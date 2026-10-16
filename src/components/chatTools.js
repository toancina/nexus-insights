/**
 * chatTools.js — the tools the chat model can call to look at match data.
 *
 * Design rule: the model never does arithmetic. Every number it quotes comes
 * from one of these tools, and the tools reuse the app's own calculators
 * (window.computeTabStats, statHistory, the coaching engine), so the chat can't
 * disagree with what the cards show.
 *
 * Results are deliberately small: an 8B local model has a limited context
 * window, so tools return rounded, aggregated numbers — never raw match JSON.
 *
 * Pure apart from the `ctx` passed in, so it is tested in Node
 * (test/chatTools.test.js).
 */

const TABS = ['Overview', 'Lane Phase', 'Combat', 'Death Review', 'Objectives',
              'Vision', 'Economy', 'Macro', 'Consistency'];

const QUEUES = {
    solo:   [420],
    flex:   [440],
    ranked: [420, 440],
    premade: [710],
    normal: [400, 430, 480, 490, 700],
};

const QUEUE_LABEL = {
    420: 'Ranked Solo', 440: 'Ranked Flex', 710: 'Ranked Premade', 400: 'Normal Draft', 430: 'Normal Blind',
    480: 'Swiftplay', 490: 'Quickplay', 700: 'Clash',
};

const ROLE_ALIASES = {
    top: 'TOP', jungle: 'JUNGLE', jg: 'JUNGLE', jungler: 'JUNGLE',
    mid: 'MIDDLE', middle: 'MIDDLE',
    adc: 'BOTTOM', bot: 'BOTTOM', bottom: 'BOTTOM', carry: 'BOTTOM', marksman: 'BOTTOM',
    support: 'UTILITY', supp: 'UTILITY', sup: 'UTILITY', utility: 'UTILITY',
};

const ROLE_LABEL = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'ADC', UTILITY: 'Support' };

// Display names whose internal Riot name differs
const CHAMPION_ALIASES = { wukong: 'monkeyking', nunu: 'nunu', 'renataglasc': 'renata' };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const round = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const norm  = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const pad2  = n => String(n).padStart(2, '0');

