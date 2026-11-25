import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { PROVIDERS, runCommand } from './adapters.mjs';
import { checkProvider } from './setup.mjs';
import { aliasProblem, parseRepo, pickFromList, REPO_LABEL_MAX, repoLabels } from './select.mjs';
import { PROVIDER_NAMES } from './ui.mjs';

// The Settings screen (`c` in the picker, or `reviewpr settings`): which CLI
// runs the agents, its model, the bell when a run is done, and the aliases
// that name repositories in the PR list. All are saved in this project's
// config.json only; neither CLI's own settings are touched.

// A short list per provider; "Other" takes any ID. The run's model check
// stops at the first agent if an ID is wrong.
export const MODELS = {
  copilot: ['claude-haiku-5.5', 'claude-sonnet-5.5', 'claude-opus-5.5'],
  claude: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
};
const DEFAULT_MODEL = { copilot: 'claude-sonnet-5.5', claude: 'claude-sonnet-5-5' };

// Top-level model and checkModel are Copilot's; Claude Code's sit under "claude".
const slot = (config, provider) => (provider === 'claude' ? config.claude ?? {} : config);

export function currentSettings(config) {
  const provider = config.provider ?? 'copilot';
  const { model, checkModel } = slot(config, provider);
  return { provider, model: model ?? null, checkModel: checkModel ?? model ?? null };
}

// "Provider: Claude Code · Model: claude-sonnet-5-5", for the picker; a bell
// that is off is mentioned too.
export function settingsLine(config) {
  const { provider, model, checkModel } = currentSettings(config);
  const check = checkModel && checkModel !== model ? ` · check: ${checkModel}` : '';
  return `Provider: ${PROVIDER_NAMES[provider]} · Model: ${model ?? 'not set'}${check}${config.notify === false ? ' · bell off' : ''}`;
}

// The bell when a review or summary is done (src/bell.mjs): on unless "notify": false.
const BELL = (config) => (config.notify === false ? 'off' : 'on, when a review or summary is done');

// Choosing a model sets the main and the check model of that provider.
export function withModel(config, provider, model) {
  const before = slot(config, provider);
  const note = before.checkModel && before.checkModel !== model ? `The check model was ${before.checkModel}; it is now ${model} too.` : null;
  const models = { ...before, model, checkModel: model };
  return { config: provider === 'claude' ? { ...config, claude: models } : { ...config, ...models }, note };
}

// A provider without a model yet gets the default one.
export function withProvider(config, provider) {
  const next = { ...config, provider };
  if (slot(next, provider).model) return { config: next, note: null };
  const model = DEFAULT_MODEL[provider];
  return { config: withModel(next, provider, model).config, note: `Model set to ${model}; change it under Model.` };
}

// The raw config's repositories: [{ repo: "owner/repo", alias }], from
// "repositories" (strings or objects) or the older "defaultRepository".
// Entries that aren't a repository are left out; readConfig reports them.
export function repoEntries(config) {
  const listed = Array.isArray(config.repositories) ? config.repositories : config.defaultRepository !== undefined ? [config.defaultRepository] : [];
  const seen = new Set();
  return listed.flatMap((entry) => {
    const isObject = entry !== null && typeof entry === 'object';
    const repo = parseRepo(isObject ? entry.repo : entry);
    if (!repo || seen.has(repo)) return [];
    seen.add(repo);
    return [{ repo, alias: isObject && typeof entry.alias === 'string' ? entry.alias : null }];
  });
}

// Sets (or, with an empty alias, removes) one repository's alias in the raw
// config: its entry becomes { repo, alias }, or a plain "owner/repo" again.
// Other entries are kept as written. A config that still uses
// "defaultRepository" moves to "repositories".
export function withAlias(config, repo, alias) {
  const listed = Array.isArray(config.repositories) ? config.repositories : config.defaultRepository !== undefined ? [config.defaultRepository] : [];
  const repositories = listed.map((entry) => {
    const isObject = entry !== null && typeof entry === 'object';
    if (parseRepo(isObject ? entry.repo : entry) !== repo) return entry;
    return alias ? { repo, alias } : repo;
  });
  const { defaultRepository, ...rest } = config;
  return { ...rest, repositories };
}

// "2 · aliases: fe, be" for the Settings row.
function repositoriesRow(entries) {
  if (!entries.length) return 'none: list them in config.json';
  const aliases = entries.map((entry) => entry.alias).filter(Boolean);
  return `${entries.length} · ${aliases.length ? `aliases: ${aliases.join(', ')}` : 'no aliases'}`;
}

// Written back with the file's own indentation. Other keys are kept.
export function formatConfig(config, original = '') {
  const indent = /^([ \t]+)"/m.exec(original)?.[1] ?? '  ';
  return `${JSON.stringify(config, null, indent)}\n`;
}

const validId = (id) => /^[\w.:@/-]+$/.test(id);

// Why a provider can't be chosen here, or null when it can: its CLI must
// answer --version, and Claude Code isn't supported on Windows yet.
export async function unavailable({ execute = runCommand, platform = process.platform } = {}) {
  const reasons = await Promise.all(PROVIDERS.map((provider) => {
    if (provider === 'claude' && platform === 'win32') return 'not supported on Windows yet';
    return execute(provider, ['--version']).then(() => null, () => `${provider} not found`);
  }));
  return Object.fromEntries(PROVIDERS.map((provider, i) => [provider, reasons[i]]));
}

