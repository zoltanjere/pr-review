import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bellEnabled, QUICK_MS, ring } from '../src/bell.mjs';

const terminal = () => { const out = { isTTY: true, text: '', write(chunk) { this.text += chunk; } }; return out; };

test('the bell rings once in a terminal after a long run, unless notify is false', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'bell-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ model: 'm' }));
  const out = terminal();
  assert.equal(ring({ started: 0, now: QUICK_MS, output: out, configPath }), true);
  assert.equal(out.text, '\x07');
  assert.equal(ring({ started: 0, now: QUICK_MS - 1, output: terminal(), configPath }), false, 'a quick run was watched');
  assert.equal(ring({ started: 0, now: QUICK_MS, output: { isTTY: false, write() { throw new Error('not a terminal'); } }, configPath }), false);
  assert.equal(ring({ started: 0, now: QUICK_MS, output: { isTTY: true, write() { throw new Error('closed'); } }, configPath }), false, 'a failed write never breaks the run');
  await writeFile(configPath, JSON.stringify({ model: 'm', notify: false }));
  assert.equal(ring({ started: 0, now: QUICK_MS, output: terminal(), configPath }), false);
  assert.equal(bellEnabled(join(dir, 'missing.json')), true);
});
