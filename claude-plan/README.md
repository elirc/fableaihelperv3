# Improvement plan: tailorable context for AI Call Assistant

This folder contains a code review of this repository and a proposed plan for
the owner's request:

> "I want a way to tailor the output or give it some context, maybe a system
> point depending on the situation and question or scenario."

It was written by Claude (Opus 5.5) on 2026-09-29 for **another LLM to review**.
Nothing here has been implemented yet. You are being asked to critique the plan
before any code is written.

## Read in this order

| File | What it contains |
|---|---|
| [01-app-review.md](01-app-review.md) | What the app is, how it works, its health, and the gaps that block tailoring |
| [02-proposal.md](02-proposal.md) | The design: three levels of context, prompt layout, data model, templates |
| [03-implementation-plan.md](03-implementation-plan.md) | Phased plan with file-level changes, API sketches, tests, acceptance criteria |
| [04-decisions-and-open-questions.md](04-decisions-and-open-questions.md) | Choices already made (with alternatives), risks, and the questions we want you to answer |
| [appendix-current-code.md](appendix-current-code.md) | Verbatim excerpts of the current prompt and provider code, so you can review without the repo |

## Repository facts you need

- Electron 43 + strict TypeScript + Vite. Main process in `src/main/`, renderer
  in `src/renderer/`, IPC contract in `src/shared/types.ts`.
- The plan was written against the **working tree**, not the last commit
  (`7a62ff8`). The working tree has 19 modified and 9 untracked files
  (about +2.2k lines) that are not yet committed. Phase 0 of the plan commits them.
- At review time: `npm test` → **620/620 passing across 15 files**;
  `npm run typecheck` → clean.
- `docs/spec/REBUILD_PROMPT.md` is the project's behavioral spec (it pins exact
  prompt strings in §7). `docs/TESTING.md` documents every test and why it
  exists. Both are treated as sources of truth and must be updated with any
  behavior change.

## Constraints the plan must respect

These are the project's non-negotiables. Flag anything in the plan that
violates them.

1. **Stop-to-first-word latency (~1 s) is the product.** Anything added to the
   request path must be bounded and measurable. The UI already reports
   per-answer latency (`AnswerMetrics`).
2. **Prompt-cache prefix stability.** Anthropic caching is a prefix match. The
   code deliberately puts per-call-stable content before the cache breakpoint
   and volatile content (answer style) after it. New content must follow the
   same rule.
3. **One active session; stale events dropped by session ID.** The session
   state machine in `src/main/session.ts` is heavily guarded against races.
   Changes to it must preserve those invariants.
4. **Security boundaries.** The renderer never receives API keys (only
   `hasKey` flags). All IPC input is zod-validated in main. Model output
   reaches the DOM only via `textContent`/`createTextNode`, never `innerHTML`.
5. **Settings are untrusted input.** `settings.json` is parsed with per-field
   fallback so one corrupt value never costs the user their other settings.
   Writes are atomic (write-then-rename).
6. **Project conventions.** Pure, DOM-free, Electron-free modules wherever
   possible so logic is unit-testable. Comments explain *why* (invariants,
   races, failure modes), not *what*. Every new test gets an entry in
   `docs/TESTING.md`.

## What we want from you

Write your review as a new file: `claude-plan/reviews/<your-model-name>.md`.
Use these sections:

1. **Blocking issues.** Anything that would break a constraint above, cause a
   bug, or make the feature not do what the owner asked. Cite the plan file and
   section, and the source file/line if relevant.
2. **Suggested changes.** Improvements that are not blocking. Say what you
   would do instead and why.
3. **Answers to the open questions.** These are listed in
   [04-decisions-and-open-questions.md](04-decisions-and-open-questions.md).
   Take a position on each; "no opinion" is fine where true.
4. **Anything missed.** Gaps in the review or the plan.
5. **Verdict.** Proceed as written / proceed with changes / rethink. One line
   of reasoning.

Please be concrete. "Consider edge cases" is not useful; "a scenario deleted
while it is active leaves `activeScenarioId` dangling, see 03 §1.2" is.
