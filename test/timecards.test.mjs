// The time cards (In dungeons, Between runs, Unaccounted) fed from the game's Loot & XP Log: derive() over a synthetic
// record. The block is cut out of the userscript, so this exercises the shipped code.
//   node test/timecards.test.mjs [--source path]
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const source = args.includes("--source") ? args[args.indexOf("--source") + 1] : path.join(here, "..", "metz-dungeon-stats.user.js");
const text = fs.readFileSync(source, "utf8");
const derive = new Function(`${text.slice(text.indexOf("// <derive>"), text.indexOf("// </derive>"))}\nreturn derive;`)();

const H = 3600e3, MIN = 60e3, DUNGEON = "/actions/combat/pirate_cove", CRAFT = "/actions/crafting/pirate_entry_key", PLANET = "/actions/combat/fly";
// The record begins at hour 5. A run is seen starting at hour 10 and then nothing: the script was not watching for
// two days. At hour 60 it watches one run through, 13 minutes. Now is hour 61.
const events = [
    { id: "s1", kind: "start", at: 10 * H, zone: DUNGEON, tier: 2, battleId: 1, runId: "r1", party: ["A"] },
    { id: "s2", kind: "start", at: 60 * H, zone: DUNGEON, tier: 2, battleId: 2, runId: "r2", party: ["A"] },
    { id: "c2", kind: "clear", at: 60 * H + 13 * MIN, zone: DUNGEON, tier: 2, battleId: 2, runId: "r2", chests: [], keysCharged: 1 },
];
const cfg = { selfName: "A", recordStart: 5 * H, isDungeon: a => a === DUNGEON, isKeyCraft: a => a === CRAFT };
const now = 61 * H;

// Without the log, everything after the lone start is unaccounted, as it was.
const plain = derive(events, now, cfg).summary;
assert.equal(plain.dungeonMs, 13 * MIN);
assert.equal(plain.dungeonLogMs, 0);
assert.equal(plain.unknownMs, 50 * H + 47 * MIN, "hour 10 to hour 60, and from the clear to now");
assert.equal(plain.betweenMs, 5 * H, "record start to the first start");

// With it: a dungeon session from hour 9 to hour 40, key crafting to hour 41, a planet to hour 45; nothing after.
const logSessions = [
    { id: 1, action: DUNGEON, start: 9 * H, end: 40 * H, count: 138 },
    { id: 2, action: CRAFT, start: 40 * H, end: 41 * H, count: 200 },
    { id: 3, action: PLANET, start: 41 * H, end: 45 * H, count: 900 },
    { id: 4, action: DUNGEON, start: 1 * H, end: 4 * H, count: 13 },                 // over before the record began
    { id: 5, action: DUNGEON, start: 60 * H, end: 60 * H + 13 * MIN, count: 1 },     // the run this record watched
];
const S = derive(events, now, { ...cfg, logSessions }).summary;
assert.equal(S.dungeonMs, 31 * H + 13 * MIN, "the log's 31 hours and the watched run, counted once");
assert.equal(S.dungeonWatchedMs, 13 * MIN);
assert.equal(S.dungeonLogMs, 31 * H);
assert.equal(S.unknownMs, 15 * H + 47 * MIN, "hour 45 to hour 60 and the last 47 minutes: no run end and no log session");
assert.equal(S.betweenMs, 9 * H, "hours 5 to 9, and hours 40 to 45");
assert.equal(S.craftingMs, 1 * H, "the key craft session");
assert.equal(S.otherMs, 8 * H);
assert.equal(S.dungeonMs + S.unknownMs + S.betweenMs, S.totalMs, "the three cards add up to the record's span");

// A session the game still reports as running ends at its last read; the record's own run covers what follows.
const running = derive(events, now, { ...cfg, logSessions: [{ id: 6, action: DUNGEON, start: 9 * H, end: 60 * H + 5 * MIN, count: 220 }] }).summary;
assert.equal(running.dungeonMs, 51 * H + 13 * MIN);
assert.equal(running.unknownMs, 47 * MIN);
console.log("ok: log sessions fill the time cards; only time with no run end and no log session stays unaccounted");
