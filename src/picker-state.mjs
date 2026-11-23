import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// The picker's memory on this machine only (state/ is git-ignored; nothing is
// written to GitHub):
// - skipped: PRs you chose to skip, with the head commit at that time, so a
//   skip ends by itself when the author pushes again;
// - lastLooked: when you last opened the picker per repository, so New and
//   Updated can mean "since you looked".
//
// File shape:
// { "skipped": { "owner/repo#61": "<headRefOid when skipped>" },
//   "lastLooked": { "owner/repo": "<ISO time>" } }

export const skipKey = (repo, pr) => `${repo}#${pr.number}`;

const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

export function loadState(path) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return { skipped: object(data?.skipped), lastLooked: object(data?.lastLooked) };
  } catch {
    return { skipped: {}, lastLooked: {} }; // missing or unreadable: start fresh
  }
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ skipped: state.skipped ?? {}, lastLooked: state.lastLooked ?? {} }, null, 2)}\n`, { mode: 0o600 });
}

// Skipped only while the head is still the one you skipped.
export function isSkipped(repo, pr, skipped) {
  const head = skipped[skipKey(repo, pr)];
  return Boolean(head) && head === pr.headRefOid;
}
