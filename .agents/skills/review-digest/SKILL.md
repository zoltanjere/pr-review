---
name: review-digest
description: >
  Turn a long verified code review into one short PR comment people will read:
  at most 5 important findings, minor items folded away. The pipeline adds
  the verdict line.
  Use for /review-digest.
---

Write the one comment a busy author reads before merging. Keep only what
changes their decision. Everything else is either folded away or dropped. The
full verified review still exists, so you don't need to repeat it.

The input marks each finding **Confirmed**, **Question** or **Rejected**
after someone checked it against the code, and gives each Confirmed finding a
**Priority**: Must fix, Should fix or Minor. That priority is final. Use it
as given; never move a finding to another group. Never show a Rejected or
Unchecked finding.

## Budget

- At most **250 words** before `<details>`.
- At most **5 numbered findings** visible, but every Must fix is shown even if
  that means more than 5.
- At most **8 lines** inside `<details>`, one line each.

## Placement

1. **Must fix** 🔴: every Must fix finding. Always visible.
2. **Should fix** 🟡: Should fix findings in the given order, until the
   5-finding cap. Any that don't fit go into `<details>`.
3. **Questions** ❓: Question findings, only while a visible slot is left.
   Otherwise fold them into `<details>`.
4. **Minor**: Minor findings, one line each, inside `<details>`. Merge
   related items into one line.

Leave out praise, "confirmed OK" lists and review-process limitations. Don't
summarise what the PR does: its author wrote it and its description says it. Never
mention reviewers, tools, severity ratings from a reviewer, or what was or
wasn't checked: the author reads findings, not how they were found. Merge
two findings into one entry only when they share one fix.

## Format

Start directly with the first non-empty group. Don't write a verdict line:
the pipeline adds it from the priorities. Use exactly this shape and skip
empty groups:

```
### Must fix
1. 🔴 **<Short title>**
   `<file>` · `<symbol or line>`
   <Scenario → impact, one sentence.> Fix: <concrete fix.>

### Should fix
2. 🟡 **<Short title>**
   ...

### Questions
3. ❓ <The question, with the fact that raised it.>

<details><summary><N> minor items</summary>

- <one line: location, problem, fix>
</details>
```

Rules for each finding:
- The title says what goes wrong, not which file is touched.
- Write exact file, function and variable names in backticks.
- Give two lines of body at most: the case that breaks, then `Fix:`. A
  security finding may take four lines so it can be understood.
- Number findings across all groups so people can say "fix 1 and 3".
- Don't hedge ("might", "consider", "it seems"). If unsure, make it a ❓.
- Don't restate the diff, don't invent findings, and don't claim checks were
  done when they weren't.

## Example

```
### Must fix
1. 🔴 **Retry resends a chunk the server already stored**
   `upload.ts` · `sendChunk`
   A timeout after the server wrote chunk 3 retries the POST, and the file is
   assembled with chunk 3 twice. Fix: send the `Upload-Offset` header and skip
   chunks below the offset the server reports.

### Should fix
2. 🟡 **Backoff has no upper bound**
   `retry.ts:18` · `delayFor`
   After 10 attempts the delay passes 17 minutes, while the spec caps a retry
   at 30 s. Fix: clamp to `maxDelayMs` and add a test at attempt 10.
3. 🟡 **Resume ignores a changed file**
   `resume.ts` · `loadSession`
   A file edited between sessions resumes at the old offset and uploads a
   mix of both versions. Fix: store the file's size and mtime and restart when
   they differ.

### Questions
4. ❓ The spec says uploads over 5 GB are refused, but `MAX_SIZE` is 50 GB.
   Which one is right?

<details><summary>3 minor items</summary>

- `progress.ts:9`: the callback reports bytes sent, not bytes confirmed; rename it `onBytesSent` or report confirmed bytes.
- `upload.ts:4`: `MAX_ATTEMPTS` is exported but unused; remove it.
- The PR body doesn't mention the new `UPLOAD_CHUNK_MB` setting; document it.
</details>
```

Nothing worth raising: output exactly `Nothing to raise.`

Output only the comment body, with no preamble.
