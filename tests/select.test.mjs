import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidatePrs, choosePr, formatRows, hiddenSummary, ownLabel, pickFromList, reviewedHead } from '../src/select.mjs';

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

test('only PRs that still need my review are listed, by state then newest first', async () => {
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
  ], ME, { now: Date.parse('2026-11-30T10:00:00Z'), commitOf: async (number) => { lookups.push(number); return number === 11 ? HEAD : null; } });
  // #3 had changes requested at an older commit: fixes pushed, first. The rest wait, newest activity first.
  // My own PR (#8) is listed last, under Your PRs.
  assert.deepEqual(prs.map((item) => [item.number, item.state.key]), [[3, 'fixes'], [6, 'waiting'], [4, 'waiting'], [12, 'waiting'], [1, 'waiting'], [8, 'mine']]);
  assert.deepEqual(hidden, { reviewed: 3, draft: 1, bot: 1 });
  assert.equal(open, 11);
  assert.deepEqual(lookups, [11, 12]);
  assert.equal(hiddenSummary({ hidden, open }), '11 open; hidden: 3 reviewed, 1 draft, 1 bot');
});

test('my own PRs are listed for a self-review, drafts too, and my comments never hide them', async () => {
  const mineReviewed = pr(8, { author: { login: ME }, latestReviews: [review('COMMENTED', 'Reviewed at `a7e50c8` with AI assistance.')] });
  const { prs, hidden } = await candidatePrs([mineReviewed, pr(9, { author: { login: ME }, isDraft: true })], ME, { now: Date.parse('2026-11-30T10:00:00Z') });
  assert.deepEqual(prs.map((item) => [item.number, item.state.key, item.state.heading, item.state.icon]), [[9, 'mine', 'Your PRs', '◆'], [8, 'mine', 'Your PRs', '◆']]);
  assert.deepEqual(hidden, { reviewed: 0, draft: 0, bot: 0 });
  assert.equal(prs[0].state.label, 'draft · no reviews yet');
});

