// The damage meter (0.2.0): createMeter over synthetic battle messages shaped like the game's, one rule at a time.
// The block is cut out of the userscript, so this exercises the shipped code. With --capture, a capture made with the
// capture command (rows of [ms, message]) is replayed too and every finished wave must check out.
//   node test/meter.test.mjs [--source path] [--capture path]
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = k => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const text = fs.readFileSync(arg("--source") || path.join(here, "..", "metz-dungeon-stats.user.js"), "utf8");
const { createMeter, meterAbilityInfo } = new Function(`${text.slice(text.indexOf("// <meter>"), text.indexOf("// </meter>"))}\nreturn { createMeter, meterAbilityInfo };`)();

const ABILITIES = {
    "/abilities/water_strike": { abilityEffects: [{ effectType: "/ability_effect_types/damage" }] },
    "/abilities/maim": { abilityEffects: [{ effectType: "/ability_effect_types/damage", damageOverTimeRatio: 1 }] },
    "/abilities/life_drain": { abilityEffects: [{ effectType: "/ability_effect_types/damage", hpDrainRatio: 0.08 }] },
    "/abilities/heal": { abilityEffects: [{ effectType: "/ability_effect_types/heal" }] },
    "/abilities/natures_veil": { abilityEffects: [{ effectType: "/ability_effect_types/damage", blindChance: 0.5 }] },
};
const info = Object.fromEntries(Object.entries(ABILITIES).map(([h, d]) => [h, meterAbilityInfo(d)]));
assert.deepEqual(info["/abilities/maim"], { heal: false, drain: false, dot: true });
assert.deepEqual(info["/abilities/life_drain"], { heal: false, drain: true, dot: false });
assert.deepEqual(info["/abilities/heal"], { heal: true, drain: false, dot: false });

const player = (name, id, hp, prep, extra = {}) => ({ isPlayer: true, character: { id, name }, name, currentHitpoints: hp, maxHitpoints: hp, attackAttemptCounter: 0, damageSplatCounter: 0, preparingAbilityHrid: prep || "", isPreparingAutoAttack: !prep, combatDetails: { combatStats: extra } });
const monster = (name, hp) => ({ isPlayer: false, hrid: `/monsters/${name.toLowerCase()}`, name, currentHitpoints: hp, maxHitpoints: hp, attackAttemptCounter: 0, damageSplatCounter: 0, preparingAbilityHrid: "", isPreparingAutoAttack: true });
const wave = (battleId, n, monsters) => ({ type: "new_battle", battleId, wave: n, players: [player("Mage", 1, 1000, "/abilities/water_strike"), player("Tank", 2, 2000, "", { parry: 0.08 }), player("Healer", 3, 900, "/abilities/heal")], monsters });
const upd = (battleId, pMap, mMap) => ({ type: "battle_updated", battleId, pMap, mMap });

const meter = createMeter({ ability: h => info[h] || null });
meter.newBattle(wave(7, 1, [monster("Imp", 500), monster("Golem", 800)]), 0);
// The mage casts Water Strike (the ability the card showed BEFORE this message); the card now shows the next one.
meter.update(upd(7, { 0: { cHP: 1000, atkCounter: 1, abilityHrid: "/abilities/life_drain" } }, { 0: { cHP: 200, dmgCounter: 1 } }), 1000);
// The tank's auto attack misses the golem: a splat with no HP lost.
meter.update(upd(7, { 1: { cHP: 2000, atkCounter: 1, isAutoAtk: true } }, { 1: { cHP: 800, dmgCounter: 1 } }), 2000);
// The golem attacks the tank, who parries: the golem loses HP, the tank listed with no HP change.
meter.update(upd(7, { 1: { cHP: 2000 } }, { 1: { cHP: 700, atkCounter: 1, dmgCounter: 2 } }), 3000);
// A Nature's Veil style hit (the mage's Life Drain here): the imp's counter moves as its blind lands. The imp did not act.
meter.update(upd(7, { 0: { cHP: 1000, atkCounter: 2, abilityHrid: "/abilities/life_drain" } }, { 0: { cHP: 100, atkCounter: 1, dmgCounter: 2, isBlinded: true } }), 4000);
// The tank's Maim (prepared before), then its bleed with nobody acting, the tank listed.
meter.update(upd(7, { 1: { cHP: 2000, atkCounter: 2, abilityHrid: "/abilities/maim" } }, {}), 4500); // card now shows Maim
meter.update(upd(7, { 1: { cHP: 2000, atkCounter: 3, isAutoAtk: true } }, { 1: { cHP: 600, dmgCounter: 3 } }), 5000); // Maim lands
meter.update(upd(7, { 1: { cHP: 2000 } }, { 1: { cHP: 550, dmgCounter: 4 } }), 6000); // bleed tick
// The imp hits the mage for 300; the healer heals the mage for 250; everyone regenerates 10 with nobody acting.
meter.update(upd(7, { 0: { cHP: 700, dmgCounter: 1 } }, { 0: { cHP: 100, atkCounter: 2 } }), 7000);
meter.update(upd(7, { 0: { cHP: 950 }, 2: { cHP: 900, atkCounter: 1, abilityHrid: "/abilities/heal" } }, {}), 8000);
meter.update(upd(7, { 0: { cHP: 960 }, 1: { cHP: 2000 }, 2: { cHP: 900 } }, {}), 9000);
// The mage kills both (Life Drain was prepared, so this is Life Drain, and the mage drains 40).
meter.update(upd(7, { 0: { cHP: 1000, atkCounter: 3, abilityHrid: "/abilities/water_strike" } }, { 0: { cHP: 0, dmgCounter: 3 }, 1: { cHP: 0, dmgCounter: 5 } }), 10000);

