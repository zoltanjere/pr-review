# Decisions

These are the decisions currently in force, with the reason for each. Read this before changing the pipeline, so settled questions are not reopened. When a decision changes, edit its entry in place. This is not a changelog.

Each entry has three parts:
- **Decision:** what we do.
- **Why:** the reason or evidence.
- **Don't:** something tried or considered and ruled out, where there is one.

---

## 1. Scope and shape

### 1.1 Local by default; posting is an explicit, two-step choice
- **Decision:**
  - The tool reads a PR and writes Markdown files under `reviews/`. It never writes to git remotes and never changes an existing checkout.
  - The only write to GitHub is one `gh pr review`, sent after the person picks **Post** and then a review type in the terminal. Keeping it local is the default.
  - Runs without a terminal, or with `--yes`, never post.
- **Why:** These are real company repositories, and a review posted under someone's name, especially an Approve, is their decision. Two explicit choices make an accidental post unlikely.
- **Don't:** Add a flag that posts without the interactive choice, or post more than one review per run.

### 1.2 Node CLI orchestrating separate Copilot CLI processes
- **Decision:** `src/review.mjs` starts one `copilot` process per stage and per reviewer, and checks each process's JSONL events. There are no npm dependencies.
- **Why:** The script controls parallelism, timeouts, retries and failure handling directly. Asking one Copilot session to coordinate nested agents hides failures and skipped steps.

### 1.3 Pipeline: 2 reviewers → verify (2 sessions) → digest
- **Decision:** Two reviewers run in parallel. Verify follows in two sessions (list, then check), then one digest agent. That's about 5 Copilot sessions per PR.
- **Why:**
  - This review is a cheap second opinion next to GitHub Copilot's own PR review, so it goes for good value per token rather than maximum coverage (see 9).
  - Separate reviewers bring separate lenses.
  - Verify removes false positives, which are what make people ignore bot reviews.
  - The digest makes the result short enough to read.
- **Don't:**
  - Bring back a "merge" stage that only rewrites the reviews. Nothing checked findings against the code, so false positives reached the comment.
  - Bring back `caveman-review` as the summariser. It compressed the words, not the content, so it stayed too long.
  - Add reviewers or validation passes without measuring their cost per finding gained first.

## 2. Reviewers

### 2.1 Use upstream skills unmodified
- **Decision:** The reviewers are `ponytail-review` (dietrichgebert/ponytail) and `code-review` (mattpocock/skills). They are installed with `npx skills` at project scope, pinned in `skills-lock.json`, and updated only on purpose.
- **Why:** About 18 review skills on skills.sh were compared:
  - `code-review` is the only established reviewer that checks the PR against its spec or intent.
  - `ponytail-review` is the best general correctness reviewer.
- **Don't:**
  - Write our own reviewer skill.
  - Swap in `warpdotdev/review-pr`, the `obra` code-reviewer or `addyosmani` code-review-and-quality. They overlap with ponytail.
  - Use `multi-agent-review` (it reviews specs, not code) or `thermo-nuclear` (Cursor only).

### 2.2 security-review dropped
- **Decision:** `getsentry/skills` `security-review` was removed.
- **Why:** In every evaluation round it produced no unique confirmed finding. It cost about 1 premium request and 110k tokens per PR. Copilot's own review and ponytail's safety lens cover the common cases. This was the user's decision.
- **Don't:** Bring it back without evidence that it finds what the other two miss.

### 2.2a Reviewer focus line
- **Decision:** The shared review prompt adds one sentence: also check failure paths (errors and fallbacks that pass silently), limits and boundary values, text encoding, and framework constraints. The upstream skills stay unmodified.
- **Why:** The bug-catching test (8.1b) found that the missed bugs were mostly of these classes. A sentence costs nothing, while another reviewer would cost a session.

### 2.3 code-review must use subagents; strong wording up front, one retry
- **Decision:**
  - The first `code-review` prompt says to launch each axis with the `task` tool in foreground, "however small the diff".
  - The code accepts the response only if it has `## Standards` and `## Spec` headings and enough completed foreground `task` calls: 1, or 2 when a spec exists. Any subagent name counts.
  - A shortfall gets one retry, with a note.
- **Why:**
  - The skill's design isolates each axis in its own subagent, and the user wants that kept.
  - Skipping it was caused by weak first-prompt wording, while the retry wording was strong. Putting the strong wording first brought the retries to 0.
- **Don't:**
  - Remove the subagent requirement.
  - Require particular subagent names.
  - Add more retries.

### 2.4 Specs are pre-fetched, not queried by agents
- **Decision:** `prepare()` fetches these into `pr-context.json`:
  - the linked GitHub issues (`closingIssuesReferences`, via `gh issue view`)
  - the Azure Boards work items referenced as `AB#<id>` in the title, body or commits (via `az boards work-item show`)
  - the PR's own `isDraft`, and the current state of up to 5 other PRs or issues the title or body names (`#163`, `owner/repo#163` or a github.com URL), via one read-only `gh api repos/<owner>/<repo>/issues/<n>` call each: open or closed, merged when, draft. A bare `#N` after an explicit `owner/repo#N` with the same number is read as shorthand for it. Owner or repo names made only of dots are ignored, so a crafted PR body can't turn the lookup into another API path. A failed lookup is recorded with its error.

  Reviewers get an "Issue tracker" note saying these are already fetched. A failed work-item fetch is recorded with its error, and the run continues.
- **Why:** Copilot shell rules match only the first subcommand. Allowing `gh issue` would also allow `gh issue create`, and the same goes for `az boards`. Pre-fetching keeps agents read-only.
- **Don't:**
  - Give agents `gh` or `az` shell access.
  - Install `setup-matt-pocock-skills`. It is interactive, it writes `CLAUDE.md`, `AGENTS.md` and `docs/agents/*` into the reviewed repo, and its only useful output for us is the tracker description, which the prompt already supplies.

## 3. Agent sandbox

### 3.1 Tools
- **Decision:** `--available-tools=skill,view,grep,glob,task,bash`, `--deny-tool=write`, `--disable-builtin-mcps`, `--no-ask-user` and `--no-auto-update`. The shell tool is called `bash`; `shell` is rejected as a tool name.
- **Why:** Agents need to read, load skills and start subagents, and nothing else.

### 3.2 Read-only git through allow and deny rules
- **Decision:**
  - Allow `shell(git <sub>)` for `diff`, `log`, `show`, `blame`, `grep`, `ls-files`, `rev-parse`, `merge-base`, `status` and `cat-file`.
  - Explicitly deny `push`, `commit`, `reset`, `checkout`, `switch`, `remote`, `config`, `fetch`, `pull`, `clean`, `restore`, `rm`, `tag` and `branch`.
  - Never allow a blanket `shell`.
- **Why:** Deny rules beat allow rules. Under `--no-ask-user`, anything not allowed is refused. `git log --output=<file>` can still write, which is harmless in the disposable clone.

