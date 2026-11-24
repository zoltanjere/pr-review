import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkClaudeModel, claudeArgs, claudeEnv, claudeLive, claudeProjectsDir, claudeResponse, claudeSkillMissing,
  claudeSubagents, claudeUsage, modelAlias, projectKey, removeProjectFolder,
} from '../src/claude.mjs';

const MODEL = 'claude-sonnet-5-5';
const use = (id, name, input, extra = {}) => ({ type: 'assistant', parent_tool_use_id: null, message: { id: `m-${id}`, model: MODEL, content: [{ type: 'tool_use', id, name, input }] }, ...extra });
const result = (id, content, isError = false, extra = {}) => ({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, ...extra });
const done = (text = 'answer', extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: text, ...extra });

test('claude runs with per-run isolation flags, read-only git and the prompt after --', () => {
  const args = claudeArgs({ prompt: '--looks-like-a-flag', model: MODEL, workspace: '/w', readOnlyGit: ['diff', 'log'] });
  assert.deepEqual(args.slice(0, 4), ['-p', '--setting-sources', '', '--strict-mcp-config']);
  for (const [flag, value] of [['--permission-mode', 'dontAsk'], ['--tools', 'Skill,Read,Grep,Glob,Bash,Agent'], ['--add-dir', '/w'],
    ['--plugin-dir', join('/w', 'prreview-plugin')], ['--model', MODEL], ['--output-format', 'stream-json'], ['--allowed-tools', 'Bash(git diff:*)']]) {
    assert.equal(args[args.indexOf(flag) + 1], value, flag);
  }
  assert(args.includes('--no-session-persistence'));
  assert(args.includes('Bash(git log:*)'));
  assert(!args.some((arg) => /^Bash(\(\*?\))?$/.test(arg)), 'no blanket shell allow');
  assert.deepEqual(args.slice(args.indexOf('--disallowed-tools') + 1, args.indexOf('--')), ['Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch']);
  assert.equal(args.at(-2), '--');
  assert.equal(args.at(-1), '--looks-like-a-flag\n\nFor every subagent you launch with the Agent tool, set its model argument to sonnet.');
  assert.equal(claudeArgs({ prompt: 'p', model: 'some-model', workspace: '/w', readOnlyGit: [] }).at(-1), 'p');
  assert.equal(claudeEnv({ PATH: '/bin' }).CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.equal(claudeEnv({ PATH: '/bin' }).PATH, '/bin');
  assert.deepEqual(['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet', 'gpt-5'].map(modelAlias), ['haiku', 'opus', null, null]);
});

test('a Claude run fails on an error result, a missing result or another model, subagents included', () => {
  assert.doesNotThrow(() => checkClaudeModel([use('a', 'Read', {}), done()], MODEL));
  assert.throws(() => checkClaudeModel([], MODEL), /no result/);
  assert.throws(() => checkClaudeModel([done('Usage limit reached', { is_error: true })], MODEL), /session failed: Usage limit reached/);
  assert.throws(() => checkClaudeModel([done('', { subtype: 'error_max_turns' })], MODEL), /session failed: error_max_turns/);
  const sub = use('b', 'Bash', {}, { parent_tool_use_id: 'a' });
  sub.message.model = 'claude-haiku-5-5';
  assert.throws(() => checkClaudeModel([sub, done()], MODEL), /Expected model claude-sonnet-5-5, but an agent used claude-haiku-5-5/);
});

test('the skill counts only as the plugin copy, loaded by the main agent', () => {
  const loaded = [use('s', 'Skill', { skill: 'prreview:code-review' }), result('s', 'Launching skill: prreview:code-review')];
  assert.equal(claudeSkillMissing(loaded, 'code-review'), null);
  assert.equal(claudeSkillMissing([use('s', 'Skill', { skill: 'prreview:code-review' }), result('s', [{ type: 'text', text: 'Launching skill: prreview:code-review' }])], 'code-review'), null);
  for (const events of [
    [],
    [use('s', 'Skill', { skill: 'code-review' }), result('s', 'Launching skill: code-review')],
    [use('s', 'Skill', { skill: 'prreview:code-review' }), result('s', 'Unknown skill', true)],
    [use('s', 'Skill', { skill: 'prreview:code-review' }, { parent_tool_use_id: 'x' }), result('s', 'Launching skill: prreview:code-review')],
  ]) {
    assert.match(claudeSkillMissing(events, 'code-review'), /did not load the prreview:code-review skill/);
  }
});

test('subagents count when launched in the foreground and finished without error', () => {
  assert.equal(claudeSubagents([
    use('a', 'Agent', { prompt: 'standards' }), result('a', 'ok'),
    use('b', 'Agent', { prompt: 'spec', run_in_background: true }), result('b', 'started'),
    use('c', 'Agent', { prompt: 'failed' }), result('c', 'boom', true),
    use('d', 'Task', { prompt: 'older name' }), result('d', 'ok'),
    use('e', 'Read', {}), result('e', 'ok'),
  ]), 2);
});

test('the response is the result text; usage is tokens only, live and final', () => {
  assert.equal(claudeResponse([done('## Standards')]), '## Standards');
  assert.throws(() => claudeResponse([done('  ')]), /no response/);
  const final = done('x', { modelUsage: { [MODEL]: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 30, cacheCreationInputTokens: 400 }, 'claude-haiku-5-5': { inputTokens: 5000 } } });
  assert.deepEqual(claudeUsage([final]), { premium: null, tokens: 5433, credits: null });
  assert.deepEqual(claudeUsage([]), { premium: null, tokens: null, credits: null });
  const updates = [];
  const live = claudeLive((now) => updates.push(now.tokens));
  const message = (id, output) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: 10, output_tokens: output } } });
  live.line(message('m1', 5));
  live.line(message('m1', 5));
  live.line(message('m2', 1));
  live.line('{"type":"user"}');
  live.line('{"type":"assistant", broken');
  assert.deepEqual(updates, [15, 15, 26]);
});

test('the checkout\'s Claude project folder is removed, and only that one', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'claude-projects-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'pr-review-x', 'checkout');
  await mkdir(checkout, { recursive: true });
  const projects = join(root, 'projects');
  const mine = join(projects, projectKey(checkout));
  const other = join(projects, '-Users-someone-project');
  await mkdir(join(mine, 'session', 'subagents'), { recursive: true });
  await mkdir(other, { recursive: true });
  await removeProjectFolder(checkout, projects);
  await assert.rejects(access(mine), { code: 'ENOENT' });
  await access(other);
  assert.equal(projectKey('/private/tmp/pr-review-a1/checkout'), '-private-tmp-pr-review-a1-checkout');
  assert.equal(claudeProjectsDir({ CLAUDE_CONFIG_DIR: '/c' }), join('/c', 'projects'));
});
