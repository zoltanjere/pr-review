import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter, runSteps } from '../src/steps.mjs';
import { palette, plainReporter } from '../src/ui.mjs';

const capture = () => {
  const lines = [];
  return { lines, reporter: plainReporter((line) => lines.push(line)) };
};

test('plain mode prints groups as headings and leaves as start and finish lines', async () => {
  const { lines, reporter } = capture();
  await runSteps([
    { title: 'Preparing acme/widget#42', section: true, run: async (ui) => { ui.reporter.start('cloning'); ui.reporter.finish('cloning'); } },
    { title: 'Reviews', concurrent: true, steps: [
      { title: 'ponytail-review', run: async () => '736 words · 313k tokens' },
      { title: 'code-review', run: async (ui) => { ui.status('ignored in plain mode'); ui.log('a note'); return '568 words'; } },
    ] },
  ], { live: false, reporter });
  assert.deepEqual(lines, [
    '[progress] == Preparing acme/widget#42',
    '[progress] Starting cloning',
    '[progress] Finished cloning',
    '[progress] == Reviews',
    '[progress] Starting ponytail-review',
    '[progress] Starting code-review',
    '[progress] a note',
    '[progress] Finished ponytail-review (736 words · 313k tokens)',
    '[progress] Finished code-review (568 words)',
  ]);
});

test('side-by-side steps all finish before the first failure is raised', async () => {
  const { lines, reporter } = capture();
  let slowDone = false;
  await assert.rejects(runSteps([{ title: 'Reviews', concurrent: true, steps: [
    { title: 'fails', run: async () => { throw new Error('boom'); } },
    { title: 'slow', run: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); slowDone = true; return 'ok'; } },
  ] }], { live: false, reporter }), /boom/);
  assert.equal(slowDone, true);
  assert(lines.includes('[progress] Failed fails: boom'));
  assert(lines.includes('[progress] Finished slow (ok)'));
});

test('the listr2 path shows titles with detail and time, log lines, and runs side by side', async () => {
  const { PassThrough } = await import('node:stream');
  const stream = new PassThrough();
  let raw = '';
  stream.on('data', (chunk) => { raw += chunk; });
  let overlap = 0;
  let running = 0;
  const work = (detail) => async (ui) => {
    running++;
    overlap = Math.max(overlap, running);
    ui.log('✖ Rejected   something — because');
    ui.reporter.finish('listing findings', '41k tokens');
    await new Promise((resolve) => setTimeout(resolve, 10));
    running--;
    return detail;
  };
  await runSteps([{ title: 'Reviews', concurrent: true, steps: [
    { title: 'ponytail-review', run: work('736 words · 1.80 AI credits') },
    { title: 'code-review', run: work('568 words') },
  ] }], { live: true, renderer: 'test', output: stream });
  // The test renderer writes one JSON event per line.
  const events = raw.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
  const text = (event) => String(event.data).replace(/\x1b\[[0-9;]*m/g, '');
  const titles = events.filter((event) => event.event === 'TITLE').map(text);
  const outputs = events.filter((event) => event.event === 'OUTPUT').map(text);
  assert.equal(overlap, 2);
  assert(titles.some((title) => /^ponytail-review · 736 words · 1\.80 AI credits · \d+s$/.test(title)), titles.join('\n'));
  assert(titles.some((title) => /^code-review · 568 words · \d+s$/.test(title)));
  assert(outputs.some((output) => output.includes('✖ Rejected   something — because')));
  assert(outputs.some((output) => /✔ listing findings · 41k tokens · \d+s/.test(output)));
});

test('the router sends adapter lines to the running step, or back to the fallback', () => {
  const fallback = [];
  const step = [];
  const router = createRouter({ note: (text) => fallback.push(text) });
  router.note('before');
  router.route({ note: (text) => step.push(text) });
  router.note('during');
  router.route(null);
  router.note('after');
  assert.deepEqual([fallback, step], [['before', 'after'], ['during']]);
});

test('colours come from picocolors and switch off cleanly', () => {
  const off = palette(false);
  assert.equal(off.bold(off.red('x')), 'x');
  assert.equal(typeof palette(true).inverse, 'function');
});

test('live usage of a running session is read from its growing log', async (t) => {
  const { liveUsage } = await import('../src/adapters.mjs');
  const { mkdtemp, mkdir, appendFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'live-usage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'abc-1'));
  const file = join(dir, 'abc-1', 'events.jsonl');
  const record = (input, output, nano) => `${JSON.stringify({ type: 'session.usage_record', data: { usage: { inputTokens: input, outputTokens: output, copilotUsage: { totalNanoAiu: nano } } } })}\n`;
  const updates = [];
  const live = liveUsage(dir, (now) => updates.push(now), { intervalMs: 10 });
  await appendFile(file, record(20_000, 1_000, 2e8));
  live.line(JSON.stringify({ type: 'session.start', data: { sessionId: 'abc-1' } }));
  await new Promise((resolve) => setTimeout(resolve, 40));
  const second = record(30_000, 500, 1.5e8);
  await appendFile(file, second.slice(0, 20));
  await new Promise((resolve) => setTimeout(resolve, 40));
  await appendFile(file, second.slice(20));
  await new Promise((resolve) => setTimeout(resolve, 40));
  live.stop();
  assert.deepEqual(updates.at(0), { tokens: 21_000, credits: 0.2 });
  assert.equal(updates.at(-1).tokens, 51_500);
  assert.ok(Math.abs(updates.at(-1).credits - 0.35) < 1e-9);
});

test('a running step shows live usage and a ticking timer in its title', async () => {
  const { PassThrough } = await import('node:stream');
  const stream = new PassThrough();
  let raw = '';
  stream.on('data', (chunk) => { raw += chunk; });
  const router = createRouter({});
  await runSteps([{ title: 'Reviews', concurrent: true, steps: [
    { title: 'ponytail-review', run: async (ui) => {
      router.route(ui.reporter);
      router.usage('ponytail-review', '412k tokens · 3.10 AI credits');
      await new Promise((resolve) => setTimeout(resolve, 1100));
      return '736 words';
    } },
    { title: 'code-review', run: async (ui) => { router.route(ui.reporter); return '568 words'; } },
  ] }], { live: true, renderer: 'test', output: stream });
  const titles = raw.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line))
    .filter((event) => event.event === 'TITLE').map((event) => String(event.data).replace(/\x1b\[[0-9;]*m/g, ''));
  assert(titles.includes('ponytail-review · 412k tokens · 3.10 AI credits · 0s'), titles.join('\n'));
  assert(titles.includes('ponytail-review · 412k tokens · 3.10 AI credits · 1s'), 'the timer ticks');
  assert(titles.includes('ponytail-review · 736 words · 1s'));
  assert(!titles.some((title) => title.startsWith('code-review · 412k')), 'usage goes to its own step');
});

test('the summary table shows a million tokens and more as M', async () => {
  const { costLines } = await import('../src/confirm.mjs');
  const text = costLines([{ stage: 'code-review', premium: 1, tokens: 1_642_000, credits: 3.29 }, { stage: 'review-digest', premium: 1, tokens: 48_000, credits: 0.5 }]).join('\n');
  assert.match(text, /code-review\s+1 session\s+1\.0 premium\s+1\.6M tokens/);
  assert.match(text, /review-digest\s+1 session\s+1\.0 premium\s+48k tokens/);
  assert.match(text, /total\s+2 sessions\s+2\.0 premium\s+1\.7M tokens/);
});
