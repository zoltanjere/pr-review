import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdapters, readConfig } from './adapters.mjs';
import { isSkipped, loadJson, loadState, saveJson } from './picker-state.mjs';
import { age, choosePr, scanRepo } from './select.mjs';
import { WATCH_EVENTS, departed, notify as showNotification, watchConfig, watchEvents } from './watch.mjs';

// Running watch: one poll (shared by the launchd mode and the interactive
// app), the lock that stops both from notifying twice, the log, and the
// launchd agent install. Reads GitHub only; writes only under state/ and,
// on --install, one file in ~/Library/LaunchAgents.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PATHS = {
  memory: join(ROOT, 'state', 'watch.json'),
  picker: join(ROOT, 'state', 'picker.json'),
  lock: join(ROOT, 'state', 'watch.lock'),
  log: join(ROOT, 'state', 'watch.log'),
  script: join(ROOT, 'src', 'review.mjs'),
};
const MEMORY_FIELDS = ['primed', 'open'];
export const LOCK_STALE_MS = 15 * 60_000;
const LOG_MAX = 256 * 1024;
export const AGENT_LABEL = 'local.reviewpr.watch';

// One poll: scan, look up PRs that left the open list (only with a merge event
// on), decide the notifications, remember, then show them. The memory is saved
// before notifying, so a failed notification never repeats on the next poll.
export async function pollOnce(repo, adapters, { events, paths = PATHS, notify = showNotification, now = Date.now(), seenAt = null, status = () => {} } = {}) {
  const memory = loadJson(paths.memory, MEMORY_FIELDS);
  const skips = loadState(paths.picker).skipped;
  const scan = await scanRepo(repo, adapters, { now, seenAt, status });
  const outcomes = {};
  if (events.includes('merged') || events.includes('merged-reviewed')) {
    for (const number of departed(memory, repo, scan.all)) {
      status(`checking what happened to #${number}`);
      try { outcomes[number] = await adapters.prOutcome(repo, number); } catch { /* retried next poll */ }
    }
  }
  const result = watchEvents({ repo, scan, memory, events, outcomes, now, skipped: (pr) => isSkipped(repo, pr, skips) });
  saveJson(paths.memory, MEMORY_FIELDS, result.memory);
  const failed = [];
  const fallbacks = [];
  for (const notification of result.notifications) {
    try {
      const used = await notify(notification);
      // Shown, but by the fallback: log why, so a blocked terminal-notifier is visible.
      if (typeof used === 'string' && used.includes('failed')) fallbacks.push(`${notification.text}: shown via ${used}`);
    } catch (error) { failed.push(`${notification.text}: ${error.message}`); }
  }
  return { scan, notifications: result.notifications, failed, fallbacks };
}

// The lock an open interactive watch holds: { pid, beat }. Live while that
// process exists and its heartbeat is recent; otherwise stale.
export function lockState(path, { now = Date.now(), alive = processAlive } = {}) {
  let lock;
  try { lock = JSON.parse(readFileSync(path, 'utf8')); } catch { return 'none'; }
  const fresh = Number.isFinite(lock?.beat) && now - lock.beat < LOCK_STALE_MS;
  return fresh && alive(lock.pid) ? 'live' : 'stale';
}

export function writeLock(path, { now = Date.now(), pid = process.pid } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ pid, beat: now })}\n`, { mode: 0o600 });
}

export function removeLock(path, { pid = process.pid } = {}) {
  try {
    if (JSON.parse(readFileSync(path, 'utf8'))?.pid === pid) rmSync(path);
  } catch { /* already gone */ }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// One timestamped line in state/watch.log; the oldest half is dropped past 256 KB.
export function log(path, line, { now = Date.now() } = {}) {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (statSync(path, { throwIfNoEntry: false })?.size > LOG_MAX) {
      const text = readFileSync(path, 'utf8');
      writeFileSync(path, text.slice(text.indexOf('\n', text.length / 2) + 1), { mode: 0o600 });
    }
    appendFileSync(path, `${new Date(now).toISOString()} ${line}\n`, { mode: 0o600 });
  } catch { /* the log is a convenience */ }
}

// `reviewpr watch --once`, what launchd runs: skip while an interactive watch
// holds a live lock, otherwise poll once and log what was sent.
export async function runOnce(repo, adapters, { events, paths = PATHS, notify, now = Date.now(), alive } = {}) {
  if (lockState(paths.lock, { now, alive }) === 'live') {
    log(paths.log, 'skipped: an interactive watch is running', { now });
    return { skipped: true, notifications: [] };
  }
  try {
    const result = await pollOnce(repo, adapters, { events, paths, notify, now });
    log(paths.log, `${repo}: ${result.notifications.length} notification${result.notifications.length === 1 ? '' : 's'}${result.notifications.map((n) => ` | ${n.text}`).join('')}`, { now });
    for (const failure of result.failed) log(paths.log, `notification failed: ${failure}`, { now });
    for (const note of result.fallbacks ?? []) log(paths.log, `notification ${note}`, { now });
    return { skipped: false, notifications: result.notifications };
  } catch (error) {
    log(paths.log, `poll failed: ${error.message}`, { now });
    throw error;
  }
}

// The launchd agent: runs `node src/review.mjs watch --once` every interval,
// with the Node binary and PATH of the shell that installed it, so gh and
// terminal-notifier are found. Output goes to state/watch.log.
const xml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function agentPlist({ node, script, intervalMinutes, logPath, path }) {
  const strings = (items) => items.map((item) => `    <string>${xml(item)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings([node, script, 'watch', '--once'])}
  </array>
  <key>StartInterval</key>
  <integer>${Math.round(intervalMinutes * 60)}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(path)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

