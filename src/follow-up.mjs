// Follow-up review: after your Request changes or Comment, check whether each
// earlier finding was fixed or answered, instead of reviewing the whole PR
// again. This module is pure: it reads a posted review, decides follow-up or
// full review (and why), and writes the follow-up digest. src/adapters.mjs
// reads GitHub and runs the models; src/review.mjs runs the steps.

import { verdictFor, verdictFromText, verdictLine } from './verdict.mjs';

const SEVERITY = { '🔴': 'Must fix', '🟡': 'Should fix', '❓': 'Question' };

// The commit a posted review covered and, for a follow-up, the one before:
// "Reviewed at `a7e50c8`…" or "Follow-up at `def5678` of the review at `abc1234`…".
const FOOTER = /<sub>(?:Reviewed|Follow-up) at `([0-9a-f]{7,40})`/;
const OLD_FOOTER = /pr-review at `([0-9a-f]{7,40})`/;

// The numbered findings of a digest as posted: the part before <details> and
// the footer. Each is { n, severity, title, location, text }. Questions have
// no bold title; their first line is the title. Minor items inside <details>
// aren't read: they were optional for the author.
export function postedFindings(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  const fromReviewpr = FOOTER.test(text) || OLD_FOOTER.test(text);
  const visible = text.split(/<details\b/i)[0].split(/\n---\n/)[0];
  const findings = [];
  let current = null;
  for (const line of visible.split('\n')) {
    const item = /^\s{0,3}(\d+)[.)]\s+(🔴|🟡|❓)\s*(.*)$/u.exec(line);
    if (item) {
      const [, n, icon, rest] = item;
      const bold = /^\*\*(.+?)\*\*\s*(.*)$/.exec(rest);
      current = { n: Number(n), severity: SEVERITY[icon], title: (bold ? bold[1] : rest).trim(), lines: bold && bold[2] ? [bold[2]] : [] };
      findings.push(current);
      continue;
    }
    if (/^#{2,4}\s|^>/.test(line) || /^\*\*Verdict:\*\*/.test(line)) { current = null; continue; }
    if (current && line.trim()) current.lines.push(line.trim());
  }
  return {
    fromReviewpr,
    findings: findings.map(({ lines, ...finding }) => {
      // The location line is the first body line when it starts with a `code` span (or a link around one).
      const first = lines[0] ?? '';
      const located = /^\[?`/.test(first);
      const strip = (value) => value.replace(/\[(`[^`]+`)\]\([^)]*\)/g, '$1');
      return {
        ...finding,
        location: located ? strip(first) : '',
        text: strip(lines.slice(located ? 1 : 0).join(' ')).trim(),
      };
    }),
  };
}

// The commit a posted review says it covered (7 to 40 characters), or null.
export function postedHead(body) {
  const text = String(body ?? '');
  return (FOOTER.exec(text) ?? OLD_FOOTER.exec(text))?.[1] ?? null;
}

// How the reviewed commit relates to the PR head now, from GitHub's compare
// status (old...new): "ahead" or "identical" keep the history; "diverged" or
// "behind" mean it was rewritten; a missing commit means it's gone.
export function ancestry(status) {
  if (status === 'ahead' || status === 'identical') return 'kept';
  if (status === 'diverged' || status === 'behind') return 'rewritten';
  if (status === 'missing') return 'missing';
  return 'unknown';
}

const at = (sha) => `\`${String(sha ?? '').slice(0, 7)}\``;

// What a review was posted as. GitHub reports a dismissed review only as
// DISMISSED (a push dismisses an approval when the repository asks for it),
// but it's still your review, and its body is unchanged. The verdict line
// reviewpr posted says which it was: ✅ was an approval, 🔴 and ⚠️ a Request
// changes. A dismissed review without one stays DISMISSED: still yours, read
// like any review that isn't an approval.
const POSTED_AS = { ship: 'APPROVED', block: 'CHANGES_REQUESTED', changes: 'CHANGES_REQUESTED', comment: 'COMMENTED' };
export function reviewState(review) {
  if (review?.state !== 'DISMISSED') return review?.state ?? null;
  return POSTED_AS[verdictFromText(review.body)?.level] ?? 'DISMISSED';
}

