/**
 * chatPanel.js — the Chat page: talk to a local Ollama model about your games.
 *
 *   chatPanel (this file)  UI: model picker, messages, composer, status
 *   chatAgent.js           the tool-calling loop
 *   chatTools.js           the data tools (every number comes from here)
 *   services/ollama.js     HTTP client for http://127.0.0.1:11434
 *   markdown.js            safe rendering of the model's answers
 *
 * Exposes window.openChatPanel(), called by switchTopTab('chat').
 */

const { createClient }  = require('../services/ollama');
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
const MODEL_KEY       = 'nexus.chatModel';
const THINK_KEY       = 'nexus.chatThink';

// num_ctx: Ollama's default context is small and silently truncates the
// START of the conversation — i.e. the system prompt and tool rules — once
// tool results pile up. 8k fits several tool rounds of the compact results.
const MODEL_OPTIONS = { num_ctx: 8192, temperature: 0.4 };

const SUGGESTIONS = [
    'How did my last 10 games go?',
    'Which champions should I play more in Solo/Duo?',
    'How has my win rate changed this year?',
    'What should I focus on to climb?',
    'Where am I weakest in the laning phase?',
    'Compare my Solo/Duo and Flex results',
];

const client = createClient();

const state = {
    initialised: false,
    models: [],
    model: null,
    ollamaUp: false,
    history: [],        // [{ role, content }] — final texts only
    busy: false,
    abort: null,
};

const $ = id => document.getElementById(id);

function storageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function storageSet(key, v) { try { localStorage.setItem(key, v); } catch { /* storage unavailable */ } }

// ---------------------------------------------------------------------------
// Status + model picker
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
    const m = currentModelInfo();
    foot.innerHTML = m && m.cloud
        ? `<span class="chat-foot-warn">☁ <b>${escapeHtml(m.name)}</b> runs on Ollama's servers — your questions and the stats the app sends it leave your PC.</span>`
        : `Runs on your PC with Ollama — nothing leaves your machine. Numbers come from your matches; the model's explanations can still be wrong.`;
}

async function refreshModels() {
    setStatus('checking', 'Checking Ollama…');
    try {
        const models = await client.listModels();
        // Local models first: they're the default and keep data on this PC
        state.models = models.sort((a, b) => (a.cloud - b.cloud) || a.name.localeCompare(b.name));
        state.ollamaUp = true;
    } catch (err) {
        state.models = [];
        state.ollamaUp = false;
        setStatus('down', err.code === 'OLLAMA_DOWN' ? 'Ollama not running' : 'Ollama error');
        renderEmptyState(err.message);
        populatePicker();
        return;
    }

    const saved = storageGet(MODEL_KEY);
    const names = state.models.map(m => m.name);
    state.model = names.includes(saved) ? saved
                : names.includes(PREFERRED_MODEL) ? PREFERRED_MODEL
                : (state.models.find(m => !m.cloud) || state.models[0] || {}).name || null;

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

function populatePicker() {
    const sel = $('chatModel');
    if (!sel) return;
    sel.innerHTML = state.models.length
        ? state.models.map(m =>
            `<option value="${escapeHtml(m.name)}"${m.name === state.model ? ' selected' : ''}>` +
            `${escapeHtml(m.name)}${m.cloud ? '  ☁ cloud' : ''}</option>`).join('')
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

function renderEmptyState(problem) {
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
                     <button class="chat-btn" type="button" id="chatRetry">Retry</button></div>`
                : `<div class="chat-chips">${SUGGESTIONS.map(s =>
                     `<button class="chat-chip" type="button" data-q="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}</div>`}
        </div>`;
    const retry = $('chatRetry');
    if (retry) retry.addEventListener('click', refreshModels);
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

async function send(rawText) {
    const text = String(rawText || '').trim();
    if (!text || state.busy) return;

    if (!state.ollamaUp || !state.model) {
        await refreshModels();
        if (!state.ollamaUp || !state.model) return;
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
    const think = thinkFlag(model, $('chatThink') && $('chatThink').checked);

    try {
        const result = await runAgent({
            messages,
            tools: chatTools.toolSchemas(),
            signal: state.abort.signal,
            describeCall: chatTools.describeCall,
            executeTool: (name, args) => chatTools.executeTool(name, args, ctx),
            chat: req => client.chat({ ...req, model, think, options: MODEL_OPTIONS }),
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
            if (/not found/i.test(msg) && /model/i.test(msg)) {
                msg += `  In Command Prompt run:  ollama pull ${model}`;
            }
            ui.body.innerHTML = `<div class="chat-error">${escapeHtml(msg)}</div>`;
            if (err.code === 'OLLAMA_DOWN') { state.ollamaUp = false; setStatus('down', 'Ollama not running'); }
            else setStatus('ready', 'Ready');
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
    renderEmptyState(state.ollamaUp ? undefined : 'Ollama is not running. Start it, then press Retry.');
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
    const thinkBox = $('chatThink');

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
        storageSet(MODEL_KEY, state.model);
        updateFoot();
    });
    $('chatNew').addEventListener('click', newChat);
}

window.openChatPanel = function () {
    init();
    // Re-check every time the page is opened: Ollama may have been started
    // (or a model pulled) since last time.
    if (!state.busy) refreshModels();
    const input = $('chatInput');
    if (input) setTimeout(() => input.focus(), 50);
};

module.exports = { thinkFlag };
