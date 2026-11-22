// The game's Loot & XP Log as the record's count (design 4.7): logTotals() over synthetic sessions, and what it does to
// the Keys table through deriveMoney(). Both blocks are cut out of the userscript, so this exercises the shipped code.
//   node test/logtotals.test.mjs [--source path]
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const source = args.includes("--source") ? args[args.indexOf("--source") + 1] : path.join(here, "..", "metz-dungeon-stats.user.js");
const text = fs.readFileSync(source, "utf8");
const cut = (a, b) => text.slice(text.indexOf(a), text.indexOf(b));
const logTotals = new Function(`${cut("// <derive>", "// </derive>")}\nreturn logTotals;`)();
const deriveMoney = new Function(`${cut("// <money>", "// </money>")}\nreturn deriveMoney;`)();

const CHEST = "/items/pirate_chest", REFINE = "/items/pirate_refinement_chest", ENTRY = "/items/pirate_entry_key", CHESTKEY = "/items/pirate_chest_key";
const DUNGEON = "/actions/combat/pirate_cove", CRAFT = "/actions/crafting/pirate_entry_key";
const C = { isDungeon: a => a === DUNGEON, isKeyCraft: a => a === CRAFT, isChest: h => h === CHEST || h === REFINE, isKey: h => h === ENTRY || h === CHESTKEY };

// ---- 1. logTotals
const d = {
    summary: { windowStart: 1000 },
    runs: [
        { result: "clear", endAt: 3000, chests: [{ item: CHEST, qty: 1 }] },   // inside a session the log covers: the log counts it
        { result: "clear", endAt: 7000, chests: [{ item: CHEST, qty: 2 }] },   // after the log's last reading: the record counts it
        { result: "clear", endAt: 1100, chests: null },                        // before the log's first reading of the running session: the record counts it
        { result: "fail", endAt: 7500, chests: null },
        { result: "clear", endAt: 900, chests: [{ item: CHEST, qty: 1 }] },    // before the record began
    ],
    offline: [{ from: 7600, to: 8000, chests: { [CHEST]: 4 } }, { from: 2100, to: 2500, chests: { [CHEST]: 9 } }],   // the second sits inside a covered session
};
const sessions = [
    { id: 1, action: DUNGEON, start: 2000, end: 5000, count: 10, drops: { [CHEST]: 13, [REFINE]: 13, "/items/pirate_token": 40 } },
    // Already running when the record began, read by the log at 1200: counts from that reading, exactly.
    { id: 2, action: DUNGEON, start: 500, end: 1900, count: 8, drops: { [CHEST]: 10 }, first: { at: 1200, count: 5, drops: { [CHEST]: 6 } } },
    // Already running when the record began and never read inside it: left to the record, and reported.
    { id: 3, action: DUNGEON, start: 100, end: 1500, count: 50, drops: { [CHEST]: 60 } },
    { id: 4, action: CRAFT, start: 6000, end: 6500, count: 100, drops: { [ENTRY]: 100, "/items/pirate_essence": 3 } },
    { id: 5, action: DUNGEON, start: 10, end: 900, count: 99, drops: { [CHEST]: 120 } },                      // over before the record began
    { id: 6, action: "/actions/combat/fly", start: 3000, end: 4000, count: 500, drops: { [CHEST]: 1 } },       // not a dungeon
];
const crafts = [{ at: 6200, outputs: [{ item: ENTRY, qty: 7 }] }, { at: 9000, outputs: [{ item: ENTRY, qty: 5 }] }];
const T = logTotals(sessions, d, { ...C, crafts });
assert.equal(T.read, true);
assert.equal(T.sessions, 2);
assert.equal(T.uncovered, 1);
assert.equal(T.lastEnd, 6500);
assert.deepEqual(T.log, { clears: 13, chests: { [CHEST]: 17, [REFINE]: 13 }, crafted: { [ENTRY]: 100 } });
assert.deepEqual(T.own, { clears: 2, chests: { [CHEST]: 6 }, crafted: { [ENTRY]: 5 } });
assert.deepEqual(T.total, { clears: 15, chests: { [CHEST]: 23, [REFINE]: 13 }, crafted: { [ENTRY]: 105 } });

// With no log at all, the record's own events are the count, and it says the log was not read.
const none = logTotals([], d, { ...C, crafts });
assert.equal(none.read, false);
assert.deepEqual(none.total, { clears: 3, chests: { [CHEST]: 16 }, crafted: { [ENTRY]: 12 } });

// ---- 2. deriveMoney: entry keys and crafts by the game's count
const stub = base => new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => null) });
const X = extra => stub({ recordStart: 0, reviewPct: 0.5, consumeTotals: new Map(), keyRecipes: {}, isKey: h => h === ENTRY || h === CHESTKEY, isEntryKey: h => h === ENTRY, isRealKey: h => h === ENTRY || h === CHESTKEY,
    isChest: h => h === CHEST || h === REFINE, isDungeonChest: h => h === CHEST || h === REFINE, isCounted: () => false, isConsumable: () => false, isToken: () => false, isOpenable: () => false, isDungeonLoot: () => false, isTradable: () => true,
    tokenShop: () => [], heldKeys: () => [ENTRY], held: () => 0, listed: () => 0, keyOf: z => (z === DUNGEON ? ENTRY : null), keyAvg: h => (h === ENTRY ? 1000 : null), ...extra });
const timeline = [
    { id: "b", kind: "baseline", at: 1, items: [], keys: [{ item: ENTRY, qty: 500, unitCost: 900 }], chests: [] },
    { id: "k", kind: "craft", at: 5, action: CRAFT, outputs: [{ item: ENTRY, qty: 20 }], inputs: [], unitCost: 1000 },
    { id: "c1", kind: "clear", at: 10, zone: DUNGEON, chests: [{ item: CHEST, qty: 2 }], keysCharged: 2, keyCost: { unitCost: 800, basis: "lot" } },
    { id: "c2", kind: "clear", at: 20, zone: DUNGEON, chests: [{ item: CHEST, qty: 1 }], keysCharged: 1, keyCost: { unitCost: 800, basis: "lot" } },
];
const plain = deriveMoney(timeline, X({})).keys[ENTRY];
assert.equal(plain.used, 3);
assert.equal(plain.crafted, 20);
assert.equal(plain.usedByLog, false);
assert.equal(plain.craftedByLog, false);

const byLog = deriveMoney(timeline, X({ logKeys: () => ({ [ENTRY]: 40 }), logCrafted: () => ({ [ENTRY]: 300 }) })).keys[ENTRY];
assert.equal(byLog.used, 40, "the game's count of chests is the keys that went");
assert.equal(byLog.usedByLog, true);
assert.equal(byLog.usedWatched, 3);
assert.equal(byLog.usedExact, 3, "what this record watched keeps its lot cost");
assert.equal(byLog.usedFallback, 37, "the rest is priced like any unwatched use");
assert.equal(byLog.usedCost, 3 * 800 + 37 * 1000);
assert.equal(byLog.crafted, 300);
assert.equal(byLog.craftedByLog, true);
assert.equal(byLog.craftedWatched, 20);

// A log that has seen less than this record did never lowers what the record watched.
const behind = deriveMoney(timeline, X({ logKeys: () => ({ [ENTRY]: 2 }), logCrafted: () => ({ [ENTRY]: 5 }) })).keys[ENTRY];
assert.equal(behind.used, 3);
assert.equal(behind.usedByLog, false);
assert.equal(behind.crafted, 20);
assert.equal(behind.craftedByLog, false);
console.log("ok: logTotals covers, splits and reports; the Keys table follows the game's count");
