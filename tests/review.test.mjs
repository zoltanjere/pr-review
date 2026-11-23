import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/review.mjs', import.meta.url));
// Fixed clock so run names are predictable: runs are named by local HHMM.
const NOW = new Date(2026, 10, 22, 14, 30);

test('rejects a non-GitHub PR URL before starting external tools', () => {
  const result = spawnSync(process.execPath, [cli, 'https://example.com/o/r/pull/42'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid.*pull request url/i);
});

test('runs all reviews in parallel and saves five distinct outputs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr-review-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { runPipeline } = await import('../src/review.mjs');
  let started = 0;
  let unblock;
  const bothStarted = new Promise((resolve) => { unblock = resolve; });
  let cleaned = false;
  const adapters = {
    prepare: async () => ({ checkout: 'fixture', base: 'base-sha', cleanup: async () => { cleaned = true; } }),
    review: async (name) => {
      if (++started === 2) unblock();
      await bothStarted;
      return `${name} finding`;
    },
    verify: async (reviews) => ({ markdown: `verified ${Object.values(reviews).join(' ')}`, findings: [] }),
    digest: async (verified) => `brief ${verified}`,
  };
  await runPipeline('https://github.com/acme/widget/pull/42', { root, adapters, now: NOW });
  const dates = await readdir(root);
  assert.equal(dates.length, 1);
  const folder = join(root, dates[0], 'widget-PR42');
  const files = await readdir(folder);
  assert.equal(files.length, 4);
  const contents = await Promise.all(files.map((file) => readFile(join(folder, file), 'utf8')));
  assert.equal((await stat(join(folder, files[0]))).mode & 0o077, 0);
  assert(contents.some((text) => text.includes('brief verified ponytail-review finding code-review finding')));
  assert.equal(cleaned, true);
});

test('a failed reviewer preserves the successful output and stops subsequent stages', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr-review-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { runPipeline } = await import('../src/review.mjs');
  let cleaned = false;
  const adapters = {
    prepare: async () => ({ checkout: 'fixture', cleanup: async () => { cleaned = true; } }),
    review: async (name) => {
      if (name === 'code-review') throw new Error('review failed');
      return 'successful review';
    },
    verify: async () => { throw new Error('verify should not run'); },
    digest: async () => { throw new Error('digest should not run'); },
  };
  await assert.rejects(runPipeline('https://github.com/acme/widget/pull/42', { root, adapters, now: NOW }), /review failed/);
  const [date] = await readdir(root);
  const files = await readdir(join(root, date, 'widget-PR42'));
  assert.deepEqual(files.sort(), ['1430-ponytail-review.md']);
  assert.match(await readFile(join(root, date, 'widget-PR42', '1430-ponytail-review.md'), 'utf8'), /successful review/);
  assert.equal(cleaned, true);
  adapters.review = async () => 'review';
  adapters.verify = async () => ({ markdown: 'verified', findings: [] });
  adapters.digest = async () => 'brief';
  await runPipeline('https://github.com/acme/widget/pull/42', { root, adapters, now: NOW });
  assert.deepEqual((await readdir(join(root, date, 'widget-PR42'))).sort(), [
    '1430-ponytail-review.md',
    '1430b-code-review.md', '1430b-digest.md', '1430b-ponytail-review.md', '1430b-verified.md',
  ]);
});

test('an empty review stops verification and leaves the other reviews available', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr-review-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { runPipeline } = await import('../src/review.mjs');
  const adapters = {
    prepare: async () => ({ cleanup: async () => {} }),
    review: async (name) => name === 'code-review' ? '  ' : 'valid review',
    verify: async () => { throw new Error('verify should not run'); },
  };
  await assert.rejects(runPipeline('https://github.com/acme/widget/pull/42', { root, adapters, now: NOW }), /empty review/);
  const [date] = await readdir(root);
  assert.equal((await readdir(join(root, date, 'widget-PR42'))).length, 1);
});

