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
assert.deepEqual(info["/abilities/maim"], { heal: false, drain: false, dot: true, cost: 0, buffs: [] });
assert.deepEqual(info["/abilities/life_drain"], { heal: false, drain: true, dot: false, cost: 0, buffs: [] });
assert.deepEqual(info["/abilities/heal"], { heal: true, drain: false, dot: false, cost: 0, buffs: [] });

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
assert.equal(mage.takenHits.Imp, 1); assert.equal(mage.healHits.regen, 1); assert.equal(mage.healHits["Healer: /abilities/heal"], 1); assert.equal(mage.healHits["/abilities/life_drain"], 1, "Life Drain's heal counted once");
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
assert.equal(s.combatMs, 11000 + 1000, "wave 1 from its start to wave 2's start (no pause between waves), wave 2 to its last message");
assert.equal(meter.snapshot(12500).combatMs, 12500, "live: up to now while messages keep coming");
assert.equal(meter.snapshot(40000).combatMs, 12000, "no message for 15 s: the clock stops at the last one");

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

// An attack that takes no HP (a splat, HP unchanged, the monster acting) is a miss against the player.
meter.update(upd(8, { 0: { cHP: 1000, dmgCounter: 1 } }, { 0: { cHP: 500, atkCounter: 1 } }), 22500);
assert.equal(meter.session.players.Mage.takenMiss.Imp, 1);
// Deaths: HP to 0 counts once.
meter.update(upd(8, { 2: { cHP: 0, dmgCounter: 1 } }, { 0: { cHP: 500, atkCounter: 2 } }), 23000);
meter.update(upd(8, { 2: { cHP: 0 } }, {}), 23500);
assert.equal(meter.session.players.Healer.deaths, 1);

// A session saved and restored (a page reload) carries on with the same battle.
const saved = JSON.parse(JSON.stringify(meter.snapshot()));
const again = createMeter({ ability: h => info[h] || null });
again.restore(saved);
assert.equal(again.newBattle(wave(8, 3, [monster("Imp", 500)]), 30000), null, "same battle id: no new session");
assert.equal(again.session.waves, 3);
// Stitching: a piece kept by an earlier page joins the session in progress when it comes before it.
const late = createMeter({ ability: h => info[h] || null });
late.newBattle(wave(9, 4, [monster("Imp", 500)]), 50000);
late.update(upd(9, { 0: { cHP: 1000, atkCounter: 1 } }, { 0: { cHP: 0, dmgCounter: 1 } }), 51000);
const piece = { battleId: 9, startAt: 40000, lastAt: 48000, firstWave: 1, lastWave: 3, waves: 3, combatMs: 8000, monsterHpLost: 900, monsterHealed: 0, unassigned: 0, check: { waves: 2, balanced: 2, gap: 0 }, zone: "/actions/combat/x", tier: 1,
    players: { Mage: { name: "Mage", dealt: 900, hits: 3, misses: 0, casts: 3, taken: 0, healed: 0, healDone: 0, deaths: 0, abilities: { "/abilities/water_strike": { dmg: 900, hits: 3, misses: 0, casts: 3, heal: 0 } }, takenBy: {}, healBy: {} } } };
