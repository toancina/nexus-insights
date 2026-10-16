const {
    loadRawJson, loadTimelineJson,
    getCachedRawJson, getCachedTimelineJson
} = require('../services/matchService');
const { RANK_COLORS } = require('./rankTiers');
const { benchmarkFor } = require('./roleBenchmarks');
const RoleRanks = require('./roleRanks');
const { decodePurchases, firstBackStats, firstBackAt } = require('../services/itemBuild');
const { impactFor } = require('../services/teamImpact');
const { platesTakenBy } = require('../services/timelineRules');

// Benchmark thresholds per stat — values represent the MINIMUM needed to qualify for that tier
// For "lower is better" stats (higherIsBetter=false), value must be AT OR BELOW the threshold
const STAT_BENCHMARKS = {
  // Overview
  win_rate:        { iron:45, bronze:47, silver:49, gold:51, platinum:52, emerald:53, diamond:54, master:55, grandmaster:56, challenger:57 },
  avg_kda:         { iron:1.6, bronze:1.8, silver:2.0, gold:2.2, platinum:2.4, emerald:2.6, diamond:2.9, master:3.1, grandmaster:3.3, challenger:3.5 },
  avg_kp:          { iron:35, bronze:39, silver:43, gold:47, platinum:50, emerald:53, diamond:56, master:59, grandmaster:61, challenger:63 },
  avg_csm:         { iron:4.5, bronze:5.0, silver:5.5, gold:6.0, platinum:6.5, emerald:7.0, diamond:7.5, master:8.0, grandmaster:8.3, challenger:8.6 },
  avg_cs:          { iron:120, bronze:135, silver:150, gold:165, platinum:180, emerald:195, diamond:210, master:225, grandmaster:235, challenger:245 },
  avg_dmg:         { iron:12000, bronze:14000, silver:16000, gold:18000, platinum:20000, emerald:22000, diamond:24500, master:27000, grandmaster:29000, challenger:31000 },
  dmg_min:         { iron:400, bronze:460, silver:520, gold:580, platinum:640, emerald:700, diamond:770, master:840, grandmaster:900, challenger:960 },
  // Lane Phase
  csd_15:          { iron:-18, bronze:-12, silver:-7, gold:-3, platinum:0, emerald:4, diamond:8, master:12, grandmaster:16, challenger:20 },
  gd_15:           { iron:-900, bronze:-600, silver:-350, gold:-150, platinum:0, emerald:200, diamond:450, master:700, grandmaster:950, challenger:1200 },
  xpd_15:          { iron:-800, bronze:-550, silver:-300, gold:-100, platinum:0, emerald:150, diamond:350, master:550, grandmaster:750, challenger:950 },
  cs_10:           { iron:45, bronze:50, silver:55, gold:60, platinum:65, emerald:70, diamond:75, master:80, grandmaster:83, challenger:86 },
  cs_15:           { iron:70, bronze:78, silver:86, gold:94, platinum:102, emerald:110, diamond:118, master:126, grandmaster:132, challenger:138 },
  cs_20:           { iron:95, bronze:108, silver:121, gold:134, platinum:147, emerald:160, diamond:173, master:186, grandmaster:195, challenger:204 },
  deaths_10:       { iron:1.00, bronze:0.80, silver:0.65, gold:0.50, platinum:0.40, emerald:0.32, diamond:0.25, master:0.20, grandmaster:0.16, challenger:0.12 },
  plates_taken:    { iron:0.4, bronze:0.6, silver:0.8, gold:1.0, platinum:1.2, emerald:1.5, diamond:1.8, master:2.1, grandmaster:2.4, challenger:2.7 },
  plates_lost:     { iron:2.5, bronze:2.1, silver:1.8, gold:1.5, platinum:1.2, emerald:1.0, diamond:0.8, master:0.6, grandmaster:0.5, challenger:0.4 },
  solo_kill_diff:  { iron:-0.50, bronze:-0.35, silver:-0.20, gold:-0.10, platinum:0.00, emerald:0.10, diamond:0.25, master:0.40, grandmaster:0.55, challenger:0.70 },
  // Combat
  dmg_share:       { iron:16, bronze:18, silver:20, gold:22, platinum:24, emerald:25, diamond:27, master:29, grandmaster:31, challenger:33 },
  dmg_min_combat:  { iron:400, bronze:460, silver:520, gold:580, platinum:640, emerald:700, diamond:770, master:840, grandmaster:900, challenger:960 },
  dmg_gold:        { iron:1.00, bronze:1.10, silver:1.20, gold:1.30, platinum:1.40, emerald:1.50, diamond:1.60, master:1.70, grandmaster:1.80, challenger:1.90 },
  kp_combat:       { iron:35, bronze:39, silver:43, gold:47, platinum:50, emerald:53, diamond:56, master:59, grandmaster:61, challenger:63 },
  shutdowns_got:   { iron:0.05, bronze:0.08, silver:0.11, gold:0.14, platinum:0.17, emerald:0.20, diamond:0.24, master:0.28, grandmaster:0.32, challenger:0.36 },
  shutdowns_lost:  { iron:0.45, bronze:0.38, silver:0.32, gold:0.27, platinum:0.23, emerald:0.19, diamond:0.15, master:0.12, grandmaster:0.10, challenger:0.08 },
  multikills:      { iron:0.10, bronze:0.15, silver:0.20, gold:0.27, platinum:0.34, emerald:0.42, diamond:0.50, master:0.60, grandmaster:0.70, challenger:0.80 },
  // Death Review
  dr_avg_deaths:   { iron:8.0, bronze:7.3, silver:6.7, gold:6.2, platinum:5.8, emerald:5.4, diamond:5.0, master:4.7, grandmaster:4.5, challenger:4.3 },
  dr_early_deaths: { iron:1.00, bronze:0.80, silver:0.65, gold:0.50, platinum:0.40, emerald:0.32, diamond:0.25, master:0.20, grandmaster:0.16, challenger:0.12 },
  dr_isolated:     { iron:2.0, bronze:1.7, silver:1.4, gold:1.2, platinum:1.0, emerald:0.8, diamond:0.65, master:0.50, grandmaster:0.40, challenger:0.30 },
  dr_shutdown:     { iron:220, bronze:180, silver:145, gold:115, platinum:90, emerald:70, diamond:55, master:42, grandmaster:32, challenger:24 },
  dr_death_share:  { iron:30, bronze:27, silver:24, gold:22, platinum:20, emerald:18, diamond:16, master:14, grandmaster:13, challenger:12 },
  // Objectives
  obj_dragon:      { iron:35, bronze:39, silver:43, gold:47, platinum:50, emerald:53, diamond:56, master:59, grandmaster:62, challenger:65 },
  obj_baron:       { iron:30, bronze:34, silver:38, gold:42, platinum:46, emerald:50, diamond:54, master:58, grandmaster:62, challenger:66 },
  obj_tower:       { iron:35, bronze:39, silver:43, gold:47, platinum:50, emerald:54, diamond:58, master:62, grandmaster:66, challenger:70 },
  obj_herald:      { iron:0.35, bronze:0.45, silver:0.55, gold:0.65, platinum:0.75, emerald:0.85, diamond:0.95, master:1.05, grandmaster:1.15, challenger:1.25 },
  obj_inhib:       { iron:0.25, bronze:0.35, silver:0.45, gold:0.55, platinum:0.65, emerald:0.78, diamond:0.90, master:1.05, grandmaster:1.20, challenger:1.35 },
  obj_steal:       { iron:0.01, bronze:0.02, silver:0.03, gold:0.04, platinum:0.05, emerald:0.06, diamond:0.08, master:0.10, grandmaster:0.12, challenger:0.14 },
  // Vision
  vis_score:       { iron:18, bronze:22, silver:26, gold:30, platinum:34, emerald:38, diamond:42, master:47, grandmaster:52, challenger:57 },
  vis_vs_min:      { iron:0.65, bronze:0.78, silver:0.90, gold:1.02, platinum:1.15, emerald:1.28, diamond:1.42, master:1.58, grandmaster:1.75, challenger:1.95 },
  vis_placed:      { iron:7, bronze:9, silver:11, gold:13, platinum:15, emerald:17, diamond:20, master:23, grandmaster:26, challenger:30 },
  vis_killed:      { iron:2, bronze:3, silver:4, gold:5, platinum:6, emerald:7, diamond:8, master:9, grandmaster:10, challenger:12 },
  vis_control:     { iron:0.8, bronze:1.1, silver:1.4, gold:1.7, platinum:2.0, emerald:2.3, diamond:2.6, master:3.0, grandmaster:3.4, challenger:3.8 },
  vis_adv:         { iron:-0.30, bronze:-0.20, silver:-0.10, gold:0.00, platinum:0.08, emerald:0.16, diamond:0.24, master:0.32, grandmaster:0.40, challenger:0.50 },
  // Economy
  eco_gold:        { iron:10500, bronze:11200, silver:11900, gold:12600, platinum:13300, emerald:14000, diamond:14800, master:15600, grandmaster:16400, challenger:17200 },
  eco_gold_min:    { iron:330, bronze:350, silver:370, gold:390, platinum:410, emerald:430, diamond:455, master:480, grandmaster:505, challenger:530 },
  eco_cs:          { iron:120, bronze:135, silver:150, gold:165, platinum:180, emerald:195, diamond:210, master:225, grandmaster:235, challenger:245 },
  eco_cs_min:      { iron:4.5, bronze:5.0, silver:5.5, gold:6.0, platinum:6.5, emerald:7.0, diamond:7.5, master:8.0, grandmaster:8.3, challenger:8.6 },
  // Macro
  mac_fb:          { iron:5, bronze:7, silver:9, gold:11, platinum:13, emerald:15, diamond:17, master:19, grandmaster:21, challenger:23 },
  mac_dragon_ctl:  { iron:35, bronze:39, silver:43, gold:47, platinum:50, emerald:53, diamond:56, master:59, grandmaster:62, challenger:65 },
  mac_baron_ctl:   { iron:30, bronze:34, silver:38, gold:42, platinum:46, emerald:50, diamond:54, master:58, grandmaster:62, challenger:66 },
  mac_short_wr:    { iron:45, bronze:47, silver:49, gold:51, platinum:53, emerald:55, diamond:57, master:59, grandmaster:61, challenger:63 },
  mac_long_wr:     { iron:45, bronze:47, silver:49, gold:51, platinum:53, emerald:55, diamond:57, master:59, grandmaster:61, challenger:63 },
  // Consistency
  con_consistency: { iron:35, bronze:42, silver:49, gold:56, platinum:63, emerald:70, diamond:76, master:82, grandmaster:87, challenger:92 },
  con_overall_wr:  { iron:45, bronze:47, silver:49, gold:51, platinum:52, emerald:53, diamond:54, master:55, grandmaster:56, challenger:57 },
};

