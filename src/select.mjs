import { emitKeypressEvents } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { palette, plainReporter, short } from './ui.mjs';
import { isLive, runSteps } from './steps.mjs';
import { isSkipped, loadState, saveState, skipKey } from './picker-state.mjs';
import { ancestry, followUpMode, reviewState, sameChanges } from './follow-up.mjs';

// Which open PRs still need your review, what state each is in, and an
// arrow-key picker for them. Listing uses read-only gh calls only; no model is
// involved. The only write is the local skip list (state/picker.json).

const DEFAULT_STATE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'state', 'picker.json');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const STALE_DAYS = 14;

// The commit a posted review covered, read from our footer: "Reviewed at
// `a7e50c8`…", or "…by pr-review at `c0ffee1`…" in older posts.
export function reviewedHead(review) {
  return /(?:Reviewed|pr-review|Follow-up) at `([0-9a-f]{7,40})`/.exec(review?.body ?? '')?.[1] ?? null;
}

export const isBot = (author) => Boolean(author?.is_bot) || /\[bot\]$/.test(author?.login ?? '');
export const isRequested = (pr, viewer) => (pr.reviewRequests ?? []).some((request) => request?.login === viewer);

// Each state has a priority (rank), an icon and a colour, so the meaning never
// depends on colour alone. The colour marks the icon and the group heading; the
// label on the right is coloured by age instead (see ageColor). Stale shares the
// Waiting heading and sorts after it.
export const STATES = {
  fixes: { rank: 0, icon: '⟳', heading: 'Fixes pushed', color: 'yellow' },
  requested: { rank: 1, icon: '★', heading: 'Asked for you', color: 'magenta' },
  new: { rank: 2, icon: '●', heading: 'New', color: 'green' },
  updated: { rank: 3, icon: '↑', heading: 'Updated', color: 'cyan' },
  approved: { rank: 3.5, icon: '↑', heading: 'Approved, new commits', color: 'cyan' },
  // Rebased or base merged in, but the PR's own changes are the same as reviewed.
  unchanged: { rank: 3.8, icon: '…', heading: 'No new changes since your review', color: null },
  waiting: { rank: 4, icon: '·', heading: 'Waiting', color: null },
  stale: { rank: 5, icon: '◌', heading: 'Waiting', color: null },
  mine: { rank: 6, icon: '◆', heading: 'Your PRs', color: 'blue' },
};

// Age of the PR's last activity, as a colour: fresh is green, a week old is
// yellow, two weeks or more is red, so a PR nobody touched stands out.
export function ageColor(ms) {
  if (ms === null || ms === undefined) return null;
  if (ms < DAY) return 'green';
  if (ms < 7 * DAY) return null;
  if (ms < STALE_DAYS * DAY) return 'yellow';
  return 'red';
}

// "40m", "5h", "3d".
export function age(ms) {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}

// The state of one listed PR, first match wins. `mine` is your latest review
// (null when none; a dismissed one has the state it was posted as); `covered`
// is the commit it covered; `newer` is { count, last } for the commits since
// then, when known. `seenAt` is when
// you last opened the picker for this repository: New and Updated then mean
// "since you looked"; without it (first visit) they mean the last 24 hours.
// `ageMs` is how long ago the activity in the label happened.
// What other people did on one of your PRs: "2 approvals · 1 change request ·
// conflicts", or "no reviews yet". Your own comments and bot reviews don't count.
// Other people's latest reviews on a PR: not yours, not bots or Copilot.
export const otherReviews = (pr, viewer) => (pr.latestReviews ?? []).filter((review) => review?.author?.login
  && review.author.login !== viewer && !isBot(review.author) && !/copilot/i.test(review.author.login));