assert.equal(late.stitch({ ...piece, battleId: 10 }), false, "another battle");
assert.equal(late.stitch({ ...piece, lastWave: 4 }), false, "overlapping waves");
assert.equal(late.stitch(JSON.parse(JSON.stringify(piece))), true);
const st = late.snapshot();
assert.equal(st.firstWave, 1); assert.equal(st.waves, 4); assert.equal(st.startAt, 40000); assert.equal(st.zone, "/actions/combat/x"); assert.equal(st.stitched, 1);
assert.equal(st.players.Mage.dealt, 1400); assert.equal(st.players.Mage.abilities["/abilities/water_strike"].dmg, 1400, "the prepared Water Strike again on the late page");
// Bloom: a cast (not an auto) by a player with the bloom stat heals the lowest-HP ally; credited to the caster.
const bl = createMeter({ ability: h => info[h] || null });
bl.newBattle({ type: "new_battle", battleId: 20, wave: 1, players: [player("Druid", 1, 1000, "/abilities/water_strike", { bloom: 0.38 }), player("Tank", 2, 2000, ""), player("Mage", 3, 1000, "/abilities/water_strike")], monsters: [monster("Imp", 5000)] }, 0);
bl.update(upd(20, { 1: { cHP: 1500 }, 2: { cHP: 600 } }, {}), 500); // both hurt (no actor: not credited to anyone)
bl.update(upd(20, { 0: { cHP: 1000, atkCounter: 1, isAutoAtk: true }, 1: { cHP: 1600 }, 2: { cHP: 700 } }, { 0: { cHP: 4800, dmgCounter: 1 } }), 1000); // the Druid's cast: Mage (60%) is lowest -> Bloom; Tank -> regen
bl.update(upd(20, { 0: { cHP: 1000, atkCounter: 2 }, 2: { cHP: 800 } }, { 0: { cHP: 4700, dmgCounter: 2 } }), 2000); // an auto: no Bloom
const bs = bl.snapshot();
assert.equal(bs.players.Druid.healDone, 100); assert.equal(bs.players.Druid.abilities.bloom.heal, 100); assert.equal(bs.players.Druid.abilities.bloom.hits, 1);
assert.equal(bs.players.Mage.healBy["Druid: bloom"], 100); assert.equal(bs.players.Mage.healBy.regen, 100, "the gain during the auto is not Bloom");
assert.equal(bs.players.Tank.healBy.regen, 100, "the second gain in the cast's message is not Bloom");
// Life steal and mana leech: verified by the stat, the player acting, and the gain within damage x stat.
{
    const m3 = createMeter({ ability: h => info[h] || null });
    const thief = { ...player("Thief", 9, 1000, "", { lifeSteal: 0.02, manaLeech: 0.02 }), currentHitpoints: 800, currentManapoints: 100, maxManapoints: 500 };
    const plain = { ...player("Plain", 8, 1000, ""), currentHitpoints: 800 };
    m3.newBattle({ type: "new_battle", battleId: 9, wave: 1, players: [thief, plain], monsters: [monster("Imp", 5000)] }, 0);
    m3.update(upd(9, { 0: { cHP: 820, cMP: 120, atkCounter: 1, isAutoAtk: true } }, { 0: { cHP: 4000, dmgCounter: 1 } }), 1000);   // 1,000 damage, +20 HP, +20 MP
    m3.update(upd(9, { 0: { cHP: 920, atkCounter: 2, isAutoAtk: true } }, { 0: { cHP: 3900, dmgCounter: 2 } }), 2000);              // 100 damage, +100 HP: too much to be life steal
    m3.update(upd(9, { 1: { cHP: 830, atkCounter: 1, isAutoAtk: true } }, { 0: { cHP: 2900, dmgCounter: 3 } }), 3000);              // no stat: not life steal
    const s3 = m3.close();
    assert.deepEqual(s3.players.Thief.healSub.regen, { lifesteal: { amt: 20, hits: 0, misses: 0, n: 1 }, other: { amt: 100, hits: 0, misses: 0, n: 1 } });
    assert.deepEqual(s3.players.Thief.mana.gain, { leech: { amt: 20, n: 1 } });
    assert.deepEqual(Object.keys(s3.players.Plain.healSub.regen), ["other"]);
}
// Vampirism: the cast gives life steal for its duration; a gain on the caster's own hit inside it is life steal.
{
    const vinfo = meterAbilityInfo({ abilityEffects: [{ effectType: "/ability_effect_types/buff", buffs: [{ typeHrid: "/buff_types/life_steal", flatBoost: 0.08, flatBoostLevelBonus: 0.0008, duration: 20e9 }] }] });
    assert.deepEqual(vinfo.lifeSteal, { flat: 0.08, perLevel: 0.0008, ms: 20000 });
    const m4 = createMeter({ ability: h => (h === "/abilities/vampirism" ? vinfo : null) });
    const v = { ...player("Vamp", 7, 1000, "/abilities/vampirism"), currentHitpoints: 500, combatAbilities: [{ abilityHrid: "/abilities/vampirism", level: 50 }] };
    m4.newBattle({ type: "new_battle", battleId: 4, wave: 1, players: [v], monsters: [monster("Imp", 9000)] }, 0);
    m4.update(upd(4, { 0: { atkCounter: 1, isAutoAtk: true } }, {}), 1000);                                                  // casts Vampirism
    m4.update(upd(4, { 0: { cHP: 560, atkCounter: 2, isAutoAtk: true } }, { 0: { cHP: 8500, dmgCounter: 1 } }), 5000);     // 500 damage x 0.12 = 60
    m4.update(upd(4, { 0: { cHP: 620, atkCounter: 3, isAutoAtk: true } }, { 0: { cHP: 8000, dmgCounter: 2 } }), 30000);    // after the buff ran out
    const s4 = m4.close();
    assert.deepEqual(s4.players.Vamp.healSub.regen, { lifesteal: { amt: 60, hits: 0, misses: 0, n: 1 }, other: { amt: 60, hits: 0, misses: 0, n: 1 } });
}
console.log("meter: rules ok");

