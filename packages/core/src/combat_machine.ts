// Web-mode turn-based combat state machine.
//
// Slack combat is cooldown-paced and stateless per /sq command — this module
// is NOT used there. The Slack worker continues to use the helpers in
// combat.ts directly.
//
// This machine is for the web app: rolled initiative, strict turn order, one
// action at a time, with each step emitting a stream of events that the UI
// animates (dice landing, damage chip-down, monster strike, victory).
//
// Pure: no D1, no fetch, no time. RNG is injected so tests are deterministic
// and the QuestRoom Durable Object can persist state confidently across
// hibernation.
//
// Reuses the math in combat.ts (resolvePlayerHit, resolveMonsterHit, etc.) so
// damage formulas stay identical to Slack.

import {
  applyDamageWithShield,
  isBossPhaseTransition,
  pickMonsterTarget,
  resolveHeal,
  resolveMonsterHit,
  resolvePlayerHit,
  type BattlePosition,
} from "./combat";
import {
  GRID_DEFAULT,
  allHexesInGrid,
  hexDistance,
  hexDisk,
  hexLos,
  hexNeighbors,
  hexPath,
  hexReachable,
  initialHexPositions,
  defaultMonsterMoveRange,
  placeMonsters,
  generateObstacles,
  generateLootTiles,
  lootTileGold,
  lootTileItemTier,
  obstaclePositions,
  deriveMoveRange,
  deriveRangeTiles,
  inBounds,
  posKey,
  type HexGrid,
  type HexPos,
  type LootKind,
  type LootTile,
  type MonsterSpecial,
  type Obstacle,
  type GroundEffect,
  type GroundEffectKind,
} from "./hex";
import {
  ELEMENT_META,
  ELEMENT_PROC_RATE,
  SHIELD_CAP_MULTIPLIER,
  classByName,
  type AbilityId,
  type DamageType,
  type DrinkBuff,
  type EffectType,
  type ElementType,
  type Rarity,
  type WeaponRange,
} from "./flavor";
import { type AbilityContext, type AbilityEffect, type ActiveAbilityDef, type AllyNpcSpec, type PassiveAbilityDef } from "./abilities";
import { ALL_TALENT_NODES } from "./abilities/tree";
import { deriveArmorBonus, deriveCritBonus, deriveDodgeChance, deriveInitiativeBonus, type AffixEffects, type Stats } from "./stats";

export type ActorId = string;

export const MONSTER_ID: ActorId = "__monster__";
export const isMonsterActor = (id: ActorId): boolean => id === MONSTER_ID || id.startsWith("__monster_");
// Merc IDs are "__merc_<hiring_user_id>__". Auto-resolved by the server; never
// sent by web clients directly.
export const isMercActor = (id: ActorId): boolean => id.startsWith("__merc_");
// Ally NPC IDs: "__merc_*" (hired mercs) or "__ally_*" (ability-summoned NPCs).
// Use isAllyNpcActor for all combat turn dispatch; use isMercActor only for
// merc-specific logic (hire/dismiss, reward filtering).
export const isAllyNpcActor = (id: ActorId): boolean => id.startsWith("__merc_") || id.startsWith("__ally_");

export interface MachineStatusEffect {
  type: EffectType;
  magnitude: number;
  remaining: number;
  source?: string;
  // Display string rendered verbatim in the status pill suffix (e.g. "30% break").
  // Only set for effects that need custom pill text; others fall back to "${remaining}t".
  pill_suffix?: string;
}

// Snapshot of a party member at combat start. Loaded from D1 once when the
// quest enters web combat mode; the machine mutates this in place across
// turns. Equipment-derived numbers (weapon_power, armor_power, etc.) are
// frozen here so combat doesn't have to re-resolve inventory mid-turn.
export interface CombatFighter {
  id: ActorId;             // user_id
  name: string;
  class: string;
  level: number;
  // Slack display handle ("josh"). Snapshot at combat start; null if the
  // player hasn't issued a slash command since the column was added.
  slack_username?: string | null;
  hp: number;
  max_hp: number;
  mana: number;
  max_mana: number;
  shield: number;
  // Hex grid position (axial coordinates). Populated by createCombatState()
  // and updated by move actions. Optional for backward compat with serialized
  // states that pre-date the tactical grid.
  pos?: HexPos;
  // Legacy front/back position — kept for Slack combat and old serialized
  // states. In hex combat, `pos` is the authoritative position.
  position: BattlePosition;
  attack_mod: number;
  magic_mod: number;
  // weapon_power contributes to attack/cast/sig damage. For melee/ranged this is
  // the full item power; for focus weapons it is floor(item_power/4) — enough to
  // make attacks functional without competing with melee/ranged damage output.
  weapon_power: number;
  focus_power: number;
  // Equipped weapon range. Used to gate back-row attack (only ranged/focus
  // can melee from the back row in a party fight).
  weapon_range: WeaponRange;
  armor_power: number;
  damage_roll?: string;
  initiative: number;      // rolled at begin
  effects: MachineStatusEffect[];
  scars: string[];         // battle scars from defeats
  // Primary stats (Phase 1 / STATS_V2). Present when the flag is on; absent
  // on legacy combats so older persisted states deserialise without a schema bump.
  stats?: Stats;
  // Elemental weapon affinity. undefined = no element or focus weapon.
  element?: ElementType;
  // Rarity of the equipped main-hand weapon. Used to gate proc rates.
  weapon_rarity?: "uncommon" | "rare" | "epic" | "legendary";
  // Summed gear resistance by damage type. Capped to 0–75 at combat init.
  // Absent keys = 0% resistance. physical is included but not used (armor handles it).
  resistances?: Partial<Record<DamageType, number>>;
  // Talent-tree passive node ids the player has equipped this combat. Lets
  // hooks like fighterHasPassive() pick up tree passives that aren't part of
  // the static class kit (Cherry-Pick, Static Analysis, etc.). Optional for
  // backward compat — legacy combats and Slack init leave it undefined and
  // only kit passives apply.
  equipped_passive_ids?: string[];
  // Talent-tree owned rank per ability id (covers both kit abilities and
  // tree-only nodes). The cast handler reads this to set ctx.rank so
  // rank-aware execute() branches fire. Undefined = treat all abilities as
  // rank 1 (legacy combats, fresh characters who haven't bought any ranks).
  talent_ranks?: Record<string, number>;
  // Gear-affix effects (design doc: docs/gear-affixes-and-uniques.md).
  // Summed from all equipped items at combat init; frozen for the encounter.
  // Each field is the magnitude that combat hooks read:
  //   crit_pct adds to crit chance; lifesteal heals on damage dealt;
  //   *_dmg flat-adds to the matching elemental damage line; resist_*
  //   reduces incoming damage of that type; thorns reflects on melee
  //   taken; mana_regen ticks each turn; dodge_pct adds to dodge.
  // Absent keys default to 0 — legacy combats and pre-affix items work unchanged.
  affix_effects?: AffixEffects;
  // Equipped legendary unique-effect ids (UNIQUE_REGISTRY keys). Combat hooks
  // dispatch these at named lifecycle points (onCritHit, onTakeDamage, etc.).
  unique_ids?: string[];
  // Active set bonuses keyed by set_id, with the highest piece-count
  // threshold currently active (2 / 4 / etc.). Drives the set bonus
  // dispatcher in the equip aggregator.
  active_sets?: Record<string, number>;
}

export interface GauntletWaveSpec {
  name: string;
  max_hp: number;
}

export interface CombatMonster {
  id: ActorId;
  name: string;
  hp: number;
  max_hp: number;
  // Depletable armor pool. Physical player attacks deplete it before hitting HP;
  // cast/signature/magic attacks bypass it entirely. Starts at `tier` by default.
  shield: number;
  tier: number;
  initiative: number;      // rolled at begin
  effects: MachineStatusEffect[];
  is_boss: boolean;
  boss_phase: 1 | 2;
  // Hex grid position. Populated by createCombatState() from initialHexPositions.
  // Optional for backward compat with serialized states that pre-date the grid.
  pos?: HexPos;
  // Hexes the monster can move per turn. Defaults to min(5, 2 + tier) at combat init.
  move_range?: number;
  // Computed attack range in hexes. Defaults based on weapon_range (melee=1, ranged=4, focus=3).
  range_tiles?: number;
  // Anti-kite special abilities. Empty for basic monsters.
  specials?: MonsterSpecial[];
  // Gauntlet wave state. Set only when the quest variant is "gauntlet";
  // undefined for standard / boss combats. `wave` is 1-indexed. On the
  // current monster's death, the engine pops the next entry from
  // `upcoming_waves` and continues combat (same turn order + initiative)
  // instead of emitting victory. Combat ends only when all waves are
  // cleared.
  wave?: number;
  total_waves?: number;
  upcoming_waves?: GauntletWaveSpec[];
  // Tower-only display value (absolute floor 1, 2, … 11, 12, …). Set when
  // the quest variant is "tower" so the combat header can render
  // "Floor N · Cycle M". The engine doesn't use it for any mechanics; it's
  // pure pass-through to the UI.
  tower_floor?: number;
  tower_cycle?: number;
  // Optional flux-1-schnell portrait URL from the scene. Surfaced to the UI
  // so the combat page can render the same image as the active-quest card.
  art_url?: string;
  // Elemental affinities — assigned at combat init by rollMonsterElementAffinity.
  // weakness: proc magnitude/duration boosted; resistance: 50% chance to block proc.
  element_weakness?: ElementType;
  element_resistance?: ElementType;
  // Damage-type routing for this monster's attacks. undefined defaults to "physical".
  // Determines whether armor or gear resistance applies when the monster hits a fighter.
  attack_damage_type?: DamageType;
  // Weapon range category for this monster. Drives initial range_tiles calculation
  // and determines whether the monster is a melee, ranged, or caster threat.
  weapon_range?: WeaponRange;
  damage_roll?: string;
  // Player damage type weaknesses/resistances (separate from elemental proc affinities).
  // weakness: player deals +30% to this monster with matching type.
  // resistance: player deals −30% with matching type.
  damage_weakness?: DamageType;
  damage_resistance?: DamageType;
}

export type CombatStatus = "pending" | "active" | "victory" | "defeat" | "fled";

export interface CombatState {
  fighters: CombatFighter[];
  // Multi-monster array (Phase 3). Dead monsters remain in the array with hp<=0
  // until the combat ends so the turn-order index stays stable.
  monsters: CombatMonster[];
  // Deprecated: single-monster field kept for backward-compat with persisted
  // DO states created before Phase 3. upgradeCombatState() populates `monsters`
  // from this when deserializing old states.
  monster?: CombatMonster;
  // Turn order is the actor IDs sorted by initiative descending. The current
  // turn is turn_order[turn_index % turn_order.length]; round increments when
  // we wrap.
  turn_order: ActorId[];
  turn_index: number;
  round: number;
  status: CombatStatus;
  // Per-fighter total damage dealt to the monster across this combat. Drives
  // contribution-proportional spoils on victory. Updated on every player_hit
  // (only fighters appear here; the monster doesn't accumulate contribution).
  contribution: Record<ActorId, number>;
  // Per-fighter stats accumulator for end-of-combat breakdown display.
  stats: Record<ActorId, {
    damage_taken: number;
    healing_done: number;
    shielding_done: number;
    kills: number;
  }>;
  // Active class abilities write transient buffs/debuffs here. Each field
  // counts down on use; absence means inactive. Persists across rounds until
  // exhausted or combat ends.
  ability_state?: AbilityRuntimeState;
  // Once-per-fight passives that have already fired, keyed by fighter id.
  // Always-on passives (Bard aura, Druid regen, Warlock crit-bleed, Sage info)
  // don't appear here — they don't burn out.
  passives_used?: Record<ActorId, string[]>;
  // Per-fighter action count for the current fight. Used by periodic passives
  // like Mana Font (1 mana every 3 actions). Resets at combat start.
  action_counters?: Record<ActorId, number>;
  // Cooldown tracking: cooldowns[fighterId][abilityId] = turns remaining.
  // Decremented when that fighter's next turn arrives; removed when it hits 0.
  cooldowns?: Record<ActorId, Record<AbilityId, number>>;
  // Pub drink buffs carried into this combat, keyed by fighter id. Seeded
  // by the DO bootstrap step from characters.drink_buff_json so a buff
  // bought in the pub before /sq quest survives into the engine-driven
  // fight. Engine consumes per-fighter on attack/cast/ability; absent
  // means no buff. Cleared (written back to D1) on combat exit. Optional
  // for backward compatibility with quests created before the unified
  // engine landed — older saved states deserialize cleanly without it.
  drink_buffs?: Record<ActorId, DrinkBuff>;
  // Anti-pile-on: tracks how many monsters have targeted each fighter in the
  // current round. Cleared when round advances. Used by pickMonsterTarget to
  // reduce the chance of multiple monsters focusing the same fighter.
  round_monster_targets?: { round: number; counts: Record<ActorId, number> };
  // Channel-broadcast idempotency for PR 4's milestone posts. Each
  // milestone key (e.g. "boss_reveal", "phase_2", "down:U123") is
  // recorded the moment the broadcast is queued so a DO crash between
  // queue and actual post can't double-broadcast on replay. Engine
  // ignores this field — the DO is the only writer/reader.
  milestones_posted?: string[];
  // ── Hex grid fields (added with tactical combat) ──────────────────────────
  // Arena dimensions. Defaults to GRID_DEFAULT (13×7) when not present.
  grid?: HexGrid;
  // Current sub-phase of the active turn. "move" → player may move or skip;
  // "attack" → player may attack, cast, or wait. Monsters resolve both phases
  // automatically. Absent on legacy states (treated as "attack").
  turn_phase?: "move" | "attack";
  // Terrain obstacles: block movement AND line of sight. Generated
  // deterministically at combat init from `scene_seed`.
  obstacles?: Obstacle[];
  // Pickup tiles scattered across the battlefield. Walking a fighter ONTO
  // one of these auto-picks it up — the tile leaves `loot_tiles` and the
  // payload accumulates in `pickups[fighterId]`. Worker-side reward
  // resolution reads `pickups` on victory and rolls real items via the
  // existing rollItem/flavorLootDrop pipeline (kept out of the engine
  // because rollItem uses Math.random and lives in flavor.ts).
  loot_tiles?: LootTile[];
  // Per-fighter accumulated pickups from loot tiles walked over this fight.
  // `gold` is raw coins; `item_tile_tiers` is one entry per item tile picked
  // up, capturing the tier to roll at victory. Cleared on combat resolve.
  pickups?: Record<ActorId, { gold: number; item_tile_tiers: number[] }>;
  // Visual/AI hint for battlefield generation (cave, forest, ruins, etc.).
  // Used by the obstacle generator to pick scene-appropriate kinds.
  scene?: string;
  // Once-per-fight monster specials that have already fired, keyed by monster id.
  specials_used?: Record<ActorId, MonsterSpecial[]>;
  // When true, hex range and LOS are enforced on attacks. Set by the web app;
  // false/absent on Slack combats, old serialized states, and unit tests.
  hex_range_enabled?: boolean;
  // Persistent tile effects placed by player abilities — fire walls, caltrops,
  // consecrated ground, etc. See `GroundEffect` in hex.ts + the design doc at
  // docs/ground-effects.md. Optional/back-compat: persisted states without
  // this field deserialize cleanly and all three engine hooks no-op when the
  // array is absent or empty. Cleared on combat resolve regardless of any
  // remaining duration.
  ground_effects?: GroundEffect[];
}

// Passive tuning knobs. Mirror src/commands.ts constants in main.
const DRUID_PASSIVE_REGEN = 2;
const BARD_AURA_HYMN_BONUS = 2;

// Keys for once-per-fight passives.
const PASSIVE_WARDEN_SHIELD = "warden_shield";
const PASSIVE_ROGUE_FIRST_CRIT = "rogue_first_crit";
const PASSIVE_PALADIN_AUTO_HEAL = "paladin_auto_heal";

export interface AbilityRuntimeState {
  // SRE Warden — monster's next N swings forced to target actor_id.
  taunt?: { actor_id: ActorId; swings_remaining: number };
  // Refactor Rogue — these fighters cannot be targeted; map of actor → swings left.
  vanished?: Record<ActorId, number>;
  // Frontend Bard — Battle Hymn: aura boost active until this round.
  battle_hymn?: { expires_after_round: number };
  // Frontend Bard — Encourage: fighter's next N to-hit d20 rolls twice, take higher.
  encourage?: Record<ActorId, number>;
  // Frontend Bard — Mock: monster's next N to-hit d20 rolls twice, take lower.
  discourage?: Record<ActorId, number>;
  // Mark / focus-fire — partymates other than the marker get +MARK_BONUS
  // damage on attack/cast until `expires_after_round` is exceeded. Cleared
  // when the monster falls or a wave transition fires.
  mark?: { marked_by: ActorId; expires_after_round: number; monster_id?: string };
  // QA Paladin — Holy Rage: accumulated raw HP damage received per fighter id.
  // Bonus on next attack = floor(total * 0.1). Reset to 0 on consume.
  holy_rage?: Record<ActorId, number>;
  // QA Paladin — Shield of Faith: all allies get +5 AC until this round passes.
  shield_of_faith?: { expires_after_round: number };
  // QA Paladin — Protect: the paladin absorbs half of the protected ally's HP damage.
  paladin_protect?: { paladin_id: ActorId; target_id: ActorId };
  // QA Paladin — Smite debuff: monster → swings remaining at 50% reduced damage.
  paladin_smite_debuff?: Record<ActorId, number>;
  // Refactor Rogue — Envenom Weapon: fighter → stacks + remaining charges.
  envenomed_weapon?: Record<ActorId, { stacks: number; charges: number }>;
  // Refactor Rogue — Debilitate: monster → vulnerability until this round passes.
  vulnerable?: Record<ActorId, { expires_after_round: number; magnitude: number }>;
  // Staff Sage — Blizzard: remaining end-of-caster-turn AoE damage charges.
  blizzard?: { caster_id: ActorId; mag: number; charges: number };
  // Staff Sage — Good Fortune: pending delayed double-heal for caster's next turn.
  good_fortune?: { caster_id: ActorId; target_id: ActorId; amount: number };
  // Staff Sage — Ill Omen: per-monster damage tracker + remaining monster turns until burst.
  ill_omen?: Record<ActorId, { caster_id: ActorId; accumulated: number; monster_turns_remaining: number }>;
  // Staff Sage — Foretell: per-monster pre-rolled fighter targets so each prediction is guaranteed correct.
  foretold_targets?: Record<ActorId, ActorId>;
  // SRE Warden — Brace: incoming damage reduced by pct% for N of the fighter's own turns.
  brace?: Record<ActorId, { pct: number; turns_remaining: number }>;
  // Backend Druid — Animal Form: buffed stat deltas for N of the caster's own turns.
  // Stored so they can be cleanly reverted on expiry.
  animal_form?: Record<ActorId, { str_bonus: number; vit_bonus: number; agi_bonus: number; dex_bonus: number; atk_delta: number; hp_delta: number; turns_remaining: number }>;
  // SRE Warden — Taunt Fortify: all incoming damage routes through armor for N of the warden's own turns.
  taunt_fortify?: Record<ActorId, { turns_remaining: number }>;
  // SRE Warden — Resilient stacks: each element is the expires_after_round value for one stack.
  resilient?: Record<ActorId, number[]>;
  // Staff Sage — Memoization: per-actor list of ability ids whose first cast
  // this combat has already been comped. The cast handler consults this on
  // every cast; if the actor has the passive equipped AND the ability id
  // isn't in this list yet, the cast is mana-free and the id is appended.
  memoization_casts?: Record<ActorId, string[]>;
  // Staff Sage — Cache Warmer: list of actor ids whose next ability cast is
  // mana-free because they took damage since their last cast. Damaged
  // fighters with the cache_warmer passive are added; the cast handler
  // zeroes mana_cost for any actor on this list and removes them after.
  cache_warmer_primed?: ActorId[];
}

// How many rounds a mark stays active. Roughly mirrors slack's 90s timer
// (which is ~2 cooldown cycles).
const MARK_ROUNDS = 2;

// Action shape submitted to step(). `actor` is required for player actions and
// must match the current turn's actor; the machine rejects out-of-turn moves.
// `monster_act` is a system action — the caller (DO) submits it when the turn
// rolls to the monster.
export type TurnAction =
  | { kind: "begin" }
  | { kind: "attack"; actor: ActorId; target_id?: ActorId }
  | { kind: "flee"; actor: ActorId }
  | { kind: "position"; actor: ActorId; to: BattlePosition }
  | { kind: "wait"; actor: ActorId }
  | { kind: "mark"; actor: ActorId; target_id?: string | null }
  | {
      kind: "ability";
      actor: ActorId;
      ability_id: AbilityId;
      // For single_enemy and soul_drain: the monster to target.
      target_id?: ActorId;
      // Used by migrate (target fighter + new position).
      target?: ActorId;
      position?: BattlePosition;
      // For ground-targeted abilities (target: "ground"): the chosen hex.
      // execute() resolves the shape around this center.
      target_pos?: HexPos;
    }
  // Hex grid: move the actor to an adjacent-or-reachable hex during move phase.
  | { kind: "move"; actor: ActorId; to: HexPos }
  | { kind: "monster_act"; actor?: ActorId }
  // ally_npc_act covers both hired mercs (__merc_*) and ability-summoned NPCs
  // (__ally_*). The DO/client dispatches this whenever isAllyNpcActor() is true
  // for the current actor; the engine auto-resolves the turn.
  | { kind: "ally_npc_act" };

export type RollPurpose =
  | "initiative"
  | "hit_check"
  | "damage_attack"
  | "damage_monster"
  | "ability"
  | "flee_check";

// Stream of events emitted by step(). The UI animates each in sequence.
//   roll       — a die hits the table; UI shows it spinning + landing on value
//   hit_check  — d20 + mod vs target AC; UI shows HIT/MISS banner
//   player_hit — damage chipped from monster HP; UI animates the chip-down
//   monster_attack — damage chipped from fighter HP (with shield + armor breakdown)
export type CombatEvent =
  | { type: "begin"; turn_order: ActorId[]; initiatives: Record<ActorId, number> }
  | { type: "turn_start"; actor: ActorId; round: number }
  | { type: "roll"; actor: ActorId; die: string; value: number; purpose: RollPurpose }
  | {
      type: "hit_check";
      actor: ActorId;
      target: ActorId;
      roll: number;        // raw d20
      modifier: number;    // attack_mod / magic_mod / tier
      total: number;       // roll + modifier
      ac: number;          // target's defense
      hit: boolean;
    }
  | {
      type: "player_hit";
      actor: ActorId;
      target: ActorId;       // always MONSTER_ID for now
      damage: number;
      armor_absorbed: number; // monster armor absorbed before HP damage; 0 for magic/cast
      crit: boolean;
      formula: string;
      damage_type?: DamageType;
    }
  | {
      type: "monster_attack";
      actor: ActorId;
      target: ActorId;
      damage_type: DamageType;
      raw_damage: number;
      damage_after_position: number;
      // For physical hits this is damage after armor reduction.
      // For magic/elemental hits this is damage after resistance reduction.
      damage_after_mitigation: number;
      armor_reduction: number;
      resistance_reduction: number;
      shield_absorbed: number;
      hp_damage: number;
    }
  | {
      type: "monster_splash";
      damage_type: DamageType;
      targets: Array<{
        target: ActorId;
        raw_damage: number;
        damage_after_mitigation: number;
        shield_absorbed: number;
        hp_damage: number;
      }>;
    }
  | { type: "monster_dodged"; target: ActorId }
  | { type: "monster_target_blocked"; reason: "vanish" }
  | { type: "boss_phase_transition"; new_phase: 2 }
  | { type: "fighter_down"; target: ActorId }
  | { type: "monster_down"; killed_by: ActorId }
  | {
      type: "wave_transition";
      from_monster: string;     // the monster that just fell
      to_monster: string;       // the next wave's monster
      to_max_hp: number;
      new_wave: number;         // 1-indexed
      total_waves: number;
    }
  | {
      type: "heal_applied";
      actor: ActorId;
      target: ActorId;
      amount: number;        // actual HP restored (clamped to max_hp)
      rolled: number;        // amount before clamp
    }
  | {
      type: "flee_check";
      actor: ActorId;
      roll: number;
      modifier: number;
      total: number;
      dc: number;
      success: boolean;
    }
  | { type: "fled" }
  | {
      type: "position_changed";
      actor: ActorId;
      from: BattlePosition;
      to: BattlePosition;
    }
  // Hex grid movement events.
  | { type: "moved"; actor: ActorId; from: HexPos; to: HexPos }
  | { type: "monster_moved"; actor: ActorId; from: HexPos; to: HexPos }
  | {
      type: "loot_pickup";
      actor: ActorId;
      tile_id: string;
      pos: HexPos;
      kind: LootKind;
      gold?: number;       // present when kind === "gold"
      item_tier?: number;  // present when kind === "item" — worker rolls the real item at victory
    }
  | { type: "monster_pounce"; actor: ActorId; to: HexPos }
  | { type: "out_of_range"; actor: ActorId; distance: number; max_range: number }
  // Generic "status effect applied" event — used by monster specials like
  // entangle_on_hit. Ability-driven effects still emit their bespoke types.
  | { type: "effect_applied"; actor: ActorId; target: ActorId; effect: EffectType; magnitude: number; duration: number }
  | {
      type: "effect_tick";
      actor: ActorId;
      effect: EffectType;
      magnitude: number;
      hp_delta: number;     // signed; positive for regen, negative for DoTs
      source?: string;
    }
  | {
      type: "ability_used";
      actor: ActorId;
      ability_id: string;
      name: string;
      mana_spent: number;
    }
  | { type: "ability_taunt"; actor: ActorId; swings: number }
  | { type: "ability_containerize" }
  | {
      type: "ability_regression_shield";
      actor: ActorId;
      grants: { target: ActorId; amount: number }[];
    }
  | { type: "ability_vanish"; actor: ActorId; swings: number }
  | {
      type: "ability_soul_drain";
      actor: ActorId;
      damage: number;
      healed: number;
      roll: number;
      formula: string;
    }
  | { type: "ability_battle_hymn"; actor: ActorId; expires_after_round: number }
  | { type: "ability_encourage"; actor: ActorId; target: ActorId; charges: number }
  | { type: "ability_mock"; actor: ActorId; target: ActorId; charges: number }
  | { type: "advantage_used"; actor: ActorId; d20_a: number; d20_b: number; took: number }
  | { type: "disadvantage_used"; actor: ActorId; d20_a: number; d20_b: number; took: number }
  | {
      type: "ability_foresee";
      actor: ActorId;
      // Committed telegraph target for the primary (first upcoming) monster.
      predicted_target: ActorId | null;
      // Per-monster committed targets. Keyed by monster ID; populated for every
      // monster that will act before the sage's next turn.
      predicted_targets: Record<ActorId, ActorId>;
      // Raw damage range (pre-armor/position).
      damage_lo: number;
      damage_hi: number;
      // Net damage range after target's armor + position modifier.
      net_lo: number;
      net_hi: number;
      // Survivability verdict for the predicted target.
      verdict: "safe" | "at_risk" | "lethal";
      // Targeting probability (0-100) per alive, non-vanished fighter.
      probabilities: Array<{ id: ActorId; position: BattlePosition; pct: number }>;
      // Party HP snapshot for triage.
      triage: Array<{ id: ActorId; hp: number; max_hp: number; shield: number; position: BattlePosition }>;
      // Active ability effects summary.
      active: { stunned: number; taunt_actor: ActorId | null; taunt_swings: number; vanished: ActorId[] };
      // How many more turns this readout will re-appear (counts down after cast).
      turns_remaining: number;
    }
  | {
      type: "ability_migrate";
      actor: ActorId;
      target: ActorId;
      from: BattlePosition;
      to: BattlePosition;
    }
  | { type: "monster_swing_skipped"; reason: "stunned" | "out_of_range" }
  | { type: "monster_stun_broken"; turns_active: number }
  | { type: "monster_target_redirected"; from: ActorId; to: ActorId; reason: "taunt" | "vanish" }
  | { type: "battle_hymn_expired"; actor: ActorId }
  | { type: "mark_applied"; actor: ActorId; expires_after_round: number }
  | { type: "shield_applied"; actor: ActorId; target: ActorId; restored: number; new_armor: number; bonus_barrier?: boolean }
  | { type: "passive_warden_shield"; actor: ActorId; amount: number }
  | { type: "passive_warden_thorns"; actor: ActorId; target: ActorId; amount: number }
  | { type: "passive_warden_armor_up"; actor: ActorId; amount: number }
  | { type: "ability_taunt_fortify"; actor: ActorId; turns: number }
  | { type: "passive_warden_resilient"; actor: ActorId; stacks: number }
  | { type: "ability_brace"; actor: ActorId; turns: number }
  | { type: "passive_mage_mana_font"; actor: ActorId; amount: number }
  | { type: "passive_druid_regen"; actor: ActorId; amount: number }
  | { type: "passive_rogue_lethal_strike"; actor: ActorId; magnitude: number; duration: number }
  | { type: "ability_envenom_proc"; actor: ActorId; target: ActorId; stacks: number }
  | { type: "passive_bard_aura"; actor: ActorId; source: ActorId; bonus: number }
| { type: "passive_holy_rage"; paladin: ActorId; bonus: number }
  | { type: "passive_lifesteal"; actor: ActorId; healed: number }
  | { type: "passive_thorns"; actor: ActorId; reflected: number }
  | { type: "passive_mana_regen"; actor: ActorId; amount: number }
  | { type: "ability_shield_of_faith"; actor: ActorId; expires_after_round: number }
  | { type: "ability_protect"; actor: ActorId; target: ActorId }
  | { type: "ability_smite_debuff"; actor: ActorId; target: ActorId }
  | { type: "protect_triggered"; paladin: ActorId; target: ActorId; target_damage: number; paladin_damage: number }
  | { type: "passive_primal_strikes_heal"; actor: ActorId; amount: number }
  | { type: "ability_regeneration"; actor: ActorId; target: ActorId; magnitude: number; duration: number }
  | { type: "ability_animal_form"; actor: ActorId; str_bonus: number; vit_bonus: number; agi_bonus: number; dex_bonus: number; turns: number }
  | { type: "ability_barkskin"; actor: ActorId; target: ActorId; bonus: number; turns: number }
  | { type: "ability_wildgrowth_entangle"; actor: ActorId; target: ActorId; duration: number }
  | { type: "passive_rogue_first_crit"; actor: ActorId }
  | { type: "passive_sinister_queries"; actor: ActorId; target: ActorId; magnitude: number }
  | { type: "ability_hex"; actor: ActorId; target: ActorId; duration: number }
  | { type: "hex_bleed_proc"; target: ActorId; stacks: number }
  | { type: "ability_forbidden_sql"; actor: ActorId; target: ActorId; stacks_consumed: number; damage: number }
  | { type: "passive_paladin_auto_heal"; paladin: ActorId; target: ActorId; amount: number }
  | {
      type: "drink_buff_consumed";
      actor: ActorId;
      drink_id: string;
      kind: "buff_attack" | "buff_magic" | "buff_next_crit";
      // Damage bonus from the buff. For buff_attack / buff_magic this is the
      // flat magnitude; for buff_next_crit it's `baseDamage` (the doubling
      // delta from forcing a crit on what would have been a non-crit hit).
      bonus: number;
      // True when this consumption forced a crit (buff_next_crit only).
      force_crit: boolean;
      // Charges left on the buff AFTER this consumption. 0 means the buff
      // expired and was cleared from state.drink_buffs.
      remaining: number;
    }
  | { type: "ally_npc_summoned"; actor: ActorId; npc_id: ActorId; name: string }
  | { type: "victory" }
  | { type: "defeat" }
  | { type: "rejected"; reason: string }
  | { type: "turn_skip"; actor: ActorId; reason: "frozen" }
  | { type: "ability_freeze_applied"; actor: ActorId; target: ActorId }
  | { type: "ability_burn_applied"; actor: ActorId; target: ActorId; magnitude: number; duration: number }
  | { type: "ability_shock_applied"; actor: ActorId; target: ActorId; magnitude: number; duration: number }
  | { type: "ability_blizzard_tick"; actor: ActorId; charges_remaining: number; hits: Array<{ target: ActorId; damage: number }> }
  | { type: "ability_good_fortune_delayed"; actor: ActorId; target: ActorId; amount: number }
  | { type: "ability_ill_omen_applied"; actor: ActorId; target: ActorId }
  | { type: "ability_ill_omen_burst"; actor: ActorId; target: ActorId; accumulated: number; burst: number }
  | { type: "ability_self_hp_cost"; actor: ActorId; amount: number }
  | { type: "passive_on_kill"; actor: ActorId; passive_id: string; target: ActorId }
  | { type: "passive_earworm_refund"; actor: ActorId; amount: number }
  | { type: "passive_load_balancer"; warden: ActorId; target: ActorId; redirect_damage: number }
  | { type: "passive_cache_warmer_primed"; actor: ActorId }
  | { type: "passive_cache_warmer_freed"; actor: ActorId; ability_id: string }
  | { type: "passive_failsafe_triggered"; actor: ActorId }
  | {
      type: "elemental_proc";
      actor: ActorId;
      target: ActorId;
      element: ElementType;
      effect: EffectType;
      magnitude: number;
      duration: number;
      resisted: boolean;
    }
  // Monster-to-fighter status proc on an elemental hit. Mirrors the
  // weapon-side `elemental_proc` (which fires player → monster). Separate
  // event so log renderers and analytics can distinguish "monster gave me
  // a status" from "I gave the monster a status."
  | {
      type: "monster_elemental_proc";
      actor: ActorId;          // monster id
      target: ActorId;         // fighter id
      element: "fire" | "ice" | "lightning";
      effect: "burning" | "frozen" | "shocked";
      magnitude: number;
      duration: number;
    }
  // ── Ground effects ──────────────────────────────────────────────────────
  // A persistent tile effect was placed on the battlefield.
  | {
      type: "ground_placed";
      actor: ActorId;          // source / initiator
      ground_id: string;
      kind: GroundEffectKind;
      hexes: HexPos[];
      expires_after_round: number;
      potency: number;
    }
  // A tick fired against an actor standing on a ground effect this turn.
  // hp_delta is signed: negative for damage, positive for heals.
  | {
      type: "ground_tick";
      actor: ActorId;          // actor standing on the tile
      source: ActorId;         // who planted the effect
      ground_id: string;
      kind: GroundEffectKind;
      hp_delta: number;
    }
  // An on_enter effect fired when an actor stepped onto its hex.
  | {
      type: "ground_triggered";
      actor: ActorId;          // actor who stepped on
      source: ActorId;
      ground_id: string;
      kind: GroundEffectKind;
      pos: HexPos;
      hp_delta: number;        // signed (negative for damage)
    }
  // A ground effect's duration ran out at round-advance.
  | {
      type: "ground_expired";
      ground_id: string;
      kind: GroundEffectKind;
      source: ActorId;
    };

