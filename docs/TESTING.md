# Test Documentation

Every test in the suite, what it verifies, and why it exists. The suite runs
with `npm test` (vitest) — **379 tests across 10 files, no Electron and no
network required**. Electron APIs are mocked where needed (`store`), network
protocols are driven through fakes at the wire level (a mock WebSocket for
Deepgram, a stubbed `fetch` serving real SSE bytes for the LLM providers), and
DOM tests run under `happy-dom` via a per-file pragma.

Why this document exists: the app's one product promise is stop-to-first-word
latency, and almost every test below defends either that promise or one of the
invariants that make it safe to be fast — one live session at a time, stale
events dropped by session id, at most one error per stream, byte-stable prompt
prefixes for caching, and untrusted model output that can never become markup.
Each entry names the failure mode it guards, so a future change that breaks a
test can be judged against the reason the test was written.

| File | Tests | Covers |
|---|---|---|
| `test/session.test.ts` | 39 | Session manager: lifecycle, supersession, timeouts, metrics, the `ask()` path |
| `test/deepgram.test.ts` | 65 | Deepgram WS client: connect races, buffering, keepalive, finalize, error contract |
| `test/pcm.test.ts` | 21 | PCM helpers: downsampling, Int16 conversion, RMS |
| `test/llm.test.ts` | 42 | Both LLM providers: streaming, caching layout, retries, full error-mapping matrix |
| `test/sse.test.ts` | 26 | OpenAI-style SSE parser: chunk reassembly, tail flush, hostile payloads |
| `test/prompt.test.ts` | 24 | Prompt builders: content, style handling, cache-prefix byte-stability |
| `test/warm.test.ts` | 16 | LLM connection pre-warm: URLs, throttling, never-throws, pooling |
| `test/markdown.test.ts` | 81 | Markdown parser + streaming DOM view: correctness, DOM reuse, XSS defence |
| `test/store.test.ts` | 32 | Settings store: validation, secrets encryption, patch semantics, atomic writes |
| `test/format.test.ts` | 33 | Renderer display helpers: accelerator labels, timer, errors, latency strings |

---

### test/session.test.ts

The session manager is the orchestrator: one live question/answer pipeline, injected STT/LLM dependencies, timeouts, and metrics. These tests run without Electron or the network.

#### SessionManager (core lifecycle)

- **happy path: audio routed, transcript finalized, answer streamed** — start → audio → stop produces the full event sequence: final `partial` with the transcript, `delta` with the answer, `done` last with transcript+answer. *Why:* this is the product's entire recorded-question pipeline in one assertion; any wiring regression breaks it first.
- **starting a new session aborts the previous one** — a second `start()` returns a higher id, aborts the first STT stream, and drops audio addressed to the stale id. *Why:* "record again while an answer is streaming" is a supported gesture; a leaked socket or misrouted audio would corrupt the new session.
- **an empty transcript reports no_speech** — a whitespace-only finalize surfaces `no_speech` instead of sending an empty prompt to the LLM. *Why:* the user gets an actionable error ("make sure call audio is playing") rather than a hallucinated answer to silence.
- **LLM first-token timeout produces a structured error and aborts** — a provider slower than `llmFirstTokenMs` yields `llm_first_token_timeout`. *Why:* the app's promise is fast first words; a hung provider must fail loudly and quickly, not hold the UI in "Answering…".
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
- **an error queued before wiring is delivered, not dropped** — an error delivered synchronously during `onError` registration (socket died between connect and wiring) still tears down and reports. *Why:* DeepgramStream queues pre-registration errors; losing one leaves the user recording into a dead socket.
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

#### toAppError

- **passes structured errors through** — an `AppError` survives untouched. *Why:* provider code throws deliberate `{code, message}` pairs; re-wrapping would erase the code the renderer keys its messaging on.
- **wraps plain errors with the fallback code** — a bare `Error` becomes `{code: fallback, message}`. *Why:* unexpected throws must still produce a renderer-safe structured error instead of leaking raw exceptions.

### test/deepgram.test.ts

`DeepgramStream` is the WebSocket STT client: connect race, pre-open buffering, keepalive, the CloseStream flush on Stop, and a one-error-per-stream reporting contract. These tests drive it with a mock WebSocket — no network.

#### parseDeepgramMessage

