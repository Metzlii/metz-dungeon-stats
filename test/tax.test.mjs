// Market tax by item and date (design 4.5): marketTaxRate() and what deriveMoney() does with sales that carry no tax
// from the game. The block is cut out of the userscript, so this exercises the shipped code.
//   node test/tax.test.mjs [--source path]
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const source = args.includes("--source") ? args[args.indexOf("--source") + 1] : path.join(here, "..", "metz-dungeon-stats.user.js");
const text = fs.readFileSync(source, "utf8");
const { deriveMoney, marketTaxRate } = new Function(`${text.slice(text.indexOf("// <money>"), text.indexOf("// </money>"))}\nreturn { deriveMoney, marketTaxRate };`)();

const BAG = "/items/bag_of_10_cowbells", SHARD = "/items/pirate_refinement_shard", ESSENCE = "/items/pirate_essence", LUMBER = "/items/arcane_lumber";
const day = (y, m, d, h = 12) => Date.UTC(y, m - 1, d, h);

// ---- 1. The rule: 2% until the patch of 2026-08-13, 5% until the patch of 2026-09-27, 4% since; a Cowbell Bag always 18%.
assert.equal(marketTaxRate(SHARD, day(2026, 7, 1)), 0.02);
assert.equal(marketTaxRate(SHARD, day(2026, 8, 12)), 0.02);
assert.equal(marketTaxRate(SHARD, day(2026, 8, 13)), 0.05);
assert.equal(marketTaxRate(SHARD, day(2026, 9, 26)), 0.05);
assert.equal(marketTaxRate(SHARD, day(2026, 9, 27)), 0.04);
assert.equal(marketTaxRate(SHARD, day(2026, 11, 22)), 0.04);
assert.equal(marketTaxRate(SHARD, null), 0.04);
for (const at of [day(2026, 7, 1), day(2026, 9, 1), day(2026, 11, 22), null]) assert.equal(marketTaxRate(BAG, at), 0.18);

// ---- 2. deriveMoney
const stub = base => new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => null) });
const X = stub({ recordStart: 0, reviewPct: 0.5, consumeTotals: new Map(), keyRecipes: {}, isKey: () => false, isEntryKey: () => false, isRealKey: () => false,
    isChest: h => h === "/items/pirate_refinement_chest", isDungeonChest: h => h === "/items/pirate_refinement_chest", isCounted: () => false, isConsumable: () => false, isToken: () => false, isOpenable: () => false,
    isDungeonLoot: () => false, isTradable: () => true, tokenShop: () => [], heldKeys: () => [], held: () => 0, listed: () => 0 });
const imported = (id, item, at, gross, tax) => ({ id, kind: "sell", at, listingId: id, item, level: 0, qty: 1, unitPrice: gross, gross, tax, net: gross - tax, taxBasis: "rate", imported: true, instant: false });
const live = (id, item, at, qty, unitPrice, tax) => ({ id, kind: "sell", at, listingId: id, item, level: 0, qty, unitPrice, gross: qty * unitPrice, tax, net: qty * unitPrice - tax, instant: false });
const now = day(2026, 11, 22);
const timeline = [
    { id: "b", kind: "baseline", at: 1, items: [], keys: [], chests: [] },
    { id: "o", kind: "open", at: 2, chest: "/items/pirate_refinement_chest", count: 1, gains: [{ item: SHARD, qty: 100, bid: 2440000 }], coinsGained: 0 },
    // Imported sales whose stored tax copied the rate of whatever sold last: a rounded-up 4.17%, and a Cowbell Bag's 18%.
    imported("i1", SHARD, now - 5000, 100000000, 4170000),
    imported("i2", SHARD, now - 4000, 100000000, 18000000),
    // The same mistake the other way: a Cowbell Bag imported at 4%.
    imported("i3", BAG, now - 3000, 10000000, 400000),
    // Imports dated under the older rules.
    imported("i4", LUMBER, day(2026, 9, 1), 1000000, 40000),
    imported("i5", LUMBER, day(2026, 7, 1), 1000000, 40000),
    // Watched sales keep the tax the game reported, whatever the rule says: a normal one, a Cowbell Bag, and a small
    // sale of a cheap item where the game's figure came to 4.7%.
    live("l1", SHARD, now - 2000, 10, 2440000, 976000),
    live("l2", BAG, now - 1000, 2, 1265000, 455400),
    live("l3", ESSENCE, now - 500, 100, 77, 362),
];
const M = deriveMoney(timeline, X);
const S = M.sellBy;
assert.equal(S[SHARD].tax, 4000000 + 4000000 + 976000, "imported loot sales are taxed 4%, the watched one as reported");
assert.equal(S[SHARD].net, 96000000 + 96000000 + (24400000 - 976000));
assert.equal(S[BAG].tax, 1800000 + 455400, "an imported Cowbell Bag is taxed 18%");
assert.equal(S[LUMBER].tax, 50000 + 20000, "an import dated under the 5% rule, and one under the 2% rule");
assert.equal(S[ESSENCE].tax, 362, "the game's own figure stands");
assert.equal(M.sold.loot.tax, 4000000 + 4000000 + 976000);
assert.equal(M.sold.other.tax, 1800000 + 455400 + 50000 + 20000 + 362);
// The standard rate in force: the latest watched sale of an ordinary item at 10,000 or more a piece. Neither the
// Cowbell Bag nor the cheap essence that sold after it decides it.
assert.equal(M.tax.rate, 0.04);
assert.equal(M.tax.measured, 1);
// With no such sale the rule itself is the rate.
const none = deriveMoney(timeline.filter(e => e.id !== "l1"), X);
assert.equal(none.tax.rate, 0.04);
assert.equal(none.tax.measured, 0);
// If the game changes the tax again, the record's own next sale shows it before the rule is updated.
const changed = deriveMoney(timeline.concat([live("l4", SHARD, now, 10, 2440000, 732000)]), X);
assert.equal(changed.tax.rate, 0.03);
console.log("ok: tax by item and date; imports follow the rule, watched sales keep the game's figure");