// AC formulas — defense thresholds the attacker must equal or exceed on a
// d20 + relevant modifier. Tuned so low-tier monsters are easy to hit and
// boss-tier (tier 5+) take real swings to land. Armor still mitigates
// landed damage in resolveMonsterHit — it doesn't double-up here as AC.
const MONSTER_BASE_AC = 6;
// Fighter AC scales with level so high-tier monsters can't auto-hit, capped at 20
// so monsters never become literally unable to land hits at high levels.
// level 1→10, level 10→15, level 20+→20 (hard cap).
export const fighterAc = (level: number) => 10 + Math.min(Math.floor(level / 2), 10);
// Monster AC scales at half the tier rate; player attack_mod (augmented by
// level in the host app) stays meaningful throughout progression.
export const monsterAc = (tier: number) => MONSTER_BASE_AC + Math.max(0, Math.floor(tier / 2));

export interface StepResult {
  state: CombatState;
  events: CombatEvent[];
}

export type RollFn = (sides: number) => number;

// Inputs for the initial state. Build it once from D1 data, then feed into
// step({ kind: "begin" }) to roll initiative and enter the active phase.
// Wave fields on monster are opt-in: omit them for standard/boss combats.
// Use `monsters` for multi-enemy; `monster` for single-enemy (backward compat).
type MonsterInitSpec = Omit<CombatMonster, "initiative" | "effects" | "boss_phase" | "id" | "shield" | "pos"> & {
  id?: ActorId;    // auto-generated if omitted
  boss_phase?: 1 | 2;
  shield?: number; // defaults to tier when omitted
  // Hex position is auto-assigned by createCombatState(); callers don't set it.
  pos?: never;
};
export interface CombatInit {
  // focus_power and weapon_range default to 0 and "melee" when omitted — keeps
  // older call sites and tests valid without having to know about focus weapons.
  // pos is auto-assigned by createCombatState(); callers don't provide it.
  fighters: (Omit<CombatFighter, "initiative" | "effects" | "focus_power" | "weapon_range" | "pos"> & {
    focus_power?: number;
    weapon_range?: WeaponRange;
  })[];
  // When true, hex range and LOS are enforced on attacks. The web app sets
  // this; Slack combat and unit tests leave it false (backward compatible).
  hex_range_enabled?: boolean;
  // Seed for deterministic obstacle generation. Typically the quest id so a
  // player resuming a combat sees the same battlefield. Omit / undefined →
  // no obstacles.
  scene_seed?: number;
  // Scene kind for picking obstacle visual variety (cave/forest/ruins/...).
  // Stored on CombatState for the renderer.
  scene?: string;
  // Single monster (legacy). Alias for monsters: [monster].
  monster?: MonsterInitSpec;
  // Multi-monster (Phase 3). When present, `monster` is ignored.
  monsters?: MonsterInitSpec[];
}

export function createCombatState(init: CombatInit): CombatState {
  const contribution: Record<ActorId, number> = {};
  for (const f of init.fighters) contribution[f.id] = 0;
  const stats: CombatState["stats"] = {};
  for (const f of init.fighters) stats[f.id] = { damage_taken: 0, healing_done: 0, shielding_done: 0, kills: 0 };
  const monsterSpecs = init.monsters ?? (init.monster ? [init.monster] : []);
  const grid = GRID_DEFAULT;

  // Assign initial hex positions. Fighters fill from the top of the grid in
  // a stable center-out pattern. Monsters pick a seeded formation (line /
  // wedge / scatter / flank / back-rank / center) so each quest's opening
  // shape is different but deterministic per scene_seed; bosses always claim
  // the visual center regardless of formation. Solo fights skip formation
  // logic entirely (one monster → original center-fill behavior).
  const fighterPositions = initialHexPositions(init.fighters.length, "top", grid);
  const monsterPositions = placeMonsters(
    monsterSpecs.map((m) => ({
      weapon_range: m.weapon_range,
      is_boss: m.is_boss,
      tier: m.tier,
    })),
    grid,
    init.scene_seed ?? 0,
  );

  const monsters = monsterSpecs.map((m, i) => {
    const weaponRange = m.weapon_range ?? "melee";
    const tier = m.tier;
    const specials: MonsterSpecial[] = m.specials ?? [];
    return {
      ...m,
      id: m.id ?? (monsterSpecs.length === 1 ? MONSTER_ID : `__monster_${i}__`),
      initiative: 0,
      effects: [],
      boss_phase: m.boss_phase ?? 1,
      shield: m.shield ?? tier,
      pos: monsterPositions[i] ?? { q: 11, r: 3 },
      move_range: m.move_range ?? defaultMonsterMoveRange(tier),
      range_tiles: m.range_tiles ?? (weaponRange === "ranged" ? 4 : weaponRange === "focus" ? 3 : (specials.includes("reach") ? 2 : 1)),
      specials,
    };
  });

  // Generate terrain + loot tiles once, then share with the return object so
  // both `obstacles` and `loot_tiles` reference the same obstacle layout.
  const obstacles = init.scene_seed != null
    ? generateObstacles(grid, fighterPositions, monsterPositions, init.scene_seed, init.scene ?? "cave")
    : [];
  const loot_tiles = init.scene_seed != null
    ? generateLootTiles(
        grid,
        fighterPositions,
        monsterPositions,
        obstacles,
        init.scene_seed,
        // Tier hint: highest-tier monster on the field (boss > pack > lead).
        monsters.reduce((max, m) => Math.max(max, m.tier ?? 1), 1),
      )
    : [];

  return {
    fighters: init.fighters.map((f, i) => ({
      ...f,
      focus_power: f.focus_power ?? 0,
      weapon_range: f.weapon_range ?? "melee",
      initiative: 0,
      effects: [],
      pos: fighterPositions[i] ?? { q: 1, r: 3 },
    })),
    monsters,
    turn_order: [],
    turn_index: 0,
    round: 0,
    status: "pending",
    contribution,
    stats,
    grid,
    turn_phase: "move",
    obstacles,
    loot_tiles,
    pickups: {},
    scene: init.scene,
    hex_range_enabled: init.hex_range_enabled ?? false,
  };
}

// Upgrades a persisted combat state from older formats to the current one.
// Safe to call on already-upgraded states (idempotent).
export function upgradeCombatState(raw: CombatState): CombatState {
  // Phase 3 upgrade: monsters[] from legacy monster field.
  let s: CombatState = raw;
  if (!s.monsters || s.monsters.length === 0) {
    const legacy = s.monster;
    if (legacy) s = { ...s, monsters: [{ ...legacy, id: legacy.id ?? MONSTER_ID }] };
  }
  // Hex grid upgrade: add grid, turn_phase, obstacles, and positions if missing.
  // Skip when there are no actors (empty test states, etc.) to preserve toBe() identity.
  if (!s.grid && (s.fighters.length > 0 || s.monsters.length > 0)) {
    const grid = GRID_DEFAULT;
    const fighterPositions = initialHexPositions(s.fighters.length, "top", grid);
    const monsterPositions = initialHexPositions(s.monsters.length, "bottom", grid);
    s = {
      ...s,
      grid,
      // Active mid-combat states without turn_phase default to "attack" so
      // they don't require a move action before the next swing.
      turn_phase: "attack",
      obstacles: [],
      // Legacy states have no loot tiles — back-fill empty so renderers/handlers
      // don't have to null-check. Pickups likewise start empty.
      loot_tiles: s.loot_tiles ?? [],
      pickups: s.pickups ?? {},
      fighters: s.fighters.map((f, i) => ({
        ...f,
        pos: f.pos ?? (fighterPositions[i] ?? { q: 1, r: 3 }),
      })),
      monsters: s.monsters.map((m, i) => ({
        ...m,
        pos: m.pos ?? (monsterPositions[i] ?? { q: 11, r: 3 }),
        move_range: m.move_range ?? defaultMonsterMoveRange(m.tier),
        range_tiles: m.range_tiles ?? (m.weapon_range === "ranged" ? 4 : m.weapon_range === "focus" ? 3 : 1),
        specials: m.specials ?? [],
      })),
    };
  }
  // Position backfill: a joiner added to active combat without a hex position
  // (pre-fix bug) leaves the fighter invisible and unable to move. Assign any
  // free party-side hex so they show up and the move action unblocks.
  if (s.grid && s.fighters.some((f) => !f.pos)) {
    const grid = s.grid;
    const occupied = new Set<string>();
    for (const f of s.fighters) if (f.pos) occupied.add(posKey(f.pos));
    for (const m of s.monsters ?? []) if (m.pos && m.hp > 0) occupied.add(posKey(m.pos));
    for (const o of s.obstacles ?? []) if (o.pos) occupied.add(posKey(o.pos));
    const candidates = [
      ...initialHexPositions(s.fighters.length, "top", grid),
      ...allHexesInGrid(grid),
    ];
    s = {
      ...s,
      fighters: s.fighters.map((f) => {
        if (f.pos) return f;
        const pick = candidates.find((p) => !occupied.has(posKey(p))) ?? { q: 1, r: 1 };
        occupied.add(posKey(pick));
        return { ...f, pos: pick };
      }),
    };
  }
  // Obstacle format upgrade: very old persisted states may carry obstacles as
  // bare HexPos[] (pre-Obstacle interface). Wrap them as {pos, kind:"rubble"}.
  if (s.obstacles && s.obstacles.length > 0) {
    const upgraded = s.obstacles.map((o: Obstacle | HexPos) =>
      "pos" in o ? o : { pos: o, kind: "rubble" as const }
    );
    if (upgraded.some((o, i) => o !== s.obstacles![i])) {
      s = { ...s, obstacles: upgraded };
    }
  }
  return s;
}

// The engine. Pure function: same (state, action, rng) → same (state', events).
export function step(state: CombatState, action: TurnAction, roll: RollFn): StepResult {
  if (state.status === "victory" || state.status === "defeat" || state.status === "fled") {
    return reject(state, `combat already ended (${state.status})`);
  }

  switch (action.kind) {
    case "begin": {
      const beginResult = handleBegin(state, roll);
      // Fire an initial foresee so the Sage has predictions before the first
      // monster attack — but only when monsters act before the sage in round 1.
      // If the sage goes first they'll get foresee after the monster attacks.
      const sage = beginResult.state.fighters.find(
        (f) => f.hp > 0 && classHasPassive(f.class, "foretell"),
      );
      if (!sage) return beginResult;
      const order = beginResult.state.turn_order;
      const sageIdx = order.indexOf(sage.id);
      if (sageIdx <= 0 || !order.slice(0, sageIdx).some(isMonsterActor)) return beginResult;
      return withForeseeForSage(beginResult, sage.id, 0, roll);
    }
    case "attack":
      return handlePlayerHit(state, action, roll);
    case "flee":
      return handleFlee(state, action, roll);
    case "position":
      return handlePosition(state, action, roll);
    case "wait":
      return handleWait(state, action, roll);
    case "mark":
      return handleMark(state, action);
    case "ability":
      return handleAbility(state, action, roll);
    case "move":
      return handleMove(state, action);
    case "monster_act":
      // After the monster acts, if the next actor is a Staff Sage with Foresee
      // active, inject the intel refresh right before the turn_start divider so
      // the Sage sees fresh info at the top of their incoming turn.
      return withForeseeForNextActor(handleMonsterAct(state, roll), roll);
    case "ally_npc_act":
      return withForeseeForNextActor(handleAllyNpcAct(state, roll), roll);
  }
}

// --- Handlers ---

// ── Hex movement helper ───────────────────────────────────────────────────────

// Returns all occupied hex positions: alive actors with `pos` (excluding
// `excludeId`) plus all terrain obstacles. Used as the `occupied` argument
// to `hexReachable` / `hexPath` so movement routes around both units and
// terrain.
function occupiedHexes(state: CombatState, excludeId?: ActorId): HexPos[] {
  const result: HexPos[] = [];
  for (const f of state.fighters) {
    if (f.hp > 0 && f.pos && f.id !== excludeId) result.push(f.pos);
  }
  for (const m of state.monsters) {
    if (m.hp > 0 && m.pos && m.id !== excludeId) result.push(m.pos);
  }
  for (const o of state.obstacles ?? []) result.push(o.pos);
  return result;
}

// Returns the effective move range for a fighter, derived from AGI stat when available.
// When the fighter is adjacent (hex distance ≤ 1) to a monster with the
// `guardian_aura` special, the move range is halved (rounded down, minimum 1).
function fighterMoveRange(fighter: CombatFighter, state?: CombatState): number {
  const base = fighter.stats ? deriveMoveRange(fighter.stats.agi) : 2;
  if (!state || !fighter.pos) return base;
  const adjacentGuardian = state.monsters.some(
    (m) => m.hp > 0 && m.pos && m.specials?.includes("guardian_aura") && hexDistance(fighter.pos!, m.pos) <= 1,
  );
  return adjacentGuardian ? Math.max(1, Math.floor(base / 2)) : base;
}

// Returns the effective attack range in hexes for a fighter.
function fighterRangeTiles(fighter: CombatFighter): number {
  return deriveRangeTiles(
    fighter.weapon_range,
    fighter.stats?.int_stat,
    fighter.stats?.dex,
  );
}

// Move phase handler: validates the destination, updates pos, advances to attack phase.
// Does NOT advance turn_index — the actor still needs to take their attack action.
function handleMove(
  state: CombatState,
  action: { kind: "move"; actor: ActorId; to: HexPos },
): StepResult {
  const fighter = state.fighters.find((f) => f.id === action.actor);
  if (!fighter) return reject(state, `unknown actor: ${action.actor}`);
  if (currentActor(state) !== action.actor) {
    return reject(state, `not ${action.actor}'s turn (current: ${currentActor(state)})`);
  }
  if (fighter.hp <= 0) return reject(state, `${action.actor} is downed`);
  if ((state.turn_phase ?? "attack") !== "move") {
    return reject(state, "move is only valid during the move phase");
  }
  // Frozen actors lose the whole turn (move + attack). The tick-based skip
  // only fires when the actor commits to an attack/ability/wait, so without
  // this gate a frozen fighter could still walk freely during move phase
  // and only get hit by the skip after attempting the second phase.
  if (fighter.effects.some((e) => e.type === "frozen")) {
    return reject(state, `${action.actor} is frozen`);
  }
  if (!fighter.pos) return reject(state, "actor has no hex position");

  const grid = state.grid ?? GRID_DEFAULT;
  const from = fighter.pos;
  const toKey = posKey(action.to);

  // Stay-in-place: moving to your current hex is a no-op that advances the
  // phase. Lets the UI offer a "Skip Move" button without a separate action.
  if (toKey === posKey(from)) {
    return {
      state: { ...state, turn_phase: "attack" },
      events: [{ type: "moved", actor: action.actor, from, to: action.to }],
    };
  }

  const range = fighterMoveRange(fighter, state);
  const occupied = occupiedHexes(state, action.actor);
  const reachable = hexReachable(from, range, occupied, grid);
  const canMove = reachable.some((p) => posKey(p) === toKey);
  if (!canMove) {
    return reject(state, `hex (${action.to.q},${action.to.r}) is not reachable in ${range} steps`);
  }

  let next: CombatState = {
    ...state,
    turn_phase: "attack",
    fighters: state.fighters.map((f) =>
      f.id === action.actor ? { ...f, pos: action.to } : f,
    ),
  };

  const events: CombatEvent[] = [
    { type: "moved", actor: action.actor, from, to: action.to },
  ];

  // Loot pickup: if the destination hex matches a loot tile, accumulate it
  // into the fighter's pickups and remove the tile. Engine produces the
  // event with kind + payload hint; worker rolls real items at victory.
  const pickedUp = (state.loot_tiles ?? []).find((t) => posKey(t.pos) === toKey);
  if (pickedUp) {
    const currentPickups = next.pickups?.[action.actor]
      ?? { gold: 0, item_tile_tiers: [] };
    let updatedPickups = currentPickups;
    const evt: Extract<CombatEvent, { type: "loot_pickup" }> = {
      type: "loot_pickup",
      actor: action.actor,
      tile_id: pickedUp.id,
      pos: pickedUp.pos,
      kind: pickedUp.kind,
    };
    if (pickedUp.kind === "gold") {
      const gold = lootTileGold(pickedUp.tier);
      updatedPickups = { ...currentPickups, gold: currentPickups.gold + gold };
      evt.gold = gold;
    } else {
      const itemTier = lootTileItemTier(pickedUp.tier);
      updatedPickups = {
        ...currentPickups,
        item_tile_tiers: [...currentPickups.item_tile_tiers, itemTier],
      };
      evt.item_tier = itemTier;
    }
    next = {
      ...next,
      loot_tiles: (next.loot_tiles ?? []).filter((t) => t.id !== pickedUp.id),
      pickups: { ...(next.pickups ?? {}), [action.actor]: updatedPickups },
    };
    events.push(evt);
  }

  // Ground effects — on_enter trigger. Parallel to loot pickup: if the
  // destination matches any on_enter ground effect, fire its potency as
  // damage, credit `source_id` via contribution, and consume the entered
  // hex from the effect. See docs/ground-effects.md.
  const onEnterResult = applyGroundOnEnter(next, action.actor, action.to);
  next = onEnterResult.state;
  events.push(...onEnterResult.events);

  return { state: next, events };
}

// ── Ground effect hooks ───────────────────────────────────────────────────
//
// Three hooks, all back-compat (no-op when ground_effects is absent / empty):
//   - applyGroundOnEnter — fired from EVERY position-mutation site:
//       handleMove (player move), autoMoveMonster, autoMoveAllyNpc,
//       tryMonsterPounce, leap_adjacent_to, swap_positions.
//   - applyGroundTicks   — fired from tickAtTurnStart for the upcoming actor
//   - expireGroundEffects — fired from advanceTurn on round bump
//
// All damage flows through contribution[source_id] (credit follows the
// planter, even if source is downed/dead). Heals never grant credit.

// Apply on_enter ground effects when `actor` steps onto `pos`. Damage credit
// flows to each effect's source_id. Consumed hexes are stripped from the
// effect; empty effects are removed entirely. Fighters and monsters both
// trigger and receive damage — friendly fire is intentional.
function applyGroundOnEnter(
  state: CombatState,
  actorId: ActorId,
  pos: HexPos,
): { state: CombatState; events: CombatEvent[] } {
  const effects = state.ground_effects;
  if (!effects || effects.length === 0) return { state, events: [] };
  const events: CombatEvent[] = [];
  let s = state;
  const targetKey = posKey(pos);
  const updated: GroundEffect[] = [];
  for (const ge of effects) {
    if (ge.trigger !== "on_enter") {
      updated.push(ge);
      continue;
    }
    const hit = ge.hexes.some((h) => posKey(h) === targetKey);
    if (!hit) {
      updated.push(ge);
      continue;
    }
    // Apply damage. on_enter ground effects are damage-only in v1.
    const apply = applyGroundDamage(s, actorId, ge.source_id, ge.potency);
    s = apply.state;
    events.push({
      type: "ground_triggered",
      actor: actorId,
      source: ge.source_id,
      ground_id: ge.id,
      kind: ge.kind,
      pos: { ...pos },
      hp_delta: -apply.dealt,
    });
    events.push(...apply.events);
    // Consume the hex. If this empties the effect, drop it entirely.
    const remaining = ge.hexes.filter((h) => posKey(h) !== targetKey);
    if (remaining.length > 0) {
      updated.push({ ...ge, hexes: remaining });
    } else {
      events.push({ type: "ground_expired", ground_id: ge.id, kind: ge.kind, source: ge.source_id });
    }
    // If the trigger downed the actor, stop processing further on_enter
    // effects on this tile — the actor is already off the board.
    if (isMonsterActor(actorId)) {
      const m = s.monsters.find((mm) => mm.id === actorId);
      if (!m || m.hp <= 0) break;
    } else {
      const f = s.fighters.find((ff) => ff.id === actorId);
      if (!f || f.hp <= 0) break;
    }
  }
  s = { ...s, ground_effects: updated };
  return { state: s, events };
}

// Apply tick ground effects to whichever actor is about to start a turn.
// fire/brambles/frost damage any actor; consecrated heals only allies of
// source_id (fighters → other fighters; monsters never benefit). Damage
// credit flows to each effect's source_id; heals grant no credit.
function applyGroundTicks(
  state: CombatState,
  actorId: ActorId,
): { state: CombatState; events: CombatEvent[]; downed: boolean } {
  const effects = state.ground_effects;
  if (!effects || effects.length === 0) return { state, events: [], downed: false };
  // Actor's current pos. If they have no pos (legacy / pre-hex state), skip.
  const actorPos = actorPosOf(state, actorId);
  if (!actorPos) return { state, events: [], downed: false };
  const actorKey = posKey(actorPos);
  const events: CombatEvent[] = [];
  let s = state;
  let downed = false;
  for (const ge of effects) {
    if (ge.trigger !== "tick") continue;
    if (!ge.hexes.some((h) => posKey(h) === actorKey)) continue;
    if (ge.kind === "consecrated") {
      // Heal only allies of the source (player-only kind in v1 — monsters
      // never plant consecrated ground, so a monster standing on it never
      // benefits even if it happens to share an axis with the source).
      const sourceIsFighter = !isMonsterActor(ge.source_id);
      const actorIsFighter = !isMonsterActor(actorId);
      if (!sourceIsFighter || !actorIsFighter) continue;
      const fighter = s.fighters.find((f) => f.id === actorId);
      if (!fighter || fighter.hp <= 0) continue;
      const newHp = Math.min(fighter.max_hp, fighter.hp + ge.potency);
      const applied = newHp - fighter.hp;
      if (applied <= 0) continue;
      s = {
        ...s,
        fighters: s.fighters.map((f) => f.id === actorId ? { ...f, hp: newHp } : f),
      };
      events.push({
        type: "ground_tick",
        actor: actorId,
        source: ge.source_id,
        ground_id: ge.id,
        kind: ge.kind,
        hp_delta: applied,
      });
      continue;
    }
    // Damage kinds: fire / brambles / frost. Friendly fire ON.
    const apply = applyGroundDamage(s, actorId, ge.source_id, ge.potency);
    s = apply.state;
    events.push({
      type: "ground_tick",
      actor: actorId,
      source: ge.source_id,
      ground_id: ge.id,
      kind: ge.kind,
      hp_delta: -apply.dealt,
    });
    events.push(...apply.events);
    if (apply.downed) { downed = true; break; }
  }
  return { state: s, events, downed };
}

// Drop expired ground effects after the round counter increments. Returns
// the filtered state + ground_expired events for the dropped effects.
function expireGroundEffects(
  state: CombatState,
  newRound: number,
): { state: CombatState; events: CombatEvent[] } {
  const effects = state.ground_effects;
  if (!effects || effects.length === 0) return { state, events: [] };
  const surviving: GroundEffect[] = [];
  const events: CombatEvent[] = [];
  for (const ge of effects) {
    if (ge.expires_after_round < newRound) {
      events.push({ type: "ground_expired", ground_id: ge.id, kind: ge.kind, source: ge.source_id });
    } else {
      surviving.push(ge);
    }
  }
  if (events.length === 0) return { state, events: [] };
  return { state: { ...state, ground_effects: surviving }, events };
}

// Returns the current hex pos of an actor, or undefined if absent.
function actorPosOf(state: CombatState, actorId: ActorId): HexPos | undefined {
  if (isMonsterActor(actorId)) {
    return state.monsters.find((m) => m.id === actorId)?.pos;
  }
  return state.fighters.find((f) => f.id === actorId)?.pos;
}

// Apply a flat damage hit from a ground effect to either a fighter or a
// monster. Damage bypasses armor + shield (simple model in v1 — these tiles
// are environmental hazards, not weapon swings). Damage credit flows to
// `sourceId` via contribution, ALWAYS — even if the source is downed/dead.
// Emits monster_down / fighter_down events as appropriate and routes through
// the existing kill resolver to keep wave transitions intact.
function applyGroundDamage(
  state: CombatState,
  victimId: ActorId,
  sourceId: ActorId,
  potency: number,
): { state: CombatState; events: CombatEvent[]; dealt: number; downed: boolean } {
  if (potency <= 0) return { state, events: [], dealt: 0, downed: false };
  if (isMonsterActor(victimId)) {
    const monster = state.monsters.find((m) => m.id === victimId);
    if (!monster || monster.hp <= 0) return { state, events: [], dealt: 0, downed: false };
    const oldHp = monster.hp;
    const newHp = Math.max(0, oldHp - potency);
    const dealt = oldHp - newHp;
    let next: CombatState = {
      ...state,
      monsters: state.monsters.map((m) => m.id === monster.id ? { ...m, hp: newHp } : m),
    };
    // Credit even if the planter is downed/dead — only credit if the planter
    // is a fighter (matches existing contribution semantics: monsters never
    // appear in contribution).
    if (!isMonsterActor(sourceId)) {
      next = {
        ...next,
        contribution: { ...next.contribution, [sourceId]: (next.contribution[sourceId] ?? 0) + dealt },
      };
    }
    if (newHp <= 0) {
      // Route through the shared kill resolver so wave transitions / passives fire.
      const result = resolveMonsterKill(next, monster.id, sourceId, []);
      return { state: result.state, events: result.events, dealt, downed: true };
    }
    return { state: next, events: [], dealt, downed: false };
  }
  const fighter = state.fighters.find((f) => f.id === victimId);
  if (!fighter || fighter.hp <= 0) return { state, events: [], dealt: 0, downed: false };
  const oldHp = fighter.hp;
  const newHp = Math.max(0, oldHp - potency);
  const dealt = oldHp - newHp;
  let next: CombatState = {
    ...state,
    fighters: state.fighters.map((f) => f.id === fighter.id ? { ...f, hp: newHp } : f),
    // Damage-taken stats accumulate for end-of-combat breakdown.
    stats: {
      ...state.stats,
      [fighter.id]: {
        ...(state.stats[fighter.id] ?? { damage_taken: 0, healing_done: 0, shielding_done: 0, kills: 0 }),
        damage_taken: (state.stats[fighter.id]?.damage_taken ?? 0) + dealt,
      },
    },
  };
  // Credit only if the planter is a fighter.
  if (!isMonsterActor(sourceId)) {
    next = {
      ...next,
      contribution: { ...next.contribution, [sourceId]: (next.contribution[sourceId] ?? 0) + dealt },
    };
  }
  const events: CombatEvent[] = [];
  let downed = false;
  if (newHp <= 0) {
    events.push({ type: "fighter_down", target: fighter.id });
    downed = true;
  }
  return { state: next, events, dealt, downed };
}

// ── Ally NPC auto-move helper ─────────────────────────────────────────────────

// Steps an ally NPC (hired merc / summoned NPC) up to `moveRange` hexes
// toward `targetPos`, stopping one tile short so the NPC ends up adjacent
// instead of on top of the target. Returns updated state + a single
// generic `moved` event (same kind player characters emit when they
// move). Noop if the NPC has no pos, no path is found, or one step would
// already overshoot. Routes around fighters, monsters, and obstacles via
// `occupiedHexes`.
function autoMoveAllyNpc(
  state: CombatState,
  npcId: ActorId,
  targetPos: HexPos,
  moveRange: number,
): { state: CombatState; events: CombatEvent[] } {
  const npc = state.fighters.find((f) => f.id === npcId);
  if (!npc?.pos) return { state, events: [] };
  const grid = state.grid ?? GRID_DEFAULT;
  const occupied = occupiedHexes(state, npcId);
  const path = hexPath(npc.pos, targetPos, occupied, grid);
  if (path.length === 0) return { state, events: [] };
  const stepsToTake = Math.min(moveRange, path.length - 1);
  if (stepsToTake <= 0) return { state, events: [] };
  const dest = path[stepsToTake - 1];
  const from = npc.pos;
  let nextState: CombatState = {
    ...state,
    fighters: state.fighters.map((f) => f.id === npcId ? { ...f, pos: dest } : f),
  };
  const events: CombatEvent[] = [{ type: "moved", actor: npcId, from, to: dest }];
  // On-enter ground effects fire for any position mutation, not just
  // player handleMove. See applyGroundOnEnter / docs/ground-effects.md.
  const onEnter = applyGroundOnEnter(nextState, npcId, dest);
  nextState = onEnter.state;
  events.push(...onEnter.events);
  return { state: nextState, events };
}

// ── Monster auto-move helper ──────────────────────────────────────────────────

// Automatically moves a monster toward the closest fighter (BFS).
// Returns updated state + movement events. Noop if already in attack range.
function autoMoveMonster(
  state: CombatState,
  monsterId: ActorId,
  aliveFighters: CombatFighter[],
): { state: CombatState; events: CombatEvent[] } {
  const monster = state.monsters.find((m) => m.id === monsterId);
  if (!monster?.pos) return { state, events: [] };

  const moveRange = monster.move_range ?? Math.min(5, 2 + monster.tier);
  const attackRange = monster.range_tiles ?? 1;
  const grid = state.grid ?? GRID_DEFAULT;

  // If any fighter is already in attack range, no need to move.
  const figtersWithPos = aliveFighters.filter((f) => f.pos);
  if (figtersWithPos.some((f) => hexDistance(monster.pos!, f.pos!) <= attackRange)) {
    return { state, events: [] };
  }

  // Find the closest fighter to path toward.
  const closest = figtersWithPos.reduce<CombatFighter | null>((best, f) => {
    if (!best) return f;
    return hexDistance(monster.pos!, f.pos!) < hexDistance(monster.pos!, best.pos!) ? f : best;
  }, null);
  if (!closest?.pos) return { state, events: [] };

  const occupied = occupiedHexes(state, monsterId);
  const path = hexPath(monster.pos, closest.pos, occupied, grid);
  if (path.length === 0) return { state, events: [] };

  // Move up to moveRange steps, stopping BEFORE the fighter's tile.
  const stepsToTake = Math.min(moveRange, path.length - 1);
  if (stepsToTake <= 0) return { state, events: [] };

  const dest = path[stepsToTake - 1];
  const from = monster.pos;

  let nextState: CombatState = {
    ...state,
    monsters: state.monsters.map((m) =>
      m.id === monsterId ? { ...m, pos: dest } : m,
    ),
  };
  const events: CombatEvent[] = [{ type: "monster_moved", actor: monsterId, from, to: dest }];
  // On-enter ground effects fire for monster movement too — caltrops should
  // trigger on a monster stepping onto them (per design doc smoke test).
  const onEnter = applyGroundOnEnter(nextState, monsterId, dest);
  nextState = onEnter.state;
  events.push(...onEnter.events);
  return { state: nextState, events };
}

// Handles the "pounce" special: teleport adjacent to the farthest fighter.
function tryMonsterPounce(
  state: CombatState,
  monsterId: ActorId,
  aliveFighters: CombatFighter[],
): { state: CombatState; events: CombatEvent[]; pounced: boolean } {
  const monster = state.monsters.find((m) => m.id === monsterId);
  if (!monster?.pos) return { state, events: [], pounced: false };

  const alreadyUsed = (state.specials_used?.[monsterId] ?? []).includes("pounce");
  if (!monster.specials?.includes("pounce") || alreadyUsed) {
    return { state, events: [], pounced: false };
  }

  const figtersWithPos = aliveFighters.filter((f) => f.pos);
  if (figtersWithPos.length === 0) return { state, events: [], pounced: false };

  // Find farthest fighter.
  const farthest = figtersWithPos.reduce((best, f) =>
    hexDistance(monster.pos!, f.pos!) > hexDistance(monster.pos!, best.pos!) ? f : best,
  );
  if (!farthest.pos) return { state, events: [], pounced: false };

  // Find an adjacent hex to the farthest fighter that isn't occupied.
  const grid = state.grid ?? GRID_DEFAULT;
  const occupied = new Set(occupiedHexes(state, monsterId).map(posKey));
  const adjacentTiles = hexNeighbors(farthest.pos, grid).filter((p) => !occupied.has(posKey(p)));

  if (adjacentTiles.length === 0) return { state, events: [], pounced: false };

  // Land on the closest available adjacent tile to our current position.
  const dest = adjacentTiles.reduce((best, p) =>
    hexDistance(monster.pos!, p) < hexDistance(monster.pos!, best) ? p : best,
  );

  const prevUsed = state.specials_used?.[monsterId] ?? [];
  let nextState: CombatState = {
    ...state,
    monsters: state.monsters.map((m) =>
      m.id === monsterId ? { ...m, pos: dest } : m,
    ),
    specials_used: { ...(state.specials_used ?? {}), [monsterId]: [...prevUsed, "pounce"] },
  };
  const events: CombatEvent[] = [{ type: "monster_pounce", actor: monsterId, to: dest }];
  // Pounce is a position mutation; on-enter ground effects still trigger.
  const onEnter = applyGroundOnEnter(nextState, monsterId, dest);
  nextState = onEnter.state;
  events.push(...onEnter.events);

  return {
    state: nextState,
    events,
    pounced: true,
  };
}

