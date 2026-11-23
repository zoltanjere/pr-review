// The verdict line and the recommended review type are decided here, in code,
// from verify's findings. The digest skill never writes a verdict.

const LEVELS = {
  block: { icon: '🔴', label: 'Fix before merge', event: 'request-changes' },
  // Should fix doesn't block, so it recommends a comment: a priority one level
  // too high then costs a non-blocking comment, not a blocked PR.
  changes: { icon: '⚠️', label: 'Changes recommended', event: 'comment' },
  ship: { icon: '✅', label: 'Ship', event: 'approve' },
  comment: { icon: '💬', label: 'Not approved yet', event: 'comment' },
};

const VERDICT_LINE = /^\s*\*\*Verdict:\*\*[^\n]*(?:\n|$)/;

function counts(findings) {
  const confirmed = (priority) => findings.filter((item) => item.status === 'Confirmed' && item.priority === priority).length;
  const questions = findings.filter((item) => item.status === 'Question').length;
  const parts = [
    [confirmed('Must fix'), 'must-fix'],
    [confirmed('Should fix'), 'should-fix'],
    [questions, questions === 1 ? 'question' : 'questions'],
  ].filter(([count]) => count).map(([count, name]) => `${count} ${name}`);
  // Minor items are counted once, in the <details> summary the digest writes,
  // so the two numbers can't disagree when the digest merges related lines.
  if (parts.length) return `${parts.join(', ')}.`;
  return confirmed('Minor') ? 'Only minor items.' : 'No issues found.';
}

const lineFor = (level, rest) => `**Verdict:** ${LEVELS[level].icon} ${LEVELS[level].label}. ${rest}`;
export const verdictLine = lineFor;

export function verdictFor(findings = []) {
  const has = (priority) => findings.some((item) => item.status === 'Confirmed' && item.priority === priority);
  const level = has('Must fix') ? 'block' : has('Should fix') ? 'changes' : 'ship';
  return { level, ...LEVELS[level], line: lineFor(level, counts(findings)) };
}

// Reads the level back from a digest's verdict line, which a person may have edited.
export function verdictFromText(text) {
  const line = VERDICT_LINE.exec(String(text ?? ''))?.[0] ?? '';
  const level = Object.keys(LEVELS).find((key) => line.includes(LEVELS[key].label));
  return level ? { level, ...LEVELS[level] } : null;
}

// The digest as posted: the code-owned verdict line, then the skill's body.
// Any verdict line the model wrote anyway is dropped.
export function withVerdict(body, findings) {
  const rest = detailsSummary(String(body ?? '').replace(VERDICT_LINE, '').trim().replace(/^`?Nothing to raise\.?`?$/i, ''), findings);
  return rest ? `${verdictFor(findings).line}\n\n${rest}` : verdictFor(findings).line;
}

// The <details> summary is counted in code, like the verdict line, so the two
// always agree. It holds every Minor, plus the Should fix items and Questions
// that didn't fit the visible slots (verify's count minus the numbered 🟡/❓
// entries above <details>).
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
export function detailsSummary(body, findings = []) {
  const open = /<details>\s*<summary>[^<]*<\/summary>/i;
  if (!open.test(body)) return body;
  const visible = body.split(/<details\b/i)[0];
  const shown = (icon) => (visible.match(new RegExp(`^\\s*\\d+[.)]\\s*${icon}`, 'gmu')) ?? []).length;
  const count = (test) => findings.filter(test).length;
  const folded = [
    [count((f) => f.status === 'Confirmed' && f.priority === 'Should fix') - shown('🟡'), 'should-fix', 'should-fix'],
    [count((f) => f.status === 'Question') - shown('❓'), 'question', 'questions'],
    [count((f) => f.status === 'Confirmed' && f.priority === 'Minor'), 'minor item', 'minor items'],
  ].filter(([n]) => n > 0).map(([n, one, many]) => plural(n, one, many));
  if (!folded.length) return body;
  const text = folded.length === 1 ? folded[0] : `${folded.slice(0, -1).join(', ')} and ${folded.at(-1)}`;
  return body.replace(open, `<details><summary>${text}</summary>`);
}

// Rewrites the verdict line when it contradicts the review type the person chose.
// On your own PR the only review type is a comment and you aren't a reviewer,
// so the code-decided verdict stays as a recommendation, marked "Self-review:".
const SELF = 'Self-review: ';
export function alignVerdict(digest, event, { own = false } = {}) {
  if (own) {
    const old = VERDICT_LINE.exec(digest)?.[0];
    if (!old || old.includes(SELF)) return { digest, changed: false };
    const line = old.replace(/^(\s*\*\*Verdict:\*\*\s*)/, `$1${SELF}`).trimEnd();
    return { digest: digest.replace(VERDICT_LINE, `${line}\n`), changed: true, line };
  }
  const current = verdictFromText(digest);
  const target = event === 'approve' ? (current?.level === 'ship' ? null : 'ship')
    : current?.level === 'ship' || !current ? (event === 'request-changes' ? 'changes' : event === 'comment' ? 'comment' : null)
      : null;
  if (!target) return { digest, changed: false };
  const old = VERDICT_LINE.exec(digest)?.[0];
  let rest = old ? old.replace(/^\s*\*\*Verdict:\*\*\s*\S+\s+[^.]*\.\s*/, '').trim() : '';
  // Approving over open should-fix items or questions: say they don't block.
  if (target === 'ship' && /\b(?:must-fix|should-fix|questions?)\b/.test(rest)) rest = rest.replace(/\.$/, ', none blocking.');
  const line = lineFor(target, rest || '').trimEnd();
  const updated = old ? digest.replace(VERDICT_LINE, `${line}\n`) : `${line}\n\n${digest}`;
  return { digest: updated, changed: true, line };
}