// Evaluate a stat value and return a rank tier name
// Role whose thresholds apply, set only for the length of one computeTabStats
// call that asked for it (the Analytics role filter, #10). Coaching and chat
// call without a role, so they always get the general ladder.
let benchmarkRole = null;

/** A stat's thresholds: the role's override when there is one, else general. */
function thresholdsFor(statId, role = benchmarkRole) {
    return role ? benchmarkFor(statId, role, id => STAT_BENCHMARKS[id] || null) : (STAT_BENCHMARKS[statId] || null);
}

function evaluateBenchmark(value, statId, higherIsBetter) {
    const thresholds = thresholdsFor(statId);
    if (!thresholds || value === null || value === undefined || isNaN(value)) return null;

    const tiers = ['challenger','grandmaster','master','diamond','emerald','platinum','gold','silver','bronze','iron'];

    if (higherIsBetter) {
        for (const tier of tiers) {
            if (value >= thresholds[tier]) return tier;
        }
        return 'iron';
    } else {
        // lower is better — threshold is the MAX allowed for that tier
        for (const tier of tiers) {
            if (value <= thresholds[tier]) return tier;
        }
        return 'iron';
    }
}

// ---------------------------------------------------------
// LAZY MATCH JSON
// ---------------------------------------------------------
// Which tabs actually need the heavy blobs. Anything not listed here runs
// purely off scalar columns and never touches rawJson/timelineJson.
const TAB_JSON_NEEDS = {
    'Overview':     { raw: false, timeline: false },
    'Lane Phase':   { raw: true,  timeline: true  },
    'Combat':       { raw: true,  timeline: true  },
    'Death Review': { raw: true,  timeline: true  },
    'Objectives':   { raw: false, timeline: false },
    'Vision':       { raw: true,  timeline: false },
    'Economy':      { raw: true,  timeline: false },
    'Macro':        { raw: false, timeline: false },
    'Consistency':  { raw: false, timeline: false },
};

window.TAB_JSON_NEEDS = TAB_JSON_NEEDS;

/**
 * Warm the blob cache for a tab before computeTabStats() runs.
 * Must be awaited — computeTabStats itself stays synchronous.
 */
window.prefetchTabJson = async function (tabName, ...matchLists) {
    const needs = TAB_JSON_NEEDS[tabName];
    if (!needs || (!needs.raw && !needs.timeline)) return;

    // Only rows that predate the computed-stat backfill still need their JSON.
    // Once everything is backfilled this list is empty and no blob is touched
    // at all — which is the whole point of the precomputed columns.
    const ids = [];
    for (const list of matchLists) {
        if (!Array.isArray(list)) continue;
        for (const m of list) {
            if (m && m.matchId && !isPrecomputed(m)) ids.push(m.matchId);
        }
    }
    if (ids.length === 0) return;

    const jobs = [];
    if (needs.raw)      jobs.push(loadRawJson(ids));
    if (needs.timeline) jobs.push(loadTimelineJson(ids));
    await Promise.all(jobs);
};

/**
 * Has this row been through the computed-stat backfill?
 *
 * Tested via the dedicated statsComputedAt stamp rather than any individual
 * stat, because a stat being NULL is not the same as the row being unindexed:
 * a 108-second remake where nobody dealt damage has a legitimately NULL
 * dmgShare, and testing that would have sent it back to the blobs forever.
 *
 * Rows synced before these columns existed return false and fall back to
 * parsing the JSON blobs, so the app stays correct mid-migration.
 */
function isPrecomputed(match) {
    return match.statsComputedAt !== null && match.statsComputedAt !== undefined;
}

// Synchronous accessor. Returns nulls when a blob was never prefetched, and
// every calculator below already degrades gracefully on null.
function getParsedData(match) {
    return {
        raw:      getCachedRawJson(match.matchId),
        timeline: getCachedTimelineJson(match.matchId),
    };
}

