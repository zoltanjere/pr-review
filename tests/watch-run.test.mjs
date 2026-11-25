import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_LABEL, LOCK_STALE_MS, agentPlist, lockState, notificationMode, pollOnce, removeLock, runApp, runOnce, watchCommand, writeLock } from '../src/watch-run.mjs';

const REPO = 'acme/widget';
const NOW = Date.parse('2026-11-23T12:00:00Z');
const pr = (number, extra = {}) => ({
  number, title: `PR ${number}`, author: { login: 'alice' }, isDraft: false, headRefOid: 'a'.repeat(40),
  latestReviews: [], reviewRequests: [], createdAt: '2026-11-20T10:00:00Z', updatedAt: '2026-11-22T10:00:00Z', ...extra,
});

async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), 'watch-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return {
    dir,
    paths: { memory: join(dir, 'state', 'watch.json'), picker: join(dir, 'state', 'picker.json'), lock: join(dir, 'state', 'watch.lock'), log: join(dir, 'state', 'watch.log'), script: '/repo/src/review.mjs' },
  };
}

function adaptersFor(lists, { outcome } = {}) {
  const calls = [];
  let poll = 0;
  return {
    calls,
    viewer: async () => 'me',
    listOpenPrs: async () => { calls.push('list'); return lists[Math.min(poll++, lists.length - 1)]; },
    reviewCommit: async () => null,
    commitsSince: async () => null,
    prOutcome: async (repo, number) => { calls.push(`outcome #${number}`); return outcome?.(number); },
  };
}

test('one poll primes, then notifies a new PR once and saves the memory first', async (t) => {
  const { paths } = await folder(t);
  const adapters = adaptersFor([[pr(1)], [pr(1), pr(2)], [pr(1), pr(2)]]);
  const sent = [];
  const notify = async (n) => { sent.push(n.text); };
  for (let i = 0; i < 3; i++) await pollOnce(REPO, adapters, { events: ['new'], paths, notify, now: NOW });
  assert.deepEqual(sent, ['● #2 new PR from alice']);
  assert(JSON.parse(await readFile(paths.memory, 'utf8')).open[`${REPO}#2`]);
});

test('a failed notification is reported, not retried on the next poll', async (t) => {
  const { paths } = await folder(t);
  const adapters = adaptersFor([[pr(1)], [pr(1), pr(2)]]);
  await pollOnce(REPO, adapters, { events: ['new'], paths, notify: async () => {}, now: NOW });
  const result = await pollOnce(REPO, adapters, { events: ['new'], paths, notify: async () => { throw new Error('denied'); }, now: NOW });
  assert.deepEqual(result.failed, ['● #2 new PR from alice: denied']);
});

test('a notification shown by the fallback is reported apart from failures', async (t) => {
  const { paths } = await folder(t);
  const adapters = adaptersFor([[pr(1)], [pr(1), pr(2)]]);
  await pollOnce(REPO, adapters, { events: ['new'], paths, notify: async () => 'terminal-notifier', now: NOW });
  const result = await pollOnce(REPO, adapters, { events: ['new'], paths, notify: async () => 'osascript (terminal-notifier failed: allow it)', now: NOW });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.fallbacks, ['● #2 new PR from alice: shown via osascript (terminal-notifier failed: allow it)']);
});

test('outcomes of departed PRs are looked up only with a merge event on', async (t) => {
  const quiet = await folder(t);
  const off = adaptersFor([[pr(1)], []]);
  for (let i = 0; i < 2; i++) await pollOnce(REPO, off, { events: ['new'], paths: quiet.paths, notify: async () => {}, now: NOW });
  assert(!off.calls.some((call) => call.startsWith('outcome')));
  const merges = await folder(t);
  const on = adaptersFor([[pr(1)], []], { outcome: () => ({ state: 'MERGED', mergedBy: 'lee', title: 'PR 1', url: 'u' }) });
  const sent = [];
  for (let i = 0; i < 2; i++) await pollOnce(REPO, on, { events: ['merged'], paths: merges.paths, notify: async (n) => { sent.push(n.text); }, now: NOW });
  assert.deepEqual([on.calls.filter((call) => call.startsWith('outcome')), sent], [['outcome #1'], ['✔ #1 merged by lee']]);
});

