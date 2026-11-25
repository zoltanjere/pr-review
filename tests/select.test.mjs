import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidatePrs, choosePr, formatRows, aliasProblem, hiddenSummary, OPEN_SETTINGS, ownLabel, pickFromList, repoLabels, reviewedHead } from '../src/select.mjs';

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

test('only PRs that still need my review are listed, by state then by the age shown', async () => {
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
  // #3 had changes requested at an older commit: fixes pushed, first. The rest wait, youngest age first.
  // My own PR (#8) is listed last, under Your PRs.
  assert.deepEqual(prs.map((item) => [item.number, item.state.key]), [[3, 'fixes'], [6, 'waiting'], [4, 'waiting'], [12, 'waiting'], [1, 'waiting'], [8, 'mine']]);
  assert.deepEqual(hidden, { reviewed: 3, draft: 1, bot: 1 });
  assert.equal(open, 11);
  assert.deepEqual(lookups, [11, 12]);
  assert.equal(hiddenSummary({ hidden, open }), '11 open; hidden: 3 reviewed, 1 draft, 1 bot');
});

test('a dismissed review still counts as mine, as what it was posted as', async () => {
  const dismissed = (verdict, at) => review('DISMISSED', `**Verdict:** ${verdict}\n\n---\n<sub>Reviewed at \`${at}\` with AI assistance.</sub>`);
  const { prs, hidden } = await candidatePrs([
    pr(1, { latestReviews: [dismissed('✅ Ship. Only minor items.', '0000000')] }),
    pr(2, { latestReviews: [dismissed('🔴 Fix before merge. 1 must-fix.\n\n1. 🔴 **Retry resends a stored chunk**\n   `upload.ts:41`', '0000000')] }),
    pr(3, { latestReviews: [dismissed('✅ Ship. Only minor items.', HEAD.slice(0, 7))] }),
  ], ME, { now: Date.parse('2026-11-30T10:00:00Z'), commitsSince: async () => ({ count: 2, status: 'ahead', merges: 0 }) });
  // Pushed after an approval GitHub dismissed: Approved, new commits. After a dismissed change request: Fixes pushed.
  // Dismissed on the commit it covered: still listed, never hidden as reviewed.
  assert.deepEqual(prs.map((item) => [item.number, item.state.key, item.state.label]),
    [[2, 'fixes', '2 new commits'], [1, 'approved', 'approved · 2 new commits'], [3, 'waiting', '']]);
  assert.equal(prs[0].state.followUp, true);
  assert.equal(hidden.reviewed, 0);
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

test('choosePr checks the clone, lists and returns the picked PR URL', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'picker-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'picker.json');
  const calls = [];
  const adapters = {
    findClone: async (owner, repo) => calls.push(['clone', owner, repo]),
    viewer: async () => ME,
    listOpenPrs: async (repo) => { calls.push(['list', repo]); return [pr(42), pr(43, { isDraft: true })]; },
    reviewCommit: async () => null,
  };
  const term = fakeTerminal();
  const url = choosePr('acme/widget', adapters, { ...term, statePath });
  term.press('return');
  assert.equal(await url, 'https://github.com/acme/widget/pull/42');
  assert.deepEqual(calls, [['clone', 'acme', 'widget'], ['list', 'acme/widget']]);
  assert.match(term.text(), /acme\/widget: 1 to review \(2 open; hidden: 1 draft\)/);
  const empty = fakeTerminal();
  assert.equal(await choosePr('acme/widget', { ...adapters, listOpenPrs: async () => [pr(9, { isDraft: true })] }, { ...empty, statePath }), null);
  assert.match(empty.text(), /Nothing to review in acme\/widget \(1 open; hidden: 1 draft\)/);
});

test('f picks the highlighted PR for a full review; Enter leaves the choice to the run', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'picker-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const adapters = { findClone: async () => {}, viewer: async () => ME, listOpenPrs: async () => [pr(42), pr(43)], reviewCommit: async () => null };
  for (const [keys, full] of [[['f'], true], [['return'], false]]) {
    const term = fakeTerminal();
    let choice;
    const url = choosePr('acme/widget', adapters, { ...term, statePath: join(dir, 'picker.json'), onPick: (picked) => { choice = picked; } });
    term.press(...keys);
    assert.match(await url, /^https:\/\/github\.com\/acme\/widget\/pull\/4[23]$/);
    assert.deepEqual(choice, { full });
    assert.match(term.text(), /Enter review or summary · f full review · s skip/);
  }
});

