/**
 * openaiChat.js — Chat through Mistral or any OpenAI-compatible API (#91).
 *
 * Same shape as services/ollama.js (listModels(), streaming chat() with tools
 * and abort), so chatAgent.js doesn't care which one it talks to. Runs in the
 * MAIN process (services/chatBridge.js): the API key never reaches the window.
 *
 *   GET  {baseUrl}/models
 *   POST {baseUrl}/chat/completions   stream: true, server-sent events
 *
 * The agent keeps its conversation in Ollama's format; toOpenAiMessages()
 * converts it (string tool arguments, tool_call_id on every tool result).
 * Errors never carry the key: provider messages are scrubbed of it.
 */

const http = require('http');
const https = require('https');
const { createLineSplitter } = require('./ollama');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
// OpenAI-style lists have no capabilities; leave out what obviously can't chat
const NOT_CHAT = /embed|whisper|tts|dall-e|moderation|transcri|realtime|-audio|image|ocr/i;

/** https anywhere; plain http only on this PC (a local server), so the key never crosses a network unencrypted. */
function isAllowedBaseUrl(text) {
    let u;
    try { u = new URL(String(text || '')); } catch { return false; }
    return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
}

/** 9 letters/digits: Mistral rejects other tool call ids. */
const makeId = (n) => `call${String(n).padStart(5, '0')}`;

/** The agent's (Ollama-format) conversation → OpenAI chat messages. */
function toOpenAiMessages(messages) {
    const out = [];
    let pending = [];    // ids of the last assistant turn's tool calls, matched to results in order
    let n = 0;
    for (const m of messages || []) {
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
            const calls = m.tool_calls.map(c => {
                const fn = c.function || {};
                const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {});
                return { id: c.id || makeId(n++), type: 'function', function: { name: fn.name, arguments: args } };
            });
            pending = calls.map(c => c.id);
            out.push({ role: 'assistant', content: m.content || '', tool_calls: calls });
        } else if (m.role === 'tool') {
            out.push({ role: 'tool', tool_call_id: pending.shift() || makeId(n++), content: String(m.content ?? '') });
        } else if (m.role === 'system' && out.length) {
            // A later instruction ("answer now"): Mistral rejects a conversation ending on a system message
            out.push({ role: 'user', content: m.content });
        } else {
            out.push({ role: m.role, content: m.content ?? '' });
        }
    }
    return out;
}

function abortError() {
    const e = new Error('Stopped');
    e.name = 'AbortError';
    return e;
}

