#!/usr/bin/env node
// First: switch to the project's pinned Node if this one is older (.nvmrc).
import './node-version.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createAdapters, readConfig, REVIEWERS } from './adapters.mjs';
import { choosePr } from './select.mjs';
import { plainReporter, toReporter } from './ui.mjs';
import { createRouter, isLive, runSteps } from './steps.mjs';
import { printSummary } from './confirm.mjs';
import { publishInTerminal } from './publish.mjs';

const STAGES = [...REVIEWERS, 'verified', 'digest'].join('|');

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

const words = (text) => String(text).split(/\s+/).filter(Boolean).length;

// Runs the review and saves every stage, the digest included. Posting is a
// separate, interactive step (src/publish.mjs) that works on the result.
// The phases are declared as steps (src/steps.mjs): listr2 in a terminal
// (`live`), "[progress]" lines otherwise. `router` sends the adapters' own
// progress lines to the step that is running.
export async function runPipeline(url, { root, adapters, progress, now = new Date(), live = false, router }) {
  const reporter = toReporter(progress);
  const pr = parsePrUrl(url);
  const date = now;
  const day = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  const directory = join(root, day, `${pr.repo}-PR${pr.number}`);
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
  const reviews = {};
  const failures = [];
  try {
    await runSteps([
      {
        title: `Preparing ${pr.owner}/${pr.repo}#${pr.number}`, section: true,
        run: async (ui) => {
          use(ui);
          checkout = await adapters.prepare(pr);
          reservation = await reserveRun(directory, date);
        },
      },
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
            digest = await adapters.digest(verified.markdown, verified.findings);
            await save('digest', digest);
            return detail(`${words(digest.split(/<details\b/i)[0])} visible words`, 'review-digest');
          },
        }],
      },
    ], options);
  } catch (error) {
    reviewError = failures.length ? new Error(failures.join('\n'), { cause: error }) : error;
  } finally {
    router?.route(null);
  }
  const cleanupErrors = [];
  if (checkout) {
    try {
      await runSteps([{ title: 'removing temporary checkout', run: () => checkout.cleanup() }], options);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (reservation) {
    try {
      await unlink(reservation.lock);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length) {
    const errors = reviewError ? [reviewError, ...cleanupErrors] : cleanupErrors;
    throw new AggregateError(errors, `${reviewError ? `${reviewError.message}; ` : ''}cleanup failed: ${cleanupErrors.map((error) => error.message).join('; ')}`);
  }
  if (reviewError) throw reviewError;
  return {
    pr, directory, saved, digest, digestPath: saved.at(-1), head: checkout.head,
    title: checkout.title, model: checkout.model, checkModel: checkout.checkModel,
    findings: verified.findings, usage: adapters.usage?.() ?? [],
  };
}

export async function main(args, options = {}) {
  const flags = args.filter((arg) => arg.startsWith('-'));
  const urls = args.filter((arg) => !arg.startsWith('-'));
  const unknown = flags.filter((flag) => !['-y', '--yes'].includes(flag));
  if (urls.length > 1 || unknown.length) throw new Error('Usage: node src/review.mjs [--yes] [<GitHub PR URL>]');
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const interactive = options.interactive ?? Boolean(!flags.length && process.stdin.isTTY && process.stderr.isTTY);
  let url = urls[0];
  if (url) parsePrUrl(url);
  else {
    // No URL: pick one of the default repository's PRs that still need review.
    if (!interactive) throw new Error('Pass a PR URL, or run in a terminal without --yes to pick one from defaultRepository.');
    const config = await readConfig(options.configPath);
    if (!config.defaultRepository) throw new Error('Pass a PR URL, or set "defaultRepository": "owner/repo" in config.json to pick from its open PRs.');
    url = await (options.pick ?? choosePr)(config.defaultRepository, createAdapters({ ...options, progress: () => {} }));
    if (!url) return;
  }
  // In a terminal the run renders through listr2; the adapters' progress lines
  // are routed to the running step. Otherwise plain "[progress]" lines.
  const live = !options.progress && isLive();
  const reporter = options.progress ? toReporter(options.progress) : plainReporter();
  const router = live ? createRouter(reporter) : null;
  const adapters = createAdapters({ ...options, progress: router ?? reporter });
  const result = await runPipeline(url, {
    root: options.outputRoot ?? join(projectRoot, 'reviews'),
    adapters,
    progress: reporter,
    live,
    router,
  });
  // In the interactive screen the cost table sits above the first question instead.
  printSummary(result, process.stderr, { cost: !(interactive || options.publish) });
  if (interactive || options.publish) {
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
