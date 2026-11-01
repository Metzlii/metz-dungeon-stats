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
                if (!map["/items/cowbell"] && map["/items/bag_of_10_cowbells"]) { const b = map["/items/bag_of_10_cowbells"]; map["/items/cowbell"] = { a: b.a != null ? b.a / 10 : null, b: b.b != null ? b.b / 10 : null, via: "/items/bag_of_10_cowbells" }; }
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
        chatSeen: new Set(),            // "id:<chat id>" and "tm:<t>|<m>" of recorded party system messages (replay dedupe)
        timeline: [], timelineRev: 0,   // every non-consume event, oldest first: what derive() reads
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
        if (kind !== "consume") { state.timeline.push(ev); state.timelineRev++; }
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
        const run = { id: `${shortAction(zone)}:${startAt}`, zone, tier: num(tier), battleId, startAt, endAt: null, result: "open", waves: 0, maxWaves: d.maxWaves || null, party: party || [], keysUsed: null, chests: [], deaths: null, deathsAtStart: null, deathsTotal: null, xpBySkill: null, consumes: [], source: "live", clock: clock.known ? "local+offset" : "local", partial: !!partial, xpStart: xpSnapshot() };
        state.run = run; saveRun(run);
        emit("start", { runId: run.id, zone, tier: run.tier, battleId, party: run.party, partial: !!partial }, src, startAt);
        return run;
    }
    function closeRun(result, fields, src, at) {
        const run = state.run; if (!run) return null;
        run.endAt = at || serverNow(); run.result = result; Object.assign(run, fields || {});
        run.durationMs = run.endAt - run.startAt;
        run.xpBySkill = xpDelta(run.xpStart || {}, state.lifetimeXp);
        run.deaths = run.deathsTotal != null && run.deathsAtStart != null ? Math.max(0, run.deathsTotal - run.deathsAtStart) : null;
        delete run.xpStart;
        saveRun(run); state.run = null;
        emit(result, { runId: run.id, zone: run.zone, tier: run.tier, battleId: run.battleId, waves: run.waves, durationMs: run.durationMs, chests: run.chests, keysCharged: run.keysUsed, xpBySkill: run.xpBySkill, deaths: run.deaths, deathsTotal: run.deathsTotal, partial: run.partial }, src, run.endAt);
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
        if (run) { run.waves = Math.max(run.waves, wave); if (self) { const d = num(self.deathCount); if (run.deathsAtStart == null) run.deathsAtStart = d; run.deathsTotal = d; } if (prev && prev.battleId === battleId && wave > 1) saveRun(run); }
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
            const list = [...gains.values()].map(g => ({ ...g, bid: g.item === "/items/coin" ? 1 : bidOf(g.item), ask: g.item === "/items/coin" ? 1 : askOf(g.item) }));
            const coinsGained = list.filter(g => g.item === "/items/coin").reduce((s, g) => s + g.qty, 0);
            const valueBid = list.filter(g => g.item !== "/items/coin").reduce((s, g) => s + (g.bid ? g.bid * g.qty : 0), 0);
            const unpriced = list.filter(g => g.item !== "/items/coin" && !g.bid).map(g => g.item);
            emit("open", { chest, count, keyItem: key, zone: ref.chestItems[chest] ? ref.chestItems[chest].zone : null, gains: list, coinsGained, valueBid, unpriced, pricesAt: prices.at || null, keyCost: key ? keyLotTake(key, count) : null }, "loot_opened", at);
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
    function parseKeyCounts(meta) { const out = {}; let s = ""; try { s = typeof meta === "string" ? (JSON.parse(meta).keyCountString || "") : (meta && meta.keyCountString) || ""; } catch (_e) { s = String(meta || ""); } const re = /\[([^[\]-]+?)\s*-\s*([\d,]+)\]/g; let x; while ((x = re.exec(s))) out[x[1].trim()] = num(x[2].replace(/,/g, "")); return out; }
    function onChat(msg, replay) {
        const c = msg && msg.message; if (!isObj(c) || c.chan !== "/chat_channel_types/party" || !c.isSystemMessage) return;
        const at = parseServerTime(c.t) || serverNow();
        const m = String(c.m || "");
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
        if (!state.record || switched) await openRecord(id);
        applyRows(m.characterItems, true);
        for (const r of (Array.isArray(m.characterSkills) ? m.characterSkills : [])) if (isObj(r) && r.skillHrid && r.skillHrid !== "/skills/total_level") state.lifetimeXp[r.skillHrid] = num(r.experience);
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
        // lastOfflineTime is the logout; inactiveTime is the game's inactivity horizon (logout + 72 h), so the window
        // ends at the login or that horizon, whichever came first. A reconnect a few seconds long with no item change
        // is not an offline block (its XP is in the lifetime totals anyway).
        const from = parseServerTime(ch.lastOfflineTime), loginAt = serverTs || serverNow(), horizon = parseServerTime(ch.inactiveTime);
        const to = horizon && horizon < loginAt ? horizon : loginAt;
        if ((offItems && offItems.length) || (offSkills && offSkills.length && from && to - from >= 60000)) {
            emit("offline", { from, to, loginAt, horizon, items: offItems ? offItems.map(r => ({ item: r.itemHrid, level: num(r.enhancementLevel), delta: num(r.offlineCount), raw: r.count })) : [], xpBySkill: offSkills ? Object.fromEntries(offSkills.map(r => [r.skillHrid, num(r.offlineExperience)])) : {}, keys: Object.keys(m).filter(k => /offline/i.test(k)) }, "init_character_data");
        }
        // Party chat replay.
        const chat = m.partyChatHistory || (m.chatHistoryByChannelMap && m.chatHistoryByChannelMap["/chat_channel_types/party"]);
        if (Array.isArray(chat)) { const sorted = chat.slice().sort((a, b) => (parseServerTime(a.t) || 0) - (parseServerTime(b.t) || 0)); let n = 0; for (const c of sorted) { const before = state.counts.events; onChat({ message: c }, true); if (state.counts.events > before) n++; } if (n) info(`replayed ${n} party system messages from the login history`); }
        state.record.queue("meta", { key: "lastChatAt", value: state.lastChatAt });
        state.ready = true; panel.refresh();
    }

    function ledgerState() { return { ledger: [...state.ledger.entries()], keyLots: [...state.keyLots.entries()], keyAverages: [...keyAverages.entries()], listings: [...state.listings.values()], lifetimeXp: state.lifetimeXp }; }
    function restoreLedger(v) { if (!isObj(v)) return; state.ledger = new Map(v.ledger || []); state.keyLots = new Map(v.keyLots || []); for (const [k, e] of (v.keyAverages || [])) keyAverages.set(k, e); if (Array.isArray(v.listings)) for (const l of v.listings) state.listings.set(l.id, l); }

    const TIMELINE_KINDS = ["start", "clear", "fail", "stop", "craft", "buy", "sell", "open", "redeem", "baseline", "offline", "chat", "review", "value", "note"];
    async function openRecord(id) {
        try {
            const db = await openDb(id);
            state.record = createRecord(db);
            const metaRows = await state.record.getAll("meta");
            state.meta = {}; for (const r of metaRows) state.meta[r.key] = r.value !== undefined ? r.value : r;
            if (state.meta.ledger) restoreLedger(state.meta.ledger);
            state.lastChatAt = num(state.meta.lastChatAt);
            state.chatSeen = new Set(Array.isArray(state.meta.chatSeen) ? state.meta.chatSeen : []);
            state.events = (await state.record.getAll("events", "at", null, "prev", 200));
            const perKind = await Promise.all(TIMELINE_KINDS.map(k => state.record.getAll("events", "kind", IDBKeyRange.only(k))));
            state.timeline = perKind.flat().sort((a, b) => a.at - b.at); state.timelineRev++;
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
                case "open": for (const g of (e.gains || [])) if (C.isKey(g.item)) keyMoves.push({ t: e.at, item: g.item, delta: n(g.qty) }); break;
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
            const run = { zone, startAt: s.t, endAt: null, durationMs: null, result: null, waves: null, chests: null, keysCharged: null, keysSrc: null, deaths: null, xpBySkill: null, xpPartial: !liveStart || !!liveStart.partial, battleId: liveStart ? liveStart.battleId : (liveEnd ? liveEnd.battleId : null), source: liveEnd ? "chat+live" : "chat", keysBefore: s.keys, keysAfter: null, clearAt: null, note: null };
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
                if (liveEnd.waves != null) run.waves = liveEnd.waves;
                run.chests = Array.isArray(liveEnd.chests) ? liveEnd.chests : null; run.deaths = deathsOf.get(liveEnd.id) ?? null; run.xpBySkill = liveEnd.xpBySkill || null; run.keyCost = liveEnd.keyCost || null;
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
            runs.push({ zone: ls.zone, startAt: ls.at, endAt: le ? le.at : null, durationMs: le ? le.at - ls.at : null, result, waves: le ? le.waves : null, chests: le && Array.isArray(le.chests) ? le.chests : null, keysCharged: le && le.keysCharged != null ? n(le.keysCharged) : null, keysSrc: le && le.keysCharged != null ? "clear message" : null, deaths: le ? deathsOf.get(le.id) ?? null : null, xpBySkill: le ? le.xpBySkill || null : null, xpPartial: !!ls.partial, battleId: ls.battleId, source: "live", partial: !!ls.partial, clearAt: le && le.kind === "clear" ? le.at : null, note: ls.partial ? "seen from a join, start time is the join" : null });
        }
        for (const le of liveEnds) {
            if (usedLive.has(le.id) || inside(le.at, 5e3)) continue; usedLive.add(le.id);
            const startAt = le.at - (n(le.durationMs) || 0);
            runs.push({ zone: le.zone, startAt, endAt: le.at, durationMs: n(le.durationMs) || null, result: le.kind === "stop" ? "cancelled" : le.kind, waves: le.waves, chests: Array.isArray(le.chests) ? le.chests : null, keysCharged: le.keysCharged != null ? n(le.keysCharged) : null, keysSrc: le.keysCharged != null ? "clear message" : null, deaths: deathsOf.get(le.id) ?? null, xpBySkill: le.xpBySkill || null, xpPartial: true, battleId: le.battleId, source: "live", clearAt: le.kind === "clear" ? le.at : null, note: "end seen without its start" });
        }
        runs.sort((a, b) => a.startAt - b.startAt);
        // The record window. Runs that began before it count only if they were still going when it began.
        const windowStart = C.recordStart || (runs.length ? runs[0].startAt : nowMs), windowEnd = nowMs;
        const kept = runs.filter(r => r.startAt >= windowStart || (r.endAt == null ? r.result === "open" : r.endAt > windowStart));
        for (const r of kept) if (r.startAt < windowStart) r.spansRecordStart = true;
        const clip = (a, b) => [Math.max(a, windowStart), Math.min(b, windowEnd)];
        const merge = ivs => { const s = ivs.filter(iv => iv[1] > iv[0]).sort((x, y) => x[0] - y[0]); const out = []; for (const iv of s) { const last = out[out.length - 1]; if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]); else out.push([iv[0], iv[1]]); } return out; };
        const sum = ivs => ivs.reduce((s, iv) => s + (iv[1] - iv[0]), 0);
        const complement = (ivs, a, b) => { const out = []; let cur = a; for (const iv of ivs) { if (iv[0] > cur) out.push([cur, Math.min(iv[0], b)]); cur = Math.max(cur, iv[1]); if (cur >= b) break; } if (cur < b) out.push([cur, b]); return out.filter(iv => iv[1] > iv[0]); };
        const intersect = (A, B) => { const out = []; for (const a of A) for (const b of B) { const x = Math.max(a[0], b[0]), y = Math.min(a[1], b[1]); if (y > x) out.push([x, y]); } return merge(out); };
        const dungeonIv = [], unknownIv = [];
        for (const r of kept) { if (r.result === "unknown") unknownIv.push(clip(r.startAt, r.gapTo || nowMs)); else dungeonIv.push(clip(r.startAt, r.endAt == null ? nowMs : r.endAt)); }
        const dungeonMerged = merge(dungeonIv), unknownOnly = intersect(merge(unknownIv), complement(dungeonMerged, windowStart, windowEnd));
        const between = complement(merge([...dungeonMerged, ...unknownOnly]), windowStart, windowEnd);
        const offlineIv = merge(offline.map(o => clip(o.from, o.to)));
        const bursts = []; for (const c of crafts) { const last = bursts[bursts.length - 1]; if (last && c.at - last.last <= C.craftBurstMs) { last.last = c.at; last.n++; } else bursts.push({ first: c.at, last: c.at, n: 1 }); }
        const craftIv = merge(bursts.map(b => { const per = b.n > 1 ? (b.last - b.first) / (b.n - 1) : 10e3; return clip(b.first - per, b.last); }));
        const craftingBetween = intersect(between, craftIv), offlineBetween = intersect(between, offlineIv);
        const S = { windowStart, windowEnd, totalMs: windowEnd - windowStart, clears: 0, fails: 0, cancelled: 0, open: 0, unknown: 0, chests: {}, chestTotal: 0, keysCharged: 0, deaths: 0, clearMs: [], runMs: [], dungeonMs: sum(dungeonMerged), unknownMs: sum(unknownOnly), betweenMs: sum(between), craftingMs: sum(craftingBetween), offlineBetweenMs: sum(offlineBetween), offlineMs: sum(offlineIv), crafts: crafts.length, keysCrafted: crafts.reduce((s, c) => s + (c.outputs || []).reduce((a, o) => a + n(o.qty), 0), 0) };
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
        const blocks = offline.map(o => { const b = { from: o.from, to: o.to, ms: o.to - o.from, chests: {}, chestTotal: 0, keys: {}, xp: o.xp, runsInLedger: kept.filter(r => r.startAt >= o.from && r.startAt <= o.to).length }; for (const it of o.items) { if (C.isChest(it.item)) { b.chests[it.item] = (b.chests[it.item] || 0) + n(it.delta); b.chestTotal += n(it.delta); } else if (C.isKey(it.item)) b.keys[it.item] = (b.keys[it.item] || 0) + n(it.delta); } return b; }).filter(b => b.ms >= C.offlineMinMs);
        return { runs: kept, summary: S, offline: blocks, markers: markers.length };
    }
    // </derive>

    // ---------------------------------------------------------------------------------------------------------------
    // Panel: Overview, Runs, Data. Floating, toggled by a small button; docking into the game's tab strip comes later.
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
#mds-root .mds-pane[hidden]{display:none}
#mds-root p.mds-note{color:#b9a9d6;font-size:11px;margin:8px 0 0}
#mds-root tr.cancelled td.k,#mds-root tr.offline td{color:#b9a9d6}
#mds-root tr.offline td{font-style:italic}
#mds-root tr.open td.k{color:#ffcf7a}
#mds-root details{margin:6px 0}
#mds-root summary{cursor:pointer;color:#cdbfe8}
#mds-root pre{white-space:pre-wrap;word-break:break-word;background:rgba(0,0,0,.25);padding:6px;border-radius:6px;max-height:200px;overflow:auto;font-size:11px}
`;

    const panel = (() => {
        let root = null, toggle = null, dirty = false, timer = null, filter = "all", open = false, tab = "overview", rowsHeld = false, runsHeld = false;
        const els = {};
        let derived = null, derivedAt = 0, derivedRev = -1;
        const KINDS = ["all", "start", "clear", "fail", "stop", "craft", "buy", "sell", "open", "consume", "redeem", "chat", "offline", "baseline", "review"];
        const TABS = [["overview", "Overview"], ["runs", "Runs"], ["data", "Data"]];
        const deriveCfg = () => ({ selfName: state.characterName, recordStart: state.meta.recordStart || 0, isChest: h => !!ref.chestItems[h], isKey: h => ref.keyItems.has(h), keyOf: z => (ref.dungeons[z] && ref.dungeons[z].keyItem) || null });
        function getDerived() {
            if (!derived || derivedRev !== state.timelineRev || Date.now() - derivedAt > 30000) { derived = derive(state.timeline, serverNow(), deriveCfg()); derivedAt = Date.now(); derivedRev = state.timelineRev; }
            return derived;
        }
        function ensure() {
            if (root || !document.body) return;
            const style = document.createElement("style"); style.textContent = CSS; document.documentElement.appendChild(style);
            toggle = document.createElement("button"); toggle.id = "mds-toggle"; toggle.textContent = "Dungeon Stats"; toggle.title = "Metz Dungeon Stats"; toggle.addEventListener("click", () => setOpen(!open));
            root = document.createElement("section"); root.id = "mds-root"; root.hidden = true;
            // Built once. Refreshes touch only text and table rows, so an open dropdown, the scroll position and an
            // expanded section are never torn down.
            root.innerHTML = `<div class="mds-head"><strong>Metz Dungeon Stats</strong><span class="mds-sub">v${VERSION}</span><button class="mds-x" title="Close">×</button></div>
