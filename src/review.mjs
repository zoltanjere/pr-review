#!/usr/bin/env node
// First: switch to the project's pinned Node if this one is older (.nvmrc).
import './node-version.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createAdapters, readConfig, REVIEWERS } from './adapters.mjs';
import { choosePr, OPEN_SETTINGS, pickFromList } from './select.mjs';
import { openSettings, settingsLine } from './settings.mjs';
import { ring } from './bell.mjs';
import { palette, plainReporter, toReporter } from './ui.mjs';
import { createRouter, isLive, runSteps } from './steps.mjs';
import { costTotal, printSummary } from './confirm.mjs';
import { choose, publishInTerminal } from './publish.mjs';
import { watchCommand } from './watch-run.mjs';
import { diffStats, formatSummary, renderSummary, SUMMARY_WORD_LIMIT, summaryWords } from './summary.mjs';
import { followUpDigest, followUpLine, formatFollowUp, quietMentions, statusSummary, withNotice } from './follow-up.mjs';

const STAGES = [...REVIEWERS, 'follow-up', 'scan', 'verified', 'digest', 'summary'].join('|');

export function parsePrUrl(input) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/.exec(input ?? '');
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') {
    throw new Error('Invalid GitHub pull request URL');
  }
  return { owner: match[1], repo: match[2], number: match[3] };
}

// A run is named by its local start time, e.g. 1430-digest.md. A second run
// in the same minute becomes 1430b, then 1430c, and so on. The lock file
// stops two runs started at once from taking the same name.
export function runIds(date) {
  const base = `${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}`;
  return [base, ...'bcdefghijklmnopqrstuvwxyz'.split('').map((letter) => `${base}${letter}`)];
}

async function reserveRun(directory, date) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const id of runIds(date)) {
    const lock = join(directory, `.run-${id}.lock`);
    try {
      await writeFile(lock, '', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    let existing;
    try {
      existing = await readdir(directory);
    } catch (error) {
      try {
        await unlink(lock);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `${error.message}; reservation cleanup failed: ${cleanupError.message}`);
      }
      throw error;
    }
    if (existing.some((file) => new RegExp(`^${id}-(?:${STAGES})\\.md$`).test(file))) {
      await unlink(lock);
      continue;
    }
    return { id, lock };
  }
  throw new Error(`Too many runs started in the same minute in ${directory}`);
}

