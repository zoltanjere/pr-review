import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapters, findLocalRepository, prReferences, runCommand, stageSkills, REVIEWERS } from '../src/adapters.mjs';

const MODEL = 'claude-sonnet-5.5';
const PR = { owner: 'acme', repo: 'widget', number: '42' };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'review-adapter-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'widget');
  await mkdir(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('remote', 'add', 'origin', 'https://github.com/acme/widget.git');
  await writeFile(join(repo, 'example.txt'), 'before\n');
  git('add', 'example.txt');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'example.txt'), 'after\n');
  git('commit', '-qam', 'change');
  const head = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/pull/42/head', head);
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({ model: MODEL }));
  return { root, repo, base, head, git, config };
}

// Copilot JSONL event builders.
const skillLoaded = (skill, source = 'project', id = 'skill-1') => [
  { type: 'tool.execution_start', data: { toolCallId: id, toolName: 'skill', arguments: { skill } } },
  { type: 'tool.execution_complete', data: { toolCallId: id, success: true, result: { content: `Skill "${skill}" loaded successfully.` }, toolTelemetry: { properties: { skillSource: source } } } },
];
const task = (id, args = {}) => [
  { type: 'tool.execution_start', data: { toolCallId: id, toolName: 'task', arguments: { name: id, ...args } } },
  { type: 'tool.execution_complete', data: { toolCallId: id, success: true } },
];
const message = (content, model = MODEL) => ({ type: 'assistant.message', data: { model, content } });
const jsonl = (events) => events.map((event) => JSON.stringify(event)).join('\n');
const promptOf = (args) => args[args.indexOf('--prompt') + 1];
const skillOf = (args) => promptOf(args).match(/^\/(ponytail-review|code-review|review-digest)/)?.[1];
const isCheck = (args) => promptOf(args).startsWith('Verify code-review findings');

// Real git against the fixture (fetches redirected to the local repo), faked
// gh and az, and `copilot(args, options)` for agent calls.
function mockExecute(f, { metadata = {}, copilot, az, issue, reference, reviews, compare, changes } = {}) {
  return async (command, args, options) => {
    if (command === 'az') return az(args);
    if (command === 'gh') {
      if (args[0] === 'issue') return issue(args);
      if (args[0] === 'api' && /\/issues\/\d+$/.test(args[1])) return reference ? reference(args) : JSON.stringify({ state: 'open' });
      if (args[0] === 'api' && args[1] === 'user') return 'me\n';
      if (args[0] === 'api' && args.includes('--paginate')) return reviews ? reviews(args) : '[[]]';
      if (args[0] === 'api' && args[1].includes('/compare/') && args.at(-1).startsWith('{total')) return changes ? changes(args) : JSON.stringify({ total: 1, files: [{ filename: 'example.txt', status: 'modified', patch: `+${args[1]}` }] });
      if (args[0] === 'api' && args[1].includes('/compare/')) return `${compare ?? 'ahead'}\n`;
      return JSON.stringify({ baseRefOid: f.base, headRefOid: f.head, title: '', body: '', closingIssuesReferences: [], ...metadata });
    }
    if (command === 'copilot') return copilot(args, options);
    if (command === 'git' && args.includes('fetch')) {
      return runCommand(command, args.map((value) => value === 'https://github.com/acme/widget.git' ? f.repo : value), options);
    }
    return runCommand(command, args, options);
  };
}

