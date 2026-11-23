# Changelog

This project follows [semantic versioning](https://semver.org/). A pipeline or terminal-output change bumps the minor version.

## 0.6.0 (2026-11-23)

- **Referenced PRs:** preparation records the PR's draft state and the current state of up to 5 PRs or issues its body names (open, closed, merged when), with read-only `gh api` calls.
- **Conditions in the PR body:** "stays a draft until #163 merges" counts as already stated only while #163 is unmerged. Once it has merged, a finding about the promised step is judged on its own.
- **Rules in documents:** for a finding about a rule in a document or config file, verify reads the whole section and the rules around it that could override it before confirming.

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
