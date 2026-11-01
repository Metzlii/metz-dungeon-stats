# Metz Dungeon Stats: design

A Milky Way Idle userscript that keeps one permanent record per character of three things: XP, dungeon runs, and the dungeon cash flow from buying key materials to selling the loot. Written from scratch. MWI Insight (Weylan, MIT) was read as a reference for what the game's messages carry and for the parts of its interface worth keeping; none of its code or its accounting model is reused.

## 1. Principles

1. **Tracked, never estimated.** Every number on screen is a sum over recorded game messages. There are no expected values, luck ratios, projections, replacement costs, planners or "per day" extrapolations. Where a value cannot be observed (an item sold while the script was not running), it is marked as valued at a stated price and date, and it sits in its own row, never blended into a tracked total.
2. **Verifiable.** The first tab anyone can open is the capture log: the raw events the script derived from the socket, newest first, with the message type each came from. If a run, a chest or a sale is missing or doubled, the log shows it. Mistracking is found by looking, not by guessing.
3. **One permanent record.** No sessions for dungeon data. The record starts when the script first runs on a character and grows forever. The XP tracker is the one place with a start, pause and reset, because that is what it is for.
4. **Small and quiet.** One script file, no bundled data snapshots, no 250 ms render loop, no history rewrite on every wave. Each event is one small write. The panel renders when it is visible and something changed.
5. **Portable.** Export and import of the whole record as one JSON file, merged by event id, so sales made on another machine can be folded into the home record without double counting.

## 2. What the game tells us

All data comes from the game's own WebSocket (wss api.milkywayidle.com/ws). Message shapes below were confirmed from our own raw captures where stated, otherwise from Toolasha's and Insight's handling and marked "to confirm". The first milestone verifies every "to confirm" item against a live capture before anything depends on it.

| Need | Message | Fields | Status |
|---|---|---|---|
| Who we are, starting inventory, lifetime XP, open orders | `init_character_data` | `character.id`, `characterItems[]`, `characterSkills[].experience`, `myMarketListings`, `currentTimestamp`, `partyChatHistory` | confirmed except partyChatHistory (Insight) |
| Dungeon metadata | `init_client_data` | `actionDetailMap[zone].combatZoneInfo.dungeonInfo.{keyItemHrid, maxWaves, rewardDropTable}`, key recipes under `/action_categories/crafting/dungeon_keys` with `inputItems/outputItems`, `itemDetailMap[chest].{isOpenable, openKeyItemHrid}`, `openableLootDropMap` | confirmed (full sample on disk) |
| Each wave, party, cumulative XP and loot per player | `new_battle` | `battleId`, `wave` (1-based in every capture), `combatStartTime` (action start, constant across runs), `players[].character.{id,name}`, `players[].totalSkillExperienceMap`, `players[].totalLootMap`, `players[].deathCount`, `players[].combatConsumables[]` | confirmed; duplicates for the same wave happen, dedupe on battleId+wave |
| Wave cleared, run cleared, server time, lifetime XP totals | `action_completed` | `endCharacterAction.{actionHrid, wave, currentCount, isDone, updatedAt, partyID, difficultyTier}`, `endCharacterSkills[].experience` (new lifetime totals), `endCharacterItems[]` (changed rows) | confirmed; clear = `wave === maxWaves`, `currentCount` counts clears only |
| Chests awarded and entry key charged | the clear's `action_completed.endCharacterItems` | +chest rows, -entry key row | to confirm (Insight and Toolasha both say the key is charged at the clear) |
| Fail | `new_battle` wave 1 with the same `battleId`; party chat `systemChatMessage.partyWaveFailed` | | confirmed (capture) / confirmed (Toolasha) |
| Manual stop | `actions_updated` with the dungeon action `isDone:true` before maxWaves; party chat `partyBattleEnded` | | confirmed |
| Run start and end on the server clock | `chat_message_received` with `message.chan === "/chat_channel_types/party"`, `isSystemMessage`, `m` in `partyBattleStarted`, `partyKeyCount`, `partyWaveFailed`, `partyBattleEnded`; `message.t` | solo dungeons: unknown whether any system message exists; fall back to `action_completed.updatedAt` | to confirm |
| Inventory changes | `items_updated`, and `endCharacterItems` inside `action_completed`, `market_listings_updated`, `loot_opened` | full rows: `hash`, `itemHrid`, `itemLocationHrid`, `enhancementLevel`, `count` (absolute; 0 = gone) | confirmed |
| Chest opened | `loot_opened` | `openedItem.{itemHrid,count}`, `gainedItems[].{itemHrid,count}` (one row per roll, same item may repeat, coins included) | confirmed (two samples) |
| Consumable used in combat | `battle_consumable_ability_updated.consumable` | `itemHrid`, `availableTime`; `count` present per Insight | exact keys to confirm; the authoritative count is the `items_updated` row |
| Key crafted | `action_completed` with `actionHrid` under dungeon_keys | `currentCount` delta = crafts; inputs and outputs from the same message's item rows and the recipe | confirmed shape, efficiency batches to confirm |
| Market buy or sell filled | `market_listings_updated.endMarketListings[]` | `id`, `isSell`, `itemHrid`, `enhancementLevel`, `price`, `orderQuantity`, `filledQuantity`, `taxTaken`, `unclaimedCoinCount`, `unclaimedItemCount`, `status` | confirmed (sell sample: taxTaken 5% of gross) |
| Instant buy | no listing row of its own; the coin and item rows arrive in `items_updated`; the outgoing `post_market_order` names item, level, quantity and `isInstantOrder` | read-only wrap of the socket's `send` to see the outgoing frame | see 4.3 |
| Dungeon shop redemption | `items_updated`: token count down, shop item up | | to confirm |
| Prices | `GET https://www.milkywayidle.com/game_data/marketplace.json` | `marketData[itemHrid]["0"].a` lowest ask (instant buy price), `.b` highest bid (instant sell price), `timestamp` | confirmed (Toolasha and Insight) |