test('repeated reviews use sequential numbers without overwriting earlier files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr-review-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { runPipeline } = await import('../src/review.mjs');
  const adapters = {
    prepare: async () => ({ cleanup: async () => {} }),
    review: async () => 'review',
    verify: async () => ({ markdown: 'verified', findings: [] }),
    digest: async () => 'brief',
  };
  await runPipeline('https://github.com/acme/widget/pull/42', { root, adapters, now: NOW });
  await runPipeline('https://github.com/acme/widget/pull/42', { root, adapters, now: NOW });
  const [date] = await readdir(root);
  assert.deepEqual((await readdir(join(root, date, 'widget-PR42'))).sort(), [
    '1430-code-review.md', '1430-digest.md', '1430-ponytail-review.md', '1430-verified.md',
    '1430b-code-review.md', '1430b-digest.md', '1430b-ponytail-review.md', '1430b-verified.md',
  ]);
});

test('concurrent reviews of the same PR use distinct run numbers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr-review-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { runPipeline } = await import('../src/review.mjs');
  const adapters = {
    prepare: async () => ({ cleanup: async () => {} }),
    review: async () => 'review',
    verify: async () => ({ markdown: 'verified', findings: [] }),
    digest: async () => 'brief',
  };
  await Promise.all([
    runPipeline('https://github.com/acme/widget/pull/42', { root, adapters, now: NOW }),
    runPipeline('https://github.com/acme/widget/pull/42', { root, adapters, now: NOW }),
  ]);
  const [date] = await readdir(root);
  assert.deepEqual((await readdir(join(root, date, 'widget-PR42'))).sort(), [
    '1430-code-review.md', '1430-digest.md', '1430-ponytail-review.md', '1430-verified.md',
    '1430b-code-review.md', '1430b-digest.md', '1430b-ponytail-review.md', '1430b-verified.md',
  ]);
});

test('rejects path traversal in repository names', async () => {
  const { parsePrUrl } = await import('../src/review.mjs');
  assert.throws(() => parsePrUrl('https://github.com/acme/../pull/42'), /invalid/i);
});

test('reports both a review failure and a cleanup failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr-review-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { runPipeline } = await import('../src/review.mjs');
  const adapters = {
    prepare: async () => ({ cleanup: async () => { throw new Error('cleanup failed'); } }),
    review: async () => { throw new Error('review failed'); },
  };
  await assert.rejects(runPipeline('https://github.com/acme/widget/pull/42', { root, adapters, now: NOW }), (error) => {
    assert.match(error.message, /review failed/);
    assert.match(error.message, /cleanup failed/);
    return true;
  });
});

test('reports each parallel review as it starts and finishes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr-review-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { runPipeline } = await import('../src/review.mjs');
  const messages = [];
  let finishFirst;
  let finishSecond;
  let notifyStarted;
  let notifyFirstFinished;
  let started = 0;
  const first = new Promise((resolve) => { finishFirst = resolve; });
  const second = new Promise((resolve) => { finishSecond = resolve; });
  const bothStarted = new Promise((resolve) => { notifyStarted = resolve; });
  const firstFinished = new Promise((resolve) => { notifyFirstFinished = resolve; });
  const adapters = {
    prepare: async () => ({ cleanup: async () => {} }),
    review: (name) => {
      if (++started === 2) notifyStarted();
      return name === 'ponytail-review' ? first : second;
    },
    verify: async () => ({ markdown: 'verified', findings: [] }),
    digest: async () => 'digest',
  };
  const run = runPipeline('https://github.com/acme/widget/pull/42', {
    root, adapters, progress: (message) => {
      messages.push(message);
      if (/finished.*ponytail-review/i.test(message)) notifyFirstFinished();
    },
  });
  await bothStarted;
  assert(messages.some((message) => /starting.*ponytail-review/i.test(message)));
  assert(messages.some((message) => /starting.*code-review/i.test(message)));
  finishFirst('first review');
  await firstFinished;
  assert(messages.some((message) => /finished.*ponytail-review/i.test(message)));
  assert(!messages.some((message) => /finished.*code-review/i.test(message)));
  finishSecond('second review');
  await run;
  assert(messages.some((message) => /finished.*code-review/i.test(message)));
  assert(messages.some((message) => /== Verify/.test(message)));
  assert(messages.some((message) => /starting.*digest/i.test(message)));
});