// Verify's two steps have no skill: listing returns an array, checking an object.
const VERDICT = { status: 'Confirmed', priority: 'Minor', kind: 'cleanup', location: 'example.txt:1', finding: 'checked', evidence: 'example.txt:1 shows it', fix: '' };
function verifyStep(args, model = MODEL, findings = [{ title: 'Example problem', tier: 'A', raisedBy: ['ponytail-review'], location: 'example.txt:1', claim: 'c', fix: '' }]) {
  if (!isCheck(args)) return jsonl([message(JSON.stringify(findings), model)]);
  const count = JSON.parse(/Findings \(JSON[^\n]*\n(\[[\s\S]*?\n\])\n/.exec(promptOf(args))[1]).length;
  return jsonl([message(JSON.stringify(Array.from({ length: count }, (_, i) => ({ n: i + 1, ...VERDICT }))), model)]);
}

// A well-behaved agent: loads the prompt's skill and, for code-review, runs subagents.
function goodAgent(args) {
  const skill = skillOf(args);
  const model = args[args.indexOf('--model') + 1];
  if (!skill) return verifyStep(args, model);
  const content = { 'code-review': '## Standards\nNo findings.\n\n## Spec\nNo spec available.', 'review-digest': '**Verdict:** ✅ Ship.' }[skill] ?? skill;
  return jsonl([...skillLoaded(skill), ...(skill === 'code-review' ? task('standards') : []), message(content, model)]);
}

async function prepared(t, options = {}) {
  const f = await fixture(t);
  const adapters = createAdapters({ projectsRoot: f.root, configPath: f.config, progress: () => {}, ...options, execute: mockExecute(f, options) });
  const result = await adapters.prepare(PR);
  t.after(() => result.cleanup());
  return { f, adapters, prepared: result };
}

test('requires a matching local repository and prefers its exact directory name', async (t) => {
  const f = await fixture(t);
  execFileSync('git', ['clone', '-q', f.repo, join(f.root, 'widget-copy')]);
  execFileSync('git', ['-C', join(f.root, 'widget-copy'), 'remote', 'set-url', 'origin', 'git@github.com:acme/widget.git']);
  const found = await findLocalRepository({ owner: 'acme', repo: 'widget' }, f.root);
  assert.equal(found.path, f.repo);
  await assert.rejects(findLocalRepository({ owner: 'other', repo: 'widget' }, f.root), /no local.*matching/i);
});

test('prepares pinned PR commits in a temporary clone without modifying the local checkout', async (t) => {
  const f = await fixture(t);
  const calls = [];
  const messages = [];
  const inner = mockExecute(f);
  const execute = (command, args, options) => { calls.push([command, args]); return inner(command, args, options); };
  const adapters = createAdapters({ projectsRoot: f.root, configPath: f.config, execute, progress: (text) => messages.push(text) });
  const result = await adapters.prepare(PR);
  try {
    assert.equal(result.base, f.base);
    assert.equal(result.head, f.head);
    assert.match(await readFile(result.diff, 'utf8'), /-before\n\+after/);
    assert.notEqual(result.checkout, f.repo);
    assert.equal(f.git('rev-parse', 'HEAD'), f.head);
    assert(calls.some(([command, args]) => command === 'git' && args.includes('refs/pull/42/head')));
    assert(messages.some((text) => /starting.*local repository/i.test(text)));
    assert(messages.some((text) => /starting.*fetch.*pull request/i.test(text)));
  } finally {
    await result.cleanup();
  }
  await assert.rejects(readFile(result.diff), { code: 'ENOENT' });
});

test('failed preparation removes its temporary clone', async (t) => {
  const f = await fixture(t);
  const tempRoot = join(f.root, 'temp');
  await mkdir(tempRoot);
  const inner = mockExecute(f);
  const execute = async (command, args, options) => {
    if (command === 'git' && args.includes('fetch')) throw new Error('fetch failed');
    return inner(command, args, options);
  };
  const adapters = createAdapters({ projectsRoot: f.root, configPath: f.config, tempRoot, execute });
  await assert.rejects(adapters.prepare(PR), /fetch failed/);
  assert.deepEqual(await readdir(tempRoot), []);
});

test('agent stages invoke the intended skills and keep repository tools read-only', async (t) => {
  const f = await fixture(t);
  const calls = [];
  const cwds = [];
  const configPath = join(f.root, 'config.json');
  const execute = mockExecute(f, {
    metadata: { title: 'Fixture', body: 'Fixes #17 and AB#123', closingIssuesReferences: [{ number: 17 }] },
    issue: () => JSON.stringify({ number: 17, title: 'Requirement', body: 'Fictional spec' }),
    az: () => JSON.stringify({ fields: { 'System.Title': 'Board item', 'System.Description': 'Board spec' } }),
    copilot: (args, options) => {
      calls.push(args);
      cwds.push(options.cwd);
      const skill = skillOf(args);
      const model = args[args.indexOf('--model') + 1];
      if (!skill) return verifyStep(args, model);
      const content = skill === 'code-review' ? '## Standards\nNo findings.\n\n## Spec\nNo findings.'
        : skill === 'review-digest' ? '**Verdict:** ✅ Ship. No issues found.' : 'fictional review';
      return jsonl([
        ...(skill ? skillLoaded(skill) : []),
        ...(skill === 'code-review' ? [...task('standards'), ...task('spec')] : []),
        message(content, model),
      ]);
    },
  });
  for (const model of ['claude-sonnet-5.5', 'claude-opus-5.5', 'future-model']) {
    await writeFile(configPath, JSON.stringify({ model, azureDevOpsOrg: 'https://dev.azure.com/acme' }));
    calls.length = 0;
    cwds.length = 0;
    const adapters = createAdapters({ projectsRoot: f.root, configPath, execute, progress: () => {} });
    const result = await adapters.prepare(PR);
    try {
      await writeFile(configPath, JSON.stringify({ model: 'changed-during-run' }));
      const context = await readFile(result.context, 'utf8');
      assert.match(context, /Fictional spec/);
      assert.match(context, /Board spec/);
      await access(join(result.workspace, '.github', 'skills', 'review-digest', 'SKILL.md'));
      assert.match(await adapters.review('code-review', result), /## Standards/);
      assert.equal(await adapters.review('ponytail-review', result), 'fictional review');
      assert.match((await adapters.verify({ 'ponytail-review': 'one', 'code-review': 'two' })).markdown, /### 1\. Example problem \(Confirmed\)/);
      assert.equal(await adapters.digest('verified'), '**Verdict:** ✅ Ship. No issues found.');
      for (const args of calls) {
        assert(args.includes('--deny-tool=write'));
        assert(args.includes('--deny-tool=shell(git push)'));
        assert(args.includes('--allow-tool=shell(git diff)'));
        assert(!args.some((arg) => /^--allow-tool=shell(?:\(\w+(?::\*)?\))?$/.test(arg)), 'no blanket or whole-program shell allow');
        assert(args.includes('--no-custom-instructions'));
        assert.equal(args[args.indexOf('--add-dir') + 1], result.workspace);
        assert(args.includes('--disable-builtin-mcps'));
        assert.equal(args[args.indexOf('--model') + 1], model);
        assert(promptOf(args).includes(`set its model argument to ${model}`));
      }
      assert(promptOf(calls[0]).includes(result.diff));
      assert.match(promptOf(calls[0]), /no spec available/i);
      assert(promptOf(calls[0]).includes(`${result.base}...${result.head}`));
      assert(cwds.every((cwd) => cwd === result.checkout));
    } finally {
      await result.cleanup();
    }
  }
});

test('invalid configuration fails before invoking external commands', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-config-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'config.json');
  const execute = async () => { throw new Error('unexpected command'); };
  for (const [config, pattern] of [
    [{ model: '' }, /config.*model/i],
    [{ model: 'm', azureDevOpsOrg: 'my-organization' }, /azureDevOpsOrg/],
  ]) {
    await writeFile(configPath, JSON.stringify(config));
    const adapters = createAdapters({ projectsRoot: root, configPath, execute });
    await assert.rejects(adapters.prepare(PR), pattern);
  }
});

test('the entry point produces five saved review stages for a local repository', async (t) => {
  const f = await fixture(t);
  const output = join(f.root, 'reviews');
  const { main } = await import('../src/review.mjs');
  await main(['https://github.com/acme/widget/pull/42'], {
    projectsRoot: f.root, configPath: f.config, outputRoot: output, execute: mockExecute(f, { copilot: goodAgent }), progress: () => {},
  });
  const [day] = await readdir(output);
  const files = await readdir(join(output, day, 'widget-PR42'));
  const id = files[0].split('-')[0];
  assert.match(id, /^\d{4}$/);
  assert.deepEqual(files.sort(), ['code-review', 'digest', 'ponytail-review', 'verified'].map((stage) => `${id}-${stage}.md`));
  assert.match(await readFile(join(output, day, 'widget-PR42', `${id}-verified.md`), 'utf8'), /^# Verified review/);
});

// A PR you reviewed at f.head (Request changes), with one fix commit pushed since.
async function reviewedFixture(t) {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'example.txt'), 'fixed\n');
  f.git('commit', '-qam', 'fix: handle the empty case');
  const fixedHead = f.git('rev-parse', 'HEAD');
  f.git('update-ref', 'refs/pull/42/head', fixedHead);
  const posted = `**Verdict:** 🔴 Fix before merge. 1 must-fix.\n\n### Must fix\n1. 🔴 **Empty input crashes**\n   \`example.txt:1\`\n   An empty file throws. Fix: handle it.\n\n---\n<sub>Reviewed at \`${f.head.slice(0, 7)}\` with AI assistance. Each finding was checked against the code.</sub>\n`;
  const reviews = (args) => {
    const path = args.at(-1);
    if (path.endsWith('/reviews')) return JSON.stringify([[{ user: { login: 'me' }, state: 'CHANGES_REQUESTED', body: posted, commit_id: f.head, submitted_at: '2026-01-01T00:00:00Z' }]]);
    if (path.includes('/issues/')) return JSON.stringify([[{ user: { login: 'alice', type: 'User' }, created_at: '2026-01-02T00:00:00Z', body: 'Handled the empty case.' }, { user: { login: 'ci[bot]', type: 'Bot' }, created_at: '2026-01-02T00:00:00Z', body: 'green' }]]);
    return '[[]]';
  };
  return { ...f, old: f.head, head: fixedHead, reviews, metadata: { headRefOid: fixedHead, author: { login: 'alice' }, baseRefName: 'main' } };
}

