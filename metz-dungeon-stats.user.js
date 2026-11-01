// ==UserScript==
// @name         Metz Dungeon Stats
// @namespace    metzlii
// @version      0.1.0
// @description  One permanent record of your XP, your dungeon runs and the dungeon cash flow: keys crafted, consumables used, chests opened, loot sold. Tracked from the game's own messages, nothing estimated.
// @author       Metzli
// @license      MIT
// @homepageURL  https://github.com/Metzlii/metz-dungeon-stats
// @supportURL   https://github.com/Metzlii/metz-dungeon-stats/issues
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
 * Milestone 1: capture and record.
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

    const VERSION = "0.1.0";
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
    const fmtTime = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
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
    const ref = { ready: false, dungeons: {}, keyActions: {}, keyItems: new Set(), chestItems: {}, items: {}, version: null, source: null };

    function buildRef(data) {
        if (!isObj(data) || !isObj(data.actionDetailMap) || !isObj(data.itemDetailMap)) return false;
        ref.dungeons = {}; ref.keyActions = {}; ref.keyItems = new Set(); ref.chestItems = {}; ref.items = {};
        for (const [hrid, item] of Object.entries(data.itemDetailMap)) {
            ref.items[hrid] = { name: item.name, category: item.categoryHrid, openable: !!item.isOpenable, openKey: item.openKeyItemHrid || null, tradable: item.isTradable !== false && !(item.isOpenable && item.openKeyItemHrid === undefined && false), sellPrice: num(item.sellPrice) };
            if (item.categoryHrid === "/item_categories/dungeon_key") ref.keyItems.add(hrid);
        }
        for (const [hrid, action] of Object.entries(data.actionDetailMap)) {
            const zone = action.combatZoneInfo;
            if (zone && zone.isDungeon && zone.dungeonInfo) {
                const d = zone.dungeonInfo;
                const chests = (d.rewardDropTable || []).map(r => r.itemHrid).filter(Boolean);
                ref.dungeons[hrid] = { name: action.name, maxWaves: num(d.maxWaves), keyItem: d.keyItemHrid || null, chests };
                for (const c of chests) ref.chestItems[c] = { zone: hrid, key: ref.items[c] ? ref.items[c].openKey : null };
            }
            if (action.category === "/action_categories/crafting/dungeon_keys") {
                ref.keyActions[hrid] = { name: action.name, inputs: (action.inputItems || []).map(i => ({ item: i.itemHrid, qty: num(i.count) })), outputs: (action.outputItems || []).map(i => ({ item: i.itemHrid, qty: num(i.count) })) };
            }
        }
        for (const [hrid, item] of Object.entries(data.itemDetailMap)) if (item.isOpenable && item.openKeyItemHrid && !ref.chestItems[hrid]) ref.chestItems[hrid] = { zone: null, key: item.openKeyItemHrid };
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

    const itemName = hrid => (ref.items[hrid] && ref.items[hrid].name) || shortItem(hrid);
    const isConsumable = hrid => { const c = ref.items[hrid] && ref.items[hrid].category; return c === "/item_categories/food" || c === "/item_categories/drink"; };
    const isLootItem = hrid => hrid && hrid !== "/items/coin" && !ref.keyItems.has(hrid) && !ref.chestItems[hrid];

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
        listings: new Map(),            // listing id -> {filledQuantity, taxTaken, unclaimedCoinCount, unclaimedItemCount, isSell, itemHrid, price, status}
        pendingOrders: [],              // outgoing post_market_order frames waiting for their inventory rows
        battleItems: new Set(),         // consumables slotted in the current battle (self)
        run: null,                      // live run in progress
        chatRun: null,                  // run opened by the party chat ledger
        lastBattle: null,               // {battleId, wave}
        lastChatAt: 0,
        ledger: new Map(),              // itemHrid -> {qty, cost} running purchase ledger (average cost)
        keyLots: new Map(),             // keyItem -> [{qty, unitCost, basis, craftId}]
        counts: { frames: 0, byType: new Map(), events: 0 },
        frameCounts: new Map(),         // type -> retained count
        reviews: 0,
        events: [],                     // recent events for the panel (newest first, capped)
        sockets: 0, viaData: 0,
    };

    // ---------------------------------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------------------------------
    const listeners = new Set();
    function emit(kind, fields, src, at, clockKind) {
        const ev = { id: newId(), kind, at: at || serverNow(), clock: clockKind || (at ? "server" : (clock.known ? "local+offset" : "local")), src: src || null, v: 1, ...fields };
        if (state.record) state.record.queue("events", ev);
        state.counts.events++;
        state.events.unshift(ev); if (state.events.length > 400) state.events.length = 400;
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
            state.lifetimeXp[r.skillHrid] = xp;
        }
        return deltas;
    }
    const xpSnapshot = () => ({ ...state.lifetimeXp });
    function xpDelta(from, to) { const out = {}; for (const [k, v] of Object.entries(to)) { const d = v - (from[k] || 0); if (d > 0) out[k] = Math.round(d * 10) / 10; } return out; }

    // ---------------------------------------------------------------------------------------------------------------
    // Runs (live)
    // ---------------------------------------------------------------------------------------------------------------
    function saveRun(run) { if (state.record) state.record.queue("runs", clone(run)); }
    function openRun(zone, tier, battleId, startAt, party, partial, src) {
        const d = ref.dungeons[zone] || {};
        const run = { id: `${shortAction(zone)}:${startAt}`, zone, tier: num(tier), battleId, startAt, endAt: null, result: "open", waves: 0, maxWaves: d.maxWaves || null, party: party || [], keysUsed: null, chests: [], deaths: 0, xpBySkill: null, consumes: [], source: "live", clock: clock.known ? "local+offset" : "local", partial: !!partial, xpStart: xpSnapshot() };
        state.run = run; saveRun(run);
        emit("start", { runId: run.id, zone, tier: run.tier, battleId, party: run.party, partial: !!partial }, src, startAt);
        return run;
    }
    function closeRun(result, fields, src, at) {
        const run = state.run; if (!run) return null;
        run.endAt = at || serverNow(); run.result = result; Object.assign(run, fields || {});
        run.durationMs = run.endAt - run.startAt;
        run.xpBySkill = xpDelta(run.xpStart || {}, state.lifetimeXp);
        delete run.xpStart;
        saveRun(run); state.run = null;
        emit(result, { runId: run.id, zone: run.zone, tier: run.tier, battleId: run.battleId, waves: run.waves, durationMs: run.durationMs, chests: run.chests, keysCharged: run.keysUsed, xpBySkill: run.xpBySkill, deaths: run.deaths, partial: run.partial }, src, run.endAt);
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
        if (run) { run.waves = Math.max(run.waves, wave); if (self) run.deaths = num(self.deathCount); if (prev && prev.battleId === battleId && wave > 1) saveRun(run); }
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
                state.run.waves = Math.max(state.run.waves, wave);
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
        // 1. Outgoing instant orders waiting for their rows.
        state.pendingOrders = state.pendingOrders.filter(o => now - o.at < 15000);
        const coinDiff = diffs.find(x => x.item === "/items/coin");
        for (const order of state.pendingOrders.slice()) {
            const row = diffs.find(x => x.item === order.item && x.level === order.level && (order.isSell ? x.delta < 0 : x.delta > 0));
            if (!row) continue;
            const qty = Math.abs(row.delta);
            if (!order.isSell) {
                if (coinDiff && coinDiff.delta < 0 && diffs.filter(x => x.delta > 0 && x.item !== "/items/coin").length === 1) {
                    const total = -coinDiff.delta; const unit = total / qty;
                    emit("buy", { item: order.item, level: order.level, qty, unitPrice: unit, coins: total, instant: true }, src);
                    ledgerAdd(order.item, qty, unit); if (ref.keyItems.has(order.item)) keyLotAdd(order.item, qty, unit, "bought", null);
                } else {
                    emit("buy", { item: order.item, level: order.level, qty, unitPrice: null, coins: null, instant: true, unresolved: true }, src);
                    review("instant buy: could not pair the coin change with this item alone", { item: order.item, qty, diffs }, src);
                }
            } else {
                if (coinDiff && coinDiff.delta > 0 && diffs.filter(x => x.delta < 0 && x.item !== "/items/coin").length === 1) emit("sell", { item: order.item, level: order.level, qty, unitPrice: coinDiff.delta / qty, gross: null, tax: null, net: coinDiff.delta, instant: true }, src);
                else { emit("sell", { item: order.item, level: order.level, qty, unitPrice: null, gross: null, tax: null, net: null, instant: true, unresolved: true }, src); review("instant sell: could not pair the coin change with this item alone", { item: order.item, qty, diffs }, src); }
            }
            state.pendingOrders = state.pendingOrders.filter(o => o !== order);
            return; // the message belonged to the order
        }
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
            if (next.isSell) {
                const gross = dFill * next.price; const tax = next.taxTaken - (prev ? prev.taxTaken : 0);
                emit("sell", { listingId: next.id, item: next.itemHrid, level: next.level, qty: dFill, unitPrice: next.price, gross, tax: tax >= 0 ? tax : null, net: tax >= 0 ? gross - tax : null, instant: false }, "market_listings_updated", at);
            } else {
                const total = dFill * next.price;
                emit("buy", { listingId: next.id, item: next.itemHrid, level: next.level, qty: dFill, unitPrice: next.price, coins: total, instant: false }, "market_listings_updated", at);
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
            const list = [...gains.values()].map(g => ({ ...g, bid: g.item === "/items/coin" ? 1 : bidOf(g.item), ask: g.item === "/items/coin" ? 1 : askOf(g.item) }));
            const coinsGained = list.filter(g => g.item === "/items/coin").reduce((s, g) => s + g.qty, 0);
            const valueBid = list.filter(g => g.item !== "/items/coin").reduce((s, g) => s + (g.bid ? g.bid * g.qty : 0), 0);
            const unpriced = list.filter(g => g.item !== "/items/coin" && !g.bid).map(g => g.item);
            emit("open", { chest, count, keyItem: key, zone: ref.chestItems[chest] ? ref.chestItems[chest].zone : null, gains: list, coinsGained, valueBid, unpriced, pricesAt: prices.at || null, keyCost: key ? keyLotTake(key, count) : null }, "loot_opened", at);
        };
        fetchPrices(false).then(finish, finish);
        const diffs = applyRows(m.endCharacterItems, false); if (diffs.length) onInventoryDiffs(diffs, "loot_opened", m);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Party chat ledger (provisional model until the first capture settles the message order)
    // ---------------------------------------------------------------------------------------------------------------
    function parseKeyCounts(meta) { const out = {}; let s = ""; try { s = typeof meta === "string" ? (JSON.parse(meta).keyCountString || "") : (meta && meta.keyCountString) || ""; } catch (_e) { s = String(meta || ""); } const re = /\[([^[\]-]+?)\s*-\s*([\d,]+)\]/g; let x; while ((x = re.exec(s))) out[x[1].trim()] = num(x[2].replace(/,/g, "")); return out; }
    function onChat(msg, replay) {
        const c = msg && msg.message; if (!isObj(c) || c.chan !== "/chat_channel_types/party" || !c.isSystemMessage) return;
        const at = parseServerTime(c.t) || serverNow();
        if (at <= state.lastChatAt && replay) return;
        state.lastChatAt = Math.max(state.lastChatAt, at);
        const m = String(c.m || "");
        const fields = { m, at, keyCounts: /partyKeyCount/.test(m) ? parseKeyCounts(c.systemMetadata) : undefined, meta: c.systemMetadata, replay: !!replay };
        emit("chat", fields, "chat_message_received", at);
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
        if (!state.record || switched) await openRecord(id);
        applyRows(m.characterItems, true);
        for (const r of (Array.isArray(m.characterSkills) ? m.characterSkills : [])) if (isObj(r) && r.skillHrid) state.lifetimeXp[r.skillHrid] = num(r.experience);
        applyActions(m.characterActions);
        seedListings(m.myMarketListings);
        retainFrame("init_character_data", m, "in");
        // Record start and baseline, once.
        if (!state.meta.recordStart) {
            state.meta.recordStart = serverNow(); state.record.queue("meta", { key: "recordStart", value: state.meta.recordStart });
            await fetchPrices(true);
            const items = [], keys = [], chests = [];
            for (const r of state.inventory.values()) {
                if (r.itemLocationHrid !== INV || r.enhancementLevel !== 0) continue;
                if (isConsumable(r.itemHrid) || isKeyMaterial(r.itemHrid)) { const a = askOf(r.itemHrid); items.push({ item: r.itemHrid, qty: r.count, unitCost: a, basis: "ask-at-start", kind: isConsumable(r.itemHrid) ? "consumable" : "key material" }); if (a != null) ledgerAdd(r.itemHrid, r.count, a); }
                else if (ref.keyItems.has(r.itemHrid)) { const a = askOf(r.itemHrid); keys.push({ item: r.itemHrid, qty: r.count, unitCost: a, basis: "ask-at-start" }); keyLotAdd(r.itemHrid, r.count, a == null ? 0 : a, a == null ? "unknown" : "ask", null); if (!ref.keyActions[r.itemHrid] && a != null) ledgerAdd(r.itemHrid, r.count, a); }
                else if (ref.chestItems[r.itemHrid]) chests.push({ item: r.itemHrid, qty: r.count });
            }
            emit("baseline", { items, keys, chests, coins: coins(), pricesAt: prices.at || null, priceError: prices.error }, "init_character_data");
            state.record.queue("meta", { key: "ledger", value: ledgerState() });
        }
        // Offline summary.
        const offItems = Array.isArray(m.offlineItems) ? m.offlineItems : null, offSkills = Array.isArray(m.offlineSkills) ? m.offlineSkills : null;
        if ((offItems && offItems.length) || (offSkills && offSkills.length)) {
            const from = parseServerTime(ch.lastOfflineTime), to = parseServerTime(ch.inactiveTime) || serverTs;
            emit("offline", { from, to, items: offItems ? offItems.map(r => ({ item: r.itemHrid, level: num(r.enhancementLevel), delta: num(r.offlineCount), raw: r.count })) : [], xpBySkill: offSkills ? Object.fromEntries(offSkills.map(r => [r.skillHrid, num(r.offlineExperience)])) : {}, keys: Object.keys(m).filter(k => /offline/i.test(k)) }, "init_character_data");
        }
        // Party chat replay.
        const chat = m.partyChatHistory || (m.chatHistoryByChannelMap && m.chatHistoryByChannelMap["/chat_channel_types/party"]);
        if (Array.isArray(chat)) { const sorted = chat.slice().sort((a, b) => (parseServerTime(a.t) || 0) - (parseServerTime(b.t) || 0)); let n = 0; for (const c of sorted) { const before = state.counts.events; onChat({ message: c }, true); if (state.counts.events > before) n++; } if (n) info(`replayed ${n} party system messages from the login history`); }
        state.record.queue("meta", { key: "lastChatAt", value: state.lastChatAt });
        state.ready = true; panel.refresh();
    }

    function ledgerState() { return { ledger: [...state.ledger.entries()], keyLots: [...state.keyLots.entries()], keyAverages: [...keyAverages.entries()], listings: [...state.listings.values()], lifetimeXp: state.lifetimeXp }; }
    function restoreLedger(v) { if (!isObj(v)) return; state.ledger = new Map(v.ledger || []); state.keyLots = new Map(v.keyLots || []); for (const [k, e] of (v.keyAverages || [])) keyAverages.set(k, e); if (Array.isArray(v.listings)) for (const l of v.listings) state.listings.set(l.id, l); }

    async function openRecord(id) {
        try {
            const db = await openDb(id);
            state.record = createRecord(db);
            const metaRows = await state.record.getAll("meta");
            state.meta = {}; for (const r of metaRows) state.meta[r.key] = r.value !== undefined ? r.value : r;
            if (state.meta.ledger) restoreLedger(state.meta.ledger);
            state.lastChatAt = num(state.meta.lastChatAt);
            state.events = (await state.record.getAll("events", "at", null, "prev", 200));
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
            switch (type) {
                case "new_battle": onNewBattle(m); break;
                case "action_completed": onActionCompleted(m); break;
                case "actions_updated": applyActions(m.endCharacterActions); if (state.run && !currentDungeonZone()) closeRun("stop", { reason: "dungeon action removed from the queue" }, "actions_updated"); break;
                case "items_updated": { const diffs = applyRows(m.endCharacterItems, false); if (diffs.length) onInventoryDiffs(diffs, "items_updated", m); break; }
                case "skills_updated": { const d = applySkills(m.endCharacterSkills); if (Object.keys(d).length) noteSkillingXp(d, null, serverNow()); break; }
                case "loot_opened": onLootOpened(m); break;
                case "market_listings_updated": onListings(m); break;
                case "chat_message_received": onChat(m, false); break;
                case "battle_consumable_ability_updated": break; // retained as a frame; the consume event comes from the inventory row
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
    // Panel (milestone 1: Data only). Floating, toggled by a small button; the game-tab docking comes with the views.
    // ---------------------------------------------------------------------------------------------------------------
    const CSS = `
#mds-toggle{position:fixed;left:10px;bottom:10px;z-index:2147483000;background:rgba(20,16,31,.92);color:#e6ddf5;border:1px solid rgba(190,160,255,.35);border-radius:9px;padding:5px 9px;font:600 11px/1.2 system-ui,sans-serif;letter-spacing:.3px;cursor:pointer;backdrop-filter:blur(6px)}
#mds-toggle:hover{border-color:rgba(190,160,255,.7)}
#mds-root{position:fixed;left:10px;bottom:40px;z-index:2147483000;width:min(760px,calc(100vw - 20px));max-height:min(70vh,640px);display:flex;flex-direction:column;background:rgba(15,12,25,.94);color:#e6ddf5;border:1px solid rgba(190,160,255,.3);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.5);font:12px/1.35 system-ui,sans-serif;backdrop-filter:blur(7px)}
#mds-root[hidden]{display:none}
#mds-root *{box-sizing:border-box}
#mds-root .mds-head{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid rgba(190,160,255,.18)}
#mds-root .mds-head strong{font-size:13px;letter-spacing:.2px}
#mds-root .mds-head .mds-sub{color:#b9a9d6;font-size:11px}
#mds-root .mds-head .mds-x{margin-left:auto;background:none;border:0;color:#b9a9d6;font-size:16px;cursor:pointer}
#mds-root .mds-tabs{display:flex;gap:4px;padding:6px 10px 0}
#mds-root .mds-tabs button{background:rgba(44,33,64,.6);border:1px solid rgba(190,160,255,.18);border-bottom:0;color:#cdbfe8;border-radius:8px 8px 0 0;padding:5px 10px;cursor:pointer;font:inherit}
#mds-root .mds-tabs button[aria-selected="true"]{background:rgba(70,52,104,.85);color:#fff}
#mds-root .mds-body{overflow:auto;padding:10px 12px 12px;border-top:1px solid rgba(190,160,255,.18)}
#mds-root .mds-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:10px}
#mds-root .mds-card{background:linear-gradient(140deg,rgba(44,33,64,.94),rgba(29,23,44,.91));border:1px solid rgba(190,160,255,.18);border-radius:10px;padding:8px 10px}
#mds-root .mds-card .l{font-size:9px;letter-spacing:.75px;text-transform:uppercase;color:#c0acd9}
#mds-root .mds-card .n{font-size:17px;font-weight:650;font-variant-numeric:tabular-nums;margin-top:2px}
#mds-root .mds-card small{display:block;color:#b9a9d6;font-size:10px;margin-top:2px}
#mds-root .mds-status{margin:0 0 8px;color:#d9cff0}
#mds-root .mds-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 8px}
#mds-root .mds-bar button,#mds-root .mds-bar select,#mds-root .mds-bar label{background:rgba(44,33,64,.8);border:1px solid rgba(190,160,255,.25);color:#e6ddf5;border-radius:7px;padding:4px 8px;font:inherit;cursor:pointer}
#mds-root .mds-bar button.danger{border-color:rgba(255,120,120,.5);color:#ffb3b3}
#mds-root .mds-bar .mds-note{color:#b9a9d6;font-size:11px}
#mds-root table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
#mds-root th,#mds-root td{text-align:left;padding:4px 6px;border-bottom:1px solid rgba(190,160,255,.12);vertical-align:top}
#mds-root th{position:sticky;top:0;background:rgba(25,20,38,.98);font-size:10px;letter-spacing:.5px;text-transform:uppercase;color:#c0acd9}
#mds-root td.k{white-space:nowrap;font-weight:600}
#mds-root td.t{white-space:nowrap;color:#b9a9d6}
#mds-root td.d{color:#d9cff0;word-break:break-word}
#mds-root tr.review td.k{color:#ffcf7a}
#mds-root tr.clear td.k{color:#9be3a4}
#mds-root tr.fail td.k,#mds-root tr.stop td.k{color:#ff9f9f}
#mds-root .mds-wrap{max-height:360px;overflow:auto;border:1px solid rgba(190,160,255,.15);border-radius:9px}
#mds-root details{margin:6px 0}
#mds-root summary{cursor:pointer;color:#cdbfe8}
#mds-root pre{white-space:pre-wrap;word-break:break-word;background:rgba(0,0,0,.25);padding:6px;border-radius:6px;max-height:200px;overflow:auto;font-size:11px}
`;

    const panel = (() => {
        let root = null, body = null, toggle = null, dirty = false, timer = null, filter = "all", open = false, hover = false;
        function ensure() {
            if (root || !document.body) return;
            const style = document.createElement("style"); style.textContent = CSS; document.documentElement.appendChild(style);
            toggle = document.createElement("button"); toggle.id = "mds-toggle"; toggle.textContent = "Dungeon Stats"; toggle.title = "Metz Dungeon Stats"; toggle.addEventListener("click", () => setOpen(!open));
            root = document.createElement("section"); root.id = "mds-root"; root.hidden = true;
            root.innerHTML = `<div class="mds-head"><strong>Metz Dungeon Stats</strong><span class="mds-sub">v${VERSION} · milestone 1: capture and record</span><button class="mds-x" title="Close">×</button></div><div class="mds-tabs"><button role="tab" aria-selected="true">Data</button></div><div class="mds-body"></div>`;
            root.querySelector(".mds-x").addEventListener("click", () => setOpen(false));
            // The panel never rebuilds under the pointer or a focused control (an open dropdown would be torn down).
            root.addEventListener("mouseenter", () => { hover = true; });
            root.addEventListener("mouseleave", () => { hover = false; if (deferred) render(); });
            root.addEventListener("focusout", () => { setTimeout(() => { if (deferred && !hover && !root.contains(document.activeElement)) render(); }, 0); });
            body = root.querySelector(".mds-body");
            document.body.appendChild(toggle); document.body.appendChild(root);
            try { open = localStorage.getItem(PANEL_KEY) === "open"; } catch (_e) { open = false; }
            root.hidden = !open; if (open) render();
        }
        function setOpen(v) { open = v; if (root) root.hidden = !v; try { localStorage.setItem(PANEL_KEY, v ? "open" : "closed"); } catch (_e) { /* fine */ } if (v) render(); }
        function touch() { dirty = true; if (!timer) timer = setTimeout(() => { timer = null; if (dirty && open) render(); dirty = false; }, 1000); }
        function refresh() { ensure(); touch(); }
        const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
        function describe(ev) {
            const it = h => esc(itemName(h));
            switch (ev.kind) {
                case "start": return `${esc(shortAction(ev.zone))} T${ev.tier} battle ${ev.battleId}${ev.partial ? " (joined mid-run)" : ""} · party ${esc((ev.party || []).join(", "))}`;
                case "clear": return `${esc(shortAction(ev.zone))} T${ev.tier} cleared in ${fmtDur(ev.durationMs)} · ${ev.waves} waves · chests ${(ev.chests || []).map(c => `${c.qty}× ${it(c.item)}`).join(", ") || "none in message"} · keys charged ${ev.keysCharged ?? "?"} · XP ${fmtCoins(Object.values(ev.xpBySkill || {}).reduce((s, v) => s + v, 0))}`;
                case "fail": return `${esc(shortAction(ev.zone))} T${ev.tier} failed on wave ${ev.waves} after ${fmtDur(ev.durationMs)}`;
                case "stop": return `${esc(shortAction(ev.zone))} stopped at wave ${ev.waves ?? ev.waveReached ?? "?"} · ${esc(ev.reason || "")}`;
                case "craft": return `${esc(shortAction(ev.action))} ×${(ev.outputs || []).reduce((s, o) => s + o.qty, 0)} · ${(ev.inputs || []).map(i => `${i.qty} ${it(i.item)}${i.unitCost != null ? ` @${fmtCoins(i.unitCost)}` : " @?"}`).join(", ")}${ev.coins ? ` + ${fmtCoins(ev.coins)} coins` : ""} · ${ev.unitCost != null ? `${fmtCoins(ev.unitCost)} per key` : "cost unknown"}`;
                case "buy": return `${ev.qty}× ${it(ev.item)} ${ev.unitPrice != null ? `@ ${fmtCoins(ev.unitPrice)} = ${fmtCoins(ev.coins)}` : "price unresolved"}${ev.instant ? " · instant" : ""}`;
                case "sell": return `${ev.qty}× ${it(ev.item)} ${ev.unitPrice != null ? `@ ${fmtCoins(ev.unitPrice)}` : ""} · net ${fmtCoins(ev.net)}${ev.tax != null ? ` (tax ${fmtCoins(ev.tax)})` : ""}${ev.instant ? " · instant" : ""}`;
                case "open": return `${ev.count}× ${it(ev.chest)} → ${(ev.gains || []).map(g => `${g.qty} ${it(g.item)}`).join(", ")} · value at bid ${fmtCoins(ev.valueBid)}${ev.coinsGained ? ` + ${fmtCoins(ev.coinsGained)} coins` : ""}${ev.unpriced && ev.unpriced.length ? ` · unpriced: ${ev.unpriced.map(it).join(", ")}` : ""}`;
                case "consume": return `${ev.qty}× ${it(ev.item)}${ev.unitCost != null ? ` @ ${fmtCoins(ev.unitCost)}` : ` (purchase price known for ${ev.covered || 0} of ${ev.qty})`}`;
                case "redeem": return `${ev.qty}× ${it(ev.token)} → ${ev.itemQty}× ${it(ev.item)}`;
                case "baseline": return `${(ev.items || []).filter(i => i.kind !== "key material").length} consumables and ${(ev.items || []).filter(i => i.kind === "key material").length} key materials priced at ask, ${(ev.keys || []).length} key types, ${(ev.chests || []).length} chest types · ${fmtCoins(ev.coins)} coins`;
                case "offline": return `${fmtDur((ev.to || 0) - (ev.from || 0))} away · ${(ev.items || []).length} item deltas · XP ${fmtCoins(Object.values(ev.xpBySkill || {}).reduce((s, v) => s + v, 0))}`;
                case "chat": return `${esc(ev.m)}${ev.keyCounts ? " · " + esc(Object.entries(ev.keyCounts).map(([n, k]) => `${n} ${k}`).join(", ")) : ""}${ev.replay ? " · replayed" : ""}`;
                case "review": return `${esc(ev.reason)}`;
                default: return esc(JSON.stringify(ev).slice(0, 200));
            }
        }
        let deferred = false;
        function render() {
            ensure(); if (!body) return;
            // Never rebuild the feed under a reader: while the list is scrolled down, hold the refresh until they
            // return to the top (new events arrive at the top anyway).
            const wrapBefore = body.querySelector(".mds-wrap");
            const busy = (wrapBefore && wrapBefore.scrollTop > 8) || hover || (root && root.contains(document.activeElement) && document.activeElement !== root);
            if (busy && body.childElementCount) { deferred = true; return; }
            deferred = false;
            const kinds = ["all", "start", "clear", "fail", "stop", "craft", "buy", "sell", "open", "consume", "redeem", "chat", "offline", "baseline", "review"];
            // The default feed leaves consumable uses out: they are kept for cost tracking, not for reading.
            const rows = state.events.filter(e => filter === "all" ? e.kind !== "consume" : e.kind === filter).slice(0, 200);
            const used = state.events.filter(e => e.kind === "consume").reduce((s, e) => { s.n += e.qty; s.cost += e.unitCost != null ? e.unitCost * e.qty : 0; return s; }, { n: 0, cost: 0 });
            const byType = [...state.counts.byType.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(" · ");
            const runLine = state.run ? `${esc(shortAction(state.run.zone))} T${state.run.tier} · wave ${state.run.waves} · ${fmtDur(serverNow() - state.run.startAt)}` : "between runs";
            body.innerHTML = `
<p class="mds-status"><strong>${esc(state.characterName || "waiting for login")}</strong>${state.meta.recordStart ? ` · record since ${fmtTime(state.meta.recordStart)}` : " · no record yet"} · ${state.counts.events} events${state.reviews ? ` · ${state.reviews} for review` : ""} · ${runLine}${used.n ? ` · consumables used ${used.n} (${fmtCoins(used.cost)} at purchase price, recent events)` : ""}</p>
<div class="mds-bar">
 <label>Show <select id="mds-filter">${kinds.map(k => `<option value="${k}"${k === filter ? " selected" : ""}>${k}</option>`).join("")}</select></label>
 <button id="mds-export">Export record (JSON)</button>
 <button id="mds-export-frames">Export raw frames</button>
 <button id="mds-prices">Refresh prices</button>
 <button id="mds-reset" class="danger">Reset record</button>
 <span class="mds-note">Newest first. Source = the game message the event came from. Consumable uses are recorded but shown only under "consume".</span>
</div>
<div class="mds-wrap"><table><thead><tr><th>Time</th><th>Kind</th><th>What</th><th>Source</th></tr></thead><tbody>
${rows.map(ev => `<tr class="${ev.kind}"><td class="t">${fmtTime(ev.at)}</td><td class="k">${ev.kind}</td><td class="d">${describe(ev)}</td><td class="t">${esc(ev.src || "")}</td></tr>`).join("") || `<tr><td colspan="4" class="t">Nothing recorded yet.</td></tr>`}
</tbody></table></div>
<details><summary>Diagnostics</summary><pre>${esc([
                `frames heard ${state.counts.frames} · ${state.sockets} socket${state.sockets === 1 ? "" : "s"}${state.viaData ? ` · ${state.viaData} via data getter` : ""}`,
                `game data: ${ref.ready ? Object.keys(ref.dungeons).length + " dungeons" : "not loaded"} · ${ref.source || "waiting"}${ref.version ? " · " + ref.version : ""}`,
                `prices: ${prices.map ? Object.keys(prices.map).length : 0} items · ${prices.at ? "fetched " + fmtTime(prices.at) : "not fetched this session"}${prices.error ? " · " + prices.error : ""}`,
                `record: ${state.record ? JSON.stringify(state.record.stats()) : "none"} · device ${DEVICE} · v${VERSION}`,
                `held keys and chests: ${[...state.inventory.values()].filter(r => r.itemLocationHrid === INV && (ref.keyItems.has(r.itemHrid) || ref.chestItems[r.itemHrid])).map(r => `${r.count}× ${itemName(r.itemHrid)}`).join(", ") || "none"}`,
                `messages this session: ${byType || "none yet"}`,
            ].join("\n"))}</pre></details>`;
            body.querySelector("#mds-filter").addEventListener("change", e => { filter = e.target.value; const w = body.querySelector(".mds-wrap"); if (w) w.scrollTop = 0; render(); });
            body.querySelector(".mds-wrap").addEventListener("scroll", e => { if (deferred && e.target.scrollTop <= 8) render(); }, { passive: true });
            body.querySelector("#mds-export").addEventListener("click", exportRecord);
            body.querySelector("#mds-export-frames").addEventListener("click", exportFrames);
            body.querySelector("#mds-prices").addEventListener("click", () => fetchPrices(true).then(() => render()));
            body.querySelector("#mds-reset").addEventListener("click", resetRecord);
        }
        return { refresh, touch, render };
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
    async function resetRecord() {
        if (!state.record) return;
        if (!W.confirm("Delete this character's whole Dungeon Stats record? Export it first if you want to keep it.")) return;
        await state.record.flush(); await state.record.clearAll();
        state.meta = {}; state.events = []; state.counts.events = 0; state.ledger.clear(); state.keyLots.clear(); keyAverages.clear(); state.run = null;
        panel.render();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Start
    // ---------------------------------------------------------------------------------------------------------------
    hookConstructor(); hookPrototype(); hookMessageData();
    if (!refFromCache()) setTimeout(refFromCache, 5000);
    const boot = () => { panel.refresh(); };
    if (document.body) boot(); else document.addEventListener("DOMContentLoaded", boot, { once: true });
    // Diagnostics and the replay harness (test/index.html): feed() takes a frame as the game would send it.
    W.__mds = { state, ref, prices, version: VERSION, feed: f => onMessage(typeof f === "string" ? f : JSON.stringify(f)), feedOut: f => onOutgoing(typeof f === "string" ? f : JSON.stringify(f)), flush: () => state.record && state.record.flush(), status: () => ({ character: state.characterName, events: state.counts.events, frames: state.counts.frames, sockets: state.sockets, viaData: state.viaData, ref: ref.ready, run: state.run && { zone: state.run.zone, waves: state.run.waves }, record: state.record && state.record.stats() }) };
    info(`v${VERSION} loaded`);
})();
