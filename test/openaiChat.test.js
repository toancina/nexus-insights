/**
 * #91: Chat through Mistral or any OpenAI-compatible API. A fake server on
 * 127.0.0.1 plays the provider (plain http is allowed only for loopback).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const util = require('util');
const { SRC } = require('./helpers');

const { createOpenAiClient, toOpenAiMessages, isAllowedBaseUrl, normalizeBaseUrl } = require(path.join(SRC, 'services', 'openaiChat.js'));

const KEY = 'sk-test-0123456789abcdefSECRET';

/** A fake provider. `handler(req, body, res)` answers; requests are recorded. */
function fakeProvider(handler) {
    const requests = [];
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', () => {
                const parsed = body ? JSON.parse(body) : null;
                requests.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
                handler(req, parsed, res);
            });
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, requests, base: `http://127.0.0.1:${server.address().port}/v1` }));
    });
}
const close = (server) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const client = (base, extra = {}) => createOpenAiClient({ baseUrl: base, apiKey: KEY, label: 'Mistral', ...extra });

/** Server-sent events, the way /chat/completions streams them. */
const sse = (chunks) => chunks.map(c => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('');
const delta = (d, finish = null) => ({ id: 'cmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: d, finish_reason: finish }] });

/** Every way an error could end up in a log. */
const everyRendering = (err) => [util.inspect(err, { depth: Infinity, showHidden: true }), String(err), err.stack || '', JSON.stringify(err)].join('\n');

test('lists chat models that can call tools, with the key as a bearer token', async () => {
    const { server, requests, base } = await fakeProvider((req, body, res) => {
        res.end(JSON.stringify({ object: 'list', data: [
            { id: 'mistral-small-latest', object: 'model', capabilities: { completion_chat: true, function_calling: true } },
            { id: 'mistral-embed', object: 'model', capabilities: { completion_chat: false, function_calling: false } },
            { id: 'codestral-mamba', object: 'model', capabilities: { completion_chat: true, function_calling: false } },
            { id: 'gpt-4.1-mini', object: 'model' },            // OpenAI lists no capabilities
            { id: 'text-embedding-3-small', object: 'model' },
            { id: 'whisper-1', object: 'model' },
            { id: 'tts-1', object: 'model' },
            { id: 'dall-e-3', object: 'model' },
        ] }));
    });
    try {
        const models = await client(base).listModels();
        assert.deepEqual(models.map(m => m.name), ['gpt-4.1-mini', 'mistral-small-latest']);
        assert.ok(models.every(m => m.cloud));
        assert.equal(requests[0].method, 'GET');
        assert.equal(requests[0].url, '/v1/models');
        assert.equal(requests[0].headers.authorization, `Bearer ${KEY}`);
    } finally { close(server); }
});

test('streams the answer, even when events are split mid-line', async () => {
    const { server, requests, base } = await fakeProvider(async (req, body, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const text = sse([delta({ role: 'assistant', content: '' }), delta({ content: 'Your ' }), delta({ content: 'win rate' }), delta({}, 'stop'), '[DONE]']);
        for (let i = 0; i < text.length; i += 9) { res.write(text.slice(i, i + 9)); await sleep(1); }
        res.end();
    });
    try {
        const deltas = [];
        const tools = [{ type: 'function', function: { name: 'get_overview', description: 'd', parameters: { type: 'object', properties: {} } } }];
        const out = await client(base).chat({
            model: 'mistral-small-latest',
            messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hi' }],
            tools, options: { num_ctx: 8192, temperature: 0.4 }, onDelta: d => deltas.push(d),
        });
        assert.deepEqual(deltas, ['Your ', 'win rate']);
        assert.equal(out.content, 'Your win rate');
        assert.deepEqual(out.tool_calls, []);
        const sent = requests[0];
        assert.equal(sent.url, '/v1/chat/completions');
        assert.equal(sent.headers.authorization, `Bearer ${KEY}`);
        assert.equal(sent.body.model, 'mistral-small-latest');
        assert.equal(sent.body.stream, true);
        assert.equal(sent.body.temperature, 0.4);
        assert.equal(sent.body.num_ctx, undefined, 'Ollama-only options stay out');
        assert.deepEqual(sent.body.tools, tools);
        assert.deepEqual(sent.body.messages, [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hi' }]);
    } finally { close(server); }
});

test('assembles tool calls whose arguments arrive in pieces', async () => {
    const { server, base } = await fakeProvider((req, body, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(sse([
            delta({ role: 'assistant', tool_calls: [{ index: 0, id: 'AbC123xyZ', type: 'function', function: { name: 'get_overview', arguments: '' } }] }),
            delta({ tool_calls: [{ index: 0, function: { arguments: '{"queue":' } }] }),
            delta({ tool_calls: [{ index: 1, id: 'QwE456rtY', type: 'function', function: { name: 'get_rank_and_lp', arguments: '{}' } }] }),
            delta({ tool_calls: [{ index: 0, function: { arguments: '"solo"}' } }] }),
            delta({}, 'tool_calls'),
            '[DONE]',
        ]));
    });
    try {
        const out = await client(base).chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] });
        assert.deepEqual(out.tool_calls, [
            { id: 'AbC123xyZ', type: 'function', function: { name: 'get_overview', arguments: '{"queue":"solo"}' } },
            { id: 'QwE456rtY', type: 'function', function: { name: 'get_rank_and_lp', arguments: '{}' } },
        ]);
    } finally { close(server); }
});

test('Mistral sends tool calls whole, with arguments as one string', async () => {
    const { server, base } = await fakeProvider((req, body, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(sse([
            delta({ role: 'assistant', content: '', tool_calls: [{ id: 'D681PevKs', function: { name: 'get_overview', arguments: '{"queue": "solo"}' }, index: 0 }] }, 'tool_calls'),
            '[DONE]',
        ]));
    });
    try {
        const out = await client(base).chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] });
        assert.deepEqual(out.tool_calls, [{ id: 'D681PevKs', type: 'function', function: { name: 'get_overview', arguments: '{"queue": "solo"}' } }]);
    } finally { close(server); }
});