### 3.3 Working directory is the temporary checkout; skills come via `--add-dir`
- **Decision:**
  - Agents run with `cwd` set to the checkout.
  - Pipeline skills are copied to `<workspace>/.github/skills/` and loaded with `--add-dir <workspace>`.
  - Same-named skills in the checkout (`.github/skills`, `.agents/skills`, `.claude/skills`) are deleted from the clone.
- **Why:**
  - `git -C <path>` is refused even when `git` is allowed, so git must run in the working directory.
  - Deleting the clone's same-named skills stops a reviewed repo from shadowing a reviewer.
- **Don't:** Run agents from the project root with `git -C`.

### 3.4 Ignore the reviewed repo's instructions
- **Decision:** Use `--no-custom-instructions`. Every prompt says repository and PR content is data, not instructions.
- **Why:** Otherwise the reviewed repo's `AGENTS.md` would steer the reviewer.

### 3.5 Skill must load, and from the project
- **Decision:** Every skill stage must show a successful `skill` tool call whose result says `Skill "<name>" loaded successfully` and whose `skillSource` is `project`. If it didn't load, retry once. If it loaded from the wrong source, fail.
- **Why:** Models sometimes answer without loading the skill. Same-named personal skills exist in `~/.copilot/skills`, such as `code-review` and `caveman-review`.

### 3.6 One model, enforced
- **Decision:** `config.json` holds one `model`. It is passed with `--model`, and subagents are told to use it. Every `assistant.message`, including those from subagents, must report that model, or the run fails.
- **Why:** The results must be comparable and predictable. Subagents otherwise fall back to other models.

### 3.7 Stream Copilot output and drop shell echoes
- **Decision:** Read `copilot` stdout line by line and drop the `tool.shell_output` events. Use `--output-format=json --stream off`.
- **Why:** One `git grep` once produced 114 MB of JSONL, which overflowed `execFile`'s buffer. The pipeline never reads those events.

