/**
 * itemKinds.js — which items count as a build, from Data Dragon's item.json.
 * Shared by the Champions page (#4, #7) and the Live page's Next item card (#90).
 * Without Data Dragon loaded, every item counts.
 */

const { getItemData } = require('../services/dataDragon');

const tagsOf = id => (getItemData(id) || {}).tags || [];

/**
 * Finished items only: no consumables, trinkets or components. Boots count
 * once they're past basic Boots, even though tier-2 boots can still upgrade.
 */
function isCoreItem(id) {
    const it = getItemData(id);
    if (!it) return true;
    const tags = it.tags || [];
    const cost = (it.gold && it.gold.total) || 0;
    if (tags.includes('Consumable') || tags.includes('Trinket')) return false;
    if (tags.includes('Boots')) return cost >= 900;
    return !(it.into && it.into.length) && cost >= 1000;
}

/** Trinkets and consumables never count as part of a build. */
function isExcludedItem(id) {
    const tags = tagsOf(id);
    return tags.includes('Consumable') || tags.includes('Trinket');
}

/**
 * The numbered build slots are about the big item choices, so boots (which
 * nearly everyone buys first) stay out of them; they still show under First
 * back and in Core items.
 */
function isBuildItem(id) {
    return isCoreItem(id) && !tagsOf(id).includes('Boots');
}

module.exports = { isCoreItem, isExcludedItem, isBuildItem };