function createOpenAiClient({ baseUrl, apiKey, label = 'The provider' }) {
    if (!isAllowedBaseUrl(baseUrl)) {
        throw new Error('The base URL must start with https:// (plain http only for a server on this PC).');
    }
    const base = new URL(String(baseUrl).replace(/\/+$/, '') + '/');
    const scrub = (text) => (apiKey ? String(text).split(apiKey).join('[key]') : String(text));

    function httpError(status, text) {
        let msg = '';
        try {
            const body = JSON.parse(text);
            const raw = (body.error && (body.error.message || body.error)) || body.message || body.detail;
            msg = typeof raw === 'string' ? raw : raw ? JSON.stringify(raw) : '';
        } catch { msg = text; }
        let e;
        if (status === 401 || status === 403) {
            e = new Error(`${label} rejected the API key. Check it under Provider on the Chat page.`);
            e.code = 'KEY_REJECTED';
        } else if (status === 429) {
            e = new Error(`${label}: rate limit reached. Wait a minute and try again.`);
            e.code = 'RATE_LIMIT';
        } else {
            e = new Error(scrub(msg || `${label} returned HTTP ${status}`).slice(0, 500));
        }
        e.status = status;
        return e;
    }

    function networkError(err) {
        const e = new Error(`Couldn't reach ${label} (${scrub(err.code || err.message)}). Check your internet connection.`);
        e.code = 'NETWORK';
        return e;
    }

    function request(method, path, body, { onLine, signal, timeoutMs = 0 } = {}) {
        return new Promise((resolve, reject) => {
            if (signal && signal.aborted) return reject(abortError());
            const url = new URL(path, base);
            const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
            const lib = url.protocol === 'https:' ? https : http;
            const req = lib.request(url, {
                method,
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    Accept: onLine ? 'text/event-stream' : 'application/json',
                    ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
                },
            }, res => {
                res.setEncoding('utf8');
                const status = res.statusCode || 0;
                if (status >= 400) {
                    let text = '';
                    res.on('data', c => { text += c; });
                    res.on('end', () => reject(httpError(status, text)));
                    return;
                }
                if (onLine) {
                    const split = createLineSplitter(onLine);
                    res.on('data', c => split.push(c));
                    res.on('end', () => { split.end(); resolve(); });
                } else {
                    let text = '';
                    res.on('data', c => { text += c; });
                    res.on('end', () => {
                        try { resolve(text ? JSON.parse(text) : null); }
                        catch { reject(new Error(`${label} sent an unreadable response.`)); }
                    });
                }
                res.on('error', err => reject(signal && signal.aborted ? abortError() : networkError(err)));
                // Destroyed mid-stream (Stop pressed): 'end' never fires, 'close' does
                res.on('close', () => { if (signal && signal.aborted) reject(abortError()); });
            });

            req.on('error', err => reject(signal && signal.aborted ? abortError() : networkError(err)));
            if (timeoutMs) {
                req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
            }
            if (signal) signal.addEventListener('abort', () => req.destroy(abortError()), { once: true });
            if (payload) req.write(payload);
            req.end();
        });
    }

    /** Chat models that can call tools: [{ name, cloud: true }], by name. */
    async function listModels({ signal } = {}) {
        const data = await request('GET', 'models', undefined, { signal, timeoutMs: 10000 });
        const names = ((data && data.data) || [])
            .filter(m => m && m.id && (m.capabilities
                ? m.capabilities.completion_chat !== false && m.capabilities.function_calling !== false
                : !NOT_CHAT.test(m.id)))
            .map(m => m.id);
        return [...new Set(names)].sort((a, b) => a.localeCompare(b)).map(name => ({ name, cloud: true }));
    }

    /**
     * One chat completion, streamed. Resolves with { content, thinking, tool_calls };
     * tool calls have string arguments, as the OpenAI format sends them.
     */
    async function chat({ model, messages, tools, options: modelOptions, onDelta, onThinking, signal }) {
        const body = { model, messages: toOpenAiMessages(messages), stream: true };
        if (tools && tools.length) body.tools = tools;
        if (modelOptions && Number.isFinite(modelOptions.temperature)) body.temperature = modelOptions.temperature;

        const out = { content: '', thinking: '', tool_calls: [] };
        const calls = [];
        let streamError = null;

        const addText = (text) => { if (text) { out.content += text; if (onDelta) onDelta(text); } };
        const addThinking = (text) => { if (text) { out.thinking += text; if (onThinking) onThinking(text); } };

        await request('POST', 'chat/completions', body, {
            signal,
            timeoutMs: 120000,
            onLine: line => {
                if (!line.startsWith('data:')) return;          // comments, event names
                const data = line.slice(5).trim();
                if (!data || data === '[DONE]') return;
                let obj;
                try { obj = JSON.parse(data); } catch { return; }
                if (obj.error) {
                    streamError = new Error(scrub(obj.error.message || JSON.stringify(obj.error)));
                    return;
                }
                const d = (obj.choices && obj.choices[0] && obj.choices[0].delta) || {};
                if (typeof d.content === 'string') addText(d.content);
                else if (Array.isArray(d.content)) {
                    // Mistral reasoning models: [{type:'thinking', thinking:[…]}, {type:'text', text}]
                    for (const part of d.content) {
                        if (part.type === 'text') addText(part.text);
                        else if (part.type === 'thinking') addThinking((part.thinking || []).map(t => t.text || '').join(''));
                    }
                }
                for (const tc of d.tool_calls || []) {
                    const i = Number.isInteger(tc.index) ? tc.index : calls.length;
                    const c = calls[i] || (calls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } });
                    const fn = tc.function || {};
                    if (tc.id) c.id = tc.id;
                    if (fn.name) c.function.name = fn.name;
                    if (typeof fn.arguments === 'string') c.function.arguments += fn.arguments;
                    else if (fn.arguments) c.function.arguments = JSON.stringify(fn.arguments);
                }
            },
        });

        if (streamError) throw streamError;
        out.tool_calls = calls.filter(Boolean);
        return out;
    }

    return { listModels, chat };
}

module.exports = { createOpenAiClient, toOpenAiMessages, isAllowedBaseUrl };
