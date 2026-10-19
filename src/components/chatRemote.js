/**
 * chatRemote.js — the window's side of cloud chat (#91).
 *
 * Same shape as services/ollama.js (listModels(), chat()), but every call goes
 * over IPC to services/chatBridge.js in the main process, which holds the API
 * key and talks to the provider. Text streams back on chat:delta, matched by
 * request id; Stop sends chat:abort. `ipc` is Electron's ipcRenderer (a fake
 * in tests).
 */

let nextId = 0;

/** A bridge answer → its value, or the error rebuilt with its code and name. */
function unwrap(result) {
    if (result && result.ok) return result.value;
    const info = (result && result.error) || { message: 'Chat failed.' };
    const err = new Error(info.message);
    if (info.code) err.code = info.code;
    if (info.name && info.name !== 'Error') err.name = info.name;
    throw err;
}

/** Save / check / remove a provider's key. Answers carry its status, never the key. */
function keyApi(ipc) {
    return {
        status: async (provider) => unwrap(await ipc.invoke('chat:keyStatus', provider)),
        set: async (provider, { key, baseUrl } = {}) => unwrap(await ipc.invoke('chat:setKey', provider, { key, baseUrl })),
        remove: async (provider) => unwrap(await ipc.invoke('chat:removeKey', provider)),
    };
}

function createRemoteClient({ provider, ipc }) {
    async function listModels() {
        return unwrap(await ipc.invoke('chat:models', provider));
    }

    async function chat({ model, messages, tools, options, onDelta, onThinking, signal }) {
        const id = `chat-${Date.now()}-${++nextId}`;
        const forThis = (cb) => (_event, msg) => { if (msg && msg.id === id && cb) cb(msg.text); };
        const deltaListener = forThis(onDelta);
        const thinkingListener = forThis(onThinking);
        const stop = () => ipc.send('chat:abort', id);

        ipc.on('chat:delta', deltaListener);
        ipc.on('chat:thinking', thinkingListener);
        if (signal) signal.addEventListener('abort', stop, { once: true });
        try {
            return unwrap(await ipc.invoke('chat:send', { id, provider, model, messages, tools, options }));
        } finally {
            ipc.removeListener('chat:delta', deltaListener);
            ipc.removeListener('chat:thinking', thinkingListener);
            if (signal) signal.removeEventListener('abort', stop);
        }
    }

    return { listModels, chat };
}

module.exports = { createRemoteClient, keyApi };
