import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentSettings, formatConfig, openSettings, repoEntries, settingsLine, withAlias, withModel, withProvider } from '../src/settings.mjs';
import { costLines } from '../src/confirm.mjs';
import { plainReporter } from '../src/ui.mjs';

const COPILOT = { model: 'claude-haiku-5.5', defaultRepository: 'acme/widget', watch: { intervalMinutes: 5 } };

test('the current setting and its line come from the active provider\'s models', () => {
  assert.deepEqual(currentSettings(COPILOT), { provider: 'copilot', model: 'claude-haiku-5.5', checkModel: 'claude-haiku-5.5' });
  assert.equal(settingsLine(COPILOT), 'Provider: Copilot · Model: claude-haiku-5.5');
  const claude = { ...COPILOT, provider: 'claude', claude: { model: 'claude-sonnet-5-5', checkModel: 'claude-haiku-5-5' } };
  assert.equal(settingsLine(claude), 'Provider: Claude Code · Model: claude-sonnet-5-5 · check: claude-haiku-5-5');
  assert.equal(settingsLine({ provider: 'claude' }), 'Provider: Claude Code · Model: not set');
});

test('a chosen model sets main and check model of that provider only, and says when check changed', () => {
  const copilot = withModel({ ...COPILOT, checkModel: 'claude-opus-5.5' }, 'copilot', 'claude-sonnet-5.5');
  assert.deepEqual(copilot.config, { ...COPILOT, model: 'claude-sonnet-5.5', checkModel: 'claude-sonnet-5.5' });
  assert.equal(copilot.note, 'The check model was claude-opus-5.5; it is now claude-sonnet-5.5 too.');
  const claude = withModel(COPILOT, 'claude', 'claude-opus-5-5');
  assert.deepEqual(claude.config, { ...COPILOT, claude: { model: 'claude-opus-5-5', checkModel: 'claude-opus-5-5' } });
  assert.equal(claude.note, null);
});

test('switching provider keeps each provider\'s models and gives a first-time provider the default', () => {
  const first = withProvider(COPILOT, 'claude');
  assert.deepEqual(first.config, { ...COPILOT, provider: 'claude', claude: { model: 'claude-sonnet-5-5', checkModel: 'claude-sonnet-5-5' } });
  assert.match(first.note, /Model set to claude-sonnet-5-5/);
  const back = withProvider(first.config, 'copilot');
  assert.equal(back.config.model, 'claude-haiku-5.5');
  assert.equal(back.config.claude.model, 'claude-sonnet-5-5');
  assert.equal(back.note, null);
});

test('the config is written back with its own indentation', () => {
  assert.equal(formatConfig({ a: 1 }, '{\n    "a": 0\n}\n'), '{\n    "a": 1\n}\n');
  assert.equal(formatConfig({ a: 1 }), '{\n  "a": 1\n}\n');
});

async function screen(t, config, answers, { ask = async () => '', available = async () => ({ copilot: null, claude: null }), ready = async () => null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'settings-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, `${JSON.stringify(config, null, 4)}\n`);
  const shown = [];
  let text = '';
  await openSettings({
    configPath, ask, available, ready, output: { write: (chunk) => { text += chunk; } },
    pick: async (title, rows) => { shown.push({ title, rows }); return answers.shift() ?? null; },
  });
  return { config: JSON.parse(await readFile(configPath, 'utf8')), raw: await readFile(configPath, 'utf8'), shown, text };
}

test('Settings: choose Claude Code, then a model; other keys and indentation stay', async (t) => {
  const { config, raw, shown, text } = await screen(t, COPILOT, [0, 1, 1, 1, 4]);
  assert.deepEqual(shown[0].rows, ['Provider  Copilot', 'Model     claude-haiku-5.5', 'Bell      on, when a review or summary is done', 'Repositories  1 · no aliases', 'Done']);
  assert.deepEqual(shown[1].rows, ['Copilot', 'Claude Code']);
  assert.deepEqual(shown[3].rows, ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'Other (type an ID)']);
  assert.deepEqual(config, { ...COPILOT, provider: 'claude', claude: { model: 'claude-haiku-5-5', checkModel: 'claude-haiku-5-5' } });
  assert.match(raw, /^ {4}"model"/m);
  assert.match(text, /Saved: Provider: Claude Code · Model: claude-sonnet-5-5\nModel set to claude-sonnet-5-5/);
  assert.match(text, /Saved: Provider: Claude Code · Model: claude-haiku-5-5\n/);
});

