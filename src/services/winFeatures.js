/**
 * winFeatures.js — the game state at each timeline frame, as the fitted
 * win-chance curve (winModel.js) reads it. Pure, tested.
 *
 * Every value is team 100 minus team 200, so one stored list serves both
 * sides (flipFeatures for team 200):
 *   m        minute of the frame (float)
 *   gold xp  team totals
 *   kills    kills by players (an execution counts for nobody, as in teamSeries)
 *   towers   towers destroyed
 *   inhibs   inhibitors currently down (they respawn after 5 minutes)
 *   dragons  elemental dragons taken (Elder excluded)
 *   soul     +1 / −1 once a team has 4 dragons
 *   baron    +1 / −1 while that team's Baron buff is up (3 min)
 *   elder    +1 / −1 while that team's Elder buff is up (2.5 min)
 *
 * Stored as text, one frame per ';': "m,g,x,k,t,i,d,s,b,e" (m to 2 decimals).
 */

const { rosterOf } = require('./matchTimeline');

const INHIB_RESPAWN_MS = 300000;
const BARON_BUFF_MS = 180000;
const ELDER_BUFF_MS = 150000;
const KEYS = ['m', 'gold', 'xp', 'kills', 'towers', 'inhibs', 'dragons', 'soul', 'baron', 'elder'];

const framesOf = tl => (tl && tl.info ? tl.info.frames : tl && tl.frames) || [];
const sideOf = team => (team === 100 ? 1 : team === 200 ? -1 : 0);

function frameFeatures(raw, timeline) {
    const frames = framesOf(timeline);
    if (!frames.length) return [];
    const roster = rosterOf(raw && raw.info ? raw : { info: raw });
    const events = frames.flatMap(f => f.events || []);

    const kills = [], towers = [], inhibs = [], dragons = [], barons = [], elders = [];
    for (const e of events) {
        if (e.type === 'CHAMPION_KILL' && roster[e.killerId]) {
            kills.push({ t: e.timestamp, s: sideOf(roster[e.killerId].teamId) });
        } else if (e.type === 'BUILDING_KILL') {
            const s = -sideOf(e.teamId);   // teamId is the team that lost the building
            if (e.buildingType === 'TOWER_BUILDING') towers.push({ t: e.timestamp, s });
            else if (e.buildingType === 'INHIBITOR_BUILDING') inhibs.push({ t: e.timestamp, s });
        } else if (e.type === 'ELITE_MONSTER_KILL') {
            const s = sideOf(e.killerTeamId);
            if (e.monsterType === 'BARON_NASHOR') barons.push({ t: e.timestamp, s });
            else if (e.monsterType === 'DRAGON' && e.monsterSubType === 'ELDER_DRAGON') elders.push({ t: e.timestamp, s });
            else if (e.monsterType === 'DRAGON') dragons.push({ t: e.timestamp, s });
        }
    }
    const sumUpTo = (list, t) => list.reduce((d, x) => (x.t <= t ? d + x.s : d), 0);
    const sumWithin = (list, t, ms) => list.reduce((d, x) => (x.t <= t && t - x.t < ms ? d + x.s : d), 0);
    const buff = (list, t, ms) => {
        const last = list.filter(x => x.t <= t && t - x.t < ms).pop();
        return last ? last.s : 0;
    };

    return frames.map(frame => {
        const t = frame.timestamp;
        let gold = 0, xp = 0;
        for (const [pid, p] of Object.entries(frame.participantFrames || {})) {
            const r = roster[pid];
            if (!r) continue;
            const s = sideOf(r.teamId);
            gold += s * (p.totalGold || 0);
            xp += s * (p.xp || 0);
        }
        const blueDragons = dragons.filter(x => x.t <= t && x.s === 1).length;
        const redDragons = dragons.filter(x => x.t <= t && x.s === -1).length;
        return {
            m: t / 60000,
            gold, xp,
            kills: sumUpTo(kills, t),
            towers: sumUpTo(towers, t),
            inhibs: sumWithin(inhibs, t, INHIB_RESPAWN_MS),
            dragons: blueDragons - redDragons,
            soul: blueDragons >= 4 ? 1 : redDragons >= 4 ? -1 : 0,
            baron: buff(barons, t, BARON_BUFF_MS),
            elder: buff(elders, t, ELDER_BUFF_MS),
        };
    });
}

function encodeFeatures(list) {
    return (list || []).map(f => KEYS.map((k, i) => (i === 0 ? (f.m || 0).toFixed(2) : Math.round(f[k] || 0))).join(',')).join(';');
}

function decodeFeatures(text) {
    if (!text) return [];
    const out = [];
    for (const part of String(text).split(';')) {
        const nums = part.split(',');
        if (nums.length !== KEYS.length) return [];
        const values = nums.map(Number);
        if (!values.every(Number.isFinite)) return [];
        const f = {};
        KEYS.forEach((k, i) => { f[k] = values[i]; });
        out.push(f);
    }
    return out;
}

function flipFeatures(f) {
    const out = { m: f.m };
    for (const k of KEYS.slice(1)) out[k] = f[k] ? -f[k] : 0;
    return out;
}

module.exports = { KEYS, INHIB_RESPAWN_MS, BARON_BUFF_MS, ELDER_BUFF_MS, frameFeatures, encodeFeatures, decodeFeatures, flipFeatures };
