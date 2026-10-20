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

const {
    QUEUE_LABEL, ROLE_LABEL, FILTER_PROPS, norm, posInt, parseDay, championMatcher, applyFilters, filterOptions,
} = require('./chatFilters');
const { comparePatchDesc } = require('../services/patches');
const { compareGame, comparisonPools, highlights, blunders, REPORT_STATS } = require('../services/gameReport');
const { decodePurchases, encodePurchases, purchasesFromTimeline, firstBackAt, buildOrderTable, firstBackStats } =
    require('../services/itemBuild');
const { itemWpa, itemTable, winChancePoints, asStored } = require('../services/itemWpa');
const { teamSeries, timelineEvents, formatClock } = require('../services/matchTimeline');
const { computeTeamImpact } = require('../services/teamImpact');
const { decodeDeaths, zoneOf, ZONE_LABELS } = require('../services/deathMap');
const { curveSummary, winChanceStats, THROW_PEAK, COMEBACK_LOW, AHEAD_AT_15, BEHIND_AT_15 } =
    require('../services/winChanceStats');

const TABS = ['Overview', 'Lane Phase', 'Combat', 'Death Review', 'Objectives',
              'Vision', 'Economy', 'Macro', 'Consistency'];

const LOW_SAMPLE = 5;    // an average WPA over fewer games isn't shown (as on the Champions page)

const WPA_NOTE = "WPA = average change in your team's estimated win chance from buying the item until your next " +
    'trip to the shop (at most 5 min). It shows how games went while you had the item, not what the item caused.';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const round = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const pct   = (part, whole) => (whole ? round((part / whole) * 100, 1) : null);
const pad2  = n => String(n).padStart(2, '0');
const isWin = m => m.win === 1 || m.win === true;

