/**
 * Small in-memory request guards. They protect a single server process; a
 * multi-instance deployment would need a shared store instead.
 */

export class RateLimiter {
  readonly #hits = new Map<string, number[]>();
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** Records a hit for `key` and reports whether it is within the limit. */
  take(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const now = this.#now();
    const windowStart = now - this.#windowMs;
    const hits = (this.#hits.get(key) ?? []).filter((t) => t > windowStart);
    if (hits.length >= this.#limit) {
      this.#hits.set(key, hits);
      const oldest = hits[0] ?? now;
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.#windowMs - now) / 1000)) };
    }
    hits.push(now);
    this.#hits.set(key, hits);
    if (this.#hits.size > 10_000) this.#prune(windowStart);
    return { ok: true };
  }

  #prune(windowStart: number) {
    for (const [key, hits] of this.#hits) {
      if (hits.every((t) => t <= windowStart)) this.#hits.delete(key);
    }
  }
}

export class BusyError extends Error {
  constructor() {
    super("Too many requests are waiting.");
    this.name = "BusyError";
  }
}

/** Limits concurrent upstream calls; excess callers wait in a bounded queue. */
export class Semaphore {
  #available: number;
  readonly #maxQueue: number;
  readonly #queue: Array<{ resolve: (release: () => void) => void; reject: (error: unknown) => void }> = [];

  constructor(concurrency: number, maxQueue: number) {
    this.#available = concurrency;
    this.#maxQueue = maxQueue;
  }

  get queued(): number {
    return this.#queue.length;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#available > 0) {
      this.#available -= 1;
      return Promise.resolve(this.#releaser());
    }
    if (this.#queue.length >= this.#maxQueue) return Promise.reject(new BusyError());
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.#queue.push(entry);
      signal?.addEventListener(
        "abort",
        () => {
          const index = this.#queue.indexOf(entry);
          if (index >= 0) {
            this.#queue.splice(index, 1);
            reject(signal.reason);
          }
        },
        { once: true },
      );
    });
  }

  #releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#queue.shift();
      if (next) next.resolve(this.#releaser());
      else this.#available += 1;
    };
  }
}
