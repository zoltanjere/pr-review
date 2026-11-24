import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidatePrs } from '../src/select.mjs';
import { WATCH_EVENTS, departed, notify, watchConfig, watchEvents } from '../src/watch.mjs';

const ME = 'me';
const REPO = 'acme/widget';
const NOW = Date.parse('2026-11-23T12:00:00Z');
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const pr = (number, extra = {}) => ({
  number, title: `PR ${number}`, author: { login: 'alice' }, isDraft: false, headRefOid: OLD,
  latestReviews: [], reviewRequests: [], createdAt: '2026-11-20T10:00:00Z', updatedAt: '2026-11-22T10:00:00Z', ...extra,
});
const myReview = (state, head = OLD) => ({ author: { login: ME }, state, body: `Reviewed at \`${head.slice(0, 7)}\` with AI assistance.`, commit: { oid: '' } });
const review = (login, state, at = '2026-11-23T11:00:00Z') => ({ author: { login }, state, submittedAt: at, body: '' });

async function scan(prs) {
  const list = await candidatePrs(prs, ME, { now: NOW, commitsSince: async () => ({ count: 2, last: '2026-11-23T11:00:00Z' }) });
  return { viewer: ME, all: prs, list };
}

// Two polls: the first primes (or uses the given memory), the second sees the change.
async function polls(first, second, options = {}) {
  const primed = watchEvents({ repo: REPO, scan: await scan(first), now: NOW, ...options });
  return watchEvents({ repo: REPO, scan: await scan(second), memory: primed.memory, now: NOW, ...options, ...options.second });
}

test('config: default events, unknown names stop with the valid list, interval bounds', () => {
  // No watch block, or "all": every event.
  assert.deepEqual(watchConfig({}), { events: WATCH_EVENTS, intervalMinutes: 5 });
  assert.deepEqual(watchConfig({ watch: { events: ['all'] } }).events, WATCH_EVENTS);
  assert.deepEqual(watchConfig({ watch: { events: ['new', 'all'] } }).events, WATCH_EVENTS);
  assert.deepEqual(watchConfig({ watch: { events: ['merged', 'new'], intervalMinutes: 3 } }), { events: ['new', 'merged'], intervalMinutes: 3 });
  assert.throws(() => watchConfig({ watch: { events: ['new', 'fixes'] } }), new RegExp(`Unknown watch event "fixes".*Valid: all, ${WATCH_EVENTS.join(', ')}`));
  assert.throws(() => watchConfig({ watch: { events: [] } }), /non-empty list/);
  assert.throws(() => watchConfig({ watch: { intervalMinutes: 1 } }), /at least 2/);
  assert.throws(() => watchConfig({ watch: [] }), /must be an object/);
});

test('the first poll only records, so open PRs and old pushes never notify', async () => {
  const result = watchEvents({ repo: REPO, scan: await scan([pr(1), pr(2, { latestReviews: [myReview('CHANGES_REQUESTED')], headRefOid: NEW })]), events: WATCH_EVENTS, now: NOW });
  assert.deepEqual(result.notifications, []);
  assert.equal(result.memory.primed[REPO], new Date(NOW).toISOString());
  assert.equal(result.memory.open[`${REPO}#2`].notifiedHead, NEW);
});

test('new: a PR opened, or moved out of draft, notifies once; mine, bots and drafts do not', async () => {
  const before = [pr(1), pr(3, { isDraft: true })];
  const after = [pr(1), pr(2, { author: { login: 'octo-dev' } }), pr(3), pr(4, { author: { login: ME } }), pr(5, { author: { login: 'bot[bot]' } }), pr(6, { isDraft: true })];
  const { notifications, memory } = await polls(before, after);
  assert.deepEqual(notifications.map((n) => [n.number, n.text]), [[2, '● #2 new PR from octo-dev'], [3, '● #3 new PR from alice']]);
  assert.equal(notifications[0].url, 'https://github.com/acme/widget/pull/2');
  const again = watchEvents({ repo: REPO, scan: await scan(after), memory, now: NOW });
  assert.deepEqual(again.notifications, []);
});

