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

// Small local JSON files under state/ (git-ignored). Each named field is an
// object; a missing or unreadable file reads as empty, so a broken file never
// stops the picker or watch. Written private: folder 0700, file 0600.
export function loadJson(path, fields) {
  let data = {};
  try { data = JSON.parse(readFileSync(path, 'utf8')); } catch { /* missing or unreadable: start fresh */ }
  return Object.fromEntries(fields.map((field) => [field, object(data?.[field])]));
}

export function saveJson(path, fields, state) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const data = Object.fromEntries(fields.map((field) => [field, state[field] ?? {}]));
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

const PICKER_FIELDS = ['skipped', 'lastLooked'];
export const loadState = (path) => loadJson(path, PICKER_FIELDS);
export const saveState = (path, state) => saveJson(path, PICKER_FIELDS, state);

// Skipped only while the head is still the one you skipped.
export function isSkipped(repo, pr, skipped) {
  const head = skipped[skipKey(repo, pr)];
  return Boolean(head) && head === pr.headRefOid;
}