// The decision, in code, before any model runs. The first row that applies
// wins. Each fallback has one reason, said the same way everywhere:
// `line` in the terminal, `short` on the picker row, `notice` to the author
// in the digest. A first review (no earlier review of yours) has no reason.
// - full: --full or `f` in the picker
// - own: your own PR
// - latest: your latest review on the PR ({ state, body, commit }), or null;
//   a dismissed one counts, as what it was posted as (reviewState)
// - history: ancestry() of the reviewed commit against the PR head
export function followUpMode({ full = false, own = false, latest = null, history = 'unknown' }) {
  const fallback = (key, line, short, notice) => ({ mode: 'full', key, line: `Full review: ${line}`, short, notice });
  if (full) return fallback('asked', 'you asked for one.', 'full review', null);
  if (own || !latest) return { mode: 'full', key: own ? 'own' : 'first', line: null, short: null, notice: null };
  if (reviewState(latest) === 'APPROVED') return { mode: 'full', key: 'approved', line: 'Full review: your last review was an approval.', short: null, notice: null };
  const parsed = postedFindings(latest.body);
  const head = latest.commit ?? postedHead(latest.body);
  if (!parsed.fromReviewpr) {
    return fallback('hand-written', 'your last review wasn\'t made by reviewpr, so its findings can\'t be read.', 'hand-written review', null);
  }
  if (!parsed.findings.length) {
    return fallback('no-findings', 'your last review had no findings to follow up.', 'no findings', null);
  }
  if (history === 'rewritten') {
    return fallback('rewritten', `the commit you reviewed (${at(head)}) is no longer in the PR's history (rebase or force-push), so the earlier findings can't be checked line by line.`, 'history rewritten',
      `🔁 **Full re-review:** the commit reviewed last time (${at(head)}) is no longer in the PR's history after a rebase or force-push, so the whole PR was reviewed again. Earlier points may come back in different words.`);
  }
  if (history === 'missing') {
    return fallback('missing', `the commit you reviewed (${at(head)}) is no longer available on GitHub.`, 'commit gone',
      `🔁 **Full re-review:** the commit reviewed last time (${at(head)}) is no longer available, so the whole PR was reviewed again. Earlier points may come back in different words.`);
  }
  return { mode: 'follow-up', key: 'follow-up', head, findings: parsed.findings, line: null, short: null, notice: null };
}

// The terminal line for a follow-up, before the first model step.
export function followUpLine({ head, commits, findings, rebased = false }) {
  const count = rebased ? 'rebased, no changes to the PR\'s code' : commits ? `${commits} new commit${commits === 1 ? '' : 's'}` : 'no new commits';
  return `Follow-up of your review at ${at(head)}: ${count}, ${findings} finding${findings === 1 ? '' : 's'} to check.`;
}

// --- The follow-up check's answer -------------------------------------------

export const FOLLOW_UP_STATUSES = ['Fixed', 'Partly fixed', 'Answered', 'Still open'];

// One status per earlier finding, in order. Returns an error message, or null.
export function checkStatuses(results, count) {
  if (!Array.isArray(results) || results.length !== count) return `returned ${Array.isArray(results) ? results.length : 'no'} statuses for ${count} findings`;
  for (const result of results) {
    if (!FOLLOW_UP_STATUSES.includes(result?.status)) return 'returned an unknown status';
    if (result.status === 'Answered' && !['accepted', 'disputed'].includes(result.answer)) return 'returned an Answered status without "accepted" or "disputed"';
    if (typeof result.evidence !== 'string' || !result.evidence.trim()) return 'returned a status without evidence';
  }
  return null;
}

// Fixed, or answered convincingly: resolved. Everything else stays open,
// a disputed answer and a partial fix included.
export const resolved = (status) => status.status === 'Fixed' || (status.status === 'Answered' && status.answer === 'accepted');

// --- The follow-up digest ----------------------------------------------------

const ICON = { 'Must fix': '🔴', 'Should fix': '🟡', Question: '❓' };
const ORDER = ['Must fix', 'Should fix', 'Question'];
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const quote = (text) => `"${String(text ?? '').replace(/\s+/g, ' ').trim()}"`;

// The new findings' numbered items (from the review-digest skill) under one
// heading, numbered after the still-open ones; their minors in a separate
// <details>. Returns { visible, details }.
function newSection(body, start) {
  const text = String(body ?? '').trim();
  if (!text || /^`?Nothing to raise\.?`?$/i.test(text)) return { visible: '', details: '' };
  const cut = text.search(/<details\b/i);
  const visible = (cut < 0 ? text : text.slice(0, cut)).split('\n').filter((line) => !/^#{2,4}\s/.test(line));
  let n = start;
  const numbered = visible.map((line) => line.replace(/^(\s{0,3})\d+([.)]\s+(?:🔴|🟡|❓))/u, (match, indent, rest) => `${indent}${n++}${rest}`))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const details = cut < 0 ? '' : text.slice(cut).replace(/<summary>([^<]*)<\/summary>/i, '<summary>In the new commits: $1</summary>').trim();
  return { visible: numbered, details };
}