export function ownLabel(pr, viewer) {
  const others = otherReviews(pr, viewer);
  const reviews = [['APPROVED', 'approval', 'approvals'], ['CHANGES_REQUESTED', 'change request', 'change requests'], ['COMMENTED', 'comment', 'comments']]
    .map(([state, one, many]) => [others.filter((review) => review.state === state).length, one, many])
    .filter(([n]) => n).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  return [pr.isDraft ? 'draft' : null, ...(reviews.length ? reviews : ['no reviews yet']), pr.mergeable === 'CONFLICTING' ? 'conflicts' : null]
    .filter(Boolean).join(' · ');
}

export function prState(pr, viewer, { mine = null, covered = null, newer = null, unchanged = null, now = Date.now(), seenAt = null } = {}) {
  const sinceLooked = Number.isFinite(seenAt);
  // Milliseconds since a timestamp, or null when it's missing: unknown is never "new".
  const since = (iso) => { const time = Date.parse(iso ?? ''); return Number.isNaN(time) ? null : now - time; };
  const within = (iso, ms) => since(iso) !== null && since(iso) < ms;
  // New or changed: after your last look, or in the last 24 hours on a first visit.
  const fresh = (iso) => (sinceLooked ? Date.parse(iso ?? '') > seenAt : within(iso, DAY));
  const at = (key, time) => ({
    key, ...STATES[key], ageMs: since(time),
    ...(sinceLooked && (key === 'new' || key === 'updated') ? { heading: `${STATES[key].heading} since you looked` } : {}),
  });
  const head = String(pr.headRefOid ?? '');
  // Your own PR: listed for a self-review, never treated as reviewed by you.
  if (pr.author?.login === viewer) return { ...at('mine', pr.updatedAt), label: ownLabel(pr, viewer) };
  if (mine && covered && !head.startsWith(covered)) {
    const count = newer?.count ?? 0;
    const what = count ? `${count} new commit${count === 1 ? '' : 's'}` : 'new commits';
    // You approved: lower priority than fixes pushed after your change request.
    // `review` and `commits` tell watch which review type the pushes came after.
    const pushed = { review: mine.state, commits: newer?.count ?? null };
    // Only rebased or merged the base in: nothing for you to check yet. Watch
    // doesn't notify these; the next real change makes it Fixes pushed again.
    if (unchanged) {
      const how = unchanged === 'rebased' ? 'rebased only' : `merged ${pr.baseRefName || 'the base branch'} only`;
      return { ...at('unchanged', newer?.last ?? pr.updatedAt), ...pushed, label: mine.state === 'APPROVED' ? `approved · ${how}` : how };
    }
    // When Enter can't run a follow-up (history rewritten, a hand-written
    // review…), say so before it's pressed. After an approval, Enter reviews
    // only the new commits.
    const mode = followUpMode({ latest: { state: mine.state, body: mine.body, commit: covered }, history: ancestry(newer?.status) });
    const fallback = mode.mode === 'full' && mode.short ? ` · full review: ${mode.short}` : '';
    if (mine.state === 'APPROVED') return { ...at('approved', newer?.last ?? pr.updatedAt), ...pushed, followUp: mode.mode === 'follow-up', label: `approved · ${what}${fallback}` };
    return { ...at('fixes', newer?.last ?? pr.updatedAt), ...pushed, followUp: mode.mode === 'follow-up', label: `${what}${fallback}` };
  }
  // The age is its own column (formatRows), so labels only add what the
  // group heading doesn't already say.
  if (isRequested(pr, viewer)) return { ...at('requested', pr.updatedAt), label: 'requested' };
  if (fresh(pr.createdAt)) return { ...at('new', pr.createdAt), label: '' };
  if (fresh(pr.updatedAt)) return { ...at('updated', pr.updatedAt), label: '' };
  if (since(pr.updatedAt) >= STALE_DAYS * DAY) return { ...at('stale', pr.updatedAt), label: 'idle' };
  return { ...at('waiting', pr.updatedAt), label: '' };
}

