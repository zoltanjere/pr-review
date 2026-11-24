# Changelog

This project follows [semantic versioning](https://semver.org/). A pipeline or terminal-output change bumps the minor version.

## 0.11.1 (2026-11-24)

- **Windows support for reviews and summaries:** an npm-installed `copilot` (`copilot.cmd`) is started through Node without a shell, so prompts pass safely; `az.cmd` runs through the shell only with plain arguments. Agents get the PowerShell tool instead of bash, under the same read-only git rules. The temporary clone allows long paths, Edit falls back to Notepad, and cleanup retries when a file is briefly locked. Nothing changes on macOS. Watch stays macOS only.

## 0.11.0 (2026-11-23)

- **Summarise a PR before reviewing it:** after you pick a PR (in `reviewpr` and `reviewpr watch`), a menu offers **Review it** (the default, so Enter twice works as before), **Summarise it first**, or **Back to the list**. The summary is a short, plain description of what the PR does, written by one check-model session from the description and the code: one standalone sentence, a few "What changes" bullets, and "Worth knowing" points such as where the description and the code disagree. It's saved as `<id>-summary.md` and never posted. Afterwards: Review it now, Back to the list, or Done.
- **`--summary`:** summarise a PR from the command line; not in a terminal, it prints the summary to stdout.
- **`f` in the picker** still starts a full review straight away, without the menu.

## 0.10.0 (2026-11-23)

- **Rebases don't look like fixes:** after your review, a PR that was only rebased or had the base branch merged in, with its own changes exactly as reviewed, moves to "No new changes since your review" (`rebased only`, `merged main only`) instead of Fixes pushed, and watch doesn't notify. A follow-up on it checks your points against the replies instead of falling back to a full review.
- **The follow-up scan covers every changed file,** workflows and configuration included, and checks that no other change undoes a fix.
- **Follow-up digests stay short:** resolved points are one line each (✅ fixed, 💬 answered) with no explanation, titles are cut at 80 characters, and the re-review notice is two lines.
- **Follow-up reviews:** reviewing a PR again after your Request changes or Comment checks each earlier finding (fixed, partly fixed, answered, still open) and scans only the new commits, instead of a full review. Replies are read and judged against the code. The comment opens with a re-review notice telling the author what was and wasn't reviewed, and the footer names the review it followed, so follow-ups chain.
- **Clear fallbacks:** after a rebase or force-push, an approval, a hand-written review or one without findings, it runs a full review and says why: in the terminal before any model runs, on the picker's Fixes pushed row, and to the author under the verdict.
- **`--full` and `f`:** force a full review from the command line or the picker.
- **Watch notifications read like a picker row:** the title is what happened (`⟳ #61 fixes pushed`), then the PR title, then who and how much (`by octo-dev · 2 new commits · acme/widget`). Merges name who merged and who opened the PR.
- **Watch notifications survive a blocked terminal-notifier:** when macOS refuses terminal-notifier, watch shows a plain osascript notification ending with "run reviewpr" instead of dropping it, and logs that it used the fallback.
- **`watch --install` tests notifications:** it sends a test notification and reports the mode: clickable, plain, or not working.
- **⚠️ recommends Comment only:** with Should fix as the worst finding, posting preselects Comment only, not Request changes. Only a Must fix recommends Request changes.
- **Work-item scope:** for a PR that only says "Related to" (or "Part of", "Refs") its work item, verify judges only the criteria the PR claims or changes behaviour for, and rejects the rest as outside its stated scope.
- **The PR's own docs count as stated:** behaviour that documentation added or changed by the PR describes as intended (a limitation, a failure mode, a recovery step) is rejected as already stated, like the PR body.
- **How a change was made isn't evidence:** a claim such as "edited by hand" is rejected unless the resulting content is wrong.
- **Tier A overflow is checked lightly:** tier A findings past the 6 rigorous slots take the 12 light slots first, ahead of tier B, instead of being left Unchecked. The total checked stays the same.
- **Must fix needs a likely case:** gaps seen only on misuse, already caught by another check the PR adds, in rare environments, in guards against mistakes, or in docs and PR-description fields are Should fix.
- **Questions don't assert:** verify no longer backs a Question with language or runtime internals it can't show in the repository, and rejects a Question the PR body already asks for.

## 0.9.0 (2026-11-23)

- **`reviewpr watch`:** macOS notifications for the events listed in `config.json` (`new`, `fixes-after-changes`, `reviewed-updated`, `merged-reviewed`, `merged`, `review-requested`, `my-pr-reviewed`, `my-pr-conflicts`, or `all`, the default). It polls with read-only `gh` calls and uses no model.
- **Background mode:** `watch --install` adds a launchd agent that runs `watch --once` every `intervalMinutes`; `--uninstall` removes it.
- **Picker rows:** the age is a column right after the PR number (`● #68  10m  octo-dev  feat: …`), and details follow the titles instead of the terminal's right edge. Rows are at most 100 columns wide. Within a group, rows are sorted by that age, youngest first.
- **Terminal mode:** `watch` keeps the picker open and refreshes it in place. Enter reviews in the same terminal and returns to the list, and `r` checks immediately. Merges and events on your own PRs show on a status line.

## 0.8.1 (2026-11-23)

- **Your PRs in the picker:** your own open PRs, drafts included, are listed under ◆ Your PRs for a self-review, labelled with other people's reviews and merge conflicts.
- **Self-review verdict:** posting on your own PR (comment only) keeps the verdict as a recommendation, marked `Self-review:`, instead of rewriting it to "Not approved yet".

## 0.8.0 (2026-11-23)

- **Weakened protections:** a trade-off the PR states that removes or weakens a protection (code-owner review, access control, a merge or release gate) is no longer rejected as already stated. Verify asks whether the owners have agreed.
- **One change, one finding:** findings about the same change at the same location are merged, even when reviews frame them differently (a risk, a scope gap).

## 0.7.0 (2026-11-23)

- **New since you looked:** ● New and ↑ Updated mean opened or updated since you last opened the picker for that repository (24 hours on a first visit). The header shows `last looked 2d ago`.
- **Age colours:** the label is green under a day, yellow from a week and red from two weeks. Stale PRs are no longer dimmed, so they stand out. Group headings take their state's colour.
- **Approved, new commits** is its own group below Updated.

## 0.6.0 (2026-11-23)

- **Referenced PRs:** preparation records the PR's draft state and the current state of up to 5 PRs or issues its body names (open, closed, merged when), with read-only `gh api` calls.
- **Conditions in the PR body:** "stays a draft until #163 merges" counts as already stated only while #163 is unmerged. Once it has merged, a finding about the promised step is judged on its own.
- **Rules in documents:** for a finding about a rule in a document or config file, verify reads the whole section and the rules around it that could override it before confirming.
- **Self-check:** before confirming, verify reads its own evidence against the finding. A finding whose evidence shows the case is already prevented is Rejected; a misleading example on its own is at most Minor.

## 0.5.0 (2026-11-23)

- **PR picker states:** each PR shows an icon, a colour and a label, grouped most urgent first: ⟳ Fixes pushed ("3 new commits · 2h"), ★ Asked for you, ● New (opened in 24 h), ↑ Updated (24 h, or approved with new commits), then Waiting, with ◌ for 14+ days idle. Colour is never the only signal.
- **Skip:** `s` hides a PR until its author pushes a new commit, and `a` shows skipped PRs. Skips are kept locally in the git-ignored `state/picker.json`.
- **Re-requested reviews** are listed even when you reviewed the current head.
- **Query limit:** new commits are counted with one compare call per PR that changed since your review. Asking `gh pr list` for all PRs' commits exceeded GitHub's GraphQL node limit.

## 0.4.1 (2026-11-23)

- **Details summary:** the `<details>` summary is counted in code from verify's findings, including Should fix items and Questions folded there when the visible slots are full ("1 question and 5 minor items"), so it always matches the verdict line.

## 0.4.0 (2026-11-23)

- **Empty groups:** a digest group that only says `None.` (for example `### Must fix` with nothing under it) is removed from the comment.
- **Traced examples:** verify walks a finding's claimed input through each function before confirming it, and corrects or rejects examples that don't hold.
- **Already stated in the PR:** a gap, limitation or deferral the PR body already states is rejected, and so is a question asking for proof of a check the PR says it ran (the same check only). Verify quotes the PR when it does this.
- **Verdict line:** minor items are counted only in the `<details>` summary, so the two numbers can't disagree; with only minor items it says "Only minor items." Approving over open items posts "✅ Ship. 1 should-fix, 1 question, none blocking." without an edit.
- **More minor findings checked:** tier B holds up to 12 findings instead of 8.

## 0.3.0 (2026-11-22)

- **Digest cleanup:** notes the model writes about itself (saving files, the sandbox, posting) are removed from the comment, with a warning saying what was cut.
- **Run from anywhere:** the CLI now starts when run through a symlink, such as `~/.local/bin/reviewpr`; before, it exited without doing anything. The README shows how to set it up.
- **Bypass rule:** a deliberate way past a new check is a Must fix only when the check is a protection (access, untrusted input, private data, merge or deploy gates). A new way around a best-effort heuristic is Should fix at most, and Minor when its limits are already documented.

## 0.2.0 (2026-11-22)

- **Live timer:** running steps show a timer that ticks every second.
- **Live usage:** model steps show tokens and AI credits growing live, read from Copilot's session log at no extra cost.
- **Summary table:** a million tokens or more show as `1.6M`.
- **Node version:** the CLI restarts itself on the `.nvmrc` Node when started with an older one, for this project only.

## 0.1.0 (2026-11-22)

First versioned release.

- **Pipeline:** two reviewers (`ponytail-review`, `code-review`), then verify in two sessions (list and tier, then one focused check), then the digest.
- **Verdict:** the verdict line and the recommended review type are decided in code from verify's priorities: 🔴 Fix before merge, ⚠️ Changes recommended, ✅ Ship.
- **Posting:** keep local by default, or post one review after two explicit terminal choices. The choice overrides a contradicting verdict line.
- **PR picker:** run without a URL to pick an open PR from `defaultRepository` that still needs your review.
- **Clickable links:** `path:line` references become GitHub links, into Files changed when the line is in the diff.
- **Cost display:** tokens and AI credits per step and per run.
- **Terminal output:** listr2 in a terminal, plain `[progress]` lines otherwise. Colours come from picocolors and spinner frames from cli-spinners.
- **Packaging:** `package.json` with exact-pinned dependencies and a lockfile; Node 26 via `.nvmrc`.