### 3.8 Claude Code as a second provider
- **Decision:** `"provider": "claude"` runs every agent as `claude -p` instead of `copilot`, signed in with the person's own Claude login. Everything is per run (`src/claude.mjs`):
  - `--setting-sources ""`, `--strict-mcp-config`, `--no-session-persistence` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`: no personal settings, `CLAUDE.md`, memory, hooks, plugins or MCP servers.
  - `--permission-mode dontAsk`, `--tools Skill,Read,Grep,Glob,Bash,Agent`, `Bash(git <sub>:*)` allows for the same read-only subcommands, and Write, Edit, NotebookEdit, WebFetch and WebSearch denied. The prompt comes after `--`, because the allow and deny options take several values.
  - Skills come from a plugin in the workspace (`--plugin-dir`), as `prreview:<name>`. The prompt asks for the Skill tool; the check is a `Skill` call for `prreview:<name>` whose result says `Launching skill: prreview:<name>`.
  - The same model check (every message, subagents included), the same code-review subagent count (foreground `Agent` calls) and the same retries.
  - Models are kept per provider (`claude.model`, `claude.checkModel`). Subagents are told the family alias (`sonnet`), which the Agent tool takes.
  - The checkout's folder in `~/.claude/projects` is removed after each step.
  - Usage is tokens only.
- **Why:**
  - **It uses the Claude plan the person already has.** Copilot's bring-your-own-key mode needs a paid API key, and the Agent SDK is meant for API keys.
  - **`--bare` is ruled out:** it accepts only an API key, not a claude.ai login.
  - **Skills through `--add-dir` don't load** once setting sources are off, and the plugin prefix keeps Claude Code's built-in `code-review` from answering instead.
  - **A slash-command prompt (`/prreview:<name>`) loads the skill without any event,** so nothing could prove it loaded.
  - **Claude Code allows read-only commands in the working directory by itself** (`git status`, pipes to `head`). That is still read-only. Reads outside the checkout and workspace, `git -C` and writes are refused, which a spike confirmed.
  - **Even with session persistence off, it writes subagent notes** per working directory. The checkout is disposable, so that folder is ours to remove.
  - **The reported `costUSD` is an API list price,** not what a plan charges, so it isn't shown.
- **Don't:** Change `~/.claude` or `~/.copilot` to make a provider work. The choice must stay inside this project.

### 3.9 Setup problems are named before any work
- **Decision:** `prepare` first runs `<provider> --version`, and `claude auth status` for Claude Code, before cloning (`src/setup.mjs`). Any failed `gh`, `git`, `copilot` or `claude` call that's a missing program (ENOENT) or a sign-in error starts its message with one line: what's missing and the command that fixes it (`gh auth login`, `copilot login`, `claude auth login`). The raw error follows. For a provider, the line also points to `reviewpr settings`.
- **Why:** On a new machine, `spawn claude ENOENT` after a minute of cloning says neither what's wrong nor what to do. `claude auth status` is local and uses no tokens. Copilot has no such status command, so its sign-in error gets the hint when the first agent runs.
- **Don't:** Check sign-in by starting a model session: that costs a request every run.

## 4. Verify

### 4.0 Two sessions: list and tier, then one focused check
- **Decision:**
  - **Session 1** reads only the reviews. It returns every distinct finding as JSON, merges duplicates, and gives each a tier:
    - **A**, could block;
    - **B**, minor but concrete;
    - **C**, pure style.
  - **Session 2** checks tier A (at most 6, opened in code and cited) and tier B (at most 12, judged from the diff) in one go. Tier B was 8 until valid minors (unannounced scope changes, stale docs) kept landing in Unchecked while the slots went to findings that were then rejected; judged from the diff, four more cost little. It returns a JSON array of verdicts in order.
    - It gets only the diff sections of the cited files (`diffForFiles`), not the whole PR diff.
    - Optionally it runs on `checkModel`.
  - Tier C is recorded as Rejected (style only) without a check. A finding that names a situation in which something goes wrong is never tier C, because the listing step once filed concrete failure cases (a failed push, a bad env value) as style. Tier A findings over its limit take the light-check slots first, ahead of tier B, so the total stays at 18. A security finding was once left Unchecked while two light slots went unused. Findings over the light limit are recorded as **Unchecked**, which the digest never shows.
  - The script validates the array (length, status and priority values, evidence present), retries once, and writes `verified.md` itself.
- **Why:**
  - **One agent per finding was too expensive.** About 13 sessions at ~79k tokens each, roughly 1M tokens and 13 premium requests per PR. Each session re-read the full diff, and most checked findings ended up Rejected.
  - **One agent for everything cut corners** (4 of 12 findings "not opened", 2 dropped), because it read all the reviews and checked every finding against the full diff.
  - **The split keeps what worked.** Listing happens in a separate session, rigorous checks are capped, minors get a light check, style never reaches a check, and the input is only the relevant diff. Target: verify ≤ 200k tokens.
- **Don't:**
  - Go back to one session per finding.
  - Raise the tier limits without measuring the cost.
  - Add a check that greps verify output for "did not open".

### 4.0a Judge the code, not just the claim
- **Decision:** When a tier A claim is wrong as stated but the code it points at has a related real defect, verify confirms that defect and rewrites the finding.
- **Why:** In the bug-catching test, verify quoted a buggy line (`>= max_commits`) as evidence and still rejected the reviewer's differently-worded claim.

### 4.1 Verify is the single authority on status and priority
- **Decision:**
  - Each finding check gets the diff and `pr-context.json`, which holds the spec.
  - Each distinct finding becomes **Confirmed**, **Question** or **Rejected**.
  - Each Confirmed finding gets exactly one priority: **Must fix**, **Should fix** or **Minor**, using the rubric in `checkFindingPrompt`.
  - Later stages use that priority as given.
- **Why:** Before this, priority was decided twice in different vocabularies: verify by "kind", the digest by its own triage. That produced verdicts that contradicted their own groups. Verify also lacked the spec, so it could not judge requirement findings.
- **Don't:**
  - Let the digest re-rank findings.
  - Add a code check that the verdict matches the groups. That would be a workaround; the cause was the double triage.

### 4.2 Status definitions
- **Decision:**
  - **Rejected:** the claim is false, or it is pure taste with no concrete effect. A true finding with small impact is Confirmed and Minor. Being outside the spec is not a reason to reject.
  - **Question:** the code cannot settle it. Not looking is not a reason to make it a Question.
  - **Minor bar:** a Minor is something a careful senior reviewer would still comment on and the author would act on: a misleading message or name, duplication or dead code the PR adds, a missing test for new logic, or unmentioned scope. True findings below that bar are Rejected with "below the Minor bar". That covers cosmetics, display-only polish, inputs only tests set, failure modes that predate the PR or follow a repo-wide pattern, and feature or hardening requests beyond the PR.
- **Why:** An earlier, looser definition rejected true but small findings, which lost useful minor items. With no bar at all, a small PR got 8 minor items, about half of them not worth a comment. The bar names concrete categories, so "small" alone is never a reason to reject.

### 4.2a A deliberate bypass is a Must fix, when the check is a protection
- **Decision:** In the check rubric, a way for someone to deliberately get past a check the PR adds counts as a security hole, so it's a Must fix, when that check is a protection: access control, validation of untrusted input, a filter for private or harmful data, or a gate that decides a merge, release or deploy. An accidental, rare fail-open stays Should fix. A new way around a best-effort heuristic (a text scorer, a lint, a detector, an evaluation metric) is Should fix at most, and Minor when the code or its docs already say it can be fooled the same way.
- **Why:** A finding that let added lines slip past a new content scanner was rated Should fix, although the scanner's whole purpose is to catch such content. The rule then over-fired the other way: on a heuristic report scorer whose docstring already said invented reproductions pass, one more way to fool it was rated Must fix and blocked a PR whose earlier findings were all fixed.

### 4.2b Claimed examples are traced; severity is not lowered by likelihood
- **Decision:** When a finding claims a specific input gives a specific result, verify walks that exact input through each function, citing `file:line` per step. It confirms only if every step agrees; otherwise it corrects the example, rejects the finding, or makes it a Question. For a rule in a document or configuration file (instructions, a skill, a policy), it reads the whole section and the other rules in that file that could override or cover the cited one, and cites the line that settles it. Before confirming, it reads its own evidence against the finding: if the evidence shows a condition that already prevents the stated case, the finding is Rejected, and a misleading example on its own is at most Minor. A true problem with a concrete case stays Should fix even when the case is unusual or only lowers a result; whether it blocks is the person's decision when posting (see 5.2).
- **Why:**
  - **Tracing:** a confirmed example was false, because a split at `;` in an earlier function put the two words in different sentences. In a skill file, a finding that a fix round could go "narrow" was confirmed from line 14, while line 24, ten lines below, says a fix round always makes the next pass full. In a later run, verify confirmed "coverage is carried forward after a test is deleted" while its own evidence said the rule's condition ("whose code and tests did not change") already excludes that case. Verify can't run the code (the sandbox forbids it on purpose), so it has to trace instead.
  - **No likelihood rule:** a rule that made unusual inputs, unmeasured performance costs and fail-closed failures Minor was tried and removed. It hid true Should fixes from the author, and mixed up how important a finding is with whether it blocks.

### 4.2c What the PR already says is not a finding
- **Decision:** Verify rejects a finding as "already stated in the PR" when the PR body already says what it describes: a gap, limitation or deferral (such as a requirement named as a follow-up), or a check the PR says was run when the finding only asks for proof of that same check (same tool or command). Verify quotes the PR's words. The exception is when the merged code does something wrong because of the gap, or the code gives a concrete reason to doubt the stated check. Verify reads the PR context for this, not only for requirement findings.
  - **Conditions:** a statement tied to a condition ("stays a draft until #163 merges", "after X lands") counts as stated only while the condition is unmet. Verify checks `isDraft` and `references` in the context; once the condition is met, the promised step is due and the finding is judged on its own.
  - **Partly stated:** when the PR states only part of what a finding describes, only the rest is confirmed: the title, finding and fix are rewritten to cover the unstated part alone, and the fix never undoes the stated behaviour.
  - **Unclear documents:** a finding that a sentence is unclear or contradictory must quote the whole sentence and say how the two readings differ. If the sentence already says what happens in the case raised, or the fix restates it, the finding is rejected.
  - **Weakened protections:** a stated trade-off that removes or weakens a protection (required or code-owner review, access control, a merge, release or deploy gate) is not rejected. It becomes a Question asking whether the owners of that protection agreed, quoting the PR.
- **Why:**
  - A PR listed three acceptance criteria as follow-ups. Verify noted the gap was "real but disclosed" and still rated it Should fix, so the comment repeated the author's own words back to them.
  - "Same check" matters: in one run, the PR saying one validation command exited 0 was wrongly taken as an answer to whether a different tool accepted the file.
  - Conditions matter: a PR said it "stays a draft until" another PR merged, and that a pinned version would then move. The other PR had merged and this one was out of draft, but the pin hadn't moved. Verify rejected the finding as already stated, because it couldn't see either state.
  - Disclosure is not consent: a PR disclosed that its exemption also removed code-owner review for every other PR touching those files. Verify rejected it as already stated, so the digest never raised the biggest risk in the PR, one that only the code owners can accept.

### 4.3 Own evidence only
- **Decision:** Verify must base every decision on code or files it opened, and cite `file:line`. Another review's claim is not evidence.
- **Why:** Verify was observed citing a reviewer's claim as proof.

### 4.4 The verified review is the full record
- **Decision:** `<HHMM>-verified.md` keeps every finding, Rejected ones too, with their reasons, so the result can be audited. Review-process limitations, such as tools that were unavailable, are left out.

## 5. Digest

### 5.1 Own skill, fixed budget
- **Decision:**
  - `review-digest` is a project skill.
  - Budget: 250 words before `<details>`, at most 5 visible numbered findings (every Must fix is always shown), and at most 8 one-line minor items in `<details>`.
  - Must fix 🔴 → Should fix 🟡 → Questions ❓ → Minor folded away. Rejected findings are never shown.
- **Why:**
  - The comment is pasted into a GitHub PR, and people stop reading long bot comments.
  - The target of about 250 visible words came from the user.
  - Folding with `<details>` follows the CodeRabbit pattern.
  - Research supports one verdict first and few findings: Google eng-practices, Conventional Comments, and studies on AI review noise.

### 5.1a No process talk in the comment
- **Decision:** The digest never mentions reviewers, tools, a reviewer's severity rating, or what was or wasn't checked.
- **Why:** A digest once said "The security reviewer rated this Low" and "(not checked in code)". The author reads findings, not how they were found. The full record keeps that detail.

### 5.1b No summary of the PR
- **Decision:** The digest goes straight from the verdict to the findings. It never restates what the PR does.
- **Why:** The author wrote the PR, and its description already says what it does. A summary line spends the reader's attention on nothing new.

### 5.1c The reply is the comment; anything else is cut in code
- **Decision:** The digest prompt says the reply is the comment body and nothing else. In code, `digestBody` keeps only the skill's format (group headings, numbered findings with their indented lines, fenced code, the `<details>` block, the verdict or `Nothing to raise.` line) and removes every other paragraph, with a warning naming what was cut. A group whose only content is a placeholder (`None.`, `n/a`, `-`) is dropped too, since the skill says to skip empty groups.
- **Why:** A digest once opened with "I couldn't save a file: the sandbox blocks bash writes…" and ended with "Nothing was posted. No subagents were spawned." Posted as is, those lines would have reached the PR. A prompt rule alone doesn't reliably stop this, and the format is strict enough to check in code.

### 5.2 Verdict and recommendation are decided in code from verify's priorities
- **Decision:** `src/verdict.mjs` owns the verdict line. The digest skill writes only the body; the code prepends the line and removes any verdict the model writes anyway.

  | Confirmed findings | Verdict | Recommended review |
  |---|---|---|
  | any Must fix | 🔴 Fix before merge | Request changes |
  | any Should fix | ⚠️ Changes recommended | Comment only |
  | only Questions, Minor or none | ✅ Ship (with questions: "2 questions, none blocking.") | Approve |

  The counts on the line ("4 should-fix, 1 question.") are computed in code too. Minor items are counted only in the `<details>` summary, so the two numbers can't disagree when the digest merges related minor lines; with only minor items the line says "Only minor items." The `<details>` summary is counted in code too: every Minor, plus the Should fix items and Questions that didn't fit the five visible slots (verify's count minus the numbered 🟡 and ❓ entries shown), for example "1 question and 5 minor items". A run once said "2 questions" in the verdict but showed one, because the model's summary counted the folded question as a minor item. When the person approves over open should-fix items, the line becomes "✅ Ship. 1 should-fix, 1 question, none blocking." so the posted comment matches the decision without an edit; choosing Comment only or Request changes drops "none blocking".
- **Why:**
  - An earlier rule, "✅ Ship unless there is a Must fix", produced "✅ Ship" above four Should fix items and recommended Approve. The person had to override it by hand.
  - With the line written by the model there were two sources of truth; now there is one.
  - Open Questions alone recommend Approve, and the line says they don't block (user decision, 2026-11-24, replacing the morning's "an open question isn't an approval"). A Question is something unclear, not a problem found: it isn't a Must or Should fix. The author sees the questions in the approved comment and answers them, and a question that turns up a real problem stops the merge there. Holding the approval back for them cost a round trip on PRs that were otherwise done: a follow-up whose fixes were all made, with two questions waiting on the code owners, recommended Comment only.
  - The follow-up already reads the replies since the last review: a Question counts as resolved when a reply answers it, so an answered question isn't asked again. A reply that only says the question is still waiting isn't an answer.
  - Should fix doesn't block a merge, so ⚠️ recommends Comment only. A Haiku run once gave Should fix to a test nit and recommended Request changes on a correct PR. A priority one level too high should cost a comment, not a blocked PR (user decision).
- **Don't:**
  - Let the skill write the verdict again.
  - Bring back 🛑 **Blocked** or any other judgment-based tier.

### 5.2a The person's choice wins
- **Decision:** The recommendation follows the digest's current verdict line, so an edited line changes it. When the person picks a review type that contradicts the verdict line, the line is rewritten before posting and the saved digest is updated:
  - Approve gives ✅ Ship;
  - Request changes on ✅ gives ⚠️ Changes recommended;
  - Comment only on ✅ gives 💬 Not approved yet.
- **Why:** The posted comment must never say "Ship" on a review that requests changes, or the reverse.

### 5.2b File references are links, made in code
- **Decision:** After the digest is written, `src/links.mjs` turns each `` `path:line` ``, `` `path:a-b` `` or `` `path:a,b` `` reference into a Markdown link.
  - Paths are resolved against the PR's changed files first, then `git ls-files` of the checkout. A short path must match exactly one file, or it stays plain text.
  - If the line falls inside a hunk of the PR diff, the link is `…/pull/<n>/files#diff-<sha256(path)>R<line>`, which opens it in Files changed. Otherwise it's the permalink `…/blob/<head-sha>/<path>#L<line>`.
