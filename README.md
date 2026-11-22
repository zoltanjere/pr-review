# pr-review

Review a GitHub pull request with two independent AI reviewers. The findings that matter are checked against the code, and the result is a short PR comment that people actually read. It's meant as a cheap second opinion next to GitHub Copilot's own PR review: about 5 Copilot sessions per PR.

```sh
node src/review.mjs https://github.com/acme/widget/pull/42
```

`pr-review` runs locally on your machine through the GitHub Copilot CLI. It reads the PR, its linked GitHub issues and its Azure Boards work items. It reviews the code in a disposable clone and saves the results as Markdown. **It never changes your checkouts, and it posts to GitHub only when you choose to in the terminal**: one review, after two explicit choices.

## How it works

```
prepare ── temporary clone at the pinned PR head, diff, PR body, commits,
   │       linked GitHub issues and AB#<id> work items
   │
   ├─ ponytail-review   correctness, safety, load, tests, lean code      ┐ parallel
   └─ code-review       repo standards + "does it do what the spec asks" ┘
   │
verify ── 1. list and tier the findings (reviews only)
   │      2. check them in one session against the cited code:
   │         Confirmed / Question / Rejected, one priority
   │
digest ── verdict + at most 5 findings in ≤ 250 words, minor items folded
```

1. **Reviews.** Two installed skills each review the PR on their own, in parallel. Both are also asked to look at failure paths, boundary values, encoding and framework constraints.
2. **Verify.** One agent lists every distinct finding from the reviews, merging duplicates, and sorts it into a tier:
   - **A** (could block): checked rigorously, at most 6.
   - **B** (minor but concrete): checked lightly, at most 8.
   - **C** (pure style): rejected without a check.

   A second agent then checks tiers A and B in one session. It gets only the diff of the cited files, plus the spec, opens the cited code and rejects what is false, taste, or below the bar for a Minor finding. When a reviewer points at a real defect but describes it wrongly, verify confirms the real defect. Verify is the only stage that sets priority: *Must fix*, *Should fix* or *Minor*.
3. **Digest.** The PR comment. It opens with a verdict line that the code sets from verify's priorities, so it can't contradict the findings:
   - 🔴 **Fix before merge** when there is a Must fix;
   - ⚠️ **Changes recommended** when there is a Should fix;
   - otherwise ✅ **Ship**.

   Up to five numbered findings follow. Minor items sit in a collapsed `<details>` block.

   Every `` `path:line` `` reference becomes a clickable GitHub link. If the line is part of the PR's diff, the link opens it in **Files changed**, where you can comment on it; otherwise it opens the file at the reviewed commit with the line highlighted. Short paths such as `upload_queue.py:148` are resolved to the one matching file. A reference that matches no file, or more than one, stays plain text. The terminal preview shows the reference without the URL.

## Requirements