// Keeps the PRs worth reviewing, each with its state: no review from you yet,
// or your latest review was dismissed on the commit it covered, covers an
// older commit, or you were asked again. Drafts, your own PRs and bot PRs are hidden. When the reviewed
// commit can't be found, the PR is shown: listing too much is safer than
// hiding one. Sorted by state priority, then by the age shown in the row.
// `commitsSince(number, covered, head)` counts the commits after your review;
// it is called only for PRs you reviewed that have changed since.
// `compareChanges(number, base, covered, head)` says whether the PR's own
// changes are the same as when you reviewed (true, false or null); it is
// called only after a rebase, or when every new commit is a merge.
// By state priority, then, within a group, by the age shown in the row
// (youngest first: 1h, 3h, 5h); unknown ages last.
const shownAge = (pr) => (Number.isFinite(pr.state.ageMs) ? pr.state.ageMs : Infinity);
const byPriority = (a, b) => a.state.rank - b.state.rank || shownAge(a) - shownAge(b);

export async function candidatePrs(prs, viewer, { commitOf = async () => null, commitsSince = async () => null, compareChanges = async () => null, now = Date.now(), seenAt = null } = {}) {
  const hidden = { reviewed: 0, draft: 0, bot: 0 };
  const kept = [];
  for (const pr of prs) {
    // Your own PRs are listed (drafts too) for a self-review; your comments on them don't count as a review.
    if (pr.author?.login === viewer) { kept.push({ ...pr, state: prState(pr, viewer, { now, seenAt }) }); continue; }
    if (pr.isDraft) { hidden.draft++; continue; }
    if (isBot(pr.author)) { hidden.bot++; continue; }
    const latest = (pr.latestReviews ?? []).filter((review) => review.author?.login === viewer).at(-1);
    // A dismissed review still counts as yours. Dismissed on the commit it
    // covered, it stays listed: someone set it aside without new code.
    const mine = latest ? { ...latest, state: reviewState(latest) } : null;
    const covered = mine ? reviewedHead(mine) ?? (mine.commit?.oid || await commitOf(pr.number)) : null;
    if (covered && String(pr.headRefOid ?? '').startsWith(covered) && !isRequested(pr, viewer) && latest.state !== 'DISMISSED') { hidden.reviewed++; continue; }
    const changed = mine && covered && !String(pr.headRefOid ?? '').startsWith(covered);
    // Whatever it returns or throws, a failed count never stops the listing.
    const newer = changed ? await Promise.resolve().then(() => commitsSince(pr.number, covered, pr.headRefOid)).catch(() => null) : null;
    const rebased = newer?.status === 'diverged';
    const mergedOnly = newer?.status === 'ahead' && newer.count > 0 && newer.merges === newer.count;
    const same = rebased || mergedOnly
      ? await Promise.resolve().then(() => compareChanges(pr.number, pr.baseRefName, covered, pr.headRefOid)).catch(() => null) : null;
    const unchanged = same === true ? (rebased ? 'rebased' : 'merged') : null;
    kept.push({ ...pr, state: prState(pr, viewer, { mine, covered, newer, unchanged, now, seenAt }) });
  }
  kept.sort(byPriority);
  return { prs: kept, hidden, open: prs.length };
}

export function hiddenSummary({ hidden, open }) {
  const parts = [
    [hidden.reviewed, 'reviewed'], [hidden.draft, hidden.draft === 1 ? 'draft' : 'drafts'],
    [hidden.bot, hidden.bot === 1 ? 'bot' : 'bots'],
  ].filter(([count]) => count).map(([count, name]) => `${count} ${name}`);
  return `${open} open${parts.length ? `; hidden: ${parts.join(', ')}` : ''}`;
}

