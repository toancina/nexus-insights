/**
 * Which items count as a build (#7, #90): shared by the Champions page's
 * Build order card and the Live page's Next item card.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const { SRC } = require('./helpers');

/** item.json entries, trimmed to what the rules read. */
const ITEMS = {
    1001: { name: 'Boots',                tags: ['Boots'],                gold: { total: 300 },  into: ['3006'] },
    3006: { name: "Berserker's Greaves",  tags: ['Boots', 'AttackSpeed'], gold: { total: 1100 } },
    1036: { name: 'Long Sword',           tags: ['Damage'],               gold: { total: 350 },  into: ['3071'] },
    3071: { name: 'Black Cleaver',        tags: ['Damage', 'Health'],     gold: { total: 3000 } },
    1055: { name: "Doran's Blade",        tags: ['Damage', 'Lane'],       gold: { total: 450 } },
    2003: { name: 'Health Potion',        tags: ['Consumable'],           gold: { total: 50 } },
    3340: { name: 'Stealth Ward',         tags: ['Trinket'],              gold: { total: 0 } },
};

function withItems(items, fn) {
    const ddFile = path.join(SRC, 'services', 'dataDragon.js');
    const fake = new Module(ddFile);
    fake.filename = ddFile; fake.loaded = true;
    fake.exports = { getItemData: id => (items ? items[id] || null : null) };
    require.cache[ddFile] = fake;
    const file = path.join(SRC, 'components', 'itemKinds.js');
    delete require.cache[file];
    try {
        fn(require(file));
    } finally {
        delete require.cache[ddFile];
        delete require.cache[file];
    }
}

test('isCoreItem: finished items and upgraded boots, not components, consumables or trinkets', () => {
    withItems(ITEMS, ({ isCoreItem }) => {
        assert.deepEqual([3071, 3006, 1036, 1001, 1055, 2003, 3340].map(isCoreItem),
            [true, true, false, false, false, false, false]);
    });
});

test('isBuildItem: core items without boots', () => {
    withItems(ITEMS, ({ isBuildItem }) => {
        assert.deepEqual([3071, 3006, 1036].map(isBuildItem), [true, false, false]);
    });
});

test('isExcludedItem: consumables and trinkets only', () => {
    withItems(ITEMS, ({ isExcludedItem }) => {
        assert.deepEqual([2003, 3340, 1036, 3071].map(isExcludedItem), [true, true, false, false]);
    });
});

test('without Data Dragon loaded, every item counts', () => {
    withItems(null, ({ isCoreItem, isBuildItem, isExcludedItem }) => {
        assert.equal(isCoreItem(1036), true);
        assert.equal(isBuildItem(1036), true);
        assert.equal(isExcludedItem(2003), false);
    });
});
