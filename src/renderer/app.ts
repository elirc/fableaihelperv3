import { DEFAULT_HOTKEY } from '../shared/types';
import { createDefaultProfile, createProfile, resolveContext, cloneContext, boundRelatedAnswer, DEFAULT_OUTPUT, CONTEXT_LIMITS } from '../shared/context';
import type {
  ContextSnapshot, ScenarioProfile, Situation, RelatedAnswer, OutputPreferences,
  AnswerStyle,
  LlmProviderId,
  RendererApi,
  Result,
  SettingsPatch,
  SettingsView,
} from '../shared/types';
import { errorMessage, formatAccelerator, formatTimer, latencyLabel, latencyTitle } from './format';
import { createHistory } from './history';
import { createMarkdownView } from './markdown';
import { stateUi } from './ui-state';
import type { State } from './ui-state';

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
const srAnnounce = $('srAnnounce');
const mainView = $('mainView');
const settingsView = $('settingsView');
const settingsBtn = $<HTMLButtonElement>('settingsBtn');
const settingsHeading = $('settingsHeading');

const MAX_SECONDS = 120; // safety cap per clip
const MAX_HISTORY = 6; // Q/A pairs kept in memory
const MAX_PENDING_FRAMES = 120; // ~15 s of audio buffered while the session opens
const BASE_READY_TEXT = 'Ready — press Record while the other person is speaking';
const ANSWER_PLACEHOLDER = 'Your AI-suggested answer will stream here.';
const TRANSCRIPT_PLACEHOLDER = 'The live transcript will appear here while you record.';

const answerView = createMarkdownView(answerBox);

// ---------- State ----------
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

const history = createHistory(MAX_HISTORY);
let settingsCache: SettingsView | null = null;
let contextReady = false;
let profileBusy = false;
let profiles: ScenarioProfile[] = [createDefaultProfile()];
let activeProfileId = profiles[0]!.id;
let pendingFollowup: RelatedAnswer | undefined;
let requestFollowup: RelatedAnswer | undefined;
let editingContext: ContextSnapshot | undefined;
let noteRevision = 0;
let requestNoteRevision: number | null = null;
let awaitingSession = false;
let earlyEvents: Array<() => void> = [];
const noteInput = $<HTMLTextAreaElement>('questionNote');
noteInput.addEventListener('input', () => { noteRevision += 1; syncContextSummary(); });
noteInput.maxLength = CONTEXT_LIMITS.questionNote;
$<HTMLTextAreaElement>('contextBackground').maxLength = CONTEXT_LIMITS.background;
$<HTMLTextAreaElement>('contextInstructions').maxLength = CONTEXT_LIMITS.instructions;
$<HTMLInputElement>('profileName').maxLength = CONTEXT_LIMITS.name;

function adoptSession(id: number): void {
  sessionId = id;
  awaitingSession = false;
  const events = earlyEvents;
  earlyEvents = [];
  events.forEach((event) => event());
}

function buffered<T>(handler: (event: T) => void): (event: T) => void {
  return (event) => {
    if (awaitingSession && sessionId === null) earlyEvents.push(() => handler(event));
    else handler(event);
  };
}

function activeProfile(): ScenarioProfile {
  return profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0]!;
}

function currentContext(): ContextSnapshot {
  return resolveContext({
    alwaysOnTop: false, llmProvider: 'anthropic', hotkey: '', hotkeyRegistered: false,
    hasDeepgramKey: false, hasAnthropicKey: false, hasGroqKey: false,
    resume: settingsCache?.resume ?? '', jobDescription: settingsCache?.jobDescription ?? '',
    answerStyle: settingsCache?.answerStyle ?? 'balanced', outputDefaults: settingsCache?.outputDefaults,
    contextProfiles: profiles, activeProfileId,
  }, { questionNote: noteInput.value, followUp: pendingFollowup });
}