- **extracts an interim transcript** — a `Results` frame with `is_final: false` decodes to `{ transcript, isFinal: false }`. *Why:* interims are what make the transcript render live while the other person is still speaking.
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

#### DeepgramStream.connect

- **passes the API key as a subprotocol and asks for arraybuffers** — the socket is constructed with `['token', key]`, `binaryType = 'arraybuffer'`, and the nova-3 URL; connect resolves on open. *Why:* the subprotocol is the only auth the browser-style WebSocket API can carry; getting it wrong is a silent 401-by-close.
- **rejects with stt_connect when the socket errors before open** — `onerror` before open rejects the connect promise. *Why:* regression guard — a failure before open must fail `connect()`, not queue a mid-stream error nobody is listening for yet.
- **rejects with stt_connect when the connect times out** — no open within the budget rejects and closes the socket. *Why:* `connect()` must never hang; the session's stop-to-first-word budget starts from a bounded connect.
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
- **ignores a socket error that arrives after the stream is already over** — an `onerror` firing after finalize's timeout teardown emits nothing. *Why:* guards a fixed bug — a TCP reset on a socket we already dropped is stale news, not a new failure to toast after the answer is already streaming.
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

- **sends CloseStream and resolves with the full transcript once the server closes** — the happy path: `CloseStream` out, server close in, transcript returned. *Why:* this handshake is the stop-to-first-word critical path.
- **includes a trailing interim segment that never got finalized** — a dangling interim is part of the returned transcript. *Why:* the last words before Stop are usually still interim; dropping them cuts off the end of the question.
- **counts a tail Results frame that lands between CloseStream and the close** — a final arriving during the close wait is included. *Why:* the entire point of `CloseStream` is that flush; guards the teardown-gating fix from over-suppressing (`closed`, not `closeRequested`).
- **drops audio sent after finalize has asked for the close** — a straggler frame after `CloseStream` is not sent and a poisoned socket raises no error. *Why:* guards a fixed bug — the socket is CLOSING, the frame can't influence the transcript, and a throw here reported a bogus mid-recording error during a successful stop.
- **abort() during the close wait settles finalize at once with what was heard** — abort mid-wait resolves the pending finalize immediately, silently, leaving no timers. *Why:* re-record races stop; nobody will ever emit the close that finalize is waiting for.
- **resolves at once when the socket is not open, without burning the timeout** — a not-open socket returns the buffered transcript with zero timer advance and releases the socket. *Why:* waiting on a socket that can't answer would burn the whole 5 s budget straight onto stop-to-first-word.
- **ignores frames that arrive after the finalize timeout tore the stream down** — post-teardown Results fire no partials and a repeat finalize returns the identical string. *Why:* guards a fixed bug — a late frame growing the transcript after finalize resolved would contradict the answer being generated from it.
- **an empty final leaves no gap in the joined transcript** — finals around an empty final join with single spaces. *Why:* empty finals must not become empty list entries that double-space the joined text.
- **a whitespace-only trailing interim resolves to a trimmed transcript** — a `'   '` interim contributes nothing to the result. *Why:* `filter(Boolean)` keeps whitespace-truthy strings; the trailing trim is what keeps them out of the LLM prompt.
- **does not report the close it asked for as an error** — the close following `CloseStream` emits no error. *Why:* the requested close is success; reporting it would toast an error on every normal stop.
- **settles within the timeout when the server never closes** — a mute server resolves finalize at the deadline with everything heard, clears all timers, drops the socket. *Why:* the hard contract — finalize ALWAYS settles within `timeoutMs`.
- **returns at once when the CloseStream send throws** — a dead socket at finalize time resolves immediately without any timer. *Why:* waiting on a socket we already know is dead burned the entire 5 s budget to return the same string.
- **returns at once after abort(), without sending CloseStream** — finalize on an aborted stream resolves instantly and sends nothing. *Why:* an aborted stream has no server to talk to; a `CloseStream` there would throw or leak.
- **returns the best transcript available after a mid-stream error** — finalize after a socket error resolves immediately with what was captured. *Why:* half a question is still a usable prompt; the error path must not also destroy the transcript.
- **resolves without waiting when the socket already closed** — finalize after the server closed resolves at once. *Why:* the close waiter must short-circuit when there is no close left to wait for.
- **is idempotent: a second call joins the first and sends one CloseStream** — both calls return the same promise, same string, one control frame. *Why:* hotkey mashing double-finalizes; a second `CloseStream` or second wait would corrupt the handshake.
- **returns an empty transcript rather than hanging when nothing was heard** — silence resolves to `''`. *Why:* the session decides what to do with an empty question; finalize just must not hang on it.