function handleBegin(state: CombatState, roll: RollFn): StepResult {
  if (state.status !== "pending") {
    return reject(state, "begin is only valid when status is 'pending'");
  }
  const initiatives: Record<ActorId, number> = {};
  const next: CombatState = {
    ...state,
    fighters: state.fighters.map((f) => {
      const base = roll(20);
      const agiBonus = f.stats ? deriveInitiativeBonus(f.stats) : 0;
      const init = base + agiBonus;
      initiatives[f.id] = init;
      return { ...f, initiative: init };
    }),
    monsters: state.monsters.map((m) => {
      const init = roll(20);
      initiatives[m.id] = init;
      return { ...m, initiative: init };
    }),
    status: "active",
    turn_index: 0,
    round: 1,
  };
  next.turn_order = computeTurnOrder(next);

  const firstActor = next.turn_order[0];
  return {
    state: next,
    events: [
      { type: "begin", turn_order: next.turn_order, initiatives },
      ...next.fighters.map(
        (f) =>
          ({
            type: "roll",
            actor: f.id,
            die: "d20",
            value: f.initiative,
            purpose: "initiative",
          }) as CombatEvent,
      ),
      ...next.monsters.map(
        (m) =>
          ({
            type: "roll",
            actor: m.id,
            die: "d20",
            value: m.initiative,
            purpose: "initiative",
          }) as CombatEvent,
      ),
      { type: "turn_start", actor: firstActor, round: 1 },
    ],
  };
}

function handlePlayerHit(
  state: CombatState,
  action: { kind: "attack"; actor: ActorId; target_id?: ActorId },
  roll: RollFn,
): StepResult {
  const fighter = state.fighters.find((f) => f.id === action.actor);
  if (!fighter) return reject(state, `unknown actor: ${action.actor}`);
  if (currentActor(state) !== action.actor) {
    return reject(state, `not ${action.actor}'s turn (current: ${currentActor(state)})`);
  }
  if (fighter.hp <= 0) return reject(state, `${action.actor} is downed`);

  // Hex grid: attacking implicitly skips the move phase if the player hasn't moved yet.
  // This preserves backward compat (tests don't need explicit move actions) and mirrors
  // standard tactical-RPG UX where taking an action consumes both sub-phases.
  if ((state.turn_phase ?? "attack") === "move") {
    state = { ...state, turn_phase: "attack" };
  }

  // Target selection: use explicit target_id if provided, else pick first alive monster.
  const targetMonster = action.target_id
    ? state.monsters.find((m) => m.id === action.target_id && m.hp > 0)
    : state.monsters.find((m) => m.hp > 0);
  if (!targetMonster) return reject(state, "no valid target");

  // Hex range + LOS check (only when hex_range_enabled is set — the web app
  // enables this; Slack combat and unit tests are unaffected).
  if (state.hex_range_enabled && fighter.pos && targetMonster.pos) {
    const rangeTiles = fighterRangeTiles(fighter);
    const dist = hexDistance(fighter.pos, targetMonster.pos);
    if (dist > rangeTiles) {
      return {
        state,
        events: [{ type: "out_of_range", actor: action.actor, distance: dist, max_range: rangeTiles }],
      };
    }
    // LOS check for non-melee weapons.
    if (fighter.weapon_range !== "melee") {
      const obstacles = state.obstacles ?? [];
      if (!hexLos(fighter.pos, targetMonster.pos, obstacles)) {
        return reject(state, "no line of sight to target");
      }
    }
  }

  const tick = tickAtTurnStart(state, action.actor);
  if (tick.earlyReturn) return tick.earlyReturn;
  let s = tick.state;
  const tickedFighter = s.fighters.find((f) => f.id === action.actor)!;
  // Re-resolve target from updated state (tick may have killed the monster).
  const monster = s.monsters.find((m) => m.id === targetMonster.id && m.hp > 0);
  if (!monster) return reject(s, "target died before action resolved");

  const events: CombatEvent[] = [...tick.events];
  // Primal Strikes (Druid passive): add magic_mod to both to-hit and damage.
  const primalBonus = classHasPassive(tickedFighter.class, "primal_strikes") ? tickedFighter.magic_mod : 0;
  // Focus weapons use magic_mod for to-hit so casters can land attacks without speccing attack,
  // but damage still uses attack_mod (focus damage comes from weapon_power, not magic).
  const hitMod =
    (tickedFighter.weapon_range === "focus" ? tickedFighter.magic_mod : tickedFighter.attack_mod) + primalBonus;
  const damageMod = tickedFighter.attack_mod + primalBonus;

  // ── d20 to-hit ──
  let d20 = roll(20);
  // Bard Encourage — advantage: roll the d20 twice, take higher, consume one charge.
  const encourageCharges = s.ability_state?.encourage?.[action.actor] ?? 0;
  if (encourageCharges > 0) {
    const d20b = roll(20);
    const took = Math.max(d20, d20b);
    events.push({ type: "advantage_used", actor: action.actor, d20_a: d20, d20_b: d20b, took });
    d20 = took;
    s = { ...s, ability_state: consumeEncourageCharge(s.ability_state, action.actor) };
  }
  const ac = monsterAc(monster.tier);
  const hitTotal = d20 + hitMod;
  const landed = hitTotal >= ac;
  events.push({
    type: "roll",
    actor: action.actor,
    die: "d20",
    value: d20,
    purpose: "hit_check",
  });
  events.push({
    type: "hit_check",
    actor: action.actor,
    target: monster.id,
    roll: d20,
    modifier: hitMod,
    total: hitTotal,
    ac,
    hit: landed,
  });

  if (!landed) {
    const next = advanceTurn(s, events);
    return { state: next, events: [...events, ...turnStartEvent(next)] };
  }

  // Vanish auto-crit: reveal from stealth on any attack; force crit if attack lands.
  const wasVanished = (s.ability_state?.vanished?.[action.actor] ?? 0) > 0;
  if (wasVanished) {
    s = { ...s, ability_state: removeVanishForFighter(s.ability_state, action.actor) };
  }

  // ── damage roll on hit ──
  const damageRoll = tickedFighter.damage_roll ?? "1d6";
  const hit = resolvePlayerHit(action.kind, damageMod, tickedFighter.weapon_power, roll, damageRoll);
  events.push({
    type: "roll",
    actor: action.actor,
    die: damageRoll,
    value: hit.roll,
    purpose: "damage_attack",
  });

  let damage = hit.damage;
  let isCrit = hit.isCrit;

  // Vanish auto-crit: attacking while obscured guarantees a crit on hit.
  if (wasVanished && !isCrit) {
    isCrit = true;
    damage *= 2;
  }

  // DEX crit bonus — secondary crit chance for DEX > 5 (STATS_V2 only).
  if (!isCrit && tickedFighter.stats) {
    const threshold = Math.round(deriveCritBonus(tickedFighter.stats) * 100);
    if (threshold > 0 && roll(100) <= threshold) {
      isCrit = true;
      damage = damage * 2;
    }
  }

  // Gear-affix crit_pct — extra crit chance from rolled weapon affixes
  // (docs/gear-affixes-and-uniques.md). Stacks additively with the DEX
  // threshold; capped together at 50% to keep degenerate stacks in check.
  if (!isCrit && (tickedFighter.affix_effects?.crit_pct ?? 0) > 0) {
    const dexThreshold = tickedFighter.stats ? Math.round(deriveCritBonus(tickedFighter.stats) * 100) : 0;
    const affixThreshold = Math.min(50 - dexThreshold, tickedFighter.affix_effects!.crit_pct);
    if (affixThreshold > 0 && roll(100) <= affixThreshold) {
      isCrit = true;
      damage = damage * 2;
    }
  }

  // Gear-affix elemental damage adds — fire_dmg / ice_dmg / lightning_dmg
  // flat-add to the damage line when the wielder's weapon element matches.
  // For non-elemental weapons no add applies (the dmg key is dormant).
  const elementKey: keyof AffixEffects | null = tickedFighter.element === "fire" ? "fire_dmg"
    : tickedFighter.element === "ice" ? "ice_dmg"
    : tickedFighter.element === "lightning" ? "lightning_dmg"
    : null;
  if (elementKey && tickedFighter.affix_effects) {
    const bonus = tickedFighter.affix_effects[elementKey] ?? 0;
    if (bonus > 0) damage += bonus;
  }

  // Frontend Bard — Earworm: +1 mana to every bard with the passive on
  // any party crit. Applies before drink-buff because forceCrit could flip
  // isCrit later but we want the refund only on rolls that are actually
  // critting at this point (or via vanish).
  const attackEarworm = applyEarwormOnCrit(s, isCrit);
  s = attackEarworm.state;
  events.push(...attackEarworm.events);

  // Pub drink-buff. Applied between rogue first-crit and bard aura so the
  // crit-doubling has happened (buff_next_crit gates on !isCrit) but the
  // aura/mark bonuses haven't yet (those are partymate-driven additive
  // bonuses, distinct from the actor's own consumable buff).
  const drinkResult = applyDrinkBuff(s, action.actor, action.kind, damage, isCrit);
  damage = drinkResult.damage;
  if (drinkResult.forceCrit) {
    isCrit = true;
  }

  // QA Paladin — Holy Rage: consume accumulated bonus from damage taken.
  const holyRageTotal = s.ability_state?.holy_rage?.[action.actor] ?? 0;
  // R1 10% of accumulated damage, R2 15%, R3 20%.
  const holyRagePct = 0.05 + 0.05 * fighterRank(tickedFighter, "holy_rage");
  const holyRageBonus = Math.floor(holyRageTotal * holyRagePct);
  if (holyRageBonus > 0) {
    damage += holyRageBonus;
    s = { ...s, ability_state: clearHolyRage(s.ability_state, action.actor) };
    events.push({ type: "passive_holy_rage", paladin: action.actor, bonus: holyRageBonus });
  }

  // Battle Elixir — Empowered: +25% damage for N turns.
  const hasEmpowered = tickedFighter.effects.some((e) => e.type === "empowered");
  if (hasEmpowered) damage = Math.round(damage * 1.25);

  // Bard Aura — whole party gains +bonus dmg while a Bard is alive; Battle
  // Hymn boosts the aura by +2 for its round duration.
  const aura = computeBardAuraBonus(s);


  // Shocked amplifier: monster takes +30% (magnitude 1) or +45% (magnitude 2) from all hits.
  const shockedEffect = monster.effects.find((e) => e.type === "shocked");
  const shockMult = shockedEffect ? (shockedEffect.magnitude >= 2 ? 1.45 : 1.30) : 1.0;

  // Damage type weakness/resistance: +30% on weakness, −30% on resistance.
  // Player attack type: "physical" for melee, element or "magic" for cast.
  const playerAttackType: DamageType =
    action.kind === "attack"
      ? "physical"
      : (tickedFighter.element as DamageType | undefined) ?? "magic";
  const weaknessMult = monster.damage_weakness === playerAttackType ? 1.3 : 1.0;
  const resistMult = monster.damage_resistance === playerAttackType ? 0.7 : 1.0;

  const vulnMult = vulnerabilityMult(s, monster.id, s.round);
  const finalDamage = Math.max(1, Math.round((damage + aura.bonus) * shockMult * weaknessMult * resistMult * vulnMult));

  // Physical attacks (attack action) deplete the monster's armor pool first.
  // Cast and signatures bypass armor and go straight to HP.
  const monsterArmorAbsorbed = playerAttackType === "physical"
    ? Math.min(monster.shield, finalDamage)
    : 0;
  const newMonsterShield = monster.shield - monsterArmorAbsorbed;
  const hpDamage = finalDamage - monsterArmorAbsorbed;

  const oldHp = monster.hp;
  const newHp = Math.max(0, oldHp - hpDamage);
  const monsterKilled = newHp <= 0;
  const phaseTransition =
    monster.is_boss &&
    monster.boss_phase === 1 &&
    isBossPhaseTransition(monster.max_hp, oldHp, newHp);

  if (drinkResult.event) {
    events.push(drinkResult.event);
  }
  if (aura.bonus > 0) {
    events.push({
      type: "passive_bard_aura",
      actor: action.actor,
      source: state.fighters.find((f) => f.hp > 0 && classIdOf(f) === "frontend_bard")?.id ?? action.actor,
      bonus: aura.bonus,
    });
  }
  const drinkBonusForFormula =
    drinkResult.event && drinkResult.event.type === "drink_buff_consumed" && !drinkResult.forceCrit
      ? ` +${drinkResult.event.bonus} drink`
      : "";
  events.push({
    type: "player_hit",
    actor: action.actor,
    target: monster.id,
    damage: finalDamage,
    armor_absorbed: monsterArmorAbsorbed,
    crit: isCrit,
    formula: `${hit.roll}+${hit.totalMod}${isCrit ? " ×2" : ""}${drinkBonusForFormula}${hasEmpowered ? " ⚡" : ""}${aura.bonus > 0 ? ` +${aura.bonus} aura` : ""}`,
  });

  // Gear-affix lifesteal — heal the attacker by `lifesteal` HP per landed hit,
  // capped at their max_hp. Applies only when damage actually lands (not on
  // overkill that hit shield-only) so weak attacks still feel "drained-back".
  const lifestealAmt = tickedFighter.affix_effects?.lifesteal ?? 0;
  const lifestealHeal = lifestealAmt > 0 && hpDamage > 0
    ? Math.min(lifestealAmt, Math.max(0, hit.totalMod + tickedFighter.max_hp - tickedFighter.hp))
    : 0;

  let nextState: CombatState = {
    ...s,
    monsters: s.monsters.map((m) =>
      m.id === monster.id
        ? {
            ...m,
            hp: newHp,
            shield: newMonsterShield,
            // Boss phase 2 transition: armor refills (boss hardens).
            ...(phaseTransition ? { boss_phase: 2 as const, shield: m.tier } : {}),
          }
        : m,
    ),
    // Apply lifesteal to the attacker's fighter row.
    ...(lifestealHeal > 0
      ? { fighters: s.fighters.map((f) => f.id === action.actor ? { ...f, hp: Math.min(f.max_hp, f.hp + lifestealHeal) } : f) }
      : {}),
    contribution: {
      ...s.contribution,
      [action.actor]: (s.contribution[action.actor] ?? 0) + finalDamage,
    },
    // Only overwrite drink_buffs when this turn actually consumed one —
    // otherwise leave the existing map untouched so the optional field
    // doesn't get coerced to undefined for unrelated turns.
    ...(drinkResult.event ? { drink_buffs: drinkResult.nextDrinkBuffs } : {}),
  };
  if (lifestealHeal > 0) {
    events.push({ type: "passive_lifesteal", actor: action.actor, healed: lifestealHeal });
  }

  // Sinister Queries passive — applies bleed on any hit.
  if (!monsterKilled) {
    const sq = applySinisterQueries(nextState, tickedFighter, monster.id);
    nextState = sq.state;
    events.push(...sq.events);
    const hexProc = applyHexBleedProc(nextState, monster.id);
    nextState = hexProc.state;
    events.push(...hexProc.events);
  }

  // Rogue — Lethal Strikes: crits apply bleed.
  if (isCrit && !monsterKilled) {
    const ls = applyRogueLethalStrike(nextState, tickedFighter, monster.id);
    nextState = ls.state;
    events.push(...ls.events);
  }

  // Rogue — Envenom Weapon: next hit after ability applies poison.
  if (!monsterKilled) {
    const env = applyEnvenomProc(nextState, tickedFighter, monster.id);
    nextState = env.state;
    events.push(...env.events);
  }

  // Elemental weapon proc — applies status (burning/frozen/shocked) to target.
  if (!monsterKilled) {
    const proc = applyElementalProc(nextState, tickedFighter, monster.id, roll);
    nextState = proc.state;
    events.push(...proc.events);
  }

  // Warden — Resilient: gain a stack on every successful hit.
  if (!monsterKilled) {
    const rr = applyWardenResilient(nextState, tickedFighter);
    nextState = rr.state;
    events.push(...rr.events);
  }

  if (phaseTransition) {
    events.push({ type: "boss_phase_transition", new_phase: 2 });
  }

  // Staff Sage — Ill Omen: track HP damage dealt to omen-marked monster.
  if (hpDamage > 0) {
    nextState = accumulateIllOmenDamage(nextState, monster.id, hpDamage);
  }

  if (monsterKilled) {
    return resolveMonsterKill(nextState, monster.id, action.actor, events);
  }

  // Staff Sage — Blizzard: fire end-of-turn AoE tick after any player attack.
  const blizzTick = applyBlizzardTick(nextState, action.actor, roll);
  nextState = blizzTick.state;
  events.push(...blizzTick.events);
  for (const killedId of blizzTick.killed) {
    const killResult = resolveMonsterKill(nextState, killedId, action.actor, events);
    if (killResult.state.status !== "active") return killResult;
    nextState = killResult.state;
    events.length = 0;
    events.push(...killResult.events);
  }

  // Primal Strikes — heal on landing an attack. R1 ×1, R2 ×1.5, R3 ×2.
  if (primalBonus > 0) {
    const psRank = fighterRank(tickedFighter, "primal_strikes");
    const psMult = psRank >= 3 ? 2 : psRank >= 2 ? 1.5 : 1;
    const healAmount = Math.round((2 * tickedFighter.magic_mod + tickedFighter.attack_mod) * psMult);
    const primalFighter = nextState.fighters.find((f) => f.id === action.actor)!;
    const newHp = Math.min(primalFighter.max_hp, primalFighter.hp + healAmount);
    const healed = newHp - primalFighter.hp;
    if (healed > 0) {
      nextState = {
        ...nextState,
        fighters: nextState.fighters.map((f) => f.id === action.actor ? { ...f, hp: newHp } : f),
      };
      events.push({ type: "passive_primal_strikes_heal", actor: action.actor, amount: healed });
    }
  }

  return { state: advanceTurn(nextState, events), events: [...events, ...turnStartEvent(nextState)] };
}

// Auto-resolved ally NPC turn (hired mercs and ability-summoned NPCs): simple
// d20 to-hit then d6 damage swing at the lowest-HP live monster. No class
// abilities, no crits, no mana. Server fires this in a loop after each
// player/monster action whenever the next actor is an ally NPC, so the web
// client never sees a "pending NPC turn".
function handleAllyNpcAct(state: CombatState, roll: RollFn): StepResult {
  const actorId = currentActor(state);
  if (!actorId || !isAllyNpcActor(actorId)) {
    return reject(state, "not an ally NPC's turn");
  }
  const merc = state.fighters.find((f) => f.id === actorId);
  if (!merc || merc.hp <= 0) {
    const expiredEvents: CombatEvent[] = [];
    const next = advanceTurn(state, expiredEvents);
    return { state: next, events: [...expiredEvents, ...turnStartEvent(next)] };
  }

  const tick = tickAtTurnStart(state, actorId);
  if (tick.earlyReturn) return tick.earlyReturn;
  let s = tick.state;
  let mercAfterTick = s.fighters.find((f) => f.id === actorId);
  if (!mercAfterTick || mercAfterTick.hp <= 0) {
    return tick.earlyReturn ?? { state: s, events: tick.events };
  }

  const events: CombatEvent[] = [...tick.events];

  // Range gate + auto-move: in hex mode the merc respects its weapon range
  // just like a player character. We pick the lowest-HP monster within
  // reach (LOS-checked for ranged/focus weapons); if nothing's in reach the
  // merc auto-steps toward the closest live monster using a small move
  // range, then re-checks. If it still can't reach anyone, the turn passes
  // — no more free attacks on monsters across the whole battlefield.
  // Slack mode (hex_range_enabled=false) keeps the original "pick lowest-HP
  // monster anywhere" behavior since positions aren't tracked there.
  let monster: CombatMonster | null;
  if (s.hex_range_enabled && mercAfterTick.pos) {
    const obstacles = s.obstacles ?? [];
    const isMelee = (mercAfterTick.weapon_range ?? "melee") === "melee";
    const reachable = (m: CombatMonster, pos: HexPos, range: number): boolean =>
      m.hp > 0 && !!m.pos
      && hexDistance(pos, m.pos) <= range
      && (isMelee || hexLos(pos, m.pos, obstacles));

    let range = fighterRangeTiles(mercAfterTick);
    let inReach = s.monsters.filter((m) => reachable(m, mercAfterTick!.pos!, range));

    if (inReach.length === 0) {
      // Nothing in reach — try a single auto-step toward the closest live
      // monster. Mercs don't have stats so `fighterMoveRange` returns the
      // base move of 2; that's enough to make positioning matter without
      // letting the merc sprint across the field every turn.
      const live = s.monsters.filter((m) => m.hp > 0 && m.pos);
      if (live.length > 0) {
        const closest = live.reduce<CombatMonster>(
          (best, m) => hexDistance(mercAfterTick!.pos!, m.pos!) < hexDistance(mercAfterTick!.pos!, best.pos!) ? m : best,
          live[0],
        );
        const move = autoMoveAllyNpc(s, actorId, closest.pos!, fighterMoveRange(mercAfterTick, s));
        s = move.state;
        events.push(...move.events);
        mercAfterTick = s.fighters.find((f) => f.id === actorId) ?? mercAfterTick;
        range = fighterRangeTiles(mercAfterTick);
        inReach = s.monsters.filter((m) => reachable(m, mercAfterTick!.pos!, range));
      }
    }

    monster = inReach.reduce<CombatMonster | null>((best, m) => {
      if (!best || m.hp < best.hp) return m;
      return best;
    }, null);
  } else {
    // Slack / hex-disabled mode: original "pick lowest-HP monster" behavior.
    monster = s.monsters.reduce<CombatMonster | null>((best, m) => {
      if (m.hp <= 0) return best;
      if (!best || m.hp < best.hp) return m;
      return best;
    }, null);
  }

  if (!monster) {
    // Either no live monsters anywhere, or none in reach after the auto-
    // step. Advance the turn quietly; the UI shows the move event (if any)
    // and the next actor's turn-start banner.
    const next = advanceTurn(s, events);
    return { state: next, events: [...events, ...turnStartEvent(next)] };
  }

  const ac = monsterAc(monster.tier);
  const d20 = roll(20);
  const total = d20 + mercAfterTick.attack_mod;
  const landed = total >= ac;

  events.push({ type: "roll", actor: actorId, die: "d20", value: d20, purpose: "hit_check" });
  events.push({
    type: "hit_check",
    actor: actorId,
    target: monster.id,
    roll: d20,
    modifier: mercAfterTick.attack_mod,
    total,
    ac,
    hit: landed,
  });

  if (!landed) {
    const next = advanceTurn(s, events);
    return { state: next, events: [...events, ...turnStartEvent(next)] };
  }

  const npcDamageRoll = mercAfterTick.damage_roll ?? "1d6";
  const hit = resolvePlayerHit("attack", mercAfterTick.attack_mod, mercAfterTick.weapon_power, roll, npcDamageRoll);
  events.push({ type: "roll", actor: actorId, die: npcDamageRoll, value: hit.roll, purpose: "damage_attack" });

  const aura = computeBardAuraBonus(s);
  const rawDamage = hit.damage + aura.bonus;
  const { newShield: newMonsterShield, newHp, hpDamage: finalDamage } =
    applyDamageWithShield(rawDamage, monster.shield, monster.hp);

  if (aura.bonus > 0) {
    events.push({
      type: "passive_bard_aura",
      actor: actorId,
      source: s.fighters.find((f) => f.hp > 0 && classHasPassive(f.class, "bardic_aura"))?.id ?? actorId,
      bonus: aura.bonus,
    });
  }
  events.push({
    type: "player_hit",
    actor: actorId,
    target: monster.id,
    damage: finalDamage,
    armor_absorbed: monster.shield - newMonsterShield,
    crit: hit.isCrit,
    formula: `${npcDamageRoll}+${mercAfterTick.attack_mod}a+${mercAfterTick.weapon_power}w${aura.bonus > 0 ? ` +${aura.bonus} aura` : ""}`,
  });
  const monsterKilled = newHp <= 0;
  const nextState: CombatState = {
    ...s,
    monsters: s.monsters.map((m) =>
      m.id === monster.id ? { ...m, hp: Math.max(0, newHp), shield: newMonsterShield } : m,
    ),
    contribution: {
      ...s.contribution,
      [actorId]: (s.contribution[actorId] ?? 0) + finalDamage,
    },
  };

  if (monsterKilled) {
    return resolveMonsterKill(nextState, monster.id, actorId, events);
  }

  const hexProc = applyHexBleedProc(nextState, monster.id);
  events.push(...hexProc.events);

  return { state: advanceTurn(hexProc.state, events), events: [...events, ...turnStartEvent(hexProc.state)] };
}

function handlePosition(
  state: CombatState,
  action: { kind: "position"; actor: ActorId; to: BattlePosition },
  roll: RollFn,
): StepResult {
  const fighter = state.fighters.find((f) => f.id === action.actor);
  if (!fighter) return reject(state, `unknown actor: ${action.actor}`);
  if (currentActor(state) !== action.actor) {
    return reject(state, `not ${action.actor}'s turn`);
  }
  if (fighter.hp <= 0) return reject(state, `${action.actor} is downed`);
  if (fighter.position === action.to) {
    return reject(state, `already in ${action.to} row`);
  }

  const tick = tickAtTurnStart(state, action.actor);
  if (tick.earlyReturn) return tick.earlyReturn;
  let s = tick.state;

  const events: CombatEvent[] = [
    ...tick.events,
    { type: "position_changed", actor: action.actor, from: fighter.position, to: action.to },
  ];
  s = { ...s, fighters: s.fighters.map((f) => f.id === action.actor ? { ...f, position: action.to } : f) };

  // Staff Sage — Blizzard: fire end-of-turn AoE tick.
  const blizzTick = applyBlizzardTick(s, action.actor, roll);
  s = blizzTick.state;
  events.push(...blizzTick.events);
  for (const killedId of blizzTick.killed) {
    const killResult = resolveMonsterKill(s, killedId, action.actor, events);
    if (killResult.state.status !== "active") return killResult;
    s = killResult.state;
    events.length = 0;
    events.push(...killResult.events);
  }

  const next = advanceTurn(s, events);
  return { state: next, events: [...events, ...turnStartEvent(next)] };
}

function handleWait(
  state: CombatState,
  action: { kind: "wait"; actor: ActorId },
  roll: RollFn,
): StepResult {
  if (currentActor(state) !== action.actor) {
    return reject(state, `not ${action.actor}'s turn`);
  }
  const tick = tickAtTurnStart(state, action.actor);
  if (tick.earlyReturn) return tick.earlyReturn;
  let s = tick.state;
  const events: CombatEvent[] = [...tick.events];

  // Staff Sage — Blizzard: fire end-of-turn AoE tick.
  const blizzTick = applyBlizzardTick(s, action.actor, roll);
  s = blizzTick.state;
  events.push(...blizzTick.events);
  for (const killedId of blizzTick.killed) {
    const killResult = resolveMonsterKill(s, killedId, action.actor, events);
    if (killResult.state.status !== "active") return killResult;
    s = killResult.state;
    events.length = 0;
    events.push(...killResult.events);
  }

  const next = advanceTurn(s, events);
  return { state: next, events: [...events, ...turnStartEvent(next)] };
}

// Mark — free action, does not consume the actor's turn. Any living fighter
// can mark at any time to call out a focus target for their allies. Re-marking
// overrides the previous mark and resets the expiry.
function handleMark(
  state: CombatState,
  action: { kind: "mark"; actor: ActorId; target_id?: string | null },
): StepResult {
  const fighter = state.fighters.find((f) => f.id === action.actor);
  if (!fighter) return reject(state, `unknown actor: ${action.actor}`);
  if (fighter.hp <= 0) return reject(state, `${action.actor} is downed`);
  if (state.monsters.every((m) => m.hp <= 0)) return reject(state, `no live foe to mark`);

  // Resolve which monster is being marked. Explicit target_id wins; falls
  // back to the first live monster (single-monster fights, Slack path).
  const monster_id = action.target_id
    ?? state.monsters.find((m) => m.hp > 0)?.id;

  const expires_after_round = state.round + MARK_ROUNDS;
  const ability_state: AbilityRuntimeState = {
    ...(state.ability_state ?? {}),
    mark: { marked_by: action.actor, expires_after_round, monster_id },
  };
  return {
    state: { ...state, ability_state },
    events: [{ type: "mark_applied", actor: action.actor, expires_after_round }],
  };
}

