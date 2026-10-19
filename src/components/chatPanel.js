/**
 * chatPanel.js — the Chat page: talk to a model about your games.
 *
 *   chatPanel (this file)  UI: provider + model picker, API key bar, messages, composer, status
 *   chatAgent.js           the tool-calling loop
 *   chatTools.js           the data tools (every number comes from here)
 *   services/ollama.js     HTTP client for a local Ollama (http://127.0.0.1:11434), the default
 *   chatRemote.js          cloud providers (#91): Mistral or any OpenAI-compatible API, over
 *                          IPC to services/chatBridge.js, which holds the key and makes the calls
 *   markdown.js            safe rendering of the model's answers
 *
 * The API key is typed here once, sent to the main process and encrypted
 * there (services/secretStore.js). This window never gets it back: only
 * "saved, ends in a1b2".
 *
 * Exposes window.openChatPanel(), called by switchTopTab('chat').
 */

const { ipcRenderer }   = require('electron');
const { createClient }  = require('../services/ollama');
const { createRemoteClient, keyApi } = require('./chatRemote');
const { PROVIDERS }     = require('../services/chatProviders');
const { loadConfig }    = require('../services/config');
const {
    getCoachingData, getLpReadings, absoluteLp,
} = require('../services/matchService');
const chatTools          = require('./chatTools');
const { runAgent, buildSystemPrompt, stripThink, trimHistory } = require('./chatAgent');
const { renderMarkdown } = require('./markdown');
const { escapeHtml }     = require('./dom');
const { seasonStart }    = require('../services/syncOrder');
const statHistory        = require('./statHistory');
const CoachingEngine     = require('./coachingEngine');

const PREFERRED_MODEL = 'qwen3:8b';
const MODEL_KEY       = 'nexus.chatModel';      // Ollama's; cloud providers add ".<provider>"
const THINK_KEY       = 'nexus.chatThink';
const PROVIDER_KEY    = 'nexus.chatProvider';
const PROVIDER_OPTIONS = [['ollama', 'Ollama (this PC)'], ...Object.values(PROVIDERS).map(p => [p.id, p.label])];

// num_ctx: Ollama's default context is small and silently truncates the
// START of the conversation — i.e. the system prompt and tool rules — once
// tool results pile up. 8k fits several tool rounds of the compact results.
// Cloud providers use only the temperature.
const MODEL_OPTIONS = { num_ctx: 8192, temperature: 0.4 };

const SUGGESTIONS = [
    'How did my last 10 games go?',
    'Which champions should I play more in Solo/Duo?',
    'How has my win rate changed this year?',
    'What should I focus on to climb?',
    'Where am I weakest in the laning phase?',
    'Compare my Solo/Duo and Flex results',
];

const ollama = createClient();
const remoteClients = {};
const keys = keyApi(ipcRenderer);

const state = {
    initialised: false,
    provider: 'ollama',
    keyStatus: null,    // cloud provider: { saved, last4, persisted, baseUrl }
    editingKey: false,
    models: [],
    model: null,
    up: false,          // the provider answered: Ollama running, or the key accepted
    history: [],        // [{ role, content }] — final texts only
    busy: false,
    abort: null,
};
let refreshGen = 0;     // the provider can change while a check is running

const $ = id => document.getElementById(id);

function storageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function storageSet(key, v) { try { localStorage.setItem(key, v); } catch { /* storage unavailable */ } }

const isCloud = () => state.provider !== 'ollama';
const providerInfo = () => PROVIDERS[state.provider] || null;
const modelKey = () => (isCloud() ? `${MODEL_KEY}.${state.provider}` : MODEL_KEY);

function client() {
    if (!isCloud()) return ollama;
    if (!remoteClients[state.provider]) {
        remoteClients[state.provider] = createRemoteClient({ provider: state.provider, ipc: ipcRenderer });
    }
    return remoteClients[state.provider];
}

function hostOf(url) {
    try { return new URL(url).host; } catch { return ''; }
}

// ---------------------------------------------------------------------------
// Status, provider + model picker, key bar
// ---------------------------------------------------------------------------

function setStatus(kind, text) {
    const el = $('chatStatus');
    if (!el) return;
    el.className = `chat-status chat-status--${kind}`;
    el.querySelector('span').textContent = text;
}

function currentModelInfo() {
    return state.models.find(m => m.name === state.model) || null;
}

