import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The terminal bell when a review or summary is done or failed, so you can
// work elsewhere meanwhile (plans/run-notification.md). One BEL character:
// the terminal decides what it shows (a dock bounce or badge on macOS, a
// flashing taskbar button in Windows Terminal). Nothing is installed or
// spawned, so it works the same everywhere and can't break a run.

// A run shorter than this was probably watched: no bell.
export const QUICK_MS = 30_000;

const CONFIG = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'config.json');

// "notify": false in config.json turns it off; it's on otherwise. Read when
// the run ends, so a change made meanwhile applies.
export function bellEnabled(configPath = CONFIG) {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'))?.notify !== false;
  } catch {
    return true;
  }
}

// Rings once when the run took long enough, it's on, and output is a terminal.
// Returns whether it rang.
export function ring({ started, now = Date.now(), output = process.stderr, configPath } = {}) {
  if (!output?.isTTY || now - started < QUICK_MS || !bellEnabled(configPath)) return false;
  try {
    output.write('\x07');
    return true;
  } catch {
    return false;
  }
}
