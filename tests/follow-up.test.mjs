import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ancestry, followUpLine, followUpMode, postedFindings, postedHead, quietMentions, reviewState } from '../src/follow-up.mjs';

const FOOTER = '\n\n---\n<sub>Reviewed at `abc1234` with AI assistance. Each finding was checked against the code.</sub>\n';
const DIGEST = `**Verdict:** 🔴 Fix before merge. 1 must-fix, 1 should-fix, 1 question.

### Must fix
1. 🔴 **Retry resends a chunk the server already stored**
   [\`upload.ts:41\`](https://github.com/acme/widget/pull/61/files#diff-1R41) · \`sendChunk\`
   A timeout after the server wrote chunk 3 retries the POST. Fix: send the offset header.

### Should fix
2. 🟡 **Backoff has no upper bound**
   \`retry.ts\` · \`delayFor\`
   After 10 attempts the delay passes 17 minutes. Fix: clamp to \`maxDelayMs\`.

### Questions
3. ❓ The spec says uploads over 5 GB are refused, but \`MAX_SIZE\` is 50 GB.
   Which one is right?

<details><summary>1 minor item</summary>

- 4. 🟡 \`progress.ts:9\`: not a numbered finding, it's inside details.
</details>`;

test('postedFindings reads the numbered findings, their severity, location and text, not the minors', () => {
  const { fromReviewpr, findings } = postedFindings(DIGEST + FOOTER);
  assert.equal(fromReviewpr, true);
  assert.deepEqual(findings, [
    { n: 1, severity: 'Must fix', title: 'Retry resends a chunk the server already stored', location: '`upload.ts:41` · `sendChunk`', text: 'A timeout after the server wrote chunk 3 retries the POST. Fix: send the offset header.' },
    { n: 2, severity: 'Should fix', title: 'Backoff has no upper bound', location: '`retry.ts` · `delayFor`', text: 'After 10 attempts the delay passes 17 minutes. Fix: clamp to `maxDelayMs`.' },
    { n: 3, severity: 'Question', title: 'The spec says uploads over 5 GB are refused, but `MAX_SIZE` is 50 GB.', location: '', text: 'Which one is right?' },
  ]);
});

test('postedFindings: a follow-up digest parses the same way, so follow-ups chain', () => {
  const followUp = `**Verdict:** ⚠️ Changes recommended. 1 still open.

> 🔁 **Re-review of the changes since the review at \`abc1234\`** (2 new commits).
> 1. 🔴 not a finding: inside the notice.

### Still open from the last review
1. 🟡 **Backoff has no upper bound**
   \`retry.ts\` · \`delayFor\`
   Still unbounded. Fix: clamp it.

### New in the fixes
2. 🟡 **The retry counter is never reset**
   \`upload.ts:95\`
   Fix: reset it per chunk.

<details><summary>Resolved since the last review: 1 fixed</summary>

- ✅ **Fixed:** Retry resends a chunk
</details>

---
<sub>Follow-up at \`def5678\` of the review at \`abc1234\`, with AI assistance.</sub>`;
  const { fromReviewpr, findings } = postedFindings(followUp);
  assert.equal(fromReviewpr, true);
  assert.deepEqual(findings.map((f) => [f.n, f.severity, f.title]), [[1, 'Should fix', 'Backoff has no upper bound'], [2, 'Should fix', 'The retry counter is never reset']]);
  assert.equal(postedHead(followUp), 'def5678');
});

test('postedFindings: a hand-written review is not from reviewpr; an empty digest has no findings', () => {
  assert.equal(postedFindings('1. 🔴 **Looks wrong**\n   please fix').fromReviewpr, false);
  assert.deepEqual(postedFindings(`**Verdict:** ✅ Ship. Only minor items.\n\n<details><summary>1 minor item</summary>\n\n- x\n</details>${FOOTER}`).findings, []);
  assert.equal(postedHead(`text${FOOTER}`), 'abc1234');
  assert.equal(postedHead('Reviewed by pr-review at `c0ffee1` long ago'), 'c0ffee1');
  assert.equal(postedHead('no footer'), null);
});

test('ancestry maps GitHub compare status', () => {
  assert.equal(ancestry('ahead'), 'kept');
  assert.equal(ancestry('identical'), 'kept');
  assert.equal(ancestry('diverged'), 'rewritten');
  assert.equal(ancestry('behind'), 'rewritten');
  assert.equal(ancestry('missing'), 'missing');
  assert.equal(ancestry(undefined), 'unknown');
});

const review = (state, body = DIGEST + FOOTER) => ({ state, body, commit: 'a'.repeat(40) });

