// What the tool needs on the machine, and what to tell someone who doesn't
// have it yet: a missing program or a missing sign-in becomes one line that
// says how to fix it, instead of "spawn claude ENOENT".

const TOOLS = {
  git: { name: 'git', install: 'https://git-scm.com/downloads' },
  gh: { name: 'The GitHub CLI (gh)', install: 'brew install gh, or on Windows: winget install GitHub.cli', login: 'gh auth login' },
  copilot: { name: 'The Copilot CLI (copilot)', install: 'brew install copilot-cli, or on Windows: winget install GitHub.Copilot', login: 'copilot login', provider: true },
  claude: { name: 'Claude Code (claude)', install: 'see https://docs.claude.com/en/docs/claude-code/setup', login: 'claude auth login', provider: true },
};

const OTHER_PROVIDER = 'or choose the other provider with: reviewpr settings';
const SIGNED_OUT = /not logged in|not signed in|please run \/login|auth login|unauthori[sz]ed|not authenticated|authentication (?:failed|required)|invalid api key|token (?:has )?expired/i;

// One line for a failed command, or null when it isn't a setup problem.
export function setupHint(command, error) {
  const tool = TOOLS[command];
  if (!tool) return null;
  const or = tool.provider ? `, ${OTHER_PROVIDER}` : '';
  if (error?.code === 'ENOENT') return `${tool.name} isn't installed, or isn't on your PATH. Install it: ${tool.install}${or}.`;
  if (tool.login && SIGNED_OUT.test(String(error?.message ?? ''))) return `${tool.name} isn't signed in. Run: ${tool.login}${or}.`;
  return null;
}

// Before a review or summary starts: the provider's CLI answers, and Claude
// Code is signed in (a local check that uses no tokens). Copilot has no such
// check; its sign-in error gets the same hint when the first agent runs.
export async function checkProvider(provider, execute) {
  await execute(provider, ['--version']);
  if (provider !== 'claude') return;
  try {
    await execute('claude', ['auth', 'status']);
  } catch (error) {
    if (error.code === 'ENOENT') throw error;
    throw new Error(`Claude Code (claude) isn't signed in. Run: claude auth login, ${OTHER_PROVIDER}.`, { cause: error });
  }
}