function localDate(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function localDateTime(ms) {
    const d = new Date(ms);
    return `${localDate(ms)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** The shared filters over the chat's games, with the context's clock. */
function filtered(ctx, args) {
    return applyFilters(ctx.matches, args, { now: ctx.now ? ctx.now().getTime() : Date.now() });
}

/**
 * Load the JSON blobs a tab needs for games not indexed yet. Once every game
 * is indexed this touches nothing (see analyticsEngine.prefetchTabJson).
 */
async function prefetch(ctx, tab, list) {
    if (ctx.prefetchTabJson && list.length) await ctx.prefetchTabJson(tab, list);
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
// One game (get_game_detail)
// ---------------------------------------------------------------------------

const parseBlob = v => (typeof v === 'string' ? JSON.parse(v) : v || null);
const VERDICT = { good: 'better', bad: 'worse', even: 'similar' };

/** The game's rawJson and timeline, or nulls when they can't be read. */
async function loadFullGame(ctx, matchId) {
    if (!ctx.getMatchById) return { raw: null, timeline: null };
    try {
        const full = await ctx.getMatchById(matchId);
        return { raw: parseBlob(full && full.rawJson), timeline: parseBlob(full && full.timelineJson) };
    } catch {
        return { raw: null, timeline: null };
    }
}

/** This game against your usual, as in its Game report (#9). */
async function reportSection(game, ctx) {
    const pools = comparisonPools(game, ctx.matches);
    for (const tab of new Set(REPORT_STATS.map(s => s.tab))) await prefetch(ctx, tab, [game, ...pools.season]);
    const { rows, games } = compareGame(game, ctx.matches, ctx.computeTabStats);
    const col = c => (c ? `${c.display} (${VERDICT[c.verdict] || 'similar'})` : undefined);
    const h = highlights(rows);
    return {
        went_well: h.good,
        went_wrong: h.bad,
        stats_vs_your_usual: rows.map(r => ({
            stat: r.label, this_game: r.game.display,
            season: col(r.season), patch: col(r.patch), last_7_days: col(r.week),
        })),
        compared_games: { season: games.season, patch: games.patch, last_7_days: games.week },
    };
}

/** What happened inside one win-chance swing, from your side. */
function swingEvents(events, swing, teamId, pid) {
    const inside = events.filter(e => e.t > swing.fromT && e.t <= swing.toT);
    const out = [];
    const kills = inside.filter(e => e.kind === 'kill');
    if (kills.length) {
        const ours = kills.filter(e => e.killerTeam === teamId).length;
        out.push(`kills: your team ${ours}, enemy ${kills.length - ours}`);
    }
    for (const e of kills.filter(k => k.victimId === pid)) out.push(`you died at ${formatClock(e.t)} (${e.label})`);
    for (const e of inside.filter(x => x.kind !== 'kill')) {
        out.push(`${e.team === teamId ? 'your team' : 'enemy'} ${e.kind === 'structure' ? 'destroyed' : 'took'} ${e.label}`);
    }
    // Voidgrubs come in threes: "your team took Voidgrubs ×3", not three lines
    const counted = new Map();
    for (const line of out) counted.set(line, (counted.get(line) || 0) + 1);
    return [...counted].map(([line, n]) => (n > 1 ? `${line} ×${n}` : line)).slice(0, 6);
}

function winChanceSection(points, events, teamId, pid) {
    const c = curveSummary(points);
    if (!c) return undefined;
    return {
        by_minute: Object.fromEntries(c.byMinute.map(b => [String(b.minute), Math.round(b.p)])),
        at_end: Math.round(c.end.p),
        peak: `${Math.round(c.peak.p)}% at ${formatClock(c.peak.t)}`,
        low: `${Math.round(c.low.p)}% at ${formatClock(c.low.t)}`,
        biggest_swings: c.swings.map(s => ({
            from: formatClock(s.fromT), to: formatClock(s.toT),
            win_chance: `${Math.round(s.from)}% → ${Math.round(s.to)}%`,
            what_happened: events.length ? swingEvents(events, s, teamId, pid) : undefined,
        })),
    };
}

function itemsSection(game, purchases, points, ctx) {
    const name = ctx.itemName || (id => `Item ${id}`);
    const isCore = ctx.isCoreItem || (() => true);
    const wpa = itemWpa(purchases, points);
    const bought = purchases.map((p, i) => ({ p, w: wpa[i] }))
        .filter(({ p }) => isCore(p.itemId))
        .map(({ p, w }) => ({
            item: name(p.itemId),
            at: formatClock(p.t),
            win_chance: w ? `${Math.round(w.from)}% → ${Math.round(w.to)}%` : undefined,
            wpa: w ? Math.round(w.wpa) : undefined,
        }));
    const back = firstBackAt(purchases);
    return {
        final_build: [game.item0, game.item1, game.item2, game.item3, game.item4, game.item5].filter(id => id > 0).map(name),
        finished_items_bought: bought.length ? bought : undefined,
        first_back: back === null ? undefined : formatClock(back),
    };
}

/** "14:05, mid-map, Zed killed Ahri" per death. */
function deathsSection(game, events, pid) {
    const kills = events.filter(e => e.kind === 'kill' && e.victimId === pid);
    const placed = decodeDeaths(game.deathPositions);
    const list = placed.length ? placed : kills.map(k => ({ t: k.t }));
    return list.map(d => {
        const k = kills.find(e => Math.abs(e.t - d.t) < 1500);
        return [formatClock(d.t), Number.isFinite(d.x) ? ZONE_LABELS[zoneOf(d)] : null, k ? k.label : null]
            .filter(Boolean).join(', ');
    });
}

/** Both teams, one line per player: champion, role, K/D/A, damage, impact rank. */
function playersSection(participants, game, pid) {
    if (!participants.length) return {};
    const impact = computeTeamImpact(participants);
    const line = (p, i) => {
        const id = p.participantId || i + 1;
        const imp = impact.get(id);
        const role = ROLE_LABEL[p.teamPosition];
        return `${p.championName}${role ? ` (${role})` : ''} ${p.kills}/${p.deaths}/${p.assists}, ` +
            `${round((p.totalDamageDealtToChampions || 0) / 1000, 1)}k damage` +
            (imp ? `, impact #${imp.rank}${imp.tag ? ` ${imp.tag}` : ''}` : '') +
            (id === pid ? ' (you)' : '');
    };
    const rows = participants.map((p, i) => ({ p, i }));
    return {
        your_team: rows.filter(r => r.p.teamId === game.teamId).map(r => line(r.p, r.i)),
        enemy_team: rows.filter(r => r.p.teamId !== game.teamId).map(r => line(r.p, r.i)),
    };
}