test('fixes-after-changes: pushes after my Request changes notify once per head, not after Approve or Comment', async () => {
  const reviewed = [pr(1, { latestReviews: [myReview('CHANGES_REQUESTED')] }), pr(2, { latestReviews: [myReview('APPROVED')] }), pr(3, { latestReviews: [myReview('COMMENTED')] })];
  const pushed = reviewed.map((item) => ({ ...item, headRefOid: NEW }));
  const events = ['fixes-after-changes'];
  const { notifications, memory } = await polls(reviewed, pushed, { events });
  assert.deepEqual(notifications.map((n) => [n.number, n.events, n.text]), [[1, ['fixes-after-changes'], '⟳ #1 fixes pushed by alice · 2 new commits']]);
  assert.deepEqual(watchEvents({ repo: REPO, scan: await scan(pushed), memory, events, now: NOW }).notifications, []);
});

test('reviewed-updated covers every review type, and one push gives one notification with fixes-after-changes on too', async () => {
  const reviewed = [pr(1, { latestReviews: [myReview('CHANGES_REQUESTED')] }), pr(2, { latestReviews: [myReview('APPROVED')] }), pr(3, { latestReviews: [myReview('COMMENTED')] })];
  const pushed = reviewed.map((item) => ({ ...item, headRefOid: NEW }));
  const both = await polls(reviewed, pushed, { events: ['fixes-after-changes', 'reviewed-updated'] });
  assert.deepEqual(both.notifications.map((n) => n.text), ['⟳ #1 fixes pushed by alice · 2 new commits', '↑ #2 updated since your approval · by alice · 2 new commits', '↑ #3 updated since your comment · by alice · 2 new commits']);
  const only = await polls(reviewed, pushed, { events: ['reviewed-updated'] });
  assert.deepEqual(only.notifications.map((n) => n.events[0]), ['reviewed-updated', 'reviewed-updated', 'reviewed-updated']);
});

test('a review GitHub dismissed on the push still counts: updates and merges notify as after the review', async () => {
  const shipped = (head) => ({ ...myReview('APPROVED', head), body: `**Verdict:** ✅ Ship. Only minor items.\n\n---\n<sub>Reviewed at \`${head.slice(0, 7)}\` with AI assistance.</sub>` });
  const reviewed = [pr(1, { latestReviews: [shipped(OLD)] })];
  // The push dismisses the approval: GitHub now reports it only as DISMISSED.
  const pushed = [{ ...reviewed[0], headRefOid: NEW, latestReviews: [{ ...shipped(OLD), state: 'DISMISSED' }] }];
  const { notifications, memory } = await polls(reviewed, pushed, { events: ['reviewed-updated'] });
  assert.deepEqual(notifications.map((n) => n.text), ['↑ #1 updated since your approval · by alice · 2 new commits']);
  const outcomes = { 1: { state: 'MERGED', mergedBy: 'sam', title: 'PR 1', url: 'https://github.com/acme/widget/pull/1' } };
  const merged = watchEvents({ repo: REPO, scan: await scan([]), memory, events: ['merged-reviewed'], outcomes, now: NOW });
  assert.deepEqual(merged.notifications.map((n) => n.text), ['✔ #1 merged by sam']);
});

test('a skipped PR does not notify about pushes until its head changes', async () => {
  const reviewed = [pr(1, { latestReviews: [myReview('CHANGES_REQUESTED')] })];
  const pushed = [{ ...reviewed[0], headRefOid: NEW }];
  const skipped = (item) => item.headRefOid === NEW;
  assert.deepEqual((await polls(reviewed, pushed, { skipped })).notifications, []);
});

