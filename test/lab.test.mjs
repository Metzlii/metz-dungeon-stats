// The talisman lab (test server only): createLab over synthetic battle messages shaped like the game's. The block is
// cut out of the userscript, so this exercises the shipped code.
//   node test/lab.test.mjs [--source path]
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = k => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const text = fs.readFileSync(arg("--source") || path.join(here, "..", "metz-dungeon-stats.user.js"), "utf8");
const { createLab } = new Function(`${text.slice(text.indexOf("// <lab>"), text.indexOf("// </lab>"))}\nreturn { createLab };`)();

const player = (name, hp, prep) => ({ character: { id: 1, name }, currentHitpoints: hp, maxHitpoints: hp, attackAttemptCounter: 0, damageSplatCounter: 0, criticalDamageSplatCounter: 0, preparingAbilityHrid: prep || "", isPreparingAutoAttack: !prep, combatDetails: { totalArmor: 30, combatStats: { armor: 6 } } });
const monster = (name, hp) => ({ hrid: `/monsters/${name}`, name, currentHitpoints: hp, maxHitpoints: hp, attackAttemptCounter: 0, damageSplatCounter: 0, criticalDamageSplatCounter: 0, isPreparingAutoAttack: true, combatDetails: { totalArmor: 10, combatStats: {} } });
const wave = (n, monsters) => ({ type: "new_battle", battleId: 7, wave: n, players: [player("Me", 1000, "/abilities/poke")], monsters });
const upd = (pMap, mMap) => ({ type: "battle_updated", battleId: 7, pMap, mMap });

const lab = createLab();
let at = 1000; const tick = ms => (at += ms);
lab.mark("with", at);
lab.newBattle(wave(1, [monster("rat", 100), monster("bear", 1000)]), at);

// Poke (named before the message) hits the rat for 60, a crit; the player prepares an auto attack next.
lab.update(upd({ 0: { atkCounter: 1, isAutoAtk: true } }, { 0: { cHP: 40, dmgCounter: 1, critCounter: 1 } }), tick(100));
// The auto attack misses: a damage number, no HP lost.
lab.update(upd({ 0: { atkCounter: 2, isAutoAtk: true } }, { 0: { dmgCounter: 2 } }), tick(100));
// The next one kills the rat (40 left): the size of that hit is not visible.
lab.update(upd({ 0: { atkCounter: 3, isAutoAtk: true } }, { 0: { cHP: 0, dmgCounter: 3 } }), tick(100));
// The first hit after a kill, on the bear, shown as two damage numbers.
lab.update(upd({ 0: { atkCounter: 4, isAutoAtk: true } }, { 1: { cHP: 900, dmgCounter: 2 } }), tick(100));
// And an ordinary one.
lab.update(upd({ 0: { atkCounter: 5, isAutoAtk: true } }, { 1: { cHP: 850, dmgCounter: 3 } }), tick(100));
// The bear hits back three times inside 5 s, then once more after 6 s.
lab.update(upd({ 0: { cHP: 900, dmgCounter: 1 } }, { 1: { atkCounter: 1 } }), tick(1000));
lab.update(upd({ 0: { cHP: 810, dmgCounter: 2 } }, { 1: { atkCounter: 2 } }), tick(1000));
lab.update(upd({ 0: { cHP: 730, dmgCounter: 3 } }, { 1: { atkCounter: 3 } }), tick(1000));
lab.update(upd({ 0: { cHP: 630, dmgCounter: 4 } }, { 1: { atkCounter: 4 } }), tick(6000));
// Damage with nobody acting, 200 ms after... nothing: kept as "other", never summarised.
lab.update(upd({}, { 1: { cHP: 840, dmgCounter: 4 } }), tick(200));
// Player and monster act in one message: also "other".
lab.update(upd({ 0: { atkCounter: 6, cHP: 600, isAutoAtk: true } }, { 1: { atkCounter: 5, cHP: 800, dmgCounter: 5 } }), tick(200));

const d = lab.dump(), rows = d.rows;
assert.deepEqual(rows.map(r => r.kind), ["hit", "hit", "hit", "hit", "hit", "taken", "taken", "taken", "taken", "other", "other", "other"]);
assert.deepEqual(rows[0], { at: 1100, wave: 1, kind: "hit", by: "Me", key: "/abilities/poke", on: "rat", hrid: "/monsters/rat", dmg: 60, miss: false, splats: 1, crits: 1, hpBefore: 100, mhp: 100, kill: false, afterKill: false, label: "with" });
assert.equal(rows[1].key, "auto"); assert.equal(rows[1].miss, true);
assert.equal(rows[2].kill, true); assert.equal(rows[2].dmg, 40);
assert.equal(rows[3].afterKill, true, "first hit after a kill"); assert.equal(rows[3].splats, 2);
assert.equal(rows[4].afterKill, false, "the stored damage is spent by the hit before");
assert.deepEqual(rows.slice(5, 9).map(r => [r.dmg, r.hitsBefore]), [[100, 0], [90, 1], [80, 2], [100, 0]], "hits in the 5 s before");
assert.equal(rows[9].actors, 0); assert.equal(rows[10].actors, 2);
// A stun landing on a monster moves its counter too: that is not the monster acting, so the hit still counts.
lab.update(upd({ 0: { atkCounter: 7, isAutoAtk: true } }, { 1: { atkCounter: 6, cHP: 760, dmgCounter: 6, isStunned: true } }), tick(200));
assert.equal(lab.dump().rows.at(-1).kind, "hit");

const s = lab.summary();
const g = k => s.groups.find(x => x.kind === k.kind && x.key === k.key && x.on === k.on);
assert.deepEqual(g({ kind: "hit", key: "/abilities/poke", on: "rat" }).crit, { n: 1, min: 60, max: 60, mean: 60 });
const autoRat = g({ kind: "hit", key: "auto", on: "rat" });
assert.equal(autoRat.misses, 1); assert.equal(autoRat.kills, 1); assert.equal(autoRat.plain, null, "a kill says nothing about the hit's size");
const autoBear = g({ kind: "hit", key: "auto", on: "bear" });
assert.equal(autoBear.multiSplat, 1); assert.deepEqual(autoBear.afterKill, { n: 1, min: 100, max: 100, mean: 100 }); assert.deepEqual(autoBear.notAfterKill, { n: 2, min: 40, max: 50, mean: 45 });
const taken = s.groups.find(x => x.kind === "taken");
assert.deepEqual(taken.byHitsBefore.map(x => x && x.mean), [100, 90, 80, null, null]);
assert.equal(s.other, 3);

// A new label starts a new stretch; rows keep the label they were made under. Cards are kept when they change.
lab.mark("without", tick(100));
lab.newBattle(wave(2, [monster("rat", 100)]), at);
lab.update(upd({ 0: { atkCounter: 1, isAutoAtk: true } }, { 0: { cHP: 70, dmgCounter: 1 } }), tick(100));
assert.equal(lab.dump().rows.at(-1).label, "without");
assert.deepEqual(lab.dump().labels.map(l => [l.label, l.to != null]), [["with", true], ["without", false]]);
assert.equal(lab.unitCard({ type: "battle_unit_fetched", unit: { name: "rat", combatDetails: { totalArmor: 12 } } }, at).totalArmor, 12);
assert.ok(lab.dump().cards.some(c => c.source === "clicked" && c.details.totalArmor === 12));
console.log("ok: the lab logs each hit with its ability, crit and damage numbers, the first hit after a kill, the hits in the 5 s before one taken, and keeps what it cannot attribute apart");