// A warning when the chosen provider isn't ready, such as not signed in.
const readiness = (provider) => checkProvider(provider, runCommand).then(() => null, (error) => error.message.split('\n')[0]);

async function typeId(question, { input, output }) {
  const rl = createInterface({ input, output, terminal: Boolean(output.isTTY) });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export async function openSettings({
  configPath, input = process.stdin, output = process.stderr,
  pick = (title, rows, options) => pickFromList(title, rows, { input, output, ...options }),
  ask = (question) => typeId(question, { input, output }),
  available = unavailable, ready = readiness,
} = {}) {
  for (;;) {
    const text = await readFile(configPath, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') throw new Error(`No ${configPath} yet. Copy config.example.json to config.json first.`, { cause: error });
      throw error;
    });
    const config = JSON.parse(text);
    const now = currentSettings(config);
    const choice = await pick('Settings (saved in config.json, for pr-review only)', [
      `Provider  ${PROVIDER_NAMES[now.provider]}`,
      `Model     ${now.model ?? 'not set'}${now.checkModel && now.checkModel !== now.model ? ` · check: ${now.checkModel}` : ''}`,
      `Bell      ${BELL(config)}`,
      `Repositories  ${repositoriesRow(repoEntries(config))}`,
      'Done',
    ], { hint: 'Enter change · q done' });
    if (choice === null || choice === 4) return;
    if (choice === 3) {
      await editAliases({ configPath, pick, ask, output });
      continue;
    }
    let change;
    if (choice === 2) {
      const on = config.notify === false;
      change = { config: { ...config, notify: on }, note: on ? 'The terminal bell rings when a review or summary is done or fails (runs over 30 s).' : null };
    } else if (choice === 0) {
      const reasons = await available();
      const rows = PROVIDERS.map((provider) => (reasons[provider] ? { heading: `${PROVIDER_NAMES[provider]} (${reasons[provider]})` } : PROVIDER_NAMES[provider]));
      const picked = await pick('Provider: where the models come from', rows, { initial: PROVIDERS.indexOf(now.provider), hint: 'Enter choose · q back' });
      if (picked === null || PROVIDERS[picked] === now.provider) continue;
      change = withProvider(config, PROVIDERS[picked]);
      const warning = await ready(PROVIDERS[picked]);
      if (warning) change.note = [change.note, `Warning: ${warning}`].filter(Boolean).join('\n');
    } else {
      const models = [...new Set([...(now.model ? [now.model] : []), ...MODELS[now.provider]])];
      const picked = await pick(`Model for ${PROVIDER_NAMES[now.provider]} (main and check)`, [...models, 'Other (type an ID)'], {
        initial: Math.max(0, models.indexOf(now.model)), hint: 'Enter choose · q back',
      });
      if (picked === null) continue;
      let model = models[picked];
      if (!model) {
        model = String(await ask(`Model ID for ${PROVIDER_NAMES[now.provider]}: `) ?? '').trim();
        if (!model) continue;
        if (!validId(model)) {
          output.write(`Not a model ID: ${model}\n`);
          continue;
        }
      }
      if (model === now.model && now.checkModel === model) continue;
      change = withModel(config, now.provider, model);
    }
    await writeFile(configPath, formatConfig(change.config, text));
    output.write(`Saved: ${settingsLine(change.config)}${change.note ? `\n${change.note}` : ''}\n`);
  }
}

// The Repositories screen: one row per configured repository with its alias
// (or the label it gets without one). Enter asks for an alias; empty removes
// it, and one aliasProblem refuses is explained and asked again. Each change
// is saved at once and the screen stays open; q or Done goes back.
async function editAliases({ configPath, pick, ask, output }) {
  let index = 0;
  for (;;) {
    const text = await readFile(configPath, 'utf8');
    const config = JSON.parse(text);
    const entries = repoEntries(config);
    if (!entries.length) {
      output.write('No repositories yet: list them in config.json as "repositories": ["owner/repo"].\n');
      return;
    }
    const repos = entries.map((entry) => entry.repo);
    const aliases = Object.fromEntries(entries.filter((entry) => entry.alias).map((entry) => [entry.repo, entry.alias]));
    // What the PR list shows now, so a repository without an alias shows its
    // label (with one repository, its name).
    const labels = repoLabels(repos, aliases) ?? { [repos[0]]: repos[0].split('/')[1] };
    const width = Math.max(...repos.map((repo) => repo.length));
    const rows = entries.map((entry) => `${entry.repo.padEnd(width)}  ${entry.alias ?? `(none: ${labels[entry.repo]})`}`);
    const picked = await pick('Repositories (aliases name them in the PR list)', [...rows, 'Done'], { initial: index, hint: 'Enter set alias · q back' });
    if (picked === null || picked === entries.length) return;
    index = picked;
    const { repo, alias: before } = entries[picked];
    let alias;
    for (;;) {
      alias = String(await ask(`Alias for ${repo} (empty removes it, at most ${REPO_LABEL_MAX} characters): `) ?? '').trim();
      const problem = alias ? aliasProblem(alias, repo, repos, aliases) : null;
      if (!problem) break;
      output.write(`Not saved: ${problem}.\n`);
    }
    if ((alias || null) === before) continue;
    await writeFile(configPath, formatConfig(withAlias(config, repo, alias), text));
    output.write(alias ? `Saved: ${repo} shows as ${alias}.\n` : `Saved: ${repo} has no alias.\n`);
  }
}