test('followUpMode: each row of the decision table, first match wins', () => {
  const mode = (input) => followUpMode({ history: 'kept', ...input });
  assert.deepEqual([mode({ full: true, latest: review('CHANGES_REQUESTED') })].map((m) => [m.mode, m.key, m.line, m.short]),
    [['full', 'asked', 'Full review: you asked for one.', 'full review']]);
  assert.equal(mode({ own: true, latest: review('COMMENTED') }).key, 'own');
  assert.equal(mode({ own: true }).line, null);
  assert.equal(mode({}).key, 'first');
  // A dismissed review still counts, as what it was posted as.
  // After an approval (dismissed by a push, too) only the new commits are reviewed.
  const shipped = mode({ latest: review('DISMISSED', `**Verdict:** ✅ Ship. Only minor items.${FOOTER}`) });
  assert.deepEqual([shipped.mode, shipped.approved, shipped.findings, shipped.line], ['follow-up', true, [], null]);
  assert.equal(mode({ latest: review('DISMISSED') }).mode, 'follow-up');
  assert.equal(mode({ latest: review('DISMISSED', 'LGTM') }).key, 'hand-written');
  // Points an approval left open (questions, should-fix approved over) are checked too.
  assert.deepEqual([mode({ latest: review('APPROVED') })].map((m) => [m.mode, m.approved, m.findings.length]), [['follow-up', true, 3]]);
  // A hand-written approval: just the new commits.
  assert.deepEqual([mode({ latest: review('APPROVED', 'LGTM') })].map((m) => [m.mode, m.findings]), [['follow-up', []]]);
  assert.equal(mode({ latest: review('APPROVED'), history: 'rewritten' }).key, 'rewritten');
  const hand = mode({ latest: review('CHANGES_REQUESTED', '1. 🔴 **x**\n   y') });
  assert.deepEqual([hand.key, hand.short], ['hand-written', 'hand-written review']);
  assert.match(hand.line, /wasn't made by reviewpr/);
  assert.equal(mode({ latest: review('COMMENTED', `**Verdict:** ✅ Ship. Only minor items.${FOOTER}`) }).key, 'no-findings');
  const rewritten = mode({ latest: review('CHANGES_REQUESTED'), history: 'rewritten' });
  assert.deepEqual([rewritten.key, rewritten.short], ['rewritten', 'history rewritten']);
  assert.match(rewritten.line, /^Full review: the commit you reviewed \(`aaaaaaa`\) is no longer in the PR's history \(rebase or force-push\)/);
  assert.match(rewritten.notice, /^🔁 \*\*Full re-review:\*\* the commit reviewed last time \(`aaaaaaa`\)/);
  const gone = mode({ latest: review('CHANGES_REQUESTED'), history: 'missing' });
  assert.deepEqual([gone.key, gone.short], ['missing', 'commit gone']);
  assert.match(gone.notice, /no longer available/);
});

test('followUpMode: a follow-up after Request changes or Comment carries the head and findings', () => {
  for (const state of ['CHANGES_REQUESTED', 'COMMENTED']) {
    const result = followUpMode({ latest: review(state), history: 'kept' });
    assert.equal(result.mode, 'follow-up');
    assert.equal(result.head, 'a'.repeat(40));
    assert.equal(result.findings.length, 3);
  }
  // Unknown history (the compare call failed) doesn't block: the run checks with git.
  assert.equal(followUpMode({ latest: review('COMMENTED'), history: 'unknown' }).mode, 'follow-up');
  // Without the REST commit, the footer's short head is used.
  assert.equal(followUpMode({ latest: { state: 'COMMENTED', body: DIGEST + FOOTER } }).head, 'abc1234');
});

test('followUpLine counts commits and findings', () => {
  assert.equal(followUpLine({ head: 'a'.repeat(40), commits: 2, findings: 4 }), 'Follow-up of your review at `aaaaaaa`: 2 new commits, 4 findings to check.');
  assert.equal(followUpLine({ head: 'a'.repeat(40), commits: 1, findings: 0, approved: true }), 'Follow-up of your approval at `aaaaaaa`: 1 new commit, only the new code is reviewed.');
  assert.equal(followUpLine({ head: 'a'.repeat(40), commits: 0, findings: 0, approved: true, rebased: true }), 'Follow-up of your approval at `aaaaaaa`: rebased, no changes to the PR\'s code, nothing new to review.');
  assert.equal(followUpLine({ head: 'abc1234', commits: 0, findings: 1 }), 'Follow-up of your review at `abc1234`: no new commits, 1 finding to check.');
});

const { checkStatuses, followUpDigest, reReviewNotice, resolved, shortTitle, withNotice } = await import('../src/follow-up.mjs');
const { verdictFromText } = await import('../src/verdict.mjs');

const PREVIOUS = postedFindings(DIGEST + FOOTER).findings;
const FACTS = { old: 'a'.repeat(40), head: 'b'.repeat(40), commits: 2, chained: false, merged: null };
const fixed = (evidence = 'upload.ts:41 now sends the offset') => ({ status: 'Fixed', evidence });

test('checkStatuses: one valid status per finding, Answered needs a judgement, evidence is required', () => {
  assert.equal(checkStatuses([fixed()], 1), null);
  assert.match(checkStatuses([fixed()], 2), /1 statuses for 2/);
  assert.match(checkStatuses([{ status: 'Gone', evidence: 'x' }], 1), /unknown status/);
  assert.match(checkStatuses([{ status: 'Answered', evidence: 'x' }], 1), /accepted/);
  assert.match(checkStatuses([{ status: 'Fixed', evidence: ' ' }], 1), /without evidence/);
  assert.equal(resolved({ status: 'Answered', answer: 'accepted' }), true);
  assert.equal(resolved({ status: 'Answered', answer: 'disputed' }), false);
  assert.equal(resolved({ status: 'Partly fixed' }), false);
});

test('followUpDigest: still open first, numbered; new findings after; resolved folded; notice under the verdict', () => {
  const statuses = [
    fixed(),
    { status: 'Partly fixed', evidence: 'retry.ts:18', remaining: 'The clamp is added but never tested.' },
    { status: 'Answered', answer: 'accepted', reply: 'The 5 GB limit is the gateway\'s; MAX_SIZE is the storage cap.', evidence: 'gateway.yml:3 sets 5 GB.' },
  ];
  const newBody = `### Should fix\n1. 🟡 **The retry counter is never reset**\n   \`upload.ts:95\`\n   Fix: reset it per chunk.\n\n<details><summary>1 minor item</summary>\n\n- \`upload.ts:4\`: unused export.\n</details>`;
  const newFindings = [{ status: 'Confirmed', priority: 'Should fix' }, { status: 'Confirmed', priority: 'Minor' }];
  const digest = followUpDigest({ previous: PREVIOUS, statuses, newBody, newFindings, facts: FACTS });
  assert.equal(digest, `**Verdict:** ⚠️ Changes recommended. 1 still open, 1 new.

> 🔁 **Re-review since \`aaaaaaa\`** (2 new commits): only the 3 earlier points and what the new commits changed were checked.
> 1 fixed, 1 answered, 1 still open, 1 new.

### Still open from the last review
1. 🟡 **Backoff has no upper bound**
   \`retry.ts\` · \`delayFor\`
   Partly fixed: The clamp is added but never tested.

### New in the fixes
2. 🟡 **The retry counter is never reset**
   \`upload.ts:95\`
   Fix: reset it per chunk.

<details><summary>Resolved since the last review: 1 fixed, 1 answered</summary>

- ✅ Retry resends a chunk the server already stored
- 💬 The spec says uploads over 5 GB are refused, but \`MAX_SIZE\` is 50 GB
</details>

<details><summary>In the new commits: 1 minor item</summary>

- \`upload.ts:4\`: unused export.
</details>`);
  // The result reads back: the next follow-up finds the open and new findings.
  assert.deepEqual(postedFindings(`${digest}${FOOTER}`).findings.map((f) => f.title), ['Backoff has no upper bound', 'The retry counter is never reset']);
  assert.equal(verdictFromText(digest).event, 'comment');
});

test('followUpDigest verdict: an open or disputed Must fix requests changes; all resolved approves', () => {
  const disputed = [{ status: 'Answered', answer: 'disputed', reply: 'It never times out.', evidence: 'upload.ts:40 has a 30 s timeout.' }, fixed(), fixed()];
  const blocking = followUpDigest({ previous: PREVIOUS, statuses: disputed, facts: FACTS });
  assert.equal(verdictFromText(blocking).event, 'request-changes');
  assert.match(blocking, /1\. 🔴 \*\*Retry resends a chunk the server already stored\*\*\n {3}`upload\.ts:41` · `sendChunk`\n {3}Reply: "It never times out\." This doesn't settle it: upload\.ts:40 has a 30 s timeout\./);
  const clean = followUpDigest({ previous: PREVIOUS, statuses: [fixed(), fixed(), fixed()], facts: FACTS });
  assert.match(clean, /^\*\*Verdict:\*\* ✅ Ship\. All 3 earlier points resolved, nothing new\./);
  assert.match(clean, /\n> 3 fixed, nothing new\./);
  assert.equal(verdictFromText(clean).event, 'approve');
  // A new Must fix blocks even when everything earlier is fixed.
  const fresh = followUpDigest({ previous: PREVIOUS, statuses: [fixed(), fixed(), fixed()], newBody: '### Must fix\n1. 🔴 **Breaks login**\n   `auth.ts:3`\n   Fix: x.', newFindings: [{ status: 'Confirmed', priority: 'Must fix' }], facts: FACTS });
  assert.equal(verdictFromText(fresh).event, 'request-changes');
  assert.match(fresh, /### New in the fixes\n1\. 🔴 \*\*Breaks login\*\*/);
  // "Nothing to raise." from the skill adds no section.
  assert.doesNotMatch(followUpDigest({ previous: PREVIOUS, statuses: [fixed(), fixed(), fixed()], newBody: 'Nothing to raise.', facts: FACTS }), /New in the fixes/);
});

test('reReviewNotice variants: no new commits, base merged in, chained follow-up', () => {
  const counts = { fixed: 0, answered: 1, open: 1, added: 0 };
  assert.equal(reReviewNotice({ ...FACTS, commits: 0, total: 2, counts }),
    '> 🔁 **Re-review since `aaaaaaa`** (no new commits): only the replies to the 2 earlier points were checked.\n> 1 answered, 1 still open.');
  assert.match(reReviewNotice({ ...FACTS, merged: 'main', total: 2, counts }), /were checked\. Changes merged in from `main` weren't reviewed\.\n/);
  assert.equal(reReviewNotice({ ...FACTS, commits: 1, chained: true, total: 2, counts }),
    '> 🔁 **Re-review since the follow-up at `aaaaaaa`** (1 new commit): only the 2 earlier points still open and what the new commit changed were checked.\n> 1 answered, 1 still open, nothing new.');
});

test('shortTitle cuts long titles at a word and never leaves a code span open', () => {
  assert.equal(shortTitle('Backoff has no upper bound.'), 'Backoff has no upper bound');
  const long = 'Is `**/*.md` low on purpose, so that `SKILL.md` and agent bodies which instruct agents are `merge_eligible`, when only a few fields count?';
  const cut = shortTitle(long);
  assert(cut.length <= 82, cut);
  assert.equal((cut.match(/`/g) ?? []).length % 2, 0);
  assert.match(cut, / …$/);
});

test('withNotice puts the fallback reason under the verdict line', () => {
  assert.equal(withNotice('**Verdict:** ✅ Ship. No issues found.\n\n### Should fix\n1. x', '🔁 **Full re-review:** gone.'),
    '**Verdict:** ✅ Ship. No issues found.\n\n> 🔁 **Full re-review:** gone.\n\n### Should fix\n1. x');
  assert.equal(withNotice('body', null), 'body');
});

const { sameChanges } = await import('../src/follow-up.mjs');

test('sameChanges: the same added and removed lines are the same, wherever they moved', () => {
  const file = (patch, extra = {}) => ({ filename: 'a.js', status: 'modified', sha: 's1', patch, ...extra });
  const then = { total: 1, files: [file('@@ -10,3 +10,3 @@ f()\n context\n-old\n+new\n more')] };
  // Rebased: other hunk position and other context lines.
  const now = { total: 1, files: [file('@@ -40,3 +40,3 @@ g()\n other context\n-old\n+new\n changed too', { sha: 's2' })] };
  assert.equal(sameChanges(then, now), true);
  assert.equal(sameChanges(then, { total: 1, files: [file('@@ -10,3 +10,3 @@\n-old\n+newer')] }), false);
  assert.equal(sameChanges(then, { total: 2, files: [file('@@\n-old\n+new'), { filename: 'b.js', status: 'added', sha: 'x', patch: '+b' }] }), false);
  // A binary file has no patch: compared by its blob.
  const bin = (sha) => ({ total: 1, files: [{ filename: 'logo.png', status: 'modified', sha }] });
  assert.equal(sameChanges(bin('s1'), bin('s1')), true);
  assert.equal(sameChanges(bin('s1'), bin('s2')), false);
  assert.equal(sameChanges(bin(null), bin(null)), null);
  // GitHub's 300-file limit, or a missing side: can't tell.
  assert.equal(sameChanges({ total: 300, files: [] }, { total: 300, files: [] }), null);
  assert.equal(sameChanges(null, now), null);
});

test('followUpMode follows up when the history was rewritten but the changes are unchanged; the notice says rebased', () => {
  const result = followUpMode({ latest: review('CHANGES_REQUESTED'), history: 'unchanged' });
  assert.equal(result.mode, 'follow-up');
  assert.equal(reReviewNotice({ old: 'a'.repeat(40), commits: 0, rebased: true, total: 3, counts: { fixed: 0, answered: 1, open: 2, added: 0 } }),
    '> 🔁 **Re-review since `aaaaaaa`** (rebased, no changes to the PR\'s code): only the replies to the 3 earlier points were checked.\n> 1 answered, 2 still open.');
  assert.equal(followUpLine({ head: 'abc1234', commits: 0, findings: 3, rebased: true }), 'Follow-up of your review at `abc1234`: rebased, no changes to the PR\'s code, 3 findings to check.');
});

test('reviewState: a dismissed review reads back as what its verdict line was posted as', () => {
  const dismissed = (verdict) => reviewState({ state: 'DISMISSED', body: `**Verdict:** ${verdict}${FOOTER}` });
  assert.equal(dismissed('✅ Ship. Only minor items.'), 'APPROVED');
  assert.equal(dismissed('✅ Ship. 1 should-fix, none blocking.'), 'APPROVED');
  assert.equal(dismissed('🔴 Fix before merge. 1 must-fix.'), 'CHANGES_REQUESTED');
  assert.equal(dismissed('⚠️ Changes recommended. 2 should-fix.'), 'CHANGES_REQUESTED');
  assert.equal(reviewState({ state: 'DISMISSED', body: 'LGTM' }), 'DISMISSED');
  assert.equal(reviewState({ state: 'APPROVED', body: `**Verdict:** 🔴 Fix before merge.${FOOTER}` }), 'APPROVED');
  assert.equal(reviewState(null), null);
});

test('quietMentions: an @user or @org/team outside code becomes code, so posting notifies nobody', () => {
  assert.equal(quietMentions('Ask @acme/widget-owners and @octo-dev.'), 'Ask `@acme/widget-owners` and `@octo-dev`.');
  assert.equal(quietMentions('(@octo-dev) first: @lee'), '(`@octo-dev`) first: `@lee`');
  assert.equal(quietMentions('@lee at the start'), '`@lee` at the start');
});

test('quietMentions: code, emails, paths and bots are left alone', () => {
  const kept = 'Already `@acme/owners`, mail a@b.com, see https://example.com/@x, github-actions[bot], foo.@bar';
  assert.equal(quietMentions(kept), kept);
  const fenced = '```\n@lee in a fence\n```\nthen @lee';
  assert.equal(quietMentions(fenced), '```\n@lee in a fence\n```\nthen `@lee`');
});

test('followUpDigest: fixes made and only questions still open recommend approving', () => {
  const previous = [
    { n: 1, severity: 'Should fix', title: 'Head read once', location: '`a.ps1:13`', text: '' },
    { n: 2, severity: 'Question', title: 'Owners accept the carve-out?', location: '-', text: '' },
    { n: 3, severity: 'Question', title: 'Is bot approval enough?', location: '-', text: '' },
  ];
  const waiting = { status: 'Still open', reply: 'Still waiting on the owners.', evidence: 'No owner replied.', remaining: 'The owners must confirm.' };
  const digest = followUpDigest({ previous, statuses: [fixed(), waiting, waiting], facts: { ...FACTS, commits: 1 } });
  assert.match(digest, /^\*\*Verdict:\*\* ✅ Ship\. 2 still open, none blocking\.\n/);
  assert.equal(verdictFromText(digest).event, 'approve');
  assert.match(digest, /1\. ❓ Owners accept the carve-out\?/);
});

test('followUpDigest after an approval: only the new commits, no empty tally, its own heading', () => {
  const facts = { ...FACTS, commits: 2, approved: true };
  assert.equal(followUpDigest({ previous: [], statuses: [], facts }),
    '**Verdict:** ✅ Ship. Nothing new.\n\n> 🔁 **Re-review since the approval at `aaaaaaa`** (2 new commits): only what the new commits changed was checked.');
  const found = followUpDigest({ previous: [], statuses: [], newBody: '### Should fix\n1. 🟡 **Loop never ends**\n   `a.js:3`\n   Fix: cap it.', newFindings: [{ status: 'Confirmed', priority: 'Should fix' }], facts });
  assert.match(found, /^\*\*Verdict:\*\* ⚠️ Changes recommended\. 1 new\.\n\n> .*\n> 1 new\.\n\n### New since the approval\n1\. 🟡 \*\*Loop never ends\*\*/);
});
