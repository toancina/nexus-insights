/**
 * Issue #67: item icons. Items still in the game share one current-version
 * URL; removed items come from their game's patch.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const { SRC } = require('./helpers');

test('current items use the current version, removed ones their patch', () => {
    const ddFile = path.join(SRC, 'services', 'dataDragon.js');
    const fake = new Module(ddFile);
    fake.filename = ddFile; fake.loaded = true;
    fake.exports = {
        getDDragonBase: () => 'https://ddragon.leagueoflegends.com/cdn/16.20.1',
        getVersions: () => ['16.20.1', '16.16.1', '16.10.1'],
        getItemData: id => (id === 3078 ? { name: 'Trinity Force' } : null),
        isGameDataLoaded: () => true,
    };
    require.cache[ddFile] = fake;
    global.window = global.window || {};
    const iconFile = path.join(SRC, 'components', 'itemIcon.js');
    delete require.cache[iconFile];
    try {
        const { itemIconUrl, itemImg } = require(iconFile);
        assert.equal(itemIconUrl(3078, '16.10'), 'https://ddragon.leagueoflegends.com/cdn/16.20.1/img/item/3078.png');
        assert.equal(itemIconUrl(3097, '16.16'), 'https://ddragon.leagueoflegends.com/cdn/16.16.1/img/item/3097.png');
        assert.equal(itemIconUrl(3097, null), 'https://ddragon.leagueoflegends.com/cdn/16.20.1/img/item/3097.png',
            'unknown patch: current version, then the placeholder');
        assert.match(itemImg(3097, { patch: '16.16', extra: 'class="x"' }), /data-item-id="3097" alt="Item" class="x" onerror="itemIconFallback\(this\)"/);
        assert.equal(typeof window.itemIconFallback, 'function');
    } finally {
        delete require.cache[ddFile];
        delete require.cache[iconFile];
    }
});