test('with a settings line, the picker shows it and c leaves the list to open Settings', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'picker-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const adapters = { findClone: async () => {}, viewer: async () => ME, listOpenPrs: async () => [pr(42)], reviewCommit: async () => null };
  const term = fakeTerminal();
  const picked = choosePr('acme/widget', adapters, { ...term, statePath: join(dir, 'picker.json'), settings: 'Provider: Claude Code · Model: claude-sonnet-5-5' });
  term.press('c');
  assert.equal(await picked, OPEN_SETTINGS);
  assert.match(term.text(), /Provider: Claude Code · Model: claude-sonnet-5-5\n/);
  assert.match(term.text(), /a show skipped · c settings · q cancel/);
  const plain = fakeTerminal();
  const url = choosePr('acme/widget', adapters, { ...plain, statePath: join(dir, 'picker.json') });
  plain.press('c', 'return');
  assert.equal(await url, 'https://github.com/acme/widget/pull/42');
  assert.doesNotMatch(plain.text(), /settings/);
});

test('without a URL, main needs a terminal and repositories, then reviews the picked PR', async (t) => {
  const { main } = await import('../src/review.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'pick-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ model: 'm' }));
  await assert.rejects(main([], { configPath, interactive: false }), /Pass a PR URL, or run in a terminal/);
  await assert.rejects(main([], { configPath, interactive: true }), /set "repositories"/);
  await writeFile(configPath, JSON.stringify({ model: 'm', defaultRepository: 'https://github.com/acme/widget' }));
  let asked;
  await main([], { configPath, interactive: true, pick: async (repo) => { asked = repo; return null; } });
  assert.deepEqual(asked, ['acme/widget']);
  await writeFile(configPath, JSON.stringify({ model: 'm', defaultRepository: 'not a repo' }));
  await assert.rejects(main([], { configPath, interactive: true }), /defaultRepository .* must look like owner\/repo/);
});

