# Gear Affixes, Item Level, Set Bonuses & Legendary Uniques — Design Doc

**Status:** Spike / draft. Last touched 2026-06-03.
**Author:** josh + Claude (gear-system audit follow-up).

Audit pass found that the current rarity ladder doubles as both the *aesthetic*
tier AND the *power budget* AND the *content tier* — and nothing else.
Legendaries are bigger numbers with better proc rates; they don't *do* anything
a common item can't. This doc proposes splitting those roles apart the way
mainstream ARPGs (Diablo, PoE, WoW, Borderlands) do, so legendary becomes a
*content* tier and rares can have great rolls without being upstaged on the
spot.

Scope: weapons, armor, accessories. Consumables (Caffeine Bomb, Rebase Scroll,
etc.) stay as-is — they're already named characters and the catalog model
works.

---

## Goals

- Decouple **rarity** (slot count / aesthetic tier) from **item level**
  (power budget) so a great-rolled rare can beat a mediocre epic.
- Give legendaries a *unique line* that changes how the item plays, not just
  bigger numbers — Borderlands red-text / D3 legendary-power energy.
- Reuse the 8-slot grid for **set bonuses** keyed to the 8 class archetypes,
  so loot reinforces build identity already established by talent_ranks.
- Let armor/accessories carry elemental affinity, not just weapons.
- Keep the deterministic-mechanics-plus-AI-flavor split — affixes are rolled
  deterministically; the AI namer prompts off the rolled affixes.
- No database flag day. Old items keep working via read-time normalization.

## Non-goals (for v1)

- **Crafting / reroll currency.** PoE-style orb economy is overkill for a
  side project. Maybe v2.
- **Item-level-up / infusion.** D4-style "your gear levels with you" is a big
  system. Static drops stay static in v1; we revisit if it feels bad.
- **Dynamic per-zone loot tables.** Tier-flat distribution stays. Theming
  comes from `set_id` tagging instead (see below).
- **Multi-element weapons.** One element per weapon, like today.
- **Auction house / trading.** This is a single-player-coop game.

---

## Current state (what's hardcoded today)

See [audit summary](../README.md) and these source pegs:

- Rarity tiers — [`packages/core/src/flavor.ts:359`](../packages/core/src/flavor.ts:359)
- Rarity drop odds — [`flavor.ts:1171`](../packages/core/src/flavor.ts:1171)
- Power roll (weapon/armor) — [`flavor.ts:1193`](../packages/core/src/flavor.ts:1193)
- Stat-bonus apply on body armor — [`flavor.ts:1264`](../packages/core/src/flavor.ts:1264)
- Weapon element roll (rare+ melee/ranged only) — [`flavor.ts:280`](../packages/core/src/flavor.ts:280)
- Stat snapshot summing — [`packages/core/src/stats.ts:196`](../packages/core/src/stats.ts:196)
- Armor pool init — [`packages/db/src/db.ts:1031`](../packages/db/src/db.ts:1031)
- Level-req derivation `ceil(power/3)` — [`db.ts:1163`](../packages/db/src/db.ts:1163)

Today every item row carries:

```ts
Item {
  type: ItemType;             // weapon | armor | consumable | ...
  slot?: EquipSlot;           // 8-slot grid
  range?: "melee" | "ranged" | "focus";
  element?: "fire" | "ice" | "lightning";
  rarity: Rarity;             // 5 tiers
  power: number;              // sole scalar — drives damage / heal / armor pool
  stat_bonus: Record<string, number>;  // {str:2, resist_fire:30}
  level_req: number;          // = ceil(power/3)
  name: string;               // AI-flavored
  flavor_text: string;        // AI-flavored
}
```

There's no affix concept, no iLvl independent of power, no set_id, no
unique-effect hook.

---

## Proposed data model

