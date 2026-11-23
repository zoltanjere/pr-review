import { emitKeypressEvents } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { palette, plainReporter, short } from './ui.mjs';
import { isLive, runSteps } from './steps.mjs';
import { isSkipped, loadState, saveState, skipKey } from './picker-state.mjs';
import { ancestry, followUpMode, sameChanges } from './follow-up.mjs';

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
// (null when none or dismissed); `covered` is the commit it covered; `newer`
// is { count, last } for the commits since then, when known. `seenAt` is when
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
    if (mine.state === 'APPROVED') return { ...at('approved', newer?.last ?? pr.updatedAt), ...pushed, label: `approved · ${what}` };
    // When Enter can't run a follow-up (history rewritten, a hand-written
    // review…), say so before it's pressed.
    const mode = followUpMode({ latest: { state: mine.state, body: mine.body, commit: covered }, history: ancestry(newer?.status) });
    const fallback = mode.mode === 'full' && mode.short ? ` · full review: ${mode.short}` : '';
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
// or your latest review was dismissed, covers an older commit, or you were
// asked again. Drafts, your own PRs and bot PRs are hidden. When the reviewed
// commit can't be found, the PR is shown: listing too much is safer than
// hiding one. Sorted by state priority, then by the age shown in the row.
// `commitsSince(number, covered, head)` counts the commits after your review;
// it is called only for PRs you reviewed that have changed since.
// `compareChanges(number, base, covered, head)` says whether the PR's own
// changes are the same as when you reviewed (true, false or null); it is
// called only after a rebase, or when every new commit is a merge.
export async function candidatePrs(prs, viewer, { commitOf = async () => null, commitsSince = async () => null, compareChanges = async () => null, now = Date.now(), seenAt = null } = {}) {
  const hidden = { reviewed: 0, draft: 0, bot: 0 };
  const kept = [];
  for (const pr of prs) {
    // Your own PRs are listed (drafts too) for a self-review; your comments on them don't count as a review.
    if (pr.author?.login === viewer) { kept.push({ ...pr, state: prState(pr, viewer, { now, seenAt }) }); continue; }
    if (pr.isDraft) { hidden.draft++; continue; }
    if (isBot(pr.author)) { hidden.bot++; continue; }
    const latest = (pr.latestReviews ?? []).filter((review) => review.author?.login === viewer).at(-1);
    const mine = latest && latest.state !== 'DISMISSED' ? latest : null;
    const covered = mine ? reviewedHead(mine) ?? (mine.commit?.oid || await commitOf(pr.number)) : null;
    if (covered && String(pr.headRefOid ?? '').startsWith(covered) && !isRequested(pr, viewer)) { hidden.reviewed++; continue; }
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
  // Within a group, by the age shown in the row (youngest first: 1h, 3h, 5h); unknown ages last.
  const shownAge = (pr) => (Number.isFinite(pr.state.ageMs) ? pr.state.ageMs : Infinity);
  kept.sort((a, b) => a.state.rank - b.state.rank || shownAge(a) - shownAge(b));
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
export function formatRows(prs, width = 100, { color = false } = {}) {
  const c = palette(color);
  const numberWidth = Math.max(0, ...prs.map((pr) => String(pr.number).length)) + 1;
  const authorWidth = Math.min(28, Math.max(0, ...prs.map((pr) => (pr.author?.login ?? '').length)));
  const author = (pr) => short(pr.author?.login ?? '', authorWidth).padEnd(authorWidth);
  const number = (pr) => `#${pr.number}`.padEnd(numberWidth);
  if (!prs.some((pr) => pr.state)) {
    return prs.map((pr) => {
      const head = `${number(pr)}  ${author(pr)}  `;
      return head + short(pr.title ?? '', Math.max(10, width - head.length - 4));
    });
  }
  const ageOf = (pr) => (Number.isFinite(pr.state?.ageMs) ? age(pr.state.ageMs) : '');
  const ageWidth = Math.max(0, ...prs.map((pr) => ageOf(pr).length));
  const labelWidth = Math.max(0, ...prs.map((pr) => (pr.state?.label ?? '').length));
  const headWidth = 2 + numberWidth + 2 + (ageWidth ? ageWidth + 2 : 0) + authorWidth + 2;
  const room = Math.min(width, MAX_WIDTH) - headWidth - (labelWidth ? labelWidth + 2 : 0);
  const titleWidth = Math.max(10, Math.min(room, Math.max(0, ...prs.map((pr) => (pr.title ?? '').length))));
  return prs.map((pr) => {
    const state = pr.state ?? { icon: ' ', label: '' };
    const when = ageWidth ? `${ageOf(pr).padEnd(ageWidth)}  ` : '';
    const title = short(pr.title ?? '', titleWidth);
    const tail = state.label ? `${title.padEnd(titleWidth)}  ${state.label}` : title;
    if (state.dim) return c.dim(`${state.icon} ${number(pr)}  ${when}${author(pr)}  ${tail}`);
    const paint = (name, part) => (name ? c[name](part) : part);
    return `${paint(state.color, state.icon)} ${number(pr)}  ${paint(ageColor(state.ageMs), when)}${author(pr)}  ${tail}`;
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
        // An action may pick the row, like Enter (f: full review).
        if (update.choose) return selectable(index) ? finish(index) : undefined;
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
export function pickerRows(prs, width, { color = false, skipped = () => false, marked = () => false } = {}) {
  const shown = prs.map((pr) => (skipped(pr)
    ? { ...pr, state: { ...pr.state, label: ['skipped', pr.state.label].filter(Boolean).join(' · '), dim: true } }
    : marked(pr) ? { ...pr, state: { ...pr.state, label: ['•', pr.state.label].filter(Boolean).join(' ') } } : pr));
  const lines = formatRows(shown, width, { color });
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

// Lists the default repository's PRs that need review and lets the person pick
// one. The loading is a visible step ("Loading open PRs of owner/repo" with
// what it is doing right now), so the terminal never sits silent. `s` skips
// the highlighted PR until its head changes, `a` shows skipped PRs. Returns
// the PR URL, or null when nothing was picked. `f` picks the row for a full
// review instead of a follow-up: onPick({ full }) says which.
// With `watch` (the interactive watch app), the list stays open while empty,
// refreshes in place, marks new PRs with • until the cursor reaches them, and
// shows a status line: watch = { scanner(status, { now, seenAt }), subscribe(apply)
// returning an unsubscribe, refresh(), status(), marks: Set of PR numbers }.
export async function choosePr(repo, adapters, { input, output = process.stderr, live = isLive(), reporter = plainReporter(), statePath = DEFAULT_STATE, now = Date.now(), watch = null, onPick } = {}) {
  let full = false;
  const [owner, name] = repo.split('/');
  // Read the last look before listing: New and Updated mean "since then".
  const state = loadState(statePath);
  const seenAt = Date.parse(state.lastLooked[repo] ?? '');
  const save = () => {
    try { saveState(statePath, state); } catch { /* the picker's memory is a convenience; never fail the pick */ }
  };
  let list;
  await runSteps([{
    title: `Loading open PRs of ${repo}`,
    run: async (ui) => {
      ui.status('checking local clone');
      await adapters.findClone(owner, name);
      const status = (text) => ui.status(text);
      const looked = Number.isFinite(seenAt) ? seenAt : null;
      ({ list } = await (watch ? watch.scanner(status, { now, seenAt: looked }) : scanRepo(repo, adapters, { now, seenAt: looked, status })));
      return `${list.prs.length} to review`;
    },
  }], { live, reporter });
  const skips = state.skipped;
  // Skips of PRs that are closed or have new commits have ended; drop them.
  for (const key of Object.keys(skips)) {
    if (key.startsWith(`${repo}#`) && !list.prs.some((pr) => skipKey(repo, pr) === key && isSkipped(repo, pr, skips))) delete skips[key];
  }
  // This visit counts as looking, also when nothing is picked.
  state.lastLooked[repo] = new Date(now).toISOString();
  save();
  if (!list.prs.length && !watch) {
    output.write(`Nothing to review in ${repo} (${hiddenSummary(list)}).\n`);
    return null;
  }
  const skipped = (pr) => isSkipped(repo, pr, skips);
  const color = !process.env.NO_COLOR && output.isTTY !== false;
  const width = output.columns || 100;
  let showSkipped = list.prs.every(skipped); // all skipped: show them rather than an empty list
  let view;
  const build = (focus) => {
    const visible = showSkipped ? list.prs : list.prs.filter((pr) => !skipped(pr));
    const count = list.prs.filter(skipped).length;
    view = pickerRows(visible, width, { color, skipped, marked: (pr) => Boolean(watch?.marks.has(pr.number)) });
    const looked = Number.isFinite(seenAt) ? ` · last looked ${age(Math.max(0, now - seenAt))} ago` : '';
    const yours = list.prs.filter((pr) => pr.state.key === 'mine' && !skipped(pr)).length;
    const title = `${repo}: ${list.prs.length - count - yours} to review${yours ? `, ${yours} yours` : ''}${count ? `, ${count} skipped` : ''} (${hiddenSummary(list)})${looked}`;
    const index = Math.max(0, view.map.findIndex((pr) => pr && pr.number === focus?.number));
    return { rows: view.rows, title, index };
  };
  const actions = {
    s: (index) => {
      const pr = view.map[index];
      if (!pr) return undefined;
      if (skipped(pr)) delete skips[skipKey(repo, pr)];
      else skips[skipKey(repo, pr)] = pr.headRefOid;
      save();
      if (!list.prs.some((item) => !skipped(item))) showSkipped = true;
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
  };
  const control = {};
  // A background refresh: keep the highlighted PR highlighted.
  const unsubscribe = watch?.subscribe((next) => {
    if (next) list = next;
    control.update?.(build(view.map[control.index?.() ?? 0]));
  });
  const onMove = (index) => {
    const pr = view.map[index];
    return pr && watch?.marks.delete(pr.number) ? build(pr) : undefined;
  };
  const first = build(null);
  const picked = await pickFromList(first.title, first.rows, {
    input, output, initial: first.index, actions, control, onMove: watch ? onMove : undefined, status: watch?.status,
    hint: `Enter review · f full review · s skip until it changes · a show skipped${watch ? ' · r refresh' : ''} · q ${watch ? 'quit' : 'cancel'}`,
  }).finally(() => unsubscribe?.());
  if (picked === null || !view.map[picked]) {
    output.write(watch ? 'Watch stopped.\n' : 'Nothing selected.\n');
    return null;
  }
  onPick?.({ full });
  return `https://github.com/${repo}/pull/${view.map[picked].number}`;
}
