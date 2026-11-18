# Abilities: review and refactor plan

Branch reviewed: `class-abilities` (at `0b8b59b`), against `main`.
This document is meant to be followed by an implementing agent. It has four parts:

1. [How abilities work today, and why it will not scale](#1-how-abilities-work-today)
2. [Bugs found](#2-bugs-found) (each with a reproduction and a fix)
3. [Target architecture](#3-target-architecture)
4. [The plan, phase by phase](#4-the-plan) (each phase leaves every test green and is its own commit)

Read [Ground rules](#ground-rules) before changing anything.

---

## Ground rules

These hold for every phase.

- **Verify after every step.** From the repo root:
  - `cd packages/world && npx vitest run && npx tsc --noEmit`
  - `cd apps/game && npx vitest run && npx tsc --noEmit`
  - Baseline at the time of writing: world 920 passed / 1 skipped, game 305 passed, both typecheck clean.
    (`pnpm -r typecheck` fails in `packages/core/src/ground-effects.test.ts:497`. That failure is older than this branch and has nothing to do with it. Leave it alone.)
- **Keep the RNG call order unless a phase says otherwise.** `stepZone` is seeded. Many tests, and the golden snapshots added in Phase 1, depend on dice coming off the RNG in the same order. When you move code, keep the order of `d20`, `rollDice`, `saveRoll`, `attackRoll` and `ctx.rng.int` calls exactly as it is. If a snapshot changes and you did not mean to change behaviour, you broke the order. Find out why; do not just update the snapshot.
- **Keep the saved state readable.** `ZoneState` is persisted as JSON in D1 (`zones.state_json`) and reloaded after hibernation. Do not rename condition kinds, weather kinds, `UnitCondition` fields (`amount`, `at`, `joined`, `surge`, `by`, `fresh`), `Budget` fields or `Unit` fields. Adding optional fields is fine.
- **Keep the wire format.** `ZoneEvent`, `ZoneAction` and `ZoneView` are what the client receives. Adding event variants is fine. Changing existing ones means changing `apps/game/src/client/ZoneView.tsx` in the same commit.
- **Keep the engine primitives' exports.** Tests import `addCondition`, `damage`, `kindle`, `burnOf`, `shieldOf`, `attackContext`, `defenceOf`, `walk`, `abilityArea`, `checkAbility`, `crateBlow`, `enemyAct`, `wayBetween`, `TACTICS`, `tacticOf`, `abilityDice` and the kit constants. Keep them exported, as thin wrappers if their insides move. Remove one only after updating every test that uses it.
- **One phase, one commit** (or a few), on `class-abilities` or a branch off it. The commit message ends with the attribution line the harness gives you. Do not push.
- **Comment style.** The codebase writes comments in plain, in-world English ("A torch swung in the hand hits with the torch…"). New code should read the same way.

---

## 1. How abilities work today

### The pieces

| Concern | Where |
|---|---|
| Card: name, stat, damage/heal numbers, legacy effect fields, blurb | `packages/world/src/content.ts` `ABILITIES` (shared with voyage battles in `battle.ts`) |
| Zone behaviour as flags | `packages/world/src/zone/kit.ts` `Tactic` (44 optional fields; 12 on `main`) and `TACTICS` |
| Per-ability numbers | `kit.ts`: ~30 exported constants (`BOLSTER`, `CHART`, `DROWNING`, …), re-exported one by one from `zone/index.ts` |
| Validation | `combat.ts` `checkAbility` (an if-chain over shape and flags) |
| Area / highlight | `combat.ts` `abilityArea` (an if-chain over flags) |
| Resolution | `combat.ts` `resolveAbility`: one if/else-if chain of 16 branches (4 on `main`), where order decides which flag wins |
| Cost, cooldown, Focus, starting a fight | `zone.ts` `act` → `"use"` |
| Conditions | the `Condition` union in `types.ts`; `SAVE_STAT` and `CONDITION_INFO` in `kit.ts`; special cases in `engine.ts` `addCondition`, `attackContext`, `defenceOf`, `damage` and `fall`; turn ticks in `zone.ts` `beginTurn`/`endTurn` and again in `clock.ts` `exploreRound`; `DEBUFFS` in `engine.ts` and a second `DEBUFFS` in `traits.ts` |
| Class passives | `unit.kind === "<class>"` checks in `combat.ts:348`, `combat.ts:395`, `zone.ts:186`, `zone.ts:326`, `clock.ts:38`, `kit.ts:479` |
| Per-class helpers | `weather.ts`, `song.ts`, `stars.ts`, `summon.ts`, `drowning.ts` (well scoped: keep these) |
| Client aiming | `ZoneView.tsx` branches on tactic flags in six places: overlays (997–1029), aim hint (1099–1104), aim arc (1128–1133), `choose` (1200–1205), click (1256–1280), tooltip `reachText` (1382); plus `joinTip` (133) hand-copies shanty numbers |
| Client art | `actionArt.ts`, `zone/actionIcons.ts`, `zone/abilityFx.ts` (keyed by id with fallbacks; fine) |

### Why it will not scale

1. **One ability is spread across 6–9 places.** A new class ability currently means a card in `content.ts`, a flag plus a constant in `kit.ts`, a branch in `checkAbility`, a branch in `abilityArea`, a branch in `resolveAbility`, sometimes new `Condition` members (with `SAVE_STAT` and `CONDITION_INFO` entries and hooks in `engine.ts`/`zone.ts`), a re-export in `index.ts`, and client branches in `ZoneView.tsx`. Leaving any of these out does not fail to compile. The ability just behaves wrongly.
2. **Flag soup with order-dependent precedence.** `Tactic` is a bag of optional fields, and `resolveAbility` picks the first branch whose flag is set. `chart_a_course` is shape `"blast"` but is caught earlier by `tactic.chart`. `revitalizing_splash` is a blast caught by `tactic.splash`. `fortify` is caught by `tactic.weather`. Put two flags on one ability and one of them is silently ignored. Reorder the branches and other abilities change behaviour.
3. **Damage is worked out differently on every path.** `strike` applies armorDamage, maxHpDamage, perDebuff, vsEffect, vsWet, wading, bulwark, bleedPayoff, finisher, drain, the Warlock's crit bleed, thorns, guide, ignites and surface. The `sure` path applies none of them. `sweep` applies only vsWet. Blasts apply vsEffect and vsWet. Constellation, New Moon and North Star apply none. Crates apply none. So adding `vsEffect` to a line or `maxHpDamage` to a blast silently does nothing.
4. **Conditions have no single home.** What a condition *is* (save stat, name, colour, harmful or not), what it *does* (to attack rolls, Defence, movement, damage dealt or taken, turn start and end, falling) and how it *stacks* are spread over five files. `beginTurn` and `exploreRound` repeat the same start-of-turn work and have already drifted apart (see bug B5).
5. **Class identity is hard-coded in the engine.** Five classes are special-cased by id string inside generic code.
6. **The client re-implements targeting.** It works out "what do I click next" from tactic flags in its own if-chains, which must be kept in step with `checkAbility` by hand.
7. **Blurbs repeat numbers that live in code.** For example, "for 4 turns" and "within 2 hexes" in `beacon_aura`'s blurb duplicate `TACTICS.beacon_aura.aura.rounds` and `AURAS.range`. `CONDITION_INFO` already templates some numbers from the constants. The cards do not.

---

## 2. Bugs found

Each one was reproduced with a scratch test unless marked *by reading*. Reproductions use the helpers at the top of `zone/zone.test.ts` (`board`, `hero`, `enemy`, `duel`, `must`, `unit`, `at`).

### B1. Focus is spent on abilities that roll nothing (confirmed)
`zone.ts:724-727` takes one Focus whenever `action.focus` is set. Focus only does something in `attackRoll` (advantage) and in `saveRoll` for blasts and lines (the target saves with disadvantage). The client sends `focus` whenever `ABILITIES[id].damage !== undefined` (`ZoneView.tsx:1181`). That covers sure-hit abilities with damage: Curse of Drowning, Constellation, New Moon, North Star. Focus is spent and nothing changes.
```ts
let { state, foe } = duel("bandit", "data_warlock");
unit(state, "ann").abilities.push("curse_of_drowning");
state = must(state, { type: "use", by: "ann", unit: "ann", ability: "curse_of_drowning", target: foe, focus: true });
// focus 2 -> 1, and no attack roll in the events
```
**Fix:** one shared predicate, `focusMatters(ability)`: true when the delivery is an attack roll or a save. The server ignores (or refuses) `focus` when it is false; the client uses the same predicate. Phase 6.

### B2. Tactical Retreat at a crate never moves the Rogue (confirmed)
`checkAbility` returns early for a crate target without checking `aim.at` (`combat.ts:279-285`). The crate branch of `resolveAbility` (`combat.ts:461-465`) never does the blink.
```ts
const state = board(); hero(state, "ann", "refactor_rogue", at(5, 6)); unit(state, "ann").abilities.push("tactical_retreat");
state.map.pois.push({ id: "c1", kind: "crate", pos: at(6, 6), hidden: false, cleared: false, usedBy: [], enemies: [], hp: 50, maxHp: 50 });
const next = must(state, { type: "use", by: "ann", unit: "ann", ability: "tactical_retreat", target: "c1", at: at(2, 6) });
// ann is still at(5,6); no "blinked" event
```
**Fix (now):** check the blink hex on the crate path too, and run the "then away" step after `smash`. **Fix (structurally):** in Phase 5 the after-effects (blink) run whatever the target was.

### B3. North Star sets fire from things that are not blows (confirmed)
`engine.ts:169-171` adds Burning on *any* `damage()` whose `actor` carries North Star. That includes a Coral Field cut (`weather.ts`, `actor: w.by`) and Coral Armor thorns (`actor: target.id`). The blurb says "every blow they land".
```ts
let { state, foe } = duel("bandit", "backend_druid");
unit(state, "ann").abilities.push("coral_field");
unit(state, "ann").conditions.push({ kind: "north_star", rounds: 3 });
state = must(state, { type: "use", by: "ann", unit: "ann", ability: "coral_field", at: unit(state, foe).pos });
// foe now has "burning"
```
**Fix:** give `damage()` a source kind (`"blow" | "spell" | "weather" | "thorns" | …`). North Star reacts to `"blow"` only (and `"spell"`, if that is the design: see Decisions). Phase 4.

### B4. Full Reckoning (and Show the Way) do not count the new conditions as harmful (by reading)
`engine.ts:85` `DEBUFFS` lists only the eight old conditions. Full Reckoning (`perDebuffDamage`, `combat.ts:382`) gets nothing for Drowning, the Black Spot, Red Sky, Guiding Light or Taunted on its target. Show the Way (`clearWay`, `combat.ts:637`) would not lift them from an ally either. Today only enemies carry those conditions, so the second half is latent, but a future enemy ability that lays them would expose it. `traits.ts:51` has a third, different `DEBUFFS`.
**Fix:** a `harmful: true` flag per condition in the condition registry, with `DEBUFFS` derived from it. Decide per condition (see Decisions). Phase 2.

### B5. Out of a fight, the Healing Aura heals nobody, though its rounds run down (confirmed)
`clock.ts` `exploreRound` repeats `beginTurn` by hand. It has Druid regen, Aqueous Regeneration, troll regen, bleeding and burning, but not the Healing Aura, nor Drowning's tick and save, nor shanty surge resets.
**Fix:** one turn-lifecycle module that both use (Phase 2). Whether each hook runs out of a fight becomes an explicit per-hook choice.

### B6. Opening a fight with an ability puts nothing on cooldown (confirmed; also on `main`)
`zone.ts:728` sets a cooldown only `if (budget && …)`, and `budget` is null out of a fight. A hero who opens with Falling Star (cooldown 3) on a band that has not noticed anyone starts the fight and can get a turn straight away with it ready again. The long class cooldowns make this matter far more than it did on `main`.
**Fix:** after `resolveAbility` and `engage`, if the user is now in a fight and the ability has a cooldown, set it (`cooldown + 1`, the same as an in-fight use). Phase 0.

### B7. Soothing Rain over an unaware band starts a fight (confirmed; design call)
`zone.ts:730` treats everything except `splash` as hostile. Rain only heals the caster's side. The comment two lines above calls a heal splashed among enemies "a kindness". Healing potions, Revitalizing Splash and Chart a Course already start nothing.
**Fix:** a `hostile` property on the ability (default true; false for rain, splash and chart). Phase 6.

### B8. Bulwark Strike stacks shield without limit out of a fight (confirmed; design call)
`addShield` adds to the existing shield, and out of a fight there is no cooldown and no Action cost. Six swings at a sturdy crate gave a Warden 30 shield. (Shields do wear off out of a fight, a round per 6 s, so this is a short-lived exploit.)
**Fix options:** cap the shield (for example at the larger of the existing shield and the new amount, plus `BULWARK.shield + level`), or only add Bulwark's shield in a fight. See Decisions.

### B9. In voyage battles, class abilities do nothing, or hurt your own side (confirmed)
`hero.ts` `heroCombatant` gives voyage combatants their class abilities. `battle.ts` `resolveAbility` only understands `damage`, `heal`, `targetEffect`, `selfEffect`, `perfect` and `actNext`, and it picks targets from the card's `target` field alone.
- **Your own side is hurt.** North Star's card is `target: "ally", damage: 9`, so in a voyage battle it *damages the ally* (confirmed: a `hit` of 5 on the crewmate). Constellation's card is `target: "self", damage: 5`, so it rolls its damage against the caster.
- **Nothing happens.** Bolster, Beacon Aura, Healing Aura, Soothing Rain, Trade Winds, Smuggler's Route, Sneak, Contraband, Coral Field, Coral Armor, the three Shanties, Chart a Course, Against the Waves, Fortify, Taunt, Summon Sea Turtle, Summon Sunken Sailors, the Black Spot, Red Sky, Unholy Waters and Overwhelm spend the turn and do nothing. `content.ts:193` acknowledges this for the two auras only.

Reproduction (in `packages/world/src`, importing from `./index`): build two `heroCombatant`s from `HeroSheet`s, a Sage (`weapon: "orb"`, `abilityLoadout: ["north_star"]`) and a Paladin `"b"`. Then `createBattle({ heroes, enemyKinds: [DUMMY_KIND], avgLevel: 1, poiId: "ring" }, makeRng(1))` and `stepBattle(state, "a", { type: "ability", ability: "north_star", target: "b" }, rng)` on the Sage's turn. The events hold `{ t: "hit", actor: "a", target: "b" }`.

**Fix:** mark each zone ability `voyage: false | true` and filter in `heroCombatant`. The alternative, giving them voyage meanings, is a design job. See Decisions. The filter goes in Phase 0 as a stopgap (a hand-written allowlist in `classabilities.ts`) and becomes data in Phase 8.

### Smaller things
- **S1.** `ai.ts:135` repeats line 134 with a weaker condition. Delete it.
- **S2.** A hero's `checkAbility` reach test uses `sees`, not `seesFor(state, unit.side, …)` (`combat.ts:275`). It is harmless while only heroes raise walls, and wrong as soon as an enemy can. The chain jump (`combat.ts:571`) is the same.
- **S3.** `joinTip` (`ZoneView.tsx:133`) hard-codes the shanty joining lifts and "+1" instead of reading `SHANTY` / `COMMON_ACTIONS.join`.
- **S4.** `checkAbility` for an `ally` ability accepts a downed ally. That is right for heals (Mend gets them up). For Coral Armor, Contraband and North Star on a downed ally, the condition is silently dropped (`addCondition` returns on `down`) while the Action and cooldown are still spent.
- **S5.** `inspireNearest` (`combat.ts:226`) can pick an ally who is not in the fight (or a summon). Probably fine; worth a line in the ability's own file once it has one.

---

## 3. Target architecture

The principle: **the engine never names a specific ability, condition or class.** Each of those is a self-contained definition that plugs into a few well-defined hooks. Adding one means adding one definition (and its test). Changing one means touching only its definition.

### 3.1 Condition registry (`zone/conditions/`)

```ts
// zone/conditions/types.ts
export interface ConditionDef {
  name: string;
  blurb: string;            // may be a template over this file's numbers
  color: string;
  save: StatKey;            // was SAVE_STAT
  /** Counts as a wound (Full Reckoning) and is lifted by a cleanse (Show the Way). */
  harmful?: boolean;
  /** Lifted as the bearer's turn starts, whatever rounds it has (guarded, taunting). */
  endsAtTurnStart?: boolean;
  /** Return false to refuse it (burning on the wet; slowed in a Wind-god's Shanty). */
  canApply?(ctx: Ctx, unit: Unit): boolean;
  /** After it is put on: wet puts out burning; on the bearer's own turn, hasted/slowed/prone change the budget. */
  onApplied?(ctx: Ctx, unit: Unit, c: UnitCondition, fresh: boolean): void;
  /** Start of the bearer's turn (in a fight) or of an explore round (out of one). */
  onTurnStart?(ctx: Ctx, unit: Unit, c: UnitCondition, mode: "fight" | "explore"): void;
  /** Its turn underway and the budget set (Drowning's breath, a course charted, the winds). */
  onBudget?(ctx: Ctx, unit: Unit, c: UnitCondition, budget: Budget): void;
  /** Stacks owed as the turn ends, counted before conditions run down (Drowning). */
  onTurnEnd?(ctx: Ctx, unit: Unit, c: UnitCondition): void;
  /** The bearer has fallen (the Black Spot passes on). */
  onFall?(ctx: Ctx, unit: Unit, c: UnitCondition): void;
  /** What it does to an attack: as the attacker, and as the target. */
  asAttacker?(state: ZoneState, attacker: Unit, target: Unit, opts: { melee: boolean }): AttackMod | null;
  asTarget?(state: ZoneState, attacker: Unit, target: Unit, opts: { melee: boolean }): AttackMod | null;
  /** Added to the bearer's Defence. */
  defence?(state: ZoneState | undefined, unit: Unit): number;
  /** The bearer has dealt damage (North Star) / has taken a blow (Coral Armor's thorns). */
  onDealt?(ctx: Ctx, bearer: Unit, target: Unit, hit: DamageInfo): void;
  onStruck?(ctx: Ctx, bearer: Unit, attacker: Unit, hit: DamageInfo): void;
}
export type AttackMod = { adv?: 1 | -1; mods?: number; note: string };
```

- `CONDITIONS: Record<Condition, ConditionDef>` is assembled from small files, one per family: `old.ts` (bleeding, burning, stunned, …), `ground.ts` (poisoned, prone, wet), `paladin.ts` (beacon, mending, bolstered), `rogue.ts`, `druid.ts`, `bard.ts` (re-using `song.ts`), `sage.ts` (re-using `stars.ts`), `warden.ts`, `warlock.ts` (re-using `drowning.ts`).
- `SAVE_STAT`, `CONDITION_INFO` and `DEBUFFS` stay exported, derived from `CONDITIONS`, so the client and the tests do not change.
- `addCondition`, `attackContext`, `defenceOf`, `damage` and `fall` become generic loops over the conditions on the involved units. `attackContext` keeps the conditions that are not about a condition at all (high ground, trees, dark, pack, shooting with an enemy beside you) as they are. They are about the board.
- The `Condition` type stays a string union in `types.ts`. A test checks that `Object.keys(CONDITIONS)` matches it exactly (a `satisfies Record<Condition, ConditionDef>` does this at compile time).

### 3.2 Turn lifecycle (`zone/turn.ts`)

One `startOfTurn(ctx, unit, mode)` and one `endOfTurn(ctx, unit, mode)`. `zone.ts` `beginTurn`/`endTurn` and `clock.ts` `exploreRound` call them. Order inside `startOfTurn` matches today's `beginTurn` exactly (cooldowns, `endsAtTurnStart` conditions, shanty surge reset, bleeding/burning ticks, class passives, condition `onTurnStart` hooks in a fixed order, enemy regen, `standInSurface`, Drowning), so the RNG order holds. Each hook says whether it runs in `"explore"` mode. Today's behaviour, where `exploreRound` skips some hooks, is reproduced exactly in Phase 2. Fixing B5 is then a one-line, deliberate change.

### 3.3 Class passives (`zone/passives.ts`)

```ts
export interface ClassPassive {
  /** Added to the damage of an ally's ability (Bard's tune), given the bearer and the ally. */
  allyDamage?(state: ZoneState, bearer: Unit, ally: Unit): number;
  onTurnStart?(ctx: Ctx, unit: Unit, mode: "fight" | "explore"): void;  // Druid regen
  onCrit?(ctx: Ctx, unit: Unit, target: Unit): void;                       // Warlock bleed
  onEnterFight?(ctx: Ctx, unit: Unit): void;                               // Warden guarded
  commonCost?(what: CommonAction): "action" | "bonus" | undefined;          // Rogue
}
export const CLASS_PASSIVES: Record<string, ClassPassive>;
```
The numbers stay in `content.ts` (`DRUID_REGEN`, `BARD_AURA`, `WARLOCK_BLEED_TURNS`), because voyage battles use them too.

### 3.4 Damage pipeline (`zone/damage.ts`)

```ts
export type DamageKind = "blow" | "spell" | "weather" | "thorns" | "surface" | "condition";
export interface DamageInfo { actor: string | null; what: string; kind: DamageKind; crit?: boolean; ignoreGuard?: boolean }

/** The dice and flat bonus of an ability, rolled once per use (a blast rolls once for everyone in it). */
export function rollAbilityDamage(ctx, user, ability, opts: { crit?: boolean }): number;
/** What one target takes of that roll: every per-target modifier, in one place. */
export function abilityDamageOn(ctx, user, ability, target, rolled): number;
```
- `abilityDamageOn` applies, in order, every modifier `strike` applies today (armorDamage, maxHpDamage, perDebuff, vsEffect, vsWet, wading, bulwark, bleedPayoff, finisher), plus Chorus. Every path calls it, so a modifier set on any ability works whatever its shape. **This deliberately changes behaviour** for paths that skip modifiers today. Only abilities whose data has a modifier that their path ignores are affected. Run the golden tests, list exactly what changed, and confirm each change is the intended uniform rule. Put that list in the commit message.
- `engine.ts` `damage(ctx, target, amount, opts)` gains `opts.kind`, defaulting to `"blow"` so existing callers and tests keep working. Weather passes `"weather"`, thorns `"thorns"`. `onDealt`/`onStruck` condition hooks receive it.
- The guarded/shield/fall logic stays in `engine.ts` `damage`.

### 3.5 Zone abilities (`zone/abilities/`)

Each ability's whole zone behaviour lives in one definition, in a file per class (plus `weapons.ts` and `summons.ts`).

```ts
// zone/abilities/types.ts
export interface ZoneAbility {
  id: string;                      // key into content.ts ABILITIES (the card)
  cost: "action" | "bonus";
  cooldown?: number;
  aim: Aim;                        // how it is aimed: §3.6
  delivery: "attack" | "save" | "sure" | "none";
  /** Using it on a band that has noticed nobody starts a fight. Default true. */
  hostile?: boolean;
  /** Can be used in a voyage battle (battle.ts understands it). Default false for class abilities. */
  voyage?: boolean;
  /** Before any target is resolved (Bulwark's shield goes up before the swing). */
  before?: Step[];
  /** For each unit it gets through to: hit (attack), failed the save (save), or simply reached (sure, none). */
  onHit?: Step[];
  /** For each unit that saved (save delivery): what still happens. Damage halves without saying so. */
  onSave?: Step[];
  /** Once, after every target: ground, weather, a summon, the user moving. Runs whatever was aimed at (a crate too). */
  after?: Step[];
  /** Extra validity, after the aim's own check. */
  check?(state: ZoneState, unit: Unit, aim: AimInput): string | null;
  /** A wholly bespoke resolution (Constellation, Chart a Course, a Shanty). When present, delivery/onHit/after are not used. */
  resolve?(ctx: Ctx, use: Use): void;
}

/** One thing an ability does. Built by small factory functions; the pipeline only ever calls `run`. */
export interface Step { run(ctx: Ctx, use: Use, target?: Unit): void }

/** Everything about one use, handed to every step: who, with what, aimed where, and what has happened so far. */
export interface Use {
  user: Unit; ability: ZoneAbility; card: AbilityDef; aim: AimInput;
  area: HexPos[];                // what the aim covers
  rolled?: number;               // the shared damage roll, once made
  landed: boolean;               // anything got through (selfEffect hangs on this)
  wasUnseen: boolean;
  hit?: { crit: boolean; saved: boolean };  // set for the current target while onHit/onSave run
}
```

Steps are **functions, not a growing union.** A new mechanic is a new factory in `zone/abilities/steps/*.ts`, used by the abilities that need it. Nothing central gets a new branch. For example:

```ts
// zone/abilities/steps/core.ts
export const dealDamage = (): Step => ({ run: (ctx, use, t) => { /* abilityDamageOn(...); halved if use.hit.saved; damage(..., { kind: use.ability.delivery === "attack" ? "blow" : "spell" }) */ } });
export const cardEffects = (): Step => /* afflict(): card.perfect / card.targetEffect, as today */;
export const condition = (kind: Condition, rounds: number, opts?: { on?: "target" | "user"; amount?: number; by?: boolean; afresh?: boolean }): Step => …;
export const surfaceUnder = (kind: SurfaceKind, rounds: number): Step => …;    // per target
export const surfaceOver = (kind: SurfaceKind, rounds: number): Step => …;     // over use.area, in `after`
export const igniteUnder = (): Step => …;  export const igniteOver = (): Step => …;
export const knockback = (hexes: number): Step => …;
// zone/abilities/steps/movement.ts: blinkAfter(), blinkWithAlly(range)
// zone/abilities/steps/shields.ts: shieldAround(range, amount, rounds, water?), addShieldToUser(amount, rounds)
// … one file per family, re-using weather.ts / song.ts / stars.ts / summon.ts / drowning.ts
```

and an ability reads like its blurb:

```ts
// zone/abilities/warlock.ts
export const curse_of_drowning: ZoneAbility = {
  id: "curse_of_drowning", cost: "bonus", cooldown: 3,
  aim: enemyAt({ reach: "spell", range: 5 }),
  delivery: "sure",
  onHit: [dealDamage(), cardEffects(), layCurse("drowning_curse", DROWNING_CURSE.rounds)],
};
export const unholy_waters: ZoneAbility = {
  id: "unholy_waters", cost: "bonus", cooldown: 2,
  aim: blastAt({ range: 5, radius: 1 }),
  delivery: "none",
  after: [unholyFlood(UNHOLY_WATERS)],   // the existing branch body, moved, unchanged
};
```

`resolveAbility` becomes a short, generic pipeline:

```
push "used" event
if ability.resolve: ability.resolve(ctx, use) → skip to the tail
run `before`
if aimed at a crate: smash it (shared code), landed = true
else for each target from aim.targets(state, user, aim), in the aim's order:
   attack → attackRoll; hit → onHit (and thorns if melee); miss → "miss" event
   save   → saveRoll (Focus = disadvantage); onHit if failed, onSave if saved
   sure / none → onHit
crates in the area take the shared roll (when the ability does damage and the user is a hero)
run `after`
tail: card.selfEffect if landed; give the user away if they were Unseen (unless a step said not to)
```

The steps must reproduce today's RNG order. Where today's branch interleaves differently (Tidal Wave sweeps the far ones first; New Moon clears every light before any damage), the aim's `targets()` order or a bespoke `resolve` keeps it. When in doubt, use `resolve` with the old branch body moved in verbatim. That is still a big win: the code then lives with its ability, and the central chain is gone.

`TACTICS` and `tacticOf` stay as a compatibility view (cost, reach, range, shape, cooldown, radius) generated from the registry, so `Hud.tsx`, `abilityFx.ts`, `reactionStrike`, `crateBlow` and the tests keep working until each caller moves to the registry.

### 3.6 Aim (targeting) strategies (`zone/abilities/aim.ts`)

```ts
export interface Aim {
  /** How the client takes the aim: what each click picks. Drives ZoneView (Phase 7). */
  flow: AimFlow;   // "none" | "enemy" | "ally" | "hex" | "direction" | "enemy-then-hex" | "ally-then-hex" | "hex-any" (Chart: unseen hexes allowed)
  reach: "melee" | "ranged" | "spell";
  range: number;
  check(state: ZoneState, unit: Unit, aim: AimInput): string | null;
  area(state: ZoneState, unit: Unit, aim: AimInput): HexPos[];
  targets(state: ZoneState, unit: Unit, aim: AimInput, area: HexPos[]): Unit[];
  /** Crates: aimed at directly (single), caught in the area (blast/line/adjacent), or never. */
  crates: "target" | "area" | "none";
  /** The tooltip's reach line ("an enemy beside you", "a hex up to 8 off"). */
  describe(): string;
}
```
Factories: `enemyAt({reach, range})`, `chainFrom({range, jumps, hop})`, `allEnemiesBeside()`, `burstAround(radius)`, `blastAt({range, radius, who: "everyone"|"foes"})`, `lineFrom({length, who})`, `allyAt({range})`, `self()`, `hexAt({range, seen: boolean, room: "stand" | "summon" | "wall"})`, plus bespoke ones next to their ability (Constellation's links, North Star's ring round an ally, Fortify's wall, Rain's cloud, Splash's cluster). `checkAbility` and `abilityArea` keep their exported signatures and delegate to `aim.check`/`aim.area` plus `ability.check`.

### 3.7 Card and numbers co-location (optional, last)

Today the card lives in `content.ts` and the numbers in `kit.ts`. Once behaviour is per class, move each class ability's numbers (`BOLSTER`, `CHART`, …) into that class's zone ability file, and write the card's blurb as a template over them so they cannot drift. To avoid import cycles (`content.ts` → class file → `zone/engine.ts` → `content.ts`), put the card and its numbers in a pure-data file with no runtime imports (`packages/world/src/abilities/<class>.data.ts`), imported by both `content.ts` and `zone/abilities/<class>.ts`. Do this only after Phase 5 is done and green.

---

## 4. The plan

Each phase is independently shippable. Do them in order. Inside a phase, migrate in small steps and run the tests after each.

### Phase 0: Bugs that do not need the refactor (small, do first)

1. **B6** cooldown on a fight-opening use: in `zone.ts` `act` (`"use"`), after `engage`/`reachIn`, add: if `!budget && tactic.cooldown && inFight(state, unit.id)`, set `unit.cooldowns[ability] = tactic.cooldown + 1`. Test: Falling Star at an unaware band at range; afterwards the fight is on and `cooldowns.falling_star === 4`.
2. **B2** Tactical Retreat at a crate: in `checkAbility`'s crate path, return `inReach(crate.pos) ?? (tactic.blink && aim.at ? blinkWrong(...) : null)`. In `resolveAbility`'s crate branch, after `smash`, run the same "then away" block the single branch runs (move that block into a small `blinkAfter(ctx, unit, tactic, aim)` helper and call it from both). Test: the reproduction in B2 ends with the Rogue on `at(2, 6)` and a `blinked` event.
3. **B1** Focus: add `export function focusMatters(ability: string): boolean` to `combat.ts`. It mirrors which branch of today's `resolveAbility` the ability reaches, and is true only for the branches that pass `focus` on to a roll:
   - **false** if the tactic has any of `weather`, `splash`, `summon`, `chart`, `constellation`, `newMoon`, `redSky`, `unholy` (each is caught before the shape branches), or `sure` or `overwhelm` (single, no attack roll), or the shape is `ally`, `self` or a `blink` self.
   - **true** for `single` (via `strike`), `adjacent`, `chain`, `sweep`, and the generic `blast`/`burst`/`line` branch (the save is rolled with disadvantage).
   - Pickpocket used Unseen spends Focus for nothing. That depends on state, so leave it.

   The server: `const aim = { …, focus: !!action.focus && focusMatters(action.ability) && !isCrateId(…) }`. The client: `ZoneView.tsx:1181` uses `focusMatters`. Export it from `zone/index.ts`. Tests: B1's reproduction keeps both Focus; Firebolt with Focus still spends one and rolls with advantage; Meteor with Focus spends one and the saves are rolled with disadvantage.
4. **B9 stopgap:** in `classabilities.ts` add `export const VOYAGE_CLASS_ABILITIES: ReadonlySet<string>`, the class abilities whose card `battle.ts` runs correctly (see Phase 8 for the review). `heroCombatant` filters `classAbilitiesOf(...)` by it. North Star and Constellation must **not** be in it. Test: a Sage with `["north_star", "falling_star", null]` has only `falling_star` added in a voyage battle and both in a zone.
5. **S1** delete `ai.ts:135`.
6. Commit: "Fixes: a fight-opening ability goes on cooldown; Tactical Retreat at a crate retreats; no Focus spent where there is no roll; voyage battles get only the class abilities they can run".

### Phase 1: The safety net (golden characterization tests)

Do this before any structural change. It is what makes the later phases safe.

1. New file `packages/world/src/zone/abilities.golden.test.ts`. For **every** id in `TACTICS`:
   - Build a fixed board (reuse `board`, `hero`, `enemy` from `zone.test.ts`. Move those helpers into `zone/testkit.ts` and import them from both files; that is a pure move). On it: the user (a hero of the class whose pool or weapon has the ability, or a Paladin if none, with the ability added to `abilities`), an ally adjacent, a second ally 3 hexes off, three enemies of kind `"dummy"` with `hp = maxHp = 500` at distances 1, 3 and 4 in a rough line, water painted under the far enemy, oil under the middle one, a crate 2 hexes off. `aiOff = true`, a fight started with `provoke`, the turn order forced so the user's side acts (copy the `party()` pattern from `describe("the Warden's wall")`).
   - Try a fixed list of aims: `{}`, `{target: self}`, `{target: ally}`, `{target: enemy@1}`, `{target: enemy@3}`, `{target: crate}`, `{at: enemy@3.pos}`, `{at: empty hex 3 off}`, `{target: enemy@1, at: empty hex 3 back}`, `{target: ally, at: empty hex 3 off}`.
   - For each: record `checkAbility(...)`, `abilityArea(...)`, and the `stepZone` result: either `{error}` or `{events, units: units.map(u => ({id, pos, hp, down, conditions, cooldowns, focus, items})), surfaces, weather, encounter: {acting, done, budgets}}`. `expect(record).toMatchSnapshot()`.
   - Run with two seeds (set `state.rng`).
2. A second golden test for the turn lifecycle: one unit carrying every condition kind (with plausible `amount`/`at`/`by` data), on water, inside rain, wind and coral weather, with a shanty-singing Bard ally. Snapshot the events and state over: (a) three fight rounds (`timeout` actions), (b) three `exploreRound`s via `time` actions out of a fight.
3. Commit the snapshots. From here on, a snapshot diff means behaviour changed. Every intended change is listed in its commit message.

### Phase 2: Conditions registry and one turn lifecycle

1. Create `zone/conditions/types.ts` (§3.1) and the family files. Start with only `name`, `blurb`, `color`, `save` and `harmful`, taken from `SAVE_STAT` and `CONDITION_INFO`. Derive `SAVE_STAT`, `CONDITION_INFO` and `DEBUFFS` from it, keeping their names and export locations (`kit.ts`, `engine.ts`). Tests green, snapshots identical.
   - For `harmful`, **keep today's set** (`DEBUFFS` = the eight) in this step, so snapshots are unchanged. B4 is a separate step (5 below).
2. Move the special cases into hooks, one condition at a time, running tests after each:
   - `addCondition`: burning/wet (`canApply`, `onApplied`), slowed/windward (`canApply`), hasted/slowed/prone budget changes (`onApplied` with `fresh` = it is the bearer's own turn).
   - `attackContext`: exposed, stunned, prone (melee), invisible, inspired, guiding_light, beacon (range aura: `asAttacker` looks at allies), poisoned, glitched, black_spot, red_sky, prone (ranged). **Keep the order the notes are pushed in** (the tooltip shows them in order).
   - `attackRoll`'s clearing of glitched and inspired: a `consumedOnAttack?: boolean` field.
   - `defenceOf`: coral_armor (`defence`). The shanty and wall terms stay (they are about the board).
   - `damage`: North Star → `onDealt` on north_star. `strike`'s `thorns` → `onStruck` on coral_armor, called from the blow path (melee only, as now).
   - `fall`: the Black Spot → `onFall`.
3. Create `zone/turn.ts` with `startOfTurn(ctx, unit, mode)` / `endOfTurn(ctx, unit, mode)`. Move `beginTurn`'s pre-budget part and `exploreRound`'s body into it, with per-hook `explore` flags that reproduce **today's** behaviour exactly (the snapshot from Phase 1 step 2 must not change). Bleeding/burning ticks become `onTurnStart` on those conditions; mending, regenerating, drowning and drowning_curse likewise; `guarded` and `taunting` get `endsAtTurnStart`; `stunned` is handled where `beginTurn` handles it now (out of a fight, `exploreRound` just removes it: keep that).
4. Run the tests. Commit "Conditions: each is defined in one place".
5. **B4 and B5, deliberately:** set `harmful: true` on drowning, drowning_curse, black_spot, red_sky, taunted and guiding_light (see Decisions), and turn on the Healing Aura's `explore` flag. Update the snapshots, add focused tests (Full Reckoning counts the Black Spot; the Healing Aura heals an ally out of a fight). Separate commit.

### Phase 3: Class passives

1. Create `zone/passives.ts` (§3.3) with entries for `frontend_bard` (`allyDamage`, range `BARD_AURA_RANGE`, which moves here from `combat.ts`), `backend_druid` (`onTurnStart` regen, both modes), `data_warlock` (`onCrit`), `sre_warden` (`onEnterFight`) and `refactor_rogue` (`commonCost`).
2. Replace the six `kind === "<class>"` sites with lookups. `commonCost(what, classId)` keeps its signature.
3. `grep -n 'kind === "\(qa_paladin\|devops_mage\|refactor_rogue\|backend_druid\|frontend_bard\|staff_sage\|sre_warden\|data_warlock\)"' packages/world/src/zone/*.ts` returns nothing outside `passives.ts` and tests. Commit.

### Phase 4: Damage pipeline and damage kinds

1. Add `DamageKind` and `kind` to `damage()` opts (default `"blow"`). Pass `"weather"` from `weather.ts`, `"thorns"` from the thorns hook, and `"spell"` from the save/sure paths in `resolveAbility`.
2. North Star's `onDealt` reacts to `kind === "blow"` (and `"spell"`, if that is the decision: see Decisions). B3's reproduction gets a test. Snapshot diffs: only North Star with weather or thorns. Commit.
3. Create `zone/damage.ts` (§3.4). First make `strike` use `rollAbilityDamage` + `abilityDamageOn` with no change in output. Then switch the other paths (sure, sweep, blast/burst/line, constellation, new moon, north star, crates) to it. Snapshot diffs show exactly which abilities' numbers change; check each is "a modifier in its data that its path used to ignore". As of this writing there should be none or nearly none, because data and paths happen to line up. If something else changes, stop and look. Commit, listing the diffs.

### Phase 5: Zone abilities as definitions (the big one)

Do it **one class at a time**, with a compatibility shim so old and new co-exist:

1. Create `zone/abilities/types.ts`, `aim.ts`, `steps/*.ts` and `registry.ts` (`ZONE_ABILITIES: Record<string, ZoneAbility>`, empty at first) and `pipeline.ts` (§3.5). In `combat.ts`:
   - `checkAbility`: if `ZONE_ABILITIES[id]` exists, return `aim.check(...) ?? ability.check?.(...) ?? null` after the shared "you do not have that ability" check; otherwise the old code.
   - `abilityArea`: likewise, `aim.area`.
   - `resolveAbility`: likewise, `runAbility(ctx, unit, ability, aim)` from `pipeline.ts`.
   - `tacticOf(id)`: if in the registry, a `Tactic` built from it (cost, reach, range, shape from `aim.flow`, radius/length if any, cooldown). Otherwise `TACTICS[id]`.
2. Migrate `weapons.ts` first (all the weapon abilities: punch, torch_swing, smite, cleave, …). They are the most uniform and exercise the generic pipeline: `enemyAt` + `"attack"` + `[dealDamage(), cardEffects(), …]`; cleave = `allEnemiesBeside()`; chain_spark = `chainFrom`; thunderhead/overgrowth/meteor/blight = `blastAt` + `"save"`; riptide/lighthouse_beam = `lineFrom`; cacophony = `burstAround`; mend/rejuvenate/encore/all_hands = `allyAt` + `"none"` + `[healStep(), cardEffects(), actNextStep()]`; shield_wall/arcane_ward/hold_the_line = `self()`. Snapshots must not change.
3. Then one commit per class, in this order (simplest first): Paladin, Mage, Druid, Rogue, Warden, Warlock, Bard, Sage, then `summons.ts` (turtle_bite, sailor_pistol, sailor_scimitar). For each:
   - Write the definitions. For anything bespoke, start with `resolve` holding the old branch body verbatim. Refine to steps only where it is clearly the same behaviour.
   - Delete that class's branches from `checkAbility`, `abilityArea` and `resolveAbility`, and its fields from `Tactic` once no `TACTICS` entry uses them.
   - Snapshots identical; full suites green; commit.
4. When every ability is in the registry: delete the old branches, slim `Tactic` down to the compatibility view, and make `TACTICS` a generated `Record<string, Tactic>`. `zone.test.ts`'s "has a tactical entry for every ability" becomes "every card has a zone ability, and every zone ability has a card" (keep the test's name).
5. Add a **contract test** `zone/abilities/contract.test.ts`: for every ability in the registry, `aim.flow` is consistent with `delivery` (for example, `"none"` flow has no per-target delivery other than self or area), `hostile === false` only where no step harms, `focusMatters` equals `delivery ∈ {attack, save}`, `describe()` is non-empty, and the card exists with the same id.

### Phase 6: The `use` action

In `zone.ts` `act` → `"use"`:
- Starting a fight: `const struck = ability.hostile === false ? [] : …` (replaces `tactic.splash ? [] :` and `tactic.chart ? [] :`). Set `hostile: false` on soothing_rain, revitalizing_splash and chart_a_course (**B7**; see Decisions).
- Focus: `focusMatters` reads `delivery` (replacing Phase 0's shape heuristics).
- Cooldown (Phase 0 fix) reads `ability.cooldown`.
- Move cost/cooldown/Focus/engage into `pipeline.ts` `useAbility(ctx, unit, id, aim, budget)` if it makes `act` shorter. Keep `reachBack`/`reachIn` calls in `zone.ts` (they are about the encounter, not the ability).

### Phase 7: Client reads the aim instead of the flags

In `apps/game/src/client/ZoneView.tsx`:
1. `choose(ability)`: fires at once iff `aim.flow === "none"`.
2. Click handling: one `switch (aim.flow)`. `"enemy-then-hex"` and `"ally-then-hex"` are the two-click blinks (today keyed on `tactic.blink` + shape).
3. Overlays: the range ring is `within(aim.reach === "melee" ? 1 : aim.range, aim.flow !== "hex-any")`; the area is `abilityArea(...)`; the blink and summon cases become flows.
4. `aimHint` and the aim arc read `aim.flow`.
5. `reachText` is `aim.describe()` (written in the world package, next to each aim). Delete the 400-character ternary.
6. `joinTip` reads `SHANTY` and `COMMON_ACTIONS.join` (**S3**).
7. Export `ZONE_ABILITIES` (or `zoneAbility(id)`) and the `AimFlow` type from `zone/index.ts`. Drop the per-constant re-exports the client no longer uses.
8. `cd apps/game && npx vitest run && npx tsc --noEmit`. If a run skill or dev server is available, try each class's five abilities on the dev map (the Maps tab can give a hero any class's abilities). Commit.

### Phase 8: Voyage battles (**B9**)

1. `voyage?: boolean` on `ZoneAbility` (§3.5), replacing Phase 0's `VOYAGE_CLASS_ABILITIES`. Set `true` only for class abilities whose card works in `battle.ts` as written: the card's `target` must name who it should hurt or help (`battle.ts` damages whoever `target` picks, ally or not), and it must have `damage`, `heal` or `targetEffect`/`selfEffect` and no zone-only mechanic the voyage would miss. Candidates: branding_strike, stoke_the_fire, chain_lightning, roar_of_thunder, tidal_wave, pickpocket (damage only), tactical_retreat, aqueous_regeneration (heal only), revitalizing_splash (heal only), chorus, lead_by_example, falling_star, bulwark_strike, curse_of_drowning (damage + slowed). New Moon (`all_enemies`, 15 damage, with no Guiding Light to need) would be far too strong there: leave it out. North Star and Constellation must stay out (they hit the caster's own side, B9). Review each against `battle.ts` `resolveAbility`.
2. `classAbilitiesOf(classId, level, loadout, pools, { mode: "voyage" })` filters by `voyage`. `heroCombatant` passes it. `zoneHero` does not. Add a test that runs every `voyage: true` class ability once in a voyage battle and asserts that no `hit` event targets the user's own side.
3. Update `classabilities.test.ts`. The Harbor UI (`InventoryScreen.tsx`) can mark slots "map fights only". Small, optional.

### Phase 9: Tidy-up

1. **S2:** `checkAbility` reach and chain hop use `seesFor(state, unit.side, …)`.
2. **S4:** ally aims refuse a downed ally unless the ability heals (`allyAt({ range, downed: "heal-only" })`).
3. Blurb drift: either template class-ability blurbs from their numbers (§3.7), or add a test that, for each class ability, every number in its `numbers` record that a blurb should quote appears in the blurb. Templating is better.
4. Split `zone/zone.test.ts` (4,000 lines) into `zone/test/*.test.ts` by topic (one per class for abilities), importing `zone/testkit.ts`. Pure moves.
5. Write `docs/abilities.md`: "How to add an ability" (card in content.ts, definition in `zone/abilities/<class>.ts`, any new condition in `zone/conditions/<family>.ts`, icon in `actionIcons.ts`/`actionArt.ts`, pool entry, a test file) and "How to add a mechanic" (a new step factory or condition hook; never a new branch in the pipeline).

---

## Decisions made without the user (flag these in the PR)

The user was not available. These are the choices this plan makes. Each one is isolated to a single commit so it can be reverted.

| # | Question | Plan's choice | Why |
|---|---|---|---|
| D1 | Which new conditions count as harmful (Full Reckoning, Show the Way)? | drowning, drowning_curse, black_spot, red_sky, taunted, guiding_light | Each one hurts or hinders its bearer. `inspired`, `north_star`, `charted`, shanties, `contraband`, `regenerating`, `coral_armor`, `bolstered`, `beacon`, `mending` and `invisible` help it. `wet` stays out (as now). |
| D2 | Does North Star fire on spell damage (blasts, Constellation, New Moon) as well as blows? | Blows **and** spells, but not weather, thorns, ground or ticks | It keeps today's behaviour for everything a player aims and removes only the surprising cases (B3). Make it blows-only if the blurb's "blow" was meant literally. |
| D3 | Does Soothing Rain start a fight? | No (`hostile: false`), like a healing potion and Revitalizing Splash | It matches the comment at `zone.ts:729` and the splash precedent. |
| D4 | Bulwark Strike shield stacking (B8) | Not fixed in this plan | It is a balance call. A one-line cap is easy once decided. |
| D5 | Class abilities in voyage battles (B9) | Filter out the ones `battle.ts` cannot run | Silent no-ops that spend a turn are worse than not offering them. |
| D6 | Healing Aura out of a fight (B5) | Heals, like Druid regen and Aqueous Regeneration do | It is consistent with the other heals over time. |

## Out of scope (noticed, not part of this plan)

- Class traits (`traits.ts`) are not applied in zone fights at all, only in voyage battles. This is older than this branch.
- `chartedReach` (`geometry.ts`) runs a Dijkstra over (hex, course-left) pairs with an O(n²) frontier. That is fine at today's map sizes; it would need a heap if maps grow.
