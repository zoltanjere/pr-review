import { writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { checkDigest } from './adapters.mjs';
import { costLines, costTotal, editText, renderDigest, summarizeFindings } from './confirm.mjs';
import { pickFromList } from './select.mjs';
import { isLive, runSteps } from './steps.mjs';
import { palette, plainReporter, PROVIDER_NAMES } from './ui.mjs';
import { alignVerdict, verdictFor, verdictFromText } from './verdict.mjs';

// After a run every file is saved. This step shows the result and lets the
// person keep it local (the default) or post it as one review on the PR. It
// is the only path that writes to GitHub, and it needs two explicit choices.

export const EVENTS = {
  approve: 'Approve',
  comment: 'Comment only',
  'request-changes': 'Request changes',
};

// Which review types may be posted, and which one to recommend. The
// recommendation follows the digest's verdict line, which the person may have
// edited, and falls back to the findings.
export function reviewOptions({ findings, reviewedHead, status, digest }) {
  if (status.state !== 'OPEN') {
    return { allowed: [], recommended: null, notes: [`The PR is ${String(status.state).toLowerCase()}, so nothing can be posted.`] };
  }
  const notes = [];
  let allowed = ['approve', 'comment', 'request-changes'];
  if (reviewedHead && status.head !== reviewedHead) {
    allowed = ['comment'];
    notes.push(`The PR has new commits since this review (${reviewedHead.slice(0, 7)} → ${String(status.head).slice(0, 7)}), so it can only be posted as a comment.`);
  } else if (status.author && status.author === status.viewer) {
    allowed = ['comment'];
    notes.push('This is your own PR; GitHub only allows a comment.');
  }
  const verdict = verdictFromText(digest) ?? verdictFor(findings);
  const wanted = verdict.event;
  return { allowed, recommended: allowed.includes(wanted) ? wanted : 'comment', notes, level: verdict.level };
}

// The footer records the commit reviewed (the picker and the next follow-up
// read it back); a follow-up also names the review it followed.
export function reviewBody(digest, head, previous = null) {
  const commit = head ? ` at \`${head.slice(0, 7)}\`` : '';
  const lead = previous ? `Follow-up${commit} of the review at \`${previous.slice(0, 7)}\`, with AI assistance` : `Reviewed${commit} with AI assistance`;
  return `${digest.trim()}\n\n---\n<sub>${lead}. Each finding was checked against the code.</sub>\n`;
}

// What was reviewed, and how, shown once at the top of the decision screen.
export function runHeader({ pr, title, head, provider, model, checkModel, usage }, c = palette(false)) {
  const ref = `${pr.owner}/${pr.repo}#${pr.number}`;
  const via = provider ? ` ${c.dim(`(${PROVIDER_NAMES[provider] ?? provider})`)}` : '';
  const models = model ? `${model}${checkModel && checkModel !== model ? ` · check: ${checkModel}` : ''}${via}` : null;
  const cost = costTotal(usage);
  return [
    c.bold(`${ref}${title ? `  ${title}` : ''}`),
    `  ${c.dim('PR')}      https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`,
    head ? `  ${c.dim('Commit')}  ${head.slice(0, 7)}` : null,
    models ? `  ${c.dim('Model')}   ${models}` : null,
    cost ? `  ${c.dim('Cost')}    ${cost}` : null,
  ].filter(Boolean);
}

// The menus use the same arrow-key picker as the PR selector. Returns the
// chosen value; cancelling (q, Esc) returns `fallback`.
export async function choose(pick, title, choices, fallback) {
  const initial = Math.max(0, choices.findIndex((choice) => choice.isDefault));
  const index = await pick(title, choices.map((choice) => choice.label), initial);
  return index === null ? fallback : choices[index].value;
}

export async function publishInTerminal(result, { adapters, input = process.stdin, output = process.stderr, pick: injectedPick, edit = editText, live = isLive(), reporter = plainReporter((line) => output.write(`${line}\n`)) } = {}) {
  const c = palette(!process.env.NO_COLOR && output.isTTY);
  const rule = (title) => c.dim(`── ${title} ${'─'.repeat(Math.max(4, Math.min(output.columns || 80, 100) - title.length - 4))}`);
  const pick = injectedPick ?? ((title, rows, initial) => pickFromList(title, rows, { input, output, initial, hint: 'Enter choose · q keep local' }));
  const prName = `${result.pr.owner}/${result.pr.repo}#${result.pr.number}`;
  const where = relative(process.cwd(), result.digestPath);
  const keptLocal = () => {
    output.write(`${c.dim('Kept local. Nothing was posted to GitHub.')}\n`);
    return { posted: null };
  };
  let digest = result.digest;
  for (;;) {
    // The cost table sits right above the first question, after the long
    // digest preview, so it is on screen when deciding.
    output.write(['', ...runHeader(result, c), '', rule('Decisions'), ...summarizeFindings(result.findings, c), '', rule('Digest preview'), '',
      ...renderDigest(digest, c), ...costLines(result.usage, c), ''].join('\n') + '\n');
    const problem = checkDigest(digest);
    if (problem) output.write(`${c.yellow(`! The digest ${problem}.`)}\n`);
    const next = await choose(pick, 'What next?', [
      { label: `Keep it local (saved in ${where})`, value: 'local', isDefault: true },
      { label: `Post it as a review on ${prName}`, value: 'post' },
      { label: 'Edit the digest first', value: 'edit' },
    ], 'local');
    if (next === 'local') return keptLocal();
    if (next === 'edit') {
      try {
        digest = await edit(digest);
        await writeFile(result.digestPath, `${digest.trim()}\n`, { mode: 0o600 });
      } catch (error) {
        output.write(`${c.red(error.message)}\n`);
      }
      continue;
    }
    // The GitHub calls are visible steps, so the screen never sits silent.
    let status;
    await runSteps([{ title: 'Checking PR state', run: async () => {
      status = await adapters.prStatus(result.pr);
      return String(status.state).toLowerCase();
    } }], { live, reporter });
    const { allowed, recommended, notes } = reviewOptions({ findings: result.findings, reviewedHead: result.head, status, digest });
    for (const note of notes) output.write(`${c.yellow(`! ${note}`)}\n`);
    if (!allowed.length) return keptLocal();
    const event = await choose(pick, `Post to ${prName} as:`, [
      ...allowed.map((value) => ({ label: `${EVENTS[value]}${value === recommended ? c.green(' (recommended)') : ''}`, value, isDefault: value === recommended })),
      { label: 'Cancel, keep it local', value: 'cancel' },
    ], 'cancel');
    if (event === 'cancel') return keptLocal();
    // The person's choice wins: a verdict line that contradicts it is rewritten,
    // and the saved digest matches what is posted.
    const own = Boolean(status.author) && status.author === status.viewer;
    const aligned = alignVerdict(digest, event, { own });
    if (aligned.changed) {
      digest = aligned.digest;
      await writeFile(result.digestPath, `${digest.trim()}\n`, { mode: 0o600 });
      output.write(`${c.yellow('!')} ${own ? 'Verdict line marked as a self-review' : 'Verdict line changed to match your choice'}: ${aligned.line}\n`);
    }
    await runSteps([{ title: `Posting review as ${EVENTS[event]}`, run: () => adapters.postReview(result.pr, event, reviewBody(digest, result.head, result.followUp?.old)) }], { live, reporter });
    output.write(`${c.green('✔')} Posted to ${prName} as ${c.bold(EVENTS[event])}.\n`);
    return { posted: event };
  }
}