function handleMonsterAct(state: CombatState, roll: RollFn): StepResult {
  const actorId = currentActor(state);
  if (!actorId || !isMonsterActor(actorId)) {
    return reject(state, "not a monster's turn");
  }
  const actingMonster = state.monsters.find((m) => m.id === actorId);
  if (!actingMonster || actingMonster.hp <= 0) {
    // Dead monster's turn slot — skip it silently.
    const expiredEvents: CombatEvent[] = [];
    const next = advanceTurn(state, expiredEvents);
    return { state: next, events: [...expiredEvents, ...turnStartEvent(next)] };
  }

  const tick = tickAtTurnStart(state, actorId);
  if (tick.earlyReturn) return tick.earlyReturn;
  let s = tick.state;
  // Re-resolve monster after tick (tick may have applied DoT to it).
  const monster = s.monsters.find((m) => m.id === actorId);
  if (!monster || monster.hp <= 0) {
    // Tick killed this monster — resolveMonsterKill already fired via earlyReturn above.
    return tick.earlyReturn ?? { state: s, events: tick.events };
  }

  const events: CombatEvent[] = [...tick.events];

  // Containerize stun: monster is stunned — skip this swing. At the end of
  // each stunned turn, roll to break: chance = min(100%, turnsElapsed * 30%).
  // `remaining` starts at 5 and is decremented by tickEffects each turn start,
  // so turnsElapsed = 5 - remaining after the tick. Guaranteed break on turn 4
  // (remaining=1 → turnsElapsed=4 → 120% clamped to 100%).
  const stunnedEffect = s.monsters.find((m) => m.id === actorId)?.effects.find((e) => e.type === "stunned");
  if (stunnedEffect) {
    const bpt = stunnedEffect.magnitude;
    const turnsElapsed = 5 - stunnedEffect.remaining;
    const breakChance = Math.min(1.0, turnsElapsed * (bpt / 100));
    const breaks = (roll(100) / 100) < breakChance;
    const breakEvents: CombatEvent[] = breaks
      ? [{ type: "monster_stun_broken", turns_active: turnsElapsed }]
      : [];
    const nextBreakPct = Math.min(100, (6 - stunnedEffect.remaining) * bpt);
    const updatedMonsters = breaks
      ? s.monsters.map((m) =>
          m.id === actorId
            ? { ...m, effects: m.effects.filter((e) => e.type !== "stunned") }
            : m,
        )
      : s.monsters.map((m) =>
          m.id === actorId
            ? { ...m, effects: m.effects.map((e) => e.type === "stunned" ? { ...e, pill_suffix: `${nextBreakPct}% break` } : e) }
            : m,
        );
    const skippedState: CombatState = { ...s, monsters: updatedMonsters };
    const next = advanceTurn(skippedState, events);
    return {
      state: next,
      events: [
        ...events,
        { type: "monster_swing_skipped", reason: "stunned" },
        ...breakEvents,
        ...turnStartEvent(next),
      ],
    };
  }

  // Staff Sage — Ill Omen: tick monster turn counter; burst fires on 3rd monster turn.
  const illOmen = tickIllOmenAtMonsterAct(s, actorId);
  s = illOmen.state;
  events.push(...illOmen.events);
  if (illOmen.killed && illOmen.caster_id) {
    return resolveMonsterKill(s, actorId, illOmen.caster_id, events);
  }

  const aliveFighters = s.fighters.filter((f) => f.hp > 0);
  if (aliveFighters.length === 0) {
    // Should be unreachable — defeat is checked after each fighter falls.
    return { state: { ...s, status: "defeat" }, events: [...events, { type: "defeat" }] };
  }

  // ── Hex grid: auto-move phase ─────────────────────────────────────────────
  // Monster automatically moves toward the closest fighter before attacking.
  // Only active when hex_range_enabled — keeps Slack combat and unit tests fast.
  // If it still can't reach a fighter, it tries the pounce special.
  if (s.hex_range_enabled) {
    const actingMonster = s.monsters.find((m) => m.id === actorId);
    if (actingMonster?.pos) {
      const attackRange = actingMonster.range_tiles ?? 1;
      const monsterWeaponRange = actingMonster.weapon_range ?? "melee";
      // LOS gate for ranged/focus monsters — symmetric with the player-side
      // check in handlePlayerHit. Without this, a kobold archer behind a
      // pillar can shoot the party through solid stone. Melee monsters
      // skip the check (they need to be adjacent anyway).
      const hasLos = (a: HexPos, b: HexPos) =>
        monsterWeaponRange === "melee" || hexLos(a, b, s.obstacles ?? []);
      const figtersInRange = aliveFighters.filter(
        (f) => f.pos
          && hexDistance(actingMonster.pos!, f.pos) <= attackRange
          && hasLos(actingMonster.pos!, f.pos),
      );
      if (figtersInRange.length === 0) {
        // Move toward closest fighter.
        const moveResult = autoMoveMonster(s, actorId, aliveFighters);
        s = moveResult.state;
        events.push(...moveResult.events);

        // Re-fetch monster after move to check updated position.
        const movedMonster = s.monsters.find((m) => m.id === actorId);
        const nowInRange = movedMonster?.pos && aliveFighters.some(
          (f) => f.pos
            && hexDistance(movedMonster.pos!, f.pos) <= attackRange
            && hasLos(movedMonster.pos!, f.pos),
        );

        if (!nowInRange) {
          // Still out of range — try anti-kite specials.
          const pounceResult = tryMonsterPounce(s, actorId, aliveFighters);
          if (pounceResult.pounced) {
            s = pounceResult.state;
            events.push(...pounceResult.events);
          } else {
            // Can't reach any fighter — skip attack.
            const next = advanceTurn(s, events);
            return {
              state: next,
              events: [...events, { type: "monster_swing_skipped", reason: "out_of_range" }, ...turnStartEvent(next)],
            };
          }
        }
      }
    }
  }

  // Anti-pile-on: fetch (or reset) the round-scoped target tally so monsters
  // in the same round are less likely to all converge on the same fighter.
  const prevRmt = s.round_monster_targets;
  const rmtCounts: Record<ActorId, number> =
    prevRmt && prevRmt.round === s.round ? { ...prevRmt.counts } : {};

  // Range/LOS-gated target pool. The auto-move phase only guarantees ≥1
  // fighter is reachable; without this filter the monster could be melee-
  // adjacent to fighter A but swing at fighter B across the map. Slack mode
  // (no hex positions) keeps the full pool.
  const postMovePos = s.monsters.find((m) => m.id === actorId)?.pos;
  const monsterAttackRange = monster.range_tiles ?? 1;
  const monsterAttackWeaponRange = monster.weapon_range ?? "melee";
  const targetPool = (s.hex_range_enabled && postMovePos)
    ? aliveFighters.filter((f) =>
        f.pos
        && hexDistance(postMovePos, f.pos) <= monsterAttackRange
        && (monsterAttackWeaponRange === "melee" || hexLos(postMovePos, f.pos, s.obstacles ?? [])),
      )
    : aliveFighters;
  // Safety net: if filtering somehow leaves no candidates (shouldn't happen
  // after the auto-move/pounce guards above), fall back to aliveFighters so
  // we don't crash; the OOR skip path catches the truly-unreachable case.
  const effectivePool = targetPool.length > 0 ? targetPool : aliveFighters;

  // Target selection honors taunt (override) and vanish (filter out).
  // If Foretell pre-rolled this monster's target, use it so the Sage's
  // prediction is guaranteed correct. Falls back to a fresh roll if the
  // pre-rolled fighter died before the monster swings.
  const foretoldId = s.ability_state?.foretold_targets?.[actorId];
  const foretoldFighter = foretoldId
    ? effectivePool.find((f) => f.id === foretoldId) ?? aliveFighters.find((f) => f.id === foretoldId)
    : null;
  const initialTarget = foretoldFighter ?? pickMonsterTarget(effectivePool, () => roll(101) / 100, rmtCounts, postMovePos);
  // Clear this monster's entry; leave other monsters' entries untouched.
  const ftRemaining = { ...(s.ability_state?.foretold_targets ?? {}) };
  delete ftRemaining[actorId];
  s = {
    ...s,
    ability_state: Object.keys(ftRemaining).length > 0
      ? { ...(s.ability_state ?? {}), foretold_targets: ftRemaining }
      : stripField(s.ability_state, "foretold_targets"),
  };
  const vanished = s.ability_state?.vanished ?? {};
  const taunted = s.ability_state?.taunt;
  let target: CombatFighter | null = initialTarget;
  if (taunted && taunted.swings_remaining > 0) {
    const tauntTarget = aliveFighters.find((f) => f.id === taunted.actor_id);
    if (tauntTarget) {
      if (tauntTarget.id !== initialTarget.id) {
        events.push({
          type: "monster_target_redirected",
          from: initialTarget.id,
          to: tauntTarget.id,
          reason: "taunt",
        });
      }
      target = tauntTarget;
    }
  } else if ((vanished[initialTarget.id] ?? 0) > 0) {
    // Vanish blocks this target — re-pick from the non-vanished, in-range pool.
    const eligible = effectivePool.filter((f) => (vanished[f.id] ?? 0) <= 0);
    if (eligible.length > 0) {
      const reroll = pickMonsterTarget(eligible, () => roll(101) / 100, rmtCounts);
      events.push({
        type: "monster_target_redirected",
        from: initialTarget.id,
        to: reroll.id,
        reason: "vanish",
      });
      target = reroll;
    } else {
      // If all alive fighters are vanished, the monster can't acquire a target.
      events.push({ type: "monster_target_blocked", reason: "vanish" });
      const next = advanceTurn({
        ...s,
        ability_state: tickAbilityCountersAfterSwing(s.ability_state),
      }, events);
      return { state: next, events: [...events, ...turnStartEvent(next)] };
    }
  }

  // Record this monster's target pick so subsequent monsters this round see
  // the tally and apply reduced weight to already-targeted fighters.
  if (target !== null) {
    rmtCounts[target.id] = (rmtCounts[target.id] ?? 0) + 1;
  }
  const rmt = { round: s.round, counts: rmtCounts };

  // ── Boss splash (AoE) ──
  // Bosses have a chance to forgo single-target targeting and slam the
  // area around them for reduced damage. Taunt does NOT redirect a splash.
  // The `volley` special grants the same AoE behavior at a higher base
  // chance even on non-boss monsters.
  //
  // Splash is centered on the monster's tile and only catches fighters
  // within `SPLASH_RADIUS_TILES`. Without this cap the boss-slam hit every
  // alive party member regardless of where they stood — a backline ally
  // 10 hexes away took the same damage as the tank in melee, which made
  // splash feel un-counterable. With the cap, spreading the party out
  // becomes a real defensive option. In Slack mode (no hex positions) the
  // radius is meaningless, so the legacy "hit everyone" behavior is kept.
  const SPLASH_RADIUS_TILES = 2;
  const splashEligible = (s.hex_range_enabled && monster.pos)
    ? aliveFighters.filter((f) => f.pos && hexDistance(monster.pos!, f.pos) <= SPLASH_RADIUS_TILES)
    : aliveFighters;

  const bossPhase2 = monster.is_boss && monster.boss_phase === 2;
  const splashChance = bossPhase2 ? 2 : 1; // 2-in-5 P2, 1-in-5 P1
  const hasVolley = monster.specials?.includes("volley") === true;
  // Splash needs 2+ fighters inside the radius — a single nearby target
  // doesn't justify the AoE swing; let the normal single-target attack
  // resolve instead.
  const volleyTriggers = hasVolley && splashEligible.length >= 2;
  const doSplash = (monster.is_boss && splashEligible.length > 1 && roll(5) <= splashChance)
    || volleyTriggers;

  if (doSplash) {
    const splashDamageType = monster.attack_damage_type ?? "physical";
    const splashTargets = splashEligible.filter((f) => (vanished[f.id] ?? 0) <= 0);
    const splashHexMult = monster.effects.some((e) => e.type === "hexed") ? 0.75 : 1.0;
    const splashHits = splashTargets.map((f) => {
      const resistPct = splashDamageType !== "physical" ? (f.resistances?.[splashDamageType] ?? 0) : 0;
      const hit = resolveMonsterHit(monster.tier, aliveFighters.length, 0, bossPhase2, roll, splashDamageType, resistPct, monster.damage_roll ?? "1d4");
      const splashShocked = f.effects.find((e) => e.type === "shocked");
      const splashShockMult = splashShocked ? (splashShocked.magnitude >= 2 ? 1.45 : 1.30) : 1.0;
      const posAdj = Math.round(hit.final * splashShockMult * splashHexMult);
      // Physical depletes armor pool; non-physical bypasses it.
      const splashArmorPool = splashDamageType === "physical" ? f.shield : 0;
      const rawSplash = applyDamageWithShield(posAdj, splashArmorPool, f.hp);
      const dmg = splashDamageType === "physical"
        ? rawSplash
        : { newShield: f.shield, newHp: rawSplash.newHp, shieldAbsorbed: 0, hpDamage: rawSplash.hpDamage };
      return { fighter: f, hit, posAdj, dmg };
    });

    const splashEvent: CombatEvent = {
      type: "monster_splash",
      damage_type: splashDamageType,
      targets: splashHits.map(({ fighter, hit, dmg }) => ({
        target: fighter.id,
        raw_damage: hit.raw,
        damage_after_mitigation: hit.final,
        shield_absorbed: dmg.shieldAbsorbed,
        hp_damage: dmg.hpDamage,
      })),
    };
    events.push(splashEvent);

    // Apply HP changes and emit fighter_down for casualties
    let updatedFighters = s.fighters;
    let updatedStats = s.stats;
    for (const { fighter, dmg } of splashHits) {
      const wasAlive = fighter.hp > 0;
      updatedFighters = updatedFighters.map((f) =>
        f.id === fighter.id ? { ...f, shield: dmg.newShield, hp: Math.max(0, dmg.newHp) } : f,
      );
      updatedStats = {
        ...updatedStats,
        [fighter.id]: {
          ...(updatedStats[fighter.id] ?? { damage_taken: 0, healing_done: 0, shielding_done: 0, kills: 0 }),
          damage_taken: (updatedStats[fighter.id]?.damage_taken ?? 0) + dmg.hpDamage,
        },
      };
      if (wasAlive && dmg.newHp <= 0) {
        events.push({ type: "fighter_down", target: fighter.id });
      }
    }

    const postSplashState: CombatState = {
      ...s,
      fighters: updatedFighters,
      ability_state: tickAbilityCountersAfterSwing(s.ability_state),
      stats: updatedStats,
      round_monster_targets: rmt,
    };

    const allDown = postSplashState.fighters.every((f) => f.hp <= 0);
    if (allDown) {
      events.push({ type: "defeat" });
      return { state: { ...postSplashState, status: "defeat" }, events };
    }
    const next = advanceTurn(postSplashState, events);
    return { state: next, events: [...events, ...turnStartEvent(next)] };
  }

  // ── d20 to-hit ──
  // Modifier grows at half-tier + 4 so it never auto-hits even at high tiers.
  // Fighter AC = 10 + floor(level/2) so the miss window stays meaningful.
  // Entangled: monster suffers -4 to all attack rolls.
  const entangledEffect = monster.effects.find((e) => e.type === "entangled");
  const entanglePenalty = entangledEffect ? 4 : 0;
  let d20 = roll(20);
  // Bard Mock — disadvantage: roll the d20 twice, take lower, consume one charge.
  const discourageCharges = s.ability_state?.discourage?.[actorId] ?? 0;
  if (discourageCharges > 0) {
    const d20b = roll(20);
    const took = Math.min(d20, d20b);
    events.push({ type: "disadvantage_used", actor: actorId, d20_a: d20, d20_b: d20b, took });
    d20 = took;
    s = { ...s, ability_state: consumeDiscourageCharge(s.ability_state, actorId) };
  }
  const modifier = Math.floor(monster.tier / 2) + 4 - entanglePenalty;
  const hitTotal = d20 + modifier;
  const sof = s.ability_state?.shield_of_faith;
  const shieldOfFaithBonus = sof && s.round <= sof.expires_after_round ? 5 : 0;
  // Barkskin (Druid): target fighter's AC is buffed for N of their own turns.
  const barkskinEff = target.effects.find((e) => e.type === "barkskin");
  const targetAc = fighterAc(target.level) + shieldOfFaithBonus + (barkskinEff?.magnitude ?? 0);
  const landed = hitTotal >= targetAc;
  events.push({
    type: "roll",
    actor: actorId,
    die: "d20",
    value: d20,
    purpose: "hit_check",
  });
  events.push({
    type: "hit_check",
    actor: actorId,
    target: target.id,
    roll: d20,
    modifier,
    total: hitTotal,
    ac: targetAc,
    hit: landed,
  });

  if (!landed) {
    // Even a miss consumes one tick of taunt / vanish / smite debuff — the swing happened.
    const decremented: CombatState = { ...s, ability_state: consumeSmiteDebuff(tickAbilityCountersAfterSwing(s.ability_state), actorId), round_monster_targets: rmt };
    const next = advanceTurn(decremented, events);
    return { state: next, events: [...events, ...turnStartEvent(next)] };
  }

  // AGI dodge — checked after the to-hit succeeds, before damage is rolled.
  // deriveDodgeChance returns a fraction (0..0.15); we compare against a
  // 1-100 roll so max 15 is cap (Rogue at AGI 8 → 3%, end-game AGI 15 → 10%).
  if (target.stats || (target.affix_effects?.dodge_pct ?? 0) > 0) {
    const baseThreshold = target.stats ? Math.round(deriveDodgeChance(target.stats) * 100) : 0;
    // Frontend Bard — A11y First: +1% dodge per rank (R1 +1, R2 +2, R3 +3).
    // Stacks additively with the AGI dodge bonus.
    const a11yDodgeBonus = fighterHasPassive(target, "a11y_first") ? fighterRank(target, "a11y_first") : 0;
    // Gear-affix dodge_pct — armor-rolled dodge stack. Stacks additively;
    // total dodge is hard-capped at 35% to bound the degenerate stack.
    const affixDodge = target.affix_effects?.dodge_pct ?? 0;
    const threshold = Math.min(35, baseThreshold + a11yDodgeBonus + affixDodge);
    if (threshold > 0 && roll(100) <= threshold) {
      events.push({ type: "monster_dodged", target: target.id });
      const decremented: CombatState = {
        ...s,
        ability_state: consumeSmiteDebuff(tickAbilityCountersAfterSwing(s.ability_state), actorId),
        round_monster_targets: rmt,
      };
      const next = advanceTurn(decremented, events);
      return { state: next, events: [...events, ...turnStartEvent(next)] };
    }
  }

  // ── damage roll on hit ──
  const attackDamageType = monster.attack_damage_type ?? "physical";
  const targetResistPct = attackDamageType !== "physical"
    ? (target.resistances?.[attackDamageType] ?? 0)
    : 0;
  const monsterDamageRoll = monster.damage_roll ?? "1d4";
  const hit = resolveMonsterHit(
    monster.tier,
    aliveFighters.length,
    0,
    bossPhase2,
    roll,
    attackDamageType,
    targetResistPct,
    monsterDamageRoll,
  );
  const targetShocked = target.effects.find((e) => e.type === "shocked");
  const targetShockMult = targetShocked ? (targetShocked.magnitude >= 2 ? 1.45 : 1.30) : 1.0;
  const hexMult = monster.effects.some((e) => e.type === "hexed") ? 0.75 : 1.0;
  // In hex combat, damage is no longer reduced by front/back position.
  const mitigatedDamage = Math.round(hit.final * targetShockMult * hexMult);
  // QA Paladin — Smite debuff: 50% reduced damage on this swing.
  const smiteDebuffSwings = s.ability_state?.paladin_smite_debuff?.[actorId] ?? 0;
  const smiteAdjusted = smiteDebuffSwings > 0
    ? Math.max(1, Math.round(mitigatedDamage * 0.5))
    : mitigatedDamage;
  const brace = s.ability_state?.brace?.[target.id];
  const effectiveDamage = brace && brace.turns_remaining > 0
    ? Math.max(1, Math.round(smiteAdjusted * (1 - brace.pct / 100)))
    : smiteAdjusted;
  // Physical attacks route through the armor pool first (shield = depletable armor).
  // Non-physical bypasses armor entirely — unless Taunt Fortify is active, in which case
  // all damage routes through armor.
  const hasTauntFortify = (s.ability_state?.taunt_fortify?.[target.id]?.turns_remaining ?? 0) > 0;
  const armorForHit = (attackDamageType === "physical" || hasTauntFortify) ? target.shield : 0;
  const rawResult = applyDamageWithShield(effectiveDamage, armorForHit, target.hp);
  const newShield = (attackDamageType === "physical" || hasTauntFortify) ? rawResult.newShield : target.shield;
  const newHp = rawResult.newHp;
  const shieldAbsorbed = rawResult.shieldAbsorbed;
  const hpDamage = rawResult.hpDamage;

  events.push({
    type: "roll",
    actor: actorId,
    die: monsterDamageRoll,
    value: hit.raw - monster.tier - Math.floor((aliveFighters.length - 1) / 2) - (bossPhase2 ? monster.tier : 0),
    purpose: "damage_monster",
  });
  events.push({
    type: "monster_attack",
    actor: actorId,
    target: target.id,
    damage_type: attackDamageType,
    raw_damage: hit.raw,
    damage_after_position: effectiveDamage,
    damage_after_mitigation: hit.final,
    armor_reduction: hit.armorReduction,
    resistance_reduction: hit.resistanceReduction,
    shield_absorbed: shieldAbsorbed,
    hp_damage: hpDamage,
  });

  // Gear-affix thorns — reflect damage to the attacking monster when the
  // target took physical HP damage. Cosmetic ceiling: never reflect more
  // than 10 per hit so a stacked thorns build can't trivially nuke bosses.
  const thornsAmt = target.affix_effects?.thorns ?? 0;
  if (thornsAmt > 0 && attackDamageType === "physical" && hpDamage > 0) {
    const reflected = Math.min(10, thornsAmt);
    s = {
      ...s,
      monsters: s.monsters.map((m) =>
        m.id === monster.id ? { ...m, hp: Math.max(0, m.hp - reflected) } : m,
      ),
    };
    events.push({ type: "passive_thorns", actor: target.id, reflected });
  }

  // ── Special: entangle_on_hit ──
  // Monsters with this special apply the `entangled` status to any fighter
  // they damage with a melee hit. Forces the player to stick close (the
  // entangled effect zeros their move range until it ticks down).
  if (
    hpDamage > 0
    && monster.specials?.includes("entangle_on_hit")
    && (monster.range_tiles ?? 1) <= 2
  ) {
    const entangleEff: MachineStatusEffect = {
      type: "entangled",
      magnitude: 1,
      remaining: 2,
      source: actorId,
    };
    s = {
      ...s,
      fighters: s.fighters.map((f) =>
        f.id === target.id
          ? { ...f, effects: mergeEffect(f.effects, entangleEff) }
          : f,
      ),
    };
    events.push({
      type: "effect_applied",
      actor: actorId,
      target: target.id,
      effect: "entangled",
      magnitude: 1,
      duration: 2,
    });
  }

  // SRE Warden — Load Balancer: redirect 25% of HP damage to an adjacent
  // Warden who has the passive equipped. Applies before Protect splits the
  // remainder — Load Balancer absorbs first off the top.
  let loadBalancerWarden: CombatFighter | null = null;
  let loadBalancerDamage = 0;
  if (hpDamage > 0 && target.pos) {
    for (const f of s.fighters) {
      if (f.id === target.id || f.hp <= 0 || !f.pos) continue;
      if (!fighterHasPassive(f, "load_balancer")) continue;
      if (hexDistance(f.pos, target.pos) > 1) continue;
      loadBalancerWarden = f;
      // R1 25%, R2 35%, R3 45% redirect share.
      const pct = 0.15 + 0.10 * fighterRank(f, "load_balancer");
      loadBalancerDamage = Math.floor(hpDamage * pct);
      break;
    }
  }
  const postLoadBalancerHpDamage = hpDamage - loadBalancerDamage;

  // QA Paladin — Protect: split remaining HP damage between the protected
  // ally and the paladin (after Load Balancer has skimmed its share).
  const protectState = s.ability_state?.paladin_protect;
  const protectPaladin = protectState?.target_id === target.id
    ? s.fighters.find((f) => f.id === protectState!.paladin_id && f.hp > 0 && f.id !== target.id && f.id !== loadBalancerWarden?.id)
    : null;
  const targetHpDamage = protectPaladin ? Math.floor(postLoadBalancerHpDamage / 2) : postLoadBalancerHpDamage;
  const paladinProtectDamage = protectPaladin ? (postLoadBalancerHpDamage - targetHpDamage) : 0;
  // DevOps Mage — Failsafe: once-per-fight death save for any party member
  // (mage or otherwise) who has the passive equipped. Floors HP at 1 instead
  // of downing them. Applied at each damage-take point so a redirected hit
  // (Load Balancer / Protect) also gets the save.
  const targetFailsafe = applyFailsafe(s, target, Math.max(0, target.hp - targetHpDamage));
  const targetNewHp = targetFailsafe.newHp;
  const paladinFailsafe = protectPaladin
    ? applyFailsafe(s, protectPaladin, Math.max(0, protectPaladin.hp - paladinProtectDamage))
    : { newHp: 0, triggered: false };
  const paladinProtectNewHp = protectPaladin ? paladinFailsafe.newHp : null;
  const wardenFailsafe = loadBalancerWarden
    ? applyFailsafe(s, loadBalancerWarden, Math.max(0, loadBalancerWarden.hp - loadBalancerDamage))
    : { newHp: 0, triggered: false };
  const wardenNewHp = loadBalancerWarden ? wardenFailsafe.newHp : null;

  if (loadBalancerWarden) {
    events.push({ type: "passive_load_balancer", warden: loadBalancerWarden.id, target: target.id, redirect_damage: loadBalancerDamage });
  }
  if (protectPaladin) {
    events.push({ type: "protect_triggered", paladin: protectPaladin.id, target: target.id, target_damage: targetHpDamage, paladin_damage: paladinProtectDamage });
  }
  // Helper: at R2 a triggered Failsafe also grants 5 shield; at R3 it grants
  // 10 shield. Lets the saved fighter stick around a moment instead of being
  // a 1-HP sitting duck on the next swing.
  const failsafeShieldFor = (f: CombatFighter): number => {
    const r = fighterRank(f, "failsafe");
    return r >= 3 ? 10 : r >= 2 ? 5 : 0;
  };
  if (targetFailsafe.triggered) {
    s = markPassiveUsed(s, target.id, "failsafe");
    const shieldBonus = failsafeShieldFor(target);
    if (shieldBonus > 0) {
      s = { ...s, fighters: s.fighters.map((f) => f.id === target.id ? { ...f, shield: f.shield + shieldBonus } : f) };
    }
    events.push({ type: "passive_failsafe_triggered", actor: target.id });
  }
  if (paladinFailsafe.triggered && protectPaladin) {
    s = markPassiveUsed(s, protectPaladin.id, "failsafe");
    const shieldBonus = failsafeShieldFor(protectPaladin);
    if (shieldBonus > 0) {
      s = { ...s, fighters: s.fighters.map((f) => f.id === protectPaladin.id ? { ...f, shield: f.shield + shieldBonus } : f) };
    }
    events.push({ type: "passive_failsafe_triggered", actor: protectPaladin.id });
  }
  if (wardenFailsafe.triggered && loadBalancerWarden) {
    s = markPassiveUsed(s, loadBalancerWarden.id, "failsafe");
    const shieldBonus = failsafeShieldFor(loadBalancerWarden);
    if (shieldBonus > 0) {
      s = { ...s, fighters: s.fighters.map((f) => f.id === loadBalancerWarden.id ? { ...f, shield: f.shield + shieldBonus } : f) };
    }
    events.push({ type: "passive_failsafe_triggered", actor: loadBalancerWarden.id });
  }

  const updatedFighters = s.fighters.map((f) => {
    if (f.id === target.id) return { ...f, shield: newShield, hp: targetNewHp };
    if (protectPaladin && f.id === protectPaladin.id) return { ...f, hp: paladinProtectNewHp! };
    if (loadBalancerWarden && f.id === loadBalancerWarden.id) return { ...f, hp: wardenNewHp! };
    return f;
  });
  const targetDowned = targetNewHp <= 0 && target.hp > 0;
  if (targetDowned) {
    events.push({ type: "fighter_down", target: target.id });
  }
  if (protectPaladin && paladinProtectNewHp! <= 0 && protectPaladin.hp > 0) {
    events.push({ type: "fighter_down", target: protectPaladin.id });
  }
  if (loadBalancerWarden && wardenNewHp! <= 0 && loadBalancerWarden.hp > 0) {
    events.push({ type: "fighter_down", target: loadBalancerWarden.id });
  }

  // Staff Sage — Cache Warmer: any fighter who took damage AND has the
  // passive equipped gets primed for a free next cast. Persists across
  // turns until the next ability cast consumes the prime.
  let cacheWarmerPrimed = s.ability_state?.cache_warmer_primed ?? [];
  const damagedIds: ActorId[] = [];
  if (targetHpDamage > 0) damagedIds.push(target.id);
  if (protectPaladin && paladinProtectDamage > 0) damagedIds.push(protectPaladin.id);
  if (loadBalancerWarden && loadBalancerDamage > 0) damagedIds.push(loadBalancerWarden.id);
  for (const fid of damagedIds) {
    const updated = updatedFighters.find((f) => f.id === fid);
    if (!updated || updated.hp <= 0) continue;
    if (!fighterHasPassive(updated, "cache_warmer")) continue;
    if (cacheWarmerPrimed.includes(fid)) continue;
    cacheWarmerPrimed = [...cacheWarmerPrimed, fid];
    events.push({ type: "passive_cache_warmer_primed", actor: fid });
  }

  // Consume smite debuff for this monster's swing (hit or miss handled elsewhere for miss).
  const abilityStateAfterSmite = consumeSmiteDebuff(
    tickAbilityCountersAfterSwing(s.ability_state), actorId,
  );
  const abilityStateAfterPrime = cacheWarmerPrimed !== (s.ability_state?.cache_warmer_primed ?? [])
    ? { ...abilityStateAfterSmite, cache_warmer_primed: cacheWarmerPrimed }
    : abilityStateAfterSmite;

  let next: CombatState = {
    ...s,
    fighters: updatedFighters,
    ability_state: abilityStateAfterPrime,
    stats: {
      ...s.stats,
      [target.id]: {
        ...(s.stats[target.id] ?? { damage_taken: 0, healing_done: 0, shielding_done: 0, kills: 0 }),
        damage_taken: (s.stats[target.id]?.damage_taken ?? 0) + targetHpDamage,
      },
      ...(protectPaladin ? {
        [protectPaladin.id]: {
          ...(s.stats[protectPaladin.id] ?? { damage_taken: 0, healing_done: 0, shielding_done: 0, kills: 0 }),
          damage_taken: (s.stats[protectPaladin.id]?.damage_taken ?? 0) + paladinProtectDamage,
        },
      } : {}),
      ...(loadBalancerWarden ? {
        [loadBalancerWarden.id]: {
          ...(s.stats[loadBalancerWarden.id] ?? { damage_taken: 0, healing_done: 0, shielding_done: 0, kills: 0 }),
          damage_taken: (s.stats[loadBalancerWarden.id]?.damage_taken ?? 0) + loadBalancerDamage,
        },
      } : {}),
    },
    round_monster_targets: rmt,
  };

  // QA Paladin — Holy Rage: accumulate bonus damage for all alive Paladins.
  if (hpDamage > 0) {
    next = accumulateHolyRage(next, hpDamage);
  }

  // Elemental proc — fire/ice/lightning monster attacks can apply
  // burning / frozen / shocked to the target. 25% base, scaled down by
  // the target's resist_<type> stat. Skipped if the swing dropped them.
  if (targetNewHp > 0 && (attackDamageType === "fire" || attackDamageType === "ice" || attackDamageType === "lightning")) {
    const proc = applyMonsterElementalProc(
      next, monster, target.id, attackDamageType, targetResistPct, roll,
    );
    next = proc.state;
    events.push(...proc.events);

    // Lightning chain — arc to same-row allies. Each ally rolls an
    // independent proc with their own resist. Damage doesn't spread,
    // only the shocked status. Skips downed allies and the primary
    // target (already rolled above).
    if (attackDamageType === "lightning") {
      const targetRow = target.position;
      const chainTargets = next.fighters.filter((f) =>
        f.id !== target.id && f.hp > 0 && f.position === targetRow,
      );
      for (const ally of chainTargets) {
        const allyResist = ally.resistances?.lightning ?? 0;
        const chain = applyMonsterElementalProc(
          next, monster, ally.id, "lightning", allyResist, roll,
        );
        next = chain.state;
        events.push(...chain.events);
      }
    }
  }

  // QA Paladin — Lay on Hands. Trigger if the target survived but dropped
  // below the threshold. Skips if target died on the swing.
  if (newHp > 0) {
    const heal = applyPaladinAutoHeal(next, target.id, roll);
    next = heal.state;
    events.push(...heal.events);
  }

  // SRE Warden — Thorns. Deal 25% armor_power back to the attacker if target survived.
  if (newHp > 0) {
    const thorns = applyWardenThorns(next, target.id, actorId);
    next = thorns.state;
    events.push(...thorns.events);
    if (thorns.events.length > 0) {
      const thornedMonster = next.monsters.find((m) => m.id === actorId);
      if (thornedMonster && thornedMonster.hp <= 0) {
        return resolveMonsterKill(next, actorId, target.id, events);
      }
    }
  }


  const allDown = next.fighters.every((f) => f.hp <= 0);
  if (allDown) {
    events.push({ type: "defeat" });
    return { state: { ...next, status: "defeat" }, events };
  }
  next = advanceTurn(next, events);
  return { state: next, events: [...events, ...turnStartEvent(next)] };
}


// Executes a damage-dealing active ability: calls ability.execute(ctx) for the
// damage formula, then applies drink buffs, shocked amplifier, boss phase,
// elemental proc, and kill resolution.
function handleDamageAbility(
  state: CombatState,
  actorId: ActorId,
  tickedActor: CombatFighter,
  ability: ActiveAbilityDef,
  ctx: AbilityContext,
  monster: CombatMonster,
  preEvents: CombatEvent[],
  roll: RollFn,
): StepResult {
  const effects = ability.execute(ctx);
  const dmgEffect = effects.find(
    (e): e is Extract<AbilityEffect, { kind: "deal_damage" }> => e.kind === "deal_damage",
  );
  if (!dmgEffect) return reject(state, `${ability.id} produced no damage effect`);

  let amount = dmgEffect.amount;
  let isCrit = dmgEffect.is_crit ?? false;
  const formula = dmgEffect.formula;

  // QA Paladin — Holy Rage: consume accumulated bonus.
  const holyRageTotal = state.ability_state?.holy_rage?.[actorId] ?? 0;
  // R1 10%, R2 15%, R3 20% — matches the basic-attack path.
  const holyRagePct = 0.05 + 0.05 * fighterRank(tickedActor, "holy_rage");
  const holyRageBonusAbility = Math.floor(holyRageTotal * holyRagePct);
  const abilityStateAfterAnger = holyRageTotal > 0
    ? clearHolyRage(state.ability_state, actorId)
    : state.ability_state;
  amount += holyRageBonusAbility;
  // DevOps Mage — Observability: flat +1 per unique debuff on the enemy field.
  const obsBonus = observabilityBonus(state, tickedActor);
  amount += obsBonus;

  // Drink buff — only buff_next_crit applies to ability damage.
  const drinkResult = dmgEffect.drink_buff_context === "ability"
    ? applyDrinkBuff(state, actorId, "ability", amount, isCrit)
    : { damage: amount, forceCrit: false, event: null as CombatEvent | null, nextDrinkBuffs: state.drink_buffs };
  amount = drinkResult.damage;
  if (drinkResult.forceCrit) isCrit = true;

  // Frontend Bard — Earworm: refund mana to bards with the passive on any
  // ability crit. nextState isn't constructed yet so we operate on `state`
  // directly and the refund carries into the final nextState below.
  const abilityEarworm = applyEarwormOnCrit(state, isCrit);
  state = abilityEarworm.state;
  preEvents.push(...abilityEarworm.events);

  // Shocked amplifier.
  const sigShockedEffect = monster.effects.find((e) => e.type === "shocked");
  const sigShockMult = sigShockedEffect ? (sigShockedEffect.magnitude >= 2 ? 1.45 : 1.30) : 1.0;
  const sigVulnMult = vulnerabilityMult(state, monster.id, state.round);
  // Refactor Rogue — Cherry-Pick: +50% damage when the target is under 25% HP.
  // Only fires if the attacker has the cherry_pick passive equipped via the
  // talent tree; class kit doesn't auto-grant it.
  const cherryPickFighter = state.fighters.find((f) => f.id === actorId);
  const targetHpFrac = monster.max_hp > 0 ? monster.hp / monster.max_hp : 1;
  const cherryPickActive = !!cherryPickFighter
    && fighterHasPassive(cherryPickFighter, "cherry_pick")
    && targetHpFrac <= 0.25;
  // R1 ×1.5. R2 ×1.75. R3 ×2.0. Linear scaling on the execute bonus.
  const cherryPickMult = cherryPickActive && cherryPickFighter
    ? 1.0 + 0.5 * fighterRank(cherryPickFighter, "cherry_pick")
    : 1.0;
  const finalDamage = Math.round(amount * sigShockMult * sigVulnMult * cherryPickMult);

  const oldHp = monster.hp;
  const newHp = Math.max(0, oldHp - finalDamage);
  const monsterKilled = newHp <= 0;
  const phaseTransition =
    monster.is_boss &&
    monster.boss_phase === 1 &&
    isBossPhaseTransition(monster.max_hp, oldHp, newHp);

  const events: CombatEvent[] = [
    ...preEvents,
    {
      type: "player_hit",
      actor: actorId,
      target: monster.id,
      damage: finalDamage,
      armor_absorbed: 0, // ability damage bypasses monster armor
      crit: isCrit,
      formula: drinkResult.event ? `${formula} ×2 (lucky sip)` : formula,
    },
  ];
  if (drinkResult.event) events.push(drinkResult.event);
  if (holyRageBonusAbility > 0) events.push({ type: "passive_holy_rage", paladin: actorId, bonus: holyRageBonusAbility });

  let nextState: CombatState = {
    ...state,
    monsters: state.monsters.map((m) =>
      m.id === monster.id
        ? {
            ...m,
            hp: newHp,
            ...(phaseTransition ? { boss_phase: 2 as const, shield: m.tier } : {}),
          }
        : m,
    ),
    contribution: {
      ...state.contribution,
      [actorId]: (state.contribution[actorId] ?? 0) + finalDamage,
    },
    ...(drinkResult.event ? { drink_buffs: drinkResult.nextDrinkBuffs } : {}),
    ...(abilityStateAfterAnger !== state.ability_state ? { ability_state: abilityStateAfterAnger } : {}),
  };

  if (phaseTransition) events.push({ type: "boss_phase_transition", new_phase: 2 });

  // Apply any non-damage effects returned by execute() (e.g. Smite debuff).
  if (!monsterKilled) {
    for (const effect of effects) {
      if (effect.kind === "apply_smite_debuff") {
        const prev = nextState.ability_state?.paladin_smite_debuff ?? {};
        const ability_state: AbilityRuntimeState = {
          ...(nextState.ability_state ?? {}),
          paladin_smite_debuff: { ...prev, [effect.target_id]: 1 },
        };
        nextState = { ...nextState, ability_state };
        events.push({ type: "ability_smite_debuff", actor: actorId, target: effect.target_id });
      }
    }
  }

  // Sinister Queries passive — applies bleed on any ability damage hit.
  if (!monsterKilled) {
    const sq = applySinisterQueries(nextState, tickedActor, monster.id);
    nextState = sq.state;
    events.push(...sq.events);
    const hexProc = applyHexBleedProc(nextState, monster.id);
    nextState = hexProc.state;
    events.push(...hexProc.events);
  }

  // Rogue — Lethal Strikes: crits apply bleed.
  if (isCrit && !monsterKilled) {
    const ls = applyRogueLethalStrike(nextState, tickedActor, monster.id);
    nextState = ls.state;
    events.push(...ls.events);
  }

  // Rogue — Envenom Weapon: next hit after ability applies poison.
  if (!monsterKilled) {
    const env = applyEnvenomProc(nextState, tickedActor, monster.id);
    nextState = env.state;
    events.push(...env.events);
  }

  // Elemental weapon proc.
  if (!monsterKilled) {
    const proc = applyElementalProc(nextState, tickedActor, monster.id, roll);
    nextState = proc.state;
    events.push(...proc.events);
  }

  // ── AoE blast around the primary target ──
  // When the ability declares `aoe_radius_tiles`, the same damage instance
  // (scaled by SPLASH_MULT) fires on every other live enemy whose pos lies
  // within radius hexes of the primary target. Uses cube-distance.
  const aoeRadius = ability.aoe_radius_tiles ?? 0;
  if (aoeRadius > 0 && monster.pos && state.hex_range_enabled) {
    const SPLASH_MULT = 0.6;
    const splashDamage = Math.max(1, Math.round(finalDamage * SPLASH_MULT));
    const primaryPos = monster.pos;
    const splashTargets = nextState.monsters.filter((m) =>
      m.id !== monster.id
      && m.hp > 0
      && m.pos
      && hexDistance(primaryPos, m.pos) <= aoeRadius,
    );
    for (const splashMonster of splashTargets) {
      const splashOldHp = splashMonster.hp;
      const splashNewHp = Math.max(0, splashOldHp - splashDamage);
      events.push({
        type: "player_hit",
        actor: actorId,
        target: splashMonster.id,
        damage: splashDamage,
        armor_absorbed: 0,
        crit: false,
        formula: `${formula} (splash)`,
      });
      nextState = {
        ...nextState,
        monsters: nextState.monsters.map((m) => m.id === splashMonster.id ? { ...m, hp: splashNewHp } : m),
        contribution: {
          ...nextState.contribution,
          [actorId]: (nextState.contribution[actorId] ?? 0) + splashDamage,
        },
      };
    }
  }

  if (monsterKilled) return resolveMonsterKill(nextState, monster.id, actorId, events);
  nextState = advanceTurn(nextState, events);
  return { state: nextState, events: [...events, ...turnStartEvent(nextState)] };
}