test('the lock is live only while its process runs and its heartbeat is fresh', async (t) => {
  const { paths } = await folder(t);
  assert.equal(lockState(paths.lock, { now: NOW }), 'none');
  writeLock(paths.lock, { now: NOW, pid: 4242 });
  assert.equal(lockState(paths.lock, { now: NOW + 60_000, alive: () => true }), 'live');
  assert.equal(lockState(paths.lock, { now: NOW + LOCK_STALE_MS + 1, alive: () => true }), 'stale');
  assert.equal(lockState(paths.lock, { now: NOW, alive: () => false }), 'stale');
  removeLock(paths.lock, { pid: 1 });
  assert(existsSync(paths.lock), 'another process\'s lock is left alone');
  removeLock(paths.lock, { pid: 4242 });
  assert(!existsSync(paths.lock));
});

test('--once does nothing while an interactive watch holds a live lock, and runs when it is stale', async (t) => {
  const { paths } = await folder(t);
  const adapters = adaptersFor([[pr(1)]]);
  writeLock(paths.lock, { now: NOW, pid: 4242 });
  const skipped = await runOnce(REPO, adapters, { events: ['new'], paths, now: NOW, alive: () => true, notify: async () => {} });
  assert.equal(skipped.skipped, true);
  assert.deepEqual(adapters.calls, []);
  const ran = await runOnce(REPO, adapters, { events: ['new'], paths, now: NOW, alive: () => false, notify: async () => {} });
  assert.equal(ran.skipped, false);
  assert.match(await readFile(paths.log, 'utf8'), /skipped: an interactive watch is running\n.*acme\/widget: 0 notifications/);
});

test('the launchd agent runs watch --once with the installing Node, PATH and interval', () => {
  const plist = agentPlist({ node: '/n/v26/bin/node', script: '/repo/src/review.mjs', intervalMinutes: 5, logPath: '/repo/state/watch.log', path: '/opt/homebrew/bin:/usr/bin&x' });
  assert.match(plist, new RegExp(`<string>${AGENT_LABEL.replace(/\./g, '\\.')}</string>`));
  assert.match(plist, /<string>\/n\/v26\/bin\/node<\/string>\n {4}<string>\/repo\/src\/review\.mjs<\/string>\n {4}<string>watch<\/string>\n {4}<string>--once<\/string>/);
  assert.match(plist, /<key>StartInterval<\/key>\n {2}<integer>300<\/integer>/);
  assert.match(plist, /<string>\/opt\/homebrew\/bin:\/usr\/bin&amp;x<\/string>/);
  assert.match(plist, /<key>StandardErrorPath<\/key>\n {2}<string>\/repo\/state\/watch\.log<\/string>/);
});

test('watch --install writes and loads the agent from config; --uninstall removes it', async (t) => {
  const { dir, paths } = await folder(t);
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ model: 'm', defaultRepository: REPO, watch: { events: ['new', 'merged'], intervalMinutes: 3 } }));
  const calls = [];
  const exec = async (command, args) => { calls.push([command, ...args]); return ''; };
  let text = '';
  const output = { write: (chunk) => { text += chunk; } };
  const agentDir = join(dir, 'LaunchAgents');
  const sent = [];
  await watchCommand(['--install'], { configPath, paths, agentDir, exec, output, node: '/n/node', path: '/usr/bin', notify: async (n) => { sent.push(n.text); return 'osascript'; } });
  const plist = await readFile(join(agentDir, `${AGENT_LABEL}.plist`), 'utf8');
  assert.match(plist, /<integer>180<\/integer>/);
  assert.deepEqual(calls.map((call) => call.slice(0, 2)), [['launchctl', 'bootout'], ['launchctl', 'bootstrap']]);
  assert.deepEqual(sent, ['✓ watch is set up']);
  assert.match(text, /checks acme\/widget every 3 min for new, merged/);
  assert.match(text, /brew install terminal-notifier/);
  await watchCommand(['--uninstall'], { agentDir, exec, output });
  assert(!existsSync(join(agentDir, `${AGENT_LABEL}.plist`)));
  assert.match(text, /Removed the background watch/);
});

