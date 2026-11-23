import { execFile } from 'node:child_process';
import { isBot, isRequested, otherReviews } from './select.mjs';

// Watch: which PR changes are worth a desktop notification. It reuses the
// picker's scan (scanRepo), so it needs no model and only reads GitHub. This
// module holds the parts both watch modes share: the config check, the event
// rules (a pure function over a scan and the last memory) and the notifier.

// In the order a combined notification lists them.
export const WATCH_EVENTS = [
  'new', 'fixes-after-changes', 'reviewed-updated', 'merged-reviewed', 'merged',
  'review-requested', 'my-pr-reviewed', 'my-pr-conflicts',
];
export const DEFAULT_EVENTS = ['new', 'fixes-after-changes'];
const DEFAULT_INTERVAL = 5;
const MIN_INTERVAL = 2;

// config.watch, checked: a typo stops watch instead of silently disabling a notification.
export function watchConfig(config = {}) {
  const watch = config.watch ?? {};
  if (typeof watch !== 'object' || Array.isArray(watch)) throw new Error('config.json "watch" must be an object.');
  const events = watch.events ?? DEFAULT_EVENTS;
  if (!Array.isArray(events) || !events.length) throw new Error(`config.json "watch.events" must be a non-empty list of: ${WATCH_EVENTS.join(', ')}.`);
  const unknown = events.filter((name) => !WATCH_EVENTS.includes(name));
  if (unknown.length) throw new Error(`Unknown watch event${unknown.length === 1 ? '' : 's'} ${unknown.map((name) => `"${name}"`).join(', ')} in config.json. Valid: ${WATCH_EVENTS.join(', ')}.`);
  const interval = watch.intervalMinutes ?? DEFAULT_INTERVAL;
  if (!Number.isFinite(interval) || interval < MIN_INTERVAL) throw new Error(`config.json "watch.intervalMinutes" must be a number of at least ${MIN_INTERVAL}.`);
  return { events: WATCH_EVENTS.filter((name) => events.includes(name)), intervalMinutes: interval };
}

const prKey = (repo, number) => `${repo}#${number}`;
const prUrl = (repo, number) => `https://github.com/${repo}/pull/${number}`;
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
const REVIEW_NAMES = { APPROVED: 'approval', CHANGES_REQUESTED: 'change request', COMMENTED: 'comment' };
const SAID = {
  APPROVED: { icon: '✅', text: 'approved by' },
  CHANGES_REQUESTED: { icon: '🔴', text: 'changes requested by' },
  COMMENTED: { icon: '💬', text: 'comment from' },
};

// What watch remembers about one open PR between polls.
function entryFor(pr, viewer, previous) {
  const own = pr.author?.login === viewer;
  const mine = (pr.latestReviews ?? []).filter((review) => review.author?.login === viewer).at(-1);
  const mergeable = pr.mergeable === 'UNKNOWN' || !pr.mergeable ? previous?.mergeable ?? null : pr.mergeable;
  return {
    head: pr.headRefOid ?? null,
    author: pr.author?.login ?? null,
    own,
    reviewable: !own && !pr.isDraft && !isBot(pr.author),
    reviewed: !own && Boolean(mine && mine.state !== 'DISMISSED'),
    requested: !own && isRequested(pr, viewer),
    reviews: own ? otherReviews(pr, viewer).map((review) => `${review.author.login}:${review.state}:${review.submittedAt ?? ''}`) : [],
    mergeable,
    notifiedHead: previous?.notifiedHead ?? null,
  };
}

// The PRs watch remembered as open that are no longer in the list: merged or
// closed. The caller looks them up (prOutcome) only when a merge event is on.
export function departed(memory, repo, all) {
  const open = new Set(all.map((pr) => prKey(repo, pr.number)));
  return Object.keys(memory.open ?? {}).filter((key) => key.startsWith(`${repo}#`) && !open.has(key))
    .map((key) => Number(key.slice(repo.length + 1)));
}

