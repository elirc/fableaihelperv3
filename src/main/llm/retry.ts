// The single shared piece of the two providers' retry policy: attempt, and if
// the failure is one the caller deems retryable, attempt exactly once more.
//
// Why the predicate lives at the call site: the two providers agree on the
// POLICY — retry only a pre-stream connection failure, because the request
// never landed, nothing is on screen, and the happy path pays nothing — but
// they cannot agree on how to RECOGNIZE one. Anthropic's SDK throws a typed
// APIConnectionError and needs a streamedAny flag (its one call spans fetch and
// stream, so a mid-stream drop surfaces through the same throw); Groq's raw
// fetch rejects only ever before the stream exists, and its mid-stream drops
// are handled in the read loop. Forcing those taxonomies into one shape here
// would obscure both. What this helper pins is the part that must never drift
// apart: one retry, never more, and a non-retryable error propagates untouched
// for the caller to map.
export async function retryOnceIf<T>(
  attempt: () => Promise<T>,
  shouldRetry: (err: unknown) => boolean,
): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    if (!shouldRetry(err)) throw err;
    return await attempt();
  }
}
