/**
 * account.js — whose games and LP readings the app shows (#73).
 *
 * Every stored game and LP reading carries the PUUID of the account it
 * belongs to (`matches.puuid`, `lp_history.puuid`). The configured account's
 * PUUID is kept in config.json as `puuid`, with `puuidFor` = the Riot ID and
 * server it was resolved for. Sync, ranks and LP always use the configured
 * account; the top bar can't point them at anyone else.
 *
 * The PUUID, not the Riot ID, is the key: names change (one real history
 * spans Toan#GGWP and Toan#NBG under one PUUID), PUUIDs don't. Riot encrypts
 * PUUIDs per API key project, though, so if the configured Riot ID resolves
 * to a different PUUID than before, the stored rows are re-tagged instead of
 * hidden (planAccount's `remapFrom`).
 */

/** "name#tag@platform", lower case; '' when no Riot ID is configured. */
function accountKey(cfg) {
    if (!cfg || !cfg.gameName || !cfg.tagLine) return '';
    return `${cfg.gameName.trim()}#${cfg.tagLine.trim()}@${cfg.platform || 'euw1'}`.toLowerCase();
}

/** Has the configured Riot ID been resolved to a PUUID yet? */
function isResolved(cfg) {
    return !!cfg.puuid && cfg.puuidFor === accountKey(cfg);
}

/**
 * SQL condition limiting rows to the configured account.
 * - resolved: that PUUID (untagged rows count too, they predate tagging)
 * - Riot ID changed, not resolved yet: no tagged rows, so the old account's
 *   games never show under the new name
 * - never resolved (first run, or a database from before #73): everything
 */
function accountScope(cfg, column = 'puuid') {
    if (isResolved(cfg)) return { sql: `(${column} = ? OR ${column} IS NULL)`, params: [cfg.puuid] };
    if (cfg.puuid) return { sql: `${column} IS NULL`, params: [] };
    return { sql: '1 = 1', params: [] };
}

/**
 * What to save once the configured Riot ID has resolved to `puuid`.
 * `remapFrom`: the same Riot ID and server now give a different PUUID (a key
 * from another Riot project), so rows tagged with the old one are this
 * account's and get the new one. A different Riot ID is a different account
 * (or a rename, which resolves to the same PUUID): nothing is re-tagged.
 */
function planAccount(cfg, puuid) {
    const key = accountKey(cfg);
    const remapFrom = cfg.puuid && cfg.puuidFor === key && cfg.puuid !== puuid ? cfg.puuid : null;
    const changed = cfg.puuid !== puuid || cfg.puuidFor !== key;
    return { puuid, puuidFor: key, remapFrom, changed };
}

/**
 * Resolve the configured account and save it. Resolves to
 * { puuid, changed } (changed: what the app shows is now different), or null
 * when no Riot ID is configured. Dependencies are passed in (riotApi,
 * database, config) so this stays testable and free of circular requires.
 */
async function resolveAccount({ loadConfig, updateConfig, getPuuid, retag }) {
    const cfg = loadConfig();
    if (!accountKey(cfg)) return null;
    const puuid = await getPuuid(cfg.gameName.trim(), cfg.tagLine.trim());
    const plan = planAccount(cfg, puuid);
    if (plan.remapFrom) await retag(plan.remapFrom, puuid);
    if (plan.changed) updateConfig({ puuid: plan.puuid, puuidFor: plan.puuidFor });
    return { puuid, changed: plan.changed };
}

module.exports = { accountKey, isResolved, accountScope, planAccount, resolveAccount };