test('long-running stages report elapsed time and stop reporting after completion', async () => {
  const { withProgress } = await import('../src/progress.mjs');
  const messages = [];
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const result = withProgress((message) => {
    messages.push(message);
    if (/waiting/i.test(message)) finish('done');
  }, 'example stage', () => pending, 5);
  assert.equal(await result, 'done');
  assert(messages.some((message) => /waiting.*example stage.*elapsed/i.test(message)));
  const count = messages.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(messages.length, count);
});

test('a failed stage reports failure and propagates the original error', async () => {
  const { withProgress } = await import('../src/progress.mjs');
  const messages = [];
  await assert.rejects(withProgress((message) => messages.push(message), 'example stage', async () => {
    throw new Error('specific failure');
  }), /specific failure/);
  assert(messages.some((message) => /failed.*example stage.*specific failure/i.test(message)));
  assert(!messages.some((message) => /finished.*example stage/i.test(message)));
});


test('every stage including the digest is saved, and the result carries what posting needs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr-review-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { runPipeline } = await import('../src/review.mjs');
  const findings = [{ title: 'A', status: 'Rejected', priority: '-' }];
  const adapters = {
    prepare: async () => ({ head: 'h'.repeat(40), cleanup: async () => {} }),
    review: async () => 'review',
    verify: async () => ({ markdown: 'verified', findings }),
    digest: async () => 'the digest',
  };
  const result = await runPipeline('https://github.com/acme/widget/pull/42', { root, adapters, now: NOW, progress: () => {} });
  assert.deepEqual((await readdir(result.directory)).sort(), ['1430-code-review.md', '1430-digest.md', '1430-ponytail-review.md', '1430-verified.md']);
  assert.match(result.digestPath, /1430-digest\.md$/);
  assert.equal(await readFile(result.digestPath, 'utf8'), 'the digest\n');
  assert.deepEqual(result.findings, findings);
  assert.equal(result.head, 'h'.repeat(40));
  assert.deepEqual(result.pr, { owner: 'acme', repo: 'widget', number: '42' });
});

test('the confirmation summary groups findings by what happens to them in the digest', async () => {
  const { summarizeFindings } = await import('../src/confirm.mjs');
  const lines = summarizeFindings([
    { title: 'Crash on empty input', status: 'Confirmed', priority: 'Must fix', location: 'a.js:1' },
    { title: 'Typo', status: 'Confirmed', priority: 'Minor', location: 'b.js:2' },
    { title: 'Version bump', status: 'Rejected', priority: '-', location: 'CONTRIBUTING.md:1', finding: 'Policy forbids it.' },
  ]).join('\n');
  assert.match(lines, /3 findings → 1 must fix · 1 minor · 1 rejected/);
  assert.match(lines, /In the digest: must fix\n  ● Crash on empty input/);
  assert.match(lines, /Folded as minor\n  · Typo/);
  assert.match(lines, /Dropped \(rejected\)\n  ✖ Version bump[^\n]*\n      Policy forbids it\./);
});

