import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetWarmStateForTests, warmLlmConnection } from '../src/main/llm/warm';

// warm.ts is a fire-and-forget pre-warm: it must never throw, never block, and
// never spam the provider — a warm is only worth anything if it is free. These
// tests pin the throttle window (Date.now-based, hence fake timers +
// setSystemTime), the per-provider URLs, and the two failure modes that must
// stay silent (async rejection and a synchronously-throwing fetch impl).

/** A fetch double whose response body can be observed being consumed. */
function fetchDouble(): { fn: ReturnType<typeof vi.fn>; arrayBuffer: ReturnType<typeof vi.fn> } {
  const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
  const fn = vi.fn(async () => ({ arrayBuffer }) as unknown as Response);
  return { fn, arrayBuffer };
}

/** Cast a vi.fn to the fetchFn parameter type without losing the mock handle. */
function asFetch(fn: ReturnType<typeof vi.fn>): typeof fetch {
  return fn as unknown as typeof fetch;
}

/** Drain the promise chain inside warmLlmConnection (it is not awaitable by design). */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-22T12:00:00Z'));
  resetWarmStateForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('warmLlmConnection — target URLs', () => {
  test('warms the Anthropic API origin for the anthropic provider', () => {
    const { fn } = fetchDouble();
    warmLlmConnection('anthropic', asFetch(fn));

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]?.[0]).toBe('https://api.anthropic.com/v1/models');
  });

  test('warms the Groq API origin for the groq provider', () => {
    const { fn } = fetchDouble();
    warmLlmConnection('groq', asFetch(fn));

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]?.[0]).toBe('https://api.groq.com/openai/v1/models');
  });

  test('passes an abort signal so a dead network cannot hold the socket open forever', () => {
    const { fn } = fetchDouble();
    warmLlmConnection('anthropic', asFetch(fn));

    const init = fn.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('warmLlmConnection — throttling', () => {
  test('a second warm inside the 2 s window is dropped', () => {
    const { fn } = fetchDouble();
    warmLlmConnection('anthropic', asFetch(fn));
    warmLlmConnection('anthropic', asFetch(fn));

    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('still throttled one millisecond before the window closes', () => {
    const { fn } = fetchDouble();
    warmLlmConnection('anthropic', asFetch(fn));
    vi.advanceTimersByTime(1_999);
    warmLlmConnection('anthropic', asFetch(fn));

    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('allowed again once the window has elapsed', () => {
    const { fn } = fetchDouble();
    warmLlmConnection('anthropic', asFetch(fn));
    vi.advanceTimersByTime(2_000);
    warmLlmConnection('anthropic', asFetch(fn));

    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('throttle state is tracked per provider, not globally', () => {
    const { fn } = fetchDouble();
    warmLlmConnection('anthropic', asFetch(fn));
    warmLlmConnection('groq', asFetch(fn));

    // Warming one provider must not starve the other — the user can switch
    // providers in Settings between answers.
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('a failed warm still counts for throttling (no hot retry loop on a dead network)', async () => {
    const fn = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    warmLlmConnection('anthropic', asFetch(fn));
    await flushMicrotasks();
    warmLlmConnection('anthropic', asFetch(fn));

    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('warmLlmConnection — never throws, never leaks', () => {
  test('a rejected fetch is swallowed (no throw, no unhandled rejection)', async () => {
    const fn = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    expect(() => warmLlmConnection('anthropic', asFetch(fn))).not.toThrow();
    // If the rejection were unhandled, vitest would fail the test run here.
    await flushMicrotasks();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('a synchronously-throwing fetch implementation is swallowed too', () => {
    const fn = vi.fn(() => {
      throw new Error('broken polyfill');
    });

    expect(() => warmLlmConnection('anthropic', asFetch(fn))).not.toThrow();
  });

  test('a rejected body read is swallowed', async () => {
    const fn = vi.fn(async () => ({
      arrayBuffer: async () => {
        throw new Error('connection reset');
      },
    }) as unknown as Response);

    expect(() => warmLlmConnection('groq', asFetch(fn))).not.toThrow();
    await flushMicrotasks();
  });

  test('returns synchronously without waiting for the request', () => {
    // The warm fires from the hot record/stop path; if it ever awaited the
    // network it would add the very latency it exists to remove.
    let settled = false;
    const fn = vi.fn(
      () =>
        new Promise<Response>(() => {
          /* never settles */
        }).finally(() => {
          settled = true;
        }),
    );

    warmLlmConnection('anthropic', asFetch(fn));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false); // caller was not blocked on the fetch
  });
});

describe('warmLlmConnection — connection reuse', () => {
  test('reads the response body to completion so undici can pool the connection', async () => {
    // An unread body makes undici tear the connection down instead of pooling
    // it — which would silently turn the warm into a no-op.
    const { fn, arrayBuffer } = fetchDouble();
    warmLlmConnection('anthropic', asFetch(fn));
    await flushMicrotasks();

    expect(arrayBuffer).toHaveBeenCalledTimes(1);
  });

  test('uses the injected fetchFn, never the global fetch', () => {
    const globalFetch = vi.fn();
    vi.stubGlobal('fetch', globalFetch);
    const { fn } = fetchDouble();

    warmLlmConnection('anthropic', asFetch(fn));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});

describe('resetWarmStateForTests', () => {
  test('clears the throttle so the next warm fires immediately', () => {
    const { fn } = fetchDouble();
    warmLlmConnection('anthropic', asFetch(fn));
    resetWarmStateForTests();
    warmLlmConnection('anthropic', asFetch(fn));

    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('clears every provider, not just one', () => {
    const { fn } = fetchDouble();
    warmLlmConnection('anthropic', asFetch(fn));
    warmLlmConnection('groq', asFetch(fn));
    resetWarmStateForTests();
    warmLlmConnection('anthropic', asFetch(fn));
    warmLlmConnection('groq', asFetch(fn));

    expect(fn).toHaveBeenCalledTimes(4);
  });
});