let s = meter.snapshot();
const mage = s.players.Mage, tank = s.players.Tank, healer = s.players.Healer;
assert.equal(mage.abilities["/abilities/water_strike"].dmg, 300, "the first cast was the Water Strike prepared at the start");
assert.equal(mage.abilities["/abilities/life_drain"].dmg, 100 + 100 + 550, "then Life Drain twice, the second killing both");
assert.equal(mage.abilities["/abilities/life_drain"].casts, 2);
assert.equal(mage.abilities["/abilities/life_drain"].heal, 40, "Life Drain heals its caster");
assert.equal(mage.healBy.regen, 10);
assert.equal(mage.healBy["Healer: /abilities/heal"], 250);
assert.equal(healer.healDone, 250);
assert.equal(mage.taken, 300); assert.equal(mage.takenBy.Imp, 300, "the imp's attack, though its counter moved earlier with the blind");
assert.equal(tank.abilities.auto.misses, 1);
assert.equal(tank.abilities.parry.dmg, 100, "the golem's loss while it attacked the tank");
assert.equal(tank.abilities["/abilities/maim"].dmg, 100);
assert.equal(tank.abilities["dot:/abilities/maim"].dmg, 50, "the bleed goes on Maim");
assert.equal(s.unassigned, 0);
assert.equal(mage.dealt + tank.dealt + healer.dealt, 1300, "every HP the monsters had");
assert.equal(s.check.waves, 0, "the wave has not finished yet");

// The next wave of the same battle: the first one is checked (both monsters at 0, every point credited).
meter.newBattle(wave(7, 2, [monster("Imp", 500)]), 11000);
meter.update(upd(7, { 0: { cHP: 1000, atkCounter: 1 } }, { 0: { cHP: 0, dmgCounter: 1 } }), 12000);
s = meter.snapshot();
assert.deepEqual(s.check, { waves: 1, balanced: 1, gap: 0 });
assert.equal(s.waves, 2);
assert.equal(s.combatMs, 10000 + 1000, "wave 1 from its start to its last hit, wave 2 so far");

// A new battle id closes the session; a cleared session counts its last wave.
meter.session.result = "clear";
const closed = meter.newBattle(wave(8, 1, [monster("Imp", 500)]), 20000);
assert.equal(closed.battleId, 7); assert.equal(closed.result, "clear");
assert.deepEqual(closed.check, { waves: 2, balanced: 2, gap: 0 });
assert.equal(meter.session.battleId, 8);

// A wave with a missed message: a monster left with HP when the next wave starts fails the check.
meter.update(upd(8, { 0: { cHP: 1000, atkCounter: 1 } }, { 0: { cHP: 300, dmgCounter: 1 } }), 21000);
meter.newBattle(wave(8, 2, [monster("Imp", 500)]), 22000);
assert.deepEqual(meter.session.check, { waves: 1, balanced: 0, gap: 300 });

// Deaths: HP to 0 counts once.
meter.update(upd(8, { 2: { cHP: 0, dmgCounter: 1 } }, { 0: { cHP: 500, atkCounter: 1 } }), 23000);
meter.update(upd(8, { 2: { cHP: 0 } }, {}), 23500);
assert.equal(meter.session.players.Healer.deaths, 1);

// A session saved and restored (a page reload) carries on with the same battle.
const saved = JSON.parse(JSON.stringify(meter.snapshot()));
const again = createMeter({ ability: h => info[h] || null });
again.restore(saved);
assert.equal(again.newBattle(wave(8, 3, [monster("Imp", 500)]), 30000), null, "same battle id: no new session");
assert.equal(again.session.waves, 3);
console.log("meter: rules ok");

const capture = arg("--capture");
if (capture) {
    const gd = JSON.parse(fs.readFileSync(arg("--game-data") || path.join(here, "..", "..", "rust_combat_Metz", "dist", "zone-site", "init_client_data.json"), "utf8")).abilityDetailMap;
    const m2 = createMeter({ ability: h => (gd[h] ? meterAbilityInfo(gd[h]) : null) }), out = [];
    for (const [t, m] of JSON.parse(fs.readFileSync(capture, "utf8")).rows) { if (m.type === "new_battle") { const c = m2.newBattle(m, t); if (c) out.push(c); } else if (m.type === "battle_updated") m2.update(m, t); }
    out.push(m2.close());
    for (const x of out) {
        const credited = Object.values(x.players).reduce((a, p) => a + p.dealt, 0);
        assert.equal(credited, x.monsterHpLost, `battle ${x.battleId}: every HP lost credited`);
        assert.equal(x.check.balanced, x.check.waves, `battle ${x.battleId}: every finished wave checks out`);
        console.log(`capture battle ${x.battleId}: waves ${x.firstWave}-${x.lastWave}, ${credited} HP credited, ${x.check.balanced}/${x.check.waves} waves checked`);
    }
}
