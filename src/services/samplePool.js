/**
 * samplePool.js — which games feed a champion's item and rune numbers while
 * sample games are on (pure, tested): your games on the champion plus the
 * sample rows on it from your current two groups, under the same role and
 * period. Sample rows are marked `sample: 'level' | 'above'`.
 */

const { groupOf } = require('./sampleSelect');
const { filterByPeriod, patchList } = require('./patches');

/**
 * A period for sample rows. "Last N patches" means your N newest patches
 * (patchSource = your games), not the sample rows' own.
 */
function periodRows(rows, period, { patchSource, now }) {
    const [kind, arg] = String(period || '').split(':');
    if (kind === 'patches' && patchSource) {
        const keep = new Set(patchList(patchSource).slice(0, Number(arg) || 0).map(p => p.patch));
        return rows.filter(r => keep.has(r.patch));
    }
    return filterByPeriod(rows, period, { now });
}

function championPool(myMatches, sampleRows, champion, { role = null, period = '', groups = [], patchSource = null, now = Date.now() } = {}) {
    const name = String(champion || '').toLowerCase();
    const onChamp = m => String(m.championName || '').toLowerCase() === name && (!role || (m.teamPosition || '') === role);
    const mine = (myMatches || []).filter(onChamp);
    const others = periodRows((sampleRows || []).filter(onChamp), period, { patchSource, now })
        .map(r => ({ ...r, sample: groupOf(r, groups) }))
        .filter(r => r.sample);
    return {
        games: [...mine, ...others],
        counts: {
            mine: mine.length,
            level: others.filter(r => r.sample === 'level').length,
            above: others.filter(r => r.sample === 'above').length,
        },
    };
}

/** "From 412 games: yours 214 · Silver I 25 · Gold I 18" (groups with no games left out). */
function poolLabel(counts, groups) {
    const parts = [`yours ${counts.mine}`];
    for (const g of groups || []) if (counts[g.key]) parts.push(`${g.label} ${counts[g.key]}`);
    const total = counts.mine + (counts.level || 0) + (counts.above || 0);
    return `From ${total} games: ${parts.join(' · ')}`;
}

module.exports = { championPool, poolLabel };