async function gameDetail(args, ctx) {
    let game;
    if (args.match_id) {
        game = ctx.matches.find(m => m.matchId === String(args.match_id).trim());
        if (!game) return { error: `No stored game "${args.match_id}" (remakes are left out).` };
    } else {
        const f = filtered(ctx, args);
        if (f.error) return { error: f.error };
        const nth = posInt(args.nth) || 1;
        game = f.matches[nth - 1];
        if (!game) return { error: f.matches.length ? `Only ${f.matches.length} games match (${f.description}).` : `No games match (${f.description}).` };
    }

    const { raw, timeline } = await loadFullGame(ctx, game.matchId);
    const participants = (raw && raw.info && raw.info.participants) || [];
    const me = participants.findIndex(p => p.championName === game.championName && p.teamId === game.teamId);
    const pid = me >= 0 ? (participants[me].participantId || me + 1) : null;
    const full = !!(raw && timeline && pid !== null);

    // Stored columns first (what the Champions page and tooltips use), the timeline for games not indexed yet
    let points = winChancePoints(game.winChance, game.gameDuration);
    let purchases = decodePurchases(game.itemPurchases);
    if (full && points.length < 2) points = asStored([], teamSeries(raw, timeline, game.teamId), game.gameDuration).points;
    if (full && !purchases.length) purchases = decodePurchases(encodePurchases(purchasesFromTimeline(timeline, pid)));
    const events = full ? timelineEvents(raw, timeline) : [];

    const mins = (game.gameDuration || 0) / 60;
    const lp = (ctx.lpDeltas || {})[game.matchId];
    const report = await reportSection(game, ctx);
    return {
        match_id: game.matchId,
        date: localDateTime(game.gameCreation),
        champion: game.championName,
        role: ROLE_LABEL[game.teamPosition],
        queue: QUEUE_LABEL[game.queueId] || `Queue ${game.queueId}`,
        patch: game.patch || undefined,
        result: isWin(game) ? 'Win' : 'Loss',
        length: formatClock((game.gameDuration || 0) * 1000),
        kda: `${game.kills}/${game.deaths}/${game.assists}`,
        cs: game.totalMinionsKilled,
        cs_per_min: mins ? round(game.totalMinionsKilled / mins, 1) : null,
        damage: game.totalDamageDealtToChampions,
        gold: game.goldEarned,
        vision_score: game.visionScore,
        lane_opponent: game.laneOpponent || undefined,
        gold_diff_at_15: round(game.goldDiff15, 0),
        cs_diff_at_15: round(game.csDiff15, 0),
        xp_diff_at_15: round(game.xpDiff15, 0),
        impact: Number.isFinite(game.impactRank) ? `#${game.impactRank} of 10${game.impactTag ? ` (${game.impactTag})` : ''}` : undefined,
        lp_change: Number.isFinite(lp) ? lp : undefined,
        went_well: report.went_well,
        went_wrong: report.went_wrong,
        blunders: full ? blunders(raw, timeline, pid, game.teamId) : undefined,
        stats_vs_your_usual: report.stats_vs_your_usual,
        compared_games: report.compared_games,
        stats_note: 'season / patch / last_7_days are your averages in other games of this queue and role; better / worse says how THIS game compares (10%+ difference).',
        win_chance: winChanceSection(points, events, game.teamId, pid),
        items: itemsSection(game, purchases, points, ctx),
        runes: ctx.runeName && game.primaryRune
            ? { keystone: ctx.runeName(game.primaryRune), secondary_tree: ctx.runeName(game.secondaryRuneStyle) } : undefined,
        deaths: deathsSection(game, events, pid),
        ...playersSection(participants, game, pid),
        wpa_note: points.length >= 2 ? WPA_NOTE : undefined,
        missing: !full && points.length < 2 ? 'No timeline stored for this game: no win chance, blunders or purchase times.' : undefined,
    };
}

