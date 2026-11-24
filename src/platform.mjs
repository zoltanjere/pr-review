import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

// How to start a program. Elsewhere than Windows, and for real .exe files on
// Windows, nothing changes. Node can't start a .cmd shim without a shell, and
// a shell isn't safe for our multi-line prompts, so an npm-installed copilot
// runs its loader through this Node instead; any other .cmd (such as az) runs
// through the shell only when every argument is plain.

const SAFE_ARG = /^[\w.:/@=#-]+$/;
const COPILOT_LOADER = ['node_modules', '@github', 'copilot', 'npm-loader.js'];

function findOnPath(name, env, exists) {
  const dirs = String(env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  for (const ext of ['.exe', '.com']) {
    if (dirs.some((dir) => exists(win32.join(dir, name + ext)))) return { kind: 'exe' };
  }
  const dir = dirs.find((d) => exists(win32.join(d, `${name}.cmd`)));
  return dir ? { kind: 'cmd', dir } : null;
}

export function resolveCommand(name, args, { platform = process.platform, env = process.env, exists = existsSync, execPath = process.execPath, cache } = {}) {
  if (platform !== 'win32') return { command: name, args, shell: false };
  const found = cache?.has(name) ? cache.get(name) : findOnPath(name, env, exists);
  cache?.set(name, found);
  if (found?.kind !== 'cmd') return { command: name, args, shell: false };
  if (name === 'copilot') {
    const loader = win32.join(found.dir, ...COPILOT_LOADER);
    if (!exists(loader)) throw new Error('Found copilot.cmd but not its npm package; install Copilot with: winget install GitHub.Copilot');
    return { command: execPath, args: [loader, ...args], shell: false };
  }
  if (!args.every((arg) => SAFE_ARG.test(String(arg)))) {
    throw new Error(`${name}.cmd needs a shell, and these arguments aren't safe to pass through one`);
  }
  // One command string: Node deprecates an args list together with a shell.
  return { command: [name, ...args].join(' '), args: [], shell: true };
}

const resolved = new Map();
// The same, cached for the life of the process.
export const startCommand = (name, args) => resolveCommand(name, args, { cache: resolved });
