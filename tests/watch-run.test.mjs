import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_LABEL, LOCK_STALE_MS, agentPlist, lockState, pollOnce, removeLock, runOnce, watchCommand, writeLock } from '../src/watch-run.mjs';

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
  const exec = async (command, args) => { calls.push([command, ...args]); if (command === '/usr/bin/which') throw new Error('not found'); return ''; };
  let text = '';
  const output = { write: (chunk) => { text += chunk; } };
  const agentDir = join(dir, 'LaunchAgents');
  await watchCommand(['--install'], { configPath, paths, agentDir, exec, output, node: '/n/node', path: '/usr/bin' });
  const plist = await readFile(join(agentDir, `${AGENT_LABEL}.plist`), 'utf8');
  assert.match(plist, /<integer>180<\/integer>/);
  assert.deepEqual(calls.map((call) => call.slice(0, 2)), [['launchctl', 'bootout'], ['launchctl', 'bootstrap'], ['/usr/bin/which', 'terminal-notifier']]);
  assert.match(text, /checks acme\/widget every 3 min for new, merged/);
  assert.match(text, /brew install terminal-notifier/);
  await watchCommand(['--uninstall'], { agentDir, exec, output });
  assert(!existsSync(join(agentDir, `${AGENT_LABEL}.plist`)));
  assert.match(text, /Removed the background watch/);
});

test('watch rejects unknown flags and bad event names before doing anything', async (t) => {
  const { dir } = await folder(t);
  await assert.rejects(watchCommand(['--forever']), /Usage: reviewpr watch/);
  await assert.rejects(watchCommand(['--once', '--install']), /Usage: reviewpr watch/);
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ model: 'm', defaultRepository: REPO, watch: { events: ['fixes'] } }));
  await assert.rejects(watchCommand(['--once'], { configPath, adapters: adaptersFor([[]]) }), /Unknown watch event "fixes"/);
});