// ---------------------------------------------------------------------------
// Many games: breakdowns, items, win chance
// ---------------------------------------------------------------------------

function itemStats(args, ctx) {
    const f = filtered(ctx, args);
    if (f.error) return { error: f.error };
    const games = f.matches.filter(m => m.itemPurchases).map(m => {
        const purchases = decodePurchases(m.itemPurchases);
        return {
            purchases, win: isWin(m), firstBackAt: firstBackAt(purchases),
            finalItems: [m.item0, m.item1, m.item2, m.item3, m.item4, m.item5],
            wpa: itemWpa(purchases, winChancePoints(m.winChance, m.gameDuration)),
        };
    });
    const base = { filters: f.description, games: f.matches.length, games_with_purchase_data: games.length };
    if (!games.length) return { ...base, error: 'No purchase data for these games yet. It is filled in for games with a stored timeline.' };

    const name = ctx.itemName || (id => `Item ${id}`);
    const wpaOf = r => (r.wpaGames >= LOW_SAMPLE ? round(r.wpa, 1) : undefined);
    const rate = r => ({ games: r.games, pick_rate_pct: round(r.pickRate * 100, 0), win_rate_pct: round(r.winRate * 100, 1), avg_wpa: wpaOf(r) });
    const minGames = Math.max(1, posInt(args.min_games) || 3);
    const limit = Math.min(30, posInt(args.limit) || 12);
    const sortKey = {
        win_rate: r => r.winRate,
        wpa: r => (r.wpaGames >= LOW_SAMPLE ? r.wpa : -Infinity),
    }[args.sort_by] || (r => r.games);
    const items = itemTable(games, ctx.isCoreItem || (() => true))
        .filter(r => r.games >= minGames)
        .sort((a, b) => sortKey(b) - sortKey(a) || b.games - a.games)
        .slice(0, limit)
        .map(r => ({ item: name(r.itemId), ...rate(r), usually_bought_at: formatClock(r.avgT) }));

    let buildOrder;
    if (args.champion) {
        const t = buildOrderTable(games, {
            isExcluded: ctx.isExcludedItem || (() => false),
            isCompleted: ctx.isBuildItem || ctx.isCoreItem || (() => true),
        });
        const names = key => String(key).split('+').map(id => name(Number(id))).join(' + ');
        const rows = list => list.slice(0, 3).map(r => ({ items: names(r.key), ...rate(r) }));
        buildOrder = {
            starting_items: rows(t.start), first_back: rows(t.firstBack),
            first_item: rows(t.core[0]), second_item: rows(t.core[1]), third_item: rows(t.core[2]),
            note: 'Numbered items are finished items you kept, in purchase order, boots left out.',
        };
    }
    const fb = firstBackStats(games);
    return {
        ...base,
        items,
        build_order: buildOrder,
        first_back: fb.medianMs === null ? undefined : {
            median: formatClock(fb.medianMs), games: fb.games,
            win_rate_when_earlier_pct: fb.faster ? round(fb.faster.winRate * 100, 1) : null,
            win_rate_when_later_pct: fb.slower ? round(fb.slower.winRate * 100, 1) : null,
        },
        note: `${WPA_NOTE} avg_wpa is left out under ${LOW_SAMPLE} games with a win-chance curve.`,
    };
}

const BREAKDOWNS = {
    champion:      { keyOf: m => m.championName, minGames: 3 },
    role:          { keyOf: m => ROLE_LABEL[m.teamPosition] || 'No role', minGames: 1 },
    lane_opponent: { keyOf: m => m.laneOpponent, minGames: 2 },
    patch:         { keyOf: m => m.patch, minGames: 1 },
    queue:         { keyOf: m => QUEUE_LABEL[m.queueId] || `Queue ${m.queueId}`, minGames: 1 },
};