// Deaths, time down, time out of mana, buff uptime and wave times.
{
    const T0 = Date.parse("2026-11-23T09:00:00Z");
    const inf = { "/abilities/berserk": meterAbilityInfo({ manaCost: 65, abilityEffects: [{ targetType: "self", effectType: "/ability_effect_types/buff", buffs: [{ uniqueHrid: "/buff_uniques/berserk", duration: 20e9 }] }] }),
        "/abilities/aura": meterAbilityInfo({ manaCost: 100, abilityEffects: [{ targetType: "allAllies", effectType: "/ability_effect_types/buff", buffs: [{ uniqueHrid: "/buff_uniques/aura", duration: 120e9 }] }] }),
        "/abilities/pollen": meterAbilityInfo({ manaCost: 45, abilityEffects: [{ targetType: "allEnemies", effectType: "/ability_effect_types/damage", buffs: [{ uniqueHrid: "/buff_uniques/pollen", duration: 10e9 }] }] }) };
    assert.deepEqual(inf["/abilities/aura"].buffs.map(b => [b.u, b.ms, b.to]), [["/buff_uniques/aura", 120000, "allies"]]);
    assert.equal(inf["/abilities/berserk"].cost, 65);
    const pl = (name, id, hp, mp, prep, abilities, buffs = {}) => ({ ...player(name, id, hp, prep), currentManapoints: mp, maxManapoints: 1000, combatAbilities: abilities.map(h => ({ abilityHrid: h, level: 1 })), combatBuffMap: buffs });
    const w = (n, at, extra = {}) => ({ type: "new_battle", battleId: 9, wave: n, players: [pl("A", 1, 1000, extra.mpA ?? 500, "/abilities/berserk", ["/abilities/berserk", "/abilities/pollen"], extra.buffsA), pl("B", 2, extra.hpB ?? 800, 500, "/abilities/aura", ["/abilities/aura"])], monsters: [monster("Imp", 5000)] });
    const m3 = createMeter({ ability: h => inf[h] || null });
    // Wave 1: a coffee already running for 5 s when the wave starts counts from the session's start only.
    m3.newBattle(w(1, T0, { buffsA: { c: { uniqueHrid: "/buff_uniques/attack_coffee", startTime: new Date(T0 - 5000).toISOString(), duration: 300e9 } } }), T0);
    m3.update(upd(9, { 0: { cHP: 1000, cMP: 435, atkCounter: 1, abilityHrid: "/abilities/pollen" } }, {}), T0 + 1000);          // A casts Berserk: 20 s on A
    m3.update(upd(9, { 1: { cHP: 800, cMP: 400, atkCounter: 1, isAutoAtk: true } }, {}), T0 + 2000);                            // B casts the aura: 120 s on both
    m3.update(upd(9, { 0: { cHP: 1000, cMP: 390, atkCounter: 2, isAutoAtk: true } }, { 0: { cHP: 4000, dmgCounter: 1 } }), T0 + 3000); // A's pollen hits: a debuff applied
    // The imp hits B twice, the second kills; B is down until healed 6 s later.
    m3.update(upd(9, { 1: { cHP: 300, dmgCounter: 1 } }, { 0: { cHP: 4000, atkCounter: 1 } }), T0 + 4000);
    m3.update(upd(9, { 1: { cHP: 0, dmgCounter: 2 } }, { 0: { cHP: 4000, atkCounter: 2 } }), T0 + 5000);
    m3.update(upd(9, { 1: { cHP: 400 } }, {}), T0 + 11000);
    // A drops below the cheapest ability's cost (45 MP) for 4 s, then is back above it.
    m3.update(upd(9, { 0: { cHP: 1000, cMP: 40 } }, {}), T0 + 12000);
    m3.update(upd(9, { 0: { cHP: 1000, cMP: 200 } }, {}), T0 + 16000);
    m3.newBattle(w(2, T0 + 30000), T0 + 30000);
    const s3 = m3.snapshot(T0 + 30000), A = s3.players.A, B = s3.players.B;
    assert.equal(B.deaths, 1); assert.equal(B.deadMs, 6000);
    assert.deepEqual({ wave: B.deathLog[0].wave, by: B.deathLog[0].by, how: B.deathLog[0].how, dmg: B.deathLog[0].dmg, hpBefore: B.deathLog[0].hpBefore, downMs: B.deathLog[0].downMs }, { wave: 1, by: "Imp", how: "auto", dmg: 300, hpBefore: 300, downMs: 6000 });
    assert.deepEqual(B.deathLog[0].recent.map(x => [x.ago, x.dmg]), [[1000, 500], [0, 300]], "the hits of the 10 s before, the killing one last");
    assert.equal(A.oomMs, 4000); assert.equal(B.oomMs, 0);
    assert.deepEqual(A.buffs["/buff_uniques/berserk"], { ms: 20000, until: T0 + 21000 });
    assert.equal(A.buffs["/buff_uniques/aura"].ms, 120000); assert.equal(B.buffs["/buff_uniques/aura"].ms, 120000, "a party buff is on every living player");
    assert.deepEqual(A.buffs["/buff_uniques/attack_coffee"], { ms: 295000, until: T0 + 295000 }, "clipped to the session's start");
    assert.deepEqual(A.debuffs["/buff_uniques/pollen"], { ms: 10000, until: T0 + 13000 });
    assert.deepEqual(s3.waveT, { 1: { ms: 30000, n: 1, mon: "Imp" } });
    console.log("deaths, time down, out of mana, buff windows and wave times check out");
}

