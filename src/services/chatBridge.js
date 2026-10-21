/**
 * chatBridge.js — cloud chat in the main process (#91).
 *
 * The window runs with nodeIntegration and no context isolation, so anything
 * it holds, any script in it could read. The API key therefore stays here:
 * the window saves a key (chat:setKey), asks for models (chat:models) and
 * sends a conversation (chat:send); this module decrypts the key
 * (services/secretStore.js), makes the call (services/openaiChat.js) and
 * streams text back (chat:delta / chat:thinking). The window only ever learns
 * whether a key is saved and its last 4 characters.
 *
 * The base URL a key may be sent to is saved with it, encrypted. Calls never
 * take a URL from the window, so a script there can't send the key elsewhere.
 */

const { createOpenAiClient, isAllowedBaseUrl, normalizeBaseUrl } = require('./openaiChat');
const { PROVIDERS } = require('./chatProviders');

const KEY_PATTERN = /^\S{8,512}$/;

function createChatBridge({ store, providers = PROVIDERS, createClient = createOpenAiClient }) {
    const running = new Map();   // request id → AbortController

    function providerOf(id) {
        if (typeof id !== 'string' || !Object.hasOwn(providers, id)) throw new Error('Unknown chat provider.');
        return providers[id];
    }

    function keyStatus(id) {
        const p = providerOf(id);
        const s = store.status(id);
        return { saved: s.saved, last4: s.last4, persisted: s.persisted, baseUrl: p.baseUrl || (s.extra && s.extra.baseUrl) || null };
    }

    function setKey(id, { key, baseUrl } = {}) {
        const p = providerOf(id);
        const secret = typeof key === 'string' ? key.trim() : '';
        if (!KEY_PATTERN.test(secret)) {
            throw new Error("That doesn't look like an API key. Paste the whole key, with no spaces.");
        }
        let url = p.baseUrl;
        if (!url) {
            url = typeof baseUrl === 'string' ? normalizeBaseUrl(baseUrl) : '';
            if (!url) throw new Error('Enter the base URL of the API, for example https://api.openai.com/v1.');
            if (!isAllowedBaseUrl(url)) throw new Error('The base URL must start with https:// (plain http only for a server on this PC).');
        }
        store.set(id, secret, { baseUrl: url });
        return keyStatus(id);
    }

    function removeKey(id) {
        providerOf(id);
        store.remove(id);
        return keyStatus(id);
    }

    function clientFor(id) {
        const p = providerOf(id);
        const saved = store.get(id);
        if (!saved) throw Object.assign(new Error(`Add your ${p.label} API key first.`), { code: 'NO_KEY' });
        return createClient({ baseUrl: p.baseUrl || saved.extra.baseUrl, apiKey: saved.secret, label: p.label });
    }

    async function listModels(id) {
        return clientFor(id).listModels();
    }

    async function chat(requestId, id, { model, messages, tools, options } = {}, { onDelta, onThinking } = {}) {
        const client = clientFor(id);
        const ac = new AbortController();
        running.set(requestId, ac);
        try {
            return await client.chat({ model, messages, tools, options, onDelta, onThinking, signal: ac.signal });
        } finally {
            running.delete(requestId);
        }
    }

    function abort(requestId) {
        const ac = running.get(requestId);
        if (ac) ac.abort();
    }

    return { keyStatus, setKey, removeKey, listModels, chat, abort };
}

/** IPC drops an Error's code, so every answer is { ok, value } or { ok: false, error: { message, code, name } }. */
async function settle(fn) {
    try {
        return { ok: true, value: await fn() };
    } catch (err) {
        return { ok: false, error: { message: String((err && err.message) || err), code: (err && err.code) || null, name: (err && err.name) || 'Error' } };
    }
}

function registerChatIpc(ipcMain, bridge) {
    ipcMain.handle('chat:keyStatus', (e, provider) => settle(() => bridge.keyStatus(provider)));
    ipcMain.handle('chat:setKey', (e, provider, input) => settle(() => bridge.setKey(provider, input)));
    ipcMain.handle('chat:removeKey', (e, provider) => settle(() => bridge.removeKey(provider)));
    ipcMain.handle('chat:models', (e, provider) => settle(() => bridge.listModels(provider)));
    ipcMain.handle('chat:send', (e, req) => settle(() => {
        const { id, provider, model, messages, tools, options } = req || {};
        const send = (channel, text) => { if (!e.sender.isDestroyed()) e.sender.send(channel, { id, text }); };
        return bridge.chat(id, provider, { model, messages, tools, options }, {
            onDelta: text => send('chat:delta', text),
            onThinking: text => send('chat:thinking', text),
        });
    }));
    ipcMain.on('chat:abort', (e, id) => bridge.abort(id));
}

module.exports = { createChatBridge, registerChatIpc, settle };
