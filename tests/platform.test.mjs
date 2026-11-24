import { test } from 'node:test';
import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import { resolveCommand } from '../src/platform.mjs';

const NPM = 'C:\\Users\\me\\AppData\\Roaming\\npm';
const GIT = 'C:\\Program Files\\Git\\cmd';
const AZ = 'C:\\Program Files\\Azure\\CLI2\\wbin';
const env = { PATH: [GIT, NPM, AZ].join(';') };
const files = (...paths) => (path) => paths.includes(path);
const windows = (exists, extra = {}) => ({ platform: 'win32', env, exists, execPath: 'C:\\node\\node.exe', ...extra });
const PROMPT = 'Review "this"\nand that & more';

test('outside Windows, every command starts as it is', () => {
  assert.deepEqual(resolveCommand('copilot', ['--prompt', PROMPT], { platform: 'darwin', exists: () => true }),
    { command: 'copilot', args: ['--prompt', PROMPT], shell: false });
});

test('on Windows, a real .exe starts as it is', () => {
  const result = resolveCommand('git', ['status'], windows(files(win32.join(GIT, 'git.exe'))));
  assert.deepEqual(result, { command: 'git', args: ['status'], shell: false });
});

test('on Windows, an .exe wins over a .cmd of the same name', () => {
  const result = resolveCommand('copilot', ['-p', PROMPT], windows(files(win32.join(NPM, 'copilot.cmd'), win32.join(AZ, 'copilot.exe'))));
  assert.deepEqual(result, { command: 'copilot', args: ['-p', PROMPT], shell: false });
});

test('an npm-installed copilot runs its loader through Node, with no shell and the args untouched', () => {
  const loader = win32.join(NPM, 'node_modules', '@github', 'copilot', 'npm-loader.js');
  const result = resolveCommand('copilot', ['--prompt', PROMPT], windows(files(win32.join(NPM, 'copilot.cmd'), loader)));
  assert.deepEqual(result, { command: 'C:\\node\\node.exe', args: [loader, '--prompt', PROMPT], shell: false });
});

test('copilot.cmd without its npm package points to winget', () => {
  assert.throws(() => resolveCommand('copilot', [], windows(files(win32.join(NPM, 'copilot.cmd')))), /winget install GitHub\.Copilot/);
});

test('another .cmd runs through the shell as one command, only with plain arguments', () => {
  const exists = files(win32.join(AZ, 'az.cmd'));
  const args = ['boards', 'work-item', 'show', '--id', '123', '--org', 'https://dev.azure.com/acme', '--output', 'json'];
  assert.deepEqual(resolveCommand('az', args, windows(exists)),
    { command: `az ${args.join(' ')}`, args: [], shell: true });
  assert.throws(() => resolveCommand('az', ['--org', 'https://dev.azure.com/a&calc'], windows(exists)), /aren't safe/);
});

test('a command that is not on PATH keeps its name, so the error stays the usual one', () => {
  assert.deepEqual(resolveCommand('gh', ['api'], windows(() => false)), { command: 'gh', args: ['api'], shell: false });
});

test('the PATH lookup is cached per name', () => {
  const cache = new Map();
  let lookups = 0;
  const exists = (path) => { lookups += 1; return path === win32.join(GIT, 'git.exe'); };
  resolveCommand('git', [], windows(exists, { cache }));
  const first = lookups;
  resolveCommand('git', ['log'], windows(exists, { cache }));
  assert.equal(lookups, first);
});