test('my PR label counts other people\u2019s reviews and conflicts, not mine or bots', () => {
  const label = ownLabel(pr(8, {
    author: { login: ME }, mergeable: 'CONFLICTING',
    latestReviews: [review('APPROVED', '', 'ana'), review('APPROVED', '', 'lee'), review('CHANGES_REQUESTED', '', 'sam'),
      review('COMMENTED', 'self-review', ME), review('COMMENTED', 'overview', 'copilot-pull-request-reviewer')],
  }), ME);
  assert.equal(label, '2 approvals · 1 change request · conflicts');
  assert.equal(ownLabel(pr(8, { author: { login: ME }, mergeable: 'MERGEABLE' }), ME), 'no reviews yet');
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

const NOW = Date.parse('2026-11-23T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();
const statePr = (number, extra = {}) => ({
  number, title: `PR ${number}`, author: { login: 'alice' }, isDraft: false, headRefOid: HEAD,
  latestReviews: [], reviewRequests: [], createdAt: hoursAgo(24 * 30), updatedAt: hoursAgo(24 * 3), ...extra,
});

test('each PR gets one state, first match wins', async () => {
  const { prState } = await import('../src/select.mjs');
  const older = 'b'.repeat(40);
  const newer = { count: 2, last: hoursAgo(2) };
  const asked = statePr(2, { createdAt: hoursAgo(1), reviewRequests: [{ login: ME }] });
  const cases = [
    [prState(statePr(1), ME, { mine: { state: 'CHANGES_REQUESTED' }, covered: older.slice(0, 7), newer, now: NOW }), 'fixes', '2 new commits · 2h'],
    [prState(statePr(1), ME, { mine: { state: 'APPROVED' }, covered: older, newer, now: NOW }), 'approved', 'approved · 2 new commits'],
    [prState(asked, ME, { now: NOW }), 'requested', 'requested · 3d'],
    [prState(statePr(3, { createdAt: hoursAgo(0.5) }), ME, { now: NOW }), 'new', 'opened 30m ago'],
    [prState(statePr(4, { updatedAt: hoursAgo(3) }), ME, { now: NOW }), 'updated', 'updated 3h ago'],
    [prState(statePr(5), ME, { now: NOW }), 'waiting', '3d'],
    [prState(statePr(6, { updatedAt: hoursAgo(24 * 23) }), ME, { now: NOW }), 'stale', 'idle 23d'],
    [prState(statePr(7, { createdAt: undefined, updatedAt: undefined }), ME, { now: NOW }), 'waiting', ''],
  ];
  for (const [state, key, label] of cases) assert.deepEqual([state.key, state.label], [key, label]);
  assert.equal(prState(statePr(8, { updatedAt: hoursAgo(24 * 13) }), ME, { now: NOW }).key, 'waiting', 'stale starts at 14 days');
});

test('a re-requested review is listed even when you reviewed the current head', async () => {
  const again = statePr(9, { latestReviews: [review('APPROVED', 'Reviewed at `a7e50c8` with AI assistance.')], reviewRequests: [{ login: ME }] });
  const { prs, hidden } = await candidatePrs([again], ME, { now: NOW });
  assert.deepEqual([prs.map((pr) => pr.state.key), hidden.reviewed], [['requested'], 0]);
});

test('rows show the state icon and a right-aligned label; colour off keeps the meaning', async () => {
  const { pickerRows } = await import('../src/select.mjs');
  const { prs } = await candidatePrs([statePr(5), statePr(3, { createdAt: hoursAgo(1) }), statePr(6, { updatedAt: hoursAgo(24 * 20) })], ME, { now: NOW });
  const { rows, map } = pickerRows(prs, 70);
  assert.deepEqual(rows.filter((row) => typeof row === 'object').map((row) => row.heading), ['New', 'Waiting']);
  assert.deepEqual(map.map((pr) => pr?.number ?? null), [null, 3, null, 5, 6]);
  const lines = rows.filter((row) => typeof row === 'string');
  assert.match(lines[0], /^● #3  alice  PR 3 +opened 1h ago$/);
  assert.match(lines[2], /^◌ #6  alice  PR 6 +idle 20d$/);
  assert(lines.every((line) => line.length === lines[0].length && line.length <= 70), lines.join('\n'));
  const skipped = pickerRows(prs, 70, { skipped: (pr) => pr.number === 5 }).rows.find((row) => typeof row === 'string' && row.includes('#5'));
  assert.match(skipped, /skipped · 3d$/);
});

test('the cursor skips group headings', async () => {
  const term = fakeTerminal();
  const picked = pickFromList('t', [{ heading: 'New' }, '#1', { heading: 'Waiting' }, '#2'], term);
  term.press('up', 'down', 'return');
  assert.equal(await picked, 3);
  assert.match(term.text(), /New[\s\S]*❯ #1/);
});

test('s skips a PR until its head changes, a shows skipped PRs again', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'picker-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'state', 'picker.json');
  let open = [statePr(42), statePr(43)];
  const adapters = { findClone: async () => {}, viewer: async () => ME, listOpenPrs: async () => open, reviewCommit: async () => null };
  const run = async (...keys) => {
    const term = fakeTerminal();
    const url = choosePr('acme/widget', adapters, { ...term, statePath, now: NOW, live: false, reporter: { start() {}, finish() {} } });
    term.press(...keys);
    return { url: await url, text: term.text() };
  };
  const first = await run('s', 'return');
  assert.equal(first.url, 'https://github.com/acme/widget/pull/43');
  assert.match(first.text, /1 to review, 1 skipped/);
  const { readFile } = await import('node:fs/promises');
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).skipped, { 'acme/widget#42': HEAD });
  assert.equal((await run('return')).url, 'https://github.com/acme/widget/pull/43', 'still skipped next time');
  const shown = await run('a', 'up', 'return'); // a keeps the cursor on #43; #42 reappears above it
  assert.equal(shown.url, 'https://github.com/acme/widget/pull/42');
  assert.match(shown.text, /skipped · 3d/);
  open = [statePr(42, { headRefOid: 'd'.repeat(40) }), statePr(43)];
  assert.equal((await run('return')).url, 'https://github.com/acme/widget/pull/42', 'a new commit ends the skip');
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).skipped, {}, 'an ended skip is pruned when the visit is saved');
});

test('new commits are counted only for PRs that changed since your review', async () => {
  const calls = [];
  const changed = statePr(1, { headRefOid: 'e'.repeat(40), latestReviews: [review('CHANGES_REQUESTED', 'Reviewed at `a7e50c8` with AI assistance.')] });
  const { prs } = await candidatePrs([changed, statePr(2)], ME, {
    now: NOW,
    commitsSince: async (number, base, head) => { calls.push([number, base, head.slice(0, 1)]); return { count: 3, last: hoursAgo(2) }; },
  });
  assert.deepEqual(calls, [[1, 'a7e50c8', 'e']]);
  assert.equal(prs[0].state.label, '3 new commits · 2h');
  const failing = await candidatePrs([changed], ME, { now: NOW, commitsSince: async () => { throw new Error('rate limited'); } });
  assert.equal(failing.prs[0].state.label, 'new commits · 3d', 'a failed count still lists the PR');
  const plain = await candidatePrs([changed], ME, { now: NOW, commitsSince: () => null });
  assert.equal(plain.prs[0].state.label, 'new commits · 3d', 'a counter that returns a plain null works too');
});

test('New and Updated mean since you last looked, and the visit is remembered', async (t) => {
  const { prState } = await import('../src/select.mjs');
  const seenAt = NOW - 3 * 24 * 3_600_000; // looked three days ago
  const opened = prState(statePr(1, { createdAt: hoursAgo(48), updatedAt: hoursAgo(48) }), ME, { now: NOW, seenAt });
  const touched = prState(statePr(2, { updatedAt: hoursAgo(60) }), ME, { now: NOW, seenAt });
  const before = prState(statePr(3, { updatedAt: hoursAgo(24 * 4) }), ME, { now: NOW, seenAt });
  assert.deepEqual([opened.key, opened.heading], ['new', 'New since you looked']);
  assert.deepEqual([touched.key, touched.heading, touched.label], ['updated', 'Updated since you looked', 'updated 2d ago']);
  assert.equal(before.key, 'waiting', 'changed before your last look is not new');
  assert.equal(prState(statePr(4, { updatedAt: hoursAgo(48) }), ME, { now: NOW }).key, 'waiting', 'first visit: 24 hours');

  const dir = await mkdtemp(join(tmpdir(), 'picker-looked-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'picker.json');
  const adapters = { findClone: async () => {}, viewer: async () => ME, listOpenPrs: async () => [statePr(5, { updatedAt: hoursAgo(30) })], reviewCommit: async () => null };
  const visit = async (now) => {
    const term = fakeTerminal();
    const url = choosePr('acme/widget', adapters, { ...term, statePath, now, live: false, reporter: { start() {}, finish() {} } });
    term.press('q');
    await url;
    return term.text();
  };
  // First visit 12h ago, 18h after the update: within 24 hours, so Updated.
  assert.match(await visit(NOW - 12 * 3_600_000), /Updated\n/);
  // Second visit now: the update came before the last look, so it waits.
  const second = await visit(NOW);
  assert.doesNotMatch(second, /Updated/);
  assert.match(second, /Waiting/);
  assert.match(second, /last looked 12h ago/);
  const { readFile } = await import('node:fs/promises');
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).lastLooked['acme/widget'], new Date(NOW).toISOString());
});

test('the label is coloured by age and the icon by state; headings take the state colour', async () => {
  const { ageColor, pickerRows } = await import('../src/select.mjs');
  const DAYMS = 24 * 3_600_000;
  assert.deepEqual([ageColor(3_600_000), ageColor(3 * DAYMS), ageColor(9 * DAYMS), ageColor(20 * DAYMS), ageColor(null)], ['green', null, 'yellow', 'red', null]);
  const { prs } = await candidatePrs([statePr(6, { updatedAt: hoursAgo(24 * 20) })], ME, { now: NOW });
  const { rows } = pickerRows(prs, 70, { color: true });
  const line = rows.find((row) => typeof row === 'string');
  assert.match(line, /\x1b\[31m\s*idle 20d\x1b\[39m$/, 'a 20-day-old PR has a red label');
  assert.doesNotMatch(line, /\x1b\[2m/, 'old PRs are not dimmed: they should stand out');
  assert.deepEqual(rows[0], { heading: 'Waiting', color: null });
});
