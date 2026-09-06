import {
  ANTHROPIC_MODELS,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_GROQ_MODEL,
  DEFAULT_HOTKEY,
  GROQ_MODELS,
} from '../shared/types';
import type {
  AnswerMetrics,
  AnswerStyle,
  AskOptions,
  AnthropicModelId,
  AudioSource,
  ConversationTurn,
  GroqModelId,
  LlmProviderId,
  RendererApi,
  Result,
  SettingsPatch,
  SettingsView,
} from '../shared/types';
import {
  costLabel,
  costTitle,
  errorMessage,
  formatAccelerator,
  formatTimer,
  latencyLabel,
  latencyTitle,
} from './format';
import { createMarkdownView } from './markdown';

declare global {
  interface Window {
    api: RendererApi;
  }
}

const api = window.api;

// ---------- Elements ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const recordBtn = $<HTMLButtonElement>('recordBtn');
const recordLabel = $('recordLabel');
const hotkeyHint = $('hotkeyHint');
const hotkeyWarn = $('hotkeyWarn');
const statusText = $('statusText');
const statusDot = $('statusDot');
const timerEl = $('timer');
const meterFill = $('meterFill');
const transcriptBox = $('transcriptBox');
const answerBox = $('answerBox');
const errorBox = $('errorBox');
const settingsError = $('settingsError');
const liveTag = $('liveTag');
const genTag = $('genTag');
const latencyTag = $('latencyTag');
const costTag = $('costTag');
const copyBtn = $<HTMLButtonElement>('copyBtn');
const copyLabel = $('copyLabel');
const historyBar = $('historyBar');
const historyLabel = $('historyLabel');
const prevBtn = $<HTMLButtonElement>('prevBtn');
const nextBtn = $<HTMLButtonElement>('nextBtn');
const clearBtn = $<HTMLButtonElement>('clearBtn');
const regenBtn = $<HTMLButtonElement>('regenBtn');
const askForm = $<HTMLFormElement>('askForm');
const askInput = $<HTMLInputElement>('askInput');
const askBtn = $<HTMLButtonElement>('askBtn');
const newQuestionBtn = $<HTMLButtonElement>('newQuestionBtn');
const followupModeBtn = $<HTMLButtonElement>('followupModeBtn');
const askModeHint = $('askModeHint');
const deeperBtn = $<HTMLButtonElement>('deeperBtn');
const exampleBtn = $<HTMLButtonElement>('exampleBtn');
const srAnnounce = $('srAnnounce');
const mainView = $('mainView');
const settingsView = $('settingsView');
const settingsBtn = $<HTMLButtonElement>('settingsBtn');
const settingsHeading = $('settingsHeading');

const MAX_SECONDS = 120; // safety cap per clip
const MAX_HISTORY = 6; // Q/A pairs kept in memory
const MAX_PENDING_FRAMES = 120; // ~15 s of audio buffered while the session opens
const BASE_READY_TEXT = 'Ready — press Record while your practice partner asks a question';
const ANSWER_PLACEHOLDER = 'The model answer to practise against will stream here.';
const TRANSCRIPT_PLACEHOLDER = 'The live transcript will appear here while you record.';

const answerView = createMarkdownView(answerBox);

// ---------- State ----------
// 'starting' exists so a stop pressed while the session/capture is still coming
// up is honoured instead of silently dropped.
type State = 'idle' | 'starting' | 'recording' | 'finalizing' | 'answering';
let state: State = 'idle';
let sessionId: number | null = null;
let capture: Capture | null = null;
// Bumped by every start and by every abort; an in-flight start whose token is
// stale must tear itself down instead of touching the UI or the live session.
let runId = 0;
let recordStart = 0;
let timerInterval: ReturnType<typeof setInterval> | null = null;
let hotkeyLabel = '';
let hotkeyActive = false;
// Mirrors the saved setting; startCapture reads it at record time, so a save
// in Settings applies to the very next recording without a restart.
let audioSource: AudioSource = 'microphone';

interface Entry {
  question: string;
  answer: string;
  metrics: AnswerMetrics | null;
  live: boolean;
  completed: boolean;
  context: ConversationTurn[];
  answerStyle?: AnswerStyle;
}
let entries: Entry[] = [];
let viewIndex = -1;
let followupMode = false;

const readyText = (): string =>
  hotkeyActive ? `Ready — press Record or ${hotkeyLabel}` : BASE_READY_TEXT;

