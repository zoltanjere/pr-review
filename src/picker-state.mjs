import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// PRs you chose to skip in the picker, kept on this machine only (state/ is
// git-ignored; nothing is written to GitHub). A skip remembers the PR's head
// commit at that time, so it ends by itself when the author pushes again.
//
// File shape: { "skipped": { "owner/repo#61": "<headRefOid when skipped>" } }

export const skipKey = (repo, pr) => `${repo}#${pr.number}`;

export function loadSkips(path) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return data && typeof data.skipped === 'object' && data.skipped ? data.skipped : {};
  } catch {
    return {}; // missing or unreadable: nothing skipped
  }
}

export function saveSkips(path, skips) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ skipped: skips }, null, 2)}\n`, { mode: 0o600 });
}

// Skipped only while the head is still the one you skipped.
export function isSkipped(repo, pr, skips) {
  const head = skips[skipKey(repo, pr)];
  return Boolean(head) && head === pr.headRefOid;
}