function requestContext(snapshot?: ContextSnapshot): ContextSnapshot {
  const context = snapshot ? cloneContext(snapshot) : currentContext();
  requestNoteRevision = snapshot ? null : noteRevision;
  requestFollowup = snapshot ? undefined : pendingFollowup;
  return context;
}

function syncContextSummary(): void {
  const p = activeProfile();
  const output = { ...DEFAULT_OUTPUT, answerStyle: settingsCache?.answerStyle ?? 'balanced', ...settingsCache?.outputDefaults, ...p.output };
  $('contextSummary').textContent = `${p.name} · ${output.answerStyle}${noteInput.value ? ' · note' : ''}`;
  $('contextSummary').title = `${p.situation} · ${output.format} · ${output.tone} · ${output.audience}${p.background ? ' · background' : ''}${p.includeResume ? ' · resume included' : ''}${p.includeJobDescription ? ' · job description included' : ''}${p.instructions ? ' · instructions set' : ''}`;
  $('contextTiming').textContent = state === 'idle'
    ? 'Changes apply when you next press Record or Ask. Profiles are saved only with Save profile.'
    : 'This answer uses its captured context. Changes apply to the next question.';
  syncStyleChips(output.answerStyle);
}

function fillContextForm(): void {
  const p = activeProfile();
  const select = $<HTMLSelectElement>('profileSelect');
  select.replaceChildren(...profiles.map((profile) => {
    const option = document.createElement('option'); option.value = profile.id; option.textContent = profile.name; return option;
  }));
  select.value = p.id;
  $<HTMLInputElement>('profileName').value = p.name;
  $<HTMLSelectElement>('scenario').value = p.situation;
  $<HTMLTextAreaElement>('contextBackground').value = p.background;
  $<HTMLTextAreaElement>('contextInstructions').value = p.instructions;
  $<HTMLInputElement>('includeResume').checked = p.includeResume;
  $<HTMLInputElement>('includeJobDescription').checked = p.includeJobDescription;
  const output = { ...DEFAULT_OUTPUT, answerStyle: settingsCache?.answerStyle ?? 'balanced', ...settingsCache?.outputDefaults, ...p.output };
  $<HTMLSelectElement>('answerFormat').value = output.format;
  $<HTMLSelectElement>('answerTone').value = output.tone;
  $<HTMLSelectElement>('answerAudience').value = output.audience;
  $<HTMLButtonElement>('profileDelete').disabled = profiles.length <= 1;
  syncContextSummary();
}

function loadContextSettings(settings: SettingsView): void {
  settingsCache = settings;
  profiles = settings.contextProfiles?.length ? settings.contextProfiles.map((p) => ({ ...p, output: { ...p.output } })) : [createDefaultProfile(settings.answerStyle)];
  activeProfileId = settings.activeProfileId ?? profiles[0]!.id;
  if (!profiles.some((p) => p.id === activeProfileId)) activeProfileId = profiles[0]!.id;
  fillContextForm();
}

async function saveProfiles(nextProfiles: ScenarioProfile[], nextId: string): Promise<void> {
  const view = await api.saveSettings({ contextProfiles: nextProfiles, activeProfileId: nextId });
  settingsCache = view;
  profiles = nextProfiles;
  activeProfileId = nextId;
  $('profileStatus').textContent = 'Profile saved';
  fillContextForm();
}

function lockProfileControls(locked: boolean): void {
  profileBusy = locked;
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement>('#contextPanel input, #contextPanel select, #contextPanel button, #contextPanel textarea, .style-row button').forEach((control) => { control.disabled = locked; });
  if (!locked) $<HTMLButtonElement>('profileDelete').disabled = profiles.length <= 1;
}