// ---------- Capture ----------
interface Capture {
  stop(): void;
}

/**
 * Opens the configured audio source (microphone by default, system-audio
 * loopback for the 'system' setting) and streams Int16 frames to `onFrame`.
 * The caller owns the returned handle: each recording run stops its own
 * capture, so a run that loses a race can never stop the capture of the run
 * that replaced it.
 */
async function startCapture(onFrame: (pcm: ArrayBuffer, rms: number) => void): Promise<Capture> {
  let stream: MediaStream;
  if (audioSource === 'system') {
    // getDisplayMedia is routed to system-audio loopback by the main process.
    // Prefer audio-only; fall back to the discarded-video workaround if the
    // Electron version insists on a video track.
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: false, audio: true } as MediaStreamConstraints);
    } catch {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      stream.getVideoTracks().forEach((t) => t.stop());
    }
  } else {
    // Practice-partner-in-the-room default. Echo cancellation and noise
    // suppression stay on: the partner's voice is the signal, and any audio
    // this PC plays (including a re-read of an earlier answer) is noise.
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      // First-run mic failures are exactly where a specific hint pays off:
      // "permission denied" and "no device" send the user to different places.
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError') {
        throw new Error(
          'Microphone access is blocked. Allow it in Windows Settings > Privacy & security > Microphone, then try again.',
        );
      }
      if (name === 'NotFoundError') {
        throw new Error('No microphone found. Plug one in, or pick a different input device in Windows sound settings.');
      }
      throw new Error(
        'Could not open the microphone. Check Windows microphone permissions for this app, or switch the audio source in Settings.',
      );
    }
  }

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error(
      audioSource === 'system'
        ? 'Could not capture system audio. Make sure audio is playing on this PC.'
        : 'The microphone opened but produced no audio track. Check the input device in Windows sound settings.',
    );
  }

  // Ask Chromium to resample to 16 kHz for us; the worklet downsamples itself
  // if the context ends up at a different rate.
  let audioCtx: AudioContext;
  try {
    audioCtx = new AudioContext({ sampleRate: 16000 });
  } catch {
    audioCtx = new AudioContext();
  }

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    audioCtx.close().catch(() => {});
    stream.getTracks().forEach((t) => t.stop());
  };

  try {
    await audioCtx.audioWorklet.addModule('./pcm-worklet.js');
    const source = audioCtx.createMediaStreamSource(new MediaStream(audioTracks));
    const worklet = new AudioWorkletNode(audioCtx, 'pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });
    // `stopped` gates stragglers: a frame posted just before close() must not be
    // attributed to whatever session is current by the time it is delivered.
    worklet.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
      if (!stopped) onFrame(e.data.pcm, e.data.rms);
    };
    source.connect(worklet);
  } catch (err) {
    stop();
    throw err;
  }

  return { stop };
}

function endCapture(): void {
  capture?.stop();
  capture = null;
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  timerEl.textContent = '';
  meterFill.style.width = '0%';
}

/**
 * Tears down a session that opened while another part of startup failed.
 * Promise.all discards the resolved value of the other promise when one
 * rejects, so the session id has to be recovered from its own promise or the
 * Deepgram socket and its keepalive leak for the life of the app.
 */
async function cancelStarted(p: Promise<Result<number>>): Promise<void> {
  try {
    const r = await p;
    if (r.ok) await api.cancelSession(r.value);
  } catch {
    // startSession itself failed — there is nothing to cancel.
  }
}

/** Mirror of cancelStarted: stop a capture that came up after startup already failed. */
async function stopPending(p: Promise<Capture>): Promise<void> {
  try {
    (await p).stop();
  } catch {
    // capture never came up — nothing to stop.
  }
}

