# Test Documentation

Run `npm test` for the offline suite, `npm run typecheck` for both process type
checks, and `npm run build` before the Electron smoke check. On Windows where
PowerShell blocks npm.ps1, use `npm.cmd` for those commands. Test totals are
reported by the runner rather than duplicated here.

Every test in the suite, what it verifies, and why it exists. The suite runs
with `npm test` (Vitest), without Electron or network access. The optional
Electron UI smoke check described below is separate from the unit suite.
Electron APIs are mocked where needed (`store`, `ipc`),
network protocols are driven through fakes at the wire level (a mock WebSocket
for Deepgram, a stubbed `fetch` serving real SSE bytes for the LLM providers),
and DOM tests run under `happy-dom` via a per-file pragma — including
`test/app.test.ts`, which drives the real renderer glue against the real
index.html markup over a mocked preload bridge.

The suite checks context correctness and measures latency without claiming a
guaranteed response time. It also protects the invariants that keep concurrent
requests predictable — one live session at a time, stale
events dropped by session id, at most one error per stream, byte-stable prompt
prefixes for caching, and untrusted model output that can never become markup.
Each entry names the failure mode it guards, so a future change that breaks a
test can be judged against the reason the test was written.

`firstTokenMs` measures from Stop or Ask to the first provider delta received
in main; it does not measure screen paint or complete-word recognition.
`sttFinalizeMs` is zero for typed questions. A provider that emits no delta uses
completion time for the first-token field. None of these tests verifies a live
provider latency guarantee, cache hit rate, or real audio transcription quality.

| File | Covers |
|---|---|
| `test/session.test.ts` | Session manager: lifecycle, supersession, timeouts, metrics, the `ask()` path, concurrency stress |
| `test/ipc.test.ts` | IPC layer: validation, Result envelopes, event forwarding, window guards, the audio fast path |
| `test/deepgram.test.ts` | Deepgram WS client: connect races, buffering, keepalive, finalize, error contract, transcript caching |
| `test/pcm.test.ts` | PCM helpers: downsampling, Int16 conversion, RMS |
| `test/llm.test.ts` | Both LLM providers: streaming, caching layout, retries, full error-mapping matrix |
| `test/retry.test.ts` | The shared one-retry policy both LLM providers build on |
| `test/sse.test.ts` | OpenAI-style SSE parser: chunk reassembly, tail flush, hostile payloads, byte-exact buffering |
| `test/context.test.ts` | Profile resolution, snapshots, overrides, selected follow-up bounds, and validation |
| `test/prompt.test.ts` | Prompt builders: content, style handling, cache-prefix byte-stability |
| `test/warm.test.ts` | LLM connection pre-warm: URLs, throttling, never-throws, pooling |
| `test/markdown.test.ts` | Markdown parser + streaming DOM view: correctness, DOM reuse, XSS defence, streaming invariants |
| `test/store.test.ts` | Settings store: validation, secrets encryption, patch semantics, atomic writes, window bounds |
| `test/bounds.test.ts` | Window-geometry sanitization: clamping, off-screen recovery, display changes |
| `test/pricing.test.ts` | Pinned pricing, cache multipliers, and unknown-model fallback |
| `test/format.test.ts` | Renderer display helpers: accelerator labels, timer, errors, latency strings |
| `test/history.test.ts` | Renderer history + state-descriptor modules: live-entry lifecycle, trim, cursor math, per-state UI |
| `test/app.test.ts` | Renderer app glue against real markup: ask/record flows, stale-event filtering, history nav, settings |

---

### test/session.test.ts

The session manager is the orchestrator: one live question/answer pipeline, injected STT/LLM dependencies, timeouts, and metrics. These tests run without Electron or the network.

#### SessionManager (core lifecycle)

- **happy path: audio routed, transcript finalized, answer streamed** — start → audio → stop produces the full event sequence: final `partial` with the transcript, `delta` with the answer, `done` last with transcript+answer. *Why:* this is the product's entire recorded-question pipeline in one assertion; any wiring regression breaks it first.
- **starting a new session aborts the previous one** — a second `start()` returns a higher id, aborts the first STT stream, and drops audio addressed to the stale id. *Why:* "record again while an answer is streaming" is a supported gesture; a leaked socket or misrouted audio would corrupt the new session.
- **an empty transcript reports no_speech** — a whitespace-only finalize surfaces `no_speech` instead of sending an empty prompt to the LLM. *Why:* the user gets an actionable error ("make sure call audio is playing") rather than a hallucinated answer to silence.
- **LLM first-token timeout produces a structured error and aborts** — a provider slower than `llmFirstTokenMs` yields `llm_first_token_timeout`. *Why:* a hung provider must fail within the configured first-delta deadline, not hold the UI in "Answering…".
- **cancel during a slow answer suppresses late events** — `cancel()` while the LLM is in flight yields neither `done` nor `error`. *Why:* aborts the user asked for must be silent; a spurious error dialog after pressing cancel is a bug.
- **createStt failure propagates from start()** — a structured `no_stt_key` throw from the STT factory rejects `start()` with the same code. *Why:* the renderer maps this rejection to the "add your key in Settings" hint; wrapping it would destroy the code.
- **stop on an unknown session is a no-op** — stopping an id that never existed emits nothing. *Why:* stale ids arrive after teardown races; they must not fabricate events.
- **cancel on an unknown session leaves the live one untouched** — `cancel(999)` while a session records does not abort the live stream, and its audio still flows. *Why:* guards the `active?.id === sessionId` check in `cancel()`; a careless cancel-all would kill the recording the user is mid-sentence into.

#### SessionManager stop() reports whether it took the session

- **returns true for the live session** — a normal stop is acknowledged. *Why:* the true/false contract is load-bearing (see below); the positive case anchors it.
- **returns false for a session that never existed** — unknown ids are refused. *Why:* every other outcome of stop reaches the renderer as an event; a stop the manager silently ignores is one the caller waits on forever.
- **returns false once an STT death has torn the session down** — pressing Stop after the socket died (which the renderer may not have noticed) is told the session is gone. *Why:* the level meter runs on local audio, so the window looks alive after an STT death; without this return the UI sits on "Finalizing…" for the rest of the interview.
- **returns false for a second stop while the first is still running** — the in-flight stop owns the session; a duplicate press is refused. *Why:* double-stops must not double-finalize or double-answer.
- **returns false for a stop after the session already completed** — once the answer is done and the slot released, a stale Stop press is refused, not swallowed. *Why:* completes the stop-contract matrix (never-existed / torn-down / in-flight / completed); a hotkey double-tap after an answer must not hang the UI.

#### SessionManager answer metrics

- **measures finalize, first token and total from the moment stop() is called** — after 300ms of recording, `sttFinalizeMs` reads ~40ms (not ≥300ms), and finalize ≤ firstToken ≤ total. *Why:* the product is a latency claim; a clock started at `start()` would leak recording time into the number the UI displays. The 300ms recording keeps the correct and buggy readings an order of magnitude apart so the test cannot flake under load.
- **a provider that never streams a delta reports first token at completion, not 0** — `firstTokenMs === totalMs` when no delta ever fired. *Why:* 0 would render as an instant answer — a metric that lies about the one thing the app is judged on.

#### SessionManager STT stream errors

- **a socket death while recording surfaces as an error and tears the session down** — `stt_error` is emitted, the stream aborted, and subsequent audio/stop are no-ops. *Why:* a silently dead socket would truncate the transcript and answer the wrong question.
- **a socket death during finalize wins over the truncated transcript** — the error beats the partial transcript; no delta or done follows. *Why:* answering "what is your grea" confidently is worse than an error.
- **a late STT error does not kill an answer that is already streaming** — once the transcript is final, Deepgram closing its socket is expected, and `done` still arrives. *Why:* the STT stream's job is over at finalize; a cosmetic close event must not destroy a good answer mid-stream.
- **an error queued before wiring rejects start before the renderer adopts its id** — A synchronous queued STT failure rejects `start()` and closes the stream before returning an id. This prevents a lost early event from leaving the renderer recording into an already-dead session.
- **an error from a session that was already replaced is ignored** — the old socket dying after supersession emits nothing for the old id. *Why:* aborting the old session *causes* its socket to die; reporting that as an error would flash spurious failures on every re-record.

#### SessionManager start() staleness

- **a start superseded while connecting is discarded, and the newest one wins** — when the older `createStt` resolves after the newer one, the older start rejects `aborted`, its stream is torn down, and the winner's partials flow. *Why:* `createStt` is a network round-trip; double-tapping Record must never leave two live sockets or resurrect the loser.
- **a superseded start does not steal the active session from the newer one** — the late-resolving loser does not install itself; audio still reaches the session the user is recording into. *Why:* guards the `latestStartId` claim-before-await; the losing branch overwriting `active` would misroute all subsequent audio.

#### SessionManager ask()

- **happy path: resolves with the id, then partial → deltas → done in order** — `ask()` resolves with the id *before* any event is emitted, then the trimmed question goes out as one final `partial`, deltas stream in order, and `done` carries the trimmed transcript and full answer. *Why:* the renderer routes events by the id it gets from the resolution, so the empty-log-at-resolution assertion pins the event-after-resolve contract; the trim assertions pin the exact text the renderer will display.
- **metrics: sttFinalizeMs is 0, first token measured from ask() to the first delta** — `sttFinalizeMs === 0`, `firstTokenMs` reflects the ~40ms delta delay (clock starts at `ask()` entry), `totalMs ≥ firstTokenMs`. *Why:* there is no STT stage to bill; any nonzero finalize time would fabricate latency, and a clock started later would understate the number the app is judged on.
- **a provider that never streams a delta reports first token at completion, not 0** — same fallback rule as the recorded path: `firstTokenMs === totalMs`, and both nonzero. *Why:* keeps the ask path honest under the same "0 reads as instant" rule; a divergence here would make typed and recorded metrics incomparable.
- **ask supersedes an active recording session** — `ask()` during recording aborts the STT stream, drops the old session's audio and late partials, and the ask's answer completes. *Why:* typing a question mid-recording is a deliberate pivot; a leaked Deepgram socket or a stale partial overwriting the typed question would corrupt it.
- **a new start() supersedes an in-flight ask silently** — pressing Record while an ask's answer streams drops the ask's late events (no done, no error) and the new recording session receives audio. *Why:* the abort is user-intent; a phantom error from the loser or a dead new session would punish the pivot back to recording.
- **an in-flight start() loses to a subsequent ask()** — a `start()` still connecting when `ask()` arrives rejects `aborted` and its late-arriving stream is torn down, while the ask completes. *Why:* proves `ask()` participates in the `latestStartId` claim; without it the slow connection would install itself and hijack the session the user actually asked.
- **cancel mid-ask aborts silently** — `cancel(id)` while the LLM streams yields neither done nor error. *Why:* same silence contract as recorded sessions; cancellation the user requested must not surface as failure.
- **an LLM failure surfaces as a structured error event** — a provider throwing `{code:'llm_auth'}` emits exactly that error and no done. *Why:* structured codes drive the renderer's remediation hints ("check your key"); wrapping them would flatten everything to "internal".
- **a createLlm failure (e.g. missing key) arrives as an event, not a rejection** — the factory throwing `no_llm_key` after `ask()` has already resolved reaches the renderer via `session:error`. *Why:* unlike `stop()`, ask's pipeline runs detached in the background; an uncaught factory throw there would be an unhandled rejection and a UI waiting forever.
- **first-token timeout maps to llm_first_token_timeout** — a provider slower than `llmFirstTokenMs` fails with the specific timeout code. *Why:* proves ask reuses the real `runLlm` timeout machinery rather than a copy without deadlines.
- **total timeout maps to llm_timeout even after tokens have streamed** — a provider that emits a first delta then hangs is killed at `llmTotalMs` with `llm_timeout` (not the first-token code). *Why:* the two timeouts are distinct failure stories; a stream that starts and stalls must still be bounded and correctly labeled.
- **whitespace-only text is rejected without touching the active session** — `ask('   ')` rejects `{code:'internal'}`, emits nothing, and the recording in progress keeps its stream and audio routing. *Why:* the manager stays defensive independent of ipc validation, and the ordering (validate before supersede) means garbage input can never kill a live session.
- **stop() on an ask session returns false — there is no recording to stop** — `stop(askId)` is refused and the in-flight answer still completes. *Why:* a hotkey press during a typed answer must not fabricate a finalize step or disturb the stream; false tells the caller nothing was taken.
- **audio() for an ask session is a silent no-op** — sending PCM to an ask id neither throws nor derails the answer. *Why:* straggler audio frames from a just-superseded recording can arrive addressed to the current id-space; they must vanish harmlessly rather than crash on a null stream.
- **a finished ask releases the slot for the next session** — after done, a stale `cancel()` is a no-op and a fresh `start()` records normally with nothing lingering to abort. *Why:* guards the `finally` cleanup in the ask pipeline; a slot never released would make every later session think it was superseding something.

#### SessionManager concurrency stress

- **a second ask() supersedes the first mid-stream; only the newest answers** — a slow first ask is replaced by a second; the first emits nothing past its partial, the second's answer completes. *Why:* re-asking is a deliberate pivot; a late answer from the superseded ask would interleave two answers in the panel.
- **cancel racing a stop mid-finalize suppresses the entire pipeline** — cancel lands while `finalize` is in flight: `stop()` still returns true (it took the session first), the stream is aborted, and *nothing* — not even the final partial — is emitted. *Why:* the user cancelled before the transcript existed; anything it fed downstream would paint a transcript for a question the user abandoned.
- **a stop that lands while start() is still connecting takes nothing and spares the session** — `stop()` during the `createStt` await returns false, and the session then connects, records, and stops normally. *Why:* the hotkey toggles record/stop, so this race is reachable from one key; a stop that installed state against a half-connected session would wedge it.
- **a new start() while the previous stop is mid-LLM silences that answer** — Record pressed while the previous answer streams: the old session's done/error never fire, its stream is aborted, and audio flows to the new session. *Why:* pins `cancelActive` against a session in its stop phase — the leaked `done` would overwrite the new recording's UI state.
- **an ask() while the previous stop is mid-LLM pivots to the typed question** — same interleaving with `ask()` as the superseder: only the typed question answers. *Why:* completes the supersession matrix (start-vs-ask × recording-vs-stopping); each pairing exercises a different `latestStartId`/`active` handoff.
- **audio sent after stop() was called is dropped, not fed into the finalize** — a straggler frame between `stop()` and finalize completion never reaches the stream. *Why:* guards the `stopped` flag; in the real stream that frame would race the CloseStream flush and could error a stop that is succeeding.

#### SessionManager timeout interplay

- **total timeout during a recorded session maps to llm_timeout after tokens streamed** — recorded-path twin of the existing ask-path test. *Why:* proves the recorded path shares the same deadline machinery rather than a copy without one (the refactor into `streamAnswer` makes this a single point of truth — this test keeps it that way).
- **the first-token timeout is disarmed by the first delta** — a provider that streams its first delta immediately and then goes quiet past `llmFirstTokenMs` still completes. *Why:* guards the `gotFirstToken` check inside the timer; a regression would kill every slow-but-started answer at the first-token deadline.
- **deltas emitted after the total timeout fired are suppressed** — a provider with a decoded chunk in hand when the abort lands cannot paint it; exactly the pre-deadline deltas reach the renderer, and the error is `llm_timeout`. *Why:* guards the `!settled` gate on delta forwarding; a late delta after the error toast would corrupt the error state in the panel.

#### SessionManager LLM abort semantics

- **a provider throw carrying code 'aborted' stays silent even without a signal abort** — a structured `{code:'aborted'}` rejection produces no error and no done, and the slot is released for the next session. *Why:* providers map their own cancellation shapes (e.g. `APIUserAbortError`) to `'aborted'`; the manager must honor the code itself, not only its own signal state, or those would toast as failures.

#### toAppError

- **passes structured errors through** — an `AppError` survives untouched. *Why:* provider code throws deliberate `{code, message}` pairs; re-wrapping would erase the code the renderer keys its messaging on.
- **wraps plain errors with the fallback code** — a bare `Error` becomes `{code: fallback, message}`. *Why:* unexpected throws must still produce a renderer-safe structured error instead of leaking raw exceptions.
- **wraps a bare string throw with the fallback code and the string as message** — `throw 'text'` becomes `{code:'internal', message:'text'}`. *Why:* non-Error throws exist in dependency code; they must reach the renderer structured, not crash the mapper.
- **wraps null and undefined without crashing** — both wrap with the fallback code and their String() form. *Why:* `'code' in err` throws on null; this pins the null-guard ordering in the structural check.
- **an object with a non-string code is not mistaken for an AppError** — `{code: 500}` falls to the fallback code. *Why:* the renderer switches on `code` as a string; a number smuggled through would miss every branch silently.
- **an object missing either half of the pair falls to the fallback** — code-only, message-only, and non-string-message shapes all wrap. *Why:* the structural check requires both halves typed correctly; partial lookalikes must not pass as structured errors.
- **a Node-style Error carrying a string code passes through structured** — `Object.assign(new Error(...), {code:'ECONNRESET'})` keeps its code. *Why:* documented behavior, not an accident — fs/net errors satisfy the structural check, and preserving their code is strictly more diagnostic than flattening to `'internal'`.

### test/ipc.test.ts

The IPC layer is the boundary between the untrusted renderer and the session pipeline: zod validation on every argument, `Result` envelopes on every invoke, and session-id-tagged events on the way back. These tests register the real handlers — real `SessionManager` included — against a mocked `ipcMain` and drive them exactly as the preload would. Electron, the store, Deepgram, the LLM providers, and the pre-warm are mocked; the session manager and the zod schemas are not.

#### ipc registration

- **registers exactly the channels the preload calls** — the handler and listener sets match the channel names in `preload.ts` one for one. *Why:* the preload and ipc.ts each hard-code the channel strings; a drift on either side strands the renderer with an invoke promise that never resolves.

#### ipc settings

- **settings:get returns the store view** — the handler hands back what the store built. *Why:* the renderer's whole settings screen is populated from this one call.
- **settings:set applies a valid patch and returns the fresh view** — the patch reaches `applySettingsPatch` and the caller gets the post-save view. *Why:* the save button re-fills the form from this return value; a stale view would show the user settings they did not save.
- **settings:set rejects a wrong-typed field before the store is touched** — a string `alwaysOnTop` and an unknown provider both reject the invoke and persist nothing. *Why:* zod runs before the store; a compromised or buggy renderer must not be able to write junk into settings.json.
- **settings:set rejects an oversized resume** — 200 001 characters is refused. *Why:* the cap exists so a runaway paste cannot bloat every future prompt (and bill) for the rest of the interview.
- **settings:set pushes alwaysOnTop to the live window** — the flag reaches `win.setAlwaysOnTop`, and a patch without the field leaves the window alone. *Why:* the setting must take effect immediately, but an unrelated save must not re-assert window state.
- **settings:set re-registers the hotkey only when the patch carries one** — `applyHotkey` fires for a new accelerator and for an explicit empty string, never for an unrelated patch. *Why:* the empty string means "disable", which is still a change to apply; spurious re-registration on every save would race the user's keystrokes.
- **settings:set survives a null window (closed while Settings was open)** — saving with the window closed applies the patch without crashing. *Why:* `getWin()` legitimately returns null during shutdown; the store write must not depend on the window living.

