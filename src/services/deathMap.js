/**
 * deathMap.js — where you die, and how that changes over a game (#8).
 *
 * Pure. The sync stores your deaths per game as a short string
 * (`deathPositions`, "x,y,seconds;…"), already turned so every death is seen
 * from the blue side, so the Death Review map never re-parses timelines.
 *
 * Turning a red-side death: lanes are fixed places on the map (top lane is
 * top for both teams), so it is reflected across the other diagonal,
 * (x, y) → (M − y, M − x). Flipping both axes would swap top and bottom.
 */

const MAP_SIZE = 14980;          // game units across Summoner's Rift

const PHASES = [
    { key: 'early', label: 'Early (0–14m)',  maxMs: 14 * 60000 },
    { key: 'mid',   label: 'Mid (14–25m)',   maxMs: 25 * 60000 },
    { key: 'late',  label: 'Late (25m+)',    maxMs: Infinity },
];

// How far along the base-to-base diagonal a death was: 0 = your fountain,
// 1 = theirs. Coarse, but needs no lane geometry.
const OWN_SIDE_MAX = 0.35;
const ENEMY_SIDE_MIN = 0.65;

const ZONE_LABELS = { own: 'near your base', middle: 'mid-map', enemy: 'in enemy territory' };

function toBlueSide(pos, teamId) {
    return teamId === 200 ? { x: MAP_SIZE - pos.y, y: MAP_SIZE - pos.x } : { x: pos.x, y: pos.y };
}

function framesOf(timeline) {
    return (timeline && timeline.info ? timeline.info.frames : timeline && timeline.frames) || [];
}

/** Your deaths that have a position, seen from the blue side, oldest first. */
function deathsFromTimeline(timeline, participantId, teamId) {
    return framesOf(timeline).flatMap(f => f.events || [])
        .filter(e => e.type === 'CHAMPION_KILL' && e.victimId === participantId && e.position)
        .sort((a, b) => a.timestamp - b.timestamp)
        .map(e => ({ ...toBlueSide(e.position, teamId), t: e.timestamp }));
}

/** [{x, y, t}] → "x,y,sec;…" ('' for none). */
function encodeDeaths(list) {
    return (list || []).map(d => `${Math.round(d.x)},${Math.round(d.y)},${Math.round(d.t / 1000)}`).join(';');
}

function decodeDeaths(text) {
    if (!text) return [];
    return String(text).split(';').map(s => {
        const [x, y, sec] = s.split(',').map(Number);
        return { x, y, t: sec * 1000 };
    }).filter(d => [d.x, d.y, d.t].every(Number.isFinite));
}

function zoneOf(d) {
    const along = (d.x + d.y) / (2 * MAP_SIZE);
    return along < OWN_SIDE_MAX ? 'own' : along > ENEMY_SIDE_MIN ? 'enemy' : 'middle';
}

function phaseOf(t) {
    return PHASES.find(p => t <= p.maxMs);
}

/** Per phase that has deaths: count and the share in each zone (0–1). */
function zonesByPhase(deaths) {
    return PHASES.map(p => {
        const inPhase = deaths.filter(d => phaseOf(d.t) === p);
        if (!inPhase.length) return null;
        const share = z => inPhase.filter(d => zoneOf(d) === z).length / inPhase.length;
        return { key: p.key, label: p.label, deaths: inPhase.length, own: share('own'), middle: share('middle'), enemy: share('enemy') };
    }).filter(Boolean);
}

/**
 * The biggest change between the first and last phase with deaths, in the
 * two zones that say something (near your base, enemy territory); null when
 * there's one phase, or nothing moved by 5 points.
 */
function biggestShift(phases) {
    if (phases.length < 2) return null;
    const first = phases[0], last = phases[phases.length - 1];
    const best = ['own', 'enemy']
        .map(zone => ({ zone, from: first[zone], to: last[zone], delta: Math.abs(last[zone] - first[zone]) }))
        .sort((a, b) => b.delta - a.delta)[0];
    if (best.delta < 0.05) return null;
    return { zone: best.zone, label: ZONE_LABELS[best.zone], fromPhase: first.label, toPhase: last.label, from: best.from, to: best.to };
}

/**
 * One dot per death with how many deaths are within `radius` (itself included).
 *
 * Deaths are bucketed into a grid of `radius`-sized cells, so each one is only
 * compared with its own cell and the 8 around it: anything farther is more
 * than `radius` away. Comparing every death with every other one took ~1 s per
 * Death Review render on ~10,000 deaths (#66).
 */
function densityDots(deaths, radius = 600) {
    const r2 = radius * radius;
    const cell = p => [Math.floor(p.x / radius), Math.floor(p.y / radius)];
    const grid = new Map();
    for (const d of deaths) {
        const [cx, cy] = cell(d);
        const key = cx + ',' + cy;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(d);
    }
    return deaths.map(d => {
        const [cx, cy] = cell(d);
        let n = 0;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (const o of grid.get((cx + dx) + ',' + (cy + dy)) || []) {
                    if ((o.x - d.x) ** 2 + (o.y - d.y) ** 2 <= r2) n++;
                }
            }
        }
        return { x: d.x, y: d.y, density: n };
    });
}

module.exports = {
    MAP_SIZE, PHASES, ZONE_LABELS,
    toBlueSide, deathsFromTimeline, encodeDeaths, decodeDeaths,
    zoneOf, phaseOf, zonesByPhase, biggestShift, densityDots,
};