// Removes the temporary checkout and the run's lock, then throws the run's
// error, a cleanup error, or both.
async function finishRun({ checkout, reservation, error, options }) {
  const cleanupErrors = [];
  if (checkout) {
    try {
      await runSteps([{ title: 'removing temporary checkout', run: () => checkout.cleanup() }], options);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
  }
  if (reservation) {
    try {
      await unlink(reservation.lock);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
  }
  if (cleanupErrors.length) {
    const errors = error ? [error, ...cleanupErrors] : cleanupErrors;
    throw new AggregateError(errors, `${error ? `${error.message}; ` : ''}cleanup failed: ${cleanupErrors.map((item) => item.message).join('; ')}`);
  }
  if (error) throw error;
}

// reviews/<day>/<repo>-PR<n>: every run of one PR on one day, summaries included.
function runDirectory(root, pr, date) {
  const day = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  return join(root, day, `${pr.repo}-PR${pr.number}`);
}

const words = (text) => String(text).split(/\s+/).filter(Boolean).length;

// Runs the review and saves every stage, the digest included. Posting is a
// separate, interactive step (src/publish.mjs) that works on the result.
// The phases are declared as steps (src/steps.mjs): listr2 in a terminal
// (`live`), "[progress]" lines otherwise. `router` sends the adapters' own
// progress lines to the step that is running.
export async function runPipeline(url, { root, adapters, progress, now = new Date(), live = false, router, full = false }) {
  const reporter = toReporter(progress);
  const pr = parsePrUrl(url);
  const date = now;
  const directory = runDirectory(root, pr, date);
  const saved = [];
  let reservation;
  const save = async (stage, text) => {
    if (typeof text !== 'string' || !text.trim()) throw new Error(`${stage} returned an empty review`);
    const path = join(directory, `${reservation.id}-${stage}.md`);
    await writeFile(path, `${text.trim()}\n`, { flag: 'wx', mode: 0o600 });
    saved.push(path);
    return path;
  };
  // Finish-line detail plus the stage's tokens and credits, when Copilot reported them.
  const detail = (text, stage) => [text, adapters.tokensFor?.(stage)].filter(Boolean).join(' · ');
  const use = (ui) => router?.route(ui.reporter);
  const options = { live, reporter };
  let checkout;
  let verified;
  let digest;
  let reviewError;
  // Follow-up or full review, decided while preparing (src/follow-up.mjs).
  let plan = { mode: 'full', line: full ? 'Full review: you asked for one.' : null, notice: null };
  let statuses = [];
  let scanText = '';
  const reviews = {};
  const failures = [];
  const visibleWords = (text) => `${words(text.split(/<details\b/i)[0])} visible words`;
  const fullSteps = () => [
    // Side by side; every successful review is saved before a failure stops the run.
    {
      title: 'Reviews', concurrent: true,
      steps: REVIEWERS.map((name) => ({
        title: name,
        run: async (ui) => {
          use(ui);
          try {
            const text = await adapters.review(name, checkout);
            await save(name, text);
            reviews[name] = text;
            return detail(`${words(text)} words`, name);
          } catch (error) {
            failures.push(`${name}: ${error.message ?? error}`);
            throw error;
          }
        },
      })),
    },
    {
      title: 'Verify', section: true,
      run: async (ui) => {
        use(ui);
        verified = await adapters.verify(Object.fromEntries(REVIEWERS.map((name) => [name, reviews[name]])));
        await save('verified', verified.markdown);
      },
    },
    {
      title: 'Digest',
      steps: [{
        title: 'writing digest',
        run: async (ui) => {
          use(ui);
          // A full review that replaced a follow-up says why, to the author.
          digest = quietMentions(withNotice(await adapters.digest(verified.markdown, verified.findings), plan.notice));
          await save('digest', digest);
          return detail(visibleWords(digest), 'review-digest');
        },
      }],
    },
  ];
  // Checks the earlier findings and scans only the new commits. After an
  // approval with no open points there is nothing to check, only the scan.
  const followUpSteps = () => [
    ...(plan.findings.length || plan.newDiffText?.trim() ? [{
      title: 'Follow-up', concurrent: true,
      steps: [
        ...(plan.findings.length ? [{
          title: `checking ${plan.findings.length} earlier finding${plan.findings.length === 1 ? '' : 's'}`,
          run: async (ui) => {
            use(ui);
            statuses = await adapters.followUp(plan);
            await save('follow-up', formatFollowUp(plan.findings, statuses));
            return detail(statusSummary(statuses), 'checking earlier findings');
          },
        }] : []),
        ...(plan.newDiffText?.trim() ? [{
          title: 'scanning the new commits',
          run: async (ui) => {
            use(ui);
            scanText = await adapters.scan(plan);
            await save('scan', scanText);
            return detail(`${words(scanText)} words`, 'scanning new commits');
          },
        }] : []),
      ],
    }] : []),
    {
      title: 'Verify', section: true,
      run: async (ui) => {
        use(ui);
        if (!scanText.trim() || /^\s*No findings\.?\s*$/i.test(scanText)) {
          ui.log(plan.newDiffText?.trim() ? 'no new findings to check' : 'no new code to check');
          verified = { markdown: '# Verified review\n\nNo findings.', findings: [] };
        } else {
          verified = await adapters.verify({ scan: scanText });
        }
        await save('verified', verified.markdown);
      },
    },
    {
      title: 'Digest',
      steps: [{
        title: 'writing digest',
        run: async (ui) => {
          use(ui);
          // The skill writes only the new findings; the rest comes from code.
          const worth = verified.findings.some((f) => f.status === 'Question' || f.status === 'Confirmed');
          const newBody = worth ? (await adapters.digest(verified.markdown, verified.findings)).replace(/^\s*\*\*Verdict:\*\*[^\n]*\n*/, '') : '';
          digest = quietMentions(await adapters.linkify(followUpDigest({
            previous: plan.findings, statuses, newBody, newFindings: verified.findings,
            facts: { old: plan.old, head: plan.head, commits: plan.commits, chained: plan.chained, approved: plan.approved, merged: plan.merged, rebased: plan.rebased },
          })));
          await save('digest', digest);
          return detail(visibleWords(digest), worth ? 'review-digest' : undefined);
        },
      }],
    },
  ];
  try {
    await runSteps([{
      title: `Preparing ${pr.owner}/${pr.repo}#${pr.number}`, section: true,
      run: async (ui) => {
        use(ui);
        checkout = await adapters.prepare(pr);
        reservation = await reserveRun(directory, date);
        if (adapters.followUpPlan) plan = await adapters.followUpPlan({ full });
        // Said before any model runs, so a surprise can still be cancelled.
        if (plan.mode === 'follow-up') ui.reporter.note(followUpLine({ head: plan.old, commits: plan.commits, findings: plan.findings.length, rebased: plan.rebased, approved: plan.approved }));
        else if (plan.line) ui.reporter.warn(plan.line);
      },
    }], options);
    await runSteps(plan.mode === 'follow-up' ? followUpSteps() : fullSteps(), options);
  } catch (error) {
    reviewError = failures.length ? new Error(failures.join('\n'), { cause: error }) : error;
  } finally {
    router?.route(null);
  }
  await finishRun({ checkout, reservation, error: reviewError, options });
  return {
    pr, directory, saved, digest, digestPath: saved.at(-1), head: checkout.head,
    title: checkout.title, provider: checkout.provider, model: checkout.model, checkModel: checkout.checkModel,
    findings: verified.findings, usage: adapters.usage?.() ?? [],
    followUp: plan.mode === 'follow-up' ? { old: plan.old } : null,
  };
}

// The summary (src/summary.mjs): prepare the same checkout as a review, run
// one session, save <id>-summary.md next to the review files. Never posted.
export async function runSummary(url, { root, adapters, progress, now = new Date(), live = false, router }) {
  const reporter = toReporter(progress);
  const pr = parsePrUrl(url);
  const directory = runDirectory(root, pr, now);
  const options = { live, reporter };
  const use = (ui) => router?.route(ui.reporter);
  let checkout;
  let reservation;
  let summary;
  let path;
  let error;
  try {
    await runSteps([
      {
        title: `Preparing ${pr.owner}/${pr.repo}#${pr.number}`, section: true,
        run: async (ui) => {
          use(ui);
          checkout = await adapters.prepare(pr);
          reservation = await reserveRun(directory, now);
        },
      },
      {
        title: 'Summary',
        steps: [{
          title: 'writing summary',
          run: async (ui) => {
            use(ui);
            const body = formatSummary(await adapters.summarize());
            const diffText = checkout.diffText ?? (checkout.diff ? await readFile(checkout.diff, 'utf8') : '');
            const stats = diffStats(diffText);
            summary = stats.files ? formatSummary(body, stats) : body;
            path = join(directory, `${reservation.id}-summary.md`);
            await writeFile(path, `${summary}\n`, { flag: 'wx', mode: 0o600 });
            const count = summaryWords(body);
            return [`${count} words${count > SUMMARY_WORD_LIMIT ? ` (long: over ${SUMMARY_WORD_LIMIT})` : ''}`, adapters.tokensFor?.('writing summary')].filter(Boolean).join(' · ');
          },
        }],
      },
    ], options);
  } catch (caught) {
    error = caught;
  } finally {
    router?.route(null);
  }
  await finishRun({ checkout, reservation, error, options });
  return { pr, title: checkout.title, summary, path, usage: adapters.usage?.() ?? [] };
}

export async function main(args, options = {}) {
  // The interactive watch returns to its picker after each review or summary.
  const configPath = options.configPath ?? join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'config.json');
  // Read again each time the list is shown, so a change in Settings applies at once.
  const settings = {
    line: async () => settingsLine(JSON.parse(await readFile(configPath, 'utf8'))),
    aliases: async () => (await readConfig(configPath)).repositoryAliases,
    open: () => (options.openSettings ?? openSettings)({ configPath }),
  };
  if (args[0] === 'watch') {
    return watchCommand(args.slice(1), {
      review: (url, choice = {}) => prAction(url, { ...actionOptions({ ...options, interactive: true }), full: Boolean(choice.full), back: true, done: false }),
      settings,
      ...options,
    });
  }
  if (args[0] === 'settings') {
    if (args.length > 1) throw new Error(USAGE);
    if (!(options.interactive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY))) throw new Error('Settings need a terminal. Edit config.json instead.');
    return settings.open();
  }
  const flags = args.filter((arg) => arg.startsWith('-'));
  const urls = args.filter((arg) => !arg.startsWith('-'));
  const unknown = flags.filter((flag) => !['-y', '--yes', '--full', '--summary'].includes(flag));
  if (urls.length > 1 || unknown.length) throw new Error(USAGE);
  const yes = flags.some((flag) => flag === '-y' || flag === '--yes');
  const summary = flags.includes('--summary');
  const interactive = options.interactive ?? Boolean(!yes && process.stdin.isTTY && process.stderr.isTTY);
  const act = actionOptions({ ...options, interactive });
  let url = urls[0];
  if (url) {
    parsePrUrl(url);
    // Not in a terminal there is no menu: review, or only summarise.
    if (!interactive) return summary ? act.summarize(url) : act.review(url, { full: flags.includes('--full') });
    await prAction(url, { ...act, full: flags.includes('--full'), start: summary ? 'summary' : 'ask' });
    return;
  }
  // No URL: pick one of the configured repositories' PRs that still need review.
  if (!interactive) throw new Error('Pass a PR URL, or run in a terminal without --yes to pick one from your repositories.');
  const config = await readConfig(options.configPath);
  if (!config.repositories.length) throw new Error('Pass a PR URL, or set "repositories": ["owner/repo"] in config.json to pick from their open PRs.');
  // "Back to the list" after a summary shows the picker again.
  for (;;) {
    let full = flags.includes('--full');
    url = await (options.pick ?? choosePr)(config.repositories, createAdapters({ ...options, progress: () => {} }), {
      onPick: (choice) => { full = full || Boolean(choice?.full); },
      settings: await settings.line(),
      aliases: await settings.aliases(),
    });
    if (url === OPEN_SETTINGS) {
      await settings.open();
      continue;
    }
    if (!url) return;
    if (await prAction(url, { ...act, full, back: true, start: summary ? 'summary' : 'ask' }) !== 'back') return;
  }
}