const run = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: 15_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});
const agentFile = (dir) => join(dir, `${AGENT_LABEL}.plist`);
const domain = () => `gui/${process.getuid()}`;

export async function installAgent({ intervalMinutes, dir = join(homedir(), 'Library', 'LaunchAgents'), paths = PATHS, node = process.execPath, path = process.env.PATH ?? '', exec = run } = {}) {
  const file = agentFile(dir);
  mkdirSync(dir, { recursive: true });
  mkdirSync(dirname(paths.log), { recursive: true, mode: 0o700 });
  writeFileSync(file, agentPlist({ node, script: paths.script, intervalMinutes, logPath: paths.log, path }), { mode: 0o644 });
  await exec('launchctl', ['bootout', `${domain()}/${AGENT_LABEL}`]).catch(() => {}); // not loaded yet: fine
  await exec('launchctl', ['bootstrap', domain(), file]);
  return file;
}

export async function uninstallAgent({ dir = join(homedir(), 'Library', 'LaunchAgents'), exec = run } = {}) {
  const file = agentFile(dir);
  await exec('launchctl', ['bootout', `${domain()}/${AGENT_LABEL}`]).catch(() => {});
  const existed = statSync(file, { throwIfNoEntry: false }) !== undefined;
  rmSync(file, { force: true });
  return { file, existed };
}

// Sends a test notification and says what the user will get, so a Mac that
// blocks terminal-notifier is found at install, not by missed notifications.
export async function notificationMode(repo, notify) {
  const test = { repo, number: 0, title: 'Test notification', url: `https://github.com/${repo}/pulls`, events: [], text: '✓ watch is set up' };
  let used;
  try { used = await notify(test); } catch (error) {
    return `Notifications: not working (${error.message}). Check System Settings → Notifications and Focus.`;
  }
  if (used === 'terminal-notifier') return 'Notifications: clickable, opening the PR. A test notification was just sent.';
  if (used === 'osascript') return 'Notifications: plain, clicking won\'t open the PR. For clickable ones: brew install terminal-notifier, then reviewpr watch --install again.';
  return 'Notifications: plain, clicking won\'t open the PR (macOS blocks terminal-notifier on this Mac). A test notification was just sent.';
}

// `reviewpr watch [--once | --install | --uninstall]`. Without a flag it opens
// the interactive app (mode B). `options` lets tests inject everything.
export const WATCH_USAGE = 'Usage: reviewpr watch [--once | --install | --uninstall]';
export async function watchCommand(args, options = {}) {
  const output = options.output ?? process.stderr;
  const modes = ['--once', '--install', '--uninstall'];
  const unknown = args.filter((arg) => !modes.includes(arg));
  const chosen = args.filter((arg) => modes.includes(arg));
  if (unknown.length || chosen.length > 1) throw new Error(WATCH_USAGE);
  const mode = chosen[0] ?? 'app';
  if (mode === '--uninstall') {
    const { file, existed } = await uninstallAgent({ dir: options.agentDir, exec: options.exec });
    output.write(existed ? `Removed the background watch (${file}).\n` : 'The background watch was not installed.\n');
    return;
  }
  const config = await readConfig(options.configPath);
  if (!config.defaultRepository) throw new Error('Set "defaultRepository": "owner/repo" in config.json for watch to know which repository to check.');
  const { events, intervalMinutes } = watchConfig(config);
  const paths = options.paths ?? PATHS;
  if (mode === '--install') {
    const file = await installAgent({ intervalMinutes, dir: options.agentDir, paths, exec: options.exec, node: options.node, path: options.path });
    output.write(`Background watch installed: checks ${config.defaultRepository} every ${intervalMinutes} min for ${events.length === WATCH_EVENTS.length ? 'all events' : events.join(', ')}.\n`
      + `  Agent: ${file}\n  Log:   ${paths.log}\n`
      + '  After changing "watch" in config.json, run reviewpr watch --install again. Remove it with reviewpr watch --uninstall.\n');
    output.write(`  ${await notificationMode(config.defaultRepository, options.notify ?? showNotification)}\n`);
    return;
  }
  const adapters = options.adapters ?? createAdapters({ ...options, progress: () => {} });
  if (mode === '--once') {
    await runOnce(config.defaultRepository, adapters, { events, paths, notify: options.notify });
    return;
  }
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
  if (!interactive) throw new Error('The interactive watch needs a terminal. In the background, use reviewpr watch --install.');
  await runApp(config.defaultRepository, adapters, { events, intervalMinutes, paths, notify: options.notify, review: options.review, input: options.input, output: options.output });
}

