import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignVerdict, verdictFor, verdictFromText, withVerdict } from '../src/verdict.mjs';

const f = (status, priority = '-') => ({ title: 't', status, priority });

test('the verdict is decided by the highest confirmed priority; open questions alone ship and don\'t block', () => {
  assert.equal(verdictFor([f('Confirmed', 'Must fix'), f('Confirmed', 'Should fix')]).line, '**Verdict:** 🔴 Fix before merge. 1 must-fix, 1 should-fix.');
  const four = [1, 2, 3, 4].map(() => f('Confirmed', 'Should fix'));
  assert.deepEqual(
    [verdictFor([...four, f('Question'), f('Confirmed', 'Minor'), f('Rejected')]).line, verdictFor(four).event],
    ['**Verdict:** ⚠️ Changes recommended. 4 should-fix, 1 question.', 'comment'],
  );
  assert.deepEqual([verdictFor([f('Question'), f('Question')]).line, verdictFor([f('Question')]).event],
    ['**Verdict:** ✅ Ship. 2 questions, none blocking.', 'approve']);
  assert.equal(verdictFor([f('Question'), f('Confirmed', 'Minor')]).line, '**Verdict:** ✅ Ship. 1 question, none blocking.');
  // Comment only over such a Ship still says it isn't an approval.
  assert.equal(alignVerdict(verdictFor([f('Question')]).line, 'comment').line, '**Verdict:** 💬 Not approved yet. 1 question.');
  assert.equal(alignVerdict(verdictFor([f('Question')]).line, 'request-changes').line, '**Verdict:** ⚠️ Changes recommended. 1 question.');
  assert.equal(verdictFor([]).line, '**Verdict:** ✅ Ship. No issues found.');
  // Minors are counted in the <details> summary only, never in the verdict line.
  assert.equal(verdictFor([f('Confirmed', 'Minor'), f('Confirmed', 'Minor')]).line, '**Verdict:** ✅ Ship. Only minor items.');
});

test('a question verdict becomes Ship when approved, and Changes recommended when changes are requested', () => {
  const asks = '**Verdict:** 💬 Not approved yet. 2 questions.\n\nbody';
  assert.equal(alignVerdict(asks, 'approve').digest, '**Verdict:** ✅ Ship. 2 questions, none blocking.\n\nbody');
  assert.equal(alignVerdict(asks, 'request-changes').digest, '**Verdict:** ⚠️ Changes recommended. 2 questions.\n\nbody');
  assert.equal(alignVerdict(asks, 'comment').changed, false);
  assert.equal(alignVerdict('**Verdict:** 💬 Not approved yet. 2 still open.\n\nbody', 'approve').line, '**Verdict:** ✅ Ship. 2 still open, none blocking.');
});

test('the verdict level is read back from a digest, or null without a verdict line', () => {
  assert.equal(verdictFromText('**Verdict:** ⚠️ Changes recommended. 1 should-fix.\n\nbody').level, 'changes');
  assert.equal(verdictFromText('**Verdict:** 🔴 Fix before merge.').event, 'request-changes');
  assert.equal(verdictFromText('### Should fix'), null);
});

test('withVerdict replaces a model-written verdict and keeps an empty digest to one line', () => {
  assert.equal(withVerdict('**Verdict:** ✅ Ship.\n\n### Must fix\n1. x', [f('Confirmed', 'Must fix')]), '**Verdict:** 🔴 Fix before merge. 1 must-fix.\n\n### Must fix\n1. x');
  assert.equal(withVerdict('Nothing to raise.', []), '**Verdict:** ✅ Ship. No issues found.');
});

test('the chosen review type rewrites a contradicting verdict line and keeps the counts', () => {
  const ship = '**Verdict:** ✅ Ship. 1 question.\n\nbody';
  assert.deepEqual(alignVerdict(ship, 'request-changes'), { digest: '**Verdict:** ⚠️ Changes recommended. 1 question.\n\nbody', changed: true, line: '**Verdict:** ⚠️ Changes recommended. 1 question.' });
  assert.equal(alignVerdict(ship, 'comment').digest, '**Verdict:** 💬 Not approved yet. 1 question.\n\nbody');
  assert.equal(alignVerdict(ship, 'approve').changed, false);
  const block = '**Verdict:** 🔴 Fix before merge. 1 must-fix.\n\nbody';
  assert.equal(alignVerdict(block, 'approve').digest, '**Verdict:** ✅ Ship. 1 must-fix, none blocking.\n\nbody');
  assert.equal(alignVerdict('**Verdict:** ⚠️ Changes recommended. 1 should-fix, 1 question.\n\nbody', 'approve').digest,
    '**Verdict:** ✅ Ship. 1 should-fix, 1 question, none blocking.\n\nbody');
  assert.equal(alignVerdict(block, 'request-changes').changed, false);
  assert.equal(alignVerdict(block, 'comment').changed, false);
});