for (const id of ['scenario', 'contextBackground', 'contextInstructions', 'includeResume', 'includeJobDescription', 'answerFormat', 'answerTone', 'answerAudience']) {
  $(id).addEventListener('input', () => {
    const p = activeProfile();
    if (id === 'scenario') {
      const template = createProfile($<HTMLSelectElement>('scenario').value as Situation);
      if (!p.instructions || p.instructions === createProfile(p.situation).instructions) $<HTMLTextAreaElement>('contextInstructions').value = template.instructions;
      $<HTMLInputElement>('includeResume').checked = template.includeResume;
      $<HTMLInputElement>('includeJobDescription').checked = template.includeJobDescription;
    }
    p.situation = $<HTMLSelectElement>('scenario').value as Situation;
    p.background = $<HTMLTextAreaElement>('contextBackground').value;
    p.instructions = $<HTMLTextAreaElement>('contextInstructions').value;
    p.includeResume = $<HTMLInputElement>('includeResume').checked;
    p.includeJobDescription = $<HTMLInputElement>('includeJobDescription').checked;
    p.output = { ...p.output, format: $<HTMLSelectElement>('answerFormat').value as OutputPreferences['format'], tone: $<HTMLSelectElement>('answerTone').value as OutputPreferences['tone'], audience: $<HTMLSelectElement>('answerAudience').value as OutputPreferences['audience'] };
    $('profileStatus').textContent = 'Unsaved profile changes · active for the next question';
    syncContextSummary();
  });
}
$('profileSelect').addEventListener('change', () => {
  if (profileBusy) return;
  activeProfileId = $<HTMLSelectElement>('profileSelect').value;
  fillContextForm();
  void api.saveSettings({ activeProfileId }).catch(showError);
});
for (const action of ['New', 'Duplicate', 'Rename', 'Delete', 'Save']) {
  $(`profile${action}`).addEventListener('click', async () => {
    if (profileBusy) return;
    lockProfileControls(true);
    try {
      let nextProfiles = profiles.map((p) => ({ ...p, output: { ...p.output } }));
      let nextId = activeProfileId;
      const p = nextProfiles.find((p) => p.id === nextId)!;
      const name = $<HTMLInputElement>('profileName').value.trim();
      if (action === 'New' || action === 'Duplicate') {
        if (profiles.length >= CONTEXT_LIMITS.profiles) { $('profileStatus').textContent = 'Up to 20 profiles can be saved. Delete a profile first.'; return; }
        const id = crypto.randomUUID();
        const next = action === 'New' ? createProfile('custom', id, 'New profile') : { ...p, id, name: `${p.name} copy`.slice(0, 80), output: { ...p.output } };
        nextProfiles.push(next); nextId = id;
      } else if (action === 'Delete') {
        if (profiles.length <= 1) return;
        nextProfiles = nextProfiles.filter((item) => item.id !== p.id); nextId = nextProfiles[0]!.id;
      } else {
        if (!name) { $('profileStatus').textContent = 'Enter a profile name.'; return; }
        p.name = name;
      }
      await saveProfiles(nextProfiles, nextId);
    } catch (err) { $('profileStatus').textContent = 'Could not save. Your draft is still available.'; showError(err); }
    finally { lockProfileControls(false); }
  });
}
const instructionTemplates: Record<string, string> = {
  star: 'For experience questions, use Situation, Task, Action, Result. Use only supplied facts; ask for missing details.',
  tradeoffs: 'Explain the main options, their trade-offs, and a recommendation with its assumptions.',
  clarify: 'If essential facts are missing, ask a concise clarifying question. Do not invent experience or outcomes.',
  actions: 'Focus on decisions, open questions, and concrete next actions. Do not invent owners or deadlines.',
};
$('applyTemplate').addEventListener('click', () => {
  const template = instructionTemplates[$<HTMLSelectElement>('instructionTemplate').value];
  if (!template) return;
  const field = $<HTMLTextAreaElement>('contextInstructions');
  field.value = [field.value.trim(), template].filter(Boolean).join('\n').slice(0, CONTEXT_LIMITS.instructions);
  field.dispatchEvent(new Event('input'));
});
$('cancelFollowup').addEventListener('click', () => { pendingFollowup = undefined; $('followupBanner').hidden = true; });
$('cancelEditQuestion').addEventListener('click', () => { editingContext = undefined; $('editBanner').hidden = true; });

