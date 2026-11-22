import cliSpinners from 'cli-spinners';
import { Listr, ListrLogger, ProcessOutput, Spinner } from 'listr2';
import { describeEvent, palette, plainReporter, seconds } from './ui.mjs';

// One way to declare work, rendered two ways:
// - live (both stdout and stderr are terminals): listr2, with a spinner per
//   running step, concurrent steps side by side, and persistent log lines;
// - plain (pipes, --yes, tests): our "[progress] …" lines, unchanged.
//
// A step is { title, run(ui), steps?, concurrent?, section? }:
// - a leaf has `run`; what it returns is the detail on its finish line,
//   "title · detail · 41s";
// - a group has `steps` (run one after another, or side by side with
//   `concurrent`) and shows as a heading;
// - `section: true` is a leaf whose own lines come from inside it (plain mode
//   prints only the heading, like a group).
// `ui` offers status(text) for a transient line, log(line) for a lasting one,
// and `reporter`, the reporter interface the adapters use, routed to this step.

// listr2's spinner with cli-spinners' "dots" frames and timing.
class DotsSpinner extends Spinner {
  spinner = cliSpinners.dots.frames;
  start(callback, interval = cliSpinners.dots.interval) {
    super.start(callback, interval);
  }
}

export const isLive = () => Boolean(process.stdout.isTTY && process.stderr.isTTY);

// Turns adapter reporter calls into a step's status and log lines.
function stepReporter(ui) {
  const c = palette(!process.env.NO_COLOR);
  const started = new Map();
  let current = null;
  return {
    title: ui.title,
    start(label) { started.set(label, Date.now()); current = label; ui.status(label); },
    finish(label, detail) {
      const time = seconds(Date.now() - (started.get(label) ?? Date.now()));
      started.delete(label);
      if (current === label) { current = null; ui.status(''); }
      ui.log(`${c.green('✔')} ${label}${c.dim(` · ${[detail, time].filter(Boolean).join(' · ')}`)}`);
    },
    done(label) { started.delete(label); if (current === label) { current = null; ui.status(''); } },
    fail(label, message) { started.delete(label); if (current === label) { current = null; ui.status(''); } ui.log(`${c.red('✖')} ${label} ${c.red(message)}`); },
    // Live tokens and credits of a running Copilot session: on the step's own
    // title when it is this step, or next to the running sub-stage's name.
    usage(label, text) {
      if (label === ui.title) ui.meter(text);
      else if (label === current || (current && current.startsWith(label.split(' ')[0]))) ui.status(`${current} · ${text}`);
      else ui.meter(text);
    },
    waiting() {},
    section() {},
    note(text) { ui.log(`${c.dim('·')} ${text}`); },
    warn(text) { ui.log(`${c.yellow('!')} ${c.yellow(text)}`); },
    event(type, data) { for (const line of describeEvent(type, data, c)) ui.log(line); },
    close() {},
  };
}

function listrTask(step) {
  if (step.steps) {
    return {
      title: step.title,
      task: (ctx, task) => task.newListr(step.steps.map(listrTask), {
        concurrent: Boolean(step.concurrent),
        exitOnError: !step.concurrent,
        rendererOptions: { collapseSubtasks: false },
      }),
    };
  }
  return {
    title: step.title,
    rendererOptions: { persistentOutput: true, outputBar: Infinity },
    task: async (ctx, task) => {
      const c = palette(!process.env.NO_COLOR);
      const start = Date.now();
      let status = '';
      let meter = '';
      // While running: "title · what it is doing · live usage · elapsed",
      // refreshed every second so the timer keeps moving.
      const draw = () => {
        task.title = `${step.title}${c.dim(` · ${[status, meter, seconds(Date.now() - start)].filter(Boolean).join(' · ')}`)}`;
      };
      const ui = {
        title: step.title,
        status: (text) => { status = text; draw(); },
        meter: (text) => { meter = text ?? ''; draw(); },
        // listr2 keeps every output value as its own line (outputBar: Infinity).
        log: (line) => { task.output = line; },
      };
      ui.reporter = stepReporter(ui);
      draw();
      const timer = setInterval(draw, 1000);
      try {
        const detail = await step.run(ui);
        task.title = `${step.title}${c.dim(` · ${[detail, seconds(Date.now() - start)].filter(Boolean).join(' · ')}`)}`;
      } finally {
        clearInterval(timer);
      }
    },
  };
}

async function runPlain(steps, reporter, concurrent = false) {
  const runOne = async (step) => {
    if (step.steps) {
      reporter.section(step.title);
      return runPlain(step.steps, reporter, step.concurrent);
    }
    const ui = { status: () => {}, log: (line) => reporter.note(line), reporter };
    if (step.section) {
      reporter.section(step.title);
      return step.run(ui);
    }
    reporter.start(step.title);
    try {
      const detail = await step.run(ui);
      reporter.finish(step.title, detail);
      return detail;
    } catch (error) {
      reporter.fail(step.title, error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
  if (!concurrent) {
    for (const step of steps) await runOne(step);
    return;
  }
  // Side by side: every step finishes, then the first failure is raised.
  const results = await Promise.allSettled(steps.map(runOne));
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
}

// Runs the steps. `reporter` (plain mode) defaults to stderr lines; `live`
// defaults to whether we are in a terminal. `renderer` lets tests use listr2's
// own 'test' renderer, and `output` a stream to render into.
export async function runSteps(steps, { live = isLive(), reporter = plainReporter(), renderer, output } = {}) {
  if (!live) return runPlain(steps, reporter);
  const listr = new Listr(steps.map(listrTask), {
    exitOnError: true,
    renderer: renderer ?? 'default',
    rendererOptions: {
      ...(renderer ? {} : { collapseSubtasks: false, collapseErrors: false, showErrorMessage: true, formatOutput: 'wrap', spinner: new DotsSpinner() }),
      ...(output ? { logger: new ListrLogger({ processOutput: new ProcessOutput(output, output) }) } : {}),
    },
  });
  await listr.run();
  // Side-by-side groups don't stop on a failure; raise the first one here.
  const failed = listr.errors?.find(Boolean);
  if (failed) throw failed.error ?? failed;
}

// A reporter the adapters can hold for the whole run while their lines go to
// whichever step is running: route(target) points it at that step's reporter.
export function createRouter(fallback = plainReporter()) {
  let target = fallback;
  // Steps running side by side each register; live usage goes to the step
  // named after the stage, the rest to the most recently routed step.
  const byTitle = new Map();
  const forward = (name) => (...args) => target[name]?.(...args);
  return {
    route(next) {
      target = next ?? fallback;
      if (next?.title) byTitle.set(next.title, next);
      if (!next) byTitle.clear();
    },
    usage(label, text) { (byTitle.get(label) ?? target).usage?.(label, text); },
    ...Object.fromEntries(['start', 'finish', 'done', 'fail', 'waiting', 'section', 'note', 'warn', 'event', 'close'].map((name) => [name, forward(name)])),
  };
}
