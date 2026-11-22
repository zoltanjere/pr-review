import picocolors from 'picocolors';

// Terminal reporting: the reporter interface the adapters call, and its plain
// renderer ("[progress] ..." lines for logs, pipes and tests). In a terminal,
// src/steps.mjs routes the same calls into listr2 instead.
//
// Interface: start(label), finish(label, detail), done(label) (finished;
// its result is reported by an event instead), fail(label, message),
// waiting(label, seconds), section(title), note(text), warn(text),
// event(type, data), close().

// Colours come from picocolors; `enabled` false gives plain text.
export function palette(enabled) {
  return picocolors.createColors(Boolean(enabled));
}

const seconds = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};

function short(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const STATUS_STYLE = { Confirmed: ['✔', 'green'], Question: ['?', 'yellow'], Rejected: ['✖', 'red'], Unchecked: ['–', 'dim'] };
const PRIORITY_STYLE = { 'Must fix': 'red', 'Should fix': 'yellow', Minor: 'dim' };

// Shared wording for domain events, so both renderers say the same thing.
export function describeEvent(type, data, c) {
  if (type === 'context') {
    const spec = [
      data.issues ? `${data.issues} issue${data.issues > 1 ? 's' : ''}` : '',
      ...data.workItems.map((item) => item.error ? c.red(`AB#${item.id} ✖`) : `AB#${item.id}`),
    ].filter(Boolean).join(', ');
    return [
      `${c.bold(data.title || '(untitled PR)')}`,
      c.dim(`${data.base.slice(0, 7)} → ${data.head.slice(0, 7)} · ${data.files} file${data.files === 1 ? '' : 's'} · ${data.commits} commit${data.commits === 1 ? '' : 's'} · spec: `) + (spec || c.dim('none linked')),
    ];
  }
  if (type === 'findings') {
    const extra = data.checking !== undefined && data.checking !== data.count ? c.dim(` · checking ${data.checking}, the rest are style only or over the limit`) : '';
    return [`${c.bold(String(data.count))} distinct finding${data.count === 1 ? '' : 's'}${extra}`];
  }
  if (type === 'finding') {
    const [icon, color] = STATUS_STYLE[data.status] ?? ['•', 'dim'];
    const tag = data.status === 'Confirmed' ? c[PRIORITY_STYLE[data.priority] ?? 'dim'](data.priority.padEnd(10)) : c[color](data.status.padEnd(10));
    const why = /^Not checked/.test(data.evidence ?? '') ? data.evidence : data.finding;
    const reason = data.status === 'Confirmed' ? '' : c.dim(` — ${short(why, 90)}`);
    return [`${c[color](icon)} ${tag} ${short(data.title, 70)}${reason}`];
  }
  if (type === 'model') {
    return [`Model: ${c.bold(data.model)}${data.checkModel && data.checkModel !== data.model ? ` · check: ${c.bold(data.checkModel)}` : ''}`];
  }
  if (type === 'review') {
    return [`${data.name}: ${data.words} words`];
  }
  return [`${type}: ${JSON.stringify(data)}`];
}

export function plainReporter(write = (line) => process.stderr.write(`${line}\n`)) {
  const c = palette(false);
  return {
    start: (label) => write(`[progress] Starting ${label}`),
    finish: (label, detail) => write(`[progress] Finished ${label}${detail ? ` (${detail})` : ''}`),
    done: (label) => write(`[progress] Finished ${label}`),
    fail: (label, message) => write(`[progress] Failed ${label}: ${message}`),
    waiting: (label, s) => write(`[progress] Still waiting for ${label} (${s}s elapsed)`),
    section: (title) => write(`[progress] == ${title}`),
    note: (text) => write(`[progress] ${text}`),
    warn: (text) => write(`[progress] Warning: ${text}`),
    event: (type, data) => { for (const line of describeEvent(type, data, c)) write(`[progress] ${line}`); },
    close() {},
  };
}

// Accepts a reporter, a line-writing function (tests, scripts) or nothing.
export function toReporter(progress) {
  if (progress && typeof progress === 'object') return progress;
  return plainReporter(typeof progress === 'function' ? progress : undefined);
}

// 15000 → "15k", 1250000 → "1.3M"; null when unknown.
export function formatTokens(tokens) {
  if (typeof tokens !== 'number') return null;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tokens`;
  return `${Math.max(1, Math.round(tokens / 1000))}k tokens`;
}

// "412k tokens · 3.10 AI credits" for a running or finished stage.
export function formatUsage({ tokens, credits } = {}) {
  return [formatTokens(tokens), typeof credits === 'number' ? `${credits.toFixed(2)} AI credits` : null].filter(Boolean).join(' · ') || null;
}

export { short, seconds };