// The notifications for one poll, and the memory to keep. Pure: no I/O.
// - scan: { viewer, all, list } from scanRepo.
// - memory: { primed, open } from state/watch.json (empty on the first run).
// - events: the enabled event names; skipped(pr): the picker's skip check;
//   outcomes: { [number]: prOutcome result } for the departed PRs.
// The first run for a repository only records, so old PRs don't notify.
// One notification per PR per poll, naming every event that matched it.
export function watchEvents({ repo, scan, memory = {}, events = DEFAULT_EVENTS, skipped = () => false, outcomes = {}, now = Date.now() }) {
  const on = new Set(events);
  const { viewer, all, list } = scan;
  const before = memory.open ?? {};
  const open = Object.fromEntries(Object.entries(before).filter(([key]) => !key.startsWith(`${repo}#`)));
  const primed = Boolean(memory.primed?.[repo]);
  const candidates = new Map(list.prs.map((pr) => [pr.number, pr]));
  const notifications = [];
  const add = (pr, parts) => {
    if (!parts.length) return;
    const text = [parts[0].text, ...parts.slice(1).map((part) => part.tag)].join(' · ');
    notifications.push({ repo, number: pr.number, title: pr.title ?? '', url: pr.url ?? prUrl(repo, pr.number), events: parts.map((part) => part.event), text });
  };

  for (const pr of all) {
    const key = prKey(repo, pr.number);
    const previous = before[key];
    const entry = entryFor(pr, viewer, previous);
    const candidate = candidates.get(pr.number);
    const pushed = ['fixes', 'approved'].includes(candidate?.state?.key) && entry.head !== entry.notifiedHead;
    if (pushed) entry.notifiedHead = entry.head;
    open[key] = entry;
    if (!primed) continue;
    const parts = [];
    const actionable = !skipped(pr);
    const n = `#${pr.number}`;
    if (on.has('new') && actionable && entry.reviewable && !previous?.reviewable) {
      parts.push({ event: 'new', text: `● ${n} new PR from ${entry.author}`, tag: 'new PR' });
    }
    if (pushed && actionable) {
      const { review, commits } = candidate.state;
      const count = commits ? ` · ${plural(commits, 'new commit')}` : '';
      if (review === 'CHANGES_REQUESTED' && (on.has('fixes-after-changes') || on.has('reviewed-updated'))) {
        parts.push({ event: on.has('fixes-after-changes') ? 'fixes-after-changes' : 'reviewed-updated', text: `⟳ ${n} fixes pushed${count}`, tag: 'fixes pushed' });
      } else if (review !== 'CHANGES_REQUESTED' && on.has('reviewed-updated')) {
        parts.push({ event: 'reviewed-updated', text: `↑ ${n} updated since your ${REVIEW_NAMES[review] ?? 'review'}${count}`, tag: 'updated' });
      }
    }
    if (on.has('review-requested') && actionable && entry.requested && !previous?.requested) {
      parts.push({ event: 'review-requested', text: `★ ${n} review requested`, tag: 'review requested' });
    }
    if (on.has('my-pr-reviewed') && entry.own && previous) {
      const seen = new Set(previous.reviews ?? []);
      const fresh = entry.reviews.filter((signature) => !seen.has(signature))
        .map((signature) => signature.split(':')).filter(([, state]) => SAID[state]);
      if (fresh.length) {
        const lines = fresh.map(([login, state]) => `${SAID[state].text} ${login}`).join(', ');
        parts.push({ event: 'my-pr-reviewed', text: `${SAID[fresh[0][1]].icon} your ${n}: ${lines}`, tag: lines });
      }
    }
    if (on.has('my-pr-conflicts') && entry.own && entry.mergeable === 'CONFLICTING' && previous && previous.mergeable !== 'CONFLICTING') {
      parts.push({ event: 'my-pr-conflicts', text: `⚠ your ${n} has merge conflicts`, tag: 'merge conflicts' });
    }
    add(pr, parts);
  }

  // PRs that left the open list: notify a merge, then forget them. Without a
  // looked-up outcome (lookup failed), keep them and try again next poll.
  const mergeOn = on.has('merged') || on.has('merged-reviewed');
  for (const number of departed({ open: before }, repo, all)) {
    const key = prKey(repo, number);
    const previous = before[key];
    const outcome = outcomes[number];
    if (mergeOn && !outcome) { open[key] = previous; continue; }
    if (!primed || !outcome || outcome.state !== 'MERGED') continue;
    const mattered = previous.reviewed || previous.own;
    if (on.has('merged') || (on.has('merged-reviewed') && mattered)) {
      const event = on.has('merged-reviewed') && mattered ? 'merged-reviewed' : 'merged';
      add({ number, title: outcome.title, url: outcome.url }, [{ event, text: `✔ #${number} merged${outcome.mergedBy ? ` by ${outcome.mergedBy}` : ''}`, tag: 'merged' }]);
    }
  }

  return { notifications, memory: { primed: { ...memory.primed, [repo]: memory.primed?.[repo] ?? new Date(now).toISOString() }, open } };
}

// Shows one notification. terminal-notifier when installed (clicking opens
// the PR; one notification per PR, a newer one replaces it), otherwise
// osascript, which can't open a link. Arguments are passed as a list, never
// through a shell or AppleScript source, so titles can't inject anything.
const run = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: 10_000 }, (error) => (error ? reject(error) : resolve()));
});

export async function notify(notification, { exec = run } = {}) {
  const title = `reviewpr · ${notification.repo}`;
  try {
    await exec('terminal-notifier', ['-title', title, '-subtitle', notification.title, '-message', notification.text,
      '-open', notification.url, '-group', prKey(notification.repo, notification.number), '-sound', 'default']);
    return 'terminal-notifier';
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await exec('osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)', '-e', 'end run',
    notification.text, title, notification.title]);
  return 'osascript';
}
