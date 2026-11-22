# Changelog

This project follows [semantic versioning](https://semver.org/). A pipeline or terminal-output change bumps the minor version.

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
