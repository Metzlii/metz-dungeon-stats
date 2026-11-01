// Runs the script's deriveMoney() block over an exported record and prints what the Overview money cards and the
// Keys / Loot / Chests tabs would show.
//   node test/money.test.mjs [record.json] [--source path] [--market marketplace.json]
// An export carries no bag or listings, so held and listed quantities are zero here unless a --held file
// ({"/items/x": qty}) is given; the "no longer held" rows therefore show everything not sold.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const source = opt("--source") || path.join(here, "..", "metz-dungeon-stats.user.js");
const recordPath = args.find((a, i) => !a.startsWith("--") && !["--source", "--market", "--held"].includes(args[i - 1])) || path.join(here, "fixtures", "record-2026-11-01.json");
const text = fs.readFileSync(source, "utf8");
const block = text.slice(text.indexOf("// <money>"), text.indexOf("// </money>"));
if (!block.includes("function deriveMoney")) throw new Error("money block not found in " + source);
const deriveMoney = new Function(`${block}\nreturn deriveMoney;`)();
const rec = JSON.parse(fs.readFileSync(recordPath, "utf8"));
const recordStart = (rec.meta.find(m => m.key === "recordStart") || {}).value || 0;
const market = opt("--market") ? JSON.parse(fs.readFileSync(opt("--market"), "utf8")) : null;
const heldMap = opt("--held") ? JSON.parse(fs.readFileSync(opt("--held"), "utf8")) : {};
const px = h => { const l = market && market.marketData && market.marketData[h] && market.marketData[h]["0"]; return l || null; };
const chestItems = new Set(["/items/pirate_chest", "/items/pirate_refinement_chest"]);
const keyItems = new Set(["/items/pirate_entry_key", "/items/pirate_chest_key"]);
const consumables = new Set(rec.events.filter(e => e.kind === "consume").map(e => e.item).concat(((rec.events.find(e => e.kind === "baseline") || {}).items || []).filter(b => b.kind === "consumable").map(b => b.item)));
// What the live script keeps in memory: consume totals, the craft averages, the purchase ledger averages (approximated
// here from the baseline asks and the buys, since the export carries no ledger).
const consumeTotals = new Map();
for (const e of rec.events) if (e.kind === "consume") { const t = consumeTotals.get(e.item) || { qty: 0, cost: 0, unknownQty: 0 }; t.qty += e.qty; if (e.unitCost != null) t.cost += e.unitCost * e.qty; else t.unknownQty += e.qty; consumeTotals.set(e.item, t); }
const keyAvg = {}; for (const c of rec.events.filter(e => e.kind === "craft")) for (const o of c.outputs || []) if (c.unitCost != null) { const k = keyAvg[o.item] || (keyAvg[o.item] = { q: 0, c: 0 }); k.q += o.qty; k.c += o.qty * c.unitCost; }
const ledger = {}; for (const b of ((rec.events.find(e => e.kind === "baseline") || {}).items || [])) if (b.unitCost != null) ledger[b.item] = { q: b.qty, c: b.qty * b.unitCost };
for (const b of rec.events.filter(e => e.kind === "buy" && e.listingId != null)) { const l = ledger[b.item] || (ledger[b.item] = { q: 0, c: 0 }); l.q += b.qty; l.c += b.coins; }
const timeline = rec.events.filter(e => e.kind !== "consume").sort((a, b) => a.at - b.at);
const t0 = performance.now();
const M = deriveMoney(timeline, {
    recordStart, reviewPct: 0.5,
    isCounted: h => h === "/items/cowbell", isKey: h => keyItems.has(h), isChest: h => chestItems.has(h), isConsumable: h => consumables.has(h), isToken: h => /_token$/.test(h),
    isOpenable: h => h === "/items/large_treasure_chest" || chestItems.has(h), isTradable: h => !/_token$/.test(h) && h !== "/items/cowbell",
    held: h => heldMap[h] || 0, listed: () => 0, bidOf: h => (px(h) && px(h).b > 0 ? px(h).b : null), askOf: h => (px(h) && px(h).a > 0 ? px(h).a : null),
    avgOf: h => (ledger[h] && ledger[h].q > 0 ? ledger[h].c / ledger[h].q : null), keyAvg: h => (keyAvg[h] ? keyAvg[h].c / keyAvg[h].q : null),
    keyOf: () => "/items/pirate_entry_key",
    keyRecipes: { "/actions/alchemy/pirate_entry_key": { inputs: [{ item: "/items/arcane_lumber", qty: 100 }, { item: "/items/redwood_lumber", qty: 100 }, { item: "/items/coin", qty: 300000 }], outputs: [{ item: "/items/pirate_entry_key", qty: 1 }] }, "/actions/alchemy/pirate_chest_key": { inputs: [{ item: "/items/burning_key_fragment", qty: 1 }, { item: "/items/stone_key_fragment", qty: 1 }, { item: "/items/white_key_fragment", qty: 1 }, { item: "/items/dark_key_fragment", qty: 1 }], outputs: [{ item: "/items/pirate_chest_key", qty: 1 }] } },
    consumeTotals, heldKeys: () => [],
});
const ms = performance.now() - t0;
const c = v => v == null ? "?" : (Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(2) + "m" : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(1) + "k" : String(Math.round(v)));
const nm = h => h.split("/").pop();
console.log(`deriveMoney over ${timeline.length} events in ${ms.toFixed(1)} ms; counted ${JSON.stringify(M.counts)}`);
console.log(`tax ${(M.tax.rate * 100).toFixed(2)}% (${M.tax.measured} taxed sales)`);
console.log(`SPENT ${c(M.spent.total)} = buys ${c(M.spent.buys)} + craft coins ${c(M.spent.craftCoins)}; used in runs ${c(M.used.total)} (keys ${c(M.used.keyCost)}, consumables ${c(M.used.consumableCost)})`);
console.log(`LOOT AT OPEN ${c(M.loot.atOpen)} (raw ${c(M.loot.atOpenRaw)}, revalued ${c(M.loot.revalued)}) + coins ${c(M.loot.coins)} from ${M.loot.opened} chests`);
console.log(`SOLD loot ${c(M.sold.loot.net)} net (${M.sold.loot.qty} items, tax ${c(M.sold.loot.tax)}); other ${c(M.sold.other.net)} (${M.sold.other.qty})`);
console.log(`NET ${c(M.net)}; held loot ${c(M.heldLoot)}; no longer held ${c(M.missingLoot)} (${M.reviewRows} rows to review)`);
console.log("\nKEYS"); for (const [h, k] of Object.entries(M.keys)) console.log(`  ${nm(h)}: held ${k.held} crafted ${k.crafted} bought ${k.bought} dropped ${k.dropped} used ${k.used} (${k.usedExact} exact, ${k.usedFallback} ${k.fallbackBasis || ""}) cost/key ${c(k.costPerKey)} ${k.costBasis} usedCost ${c(k.usedCost)} baseline ${k.baseline}`);
console.log("MATERIALS"); for (const m of Object.values(M.materials)) console.log(`  ${nm(m.item)}: bought ${m.bought} (${c(m.boughtCoins)}) consumed ${m.consumed} (${c(m.consumedCost)}) held ${m.held} avg ${c(m.avg)} baseline ${m.baseline}`);
console.log("USED CONSUMABLES"); for (const [h, u] of Object.entries(M.used.consumables)) console.log(`  ${nm(h)}: ${u.qty} (${u.offline} offline) ${c(u.cost)}${u.unknown ? ` · ${u.unknown} unpriced` : ""}`);
console.log("CHESTS"); for (const [h, ch] of Object.entries(M.chests)) console.log(`  ${nm(h)}: opened ${ch.opened} value ${c(ch.value)} coins ${c(ch.coins)} keyCost ${c(ch.keyCost)} ${JSON.stringify(ch.keyBasis)} counted ${JSON.stringify(ch.counted)}`);
console.log("TOKENS"); for (const [h, t] of Object.entries(M.tokens)) console.log(`  ${nm(h)}: gained ${t.gained} redeemed ${t.redeemed} received ${JSON.stringify(t.received)} held ${t.held}`);
console.log("LOOT ROWS (top 20 by value)"); for (const r of M.rows.slice(0, 20)) console.log(`  ${nm(r.item)} [${r.kind}]: gained ${r.gained}${r.redeemed ? ` (+${r.redeemed} redeemed)` : ""} opened ${r.opened} sold ${r.sold} net ${c(r.soldNet)} held ${r.held} missing ${r.missing} atOpen ${c(r.bidAtOpen)} now ${c(r.bidNow)} missingValue ${c(r.missingValue)}${r.review ? " REVIEW" : ""}`);
