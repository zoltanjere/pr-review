import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { publishInTerminal, reviewBody, reviewOptions } from '../src/publish.mjs';

const HEAD = 'a'.repeat(40);
const open = (extra = {}) => ({ state: 'OPEN', head: HEAD, author: 'alice', viewer: 'bob', ...extra });
const mustFix = [{ title: 'Crash', status: 'Confirmed', priority: 'Must fix' }];
const minorOnly = [{ title: 'Typo', status: 'Confirmed', priority: 'Minor' }];

test('approve is recommended without a must-fix and with at most 3 should-fix, also when questions are open', () => {
  assert.deepEqual(reviewOptions({ findings: minorOnly, reviewedHead: HEAD, status: open() }),
    { allowed: ['approve', 'comment', 'request-changes'], recommended: 'approve', notes: [], level: 'ship' });
  assert.equal(reviewOptions({ findings: mustFix, reviewedHead: HEAD, status: open() }).recommended, 'request-changes');
  const shouldFix = [{ title: 'Gap', status: 'Confirmed', priority: 'Should fix' }];
  assert.equal(reviewOptions({ findings: shouldFix, reviewedHead: HEAD, status: open() }).recommended, 'approve');
  const fourShouldFix = [1, 2, 3, 4].map(() => shouldFix[0]);
  assert.equal(reviewOptions({ findings: fourShouldFix, reviewedHead: HEAD, status: open() }).recommended, 'comment');
  const questions = [{ title: 'Why?', status: 'Question', priority: '-' }];
  assert.equal(reviewOptions({ findings: questions, reviewedHead: HEAD, status: open() }).recommended, 'approve');
});

test('an edited verdict line decides the recommendation', () => {
  const digest = '**Verdict:** 🔴 Fix before merge. 1 should-fix.\n\n### Should fix';
  assert.equal(reviewOptions({ findings: minorOnly, reviewedHead: HEAD, status: open(), digest }).recommended, 'request-changes');
  const ship = '**Verdict:** ✅ Ship. 1 should-fix.';
  assert.equal(reviewOptions({ findings: mustFix, reviewedHead: HEAD, status: open(), digest: ship }).recommended, 'approve');
});

test('own PRs and PRs with newer commits can only get a comment; closed PRs get nothing', () => {
  const own = reviewOptions({ findings: minorOnly, reviewedHead: HEAD, status: open({ author: 'bob' }) });
  assert.deepEqual([own.allowed, own.recommended], [['comment'], 'comment']);
  assert.match(own.notes[0], /your own PR/);
  const moved = reviewOptions({ findings: mustFix, reviewedHead: HEAD, status: open({ head: 'b'.repeat(40) }) });
  assert.deepEqual([moved.allowed, moved.recommended], [['comment'], 'comment']);
  assert.match(moved.notes[0], /new commits since this review \(aaaaaaa → bbbbbbb\)/);
  const merged = reviewOptions({ findings: minorOnly, reviewedHead: HEAD, status: open({ state: 'MERGED' }) });
  assert.deepEqual(merged.allowed, []);
  assert.match(merged.notes[0], /merged/);
});

test('the posted body is the digest plus a short footer naming the reviewed commit', () => {
  const body = reviewBody('**Verdict:** ✅ Ship.\n', HEAD);
  assert.match(body, /^\*\*Verdict:\*\* ✅ Ship\.\n\n---\n<sub>Reviewed at `aaaaaaa` with AI assistance\. Each finding was checked against the code\.<\/sub>\n$/);

  // A follow-up names the review it followed; the picker reads the new commit back.
  const followUp = reviewBody('**Verdict:** ✅ Ship.\n', HEAD, 'b'.repeat(40));
  assert.match(followUp, /<sub>Follow-up at `aaaaaaa` of the review at `bbbbbbb`, with AI assistance\. Each finding was checked against the code\.<\/sub>\n$/);
});

// Answers for the arrow-key menus: a 0-based index, 'default' for Enter on the
// preselected row, or null for q/Esc. Each call is recorded.
async function session(t, answers, { findings = minorOnly, status = open(), edit, digest = '**Verdict:** ✅ Ship.', failures = 0 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'publish-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const digestPath = join(dir, '1-digest.md');
  await writeFile(digestPath, 'draft\n');
  const posts = [];
  const menus = [];
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => { text += chunk; });
  const queue = [...answers];
  const adapters = {
    prStatus: async () => status,
    postReview: async (pr, event, body) => {
      if (failures-- > 0) throw new Error('gh failed: GraphQL: Something went wrong');
      posts.push({ pr, event, body });
    },
  };
  const pick = async (title, rows, initial) => {
    menus.push({ title, rows, initial, before: text });
    if (!queue.length) throw new Error('asked too often');
    const answer = queue.shift();
    return answer === 'default' ? initial : answer;
  };
  const result = await publishInTerminal({
    pr: { owner: 'acme', repo: 'widget', number: '42' }, digest, digestPath, head: HEAD, findings,
    title: 'feat: add retries', model: 'claude-sonnet-5.5', checkModel: 'claude-haiku-5.5',
    usage: [{ stage: 'code-review', premium: 1, tokens: 400_000, credits: 3.2 }, { stage: 'checking findings', premium: 1, tokens: 95_000, credits: 1.1 }],
  }, { adapters, output, pick, edit });
  return { result, posts, menus, output: () => text, digest: () => readFile(digestPath, 'utf8') };
}