test('repositories: a list, deduplicated; defaultRepository is a list of one; not both', async (t) => {
  const { readConfig } = await import('../src/adapters.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'repos-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  const read = async (config) => { await writeFile(path, JSON.stringify({ model: 'm', ...config })); return readConfig(path); };
  assert.deepEqual((await read({ repositories: ['acme/widget', 'https://github.com/acme/gadget.git', 'acme/widget'] })).repositories, ['acme/widget', 'acme/gadget']);
  const old = await read({ defaultRepository: 'acme/widget' });
  assert.deepEqual(old.repositories, ['acme/widget']);
  assert.equal(old.defaultRepository, undefined);
  await assert.rejects(read({ repositories: ['acme/widget'], defaultRepository: 'acme/widget' }), /not both/);
  await assert.rejects(read({ repositories: 'acme/widget' }), /must be a list/);
  await assert.rejects(read({ repositories: ['acme/widget', 'nope'] }), /repositories .* must look like owner\/repo \(got "nope"\)/);
});

const NOW = Date.parse('2026-11-23T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();
const statePr = (number, extra = {}) => ({
  number, title: `PR ${number}`, author: { login: 'alice' }, isDraft: false, headRefOid: HEAD,
  latestReviews: [], reviewRequests: [], createdAt: hoursAgo(24 * 30), updatedAt: hoursAgo(24 * 3), ...extra,
});

// A posted reviewpr review with one finding, so a follow-up is possible.
const POSTED = '### Must fix\n1. 🔴 **Empty input crashes**\n   `a.js:1`\n   Fix: x.\n\n---\n<sub>Reviewed at `a7e50c8` with AI assistance.</sub>';

test('each PR gets one state, first match wins', async () => {
  const { prState } = await import('../src/select.mjs');
  const older = 'b'.repeat(40);
  const newer = { count: 2, last: hoursAgo(2) };
  const asked = statePr(2, { createdAt: hoursAgo(1), reviewRequests: [{ login: ME }] });
  const cases = [
    [prState(statePr(1), ME, { mine: { state: 'CHANGES_REQUESTED', body: POSTED }, covered: older.slice(0, 7), newer, now: NOW }), 'fixes', '2 new commits'],
    [prState(statePr(1), ME, { mine: { state: 'APPROVED' }, covered: older, newer, now: NOW }), 'approved', 'approved · 2 new commits'],
    [prState(asked, ME, { now: NOW }), 'requested', 'requested'],
    [prState(statePr(3, { createdAt: hoursAgo(0.5) }), ME, { now: NOW }), 'new', ''],
    [prState(statePr(4, { updatedAt: hoursAgo(3) }), ME, { now: NOW }), 'updated', ''],
    [prState(statePr(5), ME, { now: NOW }), 'waiting', ''],
    [prState(statePr(6, { updatedAt: hoursAgo(24 * 23) }), ME, { now: NOW }), 'stale', 'idle'],
    [prState(statePr(7, { createdAt: undefined, updatedAt: undefined }), ME, { now: NOW }), 'waiting', ''],
  ];
  for (const [state, key, label] of cases) assert.deepEqual([state.key, state.label], [key, label]);
  // The age column comes from ageMs: 30 minutes for the new PR, 3 hours for the updated one.
  assert.deepEqual([cases[3][0].ageMs, cases[4][0].ageMs], [30 * 60_000, 3 * 3_600_000]);
  assert.equal(prState(statePr(8, { updatedAt: hoursAgo(24 * 13) }), ME, { now: NOW }).key, 'waiting', 'stale starts at 14 days');
});

test('a re-requested review is listed even when you reviewed the current head', async () => {
  const again = statePr(9, { latestReviews: [review('APPROVED', 'Reviewed at `a7e50c8` with AI assistance.')], reviewRequests: [{ login: ME }] });
  const { prs, hidden } = await candidatePrs([again], ME, { now: NOW });
  assert.deepEqual([prs.map((pr) => pr.state.key), hidden.reviewed], [['requested'], 0]);
});

test('the age sits right after the number, details follow the titles, and rows stay narrow', async () => {
  const { pickerRows } = await import('../src/select.mjs');
  const asked = statePr(2, { title: 'chore: a much longer title than the rest', reviewRequests: [{ login: ME }], updatedAt: hoursAgo(5) });
  const { prs } = await candidatePrs([statePr(5), statePr(3, { createdAt: hoursAgo(1) }), statePr(6, { updatedAt: hoursAgo(24 * 20) }), asked], ME, { now: NOW });
  const { rows, map } = pickerRows(prs, 200);
  assert.deepEqual(rows.filter((row) => typeof row === 'object').map((row) => row.heading), ['Asked for you', 'New', 'Waiting']);
  assert.deepEqual(map.map((pr) => pr?.number ?? null), [null, 2, null, 3, null, 5, 6]);
  const lines = rows.filter((row) => typeof row === 'string');
  assert.equal(lines[0], '★ #2  5h   alice  chore: a much longer title than the rest  requested');
  assert.equal(lines[1], '● #3  1h   alice  PR 3');
  assert.equal(lines[2], '· #5  3d   alice  PR 5');
  assert.equal(lines[3], '◌ #6  20d  alice  PR 6                                      idle');
  // A wide terminal doesn't push the details to its right edge.
  assert(lines.every((line) => line.length <= 100), lines.join('\n'));
  const narrow = pickerRows(prs, 50).rows.filter((row) => typeof row === 'string');
  assert(narrow.every((line) => line.length <= 50), narrow.join('\n'));
  assert.match(narrow[0], /^★ #2  5h   alice  chore: a much longer…  requested$/);
  const skipped = pickerRows(prs, 70, { skipped: (pr) => pr.number === 5 }).rows.find((row) => typeof row === 'string' && row.includes('#5'));
  assert.match(skipped, /^· #5  3d   alice  PR 5 +skipped$/);
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
  assert.match(shown.text, /#42 .* skipped$/m);
  open = [statePr(42, { headRefOid: 'd'.repeat(40) }), statePr(43)];
  assert.equal((await run('return')).url, 'https://github.com/acme/widget/pull/42', 'a new commit ends the skip');
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).skipped, {}, 'an ended skip is pruned when the visit is saved');
});

test('new commits are counted only for PRs that changed since your review', async () => {
  const calls = [];
  const changed = statePr(1, { headRefOid: 'e'.repeat(40), latestReviews: [review('CHANGES_REQUESTED', POSTED)] });
  const { prs } = await candidatePrs([changed, statePr(2)], ME, {
    now: NOW,
    commitsSince: async (number, base, head) => { calls.push([number, base, head.slice(0, 1)]); return { count: 3, last: hoursAgo(2) }; },
  });
  assert.deepEqual(calls, [[1, 'a7e50c8', 'e']]);
  assert.deepEqual([prs[0].state.label, prs[0].state.ageMs], ['3 new commits', 2 * 3_600_000]);
  const failing = await candidatePrs([changed], ME, { now: NOW, commitsSince: async () => { throw new Error('rate limited'); } });
  assert.equal(failing.prs[0].state.label, 'new commits', 'a failed count still lists the PR');
  const plain = await candidatePrs([changed], ME, { now: NOW, commitsSince: () => null });
  assert.equal(plain.prs[0].state.label, 'new commits', 'a counter that returns a plain null works too');
});

test('New and Updated mean since you last looked, and the visit is remembered', async (t) => {
  const { prState } = await import('../src/select.mjs');
  const seenAt = NOW - 3 * 24 * 3_600_000; // looked three days ago
  const opened = prState(statePr(1, { createdAt: hoursAgo(48), updatedAt: hoursAgo(48) }), ME, { now: NOW, seenAt });
  const touched = prState(statePr(2, { updatedAt: hoursAgo(60) }), ME, { now: NOW, seenAt });
  const before = prState(statePr(3, { updatedAt: hoursAgo(24 * 4) }), ME, { now: NOW, seenAt });
  assert.deepEqual([opened.key, opened.heading], ['new', 'New since you looked']);
  assert.deepEqual([touched.key, touched.heading, touched.ageMs], ['updated', 'Updated since you looked', 60 * 3_600_000]);
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

test('the age column is coloured by age and the icon by state; headings take the state colour', async () => {
  const { ageColor, pickerRows } = await import('../src/select.mjs');
  const DAYMS = 24 * 3_600_000;
  assert.deepEqual([ageColor(3_600_000), ageColor(3 * DAYMS), ageColor(9 * DAYMS), ageColor(20 * DAYMS), ageColor(null)], ['green', null, 'yellow', 'red', null]);
  const { prs } = await candidatePrs([statePr(6, { updatedAt: hoursAgo(24 * 20) })], ME, { now: NOW });
  const { rows } = pickerRows(prs, 70, { color: true });
  const line = rows.find((row) => typeof row === 'string');
  assert.match(line, /^◌ #6  \x1b\[31m20d  \x1b\[39m/, 'a 20-day-old PR has a red age');
  assert.doesNotMatch(line, /\x1b\[2m/, 'old PRs are not dimmed: they should stand out');
  assert.deepEqual(rows[0], { heading: 'Waiting', color: null });
});

test('within a group, rows follow the age column, youngest first, even when updatedAt says otherwise', async () => {
  // New PRs show their opening time: #1 opened 1h ago but was updated just now, #2 opened 5h ago, #3 3h ago.
  const fresh = (number, opened, updated) => statePr(number, { createdAt: hoursAgo(opened), updatedAt: hoursAgo(updated) });
  const { prs } = await candidatePrs([fresh(2, 5, 4), fresh(1, 1, 0.1), fresh(3, 3, 2), statePr(4, { createdAt: undefined, updatedAt: undefined })], ME, { now: NOW });
  assert.deepEqual(prs.filter((pr) => pr.state.key === 'new').map((pr) => [pr.number, pr.state.ageMs / 3_600_000]), [[1, 1], [3, 3], [2, 5]]);
  assert.equal(prs.at(-1).number, 4, 'an unknown age sorts last');
});

test('a Fixes pushed row says when Enter will run a full review instead of a follow-up', async () => {
  const { prState } = await import('../src/select.mjs');
  const older = 'b'.repeat(40);
  const label = (mine, newer) => prState(statePr(1), ME, { mine, covered: older, newer: { count: 2, last: hoursAgo(2), ...newer }, now: NOW });
  const fine = label({ state: 'CHANGES_REQUESTED', body: POSTED }, { status: 'ahead' });
  assert.deepEqual([fine.label, fine.followUp], ['2 new commits', true]);
  assert.equal(label({ state: 'CHANGES_REQUESTED', body: POSTED }, { status: 'diverged' }).label, '2 new commits · full review: history rewritten');
  assert.equal(label({ state: 'COMMENTED', body: POSTED }, { status: 'missing', count: null }).label, 'new commits · full review: commit gone');
  assert.equal(label({ state: 'CHANGES_REQUESTED', body: 'please fix the null check' }, {}).label, '2 new commits · full review: hand-written review');
  assert.equal(label({ state: 'COMMENTED', body: '**Verdict:** ✅ Ship. Only minor items.\n\n---\n<sub>Reviewed at `a7e50c8` with AI assistance.</sub>' }, {}).label, '2 new commits · full review: no findings');
  // The footer of a follow-up is read back as the reviewed commit.
  const { reviewedHead } = await import('../src/select.mjs');
  assert.equal(reviewedHead({ body: '<sub>Follow-up at `def5678` of the review at `abc1234`, with AI assistance.</sub>' }), 'def5678');
});

test('a rebase or base merge with the same changes is "No new changes since your review", not Fixes pushed', async () => {
  const { candidatePrs, scanRepo } = await import('../src/select.mjs');
  const reviewed = (number, state = 'CHANGES_REQUESTED') => statePr(number, { headRefOid: 'e'.repeat(40), baseRefName: 'main', latestReviews: [review(state, POSTED)] });
  const prs = [reviewed(1), reviewed(2), reviewed(3), reviewed(4), reviewed(5, 'APPROVED'), reviewed(6)];
  const newer = {
    1: { count: 2, status: 'diverged', merges: 0, last: hoursAgo(1) },
    2: { count: 1, status: 'ahead', merges: 1, last: hoursAgo(2) },
    3: { count: 2, status: 'diverged', merges: 0, last: hoursAgo(3) },
    4: { count: 2, status: 'diverged', merges: 0, last: hoursAgo(4) },
    5: { count: 2, status: 'diverged', merges: 0, last: hoursAgo(5) },
    6: { count: 2, status: 'ahead', merges: 1, last: hoursAgo(6) },
  };
  const same = { 1: true, 2: true, 3: false, 4: null, 5: true };
  const compared = [];
  const list = await candidatePrs(prs, ME, {
    now: NOW,
    commitsSince: async (number) => newer[number],
    compareChanges: async (number, base) => { compared.push([number, base]); return same[number]; },
  });
  const byNumber = Object.fromEntries(list.prs.map((item) => [item.number, [item.state.key, item.state.label]]));
  assert.deepEqual(byNumber, {
    1: ['unchanged', 'rebased only'],
    2: ['unchanged', 'merged main only'],
    3: ['fixes', '2 new commits · full review: history rewritten'],
    4: ['fixes', '2 new commits · full review: history rewritten'],
    5: ['unchanged', 'approved · rebased only'],
    6: ['fixes', '2 new commits'],
  });
  // #6 has a real commit next to its merge: never compared.
  assert.deepEqual(compared.map(([number]) => number), [1, 2, 3, 4, 5]);
  assert.equal(compared[0][1], 'main');

  // scanRepo compares with two calls once per reviewed commit and head.
  const calls = [];
  const adapters = {
    viewer: async () => ME,
    listOpenPrs: async () => [reviewed(7)],
    reviewCommit: async () => null,
    commitsSince: async () => ({ count: 1, status: 'diverged', merges: 0, last: hoursAgo(1) }),
    prChanges: async (repo, base, head) => { calls.push(head); return { total: 1, files: [{ filename: 'a.js', status: 'modified', patch: '+x' }] }; },
  };
  for (let i = 0; i < 2; i++) {
    const { list: scanned } = await scanRepo('acme/widget', adapters, { now: NOW });
    assert.equal(scanned.prs[0].state.key, 'unchanged');
  }
  assert.deepEqual(calls, ['a7e50c8', 'e'.repeat(40)]);
});

test('repository labels: the name, owner/repo when names clash, at most 14 characters', () => {
  assert.equal(repoLabels(['acme/widget']), null);
  assert.deepEqual(repoLabels(['acme/widget', 'acme/gadget']), { 'acme/widget': 'widget', 'acme/gadget': 'gadget' });
  assert.deepEqual(repoLabels(['acme/widget', 'other/widget', 'acme/api']), { 'acme/widget': 'acme/widget', 'other/widget': 'other/widget', 'acme/api': 'api' });
  assert.deepEqual(repoLabels(['acme/a-very-long-repository-name', 'acme/x']), { 'acme/a-very-long-repository-name': 'a-very-long-r…', 'acme/x': 'x' });
  // Still equal after the cut: the end of owner/repo tells them apart.
  const labels = repoLabels(['acme/shared-platform-one', 'acme/shared-platform-two']);
  assert.deepEqual(labels, { 'acme/shared-platform-one': '…-platform-one', 'acme/shared-platform-two': '…-platform-two' });
  for (const label of Object.values(labels)) assert.ok(label.length <= 14);
});

test('several repositories: one list sorted across them, a repository column, the right URL', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'picker-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'picker.json');
  const lists = {
    'acme/widget': [pr(61, { updatedAt: '2026-11-20T10:00:00Z' }), pr(43, { isDraft: true })],
    'acme/gadget': [pr(61, { updatedAt: '2026-11-22T10:00:00Z', reviewRequests: [{ login: ME }] }), pr(7, { updatedAt: '2026-11-21T10:00:00Z' })],
  };
  const adapters = { findClone: async () => {}, viewer: async () => ME, listOpenPrs: async (repo) => lists[repo], reviewCommit: async () => null };
  const now = Date.parse('2026-11-23T12:00:00Z');
  const term = fakeTerminal();
  term.output.rows = 20;
  const url = choosePr(['acme/widget', 'acme/gadget'], adapters, { ...term, statePath, now });
  term.press('return');
  // Asked for you (gadget #61) sorts first, whichever repository it is in.
  assert.equal(await url, 'https://github.com/acme/gadget/pull/61');
  const text = term.text();
  assert.match(text, /2 repositories: 3 to review \(4 open; hidden: 1 draft\)/);
  assert.match(text, /★ gadget  #61/);
  assert.match(text, /· gadget  #7 /);
  assert.match(text, /· widget  #61/);
  // Skipping gadget #61 leaves widget #61 listed.
  const again = fakeTerminal();
  const next = choosePr(['acme/widget', 'acme/gadget'], adapters, { ...again, statePath, now });
  again.press('s', 'return');
  assert.equal(await next, 'https://github.com/acme/gadget/pull/7');
  const state = JSON.parse(await (await import('node:fs/promises')).readFile(statePath, 'utf8'));
  assert.deepEqual(Object.keys(state.skipped), ['acme/gadget#61']);
  assert.deepEqual(Object.keys(state.lastLooked).sort(), ['acme/gadget', 'acme/widget']);
});

test('several repositories: one that can\'t be read is named in the header, the others still list', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'picker-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'picker.json');
  const adapters = {
    findClone: async (owner, repo) => { if (repo === 'api') throw new Error('No local repository matching acme/api found'); },
    viewer: async () => ME, listOpenPrs: async () => [pr(5)], reviewCommit: async () => null,
  };
  const term = fakeTerminal();
  const url = choosePr(['acme/widget', 'acme/api'], adapters, { ...term, statePath });
  term.press('return');
  assert.equal(await url, 'https://github.com/acme/widget/pull/5');
  assert.match(term.text(), /2 repositories: 1 to review \(1 open\) · ⚠ api: couldn't read \(No local repository matching acme\/api found\)/);
  const state = JSON.parse(await (await import('node:fs/promises')).readFile(statePath, 'utf8'));
  assert.deepEqual(Object.keys(state.lastLooked), ['acme/widget']);
  // None readable: the error stops the picker, as with one repository.
  await assert.rejects(choosePr(['acme/api'], adapters, { ...fakeTerminal(), statePath }), /No local repository/);
});

test('aliases name repositories as typed; the rest keep the usual label', () => {
  const repos = ['acme/word-word-word-fe', 'acme/word-word-word-be', 'acme/api'];
  assert.deepEqual(repoLabels(repos), { 'acme/word-word-word-fe': '…-word-word-fe', 'acme/word-word-word-be': '…-word-word-be', 'acme/api': 'api' });
  assert.deepEqual(repoLabels(repos, { 'acme/word-word-word-fe': 'fe', 'acme/word-word-word-be': 'be' }), { 'acme/word-word-word-fe': 'fe', 'acme/word-word-word-be': 'be', 'acme/api': 'api' });
  // One alias set: the other long name no longer clashes and gets its own cut name.
  assert.deepEqual(repoLabels(repos.slice(0, 2), { 'acme/word-word-word-fe': 'frontend/web.1' }), { 'acme/word-word-word-fe': 'frontend/web.1', 'acme/word-word-word-be': 'word-word-wor…' });
});

test('aliasProblem: 1 to 14 allowed characters, not another repository\'s alias or name', () => {
  const repos = ['acme/widget', 'acme/gadget'];
  assert.equal(aliasProblem('w', 'acme/widget', repos), null);
  assert.equal(aliasProblem('widget', 'acme/widget', repos), null);
  assert.match(aliasProblem('', 'acme/widget', repos), /1 to 14 characters/);
  assert.match(aliasProblem('abcdefghijklmno', 'acme/widget', repos), /1 to 14 characters/);
  assert.match(aliasProblem('my alias', 'acme/widget', repos), /letters, digits/);
  assert.match(aliasProblem('Gadget', 'acme/widget', repos), /already used by acme\/gadget/);
  assert.match(aliasProblem('g', 'acme/widget', repos, { 'acme/gadget': 'G' }), /already used by acme\/gadget/);
});

test('several repositories with aliases: the column shows them', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'picker-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const adapters = { findClone: async () => {}, viewer: async () => ME, listOpenPrs: async (repo) => [pr(repo.endsWith('fe') ? 61 : 7)], reviewCommit: async () => null };
  const term = fakeTerminal();
  term.output.rows = 20;
  const url = choosePr(['acme/word-word-word-fe', 'acme/word-word-word-be'], adapters, { ...term, statePath: join(dir, 'picker.json'), aliases: { 'acme/word-word-word-fe': 'fe', 'acme/word-word-word-be': 'be' } });
  term.press('return');
  await url;
  assert.match(term.text(), /fe  #61/);
  assert.match(term.text(), /be  #7 /);
});

test('readConfig: repository entries may be objects with an alias, checked like the picker', async (t) => {
  const { readConfig } = await import('../src/adapters.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'alias-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  const read = async (repositories) => { await writeFile(path, JSON.stringify({ model: 'm', repositories })); return readConfig(path); };
  const config = await read([{ repo: 'https://github.com/acme/word-word-word-fe', alias: 'fe' }, 'acme/word-word-word-be', { repo: 'acme/api' }]);
  assert.deepEqual(config.repositories, ['acme/word-word-word-fe', 'acme/word-word-word-be', 'acme/api']);
  assert.deepEqual(config.repositoryAliases, { 'acme/word-word-word-fe': 'fe' });
  await assert.rejects(read([{ repo: 'acme/widget', name: 'w' }]), /unknown key "name"/);
  await assert.rejects(read([{ alias: 'w' }]), /must look like owner\/repo/);
  await assert.rejects(read([{ repo: 'acme/widget', alias: 'has space' }]), /alias "has space" for acme\/widget: an alias may use letters/);
  await assert.rejects(read([{ repo: 'acme/widget', alias: 'x' }, { repo: 'acme/gadget', alias: 'X' }]), /alias "x" for acme\/widget: "x" is already used by acme\/gadget/);
  await assert.rejects(read([{ repo: 'acme/widget', alias: 3 }]), /must be text/);
});