const capture = arg("--capture");
if (capture) {
    const gd = JSON.parse(fs.readFileSync(arg("--game-data") || path.join(here, "..", "..", "rust_combat_Metz", "dist", "zone-site", "init_client_data.json"), "utf8")).abilityDetailMap;
    const m2 = createMeter({ ability: h => (gd[h] ? meterAbilityInfo(gd[h]) : null) }), out = [];
    for (const [t, m] of JSON.parse(fs.readFileSync(capture, "utf8")).rows) { if (m.type === "new_battle") { const c = m2.newBattle(m, t); if (c) out.push(c); } else if (m.type === "battle_updated") m2.update(m, t); }
    out.push(m2.close());
    // A reload in the middle of wave 30 of the first whole run: the old page's piece, then a new page from wave 31.
    const rows = JSON.parse(fs.readFileSync(capture, "utf8")).rows;
    const first = out.find(x => x.firstWave === 1 && x.lastWave >= 65);
    if (first) {
        const before = createMeter({ ability: h => (gd[h] ? meterAbilityInfo(gd[h]) : null) }), after = createMeter({ ability: h => (gd[h] ? meterAbilityInfo(gd[h]) : null) });
        let phase = 0, kept = null, inWave30 = 0;
        for (const [t, m] of rows) {
            if (m.battleId !== first.battleId) continue;
            if (phase === 0) { if (m.type === "new_battle") before.newBattle(m, t); else if (m.type === "battle_updated") { before.update(m, t); if (before.snapshot().lastWave === 30 && ++inWave30 === 20) { kept = JSON.parse(JSON.stringify(before.snapshot())); phase = 1; } } }
            else if (phase === 1) { if (m.type === "new_battle" && m.wave === 31) { after.newBattle(m, t); assert.equal(after.stitch(kept), true); phase = 2; } }
            else if (m.type === "new_battle") after.newBattle(m, t); else if (m.type === "battle_updated") after.update(m, t);
        }
        const whole = after.close(undefined, true);
        assert.equal(whole.firstWave, 1); assert.equal(whole.waves, whole.lastWave, "no wave missing after the stitch");
        const lost = first.monsterHpLost - whole.monsterHpLost;
        assert.ok(lost > 0 && lost < first.monsterHpLost * 0.02, "only the rest of wave 30 is missing");
        assert.equal(whole.check.balanced, whole.check.waves - 0, "every wave counted as finished still checks out");
        console.log(`capture stitch: waves 1-${whole.lastWave} whole after a reload in wave 30, ${lost} HP of wave 30 not seen, ${whole.check.balanced}/${whole.check.waves} waves checked`);
    }
    for (const x of out) {
        const credited = Object.values(x.players).reduce((a, p) => a + p.dealt, 0);
        assert.equal(credited, x.monsterHpLost, `battle ${x.battleId}: every HP lost credited`);
        assert.equal(x.check.balanced, x.check.waves, `battle ${x.battleId}: every finished wave checks out`);
        console.log(`capture battle ${x.battleId}: waves ${x.firstWave}-${x.lastWave}, ${credited} HP credited, ${x.check.balanced}/${x.check.waves} waves checked`);
    }
}
