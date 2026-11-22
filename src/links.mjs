import { createHash } from 'node:crypto';

// Turns `path:line` references in the digest into GitHub links, in code, so a
// link is never guessed. A line inside the PR's diff links into "Files
// changed" (where people can comment on it); any other line links to the file
// at the reviewed commit. Unresolvable references stay plain text.

// Right-side line ranges each changed file shows in the PR diff.
export function diffLines(diffText) {
  const files = new Map();
  let current = null;
  for (const line of String(diffText ?? '').split('\n')) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) {
      current = header[1];
      if (!files.has(current)) files.set(current, []);
      continue;
    }
    if (line.startsWith('+++ /dev/null')) current = null;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count > 0) files.get(current).push([start, start + count - 1]);
    }
  }
  return files;
}

// Finds the repository path a reference means: exact, or the one file whose
// path ends with it. Changed files win over the rest of the repository.
export function resolvePath(reference, changed, all) {
  const clean = reference.replace(/^\.?\//, '');
  for (const pool of [changed, all]) {
    if (pool.includes(clean)) return clean;
    const matches = pool.filter((path) => path.endsWith(`/${clean}`));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null;
  }
  return null;
}

const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

export function lineLink({ owner, repo, number, head, path, start, end, ranges }) {
  const inDiff = ranges?.some(([from, to]) => start >= from && (end ?? start) <= to);
  if (inDiff) {
    const anchor = createHash('sha256').update(path).digest('hex');
    return `https://github.com/${owner}/${repo}/pull/${number}/files#diff-${anchor}R${start}${end ? `-R${end}` : ''}`;
  }
  return `https://github.com/${owner}/${repo}/blob/${head}/${encodePath(path)}#L${start}${end ? `-L${end}` : ''}`;
}

// `path:12`, `path:12-30` and `path:12,40-41` inside backticks. A reference
// that is already a link's text is left alone.
const REFERENCE = /(?<!\[)`([^`\s:]+\.[^`\s:]+|[^`\s:]*\/[^`\s:]+):(\d+)(?:-(\d+))?((?:,\s*\d+(?:-\d+)?)*)`/g;

export function linkify(text, { owner, repo, number, head, diffText, files = [] }) {
  if (!owner || !repo || !number || !/^[0-9a-f]{40}$/i.test(head ?? '')) return text;
  const lines = diffLines(diffText);
  const changed = [...lines.keys()];
  return String(text).replace(REFERENCE, (match, reference, from, to) => {
    const path = resolvePath(reference, changed, files);
    if (!path) return match;
    const start = Number(from);
    const end = to && Number(to) > start ? Number(to) : undefined;
    return `[${match}](${lineLink({ owner, repo, number, head, path, start, end, ranges: lines.get(path) })})`;
  });
}