// AoE variant: execute() is called once and returns one deal_damage per live
// monster. Applies all hits, then resolves kills (victory if all dead, otherwise
// advance turn). No drink-buff or shocked-amp logic — AoE trades per-target
// modifiers for reach.
function handleAoeDamageAbility(
  state: CombatState,
  actorId: ActorId,
  tickedActor: CombatFighter,
  ability: ActiveAbilityDef,
  preEvents: CombatEvent[],
  roll: RollFn,
): StepResult {
  const liveMonsters = state.monsters.filter((m) => m.hp > 0);
  const ctx: AbilityContext = {
    caster: tickedActor,
    party: state.fighters.filter((f) => f.hp > 0),
    monsters: liveMonsters,
    roll,
    rank: tickedActor.talent_ranks?.[ability.id] ?? 1,
  };

  const effects = ability.execute(ctx);
  let dmgEffects = effects.filter(
    (e): e is Extract<AbilityEffect, { kind: "deal_damage" }> => e.kind === "deal_damage",
  );
  if (dmgEffects.length === 0) return reject(state, `${ability.id} produced no AoE damage effects`);

  // Radius gate: when the AoE declares `aoe_radius_tiles`, the burst is
  // centered on the caster and only enemies within that hex distance take
  // damage. Without this, an "all enemies" ability hits everything anywhere
  // on the field — fine for global buffs, wrong for a fireball that should
  // reward positioning. Skipped when hex positions aren't tracked (Slack
  // combat + unit tests) since distance is meaningless there.
  const aoeRadius = ability.aoe_radius_tiles ?? 0;
  if (state.hex_range_enabled && tickedActor.pos && aoeRadius > 0) {
    const casterPos = tickedActor.pos;
    const inRange = dmgEffects.filter((e) => {
      const m = state.monsters.find((mm) => mm.id === e.target_id);
      if (!m?.pos) return true;
      return hexDistance(casterPos, m.pos) <= aoeRadius;
    });
    if (inRange.length === 0) {
      return reject(state, `no enemies within ${aoeRadius} hexes for ${ability.name}`);
    }
    dmgEffects = inRange;
  }

  // LOS gate: caster needs line of sight to each individual target. Without
  // this, an "all enemies" damage AoE (e.g. mage Prod Fire) curves around
  // every obstacle on the field. Skipped for melee weapons (an AoE on a
  // melee caster represents a burst centered on them, not a projected one)
  // and when hex_range_enabled is off (Slack combat + unit tests don't use
  // hex positions).
  const casterWeaponRange = tickedActor.weapon_range ?? "melee";
  if (state.hex_range_enabled && tickedActor.pos && casterWeaponRange !== "melee") {
    const obstacles = state.obstacles ?? [];
    const casterPos = tickedActor.pos;
    const visibleEffects = dmgEffects.filter((e) => {
      const m = state.monsters.find((mm) => mm.id === e.target_id);
      if (!m?.pos) return true;
      return hexLos(casterPos, m.pos, obstacles);
    });
    if (visibleEffects.length === 0) {
      return reject(state, `no line of sight to any target for ${ability.name}`);
    }
    dmgEffects = visibleEffects;
  }

  const events: CombatEvent[] = [...preEvents];
  let nextState: CombatState = state;

  for (const dmgEffect of dmgEffects) {
    const monster = nextState.monsters.find((m) => m.id === dmgEffect.target_id && m.hp > 0);
    if (!monster) continue; // already killed earlier in this loop

    const finalDamage = dmgEffect.amount;
    const newHp = Math.max(0, monster.hp - finalDamage);

    events.push({
      type: "player_hit",
      actor: actorId,
      target: monster.id,
      damage: finalDamage,
      armor_absorbed: 0,
      crit: dmgEffect.is_crit ?? false,
      formula: dmgEffect.formula,
    });

    nextState = {
      ...nextState,
      monsters: nextState.monsters.map((m) => m.id === monster.id ? { ...m, hp: newHp } : m),
      contribution: {
        ...nextState.contribution,
        [actorId]: (nextState.contribution[actorId] ?? 0) + finalDamage,
      },
    };

    // Elemental procs on AoE hits — only fires on survivors (a dead target
    // can't be on fire). Same roll cadence as the single-target deal_damage
    // path: one d100 per chance per target. Per-target roll matches how the
    // monster-side weapon proc works.
    if (newHp > 0) {
      if (dmgEffect.burn_chance && roll(100) <= dmgEffect.burn_chance) {
        const burnMag = 1;
        const burnDur = 3;
        const burnEff: MachineStatusEffect = { type: "burning", magnitude: burnMag, remaining: burnDur, source: actorId };
        nextState = { ...nextState, monsters: nextState.monsters.map((m) => m.id === monster.id ? { ...m, effects: mergeEffect(m.effects, burnEff) } : m) };
        events.push({ type: "ability_burn_applied", actor: actorId, target: monster.id, magnitude: burnMag, duration: burnDur });
      }
      if (dmgEffect.shock_chance && roll(100) <= dmgEffect.shock_chance) {
        const shockMag = 1;
        const shockDur = 2;
        const shockEff: MachineStatusEffect = { type: "shocked", magnitude: shockMag, remaining: shockDur, source: actorId };
        nextState = { ...nextState, monsters: nextState.monsters.map((m) => m.id === monster.id ? { ...m, effects: mergeEffect(m.effects, shockEff) } : m) };
        events.push({ type: "ability_shock_applied", actor: actorId, target: monster.id, magnitude: shockMag, duration: shockDur });
      }
    }
  }

  // Check kills after all damage is applied.
  const killedIds = nextState.monsters.filter((m) => m.hp <= 0).map((m) => m.id);

  if (killedIds.length === 0) {
    nextState = advanceTurn(nextState, events);
    return { state: nextState, events: [...events, ...turnStartEvent(nextState)] };
  }

  // At least one monster killed — run resolveMonsterKill once for the last
  // one (it checks all monsters to decide victory vs. continue).
  for (let i = 0; i < killedIds.length - 1; i++) {
    events.push({ type: "monster_down", killed_by: actorId });
    nextState = {
      ...nextState,
      stats: {
        ...nextState.stats,
        [actorId]: {
          ...(nextState.stats[actorId] ?? { damage_taken: 0, healing_done: 0, shielding_done: 0, kills: 0 }),
          kills: (nextState.stats[actorId]?.kills ?? 0) + 1,
        },
      },
    };
  }
  return resolveMonsterKill(nextState, killedIds[killedIds.length - 1], actorId, events);
}

function handleFlee(
  state: CombatState,
  action: { kind: "flee"; actor: ActorId },
  roll: RollFn,
): StepResult {
  const actor = state.fighters.find((f) => f.id === action.actor);
  if (!actor) return reject(state, `unknown actor: ${action.actor}`);
  if (currentActor(state) !== action.actor) {
    return reject(state, `not ${action.actor}'s turn`);
  }
  if (actor.hp <= 0) return reject(state, `${action.actor} is downed`);

  // Guardian aura: a fighter adjacent to a guardian-aura monster can't flee.
  if (actor.pos) {
    const guardian = state.monsters.find(
      (m) => m.hp > 0 && m.pos && m.specials?.includes("guardian_aura") && hexDistance(actor.pos!, m.pos) <= 1,
    );
    if (guardian) {
      return reject(state, `${guardian.name} blocks your escape`);
    }
  }

  const tick = tickAtTurnStart(state, action.actor);
  if (tick.earlyReturn) return tick.earlyReturn;
  const s = tick.state;
  const tickedActor = s.fighters.find((f) => f.id === action.actor)!;

  // d20 + max(atk, mag) vs DC = 10 + monster.tier. Flexible — fighter-y
  // classes get atk, caster-y classes get mag; nobody is locked out.
  const fleeMonster = s.monsters.find((m) => m.hp > 0) ?? s.monsters[0];
  const d20 = roll(20);
  const modifier = Math.max(tickedActor.attack_mod, tickedActor.magic_mod);
  const dc = 10 + (fleeMonster?.tier ?? 1);
  const total = d20 + modifier;
  // Natural 20 always escapes — a perfect roll should never punish the player.
  const success = d20 === 20 || total >= dc;

  const events: CombatEvent[] = [
    ...tick.events,
    { type: "roll", actor: action.actor, die: "d20", value: d20, purpose: "flee_check" },
    { type: "flee_check", actor: action.actor, roll: d20, modifier, total, dc, success },
  ];

  if (success) {
    events.push({ type: "fled" });
    return { state: { ...s, status: "fled" }, events };
  }

  // Failed flee: free hit from the monster. No d20 to hit (you're exposed),
  // no armor mitigation (back turned) — treat as physical with 0 armor.
  const alive = s.fighters.filter((f) => f.hp > 0);
  const bossPhase2 = (fleeMonster?.is_boss && fleeMonster?.boss_phase === 2) ?? false;
  const hit = resolveMonsterHit(fleeMonster?.tier ?? 1, alive.length, 0, bossPhase2, roll, "physical", 0, fleeMonster?.damage_roll ?? "1d4");
  const { newShield, newHp, shieldAbsorbed, hpDamage } = applyDamageWithShield(
    hit.final,
    tickedActor.shield,
    tickedActor.hp,
  );

  events.push({
    type: "monster_attack",
    actor: fleeMonster?.id ?? MONSTER_ID,
    target: action.actor,
    damage_type: "physical",
    raw_damage: hit.raw,
    damage_after_position: hit.final,
    damage_after_mitigation: hit.final,
    armor_reduction: hit.armorReduction,
    resistance_reduction: 0,
    shield_absorbed: shieldAbsorbed,
    hp_damage: hpDamage,
  });

  const updatedFighters = s.fighters.map((f) =>
    f.id === action.actor ? { ...f, hp: Math.max(0, newHp), shield: newShield } : f,
  );
  if (newHp <= 0 && tickedActor.hp > 0) {
    events.push({ type: "fighter_down", target: action.actor });
  }
  const allDown = updatedFighters.every((f) => f.hp <= 0);
  let next: CombatState = {
    ...s,
    fighters: updatedFighters,
    stats: {
      ...s.stats,
      [action.actor]: {
        ...(s.stats[action.actor] ?? { damage_taken: 0, healing_done: 0, shielding_done: 0, kills: 0 }),
        damage_taken: (s.stats[action.actor]?.damage_taken ?? 0) + hpDamage,
      },
    },
  };
  if (allDown) {
    events.push({ type: "defeat" });
    return { state: { ...next, status: "defeat" }, events };
  }
  next = advanceTurn(next, events);
  return { state: next, events: [...events, ...turnStartEvent(next)] };
}

// ── Class abilities ───────────────────────────────────────────────────────
//
// Single entry point. Looks up the ActiveAbilityDef from the actor's class,
// validates mana, then routes based on ability.routing:
//   "aoe_damage"  — AoE path (no per-target modifiers)
//   "damage"      — single-target damage (drink buffs, shocked amp, bleed, etc.)
//   "utility"     — generic effect applicator driven by execute() output

function handleAbility(
  state: CombatState,
  action: {
    kind: "ability";
    actor: ActorId;
    ability_id: AbilityId;
    target_id?: ActorId;
    target?: ActorId;
    position?: BattlePosition;
    target_pos?: HexPos;
  },
  roll: RollFn,
): StepResult {
  const fighter = state.fighters.find((f) => f.id === action.actor);
  if (!fighter) return reject(state, `unknown actor: ${action.actor}`);
  if (currentActor(state) !== action.actor) {
    return reject(state, `not ${action.actor}'s turn`);
  }
  if (fighter.hp <= 0) return reject(state, `${action.actor} is downed`);

  const cls = classByName(fighter.class);
  // Look up the active ability in the class kit first, then fall back to the
  // talent-tree registry for new nodes (Rolling Restart, Sanity Check, etc.)
  // that aren't in the legacy per-class arrays.
  let ability = cls.abilities.find(
    (a): a is ActiveAbilityDef => a.kind === "active" && a.id === action.ability_id,
  );
  if (!ability) {
    const node = ALL_TALENT_NODES.find((n) => n.id === action.ability_id);
    if (node && node.ability.kind === "active" && node.class_id === cls.id) {
      ability = node.ability;
    }
  }
  if (!ability) {
    return reject(state, `${fighter.class} has no active ability with id ${action.ability_id}`);
  }

  // Staff Sage — Memoization: first cast of each distinct ability id per fight
  // is mana-free. The check happens BEFORE the mana_cost gate so a Sage with
  // Memoization can fire their pricey abilities even when nearly empty.
  const memoCastsPrior = state.ability_state?.memoization_casts?.[action.actor] ?? [];
  const memoActive = fighterHasPassive(fighter, "memoization") && !memoCastsPrior.includes(ability.id);
  // Staff Sage — Cache Warmer: a Sage who took damage since their last cast
  // gets one free cast. Same check shape as Memoization; either passive can
  // independently zero the cost.
  const cacheWarmerPriorPrimed = state.ability_state?.cache_warmer_primed ?? [];
  const cacheWarmerActive = fighterHasPassive(fighter, "cache_warmer") && cacheWarmerPriorPrimed.includes(action.actor);
  const effectiveManaCost = (memoActive || cacheWarmerActive) ? 0 : ability.mana_cost;
  if (fighter.mana < effectiveManaCost) {
    return reject(state, `not enough mana (need ${effectiveManaCost})`);
  }
  const remainingCooldown = state.cooldowns?.[action.actor]?.[ability.id] ?? 0;
  if (remainingCooldown > 0) {
    return reject(state, `${ability.name} is on cooldown (${remainingCooldown} turn${remainingCooldown !== 1 ? "s" : ""} remaining)`);
  }

  const tick = tickAtTurnStart(state, action.actor);
  if (tick.earlyReturn) return tick.earlyReturn;
  const s = tick.state;
  const tickedActor = s.fighters.find((f) => f.id === action.actor)!;

  const sPostMana: CombatState = {
    ...s,
    fighters: s.fighters.map((f) =>
      f.id === action.actor ? { ...f, mana: Math.max(0, f.mana - effectiveManaCost) } : f,
    ),
    ...(ability.cooldown_turns ? {
      cooldowns: {
        ...(s.cooldowns ?? {}),
        [action.actor]: {
          ...(s.cooldowns?.[action.actor] ?? {}),
          [ability.id]: ability.cooldown_turns + 1,
        },
      },
    } : {}),
    ...(memoActive || cacheWarmerActive ? {
      ability_state: {
        ...(s.ability_state ?? {}),
        ...(memoActive ? {
          memoization_casts: {
            ...(s.ability_state?.memoization_casts ?? {}),
            [action.actor]: [...memoCastsPrior, ability.id],
          },
        } : {}),
        ...(cacheWarmerActive ? {
          cache_warmer_primed: cacheWarmerPriorPrimed.filter((id) => id !== action.actor),
        } : {}),
      },
    } : {}),
  };

  const usedEvent: CombatEvent = {
    type: "ability_used",
    actor: action.actor,
    ability_id: ability.id,
    name: ability.name,
    mana_spent: effectiveManaCost,
  };
  const preEvents: CombatEvent[] = [...tick.events, usedEvent];
  if (cacheWarmerActive) preEvents.push({ type: "passive_cache_warmer_freed", actor: action.actor, ability_id: ability.id });

  // ── AoE damage ──
  if (ability.routing === "aoe_damage") {
    if (sPostMana.monsters.filter((m) => m.hp > 0).length === 0) return reject(sPostMana, "no valid targets");
    return handleAoeDamageAbility(sPostMana, action.actor, tickedActor, ability, preEvents, roll);
  }

  // ── Single-target damage ──
  if (ability.routing === "damage") {
    const targetMonster = action.target_id
      ? sPostMana.monsters.find((m) => m.id === action.target_id && m.hp > 0)
      : sPostMana.monsters.find((m) => m.hp > 0);
    if (!targetMonster) return reject(sPostMana, "no valid target");
    // Hex range + LOS gate for single_enemy abilities. Mirrors the basic
    // attack check. Abilities inherit weapon range unless they declare
    // their own `range_tiles`.
    if (
      sPostMana.hex_range_enabled
      && tickedActor.pos
      && targetMonster.pos
      && ability.target === "single_enemy"
    ) {
      const abilityRange = ability.range_tiles ?? fighterRangeTiles(tickedActor);
      const dist = hexDistance(tickedActor.pos, targetMonster.pos);
      if (dist > abilityRange) {
        return reject(sPostMana, `${ability.name} is out of range (${dist} > ${abilityRange})`);
      }
      const weaponRange = tickedActor.weapon_range ?? "melee";
      if (weaponRange !== "melee" && !hexLos(tickedActor.pos, targetMonster.pos, sPostMana.obstacles ?? [])) {
        return reject(sPostMana, `no line of sight for ${ability.name}`);
      }
    }
    const ctx: AbilityContext = {
      caster: tickedActor,
      party: sPostMana.fighters.filter((f) => f.hp > 0),
      monsters: sPostMana.monsters.filter((m) => m.hp > 0),
      target: targetMonster,
      roll,
      rank: tickedActor.talent_ranks?.[ability.id] ?? 1,
    };
    return handleDamageAbility(sPostMana, action.actor, tickedActor, ability, ctx, targetMonster, preEvents, roll);
  }

  // ── Utility ──
  // Resolve the target for execute() based on ability.target kind.
  let ctxTarget: CombatFighter | CombatMonster | undefined;
  if (ability.target === "single_enemy") {
    ctxTarget = action.target_id
      ? sPostMana.monsters.find((m) => m.id === action.target_id && m.hp > 0)
      : sPostMana.monsters.find((m) => m.hp > 0);
  } else if (ability.target === "single_ally") {
    ctxTarget = sPostMana.fighters.find((f) => f.id === (action.target ?? action.actor) && f.hp > 0);
  } else if (ability.target === "any") {
    // target_id = monster pick; target = fighter pick
    ctxTarget = action.target_id
      ? sPostMana.monsters.find((m) => m.id === action.target_id && m.hp > 0)
      : sPostMana.fighters.find((f) => f.id === action.target && f.hp > 0);
  } else if (ability.target === "self") {
    ctxTarget = tickedActor;
  }
  // Hex range + LOS gate for utility abilities targeting a single enemy.
  // Mirrors the identical check on the "damage" routing above — utility
  // abilities that declare range_tiles (e.g. Containerize) must respect it.
  if (
    ability.target === "single_enemy"
    && sPostMana.hex_range_enabled
    && tickedActor.pos
    && ctxTarget && "pos" in ctxTarget && ctxTarget.pos
  ) {
    const abilityRange = ability.range_tiles ?? fighterRangeTiles(tickedActor);
    const dist = hexDistance(tickedActor.pos, ctxTarget.pos);
    if (dist > abilityRange) {
      return reject(sPostMana, `${ability.name} is out of range (${dist} > ${abilityRange})`);
    }
    const weaponRange = tickedActor.weapon_range ?? "melee";
    if (weaponRange !== "melee" && !hexLos(tickedActor.pos, ctxTarget.pos, sPostMana.obstacles ?? [])) {
      return reject(sPostMana, `no line of sight for ${ability.name}`);
    }
  }
  // Ground-targeted abilities: require a target_pos in-bounds and within
  // range of the caster. The ability's execute() reads ctx.target_pos and
  // bakes the shape into a place_ground_effect AbilityEffect.
  if (ability.target === "ground") {
    if (!action.target_pos) return reject(sPostMana, `${ability.name} requires a hex target`);
    const grid = sPostMana.grid ?? GRID_DEFAULT;
    if (!inBounds(action.target_pos, grid)) {
      return reject(sPostMana, `target hex (${action.target_pos.q},${action.target_pos.r}) is out of bounds`);
    }
    if (sPostMana.hex_range_enabled && tickedActor.pos) {
      const abilityRange = ability.range_tiles ?? fighterRangeTiles(tickedActor);
      const dist = hexDistance(tickedActor.pos, action.target_pos);
      if (dist > abilityRange) {
        return reject(sPostMana, `${ability.name} is out of range (${dist} > ${abilityRange})`);
      }
      const weaponRange = tickedActor.weapon_range ?? "melee";
      if (weaponRange !== "melee" && !hexLos(tickedActor.pos, action.target_pos, sPostMana.obstacles ?? [])) {
        return reject(sPostMana, `no line of sight for ${ability.name}`);
      }
    }
  }
  const protectForCtx = sPostMana.ability_state?.paladin_protect;
  const ctx: AbilityContext = {
    caster: tickedActor,
    party: sPostMana.fighters.filter((f) => f.hp > 0),
    monsters: sPostMana.monsters.filter((m) => m.hp > 0),
    target: ctxTarget,
    roll,
    position: action.position,
    protected_ally_id: protectForCtx?.paladin_id === action.actor ? protectForCtx?.target_id : undefined,
    rank: tickedActor.talent_ranks?.[ability.id] ?? 1,
    target_pos: action.target_pos,
  };
  return applyUtilityAbilityEffects(sPostMana, ability.execute(ctx), action.actor, preEvents, roll);
}

