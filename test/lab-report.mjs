// Read a talisman lab file and print what each labelled stretch shows.
//   node test/lab-report.mjs <metz-talisman-lab-*.json | metz-dungeon-stats-frames-*.json>
// A lab export is printed as it is. A raw frames export is replayed through the shipped createLab first (the
// lab_mark frames are the labels), so a session whose lab rows were lost to a reload can still be read.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2];
if (!file) { console.error("usage: node test/lab-report.mjs <lab export or frames export>"); process.exit(2); }
const text = fs.readFileSync(path.join(here, "..", "metz-dungeon-stats.user.js"), "utf8");
const { createLab } = new Function(`${text.slice(text.indexOf("// <lab>"), text.indexOf("// </lab>"))}\nreturn { createLab };`)();
const data = JSON.parse(fs.readFileSync(file, "utf8"));

let summary, labels, cards, bosses = new Set(data.bosses || []);
if (Array.isArray(data.frames)) {
    const lab = createLab();
    for (const f of data.frames.slice().sort((a, b) => a.at - b.at)) {
        const m = f.body || {};
        if (f.type === "lab_mark") lab.mark(m.label, f.at);
        else if (f.type === "new_battle" && Array.isArray(m.monsters)) lab.newBattle(m, f.at);
        else if (f.type === "battle_updated") lab.update(m, f.at);
        else if (f.type === "battle_unit_fetched" || f.type === "profile_shared") lab.unitCard(m, f.at);
    }
    const d = lab.dump(); summary = lab.summary(); labels = d.labels; cards = d.cards;
} else { summary = data.summary; labels = data.labels || []; cards = data.cards || []; }

const st = x => (x ? `n ${x.n}  ${x.min}..${x.max}  mean ${x.mean.toFixed(1)}` : "-");
const short = k => (k === "auto" ? "auto" : String(k || "").split("/").pop());
console.log(`${summary.rows} rows, ${summary.other} unattributed (${summary.otherSoonAfterCast} within 0.4 s of a cast)${summary.dropped ? `, ${summary.dropped} dropped` : ""}`);
for (const l of labels.length ? labels : [{ label: "" }]) {
    console.log(`\n== ${l.label || "(no label)"}${l.from ? `  ${new Date(l.from).toISOString()}${l.to ? " to " + new Date(l.to).toISOString() : ""}` : ""}`);
    for (const g of summary.groups.filter(g => g.label === l.label)) {
        if (g.kind === "hit") {
            console.log(`  ${short(g.key)} -> ${g.on}${bosses.has(g.hrid) ? " (boss)" : ""}: ${g.n} swings, ${g.misses} missed, ${g.kills} kills, ${g.multiSplat} with 2+ damage numbers`);
            console.log(`      plain  ${st(g.plain)}${g.plain ? `   min/max ${(g.plain.min / g.plain.max).toFixed(3)}` : ""}`);
            console.log(`      crit   ${st(g.crit)}${g.crit && g.plain ? `   crit max / plain max ${(g.crit.max / g.plain.max).toFixed(3)}` : ""}`);
            console.log(`      first hit after a kill  ${st(g.afterKill)}    otherwise  ${st(g.notAfterKill)}`);
        } else {
            console.log(`  ${g.by}${bosses.has(g.hrid) ? " (boss)" : ""} ${short(g.key)} -> ${g.on}: ${g.n} hits  ${st(g.plain)}`);
            console.log(`      mean by hits in the 5 s before: ${g.byHitsBefore.map((x, i) => `${i === 4 ? "4+" : i}: ${x ? x.mean.toFixed(1) + " (n " + x.n + ")" : "-"}`).join("   ")}`);
        }
    }
}
const keys = ["totalArmor", "totalWaterResistance", "totalNatureResistance", "totalFireResistance"];
const clicked = cards.filter(c => c.source === "clicked");
if (clicked.length) {
    console.log("\n== clicked cards");
    for (const c of clicked) console.log(`  ${new Date(c.at).toISOString()} [${c.label || "-"}] ${c.name}: ${keys.map(k => `${k} ${c.details && c.details[k]}`).join("  ")}`);
}