Socket access: a Proxy on `window.WebSocket` installed at document-start, plus the `MessageEvent.prototype.data` getter path our Combat Sim Helper already uses, so a script manager that starts late still sees every frame. The script never sends anything and never patches `send`.

## 3. The record

One IndexedDB database per character, named after the character id. Four object stores.

**events**: append-only. Each event is one small object written once.

```
{ id, kind, at, src, ...fields }
```

- `id`: `<deviceId>-<counter>` (device id is a random id stored once per browser). Stable across export and import.
- `at`: server time when the message carried one, else local arrival time; `clock: "server" | "local"`.
- `src`: the message type it was derived from, for the capture log.

Event kinds, and only these:

| kind | fields | from |
|---|---|---|
| `start` | zone, tier, battleId, party[] | first `new_battle` of a run |
| `wave` | zone, battleId, wave, at | `action_completed` (one per wave; stored only as the latest wave on the run, not one event per wave) |
| `clear` | zone, tier, battleId, chests[], entryKeysCharged, xpBySkill (self), deaths | the clear's `action_completed` + the run's first and last `new_battle` totals |
| `fail` | zone, tier, battleId, waveReached | `new_battle` wave 1 same battleId, or chat |
| `stop` | zone, battleId, waveReached | `actions_updated` isDone early, or chat |
| `craft` | action, count, inputs[{item,qty}], coins, outputs[{item,qty}], teas[] | `action_completed` |
| `buy` | listingId, item, level, qty, unitPrice, coins | `market_listings_updated` fill delta (plus instant buys, 4.3) |
| `sell` | listingId, item, level, qty, unitPrice, gross, tax, net | `market_listings_updated` fill delta |
| `open` | chest, count, keyItem, gains[{item,qty,bid,ask}] | `loot_opened`, priced at open time |
| `consume` | item, qty, unitCost | `battle_consumable_ability_updated` count drop, confirmed by the `items_updated` row |
| `redeem` | token, qty, item, itemQty | `items_updated` diff |
| `baseline` | items[{item,qty,unitCost,basis:"ask-at-start"}], keys[], chests[] | once, when the record starts |
| `offline` | from, to, items[{item,delta}], xpBySkill, runIds[] | `init_character_data` offline summary on login (4.7) |
| `value` | item, qty, unitPrice, basis:"bid-now", flagged | the no-longer-held valuation (section 5.4), written when accepted |
| `note` | text | manual |

