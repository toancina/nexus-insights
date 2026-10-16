const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SRC } = require('./helpers');

const { friendlyRiotError, isKeyError } = require(path.join(SRC, 'services', 'riotErrors.js'));

const httpError = (status) => Object.assign(new Error(`Request failed with status code ${status}`),
    { isAxiosError: true, response: { status } });

const KEY_MESSAGE = 'Riot API key invalid or expired. Development keys last 24 hours: ' +
    'get a new one at developer.riotgames.com and paste it in Settings (⚙).';

test('friendlyRiotError: the sync messages, by status', () => {
    assert.equal(friendlyRiotError(httpError(401)), KEY_MESSAGE);
    assert.equal(friendlyRiotError(httpError(403)), KEY_MESSAGE);
    assert.equal(friendlyRiotError(httpError(404)), 'Player not found. Check your Riot ID');
    assert.equal(friendlyRiotError(httpError(429)), 'Rate limited. Please wait a moment');
    assert.equal(friendlyRiotError(new Error('boom')), 'boom');
});

test('isKeyError: only 401 and 403', () => {
    assert.equal(isKeyError(httpError(401)), true);
    assert.equal(isKeyError(httpError(403)), true);
    assert.equal(isKeyError(httpError(404)), false);
    assert.equal(isKeyError(new Error('network')), false);
    assert.equal(isKeyError(null), false);
});