- **Why:** A plain `README.md:177` isn't clickable on GitHub. Doing it in code keeps links correct and costs no tokens. The model would guess paths and anchors, and permalinks at the head SHA never go stale. The diff link is preferred because a reviewer can reply right on the line (user choice: hybrid).
- **Don't:** Ask the digest skill to write links.

### 5.3 Budget enforced in code, one retry, then save with a warning
- **Decision:** `checkDigest` requires a leading `**Verdict:**` line and at most `DIGEST_WORD_LIMIT` (250) words before `<details>`. On failure there is one retry with the draft. If the retry still fails, it is saved with a warning instead of failing the run.
- **Why:** The skill alone overshot sometimes. The limit once sat at 300 while the skill promised 250, so the constant and the skill must always match.

### 5.4 Save everything, then keep local or post
- **Decision:**
  - All four files, the digest included, are saved when the run ends.
  - The terminal then shows verify's decisions and the digest preview, and offers **Keep it local** (the default, and what Enter does), **Post it as a review on the PR**, or **Edit the digest first**. An edit is saved to the digest file.
  - Choosing Post re-reads the PR's live state, then asks for the review type, with the recommendation marked "(recommended)" and preselected:
    - **Request changes** when verify confirmed a Must fix;
    - **Comment only** when the worst is a Should fix;
    - otherwise **Approve**.
  - Only **Comment only** is offered when the PR has commits newer than the reviewed head, since an Approve would cover unreviewed code, or when it's the person's own PR, which GitHub doesn't let them approve. Closed and merged PRs can't be posted to.
  - **Own PR:** the person isn't a reviewer there, so the code-decided verdict is kept as a recommendation and marked `**Verdict:** Self-review: ✅ Ship. …`. It is not rewritten to "Not approved yet" as it is for a comment on someone else's PR (`alignVerdict(…, { own: true })`).
  - The body is the digest plus a one-line footer: "Reviewed at `<sha>` with AI assistance. Each finding was checked against the code." It names the commit and is open about the AI help, without "automated" or the tool's name, since a person runs and posts it.
