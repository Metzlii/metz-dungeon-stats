# Translations

Metz Dungeon Stats shows its own words in the game's language (the eight the game ships, plus English). The
game's nouns (items, abilities, monsters, places, skills) are not here: the script asks the game for them.

- `en-keys.json`: every English string the script translates. A key may hold `{placeholders}`.
- `<lang>.json`: English string -> translation. A missing or empty entry shows in English.
- `game-terms.json`: the game's own words for the few game terms our strings use (Loot & XP Log, Bloom, the
  Combat menu and Battle tab), from `node pull-game-terms.mjs`. Use them when a string mentions those.

To change a translation, edit `<lang>.json`, then run `node merge-locales.mjs` from this folder: it checks every
placeholder (a mismatch stays English and is reported) and rewrites the `// <locales>` block in the script.

To add a string: wrap it in `t("…")` where the code builds a line from parts, or leave plain text in the panel's
markup (the panel translates whole text nodes). Add the English to `en-keys.json` and its translation to each file.