test('install reports the notification mode from a test notification', async () => {
  assert.match(await notificationMode(REPO, async () => 'terminal-notifier'), /clickable/);
  assert.match(await notificationMode(REPO, async () => 'osascript'), /plain.*brew install terminal-notifier/);
  assert.match(await notificationMode(REPO, async () => 'osascript (terminal-notifier failed: allow it)'), /plain.*macOS blocks terminal-notifier/);
  assert.match(await notificationMode(REPO, async () => { throw new Error('denied'); }), /not working \(denied\)/);
});

test('watch rejects unknown flags and bad event names before doing anything', async (t) => {
  const { dir } = await folder(t);
  await assert.rejects(watchCommand(['--forever']), /Usage: reviewpr watch/);
  await assert.rejects(watchCommand(['--once', '--install']), /Usage: reviewpr watch/);
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ model: 'm', defaultRepository: REPO, watch: { events: ['fixes'] } }));
  await assert.rejects(watchCommand(['--once'], { configPath, adapters: adaptersFor([[]]) }), /Unknown watch event "fixes"/);
});

// The interactive app, driven through the real picker with a fake terminal and timers.
function appTerminal() {
  const input = new EventEmitter();
  input.setRawMode = () => {};
  input.resume = () => {};
  input.pause = () => {};
  let text = '';
  const output = { rows: 30, columns: 100, isTTY: false, write: (chunk) => { text += chunk; } };
  const press = (key) => input.emit('keypress', key.length === 1 ? key : undefined, { name: key });
  return { input, output, press, text: () => text, clear: () => { text = ''; } };
}
const until = async (check) => {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert(check(), 'timed out waiting');
};

async function app(t, lists, { events = ['new', 'merged'], outcome, settings } = {}) {
  const { paths } = await folder(t);
  const adapters = { ...adaptersFor(lists, { outcome }), findClone: async () => {} };
  const term = appTerminal();
  const ticks = [];
  const timers = { setInterval: (fn, ms) => { ticks.push({ fn, ms }); return ticks.length; }, clearInterval: () => {} };
  const sent = [];
  const reviewed = [];
  const done = runApp(REPO, adapters, {
    events, intervalMinutes: 5, paths, timers, input: term.input, output: term.output, now: () => NOW,
    notify: async (n) => { sent.push(n.text); }, review: async (url) => { reviewed.push(url); }, settings,
  });
  const tick = () => ticks.find((timer) => timer.ms === 5 * 60_000).fn();
  return { paths, term, done, sent, reviewed, tick, adapters };
}

