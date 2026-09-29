# 03 — Implementation plan

Each phase ships independently with the full test suite green and docs
updated. API shapes below are **sketches for review**, not final signatures.

| Phase | Scope | Rough size | Depends on |
|---|---|---|---|
| 0 | Commit current working tree | XS | — |
| 1 | Scenarios (situation-level context) | L | 0 |
| 2 | Hints and pinned notes (question-level context) | M | 1 |
| 3 | Call memory (conversation-level context) | M | 2 |
| 4 | Deepgram key terms (transcription accuracy) | S | 1 |

Every phase also updates `README.md`, `docs/TESTING.md` (one entry per new
test, per project convention) and the relevant sections of
`docs/spec/REBUILD_PROMPT.md` (§4 interface, §7 prompt, §8 settings, §9 UX).

---

## Phase 0 — Commit current work

The working tree is green (620 tests, clean typecheck) but uncommitted.
Commit it so Phase 1 has a clean baseline and a reviewable diff.

---

## Phase 1 — Scenarios

### 1.1 Shared types and templates

- `src/shared/types.ts`: add `Scenario` (see 02 §3). Add `scenarios` and
  `activeScenarioId` to `SettingsView` and `SettingsPatch`. Remove
  `jobDescription` from both.
- New `src/shared/scenario-templates.ts`: the template list (id, label,
  instructions, defaultStyle, useAboutMe). No side effects. It's imported by
  main (for migration) and by the renderer (for "New from template").

### 1.2 Store (`src/main/store.ts`)

- `StoreShape` gains `scenarios: Scenario[]` and `activeScenarioId: string`.
  It loses `jobDescription`.
- **Parsing keeps the per-field fallback philosophy, applied per element:**
  - Read `scenarios` as `z.array(z.unknown()).catch([])`, then `safeParse`
    each element with a scenario schema whose fields each have `.catch()`
    defaults. Drop only elements that aren't objects. One corrupt scenario
    must not cost the user the others. (A plain `z.array(scenarioSchema).catch([])`
    would drop all of them.)
  - `activeScenarioId: z.string().catch('')`.
  - `jobDescription: z.string().catch('')` stays in the **read** schema only,
    for migration.
- **Normalization** (a pure function, exported for tests), run after parse and
  after every patch:
  1. Assign a fresh `randomUUID()` (node:crypto) to any scenario with an empty
     or duplicate id.
  2. Truncate to 20 scenarios.
  3. If the list is empty, **migrate**: create one scenario from the
     Behavioral interview template, with `reference = jobDescription` and the
     **fixed id `'migrated-interview'`**. A fixed id means the migration can
     live in memory without a write at read time and still produce the same
     id on every launch until the first save persists it.
  4. If `activeScenarioId` doesn't match a scenario, fall back to the first.
- `applySettingsPatch`: `patch.scenarios` replaces the whole list, then
  normalization runs. Deleting the active scenario therefore falls back to the
  first scenario.
- Replace `getProfile()` with `getAnswerContext(): { aboutMe, scenario, answerStyle, llmProvider }`,
  where `scenario` is the active one (always defined after normalization).

### 1.3 Prompt (`src/main/prompt.ts`)

- Add `BASE_CONTRACT` and the new grounding line (02 §2). Make the "detailed"
  style text generic.
- New signature:

  ```ts
  export function buildSystemPromptBlocks(input: {
    scenario: Scenario;
    aboutMe: string;
    answerStyle: AnswerStyle;
  }): SystemPromptBlocks;
  ```

  `cachedPrefix` = `BASE_CONTRACT` + trimmed `scenario.instructions` (if
  non-empty) + `--- ABOUT THE USER ---` (if `useAboutMe` and non-empty) +
  `--- REFERENCE FOR THIS CALL ---` (if non-empty) + the grounding line (if
  either section is present). `styleSuffix` = style text.
- `buildSystemPrompt` (the Groq joiner) follows the same input shape.

### 1.4 Providers

- `createAnthropicProvider(apiKey, blocks: SystemPromptBlocks)` and
  `createGroqProvider(apiKey, blocks)`. Providers receive pre-built blocks
  instead of `(resume, jd, style)`. This moves prompt assembly into one place
  (`ipc.ts` → `prompt.ts`), and later phases can add inputs without touching
  both providers' signatures again.

### 1.5 IPC (`src/main/ipc.ts`)

- `settingsPatchSchema` adds:
  - `scenarios: z.array(scenarioInputSchema).min(1).max(20)`, with per-field
    length caps: name 80, instructions 20k, reference 200k, keyterms 5k.
    `id` may be empty (main assigns it).
  - `activeScenarioId: z.string().max(64)`.
