# Changelog

## 2026-06-03 — Gear affixes, legendary uniques, set bonuses

### Items now roll affixes
Every rare-or-better weapon and armor drop now carries 1–3 affix lines on top
of its base stats — things like `+15% Critical`, `+4 Lifesteal`, `+8 Fire
Damage`, `+25% Lightning Resist`, `+5 Thorns`, `+6% Dodge`, `+2 Mana Regen`.
The affix count scales with rarity (common 0, uncommon 1, rare 2, epic 3,
legendary 3 + a unique line), and each affix's magnitude scales with the
item's level so higher-tier drops naturally beat lower-tier ones. Affix
tooltips show the value and roll tier (T1–T5) so a "T5 +15% Critical" reads
as the top of its range.

### Item level decoupled from rarity
Power and item level are now separate numbers. Power still drives damage and
armor; item level is the budget that affix magnitudes roll against. The
practical effect: a well-rolled rare can outperform a mediocre epic. Tooltips
show `iLvl` separately from `+power` so the difference is legible. Legacy
items in existing inventories backfill `iLvl = power` on read; nothing breaks.

### 12 hand-curated legendary uniques
Legendaries no longer just have bigger numbers — they carry a named rule.
Examples: **Rebase Blade** (crits also apply Poisoned for 2 turns),
**Crown of the Druid** (your regen ticks restore 1 extra HP),
**Warden's Vigil Plate** (physical hits cost +1 thorns reflection),
**Smoke-Step Boots** (first hit each combat: auto-dodge),
**Hot-Path Dagger** (consecutive hits on the same foe deal +2 damage),
**Cinder Amulet** (your fire damage ignites for 2 burn ticks). Twelve
entries shipping; covers every class archetype with room to grow.

### 8 class-themed set bonuses
Equipping multiple pieces of the same set now unlocks tiered bonuses:
**Warden's Vigil** (2pc: +5% magic resist, 4pc: armor pool +30%),
**Warlock's Cabal** (2pc: +2 INT, 3pc: hex damage +25%),
**Paladin's Creed** (2pc: +3 VIT, 3pc: shield-block +10%),
**Druid's Canopy** (3pc: regen ticks +1 HP), and four more — one per class.
Set drops land on rare and epic items at ~15% of qualifying rolls; tooltip
shows a purple ◆ Set badge.

### Armor and accessories can carry elemental affinity
Fire, ice, and lightning are no longer weapon-only. Rare-or-better rings,
amulets, helmets, body armor, pants, boots, and shields can all roll an
element. The active element on your character is picked by slot priority
(main_hand wins, otherwise off_hand, amulet, ring, …) so an elemental amulet
fills in when your weapon is non-elemental.

### Combat hooks for every new affix
The combat system reads the new affixes at the right lifecycle points:
critical % stacks with DEX into a combined crit roll (hard-capped at 50%),
lifesteal heals on every landed hit, element damage flat-adds when your
active element matches, thorns reflects physical damage back to the attacker
(capped at 10/hit), dodge % stacks with AGI dodge (hard-capped at 35%), and
mana regen ticks silently at the start of each of your turns.

### Shop, smithy, and tower rest stock carry affixes
A refreshed shop now sells affixed rare and epic items the same way monster
drops carry them. Smithy and tower-rest stock follow the same pattern. The
"buy from shop = boring sticks" problem is gone.

### Latent gear bugs fixed
Two pre-existing bugs surfaced and were repaired along the way: combat-drop
rings, amulets, and elemental weapons were silently losing their slot, stat
bonus, and element on insert (so a rolled fire sword arrived in your
inventory as a plain sword); and the smithy's fallback rarity roll could
disagree with its power roll's rarity. Both fixed via a centralized
roll-to-inventory helper.

## 2026-05-22 — Full class reworks, ability system overhaul, CI/CD

### Class reworks (all classes)
Every class received a significant ability overhaul. The ability system now
supports cooldown turns, multiple passives, and richer routing (AoE, advantage
rolls, utility effects).

**DevOps Mage** — Fireball reworked from `2d6 + magic_mod` to `magic_mod × d6`
(scales harder with INT, tagged as fire AoE). Added Lightning Bolt (d20 + magic
to-hit, `magic × d8` lightning damage) and Mage Armor (3d6 + magic shield to
any ally). Fireball and Containerize both gain a 1-turn cooldown.

