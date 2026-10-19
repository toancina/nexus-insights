/**
 * #91: the window asks the main process to chat; main holds the key and makes
 * the call. These tests run the whole path in one process:
 *
 *   remote client (window) → fake IPC (structured clone, like Electron) →
 *   chat bridge (main) → OpenAI-compatible client → fake provider on 127.0.0.1
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { SRC } = require('./helpers');

const { createChatBridge, registerChatIpc } = require(path.join(SRC, 'services', 'chatBridge.js'));
const { PROVIDERS } = require(path.join(SRC, 'services', 'chatProviders.js'));
const { createSecretStore } = require(path.join(SRC, 'services', 'secretStore.js'));
const { createRemoteClient, keyApi } = require(path.join(SRC, 'components', 'chatRemote.js'));

const KEY = 'mistral-test-key-0123456789SECRET';

function fakeSafeStorage() {
    const flip = buf => Buffer.from(buf.map(b => b ^ 0x5a));
    return {
        isEncryptionAvailable: () => true,
        encryptString: s => Buffer.concat([Buffer.from('FAKE'), flip(Buffer.from(s, 'utf8'))]),
        decryptString: buf => flip(buf.subarray(4)).toString('utf8'),
    };
}

/** A fake provider that records each request's path and Authorization header. */
function fakeProvider(t, handler) {
    const requests = [];
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', () => {
                requests.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
                handler(req, res);
            });
        });
        t.after(() => { if (server.closeAllConnections) server.closeAllConnections(); server.close(); });
        server.listen(0, '127.0.0.1', () => resolve({ requests, base: `http://127.0.0.1:${server.address().port}/v1` }));
    });
}

const modelsReply = (res) => res.end(JSON.stringify({ data: [{ id: 'mistral-small-latest' }] }));
const sse = (chunks) => chunks.map(c => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('');
const delta = (d) => ({ choices: [{ index: 0, delta: d }] });

/** ipcMain + ipcRenderer stand-ins. Arguments and results are structured-cloned, as Electron does. */
function fakeIpc() {
    const handlers = new Map();
    const mainListeners = new Map();
    const windowListeners = new Map();
    const sender = {
        isDestroyed: () => false,
        send: (channel, payload) => (windowListeners.get(channel) || []).forEach(fn => fn({}, structuredClone(payload))),
    };
    const ipcMain = {
        handle: (channel, fn) => handlers.set(channel, fn),
        on: (channel, fn) => mainListeners.set(channel, fn),
    };
    const ipcRenderer = {
        invoke: async (channel, ...args) => structuredClone(await handlers.get(channel)({ sender }, ...structuredClone(args))),
        send: (channel, ...args) => mainListeners.get(channel)({ sender }, ...structuredClone(args)),
        on: (channel, fn) => windowListeners.set(channel, [...(windowListeners.get(channel) || []), fn]),
        removeListener: (channel, fn) => windowListeners.set(channel, (windowListeners.get(channel) || []).filter(f => f !== fn)),
        listenerCount: (channel) => (windowListeners.get(channel) || []).length,
    };
    return { ipcMain, ipcRenderer, handlers };
}

/** A bridge over a real secret store in a temp folder, with Mistral pointed at `mistralBase`. */
function setup(t, mistralBase = 'https://api.mistral.ai/v1') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-bridge-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'secrets.json');
    const store = createSecretStore({ safeStorage: fakeSafeStorage(), file });
    const providers = { ...PROVIDERS, mistral: { ...PROVIDERS.mistral, baseUrl: mistralBase } };
    const bridge = createChatBridge({ store, providers });
    const ipc = fakeIpc();
    registerChatIpc(ipc.ipcMain, bridge);
    return { file, store, bridge, ...ipc, keys: keyApi(ipc.ipcRenderer) };
}

test('saving a key returns its status, never the key', async (t) => {
    const { keys } = setup(t);
    const status = await keys.set('mistral', { key: `  ${KEY}  ` });
    assert.deepEqual(status, { saved: true, last4: 'CRET', persisted: true, baseUrl: 'https://api.mistral.ai/v1' });
    assert.deepEqual(await keys.status('mistral'), status);
    assert.ok(!JSON.stringify(await keys.status('mistral')).includes(KEY));
});

test('no IPC channel hands the key to the window', async (t) => {
    const { base } = await fakeProvider(t, (req, res) => modelsReply(res));
    const { keys, handlers, ipcRenderer } = setup(t, base);
    const answers = [await keys.set('mistral', { key: KEY })];
    for (const channel of handlers.keys()) {
        if (channel === 'chat:setKey' || channel === 'chat:removeKey') continue;
        answers.push(await ipcRenderer.invoke(channel, channel === 'chat:send'
            ? { id: 'x', provider: 'mistral', model: 'm', messages: [] }
            : 'mistral'));
    }
    answers.push(await keys.remove('mistral'));
    assert.ok(answers.length >= 5);
    assert.ok(!JSON.stringify(answers).includes(KEY));
});

