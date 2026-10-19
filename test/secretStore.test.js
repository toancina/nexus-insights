/**
 * #91: chat API keys are stored encrypted with Electron safeStorage, never in
 * plain text. Electron isn't available here, so safeStorage is a fake with the
 * same interface that really transforms the bytes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SRC } = require('./helpers');

const { createSecretStore } = require(path.join(SRC, 'services', 'secretStore.js'));

const KEY = 'mistral-KEY-0123456789abcdefWXYZ';
const URL_ = 'https://api.mistral.ai/v1';

/** safeStorage stand-in: bytes are XOR-ed and tagged, so the plain text never survives. */
function fakeSafeStorage({ available = true, backend } = {}) {
    const flip = buf => Buffer.from(buf.map(b => b ^ 0x5a));
    return {
        isEncryptionAvailable: () => available,
        encryptString: s => Buffer.concat([Buffer.from('FAKE'), flip(Buffer.from(s, 'utf8'))]),
        decryptString: buf => {
            if (buf.subarray(0, 4).toString() !== 'FAKE') throw new Error('Error while decrypting the ciphertext');
            return flip(buf.subarray(4)).toString('utf8');
        },
        ...(backend ? { getSelectedStorageBackend: () => backend } : {}),
    };
}

function tempFile(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-secrets-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'secrets.json');
}

test('a saved key reads back, and the status shows only its last 4 characters', (t) => {
    const store = createSecretStore({ safeStorage: fakeSafeStorage(), file: tempFile(t) });
    const status = store.set('mistral', KEY, { baseUrl: URL_ });
    assert.deepEqual(status, { saved: true, last4: 'WXYZ', persisted: true, extra: { baseUrl: URL_ } });
    assert.deepEqual(store.get('mistral'), { secret: KEY, extra: { baseUrl: URL_ } });
    assert.ok(!JSON.stringify(status).includes(KEY));
});

test('the file on disk holds neither the key nor the base URL in plain text', (t) => {
    const file = tempFile(t);
    createSecretStore({ safeStorage: fakeSafeStorage(), file }).set('mistral', KEY, { baseUrl: URL_ });
    const raw = fs.readFileSync(file);
    assert.ok(raw.length > 0);
    assert.ok(!raw.includes(KEY), 'key in plain text');
    assert.ok(!raw.includes(Buffer.from(KEY).toString('base64')), 'key only base64-encoded');
    assert.ok(!raw.includes('api.mistral.ai'), 'base URL readable, so it could be swapped');
});

test('a new store over the same file finds the key (it survives a restart)', (t) => {
    const file = tempFile(t);
    createSecretStore({ safeStorage: fakeSafeStorage(), file }).set('openai', KEY, { baseUrl: 'https://api.openai.com/v1' });
    const again = createSecretStore({ safeStorage: fakeSafeStorage(), file });
    assert.equal(again.get('openai').secret, KEY);
    assert.equal(again.status('mistral').saved, false);
});

test('keys are kept per provider', (t) => {
    const store = createSecretStore({ safeStorage: fakeSafeStorage(), file: tempFile(t) });
    store.set('mistral', 'first-key-1111');
    store.set('openai', 'second-key-2222');
    assert.equal(store.get('mistral').secret, 'first-key-1111');
    assert.equal(store.get('openai').secret, 'second-key-2222');
});

test('remove deletes the key from memory and from the file', (t) => {
    const file = tempFile(t);
    const store = createSecretStore({ safeStorage: fakeSafeStorage(), file });
    store.set('mistral', KEY);
    store.set('openai', 'other-key-9999');
    assert.deepEqual(store.remove('mistral'), { saved: false, last4: null, persisted: true, extra: null });
    assert.equal(store.get('mistral'), null);
    assert.equal(createSecretStore({ safeStorage: fakeSafeStorage(), file }).get('mistral'), null);
    assert.equal(createSecretStore({ safeStorage: fakeSafeStorage(), file }).get('openai').secret, 'other-key-9999');
});

test('without encryption the key is kept for this run only, and nothing is written', (t) => {
    const file = tempFile(t);
    const store = createSecretStore({ safeStorage: fakeSafeStorage({ available: false }), file });
    const status = store.set('mistral', KEY, { baseUrl: URL_ });
    assert.equal(status.saved, true);
    assert.equal(status.persisted, false);
    assert.equal(store.get('mistral').secret, KEY);
    assert.ok(!fs.existsSync(file) || !fs.readFileSync(file).includes(KEY));
    assert.equal(createSecretStore({ safeStorage: fakeSafeStorage({ available: false }), file }).get('mistral'), null);
});

test('Linux without a keyring (basic_text backend) counts as no encryption', (t) => {
    const file = tempFile(t);
    const store = createSecretStore({ safeStorage: fakeSafeStorage({ backend: 'basic_text' }), file, platform: 'linux' });
    assert.equal(store.canEncrypt(), false);
    assert.equal(store.set('mistral', KEY).persisted, false);
    assert.ok(!fs.existsSync(file));
});

test('an entry that no longer decrypts counts as no key', (t) => {
    const file = tempFile(t);
    createSecretStore({ safeStorage: fakeSafeStorage(), file }).set('mistral', KEY);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.entries.mistral.data = Buffer.from('not ours').toString('base64');
    fs.writeFileSync(file, JSON.stringify(data));
    const store = createSecretStore({ safeStorage: fakeSafeStorage(), file });
    assert.equal(store.get('mistral'), null);
    assert.equal(store.status('mistral').saved, false);
});

test('a broken secrets file counts as no keys, and saving replaces it', (t) => {
    const file = tempFile(t);
    fs.writeFileSync(file, '{ not json');
    const store = createSecretStore({ safeStorage: fakeSafeStorage(), file });
    assert.equal(store.get('mistral'), null);
    store.set('mistral', KEY);
    assert.equal(createSecretStore({ safeStorage: fakeSafeStorage(), file }).get('mistral').secret, KEY);
});

test('the secrets file is readable by this user only', { skip: process.platform === 'win32' }, (t) => {
    const file = tempFile(t);
    createSecretStore({ safeStorage: fakeSafeStorage(), file }).set('mistral', KEY);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
