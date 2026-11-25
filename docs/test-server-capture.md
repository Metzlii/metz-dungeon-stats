# Capturing on the test server

On `https://test.milkywayidle.com` the script keeps the combat stream whole instead of sampling it, so
that what an unreleased feature really does can be read off the game's own messages before the
simulator models it. Nothing changes on the live game: the extra rules are switched on by the host
name, and the test server is its own origin, so its record is a separate database.

## What is kept there

| Rule | Messages | Limit per page load |
| --- | --- | --- |
| `test-login` | `init_character_data`, trimmed to the character, what is equipped, skills, abilities, triggers, loadouts, the combat unit, and every top-level key that names a talisman or a belt, whole | 50 |
| `test-talisman` | any message whose type or top-level keys name a talisman (crafting, rerolling, socketing) | 5,000 |
| `test-battle` | every `battle_updated` (per unit: HP, MP, attack and damage counters, the ability in hand, stun, blind, silence) | 80,000 |
| `test-new-battle` | every `new_battle`, whole (units, stats, buffs with start and duration) | 5,000 |
| `test-unit` | `battle_unit_fetched` and `profile_shared`: a unit's full stat card, sent when it is clicked | 2,000 |
| `test-cooldown` | `battle_consumable_ability_updated` | 20,000 |
| `test-equipment` | `items_updated` that touches an equipped item | 2,000 |

Get them out with **Data > Export raw frames**. The file can be large after a long session
(80,000 battle messages is roughly four hours of a five-player party).

## Install

Tampermonkey only loads the script on the test server from build 2026-11-25.1 on (the `@match`
line for it is new), so reinstall from the branch's raw file once.

## What to do in the game: the six special talisman modifiers

The client data gives these six a value and no rule. The simulator follows the tooltip text for now
and marks each rule provisional (`kernel-zone/test-server/README.md` in the simulator's source). One
short session per modifier settles it. For each: note the talisman's grade and the belt, **click
your own character's card and the monster's once per fight** (that is what puts their full stat
cards in the capture), and fight long enough for 200 or so hits.

Solo, bare of other gear changes, same zone before and after is what makes the comparison clean.

| Modifier | Text | Session | What the frames will show |
| --- | --- | --- | --- |
| Talisman Power | (belt stat) | Any ordinary line, say Armor, on a Small and then a Large belt; click your card each time | Whether a line is worth `value x (1 + power)`: the stat card's armor against the line's printed value |
| Smite | Deals {value} more damage to bosses | The same character against a boss and against a non-boss in the same planet, with and without the talisman | Largest hit on each: the ratio is Smite if it is a plain multiplier |
| Consistency | Auto attacks roll at least {value} of their maximum damage | Auto attacks only (unslot abilities), 300 or more swings, with and without | The smallest hit against the largest |
| Shatter | Critical hits gain {value} armor and resistance penetration | A crit build against a high-armor monster, with and without | Largest hits (the crits) against the monster's armor on its card |
| Echo | On ability cast, {value} chance to repeat the ability's damage or healing at half strength | One damaging ability on a short cooldown, 300 or more casts | Casts followed by a second, smaller damage step in the same message or the next, how often, and how large against the first |
| Fortify | When hit, gain {value} armor and resistances for 5s, stacking up to 4 times | Stand in front of a fast-hitting monster; click your own card after 1, 2, 3 and 4 hits, and again after 6 s without one | Armor and resistances on the card at each stack count: a share of your own armor, or points |
| Overkill | On a killing blow, stores {value} of the excess damage and adds it as true damage to the first target of your next successful direct attack | Weak monsters you kill in one hit followed by a tough one (a planet with both), with and without | The first hit on a new monster against the ordinary range of that hit |

Send the exported frames file with a line saying which session is which.