// ---------- Recording lifecycle ----------
async function startRecording(): Promise<void> {
  const myRun = ++runId;
  clearError();
  sessionId = null;
  followupMode = false;
  beginLiveEntry();
  setState('starting');

  const frames: ArrayBuffer[] = [];
  let mySessionId: number | null = null;
  const onFrame = (pcm: ArrayBuffer, rms: number): void => {
    if (myRun !== runId) return;
    meterFill.style.width = `${Math.min(100, Math.round(rms * 300))}%`;
    // Frames captured before session:start resolves are held, then flushed.
    if (mySessionId !== null) api.sendAudio(mySessionId, pcm);
    else if (frames.length < MAX_PENDING_FRAMES) frames.push(pcm);
  };

  // Pre-warm the STT WebSocket while the capture pipeline spins up. Both
  // promises are kept so either result is still reachable if the other rejects.
  //
  // The id is adopted the instant the session resolves rather than after
  // capture is also up: session:error events are tagged with it, and an error
  // arriving while `sessionId` is still null matches nothing and is dropped —
  // leaving the renderer recording into a socket main has already torn down.
  // Capture can take far longer than the STT connect, so that window is real.
  const sessionPromise = api.startSession().then((r) => {
    if (r.ok && myRun === runId) {
      sessionId = r.value;
      mySessionId = r.value;
      // Flush here, not after Promise.all: once mySessionId is set onFrame
      // sends live, so buffered frames must go out first or the question's
      // audio arrives out of order. Both run in this one synchronous block.
      for (const frame of frames) api.sendAudio(r.value, frame);
      frames.length = 0;
    }
    return r;
  });
  const capturePromise = startCapture(onFrame);

  try {
    const [startResult, cap] = await Promise.all([sessionPromise, capturePromise]);
    if (myRun !== runId) {
      // Superseded while starting (stop pressed, a new run began, or a
      // session:error already claimed the UI).
      cap.stop();
      void cancelStarted(sessionPromise);
      return;
    }
    if (!startResult.ok) throw startResult.error;
    capture = cap;
  } catch (err) {
    // Whichever half succeeded still has to be torn down: Promise.all threw its
    // value away, but each promise is individually reachable. Neither teardown
    // is awaited — getDisplayMedia can stay pending for a long time and the STT
    // connect has a 5s timeout, and the error belongs on screen now, not five
    // seconds from now.
    void stopPending(capturePromise);
    void cancelStarted(sessionPromise);
    if (myRun !== runId) return; // a newer run owns the UI now
    sessionId = null;
    endCapture();
    dropLiveEntry();
    setState('idle');
    showError(err);
    return;
  }

  setState('recording');
  recordStart = Date.now();
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - recordStart) / 1000);
    timerEl.textContent = formatTimer(s);
    // stopRecording() clears this interval via endCapture(), so the cap fires
    // once; the state check keeps it that way if it ever outlives the state.
    if (s >= MAX_SECONDS && state === 'recording') {
      void stopRecording();
      statusText.textContent = `Reached the ${MAX_SECONDS}s limit — answering now`;
    }
  }, 250);
}

async function stopRecording(): Promise<void> {
  if (state !== 'recording' || sessionId === null) return;
  const id = sessionId;
  setState('finalizing');
  endCapture();
  // Errors surface through the session:error event; the invoke result only
  // covers transport failures.
  try {
    const result = await api.stopSession(id);
    if (!result.ok && sessionId === id) {
      sessionId = null;
      setState('idle');
      showError(result.error);
    }
  } catch (err) {
    // Without this the UI sits in 'finalizing' forever on a dead IPC channel.
    if (sessionId === id) {
      sessionId = null;
      setState('idle');
      showError(err);
    }
  }
}

/** Cancel a start that has not finished coming up yet. */
function abortStarting(): void {
  runId += 1; // the in-flight startRecording will stop its capture and cancel its session
  sessionId = null;
  endCapture();
  dropLiveEntry();
  setState('idle');
}

function toggleRecording(): void {
  switch (state) {
    case 'recording':
      void stopRecording();
      break;
    case 'starting':
      abortStarting();
      break;
    default:
      // idle, or re-record while a previous answer is still streaming —
      // starting a new session makes the main process abort the old one.
      void startRecording();
      break;
  }
}

// ---------- Ask (typed question / regenerate) ----------
/**
 * Push a typed (or re-asked) question through the normal answer pipeline. The
 * reply arrives through the same session events as a recorded clip — one final
 * stt:partial, then llm:delta / llm:done / session:error — so the existing
 * handlers do all the rendering work.
 */