// The notice to the PR author, under the verdict: two short lines saying it's
// a re-review, its scope, and the counts. Written from templates so it always
// matches what ran.
export function reReviewNotice({ old, commits, total, chained = false, merged = null, rebased = false, counts }) {
  const since = `${chained ? 'the follow-up at ' : ''}${at(old)}`;
  const points = `${total} earlier point${total === 1 ? '' : 's'}${chained ? ' still open' : ''}`;
  const scope = rebased ? `(rebased, no changes to the PR's code): only the replies to the ${points} were checked.`
    : commits ? `(${plural(commits, 'new commit')}): only the ${points} and what the new ${commits === 1 ? 'commit' : 'commits'} changed were checked.`
      : `(no new commits): only the replies to the ${points} were checked.`;
  const parts = [
    counts.fixed && `${counts.fixed} fixed`,
    counts.answered && `${counts.answered} answered`,
    counts.open && `${counts.open} still open`,
    counts.added && `${counts.added} new`,
    commits && !counts.added ? 'nothing new' : null,
  ].filter(Boolean);
  return [
    `🔁 **Re-review since ${since}** ${scope}${merged ? ` Changes merged in from \`${merged}\` weren't reviewed.` : ''}`,
    `${parts.join(', ') || 'Nothing to report'}.`,
  ].map((line) => `> ${line}`).join('\n');
}

// A resolved point needs no explanation: its title, cut at a word, with a
// code span never left open. The evidence stays in the saved follow-up stage.
export function shortTitle(title, max = 80) {
  const flat = String(title ?? '').replace(/\s+/g, ' ').trim().replace(/[.:?]$/, '');
  if (flat.length <= max) return flat;
  let cut = flat.slice(0, max).replace(/\s+\S*$/, '');
  if ((cut.match(/`/g) ?? []).length % 2) cut = cut.replace(/\s*`[^`]*$/, '');
  return `${cut} …`;
}

// The whole follow-up digest: verdict, notice, still open, new, resolved.
// - previous: the earlier findings (postedFindings), in the order checked
// - statuses: the follow-up check's answer, one per earlier finding
// - newBody: the review-digest skill's body for the new findings ('' if none)
// - newFindings: verify's findings for the new commits
// - facts: { old, head, commits, chained, merged, rebased }
export function followUpDigest({ previous, statuses, newBody = '', newFindings = [], facts }) {
  const items = previous.map((finding, i) => ({ finding, status: statuses[i] }));
  const open = items.filter(({ status }) => !resolved(status))
    .sort((a, b) => ORDER.indexOf(a.finding.severity) - ORDER.indexOf(b.finding.severity));
  const done = items.filter(({ status }) => resolved(status));
  const added = newFindings.filter((f) => f.status === 'Question' || (f.status === 'Confirmed' && f.priority !== 'Minor'));
  const counts = {
    fixed: done.filter(({ status }) => status.status === 'Fixed').length,
    answered: done.filter(({ status }) => status.status === 'Answered').length,
    open: open.length,
    added: added.length,
  };

  // The verdict, from code: open earlier findings keep their severity.
  const all = [
    ...open.map(({ finding }) => (finding.severity === 'Question' ? { status: 'Question', priority: '-' } : { status: 'Confirmed', priority: finding.severity })),
    ...newFindings,
  ];
  const level = verdictFor(all).level;
  const rest = !open.length && !added.length
    ? `${previous.length === 1 ? 'The earlier point is' : `All ${previous.length} earlier points`} resolved${facts.commits ? ', nothing new' : ''}.`
    : `${[open.length && `${open.length} still open`, added.length && `${added.length} new`].filter(Boolean).join(', ')}.`;

  const sections = [verdictLine(level, rest), reReviewNotice({ ...facts, total: previous.length, counts })];
  if (open.length) {
    sections.push(['### Still open from the last review', ...open.map(({ finding, status }, i) => {
      const why = status.status === 'Answered'
        ? `Reply: ${quote(status.reply)} This doesn't settle it: ${status.evidence}`
        : status.status === 'Partly fixed' ? `Partly fixed: ${status.remaining || status.evidence}` : (status.remaining || finding.text);
      const head = finding.severity === 'Question' ? `${i + 1}. ❓ ${finding.title}` : `${i + 1}. ${ICON[finding.severity]} **${finding.title}**`;
      return [head, finding.location && `   ${finding.location}`, `   ${why}`].filter(Boolean).join('\n');
    })].join('\n'));
  }
  const fresh = newSection(newBody, open.length + 1);
  if (fresh.visible) sections.push(`### New in the fixes\n${fresh.visible}`);
  if (done.length) {
    const summary = [counts.fixed && `${counts.fixed} fixed`, counts.answered && `${counts.answered} answered`].filter(Boolean).join(', ');
    sections.push([`<details><summary>Resolved since the last review: ${summary}</summary>`, '',
      ...done.map(({ finding, status }) => `- ${status.status === 'Fixed' ? '✅' : '💬'} ${shortTitle(finding.title)}`),
      '</details>'].join('\n'));
  }
  if (fresh.details) sections.push(fresh.details);
  return sections.join('\n\n');
}