const readyText = (): string =>
  hotkeyActive ? `Ready — press Record or ${hotkeyLabel}` : BASE_READY_TEXT;

// ---------- Capture ----------
interface Capture {
  stop(): void;
}

/**
 * Opens system-audio loopback and streams Int16 frames to `onFrame`. The caller
 * owns the returned handle: each recording run stops its own capture, so a run
 * that loses a race can never stop the capture of the run that replaced it.
 */
async function startCapture(onFrame: (pcm: ArrayBuffer, rms: number) => void): Promise<Capture> {
  // getDisplayMedia is routed to system-audio loopback by the main process.
  // Prefer audio-only; fall back to the discarded-video workaround if the
  // Electron version insists on a video track.
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: false, audio: true } as MediaStreamConstraints);
  } catch {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((t) => t.stop());
  }

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('Could not capture system audio. Make sure audio is playing on this PC.');
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
  if (!contextReady) return;
  editingContext = undefined;
  $('editBanner').hidden = true;
  const myRun = ++runId;
  clearError();
  sessionId = null;
  const context = requestContext();
  history.beginLive(context);
  awaitingSession = true;
  earlyEvents = [];
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
  const sessionPromise = api.startSession({ snapshot: context }).then((r) => {
    if (r.ok && myRun === runId) {
      adoptSession(r.value);
      if (myRun !== runId) return r;
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
    history.dropLive();
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
  history.dropLive();
  setState('idle');
}

function toggleRecording(): void {
  if (!contextReady) return;
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
async function submitAsk(text: string, snapshot?: ContextSnapshot): Promise<void> {
  if (!contextReady) return;
  // Claim the UI the way onSessionError does: an in-flight recording start
  // whose token is now stale must tear itself down instead of adopting the UI
  // mid-ask. Asking over a still-streaming answer is fine — main aborts the
  // old session when the new one starts, and nulling sessionId here drops any
  // stragglers it emits before that lands.
  const myRun = ++runId;
  sessionId = null;
  clearError();
  const context = requestContext(snapshot);
  const live = history.beginLive(context);
  awaitingSession = true;
  earlyEvents = [];
  live.question = text; // the transcript box shows the question immediately
  setState('answering');

  let result: Result<number>;
  try {
    result = await api.askQuestion(text, { snapshot: context });
  } catch (err) {
    if (myRun !== runId) return; // a newer run owns the UI now
    history.dropLive();
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
    adoptSession(result.value);
    if (snapshot && editingContext === snapshot) { editingContext = undefined; $('editBanner').hidden = true; }
    if (askInput.value.trim() === text) askInput.value = '';
  } else {
    history.dropLive();
    setState('idle');
    showError(result.error);
  }
}

askForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = askInput.value.trim();
  if (text === '' || askInput.disabled) return;
  const snapshot = editingContext;
  void submitAsk(text, snapshot);
});

regenBtn.addEventListener('click', () => {
  const q = history.viewed()?.question.trim() ?? '';
  if (q === '' || (state !== 'idle' && state !== 'answering')) return;
  void submitAsk(q, history.viewed()?.context);
});

function refineAnswer(instruction: string, overrides: Partial<OutputPreferences> = {}): void {
  const entry = history.viewed();
  if (!entry?.question || (state !== 'idle' && state !== 'answering')) return;
  const snapshot = cloneContext(entry.context ?? currentContext());
  snapshot.relatedAnswer = boundRelatedAnswer({ question: entry.question, answer: entry.answer });
  snapshot.refinement = instruction;
  snapshot.output = { ...snapshot.output, ...overrides };
  void submitAsk(entry.question, snapshot);
}
$('regenCurrentBtn').addEventListener('click', () => {
  const question = history.viewed()?.question;
  if (question && (state === 'idle' || state === 'answering')) void submitAsk(question);
});
$('shorterBtn').addEventListener('click', () => refineAnswer('Make the previous AI suggestion shorter while preserving the essential answer.', { answerStyle: 'brief' }));
$('specificBtn').addEventListener('click', () => refineAnswer('Make the previous AI suggestion more specific using supplied facts. Flag missing facts; do not invent details.'));
$('toneBtn').addEventListener('click', () => {
  const tone = $<HTMLSelectElement>('refineTone').value as OutputPreferences['tone'];
  refineAnswer(`Rewrite the previous AI suggestion in a ${tone} tone.`, { tone });
});
$('editQuestionBtn').addEventListener('click', () => {
  const entry = history.viewed();
  if (!entry || askInput.disabled) return;
  askInput.value = entry.question;
  editingContext = entry.context ? cloneContext(entry.context) : undefined;
  $('editBanner').hidden = !editingContext;
  $('editLabel').textContent = `Edited question will use the original context: ${entry.context?.profileName ?? ''}.`;
  askInput.focus();
  announce('Edit the question, then press Ask to answer again with its original context.');
});
$('followupBtn').addEventListener('click', () => {
  const entry = history.viewed();
  if (!entry || askInput.disabled) return;
  pendingFollowup = boundRelatedAnswer({ question: entry.question, answer: entry.answer });
  editingContext = undefined;
  $('editBanner').hidden = true;
  $('followupLabel').textContent = `Next question follows: ${entry.question.slice(0, 120)}. Prior answer is an AI suggestion, not something you said.`;
  $('followupBanner').hidden = false;
  askInput.focus();
});

function setState(next: State): void {
  state = next;
  if (next === 'idle') { awaitingSession = false; earlyEvents = []; }
  const ui = stateUi(next, readyText());
  recordBtn.classList.toggle('recording', next === 'recording');
  askInput.disabled = ui.askLocked || !contextReady;
  askBtn.disabled = ui.askLocked || !contextReady;
  recordBtn.disabled = !contextReady;
  $('meterRow').hidden = next !== 'recording' && next !== 'starting';
  recordLabel.textContent = ui.recordLabel;
  statusDot.className = ui.dotClass;
  statusText.textContent = ui.statusText;
  syncContextSummary();
  renderEntry();
}

// ---------- Rendering ----------
let renderQueued = false;
let renderedIndex = -1;
let renderedContext: ContextSnapshot | undefined;
/** Answer source currently in the DOM; '' means the placeholder is showing (as in index.html). */
let answerShown = '';
/**
 * Transcript text currently in the DOM (question or placeholder text), seeded
 * with the placeholder index.html ships. Tracked in a variable because this is
 * compared every animation frame while the transcript streams, and reading
 * `textContent` re-serializes the node's text on each call.
 */
let transcriptShown = TRANSCRIPT_PLACEHOLDER;

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
  const e = history.viewed();
  const viewIndex = history.viewIndex();
  const count = history.count();
  const switched = renderedIndex !== viewIndex;
  renderedIndex = viewIndex;

  // Transcript (speech, not markdown — plain text with pre-wrap).
  if (!e || e.question === '') {
    const listening = state === 'recording' || state === 'starting';
    const text = listening && history.viewingLive() ? 'Listening…' : TRANSCRIPT_PLACEHOLDER;
    if (transcriptShown !== text) {
      setPlaceholder(transcriptBox, text);
      transcriptShown = text;
    }
  } else if (transcriptShown !== e.question) {
    transcriptBox.textContent = e.question;
    transcriptShown = e.question;
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

  liveTag.hidden = !(state === 'recording' && history.viewingLive());
  genTag.hidden = !(state === 'answering' && history.viewingLive());
  copyBtn.hidden = !e || e.answer === '';
  // Regenerate re-asks the viewed question; only offered when a question exists
  // and no recording is in flight (answering is fine — main aborts the old run).
  regenBtn.hidden = !(
    e &&
    e.question.trim() !== '' &&
    (state === 'idle' || state === 'answering')
  );

  const m = e?.metrics;
  $('answerActions').hidden = !e?.question || (state !== 'idle' && state !== 'answering');
  $('entryContext').hidden = !e?.context;
  if (e?.context && renderedContext !== e.context) {
    const c = e.context;
    $('entryContextText').textContent = `${c.profileName} · ${c.situation}\n${c.output.answerStyle} · ${c.output.format} · ${c.output.tone} · ${c.output.audience}\nBackground: ${c.background || '(none)'}\nInstructions: ${c.instructions || '(none)'}\nResume: ${c.resume || '(excluded or empty)'}\nJob description: ${c.jobDescription || '(excluded or empty)'}\nQuestion note: ${c.questionNote || '(none)'}${c.relatedAnswer ? '\nSelected prior question: ' + c.relatedAnswer.question + '\nPrior AI suggestion: ' + c.relatedAnswer.answer : ''}${c.refinement ? '\nRefinement: ' + c.refinement : ''}`;
  }
  renderedContext = e?.context;
  if (m) {
    latencyTag.hidden = false;
    latencyTag.textContent = latencyLabel(m);
    latencyTag.title = latencyTitle(m);
  } else {
    latencyTag.hidden = true;
  }

  historyBar.hidden = count <= 1;
  // Guarded like the transcript: assigning textContent replaces the text node
  // even when the string is identical, and this runs once per frame mid-stream.
  const label = count > 0 ? `${viewIndex + 1}/${count}` : '';
  if (historyLabel.textContent !== label) historyLabel.textContent = label;
  prevBtn.disabled = viewIndex <= 0;
  nextBtn.disabled = viewIndex >= count - 1;
  clearBtn.disabled = state !== 'idle' || count === 0;
}

// ---------- UI wiring ----------
recordBtn.addEventListener('click', () => toggleRecording());

prevBtn.addEventListener('click', () => {
  if (history.prev()) renderEntry();
});
nextBtn.addEventListener('click', () => {
  if (history.next()) renderEntry();
});

clearBtn.addEventListener('click', () => {
  if (state !== 'idle' || history.count() === 0) return;
  history.clear();
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
api.onSttPartial(buffered((e) => {
  if (e.sessionId !== sessionId) return;
  const live = history.live();
  if (!live || !e.text) return;
  live.question = e.text;
  scheduleRender();
}));

api.onLlmDelta(buffered((e) => {
  if (e.sessionId !== sessionId) return;
  if (state !== 'answering') setState('answering');
  const live = history.live();
  if (!live) return;
  live.answer += e.delta;
  scheduleRender();
}));

api.onLlmDone(buffered((e) => {
  if (e.sessionId !== sessionId) return;
  sessionId = null;
  const live = history.live();
  if (live) {
    live.question = e.transcript;
    live.answer = e.answer;
    live.metrics = e.metrics;
    live.live = false;
    if (e.context) live.context = cloneContext(e.context);
  }
  if (requestNoteRevision !== null && noteRevision === requestNoteRevision) noteInput.value = '';
  requestNoteRevision = null;
  if (requestFollowup && pendingFollowup === requestFollowup) { pendingFollowup = undefined; $('followupBanner').hidden = true; }
  requestFollowup = undefined;
  setState('idle');
  statusText.textContent = 'Done — press Record for the next question';
}));

api.onSessionError(buffered((e) => {
  if (e.sessionId !== sessionId) return;
  // The session can die while startRecording is still awaiting capture. Retire
  // the run so it finds itself superseded and tears down, instead of reaching
  // setState('recording') and painting over the error the user needs to see.
  runId += 1;
  sessionId = null;
  endCapture();
  history.dropLive();
  setState('idle');
  showError(e.error);
}));

let copyTimer: ReturnType<typeof setTimeout> | null = null;
copyBtn.addEventListener('click', () => {
  // Copy the markdown source, not the rendered DOM: bullets and code fences
  // survive the paste.
  const text = history.viewed()?.answer ?? '';
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
const textFields = ['resume', 'jobDescription'] as const;
const keyFields = ['deepgramKey', 'anthropicKey', 'groqKey'] as const;
const PROVIDERS: readonly string[] = ['anthropic', 'groq'];
const STYLES: readonly string[] = ['brief', 'balanced', 'detailed'];

const asProvider = (v: string): LlmProviderId => (PROVIDERS.includes(v) ? (v as LlmProviderId) : 'anthropic');
const asStyle = (v: string): AnswerStyle => (STYLES.includes(v) ? (v as AnswerStyle) : 'balanced');

// ---------- Answer-style quick toggle ----------
// Length changes preserve the stable prompt prefix. Actual latency still
// depends on context size, cache eligibility, the provider, and the network.
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
    if (profileBusy) return;
    const targetId = activeProfileId;
    try {
      const answerStyle = asStyle(chip.dataset.style ?? '');
      const persisted = settingsCache?.contextProfiles ?? [createDefaultProfile(settingsCache?.answerStyle)];
      const updated = persisted.map((p) => p.id === targetId ? { ...p, output: { ...p.output, answerStyle } } : p);
      const view = await api.saveSettings({ answerStyle, contextProfiles: updated });
      const target = profiles.find((p) => p.id === targetId);
      if (target) target.output.answerStyle = view.contextProfiles?.find((p) => p.id === targetId)?.output.answerStyle ?? view.answerStyle;
      settingsCache = view;
      syncContextSummary();
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
  for (const id of ['clearDeepgramKey', 'clearAnthropicKey', 'clearGroqKey']) $<HTMLInputElement>(id).checked = false;
  applyHotkeyUi(s);
}

function openSettings(s: SettingsView): void {
  if (!contextReady) { loadContextSettings(s); contextReady = true; setState(state); }
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

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsView.hidden) {
    e.preventDefault();
    closeSettings();
  }
});

let savedTimer: ReturnType<typeof setTimeout> | null = null;
$('saveBtn').addEventListener('click', async () => {
  const patch: SettingsPatch = {
    resume: $<HTMLTextAreaElement>('resume').value,
    jobDescription: $<HTMLTextAreaElement>('jobDescription').value,
    llmProvider: asProvider($<HTMLSelectElement>('llmProvider').value),
    answerStyle: asStyle($<HTMLSelectElement>('answerStyle').value),
    hotkey: $<HTMLInputElement>('hotkey').value.trim(),
    alwaysOnTop: $<HTMLInputElement>('alwaysOnTop').checked,
  };
  // Only send key fields the user actually typed into (empty = leave as is).
  for (const f of keyFields) {
    const v = $<HTMLInputElement>(f).value.trim();
    if (v) patch[f] = v;
    const clearId = `clear${f.charAt(0).toUpperCase()}${f.slice(1)}`;
    if ($<HTMLInputElement>(clearId).checked) patch[f] = '';
  }
  try {
    const view = await api.saveSettings(patch);
    settingsCache = view;
    if (!view.contextProfiles?.length) activeProfile().output.answerStyle = view.answerStyle;
    settingsError.hidden = true;
    fillSettingsForm(view);
    syncContextSummary();
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
recordBtn.disabled = true;
askBtn.disabled = true;
askInput.disabled = true;
void (async () => {
  try {
    const s = await api.getSettings();
    loadContextSettings(s);
    contextReady = true;
    setState(state);
    applyHotkeyUi(s);
    const missingLlmKey = s.llmProvider === 'groq' ? !s.hasGroqKey : !s.hasAnthropicKey;
    if ((!s.hasDeepgramKey || missingLlmKey) && state === 'idle') {
      statusText.textContent = 'First run: open Settings (gear icon) and add your API keys';
    }
  } catch (err) {
    showError(err);
  }
})();
