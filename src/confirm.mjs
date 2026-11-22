import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { palette, short } from './ui.mjs';

const PRIORITY_ORDER = ['Must fix', 'Should fix', 'Minor'];

// What verify decided, grouped the way the digest uses it.
export function summarizeFindings(findings, c = palette(false)) {
  const confirmed = (priority) => findings.filter((item) => item.status === 'Confirmed' && item.priority === priority);
  const questions = findings.filter((item) => item.status === 'Question');
  const rejected = findings.filter((item) => item.status === 'Rejected');
  const unchecked = findings.filter((item) => item.status === 'Unchecked');
  const counts = [
    ...PRIORITY_ORDER.map((priority) => [confirmed(priority).length, priority.toLowerCase()]),
    [questions.length, questions.length === 1 ? 'question' : 'questions'],
    [rejected.length, 'rejected'],
    [unchecked.length, 'not checked'],
  ].filter(([count]) => count).map(([count, name]) => `${count} ${name}`).join(' · ');
  const lines = [c.bold(`Verify: ${findings.length} finding${findings.length === 1 ? '' : 's'}${counts ? ` → ${counts}` : ''}`)];
  const group = (title, items, icon, color, reason) => {
    if (!items.length) return;
    lines.push('', c[color](title));
    for (const item of items) {
      lines.push(`  ${c[color](icon)} ${short(item.title, 80)} ${c.dim(short(item.location, 50))}`);
      if (reason) lines.push(`      ${c.dim(short(/^Not checked/.test(item.evidence ?? '') ? item.evidence : item.finding, 140))}`);
    }
  };
  group('In the digest: must fix', confirmed('Must fix'), '●', 'red');
  group('In the digest: should fix', confirmed('Should fix'), '●', 'yellow');
  group('In the digest: questions', questions, '?', 'yellow');
  group('Folded as minor', confirmed('Minor'), '·', 'dim');
  group('Dropped (rejected)', rejected, '✖', 'red', true);
  group('Not checked (over the limit)', unchecked, '–', 'dim');
  return lines;
}

// The terminal preview shows a link's text, not its long GitHub URL.
export function renderDigest(text, c) {
  return text.trim().replace(/\[([^\]]+)\]\(https:\/\/github\.com\/[^)\s]+\)/g, '$1').split('\n').map((line) => {
    if (/^\*\*Verdict:\*\*/.test(line)) return c.bold(line.includes('🔴') ? c.red(line) : line.includes('✅') ? c.green(line) : c.yellow(line));
    if (/^#{1,6} /.test(line)) return c.bold(c.blue(line));
    if (/^<\/?details|^<summary/.test(line)) return c.dim(line);
    return line;
  });
}

// Opens the text in $VISUAL or $EDITOR and returns the edited version.
export function editText(text) {
  return (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pr-review-digest-'));
    const file = join(dir, 'digest.md');
    try {
      await writeFile(file, text, { mode: 0o600 });
      const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
      const result = spawnSync(editor, [file], { stdio: 'inherit', shell: /\s/.test(editor) });
      if (result.status !== 0) throw new Error(`${editor} exited with ${result.status ?? result.signal}`);
      return await readFile(file, 'utf8');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
}

// Run totals for a one-line summary, e.g. "5 sessions · 947k tokens".
export function costTotal(usage) {
  if (!usage?.length) return null;
  const known = usage.filter((entry) => typeof entry.tokens === 'number');
  const tokens = known.reduce((sum, entry) => sum + entry.tokens, 0);
  const priced = usage.filter((entry) => typeof entry.credits === 'number');
  const credits = priced.reduce((sum, entry) => sum + entry.credits, 0);
  const k = tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}k`;
  return `${usage.length} session${usage.length === 1 ? '' : 's'}${known.length ? ` · ${k} tokens` : ''}${priced.length ? ` · ${credits.toFixed(1)} AI credits` : ''}`;
}

// Copilot cost per stage, from each session's own accounting.
export function costLines(usage, c = palette(false)) {
  if (!usage?.length) return [];
  const stages = new Map();
  for (const { stage, premium, tokens, credits } of usage) {
    const row = stages.get(stage) ?? { sessions: 0, premium: 0, tokens: 0, credits: 0, priced: 0, unknown: 0 };
    row.sessions++;
    if (premium === null) row.unknown++;
    else { row.premium += premium; row.tokens += tokens; }
    if (typeof credits === 'number') { row.credits += credits; row.priced++; }
    stages.set(stage, row);
  }
  const total = [...stages.values()].reduce((sum, row) => ({
    sessions: sum.sessions + row.sessions, premium: sum.premium + row.premium, tokens: sum.tokens + row.tokens,
    credits: sum.credits + row.credits, priced: sum.priced + row.priced, unknown: sum.unknown + row.unknown,
  }), { sessions: 0, premium: 0, tokens: 0, credits: 0, priced: 0, unknown: 0 });
  // 1642000 → "1.6M", 313000 → "313k".
  const k = (tokens) => tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}k`;
  // AI credits are what token-priced plans pay; tokens alone mislead, since
  // cache reads and cheaper models cost far less per token.
  const credit = (row) => (row.priced ? row.credits.toFixed(2) : '-').padStart(8);
  const line = (name, row) => `  ${name.padEnd(20)} ${String(row.sessions).padStart(3)} session${row.sessions === 1 ? ' ' : 's'} ${row.premium.toFixed(1).padStart(6)} premium ${k(row.tokens).padStart(7)} tokens ${credit(row)} AI credits${row.unknown ? c.dim(` (${row.unknown} unknown)`) : ''}`;
  return ['', c.bold('Cost'), ...[...stages].map(([name, row]) => line(name, row)), c.bold(line('total', total))];
}

export function printSummary({ saved, usage }, output = process.stderr, { cost = true } = {}) {
  const c = palette(!process.env.NO_COLOR && output.isTTY);
  const lines = ['', c.bold('Saved'), ...saved.map((path) => `  ${c.green('✔')} ${relative(process.cwd(), path)}`)];
  lines.push(...(cost ? costLines(usage, c) : []), '');
  output.write(lines.join('\n'));
}