// "#61  author  title", with numbers and authors aligned across the list. A PR
// with a state gets its icon in front, in the state's colour, and the age of
// its activity right after the number, coloured by age, so the time sits next
// to the PR it belongs to. A label with more detail ("3 new commits") follows
// the titles, not the terminal's right edge, and rows are at most MAX_WIDTH
// wide. Skipped rows are dimmed whole.
const MAX_WIDTH = 100;
// With several repositories, each row names its repository in a column after
// the icon: the repository's name, owner/repo when two names are the same,
// cut to REPO_LABEL_MAX characters so a long name can't push the titles right.
// Labels still equal after the cut keep the end of owner/repo instead.
// One repository: null, and the rows look as they always did.
export const REPO_LABEL_MAX = 14;
export function repoLabels(repos) {
  if (repos.length < 2) return null;
  const name = (repo) => repo.split('/')[1];
  const clash = (repo) => repos.some((other) => other !== repo && name(other).toLowerCase() === name(repo).toLowerCase());
  const labels = Object.fromEntries(repos.map((repo) => [repo, short(clash(repo) ? repo : name(repo), REPO_LABEL_MAX)]));
  const taken = (label) => Object.values(labels).filter((other) => other === label).length > 1;
  const tail = (repo) => (repo.length > REPO_LABEL_MAX ? `…${repo.slice(-(REPO_LABEL_MAX - 1))}` : repo);
  return Object.fromEntries(repos.map((repo) => [repo, taken(labels[repo]) ? tail(repo) : labels[repo]]));
}

export function formatRows(prs, width = 100, { color = false, labels = null } = {}) {
  const c = palette(color);
  const labelOf = (pr) => (labels ? labels[pr.repo] ?? '' : '');
  const repoWidth = labels ? Math.max(0, ...prs.map((pr) => labelOf(pr).length)) : 0;
  const repo = (pr, paint = (text) => text) => (repoWidth ? `${paint(labelOf(pr).padEnd(repoWidth))}  ` : '');
  const numberWidth = Math.max(0, ...prs.map((pr) => String(pr.number).length)) + 1;
  const authorWidth = Math.min(28, Math.max(0, ...prs.map((pr) => (pr.author?.login ?? '').length)));
  const author = (pr) => short(pr.author?.login ?? '', authorWidth).padEnd(authorWidth);
  const number = (pr) => `#${pr.number}`.padEnd(numberWidth);
  if (!prs.some((pr) => pr.state)) {
    return prs.map((pr) => {
      const head = `${repo(pr)}${number(pr)}  ${author(pr)}  `;
      return head + short(pr.title ?? '', Math.max(10, width - head.length - 4));
    });
  }
  const ageOf = (pr) => (Number.isFinite(pr.state?.ageMs) ? age(pr.state.ageMs) : '');
  const ageWidth = Math.max(0, ...prs.map((pr) => ageOf(pr).length));
  const labelWidth = Math.max(0, ...prs.map((pr) => (pr.state?.label ?? '').length));
  const headWidth = 2 + (repoWidth ? repoWidth + 2 : 0) + numberWidth + 2 + (ageWidth ? ageWidth + 2 : 0) + authorWidth + 2;
  const room = Math.min(width, MAX_WIDTH) - headWidth - (labelWidth ? labelWidth + 2 : 0);
  const titleWidth = Math.max(10, Math.min(room, Math.max(0, ...prs.map((pr) => (pr.title ?? '').length))));
  return prs.map((pr) => {
    const state = pr.state ?? { icon: ' ', label: '' };
    const when = ageWidth ? `${ageOf(pr).padEnd(ageWidth)}  ` : '';
    const title = short(pr.title ?? '', titleWidth);
    const tail = state.label ? `${title.padEnd(titleWidth)}  ${state.label}` : title;
    if (state.dim) return c.dim(`${state.icon} ${repo(pr)}${number(pr)}  ${when}${author(pr)}  ${tail}`);
    const paint = (name, part) => (name ? c[name](part) : part);
    return `${paint(state.color, state.icon)} ${repo(pr, c.dim)}${number(pr)}  ${paint(ageColor(state.ageMs), when)}${author(pr)}  ${tail}`;
  });
}