<div class="mds-tabs">${TABS.map(([k, label]) => `<button role="tab" data-tab="${k}" aria-selected="${k === tab}">${label}</button>`).join("")}</div>
<div class="mds-body">
<p class="mds-status" id="mds-status"></p>
<div class="mds-pane" data-pane="overview">
 <div class="mds-cards" id="mds-cards"></div>
 <p class="mds-note" id="mds-ovnote"></p>
</div>
<div class="mds-pane" data-pane="runs" hidden>
 <div class="mds-wrap mds-wrap-runs"><table><thead><tr><th>Start</th><th>Result</th><th>Run time</th><th>Waves</th><th>Chests</th><th>Keys</th><th>Deaths</th><th>XP</th><th>Seen by</th></tr></thead><tbody id="mds-runs"></tbody></table></div>
 <p class="mds-note" id="mds-runsnote"></p>
</div>
<div class="mds-pane" data-pane="data" hidden>
<div class="mds-bar">
 <label>Show <select id="mds-filter">${KINDS.map(k => `<option value="${k}">${k}</option>`).join("")}</select></label>
 <button id="mds-export">Export record (JSON)</button>
 <button id="mds-export-frames">Export raw frames</button>
 <button id="mds-prices">Refresh prices</button>
 <button id="mds-reset" class="danger">Reset record</button>
 <span class="mds-note">Newest first. Source = the game message the event came from. Consumable uses are recorded but shown only under "consume".</span>
