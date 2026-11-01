# Metz Dungeon Stats

A Milky Way Idle userscript that keeps one permanent record of your XP, your dungeon runs and the full dungeon cash flow: keys crafted, consumables used, chests opened and loot sold.

MIT licensed. Source and releases live in this repository.

## Install

Tampermonkey: open the raw script URL and accept the install prompt.

    https://raw.githubusercontent.com/Metzlii/metz-dungeon-stats/main/metz-dungeon-stats.user.js

The script reads the game's WebSocket and writes to IndexedDB in your browser. It never sends anything to the game or anywhere else; the only outside request is the game's own public price file.

## Status

Milestones 1 and 2 of [docs/design.md](docs/design.md): capture and record; runs and time. The panel (button bottom left, "Dungeon Stats") has three tabs: **Overview** (clears, fails, average run time, chests, keys charged, time in dungeons and between runs), **Runs** (every run newest first, with offline blocks from the login summary), and **Data** (every event the script derived, with the game message it came from, plus export of the record and the retained raw frames). Runs are timed from one party key-count message to the next, the way Toolasha counts them, so runs made while offline count too.

`node test/derive.test.mjs <record.json>` runs the derivation over an exported record and prints what the two tabs would show.

## Replay harness

`test/index.html` feeds a synthetic dungeon session through the script without the game. Serve the parent folder on a local port and open the page; it expects the game's `init_client_data.json` at `/scratch/design-export-0919/init_client_data.json` and captured samples in `test/fixtures/samples.json` (not committed: they hold player names).