test('on your own PR the verdict stays a recommendation, marked as a self-review', () => {
  const ship = '**Verdict:** ✅ Ship. 1 should-fix.\n\nbody';
  assert.deepEqual(alignVerdict(ship, 'comment', { own: true }), {
    digest: '**Verdict:** Self-review: ✅ Ship. 1 should-fix.\n\nbody', changed: true, line: '**Verdict:** Self-review: ✅ Ship. 1 should-fix.',
  });
  const marked = alignVerdict(ship, 'comment', { own: true }).digest;
  assert.equal(alignVerdict(marked, 'comment', { own: true }).changed, false);
  assert.equal(verdictFromText(marked).level, 'ship');
  const block = '**Verdict:** 🔴 Fix before merge. 1 must-fix.\n\nbody';
  assert.equal(alignVerdict(block, 'comment', { own: true }).digest, '**Verdict:** Self-review: 🔴 Fix before merge. 1 must-fix.\n\nbody');
});

test('digestBody keeps the comment format and cuts everything else', async () => {
  const { digestBody } = await import('../src/adapters.mjs');
  assert.deepEqual(digestBody('Nothing to raise.'), { body: 'Nothing to raise.', removed: [] });
  const fenced = '### Should fix\n1. 🟡 **Bad parse**\n   `a.py` · `parse`\n\n```\nx = 1\n\nprint(x)\n```\n\n### Questions\n2. ❓ Which limit applies?';
  assert.deepEqual(digestBody(fenced), { body: fenced, removed: [] });
  const details = '<details><summary>2 minor items</summary>\n\n- one\n\n- two\n</details>';
  assert.deepEqual(digestBody(`Here is the comment:\n\n${details}\n\nLet me know if you want changes.`), {
    body: details, removed: ['Here is the comment:', 'Let me know if you want changes.'],
  });
  assert.equal(digestBody('  indented chatter before anything\n\n### Must fix\n1. 🔴 **X**').body, '### Must fix\n1. 🔴 **X**');
});

test('digestBody drops a group that only says None', async () => {
  const { digestBody } = await import('../src/adapters.mjs');
  const text = '### Must fix\nNone.\n\n### Should fix\n1. 🟡 **Real problem**\n   `a.py` · `f`\n\n### Questions\n- n/a\n\n<details><summary>1 minor item</summary>\n\n- `b.py:3`: unused.\n</details>';
  assert.equal(digestBody(text).body, '### Should fix\n1. 🟡 **Real problem**\n   `a.py` · `f`\n\n<details><summary>1 minor item</summary>\n\n- `b.py:3`: unused.\n</details>');
  assert.equal(digestBody('### Must fix\nNone.').body, '');
});

test('the <details> summary is counted in code, including folded questions and should-fix items', async () => {
  const { detailsSummary } = await import('../src/verdict.mjs');
  const findings = [
    ...[1, 2, 3, 4].map(() => f('Confirmed', 'Should fix')),
    f('Question'), f('Question'),
    ...[1, 2, 3, 4, 5].map(() => f('Confirmed', 'Minor')),
    f('Rejected'),
  ];
  const body = '### Should fix\n1. 🟡 **a**\n2. 🟡 **b**\n3. 🟡 **c**\n4. 🟡 **d**\n\n### Questions\n5. ❓ One?\n\n<details><summary>6 minor items</summary>\n\n- q\n- m\n</details>';
  assert.match(detailsSummary(body, findings), /<details><summary>1 question and 5 minor items<\/summary>/);
  const more = '### Should fix\n1. 🟡 **a**\n2. 🟡 **b**\n\n<details><summary>whatever</summary>\n\n- x\n</details>';
  assert.match(detailsSummary(more, findings), /<summary>2 should-fix, 2 questions and 5 minor items<\/summary>/);
  assert.match(detailsSummary('<details><summary>3 minor items</summary>\n\n- x\n</details>', [f('Confirmed', 'Minor')]), /<summary>1 minor item<\/summary>/);
  assert.equal(detailsSummary('### Should fix\n1. 🟡 **a**', findings), '### Should fix\n1. 🟡 **a**');
});
