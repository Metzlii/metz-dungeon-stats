// Dungeon tokens valued at the opening (design 4.3): deriveMoney() over synthetic openings. The block is cut out of the
// userscript, so this exercises the shipped code.
//   node test/tokens.test.mjs [--source path]
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const source = args.includes("--source") ? args[args.indexOf("--source") + 1] : path.join(here, "..", "metz-dungeon-stats.user.js");
const text = fs.readFileSync(source, "utf8");
const deriveMoney = new Function(`${text.slice(text.indexOf("// <money>"), text.indexOf("// </money>"))}\nreturn deriveMoney;`)();

const CHEST = "/items/pirate_chest", TOKEN = "/items/pirate_token", BROOCH = "/items/marksman_brooch", ESSENCE = "/items/pirate_essence", FANG = "/items/kraken_fang", KEY = "/items/pirate_chest_key";
const SHOP = { [TOKEN]: [{ item: BROOCH, tokens: 2000, count: 1 }, { item: ESSENCE, tokens: 1, count: 1 }, { item: FANG, tokens: 3000, count: 1 }] };
const NOW = { [BROOCH]: 6000000, [ESSENCE]: 1700, [FANG]: 9300000 };
const stub = base => new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => null) });
const X = stub({ recordStart: 0, reviewPct: 0.5, consumeTotals: new Map(), keyRecipes: {}, isKey: h => h === KEY, isEntryKey: () => false, isRealKey: h => h === KEY,
    isChest: h => h === CHEST, isDungeonChest: h => h === CHEST, isCounted: () => false, isConsumable: () => false, isToken: h => h === TOKEN, isOpenable: () => false, isDungeonLoot: () => false, isTradable: h => h !== TOKEN,
    tokenShop: h => SHOP[h] || [], heldKeys: () => [], held: () => 0, listed: () => 0, bidOf: h => NOW[h] || null });
const open = (id, at, gains) => ({ id, kind: "open", at, chest: CHEST, count: 1, keyItem: KEY, gains, coinsGained: 0 });
const timeline = [
    { id: "b", kind: "baseline", at: 1, items: [], keys: [], chests: [] },
    // An opening from before tokens were valued: no stored rate. The brooch's bid comes from the opening nearest in
    // time that recorded one (id "o2", 5,000,000), the essence's from this opening itself.
    open("o1", 1000, [{ item: TOKEN, qty: 400, bid: null }, { item: ESSENCE, qty: 600, bid: 1500 }]),
    open("o2", 1100, [{ item: TOKEN, qty: 300, bid: null }, { item: ESSENCE, qty: 600, bid: 1600 }, { item: BROOCH, qty: 1, bid: 5000000 }]),
    // Far later, with its own brooch bid: the nearest one for this opening.
    open("o3", 900000, [{ item: TOKEN, qty: 500, bid: null }, { item: BROOCH, qty: 1, bid: 4000000 }]),
    // Recorded with the rate it had when opened: that rate stands, whatever the bids around it say.
    open("o4", 900100, [{ item: TOKEN, qty: 100, bid: null, tokenBid: 3000, via: BROOCH }]),
];
const M = deriveMoney(timeline, X);
// o1: best of brooch 5,000,000 / 2,000 = 2,500, essence 1,500 / 1 = 1,500, fang (never recorded) today 9,300,000 / 3,000 = 3,100.
assert.equal(M.loot.tokenRates.o1[TOKEN], 3100);
assert.equal(M.loot.tokenRates.o2[TOKEN], 3100);
assert.equal(M.loot.tokenRates.o3[TOKEN], 3100);
assert.equal(M.loot.tokenRates.o4[TOKEN], 3000);
assert.deepEqual(M.loot.tokens, { qty: 1300, value: 1200 * 3100 + 100 * 3000, open: 100, near: 0, now: 1200, unpriced: 0 });

// With the fang out of the shop the recorded bids decide: 2,500 beside the 5,000,000 brooch, 2,000 beside the 4,000,000 one.
SHOP[TOKEN].pop();
const N = deriveMoney(timeline, X);
assert.equal(N.loot.tokenRates.o1[TOKEN], 2500);
assert.equal(N.loot.tokenRates.o2[TOKEN], 2500);
assert.equal(N.loot.tokenRates.o3[TOKEN], 2000);
assert.deepEqual(N.loot.tokens, { qty: 1300, value: 700 * 2500 + 500 * 2000 + 100 * 3000, open: 100, near: 1200, now: 0, unpriced: 0 });
// The card's figure is the market items at their recorded bid plus the tokens, and the chest's own total carries both.
const market = 600 * 1500 + 600 * 1600 + 5000000 + 4000000;
assert.equal(N.loot.atOpen, market + N.loot.tokens.value);
assert.equal(N.chests[CHEST].value, market + N.loot.tokens.value);
assert.equal(N.chests[CHEST].tokenValue, N.loot.tokens.value);
// Net counts what was sold, so valuing tokens moves nothing in it.
assert.equal(N.net, 0);

// A token no shop item prices stays unpriced and adds nothing.
SHOP[TOKEN] = [];
const U = deriveMoney(timeline.slice(0, 2), X);
assert.deepEqual(U.loot.tokens, { qty: 400, value: 0, open: 0, near: 0, now: 0, unpriced: 400 });
assert.equal(U.loot.atOpen, 600 * 1500);
console.log("ok: tokens are worth the best shop bid per token at the opening; stored rate first, nearest recorded bid next, today's last");