test('the cost summary totals sessions, premium requests and tokens per stage', async () => {
  const { costLines } = await import('../src/confirm.mjs');
  const text = costLines([
    { stage: 'code-review', premium: 1.5, tokens: 300_000, credits: 3.25 },
    { stage: 'checking findings', premium: 1, tokens: 120_000, credits: 2 },
    { stage: 'checking findings', premium: null, tokens: null, credits: null },
  ]).join('\n');
  assert.match(text, /code-review\s+1 session\s+1\.5 premium\s+300k tokens\s+3\.25 AI credits/);
  assert.match(text, /checking findings\s+2 sessions\s+1\.0 premium\s+120k tokens\s+2\.00 AI credits \(1 unknown\)/);
  assert.match(text, /total\s+3 sessions\s+2\.5 premium\s+420k tokens\s+5\.25 AI credits/);
  const { costTotal } = await import('../src/confirm.mjs');
  assert.equal(costTotal([{ tokens: 400_000, credits: 3.2 }, { tokens: 95_000, credits: 1.1 }]), '2 sessions · 495k tokens · 4.3 AI credits');
  assert.equal(costTotal([{ tokens: 1000 }]), '1 session · 1k tokens');
  assert.deepEqual(costLines([]), []);
});

test('runs are named by local hour and minute, with a letter for repeats in the same minute', async (t) => {
  const { runIds, runPipeline } = await import('../src/review.mjs');
  const ids = runIds(new Date(2026, 0, 2, 9, 5));
  assert.deepEqual([ids[0], ids[1], ids.at(-1), ids.length], ['0905', '0905b', '0905z', 26]);
  const root = await mkdtemp(join(tmpdir(), 'pr-review-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, '2026-11-22', 'widget-PR42');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, '1430-digest.md'), 'earlier run\n');
  await writeFile(join(folder, '1-digest.md'), 'old numbered run\n');
  const adapters = {
    prepare: async () => ({ cleanup: async () => {} }),
    review: async () => 'review',
    verify: async () => ({ markdown: 'verified', findings: [] }),
    digest: async () => 'brief',
  };
  const result = await runPipeline('https://github.com/acme/widget/pull/42', { root, adapters, progress: () => {}, now: NOW });
  assert.match(result.digestPath, /1430b-digest\.md$/);
  assert.equal(await readFile(join(folder, '1430-digest.md'), 'utf8'), 'earlier run\n');
  for (const letter of 'cdefghijklmnopqrstuvwxyz') await writeFile(join(folder, `1430${letter}-digest.md`), 'x\n');
  await assert.rejects(runPipeline('https://github.com/acme/widget/pull/42', { root, adapters, progress: () => {}, now: NOW }), /Too many runs/);
});

test('the model is reported once at the start of a run', async () => {
  const { plainReporter } = await import('../src/ui.mjs');
  const lines = [];
  plainReporter((line) => lines.push(line)).event('model', { model: 'claude-sonnet-5.5', checkModel: 'claude-haiku-5.5' });
  assert.deepEqual(lines, ['[progress] Model: claude-sonnet-5.5 · check: claude-haiku-5.5']);
});

test('the CLI also starts when run through a symlink, from another folder', async (t) => {
  const { symlink } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'cli-link-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const link = join(dir, 'reviewpr');
  await symlink(cli, link);
  const run = spawnSync(process.execPath, [link], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Pass a PR URL, or run in a terminal/);
});

test('a follow-up with no new commits checks the replies only: no scan, no verify, no reviewers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr-review-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { runPipeline } = await import('../src/review.mjs');
  const calls = [];
  const finding = { n: 1, severity: 'Should fix', title: 'Backoff has no upper bound', location: '`retry.ts`', text: 'Fix: clamp it.' };
  const adapters = {
    prepare: async () => ({ checkout: 'fixture', head: 'b'.repeat(40), cleanup: async () => {} }),
    followUpPlan: async (options) => {
      calls.push(['plan', options]);
      return { mode: 'follow-up', old: 'a'.repeat(40), head: 'b'.repeat(40), commits: 0, newDiffText: '', findings: [finding], chained: false, merged: null };
    },
    followUp: async () => { calls.push(['followUp']); return [{ status: 'Answered', answer: 'accepted', reply: 'Bounded by the caller.', evidence: 'caller.ts:3 caps it.' }]; },
    scan: async () => { calls.push(['scan']); return ''; },
    review: async () => { calls.push(['review']); return ''; },
    verify: async () => { calls.push(['verify']); return { markdown: '', findings: [] }; },
    digest: async () => { calls.push(['digest']); return ''; },
    linkify: async (text) => text,
  };
  const notes = [];
  const result = await runPipeline('https://github.com/acme/widget/pull/42', { root, adapters, now: NOW, progress: (text) => notes.push(String(text)) });
  assert.deepEqual(calls, [['plan', { full: false }], ['followUp']]);
  assert.match(result.digest, /^\*\*Verdict:\*\* ✅ Ship\. The earlier point is resolved\./);
  assert.match(result.digest, /\(no new commits\): only the replies to the 1 earlier point were checked\./);
  assert.deepEqual(result.followUp, { old: 'a'.repeat(40) });
  assert(notes.some((note) => note.includes('Follow-up of your review at `aaaaaaa`: no new commits, 1 finding to check.')));
});

test('--full reaches the plan, and a full review says why before the reviewers start', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr-review-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { runPipeline } = await import('../src/review.mjs');
  const order = [];
  const adapters = {
    prepare: async () => ({ checkout: 'fixture', cleanup: async () => {} }),
    followUpPlan: async (options) => ({ mode: 'full', line: options.full ? 'Full review: you asked for one.' : null, notice: null }),
    review: async (name) => { order.push(name); return `${name} finding`; },
    verify: async () => ({ markdown: 'verified', findings: [] }),
    digest: async () => '**Verdict:** ✅ Ship. No issues found.',
  };
  const result = await runPipeline('https://github.com/acme/widget/pull/42', { root, adapters, now: NOW, full: true, progress: (text) => order.push(String(text)) });
  const said = order.findIndex((line) => line.includes('Full review: you asked for one.'));
  assert(said >= 0 && said < order.indexOf('ponytail-review'));
  assert.equal(result.followUp, null);
  assert.equal(result.digest, '**Verdict:** ✅ Ship. No issues found.');
});

