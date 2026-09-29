# 04 — Decisions, risks, and open questions

## Decisions already made

Each has the alternative we rejected. Challenge any of them.

| # | Decision | Why | Alternative considered |
|---|---|---|---|
| D1 | **About me is global; reference is per scenario.** Scenarios opt out of About me with `useAboutMe` | The resume is the same across interviews; the JD differs. Per-scenario resumes would mean editing the same text in several places | Everything per scenario (duplication); or keep one global resume + JD and make scenarios instructions-only (doesn't fix gap G2) |
| D2 | **The base output contract is fixed in code; scenario instructions add to it** | Keeps every answer speakable and first-person, which is what makes this a live-call tool | A fully editable system prompt, possibly behind an "advanced" toggle |
| D3 | **Memory = last 3 turns, truncated** (Q ≤ 1,000 chars, A ≤ 1,500) | Bounded prefill, so bounded latency; 3 turns covers typical follow-ups | A token budget instead of a turn count; summarizing older turns (an extra model call on the hot path, rejected) |
| D4 | **Call memory and pinned notes live in main** (`call-context.ts`) | Request assembly (system blocks) already happens in main. Memory records exactly the answer text main streamed, and needs no per-request history payload over IPC | Renderer-owned: it already keeps 6 entries in `history.ts` and could send them with each request, avoiding new IPC channels |
| D5 | **Hints reuse the ask box** (mode switches while recording) | No new row in a dense view; the box is currently disabled in exactly those states | A dedicated, always-visible hint field |
| D6 | **Scenario switch resets memory and pinned notes** | A new scenario almost always means a new call; stale turns from another context would mislead the model | Keep memory across switches; reset only on New call |
| D7 | **Templates are copied, not linked** | Users own their scenarios; a template wording change in a future version never silently rewrites them | Linked templates with per-field overrides |
| D8 | **Hint → user message; pinned notes → system[1]** | Both after the cache breakpoint. The hint is per-question, so it belongs with the question | Hint in system[1] too (would change system content every question) |
| D9 | **No automatic scenario detection** | It would add a model call to the hot path; the user picks once per call | Classify the first transcript and suggest a scenario |

## Risks

| # | Risk | Mitigation proposed | Status |
|---|---|---|---|
| R1 | **UI density.** The main view already has 7 stacked elements at the 380×520 minimum. The picker, hint chip and pinned-note chips all compete for space | Picker shares the style row; chips appear only when present | Needs review, ideally with a screenshot at minimum size during Phase 1–2 |
| R2 | **SettingsView payload.** Every `saveSettings` (including each style-chip click and scenario switch) returns the full view. With 20 scenarios × up to 200k-char references, that's up to ~4 MB per click over IPC | None yet. Options: a slim view for quick patches, or a separate `scenarios:list` channel | Open (Q7) |
| R3 | **Downgrade.** v2 reading a v3 `settings.json` ignores `scenarios`. v2's next save drops them, and the JD, now inside a scenario, is lost | Keep writing `jobDescription` mirrored from the active scenario's reference | Open (Q8) |
| R4 | **Prompt injection via transcript.** The other party's speech is model input. Memory keeps it in context for 3 turns | Existing risk, slightly extended. Output rendering is XSS-safe, so the worst case is a bad suggestion | Accepted |
| R5 | **Instruction conflicts.** A scenario might say "write an email", contradicting the spoken-reply contract. Models often weight later instructions more, and scenario text comes after the base contract | Document precedence in the Settings hint text | Open (Q2) |
| R6 | **Typing a hint means leaving the call app.** The global hotkey toggles recording but doesn't focus the hint box | None; clicking into the window is acceptable for v1 | Open (Q5) |
| R7 | **Large prompt-test diff in Phase 1.** Pinned strings all change | Reviewers should check that the **cache invariant tests** (style change leaves `cachedPrefix` unchanged) are preserved in substance, not just rewritten to pass | Process note |

## Open questions for the reviewer

Please take a position on each in your review.

1. **Q1: Unit of context.** Is a "scenario" the right unit? Should About me be
   per scenario after all (D1)?
2. **Q2: Base contract.** Fixed (D2), or add an escape hatch that replaces it?
   If fixed, how should precedence against scenario instructions be stated
   (R5)?
3. **Q3: Memory ownership.** Main-owned (D4) or renderer-owned? Is there a race
   or staleness problem with either that we missed?
4. **Q4: Memory size.** Are 3 turns and the character caps right? Should
   memory be a per-scenario toggle?
5. **Q5: Hint UX.** A mode-switched ask box (D5) or a dedicated field? Is it
   worth accepting a hint typed during *finalizing*? Stop has already been
   sent then, so this would need a late-hint channel.
6. **Q6: Regenerate exclusion.** Excluding remembered turns by trimmed
   question text is simple but fuzzy (two identical questions collapse).
   Should the renderer send an explicit turn id instead?
7. **Q7: Settings payload (R2).** Fix now in Phase 1, or defer?
8. **Q8: Downgrade safety (R3).** Worth mirroring `jobDescription`?
9. **Q9: Template wording.** Critique the draft instructions in 02 §4,
   especially Technical interview ("suggest one clarifying question first")
   and Sales ("answer briefly and then ask one discovery question").
10. **Q10: Phase order.** Would call memory (Phase 3) deliver more value
    sooner than hints (Phase 2)? `AnswerRequest` is introduced in Phase 2 but
    could move to whichever phase goes first.
11. **Q11: Cuts.** Is anything not worth building, for example Phase 4, or
    pinned notes?
