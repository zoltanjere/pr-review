import { toReporter } from './ui.mjs';

// Reports start, a periodic "still waiting" and finish or failure around an
// action. `describe(result)` adds a short detail to the finish line; `quiet`
// steps leave no finish line on the live board.
export async function withProgress(progress, label, action, options = {}) {
  const { intervalMs = 15_000, describe, quiet = false } = typeof options === 'number' ? { intervalMs: options } : options;
  const reporter = toReporter(progress);
  const start = Date.now();
  reporter.start(label);
  const timer = setInterval(() => reporter.waiting(label, Math.floor((Date.now() - start) / 1000)), intervalMs);
  try {
    const result = await action();
    if (quiet) reporter.done(label);
    else reporter.finish(label, describe?.(result));
    return result;
  } catch (error) {
    reporter.fail(label, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    clearInterval(timer);
  }
}