**QA Paladin** — Full rework. Passive changed to **Holy Rage** — accumulate a
damage bonus equal to 10% of total HP damage received (stacks, consumes on next
attack). Abilities: **Smite** (1m, +2d8 damage + 50% enemy damage debuff),
**Shield of Faith** (2m, +5 AC party-wide for 3 rounds), **Lay on Hands** (1m,
heal `1d6 + mag/2 + vit/2`; double-heals caster if target is the protected ally),
**Protect** (free + 2-turn cooldown, split damage with an ally or self-shield
`2d6 + mag/2 + vit/2`). Auto-trigger: when any fighter drops to ≤ 30% HP from a
monster hit, the Paladin auto-fires Lay on Hands once per fight.

**Backend Druid** — Fully reworked. Old Wildgrowth / Migrate / DB-Tree Communion
replaced. New passive: **Primal Strikes** — magic mod applies to attack to-hit
and damage, and dealing attack damage heals you for `2×mag + attack`. New
abilities: **Regeneration** (1m, HoT on ally for 4 rounds), **Animal Form** (2m,
transform for 4 rounds: each stat increases by `mag + 25%`), **Wildgrowth** (2m,
AoE: `3d6 + mag + attack` to all enemies + entangle for 2 rounds), **Barkskin**
(1m, +5 AC on any ally for 2 rounds).

**Frontend Bard** — Mock and Encourage merged into a single free ability
**Verse** (2-turn cooldown) — target an ally for advantage or an enemy for
disadvantage on their next 2 rolls. Battle Hymn now restores mana to all allies
in addition to the damage aura boost. Crescendo restored as the damage
signature. Ability cooldowns wired throughout.