#### DeepgramStream keepalive

- **pings Deepgram while the socket is idle** — a `KeepAlive` frame goes out at the 8 s tick. *Why:* Deepgram closes idle sockets (NET-0001) about 10 s after the last audio; long pauses in speech must not kill the stream.
- **stops after abort() and leaves no timer behind** — no frames and zero timers after abort. *Why:* a leaked interval pings a dead socket forever and keeps the process warm.
- **stops when the socket closes unexpectedly** — an unrequested close stops the pinger. *Why:* the interval must die with the socket, not throw once per tick into the error path.
- **sends no KeepAlive once finalize has asked for the close** — after `CloseStream`, the 8 s tick sends nothing. *Why:* guards a fixed bug — a `KeepAlive` after `CloseStream` is at best ignored and at worst throws on the CLOSING socket mid-flush.
- **a socket dying during the close wait does not surface a spurious error** — a poisoned socket during the finalize wait produces no error; finalize still resolves with the transcript and no timers leak. *Why:* guards a fixed bug — the user pressed Stop and the stop is succeeding; a "lost connection" toast here is false-alarm noise at the exact moment of success.
- **a keepalive send failure surfaces as stt_error and stops the interval** — a throwing keepalive send mid-recording emits one error and clears the timer. *Why:* mid-recording (before any close was requested) a failed ping is the first sign the socket died; it must be reported once and the interval must not keep throwing.

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
- **sends the resume+JD as a cached block and the style as a separate uncached block** — inspects the request body: `system` has exactly two blocks, only the first carries `cache_control: {type:'ephemeral'}`, and the model is `claude-haiku-4-5`. *Why:* the whole caching design is a prefix match split at the resume+JD boundary; a `cache_control` on the style block would make toggling brief/balanced/detailed bust the cache.

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
- **does not retry an HTTP error — that would burn the first-token budget** — a 429 response yields exactly 1 call. *Why:* an HTTP status means the server heard us; an instant identical retry can only waste the stop-to-first-word window.
- **never retries after a delta reached the panel, which would duplicate the answer** — a stream that emits `'half'` then dies yields 1 call and `['half']`, not `['half','half']`. *Why:* the renderer appends deltas; a post-stream retry would concatenate two answers.

#### groq provider

- **streams deltas and returns the concatenation** — OpenAI-style SSE lines produce ordered deltas and a matching return value. *Why:* same panel/history consistency contract as the Anthropic provider.
- **does not drop the last delta when the stream ends without a trailing newline** — a truncated final `data:` line is recovered by the tail flush. *Why:* regression pin — without `parseSSETail` the last few words of an answer were silently lost.
- **pins the model to a non-deprecated id and suppresses reasoning for latency** — asserts `openai/gpt-oss-120b` (explicitly not the shut-down `llama-3.3-70b-versatile`), `reasoning_effort: 'low'`, `include_reasoning: false`, `stream: true`. *Why:* gpt-oss is a reasoning model; left alone it thinks before speaking, spending the entire first-token budget on an empty panel.
- **caps the completion length so a runaway answer cannot stream forever** — asserts `max_completion_tokens: 1024` in the request body. *Why:* parity with Anthropic's `MAX_TOKENS`; spoken answers are short and an uncapped completion is pure tail latency.
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

#### end-to-end chunking

- **byte-at-a-time delivery produces the same deltas as one big chunk** — the same body drained at chunk size 1 and at full size yields identical output. *Why:* chunk boundaries are network noise; parser output must be a pure function of the byte stream.
- **multi-byte characters split across chunk boundaries are not corrupted** — non-ASCII content survives 3-byte chunking through line reassembly. *Why:* pins the parser half of UTF-8 safety (the decoder half lives in groq.ts and is tested in llm.test.ts).

### test/prompt.test.ts

The prompt builders are pure functions, and the split between cached prefix and style suffix is the app's prompt-caching contract — several tests pin byte-level properties the cache depends on.

