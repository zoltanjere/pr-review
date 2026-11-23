import { emitKeypressEvents } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { palette, plainReporter, short } from './ui.mjs';
import { isLive, runSteps } from './steps.mjs';
import { isSkipped, loadState, saveState, skipKey } from './picker-state.mjs';

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
  return /(?:Reviewed|pr-review) at `([0-9a-f]{7,40})`/.exec(review?.body ?? '')?.[1] ?? null;
}

const isBot = (author) => Boolean(author?.is_bot) || /\[bot\]$/.test(author?.login ?? '');
const isRequested = (pr, viewer) => (pr.reviewRequests ?? []).some((request) => request?.login === viewer);

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
  waiting: { rank: 4, icon: '·', heading: 'Waiting', color: null },
  stale: { rank: 5, icon: '◌', heading: 'Waiting', color: null },
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
export function prState(pr, viewer, { mine = null, covered = null, newer = null, now = Date.now(), seenAt = null } = {}) {
  const sinceLooked = Number.isFinite(seenAt);
  // Milliseconds since a timestamp, or null when it's missing: unknown is never "new".
  const since = (iso) => { const time = Date.parse(iso ?? ''); return Number.isNaN(time) ? null : now - time; };
  const ago = (iso) => (since(iso) === null ? '' : age(since(iso)));
  const within = (iso, ms) => since(iso) !== null && since(iso) < ms;
  // New or changed: after your last look, or in the last 24 hours on a first visit.
  const fresh = (iso) => (sinceLooked ? Date.parse(iso ?? '') > seenAt : within(iso, DAY));
  const at = (key, time) => ({
    key, ...STATES[key], ageMs: since(time),
    ...(sinceLooked && (key === 'new' || key === 'updated') ? { heading: `${STATES[key].heading} since you looked` } : {}),
  });
  const head = String(pr.headRefOid ?? '');
  if (mine && covered && !head.startsWith(covered)) {
    const count = newer?.count ?? 0;
    const what = count ? `${count} new commit${count === 1 ? '' : 's'}` : 'new commits';
    // You approved: lower priority than fixes pushed after your change request.
    if (mine.state === 'APPROVED') return { ...at('approved', newer?.last ?? pr.updatedAt), label: `approved · ${what}` };
    return { ...at('fixes', newer?.last ?? pr.updatedAt), label: [what, ago(newer?.last ?? pr.updatedAt)].filter(Boolean).join(' · ') };
  }
  if (isRequested(pr, viewer)) return { ...at('requested', pr.updatedAt), label: ['requested', ago(pr.updatedAt)].filter(Boolean).join(' · ') };
  if (fresh(pr.createdAt)) return { ...at('new', pr.createdAt), label: `opened ${ago(pr.createdAt)} ago` };
  if (fresh(pr.updatedAt)) return { ...at('updated', pr.updatedAt), label: `updated ${ago(pr.updatedAt)} ago` };
  if (since(pr.updatedAt) >= STALE_DAYS * DAY) return { ...at('stale', pr.updatedAt), label: `idle ${Math.floor(since(pr.updatedAt) / DAY)}d` };
  return { ...at('waiting', pr.updatedAt), label: ago(pr.updatedAt) };
}