#### ipc session:start

- **fails with no_stt_key when the Deepgram key is missing, without dialing out** — the invoke resolves `{ ok: false }` with the exact code, and no connect is attempted. *Why:* the renderer maps this code to the "add your key in Settings" hint; and there is nothing to dial without credentials.
- **connects Deepgram with the stored key and returns the session id** — the decrypted key reaches `DeepgramStream.connect` and the caller gets a positive id. *Why:* the id is how the renderer routes every later event; the key plumb-through is the auth path.
- **pre-warms the active provider on start, ask and stop** — each gesture fires `warmLlmConnection` with the profile's provider. *Why:* the pre-warm is the latency feature; a gesture that forgets to warm silently re-adds a TLS handshake to the stop-to-first-token window.
- **forwards live partials tagged with the session id** — partials arrive on `stt:partial` carrying `{ sessionId, text, isFinal }`. *Why:* the tag is what lets the renderer drop stale events; an untagged event stream would repaint the wrong session's transcript.
- **an STT death mid-recording reaches the renderer as session:error** — the queued error crosses as a tagged event, and a Stop pressed afterwards gets the "already ended" refusal. *Why:* the renderer's level meter runs on local audio, so a dead socket looks alive; the event plus the stop refusal are the only ways the user learns.

#### ipc audio:chunk

- **routes a valid frame to the live stream** — an ArrayBuffer sent with the live id lands in the stream's `sendAudio`. *Why:* this is the entire audio path from renderer to Deepgram; there is no fallback if it drops frames.
- **drops malformed session ids and payloads without throwing** — string/negative/fractional ids and non-ArrayBuffer payloads are inert. *Why:* `audio:chunk` is fire-and-forget at ~8 messages a second; a throwing handler would spam uncaught exceptions in main instead of telling anyone anything.
- **drops audio addressed to a session that is not live** — a stale id sends nothing to the live stream. *Why:* frames from a superseded run must never bleed into the recording that replaced it.

#### ipc audio:chunk fast-path guard

- **refuses every malformed id shape without touching the live stream** — 0, negatives, fractions, NaN, ±Infinity, numeric strings, booleans, null, undefined, arrays, objects: none throw, none deliver. *Why:* the hand-rolled guard replaced zod on the one per-frame handler; this pins that it refuses exactly what the schema refused — `Number.isInteger` must be doing the work (NaN/Infinity are `typeof number`; numeric strings coerce under `>`).
- **a boxed Number id is refused — loose coercion must not smuggle audio through** — `Object(id)` (which `== id`) is dropped. *Why:* only a typeof-level check catches wrapper objects; a loose comparison in a future "simplification" would let them through.
- **typed-array views and a missing payload are refused — the contract is a raw ArrayBuffer** — `Uint8Array`, `DataView`, and an absent payload are all dropped. *Why:* a view wraps a buffer but is not one; forwarding it would hand Deepgram the view object rather than the PCM bytes.
- **a well-formed frame still flows after a burst of garbage** — four bad frames then a good one: the good one is delivered. *Why:* rejection must be stateless; malformed input cannot be allowed to wedge the audio channel shut mid-recording.
- **audio for a session that already stopped is dropped** — a valid id whose session completed delivers nothing. *Why:* it is the session state, not the argument shape, that must refuse the straggler frame; this pins the guard's hand-off to `SessionManager.audio`.

#### ipc session:stop

