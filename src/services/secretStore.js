/**
 * secretStore.js — chat API keys, encrypted on this PC (#91). Main process only.
 *
 * Each key is encrypted with Electron's safeStorage (DPAPI on Windows, the
 * Keychain on macOS, libsecret on Linux) and only the ciphertext is written,
 * to secrets.json in the data folder, never to config.json. Whatever must
 * travel with the key (the base URL it may be sent to) is encrypted with it,
 * so editing the file can't point the key at another server.
 *
 * Without real encryption (Linux with no keyring, where Chromium falls back
 * to a hard-coded password: backend "basic_text") nothing is written: the key
 * is kept in memory for this run, and status() says so (persisted: false).
 */

const fs = require('fs');

function createSecretStore({ safeStorage, file, platform = process.platform }) {
    const session = new Map();   // name → { secret, extra } when encryption isn't available

    function canEncrypt() {
        try {
            if (!safeStorage || !safeStorage.isEncryptionAvailable()) return false;
            return !(platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function'
                && safeStorage.getSelectedStorageBackend() === 'basic_text');
        } catch {
            return false;
        }
    }

    function readFile() {
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (data && data.entries && typeof data.entries === 'object') return data;
        } catch { /* missing or broken: no keys */ }
        return { version: 1, entries: {} };
    }

    /** Temp file + rename, readable by this user only. */
    function writeFile(data) {
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, file);
        try { fs.chmodSync(file, 0o600); } catch { /* Windows: ACLs, not modes */ }
    }

    /** { secret, extra } or null. Never leaves the main process. */
    function get(name) {
        if (session.has(name)) return { ...session.get(name) };
        const entry = readFile().entries[name];
        if (!entry || typeof entry.data !== 'string' || !canEncrypt()) return null;
        try {
            const value = JSON.parse(safeStorage.decryptString(Buffer.from(entry.data, 'base64')));
            return value && typeof value.secret === 'string' && value.secret
                ? { secret: value.secret, extra: value.extra || {} }
                : null;
        } catch {
            return null;   // another machine's keychain, or a damaged entry
        }
    }

    /** What the window may know: whether a key is saved, its last 4 characters, and its extra data. */
    function status(name) {
        const value = get(name);
        return {
            saved: !!value,
            last4: value ? value.secret.slice(-4) : null,
            persisted: value ? !session.has(name) : canEncrypt(),
            extra: value ? value.extra : null,
        };
    }

    function set(name, secret, extra = {}) {
        const value = { secret, extra };
        if (canEncrypt()) {
            const data = readFile();
            data.entries[name] = { data: safeStorage.encryptString(JSON.stringify(value)).toString('base64') };
            writeFile(data);
            session.delete(name);
        } else {
            session.set(name, value);
        }
        return status(name);
    }

    function remove(name) {
        session.delete(name);
        const data = readFile();
        if (data.entries[name]) {
            delete data.entries[name];
            writeFile(data);
        }
        return status(name);
    }

    return { canEncrypt, get, status, set, remove };
}

module.exports = { createSecretStore };
