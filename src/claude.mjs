import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The Claude Code provider: agents run as `claude -p`, signed in with the
// person's own Claude login. Everything is set per run by flags and one
// environment variable; nothing in ~/.claude is configured (plans/model-provider.md).
//
// - --setting-sources "" and --strict-mcp-config: the person's settings,
//   CLAUDE.md files, hooks, plugins and MCP servers are not loaded.
// - CLAUDE_CODE_DISABLE_AUTO_MEMORY=1: no memory is read or written.
// - --permission-mode dontAsk: anything not allowed is refused, never asked.
//   Claude Code also allows read-only commands in the checkout on its own;
//   reads outside it, `git -C` and writes are refused.
// - The pipeline skills come from a plugin in the workspace, so they load as
//   prreview:<name>, never a built-in or personal skill of the same name.

export const PLUGIN = 'prreview';
export const PLUGIN_DIR = 'prreview-plugin';
const TOOLS = 'Skill,Read,Grep,Glob,Bash,Agent';
const DENY = ['Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch'];

export const claudeEnv = (env = process.env) => ({ ...env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });

// claude-sonnet-5-5 → sonnet: the Agent tool takes a family alias.
export function modelAlias(model) {
  return /^claude-(haiku|sonnet|opus|fable)-\d/.exec(model)?.[1] ?? null;
}

export function claudeArgs({ prompt, model, workspace, readOnlyGit }) {
  const alias = modelAlias(model);
  return [
    '-p',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--permission-mode', 'dontAsk',
    '--tools', TOOLS,
    '--add-dir', workspace,
    '--plugin-dir', join(workspace, PLUGIN_DIR),
    '--model', model,
    '--output-format', 'stream-json',
    '--verbose',
    '--allowed-tools', ...readOnlyGit.map((subcommand) => `Bash(git ${subcommand}:*)`),
    '--disallowed-tools', ...DENY,
    // The list options above take several values; -- ends them before the prompt.
    '--',
    alias ? `${prompt}\n\nFor every subagent you launch with the Agent tool, set its model argument to ${alias}.` : prompt,
  ];
}

// Wording that differs by provider, for the prompts.
export const CLAUDE_WORDING = {
  skill: (name) => `Load the ${PLUGIN}:${name} skill with the Skill tool first, then follow it.`,
  subagents: 'the Agent tool in the foreground (never in the background)',
};

// The pipeline skills as a plugin: <workspace>/prreview-plugin/skills/<name>.
export async function stagePlugin(workspace, copy) {
  const root = join(workspace, PLUGIN_DIR);
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await writeFile(join(root, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: PLUGIN, version: '1.0.0' })}\n`);
  await copy(join(root, 'skills'));
}

// --- Checks on a Claude run's stream-json events ------------------------------

const topLevel = (event) => !event.parent_tool_use_id;
const toolUses = (events, name) => events.filter((event) => event.type === 'assistant' && topLevel(event))
  .flatMap((event) => event.message?.content ?? []).filter((block) => block.type === 'tool_use' && name(block.name));
const toolResult = (events, id) => events.filter((event) => event.type === 'user')
  .flatMap((event) => (Array.isArray(event.message?.content) ? event.message.content : []))
  .find((block) => block.type === 'tool_result' && block.tool_use_id === id);
const text = (content) => (Array.isArray(content) ? content.map((part) => part?.text ?? '').join('\n') : String(content ?? ''));

export function claudeResult(events) {
  const result = events.findLast((event) => event.type === 'result');
  if (!result) throw new Error('Claude Code returned no result');
  if (result.is_error || result.subtype !== 'success') {
    throw new Error(`Claude Code session failed: ${result.result || result.subtype || 'unknown error'}`);
  }
  return result;
}

export function checkClaudeModel(events, model) {
  claudeResult(events);
  const other = events.find((event) => event.type === 'assistant' && event.message?.model !== model);
  if (other) throw new Error(`Expected model ${model}, but an agent used ${other.message?.model ?? 'an unreported model'}`);
}

// Returns the retry note for a skill that wasn't loaded, or null.
export function claudeSkillMissing(events, skill) {
  const name = `${PLUGIN}:${skill}`;
  const loaded = toolUses(events, (tool) => tool === 'Skill').some((use) => {
    if (use.input?.skill !== name) return false;
    const result = toolResult(events, use.id);
    return Boolean(result && !result.is_error && text(result.content).includes(`Launching skill: ${name}`));
  });
  return loaded ? null : `did not load the ${name} skill. Load it with the Skill tool first, then follow it`;
}

// Foreground subagents the main agent launched that finished without error.
export function claudeSubagents(events) {
  return toolUses(events, (tool) => tool === 'Agent' || tool === 'Task')
    .filter((use) => !use.input?.run_in_background)
    .filter((use) => {
      const result = toolResult(events, use.id);
      return result && !result.is_error;
    }).length;
}

export function claudeResponse(events) {
  const response = claudeResult(events).result;
  if (typeof response !== 'string' || !response.trim()) throw new Error('Claude Code returned no response');
  return response;
}

const usageTokens = (u = {}) => (u.input_tokens ?? u.inputTokens ?? 0) + (u.output_tokens ?? u.outputTokens ?? 0)
  + (u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? 0) + (u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? 0);

// Tokens only: a Claude plan has no AI credits or premium requests, and the
// reported costUSD is an API list price, not what the plan charges.
export function claudeUsage(events) {
  const result = events.findLast((event) => event.type === 'result');
  const models = Object.values(result?.modelUsage ?? {});
  return { premium: null, tokens: models.length ? models.reduce((sum, usage) => sum + usageTokens(usage), 0) : null, credits: null };
}

// Live tokens from the streamed messages; a message split into several
// events carries the same id and usage, so each id counts once.
export function claudeLive(onUpdate) {
  const seen = new Map();
  return {
    line(line) {
      if (!line.includes('"type":"assistant"')) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      const { id, usage } = event.message ?? {};
      if (!id || !usage) return;
      seen.set(id, usageTokens(usage));
      onUpdate({ tokens: [...seen.values()].reduce((sum, tokens) => sum + tokens, 0) });
    },
    stop() {},
  };
}

// Claude Code keeps a folder per working directory in ~/.claude/projects and
// writes subagent notes there even without session persistence. The checkout
// is a disposable folder, so its project folder is ours to remove.
export const projectKey = (path) => path.replace(/[^a-zA-Z0-9]/g, '-');

export function claudeProjectsDir(env = process.env) {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
}

export async function removeProjectFolder(checkout, projectsDir) {
  const paths = new Set([checkout, await realpath(checkout).catch(() => checkout)]);
  for (const path of paths) await rm(join(projectsDir, projectKey(path)), { recursive: true, force: true, maxRetries: 5 });
}