async function submitAsk(text: string, options: AskOptions = {}): Promise<void> {
  // Claim the UI the way onSessionError does: an in-flight recording start
  // whose token is now stale must tear itself down instead of adopting the UI
  // mid-ask. Asking over a still-streaming answer is fine — main aborts the
  // old session when the new one starts, and nulling sessionId here drops any
  // stragglers it emits before that lands.
  const myRun = ++runId;
  sessionId = null;
  clearError();
  beginLiveEntry(options);
  const live = liveEntry();
  if (live) live.question = text; // the transcript box shows the question immediately
  setState('answering');

  let result: Result<number>;
  try {
    result = await api.askQuestion(text, options);
  } catch (err) {
    if (myRun !== runId) return; // a newer run owns the UI now
    dropLiveEntry();
    setState('idle');
    showError(err);
    return;
  }
  if (myRun !== runId) {
    // Superseded while asking — the session, if one opened, belongs to nobody.
    if (result.ok) void api.cancelSession(result.value);
    return;
  }
  if (result.ok) {
    sessionId = result.value;
    askInput.value = '';
  } else {
    dropLiveEntry();
    setState('idle');
    showError(result.error);
  }
}

askForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = askInput.value.trim();
  if (text === '' || askInput.disabled) return;
  if (followupMode) {
    const context = viewedContext();
    if (!context || state !== 'idle') return;
    void submitAsk(text, { context });
  } else {
    void submitAsk(text);
  }
});

regenBtn.addEventListener('click', () => {
  const entry = entries[viewIndex];
  const q = entry?.question.trim() ?? '';
  if (!entry || q === '' || (state !== 'idle' && state !== 'answering')) return;
  followupMode = entry.context.length > 0;
  void submitAsk(q, { context: entry.context, answerStyle: entry.answerStyle });
});

/** Keep the original question as the anchor, then the most recent follow-ups. */
function boundedContext(context: ConversationTurn[]): ConversationTurn[] {
  return context.length <= MAX_HISTORY
    ? context
    : [...context.slice(0, 1), ...context.slice(-(MAX_HISTORY - 1))];
}

/** Follow-ups belong to the viewed branch, including when history is browsed. */
function viewedContext(): ConversationTurn[] | null {
  const entry = entries[viewIndex];
  if (!entry?.completed || !entry.answer.trim()) return null;
  return boundedContext([...entry.context, { question: entry.question, answer: entry.answer }]);
}

function requestFollowup(text: string): void {
  const context = viewedContext();
  if (state !== 'idle' || !context) return;
  followupMode = true;
  // Depth applies only to this answer; keep the saved first-answer style.
  void submitAsk(text, { context, answerStyle: 'detailed' });
}

deeperBtn.addEventListener('click', () => {
  requestFollowup('Go deeper on your previous answer. Explain the reasoning, practical details, and relevant tradeoffs without repeating the introduction.');
});
exampleBtn.addEventListener('click', () => {
  requestFollowup('Show a concrete, worked example of your previous answer, tailored to my profile. Walk through the steps and explain why they work.');
});
newQuestionBtn.addEventListener('click', () => {
  followupMode = false;
  renderEntry();
  askInput.focus();
});
followupModeBtn.addEventListener('click', () => {
  if (state !== 'idle' || !viewedContext()) return;
  followupMode = true;
  renderEntry();
  askInput.focus();
});

function setState(next: State): void {
  state = next;
  recordBtn.classList.toggle('recording', next === 'recording');
  switch (next) {
    case 'idle':
      recordLabel.textContent = 'Record';
      statusDot.className = 'dot';
      statusText.textContent = readyText();
      break;
    case 'starting':
      recordLabel.textContent = 'Starting…';
      statusDot.className = 'dot busy';
      statusText.textContent =
        audioSource === 'system' ? 'Opening the system-audio feed…' : 'Opening the microphone…';
      break;
    case 'recording':
      recordLabel.textContent = 'Stop & Answer';
      statusDot.className = 'dot recording';
      statusText.textContent = 'Listening to the question…';
      break;
    case 'finalizing':
      recordLabel.textContent = 'Record';
      statusDot.className = 'dot busy';
      statusText.textContent = 'Finalizing transcript…';
      break;
    case 'answering':
      recordLabel.textContent = 'Record';
      statusDot.className = 'dot busy';
      statusText.textContent = 'Generating answer…';
      break;
  }
  renderEntry();
}

// ---------- History ----------
const viewingLive = (): boolean => entries.length > 0 && viewIndex === entries.length - 1;
const liveEntry = (): Entry | undefined => {
  const last = entries[entries.length - 1];
  return last?.live ? last : undefined;
};

