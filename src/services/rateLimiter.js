/**
 * rateLimiter.js — sliding-window rate limiter with 429/5xx retry.
 *
 * Replaces the old approach of sleeping a fixed 150ms between calls. That gave
 * ~6.7 req/s, which respects Riot's 20-req/second limit but blows straight
 * through the 100-requests-per-2-minutes limit: syncing 60 matches issues 120
 * requests (match + timeline each) in ~18s and starts getting 429s, which the
 * old code silently swallowed — dropping matches from the sync.
 *
 * This enforces every window simultaneously and, on a 429, pauses ALL traffic
 * (not just the failing call) for the duration Riot asks for.
 */

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Riot's default personal/development key limits.
 * A production key is far higher — override via the RateLimiter constructor.
 */
const DEFAULT_WINDOWS = [
    { limit: 20,  intervalMs: 1000 },    // 20 requests per second
    { limit: 100, intervalMs: 120000 },  // 100 requests per 2 minutes
];

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

class RateLimiter {
    /**
     * @param {Array<{limit:number,intervalMs:number}>} windows
     * @param {object} [opts]
     * @param {number} [opts.maxRetries=5]
     * @param {number} [opts.maxBackoffMs=30000]
     * @param {(msg:string)=>void} [opts.log]
     */
    constructor(windows = DEFAULT_WINDOWS, opts = {}) {
        this.windows = windows.map(w => ({
            limit: w.limit,
            intervalMs: w.intervalMs,
            hits: [],
        }));
        this.maxRetries   = opts.maxRetries ?? 5;
        this.maxBackoffMs = opts.maxBackoffMs ?? 30000;
        this.log          = opts.log ?? (() => {});
        this.now          = opts.now ?? (() => Date.now());
        this.sleep        = opts.sleep ?? sleep;

        this.pausedUntil = 0;
        // Serialises slot acquisition so two concurrent callers can't claim the
        // same slot and overshoot the limit.
        this._chain = Promise.resolve();
    }

    /** ms to wait before a slot frees up; 0 if one is available right now. */
    _delayUntilSlot() {
        const t = this.now();
        let wait = Math.max(0, this.pausedUntil - t);

        for (const w of this.windows) {
            // Drop hits that have aged out of the window
            while (w.hits.length && w.hits[0] <= t - w.intervalMs) w.hits.shift();
            if (w.hits.length >= w.limit) {
                wait = Math.max(wait, w.hits[0] + w.intervalMs - t);
            }
        }
        return wait;
    }

    _record() {
        const t = this.now();
        for (const w of this.windows) w.hits.push(t);
    }

    /** Block until a request slot is available, then consume it. */
    acquire() {
        const run = async () => {
            for (;;) {
                const wait = this._delayUntilSlot();
                if (wait <= 0) break;
                await this.sleep(wait);
            }
            this._record();
        };
        // Chain regardless of whether the previous link resolved or rejected
        this._chain = this._chain.then(run, run);
        return this._chain;
    }

    /** Halt all traffic for `ms` — used when Riot tells us to back off. */
    pauseFor(ms) {
        this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
    }

    /**
     * Run `fn` under the limiter, retrying on 429 and transient 5xx/network
     * errors. Non-retryable errors (401, 403, 404, ...) propagate immediately.
     *
     * @param {() => Promise<any>} fn
     * @param {object} [opts]
     * @param {string} [opts.label] - shown in log output
     * @param {number} [opts.retries] - instead of maxRetries (0: fail fast)
     */
    async request(fn, opts = {}) {
        const label = opts.label ? ` (${opts.label})` : '';
        const maxRetries = Number.isInteger(opts.retries) ? opts.retries : this.maxRetries;

        for (let attempt = 0; ; attempt++) {
            await this.acquire();
            try {
                return await fn();
            } catch (err) {
                const status = err.response?.status;
                // No response at all = network blip, worth retrying
                const retryable = status === undefined || RETRYABLE_STATUS.has(status);

                if (!retryable || attempt >= maxRetries) throw err;

                let waitMs;
                if (status === 429) {
                    const retryAfter = Number(err.response?.headers?.['retry-after']);
                    waitMs = Number.isFinite(retryAfter) && retryAfter > 0
                        ? retryAfter * 1000
                        : this._backoff(attempt);
                    const kind = err.response?.headers?.['x-rate-limit-type'] || 'unknown';
                    this.log(`429 rate limited${label} [${kind}] — pausing ${waitMs}ms`);
                    // Pause every caller, not just this one
                    this.pauseFor(waitMs);
                } else {
                    waitMs = this._backoff(attempt);
                    this.log(`${status ?? 'network error'}${label} — retry ${attempt + 1}/${maxRetries} in ${waitMs}ms`);
                }

                await this.sleep(waitMs);
            }
        }
    }

    /** Exponential backoff with jitter, capped at maxBackoffMs. */
    _backoff(attempt) {
        const base = Math.min(this.maxBackoffMs, 500 * Math.pow(2, attempt));
        return Math.round(base + Math.random() * 250);
    }
}

module.exports = { RateLimiter, DEFAULT_WINDOWS, sleep };