// Events that never become picker rows: they show on the status line only.
const NOTICE_ONLY = new Set(['merged', 'merged-reviewed', 'my-pr-reviewed', 'my-pr-conflicts']);
const FAILURES_BEFORE_NOTICE = 3;

// `reviewpr watch`: the picker, kept open. It polls every interval (also
// during a review, then only as desktop notifications), refreshes the list in
// place, and Enter runs a review in this terminal and comes back here. Holds
// the lock so the launchd mode stays quiet meanwhile; q quits and frees it.
export async function runApp(repo, adapters, {
  events, intervalMinutes, paths = PATHS, notify = showNotification, review, input, output = process.stderr,
  now = () => Date.now(), pick = choosePr, alive, timers = { setInterval, clearInterval },
} = {}) {
  if (lockState(paths.lock, { now: now(), alive }) === 'live') throw new Error('Another reviewpr watch is already running in a terminal.');
  writeLock(paths.lock, { now: now() });
  const beat = timers.setInterval(() => writeLock(paths.lock, { now: now() }), 60_000);
  const marks = new Set();
  const notices = [];
  let listener = null;
  let checkedAt = null;
  let failures = 0;
  let lastError = null;
  let seenAt = null;
  let polling = null;
  let lastScan = null;
  const poll = (status = () => {}) => {
    polling ??= (async () => {
      try {
        const result = await pollOnce(repo, adapters, { events, paths, notify, now: now(), seenAt, status });
        checkedAt = now();
        lastScan = result.scan;
        failures = 0;
        lastError = null;
        for (const n of result.notifications) {
          if (n.events.every((event) => NOTICE_ONLY.has(event))) notices.unshift({ text: n.text, at: checkedAt });
          else marks.add(n.number);
        }
        notices.splice(3);
        for (const failure of result.failed) log(paths.log, `notification failed: ${failure}`, { now: checkedAt });
        for (const note of result.fallbacks ?? []) log(paths.log, `notification ${note}`, { now: checkedAt });
        listener?.(result.scan.list);
        return result;
      } catch (error) {
        failures++;
        lastError = error;
        log(paths.log, `poll failed: ${error.message}`, { now: now() });
        if (failures === FAILURES_BEFORE_NOTICE) {
          await notify({ repo, number: 0, title: error.message, url: `https://github.com/${repo}/pulls`, events: [], text: 'watch can\'t reach GitHub' }).catch(() => {});
        }
        listener?.(null);
        return null;
      } finally {
        polling = null;
      }
    })();
    return polling;
  };
  const status = () => [
    checkedAt ? `checked ${age(Math.max(0, now() - checkedAt))} ago` : null,
    lastError ? `⚠ check failed (${failures}×), retrying: ${lastError.message}` : null,
    ...notices.map((notice) => `${notice.text} · ${age(Math.max(0, now() - notice.at))} ago`),
  ].filter(Boolean).join(' · ');
  const timer = timers.setInterval(() => { poll(); }, intervalMinutes * 60_000);
  const watch = {
    marks,
    status,
    refresh: () => { poll(); },
    subscribe: (apply) => { listener = apply; return () => { if (listener === apply) listener = null; }; },
    scanner: async (report, options) => {
      seenAt = options.seenAt;
      // A failed check keeps the last list (the status line says so); only a
      // first load that fails stops the app.
      const result = await poll(report);
      if (!result && !lastScan) throw lastError;
      return result?.scan ?? lastScan;
    },
  };
  try {
    for (;;) {
      let full = false;
      const url = await pick(repo, adapters, { input, output, watch, statePath: paths.picker, onPick: (choice) => { full = Boolean(choice?.full); } });
      if (!url) break;
      try {
        await review(url, { full });
      } catch (error) {
        output.write(`${error.message}\n`);
      }
    }
  } finally {
    timers.clearInterval(timer);
    timers.clearInterval(beat);
    removeLock(paths.lock);
  }
}
