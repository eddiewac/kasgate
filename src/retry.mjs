// Retry-with-backoff for READ/CHECK operations only. Never wraps broadcasts or signing:
// upstream's "corrective 402 requires a new explicit payment authorization" safety is untouched.
export const TRANSIENT = /rollback lacks a confirmed replacement|not yet (visible|confirmed|indexed)|timed? ?out|ECONNRESET|socket|websocket|disconnected|not connected|temporar|rate limit|503|502/i;
// M2: explicit allowlist of read-only adapter methods (no name-prefix matching).
export const READ_METHODS = new Set(["getUtxo", "getUtxos", "discoverCovenantLineage", "getVirtualDaaScore", "verifyCovenantGenesis", "verifyCovenantTopUp", "getPublicIdentity", "estimateFees"]);
export async function withRetry(fn, { retries = 6, baseMs = 500, maxMs = 8000, isRetryable = (e) => TRANSIENT.test(e?.message ?? ""), onRetry, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (e) {
      if (attempt >= retries || !isRetryable(e)) throw e;
      const ms = Math.min(maxMs, baseMs * 2 ** attempt);
      onRetry?.(e, attempt + 1, ms); await sleep(ms);
    }
  }
}
/** Proxy an adapter so only allowlisted read methods are retried; everything else passes through. */
export function retryReads(obj, opts = {}) {
  const allow = opts.methods ? new Set(opts.methods) : READ_METHODS;
  return new Proxy(obj, { get(t, p) { const v = t[p];
    if (typeof v !== "function" || typeof p !== "string" || !allow.has(p)) return typeof v === "function" ? v.bind(t) : v;
    return (...a) => withRetry(() => v.apply(t, a), { ...opts, onRetry: (e, n, ms) => opts.onRetry?.(p, e, n, ms) }); } });
}
