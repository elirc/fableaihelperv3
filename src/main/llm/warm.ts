import type { LlmProviderId } from '../../shared/types';

// Fire-and-forget HTTPS pre-warm for the active LLM provider.
//
// Node's fetch (undici) pools connections per origin, and both the Anthropic
// SDK and the raw fetch in llm/groq.ts draw from that pool. Opening a
// connection while the user is still recording — and again the instant they
// press Stop, concurrently with the STT finalize — means the answer request
// that follows reuses a live TCP+TLS connection instead of paying the
// handshake inside the stop-to-first-word window, the one number this app is
// judged on.
//
// The warm request is deliberately unauthenticated: only the connection
// matters, and the 401 arrives over the same warmed socket. The body is read
// to completion so undici returns the connection to the pool instead of
// tearing it down.

const WARM_URLS: Record<LlmProviderId, string> = {
  anthropic: 'https://api.anthropic.com/v1/models',
  groq: 'https://api.groq.com/openai/v1/models',
};

/** Repeat warms inside this window are dropped; pooled connections outlive it comfortably. */
const THROTTLE_MS = 2_000;

const lastWarm: Partial<Record<LlmProviderId, number>> = {};

/**
 * Open (or refresh) a pooled connection to the provider's API origin.
 * Never throws, never blocks the caller; a failed warm costs nothing — the
 * real request simply pays the handshake it always used to.
 */
export function warmLlmConnection(provider: LlmProviderId, fetchFn: typeof fetch = fetch): void {
  const now = Date.now();
  const last = lastWarm[provider];
  if (last !== undefined && now - last < THROTTLE_MS) return;
  lastWarm[provider] = now;
  // The try/catch covers a fetchFn that throws *synchronously* (a broken
  // polyfill or an injected test double); the rejection handler covers the
  // normal async failure. Both matter: this is called from the hot record/stop
  // path, and "never throws" is part of the contract — a failed warm must cost
  // exactly nothing.
  try {
    void fetchFn(WARM_URLS[provider], { signal: AbortSignal.timeout(3_000) })
      .then((res) => res.arrayBuffer())
      .then(
        () => {},
        () => {},
      );
  } catch {
    // Swallowed deliberately; the real request simply pays its own handshake.
  }
}

/** @internal Test seam: forget throttle state so each test starts cold. */
export function resetWarmStateForTests(): void {
  for (const key of Object.keys(lastWarm) as LlmProviderId[]) delete lastWarm[key];
}
