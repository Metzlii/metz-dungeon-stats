// The game's own words, in every language it ships, for the few game terms our strings use: the Loot & XP Log
// panel, the Combat menu entry, the Battle tab, and the Bloom stat. Same public files as
// rust_combat_Metz/scripts/pull-game-locales.mjs (the asset manifest and one lazy chunk per language); each value
// is read with a regex, nothing is executed.
import fs from "node:fs";
const ORIGIN = "https://www.milkywayidle.com";
const CODE = { es: "es", fr: "fr", ja: "ja", ko: "ko", pt: "pt", ru: "ru", zh: "zh", "zh-TW": "zh-Hant" };
const get = async u => { const r = await fetch(u); if (!r.ok) throw new Error(`${u} -> ${r.status}`); return r.text(); };
const pick = (src, re) => { const m = re.exec(src); return m ? new Function(`return "${m[1]}"`)() : null; };
const terms = src => ({
    loot: pick(src, /lootLogPanel:\{lootTracker:"((?:[^"\\]|\\.)*)"/),
    combat: pick(src, /,combat:"((?:[^"\\]|\\.)*)",shop:"/),
    battle: pick(src, /battleCount:"((?:[^"\\]|\\.)*)"/),
    bloom: pick(src, /combatStats:\{[^{}]*?bloom:"((?:[^"\\]|\\.)*)"/),
});
const manifest = JSON.parse(await get(`${ORIGIN}/asset-manifest.json`));
const jsPaths = Object.values(manifest.files || manifest).filter(v => String(v).endsWith(".js"));
const mainSrc = await get(ORIGIN + jsPaths.find(p => /\/main\.[0-9a-f]+\.chunk\.js$/.test(p)));
const table = new Function(`return ${mainSrc.match(/\{"\.\/[a-zA-Z-]+\/index\.js":\[\d+,\d+\][^}]*\}/)[0]}`)();
const out = { en: terms(mainSrc) };
for (const [k, [, id]] of Object.entries(table)) {
    const tag = k.replace(/^\.\/|\/index\.js$/g, ""), p = jsPaths.find(x => new RegExp(`/${id}\\.[0-9a-f]+\\.chunk\\.js$`).test(x));
    out[CODE[tag] || tag] = terms(await get(ORIGIN + p));
}
fs.writeFileSync(new URL("./game-terms.json", import.meta.url), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
