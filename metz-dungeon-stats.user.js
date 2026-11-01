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
    const ref = { ready: false, dungeons: {}, keyActions: {}, keyItems: new Set(), realKeys: new Set(), dungeonLoot: new Set(), chestItems: {}, items: {}, version: null, source: null };

    function buildRef(data) {
        if (!isObj(data) || !isObj(data.actionDetailMap) || !isObj(data.itemDetailMap)) return false;
        ref.dungeons = {}; ref.keyActions = {}; ref.keyItems = new Set(); ref.realKeys = new Set(); ref.dungeonLoot = new Set(); ref.chestItems = {}; ref.items = {};
        for (const [hrid, item] of Object.entries(data.itemDetailMap)) {
            ref.items[hrid] = { name: item.name, category: item.categoryHrid, openable: !!item.isOpenable, openKey: item.openKeyItemHrid || null, tradable: item.isTradable !== false && !(item.isOpenable && item.openKeyItemHrid === undefined && false), sellPrice: num(item.sellPrice) };
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
    };

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
        if (kind !== "consume") { state.timeline.push(ev); state.timelineRev++; } else addConsume(ev);
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
            return { unitCost: cost / out.qty, basis: `recipe-at-start${art ? ` artisan ${(art.rate * 100).toFixed(1)}%` : ""}${asks ? ` (${asks} at ask)` : ""}` };
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
        // A run the script joined at its very end (restarted mid-run, no battle seen) has no XP to report, not zero.
        run.xpBySkill = run.partial && !run.battles ? null : xpDelta(run.xpStart || {}, state.lifetimeXp);
        run.noBattleSeen = !run.battles;
        run.deaths = run.deathsTotal != null && run.deathsAtStart != null ? Math.max(0, run.deathsTotal - run.deathsAtStart) : null;
        delete run.xpStart;
        saveRun(run); state.run = null;
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
            const list = [...gains.values()].map(g => isCounted(g.item) ? { ...g, bid: null, ask: null, counted: true } : { ...g, bid: g.item === "/items/coin" ? 1 : bidOf(g.item), ask: g.item === "/items/coin" ? 1 : askOf(g.item) });
            const coinsGained = list.filter(g => g.item === "/items/coin").reduce((s, g) => s + g.qty, 0);
            const valueBid = list.filter(g => g.item !== "/items/coin" && !g.counted).reduce((s, g) => s + (g.bid ? g.bid * g.qty : 0), 0);
            const unpriced = list.filter(g => g.item !== "/items/coin" && !g.counted && !g.bid).map(g => g.item);
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
        noteBuffs(m);
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
            emit("offline", { from, to, loginAt, horizon, items: offRows, xpBySkill: offSkills ? Object.fromEntries(offSkills.map(r => [r.skillHrid, num(r.offlineExperience)])) : {}, keys: Object.keys(m).filter(k => /offline/i.test(k)) }, "init_character_data");
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
    function taxRateNow() { for (let i = state.timeline.length - 1; i >= 0; i--) { const e = state.timeline[i]; if (e.kind === "sell" && !e.imported && num(e.gross) > 0 && e.tax != null) return e.tax / e.gross; } return 0.04; }
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
            const rate = taxRateNow(); let imported = 0;
            for (const l of listings) {
                if (l.at < start) continue;
                const missing = l.qty - (seen.get(l.id) || 0); if (missing <= 0) continue;
                if (l.isSell) { const gross = missing * l.price; const tax = Math.round(gross * rate); emit("sell", { listingId: l.id, item: l.item, level: l.level, qty: missing, unitPrice: l.price, gross, tax, net: gross - tax, taxBasis: "rate", imported: true, instant: false }, "toolasha", l.at); }
                else { emit("buy", { listingId: l.id, item: l.item, level: l.level, qty: missing, unitPrice: l.price, coins: missing * l.price, imported: true, instant: false }, "toolasha", l.at); if (l.level === 0) { ledgerAdd(l.item, missing, l.price); if (ref.keyItems.has(l.item)) keyLotAdd(l.item, missing, l.price, "bought", null); } }
                imported++;
            }
            TOOLASHA.imported += imported;
            // 3. Toolasha's copy of the Loot & XP Log (the game only sends the current window when the panel opens).
            const history = await readToolashaStore("lootLogHistory", `lootLog_${state.characterId}`);
            if (Array.isArray(history)) { const n = mergeLootLog(history, "toolasha"); TOOLASHA.sessions = history.length; if (n) emit("note", { text: `Toolasha loot log history: ${history.length} sessions, ${n} new or updated` }, "toolasha"); }
            if (imported) { state.timeline.sort((a, b) => a.at - b.at); state.timelineRev++; }
            info(`toolasha history (${reason}): ${listings.length} listings, ${TOOLASHA.seeded} items seeded, ${imported} fills imported`);
            panel.touch();
        })().catch(error => { warn("toolasha import failed", error); TOOLASHA.status = "failed: " + String(error && error.message || error); }).finally(() => { toolashaRunning = null; });
        return toolashaRunning;
    }
    async function openRecord(id) {
        try {
            const db = await openDb(id);
            state.record = createRecord(db);
            const metaRows = await state.record.getAll("meta");
            state.meta = {}; for (const r of metaRows) state.meta[r.key] = r.value !== undefined ? r.value : r;
            if (state.meta.ledger) restoreLedger(state.meta.ledger);
            if (isObj(state.meta.artisan)) state.artisan = state.meta.artisan;
            state.marketHistory = new Map(); for (const l of (Array.isArray(state.meta.marketHistory) ? state.meta.marketHistory : [])) if (l && l.id != null) state.marketHistory.set(l.id, l);
            state.lootLog = new Map(); for (const e of (Array.isArray(state.meta.lootLog) ? state.meta.lootLog : [])) if (e && e.id != null) { e.source = [...new Set(String(e.source || "").split("+").filter(Boolean))].join("+"); state.lootLog.set(e.id, e); } state.lootLogRev++;
            state.lastChatAt = num(state.meta.lastChatAt);
            state.chatSeen = new Set(Array.isArray(state.meta.chatSeen) ? state.meta.chatSeen : []);
            state.events = (await state.record.getAll("events", "at", null, "prev", 200));
            const perKind = await Promise.all(TIMELINE_KINDS.map(k => state.record.getAll("events", "kind", IDBKeyRange.only(k))));
            state.timeline = perKind.flat().sort((a, b) => a.at - b.at); state.timelineRev++;
            state.consumeTotals = new Map(); for (const c of await state.record.getAll("events", "kind", IDBKeyRange.only("consume"))) addConsume(c);
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
                case "loot_log_updated": onLootLog(m); break;
                case "consumable_buffs_updated": case "action_type_consumable_slots_updated": noteBuffs(m); break;
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
        const dungeonMerged = merge(dungeonIv), unknownOnly = intersect(merge(unknownIv), complement(dungeonMerged, windowStart, windowEnd));
        const between = complement(merge([...dungeonMerged, ...unknownOnly]), windowStart, windowEnd);
        const offlineIv = merge(offline.map(o => clip(o.from, o.to)));
        const bursts = []; for (const c of crafts) { const last = bursts[bursts.length - 1]; if (last && c.at - last.last <= C.craftBurstMs) { last.last = c.at; last.n++; } else bursts.push({ first: c.at, last: c.at, n: 1 }); }
        const craftIv = merge(bursts.map(b => { const per = b.n > 1 ? (b.last - b.first) / (b.n - 1) : 10e3; return clip(b.first - per, b.last); }));
        const craftingBetween = intersect(between, craftIv), offlineBetween = intersect(between, offlineIv);
        const S = { windowStart, windowEnd, totalMs: windowEnd - windowStart, clears: 0, fails: 0, cancelled: 0, open: 0, unknown: 0, chests: {}, chestTotal: 0, keysCharged: 0, deaths: 0, clearMs: [], runMs: [], dungeonMs: sum(dungeonMerged), unknownMs: sum(unknownOnly), betweenMs: sum(between), craftingMs: sum(craftingBetween), offlineBetweenMs: sum(offlineBetween), offlineMs: sum(offlineIv), crafts: crafts.length, keysCrafted: crafts.reduce((s, c) => s + (c.outputs || []).reduce((a, o) => a + n(o.qty), 0), 0), counted: {} };
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
    // </derive>

    // ---------------------------------------------------------------------------------------------------------------
    // Money: spent, loot value at open, sold, net, and the per-item rows behind them. A pure function of the recorded
    // events plus what the bag holds now, so test/money.test.mjs can run it over an exported record.
    // ---------------------------------------------------------------------------------------------------------------
    // <money>
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
        // Tax: the rate the game charged on the latest recorded sale, 4% until one has been recorded.
        const taxed = sells.filter(s => n(s.gross) > 0 && s.tax != null && !s.imported).sort((a, b) => b.at - a.at);
        const tax = { rate: taxed.length ? n(taxed[0].tax) / n(taxed[0].gross) : 0.04, measured: taxed.length };
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
            }
            cb.value += v;
        }
        // A container that came out of a chest and was opened later (Large Treasure Chest) is worth its contents, not its
        // own bid as well: whatever bid it carried when gained comes off the total once it is opened.
        let revalued = 0;
        for (const [chest, cb] of Object.entries(chestBy)) { const gi = gained[chest]; if (!gi) continue; const avgBid = gi.priced ? gi.value / gi.priced : 0; const opened = Math.min(cb.opened, gi.qty); gi.opened = cb.opened; revalued += avgBid * opened; }
        const chestValue = Object.values(chestBy).reduce((s, c) => s + c.value, 0), chestCoins = Object.values(chestBy).reduce((s, c) => s + c.coins, 0);
        const loot = { atOpen: chestValue - revalued, atOpenRaw: chestValue, revalued, coins: chestCoins, opened: Object.values(chestBy).filter(c => c.dungeon).reduce((s, c) => s + c.opened, 0), nestedOpened: Object.values(chestBy).filter(c => !c.dungeon).reduce((s, c) => s + c.opened, 0), other, otherIds };
        // Redemptions: tokens out, items in. What came in is dungeon loot too.
        const tokens = {};
        for (const [item, gi] of Object.entries(gained)) if (X.isToken(item)) { const t = bump(tokens, item, () => ({ gained: 0, redeemed: 0, received: {} })); t.gained += gi.qty; }
        for (const r of redeems) { const t = bump(tokens, r.token, () => ({ gained: 0, redeemed: 0, received: {} })); t.redeemed += n(r.qty); t.received[r.item] = (t.received[r.item] || 0) + n(r.itemQty); const gi = bump(gained, r.item, () => ({ qty: 0, value: 0, priced: 0, chests: {} })); gi.redeemed = (gi.redeemed || 0) + n(r.itemQty); if (n(r.bid) > 0) { gi.value += r.bid * n(r.itemQty); gi.priced += n(r.itemQty); } }
        for (const [k, t] of Object.entries(tokens)) t.held = X.held(k);
        // Sold: loot (anything the record saw come out of a chest or a redemption) against everything else.
        const lootItems = new Set(Object.keys(gained));
        const sellBy = {}; const sold = { loot: { qty: 0, gross: 0, tax: 0, net: 0 }, other: { qty: 0, gross: 0, tax: 0, net: 0 } };
        for (const s of sells) {
            const r = bump(sellBy, s.item, () => ({ qty: 0, gross: 0, tax: 0, net: 0, loot: lootItems.has(s.item) }));
            const net = s.net != null ? n(s.net) : n(s.gross) * (1 - tax.rate);
            r.qty += n(s.qty); r.gross += n(s.gross); r.tax += n(s.tax); r.net += net;
            const b = r.loot ? sold.loot : sold.other; b.qty += n(s.qty); b.gross += n(s.gross); b.tax += n(s.tax); b.net += net;
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
                return { unitCost: cost / out.qty, basis: `recipe at purchase prices${art ? `, artisan ${(art.rate * 100).toFixed(1)}%` : ", no artisan seen"}${asks ? ` (${asks} at ask)` : ""}` };
            }
            return null;
        };
        const keyPrice = k => { const u = X.keyAvg(k); if (u != null) return { unitCost: u, basis: "craft average" }; const rc = recipeCost(k); if (rc) return rc; const a = X.askOf(k); return a != null ? { unitCost: a, basis: "key ask now" } : null; };
        for (const [k, r] of Object.entries(keysUsed)) { if (r.fallback) { const p = keyPrice(k); r.fallbackBasis = p ? p.basis : "unknown"; if (p) r.cost += p.unitCost * r.fallback; else r.unknown = r.fallback; } }
        for (const cb of Object.values(chestBy)) if (cb.keyItem && cb.keyPending) { const p = keyPrice(cb.keyItem); if (p) { cb.keyCost += p.unitCost * cb.keyPending; cb.keyBasis[p.basis] = (cb.keyBasis[p.basis] || 0) + cb.keyPending; } }
        const consUsed = {};
        for (const [item, t] of (X.consumeTotals || new Map())) { const r = bump(consUsed, item, () => ({ qty: 0, cost: 0, unknown: 0, offline: 0 })); r.qty += t.qty; r.cost += t.cost; r.unknown += t.unknownQty; }
        for (const o of offline) for (const it of (o.items || [])) if (X.isConsumable(it.item) && n(it.delta) < 0) { const r = bump(consUsed, it.item, () => ({ qty: 0, cost: 0, unknown: 0, offline: 0 })); const q = -it.delta; r.qty += q; r.offline += q; const u = it.unitCost != null ? it.unitCost : X.avgOf(it.item); if (u != null) r.cost += u * q; else r.unknown += q; }
        const used = { keys: keysUsed, consumables: consUsed, keyCost: Object.values(keysUsed).reduce((s, r) => s + r.cost, 0), consumableCost: Object.values(consUsed).reduce((s, r) => s + r.cost, 0) };
        used.total = used.keyCost + used.consumableCost;
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
            const bidNow = X.bidOf(item), bidAtOpen = gi.priced ? gi.value / gi.priced : null;
            // An accepted valuation covers at most what is still missing (a later Keep or sale shrinks it).
            const acc = valuedBy[item] || { qty: 0, value: 0 };
            const accepted = { qty: Math.min(acc.qty, missing), value: acc.qty ? acc.value * Math.min(acc.qty, missing) / acc.qty : 0 };
            const remaining = Math.max(0, missing - accepted.qty);
            const drift = bidNow != null && bidAtOpen ? Math.abs(bidNow - bidAtOpen) / bidAtOpen : null;
            const review = remaining > 0 && (bidNow == null || (drift != null && drift > (X.reviewPct != null ? X.reviewPct : 0.5)));
            const netBid = bidNow != null ? bidNow * (1 - tax.rate) : null;
            rows.push({
                item, gained: gainedQty, fromChests: gi.qty, redeemed: gi.redeemed || 0, opened, sold: s.qty, soldNet: s.net, held, listed: onMarket, kept, missing,
                bidNow, bidAtOpen, heldValue: bidNow != null ? (held + onMarket) * bidNow : null, valueAtOpen: gi.value, unpricedAtOpen: gi.qty - gi.priced,
                acceptedQty: accepted.qty, acceptedValue: accepted.value, remaining, netBid, drift, review,
                missingValue: accepted.value + (!review && netBid != null ? remaining * netBid : 0),
                kind: X.isKey(item) ? "key" : X.isChest(item) ? "chest" : X.isOpenable(item) ? "container" : X.isTradable(item) ? "loot" : "untradable",
            });
        }
        rows.sort((a, b) => (b.valueAtOpen + b.soldNet) - (a.valueAtOpen + a.soldNet));
        const heldLoot = rows.filter(r => r.kind === "loot").reduce((s, r) => s + n(r.heldValue), 0);
        const missingLoot = rows.filter(r => r.kind === "loot" || r.kind === "container").reduce((s, r) => s + r.missingValue, 0);
        const reviewRows = rows.filter(r => r.review).length;
        // Supplies: keys, consumables and key materials still on hand, at ledger cost.
        const keyItems = new Set([...Object.keys(keysUsed), ...crafts.flatMap(c => (c.outputs || []).map(o => o.item)), ...Object.keys(buyBy).filter(X.isKey), ...((baseline && baseline.keys) || []).map(k => k.item), ...X.heldKeys()]);
        const keys = {};
        for (const k of keyItems) {
            if (X.isRealKey && !X.isRealKey(k)) continue;
            const crafted = crafts.reduce((s, c) => s + (c.outputs || []).filter(o => o.item === k).reduce((a, o) => a + n(o.qty), 0), 0);
            const bought = buyBy[k] ? buyBy[k].qty : 0, boughtCoins = buyBy[k] ? buyBy[k].coins : 0;
            const u = keysUsed[k] || { qty: 0, cost: 0, exact: 0, fallback: 0 };
            const avg = X.keyAvg(k), price = keyPrice(k);
            const base = ((baseline && baseline.keys) || []).find(b => b.item === k);
            keys[k] = { crafted, bought, boughtAvg: bought ? boughtCoins / bought : null, used: u.qty, usedCost: u.cost, usedExact: u.exact, usedFallback: u.fallback, fallbackBasis: u.fallbackBasis || null, held: X.held(k), costPerKey: price ? price.unitCost : null, costBasis: price ? price.basis : "unknown", craftAvg: avg, baseline: base ? base.qty : 0, dropped: gained[k] ? gained[k].qty : 0 };
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
        for (const item of consNames) { const u = consUsed[item] || { qty: 0, cost: 0, unknown: 0, offline: 0 }; consumables[item] = { used: u.qty, usedCost: u.cost, unknown: u.unknown, offline: u.offline, held: X.held(item), avg: X.avgOf(item), bought: buyBy[item] ? buyBy[item].qty : 0 }; }
        const keptRows = Object.entries(keptBy).filter(([, q]) => q > 0).map(([item, qty]) => ({ item, qty, held: X.held(item), bidNow: X.bidOf(item) }));
        const net = sold.loot.net + loot.coins - spent.total;
        return { tax, spent, loot, sold, sellBy, used, net, heldLoot, missingLoot, reviewRows, rows, tokens, chests: chestBy, keys, materials, consumables, kept: keptRows, counts: { buys: buys.length, sells: sells.length, crafts: crafts.length, opens: opens.length, redeems: redeems.length, dropped: events.filter(dup).length } };
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
#mds-root{position:fixed;left:10px;bottom:46px;z-index:2147483000;width:min(840px,calc(100vw - 20px));max-height:min(72vh,700px);display:flex;flex-direction:column;background:#101b24;color:#e6eff3;border-radius:8px;box-shadow:0 0 0 1px #595d6c,0 16px 40px rgba(0,0,0,.65);font:400 14px/1.5 "Inter",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
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
#mds-root .mds-bar .mds-note{color:#c5d4de;font-size:.857em}
#mds-root table{width:100%;border-collapse:collapse;font-size:1em;font-variant-numeric:tabular-nums}
#mds-root th{position:sticky;top:0;background:#1c2a35;text-align:left;cursor:grab;user-select:none;font-size:.786em;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:rgba(230,239,243,.6);padding:7px 9px;border-bottom:1px solid rgba(230,239,243,.16)}
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
#mds-root .mds-pane h4:first-child{margin-top:0}
#mds-root details{margin:8px 0}
#mds-root summary{cursor:pointer;color:#a9e9f1}
#mds-root pre{white-space:pre-wrap;word-break:break-word;background:#1c2a35;padding:8px 10px;border-radius:8px;max-height:220px;overflow:auto;font-size:.857em;box-shadow:0 0 0 1px #3f424d}
#mds-root .mds-flag{border-bottom:1px dotted rgba(230,239,243,.5);cursor:help;white-space:nowrap}
#mds-root .mds-card{cursor:grab}
#mds-root .mds-card.mds-dragging{opacity:.5}
#mds-root .mds-card.mds-drop{box-shadow:0 0 0 2px #45c8d8}
#mds-root th.mds-dragging{opacity:.5}
#mds-root th.mds-drop{box-shadow:inset 2px 0 0 #45c8d8}
#mds-root .mds-set{margin:4px 0 10px;padding:8px 10px;background:#1c2a35;border-radius:8px;box-shadow:0 0 0 1px #3f424d}
#mds-root .mds-set-title{display:block;font-size:.929em;font-weight:500;margin-bottom:6px}
#mds-root .mds-set .mds-bar{margin:0}
#mds-tab{white-space:nowrap}
`;

    const panel = (() => {
        let root = null, toggle = null, dirty = false, timer = null, filter = "all", open = false, tab = "overview", rowsHeld = false, runsHeld = false;
        const els = {};
        let derived = null, derivedAt = 0, derivedRev = -1, bannerDismissed = false;
        const KINDS = ["all", "start", "clear", "fail", "stop", "craft", "buy", "sell", "open", "consume", "redeem", "chat", "offline", "baseline", "review"];
        const TABS = [["overview", "Overview"], ["runs", "Runs"], ["keys", "Keys"], ["loot", "Loot"], ["chests", "Chests"], ["lifetime", "Lifetime"], ["data", "Data"], ["settings", "Settings"]];
        // Text size: every size in the panel is in em of the root, so one font-size scales it all. Saved per browser.
        const SCALE_KEY = PANEL_KEY + "-scale", BASE_PX = 14;
        let scale = 1;
        try { const v = Number(localStorage.getItem(SCALE_KEY)); if (v >= 0.7 && v <= 1.8) scale = v; } catch (_e) { /* fine */ }
        function applyScale() { if (!root) return; root.style.fontSize = `${Math.round(BASE_PX * scale * 10) / 10}px`; const el = root.querySelector("#mds-fs-val"); if (el) el.textContent = `${Math.round(scale * 100)}%`; }
        // Column switches, every table: a checkbox per column, grouped by tab in Settings. Keyed by the table (its
        // tbody id) and the column's original index; everything on by default except the Runs table's Seen-by.
        const COLS_KEY = PANEL_KEY + "-cols2";
        const TABLE_TITLES = { runs: "Runs", sessions: "Sessions in the game's Loot & XP Log", keys: "Keys", mats: "Materials", loot: "Loot to sell", tokens: "Dungeon tokens", supplies: "Supplies kept for future runs", missing: "Loot no longer held", chests: "Openings", "life-dungeons": "Dungeons", "life-keys": "Key crafts", tbody: "Capture log" };
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
        function applyAllOrders() { for (const t of root.querySelectorAll("table")) applyOrder(t); }
        function setOrder(key, order) { orders[key] = order; try { localStorage.setItem(ORDER_KEY, JSON.stringify(orders)); } catch (_e) { /* fine */ } applyAllOrders(); }
        let drag = null;
        function wireColumnDrag() {
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
            new MutationObserver(muts => { const tables = new Set(); for (const m of muts) { const t = m.target && m.target.closest ? m.target.closest("table") : null; if (t) tables.add(t); } for (const t of tables) applyOrder(t); }).observe(root, { childList: true, subtree: true });
            applyAllOrders();
        }
        function setScale(v) { scale = Math.max(0.7, Math.min(1.8, Math.round(v * 20) / 20)); try { localStorage.setItem(SCALE_KEY, String(scale)); } catch (_e) { /* fine */ } applyScale(); }
        let money = null, moneyAt = 0, moneyRev = -1, moneyPrices = 0;
        const isToken = h => /_token$/.test(h);
        const moneyCtx = () => ({
            recordStart: state.meta.recordStart || 0, reviewPct: 0.5,
            isCounted, isKey: h => ref.keyItems.has(h), isChest: h => !!ref.chestItems[h], isDungeonChest: h => !!(ref.chestItems[h] && ref.chestItems[h].zone), isDungeonLoot: h => ref.dungeonLoot.has(h), isConsumable, isToken,
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
        const deriveCfg = () => ({ selfName: state.characterName, recordStart: state.meta.recordStart || 0, isChest: h => !!ref.chestItems[h], isKey: h => ref.keyItems.has(h), isCounted, keyOf: z => (ref.dungeons[z] && ref.dungeons[z].keyItem) || null, maxWavesOf: z => (ref.dungeons[z] && ref.dungeons[z].maxWaves) || null });
        function getDerived() {
            if (!derived || derivedRev !== state.timelineRev || Date.now() - derivedAt > 30000) { derived = derive(state.timeline, serverNow(), deriveCfg()); derivedAt = Date.now(); derivedRev = state.timelineRev; }
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
            root.innerHTML = `<div class="mds-head"><strong>Metz Dungeon Stats</strong><span class="mds-sub">v${VERSION}</span><button class="mds-x" title="Close">×</button></div>
<div class="mds-tabs">${TABS.map(([k, label]) => `<button role="tab" data-tab="${k}" aria-selected="${k === tab}">${label}</button>`).join("")}</div>
<div class="mds-body">
<p class="mds-status" id="mds-status"></p>
<div class="mds-banner" id="mds-banner" hidden><span>Open the game's <strong>Loot &amp; XP Log</strong> once this session (Combat → Loot &amp; XP Log) so the record can check its clears and chests against the game's own count.</span><button class="mds-x" title="Dismiss for this session">×</button></div>
<div class="mds-pane" data-pane="overview">
 <div class="mds-cards" id="mds-cards"></div>
 <p class="mds-note" id="mds-ovnote"></p>
</div>
<div class="mds-pane" data-pane="runs" hidden>
 <div class="mds-wrap mds-wrap-runs"><table><thead><tr><th>Start</th><th>Result</th><th>Dungeon</th><th>Run time</th><th>Waves</th><th>Chests</th><th>Keys</th><th>Deaths</th><th>XP</th><th>Seen by</th></tr></thead><tbody id="mds-runs"></tbody></table></div>
 <p class="mds-note" id="mds-runsnote"></p>
 <h4>Sessions in the game's Loot &amp; XP Log</h4>
 <div class="mds-wrap"><table><thead><tr><th>Start</th><th>End</th><th>Action</th><th>Game: count</th><th>Game: drops</th><th>Game: XP</th><th>This record</th><th>Seen by</th></tr></thead><tbody id="mds-sessions"></tbody></table></div>
 <p class="mds-note" id="mds-sessionsnote"></p>
</div>
<div class="mds-pane" data-pane="keys" hidden>
 <div class="mds-wrap"><table><thead><tr><th>Key</th><th>Held</th><th>Crafted</th><th>Bought</th><th>Dropped</th><th>Used</th><th>Cost per key</th><th>Used at cost</th><th>At start</th><th>Crafted all time</th></tr></thead><tbody id="mds-keys"></tbody></table></div>
 <h4>Materials</h4>
 <div class="mds-wrap"><table><thead><tr><th>Material</th><th>Recipe</th><th>Bought</th><th>Avg price</th><th>Bought total</th><th>Used by crafts</th><th>Held</th><th>At start</th></tr></thead><tbody id="mds-mats"></tbody></table></div>
 <p class="mds-note" id="mds-keysnote"></p>
</div>
<div class="mds-pane" data-pane="loot" hidden>
 <h4>Loot to sell</h4>
 <div class="mds-wrap"><table><thead><tr><th>Item</th><th>Gained</th><th>Sold</th><th>Sold net</th><th>Held</th><th>Listed</th><th>Kept</th><th>Held at bid</th><th></th></tr></thead><tbody id="mds-loot"></tbody></table></div>
 <h4>Dungeon tokens</h4>
 <div class="mds-wrap"><table><thead><tr><th>Token</th><th>Gained</th><th>Redeemed</th><th>Received</th><th>Held</th></tr></thead><tbody id="mds-tokens"></tbody></table></div>
 <h4>Supplies kept for future runs</h4>
 <div class="mds-wrap"><table><thead><tr><th>Item</th><th>Kind</th><th>Held</th><th>Ledger cost</th><th>Held at cost</th><th>Used in the record</th></tr></thead><tbody id="mds-supplies"></tbody></table></div>
 <h4>Loot no longer held</h4>
 <div class="mds-wrap"><table><thead><tr><th>Item</th><th>Missing</th><th>Bid at open</th><th>Bid now</th><th>Value (net of tax)</th><th>Status</th><th></th></tr></thead><tbody id="mds-missing"></tbody></table></div>
 <p class="mds-note" id="mds-lootnote"></p>
</div>
<div class="mds-pane" data-pane="chests" hidden>
 <div class="mds-cards" id="mds-chestcards"></div>
 <div class="mds-wrap mds-wrap-chests"><table><thead><tr><th>Time</th><th>Chest</th><th>#</th><th>Contents</th><th>Value at bid</th><th>Coins</th><th>Key cost</th></tr></thead><tbody id="mds-chests"></tbody></table></div>
 <p class="mds-note" id="mds-chestsnote"></p>
</div>
<div class="mds-pane" data-pane="lifetime" hidden>
 <h4>Dungeons, from the game's Loot &amp; XP Log</h4>
 <div class="mds-wrap"><table><thead><tr><th>Dungeon</th><th>Sessions</th><th>Clears</th><th>Chests</th><th>Time in sessions</th><th>Per clear</th><th>XP</th><th>XP / h</th><th>From</th><th>To</th></tr></thead><tbody id="mds-life-dungeons"></tbody></table></div>
 <h4>Key crafts, from the game's Loot &amp; XP Log</h4>
 <div class="mds-wrap"><table><thead><tr><th>Key</th><th>Sessions</th><th>Crafted</th><th>Essence</th><th>First</th><th>Last</th><th>Materials bought on this PC</th><th>Cost per key</th></tr></thead><tbody id="mds-life-keys"></tbody></table></div>
 <p class="mds-note" id="mds-lifenote"></p>
</div>
<div class="mds-pane" data-pane="settings" hidden>
 <h4>General</h4>
 <div class="mds-set"><span class="mds-set-title">Text size</span>
  <div class="mds-bar"><button id="mds-fs-down" title="Smaller">A −</button><span id="mds-fs-val" class="mds-note"></span><button id="mds-fs-up" title="Larger">A +</button><button id="mds-fs-reset">Reset</button><span class="mds-note">Scales every size in the panel, 70% to 180% in steps of 5%.</span></div>
 </div>
 <div class="mds-set"><span class="mds-set-title">Column and card order</span>
  <div class="mds-bar"><button id="mds-order-reset">Reset column order</button><button id="mds-cards-reset">Reset card order</button><span class="mds-note">Drag a column header onto another, or a card onto another, to move it. Every table and the card grids remember their own order.</span></div>
 </div>
 <p class="mds-note">Everything here is saved in this browser only. Below, untick a column to hide it in that table; the Runs table's Seen by (sources and notes) is off by default, and a run with a note then shows a small flag next to its result.</p>
 <div id="mds-settings-tables"></div>
</div>
<style id="mds-cols-style"></style>
<div class="mds-pane" data-pane="data" hidden>
<div class="mds-bar">
 <label>Show <select id="mds-filter">${KINDS.map(k => `<option value="${k}">${k}</option>`).join("")}</select></label>
 <button id="mds-export">Export record (JSON)</button>
 <button id="mds-export-frames">Export raw frames</button>
 <button id="mds-prices">Refresh prices</button>
 <button id="mds-history-file" title="Merge a market history file from another PC: Toolasha's listing array (JSON) or its Market History CSV">Merge market history file…</button><input type="file" id="mds-history-input" accept=".json,.csv,application/json,text/csv" hidden>
 <button id="mds-toolasha" title="Re-price stock held at record start from your own purchases and catch up fills the script did not see">Import Toolasha history</button>
 <button id="mds-reset" class="danger">Reset record</button>
 <span class="mds-note">Newest first. Source = the game message the event came from. Consumable uses are recorded but shown only under "consume".</span>
</div>
<div class="mds-wrap"><table><thead><tr><th>Time</th><th>Kind</th><th>What</th><th>Source</th></tr></thead><tbody id="mds-tbody"></tbody></table></div>
<details><summary>Diagnostics</summary><pre id="mds-diag"></pre></details>
</div>
</div>`;
            for (const id of ["mds-status", "mds-cards", "mds-ovnote", "mds-runs", "mds-runsnote", "mds-sessions", "mds-sessionsnote", "mds-tbody", "mds-diag", "mds-filter", "mds-keys", "mds-mats", "mds-keysnote", "mds-loot", "mds-tokens", "mds-supplies", "mds-missing", "mds-lootnote", "mds-chestcards", "mds-chests", "mds-chestsnote", "mds-life-dungeons", "mds-life-keys", "mds-lifenote"]) els[id] = root.querySelector("#" + id);
            // Row actions: Keep N (moves loot into supplies), Accept (freezes a valuation of loot no longer held).
            root.addEventListener("click", e => {
                const b = e.target.closest("button[data-act]"); if (!b) return;
                const item = b.dataset.item;
                if (b.dataset.act === "keep") {
                    const cur = Number(b.dataset.kept) || 0;
                    const v = W.prompt(`Keep how many ${itemName(item)} for future runs? (now ${cur}; 0 clears it)`, String(cur || held(item, 0)));
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
            root.querySelector("#mds-reset").addEventListener("click", resetRecord);
            root.querySelector("#mds-toolasha").addEventListener("click", () => importToolasha("manual").then(() => render()));
            root.querySelector("#mds-history-file").addEventListener("click", () => root.querySelector("#mds-history-input").click());
            root.querySelector("#mds-fs-down").addEventListener("click", () => setScale(scale - 0.05));
            root.querySelector("#mds-fs-up").addEventListener("click", () => setScale(scale + 0.05));
            root.querySelector("#mds-fs-reset").addEventListener("click", () => setScale(1));
            applyScale();
            for (const t of root.querySelectorAll("table")) { const key = tableKey(t); if (key) { t.dataset.key = key; if (t.tHead && t.tHead.rows[0]) tagCells(t.tHead.rows[0]); } }
            buildColumnSettings();
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
                if (tabs.length >= 3 && tabs.some(t => STRIP_TABS.includes(tabText(t)))) return list;
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
            if (!TABS.some(t => t[0] === k)) k = "overview";
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
                case "sell": if (ev.imported) return `imported from Toolasha: ${ev.qty} ${it(ev.item)} @ ${fmtCoins(ev.unitPrice)} = ${fmtCoins(ev.gross)} gross, tax at ${((ev.tax / ev.gross) * 100).toFixed(1)}% (rate, not measured), net ${fmtCoins(ev.net)}`; return `${ev.qty}× ${it(ev.item)} ${ev.unitPrice != null ? `@ ${fmtCoins(ev.unitPrice)}` : ""} · net ${fmtCoins(ev.net)}${ev.tax != null ? ` (tax ${fmtCoins(ev.tax)})` : ""}${ev.instant ? " · instant" : ""}`;
                case "open": return `${ev.count}× ${it(ev.chest)} → ${(ev.gains || []).map(g => `${g.qty} ${it(g.item)}`).join(", ")} · value at bid ${fmtCoins(ev.valueBid)}${ev.coinsGained ? ` + ${fmtCoins(ev.coinsGained)} coins` : ""}${ev.unpriced && ev.unpriced.length ? ` · unpriced: ${ev.unpriced.map(it).join(", ")}` : ""}${(ev.gains || []).some(g => g.counted || isCounted(g.item)) ? ` · counted: ${(ev.gains || []).filter(g => g.counted || isCounted(g.item)).map(g => `${g.qty} ${it(g.item)}`).join(", ")}` : ""}`;
                case "consume": return `${ev.qty}× ${it(ev.item)}${ev.unitCost != null ? ` @ ${fmtCoins(ev.unitCost)}` : ` (purchase price known for ${ev.covered || 0} of ${ev.qty})`}`;
                case "redeem": return `${ev.qty}× ${it(ev.token)} → ${ev.itemQty}× ${it(ev.item)}`;
                case "baseline": return `${(ev.items || []).filter(i => i.kind !== "key material").length} consumables and ${(ev.items || []).filter(i => i.kind === "key material").length} key materials priced at ask, ${(ev.keys || []).length} key types, ${(ev.chests || []).length} chest types · ${fmtCoins(ev.coins)} coins`;
                case "offline": { const to = Math.min(ev.to || ev.at, ev.at); return `${fmtDur(to - (ev.from || 0))} offline (${fmtTime(ev.from)} to ${fmtTime(to)}) · ${(ev.items || []).length} item deltas · XP ${fmtCoins(xpSum(ev.xpBySkill))}`; }
                case "chat": return `${esc(ev.m)}${ev.keyCounts ? " · " + esc(Object.entries(ev.keyCounts).map(([n, k]) => `${n} ${k}`).join(", ")) : ""}${ev.replay ? " · replayed" : ""}`;
                case "review": return `${esc(ev.reason)}`;
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
            const rows = state.events.filter(e => filter === "all" ? e.kind !== "consume" : e.kind === filter).slice(0, 200);
            els["mds-tbody"].innerHTML = rows.map(ev => `<tr class="${ev.kind}"><td class="t">${fmtTime(ev.at)}</td><td class="k">${ev.kind}</td><td class="d">${describe(ev)}</td><td class="t">${esc(ev.src || "")}</td></tr>`).join("") || `<tr><td colspan="4" class="t">Nothing recorded yet.</td></tr>`;
        }
        const cardKey = label => String(label).replace(/<[^>]*>/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
        function card(label, value, sub) { return `<div class="mds-card" data-card="${cardKey(label)}" draggable="true"><div class="l">${label}</div><div class="n">${value}</div>${sub ? `<small>${sub}</small>` : ""}</div>`; }
        // Card order per container (Overview, Chests), saved per browser: drag a card onto another to move it there.
        const CARDS_KEY = PANEL_KEY + "-cards";
        let cardOrders = {};
        try { cardOrders = JSON.parse(localStorage.getItem(CARDS_KEY) || "{}") || {}; } catch (_e) { cardOrders = {}; }
        function sortCards(container, htmls) {
            const order = cardOrders[container] || []; const keyOf = h => (h.match(/data-card="([^"]*)"/) || [])[1] || "";
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
            const Mc = getMoney().chests; const baseRows = holdover().rows; const earnedNow = {}, holdNow = {};
            for (const h of new Set([...Object.keys(perType), ...baseRows.map(c => c.item)])) { const base = (baseRows.find(c => c.item === h) || {}).qty || 0; const opened = Mc[h] ? Mc[h].opened : 0; holdNow[h] = Math.max(0, base - opened); earnedNow[h] = Math.max(0, (perType[h] || 0) - Math.max(0, opened - base)); }
            const chestLines = Object.entries(earnedNow).filter(([, q]) => q > 0).map(([h, q]) => `${q} ${it(h)}`).join(" · ");
            const holdLines = Object.entries(holdNow).filter(([, q]) => q > 0).map(([h, q]) => `${q} ${it(h)}`).join(" · ");
            const holdTotal = Object.values(holdNow).reduce((a, b) => a + b, 0), earnedTotal = Object.values(earnedNow).reduce((a, b) => a + b, 0);
            const cards = [
                card("Clears", S.clears, `${S.fails} failed${S.failRate != null ? ` (${(S.failRate * 100).toFixed(1)}%)` : ""} · ${S.cancelled} cancelled${S.unknown ? ` · ${S.unknown} end unknown` : ""}`),
                card("Average run", S.avgClearMs != null ? fmtDur(S.avgClearMs) : "–", S.clearMs.length ? `${S.avgRunMs != null && S.fails ? `${fmtDur(S.avgRunMs)} counting fails · ` : ""}fastest ${fmtDur(S.fastestMs)} · slowest ${fmtDur(S.slowestMs)}` : "no completed run yet"),
                card("Chests earned", earnedTotal, chestLines || "none yet"),
                ...(holdTotal ? [card("Holdover chests", holdTotal, holdLines)] : []),
                card("Keys charged", S.keysCharged, `${S.keysCrafted} crafted in the record`),
                card("In dungeons", fmtHm(S.dungeonMs), `${pct(S.dungeonMs, S.totalMs)} of ${fmtHm(S.totalMs)} recorded`),
                card("Between runs", fmtHm(S.betweenMs), `crafting ${fmtHm(S.craftingMs)} · offline ${fmtHm(S.offlineBetweenMs)} · other ${fmtHm(S.otherMs)}`),
            ];
            for (const [h, c] of Object.entries(S.counted || {})) if (c.qty > 0) cards.push(card(it(h) + "s", c.qty, Object.entries(c.byChest).filter(([, b]) => b.qty > 0).map(([chest, b]) => `${b.opened ? (b.qty / b.opened).toFixed(2) : "?"} per ${it(chest)}`).join(" · ")));
            if (S.unknownMs > 0) cards.push(card("Unaccounted", fmtHm(S.unknownMs), "runs whose end the chat ledger does not show"));
            const M = getMoney();
            cards.push(
                card("Spent", fmtCoins(M.spent.total), `buys ${fmtCoins(M.spent.buys)} · craft coins ${fmtCoins(M.spent.craftCoins)} · used in runs ${fmtCoins(M.used.total)} at ledger cost`),
                card("Loot at open", fmtCoins(M.loot.atOpen), `${M.loot.opened} dungeon chest${M.loot.opened === 1 ? "" : "s"} opened, at bid${M.loot.nestedOpened ? ` · ${M.loot.nestedOpened} chest${M.loot.nestedOpened === 1 ? "" : "s"} from inside them` : ""} · + ${fmtCoins(M.loot.coins)} coins${M.loot.other.opened ? ` · ${M.loot.other.opened} other box${M.loot.other.opened === 1 ? "" : "es"} not counted` : ""}`),
                card("Sold", fmtCoins(M.sold.loot.net), `${M.sold.loot.qty} items · ${fmtCoins(M.sold.loot.tax)} tax (${(M.tax.rate * 100).toFixed(1)}%${M.tax.measured ? "" : " assumed"})${M.sold.other.net ? ` · other sales ${fmtCoins(M.sold.other.net)} not counted` : ""}`),
                card("Net", fmtCoins(M.net), `sold + chest coins − spent · held loot ${fmtCoins(M.heldLoot)} at bid · no longer held ${fmtCoins(M.missingLoot)}${M.reviewRows ? ` · ${M.reviewRows} to review` : ""}`),
            );
            els["mds-cards"].innerHTML = sortCards("cards", cards).join("");
            const live = sessionsOf().find(e => (ref.dungeons[e.action] || /\/combat\//.test(e.action)) && isRunning(e) && e.end > S.windowStart);
            const check = live ? (() => { const o = recordInSpan(d, live); const t = compareText(o, live, S.windowStart); return t ? ` Game's Loot & XP Log, session since ${fmtTime(live.start)} (read ${fmtTime(state.lootLogAt)}): ${t}.` : ""; })() : "";
            els["mds-ovnote"].textContent = `${check}Since ${fmtTime(S.windowStart)}. A run lasts from one party key-count message to the next, the way Toolasha counts it; cancelled runs are left out of the average. Runs while you were offline come from the party chat, their chests from the login summary.${S.open ? " One run is in progress." : ""}`;
        }
        const fmtQ = q => (q == null ? "–" : Number.isInteger(q) ? q.toLocaleString() : q.toFixed(1));
        const coinsOr = (v, dash = "–") => (v == null ? dash : fmtCoins(v));
        function renderKeys() {
            const M = getMoney();
            const keyRows = Object.entries(M.keys).sort((a, b) => b[1].used - a[1].used);
            els["mds-keys"].innerHTML = keyRows.map(([h, k]) => `<tr><td class="k">${it(h)}</td><td>${fmtQ(k.held)}</td><td>${fmtQ(k.crafted)}</td><td>${k.bought ? `${fmtQ(k.bought)} @ ${fmtCoins(k.boughtAvg)}` : "–"}</td><td>${k.dropped || "–"}</td><td>${fmtQ(k.used)}</td><td>${coinsOr(k.costPerKey, "?")}<small> ${esc(k.costBasis)}</small></td><td>${fmtCoins(k.usedCost)}${k.usedFallback ? `<small> ${k.usedFallback} at ${esc(k.fallbackBasis || "?")}</small>` : ""}</td><td>${fmtQ(k.baseline)}</td><td>${lifetimeCrafted(h) || "–"}<small>loot log</small></td></tr>`).join("") || `<tr><td colspan="10" class="t">No keys seen yet.</td></tr>`;
            const mats = Object.values(M.materials).sort((a, b) => (b.boughtCoins + b.consumedCost) - (a.boughtCoins + a.consumedCost));
            els["mds-mats"].innerHTML = mats.map(m => `<tr><td class="k">${it(m.item)}</td><td class="t">${m.recipes.map(r => esc(shortAction(r))).join(", ")} ×${m.perCraft}</td><td>${m.bought ? fmtQ(m.bought) : "–"}</td><td>${m.bought ? fmtCoins(m.boughtCoins / m.bought) : "–"}</td><td>${m.bought ? fmtCoins(m.boughtCoins) : "–"}</td><td>${m.consumed ? `${fmtQ(m.consumed)} (${fmtCoins(m.consumedCost)})` : "–"}</td><td>${fmtQ(m.held)}${m.avg != null ? `<small> @ ${fmtCoins(m.avg)}</small>` : ""}</td><td>${m.baseline ? fmtQ(m.baseline) : "–"}</td></tr>`).join("") || `<tr><td colspan="8" class="t">No key recipes loaded yet.</td></tr>`;
            els["mds-keysnote"].textContent = "Cost per key = the average of the key crafts this record has seen (materials at their purchase price, plus the recipe's coins); until one is seen, the recipe at the materials' purchase prices (asks for materials never bought) with every input cut by the game's artisan rate (tea × Guzzling Pouch, as the game reports it) plus the tea's share of the craft time, and the key's own ask only when a material has no price at all. Keys held before the record began are priced the same way. Used at cost charges each live clear the exact lot it took; offline and older clears use the craft average. At start = held when the record began, priced at ask then.";
        }
        function renderLoot() {
            const M = getMoney();
            const lootRows = M.rows.filter(r => r.kind === "loot" || r.kind === "container");
            els["mds-loot"].innerHTML = lootRows.map(r => `<tr><td class="k">${it(r.item)}${r.kind === "container" ? `<small> opened ${r.opened}</small>` : ""}</td><td>${fmtQ(r.gained)}${r.redeemed ? `<small> ${r.redeemed} redeemed</small>` : ""}</td><td>${r.sold ? fmtQ(r.sold) : "–"}</td><td>${r.sold ? fmtCoins(r.soldNet) : "–"}</td><td>${fmtQ(r.held)}</td><td>${r.listed || "–"}</td><td>${r.kept || "–"}</td><td>${coinsOr(r.heldValue, "no bid")}</td><td><button class="mds-act" data-act="keep" data-item="${esc(r.item)}" data-kept="${r.kept}">Keep…</button></td></tr>`).join("") || `<tr><td colspan="9" class="t">No loot opened yet.</td></tr>`;
            const tok = Object.entries(M.tokens);
            els["mds-tokens"].innerHTML = tok.map(([h, t]) => `<tr><td class="k">${it(h)}</td><td>${fmtQ(t.gained)}</td><td>${t.redeemed ? fmtQ(t.redeemed) : "–"}</td><td>${Object.entries(t.received).map(([i, q]) => `${q} ${it(i)}`).join(", ") || "–"}</td><td>${fmtQ(t.held)}</td></tr>`).join("") || `<tr><td colspan="5" class="t">No tokens yet.</td></tr>`;
            const sup = [];
            for (const [h, k] of Object.entries(M.keys)) if (k.held > 0 || k.used > 0) sup.push({ item: h, kind: "key", held: k.held, cost: k.costPerKey, used: `${k.used} used` });
            for (const [h, c] of Object.entries(M.consumables)) if (c.held > 0 || c.used > 0) sup.push({ item: h, kind: "consumable", held: c.held, cost: c.avg, used: `${c.used} used${c.offline ? ` (${c.offline} offline)` : ""}${c.unknown ? ` · ${c.unknown} unpriced` : ""}` });
            for (const m of Object.values(M.materials)) if (m.held > 0) sup.push({ item: m.item, kind: "key material", held: m.held, cost: m.avg, used: m.consumed ? `${m.consumed} in crafts` : "–" });
            for (const k of M.kept) sup.push({ item: k.item, kind: "kept loot", held: k.qty, cost: k.bidNow, used: `${k.held} in the bag` });
            sup.sort((a, b) => (b.held * (b.cost || 0)) - (a.held * (a.cost || 0)));
            els["mds-supplies"].innerHTML = sup.map(r => `<tr><td class="k">${it(r.item)}</td><td class="t">${r.kind}</td><td>${fmtQ(r.held)}</td><td>${coinsOr(r.cost, "?")}</td><td>${r.cost != null ? fmtCoins(r.held * r.cost) : "?"}</td><td class="t">${r.used}</td></tr>`).join("") || `<tr><td colspan="6" class="t">Nothing on hand.</td></tr>`;
            const miss = M.rows.filter(r => r.missing > 0 && (r.kind === "loot" || r.kind === "container"));
            els["mds-missing"].innerHTML = miss.map(r => {
                const status = r.acceptedQty >= r.missing ? `accepted ${fmtQ(r.acceptedQty)}` : r.review ? (r.bidNow == null ? "review: no bid now" : `review: bid moved ${Math.round(r.drift * 100)}%`) : "valued at bid now";
                const act = r.remaining > 0 && r.netBid != null ? `<button class="mds-act" data-act="accept" data-item="${esc(r.item)}" data-qty="${r.remaining}" data-unit="${r.netBid}" data-bid="${r.bidNow}" data-open="${r.bidAtOpen || ""}" data-tax="${M.tax.rate}">Accept ${fmtCoins(r.remaining * r.netBid)}</button>` : "";
                return `<tr class="${r.review ? "review" : ""}"><td class="k">${it(r.item)}</td><td>${fmtQ(r.missing)}${r.acceptedQty ? `<small> ${r.acceptedQty} accepted</small>` : ""}</td><td>${coinsOr(r.bidAtOpen)}</td><td>${coinsOr(r.bidNow, "none")}</td><td>${fmtCoins(r.missingValue)}</td><td class="t">${status}</td><td>${act}</td></tr>`;
            }).join("") || `<tr><td colspan="7" class="t">Everything gained is sold, held, listed or kept.</td></tr>`;
            els["mds-lootnote"].textContent = `Loot = what this record saw come out of a chest or a token redemption. Held = in the bag now; Listed = on your sell orders. No longer held = gained − sold − opened − held − listed − kept, valued at the current bid less ${(M.tax.rate * 100).toFixed(1)}% tax; a bid that moved more than 50% since opening (or no bid) is marked for review and left out of the totals until accepted. Accepting freezes that value as a recorded event.`;
        }
        // Chests held before the record began (the baseline stock), shown as their own block.
        const holdover = () => { const base = state.timeline.find(e => e.kind === "baseline"); const rows = ((base && base.chests) || []).filter(c => c.qty > 0); return { rows, total: rows.reduce((a, c) => a + c.qty, 0) }; };
        const lifetimeCrafted = key => [...state.lootLog.values()].filter(e => ref.keyActions[e.action] && ref.keyActions[e.action].outputs.some(o => o.item === key)).reduce((s, e) => s + (e.drops[key] || e.count), 0);
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
            els["mds-life-dungeons"].innerHTML = rows.map(g => `<tr><td class="k">${esc(shortAction(g.action))}${g.tier ? ` T${g.tier}` : ""}</td><td>${g.n}</td><td>${fmtQ(g.clears)}</td><td class="d">${Object.entries(g.chests).map(([h, q]) => `${fmtQ(q)} ${/refinement/.test(h) ? "Refine" : "Chest"}`).join(", ") || "–"}</td><td>${fmtHm(g.ms)}</td><td>${g.clears ? fmtDur(g.ms / g.clears) : "–"}</td><td class="d">${Object.entries(g.xp).sort((a, b) => b[1] - a[1]).map(([sk, v]) => `${fmtCoins(v)} ${esc(sk.split("/").pop())}`).join(", ") || "–"}</td><td>${g.ms > 0 ? fmtCoins(xpSumAll(g.xp) / (g.ms / 3600e3)) : "–"}</td><td class="t">${fmtDate(g.from)}</td><td class="t">${fmtDate(g.to)}</td></tr>`).join("") || `<tr><td colspan="10" class="t">No sessions yet: open the game's Loot &amp; XP Log once.</td></tr>`;
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
                // Measured consumption wins: the crafts this record has observed say what a key really took.
                const obs = state.timeline.filter(e => e.kind === "craft" && e.action === g.action && (e.outputs || []).some(o => o.item === g.key));
                const keysOut = obs.reduce((s, e) => s + (e.outputs || []).filter(o => o.item === g.key).reduce((a, o) => a + o.qty, 0), 0);
                let cost = null, basis = "";
                if (keysOut > 0) {
                    const perKey = {}; for (const e of obs) for (const i of (e.inputs || [])) perKey[i.item] = (perKey[i.item] || 0) + i.qty / keysOut;
                    const coinsPerKey = obs.reduce((s, e) => s + (e.coins || 0), 0) / keysOut;
                    const teaPerKey = {}; for (const e of obs) for (const t of (e.teas || [])) teaPerKey[t.item] = (teaPerKey[t.item] || 0) + t.qty / keysOut;
                    const priceOf = h => { const m = mats.find(x => x.item === h); if (m && m.price != null) return m.price; const b = buys.filter(l => l.item === h); if (b.length) return b.reduce((s, l) => s + l.qty * l.price, 0) / b.reduce((s, l) => s + l.qty, 0); const a = ledgerAvg(h); return a != null ? a : askOf(h); };
                    let c = coinsPerKey, ok = true;
                    for (const [h, q] of Object.entries(perKey)) { const p = priceOf(h); if (p == null) { ok = false; break; } c += p * q; }
                    for (const [h, q] of Object.entries(teaPerKey)) { const p = priceOf(h); if (p != null) c += p * q; }
                    if (ok) { cost = c; const units = Object.values(perKey).reduce((a, b) => a + b, 0); basis = `measured on ${obs.length} craft${obs.length === 1 ? "" : "s"} (${units.toFixed(2)} materials per key) at your average paid price`; }
                }
                if (cost == null && priced) {
                    cost = mats.reduce((s, m) => s + m.price * m.perKey, 0) + coinsIn;
                    if (art && art.tea) { const tp = ledgerAvg(art.tea) != null ? ledgerAvg(art.tea) : askOf(art.tea); if (tp != null) cost += tp * art.seconds / art.teaSeconds; }
                    const asksN = mats.filter(m => m.paid == null && m.price != null).length;
                    basis = `recipe at your average paid price${asksN ? ` (${asksN} at ask)` : ""}${art ? `, artisan ${(art.rate * 100).toFixed(1)}%` : ", no artisan"}${art && art.tea ? " + tea" : ""} · no craft observed yet`;
                }
                const asks = 0;
                const coverage = mats.reduce((s, m) => s + m.needed, 0) > 0 ? mats.reduce((s, m) => s + Math.min(m.qty, m.needed), 0) / mats.reduce((s, m) => s + m.needed, 0) : 0;
                return `<tr><td class="k">${it(g.key)}</td><td>${g.n}</td><td>${fmtQ(g.crafted)}</td><td>${g.essence || "–"}</td><td class="t">${fmtDate(g.from)}</td><td class="t">${fmtDate(g.to)}</td><td class="d">${mats.map(m => `${fmtQ(m.qty)} ${it(m.item)}${m.paid != null ? ` @ ${fmtCoins(m.paid)}` : " (none here)"}`).join(", ")}<small>${Math.round(coverage * 100)}% of what these crafts consumed is in the merged history (${devices} source${devices === 1 ? "" : "s"})</small></td><td>${cost != null ? `${fmtCoins(cost)}<small>${esc(basis)}</small>` : "–"}</td></tr>`;
            }).join("") || `<tr><td colspan="8" class="t">No key crafts in the log yet.</td></tr>`;
            els["mds-lifenote"].textContent = `The game's own log (server-side, complete across devices), merged with Toolasha's saved copy: ${all.length} sessions${all.length ? ` from ${fmtDate(Math.min(...all.map(e => e.start)))}` : ""}. Time in sessions is the log's start-to-end, so XP / h is per hour of the action running, offline included. Market history is per device, merged here by listing id from this PC's Toolasha store and any file merged on the Data tab (${state.marketHistory.size} listings); the cost per key takes the average paid price in that history (a price holds whatever share was bought on one PC) with recipe quantities at your current artisan rate, since the log has no consumption per craft; no lifetime income is shown until the records from both PCs are merged (import, milestone 5).`;
        }
        function renderChests() {
            const M = getMoney();
            const otherCard = M.loot.other.opened ? [card("Other boxes (not dungeon loot)", M.loot.other.opened, `${Object.entries(M.loot.other.kinds).map(([h, q]) => `${q} ${it(h)}`).join(" · ")} · value at bid ${fmtCoins(M.loot.other.value)}${M.loot.other.coins ? ` · coins ${fmtCoins(M.loot.other.coins)}` : ""} · kept out of the loot and the net`)] : [];
            const cards = otherCard.concat(Object.entries(M.chests).sort((a, b) => b[1].opened - a[1].opened).map(([h, c]) => card(it(h), c.opened, `value at bid ${fmtCoins(c.value)}${c.coins ? ` · coins ${fmtCoins(c.coins)}` : ""}${c.keyItem ? ` · keys ${fmtCoins(c.keyCost)}` : ""}${Object.keys(c.counted).length ? ` · ${Object.entries(c.counted).map(([i, q]) => `${q} ${it(i)}`).join(", ")} counted` : ""}`)));
            const bag = Object.keys(ref.chestItems).map(h => [h, held(h, 0)]).filter(([, q]) => q > 0);
            els["mds-chestcards"].innerHTML = sortCards("chestcards", [...cards, ...(bag.length ? [card("In the bag now", bag.reduce((a, [, q]) => a + q, 0), bag.map(([h, q]) => `${q} ${it(h)}`).join(" · "))] : [])]).join("");
            const opens = state.timeline.filter(e => e.kind === "open" && e.at >= (state.meta.recordStart || 0)).slice(-300).reverse();
            els["mds-chests"].innerHTML = opens.map(ev => `<tr class="${M.loot.otherIds.has(ev.id) ? "cancelled" : ""}"><td class="t">${fmtTime(ev.at)}</td><td class="k">${it(ev.chest)}${M.loot.otherIds.has(ev.id) ? "<small>not dungeon loot</small>" : ""}</td><td>${ev.count}</td><td class="d">${(ev.gains || []).map(g => `${g.qty} ${it(g.item)}${(g.counted || isCounted(g.item)) ? " (counted)" : (g.item !== "/items/coin" && !g.bid) ? " (no bid)" : ""}`).join(", ")}</td><td>${fmtCoins((ev.gains || []).filter(g => g.item !== "/items/coin" && !g.counted && !isCounted(g.item)).reduce((s, g) => s + (g.bid ? g.bid * g.qty : 0), 0))}</td><td>${ev.coinsGained ? fmtCoins(ev.coinsGained) : "–"}</td><td>${ev.keyCost && ev.keyCost.unitCost != null ? `${fmtCoins(ev.keyCost.unitCost * ev.count)}<small> ${esc(ev.keyCost.basis || "")}</small>` : "–"}</td></tr>`).join("") || `<tr><td colspan="7" class="t">No chest opened yet.</td></tr>`;
            els["mds-chestsnote"].textContent = "Newest first. Value at bid = each item's highest bid when the chest was opened; counted items (cowbells) and unpriced items carry no value. Key cost = the chest key's lot cost; a basis of ask means the key was held before the record began.";
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
                return `<tr class="${off ? "review" : ""}"><td class="t">${fmtTime(e.start)}</td><td class="t">${isRunning(e) ? (serverNow() - e.readAt > 600e3 ? `running at ${fmtClock(e.readAt)}` : "running") : fmtTime(e.end)}</td><td class="k">${esc(shortAction(e.action))}${e.tier ? ` T${e.tier}` : ""}</td><td>${e.count}${dungeon ? " clears" : " crafts"}</td><td class="d">${drops}</td><td>${fmtCoins(xpSumAll(e.xp))}</td><td>${text || (dungeon ? "before this record" : "–")}</td><td class="t">${esc(e.source || "")}</td></tr>`;
            }).join("") || `<tr><td colspan="8" class="t">Open the game's Loot &amp; XP Log once (Moo Pass) and its sessions appear here; Toolasha's saved history is merged at login.</td></tr>`;
            els["mds-sessionsnote"].textContent = "The game's own log, one row per action session: its count (dungeon clears, or keys crafted), its drops and XP, offline included. \"This record\" counts the clears and chests this record has for the same span; ≠ marks a difference, highlighted once the session is over. The game's count is the reference; this record only adds times and costs the log does not have.";
        }
        // Notes on a run are shown as a short label; the full sentence is the tooltip.
        const noteLabel = t => /not running/.test(t) ? "restarted mid-run" : /no end/.test(t) ? "end unknown" : /lifetime totals/.test(t) ? "XP from run ends" : t.length > 22 ? t.slice(0, 20) + "…" : t;
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
                const result = r.result === "open" ? "in progress" : r.result;
                return `<tr class="${r.result}"><td class="t">${fmtTime(r.startAt)}${r.spansRecordStart ? " ↰" : ""}</td><td class="k">${result}${!colVisible("runs", 9, "Seen by") && r.note ? ` <span class="mds-flag" title="${esc(r.note)}">?</span>` : ""}</td><td class="t">${dungeonCode(r.zone, r.tier, r.startAt)}</td><td>${dur}</td><td>${r.waves ?? "–"}</td><td>${chestText(r)}</td><td>${r.keysCharged ?? "–"}${r.keysSrc === "key count" ? "*" : ""}</td><td>${r.deaths ?? "–"}</td><td>${r.xpBySkill ? fmtCoins(xpSum(r.xpBySkill)) + (r.xpPartial ? "†" : "") : "–"}</td><td class="t">${r.source}${r.note ? ` · <span class="mds-flag" title="${esc(r.note)}">${esc(noteLabel(r.note))}</span>` : ""}</td></tr>`;
            }).join("") || `<tr><td colspan="10" class="t">No runs yet.</td></tr>`;
            renderSessions(d);
            els["mds-runsnote"].textContent = "Newest first. * keys charged read from the party key counts (no clear message seen). † XP counted from when the script joined the run. ↰ the run was under way when the record started.";
        }
        function render() {
            ensure(); if (!root) return;
            if (!prices.map && !prices.fetching && !prices.error) fetchPrices(false).then(() => touch(), () => {});
            const used = state.events.filter(e => e.kind === "consume").reduce((s, e) => { s.n += e.qty; s.cost += e.unitCost != null ? e.unitCost * e.qty : 0; return s; }, { n: 0, cost: 0 });
            const runLine = state.run ? `${shortAction(state.run.zone)} T${state.run.tier} · wave ${state.run.waves} · ${fmtDur(serverNow() - state.run.startAt)}` : "between runs";
            els["mds-status"].textContent = `${state.characterName || "waiting for login"}${state.meta.recordStart ? ` · record since ${fmtTime(state.meta.recordStart)}` : " · no record yet"} · ${state.counts.events} events${state.reviews ? ` · ${state.reviews} for review` : ""} · ${runLine}${used.n ? ` · consumables used ${used.n} (${fmtCoins(used.cost)} at purchase price, recent events)` : ""}`;
            root.querySelector("#mds-banner").hidden = bannerDismissed || state.lootLogReadThisSession || !state.ready;
            if (tab === "overview") renderOverview();
            else if (tab === "runs") renderRuns(false);
            else if (tab === "keys") renderKeys();
            else if (tab === "loot") renderLoot();
            else if (tab === "chests") renderChests();
            else if (tab === "lifetime") renderLifetime();
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
        return { refresh, touch, render, moneyCtx, dock: () => ({ docked: !!dock.strip, active: dock.active, worked: dock.worked }), show: () => setOpen(true) };
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
        state.meta = {}; state.events = []; state.timeline = []; state.timelineRev++; state.consumeTotals.clear(); state.lootLog.clear(); state.lootLogRev++; state.marketHistory.clear(); state.chatSeen.clear(); state.counts.events = 0; state.ledger.clear(); state.keyLots.clear(); keyAverages.clear(); state.run = null;
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
    W.__mds = { state, ref, prices, version: VERSION, panel, toolasha: TOOLASHA, importToolasha, money: () => deriveMoney(state.timeline, panel.moneyCtx()), derive: () => derive(state.timeline, serverNow(), { selfName: state.characterName, recordStart: state.meta.recordStart || 0, isChest: h => !!ref.chestItems[h], isKey: h => ref.keyItems.has(h), isCounted, keyOf: z => (ref.dungeons[z] && ref.dungeons[z].keyItem) || null, maxWavesOf: z => (ref.dungeons[z] && ref.dungeons[z].maxWaves) || null }), feed: f => onMessage(typeof f === "string" ? f : JSON.stringify(f)), feedOut: f => onOutgoing(typeof f === "string" ? f : JSON.stringify(f)), flush: () => state.record && state.record.flush(), status: () => ({ character: state.characterName, events: state.counts.events, frames: state.counts.frames, sockets: state.sockets, viaData: state.viaData, ref: ref.ready, run: state.run && { zone: state.run.zone, waves: state.run.waves }, record: state.record && state.record.stats() }) };
    info(`v${VERSION} loaded`);
})();