const mean = xs => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

function breakdown(args, ctx) {
    const by = String(args.by || '').toLowerCase().replace(/[\s-]+/g, '_');
    if (!Object.hasOwn(BREAKDOWNS, by)) return { error: `Unknown breakdown "${args.by}". Use ${Object.keys(BREAKDOWNS).join(', ')}.` };
    const f = filtered(ctx, args);
    if (f.error) return { error: f.error };
    const { keyOf } = BREAKDOWNS[by];
    const groups = new Map();
    for (const m of f.matches) {
        const key = keyOf(m);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(m);
    }
    const minGames = Math.max(1, posInt(args.min_games) || BREAKDOWNS[by].minGames);
    const limit = Math.min(25, posInt(args.limit) || 10);
    const rows = [...groups].map(([key, list]) => {
        const b = basics(list);
        const row = { [by]: key, games: b.games, wins: b.wins, losses: b.losses, win_rate_pct: b.win_rate_pct,
                      kda: b.kda, cs_per_min: b.cs_per_min, damage_per_min: b.damage_per_min };
        if (by === 'lane_opponent') {
            row.gold_diff_at_15 = round(mean(list.map(m => m.goldDiff15)), 0);
            row.cs_diff_at_15 = round(mean(list.map(m => m.csDiff15)), 1);
        }
        return row;
    }).filter(r => r.games >= minGames);

    const order = {
        win_rate_high: (x, y) => y.win_rate_pct - x.win_rate_pct,
        win_rate_low: (x, y) => x.win_rate_pct - y.win_rate_pct,
        kda: (x, y) => (y.kda ?? -1) - (x.kda ?? -1),
        games: () => 0,
    }[args.sort_by] || (by === 'patch' ? (x, y) => comparePatchDesc(x.patch, y.patch) : () => 0);
    rows.sort((x, y) => order(x, y) || y.games - x.games);

    const grouped = [...groups.values()].reduce((n, l) => n + l.length, 0);
    return {
        filters: f.description,
        games: f.matches.length,
        games_without_a_value: f.matches.length - grouped || undefined,
        min_games: minGames,
        shown: Math.min(limit, rows.length),
        with_enough_games: rows.length,
        rows: rows.slice(0, limit),
        note: sampleNote(f.matches.length),
    };
}

