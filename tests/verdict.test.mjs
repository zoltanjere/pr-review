import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignVerdict, verdictFor, verdictFromText, withVerdict } from '../src/verdict.mjs';

const f = (status, priority = '-') => ({ title: 't', status, priority });

test('the verdict has three levels decided by the highest confirmed priority', () => {
  assert.equal(verdictFor([f('Confirmed', 'Must fix'), f('Confirmed', 'Should fix')]).line, '**Verdict:** 🔴 Fix before merge. 1 must-fix, 1 should-fix.');
  const four = [1, 2, 3, 4].map(() => f('Confirmed', 'Should fix'));
  assert.deepEqual(
    [verdictFor([...four, f('Question'), f('Confirmed', 'Minor'), f('Rejected')]).line, verdictFor(four).event],
    ['**Verdict:** ⚠️ Changes recommended. 4 should-fix, 1 question, 1 minor.', 'request-changes'],
  );
  assert.deepEqual([verdictFor([f('Question'), f('Question')]).line, verdictFor([f('Question')]).event],
    ['**Verdict:** ✅ Ship. 2 questions.', 'approve']);
  assert.equal(verdictFor([]).line, '**Verdict:** ✅ Ship. No issues found.');
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
  assert.equal(alignVerdict(block, 'approve').digest, '**Verdict:** ✅ Ship. 1 must-fix.\n\nbody');
  assert.equal(alignVerdict(block, 'request-changes').changed, false);
  assert.equal(alignVerdict(block, 'comment').changed, false);
});