```ts
Item {
  // unchanged
  type, slot, range, element, rarity, name, flavor_text;

  // RENAMED / REPURPOSED
  item_level: number;         // was implicit in power. Independent budget.
  power: number;              // now derived from item_level + roll variance.

  // NEW
  affixes: Affix[];           // 0–4 rolls, count gated by rarity (see below)
  unique_id?: string;         // legendary only — points into UNIQUE_REGISTRY
  set_id?: string;            // optional — see "Set bonuses" below

  // unchanged (still summed in statSnapshot for back-compat)
  stat_bonus: Record<string, number>;

  // unchanged
  level_req: number;          // now = max(1, floor(item_level / 2))
}

interface Affix {
  id: AffixId;                // stable key into AFFIX_REGISTRY
  tier: 1 | 2 | 3 | 4 | 5;    // roll quality, bounded by item_level
  value: number;              // resolved magnitude (e.g. +12% crit)
}
```

**Read-time normalization** for legacy rows (mirrors the
`expedition→dungeon` and `monster→foes[0]` patterns elsewhere in the codebase):
on load, if `item_level` is absent, synthesize `item_level = power` and
`affixes = []`. Old items become "no-affix items" gracefully — they still
work, just bland. Players will replace them naturally via loot.

---

## Affix system

### Why affixes

Without affixes, two rare longswords differ only in their dice power roll
(±2). With affixes, two rare longswords feel like *different items* — one
might roll `+15% crit` and `+lifesteal 4`, another `+fire dmg 8` and
`-15% mana cost`. This is the engagement loop ARPGs run on.

### Slot count by rarity

| Rarity | Affix slots | Notes |
|---|---|---|
| common | 0 | Plain stick. |
| uncommon | 1 | One small flavor. |
| rare | 2 | The "interesting" tier. |
| epic | 3 | Build-shapers. |
| legendary | 3 + unique line | Unique = always present, doesn't count toward slot budget. |

### Affix registry (v1 catalog)

Twelve to fifteen affixes is enough for variety without an explosion of
balance work. Each has a value scaled by `(affix_tier, item_level)`.

```ts
const AFFIX_REGISTRY = {
  crit_pct:        { label: "Critical %",      stat: "crit_pct",      perTier: [3, 6, 9, 12, 15] },
  lifesteal:       { label: "Lifesteal",       stat: "lifesteal",     perTier: [2, 3, 4, 5, 6] },
  fire_dmg:        { label: "Fire Damage",     stat: "fire_dmg",      perTier: [2, 4, 6, 8, 10] },
  ice_dmg:         { label: "Ice Damage",      stat: "ice_dmg",       perTier: [2, 4, 6, 8, 10] },
  lightning_dmg:   { label: "Lightning Damage",stat: "lightning_dmg", perTier: [2, 4, 6, 8, 10] },
  resist_fire:     { label: "Fire Resist %",   stat: "resist_fire",   perTier: [5, 10, 15, 20, 25] },
  resist_ice:      { label: "Ice Resist %",    stat: "resist_ice",    perTier: [5, 10, 15, 20, 25] },
  resist_lightning:{ label: "Lightning Resist",stat: "resist_lightning", perTier: [5, 10, 15, 20, 25] },
  resist_magic:    { label: "Magic Resist %",  stat: "resist_magic",  perTier: [5, 10, 15, 20, 25] },
  thorns:          { label: "Thorns",          stat: "thorns",        perTier: [1, 2, 3, 4, 5] },
  mana_regen:      { label: "Mana Regen",      stat: "mana_regen",    perTier: [1, 1, 2, 2, 3] },
  dodge_pct:       { label: "Dodge %",         stat: "dodge_pct",     perTier: [2, 4, 6, 8, 10] },
  vit_bonus:       { label: "Vitality",        stat: "vit",           perTier: [1, 2, 3, 4, 5] },
  str_bonus:       { label: "Strength",        stat: "str",           perTier: [1, 2, 3, 4, 5] },
  int_bonus:       { label: "Intellect",       stat: "int",           perTier: [1, 2, 3, 4, 5] },
};
```

These all read back through the existing `stat_bonus` summation
([`stats.ts:196`](../packages/core/src/stats.ts:196)) — we just expand the
key set the engine understands. `crit_pct` / `lifesteal` / `thorns` /
`*_dmg` will need new combat hooks (see "Combat hooks" below). The
`resist_*` and stat-letter bonuses already work today.

### Affix tier roll