function beginLiveEntry(options: AskOptions = {}): void {
  // Retire interrupted partial output without allowing it into future context.
  dropLiveEntry();
  entries.push({
    question: '', answer: '', metrics: null, live: true, completed: false,
    context: boundedContext(options.context ?? []).map((turn) => ({ ...turn })),
    answerStyle: options.answerStyle,
  });
  if (entries.length > MAX_HISTORY) entries = entries.slice(entries.length - MAX_HISTORY);
  viewIndex = entries.length - 1;
  renderEntry();
}

/** Retire the live entry; discard it only when it captured nothing at all. */
function dropLiveEntry(): void {
  const idx = entries.length - 1;
  const e = entries[idx];
  if (!e?.live) return;
  if (e.question.trim() === '' && e.answer.trim() === '') entries.splice(idx, 1);
  else e.live = false;
  viewIndex = Math.min(viewIndex, entries.length - 1);
  renderEntry();
}

// ---------- Rendering ----------
let renderQueued = false;
let renderedIndex = -1;
/** Answer source currently in the DOM; '' means the placeholder is showing (as in index.html). */
let answerShown = '';

/** Coalesce token-rate updates to one paint per frame. */
function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderEntry();
  });
}

const isNearBottom = (el: HTMLElement): boolean =>
  el.scrollHeight - el.scrollTop - el.clientHeight < 28;

function setPlaceholder(el: HTMLElement, text: string): void {
  const span = document.createElement('span');
  span.className = 'placeholder';
  span.textContent = text;
  el.replaceChildren(span);
}

function renderEntry(): void {
  const e = entries[viewIndex];
  const switched = renderedIndex !== viewIndex;
  renderedIndex = viewIndex;

  // Transcript (speech, not markdown — plain text with pre-wrap).
  if (!e || e.question === '') {
    const listening = state === 'recording' || state === 'starting';
    const text = listening && viewingLive() ? 'Listening…' : TRANSCRIPT_PLACEHOLDER;
    if (transcriptBox.textContent !== text) setPlaceholder(transcriptBox, text);
  } else if (transcriptBox.textContent !== e.question) {
    transcriptBox.textContent = e.question;
  }

  // Answer: keep the view pinned to the bottom only if it already was, so
  // scrolling up to re-read an earlier line is not yanked back by each token.
  const stick = !switched && isNearBottom(answerBox);
  const src = e?.answer ?? '';
  if (src === '') {
    // Guarded: renderEntry runs every frame while the transcript streams, and
    // rebuilding the placeholder each time is pure churn.
    if (answerShown !== '') {
      answerView.placeholder(ANSWER_PLACEHOLDER);
      answerShown = '';
    }
  } else {
    answerView.update(src); // diffs internally; a no-op when nothing changed
    answerShown = src;
  }
  if (switched) answerBox.scrollTop = 0;
  else if (stick) answerBox.scrollTop = answerBox.scrollHeight;

  // Streaming answers are announced once, on completion, rather than per token.
  answerBox.setAttribute('aria-busy', state === 'answering' ? 'true' : 'false');

  liveTag.hidden = !(state === 'recording' && viewingLive());
  genTag.hidden = !(state === 'answering' && viewingLive());
  copyBtn.hidden = !e || e.answer === '';
  // Regenerate re-asks the viewed question; only offered when a question exists
  // and no recording is in flight (answering is fine — main aborts the old run).
  regenBtn.hidden = !(
    e &&
    e.question.trim() !== '' &&
    (state === 'idle' || state === 'answering')
  );

  const canFollowup = state === 'idle' && !!e?.completed && e.answer.trim() !== '';
  deeperBtn.disabled = !canFollowup;
  exampleBtn.disabled = !canFollowup;
  followupModeBtn.disabled = !canFollowup;
  newQuestionBtn.setAttribute('aria-pressed', followupMode ? 'false' : 'true');
  followupModeBtn.setAttribute('aria-pressed', followupMode ? 'true' : 'false');
  // New questions can still replace a streaming answer. Follow-ups wait for a
  // complete answer, so an interrupted fragment never becomes model context.
  const recording = state === 'starting' || state === 'recording' || state === 'finalizing';
  askInput.disabled = recording || (followupMode && !canFollowup);
  askBtn.disabled = askInput.disabled;
  askInput.placeholder = followupMode ? 'Ask about this answer, or request more detail…' : 'Or type a practice question here…';
  askInput.setAttribute('aria-label', followupMode ? 'Follow up on the viewed answer' : 'Type a new question');
  askBtn.textContent = followupMode ? 'Follow up' : 'Ask';
  askModeHint.textContent = followupMode
    ? canFollowup
      ? `Continuing: ${e.question.length > 100 ? `${e.question.slice(0, 97)}…` : e.question}`
      : state === 'answering' ? 'Follow-ups are available when the answer is complete.' : 'Choose a completed answer from history, or start a new question.'
    : 'New question · use Follow up to continue the answer you are viewing.';

  const m = e?.metrics;
  if (m) {
    latencyTag.hidden = false;
    latencyTag.textContent = latencyLabel(m);
    latencyTag.title = latencyTitle(m);
    // Cost/tokens chip: empty label means the provider reported no usage.
    const cost = costLabel(m);
    costTag.hidden = cost === '';
    costTag.textContent = cost;
    costTag.title = costTitle(m);
  } else {
    latencyTag.hidden = true;
    costTag.hidden = true;
  }

  historyBar.hidden = entries.length <= 1;
  historyLabel.textContent = entries.length > 0 ? `${viewIndex + 1}/${entries.length}` : '';
  prevBtn.disabled = viewIndex <= 0;
  nextBtn.disabled = viewIndex >= entries.length - 1;
  clearBtn.disabled = state !== 'idle' || entries.length === 0;
}

