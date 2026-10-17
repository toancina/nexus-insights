/**
 * teamImpact.js — how much of their team's game each of the 10 players
 * carried, a rank from 1 to 10, and MVP/SVP tags (issue #2).
 *
 * Pure: takes Match-V5 `info.participants`, returns numbers. Used by the
 * computed-stats pipeline (stored per match) and the expanded match row.
 *
 * A player's score is the average of their share of their OWN team's total
 * in eight areas, so a support isn't measured on damage alone and a carry
 * isn't measured on vision alone. An area whose team total is 0 (nobody
 * healed anyone) is skipped rather than scored as 0. Everyone is ranked on
 * score; the top-ranked winner is MVP and the top-ranked loser SVP.
 */

const n = (v) => (Number.isFinite(v) ? v : 0);

/** [key, label, value from a participant] */
const IMPACT_AREAS = [
    ['killsAssists',    'Kills + assists',     p => n(p.kills) + n(p.assists)],
    ['damage',          'Damage to champions', p => n(p.totalDamageDealtToChampions)],
    ['gold',            'Gold',                p => n(p.goldEarned)],
    ['vision',          'Vision',              p => n(p.visionScore)],
    // Riot's objective damage includes structures, which have their own area
    ['objectiveDamage', 'Objective damage',    p => Math.max(0, n(p.damageDealtToObjectives) - n(p.damageDealtToBuildings))],
    ['structureDamage', 'Structure damage',    p => n(p.damageDealtToBuildings)],
    // Heals on teammates, not totalHeal: lifesteal isn't given to the team
    ['healing',         'Healing on allies',   p => n(p.totalHealsOnTeammates)],
    ['damageTaken',     'Damage taken',        p => n(p.totalDamageTaken)],
];

const round1 = (v) => Math.round(v * 10) / 10;

/** Higher score first; ties by damage, kills + assists, gold, vision, then id. */
function compareImpact(a, b) {
    return (b.score - a.score) ||
           (b.damage - a.damage) ||
           (b.killsAssists - a.killsAssists) ||
           (b.gold - a.gold) ||
           (b.vision - a.vision) ||
           (a.id - b.id);
}

/**
 * @param {Array} participants  rawJson.info.participants
 * @returns {Map<number, {score, rank, tag, shares}>} keyed by participantId;
 *          shares are percentages (0–100), null for a skipped area;
 *          empty unless there are exactly 10 players
 */
function computeTeamImpact(participants) {
    // Ranks are "of 10": other modes (Arena has 16 players in pairs) get none (#68)
    if (!participants || participants.length !== 10) return new Map();
    const players = (participants || []).map((p, i) => ({
        p, id: p.participantId || i + 1,
        values: Object.fromEntries(IMPACT_AREAS.map(([key, , get]) => [key, get(p)])),
    }));

    const totals = {};
    for (const { p, values } of players) {
        const team = totals[p.teamId] || (totals[p.teamId] = {});
        for (const [key] of IMPACT_AREAS) team[key] = (team[key] || 0) + values[key];
    }

    const rows = players.map(({ p, id, values }) => {
        const shares = {};
        for (const [key] of IMPACT_AREAS) {
            const total = totals[p.teamId][key];
            shares[key] = total > 0 ? round1(values[key] / total * 100) : null;
        }
        const counted = Object.values(shares).filter(v => v !== null);
        const score = counted.length ? round1(counted.reduce((a, b) => a + b, 0) / counted.length) : 0;
        return {
            id, win: !!p.win, score, shares,
            damage: values.damage, killsAssists: values.killsAssists,
            gold: values.gold, vision: values.vision,
        };
    });

    const ranked = [...rows].sort(compareImpact);
    const mvp = ranked.find(r => r.win);
    const svp = ranked.find(r => !r.win);

    const out = new Map();
    for (const r of rows) {
        out.set(r.id, {
            score: r.score,
            rank: ranked.indexOf(r) + 1,
            tag: r === mvp ? 'MVP' : r === svp ? 'SVP' : null,
            shares: r.shares,
        });
    }
    return out;
}

/** Impact of the tracked player (found by champion + team, as everywhere else). */
function impactFor(participants, championName, teamId) {
    const list = participants || [];
    const i = list.findIndex(p => p.championName === championName && p.teamId === teamId);
    if (i < 0) return null;
    return computeTeamImpact(list).get(list[i].participantId || i + 1) || null;
}

module.exports = { IMPACT_AREAS, computeTeamImpact, impactFor, _internal: { compareImpact } };
