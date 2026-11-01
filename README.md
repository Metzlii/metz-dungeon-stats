# Metz Dungeon Stats

A Milky Way Idle userscript that keeps one permanent record of your XP, your dungeon runs and the full dungeon cash flow: keys crafted, consumables used, chests opened and loot sold.

MIT licensed. Source and releases live in this repository.

## Install

Tampermonkey: open the raw script URL and accept the install prompt.

    https://raw.githubusercontent.com/Metzlii/metz-dungeon-stats/main/metz-dungeon-stats.user.js

The script reads the game's WebSocket and writes to IndexedDB in your browser. It never sends anything to the game or anywhere else; the only outside request is the game's own public price file.

## Status

Milestones 1 to 5 of [docs/design.md](docs/design.md): capture and record; runs and time; cash flow; XP tracker; import and review. The panel (the **Dungeon Stats** tab in the game's Combat tab strip; a button bottom left on pages without that strip) has six tabs: **Overview** (clears, fails, average run time, chests earned and holdover, time in dungeons and between runs, then spent, loot value at open, sold and net, and the consumables used with marketplace links), **Runs** (every run newest first, with offline blocks from the login summary, and the sessions of the game's own Loot & XP Log beside what the record counted), **Keys** (a key crafting planner with marketplace links and the game's crafting-page navigation, then per key type crafted, bought, used, held and cost per key, with the materials table), **Loot** (loot to sell with a Sell button to the marketplace per item and a Holdover column for stock that predates the record, kept out of held value and net; dungeon tokens, supplies kept, and loot no longer held valued at bid less tax with a review flag when the bid moved more than 50%), **Chests** (every opening with contents and value at bid, totals per chest type, and the chest count checked against the bag), **Lifetime** (the game's own Loot & XP Log: per dungeon clears, chests, time and XP per hour, keys crafted all time; per combat skill its XP, XP per hour and where the rate was best), **XP** (XP per skill since the record began, exact from the game's lifetime totals, XP per hour over active time, today, a table of days, and ability XP), **Abilities** (every ability's level, XP to the next level, the books that takes, books held, and the cost of the rest at ask), **Settings** (General: text size from 70% to 180% and a reset for column order; then, per tab, which columns of each table to show; saved per browser). Any table's columns can be reordered by dragging a header onto another. Ctrl+click a row to put it into the game's chat input as one line. Every section folds from its header, with a count in the header, and remembers whether it was open., and **Data** (a review list of what the script could not settle, every event the script derived with the game message it came from, export of the record and the retained raw frames, and import of this character's record from another PC, merged so nothing counts twice). Runs are timed from one party key-count message to the next, the way Toolasha counts them, so runs made while offline count too. If Toolasha is installed, its market history prices the stock you held when the record began at what you actually paid, and fills the script did not see are imported as events marked imported. Market history is per device, so a file from another PC (Toolasha's listing array or its Market History CSV) can be merged on the Data tab; the merged history prices keys on the Lifetime tab.

`node test/derive.test.mjs <record.json>` and `node test/money.test.mjs <record.json> --market marketplace.json` run the two derivations over an exported record and print what the tabs would show.

## Replay harness

`test/index.html` feeds a synthetic dungeon session through the script without the game. Serve the parent folder on a local port and open the page; it expects the game's `init_client_data.json` at `/scratch/design-export-0919/init_client_data.json` and captured samples in `test/fixtures/samples.json` (not committed: they hold player names).
