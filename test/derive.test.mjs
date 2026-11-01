// Runs the script's derive() block over an exported record and prints what the Overview and Runs tabs would show.
//   node test/derive.test.mjs [record.json] [--source path]
// The block is cut out of the userscript between the <derive> and </derive> markers, so this exercises the shipped code.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const srcIdx = args.indexOf("--source");
const source = srcIdx >= 0 ? args[srcIdx + 1] : path.join(here, "..", "metz-dungeon-stats.user.js");
const recordPath = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--source") || path.join(here, "fixtures", "record-2026-11-01.json");
const text = fs.readFileSync(source, "utf8");
const block = text.slice(text.indexOf("// <derive>"), text.indexOf("// </derive>"));
if (!block.includes("function derive")) throw new Error("derive block not found in " + source);
const derive = new Function(`${block}\nreturn derive;`)();
const rec = JSON.parse(fs.readFileSync(recordPath, "utf8"));
const recordStart = (rec.meta.find(m => m.key === "recordStart") || {}).value || 0;
const chestItems = new Set(["/items/pirate_chest", "/items/pirate_refinement_chest", "/items/large_treasure_chest"]);
const keyItems = new Set(["/items/pirate_entry_key", "/items/pirate_chest_key"]);
const now = rec.exportedAt;
const t = ms => ms == null ? "-" : new Date(ms).toISOString().slice(5, 19);
const dur = ms => { if (ms == null) return "-"; const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`; };
const t0 = performance.now();
const out = derive(rec.events, now, { selfName: rec.character.name, recordStart, isChest: h => chestItems.has(h), isKey: h => keyItems.has(h), keyOf: () => "/items/pirate_entry_key" });
const ms = performance.now() - t0;
const S = out.summary;
console.log(`derive over ${rec.events.length} events in ${ms.toFixed(1)} ms; ${out.markers} chat markers, ${out.runs.length} runs`);
console.log(`window ${t(S.windowStart)} .. ${t(S.windowEnd)} = ${dur(S.totalMs)}`);
console.log(`clears ${S.clears}  fails ${S.fails} (${S.failRate == null ? "-" : (S.failRate * 100).toFixed(1) + "%"})  cancelled ${S.cancelled}  open ${S.open}  unknown ${S.unknown}`);
console.log(`avg clear ${dur(S.avgClearMs)}  avg incl fails ${dur(S.avgRunMs)}  fastest ${dur(S.fastestMs)}  slowest ${dur(S.slowestMs)}`);
console.log(`chests ${S.chestTotal} ${JSON.stringify(S.chests)}  keys charged ${S.keysCharged}  deaths ${S.deaths}  keys crafted ${S.keysCrafted} in ${S.crafts} crafts`);
console.log(`time: dungeons ${dur(S.dungeonMs)}  between ${dur(S.betweenMs)} (crafting ${dur(S.craftingMs)}, offline ${dur(S.offlineBetweenMs)}, other ${dur(S.otherMs)})  unknown ${dur(S.unknownMs)}  offline total ${dur(S.offlineMs)}`);
console.log(`check: dungeons + between + unknown = ${dur(S.dungeonMs + S.betweenMs + S.unknownMs)} vs window ${dur(S.totalMs)}`);
for (const b of out.offline) console.log(`offline ${t(b.from)} .. ${t(b.to)} ${dur(b.ms)}  chests ${b.chestTotal} ${JSON.stringify(b.chests)}  keys ${JSON.stringify(b.keys)}  runs in ledger ${b.runsInLedger}  xp ${JSON.stringify(b.xp)}`);
console.log("\nruns (oldest first):");
for (const r of out.runs) console.log(`${t(r.startAt)} -> ${t(r.endAt)} ${dur(r.durationMs).padStart(6)}  ${String(r.result).padEnd(9)} b${String(r.battleId ?? "?").padEnd(3)} w${String(r.waves ?? "?").padEnd(3)} chests ${r.chests ? r.chests.map(c => c.qty).join("+") : "?"}  keys ${r.keysCharged ?? "?"}${r.keysSrc ? " (" + r.keysSrc + ")" : ""}  deaths ${r.deaths ?? "?"}  xp ${r.xpBySkill ? Math.round(Object.values(r.xpBySkill).reduce((s, v) => s + v, 0)) : "?"}${r.xpPartial ? "p" : ""}  ${r.source}${r.spansRecordStart ? " spans-start" : ""}${r.note ? "  // " + r.note : ""}`);