</div>
<div class="mds-wrap"><table><thead><tr><th>Time</th><th>Kind</th><th>What</th><th>Source</th></tr></thead><tbody id="mds-tbody"></tbody></table></div>
<details><summary>Diagnostics</summary><pre id="mds-diag"></pre></details>
</div>
</div>`;
            for (const id of ["mds-status", "mds-cards", "mds-ovnote", "mds-runs", "mds-runsnote", "mds-tbody", "mds-diag", "mds-filter"]) els[id] = root.querySelector("#" + id);
            els.wrap = root.querySelector(".mds-pane[data-pane=data] .mds-wrap"); els.runsWrap = root.querySelector(".mds-wrap-runs");
            root.querySelector(".mds-x").addEventListener("click", () => setOpen(false));
            root.querySelector(".mds-tabs").addEventListener("click", e => { const b = e.target.closest("button[data-tab]"); if (b) setTab(b.dataset.tab); });
            els["mds-filter"].addEventListener("change", e => { filter = e.target.value; els.wrap.scrollTop = 0; renderRows(true); });
            root.querySelector("#mds-export").addEventListener("click", exportRecord);
            root.querySelector("#mds-export-frames").addEventListener("click", exportFrames);
            root.querySelector("#mds-prices").addEventListener("click", () => fetchPrices(true).then(() => render()));
            root.querySelector("#mds-reset").addEventListener("click", resetRecord);
            // Rows are held while the reader is scrolled down; they catch up at the top.
            els.wrap.addEventListener("scroll", () => { if (rowsHeld && els.wrap.scrollTop <= 8) renderRows(true); }, { passive: true });
            els.runsWrap.addEventListener("scroll", () => { if (runsHeld && els.runsWrap.scrollTop <= 8) renderRuns(true); }, { passive: true });
            document.body.appendChild(toggle); document.body.appendChild(root);
            try { open = localStorage.getItem(PANEL_KEY) === "open"; tab = localStorage.getItem(PANEL_KEY + "-tab") || tab; } catch (_e) { open = false; }
            setTab(tab, true);
            root.hidden = !open; if (open) render();
        }
        function setTab(k, silent) {
            if (!TABS.some(t => t[0] === k)) k = "overview";
            tab = k;
            for (const b of root.querySelectorAll(".mds-tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === k));
            for (const p of root.querySelectorAll(".mds-pane")) p.hidden = p.dataset.pane !== k;
            try { localStorage.setItem(PANEL_KEY + "-tab", k); } catch (_e) { /* fine */ }
            if (!silent) render();
        }
        function setOpen(v) { open = v; if (root) root.hidden = !v; try { localStorage.setItem(PANEL_KEY, v ? "open" : "closed"); } catch (_e) { /* fine */ } if (v) render(); }
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
                case "buy": return `${ev.qty}× ${it(ev.item)} ${ev.unitPrice != null ? `@ ${fmtCoins(ev.unitPrice)} = ${fmtCoins(ev.coins)}` : "price unresolved"}${ev.instant ? " · instant" : ""}`;
                case "sell": return `${ev.qty}× ${it(ev.item)} ${ev.unitPrice != null ? `@ ${fmtCoins(ev.unitPrice)}` : ""} · net ${fmtCoins(ev.net)}${ev.tax != null ? ` (tax ${fmtCoins(ev.tax)})` : ""}${ev.instant ? " · instant" : ""}`;
                case "open": return `${ev.count}× ${it(ev.chest)} → ${(ev.gains || []).map(g => `${g.qty} ${it(g.item)}`).join(", ")} · value at bid ${fmtCoins(ev.valueBid)}${ev.coinsGained ? ` + ${fmtCoins(ev.coinsGained)} coins` : ""}${ev.unpriced && ev.unpriced.length ? ` · unpriced: ${ev.unpriced.map(it).join(", ")}` : ""}`;
                case "consume": return `${ev.qty}× ${it(ev.item)}${ev.unitCost != null ? ` @ ${fmtCoins(ev.unitCost)}` : ` (purchase price known for ${ev.covered || 0} of ${ev.qty})`}`;
                case "redeem": return `${ev.qty}× ${it(ev.token)} → ${ev.itemQty}× ${it(ev.item)}`;
                case "baseline": return `${(ev.items || []).filter(i => i.kind !== "key material").length} consumables and ${(ev.items || []).filter(i => i.kind === "key material").length} key materials priced at ask, ${(ev.keys || []).length} key types, ${(ev.chests || []).length} chest types · ${fmtCoins(ev.coins)} coins`;
                case "offline": { const to = Math.min(ev.to || ev.at, ev.at); return `${fmtDur(to - (ev.from || 0))} offline (${fmtTime(ev.from)} to ${fmtTime(to)}) · ${(ev.items || []).length} item deltas · XP ${fmtCoins(xpSum(ev.xpBySkill))}`; }
                case "chat": return `${esc(ev.m)}${ev.keyCounts ? " · " + esc(Object.entries(ev.keyCounts).map(([n, k]) => `${n} ${k}`).join(", ")) : ""}${ev.replay ? " · replayed" : ""}`;
                case "review": return `${esc(ev.reason)}`;
                default: return esc(JSON.stringify(ev).slice(0, 200));
            }
        }
        function renderRows(force) {
            if (!els["mds-tbody"]) return;
            if (!force && els.wrap.scrollTop > 8) { rowsHeld = true; return; }
            rowsHeld = false;
            // The default feed leaves consumable uses out: they are kept for cost tracking, not for reading.
            const rows = state.events.filter(e => filter === "all" ? e.kind !== "consume" : e.kind === filter).slice(0, 200);
            els["mds-tbody"].innerHTML = rows.map(ev => `<tr class="${ev.kind}"><td class="t">${fmtTime(ev.at)}</td><td class="k">${ev.kind}</td><td class="d">${describe(ev)}</td><td class="t">${esc(ev.src || "")}</td></tr>`).join("") || `<tr><td colspan="4" class="t">Nothing recorded yet.</td></tr>`;
        }
        function card(label, value, sub) { return `<div class="mds-card"><div class="l">${label}</div><div class="n">${value}</div>${sub ? `<small>${sub}</small>` : ""}</div>`; }
        function renderOverview() {
            const d = getDerived(), S = d.summary;
            const offChests = d.offline.reduce((s, b) => s + b.chestTotal, 0);
            const chestLines = Object.entries(S.chests).map(([h, q]) => `${q} ${it(h)}`).join(" · ");
            const cards = [
                card("Clears", S.clears, `${S.fails} failed${S.failRate != null ? ` (${(S.failRate * 100).toFixed(1)}%)` : ""} · ${S.cancelled} cancelled${S.unknown ? ` · ${S.unknown} end unknown` : ""}`),
                card("Average run", S.avgClearMs != null ? fmtDur(S.avgClearMs) : "–", S.clearMs.length ? `${S.avgRunMs != null && S.fails ? `${fmtDur(S.avgRunMs)} counting fails · ` : ""}fastest ${fmtDur(S.fastestMs)} · slowest ${fmtDur(S.slowestMs)}` : "no completed run yet"),
                card("Chests", S.chestTotal + offChests, `${chestLines || "none yet"}${offChests ? ` · ${offChests} of them while offline` : ""}`),
                card("Keys charged", S.keysCharged, `${S.keysCrafted} crafted in the record`),
                card("In dungeons", fmtHm(S.dungeonMs), `${pct(S.dungeonMs, S.totalMs)} of ${fmtHm(S.totalMs)} recorded`),
                card("Between runs", fmtHm(S.betweenMs), `crafting ${fmtHm(S.craftingMs)} · offline ${fmtHm(S.offlineBetweenMs)} · other ${fmtHm(S.otherMs)}`),
            ];
            if (S.unknownMs > 0) cards.push(card("Unaccounted", fmtHm(S.unknownMs), "runs whose end the chat ledger does not show"));
            els["mds-cards"].innerHTML = cards.join("");
            els["mds-ovnote"].textContent = `Since ${fmtTime(S.windowStart)}. A run lasts from one party key-count message to the next, the way Toolasha counts it; cancelled runs are left out of the average. Runs while you were offline come from the party chat, their chests from the login summary.${S.open ? " One run is in progress." : ""}`;
        }
        function renderRuns(force) {
            if (!els["mds-runs"]) return;
            if (!force && els.runsWrap.scrollTop > 8) { runsHeld = true; return; }
            runsHeld = false;
            const d = getDerived(); const now = serverNow();
            const items = [...d.runs.map(r => ({ t: r.startAt, run: r })), ...d.offline.map(b => ({ t: b.to, block: b }))].sort((a, b) => b.t - a.t).slice(0, 300);
            const chestText = r => (r.chests ? (r.chests.length ? r.chests.map(c => `${c.qty} ${it(c.item)}`).join(", ") : "none") : "–");
            els["mds-runs"].innerHTML = items.map(x => {
                if (x.block) { const b = x.block; return `<tr class="offline"><td class="t">${fmtTime(b.from)}</td><td class="k">offline</td><td>${fmtDur(b.ms)}</td><td>–</td><td>${b.chestTotal ? Object.entries(b.chests).map(([h, q]) => `${q} ${it(h)}`).join(", ") : "none"}</td><td>${Object.values(b.keys).reduce((s, v) => s + -v, 0) || "–"}</td><td>–</td><td>${fmtCoins(xpSum(b.xp))}</td><td class="t">login summary · ${b.runsInLedger} runs in the chat ledger</td></tr>`; }
                const r = x.run;
                const dur = r.result === "open" ? `${fmtDur(now - r.startAt)} so far` : (r.durationMs != null ? fmtDur(r.durationMs) : "–");
                const result = r.result === "open" ? "in progress" : r.result;
                return `<tr class="${r.result}"><td class="t">${fmtTime(r.startAt)}${r.spansRecordStart ? " ↰" : ""}</td><td class="k">${result}</td><td>${dur}</td><td>${r.waves ?? "–"}</td><td>${chestText(r)}</td><td>${r.keysCharged ?? "–"}${r.keysSrc === "key count" ? "*" : ""}</td><td>${r.deaths ?? "–"}</td><td>${r.xpBySkill ? fmtCoins(xpSum(r.xpBySkill)) + (r.xpPartial ? "†" : "") : "–"}</td><td class="t">${r.source}${r.note ? ` · ${esc(r.note)}` : ""}</td></tr>`;
            }).join("") || `<tr><td colspan="9" class="t">No runs yet.</td></tr>`;
            els["mds-runsnote"].textContent = "Newest first. * keys charged read from the party key counts (no clear message seen). † XP counted from when the script joined the run. ↰ the run was under way when the record started.";
        }
        function render() {
            ensure(); if (!root) return;
            const used = state.events.filter(e => e.kind === "consume").reduce((s, e) => { s.n += e.qty; s.cost += e.unitCost != null ? e.unitCost * e.qty : 0; return s; }, { n: 0, cost: 0 });
            const runLine = state.run ? `${shortAction(state.run.zone)} T${state.run.tier} · wave ${state.run.waves} · ${fmtDur(serverNow() - state.run.startAt)}` : "between runs";
            els["mds-status"].textContent = `${state.characterName || "waiting for login"}${state.meta.recordStart ? ` · record since ${fmtTime(state.meta.recordStart)}` : " · no record yet"} · ${state.counts.events} events${state.reviews ? ` · ${state.reviews} for review` : ""} · ${runLine}${used.n ? ` · consumables used ${used.n} (${fmtCoins(used.cost)} at purchase price, recent events)` : ""}`;
            if (tab === "overview") renderOverview();
            else if (tab === "runs") renderRuns(false);
            else {
                renderRows(false);
                const byType = [...state.counts.byType.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(" · ");
                els["mds-diag"].textContent = [
                    `frames heard ${state.counts.frames} · ${state.sockets} socket${state.sockets === 1 ? "" : "s"}${state.viaData ? ` · ${state.viaData} via data getter` : ""}`,
                    `game data: ${ref.ready ? Object.keys(ref.dungeons).length + " dungeons" : "not loaded"} · ${ref.source || "waiting"}${ref.version ? " · " + ref.version : ""}`,
                    `prices: ${prices.map ? Object.keys(prices.map).length : 0} items · ${prices.at ? "fetched " + fmtTime(prices.at) : "not fetched this session"}${prices.error ? " · " + prices.error : ""}`,
                    `record: ${state.record ? JSON.stringify(state.record.stats()) : "none"} · timeline ${state.timeline.length} events · device ${DEVICE} · v${VERSION}`,
                    `held keys and chests: ${[...state.inventory.values()].filter(r => r.itemLocationHrid === INV && (ref.keyItems.has(r.itemHrid) || ref.chestItems[r.itemHrid])).map(r => `${r.count}× ${itemName(r.itemHrid)}`).join(", ") || "none"}`,
                    `messages this session: ${byType || "none yet"}`,
                ].join("\n");
            }
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
        state.meta = {}; state.events = []; state.timeline = []; state.timelineRev++; state.chatSeen.clear(); state.counts.events = 0; state.ledger.clear(); state.keyLots.clear(); keyAverages.clear(); state.run = null;
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
    W.__mds = { state, ref, prices, version: VERSION, derive: () => derive(state.timeline, serverNow(), { selfName: state.characterName, recordStart: state.meta.recordStart || 0, isChest: h => !!ref.chestItems[h], isKey: h => ref.keyItems.has(h), keyOf: z => (ref.dungeons[z] && ref.dungeons[z].keyItem) || null }), feed: f => onMessage(typeof f === "string" ? f : JSON.stringify(f)), feedOut: f => onOutgoing(typeof f === "string" ? f : JSON.stringify(f)), flush: () => state.record && state.record.flush(), status: () => ({ character: state.characterName, events: state.counts.events, frames: state.counts.frames, sockets: state.sockets, viaData: state.viaData, ref: ref.ready, run: state.run && { zone: state.run.zone, waves: state.run.waves }, record: state.record && state.record.stats() }) };
    info(`v${VERSION} loaded`);
})();