// The step between picking a PR and reviewing it.
function menuRun(answers) {
  const asked = [];
  const calls = [];
  const menu = async (title, rows, initial) => {
    asked.push({ title, rows, initial });
    const answer = answers.shift();
    return answer === undefined ? null : rows.findIndex((row) => row.startsWith(answer));
  };
  const options = {
    menu,
    output: { write: (text) => calls.push(['output', text]) },
    review: async (url, choice) => { calls.push(['review', url, choice]); },
    summarize: async (url) => { calls.push(['summarize', url]); },
  };
  return { asked, calls, options };
}
const URL42 = 'https://github.com/acme/widget/pull/42';

test('after a pick, Enter reviews as before: Review it is the default', async () => {
  const { prAction } = await import('../src/review.mjs');
  const run = menuRun(['Review it']);
  assert.equal(await prAction(URL42, { ...run.options, back: true }), 'done');
  assert.equal(run.asked[0].title, 'acme/widget#42: what next?');
  assert.deepEqual(run.asked[0].rows, ['Review it', 'Summarise it first', 'Back to the list']);
  assert.equal(run.asked[0].initial, 0);
  assert.deepEqual(run.calls, [['review', URL42, { full: false }]]);
});

test('Summarise it first, then Review it now, runs the summary and then the review', async () => {
  const { prAction } = await import('../src/review.mjs');
  const run = menuRun(['Summarise', 'Review it now']);
  assert.equal(await prAction(URL42, { ...run.options, back: true }), 'done');
  assert.deepEqual(run.asked[1].rows, ['Review it now', 'Back to the list', 'Done']);
  assert.deepEqual(run.calls, [['summarize', URL42], ['review', URL42, { full: false }]]);
});