// ---------- UI wiring ----------
recordBtn.addEventListener('click', () => toggleRecording());

prevBtn.addEventListener('click', () => {
  if (viewIndex > 0) {
    viewIndex -= 1;
    renderEntry();
  }
});
nextBtn.addEventListener('click', () => {
  if (viewIndex < entries.length - 1) {
    viewIndex += 1;
    renderEntry();
  }
});

clearBtn.addEventListener('click', () => {
  if (state !== 'idle' || entries.length === 0) return;
  entries = [];
  followupMode = false;
  viewIndex = -1;
  renderedIndex = -1;
  renderEntry(); // placeholders return; the history bar hides itself
  announce('History cleared');
  // The button just vanished with its bar — don't strand keyboard focus.
  recordBtn.focus();
});

// The global shortcut fires regardless of focus. Ignore it while Settings is
// open: the user is deliberately editing text there, not in a call.
api.onHotkeyToggle(() => {
  if (!settingsView.hidden) return;
  toggleRecording();
});

// ---------- Session events (all filtered by current session) ----------
api.onSttPartial((e) => {
  if (e.sessionId !== sessionId) return;
  const live = liveEntry();
  if (!live || !e.text) return;
  live.question = e.text;
  scheduleRender();
});

api.onLlmDelta((e) => {
  if (e.sessionId !== sessionId) return;
  if (state !== 'answering') setState('answering');
  const live = liveEntry();
  if (!live) return;
  live.answer += e.delta;
  scheduleRender();
});

api.onLlmDone((e) => {
  if (e.sessionId !== sessionId) return;
  sessionId = null;
  const live = liveEntry();
  if (live) {
    live.question = e.transcript;
    live.answer = e.answer;
    live.metrics = e.metrics;
    live.live = false;
    live.completed = true;
  }
  setState('idle');
  statusText.textContent = 'Done — explore this answer below or ask a new question';
});

api.onSessionError((e) => {
  if (e.sessionId !== sessionId) return;
  // The session can die while startRecording is still awaiting capture. Retire
  // the run so it finds itself superseded and tears down, instead of reaching
  // setState('recording') and painting over the error the user needs to see.
  runId += 1;
  sessionId = null;
  endCapture();
  dropLiveEntry();
  setState('idle');
  showError(e.error);
});

let copyTimer: ReturnType<typeof setTimeout> | null = null;
copyBtn.addEventListener('click', () => {
  // Copy the markdown source, not the rendered DOM: bullets and code fences
  // survive the paste.
  const text = entries[viewIndex]?.answer ?? '';
  if (!text) return;
  void navigator.clipboard
    .writeText(text)
    .then(() => {
      if (copyTimer) clearTimeout(copyTimer);
      // Only the inner label changes; the button's accessible name comes from
      // its stable aria-label.
      copyLabel.textContent = 'Copied ✓';
      announce('Answer copied');
      copyTimer = setTimeout(() => {
        copyLabel.textContent = 'Copy';
        copyTimer = null;
      }, 1200);
    })
    .catch(() => showError('Could not copy to the clipboard.'));
});