// A full review that replaced a follow-up: the reason, to the author, right
// under the verdict line.
export function withNotice(digest, notice) {
  if (!notice) return digest;
  const text = String(digest ?? '');
  const match = /^\s*\*\*Verdict:\*\*[^\n]*(?:\n|$)/.exec(text);
  const quoted = notice.split('\n').map((line) => `> ${line}`).join('\n');
  if (!match) return `${quoted}\n\n${text}`;
  return `${match[0].trimEnd()}\n\n${quoted}\n\n${text.slice(match[0].length).trim()}`.trim();
}

// "2 fixed, 1 answered, 1 still open", for the step's finish line.
export function statusSummary(statuses) {
  const count = (test) => statuses.filter(test).length;
  return [
    [count((s) => s.status === 'Fixed'), 'fixed'],
    [count((s) => s.status === 'Answered' && s.answer === 'accepted'), 'answered'],
    [count((s) => !resolved(s)), 'still open'],
  ].filter(([n]) => n).map(([n, word]) => `${n} ${word}`).join(', ') || 'nothing to check';
}

// The saved follow-up stage: each earlier finding with its status and evidence.
export function formatFollowUp(findings, statuses) {
  return ['# Follow-up check', ...findings.map((finding, i) => {
    const status = statuses[i];
    return [
      `### ${i + 1}. ${finding.title} (${status.status}${status.status === 'Answered' ? `, ${status.answer}` : ''})`,
      `- Severity: ${finding.severity}`,
      `- Location: ${finding.location || '-'}`,
      status.reply ? `- Reply: ${quote(status.reply)}` : null,
      `- Evidence: ${status.evidence}`,
      status.remaining ? `- Remaining: ${status.remaining}` : null,
    ].filter(Boolean).join('\n');
  })].join('\n\n');
}

// --- Rebased or merged without changes ---------------------------------------

// GitHub's compare returns at most 300 files; with that many, it can't tell.
const COMPARE_FILE_LIMIT = 300;

// Whether the PR's own changes are the same then and now: the same files, and
// per file the same added and removed lines. Hunk positions and context are
// ignored, since a rebase shifts them; a file without a patch (binary, too
// large) is compared by its blob. Takes two { files, total } from
// compare/<base>...<commit>; returns true, false, or null when it can't tell.
export function sameChanges(then, now) {
  if (!Array.isArray(then?.files) || !Array.isArray(now?.files)) return null;
  if ([then, now].some((side) => (side.total ?? side.files.length) >= COMPARE_FILE_LIMIT)) return null;
  const key = (file) => {
    if (typeof file.patch === 'string') {
      return `${file.status}\n${file.patch.split('\n').filter((line) => /^[+-]/.test(line)).join('\n')}`;
    }
    return file.sha ? `${file.status}\nsha:${file.sha}` : null;
  };
  const map = (files) => new Map(files.map((file) => [file.previous_filename ? `${file.previous_filename}→${file.filename}` : file.filename, key(file)]));
  const a = map(then.files);
  const b = map(now.files);
  if ([...a.values(), ...b.values()].some((value) => value === null)) return null;
  if (a.size !== b.size) return false;
  for (const [name, value] of a) if (b.get(name) !== value) return false;
  return true;
}