test('a PR re-reviewed after fixes gets a follow-up: earlier findings checked, new commits scanned, no full reviewers', async (t) => {
  const f = await reviewedFixture(t);
  const output = join(f.root, 'reviews');
  const prompts = [];
  const copilot = (args) => {
    const prompt = promptOf(args);
    prompts.push(prompt);
    const model = args[args.indexOf('--model') + 1];
    if (prompt.startsWith('This is a follow-up review')) {
      return jsonl([message(JSON.stringify([{ n: 1, status: 'Fixed', answer: '-', reply: '', evidence: 'example.txt:1 now handles it.', remaining: '' }]), model)]);
    }
    if (prompt.startsWith('Review only the new commits')) return jsonl([message('No findings.', model)]);
    return goodAgent(args);
  };
  const { main } = await import('../src/review.mjs');
  await main(['https://github.com/acme/widget/pull/42'], {
    projectsRoot: f.root, configPath: f.config, outputRoot: output, progress: () => {},
    execute: mockExecute(f, { copilot, reviews: f.reviews, metadata: f.metadata }),
  });
  const [day] = await readdir(output);
  const dir = join(output, day, 'widget-PR42');
  const files = (await readdir(dir)).map((file) => file.replace(/^\d{4}-/, '')).sort();
  assert.deepEqual(files, ['digest.md', 'follow-up.md', 'scan.md', 'verified.md']);
  assert(!prompts.some((prompt) => /^\/(ponytail-review|code-review)/.test(prompt)));
  // The check sees the new-code diff and the human replies, not the bot's.
  const check = prompts.find((prompt) => prompt.startsWith('This is a follow-up review'));
  const diffPath = /changes since the earlier review are in (\S+) /.exec(check)[1];
  assert.equal(diffPath.endsWith('new-diff.txt'), true);
  const digest = await readFile(join(dir, (await readdir(dir)).find((file) => file.endsWith('-digest.md'))), 'utf8');
  assert.match(digest, /^\*\*Verdict:\*\* ✅ Ship\. The earlier point is resolved, nothing new\./);
  assert.match(digest, new RegExp(`Re-review since \`${f.old.slice(0, 7)}\`\\*\\* \\(1 new commit\\)`));
  assert.match(digest, /\n- ✅ Empty input crashes\n/);
});

