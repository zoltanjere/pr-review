# pr-review

A cheap, verified second review for GitHub pull requests, next to Copilot's own PR review.

Two AI reviewers look at the PR independently. A verify step checks every finding that matters against the code and drops what's false. The result is a short PR comment of at most 250 words. It runs locally through the GitHub Copilot CLI, at about 5 Copilot sessions per PR.

```sh
node src/review.mjs https://github.com/acme/widget/pull/42
```

It reviews in a throwaway clone and never touches your checkouts. It posts to GitHub only when you pick that in the terminal.

## How it works

```
prepare ── temporary clone at the PR head, diff, PR body, commits, linked issues and AB# work items
   ├─ ponytail-review   correctness, safety, load, tests       ┐ in parallel
   └─ code-review       repo standards + "does it match spec"  ┘
verify  ── list and tier the findings, then check them against the cited code
digest  ── verdict line + at most 5 findings, minor items folded
```

- **Verify** is the only step that sets priority: *Must fix*, *Should fix* or *Minor*. Every rejected finding is kept with its reason.
- **The verdict line** is set in code from those priorities, so it can't contradict the findings: 🔴 Fix before merge, ⚠️ Changes recommended, or ✅ Ship.
- **`path:line` references** in the comment become GitHub links. They open the line in *Files changed* when it's part of the diff, and otherwise the file at the reviewed commit.

[`DECISIONS.md`](DECISIONS.md) explains why each step is built the way it is.

## Setup

You need:
- [nvm](https://github.com/nvm-sh/nvm);
- git;
- the [GitHub CLI](https://cli.github.com/) (`gh`) and the [Copilot CLI](https://github.com/github/copilot-cli) (`copilot`), both signed in;
- a clone of the reviewed repository **next to this folder**, with `origin` pointing at GitHub (for example `~/code/widget` beside `~/code/pr-review`).

To fetch `AB#` work items, you also need the [Azure CLI](https://learn.microsoft.com/cli/azure/) with the `azure-devops` extension. It's optional.

```sh
nvm install      # once: the Node version pinned in .nvmrc
npm ci
cp config.example.json config.json   # git-ignored
```

| `config.json` key | Meaning |
|---|---|
| `model` (required) | Copilot model for every agent. A run stops if an agent reports another model. |
| `checkModel` | Model for verify's check session only. Defaults to `model`. |
| `azureDevOpsOrg` | `https://dev.azure.com/<org>`, used to fetch `AB#<id>` work items. |
| `defaultRepository` | `owner/repo` to pick PRs from when you run the tool without a URL. |

**Models:**
- **Default:** `claude-sonnet-5.5` is what the pipeline was tuned with.
- **Thorough:** `claude-opus-5.5`, for large or risky PRs.
- **Cheaper:** `"checkModel": "claude-haiku-5.5"`. Keep the reviewers on Sonnet or better: they do about 75% of the work and find the bugs.

Use IDs exactly as Copilot's `/model` lists them.

**Node version:** you don't have to switch your shell to the version in `.nvmrc`. Started with an older Node, the tool restarts itself on the pinned one from your nvm folder; nothing global changes. Run `nvm use` before `npm ci` or `npm test`.

### Run it from anywhere (optional)

To start it as `reviewpr` from any folder, link the script into a folder on your `PATH`. `~/.local/bin` needs no `sudo`:

```sh
mkdir -p ~/.local/bin
ln -s "$PWD/src/review.mjs" ~/.local/bin/reviewpr   # run inside this folder
```

If `command -v reviewpr` finds nothing, add `~/.local/bin` to your `PATH` in `~/.zshrc` or `~/.bashrc`, then open a new terminal:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

The link always runs this checkout, so `git pull` updates the command. Config, reviews and the Node version all come from this folder, whatever folder you start it in. To remove it, run `rm ~/.local/bin/reviewpr`.

## Usage

```sh
reviewpr <pr-url>                # review one PR (or: node src/review.mjs <pr-url>)
reviewpr                         # pick from defaultRepository's open PRs
reviewpr --yes <url>             # no prompts, never posts; the digest goes to stdout
```

The picker lists open PRs you haven't reviewed yet, plus ones with new commits since your review. Drafts, bot PRs and your own PRs are hidden. Use `↑`/`↓` to move, Enter to choose and `q` to cancel.

While it runs, each step shows a spinner, a timer, and its live tokens and AI credits:

```
✔ ponytail-review · 736 words · 313k tokens · 1.80 AI credits · 48s
⠦ code-review · 183k tokens · 1.23 AI credits · 41s
```

At the end you see the PR, the commit, the model, what verify kept and dropped (and why), the digest, and a cost table. Then:

```
What next?
❯ Keep it local (saved in reviews/2026-11-22/widget-PR42/1430-digest.md)
  Post it as a review on acme/widget#42
  Edit the digest first
```

- **Posting** asks for the review type, with the one matching the verdict preselected: Request changes for 🔴 and ⚠️, Approve for ✅.
- **Overriding:** if you pick a type that contradicts the verdict, the verdict line is rewritten to match.
- **New commits:** if the PR has commits since the review, only Comment is offered.
- **How it posts:** one `gh pr review` as you, with a footer naming the reviewed commit.
- **No terminal:** without a terminal, or with `--yes`, nothing is ever posted.

## Output

Each run writes four files to `reviews/<date>/<repo>-PR<number>/`, prefixed with the start time (`1430-…`, then `1430b-…` for a second run in the same minute):

| File | Contents |
|---|---|
| `1430-ponytail-review.md`, `1430-code-review.md` | The raw reviews |
| `1430-verified.md` | Every finding with status, priority, `file:line` evidence and fix |
| `1430-digest.md` | The PR comment |

Example digest (fictional):

```markdown
**Verdict:** 🔴 Fix before merge. 1 must-fix, 1 should-fix.

### Must fix
1. 🔴 **Retries resend a non-idempotent POST**
   `upload.ts` · `sendChunk`
   A timeout after the server stored the chunk retries the POST and stores it twice. Fix: send an `Idempotency-Key`, or retry only on connection errors.

### Should fix
2. 🟡 **Backoff has no upper bound**
   `retry.ts:18` · `delayFor`
   After 10 attempts the delay passes 17 minutes. Fix: cap it at 30 s, as the spec says, and add a test.

<details><summary>1 minor item</summary>

- `retry.ts:4`: `MAX_ATTEMPTS` is exported but unused.
</details>
```

## Safety and data

- **Agents are read-only.** They run in the temporary clone and can read files and use read-only git, nothing else: no writes, no `gh`, no network. The clone is deleted when the run ends.
- **The reviewed repo can't steer the review.** Its own agent instructions aren't loaded, and its skills can't replace the pipeline's.
- **Your data goes to the model provider.** Copilot sends what the agents read (code, PR text, work items) to it. Saved reviews may hold sensitive content; they are owner-readable only, and `reviews/` is git-ignored.

## Development

```sh
nvm use
npm test     # local fixtures and mocked gh/az/copilot: no network, no model calls
```

- **Code:** in `src/`, with the entry point in `src/review.mjs`.
- **Skills:** in `.agents/skills/`. The two reviewers are pinned in `skills-lock.json`; update them with `npx skills update --project`. `review-digest` belongs to this project.
- **Changes:** listed in [`CHANGELOG.md`](CHANGELOG.md).

## Credits

`ponytail-review` ([dietrichgebert/ponytail](https://github.com/dietrichgebert/ponytail)) and `code-review` ([mattpocock/skills](https://github.com/mattpocock/skills)) are used unmodified under the MIT License. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