// Generic applicator for utility ability effects. Iterates AbilityEffect[] from
// execute() and applies each one to state, collecting events. A deal_damage that
// kills a monster immediately fires resolveMonsterKill; remaining effects are skipped.
function applyUtilityAbilityEffects(
  state: CombatState,
  effects: AbilityEffect[],
  actor: ActorId,
  preEvents: CombatEvent[],
  roll: RollFn,
): StepResult {
  let s = state;
  const events: CombatEvent[] = [...preEvents];

  // If the acting fighter has a focus weapon equipped, their focus_power is
  // added as a flat bonus to every heal and single-target shield they apply.
  // This is the mechanic described in the item text ("boosts heal + shield by
  // their power") — previously the field existed but was never read here.
  // grant_shield_all (Warden tank ability) and grant_shield_from_armor
  // (fraction-of-armor calc) are intentionally excluded.
  const actorFighter = s.fighters.find((f) => f.id === actor);
  const focusBonus = actorFighter?.focus_power ?? 0;

  for (const effect of effects) {
    switch (effect.kind) {
      case "deal_damage": {
        const monster = s.monsters.find((m) => m.id === effect.target_id && m.hp > 0);
        if (!monster) continue;
        const ddWeakness = effect.damage_type && monster.damage_weakness === effect.damage_type ? 1.3 : 1.0;
        const ddResist = effect.damage_type && monster.damage_resistance === effect.damage_type ? 0.7 : 1.0;
        const ddAmount = Math.max(1, Math.round(effect.amount * ddWeakness * ddResist));
        const newHp = Math.max(0, monster.hp - ddAmount);
        events.push({
          type: "player_hit",
          actor,
          target: monster.id,
          damage: ddAmount,
          armor_absorbed: 0,
          crit: effect.is_crit ?? false,
          formula: effect.formula,
          damage_type: effect.damage_type,
        });
        s = {
          ...s,
          monsters: s.monsters.map((m) => m.id === monster.id ? { ...m, hp: newHp } : m),
          contribution: { ...s.contribution, [actor]: (s.contribution[actor] ?? 0) + ddAmount },
        };
        s = accumulateIllOmenDamage(s, monster.id, monster.hp - newHp);
        if (newHp <= 0) return resolveMonsterKill(s, monster.id, actor, events);
        // Sinister Queries passive and hex bleed proc fire on any damage hit.
        const casterFighter = s.fighters.find((f) => f.id === actor);
        if (casterFighter) {
          const sq = applySinisterQueries(s, casterFighter, monster.id);
          s = sq.state;
          events.push(...sq.events);
        }
        const hexProc = applyHexBleedProc(s, monster.id);
        s = hexProc.state;
        events.push(...hexProc.events);
        // Elemental procs (Mage Fireball burn / Lightning shock). Same roll
        // pattern as Sage Ray of Frost — roll d100 after the damage lands;
        // only fires when the target is still alive (the kill path above
        // returns early before we get here).
        if (effect.burn_chance && roll(100) <= effect.burn_chance) {
          const burnMag = 1;
          const burnDur = 3;
          const burnEff: MachineStatusEffect = { type: "burning", magnitude: burnMag, remaining: burnDur, source: actor };
          s = { ...s, monsters: s.monsters.map((m) => m.id === monster.id ? { ...m, effects: mergeEffect(m.effects, burnEff) } : m) };
          events.push({ type: "ability_burn_applied", actor, target: monster.id, magnitude: burnMag, duration: burnDur });
        }
        if (effect.shock_chance && roll(100) <= effect.shock_chance) {
          const shockMag = 1;
          const shockDur = 2;
          const shockEff: MachineStatusEffect = { type: "shocked", magnitude: shockMag, remaining: shockDur, source: actor };
          s = { ...s, monsters: s.monsters.map((m) => m.id === monster.id ? { ...m, effects: mergeEffect(m.effects, shockEff) } : m) };
          events.push({ type: "ability_shock_applied", actor, target: monster.id, magnitude: shockMag, duration: shockDur });
        }
        break;
      }
      case "heal": {
        const target = s.fighters.find((f) => f.id === effect.target_id);
        if (!target || target.hp <= 0) continue;
        const healTotal = effect.amount + focusBonus;
        const newHp = Math.min(target.max_hp, target.hp + healTotal);
        const applied = newHp - target.hp;
        if (applied > 0) {
          events.push({ type: "heal_applied", actor, target: effect.target_id, amount: applied, rolled: healTotal });
          s = { ...s, fighters: s.fighters.map((f) => f.id === effect.target_id ? { ...f, hp: newHp } : f) };
        }
        break;
      }
      case "grant_shield": {
        const target = s.fighters.find((f) => f.id === effect.target_id);
        if (!target || target.hp <= 0) continue;
        const shieldCap = target.max_hp * SHIELD_CAP_MULTIPLIER + resilientBonus(target, s.ability_state, s.round);
        const newShield = Math.min(shieldCap, target.shield + effect.amount + focusBonus);
        const restored = newShield - target.shield;
        if (restored > 0) {
          events.push({ type: "shield_applied", actor, target: effect.target_id, restored, new_armor: newShield, bonus_barrier: false });
          s = { ...s, fighters: s.fighters.map((f) => f.id === effect.target_id ? { ...f, shield: newShield } : f) };
        }
        break;
      }
      case "grant_shield_all": {
        const grants: { target: ActorId; amount: number }[] = [];
        s = {
          ...s,
          fighters: s.fighters.map((f) => {
            if (f.hp <= 0) return f;
            const cap = f.max_hp * SHIELD_CAP_MULTIPLIER + resilientBonus(f, s.ability_state, s.round);
            const newShield = Math.min(cap, f.shield + effect.amount);
            const added = newShield - f.shield;
            if (added > 0) grants.push({ target: f.id, amount: added });
            return added > 0 ? { ...f, shield: newShield } : f;
          }),
        };
        events.push({ type: "ability_regression_shield", actor, grants });
        break;
      }
      case "grant_shield_from_armor": {
        const target = s.fighters.find((f) => f.id === effect.target_id);
        if (!target || target.hp <= 0) continue;
        const effectiveArmor = target.armor_power + resilientBonus(target, s.ability_state, s.round);
        const shieldCap = target.max_hp * SHIELD_CAP_MULTIPLIER + resilientBonus(target, s.ability_state, s.round);
        const newShield = Math.min(shieldCap, target.shield + Math.floor(effectiveArmor * effect.fraction));
        const restored = newShield - target.shield;
        if (restored > 0) {
          events.push({ type: "shield_applied", actor, target: effect.target_id, restored, new_armor: newShield, bonus_barrier: false });
          s = { ...s, fighters: s.fighters.map((f) => f.id === effect.target_id ? { ...f, shield: newShield } : f) };
        }
        break;
      }
      case "stun_monster": {
        const targetMonster = s.monsters.find((m) => m.id === effect.target_id && m.hp > 0);
        if (!targetMonster) continue;
        const isBoss = targetMonster.is_boss;
        const bpt = (isBoss && effect.boss_break_pct_per_turn != null)
          ? effect.boss_break_pct_per_turn
          : effect.break_pct_per_turn;
        const stunnedEffect: MachineStatusEffect = {
          type: "stunned",
          magnitude: bpt,
          remaining: 5,
          source: actor,
          pill_suffix: `${Math.min(100, bpt)}% break`,
        };
        s = {
          ...s,
          monsters: s.monsters.map((m) =>
            m.id === targetMonster.id
              ? { ...m, effects: [...m.effects.filter((e) => e.type !== "stunned"), stunnedEffect] }
              : m,
          ),
        };
        events.push({ type: "ability_containerize" });
        break;
      }
      case "restore_mana": {
        const target = s.fighters.find((f) => f.id === effect.target_id);
        if (!target) continue;
        const newMana = Math.min(target.max_mana, target.mana + effect.amount);
        if (newMana > target.mana) {
          s = { ...s, fighters: s.fighters.map((f) => f.id === effect.target_id ? { ...f, mana: newMana } : f) };
        }
        break;
      }
      case "set_taunt": {
        const ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          taunt: { actor_id: effect.actor_id, swings_remaining: effect.swings },
        };
        s = { ...s, ability_state };
        events.push({ type: "ability_taunt", actor: effect.actor_id, swings: effect.swings });
        break;
      }
      case "set_vanish": {
        const prev = s.ability_state?.vanished ?? {};
        let ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          vanished: { ...prev, [effect.actor_id]: effect.swings },
        };
        if (ability_state.taunt?.actor_id === effect.actor_id) {
          ability_state = stripField(ability_state, "taunt") ?? {};
        }
        s = { ...s, ability_state };
        events.push({ type: "ability_vanish", actor: effect.actor_id, swings: effect.swings });
        break;
      }
      case "add_battle_hymn": {
        const expiresAfterRound = s.round + effect.rounds - 1;
        const ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          battle_hymn: { expires_after_round: expiresAfterRound },
        };
        s = { ...s, ability_state };
        events.push({ type: "ability_battle_hymn", actor, expires_after_round: expiresAfterRound });
        break;
      }
      case "move_fighter": {
        const target = s.fighters.find((f) => f.id === effect.target_id);
        if (!target || target.hp <= 0) continue;
        const from = target.position;
        s = { ...s, fighters: s.fighters.map((f) => f.id === effect.target_id ? { ...f, position: effect.to } : f) };
        events.push({ type: "ability_migrate", actor, target: effect.target_id, from, to: effect.to });
        break;
      }
      case "hex_monster": {
        const target = s.monsters.find((m) => m.id === effect.target_id && m.hp > 0);
        if (!target) break;
        const hexEffect: MachineStatusEffect = {
          type: "hexed",
          magnitude: 1,
          remaining: effect.duration,
          source: actor,
        };
        s = {
          ...s,
          monsters: s.monsters.map((m) =>
            m.id === target.id ? { ...m, effects: mergeEffect(m.effects, hexEffect) } : m,
          ),
        };
        events.push({ type: "ability_hex", actor, target: target.id, duration: effect.duration });
        break;
      }
      case "consume_monster_bleed": {
        const target = s.monsters.find((m) => m.id === effect.target_id && m.hp > 0);
        if (!target) break;
        s = {
          ...s,
          monsters: s.monsters.map((m) =>
            m.id === target.id ? { ...m, effects: m.effects.filter((e) => e.type !== "bleeding") } : m,
          ),
        };
        break;
      }
      case "grant_encourage": {
        const prev = s.ability_state?.encourage ?? {};
        const prevCharges = prev[effect.target_id] ?? 0;
        const ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          encourage: { ...prev, [effect.target_id]: prevCharges + effect.charges },
        };
        s = { ...s, ability_state };
        events.push({ type: "ability_encourage", actor, target: effect.target_id, charges: effect.charges });
        break;
      }
      case "apply_discourage": {
        const prev = s.ability_state?.discourage ?? {};
        const prevCharges = prev[effect.target_id] ?? 0;
        const ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          discourage: { ...prev, [effect.target_id]: prevCharges + effect.charges },
        };
        s = { ...s, ability_state };
        events.push({ type: "ability_mock", actor, target: effect.target_id, charges: effect.charges });
        break;
      }
      case "apply_shield_of_faith": {
        const expiresAfterRound = s.round + effect.rounds - 1;
        const ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          shield_of_faith: { expires_after_round: expiresAfterRound },
        };
        s = { ...s, ability_state };
        events.push({ type: "ability_shield_of_faith", actor, expires_after_round: expiresAfterRound });
        break;
      }
      case "apply_protect": {
        const ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          paladin_protect: { paladin_id: actor, target_id: effect.target_id },
        };
        s = { ...s, ability_state };
        events.push({ type: "ability_protect", actor, target: effect.target_id });
        break;
      }
      case "apply_smite_debuff": {
        const prev = s.ability_state?.paladin_smite_debuff ?? {};
        const ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          paladin_smite_debuff: { ...prev, [effect.target_id]: 1 },
        };
        s = { ...s, ability_state };
        events.push({ type: "ability_smite_debuff", actor, target: effect.target_id });
        break;
      }
      case "attack_roll_damage": {
        // Machine-side d20 hit check with optional advantage. Calls the same
        // encourage/advantage logic as handleAttack; on a miss the loop continues
        // to the next effect (turn will advance after all effects are processed).
        const targetMonster = s.monsters.find((m) => m.id === effect.target_id && m.hp > 0);
        if (!targetMonster) continue;
        const fighter = s.fighters.find((f) => f.id === actor);
        if (!fighter) continue;

        let d20 = roll(20);
        const encourageCharges = s.ability_state?.encourage?.[actor] ?? 0;
        if (encourageCharges > 0 || effect.advantage) {
          const d20b = roll(20);
          const took = Math.max(d20, d20b);
          events.push({ type: "advantage_used", actor, d20_a: d20, d20_b: d20b, took });
          d20 = took;
          if (encourageCharges > 0) {
            s = { ...s, ability_state: consumeEncourageCharge(s.ability_state, actor) };
          }
        }
        const atkAc = monsterAc(targetMonster.tier);
        // Frontend Bard — A11y First: +1 to attack rolls per rank.
        const a11yHitBonus = fighterHasPassive(fighter, "a11y_first") ? fighterRank(fighter, "a11y_first") : 0;
        const hitTotal = d20 + effect.hit_mod + a11yHitBonus;
        const landed = hitTotal >= atkAc;
        events.push({ type: "roll", actor, die: "d20", value: d20, purpose: "hit_check" });
        events.push({ type: "hit_check", actor, target: targetMonster.id, roll: d20, modifier: effect.hit_mod, total: hitTotal, ac: atkAc, hit: landed });

        if (!landed) break;

        const isCrit = effect.is_crit ?? false;
        // Frontend Bard — Earworm: refund mana to bards on any party crit.
        const arEarworm = applyEarwormOnCrit(s, isCrit);
        s = arEarworm.state;
        events.push(...arEarworm.events);
        const atkVulnMult = vulnerabilityMult(s, targetMonster.id, s.round);
        // DevOps Mage — Observability adds flat damage per unique enemy debuff.
        const atkObsBonus = observabilityBonus(s, fighter);
        const atkDamage = Math.max(1, Math.round((effect.amount + atkObsBonus) * atkVulnMult));
        events.push({ type: "player_hit", actor, target: targetMonster.id, damage: atkDamage, armor_absorbed: 0, crit: isCrit, formula: effect.formula, damage_type: effect.damage_type });
        const newHp = Math.max(0, targetMonster.hp - atkDamage);
        s = {
          ...s,
          monsters: s.monsters.map((m) => m.id === targetMonster.id ? { ...m, hp: newHp } : m),
          contribution: { ...s.contribution, [actor]: (s.contribution[actor] ?? 0) + atkDamage },
        };
        s = accumulateIllOmenDamage(s, targetMonster.id, atkDamage);
        if (newHp <= 0) return resolveMonsterKill(s, targetMonster.id, actor, events);

        // Staff Sage — Ray of Frost: 25% chance to freeze on hit.
        if (effect.freeze_chance && roll(100) <= effect.freeze_chance) {
          const frozenEff: MachineStatusEffect = { type: "frozen", magnitude: 1, remaining: 1, source: actor };
          s = { ...s, monsters: s.monsters.map((m) => m.id === targetMonster.id ? { ...m, effects: mergeEffect(m.effects, frozenEff) } : m) };
          events.push({ type: "ability_freeze_applied", actor, target: targetMonster.id });
        }
        // DevOps Mage — Zero-Day Strike shock proc (and any future ranged
        // physical/elemental attack that opts in). Same roll cadence as
        // freeze above.
        if (effect.burn_chance && roll(100) <= effect.burn_chance) {
          const burnMag = 1;
          const burnDur = 3;
          const burnEff: MachineStatusEffect = { type: "burning", magnitude: burnMag, remaining: burnDur, source: actor };
          s = { ...s, monsters: s.monsters.map((m) => m.id === targetMonster.id ? { ...m, effects: mergeEffect(m.effects, burnEff) } : m) };
          events.push({ type: "ability_burn_applied", actor, target: targetMonster.id, magnitude: burnMag, duration: burnDur });
        }
        if (effect.shock_chance && roll(100) <= effect.shock_chance) {
          const shockMag = 1;
          const shockDur = 2;
          const shockEff: MachineStatusEffect = { type: "shocked", magnitude: shockMag, remaining: shockDur, source: actor };
          s = { ...s, monsters: s.monsters.map((m) => m.id === targetMonster.id ? { ...m, effects: mergeEffect(m.effects, shockEff) } : m) };
          events.push({ type: "ability_shock_applied", actor, target: targetMonster.id, magnitude: shockMag, duration: shockDur });
        }

        if (isCrit) {
          const lsAfterAtk = applyRogueLethalStrike(s, fighter, targetMonster.id);
          s = lsAfterAtk.state; events.push(...lsAfterAtk.events);
        }
        const envAfterAtk = applyEnvenomProc(s, fighter, targetMonster.id);
        s = envAfterAtk.state; events.push(...envAfterAtk.events);
        const sqAfterAtk = applySinisterQueries(s, fighter, targetMonster.id);
        s = sqAfterAtk.state; events.push(...sqAfterAtk.events);
        const rr = applyWardenResilient(s, fighter);
        s = rr.state;events.push(...rr.events);
        const hexAfterAtk = applyHexBleedProc(s, targetMonster.id);
        s = hexAfterAtk.state; events.push(...hexAfterAtk.events);
        break;
      }
      case "apply_bleed": {
        const targetMonster = s.monsters.find((m) => m.id === effect.target_id && m.hp > 0);
        if (!targetMonster) continue;
        const bleedEffect: MachineStatusEffect = { type: "bleeding", magnitude: effect.stacks, remaining: effect.duration, source: actor };
        s = { ...s, monsters: s.monsters.map((m) => m.id === targetMonster.id ? { ...m, effects: mergeEffect(m.effects, bleedEffect) } : m) };
        events.push({ type: "passive_rogue_lethal_strike", actor, magnitude: effect.stacks, duration: effect.duration });
        break;
      }
      case "apply_poison": {
        const targetMonster = s.monsters.find((m) => m.id === effect.target_id && m.hp > 0);
        if (!targetMonster) continue;
        const poisonEffect: MachineStatusEffect = { type: "poisoned", magnitude: effect.stacks, remaining: effect.duration, source: actor };
        s = { ...s, monsters: s.monsters.map((m) => m.id === targetMonster.id ? { ...m, effects: mergeEffect(m.effects, poisonEffect) } : m) };
        events.push({ type: "ability_envenom_proc", actor, target: targetMonster.id, stacks: effect.stacks });
        break;
      }
      case "apply_envenom_weapon": {
        const ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          envenomed_weapon: { ...(s.ability_state?.envenomed_weapon ?? {}), [actor]: { stacks: effect.stacks, charges: 2 } },
        };
        s = { ...s, ability_state };
        break;
      }
      case "apply_vulnerability": {
        const ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          vulnerable: {
            ...(s.ability_state?.vulnerable ?? {}),
            [effect.target_id]: { expires_after_round: s.round + effect.rounds - 1, magnitude: effect.magnitude },
          },
        };
        s = { ...s, ability_state };
        break;
      }
      case "set_damage_reduction": {
        const ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          brace: {
            ...(s.ability_state?.brace ?? {}),
            [effect.target_id]: { pct: effect.pct, turns_remaining: effect.turns },
          },
        };
        s = { ...s, ability_state };
        events.push({ type: "ability_brace", actor, turns: effect.turns });
        break;
      }
      case "apply_fighter_regen": {
        const target = s.fighters.find((f) => f.id === effect.target_id);
        if (!target || target.hp <= 0) continue;
        const regenEffect = { type: "regen" as const, magnitude: effect.magnitude, remaining: effect.duration, source: actor };
        s = { ...s, fighters: s.fighters.map((f) => f.id === effect.target_id ? { ...f, effects: mergeEffect(f.effects, regenEffect) } : f) };
        events.push({ type: "ability_regeneration", actor, target: effect.target_id, magnitude: effect.magnitude, duration: effect.duration });
        break;
      }
      case "apply_animal_form": {
        const target = s.fighters.find((f) => f.id === effect.target_id);
        if (!target) continue;
        const atkDelta = target.stats
          ? Math.floor((target.stats.str + effect.str_bonus - 5) / 2) - Math.floor((target.stats.str - 5) / 2)
          : Math.floor(effect.str_bonus / 2);
        const hpDelta = 2 * effect.vit_bonus;
        const newMaxHp = target.max_hp + hpDelta;
        const newHp = Math.min(newMaxHp, target.hp + hpDelta);
        const buffedFighter = {
          ...target,
          attack_mod: target.attack_mod + atkDelta,
          max_hp: newMaxHp,
          hp: newHp,
          ...(target.stats ? {
            stats: {
              ...target.stats,
              str: target.stats.str + effect.str_bonus,
              vit: target.stats.vit + effect.vit_bonus,
              agi: target.stats.agi + effect.agi_bonus,
              dex: target.stats.dex + effect.dex_bonus,
            },
          } : {}),
        };
        const animalFormEff = { type: "animal_form" as const, magnitude: 1, remaining: effect.turns, source: actor };
        s = { ...s, fighters: s.fighters.map((f) => f.id === effect.target_id ? { ...buffedFighter, effects: mergeEffect(buffedFighter.effects, animalFormEff) } : f) };
        s = {
          ...s,
          ability_state: {
            ...(s.ability_state ?? {}),
            animal_form: {
              ...(s.ability_state?.animal_form ?? {}),
              [effect.target_id]: {
                str_bonus: effect.str_bonus, vit_bonus: effect.vit_bonus,
                agi_bonus: effect.agi_bonus, dex_bonus: effect.dex_bonus,
                atk_delta: atkDelta, hp_delta: hpDelta,
                turns_remaining: effect.turns,
              },
            },
          },
        };
        events.push({ type: "ability_animal_form", actor, str_bonus: effect.str_bonus, vit_bonus: effect.vit_bonus, agi_bonus: effect.agi_bonus, dex_bonus: effect.dex_bonus, turns: effect.turns });
        break;
      }
      case "apply_barkskin": {
        const target = s.fighters.find((f) => f.id === effect.target_id);
        if (!target || target.hp <= 0) continue;
        const barkskinEff = { type: "barkskin" as const, magnitude: effect.bonus, remaining: effect.turns, source: actor };
        s = { ...s, fighters: s.fighters.map((f) => f.id === effect.target_id ? { ...f, effects: mergeEffect(f.effects, barkskinEff) } : f) };
        events.push({ type: "ability_barkskin", actor, target: effect.target_id, bonus: effect.bonus, turns: effect.turns });
        break;
      }
      case "entangle_monster": {
        const target = s.monsters.find((m) => m.id === effect.target_id && m.hp > 0);
        if (!target) continue;
        const entangleEff = { type: "entangled" as const, magnitude: 1, remaining: effect.duration, source: actor };
        s = { ...s, monsters: s.monsters.map((m) => m.id === effect.target_id ? { ...m, effects: mergeEffect(m.effects, entangleEff) } : m) };
        events.push({ type: "ability_wildgrowth_entangle", actor, target: effect.target_id, duration: effect.duration });
        break;
      }
      case "apply_taunt_fortify": {
        s = {
          ...s,
          ability_state: {
            ...(s.ability_state ?? {}),
            taunt_fortify: {
              ...(s.ability_state?.taunt_fortify ?? {}),
              [effect.target_id]: { turns_remaining: effect.turns },
            },
          },
        };
        events.push({ type: "ability_taunt_fortify", actor, turns: effect.turns });
        break;
      }
      case "summon_ally_npc": {
        const { spec, id_suffix } = effect;
        const idPrefix = `__ally_${id_suffix}_${actor}_`;
        const count = s.fighters.filter((f) => f.id.startsWith(idPrefix)).length;
        const npcId: ActorId = `${idPrefix}${count}__`;
        const npc: CombatFighter = {
          id: npcId,
          name: spec.name,
          class: spec.class_label,
          level: spec.level,
          hp: spec.hp,
          max_hp: spec.hp,
          mana: 0,
          max_mana: 0,
          shield: 0,
          position: spec.position,
          attack_mod: spec.attack_mod,
          magic_mod: 0,
          weapon_power: spec.weapon_power,
          focus_power: 0,
          weapon_range: spec.weapon_range,
          damage_roll: spec.damage_roll,
          slack_username: null,
          armor_power: 0,
          initiative: 0,
          effects: [],
          scars: [],
        };
        // Insert the NPC at the current actor's array position and adjust
        // turn_index so it still resolves to the same actor. This places the
        // NPC "behind" the current position in the circular order, meaning it
        // won't act until the next cycle — summoning costs the caster's turn.
        const oldLen = s.turn_order.length;
        const pos = s.turn_index % oldLen;
        const newTurnOrder = [...s.turn_order.slice(0, pos), npcId, ...s.turn_order.slice(pos)];
        const newTurnIndex = (pos + 1) + Math.floor(s.turn_index / oldLen) * (oldLen + 1);
        s = {
          ...s,
          fighters: [...s.fighters, npc],
          turn_order: newTurnOrder,
          turn_index: newTurnIndex,
        };
        events.push({ type: "ally_npc_summoned", actor, npc_id: npcId, name: spec.name });
        break;
      }
      case "apply_blizzard": {
        const ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          blizzard: { caster_id: effect.caster_id, mag: effect.mag, charges: 3 },
        };
        s = { ...s, ability_state };
        break;
      }
      case "apply_good_fortune": {
        const ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          good_fortune: { caster_id: effect.caster_id, target_id: effect.target_id, amount: effect.delayed_amount },
        };
        s = { ...s, ability_state };
        break;
      }
      case "apply_ill_omen": {
        const omenTarget = s.monsters.find((m) => m.id === effect.target_id && m.hp > 0);
        if (!omenTarget) continue;
        const ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          ill_omen: {
            ...(s.ability_state?.ill_omen ?? {}),
            [effect.target_id]: { caster_id: effect.caster_id, accumulated: 0, monster_turns_remaining: 3 },
          },
        };
        s = { ...s, ability_state };
        events.push({ type: "ability_ill_omen_applied", actor, target: effect.target_id });
        break;
      }
      case "reset_cooldowns": {
        // Encore (Bard): wipe every ability cooldown the target ally is sitting
        // on. No-op if they have none. The map entry is left in place but with
        // an empty inner object; cooldowns?.[id]?.[abilityId] reads work either
        // way, and a follow-up cast will repopulate as needed.
        if (!s.cooldowns?.[effect.target_id]) break;
        const { [effect.target_id]: _dropped, ...rest } = s.cooldowns;
        s = { ...s, cooldowns: rest };
        break;
      }
      case "dispel_enemy_buffs": {
        // Unsubscribe from All (Bard): strip every positive effect from each
        // living monster. Hardcoded list covers buff-kind (regen, animal_form)
        // plus positive passives (empowered, barkskin). Negative effects
        // (bleeding/poisoned/stunned/etc) are left intact — those are the
        // player's leverage and shouldn't be cleared by their own cast.
        const POSITIVE = new Set<EffectType>(["regen", "animal_form", "empowered", "barkskin"]);
        s = {
          ...s,
          monsters: s.monsters.map((m) => ({
            ...m,
            effects: (m.effects ?? []).filter((e) => !POSITIVE.has(e.type)),
          })),
        };
        break;
      }
      case "cleanse_ally_debuffs": {
        // Unsubscribe from All R2 (reserved): strip every negative effect from
        // each living ally. Same shape as dispel above but flipped — buffs
        // stay, debuffs and negative passives go.
        const NEGATIVE = new Set<EffectType>(["bleeding", "burning", "poisoned", "entangled", "stunned", "hexed", "shocked", "frozen"]);
        s = {
          ...s,
          fighters: s.fighters.map((f) => ({
            ...f,
            effects: (f.effects ?? []).filter((e) => !NEGATIVE.has(e.type)),
          })),
        };
        break;
      }
      case "leap_adjacent_to": {
        // Refactor Rogue — Hotpath: jump the actor to an unoccupied hex
        // adjacent to the target monster. Picks the neighbor closest to the
        // actor's current pos so the leap reads as "minimum jump that gets
        // me into range." Silently no-ops when there's no free landing
        // square or either fighter lacks a pos — the strike effect that
        // follows still lands.
        const leapActor = s.fighters.find((f) => f.id === effect.actor_id);
        const leapTarget = s.monsters.find((m) => m.id === effect.target_id);
        if (!leapActor || !leapTarget || !leapActor.pos || !leapTarget.pos) break;
        const grid = s.grid ?? GRID_DEFAULT;
        const occupied = new Set<string>();
        for (const f of s.fighters) if (f.pos && f.hp > 0 && f.id !== effect.actor_id) occupied.add(`${f.pos.q},${f.pos.r}`);
        for (const m of s.monsters) if (m.pos && m.hp > 0) occupied.add(`${m.pos.q},${m.pos.r}`);
        for (const o of s.obstacles ?? []) occupied.add(`${o.pos.q},${o.pos.r}`);
        const from = leapActor.pos;
        const candidates = hexNeighbors(leapTarget.pos, grid)
          .filter((n) => !occupied.has(`${n.q},${n.r}`))
          .sort((a, b) => hexDistance(a, from) - hexDistance(b, from));
        const dest = candidates[0];
        if (!dest) break;
        s = {
          ...s,
          fighters: s.fighters.map((f) => f.id === effect.actor_id ? { ...f, pos: dest } : f),
        };
        events.push({ type: "moved", actor: effect.actor_id, from, to: dest });
        // Position mutation → check on-enter ground effects on the landing tile.
        const onEnter = applyGroundOnEnter(s, effect.actor_id, dest);
        s = onEnter.state;
        events.push(...onEnter.events);
        break;
      }
      case "swap_positions": {
        // SRE Warden — Failover: trade hex positions with the targeted ally.
        // Both must have a pos for the swap to apply (legacy front/back combat
        // doesn't have hex positions; the swap is a no-op there).
        const caster = s.fighters.find((f) => f.id === effect.caster_id);
        const target = s.fighters.find((f) => f.id === effect.target_id);
        if (!caster || !target || !caster.pos || !target.pos) break;
        const casterPos = caster.pos;
        const targetPos = target.pos;
        s = {
          ...s,
          fighters: s.fighters.map((f) => {
            if (f.id === effect.caster_id) return { ...f, pos: targetPos };
            if (f.id === effect.target_id) return { ...f, pos: casterPos };
            return f;
          }),
        };
        events.push({ type: "moved", actor: effect.caster_id, from: casterPos, to: targetPos });
        events.push({ type: "moved", actor: effect.target_id, from: targetPos, to: casterPos });
        // Both actors check on-enter ground effects at their new tiles.
        const onEnterCaster = applyGroundOnEnter(s, effect.caster_id, targetPos);
        s = onEnterCaster.state;
        events.push(...onEnterCaster.events);
        const onEnterTarget = applyGroundOnEnter(s, effect.target_id, casterPos);
        s = onEnterTarget.state;
        events.push(...onEnterTarget.events);
        break;
      }
      case "cleanse_single_ally": {
        // QA Paladin — Code Review: strip every negative status from one
        // ally. Same NEGATIVE set as the field-wide cleanse_ally_debuffs
        // handler so the semantics stay consistent.
        const NEGATIVE = new Set<EffectType>(["bleeding", "burning", "poisoned", "entangled", "stunned", "hexed", "shocked", "frozen"]);
        const target = s.fighters.find((f) => f.id === effect.target_id);
        if (!target) break;
        s = {
          ...s,
          fighters: s.fighters.map((f) =>
            f.id === effect.target_id ? { ...f, effects: (f.effects ?? []).filter((e) => !NEGATIVE.has(e.type)) } : f,
          ),
        };
        break;
      }
      case "deduct_caster_hp": {
        // Drop Table (Warlock): pay HP instead of mana. Bypasses shield + armor
        // because it's a self-sacrifice cost, not damage. Floors at 1 so the
        // cast can't be lethal — the cost is real but never the final blow.
        const caster = s.fighters.find((f) => f.id === effect.caster_id);
        if (!caster) break;
        const newHp = Math.max(1, caster.hp - effect.amount);
        const lost = caster.hp - newHp;
        if (lost <= 0) break;
        s = {
          ...s,
          fighters: s.fighters.map((f) => f.id === effect.caster_id ? { ...f, hp: newHp } : f),
        };
        events.push({ type: "ability_self_hp_cost", actor: effect.caster_id, amount: lost });
        break;
      }
      case "place_ground_effect": {
        // Drop a baked-shape persistent tile effect onto the field. The
        // shape (hexes) is resolved at ability-execute time so this handler
        // is a thin pusher — see docs/ground-effects.md.
        if (effect.hexes.length === 0) break;
        const grid = s.grid ?? GRID_DEFAULT;
        const validHexes = effect.hexes.filter((h) => inBounds(h, grid));
        if (validHexes.length === 0) break;
        const existing = s.ground_effects ?? [];
        // Stable id from round + actor + kind + hex count so events can
        // correlate without depending on insertion order.
        const id = `ge-${s.round}-${actor}-${effect.ground_kind}-${existing.length}`;
        const ground: GroundEffect = {
          id,
          kind: effect.ground_kind,
          hexes: validHexes,
          source_id: actor,
          // duration_rounds counts the round of placement. Effect is active
          // through round = current_round + duration_rounds - 1 (inclusive).
          expires_after_round: s.round + Math.max(1, effect.duration_rounds) - 1,
          trigger: effect.trigger,
          potency: Math.max(0, Math.round(effect.potency)),
        };
        s = { ...s, ground_effects: [...existing, ground] };
        events.push({
          type: "ground_placed",
          actor,
          ground_id: id,
          kind: ground.kind,
          hexes: ground.hexes,
          expires_after_round: ground.expires_after_round,
          potency: ground.potency,
        });
        break;
      }
    }
  }

  // Staff Sage — Blizzard: fire end-of-turn AoE tick.
  const blizzTick = applyBlizzardTick(s, actor, roll);
  s = blizzTick.state;
  events.push(...blizzTick.events);
  for (const killedId of blizzTick.killed) {
    const killResult = resolveMonsterKill(s, killedId, actor, events);
    if (killResult.state.status !== "active") return killResult;
    s = killResult.state;
    events.length = 0;
    events.push(...killResult.events);
  }

  const next = advanceTurn(s, events);
  return { state: next, events: [...events, ...turnStartEvent(next)] };
}

// Builds the full Foresee intel payload from current state. Shared between
// the initial cast and subsequent turn refreshes.
function buildForeseeEvent(
  state: CombatState,
  actor: ActorId,
  roll: RollFn,
  turnsRemaining: number,
  precomputedTarget?: ActorId | null,
): Extract<CombatEvent, { type: "ability_foresee" }> {
  const aliveFighters = state.fighters.filter((f) => f.hp > 0);
  const abilityState = state.ability_state ?? {};
  const vanishedMap = abilityState.vanished ?? {};
  const partyBonus = Math.floor((Math.max(1, aliveFighters.length) - 1) / 2);
  // Foresee targets the first alive monster (primary threat).
  const foreseeMon = state.monsters.find((m) => m.hp > 0) ?? state.monsters[0];
  const isBossP2 = foreseeMon?.is_boss && foreseeMon?.boss_phase === 2;
  const bossBonus = isBossP2 ? (foreseeMon?.tier ?? 0) : 0;
  const tier = foreseeMon?.tier ?? 1;
  const rawLo = 1 + tier + partyBonus + bossBonus;
  const rawHi = 4 + tier + partyBonus + bossBonus;

  const taunted = abilityState.taunt;

  // Determine confirmed/predicted target.
  // When a precomputedTarget is explicitly provided (even null), use it directly
  // — it was pre-rolled by withForeseeForSage and is guaranteed to match the
  // actual attack. Only do the fallback probabilistic roll when the parameter
  // was not provided at all (undefined).
  let predicted: ActorId | null;
  if (precomputedTarget !== undefined) {
    predicted = precomputedTarget;
  } else {
    predicted = null;
    if (taunted && taunted.swings_remaining > 0) {
      const tauntTarget = aliveFighters.find((f) => f.id === taunted.actor_id);
      if (tauntTarget) predicted = tauntTarget.id;
    }
    if (!predicted && aliveFighters.length > 0) {
      const eligible = aliveFighters.filter((f) => (vanishedMap[f.id] ?? 0) <= 0);
      const pool = eligible.length > 0 ? eligible : aliveFighters;
      predicted = pickMonsterTarget(pool, () => roll(101) / 100).id;
    }
  }

  // Net damage range for the predicted target (no position reduction in hex combat).
  const targetFighter = predicted ? aliveFighters.find((f) => f.id === predicted) : null;
  let netLo = rawLo;
  let netHi = rawHi;
  let verdict: "safe" | "at_risk" | "lethal" = "safe";
  if (targetFighter) {
    const armorReduction = Math.floor(targetFighter.armor_power / 2);
    netLo = Math.max(1, rawLo - armorReduction);
    netHi = Math.max(1, rawHi - armorReduction);
    verdict = targetFighter.hp > netHi ? "safe"
      : targetFighter.hp <= netLo ? "lethal"
      : "at_risk";
  }

  // Targeting probabilities: closer fighters are more likely to be targeted.
  const foreseeMonstPos = state.monsters.find((m) => m.hp > 0)?.pos;
  const targetable = aliveFighters.filter((f) => (vanishedMap[f.id] ?? 0) <= 0);
  const weights = targetable.map((f) => {
    if (foreseeMonstPos && f.pos) {
      return Math.max(1, 8 - hexDistance(foreseeMonstPos, f.pos));
    }
    return 3; // legacy fallback
  });
  const total = weights.reduce((a, b) => a + b, 0);
  const probabilities = targetable.map((f, i) => ({
    id: f.id,
    position: f.position,
    pct: Math.round((weights[i] / total) * 100),
  }));

  // Party triage snapshot.
  const triage = aliveFighters.map((f) => ({
    id: f.id, hp: f.hp, max_hp: f.max_hp, shield: f.shield, position: f.position,
  }));

  // Active effects summary.
  const vanishedIds = Object.entries(vanishedMap)
    .filter(([, v]) => v > 0)
    .map(([id]) => id);
  const liveMonster = state.monsters.find((m) => m.hp > 0);
  const active = {
    stunned: liveMonster?.effects.some((e) => e.type === "stunned") ? 1 : 0,
    taunt_actor: taunted && taunted.swings_remaining > 0 ? taunted.actor_id : null,
    taunt_swings: taunted?.swings_remaining ?? 0,
    vanished: vanishedIds,
  };

  return {
    type: "ability_foresee",
    actor,
    predicted_target: predicted,
    predicted_targets: { ...(state.ability_state?.foretold_targets ?? {}) },
    damage_lo: rawLo,
    damage_hi: rawHi,
    net_lo: netLo,
    net_hi: netHi,
    verdict,
    probabilities,
    triage,
    active,
    turns_remaining: turnsRemaining,
  };
}

// Pre-rolls fighter targets for every alive monster that will act between
// `fromIndex` (inclusive, in turn_order) and the sage's next turn (exclusive).
// Stores each result in ability_state.foretold_targets keyed by monster ID so
// handleMonsterAct can use the exact same value — making every prediction correct.
// Returns the updated state and the target for the first upcoming monster (used
// as the displayed prediction in the foresee event).
function prerollMonsterTargets(
  state: CombatState,
  fromIndex: number,
  roll: RollFn,
): { state: CombatState; primaryTarget: ActorId | null } {
  const order = state.turn_order;
  const n = order.length;
  if (n === 0) return { state, primaryTarget: null };

  // Find how many steps forward until the sage (stops at sage's position).
  let sageSteps = -1;
  for (let i = 0; i < n; i++) {
    const id = order[(fromIndex + i) % n];
    const f = state.fighters.find((f) => f.id === id && f.hp > 0 && classHasPassive(f.class, "foretell"));
    if (f) { sageSteps = i; break; }
  }
  if (sageSteps <= 0) return { state, primaryTarget: null };

  const abilityState = state.ability_state ?? {};
  const vanishedMap = abilityState.vanished ?? {};
  const taunted = abilityState.taunt;
  const aliveFighters = state.fighters.filter((f) => f.hp > 0);
  const foretoldTargets: Record<ActorId, ActorId> = { ...(abilityState.foretold_targets ?? {}) };
  let primaryTarget: ActorId | null = null;

  for (let i = 0; i < sageSteps; i++) {
    const monsterId = order[(fromIndex + i) % n];
    if (!isMonsterActor(monsterId)) continue;
    if (!state.monsters.find((m) => m.id === monsterId && m.hp > 0)) continue;

    let target: ActorId | null = null;
    if (taunted && taunted.swings_remaining > 0) {
      const tauntFighter = aliveFighters.find((f) => f.id === taunted.actor_id);
      if (tauntFighter) target = tauntFighter.id;
    }
    if (!target) {
      const eligible = aliveFighters.filter((f) => (vanishedMap[f.id] ?? 0) <= 0);
      const pool = eligible.length > 0 ? eligible : aliveFighters;
      if (pool.length > 0) target = pickMonsterTarget(pool, () => roll(101) / 100).id;
    }
    if (target) {
      foretoldTargets[monsterId] = target;
      if (primaryTarget === null) primaryTarget = target;
    }
  }

  const newAbilityState = Object.keys(foretoldTargets).length > 0
    ? { ...abilityState, foretold_targets: foretoldTargets }
    : abilityState;
  return { state: { ...state, ability_state: newAbilityState }, primaryTarget };
}

// Core: builds and injects the foresee event into result, using sageId as the
// event actor. Pre-rolls targets for all monsters between fromIndex and the sage.
function withForeseeForSage(
  result: StepResult,
  sageId: ActorId,
  fromIndex: number,
  roll: RollFn,
): StepResult {
  const { state: stateWithTargets, primaryTarget } = prerollMonsterTargets(result.state, fromIndex, roll);
  const refreshEvent = buildForeseeEvent(stateWithTargets, sageId, roll, 99, primaryTarget);

  // Insert before the last turn_start so the readout appears at the top of the
  // next relevant turn block rather than at the tail of the preceding action.
  const events = [...result.events];
  let insertAt = events.length;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "turn_start") { insertAt = i; break; }
  }
  events.splice(insertAt, 0, refreshEvent);
  return { state: stateWithTargets, events };
}

// After the monster (or ally NPC) acts, checks if the next actor is a Staff
// Sage with the Foretell passive and, if so, fires foresee so the Sage sees
// fresh intel at the top of their upcoming turn.
function withForeseeForNextActor(result: StepResult, roll: RollFn): StepResult {
  const actorId = currentActor(result.state);
  if (!actorId || isMonsterActor(actorId)) return result;
  if (!result.state.fighters.find((f) => f.id === actorId && classHasPassive(f.class, "foretell"))) return result;
  // Monsters after sage's current position (fromIndex = turn_index + 1) will act
  // before the sage's next turn — pre-roll a target for each of them.
  return withForeseeForSage(result, actorId, result.state.turn_index + 1, roll);
}