function localDate(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function localDateTime(ms) {
    const d = new Date(ms);
    return `${localDate(ms)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 'YYYY-MM-DD' → local-midnight ms, or null. */
function parseDay(s) {
    if (!s) return null;
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s).trim());
    if (!m) return null;
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    return Number.isFinite(t) ? t : null;
}

function championMatcher(query, matches) {
    const q = norm(query);
    if (!q) return { ok: true, test: () => true };
    const target = CHAMPION_ALIASES[q] || q;

    const played = [...new Set(matches.map(m => m.championName).filter(Boolean))];
    const exact  = played.filter(c => norm(c) === target);
    if (exact.length) return { ok: true, name: exact[0], test: m => norm(m.championName) === target };

    const partial = played.filter(c => norm(c).startsWith(target) || norm(c).includes(target));
    if (partial.length === 1) {
        const n = norm(partial[0]);
        return { ok: true, name: partial[0], test: m => norm(m.championName) === n };
    }
    return {
        ok: false,
        error: partial.length
            ? `"${query}" matches several champions: ${partial.slice(0, 8).join(', ')}. Ask which one.`
            : `No stored games on "${query}".`,
    };
}

/**
 * Apply the shared filter arguments. Returns { matches, description } or
 * { error } — errors go back to the model as data so it can tell the user.
 */
function applyFilters(all, args = {}) {
    let list = all.slice();
    const parts = [];

    const queue = String(args.queue || 'all').toLowerCase();
    if (queue !== 'all') {
        const ids = QUEUES[queue];
        if (!ids) return { error: `Unknown queue "${args.queue}". Use all, solo, flex, ranked, premade or normal.` };
        list = list.filter(m => ids.includes(m.queueId));
        parts.push({ solo: 'Ranked Solo/Duo', flex: 'Ranked Flex', ranked: 'Ranked (Solo + Flex)', premade: 'Ranked Premade (5-stack)', normal: 'Normal games' }[queue]);
    }

    if (args.champion) {
        const cm = championMatcher(args.champion, list);
        if (!cm.ok) return { error: cm.error };
        list = list.filter(cm.test);
        parts.push(cm.name);
    }

    if (args.role) {
        const role = ROLE_ALIASES[norm(args.role)] || String(args.role).toUpperCase();
        if (!ROLE_LABEL[role]) return { error: `Unknown role "${args.role}". Use top, jungle, mid, adc or support.` };
        list = list.filter(m => (m.teamPosition || '') === role);
        parts.push(ROLE_LABEL[role]);
    }

    const since = parseDay(args.since), until = parseDay(args.until);
    if (args.since && since === null) return { error: `Bad date "${args.since}" — use YYYY-MM-DD.` };
    if (args.until && until === null) return { error: `Bad date "${args.until}" — use YYYY-MM-DD.` };
    if (since !== null) { list = list.filter(m => m.gameCreation >= since); parts.push(`since ${args.since}`); }
    // until is inclusive of that whole day
    if (until !== null) { list = list.filter(m => m.gameCreation < until + 86400000); parts.push(`until ${args.until}`); }

    // Newest first, so "last N games" is a simple slice
    list.sort((a, b) => b.gameCreation - a.gameCreation);
    const n = Number.parseInt(args.last_n_games, 10);
    if (Number.isFinite(n) && n > 0) { list = list.slice(0, n); parts.push(`last ${n} games`); }

    return { matches: list, description: parts.length ? parts.join(', ') : 'all stored games' };
}

function dateRange(list) {
    if (!list.length) return null;
    let lo = Infinity, hi = -Infinity;
    for (const m of list) { lo = Math.min(lo, m.gameCreation); hi = Math.max(hi, m.gameCreation); }
    return { from: localDate(lo), to: localDate(hi) };
}

function sampleNote(games) {
    if (games === 0) return 'No games match these filters.';
    if (games < 10)  return `Only ${games} games — too few to draw firm conclusions.`;
    return undefined;
}

/**
 * Per-game basics for a list of matches (used by the breakdown tools).
 *
 * Uses the SAME definitions as analyticsEngine.calcOverview so the chat never
 * contradicts a card: KDA is total (K+A)/total D; CS/min and damage/min are the
 * average of each game's own rate (not total ÷ total minutes); kill
 * participation counts a game with zero team kills as 0%.
 */
function basics(list) {
    const g = list.length;
    let w = 0, k = 0, d = 0, a = 0, secs = 0;
    let csm = 0, dmgm = 0, kp = 0, vism = 0, rated = 0;
    for (const m of list) {
        if (m.win === 1 || m.win === true) w++;
        k += m.kills || 0; d += m.deaths || 0; a += m.assists || 0;
        secs += m.gameDuration || 0;
        kp += m.teamKills > 0 ? ((m.kills || 0) + (m.assists || 0)) / m.teamKills : 0;
        const mins = (m.gameDuration || 0) / 60;
        if (mins > 0) {
            csm  += (m.totalMinionsKilled || 0) / mins;
            dmgm += (m.totalDamageDealtToChampions || 0) / mins;
            vism += (m.visionScore || 0) / mins;
            rated++;
        }
    }
    return {
        games: g,
        wins: w,
        losses: g - w,
        win_rate_pct: g ? round((w / g) * 100, 1) : null,
        kda: g ? round((k + a) / Math.max(1, d), 2) : null,
        avg_kills: g ? round(k / g, 1) : null,
        avg_deaths: g ? round(d / g, 1) : null,
        avg_assists: g ? round(a / g, 1) : null,
        cs_per_min: rated ? round(csm / rated, 2) : null,
        damage_per_min: rated ? round(dmgm / rated, 0) : null,
        kill_participation_pct: g ? round((kp / g) * 100, 1) : null,
        vision_per_min: rated ? round(vism / rated, 2) : null,
        avg_game_minutes: g ? round(secs / 60 / g, 1) : null,
    };
}

function cardsToStats(cards) {
    return cards.map(c => {
        const out = { stat: c.label.replace(/\s*\(\d+g\)\s*$/, ''), value: c.displayValue };
        if (c.benchmarkable && c.benchmarkRank && c.benchmarkRank !== 'unrated') out.tier = c.benchmarkRank;
        if (c.higherIsBetter === false) out.lower_is_better = true;
        return out;
    });
}

/** Find a stat card by name/id across all tabs. */
function resolveStat(name, ctx, matches) {
    const q = norm(name);
    if (!q) return null;
    const candidates = [];
    for (const tab of TABS) {
        for (const c of ctx.computeTabStats(tab, matches, []) || []) {
            candidates.push({ tab, id: c.id, label: c.label, aggregationType: c.aggregationType,
                              n: norm(c.label.replace(/\s*\(\d+g\)\s*$/, '')) });
        }
    }
    return candidates.find(c => c.id === name || c.n === q)
        || candidates.find(c => c.n.startsWith(q) || q.startsWith(c.n))
        || candidates.find(c => c.n.includes(q) || q.includes(c.n))
        || null;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const FILTER_PROPS = {
    queue: { type: 'string', enum: ['all', 'solo', 'flex', 'ranked', 'premade', 'normal'],
             description: 'Which games: all, solo (Ranked Solo/Duo), flex (Ranked Flex), ranked (Solo + Flex), premade (Ranked Premade, 5-stack), normal. Default all.' },
    champion: { type: 'string', description: 'Only games on this champion, e.g. "Ahri".' },
    role: { type: 'string', enum: ['top', 'jungle', 'mid', 'adc', 'support'], description: 'Only games in this role.' },
    since: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive).' },
    until: { type: 'string', description: 'End date YYYY-MM-DD (inclusive).' },
    last_n_games: { type: 'integer', description: 'Only the most recent N games (after the other filters).' },
};

const TOOLS = [
    {
        name: 'get_overview',
        description: 'Headline numbers for a set of games: games played, wins/losses, win rate, KDA, CS per minute, damage per minute, kill participation, vision, game length, date range, and most-played champions/roles. Start here for general questions.',
        parameters: { type: 'object', properties: { ...FILTER_PROPS } },
        run(args, ctx) {
            const f = applyFilters(ctx.matches, args);
            if (f.error) return { error: f.error };
            const list = f.matches;
            const champCounts = {}, roleCounts = {};
            for (const m of list) {
                champCounts[m.championName] = (champCounts[m.championName] || 0) + 1;
                if (m.teamPosition) roleCounts[m.teamPosition] = (roleCounts[m.teamPosition] || 0) + 1;
            }
            const top = (obj, label = x => x) => Object.entries(obj).sort((a, b) => b[1] - a[1])
                .slice(0, 3).map(([k, v]) => `${label(k)} (${v})`);
            // Rank tier per headline stat, straight from the Overview cards
            const tiers = {};
            for (const c of ctx.computeTabStats('Overview', list, []) || []) {
                if (c.benchmarkable && c.benchmarkRank && c.benchmarkRank !== 'unrated') tiers[c.label] = c.benchmarkRank;
            }
            return {
                filters: f.description,
                dates: dateRange(list),
                ...basics(list),
                rank_tiers: Object.keys(tiers).length ? tiers : undefined,
                most_played_champions: top(champCounts),
                most_played_roles: top(roleCounts, r => ROLE_LABEL[r] || r),
                note: sampleNote(list.length),
            };
        },
    },
    {
        name: 'get_category_stats',
        description: 'Detailed stats for one category, exactly as shown on that tab of the app, each with its rank tier (iron..challenger) where benchmarked. Categories: Overview, Lane Phase, Combat, Death Review, Objectives, Vision, Economy, Macro, Consistency.',
        parameters: {
            type: 'object',
            properties: {
                category: { type: 'string', enum: TABS, description: 'Which category.' },
                ...FILTER_PROPS,
            },
            required: ['category'],
        },
        run(args, ctx) {
            const tab = TABS.find(t => norm(t) === norm(args.category));
            if (!tab) return { error: `Unknown category "${args.category}". Use one of: ${TABS.join(', ')}.` };
            const f = applyFilters(ctx.matches, args);
            if (f.error) return { error: f.error };
            const cards = ctx.computeTabStats(tab, f.matches, []) || [];
            return {
                category: tab,
                filters: f.description,
                games: f.matches.length,
                stats: cardsToStats(cards),
                note: sampleNote(f.matches.length),
            };
        },
    },
    {
        name: 'get_stat_trend',
        description: 'How one stat changed month by month over the last 12 months (e.g. "Win Rate", "Avg KDA", "CSD@15", "Vision Score", "Deaths/Game"). Months with under 5 games are unreliable.',
        parameters: {
            type: 'object',
            properties: {
                stat: { type: 'string', description: 'Stat name as shown in the app, e.g. "Win Rate", "Avg CS/M", "GD@15".' },
                ...FILTER_PROPS,
            },
            required: ['stat'],
        },
        run(args, ctx) {
            const f = applyFilters(ctx.matches, { ...args, last_n_games: undefined });
            if (f.error) return { error: f.error };
            const found = resolveStat(args.stat, ctx, f.matches.length ? f.matches : ctx.matches);
            if (!found) return { error: `Unknown stat "${args.stat}". Try names like Win Rate, Avg KDA, Avg CS/M, CSD@15, Vision Score.` };
            if (!ctx.statHistory.isChartable({ id: found.id, aggregationType: found.aggregationType })) {
                return { error: `"${found.label}" has no meaningful monthly trend.` };
            }
            const h = ctx.statHistory.computeMonthlyHistory({
                tabName: found.tab, statId: found.id, matches: f.matches,
                computeTabStats: ctx.computeTabStats, now: ctx.now ? ctx.now() : new Date(),
            });
            return {
                stat: found.label.replace(/\s*\(\d+g\)\s*$/, ''),
                filters: f.description,
                months: h.points.map(p => ({
                    month: `${p.year}-${pad2(p.month + 1)}`,
                    games: p.games,
                    value: p.games ? p.display : null,
                    ...(p.tier ? { tier: p.tier } : {}),
                    ...(p.games > 0 && p.games < 5 ? { unreliable: true } : {}),
                    ...(p.isCurrent ? { partial_month: true } : {}),
                })),
            };
        },
    },
    {
        name: 'get_champion_stats',
        description: 'Per-champion results: games, win rate, KDA, CS/min, damage/min. Use for "best champions", "what should I play", or comparing champions.',
        parameters: {
            type: 'object',
            properties: {
                ...FILTER_PROPS,
                sort_by: { type: 'string', enum: ['games', 'win_rate', 'kda'], description: 'Default games.' },
                min_games: { type: 'integer', description: 'Ignore champions with fewer games. Default 3.' },
                limit: { type: 'integer', description: 'How many champions to return. Default 10, max 25.' },
            },
        },
        run(args, ctx) {
            const f = applyFilters(ctx.matches, args);
            if (f.error) return { error: f.error };
            const groups = {};
            for (const m of f.matches) (groups[m.championName] = groups[m.championName] || []).push(m);
            const minGames = Math.max(1, Number.parseInt(args.min_games, 10) || 3);
            const limit = Math.min(25, Math.max(1, Number.parseInt(args.limit, 10) || 10));
            const key = { win_rate: 'win_rate_pct', kda: 'kda' }[args.sort_by] || 'games';
            const rows = Object.entries(groups)
                .map(([name, list]) => {
                    const b = basics(list);
                    return { champion: name, games: b.games, win_rate_pct: b.win_rate_pct, kda: b.kda,
                             cs_per_min: b.cs_per_min, damage_per_min: b.damage_per_min };
                })
                .filter(r => r.games >= minGames)
                .sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1) || b.games - a.games);
            return {
                filters: f.description,
                total_games: f.matches.length,
                champions_shown: Math.min(limit, rows.length),
                champions_with_enough_games: rows.length,
                min_games: minGames,
                champions: rows.slice(0, limit),
            };
        },
    },
    {
        name: 'get_role_stats',
        description: 'Results per role (Top, Jungle, Mid, ADC, Support): games, win rate, KDA, CS/min.',
        parameters: { type: 'object', properties: { ...FILTER_PROPS } },
        run(args, ctx) {
            const f = applyFilters(ctx.matches, { ...args, role: undefined });
            if (f.error) return { error: f.error };
            const groups = {};
            for (const m of f.matches) {
                const r = m.teamPosition || 'UNKNOWN';
                (groups[r] = groups[r] || []).push(m);
            }
            return {
                filters: f.description,
                roles: Object.entries(groups)
                    .map(([r, list]) => {
                        const b = basics(list);
                        return { role: ROLE_LABEL[r] || 'Unknown', games: b.games, win_rate_pct: b.win_rate_pct,
                                 kda: b.kda, cs_per_min: b.cs_per_min, damage_per_min: b.damage_per_min };
                    })
                    .sort((a, b) => b.games - a.games),
            };
        },
    },
    {
        name: 'get_recent_games',
        description: 'List individual recent games, newest first: date, champion, role, queue, win/loss, K/D/A, CS, damage, length, and LP change when known.',
        parameters: {
            type: 'object',
            properties: {
                ...FILTER_PROPS,
                count: { type: 'integer', description: 'How many games. Default 10, max 30.' },
            },
        },
        run(args, ctx) {
            const f = applyFilters(ctx.matches, args);
            if (f.error) return { error: f.error };
            const count = Math.min(30, Math.max(1, Number.parseInt(args.count, 10) || 10));
            const lp = ctx.lpDeltas || {};
            return {
                filters: f.description,
                games: f.matches.slice(0, count).map(m => {
                    const mins = (m.gameDuration || 0) / 60;
                    const row = {
                        date: localDateTime(m.gameCreation),
                        champion: m.championName,
                        role: ROLE_LABEL[m.teamPosition] || null,
                        queue: QUEUE_LABEL[m.queueId] || `Queue ${m.queueId}`,
                        result: (m.win === 1 || m.win === true) ? 'Win' : 'Loss',
                        kda: `${m.kills}/${m.deaths}/${m.assists}`,
                        cs: m.totalMinionsKilled,
                        cs_per_min: mins ? round(m.totalMinionsKilled / mins, 1) : null,
                        damage: m.totalDamageDealtToChampions,
                        minutes: round(mins, 0),
                    };
                    if (Number.isFinite(lp[m.matchId])) row.lp_change = lp[m.matchId];
                    return row;
                }),
            };
        },
    },
    {
        name: 'get_rank_and_lp',
        description: 'Current rank and recent LP movement for Ranked Solo/Duo or Ranked Flex, from LP readings the app has recorded.',
        parameters: {
            type: 'object',
            properties: { queue: { type: 'string', enum: ['solo', 'flex'], description: 'Default solo.' } },
        },
        async run(args, ctx) {
            const queue = args.queue === 'flex' ? 'flex' : 'solo';
            const readings = (await ctx.getLpReadings(queue)) || [];
            if (!readings.length) return { queue, error: 'No LP readings recorded for this queue yet.' };
            const abs = r => ctx.absoluteLp(r.tier, r.rank, r.lp);
            const last = readings[readings.length - 1];
            const ago = days => {
                const cutoff = (ctx.now ? ctx.now() : new Date()).getTime() - days * 86400000;
                const before = readings.filter(r => r.recorded_at <= cutoff);
                return before.length ? abs(last) - abs(before[before.length - 1]) : null;
            };
            let peak = readings[0];
            for (const r of readings) if (abs(r) > abs(peak)) peak = r;
            return {
                queue: queue === 'solo' ? 'Ranked Solo/Duo' : 'Ranked Flex',
                current: `${last.tier} ${last.rank} ${last.lp} LP`,
                as_of: localDate(last.recorded_at),
                lp_change_last_7_days: ago(7),
                lp_change_last_30_days: ago(30),
                peak: `${peak.tier} ${peak.rank} ${peak.lp} LP (${localDate(peak.recorded_at)})`,
                readings_recorded: readings.length,
            };
        },
    },
    {
        name: 'get_coaching_focus',
        description: "The app's coaching analysis of Ranked Solo/Duo games this season: the single habit to focus on, how much win rate it is worth, and other habits ranked. Use for \"what should I improve\" or \"how do I climb\".",
        parameters: { type: 'object', properties: {} },
        async run(args, ctx) {
            const { rows } = await ctx.getCoachingData(ctx.seasonStart, 0);
            if (!rows || !rows.length) return { error: 'No Ranked Solo/Duo games this season.' };
            const r = ctx.CoachingEngine.analyse(rows, {});
            if (r.empty) return { error: 'Not enough Solo/Duo games to analyse.' };
            const fmt = (x, dec = 1) => (Number.isFinite(x) ? round(x, dec) : null);
            const habit = h => h && ({
                habit: h.label,
                rule: h.rule,
                your_average: fmt(h.current, h.decimals ?? 1),
                target: fmt(h.target, h.decimals ?? 1),
                win_rate_when_met_pct: fmt(h.wrMet),
                win_rate_when_missed_pct: fmt(h.wrMissed),
                games_missed: h.failedGames,
                games_met: h.metGames,
                confident: !!h.confident,
            });
            return {
                ranked_solo_games_analysed: r.sampleSize,
                main_role: r.roleLabel,
                focus: habit(r.focus),
                other_habits: (r.allInputs || []).filter(h => !r.focus || h.id !== r.focus.id).slice(0, 4).map(habit),
            };
        },
    },
];

/** Ollama/OpenAI-style tool schemas for the chat request. */
function toolSchemas() {
    return TOOLS.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
}

/** Short human description of a tool call, for the "looked up…" line in the chat. */
function describeCall(name, args = {}) {
    const what = {
        get_overview: 'overall stats',
        get_category_stats: `${args.category || 'category'} stats`,
        get_stat_trend: `${args.stat || 'stat'} by month`,
        get_champion_stats: 'champion stats',
        get_role_stats: 'role stats',
        get_recent_games: 'recent games',
        get_rank_and_lp: `${args.queue === 'flex' ? 'Flex' : 'Solo/Duo'} rank and LP`,
        get_coaching_focus: 'coaching analysis',
    }[name] || name;
    const bits = [];
    if (args.queue && args.queue !== 'all' && name !== 'get_rank_and_lp') bits.push(args.queue);
    if (args.champion) bits.push(args.champion);
    if (args.role) bits.push(args.role);
    if (args.since || args.until) bits.push(`${args.since || '…'} → ${args.until || 'now'}`);
    if (args.last_n_games) bits.push(`last ${args.last_n_games}`);
    return bits.length ? `${what} (${bits.join(', ')})` : what;
}

/**
 * Run one tool call. Never throws: failures come back as { error } so the
 * model can explain them instead of the chat breaking.
 */
async function executeTool(name, args, ctx) {
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) return { error: `Unknown tool "${name}".` };
    let parsed = args;
    if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch { parsed = {}; }
    }
    try {
        const out = await tool.run(parsed || {}, ctx);
        // Drop undefined keys so the JSON the model sees stays compact
        return JSON.parse(JSON.stringify(out));
    } catch (err) {
        return { error: `Tool failed: ${err.message}` };
    }
}

module.exports = {
    TOOLS, TABS, toolSchemas, executeTool, describeCall,
    // exported for tests
    _internal: { applyFilters, basics, championMatcher, resolveStat, parseDay },
};