- **Why:** The digest's verdict already follows from Must fix (5.2), so the recommendation reuses it rather than judging again. The live-state checks stop an Approve on code nobody reviewed.

## 6. Retries and failures

### 6.1 One generic retry, only for model-fixable failures
- **Decision:** A check that the model can fix throws an error with a `retryNote`: a skill not loaded, code-review answered inline, or invalid verify JSON. A digest over budget gets its own single retry with the draft. `agent()` retries once, appending "A previous attempt …". Every other error fails right away.
- **Why:** These failures are intermittent model behaviour, and a second attempt with a pointed note fixes them. Unlimited retries would hide real problems.
- **Don't:** Answer a recurring retry with more retries. Find the cause in the prompt instead, as in 2.3.

### 6.2 Partial results are kept
- **Decision:**
  - When a reviewer fails, the reviews that succeeded are saved and the run stops before verify.
  - An empty review counts as a failure.
  - The temporary clone is removed even when the run fails.

### 6.3 Terminal output
- **Decision:** Progress goes through one reporter interface (`src/ui.mjs`) with two renderers. In a TTY, the live renderer prints finished lines once and keeps running stages, with a spinner and elapsed time, at the bottom. The plain renderer prints `[progress]` lines for logs, pipes and tests. Stages report structured events (PR context, finding count, each verdict) rather than preformatted text, so both renderers say the same thing. Full review texts are not dumped to the terminal; they are in the files.
- **Why:** The old output was a flat list of start and finish lines plus every review text, so the decisions were hard to see.

### 6.3a Steps render through listr2 in a terminal
- **Decision:** The pipeline and every wait are declared as steps (`src/steps.mjs`).
  - **In a terminal** (both stdout and stderr), they render with listr2. Concurrent reviewers each get a spinner, finished steps read `title · detail · time`, and verify verdicts show as lasting lines under their step.
  - **Everywhere else**, the same steps print the plain `[progress]` lines.
  - The adapters keep their reporter interface. A router sends their lines to whichever step is running.
  - The picker loading and the PR state check and posting are steps too, so the terminal never sits silent.
  - The PR picker, the decision screen and the menus stay our own code. They run only after listr2 has finished, so nothing else is reading stdin at the same time.
- **Live timer and usage:** a running step's title reads `title · what it's doing · live usage · elapsed`, redrawn every second.
  - The live usage comes from Copilot's session log (`~/.copilot/session-state/<id>/events.jsonl`): one `session.usage_record` per model call, with tokens (input plus output) and AI credits (`copilotUsage.totalNanoAiu`), read from that file as it grows.
  - On a real session these per-call records added up exactly to the final accounting.
  - The session id comes from the first streamed event.
  - Reading the file costs no tokens. When the step finishes, the final numbers from the shutdown accounting replace the live ones.
- **Why:** The user wanted feedback at every wait and a tidier, consistent look, built on a library made for this rather than our own redraw code. While a reviewer works for minutes, the ticking time and the growing cost show that it is alive.

### 6.4 What each step and the decision screen show
- **Decision:**
  - Every finished step shows what it produced and what it cost, separated by dots: `✔ code-review · 568 words · 405k tokens · 3.29 AI credits · 41s`. The figures come from the session accounting already collected, so showing them costs nothing.
  - On the decision screen, the cost table is printed right above "What next?", after the digest preview. In non-interactive runs it stays in the final summary.
  - All menus (the PR picker, What next?, and the review type) use the same arrow-key picker, with the default or recommended row preselected and `q`/`Esc` meaning "keep it local".
- **Why:** The table used to print before the long digest preview and scrolled off screen exactly when the person needed it. One picker for all menus means one set of keys to learn.

## 7. Inputs and outputs

### 7.1 Repository discovery and pinning
- **Decision:**
  - The reviewed repo must be cloned as a direct sibling of this project, in the parent directory.
  - Its `origin` must match the PR's owner and repo. If several match, the directory named after the repo wins.
  - `prepare()` clones it into a temp directory with `--no-hardlinks`, fetches the pinned base SHA and `refs/pull/<n>/head`, and checks that `FETCH_HEAD` equals the head SHA from `gh pr view`.
  - It checks out detached with hooks disabled.
- **Why:** The review uses existing credentials and clones and never touches them. Every stage sees the same commits.

### 7.2 Run naming and files
- **Decision:**
  - Output goes to `reviews/YYYY-MM-DD/<repo>-PR<n>/<HHMM>-<stage>.md`, with stages `ponytail-review`, `code-review`, `verified` and `digest`. `HHMM` is the run's local start time, the same moment as the date folder.
  - A second run in the same minute is `HHMMb`, then `HHMMc`, up to `z`. The name is reserved with a `.run-<id>.lock` file created with `wx`, so concurrent runs get distinct names.
  - Files are created with mode `0600` and never overwritten. Older `1-*.md` runs are left as they are and don't affect naming.
- **Why:**
  - A run's name says when it ran, which is what you look for (user choice over sequential numbers).
  - Reruns must keep history, and parallel runs must not collide.
  - The reviews may hold sensitive content.

### 7.3 PR picker: what is listed and why
- **Decision:** Without a URL, the tool lists the open PRs of `defaultRepository` from one `gh pr list --json number,title,author,isDraft,headRefOid,latestReviews,reviewRequests,createdAt,updatedAt,mergeable` call, and you pick one with the arrow keys (`src/select.mjs`).
  - **Listed:**
    - PRs with no review from you;
    - PRs whose latest review by you was dismissed on the commit it covered;
    - PRs whose latest review by you covered a commit other than the current head;
    - PRs where you were asked to review again, even if you reviewed the current head.

    Any review type counts. A dismissed review still counts as yours (`reviewState`): GitHub reports it only as DISMISSED, so the verdict line reviewpr posted says what it was (✅ an approval, 🔴 or ⚠️ a Request changes). A push that dismisses your approval therefore shows the PR under Approved, new commits, and watch notifies as after any review. A dismissed review without a verdict line is read like a review that isn't an approval.
  - **Hidden:** other people's drafts and bot PRs.
  - **States and order:** each PR gets one state, first match wins, shown with an icon, a colour and a label, and grouped under a heading in this order:
    1. **⟳ Fixes pushed:** your latest review was Request changes or Comment, and there are commits after it ("3 new commits", aged by the last one). The count comes from one `gh api repos/<repo>/compare/<reviewed>...<head>` call per changed PR, not from `gh pr list --json commits`: asking for every PR's commits exceeded GitHub's 500,000-node query limit on a real repository. If the count fails, the PR is still listed, as "new commits".
    2. **★ Asked for you:** you're in `reviewRequests`.
    3. **● New since you looked:** created after your last visit to the picker for this repository; on a first visit, in the last 24 h.
    4. **↑ Updated since you looked:** updated after your last visit (first visit: 24 h).
    5. **↑ Approved, new commits:** you approved and commits came in after ("approved · 2 new commits").
    6. **Waiting:** the rest, with **◌** for 14 days or more without an update (labelled `idle`, with the age in red).
    7. **◆ Your PRs:** your own open PRs, drafts included, listed for a self-review. Your own reviews on them are ignored, so they're never hidden or shown as "fixes pushed". The label counts other people's latest reviews, leaving out bots and Copilot, and adds `conflicts` when `mergeable` is `CONFLICTING` ("1 approval · conflicts", or "no reviews yet"). The header counts them separately ("6 to review, 1 yours").

    Within a group, rows are sorted by the age shown in the row, youngest first (1h, 3h, 5h), so the order always matches the age column; for New that is the opening time, for Fixes pushed the last new commit. A missing date counts as unknown, never as new, and sorts last.
  - **Row layout:** `icon #number age author title  label`.
    - The age column comes right after the number: the creation time for New, the update time for Updated, the last new commit for Fixes pushed. It's coloured by age: green under a day, plain up to a week, yellow from a week, red from 14 days.
    - Labels hold only what the heading doesn't say (`3 new commits`, `requested`, `idle`, `approved · 2 new commits`, your PR's reviews). They follow the longest title.
    - Rows are at most 100 columns wide.
  - **Colours:** the icon and the group heading take the state's colour. Only skipped rows are dimmed.
  - **Last looked:** `state/picker.json` records when you last opened the picker per repository, written when the list loads, so a cancelled pick still counts as a look.
  - **Skip:** `s` hides a PR until its head commit changes, and `a` shows skipped PRs. The skip list is `state/picker.json`, which is git-ignored and keyed by `owner/repo#number` with the head at skip time. Skips that have ended are pruned when the list is saved.
