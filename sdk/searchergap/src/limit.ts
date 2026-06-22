/**
 * Tiny zero-dep concurrency + rate-limit primitives so the loop can scan every
 * market in parallel without blowing your RPC or Jupiter quotas.
 *
 *  - `pLimit(n)`   caps how many async tasks run at once (RPC fan-out bound).
 *  - `rateGate(ms)` spaces calls ≥ ms apart, globally serialized (Jupiter QPS).
 */

/** Bounded-concurrency runner. `run(fn)` queues `fn` until a slot is free. */
export function pLimit(concurrency: number): <T>(task: () => Promise<T>) => Promise<T> {
  const max = Math.max(1, concurrency | 0);
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    active--;
    const fn = queue.shift();
    if (fn) fn();
  };
  return function run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const exec = () => {
        active++;
        task().then(resolve, reject).finally(next);
      };
      if (active < max) exec();
      else queue.push(exec);
    });
  };
}

/**
 * Serialize callers so each `wait()` resolves ≥ `intervalMs` after the previous
 * one — a single-lane rate limiter (good for Jupiter's per-key QPS). intervalMs
 * ≤ 0 disables (resolves immediately).
 */
export function rateGate(intervalMs: number): () => Promise<void> {
  if (!(intervalMs > 0)) return () => Promise.resolve();
  let last = 0;
  let chain: Promise<void> = Promise.resolve();
  return function wait(): Promise<void> {
    chain = chain.then(async () => {
      const now = Date.now();
      const delay = last + intervalMs - now;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      last = Date.now();
    });
    return chain;
  };
}