// Keeps the PRs worth reviewing, each with its state: no review from you yet,
// or your latest review was dismissed, covers an older commit, or you were
// asked again. Drafts, your own PRs and bot PRs are hidden. When the reviewed
// commit can't be found, the PR is shown: listing too much is safer than
// hiding one. Sorted by state priority, then most recent activity.
// `commitsSince(number, covered, head)` counts the commits after your review;
// it is called only for PRs you reviewed that have changed since.
export async function candidatePrs(prs, viewer, { commitOf = async () => null, commitsSince = async () => null, now = Date.now(), seenAt = null } = {}) {
  const hidden = { reviewed: 0, draft: 0, yours: 0, bot: 0 };
  const kept = [];
  for (const pr of prs) {
    if (pr.isDraft) { hidden.draft++; continue; }
    if (pr.author?.login === viewer) { hidden.yours++; continue; }
    if (isBot(pr.author)) { hidden.bot++; continue; }
    const latest = (pr.latestReviews ?? []).filter((review) => review.author?.login === viewer).at(-1);
    const mine = latest && latest.state !== 'DISMISSED' ? latest : null;
    const covered = mine ? reviewedHead(mine) ?? (mine.commit?.oid || await commitOf(pr.number)) : null;
    if (covered && String(pr.headRefOid ?? '').startsWith(covered) && !isRequested(pr, viewer)) { hidden.reviewed++; continue; }
    const changed = mine && covered && !String(pr.headRefOid ?? '').startsWith(covered);
    // Whatever it returns or throws, a failed count never stops the listing.
    const newer = changed ? await Promise.resolve().then(() => commitsSince(pr.number, covered, pr.headRefOid)).catch(() => null) : null;
    kept.push({ ...pr, state: prState(pr, viewer, { mine, covered, newer, now, seenAt }) });
  }
  kept.sort((a, b) => a.state.rank - b.state.rank || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  return { prs: kept, hidden, open: prs.length };
}

export function hiddenSummary({ hidden, open }) {
  const parts = [
    [hidden.reviewed, 'reviewed'], [hidden.draft, hidden.draft === 1 ? 'draft' : 'drafts'],
    [hidden.yours, 'yours'], [hidden.bot, hidden.bot === 1 ? 'bot' : 'bots'],
  ].filter(([count]) => count).map(([count, name]) => `${count} ${name}`);
  return `${open} open${parts.length ? `; hidden: ${parts.join(', ')}` : ''}`;
}

// "#61  author  title", with numbers and authors aligned across the list. A PR
// with a state also gets its icon in front, in the state's colour, and its
// label right-aligned, coloured by age. Skipped rows are dimmed whole.
export function formatRows(prs, width = 100, { color = false } = {}) {
  const c = palette(color);
  const numberWidth = Math.max(0, ...prs.map((pr) => String(pr.number).length)) + 1;
  const authorWidth = Math.min(28, Math.max(0, ...prs.map((pr) => (pr.author?.login ?? '').length)));
  const labelWidth = Math.max(0, ...prs.map((pr) => (pr.state?.label ?? '').length));
  return prs.map((pr) => {
    const head = `${`#${pr.number}`.padEnd(numberWidth)}  ${short(pr.author?.login ?? '', authorWidth).padEnd(authorWidth)}  `;
    if (!pr.state) return head + short(pr.title ?? '', Math.max(10, width - head.length - 4));
    const titleWidth = Math.max(10, width - head.length - labelWidth - 8);
    const text = `${short(pr.title ?? '', titleWidth).padEnd(titleWidth)}  `;
    if (pr.state.dim) return c.dim(`${pr.state.icon} ${head}${text}${pr.state.label.padStart(labelWidth)}`);
    const paint = (name, part) => (name ? c[name](part) : part);
    const label = pr.state.label.padStart(labelWidth);
    return `${paint(pr.state.color, pr.state.icon)} ${head}${text}${paint(ageColor(pr.state.ageMs), label)}`;
  });
}

// Arrow-key picker. Returns the chosen row's index, or null when cancelled.
// ↑/↓ or k/j move, Enter picks, q, Esc or Ctrl-C cancels. A row given as
// { heading } is a group title the cursor skips. `actions` maps a key to a
// handler (index) => { rows, title, index } | undefined, to redraw the list.
export function pickFromList(title, rows, { input = process.stdin, output = process.stderr, initial = 0, hint = 'Enter review · q cancel', actions = {} } = {}) {
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
      lines.push(c.dim(`↑/↓ move · ${hint}${more}`));
      output.write(`${lines.join('\n')}\n`);
      drawn = lines.length;
    };
    const finish = (value) => {
      input.off('keypress', onKey);
      try { input.setRawMode?.(false); } catch { /* terminal already gone */ }
      input.pause?.();
      resolve(value);
    };
    const onKey = (text, key = {}) => {
      if (key.name === 'up' || text === 'k') index = nearest(index - 1, -1) ?? index;
      else if (key.name === 'down' || text === 'j') index = nearest(index + 1, 1) ?? index;
      else if (key.name === 'return' || key.name === 'enter') return selectable(index) ? finish(index) : undefined;
      else if (key.name === 'escape' || text === 'q' || (key.ctrl && key.name === 'c')) return finish(null);
      else if (text && actions[text]) {
        const update = actions[text](index);
        if (!update) return undefined;
        items = update.rows ?? items;
        heading = update.title ?? heading;
        index = settle(update.index ?? index);
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
export function pickerRows(prs, width, { color = false, skipped = () => false } = {}) {
  const shown = prs.map((pr) => (skipped(pr)
    ? { ...pr, state: { ...pr.state, label: `skipped · ${pr.state.label}`, dim: true } }
    : pr));
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

// Lists the default repository's PRs that need review and lets the person pick
// one. The loading is a visible step ("Loading open PRs of owner/repo" with
// what it is doing right now), so the terminal never sits silent. `s` skips
// the highlighted PR until its head changes, `a` shows skipped PRs. Returns
// the PR URL, or null when nothing was picked.
export async function choosePr(repo, adapters, { input, output = process.stderr, live = isLive(), reporter = plainReporter(), statePath = DEFAULT_STATE, now = Date.now() } = {}) {
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
      ui.status('reading open PRs');
      const viewer = await adapters.viewer();
      const prs = await adapters.listOpenPrs(repo);
      list = await candidatePrs(prs, viewer, {
        now,
        seenAt: Number.isFinite(seenAt) ? seenAt : null,
        commitOf: (number) => {
          ui.status(`checking your review of #${number}`);
          return adapters.reviewCommit(repo, number, viewer);
        },
        commitsSince: (number, base, head) => {
          ui.status(`counting new commits on #${number}`);
          return adapters.commitsSince?.(repo, base, head) ?? null;
        },
      });
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
  if (!list.prs.length) {
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
    view = pickerRows(visible, width, { color, skipped });
    const looked = Number.isFinite(seenAt) ? ` · last looked ${age(Math.max(0, now - seenAt))} ago` : '';
    const title = `${repo}: ${list.prs.length - count} to review${count ? `, ${count} skipped` : ''} (${hiddenSummary(list)})${looked}`;
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
  };
  const first = build(null);
  const picked = await pickFromList(first.title, first.rows, {
    input, output, initial: first.index, actions,
    hint: 'Enter review · s skip until it changes · a show skipped · q cancel',
  });
  if (picked === null) {
    output.write('Nothing selected.\n');
    return null;
  }
  return `https://github.com/${repo}/pull/${view.map[picked].number}`;
}