- **How the reviewed commit is found:** `gh pr list` leaves review commits empty. Our posted footer names the commit ("Reviewed at `<sha>`", or the older "pr-review at `<sha>`"), so it's read from there for free. Only reviews without that footer cost one `gh api …/pulls/<n>/reviews` call (`commit_id`). If no commit can be found, the PR is listed: showing too much is safer than hiding.
- **Why:**
  - The re-list rule uses new commits, not the branch protection's "dismiss stale approvals" setting. Reading protection rules needs admin rights, and new commits after a Request changes also deserve a second look (user decision).
  - Listing uses no model, so it's free.
  - **Own PRs are listed:** a self-review before asking others is useful, and drafts are when it's most useful.
  - **Colour is never the only signal:** the icon and label carry the state with `NO_COLOR` or in a pipe.
  - **Fixes pushed comes first:** a PR where you asked for changes and the author answered is the most likely to need you next.
  - **The age sits next to the number:** right-aligned to the terminal edge, the age ended up far from its title on a wide terminal and went unnoticed.
  - **Old PRs stand out instead of fading:** the first version dimmed stale rows, which hid exactly the PRs that had sat untouched. A red age label makes them visible.
  - **"Since you looked" beats a fixed window:** with a 24-hour window, a list checked after a weekend showed nothing as new, while a list checked twice an hour showed the same PRs as new both times.
  - **Skip is local and ends on its own:** it must never write to GitHub, and a new commit is exactly when a skipped PR deserves another look.
- **Don't:** Hide a PR because its reviewed commit is unknown.

- **No new changes since your review:** after your review, a head that moved only by a rebase (compare status `diverged`) or only by merge commits gets a second look: the PR's own changes then and now (`compare/<base>...<commit>` for each) are compared per file by added and removed lines, ignoring positions and context; files without a patch by blob SHA. The same changes give the `unchanged` state (`rebased only`, `merged main only`), ranked after Updated, and watch doesn't notify it.
  - **Why:** a rebase or a conflict-resolving merge before the author works on your points looked like Fixes pushed, and notified you for nothing. Skip worked around it by hand, but you only knew after looking, and the next rebase ended it.
  - **Undecided stays visible:** a failed call, GitHub's 300-file compare limit, or anything not comparable keeps the row in Fixes pushed. A conflict resolution that touched the PR's own lines differs, which is right.
  - **Cost:** two calls per such row, cached per PR, reviewed commit and head for the life of the process.

### 7.4 Watch: notify when a PR needs you
- **Decision:** `reviewpr watch` polls the default repository with the picker's own scan (`scanRepo`) and sends macOS notifications for the events listed in `config.json` (`watch.events`, see the README table; `all`, the default, means every event). It has two modes that share one poll (`pollOnce`):
  - `watch --once`, run by a launchd agent (`watch --install`) every `intervalMinutes` (default 5, minimum 2);
  - `watch`, the picker kept open: it refreshes in place, and Enter reviews in the same terminal and returns to the list (`reviewOne`).
  - **Events:** `watchEvents` is a pure function of the scan and the memory in `state/watch.json`.
    - **First check:** the first poll per repository only records.
    - **One per change:** each PR gives at most one notification per poll, naming every event that matched. A push is notified once per head (`notifiedHead`), and the same head is recorded even when the event is off or the PR is skipped, so turning an event on never replays old pushes.
    - **Merges:** a PR that leaves the open list is looked up with one `gh pr view` (`prOutcome`), only when a merge event is on. If the lookup fails, the PR is kept and looked up again on the next poll.
    - **Conflicts:** `mergeable: UNKNOWN` keeps the last known value, so only a real change to conflicting notifies.
    - **Skips:** skipped PRs don't notify about pushes or requests until their head changes, and the skip itself ends then.
  - **Notifier:** `terminal-notifier` with `-open <PR URL>` and `-group <repo#N>`; when it's missing or macOS refuses it (it's ad-hoc signed, so some Macs never offer an Allow prompt), `osascript`, which needs no setup but can't open a link, so its text ends with "run reviewpr". `--install` sends a test notification and reports the mode. A signed notifier of our own would need an Apple developer account and notarization per release, so it isn't worth it. Arguments are always passed as a list, never through a shell or AppleScript source.
  - **Lock:** the open app holds `state/watch.lock` (pid plus a heartbeat every minute). `--once` does nothing while the lock is live. A lock whose process is gone, or whose heartbeat is older than 15 minutes, is stale.
  - **Failures:** a failed check is logged to `state/watch.log` and retried on the next interval. In the app it shows on the status line, the last list stays, and the third failure in a row sends one notification. Only a failed first load stops the app.
- **Why:**
  - **Polling, not webhooks or Actions:** both of those need writes or admin rights on the repository being reviewed, and the tool only reads it. GitHub's notifications API doesn't reliably report new commits on a PR you reviewed, which is the main event.
  - **No model:** the picker already knows every state, so notifying costs nothing.
  - **Notifications never act:** they open the PR and nothing more. A review starts only from the picker, and posting still needs the two confirmations (5.4).
  - **Every event by default (`all`):** it's easier to try everything and remove what's noisy than to copy each name from the README. `config.example.json` lists every event for the same reason.
  - **Request changes blocks the author** until you look again. Approving doesn't, which is why `fixes-after-changes` exists on its own next to `reviewed-updated`.
