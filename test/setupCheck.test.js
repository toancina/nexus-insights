/**
 * Issue #74: what the setup dialog says when the Riot check of its details
 * fails, and when it saves them unchecked.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SRC } = require('./helpers');

const { verifyProblem } = require(path.join(SRC, 'services', 'setupCheck.js'));
const who = { gameName: 'Toan', tagLine: 'NBG', serverName: 'EUW' };
const err = (status, step) => Object.assign(new Error('x'), status ? { response: { status }, step } : { step });

test('bad key, unknown Riot ID and wrong server block the save', () => {
    assert.match(verifyProblem(err(403, 'account'), who).message, /invalid or expired/);
    assert.match(verifyProblem(err(401, 'summoner'), who).message, /invalid or expired/);
    assert.match(verifyProblem(err(404, 'account'), who).message, /no Riot ID Toan#NBG/);
    assert.match(verifyProblem(err(404, 'summoner'), who).message, /no League account on EUW/);
    for (const e of [err(403, 'account'), err(404, 'account'), err(404, 'summoner')]) {
        assert.equal(verifyProblem(e, who).offline, undefined);
    }
});

test('offline, Riot down or busy: saved unchecked', () => {
    for (const e of [err(null, 'account'), err(500, 'account'), err(429, 'summoner'), err(503, 'summoner')]) {
        assert.equal(verifyProblem(e, who).offline, true);
    }
});
