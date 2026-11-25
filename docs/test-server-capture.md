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

A row of **Hits taken** is one monster's attack on you: all hits, then the mean by how many hits came before it
in an unbroken run, each within 5 s of the last (0, 1, 2, 3, 4+). That is the stack count Fortify holds if every
hit restarts its 5 s. The export also has the other reading, hits in the 5 s before, so a lone monster swinging
every 3 s tells the two apart: under the first the damage keeps falling for four hits, under the second it stops
after one.

The line under the status shows the last unit card you clicked: total armor and resistances, and any of the
special stats the game lists on it. **Click your own card** whenever the armor matters.

"Unattributed" rows are HP changes the lab would have had to guess at (two units acting in one message, damage
with nobody acting). They are kept in the export and never counted. If Echo's repeat arrives a moment after the
cast instead of with it, it shows up there, counted separately as "within 0.4 s of a cast".

What the lab cannot see: how much a killing hit dealt past the HP that was left, and a unit's armor unless its card
is clicked.

## The plan: all three talismans in, one monster

The game's tooltips say what each special does, so the session only has to settle the details, and the six do not
get in each other's way: each shows in a different column. A second copy of a special does not stack (two Overkill
lines count once), so the three talismans together carry exactly one of each of the six.

The lab does not need a run without talismans to compare against. Every wave's `new_battle` carries your whole
stat block and the monster's, and the lab keeps each one that changed, so what a hit SHOULD have been without the
special is worked out from your own stats.

**Setup.** Large belt, all three talismans, solo. One damaging ability on a short cooldown slotted (for Echo),
everything else unslotted so the rest are auto attacks. A single-monster zone where the monster:
- survives one hit but dies in two to five (kills come often, and most hits are not kills);
- has real armor (Shatter has something to ignore);
- hits you often and for more than a scratch (Fortify has something to reduce).

**Run.** Label `all3`, Start, and fight for 45 to 60 minutes: about 1,000 swings. Twice during it, right after the
monster has hit you two or three times in a row, click your own card; and click the monster's card once.

**Smite needs a boss.** Then 10 to 15 minutes in a planet whose boss you can reach (label `all3 boss`), same gear.
Only the hits on the boss matter there; the star in the table marks it.

**Send** the lab export. If the page reloaded during the session, send the raw frames export too.

What each special is read from:

| Special | Read from | Settles |
| --- | --- | --- |
| Consistency | `plain` auto attacks: smallest / largest | Whether it is a floor on the roll at 12% x (1 + power) of the top roll, and whether abilities are left alone |
| Shatter | `crit` against the largest `plain` on the same monster, with your critical damage and the monster's armor from the stat blocks | How much armor a crit ignores, and whether it adds to your penetration or multiplies |
| Echo | `2+ numbers` on the ability's row against its casts, and the "within 0.4 s of a cast" count | The chance (12% x (1 + power)), whether the repeat lands with the cast or after, and its size against the cast's (half?) |
| Overkill | `after a kill` against `not after a kill`: with one monster at a time, the first hit on each new one | Whether the stored damage is added to the next hit, about how much, and whether mitigation applies to it |
| Fortify | `Hits taken` by run of hits, your card after two or three hits, and the buffs listed on you at each wave start | Whether a stack is a share of your armor or points, whether a hit restarts the timer, and the cap of 4 |
| Smite | Largest `plain` hit on the boss against what your stats predict without it | Whether it is a plain 12% x (1 + power) multiplier |
| Talisman Power | Your stat block against the talismans' printed values | Whether a line is worth `value x (1 + power)` |

You and the lone monster acting in the same message is the one case the lab will not attribute. Those rows go to
"unattributed" and are left out; with one monster it is a small share.

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