const USAGE = 'Usage: reviewpr [--yes] [--full] [--summary] [<GitHub PR URL>]\n       reviewpr watch [--once | --install | --uninstall]\n       reviewpr settings';

// What reviewing and summarising one PR need, for prAction.
function actionOptions(options) {
  return {
    menu: options.menu,
    output: options.menuOutput,
    review: (url, { full = false } = {}) => reviewOne(url, { ...options, full }),
    summarize: (url) => summaryOne(url, options),
  };
}

// The step between picking a PR and reviewing it: review it (the default),
// summarise it first, or go back. `f` in the picker (`full`) goes straight
// to a full review. Returns 'back' to show the list again, otherwise 'done'.
// `back`: a list to return to; `done`: offer Done after a summary (the watch
// app has no Done, since its list is always there).
export async function prAction(url, { full = false, back = false, done = true, start = 'ask', menu, output = process.stderr, review, summarize }) {
  const pr = parsePrUrl(url);
  const name = `${pr.owner}/${pr.repo}#${pr.number}`;
  const pick = menu ?? ((title, rows, initial) => pickFromList(title, rows, { output, initial, hint: `Enter choose · q ${back ? 'back' : 'cancel'}` }));
  if (!full) {
    const first = start === 'summary' ? 'summary' : await choose(pick, `${name}: what next?`, [
      { label: 'Review it', value: 'review', isDefault: true },
      { label: 'Summarise it first', value: 'summary' },
      back ? { label: 'Back to the list', value: 'back' } : { label: 'Cancel', value: 'cancel' },
    ], back ? 'back' : 'cancel');
    if (first === 'back') return 'back';
    if (first === 'cancel') return 'done';
    if (first === 'summary') {
      try {
        await summarize(url);
      } catch (error) {
        output.write(`${error.message}\n`);
      }
      const next = await choose(pick, `${name}: what next?`, [
        { label: 'Review it now', value: 'review', isDefault: true },
        back && { label: 'Back to the list', value: 'back' },
        (done || !back) && { label: 'Done', value: 'done' },
      ].filter(Boolean), back ? 'back' : 'done');
      if (next !== 'review') return next;
    }
  }
  await review(url, { full });
  return 'done';
}