// ── Monster-kill resolution ───────────────────────────────────────────────
//
// Called every time a monster's hp drops to 0.
// For gauntlet quests with remaining waves, transitions to the next wave
// (preserving turn order + initiative + killer's credit). Otherwise, victory
// fires when ALL monsters are dead. monster_down always fires for the "kill" beat.
export function resolveMonsterKill(
  state: CombatState,
  monsterId: ActorId,
  killedBy: ActorId,
  precedingEvents: CombatEvent[],
): StepResult {
  const events: CombatEvent[] = [...precedingEvents];
  events.push({ type: "monster_down", killed_by: killedBy });

  // Track kill credit for the killing blow actor.
  const stateWithKill: CombatState = killedBy !== MONSTER_ID && !isMonsterActor(killedBy)
    ? {
        ...state,
        stats: {
          ...state.stats,
          [killedBy]: {
            ...(state.stats[killedBy] ?? { damage_taken: 0, healing_done: 0, shielding_done: 0, kills: 0 }),
            kills: (state.stats[killedBy]?.kills ?? 0) + 1,
          },
        },
      }
    : state;

  const deadMonster = stateWithKill.monsters.find((m) => m.id === monsterId);
  const upcoming = deadMonster?.upcoming_waves ?? [];

  // Fire on_kill passives. Each living fighter's class kit + their talent-
  // tree-registered passives are scanned for trigger === "on_kill"; nearby_
  // radius_tiles filters by hex distance from the fighter to the dying
  // monster. Effects are applied inline (restore_mana / heal only — other
  // kinds become no-ops here so we don't need to thread RollFn into every
  // resolveMonsterKill caller). Most on_kill passives are mana/HP refunds,
  // so this covers the design space; richer effects can graduate to the
  // full applyUtilityAbilityEffects path in a follow-up.
  let afterKill = stateWithKill;
  for (const fighter of afterKill.fighters) {
    if (fighter.hp <= 0) continue;
    const fighterCls = classByName(fighter.class);
    const kitPassives = fighterCls.abilities.filter(
      (a): a is PassiveAbilityDef => a.kind === "passive" && a.trigger === "on_kill",
    );
    const treePassives = ALL_TALENT_NODES
      .filter((n) => n.class_id === fighterCls.id && n.ability.kind === "passive")
      .map((n) => n.ability)
      .filter((a): a is PassiveAbilityDef => a.kind === "passive" && a.trigger === "on_kill");
    // Deduplicate by id so a talent-tree node sharing the kit's id (rank-1
    // wrappers) doesn't double-fire.
    const seen = new Set<string>();
    const allPassives = [...kitPassives, ...treePassives].filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
    for (const passive of allPassives) {
      // Nearby radius filter — Stale Cache style.
      if (
        passive.nearby_radius_tiles !== undefined
        && fighter.pos
        && deadMonster?.pos
        && hexDistance(fighter.pos, deadMonster.pos) > passive.nearby_radius_tiles
      ) continue;
      const ctx: AbilityContext = {
        caster: fighter,
        party: afterKill.fighters.filter((f) => f.hp > 0),
        monsters: afterKill.monsters.filter((m) => m.hp > 0 && m.id !== monsterId),
        roll: (sides: number) => Math.floor((sides + 1) / 2), // deterministic mid-roll; on_kill execs are non-random
      };
      const passiveEffects = passive.execute(ctx);
      if (passiveEffects.length === 0) continue;
      let anyApplied = false;
      for (const eff of passiveEffects) {
        if (eff.kind === "restore_mana") {
          const t = afterKill.fighters.find((f) => f.id === eff.target_id);
          if (!t) continue;
          afterKill = {
            ...afterKill,
            fighters: afterKill.fighters.map((f) =>
              f.id === eff.target_id ? { ...f, mana: Math.min(f.max_mana, f.mana + eff.amount) } : f,
            ),
          };
          anyApplied = true;
        } else if (eff.kind === "heal") {
          const t = afterKill.fighters.find((f) => f.id === eff.target_id);
          if (!t || t.hp <= 0) continue;
          const newHp = Math.min(t.max_hp, t.hp + eff.amount);
          afterKill = {
            ...afterKill,
            fighters: afterKill.fighters.map((f) =>
              f.id === eff.target_id ? { ...f, hp: newHp } : f,
            ),
          };
          anyApplied = true;
        }
      }
      if (anyApplied) {
        events.push({ type: "passive_on_kill", actor: fighter.id, passive_id: passive.id, target: monsterId });
      }
    }
  }
  // From here on, use `afterKill` as the canonical state (passive effects baked in).
  const stateWithKillAndPassives = afterKill;

  if (upcoming.length > 0) {
    // Gauntlet wave transition — replace the dead monster in-place.
    const [next, ...rest] = upcoming;
    const newMonster: CombatMonster = {
      id: monsterId,           // keep the same slot ID so turn_order stays valid
      name: next.name,
      hp: next.max_hp,
      max_hp: next.max_hp,
      shield: deadMonster!.tier,
      tier: deadMonster!.tier,
      initiative: deadMonster!.initiative,
      effects: [],
      is_boss: false,          // gauntlet waves are never boss-tier
      boss_phase: 1,
      wave: (deadMonster!.wave ?? 1) + 1,
      total_waves: deadMonster!.total_waves,
      upcoming_waves: rest,
      art_url: deadMonster!.art_url,
    };
    events.push({
      type: "wave_transition",
      from_monster: deadMonster!.name,
      to_monster: next.name,
      to_max_hp: next.max_hp,
      new_wave: newMonster.wave!,
      total_waves: newMonster.total_waves ?? newMonster.wave!,
    });
    // Wave transition clears mark — the previous focus target is gone.
    const ability_state = stripField(stateWithKillAndPassives.ability_state, "mark");
    const updatedMonsters = stateWithKillAndPassives.monsters.map((m) => m.id === monsterId ? newMonster : m);
    const advanced = advanceTurn({ ...stateWithKillAndPassives, monsters: updatedMonsters, ability_state }, events);
    return { state: advanced, events: [...events, ...turnStartEvent(advanced)] };
  }

  // Check if ALL monsters are now dead.
  const allMonstersDown = stateWithKillAndPassives.monsters.every((m) => m.id === monsterId || m.hp <= 0);
  if (allMonstersDown) {
    events.push({ type: "victory" });
    return { state: { ...stateWithKillAndPassives, status: "victory" }, events };
  }

  // Some monsters still alive — combat continues. Clear mark (target is dead).
  const ability_state = stripField(stateWithKillAndPassives.ability_state, "mark");
  const advanced = advanceTurn({ ...stateWithKillAndPassives, ability_state }, events);
  return { state: advanced, events: [...events, ...turnStartEvent(advanced)] };
}

// ── Status effect tick handling ───────────────────────────────────────────
//
// Ticks once at the start of every actor's turn. regen heals; bleeding /
// burning / poisoned damage. Effects decrement `remaining` each tick and
// drop off when remaining hits 0. If a tick lowers the actor below 1 hp,
// the wrapping handler treats it as the actor being downed before they
// can act.

interface TickResult {
  newHp: number;
  newEffects: MachineStatusEffect[];
  events: CombatEvent[];
}

function tickEffects(
  hp: number,
  maxHp: number,
  effects: MachineStatusEffect[],
  actorId: ActorId,
): TickResult {
  let newHp = hp;
  const newEffects: MachineStatusEffect[] = [];
  const events: CombatEvent[] = [];
  for (const eff of effects) {
    if (eff.type === "empowered" || eff.type === "frozen" || eff.type === "shocked" || eff.type === "stunned" || eff.type === "hexed" || eff.type === "entangled" || eff.type === "barkskin" || eff.type === "animal_form") {
      // Passive — no HP delta. Silently count down; the effect is applied
      // inline in the attack/turn handlers via the actor's effects array.
      // "stunned" uses remaining as a max-duration safety net (break logic
      // lives in handleMonsterAct via the probabilistic roll).
      if (eff.remaining > 1) newEffects.push({ ...eff, remaining: eff.remaining - 1 });
      events.push({ type: "effect_tick", actor: actorId, effect: eff.type, magnitude: 0, hp_delta: 0 });
      continue;
    }
    const delta = eff.type === "regen" ? eff.magnitude : -eff.magnitude;
    newHp = Math.max(0, Math.min(maxHp, newHp + delta));
    events.push({
      type: "effect_tick",
      actor: actorId,
      effect: eff.type,
      magnitude: eff.magnitude,
      hp_delta: delta,
      source: eff.source,
    });
    if (eff.remaining > 1) {
      newEffects.push({ ...eff, remaining: eff.remaining - 1 });
    }
  }
  return { newHp, newEffects, events };
}

// Apply pre-turn ticks to whichever actor is about to act. Returns the
// updated state, the events to emit, and — if the tick killed the actor —
// an `earlyReturn` StepResult so the caller can skip the action handler
// entirely. Centralizes the down/victory/defeat bookkeeping so each action
// handler just has to prepend `tick.events` and bail on `earlyReturn`.
interface TickGate {
  state: CombatState;
  events: CombatEvent[];
  earlyReturn: StepResult | null;
}

function tickAtTurnStart(state: CombatState, actorId: ActorId): TickGate {
  // Ground effect ticks fire first — they're environmental "you're standing
  // on a fire" damage that should resolve before status DoTs decide whether
  // the actor is still alive to bleed. If a ground tick downs the actor,
  // skip the rest of the tick path entirely.
  const groundTickResult = applyGroundTicks(state, actorId);
  state = groundTickResult.state;
  const groundEvents = groundTickResult.events;
  if (groundTickResult.downed) {
    if (isMonsterActor(actorId)) {
      // resolveMonsterKill was already invoked inside applyGroundDamage
      // (via the monster_down path). State is post-kill / post-victory.
      if (state.status === "victory") {
        return { state, events: groundEvents, earlyReturn: { state, events: groundEvents } };
      }
      const expiredEvents: CombatEvent[] = [];
      const advanced = advanceTurn(state, expiredEvents);
      return {
        state,
        events: groundEvents,
        earlyReturn: { state: advanced, events: [...groundEvents, ...expiredEvents, ...turnStartEvent(advanced)] },
      };
    }
    // Fighter downed by ground tick.
    const allDown = state.fighters.every((f) => f.hp <= 0);
    if (allDown) {
      const events: CombatEvent[] = [...groundEvents, { type: "defeat" }];
      return { state, events, earlyReturn: { state: { ...state, status: "defeat" }, events } };
    }
    const expiredEvents: CombatEvent[] = [];
    const advanced = advanceTurn(state, expiredEvents);
    return {
      state,
      events: groundEvents,
      earlyReturn: { state: advanced, events: [...groundEvents, ...expiredEvents, ...turnStartEvent(advanced)] },
    };
  }
  if (isMonsterActor(actorId)) {
    const monster = state.monsters.find((m) => m.id === actorId);
    if (!monster) return { state, events: groundEvents, earlyReturn: null };
    const tick = tickEffects(monster.hp, monster.max_hp, monster.effects, actorId);
    let newState: CombatState = {
      ...state,
      monsters: state.monsters.map((m) =>
        m.id === actorId ? { ...m, hp: tick.newHp, effects: tick.newEffects } : m,
      ),
    };
    // Staff Sage — Ill Omen: accumulate DoT damage dealt to an omen-marked monster.
    const monsterDotDamage = Math.max(0, monster.hp - tick.newHp);
    if (monsterDotDamage > 0) newState = accumulateIllOmenDamage(newState, actorId, monsterDotDamage);
    // Frozen: skip every turn while the effect is active (see fighter side
    // comment). Was a `wasFrozen && !stillFrozen` gate which only fired on
    // the expiry turn.
    const wasMonsterFrozen = monster.effects.some((e) => e.type === "frozen");
    if (wasMonsterFrozen && tick.newHp > 0) {
      const skipEvent: CombatEvent = { type: "turn_skip", actor: actorId, reason: "frozen" };
      const expiredEvents: CombatEvent[] = [];
      const advanced = advanceTurn(newState, expiredEvents);
      return {
        state: newState,
        events: [...groundEvents, ...tick.events, skipEvent],
        earlyReturn: { state: advanced, events: [...groundEvents, ...tick.events, skipEvent, ...expiredEvents, ...turnStartEvent(advanced)] },
      };
    }
    if (tick.newHp <= 0 && monster.hp > 0) {
      // Credit the kill to whoever applied the longest-running tick source,
      // falling back to the first alive fighter. Pure best-effort — used
      // for the UI's "killed by" banner and contribution count.
      const killerId =
        monster.effects.find((e) => e.source)?.source ??
        state.fighters.find((f) => f.hp > 0)?.id ??
        actorId;
      // Credit the killing tick's damage to the source so the contribution
      // split on victory matches what actually happened.
      const tickDmg = monster.hp - tick.newHp;
      const contribution =
        !isMonsterActor(killerId)
          ? {
              ...state.contribution,
              [killerId]: (state.contribution[killerId] ?? 0) + tickDmg,
            }
          : state.contribution;
      // Defer victory vs wave transition to the shared resolver so
      // gauntlet quests keep going past a poison-kill.
      const withContribution: CombatState = { ...newState, contribution };
      const result = resolveMonsterKill(withContribution, actorId, killerId, [...groundEvents, ...tick.events]);
      return { state: result.state, events: result.events, earlyReturn: result };
    }
    return { state: newState, events: [...groundEvents, ...tick.events], earlyReturn: null };
  }

  const fighter = state.fighters.find((f) => f.id === actorId);
  if (!fighter) {
    // Shouldn't happen — turn_order is built from current fighters — but
    // defensively pass through.
    return { state, events: groundEvents, earlyReturn: null };
  }
  const tick = tickEffects(fighter.hp, fighter.max_hp, fighter.effects, actorId);
  const updatedFighters = state.fighters.map((f) =>
    f.id === actorId ? { ...f, hp: tick.newHp, effects: tick.newEffects } : f,
  );
  let newState: CombatState = { ...state, fighters: updatedFighters };
  let passiveEvents: CombatEvent[] = [];
  // Apply pre-action passives only if the tick didn't drop the actor below 1.
  if (tick.newHp > 0) {
    const tickedFighter = newState.fighters.find((f) => f.id === actorId)!;
    const pre = applyPreActionPassives(newState, actorId);
    newState = pre.state;
    passiveEvents = pre.events;
    void tickedFighter;

    // Staff Sage — Good Fortune: fire delayed double-heal at start of caster's next turn.
    const gf = applyGoodFortuneDelayed(newState, actorId);
    newState = gf.state;
    passiveEvents = [...passiveEvents, ...gf.events];
  }

  // Frozen: the fighter's turn is skipped while frozen is active. The tick
  // above already decrements the effect's `remaining` counter, so the player
  // skips every turn for as many turns as `remaining` started at. The old
  // `wasFrozen && !stillFrozen` check only triggered the skip on the turn
  // the effect EXPIRED — fine for engine-applied frozen with remaining=1
  // but silently broken for any longer freeze (the actor would play
  // normally for N-1 turns and then skip one).
  const wasFighterFrozen = fighter.effects.some((e) => e.type === "frozen");
  if (wasFighterFrozen && tick.newHp > 0) {
    const skipEvent: CombatEvent = { type: "turn_skip", actor: actorId, reason: "frozen" };
    const expiredEvents: CombatEvent[] = [];
    const advanced = advanceTurn(newState, expiredEvents);
    return {
      state: newState,
      events: [...groundEvents, ...tick.events, skipEvent],
      earlyReturn: { state: advanced, events: [...groundEvents, ...tick.events, skipEvent, ...expiredEvents, ...turnStartEvent(advanced)] },
    };
  }

  if (tick.newHp <= 0 && fighter.hp > 0) {
    // Tick downed the fighter — skip their action, advance turn (or end
    // combat on full party wipe).
    const events: CombatEvent[] = [
      ...groundEvents,
      ...tick.events,
      { type: "fighter_down", target: actorId },
    ];
    const allDown = updatedFighters.every((f) => f.hp <= 0);
    if (allDown) {
      events.push({ type: "defeat" });
      return {
        state: newState,
        events,
        earlyReturn: { state: { ...newState, status: "defeat" }, events },
      };
    }
    const expiredEvents: CombatEvent[] = [];
    const advanced = advanceTurn(newState, expiredEvents);
    return {
      state: newState,
      events,
      earlyReturn: { state: advanced, events: [...events, ...expiredEvents, ...turnStartEvent(advanced)] },
    };
  }

  return { state: newState, events: [...groundEvents, ...tick.events, ...passiveEvents], earlyReturn: null };
}

// ── Class passives ───────────────────────────────────────────────────────
//
// Always-on or once-per-fight triggers wired into the action handlers. Each
// helper is pure: it returns a {state, events} delta that callers fold in
// before persisting. Once-per-fight passives consult passives_used.

function classIdOf(fighter: CombatFighter): string {
  return classByName(fighter.class).id;
}

// Returns true if the named class has a passive ability with the given id.
// Used to gate passive mechanics without hardcoding class ID strings.
function classHasPassive(className: string, passiveId: string): boolean {
  return classByName(className).abilities.some(
    (a) => a.kind === "passive" && a.id === passiveId,
  );
}

// Checks both the static class kit AND the fighter's equipped talent-tree
// passives. Use this for passives that ship via the talent tree (Cherry-Pick,
// Stale Cache, etc.) so they don't fire for every member of the class regardless
// of whether they actually bought + equipped the passive.
function fighterHasPassive(fighter: CombatFighter, passiveId: string): boolean {
  if (classHasPassive(fighter.class, passiveId)) return true;
  return fighter.equipped_passive_ids?.includes(passiveId) ?? false;
}

// Returns the fighter's owned rank for the given passive/ability id. Defaults
// to 1 — kit passives without a tree purchase, legacy combats without
// talent_ranks populated, and pre-talent-tree characters all read as R1.
// Used by machine-side helpers (observabilityBonus, applyManaFont, etc.) to
// scale their effects when the passive has been ranked up via the tree.
function fighterRank(fighter: CombatFighter, passiveId: string): number {
  return fighter.talent_ranks?.[passiveId] ?? 1;
}

// DevOps Mage — Observability: + flat damage equal to the number of distinct
// debuff types currently on the enemy field. Reads only the unique types
// (not stacks) so a target with bleed×5 still counts as one. Returns 0 when
// the attacker doesn't have the passive equipped.
const OBSERVABILITY_DEBUFF_TYPES: ReadonlySet<EffectType> = new Set<EffectType>([
  "bleeding", "burning", "poisoned", "entangled", "stunned", "hexed", "shocked", "frozen",
]);
// DevOps Mage — Failsafe: once per fight, a lethal blow leaves the mage at
// 1 HP instead of downing them. Caller passes the proposed new HP; if it's
// ≤ 0 AND the fighter has the passive equipped AND hasn't triggered it this
// fight, the function returns `{ newHp: 1, triggered: true }` so the caller
// can mark the passive used + emit the event. Otherwise pass-through.
function applyFailsafe(
  state: CombatState,
  fighter: CombatFighter,
  proposedNewHp: number,
): { newHp: number; triggered: boolean } {
  if (proposedNewHp > 0 || fighter.hp <= 0) return { newHp: proposedNewHp, triggered: false };
  if (!fighterHasPassive(fighter, "failsafe")) return { newHp: proposedNewHp, triggered: false };
  if (isPassiveUsed(state, fighter.id, "failsafe")) return { newHp: proposedNewHp, triggered: false };
  return { newHp: 1, triggered: true };
}

// Frontend Bard — Earworm: every party member with the passive equipped
// gets +1 mana when ANY party crit lands (their own crit also counts —
// the bard is "in the party"). Capped at max_mana. Returns the modified
// state + one event per actual refund (so the UI can show the trigger).
function applyEarwormOnCrit(state: CombatState, isCrit: boolean): { state: CombatState; events: CombatEvent[] } {
  if (!isCrit) return { state, events: [] };
  const events: CombatEvent[] = [];
  const fighters = state.fighters.map((f) => {
    if (f.hp <= 0 || !fighterHasPassive(f, "earworm") || f.mana >= f.max_mana) return f;
    // R1 +1 mana per crit. R2 +2. R3 +3. Capped at max_mana headroom.
    const refund = Math.min(fighterRank(f, "earworm"), f.max_mana - f.mana);
    if (refund <= 0) return f;
    events.push({ type: "passive_earworm_refund", actor: f.id, amount: refund });
    return { ...f, mana: f.mana + refund };
  });
  if (events.length === 0) return { state, events };
  return { state: { ...state, fighters }, events };
}

function observabilityBonus(state: CombatState, fighter: CombatFighter): number {
  if (!fighterHasPassive(fighter, "observability")) return 0;
  const types = new Set<EffectType>();
  for (const m of state.monsters) {
    if (m.hp <= 0) continue;
    for (const e of m.effects ?? []) {
      if (OBSERVABILITY_DEBUFF_TYPES.has(e.type)) types.add(e.type);
    }
  }
  // R1 +1 per unique debuff. R2 +2. R3 +3.
  return types.size * fighterRank(fighter, "observability");
}

function isPassiveUsed(state: CombatState, actorId: ActorId, key: string): boolean {
  return state.passives_used?.[actorId]?.includes(key) ?? false;
}

function markPassiveUsed(state: CombatState, actorId: ActorId, key: string): CombatState {
  const current = state.passives_used ?? {};
  const userKeys = current[actorId] ?? [];
  if (userKeys.includes(key)) return state;
  return {
    ...state,
    passives_used: {
      ...current,
      [actorId]: [...userKeys, key],
    },
  };
}

// SRE Warden — Armor Up. Regenerate 2 + floor(level/4) shield at the start of each turn.
function applyWardenArmorUp(
  state: CombatState,
  actor: CombatFighter,
): { state: CombatState; events: CombatEvent[] } {
  if (!classHasPassive(actor.class, "armor_up")) return { state, events: [] };
  // R1 +0, R2 +1, R3 +2 bonus on top of the level scaling.
  const amount = 2 + Math.floor(actor.level / 4) + Math.max(0, fighterRank(actor, "armor_up") - 1);
  const cap = actor.max_hp * SHIELD_CAP_MULTIPLIER + resilientBonus(actor, state.ability_state, state.round);
  const newShield = Math.min(cap, actor.shield + amount);
  const added = newShield - actor.shield;
  if (added <= 0) return { state, events: [] };
  const updated = state.fighters.map((f) =>
    f.id === actor.id ? { ...f, shield: newShield } : f,
  );
  return {
    state: { ...state, fighters: updated },
    events: [{ type: "passive_warden_armor_up", actor: actor.id, amount: added }],
  };
}

// QA Paladin — Lay on Hands auto-trigger. Fires after a monster swing when the
// target survived but has fallen to ≤ 30% of max_hp. The first alive Paladin in
// the party who hasn't already triggered this once-per-fight heals the fighter
// for 1d6 + floor(mag/2) + floor(vit/2).
function applyPaladinAutoHeal(
  state: CombatState,
  targetId: ActorId,
  roll: RollFn,
): { state: CombatState; events: CombatEvent[] } {
  const target = state.fighters.find((f) => f.id === targetId);
  if (!target || target.hp <= 0) return { state, events: [] };
  if (target.hp > Math.floor(target.max_hp * 0.3)) return { state, events: [] };

  const paladin = state.fighters.find(
    (f) => f.hp > 0 && classHasPassive(f.class, "holy_rage") && !isPassiveUsed(state, f.id, PASSIVE_PALADIN_AUTO_HEAL),
  );
  if (!paladin) return { state, events: [] };

  const vit = paladin.stats?.vit ?? 5;
  const rolled = roll(6) + Math.floor(paladin.magic_mod / 2) + Math.floor(vit / 2);
  const newHp = Math.min(target.max_hp, target.hp + rolled);
  const actualAmount = newHp - target.hp;
  if (actualAmount <= 0) return { state, events: [] };

  let next: CombatState = {
    ...state,
    fighters: state.fighters.map((f) =>
      f.id === targetId ? { ...f, hp: newHp } : f,
    ),
  };
  next = markPassiveUsed(next, paladin.id, PASSIVE_PALADIN_AUTO_HEAL);

  return {
    state: next,
    events: [{ type: "passive_paladin_auto_heal", paladin: paladin.id, target: targetId, amount: actualAmount }],
  };
}

// SRE Warden — Resilient. Returns the flat bonus from active stacks:
// stacks * (2 + floor(vit/4)). Used for shield cap and Thorns/Brace scaling.
function resilientBonus(
  fighter: CombatFighter,
  abilityState: AbilityRuntimeState | undefined,
  currentRound: number,
): number {
  const stacks = (abilityState?.resilient?.[fighter.id] ?? []).filter(
    (exp) => exp >= currentRound,
  );
  if (stacks.length === 0) return 0;
  const vit = fighter.stats?.vit ?? 0;
  // R1 +0, R2 +1, R3 +2 per stack on top of the vit scaling.
  const rankBonus = Math.max(0, fighterRank(fighter, "resilient") - 1);
  return stacks.length * (2 + Math.floor(vit / 4) + rankBonus);
}

// SRE Warden — Resilient. Called after any successful hit by the warden to
// add a stack (expires_after_round = round + 4). No shield is directly granted;
// the raised cap takes effect when shield is next applied.
function applyWardenResilient(
  state: CombatState,
  fighter: CombatFighter,
): { state: CombatState; events: CombatEvent[] } {
  if (!classHasPassive(fighter.class, "resilient")) return { state, events: [] };
  const existing = state.ability_state?.resilient?.[fighter.id] ?? [];
  const newStacks = [...existing, state.round + 4];
  return {
    state: {
      ...state,
      ability_state: {
        ...(state.ability_state ?? {}),
        resilient: {
          ...(state.ability_state?.resilient ?? {}),
          [fighter.id]: newStacks,
        },
      },
    },
    events: [{ type: "passive_warden_resilient", actor: fighter.id, stacks: newStacks.length }],
  };
}

// SRE Warden — Thorns. When hit, deal 25% of armor_power back to the attacker.
function applyWardenThorns(
  state: CombatState,
  targetFighterId: ActorId,
  monsterId: ActorId,
): { state: CombatState; events: CombatEvent[] } {
  const fighter = state.fighters.find((f) => f.id === targetFighterId);
  if (!fighter || !classHasPassive(fighter.class, "thorns")) return { state, events: [] };
  const effectiveArmor = fighter.armor_power + resilientBonus(fighter, state.ability_state, state.round);
  // R1 25% reflect, R2 35%, R3 45%.
  const reflectPct = 0.15 + 0.10 * fighterRank(fighter, "thorns");
  const amount = Math.max(1, Math.floor(effectiveArmor * reflectPct));
  const monster = state.monsters.find((m) => m.id === monsterId && m.hp > 0);
  if (!monster) return { state, events: [] };
  const newHp = Math.max(0, monster.hp - amount);
  return {
    state: { ...state, monsters: state.monsters.map((m) => m.id === monsterId ? { ...m, hp: newHp } : m) },
    events: [{ type: "passive_warden_thorns", actor: targetFighterId, target: monsterId, amount }],
  };
}

// DevOps Mage — Mana Font. Restores 1 mana every 3 actions (always-on). Uses
// CombatState.action_counters to track per-fighter action count across the fight.
const MANA_FONT_INTERVAL = 3;
const MANA_FONT_AMOUNT = 1;

function applyManaFont(
  state: CombatState,
  actor: CombatFighter,
): { state: CombatState; events: CombatEvent[] } {
  if (!classHasPassive(actor.class, "mana_font")) return { state, events: [] };
  if (actor.mana >= actor.max_mana) return { state, events: [] };
  const counters = state.action_counters ?? {};
  const prev = counters[actor.id] ?? 0;
  const next = prev + 1;
  const updatedCounters = { ...counters, [actor.id]: next };
  // R1 every 3 turns, R2 every 2, R3 every turn.
  const rank = fighterRank(actor, "mana_font");
  const interval = rank >= 3 ? 1 : rank >= 2 ? 2 : MANA_FONT_INTERVAL;
  const fires = next % interval === 0;
  if (!fires) {
    return { state: { ...state, action_counters: updatedCounters }, events: [] };
  }
  const newMana = Math.min(actor.max_mana, actor.mana + MANA_FONT_AMOUNT);
  const added = newMana - actor.mana;
  const updated = state.fighters.map((f) =>
    f.id === actor.id ? { ...f, mana: newMana } : f,
  );
  return {
    state: { ...state, fighters: updated, action_counters: updatedCounters },
    events: [{ type: "passive_mage_mana_font", actor: actor.id, amount: added }],
  };
}

// Backend Druid — Database-Tree Communion. +1 HP at the start of every Druid
// action (always-on). Clamped to max_hp; emits nothing if already at full HP.
function applyDruidRegen(
  state: CombatState,
  actor: CombatFighter,
): { state: CombatState; events: CombatEvent[] } {
  if (!classHasPassive(actor.class, "db_tree_communion")) return { state, events: [] };
  if (actor.hp <= 0) return { state, events: [] };
  const regenAmount = DRUID_PASSIVE_REGEN + Math.floor(actor.level / 6);
  const newHp = Math.min(actor.max_hp, actor.hp + regenAmount);
  const added = newHp - actor.hp;
  if (added <= 0) return { state, events: [] };
  const updated = state.fighters.map((f) =>
    f.id === actor.id ? { ...f, hp: newHp } : f,
  );
  return {
    state: { ...state, fighters: updated },
    events: [{ type: "passive_druid_regen", actor: actor.id, amount: added }],
  };
}

// Pre-action passive hook for player handlers. Applies Warden harden-up and
// Druid regen. Returns the new fighter snapshot too so the calling handler
// can use up-to-date HP/shield values.
function applyPreActionPassives(
  state: CombatState,
  actorId: ActorId,
): { state: CombatState; fighter: CombatFighter; events: CombatEvent[] } {
  const fighter = state.fighters.find((f) => f.id === actorId);
  if (!fighter) return { state, fighter: fighter as unknown as CombatFighter, events: [] };
  // Tick down Brace turns for this actor before other passives fire.
  const braceEntry = state.ability_state?.brace?.[actorId];
  let s = state;
  if (braceEntry) {
    const remaining = braceEntry.turns_remaining - 1;
    if (remaining <= 0) {
      s = { ...s, ability_state: stripField(s.ability_state, "brace") ?? {} };
    } else {
      s = {
        ...s,
        ability_state: {
          ...(s.ability_state ?? {}),
          brace: { ...s.ability_state!.brace, [actorId]: { ...braceEntry, turns_remaining: remaining } },
        },
      };
    }
  }
  // Tick down Taunt Fortify turns for this actor.
  const fortifyEntry = s.ability_state?.taunt_fortify?.[actorId];
  if (fortifyEntry) {
    const remaining = fortifyEntry.turns_remaining - 1;
    if (remaining <= 0) {
      const { [actorId]: _dropped, ...restFortify } = s.ability_state?.taunt_fortify ?? {};
      s = {
        ...s,
        ability_state: Object.keys(restFortify).length > 0
          ? { ...(s.ability_state ?? {}), taunt_fortify: restFortify }
          : (stripField(s.ability_state, "taunt_fortify") ?? {}),
      };
    } else {
      s = {
        ...s,
        ability_state: {
          ...(s.ability_state ?? {}),
          taunt_fortify: { ...s.ability_state!.taunt_fortify, [actorId]: { turns_remaining: remaining } },
        },
      };
    }
  }
  // Clean up expired Resilient stacks for this actor.
  const resilientStacks = s.ability_state?.resilient?.[actorId];
  if (resilientStacks) {
    const activeStacks = resilientStacks.filter((exp) => exp >= s.round);
    if (activeStacks.length < resilientStacks.length) {
      if (activeStacks.length === 0) {
        const { [actorId]: _dropped, ...restResilient } = s.ability_state?.resilient ?? {};
        s = {
          ...s,
          ability_state: Object.keys(restResilient).length > 0
            ? { ...(s.ability_state ?? {}), resilient: restResilient }
            : (stripField(s.ability_state, "resilient") ?? {}),
        };
        // Clamp shield to new (lower) cap if it now exceeds it.
        const currentFighterForClamp = s.fighters.find((f) => f.id === actorId);
        if (currentFighterForClamp) {
          const newCap = currentFighterForClamp.max_hp * SHIELD_CAP_MULTIPLIER;
          if (currentFighterForClamp.shield > newCap) {
            s = { ...s, fighters: s.fighters.map((f) => f.id === actorId ? { ...f, shield: newCap } : f) };
          }
        }
      } else {
        s = {
          ...s,
          ability_state: {
            ...(s.ability_state ?? {}),
            resilient: { ...s.ability_state!.resilient, [actorId]: activeStacks },
          },
        };
        // Clamp shield to the new (reduced) cap.
        const currentFighterForClamp = s.fighters.find((f) => f.id === actorId);
        if (currentFighterForClamp) {
          const newCap = currentFighterForClamp.max_hp * SHIELD_CAP_MULTIPLIER + resilientBonus(currentFighterForClamp, s.ability_state, s.round);
          if (currentFighterForClamp.shield > newCap) {
            s = { ...s, fighters: s.fighters.map((f) => f.id === actorId ? { ...f, shield: newCap } : f) };
          }
        }
      }
    }
  }
  // Tick down Animal Form and revert stat bonuses on expiry.
  const animalFormEntry = s.ability_state?.animal_form?.[actorId];
  if (animalFormEntry) {
    const remaining = animalFormEntry.turns_remaining - 1;
    if (remaining <= 0) {
      const af = s.fighters.find((f) => f.id === actorId)!;
      const newMaxHp = af.max_hp - animalFormEntry.hp_delta;
      const revertedFighter: typeof af = {
        ...af,
        attack_mod: af.attack_mod - animalFormEntry.atk_delta,
        max_hp: newMaxHp,
        hp: Math.min(af.hp, newMaxHp),
        ...(af.stats ? {
          stats: {
            ...af.stats,
            str: af.stats.str - animalFormEntry.str_bonus,
            vit: af.stats.vit - animalFormEntry.vit_bonus,
            agi: af.stats.agi - animalFormEntry.agi_bonus,
            dex: af.stats.dex - animalFormEntry.dex_bonus,
          },
        } : {}),
      };
      s = { ...s, fighters: s.fighters.map((f) => f.id === actorId ? revertedFighter : f) };
      const afMap = { ...(s.ability_state?.animal_form ?? {}) };
      delete afMap[actorId];
      s = { ...s, ability_state: Object.keys(afMap).length > 0 ? { ...s.ability_state, animal_form: afMap } : (stripField(s.ability_state, "animal_form") ?? {}) };
    } else {
      s = { ...s, ability_state: { ...s.ability_state, animal_form: { ...s.ability_state!.animal_form, [actorId]: { ...animalFormEntry, turns_remaining: remaining } } } };
    }
  }

  const currentFighter = s.fighters.find((f) => f.id === actorId) ?? fighter;
  const armorUp = applyWardenArmorUp(s, currentFighter);
  const armorUpFighter = armorUp.state.fighters.find((f) => f.id === actorId) ?? currentFighter;
  const druid = applyDruidRegen(armorUp.state, armorUpFighter);
  const druidFighter = druid.state.fighters.find((f) => f.id === actorId) ?? armorUpFighter;
  const mana = applyManaFont(druid.state, druidFighter);
  const finalFighter = mana.state.fighters.find((f) => f.id === actorId) ?? druidFighter;
  return {
    state: mana.state,
    fighter: finalFighter,
    events: [...armorUp.events, ...druid.events, ...mana.events],
  };
}