test('Enter keeps the review local; the cost table sits right above the first question', async (t) => {
  const run = await session(t, ['default']);
  const header = run.output().split('── Decisions')[0];
  assert.match(header, /acme\/widget#42 {2}feat: add retries/);
  assert.match(header, /PR {6}https:\/\/github\.com\/acme\/widget\/pull\/42/);
  assert.match(header, /Commit {2}aaaaaaa/);
  assert.match(header, /Model {3}claude-sonnet-5\.5 · check: claude-haiku-5\.5/);
  assert.match(header, /Cost {4}2 sessions · 495k tokens · 4\.3 AI credits/);
  assert.deepEqual(run.result, { posted: null });
  assert.deepEqual(run.posts, []);
  assert.equal(run.menus[0].title, 'What next?');
  assert.match(run.menus[0].rows[0], /^Keep it local/);
  assert.equal(run.menus[0].initial, 0);
  const beforeMenu = run.menus[0].before;
  assert(beforeMenu.lastIndexOf('Cost\n') > beforeMenu.lastIndexOf('Digest preview'), 'cost table after the digest preview');
  assert.match(beforeMenu.trimEnd().split('\n').at(-1), /total .*4\.30 AI credits$/);
  assert.match(run.output(), /Nothing was posted/);
});

test('posting preselects the recommended review type and marks it', async (t) => {
  const run = await session(t, [1, 'default']);
  assert.deepEqual(run.result, { posted: 'approve' });
  assert.equal(run.posts[0].event, 'approve');
  assert.match(run.posts[0].body, /^\*\*Verdict:\*\* ✅ Ship\./);
  assert.equal(run.menus[1].title, 'Post to acme/widget#42 as:');
  assert.deepEqual(run.menus[1].rows, ['Approve (recommended)', 'Comment only', 'Request changes', 'Cancel, keep it local']);
  assert.equal(run.menus[1].initial, 0);
  const changes = await session(t, [1, 'default'], {
    findings: [{ title: 'Gap', status: 'Confirmed', priority: 'Should fix' }], digest: '**Verdict:** ⚠️ Changes recommended. 1 should-fix.',
  });
  assert.equal(changes.menus[1].initial, 1);
});

test('a failed post says nothing was posted and asks again, so it can be retried', async (t) => {
  const run = await session(t, [1, 'default', 1, 'default'], { failures: 1 });
  assert.deepEqual(run.result, { posted: 'approve' });
  assert.equal(run.posts.length, 1);
  assert.match(run.output(), /Not posted: gh failed: GraphQL: Something went wrong/);
  assert.equal(run.menus[2].title, 'What next?');
  const gaveUp = await session(t, [1, 'default', 'default'], { failures: 1 });
  assert.deepEqual([gaveUp.result, gaveUp.posts], [{ posted: null }, []]);
});

test('a non-recommended type can be chosen, and the verdict line follows the choice', async (t) => {
  const comment = await session(t, [1, 1]);
  assert.equal(comment.posts[0].event, 'comment');
  assert.match(comment.posts[0].body, /^\*\*Verdict:\*\* 💬 Not approved yet\./);
  assert.match(await comment.digest(), /^\*\*Verdict:\*\* 💬 Not approved yet\./);
  assert.match(comment.output(), /Verdict line changed to match your choice/);
  const changes = await session(t, [1, 2]);
  assert.equal(changes.posts[0].event, 'request-changes');
  assert.match(changes.posts[0].body, /^\*\*Verdict:\*\* ⚠️ Changes recommended\./);
  const cancel = await session(t, [1, 3]);
  assert.deepEqual([cancel.result, cancel.posts], [{ posted: null }, []]);
});

test('on your own PR only a comment is offered, and the verdict is posted as a self-review', async (t) => {
  const run = await session(t, [1, 'default'], { status: open({ author: 'bob' }) });
  assert.deepEqual(run.menus[1].rows, ['Comment only (recommended)', 'Cancel, keep it local']);
  assert.equal(run.posts[0].event, 'comment');
  assert.match(run.posts[0].body, /^\*\*Verdict:\*\* Self-review: ✅ Ship\./);
  assert.match(await run.digest(), /^\*\*Verdict:\*\* Self-review: ✅ Ship\./);
  assert.match(run.output(), /Verdict line marked as a self-review/);
});

test('q or Esc keeps it local in either menu', async (t) => {
  const first = await session(t, [null]);
  assert.deepEqual([first.result, first.posts], [{ posted: null }, []]);
  const second = await session(t, [1, null]);
  assert.deepEqual([second.result, second.posts], [{ posted: null }, []]);
});

test('a closed PR is never posted to', async (t) => {
  const run = await session(t, [1], { status: open({ state: 'CLOSED' }) });
  assert.deepEqual([run.result, run.posts], [{ posted: null }, []]);
});

test('editing updates the saved digest before it is shown again and posted', async (t) => {
  const run = await session(t, [2, 1, 'default'], { edit: async () => '**Verdict:** ✅ Ship. Edited.' });
  assert.equal(await run.digest(), '**Verdict:** ✅ Ship. Edited.\n');
  assert.match(run.posts[0].body, /Edited\./);
});

test('the menus use the arrow-key picker with the default preselected', async () => {
  const { EventEmitter } = await import('node:events');
  const { pickFromList } = await import('../src/select.mjs');
  const input = Object.assign(new EventEmitter(), { setRawMode() {}, resume() {}, pause() {} });
  let text = '';
  const picked = pickFromList('Post as:', ['Approve', 'Comment only', 'Request changes (recommended)'], {
    input, output: { rows: 10, isTTY: false, write: (chunk) => { text += chunk; } }, initial: 2, hint: 'Enter choose · q keep local',
  });
  setImmediate(() => input.emit('keypress', undefined, { name: 'return' }));
  assert.equal(await picked, 2);
  assert.match(text, /❯ Request changes \(recommended\)/);
  assert.match(text, /↑\/↓ move · Enter choose · q keep local/);
});