test('the app refreshes in place, marks a new PR until the cursor reaches it, and r checks now', async (t) => {
  const run = await app(t, [[pr(1)], [pr(1), pr(2, { updatedAt: '2026-11-23T11:00:00Z' })], [pr(1), pr(2, { updatedAt: '2026-11-23T11:00:00Z' })]]);
  await until(() => run.term.text().includes('#1'));
  assert(existsSync(run.paths.lock), 'the app holds the lock');
  run.tick();
  await until(() => run.term.text().includes('#2'));
  assert.deepEqual(run.sent, ['● #2 new PR from alice']);
  assert.match(run.term.text(), /#2 .*•$/m);
  assert.match(run.term.text(), /checked 1m ago/);
  // #1 stays highlighted after the refresh; moving onto #2 clears its mark.
  assert.match(run.term.text().split('acme/widget:').at(-1), /❯ · #1/);
  run.term.clear();
  run.term.press('up');
  await until(() => run.term.text().includes('❯ ↑ #2'));
  assert.doesNotMatch(run.term.text().split('acme/widget:').at(-1), /•/);
  run.term.press('r');
  await until(() => run.adapters.calls.filter((call) => call === 'list').length === 3);
  run.term.press('q');
  await run.done;
  assert(!existsSync(run.paths.lock), 'q frees the lock');
  assert.match(run.term.text(), /Watch stopped/);
});

test('Enter reviews in the same terminal and comes back to a fresh list; merges show on the status line', async (t) => {
  const outcome = () => ({ state: 'MERGED', mergedBy: 'lee', title: 'PR 1', url: 'u' });
  const run = await app(t, [[pr(1), pr(2)], [pr(2)]], { outcome });
  await until(() => run.term.text().includes('#2'));
  run.term.press('return');
  await until(() => run.reviewed.length === 1);
  await until(() => run.term.text().includes('✔ #1 merged by lee · 1m ago'));
  assert.deepEqual(run.sent, ['✔ #1 merged by lee']);
  assert.deepEqual(run.reviewed, ['https://github.com/acme/widget/pull/1']);
  run.term.press('q');
  await run.done;
});

test('a second app is refused while one holds a live lock; an empty list keeps the app open', async (t) => {
  const run = await app(t, [[]]);
  await until(() => run.term.text().includes('0 to review'));
  await assert.rejects(runApp(REPO, {}, { events: ['new'], intervalMinutes: 5, paths: run.paths, now: () => NOW }), /already running/);
  run.term.press('q');
  await run.done;
});

test('failed checks keep the app and its list open, and the third in a row notifies once', async (t) => {
  const run = await app(t, [[pr(1)]]);
  await until(() => run.term.text().includes('#1'));
  run.adapters.listOpenPrs = async () => { throw new Error('gh: offline'); };
  for (let i = 1; i <= 4; i++) {
    run.tick();
    await until(() => run.term.text().includes(`check failed (${i}×)`));
  }
  assert.deepEqual(run.sent, ['watch can\'t reach GitHub']);
  assert.match(run.term.text().split('acme/widget:').at(-1), /❯ · #1/);
  assert.match(await readFile(run.paths.log, 'utf8'), /poll failed: gh: offline/);
  run.term.press('q');
  await run.done;
});

test('c in the app opens Settings and comes back to the list with the new setting', async (t) => {
  let line = 'Provider: Copilot · Model: claude-haiku-5.5';
  let opened = 0;
  const settings = { line: async () => line, open: async () => { opened++; line = 'Provider: Claude Code · Model: claude-sonnet-5-5'; } };
  const run = await app(t, [[pr(1)], [pr(1)]], { settings });
  await until(() => run.term.text().includes('Provider: Copilot'));
  assert.match(run.term.text(), /c settings · q quit/);
  run.term.clear();
  run.term.press('c');
  await until(() => run.term.text().includes('Provider: Claude Code'));
  assert.equal(opened, 1);
  run.term.press('q');
  await run.done;
  assert.deepEqual(run.reviewed, []);
});

// Two repositories, each with its own open list per poll.
function twoRepos(lists, { failing = null } = {}) {
  const polls = {};
  return {
    viewer: async () => 'me',
    findClone: async () => {},
    listOpenPrs: async (repo) => {
      if (repo === failing) throw new Error('Could not resolve to a Repository');
      const i = polls[repo] = (polls[repo] ?? -1) + 1;
      return lists[repo][Math.min(i, lists[repo].length - 1)];
    },
    reviewCommit: async () => null,
    commitsSince: async () => null,
    prOutcome: async () => ({ state: 'MERGED', mergedBy: 'lee', title: 'PR', url: 'u' }),
  };
}

test('several repositories: each is primed and notifies on its own, and the log has a line per repository', async (t) => {
  const { paths } = await folder(t);
  const adapters = twoRepos({ 'acme/widget': [[pr(61)], [pr(61), pr(62)]], 'acme/gadget': [[], [pr(61)]] });
  const sent = [];
  const notify = async (n) => { sent.push(`${n.repo} ${n.text}`); };
  for (let i = 0; i < 2; i++) await runOnce(['acme/widget', 'acme/gadget'], adapters, { events: ['new'], paths, notify, now: NOW });
  assert.deepEqual(sent.sort(), ['acme/gadget ● #61 new PR from alice', 'acme/widget ● #62 new PR from alice']);
  const memory = JSON.parse(await readFile(paths.memory, 'utf8'));
  assert.deepEqual(Object.keys(memory.primed).sort(), ['acme/gadget', 'acme/widget']);
  assert.deepEqual(Object.keys(memory.open).sort(), ['acme/gadget#61', 'acme/widget#61', 'acme/widget#62']);
  const log = await readFile(paths.log, 'utf8');
  assert.match(log, /acme\/widget: 1 notification \| ● #62 new PR from alice/);
  assert.match(log, /acme\/gadget: 1 notification \| ● #61 new PR from alice/);
});

test('several repositories: one unreadable keeps its memory and is logged; the others still notify', async (t) => {
  const { paths } = await folder(t);
  const lists = { 'acme/widget': [[pr(1)], [pr(1), pr(2)]], 'acme/gadget': [[pr(5)], []] };
  await runOnce(['acme/widget', 'acme/gadget'], twoRepos(lists), { events: ['new'], paths, notify: async () => {}, now: NOW });
  const sent = [];
  await runOnce(['acme/widget', 'acme/gadget'], twoRepos(lists, { failing: 'acme/gadget' }), { events: ['new', 'merged'], paths, notify: async (n) => { sent.push(n.text); }, now: NOW });
  assert.deepEqual(sent, []); // widget's list on a fresh adapter is its first one again: nothing new
  const memory = JSON.parse(await readFile(paths.memory, 'utf8'));
  assert(memory.open['acme/gadget#5'], 'gadget #5 is not taken for merged while gadget is unreadable');
  assert.match(await readFile(paths.log, 'utf8'), /poll failed: acme\/gadget: Could not resolve to a Repository/);
  // None readable: the poll fails as with one repository.
  await assert.rejects(runOnce(['acme/gadget'], twoRepos(lists, { failing: 'acme/gadget' }), { events: ['new'], paths, notify: async () => {}, now: NOW }), /Could not resolve/);
});

test('watch reads "repositories" and says which it checks on install', async (t) => {
  const { dir, paths } = await folder(t);
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ model: 'm', repositories: ['acme/widget', 'acme/gadget'] }));
  let text = '';
  await watchCommand(['--install'], { configPath, paths, agentDir: join(dir, 'LaunchAgents'), exec: async () => '', output: { write: (chunk) => { text += chunk; } }, node: '/n/node', path: '/usr/bin', notify: async () => 'terminal-notifier' });
  assert.match(text, /checks acme\/widget, acme\/gadget every 5 min/);
  assert.match(text, /again after changing intervalMinutes or Node/);
  await writeFile(configPath, JSON.stringify({ model: 'm' }));
  await assert.rejects(watchCommand(['--once'], { configPath, paths }), /Set "repositories"/);
});

test('the app over several repositories: one list with a repository column, marks by repository, labelled notices', async (t) => {
  const { paths } = await folder(t);
  const adapters = twoRepos({
    'acme/widget': [[pr(61), pr(9)], [pr(61)]],
    'acme/gadget': [[pr(9)], [pr(9), pr(61, { updatedAt: '2026-11-23T11:00:00Z' })]],
  });
  const term = appTerminal();
  const ticks = [];
  const timers = { setInterval: (fn, ms) => { ticks.push({ fn, ms }); return ticks.length; }, clearInterval: () => {} };
  const reviewed = [];
  const done = runApp(['acme/widget', 'acme/gadget'], adapters, {
    events: ['new', 'merged'], intervalMinutes: 5, paths, timers, input: term.input, output: term.output, now: () => NOW,
    notify: async () => {}, review: async (url) => { reviewed.push(url); },
  });
  await until(() => term.text().includes('2 repositories: 3 to review'));
  assert.match(term.text(), /widget  #61/);
  assert.match(term.text(), /gadget  #9 /);
  ticks.find((timer) => timer.ms === 5 * 60_000).fn();
  // gadget #61 is new and marked; widget #61 isn't; widget #9 merged shows labelled.
  await until(() => term.text().includes('widget: ✔ #9 merged by lee'));
  const last = term.text().split('2 repositories:').at(-1);
  assert.match(last, /gadget  #61 .*•$/m);
  assert.doesNotMatch(last, /widget  #61 .*•/);
  term.press('q');
  await done;
});