- **Don't:** Send PR titles to a third-party push service. They are the reviewed repository's data.

### 7.5 Follow-up review after fixes
- **Decision:** reviewing a PR again after your Request changes, Comment or Approve runs a follow-up instead of a full review, when it can (`src/follow-up.mjs`).
  - **Source:** your latest posted review on GitHub (REST, which gives the full commit and the time): its numbered findings and the commit in its footer. Reviews you didn't post, and minor items inside `<details>`, aren't read. A review GitHub dismissed counts as what it was posted as (7.3), so a dismissed approval is followed up as an approval, not as a first review.
  - **Decided in code before any model runs,** first match wins: `--full` or `f`; your own PR; no review yet; a review without the reviewpr footer or without numbered findings, unless it was an approval; a reviewed commit that is no longer an ancestor of the head (GitHub's compare status `diverged`/`behind`, confirmed with `git merge-base --is-ancestor`); a reviewed commit GitHub no longer has. Each fallback has one reason, said in the terminal before the run, on the picker row (from the compare call the row already makes) and to the author under the verdict.
  - **Steps:** one check session (the check model) gives each earlier finding Fixed, Partly fixed, Answered (accepted or disputed) or Still open, from the new-code diff, the current files and the replies since the review. One scan session reviews only the new code, told the earlier findings so it doesn't repeat them; verify checks its findings as usual. The scan is skipped without new code.
  - **After an approval:** only the scan of the new commits runs, plus the check of any numbered points the approval left open (questions, should-fix items approved over). An approval without such points, or written by hand, has nothing to check, so there is no check session. The notice reads "Re-review since the approval at `abc1234` (2 new commits): only what the new commits changed was checked.", new findings come under "New since the approval", and with nothing new the verdict is "✅ Ship. Nothing new." (user decision, 2026-11-24).
  - **Unchanged rebase:** when the reviewed commit is no longer an ancestor but the PR's own changes are the same (the picker's comparison), it's still a follow-up, with no new code to scan; the notice says `(rebased, no changes to the PR's code)`.
  - **New code:** `git diff <reviewed> <head>` limited to the files the PR changes, so a merge from the base branch isn't reviewed as the PR's work; the notice says when one happened.
  - **Digest:** written in code (the verdict, a two-line re-review notice, still open, resolved); the review-digest skill writes only the new findings, renumbered after the still-open ones. Still open and new findings stay numbered, and the footer reads `Follow-up at <head> of the review at <old>`, so the next follow-up reads it the same way.
  - **Verdict:** open earlier findings keep their severity; a disputed answer and a partial fix count as open; new findings count as in a full review. All resolved and nothing new above Minor approves.
- **Why:**
  - **The question after fixes is narrower:** were the points fixed or answered, and did the fixes break anything. A full review answers a different one, and its fresh sample of findings on unchanged code is unfair to an author who did what was asked.
  - **Replies matter:** a full review doesn't read them and raises answered points again.
  - **A push dismisses an approval** where branch protection asks for it, so re-approving after small follow-up commits is common. The earlier code was already reviewed and approved; a full review of it again costs two reviewer sessions and samples fresh findings on code nobody changed. Earlier, an approval always got a full review.
  - **The posted review is what the author saw.** The digest may have been edited before posting, and local runs don't record their commit.
  - **The notice is a template, not model text,** so its scope and counts always match what ran.
  - **Resolved points are one line each** (✅ or 💬 and the title, cut at 80 characters): the author made the fix and needs no explanation, and the first version's evidence and quoted replies made a follow-up longer than a full review. Open points keep their reason, since those need action. The evidence stays in the saved `follow-up` stage.
  - **Cost:** two sessions plus a small verify, against two reviewer sessions plus verify.
- **Don't:** Follow up across a rebase by matching moved code (range-diff). It's much harder to get right; the clear fallback covers it.

### 7.6 PR summary before a review
- **Decision:** after you pick a PR, a menu offers Review it (the default), Summarise it first, or Back. The summary is one session on the check model, in the same temporary checkout as a review, saved as `<id>-summary.md` and never posted (`src/summary.mjs`).
  - **Shape:** a standalone first sentence (at most 25 words), 2 to 4 "What changes" bullets (at most 20 words each), at most 2 "Worth knowing" points, about 100 words in total. The size line (files, lines, "mostly tests" or "mostly docs" above 60% of changed lines) is computed in code.
  - **Reader:** a developer on the team who doesn't know this part of the code. Plain, not childish.
  - **Rules in the prompt:** active voice, present tense; what it does, not how it's built (no code names unless the name is the change); no evidence, no judgement, no filler; one name per thing; the code wins over the description, and a disagreement goes under Worth knowing; no guessed reasons. The prompt carries one fictional good example and one bad one.
  - **Enter, Enter reviews as before,** and `f` still starts a full review without the menu. Not in a terminal there's no menu: `--summary` prints the summary, otherwise it reviews.
- **Why:**
  - **PR descriptions are written for the record,** with logs, checklists and file lists. Before deciding to review you want to know what changes and why, in one read.
  - **Sources:** Google's CL description guide (a first line that stands alone and says what the change does; "Fix bug" and "Phase 1" are its bad examples), Keep a Changelog ("for humans, not machines"; always mention removals), Linear's changelog (one plain sentence of 9 to 20 words per change, from the affected person's side), plain-language guides (active voice, present tense, no filler), and a 2026 study of PR descriptions (readers value purpose and reason most, code explanation less). Tools like Copilot and CodeRabbit write file-by-file lists for the GitHub description, which is the opposite of the goal here.
  - **It reads the code, not just the description,** because descriptions drift from what the code does, and that gap is useful to know before a review.
  - **The full checkout, not just `gh pr diff`:** the model can open whole files to see what a change does, and it reuses the tested prepare path with its read-only rules and cleanup.
  - **The check model:** one short text needs no reviewer-grade model.
  - **Never posted:** it's for you, to decide; the PR already has its author's description.
- **Don't:** Ask for a fixed word count the run fails on. A long summary is shown with a note instead.

### 7.7 The terminal bell when a run is done
- **Decision:** an interactive review or summary writes one BEL character (`\x07`) to the terminal when it's done (the review just before the decision screen) or fails (`src/bell.mjs`). Only when the output is a terminal, the run is interactive and took at least 30 s, and `notify` isn't `false`. The Settings screen has a Bell row for it.
- **Why:**
  - **Runs take minutes,** so people work elsewhere meanwhile and had no sign the run was waiting for them.
  - **The bell works everywhere with nothing installed:** the terminal decides how to show it (a dock bounce or badge on macOS, a flashing taskbar button in Windows Terminal). Nothing is spawned, so it can't fail on any platform.
  - **Not watch's notifier (terminal-notifier):** its style is set per app in macOS. The watch alerts are set to stay on screen so they can be read, and "run finished" would then stay on screen too (user decision, 2026-11-24).
  - **Not `node-notifier`:** a new dependency with native helpers for a small feature.
  - **Under 30 s,** you were probably watching. `notify` is read when the run ends, so turning it off applies at once.
- **Don't:** If a banner is wanted later, send it through `osascript` only, never terminal-notifier: macOS files those under another app (Script Editor), whose style can stay a short banner (plans/run-notification.md).

## 8. Evaluation

### 8.1 How changes are judged
- **Decision:** Unit tests (`node --test tests/*.test.mjs`) mock `gh`, `az` and `copilot`, and must pass. Pipeline behaviour changes are judged on real PRs of different kinds against these criteria:
  1. All runs complete.
  2. Each verdict matches its Must-fix findings.
  3. Digests have at most 250 visible words.
  4. No Rejected finding is shown.
  5. The spec is used when linked.
  6. Verify cites code it opened.
  7. No important finding is lost between the reviews and the digest.
- **Why:** These criteria came out of four tuning rounds on 5 PRs, and all of them hold now: a dependency bump, a large feature, a CI fix, a React component and a new skill. The rounds' raw results are in the local, git-ignored `eval/` folder.
- **Don't:** Tune prompts to particular PRs. The tool must stay general.

### 8.1a False positives are checked by hand, and no extra validation stage is added yet
- **Decision:** After the per-finding verify (4.0), every finding visible in the five evaluation digests was re-checked against the code by hand. None was false. The earlier false positives, such as "bump the package version" in a repo whose contributing guide forbids version bumps in feature PRs, are now rejected with evidence from that repo's own docs. No second validation pass before the verdict is added.
- **Why:** Per-finding verify already is the validation step, and on the evidence it works. A further pass would cost model calls without a measured problem to fix.
- **Revisit when:** a confirmed Must or Should fix turns out false. The next lever is an adversarial re-check of only the Must and Should fix items, the ones that drive the verdict, by a fresh agent told to try to disprove them.

### 8.1b Recall is the weak point
- **Finding:** On 5 merged PRs with bugs that were later fixed (12 known bugs), the pipeline raised none at Should fix or above. 2 were buried as Minor, 2 were lost at verify because the reviewer's claim was wrong but pointed at the buggy code, and 8 were never raised by any reviewer. Every verdict was ✅ Ship. Precision is good, recall is not.
- **Implication:** A ✅ verdict means "no confirmed blocking problem found", not "this PR is safe". That's why an Approve is only a recommendation that a person accepts, never automatic, and why the posted footer says the review was AI-assisted.

### 8.2 Known limitation: variance on large PRs
- **Decision:** Accept that one reviewer pass and one verify pass per PR leave some run-to-run variance. Mid-priority points on large PRs can flip between Should fix and Question, or appear and disappear.
- **Why:** This is model judgment, not a pipeline fault. Further prompt tuning on the evaluation PRs would overfit.
- **Open option, not adopted:** Run verify twice and reconcile the two results, at the cost of one more model call per PR.

## 9. Cost budget

### 9.1 Measure every run, aim for about 5 sessions
- **Decision:** Each Copilot session's cost is read from its `session.shutdown` accounting, either in the JSONL stream or in `~/.copilot/session-state/<id>/events.jsonl`. It's summed per stage and shown at the end of every run.
- **Budget per typical PR:** about 5 sessions and ≤ 0.7M tokens. Reviewers ~440k, verify ≤ 200k, digest ~40k.
- **Why:** Copilot bills about one premium request per session, so the number of sessions drives the cost. Measured before the change: about 18 sessions and 1.65M tokens per PR, two-thirds of them in per-finding verify.
- **Don't:** Judge a pipeline change on quality alone; compare its cost line too.
- **Measure in AI credits, not tokens.** On one PR, Haiku 5.5 used 1.8× Sonnet's tokens (1.5M against 0.84M) but cost about 8.5× less (8.8 against 74.7 AI credits). Its extra calls were mostly cheap cache reads, at a much lower per-token price. Caches are per model and expire after 5 minutes, so this wasn't carry-over from the earlier run. The cost table therefore shows `totalNanoAiu / 10^9` per stage as **AI credits**.

### 9.2 Measured on one PR (38 files, 22 findings)
- **Before** (3 reviewers, per-finding verify): 19 sessions, 2.30M tokens. Verify alone was 16 sessions and 1.47M tokens.
- **After:** 5 sessions, 0.95M tokens. Verify was 2 sessions and 190k tokens: 41k listing, 149k checking.
- The reviewers are now about 75% of the cost (ponytail 313k, code-review 405k). If cost needs to drop further, that's the next lever, not verify.

## 10. Dependencies

### 10.1 Three small dependencies, pinned
- **Decision:**
  - `listr2` (live step list), `picocolors` (colours) and `cli-spinners` (frames for listr2's spinner, via a `Spinner` subclass).
  - Exact versions: `.npmrc` sets `save-exact=true`, `package-lock.json` is kept, and installs use `npm ci`.
  - The project is `pr-review` 0.1.0 with semver releases (`CHANGELOG.md`). A pipeline or output change bumps the minor version.
- **Why:**
  - **Research (2026-11):** no small Node-20 library shows several concurrent steps with live elapsed time. listr2 does, but needs Node ≥ 22.13.
  - **picocolors** (6 KB, no dependencies) replaces hand-written colour codes and handles `NO_COLOR`/`FORCE_COLOR`.
  - **cli-spinners** is plain frame data.
  - **Rejected:**
    - `ora`, `log-update` and `chalk` 6: they need Node 22+ for a single spinner.
    - `@clack/prompts` and `@inquirer/select`: they take over stdin and impose their own look on the menus the user likes.
    - `prompts`, `enquirer` and `signale`: unmaintained.
    - `ink`: too large.
- **Adding one:** it must be small, ESM, actively maintained, and must not take over stdin. Pin it exactly, and record it here.

### 10.2 Node 26 for this project only
- **Decision:**
  - `.nvmrc` pins `v26.13.1`, the latest LTS when chosen, and `engines` requires `>=26`. `engine-strict` stops `npm ci` on older Node.
  - When the CLI is started with an older Node, `src/node-version.mjs` (the first import of `src/review.mjs`) restarts it on `$NVM_DIR/versions/node/<.nvmrc version>/bin/node`, with the same arguments, the same terminal, and its exit code passed back.
  - It restarts at most once. If that version isn't installed, the CLI stops with `nvm install <version>`.
  - Tests and imports are never restarted; only the CLI entry point is.
- **Why:** listr2 needs a recent Node. The user wanted the latest Node in this project without changing other projects. `nvm use` alone only switches the current shell, so a new terminal fell back to the default Node 22 and the tool refused to start. The restart needs no shell setup and changes nothing global.
- **Don't:** Change nvm's `default` alias or the user's shell profile to make the tool work. The Copilot CLI is a standalone binary, so the project's Node version doesn't affect it.