- **happy path: transcript, streamed deltas, then done with metrics** — stop resolves `ok(null)` after the final transcript, each delta, and a `llm:done` carrying transcript, answer, and internally consistent metrics have all been sent. *Why:* this is the product's full stop-to-answer pipeline crossing the IPC boundary; any envelope or ordering regression breaks it first.
- **builds the provider from the stored profile** — the provider factory receives the decrypted key, resume, JD and style, and the LLM sees the finalized transcript. *Why:* the grounding contract: answers are generated from the user's saved profile, not from defaults that happen to typecheck.
- **a stop for an unknown session is refused, not swallowed** — the invoke resolves `{ ok: false }` with the "already ended" message. *Why:* every other outcome arrives as an event; a stop the manager silently ignored would leave the UI on "Finalizing…" forever.
- **a missing key for the selected provider surfaces as a no_llm_key event** — with the profile on Groq and no Groq key, stop itself succeeds while the failure arrives as a tagged `session:error`, and the warm went to Groq. *Why:* pins the error-envelope split (stop's Result covers only "did the manager take it"; pipeline failures are events) and that provider selection follows the profile.

#### ipc session:ask

- **happy path: question echoed as a final partial, then deltas, then done** — the trimmed question crosses as one final `stt:partial`, the answer streams, and `llm:done` reports `sttFinalizeMs === 0`. *Why:* the ask path reuses the recorded-session event shape by design; the 0 pins the no-STT-stage honesty rule at the IPC level.
- **rejects empty, whitespace-only, oversized and non-string questions as Results** — every invalid input resolves `{ ok: false }` (never throws), and nothing reaches the pipeline. *Why:* ask failures must arrive as structured Results the renderer can render; an oversized paste must be refused before it ships a novel to the LLM.

#### ipc session:cancel

- **cancels the live session and silences its events** — cancel aborts the stream and a later stop is refused. *Why:* cancel is what an aborted start calls to avoid leaking a Deepgram socket (and its keepalive) for the life of the app.
- **a malformed id neither throws nor kills the live session** — garbage ids resolve without effect and the live stream stays up. *Why:* regression for the fixed `.parse` → `safeParse`: the renderer calls cancel fire-and-forget, so a thrown validation error surfaced as an unhandled rejection nobody could act on.

#### ipc window guards

- **events after the window is destroyed are dropped, not crashed on** — a partial arriving after `isDestroyed()` flips true sends nothing and throws nothing. *Why:* sessions outlive windows during shutdown; `send` on a destroyed WebContents throws, and this guard is the only thing between that and an uncaught exception in main.
- **events with no window at all are dropped** — same contract when `getWin()` returns null. *Why:* the other half of the guard: between `closed` and app quit the getter really does return null.

### test/deepgram.test.ts

`DeepgramStream` is the WebSocket STT client: connect race, pre-open buffering, keepalive, the CloseStream flush on Stop, and a one-error-per-stream reporting contract. These tests drive it with a mock WebSocket — no network.

#### parseDeepgramMessage

- **extracts an interim transcript** — a `Results` frame with `is_final: false` decodes to `{ transcript, isFinal: false }`. *Why:* interims are what make the transcript render live while the practice partner is still speaking.
- **extracts a final transcript** — a `Results` frame with `is_final: true` decodes with `isFinal: true`. *Why:* finals mark committed text; downstream logic (accumulation, UI styling) keys off this flag.
- **returns an empty final so callers can clear the interim** — an empty-transcript final is returned, not swallowed. *Why:* an empty final is Deepgram's way of closing out a silent stretch; callers need it to clear a stale interim.
- **ignores Metadata and other non-Results messages** — `Metadata`, `UtteranceEnd`, `SpeechStarted` all return null. *Why:* Deepgram interleaves housekeeping frames with transcripts; treating one as speech would corrupt the transcript.
- **ignores malformed JSON and shapes missing the transcript** — unparseable input and `Results` without a transcript string return null. *Why:* a garbled wire frame must degrade to "nothing heard", never a crash in the message handler.
- **never reports an Error frame as a transcript** — an `Error` frame returns null from the transcript-only API. *Why:* the legacy accessor must not leak error text into the transcript.

#### parseDeepgramFrame

- **decodes transcript frames** — both interim and final `Results` decode to `kind: 'transcript'` with the right flag. *Why:* pins the discriminated-union shape the stream's message handler dispatches on.
- **decodes a v1 listen Error frame, quoting description and variant** — the `{type, description, message, variant}` shape (SDK `ErrorResponse`) maps to a friendly `stt_error` containing both detail and tag. *Why:* this is the error shape the production socket actually sends; the user-facing message must carry the actionable detail.
- **decodes an Error frame that carries code instead of variant** — the newer Flux/agent `{type, code, description}` shape also maps to `stt_error` quoting both. *Why:* Deepgram's error field set varies by socket generation; both must be readable.
- **falls back to message when description is absent** — `message` alone still produces a detailed error. *Why:* only some fields are populated per failure; the fallback chain must not drop the one clue we got.
- **still reports a bare Error frame carrying no detail** — a detail-free `Error` frame yields the generic transcription-error message. *Why:* an error with no fields is still an error; silence here would be a swallowed failure.
- **returns null for frames we do not act on** — `Metadata`, `UtteranceEnd`, malformed JSON return null. *Why:* same tolerance contract as `parseDeepgramMessage`, at the frame level.

#### parseDeepgramFrame hostile inputs

- **an empty alternatives array yields no frame** — `alternatives: []` returns null. *Why:* `alternatives[0]` is undefined; optional chaining must absorb it rather than hand the message handler a TypeError.
- **a missing channel or a null channel yields no frame** — absent, null, and string-typed `channel` all return null. *Why:* the parser sits directly on the network; no shape a proxy could inject may reach typed code.
- **a non-string transcript yields no frame** — numbers, null, arrays, objects in the transcript slot return null. *Why:* the transcript is concatenated into the committed string; a non-string leaking through would corrupt the joined transcript.
- **is_final must be literally true — truthy imposters read as interim** — `'true'`, `1`, `{}`, `[]` decode with `isFinal: false`. *Why:* a final wrongly promoted commits revisable text into the committed prefix; treating imposters as interim is the safe direction.
- **scalar and array JSON payloads are ignored without throwing** — `null`, `42`, `"Results"`, `[]`, `true` as whole payloads return null. *Why:* `msg?.type` on non-objects must stay inert; a scalar frame is not worth a crash.
- **a pathologically nested payload cannot crash the message handler** — 200k-deep nesting (which can blow the JSON.parse stack) returns null without throwing, while a huge flat transcript survives intact. *Why:* the stack-overflow RangeError must land in the same catch as malformed JSON; and "big" alone must never be confused with "hostile".

#### DeepgramStream.connect

- **passes the API key as a subprotocol and asks for arraybuffers** — the socket is constructed with `['token', key]`, `binaryType = 'arraybuffer'`, and the nova-3 URL; connect resolves on open. *Why:* the subprotocol is the only auth the browser-style WebSocket API can carry; getting it wrong is a silent 401-by-close.
- **rejects with stt_connect when the socket errors before open** — `onerror` before open rejects the connect promise. *Why:* regression guard — a failure before open must fail `connect()`, not queue a mid-stream error nobody is listening for yet.
- **rejects with stt_connect when the connect times out** — no open within the budget rejects and closes the socket. *Why:* `connect()` must never hang; connection startup has its own bounded deadline before recording is ready.
- **rejects at once when Deepgram closes before open, quoting the close reason** — a 1008/`DATA-0000` close rejects immediately with the code and reason in the message, and clears the connect timer. *Why:* Deepgram refuses a bad key by closing without `onerror`; this used to hang the full 5 s and then blame the network.
- **starts no keepalive when the socket opens after the connect timed out** — a late `onopen` after rejection sends nothing and leaves zero timers. *Why:* a keepalive started for a stream nobody owns would ping a dead socket forever.

#### DeepgramStream partial transcripts

- **reports an interim segment as not final** — one interim frame produces one `onPartial(text, false)`. *Why:* the live-transcript UX depends on interims flowing through unmodified.
- **reports a finalized segment as final** — a final frame produces `onPartial(text, true)`. *Why:* `isFinal` was once hardcoded false, making the flag a lie; this pins the fix.
- **accumulates finals and appends the live interim, with honest flags** — a realistic interim/final interleaving yields the correct growing transcript with per-frame flags. *Why:* the accumulate-finals-plus-current-interim model is the core transcript invariant.
- **an empty final clears the interim and is reported as final** — an empty final wipes the pending interim and still fires the callback. *Why:* without the wipe, an abandoned interim would stay glued to the transcript forever.
- **a newer interim replaces the previous one instead of appending** — two consecutive interims produce `'hel'` then `'hello wor'`, never `'hel hello wor'`. *Why:* interims are revisions of the same in-flight segment; accumulating them like finals would duplicate speech.
- **ignores binary frames and frames it does not act on** — a binary message and a `Metadata` frame fire no callbacks. *Why:* a non-string frame reaching `JSON.parse`, or housekeeping reaching the transcript, would corrupt or crash the handler.

#### DeepgramStream.onError

- **surfaces a send failure mid-recording as stt_error** — a throwing `send()` emits one `stt_error` quoting the cause. *Why:* staying quiet here is what used to hand the user a silently truncated transcript.
- **surfaces a socket error after open as stt_error** — `onerror` mid-recording emits `stt_error`. *Why:* a dead socket mid-question must be reported, not discovered at finalize.
- **surfaces an unexpected mid-recording close as stt_error, quoting the code** — a 1011/`NET-0001` close we didn't ask for emits an error carrying the close detail. *Why:* the close code is the only diagnostic Deepgram gives for server-side faults.
- **surfaces a Deepgram Error frame as stt_error** — an application-level `Error` frame reaches `onError` with its description. *Why:* Deepgram can report failure over a healthy socket; both failure channels must converge on one error path.
- **delivers at most one error even when the socket errors, closes, and complains** — `onerror` + `onclose` + an `Error` frame produce exactly one callback. *Why:* one dying socket fires multiple events; the session must see one failure, not three toasts.
- **delivers no error after abort()** — every error source fired after `abort()` is suppressed. *Why:* the SttStream contract: no callbacks after abort — a new recording already owns the screen.
- **fires no partial callbacks after abort()** — a transcript frame after `abort()` fires nothing. *Why:* same contract, transcript side: a stale session must not scribble over the new one.
- **replays an error that arrived before onError was registered** — an error raised pre-registration is delivered on registration. *Why:* the session registers `onError` only after `connect()` resolves; the gap must not drop failures on the floor.
- **delivers a queued error exactly once across onError registrations** — a second registration receives nothing. *Why:* the queue must drain on delivery, or one dead socket gets re-reported to every later listener.
- **ignores a socket error that arrives after the stream is already over** — After the finalize promise rejects with `stt_timeout`, a late socket error produces no duplicate callback. The already-reported failure remains the only terminal outcome.
- **does not replay a queued error to a stream that was aborted first** — abort between queueing and registration suppresses the replay. *Why:* "never after abort()" includes queued deliveries, not just live ones.
- **releases the dead socket and stops accepting audio after an error** — post-error, `close()` was called and further `sendAudio` is dropped. *Why:* a stream that errored must be inert: no zombie sends, no resource leak.

#### DeepgramStream audio

- **sends audio frames straight through once open** — frames pass to the socket unmodified and in order. *Why:* the hot path; any buffering here would add latency to every frame.
- **caps pre-open buffering instead of queueing a whole clip** — a simulated 120 s clip against a never-open socket stays ≤ 160 KB with an accurate byte counter. *Why:* pins the memory bound — without the cap the queue grows ~3.8 MB of unsendable ArrayBuffers.
- **flushes pre-open audio in arrival order once the socket opens** — buffered frames hit the wire in FIFO order on open. *Why:* the buffered audio is the start of the question; out-of-order flush would hand Deepgram shuffled speech.
- **keeps everything at exactly the 160 KB boundary without dropping** — a buffer summing to exactly the cap drops nothing. *Why:* pins the boundary semantics (`>` cap, not `>=`) so a refactor doesn't silently discard in-budget audio.
- **drops the oldest pre-open frame first once over the cap** — going one frame over evicts exactly the oldest frame and updates the byte counter. *Why:* drop-oldest keeps the newest (most recoverable) audio; evicting the wrong end would drop the freshest speech.
- **keeps a lone oversized frame rather than dropping the only audio** — a single frame larger than the cap is retained. *Why:* the `length > 1` clause exists so bounded memory never means throwing away all the audio we have.
- **drops buffered audio when the stream is torn down** — `abort()` clears the pending queue and byte count. *Why:* a torn-down stream holding megabytes of PCM would be a leak with no path to the wire.

#### DeepgramStream.finalize

- **sends CloseStream and resolves with the full transcript once the server closes** — the happy path: `CloseStream` out, server close in, transcript returned. *Why:* this handshake is the stop-to-first-token critical path.
- **includes a trailing interim segment that never got finalized** — a dangling interim is part of the returned transcript. *Why:* the last words before Stop are usually still interim; dropping them cuts off the end of the question.
- **counts a tail Results frame that lands between CloseStream and the close** — a final arriving during the close wait is included. *Why:* the entire point of `CloseStream` is that flush; guards the teardown-gating fix from over-suppressing (`closed`, not `closeRequested`).
- **drops audio sent after finalize has asked for the close** — a straggler frame after `CloseStream` is not sent and a poisoned socket raises no error. *Why:* guards a fixed bug — the socket is CLOSING, the frame can't influence the transcript, and a throw here reported a bogus mid-recording error during a successful stop.
- **abort() during the close wait settles finalize at once with what was heard** — abort mid-wait resolves the pending finalize immediately, silently, leaving no timers. *Why:* re-record races stop; nobody will ever emit the close that finalize is waiting for.
- **rejects at once when the socket is not open, without burning the timeout** — A missing connection rejects with `stt_error` immediately and releases its resources. Buffered text must not be mistaken for a confirmed final transcript.
- **ignores frames that arrive after the finalize timeout tore the stream down** — Timeout rejects with `stt_timeout`, preserves previously emitted partial text, ignores late Results, and returns the same rejection on repeated finalize. This prevents an incomplete tail from silently reaching the answer provider.
- **an empty final leaves no gap in the joined transcript** — finals around an empty final join with single spaces. *Why:* empty finals must not become empty list entries that double-space the joined text.
- **a whitespace-only trailing interim resolves to a trimmed transcript** — a `'   '` interim contributes nothing to the result. *Why:* `filter(Boolean)` keeps whitespace-truthy strings; the trailing trim is what keeps them out of the LLM prompt.
- **does not report the close it asked for as an error** — the close following `CloseStream` emits no error. *Why:* the requested close is success; reporting it would toast an error on every normal stop.
- **rejects with stt_timeout when the server never closes** — The deadline rejects finalize, closes the socket, and clears both keepalive and deadline timers. A missing flush acknowledgement must never produce a successful partial answer.
- **rejects at once with the cause when the CloseStream send throws** — A failed CloseStream send rejects immediately with `stt_error` and the send failure detail, leaving no timers. This makes an incomplete flush actionable instead of silently successful.
- **returns at once after abort(), without sending CloseStream** — finalize on an aborted stream resolves instantly and sends nothing. *Why:* an aborted stream has no server to talk to; a `CloseStream` there would throw or leak.
- **rejects after a mid-stream error rather than treating a partial transcript as complete** — A failed stream rejects finalize with `stt_error`; previously emitted transcript text remains available for review. No automatic answer may be generated from an unconfirmed tail.
- **rejects without waiting when the socket closed before finalize requested it** — An unsolicited close rejects finalize immediately. A normal close is successful only after the client requested its final flush.
- **is idempotent: a second call joins the first and sends one CloseStream** — both calls return the same promise, same string, one control frame. *Why:* hotkey mashing double-finalizes; a second `CloseStream` or second wait would corrupt the handshake.
- **returns an empty transcript rather than hanging when nothing was heard** — silence resolves to `''`. *Why:* the session decides what to do with an empty question; finalize just must not hang on it.

#### DeepgramStream keepalive

- **pings Deepgram while the socket is idle** — a `KeepAlive` frame goes out at the 8 s tick. *Why:* Deepgram closes idle sockets (NET-0001) about 10 s after the last audio; long pauses in speech must not kill the stream.
- **stops after abort() and leaves no timer behind** — no frames and zero timers after abort. *Why:* a leaked interval pings a dead socket forever and keeps the process warm.
- **stops when the socket closes unexpectedly** — an unrequested close stops the pinger. *Why:* the interval must die with the socket, not throw once per tick into the error path.
- **sends no KeepAlive once finalize has asked for the close** — after `CloseStream`, the 8 s tick sends nothing. *Why:* guards a fixed bug — a `KeepAlive` after `CloseStream` is at best ignored and at worst throws on the CLOSING socket mid-flush.
- **a close wait timeout rejects once without a duplicate callback or keepalive error** — A close wait spanning keepalive intervals rejects once with `stt_timeout`, sends no duplicate onError callback, and leaves no timers. Finalization owns its terminal error channel.
- **a keepalive send failure surfaces as stt_error and stops the interval** — a throwing keepalive send mid-recording emits one error and clears the timer. *Why:* mid-recording (before any close was requested) a failed ping is the first sign the socket died; it must be reported once and the interval must not keep throwing.
- **a mid-recording send failure stops the keepalive — one error total, no timer left** — after an audio-send failure, 60 s of keepalive ticks add no second error and no timer remains. *Why:* the keepalive was live when the audio send died; without the teardown ordering it would re-report the same dead socket every 8 seconds.
- **a pre-open flush that dies reports once and never starts the keepalive** — the queued-audio flush hitting a dead socket during `handleOpen` emits exactly one `stt_error`, abandons the rest of the queue, and starts no keepalive. *Why:* guards the `closed` re-checks inside `handleOpen`; a keepalive started on the corpse would tick (and maybe error) forever with nobody to clear it.

#### DeepgramStream committed-transcript caching

- **hundreds of interim revisions all report against the same committed prefix** — 300 interim replacements each combine the prefix with only the newest interim, and finalize returns the right join. *Why:* pins the cached-prefix optimization (`fullTranscript` no longer re-joins every final per message); a stale-interim or double-append bug shows up here first.
- **finals interleaved with interims extend the prefix in order** — four snapshots (`final, interim, final, interim`) each read exactly right, and finalize matches. *Why:* cache invalidation must happen exactly when a final commits; any drift shows as a duplicated or missing segment in one of the snapshots.
- **a whitespace-only final joins byte-identically to the old array join** — `'first'`, `'   '`, `'second'` finalize as `first` + 5 spaces + `second`. *Why:* the caching change claimed behavior-identical; this pins the weirdest join edge (interior whitespace preserved, only string edges trimmed) so the claim is checked, not asserted.

### test/pcm.test.ts

Pure PCM helpers shared by the tests and both processes. The audio worklet carries a hand-mirrored copy of this logic (worklets can't import bundled code), so several tests deliberately pin arithmetic the two copies must share.

#### downsample

- **returns input untouched when rates match** — same-rate input returns the identical array instance. *Why:* the passthrough must be zero-copy; cloning every frame on a 16 kHz context would be pure waste on the hot path.
- **halves length at a 2:1 ratio and keeps a constant signal constant** — 32k→16k halves the length and preserves DC. *Why:* box averaging must not change the level of a constant signal; a drift here is a gain bug.
- **48k→16k gives ~1/3 length and averages windows** — a ramp averaged in groups of 3 gives exact window means. *Why:* pins the primary Windows capture rate's exact arithmetic (48 kHz is the default device rate).
- **rejects upsampling** — a from-rate below the target throws. *Why:* silent upsampling would fabricate samples and desync the frame clock; failing loudly is the only honest option.
- **returns an empty output for an empty input** — empty in, empty out, no throw. *Why:* worklet quantum edges can present empty slices; the helper must be total.
- **averages the 1-and-2-sample windows of a 1.5 ratio (24k→16k)** — the narrowest windows the algorithm ever sees (single sample) average correctly. *Why:* exercises the `end > start` guard at its boundary; a one-sample window collapsing to 0 would be a periodic click.
- **places 44.1k→16k window boundaries at floor(i*ratio) on a ramp** — the exact 2/3-wide alternating windows of ratio 2.75625 produce the hand-computed means. *Why:* pins the boundary rule so every input sample lands in exactly one window — no double-counting, no gaps — and any off-by-one refactor fails loudly.
- **handles a non-integer 44.1k→16k ratio without dropping or stretching the signal** — 100 ms in yields exactly 100 ms out with the level intact. *Why:* 44.1 kHz is the other rate Windows hands us; time-base drift here would desync transcript and audio.
- **never emits an empty window as a zero sample on a fractional ratio** — every output sample averages at least one real input sample. *Why:* a zero from an empty window is an audible click, not signal.
- **cancels a signal at the input Nyquist instead of aliasing it down** — a 16 kHz tone at 32 kHz input averages to ~0 rather than folding to DC. *Why:* the anti-alias property is the entire reason box averaging exists over naive decimation.
- **attenuates an out-of-band tone to 1/3 scale at 48k→16k** — the worst-case out-of-band tone is attenuated to exactly 1/3. *Why:* quantifies the filter's attenuation so a "simplification" to picking every Nth sample can't sneak in.
- **does not mutate its input** — the source array is unchanged after downsampling. *Why:* the worklet reuses its input buffer across frames; in-place mutation would corrupt the next frame.

#### floatTo16BitPcm

- **maps full-scale values to int16 extremes and clamps overflow** — −1→−0x8000, +1→0x7fff, 0→0, and ±2 clamp to the rails. *Why:* the ±1↔int16 mapping is the wire contract with Deepgram's linear16 decoder.
- **clamping never wraps around to the opposite rail** — overflow, including ±Infinity, stays in range with the correct sign. *Why:* the asymmetric 0x8000/0x7fff scale is what keeps +1 from becoming 32768 and wrapping to −32768 — the loudest possible click.
- **maps NaN to silence rather than a garbage sample** — NaN encodes as 0. *Why:* Int16Array assignment of NaN happens to be 0; pinning it keeps a driver glitch inaudible instead of undefined.
- **truncates toward zero, matching the capture worklet** — 0.5 → 16383 (not 16384). *Why:* deliberately pins the rounding mode: `pcm-worklet.js` does the identical arithmetic and the two copies are required to stay in sync — if this is ever "fixed", both files must move together.
- **emits little-endian bytes, which is what Deepgram linear16 expects** — the underlying buffer of 0x7fff is `[0xff, 0x7f]`. *Why:* Int16Array uses platform byte order; this fails loudly on a big-endian host rather than sending Deepgram byte-swapped noise.
- **preserves frame length** — output length equals input length, including zero. *Why:* a length change would silently alter frame duration and desync the 128 ms frame clock.

#### rms

- **is zero for silence and matches a known signal** — silence gives 0; ±0.5 square gives 0.5. *Why:* the level meter's anchor points; a wrong constant here miscalibrates the whole meter.
- **is zero for an empty frame** — length 0 returns 0, not NaN. *Why:* `sqrt(0/0)` is NaN; the guard keeps an empty capture quantum from wedging the meter.
- **is 1 for a full-scale square wave and never negative** — full-scale gives 1; an all-negative signal gives its positive magnitude. *Why:* RMS is a magnitude; a sign leak would render the meter below zero.

### test/llm.test.ts

These tests stub global `fetch` rather than mocking the `@anthropic-ai/sdk`, so the real SDK parses real SSE wire bytes and throws its real error classes — the error-hierarchy bugs this file pins could not be caught with a mocked SDK.

#### anthropic provider — happy path

- **streams deltas and returns exactly what was streamed** — feeds a well-formed Anthropic SSE stream and asserts the deltas arrive in order and the returned string equals their concatenation. *Why:* the renderer paints deltas and the history stores the return value; any divergence between the two shows the user one answer and saves another.
- **a multi-block answer returns the streamed concatenation, with no injected separator** — a two-text-block response returns `'onetwo'`, not `'one two'`. *Why:* guards against "simplifying" to the SDK's `finalText()`, which joins blocks with a space that was never streamed.
- **sends the resume+JD as a cached block and the style as a separate uncached block** — inspects the request body: `system` has exactly two blocks, only the first carries `cache_control: {type:'ephemeral'}`, and the model is `claude-haiku-4-5`. *Why:* the caching layout separates stable scenario instructions and reference data from output preferences; a `cache_control` on the style block would make toggling brief/balanced/detailed bust the cache.

#### anthropic provider — error mapping

- **401 maps to llm_auth** — an `authentication_error` response becomes `llm_auth` with a message pointing at Settings. *Why:* a bad key must be actionable, not a generic HTTP failure.
- **403 maps to llm_auth and names the model the key cannot use** — `PermissionDeniedError` becomes `llm_auth` mentioning `403` and `claude-haiku-4-5`. *Why:* a key without model access looks identical to a bad key unless the message names the model; this pins the dedicated 403 branch.
- **429 maps to llm_rate_limit with actionable advice, not llm_http** — the rate-limit branch produces its own code and a wait/credit hint. *Why:* the UI can treat rate limits differently from hard failures; collapsing them into `llm_http` would lose that.
- **529 overloaded maps to llm_http with a retry hint** — the Anthropic-specific 529 status gets an "overloaded, try again" message. *Why:* 529 is not in the SDK's named subclass set; this pins the explicit status check inside the generic branch.
- **400 maps to llm_http and keeps the status visible** — a bad request surfaces with `400` in the message. *Why:* invalid-request bugs (e.g. a bad model id after an edit) must be debuggable from the error text alone.
- **404 maps to llm_http with the status visible (model retired out from under us)** — `NotFoundError` falls through to the generic branch with `404` visible. *Why:* if the pinned model is ever retired, the on-screen error must say so rather than showing something vague.
- **500 maps to llm_http with the status visible, without a retry** — a server error is reported on the first attempt, exactly one fetch call. *Why:* the provider's own retry is scoped to connection errors; retrying a 5xx would burn the first-token budget against a server that already answered.
- **an abort wins over a concurrent HTTP error** — the signal aborts while the SDK is holding a 500; the result is `aborted`, not `llm_http`. *Why:* pins the precedence rule at the top of `toLlmError` — once the user cancels, whatever error was in flight is noise and the session manager must show nothing.
- **an abort maps to aborted, never to an HTTP-undefined error** — the headline regression: `APIUserAbortError` extends `APIError` with `status === undefined`, so a mis-ordered `instanceof APIError` branch turned "user pressed record again" into "Answer generation failed (HTTP undefined)". *Why:* pins the abort check first in the chain.
- **a network failure is a clean message, not a raw TypeError or HTTP undefined** — a rejecting fetch becomes `llm_http` "Could not reach Anthropic". *Why:* `APIConnectionError` has `status === undefined`; falling through to the HTTP branch would print "HTTP undefined" at the user.

#### anthropic provider — single retry on connection failure

- **retries once and succeeds when the connection drops before any token** — first fetch rejects, second succeeds; exactly 2 calls and exactly one answer on screen. *Why:* the retry exists because a pre-stream connection failure is invisible and free to retry; this proves the happy retry path works and does not double-paint.
- **retries at most once, then reports the error** — persistent failure yields exactly 2 calls then `llm_http`. *Why:* an unbounded retry loop against a dead network would hang the answer panel past every timeout.
- **does not retry a request aborted in flight** — an abort during the request yields `aborted` after exactly 1 call. *Why:* a retry after cancellation would race the user's new recording session.
- **does not retry an HTTP error — that would burn the first-token budget** — a 429 response yields exactly 1 call. *Why:* an HTTP status means the server heard us; an instant identical retry can only waste the stop-to-first-token window.
- **never retries after a delta reached the panel, which would duplicate the answer** — a stream that emits `'half'` then dies yields 1 call and `['half']`, not `['half','half']`. *Why:* the renderer appends deltas; a post-stream retry would concatenate two answers.

#### groq provider

- **streams deltas and returns the concatenation** — OpenAI-style SSE lines produce ordered deltas and a matching return value. *Why:* same panel/history consistency contract as the Anthropic provider.
- **does not drop the last delta when the stream ends without a trailing newline** — a truncated final `data:` line is recovered by the tail flush. *Why:* regression pin — without `parseSSETail` the last few words of an answer were silently lost.
- **uses the default public model and suppresses reasoning for latency** — asserts `openai/gpt-oss-120b` (explicitly not the shut-down `llama-3.3-70b-versatile`), `reasoning_effort: 'low'`, `include_reasoning: false`, `stream: true`. *Why:* gpt-oss is a reasoning model; left alone it thinks before speaking, spending the entire first-token budget on an empty panel.
- **caps completion length with room for hidden reasoning and visible answer text** — asserts a 2048-token initial cap and a 4096-token cap for detailed answers or follow-ups. The budget includes hidden reasoning; prompt instructions control concision.
- **multi-byte UTF-8 split across network chunks is reassembled, not corrupted** — delivers the body one byte at a time so every multi-byte character is split across reads; asserts the exact text survives with no U+FFFD. *Why:* pins `decoder.decode(value, {stream:true})` plus the final `decoder.decode()` flush — the provider-side half of UTF-8 safety that the parser tests cannot cover.
- **401 maps to llm_auth** — with `401` visible in the message. *Why:* bad-key errors must be actionable and correctly labelled.
- **403 maps to llm_auth and reports 403, not a misleading 401** — asserts the message contains `403` and not `401`. *Why:* regression pin for the fixed hardcoded "(401)" message that sent 403 users debugging the wrong thing.
- **429 maps to llm_rate_limit** — rate limits get their own code. *Why:* same UI distinction as the Anthropic provider.
- **404 points at the pinned model, the likeliest cause** — the message names the model and suggests updating `llm/groq.ts`. *Why:* Groq retires models on a schedule; a bare 404 would be undiagnosable.
- **5xx maps to llm_http with a retry hint** — a 503 produces "unavailable, try again". *Why:* transient server trouble should read as transient.
- **500 maps to llm_http with the status visible** — the 5xx branch interpolates the real status. *Why:* keeps server errors debuggable from the message alone.
- **an unmapped 4xx keeps the status and a body snippet for debugging** — a 422 falls to the generic branch carrying both status and response body. *Why:* unknown failures must carry enough context to diagnose without a debugger attached mid-interview.
- **a 200 with no body is a clean error, not a TypeError** — a bodyless response yields "empty response body". *Why:* regression pin — this used to be `res.body!.getReader()` throwing "Cannot read properties of null" at the user.
- **an abort during the request maps to aborted** — an already-aborted signal yields `aborted`. *Why:* cancellation is a user action, never an error.
- **an abort mid-stream maps to aborted, not a scary network error** — the stream errors because the session cancelled it; result is `aborted`. *Why:* pins the `signal.aborted` check inside the read-loop catch.
- **a connection drop mid-stream is a clean llm_http message** — a genuine mid-stream failure reads as "connection dropped while streaming". *Why:* distinguishes a real network fault from a cancellation in the same catch block.

#### groq provider — single retry on connection failure

- **retries once and succeeds when the initial fetch rejects** — first fetch rejects, second streams `'recovered'`; 2 calls, one answer on screen. *Why:* pins the new retry parity with the Anthropic provider — a rejected fetch means the request never landed, so one immediate retry is strictly better than an error mid-interview.
- **retries at most once, then reports a clean connection error** — persistent rejection yields exactly 2 calls then `llm_http` "Could not reach Groq". *Why:* bounds the retry so a dead network fails fast instead of looping.
- **re-sends a byte-identical request body on the retry** — asserts the second call's body is the same serialized string as the first. *Why:* the body is built once by design; re-serialization could silently diverge (and wastes time on the retry path).
- **does not retry a request aborted in flight** — abort during the first fetch yields `aborted` after 1 call. *Why:* a retry after cancellation would race the user's next session.
- **does not retry an HTTP error status — the server heard us and said no** — a 429 yields exactly 1 call. *Why:* HTTP statuses resolve rather than reject; this proves they can never enter the retry path.
- **does not retry a 5xx either** — a 503 yields exactly 1 call. *Why:* same rule at the other end of the status range; an instant retry only burns the first-token budget.
- **never retries a mid-stream drop after a delta reached the panel** — a stream that delivers `'half'` then dies yields 1 call, `llm_http`, and `['half']` exactly once. *Why:* the retry is scoped to the initial fetch; a post-stream retry would concatenate two answers in the renderer.
- **an abort that arrives between the two attempts maps to aborted, not llm_http** — first attempt fails for real, user cancels during the retry; result is `aborted` after 2 calls. *Why:* pins the second `signal.aborted` check inside the retry's own catch.

### test/retry.test.ts

`retryOnceIf` is the one shared piece of both LLM providers' "retry exactly once on a pre-stream connection failure" policy. The providers keep their own error recognizers and mapping; what must never drift between them is counted here.

#### retryOnceIf

- **a first-try success makes one attempt and never consults the predicate** — resolves the first attempt's value; the predicate is untouched. *Why:* this helper sits on the stop-to-first-token critical path; the happy path must pay nothing for the retry machinery.
- **a retryable failure is retried once and the second attempt wins** — one failure with a true predicate yields the second attempt's result, two calls total. *Why:* the core policy — a request that never landed is retried invisibly instead of surfacing an error mid-interview.
- **retries at most once even when every failure is retryable, and propagates the second error** — both attempts fail, predicate always true: exactly two calls, one predicate consultation, and the *second* error rejects. *Why:* the second error is the current truth about the connection (an abort may have landed between attempts); and an always-true predicate must not loop.
- **a non-retryable failure propagates untouched after a single attempt** — identity, not equality, on the rejection. *Why:* the callers map errors by `instanceof`; any wrapping here would break their taxonomy downstream.
- **the predicate receives the exact thrown value, Error or not** — a plain `{code, message}` sentinel reaches the predicate by identity. *Why:* both providers throw structured objects as well as Errors; the predicate must be able to inspect whatever actually flew.
- **state the predicate reads is evaluated at failure time, not call time** — an attempt that flips a `streamedAny`-style flag before rejecting is not retried. *Why:* simulates the Anthropic provider's guard; deciding on stale state would duplicate a partially painted answer.
- **non-Error throw shapes (string, null) survive the round trip untouched** — `throw 'string'` and `throw null` reject as-is. *Why:* the helper must not assume Error and must not normalize — mapping is the caller's job.

### test/sse.test.ts

The OpenAI-style SSE chunk/tail parser used by the Groq provider. Network chunks do not align to line or event boundaries — most of these tests exist because of that.

#### parseSSEChunk

- **extracts content deltas from complete lines** — two complete `data:` lines yield two deltas and an empty remainder. *Why:* the basic contract every other behaviour builds on.
- **carries a partial trailing line forward via rest** — a stream split at an arbitrary byte offset loses nothing once `rest` is prepended to the next chunk. *Why:* network chunks do not align to line boundaries; this is the core reassembly invariant.
- **ignores the [DONE] sentinel** — the OpenAI-style terminator emits nothing. *Why:* `[DONE]` is control flow, not content; parsing it as JSON would log noise or crash.
- **skips keep-alive comments and blank lines** — `: keep-alive` and empty lines produce no deltas. *Why:* SSE servers send heartbeats; each one must not become a phantom empty delta.
- **tolerates malformed JSON without throwing** — a garbage payload is skipped and the stream continues. *Why:* one corrupt frame must cost one frame, not the whole answer.
- **drops deltas that have no content field (e.g. role-only opener)** — the `{delta:{role:'assistant'}}` opener frame emits nothing. *Why:* OpenAI-compatible streams always start with a contentless frame; emitting it would send `undefined` to the panel.
- **handles CRLF line endings** — `\r\n`-terminated lines parse identically to `\n`. *Why:* proxies and some servers emit CRLF; the `\r` must not end up glued to the JSON payload.
- **accepts data lines with no space after the colon** — `data:{...}` parses the same as `data: {...}`. *Why:* the space is optional in the SSE spec; a strict prefix match would silently drop every delta from a tight-formatting server.
- **survives a JSON payload that is not an object** — `null`, a string, and a number payload neither throw nor emit. *Why:* `JSON.parse` succeeding is not the same as the payload having the expected shape; the optional-chain must hold for primitives.
- **ignores the trailing usage-only frame Groq sends with empty choices** — `{choices: [], x_groq: {usage}}` emits nothing. *Why:* Groq appends a usage frame after the content; indexing `choices[0]` on it must not produce a delta or a crash.
- **skips empty-string deltas instead of emitting useless events** — `content: ""` is not emitted. *Why:* every delta costs an IPC round-trip and a DOM diff in the renderer; empty ones are pure overhead.
- **skips a null content delta** — `content: null` is not emitted. *Why:* pins the truthiness guard against a provider sending explicit nulls.
- **ignores event: lines (only data: lines carry content)** — an `event: message` line is skipped. *Why:* only `data:` lines carry payload in this dialect; treating other fields as data would corrupt the answer.
- **handles a data line split mid-JSON across two chunks** — a cut placed squarely inside the JSON payload emits nothing on the first call (with the fragment preserved verbatim in `rest`) and the full delta on the second. *Why:* the most common real-world chunking case; an eager parse of the fragment would drop the delta as "malformed".
- **ignores the [DONE] sentinel with CRLF line endings too** — `data: [DONE]\r\n` is still recognised. *Why:* the sentinel comparison happens after trimming; a `\r` glued to `[DONE]` would demote it to a malformed-JSON skip, which works by accident — this pins it working by design.
- **a single chunk containing data lines, a comment, and [DONE] emits exactly the content** — a mixed chunk yields exactly the two content deltas and an empty remainder. *Why:* one network read can contain many events; this proves the per-line loop handles a realistic mixed batch in one call.

#### parseSSETail

- **recovers a final data line that arrived without a trailing newline** — the last delta is absent from `parseSSEChunk`'s output and only produced by the tail flush. *Why:* the regression this function exists for — a stream closing mid-line used to strand the final words of the answer in `rest` forever.
- **an unterminated stream loses nothing end to end** — `drain()` (chunk loop + tail flush, exactly as groq.ts runs it) recovers all deltas from a truncated body. *Why:* verifies the two functions compose correctly in the real call pattern.
- **returns nothing for an empty or whitespace-only tail** — `''`, `'\n'`, `'   '` all yield `[]`. *Why:* the common clean-shutdown case must not fabricate deltas or throw.
- **discards a genuinely truncated JSON payload instead of throwing** — a half-transmitted JSON tail parses to nothing. *Why:* at end-of-stream no more bytes are coming; discarding is the only correct outcome.
- **does not double-emit when the stream ended cleanly with [DONE]** — a properly terminated stream produces each delta exactly once through the full drain. *Why:* the tail flush must be a no-op when there is nothing left, or every clean answer would repeat its last words.
- **is idempotent for a tail that is already newline-terminated** — a terminated line passed to the tail flush still parses correctly. *Why:* pins the `endsWith('\n')` guard so the flush never manufactures a blank line that changes parsing.
- **ignores a tail that is only the [DONE] sentinel without a newline** — `data: [DONE]` as the leftover yields `[]`. *Why:* a server that closes right after the sentinel without a final newline must not produce a phantom delta.
- **ignores a comment-only tail** — `: keep-alive` as the leftover yields `[]`. *Why:* a heartbeat cut off by connection close is noise, not content.

#### parseSSETail line endings

- **recovers a final line terminated by a bare CR** — a tail ending `...}\r` with no `\n` still yields its delta. *Why:* a CRLF stream truncated between the `\r` and the `\n` leaves the `\r` in the tail; the flush must strip it or the last words of the answer vanish.

#### parseSSEChunk buffer bookkeeping

- **[DONE] mid-buffer skips only itself — later lines in the same chunk still parse** — data after `[DONE]` in one chunk is still emitted. *Why:* `[DONE]` is a sentinel to ignore, not a terminator; treating it as end-of-parse would drop bytes a coalescing proxy packed after it.
- **an all-CRLF stream with comments interleaved between events parses like LF** — full-CRLF body with keep-alives between events yields exactly the content deltas. *Why:* servers legitimately emit CRLF; the trim-based CR handling must hold across comments and blank lines, not just data lines.
- **a data line with an empty or whitespace payload is ignored, not parsed** — `data:` and `data:   ` lines burn in the try/catch without taking the chunk's real deltas. *Why:* `JSON.parse('')` throws; a degenerate line must not cost its neighbors.
- **rest is byte-exact: empty after a clean newline, the partial line otherwise** — three shapes: clean-terminated → `''`; trailing partial → exactly the partial; no newline at all → the whole buffer. *Why:* the caller prepends the next chunk to `rest` verbatim; one byte lost or duplicated corrupts the reassembled line. Pins the index-scan rewrite's slicing.

#### end-to-end chunking

- **byte-at-a-time delivery produces the same deltas as one big chunk** — the same body drained at chunk size 1 and at full size yields identical output. *Why:* chunk boundaries are network noise; parser output must be a pure function of the byte stream.
- **multi-byte characters split across chunk boundaries are not corrupted** — non-ASCII content survives 3-byte chunking through line reassembly. *Why:* pins the parser half of UTF-8 safety (the decoder half lives in groq.ts and is tested in llm.test.ts).
- **cutting the stream at every byte boundary yields identical deltas** — one realistic body (comment, LF event, blank line, CRLF event, [DONE]) is cut at every index into two chunks plus tail flush; every cut yields the same deltas. *Why:* a network read can end anywhere — inside `data:`, mid-JSON, between `\r` and `\n`; exhaustive cutting proves the deltas/rest contract has no position-dependent hole (and re-proves it over the index-scan rewrite).

### test/prompt.test.ts

The prompt builders separate stable scenario instructions and quoted reference
material from changeable output preferences and request-specific instructions.
These tests assert the submitted prompt structure, not provider cache hits or
an empirically guaranteed latency.

#### situational prompt

- **supports %s without imposing interview framing** — Runs for interview, technical, client, meeting, and custom scenarios. Every scenario keeps the conversation-assistant role and no-invention rule; non-interview scenarios must not instruct the model to act as a candidate.
- **reference data is quoted separately from behavioral instructions** — Reference text containing apparent instruction headings is JSON-quoted as data while explicit user instructions remain a separate section. This guards accidental promotion of reference content into instructions.
- **disabled resume and job description never appear in the prompt** — Excluded references are physically absent, preventing irrelevant personal material from reaching a provider.
- **empty references retain the unconditional no-invention rule** — Empty profiles still forbid invented experience, metrics, and commitments rather than removing grounding safeguards.
- **all output dimensions and question options leave the cached prefix unchanged** — Length, format, tone, audience, question notes, related answers, and refinements cannot rewrite the stable prefix. This preserves the deliberate provider cache boundary.
- **changing background or instructions changes the stable prefix** — Real changes to saved context affect prompt bytes, preventing stale context reuse.
- **single-system providers receive exactly the same prompt blocks joined by a blank line** — The single-string system prompt equals the two Anthropic blocks joined deterministically. Provider choice cannot change context content.
- **length %s remains independent of format** — Brief, balanced, and detailed lengths retain talking-point formatting without contradictory spoken-only or STAR instructions.

#### current question and explicit related answer

- **preserves multiline transcript and quotes as data** — Newlines and quotes survive JSON encoding, keeping the current question distinct from instructions.
- **ordinary asks carry no prior answer or request notes** — An independent question contains no inferred conversation history or stale one-shot directions.
- **explicit follow-up labels prior output as an unconfirmed suggestion rather than a user fact** — Only the selected prior Q/A is included, with language preventing generated suggestions from being treated as something the user actually said.
- **question note and refinement are separate explicit user instructions outside the prefix** — One-shot directions reach the current user message without polluting stable context or future requests.

### test/warm.test.ts

`warmLlmConnection` pre-warms the HTTPS connection to the active LLM provider so the answer request that fires on Stop reuses a pooled TCP+TLS connection instead of paying the handshake inside the stop-to-first-token window. All tests run under `vi.useFakeTimers()` + `vi.setSystemTime()` because the throttle is `Date.now()`-based, and inject a fetch double via the `fetchFn` parameter — no network, no global-fetch dependence.

#### warmLlmConnection — target URLs

- **warms the Anthropic API origin for the anthropic provider** — exactly one fetch to `https://api.anthropic.com/v1/models`. *Why:* connection pooling is per origin; warming the wrong host warms nothing.
- **warms the Groq API origin for the groq provider** — exactly one fetch to `https://api.groq.com/openai/v1/models`. *Why:* same, for the Groq preset.
- **passes an abort signal so a dead network cannot hold the socket open forever** — the request carries an `AbortSignal`. *Why:* a warm with no timeout could pin a half-open socket on a bad network; the signal bounds it.

#### warmLlmConnection — throttling

- **a second warm inside the 2 s window is dropped** — two immediate calls produce one fetch. *Why:* the warm fires from hot UI paths (record, stop); without the throttle each keystroke-level event would spam the provider.
- **still throttled one millisecond before the window closes** — a call at +1999 ms is dropped. *Why:* pins the boundary as `< 2000`, catching off-by-one regressions in the window comparison.
- **allowed again once the window has elapsed** — a call at +2000 ms fires. *Why:* the other side of the same boundary; a throttle that never reopens would stop refreshing pooled connections mid-interview.
- **throttle state is tracked per provider, not globally** — warming anthropic then groq back-to-back fires both. *Why:* the user can switch providers in Settings; one provider's warm must not starve the other's.
- **a failed warm still counts for throttling (no hot retry loop on a dead network)** — after a rejected warm, an immediate second call is still dropped. *Why:* documents that the throttle stamps on attempt, not success — a dead network must not turn the warm into a rapid-fire retry loop.

#### warmLlmConnection — never throws, never leaks

- **a rejected fetch is swallowed (no throw, no unhandled rejection)** — a rejecting fetch neither throws at the call site nor leaves an unhandled rejection after the microtask queue drains. *Why:* the warm is fire-and-forget from the session path; an escaped rejection would crash the main process over an optimization.
- **a synchronously-throwing fetch implementation is swallowed too** — a fetchFn that throws before returning a promise does not propagate. *Why:* pins the try/catch around the call — `typeof fetch` doesn't guarantee async-only failure, and "never throws" is the contract.
- **a rejected body read is swallowed** — a response whose `arrayBuffer()` rejects stays silent. *Why:* the second failure point in the chain (connection reset during body read) must be as harmless as the first.
- **returns synchronously without waiting for the request** — the function returns while the fetch promise is still pending. *Why:* the warm exists to *remove* latency from the record/stop path; blocking on the network there would add the very latency it exists to remove.

#### warmLlmConnection — connection reuse

- **reads the response body to completion so undici can pool the connection** — `arrayBuffer()` is called on the response. *Why:* undici only returns a connection to the pool once the body is consumed; skipping the read would tear the connection down and silently turn the warm into a no-op.
- **uses the injected fetchFn, never the global fetch** — with global fetch stubbed, only the injected double is called. *Why:* pins the dependency-injection seam the tests (and any future instrumentation) rely on.

#### resetWarmStateForTests

- **clears the throttle so the next warm fires immediately** — warm, reset, warm again produces two fetches with no time advance. *Why:* the documented test seam; if reset stopped working, every warm test after the first would silently assert against stale throttle state.
- **clears every provider, not just one** — resets after warming both providers allow both to fire again. *Why:* the seam iterates the state's keys; a partial reset would produce order-dependent test flakiness.

### test/markdown.test.ts

The markdown module renders untrusted model output as a streaming answer. Runs under the `happy-dom` environment (per-file pragma) so the same file can test both the pure parser and the DOM view.

#### parseInline

- **plain text is one text node** — a string with no markdown collapses to a single text node. *Why:* the baseline shape every other inline case builds on; a tokenizer regression would surface here first.
- **empty input yields no nodes** — `parseInline('')` returns `[]`. *Why:* the streaming path hits empty strings constantly (first token not yet arrived); it must not emit phantom nodes.
- **\*\*bold\*\* and \*italic\* and \`code\`** — a mixed sentence produces strong, em, and code nodes with the surrounding text intact. *Why:* the canonical happy path for all three inline types in one pass.
- **\_\_bold\_\_ and \_italic\_ underscore forms** — underscore delimiters behave like asterisks. *Why:* models switch freely between `*` and `_`; both grammars must stay in sync.
- **intraword underscores stay literal (snake_case, not emphasis)** — `user_id_field` is one text node. *Why:* technical answers are full of snake_case identifiers; emphasizing them would corrupt code names.
- **bold nests inside italic** — `*a **b** c*` (and the `_` form) parses as em containing strong. *Why:* regression for the fixed `findClose` bug where the second `*` of an inner `**` run closed the emphasis early, mangling a very common model construct.
- **a \*\* run inside single emphasis stays literal, as in CommonMark** — `*a**b*` is em("a\*\*b"). *Why:* pins the run-skip logic from both directions; the old code produced em("a\*") + stray text.
- **an escaped star just before the closer does not hide it** — `*a\**` is em("a\*"). *Why:* guards the escaped-`\*` exemption in the new prev-run skip; without it the fix would over-skip real closers.
- **emphasis nests inside bold** — `**a *b* c**` produces strong containing em. *Why:* recursion into delimiter contents must re-run the full inline grammar.
- **inline code is not parsed for emphasis** — `` `a *b* c` `` keeps the stars literal. *Why:* code spans are atomic; emphasizing inside them would corrupt code samples.
- **double-backtick code spans may contain single backticks** — ``` ``a`b`` ``` yields code "a\`b". *Why:* the standard markdown idiom for putting a backtick inside code.
- **one space of code-span padding is stripped, all-space spans are kept** — `` ` a ` `` → "a", plus the exact-length closer rule. *Why:* covers `stripCodePadding` plus the code-span closer fix (the closer must match the opening run length exactly; the old scanner closed against the prefix of a longer backtick run).
- **backslash escapes are honored** — `\*not italic\*` renders literal stars. *Why:* the model's own escaping must not be double-interpreted.
- **a backslash before a non-escapable char stays literal (Windows paths)** — `C:\njs\node` is unchanged. *Why:* answers quote Windows paths; a greedy escape rule would silently eat backslashes.
- **a \* surrounded by spaces is literal, not emphasis** — `2 * 3 * 4` stays text. *Why:* left-flanking rules keep arithmetic and bullet-like prose from turning into emphasis.
- **unterminated bold stays literal mid-stream** — `I **lead` is literal text. *Why:* tokens arrive mid-delimiter; a half-open marker must render as typed, not vanish.
- **unterminated inline code stays literal mid-stream** — `` run `npm `` keeps the backtick visible. *Why:* same streaming property for code spans.
- **mid-stream state keeps every character visible** (parameterized, 8 inputs) — for unterminated `**`, `*`, `__`, `_`, `` ` ``, trailing `*`, trailing `\`, and empty `****` runs, the flattened text equals the input exactly. *Why:* the core streaming invariant — no character may be dropped while its closer has not arrived.
- **once the closing marker arrives, nothing is dropped or duplicated** — the prefix `I **lead` is literal; the completed `I **lead** teams` parses to markup with each character exactly once. *Why:* directly encodes the streaming contract across an update boundary.
- **html in model output is kept as literal text, never markup** — `<img onerror=...>` and `<b>` arrive as one text node. *Why:* the parser layer of the XSS defence; nothing tag-shaped may get structural meaning.
- **links are not parsed, so no href can ever be attacker-controlled** — `[click](javascript:alert(1))` stays literal. *Why:* pins the deliberate no-links design decision; there is no URL to sanitize because none is ever produced.
- **an escaped star inside italic stays literal text** — `*a\*b*` is em("a\*b"). *Why:* the findClose escape-skip must apply mid-span, not just at the closer; a miss ends the emphasis at the escaped star.
- **an escaped star inside bold stays literal text** — `**a\*b**` is strong("a\*b"). *Why:* the double-delimiter scan takes a separate findClose path (no single-run skips); both must honor escapes.
- **word-adjacent underscores never open or close emphasis** — `_foo_bar` and `foo_bar_` stay literal. *Why:* canOpen blocks the intraword open and findClose the intraword close; both directions must hold or identifiers grow phantom emphasis.
- **\*\*\*bold italic\*\*\* degrades to strong plus a stray star, with no character loss** — `***bi***` is strong("\*bi") + "\*". *Why:* pins the deliberate non-CommonMark handling of triple runs so any future change is conscious; the invariant that matters is zero character loss.
- **overlapping delimiters resolve to the first-opened pair** — `*foo _bar* baz_` is em("foo \_bar") + literal tail. *Why:* crossed delimiters cannot nest; the parser must pick a deterministic winner rather than produce crossed markup or crash.
- **emphasis may wrap a code span** — `*a` `` `b` `` `c*` nests a code node inside em. *Why:* the recursive parse inside a delimiter pair must still find code spans.
- **emphasis delimiters work around multibyte text** — `**🎉 café**` parses as strong. *Why:* flanking checks read one UTF-16 unit; a surrogate half must count as non-space.
- **an escaped backtick never opens a code span** — `` \`not code\` `` stays literal text. *Why:* backslash handling runs before the backtick branch; a regression would swallow text up to the next backtick as "code".
- **backslashes inside a code span are kept verbatim** — `` `C:\njs\*` `` keeps both backslashes. *Why:* code spans are atomic; escape processing inside would corrupt Windows paths and regexes.

#### parseMarkdown

- **blank lines separate paragraphs** — `one\n\ntwo` is two `p` blocks. *Why:* the fundamental block boundary the streaming diff keys off.
- **soft-wrapped lines join into a single paragraph** — `one\ntwo` is one paragraph "one two". *Why:* markdown soft-wrap semantics; a regression would double the block count and break DOM reuse.
- **trailing whitespace on paragraph lines is trimmed away** — `one   \ntwo  ` joins to "one two". *Why:* stray token whitespace must not accumulate in rendered text or destabilize block keys.
- **bullet lists with -, \* and + markers** — all three markers produce a `ul`. *Why:* models use all three; each rides the same regex alternation.
- **numbered list keeps its start number** — `3. c\n4. d` is an `ol` with `start: 3`. *Why:* answers often continue numbering across paragraphs; resetting to 1 would misnumber steps.
- **numbered list accepts the 1) form** — `1) a` parses as an ordered list. *Why:* the paren delimiter is common model output.
- **a 10-digit "number" is a paragraph, not a list marker** — `1234567890. x` stays prose. *Why:* CommonMark's 9-digit cap; also keeps years/IDs followed by periods from becoming lists.
- **wrapped bullet text continues the same item** — an indented continuation line joins the previous item. *Why:* lazy continuation keeps wrapped items whole instead of leaking into new blocks.
- **switching from bullets to numbers starts a new list** — `- a\n1. b` is `ul` then `ol`. *Why:* the ul→ol transition must split cleanly, not swallow the other type's item.
- **switching from numbers to bullets starts a new list** — `1. a\n- b` is `ol` then `ul` with both items intact. *Why:* the mirror transition takes a different branch through the list loop.
- **a blank line between items keeps one list (loose list)** — `- a\n\n- b` is a single two-item `ul`. *Why:* models emit loose lists; splitting them would create one-item lists and DOM churn per item.
- **a paragraph after a blank line ends the list** — text after the blank terminates the `ul`. *Why:* the counterpart rule — the loose-list lookahead must not swallow following prose.
- **a fence or heading line ends an open list** — `- a` followed by a fence or `# H` yields `[ul, code]` / `[ul, heading]`. *Why:* covers the explicit break conditions inside the list loop (the "fences inside lists" boundary).
- **list items carry inline formatting** — `- **bold** item` nests a strong node in the item. *Why:* items run the full inline grammar, not a plain-text path.
- **headings by level** — `#` and `###` produce levels 1 and 3 with parsed children. *Why:* baseline heading shape and level extraction.
- **a trailing # that is part of a word survives (C#)** — `### Experience with C#` keeps its hash. *Why:* regression for the fixed closing-hash bug that silently dropped the `#` — permanent character loss in a realistic tech-interview heading.
- **a space-separated closing hash run is stripped, interior hashes stay** — `## Tips ##` → "Tips", `# foo ## bar` keeps the interior run. *Why:* proves the fix still honors CommonMark's decorative-closing-run rule rather than disabling it.
- **#7 and seven hashes are paragraphs, not headings** — no space after `#`, or more than six hashes, means prose. *Why:* `#7` (issue numbers, rankings) must not become a heading; both are CommonMark rules.
- **headings tolerate up to three spaces of indent, like CommonMark** — `   ## indented` is a heading. *Why:* pins the `{0,3}` indent allowance shared by all block regexes.
- **fenced code keeps raw text and does not parse markdown inside** — ` ```js ` content keeps `**1**` literal; the language tag is dropped. *Why:* code must never be reformatted; the info string has no CSS hook by design.
- **unterminated fence renders what has streamed so far** — an unclosed fence shows its partial body. *Why:* while a code answer streams, the fence is open almost the whole time; the body must render live.
- **tilde fences work and blank lines inside a fence are preserved** — `~~~` fences with an interior blank line keep it. *Why:* tilde is a valid fence char, and blank lines inside code are content, not block breaks.
- **a closing fence must be at least as long as the opener** — ` ```` ` is not closed by ` ``` `, and a longer closer works. *Why:* the CommonMark length rule lets code blocks contain smaller fences (markdown-about-markdown answers).
- **a "closing" fence with an info string does not close the block** — ` ``` js ` inside a block is content. *Why:* only opening fences carry language tags; closing early would truncate code.
- **thematic breaks, including - - - which also looks like a bullet** — `---` between paragraphs is an `hr`; `- - -` is a rule, not a one-item list. *Why:* the hr-before-list ordering in the block loop is load-bearing.
- **all three rule characters work, with or without trailing spaces** — `***`, `___`, `- - -`, spaced and trailing-whitespace variants all yield `hr`. *Why:* exercises the full `HR_RE` alternation and its whitespace tolerance.
- **a rule ends an open list rather than joining it** — `- a\n---\n- b` is `[ul, hr, ul]`. *Why:* the in-loop HR check must win over lazy continuation.
- **a rule after a loose-list blank line is a rule, not the next item** — `- a\n\n- - -` is `[ul, hr]`. *Why:* guards the `!HR_RE.test(next)` condition in the loose-list lookahead.
- **setext headings are deliberately not supported: text then --- is p + hr** — `Title\n---` parses as paragraph plus rule. *Why:* documents a design decision so a future "fix" doesn't accidentally change streamed output shape.
- **empty input yields no blocks** — empty and whitespace-only sources produce `[]`. *Why:* the pre-first-token state must render nothing.
- **CRLF input parses like LF** — a CRLF document equals its LF twin. *Why:* Windows-originating text (this is a Windows app) must not confuse line-anchored regexes.
- **CRLF inside a fence does not leak \r into the code text** — fenced content is `\r`-free. *Why:* a stray `\r` in `textContent` renders as odd spacing and would break block-key stability.
- **script tags and event handlers stay literal paragraph text** — `<script>` and `<img onerror>` lines are plain paragraphs, text preserved verbatim. *Why:* block-level counterpart of the inline XSS guarantee.
- **a realistic streamed answer** — a typical interview answer parses to `[p, p, ul, ol]`. *Why:* an integration-shaped check that the block types compose on real-looking input.
- **every prefix of a streamed answer parses cleanly** — all prefixes of a rich answer parse without throwing, and the final shape is correct. *Why:* the parser runs on every token boundary; one throwing prefix would kill the live render.
- **an empty list item is kept as an empty item, not dropped** — `- a\n- \n- b` is one `ul` with a middle empty item. *Why:* the model streams "- " and pauses; collapsing the item would reflow the list when its text arrives.
- **a list item containing only inline code keeps the code node** — `` - `npm test` `` nests a code node as the whole item. *Why:* items run the full inline grammar even when code is the entire content.
- **"- -" is a one-item list, not a rule** — two dashes fall through to the list branch. *Why:* one short of HR_RE's minimum; mirrors how `- - -` falls the other way.
- **two blank lines end a loose list where one would not** — `- a\n\n- b` is one `ul`; `- a\n\n\n- b` is two. *Why:* the loose-list lookahead reads exactly one line; pinned because the streaming boundary scanner models this exact lookahead.
- **hash runs with no text: "##" is prose, "# #" keeps its hash** — plus `## ##` → heading "##". *Why:* HEADING_RE needs whitespace after the opening run and before a decorative closing run; with neither, hashes are text.
- **the fence info string is dropped for backtick and tilde fences alike** — ` ```python ` and `~~~ruby` bodies carry no tag. *Why:* the language tag has no CSS hook by design, for both fence characters.
- **a bare fence opener at EOF is an empty code block, not a crash** — ` ``` ` and ` ```ts ` alone yield `{code, text: ''}`. *Why:* the instant a code answer starts streaming, the source ends in exactly this state.
- **ordered lists keep unusual but valid start numbers** — start 0 and a nine-digit start survive. *Why:* 0 is falsy and an easy victim of a `start || 1` refactor; nine digits is OL_RE's last accepted width.
- **two-character rule candidates stay prose** — `**` and `--` are paragraphs. *Why:* one character short of a thematic break on both alphabets; eager matching would turn streamed half-rules into permanent hrs.

#### createMarkdownView

- **renders each block type with the expected tag** — a full document yields `H3, P, UL, OL, PRE, HR` children with strong/em/code inside the paragraph and `pre > code` structure. *Why:* the AST→DOM mapping uses only tags styled by the existing styles.css; a new tag would silently render unstyled.
- **model headings map to h3–h6 so the page keeps h1/h2 for itself** — `#`…`######` become `H3, H4, H5, H6, H6, H6`. *Why:* pins the level+2 clamp that protects the page's own outline and accessibility tree.
- **ol start attribute appears only when the list does not start at 1** — `start="5"` is set for a list starting at 5, absent for 1. *Why:* the only attribute the renderer ever writes; it must stay a number-derived value, never model text.
- **completed blocks keep their DOM nodes while the stream appends** — node references for finished paragraphs survive later updates; only the growing tail is rebuilt. *Why:* the no-flicker/no-lost-selection property the block-level diff exists for — the product's core rendering guarantee.
- **a closing fence arriving later leaves the code node in place** — closing an open fence (same AST) keeps the same `pre` node, including when more content follows. *Why:* the fence-close boundary is the highest-risk flicker moment in a code answer; identical keys must mean identical nodes.
- **the final update after completion is a DOM no-op** — re-rendering identical text preserves child count and every node reference. *Why:* `llm:done` re-renders the full answer; a rebuild there would flash the whole panel at the worst moment.
- **incremental streaming converges to the same DOM as a one-shot render** — feeding every prefix character by character ends with `innerHTML` identical to a single full render. *Why:* proves mid-stream states (open fences, half-delimiters) never leave residue — no dropped or duplicated characters across update boundaries.
- **placeholder renders a muted line that the first update replaces** — `placeholder()` produces `span.placeholder` with the given text; the first `update()` removes it and renders content. *Why:* the "Listening…" state must never coexist with answer text.
- **clear empties the container and a later update starts fresh** — after `clear()` the container has zero nodes and a new update renders correctly. *Why:* the reset path between history entries must also reset the internal key state, or the next diff would misalign.
- **updating to empty text removes everything** — `update('')` after content empties the container. *Why:* the shrink-to-zero diff path (e.g. re-record) must remove stale nodes, not orphan them.
- **hostile input becomes inert text, character for character** (parameterized, 6 inputs) — script tags, `onerror` images, svg payloads, `javascript:` links, entity-looking text, and SQL-ish text render as a single attribute-free `P` whose `textContent` equals the input exactly. *Why:* the end-to-end XSS guarantee — model text reaches the DOM only via text nodes, with nothing dropped and nothing becoming markup.
- **hostile text inside emphasis and code blocks stays text too** — `<b>` inside strong and `</script><script>` inside a fence remain literal; no `script`/`b` elements exist. *Why:* the inline and code render paths each write text separately; every one of them must hold the line, not just paragraphs.
- **no element in a full render carries any attribute derived from text** — a document salted with `" onmouseover="`-style strings renders with zero attributes on every element. *Why:* attribute injection is the other half of the innerHTML threat model; the walker proves no code path writes model text into attributes.

#### createMarkdownView streaming invariants

- **every prefix of ‹doc› renders exactly like a batch render** (parameterized, 10 documents) — each document (plain paragraphs, nested emphasis, a fence containing markdown syntax, lazy-continuation lists, loose/tight lists, headings and rules, CRLF, lone-CR, emoji/multibyte, a kitchen sink) is streamed at every single cut point, and after each update the `innerHTML` equals a fresh one-shot render of the same prefix. *Why:* the safety net for committed-prefix parsing — cuts land inside `**` runs, fence openers, between `\r` and `\n`, and inside surrogate pairs; any state where incremental rendering diverges from batch fails at the exact cut point.
- **early-completed blocks of ‹doc› keep their DOM nodes to the end** (parameterized, 10 documents) — streaming every prefix while snapshotting child nodes proves node identity is sticky: once a block's final node appears at its position it is never rebuilt. *Why:* the no-flicker/no-lost-selection guarantee, now asserted across every document shape rather than one hand-picked sequence.
- **a long document streamed at random cut points matches batch at every cut** — three concatenated kitchen sinks, 60 seeded-PRNG cut points. *Why:* long streams trigger several committed-prefix advances with jumps that skip whole blocks; deterministic seeds keep failures reproducible.
- **streaming in random multi-character chunks matches batch at every step** — seeded chunk sizes of 1–7 characters. *Why:* real deltas arrive as tokens, not characters, so one update can complete several lines at once — a different boundary-advance cadence than the every-prefix suites.
- **repeating an identical update produces zero mutation records** — a MutationObserver (childList+subtree+characterData+attributes) sees nothing on the second identical `update`. *Why:* app.ts re-renders once per animation frame whether or not a delta arrived; the early-out must make the idle frame free, not merely cheap.
- **a dash arriving after a loose-list blank line rejoins the list above it** — the prefix sequence `- a` → `- a\n\n-` → `- a\n\n- b` matches batch at each step and ends as one two-item `ul`. *Why:* the hardest committed-prefix hazard — `- a\n\n` looks finished, but a later item reopens it; a prefix committed too eagerly would freeze two lists into the DOM.
- **blank lines inside a streaming fence never split the code block** — a fence with interior blank lines streamed at every prefix stays a single `pre`. *Why:* inside an open fence a blank line is content; a boundary committed there would tear the code block in two for good.
- **a complete rewrite (regenerate) renders exactly like a batch render of the new text** — after a full char-by-char stream, replacing the source wholesale renders the new text exactly, and streaming may resume on top. *Why:* stale committed state from the first answer must not leak into the second.
- **shrinking the source to an earlier prefix re-renders that prefix exactly** — shrink is detected as a non-append, extra blocks vanish, and the untouched first block keeps its node. *Why:* re-record/edited re-ask shrinks the source; committed blocks beyond the new end must go while the structural diff still preserves what really is unchanged.
- **a same-length different source is not mistaken for an append** — equal length, different tail takes the rewrite path, with the unchanged leading block's node surviving. *Why:* only a strict-prefix relation may reuse committed state; a length-based shortcut would render the old tail.
- **a placeholder shown mid-stream does not poison a later resumed render** — placeholder between updates disappears on the next update and the resumed render is exact. *Why:* reconnect flows interleave placeholder and stream; the span must never coexist with answer text nor desync the block/DOM mapping.
- **clear mid-stream resets committed state so a new stream renders fresh** — clear between two char-by-char streams leaves the second identical to batch. *Why:* clear runs between history entries; leftover prefix state would misalign every diff of the next answer.

#### createMarkdownView hostility

- **hostile text in headings and list items never becomes markup** — `<script>` in a heading and `<img onerror>` in an item stay text with zero attributes anywhere. *Why:* headings and list items feed appendInlines through different block renderers; each path must hold the line.
- **attribute-injection text inside inline code stays inside the code element** — a `" onmouseover="` payload is the code's textContent; every element attribute-free. *Why:* quote-heavy payloads must never migrate into attribute position.
- **serialized innerHTML shows escaped entities, proving text-node insertion** — `<b>` serializes as `&lt;b&gt;`, pre-escaped `&amp;` double-escapes to `&amp;amp;`. *Why:* the strongest observable form of "never innerHTML" — the serializer itself shows model text was inserted as text nodes.
- **a fence body cannot break out of its pre element** — `</pre><script>` inside a fence stays literal in one `pre`. *Why:* the classic sandbox escape when code blocks are string-concatenated; here it must be inert.

### test/store.test.ts

The settings store persists the profile and safeStorage-encrypted API keys. Runs in node with `electron` mocked (`app.getPath` → temp dir, `safeStorage` → reversible fake DPAPI), so tests can tell real encryption from plaintext on disk.

#### store defaults aliasing

- **a settings.json without a secrets key does not poison the defaults** — saving a key into a file that lacked `secrets`, then re-loading a different file, shows no inherited key. *Why:* regression for the real shipped bug where `{ ...DEFAULTS, ...parsed }` aliased the shared defaults object and leaked one profile's API keys into every later load.
- **clearing a key does not delete it out of the defaults either** — set-then-clear on one file, then a reload of another file with its own key, still decrypts that key. *Why:* the delete path mutates `secrets` too; it must only ever touch an object the cache built.

#### store validation of settings.json

- **hostile field types fall back to defaults instead of reaching typed code** — numbers, objects, and unknown enum values in every field load as defaults, for both the view and `getProfile()`. *Why:* settings.json is untrusted user-writable input feeding the prompt builder and provider switch; a bad type must never cross into typed code.
- **one bad field does not cost the user the rest of the file** — an invalid `llmProvider` resets alone; resume and answerStyle survive. *Why:* the per-field `.catch` design exists so one corrupt value can't cost the user their resume.
- **a malformed entry inside secrets does not cost the other keys** — a numeric `deepgramKey` and object `groqKey` are dropped while a valid `anthropicKey` still decrypts. *Why:* per-field fallback must hold inside the nested secrets object, not just at the top level.
- **unparseable json / a bare scalar / null / an array loads as defaults rather than throwing at launch** (parameterized) — every non-object file shape yields clean defaults. *Why:* a corrupt file must degrade to first-run behavior, never crash the app at startup.
- **a missing settings.json is a first run, not an error** — no file means defaults, including `alwaysOnTop`. *Why:* the genuine first-launch path.

#### store secrets

- **keys round-trip through safeStorage and never hit disk in plaintext** — saved keys come back trimmed and decrypted, the file contains neither plaintext, the stored value carries the `enc:` marker, and keys survive a cache reset. *Why:* the central promise of the secrets design: encrypted at rest, intact across restarts.
- **the renderer view exposes presence flags only** — the serialized view contains `hasGroqKey` but never the key material. *Why:* keys are write-only across the IPC bridge; the view is what actually crosses it.
- **an empty string clears a key; undefined leaves the others alone** — clearing one key removes it from disk without touching its siblings. *Why:* the documented patch contract for key fields.
- **a whitespace-only value clears the key like an empty string does** — `'   '` behaves as a clear: flag false, secret empty, nothing on disk. *Why:* regression for the fixed trim-order bug that encrypted `''` and left `hasKey` claiming a key that could never authenticate.
- **a key copied from another machine is treated as unset, not a crash** — An undecryptable encrypted value returns an empty secret and a false presence flag. A stored blob must not claim a usable credential when OS decryption failed.
- **an unrecognized storage prefix reads as unset instead of leaking the raw value** — An unknown format returns an empty secret and false presence flag. Corrupt or unsupported storage must never become a provider credential.
- **no plaintext and no ciphertext ever appears in the renderer view** — with all three keys set, the serialized view contains no plaintext, no `enc:`/`plain:` blob, and no `secrets` field at all. *Why:* the strongest form of the write-only guarantee, checked against the exact object the renderer receives.
- **falls back to marked plaintext when the OS keystore is unavailable** — with encryption unavailable, the stored value carries the `plain:` marker and still round-trips. *Why:* the degraded path must stay functional and honestly labeled, so real encryption is distinguishable on disk.
- **a plain: fallback key still reads after the keystore comes back** — a key saved during a keystore outage decrypts after availability returns. *Why:* the stored prefix, not the keystore's current availability, must select the decode path; keying on availability would silently vanish the key on the next launch.
- **getProfile exposes exactly the prompt inputs — never key material** — the profile contains only the expected prompt inputs and model selections, with no key material in its serialization. *Why:* getProfile feeds the prompt builders, whose output goes into network request bodies; a leak here would ship the key to the wrong provider.

#### store patch semantics

- **an empty patch changes nothing** — `applySettingsPatch({})` returns a view equal to the current one and leaves secrets intact. *Why:* the settings dialog saves whole patches; untouched fields must be genuine no-ops.
- **undefined fields are left untouched; only named fields change** — patching `resume` alone leaves jobDescription, answerStyle, and keys as they were. *Why:* undefined-means-skip is the core patch contract; a regression would wipe fields on every save.
- **resume and job description are stored verbatim, not trimmed** — leading/trailing whitespace and newlines survive a reload. *Why:* documents the deliberate contrast with hotkey/keys — profile formatting belongs to the user.
- **an empty string is a real value for plain fields, not a clear** — setting `resume: ''` persists an empty resume. *Why:* only key fields use empty-string-as-delete; plain fields must not inherit that semantic.

#### store answerStyle and hotkey

- **default to brief and the shared DEFAULT_HOTKEY** — first-run values come from the shared constants. *Why:* the renderer and main both import `DEFAULT_HOTKEY`; the store must agree with it, not restate it.
- **persist across a reload** — `brief` + a custom hotkey survive a cache reset, with the hotkey trimmed. *Why:* covers the trim on save plus the disk round-trip for both fields, including `getProfile()`/`getHotkey()` consumers.
- **an empty hotkey means "disabled" and must not spring back to the default** — `''` persists as `''`. *Why:* "no global shortcut" is a real user choice; a fallback-to-default here would re-register a hotkey the user removed.
- **a whitespace-only hotkey saves as "" (disabled), not as raw spaces** — `'   '` persists and reloads as `''`. *Why:* main.ts treats `''` as deliberately disabled; raw spaces would be handed to `globalShortcut.register`, which throws on the malformed accelerator and reports a failure the user never asked for.

#### store hotkeyRegistered

- **reports the live registration state and is never persisted** — the flag follows `setHotkeyRegistered(true/false)` and never appears in settings.json. *Why:* registration is a fact about this run (another app may own the accelerator today); persisting it would lie after a reboot.
- **resetCacheForTests drops the flag along with the cache** — after a reset, the view reports `false` again. *Why:* the test seam must model a fresh process, or later tests would inherit stale registration state.

#### store persistence

- **a failed write does not leave the cache diverged from disk** — when `renameSync` throws, the patch throws, and both memory and disk still hold the previous value. *Why:* regression for the fixed mutate-before-persist gap where a disk-full save left the app claiming a value the next launch silently lost.
- **writes atomically and leaves no partial file behind** — after a save, no `.tmp` remains and the file parses with the new value. *Why:* the observable outcome of write-then-rename in the normal case.
- **persists by writing a tmp file first and renaming it over settings.json** — fs spies confirm exactly one write, to `settings.json.tmp`, followed (in order) by the rename onto the real path. *Why:* pins the mechanism itself — a refactor to a direct write would pass the outcome test but reintroduce torn-file risk on crash.
- **reading settings never creates the file — only a save does** — pure reads leave no settings.json; the first patch creates it. *Why:* read paths must stay side-effect-free, so a browse-only launch touches nothing on disk.
- **creates the userData directory on first save** — saving into a not-yet-existing nested userData path succeeds. *Why:* on a true first run the directory may not exist; persist must create it rather than throw.

#### store window bounds

- **round-trips geometry through disk** — nothing saved on first run; after `setWindowBounds` the exact geometry survives a cache reset. *Why:* the whole feature is "reopen where I left the window"; it only works if the value truly reaches disk.
- **negative positions persist** — a window at `x: -1500` round-trips unchanged. *Why:* Windows places displays left of the primary at negative coordinates; a well-meaning `positive()` in the schema would silently forget every left-monitor user's position.
- **a corrupt windowBounds field falls back to undefined without costing other settings** — a string `x` and negative `width` load as "nothing saved" while the resume survives. *Why:* the per-field `.catch` design must extend to the new field; corrupt geometry degrades to a centered window, never a crash or a lost profile.
- **bounds never reach the renderer settings view** — the serialized view has no `windowBounds` property. *Why:* the view is the renderer's contract; window geometry is main-process state and widening the bridge for it would be pure surface area.
- **the returned bounds never alias the cache** — mutating a returned object does not change the next read. *Why:* same no-shared-references rule the secrets copy enforces; a caller scribbling on the cache would corrupt the next save.
- **a failed write is swallowed — saving geometry must never break shutdown** — with `renameSync` throwing, `setWindowBounds` does not throw, and both memory and disk keep their previous values. *Why:* this runs in the window's close handler; an exception there turns "disk full at quit" into a crash dialog, for data that is purely cosmetic.
- **saving other settings preserves previously saved bounds** — a resume patch after `setWindowBounds` leaves the geometry on disk intact. *Why:* both writers share one settings.json; a patch that rebuilt the file without the field would silently forget the window position on every save.
- **setWindowBounds copies its argument instead of aliasing it** — mutating the caller's object after saving does not change what the store returns. *Why:* main.ts reuses bounds objects across the debounced save path; a live reference in the cache would let later mutation rewrite "what was saved" without a persist.
- **fractional window bounds on disk are dropped as a unit, other fields kept** — `x: 10.5` on disk reads as undefined bounds while the resume survives. *Why:* `getNormalBounds` only yields integers, so fractions mean a hand edit or corruption — distrust the whole geometry (Electron centers) rather than round someone else's guess, and hold the per-field fallback rule for the rest of the file.

### test/bounds.test.ts

`src/main/bounds.ts` is the pure half of window-position persistence: it turns whatever geometry was persisted into safe `BrowserWindow` options, given the live display work areas. main.ts owns the Electron calls; everything decidable is here, testable without a screen.

#### sanitizeWindowBounds fallback

- **nothing saved (first run) returns the default size with no position** — `undefined` yields the default 460×700 and no `x`/`y`, so Electron centers. *Why:* the first launch must look exactly as it did before the feature existed.
- **non-finite coordinates are rejected wholesale** (parameterized) — `NaN`/`±Infinity` in any field falls back to defaults. *Why:* zod validates the file, but this function is also fed by future callers; a `NaN` reaching `BrowserWindow` produces undefined native behavior.
- **the returned object never aliases the saved bounds** — mutating the result leaves the input untouched. *Why:* the input is (a copy of) store state; an alias would let window setup scribble on the cache.

#### sanitizeWindowBounds size clamping

- **a saved size below the window minimum is clamped up** — 100×90 opens at the 380×520 minimum. *Why:* a hand-edited settings.json must not open an unusably small window that the min-size constraint then fights.
- **fractional geometry is rounded to integers** — DPI-scaled fractional values round cleanly. *Why:* `BrowserWindow` expects integers; fractional bounds come from real mixed-DPI setups.
- **a valid on-screen save is returned unchanged** — the common case is byte-for-byte identity. *Why:* the feature's promise is "where I left it", not "near where I left it".

#### sanitizeWindowBounds off-screen recovery

- **a window on an unplugged monitor loses its position but keeps its size** — coordinates on a display that is gone are dropped; the size survives. *Why:* the classic strand: undocking a laptop must not leave the window where no mouse can reach it.
- **a window fully above the work area (behind a top taskbar) is recentred** — y far above a work area that starts at 40 loses its position. *Why:* work areas, not display bounds, are the truth about where a title bar is grabbable.
- **a window mostly off the right edge keeps its position while a grabbable strip remains** — exactly `MIN_VISIBLE_PX` still visible keeps the position. *Why:* users deliberately dock this window mostly off-screen next to a call app; over-eager recovery would undo that every launch.
- **one pixel less visible than the threshold drops the position** — `MIN_VISIBLE_PX - 1` recentres. *Why:* pins the boundary exactly, from both sides.
- **visibility must hold on both axes, not either one** — wide horizontal overlap with the window entirely below the display still recentres. *Why:* an either-axis check would accept a window that shares an x-range with the display while sitting a monitor's height under it.
- **a position on a secondary display survives when that display is present** — coordinates on an attached second monitor are kept. *Why:* the multi-monitor happy path; recovery must only trigger when the display is actually gone.
- **a display at negative coordinates (left of primary) counts** — a position on a left-of-primary monitor is kept. *Why:* negative coordinates are how Windows models left/above displays; treating them as off-screen would recentre half of all dual-monitor setups.
- **no displays at all falls back to size only** — an empty work-area list yields size-only. *Why:* defensive floor: the contract must hold even if the screen API reports nothing.
- **visibility is judged with the clamped size, not the saved size** — a saved 1×1 at the bottom-right corner is visible once clamped up, so the position survives. *Why:* the size the check reasons about must be the size the window will actually open at; judging the raw size gets the corner cases backwards.
- **zero and negative saved sizes clamp up to the window minimum** — `0×0` and negative sizes at a visible position clamp to MIN and keep the position. *Why:* finite garbage from a corrupt save must clamp like any undersized value; a 0×0 BrowserWindow is unusable.
- **a window straddling two adjacent displays keeps its position via the second** — 20px on the primary (not grabbable alone) but the bulk on the secondary keeps the position. *Why:* `some()` must let any one display qualify the window; punishing a straddling window would recentre it on every launch.
- **slivers on different displays do not add up — one display must show enough on both axes** — a 30px column on the primary (x fails) plus wide x-overlap on a far-offset display (y fails) drops the position. *Why:* blending one display's x with another's y would call an unreachable window "visible"; the per-display AND of both axes is the actual grabbability test.
- **exactly MIN_VISIBLE_PX on both axes at the bottom-right corner keeps the position** — the corner case where both overlaps equal the threshold simultaneously. *Why:* the single-axis tests pin each edge; the corner pins the conjunction, where an off-by-one on either axis would flip the result.

### test/format.test.ts

`src/renderer/format.ts` holds the renderer's pure display-string helpers (accelerator labels, the mm:ss timer, error message extraction, and the latency tag strings), extracted from `app.ts` so they can be unit-tested without a DOM.

#### formatAccelerator

- **CommandOrControl renders as Ctrl** — the cross-platform default modifier maps to the Windows key cap. *Why:* the default hotkey ships as `CommandOrControl+Shift+Space` and this is the token every user sees first.
- **CmdOrCtrl renders as Ctrl** — Electron's short alias maps identically. *Why:* users can type either alias into Settings; both must render the same chip.
- **Control and Ctrl both render as Ctrl** — the plain control tokens normalize to one spelling. *Why:* the hint chip should never show two spellings for the same physical key.
- **modifier matching is case-insensitive** — `CTRL`, `commandorcontrol`, and `sHiFt` all normalize. *Why:* the Settings field is free text; casing must not change what the chip teaches.
- **Command, Cmd, Super and Meta all render as Win** — every macOS/Linux-flavored meta token maps to the Windows key. *Why:* this is a Windows app; accelerators pasted from mac-centric docs must still label the key that actually exists.
- **Option and Alt both render as Alt** — the macOS alias joins the Windows name. *Why:* same portability guarantee for the third modifier.
- **Shift renders as Shift** — the identity mapping stays intact. *Why:* guards against a refactor accidentally dropping the one modifier that passes through by name.
- **single letters are uppercased** — `a` → `A`, including inside a combination (`Ctrl+x` → `Ctrl+X`). *Why:* key caps are uppercase; a lowercase letter in the chip would look like a typo.
- **multi-token accelerators join with +** — full combinations map each token and rejoin with `+`. *Why:* this is the exact string painted into the record button's hotkey chip.
- **unknown multi-character tokens pass through untouched** — `Space`, `F11`, `PageDown` survive verbatim. *Why:* the formatter must not mangle key names it does not recognize, or valid accelerators would display wrong.
- **whitespace around tokens is trimmed** — `' Ctrl + Shift + a '` → `Ctrl+Shift+A`. *Why:* hand-typed accelerators often carry stray spaces; the chip should stay clean regardless.
- **empty accelerator stays empty** — `''` → `''`. *Why:* an empty hotkey means "shortcut disabled"; the formatter must not invent text for it.
- **mixed weird casing normalizes modifiers but leaves unknown tokens alone** — `cOnTrOl+sHIFT+f5` → `Ctrl+Shift+f5`. *Why:* matching lowercases before the switch; unknown multi-char tokens keep user-typed casing.
- **empty tokens from doubled plus signs round-trip without crashing** — `Ctrl++` → `Ctrl++`, `+` → `+`. *Why:* half-typed accelerators contain empty segments; the formatter must reproduce, not throw or collapse.
- **only single characters are case-normalized, multi-char names are not** — `space` and `pageDown` pass through unchanged. *Why:* the uppercase rule is for key caps; applying it to key names would corrupt valid Electron tokens.

#### formatTimer

- **0 seconds is 00:00** — both fields are zero-padded from the first tick. *Why:* the timer's very first paint sets the visual shape; `0:0` would jitter the layout.
- **59 seconds is 00:59** — the seconds field fills without rolling over. *Why:* verifies the modulo boundary just before a minute completes.
- **60 seconds rolls over to 01:00** — seconds reset and minutes increment. *Why:* the classic off-by-one spot for mm:ss math.
- **605 seconds is 10:05 (both halves zero-padded)** — a mid-range value pads the seconds beside two-digit minutes. *Why:* exercises padding on both fields at once, not just one.
- **last second before the hour is 59:59** — the largest two-digit-minutes value renders correctly. *Why:* pins the upper edge of the normal display range.
- **large values let the minutes field grow past two digits** — 3600 → `60:00`, 7325 → `122:05`. *Why:* documents that minutes expand rather than wrap; the recording cap makes this unreachable today, but the helper must not silently corrupt if the cap changes.
- **negative seconds produce a string instead of throwing** — `-1` → `-1:-1`, `-61` → `-2:-1`. *Why:* clock skew upstream must degrade to an odd label, never a render crash; pinned so changing the ugly-but-safe output is deliberate.
- **huge durations grow the minutes field without wrapping** — 360000 → `6000:00`. *Why:* 100 hours must not overflow into garbage.
- **fractional seconds leak into the seconds field — the contract is whole seconds** — 90.5 → `01:30.5`. *Why:* documents that callers must floor; the helper does not hide raw-millisecond callers.

#### errorMessage

- **AppError-shaped object yields its message** — a `{code, message}` structured error surfaces just its message. *Why:* this is the shape every session error crosses IPC in; the code is internal, the message is for the user.
- **plain Error yields its message** — a thrown `Error` shows its message, not its stringified form. *Why:* renderer-side throws (clipboard, capture) must read cleanly, without a `Error:` prefix.
- **non-string message property is coerced to a string** — `{message: 42}` → `'42'`. *Why:* the guard checks for the key's presence, not its type; coercion must stay total.
- **string passes through unchanged** — a plain string message displays as-is. *Why:* some call sites pass literal strings to `showError` directly.
- **number is stringified** — `500` → `'500'`. *Why:* anything can be thrown in JS; the error box must render something rather than crash.
- **null and undefined stringify rather than throw** — `'null'` / `'undefined'` come back safely. *Why:* the leading truthiness check exists precisely so `'message' in null` never executes; this pins that.
- **object without a message field falls back to String()** — `{code: 'internal'}` → `'[object Object]'`. *Why:* documents the current fallback for malformed errors so any future change to it is deliberate.
- **Error subclasses yield their message like plain Error** — `TypeError` surfaces its message. *Why:* `'message' in err` sees inherited properties; all Error flavors must read cleanly.
- **an empty message string is returned as-is, not replaced** — `{message: ''}` → `''`. *Why:* the guard checks key presence, not truthiness.
- **a null message coerces to the string "null"** — `{message: null}` → `'null'`. *Why:* coercion must stay total instead of throwing on the value.
- **an array without a message falls back to String()** — `[]` → `''`, `['a','b']` → `'a,b'`. *Why:* arrays are objects and take the `in` check; the fallback must still stringify them.
- **an object-valued message coerces through its own String() form** — `{message: {}}` → `'[object Object]'`; a custom toString wins. *Why:* structured message objects degrade to something printable rather than crashing the error box.

#### latencyLabel

- **1234 ms rounds to "1.2s to first token received"** — the headline number rounds to one decimal via `toFixed`. *Why:* this is the product's core metric string; its exact wording and rounding are load-bearing.
- **rounds up when the hundredths carry (1270 ms → 1.3s)** — `toFixed(1)` rounds rather than floors. *Why:* proves the label rounds to nearest instead of always down.
- **sub-100ms values keep one decimal (0 ms → 0.0s)** — the shape is stable even at zero. *Why:* a bare `0s` would look broken next to every other reading.
- **1999 ms rounds to a whole "2.0s"** — values just under a boundary round up and keep the trailing `.0`. *Why:* fixed-width output keeps the tag from shifting the panel header between answers.
- **double-digit seconds keep the same shape (12340 ms → 12.3s)** — slow answers format identically. *Why:* timeout-adjacent answers still need an honest, correctly formatted readout.
- **an exact half-tenth (1250 ms) rounds up to 1.3s** — the toFixed tie resolves upward. *Why:* pinned so a refactor to manual rounding cannot silently flip boundary readings.
- **a near-timeout value keeps the same template (999999 ms → 1000.0s)** — absurd latencies stay honest and same-shaped. *Why:* no scientific notation, no clamped lie.

#### latencyTitle

- **mixes rounded ms for the stages with one-decimal seconds for the total** — fractional inputs produce `First token received 1235 ms after Stop / Ask · transcript finalized 480 ms · full answer 5.7 s`. *Why:* pins the full hover-breakdown template — separator, unit spacing, `Math.round` on the ms stages, and `toFixed(1)` on the total — byte for byte.
- **integer inputs render without decimals in the ms fields** — whole-number metrics pass through `Math.round` unchanged and the total still shows `.0`. *Why:* the common real-world case; guards against accidental decimal formatting on ms values.
- **a typed question (sttFinalizeMs = 0) reads "finalized 0 ms"** — the ask-flow contract (`sttFinalizeMs: 0`) renders a plain `0 ms`. *Why:* every Ask-box answer will carry this exact value, so its rendering is now a fixed part of the UI.
- **half-millisecond stage values round half up via Math.round** — 100.5/0.5 render 101/1 ms. *Why:* performance.now() feeds fractional ms; the .5 tie must round predictably in both stage fields.
- **all-zero metrics still format cleanly** — zeros render the full template. *Why:* an instant-failure session must not hide fields or divide oddly.

### test/history.test.ts

The renderer's pure state modules, extracted from app.ts so they can be tested
without a DOM: `createHistory` (the Q/A entry list, live-entry lifecycle, view
cursor, and MAX_HISTORY trimming) and `stateUi` (the per-state transport-control
descriptor). app.ts is glue over these; the DOM side of the same behavior is
exercised end-to-end in `test/app.test.ts`.

#### createHistory (empty state)

- **starts empty: no entries, cursor at -1, nothing viewed or live** — a fresh history reports count 0, viewIndex -1, and undefined for viewed/live. *Why:* renderEntry renders placeholders from exactly these values on first paint; a non-empty default would fabricate a history row.
- **prev/next/dropLive on an empty history are refused no-ops** — all three return false and change nothing. *Why:* nav buttons and error teardown fire in every app state; the empty case must be inert, not an index out of range.

#### createHistory (live entry lifecycle)

- **beginLive pushes an empty live entry and moves the cursor to it** — the returned entry is `{question:'', answer:'', metrics:null, live:true}` and becomes both viewed() and live(). *Why:* every recording and ask starts here; the cursor jump is what makes the UI show the new question instead of whatever was being read.
- **mutations through live() are visible through viewed() — same object** — writes via live() read back via viewed(). *Why:* session handlers write through live() while renderEntry reads through viewed(); the contract is one shared object, not a copy.
- **live() returns undefined once the newest entry is retired** — after dropLive, the entry survives but live() finds nothing. *Why:* stale stt/llm events probe live() first; a retired entry that still answered would let a straggler overwrite a completed answer.
- **dropLive discards an entry that captured nothing** — an empty live entry is removed entirely. *Why:* an aborted recording must not leave a blank history row the user has to page past.
- **whitespace-only capture still counts as nothing** — spaces and newlines in question/answer still discard. *Why:* Deepgram can emit whitespace partials for silence; those are not content worth keeping.
- **a question alone is enough to retire instead of discard** — question set, no answer: kept with `live:false`. *Why:* a transcript that arrived before the failure is user-visible history — and the regenerate button needs it.
- **an answer alone is enough to retire instead of discard** — answer set, no question: kept. *Why:* on the ask path an llm:delta can land before any stt text; half an answer is still worth keeping on error.
- **dropLive is refused when the newest entry is already retired** — returns false, count unchanged. *Why:* onSessionError calls dropLive unconditionally; a second error must not delete a completed entry.
- **dropLive keeps the cursor where the user navigated back to** — reading entry 0 while a doomed recording dies leaves the cursor at 0. *Why:* an error in the background must not yank the user off the answer they are reading.
- **dropLive pulls the cursor in when the discarded entry was the one viewed** — cursor clamps from the removed slot to the new last entry. *Why:* guards the `Math.min` clamp; without it viewed() would read one past the end.
- **beginLive over a still-streaming entry abandons it in place** — a second beginLive leaves the first entry `live:true` but unreachable through live(). *Why:* asking over a streaming answer is supported; the old entry's events are already dropped by session id, so retiring it is unnecessary — but it must keep its content.
- **discarding an empty live entry re-exposes a still-live entry beneath it** — dropping the empty newcomer makes the abandoned entry the last again, so live() finds it. *Why:* pins the exact quirk of the last-entry-only live() rule; a "fix" that retired abandoned entries would change error-path behavior in app.ts.

#### createHistory (trimming to capacity)

- **the list never grows past maxEntries; the oldest entry falls off** — a seventh completed entry evicts the first. *Why:* the history is unbounded interview transcript otherwise; memory and the 1-of-N label both depend on the cap.
- **the trim happens on beginLive and the new live entry always survives it** — after trimming, live() and viewed() are the just-pushed entry. *Why:* the slice keeps the *last* maxEntries and the live entry was just appended — trimming must never evict the recording in flight.
- **a still-live abandoned entry is trimmed away like any other** — an entry left `live:true` at the front falls off normally. *Why:* the live flag must not pin an entry in memory forever.
- **a trimming beginLive yanks the cursor from the front to the live entry** — a user reading the oldest answer lands on the fresh recording. *Why:* after the slice, the old index would point at a different entry; moving to the live one is the only non-lying option.
- **a small maxEntries is honoured** — capacity 2 keeps exactly the newest 2. *Why:* proves the cap is the parameter, not a hard-coded 6.

#### createHistory (navigation, clear)

- **prev/next walk the cursor and report whether they moved** — moves return true, boundary presses return false and hold position. *Why:* app.ts re-renders only when the return is true; a false-positive would churn the DOM, a false-negative would freeze the nav buttons.
- **viewingLive is about position, not liveness** — true on the newest slot even when everything is retired. *Why:* the name misleads; renderEntry keys the live/generating tags and stream-follow behavior off "viewing the newest slot", which this pins.
- **clear empties everything** — count, cursor, viewed, live all reset. *Why:* Clear is the user's panic button between interview questions; anything left behind leaks into the next question.
- **the history is usable again after clear** — a fresh beginLive behaves like the first ever. *Why:* clear swaps the array; a stale reference kept anywhere would resurrect old entries.

#### stateUi

- **idle shows the caller-supplied ready text and unlocks the ask box** — full descriptor equality for idle. *Why:* the idle line names the live hotkey, which only the caller knows; the descriptor must not hard-code it.
- **starting/recording/finalizing/answering map to their fixed label, dot and status** (4 cases) — each state's exact recordLabel/dotClass/statusText/askLocked. *Why:* these strings are the app's entire state feedback; a swapped label would tell the user to press Stop while nothing records.
- **the ask box is locked exactly while audio capture is in any stage of flight** — locked for starting/recording/finalizing, unlocked for idle/answering. *Why:* answering deliberately stays unlocked (asking aborts the old session), but capture must never be double-driven; the matrix pins the boundary.

### test/app.test.ts

Drives the REAL app.ts against the REAL index.html markup under happy-dom: the
page body is loaded per test, `window.api` is a mocked preload bridge whose
event callbacks are captured so tests can play the main process, and the module
is re-imported per test (it wires everything at import time). Audio capture is
stubbed at the getDisplayMedia/AudioContext boundary — enough to drive the full
record → stop → answer cycle, including the frame-buffering window while the
session opens. Every assertion is on real DOM state (textContent, hidden,
disabled, aria attributes), never on internals.

#### boot

- **wires the hotkey hint and ready text from settings** — the status line names the formatted accelerator and the hint chip shows it. *Why:* this is the only place the user learns the shortcut exists.
- **first run without a Deepgram key nudges toward Settings** — the status line points at the gear icon. *Why:* the app is dead without keys; the nudge is the entire onboarding.
- **a missing key for the selected LLM provider also nudges** — groq selected with no groq key nudges even though the anthropic key exists. *Why:* the key that matters is the selected provider's; checking the wrong one would nudge users who are fully configured.
- **no nudge when the selected provider has its key, even if the other is missing** — the mirror case stays on the ready text. *Why:* nagging a configured user about a provider they don't use trains them to ignore the status line.
- **a taken hotkey shows the warning and drops it from the ready text** — `hotkeyRegistered:false` shows the "already taken" notice, hides the chip, and falls back to the base ready text. *Why:* advertising a shortcut that silently does nothing is worse than none.
- **a failing getSettings at boot lands in the error box** — the rejection message becomes visible. *Why:* the first-run IIFE is fire-and-forget; without the catch the failure would be an unhandled rejection and a silent UI.
- **style chips reflect the persisted answer style** — the saved style's chip is aria-pressed on load. *Why:* the chips are the visible truth of a persisted setting; defaulting visually to "balanced" while "detailed" is stored lies about every future answer.

#### ask flow

- **a typed question flows end to end: ask → stream → done** — submit calls askQuestion with trimmed text, claims the answering state (status, gen tag, aria-busy, question shown, input cleared, regenerate offered), streamed deltas render as markdown, and done lands the final transcript/answer/latency tag and returns to idle. *Why:* this is the typed-question product path in one test; any wiring regression between the bridge events and the DOM breaks it first.
- **empty or whitespace input never reaches the bridge** — no askQuestion call, state stays idle. *Why:* main rejects whitespace with an error event; filtering in the form spares the user a pointless error flash.
- **events for a stale session change nothing** — partial/delta/done/error for a wrong session id leave transcript, answer, state and error box untouched. *Why:* the one-live-session model depends on the renderer dropping stragglers; a stale done would repaint a finished answer with an aborted one.
- **events arriving before askQuestion resolves are buffered until its session id is known** — Early events are held while the request id is pending, replayed in arrival order after adoption, and filtered by the adopted id. Fast completion must not lose answer text before the invoke response arrives.
- **a rejected askQuestion surfaces the error and retires the question** — the message shows, state returns to idle, and the entry keeps its question (regenerate offered, nothing to copy). *Why:* the typed question is user work; discarding it on an IPC hiccup would force retyping, but offering to copy a nonexistent answer would be a lie.
- **an ok:false askQuestion result shows the structured message and keeps the input** — the error code's message renders and the ask box retains the typed text. *Why:* the input is only cleared on acceptance; clearing on failure destroys the question the user needs to retry.
- **a session error mid-answer keeps the partial answer and shows the message** — after a delta, session:error retires the entry with its partial content, which stays copyable. *Why:* half an answer the user watched stream is worth keeping; vanishing it on error looks like data loss.
- **asking over a streaming answer supersedes it cleanly** — a second ask claims the view with a fresh entry, stragglers from the first session are dead, and the second answer completes. *Why:* "never mind, next question" is a core gesture; a zombie delta from the superseded session would corrupt the new answer.
- **the ask box is locked while capture spins up, and a locked submit is refused** — during 'starting' the input and button are disabled, a forced submit does not reach the bridge, and aborting re-enables them. *Why:* the disabled attribute can be bypassed (Enter from elsewhere); the handler's own guard is the real gate.

#### recording lifecycle

- **record → stop → answer drives the full UI cycle** — record shows Stop & Answer/recording dot/live tag/Listening…/locked ask box; a partial updates the transcript; stop calls stopSession and shows Finalizing; delta flips to answering and renders markdown; done lands the answer, latency tag, and unlocks. *Why:* the recorded path is the product; this is the one test that walks every state transition in order against the real markup.
- **audio frames buffer while the session opens, then flush in order** — frames posted before session:start resolves are held (meter still moving), then flushed to the adopted id in capture order before new frames stream directly. *Why:* the pre-warm design lets capture outrun the STT connect; out-of-order or dropped frames would garble the start of the question Deepgram hears.
- **a capture failure tears down the pre-warmed session and reports** — getDisplayMedia failing cancels the already-opened session, shows the error, and discards the empty entry. *Why:* Promise.all threw the session id away; without cancelStarted the Deepgram socket and its keepalive would leak for the life of the app.
- **a failed session start also stops the capture that came up** — an ok:false startSession stops the audio track and shows the structured message, with nothing to cancel. *Why:* the mirror leak — a live loopback capture with no session would keep the mic-style indicator on and burn the audio pipeline.
- **aborting a pending start cleans up when the capture finally arrives** — pressing Record again while getDisplayMedia hangs returns to idle immediately; when the capture later resolves, the stale run stops it and cancels its session without touching the UI. *Why:* proves the runId supersession token end to end — the loser tears itself down silently instead of resurrecting a recording the user cancelled.
- **a session error during recording discards the empty question** — socket death mid-recording shows the error, stops the capture, and leaves no blank history row. *Why:* the error must also stop the local audio pipeline — the meter runs on local frames, so without endCapture the window would look alive while recording into a dead socket.
- **a failing stopSession does not strand the UI in finalizing** — an ok:false stop lands the error and returns to idle. *Why:* every other exit from 'finalizing' is an event that will now never come; this is the only way out.

#### hotkey

- **the global hotkey toggles record and stop** — one press starts a session, the next stops it. *Why:* the hotkey is the primary control during a call, when the window deliberately doesn't have focus.
- **the hotkey is ignored while Settings is open** — no session starts while the settings view is visible; the same press works again after closing. *Why:* the shortcut is a plain key chord the user may type into the hotkey field itself; recording their settings edits would be absurd.

#### history

- **completed answers stack and prev/next walk them** — two answers show 2/2, prev shows the first Q/A with prev disabled, next returns. *Why:* the nav buttons' disabled states are the only affordance for "there is more"; off-by-one here reads as lost answers.
- **the seventh answer pushes the first out (MAX_HISTORY)** — after seven asks the label reads 6/6 and the oldest reachable question is Q2. *Why:* proves the cap through the real UI: the label, the trim, and the prev boundary all agree.
- **regenerate re-asks the question being viewed, not the newest one** — viewing Q1 of two and clicking regenerate asks Q1 and begins a new entry at 3/3. *Why:* re-asking the wrong question would silently answer something the user isn't looking at.
- **regenerate hides while a recording is in flight** — visible when idle with a question, hidden during recording, back after the error teardown. *Why:* a re-ask mid-recording would abort the recording the user is speaking into.
- **clear wipes history, announces it, and moves focus to Record** — both placeholders return, every tag/button hides, the SR region announces, and focus lands on Record. *Why:* the Clear button vanishes with its bar; stranded keyboard focus would drop to body and break the next Tab.
- **clear is refused while an answer is streaming** — the button is disabled and a forced click is a no-op until done re-enables it. *Why:* clearing mid-stream would delete the live entry the session events are about to write into.

#### copy

- **copies the markdown source, not the rendered text** — the clipboard receives `A **bold** claim` while the DOM shows "A bold claim", and the label/SR region confirm. *Why:* the rendered DOM loses bullets and fences on paste; the source survives in any editor.
- **is hidden until there is an answer to copy** — hidden at boot and while only a question exists; appears with the first streamed delta. *Why:* a copy button over an empty answer copies nothing and erodes trust in the control.
- **a clipboard failure surfaces in the error box** — a rejected writeText shows the fixed message. *Why:* clipboard access can fail silently in Electron; the user must know the paste they're about to do is empty.

#### style chips

- **clicking a chip persists it and reflects what main returned** — the click saves `{answerStyle:'brief'}` but the chips display the *different* style main returned. *Why:* main is the single source of truth (a concurrent settings save can win); reflecting the click would show a style that isn't stored.
- **a failed style save shows the error** — a rejected save lands in the main error box. *Why:* the chip handler is async fire-and-forget; without the catch the flip would silently not stick.

#### settings

- **opening populates the form from the live settings view** — every field, select, checkbox and hotkey placeholder fills from the view; saved keys show a "saved" placeholder with an empty value; focus moves to the heading. *Why:* keys are write-only across the bridge — the placeholder-not-value rule is the security contract this screen is built on.
- **Escape closes Settings and is inert on the main view** — Escape returns to the main view and focuses the gear button; a second Escape changes nothing. *Why:* Escape is a global document listener; without the visibility guard it would run its focus dance on every main-view Escape press.
- **the Back button closes too** — click returns to the main view. *Why:* the mouse path must match the keyboard path.
- **save sends the form and only the key fields that were typed** — the patch preserves reference text verbatim, trims the hotkey and typed key, and omits untouched key fields entirely; the form re-fills from the returned view and the main-view chips sync. *Why:* an empty key string in the patch *clears* the stored key — sending untouched fields would wipe credentials on every unrelated save.
- **a failed save reports in the settings-local error box** — the message lands in settingsError, the saved note stays hidden, the view stays open. *Why:* the main error box is on the hidden main view; reporting there is reporting to nobody.
- **a saved view that disables the hotkey re-arms the main-view hints** — saving `hotkey:''` hides the hint chip and drops the shortcut from the ready text. *Why:* the main view is repainted from the save's return value; a stale hint would advertise a shortcut that no longer fires.


## Context feature and reliability regression coverage

These cases extend the file-by-file baseline above. Each named test records
both the intended behavior and the regression it would expose.

### test/context.test.ts

- **legacy settings resolve to an Interview profile with existing material and length**: Old resume, job description, and answer length produce a valid Interview snapshot instead of disappearing during upgrade.
- **request preferences override scenario preferences which override defaults**: Explicit request choices take precedence over profile choices and global defaults; a lower-priority preference cannot silently win.
- **disabled references are excluded rather than merely discouraged in instructions**: Opted-out resume/job material is absent from the snapshot and cannot leak into a different scenario.
- **a missing explicitly requested profile fails instead of silently using another scenario**: A stale profile id produces an actionable failure rather than answering with an unrelated profile.
- **request snapshot remains independent of settings and overrides**: Later edits to references, instructions, output preferences, or the caller's overrides cannot mutate an already-submitted request.
- **original regeneration uses its snapshot after the profile is changed or deleted**: Regeneration remains reproducible and nested output/related-answer objects are independently cloned.
- **refinement overrides only requested fields and an explicit empty note clears the original note**: Refinement cannot overwrite unrelated choices, and an intentional empty note is distinguishable from no override.
- **follow-ups bound the selected excerpt without mutating the source**: Related questions and generated suggestions are limited to their shared budgets while the original history text remains intact.
- **templates and clones never share mutable output objects**: Editing one template or cloned snapshot cannot alter another profile or prior request.
- **oversized notes and unexpected privileged fields are rejected at IPC**: Oversized options and unknown fields such as credentials cannot cross the context boundary.
- **empty and duplicate profile lists are rejected**: Profile identity and a usable nonempty selection are enforced before persistence.
- **valid legacy reference limits remain accepted and new context fields are bounded**: Existing 200,000-character resume/job limits remain compatible while new fields enforce their smaller budgets.

### test/store.test.ts: profiles and credential state

- **legacy answer style changes target the active profile and preserve other profiles**: A compatibility style patch changes the selected profile, preventing an unrelated Interview profile from being overwritten.
- **migrates legacy references and style into an Interview profile without rewriting on read**: Legacy formatting and style survive migration; merely opening settings neither writes a file nor discards the original values.
- **round-trips saved profiles, selection, and output defaults through disk**: A cold reload preserves the entire saved scenario and its selected/default preferences.
- **recovers corrupt profile and output fields without losing valid siblings**: One malformed field falls back independently, valid sibling profiles survive, and an invalid active id selects a surviving profile.
- **recovers duplicate and excessive persisted profiles while preserving valid IDs**: User-edited files cannot introduce duplicate identities or exceed the profile count, without resetting every valid entry.
- **falls back to migrated Interview when no usable profile remains: %j**: Null, empty, invalid-id, and non-array profile values recover the legacy Interview profile and retain its references/style.
- **rejects duplicate IDs, empty lists, oversized fields, and missing active IDs before writing**: Invalid combined patches leave both disk and cached state unchanged.
- **profile arguments and returned nested settings never alias cached data**: Mutating supplied profiles, returned views, nested output choices, or defaults cannot change the store without a save.
- **failed nested profile updates preserve both memory and disk**: A failed atomic rename leaves the old profiles, selection, and defaults intact in memory and after restart.
- **empty, whitespace, and malformed stored credentials are not reported as usable**: Successfully decoding an unusable value must not turn on key-presence flags or encryption status.
- **reports plaintext fallback and mixed storage until plaintext keys are replaced**: The view distinguishes no usable credentials, plaintext fallback, mixed storage, and encrypted storage without exposing secrets.

### test/deepgram.test.ts: finalization failures

The revised timeout, failed-send, and already-closed tests in the original
Deepgram section require rejection rather than silent partial success.
Previously emitted transcript text remains visible for review; the session
must not automatically answer an incomplete transcription.

- **an abnormal close rejects with server details and no duplicate callback**: A non-1000 close during finalization rejects with its server reason, keeps previously emitted transcript text, and ignores subsequent errors and Results.
- **finalize consumes a queued error without replaying it to a later callback**: A pre-registration failure is delivered by the finalize rejection exactly once, not replayed again through onError.
- **a provider error during finalize rejects once and ignores post-abort events**: A Deepgram Error frame terminates the wait and suppresses later socket/close errors after abort.

### test/session.test.ts: captured context and terminal cleanup

- **recording captures context and provider before STT connects and reports that snapshot on completion**: Changes while the connection opens cannot replace the request's references, related answer, output preferences, or provider. Nested snapshots are frozen and completion reports the captured context.
- **typed asks snapshot notes before the deferred pipeline runs**: A note edited immediately after Ask cannot alter the deferred provider request.
- **malformed and oversized context cannot supersede a live recording**: Validation happens before cancellation; invalid context or an oversized typed question cannot kill valid audio work.
- **recorded transcript size is bounded before reaching the answer provider**: Oversized STT output fails before creating the LLM and tears down the stream instead of sending an unbounded prompt.
- **individually valid fields cannot exceed the combined request cap or supersede the active session**: The sum of references, context, selected history, and current question must fit the total request budget even when each field fits individually.
- **finalize rejection aborts the stream and emits exactly one error**: A timeout rejection closes STT resources, emits one structured failure, and releases the session instead of leaking a socket or generating an answer.
- **cancelling a provider that ignores abort removes timeout handles immediately**: Cancellation clears both deadline timers without waiting for a noncooperative provider or emitting a failure.
- **a synchronous provider failure removes timers and reports one terminal error**: A provider throwing before returning a promise still follows the same cleanup and structured-error contract.

### test/ipc.test.ts: context requests

- **captures saved context and provider at record time despite later settings changes**: Recording binds context and provider once; later settings edits cannot change provider selection, pre-warming, or completion metadata for that request.
- **regeneration uses original context even after the saved profile and output style change**: A supplied history snapshot is authoritative for regeneration instead of being merged with newer saved references.
- **explicit follow-up and refinement reach only their own request**: Selected history, refinement, and tone are forwarded for that request and are absent from the next independent ask.
- **invalid request options are actionable and leave the active recording intact**: Oversized notes/history, invalid preferences, missing profiles, malformed snapshots, and unexpected fields are rejected before live-session replacement.
- **validates profile arrays and output controls before persisting settings**: Empty, excessive, duplicate, or oversized profiles and invalid output enums never reach the store mutation.

### test/llm.test.ts: provider context parity

- **both providers send identical context instructions and bounded explicit follow-up data**: Mocked wire requests compare Anthropic's two system blocks with Groq's joined system message and compare their user messages exactly. Notes, refinements, and the selected prior suggestion remain outside the stable prefix; prior output is labeled as unconfirmed. A provider-specific adapter cannot drop or reinterpret explicit context.

### test/app.test.ts: explicit context and refinements

- **a draft applies immediately to the next ask and remains fixed while streaming**: Unsaved context edits affect the next submission, while later edits cannot alter its captured snapshot or history entry.
- **Record captures the context before capture or transcription resolves**: Context is bound at the gesture, preventing asynchronous audio startup from changing the question's scenario.
- **note survives failures and a newer note survives an older successful answer**: A failed request keeps the one-shot note; completion only clears the note revision actually submitted.
- **retyping the same note is still a new note and is retained**: Revision identity, rather than text equality, protects a newly entered note from an older completion.
- **original regeneration preserves its snapshot; current regeneration uses the draft**: The two explicit regeneration actions use their advertised source, even after profile edits.
- **followup sends only the explicitly selected bounded AI suggestion and does not become global memory**: Follow-up submits one selected excerpt and does not silently include unrelated history or persist it into future questions.
- **refinement and edit operate on the selected entry with its original context**: Shorter, more-specific, tone, and edit actions address the viewed question and preserve its snapshot rather than targeting the newest entry.
- **an early completion is replayed, stale events in the buffer are ignored**: Completion arriving before the invoke response is retained; buffered events belonging to another session cannot overwrite the adopted answer.
- **switching scenario picks safe inclusion defaults but preserves custom instructions**: Templates update resume/job inclusion appropriately without erasing authored instructions.
- **refinement controls stay collapsed after answering until the user opens them**: Native details keep secondary controls out of the answer's reading area until deliberately expanded.

### test/app.test.ts: profiles and key clearing

- **failed profile save retains the edited draft for retry and for the next question**: Persistence failure reports an error without discarding the text the user wrote or removing it from the next request.
- **profiles can be created, duplicated, renamed, switched and deleted**: The complete profile management flow keeps names, identities, selection, and save payloads consistent.
- **length chips change the active profile length without saving its unrelated draft edits**: A quick preference save cannot accidentally commit background/instruction drafts.
- **only explicitly selected keys are cleared; untouched keys stay absent from patch**: The clear controls generate deliberate empty-key patches; a blank password input still means leave the credential unchanged.

### test/app.test.ts: context lifecycle races

- **Ask, Record and hotkey wait for saved settings before taking a snapshot**: Startup cannot submit placeholder context with empty references while the real settings are still loading.
- **failed %s keeps visible profile and request context aligned**: New, Duplicate, and Delete failures keep the visible selection and actual request snapshot aligned; staged changes do not erase an existing draft.
- **a delayed length save targets its original profile after the selection changes**: An asynchronous save response cannot install an override on a different profile selected in the meantime.
- **active profile length wins in the chips and survives saving unrelated settings**: Boot and unrelated Settings saves cannot replace an explicit profile length with the legacy global default.
- **a failed follow-up can be retried without reselecting its source**: A transient failure preserves the explicitly selected prior suggestion for retry rather than silently turning the retry into an independent question.

### test/history.test.ts: snapshot ownership

- **history captures independent nested context snapshots**: Creating a history entry clones its output preferences and selected related answer. Mutating the original context or a later entry cannot rewrite the snapshot used to regenerate an earlier answer.

### Offline Electron UI smoke check

After `npm run build`, run `node scripts/ui-smoke.cjs`. This is a separate
integration check using the real compiled renderer and production preload in
hidden Electron windows with context isolation and sandboxing enabled. The
harness uses a temporary user-data directory and isolated fake IPC handlers;
no production settings or credentials are loaded. HTTP, HTTPS, WebSocket, and
secure WebSocket requests are blocked. Live audio and real providers are not
part of this check.

The harness checks the production bridge, context snapshot submission,
successful one-shot note clearing, Shorter refinement, explicit selected
follow-up, write-only key inputs, horizontal overflow, and renderer console
errors. It also asserts that the answer retains readable height and starts
within the minimum viewport. It captures `default-main.png` at 460x700 and `minimum-main.png`,
`minimum-context.png`, `minimum-answer.png`, and `minimum-settings.png` at
380x520 under `artifacts/ui-smoke/`. These screenshots support visual review;
the automatic assertions do not establish accessibility completeness, actual
screen-capture exclusion, real provider performance, or live transcription
quality.

---

## Practice-mode rework additions (2026-08-20)

The practice-mode conversion (mock-interview coaching prompt, mic/system audio
source, per-provider model picker, and per-answer usage/cost reporting) has
additional coverage documented here, grouped by file. The context-specific
prompt tests above supersede the older interview-only prompt assertions.

### test/sse.test.ts

- **surfaces the usage object from a final chunk** — `parseSSEChunk` returns `usage` alongside deltas. *Why:* the cost chip is fed from here; dropping the final chunk's accounting silently blanks it.
- **omits the usage key entirely when no chunk carried one** — key-absence, not `undefined`. *Why:* callers compare whole results; a phantom key breaks exact assertions and JSON round-trips.
- **reads Groq's x_groq mirror when the top-level usage is absent** — provider quirk cover. *Why:* Groq has shipped usage in both places across API versions.
- **the last usage seen wins when several chunks carry one** — later chunks are cumulative. *Why:* summing would double-count.
- **recovers usage from an unterminated tail line** — `parseSSETail` flushes usage exactly like it flushes the last delta. *Why:* the usage chunk is the *last* line, so it is the one most likely to arrive without a trailing newline.
- **a non-object usage value is ignored** — hostile/malformed payload guard. *Why:* the parser's contract is "never crash the stream".

### test/llm.test.ts

- **anthropic: the default model sends NO thinking parameter (Haiku predates it)** — Haiku 4.5 gets no `thinking` config. *Why:* Haiku never thinks unless asked; sending config it doesn't need risks 400s on API drift.
- **anthropic: a model override reaches the body and disables default-on thinking** — Sonnet 5 / Opus 5 get `thinking: {type: 'disabled'}`. *Why:* those models think *by default*, and unprompted thinking spends the stop-to-first-token budget this app exists to protect.
- **anthropic: reports usage with a cost estimate for a pinned-pricing model** — `onUsage` receives model, four token buckets, and a cost matching the pinned rates. *Why:* the whole model-comparison feature rests on these numbers being real.
- **groq: asks for usage accounting on the final chunk** — `stream_options.include_usage` is sent. *Why:* without it Groq reports nothing and the chip never shows.
- **groq: a non-reasoning model gets no reasoning params (it would reject them)** — the llama pick omits `reasoning_effort`/`include_reasoning`. *Why:* non-reasoning models reject those params; the picker must not brick a model choice.
- **groq: usage from the final chunk reaches onUsage — tokens only, no invented cost** — `estCostUsd` absent. *Why:* Groq pricing is deliberately not pinned; a guessed dollar figure is worse than none.
- **groq: a stream with no usage chunk simply never calls onUsage** — absence is not an error. *Why:* usage is best-effort telemetry; its absence must never fail an answer.

### test/session.test.ts

- **usage reported by the provider lands on the done metrics** — recorded-session path. *Why:* the chip renders from `metrics.usage`; a broken thread loses the feature invisibly.
- **ask() sessions carry usage too** — typed-question path. *Why:* Regenerate (the model-comparison gesture) goes through `ask()`.
- **a provider that reports no usage produces metrics WITHOUT a usage key** — key-absence pinned. *Why:* `usage: undefined` survives `toEqual` but breaks key-iterating consumers; the conditional spread in session.ts is deliberate.

### test/store.test.ts

- **new-install brevity agrees across legacy style, output defaults, and the Interview profile**: A new installation uses brief consistently; a migrated shared balanced default cannot override it silently.
- **migrating personalized settings preserves explicit style and global text beside scenario drafts**: Existing personalized text, explicit style, audio source, and model choices survive the addition and saving of scenario profiles.
- **upgrading keeps an explicitly saved answer style**: The new brief default does not rewrite existing balanced/detailed settings or lose saved credentials when personalization fields are introduced.
- **profile and custom instructions can be edited and cleared independently**: Clearing one global personalization field leaves the other intact across a reload.
- **invalid saved personalization fields do not discard other settings**: Malformed or oversized global fields fall back independently while valid references and style remain.
- **defaults: microphone source and the latency-first models** — new-install defaults. *Why:* the defaults ARE the product posture: practice partner in the room, fastest model.
- **a settings.json written before these fields existed falls back to the defaults** — v2.0 files load clean. *Why:* the rework must not brick an existing settings file (which also holds the encrypted keys).
- **patched values persist and reach getProfile** — round-trip through disk, and `getProfile` (which feeds provider construction) carries the model picks. *Why:* a picker that saves but doesn't reach the request is a silent lie.
- **a model no longer in the curated list falls back instead of failing the file** — per-field `catch` semantics extended to the new enums. *Why:* retiring a model from the list in a future version must cost the user one dropdown value, not their resume.

### test/format.test.ts

- **empty when the provider reported no usage** — chip hides itself. *Why:* an empty chip rendering `"undefined"` is the classic formatter failure.
- **shows dollars to four decimals when a cost estimate exists** / **four decimals keep sub-cent answers visible** — `$0.0030`, `$0.0004`. *Why:* two decimals would render every Haiku answer as `$0.00` and the comparison would teach nothing.
- **falls back to a token count when pricing is not pinned (Groq)** — `1500→300 tok`. *Why:* honest fallback, pinned format.
- **token fallback counts cached tokens as input** — cache reads/writes were real prompt tokens. *Why:* omitting them would understate counts if caching ever lands on that path.
- **title names the model and the in/out split** — hover breakdown. *Why:* the chip is the headline; the title is where the comparison data lives.
- **title mentions cache lines only when caching actually engaged** — zeros suppressed. *Why:* a wall of zeros buries the one number that matters (cache reads prove the prefix cache engaged — see README).
- **title explains an absent estimate instead of leaving a bare token count** — "pricing not pinned". *Why:* an unexplained missing dollar figure reads as a bug.

### test/pricing.test.ts

- **prices a typical Haiku answer (the default model) correctly** — 1500 in / 300 out = $0.003. *Why:* the README quotes this number; the code must agree with it.
- **scales with the model tier** — $1/$3/$5 per MTok input across Haiku/Sonnet/Opus. *Why:* the tier ratio is the entire point of the comparison feature.
- **output tokens are priced at the output rate** — 5x input on every tier. *Why:* swapping the rates is the likeliest single-character bug in a pricing table.
- **cache reads bill at 0.1x input and writes at 1.25x** — Anthropic's uniform multipliers. *Why:* cache economics justify the two-block prompt; wrong multipliers misreport the payoff.
- **all four buckets are summed — cache tokens are NOT inside inputTokens** — the API reports them separately. *Why:* double-counting or dropping either bucket skews every estimate silently.
- **returns undefined for a model whose pricing is not pinned** — Groq and unknown ids. *Why:* "never guess" is the module's contract; the UI's token fallback depends on it.
- **a zero-token answer costs exactly zero, not NaN** — degenerate input. *Why:* NaN in a template string renders `$NaN` in the chip.

## Personalization and Groq verification

Run `npm run test:smoke` to build and exercise the real Electron renderer,
preload bridge, IPC handlers, encrypted settings, session manager, and Groq SSE
provider together. The hidden window uses a temporary settings directory and
a deterministic replacement for fetch; no real API key, model request, or
microphone is used. The test covers settings save/reload, write-only keys,
initial answer streaming, depth and example buttons, branching from history,
token accounting, explicit one-shot follow-ups, independent fresh questions,
and preserving the concise default. The real provider request is asserted as
one system message and one user message with labeled JSON reference data;
prior generated answers are never promoted into trusted assistant-role history.
Chromium network requests are blocked in addition to replacing main-process
fetch. A screenshot is written to `out/smoke-answer.png`. The Node launcher
removes only its checked temporary directory under `out` after Electron exits,
so Windows releases Chromium cache handles before cleanup.

This verifies integration with simulated Groq responses. It does not verify
account access, live model output quality, or real service latency. A live check
requires saving a Groq key in Settings and asking a question.

The additional unit and DOM regressions cover:

- Personalization persistence, independent clearing, legacy-style preservation,
  and invalid saved fields without losing other settings.
- IPC validation for profile sizes, style choices, and bounded conversation turns.
- Per-request context snapshots and no context leakage into fresh questions or recordings.
- Original question retention plus the newest five turns in long follow-up chains.
- Both providers' personalized request bodies and temporary depth overrides.
- Groq streamed errors, empty responses, malformed deltas, and immediate completion
  on `[DONE]` even if the connection remains open.


## Merged personalization, model, and follow-up regressions

### test/context.test.ts

- **personalization and explicit conversation are captured without sharing later mutations**: Global profile text, instructions, and selected turns are deep-copied into the request and regeneration snapshot; a later independent request has no conversation.
- **explicit output override takes precedence over the compatible answerStyle option**: The newer per-request output override wins when both compatibility and current options specify length.
- **conversation and personalization enforce individual and combined request budgets**: Per-field limits and the overall context cap include global personalization and every selected turn, preventing otherwise valid fields from bypassing the total bound.

### test/prompt.test.ts

- **only interview scenarios include mock practice and Key beats coaching**: Interview practice guidance does not leak into technical, meeting, client, or custom scenarios.
- **personal profile stays reference data while custom instructions override coaching defaults**: Factual personal material is quoted separately from explicit behavior instructions; customization remains able to change default coaching presentation.
- **multi-turn context preserves order and explicit requests without asserting generated claims**: Ordered selected turns appear as labeled reference data, with prior generated claims treated as unconfirmed.
- **a selected related answer already present in explicit conversation is included once**: Compatibility related-answer and conversation fields do not duplicate the same prior suggestion in the prompt.

### test/session.test.ts

- **passes a snapshot of context and per-answer style without leaking into later questions**: Compatibility context and temporary detailed length reach only their intended request; later questions use their own settings.

### test/ipc.test.ts

- **captures model and global customization at record start despite settings edits**: Provider model and global personalization are fixed before asynchronous transcription, protecting an in-flight question from later Settings saves.
- **routes explicit multi-turn context and legacy answerStyle into a frozen snapshot**: Legacy options enter the same immutable, validated snapshot path as current request options.
- **rejects malformed conversation without replacing a live recording**: Empty, oversized, excessive, or malformed turns fail validation while the existing recording continues.
- **validates customization, audio source, and model settings before persistence**: Invalid personalization sizes, capture modes, and model ids cannot reach store writes.

### test/llm.test.ts

- **sends personalization and follow-up context while keeping style outside the cached prefix**: Anthropic receives global customization and explicit selected history without moving temporary length preferences into the stable cache block.
- **finishes on DONE without waiting for the server to close the connection**: Groq's completion marker releases the stream immediately, preventing an open connection from consuming the total-answer deadline.
- **gives a typed follow-up room for examples even when the saved style is brief**: Explicit follow-ups receive a sufficient bounded completion budget without changing the saved default.
- **maps a rate-limit event received after HTTP 200**: A streamed provider error preserves the rate-limit code instead of being mistaken for a successful or empty answer.
- **sends personalization and labeled conversation data for a detailed follow-up**: Groq forwards the selected global/profile context and ordered history in the same labeled-data contract as Anthropic.

### test/sse.test.ts

- **ignores non-string content instead of emitting objects as answer text**: Malformed delta values cannot become rendered answer text.
- **surfaces an SSE error after any preceding content and stops at the error**: Earlier partial output remains available, but a provider error ends processing and rejects the answer.
- **marks DONE and ignores any trailing content in the same chunk**: The terminal marker cannot be bypassed by extra data bytes that would append a late answer tail.
- **surfaces an error delivered without a trailing newline**: End-of-stream error frames are parsed from the buffered tail instead of being silently lost.

### test/app.test.ts

- **recording defaults to microphone and saved system source uses loopback instead**: New installs use microphone capture; explicit system capture selects loopback without opening the other source.
- **personalization and model settings load, save, snapshot and retain drafts on failure**: The selected provider enables its model control, global text and audio preferences save correctly, submitted snapshots contain personalization, and failed saves retain edits.
- **Go deeper and examples preserve selected context with temporary detailed length**: Actions use the viewed entry's context and ordered history with detailed output, while preserving the saved brief default and rejecting concurrent actions.
- **explicit followup chains retain anchor and recent turns and branch from the selected entry**: Bounded chains keep their originating question and recent turns, branch from the viewed answer, and do not leak into the next independent typed question.
- **failed partial answers cannot be selected as completed followup context**: An incomplete answer remains visible but cannot be treated as a completed source for depth/example/follow-up actions.
- **usage chip displays estimated cost or tokens honestly and follows history selection**: The chip shows pinned estimates when available, token-only fallback otherwise, and always matches the selected history entry.

- **%s does not replay the source one-question note or consume the next pending note**: Go deeper and Worked example clear the source snapshot's one-shot note while preserving a newly drafted note for the next independent question.
