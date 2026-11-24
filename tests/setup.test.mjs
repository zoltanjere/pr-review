import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from '../src/adapters.mjs';
import { unavailable } from '../src/settings.mjs';
import { checkProvider, setupHint } from '../src/setup.mjs';

test('a missing program says what it is and how to install it; providers point to Settings', () => {
  const missing = { code: 'ENOENT', message: 'spawn claude ENOENT' };
  assert.equal(setupHint('claude', missing), 'Claude Code (claude) isn\'t installed, or isn\'t on your PATH. Install it: see https://docs.claude.com/en/docs/claude-code/setup, or choose the other provider with: reviewpr settings.');
  assert.match(setupHint('copilot', missing), /^The Copilot CLI \(copilot\) isn't installed.*winget install GitHub\.Copilot, or choose the other provider/);
  assert.match(setupHint('gh', missing), /^The GitHub CLI \(gh\) isn't installed.*winget install GitHub\.cli\.$/);
  assert.equal(setupHint('az', missing), null);
});

test('a missing sign-in says which command signs in', () => {
  assert.equal(setupHint('claude', { code: 1, message: 'Not logged in · Please run /login' }), 'Claude Code (claude) isn\'t signed in. Run: claude auth login, or choose the other provider with: reviewpr settings.');
  assert.match(setupHint('gh', { code: 1, message: 'To get started with GitHub CLI, please run:  gh auth login' }), /Run: gh auth login\.$/);
  assert.match(setupHint('copilot', { code: 1, message: 'Error: not authenticated' }), /Run: copilot login, or choose/);
  assert.equal(setupHint('gh', { code: 1, message: 'HTTP 404: Not Found' }), null);
});

test('runCommand turns a missing program into the hint, with the raw error after it', async () => {
  for (const command of ['gh', 'claude']) {
    const error = await runCommand(command, ['--version'], { env: { PATH: '' } }).catch((caught) => caught);
    assert.equal(error.code, 'ENOENT');
    assert.match(error.message, new RegExp(`isn't installed, or isn't on your PATH[\\s\\S]*\\(${command} failed: spawn ${command} ENOENT`));
  }
});

test('before a run, the provider CLI must answer and Claude Code must be signed in', async () => {
  const calls = [];
  const ok = async (command, args) => { calls.push([command, ...args].join(' ')); return ''; };
  await checkProvider('copilot', ok);
  await checkProvider('claude', ok);
  assert.deepEqual(calls, ['copilot --version', 'claude --version', 'claude auth status']);
  const signedOut = async (command, args) => { if (args[0] === 'auth') throw Object.assign(new Error('exit 1'), { code: 1 }); return ''; };
  await assert.rejects(checkProvider('claude', signedOut), /Claude Code \(claude\) isn't signed in\. Run: claude auth login, or choose the other provider/);
  const missing = async () => { throw Object.assign(new Error('not installed'), { code: 'ENOENT' }); };
  await assert.rejects(checkProvider('claude', missing), /not installed/);
});

test('Settings: a missing CLI, or Claude Code on Windows, can\'t be chosen', async () => {
  const execute = async (command) => { if (command === 'claude') throw new Error('missing'); return ''; };
  assert.deepEqual(await unavailable({ execute, platform: 'darwin' }), { copilot: null, claude: 'claude not found' });
  assert.deepEqual(await unavailable({ execute: async () => '', platform: 'win32' }), { copilot: null, claude: 'not supported on Windows yet' });
});
