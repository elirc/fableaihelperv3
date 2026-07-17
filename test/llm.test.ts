import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AppError } from '../src/shared/types';
import { createAnthropicProvider } from '../src/main/llm/anthropic';
import { createGroqProvider } from '../src/main/llm/groq';

// These tests stub global fetch rather than mocking the Anthropic SDK, so the
// real SDK does the real work: it parses the real SSE wire format and throws its
// real error classes. That matters here, because the bug this file exists to pin
// is entirely about the SDK's error *hierarchy* — a mocked SDK would have
// happily reproduced whatever hierarchy the mock invented.

afterEach(() => {
  vi.unstubAllGlobals();
});

function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A well-formed Anthropic streaming response. Each inner array is one text block's deltas. */
function anthropicStream(blocks: string[][]): Response {
  let body = sseEvent('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
  blocks.forEach((deltas, index) => {
    body += sseEvent('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '', citations: null },
    });
    for (const text of deltas) {
      body += sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text },
      });
    }
    body += sseEvent('content_block_stop', { type: 'content_block_stop', index });
  });
  body += sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 5 },
  });
  body += sseEvent('message_stop', { type: 'message_stop' });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function apiError(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function abortError(): DOMException {
  return new DOMException('This operation was aborted', 'AbortError');
}

/** Captures the AppError thrown by a provider. Fails loudly if it resolves instead. */
async function catchError(run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (err) {
    return err as AppError;
  }
  throw new Error('expected the provider to throw, but it resolved');
}

const anthropic = () => createAnthropicProvider('sk-test', 'resume', 'jd', 'balanced');
const groq = () => createGroqProvider('gsk-test', 'resume', 'jd', 'balanced');
const noop = (): void => {};

describe('anthropic provider — happy path', () => {
  test('streams deltas and returns exactly what was streamed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => anthropicStream([['Hello', ', ', 'world']])));
    const deltas: string[] = [];
    const full = await anthropic().generate('q', (d) => deltas.push(d), new AbortController().signal);

    expect(deltas).toEqual(['Hello', ', ', 'world']);
    expect(full).toBe('Hello, world');
    expect(full).toBe(deltas.join(''));
  });

  // Regression: stream.finalText() joins text blocks with a SPACE. If this
  // provider ever switches to it, the answer handed to the renderer would gain a
  // space that was never streamed, and this assertion would catch it.
  test('a multi-block answer returns the streamed concatenation, with no injected separator', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => anthropicStream([['one'], ['two']])));
    const deltas: string[] = [];
    const full = await anthropic().generate('q', (d) => deltas.push(d), new AbortController().signal);

    expect(full).toBe('onetwo');
    expect(full).toBe(deltas.join(''));
    expect(full).not.toContain(' ');
  });

  test('sends the resume+JD as a cached block and the style as a separate uncached block', async () => {
    const fetchMock = vi.fn(async () => anthropicStream([['ok']]));
    vi.stubGlobal('fetch', fetchMock);
    await anthropic().generate('q', noop, new AbortController().signal);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.system).toHaveLength(2);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system[0].text).toContain('resume');
    // The volatile block must NOT carry a breakpoint, or the style would be
    // part of the cached prefix and toggling it would bust the cache.
    expect(body.system[1].cache_control).toBeUndefined();
    expect(body.model).toBe('claude-haiku-4-5');
  });
});

describe('anthropic provider — error mapping', () => {
  test('401 maps to llm_auth', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => apiError(401, 'authentication_error', 'invalid x-api-key')));
    const err = await catchError(() => anthropic().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_auth');
    expect(err.message).toMatch(/Settings/);
  });

  test('429 maps to llm_rate_limit with actionable advice, not llm_http', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => apiError(429, 'rate_limit_error', 'slow down')));
    const err = await catchError(() => anthropic().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_rate_limit');
    expect(err.message).toMatch(/wait a few seconds|credit balance/i);
  });

  test('529 overloaded maps to llm_http with a retry hint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => apiError(529, 'overloaded_error', 'overloaded')));
    const err = await catchError(() => anthropic().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_http');
    expect(err.message).toMatch(/overloaded/i);
  });

  test('400 maps to llm_http and keeps the status visible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => apiError(400, 'invalid_request_error', 'bad model')));
    const err = await catchError(() => anthropic().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_http');
    expect(err.message).toContain('400');
  });

  // The headline regression. APIUserAbortError extends APIError with
  // status === undefined, so an `instanceof APIError` branch placed before the
  // abort check turns "user pressed record again" into
  // "Answer generation failed (HTTP undefined)".
  test('an abort maps to aborted, never to an HTTP-undefined error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (init?.signal?.aborted) throw abortError();
        return anthropicStream([['never']]);
      }),
    );
    const ac = new AbortController();
    ac.abort();

    const err = await catchError(() => anthropic().generate('q', noop, ac.signal));
    expect(err.code).toBe('aborted');
    expect(err.message).not.toMatch(/undefined/);
    expect(err.message).not.toMatch(/HTTP/);
  });

  test('a network failure is a clean message, not a raw TypeError or HTTP undefined', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const err = await catchError(() => anthropic().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_http');
    expect(err.message).toMatch(/Could not reach Anthropic/);
    expect(err.message).not.toMatch(/undefined/);
  });
});