// Arrow-key picker. Returns the chosen row's index, or null when cancelled.
// ↑/↓ or k/j move, Enter picks, q, Esc or Ctrl-C cancels. A row given as
// { heading } is a group title the cursor skips. `actions` maps a key to a
// handler (index) => { rows, title, index } | undefined, to redraw the list.
// `onMove(index)` may return such an update after the cursor moves. `control`,
// when given, gets update(next) to redraw from outside (a background refresh)
// and index() for the highlighted row. `status()` is a dim line above the keys.
export function pickFromList(title, rows, { input = process.stdin, output = process.stderr, initial = 0, hint = 'Enter review · q cancel', actions = {}, onMove, control, status } = {}) {
  const c = palette(!process.env.NO_COLOR && output.isTTY !== false);
  return new Promise((resolve) => {
    let items = rows;
    let heading = title;
    const isHeading = (i) => typeof items[i] === 'object' && items[i] !== null;
    const selectable = (i) => i >= 0 && i < items.length && !isHeading(i);
    const nearest = (from, step) => {
      let i = from;
      while (i >= 0 && i < items.length && !selectable(i)) i += step;
      return selectable(i) ? i : null;
    };
    const settle = (from) => {
      const start = Math.min(Math.max(0, from), items.length - 1);
      return nearest(start, 1) ?? nearest(start, -1) ?? 0;
    };
    let index = settle(initial);
    let top = 0;
    let drawn = 0;
    const height = () => Math.max(3, Math.min(items.length, (output.rows || 24) - 4));
    const draw = () => {
      if (drawn) output.write(`\x1b[${drawn}A\x1b[0J`);
      const size = height();
      // Keep a group's heading on screen above its first row.
      const want = index > 0 && isHeading(index - 1) ? index - 1 : index;
      if (want < top) top = want;
      if (index >= top + size) top = index - size + 1;
      const lines = [c.bold(heading)];
      for (let i = top; i < Math.min(items.length, top + size); i++) {
        if (isHeading(i)) lines.push(`  ${items[i].color ? c.bold(c[items[i].color](items[i].heading)) : c.dim(items[i].heading)}`);
        else lines.push(i === index ? `${c.cyan('❯')} ${c.bold(items[i])}` : `  ${items[i]}`);
      }
      const choices = items.filter((_, i) => !isHeading(i)).length;
      const position = items.slice(0, index + 1).filter((_, i) => !isHeading(i)).length;
      const more = items.length > size ? ` · ${position}/${choices}` : '';
      const line = status?.();
      if (line) lines.push(c.dim(line));
      lines.push(c.dim(`↑/↓ move · ${hint}${more}`));
      output.write(`${lines.join('\n')}\n`);
      drawn = lines.length;
    };
    const apply = (update) => {
      if (!update) return;
      items = update.rows ?? items;
      heading = update.title ?? heading;
      index = settle(update.index ?? index);
    };
    let done = false;
    if (control) {
      control.update = (update) => { if (!done) { apply(update); draw(); } };
      control.index = () => index;
    }
    const finish = (value) => {
      done = true;
      input.off('keypress', onKey);
      try { input.setRawMode?.(false); } catch { /* terminal already gone */ }
      input.pause?.();
      resolve(value);
    };
    const onKey = (text, key = {}) => {
      if (key.name === 'up' || text === 'k' || key.name === 'down' || text === 'j') {
        const up = key.name === 'up' || text === 'k';
        index = (up ? nearest(index - 1, -1) : nearest(index + 1, 1)) ?? index;
        apply(onMove?.(index));
      } else if (key.name === 'return' || key.name === 'enter') return selectable(index) ? finish(index) : undefined;
      else if (key.name === 'escape' || text === 'q' || (key.ctrl && key.name === 'c')) return finish(null);
      else if (text && actions[text]) {
        const update = actions[text](index);
        if (!update) return undefined;
        // An action may pick the row, like Enter (f: full review), or leave
        // the list with its own value (c: settings).
        if (update.choose) return selectable(index) ? finish(index) : undefined;
        if (update.exit !== undefined) return finish(update.exit);
        apply(update);
      } else return undefined;
      draw();
      return undefined;
    };
    emitKeypressEvents(input);
    try { input.setRawMode?.(true); } catch { /* not a terminal */ }
    input.resume?.();
    input.on('keypress', onKey);
    draw();
  });
}