- `createLlm()` reads `getAnswerContext()`, builds the blocks, and passes
  them to the provider.

### 1.6 Renderer

- `index.html`: the scenario `<select>` shares the style row. In Settings, the
  JD textarea is replaced by a Scenarios section (list + editor), and the
  resume label becomes "About me".
- New pure module `src/renderer/scenarios.ts` for list operations:
  `fromTemplate`, `duplicate`, `remove` (refuses the last one), `update`. It's
  unit-testable in node like `history.ts`.
- `app.ts`: picker wiring (one patch: `{ activeScenarioId, answerStyle }`),
  editor wiring, and `fillSettingsForm` / save changes. All text goes through
  `.value` / `textContent`, never `innerHTML`.

### 1.7 Tests

| File | New or changed cases |
|---|---|
| `test/prompt.test.ts` | Rewrite pinned strings. Section inclusion rules (empty instructions, `useAboutMe: false`, empty reference, grounding line only when a section exists). **Style change leaves `cachedPrefix` byte-identical** (the existing cache invariant, re-pinned). Scenario change alters `cachedPrefix` |
| `test/store.test.ts` | v2 file migrates: resume kept, JD becomes reference of `'migrated-interview'`, which is active. One corrupt scenario among valid ones is dropped alone. Duplicate/empty ids reassigned. Dangling active id falls back. Cap at 20. Deleting the active scenario via patch. Migration id is stable across two cold reads |
| `test/ipc.test.ts` | Patch validation: over-length fields, 0 and 21 scenarios rejected. `createLlm` passes blocks built from the active scenario |
| `test/llm.test.ts` | Providers send the given blocks unchanged (Anthropic: two system blocks, cache_control on the first; Groq: joined) |
| `test/scenarios.test.ts` (new) | Pure list operations |
| `test/app.test.ts` | Picker renders scenarios, switching sends one patch with the default style and updates chips. Editor round-trip |

### 1.8 Acceptance criteria

- A v2 `settings.json` loads with the resume intact and the JD shown as the
  reference of an active "Behavioral interview" scenario.
- All tests pass. Changed existing tests have a reason recorded in `docs/TESTING.md`.
- Manual check with the app running: create a Sales scenario, ask the same
  typed question under Behavioral and Sales, and confirm the answers differ in
  framing.

---

## Phase 2 — Hints and pinned notes

### 2.1 Request shape

Introduce the per-question request object now (Phase 3 fills `priorTurns`):

```ts
// src/main/session.ts
export interface AnswerRequest {
  transcript: string;
  hint: string;                 // '' when none
  priorTurns: readonly Turn[];  // [] until Phase 3
}
export interface LlmProvider {
  generate(req: AnswerRequest, onDelta: (d: string) => void, signal: AbortSignal): Promise<string>;
}
```

- `SessionManager.stop(sessionId, opts?: { hint?: string })` and
  `ask(text, opts?: { hint?: string })` thread `hint` through `runStop` /
  `runAsk` → `streamAnswer` → `runLlm` → `generate`. The supersession, timeout
  and staleness logic is untouched. Only the payload grows.
- `prompt.ts`: `buildUserMessage(transcript, hint)` appends
  `\n\nNote from the user for this answer: <hint>` before `What should I say?`
  when the hint is non-empty. The hint lives in the user message, so it never
  touches the cache.

### 2.2 Pinned notes

- New pure module `src/main/call-context.ts`: `createCallContext()` holds
  `pinnedNotes` (max 5, each ≤ 300 chars) with `pin`, `unpin(index)`, `reset`,
  `notes()`. Phase 3 adds turns to the same module.
- `ipc.ts`: move `createLlm` inside `registerIpc` so it can read the call
  context. Pinned notes are rendered into **system[1]** (after the breakpoint)
  as `--- NOTES FOR THIS CALL ---` plus one line per note.
- New IPC: `call:pin(text)`, `call:unpin(index)`, `call:reset()`. Each returns
  the updated notes list, zod-validated.
- Scenario switch (a patch whose `activeScenarioId` differs from the current
  one) resets the call context.

### 2.3 IPC and preload

- `session:stop` accepts `(sessionId, { hint? })`; `session:ask` accepts
  `(text, { hint? })`. Hint is validated as `z.string().trim().max(500)`.
  Omitting the options object keeps today's behavior, so existing callers and
  tests are unaffected.

### 2.4 Renderer