describe('anthropic provider — single retry on connection failure', () => {
  test('retries once and succeeds when the connection drops before any token', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new TypeError('fetch failed');
        return anthropicStream([['recovered']]);
      }),
    );
    const deltas: string[] = [];
    const full = await anthropic().generate('q', (d) => deltas.push(d), new AbortController().signal);

    expect(calls).toBe(2);
    expect(full).toBe('recovered');
    expect(deltas).toEqual(['recovered']); // exactly one answer on screen
  });

  test('retries at most once, then reports the error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);

    const err = await catchError(() => anthropic().generate('q', noop, new AbortController().signal));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(err.code).toBe('llm_http');
  });

  test('does not retry a request aborted in flight', async () => {
    const ac = new AbortController();
    // The request starts, then the session cancels it (user hit record again).
    const fetchMock = vi.fn(async () => {
      ac.abort();
      throw abortError();
    });
    vi.stubGlobal('fetch', fetchMock);

    const err = await catchError(() => anthropic().generate('q', noop, ac.signal));
    expect(err.code).toBe('aborted');
    expect(fetchMock).toHaveBeenCalledTimes(1); // a retry here would race the new session
  });

  test('does not retry an HTTP error — that would burn the first-token budget', async () => {
    const fetchMock = vi.fn(async () => apiError(429, 'rate_limit_error', 'slow down'));
    vi.stubGlobal('fetch', fetchMock);

    await catchError(() => anthropic().generate('q', noop, new AbortController().signal));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('never retries after a delta reached the panel, which would duplicate the answer', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        // Stream a delta, then cut the connection mid-block (no message_stop).
        const partial =
          sseEvent('message_start', {
            type: 'message_start',
            message: {
              id: 'm',
              type: 'message',
              role: 'assistant',
              model: 'claude-haiku-4-5',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          }) +
          sseEvent('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '', citations: null },
          }) +
          sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'half' },
          });
        return new Response(partial, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }),
    );

    const deltas: string[] = [];
    await catchError(() => anthropic().generate('q', (d) => deltas.push(d), new AbortController().signal));
    expect(calls).toBe(1);
    expect(deltas).toEqual(['half']); // not ['half', 'half']
  });
});

describe('groq provider', () => {
  function groqStream(body: string): Response {
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  function groqLine(content: string): string {
    return 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n';
  }

  test('streams deltas and returns the concatenation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => groqStream(groqLine('Hi') + groqLine(' there') + 'data: [DONE]\n\n')),
    );
    const deltas: string[] = [];
    const full = await groq().generate('q', (d) => deltas.push(d), new AbortController().signal);

    expect(deltas).toEqual(['Hi', ' there']);
    expect(full).toBe('Hi there');
  });

  // Regression: without the end-of-stream flush the last delta stayed stuck in
  // the parser's leftover buffer and the user silently lost the end of the answer.
  test('does not drop the last delta when the stream ends without a trailing newline', async () => {
    const truncated = groqLine('Start') + 'data: ' + JSON.stringify({ choices: [{ delta: { content: ' END' } }] });
    vi.stubGlobal('fetch', vi.fn(async () => groqStream(truncated)));
    const deltas: string[] = [];
    const full = await groq().generate('q', (d) => deltas.push(d), new AbortController().signal);

    expect(deltas).toEqual(['Start', ' END']);
    expect(full).toBe('Start END');
  });

  test('pins the model to a non-deprecated id and suppresses reasoning for latency', async () => {
    const fetchMock = vi.fn(async () => groqStream(groqLine('x') + 'data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetchMock);
    await groq().generate('q', noop, new AbortController().signal);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.model).not.toBe('llama-3.3-70b-versatile'); // shut down 2026-08-16
    expect(body.model).toBe('openai/gpt-oss-120b');
    expect(body.include_reasoning).toBe(false);
    expect(body.reasoning_effort).toBe('low');
    expect(body.stream).toBe(true);
  });

  test('401 maps to llm_auth', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const err = await catchError(() => groq().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_auth');
  });

  test('429 maps to llm_rate_limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', { status: 429 })));
    const err = await catchError(() => groq().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_rate_limit');
  });

  test('404 points at the pinned model, the likeliest cause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no such model', { status: 404 })));
    const err = await catchError(() => groq().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_http');
    expect(err.message).toMatch(/retired|model/i);
  });

  test('5xx maps to llm_http with a retry hint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })));
    const err = await catchError(() => groq().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_http');
    expect(err.message).toMatch(/unavailable/i);
  });

  // Regression: this used to be `res.body!.getReader()`, which threw a raw
  // "Cannot read properties of null" TypeError at the user.
  test('a 200 with no body is a clean error, not a TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const err = await catchError(() => groq().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_http');
    expect(err.message).toMatch(/empty response body/i);
    expect(err.message).not.toMatch(/Cannot read propert/);
  });

  test('an abort during the request maps to aborted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (init?.signal?.aborted) throw abortError();
        return groqStream(groqLine('x'));
      }),
    );
    const ac = new AbortController();
    ac.abort();

    const err = await catchError(() => groq().generate('q', noop, ac.signal));
    expect(err.code).toBe('aborted');
  });

  test('an abort mid-stream maps to aborted, not a scary network error', async () => {
    const ac = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(groqLine('first')));
                // The session cancelled us while the answer was still streaming.
                ac.abort();
                controller.error(abortError());
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
      ),
    );

    const err = await catchError(() => groq().generate('q', noop, ac.signal));
    expect(err.code).toBe('aborted');
  });

  test('a connection drop mid-stream is a clean llm_http message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(groqLine('first')));
                controller.error(new TypeError('terminated'));
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
      ),
    );

    const err = await catchError(() => groq().generate('q', noop, new AbortController().signal));
    expect(err.code).toBe('llm_http');
    expect(err.message).toMatch(/dropped/i);
  });
});
