const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PLATFORM_ROUTING, routingFor, accountRoutingFor } = require('../src/services/riotApi');

test('every server in the setup dropdown has a routing', () => {
    // If someone adds a server to the dropdown but not to PLATFORM_ROUTING,
    // that player would silently fall back to Europe and sync nothing.
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
    const select = html.match(/<select id="setupPlatform"[\s\S]*?<\/select>/)[0];
    const platforms = [...select.matchAll(/value="([a-z0-9]+)"/g)].map(m => m[1]);
    assert.ok(platforms.length >= 16, `expected the full server list, got ${platforms.length}`);
    for (const p of platforms) {
        assert.ok(PLATFORM_ROUTING[p], `server "${p}" is in the dropdown but has no routing`);
    }
});

test('every routing has a matching option in the Region box', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
    const select = html.match(/<select id="setupRegion"[\s\S]*?<\/select>/)[0];
    const regions = new Set([...select.matchAll(/value="([a-z]+)"/g)].map(m => m[1]));
    for (const r of new Set(Object.values(PLATFORM_ROUTING))) {
        assert.ok(regions.has(r), `routing "${r}" can't be displayed in the Region box`);
    }
});

test('match routing follows Riot\'s cluster for each server', () => {
    assert.equal(routingFor('euw1'), 'europe');
    assert.equal(routingFor('na1'),  'americas');
    assert.equal(routingFor('kr'),   'asia');
    assert.equal(routingFor('oc1'),  'sea');   // the old region list had no sea at all
    assert.equal(routingFor('vn2'),  'sea');
});

test('account lookups never use sea (Account-V1 does not serve it)', () => {
    for (const p of Object.keys(PLATFORM_ROUTING)) {
        assert.notEqual(accountRoutingFor(p), 'sea', `${p} would send Account-V1 to sea`);
    }
    assert.equal(accountRoutingFor('oc1'), 'asia');
    assert.equal(accountRoutingFor('euw1'), 'europe');
});

test('unknown server falls back instead of producing an invalid host', () => {
    assert.equal(routingFor('xx9'), 'europe');
    assert.equal(routingFor('xx9', 'americas'), 'americas');
});

test('riotApi exposes the sample-game calls', async () => {
    const riotApi = require('../src/services/riotApi');
    for (const fn of ['getLeagueEntries', 'getApexLeague', 'getAllMasteries']) {
        assert.equal(typeof riotApi[fn], 'function', `${fn} missing`);
    }
    await assert.rejects(riotApi.getApexLeague('DIAMOND'), /apex/);
});