// One summary of one PR, shown in the terminal. Not in a terminal, the
// summary also goes to stdout. Nothing is posted.
export async function summaryOne(url, options = {}) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const live = !options.progress && isLive();
  const reporter = options.progress ? toReporter(options.progress) : plainReporter();
  const router = live ? createRouter(reporter) : null;
  const adapters = createAdapters({ ...options, progress: router ?? reporter });
  const started = Date.now();
  // The bell (src/bell.mjs) when it's done or failed, in a terminal only.
  const bell = () => options.interactive && (options.ring ?? ring)({ started, configPath: options.configPath });
  const result = await runSummary(url, { root: options.outputRoot ?? join(projectRoot, 'reviews'), adapters, progress: reporter, live, router })
    .catch((error) => { bell(); throw error; });
  const output = options.menuOutput ?? process.stderr;
  const c = palette(!process.env.NO_COLOR && output.isTTY);
  const { owner, repo, number } = result.pr;
  const head = `── Summary · ${owner}/${repo}#${number}${result.title ? ` · ${result.title}` : ''} `;
  const width = Math.min(output.columns || 80, 100);
  output.write(['', c.dim(`${head}${'─'.repeat(Math.max(4, width - head.length))}`), '', ...renderSummary(result.summary, c), '',
    c.dim([`Saved in ${relative(process.cwd(), result.path)}`, costTotal(result.usage)].filter(Boolean).join(' · ')), c.dim('Nothing was posted to GitHub.'), ''].join('\n') + '\n');
  if (!options.interactive && !process.stdout.isTTY) process.stdout.write(`${result.summary}\n`);
  bell();
  return result;
}