`tier` is `clamp(1, ceil(item_level / 3), 5)` plus ±1 dice variance.
A level-9 item rolls tier-3 affixes ±1; a level-15 item rolls tier-5.
This is the **iLvl-affix coupling** that makes a great-rolled rare beat a
mediocre epic — same affix at higher tier.

### Slot restrictions (v1, light)

To prevent nonsense rolls:
- `lifesteal`, `crit_pct`, `*_dmg` — weapons only.
- `thorns`, `dodge_pct` — armor only.
- `resist_*` — armor + accessories only.
- stat-letter bonuses — any slot.
- `mana_regen` — focus weapons + accessories only.

---

## Item level (iLvl) decoupled from rarity

### What changes

Today: `power = base(tier) + rarityFloor(rarity) + dice(rarity)`. Rarity does
double duty as power budget AND aesthetic tier.

Proposed: `item_level = base(monster_tier) + roll(±2)` independent of rarity.
`power = item_level + rarityFloor(rarity)` where the rarity floor is small
(common +0, uncommon +1, rare +2, epic +3, legendary +4). Most of the
"how strong is this thing" question moves to `item_level`; rarity governs
*how many* affixes ride on top.

### Why this matters

- A monster-tier-5 white drop becomes mechanically interesting again — it's
  iLvl-10 with zero affixes, but the power is real and the level_req is
  honest. Today T5 commons are vendor trash on contact.
- A monster-tier-5 legendary is iLvl-10 with three high-tier affixes plus a
  unique. The *budget* is the same; the *content* is the differentiator.
- "Lucky rare" becomes a thing: rare with two tier-5 affixes can outclass an
  epic with two tier-3s.

### `level_req` formula

Today: `ceil(power / 3)`. Proposed: `max(1, floor(item_level / 2))`.
Roughly the same gating, but driven by the right variable.

---

## Legendary unique effects

### Registry shape

```ts
const UNIQUE_REGISTRY: Record<string, UniqueDef> = {
  rebase_blade: {
    name: "Rebase Blade",
    slot: "main_hand",
    range: "melee",
    rule: "On critical hit, also apply poisoned (2 turns).",
    hook: "onCritHit",
    apply: ({ target, scene }) => applyStatus(target, "poisoned", 2, scene),
  },
  crown_of_the_druid: {
    name: "Crown of the Druid",
    slot: "helmet",
    rule: "Your regeneration ticks also restore 1 mana.",
    hook: "onRegenTick",
    apply: ({ actor }) => grantMana(actor, 1),
  },
  warlocks_grimoire: {
    name: "Warlock's Grimoire",
    slot: "off_hand",                       // shield slot, but it's a tome
    range: "focus",
    rule: "Your hexes last +1 turn.",
    hook: "onApplyHex",
    apply: ({ duration }) => duration + 1,
  },
  // ... ~15 more, one per class archetype + a few cross-class.
};
```

The hand-curated registry is the *content tier* of legendaries. Twelve to
twenty entries is plenty for v1 — we can grow it the same way the talent
node catalog has grown ([recent commits](../CHANGELOG.md): SRE Warden, Data
Warlock kits).

### Hook surface

Five or six lifecycle hooks cover the bulk of "interesting" effects:

| Hook | Fires when |
|---|---|
| `onAttackHit` | A swing connects (before damage applied). |
| `onCritHit` | Hit was a crit. |
| `onTakeDamage` | Player takes damage (post-armor). |
| `onApplyStatus` | A status is being applied to a target. |
| `onRegenTick` | A regen/passive tick fires. |
| `onSpendMana` | An ability deducts mana. |

These plumb into the existing combat / ability pipeline. Each equipped item
checks `unique_id` and runs the registered hook closure.

### Roll mechanics

When a legendary drops, after slot/range/element are rolled, pick a
`unique_id` from `UNIQUE_REGISTRY` filtered by `slot` (and `range` for
weapons). The unique's name *replaces* the AI-generated name; the unique's
`rule` line gets prepended to the AI-generated `flavor_text` so players see
the mechanical effect at the top of the tooltip.

If a legendary's slot has no registered unique (early-content gaps), fall
back to the current "fancy generic" behavior — the system degrades
gracefully.

