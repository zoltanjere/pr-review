# pr-review

A cheap, verified second review for GitHub pull requests, next to Copilot's own PR review.

Two AI reviewers read the PR independently, and a verify step checks every finding against the code. You get a short PR comment of at most 250 words that you can keep or post. It runs locally through the GitHub Copilot CLI.

**What you can do with it:**
- **Review a PR:** run `reviewpr <url>` and get a verified comment in a few minutes.
- **Pick what needs you:** run `reviewpr` for a list of open PRs, sorted by what needs you most.
- **Get notified:** with `reviewpr watch --install`, a macOS notification arrives when a PR needs you again, for example when fixes are pushed after your Request changes.

Nothing is posted to GitHub unless you choose it in the terminal.

---

## Quick start

### 1. Install

You need git, [nvm](https://github.com/nvm-sh/nvm), and the [GitHub CLI](https://cli.github.com/) (`gh`) and [Copilot CLI](https://github.com/github/copilot-cli) (`copilot`), both signed in. Clone this repository **next to** your clone of the repository you review, for example `~/code/pr-review` beside `~/code/widget`.

```sh
cd pr-review
nvm install                          # the Node version pinned in .nvmrc
npm ci
cp config.example.json config.json   # git-ignored; set "model" and "defaultRepository"
mkdir -p ~/.local/bin && ln -s "$PWD/src/review.mjs" ~/.local/bin/reviewpr   # the reviewpr command
brew install terminal-notifier       # for notifications you can click
```

If `command -v reviewpr` finds nothing, add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` and open a new terminal.

### 2. Use

```sh
reviewpr https://github.com/acme/widget/pull/42   # review one PR
reviewpr                                          # pick a PR from defaultRepository
reviewpr watch --install                          # get notified in the background
```

### 3. What to expect

**When you review a PR:**
- **Duration:** it takes a few minutes, and each step shows a spinner, a timer and the live cost. A run uses about 5 Copilot sessions.
- **At the end** you see the verdict (🔴 Fix before merge, ⚠️ Changes recommended or ✅ Ship), the findings and what verify dropped and why.
- **Your choice:** keep it local (the default), post it as a review, or edit it first. Posting asks you twice, and nothing is ever posted without a terminal.
- **Your checkouts:** it reviews in a throwaway clone, so your own clones are never touched.

**After `reviewpr watch --install`:**
- **Right away:** a background check is installed and runs once. That first check only records the PRs that are already open, so **you see nothing at first. That's expected.**
- **Every 5 minutes after that,** it checks GitHub. When something changed, a macOS banner appears in the top-right corner:
  ```
  reviewpr · acme/widget
  fix: resume uploads after a dropped connection
  ⟳ #61 fixes pushed · 2 new commits
  ```
  Clicking it opens the PR in your browser. To review it, run `reviewpr` in a terminal.
- **Reboots and sleep:** it keeps working after a reboot without a terminal open. If the Mac was asleep, it checks when it wakes.
- **Cost:** none. It only reads GitHub through `gh` and uses no model. It never posts and never starts a review.
- **Defaults:** every event is on (`all`). Pick fewer in `config.json` (see [Watch](#watch)), then run `reviewpr watch --install` again.
- **To stop it:** `reviewpr watch --uninstall`.

Prefer a terminal? `reviewpr watch` keeps the PR list open, refreshes it every few minutes, and lets you press Enter to review right there. See [Watch](#watch).

### 4. If something doesn't work

| Problem | Check |
|---|---|
| No notification ever appears | Run `terminal-notifier -message test`. If nothing shows, allow notifications in **System Settings → Notifications → terminal-notifier**. Focus or Do Not Disturb hides banners, but they still land in Notification Center. |
| Banners vanish too fast | Set terminal-notifier's style to **Alerts** in the same settings page. |
| Clicking a notification does nothing | terminal-notifier isn't installed, so `osascript` showed it: `brew install terminal-notifier`. |
| Is the background check running? | `tail state/watch.log` shows one line per check (`acme/widget: 0 notifications`). `poll failed: …` usually means `gh` isn't signed in: run `gh auth status`. |
| `reviewpr: command not found` | Add `~/.local/bin` to your `PATH` (see Install). |
| A setting in `config.json` didn't apply to the background check | Run `reviewpr watch --install` again. |

---

## Reference

### Commands

```sh
reviewpr <pr-url>              # review one PR (or: node src/review.mjs <pr-url>)
reviewpr                       # pick from defaultRepository's open PRs
reviewpr --yes <url>           # no prompts, never posts; the digest goes to stdout
reviewpr watch                 # the picker, kept open, with notifications
reviewpr watch --install       # check in the background (launchd)
reviewpr watch --uninstall     # remove the background check
reviewpr watch --once          # one check by hand (what the background check runs)
```

**Node version:** you don't have to switch your shell to the version in `.nvmrc`. If you start the tool with an older Node, it restarts itself on the pinned one from your nvm folder, and nothing global changes. Run `nvm use` before `npm ci` or `npm test`.

**The `reviewpr` link:** it always runs this checkout, so `git pull` updates the command. Config, reviews and the Node version come from this folder, whichever folder you start it in. To remove it, run `rm ~/.local/bin/reviewpr`.

### Configuration

`config.json` (git-ignored; start from `config.example.json`):

| Key | Meaning |
|---|---|
| `model` (required) | Copilot model for every agent. A run stops if an agent reports a different model. |
| `checkModel` | Model for verify's check session only. Defaults to `model`. |
| `azureDevOpsOrg` | `https://dev.azure.com/<org>`, used to fetch `AB#<id>` work items. This needs the [Azure CLI](https://learn.microsoft.com/cli/azure/) with the `azure-devops` extension, and is optional. |
| `defaultRepository` | `owner/repo` to pick PRs from, and for watch to check. |
| `watch.events` | Which changes notify you (see [Watch](#watch)). Defaults to `["all"]`. |
| `watch.intervalMinutes` | How often watch checks. Defaults to 5; the minimum is 2. |

**Models:**
- **Default:** `claude-sonnet-5.5` is what the pipeline was tuned with.
- **Thorough:** `claude-opus-5.5`, for large or risky PRs.
- **Cheaper:** `"checkModel": "claude-haiku-5.5"`. Keep the reviewers on Sonnet or better: they do about 75% of the work and find the bugs.

Use model IDs exactly as Copilot's `/model` lists them.

### PR picker

`reviewpr` without a URL lists the open PRs of `defaultRepository` that you haven't reviewed yet, plus ones with new commits since your review, grouped by what needs you most:

```
acme/widget: 6 to review, 1 yours, 1 skipped (9 open; hidden: 1 draft)
  Fixes pushed
❯ ⟳ #61  octo-dev   fix: resume uploads after a dropped connection      3 new commits · 2h
  Asked for you
  ★ #66  lee-park   chore: bump the test runner to the latest minor         requested · 5h
  New
  ● #68  octo-dev   feat: show upload progress in the status bar            opened 42m ago
  Updated
  ↑ #52  ana-dev    refactor: split the queue worker                        updated 3h ago
  Waiting
  · #49  sam-codes  docs: explain chunk sizes                                           4d
  ◌ #31  lee-park   feat: offline mode                                            idle 23d
  Your PRs
  ◆ #70  me         feat: retry budget per tenant             1 approval · conflicts
```

- **Groups, most urgent first:**
  - **⟳ Fixes pushed:** you requested changes or commented, and the author has pushed since.
  - **★ Asked for you:** you're a requested reviewer.
  - **● New since you looked / ↑ Updated since you looked:** opened or updated since you last opened the picker for this repository (on a first visit: the last 24 h). The header says when that was: `last looked 2d ago`.
  - **↑ Approved, new commits:** you approved, and commits came in after.
  - **Waiting:** the rest. **◌** marks PRs idle for 14 days or more.
  - **◆ Your PRs:** your own open PRs, drafts included, for a self-review.
    - The label shows what others did (`2 approvals · 1 change request · conflicts`), and your own comments never mark them as reviewed.
    - GitHub doesn't let you approve or request changes on your own PR, so a self-review posts as a comment. Its verdict line reads `Self-review: ✅ Ship.` or `Self-review: 🔴 Fix before merge.`.
- **Colours:** the icon and the group heading carry the state's colour. The label on the right is coloured by age: green under a day, plain up to a week, yellow from a week, red from two weeks. Without colour, the icons and labels carry the same information.
- **Hidden:** other people's drafts and bot PRs.
- **Keys:** `↑`/`↓` move, Enter reviews, and `q` cancels. `s` skips the highlighted PR until its author pushes a new commit, and `a` shows skipped PRs again (press `s` on one to unskip it).
- **Where this is kept:** skips and the time you last looked live in `state/picker.json` on your machine only, which is git-ignored. Nothing is written to GitHub.

### Watch

Watch sends a macOS notification when something you care about changes. It checks with read-only `gh` calls and uses no model.

**Events:** set them in `config.json`. Without a `watch` block you get every event, as with `"events": ["all"]`. `config.example.json` lists every event, so you can copy it and delete the ones you don't want:

```json
"watch": { "events": ["new", "fixes-after-changes", "merged-reviewed"], "intervalMinutes": 5 }
```

| Event | Notifies when |
|---|---|
| `new` | a PR you can review appears: opened, or moved out of draft (not yours, not a bot's) |
| `fixes-after-changes` | new commits after your Request changes |
| `reviewed-updated` | new commits on any PR you reviewed (Approve, Request changes or Comment) |
| `merged-reviewed` | a PR you reviewed, or one of yours, is merged |
| `merged` | any PR in the repository is merged (the noisiest on a busy repository) |
| `review-requested` | you're asked to review, or asked again |
| `my-pr-reviewed` | someone approves, requests changes on or comments on one of your PRs |
| `my-pr-conflicts` | one of your PRs starts having merge conflicts |
| `all` | every event above |

- **One change, one notification:** even when it matches several events (for example `fixes-after-changes` and `reviewed-updated`).
- **First check:** it only records what's already open, so you don't get a burst for old PRs.
- **Typos:** a misspelled event name stops watch with the list of valid names.

**Two modes; use either or both:**
- **In the background** (`reviewpr watch --install`):
  - A launchd agent, `~/Library/LaunchAgents/local.reviewpr.watch.plist`, runs `reviewpr watch --once` at load and then every `intervalMinutes`, including after a reboot.
  - It uses the Node and `PATH` of the terminal you install from, so install from a shell where `gh` works.
  - Its log is `state/watch.log`. Run `--install` again after changing `watch` in `config.json`.
- **In a terminal** (`reviewpr watch`): the picker, kept open.
  - It checks on the same interval, refreshes the list in place and marks new items with `•` until you move onto them. `r` checks immediately.
  - Enter reviews the highlighted PR right there, and you come back to the list afterwards. Checking continues during a review, as desktop notifications only.
  - Merges and events on your own PRs appear on the status line, such as `✔ #61 merged by lee-park · 2m ago`.
  - While it's open, the background check stays quiet, so you never get two notifications for one change.
  - A failed check keeps the last list on screen and says so, and the third failure in a row sends one notification.

Notifications never start a review or post anything; clicking one only opens the PR. Watch's memory lives in `state/watch.json`, which is git-ignored.

### A review run

```
prepare ── temporary clone at the PR head, diff, PR body, commits, linked issues, AB# work items
           and the state of PRs the body names (open, merged, draft)
   ├─ ponytail-review   correctness, safety, load, tests       ┐ in parallel
   └─ code-review       repo standards + "does it match spec"  ┘
verify  ── list and tier the findings, then check them against the cited code
digest  ── verdict line + at most 5 findings, minor items folded
```

- **Verify** is the only step that sets priority: *Must fix*, *Should fix* or *Minor*. Every rejected finding is kept with its reason.
- **The verdict line** is set in code from those priorities, so it can't contradict the findings: 🔴 Fix before merge, ⚠️ Changes recommended, or ✅ Ship.
- **`path:line` references** in the comment become GitHub links. They open the line in *Files changed* when it's part of the diff, and otherwise the file at the reviewed commit.

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
- **New commits or your own PR:** only Comment is offered.
- **How it posts:** one `gh pr review` as you, with a footer naming the reviewed commit.
- **No terminal:** without a terminal, or with `--yes`, nothing is ever posted.

[`DECISIONS.md`](DECISIONS.md) explains why each step is built the way it is.

### Output

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

### Safety and data

- **Agents are read-only.** They run in the temporary clone and can read files and use read-only git, nothing else: no writes, no `gh`, no network. The clone is deleted when the run ends.
- **The reviewed repository can't steer the review.** Its own agent instructions aren't loaded, and its skills can't replace the pipeline's.
- **GitHub is only read**, except for the one review you choose to post. Watch and the picker write only to `state/`, which is git-ignored, and `watch --install` writes one launchd file.
- **Your data goes to the model provider.** Copilot sends what the agents read (code, PR text, work items) to it. Saved reviews may hold sensitive content; they are readable only by you, and `reviews/` is git-ignored. Watch sends nothing anywhere: PR titles appear only in your own notifications.

### Development

```sh
nvm use
npm test     # local fixtures and mocked gh/az/copilot/launchd: no network, no model calls
```

- **Code:** in `src/`, with the entry point in `src/review.mjs`.
- **Skills:** in `.agents/skills/`. The two reviewers are pinned in `skills-lock.json`; update them with `npx skills update --project`. `review-digest` belongs to this project.
- **Changes:** listed in [`CHANGELOG.md`](CHANGELOG.md).

## Credits

`ponytail-review` ([dietrichgebert/ponytail](https://github.com/dietrichgebert/ponytail)) and `code-review` ([mattpocock/skills](https://github.com/mattpocock/skills)) are used unmodified under the MIT License. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
