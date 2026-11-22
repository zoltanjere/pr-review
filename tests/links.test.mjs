import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { diffLines, linkify, resolvePath } from '../src/links.mjs';

const HEAD = 'c'.repeat(40);
const PR = { owner: 'acme', repo: 'widget', number: '42', head: HEAD };
const DIFF = [
  'diff --git a/src/upload_queue.py b/src/upload_queue.py',
  '--- a/src/upload_queue.py',
  '+++ b/src/upload_queue.py',
  '@@ -140,5 +148,9 @@ def changed_files(repo):',
  '+x',
  'diff --git a/docs/README.md b/docs/README.md',
  '--- a/docs/README.md',
  '+++ b/docs/README.md',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  'diff --git a/gone.txt b/gone.txt',
  '--- a/gone.txt',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
].join('\n');
const FILES = ['src/upload_queue.py', 'docs/README.md', 'README.md', 'tests/a/util.js', 'tests/b/util.js', 'CONTRIBUTING.md'];
const anchor = (path) => createHash('sha256').update(path).digest('hex');

test('diff line ranges come from the hunk headers of each changed file', () => {
  assert.deepEqual([...diffLines(DIFF)], [['src/upload_queue.py', [[148, 156]]], ['docs/README.md', [[1, 1]]]]);
});

test('short paths resolve to the one matching file, preferring changed files, never guessing', () => {
  const changed = ['src/upload_queue.py', 'docs/README.md'];
  assert.equal(resolvePath('upload_queue.py', changed, FILES), 'src/upload_queue.py');
  assert.equal(resolvePath('README.md', changed, FILES), 'docs/README.md');
  assert.equal(resolvePath('CONTRIBUTING.md', changed, FILES), 'CONTRIBUTING.md');
  assert.equal(resolvePath('util.js', changed, FILES), null);
  assert.equal(resolvePath('missing.py', changed, FILES), null);
});

test('a line inside the diff links into Files changed; any other line to the file at the reviewed commit', () => {
  const text = 'See `upload_queue.py:150-152` and `CONTRIBUTING.md:101-113` and `src/upload_queue.py:10`.';
  assert.equal(linkify(text, { ...PR, diffText: DIFF, files: FILES }),
    `See [\`upload_queue.py:150-152\`](https://github.com/acme/widget/pull/42/files#diff-${anchor('src/upload_queue.py')}R150-R152)`
    + ` and [\`CONTRIBUTING.md:101-113\`](https://github.com/acme/widget/blob/${HEAD}/CONTRIBUTING.md#L101-L113)`
    + ` and [\`src/upload_queue.py:10\`](https://github.com/acme/widget/blob/${HEAD}/src/upload_queue.py#L10).`);
});

test('a comma list links its first line, keeping the text', () => {
  const out = linkify('`upload_queue.py:148,175-179`', { ...PR, diffText: DIFF, files: FILES });
  assert.equal(out, `[\`upload_queue.py:148,175-179\`](https://github.com/acme/widget/pull/42/files#diff-${anchor('src/upload_queue.py')}R148)`);
});

test('unresolvable, line-less and already linked references are left as they are', () => {
  const text = '`util.js:3` `upload_queue.py` `Resume-PendingUpload` [`README.md:1`](https://example.com) `a:b`';
  assert.equal(linkify(text, { ...PR, diffText: DIFF, files: FILES }), text);
  assert.equal(linkify('`upload_queue.py:150`', { ...PR, head: 'not-a-sha', diffText: DIFF, files: FILES }), '`upload_queue.py:150`');
});

test('the terminal preview shows link text instead of GitHub URLs', async () => {
  const { renderDigest } = await import('../src/confirm.mjs');
  const { palette } = await import('../src/ui.mjs');
  const [line] = renderDigest(`- [\`a.py:3\`](https://github.com/acme/widget/blob/${HEAD}/a.py#L3): fix`, palette(false));
  assert.equal(line, '- `a.py:3`: fix');
});