function winChancePatterns(args, ctx) {
    const f = filtered(ctx, args);
    if (f.error) return { error: f.error };
    const games = f.matches.map(m => ({ m, win: isWin(m), points: winChancePoints(m.winChance, m.gameDuration) }));
    const s = winChanceStats(games);
    const base = { filters: f.description, games: f.matches.length, games_with_win_chance: s.games };
    if (!s.games) return { ...base, error: 'No win-chance data for these games yet. It needs a stored timeline.' };

    const curves = games.filter(g => g.points.length >= 2);
    const wins = curves.filter(g => g.win).length;
    const row = r => ({ games: r.games, win_rate_pct: pct(r.wins, r.games) });
    const example = (g, at) => `${localDate(g.m.gameCreation)} ${g.m.championName}: ${Math.round(at.p)}% at ${formatClock(at.t)}`;
    return {
        ...base,
        average_win_chance_pct: {
            at_10_min: round(s.average[10], 0), at_15_min: round(s.average[15], 0), at_20_min: round(s.average[20], 0),
        },
        by_win_chance_at_15_min: { ahead: row(s.at15.ahead), even: row(s.at15.even), behind: row(s.at15.behind) },
        throws: { games: s.throws.length, share_of_losses_pct: pct(s.throws.length, curves.length - wins),
                  newest: s.throws.slice(0, 5).map(g => example(g, g.peak)) },
        comebacks: { games: s.comebacks.length, share_of_wins_pct: pct(s.comebacks.length, wins),
                     newest: s.comebacks.slice(0, 5).map(g => example(g, g.low)) },
        definitions: `ahead = ${AHEAD_AT_15}%+ at 15 min, behind = ${BEHIND_AT_15}% or less; ` +
            `throw = lost after reaching ${THROW_PEAK}%+; comeback = won after falling to ${COMEBACK_LOW}% or less. ` +
            'Win chance is the app\'s estimate from gold, XP and kills, not Riot data.',
    };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
    {
        name: 'get_overview',
        description: 'Headline numbers for a set of games: games played, wins/losses, win rate, KDA, CS per minute, damage per minute, kill participation, vision, game length, date range, and most-played champions/roles. Start here for general questions.',
        parameters: { type: 'object', properties: { ...FILTER_PROPS } },
        run(args, ctx) {
            const f = filtered(ctx, args);
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
        async run(args, ctx) {
            const tab = TABS.find(t => norm(t) === norm(args.category));
            if (!tab) return { error: `Unknown category "${args.category}". Use one of: ${TABS.join(', ')}.` };
            const f = filtered(ctx, args);
            if (f.error) return { error: f.error };
            await prefetch(ctx, tab, f.matches);
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
        async run(args, ctx) {
            const f = filtered(ctx, { ...args, last_n_games: undefined });
            if (f.error) return { error: f.error };
            const found = resolveStat(args.stat, ctx, f.matches.length ? f.matches : ctx.matches);
            if (!found) return { error: `Unknown stat "${args.stat}". Try names like Win Rate, Avg KDA, Avg CS/M, CSD@15, Vision Score.` };
            if (!ctx.statHistory.isChartable({ id: found.id, aggregationType: found.aggregationType })) {
                return { error: `"${found.label}" has no meaningful monthly trend.` };
            }
            await prefetch(ctx, found.tab, f.matches);
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
        name: 'get_breakdown',
        description: 'Results split by champion, role, lane opponent, patch or queue: games, wins/losses, win rate, KDA, CS/min, damage/min (lane opponent adds gold and CS difference at 15). For best champions, roles, who you struggle against, win rate per patch.',
        parameters: {
            type: 'object',
            properties: {
                by: { type: 'string', enum: Object.keys(BREAKDOWNS) },
                ...FILTER_PROPS,
                sort_by: { type: 'string', enum: ['games', 'win_rate_high', 'win_rate_low', 'kda'], description: 'Default games (patch: newest).' },
                min_games: { type: 'integer', description: 'Default 3 for champion, 2 for lane_opponent, else 1.' },
                limit: { type: 'integer', description: 'Default 10, max 25.' },
            },
            required: ['by'],
        },
        run: breakdown,
    },
    {
        name: 'get_recent_games',
        description: 'List individual recent games, newest first: match id, date, champion, role, queue, win/loss, K/D/A, CS, damage, length, lane opponent, MVP/SVP and LP change when known. For one game in depth, use get_game_detail.',
        parameters: {
            type: 'object',
            properties: {
                ...FILTER_PROPS,
                count: { type: 'integer', description: 'How many games. Default 10, max 30.' },
            },
        },
        run(args, ctx) {
            const f = filtered(ctx, args);
            if (f.error) return { error: f.error };
            const count = Math.min(30, Math.max(1, Number.parseInt(args.count, 10) || 10));
            const lp = ctx.lpDeltas || {};
            return {
                filters: f.description,
                games: f.matches.slice(0, count).map(m => {
                    const mins = (m.gameDuration || 0) / 60;
                    const row = {
                        match_id: m.matchId,
                        date: localDateTime(m.gameCreation),
                        champion: m.championName,
                        role: ROLE_LABEL[m.teamPosition] || null,
                        queue: QUEUE_LABEL[m.queueId] || `Queue ${m.queueId}`,
                        result: isWin(m) ? 'Win' : 'Loss',
                        kda: `${m.kills}/${m.deaths}/${m.assists}`,
                        cs: m.totalMinionsKilled,
                        cs_per_min: mins ? round(m.totalMinionsKilled / mins, 1) : null,
                        damage: m.totalDamageDealtToChampions,
                        minutes: round(mins, 0),
                    };
                    if (m.laneOpponent) row.vs = m.laneOpponent;
                    if (m.impactTag) row.impact = m.impactTag;
                    if (Number.isFinite(lp[m.matchId])) row.lp_change = lp[m.matchId];
                    return row;
                }),
            };
        },
    },
    {
        name: 'get_game_detail',
        description: 'Everything about ONE game: your stats against your usual, what went well and wrong, blunders, win chance minute by minute with the biggest swings and what happened in them, items with purchase time and WPA, runes, deaths and all 10 players. Takes the newest game matching the filters (nth 2 = the one before), or match_id from get_recent_games.',
        parameters: {
            type: 'object',
            properties: {
                ...FILTER_PROPS,
                nth: { type: 'integer', description: '1 = newest matching game (default).' },
                match_id: { type: 'string' },
            },
        },
        run: gameDetail,
    },
    {
        name: 'get_item_stats',
        description: 'Finished items over many games: games bought, win rate, average WPA, when you usually buy them. With a champion, also the build order (start, first back, 1st/2nd/3rd item) and first-back timing.',
        parameters: {
            type: 'object',
            properties: {
                ...FILTER_PROPS,
                sort_by: { type: 'string', enum: ['games', 'win_rate', 'wpa'], description: 'Default games.' },
                min_games: { type: 'integer', description: 'Default 3.' },
                limit: { type: 'integer', description: 'Default 12, max 30.' },
            },
        },
        run: itemStats,
    },
    {
        name: 'get_win_chance_stats',
        description: 'Win-chance patterns over many games: average win chance at 10/15/20 min, win rate when ahead/even/behind at 15, throws (lost from 70%+) and comebacks (won from 30% or less) with examples.',
        parameters: { type: 'object', properties: { ...FILTER_PROPS } },
        run: winChancePatterns,
    },
    {
        name: 'get_filter_options',
        description: 'Which filter values have games, with counts: queues, roles, patches (newest first), your champions, lane opponents you faced most. Use it to check a patch or champion before filtering.',
        parameters: { type: 'object', properties: { queue: FILTER_PROPS.queue } },
        run(args, ctx) {
            const f = filtered(ctx, { queue: args.queue });
            if (f.error) return { error: f.error };
            return { filters: f.description, dates: dateRange(f.matches), ...filterOptions(f.matches) };
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
        get_breakdown: `results by ${String(args.by || 'group').replace('_', ' ')}`,
        get_recent_games: 'recent games',
        get_game_detail: args.match_id ? 'one game' : posInt(args.nth) > 1 ? `game ${posInt(args.nth)} back` : 'latest game',
        get_item_stats: 'items and WPA',
        get_win_chance_stats: 'win chance patterns',
        get_filter_options: 'what the data covers',
        get_rank_and_lp: `${args.queue === 'flex' ? 'Flex' : 'Solo/Duo'} rank and LP`,
        get_coaching_focus: 'coaching analysis',
    }[name] || name;
    const bits = [];
    if (args.queue && args.queue !== 'all' && name !== 'get_rank_and_lp') bits.push(args.queue);
    if (args.champion) bits.push(args.champion);
    if (args.role) bits.push(args.role);
    if (args.lane_opponent) bits.push(`vs ${args.lane_opponent}`);
    if (args.result) bits.push(String(args.result).toLowerCase().startsWith('w') ? 'wins' : 'losses');
    if (args.patch) bits.push(`patch ${args.patch}`);
    if (args.last_n_patches) bits.push(`last ${args.last_n_patches} patches`);
    if (args.last_n_days) bits.push(`last ${args.last_n_days} days`);
    if (args.since || args.until) bits.push(`${args.since || '…'} → ${args.until || 'now'}`);
    if (args.min_minutes || args.max_minutes) bits.push(`${args.min_minutes || 0}–${args.max_minutes || '…'} min`);
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
    _internal: { applyFilters, basics, championMatcher, resolveStat, parseDay, filterOptions },
};