// Utility functions
//
// sum/avg ignore non-finite entries. Riot payloads are not uniform — older
// matches and some queue types omit fields like totalDamageTaken — and a single
// undefined would otherwise turn the whole stat into NaN, blanking a card that
// had 200 perfectly good matches behind it.
const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);
const sum = (arr) => arr.reduce((a, b) => a + num(b), 0);
const avg = (arr) => {
    const finite = arr.filter(Number.isFinite);
    return finite.length > 0 ? finite.reduce((a, b) => a + b, 0) / finite.length : 0;
};
/** Safe division — returns `fallback` instead of NaN/Infinity. */
const ratio = (numerator, denominator, fallback = 0) => {
    const n = num(numerator), d = num(denominator);
    return d !== 0 && Number.isFinite(n / d) ? n / d : fallback;
};
const formatPct = (num) => `${Math.round(num * 100)}%`;
const formatNum = (num, decimals = 1) => Number(num).toFixed(decimals);
const fmtInt = (v) => Math.round(v).toLocaleString('en-US');
const fmtDiff = (v) => (v > 0 ? '+' : '') + Math.round(v).toLocaleString('en-US');
// Minutes → "7:42"
const fmtClock = (v) => { const s = Math.round(v * 60); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function getParticipant(raw, championName, teamId) {
    const participants = raw.info ? raw.info.participants : raw.participants;
    if (!participants) return null;
    return participants.find(p => p.championName === championName && p.teamId === teamId);
}

function getEnemyLane(raw, myParticipant) {
    if (!myParticipant) return null;
    const participants = raw.info ? raw.info.participants : raw.participants;
    return participants.find(p => p.teamPosition === myParticipant.teamPosition && p.teamId !== myParticipant.teamId);
}

function getTeam(raw, teamId) {
    const participants = raw.info ? raw.info.participants : raw.participants;
    return participants.filter(p => p.teamId === teamId);
}

// ---------------------------------------------------------
// STAT CALCULATORS (to run on any dataset)
// ---------------------------------------------------------

function calcOverview(matches) {
    if (!matches || !matches.length) return null;
    const mCount = matches.length;
    const wins = matches.filter(m => m.win === 1).length;
    const winRate = (wins / mCount) * 100;
    
    const totalKills = sum(matches.map(m => m.kills));
    const totalDeaths = sum(matches.map(m => m.deaths));
    const totalAssists = sum(matches.map(m => m.assists));
    const avgKda = (totalKills + totalAssists) / Math.max(1, totalDeaths);
    
    const kpArr = matches.map(m => m.teamKills > 0 ? (m.kills + m.assists) / m.teamKills : 0);
    const avgKp = avg(kpArr) * 100;

    const csmArr = matches.map(m => m.totalMinionsKilled / (m.gameDuration / 60));
    const avgCsm = avg(csmArr);
    
    const avgCs = avg(matches.map(m => m.totalMinionsKilled));
    const avgDmg = avg(matches.map(m => m.totalDamageDealtToChampions));
    
    const dmgMinArr = matches.map(m => m.totalDamageDealtToChampions / (m.gameDuration / 60));
    const avgDmgMin = avg(dmgMinArr);

    return { totalMatches: mCount, winRate, avgKda, avgKp, avgCsm, avgCs, avgDmg, avgDmgMin };
}

function calcLanePhase(matches) {
    if (!matches || !matches.length) return null;
    const mCount = matches.length;
    let csd15 = [], gd15 = [], xpd15 = [], cs10 = [], cs15 = [], cs20 = [];
    let deathsBefore10 = 0, platesTaken = 0, platesLost = 0, soloKillDiff = 0;

    matches.forEach(m => {
        if (m.csDiff15 !== null) csd15.push(m.csDiff15);
        if (m.goldDiff15 !== null) gd15.push(m.goldDiff15);
        if (m.xpDiff15 !== null) xpd15.push(m.xpDiff15);

        // Precomputed columns (see matchService.computeAdvancedStatsForMatch).
        // A row that predates the backfill falls through to the blobs below.
        if (isPrecomputed(m)) {
            if (m.cs10 !== null) cs10.push(m.cs10);
            if (m.cs15 !== null) cs15.push(m.cs15);
            if (m.cs20 !== null) cs20.push(m.cs20);
            deathsBefore10 += num(m.deathsBefore10);
            platesTaken    += num(m.platesTaken);
            platesLost     += num(m.platesLost);
            soloKillDiff   += num(m.soloKillDiff);
            return;
        }

        const { raw, timeline } = getParsedData(m);
        if (!raw) return; // need rawJson for participant data

        const me = getParticipant(raw, m.championName, m.teamId);
        const enemy = getEnemyLane(raw, me);
        if (!me) return;

        // Challenges-based stats only need rawJson
        if (me.challenges) {
            const mySoloKills   = me.challenges.soloKills || 0;
            const enemySoloKills = enemy && enemy.challenges ? enemy.challenges.soloKills || 0 : 0;
            soloKillDiff += (mySoloKills - enemySoloKills);
        }
        // Timeline-dependent stats (skipped gracefully if timeline absent)
        if (!timeline) return;

        const frames = timeline.info ? timeline.info.frames : timeline.frames;
        const pId = me.participantId;

        // Plates before 14:00, same rule as the stored column
        const events = frames.flatMap(f => f.events || []);
        platesTaken += platesTakenBy(events, pId);
        if (enemy) platesLost += platesTakenBy(events, enemy.participantId);

        const getCsAt = (minute) => {
            const frame = frames.find(f => f.timestamp >= minute * 60 * 1000) || frames[frames.length - 1];
            const pf = frame.participantFrames[pId];
            return pf ? pf.minionsKilled + pf.jungleMinionsKilled : 0;
        };

        if (m.gameDuration >= 10 * 60) cs10.push(getCsAt(10));
        if (m.gameDuration >= 15 * 60) cs15.push(getCsAt(15));
        if (m.gameDuration >= 20 * 60) cs20.push(getCsAt(20));

        const earlyDeaths = frames.filter(f => f.timestamp < 10 * 60 * 1000).reduce((acc, f) => {
            const kills = (f.events || []).filter(e => e.type === 'CHAMPION_KILL' && e.victimId === pId);
            return acc + kills.length;
        }, 0);
        deathsBefore10 += earlyDeaths;
    });

    return {
        csd15: avg(csd15), gd15: avg(gd15), xpd15: avg(xpd15),
        cs10: avg(cs10), cs15: avg(cs15), cs20: avg(cs20),
        deathsBefore10: deathsBefore10 / mCount,
        platesTaken: platesTaken / mCount,
        platesLost: platesLost / mCount,
        soloKillDiff: soloKillDiff / mCount
    };
}

/**
 * Your team impact for one match: stored columns, or parsed from a prefetched
 * rawJson for rows indexed before impact existed. Null when neither is there.
 */
function matchImpact(m) {
    if (m.impactRank !== null && m.impactRank !== undefined) return { rank: m.impactRank, tag: m.impactTag };
    const { raw } = getParsedData(m);
    if (!raw) return null;
    return impactFor(raw.info ? raw.info.participants : raw.participants, m.championName, m.teamId);
}

function calcCombat(matches) {
    if (!matches || !matches.length) return null;
    const mCount = matches.length;
    let dmgShare = [], dmgMin = [], dmgGold = [], kpArr = [];
    let shutdownsClaimed = 0, shutdownsGiven = 0, dmgTakenDeath = [], multikills = 0;
    let impactRanks = [], impactTop = 0;

    matches.forEach(m => {
        const gameMin = m.gameDuration / 60;
        dmgMin.push(m.totalDamageDealtToChampions / gameMin);

        const impact = matchImpact(m);
        if (impact) {
            impactRanks.push(impact.rank);
            if (impact.tag) impactTop++;              // MVP or SVP: best on your team
        }
        
        if (isPrecomputed(m)) {
            if (m.dmgShare !== null)          dmgShare.push(m.dmgShare);
            if (m.dmgGoldRatio !== null)      dmgGold.push(m.dmgGoldRatio);
            if (m.killParticipation !== null) kpArr.push(m.killParticipation);
            if (m.dmgTakenPerDeath !== null)  dmgTakenDeath.push(m.dmgTakenPerDeath);
            multikills       += num(m.multikills);
            shutdownsClaimed += num(m.shutdownsClaimed);
            shutdownsGiven   += num(m.shutdownsGiven);
            return;
        }

        const { raw, timeline } = getParsedData(m);
        if (!raw) return;
        
        const me = getParticipant(raw, m.championName, m.teamId);
        const team = getTeam(raw, m.teamId);
        if (!me) return;

        const teamDmg = sum(team.map(t => t.totalDamageDealtToChampions));
        dmgShare.push(teamDmg > 0 ? me.totalDamageDealtToChampions / teamDmg : 0);
        
        if (me.challenges) {
            dmgGold.push(num(me.challenges.damagePerGold) || ratio(me.totalDamageDealtToChampions, me.goldEarned));
            kpArr.push(num(me.challenges.killParticipation));
            // Note: shutdownsClaimed is counted from timeline events below (no reliable challenges field)
        } else {
            dmgGold.push(ratio(me.totalDamageDealtToChampions, me.goldEarned));
            const teamKills = sum(team.map(t => t.kills));
            kpArr.push(ratio(num(me.kills) + num(me.assists), teamKills));
        }

        // totalDamageTaken is absent on some older/alternate-queue payloads
        if (Number.isFinite(me.totalDamageTaken)) {
            dmgTakenDeath.push(me.totalDamageTaken / Math.max(1, num(me.deaths)));
        }
        multikills += num(me.doubleKills) + num(me.tripleKills) + num(me.quadraKills) + num(me.pentaKills);

        if (timeline) {
            const frames = timeline.info ? timeline.info.frames : timeline.frames;
            frames.forEach(f => {
                (f.events || []).forEach(e => {
                    if (e.type === 'CHAMPION_KILL') {
                        // Shutdown given: I died with a high bounty
                        if (e.victimId === me.participantId && e.bounty > 300) shutdownsGiven++;
                        // Shutdown claimed: I killed someone with a high bounty
                        if (e.killerId === me.participantId && e.bounty > 300) shutdownsClaimed++;
                    }
                });
            });
        }
    });

    return {
        dmgShare: avg(dmgShare) * 100,
        dmgMin: avg(dmgMin),
        dmgGold: avg(dmgGold),
        kp: avg(kpArr) * 100,
        shutdownsClaimed: shutdownsClaimed / mCount,
        shutdownsGiven: shutdownsGiven / mCount,
        dmgTakenDeath: avg(dmgTakenDeath),
        multikills: multikills / mCount,
        // 0 when no match has impact yet; the cards show "--" for that
        impactGames: impactRanks.length,
        impactRank: avg(impactRanks),
        mvpRate: impactRanks.length ? impactTop / impactRanks.length * 100 : 0
    };
}

// ---------------------------------------------------------
// CARD FACTORY
// ---------------------------------------------------------

function buildCard(id, label, tab, value, formatFn, aggregationType, benchmarkable, higherIsBetter, prevValue) {
    let displayValue = value !== null && !isNaN(value) ? formatFn(value) : '--';
    let benchmarkRank = null;
    let color = 'neutral';

    if (benchmarkable) {
        const rank = evaluateBenchmark(value, id, higherIsBetter);
        benchmarkRank = rank || 'unrated';
        color = RANK_COLORS[benchmarkRank] || RANK_COLORS.unrated;
    }

    let isImproving = null;
    let trendStr = null;

    if (prevValue !== null && !isNaN(prevValue) && value !== null && !isNaN(value)) {
        const trendVal = value - prevValue;
        if (Math.abs(trendVal) > 0.01) { // ignore floating point noise
            trendStr = trendVal > 0 ? '+' + formatNum(trendVal, 1) : formatNum(trendVal, 1);
            // null = neither direction is better: show the change, no green/red (#56)
            isImproving = higherIsBetter === null ? null : higherIsBetter ? (trendVal > 0) : (trendVal < 0);
        } else {
            trendStr = "0.0";
            isImproving = null;
        }
    }

    return {
        id, label, tab, value, displayValue, aggregationType, 
        benchmarkable, benchmarkRank, color, 
        trend: trendStr, trendLabel: "vs prev period", isImproving, higherIsBetter
    };
}

// ---------------------------------------------------------
// DEATH REVIEW
// ---------------------------------------------------------

function calcDeathReview(matches) {
    if (!matches || !matches.length) return null;
    const mCount = matches.length;
    let deathsBefore10 = 0, shutdownBountyGiven = 0;
    let isolatedDeaths = 0;

    matches.forEach(m => {
        // Isolated deaths — pre-computed column
        if (m.isolatedDeaths !== null && m.isolatedDeaths !== undefined) {
            isolatedDeaths += m.isolatedDeaths;
        }

        if (isPrecomputed(m)) {
            deathsBefore10      += num(m.deathsBefore10);
            shutdownBountyGiven += num(m.shutdownBountyGiven);
            return;
        }

        const { raw, timeline } = getParsedData(m);

        // Timeline-dependent: early deaths and shutdown bounty given
        if (raw && timeline) {
            const me = getParticipant(raw, m.championName, m.teamId);
            if (me) {
                const frames = timeline.info ? timeline.info.frames : timeline.frames;
                const pId = me.participantId;

                frames.forEach(f => {
                    (f.events || []).forEach(e => {
                        if (e.type === 'CHAMPION_KILL' && e.victimId === pId) {
                            if (e.timestamp < 10 * 60 * 1000) deathsBefore10++;
                            if (e.bounty && e.bounty > 300) shutdownBountyGiven += e.bounty;
                        }
                    });
                });
            }
        }
    });

    const totalDeaths = sum(matches.map(m => m.deaths));
    const avgDeaths = totalDeaths / mCount;
    const avgEarlyDeaths = deathsBefore10 / mCount;
    const avgIsolated = isolatedDeaths / mCount;
    const avgShutdownBounty = shutdownBountyGiven / mCount;
    const deathShare = totalDeaths > 0 ? matches.reduce((acc, m) => {
        if (isPrecomputed(m)) return acc + ratio(m.deaths, m.enemyTeamKills);
        const { raw } = getParsedData(m);
        if (!raw) return acc;
        const all = raw.info ? raw.info.participants : raw.participants;
        const teamDeaths = all ? all.filter(p => p.teamId !== m.teamId).reduce((s, p) => s + p.kills, 0) : 0;
        return acc + (teamDeaths > 0 ? m.deaths / teamDeaths : 0);
    }, 0) / mCount * 100 : 0;

    // Minutes. Games without a death have no first death and are left out.
    const firstDeaths = matches.filter(m => m.firstDeathAt != null).map(m => m.firstDeathAt / 60000);
    const avgFirstDeath = avg(firstDeaths);

    return { avgDeaths, avgEarlyDeaths, avgIsolated, avgShutdownBounty, deathShare,
             avgFirstDeath, firstDeathGames: firstDeaths.length };
}

// ---------------------------------------------------------
// OBJECTIVES
// ---------------------------------------------------------

function calcObjectives(matches) {
    if (!matches || !matches.length) return null;
    const mCount = matches.length;
    let dragonCtl = [], baronCtl = [], towerCtl = [];
    let heraldsAvg = 0, inhibsAvg = 0, stealsAvg = 0, objRate = [];
    const objDmgMin = [], turretDmgMin = [];

    matches.forEach(m => {
        const td = m.teamDragons || 0, ed = m.enemyDragons || 0;
        if (td + ed > 0) dragonCtl.push(td / (td + ed) * 100);

        const tb = m.teamBarons || 0, eb = m.enemyBarons || 0;
        if (tb + eb > 0) baronCtl.push(tb / (tb + eb) * 100);

        const tt = m.teamTowers || 0, et = m.enemyTowers || 0;
        if (tt + et > 0) towerCtl.push(tt / (tt + et) * 100);

        heraldsAvg += (m.teamRiftHeralds || 0);
        inhibsAvg  += (m.teamInhibitors || 0);
        stealsAvg  += (m.objectivesStolen || 0);
        if (m.objectiveRate !== null && m.objectiveRate !== undefined) objRate.push(m.objectiveRate);

        // Rows not indexed yet (turretDamage NULL) are left out until the
        // background backfill reaches them.
        const minutes = (m.gameDuration || 0) / 60;
        if (m.turretDamage != null && minutes > 0) {
            turretDmgMin.push(m.turretDamage / minutes);
            objDmgMin.push(num(m.objectiveDamage) / minutes);
        }
    });

    return {
        dragonCtl: avg(dragonCtl),
        baronCtl:  avg(baronCtl),
        towerCtl:  avg(towerCtl),
        heralds:   heraldsAvg / mCount,
        inhibs:    inhibsAvg  / mCount,
        steals:    stealsAvg  / mCount,
        objRate:   avg(objRate),  // DB stores objectiveRate as a percentage (0-100) — no * 100
        objDmgMin:    avg(objDmgMin),
        turretDmgMin: avg(turretDmgMin),
        dmgGames:     turretDmgMin.length,  // 0 = no indexed game: cards show "--"
    };
}

// ---------------------------------------------------------
// VISION
// ---------------------------------------------------------

function calcVision(matches) {
    if (!matches || !matches.length) return null;
    const mCount = matches.length;
    const vsArr   = matches.map(m => m.visionScore || 0);
    const wpArr   = matches.map(m => m.wardsPlaced || 0);
    const wkArr   = matches.map(m => m.wardsKilled || 0);
    const cwArr   = matches.map(m => m.detectorWardsPlaced || 0);
    const vsMinArr = matches.map(m => (m.visionScore || 0) / (m.gameDuration / 60));
    const vsBuyArr = matches.map(m => {
        if (isPrecomputed(m)) return num(m.visionAdvantage);
        const { raw } = getParsedData(m);
        if (!raw) return 0;
        const me = getParticipant(raw, m.championName, m.teamId);
        return me && me.challenges ? (me.challenges.visionScoreAdvantageLaneOpponent || 0) : 0;
    });

    return {
        avgVs:    avg(vsArr),
        avgWp:    avg(wpArr),
        avgWk:    avg(wkArr),
        avgCw:    avg(cwArr),
        avgVsMin: avg(vsMinArr),
        avgVsAdv: avg(vsBuyArr)
    };
}

// ---------------------------------------------------------
// ECONOMY
// ---------------------------------------------------------

function calcEconomy(matches) {
    if (!matches || !matches.length) return null;
    const goldArr  = matches.map(m => m.goldEarned || 0);
    const goldMinArr = matches.map(m => (m.goldEarned || 0) / (m.gameDuration / 60));
    const csArr    = matches.map(m => m.totalMinionsKilled || 0);
    const csMinArr = matches.map(m => (m.totalMinionsKilled || 0) / (m.gameDuration / 60));
    const goldShareArr = [];

    matches.forEach(m => {
        if (isPrecomputed(m)) {
            // stored as a fraction; this array is in percent
            if (m.goldShare !== null) goldShareArr.push(m.goldShare * 100);
            return;
        }
        const { raw } = getParsedData(m);
        if (!raw) return;
        const me   = getParticipant(raw, m.championName, m.teamId);
        const team = getTeam(raw, m.teamId);
        if (!me) return;
        const teamGold = sum(team.map(t => t.goldEarned || 0));
        if (teamGold > 0) goldShareArr.push(me.goldEarned / teamGold * 100);
    });

    // First back (#7): from the stored purchases, games with a timeline only
    const backs = firstBackStats(matches.map(m => ({ firstBackAt: firstBackAt(decodePurchases(m.itemPurchases)), win: m.win === 1 })));

    return {
        avgGold:    avg(goldArr),
        avgGoldMin: avg(goldMinArr),
        avgCs:      avg(csArr),
        avgCsMin:   avg(csMinArr),
        goldShare:  avg(goldShareArr),
        firstBackGames: backs.games,
        firstBackMin:   backs.medianMs === null ? 0 : backs.medianMs / 60000
    };
}

// ---------------------------------------------------------
// MACRO
// ---------------------------------------------------------

function calcMacro(matches) {
    if (!matches || !matches.length) return null;
    const mCount = matches.length;
    const durArr = matches.map(m => m.gameDuration / 60);
    const avgDur = avg(durArr);

    const short = matches.filter(m => m.gameDuration < 25 * 60);
    const long  = matches.filter(m => m.gameDuration > 35 * 60);
    const shortWr = short.length > 0 ? (short.filter(m => m.win).length / short.length * 100) : null;
    const longWr  = long.length  > 0 ? (long.filter(m => m.win).length  / long.length  * 100) : null;

    const fbRate  = matches.filter(m => m.firstBlood).length / mCount * 100;
    const objRate = avg(matches.filter(m => m.objectiveRate !== null && m.objectiveRate !== undefined).map(m => m.objectiveRate)); // already a percent

    const drCtl = [], brCtl = [];
    matches.forEach(m => {
        const td = m.teamDragons || 0, ed = m.enemyDragons || 0;
        if (td + ed > 0) drCtl.push(td / (td + ed) * 100);
        const tb = m.teamBarons || 0, eb = m.enemyBarons || 0;
        if (tb + eb > 0) brCtl.push(tb / (tb + eb) * 100);
    });

    return {
        avgDur, shortWr, longWr, fbRate, objRate,
        shortCount: short.length, longCount: long.length,
        dragonCtl: avg(drCtl), baronCtl: avg(brCtl)
    };
}

// ---------------------------------------------------------
// CONSISTENCY
// ---------------------------------------------------------

function calcConsistency(matches) {
    if (!matches || !matches.length) return null;
    const mCount = matches.length;

    // KDA per match
    const kdaArr = matches.map(m => (m.kills + m.assists) / Math.max(1, m.deaths));
    const meanKda = avg(kdaArr);
    const kdaStdDev = Math.sqrt(avg(kdaArr.map(v => (v - meanKda) ** 2)));
    const kdaConsistency = meanKda > 0 ? Math.max(0, 1 - (kdaStdDev / meanKda)) * 100 : 0;

    // Streaks — matches are newest-first, scan chronologically (reversed)
    const chron = [...matches].reverse();
    let curWin = 0, curLoss = 0, maxWin = 0, maxLoss = 0, currentStreak = 0;
    chron.forEach(m => {
        if (m.win) { curWin++; curLoss = 0; if (curWin > maxWin) maxWin = curWin; }
        else       { curLoss++; curWin = 0; if (curLoss > maxLoss) maxLoss = curLoss; }
    });
    // Current streak = from newest match
    for (const m of matches) {
        if (currentStreak === 0) { currentStreak = m.win ? 1 : -1; }
        else if (m.win && currentStreak > 0) currentStreak++;
        else if (!m.win && currentStreak < 0) currentStreak--;
        else break;
    }

    // Win rate last 10 vs overall
    const overallWr = matches.filter(m => m.win).length / mCount * 100;
    const last10 = matches.slice(0, 10);
    const last10Wr = last10.length > 0 ? last10.filter(m => m.win).length / last10.length * 100 : null;

    return { kdaConsistency, kdaStdDev, meanKda, maxWin, maxLoss, currentStreak, overallWr, last10Wr };
}

// ---------------------------------------------------------
// MAIN EXPORT
// ---------------------------------------------------------

/**
 * Rank thresholds for one stat (or null if it isn't benchmarked). Used by the
 * stat-history chart (statHistory.js) to draw the Iron → Challenger bands with
 * exactly the boundaries the cards are coloured by.
 */
window.getStatBenchmark = function (statId, role = null) {
    return thresholdsFor(statId, role);
};

/**
 * Cards for one Analytics tab. `role` (a teamPosition) ranks the cards on that
 * role's thresholds from roleBenchmarks.js where it has them: the Analytics
 * page passes it when its role filter picks one role.
 */
window.computeTabStats = function (tabName, matches, prevMatches = [], { role = null, roleWeighted = false } = {}) {
    if (roleWeighted) {
        return role
            ? withoutNotApplicable(computeWithRole(tabName, matches, prevMatches, role), role)
            : roleWeightedCards(tabName, matches, prevMatches);
    }
    return computeWithRole(tabName, matches, prevMatches, role || null);
};

function computeWithRole(tabName, matches, prevMatches, role) {
    benchmarkRole = role || null;
    try {
        return computeCards(tabName, matches, prevMatches);
    } finally {
        benchmarkRole = null;
    }
}

/** A card with no value: "--", no rank, no trend. */
function emptyCard(card) {
    return { ...card, value: null, displayValue: '--', benchmarkRank: card.benchmarkable ? 'unrated' : null,
             color: card.benchmarkable ? RANK_COLORS.unrated : 'neutral', trend: null, isImproving: null };
}

/** One role picked: stats that don't apply to it show "--" (plates for junglers). */
function withoutNotApplicable(cards, role) {
    const r = RoleRanks.roleOf({ teamPosition: role });
    return cards.map(c => (RoleRanks.notApplicable(c.id, r) ? emptyCard(c) : c));
}

/**
 * Role-weighted rank badges (#56). The cards are computed as before over every
 * game; then, for each rank-badged card:
 * - each role's games are computed on their own, and that role's value is
 *   scored on the role's ladder (Iron 0 … Challenger 9, continuous)
 * - the scores are averaged weighted by games, and the tier of that average
 *   becomes the badge and colour
 * - roles the stat doesn't apply to (plates for junglers, CS for supports) are
 *   left out, of the value and trend too; with none left the card shows "--"
 * card.roleBreakdown lists each role's value and tier for the tooltip.
 */
function roleWeightedCards(tabName, matches, prevMatches = []) {
    const cards = computeWithRole(tabName, matches, prevMatches, null);
    if (!cards.length) return cards;

    const groups = RoleRanks.groupByRole(matches);
    const prevByRole = new Map(RoleRanks.groupByRole(prevMatches).map(g => [g.role, g.matches]));
    const perRole = groups.map(g => ({
        role: g.role,
        games: g.matches.length,
        cards: new Map(computeWithRole(tabName, g.matches, prevByRole.get(g.role) || [], g.role).map(c => [c.id, c])),
    }));

    // Cards recomputed without the roles they don't apply to, one set per set of excluded roles
    const subsetCache = new Map();
    const subsetCards = (excluded) => {
        const key = excluded.join(',');
        if (!subsetCache.has(key)) {
            const keep = m => !excluded.includes(RoleRanks.roleOf(m));
            const list = matches.filter(keep);
            subsetCache.set(key, list.length
                ? new Map(computeWithRole(tabName, list, (prevMatches || []).filter(keep), null).map(c => [c.id, c]))
                : new Map());
        }
        return subsetCache.get(key);
    };

    return cards.map(card => {
        if (!card.benchmarkable) return card;
        const excluded = groups.map(g => g.role).filter(r => RoleRanks.notApplicable(card.id, r));
        let out = card;
        if (excluded.length) {
            const sub = subsetCards(excluded).get(card.id);
            out = sub ? { ...sub } : emptyCard(card);
        }
        const entries = [];
        for (const pr of perRole) {
            if (excluded.includes(pr.role)) continue;
            const rc = pr.cards.get(card.id);
            if (!rc || rc.value === null || rc.value === undefined || Number.isNaN(rc.value)) continue;
            const score = RoleRanks.tierScore(rc.value, thresholdsFor(card.id, pr.role), card.higherIsBetter);
            entries.push({ role: pr.role, games: pr.games, value: rc.value, displayValue: rc.displayValue,
                           score, tier: score === null ? null : RoleRanks.scoreToTier(score) });
        }
        const combined = RoleRanks.combineScores(entries);
        if (!combined || out.value === null) return { ...emptyCard(out), roleBreakdown: entries };
        return { ...out, benchmarkRank: combined.tier, color: RANK_COLORS[combined.tier], roleBreakdown: entries };
    });
}

function computeCards(tabName, matches, prevMatches = []) {
    if (!matches || matches.length === 0) return [];
    let cards = [];

    switch (tabName) {
        case 'Overview': {
            const cur = calcOverview(matches);
            const prev = calcOverview(prevMatches);
            
            cards.push(buildCard('total_matches', 'Total Matches', tabName, cur.totalMatches, v => v, 'count', false, true, prev ? prev.totalMatches : null));
            cards.push(buildCard('win_rate', 'Win Rate', tabName, cur.winRate, v => formatPct(v/100), 'percentage', true, true, prev ? prev.winRate : null));
            cards.push(buildCard('avg_kda', 'Avg KDA', tabName, cur.avgKda, v => formatNum(v, 2), 'average', true, true, prev ? prev.avgKda : null));
            cards.push(buildCard('avg_kp', 'Avg KP%', tabName, cur.avgKp, v => formatPct(v/100), 'percentage', true, true, prev ? prev.avgKp : null));
            cards.push(buildCard('avg_csm', 'Avg CS/M', tabName, cur.avgCsm, v => formatNum(v, 1), 'per-minute', true, true, prev ? prev.avgCsm : null));
            cards.push(buildCard('avg_cs', 'Avg CS', tabName, cur.avgCs, v => fmtInt(v), 'average', true, true, prev ? prev.avgCs : null));
            cards.push(buildCard('avg_dmg', 'Avg DMG', tabName, cur.avgDmg, v => fmtInt(v), 'average', true, true, prev ? prev.avgDmg : null));
            cards.push(buildCard('dmg_min', 'Damage/Min', tabName, cur.avgDmgMin, v => fmtInt(v), 'per-minute', true, true, prev ? prev.avgDmgMin : null));
            break;
        }

        case 'Lane Phase': {
            const cur = calcLanePhase(matches);
            const prev = calcLanePhase(prevMatches);

            cards.push(buildCard('csd_15', 'CSD@15', tabName, cur.csd15, v => (v > 0 ? '+' : '') + formatNum(v, 1), 'differential', true, true, prev ? prev.csd15 : null));
            cards.push(buildCard('gd_15', 'GD@15', tabName, cur.gd15, v => fmtDiff(v), 'differential', true, true, prev ? prev.gd15 : null));
            cards.push(buildCard('xpd_15', 'XPD@15', tabName, cur.xpd15, v => fmtDiff(v), 'differential', true, true, prev ? prev.xpd15 : null));
            cards.push(buildCard('cs_10', 'Avg CS@10', tabName, cur.cs10, v => formatNum(v, 1), 'average', true, true, prev ? prev.cs10 : null));
            cards.push(buildCard('cs_15', 'Avg CS@15', tabName, cur.cs15, v => formatNum(v, 1), 'average', true, true, prev ? prev.cs15 : null));
            cards.push(buildCard('cs_20', 'Avg CS@20', tabName, cur.cs20, v => formatNum(v, 1), 'average', true, true, prev ? prev.cs20 : null));
            cards.push(buildCard('deaths_10', 'Deaths < 10m', tabName, cur.deathsBefore10, v => formatNum(v, 1), 'average', true, false, prev ? prev.deathsBefore10 : null));
            cards.push(buildCard('plates_taken',  'Plates Taken',   tabName, cur.platesTaken,  v => formatNum(v, 1), 'average',      true,  true,  prev ? prev.platesTaken  : null));
            cards.push(buildCard('plates_lost',   'Plates Lost',    tabName, cur.platesLost,   v => formatNum(v, 1), 'average',      true,  false, prev ? prev.platesLost   : null));
            cards.push(buildCard('solo_kill_diff','Solo Kill Diff', tabName, cur.soloKillDiff, v => (v > 0 ? '+' : '') + formatNum(v, 1), 'differential', true, true, prev ? prev.soloKillDiff : null));
            break;
        }

        case 'Combat': {
            const cur = calcCombat(matches);
            const prev = calcCombat(prevMatches);

            cards.push(buildCard('dmg_share', 'Damage Share %', tabName, cur.dmgShare, v => formatPct(v/100), 'percentage', true, true, prev ? prev.dmgShare : null));
            cards.push(buildCard('dmg_min_combat', 'Damage/Min', tabName, cur.dmgMin, v => fmtInt(v), 'per-minute', true, true, prev ? prev.dmgMin : null));
            cards.push(buildCard('dmg_gold', 'Damage/Gold', tabName, cur.dmgGold, v => formatNum(v, 2), 'average', true, true, prev ? prev.dmgGold : null));
            cards.push(buildCard('kp_combat', 'Kill Part.', tabName, cur.kp, v => formatPct(v/100), 'percentage', true, true, prev ? prev.kp : null));
            cards.push(buildCard('shutdowns_got',  'Shutdowns Claimed', tabName, cur.shutdownsClaimed, v => formatNum(v, 2), 'average', true,  true,  prev ? prev.shutdownsClaimed : null));
            cards.push(buildCard('shutdowns_lost', 'Shutdowns Given',   tabName, cur.shutdownsGiven,   v => formatNum(v, 2), 'average', true,  false, prev ? prev.shutdownsGiven   : null));
            cards.push(buildCard('dmg_taken_death', 'Dmg Taken/Death', tabName, cur.dmgTakenDeath, v => fmtInt(v), 'average', false, true, prev ? prev.dmgTakenDeath : null));
            cards.push(buildCard('multikills', 'Multikills', tabName, cur.multikills, v => formatNum(v, 2), 'average', true, true, prev ? prev.multikills : null));

            // Team impact (services/teamImpact.js). No rank-tier data exists
            // for these, so they aren't benchmarked. No trend unless both
            // periods actually have impact values.
            const hasImpact = cur.impactGames > 0;
            const prevImpact = hasImpact && prev && prev.impactGames > 0 ? prev : null;
            cards.push(buildCard('impact_rank', 'Avg Impact Rank', tabName, cur.impactRank, v => hasImpact ? '#' + formatNum(v, 1) : '--', 'average', false, false, prevImpact ? prevImpact.impactRank : null));
            cards.push(buildCard('mvp_rate', 'MVP/SVP Rate', tabName, cur.mvpRate, v => hasImpact ? formatPct(v / 100) : '--', 'percentage', false, true, prevImpact ? prevImpact.mvpRate : null));
            break;
        }

        case 'Death Review': {
            const cur = calcDeathReview(matches);
            const prev = calcDeathReview(prevMatches);
            cards.push(buildCard('dr_avg_deaths',   'Deaths/Game',      tabName, cur.avgDeaths,       v => formatNum(v,1), 'average',    true,  false, prev ? prev.avgDeaths : null));
            cards.push(buildCard('dr_early_deaths', 'Deaths < 10m',     tabName, cur.avgEarlyDeaths,  v => formatNum(v,1), 'average',    true,  false, prev ? prev.avgEarlyDeaths : null));
            cards.push(buildCard('dr_isolated',     'Isolated Deaths',   tabName, cur.avgIsolated,     v => formatNum(v,1), 'average',    true,  false, prev ? prev.avgIsolated : null));
            cards.push(buildCard('dr_shutdown', 'Shutdown Gold Given', tabName, cur.avgShutdownBounty, v => fmtInt(v), 'average', true, false, prev ? prev.avgShutdownBounty : null));
            cards.push(buildCard('dr_death_share', 'Death Share %', tabName, cur.deathShare, v => formatPct(v/100), 'percentage', true, false, prev ? prev.deathShare : null));
            // Not benchmarked: depends on role (bot lane dies much earlier) more than rank
            const hasFirstDeath = cur.firstDeathGames > 0;
            const prevFirstDeath = hasFirstDeath && prev && prev.firstDeathGames > 0 ? prev.avgFirstDeath : null;
            cards.push(buildCard('dr_first_death', 'Avg First Death', tabName, cur.avgFirstDeath, v => hasFirstDeath ? fmtClock(v) : '--', 'average', false, true, prevFirstDeath));
            break;
        }

        case 'Objectives': {
            const cur = calcObjectives(matches);
            const prev = calcObjectives(prevMatches);
            cards.push(buildCard('obj_dragon',  'Dragon Control %', tabName, cur.dragonCtl, v => formatPct(v/100), 'percentage', true,  true, prev ? prev.dragonCtl : null));
            cards.push(buildCard('obj_baron',   'Baron Control %',  tabName, cur.baronCtl,  v => formatPct(v/100), 'percentage', true,  true, prev ? prev.baronCtl : null));
            cards.push(buildCard('obj_tower',   'Tower Control %',  tabName, cur.towerCtl,  v => formatPct(v/100), 'percentage', true, true, prev ? prev.towerCtl : null));
            cards.push(buildCard('obj_herald',  'Heralds/Game',     tabName, cur.heralds,   v => formatNum(v,1),  'average',    true, true, prev ? prev.heralds : null));
            cards.push(buildCard('obj_inhib',   'Inhibitors/Game',  tabName, cur.inhibs,    v => formatNum(v,1),  'average',    true, true, prev ? prev.inhibs : null));
            cards.push(buildCard('obj_steal',   'Obj Steals/Game',  tabName, cur.steals,    v => formatNum(v,1),  'average',    true, true, prev ? prev.steals : null));
            // Not benchmarked: once it was computed correctly it sits at 93–98%
            // for every role, far above the old 35–70% ladder
            cards.push(buildCard('obj_rate',    'Alive for Objectives', tabName, cur.objRate, v => formatPct(v/100), 'percentage', false, true, prev ? prev.objRate : null));
            // Not benchmarked: a jungler does ~30x a top laner's objective
            // damage, so one ladder over mixed roles would mislabel most games
            const hasDmg = cur.dmgGames > 0;
            const prevDmg = hasDmg && prev && prev.dmgGames > 0 ? prev : null;
            cards.push(buildCard('obj_dmg_min',    'Objective DMG/Min', tabName, cur.objDmgMin,    v => hasDmg ? fmtInt(v) : '--', 'per-minute', false, true, prevDmg ? prevDmg.objDmgMin : null));
            cards.push(buildCard('turret_dmg_min', 'Turret DMG/Min',    tabName, cur.turretDmgMin, v => hasDmg ? fmtInt(v) : '--', 'per-minute', false, true, prevDmg ? prevDmg.turretDmgMin : null));
            break;
        }

        case 'Vision': {
            const cur = calcVision(matches);
            const prev = calcVision(prevMatches);
            cards.push(buildCard('vis_score',   'Vision Score',     tabName, cur.avgVs,    v => formatNum(v,1),  'average',    true,  true, prev ? prev.avgVs : null));
            cards.push(buildCard('vis_vs_min',  'Vision Score/Min', tabName, cur.avgVsMin, v => formatNum(v,2),  'per-minute', true,  true, prev ? prev.avgVsMin : null));
            cards.push(buildCard('vis_placed',  'Wards Placed',     tabName, cur.avgWp,    v => formatNum(v,1),  'average',    true, true, prev ? prev.avgWp : null));
            cards.push(buildCard('vis_killed',  'Wards Killed',     tabName, cur.avgWk,    v => formatNum(v,1),  'average',    true,  true, prev ? prev.avgWk : null));
            cards.push(buildCard('vis_control', 'Control Wards',    tabName, cur.avgCw,    v => formatNum(v,1),  'average',    true,  true, prev ? prev.avgCw : null));
            cards.push(buildCard('vis_adv',     'Vision Advantage', tabName, cur.avgVsAdv, v => formatNum(v,1),  'average',    true, true, prev ? prev.avgVsAdv : null));
            break;
        }

        case 'Economy': {
            const cur = calcEconomy(matches);
            const prev = calcEconomy(prevMatches);
            cards.push(buildCard('eco_gold',      'Gold/Game',    tabName, cur.avgGold,    v => (v/1000).toFixed(1)+'k', 'average',    true, true, prev ? prev.avgGold : null));
            cards.push(buildCard('eco_gold_min',  'Gold/Min',     tabName, cur.avgGoldMin, v => fmtInt(v),          'per-minute', true,  true, prev ? prev.avgGoldMin : null));
            cards.push(buildCard('eco_cs',        'CS/Game',      tabName, cur.avgCs,      v => fmtInt(v),          'average',    true, true, prev ? prev.avgCs : null));
            cards.push(buildCard('eco_cs_min',    'CS/Min',       tabName, cur.avgCsMin,   v => formatNum(v,1),         'per-minute', true,  true, prev ? prev.avgCsMin : null));
            cards.push(buildCard('eco_gold_share','Gold Share %', tabName, cur.goldShare,  v => formatPct(v/100),       'percentage', false, true, prev ? prev.goldShare : null));
            // Median time of your first purchase after the opening shop (#7).
            // No benchmark or trend arrow: an earlier back isn't simply better.
            const hasBacks = cur.firstBackGames > 0;
            cards.push(buildCard('eco_first_back', 'Median First Back', tabName, cur.firstBackMin, v => hasBacks ? fmtClock(v) : '--', 'average', false, null, null));
            break;
        }

        case 'Macro': {
            const cur = calcMacro(matches);
            const prev = calcMacro(prevMatches);
            cards.push(buildCard('mac_dur',       'Avg Game Length',    tabName, cur.avgDur,   v => formatNum(v,1)+'m', 'average',    false, null,  prev ? prev.avgDur : null));
            cards.push(buildCard('mac_fb',        'First Blood Rate',   tabName, cur.fbRate,   v => formatPct(v/100),   'percentage', true,  true,  prev ? prev.fbRate : null));
            cards.push(buildCard('mac_obj_rate',  'Alive for Objectives', tabName, cur.objRate, v => formatPct(v/100), 'percentage', false, true,  prev ? prev.objRate : null));
            cards.push(buildCard('mac_dragon_ctl','Dragon Control %',   tabName, cur.dragonCtl,v => formatPct(v/100),   'percentage', true, true,  prev ? prev.dragonCtl : null));
            cards.push(buildCard('mac_baron_ctl', 'Baron Control %',    tabName, cur.baronCtl, v => formatPct(v/100),   'percentage', true, true,  prev ? prev.baronCtl : null));
            if (cur.shortWr !== null) cards.push(buildCard('mac_short_wr', `Short (<25m) WR (${cur.shortCount}g)`, tabName, cur.shortWr, v => formatPct(v/100), 'percentage', true, true, prev && prev.shortWr !== null ? prev.shortWr : null));
            if (cur.longWr  !== null) cards.push(buildCard('mac_long_wr',  `Long (>35m) WR (${cur.longCount}g)`,  tabName, cur.longWr,  v => formatPct(v/100), 'percentage', true, true, prev && prev.longWr !== null ? prev.longWr : null));
            break;
        }

        case 'Consistency': {
            const cur = calcConsistency(matches);
            const prev = calcConsistency(prevMatches);
            const streakLabel = cur.currentStreak > 0 ? `🔥 ${cur.currentStreak}W Streak` : cur.currentStreak < 0 ? `❄️ ${Math.abs(cur.currentStreak)}L Streak` : 'No Streak';
            cards.push(buildCard('con_consistency', 'KDA Consistency',    tabName, cur.kdaConsistency, v => formatNum(v,1)+'%', 'percentage', true, true,  prev ? prev.kdaConsistency : null));
            // No STAT_BENCHMARKS entry exists for std-dev, so it is not benchmarkable
            // (was true → rendered a permanent "Unrated" chip).
            cards.push(buildCard('con_kda_std',     'KDA Std Dev',        tabName, cur.kdaStdDev,      v => formatNum(v,2),     'average',    false, false, prev ? prev.kdaStdDev : null));
            cards.push(buildCard('con_overall_wr',  'Overall Win Rate',   tabName, cur.overallWr,      v => formatPct(v/100),   'percentage', true, true,  prev ? prev.overallWr : null));
            if (cur.last10Wr !== null) cards.push(buildCard('con_last10_wr', 'Last 10 Win Rate', tabName, cur.last10Wr, v => formatPct(v/100), 'percentage', false, true, prev && prev.last10Wr !== null ? prev.last10Wr : null));
            cards.push(buildCard('con_max_win',     'Best Win Streak',    tabName, cur.maxWin,         v => v,                  'count',      false, true,  prev ? prev.maxWin : null));
            cards.push(buildCard('con_max_loss',    'Worst Loss Streak',  tabName, cur.maxLoss,        v => v,                  'count',      false, false, prev ? prev.maxLoss : null));
            cards.push(buildCard('con_cur_streak',  'Current Streak',     tabName, Math.abs(cur.currentStreak), v => streakLabel, 'count', false, true,  null));
            break;
        }

        default:
            cards.push(buildCard('coming_soon', 'Coming Soon', tabName, 0, () => '--', 'none', false, true, null));
    }

    return cards;
}