---

## Set bonuses

### Why sets

The 8-slot grid is *built* for sets. Tagging items with `set_id` and summing
ownership at equip time is ~20 lines of code, and gives a free build lever
on top of talents.

### v1 sets (one per class archetype)

```ts
const SET_REGISTRY = {
  warden_vigil: {
    name: "Warden's Vigil",                 // SRE Warden
    pieces: 4,                              // body, helmet, pants, boots
    bonuses: {
      2: { stat: "resist_magic", value: 5 },
      4: { rule: "Armor pool +30%.", hook: "onArmorInit", multiplier: 1.3 },
    },
  },
  warlocks_cabal: {
    name: "Warlock's Cabal",                // Data Warlock
    pieces: 3,                              // helmet, amulet, ring
    bonuses: {
      2: { stat: "int", value: 2 },
      3: { rule: "Hex damage +25%.", hook: "onHexDamage", multiplier: 1.25 },
    },
  },
  // ... one per archetype.
};
```

### How sets drop

Set items roll at **rare or epic** (never legendary — legendary slot is
reserved for unique-bearing items). When a rare/epic gear drop happens,
~15% chance to slot it into a set instead of a random affix roll. The
set membership *replaces* one affix slot.

This keeps set drops rare-feeling without needing a separate roll table.

### How sets activate

In `statSnapshot()`, after summing per-item `stat_bonus`, walk equipped
items grouped by `set_id`, look up active bonus tiers, and apply. Pure
addition to the existing summation step — no new combat path.

---

## Armor/accessory elements

Trivial change: remove the `type === "weapon" && range !== "focus"` guard
in `rollWeaponElement` ([flavor.ts:280](../packages/core/src/flavor.ts:280))
for rare+ armor/accessory drops. Add an "elemental armor" affix to the
registry — e.g., a fire-affinity ring procs *burning* on the wearer's
attacks at rarity-scaled %.

### Why this is cheap

`stat_bonus` already accepts arbitrary keys. The combat hook for
on-attack-proc already exists for weapons. We're just extending the proc
source from "weapon-only" to "any equipped piece with an element".

### Stacking rule

If multiple equipped items have elements, the *highest-rarity* one wins
on each swing (no double-proc). Ties broken by slot priority:
`main_hand > off_hand > amulet > ring > body > helmet > pants > boots`.

---

## Combat hooks (what needs to be new)

Most affixes read through the existing `stat_bonus` summation. These need
new combat-side wiring:

| Affix / hook | Where to wire |
|---|---|
| `crit_pct` | [`combat.ts`](../packages/core/src/combat.ts) — already rolls crit; just add to crit chance. |
| `lifesteal` | `combat.ts` — on damage dealt, heal actor by `damage × lifesteal/100`. |
| `*_dmg` (flat element bonus) | `combat.ts` — add to weapon's element damage line. |
| `thorns` | `combat.ts` — on melee taken, reflect `thorns` damage to attacker. |
| `mana_regen` | quest-tick / turn handler — already has a regen path. |
| `dodge_pct` | `combat.ts` — already has dodge; just add. |
| Unique hooks | New thin dispatcher in `combat.ts` — `runUniqueHooks(actor, hook_name, ctx)` called at each lifecycle point. |

