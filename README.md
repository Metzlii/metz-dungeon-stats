# Metz Dungeon Stats

A Milky Way Idle userscript that keeps one permanent record of your XP, your dungeon runs and the full dungeon cash flow: keys crafted, consumables used, chests opened and loot sold.

MIT licensed. Source and releases live in this repository.

## Install

Tampermonkey: open the raw script URL and accept the install prompt.

    https://raw.githubusercontent.com/Metzlii/metz-dungeon-stats/main/metz-dungeon-stats.user.js

The script reads the game's WebSocket and writes to IndexedDB in your browser. It never sends anything to the game or anywhere else; the only outside request is the game's own public price file.

## Status

Milestone 1 of [docs/design.md](docs/design.md): capture and record. The panel (button bottom left, "Dungeon Stats") shows every event the script derived, newest first, with the game message it came from, and exports the record and the retained raw frames as JSON.

## Replay harness

`test/index.html` feeds a synthetic dungeon session through the script without the game. Serve the parent folder on a local port and open the page; it expects the game's `init_client_data.json` at `/scratch/design-export-0919/init_client_data.json` and captured samples in `test/fixtures/samples.json` (not committed: they hold player names).