test('Mistral reasoning models: thinking parts go to onThinking, text parts to the answer', async () => {
    const { server, base } = await fakeProvider((req, body, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(sse([
            delta({ role: 'assistant', content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'Check the stats.' }] }] }),
            delta({ content: [{ type: 'text', text: 'You win ' }] }),
            delta({ content: 'more.' }),
            '[DONE]',
        ]));
    });
    try {
        const thinking = [];
        const out = await client(base).chat({ model: 'magistral-small-latest', messages: [], onThinking: t => thinking.push(t) });
        assert.equal(out.content, 'You win more.');
        assert.equal(out.thinking, 'Check the stats.');
        assert.deepEqual(thinking, ['Check the stats.']);
    } finally { close(server); }
});

test('toOpenAiMessages: tool calls get string arguments and ids, results get the matching id', () => {
    const messages = toOpenAiMessages([
        { role: 'system', content: 'rules' },
        { role: 'user', content: 'how am I doing?' },
        { role: 'assistant', content: '', tool_calls: [
            { id: 'AbC123xyZ', type: 'function', function: { name: 'get_overview', arguments: '{"queue":"solo"}' } },
            { function: { name: 'get_rank_and_lp', arguments: { queue: 'solo' } } },   // Ollama shape: object, no id
        ] },
        { role: 'tool', tool_name: 'get_overview', content: '{"games":20}' },
        { role: 'tool', tool_name: 'get_rank_and_lp', content: '{"tier":"GOLD"}' },
        { role: 'system', content: 'Answer the user now.' },
    ]);
    const generated = messages[2].tool_calls[1].id;
    assert.match(generated, /^[a-zA-Z0-9]{9}$/, 'Mistral wants 9 letters or digits');
    assert.deepEqual(messages, [
        { role: 'system', content: 'rules' },
        { role: 'user', content: 'how am I doing?' },
        { role: 'assistant', content: '', tool_calls: [
            { id: 'AbC123xyZ', type: 'function', function: { name: 'get_overview', arguments: '{"queue":"solo"}' } },
            { id: generated, type: 'function', function: { name: 'get_rank_and_lp', arguments: '{"queue":"solo"}' } },
        ] },
        { role: 'tool', tool_call_id: 'AbC123xyZ', content: '{"games":20}' },
        { role: 'tool', tool_call_id: generated, content: '{"tier":"GOLD"}' },
        // Mistral rejects a conversation that ends on a system message
        { role: 'user', content: 'Answer the user now.' },
    ]);
});