test('Back to the list after a summary returns back; Done ends; q goes back without reviewing', async () => {
  const { prAction } = await import('../src/review.mjs');
  let run = menuRun(['Summarise', 'Back']);
  assert.equal(await prAction(URL42, { ...run.options, back: true }), 'back');
  run = menuRun(['Summarise', 'Done']);
  assert.equal(await prAction(URL42, { ...run.options, back: true }), 'done');
  run = menuRun([]);
  assert.equal(await prAction(URL42, { ...run.options, back: true }), 'back');
  assert.deepEqual(run.calls, []);
});

test('the watch app offers no Done, and a URL with no list offers Cancel and Done instead of Back', async () => {
  const { prAction } = await import('../src/review.mjs');
  let run = menuRun(['Summarise', 'Back']);
  await prAction(URL42, { ...run.options, back: true, done: false });
  assert.deepEqual(run.asked[1].rows, ['Review it now', 'Back to the list']);
  run = menuRun(['Cancel']);
  assert.equal(await prAction(URL42, run.options), 'done');
  assert.deepEqual(run.asked[0].rows, ['Review it', 'Summarise it first', 'Cancel']);
  run = menuRun(['Summarise', 'Done']);
  await prAction(URL42, run.options);
  assert.deepEqual(run.asked[1].rows, ['Review it now', 'Done']);
});

test('f (full review) skips the menu; --summary skips the first question', async () => {
  const { prAction } = await import('../src/review.mjs');
  let run = menuRun([]);
  await prAction(URL42, { ...run.options, full: true, back: true });
  assert.deepEqual(run.asked, []);
  assert.deepEqual(run.calls, [['review', URL42, { full: true }]]);
  run = menuRun(['Done']);
  await prAction(URL42, { ...run.options, start: 'summary' });
  assert.equal(run.asked.length, 1);
  assert.deepEqual(run.calls, [['summarize', URL42]]);
});

test('a failed summary is shown and the menu still offers the review', async () => {
  const { prAction } = await import('../src/review.mjs');
  const run = menuRun(['Summarise', 'Review it now']);
  await prAction(URL42, { ...run.options, summarize: async () => { throw new Error('copilot failed'); } });
  assert.deepEqual(run.calls, [['output', 'copilot failed\n'], ['review', URL42, { full: false }]]);
});

test('Back to the list shows the picker again in reviewpr with no URL', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr-review-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ model: 'claude-sonnet-5.5', defaultRepository: 'acme/widget' }));
  const { main } = await import('../src/review.mjs');
  const picks = [URL42, null];
  let shown = 0;
  await main([], {
    configPath, interactive: true,
    pick: async () => { shown += 1; return picks.shift(); },
    menu: async (title, rows) => rows.indexOf('Back to the list'),
  });
  assert.equal(shown, 2);
});

test('runSummary saves the summary with its size line, cleans up, and runs no review', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr-review-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { runSummary } = await import('../src/review.mjs');
  const calls = [];
  const adapters = {
    prepare: async () => ({ checkout: 'fixture', title: 'fix: resume uploads', diffText: 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-a\n+b', cleanup: async () => { calls.push('cleanup'); } }),
    summarize: async () => { calls.push('summarize'); return 'Summary:\nUploads now resume after a dropped connection.'; },
    review: async () => { calls.push('review'); return ''; },
  };
  const result = await runSummary(URL42, { root, adapters, now: NOW, progress: () => {} });
  assert.deepEqual(calls, ['summarize', 'cleanup']);
  assert.equal(result.summary, 'Uploads now resume after a dropped connection.\n\n_1 file · +1 −1_');
  assert.equal(result.title, 'fix: resume uploads');
  assert.match(result.path, /widget-PR42\/1430-summary\.md$/);
  assert.equal(await readFile(result.path, 'utf8'), `${result.summary}\n`);
  assert.deepEqual((await readdir(dirname(result.path))).sort(), ['1430-summary.md']);
});