function announce(msg: string): void {
  srAnnounce.textContent = msg;
}

function showError(err: unknown): void {
  errorBox.textContent = errorMessage(err);
  errorBox.hidden = false;
}
function clearError(): void {
  errorBox.hidden = true;
  errorBox.textContent = '';
}

// ---------- Settings ----------
const textFields = ['resume', 'jobDescription', 'personalProfile', 'customInstructions'] as const;
const keyFields = ['deepgramKey', 'anthropicKey', 'groqKey'] as const;
const PROVIDERS: readonly string[] = ['anthropic', 'groq'];
const STYLES: readonly string[] = ['brief', 'balanced', 'detailed'];
const SOURCES: readonly string[] = ['microphone', 'system'];

const asProvider = (v: string): LlmProviderId => (PROVIDERS.includes(v) ? (v as LlmProviderId) : 'anthropic');
const asStyle = (v: string): AnswerStyle => (STYLES.includes(v) ? (v as AnswerStyle) : 'brief');
const asSource = (v: string): AudioSource => (SOURCES.includes(v) ? (v as AudioSource) : 'microphone');
const asAnthropicModel = (v: string): AnthropicModelId =>
  (ANTHROPIC_MODELS as readonly string[]).includes(v) ? (v as AnthropicModelId) : DEFAULT_ANTHROPIC_MODEL;
const asGroqModel = (v: string): GroqModelId =>
  (GROQ_MODELS as readonly string[]).includes(v) ? (v as GroqModelId) : DEFAULT_GROQ_MODEL;

// Only the active provider's model picker is live; the other is grayed out so
// changing it (and wondering why nothing happened) is impossible.
function syncModelPickers(provider: string): void {
  $<HTMLSelectElement>('anthropicModel').disabled = provider !== 'anthropic';
  $<HTMLSelectElement>('groqModel').disabled = provider !== 'groq';
}

// ---------- Answer-style quick toggle ----------
// Flipping the style is latency-free by design: the cached prompt prefix is
// split before the style suffix, so a flip never invalidates the cached
// resume+JD block (see README, "Prompt caching, honestly").
const styleChips = [
  $<HTMLButtonElement>('styleBrief'),
  $<HTMLButtonElement>('styleBalanced'),
  $<HTMLButtonElement>('styleDetailed'),
];

function syncStyleChips(style: AnswerStyle): void {
  for (const chip of styleChips) {
    chip.setAttribute('aria-pressed', chip.dataset.style === style ? 'true' : 'false');
  }
}

for (const chip of styleChips) {
  chip.addEventListener('click', async () => {
    try {
      // Reflect what main persisted, not what was clicked.
      const view = await api.saveSettings({ answerStyle: asStyle(chip.dataset.style ?? '') });
      syncStyleChips(view.answerStyle);
    } catch (err) {
      showError(err);
    }
  });
}

/** Reflect hotkey state on the main view: the chip teaches it, the notice explains its absence. */
function applyHotkeyUi(s: SettingsView): void {
  hotkeyLabel = s.hotkey ? formatAccelerator(s.hotkey) : '';
  hotkeyActive = s.hotkey !== '' && s.hotkeyRegistered;

  hotkeyHint.hidden = !hotkeyActive;
  hotkeyHint.textContent = hotkeyLabel;

  const taken = s.hotkey !== '' && !s.hotkeyRegistered;
  hotkeyWarn.hidden = !taken;
  if (taken) {
    hotkeyWarn.textContent = `${hotkeyLabel} is already taken by another app, so the shortcut is off — record from this window, or pick a different one in Settings.`;
  }
  if (state === 'idle') statusText.textContent = readyText();
}