// Rows for the picker: a heading per state group, then that group's PRs.
// Returns the rows and, per row, the PR it stands for (null for a heading).
export function pickerRows(prs, width, { color = false, skipped = () => false, marked = () => false, labels = null } = {}) {
  const shown = prs.map((pr) => (skipped(pr)
    ? { ...pr, state: { ...pr.state, label: ['skipped', pr.state.label].filter(Boolean).join(' · '), dim: true } }
    : marked(pr) ? { ...pr, state: { ...pr.state, label: ['•', pr.state.label].filter(Boolean).join(' ') } } : pr));
  const lines = formatRows(shown, width, { color, labels });
  const rows = [];
  const map = [];
  let group = null;
  shown.forEach((pr, i) => {
    if (pr.state.heading !== group) {
      group = pr.state.heading;
      rows.push({ heading: group, color: pr.state.color });
      map.push(null);
    }
    rows.push(lines[i]);
    map.push(prs[i]);
  });
  return { rows, map };
}

// The before/after comparison of a rebased PR, per PR, reviewed commit and
// head, so the open watch app doesn't repeat its two calls on every refresh.
const CHANGES = new Map();

// One read of a repository's open PRs: the viewer, every open PR as GitHub
// returned it (`all`, which watch needs for drafts, bots and merges), and the
// picker's candidate list. Used by the picker and by watch. Read-only.

export async function scanRepo(repo, adapters, { now = Date.now(), seenAt = null, status = () => {} } = {}) {
  status('reading open PRs');
  const viewer = await adapters.viewer();
  const all = await adapters.listOpenPrs(repo);
  const list = await candidatePrs(all, viewer, {
    now,
    seenAt: Number.isFinite(seenAt) ? seenAt : null,
    commitOf: (number) => {
      status(`checking your review of #${number}`);
      return adapters.reviewCommit(repo, number, viewer);
    },
    commitsSince: (number, base, head) => {
      status(`counting new commits on #${number}`);
      return adapters.commitsSince?.(repo, base, head) ?? null;
    },
    compareChanges: async (number, base, covered, head) => {
      if (!adapters.prChanges || !base) return null;
      const key = `${repo}#${number}:${covered}:${head}`;
      if (CHANGES.has(key)) return CHANGES.get(key);
      status(`checking what changed on #${number}`);
      const [then, current] = await Promise.all([adapters.prChanges(repo, base, covered), adapters.prChanges(repo, base, head)]);
      const result = sameChanges(then, current);
      CHANGES.set(key, result);
      return result;
    },
  });
  return { viewer, all, list };
}

// The open PRs of several repositories, read at the same time, as one list:
// each PR carries `repo`, the list is sorted as one (most urgent first,
// whichever repository), and hidden counts are summed. `seenAt` is a time or
// { [repo]: time }. With `clone`, a repository without a local clone counts as
// unreadable, since its PRs couldn't be reviewed. A repository that can't be
// read is reported in `failed` and the others still list; when none can be
// read, the first error is thrown. Read-only.
export async function scanRepos(repos, adapters, { now = Date.now(), seenAt = null, status = () => {}, clone = false } = {}) {
  const labels = repoLabels(repos);
  const results = await Promise.all(repos.map(async (repo) => {
    const say = labels ? (text) => status(`${labels[repo]}: ${text}`) : status;
    try {
      if (clone) {
        say('checking local clone');
        const [owner, name] = repo.split('/');
        await adapters.findClone(owner, name);
      }
      const seen = seenAt && typeof seenAt === 'object' ? seenAt[repo] : seenAt;
      return { repo, scan: await scanRepo(repo, adapters, { now, seenAt: seen, status: say }) };
    } catch (error) { return { repo, error }; }
  }));
  const read = results.filter((result) => result.scan);
  const failed = results.filter((result) => result.error).map(({ repo, error }) => ({ repo, error }));
  if (!read.length) throw failed[0].error;
  const hidden = { reviewed: 0, draft: 0, bot: 0 };
  for (const { scan } of read) for (const key of Object.keys(hidden)) hidden[key] += scan.list.hidden[key] ?? 0;
  const prs = read.flatMap(({ repo, scan }) => scan.list.prs.map((pr) => ({ ...pr, repo }))).sort(byPriority);
  return {
    viewer: read[0].scan.viewer,
    byRepo: Object.fromEntries(read.map(({ repo, scan }) => [repo, scan])),
    list: { prs, hidden, open: read.reduce((sum, { scan }) => sum + scan.list.open, 0) },
    failed,
  };
}

