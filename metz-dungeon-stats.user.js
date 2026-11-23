// ==UserScript==
// @name         Metz Dungeon Stats
// @namespace    metzlii
// @version      0.2.10
// @description  One permanent record of your XP, your dungeon runs and the dungeon cash flow: keys crafted, consumables used, chests opened, loot sold. A damage meter per run, by player and ability. Tracked from the game's own messages, nothing estimated.
// @author       Metzli
// @license      MIT
// @homepageURL  https://github.com/Metzlii/metz-dungeon-stats
// @supportURL   https://github.com/Metzlii/metz-dungeon-stats/issues
// @downloadURL  https://update.greasyfork.org/scripts/603399/Metz%20Dungeon%20Stats.user.js
// @updateURL    https://update.greasyfork.org/scripts/603399/Metz%20Dungeon%20Stats.meta.js
// @match        https://www.milkywayidle.com/*
// @match        https://milkywayidle.com/*
// @match        https://www.milkywayidlecn.com/*
// @match        https://milkywayidlecn.com/*
// @run-at       document-start
// @grant        none
// @noframes
// @require      https://cdn.jsdelivr.net/npm/lz-string@1.5.0/libs/lz-string.min.js
// ==/UserScript==

/*
 * Milestones 1 and 2: capture and record; runs and time.
 *
 * Everything this script knows comes from the game's WebSocket. Each message is read once, turned into zero or more
 * small events, and each event is written once to IndexedDB. Nothing is estimated; where a value cannot be observed
 * the event says so. The Data panel shows the events newest first with the message each came from, so a run, a
 * chest or a sale that went missing or doubled can be seen rather than guessed at.
 *
 * Open questions from docs/design.md section 9 are answered by retained raw frames ("frames" store): the first
 * frames of every type, every party system chat message, every loot_opened, every action_completed that moved items,
 * every consumable cooldown message, and the login summary. Export them from the panel.
 */
(function () {
    "use strict";

    const VERSION = "0.2.10";
    const LOG = "[Metz Dungeon Stats]";
    const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const DEVICE_KEY = "mds-device-v1";
    const PANEL_KEY = "mds-panel-v1";

    // ---------------------------------------------------------------------------------------------------------------
    // Small helpers
    // ---------------------------------------------------------------------------------------------------------------
    const warn = (...a) => { try { console.warn(LOG, ...a); } catch (_e) { /* quiet */ } };
    const info = (...a) => { try { console.info(LOG, ...a); } catch (_e) { /* quiet */ } };
    const num = v => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
    const isObj = v => v !== null && typeof v === "object";
    const clone = v => { try { return structuredClone(v); } catch (_e) { return JSON.parse(JSON.stringify(v)); } };
    const pad2 = n => String(n).padStart(2, "0");
    // Compact, unambiguous dates: 1Nov26 11:44:01 (operator's preference: readable from anywhere, no day/month order to guess).
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const fmtDate = ms => { const d = new Date(ms); return `${d.getDate()}${MONTHS[d.getMonth()]}${String(d.getFullYear()).slice(2)}`; };
    const fmtClock = ms => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
    const fmtTime = ms => { const d = new Date(ms); return `${fmtDate(ms)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
    const fmtDur = ms => { if (!(ms >= 0)) return "?"; const s = Math.round(ms / 1000); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60; return h ? `${h}:${pad2(m)}:${pad2(r)}` : `${m}:${pad2(r)}`; };
    const fmtCoins = n => { if (n == null) return "?"; const a = Math.abs(n); const sign = n < 0 ? "-" : ""; if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(2)}b`; if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(2)}m`; if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(1)}k`; return `${sign}${Math.round(a)}`; };
    const parseServerTime = s => { if (!s) return null; const t = Date.parse(typeof s === "string" && s.length > 24 ? s.replace(/(\.\d{3})\d+Z$/, "$1Z") : s); return Number.isFinite(t) ? t : null; };
    const shortItem = hrid => (typeof hrid === "string" ? hrid.replace(/^\/items\//, "") : String(hrid));
    const shortAction = hrid => (typeof hrid === "string" ? hrid.replace(/^\/actions\/[a-z_]+\//, "") : String(hrid));

    function deviceId() {
        try {
            let id = localStorage.getItem(DEVICE_KEY);
            if (!id) { id = Math.random().toString(36).slice(2, 8); localStorage.setItem(DEVICE_KEY, id); }
            return id;
        } catch (_e) { return "nodev"; }
    }
    const DEVICE = deviceId();
    let idCounter = 0;
    const newId = () => `${DEVICE}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

    // Server clock: offset = server - local, measured from init_character_data.currentTimestamp.
    const clock = { offset: 0, known: false };
    const serverNow = () => Date.now() + clock.offset;

    // ---------------------------------------------------------------------------------------------------------------
    // IndexedDB record: one database per character, small writes, batched into one transaction per second.
    // ---------------------------------------------------------------------------------------------------------------
    const STORES = { events: { keyPath: "id" }, runs: { keyPath: "id" }, inventory: { keyPath: "hash" }, meta: { keyPath: "key" }, frames: { keyPath: "id" }, xp: { keyPath: "id" } };

    function openDb(characterId) {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(`metz-dungeon-stats-${characterId}`, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                for (const [name, opts] of Object.entries(STORES)) if (!db.objectStoreNames.contains(name)) {
                    const store = db.createObjectStore(name, opts);
                    if (name === "events") { store.createIndex("at", "at"); store.createIndex("kind", "kind"); }
                    if (name === "frames") store.createIndex("type", "type");
                    if (name === "runs") store.createIndex("startAt", "startAt");
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
            req.onblocked = () => warn("database open blocked (another tab upgrading?)");
        });
    }

    function createRecord(db) {
        const pending = new Map(); // store -> Map(key -> value | DELETE)
        const DELETE = Symbol("delete");
        let timer = null, flushing = null, written = 0;
        const keyOf = (store, v) => v[STORES[store].keyPath];
        function queue(store, value) { let m = pending.get(store); if (!m) pending.set(store, m = new Map()); m.set(keyOf(store, value), value); schedule(); }
        function remove(store, key) { let m = pending.get(store); if (!m) pending.set(store, m = new Map()); m.set(key, DELETE); schedule(); }
        function schedule() { if (!timer) timer = setTimeout(flush, 1000); }
        function flush() {
            timer = null;
            if (!pending.size) return Promise.resolve();
            const batch = new Map(pending); pending.clear();
            flushing = new Promise(resolve => {
                try {
                    const tx = db.transaction([...batch.keys()], "readwrite");
                    for (const [store, m] of batch) { const os = tx.objectStore(store); for (const [k, v] of m) { if (v === DELETE) os.delete(k); else os.put(v); written++; } }
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => { warn("write failed", tx.error); resolve(); };
                    tx.onabort = () => { warn("write aborted", tx.error); resolve(); };
                } catch (error) { warn("write failed", error); resolve(); }
            });
            return flushing;
        }
        function getAll(store, indexName, range, direction, limit) {
            return new Promise(resolve => {
                try {
                    const tx = db.transaction(store, "readonly"); const os = tx.objectStore(store);
                    const src = indexName ? os.index(indexName) : os;
                    if (!direction && !limit) { const r = src.getAll(range || undefined); r.onsuccess = () => resolve(r.result || []); r.onerror = () => resolve([]); return; }
                    const out = []; const c = src.openCursor(range || undefined, direction || "next");
                    c.onsuccess = () => { const cur = c.result; if (!cur || (limit && out.length >= limit)) return resolve(out); out.push(cur.value); cur.continue(); };
                    c.onerror = () => resolve(out);
                } catch (_e) { resolve([]); }
            });
        }
        function get(store, key) { return new Promise(resolve => { try { const r = db.transaction(store, "readonly").objectStore(store).get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(undefined); } catch (_e) { resolve(undefined); } }); }
        function count(store) { return new Promise(resolve => { try { const r = db.transaction(store, "readonly").objectStore(store).count(); r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(0); } catch (_e) { resolve(0); } }); }
        function clearAll() { return new Promise(resolve => { try { const names = [...db.objectStoreNames]; const tx = db.transaction(names, "readwrite"); for (const n of names) tx.objectStore(n).clear(); tx.oncomplete = () => resolve(true); tx.onerror = () => resolve(false); } catch (_e) { resolve(false); } }); }
        const api = { queue, remove, flush, getAll, get, count, clearAll, stats: () => ({ written, pending: [...pending.values()].reduce((s, m) => s + m.size, 0) }) };
        const settle = () => { try { if (state.ready) queue("meta", { key: "ledger", value: ledgerState() }); } catch (_e) { /* fine */ } flush(); };
        W.addEventListener("pagehide", settle);
        document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") settle(); });
        return api;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Static reference: dungeons, key recipes, openables, item facts. From init_client_data (message or cache).
    // ---------------------------------------------------------------------------------------------------------------
    const ref = { ready: false, dungeons: {}, keyActions: {}, keyItems: new Set(), realKeys: new Set(), dungeonLoot: new Set(), chestItems: {}, items: {}, tokenShop: {}, skills: {}, abilities: {}, books: {}, levelTable: [], version: null, source: null };

    function buildRef(data) {
        if (!isObj(data) || !isObj(data.actionDetailMap) || !isObj(data.itemDetailMap)) return false;
        ref.dungeons = {}; ref.keyActions = {}; ref.keyItems = new Set(); ref.realKeys = new Set(); ref.dungeonLoot = new Set(); ref.chestItems = {}; ref.items = {};
        for (const [hrid, item] of Object.entries(data.itemDetailMap)) {
            ref.items[hrid] = { name: item.name, category: item.categoryHrid, openable: !!item.isOpenable, openKey: item.openKeyItemHrid || null, tradable: item.isTradable === true, sellPrice: num(item.sellPrice), hp: num(item.consumableDetail && item.consumableDetail.hitpointRestore), hpOverMs: num(item.consumableDetail && item.consumableDetail.recoveryDuration) / 1e6 };
            if (item.categoryHrid === "/item_categories/dungeon_key") ref.keyItems.add(hrid);
        }
        for (const [hrid, action] of Object.entries(data.actionDetailMap)) {
            const zone = action.combatZoneInfo;
            if (zone && zone.isDungeon && zone.dungeonInfo) {
                const d = zone.dungeonInfo;
                const chests = (d.rewardDropTable || []).map(r => r.itemHrid).filter(Boolean);
                ref.dungeons[hrid] = { name: action.name, sortIndex: num(action.sortIndex), maxWaves: num(d.maxWaves), keyItem: d.keyItemHrid || null, chests };
                for (const c of chests) ref.chestItems[c] = { zone: hrid, key: ref.items[c] ? ref.items[c].openKey : null };
            }
            if (action.category === "/action_categories/crafting/dungeon_keys") {
                ref.keyActions[hrid] = { name: action.name, type: action.type || "/action_types/crafting", seconds: num(action.baseTimeCost) / 1e9 || 10, inputs: (action.inputItems || []).map(i => ({ item: i.itemHrid, qty: num(i.count) })), outputs: (action.outputItems || []).map(i => ({ item: i.itemHrid, qty: num(i.count) })) };
            }
        }
        for (const [hrid, item] of Object.entries(data.itemDetailMap)) if (item.isOpenable && item.openKeyItemHrid && !ref.chestItems[hrid]) ref.chestItems[hrid] = { zone: null, key: item.openKeyItemHrid };
        Object.entries(ref.dungeons).sort((a, b) => a[1].sortIndex - b[1].sortIndex).forEach(([, dg], i) => { dg.index = i + 1; });
        ref.dungeonLoot = new Set(); for (const [chest, c] of Object.entries(ref.chestItems)) if (c.zone) for (const d of ((data.openableLootDropMap || {})[chest] || [])) if (d && d.itemHrid) ref.dungeonLoot.add(d.itemHrid);
        ref.realKeys = new Set([...Object.values(ref.dungeons).map(d => d.keyItem), ...Object.values(ref.chestItems).map(c => c.key)].filter(Boolean));
        // Token shop: shop items paid with exactly one kind of token (the site's chestValue.mjs rule, ZONE-12).
        ref.tokenShop = {};
        for (const entry of Object.values(data.shopItemDetailMap || {})) {
            const costs = Array.isArray(entry.costs) ? entry.costs : []; if (costs.length !== 1 || !/_token$/.test(costs[0].itemHrid || "") || !(num(costs[0].count) > 0)) continue;
            (ref.tokenShop[costs[0].itemHrid] = ref.tokenShop[costs[0].itemHrid] || []).push({ item: entry.itemHrid, tokens: num(costs[0].count), count: num(entry.count) || 1, shop: entry.hrid, category: entry.category || null });
        }
        ref.abilities = {}; for (const [hrid, ab] of Object.entries(data.abilityDetailMap || {})) ref.abilities[hrid] = { name: ab.name || hrid.split("/").pop(), sortIndex: num(ab.sortIndex), special: !!ab.isSpecialAbility, meter: meterAbilityInfo(ab) };
        ref.levelTable = Array.isArray(data.levelExperienceTable) ? data.levelExperienceTable.map(num) : [];
        ref.books = {}; for (const [hrid, item] of Object.entries(data.itemDetailMap)) { const bd = item.abilityBookDetail; if (bd && bd.abilityHrid && num(bd.experienceGain) > 0) ref.books[bd.abilityHrid] = { item: hrid, xp: num(bd.experienceGain) }; }
        ref.skills = {}; for (const [hrid, sk] of Object.entries(data.skillDetailMap || {})) if (hrid !== "/skills/total_level") ref.skills[hrid] = { name: sk.name || hrid.split("/").pop(), sortIndex: num(sk.sortIndex), combat: !!sk.isCombat };
        ref.version = data.gameVersion || null;
        ref.ready = Object.keys(ref.dungeons).length > 0;
        return ref.ready;
    }

    function refFromCache() {
        try {
            const packed = W.localStorage.getItem("initClientData");
            if (!packed) return false;
            const LZ = (typeof LZString !== "undefined" && LZString) || W.LZString;
            if (!LZ || typeof LZ.decompressFromUTF16 !== "function") { warn("lz-string missing; cannot read the cached game data until the game sends it"); return false; }
            const text = LZ.decompressFromUTF16(packed);
            if (!text) return false;
            if (buildRef(JSON.parse(text))) { ref.source = "cache"; return true; }
        } catch (error) { warn("cached game data unreadable", error); }
        return false;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Languages (0.2.3, operator 2026-11-23: every language the game ships, like the other Metz scripts)
    // ---------------------------------------------------------------------------------------------------------------
    // Two sources, the site's rule (zone-page/i18n.js):
    //   - The game's own NOUNS (items, abilities, monsters, places, skills, its tab names) come from the game itself:
    //     its components carry react-i18next's `i18n`, and `i18n.t("itemNames./items/…")` is exactly what the
    //     player's screen shows. Nothing shipped, nothing to go stale; English from the game data if it is not found.
    //   - OUR words are keyed by their English. I18N[lang] maps an English string to its translation; a key may hold
    //     {placeholders}, which then match the same text with any values in them. A string with no translation stays
    //     English, so a half-done language is always safe. localize() translates what the panel wrote, text nodes
    //     and title/placeholder/aria-label/label attributes, and never inside translate="no" (player names).
    const I18N_SRC = {};   // lang -> JSON text of its translations, in the order of the English keys (locale block, end of file)
    let I18N_KEYS_SRC = "[]", I18N_KEYS = null;   // the English keys, once, as JSON text; parsed with the first language used
    const I18N = {};       // lang -> parsed dictionary, only for the languages actually used
    const LANGS = ["en", "es", "fr", "ja", "ko", "pt", "ru", "zh", "zh-Hant"];
    let gameI18nNode = null, gameI18nAt = 0;
    function gameI18n() {
        if (gameI18nNode && typeof gameI18nNode.t === "function") return gameI18nNode;
        if (Date.now() - gameI18nAt < 3000) return null; gameI18nAt = Date.now();
        try {
            const rootEl = document.getElementById("root"); if (!rootEl) return null;
            const c = rootEl._reactRootContainer; let first = (c && (c.current || (c._internalRoot && c._internalRoot.current))) || null;
            if (!first) { const k = Object.keys(rootEl).find(x => x.startsWith("__reactContainer$")); if (k) first = rootEl[k]; }
            const pending = first ? [first] : [], seen = new Set();
            while (pending.length && seen.size < 8000) {
                const f = pending.pop(); if (!f || seen.has(f)) continue; seen.add(f);
                const i = f.memoizedProps && f.memoizedProps.i18n;
                if (i && typeof i.t === "function" && typeof i.language === "string") { gameI18nNode = i; return i; }
                if (f.child) pending.push(f.child); if (f.sibling) pending.push(f.sibling);
            }
        } catch (_e) { /* not reachable: English names */ }
        return null;
    }
    function uiLang() {
        let l = "";
        const g = gameI18n(); if (g) l = g.language;
        if (!l) { try { l = String(W.localStorage.getItem("i18nextLng") || "").replace(/^"|"$/g, ""); } catch (_e) { l = ""; } }
        l = l || "en";
        if (/^zh[-_](tw|hk|mo|hant)/i.test(l)) return "zh-Hant";
        if (/^zh/i.test(l)) return "zh";
        const base = l.slice(0, 2).toLowerCase();
        return LANGS.includes(base) ? base : "en";
    }
    // The game's name for a thing in the player's language, else the English one.
    function gameName(section, hrid, english) {
        if (!hrid || uiLang() === "en") return english;
        const g = gameI18n(); if (!g) return english;
        try { const k = `${section}.${hrid}`, v = g.t(k); return v && v !== k && typeof v === "string" ? v : english; } catch (_e) { return english; }
    }
    const i18nCache = new Map();   // lang -> { exact: Map, patterns: [{re, to, anchor}] }
    function i18nTable(lang) {
        let tb = i18nCache.get(lang); if (tb) return tb;
        tb = { exact: new Map(), patterns: [], all: new Map() };
        if (!I18N[lang] && I18N_SRC[lang]) {
            try {
                if (!I18N_KEYS) I18N_KEYS = JSON.parse(I18N_KEYS_SRC);
                const list = JSON.parse(I18N_SRC[lang]), dict = {};
                for (let i = 0; i < I18N_KEYS.length; i++) if (list[i] != null) dict[I18N_KEYS[i]] = list[i];
                I18N[lang] = dict;
            } catch (error) { warn(`translations for ${lang} unreadable`, error); I18N[lang] = {}; }
        }
        for (const [en, to] of Object.entries(I18N[lang] || {})) {
            if (!to) continue;
            tb.all.set(en, to);   // t() looks a template up by its English, placeholders and all
            if (!/\{[a-z0-9_]+\}/i.test(en)) { tb.exact.set(en, to); continue; }
            const names = []; const anchor = en.split(/\{[a-z0-9_]+\}/i).sort((a, b) => b.length - a.length)[0];
            const re = new RegExp("^" + en.split(/(\{[a-z0-9_]+\})/i).map(part => { const m = /^\{([a-z0-9_]+)\}$/i.exec(part); if (m) { names.push(m[1]); return "([^·]+?)"; } return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("") + "$");
            tb.patterns.push({ re, to, names, anchor });
        }
        tb.patterns.sort((a, b) => b.anchor.length - a.anchor.length);
        tb.memo = new Map();
        i18nCache.set(lang, tb); return tb;
    }
    // One string: exact, else the first pattern that matches it whole.
    function trText(text, lang) {
        lang = lang || uiLang(); if (lang === "en" || !text) return text;
        const core = text.trim(); if (!core || !/\p{L}/u.test(core)) return text;
        const tb = i18nTable(lang);
        let out = tb.memo.get(core);
        if (out === undefined) {
            out = tb.exact.get(core);
            if (out === undefined) {
                out = null;
                for (const p of tb.patterns) { if (p.anchor && !core.includes(p.anchor)) continue; const m = p.re.exec(core); if (m) { out = p.to.replace(/\{([a-z0-9_]+)\}/gi, (all, n) => { const i = p.names.indexOf(n); return i >= 0 ? trText(m[i + 1], lang) : all; }); break; } }
            }
            if (tb.memo.size > 20000) tb.memo.clear();
            tb.memo.set(core, out);
        }
        if (out == null) { if (W.__mdsI18nMissing) W.__mdsI18nMissing.add(core); return text; }
        return text.replace(core, out);
    }
    // In code: t("Damage taken {n}", { n }) -> the translation with the values in.
    function t(en, vars) {
        const lang = uiLang(); let out = en;
        if (W.__mdsI18nCollect) W.__mdsI18nCollect.add(en);
        if (lang !== "en") { const tb = i18nTable(lang), v = tb.all.get(en); if (v) out = v; else if (W.__mdsI18nMissing) W.__mdsI18nMissing.add(en); }
        return vars ? out.replace(/\{([a-z0-9_]+)\}/gi, (all, n) => (vars[n] != null ? String(vars[n]) : all)) : out;
    }
    const L10N_ATTRS = ["title", "placeholder", "aria-label", "label"];
    // Translate what the panel wrote under `el`. Cheap when nothing changed: every string is memoised.
    // Each text and attribute remembers the English it was translated from, so a change of the game's language (or
    // back to English) is translated from the English again rather than from the last language.
    const l10nText = new WeakMap(), l10nAttr = new WeakMap();   // node -> {en, out}; element -> {attr: {en, out}}
    let l10nUsed = false;
    function localize(el) {
        const lang = uiLang(); if (!el || (lang === "en" && !l10nUsed && !W.__mdsI18nCollect)) return;
        if (lang !== "en") l10nUsed = true;
        const collect = W.__mdsI18nCollect;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, { acceptNode: n => (n.nodeType === 1 && (n.getAttribute("translate") === "no" || n.tagName === "STYLE" || n.tagName === "SCRIPT") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
        const one = s => { if (collect) { const c = s.trim(); if (c && /\p{L}/u.test(c)) collect.add(c); } return lang === "en" ? s : trText(s, lang); };
        // The English behind what is shown: the remembered one while the text is still what we put there, else the
        // text itself (the panel wrote new English over it).
        const english = (cur, memo) => (memo && cur === memo.out ? memo.en : cur);
        for (let n = el; n; n = walker.nextNode()) {
            if (n.nodeType === 3) { const en = english(n.data, l10nText.get(n)), v = one(en); if (v !== n.data) n.data = v; if (v !== en) l10nText.set(n, { en, out: v }); else l10nText.delete(n); }
            else if (n.nodeType === 1) for (const a of L10N_ATTRS) {
                const v0 = n.getAttribute(a); if (!v0) continue;
                let m = l10nAttr.get(n); const en = english(v0, m && m[a]), v = one(en);
                if (v !== v0) n.setAttribute(a, v);
                if (v !== en) { if (!m) l10nAttr.set(n, m = {}); m[a] = { en, out: v }; } else if (m) delete m[a];
            }
        }
    }

    const itemName = hrid => gameName("itemNames", hrid, (ref.items[hrid] && ref.items[hrid].name) || shortItem(hrid));
    const isConsumable = hrid => { const c = ref.items[hrid] && ref.items[hrid].category; return c === "/item_categories/food" || c === "/item_categories/drink"; };
    // Items that cannot be sold for coins: counted and averaged per chest, never priced (same as the simulator site).
    const COUNT_ONLY = new Set(["/items/cowbell"]);
    const isCounted = hrid => COUNT_ONLY.has(hrid);

    // ---------------------------------------------------------------------------------------------------------------
    // Prices: marketplace.json, lowest ask (instant buy) and highest bid (instant sell), 15 minute cache.
    // ---------------------------------------------------------------------------------------------------------------
    const prices = { at: 0, map: null, fetching: null, error: null };
    function fetchPrices(force) {
        if (!force && prices.map && Date.now() - prices.at < 15 * 60 * 1000) return Promise.resolve(prices.map);
        if (prices.fetching) return prices.fetching;
        const origin = location.hostname.includes("milkywayidlecn") ? "https://www.milkywayidlecn.com" : "https://www.milkywayidle.com";
        prices.fetching = fetch(`${origin}/game_data/marketplace.json`, { credentials: "omit", cache: "no-store" })
            .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
            .then(json => {
                const map = {}; const md = json && json.marketData;
                if (isObj(md)) for (const [hrid, levels] of Object.entries(md)) { const l0 = levels && levels["0"]; if (l0) map[hrid] = { a: num(l0.a) > 0 ? num(l0.a) : null, b: num(l0.b) > 0 ? num(l0.b) : null }; }
                prices.map = map; prices.at = Date.now(); prices.error = null; prices.serverTs = num(json && json.timestamp) * 1000 || null;
                if (state.record) state.record.queue("meta", { key: "prices", at: prices.at, serverTs: prices.serverTs, count: Object.keys(map).length });
                return map;
            })
            .catch(error => { prices.error = String(error); warn("prices fetch failed", error); return prices.map; })
            .finally(() => { prices.fetching = null; });
        return prices.fetching;
    }
    const askOf = hrid => (prices.map && prices.map[hrid] && prices.map[hrid].a) || null;
    const bidOf = hrid => (prices.map && prices.map[hrid] && prices.map[hrid].b) || null;

    // ---------------------------------------------------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------------------------------------------------
    const state = {
        characterId: null, characterName: null, record: null, ready: false, startedAt: Date.now(),
        meta: {},                       // loaded meta rows by key
        inventory: new Map(),           // hash -> row (inventory location and others)
        lifetimeXp: {},                 // skillHrid -> experience (lifetime)
        lifetimeAbilityXp: {},          // abilityHrid -> experience (lifetime), from characterAbilities / endCharacterAbilities
        levels: {},                     // skill or ability hrid -> level the game last reported
        listings: new Map(),            // listing id -> {filledQuantity, taxTaken, unclaimedCoinCount, unclaimedItemCount, isSell, itemHrid, price, status}
        pendingOrders: [],              // outgoing post_market_order frames waiting for their inventory rows
        battleItems: new Set(),         // consumables slotted in the current battle (self)
        run: null,                      // live run in progress
        chatRun: null,                  // run opened by the party chat ledger
        lastBattle: null,               // {battleId, wave}
        lastChatAt: 0,
        chatSeen: new Set(),            // "id:<chat id>" and "tm:<t>|<m>" of recorded party system messages (replay dedupe)
        timeline: [], timelineRev: 0,   // every non-consume event, oldest first: what derive() reads
        consumeTotals: new Map(),       // itemHrid -> {qty, cost, unknownQty} over every consume event (they stay out of the timeline)
        artisan: {},                    // actionType -> {rate, tea, at}: the game's artisan buff (tea × pouch), from consumableActionTypeBuffsMap
        lootLog: new Map(),             // characterActionId -> session from the game's Loot & XP Log (loot_log_updated) and Toolasha's copy
        lootLogRev: 0, lootLogAt: 0, lootLogReadThisSession: false,
        marketHistory: new Map(),       // listing id -> {id, at, item, level, price, qty, ordered, isSell, src}: this PC's Toolasha store + imported files
        ledger: new Map(),              // itemHrid -> {qty, cost} running purchase ledger (average cost)
        keyLots: new Map(),             // keyItem -> [{qty, unitCost, basis, craftId}]
        counts: { frames: 0, byType: new Map(), events: 0 },
        frameCounts: new Map(),         // type -> retained count
        reviews: 0,
        events: [],                     // recent events for the panel (newest first, capped)
        sockets: 0, viaData: 0,
        meter: null,                    // the damage meter's live session (0.2.0)
        damage: [],                     // saved damage sessions: the record's "damage" events
        streak: null,                   // the battle tab's running total: every session since the party went into combat, this page only
    };

    // <meter>
    // Damage meter (0.2.0). Built from the game's own battle messages and checked against them, never against another
    // meter. Read in a capture of three Pirate Cove clears (2026-11-23, 169 waves):
    //   new_battle: every unit with its current HP and MP, attack counter (attackAttemptCounter), the ability it is
    //     preparing (preparingAbilityHrid, isPreparingAutoAttack) and its status flags.
    //   battle_updated (pMap/mMap by unit index): only the units that changed: cHP, cMP, atkCounter, dmgCounter,
    //     abilityHrid / isAutoAtk, isBlinded / isStunned / isSilenced.
    // Every HP point is visible: in all 169 waves, spawn HP less the losses plus the self-heals is exactly what is left.
    // Who did it:
    //   - The unit whose atkCounter rose is the one acting; HP its enemies lost in that message is its damage.
    //   - The ability it used is the one its card named BEFORE this message: a unit's abilityHrid is what it prepares
    //     next. By mana spent, the previous name gives each ability one fixed cost; the current name scatters.
    //   - A monster whose counter rises in the same message as a debuff landing on it (Nature's Veil's blind: 67 of 67)
    //     did not act; the counter moved with the debuff.
    //   - A monster losing HP while it acts, with a player listed whose HP did not move: that player's parry (a
    //     counter-attack) or thorns. With two listed, the one with parry or thorns in their stats.
    //   - HP lost with nobody acting, a player listed: that player's damage over time, put on the last DoT ability
    //     that player hit this monster with (Maim's bleed). A player losing HP with nobody acting: a monster's DoT.
    // Healing: a heal ability's gains go to its caster; Life Drain (hpDrainRatio) heals the caster; every other gain is
    // regeneration, food or a passive, and counts as healing received, not done.
    // Mana (0.2.8, operator 2026-11-23), read in the same capture, every MP change of 14 minutes classified:
    //   - MP lost in the message where the player's own counter rose is that ability's cost (1,275 of 1,275 losses;
    //     one fixed cost per ability, two when its level changed).
    //   - MP gained by two or more players in one message is the regeneration tick (every 10 s, also when someone
    //     acts in that message); gained by one player alone with nobody acting is food or drink; anything else "other".
    //   - A difference between waves' new_battle values (a refill at a run's start) is not counted.
    function createMeter(cfg) {
        cfg = cfg || {};
        const abilityOf = h => (cfg.ability && h && cfg.ability(h)) || null;
        const FLAGS = ["isBlinded", "isStunned", "isSilenced"];
        let cur = null, battle = null, seq = 0;
        // The regeneration clock (operator, 2026-11-23: one tick shown as "Other"). Regeneration ticks every 10 s for
        // everyone at once; in the capture two or more players gain MP with nobody acting only on that clock (gaps
        // of exactly 10 or 20 s). A heal or mana gain on one player alone is that tick too when it lands on the
        // clock (within 0.4 s) AND is the amount that player's tick is known to give, or less with the player ending
        // full. On the clock alone is not enough: about 8% of food and Bloom heals land there by chance.
        let regenAt = null; const regenHp = {}, regenMp = {};
        const onRegenClock = at => { if (regenAt == null) return false; const x = (((at - regenAt) % 10000) + 10000) % 10000; return Math.min(x, 10000 - x) <= 400; };
        const regenTick = (known, gain, full) => known > 0 && (gain === known || (gain < known && full));
        // Life steal and mana leech (operator, 2026-11-23) come only from gear (game data: Vampire Fang Dirk and
        // Vampiric Bow, lifeSteal; Soul Hunter Crossbow, manaLeech), so they can be verified: the player has the stat,
        // acts in this message, monsters lose HP in it, and the gain is no more than that damage times the stat.
        // Anything that cannot be verified stays in "other", never folded into food or Bloom.
        const stolen = (stat, dmg, gain) => stat > 0 && dmg > 0 && gain <= Math.ceil(dmg * stat) + 1;
        // Vampirism (game data: a self buff of type life_steal, 0.08 + 0.0008 a level, for 20 s) is life steal too:
        // battle_updated carries no buffs, so the buff is kept from the cast, by player name across waves.
        const vamp = {};
        const lifeStealOf = (u, at) => u.lifeSteal + (vamp[u.name] && at <= vamp[u.name].until ? vamp[u.name].amt : 0);
        const blankPlayer = (name, id) => ({ name, id: id != null ? String(id) : null, dealt: 0, hits: 0, misses: 0, casts: 0, taken: 0, healed: 0, healDone: 0, deaths: 0, abilities: {}, takenBy: {}, healBy: {}, takenHits: {}, takenMiss: {}, healHits: {}, takenSub: {}, healSub: {}, mpSpent: 0, mpGain: 0, mana: { spent: {}, gain: {} } });
        const abilityRow = (p, key) => p.abilities[key] || (p.abilities[key] = { dmg: 0, hits: 0, misses: 0, casts: 0, heal: 0 });
        function open(m, at) {
            cur = { v: 1, battleId: m.battleId, startAt: at, lastAt: at, firstWave: Number(m.wave) || 0, lastWave: Number(m.wave) || 0, waves: 0, combatMs: 0, players: {}, monsters: {}, monsterHpLost: 0, monsterHealed: 0, unassigned: 0, check: { waves: 0, balanced: 0, gap: 0 } };
            return cur;
        }
        // The check, for a wave that ended in a win (the next wave began, or the run was cleared): every monster was
        // seen going to 0 HP and every point it lost was credited to a player. A missed message leaves HP standing.
        // Time in combat runs without a break (operator, 2026-11-23: it paused between waves): a wave counts from its
        // start to the next wave's start, the last wave to its last message.
        function closeWave(complete, endAt) {
            if (!battle || !cur) return;
            if (complete) {
                const left = battle.m.reduce((s, u) => s + (u ? Math.max(0, u.hp) : 0), 0);
                cur.check.waves++; if (left === 0 && battle.unassigned === 0) cur.check.balanced++; else cur.check.gap += left + battle.unassigned;
            }
            cur.combatMs += Math.max(0, (endAt != null ? endAt : battle.lastAt) - battle.startAt);
            battle = null;
        }
        function close(at, complete) {
            if (!cur) return null;
            closeWave(!!complete);
            const s = cur; cur = null; if (at) s.endAt = at; else s.endAt = s.lastAt;
            return s;
        }
        function unit(u, i, isPlayer) {
            const det = (u.combatDetails && u.combatDetails.combatStats) || {};
            return { i, isPlayer, name: (isPlayer ? (u.character && u.character.name) || u.name : u.name || String(u.hrid || "").split("/").pop()) || `#${i}`, id: isPlayer && u.character ? u.character.id : null,
                hp: Number(u.currentHitpoints) || 0, mhp: Number(u.maxHitpoints) || 0, mp: Number(u.currentManapoints) || 0, mmp: Number(u.maxManapoints) || 0, lifeSteal: Number(det.lifeSteal) || 0, levels: Object.fromEntries((u.combatAbilities || []).filter(a => a && a.abilityHrid).map(a => [a.abilityHrid, Number(a.level) || 0])), manaLeech: Number(det.manaLeech) || 0, bloom: Number(det.bloom) || 0, atk: Number(u.attackAttemptCounter) || 0, dmg: Number(u.damageSplatCounter) || 0,
                prep: u.isPreparingAutoAttack ? "auto" : (u.preparingAbilityHrid || "auto"), flags: Object.fromEntries(FLAGS.map(f => [f, !!u[f]])),
                counters: (Number(det.parry) || 0) + (Number(det.thorns) || 0) + (Number(det.retaliation) || 0) > 0, dotBy: {}, dotFrom: null, hrid: isPlayer ? null : u.hrid || null };
        }
        // A new wave. Returns the session it closed, if this battle is not the session's battle.
        function newBattle(m, at) {
            let closed = null;
            if (cur && cur.battleId !== m.battleId) closed = close(undefined, cur.result === "clear");
            else closeWave(true, at);
            if (!cur) open(m, at);
            const players = (m.players || []).map((u, i) => unit(u, i, true)), monsters = (m.monsters || []).map((u, i) => unit(u, i, false));
            battle = { p: players, m: monsters, startAt: at, lastAt: at, spawnHp: monsters.reduce((s, u) => s + u.hp, 0), lost: 0, healed: 0, unassigned: 0 };
            cur.waves++; cur.lastWave = Number(m.wave) || cur.lastWave; cur.lastAt = at;
            for (const u of players) { const p = cur.players[u.name] || (cur.players[u.name] = blankPlayer(u.name, u.id)); if (u.hp <= 0) u.dead = true; }
            cur.monsters = cur.monsters || {}; for (const u of monsters) if (u.hrid) cur.monsters[u.name] = u.hrid;
            return closed;
        }
        function update(m, at) {
            if (!battle || !cur || m.battleId !== cur.battleId) return false;
            battle.lastAt = at; cur.lastAt = at;
            const ch = [];
            for (const [side, map] of [["p", m.pMap], ["m", m.mMap]]) for (const [k, u] of Object.entries(map || {})) {
                const s = battle[side][Number(k)]; if (!s || !u) continue;
                const hp = u.cHP != null ? Number(u.cHP) : s.hp, atk = u.atkCounter != null ? Number(u.atkCounter) : s.atk, dmg = u.dmgCounter != null ? Number(u.dmgCounter) : s.dmg;
                const newly = FLAGS.some(f => u[f] === true && !s.flags[f]);
                const mp = u.cMP != null ? Number(u.cMP) : s.mp;
                const e = { s, side, dhp: hp - s.hp, dmp: side === "p" ? mp - (Number(s.mp) || 0) : 0, datk: atk - s.atk, ddmg: dmg - s.dmg, used: s.prep, newly };
                ch.push(e);
                s.hp = hp; s.atk = atk; s.dmg = dmg; s.mp = mp;
                for (const f of FLAGS) if (f in u) s.flags[f] = !!u[f];
                if ("isAutoAtk" in u || "abilityHrid" in u) s.prep = u.isAutoAtk ? "auto" : (u.abilityHrid || "auto");
            }
            const pa = ch.filter(e => e.side === "p" && e.datk > 0), ma = ch.filter(e => e.side === "m" && e.datk > 0 && !e.newly);
            const listed = ch.filter(e => e.side === "p");
            const P = e => cur.players[e.s.name] || (cur.players[e.s.name] = blankPlayer(e.s.name, e.s.id));
            const actor = pa.length === 1 ? pa[0] : null;
            if (actor) { const row = abilityRow(P(actor), actor.used); row.casts++; P(actor).casts++; }
            if (actor) { const inf = abilityOf(actor.used); if (inf && inf.lifeSteal) vamp[actor.s.name] = { until: at + inf.lifeSteal.ms + 1000, amt: inf.lifeSteal.flat + inf.lifeSteal.perLevel * ((actor.s.levels && actor.s.levels[actor.used]) || 0) }; }
            const monsterLoss = ch.reduce((a, x) => a + (x.side === "m" && x.dhp < 0 ? -x.dhp : 0), 0);
            // Mana: an ability's cost on the player acting, the regeneration tick, food and drink.
            {
                const gainers = ch.filter(x => x.side === "p" && x.dmp > 0).length;
                if (gainers >= 2 && !pa.length) { regenAt = at; for (const x of ch) if (x.side === "p" && x.dmp > 0 && !(x.s.mmp > 0 && x.s.mp >= x.s.mmp)) regenMp[x.s.name] = x.dmp; }
                for (const e of ch) {
                    if (e.side !== "p" || !e.dmp) continue;
                    const pl = P(e), mana = pl.mana || (pl.mana = { spent: {}, gain: {} });
                    const lone = e.dmp > 0 && gainers === 1 && onRegenClock(at) && regenTick(regenMp[e.s.name], e.dmp, e.s.mmp > 0 && e.s.mp >= e.s.mmp);
                    const lost = e.dmp < 0, key = lost ? (e.datk > 0 ? e.used : "other") : gainers >= 2 || lone ? "regen" : !pa.length && !ma.length ? "food" : e === actor && stolen(e.s.manaLeech, monsterLoss, e.dmp) ? "leech" : "other";
                    const t = lost ? mana.spent : mana.gain, r = t[key] || (t[key] = { amt: 0, n: 0 });
                    r.amt += Math.abs(e.dmp); r.n++;
                    if (lost) pl.mpSpent = (pl.mpSpent || 0) - e.dmp; else pl.mpGain = (pl.mpGain || 0) + e.dmp;
                }
            }
            // Damage to monsters.
            for (const e of ch) {
                if (e.side !== "m") continue;
                if (e.dhp > 0) { battle.healed += e.dhp; cur.monsterHealed += e.dhp; continue; }
                if (e.dhp === 0) { if (actor && e.ddmg > 0) { abilityRow(P(actor), actor.used).misses++; P(actor).misses++; } continue; }
                const dmg = -e.dhp; battle.lost += dmg; cur.monsterHpLost += dmg;
                let who = null, key = null;
                if (actor) { who = actor; key = actor.used; const info = abilityOf(key); if (info && info.dot) e.s.dotBy[actor.s.name] = key; }
                else if (!pa.length) {
                    // A monster acting: the listed player countered it (parry, or thorns when they took the hit).
                    // Nobody acting: the listed player's damage over time on it.
                    const cands = listed.length <= 1 ? listed : ma.length ? listed.filter(x => x.s.counters) : listed.filter(x => e.s.dotBy[x.s.name]);
                    if (cands.length === 1) { who = cands[0]; key = ma.length ? (who.dhp < 0 || !who.s.counters ? "thorns" : "parry") : `dot:${e.s.dotBy[who.s.name] || "?"}`; }
                }
                if (!who) { cur.unassigned += dmg; battle.unassigned += dmg; continue; }
                const p = P(who), row = abilityRow(p, key); p.dealt += dmg; row.dmg += dmg; row.hits++; p.hits++;
            }
            // Bloom (a weapon stat, the Blooming Trident's 0.35/0.38): a completed cast may heal the lowest-HP ally. In the
            // capture the one player with Bloom had a heal on exactly one player with 436 of 1,198 casts (36%, a Bloom on a
            // party at full HP shows nothing), and no other player's 2,343 casts ever came with a heal (operator,
            // 2026-11-23: "healing done" missed every Bloom). The gain on the lowest-HP player before the message is it;
            // Life Drain's own heal on its caster is not.
            let bloomTarget = null;
            if (actor && actor.used !== "auto" && actor.s.bloom > 0) {
                const info = abilityOf(actor.used);
                const cands = ch.filter(e => e.side === "p" && e.dhp > 0 && !(info && info.drain && e === actor));
                const pctBefore = e => (e.s.mhp > 0 ? (e.s.hp - e.dhp) / e.s.mhp : 1);
                if (cands.length) bloomTarget = cands.reduce((x, y) => (pctBefore(y) < pctBefore(x) ? y : x));
            }
            // Each source broken down (0.2.1, operator 2026-11-23): damage taken by the monster's ability (its card's
            // name before the message, the players' rule), thorns under the monster that has them, an over-time hit
            // under the monster and ability that applied it, the HP a player's own action cost; healing by kind.
            // In the capture: regeneration is a tick every 10 s on several players at once with nobody acting; food a
            // gain on one player alone with nobody acting, which for our own character lines up with the game's
            // consumable messages (donut instant, cake over 30 s); other players' foods are not announced.
            const sub = (o, src, k) => { const t = o[src] || (o[src] = {}); return t[k] || (t[k] = { amt: 0, hits: 0, misses: 0, n: 0 }); };
            const actorInfo = actor && abilityOf(actor.used);
            const creditedHeal = x => x === bloomTarget || !!(actorInfo && (actorInfo.heal || (actorInfo.drain && actor === x)));
            const plainGains = ch.filter(x => x.side === "p" && x.dhp > 0 && !creditedHeal(x)).length;
            // What each player's regeneration tick gives, learnt from ticks on the clock with several players healing.
            if (plainGains >= 2 && !pa.length && onRegenClock(at)) for (const x of ch) if (x.side === "p" && x.dhp > 0 && !creditedHeal(x) && x.s.hp < x.s.mhp) regenHp[x.s.name] = x.dhp;
            const foodOf = (name, t) => { const f = (foods[name] || []).slice().reverse().find(x => t >= x.at - 1500 && t <= x.at + x.overMs + 1500); return f ? `food:${f.item}` : "food"; };
            // Players: damage taken, healing, deaths. A splat with no HP lost while a monster acts: its attack missed.
            for (const e of ch) {
                if (e.side === "p" && !e.dhp && e.ddmg > 0 && ma.length) { const p = P(e), src = ma[0].s.name; p.takenMiss[src] = (p.takenMiss[src] || 0) + 1; sub(p.takenSub || (p.takenSub = {}), src, ma[0].used).misses++; continue; }
                if (e.side !== "p" || !e.dhp) continue;
                const p = P(e);
                if (e.dhp < 0) {
                    const dmg = -e.dhp; p.taken += dmg;
                    let src, how;
                    if (ma.length) { src = ma[0].s.name; how = ma[0].used; const inf = abilityOf(how); if (inf && inf.dot) e.s.dotFrom = { src, ability: how }; }
                    else if (e.datk > 0) { const thorn = ch.find(x => x.side === "m" && x.s.counters && (x.dhp < 0 || x.ddmg > 0)); if (thorn) { src = thorn.s.name; how = "thorns"; } else { src = "Own actions (HP cost)"; how = `cost:${e.used}`; } }
                    else if (e.s.dotFrom) { src = e.s.dotFrom.src; how = `dot:${e.s.dotFrom.ability}`; }
                    else { src = "Damage over time"; how = "dot:?"; }
                    p.takenBy[src] = (p.takenBy[src] || 0) + dmg; p.takenHits[src] = (p.takenHits[src] || 0) + 1;
                    const r = sub(p.takenSub || (p.takenSub = {}), src, how); r.amt += dmg; r.hits++;
                    if (e.s.hp <= 0 && !e.s.dead) { e.s.dead = true; p.deaths++; }
                } else {
                    const gain = e.dhp; p.healed += gain; if (e.s.hp > 0) e.s.dead = false;
                    const info = actor && abilityOf(actor.used);
                    const bloom = e === bloomTarget;
                    const healer = bloom || (info && (info.heal || (info.drain && actor === e))) ? actor : null;
                    const how = bloom ? "bloom" : actor && actor.used;
                    const key = !healer ? "regen" : healer.s.name === e.s.name ? how : `${healer.s.name}: ${how}`;
                    if (healer) { const h = P(healer), row = abilityRow(h, how); h.healDone += gain; row.heal += gain; if (bloom) row.hits++; }
                    p.healBy[key] = (p.healBy[key] || 0) + gain; p.healHits[key] = (p.healHits[key] || 0) + 1;
                    if (!healer) { const named = foodOf(e.s.name, at), quiet = !pa.length && !ma.length; const kind = plainGains >= 2 ? "regen" : onRegenClock(at) && regenTick(regenHp[e.s.name], gain, e.s.hp >= e.s.mhp) ? "regen" : quiet ? (listed.length >= 2 ? "regen" : named) : named !== "food" ? named : e === actor && stolen(lifeStealOf(e.s, at), monsterLoss, gain) ? "lifesteal" : "other"; const r = sub(p.healSub || (p.healSub = {}), "regen", kind); r.amt += gain; r.n++; }
                }
            }
            return true;
        }
        // A copy of the session as it stands, the wave in progress counted up to now while battle messages are still
        // coming (within 15 s of the last), else to its last message.
        function snapshot(now) {
            if (!cur) return null;
            const s = JSON.parse(JSON.stringify(cur));
            if (battle) { const end = now != null && now - battle.lastAt < 15000 ? Math.max(now, battle.lastAt) : battle.lastAt; s.combatMs += Math.max(0, end - battle.startAt); }
            s.live = true; s.seq = ++seq;
            return s;
        }
        function restore(s) { cur = s && typeof s === "object" ? s : null; battle = null; }
        // A piece of the same battle kept by an earlier page (a reload mid-run): joined to the session in progress, or
        // taken up as it when none is. Refused when the pieces overlap or belong to another battle.
        function stitch(saved) {
            if (!saved || !saved.players) return false;
            if (!cur) { restore(saved); return true; }
            if (cur.battleId !== saved.battleId || num(saved.lastWave) >= num(cur.firstWave)) return false;
            meterAdd(cur, saved);
            for (const k of ["zone", "tier", "runId"]) if (cur[k] == null && saved[k] != null) cur[k] = saved[k];
            cur.stitched = (cur.stitched || 0) + (saved.stitched || 0) + 1;
            return true;
        }
        const num = v => Number(v) || 0;
        // Our own food, from the game's consumable messages (only our own are sent): the item and how long it heals.
        const foods = {};
        function food(name, item, at, overMs) { const l = foods[name] || (foods[name] = []); l.push({ item, at, overMs: Number(overMs) || 0 }); if (l.length > 6) l.shift(); }
        return { newBattle, update, close, snapshot, restore, stitch, food, get session() { return cur; }, get inWave() { return !!battle; } };
    }
    // Adds one session's counts into another: a run stitched across a reload, or the all-seen total of a dungeon.
    function meterAdd(dst, src) {
        const sum = (a, b, keys) => { for (const k of keys) a[k] = (Number(a[k]) || 0) + (Number(b[k]) || 0); };
        dst.players = dst.players || {};
        if (src.monsters) dst.monsters = Object.assign(dst.monsters || {}, src.monsters);
        sum(dst, src, ["waves", "combatMs", "monsterHpLost", "monsterHealed", "unassigned"]);
        dst.check = dst.check || { waves: 0, balanced: 0, gap: 0 }; sum(dst.check, src.check || {}, ["waves", "balanced", "gap"]);
        const lo = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b)), hi = (a, b) => (a == null ? b : b == null ? a : Math.max(a, b));
        dst.startAt = lo(dst.startAt, src.startAt); dst.lastAt = hi(dst.lastAt, src.lastAt); dst.endAt = hi(dst.endAt, src.endAt);
        dst.firstWave = lo(dst.firstWave, src.firstWave); dst.lastWave = hi(dst.lastWave, src.lastWave);
        for (const [name, p] of Object.entries(src.players || {})) {
            const q = dst.players[name] || (dst.players[name] = { name, id: p.id || null, dealt: 0, hits: 0, misses: 0, casts: 0, taken: 0, healed: 0, healDone: 0, deaths: 0, abilities: {}, takenBy: {}, healBy: {}, takenHits: {}, takenMiss: {}, healHits: {} });
            sum(q, p, ["dealt", "hits", "misses", "casts", "taken", "healed", "healDone", "deaths"]);
            if (p.mana) { sum(q, p, ["mpSpent", "mpGain"]); q.mana = q.mana || { spent: {}, gain: {} }; for (const side of ["spent", "gain"]) for (const [k, r] of Object.entries(p.mana[side] || {})) sum(q.mana[side][k] || (q.mana[side][k] = {}), r, ["amt", "n"]); }
            for (const [k, a] of Object.entries(p.abilities || {})) sum(q.abilities[k] || (q.abilities[k] = {}), a, ["dmg", "hits", "misses", "casts", "heal"]);
            for (const o of ["takenBy", "healBy", "takenHits", "takenMiss", "healHits"]) { if (!p[o]) continue; q[o] = q[o] || {}; for (const [k, v] of Object.entries(p[o])) q[o][k] = (q[o][k] || 0) + (Number(v) || 0); }
            for (const o of ["takenSub", "healSub"]) for (const [srcKey, subs] of Object.entries(p[o] || {})) { q[o] = q[o] || {}; const qs = q[o][srcKey] || (q[o][srcKey] = {}); for (const [k, r] of Object.entries(subs)) sum(qs[k] || (qs[k] = {}), r, ["amt", "hits", "misses", "n"]); }
        }
        return dst;
    }
    // Ability facts the meter needs, from the game's abilityDetailMap: heals, drains, damage over time.
    function meterAbilityInfo(detail) {
        const fx = (detail && detail.abilityEffects) || [];
        const ls = fx.flatMap(e => e.buffs || []).find(b => b && b.typeHrid === "/buff_types/life_steal");
        const out = { heal: fx.some(e => /\/(heal|revive)$/.test(String(e.effectType || ""))), drain: fx.some(e => Number(e.hpDrainRatio) > 0), dot: fx.some(e => Number(e.damageOverTimeRatio) > 0) };
        if (ls) out.lifeSteal = { flat: Number(ls.flatBoost) || 0, perLevel: Number(ls.flatBoostLevelBonus) || 0, ms: (Number(ls.duration) || 0) / 1e6 };
        return out;
    }
    // </meter>

    state.meter = createMeter({ ability: h => (ref.abilities && ref.abilities[h] && ref.abilities[h].meter) || null });
    // A session is one battle id: a dungeon run, or a stretch on a planet, however long. It ends with the next battle
    // id or the run's end (a few seconds later, so the last wave's final hits are in). The session in progress is kept
    // in meta at every wave and every 5 s, and a reload stitches it back together (operator, 2026-11-23). Saved as a
    // "damage" event only when it is whole: a planet stretch always; a dungeon run only when seen from wave 1 to its
    // end with no wave missing. Anything less goes into the dungeon's all-seen total (meta "damagePartial", by zone and
    // tier), so its abilities still count in the averages.
    const METER_SETTLE_MS = 5000, METER_STALE_MS = 10 * 60e3;
    let meterLast = null, meterCheckpointAt = 0;
    function meterWhole(s) {
        if (!s || !ref.dungeons[s.zone]) return true;
        return num(s.firstWave) === 1 && num(s.waves) === num(s.lastWave) && ["clear", "fail", "stop"].includes(s.result);
    }
    function meterPartial(s) {
        const key = `${s.zone || "?"}|${s.tier ?? ""}`, all = isObj(state.meta.damagePartial) ? state.meta.damagePartial : {};
        const agg = all[key] || { zone: s.zone || null, tier: s.tier ?? null, players: {}, pieces: 0 };
        meterAdd(agg, s); agg.pieces = (agg.pieces || 0) + 1;
        all[key] = agg; state.meta.damagePartial = all;
        if (state.record) state.record.queue("meta", { key: "damagePartial", value: all });
    }
    function meterCheckpoint() {
        const s = state.meter.session; if (!s || !state.record || !state.ready || s.lastAt === meterCheckpointAt) return;
        const snap = state.meter.snapshot(); delete snap.live; delete snap.seq;
        state.record.queue("meta", { key: "meterOpen", value: snap }); meterCheckpointAt = s.lastAt;
    }
    let meterZoneLast = null;   // the last place a session was tagged with: {zone, tier, at}
    function meterTag(s) {
        if (!s) return;
        if (!s.zone) {
            const a = currentAction(), run = state.run && state.run.battleId === s.battleId ? state.run : null;
            if (a) { s.zone = a.actionHrid; s.tier = num(a.difficultyTier); }
            else if (run) { s.zone = run.zone; s.tier = run.tier; }
            else if (meterZoneLast && serverNow() - meterZoneLast.at < METER_STALE_MS) { s.zone = meterZoneLast.zone; s.tier = meterZoneLast.tier; }
        }
        if (s.zone) meterZoneLast = { zone: s.zone, tier: s.tier, at: serverNow() };
        if (!s.runId && state.run && state.run.battleId === s.battleId) s.runId = state.run.id;
    }
    const meterInCombat = () => { const s = state.meter.session; return !!(currentAction() || state.run || (s && serverNow() - num(s.lastAt) < 60e3)); };
    function meterSave(s, result) {
        if (!s || !s.waves || !s.players || !Object.keys(s.players).length) return null;
        delete s.live; delete s.seq; delete s.closeAfter;
        if (result) s.result = result;
        meterTag(s);
        if (state.record) state.record.queue("meta", { key: "meterOpen", value: null });
        meterCheckpointAt = 0;
        if (!meterWhole(s)) { meterPartial(s); return null; }
        // The same run saved once only (battle ids repeat over days, so the start time decides).
        if (state.damage.some(e => e.battleId === s.battleId && num(e.startAt) === num(s.startAt) && e.zone === s.zone)) return null;
        const ev = emit("damage", s, "battle", s.endAt || s.lastAt);
        state.damage.push(ev);
        return ev;
    }
    // The battle tab's running total (operator, 2026-11-23): every session closed on this page since the party went
    // into combat, whole runs and parts alike. It ends when the combat action leaves the queue, the place or tier
    // changes, or ten minutes pass with no battle; a reload starts it again.
    function streakAdd(s) {
        if (!s || !s.players || !Object.keys(s.players).length) return;
        const k = `${s.zone || "?"}|${s.tier ?? ""}`;
        if (!state.streak || state.streak.key !== k) state.streak = { key: k, streak: true, zone: s.zone || null, tier: s.tier ?? null, players: {}, runs: 0 };
        const gap = num(s.startAt) - num(state.streak.lastAt);
        if (state.streak.runs && gap > 0 && gap < 120e3) state.streak.combatMs = num(state.streak.combatMs) + gap;
        // "N runs" counts runs, not pieces (operator, 2026-11-23: "2 runs" matched nothing): two pieces of one run,
        // either side of a reload or a reset, are one run.
        const ids = state.streak.ids || (state.streak.ids = []);
        if (s.battleId == null || !ids.includes(s.battleId)) { state.streak.runs++; if (s.battleId != null) ids.push(s.battleId); }
        meterAdd(state.streak, s);
    }
    function streakCheck() {
        const st = state.streak, s = state.meter.session; if (!st) return;
        if (!meterInCombat() || (s && s.zone && `${s.zone}|${s.tier ?? ""}` !== st.key) || serverNow() - num(st.lastAt) > METER_STALE_MS && !(s && serverNow() - num(s.lastAt) < METER_STALE_MS)) state.streak = null;
    }
    function meterClosed(s, result) { if (result) s.result = result; if (s.battleId !== meterNoStreakBattle) streakAdd(s); else meterNoStreakBattle = null; return meterSave(s); }
    // Off (Settings → Damage meter, 0.2.1, operator 2026-11-23: some play on very old PCs): battle messages are not read
    // at all, nothing is recorded, and the battle-tab meter and the Damage tab are hidden.
    const METER_OFF_KEY = PANEL_KEY + "-meter";
    const meterEnabled = () => { try { return localStorage.getItem(METER_OFF_KEY) !== "off"; } catch (_e) { return true; } };
    function meterDisable() {
        state.meter.restore(null); state.streak = null; meterLast = null; meterCheckpointAt = 0;
        if (state.record) state.record.queue("meta", { key: "meterOpen", value: null });
    }
    // After Reset damage data the meter records again from the next wave, but the rest of the run the reset was
    // pressed in never joins the battle tab's All runs total (operator, 2026-11-23: All runs held the last 15 waves of
    // that run and did not match the Damage tab). Skipping the rest of the run instead left the meter blank until the
    // next run, and on a planet, whose battle id never changes, for good.
    let meterNoStreakBattle = null;
    // Our own recent foods, kept across a reload (operator, 2026-11-23: an unnamed "Food" row): a cake eaten just
    // before a reload still heals after it, and the page that reloads never saw it eaten.
    const METER_FOODS_KEY = "mds-meterfoods-v1";
    function meterFoodKeep(f) { try { const l = JSON.parse(localStorage.getItem(METER_FOODS_KEY) || "[]"); l.push(f); localStorage.setItem(METER_FOODS_KEY, JSON.stringify(l.slice(-6))); } catch (_e) { /* fine */ } }
    function meterFoodRestore() {
        if (state.meterFoodsRestored) return; state.meterFoodsRestored = true;
        try { const now = serverNow(); for (const f of JSON.parse(localStorage.getItem(METER_FOODS_KEY) || "[]")) if (f && f.who === state.characterName && f.item && now <= Number(f.at) + (Number(f.overMs) || 0) + 60e3) state.meter.food(f.who, f.item, Number(f.at), f.overMs); } catch (_e) { /* fine */ }
    }
    function meterOnNewBattle(m) {
        if (!meterEnabled()) return;
        meterFoodRestore();
        if (meterLast && meterLast.battleId === m.battleId && meterLast.wave === num(m.wave)) return; // duplicate roster send
        meterLast = { battleId: m.battleId, wave: num(m.wave) };
        const closed = state.meter.newBattle(m, serverNow());
        if (closed) meterClosed(closed);
        meterTag(state.meter.session); streakCheck(); meterCheckpoint(); panel.meterPing();
    }
    function meterOnUpdate(m) { if (!meterEnabled()) return; state.meter.update(m, serverNow()); panel.meterPing(); }
    // A run that ended: its session closes once the last messages are in. A clear counts its last wave in the check.
    function meterRunEnded(run, result) {
        const s = state.meter.session; if (!s || !run || (s.runId !== run.id && s.battleId !== run.battleId)) return;
        s.result = result; s.closeAfter = serverNow() + METER_SETTLE_MS;
    }
    setInterval(() => {
        try {
            const s = state.meter.session; if (!s) return;
            if (s.closeAfter && serverNow() >= s.closeAfter) { const r = s.result; meterClosed(state.meter.close(undefined, r === "clear"), r); panel.touch(); return; }
            if (Date.now() % 5000 < 1000) meterCheckpoint();
        } catch (error) { warn("damage meter timer", error); }
    }, 1000);

    // ---------------------------------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------------------------------
    const listeners = new Set();
    function addConsume(ev) { const t = state.consumeTotals.get(ev.item) || { qty: 0, cost: 0, unknownQty: 0 }; t.qty += num(ev.qty); if (ev.unitCost != null) t.cost += ev.unitCost * num(ev.qty); else t.unknownQty += num(ev.qty); state.consumeTotals.set(ev.item, t); }
    function emit(kind, fields, src, at, clockKind) {
        const ev = { id: newId(), kind, at: at || serverNow(), clock: clockKind || (at ? "server" : (clock.known ? "local+offset" : "local")), src: src || null, v: 1, ...fields };
        if (state.record) state.record.queue("events", ev);
        state.counts.events++;
        state.events.unshift(ev); if (state.events.length > 400) state.events.length = 400;
        if (kind === "consume") addConsume(ev); else if (kind !== "damage") { state.timeline.push(ev); state.timelineRev++; }
        for (const l of listeners) { try { l(ev); } catch (_e) { /* a panel error never stops recording */ } }
        return ev;
    }
    function review(reason, fields, src) { state.reviews++; return emit("review", { reason, ...fields }, src); }

    // ---------------------------------------------------------------------------------------------------------------
    // Raw frame retention for the open questions. Bounded per rule.
    // ---------------------------------------------------------------------------------------------------------------
    const FRAME_RULES = [
        { name: "first-of-type", max: 3, test: () => true, trim: trimFrame },
        { name: "party-chat", max: 2000, test: (t, m) => t === "chat_message_received" && m.message && m.message.chan === "/chat_channel_types/party" && m.message.isSystemMessage },
        { name: "loot-opened", max: 300, test: t => t === "loot_opened" },
        { name: "consumable", max: 40, test: (t, m) => t === "battle_consumable_ability_updated" && m.consumable },
        { name: "action-items", max: 300, test: (t, m) => t === "action_completed" && Array.isArray(m.endCharacterItems) && m.endCharacterItems.length > 0 },
        { name: "action-done", max: 40, test: (t, m) => (t === "action_completed" && m.endCharacterAction && m.endCharacterAction.isDone) || t === "actions_updated" },
        { name: "run-start", max: 100, test: (t, m) => t === "new_battle" && num(m.wave) <= 1, trim: trimFrame },
        { name: "market", max: 400, test: t => t === "market_listings_updated" || t === "post_market_order" },
        { name: "login", max: 10, test: t => t === "init_character_data", trim: trimLogin },
    ];
    function trimFrame(type, m) {
        if (type !== "new_battle") return m;
        const self = (m.players || []).find(p => p && p.character && String(p.character.id) === state.characterId) || null;
        return { type, battleId: m.battleId, wave: m.wave, combatStartTime: m.combatStartTime, playerCount: (m.players || []).length, players: (m.players || []).map(p => ({ name: p.character && p.character.name, id: p.character && p.character.id })), self: self && { totalSkillExperienceMap: self.totalSkillExperienceMap, totalLootMap: self.totalLootMap, deathCount: self.deathCount, combatConsumables: self.combatConsumables } };
    }
    function trimLogin(type, m) {
        const out = { type, keys: Object.keys(m), currentTimestamp: m.currentTimestamp, character: m.character && { id: m.character.id, name: m.character.name, lastOfflineTime: m.character.lastOfflineTime, inactiveTime: m.character.inactiveTime }, offlineItems: m.offlineItems, offlineSkills: m.offlineSkills, myMarketListings: m.myMarketListings };
        const chat = m.partyChatHistory || (m.chatHistoryByChannelMap && m.chatHistoryByChannelMap["/chat_channel_types/party"]);
        out.partyChatHistoryLength = Array.isArray(chat) ? chat.length : null; out.partyChatHistorySample = Array.isArray(chat) ? chat.slice(-12) : (chat === undefined ? "absent" : chat);
        out.chatHistoryKeys = m.chatHistoryByChannelMap ? Object.keys(m.chatHistoryByChannelMap) : null;
        return out;
    }
    function retainFrame(type, msg, direction) {
        if (!state.record) return;
        for (const rule of FRAME_RULES) {
            const k = `${rule.name}:${type}`;
            const n = state.frameCounts.get(k) || 0;
            if (n >= rule.max) continue;
            let ok = false; try { ok = rule.test(type, msg); } catch (_e) { ok = false; }
            if (!ok) continue;
            state.frameCounts.set(k, n + 1);
            const body = rule.trim ? rule.trim(type, msg) : msg;
            state.record.queue("frames", { id: newId(), type, rule: rule.name, direction: direction || "in", at: serverNow(), body: clone(body) });
            return;
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Inventory mirror
    // ---------------------------------------------------------------------------------------------------------------
    const INV = "/item_locations/inventory";
    function applyRows(rows, replace) {
        const diffs = [];
        if (!Array.isArray(rows)) return diffs;
        if (replace) state.inventory.clear();
        for (const row of rows) {
            if (!isObj(row) || !row.itemHrid) continue;
            const hash = row.hash || `${row.characterID}::${row.itemLocationHrid}::${row.itemHrid}::${row.enhancementLevel || 0}`;
            const prev = state.inventory.get(hash);
            const count = num(row.count);
            const before = prev ? num(prev.count) : 0;
            const next = { hash, itemHrid: row.itemHrid, itemLocationHrid: row.itemLocationHrid, enhancementLevel: num(row.enhancementLevel), count, id: row.id };
            if (count <= 0) state.inventory.delete(hash); else state.inventory.set(hash, next);
            if (!replace && count !== before && row.itemLocationHrid === INV) diffs.push({ item: row.itemHrid, level: num(row.enhancementLevel), delta: count - before, count, hash });
            if (state.record) { if (count <= 0) state.record.remove("inventory", hash); else state.record.queue("inventory", next); }
        }
        return diffs;
    }
    function held(itemHrid, level = 0) { let n = 0; for (const r of state.inventory.values()) if (r.itemHrid === itemHrid && r.itemLocationHrid === INV && r.enhancementLevel === level) n += r.count; return n; }
    function coins() { return held("/items/coin", 0); }
    // Artisan buffs per action type, from any message that carries the game's consumable buff map (login, tea changes).
    const TEA_SECONDS = 300; // every tea lasts 300 s of action time
    function noteBuffs(m) {
        const map = m && m.consumableActionTypeBuffsMap; if (!isObj(map)) return false;
        const slots = isObj(m.actionTypeDrinkSlotsMap) ? m.actionTypeDrinkSlotsMap : null;
        let changed = false;
        for (const [type, buffs] of Object.entries(map)) {
            const b = (Array.isArray(buffs) ? buffs : []).find(x => x && x.typeHrid === "/buff_types/artisan");
            const rate = b ? num(b.flatBoost) : 0;
            const teaSlot = slots && Array.isArray(slots[type]) ? slots[type].find(sl => sl && /artisan/.test(String(sl.itemHrid))) : null;
            const tea = teaSlot ? teaSlot.itemHrid : (b && b.uniqueHrid ? b.uniqueHrid.replace("/buff_uniques/", "/items/") : null);
            const prev = state.artisan[type];
            if (!prev || prev.rate !== rate || prev.tea !== tea) { state.artisan[type] = { rate, tea: rate ? tea : null, at: serverNow() }; changed = true; }
        }
        if (changed && state.record) state.record.queue("meta", { key: "artisan", value: state.artisan });
        return changed;
    }
    const artisanOf = actionHrid => { const r = ref.keyActions[actionHrid]; const a = state.artisan[(r && r.type) || "/action_types/crafting"]; return a && a.rate > 0 ? { rate: a.rate, tea: a.tea, teaSeconds: TEA_SECONDS, seconds: (r && r.seconds) || 10 } : null; };
    // What one key would cost to craft now: the recipe at purchase ledger prices (asks for materials never bought),
    // every input cut by the artisan rate, plus the tea's share of the craft time. Null when a material has no price.
    function recipePriceNow(keyItem) {
        for (const [action, r] of Object.entries(ref.keyActions)) {
            const out = r.outputs.find(o => o.item === keyItem); if (!out || !(out.qty > 0)) continue;
            const art = artisanOf(action); const cut = art ? 1 - art.rate : 1;
            let cost = 0, asks = 0;
            for (const i of r.inputs) { if (i.item === "/items/coin") { cost += i.qty * cut; continue; } const a = ledgerAvg(i.item); const p = a != null ? a : askOf(i.item); if (p == null) return null; if (a == null) asks++; cost += p * i.qty * cut; }
            if (art && art.tea) { const a = ledgerAvg(art.tea); const p = a != null ? a : askOf(art.tea); if (p != null) cost += p * art.seconds / art.teaSeconds; }
            return { unitCost: cost / out.qty, basis: `craft price${art ? `, artisan ${(art.rate * 100).toFixed(1)}%` : ""}` };
        }
        return null;
    }
    // Quantity sitting on your own open sell orders (left the bag, not sold yet).
    function listedQty(itemHrid, level = 0) { let n = 0; for (const l of state.listings.values()) if (l.isSell && l.itemHrid === itemHrid && l.level === level && !/cancel|filled|expired/i.test(String(l.status || "")) && l.orderQuantity > l.filledQuantity) n += l.orderQuantity - l.filledQuantity; return n; }

    // ---------------------------------------------------------------------------------------------------------------
    // Purchase ledger (running average per item) and key lots (first crafted, first used)
    // ---------------------------------------------------------------------------------------------------------------
    function ledgerAdd(item, qty, unitCost) {
        if (!(qty > 0) || !(unitCost >= 0)) return;
        const e = state.ledger.get(item) || { qty: 0, cost: 0 };
        e.qty += qty; e.cost += qty * unitCost; state.ledger.set(item, e);
    }
    function ledgerAvg(item) { const e = state.ledger.get(item); return e && e.qty > 0 ? e.cost / e.qty : null; }
    // Charges qty against the ledger. Returns the average charged and how much of qty the ledger actually covered;
    // the uncovered part has no known price and the caller says so instead of guessing.
    function ledgerTake(item, qty) { const e = state.ledger.get(item); if (!e || !(e.qty > 0)) return { avg: null, covered: 0 }; const avg = e.cost / e.qty; const take = Math.min(qty, e.qty); e.qty -= take; e.cost -= take * avg; if (e.qty <= 1e-9) { e.qty = 0; e.cost = 0; } return { avg, covered: take }; }
    const isKeyMaterial = hrid => Object.values(ref.keyActions).some(r => r.inputs.some(i => i.item === hrid && i.item !== "/items/coin"));
    function keyLotAdd(item, qty, unitCost, basis, craftId) { const lots = state.keyLots.get(item) || []; lots.push({ qty, unitCost, basis, craftId }); state.keyLots.set(item, lots); }
    function keyLotTake(item, qty) {
        const lots = state.keyLots.get(item) || []; let left = qty, cost = 0, basis = new Set(), taken = 0;
        while (left > 0 && lots.length) { const lot = lots[0]; const t = Math.min(left, lot.qty); lot.qty -= t; left -= t; taken += t; cost += t * lot.unitCost; basis.add(lot.basis); if (lot.qty <= 0) lots.shift(); }
        if (left > 0) { const fallback = keyAverage(item) ?? askOf(item); if (fallback != null) { cost += left * fallback; basis.add(keyAverage(item) != null ? "average" : "ask"); } else basis.add("unknown"); }
        return { unitCost: qty > 0 ? cost / qty : null, basis: [...basis].join("+"), fromLots: taken };
    }
    const keyAverages = new Map(); // keyItem -> {qty, cost} of observed crafts
    function keyAverage(item) { const e = keyAverages.get(item); return e && e.qty > 0 ? e.cost / e.qty : null; }

    // ---------------------------------------------------------------------------------------------------------------
    // Lifetime XP
    // ---------------------------------------------------------------------------------------------------------------
    function applySkills(rows) {
        const deltas = {};
        if (!Array.isArray(rows)) return deltas;
        for (const r of rows) {
            if (!isObj(r) || !r.skillHrid || r.skillHrid === "/skills/total_level") continue;
            const xp = num(r.experience); const prev = state.lifetimeXp[r.skillHrid];
            if (prev != null && xp > prev) deltas[r.skillHrid] = xp - prev;
            state.lifetimeXp[r.skillHrid] = xp; if (r.level != null) state.levels[r.skillHrid] = num(r.level);
        }
        return deltas;
    }
    function applyAbilities(rows) {
        const deltas = {};
        if (!Array.isArray(rows)) return deltas;
        xpAbilityStart(); // the snapshot is the totals before this message
        for (const r of rows) {
            if (!isObj(r) || !r.abilityHrid) continue;
            const xp = num(r.experience); const prev = state.lifetimeAbilityXp[r.abilityHrid];
            if (prev != null && xp > prev) deltas[r.abilityHrid] = xp - prev;
            state.lifetimeAbilityXp[r.abilityHrid] = xp; if (r.level != null) state.levels[r.abilityHrid] = num(r.level);
        }
        return deltas;
    }
    const levelOf = xp => { const t = ref.levelTable; if (!t.length) return null; let l = 0; for (let i = 1; i < t.length; i++) { if (xp >= t[i]) l = i; else break; } return l; };
    const toNextLevel = (xp, level) => { const t = ref.levelTable; const l = level != null && t[level + 1] > xp ? level : levelOf(xp); return l != null && t[l + 1] != null ? Math.max(0, t[l + 1] - xp) : null; };
    const xpSnapshot = () => ({ ...state.lifetimeXp });

    // XP record (milestone 4): one permanent record, no sessions. XP since the record began is the lifetime total the
    // game reports now minus the total at the record's start, per skill, so it is exact however often the script was
    // off and includes offline play. Active time is what the XP/h rate runs over: the time between XP messages when
    // that gap is 15 minutes or less, plus offline time that earned XP. A snapshot of the lifetime totals is kept at
    // the start of each day (server clock) so the tab can show today and the past days. Meta "xpRecord".
    const XP_GAP_MS = 15 * 60e3, XP_DAYS_KEEP = 90;
    // Days are on the player's own clock (2026-11-01: UTC days restarted "today" at 5 pm for a UTC-7 player).
    const xpDayKey = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    function xpRec() {
        if (!state.xpRec) {
            const m = state.meta && isObj(state.meta.xpRecord) ? state.meta.xpRecord : null;
            state.xpRec = m ? { startAt: num(m.startAt) || null, startSnap: isObj(m.startSnap) ? m.startSnap : null, activeMs: num(m.activeMs), offlineMs: num(m.offlineMs), lastTickAt: num(m.lastTickAt) || 0, days: isObj(m.days) ? m.days : {} } : { startAt: null, startSnap: null, activeMs: 0, offlineMs: 0, lastTickAt: 0, days: {} };
            // Buckets keyed by a UTC day from the first build: one dated after today on this clock folds into today.
            const R = state.xpRec, today = xpDayKey(serverNow());
            for (const k of Object.keys(R.days)) if (k > today) { const b = R.days[k]; const t = R.days[today]; if (t) { t.activeMs += num(b.activeMs); t.offlineMs += num(b.offlineMs); } else R.days[today] = b; R.days[k] = undefined; delete R.days[k]; xpSave(); }
        }
        return state.xpRec;
    }
    function xpSave() { if (state.record && state.ready) state.record.queue("meta", { key: "xpRecord", value: xpRec() }); }
    // The start snapshot: taken when the record starts. A record from before this build takes the earliest lifetime
    // snapshot a clear left in its timeline (xpEnd), else the totals at the moment this build first saw them.
    // XP the game's Loot & XP Log puts between two times: exact for a session inside the window, split by time for a
    // session that straddles an edge (its XP runs with the action, so the split is close; it is labelled).
    function xpFromLootLog(from, to) {
        const xp = {}; let coveredMs = 0, split = false, sessions = 0;
        for (const e of state.lootLog.values()) {
            const s0 = num(e.start), s1 = num(e.end) || s0; if (!(s1 > from) || !(s0 < to) || !(s1 > s0)) continue;
            const lo = Math.max(s0, from), hi = Math.min(s1, to); const f = (hi - lo) / (s1 - s0); if (f < 0.999) split = true;
            coveredMs += hi - lo; sessions++;
            for (const [k, v] of Object.entries(e.xp || {})) if (v > 0 && k !== "/skills/total_level") xp[k] = (xp[k] || 0) + v * f;
        }
        return { xp, coveredMs, split, sessions };
    }
    // The start snapshot. A new record takes it when it starts. A record from before this build: the earliest lifetime
    // snapshot a clear left in its timeline (xpEnd), backed to the record start with the Loot & XP Log's XP for the
    // time between, and active time backfilled from the log's session time; else the totals when first seen.
    function xpEnsureStart(at) {
        const R = xpRec(); if (R.startSnap && R.basis) return R;
        const now = at || serverNow();
        let snap = null, when = null, basis = null;
        for (const e of state.timeline) if ((e.kind === "clear" || e.kind === "fail") && isObj(e.xpEnd) && Object.keys(e.xpEnd).length) { snap = { ...e.xpEnd }; when = e.at; basis = "earliest clear snapshot"; break; }
        if (!snap && Object.keys(state.lifetimeXp).length) { snap = { ...state.lifetimeXp }; when = now; basis = "totals when first seen"; }
        if (!snap) return R;
        delete snap["/skills/total_level"];
        const rs = num(state.meta.recordStart);
        if (rs > 0 && rs < when - 60e3) {
            const back = xpFromLootLog(rs, when);
            if (back.coveredMs > 0) { for (const [k, v] of Object.entries(back.xp)) snap[k] = Math.max(0, (snap[k] != null ? snap[k] : 0) - v); basis = `${basis}, then the Loot & XP Log back to the record start${back.split ? ", one session split by time" : ""}`; when = rs; }
            else basis += " (nothing in the Loot & XP Log before it)";
        }
        R.startSnap = snap; R.startAt = when; R.basis = basis;
        // Active time before this build ran: the log's session time from the start to now, once.
        const fill = xpFromLootLog(when, now); const prior = R.activeMs;
        if (fill.coveredMs > prior) R.activeMs = fill.coveredMs;
        R.lastTickAt = now;
        const k = xpDayKey(when); if (R.days[k]) { R.days[k].snap = { ...snap }; if (k === xpDayKey(now) && R.activeMs > R.days[k].activeMs) R.days[k].activeMs = R.activeMs; }
        xpSave();
        info(`XP record start ${new Date(when).toISOString()}: ${basis}; active time backfilled ${Math.round(fill.coveredMs / 60000)} min from ${fill.sessions} log sessions`);
        return R;
    }
    // Abilities: the Loot & XP Log has no ability XP, so there is nothing to back a start to; the snapshot is taken
    // when this build first sees the abilities (with the record start when that is the same moment).
    function xpAbilityStart() {
        const R = xpRec(); if (R.startAbil || !Object.keys(state.lifetimeAbilityXp).length) return R;
        R.startAbil = { ...state.lifetimeAbilityXp }; R.startAbilAt = serverNow(); xpSave();
        info(`XP record: ability snapshot taken at ${new Date(R.startAbilAt).toISOString()}`);
        return R;
    }
    function xpDay(R, at, snapBefore) { const k = xpDayKey(at); let d = R.days[k]; if (!d) { const sameDayStart = R.startSnap && R.startAt && xpDayKey(R.startAt) === k; d = R.days[k] = { snap: { ...(sameDayStart ? R.startSnap : snapBefore) }, activeMs: 0, offlineMs: 0 }; delete d.snap["/skills/total_level"]; const keys = Object.keys(R.days).sort(); while (keys.length > XP_DAYS_KEEP) delete R.days[keys.shift()]; } return d; }
    function xpTick(deltas, at) {
        at = at || serverNow(); const R = xpEnsureStart(at); if (!R.startSnap) return;
        const before = {}; for (const [k, v] of Object.entries(state.lifetimeXp)) before[k] = v - (deltas[k] || 0);
        const d = xpDay(R, at, before);
        const gap = at - R.lastTickAt; if (R.lastTickAt && gap > 0 && gap <= XP_GAP_MS) { R.activeMs += gap; d.activeMs += gap; }
        if (at > R.lastTickAt) R.lastTickAt = at;
        xpSave();
    }
    function xpOffline(from, to, bySkill) {
        const total = Object.values(bySkill || {}).reduce((a, v) => a + v, 0); if (!(total > 0) || !from || !(to > from)) return;
        const R = xpEnsureStart(from); if (!R.startSnap) return;
        // A window that ended before the record began is in the start snapshot already; one that straddles the start
        // counts from the start.
        if (R.startAt && to <= R.startAt) return;
        if (R.startAt && from < R.startAt) from = R.startAt;
        // The lifetime totals already include the offline XP (set from the login message); the day the window ended
        // starts from the totals before it when it is new.
        const before = {}; for (const [k, v] of Object.entries(state.lifetimeXp)) before[k] = v - (bySkill[k] || 0);
        const d = xpDay(R, to, before);
        R.activeMs += to - from; R.offlineMs += to - from; d.activeMs += to - from; d.offlineMs += to - from; if (to > R.lastTickAt) R.lastTickAt = to;
        xpSave();
    }
    // Since-record and per-day figures from the snapshots and the lifetime totals now.
    function xpSinceSnap(snap) { const out = {}; for (const [k, v] of Object.entries(state.lifetimeXp)) { if (k === "/skills/total_level") continue; const d = v - (snap[k] != null ? snap[k] : v); if (d > 0) out[k] = d; } return out; }
    function xpSummary(now) {
        const R = xpEnsureStart(now); if (!R.startSnap) return null;
        const since = xpSinceSnap(R.startSnap); const total = Object.values(since).reduce((a, v) => a + v, 0);
        const gap = now - R.lastTickAt; const active = R.activeMs + (R.lastTickAt && gap > 0 && gap <= XP_GAP_MS ? gap : 0);
        const keys = Object.keys(R.days).sort().reverse(); const days = [];
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i]; const d = R.days[k]; const next = i > 0 ? R.days[keys[i - 1]].snap : null;
            // A day's XP: the next day's start snapshot minus this day's, or the totals now for the latest day.
            const by = {}; const end = next || state.lifetimeXp; for (const [sk, v] of Object.entries(end)) { if (sk === "/skills/total_level") continue; const dv = v - (d.snap[sk] != null ? d.snap[sk] : v); if (dv > 0) by[sk] = dv; }
            const active = d.activeMs + (i === 0 && R.lastTickAt && gap > 0 && gap <= XP_GAP_MS ? gap : 0);
            days.push({ day: k, bySkill: by, total: Object.values(by).reduce((a, v) => a + v, 0), activeMs: active, offlineMs: d.offlineMs });
        }
        const today = days.find(d => d.day === xpDayKey(now)) || null;
        const abilities = Object.entries(state.lifetimeAbilityXp).map(([h, xp]) => ({ hrid: h, xp, level: state.levels[h] != null ? state.levels[h] : levelOf(xp), since: R.startAbil && R.startAbil[h] != null ? Math.max(0, xp - R.startAbil[h]) : null })).sort((a, b) => b.xp - a.xp);
        return { startAt: R.startAt, basis: R.basis || null, since, total, activeMs: active, abilities, abilStartAt: R.startAbilAt || null, offlineMs: R.offlineMs, perHour: active > 0 ? total / (active / 3600e3) : null, days, today };
    }
    function xpDelta(from, to) { const out = {}; for (const [k, v] of Object.entries(to)) { const d = v - (from[k] || 0); if (d > 0) out[k] = Math.round(d * 10) / 10; } return out; }

    // ---------------------------------------------------------------------------------------------------------------
    // Runs (live)
    // ---------------------------------------------------------------------------------------------------------------
    function saveRun(run) { if (state.record) state.record.queue("runs", clone(run)); }
    function openRun(zone, tier, battleId, startAt, party, partial, src) {
        const d = ref.dungeons[zone] || {};
        const run = { id: `${shortAction(zone)}:${startAt}`, zone, tier: num(tier), battleId, startAt, endAt: null, result: "open", waves: 0, maxWaves: d.maxWaves || null, party: party || [], keysUsed: null, chests: [], deaths: null, deathsAtStart: null, deathsTotal: null, xpBySkill: null, consumes: [], source: "live", clock: clock.known ? "local+offset" : "local", partial: !!partial, xpStart: xpSnapshot() };
        state.run = run; saveRun(run);
        emit("start", { runId: run.id, zone, tier: run.tier, battleId, party: run.party, partial: !!partial }, src, startAt);
        return run;
    }
    function closeRun(result, fields, src, at) {
        const run = state.run; if (!run) return null;
        run.endAt = at || serverNow(); run.result = result; Object.assign(run, fields || {});
        run.durationMs = run.endAt - run.startAt;
        // A run the script joined at its very end (restarted mid-run, no battle seen) has no XP to report, not zero.
        run.xpBySkill = run.partial && !run.battles ? null : xpDelta(run.xpStart || {}, state.lifetimeXp);
        run.noBattleSeen = !run.battles;
        run.deaths = run.deathsTotal != null && run.deathsAtStart != null ? Math.max(0, run.deathsTotal - run.deathsAtStart) : null;
        delete run.xpStart;
        saveRun(run); state.run = null;
        meterRunEnded(run, result);
        emit(result, { runId: run.id, zone: run.zone, tier: run.tier, battleId: run.battleId, waves: run.waves, durationMs: run.durationMs, chests: run.chests, keysCharged: run.keysUsed, keyCost: run.keyCost || null, noBattleSeen: !run.battles, xpEnd: xpSnapshot(), xpBySkill: run.xpBySkill, deaths: run.deaths, deathsTotal: run.deathsTotal, partial: run.partial }, src, run.endAt);
        return run;
    }

    function onNewBattle(m) {
        const battleId = m.battleId, wave = num(m.wave);
        if (state.lastBattle && state.lastBattle.battleId === battleId && state.lastBattle.wave === wave) return; // duplicate roster send
        const prev = state.lastBattle; state.lastBattle = { battleId, wave };
        const players = Array.isArray(m.players) ? m.players : [];
        const self = players.find(p => p && p.character && String(p.character.id) === state.characterId) || null;
        state.battleItems = new Set((self && self.combatConsumables || []).map(c => c.itemHrid).filter(Boolean));
        const zone = currentDungeonZone();
        if (!zone) { if (state.run) closeRun("stop", { reason: "left dungeon" }, "new_battle"); return; }
        const party = players.map(p => p.character && p.character.name).filter(Boolean);
        const tier = currentTier();
        const at = serverNow();
        if (wave <= 1) {
            if (state.run) {
                if (state.run.battleId === battleId) closeRun("fail", { waveReached: state.run.waves }, "new_battle", at);
                else closeRun("stop", { reason: "new run began without a clear being seen", waveReached: state.run.waves }, "new_battle", at);
            }
            openRun(zone, tier, battleId, at, party, false, "new_battle");
        } else if (!state.run || state.run.battleId !== battleId) {
            if (state.run) closeRun("stop", { reason: "battle id changed mid run" }, "new_battle", at);
            openRun(zone, tier, battleId, at, party, true, "new_battle");
        }
        const run = state.run;
        if (run) { run.battles = (run.battles || 0) + 1; run.waves = Math.max(run.waves, wave); if (self) { const d = num(self.deathCount); if (run.deathsAtStart == null) run.deathsAtStart = d; run.deathsTotal = d; } if (prev && prev.battleId === battleId && wave > 1) saveRun(run); }
    }

    // The current combat action from the queue (actions_updated / action_completed keep it current).
    const queue = { actions: new Map() };
    function applyActions(rows) { if (!Array.isArray(rows)) return; for (const a of rows) if (isObj(a) && a.id != null) { if (a.isDone) queue.actions.delete(a.id); else queue.actions.set(a.id, a); } }
    function currentAction() { let best = null; for (const a of queue.actions.values()) if (a.actionHrid && a.actionHrid.startsWith("/actions/combat/")) { if (!best || num(a.ordinal) < num(best.ordinal)) best = a; } return best; }
    function currentDungeonZone() { const a = currentAction(); if (a && ref.dungeons[a.actionHrid]) return a.actionHrid; if (state.run) return state.run.zone; return null; }
    function currentTier() { const a = currentAction(); return a ? num(a.difficultyTier) : (state.run ? state.run.tier : 0); }

    function onActionCompleted(m) {
        const a = m.endCharacterAction || {};
        const at = parseServerTime(a.updatedAt) || serverNow();
        const xpDeltas = applySkills(m.endCharacterSkills);
        if (Object.keys(xpDeltas).length) xpTick(xpDeltas, at);
        const diffs = applyRows(m.endCharacterItems, false);
        if (a.id != null) { if (a.isDone) queue.actions.delete(a.id); else queue.actions.set(a.id, a); }
        if (ref.keyActions[a.actionHrid]) return onKeyCraft(m, a, diffs, at);
        if (ref.dungeons[a.actionHrid]) {
            const d = ref.dungeons[a.actionHrid]; const wave = num(a.wave);
            if (state.run && wave > state.run.waves) { state.run.waves = wave; }
            const chestDiffs = diffs.filter(x => x.delta > 0 && ref.chestItems[x.item] && ref.chestItems[x.item].zone === a.actionHrid);
            const keyDiffs = diffs.filter(x => x.delta < 0 && x.item === d.keyItem);
            const cleared = wave >= d.maxWaves || chestDiffs.length > 0;
            if (cleared) {
                const chests = chestDiffs.map(x => ({ item: x.item, qty: x.delta }));
                const keysCharged = keyDiffs.reduce((s, x) => s + -x.delta, 0) || null;
                let keyCost = null;
                if (keysCharged) { const k = keyLotTake(d.keyItem, keysCharged); keyCost = { unitCost: k.unitCost, basis: k.basis }; }
                if (!state.run) openRun(a.actionHrid, a.difficultyTier, state.lastBattle && state.lastBattle.battleId, at, [], true, "action_completed");
                // A clear means every wave was fought, whether or not the script saw them (it may have started mid-run).
                state.run.waves = Math.max(state.run.waves, wave, num(d.maxWaves));
                closeRun("clear", { chests, keysUsed: keysCharged, keyCost, serverEnd: parseServerTime(a.updatedAt) ? at : null }, "action_completed", at);
                if (chestDiffs.length === 0) review("clear seen by wave count but no chest row in the message", { zone: a.actionHrid, wave, diffs }, "action_completed");
            } else if (a.isDone && state.run) {
                closeRun("stop", { reason: "action done before the last wave", waveReached: wave }, "action_completed", at);
            }
            if (diffs.length) onInventoryDiffs(diffs, "action_completed", m);
            return;
        }
        if (diffs.length) onInventoryDiffs(diffs, "action_completed", m);
        if (Object.keys(xpDeltas).length) noteSkillingXp(xpDeltas, a.actionHrid, at);
    }

    function noteSkillingXp(deltas, actionHrid, at) { for (const l of listeners) { try { l({ kind: "xp-tick", deltas, actionHrid, at }); } catch (_e) { /* quiet */ } } }

    // ---------------------------------------------------------------------------------------------------------------
    // Key crafting
    // ---------------------------------------------------------------------------------------------------------------
    const craftCursor = new Map(); // action id -> currentCount
    function onKeyCraft(m, a, diffs, at) {
        const recipe = ref.keyActions[a.actionHrid];
        const prevCount = craftCursor.get(a.id); craftCursor.set(a.id, num(a.currentCount));
        const crafts = prevCount != null ? Math.max(0, num(a.currentCount) - prevCount) : null;
        const outputs = diffs.filter(x => x.delta > 0 && recipe.outputs.some(o => o.item === x.item)).map(x => ({ item: x.item, qty: x.delta }));
        const inputItems = new Set(recipe.inputs.map(i => i.item));
        const inputs = diffs.filter(x => x.delta < 0 && inputItems.has(x.item) && x.item !== "/items/coin").map(x => ({ item: x.item, qty: -x.delta, unitCost: null }));
        const coinRow = diffs.find(x => x.item === "/items/coin" && x.delta < 0);
        const coinsPaid = coinRow ? -coinRow.delta : 0;
        const teas = diffs.filter(x => x.delta < 0 && isConsumable(x.item)).map(x => ({ item: x.item, qty: -x.delta }));
        if (!outputs.length) { if (diffs.length) onInventoryDiffs(diffs, "action_completed", m); return review("key craft message without a key output row", { action: a.actionHrid, crafts, diffs }, "action_completed"); }
        let cost = coinsPaid, unknown = false;
        for (const i of inputs) { const t = ledgerTake(i.item, i.qty); i.unitCost = t.avg; i.covered = t.covered; if (t.covered < i.qty) unknown = true; if (t.avg != null) cost += t.avg * t.covered; }
        for (const t of teas) { const k = ledgerTake(t.item, t.qty); t.unitCost = k.avg; t.covered = k.covered; if (k.avg != null) cost += k.avg * k.covered; if (k.covered < t.qty) unknown = true; }
        const keyQty = outputs.reduce((s, o) => s + o.qty, 0);
        const unitCost = unknown ? null : cost / keyQty;
        const ev = emit("craft", { action: a.actionHrid, crafts, inputs, coins: coinsPaid, outputs, teas, unitCost, knownCost: cost, basis: unknown ? "partly unknown" : "materials+coins" }, "action_completed", at);
        for (const o of outputs) { if (unitCost != null) { keyLotAdd(o.item, o.qty, unitCost, "craft", ev.id); const e = keyAverages.get(o.item) || { qty: 0, cost: 0 }; e.qty += o.qty; e.cost += o.qty * unitCost; keyAverages.set(o.item, e); } else keyLotAdd(o.item, o.qty, 0, "unknown", ev.id); }
        if (unknown) review("key craft used materials with no recorded purchase price", { craftId: ev.id, inputs }, "action_completed");
        // The rows that were not inputs/outputs/teas still need the ordinary treatment (e.g. nothing, usually).
        const handled = new Set([...outputs.map(o => o.item), ...inputs.map(i => i.item), "/items/coin", ...teas.map(t => t.item)]);
        const rest = diffs.filter(x => !handled.has(x.item)); if (rest.length) onInventoryDiffs(rest, "action_completed", m);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Inventory-driven events: consumes in battle, instant buys, dungeon shop redemptions
    // ---------------------------------------------------------------------------------------------------------------
    function onInventoryDiffs(diffs, src, m) {
        const now = serverNow();
        // 1. Rows that belong to an outgoing instant order. The order itself is recorded from its listing row (the game
        //    reports an instant order as a filled listing in market_listings_updated, with price and tax); these rows
        //    only have to stay out of the consume and redeem detectors below.
        state.pendingOrders = state.pendingOrders.filter(o => now - o.at < 15000);
        const ordered = new Set();
        for (const order of state.pendingOrders) { const row = diffs.find(x => x.item === order.item && x.level === order.level && (order.isSell ? x.delta < 0 : x.delta > 0)); if (row) ordered.add(row); }
        if (ordered.size) { diffs = diffs.filter(x => !ordered.has(x) && x.item !== "/items/coin"); if (!diffs.length) return; }
        // 2. Consumables used in battle (authoritative count change of a slotted consumable while fighting).
        const inBattle = !!state.run || !!(state.lastBattle);
        for (const x of diffs) {
            if (x.delta < 0 && state.battleItems.has(x.item) && inBattle && src === "items_updated") {
                const qty = -x.delta; const t = ledgerTake(x.item, qty);
                const unitCost = t.covered === qty ? t.avg : null;
                emit("consume", { item: x.item, qty, unitCost, covered: t.covered, runId: state.run ? state.run.id : null }, src);
                if (state.run) { state.run.consumes.push({ item: x.item, qty, unitCost }); saveRun(state.run); }
            }
        }
        // 3. Dungeon shop redemption: a token (untradable, "_token") down and another item up in the same message.
        const tokenDown = diffs.filter(x => x.delta < 0 && /_token$/.test(x.item));
        const gained = diffs.filter(x => x.delta > 0 && x.item !== "/items/coin");
        if (tokenDown.length === 1 && gained.length === 1 && src === "items_updated") emit("redeem", { token: tokenDown[0].item, qty: -tokenDown[0].delta, item: gained[0].item, itemQty: gained[0].delta, bid: bidOf(gained[0].item) }, src);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Market listings (your orders)
    // ---------------------------------------------------------------------------------------------------------------
    function seedListings(rows) { if (!Array.isArray(rows)) return; for (const l of rows) if (isObj(l) && l.id != null) state.listings.set(l.id, snapshotListing(l)); }
    const snapshotListing = l => ({ id: l.id, itemHrid: l.itemHrid, level: num(l.enhancementLevel), isSell: !!l.isSell, price: num(l.price), orderQuantity: num(l.orderQuantity), filledQuantity: num(l.filledQuantity), taxTaken: num(l.taxTaken), unclaimedCoinCount: num(l.unclaimedCoinCount), unclaimedItemCount: num(l.unclaimedItemCount), status: l.status, createdTimestamp: l.createdTimestamp });
    function onListings(m) {
        const rows = Array.isArray(m.endMarketListings) ? m.endMarketListings : [];
        for (const l of rows) {
            if (!isObj(l) || l.id == null) continue;
            const next = snapshotListing(l); const prev = state.listings.get(l.id);
            state.listings.set(l.id, next);
            const prevFilled = prev ? prev.filledQuantity : (parseServerTime(l.createdTimestamp) >= (state.meta.recordStart || 0) ? 0 : null);
            if (prevFilled == null) { if (next.filledQuantity > 0) review("listing seen for the first time with fills already on it", { listing: next }, "market_listings_updated"); continue; }
            const dFill = next.filledQuantity - prevFilled;
            if (dFill <= 0) continue;
            const at = serverNow();
            const instant = state.pendingOrders.some(o => o.item === next.itemHrid && o.level === next.level && o.isSell === next.isSell && o.qty === next.orderQuantity && at - o.at < 15000);
            if (next.isSell) {
                const gross = dFill * next.price; const tax = next.taxTaken - (prev ? prev.taxTaken : 0);
                emit("sell", { listingId: next.id, item: next.itemHrid, level: next.level, qty: dFill, unitPrice: next.price, gross, tax: tax >= 0 ? tax : null, net: tax >= 0 ? gross - tax : null, instant }, "market_listings_updated", at);
            } else {
                const total = dFill * next.price;
                emit("buy", { listingId: next.id, item: next.itemHrid, level: next.level, qty: dFill, unitPrice: next.price, coins: total, instant }, "market_listings_updated", at);
                ledgerAdd(next.itemHrid, dFill, next.price); if (ref.keyItems.has(next.itemHrid)) keyLotAdd(next.itemHrid, dFill, next.price, "bought", null);
            }
        }
        const diffs = applyRows(m.endCharacterItems, false);
        if (diffs.length) onInventoryDiffs(diffs, "market_listings_updated", m);
    }
    function onOutgoing(text) {
        let m; try { m = JSON.parse(text); } catch (_e) { return; }
        if (!isObj(m) || m.type !== "post_market_order") return;
        state.counts.frames++;
        retainFrame("post_market_order", m, "out");
        const d = m.postMarketOrderData || {};
        if (d.isInstantOrder) state.pendingOrders.push({ item: d.itemHrid, level: num(d.enhancementLevel), qty: num(d.quantity), isSell: !!d.isSell, at: serverNow() });
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Chest openings
    // ---------------------------------------------------------------------------------------------------------------
    function onLootOpened(m) {
        const opened = m.openedItem || {}; const chest = opened.itemHrid; const count = num(opened.count) || 1;
        const gains = new Map();
        for (const g of (Array.isArray(m.gainedItems) ? m.gainedItems : [])) { if (!isObj(g) || !g.itemHrid) continue; const k = `${g.itemHrid}::${num(g.enhancementLevel)}`; const e = gains.get(k) || { item: g.itemHrid, level: num(g.enhancementLevel), qty: 0 }; e.qty += num(g.count); gains.set(k, e); }
        const key = ref.chestItems[chest] ? ref.chestItems[chest].key : null;
        const at = serverNow();
        const finish = () => {
            // A dungeon token has no market price: it is worth the best bid per token among the shop items it buys,
            // recorded here so the opening keeps the value it had when the chest was opened.
            const tokenBid = hrid => { let best = null; for (const e of (ref.tokenShop[hrid] || [])) { const b = bidOf(e.item); if (!(b > 0) || !(e.tokens > 0)) continue; const per = b * (e.count || 1) / e.tokens; if (!best || per > best.tokenBid) best = { tokenBid: per, via: e.item }; } return best; };
            const list = [...gains.values()].map(g => isCounted(g.item) ? { ...g, bid: null, ask: null, counted: true } : ref.tokenShop[g.item] ? { ...g, bid: null, ask: null, ...(tokenBid(g.item) || {}) } : { ...g, bid: g.item === "/items/coin" ? 1 : bidOf(g.item), ask: g.item === "/items/coin" ? 1 : askOf(g.item) });
            const coinsGained = list.filter(g => g.item === "/items/coin").reduce((s, g) => s + g.qty, 0);
            const valueBid = list.filter(g => g.item !== "/items/coin" && !g.counted).reduce((s, g) => s + (g.bid ? g.bid * g.qty : 0), 0);
            const valueTokens = list.reduce((s, g) => s + (g.tokenBid ? g.tokenBid * g.qty : 0), 0);
            const unpriced = list.filter(g => g.item !== "/items/coin" && !g.counted && !g.bid && !g.tokenBid).map(g => g.item);
            emit("open", { chest, count, keyItem: key, zone: ref.chestItems[chest] ? ref.chestItems[chest].zone : null, gains: list, coinsGained, valueBid, valueTokens, unpriced, pricesAt: prices.at || null, keyCost: key ? keyLotTake(key, count) : null }, "loot_opened", at);
            for (const g of list) if (ref.keyItems.has(g.item)) keyLotAdd(g.item, g.qty, 0, "dropped", null);
        };
        fetchPrices(false).then(finish, finish);
        const diffs = applyRows(m.endCharacterItems, false); if (diffs.length) onInventoryDiffs(diffs, "loot_opened", m);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Party chat ledger. Confirmed 2026-11-01: partyKeyCount once per run start (one per clear, same second as the next
    // new_battle), partyWaveFailed {wave} then a fresh partyKeyCount, partyBattleEnded on a cancel, partyBattleStarted
    // + partyKeyCount on a restart. The login history holds the newest 100 party messages.
    // ---------------------------------------------------------------------------------------------------------------
    // Party consumables (operator, 2026-11-23): every new_battle carries each player's combatConsumables with the
    // count they hold (read in the 2026-11-23 capture: all five players, every wave). Per player and item: the count
    // now and how many were used since first seen on this page, for a time-left estimate. Kept per browser across a reload; a
    // slot that changes item starts over, a restock does not count as use, and a 5-minute gap starts everyone over
    // (time out of combat would dilute the rate).
    function trackPartyCons(m) {
        const at = serverNow();
        // Kept across a reload (operator, 2026-11-23: every reload emptied the times for ten minutes): the newest
        // state is saved per browser and taken up again when it is this character's and under five minutes old.
        if (!state.partyCons) { try { const v = JSON.parse(localStorage.getItem("mds-partycons-v1") || "null"); if (v && v.who === state.characterName && v.cons && typeof v.cons === "object") { state.partyCons = v.cons; state.partyConsAt = Number(v.at) || 0; } } catch (_e) { /* start fresh */ } }
        if (!state.partyCons || at - (state.partyConsAt || 0) > 300e3) state.partyCons = {};
        state.partyConsAt = at;
        const seen = new Set();
        for (const p of (m && m.players) || []) {
            const name = p && (p.name || (p.character && p.character.name)); if (!name) continue; seen.add(name);
            const rec = state.partyCons[name] || (state.partyCons[name] = {}), now = {}, where = {};
            // Slots: the list is food 1-3 then drink 1-3 when it has all six places (an empty slot is a null);
            // a shorter list is numbered in order within food and within drink.
            const list = p.combatConsumables || [], six = list.length === 6, seq = { food: 0, drink: 0 };
            list.forEach((c, i) => {
                if (!c || !c.itemHrid) return;
                const kind = ref.items[c.itemHrid] && ref.items[c.itemHrid].category === "/item_categories/drink" ? "drink" : "food";
                now[c.itemHrid] = num(c.count); where[c.itemHrid] = { kind, slot: six ? (i < 3 ? i : i - 3) : seq[kind] }; seq[kind]++;
            });
            for (const k of Object.keys(rec)) if (!(k in now)) delete rec[k];
            for (const [item, count] of Object.entries(now)) { let r = rec[item]; if (!r) r = rec[item] = { t0: at, used: 0, count, t: at }; else { if (count < r.count) r.used += r.count - count; r.count = count; r.t = at; } r.kind = where[item].kind; r.slot = where[item].slot; }
        }
        for (const k of Object.keys(state.partyCons)) if (!seen.has(k)) delete state.partyCons[k];
        try { localStorage.setItem("mds-partycons-v1", JSON.stringify({ at, who: state.characterName, cons: state.partyCons })); } catch (_e) { /* fine */ }
    }
    // Party XP/hr (operator, 2026-11-23: shown in the damage meter so the Combat Sim Helper's bars above the cards can
    // go). Every new_battle carries each player's experience gained this session by skill (totalSkillExperienceMap).
    // The rate is what was gained since this page first saw the player over the time since, read at wave starts; a
    // session first seen with nothing earned starts its clock at the first wave that shows experience (the helper's
    // rule). Kept per browser across a reload; a total that drops (a new session) or a 5-minute gap starts over.
    function trackPartyXp(m) {
        const at = serverNow();
        if (!state.partyXp) { try { const v = JSON.parse(localStorage.getItem("mds-partyxp-v1") || "null"); if (v && v.who === state.characterName && v.xp && typeof v.xp === "object") { state.partyXp = v.xp; state.partyXpAt = Number(v.at) || 0; } } catch (_e) { /* start fresh */ } }
        if (!state.partyXp || at - (state.partyXpAt || 0) > 300e3) state.partyXp = {};
        state.partyXpAt = at;
        const seen = new Set();
        for (const p of (m && m.players) || []) {
            const name = p && (p.name || (p.character && p.character.name)); if (!name) continue; seen.add(name);
            const map = {}; let total = 0; for (const [k, v] of Object.entries(p.totalSkillExperienceMap || {})) { const n = num(v); if (n > 0) { map[k] = n; total += n; } }
            let r = state.partyXp[name];
            if (!r || total < r.total) r = state.partyXp[name] = { t0: at, base: map, baseTotal: total, t: at, map, total };
            else if (r.baseTotal === 0 && r.total === 0 && total > 0) { r.t0 = at; r.base = map; r.baseTotal = total; }
            r.t = at; r.map = map; r.total = total;
        }
        for (const k of Object.keys(state.partyXp)) if (!seen.has(k)) delete state.partyXp[k];
        try { localStorage.setItem("mds-partyxp-v1", JSON.stringify({ at, who: state.characterName, xp: state.partyXp })); } catch (_e) { /* fine */ }
    }
    function parseKeyCounts(meta) { const out = {}; let s = ""; try { s = typeof meta === "string" ? (JSON.parse(meta).keyCountString || "") : (meta && meta.keyCountString) || ""; } catch (_e) { s = String(meta || ""); } const re = /\[([^[\]-]+?)\s*-\s*([\d,]+)\]/g; let x; while ((x = re.exec(s))) out[x[1].trim()] = num(x[2].replace(/,/g, "")); return out; }
    function onChat(msg, replay) {
        const c = msg && msg.message; if (!isObj(c) || c.chan !== "/chat_channel_types/party" || !c.isSystemMessage) return;
        const at = parseServerTime(c.t) || serverNow();
        const m = String(c.m || "");
        if (/partyKeyCount/.test(m) && (!state.partyKeys || at >= state.partyKeys.at)) state.partyKeys = { at, counts: parseKeyCounts(c.systemMetadata) };
        const keys = [`tm:${at}|${m}`]; if (c.id != null) keys.push(`id:${c.id}`);
        if (keys.some(k => state.chatSeen.has(k))) return;
        for (const k of keys) state.chatSeen.add(k);
        if (state.chatSeen.size > 1200) { const old = [...state.chatSeen].slice(0, 400); for (const k of old) state.chatSeen.delete(k); }
        state.lastChatAt = Math.max(state.lastChatAt, at);
        const fields = { m, at, chatId: c.id != null ? c.id : undefined, keyCounts: /partyKeyCount/.test(m) ? parseKeyCounts(c.systemMetadata) : undefined, meta: c.systemMetadata, replay: !!replay };
        emit("chat", fields, "chat_message_received", at);
        if (state.record) { state.record.queue("meta", { key: "chatSeen", value: [...state.chatSeen] }); state.record.queue("meta", { key: "lastChatAt", value: state.lastChatAt }); }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Login: character, clock, inventory, baseline, offline summary, listings, chat replay
    // ---------------------------------------------------------------------------------------------------------------
    async function onInitCharacter(m) {
        const ch = m.character || {};
        const id = ch.id != null ? String(ch.id) : null;
        if (!id) return warn("init_character_data without a character id");
        const serverTs = parseServerTime(m.currentTimestamp); if (serverTs) { clock.offset = serverTs - Date.now(); clock.known = true; }
        const switched = state.characterId && state.characterId !== id;
        state.characterId = id; state.characterName = ch.name || null;
        // The action queue first: battle messages keep coming while the record opens, and the damage meter and the
        // run tracker read the dungeon from the queue (0.2.1: sessions saved with no place after a reload).
        applyActions(m.characterActions);
        if (!state.record || switched) await openRecord(id);
        applyRows(m.characterItems, true);
        noteBuffs(m);
        for (const r of (Array.isArray(m.characterSkills) ? m.characterSkills : [])) if (isObj(r) && r.skillHrid && r.skillHrid !== "/skills/total_level") { state.lifetimeXp[r.skillHrid] = num(r.experience); if (r.level != null) state.levels[r.skillHrid] = num(r.level); }
        for (const r of (Array.isArray(m.characterAbilities) ? m.characterAbilities : [])) if (isObj(r) && r.abilityHrid) { state.lifetimeAbilityXp[r.abilityHrid] = num(r.experience); if (r.level != null) state.levels[r.abilityHrid] = num(r.level); }
        xpAbilityStart();
        applyActions(m.characterActions);
        seedListings(m.myMarketListings);
        retainFrame("init_character_data", m, "in");
        // Record start and baseline, once.
        if (!state.meta.recordStart) {
            state.meta.recordStart = serverNow(); state.record.queue("meta", { key: "recordStart", value: state.meta.recordStart });
            { const R = xpRec(); if (!R.startSnap && Object.keys(state.lifetimeXp).length) { R.startSnap = { ...state.lifetimeXp }; delete R.startSnap["/skills/total_level"]; R.startAt = state.meta.recordStart; R.lastTickAt = state.meta.recordStart; xpSave(); info(`XP record start snapshot taken with the record start ${new Date(R.startAt).toISOString()}`); } else info(`XP record start: snapshot ${R.startSnap ? "already present" : "not possible, no skill totals yet"}`); }
            await fetchPrices(true);
            const items = [], keys = [], chests = [];
            for (const r of state.inventory.values()) {
                if (r.itemLocationHrid !== INV || r.enhancementLevel !== 0) continue;
                if (isConsumable(r.itemHrid) || isKeyMaterial(r.itemHrid)) { const a = askOf(r.itemHrid); items.push({ item: r.itemHrid, qty: r.count, unitCost: a, basis: "ask-at-start", kind: isConsumable(r.itemHrid) ? "consumable" : "key material" }); if (a != null) ledgerAdd(r.itemHrid, r.count, a); }
                else if (ref.keyItems.has(r.itemHrid)) { const rp = recipePriceNow(r.itemHrid); const a = rp ? rp.unitCost : askOf(r.itemHrid); const basis = rp ? rp.basis : (a != null ? "ask-at-start" : "unknown"); keys.push({ item: r.itemHrid, qty: r.count, unitCost: a, basis }); keyLotAdd(r.itemHrid, r.count, a == null ? 0 : a, rp ? "recipe" : (a == null ? "unknown" : "ask"), null); }
                else if (ref.chestItems[r.itemHrid]) chests.push({ item: r.itemHrid, qty: r.count });
            }
            emit("baseline", { items, keys, chests, coins: coins(), pricesAt: prices.at || null, priceError: prices.error }, "init_character_data");
            state.record.queue("meta", { key: "ledger", value: ledgerState() });
        }
        // Offline summary.
        const offItems = Array.isArray(m.offlineItems) ? m.offlineItems : null, offSkills = Array.isArray(m.offlineSkills) ? m.offlineSkills : null;
        // lastOfflineTime is the logout; inactiveTime is the game's inactivity horizon (logout + 72 h), so the window
        // ends at the login or that horizon, whichever came first. A reconnect a few seconds long with no item change
        // is not an offline block (its XP is in the lifetime totals anyway).
        const from = parseServerTime(ch.lastOfflineTime), loginAt = serverTs || serverNow(), horizon = parseServerTime(ch.inactiveTime);
        const to = horizon && horizon < loginAt ? horizon : loginAt;
        if ((offItems && offItems.length) || (offSkills && offSkills.length && from && to - from >= 60000)) {
            // Consumables used while away leave the purchase ledger here, at the average they were bought at.
            const offRows = offItems ? offItems.map(r => { const row = { item: r.itemHrid, level: num(r.enhancementLevel), delta: num(r.offlineCount), raw: r.count }; if (row.delta < 0 && isConsumable(row.item)) { const t = ledgerTake(row.item, -row.delta); row.unitCost = t.covered === -row.delta ? t.avg : null; row.covered = t.covered; } return row; }) : [];
            const offXp = offSkills ? Object.fromEntries(offSkills.filter(r => isObj(r) && r.skillHrid && r.skillHrid !== "/skills/total_level").map(r => [r.skillHrid, num(r.offlineExperience)])) : {};
            if (from && Object.keys(offXp).length) xpOffline(from, to, offXp);
            emit("offline", { from, to, loginAt, horizon, items: offRows, xpBySkill: offXp, keys: Object.keys(m).filter(k => /offline/i.test(k)) }, "init_character_data");
        }
        // Party chat replay.
        const chat = m.partyChatHistory || (m.chatHistoryByChannelMap && m.chatHistoryByChannelMap["/chat_channel_types/party"]);
        if (Array.isArray(chat)) { const sorted = chat.slice().sort((a, b) => (parseServerTime(a.t) || 0) - (parseServerTime(b.t) || 0)); let n = 0; for (const c of sorted) { const before = state.counts.events; onChat({ message: c }, true); if (state.counts.events > before) n++; } if (n) info(`replayed ${n} party system messages from the login history`); }
        state.record.queue("meta", { key: "lastChatAt", value: state.lastChatAt });
        state.ready = true; panel.refresh();
        importToolasha("login");
    }

    function ledgerState() { return { ledger: [...state.ledger.entries()], keyLots: [...state.keyLots.entries()], keyAverages: [...keyAverages.entries()], listings: [...state.listings.values()], lifetimeXp: state.lifetimeXp }; }
    function restoreLedger(v) { if (!isObj(v)) return; state.ledger = new Map(v.ledger || []); state.keyLots = new Map(v.keyLots || []); for (const [k, e] of (v.keyAverages || [])) keyAverages.set(k, e); if (Array.isArray(v.listings)) for (const l of v.listings) state.listings.set(l.id, l); }

    const TIMELINE_KINDS = ["start", "clear", "fail", "stop", "craft", "buy", "sell", "open", "redeem", "baseline", "offline", "chat", "review", "value", "keep", "reprice", "note"];

    // ---------------------------------------------------------------------------------------------------------------
    // Toolasha market history. Toolasha keeps every listing it has seen for this player in IndexedDB (ToolashaDB,
    // store marketListings, key marketListingTimestamps: an array of {id, createdTimestamp, itemHrid,
    // enhancementLevel, price, orderQuantity, filledQuantity, isSell}). Two uses, both recorded as events:
    //   1. once per record, stock that the baseline priced at ask is re-priced at what the player actually paid for it,
    //      walking their filled buys newest first until the held quantity is covered (a reprice event, applied to the
    //      purchase ledger and to key lots priced from the recipe);
    //   2. on every login, listings inside the record window whose fills the script did not see (another device,
    //      script off) become buy/sell events marked imported; sells carry tax at the rate in force, never measured.
    // Read-only: the database is opened without a version and never created.
    // ---------------------------------------------------------------------------------------------------------------
    // ---------------------------------------------------------------------------------------------------------------
    // Loot & XP Log. The game answers the panel with loot_log_updated: entries per character action session
    // {startTime, endTime, characterActionId, actionHrid, difficultyTier, actionCount, partyId, drops {"hrid::level": n},
    // xpGains {skill: xp}}. For a dungeon, actionCount is the clears of that party action and drops are its chests, the
    // server's own count, offline included. Entries are merged by characterActionId (the latest end time wins) and kept
    // in meta; Toolasha's persisted copy (store lootLogHistory, key lootLog_<characterId>) is merged the same way.
    // ---------------------------------------------------------------------------------------------------------------
    function normLootLog(e) {
        if (!isObj(e) || e.characterActionId == null || !e.actionHrid) return null;
        const start = parseServerTime(e.startTime), end = parseServerTime(e.endTime); if (!start) return null;
        const drops = {}; for (const [k, v] of Object.entries(isObj(e.drops) ? e.drops : {})) { const [hrid, lvl] = String(k).split("::"); drops[hrid + (lvl && lvl !== "0" ? "::" + lvl : "")] = num(v); }
        return { id: e.characterActionId, action: e.actionHrid, tier: num(e.difficultyTier), start, end: end || start, count: num(e.actionCount), party: num(e.partyId) || 0, drops, xp: isObj(e.xpGains) ? e.xpGains : {}, activeMs: num(e.totalActiveMillis) || 0 };
    }
    function mergeLootLog(list, source) {
        let changed = 0;
        for (const raw of list) {
            const e = normLootLog(raw); if (!e) continue;
            const prev = state.lootLog.get(e.id);
            if (prev && prev.first) e.first = prev.first;
            // A session the game reports as running (its end is the time of the read) gets a snapshot, so later reads
            // and this record can be compared from that moment on, exactly.
            if (!e.first && source === "game" && Math.abs(e.end - serverNow()) < 15e3) e.first = { at: serverNow(), count: e.count, drops: { ...e.drops }, xp: { ...e.xp } };
            const fresher = !prev || e.end > prev.end || e.count > prev.count || (e.end === prev.end && JSON.stringify(e.drops) !== JSON.stringify(prev.drops)) || (!prev.first && e.first);
            if (!fresher) continue;
            e.readAt = serverNow(); // a running session carries the time of the read as its end
            e.source = [...new Set(`${prev ? prev.source + "+" : ""}${source}`.split("+").filter(Boolean))].join("+");
            state.lootLog.set(e.id, e); changed++;
        }
        if (changed) { state.lootLogRev++; state.lootLogAt = serverNow(); if (state.record) state.record.queue("meta", { key: "lootLog", value: [...state.lootLog.values()] }); }
        return changed;
    }
    function onLootLog(m) {
        const list = Object.values(m).find(v => Array.isArray(v) && v.some(x => isObj(x) && x.characterActionId != null));
        if (!list) return review("loot_log_updated without a session list", { keys: Object.keys(m) }, "loot_log_updated");
        const changed = mergeLootLog(list, "game");
        state.lootLogReadThisSession = true;
        emit("note", { text: `Loot & XP Log read: ${list.length} sessions, ${changed} new or updated`, lootLog: { entries: list.length, changed } }, "loot_log_updated");
        panel.touch();
    }
    const TOOLASHA = { status: "not read", listings: 0, seeded: 0, imported: 0, at: 0, sessions: 0 };
    async function readToolashaStore(store, key) {
        try {
            if (typeof indexedDB.databases === "function") { const dbs = await indexedDB.databases(); if (!dbs.some(d => d && d.name === "ToolashaDB")) return null; }
            const db = await new Promise((res, rej) => { const q = indexedDB.open("ToolashaDB"); q.onupgradeneeded = e => { try { e.target.transaction.abort(); } catch (_e) { /* fine */ } }; q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error || new Error("open failed")); q.onblocked = () => rej(new Error("blocked")); });
            try { if (!db.objectStoreNames.contains(store)) return null; return await new Promise((res, rej) => { const q = db.transaction(store, "readonly").objectStore(store).get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); } finally { db.close(); }
        } catch (_e) { return null; }
    }
    async function readToolashaListings() {
        try {
            if (typeof indexedDB.databases === "function") { const dbs = await indexedDB.databases(); if (!dbs.some(d => d && d.name === "ToolashaDB")) { TOOLASHA.status = "no ToolashaDB"; return null; } }
            const db = await new Promise((res, rej) => { const q = indexedDB.open("ToolashaDB"); q.onupgradeneeded = e => { try { e.target.transaction.abort(); } catch (_e) { /* fine */ } }; q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error || new Error("open failed")); q.onblocked = () => rej(new Error("blocked")); });
            try {
                if (!db.objectStoreNames.contains("marketListings")) { TOOLASHA.status = "no marketListings store"; return null; }
                const v = await new Promise((res, rej) => { const q = db.transaction("marketListings", "readonly").objectStore("marketListings").get("marketListingTimestamps"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
                if (!Array.isArray(v)) { TOOLASHA.status = "no listing history"; return null; }
                TOOLASHA.status = "read"; TOOLASHA.listings = v.length; TOOLASHA.at = Date.now();
                return v.map(l => ({ id: l.id, at: parseServerTime(l.createdTimestamp) || num(l.timestamp), item: l.itemHrid, level: num(l.enhancementLevel), price: num(l.price), qty: num(l.filledQuantity), ordered: num(l.orderQuantity), isSell: !!l.isSell })).filter(l => l.id != null && l.item && l.qty > 0 && l.price > 0 && l.at > 0);
            } finally { db.close(); }
        } catch (error) { TOOLASHA.status = "unavailable: " + String(error && error.message || error); return null; }
    }
    let toolashaRunning = null;
    // Merge listings into the record's market history by listing id (a listing with more filled wins). Returns how many
    // were new or changed.
    function addMarketHistory(list, src) {
        let changed = 0;
        for (const l of list) { if (!l || l.id == null) continue; const prev = state.marketHistory.get(l.id); if (prev && prev.qty >= l.qty && prev.at) continue; state.marketHistory.set(l.id, { ...l, src: prev && prev.src && !prev.src.includes(src) ? `${prev.src}+${src}` : (prev && prev.src) || src }); changed++; }
        if (changed && state.record) state.record.queue("meta", { key: "marketHistory", value: [...state.marketHistory.values()] });
        return changed;
    }
    const marketHistoryRows = () => [...state.marketHistory.values()];
    // A market history file from another PC: Toolasha's IndexedDB array (the console download) or its Export CSV
    // (Date, Item, Enh Lvl, Type, Status, Price, Quantity, Filled, Total; items by name, ids synthesised).
    function parseMarketHistoryFile(text) {
        const t = String(text || "").trim(); if (!t) return [];
        if (t[0] === "[" || t[0] === "{") {
            let json; try { json = JSON.parse(t); } catch (_e) { return []; }
            const arr = Array.isArray(json) ? json : (Array.isArray(json.listings) ? json.listings : Array.isArray(json.marketListingTimestamps) ? json.marketListingTimestamps : []);
            return arr.map(l => ({ id: l.id, at: parseServerTime(l.createdTimestamp) || num(l.timestamp) || num(l.at), item: l.itemHrid || l.item, level: num(l.enhancementLevel != null ? l.enhancementLevel : l.level), price: num(l.price), qty: num(l.filledQuantity != null ? l.filledQuantity : l.qty), ordered: num(l.orderQuantity != null ? l.orderQuantity : l.ordered), isSell: !!l.isSell })).filter(l => l.id != null && l.item && l.qty > 0 && l.price > 0 && l.at > 0);
        }
        const lines = t.split(/\r?\n/).filter(Boolean); if (lines.length < 2) return [];
        const cell = line => { const out = []; let cur = "", q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === "," && !q) { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out.map(x => x.trim()); };
        const head = cell(lines[0]).map(h => h.toLowerCase());
        const col = name => head.findIndex(h => h === name || h.startsWith(name));
        const cDate = col("date"), cItem = col("item"), cLvl = col("enh"), cType = col("type"), cPrice = col("price"), cQty = col("quantity"), cFilled = col("filled");
        if (cDate < 0 || cItem < 0 || cType < 0 || cPrice < 0) return [];
        const byName = new Map(Object.entries(ref.items).map(([h, i]) => [String(i.name).toLowerCase(), h]));
        const rows = [];
        for (const line of lines.slice(1)) {
            const c = cell(line); const name = c[cItem]; const hrid = /^\/items\//.test(name) ? name : byName.get(String(name).toLowerCase()); if (!hrid) continue;
            const at = Date.parse(c[cDate]); const price = num(String(c[cPrice]).replace(/[^\d.]/g, "")); const filled = num(String(c[cFilled >= 0 ? cFilled : cQty]).replace(/[^\d.]/g, "")); const ordered = num(String(c[cQty]).replace(/[^\d.]/g, ""));
            if (!(at > 0) || !(price > 0) || !(filled > 0)) continue;
            const isSell = /sell/i.test(c[cType]); const level = cLvl >= 0 ? num(String(c[cLvl]).replace(/[^\d]/g, "")) : 0;
            rows.push({ id: `csv:${at}|${hrid}|${level}|${isSell ? "s" : "b"}|${price}|${ordered}`, at, item: hrid, level, price, qty: filled, ordered, isSell });
        }
        return rows;
    }
    // Record import (milestone 5): another device's export of the same character, merged into this record. Events
    // merge by id (ids carry the device, so two devices never collide); what both devices capture independently is
    // matched by a natural key instead: replayed party chat (chat id, or time + message), the runs derived from it
    // and anything else time-stamped by the game (same kind and subject within 3 s), and listing fills (listing id,
    // quantity, price). Record-specific events (baseline, reprice, note) stay with their own record. Meta merges:
    // record start to the earlier one, Loot & XP Log sessions by id, market history by listing id, XP sessions by id.
    const IMPORT_SKIP = new Set(["baseline", "reprice", "note"]);
    function naturalKey(e) {
        switch (e.kind) {
            case "chat": return e.chatId != null ? `chat|id:${e.chatId}` : `chat|tm:${e.at}|${e.m}`;
            case "buy": case "sell": return e.listingId != null ? `${e.kind}|l:${e.listingId}|${num(e.qty)}|${num(e.unitPrice)}` : null;
            case "offline": return `offline|${num(e.from)}|${num(e.to)}`;
            default: return null;
        }
    }
    // Subject + time keys: a run start/end by zone, an open by chest and count, a craft by action, a consume by item
    // and quantity, a redeem by token and quantity. Two events of one subject within 3 s are the same event.
    function timedSubject(e) {
        switch (e.kind) {
            case "start": case "clear": case "fail": case "stop": return `${e.kind}|${e.zone || ""}`;
            case "open": return `open|${e.chest}|${num(e.count)}`;
            case "craft": return `craft|${e.action}`;
            case "consume": return `consume|${e.item}|${num(e.qty)}`;
            case "redeem": return `redeem|${e.token}|${num(e.qty)}`;
            case "damage": return `damage|${e.zone || ""}|${e.battleId}`;
            default: return null;
        }
    }
    function parseRecordFile(text) {
        let d = null; try { d = JSON.parse(text); } catch (_e) { return { error: "not JSON" }; }
        if (!isObj(d) || !/^metz-dungeon-stats\//.test(String(d.schema || "")) || !Array.isArray(d.events)) return { error: "not a Metz Dungeon Stats record export" };
        return { data: d };
    }
    async function importRecordData(d, label) {
        if (!state.record || !state.ready) throw new Error("no record open");
        const theirs = d.character && d.character.id != null ? String(d.character.id) : null;
        if (theirs && theirs !== String(state.characterId)) return { error: `that export is for character ${d.character.name || theirs}, this record is ${state.characterName || state.characterId}` };
        await state.record.flush();
        const local = await state.record.getAll("events");
        const ids = new Map(local.map(e => [e.id, e]));
        const nat = new Set(); const timed = new Map();
        const noteTimed = e => { const k = timedSubject(e); if (!k) return; let arr = timed.get(k); if (!arr) timed.set(k, arr = []); arr.push(num(e.at)); };
        for (const e of local) { const k = naturalKey(e); if (k) nat.add(k); noteTimed(e); }
        const sameTimed = e => { const k = timedSubject(e); if (!k) return false; const arr = timed.get(k); if (!arr) return false; const at = num(e.at); return arr.some(t => Math.abs(t - at) <= 3000); };
        const out = { added: 0, duplicate: 0, skipped: 0, conflict: 0, byKind: {} };
        const sorted = d.events.filter(isObj).slice().sort((a, b) => num(a.at) - num(b.at));
        for (const e of sorted) {
            if (!e.id || !e.kind || !(num(e.at) > 0)) { out.skipped++; continue; }
            const mine = ids.get(e.id);
            if (mine) { if (JSON.stringify(mine) === JSON.stringify(e)) out.duplicate++; else out.conflict++; continue; }
            if (IMPORT_SKIP.has(e.kind)) { out.skipped++; continue; }
            const k = naturalKey(e);
            if ((k && nat.has(k)) || sameTimed(e)) { out.duplicate++; continue; }
            const ev = { ...e, fromRecord: d.device || label || "import" };
            fixImportedTax(ev);   // a record exported before 0.1.3 still carries the old figure
            state.record.queue("events", ev); ids.set(ev.id, ev); if (k) nat.add(k); noteTimed(ev);
            if (ev.kind === "consume") addConsume(ev); else if (ev.kind === "damage") state.damage.push(ev); else state.timeline.push(ev);
            out.added++; out.byKind[ev.kind] = (out.byKind[ev.kind] || 0) + 1; state.counts.events++;
        }
        // Meta.
        const metaOf = key => { const r = (Array.isArray(d.meta) ? d.meta : []).find(m => m && m.key === key); return r ? (r.value !== undefined ? r.value : r) : undefined; };
        const rs = num(metaOf("recordStart"));
        if (rs > 0 && (!state.meta.recordStart || rs < state.meta.recordStart)) { state.meta.recordStart = rs; state.record.queue("meta", { key: "recordStart", value: rs }); out.recordStart = rs; }
        const ll = metaOf("lootLog"); if (Array.isArray(ll)) { let n = 0; for (const e of ll) { if (!isObj(e) || e.id == null) continue; const prev = state.lootLog.get(e.id); if (!prev || num(e.end) > num(prev.end) || num(e.count) > num(prev.count)) { if (prev && prev.first && !e.first) e.first = prev.first; state.lootLog.set(e.id, e); n++; } } if (n) { state.lootLogRev++; state.record.queue("meta", { key: "lootLog", value: [...state.lootLog.values()] }); } out.lootLog = n; }
        const mh = metaOf("marketHistory"); if (Array.isArray(mh) && mh.length) out.marketHistory = addMarketHistory(mh, `record:${d.device || label || "import"}`);
        const xpm = metaOf("xpRecord"); if (isObj(xpm)) { const R = xpRec(); let n = 0; if (isObj(xpm.startSnap) && (!R.startSnap || num(xpm.startAt) < num(R.startAt))) { R.startSnap = { ...xpm.startSnap }; R.startAt = num(xpm.startAt) || R.startAt; n++; } for (const [k, d] of Object.entries(isObj(xpm.days) ? xpm.days : {})) { if (!isObj(d) || !isObj(d.snap)) continue; const mine = R.days[k]; if (!mine) { R.days[k] = { snap: { ...d.snap }, activeMs: num(d.activeMs), offlineMs: num(d.offlineMs) }; n++; } else { for (const [sk, v] of Object.entries(d.snap)) if (mine.snap[sk] == null || v < mine.snap[sk]) mine.snap[sk] = v; mine.activeMs += num(d.activeMs); mine.offlineMs += num(d.offlineMs); } } R.activeMs += num(xpm.activeMs); R.offlineMs += num(xpm.offlineMs); if (num(xpm.lastTickAt) > R.lastTickAt) R.lastTickAt = num(xpm.lastTickAt); xpSave(); out.xp = n; }
        const cs = metaOf("chatSeen"); if (Array.isArray(cs)) { for (const k of cs) state.chatSeen.add(k); if (state.chatSeen.size > 1200) { const old = [...state.chatSeen].slice(0, state.chatSeen.size - 1200); for (const k of old) state.chatSeen.delete(k); } state.record.queue("meta", { key: "chatSeen", value: [...state.chatSeen] }); }
        state.timeline.sort((a, b) => a.at - b.at); state.timelineRev++;
        await state.record.flush();
        state.events = await state.record.getAll("events", "at", null, "prev", 200);
        emit("note", { text: `Record import ${label || ""} from ${d.device || "another device"}: ${out.added} events added${Object.keys(out.byKind).length ? ` (${Object.entries(out.byKind).map(([k, v]) => `${v} ${k}`).join(", ")})` : ""}, ${out.duplicate} already here, ${out.skipped} record-specific skipped, ${out.conflict} conflicts kept as ours${out.lootLog ? `; ${out.lootLog} loot log sessions` : ""}${out.marketHistory ? `; ${out.marketHistory} market listings` : ""}${out.xp ? `; ${out.xp} XP sessions` : ""}${out.recordStart ? `; record start moved to ${new Date(out.recordStart).toISOString()}` : ""}`, import: out }, "import");
        panel.touch();
        return out;
    }
    async function importRecordFile(file) {
        const { data, error } = parseRecordFile(await file.text());
        if (error) { W.alert(`Could not import ${file.name}: ${error}.`); return null; }
        const r = await importRecordData(data, file.name);
        if (r && r.error) { W.alert(`Not imported: ${r.error}.`); return null; }
        return r;
    }
    async function importMarketHistoryFile(file) {
        const text = await file.text(); const rows = parseMarketHistoryFile(text);
        if (!rows.length) { W.alert("No listings recognised in that file. Expected Toolasha's listing array (JSON) or its Market History CSV."); return 0; }
        const changed = addMarketHistory(rows, `file:${file.name}`);
        emit("note", { text: `Market history file ${file.name}: ${rows.length} listings, ${changed} new or updated; history now ${state.marketHistory.size}` }, "import");
        if (changed) await importToolasha("file", true);
        return changed;
    }
    function importToolasha(reason, reseed) {
        if (toolashaRunning) return toolashaRunning;
        toolashaRunning = (async () => {
            if (!state.record || !state.ready || !state.meta.recordStart) return;
            const fresh = await readToolashaListings();
            const added = fresh ? addMarketHistory(fresh, "toolasha:" + DEVICE) : 0;
            // Toolasha's copy of the Loot & XP Log, first and whatever else is found: the game only sends its current
            // window when the panel opens, Toolasha keeps every session it has seen, and the log is this record's count
            // of clears, chests and crafts (design 4.7). It used to sit after the market history and was skipped when
            // there was none.
            const history = await readToolashaStore("lootLogHistory", `lootLog_${state.characterId}`);
            if (Array.isArray(history)) { const n = mergeLootLog(history, "toolasha"); TOOLASHA.sessions = history.length; if (n) { emit("note", { text: `Toolasha loot log history: ${history.length} sessions, ${n} new or updated` }, "toolasha"); panel.touch(); } }
            const listings = marketHistoryRows(); if (!listings.length) return;
            const start = state.meta.recordStart;
            // 1. Seed purchase prices for the stock the baseline priced at ask.
            if (!state.meta.toolashaSeeded || reseed) {
                const rows = [];
                for (const [item, e] of state.ledger) {
                    if (!(e.qty > 0)) continue;
                    const buys = listings.filter(l => !l.isSell && l.item === item && l.level === 0 && l.at < start).sort((a, b) => b.at - a.at);
                    if (!buys.length) continue;
                    let left = e.qty, cost = 0, used = 0, ids = 0;
                    for (const b of buys) { if (left <= 0) break; const t = Math.min(left, b.qty); cost += t * b.price; used += t; left -= t; ids++; }
                    const prevAvg = e.cost / e.qty;
                    const newCost = cost + left * prevAvg;
                    rows.push({ item, qty: e.qty, covered: used, listings: ids, prevAvg, avg: newCost / e.qty, oldest: buys[Math.min(ids, buys.length) - 1].at });
                    e.cost = newCost;
                }
                // Key lots priced from the recipe or at ask follow the materials.
                const keyRows = [];
                for (const [item, lots] of state.keyLots) for (const lot of lots) { if (lot.basis !== "recipe" && lot.basis !== "ask") continue; const rp = recipePriceNow(item); if (!rp) continue; keyRows.push({ item, qty: lot.qty, prev: lot.unitCost, unitCost: rp.unitCost, basis: rp.basis }); lot.unitCost = rp.unitCost; lot.basis = "recipe"; }
                state.meta.toolashaSeeded = serverNow(); state.record.queue("meta", { key: "toolashaSeeded", value: state.meta.toolashaSeeded });
                state.record.queue("meta", { key: "ledger", value: ledgerState() });
                TOOLASHA.seeded = rows.length;
                if (rows.length || keyRows.length) emit("reprice", { from: "toolasha", items: rows, keys: keyRows, listings: listings.length }, "toolasha");
            }
            // 2. Fills inside the record window that the script never recorded.
            const seen = new Map();
            for (const e of state.timeline) if ((e.kind === "buy" || e.kind === "sell") && e.listingId != null) seen.set(e.listingId, (seen.get(e.listingId) || 0) + num(e.qty));
            let imported = 0;
            for (const l of listings) {
                if (l.at < start) continue;
                const missing = l.qty - (seen.get(l.id) || 0); if (missing <= 0) continue;
                if (l.isSell) { const gross = missing * l.price; const tax = Math.round(gross * marketTaxRate(l.item, l.at)); emit("sell", { listingId: l.id, item: l.item, level: l.level, qty: missing, unitPrice: l.price, gross, tax, net: gross - tax, taxBasis: "rate", imported: true, instant: false }, "toolasha", l.at); }
                else { emit("buy", { listingId: l.id, item: l.item, level: l.level, qty: missing, unitPrice: l.price, coins: missing * l.price, imported: true, instant: false }, "toolasha", l.at); if (l.level === 0) { ledgerAdd(l.item, missing, l.price); if (ref.keyItems.has(l.item)) keyLotAdd(l.item, missing, l.price, "bought", null); } }
                imported++;
            }
            TOOLASHA.imported += imported;
            if (imported) { state.timeline.sort((a, b) => a.at - b.at); state.timelineRev++; }
            info(`toolasha history (${reason}): ${listings.length} listings, ${TOOLASHA.seeded} items seeded, ${imported} fills imported`);
            panel.touch();
        })().catch(error => { warn("toolasha import failed", error); TOOLASHA.status = "failed: " + String(error && error.message || error); }).finally(() => { toolashaRunning = null; });
        return toolashaRunning;
    }
    // A sale imported from Toolasha's history carries the game's rule for its item on its day (marketTaxRate). Imports
    // before 0.1.3 stored the rate of whatever had sold last; this puts the rule's figure on the stored event itself, so
    // an export of the record is right too. True when the event changed.
    function fixImportedTax(e) {
        if (!isObj(e) || e.kind !== "sell" || !e.imported || e.taxBasis !== "rate" || !(num(e.gross) > 0)) return false;
        const tax = Math.round(e.gross * marketTaxRate(e.item, e.at));
        if (e.tax === tax && e.net === e.gross - tax) return false;
        e.tax = tax; e.net = e.gross - tax; return true;
    }
    async function openRecord(id) {
        try {
            const db = await openDb(id);
            state.record = createRecord(db);
            const metaRows = await state.record.getAll("meta");
            state.meta = {}; for (const r of metaRows) state.meta[r.key] = r.value !== undefined ? r.value : r;
            if (state.meta.ledger) restoreLedger(state.meta.ledger);
            if (isObj(state.meta.artisan)) state.artisan = state.meta.artisan;
            state.xpRec = null; xpRec();
            xpAbilityStart();
            state.marketHistory = new Map(); for (const l of (Array.isArray(state.meta.marketHistory) ? state.meta.marketHistory : [])) if (l && l.id != null) state.marketHistory.set(l.id, l);
            state.lootLog = new Map(); for (const e of (Array.isArray(state.meta.lootLog) ? state.meta.lootLog : [])) if (e && e.id != null) { e.source = [...new Set(String(e.source || "").split("+").filter(Boolean))].join("+"); state.lootLog.set(e.id, e); } state.lootLogRev++;
            state.lastChatAt = num(state.meta.lastChatAt);
            state.chatSeen = new Set(Array.isArray(state.meta.chatSeen) ? state.meta.chatSeen : []);
            state.events = (await state.record.getAll("events", "at", null, "prev", 200));
            const perKind = await Promise.all(TIMELINE_KINDS.map(k => state.record.getAll("events", "kind", IDBKeyRange.only(k))));
            state.timeline = perKind.flat().sort((a, b) => a.at - b.at); state.timelineRev++;
            const retaxed = state.timeline.filter(fixImportedTax);
            if (retaxed.length) { for (const e of retaxed) state.record.queue("events", e); for (const e of state.events) fixImportedTax(e); info(`imported sales re-taxed by the game's rule: ${retaxed.length}`); }
            state.consumeTotals = new Map(); for (const c of await state.record.getAll("events", "kind", IDBKeyRange.only("consume"))) addConsume(c);
            state.damage = await state.record.getAll("events", "kind", IDBKeyRange.only("damage"));
            {   // Sessions saved with no place (the login race above): the run record that covers them names it.
                const lost = state.damage.filter(e => !e.zone);
                if (lost.length) {
                    const runs = await state.record.getAll("runs");
                    for (const e of lost) {
                        const r = runs.find(x => (e.runId && x.id === e.runId) || (x.battleId === e.battleId && num(x.startAt) <= num(e.lastAt) && num(e.startAt) <= num(x.endAt || e.lastAt) + 60e3));
                        if (r && r.zone) { e.zone = r.zone; e.tier = r.tier; e.runId = e.runId || r.id; state.record.queue("events", e); }
                    }
                }
            }
            {
                const mo = state.meta.meterOpen;
                // A piece of another run than the one now in progress (the next run began during the reload, or its first
                // wave came in before the record opened): saved, and counted in the battle tab's running total when recent.
                if (isObj(mo) && isObj(mo.players) && !state.meter.stitch(mo)) { if (serverNow() - num(mo.lastAt) < METER_STALE_MS) streakAdd(mo); meterSave(mo); }
                // 0.2.0 before this change saved a reloaded run's first piece as "interrupted", and kept runs it saw
                // only part of. Stitch the first back into its run; move the rest into the all-seen total.
                const keep = [];
                for (const e of state.damage.slice().sort((a, b) => num(b.lastAt) - num(a.lastAt))) {
                    const piece = { ...e }; delete piece.id; delete piece.kind; delete piece.at; delete piece.clock; delete piece.src; delete piece.v;
                    if (e.result === "interrupted" && state.meter.session && state.meter.stitch(piece)) state.record.remove("events", e.id);
                    else if (!meterWhole(e)) { meterPartial(piece); state.record.remove("events", e.id); }
                    else keep.push(e);
                }
                state.damage = keep;
                if (state.meter.session) meterCheckpoint();
            }
            state.counts.events = await state.record.count("events");
            state.run = null;
            const openRuns = (await state.record.getAll("runs")).filter(r => r.result === "open");
            for (const r of openRuns) { r.result = "stop"; r.reason = "script restarted during the run"; r.endAt = r.endAt || serverNow(); saveRun(r); }
            info(`record open for character ${id}: ${state.counts.events} events`);
        } catch (error) { warn("could not open the record", error); }
    }
    // Persist the in-memory ledger every 30 s when it changed.
    setInterval(() => { if (state.record && state.ready) state.record.queue("meta", { key: "ledger", value: ledgerState() }); }, 30000);

    // ---------------------------------------------------------------------------------------------------------------
    // Dispatcher
    // ---------------------------------------------------------------------------------------------------------------
    function onMessage(text) {
        if (typeof text !== "string" || text.length < 10 || text.charCodeAt(0) !== 123) return;
        let m; try { m = JSON.parse(text); } catch (_e) { return; }
        const type = m && m.type; if (!type) return;
        state.counts.frames++; state.counts.byType.set(type, (state.counts.byType.get(type) || 0) + 1);
        try {
            if (type === "init_client_data") { if (buildRef(m)) ref.source = "message"; return; }
            if (type === "init_character_data") { onInitCharacter(m); return; }
            if (!state.characterId) return; // nothing before we know who we are
            retainFrame(type, m, "in");
            if (Array.isArray(m.endCharacterAbilities) && m.endCharacterAbilities.length) applyAbilities(m.endCharacterAbilities);
            switch (type) {
                case "new_battle": onNewBattle(m); try { trackPartyCons(m); trackPartyXp(m); } catch (error) { warn("party consumables", error); } meterOnNewBattle(m); break;
                case "battle_updated": meterOnUpdate(m); break;
                case "action_completed": onActionCompleted(m); break;
                case "actions_updated": applyActions(m.endCharacterActions); streakCheck(); if (state.run && !currentDungeonZone()) closeRun("stop", { reason: "dungeon action removed from the queue" }, "actions_updated"); break;
                case "items_updated": { const diffs = applyRows(m.endCharacterItems, false); if (diffs.length) onInventoryDiffs(diffs, "items_updated", m); break; }
                case "skills_updated": { const d = applySkills(m.endCharacterSkills); if (Object.keys(d).length) { xpTick(d, serverNow()); noteSkillingXp(d, null, serverNow()); } break; }
                case "loot_opened": onLootOpened(m); break;
                case "loot_log_updated": onLootLog(m); break;
                case "consumable_buffs_updated": case "action_type_consumable_slots_updated": noteBuffs(m); break;
                case "market_listings_updated": onListings(m); break;
                case "chat_message_received": onChat(m, false); break;
                case "battle_consumable_ability_updated": { // retained as a frame; the consume event comes from the inventory row
                    const c = m.consumable, it = c && ref.items[c.itemHrid];
                    if (it && it.hp > 0 && state.characterName && meterEnabled()) { state.meter.food(state.characterName, c.itemHrid, serverNow(), it.hpOverMs); meterFoodKeep({ who: state.characterName, item: c.itemHrid, at: serverNow(), overMs: it.hpOverMs }); }
                    break;
                }
                default: break;
            }
        } catch (error) { warn(`handler for ${type} failed`, error); }
        panel.touch();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Socket hooks: constructor proxy, prototype listener patch, and the page's MessageEvent data getter. Plus a
    // read-only wrap of send to see our own market orders. The script never sends anything itself.
    // ---------------------------------------------------------------------------------------------------------------
    const seen = new WeakSet(), attached = new WeakSet(), listenerMap = new WeakMap();
    const isGameSocket = s => { try { return !!(s && typeof s.url === "string" && /api(?:-test)?\.milkywayidle(?:cn)?\.com\/ws/.test(s.url)); } catch (_e) { return false; } };
    const handleEvent = e => { if (!e || seen.has(e)) return; seen.add(e); try { onMessage(e.data); } catch (_e) { /* quiet */ } };
    function attach(ws) {
        if (!isGameSocket(ws) || attached.has(ws)) return;
        attached.add(ws); state.sockets++;
        ws.addEventListener("message", handleEvent);
        try { const send = ws.send; if (typeof send === "function" && !send.__mdsWrapped) { const wrapped = function (data) { try { if (typeof data === "string") onOutgoing(data); } catch (_e) { /* never in the way */ } return send.apply(this, arguments); }; wrapped.__mdsWrapped = true; ws.send = wrapped; } } catch (_e) { /* fine */ }
    }
    function hookConstructor() {
        const wrap = Original => { if (!Original || Original.__mdsWrapped) return Original; const P = new Proxy(Original, { construct(t, args, nt) { const ws = Reflect.construct(t, args, nt); attach(ws); return ws; } }); try { Object.defineProperty(P, "__mdsWrapped", { value: true }); } catch (_e) { /* fine */ } return P; };
        const desc = Object.getOwnPropertyDescriptor(W, "WebSocket"); let current = wrap(W.WebSocket);
        try { if (desc && (desc.get || desc.set)) W.WebSocket = current; else Object.defineProperty(W, "WebSocket", { configurable: true, get() { return current; }, set(n) { current = wrap(n); } }); }
        catch (error) { warn("constructor hook failed", error); try { W.WebSocket = current; } catch (_e) { /* prototype hook remains */ } }
    }
    function hookPrototype() {
        const proto = W.WebSocket && W.WebSocket.prototype; if (!proto || proto.__mdsPatched) return;
        const add = proto.addEventListener, rem = proto.removeEventListener;
        if (typeof add === "function") proto.addEventListener = function (type, listener, options) {
            if (type !== "message" || !listener) return add.call(this, type, listener, options);
            const wrapped = function (event) { if (isGameSocket(this)) { attach(this); handleEvent(event); } if (typeof listener === "function") return listener.call(this, event); if (listener && typeof listener.handleEvent === "function") return listener.handleEvent(event); return undefined; };
            listenerMap.set(listener, wrapped); return add.call(this, type, wrapped, options);
        };
        if (typeof rem === "function") proto.removeEventListener = function (type, listener, options) { return rem.call(this, type, listenerMap.get(listener) || listener, options); };
        const om = Object.getOwnPropertyDescriptor(proto, "onmessage");
        if (om && om.set) Object.defineProperty(proto, "onmessage", { configurable: true, get: om.get, set(h) { if (typeof h !== "function") return om.set.call(this, h); return om.set.call(this, function (event) { if (isGameSocket(this)) { attach(this); handleEvent(event); } return h.call(this, event); }); } });
        try { Object.defineProperty(proto, "__mdsPatched", { value: true }); } catch (_e) { proto.__mdsPatched = true; }
    }
    function hookMessageData() {
        try {
            const proto = W.MessageEvent && W.MessageEvent.prototype; const desc = proto && Object.getOwnPropertyDescriptor(proto, "data");
            if (!desc || typeof desc.get !== "function" || desc.get.__mdsData) return;
            const original = desc.get;
            const hooked = function () { const v = original.call(this); try { const s = this.currentTarget || this.target; if (isGameSocket(s)) { attach(s); if (!seen.has(this)) { seen.add(this); state.viaData++; onMessage(v); } } } catch (_e) { /* never in the way */ } return v; };
            try { Object.defineProperty(hooked, "__mdsData", { value: true }); } catch (_e) { /* fine */ }
            Object.defineProperty(proto, "data", { ...desc, get: hooked });
        } catch (error) { warn("message-data hook failed", error); }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Runs and time, derived from the record. Pure: events in, runs + time summary out. test/derive.test.mjs runs this
    // same block over an exported record, so it uses nothing from the script's state; cfg carries what it needs.
    //
    // The party chat ledger is the clock: each systemChatMessage.partyKeyCount is a run start, and the run lasts until
    // the next party system message about the dungeon (the next key count = cleared, partyWaveFailed = failed,
    // partyBattleEnded = cancelled). That is also how Toolasha numbers runs, so the two agree to the second. Live
    // events (start/clear/fail/stop from the socket) fill in waves, chests, keys charged, deaths and XP, and stand in
    // for the ledger when there is none (solo, or chat history lost).
    // <derive>
    function derive(events, nowMs, cfg) {
        const C = Object.assign({ selfName: null, recordStart: 0, maxRunMs: 60 * 60e3, craftBurstMs: 90e3, offlineMinMs: 60e3, isChest: () => false, isKey: () => false, keyOf: () => null }, cfg || {});
        const n = v => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
        const evs = events.filter(e => e && e.kind !== "consume").sort((a, b) => a.at - b.at);
        const markers = [], liveStarts = [], liveEnds = [], crafts = [], offline = [], keyMoves = [];
        const opens = [];
        const seenChat = new Set();
        let zoneSeen = null;
        for (const e of evs) {
            switch (e.kind) {
                case "chat": {
                    const key = `${e.at}|${e.m}|${typeof e.meta === "string" ? e.meta : JSON.stringify(e.meta || "")}`;
                    if (seenChat.has(key)) break; seenChat.add(key); // a replayed history once duplicated live messages
                    const m = String(e.m || "").replace("systemChatMessage.", "");
                    let meta = e.meta; if (typeof meta === "string") { try { meta = JSON.parse(meta); } catch (_x) { meta = {}; } } meta = meta || {};
                    if (m === "partyKeyCount") markers.push({ t: e.at, type: "start", keys: C.selfName && e.keyCounts && e.keyCounts[C.selfName] != null ? n(e.keyCounts[C.selfName]) : null });
                    else if (m === "partyWaveFailed") markers.push({ t: e.at, type: "fail", wave: n(meta.wave) || null });
                    else if (m === "partyBattleEnded") markers.push({ t: e.at, type: "ended", zone: meta.actionHrid || null });
                    else if (m === "partyBattleStarted") markers.push({ t: e.at, type: "began", zone: meta.actionHrid || null });
                    break;
                }
                case "start": liveStarts.push(e); zoneSeen = e.zone || zoneSeen; break;
                case "clear": case "fail": case "stop": liveEnds.push(e); zoneSeen = e.zone || zoneSeen; break;
                case "craft": crafts.push(e); for (const o of (e.outputs || [])) if (C.isKey(o.item)) keyMoves.push({ t: e.at, item: o.item, delta: n(o.qty) }); break;
                case "buy": if (C.isKey(e.item)) keyMoves.push({ t: e.at, item: e.item, delta: n(e.qty) }); break;
                case "sell": if (C.isKey(e.item)) keyMoves.push({ t: e.at, item: e.item, delta: -n(e.qty) }); break;
                case "open": {
                    opens.push(e);
                    for (const g of (e.gains || [])) if (C.isKey(g.item)) keyMoves.push({ t: e.at, item: g.item, delta: n(g.qty) });
                    break;
                }
                case "offline": {
                    // Old records carry the game's 72 h horizon as `to`; the window can never run past the login itself.
                    const from = n(e.from), to = Math.min(n(e.to) || e.at, e.at);
                    if (to > from && (to - from >= C.offlineMinMs || (e.items || []).length)) offline.push({ from, to, items: e.items || [], xp: e.xpBySkill || {} });
                    break;
                }
                default: break;
            }
        }
        markers.sort((a, b) => a.t - b.t);
        // Deaths per run. New records carry the delta (deathsTotal beside it); older ones carry the player's cumulative
        // count for the whole party action, so the delta is taken against the previous live end of the same action.
        const deathsOf = new Map();
        { let lastTotal = null, lastAt = 0, lastB = null;
          for (const e of liveEnds.slice().sort((a, b) => a.at - b.at)) {
              if (e.deathsTotal != null || e.deaths == null) { deathsOf.set(e.id, e.deaths != null ? n(e.deaths) : null); if (e.deathsTotal != null) { lastTotal = n(e.deathsTotal); lastAt = e.at; lastB = e.battleId; } continue; }
              const cont = lastTotal != null && e.battleId != null && lastB != null && n(e.battleId) >= n(lastB) && e.at - lastAt < 2 * 3600e3;
              deathsOf.set(e.id, cont ? Math.max(0, n(e.deaths) - lastTotal) : null); lastTotal = n(e.deaths); lastAt = e.at; lastB = e.battleId;
          } }
        let curZone = null;
        for (const x of markers) { if (x.type === "began" && x.zone) curZone = x.zone; if (x.type === "start") x.zone = curZone; }
        const usedLive = new Set();
        const runs = [];
        for (let i = 0; i < markers.length; i++) {
            const s = markers[i]; if (s.type !== "start") continue;
            let end = null; for (let j = i + 1; j < markers.length; j++) { const x = markers[j]; if (x.type === "start" || x.type === "fail" || x.type === "ended") { end = x; break; } }
            const limit = end ? end.t + (end.type === "ended" ? 60e3 : 5e3) : nowMs; // a live stop trails the chat's ended message
            const liveStart = liveStarts.find(e => !usedLive.has(e.id) && Math.abs(e.at - s.t) <= 10e3) || null;
            let liveEnd = liveEnds.find(e => !usedLive.has(e.id) && e.at > s.t && e.at <= limit) || null;
            if (liveEnd && !liveStart) { const own = liveStarts.find(e => !e.partial && e.runId && e.runId === liveEnd.runId); if (own && Math.abs(own.at - s.t) > 10e3) liveEnd = null; } // that clear has a start of its own elsewhere
            if (liveStart) usedLive.add(liveStart.id); if (liveEnd) usedLive.add(liveEnd.id);
            for (const e of liveStarts) if (e.partial && e.at > s.t && e.at < limit) usedLive.add(e.id); // a join mid-run is not a run
            const zone = (liveEnd && liveEnd.zone) || (liveStart && liveStart.zone) || s.zone || zoneSeen;
            const run = { zone, startAt: s.t, endAt: null, durationMs: null, result: null, waves: null, chests: null, keysCharged: null, keysSrc: null, deaths: null, xpBySkill: null, xpPartial: !liveStart || !!liveStart.partial, battleId: liveStart ? liveStart.battleId : (liveEnd ? liveEnd.battleId : null), tier: liveStart && liveStart.tier != null ? liveStart.tier : (liveEnd && liveEnd.tier != null ? liveEnd.tier : null), source: liveEnd ? "chat+live" : "chat", keysBefore: s.keys, keysAfter: null, clearAt: null, note: null };
            if (end && end.type === "start") {
                run.keysAfter = end.keys;
                if (end.t - s.t > C.maxRunMs && !(liveEnd && liveEnd.kind === "clear")) { run.result = "unknown"; run.gapTo = end.t; run.note = "no end in the chat ledger and the next start is more than an hour later"; }
                else { run.result = liveEnd && liveEnd.kind === "fail" ? "fail" : "clear"; run.endAt = end.t; }
            } else if (end && end.type === "fail") { run.result = "fail"; run.endAt = end.t; run.waves = end.wave; }
            else if (end && end.type === "ended") { if (liveEnd && liveEnd.kind === "clear") { run.result = "clear"; run.endAt = liveEnd.at; } else { run.result = "cancelled"; run.endAt = end.t; } }
            else if (liveEnd) { run.result = liveEnd.kind === "stop" ? "cancelled" : liveEnd.kind; run.endAt = liveEnd.at; }
            else if (nowMs - s.t <= C.maxRunMs) run.result = "open";
            else { run.result = "unknown"; run.gapTo = null; run.note = "no end seen"; }
            if (liveEnd) {
                if (liveEnd.kind === "clear") run.clearAt = liveEnd.at;
                // A clear is every wave even when the script saw none of them (it started mid-run); XP and deaths it did not
                // see are unknown, not zero.
                if (liveEnd.waves > 0) run.waves = liveEnd.waves; else if (liveEnd.kind === "clear" && C.maxWavesOf) run.waves = C.maxWavesOf(run.zone) || null;
                const blind = !!liveEnd.noBattleSeen || (liveEnd.kind === "clear" && !(liveEnd.waves > 0));
                run.chests = Array.isArray(liveEnd.chests) ? liveEnd.chests : null; run.deaths = blind ? null : (deathsOf.get(liveEnd.id) ?? null); run.xpBySkill = blind || !liveEnd.xpBySkill || !Object.keys(liveEnd.xpBySkill).length ? null : liveEnd.xpBySkill; run.keyCost = liveEnd.keyCost || null; run.xpEnd = liveEnd.xpEnd || null;
                if (blind) run.note = "script was not running for the battles of this run: waves, deaths and XP not seen";
                if (liveEnd.keysCharged != null) { run.keysCharged = n(liveEnd.keysCharged); run.keysSrc = "clear message"; }
            }
            if (run.result === "clear" && run.keysCharged == null && run.keysBefore != null && run.keysAfter != null && end) {
                const keyItem = C.keyOf(zone);
                const adj = keyMoves.filter(k => (!keyItem || k.item === keyItem) && k.t > s.t && k.t <= end.t).reduce((a, k) => a + k.delta, 0);
                const charged = run.keysBefore - run.keysAfter + adj;
                if (charged >= 0) { run.keysCharged = charged; run.keysSrc = "key count"; }
            }
            if (run.endAt != null) run.durationMs = run.endAt - run.startAt;
            runs.push(run);
        }
        // Live runs the ledger does not cover (solo, or history lost).
        const inside = (t, slack) => runs.some(r => r.result !== "unknown" && t >= r.startAt - 10e3 && (r.endAt == null ? t <= nowMs : t < r.endAt + slack));
        for (const ls of liveStarts) {
            if (usedLive.has(ls.id)) continue; usedLive.add(ls.id);
            if (inside(ls.at, 0)) continue;
            const le = liveEnds.find(e => !usedLive.has(e.id) && e.runId && e.runId === ls.runId) || null; if (le) usedLive.add(le.id);
            const result = le ? (le.kind === "stop" ? "cancelled" : le.kind) : (nowMs - ls.at <= C.maxRunMs ? "open" : "unknown");
            runs.push({ zone: ls.zone, tier: ls.tier != null ? ls.tier : (le ? le.tier : null), startAt: ls.at, endAt: le ? le.at : null, durationMs: le ? le.at - ls.at : null, result, waves: le ? le.waves : null, chests: le && Array.isArray(le.chests) ? le.chests : null, keysCharged: le && le.keysCharged != null ? n(le.keysCharged) : null, keysSrc: le && le.keysCharged != null ? "clear message" : null, deaths: le ? deathsOf.get(le.id) ?? null : null, xpBySkill: le ? le.xpBySkill || null : null, xpPartial: !!ls.partial, battleId: ls.battleId, source: "live", partial: !!ls.partial, clearAt: le && le.kind === "clear" ? le.at : null, note: ls.partial ? "seen from a join, start time is the join" : null });
        }
        for (const le of liveEnds) {
            if (usedLive.has(le.id) || inside(le.at, 5e3)) continue; usedLive.add(le.id);
            const startAt = le.at - (n(le.durationMs) || 0);
            runs.push({ zone: le.zone, tier: le.tier != null ? le.tier : null, startAt, endAt: le.at, durationMs: n(le.durationMs) || null, result: le.kind === "stop" ? "cancelled" : le.kind, waves: le.waves, chests: Array.isArray(le.chests) ? le.chests : null, keysCharged: le.keysCharged != null ? n(le.keysCharged) : null, keysSrc: le.keysCharged != null ? "clear message" : null, deaths: deathsOf.get(le.id) ?? null, xpBySkill: le.xpBySkill || null, xpPartial: true, battleId: le.battleId, source: "live", clearAt: le.kind === "clear" ? le.at : null, note: "end seen without its start" });
        }
        runs.sort((a, b) => a.startAt - b.startAt);
        // The record window. Runs that began before it count only if they were still going when it began.
        const windowStart = C.recordStart || (runs.length ? runs[0].startAt : nowMs), windowEnd = nowMs;
        // XP for a run whose battles the script missed: the lifetime totals every run end records make it the total at
        // this end minus the total at the previous run's end, when that end came just before this run started (runs chain
        // back to back and XP only moves in battle). Otherwise it stays unknown.
        runs.sort((a, b) => a.startAt - b.startAt);
        for (let i = 1; i < runs.length; i++) {
            const r = runs[i], p = runs[i - 1];
            if (r.xpBySkill || !r.xpEnd || !p.xpEnd || p.endAt == null || r.startAt - p.endAt > 60e3) continue;
            const d = {}; for (const [k, v] of Object.entries(r.xpEnd)) { const dv = n(v) - n(p.xpEnd[k]); if (dv > 0 && k !== "/skills/total_level") d[k] = dv; }
            if (Object.keys(d).length) { r.xpBySkill = d; r.xpPartial = false; r.xpSrc = "lifetime totals at the two run ends"; r.note = r.note ? r.note.replace(/: waves, deaths and XP not seen/, ": deaths not seen; XP from the lifetime totals at the two run ends") : null; }
        }
        const kept = runs.filter(r => r.startAt >= windowStart || (r.endAt == null ? r.result === "open" : r.endAt > windowStart));
        for (const r of kept) if (r.startAt < windowStart) r.spansRecordStart = true;
        const clip = (a, b) => [Math.max(a, windowStart), Math.min(b, windowEnd)];
        const merge = ivs => { const s = ivs.filter(iv => iv[1] > iv[0]).sort((x, y) => x[0] - y[0]); const out = []; for (const iv of s) { const last = out[out.length - 1]; if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]); else out.push([iv[0], iv[1]]); } return out; };
        const sum = ivs => ivs.reduce((s, iv) => s + (iv[1] - iv[0]), 0);
        const complement = (ivs, a, b) => { const out = []; let cur = a; for (const iv of ivs) { if (iv[0] > cur) out.push([cur, Math.min(iv[0], b)]); cur = Math.max(cur, iv[1]); if (cur >= b) break; } if (cur < b) out.push([cur, b]); return out.filter(iv => iv[1] > iv[0]); };
        const intersect = (A, B) => { const out = []; for (const a of A) for (const b of B) { const x = Math.max(a[0], b[0]), y = Math.min(a[1], b[1]); if (y > x) out.push([x, y]); } return merge(out); };
        const dungeonIv = [], unknownIv = [];
        for (const r of kept) { if (r.result === "unknown") unknownIv.push(clip(r.startAt, r.gapTo || nowMs)); else dungeonIv.push(clip(r.startAt, r.endAt == null ? nowMs : r.endAt)); }
        // The game's Loot & XP Log fills the time this record did not watch (operator, 2026-11-22). A log session is one
        // action from its start to its end by the game's own clock, offline included: a dungeon session is time in
        // dungeons, a key craft session is crafting, any other session is time between runs. What stays unaccounted is
        // a stretch with no run end in the chat ledger AND no log session over it.
        const logIv = { dungeon: [], craft: [], other: [] };
        for (const e of (C.logSessions || [])) { const iv = clip(n(e.start), n(e.end) || n(e.start)); if (!(iv[1] > iv[0])) continue; (C.isDungeon && C.isDungeon(e.action) ? logIv.dungeon : C.isKeyCraft && C.isKeyCraft(e.action) ? logIv.craft : logIv.other).push(iv); }
        const watchedMerged = merge(dungeonIv), dungeonMerged = merge([...dungeonIv, ...logIv.dungeon]);
        const unknownOnly = intersect(merge(unknownIv), complement(merge([...dungeonMerged, ...logIv.craft, ...logIv.other]), windowStart, windowEnd));
        const between = complement(merge([...dungeonMerged, ...unknownOnly]), windowStart, windowEnd);
        const offlineIv = merge(offline.map(o => clip(o.from, o.to)));
        const bursts = []; for (const c of crafts) { const last = bursts[bursts.length - 1]; if (last && c.at - last.last <= C.craftBurstMs) { last.last = c.at; last.n++; } else bursts.push({ first: c.at, last: c.at, n: 1 }); }
        const craftIv = merge([...bursts.map(b => { const per = b.n > 1 ? (b.last - b.first) / (b.n - 1) : 10e3; return clip(b.first - per, b.last); }), ...logIv.craft]);
        const craftingBetween = intersect(between, craftIv), offlineBetween = intersect(between, offlineIv);
        const S = { windowStart, windowEnd, totalMs: windowEnd - windowStart, clears: 0, fails: 0, cancelled: 0, open: 0, unknown: 0, chests: {}, chestTotal: 0, keysCharged: 0, deaths: 0, clearMs: [], runMs: [], dungeonMs: sum(dungeonMerged), dungeonWatchedMs: sum(watchedMerged), dungeonLogMs: sum(dungeonMerged) - sum(watchedMerged), unknownMs: sum(unknownOnly), betweenMs: sum(between), craftingMs: sum(craftingBetween), offlineBetweenMs: sum(offlineBetween), offlineMs: sum(offlineIv), crafts: crafts.length, keysCrafted: crafts.reduce((s, c) => s + (c.outputs || []).reduce((a, o) => a + n(o.qty), 0), 0), counted: {} };
        // Items that are only counted (cowbells): total and per chest type, with how many chests of that type were opened.
        {
            const openedBy = {};
            for (const e of opens) { if (e.at < windowStart) continue; openedBy[e.chest] = (openedBy[e.chest] || 0) + (n(e.count) || 1); }
            for (const e of opens) { if (e.at < windowStart) continue; for (const g of (e.gains || [])) { if (!(g.counted || (C.isCounted && C.isCounted(g.item)))) continue; const c = S.counted[g.item] || (S.counted[g.item] = { qty: 0, byChest: {} }); c.qty += n(g.qty); const b = c.byChest[e.chest] || (c.byChest[e.chest] = { qty: 0, opened: 0 }); b.qty += n(g.qty); } }
            for (const c of Object.values(S.counted)) for (const [chest, b] of Object.entries(c.byChest)) b.opened = openedBy[chest] || 0;
        }
        S.otherMs = Math.max(0, S.betweenMs - S.craftingMs - S.offlineBetweenMs);
        for (const r of kept) {
            if (r.result === "clear") { S.clears++; if (r.durationMs != null) { S.clearMs.push(r.durationMs); S.runMs.push(r.durationMs); } }
            else if (r.result === "fail") { S.fails++; if (r.durationMs != null) S.runMs.push(r.durationMs); }
            else if (r.result === "cancelled") S.cancelled++; else if (r.result === "open") S.open++; else S.unknown++;
            if (r.keysCharged) S.keysCharged += r.keysCharged; if (r.deaths) S.deaths += r.deaths;
            for (const c of (r.chests || [])) { S.chests[c.item] = (S.chests[c.item] || 0) + n(c.qty); S.chestTotal += n(c.qty); }
        }
        const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
        S.avgClearMs = mean(S.clearMs); S.avgRunMs = mean(S.runMs); S.fastestMs = S.clearMs.length ? Math.min(...S.clearMs) : null; S.slowestMs = S.clearMs.length ? Math.max(...S.clearMs) : null;
        S.failRate = S.clears + S.fails ? S.fails / (S.clears + S.fails) : null;
        const blocks = offline.map(o => { const b = { from: o.from, to: o.to, ms: o.to - o.from, chests: {}, chestTotal: 0, keys: {}, xp: o.xp, runsInLedger: kept.filter(r => r.startAt >= o.from && r.startAt <= o.to).length }; for (const it of o.items) { if (C.isChest(it.item)) { b.chests[it.item] = (b.chests[it.item] || 0) + n(it.delta); b.chestTotal += n(it.delta); } else if (C.isKey(it.item)) b.keys[it.item] = (b.keys[it.item] || 0) + n(it.delta); } return b; }).filter(b => b.ms >= C.offlineMinMs && b.from >= windowStart); // a block that ended at the record's first login is before the record: its chests were in the baseline stock
        return { runs: kept, summary: S, offline: blocks, markers: markers.length };
    }
    // The game's own count over the record (design 4.7: "The game's count is the reference; the record adds what the
    // log does not have"). The Loot & XP Log is the server's tally of every session of a character action: clears,
    // chests and crafted keys, whichever device played them and offline included. Until 2026-11-21 the Overview
    // cards and the Keys table added up only what THIS browser had watched (plus the party chat and the offline
    // summaries), and the log was shown beside it in the Runs tab: 271 watched clears stood where the game counted
    // 2,211, and 1,093 entry keys where about 2,800 had gone (operator: "THE LOOT AND XP LOG WAS ALREADY SUPPOSED TO BE
    // THE TRUSTED SOURCE. THAT WAS IN THE INITIAL DESIGN").
    //
    // A session counts whole when it began inside the record. One that was already running when the record began
    // reports only its total, so it counts from the log's first reading of it inside the record (`first`, an exact
    // snapshot); with no such reading it is left to the record's own events and reported in `uncovered`. Outside
    // what the log covers -- since its last reading, and before that first reading -- the record's own events count,
    // so nothing is counted twice and nothing recent waits for the log to be opened.
    //   sessions: the stored log entries. d: derive()'s result. C: { isDungeon(action), isKeyCraft(action),
    //   isChest(item), isKey(item), crafts: the record's craft events }.
    function logTotals(sessions, d, C) {
        const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
        const ws = d.summary.windowStart;
        const T = { read: false, sessions: 0, uncovered: 0, lastEnd: 0, log: { clears: 0, chests: {}, crafted: {} }, own: { clears: 0, chests: {}, crafted: {} }, total: { clears: 0, chests: {}, crafted: {} } };
        const add = (map, drops, sign, pick) => { for (const [k, q] of Object.entries(drops || {})) { const h = String(k).split("::")[0]; if (pick(h)) map[h] = (map[h] || 0) + sign * n(q); } };
        const dungeonCover = [], craftCover = [];
        for (const e of sessions || []) {
            const dungeon = C.isDungeon(e.action), craft = !dungeon && C.isKeyCraft(e.action);
            if ((!dungeon && !craft) || !(n(e.end) > ws)) continue;
            let from = n(e.start), base = null;
            if (from < ws) { if (!(e.first && n(e.first.at) >= ws)) { T.uncovered++; continue; } from = n(e.first.at); base = e.first; }
            T.read = true; T.lastEnd = Math.max(T.lastEnd, n(e.end));
            if (dungeon) {
                T.sessions++; T.log.clears += n(e.count) - (base ? n(base.count) : 0);
                add(T.log.chests, e.drops, 1, C.isChest); if (base) add(T.log.chests, base.drops, -1, C.isChest);
                dungeonCover.push([from, n(e.end)]);
            } else {
                add(T.log.crafted, e.drops, 1, C.isKey); if (base) add(T.log.crafted, base.drops, -1, C.isKey);
                craftCover.push([from, n(e.end)]);
            }
        }
        const inside = (t, cover) => cover.some(([a, b]) => t >= a && t <= b);
        for (const r of d.runs || []) if (r.result === "clear" && r.endAt != null && r.endAt >= ws && !inside(r.endAt, dungeonCover)) {
            T.own.clears++; for (const c of r.chests || []) T.own.chests[c.item] = (T.own.chests[c.item] || 0) + n(c.qty);
        }
        for (const b of d.offline || []) if (b.to >= ws && !inside(b.to, dungeonCover)) for (const [h, q] of Object.entries(b.chests || {})) if (n(q) > 0) T.own.chests[h] = (T.own.chests[h] || 0) + n(q);
        for (const c of C.crafts || []) if (n(c.at) >= ws && !inside(n(c.at), craftCover)) for (const o of c.outputs || []) if (C.isKey(o.item)) T.own.crafted[o.item] = (T.own.crafted[o.item] || 0) + n(o.qty);
        T.total.clears = T.log.clears + T.own.clears;
        for (const part of ["chests", "crafted"]) for (const src of [T.log, T.own]) for (const [h, q] of Object.entries(src[part])) T.total[part][h] = (T.total[part][h] || 0) + q;
        return T;
    }
    // </derive>

    // ---------------------------------------------------------------------------------------------------------------
    // Money: spent, loot value at open, sold, net, and the per-item rows behind them. A pure function of the recorded
    // events plus what the bag holds now, so test/money.test.mjs can run it over an exported record.
    // ---------------------------------------------------------------------------------------------------------------
    // <money>
    // The game's market tax, by item and by date (operator, 2026-11-22, from the patch notes): a Bag of 10 Cowbells has
    // always been taxed 18%; everything else 2% until the patch of 2026-08-13, 5% until the patch of 2026-09-27, 4%
    // since. A sale this record watched carries the tax the game reported and never needs this. It is for a sale with
    // no reported tax (one imported from Toolasha's history) and for valuations with no sale behind them.
    const TAX_STEPS = [[Date.UTC(2026, 7, 13), 0.02], [Date.UTC(2026, 8, 27), 0.05]];
    const TAX_COWBELL_BAG = "/items/bag_of_10_cowbells";
    function marketTaxRate(item, at) {
        if (item === TAX_COWBELL_BAG) return 0.18;
        if (at != null) for (const [until, rate] of TAX_STEPS) if (at < until) return rate;
        return 0.04;
    }
    function deriveMoney(events, X) {
        const n = v => (typeof v === "number" && isFinite(v)) ? v : 0;
        const ws = X.recordStart || 0;
        const bump = (o, k, f) => { const e = o[k] || (o[k] = f()); return e; };
        // Old records hold an instant order twice (once from the item rows, once from the listing); the listing wins.
        const listed = events.filter(e => (e.kind === "buy" || e.kind === "sell") && e.listingId != null);
        const dup = e => (e.kind === "buy" || e.kind === "sell") && e.listingId == null && listed.some(l => l.kind === e.kind && l.item === e.item && l.qty === e.qty && Math.abs(l.at - e.at) < 20000);
        const buys = [], sells = [], crafts = [], opens = [], redeems = [], offline = [], clears = [], keeps = [], values = [];
        let baseline = null;
        for (const e of events) {
            if (e.kind === "baseline") { baseline = e; continue; }
            if (e.at < ws || dup(e)) continue;
            switch (e.kind) {
                case "buy": buys.push(e); break; case "sell": sells.push(e); break; case "craft": crafts.push(e); break;
                case "open": opens.push(e); break; case "redeem": redeems.push(e); break; case "offline": offline.push(e); break;
                case "clear": clears.push(e); break; case "keep": keeps.push(e); break; case "value": values.push(e); break;
                default: break;
            }
        }
        // Tax. The standard rate in force now is the game's rule (marketTaxRate), unless this record's own latest sale
        // says otherwise: the newest watched sale of an ordinary item priced at 10,000 or more a piece (small sales of
        // cheap items measured 4.1% to 4.7% against the 4% rule, so they are no measure; a Cowbell Bag has its own
        // rate). Per item, taxOn() adds the Cowbell Bag's 18%.
        const taxed = sells.filter(s => n(s.gross) > 0 && s.tax != null && !s.imported && s.item !== TAX_COWBELL_BAG && n(s.unitPrice) >= 10000).sort((a, b) => b.at - a.at);
        const tax = { rate: taxed.length ? Math.round(n(taxed[0].tax) / n(taxed[0].gross) * 1000) / 1000 : marketTaxRate(null, null), measured: taxed.length };
        const taxOn = item => (item === TAX_COWBELL_BAG ? marketTaxRate(item, null) : tax.rate);
        // A sale imported from Toolasha's history has no tax from the game: its tax is the rule for that item on that
        // day, whatever figure the import stored (imports before 0.1.3 copied the rate of the latest sale, which could
        // be a Cowbell Bag's 18% or a rounded-up small sale).
        const saleTax = s => {
            if (s.imported && s.taxBasis === "rate") { const t = Math.round(n(s.gross) * marketTaxRate(s.item, s.at)); return { tax: t, net: n(s.gross) - t }; }
            return { tax: n(s.tax), net: s.net != null ? n(s.net) : n(s.gross) * (1 - marketTaxRate(s.item, s.at)) };
        };
        // Cash out: buys and craft coins.
        const buyBy = {}; let buyTotal = 0;
        for (const b of buys) { const r = bump(buyBy, b.item, () => ({ qty: 0, coins: 0 })); r.qty += n(b.qty); r.coins += n(b.coins); buyTotal += n(b.coins); }
        const craftCoins = crafts.reduce((s, c) => s + n(c.coins), 0);
        const spent = { buys: buyTotal, craftCoins, total: buyTotal + craftCoins, buyBy };
        // A lot the record priced at the key's ask (keys held at record start, before 2026-11-01) is not a tracked
        // cost; it is re-priced like any key whose craft was never seen.
        const lotExact = kc => !!kc && kc.unitCost != null && !/ask|unknown/.test(String(kc.basis || ""));
        // Chests opened: value at bid when opened, coins, the key each opening consumed, items only counted.
        const gained = {}, chestBy = {};
        // An opening is dungeon loot when it is a dungeon chest or a container a dungeon chest can drop (the game's drop
        // tables: a Large Treasure Chest counts wherever it was opened, since it is a large part of a Pirate Chest's
        // value). A box no dungeon chest drops (a task reward and the crates inside it) goes to "other boxes", out of
        // the loot and the net.
        const other = { opened: 0, value: 0, coins: 0, kinds: {} }; const otherIds = new Set();
        // Tokens (operator, 2026-11-22): a token is worth the best bid per token among the shop items it buys, at the
        // opening, the same plain bid the rest of the loot is valued at. An opening recorded since 0.1.2 carries that
        // rate ("open"). An older one takes each shop item's bid from the opening nearest in time that recorded one
        // ("near": every shop item is also a chest drop), or today's bid when the record never saw the item ("now").
        const bidHist = {};
        for (const o of opens) for (const g of (o.gains || [])) if (n(g.bid) > 0 && g.item !== "/items/coin") (bidHist[g.item] = bidHist[g.item] || []).push([n(o.at), n(g.bid)]);
        for (const h of Object.values(bidHist)) h.sort((a, b) => a[0] - b[0]);
        const bidNear = (item, at) => { const h = bidHist[item]; if (!h || !h.length) return null; let lo = 0, hi = h.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (h[mid][0] < at) lo = mid + 1; else hi = mid; } const a = h[lo], b = lo > 0 ? h[lo - 1] : null; return b && Math.abs(b[0] - at) <= Math.abs(a[0] - at) ? b[1] : a[1]; };
        const tokenAt = (g, at) => {
            if (n(g.tokenBid) > 0) return { rate: n(g.tokenBid), basis: "open" };
            let best = null;
            for (const e of (X.tokenShop ? X.tokenShop(g.item) : [])) { let bid = bidNear(e.item, at), basis = "near"; if (!(bid > 0)) { bid = X.bidOf(e.item); basis = "now"; } if (!(bid > 0) || !(n(e.tokens) > 0)) continue; const per = bid * (n(e.count) || 1) / n(e.tokens); if (!best || per > best.rate) best = { rate: per, basis }; }
            return best;
        };
        const tokenLoot = { qty: 0, value: 0, open: 0, near: 0, now: 0, unpriced: 0 }, tokenRates = {};
        for (const o of opens) {
            const cnt = n(o.count) || 1;
            const derived = (X.isDungeonChest ? X.isDungeonChest(o.chest) : X.isChest(o.chest)) || (X.isDungeonLoot ? X.isDungeonLoot(o.chest) : false);
            if (!derived) {
                other.opened += cnt; other.coins += n(o.coinsGained); other.kinds[o.chest] = (other.kinds[o.chest] || 0) + cnt; otherIds.add(o.id);
                for (const g of (o.gains || [])) if (g.item !== "/items/coin" && !(g.counted || X.isCounted(g.item)) && n(g.bid) > 0) other.value += g.bid * n(g.qty);
                continue;
            }
            const cb = bump(chestBy, o.chest, () => ({ opened: 0, value: 0, coins: 0, keyCost: 0, keyBasis: {}, counted: {}, keyItem: o.keyItem || null, dungeon: X.isDungeonChest ? X.isDungeonChest(o.chest) : X.isChest(o.chest) }));
            cb.opened += cnt; cb.coins += n(o.coinsGained);
            if (lotExact(o.keyCost)) { cb.keyCost += o.keyCost.unitCost * cnt; cb.keyExact = (cb.keyExact || 0) + cnt; cb.keyBasis[o.keyCost.basis || "?"] = (cb.keyBasis[o.keyCost.basis || "?"] || 0) + cnt; } else cb.keyPending = (cb.keyPending || 0) + cnt;
            let v = 0;
            for (const g of (o.gains || [])) {
                if (g.item === "/items/coin") continue;
                if (g.counted || X.isCounted(g.item)) { cb.counted[g.item] = (cb.counted[g.item] || 0) + n(g.qty); continue; }
                const gi = bump(gained, g.item, () => ({ qty: 0, value: 0, priced: 0, chests: {} }));
                gi.qty += n(g.qty); gi.chests[o.chest] = (gi.chests[o.chest] || 0) + n(g.qty);
                if (n(g.bid) > 0) { gi.value += g.bid * n(g.qty); gi.priced += n(g.qty); v += g.bid * n(g.qty); }
                else if (X.isToken(g.item)) {
                    const t = tokenAt(g, n(o.at)); tokenLoot.qty += n(g.qty);
                    if (!t) { tokenLoot.unpriced += n(g.qty); continue; }
                    const worth = t.rate * n(g.qty); v += worth; cb.tokenValue = (cb.tokenValue || 0) + worth;
                    tokenLoot.value += worth; tokenLoot[t.basis] += n(g.qty); (tokenRates[o.id] = tokenRates[o.id] || {})[g.item] = t.rate;
                }
            }
            cb.value += v;
        }
        // A container that came out of a chest and was opened later (Large Treasure Chest) is worth its contents, not its
        // own bid as well: whatever bid it carried when gained comes off the total once it is opened.
        let revalued = 0;
        for (const [chest, cb] of Object.entries(chestBy)) { const gi = gained[chest]; if (!gi) continue; const avgBid = gi.priced ? gi.value / gi.priced : 0; const opened = Math.min(cb.opened, gi.qty); gi.opened = cb.opened; revalued += avgBid * opened; }
        const chestValue = Object.values(chestBy).reduce((s, c) => s + c.value, 0), chestCoins = Object.values(chestBy).reduce((s, c) => s + c.coins, 0);
        const loot = { atOpen: chestValue - revalued, atOpenRaw: chestValue, revalued, coins: chestCoins, opened: Object.values(chestBy).filter(c => c.dungeon).reduce((s, c) => s + c.opened, 0), nestedOpened: Object.values(chestBy).filter(c => !c.dungeon).reduce((s, c) => s + c.opened, 0), other, otherIds, tokens: tokenLoot, tokenRates };
        // Redemptions: tokens out, items in. What came in is dungeon loot too.
        const tokens = {};
        for (const [item, gi] of Object.entries(gained)) if (X.isToken(item)) { const t = bump(tokens, item, () => ({ gained: 0, redeemed: 0, received: {} })); t.gained += gi.qty; }
        for (const r of redeems) { const t = bump(tokens, r.token, () => ({ gained: 0, redeemed: 0, received: {} })); t.redeemed += n(r.qty); t.received[r.item] = (t.received[r.item] || 0) + n(r.itemQty); const gi = bump(gained, r.item, () => ({ qty: 0, value: 0, priced: 0, chests: {} })); gi.redeemed = (gi.redeemed || 0) + n(r.itemQty); if (n(r.bid) > 0) { gi.value += r.bid * n(r.itemQty); gi.priced += n(r.itemQty); } }
        for (const [k, t] of Object.entries(tokens)) {
            t.bag = X.held(k); t.held = Math.min(t.bag, Math.max(0, t.gained - t.redeemed)); t.holdover = t.bag - t.held;
            // Worth: the best coins per token any shop item costing only this token sells for at bid, net of tax
            // (the site's rule). Null when no shop item for it has a bid.
            let best = null;
            for (const e of (X.tokenShop ? X.tokenShop(k) : [])) { const bid = X.bidOf(e.item); if (bid == null) continue; const per = bid * (1 - tax.rate) * e.count / e.tokens; if (!best || per > best.perToken) best = { perToken: per, item: e.item, tokens: e.tokens, bid }; }
            t.perToken = best ? best.perToken : null; t.via = best ? best.item : null; t.viaTokens = best ? best.tokens : null;
            t.heldValue = best ? t.held * best.perToken : null; t.holdoverValue = best ? t.holdover * best.perToken : null; t.gainedValue = best ? t.gained * best.perToken : null;
        }
        // Sold: loot (anything the record saw come out of a chest or a redemption) against everything else.
        const lootItems = new Set(Object.keys(gained));
        const sellBy = {}; const sold = { loot: { qty: 0, gross: 0, tax: 0, net: 0 }, other: { qty: 0, gross: 0, tax: 0, net: 0 } };
        for (const s of sells) {
            const r = bump(sellBy, s.item, () => ({ qty: 0, gross: 0, tax: 0, net: 0, loot: lootItems.has(s.item) }));
            const { tax: taxPaid, net } = saleTax(s);
            r.qty += n(s.qty); r.gross += n(s.gross); r.tax += taxPaid; r.net += net;
            const b = r.loot ? sold.loot : sold.other; b.qty += n(s.qty); b.gross += n(s.gross); b.tax += taxPaid; b.net += net;
        }
        // Used in runs, at ledger cost: entry keys (live clears carry the lot cost; offline and older clears fall back
        // to the craft average, then the ask), chest keys at the opening, consumables (live uses plus offline deltas).
        const keysUsed = {};
        for (const c of clears) { const k = X.keyOf(c.zone); if (!k || !n(c.keysCharged)) continue; const r = bump(keysUsed, k, () => ({ qty: 0, cost: 0, exact: 0, fallback: 0 })); r.qty += c.keysCharged; if (lotExact(c.keyCost)) { r.cost += c.keyCost.unitCost * c.keysCharged; r.exact += c.keysCharged; } else r.fallback += c.keysCharged; }
        for (const o of offline) for (const it of (o.items || [])) if (X.isKey(it.item) && n(it.delta) < 0) { const r = bump(keysUsed, it.item, () => ({ qty: 0, cost: 0, exact: 0, fallback: 0 })); r.qty += -it.delta; r.fallback += -it.delta; }
        for (const [chest, cb] of Object.entries(chestBy)) if (cb.keyItem) { const r = bump(keysUsed, cb.keyItem, () => ({ qty: 0, cost: 0, exact: 0, fallback: 0 })); r.qty += cb.opened; r.cost += cb.keyCost; r.exact += cb.keyExact || 0; r.fallback += cb.keyPending || 0; }
        // Cost per key when this record has not seen the key crafted: the recipe's materials at their purchase ledger
        // average (asks for materials never bought), plus the recipe's coins. Full recipe quantities: an Artisan saving
        // only shows once a craft has been observed.
        const recipeCost = k => {
            for (const [action, r] of Object.entries(X.keyRecipes || {})) {
                const out = (r.outputs || []).find(o => o.item === k); if (!out || !(out.qty > 0)) continue;
                const art = X.artisanOf ? X.artisanOf(action) : null; const cut = art ? 1 - art.rate : 1;
                let cost = 0, asks = 0, missing = 0;
                for (const i of r.inputs || []) { if (i.item === "/items/coin") { cost += n(i.qty) * cut; continue; } const a = X.avgOf(i.item); const p = a != null ? a : X.askOf(i.item); if (p == null) { missing++; continue; } if (a == null) asks++; cost += p * n(i.qty) * cut; }
                if (missing) return null;
                if (art && art.tea) { const a = X.avgOf(art.tea); const p = a != null ? a : X.askOf(art.tea); if (p != null) cost += p * (art.seconds || 10) / (art.teaSeconds || 300); }
                return { unitCost: cost / out.qty, basis: `craft price${art ? `, artisan ${(art.rate * 100).toFixed(1)}%` : ""}` };
            }
            return null;
        };
        const keyPrice = k => { const u = X.keyAvg(k); if (u != null) return { unitCost: u, basis: "craft average" }; const rc = recipeCost(k); if (rc) return rc; const a = X.askOf(k); return a != null ? { unitCost: a, basis: "key ask now" } : null; };
        // Entry keys by the game's own count (design 4.7): the game charges one entry key for every chest a clear awards,
        // so the log's chests are the keys that went, on any device. What this record watched keeps its exact lot cost;
        // the rest is priced like every other use the record did not watch (craft average, then recipe, then ask).
        const logKeys = (X.logKeys && X.logKeys()) || null;
        for (const [k, q] of Object.entries(logKeys || {})) { const r = bump(keysUsed, k, () => ({ qty: 0, cost: 0, exact: 0, fallback: 0 })); r.watched = r.qty; r.log = q; if (q > r.qty) { r.fallback += q - r.qty; r.qty = q; } }
        const logCrafted = (X.logCrafted && X.logCrafted()) || null;
        for (const [k, r] of Object.entries(keysUsed)) { if (r.fallback) { const p = keyPrice(k); r.fallbackBasis = p ? p.basis : "unknown"; if (p) r.cost += p.unitCost * r.fallback; else r.unknown = r.fallback; } }
        for (const cb of Object.values(chestBy)) if (cb.keyItem && cb.keyPending) { const p = keyPrice(cb.keyItem); if (p) { cb.keyCost += p.unitCost * cb.keyPending; cb.keyBasis[p.basis] = (cb.keyBasis[p.basis] || 0) + cb.keyPending; } }
        const consUsed = {};
        for (const [item, t] of (X.consumeTotals || new Map())) { const r = bump(consUsed, item, () => ({ qty: 0, cost: 0, unknown: 0, offline: 0 })); r.qty += t.qty; r.cost += t.cost; r.unknown += t.unknownQty; }
        for (const o of offline) for (const it of (o.items || [])) if (X.isConsumable(it.item) && n(it.delta) < 0) { const r = bump(consUsed, it.item, () => ({ qty: 0, cost: 0, unknown: 0, offline: 0 })); const q = -it.delta; r.qty += q; r.offline += q; const u = it.unitCost != null ? it.unitCost : X.avgOf(it.item); if (u != null) r.cost += u * q; else r.unknown += q; }
        // Teas drunk while crafting keys: counted with the consumables, costed inside the key (the craft's cost already
        // includes them), so they do not enter the used-in-runs total twice.
        for (const c of crafts) for (const t of (c.teas || [])) { const r = bump(consUsed, t.item, () => ({ qty: 0, cost: 0, unknown: 0, offline: 0 })); r.qty += n(t.qty); r.craftQty = (r.craftQty || 0) + n(t.qty); if (t.unitCost != null) r.craftCost = (r.craftCost || 0) + t.unitCost * n(t.qty); }
        const used = { keys: keysUsed, consumables: consUsed, keyCost: Object.values(keysUsed).reduce((s, r) => s + r.cost, 0), consumableCost: Object.values(consUsed).reduce((s, r) => s + r.cost, 0) };
        used.total = used.keyCost + used.consumableCost;
        used.entryKeyCost = Object.entries(keysUsed).filter(([k]) => X.isEntryKey && X.isEntryKey(k)).reduce((s, [, r]) => s + r.cost, 0); used.chestKeyCost = used.keyCost - used.entryKeyCost;
        // Spent (operator, 2026-11-01): what the runs used, charged as used: entry keys at the clear, chest keys at the
        // open, consumables as consumed, each at its lot or ledger cost. Buys and craft coins are stock, shown but not
        // counted, or they would be charged twice.
        spent.total = used.total; spent.entryKeys = used.entryKeyCost; spent.chestKeys = used.chestKeyCost; spent.consumables = used.consumableCost;
        // Per-item loot rows: what came in, what left, what is still here, what is unaccounted for.
        const keptBy = {}; for (const k of keeps) keptBy[k.item] = (keptBy[k.item] || 0) + n(k.qty);
        const valuedBy = {}; for (const v of values) { const r = bump(valuedBy, v.item, () => ({ qty: 0, value: 0 })); r.qty += n(v.qty); r.value += n(v.qty) * n(v.unitValue); }
        const rows = [];
        for (const [item, gi] of Object.entries(gained)) {
            if (X.isToken(item)) continue;
            const s = sellBy[item] || { qty: 0, net: 0 };
            const held = X.held(item), onMarket = X.listed(item), kept = keptBy[item] || 0, opened = gi.opened || 0;
            const gainedQty = gi.qty + (gi.redeemed || 0);
            const missing = Math.max(0, gainedQty - s.qty - opened - held - onMarket - kept);
            const recordStock = Math.max(0, gainedQty - s.qty - opened - kept);
            const holdover = Math.max(0, held + onMarket - recordStock), heldRecord = Math.max(0, held - holdover);
            const bidNow = X.bidOf(item), bidAtOpen = gi.priced ? gi.value / gi.priced : null;
            // An accepted valuation covers at most what is still missing (a later Keep or sale shrinks it).
            const acc = valuedBy[item] || { qty: 0, value: 0 };
            const accepted = { qty: Math.min(acc.qty, missing), value: acc.qty ? acc.value * Math.min(acc.qty, missing) / acc.qty : 0 };
            const remaining = Math.max(0, missing - accepted.qty);
            const drift = bidNow != null && bidAtOpen ? Math.abs(bidNow - bidAtOpen) / bidAtOpen : null;
            const review = remaining > 0 && (bidNow == null || (drift != null && drift > (X.reviewPct != null ? X.reviewPct : 0.5)));
            const netBid = bidNow != null ? bidNow * (1 - taxOn(item)) : null;
            rows.push({
                item, gained: gainedQty, fromChests: gi.qty, redeemed: gi.redeemed || 0, opened, sold: s.qty, soldNet: s.net, held: heldRecord, bag: held, holdover, listed: onMarket, kept, missing,
                bidNow, bidAtOpen, heldValue: bidNow != null ? (held + onMarket - holdover) * bidNow : null, holdoverValue: bidNow != null ? holdover * bidNow : null, valueAtOpen: gi.value, unpricedAtOpen: gi.qty - gi.priced,
                acceptedQty: accepted.qty, acceptedValue: accepted.value, remaining, netBid, drift, review,
                missingValue: accepted.value + (!review && netBid != null ? remaining * netBid : 0),
                kind: X.isKey(item) ? "key" : X.isChest(item) ? "chest" : X.isOpenable(item) && X.isTradable(item) ? "container" : X.isTradable(item) ? "loot" : "untradable",
            });
        }
        rows.sort((a, b) => (b.valueAtOpen + b.soldNet) - (a.valueAtOpen + a.soldNet));
        const heldLoot = rows.filter(r => r.kind === "loot").reduce((s, r) => s + n(r.heldValue), 0);
        const holdoverLoot = rows.filter(r => r.kind === "loot" || r.kind === "container").reduce((s, r) => s + n(r.holdoverValue), 0);
        const missingLoot = rows.filter(r => r.kind === "loot" || r.kind === "container").reduce((s, r) => s + r.missingValue, 0);
        const reviewRows = rows.filter(r => r.review).length;
        // Supplies: keys, consumables and key materials still on hand, at ledger cost.
        const keyItems = new Set([...Object.keys(keysUsed), ...crafts.flatMap(c => (c.outputs || []).map(o => o.item)), ...Object.keys(buyBy).filter(X.isKey), ...((baseline && baseline.keys) || []).map(k => k.item), ...X.heldKeys()]);
        const keys = {};
        for (const k of keyItems) {
            if (X.isRealKey && !X.isRealKey(k)) continue;
            const craftedWatched = crafts.reduce((s, c) => s + (c.outputs || []).filter(o => o.item === k).reduce((a, o) => a + n(o.qty), 0), 0);
            // Crafted by the game's own count when the log has been read (crafts on another device are in it); never
            // fewer than this record watched.
            const craftedByLog = !!(logCrafted && logCrafted[k] != null && logCrafted[k] >= craftedWatched);
            const crafted = craftedByLog ? logCrafted[k] : craftedWatched;
            const bought = buyBy[k] ? buyBy[k].qty : 0, boughtCoins = buyBy[k] ? buyBy[k].coins : 0;
            const u = keysUsed[k] || { qty: 0, cost: 0, exact: 0, fallback: 0 };
            const avg = X.keyAvg(k), price = keyPrice(k);
            const base = ((baseline && baseline.keys) || []).find(b => b.item === k);
            keys[k] = { craftedByLog, craftedWatched, usedByLog: u.log != null && u.qty === u.log, usedWatched: u.watched != null ? u.watched : u.qty, crafted, bought, boughtAvg: bought ? boughtCoins / bought : null, used: u.qty, usedCost: u.cost, usedExact: u.exact, usedFallback: u.fallback, fallbackBasis: u.fallbackBasis || null, held: X.held(k), costPerKey: price ? price.unitCost : null, costBasis: price ? price.basis : "unknown", craftAvg: avg, baseline: base ? base.qty : 0, dropped: gained[k] ? gained[k].qty : 0 };
        }
        const materials = {};
        for (const [action, recipe] of Object.entries(X.keyRecipes || {})) {
            if (!(recipe.outputs || []).some(o => keys[o.item])) continue;
            for (const inp of recipe.inputs) {
                if (inp.item === "/items/coin") continue;
                const m = bump(materials, inp.item, () => ({ item: inp.item, recipes: [], perCraft: n(inp.qty), bought: 0, boughtCoins: 0, consumed: 0, consumedCost: 0, held: X.held(inp.item), avg: X.avgOf(inp.item), baseline: 0 }));
                m.recipes.push(action);
                if (buyBy[inp.item]) { m.bought = buyBy[inp.item].qty; m.boughtCoins = buyBy[inp.item].coins; }
                const base = ((baseline && baseline.items) || []).find(b => b.item === inp.item); if (base) m.baseline = base.qty;
            }
        }
        for (const c of crafts) for (const i of (c.inputs || [])) { const m = materials[i.item]; if (!m) continue; m.consumed += n(i.qty); if (i.unitCost != null) m.consumedCost += i.unitCost * n(i.covered != null ? i.covered : i.qty); }
        const consumables = {};
        const consNames = new Set([...Object.keys(consUsed), ...((baseline && baseline.items) || []).filter(b => b.kind === "consumable").map(b => b.item), ...Object.keys(buyBy).filter(X.isConsumable)]);
        for (const item of consNames) { const u = consUsed[item] || { qty: 0, cost: 0, unknown: 0, offline: 0 }; consumables[item] = { used: u.qty, usedCost: u.cost + (u.craftCost || 0), unknown: u.unknown, offline: u.offline, crafting: u.craftQty || 0, held: X.held(item), avg: X.avgOf(item), bought: buyBy[item] ? buyBy[item].qty : 0 }; }
        const keptRows = Object.entries(keptBy).filter(([, q]) => q > 0).map(([item, qty]) => ({ item, qty, held: X.held(item), bidNow: X.bidOf(item) }));
        const net = sold.loot.net + loot.coins - used.total;
        return { tax, spent, loot, sold, sellBy, used, net, heldLoot, holdoverLoot, missingLoot, reviewRows, rows, tokens, chests: chestBy, keys, materials, consumables, kept: keptRows, counts: { buys: buys.length, sells: sells.length, crafts: crafts.length, opens: opens.length, redeems: redeems.length, dropped: events.filter(dup).length } };
    }
    // </money>


    // ---------------------------------------------------------------------------------------------------------------
    // Panel: Overview, Runs, Data. Docked as a "Dungeon Stats" tab in the game's Combat tab strip when that strip is on
    // screen; a small floating button opens it anywhere else.
    // ---------------------------------------------------------------------------------------------------------------
    const CSS = `
/* Every size inside the panel is in em of the root font size, so the Settings text-size control scales the whole panel.
   The simulator site's system (zone-page/spira-theme.css + its design system): sea-slate ground, water accent, gold
   only for warnings, Inter, 8px radius, hairline dividers at 16% of the text colour. */
#mds-toggle{position:fixed;left:10px;bottom:10px;z-index:2147483000;background:#1c2a35;color:#e6eff3;border:1px solid rgba(230,239,243,.16);border-radius:8px;padding:7px 12px;font:500 13px/1.2 "Inter",system-ui,sans-serif;cursor:pointer;box-shadow:0 0 0 1px #3f424d}
#mds-toggle:hover{border-color:#45c8d8;color:#a9e9f1}
#mds-toggle[hidden]{display:none}
#mds-root{position:fixed;left:10px;bottom:46px;z-index:2147483000;width:min(840px,calc(100vw - 20px));max-height:min(72vh,700px);display:flex;flex-direction:column;background:#101b24;color:#e6eff3;border-radius:8px;box-shadow:0 0 0 1px #595d6c,0 16px 40px rgba(0,0,0,.65);font:400 14px/1.5 "Inter",system-ui,sans-serif;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
#mds-root[hidden]{display:none}
#mds-root.docked{position:static;z-index:auto;width:auto;max-height:none;border:0;border-radius:0;box-shadow:none;background:transparent;margin:0;text-align:left}
/* z-index:auto matters: the strip is a flex container, and a flex item's z-index makes a stacking context even when static, which put the docked panel above the game's popups (z 300). */
#mds-root *{box-sizing:border-box}
#mds-root .mds-head{display:flex;align-items:center;gap:10px;padding:10px 14px 8px}
#mds-root .mds-head strong{font-size:1.214em;font-weight:500;letter-spacing:-.015em}
#mds-root .mds-head .mds-sub{color:#c5d4de;font-size:.857em}
#mds-root .mds-head .mds-x{margin-left:auto;background:none;border:0;color:#c5d4de;font-size:1.43em;line-height:1;cursor:pointer}
#mds-root .mds-head .mds-x:hover{color:#e6eff3}
#mds-root.docked .mds-head .mds-x{display:none}
#mds-root .mds-tabs{display:inline-flex;margin:0 14px;border:1px solid rgba(230,239,243,.16);border-radius:8px;overflow:hidden;align-self:flex-start}
#mds-root .mds-tabs button{background:transparent;border:0;border-left:1px solid rgba(230,239,243,.16);color:#e6eff3;padding:7px 14px;cursor:pointer;font:500 1em/1.2 "Inter",system-ui,sans-serif}
#mds-root .mds-tabs button:first-child{border-left:0}
#mds-root .mds-tabs button.mds-drop{box-shadow:inset 0 0 0 1px #f0a830}
#mds-root .mds-tabs button:hover{background:rgba(230,239,243,.07)}
#mds-root .mds-tabs button[aria-selected="true"]{color:#45c8d8;box-shadow:inset 0 0 0 1px #45c8d8}
#mds-root .mds-body{overflow:auto;padding:12px 14px 14px}
#mds-root.docked .mds-body{overflow:visible}
#mds-root .mds-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:12px}
#mds-root .mds-card{display:flex;flex-direction:column;gap:3px;background:#1c2a35;border-radius:8px;padding:10px 12px;box-shadow:0 0 0 1px #3f424d}
#mds-root .mds-card .l{font-size:.786em;letter-spacing:.1em;text-transform:uppercase;color:#45c8d8}
#mds-root .mds-card .n{font-size:1.643em;font-weight:500;font-variant-numeric:tabular-nums;line-height:1.2}
#mds-root .mds-card small{display:block;color:#c5d4de;font-size:.857em;line-height:1.4}
#mds-root .mds-status{margin:0 0 10px;color:#c5d4de;font-size:.929em}
#mds-root .mds-banner{display:flex;align-items:center;gap:10px;margin:0 0 10px;padding:7px 10px;border:1px solid #45c8d8;border-radius:8px;color:#a9e9f1;font-size:.929em}
#mds-root .mds-banner[hidden]{display:none}
#mds-root .mds-banner .mds-x{margin-left:auto;background:none;border:0;color:#a9e9f1;font-size:1.3em;line-height:1;cursor:pointer}
#mds-root .mds-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 10px}
#mds-root .mds-bar button,#mds-root .mds-bar select,#mds-root .mds-bar label,#mds-root button.mds-act{background:transparent;border:1px solid rgba(230,239,243,.16);color:#e6eff3;border-radius:8px;padding:6px 10px;font:500 .929em/1.2 "Inter",system-ui,sans-serif;cursor:pointer}
#mds-root .mds-bar select{background:#1c2a35}
#mds-root .mds-bar label{display:inline-flex;align-items:center;gap:6px;cursor:pointer}
#mds-root .mds-bar label input{accent-color:#45c8d8;margin:0}
#mds-root .mds-bar button:hover,#mds-root button.mds-act:hover{background:rgba(230,239,243,.07)}
#mds-root .mds-bar button.danger{border-color:#d3a13a;color:#f2d99a}
#mds-root .mds-bar button.danger:hover{background:rgba(211,161,58,.12)}
#mds-root button.mds-act{padding:3px 9px;font-size:.857em;white-space:nowrap}
#mds-root td.mds-acts{white-space:nowrap}
#mds-root .mds-head .mds-head-btn{margin-left:6px;background:transparent;border:1px solid rgba(230,239,243,.16);color:#e6eff3;border-radius:8px;padding:3px 9px;font:500 .857em/1.2 "Inter",system-ui,sans-serif;cursor:pointer}
#mds-root .mds-head .mds-head-btn:disabled{opacity:.5;cursor:default}
#mds-root td.mds-acts-plan{width:7.5em;min-width:7.5em;box-sizing:border-box}
#mds-root tr.mds-flash td,#mds-root .mds-card.mds-flash{background:rgba(69,200,216,.18)}
#mds-root td.mds-acts .mds-act+.mds-act{margin-left:6px}
#mds-root .mds-bar .mds-note{color:#c5d4de;font-size:.857em}
#mds-root table{width:100%;border-collapse:collapse;font-size:1em;font-variant-numeric:tabular-nums}
#mds-root th.mds-sort-asc::after{content:" ▲";color:#45c8d8}
#mds-root th.mds-sort-desc::after{content:" ▼";color:#45c8d8}
#mds-root table[data-key] th:hover{color:#e6eff3}
#mds-root th{position:sticky;top:0;background:#1c2a35;text-align:left;cursor:pointer;user-select:none;font-size:.786em;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:rgba(230,239,243,.6);padding:7px 9px;border-bottom:1px solid rgba(230,239,243,.16)}
#mds-root td{padding:6px 9px;border-bottom:1px solid rgba(230,239,243,.08);vertical-align:top;line-height:1.4;text-align:left}
#mds-root .mds-card,#mds-root .mds-cards,#mds-root p,#mds-root h4,#mds-root .mds-bar{text-align:left}
#mds-root tbody tr:hover td{background:rgba(230,239,243,.04)}
#mds-root td.k{white-space:nowrap;font-weight:500}
#mds-root td.t{white-space:nowrap;color:#c5d4de}
#mds-root td.d{color:#dee9ef;word-break:break-word}
#mds-root td small{display:block;color:#c5d4de;font-size:.786em;font-weight:400}
#mds-root tr.review td.k{color:#f2d99a}
#mds-root tr.clear td.k{color:#a9e9f1}
#mds-root tr.fail td.k,#mds-root tr.stop td.k{color:#e6be62}
#mds-root tr.cancelled td.k,#mds-root tr.offline td{color:#c5d4de}
#mds-root tr.offline td{font-style:italic}
#mds-root tr.open td.k{color:#45c8d8}
#mds-root .mds-wrap{max-height:400px;overflow:auto;border-radius:8px;background:#1c2a35;box-shadow:0 0 0 1px #3f424d}
#mds-root .mds-wrap-chests{max-height:460px}
#mds-root .mds-pane[hidden]{display:none}
#mds-root p.mds-note{color:#c5d4de;font-size:.857em;margin:8px 0 0;line-height:1.45}
#mds-root h4{margin:14px 0 6px;font-size:.786em;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:rgba(230,239,243,.6)}
#mds-root details.mds-fold{margin:0 0 6px}
#mds-root details.mds-fold > summary{display:flex;align-items:baseline;gap:8px;list-style:none;cursor:pointer;margin:12px 0 6px;font-size:.786em;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:rgba(230,239,243,.6);user-select:none}
#mds-root details.mds-fold:first-child > summary{margin-top:0}
#mds-root details.mds-fold > summary::-webkit-details-marker{display:none}
#mds-root details.mds-fold > summary::before{content:"▸";color:rgba(230,239,243,.5);font-size:1.1em;line-height:1}
#mds-root details.mds-fold[open] > summary::before{content:"▾"}
#mds-root details.mds-fold > summary:hover{color:#e6eff3}
#mds-root .mds-fold-sum{margin-left:auto;text-transform:none;letter-spacing:0;font-size:1.05em;color:#c5d4de}
#mds-root .mds-fold-body > .mds-set:first-child{margin-top:0}
#mds-root details{margin:8px 0}
#mds-root summary{cursor:pointer;color:#a9e9f1}
#mds-root pre{white-space:pre-wrap;word-break:break-word;background:#1c2a35;padding:8px 10px;border-radius:8px;max-height:220px;overflow:auto;font-size:.857em;box-shadow:0 0 0 1px #3f424d}
#mds-root .mds-flag{border-bottom:1px dotted rgba(230,239,243,.5);cursor:help;white-space:nowrap}
#mds-root .mds-card{cursor:grab}
#mds-root .mds-card.mds-dragging{opacity:.5}
#mds-root .mds-card.mds-drop{box-shadow:0 0 0 2px #45c8d8}
#mds-root .mds-icon{width:1.35em;height:1.35em;vertical-align:-.3em;margin-right:5px}
#mds-root .mds-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:8px;margin-bottom:12px}
#mds-root .mds-tile{display:flex;flex-direction:column;align-items:center;gap:2px;padding:8px 6px;background:#1c2a35;border:0;border-radius:8px;box-shadow:0 0 0 1px #3f424d;color:#e6eff3;font:inherit;cursor:pointer;text-align:center}
#mds-root .mds-tile:hover{box-shadow:0 0 0 1px #45c8d8}
#mds-root .mds-tile.slotted{box-shadow:0 0 0 1px #45c8d8,inset 0 2px 0 #45c8d8}
#mds-root .mds-tile .mds-icon{width:2.2em;height:2.2em;margin:0}
#mds-root .mds-tile strong{font-size:1.07em;font-weight:500;font-variant-numeric:tabular-nums}
#mds-root .mds-tile small{color:#c5d4de;font-size:.786em;line-height:1.2}
#mds-root a.mds-link{color:#a9e9f1;text-decoration:none;border-bottom:1px dotted rgba(169,233,241,.5)}
#mds-root a.mds-link:hover{color:#45c8d8;border-bottom-color:#45c8d8}
#mds-root .mds-num{width:7em;background:#1c2a35;border:1px solid rgba(230,239,243,.16);color:#e6eff3;border-radius:6px;padding:4px 6px;font:inherit}
#mds-root input.mds-num.mds-num-wide{width:11.5em;min-width:11.5em}
#mds-root th.mds-dragging{opacity:.5}
#mds-root th.mds-drop{box-shadow:inset 2px 0 0 #45c8d8}
#mds-root .mds-set{margin:4px 0 10px;padding:8px 10px;background:#1c2a35;border-radius:8px;box-shadow:0 0 0 1px #3f424d}
#mds-root .mds-set-title{display:block;font-size:.929em;font-weight:500;margin-bottom:6px}
#mds-root .mds-set .mds-bar{margin:0 0 8px}
#mds-root .mds-set > :last-child{margin-bottom:0}
/* Damage meter (0.2.0): the Damage tab and the block under the game's battle cards. :is() keeps the id's weight. */
:is(#mds-root,#mds-bm) .mds-meter{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
:is(#mds-root,#mds-bm) .mds-meter tr.mds-mrow{cursor:pointer}
:is(#mds-root,#mds-bm) .mds-meter tr.mds-mrow:hover td{background:rgba(230,239,243,.05)}
:is(#mds-root,#mds-bm) .mds-meter td.mds-mname{white-space:nowrap;font-weight:500}
:is(#mds-root,#mds-bm) .mds-meter td.mds-mname::before{content:"▸";display:inline-block;width:1.1em;color:rgba(230,239,243,.5)}
:is(#mds-root,#mds-bm) .mds-meter tr.mds-mrow.open td.mds-mname::before{content:"▾"}
:is(#mds-root,#mds-bm) .mds-meter tr.mds-me td.mds-mname{color:#a9e9f1}
:is(#mds-root,#mds-bm) .mds-meter :is(th,td).n{text-align:right;white-space:nowrap}
:is(#mds-root,#mds-bm) .mds-meter td.mds-mbar{position:relative;min-width:8em}
:is(#mds-root,#mds-bm) .mds-meter td.mds-mbar .fill{transition:width .3s ease-out;position:absolute;left:6px;top:22%;bottom:22%;max-width:calc(100% - 12px);background:rgba(69,200,216,.3);border-radius:3px}
:is(#mds-root,#mds-bm) .mds-meter td.mds-mbar .v{position:relative;padding-left:4px}
:is(#mds-root,#mds-bm) .mds-meter tr.mds-mdetail>td{background:rgba(0,0,0,.2);padding:6px 10px 10px}
:is(#mds-root,#mds-bm,#mds-bm-pop) .mds-msub{width:100%;border-collapse:collapse;font-size:.93em}
:is(#mds-root,#mds-bm,#mds-bm-pop) .mds-msub :is(th,td){padding:3px 8px;text-align:left;position:static}
:is(#mds-root,#mds-bm,#mds-bm-pop) .mds-msub :is(th,td).n{text-align:right}
:is(#mds-root,#mds-bm,#mds-bm-pop) details.mds-mfold{margin:8px 0 0}
:is(#mds-root,#mds-bm,#mds-bm-pop) .mds-msub tr.mds-subhead{cursor:pointer}
:is(#mds-root,#mds-bm,#mds-bm-pop) .mds-msub tr.mds-subhead:hover td{background:rgba(230,239,243,.05)}
:is(#mds-root,#mds-bm,#mds-bm-pop) .mds-msub tr.mds-subhead>td:first-child::before{content:"▸";display:inline-block;width:1.1em;color:rgba(230,239,243,.5)}
:is(#mds-root,#mds-bm,#mds-bm-pop) .mds-msub tr.mds-subhead.open>td:first-child::before{content:"▾"}
:is(#mds-root,#mds-bm,#mds-bm-pop) .mds-msub tr:not(.mds-subhead):not(.mds-subrow)>td:first-child{padding-left:calc(8px + 1.1em)}
:is(#mds-root,#mds-bm,#mds-bm-pop) .mds-msub tr.mds-subrow>td{color:#c5d4de;font-size:.95em;background:rgba(0,0,0,.12)}
:is(#mds-root,#mds-bm,#mds-bm-pop) .mds-msub tr.mds-subrow>td:first-child{padding-left:calc(8px + 2.4em)}
:is(#mds-root,#mds-bm,#mds-bm-pop) details.mds-mfold>summary{cursor:pointer;list-style:none;display:block;padding:3px 0;color:#e6eff3;font-size:.93em}
:is(#mds-root,#mds-bm,#mds-bm-pop) details.mds-mfold>summary::-webkit-details-marker{display:none}
:is(#mds-root,#mds-bm,#mds-bm-pop) details.mds-mfold>summary::before{content:"▸";display:inline-block;width:1.1em;color:rgba(230,239,243,.5)}
:is(#mds-root,#mds-bm,#mds-bm-pop) details.mds-mfold[open]>summary::before{content:"▾"}
:is(#mds-root,#mds-bm,#mds-bm-pop) details.mds-mfold>summary b{font-weight:500}
:is(#mds-root,#mds-bm,#mds-bm-pop) details.mds-mfold>summary:hover b{color:#a9e9f1}
:is(#mds-root,#mds-bm,#mds-bm-pop) .mds-hint{color:rgba(230,239,243,.5);font-weight:400}
:is(#mds-root,#mds-bm,#mds-bm-pop) .mds-mlists{display:flex;flex-direction:column;gap:4px;margin-top:8px;font-size:.9em;color:#c5d4de}
:is(#mds-root,#mds-bm,#mds-bm-pop) .mds-mlists b{color:#e6eff3;font-weight:500}
#mds-root .mds-dmg-head{margin:0 0 10px;color:#c5d4de;font-size:.929em}
#mds-root tbody#mds-dmg-sessions tr{cursor:pointer}
#mds-root tbody#mds-dmg-sessions tr.sel td{background:rgba(69,200,216,.12)}
/* The battle panel stacks its parts in a column of fixed height. The meter keeps the height it has with every player
   folded and scrolls inside when one is opened, never more than half the panel (set by renderBattleMeter, which
   measures both: the panel is the chat-resized part of the window, not the window). */
#mds-bm{box-sizing:border-box;width:100%;flex:0 0 auto;align-self:stretch;display:flex;flex-direction:column;overflow:hidden;margin:6px 0 0;padding:6px 10px;background:#101b24;color:#e6eff3;border-radius:8px;box-shadow:0 0 0 1px #3f424d;font:400 13px/1.45 "Inter",system-ui,sans-serif;text-align:left}
#mds-bm *{box-sizing:border-box}
/* The table scrolls inside the block's fixed cap; the head line stays put. */
#mds-bm .mds-bm-body{flex:1 1 auto;min-height:0;overflow:auto}
/* The game centres the unit cards in the battle area (BattlePanel_combatUnitGrid: align-content center, read in its
   stylesheet 2026-11-23). Sat on the line above the consumables instead, the spare height goes above the cards. */
[class*="BattlePanel_combatUnitGrid__"]{align-content:end !important}
#mds-bm .mds-bm-head{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline;margin-bottom:4px}
#mds-bm .mds-bm-head strong{font-weight:500}
#mds-bm .mds-bm-head small{color:#c5d4de;font-size:12px}
#mds-bm .mds-bm-head strong{font-size:14px}
#mds-bm .mds-bm-dps{font-weight:500;color:#a9e9f1}
:is(#mds-bm,#mds-bm-pop) .mds-check{font-size:11px;font-weight:500;color:#9fd9a8;border:1px solid rgba(159,217,168,.35);border-radius:9px;padding:0 6px;cursor:help;white-space:nowrap}
:is(#mds-bm,#mds-bm-pop) .mds-check.bad{color:#f2d99a;border-color:rgba(211,161,58,.5)}
#mds-bm .mds-bm-btns{margin-left:auto;display:flex;gap:6px}
#mds-bm .mds-bm-btns button{background:transparent;border:1px solid rgba(230,239,243,.16);color:#e6eff3;border-radius:6px;padding:2px 8px;font:500 12px/1.3 "Inter",system-ui,sans-serif;cursor:pointer}
#mds-bm .mds-bm-btns button:hover{background:rgba(230,239,243,.07)}
#mds-bm th{position:sticky;top:0;z-index:1;background:#101b24;font-size:11px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:rgba(230,239,243,.6);padding:2px 6px;border-bottom:1px solid rgba(230,239,243,.16);text-align:left}
#mds-bm td{padding:2px 6px;border-bottom:1px solid rgba(230,239,243,.08);vertical-align:top;line-height:1.35}
#mds-bm .mds-msub th{position:static;background:none}
@media (prefers-reduced-motion: reduce){:is(#mds-root,#mds-bm) .mds-meter td.mds-mbar .fill{transition:none}}
#mds-bm .mds-meter td.mds-mname::before{content:none}
/* Clicking a player opens their details: said on every row (operator, 2026-11-23). */
#mds-bm .mds-meter td.mds-mname::after{content:"details ›";display:inline-block;margin-left:8px;padding:0 7px;border:1px solid rgba(69,200,216,.4);border-radius:9px;font-size:10px;font-weight:500;line-height:1.5;color:#a9e9f1;opacity:.75;vertical-align:1px}
#mds-bm .mds-meter tr.mds-mrow:hover td.mds-mname::after{opacity:1;background:rgba(69,200,216,.18);border-color:#45c8d8}
:is(#mds-root,#mds-bm) .mds-meter th .mds-hint{text-transform:none;letter-spacing:0;font-weight:400;color:rgba(230,239,243,.5)}
/* A player's details from the battle meter open in a popup, so the meter keeps its size (operator, 2026-11-23). */
/* Equal-width digits everywhere a number updates live (suggested 2026-11-23: the meter header jumped as its numbers changed). */
#mds-bm,#mds-bm-pop,#mds-bkeys{font-variant-numeric:tabular-nums}
/* Columns take their content's width and the damage bar the rest (operator, 2026-11-23: blank space between columns);
   a light line between columns, and a grip on each header's right edge to set a width by hand (double-click: automatic). */
:is(#mds-root,#mds-bm) .mds-meter :is(th,td).n,:is(#mds-root,#mds-bm) .mds-meter td.mds-mname,:is(#mds-root,#mds-bm) .mds-meter th[data-mcol="name"]{width:1px;white-space:nowrap}
:is(#mds-root,#mds-bm) .mds-meter :is(th,td).n{padding-left:14px;padding-right:12px}
:is(#mds-root,#mds-bm) .mds-meter tr>:is(th,td)+:is(th,td){border-left:1px solid rgba(230,239,243,.07)}
#mds-bm .mds-meter th{position:relative}
.mds-meter .mds-colrz{position:absolute;top:0;bottom:0;right:-4px;width:8px;cursor:col-resize;z-index:2}
/* The last header's grip stays inside the table: sticking out 4 px gave the meter a horizontal scroll bar. */
.mds-meter th:last-child .mds-colrz{right:0;width:5px}
.mds-meter .mds-colrz:hover{background:rgba(69,200,216,.35)}
.mds-meter th[data-mcol]{cursor:pointer;user-select:none}
.mds-meter th[data-mcol]:hover{color:#e6eff3}
.mds-meter th.mds-sort-asc::after{content:" ▲";color:#45c8d8}
.mds-meter th.mds-sort-desc::after{content:" ▼";color:#45c8d8}
/* Fixed slots for the header's two live figures (operator, 2026-11-23): damage up to 999.99m, DPS up to 5 digits. */
#mds-bm .mds-fixd{display:inline-block;min-width:6.9ch;text-align:left}
#mds-bm .mds-fixp{display:inline-block;min-width:5.6ch;text-align:right}
#mds-bm-pop{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.45)}
#mds-bm-pop[hidden]{display:none}
#mds-bm-pop *{box-sizing:border-box}
#mds-bm-pop .mds-pop-card{width:min(780px,100%);max-height:80vh;overflow:auto;padding:10px 14px 12px;background:#101b24;color:#e6eff3;border-radius:8px;box-shadow:0 0 0 1px #595d6c,0 16px 40px rgba(0,0,0,.65);font:400 13px/1.45 "Inter",system-ui,sans-serif;text-align:left}
#mds-bm-pop .mds-pop-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;margin-bottom:8px}
#mds-bm-pop .mds-pop-head strong{font-size:15px;font-weight:500}
#mds-bm-pop .mds-pop-head small{color:#c5d4de;font-size:12px}
#mds-bm-pop .mds-pop-card{position:relative}
#mds-bm-pop .mds-pop-head{padding-right:26px;cursor:move;user-select:none;touch-action:none}
#mds-bm-pop .mds-pop-head button{position:absolute;top:6px;right:10px;background:none;border:0;color:#c5d4de;font-size:20px;line-height:1;cursor:pointer}
#mds-bm-pop .mds-pop-head button:hover{color:#e6eff3}
#mds-bm-pop th{font-size:11px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:rgba(230,239,243,.6);border-bottom:1px solid rgba(230,239,243,.16)}
#mds-bm-pop td{border-bottom:1px solid rgba(230,239,243,.08)}
#mds-bm-pop .mds-icon{width:1.2em;height:1.2em;vertical-align:-.25em;margin-right:4px}
#mds-bm tr.mds-flash td{background:rgba(69,200,216,.18)}
/* Keys in the battle window's bottom frame: the game's small item tile, Toolasha's time line under it. */
#mds-bkeys{flex:0 0 auto;width:max-content;font-size:var(--font-size-base);line-height:1.3;font-weight:500;text-align:center}
#mds-tip{position:fixed;z-index:100000;pointer-events:none;max-width:420px;padding:6px 9px;background:#101b24;color:#e6eff3;border-radius:6px;box-shadow:0 0 0 1px #3f424d,0 6px 18px rgba(0,0,0,.45);font:400 12px/1.5 "Inter",system-ui,sans-serif;white-space:pre;text-align:left;font-variant-numeric:tabular-nums}
#mds-tip[hidden]{display:none}
.mds-keywarn{font-size:12px;font-weight:400;white-space:nowrap;cursor:default}
#mds-bkeys .mds-keywarn{margin-left:8px}
#mds-bkeys .mds-bk-only .mds-keywarn{margin-left:0}
#mds-bkeys .mds-bk-grid{padding-top:var(--spacing-xs);display:flex;gap:var(--spacing-xs);justify-content:center}
#mds-bkeys .mds-bk-tile{position:relative;width:var(--item-size-small);height:var(--item-size-small);border-radius:var(--radius-sm);background-color:var(--color-midnight-500);color:var(--color-text-dark-mode);overflow:hidden}
#mds-bkeys .mds-bk-tile svg{position:absolute;left:15%;top:15%;width:70%;height:70%}
#mds-bkeys .mds-bk-tile span{position:absolute;right:2px;bottom:-1px;font-size:var(--font-size-sm);line-height:var(--line-height-normal);font-weight:var(--font-weight-medium);text-shadow:-1px 0 var(--color-background-game),0 1px var(--color-background-game),1px 0 var(--color-background-game),0 -1px var(--color-background-game)}
#mds-bkeys .mds-bk-time{font-size:10px;line-height:1.3;font-weight:400;text-align:center}
/* The players | monsters divider as a drag handle: 10 px wide on the line, a faint bar on hover. */
#mds-split{position:absolute;top:0;bottom:0;width:10px;cursor:col-resize;z-index:3;touch-action:none}
#mds-split::after{content:"";position:absolute;top:0;bottom:0;left:4px;width:2px;border-radius:1px;background:transparent;transition:background .15s}
#mds-split:hover::after,#mds-split.dragging::after{background:#45c8d8}
#mds-bm .mds-icon{width:1.2em;height:1.2em;vertical-align:-.25em;margin-right:4px}
#mds-bm p{margin:4px 0;color:#c5d4de}
#mds-tab{white-space:nowrap}
`;

    const panel = (() => {
        let root = null, toggle = null, dirty = false, timer = null, filter = "all", open = false, tab = "overview", rowsHeld = false, runsHeld = false;
        const els = {};
        let derived = null, derivedAt = 0, derivedRev = -1, bannerDismissed = false;
        const KINDS = ["all", "start", "clear", "fail", "stop", "damage", "craft", "buy", "sell", "open", "consume", "redeem", "chat", "offline", "baseline", "review"];
        const TABS = [["overview", "Overview"], ["runs", "Runs"], ["damage", "Damage"], ["party", "Consumables"], ["keys", "Keys"], ["loot", "Loot"], ["chests", "Chests"], ["lifetime", "Lifetime"], ["xp", "XP"], ["data", "Data"], ["settings", "Settings"]];
        // Text size: every size in the panel is in em of the root, so one font-size scales it all. Saved per browser.
        const SCALE_KEY = PANEL_KEY + "-scale", BASE_PX = 14;
        let scale = 1;
        try { const v = Number(localStorage.getItem(SCALE_KEY)); if (v >= 0.7 && v <= 1.8) scale = v; } catch (_e) { /* fine */ }
        function applyScale() { if (!root) return; root.style.fontSize = `${Math.round(BASE_PX * scale * 10) / 10}px`; const el = root.querySelector("#mds-fs-val"); if (el) el.textContent = `${Math.round(scale * 100)}%`; }
        // Column switches, every table: a checkbox per column, grouped by tab in Settings. Keyed by the table (its
        // tbody id) and the column's original index; everything on by default except the Runs table's Seen-by.
        const COLS_KEY = PANEL_KEY + "-cols2";
        const TABLE_TITLES = { partycons: "Party consumables", runs: "Runs", sessions: "Sessions in the game's Loot & XP Log", keys: "Keys", mats: "Materials", loot: "Loot to sell", tokens: "Dungeon tokens", supplies: "Supplies kept for future runs", missing: "Loot no longer held", chests: "Openings", "life-dungeons": "Dungeons", "life-keys": "Key crafts", "xp-skills": "Skills", "xp-days": "Days", "xp-abilities": "Abilities", "life-skills": "Combat skills", "dmg-sessions": "Damage sessions", review: "Review", tbody: "Capture log", plan: "Key crafting" };
        const DEFAULT_OFF = { runs: ["Seen by"] };
        let colVis = {};
        try { colVis = JSON.parse(localStorage.getItem(COLS_KEY) || "{}") || {}; } catch (_e) { colVis = {}; }
        const colVisible = (key, oi, label) => { const v = colVis[key] && colVis[key][oi]; if (typeof v === "boolean") return v; return !((DEFAULT_OFF[key] || []).includes(label)); };
        function applyCols() {
            if (!root) return;
            const rules = [];
            for (const t of root.querySelectorAll("table[data-key]")) { const key = t.dataset.key; const head = t.tHead && t.tHead.rows[0]; if (!head) continue; for (const th of head.children) { const oi = Number(th.dataset.oi); if (!colVisible(key, oi, th.textContent.trim())) rules.push(`#mds-root table[data-key="${key}"] th[data-oi="${oi}"],#mds-root table[data-key="${key}"] td[data-oi="${oi}"]{display:none}`); } }
            root.querySelector("#mds-cols-style").textContent = rules.join("");
            for (const inp of root.querySelectorAll("#mds-settings-tables input[data-key]")) { const th = root.querySelector(`table[data-key="${inp.dataset.key}"] th[data-oi="${inp.dataset.oi}"]`); inp.checked = colVisible(inp.dataset.key, Number(inp.dataset.oi), th ? th.textContent.trim() : ""); }
        }
        function setColVis(key, oi, v) { (colVis[key] = colVis[key] || {})[oi] = !!v; try { localStorage.setItem(COLS_KEY, JSON.stringify(colVis)); } catch (_e) { /* fine */ } applyCols(); if (tab === "runs") renderRuns(true); }
        // Settings: one section per tab, one block per table, built from the headers themselves.
        function buildColumnSettings() {
            const host = root.querySelector("#mds-settings-tables"); const groups = [];
            for (const [paneKey, paneLabel] of TABS) {
                const pane = root.querySelector(`.mds-pane[data-pane="${paneKey}"]`); if (!pane) continue;
                const tables = [...pane.querySelectorAll("table[data-key]")]; if (!tables.length) continue;
                groups.push(`<h4>${esc(paneLabel)} tab</h4>` + tables.map(t => { const key = t.dataset.key; const ths = [...t.tHead.rows[0].children]; return `<div class="mds-set"><span class="mds-set-title">${esc(TABLE_TITLES[key] || key)}</span><div class="mds-bar">${ths.map(th => `<label><input type="checkbox" data-key="${esc(key)}" data-oi="${th.dataset.oi}"> ${esc(th.textContent.trim() || "(blank)")}</label>`).join("")}</div></div>`; }).join(""));
            }
            host.innerHTML = groups.join("");
            host.addEventListener("change", e => { const inp = e.target.closest("input[data-key]"); if (inp) setColVis(inp.dataset.key, Number(inp.dataset.oi), inp.checked); });
        }
        // Column order, every table: drag a header onto another to move it. Each table (keyed by its tbody id) keeps its
        // own order per browser. Cells carry their original index (data-oi) so an order and the Runs column switches
        // survive re-renders and reorders alike.
        const ORDER_KEY = PANEL_KEY + "-order";
        let orders = {};
        try { orders = JSON.parse(localStorage.getItem(ORDER_KEY) || "{}") || {}; } catch (_e) { orders = {}; }
        const tableKey = t => (t.tBodies[0] && t.tBodies[0].id ? t.tBodies[0].id.replace(/^mds-/, "") : null);
        const tagCells = tr => { let i = 0; for (const c of tr.children) { if (!c.dataset.oi) c.dataset.oi = String(i); i++; } };
        function fullOrder(key, n) { const o = (orders[key] || []).filter(i => Number.isInteger(i) && i >= 0 && i < n); return [...o, ...[...Array(n).keys()].filter(i => !o.includes(i))]; }
        function applyOrder(table) {
            const key = tableKey(table); const head = table.tHead && table.tHead.rows[0]; if (!key || !head) return;
            tagCells(head); const n = head.children.length; const full = fullOrder(key, n);
            const place = tr => {
                tagCells(tr); if (tr.children.length !== n) return;
                const cur = [...tr.children].map(c => Number(c.dataset.oi)); if (cur.every((v, i) => v === full[i])) return;
                const by = {}; for (const c of tr.children) by[c.dataset.oi] = c; for (const i of full) tr.appendChild(by[i]);
            };
            place(head); for (const tb of table.tBodies) for (const tr of tb.rows) place(tr);
        }
        function applyAllOrders() { for (const t of root.querySelectorAll("table")) { applyOrder(t); applySort(t); } }
        // Sorting, every table with a key (operator, 2026-11-23): click a header to sort by that column, again to
        // reverse, a third time for the table's own order. A column is sorted by value when most of its cells are
        // numbers (amounts like 13.30b, percentages, times, dates), else alphabetically; empty cells go last either
        // way. Rows are re-made in their own order on every refresh, so the sort is applied to the DOM after each
        // one (the same observer that keeps the column order), and only moves rows when the order is not already it.
        const SORT_KEY = PANEL_KEY + "-sort";
        let sorts = {};
        try { sorts = JSON.parse(localStorage.getItem(SORT_KEY) || "{}") || {}; } catch (_e) { sorts = {}; }
        const SORT_MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
        // What a cell sorts by: its own text without sub-lines, buttons and icons, as a number when it reads as one.
        function sortValue(td) {
            if (!td) return { n: null, s: "" };
            let text = "";
            for (const nd of td.childNodes) { if (nd.nodeType === 3) text += nd.data; else if (nd.nodeType === 1 && !/^(small|button|svg)$/i.test(nd.tagName)) text += nd.textContent; }
            text = text.replace(/\s+/g, " ").trim();
            if (!text || text === "–" || text === "?" || text === "-") return { n: null, s: "" };
            let m = /^(\d{1,2})([A-Z][a-z]{2})(\d{2})(?: (\d\d):(\d\d)(?::(\d\d))?)?/.exec(text);
            if (m && SORT_MONTHS[m[2]] != null) return { n: new Date(2000 + Number(m[3]), SORT_MONTHS[m[2]], Number(m[1]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)).getTime(), s: text };
            m = /^(\d+):(\d\d)(?::(\d\d))?(?!\d)/.exec(text);
            if (m) return { n: m[3] != null ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]), s: text };
            m = /^(\d+)h (\d+)m/.exec(text); if (m) return { n: Number(m[1]) * 3600 + Number(m[2]) * 60, s: text };
            m = /^(\d+)m (\d+)s/.exec(text); if (m) return { n: Number(m[1]) * 60 + Number(m[2]), s: text };
            m = /^([+\-−]?)\s*(\d[\d.,\s\u00a0\u202f']*\d|\d)\s*([kmb%])?(?![a-z])/i.exec(text.replace(/^[≈~]\s*/, ""));
            if (m) {
                let num = m[2].replace(/[\s\u00a0\u202f']/g, "");
                // Thousands groups (2,262,502 or 2.262.502) are separators; a single , or . before 1-2 digits is a decimal point.
                if (/^\d{1,3}([.,]\d{3})+$/.test(num)) num = num.replace(/[.,]/g, "");
                else num = num.replace(/,(?=\d{3}(\D|$))/g, "").replace(",", ".");
                const v = Number(num) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[3] || "").toLowerCase()] || 1);
                if (Number.isFinite(v)) return { n: m[1] === "-" || m[1] === "−" ? -v : v, s: text };
            }
            return { n: null, s: text.toLowerCase() };
        }
        function applySort(table) {
            const key = tableKey(table), head = table.tHead && table.tHead.rows[0], tb = table.tBodies[0]; if (!key || !head || !tb) return;
            const st = sorts[key] || null;
            for (const th of head.children) { const on = st && Number(th.dataset.oi) === st.oi; th.classList.toggle("mds-sort-asc", !!(on && st.dir === "asc")); th.classList.toggle("mds-sort-desc", !!(on && st.dir === "desc")); }
            const rows = [...tb.rows].filter(r => !(r.cells.length === 1 && r.cells[0].colSpan > 1)); if (rows.length < 2) return;
            if (rows.some(r => r.dataset.ord == null)) rows.forEach((r, i) => { r.dataset.ord = String(i); });   // fresh rows: this is the table's own order
            const ord = r => Number(r.dataset.ord);
            let want;
            if (!st) want = rows.slice().sort((a, b) => ord(a) - ord(b));
            else {
                const val = new Map(rows.map(r => [r, sortValue([...r.cells].find(c => Number(c.dataset.oi) === st.oi))]));
                const filled = [...val.values()].filter(v => v.n != null || v.s), numeric = filled.filter(v => v.n != null).length * 2 >= filled.length;
                const dir = st.dir === "asc" ? 1 : -1;
                want = rows.slice().sort((a, b) => {
                    const x = val.get(a), y = val.get(b);
                    const xe = numeric ? x.n == null : !x.s, ye = numeric ? y.n == null : !y.s;
                    if (xe !== ye) return xe ? 1 : -1;            // empty cells last, whichever way
                    const c = xe ? 0 : numeric ? x.n - y.n : x.s.localeCompare(y.s, undefined, { numeric: true });
                    return c ? c * dir : ord(a) - ord(b);
                });
                st.numeric = numeric;
            }
            if (want.some((r, i) => rows[i] !== r)) for (const r of want) tb.appendChild(r);
        }
        function cycleSort(table, th) {
            const key = tableKey(table); if (!key) return;
            const oi = Number(th.dataset.oi), cur = sorts[key];
            if (!cur || cur.oi !== oi) {
                // First click: numbers highest first, text A to Z.
                const tb = table.tBodies[0]; const vals = tb ? [...tb.rows].map(r => sortValue([...r.cells].find(c => Number(c.dataset.oi) === oi))).filter(v => v.n != null || v.s) : [];
                const numeric = vals.filter(v => v.n != null).length * 2 >= vals.length && vals.length > 0;
                sorts[key] = { oi, dir: numeric ? "desc" : "asc", first: numeric ? "desc" : "asc" };
            } else if (cur.dir === cur.first || cur.first == null && cur.dir === "desc") sorts[key] = { ...cur, first: cur.first || "desc", dir: cur.dir === "asc" ? "desc" : "asc" };
            else delete sorts[key];
            try { localStorage.setItem(SORT_KEY, JSON.stringify(sorts)); } catch (_e) { /* fine */ }
            applySort(table);
        }
        function setOrder(key, order) { orders[key] = order; try { localStorage.setItem(ORDER_KEY, JSON.stringify(orders)); } catch (_e) { /* fine */ } applyAllOrders(); }
        let drag = null;
        function wireColumnDrag() {
            // The tabs can be dragged into any order (operator, 2026-11-23); kept per browser. A tab added by a later
            // version goes where the default order has it relative to the end.
            {
                const bar = root.querySelector(".mds-tabs"), TAB_ORDER_KEY = PANEL_KEY + "-taborder";
                try { const saved = JSON.parse(localStorage.getItem(TAB_ORDER_KEY) || "null"); if (Array.isArray(saved)) for (const k of saved) { const b = bar.querySelector(`button[data-tab="${String(k).replace(/[^a-z-]/g, "")}"]`); if (b) bar.appendChild(b); } for (const b of [...bar.children]) if (Array.isArray(saved) && !saved.includes(b.dataset.tab)) bar.appendChild(b); } catch (_e) { /* default order */ }
                let dragTab = null;
                bar.addEventListener("dragstart", e => { const b = e.target.closest("button[data-tab]"); if (!b) return; dragTab = b; e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", b.dataset.tab); } catch (_e) { /* fine */ } });
                bar.addEventListener("dragover", e => { if (!dragTab) return; const b = e.target.closest("button[data-tab]"); if (!b || b === dragTab) return; e.preventDefault(); for (const x of bar.querySelectorAll(".mds-drop")) x.classList.remove("mds-drop"); b.classList.add("mds-drop"); });
                bar.addEventListener("drop", e => { if (!dragTab) return; const b = e.target.closest("button[data-tab]"); if (!b || b === dragTab) return; e.preventDefault(); const r = b.getBoundingClientRect(); if (e.clientX > r.left + r.width / 2) b.after(dragTab); else b.before(dragTab); try { localStorage.setItem(TAB_ORDER_KEY, JSON.stringify([...bar.children].map(x => x.dataset.tab))); } catch (_e) { /* fine */ } });
                bar.addEventListener("dragend", () => { dragTab = null; for (const x of bar.querySelectorAll(".mds-drop")) x.classList.remove("mds-drop"); });
            }
            root.addEventListener("click", e => { if (e.ctrlKey || e.metaKey) return; const th = e.target.closest("thead th"); const table = th && th.closest("table"); if (th && table && tableKey(table)) cycleSort(table, th); });
            root.addEventListener("dragstart", e => { const th = e.target.closest("th"); const table = th && th.closest("table"); if (!th || !table || !tableKey(table)) return; drag = { key: tableKey(table), oi: Number(th.dataset.oi) }; th.classList.add("mds-dragging"); try { e.dataTransfer.setData("text/plain", th.textContent); e.dataTransfer.effectAllowed = "move"; } catch (_e) { /* fine */ } });
            root.addEventListener("dragend", e => { const th = e.target.closest("th"); if (th) th.classList.remove("mds-dragging"); for (const x of root.querySelectorAll("th.mds-drop")) x.classList.remove("mds-drop"); drag = null; });
            root.addEventListener("dragover", e => { const th = e.target.closest("th"); const table = th && th.closest("table"); if (!drag || !th || !table || tableKey(table) !== drag.key) return; e.preventDefault(); for (const x of table.querySelectorAll("th.mds-drop")) x.classList.remove("mds-drop"); if (Number(th.dataset.oi) !== drag.oi) th.classList.add("mds-drop"); });
            root.addEventListener("drop", e => {
                const th = e.target.closest("th"); const table = th && th.closest("table"); if (!drag || !th || !table || tableKey(table) !== drag.key) return;
                e.preventDefault();
                const n = table.tHead.rows[0].children.length; const full = fullOrder(drag.key, n).filter(i => i !== drag.oi);
                const at = full.indexOf(Number(th.dataset.oi)); const rect = th.getBoundingClientRect(); const after = e.clientX > rect.left + rect.width / 2;
                full.splice(at < 0 ? full.length : at + (after ? 1 : 0), 0, drag.oi);
                setOrder(drag.key, full);
            });
            for (const th of root.querySelectorAll("th")) th.draggable = true;
            // Re-rendered rows come back in original order; put them back in the chosen order. Idempotent, so the
            // observer's own mutations settle after one pass.
            new MutationObserver(muts => { const tables = new Set(); for (const m of muts) { const t = m.target && m.target.closest ? m.target.closest("table") : null; if (t) tables.add(t); } for (const t of tables) { applyOrder(t); applySort(t); } }).observe(root, { childList: true, subtree: true });
            applyAllOrders();
        }
        // Folds: every section header becomes a details/summary in the site's convention (chevron, no native marker, a
        // muted count at the right). Open by default; each fold's state is saved per browser.
        const FOLDS_KEY = PANEL_KEY + "-folds";
        let folds = {};
        try { folds = JSON.parse(localStorage.getItem(FOLDS_KEY) || "{}") || {}; } catch (_e) { folds = {}; }
        function foldify(scope) {
            for (const h of [...scope.querySelectorAll("h4")]) {
                if (h.closest("details.mds-fold")) continue;
                const parent = h.parentElement; const pane = h.closest(".mds-pane"); const key = `${pane ? pane.dataset.pane : "x"}:${cardKey(h.textContent)}`;
                const d = document.createElement("details"); d.className = "mds-fold"; d.dataset.fold = key; if (h.dataset.noun) d.dataset.noun = h.dataset.noun; d.open = folds[key] !== false;
                const sum = document.createElement("summary"); sum.innerHTML = `<span class="mds-fold-title">${h.innerHTML}</span><span class="mds-fold-sum"></span>`;
                const body = document.createElement("div"); body.className = "mds-fold-body";
                d.append(sum, body); parent.insertBefore(d, h); h.remove();
                // The section runs to the next header, or to a container that holds sections of its own.
                let n = d.nextSibling; while (n && !(n.nodeType === 1 && (n.tagName === "H4" || n.hasAttribute("data-sections")))) { const next = n.nextSibling; body.appendChild(n); n = next; }
                d.addEventListener("toggle", () => { folds[key] = d.open; try { localStorage.setItem(FOLDS_KEY, JSON.stringify(folds)); } catch (_e) { /* fine */ } });
            }
        }
        // The count in each fold's header: real table rows, or cards, or tiles.
        function foldSummaries() {
            for (const d of root.querySelectorAll("details.mds-fold")) {
                const el = d.querySelector(".mds-fold-sum"); if (!el) continue;
                const body = d.querySelector(".mds-fold-body"); let n = null;
                const tb = body.querySelector("tbody"); if (tb) n = [...tb.rows].filter(r => !(r.cells.length === 1 && r.cells[0].colSpan > 1)).length;
                else if (body.querySelector(".mds-card")) n = body.querySelectorAll(".mds-card").length;
                else if (body.querySelector(".mds-tile")) n = body.querySelectorAll(".mds-tile").length;
                el.textContent = n != null && d.dataset.noun ? `${n.toLocaleString()} ${n === 1 ? d.dataset.noun.replace(/ies$/, "y").replace(/s$/, "") : d.dataset.noun}` : "";
            }
        }
        function setScale(v) { scale = Math.max(0.7, Math.min(1.8, Math.round(v * 20) / 20)); try { localStorage.setItem(SCALE_KEY, String(scale)); } catch (_e) { /* fine */ } applyScale(); }
        let money = null, moneyAt = 0, moneyRev = -1, moneyPrices = 0;
        const isToken = h => /_token$/.test(h);
        // The game's count over the record (logTotals), re-read when the log or the record changes.
        let gameT = null, gameKey = "";
        function gameTotals() {
            const d = getDerived(), key = `${state.lootLogRev}|${state.timelineRev}|${d.summary.windowEnd}`;
            if (!gameT || gameKey !== key) {
                gameT = logTotals([...state.lootLog.values()], d, { isDungeon: a => !!ref.dungeons[a], isKeyCraft: a => !!ref.keyActions[a],
                    isChest: h => !!(ref.chestItems[h] && ref.chestItems[h].zone), isKey: h => ref.keyItems.has(h), crafts: state.timeline.filter(e => e.kind === "craft") });
                gameKey = key;
            }
            return gameT;
        }
        // Entry keys the game charged, by key item: one for every chest a clear awards. A dungeon's reward chests come
        // together (a chest and, on the tiers that have one, a refinement chest), so the most numerous of them is the
        // number of awards.
        function logEntryKeys() {
            const T = gameTotals(); if (!T.read) return null;
            const out = {};
            for (const dgn of Object.values(ref.dungeons)) { if (!dgn.keyItem) continue; const q = Math.max(0, ...dgn.chests.map(c => T.total.chests[c] || 0)); if (q > 0) out[dgn.keyItem] = (out[dgn.keyItem] || 0) + q; }
            return out;
        }
        const moneyCtx = () => ({
            logKeys: logEntryKeys, logCrafted: () => { const T = gameTotals(); return T.read ? T.total.crafted : null; },
            recordStart: state.meta.recordStart || 0, reviewPct: 0.5,
            isCounted, isKey: h => ref.keyItems.has(h), isChest: h => !!ref.chestItems[h], isDungeonChest: h => !!(ref.chestItems[h] && ref.chestItems[h].zone), isDungeonLoot: h => ref.dungeonLoot.has(h), isConsumable, isToken, tokenShop: h => ref.tokenShop[h] || [], isEntryKey: h => Object.values(ref.dungeons).some(d => d.keyItem === h),
            isOpenable: h => !!(ref.items[h] && ref.items[h].openable), isTradable: h => !(ref.items[h] && ref.items[h].tradable === false),
            held: h => held(h, 0), listed: h => listedQty(h, 0), bidOf, askOf, avgOf: ledgerAvg, keyAvg: keyAverage,
            keyOf: z => (ref.dungeons[z] && ref.dungeons[z].keyItem) || null, keyRecipes: ref.keyActions, artisanOf, consumeTotals: state.consumeTotals,
            isRealKey: h => ref.realKeys.has(h),
            heldKeys: () => [...state.inventory.values()].filter(r => r.itemLocationHrid === INV && ref.realKeys.has(r.itemHrid)).map(r => r.itemHrid),
        });
        function getMoney() {
            if (!money || moneyRev !== state.timelineRev || moneyPrices !== prices.at || Date.now() - moneyAt > 5000) { money = deriveMoney(state.timeline, moneyCtx()); moneyAt = Date.now(); moneyRev = state.timelineRev; moneyPrices = prices.at; }
            return money;
        }
        const deriveCfg = () => ({ selfName: state.characterName, recordStart: state.meta.recordStart || 0, isChest: h => !!ref.chestItems[h], isKey: h => ref.keyItems.has(h), isCounted, keyOf: z => (ref.dungeons[z] && ref.dungeons[z].keyItem) || null, maxWavesOf: z => (ref.dungeons[z] && ref.dungeons[z].maxWaves) || null,
            logSessions: [...state.lootLog.values()], isDungeon: a => !!ref.dungeons[a], isKeyCraft: a => !!ref.keyActions[a] });
        function getDerived() {
            if (!derived || derivedRev !== `${state.timelineRev}|${state.lootLogRev}` || Date.now() - derivedAt > 30000) { derived = derive(state.timeline, serverNow(), deriveCfg()); derivedAt = Date.now(); derivedRev = `${state.timelineRev}|${state.lootLogRev}`; }
            return derived;
        }
        function ensure() {
            if (root || !document.body) return;
            const style = document.createElement("style"); style.textContent = CSS; document.documentElement.appendChild(style);
            // Inter, as the simulator site uses it; the panel falls back to the system face if the font does not load.
            if (!document.querySelector("link[data-mds-font]")) { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500&display=swap"; l.dataset.mdsFont = "1"; (document.head || document.documentElement).appendChild(l); }
            toggle = document.createElement("button"); toggle.id = "mds-toggle"; toggle.textContent = "Dungeon Stats"; toggle.title = "Metz Dungeon Stats"; toggle.addEventListener("click", () => setOpen(!open));
            root = document.createElement("section"); root.id = "mds-root"; root.hidden = true;
            // Built once. Refreshes touch only text and table rows, so an open dropdown, the scroll position and an
            // expanded section are never torn down.
            root.innerHTML = `<div class="mds-head"><strong>Metz Dungeon Stats</strong><span class="mds-sub">v${VERSION}</span><button class="mds-refresh-prices mds-head-btn" title="Fetch the marketplace prices again now">Refresh prices</button><span class="mds-sub mds-prices-note"></span><button class="mds-x" title="Close">×</button></div>
<div class="mds-tabs">${TABS.map(([k, label]) => `<button role="tab" draggable="true" data-tab="${k}" aria-selected="${k === tab}">${label}</button>`).join("")}</div>
<div class="mds-body">
<p class="mds-status" id="mds-status"></p>
<div class="mds-banner" id="mds-banner" hidden><span>Open the game's Loot &amp; XP Log once this session (Combat → Loot &amp; XP Log) so the record can check its clears and chests against the game's own count.</span><button class="mds-x" title="Dismiss for this session">×</button></div>
<div class="mds-pane" data-pane="overview">
 <h4>Summary</h4>
 <div class="mds-cards" id="mds-cards"></div>
 <p class="mds-note" id="mds-ovnote"></p>
 <h4 data-noun="items">Consumables</h4>
 <div class="mds-tiles" id="mds-consumables"></div>
</div>
<div class="mds-pane" data-pane="runs" hidden>
 <h4 data-noun="runs">Runs</h4>
 <div class="mds-wrap mds-wrap-runs"><table><thead><tr><th>Start</th><th>Result</th><th>Dungeon</th><th>Run time</th><th>Waves</th><th>Chests</th><th>Keys</th><th>Deaths</th><th>XP</th><th>Seen by</th></tr></thead><tbody id="mds-runs"></tbody></table></div>
 <p class="mds-note" id="mds-runsnote"></p>
 <h4 data-noun="sessions">Sessions in the game's Loot &amp; XP Log</h4>
 <div class="mds-wrap"><table><thead><tr><th>Start</th><th>End</th><th>Action</th><th>Game: count</th><th>Game: drops</th><th>Game: XP</th><th>This record</th><th>Seen by</th></tr></thead><tbody id="mds-sessions"></tbody></table></div>
 <p class="mds-note" id="mds-sessionsnote"></p>
</div>
<div class="mds-pane" data-pane="party" hidden>
 <h4>Party consumables</h4>
 <table data-key="partycons"><thead><tr><th>Player</th><th>Entry keys</th><th>Food 1</th><th>Food 2</th><th>Food 3</th><th>Drink 1</th><th>Drink 2</th><th>Drink 3</th></tr></thead><tbody id="mds-partycons"></tbody></table>
 <p class="mds-note">Counts as of the last wave, for everyone in the battle. Under each count: how long it lasts at the rate that player has used it since this page opened (– until 10 minutes and one use). Entry keys are from the game's party message at each run start, at the dungeon's average run time.</p>
</div>
<div class="mds-pane" data-pane="damage" hidden>
 <h4>Damage meter</h4>
 <div class="mds-bar"><label>Session <select id="mds-dmg-pick"></select></label><button id="mds-dmg-reset" class="danger" title="Delete every saved damage session and total; the rest of the record stays">Reset damage data</button></div>
 <p class="mds-dmg-head" id="mds-dmg-head"></p>
 <div id="mds-dmg-meter"></div>
 <h4 data-noun="sessions">Sessions</h4>
 <div class="mds-wrap"><table><thead><tr><th>End</th><th>Where</th><th>Result</th><th>Combat time</th><th>Waves</th><th>Party damage</th><th>Party DPS</th><th>Your damage</th><th>Your share</th><th title="Finished waves in which every monster was seen going to 0 HP and every point was credited to a player">Checked</th></tr></thead><tbody id="mds-dmg-sessions"></tbody></table></div>
 <p class="mds-note">Click a player for their abilities: damage, uses, hits, misses and healing, then where their damage taken came from and what healed them. Damage is the HP the monsters lost, read from the game's battle messages: overkill is not counted. DPS runs over time in combat: from the first wave's start to the last hit, without a break between waves. A dungeon run is listed here only when the script saw it from wave 1 to its end (a reload in the middle of a wave is stitched back in; installing an update reloads the page, so that run is cut). On a planet a session runs until the battle changes, across reloads. Runs seen only in part still count: pick that dungeon's totals in the Session list. Parry and thorns are counter-attacks; damage over time is put on the ability that applied it. Healing done counts heal abilities, Life Drain and Bloom; everything else a player regained (regeneration, food, passives) shows under Healed. Click a session below to show it.</p>
</div>
<div class="mds-pane" data-pane="keys" hidden>
 <h4>Key crafting</h4>
 <div class="mds-set">
  <div class="mds-bar"><label>Key <select id="mds-plan-key"></select></label><label>Keys wanted <input id="mds-plan-qty" type="number" min="1" max="100000" step="1" placeholder="as many as the budget buys" class="mds-num"></label><label>Budget <input id="mds-plan-budget" type="number" min="0" step="1" class="mds-num mds-num-wide" title="Coins to spend on materials and the recipe's coins; follows your bag until you type a figure"></label><button id="mds-plan-wallet" title="Follow the coins in the bag again">Use bag coins</button><label><input type="checkbox" id="mds-plan-owned" checked> Count owned materials</label></div>
  <div class="mds-bar"><button id="mds-plan-craft" title="Uses the game's own navigation">Open crafting page</button><button id="mds-plan-copy">Copy shopping list</button><button id="mds-plan-prices">Refresh prices</button></div>
  <div class="mds-wrap"><table><thead><tr><th>Material</th><th>Per key</th><th>Need</th><th>Owned</th><th>Buy</th><th>Ask</th><th>Cost</th><th></th></tr></thead><tbody id="mds-plan"></tbody></table></div>
  <p class="mds-note" id="mds-plan-sum"></p>
 </div>
 <h4 data-noun="keys">Keys in the record</h4>
 <div class="mds-wrap"><table><thead><tr><th>Key</th><th>Held</th><th>Crafted</th><th>Bought</th><th>Dropped</th><th>Used</th><th>Cost per key</th><th>Used at cost</th><th>At start</th><th>Crafted all time</th></tr></thead><tbody id="mds-keys"></tbody></table></div>
 <h4 data-noun="materials">Materials</h4>
 <div class="mds-wrap"><table><thead><tr><th>Material</th><th>Recipe</th><th>Bought</th><th>Avg price</th><th>Bought total</th><th>Used by crafts</th><th>Held</th><th>At start</th></tr></thead><tbody id="mds-mats"></tbody></table></div>
 <p class="mds-note" id="mds-keysnote"></p>
</div>
<div class="mds-pane" data-pane="loot" hidden>
 <h4 data-noun="items">Loot to sell</h4>
 <div class="mds-wrap"><table><thead><tr><th>Item</th><th>Gained</th><th>Sold</th><th>Sold net</th><th>Held</th><th title="In the bag before the record began; sellable from here, but not counted in held loot or net">Holdover</th><th>Listed</th><th>Kept</th><th>Held at bid</th><th></th></tr></thead><tbody id="mds-loot"></tbody></table></div>
 <h4 data-noun="tokens">Dungeon tokens</h4>
 <div class="mds-wrap"><table><thead><tr><th>Token</th><th>Gained</th><th>Redeemed</th><th>Received</th><th>Held</th><th title="In the bag before the record began">Holdover</th><th title="The best coins per token any shop item costing only this token sells for at bid, net of tax (the site's rule)">Per token</th><th title="Held × per token; the holdover's worth beneath it, not counted">Held value</th><th></th></tr></thead><tbody id="mds-tokens"></tbody></table></div>
 <h4 data-noun="items">Supplies kept for future runs</h4>
 <div class="mds-wrap"><table><thead><tr><th>Item</th><th>Kind</th><th>Held</th><th>Ledger cost</th><th>Held at cost</th><th>Used in the record</th></tr></thead><tbody id="mds-supplies"></tbody></table></div>
 <h4 data-noun="items">Loot no longer held</h4>
 <div class="mds-wrap"><table><thead><tr><th>Item</th><th>Missing</th><th>Bid at open</th><th>Bid now</th><th>Value (net of tax)</th><th>Status</th><th></th></tr></thead><tbody id="mds-missing"></tbody></table></div>
 <p class="mds-note" id="mds-lootnote"></p>
</div>
<div class="mds-pane" data-pane="chests" hidden>
 <h4>Chests</h4>
 <div class="mds-cards" id="mds-chestcards"></div>
 <h4 data-noun="openings">Openings</h4>
 <div class="mds-wrap mds-wrap-chests"><table><thead><tr><th>Time</th><th>Chest</th><th>#</th><th>Contents</th><th>Value at bid</th><th>Coins</th><th>Key cost</th></tr></thead><tbody id="mds-chests"></tbody></table></div>
 <p class="mds-note" id="mds-chestsnote"></p>
</div>
<div class="mds-pane" data-pane="lifetime" hidden>
 <h4 data-noun="dungeons">Dungeons, from the game's Loot &amp; XP Log</h4>
 <div class="mds-wrap"><table><thead><tr><th>Dungeon</th><th>Sessions</th><th>Clears</th><th>Chests</th><th>Time in sessions</th><th>Per clear</th><th>XP</th><th>XP / h</th><th>From</th><th>To</th></tr></thead><tbody id="mds-life-dungeons"></tbody></table></div>
 <h4 data-noun="keys">Key crafts, from the game's Loot &amp; XP Log</h4>
 <div class="mds-wrap"><table><thead><tr><th>Key</th><th>Sessions</th><th>Crafted</th><th>Essence</th><th>First</th><th>Last</th><th>Materials bought on this PC</th><th>Cost per key</th></tr></thead><tbody id="mds-life-keys"></tbody></table></div>
 <h4 data-noun="skills">Combat skills, from the game's Loot &amp; XP Log</h4>
 <div class="mds-wrap"><table><thead><tr><th title="Each session counts for the combat skill it trained: the one with the most XP in it">Skill</th><th>Sessions</th><th>Time in sessions</th><th>XP</th><th>XP / h</th><th title="The dungeon and tier where this skill's rate was highest, over at least an hour of sessions training it">Best rate</th><th>From</th><th>To</th></tr></thead><tbody id="mds-life-skills"></tbody></table></div>
 <p class="mds-note" id="mds-lifenote"></p>
</div>
<div class="mds-pane" data-pane="xp" hidden>
 <h4>Since the record began</h4>
 <div class="mds-cards" id="mds-xpcards"></div>
 <h4 data-noun="skills">Skills</h4>
 <div class="mds-wrap"><table><thead><tr><th>Skill</th><th>Since record</th><th>Today</th><th>XP / h</th><th>Share</th></tr></thead><tbody id="mds-xp-skills"></tbody></table></div>
 <h4 data-noun="days">Days</h4>
 <div class="mds-wrap"><table><thead><tr><th>Day</th><th>XP</th><th>Active time</th><th>XP / h</th><th>Skills</th></tr></thead><tbody id="mds-xp-days"></tbody></table></div>
 <h4 data-noun="abilities">Abilities</h4>
 <div class="mds-wrap"><table><thead><tr><th>Ability</th><th>Level</th><th>Since record</th><th>XP / h</th><th>Share</th><th title="Books the next level takes, at the game's XP per book">Books to next</th><th title="Those books at the marketplace ask">Price to next</th></tr></thead><tbody id="mds-xp-abilities"></tbody></table></div>
 <p class="mds-note">XP since the record began is the game's lifetime total now less the total when the record started, so it is exact whether or not the script was running, offline play included. XP per hour runs over active time: the time between XP messages when the gap is 15 minutes or less, plus offline time that earned XP. Days are on your own clock.</p>
</div>
<div class="mds-pane" data-pane="settings" hidden>
 <h4>General</h4>
 <div class="mds-set"><span class="mds-set-title">Text size</span>
  <div class="mds-bar"><button id="mds-fs-down" title="Smaller">A −</button><span id="mds-fs-val" class="mds-note"></span><button id="mds-fs-up" title="Larger">A +</button><button id="mds-fs-reset">Reset</button><span class="mds-note">Scales every size in the panel, 70% to 180% in steps of 5%.</span></div>
 </div>
 <div class="mds-set"><span class="mds-set-title">Damage meter</span>
  <div class="mds-bar"><label><input type="checkbox" id="mds-meter-on"> Record damage</label><span class="mds-note">Off: battle messages are not read at all, nothing is recorded, and the meter and the Damage tab are hidden. For slow PCs. Sessions already saved are kept.</span></div>
  <div class="mds-bar"><label><input type="checkbox" id="mds-bm-on"> Show the meter under the battle cards (Combat → Battle)</label><span class="mds-note">The Damage tab keeps every session either way.</span></div>
  <div class="mds-bar" id="mds-metercols"><span class="mds-set-title">Meter columns</span></div>
  <div class="mds-bar"><label>Key and consumable times: amber under <input type="number" id="mds-key-amber" min="0" step="1" style="width:5em"> hours</label><label>red under <input type="number" id="mds-key-red" min="0" step="1" style="width:5em"> hours</label><span class="mds-note">Colours of the key and consumable times and warnings in the battle window.</span></div>
 </div>
 <div class="mds-set"><span class="mds-set-title">Column and card order</span>
  <div class="mds-bar"><button id="mds-order-reset">Reset column order</button><button id="mds-cards-reset">Reset card order</button><span class="mds-note">Drag a tab onto another to move it.</span><span class="mds-note">Drag a column header onto another, or a card onto another, to move it. Every table and the card grids remember their own order.</span><span class="mds-note">Click a column header to sort by it; click again to reverse, a third time for the table's own order.</span></div>
 </div>
 <p class="mds-note">Everything here is saved in this browser only. Below, untick a column to hide it in that table; the Runs table's Seen by (sources and notes) is off by default, and a run with a note then shows a small flag next to its result.</p>
 <div id="mds-settings-tables" data-sections></div>
</div>
<style id="mds-cols-style"></style>
<div class="mds-pane" data-pane="data" hidden>
<h4 data-noun="items">Review</h4>
<div class="mds-wrap"><table><thead><tr><th>Time</th><th>What the script could not settle</th><th>Details</th><th></th></tr></thead><tbody id="mds-review"></tbody></table></div>
<h4 data-noun="events">Capture log</h4>
<div class="mds-bar">
 <label>Show <select id="mds-filter">${KINDS.map(k => `<option value="${k}">${k}</option>`).join("")}</select></label>
 <button id="mds-export">Export record (JSON)</button>
 <button id="mds-export-frames">Export raw frames</button>
 <button id="mds-prices">Refresh prices</button>
 <button id="mds-history-file" title="Merge a market history file from another PC: Toolasha's listing array (JSON) or its Market History CSV">Merge market history file…</button><input type="file" id="mds-history-input" accept=".json,.csv,application/json,text/csv" hidden>
 <button id="mds-toolasha" title="Re-price stock held at record start from your own purchases and catch up fills the script did not see">Import Toolasha history</button>
 <button id="mds-record-file" title="Merge this character's record exported on another PC: events by id, replayed chat and listing fills matched so nothing counts twice">Import record file…</button><input type="file" id="mds-record-input" accept=".json,application/json" hidden>
 <button id="mds-reset" class="danger">Reset record</button>
 <span class="mds-note">Newest first. Source = the game message the event came from. Consumable uses are recorded but shown only under "consume".</span>
</div>
<div class="mds-wrap"><table><thead><tr><th>Time</th><th>Kind</th><th>What</th><th>Source</th></tr></thead><tbody id="mds-tbody"></tbody></table></div>
<details><summary>Diagnostics</summary><pre id="mds-diag"></pre></details>
</div>
</div>`;
            for (const id of ["mds-status", "mds-cards", "mds-ovnote", "mds-runs", "mds-runsnote", "mds-sessions", "mds-sessionsnote", "mds-tbody", "mds-diag", "mds-filter", "mds-keys", "mds-mats", "mds-keysnote", "mds-consumables", "mds-plan", "mds-plan-key", "mds-plan-qty", "mds-plan-budget", "mds-plan-owned", "mds-plan-sum", "mds-xpcards", "mds-xp-skills", "mds-xp-days", "mds-xp-abilities", "mds-life-skills", "mds-review", "mds-loot", "mds-tokens", "mds-supplies", "mds-missing", "mds-lootnote", "mds-chestcards", "mds-chests", "mds-chestsnote", "mds-life-dungeons", "mds-life-keys", "mds-lifenote", "mds-dmg-pick", "mds-dmg-head", "mds-dmg-meter", "mds-dmg-sessions", "mds-partycons"]) els[id] = root.querySelector("#" + id);
            // Row actions: Keep N (moves loot into supplies), Accept (freezes a valuation of loot no longer held).
            root.addEventListener("click", e => {
                const b = e.target.closest("button[data-act]"); if (!b) return;
                const item = b.dataset.item;
                if (b.dataset.act === "keep") {
                    const cur = Number(b.dataset.kept) || 0;
                    const v = W.prompt(t("Keep how many {item} for future runs? (now {n}; 0 clears it)", { item: itemName(item), n: cur }), String(cur || held(item, 0)));
                    if (v == null) return; const q = Math.max(0, Math.floor(Number(v))); if (!isFinite(q)) return;
                    emit("keep", { item, qty: q - cur, total: q }, "panel");
                } else if (b.dataset.act === "accept") {
                    const qty = Number(b.dataset.qty), unitValue = Number(b.dataset.unit);
                    if (!(qty > 0) || !(unitValue >= 0)) return;
                    emit("value", { item, qty, unitValue, bidNow: Number(b.dataset.bid) || null, bidAtOpen: Number(b.dataset.open) || null, taxRate: Number(b.dataset.tax) || null }, "panel");
                }
                render();
            });
            els.wrap = root.querySelector(".mds-pane[data-pane=data] .mds-wrap"); els.runsWrap = root.querySelector(".mds-wrap-runs");
            root.querySelector(".mds-head .mds-x").addEventListener("click", () => setOpen(false));
            root.querySelector("#mds-banner .mds-x").addEventListener("click", () => { bannerDismissed = true; render(); });
            root.querySelector(".mds-tabs").addEventListener("click", e => { const b = e.target.closest("button[data-tab]"); if (b) setTab(b.dataset.tab); });
            els["mds-filter"].addEventListener("change", e => { filter = e.target.value; els.wrap.scrollTop = 0; renderRows(true); });
            root.querySelector("#mds-export").addEventListener("click", exportRecord);
            root.querySelector("#mds-export-frames").addEventListener("click", exportFrames);
            root.querySelector("#mds-prices").addEventListener("click", () => fetchPrices(true).then(() => render()));
            for (const b of root.querySelectorAll("button.mds-refresh-prices")) b.addEventListener("click", () => { for (const x of root.querySelectorAll("button.mds-refresh-prices")) x.disabled = true; fetchPrices(true).then(() => render(), () => render()).then(() => { for (const x of root.querySelectorAll("button.mds-refresh-prices")) x.disabled = false; }); });
            root.querySelector("#mds-reset").addEventListener("click", resetRecord);
            root.querySelector("#mds-dmg-reset").addEventListener("click", () => resetDamage().then(() => { dmgPick = "live"; dmgHtml = ""; dmgSessKey = ""; renderDamage(); }));
            root.querySelector("#mds-toolasha").addEventListener("click", () => importToolasha("manual").then(() => render()));
            root.querySelector("#mds-history-file").addEventListener("click", () => root.querySelector("#mds-history-input").click());
            root.querySelector("#mds-record-file").addEventListener("click", () => root.querySelector("#mds-record-input").click());
            // Ctrl+click (Cmd on a Mac) on any table row: the row as one line in the game's chat input, from the visible
            // column headers and values in the order shown. Nothing is sent; the player sends it.
            root.addEventListener("click", e => {
                if (!(e.ctrlKey || e.metaKey) || e.target.closest("button, a, input, select, th")) return;
                const tr = e.target.closest("tbody tr"); if (!tr || !root.contains(tr)) return;
                const line = rowChatLine(tr); if (!line) return;
                e.preventDefault(); toChatInput(line, tr);
            });
            chatOut = toChatInput;
            function toChatInput(line, flashEl) {
                const input = [...document.querySelectorAll('input[class*="Chat_chatInput"], [class*="Chat_chatInputContainer"] input[type="text"]')].find(el => !root.contains(el) && el.offsetParent !== null) || null;
                if (input) {
                    const setter = Object.getOwnPropertyDescriptor(W.HTMLInputElement.prototype, "value").set;
                    const prev = input.value; const next = prev && !/\s$/.test(prev) ? `${prev} ${line}` : `${prev}${line}`;
                    setter.call(input, next); input.dispatchEvent(new Event("input", { bubbles: true })); input.focus();
                } else { try { navigator.clipboard.writeText(line); } catch (_e) { /* fine */ } warn("chat input not found; row copied to the clipboard instead:", line); }
                if (flashEl) { flashEl.classList.add("mds-flash"); setTimeout(() => flashEl.classList.remove("mds-flash"), 400); }
            }
            // Ctrl+click on a card: its label, value and sub-lines as one line.
            root.addEventListener("click", e => {
                if (!(e.ctrlKey || e.metaKey) || e.target.closest("button, a, input, select")) return;
                const cardEl = e.target.closest(".mds-card"); if (!cardEl || !root.contains(cardEl)) return;
                const label = (cardEl.querySelector(".l") || {}).textContent || "", value = (cardEl.querySelector(".n") || {}).innerText || "";
                const subs = [...cardEl.querySelectorAll("small")].flatMap(el => el.innerText.split(/\n+/)).map(t => t.trim()).filter(Boolean);
                const line = [`${label.trim()} ${value.trim()}`.trim(), ...subs].join(" · "); if (!line) return;
                e.preventDefault(); toChatInput(line, cardEl);
            });
            root.querySelector("#mds-record-input").addEventListener("change", e => { const f = e.target.files && e.target.files[0]; e.target.value = ""; if (f) importRecordFile(f).then(r => { if (r) W.alert(`Imported ${f.name}: ${r.added} events added, ${r.duplicate} already here, ${r.skipped} record-specific skipped, ${r.conflict} conflicts kept as ours.`); render(); }, err => { warn("record import failed", err); W.alert("Record import failed: " + (err && err.message || err)); }); });
            els["mds-review"].addEventListener("click", e => { const b = e.target.closest("button[data-dismiss]"); if (!b) return; const done = Array.isArray(state.meta.reviewDone) ? state.meta.reviewDone : []; if (!done.includes(b.dataset.dismiss)) done.push(b.dataset.dismiss); state.meta.reviewDone = done; state.record && state.record.queue("meta", { key: "reviewDone", value: done }); render(); });
            els["mds-plan-key"].addEventListener("change", e => { plan.key = e.target.value; savePlan(); renderPlan(); });
            els["mds-plan-qty"].addEventListener("input", e => { const v = Math.floor(Number(e.target.value)); plan.qty = e.target.value.trim() === "" || !(v > 0) ? null : Math.min(100000, v); savePlan(); renderPlan(); });
            els["mds-plan-budget"].addEventListener("input", e => { const v = Math.floor(Number(e.target.value)); plan.budget = e.target.value.trim() === "" || !(v >= 0) ? null : v; savePlan(); renderPlan(); });
            root.querySelector("#mds-plan-wallet").addEventListener("click", () => { plan.budget = null; savePlan(); renderPlan(); });
            // Damage tab: the session picker, a player row opens its abilities, a session row shows that session.
            els["mds-dmg-pick"].addEventListener("change", e => { dmgPick = e.target.value; dmgHtml = ""; renderDamage(); });
            els["mds-dmg-meter"].addEventListener("click", e => { if (e.ctrlKey || e.metaKey) return; if (metFoldClick(e)) return; if (metSubClick(e)) { dmgHtml = ""; renderDamage(); return; } const tr = e.target.closest("tr.mds-mrow"); if (!tr) return; const n = tr.dataset.player; if (dmgExpanded.has(n)) dmgExpanded.delete(n); else { dmgExpanded.add(n); metFoldsReset(); } dmgHtml = ""; renderDamage(); });
            els["mds-dmg-sessions"].addEventListener("click", e => { if (e.ctrlKey || e.metaKey) return; const tr = e.target.closest("tr[data-sid]"); if (!tr) return; dmgPick = tr.dataset.sid; dmgHtml = ""; renderDamage(); });
            {
                const on = root.querySelector("#mds-meter-on"), bmBox = root.querySelector("#mds-bm-on");
                const apply = () => { const en = meterEnabled(); on.checked = en; bmBox.disabled = !en; const tb = root.querySelector('.mds-tabs button[data-tab="damage"]'); if (tb) tb.hidden = !en; if (!en && tab === "damage") setTab("overview"); };
                on.addEventListener("change", () => { try { localStorage.setItem(METER_OFF_KEY, on.checked ? "on" : "off"); } catch (_e) { /* fine */ } if (!on.checked) { meterDisable(); bmPopClose(); } apply(); renderBattleMeter(); });
                apply();
            }
            { const box = root.querySelector("#mds-metercols"); for (const c of METER_COLS) { const lab = document.createElement("label"), inp = document.createElement("input"); inp.type = "checkbox"; inp.id = "mds-mcol-" + c.k; inp.checked = !meterCols.hidden.includes(c.k); inp.addEventListener("change", () => { meterCols.hidden = meterCols.hidden.filter(k => k !== c.k); if (!inp.checked) meterCols.hidden.push(c.k); meterColsChanged(); }); lab.appendChild(inp); lab.appendChild(document.createTextNode(" " + c.label)); box.appendChild(lab); } }
            for (const which of ["amber", "red"]) { const inp = root.querySelector("#mds-key-" + which); inp.value = String(keyHours(which)); inp.addEventListener("change", () => { const v = Number(inp.value); try { if (inp.value !== "" && v >= 0) localStorage.setItem(KEYH_KEY + which, String(v)); else localStorage.removeItem(KEYH_KEY + which); } catch (_e) { /* fine */ } inp.value = String(keyHours(which)); bkHtml = ""; bmHtml = ""; battleKeys(); renderBattleMeter(); }); }
            { const bm = root.querySelector("#mds-bm-on"); bm.checked = bmOn(); bm.addEventListener("change", () => { try { localStorage.setItem(BM_KEY, bm.checked ? "on" : "off"); } catch (_e) { /* fine */ } renderBattleMeter(); }); }
            setInterval(() => { try { if (!document.hidden) { battleSplit(); battleKeys(); consTips(); renderBattleMeter(); if (tipFor) tipPlace(); if (open && tab === "damage") renderDamage(); if (open && tab === "party") renderParty(); } } catch (error) { warn("damage meter view", error); } }, 1000);
            setInterval(() => { if (open && tab === "xp") touch(); }, 5000);
            els["mds-plan-owned"].addEventListener("change", e => { plan.owned = !!e.target.checked; savePlan(); renderPlan(); });
            root.querySelector("#mds-plan-craft").addEventListener("click", () => { const p = plan.key && planRecipe(plan.key); if (p) goToAction(p.action); });
            root.querySelector("#mds-plan-prices").addEventListener("click", () => fetchPrices(true).then(() => render()));
            root.querySelector("#mds-plan-copy").addEventListener("click", async () => {
                if (!lastPlanRows) return;
                const lines = [`${it(plan.key)} × ${lastPlanWant != null ? lastPlanWant.toLocaleString() : "?"}`, ...lastPlanRows.filter(x => x.buy > 0).map(x => `- ${itemName(x.item)} × ${x.buy.toLocaleString()}${x.cost != null ? ` ≈ ${Math.round(x.cost).toLocaleString()} coins` : ""}`), `Total ≈ ${Math.round(lastPlanRows.reduce((s, x) => s + (x.buy > 0 && x.cost != null ? x.cost : 0), 0)).toLocaleString()} coins`].join("\n");
                try { await navigator.clipboard.writeText(lines); } catch (_e) { W.prompt("Copy the shopping list:", lines); }
            });
            root.addEventListener("click", e => { const a = e.target.closest("a[data-market]"); if (a) { e.preventDefault(); goToMarket(a.dataset.market); return; } const b = e.target.closest("button[data-act=market]"); if (b) goToMarket(b.dataset.item); const by = e.target.closest("button[data-act=buy]"); if (by) openBuy(by.dataset.item, Number(by.dataset.qty)); const sh = e.target.closest("button[data-act=shop]"); if (sh) goToShop(); });
            root.querySelector("#mds-fs-down").addEventListener("click", () => setScale(scale - 0.05));
            root.querySelector("#mds-fs-up").addEventListener("click", () => setScale(scale + 0.05));
            root.querySelector("#mds-fs-reset").addEventListener("click", () => setScale(1));
            applyScale();
            for (const t of root.querySelectorAll("table")) { const key = tableKey(t); if (key) { t.dataset.key = key; if (t.tHead && t.tHead.rows[0]) tagCells(t.tHead.rows[0]); } }
            buildColumnSettings();
            foldify(root);
            applyCols();
            wireColumnDrag();
            wireCardDrag();
            root.querySelector("#mds-cards-reset").addEventListener("click", () => { cardOrders = {}; try { localStorage.removeItem(CARDS_KEY); } catch (_e) { /* fine */ } render(); });
            root.querySelector("#mds-order-reset").addEventListener("click", () => { orders = {}; try { localStorage.removeItem(ORDER_KEY); } catch (_e) { /* fine */ } for (const tr of root.querySelectorAll("tr")) { const cells = [...tr.children].sort((a, b) => Number(a.dataset.oi) - Number(b.dataset.oi)); for (const c of cells) tr.appendChild(c); } });
            root.querySelector("#mds-history-input").addEventListener("change", e => { const f = e.target.files && e.target.files[0]; e.target.value = ""; if (f) importMarketHistoryFile(f).then(() => render(), err => warn("history import failed", err)); });
            // Rows are held while the reader is scrolled down; they catch up at the top.
            els.wrap.addEventListener("scroll", () => { if (rowsHeld && els.wrap.scrollTop <= 8) renderRows(true); }, { passive: true });
            els.runsWrap.addEventListener("scroll", () => { if (runsHeld && els.runsWrap.scrollTop <= 8) renderRuns(true); }, { passive: true });
            document.body.appendChild(toggle); document.body.appendChild(root);
            try { open = localStorage.getItem(PANEL_KEY) === "open"; tab = localStorage.getItem(PANEL_KEY + "-tab") || tab; } catch (_e) { open = false; }
            setTab(tab, true);
            root.hidden = !open; if (open) render();
            dockStart();
        }
        // -----------------------------------------------------------------------------------------------------------
        // Docking. The Combat page's strip (Combat Zones · Find Party · My Party · Battle · Statistics) is MUI Tabs
        // rendered by React. Our tab is a plain button React never sees. While it is selected the game's own tab panel is
        // hidden and the panel sits in its place; clicking any game tab hands the strip back exactly as it was. React may
        // re-render the strip at any time, so an observer re-applies the selection and re-hides a re-rendered panel.
        // -----------------------------------------------------------------------------------------------------------
        const dock = { strip: null, tab: null, active: false, saved: null, compMo: null, bodyMo: null, timer: null, worked: false };
        const STRIP_TABS = ["Combat Zones", "Find Party", "My Party"];
        const tabText = b => { const sp = b.querySelector(".MuiBadge-root") || b; for (const nd of sp.childNodes) if (nd.nodeType === 3 && nd.textContent.trim()) return nd.textContent.trim(); return (sp.textContent || "").trim(); };
        function findStrip() {
            for (const list of document.querySelectorAll('[class*="TabsComponent_tabsComponent"] [role="tablist"]')) {
                const tabs = [...list.querySelectorAll('[role="tab"]')].filter(t => t !== dock.tab);
                const names = [...STRIP_TABS, ...["combatZones", "findParty", "myParty"].map(k => gameName("combatPanel", k, ""))].filter(Boolean);
                if (tabs.length >= 3 && tabs.some(t => names.includes(tabText(t)))) return list;
            }
            return null;
        }
        const dockParts = () => { const comp = dock.strip && dock.strip.closest('[class*="TabsComponent_tabsComponent"]'); const cont = dock.strip && dock.strip.closest('[class*="TabsComponent_tabsContainer"]'); return comp && cont ? { comp, cont } : null; };
        function dockSchedule() { if (dock.timer) return; dock.timer = setTimeout(() => { dock.timer = null; dockTick(); }, 60); }
        function dockStart() {
            if (dock.bodyMo || !document.body) return;
            dock.bodyMo = new MutationObserver(dockSchedule);
            dock.bodyMo.observe(document.body, { childList: true, subtree: true });
            dockTick();
        }
        function dockTick() {
            const list = findStrip();
            if (!list) { if (dock.strip) dockLost(); return; }
            if (dock.strip !== list || !dock.tab || dock.tab.parentNode !== list) dockMount(list);
            else if (dock.active) dockApply();
        }
        function dockMount(list) {
            if (dock.strip && dock.strip !== list) dockLost();
            dock.strip = list;
            const model = list.querySelector('[role="tab"]');
            if (!dock.tab) {
                dock.tab = document.createElement("button"); dock.tab.id = "mds-tab"; dock.tab.type = "button"; dock.tab.setAttribute("role", "tab"); dock.tab.tabIndex = -1; dock.tab.title = "Metz Dungeon Stats";
                dock.tab.addEventListener("click", e => { e.stopPropagation(); dockActivate(); });
            }
            dock.tab.className = model ? model.className.replace(/\bMui-selected\b/g, "").replace(/\s+/g, " ").trim() : "";
            dock.tab.setAttribute("aria-selected", "false");
            const badge = model && model.querySelector(".MuiBadge-root");
            dock.tab.textContent = ""; const sp = document.createElement("span"); sp.className = badge ? badge.className : ""; sp.textContent = "Dungeon Stats"; dock.tab.appendChild(sp);
            list.appendChild(dock.tab);
            list.addEventListener("click", onStripClick, true); // capture: runs before React selects the clicked tab
            dock.worked = true;
            if (toggle) toggle.hidden = true;
            if (open && !dock.active) { open = false; root.hidden = true; } // the floating panel yields to the strip
            const parts = dockParts();
            if (parts) {
                if (dock.compMo) dock.compMo.disconnect();
                dock.compMo = new MutationObserver(() => { if (dock.active) dockSchedule(); });
                dock.compMo.observe(parts.comp, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "aria-selected"] });
            }
        }
        function onStripClick(e) { const t = e.target.closest('[role="tab"]'); if (!t || t === dock.tab) return; if (dock.active) dockDeactivate(); }
        function dockActivate() {
            const parts = dockParts(); if (!parts || !root) return;
            if (!dock.active) {
                const ind = parts.comp.querySelector(".MuiTabs-indicator");
                dock.saved = { selected: [...dock.strip.querySelectorAll('[role="tab"].Mui-selected')].filter(t => t !== dock.tab), indicator: ind ? ind.getAttribute("style") : null };
                dock.active = true;
            }
            dockApply();
            root.classList.add("docked"); root.hidden = false;
            if (root.parentNode !== parts.comp) parts.comp.appendChild(root);
            open = true; render();
        }
        // Idempotent: every write is guarded so re-applying under the observer never loops.
        function dockApply() {
            const parts = dockParts(); if (!parts || !dock.active) return;
            for (const t of dock.strip.querySelectorAll('[role="tab"]')) { const me = t === dock.tab; if (t.classList.contains("Mui-selected") !== me) t.classList.toggle("Mui-selected", me); if (t.getAttribute("aria-selected") !== String(me)) t.setAttribute("aria-selected", String(me)); }
            const ind = parts.comp.querySelector(".MuiTabs-indicator");
            if (ind) { const l = dock.tab.offsetLeft + "px", w = dock.tab.offsetWidth + "px"; if (ind.style.left !== l) ind.style.left = l; if (ind.style.width !== w) ind.style.width = w; }
            for (const el of parts.comp.children) { if (el === parts.cont || el === root) continue; if (el.style.display !== "none") { el.dataset.mdsHidden = el.style.display || ""; el.style.display = "none"; } }
            if (root.parentNode !== parts.comp) parts.comp.appendChild(root);
            if (root.hidden) root.hidden = false;
        }
        function dockRestore() {
            const parts = dockParts();
            if (parts) {
                for (const el of parts.comp.querySelectorAll("[data-mds-hidden]")) { el.style.display = el.dataset.mdsHidden; delete el.dataset.mdsHidden; }
                const ind = parts.comp.querySelector(".MuiTabs-indicator");
                if (ind && dock.saved) { if (dock.saved.indicator == null) ind.removeAttribute("style"); else ind.setAttribute("style", dock.saved.indicator); }
            }
            if (dock.strip) for (const t of dock.strip.querySelectorAll('[role="tab"]')) { const sel = !!dock.saved && dock.saved.selected.includes(t); t.classList.toggle("Mui-selected", sel); t.setAttribute("aria-selected", String(sel)); }
            if (dock.tab) { dock.tab.classList.remove("Mui-selected"); dock.tab.setAttribute("aria-selected", "false"); }
            dock.saved = null;
        }
        function dockDeactivate() {
            if (!dock.active) return;
            dock.active = false;
            dockRestore();
            root.classList.remove("docked"); root.hidden = true; open = false;
            if (root.parentNode !== document.body) document.body.appendChild(root);
        }
        function dockLost() {
            // The strip left the page (another game tab). Nothing to restore: React took its panel with it.
            if (dock.compMo) { dock.compMo.disconnect(); dock.compMo = null; }
            if (dock.strip) dock.strip.removeEventListener("click", onStripClick, true);
            if (dock.tab && dock.tab.parentNode) dock.tab.parentNode.removeChild(dock.tab);
            dock.strip = null; dock.saved = null;
            if (dock.active) { dock.active = false; root.classList.remove("docked"); root.hidden = true; open = false; }
            if (root && root.parentNode !== document.body) document.body.appendChild(root);
        }
        function setTab(k, silent) {
            if (!TABS.some(t => t[0] === k) || (k === "damage" && !meterEnabled())) k = "overview";
            tab = k;
            for (const b of root.querySelectorAll(".mds-tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === k));
            for (const p of root.querySelectorAll(".mds-pane")) p.hidden = p.dataset.pane !== k;
            try { localStorage.setItem(PANEL_KEY + "-tab", k); } catch (_e) { /* fine */ }
            if (!silent) render();
        }
        function setOpen(v) {
            if (dock.active) { if (!v) dockDeactivate(); return; }
            if (v && dock.strip) { dockActivate(); return; }
            open = v; if (root) root.hidden = !v; try { localStorage.setItem(PANEL_KEY, v ? "open" : "closed"); } catch (_e) { /* fine */ } if (v) render();
        }
        function touch() { dirty = true; if (!timer) timer = setTimeout(() => { timer = null; if (dirty && open) render(); dirty = false; }, 1000); }
        function refresh() { ensure(); touch(); }
        const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
        const it = h => esc(itemName(h));
        const xpSum = x => Object.entries(x || {}).filter(([k]) => k !== "/skills/total_level").reduce((s, [, v]) => s + v, 0);
        const fmtHm = ms => { if (!(ms >= 0)) return "?"; if (ms < 3600e3) { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}m ${pad2(s % 60)}s`; } const m = Math.round(ms / 60000); return `${Math.floor(m / 60)}h ${pad2(m % 60)}m`; };
        const pct = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "–");
        function describe(ev) {
            switch (ev.kind) {
                case "start": return `${esc(shortAction(ev.zone))} T${ev.tier} battle ${ev.battleId}${ev.partial ? " (joined mid-run)" : ""} · party ${esc((ev.party || []).join(", "))}`;
                case "clear": return `${esc(shortAction(ev.zone))} T${ev.tier} cleared in ${fmtDur(ev.durationMs)} · ${ev.waves} waves · chests ${(ev.chests || []).map(c => `${c.qty}× ${it(c.item)}`).join(", ") || "none in message"} · keys charged ${ev.keysCharged ?? "?"} · XP ${fmtCoins(xpSum(ev.xpBySkill))}`;
                case "fail": return `${esc(shortAction(ev.zone))} T${ev.tier} failed on wave ${ev.waves} after ${fmtDur(ev.durationMs)}`;
                case "stop": return `${esc(shortAction(ev.zone))} stopped at wave ${ev.waves ?? ev.waveReached ?? "?"} · ${esc(ev.reason || "")}`;
                case "craft": return `${esc(shortAction(ev.action))} ×${(ev.outputs || []).reduce((s, o) => s + o.qty, 0)} · ${(ev.inputs || []).map(i => `${i.qty} ${it(i.item)}${i.unitCost != null ? ` @${fmtCoins(i.unitCost)}` : " @?"}`).join(", ")}${ev.coins ? ` + ${fmtCoins(ev.coins)} coins` : ""} · ${ev.unitCost != null ? `${fmtCoins(ev.unitCost)} per key` : "cost unknown"}`;
                case "buy": if (ev.imported) return `imported from Toolasha: ${ev.qty} ${it(ev.item)} @ ${fmtCoins(ev.unitPrice)} = ${fmtCoins(ev.coins)}`; return `${ev.qty}× ${it(ev.item)} ${ev.unitPrice != null ? `@ ${fmtCoins(ev.unitPrice)} = ${fmtCoins(ev.coins)}` : "price unresolved"}${ev.instant ? " · instant" : ""}`;
                case "sell": if (ev.imported) return `imported from Toolasha: ${ev.qty} ${it(ev.item)} @ ${fmtCoins(ev.unitPrice)} = ${fmtCoins(ev.gross)} gross, tax at ${(marketTaxRate(ev.item, ev.at) * 100).toFixed(0)}% (the game's rate for that item on that day, not measured), net ${fmtCoins(ev.gross - Math.round(ev.gross * marketTaxRate(ev.item, ev.at)))}`; return `${ev.qty}× ${it(ev.item)} ${ev.unitPrice != null ? `@ ${fmtCoins(ev.unitPrice)}` : ""} · net ${fmtCoins(ev.net)}${ev.tax != null ? ` (tax ${fmtCoins(ev.tax)})` : ""}${ev.instant ? " · instant" : ""}`;
                case "open": return `${ev.count}× ${it(ev.chest)} → ${(ev.gains || []).map(g => `${g.qty} ${it(g.item)}`).join(", ")} · value at bid ${fmtCoins(ev.valueBid)}${ev.coinsGained ? ` + ${fmtCoins(ev.coinsGained)} coins` : ""}${ev.unpriced && ev.unpriced.length ? ` · unpriced: ${ev.unpriced.map(it).join(", ")}` : ""}${(ev.gains || []).some(g => g.counted || isCounted(g.item)) ? ` · counted: ${(ev.gains || []).filter(g => g.counted || isCounted(g.item)).map(g => `${g.qty} ${it(g.item)}`).join(", ")}` : ""}`;
                case "consume": return `${ev.qty}× ${it(ev.item)}${ev.unitCost != null ? ` @ ${fmtCoins(ev.unitCost)}` : ` (purchase price known for ${ev.covered || 0} of ${ev.qty})`}`;
                case "redeem": return `${ev.qty}× ${it(ev.token)} → ${ev.itemQty}× ${it(ev.item)}`;
                case "baseline": return `${(ev.items || []).filter(i => i.kind !== "key material").length} consumables and ${(ev.items || []).filter(i => i.kind === "key material").length} key materials priced at ask, ${(ev.keys || []).length} key types, ${(ev.chests || []).length} chest types · ${fmtCoins(ev.coins)} coins`;
                case "offline": { const to = Math.min(ev.to || ev.at, ev.at); return `${fmtDur(to - (ev.from || 0))} offline (${fmtTime(ev.from)} to ${fmtTime(to)}) · ${(ev.items || []).length} item deltas · XP ${fmtCoins(xpSum(ev.xpBySkill))}`; }
                case "chat": return `${esc(ev.m)}${ev.keyCounts ? " · " + esc(Object.entries(ev.keyCounts).map(([n, k]) => `${n} ${k}`).join(", ")) : ""}${ev.replay ? " · replayed" : ""}`;
                case "review": return `${esc(ev.reason)}`;
                case "damage": { const total = sessTotal(ev), me = ev.players && ev.players[state.characterName]; return `${meterWhere(ev)} ${esc(meterResult(ev))} · ${ev.waves} waves · ${fmtDur(num(ev.combatMs))} in combat · party ${fmtN(total)}${me ? ` · you ${fmtN(me.dealt)} (${pct1(me.dealt, total)})` : ""} · checked ${(ev.check || {}).balanced || 0}/${(ev.check || {}).waves || 0}`; }
                case "note": return esc(ev.text || "");
                case "reprice": return `from ${esc(ev.from)} (${ev.listings} listings): ${(ev.items || []).map(r => `${it(r.item)} ${fmtCoins(r.prevAvg)} → ${fmtCoins(r.avg)} (${r.covered} of ${r.qty} from ${r.listings} buys)`).join(", ") || "no stock matched"}${(ev.keys || []).length ? ` · keys: ${ev.keys.map(k => `${k.qty} ${it(k.item)} ${fmtCoins(k.prev)} → ${fmtCoins(k.unitCost)}`).join(", ")}` : ""}`;
                case "keep": return `${it(ev.item)}: kept ${ev.total} for future runs`;
                case "value": return `${ev.qty} ${it(ev.item)} valued at ${fmtCoins(ev.unitValue)} each (bid ${fmtCoins(ev.bidNow)}, at open ${fmtCoins(ev.bidAtOpen)})`;
                default: return esc(JSON.stringify(ev).slice(0, 200));
            }
        }
        function renderRows(force) {
            if (!els["mds-tbody"]) return;
            if (!force && els.wrap.scrollTop > 8) { rowsHeld = true; return; }
            rowsHeld = false;
            // The default feed leaves consumable uses out: they are kept for cost tracking, not for reading.
            renderReview();
            const rows = state.events.filter(e => filter === "all" ? e.kind !== "consume" : e.kind === filter).slice(0, 200);
            els["mds-tbody"].innerHTML = rows.map(ev => `<tr class="${ev.kind}"><td class="t">${fmtTime(ev.at)}</td><td class="k">${ev.kind}</td><td class="d">${describe(ev)}</td><td class="t">${esc(ev.src || "")}</td></tr>`).join("") || `<tr><td colspan="4" class="t">Nothing recorded yet.</td></tr>`;
        }
        const cardKey = label => String(label).replace(/<[^>]*>/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
        function card(label, value, sub) { const text = Array.isArray(sub) ? sub.filter(Boolean).join("<br>") : sub; return `<div class="mds-card" data-card="${cardKey(label)}" draggable="true"><div class="l">${label}</div><div class="n">${value}</div>${text ? `<small>${text}</small>` : ""}</div>`; }
        // Card order per container (Overview, Chests), saved per browser: drag a card onto another to move it there.
        const CARDS_KEY = PANEL_KEY + "-cards";
        let cardOrders = {};
        try { cardOrders = JSON.parse(localStorage.getItem(CARDS_KEY) || "{}") || {}; } catch (_e) { cardOrders = {}; }
        // Default order of the Overview cards (operator's, 2026-11-01); a saved order replaces it, unknown cards follow.
        const DEFAULT_CARD_ORDER = { cards: ["clears", "average-run", "chests-earned", "holdover-chests", "loot-at-open", "spent", "net", "sold", "cowbells", "in-dungeons", "between-runs"] };
        function sortCards(container, htmls) {
            const order = cardOrders[container] || DEFAULT_CARD_ORDER[container] || []; const keyOf = h => (h.match(/data-card="([^"]*)"/) || [])[1] || "";
            return htmls.map((h, i) => ({ h, i, pos: order.indexOf(keyOf(h)) })).sort((a, b) => (a.pos < 0 ? 1e9 + a.i : a.pos) - (b.pos < 0 ? 1e9 + b.i : b.pos)).map(x => x.h);
        }
        function setCardOrder(container, order) { cardOrders[container] = order; try { localStorage.setItem(CARDS_KEY, JSON.stringify(cardOrders)); } catch (_e) { /* fine */ } render(); }
        let cardDrag = null;
        function wireCardDrag() {
            const containerOf = el => { const c = el.closest(".mds-cards"); return c ? c.id.replace(/^mds-/, "") : null; };
            root.addEventListener("dragstart", e => { if (e.target.closest("th")) return; const c = e.target.closest(".mds-card"); if (!c) return; cardDrag = { container: containerOf(c), key: c.dataset.card }; c.classList.add("mds-dragging"); try { e.dataTransfer.setData("text/plain", c.dataset.card); e.dataTransfer.effectAllowed = "move"; } catch (_e) { /* fine */ } });
            root.addEventListener("dragend", e => { const c = e.target.closest && e.target.closest(".mds-card"); if (c) c.classList.remove("mds-dragging"); for (const x of root.querySelectorAll(".mds-card.mds-drop")) x.classList.remove("mds-drop"); cardDrag = null; });
            root.addEventListener("dragover", e => { if (!cardDrag) return; const c = e.target.closest(".mds-card"); if (!c || containerOf(c) !== cardDrag.container) return; e.preventDefault(); for (const x of root.querySelectorAll(".mds-card.mds-drop")) x.classList.remove("mds-drop"); if (c.dataset.card !== cardDrag.key) c.classList.add("mds-drop"); });
            root.addEventListener("drop", e => {
                if (!cardDrag) return; const c = e.target.closest(".mds-card"); if (!c || containerOf(c) !== cardDrag.container) return;
                e.preventDefault();
                const keys = [...c.parentElement.children].map(x => x.dataset.card).filter(k => k !== cardDrag.key);
                const at = keys.indexOf(c.dataset.card); const r = c.getBoundingClientRect(); const after = e.clientX > r.left + r.width / 2;
                keys.splice(at < 0 ? keys.length : at + (after ? 1 : 0), 0, cardDrag.key);
                const container = cardDrag.container; cardDrag = null;
                setCardOrder(container, keys);
            });
        }
        function renderOverview() {
            const d = getDerived(), S = d.summary;
            const offChests = d.offline.reduce((s, b) => s + b.chestTotal, 0);
            // Chests earned since the record started and chests held before it, with openings taken out of the holdover
            // first, then out of the earned ones, so the two blocks add up to what the bag holds.
            const perType = { ...S.chests }; for (const b of d.offline) for (const [h, q] of Object.entries(b.chests)) perType[h] = (perType[h] || 0) + q;
            // The game's count is the reference (design 4.7): once the Loot & XP Log has been read, clears and dungeon
            // chests are its totals, with this record's own events only for what the log does not cover yet.
            const G = gameTotals();
            if (G.read) { for (const h of Object.keys(perType)) if (ref.chestItems[h] && ref.chestItems[h].zone) delete perType[h]; for (const [h, q] of Object.entries(G.total.chests)) perType[h] = q; }
            const Mc = getMoney().chests; const baseRows = holdover().rows; const earnedNow = {}, holdNow = {};
            for (const h of new Set([...Object.keys(perType), ...baseRows.map(c => c.item)])) { const base = (baseRows.find(c => c.item === h) || {}).qty || 0; const opened = Mc[h] ? Mc[h].opened : 0; holdNow[h] = Math.max(0, base - opened); earnedNow[h] = perType[h] || 0; } // earned since the record began, opened or not (operator 2026-11-01: it has to line up with Loot at open, Spent, Sold and Net)
            // Containers that came out of those chests (Large Treasure Chest) count as chests earned too: a dungeon runner
            // gets nearly all of them from dungeon chests (operator, 2026-11-01).
            const nested = getMoney().rows.filter(r => r.fromChests > 0 && ref.items[r.item] && ref.items[r.item].openable && !(ref.chestItems[r.item] && ref.chestItems[r.item].zone)).sort((a, b) => b.fromChests - a.fromChests);
            const chestLines = [...Object.entries(earnedNow).filter(([, q]) => q > 0).map(([h, q]) => `${q} ${chestName(h)}`), ...nested.map(r => `${r.fromChests} ${it(r.item)}`)];
            const holdLines = Object.entries(holdNow).filter(([, q]) => q > 0).map(([h, q]) => `${q} ${chestName(h)}`);
            const holdTotal = Object.values(holdNow).reduce((a, b) => a + b, 0), earnedTotal = Object.values(earnedNow).reduce((a, b) => a + b, 0) + nested.reduce((a, r) => a + r.fromChests, 0);
            const M = getMoney();
            const assumed = M.tax.measured ? "" : " assumed";
            const cards = [
                card("Clears", G.read ? G.total.clears : S.clears, [
                    G.read ? `Game's Loot & XP Log, read ${fmtClock(G.lastEnd)}${G.own.clears ? ` + ${G.own.clears} since` : ""}` : "This record only: open the Loot & XP Log for the game's count",
                    G.read ? `${S.clears} timed by this record` : "", G.uncovered ? `${G.uncovered} session${G.uncovered === 1 ? "" : "s"} from before the record not in the count` : "",
                    `${S.fails} Failed${S.failRate != null ? ` (${(S.failRate * 100).toFixed(1)}%)` : ""}`, `${S.cancelled} Cancelled`, S.unknown ? `${S.unknown} End unknown` : ""]),
                card("Average run", S.avgClearMs != null ? fmtDur(S.avgClearMs) : "–", S.clearMs.length ? [S.avgRunMs != null && S.fails ? `${fmtDur(S.avgRunMs)} counting fails` : "", `Fastest ${fmtDur(S.fastestMs)}`, `Slowest ${fmtDur(S.slowestMs)}`] : ["No completed run yet"]),
                card("Chests earned", earnedTotal, chestLines.length ? chestLines : ["None yet"]),
                ...(holdTotal ? [card("Holdover chests", holdTotal, holdLines)] : []),
                card("In dungeons", fmtHm(S.dungeonMs), [`${pct(S.dungeonMs, S.totalMs)} of ${fmtHm(S.totalMs)} recorded`, ...(S.dungeonLogMs > 0 ? [`${fmtHm(S.dungeonWatchedMs)} timed by this record`, `+ ${fmtHm(S.dungeonLogMs)} from the game's Loot & XP Log`] : [])]),
                card("Between runs", fmtHm(S.betweenMs), [`Crafting ${fmtHm(S.craftingMs)}`, `Offline ${fmtHm(S.offlineBetweenMs)}`, `Other ${fmtHm(S.otherMs)}`]),
            ];
            for (const [h, c] of Object.entries(S.counted || {})) if (c.qty > 0) cards.push(card(icon(h) + it(h) + "s", c.qty, Object.entries(c.byChest).filter(([, b]) => b.qty > 0).map(([chest, b]) => `${b.opened ? (b.qty / b.opened).toFixed(2) : "?"} per ${chestName(chest)}`)));
            if (S.unknownMs > 0) cards.push(card("Unaccounted", fmtHm(S.unknownMs), ["No run end in the chat ledger and no session in the game's Loot & XP Log"]));
            { const XS = xpSummary(serverNow()); if (XS && XS.total > 0) cards.push(card("XP", fmtCoins(XS.total), [XS.perHour != null ? `${fmtCoins(XS.perHour)} / h` : "", XS.today ? `Today ${fmtCoins(XS.today.total)}` : "", `Active ${fmtHm(XS.activeMs)}`])); }
            cards.push(
                card("Spent", fmtCoins(M.spent.total), [`Entry keys ${fmtCoins(M.spent.entryKeys)}`, `Chest keys ${fmtCoins(M.spent.chestKeys)}`, `Consumables ${fmtCoins(M.spent.consumables)}`, `Bought ${fmtCoins(M.spent.buys + M.spent.craftCoins)} as stock, charged as used`]),
                card("Loot at open", fmtCoins(M.loot.atOpen), [`${M.loot.opened} Dungeon chest${M.loot.opened === 1 ? "" : "s"} opened, at bid`, M.loot.nestedOpened ? `${M.loot.nestedOpened} Chest${M.loot.nestedOpened === 1 ? "" : "s"} from inside them` : "", M.loot.tokens.value ? `${fmtCoins(M.loot.tokens.value)} of it Tokens, at the best shop bid per token${M.loot.tokens.now ? ` (${fmtQ(M.loot.tokens.now)} at today's bid)` : ""}` : "", `+ ${fmtCoins(M.loot.coins)} Coins`]),
                card("Sold", fmtCoins(M.sold.loot.net), [`${M.sold.loot.qty} Items`, `${fmtCoins(M.sold.loot.tax)} Tax (${(M.tax.rate * 100).toFixed(1)}%${assumed})`, M.sold.other.net ? `Other sales ${fmtCoins(M.sold.other.net)} not counted` : ""]),
                card("Net", fmtCoins(M.net), [`Sold ${fmtCoins(M.sold.loot.net)}`, `+ Chest coins ${fmtCoins(M.loot.coins)}`, `− Spent ${fmtCoins(M.spent.total)}`, `Held loot ${fmtCoins(M.heldLoot)} at bid`, M.holdoverLoot ? `Holdover ${fmtCoins(M.holdoverLoot)} not counted` : "", `No longer held ${fmtCoins(M.missingLoot)}`, M.reviewRows ? `${M.reviewRows} To review` : ""]),
            );
            els["mds-cards"].innerHTML = sortCards("cards", cards).join("");
            // Consumables as Insight laid them out: icon, quantity held, name; the tile opens the item in the marketplace.
            // Those slotted for the current fight come first, then by what was used in the record.
            const slotted = new Set(state.battleItems || []);
            const cons = Object.entries(M.consumables).filter(([h, c]) => c.used > 0 || slotted.has(h) || c.held > 0 && isConsumable(h)).sort((a, b) => (slotted.has(b[0]) - slotted.has(a[0])) || (b[1].usedCost - a[1].usedCost) || (b[1].held - a[1].held));
            els["mds-consumables"].innerHTML = cons.map(([h, c]) => `<button class="mds-tile${slotted.has(h) ? " slotted" : ""}" data-act="market" data-item="${esc(h)}" title="${esc(`${itemName(h)}: ${t("{n} held", { n: fmtQ(c.held) })} · ${t("{n} used in the record", { n: fmtQ(c.used) })}${c.crafting ? " " + t("({n} in key crafts)", { n: fmtQ(c.crafting) }) : ""}${c.avg != null ? " · " + t("{n} each at purchase price", { n: fmtCoins(c.avg) }) : ""}${slotted.has(h) ? " · " + t("slotted now") : ""}. ${t("Click to open in the marketplace.")}`)}">${icon(h)}<strong>${fmtQ(c.held)}</strong><small>${it(h)}</small></button>`).join("") || `<span class="mds-note">No consumables used yet.</span>`;
            const live = sessionsOf().find(e => (ref.dungeons[e.action] || /\/combat\//.test(e.action)) && isRunning(e) && e.end > S.windowStart);
            const check = live ? (() => { const o = recordInSpan(d, live); const t = compareText(o, live, S.windowStart); return t ? ` Game's Loot & XP Log, session since ${fmtTime(live.start)} (read ${fmtTime(state.lootLogAt)}): ${t}.` : ""; })() : "";
            els["mds-ovnote"].textContent = `${check}${t("Since {date}.", { date: fmtTime(S.windowStart) })} ${t("A run lasts from one party key-count message to the next, the way Toolasha counts it; cancelled runs are left out of the average. Runs while you were offline come from the party chat, their chests from the login summary.")}${S.open ? " " + t("One run is in progress.") : ""}`;
        }
        const fmtQ = q => (q == null ? "–" : Number.isInteger(q) ? q.toLocaleString() : q.toFixed(1));
        // The game's own navigation: its React components expose handleGoToMarketplace(item, level) and
        // handleGoToAction(action). Calling them is what a click on an item or an action does in the game; nothing is
        // sent anywhere by this script.
        function gameHandler(method) {
            const rootEl = document.getElementById("root"); if (!rootEl) return null;
            let first = (rootEl._reactRootContainer && (rootEl._reactRootContainer.current || (rootEl._reactRootContainer._internalRoot && rootEl._reactRootContainer._internalRoot.current))) || null;
            if (!first) { const k = Object.keys(rootEl).find(x => x.startsWith("__reactContainer$")); if (k) first = rootEl[k]; }
            const pending = first ? [first] : [], seen = new Set();
            while (pending.length && seen.size < 4000) {
                const f = pending.pop(); if (!f || seen.has(f)) continue; seen.add(f);
                const node = f.stateNode; if (node && typeof node[method] === "function") return (...args) => node[method](...args);
                if (f.child) pending.push(f.child); if (f.sibling) pending.push(f.sibling);
            }
            return null;
        }
        const goToMarket = item => { const f = gameHandler("handleGoToMarketplace"); if (f) { try { f(item, 0); return true; } catch (e) { warn("market navigation failed", e); } } W.alert("The game's marketplace navigation was not found; open the marketplace yourself."); return false; };
        // Any handler whose name matches: the shop's navigation handler is not yet measured (handleGoToShop or similar).
        function gameHandlerLike(re) {
            const rootEl = document.getElementById("root"); if (!rootEl) return null;
            let first = (rootEl._reactRootContainer && (rootEl._reactRootContainer.current || (rootEl._reactRootContainer._internalRoot && rootEl._reactRootContainer._internalRoot.current))) || null;
            if (!first) { const k = Object.keys(rootEl).find(x => x.startsWith("__reactContainer$")); if (k) first = rootEl[k]; }
            const pending = first ? [first] : [], seen = new Set();
            while (pending.length && seen.size < 4000) {
                const f = pending.pop(); if (!f || seen.has(f)) continue; seen.add(f);
                const node = f.stateNode;
                if (node && typeof node === "object" && !(node instanceof Node)) { const name = Object.getOwnPropertyNames(node).find(n => re.test(n) && typeof node[n] === "function"); if (name) return { name, call: (...args) => node[name](...args) }; }
                if (f.child) pending.push(f.child); if (f.sibling) pending.push(f.sibling);
            }
            return null;
        }
        // The shop: the game's top component keeps the open page as navTarget and exposes handleGoToNavTarget; the
        // shop's name is NavConsts.Shop = "shop" (read from main.8add56c3.chunk.js, 2026-11-01). The shop page then
        // renders its category tabs (General, Dungeon); the Dungeon tab is clicked once it is there, like a player would.
        const goToShop = () => {
            let f = gameHandler("handleGoToNavTarget"); let via = "handleGoToNavTarget";
            if (!f) { const h = gameHandlerLike(/^handleGoTo\w*Shop\w*$/i); if (h) { f = h.call; via = h.name; } }
            if (!f) { W.alert("The game's shop navigation was not found; open the shop yourself."); return false; }
            try { f("shop"); } catch (e) { warn("shop navigation failed", via, e); W.alert("The game's shop navigation failed; open the shop yourself."); return false; }
            // The game's tabs are MUI tab buttons whose label sits in a badge span, so the text may end in a count
            // ("My Listings0"). Match the name with any count stripped; prefer a tab inside the shop panel, since the
            // Marketplace has a Dungeon tab of its own.
            let tries = 0;
            const pick = () => {
                const tabs = [...document.querySelectorAll('[role="tab"]')].filter(el => !root.contains(el));
                const norm = el => el.textContent.replace(/\d+$/, "").trim();
                const named = tabs.filter(el => /^dungeon$/i.test(norm(el)));
                const tab = named.find(el => el.closest('[class*="Shop"]')) || (tries > 15 ? named[0] : null);
                if (tab) { if (tab.getAttribute("aria-selected") !== "true") tab.click(); return; }
                if (++tries < 40) setTimeout(pick, 100); else warn("shop Dungeon tab not found; tabs seen:", tabs.map(el => `${norm(el)} in ${(el.closest('[class*="Panel"]') || {}).className || "?"}`));
            };
            setTimeout(pick, 50);
            return true;
        };
        const goToAction = action => { const f = gameHandler("handleGoToAction"); if (f) { try { f(action); return true; } catch (e) { warn("action navigation failed", e); } } W.alert("The game's action navigation was not found; open the crafting page yourself."); return false; };
        let spriteUrl = null;
        function spriteBase() {
            if (spriteUrl) return spriteUrl;
            const use = [...document.querySelectorAll('use[href*="items_sprite"]')].find(u => !root || !root.contains(u)); if (!use) return null;
            try { const url = new URL(use.getAttribute("href"), document.baseURI); if (url.origin !== location.origin) return null; url.hash = ""; spriteUrl = url.href; } catch (_e) { return null; }
            return spriteUrl;
        }
        const spriteUrls = {};
        function spriteOf(sheet) {
            if (spriteUrls[sheet]) return spriteUrls[sheet];
            const use = [...document.querySelectorAll(`use[href*="${sheet}"]`)].find(u => !root || !root.contains(u)); if (!use) return null;
            try { const url = new URL(use.getAttribute("href"), document.baseURI); if (url.origin !== location.origin) return null; url.hash = ""; spriteUrls[sheet] = url.href; } catch (_e) { return null; }
            return spriteUrls[sheet];
        }
        const skillSpriteBase = () => spriteOf("skills_sprite");
        const abilityName = h => gameName("abilityNames", h, (ref.abilities[h] && ref.abilities[h].name) || h.split("/").pop().replace(/_/g, " ").replace(/^./, c => c.toUpperCase()));
        const abilityIcon = h => { const b = spriteOf("abilities_sprite"); return b ? `<svg class="mds-icon" aria-hidden="true"><use href="${b}#${h.split("/").pop()}"></use></svg>` : ""; };
        const skillName = h => gameName("skillNames", h, (ref.skills[h] && ref.skills[h].name) || h.split("/").pop().replace(/_/g, " ").replace(/^./, c => c.toUpperCase()));
        const skillIcon = h => { const b = skillSpriteBase(); return b ? `<svg class="mds-icon" aria-hidden="true"><use href="${b}#${h.split("/").pop()}"></use></svg>` : ""; };
        const icon = h => { const b = spriteBase(); return b && /^\/items\/[a-z0-9_]+$/.test(h) ? `<svg class="mds-icon" aria-hidden="true"><use href="${b}#${h.split("/").pop()}"></use></svg>` : ""; };
        const itIcon = h => icon(h) + it(h);
        const itemLink = h => (ref.items[h] && ref.items[h].tradable === false) || h === "/items/coin" ? itIcon(h) : `${icon(h)}<a href="#" class="mds-link" data-market="${esc(h)}" title="Open in the marketplace">${it(h)}</a>`;
        // Dungeon codes everywhere: Pirate Cove is D4, its chests "D4 Chest" and "D4 Refine", a run at tier 2 "T2D4".
        const dCode = zone => { const dg = ref.dungeons[zone]; return dg && dg.index ? `D${dg.index}` : null; };
        const zoneLabel = (zone, tier) => { const d = dCode(zone); return d ? `${tier != null ? `T${tier}` : ""}${d}` : `${esc(shortAction(zone || "?"))}${tier ? ` T${tier}` : ""}`; };
        const chestName = h => { const c = ref.chestItems[h]; const d = c && c.zone ? dCode(c.zone) : null; return d ? `${d} ${/refinement/.test(h) ? "Refine" : "Chest"}` : it(h); };
        const coinsOr = (v, dash = "–") => (v == null ? dash : fmtCoins(v));
        // Key crafting planner: the recipe at the game's artisan rate, what is owned, what to buy at ask, the cost per
        // key beside the key's own ask. A planning aid, not a record; nothing here is estimated beyond the recipe.
        const PLAN_KEY = PANEL_KEY + "-plan";
        // qty null = as many as the budget buys; budget null = follow the coins in the bag.
        let plan = { key: null, qty: null, budget: null, owned: true };
        let lastPlanWant = null;   // the keys the plan shows, for the shopping list
        try { const v = JSON.parse(localStorage.getItem(PLAN_KEY) || "null"); if (v && typeof v === "object") plan = { key: v.key || null, qty: Number(v.qty) > 0 ? Math.floor(Number(v.qty)) : null, budget: Number(v.budget) >= 0 && v.budget !== null ? Math.floor(Number(v.budget)) : null, owned: v.owned !== false }; } catch (_e) { /* fine */ }
        const savePlan = () => { try { localStorage.setItem(PLAN_KEY, JSON.stringify(plan)); } catch (_e) { /* fine */ } };
        let lastPlanRows = null;
        function planRecipe(key) { for (const [action, r] of Object.entries(ref.keyActions)) if (r.outputs.some(o => o.item === key)) return { action, r }; return null; }
        // Open buy orders for a material (operator, 2026-11-23: placing an order locked coins, the budget that follows
        // the bag fell, and the plan shrank the other materials): what is still to arrive, the coins locked in it, and
        // what has filled but is not collected yet. Counted as bought, and the locked coins as part of the budget.
        function onOrder(item) {
            let qty = 0, locked = 0, unclaimed = 0;
            for (const l of state.listings.values()) {
                if (l.isSell || l.itemHrid !== item || l.level !== 0) continue;
                unclaimed += num(l.unclaimedItemCount);
                if (/cancel|filled|expired/i.test(String(l.status || ""))) continue;
                const left = Math.max(0, num(l.orderQuantity) - num(l.filledQuantity)); qty += left; locked += left * num(l.price);
            }
            return { qty, locked, unclaimed };
        }
        // The game's own buy window, opened as its Buy button opens it (handleShowPrefilledPostListing(newListing, isSell,
        // item, level, quantity, price, instant), read in the game's bundle 2026-11-23), with the plan's quantity in it:
        // an instant order at the best ask, or a new buy listing when nothing is on sale. Nothing is bought here; the
        // player confirms in the game's window.
        function marketPanelNode() {
            const rootEl = document.getElementById("root"); if (!rootEl) return null;
            let first = (rootEl._reactRootContainer && (rootEl._reactRootContainer.current || (rootEl._reactRootContainer._internalRoot && rootEl._reactRootContainer._internalRoot.current))) || null;
            if (!first) { const k = Object.keys(rootEl).find(x => x.startsWith("__reactContainer$")); if (k) first = rootEl[k]; }
            const pending = first ? [first] : [], seen = new Set();
            while (pending.length && seen.size < 8000) {
                const f = pending.pop(); if (!f || seen.has(f)) continue; seen.add(f);
                const node = f.stateNode; if (node && typeof node.handleShowPrefilledPostListing === "function") return node;
                if (f.child) pending.push(f.child); if (f.sibling) pending.push(f.sibling);
            }
            return null;
        }
        let buyTimer = null;
        function openBuy(item, qty) {
            if (!goToMarket(item)) return;
            if (!(qty > 0)) return;
            if (buyTimer) clearInterval(buyTimer);
            let tries = 0;
            buyTimer = setInterval(() => {
                tries++;
                let m = null; try { m = marketPanelNode(); } catch (_e) { m = null; }
                const books = m && m.state && m.state.marketItemOrderBooks;
                if (m && m.state.itemHrid === item && books && books.itemHrid === item) {
                    clearInterval(buyTimer); buyTimer = null;
                    try {
                        const ask = typeof m.getBestAskPrice === "function" ? num(m.getBestAskPrice(0)) : 0;
                        if (ask > 0) m.handleShowPrefilledPostListing(false, false, item, 0, qty, ask, true);
                        else m.handleShowPrefilledPostListing(true, false, item, 0, qty, typeof m.getDefaultPriceForLevel === "function" ? num(m.getDefaultPriceForLevel(0)) : num(askOf(item)), false);
                    } catch (e) { warn("the game's buy window could not be opened; the marketplace is on the item", e); }
                } else if (tries > 50) { clearInterval(buyTimer); buyTimer = null; }
            }, 100);
        }
        function renderPlan() {
            const sel = els["mds-plan-key"]; const keys = [...ref.realKeys].filter(k => planRecipe(k)).sort((a, b) => it(a).localeCompare(it(b)));
            if (!keys.length) { sel.innerHTML = ""; els["mds-plan"].innerHTML = `<tr><td colspan="8" class="t">Key recipes come with the game data; log in first.</td></tr>`; els["mds-plan-sum"].textContent = ""; return; }
            if (!plan.key || !keys.includes(plan.key)) plan.key = keys.includes("/items/pirate_chest_key") ? "/items/pirate_chest_key" : keys[0];
            if ([...sel.options].map(o => o.value).join("|") !== keys.join("|")) sel.innerHTML = keys.map(k => `<option value="${esc(k)}">${it(k)}</option>`).join("");
            sel.value = plan.key; if (document.activeElement !== els["mds-plan-qty"]) els["mds-plan-qty"].value = plan.qty == null ? "" : String(plan.qty);
            const { action, r } = planRecipe(plan.key); const out = r.outputs.find(o => o.item === plan.key); const perCraft = out ? out.qty : 1;
            const art = artisanOf(action); const cut = art ? 1 - art.rate : 1;
            const none = { qty: 0, locked: 0, unclaimed: 0 }, ord = {};
            for (const i of r.inputs) if (i.item !== "/items/coin") ord[i.item] = onOrder(i.item);
            if (art && art.tea) ord[art.tea] = onOrder(art.tea);
            const lockedTotal = Object.values(ord).reduce((a, o) => a + o.locked, 0);
            // The bag's coins plus what is already locked in buy orders for these materials: an order placed for the
            // plan is part of what the plan spends, not money that left it.
            const budget = plan.budget != null ? plan.budget : coins() + lockedTotal;
            if (document.activeElement !== els["mds-plan-budget"]) els["mds-plan-budget"].value = String(Math.round(budget));
            els["mds-plan-owned"].checked = plan.owned;
            // What N keys take: each input at the recipe cut by artisan, the tea by craft time; what to buy is the need
            // beyond what is owned (or all of it, with owned materials not counted) at ask; coins are needed as they are.
            const rowsFor = keys => {
                const crafts = Math.ceil(keys / perCraft); const rows = []; let cost = lockedTotal; const unpriced = [];
                for (const i of r.inputs) {
                    const o = ord[i.item] || none, coming = o.qty + o.unclaimed;
                    const need = Math.ceil(i.qty * cut * crafts); const owned = i.item === "/items/coin" ? 0 : (plan.owned ? held(i.item, 0) : 0); const buy = Math.max(0, need - owned - coming);
                    const ask = i.item === "/items/coin" ? 1 : askOf(i.item); const c = ask != null ? buy * ask : null;
                    if (ask == null && buy > 0) unpriced.push(i.item); if (c != null) cost += c;
                    rows.push({ item: i.item, perKey: i.qty * cut / perCraft, need, owned: i.item === "/items/coin" ? coins() : held(i.item, 0), ordered: coming, buy, ask, cost: c });
                }
                if (art && art.tea) { const o = ord[art.tea] || none, coming = o.qty + o.unclaimed; const need = Math.ceil(crafts * (art.seconds || 10) / (art.teaSeconds || 300)); const owned = plan.owned ? held(art.tea, 0) : 0; const buy = Math.max(0, need - owned - coming); const ask = askOf(art.tea); const c = ask != null ? buy * ask : null; if (c != null) cost += c; rows.push({ item: art.tea, perKey: (art.seconds || 10) / (art.teaSeconds || 300) / perCraft, need, owned: held(art.tea, 0), ordered: coming, buy, ask, cost: c, tea: true }); }
                return { crafts, rows, cost, unpriced };
            };
            let want = plan.qty, mode = "wanted";
            if (want == null) {
                // Most keys the budget buys: cost is monotone in keys, so search.
                mode = "budget"; let lo = 0, hi = 100000;
                if (rowsFor(1).cost > budget || rowsFor(1).unpriced.length) hi = 0;
                while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); const t = rowsFor(mid); if (t.cost <= budget && !t.unpriced.length) lo = mid; else hi = mid - 1; }
                want = lo;
            }
            const { crafts, rows, cost: total, unpriced } = rowsFor(Math.max(want, 0));
            lastPlanRows = rows;
            els["mds-plan"].innerHTML = rows.map(x => `<tr><td class="k">${itemLink(x.item)}${x.tea ? "<small>artisan tea, by craft time</small>" : ""}</td><td>${x.item === "/items/coin" ? fmtCoins(x.perKey) : x.perKey.toFixed(x.perKey >= 10 ? 1 : 3)}</td><td>${x.item === "/items/coin" ? fmtCoins(x.need) : fmtQ(x.need)}</td><td>${x.item === "/items/coin" ? fmtCoins(x.owned) : fmtQ(x.owned)}${x.ordered ? `<small translate="no">${esc(t("+{n} on order", { n: fmtQ(x.ordered) }))}</small>` : ""}</td><td>${x.buy > 0 ? (x.item === "/items/coin" ? fmtCoins(x.buy) : fmtQ(x.buy)) : "–"}</td><td>${x.item === "/items/coin" ? "–" : coinsOr(x.ask, "no ask")}</td><td>${x.buy > 0 && x.cost != null ? fmtCoins(x.cost) : "–"}</td><td class="mds-acts mds-acts-plan">${x.item !== "/items/coin" && x.buy > 0 && !(ref.items[x.item] && ref.items[x.item].tradable === false) ? `<button class="mds-act" data-act="buy" data-item="${esc(x.item)}" data-qty="${x.buy}" title="${esc(t("Opens the game's buy window with {n} filled in", { n: fmtQ(x.buy) }))}">Buy</button>` : (x.item !== "/items/coin" ? (x.ordered ? "<small>on order</small>" : "<small>enough owned</small>") : "")}</td></tr>`).join("");
            // Cost per key at ask (everything bought now) beside the key's own ask.
            let perKeyCost = 0, perKeyOk = true;
            for (const i of r.inputs) { const p = i.item === "/items/coin" ? 1 : askOf(i.item); if (p == null) { perKeyOk = false; break; } perKeyCost += p * i.qty * cut / perCraft; }
            if (perKeyOk && art && art.tea) { const tp = askOf(art.tea); if (tp != null) perKeyCost += tp * (art.seconds || 10) / (art.teaSeconds || 300) / perCraft; }
            const keyAsk = askOf(plan.key);
            const over = total - budget;
            const keyName = itemName(plan.key), craftsText = t(crafts === 1 ? "{n} craft" : "{n} crafts", { n: crafts.toLocaleString() });
            const unpricedText = unpriced.length ? " " + t("({items} unpriced)", { items: unpriced.map(itemName).join(", ") }) : "";
            const head = mode === "budget"
                ? (want > 0 ? t("A budget of {budget} buys {n} {key} ({crafts}) for {total}", { budget: fmtCoins(budget), n: want.toLocaleString(), key: keyName, crafts: craftsText, total: fmtCoins(total) }) : t("A budget of {budget} does not cover one {key}", { budget: fmtCoins(budget), key: keyName }) + unpricedText)
                : t("{n} {key} = {crafts}, {total} to buy", { n: want.toLocaleString(), key: keyName, crafts: craftsText, total: fmtCoins(total) }) + ", " + (over > 0 ? t("{over} over the budget of {budget}", { over: fmtCoins(over), budget: fmtCoins(budget) }) : t("within the budget of {budget}", { budget: fmtCoins(budget) })) + unpricedText;
            lastPlanWant = want;
            els["mds-plan-sum"].setAttribute("translate", "no");
            els["mds-plan-sum"].textContent = `${head}${lockedTotal > 0 ? " (" + t("{n} of it in buy orders", { n: fmtCoins(lockedTotal) }) + ")" : ""}, ${art ? t("artisan {pct}", { pct: (art.rate * 100).toFixed(1) + "%" }) : t("no artisan tea slotted")}. ${t("Crafting cost {cost} per key at ask", { cost: perKeyOk ? fmtCoins(perKeyCost) : "?" })}${keyAsk != null ? " " + t("against {ask} to buy a key", { ask: fmtCoins(keyAsk) }) + ` (${perKeyOk ? (perKeyCost < keyAsk ? t("crafting saves {n}", { n: fmtCoins(keyAsk - perKeyCost) }) : t("buying saves {n}", { n: fmtCoins(perKeyCost - keyAsk) })) : "?"})` : ""}.`;
        }
        function renderKeys() {
            const M = getMoney();
            renderPlan();
            const keyRows = Object.entries(M.keys).sort((a, b) => b[1].used - a[1].used);
            els["mds-keys"].innerHTML = keyRows.map(([h, k]) => `<tr><td class="k">${itIcon(h)}</td><td>${fmtQ(k.held)}</td><td>${fmtQ(k.crafted)}${k.craftedByLog ? `<small> loot log${k.craftedWatched !== k.crafted ? `, ${fmtQ(k.craftedWatched)} watched` : ""}</small>` : ""}</td><td>${k.bought ? `${fmtQ(k.bought)} @ ${fmtCoins(k.boughtAvg)}` : "–"}</td><td>${k.dropped || "–"}</td><td>${fmtQ(k.used)}${k.usedByLog ? `<small> loot log, one per chest${k.usedWatched !== k.used ? `, ${fmtQ(k.usedWatched)} watched` : ""}</small>` : ""}</td><td>${coinsOr(k.costPerKey, "?")}<small> ${esc(k.costBasis)}</small></td><td>${fmtCoins(k.usedCost)}${k.usedFallback ? `<small> ${k.usedFallback} at ${esc(k.fallbackBasis || "?")}</small>` : ""}</td><td>${fmtQ(k.baseline)}</td><td>${lifetimeCrafted(h) || "–"}<small>loot log</small></td></tr>`).join("") || `<tr><td colspan="10" class="t">No keys seen yet.</td></tr>`;
            const mats = Object.values(M.materials).sort((a, b) => (b.boughtCoins + b.consumedCost) - (a.boughtCoins + a.consumedCost));
            els["mds-mats"].innerHTML = mats.map(m => `<tr><td class="k">${itIcon(m.item)}</td><td class="t">${m.recipes.map(r => esc(shortAction(r))).join(", ")} ×${m.perCraft}</td><td>${m.bought ? fmtQ(m.bought) : "–"}</td><td>${m.bought ? fmtCoins(m.boughtCoins / m.bought) : "–"}</td><td>${m.bought ? fmtCoins(m.boughtCoins) : "–"}</td><td>${m.consumed ? `${fmtQ(m.consumed)} (${fmtCoins(m.consumedCost)})` : "–"}</td><td>${fmtQ(m.held)}${m.avg != null ? `<small> @ ${fmtCoins(m.avg)}</small>` : ""}</td><td>${m.baseline ? fmtQ(m.baseline) : "–"}</td></tr>`).join("") || `<tr><td colspan="8" class="t">No key recipes loaded yet.</td></tr>`;
            els["mds-keysnote"].textContent = "Cost per key = the average of the key crafts this record has seen (materials at their purchase price, plus the recipe's coins); until one is seen, the recipe at the materials' purchase prices (asks for materials never bought) with every input cut by the game's artisan rate (tea × Guzzling Pouch, as the game reports it) plus the tea's share of the craft time, and the key's own ask only when a material has no price at all. Keys held before the record began are priced the same way. Used at cost charges each live clear the exact lot it took; offline and older clears use the craft average. At start = held when the record began, priced at ask then.";
        }
        function renderLoot() {
            const M = getMoney();
            const lootRows = M.rows.filter(r => r.kind === "loot" || r.kind === "container");
            els["mds-loot"].innerHTML = lootRows.map(r => `<tr><td class="k">${itemLink(r.item)}${r.kind === "container" ? `<small> opened ${r.opened}</small>` : ""}</td><td>${fmtQ(r.gained)}${r.redeemed ? `<small> ${r.redeemed} redeemed</small>` : ""}</td><td>${r.sold ? fmtQ(r.sold) : "–"}</td><td>${r.sold ? fmtCoins(r.soldNet) : "–"}</td><td>${fmtQ(r.held)}</td><td>${r.holdover ? fmtQ(r.holdover) : "–"}</td><td>${r.listed || "–"}</td><td>${r.kept || "–"}</td><td>${coinsOr(r.heldValue, "no bid")}</td><td class="mds-acts">${r.bag > 0 && !(ref.items[r.item] && ref.items[r.item].tradable === false) ? `<button class="mds-act" data-act="market" data-item="${esc(r.item)}" title="Open this item in the marketplace">Sell</button>` : ""}${r.bag > 0 || r.kept > 0 ? `<button class="mds-act" data-act="keep" data-item="${esc(r.item)}" data-kept="${r.kept}">Keep…</button>` : ""}</td></tr>`).join("") || `<tr><td colspan="10" class="t">No loot opened yet.</td></tr>`;
            const tok = Object.entries(M.tokens);
            els["mds-tokens"].innerHTML = tok.map(([h, t]) => `<tr><td class="k">${itIcon(h)}</td><td>${fmtQ(t.gained)}</td><td>${t.redeemed ? fmtQ(t.redeemed) : "–"}</td><td>${Object.entries(t.received).map(([i, q]) => `${q} ${it(i)}`).join(", ") || "–"}</td><td>${fmtQ(t.held)}</td><td>${t.holdover ? fmtQ(t.holdover) : "–"}</td><td>${t.perToken != null ? `${fmtCoins(t.perToken)}<small> via ${esc(it(t.via))}, ${fmtQ(t.viaTokens)} tokens</small>` : "<small>no shop item with a bid</small>"}</td><td>${t.heldValue != null ? `${fmtCoins(t.heldValue)}${t.holdover ? `<small> + holdover ${fmtCoins(t.holdoverValue)}</small>` : ""}` : "–"}</td><td class="mds-acts">${t.bag > 0 ? `<button class="mds-act" data-act="shop" data-item="${esc(h)}" title="Open the game's shop">Shop</button>` : ""}</td></tr>`).join("") || `<tr><td colspan="9" class="t">No tokens yet.</td></tr>`;
            const sup = [];
            for (const [h, k] of Object.entries(M.keys)) if (k.held > 0 || k.used > 0) sup.push({ item: h, kind: "key", held: k.held, cost: k.costPerKey, used: `${k.used} used` });
            for (const [h, c] of Object.entries(M.consumables)) if (c.held > 0 || c.used > 0) sup.push({ item: h, kind: "consumable", held: c.held, cost: c.avg, used: `${c.used} used${c.offline ? ` (${c.offline} offline)` : ""}${c.unknown ? ` · ${c.unknown} unpriced` : ""}` });
            for (const m of Object.values(M.materials)) if (m.held > 0) sup.push({ item: m.item, kind: "key material", held: m.held, cost: m.avg, used: m.consumed ? `${m.consumed} in crafts` : "–" });
            for (const k of M.kept) sup.push({ item: k.item, kind: "kept loot", held: k.qty, cost: k.bidNow, used: `${k.held} in the bag` });
            sup.sort((a, b) => (b.held * (b.cost || 0)) - (a.held * (a.cost || 0)));
            els["mds-supplies"].innerHTML = sup.map(r => `<tr><td class="k">${itIcon(r.item)}</td><td class="t">${r.kind}</td><td>${fmtQ(r.held)}</td><td>${coinsOr(r.cost, "?")}</td><td>${r.cost != null ? fmtCoins(r.held * r.cost) : "?"}</td><td class="t">${r.used}</td></tr>`).join("") || `<tr><td colspan="6" class="t">Nothing on hand.</td></tr>`;
            const miss = M.rows.filter(r => r.missing > 0 && (r.kind === "loot" || r.kind === "container"));
            els["mds-missing"].innerHTML = miss.map(r => {
                const status = r.acceptedQty >= r.missing ? `accepted ${fmtQ(r.acceptedQty)}` : r.review ? (r.bidNow == null ? "review: no bid now" : `review: bid moved ${Math.round(r.drift * 100)}%`) : "valued at bid now";
                const act = r.remaining > 0 && r.netBid != null ? `<button class="mds-act" data-act="accept" data-item="${esc(r.item)}" data-qty="${r.remaining}" data-unit="${r.netBid}" data-bid="${r.bidNow}" data-open="${r.bidAtOpen || ""}" data-tax="${M.tax.rate}">Accept ${fmtCoins(r.remaining * r.netBid)}</button>` : "";
                return `<tr class="${r.review ? "review" : ""}"><td class="k">${itemLink(r.item)}</td><td>${fmtQ(r.missing)}${r.acceptedQty ? `<small> ${r.acceptedQty} accepted</small>` : ""}</td><td>${coinsOr(r.bidAtOpen)}</td><td>${coinsOr(r.bidNow, "none")}</td><td>${fmtCoins(r.missingValue)}</td><td class="t">${status}</td><td>${act}</td></tr>`;
            }).join("") || `<tr><td colspan="7" class="t">Everything gained is sold, held, listed or kept.</td></tr>`;
            els["mds-lootnote"].textContent = `Loot = what this record saw come out of a chest or a token redemption. Held = in the bag now; Listed = on your sell orders. No longer held = gained − sold − opened − held − listed − kept, valued at the current bid less ${(M.tax.rate * 100).toFixed(1)}% tax; a bid that moved more than 50% since opening (or no bid) is marked for review and left out of the totals until accepted. Accepting freezes that value as a recorded event.`;
        }
        // Chests held before the record began (the baseline stock), shown as their own block.
        const holdover = () => { const base = state.timeline.find(e => e.kind === "baseline"); const rows = ((base && base.chests) || []).filter(c => c.qty > 0); return { rows, total: rows.reduce((a, c) => a + c.qty, 0) }; };
        const lifetimeCrafted = key => [...state.lootLog.values()].filter(e => ref.keyActions[e.action] && ref.keyActions[e.action].outputs.some(o => o.item === key)).reduce((s, e) => s + (e.drops[key] || e.count), 0);
        // The review list: review events not yet dismissed, plus the loot rows whose value needs a decision.
        function renderReview() {
            const done = new Set(Array.isArray(state.meta.reviewDone) ? state.meta.reviewDone : []);
            const evs = state.timeline.filter(e => e.kind === "review" && !done.has(e.id)).slice(-100).reverse();
            const M = getMoney(); const lootReview = M.rows.filter(r => r.review);
            const detail = e => { const o = {}; for (const [k, v] of Object.entries(e)) if (!["id", "kind", "at", "clock", "src", "v", "reason", "fromRecord"].includes(k)) o[k] = v; const t = JSON.stringify(o); return t.length > 160 ? t.slice(0, 157) + "…" : t; };
            const rows = [];
            if (lootReview.length) rows.push(`<tr><td class="t">now</td><td>${lootReview.length} loot item${lootReview.length === 1 ? "" : "s"} no longer held with a bid that moved more than 50% since the open: value ${lootReview.length === 1 ? "it" : "them"} on the Loot tab</td><td class="d">${lootReview.map(r => itIcon(r.item) + " ×" + fmtQ(r.remaining)).join(", ")}</td><td></td></tr>`);
            for (const e of evs) rows.push(`<tr><td class="t">${fmtTime(e.at)}</td><td>${esc(e.reason || "")}${e.fromRecord ? ` <small>from ${esc(String(e.fromRecord))}</small>` : ""}</td><td class="d"><code title="${esc(JSON.stringify(e))}">${esc(detail(e))}</code></td><td><button class="mds-act" data-dismiss="${esc(e.id)}" title="Hide this item">Done</button></td></tr>`);
            els["mds-review"].innerHTML = rows.join("") || `<tr><td colspan="4" class="t">Nothing to review.</td></tr>`;
        }
        function renderXp() {
            const now = serverNow(); const S = xpSummary(now);
            if (!S) { els["mds-xpcards"].innerHTML = ""; els["mds-xp-skills"].innerHTML = `<tr><td colspan="5" class="t">Waiting for the game's skill totals.</td></tr>`; els["mds-xp-days"].innerHTML = ""; return; }
            const cards = [
                card("XP since record", fmtCoins(S.total), [`Since ${fmtTime(S.startAt)}`, S.today ? `Today ${fmtCoins(S.today.total)}` : "", S.basis && /Loot & XP Log/.test(S.basis) ? `Start: ${esc(S.basis)}` : ""]),
                card("XP / h", S.perHour != null ? fmtCoins(S.perHour) : "–", ["Over active time", S.today && S.today.activeMs > 0 ? `Today ${fmtCoins(S.today.total / (S.today.activeMs / 3600e3))}` : ""]),
                card("Active time", fmtHm(S.activeMs), [S.offlineMs ? `Offline ${fmtHm(S.offlineMs)}` : "", S.today ? `Today ${fmtHm(S.today.activeMs)}` : ""]),
            ];
            els["mds-xpcards"].innerHTML = sortCards("xpcards", cards).join("");
            const skills = Object.entries(S.since).sort((a, b) => b[1] - a[1]);
            els["mds-xp-skills"].innerHTML = skills.map(([h, v]) => `<tr><td class="k">${skillIcon(h)}${esc(skillName(h))}</td><td>${fmtCoins(v)}</td><td>${S.today && S.today.bySkill[h] ? fmtCoins(S.today.bySkill[h]) : "–"}</td><td>${S.activeMs > 0 ? fmtCoins(v / (S.activeMs / 3600e3)) : "–"}</td><td>${pct(v, S.total)}</td></tr>`).join("") || `<tr><td colspan="5" class="t">No XP since the record began.</td></tr>`;
            // Abilities that gained since the record, with the books the next level takes and their price at ask.
            const abRows = S.abilities.filter(a => a.since > 0).map(a => { const toNext = toNextLevel(a.xp, a.level); const book = ref.books[a.hrid] || null; const need = book && toNext != null ? Math.ceil(toNext / book.xp) : null; const ask = book ? askOf(book.item) : null; return { ...a, need, price: need != null && ask != null ? need * ask : null }; }).sort((x, y) => y.since - x.since);
            const abTotal = abRows.reduce((t, a) => t + a.since, 0);
            const fmtAb = v => Math.abs(v) < 1000 ? (Math.round(v * 10) / 10).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : fmtCoins(v);
            els["mds-xp-abilities"].innerHTML = abRows.map(a => `<tr><td class="k">${abilityIcon(a.hrid)}${esc(abilityName(a.hrid))}</td><td>${a.level != null ? a.level : "–"}</td><td>${fmtAb(a.since)}</td><td>${S.activeMs > 0 ? fmtAb(a.since / (S.activeMs / 3600e3)) : "–"}</td><td>${pct(a.since, abTotal)}</td><td>${a.need != null ? fmtQ(a.need) : "–"}</td><td>${a.price != null ? fmtCoins(a.price) : a.need != null ? "<small>no ask</small>" : "–"}</td></tr>`).join("") || `<tr><td colspan="7" class="t">${S.abilStartAt ? `No ability XP since ${fmtTime(S.abilStartAt)}.` : "Waiting for the game's ability totals."}</td></tr>`;
            if (S.abilStartAt && S.startAt && S.abilStartAt - S.startAt > 60e3) els["mds-xp-abilities"].insertAdjacentHTML("beforeend", `<tr><td colspan="7" class="t">Ability XP counted since ${fmtTime(S.abilStartAt)}, when this build first saw the abilities; the Loot &amp; XP Log has no ability XP to back that to the record start.</td></tr>`);
            const skillList = by => Object.entries(by || {}).sort((a, b) => b[1] - a[1]).map(([h, v]) => `${fmtCoins(v)} ${esc(skillName(h))}`).join(", ") || "–";
            els["mds-xp-days"].innerHTML = S.days.map(d => `<tr><td class="t">${fmtDate(Date.parse(d.day + "T12:00:00Z"))}</td><td>${fmtCoins(d.total)}</td><td>${fmtHm(d.activeMs)}${d.offlineMs ? `<small> ${fmtHm(d.offlineMs)} offline</small>` : ""}</td><td>${d.activeMs > 0 ? fmtCoins(d.total / (d.activeMs / 3600e3)) : "–"}</td><td class="d">${skillList(d.bySkill)}</td></tr>`).join("") || `<tr><td colspan="5" class="t">No days yet.</td></tr>`;
        }
        function renderLifetime() {
            const all = [...state.lootLog.values()];
            const endOf = e => isRunning(e) ? serverNow() : e.end;
            const groups = {};
            for (const e of all) {
                if (!(ref.dungeons[e.action] || /\/combat\//.test(e.action))) continue;
                const k = `${e.action}|${e.tier}`; const g = groups[k] || (groups[k] = { action: e.action, tier: e.tier, n: 0, clears: 0, chests: {}, ms: 0, xp: {}, from: e.start, to: endOf(e) });
                g.n++; g.clears += e.count; g.ms += Math.max(0, endOf(e) - e.start); g.from = Math.min(g.from, e.start); g.to = Math.max(g.to, endOf(e));
                for (const [h, q] of Object.entries(e.drops)) if (ref.chestItems[h.split("::")[0]]) g.chests[h.split("::")[0]] = (g.chests[h.split("::")[0]] || 0) + q;
                for (const [sk, v] of Object.entries(e.xp)) g.xp[sk] = (g.xp[sk] || 0) + v;
            }
            const xpSumAll = x => Object.values(x || {}).reduce((s, v) => s + v, 0);
            const rows = Object.values(groups).sort((a, b) => b.to - a.to);
            els["mds-life-dungeons"].innerHTML = rows.map(g => `<tr><td class="k"><span title="${esc((ref.dungeons[g.action] || {}).name || shortAction(g.action))}">${zoneLabel(g.action, g.tier || null)}</span></td><td>${g.n}</td><td>${fmtQ(g.clears)}</td><td class="d">${Object.entries(g.chests).map(([h, q]) => `${fmtQ(q)} ${/refinement/.test(h) ? "Refine" : "Chest"}`).join(", ") || "–"}</td><td>${fmtHm(g.ms)}</td><td>${g.clears ? fmtDur(g.ms / g.clears) : "–"}</td><td class="d">${Object.entries(g.xp).sort((a, b) => b[1] - a[1]).map(([sk, v]) => `${fmtCoins(v)} ${esc(sk.split("/").pop())}`).join(", ") || "–"}</td><td>${g.ms > 0 ? fmtCoins(xpSumAll(g.xp) / (g.ms / 3600e3)) : "–"}</td><td class="t">${fmtDate(g.from)}</td><td class="t">${fmtDate(g.to)}</td></tr>`).join("") || `<tr><td colspan="10" class="t">No sessions yet: open the game's Loot &amp; XP Log once.</td></tr>`;
            // Key crafts, with what this PC's Toolasha history shows bought of the recipe's materials (a partial view
            // when another PC bought some of them).
            const craftGroups = {};
            for (const e of all) { const r = ref.keyActions[e.action]; if (!r) continue; const key = (r.outputs[0] || {}).item; if (!key) continue; const g = craftGroups[key] || (craftGroups[key] = { key, action: e.action, n: 0, crafted: 0, essence: 0, from: e.start, to: e.end }); g.n++; g.crafted += e.drops[key] || e.count; g.essence += Object.entries(e.drops).filter(([h]) => /essence/.test(h)).reduce((s, [, q]) => s + q, 0); g.from = Math.min(g.from, e.start); g.to = Math.max(g.to, e.end); }
            const buys = marketHistoryRows().filter(l => !l.isSell);
            const devices = new Set(marketHistoryRows().map(l => String(l.src || "").split("+")).flat().filter(Boolean)).size;
            els["mds-life-keys"].innerHTML = Object.values(craftGroups).sort((a, b) => b.to - a.to).map(g => {
                // Prices from this PC's buys (an average paid is a price, whatever share of the quantity was bought here),
                // quantities from the recipe at the current artisan rate: the history has no consumption per craft.
                const art = artisanOf(g.action); const cut = art ? 1 - art.rate : 1;
                const recipe = ref.keyActions[g.action];
                const mats = recipe.inputs.filter(i => i.item !== "/items/coin").map(i => { const b = buys.filter(l => l.item === i.item); const qty = b.reduce((s, l) => s + l.qty, 0), coins = b.reduce((s, l) => s + l.qty * l.price, 0); const paid = qty ? coins / qty : null; const price = paid != null ? paid : askOf(i.item); return { item: i.item, qty, coins, paid, price, perKey: i.qty * cut, needed: g.crafted * i.qty * cut }; });
                const coinsIn = ((recipe.inputs.find(i => i.item === "/items/coin") || {}).qty || 0) * cut;
                const priced = mats.every(m => m.price != null);
                // Lifetime keys are priced at the recipe cut by the game's own artisan rate: that rate is the expected
                // consumption of every key ever crafted (the game shows it as "0.9" of each fragment), where the few
                // crafts this record has watched are a sample of it (2026-11-01: three chest-key crafts happened to
                // spare one fragment each, 3.00 against an expected 3.54, and the measured figure understated the
                // lifetime cost by 15%). The record's own keys still carry what their crafts really consumed.
                let cost = null, basis = "";
                if (priced) {
                    cost = mats.reduce((s, m) => s + m.price * m.perKey, 0) + coinsIn;
                    if (art && art.tea) { const tp = ledgerAvg(art.tea) != null ? ledgerAvg(art.tea) : askOf(art.tea); if (tp != null) cost += tp * art.seconds / art.teaSeconds; }
                    const asksN = mats.filter(m => m.paid == null && m.price != null).length;
                    const units = mats.reduce((s, m) => s + m.perKey, 0);
                    basis = `recipe at the game's artisan rate${art ? ` (${(art.rate * 100).toFixed(1)}%: ${units.toFixed(2)} materials per key)` : " (no artisan)"} at your average paid price${asksN ? ` (${asksN} at ask)` : ""}${art && art.tea ? " + tea" : ""}`;
                }
                const asks = 0;
                const coverage = mats.reduce((s, m) => s + m.needed, 0) > 0 ? mats.reduce((s, m) => s + Math.min(m.qty, m.needed), 0) / mats.reduce((s, m) => s + m.needed, 0) : 0;
                return `<tr><td class="k">${itIcon(g.key)}</td><td>${g.n}</td><td>${fmtQ(g.crafted)}</td><td>${g.essence || "–"}</td><td class="t">${fmtDate(g.from)}</td><td class="t">${fmtDate(g.to)}</td><td class="d">${mats.map(m => `${fmtQ(m.qty)} ${it(m.item)}${m.paid != null ? ` @ ${fmtCoins(m.paid)}` : " (none here)"}`).join(", ")}<small>${Math.round(coverage * 100)}% of what these crafts consumed is in the merged history (${devices} source${devices === 1 ? "" : "s"})</small></td><td>${cost != null ? `${fmtCoins(cost)}<small>${esc(basis)}</small>` : "–"}</td></tr>`;
            }).join("") || `<tr><td colspan="8" class="t">No key crafts in the log yet.</td></tr>`;
            {
                // Per combat skill: each session counts for the skill it trained, the combat skill with the most XP in it,
                // with the session's time and that skill's XP; XP/h over that time (the action's running time, offline
                // included), and the dungeon where its rate was best. Time spent levelling another skill never dilutes
                // a rate (2026-11-01: Magic's T2D4 rate had been dragged under a short Infernal Abyss stint by Attack
                // sessions in which Magic picked up a little XP).
                const per = {};
                for (const e of all) {
                    if (!(ref.dungeons[e.action] || /\/combat\//.test(e.action))) continue;
                    const ms = Math.max(0, endOf(e) - e.start); if (!(ms > 0)) continue;
                    let top = null, topXp = 0;
                    for (const [sk, v] of Object.entries(e.xp || {})) { if (!(v > 0) || sk === "/skills/total_level" || (ref.skills[sk] && !ref.skills[sk].combat)) continue; if (v > topXp) { top = sk; topXp = v; } }
                    if (!top) continue;
                    const p = per[top] || (per[top] = { skill: top, n: 0, ms: 0, xp: 0, from: e.start, to: endOf(e), by: {} });
                    p.n++; p.ms += ms; p.xp += topXp; p.from = Math.min(p.from, e.start); p.to = Math.max(p.to, endOf(e));
                    const k = `${e.action}|${e.tier}`; const b = p.by[k] || (p.by[k] = { action: e.action, tier: e.tier, ms: 0, xp: 0 }); b.ms += ms; b.xp += topXp;
                }
                const rows = Object.values(per).sort((a, b) => b.xp - a.xp);
                els["mds-life-skills"].innerHTML = rows.map(p => {
                    const best = Object.values(p.by).filter(b => b.ms >= 3600e3).sort((a, b) => b.xp / b.ms - a.xp / a.ms)[0] || null;
                    return `<tr><td class="k">${skillIcon(p.skill)}${esc(skillName(p.skill))}</td><td>${p.n}</td><td>${fmtHm(p.ms)}</td><td>${fmtCoins(p.xp)}</td><td>${fmtCoins(p.xp / (p.ms / 3600e3))}</td><td class="d">${best ? `${fmtCoins(best.xp / (best.ms / 3600e3))} in ${zoneLabel(best.action, best.tier || null)}<small> ${fmtHm(best.ms)}</small>` : "–"}</td><td class="t">${fmtDate(p.from)}</td><td class="t">${fmtDate(p.to)}</td></tr>`;
                }).join("") || `<tr><td colspan="8" class="t">No combat sessions in the log yet: open the game's Loot &amp; XP Log once.</td></tr>`;
            }
            els["mds-lifenote"].setAttribute("translate", "no");
            els["mds-lifenote"].textContent = `${t("The game's own log (server-side, complete across devices), merged with Toolasha's saved copy: {n} sessions", { n: all.length })}${all.length ? " " + t("from {date}", { date: fmtDate(Math.min(...all.map(e => e.start))) }) : ""}. ${t("Time in sessions is the log's start-to-end, so XP / h is per hour of the action running, offline included. Market history is per device, merged here by listing id from this PC's Toolasha store and any file merged on the Data tab ({n} listings); the cost per key takes the average paid price in that history (a price holds whatever share was bought on one PC) with recipe quantities at your current artisan rate, since the log has no consumption per craft; no lifetime income is shown until the records from both PCs are merged (import, milestone 5).", { n: state.marketHistory.size })}`;
        }
        function renderChests() {
            const M = getMoney();
            const otherCard = M.loot.other.opened ? [card("Other boxes (not dungeon loot)", M.loot.other.opened, `${Object.entries(M.loot.other.kinds).map(([h, q]) => `${q} ${it(h)}`).join(" · ")} · value at bid ${fmtCoins(M.loot.other.value)}${M.loot.other.coins ? ` · coins ${fmtCoins(M.loot.other.coins)}` : ""} · kept out of the loot and the net`)] : [];
            const cards = otherCard.concat(Object.entries(M.chests).sort((a, b) => b[1].opened - a[1].opened).map(([h, c]) => card(icon(h) + chestName(h), c.opened, `value at bid ${fmtCoins(c.value)}${c.tokenValue ? ` (tokens ${fmtCoins(c.tokenValue)})` : ""}${c.coins ? ` · coins ${fmtCoins(c.coins)}` : ""}${c.keyItem ? ` · keys ${fmtCoins(c.keyCost)}` : ""}${Object.keys(c.counted).length ? ` · ${Object.entries(c.counted).map(([i, q]) => `${q} ${it(i)}`).join(", ")} counted` : ""}`)));
            const bag = Object.keys(ref.chestItems).map(h => [h, held(h, 0)]).filter(([, q]) => q > 0);
            els["mds-chestcards"].innerHTML = sortCards("chestcards", [...cards, ...(bag.length ? [card("In the bag now", bag.reduce((a, [, q]) => a + q, 0), bag.map(([h, q]) => `${q} ${it(h)}`).join(" · "))] : [])]).join("");
            const tokenRate = (ev, g) => (M.loot.tokenRates[ev.id] && M.loot.tokenRates[ev.id][g.item]) || 0;
            const opens = state.timeline.filter(e => e.kind === "open" && e.at >= (state.meta.recordStart || 0)).slice(-300).reverse();
            els["mds-chests"].innerHTML = opens.map(ev => `<tr class="${M.loot.otherIds.has(ev.id) ? "cancelled" : ""}"><td class="t">${fmtTime(ev.at)}</td><td class="k">${itIcon(ev.chest)}${M.loot.otherIds.has(ev.id) ? "<small>not dungeon loot</small>" : ""}</td><td>${ev.count}</td><td class="d">${(ev.gains || []).map(g => `${g.qty} ${it(g.item)}${(g.counted || isCounted(g.item)) ? " (counted)" : tokenRate(ev, g) ? ` (${fmtCoins(tokenRate(ev, g))} each)` : (g.item !== "/items/coin" && !g.bid) ? " (no bid)" : ""}`).join(", ")}</td><td>${fmtCoins((ev.gains || []).filter(g => g.item !== "/items/coin" && !g.counted && !isCounted(g.item)).reduce((s, g) => s + (g.bid ? g.bid * g.qty : tokenRate(ev, g) * g.qty), 0))}</td><td>${ev.coinsGained ? fmtCoins(ev.coinsGained) : "–"}</td><td>${ev.keyCost && ev.keyCost.unitCost != null ? `${fmtCoins(ev.keyCost.unitCost * ev.count)}<small> ${esc(ev.keyCost.basis || "")}</small>` : "–"}</td></tr>`).join("") || `<tr><td colspan="7" class="t">No chest opened yet.</td></tr>`;
            els["mds-chestsnote"].textContent = "Newest first. Value at bid = each item's highest bid when the chest was opened; a dungeon token is worth the best bid per token among the shop items it buys (an opening from before 0.1.2 takes those bids from the nearest opening that recorded them); counted items (cowbells) and unpriced items carry no value. Key cost = the chest key's lot cost; a basis of ask means the key was held before the record began.";
        }
        // Sessions the game logged (dungeons and key crafts), newest first, beside what this record counted in the
        // same span: clears from the runs, chests from the clears plus offline blocks inside it.
        const sessionsOf = () => [...state.lootLog.values()].filter(e => ref.dungeons[e.action] || ref.keyActions[e.action] || /\/combat\//.test(e.action)).sort((a, b) => b.start - a.start);
        // The game stamps a running session's end with the time of the read. Entries saved before read times were kept
        // fall back to the latest end among game-sent entries, which is the time of the last read.
        let lastReadCache = { rev: -1, at: 0 };
        const lastGameRead = () => { if (lastReadCache.rev !== state.lootLogRev) { let m = 0; for (const x of state.lootLog.values()) if (/game/.test(String(x.source || "")) && x.end > m) m = x.end; lastReadCache = { rev: state.lootLogRev, at: m }; } return lastReadCache.at; };
        const isRunning = e => (e.readAt ? Math.abs(e.end - e.readAt) < 15e3 : Math.abs(e.end - lastGameRead()) < 15e3);
        const chestDrops = drops => Object.entries(drops || {}).filter(([h]) => ref.chestItems[h.split("::")[0]]).reduce((s, [, q]) => s + q, 0);
        function recordInSpan(d, e) {
            if (e.end <= d.summary.windowStart) return null;
            if (e.first && e.first.at >= d.summary.windowStart) {
                // Exact: both sides counted from the moment the game's log was first read for this session.
                const runs = d.runs.filter(r => r.result === "clear" && r.endAt != null && r.endAt >= e.first.at);
                return { sinceRead: e.first.at, gameClears: e.count - e.first.count, gameChests: chestDrops(e.drops) - chestDrops(e.first.drops), clears: runs.length, chests: runs.reduce((s, r) => s + (r.chests || []).reduce((a, c) => a + c.qty, 0), 0) };
            }
            const runs = d.runs.filter(r => r.startAt >= e.start - 5000 && r.startAt <= e.end);
            const clears = runs.filter(r => r.result === "clear").length;
            const chests = runs.reduce((s, r) => s + (r.chests || []).reduce((a, c) => a + c.qty, 0), 0) + d.offline.filter(b => b.from >= e.start - 5000 && b.to <= e.end + 5000).reduce((s, b) => s + b.chestTotal, 0);
            return { clears, chests, runs: runs.length, gameClears: e.count, gameChests: chestDrops(e.drops) };
        }
        const compareText = (o, e, windowStart) => {
            if (!o) return null;
            const same = o.clears === o.gameClears && o.chests === o.gameChests;
            const mine = `${o.clears} clears, ${o.chests} chests`;
            const theirs = same ? " ✓" : ` ≠ game ${o.gameClears}, ${o.gameChests}`;
            if (o.sinceRead) return `${mine} since ${fmtClock(o.sinceRead)}${theirs}`;
            if (e.start < windowStart) return `${mine} from record start`;
            return `${mine}${theirs}`;
        };
        function renderSessions(d) {
            const list = sessionsOf().slice(0, 60);
            const xpSumAll = x => Object.values(x || {}).reduce((s, v) => s + v, 0);
            els["mds-sessions"].innerHTML = list.map(e => {
                const dungeon = !!ref.dungeons[e.action] || /\/combat\//.test(e.action);
                const dropList = Object.entries(e.drops).map(([h, q]) => `${q} ${it(h.split("::")[0])}`).join(", ") || "none";
                const chestsFirst = Object.entries(e.drops).map(([h, q]) => [h.split("::")[0], q]).sort((a, b) => (ref.chestItems[b[0]] ? 1 : 0) - (ref.chestItems[a[0]] ? 1 : 0));
                const drops = ref.dungeons[e.action] || ref.keyActions[e.action]
                    ? chestsFirst.map(([h, q]) => `${q} ${ref.chestItems[h] ? (/refinement/.test(h) ? "Refine" : "Chest") : it(h)}`).join(", ") || "none"
                    : (() => { const coins = e.drops["/items/coin"] || 0; const rest = Object.entries(e.drops).filter(([h]) => h !== "/items/coin"); return `<span class="mds-flag" title="${esc(dropList)}">${coins ? fmtCoins(coins) + " coins" : ""}${coins && rest.length ? " + " : ""}${rest.length ? `${rest.reduce((a, [, q]) => a + q, 0).toLocaleString()} items, ${rest.length} kinds` : ""}</span>`; })();
                const ours = dungeon ? recordInSpan(d, e) : null;
                const text = compareText(ours, e, d.summary.windowStart);
                const off = ours && text && /≠/.test(text) && !isRunning(e);
                return `<tr class="${off ? "review" : ""}"><td class="t">${fmtTime(e.start)}</td><td class="t">${isRunning(e) ? (serverNow() - e.readAt > 600e3 ? `running at ${fmtClock(e.readAt)}` : "running") : fmtTime(e.end)}</td><td class="k"><span title="${esc((ref.dungeons[e.action] || {}).name || shortAction(e.action))}">${zoneLabel(e.action, e.tier || null)}</span></td><td>${e.count}${dungeon ? " clears" : " crafts"}</td><td class="d">${drops}</td><td>${fmtCoins(xpSumAll(e.xp))}</td><td>${text || (dungeon ? "before this record" : "–")}</td><td class="t">${esc(e.source || "")}</td></tr>`;
            }).join("") || `<tr><td colspan="8" class="t">Open the game's Loot &amp; XP Log once (Moo Pass) and its sessions appear here; Toolasha's saved history is merged at login.</td></tr>`;
            els["mds-sessionsnote"].textContent = "The game's own log, one row per action session: its count (dungeon clears, or keys crafted), its drops and XP, offline included. \"This record\" counts the clears and chests this record has for the same span; ≠ marks a difference, highlighted once the session is over. The game's count is the reference; this record only adds times and costs the log does not have.";
        }
        // Notes on a run are shown as a short label; the full sentence is the tooltip.
        const noteLabel = t => /not running/.test(t) ? "restarted mid-run" : /no end/.test(t) ? "end unknown" : /lifetime totals/.test(t) ? "XP from run ends" : t.length > 22 ? t.slice(0, 20) + "…" : t;
        // Redrawn in place: the new markup is laid over the old node by node, so only the numbers and bar widths that
        // moved change. Hover, scroll and an open dropdown survive, and the bars slide (operator, 2026-11-23: a 1 s
        // rebuild of the whole table looked janky).
        function morph(el, html) {
            const t = document.createElement("template"); t.innerHTML = html;
            const walk = (a, b) => {
                while (a.childNodes.length > b.childNodes.length) a.removeChild(a.lastChild);
                for (let i = 0; i < b.childNodes.length; i++) {
                    const x = a.childNodes[i], y = b.childNodes[i];
                    if (!x) { a.appendChild(y.cloneNode(true)); continue; }
                    if (x.nodeType !== y.nodeType || x.nodeName !== y.nodeName) { a.replaceChild(y.cloneNode(true), x); continue; }
                    if (x.nodeType === 3) { if (x.data !== y.data) x.data = y.data; continue; }
                    if (x.nodeType !== 1) continue;
                    for (const at of [...x.attributes]) if (!y.hasAttribute(at.name)) x.removeAttribute(at.name);
                    for (const at of y.attributes) if (x.getAttribute(at.name) !== at.value) x.setAttribute(at.name, at.value);
                    walk(x, y);
                }
            };
            walk(el, t.content);
        }
        // A battle message changed the meter: redraw on the next frame, once however many messages came in it.
        let meterFrame = 0;
        function meterPing() {
            if (meterFrame || document.hidden) return;
            meterFrame = requestAnimationFrame(() => { meterFrame = 0; try { renderBattleMeter(); if (open && tab === "damage") renderDamage(); } catch (error) { warn("damage meter view", error); } });
        }
        // -----------------------------------------------------------------------------------------------------------
        // Damage meter views (0.2.0): one table for the Damage tab and the block under the battle cards.
        // -----------------------------------------------------------------------------------------------------------
        const pct1 = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : "–");
        const fmtN = v => (Math.abs(v) >= 1000 ? fmtCoins(v) : String(Math.round(v || 0)));
        // Our words through t() where a line is built from parts (localize() translates whole text nodes only).
        const meterKeyName = k => k === "auto" ? t("Auto attack") : k === "bloom" ? t("Bloom") : k === "parry" ? t("Parry") : k === "thorns" ? t("Thorns and retaliation") : k === "dot:?" ? t("Damage over time") : /^dot:/.test(k) ? t("{ability} over time", { ability: abilityName(k.slice(4)) }) : /^\/abilities\//.test(k) ? abilityName(k) : k;
        const meterKeyIcon = k => { const h = /^dot:/.test(k) ? k.slice(4) : k; return /^\/abilities\//.test(h) ? abilityIcon(h) : ""; };
        const sessTotal = s => Object.values((s && s.players) || {}).reduce((a, p) => a + (p.dealt || 0), 0);
        const sessSecs = s => Math.max(1, num(s && s.combatMs) / 1000);
        // Places: a dungeon by its code (T2D4: short, and players know it; operator 2026-11-23), a planet by name, the
        // results in words ("cleared").
        const placeName = z => (z ? gameName("actionNames", z, ref.dungeons[z] ? ref.dungeons[z].name : shortAction(z).replace(/_/g, " ").replace(/^./, c => c.toUpperCase())) : t("Unknown place"));
        const meterWhere = s => (s.zone && ref.dungeons[s.zone] ? zoneLabel(s.zone, s.tier) : esc(s.zone ? `${placeName(s.zone)}${s.tier ? ` T${s.tier}` : ""}` : placeName(null)));
        const RESULT_WORDS = { clear: "cleared", fail: "failed", stop: "ended early", gap: "went quiet", interrupted: "cut short", cancelled: "cancelled", open: "in progress" };
        const resultWord = r => t(RESULT_WORDS[r] || r || "ended");
        const rejoined = s => (s.stitched ? " " + t("(rejoined after a reload)") : "");
        const meterResult = s => (s.streak ? t(s.live ? "{n} finished + this one since {time}" : "{n} finished since {time}", { n: s.runs, time: fmtClock(num(s.startAt)) })
            : s.aggregate ? t(s.runs === 1 ? "totals: {n} full run" : "totals: {n} full runs", { n: s.runs }) + (s.pieces ? ", " + t(s.pieces === 1 ? "{n} partly seen run" : "{n} partly seen runs", { n: s.pieces }) : "")
            : s.live ? (s.result ? t("{result}, closing", { result: resultWord(s.result) }) : serverNow() - num(s.lastAt) > METER_STALE_MS ? t("paused") : t("in progress")) + rejoined(s)
            : resultWord(s.result) + rejoined(s));
        const wavesText = s => (s.aggregate || s.streak ? t("{n} waves", { n: num(s.waves).toLocaleString() }) : s.firstWave === s.lastWave ? t("wave {n}", { n: s.lastWave }) : t("waves {a}–{b}", { a: s.firstWave, b: s.lastWave }));
        function meterHead(s) {
            if (!s) return "";
            const total = sessTotal(s), secs = sessSecs(s), c = s.check || {};
            return `${meterWhere(s)} · ${esc(meterResult(s))} · ${esc(wavesText(s))} · ${esc(t("{time} in combat", { time: fmtDur(num(s.combatMs)) }))} · ${esc(t("party {n} ({dps} DPS)", { n: fmtN(total), dps: Math.round(total / secs).toLocaleString() }))} · ${esc(t("checked {a} of {b} finished waves", { a: c.balanced || 0, b: c.waves || 0 }))}${c.gap ? ` · <span class="mds-flag" title="${esc(t("HP left standing or not credited, over the waves that did not check out"))}">${esc(t("{n} HP unexplained", { n: fmtN(c.gap) }))}</span>` : ""}${s.unassigned ? ` · ${esc(t("{n} not credited", { n: fmtN(s.unassigned) }))}` : ""}`;
        }
        // The battle meter's head, short (operator, 2026-11-23: the long line was too wordy): the party's damage and DPS
        // beside the title, then the place and the time in combat, and the check as a badge whose tooltip says the rest.
        function meterHeadShort(s) {
            const total = sessTotal(s), secs = sessSecs(s), c = s.check || {};
            const span = s.streak || s.aggregate ? meterResult(s) : `${wavesText(s)}${s.stitched ? ", " + t("stitched after a reload") : ""}${s.live ? "" : `, ${meterResult(s)}`}`;
            const tip = `${span}. ${t("Checked {a} of {b} finished waves: every monster seen at 0 HP and every point credited to a player.", { a: c.balanced || 0, b: c.waves || 0 })}${c.gap ? " " + t("{n} HP unexplained.", { n: fmtN(c.gap) }) : ""}${s.unassigned ? " " + t("{n} not credited.", { n: fmtN(s.unassigned) }) : ""}`;
            const ok = !c.gap && !s.unassigned;
            return { total: fmtN(total), dps: Math.round(total / secs).toLocaleString(), line: `${meterWhere(s)} · <span title="${esc(t("Time in combat the meter has counted"))}">${fmtDur(num(s.combatMs))}</span>${s.live || s.streak ? "" : ` · ${esc(meterResult(s))}`}`, badge: `<span class="mds-check${ok ? "" : " bad"}" title="${esc(tip)}">${ok ? "✓" : "!"} ${c.balanced || 0}/${c.waves || 0}</span>` };
        }
        // A player's XP/hr for the battle meter: the total, and a tooltip with each skill (and, for our own character,
        // the time to the next level from the game's own totals).
        function partyXp(name) {
            const r = (state.partyXp || {})[name]; if (!r || !(r.t > r.t0)) return null;
            const hrs = (r.t - r.t0) / 3600e3, rows = Object.entries(r.map).map(([k, v]) => ({ k, perHour: (v - (r.base[k] || 0)) / hrs })).filter(x => x.perHour > 0).sort((a, b) => b.perHour - a.perHour);
            const total = rows.reduce((a, x) => a + x.perHour, 0); if (!(total > 0)) return null;
            const me = name === state.characterName;
            const tip = [t("XP per hour since {time} ago", { time: runwayText((r.t - r.t0) / 1000) })].concat(rows.map(x => {
                let line = `${skillName(x.k)}: ${fmtCoins(x.perHour)}`;
                if (me && state.lifetimeXp[x.k] != null) { const left = toNextLevel(state.lifetimeXp[x.k], state.levels[x.k]); if (left != null && left > 0) line += ` · ${t("next level in {time}", { time: runwayText(left / x.perHour * 3600) })}`; }
                return line;
            })).join(String.fromCharCode(10));
            return { total, tip };
        }
        // The meter's columns (operator, 2026-11-23): drag a header onto another to reorder, click one to sort (again
        // to reverse, a third time for the usual order, most damage first), and switch any off in Settings. The player
        // column stays first. One choice for the battle meter and the Damage tab, kept per browser.
        const METER_COLS = [
            { k: "dealt", label: "Damage", left: true, val: p => p.dealt, cell: (p, c) => `<td class="mds-mbar"><span class="fill" style="width:${c.top > 0 ? (100 * p.dealt / c.top).toFixed(1) : 0}%"></span><span class="v">${fmtN(p.dealt)}</span></td>` },
            { k: "share", label: "Share", val: p => p.dealt, cell: (p, c) => `<td class="n">${pct1(p.dealt, c.total)}</td>` },
            { k: "dps", label: "DPS", val: p => p.dealt, cell: (p, c) => `<td class="n">${Math.round(p.dealt / c.secs).toLocaleString()}</td>` },
            { k: "taken", label: "Taken", val: p => p.taken, cell: p => `<td class="n">${fmtN(p.taken)}</td>` },
            { k: "healDone", label: "Healing done", title: "What this player's heal abilities and Life Drain restored", val: p => p.healDone, cell: p => `<td class="n">${fmtN(p.healDone)}</td>` },
            { k: "healed", label: "Healed", title: "Every HP this player regained: heals, Life Drain, regeneration, food and passives", val: p => p.healed, cell: p => `<td class="n">${fmtN(p.healed)}</td>` },
            { k: "deaths", label: "Deaths", val: p => p.deaths || 0, cell: p => `<td class="n">${p.deaths || 0}</td>` },
            { k: "xp", label: "XP/hr", title: "Experience per hour, all skills; hover a value for each skill", xpOnly: true, val: p => (partyXp(p.name) || { total: 0 }).total, cell: p => { const x = partyXp(p.name); return x ? `<td class="n" data-mds-tip="${esc(x.tip)}">${fmtCoins(x.total)}</td>` : `<td class="n">–</td>`; } },
        ];
        const METER_COLS_KEY = PANEL_KEY + "-metercols";
        let meterCols = { order: [], hidden: [], sort: null, widths: {} };
        try { const v = JSON.parse(localStorage.getItem(METER_COLS_KEY) || "null"); if (v && typeof v === "object") meterCols = { order: Array.isArray(v.order) ? v.order : [], hidden: Array.isArray(v.hidden) ? v.hidden : [], sort: v.sort && v.sort.k ? { k: String(v.sort.k), dir: v.sort.dir === "asc" ? "asc" : "desc" } : null, widths: v.widths && typeof v.widths === "object" ? v.widths : {} }; } catch (_e) { /* defaults */ }
        const meterColsSave = () => { try { localStorage.setItem(METER_COLS_KEY, JSON.stringify(meterCols)); } catch (_e) { /* fine */ } };
        const meterColsOrdered = () => { const known = meterCols.order.map(k => METER_COLS.find(c => c.k === k)).filter(Boolean); return known.concat(METER_COLS.filter(c => !known.includes(c))); };
        function meterColsChanged(keep) { if (!keep) meterColsSave(); bmHtml = ""; dmgHtml = ""; try { renderBattleMeter(); if (open && tab === "damage") renderDamage(); } catch (error) { warn("damage meter view", error); } }
        document.addEventListener("click", e => {
            const th = e.target && e.target.closest ? e.target.closest(".mds-meter th[data-mcol]") : null; if (!th || e.target.closest(".mds-colrz")) return;
            const k = th.dataset.mcol, cur = meterCols.sort, first = k === "name" ? "asc" : "desc";
            meterCols.sort = !cur || cur.k !== k ? { k, dir: first } : cur.dir === first ? { k, dir: first === "asc" ? "desc" : "asc" } : null;
            meterColsChanged();
        });
        // A header's right edge sets that column's width by hand; a double-click gives it back to its content.
        let colRz = null;
        document.addEventListener("mousedown", e => { if (e.target && e.target.closest && e.target.closest(".mds-meter .mds-colrz")) e.preventDefault(); });
        document.addEventListener("pointerdown", e => {
            const g = e.button === 0 && e.target && e.target.closest ? e.target.closest(".mds-meter .mds-colrz") : null; if (!g) return;
            e.preventDefault(); const th = g.closest("th"); colRz = { k: th.dataset.mcol, x0: e.clientX, w0: th.getBoundingClientRect().width };
            const move = ev => { if (!colRz) return; meterCols.widths[colRz.k] = Math.max(30, Math.round(colRz.w0 + ev.clientX - colRz.x0)); meterColsChanged(true); };
            const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); colRz = null; meterColsChanged(); };
            window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
        });
        document.addEventListener("dblclick", e => { const g = e.target && e.target.closest ? e.target.closest(".mds-meter .mds-colrz") : null; if (!g) return; delete meterCols.widths[g.closest("th").dataset.mcol]; meterColsChanged(); });
        {
            let dragCol = null;
            const colTh = e => { const th = e.target && e.target.closest ? e.target.closest(".mds-meter th[data-mcol]") : null; return th && th.dataset.mcol !== "name" ? th : null; };
            document.addEventListener("dragstart", e => { const th = colTh(e); if (!th) return; if (e.target.closest(".mds-colrz") || colRz) { e.preventDefault(); return; } dragCol = th.dataset.mcol; e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", dragCol); } catch (_e) { /* fine */ } });
            document.addEventListener("dragover", e => { if (!dragCol) return; const th = colTh(e); if (th && th.dataset.mcol !== dragCol) e.preventDefault(); });
            document.addEventListener("drop", e => {
                if (!dragCol) return; const th = colTh(e); if (!th || th.dataset.mcol === dragCol) return; e.preventDefault();
                const order = meterColsOrdered().map(c => c.k).filter(k => k !== dragCol), r = th.getBoundingClientRect();
                order.splice(order.indexOf(th.dataset.mcol) + (e.clientX > r.left + r.width / 2 ? 1 : 0), 0, dragCol);
                meterCols.order = order; dragCol = null; meterColsChanged();
            });
            document.addEventListener("dragend", () => { dragCol = null; });
        }
        function meterView(s, expanded, withXp) {
            if (!s || !s.players || !Object.keys(s.players).length) return `<p class="mds-note">No battle seen yet: the meter starts with the next wave.</p>`;
            const secs = sessSecs(s), total = sessTotal(s);
            const cols = meterColsOrdered().filter(c => !meterCols.hidden.includes(c.k) && (withXp || !c.xpOnly));
            const players = Object.values(s.players).sort((a, b) => b.dealt - a.dealt || a.name.localeCompare(b.name));
            const top = players.length ? players[0].dealt : 0, ctx = { secs, total, top };
            const st = meterCols.sort, sc = st && (st.k === "name" ? { val: null } : cols.find(c => c.k === st.k));
            if (st && sc) { const dir = st.dir === "asc" ? 1 : -1; players.sort((a, b) => ((sc.val ? sc.val(a) - sc.val(b) : a.name.localeCompare(b.name)) * dir) || b.dealt - a.dealt || a.name.localeCompare(b.name)); }
            const sortCls = k => (st && sc && st.k === k ? ` mds-sort-${st.dir}` : "");
            const rows = players.map(p => {
                const isOpen = expanded.has(p.name), me = p.name === state.characterName;
                const main = `<tr class="mds-mrow${isOpen ? " open" : ""}${me ? " mds-me" : ""}" data-player="${esc(p.name)}" title="${esc(t("Click for {name}'s abilities", { name: p.name }))}"><td class="mds-mname" translate="no">${esc(p.name)}</td>${cols.map(c => c.cell(p, ctx)).join("")}</tr>`;
                return isOpen ? `${main}<tr class="mds-mdetail"><td colspan="${cols.length + 1}">${meterDetail(p, secs, s)}</td></tr>` : main;
            }).join("");
            const wd = k => { const w = Number(meterCols.widths[k]); return w >= 30 ? ` style="width:${w}px;min-width:${w}px;max-width:${w}px"` : ""; }, grip = `<i class="mds-colrz" title="${esc(t("Drag to set this column's width; double-click for automatic"))}"></i>`;
            return `<table class="mds-meter"><thead><tr><th data-mcol="name" class="${sortCls("name").trim()}"${wd("name")}>Player <span class="mds-hint">· click for details</span>${grip}</th>${cols.map(c => `<th draggable="true" data-mcol="${c.k}" class="${c.left ? "" : "n"}${sortCls(c.k)}"${c.title ? ` title="${esc(c.title)}"` : ""}${c.left ? "" : wd(c.k)}>${c.label}${c.left ? "" : grip}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
        }
        const monsterIcon = h => { const b = spriteOf("combat_monsters_sprite"); return b && h ? `<svg class="mds-icon" aria-hidden="true"><use href="${b}#${String(h).split("/").pop()}"></use></svg>` : ""; };
        const takenSubName = k => k === "old" ? t("Recorded before the breakdown (update 0.2.1)") : k === "auto" ? t("Auto attack") : k === "thorns" ? t("Thorns (damage sent back)") : k === "dot:?" ? t("Over time") : /^dot:/.test(k) ? t("{ability} over time", { ability: abilityName(k.slice(4)) }) : /^cost:/.test(k) ? (k === "cost:auto" ? t("HP cost on auto attacks") : t("HP cost with {ability}", { ability: abilityName(k.slice(5)) })) : /^\/abilities\//.test(k) ? abilityName(k) : k;
        const takenSubIcon = k => { const h = /^(dot|cost):/.test(k) ? k.slice(k.indexOf(":") + 1) : k; return /^\/abilities\//.test(h) ? abilityIcon(h) : ""; };
        const healSubName = k => k === "old" ? t("Recorded before the breakdown (update 0.2.1)") : k === "regen" ? t("Regeneration (every 10 s)") : k === "food" ? t("Food") : k === "other" ? t("Other (unidentified)") : k === "lifesteal" ? t("Life steal") : /^food:/.test(k) ? itemName(k.slice(5)) : k;
        const healSubIcon = k => (/^food:/.test(k) ? icon(k.slice(5)) : "");
        // Which source rows are open (damage taken from X, healed by Y): kept so a redraw keeps them.
        const metSubs = new Set();
        function meterDetail(p, secs, s) {
            const abs = Object.entries(p.abilities || {}).sort((a, b) => (b[1].dmg - a[1].dmg) || (b[1].heal - a[1].heal) || (b[1].casts - a[1].casts));
            const rows = abs.map(([k, a]) => `<tr><td translate="no">${meterKeyIcon(k)}${esc(meterKeyName(k))}</td><td class="n">${fmtN(a.dmg)}</td><td class="n">${pct1(a.dmg, p.dealt)}</td><td class="n">${Math.round(a.dmg / secs).toLocaleString()}</td><td class="n">${a.casts || "–"}</td><td class="n">${a.hits || 0}</td><td class="n">${a.misses || 0}</td><td class="n">${a.heal ? fmtN(a.heal) : "–"}</td></tr>`).join("") || `<tr><td colspan="8">Nothing used yet.</td></tr>`;
            const healName = k => k === "regen" ? t("Regeneration, food and passives") : k.includes(": ") ? t("{name}'s {ability}", { name: k.slice(0, k.indexOf(": ")), ability: meterKeyName(k.slice(k.indexOf(": ") + 2)) }) : meterKeyName(k);
            const cnt = (o, k) => (o && o[k] != null ? Number(o[k]).toLocaleString() : "–");
            // Damage taken and healing, the abilities' format: a folded header with the total, open on a click.
            const fold = (key, title, total, rows, head, noun = "source", nouns = noun + "s") => { const n = rows.length; return `<details class="mds-mfold"${metFolds.has(key) ? " open" : ""}><summary data-fold="${key}"><b>${esc(t(title + " {n}", { n: fmtN(total) }))}</b> <span class="mds-hint">· ${esc(t(n === 1 ? "{n} " + noun : "{n} " + nouns, { n }))}</span></summary>${n ? `<table class="mds-msub"><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table>` : ""}</details>`; };
            const monsters = (s && s.monsters) || {};
            // A source row opens on a click into what made it up (its own rows, indented), when that was recorded.
            const head = (fold, k, label, iconHtml, cells, subs) => { const id = `${fold}|${k}`, has = subs && Object.keys(subs).length > 0, isOpen = has && metSubs.has(id); return `<tr class="${has ? `mds-subhead${isOpen ? " open" : ""}` : ""}"${has ? ` data-sub="${esc(id)}" title="${esc(t("Click for what made it up"))}"` : ""}><td translate="no">${iconHtml}${esc(label)}</td>${cells}</tr>`; };
            // A session stitched across the update to 0.2.1 holds totals from before the breakdown: the rest of a source
            // is shown as its own row, so a source with nothing broken down still opens (operator, 2026-11-23).
            const withOld = (subs, total, any, zero) => { const known = Object.values(subs || {}).reduce((a, r) => a + (r.amt || 0), 0); if (!any || total - known <= 0) return subs; return { ...(subs || {}), old: { ...zero, amt: total - known } }; };
            const anyTaken = !!(p.takenSub && Object.keys(p.takenSub).length), anyHeal = !!(p.healSub && Object.keys(p.healSub).length);
            const taken = Object.entries(p.takenBy || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => {
                const subs = withOld(p.takenSub && p.takenSub[k], v, anyTaken, { hits: 0, misses: 0 }), id = `taken|${k}`;
                const row = head("taken", k, monsters[k] ? gameName("monsterNames", monsters[k], k) : k === "Own actions (HP cost)" || k === "Damage over time" ? t(k) : k, monsterIcon(monsters[k]), `<td class="n">${fmtN(v)}</td><td class="n">${pct1(v, p.taken)}</td><td class="n">${Math.round(v / secs).toLocaleString()}</td><td class="n">${cnt(p.takenHits, k)}</td><td class="n">${p.takenHits && p.takenHits[k] != null ? Number((p.takenMiss || {})[k] || 0).toLocaleString() : "–"}</td>`, subs);
                if (!subs || !metSubs.has(id)) return row;
                return row + Object.entries(subs).sort((a, b) => b[1].amt - a[1].amt || b[1].misses - a[1].misses).map(([sk, r]) => `<tr class="mds-subrow"><td translate="no">${takenSubIcon(sk)}${esc(takenSubName(sk))}</td><td class="n">${fmtN(r.amt)}</td><td class="n">${pct1(r.amt, p.taken)}</td><td class="n">${Math.round(r.amt / secs).toLocaleString()}</td><td class="n">${(r.hits || 0).toLocaleString()}</td><td class="n">${(r.misses || 0).toLocaleString()}</td></tr>`).join("");
            });
            const healIcon = k => { const h = k.includes(": ") ? k.slice(k.indexOf(": ") + 2) : k; return h === "bloom" ? icon("/items/blooming_trident") : meterKeyIcon(h); };
            const healed = Object.entries(p.healBy || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => {
                const subs = (p.healSub && p.healSub[k]) || k === "regen" ? withOld(p.healSub && p.healSub[k], v, anyHeal, { n: 0 }) : null, id = `healed|${k}`;
                const row = head("healed", k, healName(k), healIcon(k), `<td class="n">${fmtN(v)}</td><td class="n">${pct1(v, p.healed)}</td><td class="n">${Math.round(v / secs).toLocaleString()}</td><td class="n">${cnt(p.healHits, k)}</td>`, subs);
                if (!subs || !metSubs.has(id)) return row;
                return row + Object.entries(subs).sort((a, b) => b[1].amt - a[1].amt).map(([sk, r]) => `<tr class="mds-subrow"><td translate="no">${healSubIcon(sk)}${esc(healSubName(sk))}</td><td class="n">${fmtN(r.amt)}</td><td class="n">${pct1(r.amt, p.healed)}</td><td class="n">${Math.round(r.amt / secs).toLocaleString()}</td><td class="n">${(r.n || 0).toLocaleString()}</td></tr>`).join("");
            });
            // Mana (0.2.8): spent by ability, gained by kind. Absent on sessions saved before it was recorded.
            const manaName = k => k === "regen" ? t("Regeneration (every 10 s)") : k === "food" ? t("Food and drinks") : k === "other" ? t("Other (unidentified)") : k === "leech" ? t("Mana leech") : meterKeyName(k);
            const manaRows = (o, total) => Object.entries(o || {}).sort((a, b) => b[1].amt - a[1].amt).map(([k, r]) => `<tr><td translate="no">${k === "regen" || k === "food" || k === "other" || k === "leech" ? "" : meterKeyIcon(k)}${esc(manaName(k))}</td><td class="n">${fmtN(r.amt)}</td><td class="n">${pct1(r.amt, total)}</td><td class="n">${(r.amt / secs).toFixed(1)}</td><td class="n">${(r.n || 0).toLocaleString()}</td></tr>`);
            const manaHtml = !p.mana ? "" : fold("mpspent", "Mana spent", p.mpSpent || 0, manaRows(p.mana.spent, p.mpSpent), `<th>Ability</th><th class="n">Mana</th><th class="n">Share</th><th class="n" title="Per second in combat">Per second</th><th class="n">Uses</th>`, "ability", "abilities") + fold("mpgain", "Mana gained", p.mpGain || 0, manaRows(p.mana.gain, p.mpGain), `<th>Source</th><th class="n">Mana</th><th class="n">Share</th><th class="n" title="Per second in combat">Per second</th><th class="n" title="Times this source restored MP">Times</th>`);
            return `${fold("abilities", "Damage dealt", p.dealt, abs.length ? rows.split("</tr>").filter(Boolean).map(r => r + "</tr>") : [], `<th>Ability</th><th class="n">Damage</th><th class="n">Share</th><th class="n">DPS</th><th class="n" title="Times used. Parry, thorns and damage over time are not cast">Uses</th><th class="n" title="Enemies hit: an area ability counts each enemy it hits">Hits</th><th class="n">Misses</th><th class="n">Healing</th>`, "ability", "abilities")}${fold("taken", "Damage taken", p.taken, taken, `<th>Source</th><th class="n">Damage</th><th class="n">Share</th><th class="n" title="Per second in combat">Per second</th><th class="n" title="Attacks or ticks that took HP">Hits</th><th class="n" title="Attacks that took no HP: missed, dodged or blocked">Misses</th>`)}${fold("healed", "Healed", p.healed, healed, `<th>Source</th><th class="n">Healing</th><th class="n">Share</th><th class="n" title="Per second in combat">Per second</th><th class="n" title="Times this source restored HP">Times</th>`)}${manaHtml}`;
        }
        let dmgPick = "live", dmgHtml = "", dmgSessKey = "";
        // Ctrl+click (Cmd on a Mac) on a table row, the meters' player rows included (operator, 2026-11-23): the row as
        // one line in the game's chat input, from the visible column headers and values in the order shown.
        let chatOut = null;
        function rowChatLine(tr) {
            const table = tr.closest("table"); const head = table && table.tHead && table.tHead.rows[0]; if (!head) return "";
            if (tr.cells.length === 1 && tr.cells[0].colSpan > 1) return "";
            const heads = [...head.children], cells = [...tr.cells], parts = [];
            for (let i = 0; i < cells.length; i++) {
                const th = heads[i], td = cells[i]; if (!th || !td || th.hidden || td.hidden || getComputedStyle(td).display === "none") continue;
                if (td.querySelector("button") && !td.textContent.replace(/\s+/g, "").replace(/(Sell|Keep…|Shop|Buy|Done|Value…)/g, "")) continue;
                const label = (th.firstChild && th.firstChild.nodeType === 3 ? th.firstChild.textContent : th.textContent).trim(); const value = td.innerText.replace(/\s*\n\s*/g, "; ").replace(/\s+/g, " ").trim();
                if (!value || value === "–") continue;
                parts.push(i === 0 || !label ? value : `${label} ${value}`);
            }
            return parts.join(" · ");
        }
        // Which detail folds are open (damage taken, healed): kept here so a redraw keeps them, shared by every player.
        // Every popup and every opened player starts the same way (operator, 2026-11-23): damage dealt open, damage taken
        // and healing folded, no source opened.
        const METER_FOLDS = ["abilities"];
        const metFolds = new Set(METER_FOLDS);
        const metFoldsReset = () => { metFolds.clear(); for (const k of METER_FOLDS) metFolds.add(k); metSubs.clear(); };
        function metSubClick(e) { const tr = e.target.closest("tr[data-sub]"); if (!tr) return false; const k = tr.dataset.sub; if (metSubs.has(k)) metSubs.delete(k); else metSubs.add(k); return true; }
        function metFoldClick(e) { const sm = e.target.closest("summary[data-fold]"); if (!sm) return false; e.preventDefault(); const k = sm.dataset.fold; if (metFolds.has(k)) metFolds.delete(k); else metFolds.add(k); sm.parentElement.open = metFolds.has(k); return true; }
        const dmgExpanded = new Set();
        function damageSessions() { return state.damage.slice().sort((a, b) => num(b.endAt || b.at) - num(a.endAt || a.at)); }
        // All seen, per place and tier: every whole session plus the pieces kept out of the session list.
        function damageTotals() {
            const by = new Map();
            const slot = (zone, tier) => { const k = `${zone || "?"}|${tier ?? ""}`; let t = by.get(k); if (!t) by.set(k, t = { id: `all:${k}`, aggregate: true, zone: zone || null, tier: tier ?? null, players: {}, runs: 0, pieces: 0 }); return t; };
            for (const e of state.damage) { const t = slot(e.zone, e.tier); meterAdd(t, e); t.runs++; }
            for (const a of Object.values(isObj(state.meta.damagePartial) ? state.meta.damagePartial : {})) { const t = slot(a.zone, a.tier); meterAdd(t, a); t.pieces += a.pieces || 1; }
            return [...by.values()].sort((a, b) => num(b.lastAt) - num(a.lastAt));
        }
        // Drawn by the panel's render and on every battle message: translated after each pass.
        function renderDamage() { renderDamagePane(); const pane = els["mds-dmg-meter"] && els["mds-dmg-meter"].closest(".mds-pane"); if (pane) localize(pane); }
        function renderDamagePane() {
            if (!els["mds-dmg-meter"]) return;
            const live = state.meter.snapshot(serverNow()), list = damageSessions(), totals = damageTotals();
            const plain = h => h.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
            const isRun = s => !!(s.zone && ref.dungeons[s.zone]);
            const label = s => s.live ? `${t(isRun(s) ? "Current run" : "Current session")} · ${plain(meterWhere(s))} · ${meterResult(s)}`
                : s.aggregate ? `${plain(meterWhere(s))} · ${meterResult(s)}`
                : `${fmtTime(num(s.endAt || s.at))} · ${plain(meterWhere(s))} · ${meterResult(s)} · ${fmtDur(num(s.combatMs))}`;
            // Grouped: what is happening now, the totals per place (every run seen, whole or in part), the saved runs.
            const groups = [[t("Now"), live ? [["live", label(live)]] : []], [t("Totals per place (every run seen, full or in part)"), totals.map(x => [x.id, label(x)])], [t(list.some(isRun) ? "Saved runs (seen from start to end), newest first" : "Saved sessions (seen from start to end), newest first"), list.slice(0, 300).map(e => [e.id, label(e)])]];
            const opts = groups.flatMap(g => g[1]);
            const known = id => list.some(e => e.id === id) || totals.some(t => t.id === id);
            if (dmgPick === "live" && !live) dmgPick = list.length ? list[0].id : totals.length ? totals[0].id : "live";
            if (dmgPick !== "live" && !known(dmgPick)) dmgPick = live ? "live" : list.length ? list[0].id : totals.length ? totals[0].id : "live";
            const sel = els["mds-dmg-pick"], optKey = opts.map(o => o.join("|")).join("\n") + "\n" + dmgPick;
            if (sel.dataset.key !== optKey) { sel.innerHTML = groups.filter(g => g[1].length).map(([name, o]) => `<optgroup label="${esc(name)}">${o.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("")}</optgroup>`).join("") || `<option value="live">No sessions yet</option>`; sel.value = dmgPick; sel.dataset.key = optKey; }
            const s = dmgPick === "live" ? live : list.find(e => e.id === dmgPick) || totals.find(t => t.id === dmgPick) || null;
            const html = meterView(s, dmgExpanded), head = s ? meterHead(s) : "No battle seen yet. Fight a wave with the script running and the meter fills in.";
            if (html + head !== dmgHtml) { morph(els["mds-dmg-meter"], html); morph(els["mds-dmg-head"], head); dmgHtml = html + head; }
            const me = state.characterName, sessKey = `${list.length}|${list.length ? list[0].id : ""}|${dmgPick}|${me}`;
            if (s && s.aggregate) els["mds-dmg-head"].title = "Every whole session here plus the runs seen only in part (joined mid-run, or a wave missed): useful for averages, not kept as sessions of their own"; else els["mds-dmg-head"].title = "";
            if (sessKey !== dmgSessKey) {
                dmgSessKey = sessKey;
                els["mds-dmg-sessions"].innerHTML = list.map(e => {
                    const total = sessTotal(e), mine = e.players && e.players[me] ? e.players[me].dealt : null, c = e.check || {};
                    return `<tr data-sid="${esc(e.id)}" class="${e.id === dmgPick ? "sel" : ""}"><td class="t">${fmtTime(num(e.endAt || e.at))}</td><td class="t">${meterWhere(e)}</td><td>${esc(meterResult(e))}</td><td>${fmtDur(num(e.combatMs))}</td><td>${e.waves}</td><td>${fmtN(total)}</td><td>${Math.round(total / sessSecs(e)).toLocaleString()}</td><td>${mine == null ? "–" : fmtN(mine)}</td><td>${mine == null ? "–" : pct1(mine, total)}</td><td>${c.balanced || 0}/${c.waves || 0}</td></tr>`;
                }).join("") || `<tr><td colspan="10" class="t">No sessions saved yet.</td></tr>`;
            }
        }
        // The block under the game's battle cards: the session in progress, or the last one for ten minutes after it.
        // It sits after the panel's info area (BattlePanel_battlePanel > battleArea, infoArea in the game's bundle).
        const BM_KEY = PANEL_KEY + "-battlemeter", BM_MODE_KEY = PANEL_KEY + "-battlemeter-mode";
        const bmOn = () => { try { return localStorage.getItem(BM_KEY) !== "off"; } catch (_e) { return true; } };
        // All runs (the default): the running total since the party went into combat. This run: the session alone.
        const bmPerRun = () => { try { return localStorage.getItem(BM_MODE_KEY) === "run"; } catch (_e) { return false; } };
        const bmExpanded = new Set();
        let bmEl = null, bmHtml = "", bmPop = null, bmPopName = null, bmPopHtml = "";
        // Where the popup has been dragged to, from the middle (operator, 2026-11-23); kept for the next player's.
        const bmPopPos = { x: 0, y: 0 };
        function bmPopClose() { bmPopName = null; bmPopHtml = ""; if (bmPop) bmPop.hidden = true; }
        function bmPopRender(s) {
            if (!bmPopName) { if (bmPop) bmPop.hidden = true; return; }
            if (!bmPop) {
                bmPop = document.createElement("div"); bmPop.id = "mds-bm-pop"; bmPop.hidden = true;
                // Dragged by its header (not the close button); double-click the header to put it back in the middle.
                // The offset is part of the card's markup, so the in-place redraw keeps it.
                bmPop.addEventListener("pointerdown", e => {
                    const headEl = e.target.closest(".mds-pop-head"); if (!headEl || e.button !== 0 || e.target.closest("button")) return;
                    const card = bmPop.querySelector(".mds-pop-card"); if (!card) return;
                    e.preventDefault();
                    const sx = e.clientX, sy = e.clientY, ox = bmPopPos.x, oy = bmPopPos.y, r = card.getBoundingClientRect();
                    const move = ev => {
                        // Keep at least 60 px of the header on screen.
                        const nx = Math.max(-r.left - r.width + 60 + ox, Math.min(innerWidth - r.left - 60 + ox, ox + ev.clientX - sx));
                        const ny = Math.max(-r.top + oy, Math.min(innerHeight - r.top - 30 + oy, oy + ev.clientY - sy));
                        bmPopPos.x = Math.round(nx); bmPopPos.y = Math.round(ny);
                        card.style.transform = `translate(${bmPopPos.x}px,${bmPopPos.y}px)`;
                    };
                    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); bmPopHtml = ""; };
                    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
                });
                bmPop.addEventListener("dblclick", e => { if (!e.target.closest(".mds-pop-head") || e.target.closest("button")) return; bmPopPos.x = 0; bmPopPos.y = 0; bmPopHtml = ""; renderBattleMeter(); });
                bmPop.addEventListener("click", e => { if (metFoldClick(e)) return; if (metSubClick(e)) { bmPopHtml = ""; renderBattleMeter(); return; } if (e.target === bmPop || e.target.closest("button[data-pop=close]")) bmPopClose(); });
                document.addEventListener("keydown", e => { if (e.key === "Escape" && bmPopName) bmPopClose(); });
                document.body.appendChild(bmPop);
            }
            const p = s && s.players && s.players[bmPopName], secs = sessSecs(s), total = sessTotal(s);
            const sub = p ? esc(t("{dmg} damage · {share} of the party · {dps} DPS · taken {taken} · healed {healed}", { dmg: fmtN(p.dealt), share: pct1(p.dealt, total), dps: Math.round(p.dealt / secs).toLocaleString(), taken: fmtN(p.taken), healed: fmtN(p.healed) }) + (p.deaths ? " · " + t(p.deaths === 1 ? "{n} death" : "{n} deaths", { n: p.deaths }) : "")) : "";
            const html = `<div class="mds-pop-card" role="dialog" aria-label="${esc(bmPopName)}'s damage" style="transform:translate(${bmPopPos.x}px,${bmPopPos.y}px)"><div class="mds-pop-head"><strong translate="no">${esc(bmPopName)}</strong><small>${sub}</small><button type="button" data-pop="close" title="Close (Esc)">×</button></div>${p ? meterDetail(p, secs, s) : `<p>Nothing for ${esc(bmPopName)} in this session.</p>`}</div>`;
            if (html !== bmPopHtml) { morph(bmPop, html); bmPopHtml = html; localize(bmPop); }
            bmPop.hidden = false;
        }
        // The line between the players and the monsters in the battle window, as a drag handle (operator, 2026-11-23).
        // The game gives both sides `flex: 1 1` inside BattlePanel_battleArea (read in its stylesheet); a chosen split
        // is one style rule (players `flex: 0 0 N%`, monsters the rest), so the game redrawing the panel cannot undo
        // it, and a handle of ours sits on the line. Kept per browser; double-click the line for the even split.
        // Independent of the damage meter.
        const SPLIT_KEY = PANEL_KEY + "-battlesplit";
        let splitPct = null, splitEl = null, splitStyle = null, splitDragging = false;
        try { const v = Number(localStorage.getItem(SPLIT_KEY)); if (v >= 15 && v <= 85) splitPct = v; } catch (_e) { splitPct = null; }
        function applySplit() {
            if (!splitStyle) { splitStyle = document.createElement("style"); splitStyle.id = "mds-split-style"; document.documentElement.appendChild(splitStyle); }
            const css = splitPct == null ? "" : `[class*="BattlePanel_battleArea__"]>[class*="BattlePanel_playersArea__"]{flex:0 0 ${splitPct}% !important}[class*="BattlePanel_battleArea__"]>[class*="BattlePanel_monstersArea__"]{flex:1 1 0 !important}[class*="BattlePanel_battleArea__"]::after{left:${splitPct}% !important}`;   // the game's own line is battleArea::after at left:50% (its stylesheet)
            if (splitStyle.textContent !== css) splitStyle.textContent = css;
            if (splitEl) splitEl.style.left = `calc(${splitPct == null ? 50 : splitPct}% - 5px)`;
        }
        function battleSplit() {
            const area = document.querySelector('[class*="BattlePanel_battlePanel__"] [class*="BattlePanel_battleArea__"]');
            if (!area) { if (splitEl && splitEl.isConnected && !splitDragging) splitEl.remove(); return; }
            if (!splitEl) {
                splitEl = document.createElement("div"); splitEl.id = "mds-split"; splitEl.setAttribute("translate", "no");
                splitEl.addEventListener("pointerdown", e => {
                    if (e.button !== 0) return;
                    const host = splitEl.parentElement; if (!host) return;
                    e.preventDefault(); splitDragging = true; splitEl.classList.add("dragging");
                    const move = ev => { const r = host.getBoundingClientRect(); if (!(r.width > 0)) return; splitPct = Math.max(15, Math.min(85, Math.round((ev.clientX - r.left) / r.width * 1000) / 10)); applySplit(); };
                    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); splitDragging = false; splitEl.classList.remove("dragging"); try { if (splitPct != null) localStorage.setItem(SPLIT_KEY, String(splitPct)); } catch (_e) { /* fine */ } };
                    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
                });
                splitEl.addEventListener("dblclick", () => { splitPct = null; try { localStorage.removeItem(SPLIT_KEY); } catch (_e) { /* fine */ } applySplit(); });
            }
            const title = t("Drag to resize the players' and monsters' sides; double-click for an even split");
            if (splitEl.title !== title) splitEl.title = title;
            if (splitEl.parentElement !== area) area.appendChild(splitEl);
            applySplit();
        }
        // The dungeon's entry key and chest key(s) in the battle window's bottom frame, left of Consumables (operator,
        // 2026-11-23): the game's small item tile with the count held, and under it how long they last at this
        // dungeon's average run time (fails counted in), in the form and colours Toolasha uses for consumables
        // (10 px, grey; amber and red by the hours in Settings). An entry key goes one a run; a chest key goes one a chest,
        // at the chests per run this record has seen for that key (1 until a run is seen). Hovering the entry key
        // lists the party's counts from the newest party key-count message. Dungeons only.
        let bkEl = null, bkHtml = "";
        function runwayText(sec) {
            if (!Number.isFinite(sec)) return "–"; if (sec <= 0) return "0m";
            if (sec < 3600) return `${Math.ceil(sec / 60)}m`;
            if (sec < 86400) { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return m ? `${h}h ${m}m` : `${h}h`; }
            const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600); return h ? `${d}d ${h}h` : `${d}d`;
        }
        // Amber under 72 hours, red under 24 (operator, 2026-11-23); both can be changed in Settings, per browser.
        const KEYH_KEY = PANEL_KEY + "-keyhours-";
        function keyHours(which) { let v = NaN; try { const raw = localStorage.getItem(KEYH_KEY + which); if (raw != null && raw !== "") v = Number(raw); } catch (_e) { v = NaN; } return v >= 0 ? v : which === "red" ? 24 : 72; }
        const runwayColor = (sec, calm = "#888") => (!Number.isFinite(sec) ? calm : sec < keyHours("red") * 3600 ? "#ff6b6b" : sec < keyHours("amber") * 3600 ? "#f0a830" : calm);
        // This dungeon's average run time: this tier's runs when the record has any, else every run of the dungeon.
        function zoneRuns(zone) {
            const tier = currentTier(), d = getDerived();
            const runs = (d.runs || []).filter(r => r.zone === zone && (r.result === "clear" || r.result === "fail") && r.durationMs > 0);
            const mine = runs.filter(r => r.tier === tier), used = mine.length ? mine : runs;
            return { used, avgMs: used.length ? used.reduce((a, r) => a + r.durationMs, 0) / used.length : null };
        }
        // Who in the party runs out of entry keys first, and when (operator, 2026-11-23): the fewest keys in the newest
        // party key-count message, at the dungeon's average run time. Amber under 72 hours and red under 24 unless changed in Settings (red at 3 keys or fewer while no run time is known).
        // Shown in the damage meter's header; in the Keys label when the meter is hidden or switched off.
        function keysWarning() {
            const zone = currentDungeonZone(); const pk = zone && ref.dungeons[zone] && state.partyKeys ? state.partyKeys.counts : null;
            const rows = pk ? Object.entries(pk).filter(([, k]) => Number.isFinite(k)) : []; if (!rows.length) return "";
            const [name, k] = rows.reduce((a, b) => (b[1] < a[1] ? b : a));
            const { avgMs } = zoneRuns(zone); const sec = avgMs != null ? k * avgMs / 1000 : NaN;
            const color = k <= 0 || (avgMs == null && k <= 3) ? "#ff6b6b" : runwayColor(sec, "#8fa3b0");
            const text = k <= 0 ? t("{name} is out of keys", { name }) : avgMs != null ? t("{name} out of keys in {time}", { name, time: runwayText(sec) }) : t("{name} has {n} keys", { name, n: k.toLocaleString() });
            const tip = [t("Party entry keys")].concat(rows.slice().sort((a, b) => a[1] - b[1]).map(([nm, n]) => `${nm}: ${n.toLocaleString()}${avgMs != null ? ` (${runwayText(n * avgMs / 1000)})` : ""}`)).join(String.fromCharCode(10));
            return `<span class="mds-keywarn" translate="no" style="color:${color}" data-mds-tip="${esc(tip)}">${color === "#ff6b6b" ? "⚠ " : ""}${esc(text)}</span>`;
        }
        // Who in the party runs out of a consumable first (operator, 2026-11-23): per player and item, the count held
        // over the rate used since this page first saw it (10 minutes and one use at least), same colours and places
        // as the key line; an item at zero is always red. The tooltip lists each member's soonest item.
        function consWarning() {
            const all = [];
            for (const [name, rec] of Object.entries(state.partyCons || {})) for (const [item, r] of Object.entries(rec)) {
                const sec = consSec(r); if (sec != null) all.push({ name, item, count: Math.max(0, r.count), sec });
            }
            if (!all.length) return "";
            all.sort((a, b) => a.sec - b.sec);
            const x = all[0], color = x.sec <= 0 ? "#ff6b6b" : runwayColor(x.sec, "#8fa3b0");
            const text = x.sec <= 0 ? t("{name} is out of {item}", { name: x.name, item: itemName(x.item) }) : t("{name} out of {item} in {time}", { name: x.name, item: itemName(x.item), time: runwayText(x.sec) });
            const first = []; for (const r of all) if (!first.some(f => f.name === r.name)) first.push(r);
            const tip = [t("Party consumables")].concat(first.map(r => `${r.name}: ${itemName(r.item)} ${r.count.toLocaleString()} (${runwayText(r.sec)})`)).join(String.fromCharCode(10));
            return `<span class="mds-keywarn" translate="no" style="color:${color}" data-mds-tip="${esc(tip)}">${color === "#ff6b6b" ? "⚠ " : ""}${esc(text)}</span>`;
        }
        // Our own tooltip for the battle window's keys, consumables and warning lines (operator, 2026-11-23: the
        // browser's title tooltip takes about a second and cannot be made faster). Shown at once on hover, below the
        // element so the game's own item tooltip above it stays clear (above only when there is no room below), text from data-mds-tip, kept current while it is open.
        let tipEl = null, tipFor = null;
        // Under a consumable tile Toolasha writes its own time line: the tooltip starts below that row.
        function tipBottom(el, r) {
            let b = r.bottom; const frame = el.closest('[class*="BattlePanel_combatConsumables__"]');
            if (frame) for (const x of frame.querySelectorAll(".mwi-combat-consumable-timer")) b = Math.max(b, x.getBoundingClientRect().bottom);
            return b;
        }
        function tipPlace() {
            if (!tipFor || !tipFor.isConnected || !tipFor.getAttribute("data-mds-tip")) { tipFor = null; if (tipEl) tipEl.hidden = true; return; }
            const text = tipFor.getAttribute("data-mds-tip"); if (tipEl.textContent !== text) tipEl.textContent = text;
            tipEl.hidden = false;
            const r = tipFor.getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight;
            const left = Math.max(4, Math.min(window.innerWidth - w - 4, r.left + r.width / 2 - w / 2)), bottom = tipBottom(tipFor, r), top = bottom + 6 + h <= window.innerHeight - 4 || r.top - h - 6 < 4 ? bottom + 6 : r.top - h - 6;
            tipEl.style.left = `${Math.round(left)}px`; tipEl.style.top = `${Math.round(top)}px`;
        }
        document.addEventListener("mouseover", e => {
            const el = e.target && e.target.closest ? e.target.closest("[data-mds-tip]") : null; if (el === tipFor) return;
            tipFor = el;
            if (el && !tipEl) { tipEl = document.createElement("div"); tipEl.id = "mds-tip"; tipEl.setAttribute("translate", "no"); tipEl.hidden = true; document.body.appendChild(tipEl); }
            if (tipEl) tipPlace();
        }, true);
        // Seconds a tracked consumable lasts at the rate seen so far: 0 at none, null until 10 minutes and one use.
        const consSec = r => (r.count <= 0 ? 0 : r.t - r.t0 >= 600e3 && r.used > 0 ? r.count * (r.t - r.t0) / r.used / 1000 : null);
        // Hovering one of your own consumables in the bottom frame lists the party's item in the same slot (food 1-3,
        // drink 1-3) with the count held and the time it lasts (operator, 2026-11-23). By slot, so nobody's two HP
        // foods have to be matched to another's one. The game's own item tooltip still opens beside it.
        function consTips() {
            const frame = document.querySelector('[class*="BattlePanel_battlePanel__"] [class*="BattlePanel_infoContainer__"] > [class*="BattlePanel_combatConsumables__"]'); if (!frame) return;
            const all = state.partyCons || {}, mine = all[state.characterName] || {};
            for (const el of frame.querySelectorAll('[class*="CombatConsumable_combatConsumable"]')) {
                const use = el.querySelector("use"), slug = use ? String(use.getAttribute("href") || use.getAttribute("xlink:href") || "").split("#")[1] : "";
                const me = slug ? mine["/items/" + slug] : null; let tip = "";
                if (me) {
                    const rows = [];
                    for (const [name, rec] of Object.entries(all)) for (const [item, r] of Object.entries(rec)) if (r.kind === me.kind && r.slot === me.slot) rows.push({ name, item, r, sec: consSec(r) });
                    rows.sort((a, b) => (a.sec == null ? Infinity : a.sec) - (b.sec == null ? Infinity : b.sec));
                    tip = [t(me.kind === "drink" ? "Party drink slot {n}" : "Party food slot {n}", { n: me.slot + 1 })].concat(rows.map(x => `${x.name}: ${itemName(x.item)} ${x.r.count.toLocaleString()} (${x.sec == null ? "–" : runwayText(x.sec)})`)).join(String.fromCharCode(10));
                }
                if ((el.getAttribute("data-mds-tip") || "") !== tip) { if (tip) el.setAttribute("data-mds-tip", tip); else el.removeAttribute("data-mds-tip"); }
            }
        }
        // The Consumables tab (operator, 2026-11-23): the whole party at a glance, one row a member, a column a slot:
        // the count held, with the time it lasts under it in the battle window's colours; entry keys beside them.
        let partyHtml = "";
        function renderParty() {
            const body = els["mds-partycons"]; if (!body) return;
            const all = state.partyCons || {}, zone = currentDungeonZone(), inDungeon = !!(zone && ref.dungeons[zone]);
            const pk = inDungeon && state.partyKeys ? state.partyKeys.counts : null, avgMs = inDungeon ? zoneRuns(zone).avgMs : null;
            const names = [...new Set([...Object.keys(all), ...Object.keys(pk || {})])];
            const time = sec => `<small style="color:${sec == null ? "#888" : runwayColor(sec, "#8fa3b0")}">${sec == null ? "–" : runwayText(sec)}</small>`;
            const html = names.map(name => {
                const rec = all[name] || {}, cell = (kind, slot) => { const hit = Object.entries(rec).find(([, r]) => r.kind === kind && r.slot === slot); if (!hit) return `<td>–</td>`; const [item, r] = hit; return `<td title="${esc(itemName(item))}">${icon(item)}${Math.max(0, r.count).toLocaleString()}${time(consSec(r))}</td>`; };
                const k = pk && pk[name] != null ? pk[name] : null;
                return `<tr><td class="k" translate="no">${esc(name)}</td><td>${k == null ? "–" : k.toLocaleString() + time(avgMs != null ? k * avgMs / 1000 : null)}</td>${[0, 1, 2].map(i => cell("food", i)).join("")}${[0, 1, 2].map(i => cell("drink", i)).join("")}</tr>`;
            }).join("") || `<tr><td colspan="8" class="t">No battle seen on this page yet.</td></tr>`;
            if (html !== partyHtml) { body.innerHTML = html; partyHtml = html; const pane = body.closest(".mds-pane"); if (pane) localize(pane); }
        }
        function battleKeys() {
            const zone = currentDungeonZone(), dz = zone && ref.dungeons[zone];
            if (!dz) {
                // No keys outside a dungeon; with the meter hidden or off the consumables line still needs a place.
                const frame = document.querySelector('[class*="BattlePanel_battlePanel__"] [class*="BattlePanel_infoContainer__"] > [class*="BattlePanel_combatConsumables__"]');
                const w = frame && !(bmOn() && meterEnabled()) ? consWarning() : "";
                if (!w) { if (bkEl && bkEl.isConnected) bkEl.remove(); return; }
                if (!bkEl) { bkEl = document.createElement("div"); bkEl.id = "mds-bkeys"; bkEl.setAttribute("translate", "no"); }
                const h = `<div class="mds-bk-label mds-bk-only">${w}</div>`;
                if (bkHtml !== h || !bkEl.firstChild) { bkEl.innerHTML = h; bkHtml = h; }
                if (frame.previousElementSibling !== bkEl) frame.before(bkEl);
                return;
            }
            const cons = dz && document.querySelector('[class*="BattlePanel_battlePanel__"] [class*="BattlePanel_infoContainer__"] > [class*="BattlePanel_combatConsumables__"]');
            const base = cons && spriteBase();
            if (!cons || !base) { if (bkEl && bkEl.isConnected) bkEl.remove(); return; }
            const { used, avgMs } = zoneRuns(zone);
            const items = []; if (dz.keyItem) items.push({ item: dz.keyItem, perRun: 1, entry: true });
            for (const c of dz.chests || []) {
                const key = ref.chestItems[c] && ref.chestItems[c].key; if (!key) continue;
                let row = items.find(x => x.item === key && !x.entry); if (!row) { row = { item: key, perRun: 0, chests: 0 }; items.push(row); }
                for (const r of used) for (const ch of (r.chests || [])) if (ch.item === c) row.chests += Number(ch.qty) || 0;
            }
            for (const x of items) if (!x.entry) x.perRun = used.length && x.chests > 0 ? x.chests / used.length : 1;
            const pk = state.partyKeys ? state.partyKeys.counts : null;   // the newest message; a run joined part-way starts later than its key-count message, so no time guard
            const html = `<div class="mds-bk-label">${esc(t("Keys"))}${bmOn() && meterEnabled() ? "" : keysWarning() + consWarning()}</div><div class="mds-bk-grid">` + items.map(x => {
                const n = held(x.item), sec = avgMs != null ? n / x.perRun * avgMs / 1000 : NaN;
                const tip = [itemName(x.item), avgMs != null ? t("Lasts about {time} at {run} a run", { time: runwayText(sec), run: fmtDur(avgMs) }) : t("No run time for this dungeon yet")];
                if (x.entry && pk && Object.keys(pk).length) { tip.push("", t("Party entry keys")); for (const [name, k] of Object.entries(pk)) tip.push(`${name}: ${k.toLocaleString()}${avgMs != null ? ` (${runwayText(k * avgMs / 1000)})` : ""}`); }
                return `<div class="mds-bk-cell" data-mds-tip="${esc(tip.join(String.fromCharCode(10)))}"><div class="mds-bk-tile"><svg aria-hidden="true"><use href="${base}#${x.item.split("/").pop()}"></use></svg><span>${n}</span></div><div class="mds-bk-time" style="color:${runwayColor(sec)}">${runwayText(sec)}</div></div>`;
            }).join("") + `</div>`;
            if (!bkEl) { bkEl = document.createElement("div"); bkEl.id = "mds-bkeys"; bkEl.setAttribute("translate", "no"); }
            if (bkHtml !== html || !bkEl.firstChild) { bkEl.innerHTML = html; bkHtml = html; }
            if (cons.previousElementSibling !== bkEl) cons.before(bkEl);
        }
        function renderBattleMeter() {
            const host = document.querySelector('[class*="BattlePanel_battlePanel__"]');
            if (!host || !bmOn() || !meterEnabled()) { if (bmEl && bmEl.isConnected) bmEl.remove(); bmPopClose(); document.documentElement.removeAttribute("data-mds-xp"); return; }
            // Read by the Metz Combat Sim Helper (0.7.9): while the meter shows XP/hr, its bars above the cards hide.
            if (!document.documentElement.hasAttribute("data-mds-xp")) document.documentElement.setAttribute("data-mds-xp", "1");
            if (!bmEl) {
                bmEl = document.createElement("div"); bmEl.id = "mds-bm";
                bmEl.addEventListener("click", e => {
                    const b = e.target.closest("button[data-bm]");
                    if (b && b.dataset.bm === "mode") { try { localStorage.setItem(BM_MODE_KEY, bmPerRun() ? "all" : "run"); } catch (_e) { /* fine */ } bmHtml = ""; renderBattleMeter(); return; }
                    if (b) { if (b.dataset.bm === "hide") { try { localStorage.setItem(BM_KEY, "off"); } catch (_e) { /* fine */ } const cb = root && root.querySelector("#mds-bm-on"); if (cb) cb.checked = false; renderBattleMeter(); } else { tab = "damage"; dmgPick = "live"; setTab("damage", true); setOpen(true); } return; }
                    const tr = e.target.closest("tr.mds-mrow"); if (!tr) return;
                    if (e.ctrlKey || e.metaKey) { const line = rowChatLine(tr); if (line && chatOut) { e.preventDefault(); chatOut(line, tr); } return; }
                    bmPopName = tr.dataset.player; bmPopHtml = ""; metFoldsReset(); renderBattleMeter();
                });
            }
            const info = [...host.children].find(c => /BattlePanel_infoArea__/.test(c.className || ""));
            if (info) { if (info.nextElementSibling !== bmEl) info.after(bmEl); } else if (bmEl.parentNode !== host) host.appendChild(bmEl);
            let s = state.meter.snapshot(serverNow());
            const st = state.streak;
            if (!bmPerRun() && st) {
                const same = !!(s && `${s.zone || "?"}|${s.tier ?? ""}` === st.key), t = JSON.parse(JSON.stringify(st));
                if (same) { const gap = num(s.startAt) - num(st.lastAt); if (gap > 0 && gap < 120e3) t.combatMs = num(t.combatMs) + gap; t.liveNew = !(t.ids || []).includes(s.battleId); meterAdd(t, s); }
                t.live = same; s = t;
            }
            if (!s) { const last = damageSessions()[0]; if (last && serverNow() - num(last.endAt || last.at) < 10 * 60e3) s = last; }
            const html = `<div class="mds-bm-head">${s ? (h => `<strong>${esc(t("Damage {n}", { n: "" })).replace("", `<span class="mds-fixd">${esc(h.total)}</span>`)}</strong><span class="mds-bm-dps"><span class="mds-fixp">${h.dps}</span> DPS</span><small>${h.line}</small>${h.badge}`)(meterHeadShort(s)) : `<strong>Damage</strong><small>starts with the next wave</small>`}${keysWarning()}${consWarning()}<span class="mds-bm-btns"><button data-bm="mode" title="${bmPerRun() ? "Showing this run only. Click to show every run since the party went into combat" : "Showing every run since the party went into combat, on this page. Click to show this run only"}">${bmPerRun() ? "This run" : "All runs"}</button><button data-bm="open" title="Every saved session, in Dungeon Stats">Sessions</button><button data-bm="hide" title="Hide the meter here; Dungeon Stats Settings brings it back">Hide</button></span></div>${s ? `<div class="mds-bm-body">${meterView(s, bmExpanded, true).replace(/title="Click for /g, 'title="Details for ')}</div>` : ""}`;
            if (html !== bmHtml || !bmEl.firstChild) { morph(bmEl, html); bmHtml = html; localize(bmEl); }
            // Players' details open in a popup, so the meter is only ever its rows high. Never more than half the battle
            // panel, whose height is what the chat panel leaves (a dump 2026-11-23: window 1197 px, panel 424 px).
            const want = `${Math.max(140, Math.round(host.clientHeight * 0.5))}px`;
            if (bmEl.style.maxHeight !== want) bmEl.style.maxHeight = want;
            bmPopRender(s);
        }
        function renderRuns(force) {
            if (!els["mds-runs"]) return;
            if (!force && els.runsWrap.scrollTop > 8) { runsHeld = true; return; }
            runsHeld = false;
            const d = getDerived(); const now = serverNow();
            const items = [...d.runs.map(r => ({ t: r.startAt, run: r })), ...d.offline.map(b => ({ t: b.to, block: b }))].sort((a, b) => b.t - a.t).slice(0, 300);
            // "1 Chest, 1 Refine": the dungeon is in its own column, and a refinement chest is the only other kind.
            const chestWord = h => (/refinement/.test(h) ? "Refine" : ref.chestItems[h] ? "Chest" : it(h));
            const chestText = r => (r.chests ? (r.chests.length ? r.chests.map(c => `${c.qty} ${chestWord(c.item)}`).join(", ") : "none") : "–");
            // T2D4: tier from the run, else from the game's loot log session that covers it; D from the game's dungeon order.
            const sessionTier = t => { const e = [...state.lootLog.values()].find(x => ref.dungeons[x.action] && x.start <= t && t <= (isRunning(x) ? serverNow() : x.end) + 5000); return e ? e.tier : null; };
            const dungeonCode = (zone, tier, at) => { const dg = ref.dungeons[zone]; const tr = tier != null ? tier : sessionTier(at); return `<span title="${esc(dg ? dg.name : shortAction(zone || ""))}">${tr != null ? `T${tr}` : ""}${dg && dg.index ? `D${dg.index}` : esc(shortAction(zone || "?"))}</span>`; };
            els["mds-runs"].innerHTML = items.map(x => {
                if (x.block) { const b = x.block; return `<tr class="offline"><td class="t">${fmtTime(b.from)}</td><td class="k">offline</td><td class="t">–</td><td>${fmtDur(b.ms)}</td><td>–</td><td>${b.chestTotal ? Object.entries(b.chests).map(([h, q]) => `${q} ${chestWord(h)}`).join(", ") : "none"}</td><td>${Object.values(b.keys).reduce((s, v) => s + -v, 0) || "–"}</td><td>–</td><td>${fmtCoins(xpSum(b.xp))}</td><td class="t">login summary · ${b.runsInLedger} runs in the chat ledger</td></tr>`; }
                const r = x.run;
                const dur = r.result === "open" ? `${fmtDur(now - r.startAt)} so far` : (r.durationMs != null ? fmtDur(r.durationMs) : "–");
                const result = resultWord(r.result);
                return `<tr class="${r.result}"><td class="t">${fmtTime(r.startAt)}${r.spansRecordStart ? " ↰" : ""}</td><td class="k">${result}${!colVisible("runs", 9, "Seen by") && r.note ? ` <span class="mds-flag" title="${esc(r.note)}">?</span>` : ""}</td><td class="t">${dungeonCode(r.zone, r.tier, r.startAt)}</td><td>${dur}</td><td>${r.waves ?? "–"}</td><td>${chestText(r)}</td><td>${r.keysCharged ?? "–"}${r.keysSrc === "key count" ? "*" : ""}</td><td>${r.deaths ?? "–"}</td><td>${r.xpBySkill ? fmtCoins(xpSum(r.xpBySkill)) + (r.xpPartial ? "†" : "") : "–"}</td><td class="t">${r.source}${r.note ? ` · <span class="mds-flag" title="${esc(r.note)}">${esc(noteLabel(r.note))}</span>` : ""}</td></tr>`;
            }).join("") || `<tr><td colspan="10" class="t">No runs yet.</td></tr>`;
            renderSessions(d);
            els["mds-runsnote"].textContent = "Newest first. * keys charged read from the party key counts (no clear message seen). † XP counted from when the script joined the run. ↰ the run was under way when the record started.";
        }
        function render() {
            ensure(); if (!root) return;
            if (!prices.map && !prices.fetching && !prices.error) fetchPrices(false).then(() => touch(), () => {});
            const used = state.events.filter(e => e.kind === "consume").reduce((s, e) => { s.n += e.qty; s.cost += e.unitCost != null ? e.unitCost * e.qty : 0; return s; }, { n: 0, cost: 0 });
            const runLine = state.run ? `${zoneLabel(state.run.zone, state.run.tier)} · ${t("wave {n}", { n: state.run.waves })} · ${fmtDur(serverNow() - state.run.startAt)}` : t("between runs");
            els["mds-status"].setAttribute("translate", "no");   // put together from translated parts here; the name stays as it is
            els["mds-status"].textContent = `${state.characterName || t("waiting for login")}${state.meta.recordStart ? " · " + t("record since {date}", { date: fmtTime(state.meta.recordStart) }) : " · " + t("no record yet")} · ${t("{n} events", { n: state.counts.events })}${state.reviews ? " · " + t("{n} for review", { n: state.reviews }) : ""} · ${runLine}${used.n ? " · " + t("consumables used {n} ({cost} at purchase price, recent events)", { n: used.n, cost: fmtCoins(used.cost) }) : ""}`;
            root.querySelector("#mds-banner").hidden = bannerDismissed || state.lootLogReadThisSession || !state.ready;
            setTimeout(() => { foldSummaries(); localize(root); }, 0);
            for (const n of root.querySelectorAll(".mds-prices-note")) n.textContent = prices.fetching ? t("fetching…") : prices.at ? t("prices as of {date}", { date: fmtTime(prices.at) }) : prices.error ? t("prices: {error}", { error: prices.error }) : t("prices not fetched yet");
            if (tab === "overview") renderOverview();
            else if (tab === "runs") renderRuns(false);
            else if (tab === "damage") renderDamage();
            else if (tab === "party") renderParty();
            else if (tab === "keys") renderKeys();
            else if (tab === "loot") renderLoot();
            else if (tab === "chests") renderChests();
            else if (tab === "lifetime") renderLifetime();
            else if (tab === "xp") renderXp();
            else {
                renderRows(false);
                const byType = [...state.counts.byType.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(" · ");
                els["mds-diag"].textContent = [
                    `frames heard ${state.counts.frames} · ${state.sockets} socket${state.sockets === 1 ? "" : "s"}${state.viaData ? ` · ${state.viaData} via data getter` : ""}`,
                    `game data: ${ref.ready ? Object.keys(ref.dungeons).length + " dungeons" : "not loaded"} · ${ref.source || "waiting"}${ref.version ? " · " + ref.version : ""}`,
                    `loot log: ${state.lootLog.size} sessions${state.lootLogAt ? ` · last read ${fmtTime(state.lootLogAt)}` : ""}${TOOLASHA.sessions ? ` · ${TOOLASHA.sessions} from Toolasha` : ""}`,
                    `market history: ${state.marketHistory.size} listings merged${[...new Set(marketHistoryRows().map(l => l.src).filter(Boolean))].length ? " from " + [...new Set(marketHistoryRows().map(l => l.src).filter(Boolean))].join(", ") : ""}`,
                    `toolasha history: ${TOOLASHA.status}${TOOLASHA.listings ? ` · ${TOOLASHA.listings} listings · ${TOOLASHA.seeded} items seeded · ${TOOLASHA.imported} fills imported` : ""}${state.meta.toolashaSeeded ? ` · seeded ${fmtTime(state.meta.toolashaSeeded)}` : ""}`,
                    `artisan: ${Object.entries(state.artisan).filter(([, a]) => a.rate > 0).map(([t, a]) => `${t.split("/").pop()} ${(a.rate * 100).toFixed(2)}% (${a.tea ? itemName(a.tea) : "?"})`).join(", ") || "none seen"}`,
                    `prices: ${prices.map ? Object.keys(prices.map).length : 0} items · ${prices.at ? "fetched " + fmtTime(prices.at) : "not fetched this session"}${prices.error ? " · " + prices.error : ""}`,
                    `record: ${state.record ? JSON.stringify(state.record.stats()) : "none"} · timeline ${state.timeline.length} events · device ${DEVICE} · v${VERSION}`,
                    `held keys and chests: ${[...state.inventory.values()].filter(r => r.itemLocationHrid === INV && (ref.keyItems.has(r.itemHrid) || ref.chestItems[r.itemHrid])).map(r => `${r.count}× ${itemName(r.itemHrid)}`).join(", ") || "none"}`,
                    `messages this session: ${byType || "none yet"}`,
                ].join("\n");
            }
        }
        return { refresh, touch, render, moneyCtx, meterPing, dock: () => ({ docked: !!dock.strip, active: dock.active, worked: dock.worked }), show: () => setOpen(true) };
    })();

    function download(name, text) { const blob = new Blob([text], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }
    const stamp = () => { const d = new Date(); return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`; };
    async function exportRecord() {
        if (!state.record) return;
        await state.record.flush();
        const [events, runs, xp, meta] = await Promise.all([state.record.getAll("events", "at"), state.record.getAll("runs"), state.record.getAll("xp"), state.record.getAll("meta")]);
        download(`metz-dungeon-stats-${(state.characterName || state.characterId || "character").replace(/[^\w-]+/g, "_")}-${stamp()}.json`, JSON.stringify({ schema: "metz-dungeon-stats/1", version: VERSION, exportedAt: serverNow(), device: DEVICE, character: { id: state.characterId, name: state.characterName }, meta: meta.filter(r => r.key !== "ledger"), events, runs, xp }, null, 1));
    }
    async function exportFrames() {
        if (!state.record) return;
        await state.record.flush();
        const frames = await state.record.getAll("frames");
        download(`metz-dungeon-stats-frames-${stamp()}.json`, JSON.stringify({ schema: "metz-dungeon-stats-frames/1", version: VERSION, exportedAt: serverNow(), gameVersion: ref.version, messageCounts: Object.fromEntries(state.counts.byType), frames }, null, 1));
    }
    // The damage meter's data alone (operator, 2026-11-23: no need to keep testing data): saved sessions, the totals
    // per place, the session in progress and the battle tab's running total. The rest of the record is untouched.
    async function resetDamage() {
        if (!state.record) return;
        if (!W.confirm(t("Delete all damage meter data: {n} saved sessions, the totals per place and the run in progress? Runs, loot, XP and everything else stay.", { n: state.damage.length }))) return;
        for (const e of state.damage) state.record.remove("events", e.id);
        state.damage = []; state.meta.damagePartial = {}; state.streak = null;
        state.record.queue("meta", { key: "damagePartial", value: {} }); state.record.queue("meta", { key: "meterOpen", value: null });
        meterNoStreakBattle = (state.meter.session && state.meter.session.battleId) ?? (meterLast && meterLast.battleId) ?? null;
        meterLast = null;   // the next wave of this battle opens a fresh session
        state.meter.restore(null);
        state.events = state.events.filter(e => e.kind !== "damage");
        await state.record.flush();
        panel.render();
    }
    async function resetRecord() {
        if (!state.record) return;
        if (!W.confirm(t("Delete this character's whole Dungeon Stats record? Export it first if you want to keep it."))) return;
        await state.record.flush(); await state.record.clearAll();
        state.meta = {}; state.events = []; state.timeline = []; state.timelineRev++; state.consumeTotals.clear(); state.damage = []; state.lootLog.clear(); state.lootLogRev++; state.marketHistory.clear(); state.chatSeen.clear(); state.counts.events = 0; state.ledger.clear(); state.keyLots.clear(); keyAverages.clear(); state.run = null;
        panel.render();
    }

    // <locales>
    // Our words in the game's languages, keyed by the English (generated by i18n/merge-locales.mjs
    // from the translators' files, placeholders checked). A string missing here shows in English.
    // Kept as JSON text and parsed only for the language in use (i18nTable): reading text costs the browser almost
    // nothing, building eight dictionaries at every page load did. The English strings are listed ONCE; a language
    // is the list of its translations in the same order (null = shown in English), which is a third of the size of
    // eight dictionaries each repeating every English key (operator, 2026-11-23).
    I18N_KEYS_SRC = "[\"(blank)\",\"(rejoined after a reload)\",\"({items} unpriced)\",\"({n} in key crafts)\",\"+ Chest coins {a}\",\"+ {a} Coins\",\"+{n} on order\",\"A budget of {budget} buys {n} {key} ({crafts}) for {total}\",\"A budget of {budget} does not cover one {key}\",\"A run lasts from one party key-count message to the next, the way Toolasha counts it; cancelled runs are left out of the average. Runs while you were offline come from the party chat, their chests from the login summary.\",\"Abilities\",\"Ability\",\"Action\",\"Active time\",\"All runs\",\"Ask\",\"At start\",\"Attacks or ticks that took HP\",\"Attacks that took no HP: missed, dodged or blocked\",\"Auto attack\",\"Average run\",\"Avg price\",\"Best rate\",\"Between runs\",\"Bid at open\",\"Bid now\",\"Bloom\",\"Books the next level takes, at the game's XP per book\",\"Books to next\",\"Bought\",\"Bought total\",\"Bought {a} as stock, charged as used\",\"Budget\",\"Buy\",\"Capture log\",\"Checked\",\"Checked {a} of {b} finished waves: every monster seen at 0 HP and every point credited to a player.\",\"Chest\",\"Chest keys {a}\",\"Chests\",\"Chests earned\",\"Chests tab\",\"Clears\",\"Click a column header to sort by it; click again to reverse, a third time for the table's own order.\",\"Click a player for their abilities: damage, uses, hits, misses and healing, then where their damage taken came from and what healed them. Damage is the HP the monsters lost, read from the game's battle messages: overkill is not counted. DPS runs over time in combat: from the first wave's start to the last hit, without a break between waves. A dungeon run is listed here only when the script saw it from wave 1 to its end (a reload in the middle of a wave is stitched back in; installing an update reloads the page, so that run is cut). On a planet a session runs until the battle changes, across reloads. Runs seen only in part still count: pick that dungeon's totals in the Session list. Parry and thorns are counter-attacks; damage over time is put on the ability that applied it. Healing done counts heal abilities, Life Drain and Bloom; everything else a player regained (regeneration, food, passives) shows under Healed. Click a session below to show it.\",\"Click for {name}'s abilities\",\"Click to open in the marketplace.\",\"Close\",\"Close (Esc)\",\"Coins\",\"Coins to spend on materials and the recipe's coins; follows your bag until you type a figure\",\"Colours of the key and consumable times and warnings in the battle window.\",\"Column and card order\",\"Combat skills\",\"Combat skills, from the game's Loot & XP Log\",\"Combat time\",\"Consumables\",\"Consumables {a}\",\"Contents\",\"Copy shopping list\",\"Cost\",\"Cost per key\",\"Cost per key = the average of the key crafts this record has seen (materials at their purchase price, plus the recipe's coins); until one is seen, the recipe at the materials' purchase prices (asks for materials never bought) with every input cut by the game's artisan rate (tea × Guzzling Pouch, as the game reports it) plus the tea's share of the craft time, and the key's own ask only when a material has no price at all. Keys held before the record began are priced the same way. Used at cost charges each live clear the exact lot it took; offline and older clears use the craft average. At start = held when the record began, priced at ask then.\",\"Count owned materials\",\"Counts as of the last wave, for everyone in the battle. Under each count: how long it lasts at the rate that player has used it since this page opened (– until 10 minutes and one use). Entry keys are from the game's party message at each run start, at the dungeon's average run time.\",\"Cowbells\",\"Crafted\",\"Crafted all time\",\"Crafting cost {cost} per key at ask\",\"Crafting {a}\",\"Current run\",\"Current session\",\"DPS\",\"Damage\",\"Damage dealt {n}\",\"Damage meter\",\"Damage over time\",\"Damage sessions\",\"Damage tab\",\"Damage taken {n}\",\"Damage {n}\",\"Data\",\"Data tab\",\"Day\",\"Days\",\"Deaths\",\"Delete all damage meter data: {n} saved sessions, the totals per place and the run in progress? Runs, loot, XP and everything else stay.\",\"Delete every saved damage session and total; the rest of the record stays\",\"Delete this character's whole Dungeon Stats record? Export it first if you want to keep it.\",\"Details\",\"Diagnostics\",\"Dismiss for this session\",\"Drag a column header onto another, or a card onto another, to move it. Every table and the card grids remember their own order.\",\"Drag a tab onto another to move it.\",\"Drag to resize the players' and monsters' sides; double-click for an even split\",\"Drag to set this column's width; double-click for automatic\",\"Drink 1\",\"Drink 2\",\"Drink 3\",\"Dropped\",\"Dungeon\",\"Dungeon tokens\",\"Dungeons\",\"Dungeons, from the game's Loot & XP Log\",\"Each session counts for the combat skill it trained: the one with the most XP in it\",\"End\",\"Enemies hit: an area ability counts each enemy it hits\",\"Entry keys\",\"Entry keys {a}\",\"Essence\",\"Every HP this player regained: heals, Life Drain, regeneration, food and passives\",\"Every saved session, in Dungeon Stats\",\"Every whole session here plus the runs seen only in part (joined mid-run, or a wave missed): useful for averages, not kept as sessions of their own\",\"Everything gained is sold, held, listed or kept.\",\"Everything here is saved in this browser only. Below, untick a column to hide it in that table; the Runs table's Seen by (sources and notes) is off by default, and a run with a note then shows a small flag next to its result.\",\"Experience per hour, all skills; hover a value for each skill\",\"Export raw frames\",\"Export record (JSON)\",\"Fastest {a}\",\"Fetch the marketplace prices again now\",\"Finished waves in which every monster was seen going to 0 HP and every point was credited to a player\",\"First\",\"Follow the coins in the bag again\",\"Food\",\"Food 1\",\"Food 2\",\"Food 3\",\"Food and drinks\",\"From\",\"Gained\",\"Game: XP\",\"Game: count\",\"Game: drops\",\"General\",\"HP cost on auto attacks\",\"HP cost with {ability}\",\"HP left standing or not credited, over the waves that did not check out\",\"Healed\",\"Healed {n}\",\"Healing\",\"Healing done\",\"Held\",\"Held at bid\",\"Held at cost\",\"Held loot {a} at bid\",\"Held value\",\"Held × per token; the holdover's worth beneath it, not counted\",\"Hide\",\"Hide the meter here; Dungeon Stats Settings brings it back\",\"Hits\",\"Holdover\",\"Import Toolasha history\",\"Import record file…\",\"In dungeons\",\"In the bag before the record began\",\"In the bag before the record began; sellable from here, but not counted in held loot or net\",\"Item\",\"Keep how many {item} for future runs? (now {n}; 0 clears it)\",\"Keep…\",\"Kept\",\"Key\",\"Key and consumable times: amber under\",\"Key cost\",\"Key crafting\",\"Key crafts\",\"Key crafts, from the game's Loot & XP Log\",\"Keys\",\"Keys in the record\",\"Keys tab\",\"Keys wanted\",\"Kind\",\"Larger\",\"Last\",\"Lasts about {time} at {run} a run\",\"Ledger cost\",\"Level\",\"Life steal\",\"Lifetime\",\"Lifetime tab\",\"Listed\",\"Loot\",\"Loot = what this record saw come out of a chest or a token redemption. Held = in the bag now; Listed = on your sell orders. No longer held = gained − sold − opened − held − listed − kept, valued at the current bid less {a} tax; a bid that moved more than {b} since opening (or no bid) is marked for review and left out of the totals until accepted. Accepting freezes that value as a recorded event.\",\"Loot at open\",\"Loot no longer held\",\"Loot tab\",\"Loot to sell\",\"Mana\",\"Mana gained {n}\",\"Mana leech\",\"Mana spent {n}\",\"Material\",\"Materials\",\"Materials bought on this PC\",\"Merge a market history file from another PC: Toolasha's listing array (JSON) or its Market History CSV\",\"Merge market history file…\",\"Merge this character's record exported on another PC: events by id, replayed chat and listing fills matched so nothing counts twice\",\"Meter columns\",\"Metz Dungeon Stats\",\"Misses\",\"Missing\",\"Need\",\"Net\",\"Newest first. * keys charged read from the party key counts (no clear message seen). † XP counted from when the script joined the run. ↰ the run was under way when the record started.\",\"Newest first. Source = the game message the event came from. Consumable uses are recorded but shown only under \\\"consume\\\".\",\"Newest first. Value at bid = each item's highest bid when the chest was opened; a dungeon token is worth the best bid per token among the shop items it buys (an opening from before 0.1.2 takes those bids from the nearest opening that recorded them); counted items (cowbells) and unpriced items carry no value. Key cost = the chest key's lot cost; a basis of ask means the key was held before the record began.\",\"No battle seen on this page yet.\",\"No combat sessions in the log yet: open the game's Loot & XP Log once.\",\"No key crafts in the log yet.\",\"No longer held {a}\",\"No run time for this dungeon yet\",\"No sessions yet: open the game's Loot & XP Log once.\",\"Nothing recorded yet.\",\"Nothing to review.\",\"Now\",\"Off: battle messages are not read at all, nothing is recorded, and the meter and the Damage tab are hidden. For slow PCs. Sessions already saved are kept.\",\"Offline {a}\",\"One run is in progress.\",\"Open crafting page\",\"Open in the marketplace\",\"Open the game's Loot & XP Log once (Moo Pass) and its sessions appear here; Toolasha's saved history is merged at login.\",\"Open the game's Loot & XP Log once this session (Combat → Loot & XP Log) so the record can check its clears and chests against the game's own count.\",\"Openings\",\"Opens the game's buy window with {n} filled in\",\"Other\",\"Other (passives, lifesteal)\",\"Other (unidentified)\",\"Other sales {a} not counted\",\"Other {a}\",\"Over time\",\"Overview\",\"Own actions (HP cost)\",\"Owned\",\"Parry\",\"Party DPS\",\"Party consumables\",\"Party damage\",\"Party drink slot {n}\",\"Party entry keys\",\"Party food slot {n}\",\"Per clear\",\"Per key\",\"Per second\",\"Per second in combat\",\"Per token\",\"Player\",\"Price to next\",\"Re-price stock held at record start from your own purchases and catch up fills the script did not see\",\"Received\",\"Recipe\",\"Record damage\",\"Recorded before the breakdown (update 0.2.1)\",\"Redeemed\",\"Refresh prices\",\"Regeneration (every 10 s)\",\"Regeneration, food and passives\",\"Reset\",\"Reset card order\",\"Reset column order\",\"Reset damage data\",\"Reset record\",\"Result\",\"Review\",\"Run time\",\"Runs\",\"Runs tab\",\"Saved runs (seen from start to end), newest first\",\"Saved sessions (seen from start to end), newest first\",\"Scales every size in the panel, {a} to {b} in steps of {c}.\",\"Seen by\",\"Session\",\"Sessions\",\"Sessions in the game's Loot & XP Log\",\"Settings\",\"Share\",\"Show\",\"Show the meter under the battle cards (Combat → Battle)\",\"Showing every run since the party went into combat, on this page. Click to show this run only\",\"Showing this run only. Click to show every run since the party went into combat\",\"Since record\",\"Since the record began\",\"Since {date}.\",\"Skill\",\"Skills\",\"Slowest {a}\",\"Smaller\",\"Sold\",\"Sold net\",\"Sold {a}\",\"Source\",\"Spent\",\"Start\",\"Status\",\"Summary\",\"Supplies kept for future runs\",\"Taken\",\"Text size\",\"The Damage tab keeps every session either way.\",\"The best coins per token any shop item costing only this token sells for at bid, net of tax (the site's rule)\",\"The dungeon and tier where this skill's rate was highest, over at least an hour of sessions training it\",\"The game's own log (server-side, complete across devices), merged with Toolasha's saved copy: {n} sessions\",\"The game's own log, one row per action session: its count (dungeon clears, or keys crafted), its drops and XP, offline included. \\\"This record\\\" counts the clears and chests this record has for the same span; ≠ marks a difference, highlighted once the session is over. The game's count is the reference; this record only adds times and costs the log does not have.\",\"This record\",\"This record only: open the Loot & XP Log for the game's count\",\"This run\",\"Thorns (damage sent back)\",\"Thorns and retaliation\",\"Those books at the marketplace ask\",\"Time\",\"Time in combat the meter has counted\",\"Time in sessions\",\"Time in sessions is the log's start-to-end, so XP / h is per hour of the action running, offline included. Market history is per device, merged here by listing id from this PC's Toolasha store and any file merged on the Data tab ({n} listings); the cost per key takes the average paid price in that history (a price holds whatever share was bought on one PC) with recipe quantities at your current artisan rate, since the log has no consumption per craft; no lifetime income is shown until the records from both PCs are merged (import, milestone 5).\",\"Times\",\"Times this source restored HP\",\"Times this source restored MP\",\"Times used. Parry, thorns and damage over time are not cast\",\"Today\",\"Token\",\"Totals per place (every run seen, full or in part)\",\"Unknown place\",\"Use bag coins\",\"Used\",\"Used at cost\",\"Used by crafts\",\"Used in the record\",\"Uses\",\"Uses the game's own navigation\",\"Value (net of tax)\",\"Value at bid\",\"Waiting for the game's skill totals.\",\"Waves\",\"What\",\"What the script could not settle\",\"What this player's heal abilities and Life Drain restored\",\"Where\",\"XP per hour since {time} ago\",\"XP since the record began is the game's lifetime total now less the total when the record started, so it is exact whether or not the script was running, offline play included. XP per hour runs over active time: the time between XP messages when the gap is 15 minutes or less, plus offline time that earned XP. Days are on your own clock.\",\"XP tab\",\"XP/hr\",\"Your damage\",\"Your share\",\"against {ask} to buy a key\",\"artisan {pct}\",\"as many as the budget buys\",\"between runs\",\"buying saves {n}\",\"cancelled\",\"checked {a} of {b} finished waves\",\"cleared\",\"consumables used {n} ({cost} at purchase price, recent events)\",\"craft price\",\"crafting saves {n}\",\"cut short\",\"ended\",\"ended early\",\"enough owned\",\"failed\",\"fetching…\",\"from {date}\",\"hours\",\"in progress\",\"login summary · {a} runs in the chat ledger\",\"loot log\",\"next level in {time}\",\"no artisan tea slotted\",\"no record yet\",\"on order\",\"party {n} ({dps} DPS)\",\"paused\",\"prices as of {date}\",\"prices not fetched yet\",\"prices: {error}\",\"record since {date}\",\"red under\",\"slotted now\",\"stitched after a reload\",\"totals: {n} full run\",\"totals: {n} full runs\",\"value at bid {a} (tokens {b}) · keys {c}\",\"value at bid {a} · keys {b}\",\"waiting for login\",\"wave {n}\",\"waves {a}–{b}\",\"went quiet\",\"within the budget of {budget}\",\"{ability} over time\",\"{a} Cancelled\",\"{a} Chest, {b} Refine\",\"{a} Chests from inside them\",\"{a} DPS\",\"{a} Dungeon chests opened, at bid\",\"{a} Failed ({b})\",\"{a} Items\",\"{a} Refine, {b} Chest\",\"{a} Tax ({b})\",\"{a} abilities\",\"{a} ability\",\"{a} at craft price\",\"{a} consumables and {b} key materials priced at ask, {c} key types, {d} chest types · {e} coins\",\"{a} counting fails\",\"{a} day\",\"{a} days\",\"{a} dungeon\",\"{a} dungeons\",\"{a} event\",\"{a} events\",\"{a} item\",\"{a} items\",\"{a} key\",\"{a} keys\",\"{a} material\",\"{a} materials\",\"{a} of it Tokens, at the best shop bid per token\",\"{a} of {b} recorded\",\"{a} opening\",\"{a} openings\",\"{a} redeemed\",\"{a} run\",\"{a} runs\",\"{a} session\",\"{a} sessions\",\"{a} skill\",\"{a} skills\",\"{a} so far\",\"{a} source\",\"{a} token\",\"{a} tokens\",\"{a} used\",\"{a} used ({b} offline) · {c} unpriced\",\"{dmg} damage · {share} of the party · {dps} DPS · taken {taken} · healed {healed}\",\"{name} has {n} keys\",\"{name} is out of keys\",\"{name} is out of {item}\",\"{name} out of keys in {time}\",\"{name} out of {item} in {time}\",\"{name}'s damage\",\"{name}'s {ability}\",\"{n} HP unexplained\",\"{n} HP unexplained.\",\"{n} abilities\",\"{n} ability\",\"{n} craft\",\"{n} crafts\",\"{n} death\",\"{n} deaths\",\"{n} each at purchase price\",\"{n} events\",\"{n} finished + this one since {time}\",\"{n} finished since {time}\",\"{n} for review\",\"{n} held\",\"{n} not credited\",\"{n} not credited.\",\"{n} of it in buy orders\",\"{n} partly seen run\",\"{n} partly seen runs\",\"{n} runs\",\"{n} source\",\"{n} sources\",\"{n} used in the record\",\"{n} waves\",\"{n} {key} = {crafts}, {total} to buy\",\"{over} over the budget of {budget}\",\"{result}, closing\",\"{time} in combat\",\"· click for details\",\"− Spent {a}\"]";
    Object.assign(I18N_SRC, {
        "es": "[\"(vacío)\",\"(reincorporado tras una recarga)\",\"({items} sin precio)\",\"({n} en fabricación de llaves)\",\"+ Monedas de cofres {a}\",\"+ {a} Monedas\",\"+{n} en pedido\",\"Un presupuesto de {budget} compra {n} {key} ({crafts}) por {total}\",\"Un presupuesto de {budget} no alcanza para una {key}\",\"Una vuelta va de un mensaje de recuento de llaves del grupo al siguiente, como la cuenta Toolasha; las vueltas canceladas quedan fuera de la media. Las vueltas hechas sin conexión salen del chat del grupo, y sus cofres del resumen de inicio de sesión.\",\"Habilidades\",\"Habilidad\",\"Acción\",\"Tiempo activo\",\"Todas las vueltas\",\"Venta\",\"Al inicio\",\"Ataques o pulsos que quitaron HP\",\"Ataques que no quitaron HP: fallados, esquivados o bloqueados\",\"Ataque automático\",\"Vuelta media\",\"Precio medio\",\"Mejor ritmo\",\"Entre vueltas\",\"Compra al abrir\",\"Compra ahora\",\"Floración\",\"Libros que requiere el siguiente nivel, con la XP por libro del juego\",\"Libros al siguiente\",\"Comprado\",\"Total comprado\",\"Comprado {a} como existencias, cargado al usarse\",\"Presupuesto\",\"Comprar\",\"Registro de captura\",\"Comprobado\",\"Comprobadas {a} de {b} oleadas terminadas: cada monstruo visto a 0 HP y cada punto atribuido a un jugador.\",\"Cofre\",\"Llaves de cofre {a}\",\"Cofres\",\"Cofres obtenidos\",\"Pestaña Cofres\",\"Vueltas completadas\",\"Haz clic en un encabezado de columna para ordenar por ella; otro clic invierte el orden y un tercero vuelve al orden propio de la tabla.\",\"Haz clic en un jugador para ver sus habilidades: daño, usos, aciertos, fallos y curación, y después de dónde vino el daño recibido y qué lo curó. El daño es el HP que perdieron los monstruos, leído de los mensajes de batalla del juego: el daño excedente no cuenta. El DPS se calcula sobre el tiempo en combate: desde el inicio de la primera oleada hasta el último golpe, sin pausa entre oleadas. Una vuelta de mazmorra aparece aquí solo si el script la vio desde la oleada 1 hasta el final (una recarga en mitad de una oleada se vuelve a unir; instalar una actualización recarga la página, así que esa vuelta se corta). En un planeta una sesión dura hasta que cambia la batalla, a través de recargas. Las vueltas vistas solo en parte siguen contando: elige los totales de esa mazmorra en la lista de sesiones. Parada y espinas son contraataques; el daño en el tiempo se asigna a la habilidad que lo aplicó. La curación realizada cuenta las habilidades de curación, Drenar Vida y Floración; todo lo demás que recuperó un jugador (regeneración, comida, pasivas) aparece en Curado. Haz clic en una sesión de abajo para mostrarla.\",\"Clic para ver las habilidades de {name}\",\"Clic para abrir en el mercado.\",\"Cerrar\",\"Cerrar (Esc)\",\"Monedas\",\"Monedas para gastar en materiales y en las monedas de la receta; sigue tu bolsa hasta que escribas una cifra\",\"Colores de los tiempos y avisos de llaves y consumibles en la ventana de batalla.\",\"Orden de columnas y tarjetas\",\"Habilidades de combate\",\"Habilidades de combate, del Registro de botín y EXP del juego\",\"Tiempo de combate\",\"Consumibles\",\"Consumibles {a}\",\"Contenido\",\"Copiar lista de compra\",\"Coste\",\"Coste por llave\",\"Coste por llave = la media de las fabricaciones de llaves que ha visto este registro (materiales a su precio de compra, más las monedas de la receta); hasta ver una, la receta a los precios de compra de los materiales (precio de venta para materiales nunca comprados) con cada ingrediente reducido por la tasa de artesano del juego (té × Bolsa Devoradora, tal como lo indica el juego) más la parte del té en el tiempo de fabricación, y el precio de venta de la propia llave solo cuando un material no tiene precio. Las llaves que se tenían antes de empezar el registro se valoran igual. Usado al coste carga a cada vuelta completada en vivo el lote exacto que usó; las vueltas sin conexión y las antiguas usan la media de fabricación. Al inicio = lo que se tenía al empezar el registro, valorado al precio de venta de entonces.\",\"Contar materiales propios\",\"Cantidades a la última oleada, para todos en la batalla. Bajo cada cantidad: cuánto dura al ritmo al que ese jugador la ha usado desde que se abrió esta página (– hasta 10 minutos y un uso). Las llaves de entrada vienen del mensaje de grupo del juego al inicio de cada partida, al tiempo medio de partida de la mazmorra.\",\"Cencerros\",\"Fabricado\",\"Fabricado en total\",\"Coste de fabricación {cost} por llave a precio de venta\",\"Fabricación {a}\",\"Vuelta actual\",\"Sesión actual\",null,\"Daño\",\"Daño infligido {n}\",\"Medidor de daño\",\"Daño en el tiempo\",\"Sesiones de daño\",\"Pestaña Daño\",\"Daño recibido {n}\",\"Daño {n}\",\"Datos\",\"Pestaña Datos\",\"Día\",\"Días\",\"Muertes\",\"¿Borrar todos los datos del medidor de daño: {n} sesiones guardadas, los totales por lugar y la vuelta en curso? Las vueltas, el botín, la XP y todo lo demás se conservan.\",\"Borrar todas las sesiones y totales de daño guardados; el resto del registro se conserva\",\"¿Borrar todo el registro de Dungeon Stats de este personaje? Expórtalo antes si quieres conservarlo.\",\"Detalles\",\"Diagnóstico\",\"Ocultar durante esta sesión\",\"Arrastra un encabezado de columna sobre otro, o una tarjeta sobre otra, para moverlo. Cada tabla y cada cuadrícula de tarjetas recuerda su propio orden.\",\"Arrastra una pestaña sobre otra para moverla.\",\"Arrastra para cambiar el ancho del lado de los jugadores y el de los monstruos; doble clic para repartirlo a partes iguales\",\"Arrastra para fijar el ancho de esta columna; doble clic para automático\",\"Bebida 1\",\"Bebida 2\",\"Bebida 3\",\"Obtenido\",\"Mazmorra\",\"Fichas de mazmorra\",\"Mazmorras\",\"Mazmorras, del Registro de botín y EXP del juego\",\"Cada sesión cuenta para la habilidad de combate que entrenó: la que más XP obtuvo en ella\",\"Fin\",\"Enemigos alcanzados: una habilidad de área cuenta cada enemigo que alcanza\",\"Llaves de entrada\",\"Llaves de entrada {a}\",\"Esencia\",\"Todo el HP que recuperó este jugador: curaciones, Drenar Vida, regeneración, comida y pasivas\",\"Todas las sesiones guardadas, en Dungeon Stats\",\"Todas las sesiones completas de aquí más las vueltas vistas solo en parte (unido a mitad de vuelta, o una oleada perdida): útil para medias, no se guardan como sesiones propias\",\"Todo lo obtenido está vendido, en posesión, publicado o reservado.\",\"Todo lo de aquí se guarda solo en este navegador. Abajo, desmarca una columna para ocultarla en esa tabla; la columna Visto por (fuentes y notas) de la tabla Vueltas está desactivada por defecto, y una vuelta con nota muestra entonces una pequeña bandera junto a su resultado.\",\"Experiencia por hora, todas las habilidades; pasa el cursor sobre un valor para ver cada habilidad\",\"Exportar tramas sin procesar\",\"Exportar registro (JSON)\",\"Más rápida {a}\",\"Volver a obtener ahora los precios del mercado\",\"Oleadas terminadas en las que se vio a cada monstruo llegar a 0 HP y cada punto se atribuyó a un jugador\",\"Primera\",\"Volver a seguir las monedas de la bolsa\",\"Comida\",\"Comida 1\",\"Comida 2\",\"Comida 3\",\"Comida y bebidas\",\"Desde\",\"Obtenido\",\"Juego: XP\",\"Juego: recuento\",\"Juego: botín\",null,\"Coste de HP en ataques automáticos\",\"Coste de HP con {ability}\",\"HP que quedó en pie o sin atribuir, en las oleadas que no cuadraron\",\"Curado\",\"Curado {n}\",\"Curación\",\"Curación realizada\",\"En posesión\",\"En posesión a precio de compra\",\"En posesión al coste\",\"Botín en posesión {a} a precio de compra\",\"Valor en posesión\",\"En posesión × por ficha; debajo, el valor del remanente, no contado\",\"Ocultar\",\"Ocultar aquí el medidor; los Ajustes de Dungeon Stats lo recuperan\",\"Aciertos\",\"Remanente\",\"Importar historial de Toolasha\",\"Importar archivo de registro…\",\"En mazmorras\",\"En la bolsa antes de empezar el registro\",\"En la bolsa antes de empezar el registro; se puede vender desde aquí, pero no cuenta en el botín en posesión ni en el neto\",\"Objeto\",\"¿Cuántos {item} reservar para futuras vueltas? (ahora {n}; 0 lo borra)\",\"Reservar…\",\"Reservado\",\"Llave\",\"Tiempos de llaves y consumibles: ámbar por debajo de\",\"Coste de llave\",\"Fabricación de llaves\",\"Llaves fabricadas\",\"Llaves fabricadas, del Registro de botín y EXP del juego\",\"Llaves\",\"Llaves en el registro\",\"Pestaña Llaves\",\"Llaves deseadas\",\"Tipo\",\"Más grande\",\"Última\",\"Dura unas {time} a {run} por partida\",\"Coste contable\",\"Nivel\",\"Robo de vida\",\"Total histórico\",\"Pestaña Total histórico\",\"Publicado\",\"Botín\",\"Botín = lo que este registro vio salir de un cofre o de un canje de fichas. En posesión = en la bolsa ahora; Publicado = en tus órdenes de venta. Ya no en posesión = obtenido − vendido − abierto − en posesión − publicado − reservado, valorado al precio de compra actual menos {a} de impuesto; un precio de compra que se movió más de {b} desde la apertura (o sin precio de compra) se marca para revisión y queda fuera de los totales hasta aceptarlo. Aceptar congela ese valor como un evento registrado.\",\"Botín al abrir\",\"Botín ya no en posesión\",\"Pestaña Botín\",\"Botín para vender\",\"Maná\",\"Maná ganado {n}\",\"Absorción de maná\",\"Maná gastado {n}\",null,\"Materiales\",\"Materiales comprados en este PC\",\"Combinar un archivo de historial de mercado de otro PC: la lista de publicaciones de Toolasha (JSON) o su Market History CSV\",\"Combinar archivo de historial de mercado…\",\"Combinar el registro de este personaje exportado en otro PC: eventos por id, chat reproducido y ventas de publicaciones emparejados para que nada cuente dos veces\",\"Columnas del medidor\",null,\"Fallos\",\"Faltan\",\"Necesario\",\"Neto\",\"Más recientes primero. * llaves cargadas leídas de los recuentos de llaves del grupo (sin mensaje de vuelta completada). † XP contada desde que el script se unió a la vuelta. ↰ la vuelta estaba en curso cuando empezó el registro.\",\"Más recientes primero. Fuente = el mensaje del juego del que vino el evento. Los usos de consumibles se registran pero solo se muestran en \\\"consume\\\".\",\"Más recientes primero. Valor a precio de compra = el precio de compra más alto de cada objeto cuando se abrió el cofre; una ficha de mazmorra vale el mejor precio de compra por ficha entre los objetos de la tienda que compra (una apertura anterior a 0.1.2 toma esos precios de la apertura más cercana que los registró); los objetos contados (cencerros) y los objetos sin precio no tienen valor. Coste de llave = el coste del lote de la llave del cofre; una base de precio de venta significa que la llave se tenía antes de empezar el registro.\",\"Aún no se ha visto ninguna batalla en esta página.\",\"Aún no hay sesiones de combate en el registro: abre una vez el Registro de botín y EXP del juego.\",\"Aún no hay llaves fabricadas en el registro.\",\"Ya no en posesión {a}\",\"Aún no hay tiempo de partida para esta mazmorra\",\"Aún no hay sesiones: abre una vez el Registro de botín y EXP del juego.\",\"Aún no hay nada registrado.\",\"Nada que revisar.\",\"Ahora\",\"Desactivado: no se leen los mensajes de batalla, no se registra nada y el medidor y la pestaña Daño se ocultan. Para PC lentos. Las sesiones ya guardadas se conservan.\",\"Sin conexión {a}\",\"Hay una vuelta en curso.\",\"Abrir página de fabricación\",\"Abrir en el mercado\",\"Abre una vez el Registro de botín y EXP del juego (Moo Pass) y sus sesiones aparecerán aquí; el historial guardado de Toolasha se combina al iniciar sesión.\",\"Abre una vez en esta sesión el Registro de botín y EXP del juego (Combate → Registro de botín y EXP) para que el registro pueda comprobar sus vueltas completadas y cofres con el recuento del propio juego.\",\"Aperturas\",\"Abre la ventana de compra del juego con {n} ya puesto\",\"Otros\",\"Otros (pasivas, robo de vida)\",\"Otros (sin identificar)\",\"Otras ventas {a} no contadas\",\"Otros {a}\",\"Daño en el tiempo\",\"Resumen\",\"Acciones propias (coste de HP)\",\"En propiedad\",\"Parada\",\"DPS del grupo\",\"Consumibles del grupo\",\"Daño del grupo\",\"Bebida del grupo, ranura {n}\",\"Llaves de entrada del grupo\",\"Comida del grupo, ranura {n}\",\"Por vuelta completada\",\"Por llave\",\"Por segundo\",\"Por segundo en combate\",\"Por ficha\",\"Jugador\",\"Precio al siguiente\",\"Revalorar las existencias del inicio del registro con tus propias compras y recuperar las ventas que el script no vio\",\"Recibido\",\"Receta\",\"Registrar daño\",\"Registrado antes del desglose (actualización 0.2.1)\",\"Canjeado\",\"Actualizar precios\",\"Regeneración (cada 10 s)\",\"Regeneración, comida y pasivas\",\"Restablecer\",\"Restablecer orden de tarjetas\",\"Restablecer orden de columnas\",\"Restablecer datos de daño\",\"Restablecer registro\",\"Resultado\",\"Revisar\",\"Tiempo por vuelta\",\"Vueltas\",\"Pestaña Vueltas\",\"Vueltas guardadas (vistas de principio a fin), más recientes primero\",\"Sesiones guardadas (vistas de principio a fin), más recientes primero\",\"Escala todos los tamaños del panel, de {a} a {b} en pasos de {c}.\",\"Visto por\",\"Sesión\",\"Sesiones\",\"Sesiones en el Registro de botín y EXP del juego\",\"Ajustes\",\"Parte\",\"Mostrar\",\"Mostrar el medidor bajo las tarjetas de batalla (Combate → Batalla)\",\"Mostrando todas las vueltas desde que el grupo entró en combate, en esta página. Clic para mostrar solo esta vuelta\",\"Mostrando solo esta vuelta. Clic para mostrar todas las vueltas desde que el grupo entró en combate\",\"Desde el registro\",\"Desde que empezó el registro\",\"Desde {date}.\",\"Habilidad\",\"Habilidades\",\"Más lenta {a}\",\"Más pequeño\",\"Vendido\",\"Vendido neto\",\"Vendido {a}\",\"Fuente\",\"Gastado\",\"Inicio\",\"Estado\",\"Resumen\",\"Suministros reservados para futuras vueltas\",\"Daño recibido\",\"Tamaño de texto\",\"La pestaña Daño conserva todas las sesiones en cualquier caso.\",\"Las mejores monedas por ficha a las que se vende a precio de compra, neto de impuesto, cualquier objeto de la tienda que cueste solo esta ficha (la regla del sitio)\",\"La mazmorra y el nivel donde el ritmo de esta habilidad fue más alto, en al menos una hora de sesiones entrenándola\",\"El registro propio del juego (en el servidor, completo en todos los dispositivos), combinado con la copia guardada de Toolasha: {n} sesiones\",\"El registro propio del juego, una fila por sesión de acción: su recuento (vueltas de mazmorra completadas o llaves fabricadas), su botín y su XP, incluido el tiempo sin conexión. \\\"Este registro\\\" cuenta las vueltas completadas y cofres que este registro tiene en el mismo intervalo; ≠ marca una diferencia, resaltada cuando termina la sesión. El recuento del juego es la referencia; este registro solo añade tiempos y costes que el registro del juego no tiene.\",\"Este registro\",\"Solo este registro: abre el Registro de botín y EXP para ver el recuento del juego\",\"Esta vuelta\",\"Espinas (daño devuelto)\",\"Espinas y represalia\",\"Esos libros al precio de venta del mercado\",\"Tiempo\",\"Tiempo en combate que ha contado el medidor\",\"Tiempo en sesiones\",\"El tiempo en sesiones va del inicio al fin del registro del juego, así que XP / h es por hora de acción en marcha, incluido el tiempo sin conexión. El historial de mercado es por dispositivo y se combina aquí por id de publicación desde el almacén de Toolasha de este PC y cualquier archivo combinado en la pestaña Datos ({n} publicaciones); el coste por llave toma el precio medio pagado en ese historial (un precio vale para la parte que se compró en un PC) con las cantidades de la receta a tu tasa de artesano actual, ya que el registro no tiene el consumo por fabricación; no se muestran ingresos históricos hasta que se combinen los registros de ambos PC (importación, hito 5).\",\"Veces\",\"Veces que esta fuente restauró HP\",\"Veces que esta fuente restauró MP\",\"Veces usada. Parada, espinas y daño en el tiempo no se lanzan\",\"Hoy\",\"Ficha\",\"Totales por lugar (todas las vueltas vistas, completas o en parte)\",\"Lugar desconocido\",\"Usar monedas de la bolsa\",\"Usado\",\"Usado al coste\",\"Usado en fabricaciones\",\"Usado en el registro\",\"Usos\",\"Usa la navegación propia del juego\",\"Valor (neto de impuesto)\",\"Valor a precio de compra\",\"Esperando los totales de habilidades del juego.\",\"Oleadas\",\"Qué\",\"Lo que el script no pudo cuadrar\",\"Lo que restauraron las habilidades de curación y Drenar Vida de este jugador\",\"Dónde\",\"XP por hora desde hace {time}\",\"La XP desde que empezó el registro es el total histórico actual del juego menos el total al empezar el registro, así que es exacta tanto si el script estaba en marcha como si no, incluido el juego sin conexión. La XP por hora se calcula sobre el tiempo activo: el tiempo entre mensajes de XP cuando el intervalo es de 15 minutos o menos, más el tiempo sin conexión que ganó XP. Los días siguen tu propio reloj.\",\"Pestaña XP\",\"XP/h\",\"Tu daño\",\"Tu parte\",\"frente a {ask} por comprar una llave\",\"artesano {pct}\",\"tantas como permita el presupuesto\",\"entre vueltas\",\"comprar ahorra {n}\",\"cancelada\",\"comprobadas {a} de {b} oleadas terminadas\",\"completada\",\"consumibles usados {n} ({cost} a precio de compra, eventos recientes)\",\"precio de fabricación\",\"fabricar ahorra {n}\",\"interrumpida\",\"terminada\",\"terminada antes de tiempo\",\"suficientes en propiedad\",\"fallida\",\"obteniendo…\",\"desde {date}\",\"horas\",\"en curso\",\"resumen de inicio de sesión · {a} vueltas en el libro del chat\",\"registro de botín\",\"siguiente nivel en {time}\",\"sin té de artesano equipado\",\"aún sin registro\",\"en pedido\",\"grupo {n} ({dps} DPS)\",\"en pausa\",\"precios del {date}\",\"precios aún no obtenidos\",\"precios: {error}\",\"registro desde {date}\",\"rojo por debajo de\",\"equipado ahora\",\"unida tras una recarga\",\"totales: {n} vuelta completa\",\"totales: {n} vueltas completas\",\"valor a precio de compra {a} (fichas {b}) · llaves {c}\",\"valor a precio de compra {a} · llaves {b}\",\"esperando el inicio de sesión\",\"oleada {n}\",\"oleadas {a}–{b}\",\"sin actividad\",\"dentro del presupuesto de {budget}\",\"{ability} (daño en el tiempo)\",\"{a} Canceladas\",\"{a} Cofre, {b} Refinamiento\",\"{a} Cofres de su interior\",null,\"{a} Cofres de mazmorra abiertos, a precio de compra\",\"{a} Fallidas ({b})\",\"{a} Objetos\",\"{a} Refinamiento, {b} Cofre\",\"{a} Impuesto ({b})\",\"{a} habilidades\",\"{a} habilidad\",\"{a} a precio de fabricación\",\"{a} consumibles y {b} materiales de llaves valorados a precio de venta, {c} tipos de llave, {d} tipos de cofre · {e} monedas\",\"{a} contando las fallidas\",\"{a} día\",\"{a} días\",\"{a} mazmorra\",\"{a} mazmorras\",\"{a} evento\",\"{a} eventos\",\"{a} objeto\",\"{a} objetos\",\"{a} llave\",\"{a} llaves\",null,\"{a} materiales\",\"{a} de ello en Fichas, al mejor precio de compra de la tienda por ficha\",\"{a} de {b} registradas\",\"{a} apertura\",\"{a} aperturas\",\"{a} canjeado\",\"{a} vuelta\",\"{a} vueltas\",\"{a} sesión\",\"{a} sesiones\",\"{a} habilidad\",\"{a} habilidades\",\"{a} hasta ahora\",\"{a} fuente\",\"{a} ficha\",\"{a} fichas\",\"{a} usado\",\"{a} usado ({b} sin conexión) · {c} sin precio\",\"{dmg} de daño · {share} del grupo · {dps} DPS · recibido {taken} · curado {healed}\",\"{name} tiene {n} llaves\",\"{name} no tiene llaves\",\"{name} no tiene {item}\",\"{name} sin llaves en {time}\",\"{name} sin {item} en {time}\",\"Daño de {name}\",\"{ability} de {name}\",\"{n} HP sin explicar\",\"{n} HP sin explicar.\",\"{n} habilidades\",\"{n} habilidad\",\"{n} fabricación\",\"{n} fabricaciones\",\"{n} muerte\",\"{n} muertes\",\"{n} cada uno a precio de compra\",\"{n} eventos\",\"{n} terminadas + esta desde {time}\",\"{n} terminadas desde {time}\",\"{n} para revisar\",\"{n} en posesión\",\"{n} sin atribuir\",\"{n} sin atribuir.\",\"{n} de ello en órdenes de compra\",\"{n} vuelta vista en parte\",\"{n} vueltas vistas en parte\",\"{n} vueltas\",\"{n} fuente\",\"{n} fuentes\",\"{n} usados en el registro\",\"{n} oleadas\",\"{n} {key} = {crafts}, {total} si se compran\",\"{over} por encima del presupuesto de {budget}\",\"{result}, cerrando\",\"{time} en combate\",\"· clic para ver detalles\",\"− Gastado {a}\"]",
        "fr": "[\"(vide)\",\"(rejoint après un rechargement)\",\"({items} sans prix)\",\"({n} dans les fabrications de clés)\",\"+ Pièces des coffres {a}\",\"+ {a} Pièces\",\"+{n} en commande\",\"Un budget de {budget} achète {n} {key} ({crafts}) pour {total}\",\"Un budget de {budget} ne couvre pas une {key}\",\"Un passage va d'un message de décompte des clés du groupe au suivant, comme le compte Toolasha ; les passages annulés sont exclus de la moyenne. Les passages faits hors ligne viennent du chat du groupe, leurs coffres du résumé de connexion.\",\"Capacités\",\"Capacité\",null,\"Temps actif\",\"Tous les passages\",\"Vente\",\"Au départ\",\"Attaques ou ticks qui ont retiré des HP\",\"Attaques qui n'ont retiré aucun HP : ratées, esquivées ou bloquées\",\"Attaque automatique\",\"Passage moyen\",\"Prix moyen\",\"Meilleur taux\",\"Entre les passages\",\"Achat à l'ouverture\",\"Achat actuel\",\"Floraison\",\"Livres nécessaires pour le niveau suivant, à l'XP par livre du jeu\",\"Livres restants\",\"Acheté\",\"Total acheté\",\"{a} acheté en stock, imputé à l'usage\",null,\"Acheter\",\"Journal de capture\",\"Vérifié\",\"{a} vagues terminées sur {b} vérifiées : chaque monstre vu à 0 HP et chaque point crédité à un joueur.\",\"Coffre\",\"Clés de coffre {a}\",\"Coffres\",\"Coffres gagnés\",\"Onglet Coffres\",\"Réussis\",\"Cliquez sur un en-tête de colonne pour trier ; cliquez à nouveau pour inverser, une troisième fois pour revenir à l'ordre d'origine du tableau.\",\"Cliquez sur un joueur pour voir ses capacités : dégâts, utilisations, coups touchés, ratés et soins, puis l'origine des dégâts qu'il a subis et ce qui l'a soigné. Les dégâts sont les HP perdus par les monstres, lus dans les messages de combat du jeu : l'excédent sur un monstre achevé n'est pas compté. Le DPS se calcule sur le temps en combat : du début de la première vague au dernier coup, sans pause entre les vagues. Un passage de donjon n'apparaît ici que si le script l'a vu de la vague 1 à la fin (un rechargement au milieu d'une vague est recousu ; installer une mise à jour recharge la page, ce passage est donc coupé). Sur une planète, une session dure jusqu'à ce que le combat change, à travers les rechargements. Les passages vus en partie comptent quand même : choisissez les totaux de ce donjon dans la liste Session. Parade et Épines sont des contre-attaques ; les dégâts sur la durée sont attribués à la capacité qui les a appliqués. Les soins prodigués comptent les capacités de soin, Drain de Vie et Floraison ; tout ce qu'un joueur a regagné d'autre (régénération, nourriture, passifs) apparaît sous Soigné. Cliquez sur une session ci-dessous pour l'afficher.\",\"Cliquez pour les capacités de {name}\",\"Cliquez pour ouvrir au marché.\",\"Fermer\",\"Fermer (Esc)\",\"Pièces\",\"Pièces à dépenser en matériaux et en pièces de la recette ; suit votre sac jusqu'à ce que vous saisissiez un montant\",\"Couleurs des durées et alertes des clés et consommables dans la fenêtre de combat.\",\"Ordre des colonnes et des cartes\",\"Compétences de combat\",\"Compétences de combat, d'après le Suivi de butin et XP du jeu\",\"Temps de combat\",\"Consommables\",\"Consommables {a}\",\"Contenu\",\"Copier la liste d'achats\",\"Coût\",\"Coût par clé\",\"Coût par clé = la moyenne des fabrications de clés vues par ce registre (matériaux à leur prix d'achat, plus les pièces de la recette) ; tant qu'aucune n'a été vue, la recette aux prix d'achat des matériaux (prix de vente pour les matériaux jamais achetés), chaque ingrédient réduit par le taux d'artisan du jeu (thé × Sacoche Goulue, tel que le jeu l'indique), plus la part du thé dans le temps de fabrication, et le prix de vente de la clé elle-même seulement quand un matériau n'a aucun prix. Les clés détenues avant le début du registre sont évaluées de la même façon. Utilisé au coût impute à chaque passage réussi en direct le lot exact qu'il a pris ; les passages hors ligne et plus anciens utilisent la moyenne de fabrication. Au départ = détenu au début du registre, évalué au prix de vente d'alors.\",\"Compter les matériaux possédés\",\"Quantités à la dernière vague, pour tous les joueurs du combat. Sous chaque quantité : sa durée au rythme auquel ce joueur l'a utilisée depuis l'ouverture de cette page (– avant 10 minutes et une utilisation). Les clés d'entrée viennent du message de groupe du jeu au début de chaque run, au temps de run moyen du donjon.\",\"Cloches\",\"Fabriqué\",\"Fabriqué depuis toujours\",\"Coût de fabrication {cost} par clé au prix de vente\",\"Artisanat {a}\",\"Passage en cours\",\"Session en cours\",null,\"Dégâts\",\"Dégâts infligés {n}\",\"Compteur de dégâts\",\"Dégâts sur la durée\",\"Sessions de dégâts\",\"Onglet Dégâts\",\"Dégâts subis {n}\",\"Dégâts {n}\",\"Données\",\"Onglet Données\",\"Jour\",\"Jours\",\"Morts\",\"Supprimer toutes les données du compteur de dégâts : {n} sessions enregistrées, les totaux par lieu et le passage en cours ? Les passages, le butin, l'XP et tout le reste sont conservés.\",\"Supprimer toutes les sessions et tous les totaux de dégâts enregistrés ; le reste du registre est conservé\",\"Supprimer tout le registre Dungeon Stats de ce personnage ? Exportez-le d'abord si vous voulez le garder.\",\"Détails\",null,\"Masquer pour cette session\",\"Faites glisser un en-tête de colonne sur un autre, ou une carte sur une autre, pour la déplacer. Chaque tableau et chaque grille de cartes retient son propre ordre.\",\"Faites glisser un onglet sur un autre pour le déplacer.\",\"Faites glisser pour redimensionner le côté des joueurs et celui des monstres ; double-cliquez pour un partage égal\",\"Faites glisser pour fixer la largeur de cette colonne ; double-cliquez pour l'automatique\",\"Boisson 1\",\"Boisson 2\",\"Boisson 3\",\"Obtenu\",\"Donjon\",\"Jetons de donjon\",\"Donjons\",\"Donjons, d'après le Suivi de butin et XP du jeu\",\"Chaque session compte pour la compétence de combat qu'elle a entraînée : celle qui y a gagné le plus d'XP\",\"Fin\",\"Ennemis touchés : une capacité de zone compte chaque ennemi touché\",\"Clés d'entrée\",\"Clés d'entrée {a}\",null,\"Tous les HP regagnés par ce joueur : soins, Drain de Vie, régénération, nourriture et passifs\",\"Toutes les sessions enregistrées, dans Dungeon Stats\",\"Toutes les sessions complètes d'ici plus les passages vus en partie (rejoints en cours, ou une vague manquée) : utiles pour les moyennes, non conservés comme sessions à part\",\"Tout ce qui a été gagné est vendu, détenu, mis en vente ou gardé.\",\"Tout ici est enregistré dans ce navigateur uniquement. Ci-dessous, décochez une colonne pour la masquer dans ce tableau ; la colonne Vu par (sources et notes) du tableau Passages est désactivée par défaut, et un passage avec une note affiche alors un petit drapeau à côté de son résultat.\",\"Expérience par heure, toutes compétences ; survolez une valeur pour chaque compétence\",\"Exporter les trames brutes\",\"Exporter le registre (JSON)\",\"Plus rapide {a}\",\"Récupérer de nouveau les prix du marché maintenant\",\"Vagues terminées où chaque monstre a été vu tomber à 0 HP et chaque point a été crédité à un joueur\",\"Premier\",\"Suivre de nouveau les pièces du sac\",\"Nourriture\",\"Nourriture 1\",\"Nourriture 2\",\"Nourriture 3\",\"Nourriture et boissons\",\"De\",\"Gagné\",\"Jeu : XP\",\"Jeu : nombre\",\"Jeu : butin\",\"Général\",\"Coût en HP des attaques automatiques\",\"Coût en HP avec {ability}\",\"HP restants ou non crédités, sur les vagues qui n'ont pas été validées\",\"Soigné\",\"Soigné {n}\",\"Soins\",\"Soins prodigués\",\"Détenu\",\"Détenu au prix d'achat\",\"Détenu au coût\",\"Butin détenu {a} au prix d'achat\",\"Valeur détenue\",\"Détenu × par jeton ; la valeur du reliquat en dessous, non comptée\",\"Masquer\",\"Masquer le compteur ici ; les Paramètres de Dungeon Stats le rétablissent\",\"Touchés\",\"Reliquat\",\"Importer l'historique Toolasha\",\"Importer un fichier de registre…\",\"En donjon\",\"Dans le sac avant le début du registre\",\"Dans le sac avant le début du registre ; vendable d'ici, mais non compté dans le butin détenu ni dans le net\",\"Objet\",\"Garder combien de {item} pour les prochains passages ? (actuellement {n} ; 0 l'efface)\",\"Garder…\",\"Gardé\",\"Clé\",\"Durées des clés et consommables : orange sous\",\"Coût de la clé\",\"Fabrication de clés\",\"Fabrications de clés\",\"Fabrications de clés, d'après le Suivi de butin et XP du jeu\",\"Clés\",\"Clés dans le registre\",\"Onglet Clés\",\"Clés voulues\",\"Type\",\"Plus grand\",\"Dernier\",\"Dure environ {time} à {run} par run\",\"Coût comptable\",\"Niveau\",\"Vol de vie\",\"Depuis toujours\",\"Onglet Depuis toujours\",\"En vente\",\"Butin\",\"Butin = ce que ce registre a vu sortir d'un coffre ou d'un échange de jetons. Détenu = dans le sac maintenant ; En vente = dans vos ordres de vente. Plus détenu = gagné − vendu − ouvert − détenu − en vente − gardé, évalué au prix d'achat actuel moins {a} de taxe ; un prix d'achat qui a bougé de plus de {b} depuis l'ouverture (ou l'absence de prix d'achat) est marqué à vérifier et exclu des totaux jusqu'à acceptation. Accepter fige cette valeur comme un événement enregistré.\",\"Butin à l'ouverture\",\"Butin plus détenu\",\"Onglet Butin\",\"Butin à vendre\",null,\"Mana gagné {n}\",\"Drain de mana\",\"Mana dépensé {n}\",\"Matériau\",\"Matériaux\",\"Matériaux achetés sur ce PC\",\"Fusionner un fichier d'historique du marché d'un autre PC : le tableau d'annonces de Toolasha (JSON) ou son CSV Market History\",\"Fusionner un fichier d'historique du marché…\",\"Fusionner le registre de ce personnage exporté sur un autre PC : événements par identifiant, chat rejoué et exécutions d'annonces rapprochés pour que rien ne compte deux fois\",\"Colonnes du compteur\",null,\"Ratés\",\"Manquant\",\"Besoin\",null,\"Les plus récents d'abord. * clés imputées lues dans les décomptes de clés du groupe (aucun message de réussite vu). † XP comptée depuis que le script a rejoint le passage. ↰ le passage était en cours au début du registre.\",\"Les plus récents d'abord. Source = le message du jeu d'où vient l'événement. Les utilisations de consommables sont enregistrées mais affichées seulement sous « consume ».\",\"Les plus récents d'abord. Valeur au prix d'achat = le meilleur prix d'achat de chaque objet à l'ouverture du coffre ; un jeton de donjon vaut le meilleur prix d'achat par jeton parmi les objets de boutique qu'il achète (une ouverture antérieure à 0.1.2 reprend ces prix de l'ouverture la plus proche qui les a enregistrés) ; les objets comptés (cloches) et les objets sans prix n'ont pas de valeur. Coût de la clé = le coût du lot de la clé de coffre ; une base au prix de vente signifie que la clé était détenue avant le début du registre.\",\"Aucun combat vu sur cette page pour l'instant.\",\"Aucune session de combat dans le journal pour l'instant : ouvrez une fois le Suivi de butin et XP du jeu.\",\"Aucune fabrication de clé dans le journal pour l'instant.\",\"Plus détenu {a}\",\"Pas encore de temps de run pour ce donjon\",\"Aucune session pour l'instant : ouvrez une fois le Suivi de butin et XP du jeu.\",\"Rien d'enregistré pour l'instant.\",\"Rien à vérifier.\",\"Maintenant\",\"Désactivé : les messages de combat ne sont pas lus du tout, rien n'est enregistré, et le compteur et l'onglet Dégâts sont masqués. Pour les PC lents. Les sessions déjà enregistrées sont conservées.\",\"Hors ligne {a}\",\"Un passage est en cours.\",\"Ouvrir la page d'artisanat\",\"Ouvrir au marché\",\"Ouvrez une fois le Suivi de butin et XP du jeu (Moo Pass) et ses sessions apparaissent ici ; l'historique enregistré de Toolasha est fusionné à la connexion.\",\"Ouvrez une fois pendant cette session le Suivi de butin et XP du jeu (Combat → Suivi de butin et XP) pour que le registre puisse vérifier ses passages réussis et ses coffres par rapport au propre décompte du jeu.\",\"Ouvertures\",\"Ouvre la fenêtre d'achat du jeu avec {n} déjà saisi\",\"Autre\",\"Autre (passifs, vol de vie)\",\"Autre (non identifié)\",\"Autres ventes {a} non comptées\",\"Autre {a}\",\"Dégâts sur la durée\",\"Vue d'ensemble\",\"Propres actions (coût en HP)\",\"Possédé\",\"Parade\",\"DPS du groupe\",\"Consommables du groupe\",\"Dégâts du groupe\",\"Boisson du groupe, emplacement {n}\",\"Clés d'entrée du groupe\",\"Nourriture du groupe, emplacement {n}\",\"Par passage réussi\",\"Par clé\",\"Par seconde\",\"Par seconde en combat\",\"Par jeton\",\"Joueur\",\"Prix jusqu'au suivant\",\"Réévaluer le stock détenu au début du registre à partir de vos propres achats et rattraper les exécutions d'ordres que le script n'a pas vues\",\"Reçu\",\"Recette\",\"Enregistrer les dégâts\",\"Enregistré avant la ventilation (mise à jour 0.2.1)\",\"Échangé\",\"Actualiser les prix\",\"Régénération (toutes les 10 s)\",\"Régénération, nourriture et passifs\",\"Réinitialiser\",\"Réinitialiser l'ordre des cartes\",\"Réinitialiser l'ordre des colonnes\",\"Réinitialiser les données de dégâts\",\"Réinitialiser le registre\",\"Résultat\",\"Vérifier\",\"Temps par passage\",\"Passages\",\"Onglet Passages\",\"Passages enregistrés (vus du début à la fin), les plus récents d'abord\",\"Sessions enregistrées (vues du début à la fin), les plus récentes d'abord\",\"Met à l'échelle toutes les tailles du panneau, de {a} à {b} par pas de {c}.\",\"Vu par\",null,null,\"Sessions dans le Suivi de butin et XP du jeu\",\"Paramètres\",\"Part\",\"Afficher\",\"Afficher le compteur sous les cartes de combat (Combat → Combat)\",\"Affiche tous les passages depuis l'entrée en combat du groupe, sur cette page. Cliquez pour n'afficher que ce passage\",\"Affiche ce passage uniquement. Cliquez pour afficher tous les passages depuis l'entrée en combat du groupe\",\"Depuis le registre\",\"Depuis le début du registre\",\"Depuis le {date}.\",\"Compétence\",\"Compétences\",\"Plus lent {a}\",\"Plus petit\",\"Vendu\",\"Vendu net\",\"Vendu {a}\",null,\"Dépensé\",\"Début\",\"État\",\"Résumé\",\"Fournitures gardées pour les prochains passages\",\"Subis\",\"Taille du texte\",\"L'onglet Dégâts conserve toutes les sessions dans tous les cas.\",\"Le meilleur nombre de pièces par jeton qu'obtient au prix d'achat, net de taxe, un objet de boutique payé uniquement avec ce jeton (la règle du site)\",\"Le donjon et le palier où le taux de cette compétence a été le plus élevé, sur au moins une heure de sessions l'entraînant\",\"Le propre journal du jeu (côté serveur, complet sur tous les appareils), fusionné avec la copie enregistrée de Toolasha : {n} sessions\",\"Le propre journal du jeu, une ligne par session d'action : son nombre (passages de donjon réussis, ou clés fabriquées), son butin et son XP, hors ligne compris. « Ce registre » compte les passages réussis et les coffres que ce registre a pour la même période ; ≠ signale une différence, mise en évidence une fois la session terminée. Le décompte du jeu fait référence ; ce registre ajoute seulement les durées et les coûts que le journal n'a pas.\",\"Ce registre\",\"Ce registre uniquement : ouvrez le Suivi de butin et XP pour le décompte du jeu\",\"Ce passage\",\"Épines (dégâts renvoyés)\",\"Épines et riposte\",\"Ces livres au prix de vente du marché\",\"Temps\",\"Temps de combat compté par le compteur\",\"Temps en sessions\",\"Le temps en sessions va du début à la fin dans le journal, donc l'XP / h est par heure d'action en cours, hors ligne compris. L'historique du marché est propre à chaque appareil, fusionné ici par identifiant d'annonce depuis le stockage Toolasha de ce PC et tout fichier fusionné dans l'onglet Données ({n} annonces) ; le coût par clé prend le prix payé moyen de cet historique (un prix vaut quelle que soit la part achetée sur un seul PC) avec les quantités de la recette à votre taux d'artisan actuel, car le journal n'a pas la consommation par fabrication ; aucun revenu total n'est affiché tant que les registres des deux PC ne sont pas fusionnés (import, étape 5).\",\"Fois\",\"Nombre de fois où cette source a rendu des HP\",\"Nombre de fois où cette source a rendu des PM\",\"Nombre d'utilisations. Parade, Épines et dégâts sur la durée ne sont pas lancés\",\"Aujourd'hui\",\"Jeton\",\"Totaux par lieu (chaque passage vu, en entier ou en partie)\",\"Lieu inconnu\",\"Utiliser les pièces du sac\",\"Utilisé\",\"Utilisé au coût\",\"Utilisé par les fabrications\",\"Utilisé dans le registre\",\"Utilisations\",\"Utilise la navigation du jeu\",\"Valeur (nette de taxe)\",\"Valeur au prix d'achat\",\"En attente des totaux de compétences du jeu.\",\"Vagues\",\"Quoi\",\"Ce que le script n'a pas pu régler\",\"Ce qu'ont rendu les capacités de soin et le Drain de Vie de ce joueur\",\"Où\",\"XP par heure depuis {time}\",\"L'XP depuis le début du registre est le total à vie actuel du jeu moins le total au début du registre, elle est donc exacte que le script ait tourné ou non, jeu hors ligne compris. L'XP par heure se calcule sur le temps actif : le temps entre les messages d'XP quand l'écart est de 15 minutes ou moins, plus le temps hors ligne qui a rapporté de l'XP. Les jours suivent votre propre horloge.\",\"Onglet XP\",\"XP/h\",\"Vos dégâts\",\"Votre part\",\"contre {ask} pour acheter une clé\",null,\"autant que le budget le permet\",\"entre les passages\",\"acheter économise {n}\",\"annulé\",\"{a} vagues terminées sur {b} vérifiées\",\"réussi\",\"consommables utilisés {n} ({cost} au prix d'achat, événements récents)\",\"prix de fabrication\",\"fabriquer économise {n}\",\"interrompu\",\"terminé\",\"terminé tôt\",\"assez possédé\",\"échoué\",\"récupération…\",\"depuis le {date}\",\"heures\",\"en cours\",\"résumé de connexion · {a} passages dans le relevé du chat\",\"journal de butin\",\"niveau suivant dans {time}\",\"aucun thé d'artisan équipé\",\"pas encore de registre\",\"en commande\",\"groupe {n} ({dps} DPS)\",\"en pause\",\"prix au {date}\",\"prix pas encore récupérés\",\"prix : {error}\",\"registre depuis le {date}\",\"rouge sous\",\"équipé actuellement\",\"recousu après un rechargement\",\"totaux : {n} passage complet\",\"totaux : {n} passages complets\",\"valeur au prix d'achat {a} (jetons {b}) · clés {c}\",\"valeur au prix d'achat {a} · clés {b}\",\"en attente de connexion\",\"vague {n}\",\"vagues {a}–{b}\",\"silencieux\",\"dans le budget de {budget}\",\"{ability} (dégâts sur la durée)\",\"{a} Annulés\",\"{a} Coffre, {b} Raffinement\",\"{a} Coffres trouvés à l'intérieur\",null,\"{a} Coffres de donjon ouverts, au prix d'achat\",\"{a} Échoués ({b})\",\"{a} Objets\",\"{a} Raffinement, {b} Coffre\",\"{a} Taxe ({b})\",\"{a} capacités\",\"{a} capacité\",\"{a} au prix de fabrication\",\"{a} consommables et {b} matériaux de clé évalués au prix de vente, {c} types de clés, {d} types de coffres · {e} pièces\",\"{a} en comptant les échecs\",\"{a} jour\",\"{a} jours\",\"{a} donjon\",\"{a} donjons\",\"{a} événement\",\"{a} événements\",\"{a} objet\",\"{a} objets\",\"{a} clé\",\"{a} clés\",\"{a} matériau\",\"{a} matériaux\",\"dont {a} en Jetons, au meilleur prix d'achat de boutique par jeton\",\"{a} sur {b} enregistrés\",\"{a} ouverture\",\"{a} ouvertures\",\"{a} échangés\",\"{a} passage\",\"{a} passages\",null,null,\"{a} compétence\",\"{a} compétences\",\"{a} jusqu'ici\",null,\"{a} jeton\",\"{a} jetons\",\"{a} utilisés\",\"{a} utilisés ({b} hors ligne) · {c} sans prix\",\"{dmg} dégâts · {share} du groupe · {dps} DPS · subis {taken} · soigné {healed}\",\"{name} a {n} clés\",\"{name} n'a plus de clés\",\"{name} n'a plus de {item}\",\"{name} à court de clés dans {time}\",\"{name} à court de {item} dans {time}\",\"Dégâts de {name}\",\"{ability} de {name}\",\"{n} HP inexpliqués\",\"{n} HP inexpliqués.\",\"{n} capacités\",\"{n} capacité\",\"{n} fabrication\",\"{n} fabrications\",\"{n} mort\",\"{n} morts\",\"{n} chacun au prix d'achat\",\"{n} événements\",\"{n} terminés + celui-ci depuis {time}\",\"{n} terminés depuis {time}\",\"{n} à vérifier\",\"{n} détenus\",\"{n} non crédités\",\"{n} non crédités.\",\"dont {n} en ordres d'achat\",\"{n} passage vu en partie\",\"{n} passages vus en partie\",\"{n} passages\",null,null,\"{n} utilisés dans le registre\",\"{n} vagues\",\"{n} {key} = {crafts}, {total} à l'achat\",\"{over} au-delà du budget de {budget}\",\"{result}, fermeture\",\"{time} en combat\",\"· cliquez pour les détails\",\"− Dépensé {a}\"]",
        "ja": "[\"（空欄）\",\"（再読み込み後に再参加）\",\"（価格なし {items}）\",\"（鍵のクラフトに {n}）\",\"+ 宝箱のコイン {a}\",\"+ {a} コイン\",\"+{n} 注文中\",\"予算 {budget} で {key} を {n} 個（{crafts}）{total} で購入できます\",\"予算 {budget} では {key} を 1 個も賄えません\",\"1 周はパーティーの鍵カウントメッセージから次のメッセージまでです（Toolasha と同じ数え方）。中止された周回は平均から除外されます。オフライン中の周回はパーティーチャットから、その宝箱はログイン時の概要から取得します。\",\"アビリティ\",\"アビリティ\",\"行動\",\"稼働時間\",\"全周回\",\"売値\",\"開始時\",\"HP を削った攻撃または継続ダメージ\",\"HP を削れなかった攻撃：ミス・回避・ブロック\",\"通常攻撃\",\"平均周回\",\"平均価格\",\"最高効率\",\"周回の合間\",\"開封時の買値\",\"現在の買値\",\"ブルーム\",\"次のレベルに必要な本の数（ゲームの本 1 冊あたりの XP で計算）\",\"次までの本\",\"購入\",\"購入合計\",\"在庫として {a} 購入、使用時に計上\",\"予算\",\"購入\",\"取得ログ\",\"確認済み\",\"終了したウェーブ {b} 件中 {a} 件を確認：すべてのモンスターが HP 0 になり、すべてのダメージがプレイヤーに計上されました。\",\"宝箱\",\"宝箱鍵 {a}\",\"宝箱\",\"獲得した宝箱\",\"宝箱タブ\",\"クリア\",\"列見出しをクリックするとその列で並べ替えます。もう一度で逆順、3 回目で表の元の順序に戻ります。\",\"プレイヤーをクリックするとアビリティごとのダメージ・使用回数・命中・ミス・回復が表示され、続いて被ダメージの出どころと回復元が表示されます。ダメージはゲームの戦闘メッセージから読み取ったモンスターの HP 減少量で、オーバーキル分は数えません。DPS は戦闘時間で計算します：最初のウェーブの開始から最後の一撃まで、ウェーブ間の休憩は含みません。ダンジョンの周回は、スクリプトがウェーブ 1 から終了まで見ていた場合のみここに表示されます（ウェーブ途中の再読み込みはつなぎ直されます。アップデートのインストールはページを再読み込みするため、その周回は途切れます）。惑星では、セッションは再読み込みをまたいで戦闘が変わるまで続きます。一部しか見ていない周回も集計されます：セッション一覧でそのダンジョンの合計を選んでください。パリィととげは反撃です。継続ダメージはそれを付与したアビリティに計上されます。与えた回復は回復アビリティ・ライフドレイン・ブルームを数えます。それ以外にプレイヤーが回復した分（自然回復・食べ物・パッシブ）は「回復量」に表示されます。下のセッションをクリックすると表示します。\",\"クリックで {name} のアビリティを表示\",\"クリックでマーケットを開きます。\",\"閉じる\",\"閉じる（Esc）\",\"コイン\",\"素材とレシピのコインに使うコイン。数値を入力するまではバッグの所持コインに連動します\",\"戦闘画面のキーと消耗品の残り時間・警告の色。\",\"列とカードの並び順\",\"戦闘スキル\",\"戦闘スキル（ゲームのドロップ・経験記録より）\",\"戦闘時間\",\"消耗品\",\"消耗品 {a}\",\"中身\",\"買い物リストをコピー\",\"コスト\",\"鍵 1 個あたりのコスト\",\"鍵 1 個あたりのコスト = この記録が見た鍵クラフトの平均（素材は購入価格、レシピのコインを加算）。まだ見ていない間は、素材の購入価格（購入したことのない素材は売値）でのレシピを使い、すべての投入量をゲームの職人率（ゲームが表示する茶 × がぶ飲みポーチ）で減らし、クラフト時間に応じた茶の分を加えます。素材にまったく価格がない場合のみ鍵自体の売値を使います。記録開始前から持っていた鍵も同じ方法で価格付けします。「原価で使用」は、リアルタイムのクリアごとに実際に使ったロットの原価を計上します。オフラインや古いクリアはクラフト平均を使います。開始時 = 記録開始時に持っていた分で、その時点の売値で評価します。\",\"所持素材を数える\",\"最後のウェーブ時点での戦闘参加者全員の所持数。各数の下：このページを開いてからのそのプレイヤーの使用ペースでもつ時間（10 分かつ 1 回使用するまでは –）。入場キーは各周回開始時のゲームのパーティメッセージから、ダンジョンの平均周回時間で計算します。\",\"カウベル\",\"クラフト済み\",\"累計クラフト\",\"売値でのクラフトコスト：鍵 1 個あたり {cost}\",\"クラフト {a}\",\"現在の周回\",\"現在のセッション\",null,\"ダメージ\",\"与ダメージ {n}\",\"ダメージメーター\",\"継続ダメージ\",\"ダメージのセッション\",\"ダメージタブ\",\"被ダメージ {n}\",\"ダメージ {n}\",\"データ\",\"データタブ\",\"日\",\"日別\",\"死亡\",\"ダメージメーターのデータをすべて削除しますか：保存済みセッション {n} 件、場所ごとの合計、進行中の周回。周回・ドロップ・XP などその他はすべて残ります。\",\"保存済みのダメージセッションと合計をすべて削除します。記録のその他の部分は残ります\",\"このキャラクターの Dungeon Stats の記録をすべて削除しますか？残したい場合は先にエクスポートしてください。\",\"詳細\",\"診断\",\"このセッション中は表示しない\",\"列見出しを別の列見出しに、またはカードを別のカードにドラッグすると移動できます。各テーブルとカード一覧はそれぞれの並び順を記憶します。\",\"タブを別のタブにドラッグすると移動できます。\",\"ドラッグでプレイヤー側とモンスター側の幅を変更。ダブルクリックで均等に戻します\",\"ドラッグでこの列の幅を設定、ダブルクリックで自動\",\"ドリンク 1\",\"ドリンク 2\",\"ドリンク 3\",\"ドロップ\",\"ダンジョン\",\"ダンジョントークン\",\"ダンジョン\",\"ダンジョン（ゲームのドロップ・経験記録より）\",\"各セッションは鍛えた戦闘スキル（XP が最も多いスキル）に計上されます\",\"終了\",\"命中した敵の数：範囲アビリティは命中した敵ごとに数えます\",\"入場キー\",\"入場鍵 {a}\",\"エッセンス\",\"このプレイヤーが回復したすべての HP：回復・ライフドレイン・自然回復・食べ物・パッシブ\",\"Dungeon Stats の保存済みセッションすべて\",\"ここにある完全なセッションすべてと、一部しか見ていない周回（途中参加やウェーブの見逃し）。平均に役立ちますが、個別のセッションとしては保存されません\",\"獲得したものはすべて売却・所持・出品・保管のいずれかです。\",\"ここにあるものはすべてこのブラウザにのみ保存されます。下でチェックを外すと、そのテーブルの列を非表示にします。周回テーブルの「取得元」（ソースとメモ）は既定でオフで、その場合メモのある周回は結果の横に小さな旗を表示します。\",\"全スキル合計の 1 時間あたり経験値。値にカーソルを合わせるとスキル別に表示\",\"生フレームをエクスポート\",\"記録をエクスポート（JSON）\",\"最速 {a}\",\"マーケット価格を今すぐ再取得\",\"すべてのモンスターが HP 0 になるのを確認し、すべてのダメージがプレイヤーに計上された終了済みウェーブ\",\"最初\",\"再びバッグのコインに連動\",\"食べ物\",\"食べ物 1\",\"食べ物 2\",\"食べ物 3\",\"食べ物とドリンク\",\"開始\",\"獲得\",\"ゲーム：XP\",\"ゲーム：回数\",\"ゲーム：ドロップ\",\"一般\",\"通常攻撃の HP コスト\",\"{ability} の HP コスト\",\"確認が合わなかったウェーブで、残った HP または計上されなかった HP\",\"回復量\",\"回復量 {n}\",\"回復\",\"与えた回復\",\"所持\",\"所持（買値）\",\"所持（原価）\",\"所持ドロップ {a}（買値）\",\"所持価値\",\"所持数 × トークン単価。繰越分の価値はその下に表示し、計上しません\",\"非表示\",\"ここでメーターを非表示にします。Dungeon Stats の設定で再表示できます\",\"命中\",\"繰越\",\"Toolasha の履歴をインポート\",\"記録ファイルをインポート…\",\"ダンジョン内\",\"記録開始前からバッグにあった分\",\"記録開始前からバッグにあった分。ここから売却できますが、所持ドロップや純益には計上しません\",\"アイテム\",\"今後の周回用に {item} をいくつ保管しますか？（現在 {n}、0 で解除）\",\"保管…\",\"保管\",\"鍵\",\"キーと消耗品の残り時間：黄色になるのは\",\"鍵のコスト\",\"鍵のクラフト\",\"鍵のクラフト\",\"鍵のクラフト（ゲームのドロップ・経験記録より）\",\"鍵\",\"記録内の鍵\",\"鍵タブ\",\"必要な鍵\",\"種類\",\"大きく\",\"最後\",\"1周 {run} で約 {time} もちます\",\"台帳上のコスト\",\"レベル\",\"ライフスティール\",\"累計\",\"累計タブ\",\"出品中\",\"ドロップ\",\"ドロップ = この記録が見た、宝箱またはトークン交換から出たもの。所持 = 現在バッグにある分、出品中 = 売り注文に出している分。手放した分 = 獲得 − 売却 − 開封 − 所持 − 出品中 − 保管 で、現在の買値から税 {a} を引いて評価します。開封時から {b} を超えて動いた買値（または買値なし）は確認待ちとなり、承認されるまで合計から除外されます。承認するとその価値が記録イベントとして固定されます。\",\"開封時のドロップ\",\"手放したドロップ\",\"ドロップタブ\",\"売却するドロップ\",\"マナ\",\"回復マナ {n}\",\"マナリーチ\",\"消費マナ {n}\",\"素材\",\"素材\",\"この PC で購入した素材\",\"別の PC のマーケット履歴ファイルを統合：Toolasha の出品配列（JSON）または Market History の CSV\",\"マーケット履歴ファイルを統合…\",\"別の PC でエクスポートしたこのキャラクターの記録を統合：イベントは ID で、再生されたチャットと出品の約定は照合され、二重に数えられません\",\"メーターの列\",null,\"ミス\",\"不足\",\"必要\",\"純益\",\"新しい順。* 計上した鍵はパーティーの鍵カウントから読み取り（クリアメッセージなし）。† XP はスクリプトが周回に参加した時点から計算。↰ 記録開始時にすでに進行中だった周回。\",\"新しい順。ソース = イベントの元になったゲームメッセージ。消耗品の使用は記録されますが、「consume」の下にのみ表示されます。\",\"新しい順。買値での価値 = 宝箱を開けた時点の各アイテムの最高買値。ダンジョントークンは、それで交換できるショップアイテムのうちトークン単価が最も高い買値で評価します（0.1.2 以前の開封は、それを記録した最も近い開封の買値を使います）。数のみのアイテム（カウベル）と価格のないアイテムは価値なしです。鍵のコスト = 宝箱鍵のロット原価。基準が売値の場合、その鍵は記録開始前から持っていたものです。\",\"このページではまだ戦闘を確認していません。\",\"ログにまだ戦闘セッションがありません：ゲームのドロップ・経験記録を一度開いてください。\",\"ログにまだ鍵のクラフトがありません。\",\"手放した分 {a}\",\"このダンジョンの周回時間はまだありません\",\"まだセッションがありません：ゲームのドロップ・経験記録を一度開いてください。\",\"まだ何も記録されていません。\",\"確認するものはありません。\",\"現在\",\"オフ：戦闘メッセージを一切読まず、何も記録せず、メーターとダメージタブを非表示にします。動作の遅い PC 向けです。保存済みのセッションは残ります。\",\"オフライン {a}\",\"1 周が進行中です。\",\"クラフト画面を開く\",\"マーケットで開く\",\"ゲームのドロップ・経験記録（Moo Pass）を一度開くと、そのセッションがここに表示されます。Toolasha の保存済み履歴はログイン時に統合されます。\",\"このセッション中にゲームのドロップ・経験記録（戦闘 → ドロップ・経験記録）を一度開くと、記録のクリア数と宝箱をゲーム自身の数と照合できます。\",\"開封\",\"ゲームの購入ウィンドウを {n} 個入力済みで開きます\",\"その他\",\"その他（パッシブ、ライフスティール）\",\"その他（未特定）\",\"その他の売上 {a}（計上なし）\",\"その他 {a}\",\"継続ダメージ\",\"概要\",\"自身の行動（HP コスト）\",\"所持\",\"パリィ\",\"パーティー DPS\",\"パーティの消耗品\",\"パーティーのダメージ\",\"パーティのドリンクスロット {n}\",\"パーティの入場キー\",\"パーティの食べ物スロット {n}\",\"クリアあたり\",\"鍵あたり\",\"毎秒\",\"戦闘中の毎秒\",\"トークンあたり\",\"プレイヤー\",\"次までの価格\",\"記録開始時の在庫を自分の購入履歴から再評価し、スクリプトが見ていなかった約定を取り込みます\",\"受取\",\"レシピ\",\"ダメージを記録\",\"内訳の導入前に記録（アップデート 0.2.1）\",\"交換済み\",\"価格を更新\",\"自然回復（10 秒ごと）\",\"自然回復・食べ物・パッシブ\",\"リセット\",\"カードの並び順をリセット\",\"列の並び順をリセット\",\"ダメージデータをリセット\",\"記録をリセット\",\"結果\",\"確認\",\"周回時間\",\"周回\",\"周回タブ\",\"保存済みの周回（開始から終了まで確認）、新しい順\",\"保存済みのセッション（開始から終了まで確認）、新しい順\",\"パネル内のすべてのサイズを {a}〜{b} の範囲で {c} 刻みで拡大縮小します。\",\"取得元\",\"セッション\",\"セッション\",\"ゲームのドロップ・経験記録のセッション\",\"設定\",\"割合\",\"表示\",\"バトルカードの下にメーターを表示（戦闘 → バトル）\",\"このページでパーティーが戦闘に入ってからの全周回を表示中。クリックでこの周回のみ表示\",\"この周回のみ表示中。クリックでパーティーが戦闘に入ってからの全周回を表示\",\"記録開始以降\",\"記録開始以降\",\"{date} 以降。\",\"スキル\",\"スキル\",\"最遅 {a}\",\"小さく\",\"売却\",\"売却（税引後）\",\"売却 {a}\",\"ソース\",\"支出\",\"開始\",\"状態\",\"まとめ\",\"今後の周回用に保管する物資\",\"被ダメージ\",\"文字サイズ\",\"どちらの場合も、ダメージタブはすべてのセッションを保持します。\",\"このトークンだけで交換できるショップアイテムを買値で売った場合の、トークンあたりの最高コイン（税引後、サイトの規則）\",\"このスキルを鍛えたセッションが 1 時間以上ある中で、効率が最も高かったダンジョンとティア\",\"ゲーム自身のログ（サーバー側、全デバイス分を網羅）と Toolasha の保存コピーを統合：{n} セッション\",\"ゲーム自身のログで、行動セッションごとに 1 行：回数（ダンジョンのクリア数、またはクラフトした鍵の数）、ドロップ、XP（オフライン分を含む）。「この記録」は同じ期間にこの記録が持つクリア数と宝箱を数えます。≠ は差異を示し、セッション終了後に強調表示されます。ゲームの回数が基準で、この記録はログにない時間とコストを補うだけです。\",\"この記録\",\"この記録のみ：ゲームの回数を見るにはドロップ・経験記録を開いてください\",\"この周回\",\"とげ（反射ダメージ）\",\"とげと反撃\",\"それらの本のマーケット売値\",\"時間\",\"メーターが計測した戦闘時間\",\"セッション時間\",\"セッション時間はログの開始から終了までなので、XP / h は行動が動いていた 1 時間あたり（オフライン分を含む）です。マーケット履歴はデバイスごとで、この PC の Toolasha の保存データとデータタブで統合したファイルから出品 ID で統合しています（出品 {n} 件）。ログにはクラフトごとの消費量がないため、鍵 1 個あたりのコストはその履歴の平均支払価格（1 台の PC で購入した分の価格をそのまま保持）と、現在の職人率でのレシピ数量を使います。両方の PC の記録を統合するまで累計収入は表示されません（インポート、マイルストーン 5）。\",\"回数\",\"この回復元が HP を回復した回数\",\"この回復源が MP を回復した回数\",\"使用回数。パリィ・とげ・継続ダメージは発動として数えません\",\"今日\",\"トークン\",\"場所ごとの合計（全体・一部を問わず確認した全周回）\",\"不明な場所\",\"バッグのコインを使う\",\"使用\",\"原価で使用\",\"クラフトで使用\",\"記録内で使用\",\"使用回数\",\"ゲーム自身のナビゲーションを使います\",\"価値（税引後）\",\"買値での価値\",\"ゲームのスキル合計を待っています。\",\"ウェーブ\",\"内容\",\"スクリプトが確定できなかったもの\",\"このプレイヤーの回復アビリティとライフドレインが回復した量\",\"場所\",\"{time} 前からの 1 時間あたり XP\",\"記録開始以降の XP は、ゲームの現在の累計から記録開始時の累計を引いた値なので、スクリプトが動いていたかどうかに関わらず（オフラインプレイを含め）正確です。時間あたり XP は稼働時間で計算します：間隔が 15 分以内の XP メッセージ間の時間と、XP を得たオフライン時間の合計です。日付はあなたの端末の時計に基づきます。\",\"XP タブ\",\"XP/時\",\"あなたのダメージ\",\"あなたの割合\",\"鍵の購入価格 {ask} に対して\",\"職人 {pct}\",\"予算で買えるだけ\",\"周回の合間\",\"購入で {n} 節約\",\"キャンセル\",\"終了したウェーブ {b} 件中 {a} 件を確認\",\"クリア\",\"消耗品使用 {n}（購入価格で {cost}、最近のイベント）\",\"クラフト価格\",\"クラフトで {n} 節約\",\"途中で中断\",\"終了\",\"早期終了\",\"所持数で足りる\",\"失敗\",\"取得中…\",\"{date} から\",\"時間未満\",\"進行中\",\"ログイン時の概要 · チャット台帳に {a} 周\",\"ドロップログ\",\"次のレベルまで {time}\",\"職人茶がセットされていません\",\"まだ記録なし\",\"注文中\",\"パーティー {n}（{dps} DPS）\",\"一時停止中\",\"{date} 時点の価格\",\"価格は未取得\",\"価格: {error}\",\"{date} からの記録\",\"赤になるのは\",\"現在セット中\",\"再読み込み後につなぎ直し\",\"合計：完全な周回 {n} 回\",\"合計：完全な周回 {n} 回\",\"買値での価値 {a}（トークン {b}） · 鍵 {c}\",\"買値での価値 {a} · 鍵 {b}\",\"ログイン待ち\",\"ウェーブ {n}\",\"ウェーブ {a}–{b}\",\"応答なし\",\"予算 {budget} の範囲内\",\"{ability}（継続ダメージ）\",\"{a} 中止\",\"{a} 宝箱、{b} 精錬\",\"{a} 宝箱の中から出た宝箱\",null,\"{a} 開封したダンジョン宝箱（買値）\",\"{a} 失敗（{b}）\",\"{a} アイテム\",\"{a} 精錬、{b} 宝箱\",\"{a} 税（{b}）\",\"{a} アビリティ\",\"{a} アビリティ\",\"クラフト価格で {a}\",\"売値で評価した消耗品 {a} と鍵素材 {b}、鍵 {c} 種類、宝箱 {d} 種類 · {e} コイン\",\"{a}（失敗を含む）\",\"{a} 日\",\"{a} 日\",\"{a} ダンジョン\",\"{a} ダンジョン\",\"{a} イベント\",\"{a} イベント\",\"{a} アイテム\",\"{a} アイテム\",\"鍵 {a} 個\",\"鍵 {a} 個\",\"素材 {a} 種\",\"素材 {a} 種\",\"うちトークン {a}（ショップのトークン単価の最高買値）\",\"{b} 件中 {a} 件を記録\",\"{a} 回開封\",\"{a} 回開封\",\"{a} 交換済み\",\"{a} 周\",\"{a} 周\",\"{a} セッション\",\"{a} セッション\",\"{a} スキル\",\"{a} スキル\",\"これまでに {a}\",\"{a} ソース\",\"{a} トークン\",\"{a} トークン\",\"{a} 使用\",\"{a} 使用（オフライン {b}） · 価格なし {c}\",\"ダメージ {dmg} · パーティーの {share} · {dps} DPS · 被ダメージ {taken} · 回復量 {healed}\",\"{name} のキー {n} 個\",\"{name} のキーがありません\",\"{name} の {item} がありません\",\"{name} のキーはあと {time}\",\"{name} の {item} はあと {time}\",\"{name} のダメージ\",\"{name} の {ability}\",\"原因不明の HP {n}\",\"原因不明の HP {n}。\",\"{n} アビリティ\",\"{n} アビリティ\",\"{n} 回クラフト\",\"{n} 回クラフト\",\"死亡 {n}\",\"死亡 {n}\",\"購入価格で各 {n}\",\"{n} イベント\",\"{time} 以降 {n} 件完了 + この周回\",\"{time} 以降 {n} 件完了\",\"確認待ち {n}\",\"所持 {n}\",\"未計上 {n}\",\"未計上 {n}。\",\"うち {n} は買い注文中\",\"一部のみ確認した周回 {n}\",\"一部のみ確認した周回 {n}\",\"{n} 周\",\"{n} ソース\",\"{n} ソース\",\"記録内で {n} 使用\",\"{n} ウェーブ\",\"{key} {n} 個 = {crafts}、購入なら {total}\",\"予算 {budget} を {over} 超過\",\"{result}、終了処理中\",\"戦闘 {time}\",\"· クリックで詳細\",\"− 支出 {a}\"]",
        "ko": "[\"(비어 있음)\",\"(새로고침 후 다시 합류)\",\"({items} 가격 없음)\",\"(열쇠 제작에 {n})\",\"+ 상자 코인 {a}\",\"+ {a} 코인\",\"+{n} 주문 중\",\"예산 {budget}(으)로 {key} {n}개({crafts})를 {total}에 구매\",\"예산 {budget}(으)로는 {key} 1개도 살 수 없습니다\",\"런은 파티 열쇠 수 메시지 하나에서 다음 메시지까지이며, Toolasha와 같은 방식으로 셉니다. 취소된 런은 평균에서 제외됩니다. 오프라인 동안의 런은 파티 채팅에서, 그 상자는 로그인 요약에서 가져옵니다.\",\"어빌리티\",\"어빌리티\",\"행동\",\"활동 시간\",\"모든 런\",\"판매가\",\"시작 시\",\"HP를 깎은 공격 또는 틱\",\"HP를 깎지 못한 공격: 빗나감, 회피 또는 막힘\",\"기본 공격\",\"평균 런\",\"평균 가격\",\"최고 효율\",\"런 사이\",\"개봉 시 입찰가\",\"현재 입찰가\",\"개화\",\"다음 레벨까지 필요한 책 수 (게임의 책당 XP 기준)\",\"다음까지 책\",\"구매\",\"총 구매\",\"재고로 {a} 구매, 사용할 때 비용 처리\",\"예산\",\"구매\",\"캡처 로그\",\"확인됨\",\"끝난 웨이브 {b}개 중 {a}개 확인: 모든 몬스터가 HP 0이 되는 것을 확인했고 모든 피해가 플레이어에게 귀속되었습니다.\",\"상자\",\"상자 열쇠 {a}\",\"상자\",\"획득한 상자\",\"상자 탭\",\"클리어\",\"열 머리글을 클릭하면 그 열로 정렬합니다. 다시 클릭하면 역순, 세 번째 클릭은 표의 원래 순서로 돌아갑니다.\",\"플레이어를 클릭하면 어빌리티별 피해, 사용 횟수, 적중, 빗나감, 치유와 함께 받은 피해의 출처와 회복 출처를 볼 수 있습니다. 피해는 게임의 전투 메시지에서 읽은, 몬스터가 잃은 HP이며 초과 피해는 포함하지 않습니다. DPS는 전투 시간 기준입니다: 첫 웨이브 시작부터 마지막 공격까지이며, 웨이브 사이의 공백은 빼지 않습니다. 던전 런은 스크립트가 1웨이브부터 끝까지 본 경우에만 여기에 표시됩니다 (웨이브 도중 새로고침은 이어 붙이지만, 업데이트를 설치하면 페이지가 새로고침되어 그 런은 끊깁니다). 행성에서는 전투가 바뀔 때까지 새로고침을 넘어 하나의 세션이 이어집니다. 일부만 본 런도 집계됩니다: 세션 목록에서 해당 던전의 합계를 선택하세요. 패링과 가시는 반격이며, 지속 피해는 그것을 건 어빌리티에 포함됩니다. 치유량은 치유 어빌리티, 생명력 흡수, 개화를 셉니다. 플레이어가 회복한 그 밖의 모든 것(재생, 음식, 패시브)은 회복됨에 표시됩니다. 아래 세션을 클릭하면 표시됩니다.\",\"클릭하여 {name}의 어빌리티 보기\",\"클릭하여 시장에서 열기.\",\"닫기\",\"닫기 (Esc)\",\"코인\",\"재료와 레시피 코인에 쓸 코인. 금액을 입력하기 전까지는 가방의 코인을 따릅니다\",\"전투 창의 열쇠와 소모품 시간 및 경고의 색.\",\"열 및 카드 순서\",\"전투 스킬\",\"전투 스킬 (게임의 전리품 및 경험치 기록 기준)\",\"전투 시간\",\"소모품\",\"소모품 {a}\",\"내용물\",\"구매 목록 복사\",\"비용\",\"열쇠당 비용\",\"열쇠당 비용 = 이 기록이 본 열쇠 제작의 평균 (재료는 구매가, 여기에 레시피 코인 추가). 아직 제작을 보지 못했다면, 재료 구매가 기준의 레시피(한 번도 사지 않은 재료는 판매가)에 게임의 장인 비율(게임이 표시하는 차 × 폭음의 주머니)로 모든 재료를 줄이고 제작 시간 중 차의 몫을 더한 값을 쓰며, 재료에 가격이 전혀 없을 때만 열쇠 자체의 판매가를 씁니다. 기록 시작 전에 보유한 열쇠도 같은 방식으로 가격을 매깁니다. 원가 사용은 실시간 클리어마다 실제로 쓴 묶음의 비용을 청구하며, 오프라인 및 이전 클리어는 제작 평균을 씁니다. 시작 시 = 기록 시작 시점에 보유한 것으로, 그때의 판매가로 계산합니다.\",\"보유 재료 계산\",\"마지막 웨이브 기준, 전투 중인 모든 플레이어의 보유 수량. 각 수량 아래: 이 페이지를 연 뒤 해당 플레이어의 사용 속도로 버티는 시간(10분 및 1회 사용 전에는 –). 입장 열쇠는 매 회차 시작 시 게임의 파티 메시지에서 가져오며 던전 평균 클리어 시간으로 계산합니다.\",\"카우벨\",\"제작\",\"전체 제작\",\"판매가 기준 열쇠당 제작 비용 {cost}\",\"제작 {a}\",\"현재 런\",\"현재 세션\",null,\"피해\",\"가한 피해 {n}\",\"피해 미터기\",\"지속 피해\",\"피해 세션\",\"피해 탭\",\"받은 피해 {n}\",\"피해 {n}\",\"데이터\",\"데이터 탭\",\"일\",\"일\",\"사망\",\"피해 미터기 데이터를 모두 삭제할까요? 저장된 세션 {n}개, 장소별 합계, 진행 중인 런이 삭제됩니다. 런, 전리품, XP 등 나머지는 모두 유지됩니다.\",\"저장된 모든 피해 세션과 합계를 삭제합니다. 나머지 기록은 유지됩니다\",\"이 캐릭터의 Dungeon Stats 기록 전체를 삭제할까요? 보관하려면 먼저 내보내세요.\",\"세부 정보\",\"진단\",\"이번 세션 동안 숨기기\",\"열 머리글이나 카드를 다른 것 위로 끌어 옮기세요. 각 표와 카드 그리드는 자체 순서를 기억합니다.\",\"탭을 다른 탭 위로 끌어 옮길 수 있습니다.\",\"드래그하여 플레이어 쪽과 몬스터 쪽의 너비를 조절합니다. 더블 클릭하면 균등하게 나눕니다\",\"끌어서 이 열의 너비를 정하고, 두 번 클릭하면 자동\",\"음료 1\",\"음료 2\",\"음료 3\",\"드롭\",\"던전\",\"던전 토큰\",\"던전\",\"던전 (게임의 전리품 및 경험치 기록 기준)\",\"각 세션은 훈련한 전투 스킬(XP를 가장 많이 얻은 스킬)로 집계됩니다\",\"종료\",\"적중한 적: 광역 어빌리티는 맞힌 적마다 셉니다\",\"입장 열쇠\",\"입장 열쇠 {a}\",\"정수\",\"이 플레이어가 회복한 모든 HP: 치유, 생명력 흡수, 재생, 음식, 패시브\",\"Dungeon Stats에 저장된 모든 세션\",\"여기의 모든 완전한 세션과 일부만 본 런(런 도중 합류했거나 웨이브를 놓친 경우): 평균 계산에 유용하며, 별도 세션으로는 저장되지 않습니다\",\"획득한 모든 것이 판매, 보유, 등록 또는 보관되었습니다.\",\"여기의 모든 내용은 이 브라우저에만 저장됩니다. 아래에서 열의 체크를 해제하면 해당 표에서 숨겨집니다. 런 표의 확인 출처(출처 및 메모)는 기본적으로 꺼져 있으며, 이때 메모가 있는 런은 결과 옆에 작은 깃발이 표시됩니다.\",\"모든 스킬의 시간당 경험치. 값에 마우스를 올리면 스킬별로 표시\",\"원본 프레임 내보내기\",\"기록 내보내기 (JSON)\",\"최단 {a}\",\"지금 시장 가격 다시 가져오기\",\"모든 몬스터가 HP 0이 되는 것을 확인했고 모든 피해가 플레이어에게 귀속된 끝난 웨이브\",\"처음\",\"다시 가방의 코인 따르기\",\"음식\",\"음식 1\",\"음식 2\",\"음식 3\",\"음식과 음료\",\"출처\",\"획득\",\"게임: XP\",\"게임: 횟수\",\"게임: 드롭\",\"일반\",\"기본 공격의 HP 소모\",\"{ability}의 HP 소모\",\"확인되지 않은 웨이브에서 남았거나 귀속되지 않은 HP\",\"회복됨\",\"회복 {n}\",\"치유\",\"치유량\",\"보유\",\"입찰가 기준 보유\",\"원가 기준 보유\",\"보유 전리품 {a} (입찰가 기준)\",\"보유 가치\",\"보유 × 토큰당 가치. 이월분의 가치는 아래에 표시되며 집계되지 않습니다\",\"숨기기\",\"여기서 미터기를 숨깁니다. Dungeon Stats 설정에서 다시 표시할 수 있습니다\",\"적중\",\"이월분\",\"Toolasha 기록 가져오기\",\"기록 파일 가져오기…\",\"던전에서\",\"기록 시작 전부터 가방에 있던 것\",\"기록 시작 전부터 가방에 있던 것. 여기서 판매할 수 있지만 보유 전리품이나 순이익에는 포함되지 않습니다\",\"아이템\",\"다음 런을 위해 {item}을(를) 몇 개 보관할까요? (현재 {n}, 0이면 해제)\",\"보관…\",\"보관\",\"열쇠\",\"열쇠와 소모품 시간: 주황색 기준\",\"열쇠 비용\",\"열쇠 제작\",\"열쇠 제작\",\"열쇠 제작 (게임의 전리품 및 경험치 기록 기준)\",\"열쇠\",\"기록 속 열쇠\",\"열쇠 탭\",\"필요한 열쇠\",\"종류\",\"크게\",\"마지막\",\"1회 {run} 기준 약 {time} 지속\",\"장부 비용\",\"레벨\",\"생명력 흡수\",\"전체 기간\",\"전체 기간 탭\",\"등록됨\",\"전리품\",\"전리품 = 이 기록이 상자나 토큰 교환에서 나온 것으로 본 것. 보유 = 지금 가방에 있는 것, 등록됨 = 판매 주문에 올린 것. 더 이상 보유하지 않음 = 획득 − 판매 − 개봉 − 보유 − 등록 − 보관이며, 현재 입찰가에서 세금 {a}을(를) 뺀 값으로 평가합니다. 개봉 이후 {b} 넘게 변한 입찰가(또는 입찰가 없음)는 검토 대상으로 표시되어 승인 전까지 합계에서 제외됩니다. 승인하면 그 값이 기록된 이벤트로 고정됩니다.\",\"개봉 시 전리품\",\"더 이상 보유하지 않은 전리품\",\"전리품 탭\",\"판매할 전리품\",\"마나\",\"회복한 마나 {n}\",\"마나 흡수\",\"소모한 마나 {n}\",\"재료\",\"재료\",\"이 PC에서 구매한 재료\",\"다른 PC의 시장 기록 파일 병합: Toolasha의 등록 배열(JSON) 또는 Market History CSV\",\"시장 기록 파일 병합…\",\"다른 PC에서 내보낸 이 캐릭터의 기록 병합: 이벤트는 id로, 재생된 채팅과 등록 체결은 대조하여 중복 집계되지 않습니다\",\"미터 열\",null,\"빗나감\",\"부족\",\"필요\",\"순이익\",\"최신순. * 청구된 열쇠는 파티 열쇠 수에서 읽음 (클리어 메시지 없음). † XP는 스크립트가 런에 합류한 시점부터 계산. ↰ 기록 시작 시 이미 진행 중이던 런.\",\"최신순. 출처 = 이벤트가 나온 게임 메시지. 소모품 사용은 기록되지만 \\\"consume\\\" 아래에만 표시됩니다.\",\"최신순. 입찰가 기준 가치 = 상자를 열었을 때 각 아이템의 최고 입찰가. 던전 토큰의 가치는 그 토큰으로 살 수 있는 상점 아이템 중 토큰당 최고 입찰가입니다 (0.1.2 이전 개봉은 그 입찰가를 기록한 가장 가까운 개봉에서 가져옵니다). 개수만 세는 아이템(카우벨)과 가격 없는 아이템은 가치가 없습니다. 열쇠 비용 = 상자 열쇠의 묶음 비용. 기준이 판매가이면 기록 시작 전에 보유한 열쇠입니다.\",\"이 페이지에서 아직 전투를 보지 못했습니다.\",\"기록에 전투 세션이 아직 없습니다: 게임의 전리품 및 경험치 기록을 한 번 여세요.\",\"기록에 열쇠 제작이 아직 없습니다.\",\"더 이상 보유하지 않음 {a}\",\"이 던전의 클리어 시간 기록이 아직 없습니다\",\"세션이 아직 없습니다: 게임의 전리품 및 경험치 기록을 한 번 여세요.\",\"아직 기록된 것이 없습니다.\",\"검토할 것이 없습니다.\",\"현재\",\"끄기: 전투 메시지를 전혀 읽지 않고 아무것도 기록하지 않으며, 미터기와 피해 탭이 숨겨집니다. 느린 PC용입니다. 이미 저장된 세션은 유지됩니다.\",\"오프라인 {a}\",\"런 하나가 진행 중입니다.\",\"제작 페이지 열기\",\"시장에서 열기\",\"게임의 전리품 및 경험치 기록(Moo Pass)을 한 번 열면 그 세션이 여기에 표시됩니다. Toolasha에 저장된 기록은 로그인할 때 병합됩니다.\",\"이번 세션에 게임의 전리품 및 경험치 기록을 한 번 열어 주세요 (전투 → 전리품 및 경험치 기록). 그러면 기록이 클리어와 상자를 게임 자체 집계와 대조할 수 있습니다.\",\"개봉\",\"게임의 구매 창을 {n}개가 입력된 상태로 엽니다\",\"기타\",\"기타 (패시브, 생명력 흡수)\",\"기타 (미확인)\",\"기타 판매 {a} 미집계\",\"기타 {a}\",\"지속 피해\",\"개요\",\"자신의 행동 (HP 소모)\",\"보유\",\"패링\",\"파티 DPS\",\"파티 소모품\",\"파티 피해\",\"파티 음료 슬롯 {n}\",\"파티 입장 열쇠\",\"파티 음식 슬롯 {n}\",\"클리어당\",\"열쇠당\",\"초당\",\"전투 중 초당\",\"토큰당\",\"플레이어\",\"다음까지 가격\",\"기록 시작 시 보유한 재고를 자신의 구매가로 다시 계산하고, 스크립트가 보지 못한 체결을 반영합니다\",\"받음\",\"레시피\",\"피해 기록\",\"세부 내역 도입 전에 기록됨 (업데이트 0.2.1)\",\"교환함\",\"가격 새로고침\",\"재생 (10초마다)\",\"재생, 음식, 패시브\",\"초기화\",\"카드 순서 초기화\",\"열 순서 초기화\",\"피해 데이터 초기화\",\"기록 초기화\",\"결과\",\"검토\",\"회당 시간\",\"런\",\"런 탭\",\"저장된 런 (처음부터 끝까지 확인), 최신순\",\"저장된 세션 (처음부터 끝까지 확인), 최신순\",\"패널의 모든 크기를 {a}~{b}, {c} 단위로 조절합니다.\",\"확인 출처\",\"세션\",\"세션\",\"게임의 전리품 및 경험치 기록에 있는 세션\",\"설정\",\"비중\",\"표시\",\"전투 카드 아래에 미터기 표시 (전투 → 배틀)\",\"이 페이지에서 파티가 전투에 들어간 이후의 모든 런을 표시 중. 클릭하면 이번 런만 표시\",\"이번 런만 표시 중. 클릭하면 파티가 전투에 들어간 이후의 모든 런 표시\",\"기록 이후\",\"기록 시작 이후\",\"{date} 이후.\",\"스킬\",\"스킬\",\"최장 {a}\",\"작게\",\"판매\",\"순판매\",\"판매 {a}\",\"출처\",\"지출\",\"시작\",\"상태\",\"요약\",\"다음 런을 위해 보관한 보급품\",\"받은 피해\",\"글자 크기\",\"피해 탭은 어느 쪽이든 모든 세션을 보관합니다.\",\"이 토큰만으로 살 수 있는 상점 아이템 중 입찰가 판매 시 세금을 뺀 토큰당 최고 코인 (사이트 규칙)\",\"이 스킬을 훈련한 세션이 최소 1시간 이상인 것 중, 효율이 가장 높았던 던전과 티어\",\"게임 자체 기록 (서버 측, 모든 기기 포함)과 Toolasha 저장본을 병합: 세션 {n}개\",\"게임 자체 기록으로, 행동 세션마다 한 행: 횟수(던전 클리어 또는 열쇠 제작), 드롭, XP를 오프라인 포함하여 표시합니다. \\\"이 기록\\\"은 같은 기간에 이 기록이 가진 클리어와 상자를 셉니다. ≠는 차이를 표시하며 세션이 끝나면 강조됩니다. 게임의 집계가 기준이며, 이 기록은 게임 기록에 없는 시간과 비용만 추가합니다.\",\"이 기록\",\"이 기록만: 게임의 집계를 보려면 전리품 및 경험치 기록을 여세요\",\"이번 런\",\"가시 (반사된 피해)\",\"가시 및 보복\",\"그 책들의 시장 판매가\",\"시간\",\"미터가 집계한 전투 시간\",\"세션 시간\",\"세션 시간은 기록의 시작부터 끝까지이므로, XP / h는 오프라인을 포함해 행동이 진행된 시간당 값입니다. 시장 기록은 기기별이며, 이 PC의 Toolasha 저장소와 데이터 탭에서 병합한 파일을 등록 id로 여기에 병합합니다 (등록 {n}개). 게임 기록에는 제작당 소모량이 없으므로, 열쇠당 비용은 그 기록의 평균 지불 가격(한 PC에서 산 몫이 얼마든 그 가격이 유지됨)과 현재 장인 비율에서의 레시피 수량을 씁니다. 두 PC의 기록이 병합되기 전까지는 전체 기간 수입이 표시되지 않습니다 (가져오기, 마일스톤 5).\",\"횟수\",\"이 출처가 HP를 회복한 횟수\",\"이 출처가 MP를 회복시킨 횟수\",\"사용 횟수. 패링, 가시, 지속 피해는 시전되지 않습니다\",\"오늘\",\"토큰\",\"장소별 합계 (전부 또는 일부를 본 모든 런)\",\"알 수 없는 장소\",\"가방 코인 사용\",\"사용\",\"원가 사용\",\"제작에 사용\",\"기록 중 사용\",\"사용 횟수\",\"게임 자체 탐색을 사용합니다\",\"가치 (세후)\",\"입찰가 기준 가치\",\"게임의 스킬 합계를 기다리는 중입니다.\",\"웨이브\",\"항목\",\"스크립트가 확정하지 못한 것\",\"이 플레이어의 치유 어빌리티와 생명력 흡수가 회복한 양\",\"장소\",\"{time} 전부터의 시간당 XP\",\"기록 시작 이후 XP는 현재 게임의 누적 총량에서 기록 시작 시점의 총량을 뺀 값이므로, 스크립트 실행 여부와 관계없이 오프라인 플레이를 포함해 정확합니다. 시간당 XP는 활동 시간 기준입니다: 간격이 15분 이하인 XP 메시지 사이의 시간과 XP를 얻은 오프라인 시간을 더한 값입니다. 날짜는 사용자의 시계 기준입니다.\",\"XP 탭\",\"XP/시간\",\"내 피해\",\"내 비중\",\"열쇠 구매가 {ask} 대비\",\"장인 {pct}\",\"예산으로 살 수 있는 만큼\",\"런 사이\",\"구매 시 {n} 절약\",\"취소됨\",\"끝난 웨이브 {b}개 중 {a}개 확인\",\"클리어\",\"소모품 사용 {n} (구매가 {cost}, 최근 이벤트)\",\"제작 가격\",\"제작 시 {n} 절약\",\"중단됨\",\"종료\",\"조기 종료\",\"보유량 충분\",\"실패\",\"가져오는 중…\",\"{date}부터\",\"시간 미만\",\"진행 중\",\"로그인 요약 · 채팅 장부의 런 {a}회\",\"전리품 기록\",\"다음 레벨까지 {time}\",\"장인 차 미장착\",\"아직 기록 없음\",\"주문 중\",\"파티 {n} ({dps} DPS)\",\"일시정지\",\"{date} 기준 가격\",\"가격을 아직 불러오지 않음\",\"가격: {error}\",\"{date}부터 기록\",\"빨간색 기준\",\"현재 장착\",\"새로고침 후 이어 붙임\",\"합계: 완전한 런 {n}회\",\"합계: 완전한 런 {n}회\",\"입찰가 기준 가치 {a} (토큰 {b}) · 열쇠 {c}\",\"입찰가 기준 가치 {a} · 열쇠 {b}\",\"로그인 대기 중\",\"{n}웨이브\",\"{a}–{b}웨이브\",\"응답 없음\",\"예산 {budget} 이내\",\"{ability} 지속 피해\",\"취소 {a}\",\"상자 {a}, 정련 {b}\",\"그 안에서 나온 상자 {a}\",null,\"던전 상자 개봉 {a}, 입찰가 기준\",\"실패 {a} ({b})\",\"아이템 {a}\",\"정련 {a}, 상자 {b}\",\"세금 {a} ({b})\",\"어빌리티 {a}개\",\"어빌리티 {a}개\",\"제작 가격 기준 {a}\",\"판매가 기준 소모품 {a}개와 열쇠 재료 {b}개, 열쇠 {c}종, 상자 {d}종 · 코인 {e}\",\"{a} (실패 포함)\",\"{a}일\",\"{a}일\",\"던전 {a}개\",\"던전 {a}개\",\"이벤트 {a}개\",\"이벤트 {a}개\",\"아이템 {a}개\",\"아이템 {a}개\",\"열쇠 {a}개\",\"열쇠 {a}개\",\"재료 {a}개\",\"재료 {a}개\",\"그중 토큰 {a} (상점 토큰당 최고 입찰가 기준)\",\"{b}개 중 {a}개 기록됨\",\"개봉 {a}회\",\"개봉 {a}회\",\"{a} 교환함\",\"런 {a}회\",\"런 {a}회\",\"세션 {a}개\",\"세션 {a}개\",\"스킬 {a}개\",\"스킬 {a}개\",\"지금까지 {a}\",\"출처 {a}개\",\"토큰 {a}개\",\"토큰 {a}개\",\"{a} 사용\",\"{a} 사용 (오프라인 {b}) · 가격 없음 {c}\",\"피해 {dmg} · 파티의 {share} · {dps} DPS · 받은 피해 {taken} · 회복 {healed}\",\"{name} 열쇠 {n}개\",\"{name} 열쇠 없음\",\"{name} {item} 없음\",\"{name} 열쇠 소진까지 {time}\",\"{name} {item} 소진까지 {time}\",\"{name}의 피해\",\"{name}의 {ability}\",\"설명되지 않은 HP {n}\",\"설명되지 않은 HP {n}.\",\"어빌리티 {n}개\",\"어빌리티 {n}개\",\"제작 {n}회\",\"제작 {n}회\",\"사망 {n}회\",\"사망 {n}회\",\"구매가 기준 개당 {n}\",\"이벤트 {n}개\",\"{time} 이후 완료 {n}회 + 이번 런\",\"{time} 이후 완료 {n}회\",\"검토 대상 {n}개\",\"{n} 보유\",\"귀속되지 않음 {n}\",\"귀속되지 않음 {n}.\",\"그중 {n}은 구매 주문 중\",\"일부만 본 런 {n}회\",\"일부만 본 런 {n}회\",\"런 {n}회\",\"출처 {n}개\",\"출처 {n}개\",\"기록 중 {n} 사용\",\"{n}웨이브\",\"{key} {n}개 = {crafts}, 구매 시 {total}\",\"예산 {budget}에서 {over} 초과\",\"{result}, 닫는 중\",\"전투 {time}\",\"· 클릭하여 세부 정보 보기\",\"− 지출 {a}\"]",
        "pt": "[\"(vazio)\",\"(reconectado após recarregar)\",\"({items} sem preço)\",\"({n} em fabricação de chaves)\",\"+ Moedas de baú {a}\",\"+ {a} Moedas\",\"+{n} em pedido\",\"Um orçamento de {budget} compra {n} {key} ({crafts}) por {total}\",\"Um orçamento de {budget} não cobre uma {key}\",\"Uma run vai de uma mensagem de contagem de chaves do grupo até a seguinte, do jeito que o Toolasha conta; runs canceladas ficam fora da média. Runs feitas enquanto você estava offline vêm do chat do grupo, e os baús delas do resumo de login.\",\"Técnicas\",\"Técnica\",\"Ação\",\"Tempo ativo\",\"Todas as runs\",\"Venda\",\"No início\",\"Ataques ou ticks que tiraram HP\",\"Ataques que não tiraram HP: errados, esquivados ou bloqueados\",\"Ataque automático\",\"Run média\",\"Preço médio\",\"Melhor taxa\",\"Entre runs\",\"Compra ao abrir\",\"Compra agora\",\"Floração\",\"Livros necessários para o próximo nível, pelo XP por livro do jogo\",\"Livros p/ próximo\",\"Comprado\",\"Total comprado\",\"Comprado {a} como estoque, cobrado ao usar\",\"Orçamento\",\"Comprar\",\"Log de captura\",\"Verificado\",\"Verificadas {a} de {b} ondas concluídas: todo monstro visto com 0 HP e todo ponto creditado a um jogador.\",\"Baú\",\"Chaves de baú {a}\",\"Baús\",\"Baús ganhos\",\"Aba Baús\",\"Concluídas\",\"Clique no cabeçalho de uma coluna para ordenar por ela; clique de novo para inverter e uma terceira vez para voltar à ordem própria da tabela.\",\"Clique em um jogador para ver suas técnicas: dano, usos, acertos, erros e cura, e depois de onde veio o dano recebido e o que o curou. Dano é o HP que os monstros perderam, lido das mensagens de batalha do jogo: dano excedente não é contado. O DPS é calculado sobre o tempo em combate: do início da primeira onda até o último golpe, sem pausa entre ondas. Uma run de masmorra só aparece aqui quando o script a viu da onda 1 até o fim (uma recarga no meio de uma onda é costurada de volta; instalar uma atualização recarrega a página, então essa run é cortada). Em um planeta, uma sessão dura até a batalha mudar, mesmo com recargas. Runs vistas só em parte ainda contam: escolha os totais daquela masmorra na lista de Sessões. Aparar e Espinhos são contra-ataques; dano ao longo do tempo é atribuído à técnica que o aplicou. Cura feita conta técnicas de cura, Drenar Vida e Floração; todo o resto que um jogador recuperou (regeneração, comida, passivas) aparece em Curado. Clique em uma sessão abaixo para exibi-la.\",\"Clique para ver as técnicas de {name}\",\"Clique para abrir no mercado.\",\"Fechar\",\"Fechar (Esc)\",\"Moedas\",\"Moedas para gastar em materiais e nas moedas da receita; segue a sua bolsa até você digitar um valor\",\"Cores dos tempos e avisos de chaves e consumíveis na janela de batalha.\",\"Ordem de colunas e cartões\",\"Habilidades de combate\",\"Habilidades de combate, do Registro de loot e EXP do jogo\",\"Tempo de combate\",\"Consumíveis\",\"Consumíveis {a}\",\"Conteúdo\",\"Copiar lista de compras\",\"Custo\",\"Custo por chave\",\"Custo por chave = a média das fabricações de chave que este registro viu (materiais pelo preço de compra, mais as moedas da receita); até que uma seja vista, a receita pelos preços de compra dos materiais (preço de venda para materiais nunca comprados) com cada insumo reduzido pela taxa de artesão do jogo (chá × Bolsa Devoradora, como o jogo informa) mais a parte do chá no tempo de fabricação, e o preço de venda da própria chave só quando um material não tem preço nenhum. Chaves que você tinha antes do início do registro são avaliadas do mesmo jeito. Usado ao custo cobra de cada run ao vivo o lote exato que ela consumiu; runs offline e mais antigas usam a média de fabricação. No início = o que você tinha quando o registro começou, avaliado pelo preço de venda daquele momento.\",\"Contar materiais que possui\",\"Quantidades na última onda, para todos na batalha. Sob cada quantidade: quanto dura ao ritmo em que esse jogador a usou desde que esta página abriu (– até 10 minutos e um uso). As chaves de entrada vêm da mensagem de grupo do jogo no início de cada run, ao tempo médio de run da masmorra.\",null,\"Fabricado\",\"Fabricado no total\",\"Custo de fabricação {cost} por chave a preço de venda\",\"Fabricação {a}\",\"Run atual\",\"Sessão atual\",null,\"Dano\",\"Dano causado {n}\",\"Medidor de dano\",\"Dano ao longo do tempo\",\"Sessões de dano\",\"Aba Dano\",\"Dano recebido {n}\",\"Dano {n}\",\"Dados\",\"Aba Dados\",\"Dia\",\"Dias\",\"Mortes\",\"Apagar todos os dados do medidor de dano: {n} sessões salvas, os totais por local e a run em andamento? Runs, loot, XP e todo o resto ficam.\",\"Apaga todas as sessões e totais de dano salvos; o resto do registro fica\",\"Apagar todo o registro do Dungeon Stats deste personagem? Exporte-o antes se quiser guardá-lo.\",\"Detalhes\",\"Diagnóstico\",\"Dispensar nesta sessão\",\"Arraste um cabeçalho de coluna sobre outro, ou um cartão sobre outro, para movê-lo. Cada tabela e as grades de cartões guardam a própria ordem.\",\"Arraste uma aba sobre outra para movê-la.\",\"Arraste para redimensionar o lado dos jogadores e o dos monstros; clique duas vezes para dividir igualmente\",\"Arraste para definir a largura desta coluna; clique duas vezes para automático\",\"Bebida 1\",\"Bebida 2\",\"Bebida 3\",\"Dropado\",\"Masmorra\",\"Fichas de masmorra\",\"Masmorras\",\"Masmorras, do Registro de loot e EXP do jogo\",\"Cada sessão conta para a habilidade de combate que treinou: a que teve mais XP nela\",\"Fim\",\"Inimigos atingidos: uma técnica em área conta cada inimigo que atinge\",\"Chaves de entrada\",\"Chaves de entrada {a}\",\"Essência\",\"Todo HP que este jogador recuperou: curas, Drenar Vida, regeneração, comida e passivas\",\"Todas as sessões salvas, no Dungeon Stats\",\"Todas as sessões completas daqui mais as runs vistas só em parte (entrou no meio da run ou perdeu uma onda): úteis para médias, não guardadas como sessões próprias\",\"Tudo o que foi ganho está vendido, guardado, anunciado ou reservado.\",\"Tudo aqui é salvo apenas neste navegador. Abaixo, desmarque uma coluna para ocultá-la naquela tabela; a coluna Visto por (fontes e notas) da tabela de Runs vem desligada por padrão, e uma run com nota mostra então uma pequena bandeira ao lado do resultado.\",\"Experiência por hora, todas as habilidades; passe o cursor sobre um valor para ver cada habilidade\",\"Exportar frames brutos\",\"Exportar registro (JSON)\",\"Mais rápida {a}\",\"Buscar os preços do mercado de novo agora\",\"Ondas concluídas em que todo monstro foi visto chegando a 0 HP e todo ponto foi creditado a um jogador\",\"Primeira\",\"Voltar a seguir as moedas da bolsa\",\"Comida\",\"Comida 1\",\"Comida 2\",\"Comida 3\",\"Comida e bebidas\",\"De\",\"Ganho\",\"Jogo: XP\",\"Jogo: contagem\",\"Jogo: drops\",\"Geral\",\"Custo de HP nos ataques automáticos\",\"Custo de HP com {ability}\",\"HP que ficou de pé ou não foi creditado, nas ondas que não bateram\",\"Curado\",\"Curado {n}\",\"Cura\",\"Cura feita\",\"Guardado\",\"Guardado a preço de compra\",\"Guardado ao custo\",\"Loot guardado {a} a preço de compra\",\"Valor guardado\",\"Guardado × por ficha; o valor do saldo anterior abaixo, não contado\",\"Ocultar\",\"Oculta o medidor aqui; as Configurações do Dungeon Stats o trazem de volta\",\"Acertos\",\"Saldo anterior\",\"Importar histórico do Toolasha\",\"Importar arquivo de registro…\",\"Em masmorras\",\"Na bolsa antes do início do registro\",\"Na bolsa antes do início do registro; pode ser vendido daqui, mas não conta no loot guardado nem no líquido\",null,\"Reservar quantos {item} para runs futuras? (agora {n}; 0 limpa)\",\"Reservar…\",\"Reservado\",\"Chave\",\"Tempos das chaves e consumíveis: âmbar abaixo de\",\"Custo da chave\",\"Fabricação de chaves\",\"Fabricações de chaves\",\"Fabricações de chaves, do Registro de loot e EXP do jogo\",\"Chaves\",\"Chaves no registro\",\"Aba Chaves\",\"Chaves desejadas\",\"Tipo\",\"Maior\",\"Última\",\"Dura cerca de {time} a {run} por run\",\"Custo contábil\",\"Nível\",\"Roubo de vida\",\"Total\",\"Aba Total\",\"Anunciado\",null,\"Loot = o que este registro viu sair de um baú ou de uma troca de fichas. Guardado = na bolsa agora; Anunciado = nas suas ordens de venda. Não está mais guardado = ganho − vendido − aberto − guardado − anunciado − reservado, avaliado pelo preço de compra atual menos {a} de taxa; um preço de compra que mudou mais de {b} desde a abertura (ou sem preço de compra) é marcado para revisão e fica fora dos totais até ser aceito. Aceitar congela esse valor como um evento registrado.\",\"Loot ao abrir\",\"Loot não mais guardado\",\"Aba Loot\",\"Loot para vender\",null,\"Mana ganha {n}\",\"Absorção de mana\",\"Mana gasta {n}\",null,\"Materiais\",\"Materiais comprados neste PC\",\"Mesclar um arquivo de histórico do mercado de outro PC: a lista de anúncios do Toolasha (JSON) ou o CSV de Histórico do Mercado dele\",\"Mesclar arquivo de histórico do mercado…\",\"Mesclar o registro deste personagem exportado em outro PC: eventos por id, chat reproduzido e execuções de anúncios casados para que nada conte duas vezes\",\"Colunas do medidor\",null,\"Erros\",\"Faltando\",\"Precisa\",\"Líquido\",\"Mais recentes primeiro. * chaves cobradas lidas das contagens de chaves do grupo (nenhuma mensagem de conclusão vista). † XP contado a partir de quando o script entrou na run. ↰ a run já estava em andamento quando o registro começou.\",\"Mais recentes primeiro. Fonte = a mensagem do jogo de onde veio o evento. Usos de consumíveis são registrados, mas só aparecem em \\\"consume\\\".\",\"Mais recentes primeiro. Valor a preço de compra = o maior preço de compra de cada item quando o baú foi aberto; uma ficha de masmorra vale o melhor preço de compra por ficha entre os itens da loja que ela compra (uma abertura de antes da 0.1.2 pega esses preços da abertura mais próxima que os registrou); itens contados (cowbells) e itens sem preço não têm valor. Custo da chave = o custo do lote da chave do baú; uma base de preço de venda significa que a chave já estava com você antes do início do registro.\",\"Nenhuma batalha vista nesta página ainda.\",\"Ainda não há sessões de combate no log: abra o Registro de loot e EXP do jogo uma vez.\",\"Ainda não há fabricações de chaves no log.\",\"Não mais guardado {a}\",\"Ainda não há tempo de run para esta masmorra\",\"Ainda não há sessões: abra o Registro de loot e EXP do jogo uma vez.\",\"Nada registrado ainda.\",\"Nada para revisar.\",\"Agora\",\"Desligado: as mensagens de batalha não são lidas, nada é registrado, e o medidor e a aba Dano ficam ocultos. Para PCs lentos. Sessões já salvas são mantidas.\",null,\"Uma run está em andamento.\",\"Abrir página de fabricação\",\"Abrir no mercado\",\"Abra o Registro de loot e EXP do jogo uma vez (Moo Pass) e as sessões dele aparecem aqui; o histórico salvo do Toolasha é mesclado no login.\",\"Abra o Registro de loot e EXP do jogo uma vez nesta sessão (Combate → Registro de loot e EXP) para que o registro possa conferir suas runs concluídas e baús com a contagem do próprio jogo.\",\"Aberturas\",\"Abre a janela de compra do jogo com {n} já preenchido\",\"Outros\",\"Outros (passivas, roubo de vida)\",\"Outros (não identificado)\",\"Outras vendas {a} não contadas\",\"Outros {a}\",\"Dano ao longo do tempo\",\"Visão geral\",\"Próprias ações (custo de HP)\",\"Possui\",\"Aparar\",\"DPS do grupo\",\"Consumíveis do grupo\",\"Dano do grupo\",\"Bebida do grupo, espaço {n}\",\"Chaves de entrada do grupo\",\"Comida do grupo, espaço {n}\",\"Por run\",\"Por chave\",\"Por segundo\",\"Por segundo em combate\",\"Por ficha\",\"Jogador\",\"Preço p/ próximo\",\"Reavaliar o estoque guardado no início do registro pelas suas próprias compras e recuperar execuções de ordens que o script não viu\",\"Recebido\",\"Receita\",\"Registrar dano\",\"Registrado antes do detalhamento (atualização 0.2.1)\",\"Trocado\",\"Atualizar preços\",\"Regeneração (a cada 10 s)\",\"Regeneração, comida e passivas\",\"Redefinir\",\"Redefinir ordem dos cartões\",\"Redefinir ordem das colunas\",\"Redefinir dados de dano\",\"Redefinir registro\",\"Resultado\",\"Revisar\",\"Tempo da run\",null,\"Aba Runs\",\"Runs salvas (vistas do início ao fim), mais recentes primeiro\",\"Sessões salvas (vistas do início ao fim), mais recentes primeiro\",\"Escala todos os tamanhos do painel, de {a} a {b} em passos de {c}.\",\"Visto por\",\"Sessão\",\"Sessões\",\"Sessões no Registro de loot e EXP do jogo\",\"Configurações\",\"Parcela\",\"Mostrar\",\"Mostrar o medidor abaixo dos cartões de batalha (Combate → Batalha)\",\"Mostrando todas as runs desde que o grupo entrou em combate, nesta página. Clique para mostrar só esta run\",\"Mostrando só esta run. Clique para mostrar todas as runs desde que o grupo entrou em combate\",\"Desde o registro\",\"Desde o início do registro\",\"Desde {date}.\",\"Habilidade\",\"Habilidades\",\"Mais lenta {a}\",\"Menor\",\"Vendido\",\"Vendido líquido\",\"Vendido {a}\",\"Fonte\",\"Gasto\",\"Início\",null,\"Resumo\",\"Suprimentos reservados para runs futuras\",\"Dano recebido\",\"Tamanho do texto\",\"A aba Dano guarda todas as sessões de qualquer forma.\",\"O melhor valor em moedas por ficha pelo qual vende, a preço de compra e descontada a taxa, qualquer item da loja que custa só esta ficha (a regra do site)\",\"A masmorra e o nível em que a taxa desta habilidade foi mais alta, em pelo menos uma hora de sessões treinando-a\",\"O log do próprio jogo (no servidor, completo entre dispositivos), mesclado com a cópia salva do Toolasha: {n} sessões\",\"O log do próprio jogo, uma linha por sessão de ação: sua contagem (runs de masmorra concluídas, ou chaves fabricadas), seus drops e XP, offline incluído. \\\"Este registro\\\" conta as runs concluídas e os baús que este registro tem para o mesmo período; ≠ marca uma diferença, destacada quando a sessão termina. A contagem do jogo é a referência; este registro só acrescenta tempos e custos que o log não tem.\",\"Este registro\",\"Só este registro: abra o Registro de loot e EXP para a contagem do jogo\",\"Esta run\",\"Espinhos (dano devolvido)\",\"Espinhos e retaliação\",\"Esses livros pelo preço de venda do mercado\",\"Tempo\",\"Tempo em combate contado pelo medidor\",\"Tempo em sessões\",\"Tempo em sessões é do início ao fim no log, então XP / h é por hora de ação em execução, offline incluído. O histórico do mercado é por dispositivo, mesclado aqui pelo id do anúncio a partir dos dados do Toolasha deste PC e de qualquer arquivo mesclado na aba Dados ({n} anúncios); o custo por chave usa o preço médio pago nesse histórico (um preço vale para a parte que foi comprada em um PC) com as quantidades da receita na sua taxa de artesão atual, já que o log não tem consumo por fabricação; nenhuma renda total é mostrada até que os registros dos dois PCs sejam mesclados (importação, etapa 5).\",\"Vezes\",\"Vezes que esta fonte restaurou HP\",\"Vezes que esta fonte restaurou MP\",\"Vezes usada. Aparar, Espinhos e dano ao longo do tempo não são lançados\",\"Hoje\",\"Ficha\",\"Totais por local (toda run vista, completa ou em parte)\",\"Local desconhecido\",\"Usar moedas da bolsa\",\"Usado\",\"Usado ao custo\",\"Usado em fabricações\",\"Usado no registro\",\"Usos\",\"Usa a navegação do próprio jogo\",\"Valor (líquido de taxa)\",\"Valor a preço de compra\",\"Aguardando os totais de habilidades do jogo.\",\"Ondas\",\"O quê\",\"O que o script não conseguiu resolver\",\"O que as técnicas de cura e o Drenar Vida deste jogador restauraram\",\"Onde\",\"XP por hora desde há {time}\",\"XP desde o início do registro é o total do jogo agora menos o total quando o registro começou, então é exato estando o script rodando ou não, jogo offline incluído. XP por hora é calculado sobre o tempo ativo: o tempo entre mensagens de XP quando o intervalo é de 15 minutos ou menos, mais o tempo offline que rendeu XP. Os dias seguem o seu próprio relógio.\",\"Aba XP\",\"XP/h\",\"Seu dano\",\"Sua parcela\",\"contra {ask} para comprar uma chave\",\"artesão {pct}\",\"quantas o orçamento comprar\",\"entre runs\",\"comprar economiza {n}\",\"cancelada\",\"verificadas {a} de {b} ondas concluídas\",\"concluída\",\"consumíveis usados {n} ({cost} a preço de compra, eventos recentes)\",\"preço de fabricação\",\"fabricar economiza {n}\",\"interrompida\",\"encerrada\",\"encerrada antes\",\"já possui o suficiente\",\"falhou\",\"buscando…\",\"a partir de {date}\",\"horas\",\"em andamento\",\"resumo de login · {a} runs no registro do chat\",\"log de loot\",\"próximo nível em {time}\",\"sem chá de artesão equipado\",\"nenhum registro ainda\",\"em pedido\",\"grupo {n} ({dps} DPS)\",\"pausado\",\"preços de {date}\",\"preços ainda não obtidos\",\"preços: {error}\",\"registro desde {date}\",\"vermelho abaixo de\",\"equipado agora\",\"costurada após recarregar\",\"totais: {n} run completa\",\"totais: {n} runs completas\",\"valor a preço de compra {a} (fichas {b}) · chaves {c}\",\"valor a preço de compra {a} · chaves {b}\",\"aguardando login\",\"onda {n}\",\"ondas {a}–{b}\",\"ficou em silêncio\",\"dentro do orçamento de {budget}\",\"{ability} (dano ao longo do tempo)\",\"{a} Canceladas\",\"{a} Baú, {b} Refinamento\",\"{a} Baús de dentro deles\",null,\"{a} Baús de masmorra abertos, a preço de compra\",\"{a} Falharam ({b})\",\"{a} Itens\",\"{a} Refinamento, {b} Baú\",\"{a} Taxa ({b})\",\"{a} técnicas\",\"{a} técnica\",\"{a} a preço de fabricação\",\"{a} consumíveis e {b} materiais de chave a preço de venda, {c} tipos de chave, {d} tipos de baú · {e} moedas\",\"{a} contando falhas\",\"{a} dia\",\"{a} dias\",\"{a} masmorra\",\"{a} masmorras\",\"{a} evento\",\"{a} eventos\",null,\"{a} itens\",\"{a} chave\",\"{a} chaves\",null,\"{a} materiais\",\"{a} disso em Fichas, pelo melhor preço de compra da loja por ficha\",\"{a} de {b} registrados\",\"{a} abertura\",\"{a} aberturas\",\"{a} trocados\",null,null,\"{a} sessão\",\"{a} sessões\",\"{a} habilidade\",\"{a} habilidades\",\"{a} até agora\",\"{a} fonte\",\"{a} ficha\",\"{a} fichas\",\"{a} usados\",\"{a} usados ({b} offline) · {c} sem preço\",\"{dmg} de dano · {share} do grupo · {dps} DPS · recebido {taken} · curado {healed}\",\"{name} tem {n} chaves\",\"{name} está sem chaves\",\"{name} está sem {item}\",\"{name} sem chaves em {time}\",\"{name} sem {item} em {time}\",\"Dano de {name}\",\"{ability} de {name}\",\"{n} HP sem explicação\",\"{n} HP sem explicação.\",\"{n} técnicas\",\"{n} técnica\",\"{n} fabricação\",\"{n} fabricações\",\"{n} morte\",\"{n} mortes\",\"{n} cada a preço de compra\",\"{n} eventos\",\"{n} concluídas + esta desde {time}\",\"{n} concluídas desde {time}\",\"{n} para revisar\",\"{n} guardados\",\"{n} não creditado\",\"{n} não creditado.\",\"{n} disso em ordens de compra\",\"{n} run vista em parte\",\"{n} runs vistas em parte\",null,\"{n} fonte\",\"{n} fontes\",\"{n} usados no registro\",\"{n} ondas\",\"{n} {key} = {crafts}, {total} para comprar\",\"{over} acima do orçamento de {budget}\",\"{result}, fechando\",\"{time} em combate\",\"· clique para detalhes\",\"− Gasto {a}\"]",
        "ru": "[\"(пусто)\",\"(снова подключён после перезагрузки)\",\"(без цены: {items})\",\"({n} на изготовление ключей)\",\"+ Монеты из сундуков {a}\",\"+ Монеты {a}\",\"+{n} в заказе\",\"На бюджет {budget}: {key} ×{n} ({crafts}) за {total}\",\"Бюджета {budget} не хватает даже на один: {key}\",\"Забег длится от одного сообщения группы о счёте ключей до следующего, как считает Toolasha; отменённые забеги в среднее не входят. Забеги, пока вы были офлайн, берутся из чата группы, их сундуки — из сводки при входе.\",\"Умения\",\"Умение\",\"Действие\",\"Активное время\",\"Все забеги\",\"Продажа\",\"На старте\",\"Атаки или тики, снявшие HP\",\"Атаки, не снявшие HP: промах, уклонение или блок\",\"Автоатака\",\"Средний забег\",\"Ср. цена\",\"Лучший темп\",\"Между забегами\",\"Спрос при открытии\",\"Спрос сейчас\",\"Цветение\",\"Книг до следующего уровня по XP за книгу из игры\",\"Книг до след.\",\"Куплено\",\"Куплено всего\",\"Куплено в запас {a}, списывается по мере расхода\",\"Бюджет\",\"Купить\",\"Журнал захвата\",\"Проверено\",\"Проверено {a} из {b} завершённых волн: каждый монстр замечен на 0 HP, и каждое очко урона засчитано игроку.\",\"Сундук\",\"Ключи от сундуков {a}\",\"Сундуки\",\"Получено сундуков\",\"Вкладка «Сундуки»\",\"Прохождения\",\"Щёлкните заголовок столбца, чтобы отсортировать по нему; ещё раз — в обратном порядке, третий раз — исходный порядок таблицы.\",\"Нажмите на игрока, чтобы увидеть его умения: урон, применения, попадания, промахи и лечение, а затем откуда пришёл полученный им урон и что его лечило. Урон — это HP, потерянное монстрами, по боевым сообщениям игры: избыточный урон не учитывается. DPS считается по времени в бою: от начала первой волны до последнего удара, без пауз между волнами. Забег подземелья попадает сюда, только если скрипт видел его от 1-й волны до конца (перезагрузка посреди волны сшивается обратно; установка обновления перезагружает страницу, поэтому такой забег обрывается). На планете сессия длится, пока не сменится бой, и переживает перезагрузки. Частично увиденные забеги тоже учитываются: выберите итоги этого подземелья в списке сессий. Парирование и шипы — контратаки; периодический урон приписывается умению, которое его наложило. Оказанное лечение включает лечащие умения, Иссушение жизни и Цветение; всё остальное, что игрок восстановил (регенерация, еда, пассивки), показано в «Вылечено». Нажмите на сессию ниже, чтобы показать её.\",\"Нажмите, чтобы увидеть умения: {name}\",\"Нажмите, чтобы открыть на рынке.\",\"Закрыть\",\"Закрыть (Esc)\",\"Монеты\",\"Монеты на материалы и монеты рецепта; следует за сумкой, пока вы не введёте число\",\"Цвета времени и предупреждений по ключам и расходникам в окне боя.\",\"Порядок столбцов и карточек\",\"Боевые навыки\",\"Боевые навыки из журнала добычи и опыта игры\",\"Время в бою\",\"Расходники\",\"Расходники {a}\",\"Содержимое\",\"Копировать список покупок\",\"Стоимость\",\"Стоимость ключа\",\"Стоимость ключа = среднее по изготовлениям ключей, которые видела эта запись (материалы по цене покупки плюс монеты рецепта); пока ни одного не видно — рецепт по ценам покупки материалов (цена продажи для никогда не покупавшихся материалов), где каждый ингредиент уменьшен на коэффициент мастерства игры (чай × Ненасытная сумка, как сообщает игра), плюс доля чая за время изготовления, а собственная цена продажи ключа — только когда у материала вообще нет цены. Ключи, имевшиеся до начала записи, оцениваются так же. «Использовано по себестоимости» списывает на каждое живое прохождение ровно ту партию, которую оно взяло; офлайн- и более старые прохождения берут среднюю цену изготовления. «На старте» = имелось при начале записи, по цене продажи на тот момент.\",\"Учитывать имеющиеся материалы\",\"Количество на последней волне для всех в бою. Под каждым числом: на сколько хватит при темпе, с которым игрок расходует предмет с момента открытия страницы (– до 10 минут и одного использования). Ключи входа берутся из сообщения группы в начале каждого забега, по среднему времени забега подземелья.\",\"Колокольчики\",\"Изготовлено\",\"Изготовлено за всё время\",\"Изготовление: {cost} за ключ по цене продажи\",\"Изготовление {a}\",\"Текущий забег\",\"Текущая сессия\",null,\"Урон\",\"Нанесено урона {n}\",\"Измеритель урона\",\"Периодический урон\",\"Сессии урона\",\"Вкладка «Урон»\",\"Получено урона {n}\",\"Урон {n}\",\"Данные\",\"Вкладка «Данные»\",\"День\",\"Дни\",\"Смерти\",\"Удалить все данные измерителя урона: сохранённые сессии ({n}), итоги по местам и текущий забег? Забеги, добыча, XP и всё остальное останутся.\",\"Удалить все сохранённые сессии урона и итоги; остальная запись останется\",\"Удалить всю запись Dungeon Stats этого персонажа? Сначала экспортируйте её, если хотите сохранить.\",\"Подробности\",\"Диагностика\",\"Скрыть до конца сессии\",\"Перетащите заголовок столбца на другой или карточку на другую, чтобы переместить. Каждая таблица и сетка карточек помнит свой порядок.\",\"Перетащите вкладку на другую, чтобы переместить её.\",\"Перетащите, чтобы изменить ширину сторон игроков и монстров; двойной щелчок — поровну\",\"Перетащите, чтобы задать ширину столбца; двойной щелчок — автоматически\",\"Напиток 1\",\"Напиток 2\",\"Напиток 3\",\"Выпало\",\"Подземелье\",\"Жетоны подземелий\",\"Подземелья\",\"Подземелья из журнала добычи и опыта игры\",\"Каждая сессия засчитывается боевому навыку, который она прокачивала: тому, что получил больше всего XP\",\"Конец\",\"Попадания по врагам: умение по площади засчитывает каждого задетого врага\",\"Ключи входа\",\"Ключи входа {a}\",\"Эссенция\",\"Всё HP, восстановленное этим игроком: лечение, Иссушение жизни, регенерация, еда и пассивки\",\"Все сохранённые сессии в Dungeon Stats\",\"Все полные сессии здесь плюс забеги, увиденные лишь частично (вход посреди забега или пропущенная волна): полезно для средних, отдельными сессиями не хранятся\",\"Всё полученное продано, в наличии, выставлено или оставлено.\",\"Всё здесь сохраняется только в этом браузере. Ниже снимите флажок со столбца, чтобы скрыть его в той таблице; столбец «Кем замечено» (источники и заметки) таблицы забегов по умолчанию выключен, и тогда у забега с заметкой рядом с результатом показан маленький флажок.\",\"Опыт в час по всем навыкам; наведите на значение, чтобы увидеть каждый навык\",\"Экспорт сырых кадров\",\"Экспорт записи (JSON)\",\"Быстрейший {a}\",\"Загрузить цены рынка заново сейчас\",\"Завершённые волны, в которых каждый монстр замечен на 0 HP и каждое очко урона засчитано игроку\",\"Первый\",\"Снова следовать за монетами в сумке\",\"Еда\",\"Еда 1\",\"Еда 2\",\"Еда 3\",\"Еда и напитки\",\"С\",\"Получено\",\"Игра: XP\",\"Игра: кол-во\",\"Игра: добыча\",\"Общее\",\"Расход HP на автоатаки\",\"Расход HP: {ability}\",\"HP, оставшееся у монстров или не засчитанное, по волнам, не прошедшим проверку\",\"Вылечено\",\"Вылечено {n}\",\"Лечение\",\"Оказано лечения\",\"В наличии\",\"В наличии по спросу\",\"В наличии по себестоимости\",\"Добыча в наличии {a} по спросу\",\"Стоимость наличия\",\"В наличии × за жетон; стоимость остатка ниже, не учитывается\",\"Скрыть\",\"Скрыть измеритель здесь; вернуть его можно в настройках Dungeon Stats\",\"Попадания\",\"Остаток\",\"Импорт истории Toolasha\",\"Импорт файла записи…\",\"В подземельях\",\"В сумке до начала записи\",\"В сумке до начала записи; можно продать отсюда, но не входит ни в добычу в наличии, ни в чистый итог\",\"Предмет\",\"Сколько оставить на будущие забеги: {item}? (сейчас {n}; 0 — сбросить)\",\"Оставить…\",\"Оставлено\",\"Ключ\",\"Время ключей и расходников: жёлтый меньше\",\"Цена ключа\",\"Изготовление ключей\",\"Изготовления ключей\",\"Изготовления ключей из журнала добычи и опыта игры\",\"Ключи\",\"Ключи в записи\",\"Вкладка «Ключи»\",\"Нужно ключей\",\"Вид\",\"Крупнее\",\"Последний\",\"Хватит примерно на {time} при {run} за забег\",\"Учётная стоимость\",\"Уровень\",\"Похищение жизни\",\"За всё время\",\"Вкладка «За всё время»\",\"Выставлено\",\"Добыча\",\"Добыча = то, что эта запись видела выпавшим из сундука или полученным за обмен жетонов. В наличии = в сумке сейчас; Выставлено = в ваших заявках на продажу. Больше нет в наличии = получено − продано − открыто − в наличии − выставлено − оставлено, по текущему спросу за вычетом налога {a}; спрос, сдвинувшийся больше чем на {b} с момента открытия (или отсутствующий), отмечается для проверки и не входит в итоги, пока не будет принят. Принятие фиксирует эту стоимость как записанное событие.\",\"Добыча при открытии\",\"Добыча, которой больше нет\",\"Вкладка «Добыча»\",\"Добыча на продажу\",\"Мана\",\"Получено маны {n}\",\"Похищение маны\",\"Потрачено маны {n}\",\"Материал\",\"Материалы\",\"Материалы, купленные на этом ПК\",\"Объединить файл истории рынка с другого ПК: массив заявок Toolasha (JSON) или его Market History CSV\",\"Объединить файл истории рынка…\",\"Объединить запись этого персонажа, экспортированную на другом ПК: события по id, повторённый чат и исполнения заявок сопоставляются, чтобы ничего не посчиталось дважды\",\"Столбцы счётчика\",null,\"Промахи\",\"Не хватает\",\"Нужно\",\"Чистыми\",\"Сначала новые. * списанные ключи взяты из счёта ключей группы (сообщение о прохождении не замечено). † XP считается с момента, когда скрипт подключился к забегу. ↰ забег уже шёл, когда началась запись.\",\"Сначала новые. Источник = игровое сообщение, из которого пришло событие. Использования расходников записываются, но показываются только в \\\"consume\\\".\",\"Сначала новые. Стоимость по спросу = наивысший спрос на каждый предмет в момент открытия сундука; жетон подземелья стоит лучший спрос за жетон среди товаров магазина, которые на него покупаются (открытие до версии 0.1.2 берёт эти цены у ближайшего открытия, где они записаны); счётные предметы (колокольчики) и предметы без цены стоимости не имеют. Цена ключа = себестоимость партии ключа от сундука; основа «продажа» означает, что ключ был в наличии до начала записи.\",\"На этой странице ещё не было боя.\",\"В журнале пока нет боевых сессий: откройте журнал добычи и опыта игры один раз.\",\"В журнале пока нет изготовлений ключей.\",\"Больше нет в наличии {a}\",\"Для этого подземелья ещё нет времени забега\",\"Сессий пока нет: откройте журнал добычи и опыта игры один раз.\",\"Пока ничего не записано.\",\"Нечего проверять.\",\"Сейчас\",\"Выкл.: боевые сообщения не читаются вовсе, ничего не записывается, измеритель и вкладка «Урон» скрыты. Для медленных ПК. Уже сохранённые сессии остаются.\",\"Офлайн {a}\",\"Идёт один забег.\",\"Открыть страницу изготовления\",\"Открыть на рынке\",\"Откройте журнал добычи и опыта игры один раз (Moo Pass), и его сессии появятся здесь; сохранённая история Toolasha объединяется при входе.\",\"Откройте журнал добычи и опыта игры один раз за эту сессию (Бой → Журнал добычи и опыта), чтобы запись сверила свои прохождения и сундуки со счётом самой игры.\",\"Открытия\",\"Открывает окно покупки игры с количеством {n}\",\"Прочее\",\"Прочее (пассивки, вампиризм)\",\"Прочее (не определено)\",\"Прочие продажи {a} не учтены\",\"Прочее {a}\",\"Периодический урон\",\"Обзор\",\"Свои действия (расход HP)\",\"Есть\",\"Парирование\",\"DPS группы\",\"Расходники группы\",\"Урон группы\",\"Напитки группы, слот {n}\",\"Ключи входа группы\",\"Еда группы, слот {n}\",\"За прохождение\",\"За ключ\",\"В секунду\",\"В секунду боя\",\"За жетон\",\"Игрок\",\"Цена до след.\",\"Переоценить запас на старте записи по вашим собственным покупкам и догнать исполнения заявок, которые скрипт не видел\",\"Получено\",\"Рецепт\",\"Записывать урон\",\"Записано до появления разбивки (обновление 0.2.1)\",\"Обменяно\",\"Обновить цены\",\"Регенерация (каждые 10 с)\",\"Регенерация, еда и пассивки\",\"Сбросить\",\"Сбросить порядок карточек\",\"Сбросить порядок столбцов\",\"Сбросить данные урона\",\"Сбросить запись\",\"Результат\",\"Проверка\",\"Время забега\",\"Забеги\",\"Вкладка «Забеги»\",\"Сохранённые забеги (увиденные от начала до конца), сначала новые\",\"Сохранённые сессии (увиденные от начала до конца), сначала новые\",\"Масштабирует все размеры в панели, от {a} до {b} с шагом {c}.\",\"Кем замечено\",\"Сессия\",\"Сессии\",\"Сессии в журнале добычи и опыта игры\",\"Настройки\",\"Доля\",\"Показать\",\"Показывать измеритель под карточками боя (Бой → Бой)\",\"Показаны все забеги с момента входа группы в бой на этой странице. Нажмите, чтобы показать только этот забег\",\"Показан только этот забег. Нажмите, чтобы показать все забеги с момента входа группы в бой\",\"С начала записи\",\"С начала записи\",\"С {date}.\",\"Навык\",\"Навыки\",\"Медленнейший {a}\",\"Мельче\",\"Продано\",\"Продано чистыми\",\"Продано {a}\",\"Источник\",\"Потрачено\",\"Начало\",\"Статус\",\"Сводка\",\"Запасы, оставленные на будущие забеги\",\"Получ. урон\",\"Размер текста\",\"Вкладка «Урон» в любом случае хранит все сессии.\",\"Лучшая выручка в монетах за жетон среди товаров магазина, которые стоят только этот жетон, при продаже по спросу за вычетом налога (правило сайта)\",\"Подземелье и уровень сложности, где темп этого навыка был выше всего, минимум за час сессий с его прокачкой\",\"Собственный журнал игры (на сервере, полный для всех устройств), объединённый с сохранённой копией Toolasha: сессий {n}\",\"Собственный журнал игры, одна строка на сессию действия: её счёт (прохождения подземелий или изготовленные ключи), добыча и XP, включая офлайн. «Эта запись» считает прохождения и сундуки, которые есть у этой записи за тот же промежуток; ≠ отмечает расхождение, оно подсвечивается после окончания сессии. Счёт игры — эталон; эта запись лишь добавляет время и затраты, которых нет в журнале.\",\"Эта запись\",\"Только эта запись: откройте журнал добычи и опыта, чтобы увидеть счёт игры\",\"Этот забег\",\"Шипы (отражённый урон)\",\"Шипы и ответный удар\",\"Эти книги по цене продажи на рынке\",\"Время\",\"Время боя, учтённое счётчиком\",\"Время в сессиях\",\"Время в сессиях — это начало–конец по журналу, поэтому XP / h — на час работы действия, включая офлайн. История рынка своя на каждом устройстве и объединяется здесь по id заявки из хранилища Toolasha этого ПК и всех файлов, объединённых на вкладке «Данные» (заявок: {n}); стоимость ключа берёт среднюю уплаченную цену из этой истории (цена отражает ту долю, что была куплена на одном ПК) с количествами рецепта при вашем текущем коэффициенте мастерства, так как в журнале нет расхода на каждое изготовление; доход за всё время не показывается, пока записи с обоих ПК не объединены (импорт, этап 5).\",\"Раз\",\"Сколько раз этот источник восстановил HP\",\"Сколько раз этот источник восстановил MP\",\"Число применений. Парирование, шипы и периодический урон не применяются\",\"Сегодня\",\"Жетон\",\"Итоги по местам (каждый замеченный забег, полностью или частично)\",\"Неизвестное место\",\"Монеты из сумки\",\"Использовано\",\"Использовано по себестоимости\",\"Ушло на изготовление\",\"Использовано в записи\",\"Применения\",\"Использует навигацию самой игры\",\"Стоимость (за вычетом налога)\",\"Стоимость по спросу\",\"Ожидание итогов навыков от игры.\",\"Волны\",\"Что\",\"Что скрипт не смог сопоставить\",\"Сколько восстановили лечащие умения этого игрока и Иссушение жизни\",\"Где\",\"Опыт в час за последние {time}\",\"XP с начала записи — это нынешний общий XP в игре минус итог на момент начала записи, поэтому он точен независимо от того, работал ли скрипт, включая офлайн-игру. XP в час считается по активному времени: время между сообщениями об XP, если промежуток не больше 15 минут, плюс офлайн-время, принёсшее XP. Дни — по вашим собственным часам.\",\"Вкладка «XP»\",\"Опыт/ч\",\"Ваш урон\",\"Ваша доля\",\"против {ask} за покупку ключа\",\"мастерство {pct}\",\"сколько позволяет бюджет\",\"между забегами\",\"покупка экономит {n}\",\"отменён\",\"проверено {a} из {b} завершённых волн\",\"пройден\",\"использовано расходников {n} ({cost} по цене покупки, недавние события)\",\"цена изготовления\",\"изготовление экономит {n}\",\"прерван\",\"завершён\",\"завершён досрочно\",\"хватает имеющихся\",\"провален\",\"загрузка…\",\"с {date}\",\"часов\",\"идёт\",\"сводка при входе · забегов в журнале чата: {a}\",\"журнал добычи\",\"следующий уровень через {time}\",\"чай мастерства не установлен\",\"записи пока нет\",\"в заказе\",\"группа {n} ({dps} DPS)\",\"пауза\",\"цены на {date}\",\"цены ещё не загружены\",\"цены: {error}\",\"запись с {date}\",\"красный меньше\",\"установлен сейчас\",\"сшит после перезагрузки\",\"итоги: полных забегов {n}\",\"итоги: полных забегов {n}\",\"стоимость по спросу {a} (жетоны {b}) · ключи {c}\",\"стоимость по спросу {a} · ключи {b}\",\"ожидание входа\",\"волна {n}\",\"волны {a}–{b}\",\"затих\",\"в пределах бюджета {budget}\",\"{ability} (периодический урон)\",\"Отменено: {a}\",\"Сундуков: {a}, очистки: {b}\",\"Сундуков внутри них: {a}\",null,\"{a} — открытые сундуки подземелий, по спросу\",\"Провалено: {a} ({b})\",\"Предметы {a}\",\"Очистки: {a}, сундуков: {b}\",\"Налог {a} ({b})\",\"умений: {a}\",\"умений: {a}\",\"{a} по цене изготовления\",\"Расходников: {a} и материалов ключей: {b} по цене продажи, видов ключей: {c}, видов сундуков: {d} · монет: {e}\",\"{a} с учётом провалов\",\"{a} дн.\",\"{a} дн.\",\"подземелий: {a}\",\"подземелий: {a}\",\"событий: {a}\",\"событий: {a}\",\"предметов: {a}\",\"предметов: {a}\",\"ключей: {a}\",\"ключей: {a}\",\"материалов: {a}\",\"материалов: {a}\",\"из них {a} — жетоны, по лучшему спросу магазина за жетон\",\"записано {a} из {b}\",\"открытий: {a}\",\"открытий: {a}\",\"обменяно {a}\",\"забегов: {a}\",\"забегов: {a}\",\"сессий: {a}\",\"сессий: {a}\",\"навыков: {a}\",\"навыков: {a}\",\"пока {a}\",\"источников: {a}\",\"жетонов: {a}\",\"жетонов: {a}\",\"использовано {a}\",\"использовано {a} ({b} офлайн) · без цены {c}\",\"урон {dmg} · {share} группы · {dps} DPS · получено {taken} · вылечено {healed}\",\"{name}: ключей {n}\",\"{name}: ключи кончились\",\"{name}: {item} кончился\",\"{name}: ключи кончатся через {time}\",\"{name}: {item} кончится через {time}\",\"Урон: {name}\",\"{name}: {ability}\",\"{n} HP не объяснено\",\"{n} HP не объяснено.\",\"умений: {n}\",\"умений: {n}\",\"изготовлений: {n}\",\"изготовлений: {n}\",\"смертей: {n}\",\"смертей: {n}\",\"{n} за шт. по цене покупки\",\"событий: {n}\",\"завершено {n} + текущий с {time}\",\"завершено {n} с {time}\",\"на проверку: {n}\",\"в наличии {n}\",\"{n} не засчитано\",\"{n} не засчитано.\",\"из них {n} в заявках на покупку\",\"частично увиденных забегов: {n}\",\"частично увиденных забегов: {n}\",\"забегов: {n}\",\"источников: {n}\",\"источников: {n}\",\"использовано в записи: {n}\",\"волн: {n}\",\"{key} ×{n} = {crafts}, купить за {total}\",\"на {over} больше бюджета {budget}\",\"{result}, закрытие\",\"{time} в бою\",\"· нажмите для подробностей\",\"− Потрачено {a}\"]",
        "zh": "[\"（空白）\",\"（刷新后重新加入）\",\"（{items} 无价格）\",\"（其中 {n} 用于制作钥匙）\",\"+ 宝箱金币 {a}\",\"+ {a} 金币\",\"+{n} 已下单\",\"预算 {budget} 可买 {n} 个{key}（{crafts}），共 {total}\",\"预算 {budget} 不够一个{key}\",\"一轮从一条队伍钥匙计数消息持续到下一条，与 Toolasha 的计法相同；已取消的轮次不计入平均值。离线期间的轮次来自队伍聊天，其宝箱来自登录汇总。\",\"技能\",\"技能\",\"行动\",\"活跃时间\",\"全部轮次\",\"卖价\",\"起始时\",\"造成 HP 损失的攻击或跳伤\",\"未造成 HP 损失的攻击：未命中、被闪避或被格挡\",\"普通攻击\",\"平均每轮\",\"均价\",\"最佳速率\",\"轮次之间\",\"开启时买价\",\"当前买价\",\"绽放\",\"升到下一级所需的书本数，按游戏中每本书的 XP 计算\",\"升级所需书本\",\"已买入\",\"买入总计\",\"作为库存买入 {a}，按使用计费\",\"预算\",\"购买\",\"录制日志\",\"已核对\",\"已核对 {b} 个已完成波次中的 {a} 个：每只怪物都被看到降至 0 HP，每一点伤害都已计入某位玩家。\",\"宝箱\",\"宝箱钥匙 {a}\",\"宝箱\",\"获得的宝箱\",\"宝箱标签页\",\"通关\",\"点击列标题按该列排序；再次点击反转，第三次点击恢复表格原本的顺序。\",\"点击玩家查看其技能：伤害、使用次数、命中、未命中和治疗，以及其承受伤害的来源和治疗来源。伤害是怪物损失的 HP，读取自游戏的战斗消息：溢出伤害不计入。DPS 按战斗时间计算：从第一波开始到最后一击，不含波次之间的间隔。只有当脚本从第 1 波一直看到结束时，地下城轮次才会列在这里（波次中途刷新会被拼接回来；安装更新会刷新页面，因此那一轮会被截断）。在星球上，一段记录持续到战斗变更为止，跨越刷新。只看到部分的轮次仍然计入：在记录列表中选择该地下城的总计即可。格挡和荆棘反伤是反击；持续伤害记在施加它的技能上。治疗量包括治疗技能、生命吸取和绽放；玩家恢复的其他一切（自然恢复、食物、被动）显示在“受到治疗”下。点击下方的记录以显示它。\",\"点击查看 {name} 的技能\",\"点击在市场中打开。\",\"关闭\",\"关闭（Esc）\",\"金币\",\"用于购买材料和支付配方金币的金币；在你输入数值之前跟随背包中的金币\",\"战斗窗口中钥匙和消耗品时间及提示的颜色。\",\"列与卡片顺序\",\"战斗技能\",\"战斗技能，来自游戏的掉落与经验记录\",\"战斗时间\",\"消耗品\",\"消耗品 {a}\",\"内容\",\"复制购物清单\",\"成本\",\"每把钥匙成本\",\"每把钥匙成本 = 本记录见过的钥匙制作的平均值（材料按买入价，加上配方金币）；在见到一次之前，按配方以材料买入价计算（从未买过的材料按卖价），每项投入按游戏的工匠比率扣减（茶 × 暴饮之囊，以游戏显示为准），再加上茶在制作时间中所占的份额；只有当某种材料完全没有价格时才用钥匙自身的卖价。记录开始前持有的钥匙按同样方式定价。“按成本使用”对每次实时通关计入其实际消耗的那一批；离线和较早的通关使用制作平均值。起始时 = 记录开始时持有的，按当时的卖价定价。\",\"计入已有材料\",\"截至上一波，战斗中每个人的持有数量。每个数量下方：按该玩家自本页面打开以来的使用速度还能用多久（满 10 分钟且使用一次之前显示 –）。入场钥匙来自每次开始时游戏的队伍消息，按该地下城的平均通关时间计算。\",\"牛铃\",\"已制作\",\"累计制作\",\"按卖价每把钥匙制作成本 {cost}\",\"制作 {a}\",\"当前轮次\",\"当前场次\",null,\"伤害\",\"造成伤害 {n}\",\"伤害统计\",\"持续伤害\",\"伤害场次\",\"伤害标签页\",\"承受伤害 {n}\",\"伤害 {n}\",\"数据\",\"数据标签页\",\"日\",\"天数\",\"死亡\",\"删除所有伤害统计数据：{n} 个已保存场次、各地点总计和进行中的轮次？轮次、掉落、XP 及其他所有数据都会保留。\",\"删除所有已保存的伤害场次和总计；记录中的其余数据保留\",\"删除此角色的全部 Dungeon Stats 记录？如需保留，请先导出。\",\"详情\",\"诊断\",\"本次会话不再显示\",\"将列标题拖到另一列上，或将卡片拖到另一张卡片上，即可移动。每个表格和卡片网格都会记住各自的顺序。\",\"将标签拖到另一个标签上即可移动。\",\"拖动以调整玩家一侧和怪物一侧的宽度；双击恢复平分\",\"拖动设置此列宽度；双击恢复自动\",\"饮料 1\",\"饮料 2\",\"饮料 3\",\"掉落\",\"地下城\",\"地下城代币\",\"地下城\",\"地下城，来自游戏的掉落与经验记录\",\"每个场次计入其训练的战斗技能：即获得 XP 最多的那一项\",\"结束\",\"命中的敌人：范围技能按命中的每个敌人计数\",\"入场钥匙\",\"入场钥匙 {a}\",\"精华\",\"该玩家恢复的全部 HP：治疗、生命吸取、自然恢复、食物和被动\",\"Dungeon Stats 中的所有已保存场次\",\"这里的所有完整场次，加上只看到部分的轮次（中途加入或漏掉一波）：可用于计算平均值，但不单独保存为场次\",\"所有获得的物品均已卖出、持有、挂单或保留。\",\"这里的所有内容只保存在本浏览器中。在下方取消勾选某列即可在该表格中隐藏它；轮次表的“来源”（来源与备注）默认关闭，此时带备注的轮次会在结果旁显示一个小标记。\",\"所有技能的每小时经验；将鼠标悬停在数值上查看各技能\",\"导出原始帧\",\"导出记录（JSON）\",\"最快 {a}\",\"立即重新获取市场价格\",\"已完成的波次中，每只怪物都被看到降至 0 HP，且每一点伤害都已计入某位玩家\",\"首次\",\"重新跟随背包中的金币\",\"食物\",\"食物 1\",\"食物 2\",\"食物 3\",\"食物和饮料\",\"从\",\"获得\",\"游戏：XP\",\"游戏：次数\",\"游戏：掉落\",\"常规\",\"普通攻击的 HP 消耗\",\"{ability} 的 HP 消耗\",\"在未通过核对的波次中，剩余或未计入的 HP\",\"受到治疗\",\"受到治疗 {n}\",\"治疗\",\"治疗量\",\"持有\",\"持有（按买价）\",\"持有（按成本）\",\"持有掉落物 {a}（按买价）\",\"持有价值\",\"持有 × 每个代币价值；下方为结余的价值，不计入\",\"隐藏\",\"在此隐藏统计面板；可在 Dungeon Stats 设置中恢复\",\"命中\",\"结余\",\"导入 Toolasha 历史\",\"导入记录文件…\",\"在地下城中\",\"记录开始前已在背包中\",\"记录开始前已在背包中；可在此出售，但不计入持有掉落物或净值\",\"物品\",\"为以后的轮次保留多少 {item}？（当前 {n}；0 为清除）\",\"保留…\",\"保留\",\"钥匙\",\"钥匙和消耗品时间：低于此值显示黄色\",\"钥匙成本\",\"钥匙制作\",\"钥匙制作\",\"钥匙制作，来自游戏的掉落与经验记录\",\"钥匙\",\"记录中的钥匙\",\"钥匙标签页\",\"所需钥匙\",\"类型\",\"放大\",\"最近\",\"按每次 {run} 计算，约可用 {time}\",\"账目成本\",\"等级\",\"生命偷取\",\"累计\",\"累计标签页\",\"挂单中\",\"掉落物\",\"掉落物 = 本记录看到的从宝箱开出或代币兑换得到的物品。持有 = 当前在背包中；挂单中 = 在你的卖单上。不再持有 = 获得 − 卖出 − 开启 − 持有 − 挂单 − 保留，按当前买价扣除 {a} 税计价；自开启以来变动超过 {b} 的买价（或没有买价）会被标记为待审核，在接受之前不计入总计。接受后该价值会作为一条已记录事件固定下来。\",\"开启时掉落物\",\"不再持有的掉落物\",\"掉落物标签页\",\"待售掉落物\",\"法力\",\"回复法力 {n}\",\"法力吸取\",\"消耗法力 {n}\",\"材料\",\"材料\",\"在此电脑上买入的材料\",\"合并来自另一台电脑的市场历史文件：Toolasha 的挂单数组（JSON）或其市场历史 CSV\",\"合并市场历史文件…\",\"合并此角色在另一台电脑上导出的记录：事件按 id 合并，重放的聊天和挂单成交会被匹配，不会重复计数\",\"伤害统计列\",null,\"未命中\",\"缺少\",\"需要\",\"净值\",\"最新在前。* 消耗的钥匙读取自队伍钥匙计数（未看到通关消息）。† XP 从脚本加入该轮时开始计算。↰ 记录开始时该轮已在进行中。\",\"最新在前。来源 = 该事件所来自的游戏消息。消耗品的使用会被记录，但只在“consume”下显示。\",\"最新在前。买价价值 = 开启宝箱时每件物品的最高买价；地下城代币的价值为其可兑换的商店物品中每个代币的最佳买价（0.1.2 之前的开启记录从最近一次记录了这些买价的开启中取值）；计数类物品（牛铃）和无价格物品不计价值。钥匙成本 = 宝箱钥匙那一批的成本；以卖价为基准表示该钥匙在记录开始前就已持有。\",\"此页面尚未看到战斗。\",\"日志中还没有战斗场次：请打开一次游戏的掉落与经验记录。\",\"日志中还没有钥匙制作。\",\"不再持有 {a}\",\"此地下城尚无通关时间记录\",\"还没有场次：请打开一次游戏的掉落与经验记录。\",\"尚无记录。\",\"没有待审核的内容。\",\"现在\",\"关闭：完全不读取战斗消息，不记录任何内容，统计面板和伤害标签页均隐藏。适用于较慢的电脑。已保存的场次会保留。\",\"离线 {a}\",\"有一轮正在进行中。\",\"打开制作页面\",\"在市场中打开\",\"打开一次游戏的掉落与经验记录（Moo Pass），其场次就会显示在这里；Toolasha 保存的历史会在登录时合并。\",\"请在本次会话中打开一次游戏的掉落与经验记录（战斗 → 掉落与经验记录），以便记录能将其通关和宝箱与游戏自身的计数核对。\",\"开启次数\",\"打开游戏的购买窗口并填入 {n}\",\"其他\",\"其他（被动、吸血）\",\"其他（未识别）\",\"其他销售 {a} 未计入\",\"其他 {a}\",\"持续伤害\",\"概览\",\"自身行动（HP 消耗）\",\"已拥有\",\"格挡\",\"队伍 DPS\",\"队伍消耗品\",\"队伍伤害\",\"队伍饮料栏位 {n}\",\"队伍入场钥匙\",\"队伍食物栏位 {n}\",\"每次通关\",\"每把钥匙\",\"每秒\",\"战斗中每秒\",\"每个代币\",\"玩家\",\"升级所需价格\",\"根据你自己的购买记录重新为记录开始时持有的库存定价，并补上脚本未看到的成交\",\"收到\",\"配方\",\"记录伤害\",\"在细分统计之前记录（更新 0.2.1）\",\"已兑换\",\"刷新价格\",\"自然恢复（每 10 秒）\",\"自然恢复、食物和被动\",\"重置\",\"重置卡片顺序\",\"重置列顺序\",\"重置伤害数据\",\"重置记录\",\"结果\",\"审核\",\"每轮用时\",\"轮次\",\"轮次标签页\",\"已保存的轮次（从开始看到结束），最新在前\",\"已保存的场次（从开始看到结束），最新在前\",\"缩放面板中的所有尺寸，范围 {a} 到 {b}，步长 {c}。\",\"观测来源\",\"场次\",\"场次\",\"游戏掉落与经验记录中的场次\",\"设置\",\"占比\",\"显示\",\"在战斗卡片下方显示统计面板（战斗 → 交战）\",\"正在显示本页面上队伍进入战斗以来的每一轮。点击只显示本轮\",\"只显示本轮。点击显示队伍进入战斗以来的每一轮\",\"自记录开始\",\"自记录开始以来\",\"自 {date} 起。\",\"技能\",\"技能\",\"最慢 {a}\",\"缩小\",\"已卖出\",\"卖出净额\",\"已卖出 {a}\",\"来源\",\"花费\",\"开始\",\"状态\",\"汇总\",\"为以后轮次保留的物资\",\"承受\",\"文字大小\",\"无论如何，伤害标签页都会保留每个场次。\",\"在只需此代币购买的商店物品中，按买价扣税后每个代币可得的最高金币（网站规则）\",\"在至少一小时训练该技能的场次中，该技能速率最高的地下城和难度\",\"游戏自身的日志（服务器端，跨设备完整），与 Toolasha 保存的副本合并：{n} 个场次\",\"游戏自身的日志，每个行动时段一行：其次数（地下城通关或制作的钥匙）、掉落和 XP，包括离线。“本记录”统计本记录在同一时段内的通关和宝箱；≠ 表示存在差异，在该时段结束后高亮显示。以游戏的计数为准；本记录只补充日志中没有的时间和成本。\",\"本记录\",\"仅本记录：打开掉落与经验记录以获取游戏的计数\",\"本轮\",\"荆棘反伤（反弹的伤害）\",\"荆棘反伤与反击\",\"这些书按市场卖价\",\"时间\",\"统计已计入的战斗时间\",\"场次时长\",\"场次时长为日志中的开始到结束，因此 XP / h 是按行动运行的每小时计算，包括离线。市场历史按设备分别保存，在此按挂单 id 合并本电脑的 Toolasha 存储和在数据标签页中合并的任何文件（{n} 条挂单）；每把钥匙成本取该历史中的平均成交价（一个价格只代表在某一台电脑上买入的那部分），配方数量按你当前的工匠比率计算，因为日志中没有每次制作的消耗；在两台电脑的记录合并之前（导入，里程碑 5），不显示累计收入。\",\"次数\",\"该来源恢复 HP 的次数\",\"此来源回复 MP 的次数\",\"使用次数。格挡、荆棘反伤和持续伤害不算施放\",\"今天\",\"代币\",\"各地点总计（所有看到的轮次，完整或部分）\",\"未知地点\",\"使用背包金币\",\"已使用\",\"按成本使用\",\"制作消耗\",\"记录中已使用\",\"使用次数\",\"使用游戏自身的导航\",\"价值（税后）\",\"买价价值\",\"正在等待游戏的技能总计。\",\"波次\",\"内容\",\"脚本无法确定的内容\",\"该玩家的治疗技能和生命吸取恢复的量\",\"地点\",\"{time} 前至今的每小时经验\",\"自记录开始以来的 XP 等于游戏当前的累计总量减去记录开始时的总量，因此无论脚本是否在运行（包括离线游戏）都是精确的。每小时 XP 按活跃时间计算：间隔不超过 15 分钟的 XP 消息之间的时间，加上获得了 XP 的离线时间。日期按你本地的时钟。\",\"XP 标签页\",\"经验/小时\",\"你的伤害\",\"你的占比\",\"对比买一把钥匙的 {ask}\",\"工匠 {pct}\",\"预算能买的最大数量\",\"轮次之间\",\"购买可省 {n}\",\"已取消\",\"已核对 {b} 个已完成波次中的 {a} 个\",\"已通关\",\"已用消耗品 {n}（按买入价 {cost}，近期事件）\",\"制作价\",\"制作可省 {n}\",\"被截断\",\"已结束\",\"提前结束\",\"已有足够\",\"失败\",\"获取中…\",\"自 {date}\",\"小时\",\"进行中\",\"登录汇总 · 聊天账目中 {a} 轮\",\"掉落日志\",\"{time} 后升级\",\"未装备工匠茶\",\"尚无记录\",\"已下单\",\"队伍 {n}（{dps} DPS）\",\"已暂停\",\"价格更新于 {date}\",\"尚未获取价格\",\"价格：{error}\",\"自 {date} 起记录\",\"低于此值显示红色\",\"当前已装备\",\"刷新后已拼接\",\"总计：{n} 轮完整\",\"总计：{n} 轮完整\",\"买价价值 {a}（代币 {b}）· 钥匙 {c}\",\"买价价值 {a} · 钥匙 {b}\",\"等待登录\",\"第 {n} 波\",\"第 {a}–{b} 波\",\"已无动静\",\"在 {budget} 预算内\",\"{ability} 持续伤害\",\"{a} 已取消\",\"{a} 宝箱，{b} 精炼\",\"{a} 从中开出的宝箱\",null,\"{a} 已开启的地下城宝箱，按买价\",\"{a} 失败（{b}）\",\"{a} 物品\",\"{a} 精炼，{b} 宝箱\",\"{a} 税（{b}）\",\"{a} 个技能\",\"{a} 个技能\",\"{a}（按制作价）\",\"{a} 种消耗品和 {b} 种钥匙材料按卖价计价，{c} 种钥匙，{d} 种宝箱 · {e} 金币\",\"{a}（计入失败）\",\"{a} 天\",\"{a} 天\",\"{a} 个地下城\",\"{a} 个地下城\",\"{a} 个事件\",\"{a} 个事件\",\"{a} 件物品\",\"{a} 件物品\",\"{a} 把钥匙\",\"{a} 把钥匙\",\"{a} 种材料\",\"{a} 种材料\",\"其中代币 {a}，按每个代币的最佳商店买价\",\"已记录 {a}/{b}\",\"{a} 次开启\",\"{a} 次开启\",\"已兑换 {a}\",\"{a} 轮\",\"{a} 轮\",\"{a} 个场次\",\"{a} 个场次\",\"{a} 个技能\",\"{a} 个技能\",\"目前 {a}\",\"{a} 个来源\",\"{a} 个代币\",\"{a} 个代币\",\"已使用 {a}\",\"已使用 {a}（离线 {b}）· {c} 无价格\",\"{dmg} 伤害 · 占队伍 {share} · {dps} DPS · 承受 {taken} · 受到治疗 {healed}\",\"{name} 有 {n} 把钥匙\",\"{name} 的钥匙已用完\",\"{name} 的 {item} 已用完\",\"{name} 的钥匙将在 {time} 后用完\",\"{name} 的 {item} 将在 {time} 后用完\",\"{name} 的伤害\",\"{name} 的{ability}\",\"{n} HP 无法解释\",\"{n} HP 无法解释。\",\"{n} 个技能\",\"{n} 个技能\",\"{n} 次制作\",\"{n} 次制作\",\"{n} 次死亡\",\"{n} 次死亡\",\"按买入价每个 {n}\",\"{n} 个事件\",\"自 {time} 起已完成 {n} 轮 + 本轮\",\"自 {time} 起已完成 {n} 轮\",\"{n} 待审核\",\"持有 {n}\",\"{n} 未计入\",\"{n} 未计入。\",\"其中 {n} 在买单中\",\"{n} 轮部分看到\",\"{n} 轮部分看到\",\"{n} 轮\",\"{n} 个来源\",\"{n} 个来源\",\"记录中已使用 {n}\",\"{n} 波\",\"{n} 个{key} = {crafts}，购买需 {total}\",\"超出 {budget} 预算 {over}\",\"{result}，正在关闭\",\"战斗 {time}\",\"· 点击查看详情\",\"− 花费 {a}\"]",
        "zh-Hant": "[\"（空白）\",\"（重新載入後重新加入）\",\"（{items} 無價格）\",\"（{n} 用於製作鑰匙）\",\"+ 寶箱金幣 {a}\",\"+ {a} 金幣\",\"+{n} 已下單\",\"預算 {budget} 可用 {total} 買到 {n} 把 {key}（{crafts}）\",\"預算 {budget} 不足以購買一把 {key}\",\"一輪從一條隊伍鑰匙計數訊息持續到下一條，與 Toolasha 的計算方式相同；已取消的輪次不計入平均。離線期間的輪次取自隊伍聊天，其寶箱取自登入摘要。\",\"技能\",\"技能\",\"行動\",\"活躍時間\",\"所有輪次\",\"賣價\",\"起始時\",\"造成 HP 損失的攻擊或持續傷害跳數\",\"未造成 HP 損失的攻擊：未命中、被閃避或被格擋\",\"普通攻擊\",\"平均每輪\",\"平均價格\",\"最佳效率\",\"輪次之間\",\"開啟時買價\",\"目前買價\",\"綻放\",\"升到下一級所需的書數，按遊戲中每本書的 XP 計算\",\"升級所需書數\",\"已購買\",\"購買總計\",\"以庫存購入 {a}，按使用量計費\",\"預算\",\"買入\",\"擷取日誌\",\"已核對\",\"已核對 {b} 個已完成波次中的 {a} 個：每隻怪物都見到降至 0 HP，且每點傷害都歸屬到某位玩家。\",\"寶箱\",\"寶箱鑰匙 {a}\",\"寶箱\",\"獲得的寶箱\",\"寶箱分頁\",\"通關\",\"點擊欄位標題依該欄排序；再點一次反轉，第三次恢復表格原本的順序。\",\"點擊玩家可查看其技能：傷害、使用次數、命中、未命中與治療，以及其承受傷害的來源和治療來源。傷害為怪物損失的 HP，讀取自遊戲的戰鬥訊息：溢出傷害不計。DPS 按戰鬥時間計算：從第一波開始到最後一擊，不含波次之間的間隔。地下城的一輪只有在腳本從第 1 波看到結束時才會列在這裡（波次中途重新載入會被接續回去；安裝更新會重新載入頁面，因此該輪會被截斷）。在星球上，一個場次持續到戰鬥改變為止，可跨越重新載入。只看到部分的輪次仍會計入：在場次清單中選擇該地下城的總計。格擋和荊棘反傷屬於反擊；持續傷害記在施加它的技能上。治療量包含治療技能、生命吸取和綻放；玩家回復的其他一切（恢復、食物、被動）顯示在「受到治療」下。點擊下方的場次即可顯示。\",\"點擊查看 {name} 的技能\",\"點擊在市場中開啟。\",\"關閉\",\"關閉（Esc）\",\"金幣\",\"用於購買材料及配方所需金幣的金額；在你輸入數字前跟隨背包中的金幣\",\"戰鬥視窗中鑰匙和消耗品時間及提示的顏色。\",\"欄位與卡片順序\",\"戰鬥技能\",\"戰鬥技能，取自遊戲的掉落與經驗記錄\",\"戰鬥時間\",\"消耗品\",\"消耗品 {a}\",\"內容\",\"複製購物清單\",\"成本\",\"每把鑰匙成本\",\"每把鑰匙成本 = 本紀錄所見鑰匙製作的平均值（材料按購入價，加上配方所需金幣）；在看到任何一次製作之前，按材料購入價計算配方（從未買過的材料用賣價），每項材料按遊戲的工匠減免率削減（茶 × 暴飲之囊，以遊戲回報為準），加上茶按製作時間分攤的份額；只有當某材料完全沒有價格時才用鑰匙本身的賣價。紀錄開始前持有的鑰匙也以相同方式計價。「按成本使用」為每次即時通關計入其實際消耗的那一批；離線和較早的通關使用製作平均值。起始時 = 紀錄開始時持有，按當時賣價計價。\",\"計入已擁有的材料\",\"截至上一波，戰鬥中每個人的持有數量。每個數量下方：按該玩家自本頁面開啟以來的使用速度還能用多久（滿 10 分鐘且使用一次之前顯示 –）。入場鑰匙來自每次開始時遊戲的隊伍訊息，按該地下城的平均通關時間計算。\",\"牛鈴\",\"已製作\",\"累計製作\",\"按賣價計，每把鑰匙製作成本 {cost}\",\"製作 {a}\",\"目前這輪\",\"目前場次\",null,\"傷害\",\"造成傷害 {n}\",\"傷害統計\",\"持續傷害\",\"傷害場次\",\"傷害分頁\",\"承受傷害 {n}\",\"傷害 {n}\",\"資料\",\"資料分頁\",\"日\",\"天數\",\"死亡\",\"刪除所有傷害統計資料：{n} 個已儲存場次、各地點總計以及進行中的這輪？輪次、掉落物、XP 及其他所有內容都會保留。\",\"刪除所有已儲存的傷害場次和總計；紀錄的其餘部分保留\",\"刪除此角色的整份 Dungeon Stats 紀錄？如需保留請先匯出。\",\"詳情\",\"診斷\",\"本次不再顯示\",\"將欄位標題拖到另一個標題上，或將卡片拖到另一張卡片上即可移動。每個表格和卡片網格都會記住各自的順序。\",\"將分頁拖到另一個分頁上即可移動。\",\"拖曳以調整玩家一側和怪物一側的寬度；雙擊恢復平分\",\"拖曳設定此欄寬度；按兩下恢復自動\",\"飲料 1\",\"飲料 2\",\"飲料 3\",\"掉落\",\"地下城\",\"地下城代幣\",\"地下城\",\"地下城，取自遊戲的掉落與經驗記錄\",\"每個場次計入其所訓練的戰鬥技能：即其中 XP 最多的那項\",\"結束\",\"命中的敵人：範圍技能命中的每個敵人各計一次\",\"入場鑰匙\",\"入場鑰匙 {a}\",\"精華\",\"此玩家回復的所有 HP：治療、生命吸取、恢復、食物和被動\",\"Dungeon Stats 中所有已儲存的場次\",\"這裡所有完整場次，加上只看到部分的輪次（中途加入或漏掉某一波）：可用於平均值，但不會單獨保存為場次\",\"所有獲得的物品都已賣出、持有、掛單或保留。\",\"這裡的一切只儲存在此瀏覽器中。在下方取消勾選某欄即可在該表格中隱藏它；輪次表格的「來源」欄（來源與備註）預設關閉，此時帶有備註的輪次會在結果旁顯示一個小旗標。\",\"所有技能的每小時經驗；將滑鼠懸停在數值上查看各技能\",\"匯出原始訊息\",\"匯出紀錄（JSON）\",\"最快 {a}\",\"立即重新取得市場價格\",\"已完成的波次中，每隻怪物都見到降至 0 HP，且每點傷害都歸屬到某位玩家\",\"首次\",\"重新跟隨背包中的金幣\",\"食物\",\"食物 1\",\"食物 2\",\"食物 3\",\"食物和飲料\",\"從\",\"獲得\",\"遊戲：XP\",\"遊戲：次數\",\"遊戲：掉落\",\"一般\",\"普通攻擊的 HP 消耗\",\"{ability} 的 HP 消耗\",\"未核對通過的波次中，剩餘或未歸屬的 HP\",\"受到治療\",\"受到治療 {n}\",\"治療\",\"治療量\",\"持有\",\"持有（按買價）\",\"持有（按成本）\",\"持有掉落物 {a}（按買價）\",\"持有價值\",\"持有量 × 每代幣價值；結轉部分的價值列在下方，不計入\",\"隱藏\",\"在此隱藏統計面板；可在 Dungeon Stats 設定中恢復\",\"命中\",\"結轉\",\"匯入 Toolasha 歷史\",\"匯入紀錄檔…\",\"在地下城中\",\"紀錄開始前已在背包中\",\"紀錄開始前已在背包中；可從此處出售，但不計入持有掉落物或淨值\",\"物品\",\"為之後的輪次保留多少個 {item}？（目前 {n}；0 為清除）\",\"保留…\",\"保留\",\"鑰匙\",\"鑰匙和消耗品時間：低於此值顯示黃色\",\"鑰匙成本\",\"鑰匙製作\",\"鑰匙製作\",\"鑰匙製作，取自遊戲的掉落與經驗記錄\",\"鑰匙\",\"紀錄中的鑰匙\",\"鑰匙分頁\",\"需要的鑰匙\",\"類型\",\"放大\",\"最近\",\"按每次 {run} 計算，約可用 {time}\",\"帳本成本\",\"等級\",\"生命偷取\",\"累計\",\"累計分頁\",\"掛單中\",\"掉落物\",\"掉落物 = 本紀錄看到從寶箱或代幣兌換中得到的物品。持有 = 目前在背包中；掛單中 = 在你的賣單上。不再持有 = 獲得 − 賣出 − 開啟 − 持有 − 掛單 − 保留，按目前買價扣除 {a} 稅計價；自開啟以來買價變動超過 {b}（或沒有買價）的會標記為待審核，在接受之前不計入總計。接受後該價值會作為一筆紀錄事件固定下來。\",\"開啟時的掉落物\",\"不再持有的掉落物\",\"掉落物分頁\",\"待售掉落物\",\"法力\",\"回復法力 {n}\",\"法力吸取\",\"消耗法力 {n}\",\"材料\",\"材料\",\"在此電腦上購買的材料\",\"合併來自另一台電腦的市場歷史檔：Toolasha 的掛單陣列（JSON）或其市場歷史 CSV\",\"合併市場歷史檔…\",\"合併在另一台電腦上匯出的此角色紀錄：事件按 id 比對，重播的聊天和掛單成交也會比對，確保不重複計算\",\"傷害統計欄\",null,\"未命中\",\"缺少\",\"需要\",\"淨值\",\"最新的在前。* 計費的鑰匙讀取自隊伍鑰匙計數（未見到通關訊息）。† XP 從腳本加入該輪時開始計算。↰ 紀錄開始時該輪已在進行中。\",\"最新的在前。來源 = 該事件所來自的遊戲訊息。消耗品使用會被紀錄，但只顯示在「consume」下。\",\"最新的在前。按買價計值 = 開啟寶箱時每件物品的最高買價；地下城代幣的價值為其可兌換的商店物品中每代幣最佳買價（0.1.2 之前的開啟記錄，取最近一次有紀錄這些買價的開啟）；計數物品（牛鈴）和無價格物品不計價值。鑰匙成本 = 寶箱鑰匙所屬批次的成本；計價基準為賣價表示該鑰匙在紀錄開始前已持有。\",\"此頁面尚未看到戰鬥。\",\"記錄中尚無戰鬥場次：請開啟一次遊戲的掉落與經驗記錄。\",\"記錄中尚無鑰匙製作。\",\"不再持有 {a}\",\"此地下城尚無通關時間記錄\",\"尚無場次：請開啟一次遊戲的掉落與經驗記錄。\",\"尚無紀錄。\",\"沒有待審核項目。\",\"現在\",\"關閉：完全不讀取戰鬥訊息，不紀錄任何內容，統計面板與傷害分頁都會隱藏。適用於較慢的電腦。已儲存的場次會保留。\",\"離線 {a}\",\"有一輪正在進行中。\",\"開啟製作頁面\",\"在市場中開啟\",\"開啟一次遊戲的掉落與經驗記錄（Moo Pass），其場次就會顯示在這裡；Toolasha 儲存的歷史會在登入時合併。\",\"請在本次登入中開啟一次遊戲的掉落與經驗記錄（戰鬥 → 掉落與經驗記錄），以便紀錄將其通關與寶箱數與遊戲自身的計數核對。\",\"開啟次數\",\"開啟遊戲的購買視窗並填入 {n}\",\"其他\",\"其他（被動、生命偷取）\",\"其他（未識別）\",\"其他銷售 {a} 未計入\",\"其他 {a}\",\"持續傷害\",\"總覽\",\"自身行動（HP 消耗）\",\"已擁有\",\"格擋\",\"隊伍 DPS\",\"隊伍消耗品\",\"隊伍傷害\",\"隊伍飲料欄位 {n}\",\"隊伍入場鑰匙\",\"隊伍食物欄位 {n}\",\"每次通關\",\"每把鑰匙\",\"每秒\",\"戰鬥中每秒\",\"每代幣\",\"玩家\",\"升級所需價格\",\"依你自己的購買重新為紀錄開始時持有的庫存計價，並補上腳本未看到的成交\",\"收到\",\"配方\",\"紀錄傷害\",\"在明細功能之前紀錄（更新 0.2.1）\",\"已兌換\",\"重新整理價格\",\"恢復（每 10 秒）\",\"恢復、食物和被動\",\"重設\",\"重設卡片順序\",\"重設欄位順序\",\"重設傷害資料\",\"重設紀錄\",\"結果\",\"審核\",\"每輪用時\",\"輪次\",\"輪次分頁\",\"已儲存的輪次（從頭到尾看到），最新的在前\",\"已儲存的場次（從頭到尾看到），最新的在前\",\"縮放面板中的所有尺寸，範圍 {a} 到 {b}，每次 {c}。\",\"觀測來源\",\"場次\",\"場次\",\"遊戲掉落與經驗記錄中的場次\",\"設定\",\"佔比\",\"顯示\",\"在戰鬥卡片下方顯示統計面板（戰鬥 → 交戰）\",\"正在顯示本頁面上自隊伍進入戰鬥以來的所有輪次。點擊只顯示這一輪\",\"正在只顯示這一輪。點擊顯示自隊伍進入戰鬥以來的所有輪次\",\"紀錄以來\",\"自紀錄開始以來\",\"自 {date} 起。\",\"技能\",\"技能\",\"最慢 {a}\",\"縮小\",\"已賣出\",\"賣出淨額\",\"已賣出 {a}\",\"來源\",\"花費\",\"開始\",\"狀態\",\"摘要\",\"為之後輪次保留的補給\",\"承受\",\"文字大小\",\"無論如何，傷害分頁都會保留每個場次。\",\"只需此代幣購買的商店物品中，按買價扣稅後每代幣可換得的最高金幣（依網站規則）\",\"在訓練此技能至少一小時的場次中，該技能效率最高的地下城與難度\",\"遊戲自身的記錄（伺服器端，跨裝置完整），與 Toolasha 儲存的副本合併：{n} 個場次\",\"遊戲自身的記錄，每個行動場次一行：其次數（地下城通關或製作的鑰匙）、掉落與 XP，含離線。「本紀錄」計算本紀錄在同一時段內的通關與寶箱數；≠ 標示差異，場次結束後會醒目顯示。以遊戲的計數為準；本紀錄只補充記錄中沒有的時間與成本。\",\"本紀錄\",\"僅本紀錄：開啟掉落與經驗記錄以取得遊戲的計數\",\"這一輪\",\"荊棘反傷（反彈傷害）\",\"荊棘反傷與反擊\",\"這些書按市場賣價\",\"時間\",\"統計已計入的戰鬥時間\",\"場次時間\",\"場次時間為記錄中的開始到結束，因此 XP / h 是按行動進行的每小時計算，含離線。市場歷史按裝置分開，在此按掛單 id 合併此電腦的 Toolasha 儲存與資料分頁中合併的檔案（{n} 筆掛單）；每把鑰匙成本採用該歷史中的平均成交價（一個價格涵蓋在一台電腦上購買的任何份額），配方數量按你目前的工匠減免率計算，因為記錄中沒有每次製作的消耗；在兩台電腦的紀錄合併之前不顯示累計收入（匯入，里程碑 5）。\",\"次數\",\"此來源回復 HP 的次數\",\"此來源回復 MP 的次數\",\"使用次數。格擋、荊棘反傷和持續傷害不屬於施放\",\"今天\",\"代幣\",\"各地點總計（所有看到的輪次，完整或部分）\",\"未知地點\",\"使用背包金幣\",\"已使用\",\"按成本使用\",\"製作所用\",\"紀錄中已使用\",\"使用次數\",\"使用遊戲自身的導覽\",\"價值（扣稅後）\",\"按買價計值\",\"正在等待遊戲的技能總計。\",\"波次\",\"內容\",\"腳本無法確定的部分\",\"此玩家的治療技能和生命吸取回復的量\",\"地點\",\"{time} 前至今的每小時經驗\",\"自紀錄開始以來的 XP = 遊戲目前的累計總量減去紀錄開始時的總量，因此無論腳本是否在執行都準確，含離線遊玩。每小時 XP 按活躍時間計算：間隔不超過 15 分鐘的 XP 訊息之間的時間，加上獲得 XP 的離線時間。日期按你自己的時鐘。\",\"XP 分頁\",\"經驗/小時\",\"你的傷害\",\"你的佔比\",\"對比買一把鑰匙的 {ask}\",\"工匠 {pct}\",\"預算能買多少就買多少\",\"輪次之間\",\"購買可省 {n}\",\"已取消\",\"已核對 {b} 個已完成波次中的 {a} 個\",\"已通關\",\"已使用消耗品 {n}（按購入價 {cost}，近期事件）\",\"製作價格\",\"製作可省 {n}\",\"被截斷\",\"已結束\",\"提前結束\",\"已擁有足夠\",\"失敗\",\"正在取得…\",\"從 {date}\",\"小時\",\"進行中\",\"登入摘要 · 聊天帳本中 {a} 輪\",\"掉落記錄\",\"{time} 後升級\",\"未裝備工匠茶\",\"尚無紀錄\",\"已下單\",\"隊伍 {n}（{dps} DPS）\",\"已暫停\",\"價格更新於 {date}\",\"尚未取得價格\",\"價格：{error}\",\"自 {date} 起的紀錄\",\"低於此值顯示紅色\",\"目前已裝備\",\"重新載入後接續\",\"總計：{n} 輪完整\",\"總計：{n} 輪完整\",\"按買價計值 {a}（代幣 {b}）· 鑰匙 {c}\",\"按買價計值 {a} · 鑰匙 {b}\",\"等待登入\",\"第 {n} 波\",\"第 {a}–{b} 波\",\"已無動靜\",\"在 {budget} 的預算內\",\"{ability} 持續傷害\",\"{a} 已取消\",\"{a} 寶箱，{b} 精煉\",\"{a} 其中開出的寶箱\",null,\"{a} 已開啟的地下城寶箱，按買價\",\"{a} 失敗（{b}）\",\"{a} 物品\",\"{a} 精煉，{b} 寶箱\",\"{a} 稅（{b}）\",\"{a} 個技能\",\"{a} 個技能\",\"{a}（按製作價格）\",\"{a} 種消耗品和 {b} 種鑰匙材料按賣價計價，{c} 種鑰匙，{d} 種寶箱 · {e} 金幣\",\"{a}（含失敗）\",\"{a} 天\",\"{a} 天\",\"{a} 個地下城\",\"{a} 個地下城\",\"{a} 個事件\",\"{a} 個事件\",\"{a} 件物品\",\"{a} 件物品\",\"{a} 把鑰匙\",\"{a} 把鑰匙\",\"{a} 種材料\",\"{a} 種材料\",\"其中 {a} 為代幣，按商店每代幣最佳買價\",\"已紀錄 {b} 中的 {a}\",\"{a} 次開啟\",\"{a} 次開啟\",\"已兌換 {a}\",\"{a} 輪\",\"{a} 輪\",\"{a} 個場次\",\"{a} 個場次\",\"{a} 項技能\",\"{a} 項技能\",\"目前為止 {a}\",\"{a} 個來源\",\"{a} 個代幣\",\"{a} 個代幣\",\"已使用 {a}\",\"已使用 {a}（離線 {b}）· {c} 無價格\",\"{dmg} 傷害 · 佔隊伍 {share} · {dps} DPS · 承受 {taken} · 受到治療 {healed}\",\"{name} 有 {n} 把鑰匙\",\"{name} 的鑰匙已用完\",\"{name} 的 {item} 已用完\",\"{name} 的鑰匙將在 {time} 後用完\",\"{name} 的 {item} 將在 {time} 後用完\",\"{name} 的傷害\",\"{name} 的 {ability}\",\"{n} HP 無法解釋\",\"{n} HP 無法解釋。\",\"{n} 個技能\",\"{n} 個技能\",\"{n} 次製作\",\"{n} 次製作\",\"{n} 次死亡\",\"{n} 次死亡\",\"按購入價每個 {n}\",\"{n} 個事件\",\"自 {time} 起已完成 {n} 輪 + 這一輪\",\"自 {time} 起已完成 {n} 輪\",\"{n} 項待審核\",\"持有 {n}\",\"{n} 未歸屬\",\"{n} 未歸屬。\",\"其中 {n} 在買單中\",\"{n} 輪部分看到\",\"{n} 輪部分看到\",\"{n} 輪\",\"{n} 個來源\",\"{n} 個來源\",\"紀錄中已使用 {n}\",\"{n} 波\",\"{n} 把 {key} = {crafts}，購買需 {total}\",\"超出 {budget} 的預算 {over}\",\"{result}，正在結束\",\"戰鬥 {time}\",\"· 點擊查看詳情\",\"− 花費 {a}\"]",
    });
    // </locales>

    // ---------------------------------------------------------------------------------------------------------------
    // Start
    // ---------------------------------------------------------------------------------------------------------------
    hookConstructor(); hookPrototype(); hookMessageData();
    if (!refFromCache()) setTimeout(refFromCache, 5000);
    const boot = () => { panel.refresh(); };
    if (document.body) boot(); else document.addEventListener("DOMContentLoaded", boot, { once: true });
    // Diagnostics and the replay harness (test/index.html): feed() takes a frame as the game would send it.
    W.__mds = { state, ref, prices, version: VERSION, panel, toolasha: TOOLASHA, importToolasha, xp: { record: xpRec, summary: () => xpSummary(serverNow()), levelOf, toNextLevel }, importRecordData, meter: () => state.meter.snapshot(), damage: () => state.damage, money: () => deriveMoney(state.timeline, panel.moneyCtx()), derive: () => derive(state.timeline, serverNow(), { selfName: state.characterName, recordStart: state.meta.recordStart || 0, isChest: h => !!ref.chestItems[h], isKey: h => ref.keyItems.has(h), isCounted, keyOf: z => (ref.dungeons[z] && ref.dungeons[z].keyItem) || null, maxWavesOf: z => (ref.dungeons[z] && ref.dungeons[z].maxWaves) || null }), feed: f => onMessage(typeof f === "string" ? f : JSON.stringify(f)), feedOut: f => onOutgoing(typeof f === "string" ? f : JSON.stringify(f)), flush: () => state.record && state.record.flush(), status: () => ({ character: state.characterName, events: state.counts.events, frames: state.counts.frames, sockets: state.sockets, viaData: state.viaData, ref: ref.ready, run: state.run && { zone: state.run.zone, waves: state.run.waves }, record: state.record && state.record.stats() }) };
    info(`v${VERSION} loaded`);
})();
