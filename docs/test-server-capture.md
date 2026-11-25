# Measuring on the test server

On `https://test.milkywayidle.com` the script does two extra things, switched on by the host name and by nothing
else. The test server is its own origin, so its record is a separate database from the live game's.

1. **It keeps the combat stream whole** as raw frames (Data > Export raw frames), instead of sampling it.
2. **It shows the Talisman lab**, a small panel bottom right: label a stretch, fight, read the table, export.

Install from this branch's raw file once: Tampermonkey only loads the script on the test server from build
2026-11-25.1 on, because the `@match` line for it is new.

## The Talisman lab

Type a label (`T2 on, golem`), press **Start**, fight, press **Stop** or start the next label. Each label is its
own stretch; the table shows the current one. **Export** saves every stretch as `metz-talisman-lab-*.json`.
`node test/lab-report.mjs <that file>` prints all of it (it also reads a raw frames export).

A row of **Your hits** is one ability against one monster:

| Column | What it is | What it answers |
| --- | --- | --- |
| plain | hits that were not crits and did not kill: count, smallest to largest, (mean) | Consistency: smallest / largest. Smite: largest on a boss against largest on a non-boss |
| crit | critical hits that did not kill | Shatter: a crit is always the top roll, so the crit number against the largest plain hit shows the armor it ignored |
| 2+ numbers | messages where the target was shown more than one damage number | Echo, if the repeat lands with the cast |
| after a kill / not after a kill | the first target of the action right after one of your kills, against every other hit | Overkill |

A row of **Hits taken** is one monster's attack on you: all hits, then the mean by how many hits landed on you in
the 5 s before (0, 1, 2, 3, 4+), which is the stack count Fortify would hold.

The line under the status shows the last unit card you clicked: total armor and resistances, and any of the
special stats the game lists on it. **Click your own card** whenever the armor matters.

"Unattributed" rows are HP changes the lab would have had to guess at (two units acting in one message, damage
with nobody acting). They are kept in the export and never counted. If Echo's repeat arrives a moment after the
cast instead of with it, it shows up there, counted separately as "within 0.4 s of a cast".

What the lab cannot see: how much a killing hit dealt past the HP that was left, and a unit's armor unless its card
is clicked.

## A plan for the three talismans

The game's own tooltips say what each special does; the open questions are the details. Solo, same zone, same
gear, **one talisman socketed at a time**, about 300 hits per label, and one label with the belt empty first
(`none`) as the baseline for everything.

**Baseline.** Label `none`, belt on, no talisman. Then with any talisman: click your own card once and note the
value its ordinary lines show in the game against the card. That is Talisman Power: whether a line is worth
`value x (1 + power)`.

**Talisman with Shatter, Critical Rate, Consistency, Attack Speed** (label `T2`), on a monster with a lot of armor
that does not die in one hit, auto attacks only (unslot abilities):
- Consistency: `plain` smallest / largest should be about 0.12 x (1 + power) if it is a floor on the roll, and
  much lower in `none`.
- Shatter: crit / largest plain in `T2`. Without Shatter that ratio is exactly 1 + your critical damage; anything
  above it is the armor Shatter ignored. Click the monster's card so its armor is in the export.

**Talisman with Overkill, Melee Accuracy, Physical Amplify, Echo** (label `T1`), on a planet with weak monsters
you kill in one hit and one that takes several, with one damaging ability slotted:
- Echo: `2+ numbers` against the number of casts (12% x (1 + power) expected), and the "within 0.4 s of a cast"
  count if the repeat comes separately. The export has each repeat's size against the cast's.
- Overkill: `after a kill` against `not after a kill` on the monster that survives.

**Talisman with Smite, Fortify, Overkill, Elemental Penetration** (label `T3 boss` and `T3 normal`):
- Smite: largest plain hit on a boss against the same on a non-boss in `none` and in `T3`. The game data's boss
  flag is the star in the table.
- Fortify: stand in front of something that hits fast. `Hits taken` by hits before: the means should fall from
  0 to 4+ if stacks build. Click your own card right after 1, 2, 3 and 4 hits and again after 6 s without one:
  the armor on the card says whether a stack is a share of your armor or points.

**Both Overkill talismans together** (label `T1+T3`): whether two Overkill lines add up (80%) or only one counts.

Send the lab export (and the raw frames export if the session was long or the page was reloaded) with a line
saying which talisman each label had.

## What is kept as raw frames there

| Rule | Messages | Limit per page load |
| --- | --- | --- |
| `test-login` | `init_character_data`, trimmed to the character, what is equipped, skills, abilities, triggers, loadouts, the combat unit, and every top-level key that names a talisman or a belt, whole | 50 |
| `test-talisman` | any message whose type or top-level keys name a talisman (crafting, rerolling, socketing) | 5,000 |
| `test-battle` | every `battle_updated` | 80,000 |
| `test-new-battle` | every `new_battle`, whole (units, stats, buffs with start and duration) | 5,000 |
| `test-unit` | `battle_unit_fetched` and `profile_shared`: a unit's full stat card, sent when it is clicked | 2,000 |
| `test-cooldown` | `battle_consumable_ability_updated` | 20,000 |
| `test-equipment` | `items_updated` that touches an equipped item | 2,000 |
| `test-lab` | the lab's labels (`lab_mark`), so a frames export can be split the same way | no limit |