#### buildSystemPrompt

- **always states the assistant role and first-person instruction** — the role and "first person" phrasing are present regardless of profile. *Why:* the model must answer as the user; losing this instruction changes the product.
- **omits resume/JD sections and grounding clause when profile is empty** — no section headers and no grounding line for an empty profile. *Why:* empty sections would waste prefix tokens and instruct the model to ground answers in nothing.
- **embeds the resume when provided** — the resume header, content, and grounding clause appear. *Why:* the resume is the substance of every answer; silently dropping it would produce generic answers with no error.
- **embeds the job description when provided** — the JD header and content appear. *Why:* same as the resume, for the target role.
- **includes both sections and the grounding clause when both are set** — full profile renders fully, including the anti-hallucination line. *Why:* "Never invent experience" is the guard against the model fabricating a career.
- **trims whitespace-only input so it counts as empty** — whitespace resume/JD behave as absent. *Why:* a textarea full of spaces must not smuggle empty sections plus a grounding clause into the prompt.
- **is the cached prefix followed by the style suffix** — the single-string prompt starts with `cachedPrefix` and ends with `styleSuffix`. *Why:* both providers must agree on prompt content, differing only in block structure.
- **is exactly cachedPrefix + blank line + styleSuffix for every style** — byte-exact equality with `cachedPrefix + '\n\n' + styleSuffix` across all three styles. *Why:* startsWith/endsWith would tolerate injected bytes between the blocks, which would make the Groq (single-string) and Anthropic (two-block) prompts silently diverge.
- **resume-only profile omits the JD section but keeps the grounding clause** — one section present, the other absent, grounding retained. *Why:* the grounding line is gated on *either* field; this pins the resume-only leg.
- **JD-only profile omits the resume section but keeps the grounding clause** — mirror of the above. *Why:* pins the JD-only leg of the same gate.

#### answerStyle

- **balanced keeps v1 wording, so the default behaviour is unchanged** — the balanced instruction matches v1 verbatim. *Why:* the style feature was introduced with a compatibility promise; rewording "balanced" would change default answers.
- **brief asks for one or two spoken sentences** — brief wording present, balanced wording absent. *Why:* each style must actually swap the instruction, not append to it.
- **detailed asks for structured supporting points** — detailed wording present, balanced absent. *Why:* same, for the third style.
- **every style produces a distinct, non-empty instruction** — three styles, three distinct non-empty suffixes. *Why:* two styles collapsing to the same text would make the setting a lie.
- **an unknown style falls back to balanced instead of splicing in undefined** — a corrupt style value yields the balanced prompt with no "undefined" in it. *Why:* a stale settings file must degrade to the default, not inject the string `undefined` into a live prompt.
- **changing the style does not change the cached prefix** — all three styles produce one identical `cachedPrefix` for the same resume/JD. *Why:* the caching invariant this app's latency story depends on — prompt caching is a prefix match, so a style-dependent prefix would mean every toggle throws away the cached resume+JD and pays a full uncached prefill.
- **the cached prefix is byte-identical across styles for an empty profile too** — same invariant with no resume/JD. *Why:* the empty-profile branch takes a different code path through the builders; the invariant must hold there as well.
- **an unknown style still leaves the cached prefix untouched** — the fallback affects only the suffix; prefix and suffix both equal the balanced output. *Why:* if the fallback ever leaked into the prefix, a corrupt settings file would silently invalidate the cache.
- **the style instruction is not duplicated into the cached prefix** — the suffix text does not appear inside the prefix. *Why:* duplication would burn prefix tokens and let a stale cached style contradict the live one.
- **the resume and JD stay in the cached prefix, not the style suffix** — profile content is only in the prefix; the suffix carries none of it. *Why:* profile text in the suffix would be re-billed uncached on every request, defeating the split.

#### buildUserMessage

- **wraps the transcript and asks what to say** — the transcript is embedded and the closing question present. *Why:* the basic user-turn contract.
- **produces the exact wrapping format** — byte-exact equality with `'The other person on the call just said:\n"""\n' + transcript + '\n"""\n\nWhat should I say?'`. *Why:* the user turn ships with every request; silent wording drift would change token counts and model behaviour with no failing test.
- **passes the transcript through verbatim, including newlines and quotes** — a multi-line transcript with quote characters survives unescaped. *Why:* the wrapper must never mangle what the interviewer actually said.
- **does not carry the answer style, so the user turn stays cache-neutral** — no style vocabulary in the user message. *Why:* style leaking into the user turn would bypass the carefully placed cache breakpoint.