test('a rebase that left the PR\'s changes as they were is still a follow-up, with no scan', async (t) => {
  const f = await reviewedFixture(t);
  const output = join(f.root, 'reviews');
  const prompts = [];
  const copilot = (args) => {
    const prompt = promptOf(args);
    prompts.push(prompt);
    const model = args[args.indexOf('--model') + 1];
    if (prompt.startsWith('This is a follow-up review')) {
      return jsonl([message(JSON.stringify([{ n: 1, status: 'Still open', answer: '-', reply: '', evidence: 'example.txt:1 is unchanged.', remaining: 'An empty file still throws.' }]), model)]);
    }
    return goodAgent(args);
  };
  const same = () => JSON.stringify({ total: 1, files: [{ filename: 'example.txt', status: 'modified', sha: 'x', patch: '@@ -1 +1 @@\n-before\n+after' }] });
  const { main } = await import('../src/review.mjs');
  await main(['https://github.com/acme/widget/pull/42'], {
    projectsRoot: f.root, configPath: f.config, outputRoot: output, progress: () => {},
    execute: mockExecute(f, { copilot, reviews: f.reviews, metadata: f.metadata, compare: 'diverged', changes: same }),
  });
  const [day] = await readdir(output);
  const dir = join(output, day, 'widget-PR42');
  assert.deepEqual((await readdir(dir)).map((file) => file.replace(/^\d{4}-/, '')).sort(), ['digest.md', 'follow-up.md', 'verified.md']);
  assert(!prompts.some((prompt) => prompt.startsWith('Review only the new commits')));
  const digest = await readFile(join(dir, (await readdir(dir)).find((file) => file.endsWith('-digest.md'))), 'utf8');
  assert.match(digest, /\(rebased, no changes to the PR's code\): only the replies to the 1 earlier point were checked\./);
  assert.match(digest, /### Still open from the last review\n1\. 🔴 \*\*Empty input crashes\*\*/);
});

test('a rewritten history falls back to a full review and tells the author why', async (t) => {
  const f = await reviewedFixture(t);
  const output = join(f.root, 'reviews');
  const notes = [];
  const { main } = await import('../src/review.mjs');
  await main(['https://github.com/acme/widget/pull/42'], {
    projectsRoot: f.root, configPath: f.config, outputRoot: output, progress: (text) => notes.push(String(text)),
    execute: mockExecute(f, { copilot: goodAgent, reviews: f.reviews, metadata: f.metadata, compare: 'diverged' }),
  });
  const [day] = await readdir(output);
  const dir = join(output, day, 'widget-PR42');
  const files = (await readdir(dir)).map((file) => file.replace(/^\d{4}-/, '')).sort();
  assert.deepEqual(files, ['code-review.md', 'digest.md', 'ponytail-review.md', 'verified.md']);
  const digest = await readFile(join(dir, (await readdir(dir)).find((file) => file.endsWith('-digest.md'))), 'utf8');
  assert.match(digest, /^\*\*Verdict:\*\*[^\n]*\n\n> 🔁 \*\*Full re-review:\*\* the commit reviewed last time/);
});

for (const [name, events, pattern] of [
  ['a response that did not load the requested skill fails', [message('Not a real skill run')], /skill.*not.*load/i],
  ['a personal instead of project skill fails', [...skillLoaded('ponytail-review', 'personal'), message('review')], /project skill/i],
]) {
  test(name, async (t) => {
    const { adapters, prepared: result } = await prepared(t, { copilot: () => jsonl(events) });
    await assert.rejects(adapters.review('ponytail-review', result), pattern);
  });
}

for (const [name, events, pattern] of [
  ['rejects a response if a nested agent uses a different model',
    [...skillLoaded('code-review'), message('nested review', 'gpt-6-luna'), message('combined review')], /gpt-6-luna/],
  ['rejects code-review output if the standards subagent did not run',
    [...skillLoaded('code-review'), message('## Standards\nNo findings.\n\n## Spec\nNo spec available.')], /0 foreground subagent/i],
  ['rejects a claimed spec review if the spec subagent runs in the background',
    [...skillLoaded('code-review'), ...task('standards'), ...task('spec', { mode: 'background' }), message('## Standards\nNo findings.\n\n## Spec\nNo findings.')],
    /expected 2 \(Standards and Spec\)/],
]) {
  test(name, async (t) => {
    const { adapters, prepared: result } = await prepared(t, { copilot: () => jsonl(events) });
    await assert.rejects(adapters.review('code-review', result), pattern);
  });
}

test('code-review accepts foreground subagents of any name', async (t) => {
  const events = [...skillLoaded('code-review'), ...task('axis-a'), ...task('axis-b'), message('## Standards\nNo findings.\n\n## Spec\nNo findings.')];
  const { adapters, prepared: result } = await prepared(t, { copilot: () => jsonl(events) });
  assert.match(await adapters.review('code-review', result), /## Spec/);
});

test('code-review that answers inline is retried once and accepted when it then uses subagents', async (t) => {
  let calls = 0;
  const copilot = () => jsonl([
    ...skillLoaded('code-review'),
    ...(++calls > 1 ? task('standards') : []),
    message('## Standards\nNo findings.\n\n## Spec\nNo spec available.'),
  ]);
  const { adapters, prepared: result } = await prepared(t, { copilot });
  assert.match(await adapters.review('code-review', result), /## Standards/);
  assert.equal(calls, 2);
});

async function digestRun(t, drafts) {
  const prompts = [];
  const messages = [];
  const copilot = (args) => {
    prompts.push(promptOf(args));
    return jsonl([...skillLoaded('review-digest'), message(drafts[prompts.length - 1])]);
  };
  const { adapters } = await prepared(t, { copilot, progress: (text) => messages.push(text) });
  return { result: await adapters.digest('verified review'), prompts, messages };
}

test('an over-budget digest is retried once and the shorter version returned', async (t) => {
  const long = `**Verdict:** ✅ Ship.\n\n### Should fix\n1. 🟡 **Long**\n   ${'word '.repeat(400)}`;
  const short = '**Verdict:** ✅ Ship. No issues found.';
  const { result, prompts } = await digestRun(t, [long, short]);
  assert.equal(result, '**Verdict:** ✅ Ship. No issues found.');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /previous draft/i);
});

test('words inside <details> do not count toward the digest budget', async (t) => {
  const text = `**Verdict:** ✅ Ship.\n\n<details><summary>minor</summary>\n\n${'word '.repeat(400)}\n</details>`;
  const { result, prompts } = await digestRun(t, [text]);
  assert.equal(result, text.replace('**Verdict:** ✅ Ship.', '**Verdict:** ✅ Ship. No issues found.'));
  assert.equal(prompts.length, 1);
});

test('the verdict line comes from the findings, replacing any the model wrote', async (t) => {
  const prompts = [];
  const copilot = (args) => {
    prompts.push(promptOf(args));
    return jsonl([...skillLoaded('review-digest'), message('**Verdict:** ✅ Ship. All good.\n\n### Should fix\n1. 🟡 **Problem**')]);
  };
  const { adapters } = await prepared(t, { copilot });
  const digest = await adapters.digest('verified', [{ title: 'Problem', status: 'Confirmed', priority: 'Should fix' }]);
  assert.equal(digest, '**Verdict:** ⚠️ Changes recommended. 1 should-fix.\n\n### Should fix\n1. 🟡 **Problem**');
  assert.match(prompts[0], /Do not write a verdict line/);
});

test('a digest still over budget after the retry is saved with a warning', async (t) => {
  const long = `### Should fix\n1. 🟡 **Long**\n   ${'word '.repeat(400)}`;
  const { result, prompts, messages } = await digestRun(t, [long, long]);
  assert.match(result, /^\*\*Verdict:\*\* ✅ Ship\. No issues found\.\n\n### Should fix\n1\. 🟡 \*\*Long\*\*\n   word/);
  assert.equal(prompts.length, 2);
  assert(messages.some((text) => /warning.*words before <details>/i.test(text)));
});

test('notes the model writes about itself are removed from the digest, with a warning', async (t) => {
  const draft = [
    "I couldn't save a file: the sandbox blocks writes. The body is below:",
    '### Must fix\n1. 🔴 **Retry resends a stored chunk**\n   `upload.ts` · `sendChunk`\n   A timeout resends it. Fix: send an offset.',
    '<details><summary>1 minor item</summary>\n\n- `retry.ts:4`: unused export.\n</details>',
    'Nothing was posted. No subagents were spawned.',
  ].join('\n\n');
  const { result, prompts, messages } = await digestRun(t, [draft]);
  assert.doesNotMatch(result, /sandbox|Nothing was posted|subagents/);
  assert.match(result, /### Must fix\n1\. 🔴 \*\*Retry resends a stored chunk\*\*\n   `upload\.ts`/);
  assert.match(result, /<details><summary>1 minor item<\/summary>\n\n- `retry\.ts:4`: unused export\.\n<\/details>$/);
  assert(messages.some((text) => /removed from the digest.*couldn't save a file/i.test(text)), messages.join('\n'));
  assert.match(prompts[0], /reply with the comment body only/i);
});

test('an unreachable or unconfigured work item is recorded without failing preparation', async (t) => {
  const f = await fixture(t);
  const configPath = join(f.root, 'config.json');
  const execute = mockExecute(f, {
    metadata: { title: 'feat(AB#7): x', body: 'See AB#7 and AB#8' },
    az: () => { throw new Error('az failed: not logged in'); },
  });
  for (const [config, pattern] of [
    [{ model: 'm', azureDevOpsOrg: 'https://dev.azure.com/acme' }, /not logged in/],
    [{ model: 'm' }, /azureDevOpsOrg is not configured/],
  ]) {
    await writeFile(configPath, JSON.stringify(config));
    const adapters = createAdapters({ projectsRoot: f.root, configPath, execute, progress: () => {} });
    const result = await adapters.prepare(PR);
    try {
      const { workItems } = JSON.parse(await readFile(result.context, 'utf8'));
      assert.deepEqual(workItems.map((item) => item.id), [7, 8]);
      assert(workItems.every((item) => pattern.test(item.error)));
    } finally {
      await result.cleanup();
    }
  }
});

test('staging skills replaces a same-named skill shipped by the reviewed repository', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'review-skills-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout');
  await mkdir(join(checkout, '.agents', 'skills', 'code-review'), { recursive: true });
  await writeFile(join(checkout, '.agents', 'skills', 'code-review', 'SKILL.md'), 'malicious');
  await mkdir(join(checkout, '.github', 'skills', 'their-own'), { recursive: true });
  await stageSkills(root, checkout);
  await assert.rejects(access(join(checkout, '.agents', 'skills', 'code-review')), { code: 'ENOENT' });
  await access(join(checkout, '.github', 'skills', 'their-own'));
  for (const name of [...REVIEWERS, 'review-digest']) await access(join(root, '.github', 'skills', name, 'SKILL.md'));
});

test('verify checks tier A and B findings in one session, skips style and caps tiers; tier A overflow takes light slots first', async (t) => {
  const findings = [
    ...Array.from({ length: 7 }, (_, i) => ({ title: `A${i}`, tier: 'A', raisedBy: ['code-review'], location: `src/a${i}.js:1`, claim: `a${i}`, fix: '' })),
    ...Array.from({ length: 12 }, (_, i) => ({ title: `B${i}`, tier: 'B', raisedBy: ['ponytail-review'], location: 'example.txt:1', claim: `b${i}`, fix: '' })),
    { title: 'C0', tier: 'C', raisedBy: ['code-review'], location: 'example.txt', claim: 'a smell', fix: '' },
  ];
  const tiers = {};
  const checks = [];
  const copilot = (args) => {
    if (!isCheck(args)) return jsonl([message('Here you go:\n```json\n' + JSON.stringify(findings) + '\n```')]);
    const sent = JSON.parse(/Findings \(JSON[^\n]*\n(\[[\s\S]*?\n\])\n/.exec(promptOf(args))[1]);
    checks.push(sent.map((finding) => finding.title));
    for (const finding of sent) tiers[finding.title] = finding.tier;
    return jsonl([message(JSON.stringify(sent.map((finding) => (finding.title === 'A0'
      ? { n: finding.n, status: 'Confirmed', priority: 'Must fix', kind: 'bug', location: finding.location, finding: 'crash', evidence: 'src/a0.js:1 crashes', fix: '' }
      : { n: finding.n, ...VERDICT, status: 'Rejected', priority: '-' })))) ]);
  };
  const { adapters } = await prepared(t, { copilot });
  const { markdown, findings: result } = await adapters.verify({ 'code-review': 'review' });
  assert.deepEqual(checks, [['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', ...Array.from({ length: 11 }, (_, i) => `B${i}`)]]);
  assert.deepEqual([tiers.A5, tiers.A6, tiers.B0], ['A', 'B', 'B']);
  assert.equal(result.find((item) => item.title === 'C0').status, 'Rejected');
  assert.match(result.find((item) => item.title === 'C0').evidence, /style/);
  assert.equal(result.find((item) => item.title === 'B11').status, 'Unchecked');
  assert.match(markdown, /^### 1\. A0 \(Confirmed\)$/m);
  assert.match(markdown, /### 20\. B11 \(Unchecked\)/);
});

test('a check session with the wrong number of verdicts is retried once with a note', async (t) => {
  const prompts = [];
  const copilot = (args) => {
    if (!isCheck(args)) return verifyStep(args);
    prompts.push(promptOf(args));
    return prompts.length === 1 ? jsonl([message('[]')]) : verifyStep(args);
  };
  const { adapters } = await prepared(t, { copilot });
  assert.match((await adapters.verify({ 'code-review': 'review' })).markdown, /\(Confirmed\)/);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /wrong number of verdicts/);
});

test('the check prompt makes verify trace a claimed example and skip what the PR already states', async (t) => {
  const prompts = [];
  const copilot = (args) => {
    if (isCheck(args)) prompts.push(promptOf(args));
    return verifyStep(args);
  };
  const { adapters } = await prepared(t, { copilot });
  await adapters.verify({ 'code-review': 'review' });
  assert.match(prompts[0], /walk that exact input through every function/);
  assert.match(prompts[0], /If a step contradicts the example/);
  // Severity is not lowered by likelihood: the person decides whether a Should fix blocks.
  assert.doesNotMatch(prompts[0], /Rate by likelihood/);
  assert.match(prompts[0], /already stated in the PR/);
  assert.match(prompts[0], /proof of that same check \(same tool or command\)/);
  assert.match(prompts[0], /Quote the PR's words/);
  assert.match(prompts[0], /whether the PR body already states what a finding describes/);
  assert.match(prompts[0], /counts as stated only while that condition is unmet/);
  assert.match(prompts[0], /read the whole section the cited line belongs to/);
  assert.match(prompts[0], /read your own evidence against the finding/);
});

test('a stated trade-off that weakens a protection becomes a question, and one change at one place is one finding', async (t) => {
  const checks = [];
  const lists = [];
  const copilot = (args) => {
    (isCheck(args) ? checks : lists).push(promptOf(args));
    return verifyStep(args);
  };
  const { adapters } = await prepared(t, { copilot });
  await adapters.verify({ 'code-review': 'review' });
  assert.match(checks[0], /stated trade-off that removes or weakens a protection \(required or code-owner review/);
  assert.match(checks[0], /is not rejected as already stated: answer Question/);
  assert.match(lists.find((p) => p.includes('extract their findings')), /same change at the same location are one finding/);
});

test('verify with no findings records that and checks nothing', async (t) => {
  const copilot = (args) => verifyStep(args, MODEL, []);
  const { adapters } = await prepared(t, { copilot });
  assert.equal((await adapters.verify({ 'code-review': 'review' })).markdown, '# Verified review\n\nNo findings.');
});

test('the check session gets only the diff of the cited files and may use its own model', async (t) => {
  const { diffForFiles } = await import('../src/adapters.mjs');
  const diff = 'diff --git a/src/one.js b/src/one.js\n+one\ndiff --git a/docs/two.md b/docs/two.md\n+two\ndiff --git a/three.py b/three.py\n+three\n';
  assert.equal(diffForFiles(diff, ['`src/one.js:12`', 'three.py (main)']), 'diff --git a/src/one.js b/src/one.js\n+one\ndiff --git a/three.py b/three.py\n+three\n');
  assert.equal(diffForFiles(diff, ['two.md:3-5']), 'diff --git a/docs/two.md b/docs/two.md\n+two\n');
  assert.equal(diffForFiles(diff, ['CONTRIBUTING.md:4']), '');
  const models = [];
  const copilot = (args) => {
    const model = args[args.indexOf('--model') + 1];
    if (isCheck(args)) models.push(model);
    return verifyStep(args, model);
  };
  const f = await fixture(t);
  await writeFile(f.config, JSON.stringify({ model: MODEL, checkModel: 'cheap-model' }));
  const adapters = createAdapters({ projectsRoot: f.root, configPath: f.config, progress: () => {}, execute: mockExecute(f, { copilot }) });
  const result = await adapters.prepare(PR);
  t.after(() => result.cleanup());
  await adapters.verify({ 'code-review': 'review' });
  assert.deepEqual(models, ['cheap-model']);
});

test('each session cost is read from its shutdown event, or from the session log', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'copilot-state-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const shutdown = (premium, input, output) => ({ type: 'session.shutdown', data: { accountingSnapshot: { totalPremiumRequestCost: premium, totalNanoAiu: premium * 1.5e9, tokenDetails: { input: { tokenCount: input }, output: { tokenCount: output } } } } });
  await mkdir(join(stateDir, 'abc-123'));
  await writeFile(join(stateDir, 'abc-123', 'events.jsonl'), JSON.stringify(shutdown(1, 900, 100)) + '\n');
  let call = 0;
  const copilot = (args) => {
    const inline = ++call === 1;
    return jsonl([
      { type: 'session.start', data: { sessionId: 'abc-123' } },
      ...skillLoaded('ponytail-review'), message('review'),
      ...(inline ? [shutdown(2, 1000, 500)] : []),
    ]);
  };
  const { adapters, prepared: result } = await prepared(t, { copilot, copilotStateDir: stateDir });
  await adapters.review('ponytail-review', result);
  await adapters.review('ponytail-review', result);
  assert.deepEqual(adapters.usage(), [
    { stage: 'ponytail-review', premium: 2, tokens: 1500, credits: 3 },
    { stage: 'ponytail-review', premium: 1, tokens: 1000, credits: 1.5 },
  ]);
  assert.equal(adapters.tokensFor('ponytail-review'), '3k tokens · 4.50 AI credits');
  assert.equal(adapters.tokensFor('code-review'), null);
  const { formatTokens } = await import('../src/ui.mjs');
  assert.deepEqual([formatTokens(15_200), formatTokens(1_250_000), formatTokens(null)], ['15k tokens', '1.3M tokens', null]);
});

test('posting runs exactly one gh pr review with the chosen type and the body as a file', async (t) => {
  const calls = [];
  let body;
  const execute = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ state: 'OPEN', headRefOid: 'a'.repeat(40), author: { login: 'alice' } });
    if (args[0] === 'api') return 'bob\n';
    if (args[0] === 'pr' && args[1] === 'review') body = await readFile(args[args.indexOf('--body-file') + 1], 'utf8');
    return '';
  };
  const tempRoot = await mkdtemp(join(tmpdir(), 'post-test-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const adapters = createAdapters({ execute, tempRoot, progress: () => {} });
  assert.deepEqual(await adapters.prStatus(PR), { state: 'OPEN', head: 'a'.repeat(40), author: 'alice', viewer: 'bob' });
  await adapters.postReview(PR, 'approve', 'the review');
  const review = calls.filter(([, a, b]) => a === 'pr' && b === 'review');
  assert.equal(review.length, 1);
  assert.deepEqual(review[0].slice(0, 5), ['gh', 'pr', 'review', 'https://github.com/acme/widget/pull/42', '--approve']);
  assert.equal(body, 'the review');
  assert.deepEqual(await readdir(tempRoot), []);
  await assert.rejects(adapters.postReview(PR, 'merge', 'x'), /Unknown review type/);
});

test('file:line references in the digest become links into the PR diff', async (t) => {
  const copilot = () => jsonl([...skillLoaded('review-digest'), message('<details><summary>1 minor item</summary>\n\n- `example.txt:1`: say why.\n</details>')]);
  const { f, adapters } = await prepared(t, { copilot });
  const digest = await adapters.digest('verified', [{ title: 'x', status: 'Confirmed', priority: 'Minor' }]);
  const { createHash } = await import('node:crypto');
  const anchor = createHash('sha256').update('example.txt').digest('hex');
  assert.match(digest, new RegExp(`\\[\`example\\.txt:1\`\\]\\(https://github\\.com/acme/widget/pull/42/files#diff-${anchor}R1\\)`));
  assert.ok(f.head);
});

test('the picker reads PRs and review commits with read-only gh calls', async () => {
  const calls = [];
  const execute = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'api' && args[1] === 'user') return 'me\n';
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([{ number: 1 }]);
    return JSON.stringify([[{ user: { login: 'me' }, commit_id: 'old' }, { user: { login: 'bob' }, commit_id: 'x' }], [{ user: { login: 'me' }, commit_id: 'new' }]]);
  };
  const adapters = createAdapters({ execute, progress: () => {} });
  assert.equal(await adapters.viewer(), 'me');
  assert.deepEqual(await adapters.listOpenPrs('acme/widget'), [{ number: 1 }]);
  assert.equal(await adapters.reviewCommit('acme/widget', 7, 'me'), 'new');
  assert.deepEqual(calls[1].slice(0, 7), ['gh', 'pr', 'list', '--repo', 'acme/widget', '--state', 'open']);
  assert.deepEqual(calls[2], ['gh', 'api', '--paginate', '--slurp', 'repos/acme/widget/pulls/7/reviews']);
  assert(calls.every(([, sub, verb]) => !['create', 'review', 'comment', 'edit', 'merge'].includes(verb) && sub !== 'review'));
});

test('references in the PR body to other PRs and issues are found, without self, closed issues or AB# items', () => {
  const body = 'Stays a draft until acme/tools#163 merges. See #12, https://github.com/acme/widget/pull/9 and #12 again. Fixes #17. AB#1234. This is #42.';
  assert.deepEqual(prReferences(body, PR, { exclude: [17] }).map((ref) => `${ref.owner}/${ref.repo}#${ref.number}`),
    ['acme/widget#9', 'acme/tools#163', 'acme/widget#12']);
  // A later bare #163 is shorthand for the explicit acme/tools#163, not this repo's #163.
  assert.deepEqual(prReferences('Needs acme/tools#163. Once #163 merges, move the pin.', PR).map((ref) => `${ref.owner}/${ref.repo}#${ref.number}`), ['acme/tools#163']);
  // A crafted body can't steer the lookup to another API path.
  assert.deepEqual(prReferences('See ../..#1 and https://github.com/../../pull/2', PR), []);
  const many = Array.from({ length: 9 }, (_, i) => `#${i + 100}`).join(' ');
  assert.equal(prReferences(many, PR).length, 5);
});

test('preparation records the draft state and the state of referenced PRs, and survives a failed lookup', async (t) => {
  const looked = [];
  const { prepared: result } = await prepared(t, {
    metadata: { title: 'Fixture', body: 'Stays a draft until acme/tools#163 merges; see #12.', isDraft: false },
    reference: (args) => {
      looked.push(args[1]);
      if (args[1].endsWith('/12')) throw new Error('not found');
      return JSON.stringify({ title: 'Tool flags', state: 'closed', pullRequest: true, mergedAt: '2026-11-11T08:57:15Z' });
    },
  });
  const context = JSON.parse(await readFile(result.context, 'utf8'));
  assert.deepEqual(looked, ['repos/acme/tools/issues/163', 'repos/acme/widget/issues/12']);
  assert.equal(context.isDraft, false);
  assert.deepEqual(context.references[0], { reference: 'acme/tools#163', title: 'Tool flags', state: 'closed', pullRequest: true, mergedAt: '2026-11-11T08:57:15Z' });
  assert.match(context.references[1].error, /not found/);
});

test('watch reads open PRs with mergeable, and a departed PR outcome with one read-only call', async () => {
  const calls = [];
  const execute = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'pr' && args[1] === 'list') return '[]';
    return JSON.stringify({ state: 'MERGED', mergedAt: '2026-11-23T10:00:00Z', mergedBy: { login: 'lee-park' }, title: 'feat: x', author: { login: 'alice' }, url: 'https://github.com/acme/widget/pull/7' });
  };
  const adapters = createAdapters({ execute, progress: () => {} });
  await adapters.listOpenPrs('acme/widget');
  assert.match(calls[0].join(' '), /--json \S*,mergeable$/);
  assert.deepEqual(await adapters.prOutcome('acme/widget', 7), {
    state: 'MERGED', mergedAt: '2026-11-23T10:00:00Z', mergedBy: 'lee-park', title: 'feat: x', author: 'alice', url: 'https://github.com/acme/widget/pull/7',
  });
  assert.deepEqual(calls[1], ['gh', 'pr', 'view', '7', '--repo', 'acme/widget', '--json', 'state,mergedAt,mergedBy,title,author,url']);
});
