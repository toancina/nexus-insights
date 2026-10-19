const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const util = require('util');
const axios = require('axios');
const { SRC } = require('./helpers');

const riotApi = require(path.join(SRC, 'services', 'riotApi.js'));

const KEY = 'RGAPI-12345678-dead-beef-cafe-0123456789ab';

/** A fake Riot. `handler(req, res)` answers; every request's key is recorded. */
function fakeRiot(handler) {
    const seenKeys = [];
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            seenKeys.push(req.headers['x-riot-token']);
            handler(req, res);
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, seenKeys }));
    });
}

/** Send riotApi's https://*.api.riotgames.com calls to `base` instead. */
function redirectRiot(t, base) {
    const realGet = axios.get;
    axios.get = (url, opts) => realGet(url.replace(/^https:\/\/[^/]+\.api\.riotgames\.com/, base), opts);
    t.after(() => { axios.get = realGet; });
}

/** Every way the error could end up in a log. */
function everyRendering(err) {
    return [
        util.inspect(err, { depth: Infinity, showHidden: true }),
        String(err),
        err.stack || '',
        JSON.stringify(typeof err.toJSON === 'function' ? err.toJSON() : err),
    ].join('\n');
}

function denyWith(status, body, headers = {}) {
    return (req, res) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
    };
}

const CHECK = { apiKey: KEY, gameName: 'Name', tagLine: 'TAG', platform: 'euw1' };

for (const [status, message] of [[401, 'Unauthorized'], [403, 'Forbidden']]) {
    test(`a ${status} from Riot carries no API key`, async (t) => {
        const { server, seenKeys } = await fakeRiot(denyWith(status, { status: { message, status_code: status } }));
        t.after(() => server.close());
        redirectRiot(t, `http://127.0.0.1:${server.address().port}`);

        const err = await riotApi.verifyAccount(CHECK).then(() => null, e => e);
        assert.ok(err, 'the call failed');
        assert.equal(seenKeys[0], KEY, 'the key was really sent');

        assert.ok(!everyRendering(err).includes(KEY), 'key not in any rendering of the error');
        assert.ok(!everyRendering(err).includes('12345678-dead'), 'not even part of it');

        // What the rest of the app reads is still there
        assert.equal(err.response.status, status);
        assert.equal(err.response.data.status.message, message);
        assert.equal(err.step, 'account');
    });
}

test('a 429 keeps Retry-After and the rate-limit type, drops the key', async (t) => {
    const { server } = await fakeRiot(denyWith(429, { status: { status_code: 429 } },
        { 'Retry-After': '7', 'X-Rate-Limit-Type': 'application' }));
    t.after(() => server.close());
    redirectRiot(t, `http://127.0.0.1:${server.address().port}`);

    const err = await riotApi.verifyAccount(CHECK).then(() => null, e => e);
    assert.ok(!everyRendering(err).includes(KEY));
    assert.equal(err.response.status, 429);
    assert.equal(err.response.headers['retry-after'], '7');
    assert.equal(err.response.headers['x-rate-limit-type'], 'application');
});

test('a network error (nothing listening) carries no API key', async (t) => {
    const { server } = await fakeRiot(() => {});
    const port = server.address().port;
    await new Promise(r => server.close(r));     // free port, nothing answers
    redirectRiot(t, `http://127.0.0.1:${port}`);

    const err = await riotApi.verifyAccount(CHECK).then(() => null, e => e);
    assert.ok(err && !err.response, 'failed without a response');
    assert.ok(!everyRendering(err).includes(KEY));
});

test('a successful call still returns the data', async (t) => {
    const { server, seenKeys } = await fakeRiot((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(req.url.includes('/riot/account/') ? { puuid: 'p-1' } : { id: 's' }));
    });
    t.after(() => server.close());
    redirectRiot(t, `http://127.0.0.1:${server.address().port}`);

    assert.equal(await riotApi.verifyAccount(CHECK), 'p-1');
    assert.deepEqual(seenKeys, [KEY, KEY]);
});

test('scrubKey leaves non-axios errors alone', () => {
    const plain = new Error('boom');
    assert.equal(riotApi.scrubKey(plain), plain);
    assert.equal(plain.message, 'boom');
    assert.equal(riotApi.scrubKey(null), null);
});