### test/warm.test.ts

`warmLlmConnection` pre-warms the HTTPS connection to the active LLM provider so the answer request that fires on Stop reuses a pooled TCP+TLS connection instead of paying the handshake inside the stop-to-first-word window. All tests run under `vi.useFakeTimers()` + `vi.setSystemTime()` because the throttle is `Date.now()`-based, and inject a fetch double via the `fetchFn` parameter — no network, no global-fetch dependence.

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
- **a key copied from another machine is treated as unset, not a crash** — an undecryptable `enc:` blob reads as `''` without throwing, while `hasKey` stays `true`. *Why:* DPAPI blobs are machine-bound; documents the deliberate asymmetry — Settings shows a key to *replace* rather than pretending the slot is empty.
- **an unrecognized storage prefix reads as unset instead of leaking the raw value** — an unknown format returns `''` (flag still `true`). *Why:* a future or corrupted format must fail closed, never hand the raw stored string to a provider.
- **no plaintext and no ciphertext ever appears in the renderer view** — with all three keys set, the serialized view contains no plaintext, no `enc:`/`plain:` blob, and no `secrets` field at all. *Why:* the strongest form of the write-only guarantee, checked against the exact object the renderer receives.
- **falls back to marked plaintext when the OS keystore is unavailable** — with encryption unavailable, the stored value carries the `plain:` marker and still round-trips. *Why:* the degraded path must stay functional and honestly labeled, so real encryption is distinguishable on disk.

#### store patch semantics

- **an empty patch changes nothing** — `applySettingsPatch({})` returns a view equal to the current one and leaves secrets intact. *Why:* the settings dialog saves whole patches; untouched fields must be genuine no-ops.
- **undefined fields are left untouched; only named fields change** — patching `resume` alone leaves jobDescription, answerStyle, and keys as they were. *Why:* undefined-means-skip is the core patch contract; a regression would wipe fields on every save.
- **resume and job description are stored verbatim, not trimmed** — leading/trailing whitespace and newlines survive a reload. *Why:* documents the deliberate contrast with hotkey/keys — profile formatting belongs to the user.
- **an empty string is a real value for plain fields, not a clear** — setting `resume: ''` persists an empty resume. *Why:* only key fields use empty-string-as-delete; plain fields must not inherit that semantic.

#### store answerStyle and hotkey

- **default to balanced and the shared DEFAULT_HOTKEY** — first-run values come from the shared constants. *Why:* the renderer and main both import `DEFAULT_HOTKEY`; the store must agree with it, not restate it.
- **persist across a reload** — `brief` + a custom hotkey survive a cache reset, with the hotkey trimmed. *Why:* covers the trim on save plus the disk round-trip for both fields, including `getProfile()`/`getHotkey()` consumers.
- **an empty hotkey means "disabled" and must not spring back to the default** — `''` persists as `''`. *Why:* "no global shortcut" is a real user choice; a fallback-to-default here would re-register a hotkey the user removed.

#### store hotkeyRegistered

- **reports the live registration state and is never persisted** — the flag follows `setHotkeyRegistered(true/false)` and never appears in settings.json. *Why:* registration is a fact about this run (another app may own the accelerator today); persisting it would lie after a reboot.
- **resetCacheForTests drops the flag along with the cache** — after a reset, the view reports `false` again. *Why:* the test seam must model a fresh process, or later tests would inherit stale registration state.

#### store persistence

- **a failed write does not leave the cache diverged from disk** — when `renameSync` throws, the patch throws, and both memory and disk still hold the previous value. *Why:* regression for the fixed mutate-before-persist gap where a disk-full save left the app claiming a value the next launch silently lost.
- **writes atomically and leaves no partial file behind** — after a save, no `.tmp` remains and the file parses with the new value. *Why:* the observable outcome of write-then-rename in the normal case.
- **persists by writing a tmp file first and renaming it over settings.json** — fs spies confirm exactly one write, to `settings.json.tmp`, followed (in order) by the rename onto the real path. *Why:* pins the mechanism itself — a refactor to a direct write would pass the outcome test but reintroduce torn-file risk on crash.
- **reading settings never creates the file — only a save does** — pure reads leave no settings.json; the first patch creates it. *Why:* read paths must stay side-effect-free, so a browse-only launch touches nothing on disk.
- **creates the userData directory on first save** — saving into a not-yet-existing nested userData path succeeds. *Why:* on a true first run the directory may not exist; persist must create it rather than throw.

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