**Staff Sage** — Unchanged mechanically from previous rework (Manifest + Foresee
+ Sage's Reading passive).

**Refactor Rogue** — Full rework. Old passive (First Strike) replaced with
**Lethal Strikes** — crits apply `2 + floor(level/2)` bleed stacks. New
abilities: **Backstab** (free + 2-turn cooldown, rolls with advantage, takes the
higher of two d6s; auto-crits if monster ≤ 50% HP), **Vanish** (2m,
untargetable for 2 rounds; attacking from Vanish auto-crits), **Envenom Weapon**
(1m, next 2 hits each apply `2 + level` poison stacks), **Debilitate** (1m,
stun for 1 round + 20% increased damage taken for 2 rounds).

**SRE Warden** — Fully reworked. Old single `harden_up` once-per-fight passive
replaced with two always-on passives: **Thorns** (deal 25% of armor value back
to attackers on every hit) and **Armor Up** (regen `2 + floor(level/4)` shield
at the start of each own turn). Bulwark Strike reworked to use a d20 to-hit roll
(`attack mod`) and deals `1d10 + attack + 50% armor` on hit (free ability, 2-turn
cooldown). New **Brace** ability (free, 4-turn cooldown): restore 50% max armor
as shield and reduce incoming damage by 20% for 2 turns.

**Data Warlock** — Fully reworked. Passive changed to **Sinister Queries** —
dealing any damage applies `1 + floor(level/5)` bleed stacks to the target.
Abilities: **Leech Life** (1m, `2d6 + magic` damage + heal for 50% dealt),
**Hex** (1m, reduce monster damage 25% + take 3 bleed stacks on each damage
received), **Forbidden SQL** (2m, consume all bleed stacks for
`(2 + floor(magic/4)) × stacks` damage), **Summon Imp** (2m, pet ally with
`5 + level + magic` HP and magic-based attacks).

### Weapon power halved in all damage formulas
`weaponPower` is now halved (`Math.floor(wpn / 2)`) before being added to any
signature or ability formula. This rebalances high-weapon classes without
removing gear scaling entirely. Affects: Mage, Paladin, Druid, Bard, Sage,
Rogue, Warden, Warlock damage signatures.

### Universal heal / cast / shield commands removed
`/sq heal`, `/sq cast`, and `/sq shield` slash subcommands have been removed.
All healing and support is now ability-driven per class. Use `/sq ability` or
the web combat action bar.

### GitHub Actions CI/CD
All deployments now happen through GitHub Actions instead of requiring a local
`wrangler deploy`. Two workflows added:
- **CI** (`ci.yml`): runs the full Vitest suite on every pull request.
- **Deploy** (`deploy.yml`): deploys the web worker then the Slack worker on
  every push to `main` (web first so DO bindings exist when Slack binds them).
  Wrangler configs are written from GitHub Secrets at deploy time — no local
  config files committed.

### Ability cooldowns wired end-to-end
Active abilities with `cooldown_turns` are now tracked in `CombatState` and
enforced in both the machine (`step()`) and the Slack action bar. The web UI
grays out cooling-down abilities and shows the remaining turns. Abilities that
can't be used show a rejected event rather than silently no-oping.

## 2026-05-19 — Armor system, lobby overhaul, web party invites

### Damage types & depletable armor pools
Weapons and monsters now have damage types (slash, pierce, blunt, fire, ice, lightning, poison, bleed). Each fighter has an armor pool based on equipped gear — incoming physical hits are absorbed by armor before reaching HP. Armor depletes during combat and is shown as a gray bar separate from HP. Monsters have a probabilistic no-armor roll based on tier so weaker enemies stay fragile.

### Armor bar in web UI
Fighter HP rows now show a separate gray armor bar that depletes as hits land. A "depleted" indicator appears when armor hits zero. Short rest, long rest, and the inn all restore the armor pool.

### Smithy repair service
The smithy now offers armor repair between fights in addition to item upgrades. Repair cost scales with how much armor has been depleted.

### Elemental weapon effects & INT-driven mana
Fire, ice, and lightning weapons apply status effects on hit (burn, frozen, shocked). Mana pool now scales with INT and level the same way HP scales with VIT.

### Status effect icons & particle bursts
New SVG icons for fire, ice, lightning, bleed, and poison status effects in the combat HUD. Defeating enemies triggers tsParticles burst effects (fire, ice, lightning, frozen, victory) as visual feedback.

### Quest lobby system
Party quests now start in a lobby instead of jumping straight into combat. Invited players get explicit Accept / Decline buttons; everyone must Ready Up before content is revealed. The quest creator can Force Start at any time. Lobby auto-starts after 5 minutes via a Durable Object alarm.

### Web-side party invites
Quest creation from the web app now shows a teammate picker — check players to invite, and the button becomes "Start Lobby." Invitees receive a Slack DM with a link to the web app to accept or decline (skipped for users without a Slack username).

### Mid-lobby invite button
While in a lobby, the creator can open an "Invite Player" panel to add more teammates without leaving the web app.

### Solo quests skip the lobby
Creating a solo quest no longer requires a Ready Up step — it auto-starts immediately.

### Engine combat victory fix
Outskirts hunts and other engine-path quests were silently swallowing victories — no XP, gold, or quest completion. Fixed by wiring `resolveVictory` / `resolveDeath` into the `handleCombatViaEngine` path.

### Delayed Slack turn notifications
Turn @mention pings are now delayed 2 minutes via a Durable Object alarm instead of posting immediately to the channel. Notifications are cancelled if the player acts before the timer fires. Quest completion also cancels any pending notification.

### Victory modal icon refresh
The victory modal replaces all emoji with SVG icons (health-normal, health-potion, health-decrease, death-skull, party-popper, party-flags). Modal height no longer clips on small screens.

### Character sheet icon fixes
HP display now uses the `health-normal` SVG; mana uses `wizard-staff`. Healing buttons use `health-potion`.

## 2026-05-15 — Combat & Inventory UX fixes

### Solo quest heal/shield auto-target
Solo questers no longer get a one-option "pick a target" prompt when healing or shielding. Heal/shield fire on self immediately. Multi-party combat is unchanged.

### Auto-resolve checkbox engages immediately
Previously, ticking "Auto-resolve enemy turns" while the first enemy turn was already on the board did nothing — you had to manually resolve once before it kicked in. The checkbox now engages right away on whichever turn is current.

### Party dice separated from enemy dice
Combat dice rolls used to pile into a single row at the bottom of the screen, making it hard to tell who rolled what (especially solo). Rolls are now split into two labeled rows — red "Enemy" above, blue "Party" below.

### Selling items keeps inventory open
Confirming a sale used to dismiss the inventory modal underneath, so each sell forced you to reopen inventory and re-scroll to the next item. Inventory now stays mounted under the confirm dialog; after Sell or Cancel you land right back where you were.