// What choosePr returns when `c` was pressed: open Settings, then pick again.
export const OPEN_SETTINGS = Symbol('settings');

// Lists the PRs that need review across the configured repositories (one
// `repo` string or a list) and lets the person pick one. With several, the
// PRs are mixed in one list and each row names its repository; a repository
// that can't be read is named in the header and the others still list. The
// loading is a visible step ("Loading open PRs of owner/repo" with what it is
// doing right now), so the terminal never sits silent. `s` skips the
// highlighted PR until its head changes, `a` shows skipped PRs. Returns the PR
// URL, or null when nothing was picked. `f` picks the row for a full review
// instead of a follow-up: onPick({ full }) says which.
// With `watch` (the interactive watch app), the list stays open while empty,
// refreshes in place, marks new PRs with • until the cursor reaches them, and
// shows a status line: watch = { scanner(status, { now, seenAt }) returning a
// scanRepos result, subscribe(apply) returning an unsubscribe, refresh(),
// status(), marks: Set of "owner/repo#number" }.
// `settings` (a line such as "Provider: Copilot · Model: …") is shown above
// the keys, and `c` returns OPEN_SETTINGS.
export async function choosePr(repoOrRepos, adapters, { input, output = process.stderr, live = isLive(), reporter = plainReporter(), statePath = DEFAULT_STATE, now = Date.now(), watch = null, onPick, settings } = {}) {
  let full = false;
  const repos = [].concat(repoOrRepos);
  const labels = repoLabels(repos);
  const where = repos.length === 1 ? repos[0] : `${repos.length} repositories`;
  // Read the last looks before listing: New and Updated mean "since then".
  const state = loadState(statePath);
  const seenAt = Object.fromEntries(repos.map((repo) => [repo, Date.parse(state.lastLooked[repo] ?? '')]).filter(([, time]) => Number.isFinite(time)));
  const save = () => {
    try { saveState(statePath, state); } catch { /* the picker's memory is a convenience; never fail the pick */ }
  };
  let scan;
  await runSteps([{
    title: `Loading open PRs of ${where}`,
    run: async (ui) => {
      const status = (text) => ui.status(text);
      scan = await (watch ? watch.scanner(status, { now, seenAt }) : scanRepos(repos, adapters, { now, seenAt, status, clone: true }));
      return `${scan.list.prs.length} to review`;
    },
  }], { live, reporter });
  const skips = state.skipped;
  const read = repos.filter((repo) => !scan.failed?.some((failure) => failure.repo === repo));
  // Skips of PRs that are closed or have new commits have ended; drop them.
  for (const repo of read) {
    for (const key of Object.keys(skips)) {
      if (key.startsWith(`${repo}#`) && !scan.list.prs.some((pr) => skipKey(pr.repo, pr) === key && isSkipped(pr.repo, pr, skips))) delete skips[key];
    }
  }
  // This visit counts as looking, also when nothing is picked; a repository
  // that couldn't be read keeps its last look for next time.
  for (const repo of read) state.lastLooked[repo] = new Date(now).toISOString();
  save();
  if (!scan.list.prs.length && !watch) {
    output.write(`Nothing to review in ${repos.join(', ')} (${hiddenSummary(scan.list)}).${unreadable(scan, labels)}\n`);
    return null;
  }
  const key = (pr) => `${pr.repo}#${pr.number}`;
  const skipped = (pr) => isSkipped(pr.repo, pr, skips);
  const color = !process.env.NO_COLOR && output.isTTY !== false;
  const width = output.columns || 100;
  let showSkipped = scan.list.prs.every(skipped); // all skipped: show them rather than an empty list
  let view;
  const build = (focus) => {
    const { list } = scan;
    const visible = showSkipped ? list.prs : list.prs.filter((pr) => !skipped(pr));
    const count = list.prs.filter(skipped).length;
    view = pickerRows(visible, width, { color, skipped, labels, marked: (pr) => Boolean(watch?.marks.has(key(pr))) });
    const oldest = Math.min(...Object.values(seenAt));
    const looked = Number.isFinite(oldest) ? ` · last looked ${age(Math.max(0, now - oldest))} ago` : '';
    const yours = list.prs.filter((pr) => pr.state.key === 'mine' && !skipped(pr)).length;
    const title = `${where}: ${list.prs.length - count - yours} to review${yours ? `, ${yours} yours` : ''}${count ? `, ${count} skipped` : ''} (${hiddenSummary(list)})${looked}${unreadable(scan, labels)}`;
    const index = Math.max(0, view.map.findIndex((pr) => pr && focus && key(pr) === key(focus)));
    return { rows: view.rows, title, index };
  };
  const actions = {
    s: (index) => {
      const pr = view.map[index];
      if (!pr) return undefined;
      if (skipped(pr)) delete skips[skipKey(pr.repo, pr)];
      else skips[skipKey(pr.repo, pr)] = pr.headRefOid;
      save();
      if (!scan.list.prs.some((item) => !skipped(item))) showSkipped = true;
      const next = view.map.slice(index + 1).find(Boolean) ?? view.map.slice(0, index).reverse().find(Boolean);
      return build(showSkipped ? pr : next);
    },
    a: (index) => {
      showSkipped = !showSkipped;
      return build(view.map[index]);
    },
    // Enter decides follow-up or full review itself; f always runs a full one.
    f: (index) => (view.map[index] ? (full = true, { choose: true }) : undefined),
    ...(watch ? { r: () => { watch.refresh(); return undefined; } } : {}),
    ...(settings ? { c: () => ({ exit: OPEN_SETTINGS }) } : {}),
  };
  const status = settings ? () => [settings, watch?.status()].filter(Boolean).join(' · ') : watch?.status;
  const control = {};
  // A background refresh: keep the highlighted PR highlighted.
  const unsubscribe = watch?.subscribe((next) => {
    if (next) scan = next;
    control.update?.(build(view.map[control.index?.() ?? 0]));
  });
  const onMove = (index) => {
    const pr = view.map[index];
    return pr && watch?.marks.delete(key(pr)) ? build(pr) : undefined;
  };
  const first = build(null);
  const picked = await pickFromList(first.title, first.rows, {
    input, output, initial: first.index, actions, control, onMove: watch ? onMove : undefined, status,
    hint: `Enter review or summary · f full review · s skip until it changes · a show skipped${watch ? ' · r refresh' : ''}${settings ? ' · c settings' : ''} · q ${watch ? 'quit' : 'cancel'}`,
  }).finally(() => unsubscribe?.());
  if (picked === OPEN_SETTINGS) return OPEN_SETTINGS;
  if (picked === null || !view.map[picked]) {
    output.write(watch ? 'Watch stopped.\n' : 'Nothing selected.\n');
    return null;
  }
  onPick?.({ full });
  return `https://github.com/${view.map[picked].repo}/pull/${view.map[picked].number}`;
}

// " · ⚠ api: couldn't read (reason)" for each repository that failed, the
// reason cut short so the header stays one line.
function unreadable(scan, labels) {
  return (scan.failed ?? []).map(({ repo, error }) => ` · ⚠ ${labels?.[repo] ?? repo}: couldn't read (${short(error?.message ?? 'unknown error', 60)})`).join('');
}