#### formatTimer

- **0 seconds is 00:00** — both fields are zero-padded from the first tick. *Why:* the timer's very first paint sets the visual shape; `0:0` would jitter the layout.
- **59 seconds is 00:59** — the seconds field fills without rolling over. *Why:* verifies the modulo boundary just before a minute completes.
- **60 seconds rolls over to 01:00** — seconds reset and minutes increment. *Why:* the classic off-by-one spot for mm:ss math.
- **605 seconds is 10:05 (both halves zero-padded)** — a mid-range value pads the seconds beside two-digit minutes. *Why:* exercises padding on both fields at once, not just one.
- **last second before the hour is 59:59** — the largest two-digit-minutes value renders correctly. *Why:* pins the upper edge of the normal display range.
- **large values let the minutes field grow past two digits** — 3600 → `60:00`, 7325 → `122:05`. *Why:* documents that minutes expand rather than wrap; the recording cap makes this unreachable today, but the helper must not silently corrupt if the cap changes.

#### errorMessage

- **AppError-shaped object yields its message** — a `{code, message}` structured error surfaces just its message. *Why:* this is the shape every session error crosses IPC in; the code is internal, the message is for the user.
- **plain Error yields its message** — a thrown `Error` shows its message, not its stringified form. *Why:* renderer-side throws (clipboard, capture) must read cleanly, without a `Error:` prefix.
- **non-string message property is coerced to a string** — `{message: 42}` → `'42'`. *Why:* the guard checks for the key's presence, not its type; coercion must stay total.
- **string passes through unchanged** — a plain string message displays as-is. *Why:* some call sites pass literal strings to `showError` directly.
- **number is stringified** — `500` → `'500'`. *Why:* anything can be thrown in JS; the error box must render something rather than crash.
- **null and undefined stringify rather than throw** — `'null'` / `'undefined'` come back safely. *Why:* the leading truthiness check exists precisely so `'message' in null` never executes; this pins that.
- **object without a message field falls back to String()** — `{code: 'internal'}` → `'[object Object]'`. *Why:* documents the current fallback for malformed errors so any future change to it is deliberate.

#### latencyLabel

- **1234 ms rounds to "1.2s to first word"** — the headline number truncates to one decimal via `toFixed`. *Why:* this is the product's core metric string; its exact wording and rounding are load-bearing.
- **rounds up when the hundredths carry (1270 ms → 1.3s)** — `toFixed(1)` rounds rather than floors. *Why:* proves the label rounds to nearest instead of always down.
- **sub-100ms values keep one decimal (0 ms → 0.0s)** — the shape is stable even at zero. *Why:* a bare `0s` would look broken next to every other reading.
- **1999 ms rounds to a whole "2.0s"** — values just under a boundary round up and keep the trailing `.0`. *Why:* fixed-width output keeps the tag from shifting the panel header between answers.
- **double-digit seconds keep the same shape (12340 ms → 12.3s)** — slow answers format identically. *Why:* timeout-adjacent answers still need an honest, correctly formatted readout.

#### latencyTitle

- **mixes rounded ms for the stages with one-decimal seconds for the total** — fractional inputs produce `First word 1235 ms after Stop · transcript finalized 480 ms · full answer 5.7 s`. *Why:* pins the full hover-breakdown template — separator, unit spacing, `Math.round` on the ms stages, and `toFixed(1)` on the total — byte for byte.
- **integer inputs render without decimals in the ms fields** — whole-number metrics pass through `Math.round` unchanged and the total still shows `.0`. *Why:* the common real-world case; guards against accidental decimal formatting on ms values.
- **a typed question (sttFinalizeMs = 0) reads "finalized 0 ms"** — the ask-flow contract (`sttFinalizeMs: 0`) renders a plain `0 ms`. *Why:* every Ask-box answer will carry this exact value, so its rendering is now a fixed part of the UI.