function updateFoot() {
    const foot = $('chatFoot');
    if (!foot) return;
    if (isCloud()) {
        const p = providerInfo();
        const host = hostOf(state.keyStatus && state.keyStatus.baseUrl) || p.label;
        foot.innerHTML = /^(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(host)
            ? `<b>${escapeHtml(p.label)}</b> runs on this PC (${escapeHtml(host)}). Your API key stays encrypted on this PC.`
            : `<span class="chat-foot-warn">☁ <b>${escapeHtml(p.label)}</b> runs on ${escapeHtml(host)}: your questions and the stats the app sends it leave your PC.</span> Your API key stays encrypted on this PC.`;
        return;
    }
    const m = currentModelInfo();
    foot.innerHTML = m && m.cloud
        ? `<span class="chat-foot-warn">☁ <b>${escapeHtml(m.name)}</b> runs on Ollama's servers — your questions and the stats the app sends it leave your PC.</span>`
        : `Runs on your PC with Ollama — nothing leaves your machine. Numbers come from your matches; the model's explanations can still be wrong.`;
}

/** Ollama-only controls; the key bar only for cloud providers. */
function syncControls() {
    const think = $('chatThink');
    if (think && think.closest('label')) think.closest('label').style.display = isCloud() ? 'none' : '';
    const sel = $('chatProvider');
    if (sel) sel.value = state.provider;
}

function renderKeyBar() {
    const bar = $('chatKeyBar');
    if (!bar) return;
    if (!isCloud()) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
    bar.style.display = '';
    const p = providerInfo();
    const s = state.keyStatus || { saved: false, persisted: true };
    const where = s.persisted === false
        ? '<span class="chat-keybar-warn">This PC has no keyring to encrypt it, so it is kept only until you close the app.</span>'
        : 'Stored encrypted on this PC. Only the app\'s background process can read it.';

    if (s.saved && !state.editingKey) {
        const forUrl = !p.baseUrl && s.baseUrl ? ` for ${escapeHtml(s.baseUrl)}` : '';
        bar.innerHTML = `
            <span class="chat-keybar-text">🔒 <b>${escapeHtml(p.label)}</b> key saved (…${escapeHtml(s.last4 || '')})${forUrl}. ${where}</span>
            <button class="chat-btn" type="button" data-key-action="change">Change</button>
            <button class="chat-btn" type="button" data-key-action="remove">Remove</button>`;
        return;
    }

    const baseField = p.baseUrl ? '' : `
        <label class="chat-keyfield">
            <span>Base URL</span>
            <input type="url" id="chatBaseUrl" class="chat-input" spellcheck="false" autocomplete="off"
                   placeholder="https://api.openai.com/v1" value="${escapeHtml(s.baseUrl || '')}">
        </label>`;
    const getKey = p.keyUrl
        ? ` <a href="${escapeHtml(p.keyUrl)}" target="_blank" rel="noopener">Get a ${escapeHtml(p.label)} API key</a>`
        : '';
    bar.innerHTML = `
        <form class="chat-keyform" id="chatKeyForm" autocomplete="off">
            <label class="chat-keyfield">
                <span>${escapeHtml(p.label)} API key</span>
                <input type="password" id="chatKeyInput" class="chat-input" spellcheck="false" autocomplete="off" placeholder="Paste your key">
            </label>
            ${baseField}
            <button class="chat-btn chat-btn--primary" type="submit">Save key</button>
            ${s.saved ? '<button class="chat-btn" type="button" data-key-action="cancel">Cancel</button>' : ''}
        </form>
        <div class="chat-keybar-note">${where}${getKey}</div>
        <div class="chat-keybar-error" id="chatKeyError" role="alert"></div>`;
}

async function saveKey() {
    const input = $('chatKeyInput');
    const baseUrl = $('chatBaseUrl');
    const error = $('chatKeyError');
    const btn = document.querySelector('#chatKeyForm button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
        state.keyStatus = await keys.set(state.provider, {
            key: input ? input.value : '',
            baseUrl: baseUrl ? baseUrl.value : undefined,
        });
        if (input) input.value = '';
        state.editingKey = false;
        refreshModels();
    } catch (err) {
        if (error) error.textContent = err.message;
        if (btn) btn.disabled = false;
    }
}

async function removeKey() {
    try {
        state.keyStatus = await keys.remove(state.provider);
    } catch (err) {
        console.warn('Chat: removing the key failed:', err.message);
    }
    state.editingKey = false;
    refreshModels();
}

function pickModel(preferred) {
    const saved = storageGet(modelKey());
    const names = state.models.map(m => m.name);
    state.model = names.includes(saved) ? saved
                : names.includes(preferred) ? preferred
                : (state.models.find(m => !m.cloud) || state.models[0] || {}).name || null;
}

async function refreshModels() {
    const gen = ++refreshGen;
    syncControls();
    renderKeyBar();
    if (isCloud()) return refreshCloudModels(gen);

    setStatus('checking', 'Checking Ollama…');
    let models;
    try {
        models = await ollama.listModels();
    } catch (err) {
        if (gen !== refreshGen) return;
        state.models = [];
        state.up = false;
        setStatus('down', err.code === 'OLLAMA_DOWN' ? 'Ollama not running' : 'Ollama error');
        renderEmptyState(err.message);
        populatePicker();
        return;
    }
    if (gen !== refreshGen) return;
    // Local models first: they're the default and keep data on this PC
    state.models = models.sort((a, b) => (a.cloud - b.cloud) || a.name.localeCompare(b.name));
    state.up = true;
    pickModel(PREFERRED_MODEL);
    populatePicker();
    updateFoot();

    if (!state.model) {
        setStatus('down', 'No models installed');
        renderEmptyState(`Ollama is running but has no models. In Command Prompt run:  ollama pull ${PREFERRED_MODEL}`);
        return;
    }
    setStatus('ready', 'Ready');
    if (!state.history.length) renderEmptyState();
}

async function refreshCloudModels(gen) {
    const p = providerInfo();
    state.models = [];
    state.model = null;
    state.up = false;
    populatePicker();
    setStatus('checking', `Checking ${p.label}…`);

    try {
        state.keyStatus = await keys.status(state.provider);
    } catch (err) {
        state.keyStatus = null;
    }
    if (gen !== refreshGen) return;
    renderKeyBar();
    updateFoot();
    if (!state.keyStatus || !state.keyStatus.saved) {
        setStatus('down', 'No API key');
        renderEmptyState(`Add your ${p.label} API key above to chat with ${p.label}.`, { retry: false });
        return;
    }

    let models;
    try {
        models = await client().listModels();
    } catch (err) {
        if (gen !== refreshGen) return;
        setStatus('down', err.code === 'KEY_REJECTED' ? 'Key rejected' : err.code === 'NETWORK' ? 'Offline' : `${p.label} error`);
        renderEmptyState(err.message);
        return;
    }
    if (gen !== refreshGen) return;
    state.models = models;
    state.up = true;
    pickModel(p.defaultModel);
    populatePicker();
    updateFoot();

    if (!state.model) {
        setStatus('down', 'No models');
        renderEmptyState(`${p.label} lists no chat models that can use tools for this key.`);
        return;
    }
    setStatus('ready', 'Ready');
    if (!state.history.length) renderEmptyState();
}

function populatePicker() {
    const sel = $('chatModel');
    if (!sel) return;
    sel.innerHTML = state.models.length
        ? state.models.map(m =>
            `<option value="${escapeHtml(m.name)}"${m.name === state.model ? ' selected' : ''}>` +
            `${escapeHtml(m.name)}${m.cloud && !isCloud() ? '  ☁ cloud' : ''}</option>`).join('')
        : '<option value="">—</option>';
    sel.disabled = !state.models.length;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function scrollToBottom() {
    const box = $('chatMessages');
    if (box) box.scrollTop = box.scrollHeight;
}

function renderEmptyState(problem, { retry = true } = {}) {
    const box = $('chatMessages');
    if (!box) return;
    const games = (window.matchesData || []).length;
    box.innerHTML = `
        <div class="chat-empty">
            <div class="chat-empty-icon">💬</div>
            <h3>Ask about your games</h3>
            <p>${games
                ? `The assistant can look up all ${games.toLocaleString('en-US')} of your stored games — by queue, champion, role or date.`
                : 'Sync your matches first, then ask away.'}</p>
            ${problem
                ? `<div class="chat-problem">${escapeHtml(problem)}
                     ${retry ? '<button class="chat-btn" type="button" id="chatRetry">Retry</button>' : ''}</div>`
                : `<div class="chat-chips">${SUGGESTIONS.map(s =>
                     `<button class="chat-chip" type="button" data-q="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}</div>`}
        </div>`;
    const retryBtn = $('chatRetry');
    if (retryBtn) retryBtn.addEventListener('click', refreshModels);
    box.querySelectorAll('.chat-chip').forEach(chip =>
        chip.addEventListener('click', () => send(chip.dataset.q)));
}

function addUserBubble(text) {
    const box = $('chatMessages');
    const empty = box.querySelector('.chat-empty');
    if (empty) empty.remove();
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg--user';
    el.innerHTML = `<div class="chat-bubble">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
    box.appendChild(el);
    scrollToBottom();
}

/** Assistant bubble with an activity strip (tool lookups) and the answer body. */
function addAssistantBubble() {
    const box = $('chatMessages');
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg--bot';
    el.innerHTML = `
        <div class="chat-bubble">
            <div class="chat-activity"></div>
            <div class="chat-body"><span class="chat-typing"><i></i><i></i><i></i></span></div>
        </div>`;
    box.appendChild(el);
    scrollToBottom();
    return {
        activity: el.querySelector('.chat-activity'),
        body: el.querySelector('.chat-body'),
        root: el,
    };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function toolContext() {
    const all = window.matchesData || [];
    const matches = typeof window.excludeRemakes === 'function' ? window.excludeRemakes(all) : all;
    return {
        matches,
        computeTabStats: window.computeTabStats,
        statHistory,
        CoachingEngine,
        getCoachingData,
        getLpReadings,
        absoluteLp,
        lpDeltas: window.lpDeltas || {},
        seasonStart: seasonStart(),
        now: () => new Date(),
    };
}

function systemPrompt(ctx) {
    const cfg = loadConfig();
    let lo = Infinity, hi = -Infinity;
    for (const m of ctx.matches) { lo = Math.min(lo, m.gameCreation); hi = Math.max(hi, m.gameCreation); }
    const day = t => new Date(t).toISOString().slice(0, 10);
    return buildSystemPrompt({
        player: cfg.gameName ? `${cfg.gameName}#${cfg.tagLine}` : null,
        today: day(Date.now()),
        totalGames: ctx.matches.length,
        from: ctx.matches.length ? day(lo) : null,
        to: ctx.matches.length ? day(hi) : null,
    });
}

/** Whether to send Ollama's `think` flag: qwen3 can toggle it; others get it only when asked. */
function thinkFlag(model, wantThink) {
    if (wantThink) return true;
    return /^qwen3/i.test(model || '') ? false : undefined;
}

function setBusy(busy) {
    state.busy = busy;
    const btn = $('chatSend');
    if (btn) {
        btn.textContent = busy ? 'Stop' : 'Send';
        btn.classList.toggle('is-stop', busy);
    }
}

/** Status after a failed answer; anything that means "not reachable" makes the next send re-check. */
function statusAfterError(err) {
    const down = {
        OLLAMA_DOWN: 'Ollama not running', KEY_REJECTED: 'Key rejected', NO_KEY: 'No API key', NETWORK: 'Offline',
    }[err.code];
    if (down) { state.up = false; setStatus('down', down); } else setStatus('ready', 'Ready');
}

async function send(rawText) {
    const text = String(rawText || '').trim();
    if (!text || state.busy) return;

    if (!state.up || !state.model) {
        await refreshModels();
        if (!state.up || !state.model) return;
    }

    const input = $('chatInput');
    if (input) { input.value = ''; autoGrow(input); }

    addUserBubble(text);
    const ui = addAssistantBubble();
    setBusy(true);
    setStatus('working', 'Thinking…');

    const ctx = toolContext();
    const messages = [
        { role: 'system', content: systemPrompt(ctx) },
        ...trimHistory(state.history),
        { role: 'user', content: text },
    ];

    let streamed = '';
    let frame = null;
    const paint = () => {
        frame = null;
        const visible = stripThink(streamed);
        if (visible.trim()) ui.body.innerHTML = renderMarkdown(visible);
        scrollToBottom();
    };

    state.abort = new AbortController();
    const model = state.model;
    const cloud = isCloud();
    const chatClient = client();
    const think = cloud ? undefined : thinkFlag(model, $('chatThink') && $('chatThink').checked);

    try {
        const result = await runAgent({
            messages,
            tools: chatTools.toolSchemas(),
            signal: state.abort.signal,
            describeCall: chatTools.describeCall,
            executeTool: (name, args) => chatTools.executeTool(name, args, ctx),
            chat: req => chatClient.chat({ ...req, model, think, options: MODEL_OPTIONS }),
            onEvent: ev => {
                if (ev.type === 'delta') {
                    streamed += ev.text;
                    if (!frame) frame = requestAnimationFrame(paint);
                } else if (ev.type === 'reset') {
                    streamed = '';
                    ui.body.innerHTML = '<span class="chat-typing"><i></i><i></i><i></i></span>';
                } else if (ev.type === 'tool') {
                    const line = document.createElement('div');
                    line.className = 'chat-tool';
                    line.textContent = `🔎 Looked up ${ev.label}`;
                    ui.activity.appendChild(line);
                    setStatus('working', 'Looking things up…');
                    scrollToBottom();
                } else if (ev.type === 'thinking') {
                    setStatus('working', 'Thinking harder…');
                }
            },
        });

        if (frame) cancelAnimationFrame(frame);
        ui.body.innerHTML = renderMarkdown(result.text);
        state.history.push({ role: 'user', content: text }, { role: 'assistant', content: result.text });
        setStatus('ready', 'Ready');
    } catch (err) {
        if (frame) cancelAnimationFrame(frame);
        if (err.name === 'AbortError') {
            const partial = stripThink(streamed).trim();
            ui.body.innerHTML = (partial ? renderMarkdown(partial) : '') +
                '<div class="chat-note">Stopped.</div>';
            setStatus('ready', 'Ready');
        } else {
            let msg = err.message || 'Something went wrong.';
            if (!cloud && /not found/i.test(msg) && /model/i.test(msg)) {
                msg += `  In Command Prompt run:  ollama pull ${model}`;
            }
            ui.body.innerHTML = `<div class="chat-error">${escapeHtml(msg)}</div>`;
            statusAfterError(err);
        }
    } finally {
        state.abort = null;
        setBusy(false);
        scrollToBottom();
    }
}

function stop() {
    if (state.abort) state.abort.abort();
}

function newChat() {
    stop();
    state.history = [];
    if (state.up) renderEmptyState();
    else refreshModels();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

function init() {
    if (state.initialised) return;
    state.initialised = true;

    const form  = $('chatForm');
    const input = $('chatInput');
    const sel   = $('chatModel');
    const providerSel = $('chatProvider');
    const keyBar = $('chatKeyBar');
    const thinkBox = $('chatThink');

    const savedProvider = storageGet(PROVIDER_KEY);
    if (PROVIDER_OPTIONS.some(([id]) => id === savedProvider)) state.provider = savedProvider;

    if (providerSel) {
        providerSel.innerHTML = PROVIDER_OPTIONS
            .map(([id, label]) => `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`).join('');
        providerSel.value = state.provider;
        providerSel.addEventListener('change', () => {
            if (state.busy) stop();
            state.provider = providerSel.value;
            state.keyStatus = null;
            state.editingKey = false;
            storageSet(PROVIDER_KEY, state.provider);
            refreshModels();
        });
    }

    if (keyBar) {
        keyBar.addEventListener('submit', e => {
            if (e.target.id !== 'chatKeyForm') return;
            e.preventDefault();
            saveKey();
        });
        keyBar.addEventListener('click', e => {
            const action = e.target.closest('[data-key-action]');
            if (!action) return;
            if (action.dataset.keyAction === 'remove') { removeKey(); return; }
            state.editingKey = action.dataset.keyAction === 'change';
            renderKeyBar();
            if (state.editingKey && $('chatKeyInput')) $('chatKeyInput').focus();
        });
    }

    if (thinkBox) {
        thinkBox.checked = storageGet(THINK_KEY) === '1';
        thinkBox.addEventListener('change', () => storageSet(THINK_KEY, thinkBox.checked ? '1' : '0'));
    }

    form.addEventListener('submit', e => {
        e.preventDefault();
        if (state.busy) stop(); else send(input.value);
    });
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!state.busy) send(input.value);
        }
    });
    input.addEventListener('input', () => autoGrow(input));
    sel.addEventListener('change', () => {
        state.model = sel.value;
        storageSet(modelKey(), state.model);
        updateFoot();
    });
    $('chatNew').addEventListener('click', newChat);
}

window.openChatPanel = function () {
    init();
    // Re-check every time the page is opened: Ollama may have been started
    // (or a model pulled, or a key saved) since last time.
    if (!state.busy) refreshModels();
    const input = $('chatInput');
    if (input) setTimeout(() => input.focus(), 50);
};

module.exports = { thinkFlag };