test('chat goes to the provider with the stored key, and streams deltas to the window', async (t) => {
    const { requests, base } = await fakeProvider(t, (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(sse([delta({ content: 'Hi ' }), delta({ content: 'there' }), '[DONE]']));
    });
    const { keys, ipcRenderer } = setup(t, base);
    await keys.set('mistral', { key: KEY });
    const deltas = [];
    const out = await createRemoteClient({ provider: 'mistral', ipc: ipcRenderer }).chat({
        model: 'mistral-small-latest', messages: [{ role: 'user', content: 'hello' }], onDelta: d => deltas.push(d),
    });
    assert.equal(out.content, 'Hi there');
    assert.deepEqual(deltas, ['Hi ', 'there']);
    assert.equal(requests[0].url, '/v1/chat/completions');
    assert.equal(requests[0].auth, `Bearer ${KEY}`);
    assert.equal(ipcRenderer.listenerCount('chat:delta'), 0, 'the delta listener is removed afterwards');
});

test('the models list comes through the bridge', async (t) => {
    const { requests, base } = await fakeProvider(t, (req, res) => modelsReply(res));
    const { keys, ipcRenderer } = setup(t, base);
    await keys.set('mistral', { key: KEY });
    const models = await createRemoteClient({ provider: 'mistral', ipc: ipcRenderer }).listModels();
    assert.deepEqual(models, [{ name: 'mistral-small-latest', cloud: true }]);
    assert.equal(requests[0].auth, `Bearer ${KEY}`);
});

test('the key only goes to the base URL saved with it, whatever the window sends', async (t) => {
    const saved = await fakeProvider(t, (req, res) => modelsReply(res));
    const other = await fakeProvider(t, (req, res) => modelsReply(res));
    const { keys, ipcRenderer } = setup(t);
    await keys.set('openai', { key: KEY, baseUrl: saved.base });
    await ipcRenderer.invoke('chat:models', 'openai', { baseUrl: other.base });
    await ipcRenderer.invoke('chat:send', { id: 'x', provider: 'openai', baseUrl: other.base, model: 'm', messages: [] });
    assert.equal(other.requests.length, 0);
    assert.ok(saved.requests.length >= 1);
});

test('Mistral\'s base URL is fixed; a base URL sent with the key is ignored', async (t) => {
    const { keys } = setup(t);
    const status = await keys.set('mistral', { key: KEY, baseUrl: 'https://evil.example.com/v1' });
    assert.equal(status.baseUrl, 'https://api.mistral.ai/v1');
});

test('OpenAI-compatible needs an https base URL (http only on this PC)', async (t) => {
    const { keys } = setup(t);
    await assert.rejects(keys.set('openai', { key: KEY }), /base URL/i);
    await assert.rejects(keys.set('openai', { key: KEY, baseUrl: 'http://api.example.com/v1' }), /https/);
    const ok = await keys.set('openai', { key: KEY, baseUrl: 'https://openrouter.ai/api/v1/' });
    assert.equal(ok.baseUrl, 'https://openrouter.ai/api/v1');
});

test('keys that cannot be real are refused before anything is saved', async (t) => {
    const { keys, file } = setup(t);
    for (const bad of ['', '   ', 'short', 'has a space in it 123', `line\nbreak-0123456789`, 'x'.repeat(600), 42, null]) {
        await assert.rejects(keys.set('mistral', { key: bad }), /API key/, String(bad));
    }
    assert.ok(!fs.existsSync(file));
});

test('an unknown provider is refused', async (t) => {
    const { keys, ipcRenderer } = setup(t);
    await assert.rejects(keys.set('__proto__', { key: KEY }), /provider/i);
    await assert.rejects(keys.status('ollama'), /provider/i);
    await assert.rejects(createRemoteClient({ provider: 'constructor', ipc: ipcRenderer }).listModels(), /provider/i);
});

test('without a saved key, chat says to add one (code survives IPC)', async (t) => {
    const { ipcRenderer } = setup(t);
    await assert.rejects(createRemoteClient({ provider: 'mistral', ipc: ipcRenderer }).chat({ model: 'm', messages: [] }), err => {
        assert.equal(err.code, 'NO_KEY');
        assert.match(err.message, /Mistral API key/);
        return true;
    });
});

test('a rejected key reaches the window as KEY_REJECTED', async (t) => {
    const { base } = await fakeProvider(t, (req, res) => { res.writeHead(401); res.end('{"message":"Unauthorized"}'); });
    const { keys, ipcRenderer } = setup(t, base);
    await keys.set('mistral', { key: KEY });
    await assert.rejects(createRemoteClient({ provider: 'mistral', ipc: ipcRenderer }).listModels(), err => {
        assert.equal(err.code, 'KEY_REJECTED');
        assert.ok(!String(err.message).includes(KEY));
        return true;
    });
});

test('remove forgets the key', async (t) => {
    const { keys } = setup(t);
    await keys.set('mistral', { key: KEY });
    const status = await keys.remove('mistral');
    assert.equal(status.saved, false);
    assert.equal((await keys.status('mistral')).saved, false);
});

test('Stop in the window aborts the request in main', async (t) => {
    const { base } = await fakeProvider(t, (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sse([delta({ content: 'thinking about it' })]));
        // never ends on its own
    });
    const { keys, ipcRenderer } = setup(t, base);
    await keys.set('mistral', { key: KEY });
    const ac = new AbortController();
    const p = createRemoteClient({ provider: 'mistral', ipc: ipcRenderer }).chat({
        model: 'm', messages: [], signal: ac.signal, onDelta: () => ac.abort(),
    });
    await assert.rejects(p, err => err.name === 'AbortError');
});