- `ui-state.ts`: replace `askLocked: boolean` with
  `askMode: 'ask' | 'hint' | 'locked'`. Mapping: idle/answering → `ask`;
  starting/recording → `hint`; finalizing → `locked`.
- `app.ts`: in hint mode, submit stores `pendingHint`, clears the input and
  shows a removable hint chip with a pin toggle. `stopRecording()` sends
  `pendingHint`. It's cleared on stop, abort, and session error. Hotkey-driven
  stop sends it too. Pinning calls `call:pin` and renders pinned-note chips.

### 2.5 Tests

- `test/session.test.ts`: the hint reaches `generate` on both the stop and ask
  paths. A superseded session's hint never reaches the new session's request.
- `test/prompt.test.ts`: user message with and without a hint; pinned notes
  appear only in `styleSuffix`, never in `cachedPrefix`.
- `test/call-context.test.ts` (new): caps, unpin bounds, reset.
- `test/ipc.test.ts`: option validation; scenario switch resets notes.
- `test/history.test.ts` (it holds the ui-state tests): the `askMode` mapping
  for all five states.
- `test/app.test.ts`: typing while recording attaches a hint instead of
  asking; the hint goes out with stop; it's cleared after an error.

---

## Phase 3 — Call memory

### 3.1 Main

- `call-context.ts` gains `turns` (ring buffer, max 3):
  `pushTurn(question, answer)` and `priorTurns(opts?: { excludeQuestion?: string })`.
  Stored text is truncated: question ≤ 1,000 chars, answer ≤ 1,500 chars,
  truncation marked with `…`.
- `ipc.ts` `events.onLlmDone` → `pushTurn(transcript, answer)`. `onLlmDone`
  only fires for the live, non-stale session, so aborted, errored and
  superseded answers are never remembered.
- `SessionManager` gets the turns through a new optional dependency,
  `priorTurns?: (question: string, regenerate: boolean) => readonly Turn[]`
  (default `() => []`), called when the request is built. This keeps the
  session module free of storage.
- **Regenerate:** `askQuestion(text, { regenerate: true })` → IPC →
  `SessionManager.ask(text, { hint, regenerate })` → `priorTurns(text, true)`.
  This excludes any remembered turn whose trimmed question equals `text`, so
  the model doesn't just repeat the answer being replaced.

### 3.2 Providers

- Anthropic: `messages = [...priorTurns.flatMap(t => [{role:'user', content: buildUserMessage(t.question, '')}, {role:'assistant', content: t.answer}]), {role:'user', content: buildUserMessage(req.transcript, req.hint)}]`.
  This alternates correctly and starts with `user`. Prior hints aren't replayed.
- Groq: the same array after the system message.

### 3.3 Renderer

- The **Clear** button becomes **New call**. It calls `call:reset` and clears
  the renderer history. It's enabled while idle, as today.

### 3.4 Tests

- `test/call-context.test.ts`: ring buffer order, truncation, exclusion by
  question.
- `test/session.test.ts`: turns requested at request time with the right
  `regenerate` flag; errored or aborted sessions never pushed.
- `test/llm.test.ts`: message array shape for 0, 1 and 3 turns on both providers.
- `test/app.test.ts`: New call clears history and calls reset; Regenerate
  sends `regenerate: true`.

### 3.5 Latency acceptance

Before and after Phase 3, with the same scenario and About me: run 10 typed
asks (the Ask path has no STT variance) with memory full (3 turns). Record the
median `firstTokenMs` from the latency readout. **Flag the phase if the median
regresses by more than 100 ms.** Report the numbers in the PR.

---

## Phase 4 — Deepgram key terms

> **Must verify first** against Deepgram's current docs: the query parameter
> name (believed to be `keyterm`, repeated once per term), which models
> support it (believed to be Nova-3), and the limits on term count and length.
> Adjust the caps below to match.

- `src/main/stt/deepgram.ts`: pure `buildDeepgramUrl(keyterms: readonly string[]): string`.
  It URL-encodes each term. **With no terms it returns today's URL
  byte-for-byte**, so behavior is unchanged when the feature isn't used.
  `DeepgramStream.connect(apiKey, timeoutMs, keyterms = [])`.
- Parse `scenario.keyterms`: split on newlines, trim, drop empties, dedupe
  case-insensitively, cap at 50 terms of ≤ 50 chars each (placeholder caps
  until verified).
- `ipc.ts` `createStt()` reads the active scenario's key terms.
- Tests (`test/deepgram.test.ts`): encoding of spaces, `&`, `#` and non-ASCII;
  caps; empty list equals the current URL.