function fillSettingsForm(s: SettingsView): void {
  for (const f of textFields) $<HTMLTextAreaElement>(f).value = s[f];
  $<HTMLSelectElement>('llmProvider').value = s.llmProvider;
  syncModelPickers(s.llmProvider);
  $<HTMLSelectElement>('anthropicModel').value = s.anthropicModel;
  $<HTMLSelectElement>('groqModel').value = s.groqModel;
  $<HTMLSelectElement>('audioSource').value = s.audioSource;
  audioSource = s.audioSource; // keep the capture path in sync with what is shown
  $<HTMLSelectElement>('answerStyle').value = s.answerStyle;
  $<HTMLInputElement>('alwaysOnTop').checked = s.alwaysOnTop;
  const hotkeyInput = $<HTMLInputElement>('hotkey');
  hotkeyInput.value = s.hotkey;
  hotkeyInput.placeholder = DEFAULT_HOTKEY;
  // Keys are write-only: show a saved marker as placeholder, never the value.
  $<HTMLInputElement>('deepgramKey').placeholder = s.hasDeepgramKey ? '••••••••  (saved — type to replace)' : 'dg_...';
  $<HTMLInputElement>('anthropicKey').placeholder = s.hasAnthropicKey ? '••••••••  (saved — type to replace)' : 'sk-ant-...';
  $<HTMLInputElement>('groqKey').placeholder = s.hasGroqKey ? '••••••••  (saved — type to replace)' : 'gsk_...';
  for (const f of keyFields) $<HTMLInputElement>(f).value = '';
  applyHotkeyUi(s);
}

function openSettings(s: SettingsView): void {
  fillSettingsForm(s);
  settingsError.hidden = true;
  mainView.hidden = true;
  settingsView.hidden = false;
  settingsHeading.focus();
}

function closeSettings(): void {
  settingsView.hidden = true;
  mainView.hidden = false;
  $('savedNote').hidden = true;
  settingsBtn.focus();
}

settingsBtn.addEventListener('click', async () => {
  try {
    openSettings(await api.getSettings());
  } catch (err) {
    showError(err);
  }
});

$('backBtn').addEventListener('click', () => closeSettings());

// Live-gate the model pickers as the provider selection changes (before Save).
$<HTMLSelectElement>('llmProvider').addEventListener('change', (e) => {
  syncModelPickers((e.target as HTMLSelectElement).value);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsView.hidden) {
    e.preventDefault();
    closeSettings();
  }
});

let savedTimer: ReturnType<typeof setTimeout> | null = null;
$('saveBtn').addEventListener('click', async () => {
  const patch: SettingsPatch = {
    personalProfile: $<HTMLTextAreaElement>('personalProfile').value,
    customInstructions: $<HTMLTextAreaElement>('customInstructions').value,
    resume: $<HTMLTextAreaElement>('resume').value,
    jobDescription: $<HTMLTextAreaElement>('jobDescription').value,
    llmProvider: asProvider($<HTMLSelectElement>('llmProvider').value),
    anthropicModel: asAnthropicModel($<HTMLSelectElement>('anthropicModel').value),
    groqModel: asGroqModel($<HTMLSelectElement>('groqModel').value),
    audioSource: asSource($<HTMLSelectElement>('audioSource').value),
    answerStyle: asStyle($<HTMLSelectElement>('answerStyle').value),
    hotkey: $<HTMLInputElement>('hotkey').value.trim(),
    alwaysOnTop: $<HTMLInputElement>('alwaysOnTop').checked,
  };
  // Only send key fields the user actually typed into (empty = leave as is).
  for (const f of keyFields) {
    const v = $<HTMLInputElement>(f).value.trim();
    if (v) patch[f] = v;
  }
  try {
    const view = await api.saveSettings(patch);
    settingsError.hidden = true;
    fillSettingsForm(view);
    syncStyleChips(view.answerStyle); // keep the main-view chips honest too
    const savedNote = $('savedNote');
    savedNote.hidden = false;
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      savedNote.hidden = true;
      savedTimer = null;
    }, 1500);
  } catch (err) {
    // The main error box lives on the main view, which is hidden right now.
    settingsError.textContent = errorMessage(err);
    settingsError.hidden = false;
  }
});

// First run: nudge toward settings if keys are missing.
void (async () => {
  try {
    const s = await api.getSettings();
    applyHotkeyUi(s);
    syncStyleChips(s.answerStyle);
    audioSource = s.audioSource;
    const missingLlmKey = s.llmProvider === 'groq' ? !s.hasGroqKey : !s.hasAnthropicKey;
    if (missingLlmKey && state === 'idle') {
      statusText.textContent = 'Open Settings (gear icon) and add your answer provider API key';
    } else if (!s.hasDeepgramKey && state === 'idle') {
      statusText.textContent = 'Ready — type a question. Add a Deepgram key in Settings to record audio.';
    }
  } catch (err) {
    showError(err);
  }
})();