- Node.js 26, pinned in `.nvmrc`, installed with [nvm](https://github.com/nvm-sh/nvm). Your shell and other projects keep their own Node version (see [Node version](#node-version)).
- Git.
- [GitHub CLI](https://cli.github.com/) (`gh`), signed in.
- [GitHub Copilot CLI](https://github.com/github/copilot-cli) (`copilot`), signed in.
- A clone of the reviewed repository **next to this project**, for example `~/code/widget` beside `~/code/pr-review`. Its `origin` must point at the GitHub repository. If several clones match, the one named after the repository wins.
- Optional, for Azure Boards specs: the [Azure CLI](https://learn.microsoft.com/cli/azure/) with the `azure-devops` extension, signed in (`az login`).

Three small npm dependencies, pinned to exact versions in `package-lock.json`:
- [listr2](https://github.com/listr2/listr2) for the live step list;
- [picocolors](https://github.com/alexeyraspopov/picocolors) for colours;
- [cli-spinners](https://github.com/sindresorhus/cli-spinners) for the spinner frames.

## Setup

```sh
git clone <this repo> ~/code/pr-review
cd ~/code/pr-review
nvm install      # once: installs the Node version from .nvmrc
npm ci           # installs the pinned dependencies
cp config.example.json config.json
```

Edit `config.json` (it is git-ignored, so your settings stay local):

```json
{
  "model": "claude-sonnet-5.5",
  "azureDevOpsOrg": "https://dev.azure.com/your-organization"
}
```

| Key | Required | Meaning |
|---|---|---|
| `model` | yes | Copilot model for every agent and subagent. A run fails if any agent reports another model. Your global Copilot settings are not changed. |
| `checkModel` | no | Model for the verify check session only. It defaults to `model`. A cheaper model lowers the price, but this session is what keeps false findings out, so try it on a few PRs first. |
| `azureDevOpsOrg` | no | Organisation used to fetch `AB#<id>` work items. Without it, work items are listed as not fetched and the review continues. |
| `defaultRepository` | no | `owner/repo` (or its GitHub URL) to pick PRs from when you run the tool without a URL. |

### Choosing models

Use the model IDs exactly as Copilot lists them in `/model`, where you can also see each model's price per token or premium-request multiplier.

| Tier | Model ID | Use it for |
|---|---|---|
| **Cheap** | `claude-haiku-5.5` | `checkModel`, to make verify's check session cheaper. Confirm it appears in your `/model` list first. |
| | `gpt-5.4-nano` | The cheapest option for `checkModel`. Expect weaker judgement on subtle rejections. |
| **Medium (default)** | `claude-sonnet-5.5` | `model` for everything. This is what the pipeline was tuned and evaluated with. |
| **Expensive** | `claude-opus-5.5` | `model` for large or high-risk PRs, when depth matters more than cost. |

Suggested combinations:

```json
{ "model": "claude-sonnet-5.5" }
```
The balanced default.
```json
{ "model": "claude-haiku-5.5" }
```
```json
{ "model": "claude-sonnet-5.5", "checkModel": "claude-haiku-5.5" }
```
Cheaper: the reviewers keep their quality, and only the check session is cheaper.

```json
{ "model": "claude-opus-5.5" }
```
Thorough: for security-sensitive or very large PRs.

Some guidance:
- **Keep the reviewers on at least the medium tier.** They are about 75% of a run's tokens, so a cheap model there saves the most, but it also finds the fewest real bugs.
- **The check session is what keeps false findings out of the comment.** Before trusting a cheap `checkModel` for posting, compare a few of its `HHMM-verified.md` files with a medium-tier run.
- **Every agent and subagent must report the configured model.** If Copilot falls back to another one, the run stops, so a typo in an ID fails fast.
- **Compare the cost table at the end of each run** to see what a switch actually saves.

## Usage

Review a PR:

```sh
node src/review.mjs https://github.com/acme/widget/pull/42
```

Or run it without a URL and pick one of `defaultRepository`'s open PRs:

```sh
node src/review.mjs
```

```
acme/widget: 3 to review (9 open; hidden: 3 reviewed, 1 draft, 1 yours, 1 bot)
❯ #61  octo-dev            fix: resume uploads after a dropped connection
  #60  sam-codes           chore: bump the test runner to the latest minor
  #48  octo-dev            feat: show upload progress in the status bar
↑/↓ move · Enter review · q cancel
```

- **Keys:** `↑`/`↓` (or `k`/`j`) move, **Enter** reviews the highlighted PR with the normal flow, and `q` or `Esc` cancels.
- **Listed:** open PRs you haven't reviewed yet, plus PRs you reviewed that have newer commits since your review, or whose review GitHub dismissed. Any review counts as reviewed: Approve, Request changes or Comment only.
- **Hidden:** drafts, your own PRs and bot PRs. The header counts what was hidden.
- **Cost:** listing uses read-only `gh` calls and no model.
- **Requirements:** it needs a terminal, so it can't be combined with `--yes`, and a local clone of the repository.

In a terminal you see the run live:
- the model in use, then the PR title, commits, changed files and linked spec;
- each step finishing with what it produced and cost, separated by dots: `✔ code-review · 568 words · 405k tokens · 3.29 AI credits · 41s`;
- every finding as verify decides it: `✔ Should fix`, `? Question` or `✖ Rejected`, with the reason;
- at the end, the Copilot cost per stage (sessions, premium requests, tokens and AI credits), taken from each session's own accounting. On token-priced plans, **AI credits** are what you pay: tokens alone mislead, because cache reads and cheaper models cost far less per token;
- running steps with a spinner, a timer that ticks every second, and, for model steps, tokens and AI credits growing live (`⠦ code-review · 183k tokens · 1.23 AI credits · 41s`). The live numbers come from Copilot's own session log, at no extra cost, and the final numbers replace them when the step finishes.

When the run finishes, all files are saved, the digest included. The terminal then shows the PR, the reviewed commit, the model and the run's cost at the top, followed by what verify decided (what made it into the digest, what was folded as minor, what was dropped and why) and the digest itself, and asks what to do next:

```
acme/widget#42  feat: add upload retries
  PR      https://github.com/acme/widget/pull/42
  Commit  3f2a9c1
  Model   claude-sonnet-5.5
  Cost    5 sessions · 640k tokens · 9.4 AI credits

── Decisions ─────────────────────────────────────────
Verify: 9 findings → 1 must fix · 1 should fix · 2 minor · 5 rejected

In the digest: must fix
  ● Retries resend a non-idempotent POST  upload.ts:42
...
Dropped (rejected)
  ✖ Missing null check on headers  upload.ts:18
      The claim is false. parseHeaders returns an empty object for a missing header, never null…

── Digest preview ────────────────────────────────────
**Verdict:** 🔴 Fix before merge. 1 must-fix, 1 should-fix.
...

Cost
  ponytail-review        1 session     1.0 premium    313k tokens     1.80 AI credits
  ...
  total                  5 sessions    5.0 premium    640k tokens     9.40 AI credits

What next?
❯ Keep it local (saved in reviews/2026-11-22/widget-PR42/1430-digest.md)
  Post it as a review on acme/widget#42
  Edit the digest first
↑/↓ move · Enter choose · q keep local
```

The cost table sits right above the first question, so the long digest preview can't push it off screen. Both menus work like the PR picker: `↑`/`↓` (or `k`/`j`) move, Enter chooses, and `q` or `Esc` keeps it local.

- **Keep it local**, preselected, keeps everything local. Nothing is sent to GitHub.
- **Post it as a review** checks the PR's live state, then asks how to post, with the recommendation preselected:

  ```
  Post to acme/widget#42 as:
    Approve
    Comment only
  ❯ Request changes (recommended)
    Cancel, keep it local
  ↑/↓ move · Enter choose · q keep local
  ```

  The recommendation follows the digest's verdict line, including any edit you made to it, and Enter picks it:
  - 🔴 and ⚠️ give **Request changes**;
  - ✅ gives **Approve**.

  If you pick a type that contradicts the verdict line, the line is rewritten to match your choice before posting, and the saved digest is updated too:
  - **Approve** gives ✅ Ship;
  - **Request changes** on a ✅ gives ⚠️ Changes recommended;
  - **Comment only** on a ✅ gives 💬 Not approved yet.
  - If the PR has new commits since the review, or it is your own PR (GitHub doesn't allow approving your own), only **Comment only** is offered.
  - A closed or merged PR can't be posted to.

  The review body is the digest plus a one-line footer, "Reviewed at `<sha>` with AI assistance. Each finding was checked against the code.", posted with `gh pr review` as your GitHub user.
- **Edit the digest first** opens the digest in `$VISUAL` or `$EDITOR` (default `vi`), saves your edit to the digest file, and shows it again.

Without a terminal, or with `--yes`, nothing is ever posted. Progress is printed as plain `[progress]` lines on stderr, and the digest text also goes to stdout:

```sh
node src/review.mjs --yes https://github.com/acme/widget/pull/42 > comment.md
```

Review the same PR again after new commits. Each run is named by the time it started, and earlier runs are kept:

```sh
node src/review.mjs https://github.com/acme/widget/pull/42   # at 16:05 writes 1605-*.md
```

Copy the comment to paste into the PR (macOS):

```sh
pbcopy < reviews/2026-11-22/widget-PR42/1430-digest.md
```

### Linking a spec

The `code-review` Spec axis and the verify stage check the PR against its *originating specification*. That is:
- **GitHub issues** the PR closes (`Fixes #17`).
- **Azure Boards work items** mentioned as `AB#1234` in the PR title, body or commit messages, with their description and acceptance criteria.
- Explicit requirements in the PR body.

Without a spec, the Spec section says `No spec available.` and the review covers the code only.

## Output

Each run writes four files to `reviews/<date>/<repo>-PR<number>/`. Each file name starts with the run's local start time as `HHMM`; a second run in the same minute gets `HHMMb`, then `HHMMc`, and so on. For a run started at 14:30:

| File | What it is |
|---|---|
| `1430-ponytail-review.md` | Raw review from `ponytail-review` |
| `1430-code-review.md` | Raw review from `code-review` (Standards and Spec sections) |
| `1430-verified.md` | **Full record.** Every finding, with status, priority, evidence (`file:line`) and fix. Rejected findings are kept, with the reason. |
| `1430-digest.md` | **The PR comment**: what is posted if you choose to post, or ready to paste by hand. |

Example digest (fictional PR):

```markdown
**Verdict:** ⚠️ Fix before merge. 1 must-fix, 1 fix recommended.

### Must fix
1. 🔴 **Retries resend a non-idempotent POST**
   `upload.ts` · `sendChunk`
   A timeout after the server stored the chunk retries the POST and stores it twice. Fix: send the `Idempotency-Key` header, or retry only on connection errors.

### Should fix
2. 🟡 **Backoff has no upper bound**
   `retry.ts:18` · `delayFor`
   After 10 attempts the delay passes 17 minutes. Fix: cap at `maxDelayMs` (the spec says 30 s) and add a test.

<details><summary>2 minor items</summary>

- `retry.ts:4`: `MAX_ATTEMPTS` is exported but unused; remove it.
- PR body doesn't mention the new `UPLOAD_RETRIES` env var; document it.
</details>
```

When nothing is worth raising, the digest is one line: `**Verdict:** ✅ Ship. No issues found.` It never summarises the PR; the author already knows what it does.

If a reviewer fails, its successful siblings are saved and the run stops before verify. If the verify or digest stage fails, every file saved before it stays.

## What the agents may do

All agents run in the temporary clone with these limits:
- **Tools:** read files (`view`, `grep`, `glob`), load skills, start subagents (`task`).
- **Shell:** only read-only git (`diff`, `log`, `show`, `blame`, `grep`, `ls-files`, `rev-parse`, `merge-base`, `status`, `cat-file`). Writing subcommands such as `push`, `commit`, `checkout` or `fetch` are explicitly denied. Any other command, `git -C`, pipes, chaining and redirection are refused.
- **No file writes, no `gh`, no `az`, no network tools.** Issues and work items are fetched before the agents start.
- The reviewed repository's own instructions (`AGENTS.md` and the like) are not loaded. Any skill in it that shares a name with a pipeline skill is removed from the clone, so a repository cannot replace a reviewer.

The temporary clone is deleted when the run ends, whether it succeeds or fails.

> **Data:** Copilot CLI sends what the agents read, meaning code, PR text and work items, to its model provider. Saved reviews may contain sensitive information. Review files are created readable by their owner only, and `reviews/` is git-ignored.

## Skills

| Skill | Source | Role |
|---|---|---|
| `ponytail-review` | [dietrichgebert/ponytail](https://github.com/dietrichgebert/ponytail) | General correctness and quality reviewer |
| `code-review` | [mattpocock/skills](https://github.com/mattpocock/skills) | Standards and Spec reviewer |
| `review-digest` | this project | Format of the final PR comment |

The two reviewers are installed unmodified in `.agents/skills/` and pinned in `skills-lock.json`. Update them on purpose, never during a review:

```sh
npx skills update --project
```

`review-digest` belongs to this project; edit `.agents/skills/review-digest/SKILL.md` directly. Its 250-word budget is also enforced in code (`DIGEST_WORD_LIMIT` in `src/adapters.mjs`), so change both together.

## Development

```sh
nvm use
npm test
```

You can also start a review with `npm run review -- <url>`, or with `./src/review.mjs <url>`.

### Node version

The project runs on the Node version in `.nvmrc` (v26.13.1). You don't have to switch your shell to it:
- **Starting the tool with an older Node** (`node src/review.mjs …` on your default Node 22, for example) makes it restart itself on the pinned version from your nvm folder (`$NVM_DIR`, default `~/.nvm`). Nothing global changes: not your shell's Node, not nvm's default, not other projects.
- **If the pinned version isn't installed,** the tool stops and tells you to run `nvm install v26.13.1`.
- **For other Node commands in this folder** (`npm ci`, `npm test`), run `nvm use` first. It switches only the current shell.

**Optional:** to have every new shell switch automatically when you `cd` into a folder with an `.nvmrc`, add nvm's [`load-nvmrc` hook](https://github.com/nvm-sh/nvm#zsh) to your `~/.zshrc`. Folders without an `.nvmrc` keep your default Node.

The tests use local git fixtures and mocked `gh`, `az` and `copilot` calls. No network or model calls are made.

| Path | Contents |
|---|---|
| `src/review.mjs` | CLI entry point, run naming, stage order, saving |
| `src/adapters.mjs` | Clone and context preparation, Copilot invocation and checks, prompts |
| `src/node-version.mjs` | Restarts the CLI on the `.nvmrc` Node when started with an older one |
| `src/steps.mjs` | Step runner: listr2 in a terminal, plain `[progress]` lines otherwise |
| `src/ui.mjs` | Colours (picocolors), the reporter interface and plain progress lines |
| `src/select.mjs` | PR picker and the arrow-key menus |
| `src/confirm.mjs` | Decision summary, digest preview rendering and the final summary with cost |
| `src/links.mjs` | Turns `path:line` references into GitHub links |
| `src/verdict.mjs` | Verdict line and recommended review type, from the findings |
| `src/publish.mjs` | Keep local or post: the two-step choice and the review-type rules |
| `src/progress.mjs` | Start, waiting and finish reporting around a stage |
| `.agents/skills/` | Pipeline skills |
| `package.json`, `package-lock.json`, `.nvmrc`, `.npmrc` | Version, scripts, pinned dependencies, Node version |
| `CHANGELOG.md` | What changed in each version |
| `DECISIONS.md` | Why the pipeline is built this way. Read it before changing it. |

## Credits

The two reviewer skills in `.agents/skills/` are third-party, used unmodified under the MIT License:

- `ponytail-review` from [dietrichgebert/ponytail](https://github.com/dietrichgebert/ponytail): Copyright (c) 2026 DietrichGebert
- `code-review` from [mattpocock/skills](https://github.com/mattpocock/skills): Copyright (c) 2026 Matt Pocock

Both are distributed under this permission notice:

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
