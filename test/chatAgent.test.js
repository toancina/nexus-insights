const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { runAgent, stripThink, trimHistory, buildSystemPrompt } =
    require(path.join(__dirname, '..', 'src', 'components', 'chatAgent.js'));

/** Fake model: returns the scripted replies in order, recording each request. */
function scriptedChat(replies) {
    const requests = [];
    let i = 0;
    const chat = async req => {
        requests.push({ ...req, messages: req.messages.slice() });
        const r = replies[Math.min(i++, replies.length - 1)];
        if (r.content && req.onDelta) req.onDelta(r.content);
        return { content: r.content || '', tool_calls: r.tool_calls || [] };
    };
    return { chat, requests };
}
const call = (name, args) => ({ function: { name, arguments: args } });

test('runs the requested tool, feeds the result back, returns the final answer', async () => {
    const { chat, requests } = scriptedChat([
        { tool_calls: [call('get_overview', { queue: 'solo' })] },
        { content: 'You won 52% of Solo/Duo games.' },
    ]);
    const executed = [];
    const events = [];
    const out = await runAgent({
        chat,
        messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'how am I doing?' }],
        tools: [{ type: 'function', function: { name: 'get_overview' } }],
        executeTool: async (name, args) => { executed.push([name, args]); return { win_rate_pct: 52 }; },
        describeCall: () => 'overall stats (solo)',
        onEvent: e => events.push(e.type),
    });
    assert.equal(out.text, 'You won 52% of Solo/Duo games.');
    assert.equal(out.toolCalls, 1);
    assert.deepEqual(executed, [['get_overview', { queue: 'solo' }]]);

    // second request carries the assistant tool call and the tool result
    const second = requests[1].messages;
    assert.equal(second[second.length - 2].role, 'assistant');
    assert.equal(second[second.length - 1].role, 'tool');
    assert.deepEqual(JSON.parse(second[second.length - 1].content), { win_rate_pct: 52 });
    assert.ok(events.includes('tool') && events.includes('reset'));
});

test('arguments sent as a JSON string are parsed', async () => {
    const { chat } = scriptedChat([
        { tool_calls: [call('get_overview', '{"champion":"Ahri"}')] },
        { content: 'done' },
    ]);
    let got;
    await runAgent({ chat, messages: [], tools: [], executeTool: async (n, a) => { got = a; return {}; } });
    assert.deepEqual(got, { champion: 'Ahri' });
});

test('an identical repeated call is answered from cache, not re-run', async () => {
    const { chat } = scriptedChat([
        { tool_calls: [call('get_overview', { queue: 'solo' })] },
        { tool_calls: [call('get_overview', { queue: 'solo' })] },
        { content: 'ok' },
    ]);
    let runs = 0;
    await runAgent({ chat, messages: [], tools: [], executeTool: async () => { runs++; return { x: 1 }; } });
    assert.equal(runs, 1);
});

test('a model that keeps calling tools is forced to answer after the round cap', async () => {
    let n = 0;
    const requests = [];
    const chat = async req => {
        requests.push(req);
        if (req.tools) return { content: '', tool_calls: [call('get_overview', { last_n_games: ++n })] };
        return { content: 'Final answer from what I have.', tool_calls: [] };
    };
    const out = await runAgent({ chat, messages: [], tools: [{}], executeTool: async () => ({}), maxRounds: 3 });
    assert.equal(out.text, 'Final answer from what I have.');
    assert.equal(requests.length, 4, '3 tool rounds + 1 forced answer');
    assert.equal(requests[3].tools, undefined, 'last request offers no tools');
});

test('empty final answer gets a graceful fallback', async () => {
    const { chat } = scriptedChat([{ content: '   ' }]);
    const out = await runAgent({ chat, messages: [], tools: [], executeTool: async () => ({}) });
    assert.match(out.text, /different way/);
});

test('reasoning tags are stripped, including an unclosed one mid-stream', () => {
    assert.equal(stripThink('<think>hmm</think>\nAnswer'), 'Answer');
    assert.equal(stripThink('Answer so far <think>still reasoning'), 'Answer so far ');
    assert.equal(stripThink('plain'), 'plain');
});

test('history keeps recent plain turns and drops tool traffic', () => {
    const turns = [
        { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
        { role: 'tool', content: '{"big":true}' },
        { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
    ];
    assert.deepEqual(trimHistory(turns, 1).map(t => t.content), ['q2', 'a2']);
    assert.ok(!trimHistory(turns).some(t => t.role === 'tool'));
});

test('system prompt states the rules that keep numbers honest', () => {
    const p = buildSystemPrompt({ player: 'Toan#GGWP', today: '2026-10-08', totalGames: 1666, from: '2025-11-01', to: '2026-10-08' });
    assert.match(p, /Never estimate, guess or invent/);
    assert.match(p, /Toan#GGWP/);
    assert.match(p, /1666/);
});

test('system prompt: the sample-games line only while sample games are on', () => {
    const base = { player: 'P#1', today: '2026-11-11', totalGames: 10, from: '2026-06-01', to: '2026-11-10' };
    assert.equal(buildSystemPrompt(base), buildSystemPrompt({ ...base, samples: false }));
    const on = buildSystemPrompt({ ...base, samples: true });
    assert.match(on, /margin includes 0 are not evidence/);
    assert.ok(!/margin includes 0/.test(buildSystemPrompt(base)));
});