test('Settings: a missing CLI can\'t be chosen; Other takes a typed ID and rejects a bad one', async (t) => {
  const missing = await screen(t, COPILOT, [0], { available: async () => ({ copilot: null, claude: 'claude not found' }) });
  assert.deepEqual(missing.shown[1].rows, ['Copilot', { heading: 'Claude Code (claude not found)' }]);
  const signedOut = await screen(t, COPILOT, [0, 1], { ready: async (provider) => `${provider} isn't signed in. Run: claude auth login` });
  assert.equal(signedOut.config.provider, 'claude');
  assert.match(signedOut.text, /Warning: claude isn't signed in\. Run: claude auth login\n/);
  const typed = await screen(t, COPILOT, [1, 3], { ask: async () => ' future-model ' });
  assert.equal(typed.config.model, 'future-model');
  assert.equal(typed.config.checkModel, 'future-model');
  const bad = await screen(t, COPILOT, [1, 3], { ask: async () => 'two words' });
  assert.deepEqual(bad.config, COPILOT);
  assert.match(bad.text, /Not a model ID: two words/);
  const cancelled = await screen(t, COPILOT, [1, null, 4]);
  assert.deepEqual(cancelled.config, COPILOT);
});

test('withAlias sets or removes one entry\'s alias and keeps the others as written', () => {
  const config = { model: 'm', repositories: ['https://github.com/acme/word-word-word-fe/', { repo: 'acme/word-word-word-be', alias: 'be' }, 'acme/api'] };
  const set = withAlias(config, 'acme/word-word-word-fe', 'fe');
  assert.deepEqual(set.repositories, [{ repo: 'acme/word-word-word-fe', alias: 'fe' }, { repo: 'acme/word-word-word-be', alias: 'be' }, 'acme/api']);
  assert.deepEqual(withAlias(set, 'acme/word-word-word-be', '').repositories, [{ repo: 'acme/word-word-word-fe', alias: 'fe' }, 'acme/word-word-word-be', 'acme/api']);
  assert.deepEqual(repoEntries(set), [{ repo: 'acme/word-word-word-fe', alias: 'fe' }, { repo: 'acme/word-word-word-be', alias: 'be' }, { repo: 'acme/api', alias: null }]);
  // The older single key moves to "repositories".
  assert.deepEqual(withAlias(COPILOT, 'acme/widget', 'w'), { model: 'claude-haiku-5.5', repositories: [{ repo: 'acme/widget', alias: 'w' }], watch: { intervalMinutes: 5 } });
});

test('Settings: Repositories sets an alias, refuses a taken or long one, removes one; the file keeps its form', async (t) => {
  const config = { model: 'm', repositories: ['acme/word-word-word-fe', { repo: 'acme/word-word-word-be', alias: 'be' }], notify: true };
  const answers = ['BE', 'a-much-too-long-alias', 'fe', ''];
  const { config: saved, raw, shown, text } = await screen(t, config, [3, 0, 1, null, 4], { ask: async () => answers.shift() });
  assert.equal(shown[0].rows[3], 'Repositories  2 · aliases: be');
  assert.deepEqual(shown[1].rows, ['acme/word-word-word-fe  (none: word-word-wor…)', 'acme/word-word-word-be  be', 'Done']);
  assert.deepEqual(shown[2].rows, ['acme/word-word-word-fe  fe', 'acme/word-word-word-be  be', 'Done']);
  assert.match(text, /Not saved: "BE" is already used by acme\/word-word-word-be\.\n/);
  assert.match(text, /Not saved: an alias is 1 to 14 characters\.\n/);
  assert.match(text, /Saved: acme\/word-word-word-fe shows as fe\.\nSaved: acme\/word-word-word-be has no alias\.\n/);
  assert.deepEqual(saved, { model: 'm', repositories: [{ repo: 'acme/word-word-word-fe', alias: 'fe' }, 'acme/word-word-word-be'], notify: true });
  assert.match(raw, /^ {4}"model"/m);
  const none = await screen(t, { model: 'm' }, [3, 4]);
  assert.match(none.text, /No repositories yet/);
});

test('Settings without a config.json says to copy the example', async () => {
  await assert.rejects(openSettings({ configPath: join(tmpdir(), 'no-such-dir-settings', 'config.json'), pick: async () => null }), /yet\. Copy config\.example\.json to config\.json first/);
});

test('reviewpr settings needs a terminal and opens the screen', async (t) => {
  const { main } = await import('../src/review.mjs');
  let opened = 0;
  await assert.rejects(main(['settings'], { interactive: false }), /Settings need a terminal/);
  await assert.rejects(main(['settings', 'x'], { interactive: true }), /Usage/);
  await main(['settings'], { interactive: true, openSettings: async () => { opened++; } });
  assert.equal(opened, 1);
  void t;
});

test('c in the picker opens Settings, then the list comes back with the new line', async (t) => {
  const { main } = await import('../src/review.mjs');
  const { OPEN_SETTINGS } = await import('../src/select.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'settings-pick-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify(COPILOT));
  const lines = [];
  const answers = [OPEN_SETTINGS, null];
  await main([], {
    configPath, interactive: true,
    pick: async (repo, adapters, { settings }) => { lines.push(settings); return answers.shift(); },
    openSettings: async () => writeFile(configPath, JSON.stringify({ ...COPILOT, model: 'claude-opus-5.5' })),
  });
  assert.deepEqual(lines, ['Provider: Copilot · Model: claude-haiku-5.5', 'Provider: Copilot · Model: claude-opus-5.5']);
});

test('the run shows the provider, and a token-only Claude session has no premium requests', () => {
  const lines = [];
  plainReporter((line) => lines.push(line)).event('model', { provider: 'claude', model: 'claude-sonnet-5-5' });
  assert.deepEqual(lines, ['[progress] Provider: Claude Code · Model: claude-sonnet-5-5']);
  const table = costLines([{ stage: 'code-review', premium: null, tokens: 412_000, credits: null }]);
  assert.match(table[2], /code-review +1 session +- premium +412k tokens +- AI credits$/);
  assert.doesNotMatch(table[2], /unknown/);
});

test('Settings: Bell turns the done bell off and on again; the picker line says when it is off', async (t) => {
  const off = await screen(t, COPILOT, [2, 3]);
  assert.equal(off.config.notify, false);
  assert.deepEqual(off.shown[1].rows[2], 'Bell      off');
  assert.equal(settingsLine(off.config), 'Provider: Copilot · Model: claude-haiku-5.5 · bell off');
  const on = await screen(t, { ...COPILOT, notify: false }, [2, 3]);
  assert.equal(on.config.notify, true);
  assert.match(on.text, /The terminal bell rings when a review or summary is done or fails/);
});

test('notify in config.json must be true or false', async (t) => {
  const { readConfig } = await import('../src/adapters.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'notify-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ model: 'm', notify: 'yes' }));
  await assert.rejects(readConfig(path), /notify .* must be true or false/);
  await writeFile(path, JSON.stringify({ model: 'm', notify: false }));
  assert.equal((await readConfig(path)).notify, false);
});

test('aliases changed in Settings apply to the list right away, without a restart', async (t) => {
  const { main } = await import('../src/review.mjs');
  const { OPEN_SETTINGS } = await import('../src/select.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'settings-alias-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ model: 'm', repositories: ['acme/word-word-word-fe', 'acme/word-word-word-be'] }));
  const seen = [];
  const answers = [OPEN_SETTINGS, null];
  await main([], {
    configPath, interactive: true,
    pick: async (repos, adapters, { aliases }) => { seen.push(aliases); return answers.shift(); },
    openSettings: async () => writeFile(configPath, JSON.stringify({ model: 'm', repositories: [{ repo: 'acme/word-word-word-fe', alias: 'fe' }, 'acme/word-word-word-be'] })),
  });
  assert.deepEqual(seen, [{}, { 'acme/word-word-word-fe': 'fe' }]);
});