test('a rejected key gives a clear message, and the key is in no part of the error', async () => {
    const { server, base } = await fakeProvider((req, body, res) => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}`, code: 'invalid_api_key' } }));
    });
    try {
        await assert.rejects(client(base).listModels(), err => {
            assert.equal(err.code, 'KEY_REJECTED');
            assert.match(err.message, /Mistral rejected the API key/);
            assert.ok(!everyRendering(err).includes(KEY), 'key leaked into the error');
            return true;
        });
    } finally { close(server); }
});

test('a 429 says the rate limit was reached', async () => {
    const { server, base } = await fakeProvider((req, body, res) => {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Requests rate limit exceeded' }));
    });
    try {
        await assert.rejects(client(base).chat({ model: 'm', messages: [] }), err => {
            assert.equal(err.code, 'RATE_LIMIT');
            assert.match(err.message, /rate limit/i);
            return true;
        });
    } finally { close(server); }
});

test('other errors pass on the provider\'s message, with the key scrubbed out', async () => {
    const { server, base } = await fakeProvider((req, body, res) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'error', message: `Invalid model: nope (key ${KEY})`, type: 'invalid_model' }));
    });
    try {
        await assert.rejects(client(base).chat({ model: 'nope', messages: [] }), err => {
            assert.equal(err.status, 400);
            assert.match(err.message, /Invalid model: nope/);
            assert.ok(!everyRendering(err).includes(KEY));
            return true;
        });
    } finally { close(server); }
});

test('an error event in the stream rejects the chat', async () => {
    const { server, base } = await fakeProvider((req, body, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(sse([delta({ content: 'Hel' }), { error: { message: 'upstream overloaded' } }]));
    });
    try {
        await assert.rejects(client(base).chat({ model: 'm', messages: [] }), /upstream overloaded/);
    } finally { close(server); }
});

test('no connection gives a network error naming the provider', async () => {
    const { server, base } = await fakeProvider(() => {});
    await new Promise(r => server.close(r));          // nothing listening there now
    await assert.rejects(client(base).listModels(), err => {
        assert.equal(err.code, 'NETWORK');
        assert.match(err.message, /couldn't reach Mistral/i);
        return true;
    });
});

test('Stop (abort) ends a stream that is still running', async () => {
    const { server, base } = await fakeProvider((req, body, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sse([delta({ content: 'thinking about it' })]));
        // never ends on its own
    });
    try {
        const ac = new AbortController();
        const p = client(base).chat({ model: 'm', messages: [], signal: ac.signal, onDelta: () => ac.abort() });
        await assert.rejects(p, err => err.name === 'AbortError');
    } finally { close(server); }
});

test('isAllowedBaseUrl: https anywhere, plain http only on this PC', () => {
    assert.equal(isAllowedBaseUrl('https://api.mistral.ai/v1'), true);
    assert.equal(isAllowedBaseUrl('https://openrouter.ai/api/v1'), true);
    assert.equal(isAllowedBaseUrl('http://127.0.0.1:1234/v1'), true);
    assert.equal(isAllowedBaseUrl('http://localhost:1234/v1'), true);
    assert.equal(isAllowedBaseUrl('http://[::1]:1234/v1'), true);
    assert.equal(isAllowedBaseUrl('http://api.example.com/v1'), false, 'the key would cross the network unencrypted');
    assert.equal(isAllowedBaseUrl('http://localhost.example.com/v1'), false);
    assert.equal(isAllowedBaseUrl('ftp://api.mistral.ai'), false);
    assert.equal(isAllowedBaseUrl('not a url'), false);
    assert.equal(isAllowedBaseUrl(''), false);
});

test('the client refuses a base URL that would send the key unencrypted', () => {
    assert.throws(() => createOpenAiClient({ baseUrl: 'http://api.example.com/v1', apiKey: KEY }), /https/);
});

test('normalizeBaseUrl: a pasted endpoint becomes its base URL', () => {
    assert.equal(normalizeBaseUrl('https://api.anthropic.com/v1/messages'), 'https://api.anthropic.com/v1');
    assert.equal(normalizeBaseUrl(' https://api.openai.com/v1/chat/completions/ '), 'https://api.openai.com/v1');
    assert.equal(normalizeBaseUrl('https://api.mistral.ai/v1/models'), 'https://api.mistral.ai/v1');
    assert.equal(normalizeBaseUrl('https://openrouter.ai/api/v1/'), 'https://openrouter.ai/api/v1');
});

test('a pasted endpoint URL still lists models from {base}/models, and only Anthropic gets x-api-key', async () => {
    const { server, requests, base } = await fakeProvider((req, body, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'some-model' }] }));
    });
    try {
        const models = await client(base + '/messages').listModels();
        assert.deepEqual(models.map(m => m.name), ['some-model']);
        assert.equal(requests[0].url, '/v1/models');
        assert.equal(requests[0].headers['x-api-key'], undefined, 'the key goes in no extra header for other hosts');
    } finally { close(server); }
});
