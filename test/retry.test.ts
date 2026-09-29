import { describe, expect, test, vi } from 'vitest';
import { retryOnceIf } from '../src/main/llm/retry';

// retryOnceIf is the one shared piece of both LLM providers' "retry exactly
// once on a pre-stream connection failure" policy. The providers keep their own
// error recognizers and mapping (Anthropic's typed SDK errors vs Groq's raw
// fetch rejections); what must never drift between them is counted here: two
// attempts maximum, the predicate consulted on the first failure only, and a
// non-retryable error propagating untouched for the caller to map.

describe('retryOnceIf', () => {
  test('a first-try success makes one attempt and never consults the predicate', async () => {
    const attempt = vi.fn(async () => 'ok');
    const shouldRetry = vi.fn(() => true);

    await expect(retryOnceIf(attempt, shouldRetry)).resolves.toBe('ok');
    // The happy path must pay nothing for the retry machinery — this is the
    // stop-to-first-word critical path.
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(shouldRetry).not.toHaveBeenCalled();
  });

  test('a retryable failure is retried once and the second attempt wins', async () => {
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return 'recovered';
    });

    await expect(retryOnceIf(attempt, () => true)).resolves.toBe('recovered');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  test('retries at most once even when every failure is retryable, and propagates the second error', async () => {
    const first = new Error('first failure');
    const second = new Error('second failure');
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls += 1;
      throw calls === 1 ? first : second;
    });
    const shouldRetry = vi.fn(() => true);

    // The second error is the current truth about the connection — re-throwing
    // the first would hide anything that changed between attempts (an abort,
    // a different failure). And a always-true predicate must not loop.
    await expect(retryOnceIf(attempt, shouldRetry)).rejects.toBe(second);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(shouldRetry).toHaveBeenCalledTimes(1);
  });

  test('a non-retryable failure propagates untouched after a single attempt', async () => {
    const original = new Error('HTTP 429');
    const attempt = vi.fn(async () => {
      throw original;
    });

    // Identity, not equality: the callers map errors by instanceof, so any
    // wrapping here would break their taxonomy downstream.
    await expect(retryOnceIf(attempt, () => false)).rejects.toBe(original);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  test('the predicate receives the exact thrown value, Error or not', async () => {
    const sentinel = { code: 'llm_http', message: 'structured throw' };
    const attempt = vi.fn(async () => {
      throw sentinel;
    });
    const shouldRetry = vi.fn(() => false);

    // Both providers throw plain { code, message } objects as well as Errors;
    // the predicate must be able to inspect whatever actually flew.
    await expect(retryOnceIf(attempt, shouldRetry)).rejects.toBe(sentinel);
    expect(shouldRetry).toHaveBeenCalledExactlyOnceWith(sentinel);
  });

  test('state the predicate reads is evaluated at failure time, not call time', async () => {
    // Simulates the Anthropic provider's streamedAny flag: the attempt streams
    // a delta (flipping the flag) and then dies mid-stream. The retry decision
    // must see the flipped flag, or a partial answer would be doubled.
    let streamedAny = false;
    const attempt = vi.fn(async () => {
      streamedAny = true;
      throw new Error('connection dropped mid-stream');
    });

    await expect(retryOnceIf(attempt, () => !streamedAny)).rejects.toThrow('mid-stream');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  test('non-Error throw shapes (string, null) survive the round trip untouched', async () => {
    // JavaScript lets anything be thrown; the helper must not assume Error and
    // must not normalize — mapping is the caller's job.
    const throwString = vi.fn(async () => {
      throw 'a bare string';
    });
    await expect(retryOnceIf(throwString, () => false)).rejects.toBe('a bare string');

    const throwNull = vi.fn(async () => {
      throw null;
    });
    await expect(retryOnceIf(throwNull, () => false)).rejects.toBe(null);
  });
});