Set bonuses with mechanical effects (Warden's "armor pool +30%") wire into
the same hook dispatcher, just via `set_id` instead of `unique_id`.

---

## AI flavor integration

The AI namer prompt today gets: `{type, range, rarity, element, power, slot}`.
After this change, it also gets `{affixes: [{label, value}, ...]}`. So
the prompt can ask "name a rare longsword with +15% crit and +6 fire
damage" instead of "name a rare longsword" — much better names without
adding any new AI surface area.

For legendaries, the unique's hand-written `name` overrides the AI
output entirely. AI just generates the flavor blurb under the rule line.

This preserves the deterministic-mechanics / AI-flavor split documented in
[README:59](../README.md:59) — affixes are mechanical, flavor is AI.

---

## DB / schema notes

Stored as JSON columns on the items row, mirroring the existing pattern:

```sql
ALTER TABLE items ADD COLUMN item_level INTEGER;     -- backfill from power on read
ALTER TABLE items ADD COLUMN affixes TEXT;            -- JSON Affix[]
ALTER TABLE items ADD COLUMN unique_id TEXT;          -- null except legendaries
ALTER TABLE items ADD COLUMN set_id TEXT;             -- null except set pieces
```

Four nullable columns. No data migration required — read-time normalization
fills sensible defaults for old rows. New drops write the new columns.

Per the [GH Actions deploy memory](../README.md), the migration goes
through `migrations/` and applies via the deploy pipeline — no manual
`db:migrate:remote`.

---

## Rollout plan

1. **Schema migration** — add the four columns nullable. Deploy. No code
   change yet; old reads/writes unaffected.
2. **Read-time normalization** — `db.ts` synthesizes `item_level = power`
   and `affixes = []` for legacy rows. Ship behind no flag; backwards
   compatible.
3. **Affix registry + rolling** — implement `AFFIX_REGISTRY` and
   `rollAffixes(rarity, item_level)`. Wire into `rollItem`. New drops have
   affixes; old inventory keeps working.
4. **Stat-snapshot expansion** — extend [`statSnapshot()`](../packages/core/src/stats.ts:196)
   to read the new affix keys. Most flow through `stat_bonus` already; new
   keys (`crit_pct`, `lifesteal`, etc.) need explicit reads.
5. **Combat hook dispatcher** — add `runUniqueHooks` in `combat.ts`. Stub
   the registry with 3-5 uniques to validate the surface area.
6. **Set registry + activation** — one set, end-to-end (Warden's Vigil).
   Validate, then add the rest.
7. **Armor/accessory elements** — remove the weapon-only guard, add
   element-stack tie-break.
8. **UI** — gear tooltip surfaces `item_level` separately from `power`,
   lists affixes with values, calls out the unique rule and set bonuses.
   Use existing rarity coloring.

Each step ships independently behind no flag, since the system degrades
gracefully at every stage (empty affixes = no effect; missing unique_id =
no hook; missing set_id = no set bonus).

Per the [gameplay-overhaul memory](../README.md), don't deploy prod during
this work — it's a multi-step gameplay change that wants review before it
goes live.

---

## Balance notes (rough)

- Affixes inflate power. Expect ~20-40% TTK reduction at the rare+ tier
  once a player's full kit has affixes. May need to dial monster HP up by
  ~15% at tier 3+ to compensate. Watch first-week data.
- Crit + lifesteal stacking is the obvious degenerate combo. Mitigate
  by hard-capping crit at 50% and lifesteal at 10 (twice tier-5).
- Set bonuses should NOT stack with unique items — legendaries can't be
  set pieces by construction (rarity gate). Enforced by drop logic.
- Element-from-armor needs proc-cooldown thinking — if a fire ring procs
  every swing at 40%, plus a fire sword at 40%, that's a lot of burning.
  Tie-break above handles this: max one proc per swing.

---

## Open questions

- Should `item_level` continue to climb past the current monster-tier-6
  ceiling, or cap there? (Affects whether T6+ content needs new monster
  tiers, or just rarer drops at T6.)
- Should focus weapons get a "spell amplification" affix family
  (e.g., `+heal_amount`, `+shield_amount`) distinct from `*_dmg`? Probably
  yes, but it's a separate batch — defer to v1.1.
- Crafting / reroll: explicit non-goal for v1, but the affix structure is
  designed to make it cheap to add. v2 could ship a single "reforge"
  consumable that rerolls one affix.
- Set drop rate (15%) is a guess. Will need tuning after first playtest
  — too low and players never see sets, too high and sets feel mandatory.

---

## What this doesn't fix

- **Static-on-drop.** A level-1 rare stays level-1 forever. Audit flagged
  this; we chose to defer. If it feels bad after this ships, infusion is
  v2.
- **No crafting.** Drops are still take-it-or-leave-it. PoE-style economy
  is out of scope.
- **No per-zone loot tables.** Theming comes from set_id tagging, not
  zone-tagged tables. May want to revisit if archetype-specific loot
  doesn't surface enough in practice.
