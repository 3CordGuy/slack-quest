# Ground Effects — Design Doc

**Status:** Draft / pre-implementation. Last touched 2026-06-05.
**Author:** josh + Claude (terrain-modifying abilities spike).

The hex grid currently has *static* terrain (`obstacles`, `loot_tiles`) generated at combat init and never modified after. All AoE abilities resolve as one-shot bursts — they deal damage and disappear. There is no way for an ability to leave a *persistent* effect on a tile: no fire patch that ticks over rounds, no caltrops that trigger on entry, no consecrated ground that heals allies who stand on it.

This doc proposes adding a `ground_effects` array to `CombatState`, three engine hooks (start-of-turn tick, on-enter trigger, round-advance decrement), and a small starter set of player-only multi-tile abilities that exercise the system.

---

## Goals

- Player-placed persistent tile effects with **round-counted duration**.
- **Multi-tile shapes** as first-class — line/wall, ring, filled blast — not just single hexes.
- Two trigger modes: **tick** (damage/heal each round while an actor stands on a marked tile) and **on-enter** (trigger when an actor moves onto a marked tile).
- **Damage credit flows to the initiator** via the existing `contribution` map, so planting a fire wall that finishes a monster still counts toward end-of-fight spoils.
- **Friendly fire on** — allies caught in a fire wall take the same tick damage as enemies. Tactical positioning is the design space.
- Additive engine change — optional field on `CombatState`, back-compat with all persisted states.

## Non-goals (v1)

