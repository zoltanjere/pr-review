import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidatePrs, choosePr, formatRows, hiddenSummary, pickFromList, reviewedHead } from '../src/select.mjs';

const ME = 'me';
const HEAD = 'a7e50c828a1b2de30d5bec350ee37e1d368490ad';
const pr = (number, extra = {}) => ({
  number, title: `PR ${number}`, author: { login: 'alice', is_bot: false }, isDraft: false,
  headRefOid: HEAD, latestReviews: [], updatedAt: `2026-11-2${number % 10}T10:00:00Z`, ...extra,
});
const review = (state, body = '', login = ME) => ({ author: { login }, state, body, commit: { oid: '' } });

test('the reviewed commit is read from our footer, old and new wording', () => {
  assert.equal(reviewedHead({ body: '---\n<sub>Reviewed at `a7e50c8` with AI assistance.</sub>' }), 'a7e50c8');
  assert.equal(reviewedHead({ body: '<sub>Automated second review by pr-review at `c0ffee1`. Findings…</sub>' }), 'c0ffee1');
  assert.equal(reviewedHead({ body: 'LGTM' }), null);
});

test('only PRs that still need my review are listed, newest first', async () => {
  const lookups = [];
  const { prs, hidden, open } = await candidatePrs([
    pr(1),
    pr(2, { latestReviews: [review('APPROVED', 'Reviewed at `a7e50c8` with AI assistance.')] }),
    pr(3, { latestReviews: [review('CHANGES_REQUESTED', 'Reviewed at `0000000` with AI assistance.')] }),
    pr(4, { latestReviews: [review('DISMISSED', 'Reviewed at `a7e50c8`')] }),
    pr(5, { latestReviews: [review('COMMENTED', 'by pr-review at `a7e50c8`.')] }),
    pr(6, { latestReviews: [review('COMMENTED', 'Copilot overview', 'copilot-pull-request-reviewer')] }),
    pr(7, { isDraft: true }),
    pr(8, { author: { login: ME } }),
    pr(9, { author: { login: 'dependabot[bot]', is_bot: true } }),
    pr(11, { latestReviews: [review('APPROVED', 'manual approval')] }),
    pr(12, { latestReviews: [review('APPROVED', 'manual approval, commit unknown')] }),
  ], ME, { commitOf: async (number) => { lookups.push(number); return number === 11 ? HEAD : null; } });
  assert.deepEqual(prs.map((item) => item.number), [6, 4, 3, 12, 1]);
  assert.deepEqual(hidden, { reviewed: 3, draft: 1, yours: 1, bot: 1 });
  assert.equal(open, 11);
  assert.deepEqual(lookups, [11, 12]);
  assert.equal(hiddenSummary({ hidden, open }), '11 open; hidden: 3 reviewed, 1 draft, 1 yours, 1 bot');
});

test('rows show the number, the author and the title, aligned and cut to the width', () => {
  const rows = formatRows([
    { number: 7, author: { login: 'bob' }, title: 'short' },
    { number: 123, author: { login: 'octo-contributor42' }, title: 'fix: resume uploads after a dropped connection and log each retry' },
  ], 60);
  assert.equal(rows[0], '#7    bob                 short');
  assert.match(rows[1], /^#123  octo-contributor42  fix: resume uploads after a d…$/);
  assert(rows.every((row) => row.length <= 60));
});

function fakeTerminal() {
  const input = new EventEmitter();
  input.modes = [];
  input.setRawMode = (on) => input.modes.push(on);
  input.resume = () => {};
  input.pause = () => {};
  let text = '';
  const output = { rows: 6, columns: 80, isTTY: false, write: (chunk) => { text += chunk; } };
  const press = (...keys) => keys.forEach((key) => setImmediate(() => input.emit('keypress', key.length === 1 ? key : undefined, key.length === 1 ? { name: key } : { name: key })));
  return { input, output, press, text: () => text };
}

test('arrow keys move the highlight, Enter picks, and raw mode is restored', async () => {
  const term = fakeTerminal();
  const picked = pickFromList('repo: 3 to review', ['#1 a one', '#2 b two', '#3 c three'], term);
  term.press('up', 'down', 'down', 'return');
  assert.equal(await picked, 2);
  assert.deepEqual(term.input.modes, [true, false]);
  assert.match(term.text(), /❯ #3 c three/);
  assert.match(term.text(), /↑\/↓ move · Enter review · q cancel/);
});

test('q and Esc cancel; a long list scrolls with a position marker', async () => {
  for (const key of ['q', 'escape']) {
    const term = fakeTerminal();
    const picked = pickFromList('t', ['#1', '#2'], term);
    term.press(key);
    assert.equal(await picked, null);
    assert.deepEqual(term.input.modes, [true, false]);
  }
  const term = fakeTerminal();
  const rows = Array.from({ length: 10 }, (_, i) => `#${i + 1} row`);
  const picked = pickFromList('t', rows, term);
  term.press(...Array(6).fill('j'), 'return');
  assert.equal(await picked, 6);
  assert.match(term.text(), /❯ #7 row[\s\S]*7\/10/);
});

test('choosePr checks the clone, lists and returns the picked PR URL', async () => {
  const calls = [];
  const adapters = {
    findClone: async (owner, repo) => calls.push(['clone', owner, repo]),
    viewer: async () => ME,
    listOpenPrs: async (repo) => { calls.push(['list', repo]); return [pr(42), pr(43, { isDraft: true })]; },
    reviewCommit: async () => null,
  };
  const term = fakeTerminal();
  const url = choosePr('acme/widget', adapters, term);
  term.press('return');
  assert.equal(await url, 'https://github.com/acme/widget/pull/42');
  assert.deepEqual(calls, [['clone', 'acme', 'widget'], ['list', 'acme/widget']]);
  assert.match(term.text(), /acme\/widget: 1 to review \(2 open; hidden: 1 draft\)/);
  const empty = fakeTerminal();
  assert.equal(await choosePr('acme/widget', { ...adapters, listOpenPrs: async () => [pr(9, { isDraft: true })] }, empty), null);
  assert.match(empty.text(), /Nothing to review in acme\/widget \(1 open; hidden: 1 draft\)/);
});

test('without a URL, main needs a terminal and defaultRepository, then reviews the picked PR', async (t) => {
  const { main } = await import('../src/review.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'pick-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ model: 'm' }));
  await assert.rejects(main([], { configPath, interactive: false }), /Pass a PR URL, or run in a terminal/);
  await assert.rejects(main([], { configPath, interactive: true }), /set "defaultRepository"/);
  await writeFile(configPath, JSON.stringify({ model: 'm', defaultRepository: 'https://github.com/acme/widget' }));
  let asked;
  await main([], { configPath, interactive: true, pick: async (repo) => { asked = repo; return null; } });
  assert.equal(asked, 'acme/widget');
  await writeFile(configPath, JSON.stringify({ model: 'm', defaultRepository: 'not a repo' }));
  await assert.rejects(main([], { configPath, interactive: true }), /defaultRepository .* must look like owner\/repo/);
});
