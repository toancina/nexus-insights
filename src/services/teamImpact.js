/**
 * teamImpact.js — how much each of the 10 players contributed to their game:
 * a 0–10 score, a rank from 1 to 10, and MVP/SVP tags (issue #2).
 *
 * Pure: takes Match-V5 `info.participants`, returns numbers. Used by the
 * computed-stats pipeline (stored per match) and the expanded match row.
 *
 * Like OP.GG's score (their formula isn't published, this is the same idea):
 * every stat is compared with what's usual FOR THAT ROLE, across all 10
 * players of the game, then the areas are weighted. 5.0 = an average player in
 * this game; 10 = far above in every area. The first version averaged each
 * player's share of their own team in eight equally weighted areas, which made
 * a support (≈82% of team healing, ≈41% of vision) or a jungler (≈68% of
 * objective damage) the MVP in 3 games of 4 and mid/bot almost never (2026-11).
 *
 * Heals and shields on allies are not an area of their own: they are added to
 * damage in one "combat" area, in HP, so a support can't win on them alone.
 * Deaths count against you; damage taken is a small plus (tanking).
 *
 * Ranks are within the game (both teams); the top-ranked winner is MVP and
 * the top-ranked loser SVP.
 */

const n = (v) => (Number.isFinite(v) ? v : 0);

/** [key, label, weight, value from a participant]. Weights add up to 1. */
const IMPACT_AREAS = [
    ['takedowns',  'Kills + assists',                    0.25,  p => n(p.kills) + n(p.assists)],
    ['deaths',     'Deaths (fewer is better)',           0.20,  p => n(p.deaths)],
    ['combat',     'Damage + heals and shields on allies', 0.20, p => n(p.totalDamageDealtToChampions) + n(p.totalHealsOnTeammates) + n(p.totalDamageShieldedOnTeammates)],
    ['gold',       'Gold',                               0.10,  p => n(p.goldEarned)],
    ['vision',     'Vision',                             0.10,  p => n(p.visionScore)],
    ['objectives', 'Objective and structure damage',     0.10,  p => n(p.damageDealtToObjectives)],
    ['tanking',    'Damage taken and mitigated',         0.025, p => n(p.totalDamageTaken) + n(p.damageSelfMitigated)],
    ['control',    'Crowd control time',                 0.025, p => n(p.timeCCingOthers)],
];

/**
 * What each role usually has, as a multiple of the game's average player,
 * measured on 526 Solo/Duo + Flex games (2026-11). A value is divided by its
 * role's par before players are compared, so a support's low damage and a
 * jungler's high objective damage count as normal, not as a gap. Retune by
 * re-measuring; an unknown role (no teamPosition) uses 1 everywhere.
 */
const ROLE_PAR = {
    TOP:     { takedowns: 0.77, deaths: 0.95, combat: 1.08, gold: 1.00, vision: 0.75, objectives: 1.05, tanking: 1.37, control: 0.94 },
    JUNGLE:  { takedowns: 1.06, deaths: 0.95, combat: 0.89, gold: 1.07, vision: 0.85, objectives: 2.03, tanking: 1.20, control: 1.01 },
    MIDDLE:  { takedowns: 0.99, deaths: 1.04, combat: 1.14, gold: 1.00, vision: 0.68, objectives: 0.73, tanking: 0.87, control: 0.88 },
    BOTTOM:  { takedowns: 1.06, deaths: 1.01, combat: 1.11, gold: 1.15, vision: 0.66, objectives: 0.92, tanking: 0.70, control: 0.60 },
    UTILITY: { takedowns: 1.13, deaths: 1.05, combat: 0.78, gold: 0.78, vision: 2.08, objectives: 0.27, tanking: 0.86, control: 1.56 },
};

const SCORE_MID   = 5;     // an average player
const SCORE_SCALE = 3.2;   // points per weighted standard deviation
const Z_CAP       = 2.5;   // one freak stat can't carry or sink a score

const round1 = (v) => Math.round(v * 10) / 10;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

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
 * @returns {Map<number, {score, rank, tag, areas}>} keyed by participantId;
 *          score 0–10; areas = per-area standing in the game, in standard
 *          deviations (positive = better than the other players for that
 *          role, deaths already flipped); empty unless there are exactly 10 players
 */
function computeTeamImpact(participants) {
    // Ranks are "of 10": other modes (Arena has 16 players in pairs) get none (#68)
    if (!participants || participants.length !== 10) return new Map();
    const players = participants.map((p, i) => {
        const par = ROLE_PAR[p.teamPosition] || {};
        return {
            p, id: p.participantId || i + 1,
            values: Object.fromEntries(IMPACT_AREAS.map(([key, , , get]) => [key, get(p)])),
            par,
        };
    });

    // z-score per area over the 10 role-adjusted values
    const areas = players.map(() => ({}));
    for (const [key] of IMPACT_AREAS) {
        const v = players.map(pl => pl.values[key] / (pl.par[key] || 1));
        const m = mean(v);
        const sd = Math.sqrt(mean(v.map(x => (x - m) ** 2)));
        v.forEach((x, i) => {
            // no real spread (or only float noise): nobody stands out
            let z = sd > 1e-9 * Math.max(1, Math.abs(m)) ? (x - m) / sd : 0;
            if (key === 'deaths') z = -z;
            areas[i][key] = Math.max(-Z_CAP, Math.min(Z_CAP, z));
        });
    }

    const rows = players.map(({ p, id, values }, i) => {
        const weighted = IMPACT_AREAS.reduce((s, [key, , w]) => s + w * areas[i][key], 0);
        const score = round1(Math.max(0, Math.min(10, SCORE_MID + SCORE_SCALE * weighted)));
        return {
            id, win: !!p.win, score, areas: areas[i],
            damage: n(p.totalDamageDealtToChampions), killsAssists: values.takedowns,
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
            areas: Object.fromEntries(Object.entries(r.areas).map(([k, z]) => [k, round1(z)])),
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

module.exports = { IMPACT_AREAS, ROLE_PAR, computeTeamImpact, impactFor, _internal: { compareImpact } };
