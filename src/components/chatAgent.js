/**
 * chatAgent.js — the tool-calling loop behind the Chat page.
 *
 *   user question
 *     → model (with tool schemas)
 *     → model asks for tools → we run them → results go back to the model
 *     → … repeat until the model answers in plain text (or the round cap hits)
 *
 * The model talks; the tools (chatTools.js) supply every number. Pure apart
 * from the injected `chat` / `executeTool` functions, so it is tested in Node
 * with fakes (test/chatAgent.test.js).
 */

const MAX_ROUNDS = 5;

/** Remove reasoning blocks some models write inline, including an unclosed one mid-stream. */
function stripThink(text) {
    return String(text || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<think>[\s\S]*$/i, '')
        .replace(/^\s+/, '');
}

function buildSystemPrompt({ player, today, totalGames, from, to }) {
    return [
        `You are the Nexus Insights assistant. You answer questions about ${player || 'the player'}'s League of Legends games, which are stored in this app.`,
        `Today is ${today}. Stored games: ${totalGames}${from ? ` (from ${from} to ${to})` : ''}. Remakes are excluded from all stats.`,
        '',
        'Rules:',
        '- Get every number from the tools. Never estimate, guess or invent a statistic. If the tools cannot answer, say so.',
        '- Call as many tools as you need, then answer. Narrow the data with the filters the data tools share: queue, champion, role, lane_opponent, result, patch, last_n_patches, last_n_days, since/until, min/max_minutes, last_n_games. get_filter_options lists which champions, patches and queues have games.',
        '- "Ranked" usually means queue "solo" unless the user says flex or both.',
        '- For one game ("my last game", "why did I lose that Ahri game") use get_game_detail.',
        '- Win chance is the app\'s estimate from gold, XP and kills, not Riot data. WPA is the change in it from buying an item until the next trip to the shop: it shows how games went, not what the item caused.',
        '- Answer in plain English, concisely: a few sentences or a short list. Quote the actual numbers.',
        '- Mention how many games a number is based on when it is small; under 10 games is not reliable.',
        '- Rank tiers (iron … challenger) on a stat compare it with typical players of that rank.',
        '- Give practical League advice when asked, but base claims about this player on the data.',
    ].join('\n');
}

/**
 * Run one user turn.
 *
 * @param {object}   p
 * @param {Function} p.chat        ({ messages, tools, onDelta, onThinking, signal }) → { content, tool_calls }
 * @param {Array}    p.messages    full conversation so far, including the system prompt and the new user message
 * @param {Array}    p.tools       tool schemas
 * @param {Function} p.executeTool (name, args) → result object
 * @param {Function} [p.describeCall]
 * @param {Function} [p.onEvent]   ({ type: 'delta'|'thinking'|'tool'|'reset', ... })
 * @returns {Promise<{ text: string, toolCalls: number }>}
 */
async function runAgent({ chat, messages, tools, executeTool, describeCall, onEvent = () => {}, signal, maxRounds = MAX_ROUNDS }) {
    const convo = messages.slice();
    const seen = new Map();          // identical repeated calls get the cached result
    let toolCalls = 0;

    for (let round = 0; round <= maxRounds; round++) {
        const lastRound = round === maxRounds;
        if (lastRound) {
            // Out of tool budget: make it answer with what it already has
            convo.push({ role: 'system', content: 'Answer the user now using the tool results above. Do not call more tools.' });
        }

        const res = await chat({
            messages: convo,
            tools: lastRound ? undefined : tools,
            signal,
            onDelta: text => onEvent({ type: 'delta', text }),
            onThinking: text => onEvent({ type: 'thinking', text }),
        });

        const calls = lastRound ? [] : (res.tool_calls || []);
        if (!calls.length) {
            const text = stripThink(res.content).trim()
                || "I couldn't put an answer together for that — try asking it a different way.";
            return { text, toolCalls };
        }

        // Anything it streamed before deciding to call tools was preamble
        onEvent({ type: 'reset' });
        convo.push({ role: 'assistant', content: res.content || '', tool_calls: calls });

        for (const call of calls) {
            const fn = call.function || {};
            const name = fn.name;
            let args = fn.arguments;
            if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
            args = args || {};

            onEvent({ type: 'tool', name, args, label: describeCall ? describeCall(name, args) : name });

            const key = `${name}:${JSON.stringify(args)}`;
            let result;
            if (seen.has(key)) {
                result = { ...seen.get(key), note: 'Same call as before — this is the same result. Use it to answer.' };
            } else {
                result = await executeTool(name, args);
                seen.set(key, result);
            }
            toolCalls++;
            convo.push({ role: 'tool', tool_name: name, content: JSON.stringify(result) });
        }
    }
    // Unreachable: the last round never requests tools
    return { text: '', toolCalls };
}

/**
 * Trim the stored conversation for the next request: keep the last N turns of
 * plain user/assistant text. Tool traffic from earlier turns is dropped — it is
 * large, and the model's own earlier answer already summarises it.
 */
function trimHistory(turns, maxTurns = 6) {
    return turns
        .filter(t => (t.role === 'user' || t.role === 'assistant') && t.content)
        .slice(-maxTurns * 2)
        .map(t => ({ role: t.role, content: t.content }));
}

module.exports = { runAgent, buildSystemPrompt, stripThink, trimHistory, MAX_ROUNDS };
