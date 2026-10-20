/**
 * chatStore.js — saved Chat page conversations, one JSON file per chat in
 * <data folder>/chats/, so a chat survives a restart and can be carried on.
 *
 * A file: { id, title, createdAt, updatedAt, messages: [{ role, content, tools? }] }.
 * `messages` are the final texts the page shows (user questions, the model's
 * answers and the "Looked up …" labels), not the tool traffic.
 *
 * Ids come from newChatId and are checked before they become a file name,
 * so an id can never point outside the folder.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_RE = /^[a-z0-9-]{1,64}$/;
const TITLE_MAX = 60;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Base-36 time first, so ids sort by when the chat was started. */
function newChatId(now = Date.now()) {
    return `c-${now.toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

/** The first question on one line, cut to fit the list. */
function titleFor(text) {
    const line = String(text || '').replace(/\s+/g, ' ').trim();
    if (!line) return 'New chat';
    return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

/** "09:05" today, "19 Oct" earlier this year, "31 Dec 2025" before that. */
function whenLabel(ts, now = Date.now()) {
    const d = new Date(ts);
    const today = new Date(now);
    const pad = n => String(n).padStart(2, '0');
    if (d.toDateString() === today.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    return d.getFullYear() === today.getFullYear() ? day : `${day} ${d.getFullYear()}`;
}

function createChatStore({ dir }) {
    const fileFor = id => (ID_RE.test(String(id)) ? path.join(dir, `${id}.json`) : null);

    function read(file) {
        try {
            const chat = JSON.parse(fs.readFileSync(file, 'utf8'));
            return chat && ID_RE.test(String(chat.id)) && Array.isArray(chat.messages) ? chat : null;
        } catch {
            return null;   // missing, or cut off mid-write
        }
    }

    /** [{ id, title, updatedAt }], most recently used first. */
    function list() {
        let names;
        try { names = fs.readdirSync(dir); } catch { return []; }
        return names
            .filter(n => n.endsWith('.json'))
            .map(n => read(path.join(dir, n)))
            .filter(Boolean)
            .map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }))
            .sort((a, b) => (b.updatedAt - a.updatedAt) || (a.id < b.id ? 1 : -1));
    }

    /** The chat with only question/answer texts kept, so an edited file can't break the page. */
    function load(id) {
        const file = fileFor(id);
        const chat = file ? read(file) : null;
        if (!chat) return null;
        chat.messages = chat.messages
            .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
            .map(m => {
                const tools = Array.isArray(m.tools) ? m.tools.filter(t => typeof t === 'string') : [];
                return { role: m.role, content: m.content, ...(tools.length ? { tools } : {}) };
            });
        return chat;
    }

    /** Temp file + rename, so a crash can't leave a half-written chat. */
    function save(chat) {
        const file = fileFor(chat && chat.id);
        if (!file) throw new Error(`Not a chat id: ${chat && chat.id}`);
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(chat));
        try {
            fs.renameSync(tmp, file);
        } catch {
            // Windows can refuse the rename while something (antivirus, a
            // sync client) holds the file: write in place instead
            fs.writeFileSync(file, fs.readFileSync(tmp));
            fs.rmSync(tmp, { force: true });
        }
    }

    function remove(id) {
        const file = fileFor(id);
        if (file) fs.rmSync(file, { force: true });
    }

    return { list, load, save, remove };
}

module.exports = { createChatStore, newChatId, titleFor, whenLabel };
