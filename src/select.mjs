import { emitKeypressEvents } from 'node:readline';
import { palette, plainReporter, short } from './ui.mjs';
import { isLive, runSteps } from './steps.mjs';

// Which open PRs still need your review, and an arrow-key picker for them.
// Listing uses read-only gh calls only; no model is involved.

// The commit a posted review covered, read from our footer: "Reviewed at
// `a7e50c8`…", or "…by pr-review at `c0ffee1`…" in older posts.
export function reviewedHead(review) {
  return /(?:Reviewed|pr-review) at `([0-9a-f]{7,40})`/.exec(review?.body ?? '')?.[1] ?? null;
}

const isBot = (author) => Boolean(author?.is_bot) || /\[bot\]$/.test(author?.login ?? '');

// Keeps the PRs worth reviewing: no review from you yet, or your latest
// review was dismissed or covers an older commit. Drafts, your own PRs and
// bot PRs are hidden. When the reviewed commit can't be found, the PR is
// shown: listing too much is safer than hiding one.
export async function candidatePrs(prs, viewer, { commitOf = async () => null } = {}) {
  const hidden = { reviewed: 0, draft: 0, yours: 0, bot: 0 };
  const kept = [];
  for (const pr of prs) {
    if (pr.isDraft) { hidden.draft++; continue; }
    if (pr.author?.login === viewer) { hidden.yours++; continue; }
    if (isBot(pr.author)) { hidden.bot++; continue; }
    const mine = (pr.latestReviews ?? []).filter((review) => review.author?.login === viewer).at(-1);
    if (!mine || mine.state === 'DISMISSED') { kept.push(pr); continue; }
    const covered = reviewedHead(mine) ?? (mine.commit?.oid || await commitOf(pr.number));
    if (covered && String(pr.headRefOid ?? '').startsWith(covered)) { hidden.reviewed++; continue; }
    kept.push(pr);
  }
  kept.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  return { prs: kept, hidden, open: prs.length };
}

export function hiddenSummary({ hidden, open }) {
  const parts = [
    [hidden.reviewed, 'reviewed'], [hidden.draft, hidden.draft === 1 ? 'draft' : 'drafts'],
    [hidden.yours, 'yours'], [hidden.bot, hidden.bot === 1 ? 'bot' : 'bots'],
  ].filter(([count]) => count).map(([count, name]) => `${count} ${name}`);
  return `${open} open${parts.length ? `; hidden: ${parts.join(', ')}` : ''}`;
}

// "#61  author  title", with numbers and authors aligned across the list.
export function formatRows(prs, width = 100) {
  const numberWidth = Math.max(0, ...prs.map((pr) => String(pr.number).length)) + 1;
  const authorWidth = Math.min(28, Math.max(0, ...prs.map((pr) => (pr.author?.login ?? '').length)));
  return prs.map((pr) => {
    const head = `${`#${pr.number}`.padEnd(numberWidth)}  ${short(pr.author?.login ?? '', authorWidth).padEnd(authorWidth)}  `;
    return head + short(pr.title ?? '', Math.max(10, width - head.length - 4));
  });
}

// Arrow-key picker. Returns the chosen index, or null when cancelled.
// ↑/↓ or k/j move, Enter picks, q, Esc or Ctrl-C cancels.
export function pickFromList(title, rows, { input = process.stdin, output = process.stderr, initial = 0, hint = 'Enter review · q cancel' } = {}) {
  const c = palette(!process.env.NO_COLOR && output.isTTY !== false);
  return new Promise((resolve) => {
    let index = Math.min(Math.max(0, initial), rows.length - 1);
    let top = 0;
    let drawn = 0;
    const height = () => Math.max(3, Math.min(rows.length, (output.rows || 24) - 4));
    const draw = () => {
      if (drawn) output.write(`\x1b[${drawn}A\x1b[0J`);
      const size = height();
      if (index < top) top = index;
      if (index >= top + size) top = index - size + 1;
      const lines = [c.bold(title)];
      for (let i = top; i < Math.min(rows.length, top + size); i++) {
        lines.push(i === index ? `${c.cyan('❯')} ${c.bold(rows[i])}` : `  ${rows[i]}`);
      }
      const more = rows.length > size ? ` · ${index + 1}/${rows.length}` : '';
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
      if (key.name === 'up' || text === 'k') index = Math.max(0, index - 1);
      else if (key.name === 'down' || text === 'j') index = Math.min(rows.length - 1, index + 1);
      else if (key.name === 'return' || key.name === 'enter') return finish(index);
      else if (key.name === 'escape' || text === 'q' || (key.ctrl && key.name === 'c')) return finish(null);
      else return;
      draw();
    };
    emitKeypressEvents(input);
    try { input.setRawMode?.(true); } catch { /* not a terminal */ }
    input.resume?.();
    input.on('keypress', onKey);
    draw();
  });
}

// Lists the default repository's PRs that need review and lets the person pick
// one. The loading is a visible step ("Loading open PRs of owner/repo" with
// what it is doing right now), so the terminal never sits silent. Returns the
// PR URL, or null when nothing was picked.
export async function choosePr(repo, adapters, { input, output = process.stderr, live = isLive(), reporter = plainReporter() } = {}) {
  const [owner, name] = repo.split('/');
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
        commitOf: (number) => {
          ui.status(`checking your review of #${number}`);
          return adapters.reviewCommit(repo, number, viewer);
        },
      });
      return `${list.prs.length} to review`;
    },
  }], { live, reporter });
  if (!list.prs.length) {
    output.write(`Nothing to review in ${repo} (${hiddenSummary(list)}).\n`);
    return null;
  }
  const title = `${repo}: ${list.prs.length} to review (${hiddenSummary(list)})`;
  const picked = await pickFromList(title, formatRows(list.prs, output.columns || 100), { input, output });
  if (picked === null) {
    output.write('Nothing selected.\n');
    return null;
  }
  return `https://github.com/${repo}/pull/${list.prs[picked].number}`;
}