**runs**: one row per run, keyed by `zone:startAt`, updated in place as the run progresses: start, end, result (`clear`, `fail`, `stop`, `open` while running), waves, party, keysUsed, chests, xpBySkill, deaths, consumesDuring, `source` (`live` or `chat` for runs rebuilt from the party ledger after being offline), `clock` (`server` or `local`). This is the table the Runs tab shows; `events` is the audit trail behind it.

**inventory**: the mirror of `characterItems`, keyed by row hash, used only to diff incoming rows. Not exported.

**meta**: record start time, device id, last prices fetch, import history (file name, date, event count), settings.

Nothing is ever rewritten wholesale. Aggregates (totals, averages, cost averages) are computed in memory from `events` on load and updated incrementally per event.

## 4. Cost and value rules

### 4.1 Running purchase ledger
Each item has a running weighted average cost: `avg = (avgQtyHeld × avg + boughtQty × unitPrice) / (avgQtyHeld + boughtQty)` on every `buy`. A `consume`, a `craft` input or a key used at a clear is charged at the item's average at that moment and the held quantity in the ledger goes down. Items the script has never seen bought and that were in the bag when the record started are entered by the `baseline` event at the lowest instant buy price at that moment (marketplace.json `a`), once. After the baseline, only observed buys feed the average. The user never crafts consumables, so there is no crafted-consumable case.

### 4.2 Keys
A key's cost is exactly what its own craft consumed: the material quantities the game reported as leaving the bag in that craft's `action_completed` rows (so an Artisan Tea or gear saving shows up as fewer materials consumed, automatically), each at the material's purchase ledger average, plus the recipe's coins, divided by the keys that craft produced. Each `craft` event stores those quantities and that cost, and each key carries the cost of the craft it came from (first crafted, first used). A bought key costs its purchase price. Only a key whose craft the script never saw (held at record start, or crafted while the script was off) is priced at the average cost of the keys it has seen crafted, or at the key's ask price if it has seen none; such keys are marked `basis: "average"` or `"ask"` and are listed separately in the Keys tab.

### 4.3 Instant buys
A normal buy order shows up in `market_listings_updated` with the item, quantity and unit price, so recording it is direct. An instant buy (you click buy and it fills at the current asks immediately) does not produce a listing row of your own; the game only sends `items_updated` with your new coin total and the item's new count. Two ways to recover the price paid:

- **Watch what the client sends.** When you place any order, the game client sends `post_market_order` to the server naming the item, enhancement level, quantity and whether it is instant. Reading those outgoing frames tells us exactly which item and how many were bought; the coin drop in the following `items_updated` gives the total paid. Reading requires wrapping the socket's `send` function so the script sees the frame on its way out. The wrapper only reads and passes the frame through unchanged; it never alters or adds messages.
- **Pair the rows.** Without the outgoing frame, the script pairs a coin decrease with an item increase in the same `items_updated`. That works when the message holds one coin row and one item row. It cannot be split when two different items increased in the same message (an instant buy landing together with a chest opening, say).

The design uses both: the outgoing order names the purchase, the rows price it. If the rows arrive without a matching order (script started after the click), the pairing fallback applies, and an unsplittable message goes to the Review list with the coins and the candidate items shown, for a one-click split instead of a silent guess.

### 4.4 Chest value
An `open` records each gained item's bid and ask at the time of opening. The tracked "loot value at open" is the sum of quantity × bid, because bid is what an instant sell would have fetched. Coins gained from the chest are cash, not loot. Tokens are counted, not valued.

### 4.5 Sales and the tax rate
A `sell` records the real gross, the real tax the game reported (`taxTaken`) and the net. For valuations that have no sale behind them (held loot, loot no longer held) the script needs a rate: it uses the rate measured from your own recorded sales (`taxTaken / gross`, latest sale wins) and 4% until a sale has been recorded. The one sale in our September capture shows 5%, so the measured rate takes precedence over any constant, and the Data tab shows which rate is in force.