// Frontend Bard — Bardic Aura. While any Bard is alive, every non-Bard
// partymate attack deals +(1 + floor(bard.level/5)) damage. Battle Hymn
// temporarily adds BARD_AURA_HYMN_BONUS on top for Battle Hymn's duration.
function computeBardAuraBonus(
  state: CombatState,
): { bonus: number } {
  const bard = state.fighters.find(
    (f) => f.hp > 0 && classHasPassive(f.class, "bardic_aura"),
  );
  if (!bard) return { bonus: 0 };
  // R1 +0, R2 +1, R3 +2 on top of the level scaling.
  const rankBonus = Math.max(0, fighterRank(bard, "bardic_aura") - 1);
  const base = 1 + Math.floor(bard.level / 5) + rankBonus;
  const hymnActive =
    state.ability_state?.battle_hymn != null &&
    state.round <= state.ability_state.battle_hymn.expires_after_round;
  return { bonus: hymnActive ? base + BARD_AURA_HYMN_BONUS + bard.magic_mod : base };
}

// Data Warlock — Sinister Queries passive: fires on any hit (attack, cast, or ability damage).
// Applies 1 + floor(level/5) bleed stacks to the target monster.
function applySinisterQueries(
  state: CombatState,
  actor: CombatFighter,
  targetMonsterId: ActorId,
): { state: CombatState; events: CombatEvent[] } {
  if (!classHasPassive(actor.class, "sinister_queries")) return { state, events: [] };
  const targetMonster = state.monsters.find((m) => m.id === targetMonsterId && m.hp > 0);
  if (!targetMonster) return { state, events: [] };
  // R1 +0, R2 +1, R3 +2 bleed stacks on top of the level scaling.
  const magnitude = 1 + Math.floor(actor.level / 5) + Math.max(0, fighterRank(actor, "sinister_queries") - 1);
  const newEffect: MachineStatusEffect = { type: "bleeding", magnitude, remaining: 3, source: actor.id };
  return {
    state: {
      ...state,
      monsters: state.monsters.map((m) =>
        m.id === targetMonsterId ? { ...m, effects: mergeEffect(m.effects, newEffect) } : m,
      ),
    },
    events: [{ type: "passive_sinister_queries", actor: actor.id, target: targetMonsterId, magnitude }],
  };
}

// Hex bleed proc: whenever a hexed monster takes damage, apply 3 bleed stacks.
function applyHexBleedProc(
  state: CombatState,
  targetMonsterId: ActorId,
): { state: CombatState; events: CombatEvent[] } {
  const targetMonster = state.monsters.find((m) => m.id === targetMonsterId && m.hp > 0);
  if (!targetMonster || !targetMonster.effects.some((e) => e.type === "hexed")) return { state, events: [] };
  const stacks = 3;
  const newEffect: MachineStatusEffect = { type: "bleeding", magnitude: stacks, remaining: 3, source: "hex" };
  return {
    state: {
      ...state,
      monsters: state.monsters.map((m) =>
        m.id === targetMonsterId ? { ...m, effects: mergeEffect(m.effects, newEffect) } : m,
      ),
    },
    events: [{ type: "hex_bleed_proc", target: targetMonsterId, stacks }],
  };
}

// Elemental weapon proc. On a hit, the attacker's equipped weapon element
// (if any) has a rarity-gated chance to apply a status to the target monster.
// Resistance: 50% chance to block the proc entirely. Weakness: boosted magnitude/duration.
function applyElementalProc(
  state: CombatState,
  fighter: CombatFighter,
  targetMonsterId: ActorId,
  roll: RollFn,
): { state: CombatState; events: CombatEvent[] } {
  if (!fighter.element || !fighter.weapon_rarity) return { state, events: [] };
  const procRate = ELEMENT_PROC_RATE[fighter.weapon_rarity];
  if (roll(100) > Math.round(procRate * 100)) return { state, events: [] };

  const targetMonster = state.monsters.find((m) => m.id === targetMonsterId && m.hp > 0);
  if (!targetMonster) return { state, events: [] };

  const effect = ELEMENT_META[fighter.element].effect;
  const hasWeakness = targetMonster.element_weakness === fighter.element;
  const hasResistance = targetMonster.element_resistance === fighter.element;

  // Resistance: 50% chance to block entirely.
  if (hasResistance && roll(2) === 1) {
    return {
      state,
      events: [{
        type: "elemental_proc", actor: fighter.id, target: targetMonsterId,
        element: fighter.element, effect, magnitude: 0, duration: 0, resisted: true,
      }],
    };
  }

  let magnitude: number;
  let duration: number;
  if (fighter.element === "fire") {
    magnitude = 1 + Math.floor(fighter.weapon_power / 5);
    if (hasWeakness) magnitude = Math.round(magnitude * 1.5);
    duration = 3;
  } else if (fighter.element === "ice") {
    magnitude = 1;
    duration = hasWeakness ? 2 : 1;
  } else {
    // lightning → shocked: magnitude encodes amplification (1 = 30%, 2 = 45%)
    magnitude = hasWeakness ? 2 : 1;
    duration = 2;
  }

  const newEffect: MachineStatusEffect = { type: effect, magnitude, remaining: duration, source: fighter.id };
  const updatedMonsters = state.monsters.map((m) =>
    m.id === targetMonsterId ? { ...m, effects: mergeEffect(m.effects, newEffect) } : m,
  );
  return {
    state: { ...state, monsters: updatedMonsters },
    events: [{
      type: "elemental_proc", actor: fighter.id, target: targetMonsterId,
      element: fighter.element, effect, magnitude, duration, resisted: false,
    }],
  };
}

// Monster → fighter elemental status proc. Mirrors `applyElementalProc`
// for the inverse direction. Fires only on non-physical, non-magic hits
// (fire/ice/lightning); magic damage is "pure" by design — bypasses
// armor but doesn't proc.
//
// Resistance lowers proc chance proportionally — a fighter with 100% resist
// is immune; 50% resist halves the chance. Tier scales the burn magnitude
// modestly so high-tier monsters chip harder, but ice/lightning stay flat
// (their effect is the lock-out / damage amp, not the magnitude).
const MONSTER_ELEMENT_PROC_RATE = 0.25;

function applyMonsterElementalProc(
  state: CombatState,
  monster: CombatMonster,
  targetFighterId: ActorId,
  damageType: DamageType,
  targetResistPct: number,
  roll: RollFn,
): { state: CombatState; events: CombatEvent[] } {
  if (damageType !== "fire" && damageType !== "ice" && damageType !== "lightning") {
    return { state, events: [] };
  }
  const fighter = state.fighters.find((f) => f.id === targetFighterId && f.hp > 0);
  if (!fighter) return { state, events: [] };

  const adjustedRate = MONSTER_ELEMENT_PROC_RATE * Math.max(0, 1 - targetResistPct / 100);
  if (adjustedRate <= 0) return { state, events: [] };
  if (roll(100) > Math.round(adjustedRate * 100)) return { state, events: [] };

  let effect: "burning" | "frozen" | "shocked";
  let magnitude: number;
  let duration: number;
  if (damageType === "fire") {
    effect = "burning";
    magnitude = 1 + Math.floor(monster.tier / 4);
    duration = 3;
  } else if (damageType === "ice") {
    effect = "frozen";
    magnitude = 1;
    duration = 1;
  } else {
    // lightning → shocked: magnitude encodes amplification (1 = 30%, 2 = 45%);
    // monsters only inflict tier-1 unless they're elite (tier >= 6).
    effect = "shocked";
    magnitude = monster.tier >= 6 ? 2 : 1;
    duration = 2;
  }

  const newEffect: MachineStatusEffect = {
    type: effect, magnitude, remaining: duration, source: monster.id,
  };
  const updatedFighters = state.fighters.map((f) =>
    f.id === targetFighterId ? { ...f, effects: mergeEffect(f.effects, newEffect) } : f,
  );
  return {
    state: { ...state, fighters: updatedFighters },
    events: [{
      type: "monster_elemental_proc",
      actor: monster.id,
      target: targetFighterId,
      element: damageType,
      effect,
      magnitude,
      duration,
    }],
  };
}

// Status-effect stacking policy. Without this, applying the same effect
// twice produced two parallel timers that each ticked independently —
// correct under "independent dots" semantics but visually noisy in the UI
// (one pill per stack) and not what most players intuit. We pick one of
// two merge modes per type:
//   - "stack":   damage-over-time effects merge into one entry. Magnitude
//                sums up to `maxMagnitude`. Remaining ticks = max(existing,
//                incoming) so you can't shorten an effect by overstacking.
//   - "refresh": buffs/regen take the BETTER magnitude (max) and the
//                LONGER duration. A new stronger application overrides; a
//                weaker one just refreshes the timer.
const EFFECT_STACK_POLICY: Record<EffectType, { mode: "stack" | "refresh"; maxMagnitude: number }> = {
  regen:     { mode: "refresh", maxMagnitude: 12 },
  bleeding:  { mode: "stack",   maxMagnitude: 6 },
  burning:   { mode: "stack",   maxMagnitude: 6 },
  poisoned:  { mode: "stack",   maxMagnitude: 6 },
  empowered: { mode: "refresh", maxMagnitude: 50 },
  frozen:    { mode: "refresh", maxMagnitude: 2 },
  shocked:   { mode: "refresh", maxMagnitude: 2 },
  stunned:   { mode: "refresh", maxMagnitude: 1 },
  hexed:     { mode: "refresh", maxMagnitude: 1 },
  entangled: { mode: "refresh", maxMagnitude: 1 },
  barkskin:    { mode: "refresh", maxMagnitude: 1 },
  animal_form: { mode: "refresh", maxMagnitude: 1 },
};

// Merge `incoming` into the existing effect list. If an effect of the
// same type is already present, applies the per-type policy; otherwise
// appends. Returns a fresh array (never mutates input). All effect-apply
// sites (warlock bleed, consumables, future class actives) should go
// through this so the engine + UI behave consistently.
export function mergeEffect(
  effects: MachineStatusEffect[],
  incoming: MachineStatusEffect,
): MachineStatusEffect[] {
  const policy = EFFECT_STACK_POLICY[incoming.type];
  const existingIdx = effects.findIndex((e) => e.type === incoming.type);
  if (existingIdx < 0) {
    // First instance of this type — clamp magnitude to cap and push.
    return [...effects, { ...incoming, magnitude: Math.min(incoming.magnitude, policy.maxMagnitude) }];
  }
  const existing = effects[existingIdx];
  const mergedMagnitude = policy.mode === "stack"
    ? Math.min(existing.magnitude + incoming.magnitude, policy.maxMagnitude)
    : Math.min(Math.max(existing.magnitude, incoming.magnitude), policy.maxMagnitude);
  const mergedRemaining = Math.max(existing.remaining, incoming.remaining);
  // Source attribution: keep whichever provided the bigger contribution.
  // For "stack" mode we credit the latest applier; for "refresh" the one
  // whose magnitude won. Mostly cosmetic — used in tick-event flavor.
  const source = policy.mode === "stack"
    ? (incoming.source ?? existing.source)
    : (incoming.magnitude >= existing.magnitude ? (incoming.source ?? existing.source) : (existing.source ?? incoming.source));
  const next = [...effects];
  next[existingIdx] = {
    ...existing,
    magnitude: mergedMagnitude,
    remaining: mergedRemaining,
    source,
  };
  return next;
}

// QA Paladin — Holy Rage helpers.

// Accumulate raw hpDamage into holy_rage for every alive paladin in party.
// Fires when any party member (including the paladin themselves) takes damage.
// The 10% bonus is applied at consume time (floor(total * 0.1)), so small hits
// stack without being discarded by per-hit rounding.
function accumulateHolyRage(state: CombatState, hpDamage: number): CombatState {
  const paladins = state.fighters.filter((f) => f.hp > 0 && classHasPassive(f.class, "holy_rage"));
  if (paladins.length === 0) return state;
  const prev = state.ability_state?.holy_rage ?? {};
  const updated: Record<ActorId, number> = { ...prev };
  for (const p of paladins) {
    updated[p.id] = (updated[p.id] ?? 0) + hpDamage;
  }
  return { ...state, ability_state: { ...(state.ability_state ?? {}), holy_rage: updated } };
}

// Clear the holy_rage entry for a specific fighter (consume on attack).
function clearHolyRage(
  abilityState: AbilityRuntimeState | undefined,
  actorId: ActorId,
): AbilityRuntimeState | undefined {
  const prev = abilityState?.holy_rage;
  if (!prev || !prev[actorId]) return abilityState;
  const updated = { ...prev };
  delete updated[actorId];
  return Object.keys(updated).length > 0
    ? { ...(abilityState ?? {}), holy_rage: updated }
    : stripField(abilityState, "holy_rage");
}

// QA Paladin — Smite debuff: decrement (or clear) the debuff for a monster after its swing.
function consumeSmiteDebuff(
  state: AbilityRuntimeState | undefined,
  monsterId: ActorId,
): AbilityRuntimeState | undefined {
  const prev = state?.paladin_smite_debuff;
  if (!prev || !(monsterId in prev)) return state;
  const newCount = (prev[monsterId] ?? 1) - 1;
  const updated = { ...prev };
  if (newCount <= 0) delete updated[monsterId];
  else updated[monsterId] = newCount;
  return Object.keys(updated).length > 0
    ? { ...(state ?? {}), paladin_smite_debuff: updated }
    : stripField(state, "paladin_smite_debuff");
}

// ── Staff Sage helpers ────────────────────────────────────────────────────

// Blizzard: fire AoE damage + freeze proc at the end of the caster's turn.
// Rolls fresh 1d6 + mag damage against each alive monster, decrements charges.
// Returns killed monster IDs for the caller to resolve via resolveMonsterKill.
function applyBlizzardTick(
  state: CombatState,
  casterActor: ActorId,
  roll: RollFn,
): { state: CombatState; events: CombatEvent[]; killed: ActorId[] } {
  const blizzard = state.ability_state?.blizzard;
  if (!blizzard || blizzard.caster_id !== casterActor || blizzard.charges <= 0) {
    return { state, events: [], killed: [] };
  }
  const liveMonsters = state.monsters.filter((m) => m.hp > 0);
  if (liveMonsters.length === 0) return { state, events: [], killed: [] };

  const hits: Array<{ target: ActorId; damage: number }> = [];
  const killed: ActorId[] = [];
  let s = state;

  for (const m of liveMonsters) {
    const dmg = roll(6) + blizzard.mag;
    const newHp = Math.max(0, m.hp - dmg);
    hits.push({ target: m.id, damage: dmg });
    s = {
      ...s,
      monsters: s.monsters.map((mon) => mon.id === m.id ? { ...mon, hp: newHp } : mon),
      contribution: { ...s.contribution, [casterActor]: (s.contribution[casterActor] ?? 0) + dmg },
    };
    if (newHp <= 0) {
      killed.push(m.id);
    } else {
      // 10% freeze chance per surviving target.
      if (roll(100) <= 10) {
        const frozenEff: MachineStatusEffect = { type: "frozen", magnitude: 1, remaining: 1, source: casterActor };
        s = { ...s, monsters: s.monsters.map((mon) => mon.id === m.id ? { ...mon, effects: mergeEffect(mon.effects, frozenEff) } : mon) };
      }
    }
  }

  const newCharges = blizzard.charges - 1;
  const ability_state: AbilityRuntimeState | undefined = newCharges > 0
    ? { ...(s.ability_state ?? {}), blizzard: { ...blizzard, charges: newCharges } }
    : stripField(s.ability_state, "blizzard");
  s = { ...s, ability_state };

  const tickEvent: CombatEvent = { type: "ability_blizzard_tick", actor: casterActor, charges_remaining: newCharges, hits };
  return { state: s, events: [tickEvent], killed };
}

// Good Fortune: fire the stored delayed heal at the start of the caster's next turn.
function applyGoodFortuneDelayed(
  state: CombatState,
  casterActor: ActorId,
): { state: CombatState; events: CombatEvent[] } {
  const gf = state.ability_state?.good_fortune;
  if (!gf || gf.caster_id !== casterActor) return { state, events: [] };

  const ability_state = stripField(state.ability_state, "good_fortune");
  let s: CombatState = { ...state, ability_state };

  const target = s.fighters.find((f) => f.id === gf.target_id && f.hp > 0);
  if (!target) return { state: s, events: [] };

  const newHp = Math.min(target.max_hp, target.hp + gf.amount);
  const applied = newHp - target.hp;
  if (applied <= 0) return { state: s, events: [] };

  s = { ...s, fighters: s.fighters.map((f) => f.id === gf.target_id ? { ...f, hp: newHp } : f) };
  return { state: s, events: [{ type: "ability_good_fortune_delayed", actor: casterActor, target: gf.target_id, amount: applied }] };
}

// Ill Omen: accumulate HP damage dealt to an omen-marked monster.
// No-op if there is no active Ill Omen on the monster or damage is 0.
function accumulateIllOmenDamage(state: CombatState, monsterId: ActorId, hpDamage: number): CombatState {
  const entry = state.ability_state?.ill_omen?.[monsterId];
  if (!entry || hpDamage <= 0) return state;
  const ability_state: AbilityRuntimeState = {
    ...(state.ability_state ?? {}),
    ill_omen: {
      ...(state.ability_state?.ill_omen ?? {}),
      [monsterId]: { ...entry, accumulated: entry.accumulated + hpDamage },
    },
  };
  return { ...state, ability_state };
}

// Ill Omen: decrement the turn counter for a monster. On the 3rd monster act,
// burst 50% of accumulated damage and clear the omen. Returns `killed: true`
// if the burst reduces the monster to 0 HP (caller resolves the kill).
function tickIllOmenAtMonsterAct(
  state: CombatState,
  monsterId: ActorId,
): { state: CombatState; events: CombatEvent[]; killed: boolean; caster_id: ActorId | null } {
  const entry = state.ability_state?.ill_omen?.[monsterId];
  if (!entry) return { state, events: [], killed: false, caster_id: null };

  const newTurns = entry.monster_turns_remaining - 1;

  if (newTurns > 0) {
    const ability_state: AbilityRuntimeState = {
      ...(state.ability_state ?? {}),
      ill_omen: { ...(state.ability_state?.ill_omen ?? {}), [monsterId]: { ...entry, monster_turns_remaining: newTurns } },
    };
    return { state: { ...state, ability_state }, events: [], killed: false, caster_id: null };
  }

  // 3rd monster turn — burst fires; clear the entry.
  const burst = Math.floor(entry.accumulated * 0.5);
  const omUpdated = { ...(state.ability_state?.ill_omen ?? {}) };
  delete omUpdated[monsterId];
  const ability_state: AbilityRuntimeState | undefined = Object.keys(omUpdated).length > 0
    ? { ...(state.ability_state ?? {}), ill_omen: omUpdated }
    : stripField(state.ability_state, "ill_omen");
  let s: CombatState = { ...state, ability_state };

  const burstEvent: CombatEvent = { type: "ability_ill_omen_burst", actor: entry.caster_id, target: monsterId, accumulated: entry.accumulated, burst };

  if (burst <= 0) return { state: s, events: [burstEvent], killed: false, caster_id: entry.caster_id };

  const monster = s.monsters.find((m) => m.id === monsterId && m.hp > 0);
  if (!monster) return { state: s, events: [burstEvent], killed: false, caster_id: entry.caster_id };

  const newHp = Math.max(0, monster.hp - burst);
  s = {
    ...s,
    monsters: s.monsters.map((m) => m.id === monsterId ? { ...m, hp: newHp } : m),
    contribution: { ...s.contribution, [entry.caster_id]: (s.contribution[entry.caster_id] ?? 0) + burst },
  };
  return { state: s, events: [burstEvent], killed: newHp <= 0, caster_id: entry.caster_id };
}

// Remove a key from ability_state without mutating. Returns undefined if the
// resulting object is empty (so we don't carry dead state forever).
function stripField<K extends keyof AbilityRuntimeState>(
  state: AbilityRuntimeState | undefined,
  key: K,
): AbilityRuntimeState | undefined {
  if (!state) return undefined;
  const next: AbilityRuntimeState = { ...state };
  delete next[key];
  return Object.keys(next).length > 0 ? next : undefined;
}

function consumeEncourageCharge(
  state: AbilityRuntimeState | undefined,
  actorId: ActorId,
): AbilityRuntimeState | undefined {
  const charges = state?.encourage?.[actorId] ?? 0;
  if (!state || charges <= 0) return state;
  const newCharges = charges - 1;
  if (newCharges <= 0) {
    const enc = { ...state.encourage };
    delete enc[actorId];
    return Object.keys(enc).length > 0 ? { ...state, encourage: enc } : stripField(state, "encourage");
  }
  return { ...state, encourage: { ...state.encourage, [actorId]: newCharges } };
}

function consumeDiscourageCharge(
  state: AbilityRuntimeState | undefined,
  monsterId: ActorId,
): AbilityRuntimeState | undefined {
  const charges = state?.discourage?.[monsterId] ?? 0;
  if (!state || charges <= 0) return state;
  const newCharges = charges - 1;
  if (newCharges <= 0) {
    const disc = { ...state.discourage };
    delete disc[monsterId];
    return Object.keys(disc).length > 0 ? { ...state, discourage: disc } : stripField(state, "discourage");
  }
  return { ...state, discourage: { ...state.discourage, [monsterId]: newCharges } };
}

// Tick down per-swing counters (taunt swings, vanish counts) after a monster
// swing resolves — whether it landed or missed. Drops fields once exhausted.
function tickAbilityCountersAfterSwing(
  state: AbilityRuntimeState | undefined,
): AbilityRuntimeState | undefined {
  if (!state) return undefined;
  let next: AbilityRuntimeState | undefined = { ...state };
  if (next.taunt) {
    const remaining = next.taunt.swings_remaining - 1;
    if (remaining <= 0) next = stripField(next, "taunt");
    else next = { ...next, taunt: { ...next.taunt, swings_remaining: remaining } };
  }
  if (next?.vanished) {
    const updated: Record<ActorId, number> = {};
    for (const [id, count] of Object.entries(next.vanished)) {
      const dec = count - 1;
      if (dec > 0) updated[id] = dec;
    }
    next = Object.keys(updated).length > 0
      ? { ...next, vanished: updated }
      : stripField(next, "vanished");
  }
  return next && Object.keys(next).length > 0 ? next : undefined;
}

// --- Helpers ---

// Pub drink-buff consumption. Called from handlePlayerHit (attack | cast)
// and handleSignature when there's a damage event in flight. Returns the
// adjusted damage, whether a crit was forced (buff_next_crit), the event
// to append, and the new drink_buffs map for nextState. When the buff
// doesn't apply (wrong kind for the action, already-crit + buff_next_crit,
// or no buff present), returns the inputs unchanged with `event: null` so
// the caller can early-out cheaply.
//
// Application rules mirror the legacy slack handler:
//   buff_attack — only on attack actions; adds +magnitude flat damage
//   buff_magic  — only on cast actions; adds +magnitude flat damage
//   buff_next_crit — any of attack/cast/ability; force-crits when the
//     hit wasn't already a crit, doubling the (post-mod) damage. Skipped
//     when the hit was already a crit so we don't waste the single charge
//     on a redundant doubling.
// Consumption: decrement `remaining`; clear from the map when it hits 0.
function applyDrinkBuff(
  state: CombatState,
  actor: ActorId,
  context: "attack" | "ability",
  baseDamage: number,
  isCrit: boolean,
): {
  damage: number;
  forceCrit: boolean;
  event: CombatEvent | null;
  nextDrinkBuffs: Record<ActorId, DrinkBuff> | undefined;
} {
  const buffs = state.drink_buffs;
  if (!buffs) {
    return { damage: baseDamage, forceCrit: false, event: null, nextDrinkBuffs: buffs };
  }
  const buff = buffs[actor];
  if (!buff) {
    return { damage: baseDamage, forceCrit: false, event: null, nextDrinkBuffs: buffs };
  }

  let applies = false;
  let damage = baseDamage;
  let forceCrit = false;
  if (buff.kind === "buff_attack" && context === "attack") {
    damage = baseDamage + buff.magnitude;
    applies = true;
  } else if (buff.kind === "buff_next_crit" && !isCrit) {
    damage = baseDamage * 2;
    forceCrit = true;
    applies = true;
  }

  if (!applies) {
    return { damage: baseDamage, forceCrit: false, event: null, nextDrinkBuffs: buffs };
  }

  // fight_duration buffs apply every action for the whole fight — no countdown.
  // writebackDrinkBuffs clears them after the fight instead of persisting them.
  const nextDrinkBuffs: Record<ActorId, DrinkBuff> = { ...buffs };
  let newRemaining: number;
  if (buff.fight_duration) {
    newRemaining = buff.remaining; // unchanged
    nextDrinkBuffs[actor] = buff;
  } else {
    newRemaining = Math.max(0, buff.remaining - 1);
    if (newRemaining === 0) {
      delete nextDrinkBuffs[actor];
    } else {
      nextDrinkBuffs[actor] = { ...buff, remaining: newRemaining };
    }
  }

  const event: CombatEvent = {
    type: "drink_buff_consumed",
    actor,
    drink_id: buff.drink_id,
    kind: buff.kind,
    bonus: damage - baseDamage,
    force_crit: forceCrit,
    remaining: newRemaining,
  };

  return {
    damage,
    forceCrit,
    event,
    nextDrinkBuffs: Object.keys(nextDrinkBuffs).length > 0 ? nextDrinkBuffs : undefined,
  };
}

function reject(state: CombatState, reason: string): StepResult {
  return { state, events: [{ type: "rejected", reason }] };
}

function removeVanishForFighter(
  state: AbilityRuntimeState | undefined,
  actorId: ActorId,
): AbilityRuntimeState | undefined {
  if (!state?.vanished) return state;
  const updated = { ...state.vanished };
  delete updated[actorId];
  return Object.keys(updated).length > 0
    ? { ...state, vanished: updated }
    : stripField(state, "vanished");
}

function vulnerabilityMult(state: CombatState, monsterId: ActorId, round: number): number {
  const entry = state.ability_state?.vulnerable?.[monsterId];
  if (!entry || round > entry.expires_after_round) return 1.0;
  return 1 + entry.magnitude / 100;
}

function applyRogueLethalStrike(
  state: CombatState,
  actor: CombatFighter,
  targetMonsterId: ActorId,
): { state: CombatState; events: CombatEvent[] } {
  if (!classHasPassive(actor.class, "lethal_strikes")) return { state, events: [] };
  const targetMonster = state.monsters.find((m) => m.id === targetMonsterId && m.hp > 0);
  if (!targetMonster) return { state, events: [] };
  // R1 +0, R2 +1, R3 +2 bonus bleed stacks on top of the level scaling.
  const stacks = 2 + Math.floor(actor.level / 2) + Math.max(0, fighterRank(actor, "lethal_strikes") - 1);
  const duration = 2;
  const bleedEffect: MachineStatusEffect = { type: "bleeding", magnitude: stacks, remaining: duration, source: actor.id };
  const updated: CombatState = {
    ...state,
    monsters: state.monsters.map((m) =>
      m.id === targetMonsterId ? { ...m, effects: mergeEffect(m.effects, bleedEffect) } : m,
    ),
  };
  return {
    state: updated,
    events: [{ type: "passive_rogue_lethal_strike", actor: actor.id, magnitude: stacks, duration }],
  };
}

function applyEnvenomProc(
  state: CombatState,
  actor: CombatFighter,
  targetMonsterId: ActorId,
): { state: CombatState; events: CombatEvent[] } {
  const entry = state.ability_state?.envenomed_weapon?.[actor.id];
  if (!entry || entry.charges <= 0) return { state, events: [] };
  const targetMonster = state.monsters.find((m) => m.id === targetMonsterId && m.hp > 0);
  if (!targetMonster) return { state, events: [] };
  const { stacks, charges } = entry;
  const poisonEffect: MachineStatusEffect = { type: "poisoned", magnitude: stacks, remaining: 2, source: actor.id };
  const updatedWeapon = { ...(state.ability_state?.envenomed_weapon ?? {}) };
  if (charges - 1 <= 0) {
    delete updatedWeapon[actor.id];
  } else {
    updatedWeapon[actor.id] = { stacks, charges: charges - 1 };
  }
  const ability_state: AbilityRuntimeState | undefined = Object.keys(updatedWeapon).length > 0
    ? { ...(state.ability_state ?? {}), envenomed_weapon: updatedWeapon }
    : stripField(state.ability_state ?? {}, "envenomed_weapon");
  const updated: CombatState = {
    ...state,
    monsters: state.monsters.map((m) =>
      m.id === targetMonsterId ? { ...m, effects: mergeEffect(m.effects, poisonEffect) } : m,
    ),
    ability_state,
  };
  return {
    state: updated,
    events: [{ type: "ability_envenom_proc", actor: actor.id, target: targetMonsterId, stacks }],
  };
}

function currentActor(state: CombatState): ActorId | undefined {
  if (state.turn_order.length === 0) return undefined;
  return state.turn_order[state.turn_index % state.turn_order.length];
}

function computeTurnOrder(state: CombatState): ActorId[] {
  const entries: { id: ActorId; init: number }[] = [
    ...state.fighters.map((f) => ({ id: f.id, init: f.initiative })),
    ...state.monsters.map((m) => ({ id: m.id, init: m.initiative })),
  ];
  // Highest initiative first; ties broken by id for determinism.
  entries.sort((a, b) => (b.init - a.init) || a.id.localeCompare(b.id));
  return entries.map((e) => e.id);
}

// Advances turn_index past any downed fighters or dead monsters so the next
// live actor takes the turn. Increments round when wrapping.
function tickActorCooldowns(state: CombatState, actorId: ActorId): CombatState {
  // Gear-affix mana_regen — restore mana at the start of the actor's turn.
  // Silent (no event) for v1 to keep the combat log uncluttered; players see
  // the mana bar tick visually. Capped at max_mana so it never overflows.
  const actor = state.fighters.find((f) => f.id === actorId);
  const manaRegenAmt = actor?.affix_effects?.mana_regen ?? 0;
  let next = state;
  if (actor && manaRegenAmt > 0 && actor.hp > 0 && actor.mana < actor.max_mana) {
    const restored = Math.min(manaRegenAmt, actor.max_mana - actor.mana);
    next = {
      ...next,
      fighters: next.fighters.map((f) => f.id === actorId ? { ...f, mana: f.mana + restored } : f),
    };
  }

  const actorCooldowns = next.cooldowns?.[actorId];
  if (!actorCooldowns || Object.keys(actorCooldowns).length === 0) return next;
  const updated: Record<string, number> = {};
  for (const [abilityId, remaining] of Object.entries(actorCooldowns)) {
    if (remaining > 1) updated[abilityId] = remaining - 1;
    // remaining === 1: cooldown expires this turn — omit from updated
  }
  const allCooldowns = { ...(next.cooldowns ?? {}), [actorId]: updated };
  if (Object.keys(updated).length === 0) {
    const { [actorId]: _removed, ...rest } = allCooldowns;
    return { ...next, cooldowns: Object.keys(rest).length > 0 ? rest : undefined };
  }
  return { ...next, cooldowns: allCooldowns };
}

// advanceTurn moves the cursor to the next live actor and bumps the round
// counter when it wraps. Optional `outEvents`: when provided, ground_expired
// events from round-advance expiration are pushed into it so callers can
// surface them to the UI (canvas fade-outs, combat log "Fire Wall fades").
// Callers without an events accumulator can omit the param — events are
// silently dropped, preserving back-compat with the legacy single-arg shape.
function advanceTurn(state: CombatState, outEvents?: CombatEvent[]): CombatState {
  if (state.turn_order.length === 0) return state;
  const total = state.turn_order.length;
  for (let i = 1; i <= total; i++) {
    const candidate = state.turn_index + i;
    const id = state.turn_order[candidate % total];
    const roundBump = Math.floor(state.turn_index / total) < Math.floor(candidate / total) ? 1 : 0;
    const newRound = state.round + roundBump;
    // Round-advance expiration: when the round counter increments, drop
    // ground effects whose duration has run out. Surface ground_expired
    // events into `outEvents` if provided so the UI can animate fade-outs.
    const expiry = roundBump > 0 ? expireGroundEffects(state, newRound) : { state, events: [] as CombatEvent[] };
    if (outEvents && expiry.events.length > 0) outEvents.push(...expiry.events);
    const stateForCheck = expiry.state;
    if (isMonsterActor(id)) {
      const m = stateForCheck.monsters.find((x) => x.id === id);
      if (m && m.hp > 0) {
        return { ...stateForCheck, turn_index: candidate, round: newRound, turn_phase: "move" };
      }
      // Dead monster slot — keep scanning. We carry the expired state
      // forward so a second wrap of the round counter doesn't try to
      // expire already-dropped effects.
      state = stateForCheck;
      continue;
    }
    const f = stateForCheck.fighters.find((x) => x.id === id);
    if (f && f.hp > 0) {
      const next: CombatState = { ...stateForCheck, turn_index: candidate, round: newRound, turn_phase: "move" };
      return tickActorCooldowns(next, id);
    }
    state = stateForCheck;
  }
  // Shouldn't reach here unless the whole party is down — defeat is detected
  // by the caller in handleMonsterAct before we get here.
  return state;
}

function turnStartEvent(state: CombatState): CombatEvent[] {
  const actor = currentActor(state);
  if (!actor) return [];
  return [{ type: "turn_start", actor, round: state.round }];
}
