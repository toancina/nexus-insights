const test = require('node:test');
const assert = require('node:assert/strict');
const { RateLimiter } = require('../src/services/rateLimiter');

/**
 * Virtual clock so tests are instant and deterministic — no real waiting, and
 * the 2-minute window can be exercised without a 2-minute test.
 */
function fakeClock() {
    let t = 0;
    let timers = [];
    return {
        now: () => t,
        sleep: (ms) => new Promise(resolve => { timers.push({ at: t + ms, resolve }); }),
        hasTimers: () => timers.length > 0,
        /** Jump to the earliest deadline and release everything due then. */
        fireNext() {
            if (timers.length === 0) return false;
            const at = Math.min(...timers.map(x => x.at));
            t = Math.max(t, at);
            const due = timers.filter(x => x.at <= t);
            timers = timers.filter(x => x.at > t);
            due.forEach(x => x.resolve());
            return true;
        },
    };
}

/** Flush all pending microtasks. */
const flush = () => new Promise(r => setImmediate(r));

/**
 * Drive `promise` to completion on the virtual clock: alternate between
 * flushing microtasks and advancing time to the next scheduled wake-up.
 */
async function runAll(clock, promise) {
    let done = false;
    const tracked = promise.then(
        v => { done = true; return v; },
        e => { done = true; throw e; }
    );
    tracked.catch(() => {}); // don't trip unhandled-rejection while we pump

    for (let i = 0; i < 10_000 && !done; i++) {
        await flush();
        if (done) break;
        if (!clock.fireNext()) break; // nothing pending and not done — stop
    }
    return tracked;
}

test('allows requests up to the window limit without waiting', async () => {
    const clock = fakeClock();
    const rl = new RateLimiter([{ limit: 3, intervalMs: 1000 }], { now: clock.now, sleep: clock.sleep });

    const order = [];
    await runAll(clock, Promise.all([1, 2, 3].map(i => rl.request(async () => order.push(i)))));

    assert.deepEqual(order, [1, 2, 3]);
    assert.equal(clock.now(), 0, 'no waiting needed under the limit');
});

test('delays the request that exceeds the window', async () => {
    const clock = fakeClock();
    const rl = new RateLimiter([{ limit: 2, intervalMs: 1000 }], { now: clock.now, sleep: clock.sleep });

    const times = [];
    await runAll(clock, Promise.all([1, 2, 3].map(() => rl.request(async () => times.push(clock.now())))));

    assert.deepEqual(times.slice(0, 2), [0, 0]);
    assert.equal(times[2], 1000, 'third request waits for the window to roll over');
});

test('enforces both windows simultaneously', async () => {
    const clock = fakeClock();
    // The old 150ms-sleep approach respected 20/s but ignored 100/2min.
    const rl = new RateLimiter(
        [{ limit: 20, intervalMs: 1000 }, { limit: 5, intervalMs: 10_000 }],
        { now: clock.now, sleep: clock.sleep }
    );

    const times = [];
    await runAll(clock, Promise.all(Array.from({ length: 6 }, () => rl.request(async () => times.push(clock.now())))));

    assert.equal(times.filter(t => t === 0).length, 5, 'per-second limit alone would allow all 6');
    assert.equal(times[5], 10_000, 'the long window holds the 6th back');
});

test('retries a 429 and honours Retry-After', async () => {
    const clock = fakeClock();
    const rl = new RateLimiter([{ limit: 100, intervalMs: 1000 }], { now: clock.now, sleep: clock.sleep });

    let calls = 0;
    const p = rl.request(async () => {
        calls++;
        if (calls === 1) {
            const err = new Error('Too Many Requests');
            err.response = { status: 429, headers: { 'retry-after': '3' } };
            throw err;
        }
        return 'ok';
    });
    assert.equal(await runAll(clock, p), 'ok');
    assert.equal(calls, 2);
    assert.ok(clock.now() >= 3000, `waited ${clock.now()}ms, expected >= 3000`);
});

test('a 429 pauses other in-flight callers too', async () => {
    const clock = fakeClock();
    const rl = new RateLimiter([{ limit: 100, intervalMs: 1000 }], { now: clock.now, sleep: clock.sleep });

    let first = true;
    const p1 = rl.request(async () => {
        if (first) {
            first = false;
            const err = new Error('429');
            err.response = { status: 429, headers: { 'retry-after': '5' } };
            throw err;
        }
        return 'a';
    });
    const p2 = rl.request(async () => 'b');

    await runAll(clock, Promise.all([p1, p2]));

    assert.ok(clock.now() >= 5000, 'the whole limiter backed off, not just the failing call');
});

test('retries transient 5xx with backoff', async () => {
    const clock = fakeClock();
    const rl = new RateLimiter([{ limit: 100, intervalMs: 1000 }], { now: clock.now, sleep: clock.sleep });

    let calls = 0;
    const p = rl.request(async () => {
        calls++;
        if (calls < 3) {
            const err = new Error('bad gateway');
            err.response = { status: 502, headers: {} };
            throw err;
        }
        return 'recovered';
    });
    assert.equal(await runAll(clock, p), 'recovered');
    assert.equal(calls, 3);
});

test('does NOT retry a 403 (bad or expired key)', async () => {
    const clock = fakeClock();
    const rl = new RateLimiter([{ limit: 100, intervalMs: 1000 }], { now: clock.now, sleep: clock.sleep });

    let calls = 0;
    const p = rl.request(async () => {
        calls++;
        const err = new Error('Forbidden');
        err.response = { status: 403, headers: {} };
        throw err;
    });
    await assert.rejects(runAll(clock, p), /Forbidden/);
    assert.equal(calls, 1, 'a dead API key should fail fast, not retry 5 times');
});

test('gives up after maxRetries and rethrows', async () => {
    const clock = fakeClock();
    const rl = new RateLimiter([{ limit: 100, intervalMs: 1000 }], {
        now: clock.now, sleep: clock.sleep, maxRetries: 2,
    });

    let calls = 0;
    const p = rl.request(async () => {
        calls++;
        const err = new Error('always down');
        err.response = { status: 503, headers: {} };
        throw err;
    });
    await assert.rejects(runAll(clock, p), /always down/);
    assert.equal(calls, 3, 'initial attempt + 2 retries');
});

test('retries: 0 fails fast, e.g. the Settings check offline (#74)', async () => {
    const clock = fakeClock();
    const rl = new RateLimiter([{ limit: 100, intervalMs: 1000 }], { now: clock.now, sleep: clock.sleep });

    let calls = 0;
    const p = rl.request(async () => { calls++; throw new Error('ENOTFOUND'); }, { retries: 0 });
    await assert.rejects(runAll(clock, p), /ENOTFOUND/);
    assert.equal(calls, 1);
});
