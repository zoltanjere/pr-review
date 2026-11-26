# pr-review

A cheap, verified second review for GitHub pull requests.

Two AI reviewers read the PR, and a verify step checks every finding against the code. You get a short comment that you can keep or post. Nothing is posted to GitHub unless you choose it in the terminal.

- **Review a PR:** `reviewpr <url>` gives you a verified comment in a few minutes.
- **Pick what needs you:** `reviewpr` lists the open PRs, most urgent first.
- **Get notified (macOS):** `reviewpr watch --install` tells you when a PR needs you again.

---

## Quick start

### 1. What you need

- **git** and **[nvm](https://github.com/nvm-sh/nvm)**. The right Node version comes from `.nvmrc`.
- **The [GitHub CLI](https://cli.github.com/) (`gh`)**, signed in. It reads the PRs.
- **One model provider**, signed in. It runs the AI reviewers:
  - **[Copilot CLI](https://github.com/github/copilot-cli) (`copilot`)**, the default. It needs a GitHub Copilot plan.
  - **or [Claude Code](https://docs.claude.com/en/docs/claude-code/setup) (`claude`)**, which needs a Claude plan. It's macOS only for now.
- **This repository cloned next to the one you review**, for example `~/code/pr-review` beside `~/code/widget`.

### 2. Install

**macOS:**

```sh
brew install gh copilot-cli          # using Claude Code instead? install it from its setup page
gh auth login
copilot login                        # or: claude auth login
cd pr-review
nvm install && npm ci
cp config.example.json config.json   # then list the owner/repo you review in "repositories"
mkdir -p ~/.local/bin && ln -s "$PWD/src/review.mjs" ~/.local/bin/reviewpr
```

If `reviewpr` isn't found afterwards, add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` and open a new terminal.

**Windows** (reviews and summaries with Copilot), in PowerShell:

```powershell
winget install GitHub.cli
winget install GitHub.Copilot
gh auth login
copilot login
cd pr-review
nvm use 26                           # nvm-windows
npm ci
copy config.example.json config.json # then set "repositories"
```

On Windows, type `npm run review --` where the commands below say `reviewpr`, for example `npm run review -- <PR URL>`.

### 3. Use

```sh
reviewpr <PR URL>            # review one PR
reviewpr                     # pick a PR from your repositories, then review or summarise it
reviewpr settings            # switch between Copilot and Claude Code, or change the model
reviewpr watch --install     # macOS: get notified when a PR needs you
```

At the end of a review you see the verdict and the findings. You then keep it local (the default), post it, or edit it first. Your own clones are never touched.

### 4. If something doesn't work

When something is missing, the tool says what it is and how to fix it:

| You see | Do this |
|---|---|
| `… isn't installed, or isn't on your PATH` | Install it as the message says, or switch provider with `reviewpr settings`. |
| `… isn't signed in` | Run the command it names: `gh auth login`, `copilot login` or `claude auth login`. |
| `Could not read model configuration …` | Run `cp config.example.json config.json`. |
| `reviewpr: command not found` | Add `~/.local/bin` to your `PATH` (see Install). |
| No notifications from watch | See [Watch: troubleshooting](#watch-troubleshooting). |

---

## Reference

### Commands

```sh
reviewpr <pr-url>              # review one PR (or: node src/review.mjs <pr-url>)
reviewpr                       # pick from the open PRs of your repositories
reviewpr --yes <url>           # no prompts, never posts; the digest goes to stdout
reviewpr --full <url>          # a full review, even where a follow-up is possible
reviewpr --summary <url>       # a short, plain summary of what the PR does; never posted
reviewpr watch                 # the picker, kept open, with notifications
reviewpr watch --install       # check in the background (launchd)
reviewpr watch --uninstall     # remove the background check
reviewpr watch --once          # one check by hand (what the background check runs)
reviewpr settings              # choose the provider (Copilot or Claude Code) and its model
```

**Node version:** you don't have to switch your shell to the version in `.nvmrc`. If you start the tool with an older Node, it restarts itself on the pinned one from your nvm folder, and nothing global changes. Run `nvm use` before `npm ci` or `npm test`.

**The `reviewpr` link:** it always runs this checkout, so `git pull` updates the command. Config, reviews and the Node version come from this folder, whichever folder you start it in. To remove it, run `rm ~/.local/bin/reviewpr`.

### Configuration

`config.json` (git-ignored; start from `config.example.json`):

| Key | Meaning |
|---|---|
| `provider` | `"copilot"` (the default) or `"claude"`: which CLI runs the agents. See [Settings](#settings). |
| `model` (required for Copilot) | Copilot model for every agent. A run stops if an agent reports a different model. |
| `checkModel` | Copilot model for the check, follow-up and summary sessions. Defaults to `model`. |
| `claude.model` (required for Claude Code) | Claude Code model for every agent, such as `claude-sonnet-5-5`. |
| `claude.checkModel` | Claude Code model for the check, follow-up and summary sessions. Defaults to `claude.model`. |
| `notify` | `false` turns off the terminal bell when a review or summary is done. On by default; also in [Settings](#settings). |
| `azureDevOpsOrg` | `https://dev.azure.com/<org>`, used to fetch `AB#<id>` work items. This needs the [Azure CLI](https://learn.microsoft.com/cli/azure/) with the `azure-devops` extension, and is optional. |
| `repositories` | The repositories to pick PRs from, and for watch to check: `["acme/widget", "acme/gadget"]`. An entry can also be `{ "repo": "acme/widget-fe", "alias": "fe" }`, to name it `fe` in the PR list (see [Settings](#settings)). Each needs a local clone next to this folder for its PRs to be listed. The older `"defaultRepository": "acme/widget"` still works as a list of one; set one or the other, not both. |
| `watch.events` | Which changes notify you (see [Watch](#watch)). Defaults to `["all"]`. |
| `watch.intervalMinutes` | How often watch checks. Defaults to 5; the minimum is 2. |

**Models:**
- **Default:** `claude-sonnet-5.5` is what the pipeline was tuned with.
- **Thorough:** `claude-opus-5.5`, for large or risky PRs.
- **Cheaper:** `"checkModel": "claude-haiku-5.5"`. Keep the reviewers on Sonnet or better: they do about 75% of the work and find the bugs.

Use model IDs exactly as Copilot's `/model` lists them. Claude Code names the same models differently (`claude-sonnet-5-5`), which is why each provider keeps its own.

### Settings

`reviewpr settings`, or `c` in the picker, opens a small screen with four rows:

- **Provider:** where the models come from: **Copilot** or **Claude Code**. A CLI that isn't installed (or Claude Code on Windows) is shown but can't be chosen. A provider that isn't signed in can be chosen, with a warning that names the sign-in command. Choosing a provider for the first time sets its model to Sonnet.
- **Model:** a short list for the current provider (Haiku, Sonnet, Opus), or **Other** to type any ID. The choice sets both `model` and `checkModel` of that provider; the screen says when it replaced a different check model. A separate check model can still be set by hand in `config.json`.
- **Bell:** on or off (`notify` in `config.json`). See [A review run](#a-review-run).
- **Repositories:** a short name (alias) for each repository in `repositories`, used in the PR list's repository column. Enter on a repository asks for its alias, and an empty answer removes it. An alias is 1 to 14 characters (letters, digits, `.` `_` `/` `-`), is shown exactly as typed, and can't be another repository's alias or name. It's saved as `{ "repo": "…", "alias": "…" }` in `repositories`. Adding or removing repositories is done in `config.json`.

The picker shows the current setting above its keys: `Provider: Claude Code · Model: claude-sonnet-5-5`, and so does every run. The choice is saved in this project's `config.json` only. Neither CLI's own settings, `gh` or your other projects change.

**Using Claude Code instead of Copilot:**
1. Install Claude Code from its [setup page](https://docs.claude.com/en/docs/claude-code/setup), and sign in with `claude auth login`.
2. Run `reviewpr settings`, choose **Provider → Claude Code**, and optionally pick a model.
3. Review as usual. Every run checks first that `claude` is installed and signed in, and says how to fix it if not. Copilot can stay installed; switch back the same way.

**How Claude Code runs:** each agent is one `claude -p` process signed in with your own Claude login. It runs with your settings, `CLAUDE.md` files, memory, hooks, plugins and MCP servers turned off for that process only. The pipeline skills come from a plugin staged in the temporary workspace, so they load as `prreview:<skill>`, never a built-in or personal skill of the same name. Agents may read the checkout and the workspace, and run read-only commands there. Reads elsewhere, `git -C` and writes are refused. Claude Code keeps a small folder per working directory in `~/.claude/projects`; the one for the temporary checkout is removed after each step. Claude runs show tokens only: a Claude plan has no AI credits. Claude Code isn't supported on Windows yet.

### PR picker

`reviewpr` without a URL lists the open PRs of your `repositories` that you haven't reviewed yet, plus ones with new commits since your review, grouped by what needs you most:

```
acme/widget: 6 to review, 1 yours, 1 skipped (9 open; hidden: 1 draft)
  Fixes pushed
❯ ⟳ #61  2h   octo-dev   fix: resume uploads after a dropped connection  3 new commits
  ⟳ #57  1d   sam-codes  feat: retry budget per tenant                   1 new commit · full review: history rewritten
  Asked for you
  ★ #66  5h   lee-park   chore: bump the test runner                     requested
  New since you looked
  ● #68  10m  octo-dev   feat: show upload progress in the status bar
  Updated since you looked
  ↑ #52  3h   ana-dev    refactor: split the queue worker
  No new changes since your review
  … #45  1h   sam-codes  fix: chunk retry order                          rebased only
  Waiting
  · #49  4d   sam-codes  docs: explain chunk sizes
  ◌ #31  23d  lee-park   feat: offline mode                              idle
  Your PRs
  ◆ #70  1d   me         feat: retry budget per tenant                   1 approval · conflicts
```

- **Groups, most urgent first:**
  - **⟳ Fixes pushed:** you requested changes or commented, and the author has pushed since. Enter runs a [follow-up review](#follow-up-reviews). When one isn't possible, the row says so (`full review: history rewritten`, `commit gone`, `no findings` or `hand-written review`).
  - **★ Asked for you:** you're a requested reviewer.
  - **● New since you looked / ↑ Updated since you looked:** opened or updated since you last opened the picker for this repository (on a first visit: the last 24 h). The header says when that was: `last looked 2d ago`.
  - **↑ Approved, new commits:** you approved, and commits came in after. Enter reviews only the new commits (see [Follow-up reviews](#follow-up-reviews)), so re-approving after a push that dismissed your approval is quick.
  - **… No new changes since your review:** the author only rebased or merged the base branch in (`rebased only`, `merged main only`), and the PR's own changes are exactly as you reviewed them. Nothing for you to check yet, and watch doesn't notify. The next real change moves it back to Fixes pushed, with no skip needed.
    - It's checked with two read-only calls that compare what the PR changes, then and now, by added and removed lines. Line positions and context are ignored, because a rebase shifts them. If it can't tell (a failed call, 300 or more files), the row stays in Fixes pushed.
  - **Waiting:** the rest. **◌** marks PRs idle for 14 days or more.
  - **◆ Your PRs:** your own open PRs, drafts included, for a self-review.
    - The label shows what others did (`2 approvals · 1 change request · conflicts`), and your own comments never mark them as reviewed.
    - GitHub doesn't let you approve or request changes on your own PR, so a self-review posts as a comment. Its verdict line reads `Self-review: ✅ Ship.` or `Self-review: 🔴 Fix before merge.`.
- **Age:** the column after the PR number says how long ago its activity was: opened for New, updated for Updated, the last new commit for Fixes pushed.
  - It's coloured green under a day, plain up to a week, yellow from a week and red from two weeks.
  - Details such as `3 new commits` follow the titles, and rows are at most 100 columns wide, so nothing drifts to the far edge of a wide terminal.
- **Colours:** the icon and the group heading carry the state's colour. Without colour, the icons, ages and labels carry the same information.
- **Hidden:** other people's drafts and bot PRs.
- **Keys:** `↑`/`↓` move, Enter picks the PR, `f` starts a full review straight away, `c` opens [Settings](#settings), and `q` cancels.
  - **After Enter,** a small menu asks what to do: **Review it** (the default, so Enter twice reviews as before, a follow-up where possible), **Summarise it first** (see [PR summary](#pr-summary)), or **Back to the list**.
  - **Other keys:** `s` skips the highlighted PR until its author pushes a new commit, and `a` shows skipped PRs again (press `s` on one to unskip it).
- **Several repositories:** their PRs share one list, in the same groups and order, so the most urgent PR comes first whichever repository it's in. A column after the icon names the repository:
  ```
  2 repositories: 4 to review (11 open; hidden: 1 draft) · last looked 2h ago
    Fixes pushed
  ❯ ⟳ widget  #61   2h   octo-dev   fix: resume uploads after a dropped connection  3 new commits
    Asked for you
    ★ gadget  #204  5h   lee-park   chore: bump the test runner                     requested
    New since you looked
    ● gadget  #210  1h   ana-dev    fix: null tenant id
    ● widget  #68   10m  octo-dev   feat: show upload progress in the status bar
  ```
  - **The column** shows the repository's alias when you set one in [Settings](#settings). Otherwise it shows the repository's name, or `owner/repo` when two configured repositories have the same name, at most 14 characters and cut with `…`, so a long name never pushes the titles right. Names that differ only at the end, such as `word-word-word-fe` and `word-word-word-be`, are hard to tell apart once cut; give them aliases such as `fe` and `be`. With one repository there's no column and the list looks as before.
  - **A repository that can't be read** (no access, no local clone, a GitHub error) is named in the header, `⚠ api: couldn't read (…)`, and the others are still listed. Its "since you looked" time is kept for the next visit.
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
  - It checks every repository in `repositories`. Its log is `state/watch.log`, with one line per repository per check. See [Updating watch](#updating-watch) for when to run `--install` again.
- **In a terminal** (`reviewpr watch`): the picker, kept open.
  - It checks on the same interval, refreshes the list in place and marks new items with `•` until you move onto them. `r` checks immediately.
  - Enter opens the same menu (Review it, Summarise it first, Back to the list) for the highlighted PR, right there, and you come back to the list afterwards. Checking continues during a review, as desktop notifications only.
  - Merges and events on your own PRs appear on the status line, such as `✔ #61 merged by lee-park · 2m ago` (`widget: ✔ #61 merged …` with several repositories).
  - While it's open, the background check stays quiet, so you never get two notifications for one change.
  - A failed check keeps the last list on screen and says so, and the third failure in a row sends one notification.

- **Several repositories:** each one is checked, primed and remembered on its own, and every notification names its repository. One that can't be read is logged (`poll failed: acme/api: …`) and the others still notify; in the open app, three failed checks in a row for one repository send one notification.

Notifications never start a review or post anything; clicking one only opens the PR. Watch's memory lives in `state/watch.json`, which is git-ignored.

#### Updating watch

Each background check is a fresh `node src/review.mjs watch --once`, so it picks up most changes by itself. An open `reviewpr watch` is one long-running process, so it doesn't.

| What changed | Background watch (`--install`) | Open `reviewpr watch` |
|---|---|---|
| reviewpr's code (`git pull`) | Nothing to do: the next check runs the new code. | Press `q` and start it again. |
| Dependencies (`npm ci`) | Nothing to do. | `q` and start it again. |
| `repositories` or `watch.events` in `config.json` | Nothing to do: every check reads `config.json`. | `q` and start it again. |
| `watch.intervalMinutes` | Run `reviewpr watch --install` again: the interval is stored in the launchd agent. | `q` and start it again. |
| Node version (for example with nvm) | Run `reviewpr watch --install` again from a shell on the new Node: the agent stores Node's full path and your `PATH`. If that Node was removed, checks fail and `state/watch.log` says so. | `q` and start it again. |

#### After `reviewpr watch --install`

For notifications you can click, also run `brew install terminal-notifier`.

- **Right away:** a background check is installed and runs once. That first check only records the PRs that are already open, so **you see nothing at first. That's expected.**
- **Every 5 minutes after that,** it checks GitHub. When something changed, a macOS banner appears in the top-right corner:
  ```
  ⟳ #61 fixes pushed
  fix: resume uploads after a dropped connection
  by octo-dev · 2 new commits · acme/widget
  ```
  The first line says what happened, the second is the PR title, the third says who and how much. It plays the default sound, and clicking it opens the PR in your browser. To review it, run `reviewpr` in a terminal.
- **Reboots and sleep:** it keeps working after a reboot without a terminal open. If the Mac was asleep, it checks when it wakes.
- **Cost:** none. It only reads GitHub through `gh` and uses no model. It never posts and never starts a review.
- **Defaults:** every event is on (`all`). Pick fewer in `config.json` (see [Watch](#watch)); the next check uses them.
- **To stop it:** `reviewpr watch --uninstall`.

Prefer a terminal? `reviewpr watch` keeps the PR list open, refreshes it every few minutes, and lets you press Enter to review right there. See [Watch](#watch).

#### Watch troubleshooting

| Problem | Check |
|---|---|
| Which notifications will I get? | `reviewpr watch --install` sends a test notification and says which mode works: **clickable** (terminal-notifier, clicking opens the PR) or **plain** (osascript, ends with "run reviewpr"; clicking can't open the PR). Plain needs no setup. You get it when terminal-notifier isn't installed, or before macOS allows it. macOS can ask to allow terminal-notifier some time after its first notification attempt, not right away: click **Allow** (and choose **Alerts** to keep banners on screen), then run `reviewpr watch --install` again to confirm clickable mode. |
| No notification ever appears | Install says `Notifications: not working`. Check Focus or Do Not Disturb (banners still land in Notification Center), and **System Settings → Notifications**. |
| Banners vanish too fast | Set terminal-notifier's style to **Alerts** in **System Settings → Notifications**. |
| Is the background check running? | `tail state/watch.log` shows one line per repository per check (`acme/widget: 0 notifications`). `poll failed: …` usually means `gh` isn't signed in: run `gh auth status`. `poll failed: acme/api: …` alone means that one repository can't be read: check its name and your access. |
| A setting in `config.json` didn't apply | See [Updating watch](#updating-watch): only `intervalMinutes` needs `reviewpr watch --install` again; an open `reviewpr watch` needs a restart. |

### A review run

- **Duration:** a few minutes. Each step shows a spinner, a timer and the live cost. A run uses about 5 agent sessions.
- **At the end** you see the verdict (🔴 Fix before merge, ⚠️ Changes recommended or ✅ Ship), the findings, and what verify dropped and why.
- **Your choice:** keep it local (the default), post it as a review, or edit it first. Posting asks you twice, and nothing is ever posted without a terminal.
- **After fixes:** reviewing a PR again where you requested changes or commented runs a quicker [follow-up review](#follow-up-reviews). It checks only your earlier points and the new commits.
- **The bell:** when a review or summary is done, or fails, the terminal bell rings once, so you can work elsewhere meanwhile. It rings only in a terminal, and not for runs under 30 seconds or with `--yes`. What you notice depends on your terminal:
  - **macOS Terminal:** the dock icon bounces, or shows a badge, when the window isn't in front. Turn on Settings → Profiles → Advanced → Bell ("Audible bell" and "Visual bell") if it's quiet.
  - **iTerm2:** the dock icon bounces and the tab shows a bell. Profiles → Terminal → Notifications can also show a banner.
  - **VS Code:** set `accessibility.signals.terminalBell` to on.
  - **Windows Terminal:** the tab shows a bell and the taskbar button flashes.
  - Turn it off with **Bell** in `reviewpr settings`, or `"notify": false` in `config.json`.

```
prepare ── temporary clone at the PR head, diff, PR body, commits, linked issues, AB# work items
           and the state of PRs the body names (open, merged, draft)
   ├─ ponytail-review   correctness, safety, load, tests       ┐ in parallel
   └─ code-review       repo standards + "does it match spec"  ┘
verify  ── list and tier the findings, then check them against the cited code
digest  ── verdict line + at most 5 findings, minor items folded
```

- **Verify** is the only step that sets priority: *Must fix*, *Should fix* or *Minor*. Every rejected finding is kept with its reason.
- **The verdict line** is set in code from those priorities, so it can't contradict the findings: 🔴 Fix before merge for any Must fix, ⚠️ Changes recommended for 4 or more Should fix, otherwise ✅ Ship. Up to 3 Should fix items and open questions don't hold back ✅ Ship: the line then says "2 should-fix, 1 question, none blocking."
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

- **Posting** asks for the review type, with the one matching the verdict preselected: Request changes for 🔴, Comment only for ⚠️, Approve for ✅. If GitHub refuses the post (an outage, say), you're asked again, so you can retry or keep it local without a new run. A review GitHub saved despite the error counts as posted, so it's never posted twice.
- **Overriding:** if you pick a type that contradicts the verdict, the verdict line is rewritten to match.
- **New commits or your own PR:** only Comment is offered.
- **How it posts:** one `gh pr review` as you, with a footer naming the reviewed commit.
- **No terminal:** without a terminal, or with `--yes`, nothing is ever posted.

[`DECISIONS.md`](DECISIONS.md) explains why each step is built the way it is.

### Follow-up reviews

When you review a PR again after your **Request changes**, **Comment** or **Approve**, reviewpr checks what changed instead of reviewing everything again:

```
prepare ── your posted review: its findings and the commit it covered
           the new code since then (only the PR's own files) and the replies since then
   ├─ follow-up check   each earlier finding: Fixed, Partly fixed, Answered or Still open   ┐ in parallel
   └─ scan              the new commits only: problems the fixes introduce                ┘
verify  ── checks the scan's findings, as in a full review
digest  ── verdict, a re-review notice for the author, still open, new, resolved
```

- **Before any model runs,** the terminal says which it will be: `Follow-up of your review at abc1234: 2 new commits, 4 findings to check.`, or a full review and why. Ctrl-C still cancels.
- **After your approval** (also one a push dismissed), only the new commits are scanned: `Follow-up of your approval at abc1234: 2 new commits, only the new code is reviewed.` Points the approval left open, such as questions, are checked too. With nothing new the verdict is `✅ Ship. Nothing new.` and Approve is preselected, so you can approve again. New problems get the usual verdict, under **New since the approval**. A hand-written approval works the same way, without earlier points.
- **Answers count:** when the author replied instead of changing the code, the check quotes the reply and judges it against the code: accepted (resolved) or disputed (still open).
- **The comment tells the author what was re-reviewed:**
  ```
  **Verdict:** ✅ Ship. 1 still open, 1 new, none blocking.

  > 🔁 **Re-review since `abc1234`** (2 new commits): only the 4 earlier points and what the new commits changed were checked.
  > 2 fixed, 1 answered, 1 still open, 1 new.

  ### Still open from the last review
  ### New in the fixes
  <details> Resolved since the last review: 2 fixed, 1 answered
    - ✅ Retry resends a chunk the server already stored
    - ✅ Backoff has no upper bound
    - 💬 The spec says uploads over 5 GB are refused, but `MAX_SIZE` is 50 GB
  </details>
  ```
- **Short by design:** resolved points are one line each (✅ fixed, 💬 answered), with no explanation. Only open points carry a reason. The full evidence for every point is in the saved `…-follow-up.md`.
- **Partly fixed points are rated again:** what remains of a partial fix gets its own priority, never higher than before. A remainder rated Minor folds into a `<details>` list and doesn't count against the verdict.
- **Verdict:** 🔴 when a Must fix is still open, disputed or new; ⚠️ when 4 or more Should fix are open or new; otherwise ✅, which says "none blocking" when points are still open ("2 still open, none blocking.").
- **Cost:** two sessions plus a small verify, instead of two full reviewers plus verify.
- **Chains:** the posted footer reads `Follow-up at def5678 of the review at abc1234`, so the next follow-up checks only what was still open.
- **When it runs a full review instead,** and says why in the terminal, on the picker row and to the author under the verdict:

  | Situation | Why |
  |---|---|
  | `--full`, or `f` in the picker | you asked for one |
  | your last review wasn't posted by reviewpr | its findings can't be read |
  | your last review had no numbered findings | nothing to follow up |
  | a rebase or force-push removed the reviewed commit and changed the PR's code | earlier findings can't be checked line by line |
  | GitHub no longer has the reviewed commit | the same |

- **A rebase with no changes** is still a follow-up, not a full review: your findings apply to the same code, so it checks them against the replies and the current code, and the notice says `(rebased, no changes to the PR's code)`.
- **Not tracked:** minor items from the earlier review (they were optional), and reviews by other people.

### PR summary

**Summarise it first** (or `--summary`) tells you what a PR does before you spend a review on it. One model session (the check model) reads the PR description, its linked issues and the code changes, and writes a short, plain description for a developer who doesn't know that part of the code. PR descriptions are often long and full of evidence; this isn't.

```
Uploads now pick up where they stopped after a dropped connection, instead of starting again.

What changes
• A large file that loses its connection halfway resumes from the last finished chunk.
• Each chunk is retried up to 3 times before the upload gives up.

Worth knowing
• The description also promises a cancel button, but this PR doesn't add one.

6 files · +210 −40 · mostly tests
```

- **Shape:** one sentence that says what's different after the PR, then 2 to 4 short bullets, and at most 2 points worth knowing: a behaviour change, something removed, a risk, or where the description and the code disagree. About 100 words at most; a tiny PR gets only the first line.
- **Left out:** file and function names, logs, test counts, ticket numbers, links, and any judgement of quality. That's the review's job.
- **The code wins:** when the description says something the code doesn't do, the summary describes the code and says so.
- **Size line:** counted from the diff, not written by the model.
- **Afterwards:** **Review it now**, **Back to the list**, or **Done** (the watch app has no Done; its list is always there).
- **Never posted.** It's saved as `1430-summary.md` next to the review files. Not in a terminal, `--summary` also prints it to stdout.

### Output

Each run writes four files to `reviews/<date>/<repo>-PR<number>/`, prefixed with the start time (`1430-…`, then `1430b-…` for a second run in the same minute):

| File | Contents |
|---|---|
| `1430-ponytail-review.md`, `1430-code-review.md` | The raw reviews |
| `1430-verified.md` | Every finding with status, priority, `file:line` evidence and fix |
| `1430-digest.md` | The PR comment |
| `1430-summary.md` | A [PR summary](#pr-summary), when you asked for one (its own run, never posted) |

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

### Windows

Reviews and summaries work in Windows Terminal with Copilot; watch and notifications are macOS only, and so is the Claude Code provider for now. `winget install GitHub.Copilot` or `npm install -g @github/copilot` both work. With nvm-windows, Node 26 must be on `PATH`, because it isn't switched to by itself.

- Agents use PowerShell as their shell, with the same read-only git rules.
- The temporary clone turns on git's long paths by itself, so repositories with deep folders check out.
- Edit before posting opens `$env:EDITOR`, or Notepad when it isn't set.
- Saved files get your folder's usual permissions: Windows ignores the private `0600` mode used on macOS.
- Very large reviews (more than about 20 long findings) can hit Windows' 32,767-character command-line limit in the check step.

### Safety and data

- **Agents are read-only.** They run in the temporary clone and can read files and use read-only git, nothing else: no writes, no `gh`, no network. The clone is deleted when the run ends.
- **The reviewed repository can't steer the review.** Its own agent instructions aren't loaded, and its skills can't replace the pipeline's.
- **GitHub is only read**, except for the one review you choose to post. Watch and the picker write only to `state/`, which is git-ignored, and `watch --install` writes one launchd file.
- **Your data goes to the model provider.** Copilot or Claude Code sends what the agents read (code, PR text, work items) to its model provider, under the terms of the account it's signed in with. With Claude Code on a personal plan, those are your personal terms, not your employer's: check that they allow it for the code you review. Saved reviews may hold sensitive content; they are readable only by you (on Windows, by whoever can read the folder), and `reviews/` is git-ignored. Watch sends nothing anywhere: PR titles appear only in your own notifications.

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
