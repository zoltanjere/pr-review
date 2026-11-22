import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The project runs on the Node version pinned in .nvmrc, without changing the
// shell's or the system's Node: when the CLI is started with an older Node, it
// restarts itself on the pinned version from nvm's install folder. Only the
// CLI entry point does this; tests and imports are left alone.

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Decides what to do for a given Node version. Pure, so it can be tested.
export function nodePlan({ current, pinned, nvmDir, exists = existsSync, restarted = false }) {
  const major = (version) => Number(String(version).replace(/^v/, '').split('.')[0]);
  if (major(current) >= major(pinned)) return { action: 'run' };
  const binary = join(nvmDir, 'versions', 'node', pinned.startsWith('v') ? pinned : `v${pinned}`, 'bin', 'node');
  if (!restarted && exists(binary)) return { action: 'restart', binary };
  return {
    action: 'fail',
    message: `pr-review needs Node ${pinned.replace(/^v/, '')} (pinned in .nvmrc); this is ${current}.\n`
      + `Install it once with: nvm install ${pinned}\n`
      + 'After that, the script switches to it by itself, for this project only.',
  };
}

// Called first thing by the CLI entry point. Returns only when this Node is fine.
export function ensureProjectNode() {
  let pinned;
  try {
    pinned = readFileSync(join(projectRoot, '.nvmrc'), 'utf8').trim();
  } catch {
    return;
  }
  const plan = nodePlan({
    current: process.version,
    pinned,
    nvmDir: process.env.NVM_DIR || join(homedir(), '.nvm'),
    restarted: process.env.PR_REVIEW_NODE_RESTARTED === '1',
  });
  if (plan.action === 'run') return;
  if (plan.action === 'fail') {
    console.error(plan.message);
    process.exit(1);
  }
  const child = spawnSync(plan.binary, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, PR_REVIEW_NODE_RESTARTED: '1' },
  });
  if (child.error) {
    console.error(`Could not start ${plan.binary}: ${child.error.message}`);
    process.exit(1);
  }
  process.exit(child.status ?? 1);
}

// Runs on import, before the CLI's other modules load, but only when
// src/review.mjs is the program being run (directly, via npm or a symlink).
const entry = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(join(projectRoot, 'src', 'review.mjs'));
  } catch {
    return false;
  }
})();
if (entry) ensureProjectNode();