### 4.7 Offline play
The game keeps running dungeons while logged out, so offline time is ordinary time, not a gap. Two login sources rebuild it:

- **The party chat ledger.** The game's own system messages in the party channel carry server timestamps: `partyKeyCount` at each run's start (and again at completion) with every member's key count, `partyWaveFailed` with the wave, `partyBattleEnded` on a stop. On login the script replays the party chat history the server sends (`init_character_data.partyChatHistory`, shape to confirm) and derives every run that happened while away: start, end, duration, result, and keys used per member from consecutive key counts. These runs enter the `runs` store with `source: "chat"` and server clocks, and the same messages drive run timing while online, so online and offline runs are measured the same way.
- **The offline summary.** `init_character_data` carries what changed while away: `offlineItems` (chests gained, consumables and keys used, as deltas per item) and `offlineSkills` (XP per skill), with `lastOfflineTime` and `inactiveTime` bounding the window. The script writes one `offline` event per login holding that window, its item deltas and XP, and attributes it to the runs the chat ledger found inside the window. Chests and XP gained offline are therefore counted once, as a block over those runs, not invented per run.

What offline cannot give: per-run chest counts (the block covers them), consumable use per run, and deaths. The Runs table marks offline runs so the difference is visible. Whether a solo dungeon produces the same system messages is one of the open questions; if it does not, solo offline runs are counted from `offlineItems` chests and timed as a block.

### 4.6 Cash flow
Spent = buys (materials, keys, consumables) + craft coins. Loot sold = Σ sell.net. Loot held = loot quantity still in the bag or on sell orders, shown at current bid as a separate line. Loot no longer held = section 5.4. Net = sold + cash from chests − spent, with held and valued lines shown beside it, never added into it without saying so.

## 5. The interface

Docked into the game's Combat tab strip as a tab named **Dungeon Stats**, in the same way Insight docks, so it opens where the fighting is. The visual language is Insight's: a grid of cards, each card expandable to its detail table, collapsible sections, dense tables with sticky headers, one scoped stylesheet. Theme matches the game's dark panel.

Sub-tabs, left to right:

### 5.1 Overview
Cards, each clickable for its detail table:

- **Clears** (fails and stops in the sub-line). Detail: clears, fails, stops, fail rate, chests dropped per clear.
- **Average run time** as m:ss, fails counted in, with the last run in the sub-line. Detail: last 100 runs with start, duration, result, waves.
- **Time not dungeoning** since the record started: the clock minus time inside runs, whether those runs happened with the game open or offline (4.7). Split into crafting keys, other actions, and between runs (the dungeon action queued but no run in progress, which is where offline gaps land too). Detail: by day.
- **Spent** (keys and consumables used, at ledger cost). Detail: by item.
- **Loot value at open**. Detail: by item.
- **Sold** (net). Detail: by item.
- **Net**: sold + chest coins − spent, with the held-loot line beside it.

### 5.2 Runs
The runs table: start time, dungeon, tier, party, duration, result, waves, chests, deaths, XP gained. Filter by dungeon and result. This is the one place XP per run is shown.

### 5.3 Keys
Insight's key crafting idea kept as tracked data only: per key type, keys crafted, keys bought, keys used, keys held, cost per key (ledger), and the materials table: for each recipe input, bought (qty, average price, total), consumed by crafts, held. No planner.

### 5.4 Loot & supplies
Four sections, as in Insight's tab but tracked only:

- **Loot to sell**: items gained from chests that are tradable and not keys or chests: gained, sold, held (bag + listed), held value at current bid. Row actions: "Keep N" moves quantity into Supplies kept.
- **Dungeon tokens**: per token, gained, redeemed (with what was received), held. No valuation.
- **Supplies kept for future runs**: entry keys, chest keys, consumables, and any item marked kept. Belt and talisman items will join this list by item category when they exist.
- **Loot no longer held**: automatic. For each loot item, `gained − sold − held − listed − kept`. When positive, the missing quantity is valued at the current bid less the tax rate in force (4.5), as the net an instant sell would have paid, and shown with its open-time value beside it. If current bid differs from the open-time value by more than the review threshold (default 50%), the row is marked "review" and excluded from totals until accepted. Accepting writes a `value` event so it stops changing. An import that brings the real sale replaces the valuation automatically.

### 5.5 Chests
The opening history: time, chest, how many, contents with quantities, value at open (bid), coins gained. Totals per chest type. Nothing expected, nothing lucky.

### 5.6 XP
The tracker, modelled on Insight's: a session with Start, Pause, Reset. Per skill: XP gained, XP per hour, share of total. Sources: the self player's cumulative `totalSkillExperienceMap` from each `new_battle` while in combat (works outside dungeons too), and `action_completed.endCharacterSkills` lifetime totals for everything else, so skilling XP counts as well. Offline XP from `init_character_data.offlineSkills` attaches to the open session when the session was live within 15 minutes of going offline, else it is shown as a separate offline block. Gaps of more than 15 minutes between messages do not count toward elapsed time. Sessions are kept (last 50) and exported with the record.

### 5.7 Data
- Capture log: newest events first, with kind, time, source message and the fields. Filter by kind. This is the verification surface.
- Review list: anything the script could not resolve on its own (ambiguous instant buy, an open whose inventory diff did not match, a run with no end).
- Export: one JSON file `metz-dungeon-stats-<character>-<date>.json` with meta, events and XP sessions.
- Import: merge by event id; report counts added, skipped as duplicate, and conflicts.
- Record start, prices last fetched, refresh prices, review threshold, panel settings.

## 6. Performance

- Writes: one `put` per event into IndexedDB, batched with a 1 s debounce when a burst arrives (a 65-wave clear produces one `clear`, one run update, a few consumes).
- No hashing, packing, verification reads or whole-record rewrites.
- Rendering: only the visible sub-tab, only when its data changed, and never faster than once per second.
- Prices: marketplace.json fetched at most every 15 minutes and only when needed (an open, a valuation, the Loot tab visible).
- The message listener returns in microseconds for the message types it ignores; it never calls `stopImmediatePropagation`.

## 7. Out of scope

Everything else Insight does: combat simulator, planet sessions, skilling ledger, tasks, labyrinth, guild boards, chest luck, expected values, profit per day, key planner, replacement costs, market automation, chat merge. Also out: any write to the game (no form filling, no sends).

## 8. Build plan

1. **Capture and record** (first deliverable). Socket hook, inventory mirror, event derivation for all kinds, IndexedDB stores, the Data tab with the capture log and export. Run it for a day of dungeons and compare the log against what the game showed. Resolve every "to confirm" row in section 2 from the captured frames.
2. **Runs and time.** Runs table, clear and fail detection, run time and time-not-dungeoning accounting, Overview cards for clears and time.
3. **Cash flow.** Purchase ledger, baseline, keys, consumes, opens with prices, sales, Loot & supplies with the automatic no-longer-held section and review flags, Chests tab, Overview money cards.
4. **XP tracker.**
5. **Import** and the review list, then interface polish and the release to Greasy Fork, synced from this repository.

Version numbers: one bump per release, never per iteration.

## 9. Open questions to settle from the first capture

- Does a fresh dungeon start send `wave: 0` or `wave: 1` as its first `new_battle`?
- Is the entry key deducted in the clear's `action_completed` item rows, and is the refinement chest in the same rows?
- Exact keys of `battle_consumable_ability_updated.consumable`.
- Whether solo dungeons produce party-style system chat messages.
- Whether `init_character_data` carries `partyChatHistory` and in what shape, and how far back it reaches (Insight replays the last 400 entries; a long offline stretch of 45-second clears could exceed that).
- The sign convention of `offlineItems` for consumed items and keys, and whether `offlineSkills` is per skill delta.
- Whether efficiency procs on key crafting produce one message with several output rows or several messages.