test('merges: merged-reviewed for PRs I reviewed or own, merged for any, one notification with both on, closed is quiet', async () => {
  const before = [pr(1, { latestReviews: [myReview('APPROVED')] }), pr(2), pr(3, { author: { login: ME } }), pr(4)];
  const outcomes = {
    1: { state: 'MERGED', mergedBy: 'lee-park', title: 'PR 1', url: 'https://github.com/acme/widget/pull/1' },
    2: { state: 'MERGED', mergedBy: 'sam', title: 'PR 2', url: 'https://github.com/acme/widget/pull/2' },
    3: { state: 'MERGED', mergedBy: null, title: 'PR 3', url: 'https://github.com/acme/widget/pull/3' },
    4: { state: 'CLOSED', title: 'PR 4', url: 'https://github.com/acme/widget/pull/4' },
  };
  const reviewedOnly = await polls(before, [], { events: ['merged-reviewed'], second: { outcomes } });
  assert.deepEqual(reviewedOnly.notifications.map((n) => [n.number, n.text]), [[1, '✔ #1 merged by lee-park'], [3, '✔ #3 merged']]);
  const both = await polls(before, [], { events: ['merged', 'merged-reviewed'], second: { outcomes } });
  assert.deepEqual(both.notifications.map((n) => [n.number, n.events]), [[1, ['merged-reviewed']], [2, ['merged']], [3, ['merged-reviewed']]]);
  assert.deepEqual(Object.keys(both.memory.open), []);
});

test('a departed PR is kept for the next poll when its outcome could not be read', async () => {
  const result = await polls([pr(1)], [], { events: ['merged'] });
  assert.deepEqual(result.notifications, []);
  assert.deepEqual(departed(result.memory, REPO, []), [1]);
  assert.deepEqual(Object.keys((await polls([pr(1)], [], { events: ['new'] })).memory.open), []);
});

test('review-requested notifies on a new request, combined with new into one notification', async () => {
  const asked = { reviewRequests: [{ login: ME }] };
  const { notifications } = await polls([pr(1)], [pr(1, asked), pr(2, { ...asked, author: { login: 'octo-dev' } })], { events: ['new', 'review-requested'] });
  assert.deepEqual(notifications.map((n) => [n.number, n.events, n.text]), [
    [1, ['review-requested'], '★ #1 review requested · PR by alice'],
    [2, ['new', 'review-requested'], '● #2 new PR from octo-dev · review requested'],
  ]);
});

test('my-pr-reviewed: a new review from someone else on my PR, not my own comment or Copilot', async () => {
  const mine = (reviews) => pr(1, { author: { login: ME }, latestReviews: reviews });
  const { notifications } = await polls([mine([review('ana', 'COMMENTED', '2026-11-22T10:00:00Z')])], [mine([
    review('ana', 'APPROVED'), review('sam', 'CHANGES_REQUESTED'), review(ME, 'COMMENTED'), review('copilot-pull-request-reviewer', 'COMMENTED'),
  ])], { events: ['my-pr-reviewed'] });
  assert.deepEqual(notifications.map((n) => n.text), ['✅ your #1 got a review · approved by ana, changes requested by sam']);
});

test('my-pr-conflicts: notifies on the change to conflicting, ignores UNKNOWN, again only after mergeable', async () => {
  const mine = (mergeable) => pr(1, { author: { login: ME }, mergeable });
  const events = ['my-pr-conflicts'];
  let memory = watchEvents({ repo: REPO, scan: await scan([mine('MERGEABLE')]), events, now: NOW }).memory;
  const step = async (mergeable) => {
    const result = watchEvents({ repo: REPO, scan: await scan([mine(mergeable)]), memory, events, now: NOW });
    memory = result.memory;
    return result.notifications.map((n) => n.text);
  };
  assert.deepEqual(await step('CONFLICTING'), ['⚠ your #1 has merge conflicts · update it from the base branch']);
  assert.deepEqual(await step('UNKNOWN'), []);
  assert.deepEqual(await step('CONFLICTING'), []);
  assert.deepEqual(await step('MERGEABLE'), []);
  assert.deepEqual(await step('CONFLICTING'), ['⚠ your #1 has merge conflicts · update it from the base branch']);
});