// One review of one PR: run the pipeline, show the summary, then offer to
// post (interactive) or print the digest. Used for a single PR and by the
// interactive watch, which returns to its picker afterwards.
export async function reviewOne(url, options = {}) {
  const { interactive } = options;
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  // In a terminal the run renders through listr2; the adapters' progress lines
  // are routed to the running step. Otherwise plain "[progress]" lines.
  const live = !options.progress && isLive();
  const reporter = options.progress ? toReporter(options.progress) : plainReporter();
  const router = live ? createRouter(reporter) : null;
  const adapters = createAdapters({ ...options, progress: router ?? reporter });
  const started = Date.now();
  // The bell (src/bell.mjs) when it's done or failed, in a terminal only.
  const bell = () => interactive && (options.ring ?? ring)({ started, configPath: options.configPath });
  const result = await runPipeline(url, {
    root: options.outputRoot ?? join(projectRoot, 'reviews'),
    adapters,
    progress: reporter,
    live,
    router,
    full: Boolean(options.full),
  }).catch((error) => { bell(); throw error; });
  // In the interactive screen the cost table sits above the first question instead.
  printSummary(result, process.stderr, { cost: !(interactive || options.publish) });
  if (interactive || options.publish) {
    bell();
    await (options.publish ?? publishInTerminal)(result, { adapters });
    return;
  }
  process.stderr.write('Nothing was posted to GitHub: posting needs an interactive terminal.\n');
  if (!process.stdout.isTTY) process.stdout.write(`${result.digest.trim()}\n`);
}

// Runs main only when this file is the program, also when started through a
// symlink (e.g. ~/.local/bin/reviewpr): Node gives import.meta.url the real
// path but leaves argv[1] as the link, so compare real paths.
const isEntry = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (isEntry) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