- **Monster-placed hazards.** Targeting AI for "where should I drop my fire patch" is a separate problem. v1 is player-only.
- **Cross-effect interactions** (ice melts fire, water + lightning = shocked tile). v2.
- **Movement modifiers** (slow, can't pass). v2 — adds pathfinding complexity that v1 doesn't need.
- **Persistent-after-combat tiles.** Effects expire on combat resolve regardless of duration.
- **Multi-target shape preview UI work beyond what AoE already has.** Render the placed shape, reuse existing AoE highlight; no new picker chrome.

---

## Data model

New optional field on [`CombatState`](packages/core/src/combat_machine.ts:237):

```ts
ground_effects?: GroundEffect[];
```

New type (lives in [packages/core/src/hex.ts](packages/core/src/hex.ts:29) next to `Obstacle`):

```ts
export type GroundEffectKind =
  | "fire"          // tick: magic damage to occupants
  | "brambles"      // tick: small phys damage to occupants
  | "caltrops"      // on-enter: phys damage, consumed
  | "consecrated"   // tick: heal allies of source standing here
  | "frost"         // tick: small magic damage; sets up future "wet/shock" combo (v2)
  | "rune";         // on-enter: one-shot magic burst, consumed

export interface GroundEffect {
  id: string;                     // stable id for events/idempotency
  kind: GroundEffectKind;
  hexes: HexPos[];                // 1..N tiles — shape baked at placement time
  source_id: ActorId;             // initiator, for contribution credit
  expires_after_round: number;    // last round (inclusive) effect is active
  trigger: "tick" | "on_enter";
  // Kind-specific magnitude. Resolved once at placement from caster stats.
  potency: number;                // damage or heal per tick/trigger
  // For "on_enter" kinds: hexes consumed when triggered are removed from `hexes`.
  // When hexes empties, the GroundEffect is removed.
}
```

Why bake the shape at placement (an array of hexes) instead of storing `{center, shape, radius}` and recomputing each turn:
- Cheaper hooks — start-of-turn iteration just scans `hexes`, no recomputation.
- Trivially handles partial consumption (caltrops triggered on hex A but not B).
- Trivially serializable / migration-safe.

## Hooks — three insertion points

### 1. On-enter trigger — inside `handleMove`

Right after the loot-pickup block at [combat_machine.ts:1064](packages/core/src/combat_machine.ts:1064) (which already handles "actor stepped onto a special tile"), add a parallel block that scans `state.ground_effects` for an `on_enter` effect whose `hexes` include the destination. If found:

- Apply `potency` damage (kind="caltrops"/"rune") via the same damage-application path used by abilities (so resist/vuln/etc. apply).
- Credit `contribution[source_id]` with the dealt damage.
- Remove the entered hex from the effect's `hexes`; if empty, remove the GroundEffect.
- Emit a `ground_triggered` event for UI/log.

### 2. Tick — top of `turn_start` for each actor

When a turn starts for an actor, scan `state.ground_effects` for `tick` effects whose `hexes` include the actor's `pos`:

- `fire` / `brambles` / `frost` → damage the actor (any actor), credit `contribution[source_id]`.
- `consecrated` → heal actor IF actor is on `source_id`'s team (fighters; monsters never heal from player consecrations in v1). No contribution credit for heals (mirror existing heal behavior).

Friendly fire: a fighter standing on their own teammate's fire patch takes the damage. Source still gets credit — they planted it.

Edge case — source is downed/dead: credit still flows to `contribution[source_id]`. Spoils payout doesn't care if the actor is alive.

### 3. Round-advance decrement — inside `advanceTurn`

[combat_machine.ts:5670](packages/core/src/combat_machine.ts:5670). When the round counter increments (wrap-around at end of `turn_order`), filter `ground_effects` to drop any whose `expires_after_round < new_round`. Emit `ground_expired` events for UI.

## Multi-tile shape catalog

Shapes are resolved at placement time inside the ability's `execute()` callback, producing the `hexes: HexPos[]` array. Reuse existing hex math from [packages/core/src/hex.ts](packages/core/src/hex.ts).

- **Single** — `[center]`
- **Line / wall** — N collinear hexes through `center` in a chosen direction (player picks orientation; UI shows two preview orientations and player taps to confirm)
- **Ring** — hollow hex ring of radius R around `center` (6×R hexes)
- **Blast** — filled hex disk of radius R around `center` (1 + 3R(R+1) hexes — same shape as existing AoE)
- **Cone** — wedge from caster through `center`, 3 or 6 hexes (v2; skip in v1)

For v1, ship **single, line, ring, blast**. Cone deferred — it needs caster-facing math we don't currently track.

## Starter ability set (6 abilities, one per relevant class)

| Class | Ability | Shape | Kind | Trigger | Duration | Potency |
|---|---|---|---|---|---|---|
| Mage | Fire Wall | Line (3 hexes) | fire | tick | 2 rounds | `magic` |
| Mage | Ring of Frost | Ring R=1 (6 hexes) | frost | tick | 2 rounds | `magic / 2` |
| Druid | Brambles | Blast R=1 (7 hexes) | brambles | tick | 3 rounds | `magic / 2` |
| Paladin | Consecrate | Blast R=1 (7 hexes) | consecrated | tick | 3 rounds | `magic` (heal) |
| Rogue | Caltrops | Single | caltrops | on_enter | 4 rounds | `dex × d4` |
| Sage | Trapped Rune | Single | rune | on_enter | 4 rounds | `magic × d6` |

All six are placed at the existing AoE range (`range_tiles` field already on `AbilityDef`). Mana costs and rank scaling follow existing per-class budgets — to be tuned in implementation, not bikeshedded here.

Naming note: the existing druid "Firewall" ability ([druid.ts:87](packages/core/src/abilities/druid.ts:87)) is actually a +5 AC buff on an ally and unrelated to fire walls. Renaming it (e.g. "Deny Rules") is a separate concern — flag it in implementation PR but don't block on it.

## Damage credit — flow diagram

```
ability.execute() → emits PlaceGroundEffectFx
  → engine pushes GroundEffect{source_id: caster.id, …} into state.ground_effects

turn_start (actor X is on fire tile):
  applyDamage(state, X, fireDamage, source=source_id)
    → existing damage-application path
    → contribution[source_id] += dealt
    → if X is monster and HP→0, killer credit = source_id (via existing kill-credit code)

end of combat:
  spoils share computation uses contribution[] as today — no change.
```

The credit story is "the planter is the attacker for every tick" — straightforward and consistent with how summoned-NPC damage credits already work in the codebase.

## Migration / back-compat

- `ground_effects?: GroundEffect[]` is optional. Persisted states without it deserialize cleanly.
- No D1 migration needed — `CombatState` is JSON-encoded into the DO storage and the existing `upgradeCombatState()` path handles missing fields.
- All three hooks no-op when `ground_effects` is absent or empty.

## Test plan

Unit tests in `packages/core/src/`:
- `ground-effects.test.ts` — covers each kind, each shape, expiration, friendly fire, credit attribution, dead-source credit, on-enter consumption.
- Extend `combat_machine.test.ts` with one ability per shape to confirm the engine round-trip.

Manual smoke:
- Cast Fire Wall, move ally across it, confirm damage + log + credit.
- Cast Caltrops near enemy spawn, watch monster step on, confirm one-shot consume + credit.
- Cast Consecrate, confirm ally heal tick + no enemy heal + no contribution bump.

## Open questions

1. **UI for line orientation pick** — for v1, default to "horizontal line along the row the click landed on"? Or require a second tap to confirm orientation? Decide during impl.
2. **Stacking** — what if two fire walls overlap on one hex? v1 simplest answer: both tick independently, damage adds. Document and ship.
3. **Visual rendering** — canvas overlay. New particle/shader work or static tinted hex highlight? Recommend static tinted highlight + small per-kind glyph for v1; fancier VFX in a follow-up PR.

## Implementation outline

1. Add `GroundEffect` type to [hex.ts](packages/core/src/hex.ts), export from `core/index.ts`.
2. Add `ground_effects?: GroundEffect[]` to `CombatState` in [combat_machine.ts:237](packages/core/src/combat_machine.ts:237).
3. Add three hooks: `handleMove` on-enter, `turnStartEvent` tick, `advanceTurn` expiration.
4. Add `placeGroundEffect()` effect-fx helper alongside existing fx builders.
5. Implement 6 abilities, register in ability tree.
6. Canvas overlay rendering in [CombatHexGrid.tsx](apps/web/src/CombatHexGrid.tsx).
7. Tests, then PR.

Estimated effort: ~1-2 days for engine + tests, ~1 day for UI overlay + ability wiring + manual QA.