test('disabled events never fire', async () => {
  const before = [pr(1, { latestReviews: [myReview('CHANGES_REQUESTED')] })];
  const after = [{ ...before[0], headRefOid: NEW, reviewRequests: [{ login: ME }] }, pr(2)];
  assert.deepEqual((await polls(before, after, { events: ['merged'] })).notifications, []);
});

test('notify uses terminal-notifier with the PR link and a group per PR, osascript when it is missing', async () => {
  const calls = [];
  const notification = { repo: REPO, number: 61, title: 'fix: "quotes" & $(stuff)', url: 'https://github.com/acme/widget/pull/61',
    headline: '⟳ #61 fixes pushed', detail: 'by octo-dev · 2 new commits', text: '⟳ #61 fixes pushed by octo-dev · 2 new commits' };
  assert.equal(await notify(notification, { exec: async (...args) => { calls.push(args); } }), 'terminal-notifier');
  assert.deepEqual(calls[0], ['terminal-notifier', ['-title', '⟳ #61 fixes pushed', '-subtitle', 'fix: "quotes" & $(stuff)', '-message', 'by octo-dev · 2 new commits · acme/widget',
    '-open', 'https://github.com/acme/widget/pull/61', '-group', 'acme/widget#61', '-sound', 'default']]);
  const fallback = [];
  const missing = async (command, args) => {
    fallback.push([command, args]);
    if (command === 'terminal-notifier') throw Object.assign(new Error('not found'), { code: 'ENOENT' });
  };
  assert.equal(await notify(notification, { exec: missing }), 'osascript');
  const [command, args] = fallback[1];
  assert.equal(command, 'osascript');
  // The title is an argument, never part of the AppleScript source.
  assert.deepEqual(args.slice(-3), ['by octo-dev · 2 new commits · acme/widget · run reviewpr', '⟳ #61 fixes pushed', 'fix: "quotes" & $(stuff)']);
  assert(!args.slice(0, -3).some((arg) => arg.includes('quotes')));
  // terminal-notifier installed but refused by macOS: still shown via osascript.
  const refused = async (command) => { if (command === 'terminal-notifier') throw new Error('Notifications are not allowed for this application'); };
  assert.match(await notify(notification, { exec: refused }), /^osascript \(terminal-notifier failed/);
  const neither = async () => { throw new Error('no'); };
  await assert.rejects(notify(notification, { exec: neither }), /terminal-notifier: no; osascript: no/);
});

test('a rebase with no new changes stays quiet; the next real push notifies', async () => {
  const reviewed = [pr(1, { latestReviews: [myReview('CHANGES_REQUESTED')], baseRefName: 'main' })];
  const scanWith = async (prs, newer, same) => {
    const list = await candidatePrs(prs, ME, { now: NOW, commitsSince: async () => newer, compareChanges: async () => same });
    return { viewer: ME, all: prs, list };
  };
  const events = ['fixes-after-changes', 'reviewed-updated'];
  let memory = watchEvents({ repo: REPO, scan: await scanWith(reviewed, null, null), events, now: NOW }).memory;
  const rebased = [{ ...reviewed[0], headRefOid: NEW }];
  const quiet = watchEvents({ repo: REPO, scan: await scanWith(rebased, { count: 1, status: 'diverged', merges: 0 }, true), memory, events, now: NOW });
  assert.deepEqual(quiet.notifications, []);
  memory = quiet.memory;
  const fixed = [{ ...reviewed[0], headRefOid: 'c'.repeat(40) }];
  const loud = watchEvents({ repo: REPO, scan: await scanWith(fixed, { count: 2, status: 'diverged', merges: 0 }, false), memory, events, now: NOW });
  assert.deepEqual(loud.notifications.map((n) => n.headline), ['⟳ #1 fixes pushed']);
});
