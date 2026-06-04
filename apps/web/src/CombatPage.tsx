import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import toast from "react-hot-toast";
import { isMonsterActor, classByName, activeAbilities, hexDistance, findNode, type AbilityLoadout, type ActiveAbilityDef, isAllyNpcActor } from "@gantt-quest/core";
import { buildBurndown, BurndownChart } from "./CombatBurndown";
import { InventoryFullScreen } from "./components/Inventory";
import type { Item } from "./types";

import { Avatar, Icon } from "./icons";
import { CombatBackdropLayer, pickScene, viewArtKeyForScene } from "./combatBackgrounds";
import { CombatParticles, CombatParticlesProvider, triggerBurst, type BurstKind } from "./CombatParticles";
import {
  CombatHexGrid,
  particleKindForEvent,
  projectileKindForAttack,
  type CombatHexGridHandle,
  type ParticleKind,
  type ProjectileKind,
} from "./CombatHexGrid";
import { RailParticipantCard, type PawnLike } from "./PawnCallout";
import { CharacterSheetModal, type CharacterSheetSubject } from "./CharacterSheetModal";
import {
  DISPLAY_FONT,
  ensureCombatAnimStyles,
  useIsMobile,
  classPortraitUrl,
  charPortraitUrl,
  slugifyName,
  TONE_COLOR,
  PURPOSE_LABEL,
  BigHpBar,
  CBtn,
  DiceRollDisplay,
  DiceRollEntry,
  InitStrip,
  CombatLog,
  LogEntry,
  ReviveTargetPicker,
  GiveItemPicker,
  GiveTargetPicker,
  TargetPicker,
  PickerModal,
  isCombatUsable,
  lootIcon,
  HitDust,
  HealBurst,
  ShieldBurst,
  ShieldGlow,
  CombatFighter,
  CombatItem,
  CombatDevModal,
  StatusEffect,
  PillSize,
  StatusPill,
  EFFECT_PILLS,
} from "./CombatShared";

ensureCombatAnimStyles();

// Live web-mode combat. Connects to the QuestRoom Durable Object via WS,
// renders the current state, animates incoming events through a scrolling
// log, and lets the active player submit actions.

interface Fighter {
  id: string;
  name: string;
  slack_username?: string | null;
  class: string;
  level: number;
  hp: number;
  max_hp: number;
  mana: number;
  max_mana: number;
  shield: number;
  position: "front" | "back";
  attack_mod: number;
  magic_mod: number;
  weapon_power: number;
  armor_power: number;
  initiative: number;
  effects: StatusEffect[];
  scars: string[];
  // Hex grid fields (added with tactical combat). Optional for backward compat.
  pos?: { q: number; r: number };
  weapon_range?: "melee" | "ranged" | "focus";
  element?: "fire" | "ice" | "lightning";
  stats?: { str: number; int_stat: number; vit: number; agi: number; dex: number };
  // Talent-tree fields broadcast from the engine. Used by the character sheet
  // to show the passives this fighter actually has slotted, instead of the
  // full class kit.
  equipped_passive_ids?: string[];
  talent_ranks?: Record<string, number>;
}

interface Monster {
  id?: string;
  name: string;
  hp: number;
  max_hp: number;
  tier: number;
  initiative: number;
  effects: StatusEffect[];
  is_boss: boolean;
  boss_phase: 1 | 2;
  // Depletable armor pool. Starts at `tier`; players drain it before HP damage.
  // Surfaced on the callout's shield bar segment.
  shield?: number;
  wave?: number;
  total_waves?: number;
  tower_floor?: number;
  tower_cycle?: number;
  art_url?: string;
  element_weakness?: "fire" | "ice" | "lightning";
  element_resistance?: "fire" | "ice" | "lightning";
  // What damage type the monster's attacks deal. Non-physical bypasses
  // the player armor pool entirely; surfaced on the monster card so
  // players see it before the swing lands.
  attack_damage_type?: "physical" | "magic" | "fire" | "ice" | "lightning";
  // Hex grid fields (added with tactical combat). Optional for backward compat.
  pos?: { q: number; r: number };
  weapon_range?: "melee" | "ranged" | "focus";
  move_range?: number;
  range_tiles?: number;
  specials?: string[];
}

interface CombatState {
  fighters: Fighter[];
  monsters: Monster[];
  turn_order: string[];
  turn_index: number;
  round: number;
  status: "pending" | "active" | "victory" | "defeat" | "fled";
  ability_state?: {
    mark?: { marked_by: string; expires_after_round: number; monster_id?: string };
    [key: string]: unknown;
  };
  cooldowns?: Record<string, Record<string, number>>;
  // Hex grid fields (added with tactical combat).
  grid?: { cols: number; rows: number };
  turn_phase?: "move" | "attack";
  obstacles?: { pos: { q: number; r: number }; kind: string }[];
  scene?: string;
  hex_range_enabled?: boolean;
}

// Mirrors BARD_AURA_HYMN_DAMAGE in combat_machine.ts — keep in sync.

type CombatEvent =
  | { type: "begin"; turn_order: string[]; initiatives: Record<string, number> }
  | { type: "turn_start"; actor: string; round: number }
  | { type: "roll"; actor: string; die: string; value: number; purpose: string }
  | {
      type: "hit_check";
      actor: string;
      target: string;
      roll: number;
      modifier: number;
      total: number;
      ac: number;
      hit: boolean;
    }
  | { type: "player_hit"; actor: string; target: string; damage: number; crit: boolean; formula: string; damage_type?: "physical" | "magic" | "fire" | "ice" | "lightning" }
  | {
      type: "monster_attack";
      actor: string;
      target: string;
      raw_damage: number;
      damage_after_position: number;
      damage_after_armor: number;
      shield_absorbed: number;
      hp_damage: number;
      // Engine emits this on every monster_attack. Non-physical types
      // bypass the depletable armor pool entirely (intentional rule), so
      // we surface the type clearly in the log to avoid the "why didn't
      // my shield block this?" confusion.
      damage_type?: "physical" | "magic" | "fire" | "ice" | "lightning";
      // Resistance reduction (from the target's stat_bonus.resist_<type>).
      // Surfaced in the breakdown when present.
      resistance_reduction?: number;
    }
  | { type: "boss_phase_transition"; new_phase: 2 }
  | { type: "fighter_down"; target: string }
  | { type: "monster_down"; killed_by: string }
  | { type: "heal_applied"; actor: string; target: string; amount: number; rolled: number }
  | { type: "shield_applied"; actor: string; target: string; restored: number; new_armor: number; bonus_barrier?: boolean }
  | { type: "effect_applied"; actor: string; target: string; effect: "burning" | "frozen" | "shocked" | "poisoned" | "bleeding" | "entangled" | "stunned" | "hexed" | "empowered" | "regen" | "barkskin" | "animal_form"; magnitude: number; duration: number }
  | {
      type: "flee_check";
      actor: string;
      roll: number;
      modifier: number;
      total: number;
      dc: number;
      success: boolean;
    }
  | { type: "fled" }
  | {
      type: "position_changed";
      actor: string;
      from: "front" | "back";
      to: "front" | "back";
    }
  | {
      type: "wave_transition";
      from_monster: string;
      to_monster: string;
      to_max_hp: number;
      new_wave: number;
      total_waves: number;
    }
  | {
      type: "effect_tick";
      actor: string;
      effect: "regen" | "bleeding" | "burning" | "poisoned";
      magnitude: number;
      hp_delta: number;
      source?: string;
    }
  | {
      type: "ability_used";
      actor: string;
      ability_id: string;
      name: string;
      mana_spent: number;
    }
  | { type: "ability_taunt"; actor: string; swings: number }
  | { type: "ability_containerize" }
  | {
      type: "ability_regression_shield";
      actor: string;
      grants: { target: string; amount: number }[];
    }
  | { type: "ability_vanish"; actor: string; swings: number }
  | {
      type: "ability_soul_drain";
      actor: string;
      damage: number;
      healed: number;
      roll: number;
      formula: string;
    }
  | { type: "ability_battle_hymn"; actor: string; expires_after_round: number }
  | { type: "ability_encourage"; actor: string; target: string; charges: number }
  | { type: "ability_mock"; actor: string; target: string; charges: number }
  | { type: "advantage_used"; actor: string; d20_a: number; d20_b: number; took: number }
  | { type: "disadvantage_used"; actor: string; d20_a: number; d20_b: number; took: number }
  | {
      type: "ability_foresee";
      actor: string;
      predicted_target: string | null;
      predicted_targets: Record<string, string>;
      damage_lo: number;
      damage_hi: number;
      net_lo: number;
      net_hi: number;
      verdict: "safe" | "at_risk" | "lethal";
      probabilities: Array<{ id: string; position: "front" | "back"; pct: number }>;
      triage: Array<{ id: string; hp: number; max_hp: number; shield: number; position: "front" | "back" }>;
      active: { stunned: number; taunt_actor: string | null; taunt_swings: number; vanished: string[] };
      turns_remaining: number;
    }
  | {
      type: "ability_migrate";
      actor: string;
      target: string;
      from: "front" | "back";
      to: "front" | "back";
    }
  | { type: "monster_swing_skipped"; reason: string }
  | { type: "monster_stun_broken"; turns_active: number }
  | { type: "monster_target_redirected"; from: string; to: string; reason: string }
  | { type: "monster_target_blocked"; reason: string }
  | {
      type: "monster_splash";
      targets: Array<{
        target: string;
        raw_damage: number;
        damage_after_armor: number;
        shield_absorbed: number;
        hp_damage: number;
      }>;
    }
  | { type: "battle_hymn_expired"; actor: string }
  | { type: "mark_applied"; actor: string; expires_after_round: number }
  | { type: "passive_warden_shield"; actor: string; amount: number }
  | { type: "passive_warden_thorns"; actor: string; target: string; amount: number }
  | { type: "passive_warden_armor_up"; actor: string; amount: number }
  | { type: "ability_brace"; actor: string; turns: number }
  | { type: "passive_mage_mana_font"; actor: string; amount: number }
  | { type: "passive_druid_regen"; actor: string; amount: number }
  | { type: "passive_rogue_lethal_strike"; actor: string; magnitude: number; duration: number }
  | { type: "ability_envenom_proc"; actor: string; target: string; stacks: number }
  | { type: "passive_bard_aura"; actor: string; source: string; bonus: number }
  | { type: "passive_warlock_bleed"; actor: string; magnitude: number; duration: number }
  | { type: "passive_holy_rage"; paladin: string; bonus: number }
  | { type: "ability_shield_of_faith"; actor: string; expires_after_round: number }
  | { type: "ability_protect"; actor: string; target: string }
  | { type: "ability_smite_debuff"; actor: string; target: string }
  | { type: "protect_triggered"; paladin: string; target: string; target_damage: number; paladin_damage: number }
  | { type: "passive_primal_strikes_heal"; actor: string; amount: number }
  | { type: "ability_regeneration"; actor: string; target: string; magnitude: number; duration: number }
  | { type: "ability_animal_form"; actor: string; str_bonus: number; vit_bonus: number; agi_bonus: number; dex_bonus: number; turns: number }
  | { type: "ability_barkskin"; actor: string; target: string; bonus: number; turns: number }
  | { type: "ability_wildgrowth_entangle"; actor: string; target: string; duration: number }
  | { type: "passive_rogue_first_crit"; actor: string }
  | { type: "passive_sinister_queries"; actor: string; target: string; magnitude: number }
  | { type: "ability_hex"; actor: string; target: string; duration: number }
  | { type: "ability_freeze_applied"; actor: string; target: string }
  | { type: "ability_burn_applied"; actor: string; target: string; magnitude: number; duration: number }
  | { type: "ability_shock_applied"; actor: string; target: string; magnitude: number; duration: number }
  | { type: "hex_bleed_proc"; target: string; stacks: number }
  | { type: "ability_forbidden_sql"; actor: string; target: string; stacks_consumed: number; damage: number }
  | { type: "passive_paladin_auto_heal"; paladin: string; target: string; amount: number }
  | {
      type: "drink_buff_consumed";
      actor: string;
      drink_id: string;
      kind: "buff_attack" | "buff_magic" | "buff_next_crit";
      bonus: number;
      force_crit: boolean;
      remaining: number;
    }
  | { type: "turn_skip"; actor: string; reason: "frozen" }
  | {
      type: "elemental_proc";
      actor: string;
      target: string;
      element: "fire" | "ice" | "lightning";
      effect: "burning" | "frozen" | "shocked";
      magnitude: number;
      duration: number;
      resisted: boolean;
    }
  | {
      type: "monster_elemental_proc";
      actor: string;          // monster id
      target: string;          // fighter id
      element: "fire" | "ice" | "lightning";
      effect: "burning" | "frozen" | "shocked";
      magnitude: number;
      duration: number;
    }
  | { type: "ability_good_fortune_delayed"; actor: string; target: string; amount: number }
  | { type: "ability_ill_omen_applied"; actor: string; target: string }
  | { type: "ability_ill_omen_burst"; actor: string; target: string; accumulated: number; burst: number }
  | { type: "victory" }
  | { type: "defeat" }
  | { type: "rejected"; reason: string }
  | {
      type: "loot_pickup";
      actor: string;
      tile_id: string;
      pos: { q: number; r: number };
      kind: "gold" | "item";
      gold?: number;
      item_tier?: number;
    }
  | ItemUsedEvent;

type TurnAction =
  | { kind: "attack"; actor: string; target_id?: string | null }
  | { kind: "flee"; actor: string }
  | { kind: "position"; actor: string; to: "front" | "back" }
  | { kind: "wait"; actor: string }
  | { kind: "mark"; actor: string; target_id?: string | null }
  | {
      kind: "ability";
      actor: string;
      ability_id: string;
      target_id?: string;   // monster target (single_enemy abilities)
      target?: string;      // fighter target (migrate)
      position?: "front" | "back";
    }
  | { kind: "monster_act" }
  | { kind: "ally_npc_act" }
  | { kind: "use_item"; actor: string; item_id: number; target_id?: string };

type ItemEffect =
  | { kind: "heal"; target: string; amount: number; rolled: number }
  | { kind: "mana_restore"; target: string; added: number; new_mana: number }
  | { kind: "mana_bump"; target: string; added: number; new_max_mana: number }
  | { kind: "revive"; target: string; hp_restored: number }
  | { kind: "monster_damage"; amount: number; capped_from?: number }
  | { kind: "self_effect"; target: string; effect: "regen"; magnitude: number; remaining: number }
  | {
      kind: "monster_effect";
      effect: "poisoned" | "bleeding" | "burning";
      magnitude: number;
      remaining: number;
    }
  | { kind: "party_mana_refill"; recipients: { user_id: string; restored: number }[] };

interface ItemUsedEvent {
  type: "item_used";
  actor: string;
  item_id: number;
  item_name: string;
  item_type: string;
  effect: ItemEffect;
}

interface InventoryItem {
  id: number;
  item_name: string;
  item_type: "weapon" | "armor" | "consumable" | "magic" | "revive" | "tool" | "scroll";
  power: number;
  rarity: "common" | "uncommon" | "rare";
  flavor: string | null;
  equipped: boolean;
}

interface LootDrop {
  item_name: string;
  item_type: string;
  power: number;
  rarity: string;
  flavor: string;
  weapon_range?: "melee" | "ranged" | "focus" | null;
  level_req?: number;
}

interface FighterReward {
  user_id: string;
  damage_dealt: number;
  damage_taken: number;
  healing_done: number;
  shielding_done: number;
  kills: number;
  xp_awarded: number;
  gold_awarded: number;
  level_up: boolean;
  new_level: number;
  loot: LootDrop[];
  soft_death: { gold_lost: number; item_lost: string | null; scar: string } | null;
}

interface OutcomeSummary {
  status: "victory" | "defeat" | "fled";
  rewards: FighterReward[];
  monster_name: string;
  monster_tier: number;
  total_pool_xp: number;
  total_pool_gold: number;
  elite: boolean;
  is_boss: boolean;
  tower_floor_cleared?: boolean;
  tower_next_floor_kind?: "combat" | "rest" | "boss";
  tower_awaiting_choice?: boolean;
  tower_cycle_complete?: boolean;
}

// LogEntry is imported from CombatShared — flat interface with side/content/tone.

interface UiState {
  connection: "connecting" | "open" | "reconnecting" | "closed";
  state: CombatState | null;
  log: LogEntry[];
  /** Unbounded copy of every CombatEvent we've received this fight. Powers
      the post-fight HP burndown chart in the victory/defeat modal. We don't
      slice this — fights are at most low-hundreds of events, well under the
      memory budget — because the burndown needs the full timeline. Wiped on
      `reset` like the formatted log. */
  rawEvents: CombatEvent[];
  error: string | null;
  outcome: OutcomeSummary | null;
}

type UiAction =
  | { kind: "connection"; value: UiState["connection"] }
  | { kind: "state"; value: CombatState }
  | { kind: "events"; value: CombatEvent[] }
  | { kind: "error"; value: string }
  | { kind: "outcome"; value: OutcomeSummary }
  | { kind: "flavor"; value: { kind: "hit" | "victory" | "death" | "flee"; actor: string; text: string } }
  // Tower floor transition — wipe outcome + log + state so the next floor's
  // WS frames render against a clean slate (no piled-up log entries from the
  // previous floor's fight).
  | { kind: "reset" };

let nextLogId = 1;

// ── AoE ability → particle burst mapping ─────────────────────────────────────
// Triggered on `ability_used` events for any ability whose routing is
// `aoe_damage` or target is `all_enemies` / `all_allies`. Keyed by
// `ability_id` so we don't need any new combat-machine events — every active
// ability already emits `ability_used` with its id.
const AOE_ABILITY_BURST: Record<string, BurstKind> = {
  // mage
  fireball: "fire",
  // sage
  blizzard: "ice",
  // druid
  wildgrowth: "nature",
  // bard
  battle_hymn: "music",
  // paladin
  shield_of_faith: "shield",
  // new_nodes / class talents
  cdn_surge: "lightning",
  bisect: "hit",
  mycelial_web: "nature",
  compost_heap: "heal",
  standup_meeting: "heal",
  unsubscribe_from_all: "dispel",
  hailstorm: "ice",
  circuit_breaker: "shield",
  drop_table: "curse",
  // time_dilation is single-target per the def, but its flavor matches slowtime
  time_dilation: "slowtime",
  // smoke_test targets self but its theme is a smoke cloud — fires at caster
  smoke_test: "smoke",
};

function reducer(s: UiState, a: UiAction): UiState {
  switch (a.kind) {
    case "connection":
      return { ...s, connection: a.value };
    case "state":
      return { ...s, state: a.value };
    case "events": {
      try {
        return {
          ...s,
          log: [...s.log, ...a.value.flatMap((e) => formatEvent(e, s.state))].slice(-50),
          rawEvents: [...s.rawEvents, ...a.value],
        };
      } catch (err) {
        console.error("[CombatPage] event render error:", err);
        return s;
      }
    }
    case "flavor": {
      const iconName = a.value.kind === "victory" ? "trophy"
        : a.value.kind === "death" ? "death-skull"
        : a.value.kind === "flee" ? "footprint"
        : "fairy";
      return {
        ...s,
        log: [...s.log, {
          id: nextLogId++,
          content: <><Icon name={iconName} /> {a.value.text}</>,
          tone: "flavor" as const,
        }].slice(-50),
      };
    }
    case "error":
      return { ...s, error: a.value };
    case "outcome":
      return { ...s, outcome: a.value };
    case "reset":
      return { connection: "connecting", state: null, log: [], rawEvents: [], error: null, outcome: null };
  }
}

function formatEvent(e: CombatEvent, state: CombatState | null): LogEntry[] {
  const nameOf = (id: string) => {
    if (isMonsterActor(id)) {
      const m = state?.monsters.find((mo) => mo.id === id) ?? state?.monsters[0];
      return m?.name ?? "monster";
    }
    return state?.fighters.find((f) => f.id === id)?.name ?? id;
  };
  const row = (
    icon: string | null,
    content: React.ReactNode,
    tone: LogEntry["tone"],
    side?: LogEntry["side"],
  ): LogEntry[] => [{
    id: nextLogId++,
    content: icon ? <><Icon name={icon} /> {content}</> : content,
    tone,
    side,
  }];
  switch (e.type) {
    case "begin":
      return row("crossed-swords", "Combat begins. Rolling initiative…", "info");
    case "turn_start": {
      const actor = nameOf(e.actor);
      const label = isMonsterActor(e.actor)
        ? `${actor}'s Turn · Round ${e.round}`
        : `${actor}'s Turn · Round ${e.round}`;
      return [{
        id: nextLogId++,
        content: label,
        tone: "info",
        side: "divider",
        divider_side: isMonsterActor(e.actor) ? "enemy" : "party",
      }];
    }
    case "roll":
      return row("perspective-dice-six", <>{nameOf(e.actor)} rolled {e.die} → <strong>{e.value}</strong> ({PURPOSE_LABEL[e.purpose] ?? e.purpose})</>, "muted");
    case "hit_check":
      return row(
        e.hit ? "crossed-swords" : "x-mark",
        e.hit
          ? <>HIT  {e.roll}{signed(e.modifier)} = {e.total} vs AC {e.ac}</>
          : <>MISS  {e.roll}{signed(e.modifier)} = {e.total} vs AC {e.ac}</>,
        e.hit ? "good" : "bad",
      );
    case "player_hit":
      return row("blast", <>{nameOf(e.actor)} → {nameOf(e.target)}: {e.damage}{e.crit ? " (CRIT)" : ""}  [{e.formula}]</>, "good");
    case "monster_attack": {
      const monName = (isMonsterActor(e.actor)
        ? state?.monsters.find((m) => m.id === e.actor)?.name
        : undefined) ?? state?.monsters[0]?.name ?? "Monster";
      return [{
        id: nextLogId++,
        side: "enemy" as const,
        tone: "bad" as const,
        content: (
          <MonsterHitEntry
            monsterName={monName}
            targetName={nameOf(e.target)}
            raw_damage={e.raw_damage}
            damage_after_armor={e.damage_after_armor}
            damage_after_position={e.damage_after_position}
            shield_absorbed={e.shield_absorbed}
            hp_damage={e.hp_damage}
            damage_type={e.damage_type}
            resistance_reduction={e.resistance_reduction}
          />
        ),
      }];
    }
    case "monster_splash":
      return row("fire", <span style={{ color: "#f97316" }}>💥 SPLASH — {e.targets.map(t => `${nameOf(t.target)} (${t.hp_damage} dmg)`).join(", ")}</span>, "bad");
    case "boss_phase_transition":
      return row("fire", "The boss enters phase 2!", "bad");
    case "fighter_down":
      return row("death-skull", <>{nameOf(e.target)} is down.</>, "bad");
    case "monster_down":
      return row("trophy", <>{nameOf(e.killed_by)} lands the killing blow.</>, "good");
    case "heal_applied":
      return row(
        "health-increase",
        <>{nameOf(e.actor)} → {nameOf(e.target)}: +{e.amount} HP{e.rolled > e.amount ? ` (rolled ${e.rolled}, clamped)` : ""}</>,
        "good",
      );
    case "shield_applied": {
      const selfCast = e.actor === e.target;
      const label = e.bonus_barrier ? "barrier" : "armor";
      return row(
        "shield",
        <>{nameOf(e.actor)} 🛡 {selfCast ? "reinforced" : `→ ${nameOf(e.target)}`}{e.restored > 0 ? `: +${e.restored} ${label}` : ": already full"} ({e.new_armor} total)</>,
        "good",
      );
    }
    case "flee_check":
      return row(
        "footprint",
        e.success
          ? <>{nameOf(e.actor)} escape check: {e.roll}{signed(e.modifier)} = {e.total} vs DC {e.dc}: SUCCESS</>
          : <>{nameOf(e.actor)} escape check: {e.roll}{signed(e.modifier)} = {e.total} vs DC {e.dc}: FAIL — exposed!</>,
        e.success ? "good" : "bad",
      );
    case "fled":
      return row("footprint", "The party escapes.", "info");
    case "wave_transition":
      return row("crossed-swords", <>Wave {e.new_wave}/{e.total_waves}: {e.to_monster} arrives ({e.to_max_hp} HP)</>, "info");
    case "position_changed":
      return row(
        e.to === "front" ? "perspective-dice-one" : "perspective-dice-two",
        <>{nameOf(e.actor)} moves to {e.to} row.</>,
        "info",
      );
    case "effect_tick": {
      const icon =
        e.effect === "regen" ? "aura"
        : e.effect === "poisoned" ? "poison-cloud"
        : e.effect === "burning" ? "fire"
        : e.effect === "bleeding" ? "bleeding-wound"
        : "bleeding-wound";
      const sign = e.hp_delta >= 0 ? `+${e.hp_delta}` : `${e.hp_delta}`;
      const src = e.source ? ` (${e.source})` : "";
      return row(icon, <>{nameOf(e.actor)} {e.effect}{src}: {sign} HP</>, e.hp_delta >= 0 ? "good" : "bad");
    }
    case "item_used": {
      const eff = e.effect;
      const head = <><Icon name="knapsack" /> {nameOf(e.actor)} used {e.item_name}</>;
      if (eff.kind === "heal") {
        return [{ id: nextLogId++, content: <>{head}: +{eff.amount} HP</>, tone: "good" }];
      } else if (eff.kind === "mana_restore") {
        return [{ id: nextLogId++, content: <>{head}: +{eff.added} mana (now {eff.new_mana})</>, tone: "good" }];
      } else if (eff.kind === "mana_bump") {
        return [{ id: nextLogId++, content: <>{head}: +{eff.added} max mana (now {eff.new_max_mana})</>, tone: "good" }];
      } else if (eff.kind === "revive") {
        return [{ id: nextLogId++, content: <>{head}: revives {nameOf(eff.target)} to {eff.hp_restored} HP</>, tone: "good" }];
      } else if (eff.kind === "monster_damage") {
        const note = eff.capped_from ? ` (capped from ${eff.capped_from})` : "";
        return [{ id: nextLogId++, content: <>{head}: {eff.amount} dmg to {state?.monsters[0]?.name ?? "monster"}{note}</>, tone: "good" }];
      } else if (eff.kind === "self_effect") {
        return [{
          id: nextLogId++,
          content: <>{head}: {nameOf(eff.target)} gains <Icon name="aura" color="#16a34a" /> regen +{eff.magnitude} × {eff.remaining}</>,
          tone: "good",
        }];
      } else if (eff.kind === "monster_effect") {
        return [{
          id: nextLogId++,
          content: <>{head}: {state?.monsters[0]?.name ?? "monster"} <Icon name="monster-skull" color="#a855f7" /> {eff.effect} {eff.magnitude} × {eff.remaining}</>,
          tone: "good",
        }];
      } else {
        const summary = eff.recipients
          .map((r) => `+${r.restored} to ${nameOf(r.user_id)}`)
          .join(", ");
        return [{ id: nextLogId++, content: <>{head}: mana refilled — {summary || "no one needed it"}</>, tone: "good" }];
      }
    }
    case "ability_used":
      return row("fairy-wand", <>{nameOf(e.actor)} uses {e.name}  −{e.mana_spent} mana</>, "good");
    case "ability_taunt":
      return row("shield", <>{nameOf(e.actor)} bellows — monster locked on for {e.swings} swings.</>, "good");
    case "ability_containerize":
      return row("cubes", <>Stasis container — monster is stunned (30%/turn escalating break chance).</>, "good");
    case "ability_regression_shield": {
      const grants = e.grants ?? [];
      const summary = grants.length === 0
        ? "everyone at cap"
        : grants.map((g) => `+${g.amount} ${nameOf(g.target)}`).join(", ");
      return row("fairy-wand", <>Regression Shield — {summary}.</>, "good");
    }
    case "ability_vanish":
      return row("player-dodge", <>{nameOf(e.actor)} vanishes — untargetable for {e.swings} swings.</>, "good");
    case "ability_soul_drain":
      return row("death-skull", <>Soul Drain: {e.damage} dmg, +{e.healed} HP  [{e.formula}]</>, "good");
    case "ability_battle_hymn":
      return row("aura", <>Battle Hymn — bardic aura surges for 3 rounds (until round {e.expires_after_round}).</>, "good");
    case "ability_encourage":
      return row("conversation", <>{nameOf(e.actor)} encourages {nameOf(e.target)} — advantage on next {e.charges} attack{e.charges === 1 ? "" : "s"}!</>, "good");
    case "ability_mock":
      return row("screaming", <>{nameOf(e.actor)} mocks the enemy — disadvantage on next {e.charges} swing{e.charges === 1 ? "" : "s"}!</>, "bad");
    case "advantage_used":
      return row("conversation", <>{nameOf(e.actor)} rolls with advantage (d20: {e.d20_a} & {e.d20_b}) → took {e.took}.</>, "good");
    case "disadvantage_used":
      return row("screaming", <>{nameOf(e.actor)} rolls with disadvantage (d20: {e.d20_a} & {e.d20_b}) → took {e.took}.</>, "bad");
    case "ability_foresee": {
      const target = e.predicted_target ? nameOf(e.predicted_target) : null;
      const verdictEl = e.verdict === "safe"
        ? <><Icon name="aura" color="#22c55e" /> safe</>
        : e.verdict === "lethal"
        ? <><Icon name="death-skull" color="#dc2626" /> lethal</>
        : <><Icon name="fire-symbol" color="#d97706" /> at risk</>;
      const remaining = e.turns_remaining ?? 0;
      const refreshNote = remaining > 0
        ? ` (${remaining} turn${remaining === 1 ? "" : "s"} left)`
        : " (fades)";
      const hasNet = e.net_lo != null && e.net_hi != null;
      const swingLine = target
        ? row("targeted", <> → {target} · raw {e.damage_lo}–{e.damage_hi}{hasNet ? <> net {e.net_lo}–{e.net_hi} HP</> : ""} · {verdictEl}</>, "info")
        : row("targeted", <> No committed target yet</>, "info");
      const probs = e.probabilities ?? [];
      const probLine = probs.length > 1
        ? row("crystal-ball", <>{probs.map((p) => `${nameOf(p.id)} ${p.position} ${p.pct}%`).join(" · ")}</>, "info")
        : [];
      const triage = e.triage ?? [];
      const triageLine = triage.length > 0
        ? row("health-increase", <>{triage.map((f) => {
            const pct = f.max_hp > 0 ? f.hp / f.max_hp : 1;
            const dot = pct >= 0.66
              ? <Icon name="aura" color="#22c55e" />
              : pct >= 0.33
              ? <span style={{ color: "#d97706" }}>◆</span>
              : <Icon name="death-skull" color="#dc2626" />;
            return <span key={f.id} style={{ marginRight: 8 }}>{dot} {nameOf(f.id)} {f.hp}/{f.max_hp}</span>;
          })}</>, "info")
        : [];
      const active = e.active;
      const effectNotes = active ? [
        (active.stunned ?? 0) > 0 && `Stunned`,
        active.taunt_actor && `Taunt→${nameOf(active.taunt_actor)} (${active.taunt_swings})`,
        (active.vanished ?? []).length > 0 && `Vanished: ${active.vanished.map(nameOf).join(", ")}`,
      ].filter(Boolean) : [];
      const effectLine = effectNotes.length > 0
        ? row("shield", <>{effectNotes.join(" · ")}</>, "info")
        : [];
      return [
        ...row("scroll-unfurled", <>Foresee{refreshNote}</>, "info"),
        ...swingLine,
        ...probLine,
        ...triageLine,
        ...effectLine,
      ];
    }
    case "ability_migrate":
      return row("grass", <>{nameOf(e.actor)} shifts {nameOf(e.target)} to the {e.to} row.</>, "info");
    case "monster_swing_skipped":
      return row("cubes", "The monster is stunned — its swing fizzles.", "good");
    case "monster_stun_broken":
      return row("cubes", <>The monster breaks free after {e.turns_active} stunned turn{e.turns_active === 1 ? "" : "s"}!</>, "info");
    case "monster_target_redirected":
      return row(
        e.reason === "taunt" ? "shield" : "player-dodge",
        e.reason === "taunt"
          ? <>Taunt redirects: {nameOf(e.from)} → {nameOf(e.to)}</>
          : <>Vanish slips {nameOf(e.from)} — monster picks {nameOf(e.to)} instead.</>,
        "good",
      );
    case "monster_target_blocked":
      return row(
        "player-dodge",
        <>Vanish blocks the attack — the monster can't find a target.</>,
        "good",
      );
    case "battle_hymn_expired":
      return row("aura", <>Battle Hymn fades for {nameOf(e.actor)}.</>, "muted");
    case "mark_applied":
      return row("targeted", <>{nameOf(e.actor)} marks the target — focus fire!</>, "good");
    case "passive_warden_shield":
      return row("shield", <>{nameOf(e.actor)} hardens up — +{e.amount} shield (passive).</>, "good");
    case "passive_warden_armor_up":
      return row("shield", <>{nameOf(e.actor)} Armor Up — +{e.amount} shield.</>, "good");
    case "passive_warden_thorns":
      return row("thorns", <>{nameOf(e.actor)} Backpressure — {e.amount} damage reflected.</>, "good");
    case "ability_brace":
      return row("aura", <>{nameOf(e.actor)} braces — 20% damage reduction for {e.turns} turns.</>, "good");
    case "passive_mage_mana_font":
      return row("wax-seal", <>Mana Font: {nameOf(e.actor)} regenerates +{e.amount} mana.</>, "good");
    case "passive_druid_regen":
      return row("grass", <>{nameOf(e.actor)} regen +{e.amount} HP (passive).</>, "good");
    case "passive_rogue_lethal_strike":
      return row("plain-dagger", <>{nameOf(e.actor)} Lethal Strikes — bleed {e.magnitude}/turn × {e.duration}.</>, "good");
    case "ability_envenom_proc":
      return row("poison", <>{nameOf(e.actor)} Malicious Payload procs — poison {e.stacks}/turn × 2.</>, "good");
    case "passive_bard_aura":
      return row("aura", <>Morale Boost: +{e.bonus} dmg from {nameOf(e.source)}'s song.</>, "good");
    case "passive_warlock_bleed":
      return [{
        id: nextLogId++,
        content: <><Icon name="death-skull" /> Cursed Strike: <Icon name="bleeding-wound" color="#dc2626" /> bleed {e.magnitude}/turn × {e.duration} on monster.</>,
        tone: "good",
      }];
    case "passive_holy_rage":
      return row("axe-swing", <>{nameOf(e.paladin)} Regression Rage +{e.bonus} damage!</>, "good");
    case "ability_shield_of_faith":
      return row("round-shield", <>Test Coverage — all allies gain +5 AC until round {e.expires_after_round}.</>, "good");
    case "ability_protect":
      return row("crowned-heart", <>{nameOf(e.actor)} shields {nameOf(e.target)} — will absorb half their incoming damage.</>, "good");
    case "ability_smite_debuff":
      return row("axe-swing", <>Breakpoint — {nameOf(e.target)} weakened, deals 50% damage next swing.</>, "good");
    case "protect_triggered":
      return row("crowned-heart", <>Protect: {nameOf(e.target)} takes {e.target_damage}, {nameOf(e.paladin)} absorbs {e.paladin_damage}.</>, "muted");
    case "passive_primal_strikes_heal":
      return row("grass", <>Primal Strikes: {nameOf(e.actor)} heals +{e.amount} HP.</>, "good");
    case "ability_regeneration":
      return row("regeneration", <>{nameOf(e.actor)} → {nameOf(e.target)}: Regeneration +{e.magnitude} HP/turn for {e.duration} rounds.</>, "good");
    case "ability_animal_form":
      return row("wolf-head", <>{nameOf(e.actor)} scales up — STR+{e.str_bonus} VIT+{e.vit_bonus} AGI+{e.agi_bonus} DEX+{e.dex_bonus} for {e.turns} turns.</>, "good");
    case "ability_barkskin":
      return row("oak-leaf", <>{nameOf(e.actor)} → {nameOf(e.target)}: Firewall +{e.bonus} AC for {e.turns} rounds.</>, "good");
    case "ability_wildgrowth_entangle":
      return row("grass", <>Deadlock: target entangled — −4 to-hit for {e.duration} rounds.</>, "good");
    case "passive_rogue_first_crit":
      return row("plain-dagger", <>{nameOf(e.actor)}'s first strike — guaranteed crit!</>, "good");
    case "passive_sinister_queries":
      return row("bleeding-wound", <>Sinister Queries: {nameOf(e.actor)} applies {e.magnitude} <Icon name="bleeding-wound" color="#dc2626" /> bleed.</>, "good");
    case "ability_hex":
      return row("death-skull", <>{nameOf(e.actor)} corrupts the index — -25% dmg, bleeds on hit ({e.duration}t).</>, "good");
    case "hex_bleed_proc":
      return row("bleeding-wound", <>Corrupt Index: <Icon name="bleeding-wound" color="#dc2626" /> +{e.stacks} bleed stacks from damage taken.</>, "muted");
    case "ability_forbidden_sql":
      return row("death-skull", <>Forbidden SQL: consumed {e.stacks_consumed} bleed stacks → {e.damage} damage.</>, "good");
    case "passive_paladin_auto_heal":
      return row("fairy-wand", <>Hotfix: {nameOf(e.paladin)} → {nameOf(e.target)} +{e.amount} HP.</>, "good");
    case "drink_buff_consumed":
      if (e.kind === "buff_next_crit") {
        return row("lucky-fish", <>Lucky Sip — guaranteed crit, +{e.bonus} damage.{e.remaining === 0 ? " Buff wears off." : ""}</>, "good");
      }
      return row(
        "spell-book",
        <>{nameOf(e.actor)} drink buff: +{e.bonus} {e.kind === "buff_attack" ? "attack" : "magic"}{e.remaining === 0 ? " — wears off" : ` (${e.remaining} left)`}.</>,
        "good",
      );
    case "turn_skip":
      return [{ id: nextLogId++, content: <><Icon name="ice-bolt" size={11} color="#93c5fd" /> {nameOf(e.actor)} is frozen — turn skipped!</>, tone: "bad" }];
    case "elemental_proc": {
      const elemIcon = e.element === "fire" ? "fire" : e.element === "ice" ? "ice-bolt" : "electric";
      const elemColor = e.element === "fire" ? "#fb923c" : e.element === "ice" ? "#93c5fd" : "#fbbf24";
      if (e.resisted) {
        return [{ id: nextLogId++, content: <><Icon name={elemIcon} size={11} color={elemColor} /> {nameOf(e.target)} resists {e.element}!</>, tone: "muted" }];
      }
      const effectLabel = e.effect === "burning" ? "burning" : e.effect === "frozen" ? "frozen" : "shocked";
      return [{ id: nextLogId++, content: <><Icon name={elemIcon} size={11} color={elemColor} /> {nameOf(e.actor)} procs {effectLabel} on {nameOf(e.target)}! ×{e.magnitude} for {e.duration}t</>, tone: "bad" }];
    }
    case "monster_elemental_proc": {
      const elemIcon = e.element === "fire" ? "fire" : e.element === "ice" ? "ice-bolt" : "electric";
      const elemColor = e.element === "fire" ? "#fb923c" : e.element === "ice" ? "#93c5fd" : "#fbbf24";
      const effectLabel = e.effect === "burning" ? "burning" : e.effect === "frozen" ? "frozen" : "shocked";
      return [{
        id: nextLogId++,
        content: <><Icon name={elemIcon} size={11} color={elemColor} /> {nameOf(e.target)} is now <strong style={{ color: elemColor }}>{effectLabel}</strong>! ×{e.magnitude} for {e.duration}t</>,
        tone: "bad",
      }];
    }
    case "victory":
      return [{ id: nextLogId++, content: <strong>VICTORY</strong>, tone: "good" }];
    case "defeat":
      return [{ id: nextLogId++, content: <strong>DEFEAT</strong>, tone: "bad" }];
    case "rejected":
      return [{ id: nextLogId++, content: <>⚠ rejected: {e.reason}</>, tone: "bad" }];
    case "ability_good_fortune_delayed":
      return [{ id: nextLogId++, content: <>🍀 Good Fortune resolves — {state ? nameOf(e.target) : e.target} heals {e.amount} HP</>, tone: "good" }];
    case "ability_ill_omen_applied":
      return [{ id: nextLogId++, content: <>🔮 {state ? nameOf(e.actor) : e.actor} casts Ill Omen on the monster</>, tone: "flavor" }];
    case "ability_ill_omen_burst":
      return [{ id: nextLogId++, content: <>💥 Ill Omen bursts for {e.burst} damage ({e.accumulated} accumulated)</>, tone: "bad" }];
    case "effect_applied":
      return [{ id: nextLogId++, content: <>{state ? nameOf(e.target) : e.target} is {e.effect} ({e.duration}t)</>, tone: "bad" }];
    case "loot_pickup": {
      const actorName = state ? nameOf(e.actor) : e.actor;
      const label = e.kind === "gold"
        ? <>💰 {actorName} grabs <strong>+{e.gold ?? 0}g</strong> from the battlefield</>
        : <>📦 {actorName} pockets a mystery chest</>;
      return [{ id: nextLogId++, content: label, tone: "good" }];
    }
    case "ability_freeze_applied":
      return [{ id: nextLogId++, content: <>❄️ {state ? nameOf(e.target) : e.target} is frozen</>, tone: "good" }];
    case "ability_burn_applied":
      return [{ id: nextLogId++, content: <>🔥 {state ? nameOf(e.target) : e.target} catches fire ({e.duration}t)</>, tone: "good" }];
    case "ability_shock_applied":
      return [{ id: nextLogId++, content: <>⚡ {state ? nameOf(e.target) : e.target} is shocked ({e.duration}t)</>, tone: "good" }];
    default: {
      const _exhaustive: never = e;
      void _exhaustive;
      return [];
    }
  }
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

export function CombatPage({
  questId,
  selfId,
  onExit,
  onOpenInventory,
}: {
  questId: number;
  selfId: string;
  onExit: () => void;
  onOpenInventory?: () => void;
}) {
  const [ui, dispatch] = useReducer(reducer, {
    connection: "connecting",
    state: null,
    log: [],
    rawEvents: [],
    error: null,
    outcome: null,
  });
  const [itemPicker, setItemPicker] = useState<"closed" | "open" | { reviveItemId: number }>("closed");
  const [migratePicker, setMigratePicker] = useState<boolean>(false);
  const [allyPickerAbility, setAllyPickerAbility] = useState<ActiveAbilityDef | null>(null);
  const [anyPickerAbility, setAnyPickerAbility] = useState<ActiveAbilityDef | null>(null);
  const [protectConfirm, setProtectConfirm] = useState<{ pendingTargetId: string } | null>(null);
  const [givePicker, setGivePicker] = useState<"closed" | "selectItem" | { itemId: number }>("closed");
  const [items, setItems] = useState<Item[]>([]);
  const [autoResolve, setAutoResolve] = useState<boolean>(
    () => localStorage.getItem("combat_auto_resolve") === "true",
  );
  const autoResolveRef = useRef(autoResolve);
  // Tracks the last turn_index for which we fired an auto-resolve so we don't double-fire.
  const autoResolvedTurnRef = useRef<number>(-1);
  const [reconnectKey, setReconnectKey] = useState(0);
  // Auto-reconnect attempt counter; reset on a successful onopen or manual reconnect.
  const reconnectAttemptsRef = useRef(0);
  const [devOpen, setDevOpen] = useState(false);
  const isMobile = useIsMobile();
  const wsRef = useRef<WebSocket | null>(null);
  const logScrollRef = useRef<HTMLDivElement | null>(null);
  const [diceRolls, setDiceRolls] = useState<DiceRollEntry[]>([]);
  const diceRollCounterRef = useRef(0);
  // Per-card animation triggers: keyed by monster id, value is seq number.
  // Bumping seq re-mounts the animation element so the keyframe re-fires.
  const [lastSlash, setLastSlash] = useState<{ id: string; seq: number } | null>(null);
  const [lastLunge, setLastLunge] = useState<{ id: string; seq: number } | null>(null);
  const [lastForesee, setLastForesee] = useState<{ predicted_target: string | null; predicted_targets: Record<string, string> } | null>(null);
  const animSeqRef = useRef(0);
  // Fighter hit-flash: tracks which fighter ids are currently flashing red.
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  // Per-fighter monotonic hit counter. Each hit bumps the entry for the
  // target id; the chip's HitDust component re-keys its WAAPI animation
  // on every change so consecutive hits each spawn a fresh puff cloud.
  const [hitDustSeq, setHitDustSeq] = useState<Record<string, number>>({});
  const [healBurstSeq, setHealBurstSeq] = useState<Record<string, number>>({});
  const [shieldBurstSeq, setShieldBurstSeq] = useState<Record<string, number>>({});
  // Delay victory modal until after dice settle so player sees the killing blow.
  const [victoryModalReady, setVictoryModalReady] = useState(false);
  const [defeatModalReady, setDefeatModalReady] = useState(false);

  // Hex grid: imperative handle for emitting particles/projectiles/shake from
  // the WS event handler.
  const hexApiRef = useRef<CombatHexGridHandle | null>(null);
  // Live ref to the latest combat state. The WS-setup useEffect captures `ui`
  // in closure (deps = [questId, reconnectKey]), so reading `ui.state` inside
  // the ws.onmessage handler would always see the value at mount time —
  // stale for every event after the first. Canvas particle/projectile
  // dispatch reads from this ref instead so it always finds up-to-date
  // pawn positions.
  const stateRef = useRef<CombatState | null>(null);
  // Battlefield viewport — measured live so the hex canvas can fill the
  // area left of the combat log and respond to window resizes. The
  // ResizeObserver watches `battlefieldFrameRef` (the absolutely-positioned
  // wrapper of the canvas) and emits {w, h} for the canvas to consume.
  const battlefieldFrameRef = useRef<HTMLDivElement | null>(null);
  const [battlefieldSize, setBattlefieldSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useEffect(() => {
    const el = battlefieldFrameRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setBattlefieldSize({ w: Math.round(r.width), h: Math.round(r.height) });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [battlefieldFrameRef.current]);
  // Timestamp (ms epoch) by which the latest in-flight projectile/swing will
  // land. State dispatches (which can zero out a monster's HP) are deferred
  // until then so the kill visually lands AFTER the shot connects, not before.
  // A small buffer is added so the impact particle has a frame to draw before
  // the pawn fades.
  const animationLandAtRef = useRef<number>(0);
  const noteAnimationLands = (durationMs: number) => {
    const landsAt = Date.now() + durationMs + 60; // 60ms post-impact buffer
    if (landsAt > animationLandAtRef.current) animationLandAtRef.current = landsAt;
  };
  // Travel durations mirror CombatHexGrid's PROJECTILE_DURATION map. Kept local
  // (not imported) because the canvas constant is internal. Off-by-a-frame is
  // harmless — these are upper bounds.
  const PROJECTILE_TRAVEL_MS: Record<ProjectileKind, number> = {
    arrow: 350, fire: 300, ice: 320, lightning: 80, poison: 400, magic: 300,
  };
  // Swing onArrive fires at t≥0.45 of SWING_DURATION_MS=260 → ~120ms.
  const SWING_IMPACT_MS = 120;

  // Battlefield-first layout: pawn screen positions reported by the hex grid,
  // hovered pawn id (for expanding the callout), and canvas dimensions used
  // to clamp callout horizontal placement.
  const [pawnPositions, setPawnPositions] = useState<Record<string, { x: number; y: number; radius: number }>>({});
  const [hoveredPawnId, setHoveredPawnId] = useState<string | null>(null);
  // Mobile: tapping a pawn pins its callout open until another tap (or
  // tapping the same pawn again). Desktop uses pure hover so this stays null.
  const [pinnedPawnId, setPinnedPawnId] = useState<string | null>(null);
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  // AI-generated battlefield ground texture URL (fetched once per scene).
  // null while loading or on cache miss; the canvas falls back to its flat tint.
  const [battlefieldArtUrl, setBattlefieldArtUrl] = useState<string | null>(null);

  // Full character sheet modal — opened by clicking the docked pawn card.
  const [sheetSubject, setSheetSubject] = useState<CharacterSheetSubject | null>(null);

  // The "preview kind" the player is currently hovering on an action button —
  // used to paint glow rings on every pawn that action would affect.
  // null when not hovering anything.
  type PreviewKind =
    // For all_enemies / all_allies, an optional radiusTiles caps the glow
    // to pawns within that hex distance of the caster — matches the
    // engine's caster-centered AoE gate so the preview is honest.
    | { scope: "all_enemies"; radiusTiles?: number }
    | { scope: "all_allies"; radiusTiles?: number }
    | { scope: "single_enemy" } // uses targetMonsterId (the currently selected target)
    | { scope: "single_ally"; actorId: string }
    | { scope: "self"; actorId: string };
  const [previewedKind, setPreviewedKind] = useState<PreviewKind | null>(null);

  // Aim mode: after clicking Attack or a single-target ability, the player
  // commits the target by clicking a pawn on the grid. self / all-enemy /
  // all-ally abilities skip aim mode entirely (no choice to make).
  type AimingAction =
    | { kind: "attack" }
    | { kind: "ability"; ability: ActiveAbilityDef };
  const [aimingAction, setAimingAction] = useState<AimingAction | null>(null);

  // Escape always cancels aim. Convenient for power users.
  useEffect(() => {
    if (!aimingAction) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setAimingAction(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [aimingAction]);

  // Inventory loaded once on mount; refreshed after each item_used event so
  // the picker reflects post-use state. Authoritative source is D1 via
  // /api/inventory.
  async function loadItems() {
    const res = await fetch("/api/inventory", { credentials: "include" });
    if (res.ok) setItems(((await res.json()) as { items: Item[] }).items);
  }
  useEffect(() => {
    void loadItems();
  }, []);

  // Fetch the AI-generated battlefield ground art once per scene. The server
  // returns a cached URL or null (and kicks off generation in the background
  // on miss). Refetches when the scene changes mid-quest (rare — only when
  // resuming an existing quest).
  const sceneKey = ui.state?.scene;
  useEffect(() => {
    if (!sceneKey || !ui.state?.hex_range_enabled) {
      setBattlefieldArtUrl(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/battlefield-art?scene=${encodeURIComponent(sceneKey)}`, { credentials: "include" })
      .then((r) => r.ok ? r.json() as Promise<{ url: string | null }> : { url: null })
      .then((j) => { if (!cancelled) setBattlefieldArtUrl(j.url); })
      .catch(() => { if (!cancelled) setBattlefieldArtUrl(null); });
    return () => { cancelled = true; };
  }, [sceneKey, ui.state?.hex_range_enabled]);


  useEffect(() => {
    // Prefixed console logs make WS lifecycle filterable in devtools
    // (filter: "[ws]"). Useful for diagnosing disconnect/reconnect patterns
    // in production — every open/close/reconnect leaves a breadcrumb with
    // timestamp, attempt count, and close-code metadata.
    const log = (msg: string, extra?: Record<string, unknown>) =>
      console.log(`[ws q=${questId}] ${msg}`, extra ?? "");

    const wasReconnect = reconnectAttemptsRef.current > 0;
    dispatch({ kind: "connection", value: wasReconnect ? "reconnecting" : "connecting" });
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/ws/quest/${questId}`;
    const openedAt = Date.now();
    log(wasReconnect ? "reconnect attempt" : "connecting", {
      attempt: reconnectAttemptsRef.current,
      url,
    });
    const ws = new WebSocket(url);
    wsRef.current = ws;

    // Heartbeat every 45s to keep the Cloudflare WS alive (60s idle limit).
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 45_000);

    // Auto-reconnect bookkeeping. `intentionalClose` lets the cleanup
    // suppress the reconnect that ws.close() would otherwise trigger when
    // the effect is tearing down (unmount, questId change, manual bump).
    let intentionalClose = false;
    let reconnectTimer: number | null = null;
    const MAX_AUTO_RECONNECTS = 4;

    ws.onopen = () => {
      const handshakeMs = Date.now() - openedAt;
      log("open", { handshakeMs, reconnectAttempts: reconnectAttemptsRef.current });
      reconnectAttemptsRef.current = 0;
      dispatch({ kind: "connection", value: "open" });
    };
    ws.onclose = (ev) => {
      const aliveMs = Date.now() - openedAt;
      // Standard close codes that hint at cause:
      //   1000 normal · 1001 going-away · 1006 abnormal (no close frame —
      //   typical of network drops / Cloudflare idle eviction) · 1011 server
      //   error · 1012 service restart · 1013 try-again · 1014 bad gateway.
      const meta = {
        code: ev.code,
        reason: ev.reason || "(none)",
        wasClean: ev.wasClean,
        aliveMs,
        intentional: intentionalClose,
      };
      if (intentionalClose) {
        log("close (intentional)", meta);
        return;
      }
      const attempts = reconnectAttemptsRef.current;
      if (attempts >= MAX_AUTO_RECONNECTS) {
        log("close — giving up after max auto-reconnects", { ...meta, attempts });
        dispatch({ kind: "connection", value: "closed" });
        return;
      }
      reconnectAttemptsRef.current = attempts + 1;
      // 500ms, 1s, 2s, 4s (capped at 8s).
      const delay = Math.min(8000, 500 * Math.pow(2, attempts));
      log("close — scheduling reconnect", { ...meta, nextAttempt: attempts + 1, delayMs: delay });
      dispatch({ kind: "connection", value: "reconnecting" });
      reconnectTimer = window.setTimeout(() => {
        setReconnectKey((k) => k + 1);
      }, delay);
    };
    ws.onerror = (ev) => {
      // The browser doesn't expose details on `error` for security reasons —
      // onclose is where the actual code/reason lands. Log the bare event for
      // ordering context.
      log("error (no detail; see following close)", { type: (ev as Event).type });
      dispatch({ kind: "error", value: "WebSocket error" });
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as
          | { type: "state"; state: CombatState & { monster?: Monster } }
          | { type: "events"; events: CombatEvent[] }
          | { type: "error"; message: string }
          | { type: "outcome"; outcome: OutcomeSummary }
          | { type: "flavor"; flavor: { kind: "hit" | "victory" | "death" | "flee"; actor: string; text: string } }
          | { type: "log_replay"; events: unknown[] };
        if (msg.type === "state") {
          // Normalise legacy DOs that still send `monster` (singular) instead of `monsters[]`.
          const s = msg.state;
          const normalised: CombatState = "monsters" in s && Array.isArray(s.monsters)
            ? s
            : { ...s, monsters: [(s as unknown as { monster: Monster }).monster] };
          // Defer state dispatch until any in-flight projectile/swing has
          // landed. The worker broadcasts `events` immediately followed by
          // `state`; without this guard, a killing-blow's state arrives ~ms
          // after the projectile spawns and the monster pawn fades to its
          // downed alpha while the shot is still mid-flight, making the
          // visual order read as "enemy clears, then arrow arrives." Now
          // the state update waits for impact + a small post-impact buffer.
          const lag = animationLandAtRef.current - Date.now();
          if (lag > 0) {
            setTimeout(() => dispatch({ kind: "state", value: normalised }), lag);
          } else {
            dispatch({ kind: "state", value: normalised });
          }
        }
        else if (msg.type === "events") {
          // Show dice first. Delay the state update (HP bars, log, turn
          // advance) until after the roll animation settles so the player
          // sees the dice result before the world reacts to it.
          let hasRolls = false;
          for (const evt of msg.events) {
            if (evt.type === "roll") {
              hasRolls = true;
              const id = ++diceRollCounterRef.current;
              const entry: DiceRollEntry = {
                id,
                die: String(evt.die),
                value: Number(evt.value),
                actor: String(evt.actor),
                purpose: String(evt.purpose ?? ""),
              };
              if (!isMonsterActor(String(evt.actor))) {
                // New player roll: clear lingering enemy dice so the player's
                // attack gets a fresh stage (unless their own dice are already up).
                setDiceRolls((prev) => {
                  const hasPlayerRoll = prev.some((r) => !isMonsterActor(r.actor));
                  return hasPlayerRoll ? [...prev, entry] : [entry];
                });
              } else {
                setDiceRolls((prev) => [...prev.slice(-5), entry]);
              }
              setTimeout(() => setDiceRolls((prev) => prev.filter((r) => r.id !== id)), 5000);
            }
            // Fire passive toasts immediately so they appear while dice are visible.
            if (evt.type === "passive_rogue_lethal_strike") {
              toast(`🗡 Lethal Strikes — bleed ${(evt as { magnitude: number }).magnitude}/turn`, { icon: "🩸", duration: 4000 });
            } else if (evt.type === "passive_warden_shield") {
              toast(`🛡 Hardened Up — +${(evt as { amount: number }).amount} shield`, { duration: 3000 });
            } else if (evt.type === "passive_warden_armor_up") {
              toast(`🛡 Armor Up — +${(evt as { amount: number }).amount} shield`, { duration: 2500 });
            } else if (evt.type === "passive_warden_thorns") {
              toast(`🌵 Backpressure — ${(evt as { amount: number }).amount} reflected`, { duration: 2500 });
            } else if (evt.type === "ability_brace") {
              toast(`🔰 Brace — 20% damage reduction active`, { duration: 3000 });
            } else if (evt.type === "passive_mage_mana_font") {
              toast(`🧙 Mana Font — +${(evt as { amount: number }).amount} mana`, { duration: 3000 });
            } else if (evt.type === "passive_holy_rage") {
              toast(`⚔️ Regression Rage — +${(evt as { bonus: number }).bonus} bonus damage`, { duration: 3000 });
            }
          }
          // Refresh inventory after any item use so the picker reflects the
          // new state. Also surface a toast when I'm the one who used the
          // item — gives immediate confirmation that the activation landed
          // (without it, scroll items like Production Outage / Rebase Scroll
          // looked like they did nothing).
          for (const evt of msg.events) {
            if (evt.type !== "item_used") continue;
            void loadItems();
            const ev = evt as ItemUsedEvent;
            if (ev.actor !== selfId) continue;
            const eff = ev.effect;
            let summary = "";
            if (eff.kind === "heal") summary = `+${eff.amount} HP`;
            else if (eff.kind === "mana_restore") summary = `+${eff.added} mana`;
            else if (eff.kind === "mana_bump") summary = `+${eff.added} max mana`;
            else if (eff.kind === "revive") summary = `revived`;
            else if (eff.kind === "monster_damage") summary = `${eff.amount} dmg${eff.capped_from ? ` (capped from ${eff.capped_from})` : ""}`;
            else if (eff.kind === "self_effect") summary = `+regen ${eff.magnitude}×${eff.remaining}t`;
            else if (eff.kind === "monster_effect") summary = `${eff.effect} ${eff.magnitude}×${eff.remaining}t`;
            else if (eff.kind === "party_mana_refill") summary = `party mana refilled`;
            toast(`✨ ${ev.item_name}: ${summary}`, { duration: 4000 });
          }
          // Fire per-card animations immediately (before the state-update delay).
          for (const evt of msg.events) {
            if (evt.type === "ability_foresee") {
              setLastForesee({ predicted_target: evt.predicted_target, predicted_targets: evt.predicted_targets ?? {} });
            }
            if (evt.type === "player_hit" && (evt as { target?: string }).target) {
              const tgt = (evt as { target: string }).target;
              setLastSlash({ id: tgt, seq: ++animSeqRef.current });
              // Player hits a monster → puff on the monster card too.
              // Same hitDustSeq map is keyed by monster id (which never
              // collides with fighter slack_user_ids).
              setHitDustSeq((prev) => ({ ...prev, [tgt]: (prev[tgt] ?? 0) + 1 }));
            }
            if (evt.type === "monster_attack" && isMonsterActor(evt.actor)) {
              setLastLunge({ id: evt.actor, seq: ++animSeqRef.current });
            }
            // Flash the targeted fighter card red when a monster hits them,
            // and bump the dust counter so HitDust spawns a fresh puff.
            // (Only the hit-flash gates on damage > 0; dust + flash both
            // fire for any landed swing, since a 0-damage hit still looks
            // like a near-miss-glancing-blow narratively.)
            if (evt.type === "monster_attack" && typeof (evt as { target?: string }).target === "string") {
              const tgt = (evt as { target: string }).target;
              setFlashIds((prev) => { const n = new Set(prev); n.add(tgt); return n; });
              setTimeout(() => setFlashIds((prev) => { const n = new Set(prev); n.delete(tgt); return n; }), 600);
              setHitDustSeq((prev) => ({ ...prev, [tgt]: (prev[tgt] ?? 0) + 1 }));
            }
            // Particle bursts. DOM `triggerBurst` is the legacy path; in hex
            // mode the canvas particle emitter below carries the same events
            // positioned to the pawn instead of the screen center.
            const _hexActiveTop = stateRef.current?.hex_range_enabled === true;
            if (evt.type === "elemental_proc" && !evt.resisted && !_hexActiveTop) {
              triggerBurst(evt.element === "fire" ? "fire" : evt.element === "ice" ? "ice" : "lightning");
            }
            // Monster procs a status on a fighter — burst on element type +
            // a toast if it landed on the local player (otherwise the
            // status pill in their roster row may go unnoticed).
            if (evt.type === "monster_elemental_proc") {
              if (!_hexActiveTop) triggerBurst(evt.element === "fire" ? "fire" : evt.element === "ice" ? "ice" : "lightning");
              if (evt.target === selfId) {
                const elemIcon = evt.element === "fire" ? "🔥" : evt.element === "ice" ? "❄️" : "⚡";
                toast(`${elemIcon} You're now ${evt.effect}! (${evt.duration}t)`, { duration: 3500 });
              }
            }
            if (evt.type === "heal_applied" && typeof (evt as { target?: string }).target === "string") {
              const tgt = (evt as { target: string }).target;
              setHealBurstSeq((prev) => ({ ...prev, [tgt]: (prev[tgt] ?? 0) + 1 }));
            }
            if (evt.type === "shield_applied" && typeof (evt as { target?: string }).target === "string") {
              const tgt = (evt as { target: string }).target;
              setShieldBurstSeq((prev) => ({ ...prev, [tgt]: (prev[tgt] ?? 0) + 1 }));
            }
            // Legacy DOM particle bursts. Only fire when the hex grid is NOT
            // active — in hex mode the canvas particles below cover the same
            // events with pawn-positioned effects.
            const hexActive = stateRef.current?.hex_range_enabled === true;
            if (!hexActive) {
              if (evt.type === "turn_skip") triggerBurst("frozen");
              if (evt.type === "victory") triggerBurst("victory");
              if (evt.type === "player_hit") triggerBurst("hit");
              if (evt.type === "ability_envenom_proc") triggerBurst("poison");
              if (evt.type === "passive_rogue_lethal_strike" || evt.type === "passive_sinister_queries" || evt.type === "hex_bleed_proc") triggerBurst("bleed");
              if (evt.type === "ability_shield_of_faith" || evt.type === "ability_barkskin" || evt.type === "ability_brace") triggerBurst("shield");
              if (evt.type === "passive_paladin_auto_heal" || evt.type === "ability_good_fortune_delayed") triggerBurst("heal");
              if (evt.type === "ability_ill_omen_applied" || evt.type === "ability_hex") triggerBurst("curse");
              if (evt.type === "ability_animal_form") triggerBurst("deploy");
            }

            // AoE ability bursts — fire a centered DOM burst when any AoE
            // ability is cast, regardless of hex mode. The canvas particle
            // system handles per-target impact effects elsewhere; this gives
            // the cast itself a satisfying punctuation. Driven by
            // `ability_used.ability_id` so we don't need any new event types.
            if (evt.type === "ability_used") {
              const kind = AOE_ABILITY_BURST[evt.ability_id];
              if (kind) triggerBurst(kind);
            }

            // ── Canvas hex grid: particle bursts + projectiles ─────────────
            // Fire positioned particles on the hex grid wherever the event
            // happens. emitParticle is a no-op if the hex grid isn't mounted.
            // Read from stateRef (not ui.state) because the ws.onmessage
            // useEffect closure captures `ui` at mount time — stale for
            // every event after the first state arrival.
            const hex = hexApiRef.current;
            const liveSnapshot = stateRef.current;
            if (hex && liveSnapshot) {
              const findFighter = (id: string) => liveSnapshot.fighters.find((f) => f.id === id);
              const findMonster = (id: string) => liveSnapshot.monsters.find((m) => m.id === id);
              if (evt.type === "player_hit") {
                const attacker = findFighter(evt.actor);
                const target = findMonster(evt.target);
                if (attacker?.pos && target?.pos) {
                  const projKind = projectileKindForAttack(attacker.weapon_range ?? "melee", attacker.element);
                  const partKind: ParticleKind = particleKindForEvent(evt.damage_type, false, false, evt.crit);
                  if (projKind) {
                    noteAnimationLands(PROJECTILE_TRAVEL_MS[projKind] ?? 350);
                    hex.emitProjectile(
                      { id: `p${evt.actor}${Date.now()}`, kind: projKind, from: attacker.pos, to: target.pos, fromActorId: attacker.id, toActorId: target.id },
                      () => {
                        hex.emitParticle({ id: `pt${Date.now()}`, kind: partKind, at: target.pos!, actorId: target.id });
                        if (evt.crit) hex.shake();
                      },
                    );
                  } else {
                    // Melee — arc swing originating at the attacker, sweeping
                    // toward the target. Impact particles fire on contact.
                    if (target.id) {
                      const tid = target.id;
                      noteAnimationLands(SWING_IMPACT_MS);
                      hex.emitSwing(
                        { id: `s${evt.actor}${Date.now()}`, fromActorId: attacker.id, toActorId: tid, element: attacker.element },
                        () => {
                          hex.emitParticle({ id: `pt${Date.now()}`, kind: partKind, at: target.pos!, actorId: tid });
                          if (evt.crit) hex.shake();
                        },
                      );
                    }
                  }
                }
              }
              if (evt.type === "monster_attack") {
                const attacker = findMonster(evt.actor);
                const target = findFighter(evt.target);
                if (attacker?.pos && target?.pos) {
                  const partKind = particleKindForEvent(evt.damage_type);
                  const isRanged = (attacker.weapon_range ?? "melee") !== "melee";
                  if (isRanged) {
                    const projKind: ProjectileKind =
                      evt.damage_type === "fire" ? "fire" :
                      evt.damage_type === "ice" ? "ice" :
                      evt.damage_type === "lightning" ? "lightning" :
                      evt.damage_type === "magic" ? "magic" : "arrow";
                    noteAnimationLands(PROJECTILE_TRAVEL_MS[projKind] ?? 350);
                    hex.emitProjectile(
                      { id: `mp${Date.now()}`, kind: projKind, from: attacker.pos, to: target.pos, fromActorId: attacker.id, toActorId: target.id },
                      () => hex.emitParticle({ id: `mt${Date.now()}`, kind: partKind, at: target.pos!, actorId: target.id }),
                    );
                  } else {
                    // Monster melee — swing toward target too
                    const monsterEl: "fire" | "ice" | "lightning" | "poison" | null =
                      evt.damage_type === "fire" ? "fire" :
                      evt.damage_type === "ice" ? "ice" :
                      evt.damage_type === "lightning" ? "lightning" : null;
                    if (attacker.id) {
                      const aid = attacker.id;
                      noteAnimationLands(SWING_IMPACT_MS);
                      hex.emitSwing(
                        { id: `ms${Date.now()}`, fromActorId: aid, toActorId: target.id, element: monsterEl },
                        () => hex.emitParticle({ id: `mt${Date.now()}`, kind: partKind, at: target.pos!, actorId: target.id }),
                      );
                    }
                  }
                }
              }
              if (evt.type === "heal_applied") {
                const target = findFighter(evt.target);
                if (target?.pos) hex.emitParticle({ id: `h${Date.now()}`, kind: "heal", at: target.pos, actorId: target.id });
              }
              if (evt.type === "loot_pickup") {
                // Burst at the pickup hex (not the fighter's actor id, because
                // the pawn is mid-tween to the tile when this event fires).
                hex.emitParticle({ id: `lt${Date.now()}`, kind: "loot", at: evt.pos });
              }
              if (evt.type === "shield_applied") {
                const target = findFighter(evt.target);
                if (target?.pos) hex.emitParticle({ id: `s${Date.now()}`, kind: "shield", at: target.pos, actorId: target.id });
              }
              // Status proc particles — fire on the targeted actor (pawn-glued).
              if (evt.type === "elemental_proc" && !evt.resisted) {
                const target = findMonster(evt.target);
                if (target?.pos) {
                  const k: ParticleKind = evt.element === "fire" ? "fire" : evt.element === "ice" ? "ice" : "lightning";
                  hex.emitParticle({ id: `ep${Date.now()}`, kind: k, at: target.pos, actorId: target.id });
                }
              }
              if (evt.type === "monster_elemental_proc") {
                const target = findFighter(evt.target);
                if (target?.pos) {
                  const k: ParticleKind = evt.element === "fire" ? "fire" : evt.element === "ice" ? "ice" : "lightning";
                  hex.emitParticle({ id: `mep${Date.now()}`, kind: k, at: target.pos, actorId: target.id });
                }
              }
              if (evt.type === "ability_envenom_proc") {
                const e = evt as { target?: string };
                const tgt = e.target ? findMonster(e.target) : null;
                if (tgt?.pos) hex.emitParticle({ id: `poi${Date.now()}`, kind: "poison", at: tgt.pos, actorId: tgt.id });
              }
              // Ability-applied elemental status procs (Mage Fireball burn,
              // Mage Zero-Day shock, Sage Ray of Frost freeze). The damage
              // hit already fires its own element burst; this second burst
              // on the proc emphasizes the status actually landing.
              if (evt.type === "ability_freeze_applied") {
                const e = evt as { target?: string };
                const tgt = e.target ? findMonster(e.target) : null;
                if (tgt?.pos) hex.emitParticle({ id: `fz${Date.now()}`, kind: "ice", at: tgt.pos, actorId: tgt.id });
              }
              if (evt.type === "ability_burn_applied") {
                const e = evt as { target?: string };
                const tgt = e.target ? findMonster(e.target) : null;
                if (tgt?.pos) hex.emitParticle({ id: `bn${Date.now()}`, kind: "fire", at: tgt.pos, actorId: tgt.id });
              }
              if (evt.type === "ability_shock_applied") {
                const e = evt as { target?: string };
                const tgt = e.target ? findMonster(e.target) : null;
                if (tgt?.pos) hex.emitParticle({ id: `sk${Date.now()}`, kind: "lightning", at: tgt.pos, actorId: tgt.id });
              }
              if (
                evt.type === "passive_rogue_lethal_strike"
                || evt.type === "passive_sinister_queries"
                || evt.type === "hex_bleed_proc"
              ) {
                const e = evt as { target?: string };
                const tgt = e.target ? findMonster(e.target) : null;
                if (tgt?.pos) hex.emitParticle({ id: `bld${Date.now()}`, kind: "bleed", at: tgt.pos, actorId: tgt.id });
              }
              if (
                evt.type === "ability_shield_of_faith"
                || evt.type === "ability_barkskin"
                || evt.type === "ability_brace"
              ) {
                const e = evt as { actor?: string; target?: string };
                const tgt = e.target ? findFighter(e.target) : e.actor ? findFighter(e.actor) : null;
                if (tgt?.pos) {
                  hex.emitParticle({ id: `sof${Date.now()}`, kind: "shield", at: tgt.pos, actorId: tgt.id });
                  // Shield of Faith → "Test Coverage" rise (green checkmark).
                  if (evt.type === "ability_shield_of_faith") {
                    hex.emitRiseEffect({ id: `r${Date.now()}`, kind: "test_coverage", actorId: tgt.id });
                  }
                }
              }
              if (
                evt.type === "passive_paladin_auto_heal"
                || evt.type === "ability_good_fortune_delayed"
              ) {
                const e = evt as { target?: string; actor?: string };
                const tgt = e.target ? findFighter(e.target) : e.actor ? findFighter(e.actor) : null;
                if (tgt?.pos) {
                  hex.emitParticle({ id: `hl${Date.now()}`, kind: "heal", at: tgt.pos, actorId: tgt.id });
                  // Good Fortune → "Delivery Bonus" rise (gold coin).
                  if (evt.type === "ability_good_fortune_delayed") {
                    hex.emitRiseEffect({ id: `r${Date.now()}`, kind: "delivery_bonus", actorId: tgt.id });
                  }
                }
              }
              if (evt.type === "ability_animal_form" || evt.type === "ability_ill_omen_applied" || evt.type === "ability_hex") {
                const e = evt as { actor?: string; target?: string };
                const tgt = e.target ? (findFighter(e.target) ?? findMonster(e.target)) : e.actor ? findFighter(e.actor) : null;
                if (tgt?.pos) {
                  hex.emitParticle({ id: `mg${Date.now()}`, kind: "magic", at: tgt.pos, actorId: tgt.id });
                  // Ill Omen → dark hex rune rise on the target. The
                  // persistent status effects (animal_form / hex) already
                  // have ambient canvas overlays; no rise needed for them.
                  if (evt.type === "ability_ill_omen_applied" && tgt.id) {
                    hex.emitRiseEffect({ id: `r${Date.now()}`, kind: "ill_omen", actorId: tgt.id });
                  }
                }
              }
              // Taunt, Mark, Foresee — pure soft-effect rises with no
              // persistent status to render. Each fires on the relevant
              // pawn so the player sees who was just taunted / marked /
              // foreseen.
              if (evt.type === "ability_taunt") {
                const e = evt as { actor?: string };
                const aid = e.actor;
                if (aid) hex.emitRiseEffect({ id: `r${Date.now()}`, kind: "taunt", actorId: aid });
              }
              if (evt.type === "ability_mark" as never) {
                const e = evt as { target?: string };
                if (e.target) {
                  const tgt = findMonster(e.target) ?? findFighter(e.target);
                  if (tgt?.id) hex.emitRiseEffect({ id: `r${Date.now()}`, kind: "marked", actorId: tgt.id });
                }
              }
              if (evt.type === "ability_foresee") {
                const e = evt as { predicted_target?: string; actor?: string };
                const aid = e.predicted_target ?? e.actor;
                if (aid) {
                  const tgt = findMonster(aid) ?? findFighter(aid);
                  if (tgt?.id) hex.emitRiseEffect({ id: `r${Date.now()}`, kind: "foreseen", actorId: tgt.id });
                }
              }
              // Generic effect_applied from monster specials (entangle_on_hit etc.).
              if (evt.type === "effect_applied") {
                const tgt = findFighter(evt.target) ?? findMonster(evt.target);
                if (tgt?.pos) {
                  const k: ParticleKind =
                    evt.effect === "burning" ? "fire" :
                    evt.effect === "frozen" ? "ice" :
                    evt.effect === "shocked" ? "lightning" :
                    evt.effect === "poisoned" ? "poison" :
                    evt.effect === "bleeding" ? "bleed" : "magic";
                  hex.emitParticle({ id: `ea${Date.now()}`, kind: k, at: tgt.pos, actorId: tgt.id });
                }
              }
              // Crit on monster attack: shake even if the attack itself is melee.
              if (evt.type === "monster_attack" && evt.hp_damage >= 8) hex.shake();
            }
          }
          // 950ms ≈ tumble duration (700ms) + brief pause to read the value.
          const delay = hasRolls ? 950 : 0;
          setTimeout(() => dispatch({ kind: "events", value: msg.events }), delay);
        }
        else if (msg.type === "error") {
          toast.error(msg.message);
          dispatch({ kind: "error", value: msg.message });
        }
        else if (msg.type === "outcome") dispatch({ kind: "outcome", value: msg.outcome });
        else if (msg.type === "flavor") dispatch({ kind: "flavor", value: msg.flavor });
        else if (msg.type === "log_replay") {
          // Replayed log mixes CombatEvents (have `type`) and flavor markers
          // (have `_kind: "flavor"`). Split + dispatch in arrival order.
          const events: CombatEvent[] = [];
          for (const entry of msg.events) {
            if (entry && typeof entry === "object" && (entry as { _kind?: string })._kind === "flavor") {
              // Flush any buffered events first so timing is preserved.
              if (events.length > 0) {
                dispatch({ kind: "events", value: events.splice(0) });
              }
              const f = (entry as { flavor: { kind: "hit" | "victory" | "death" | "flee"; actor: string; text: string } }).flavor;
              dispatch({ kind: "flavor", value: f });
            } else {
              events.push(entry as CombatEvent);
            }
          }
          if (events.length > 0) dispatch({ kind: "events", value: events });
        }
      } catch {
        dispatch({ kind: "error", value: "bad message" });
      }
    };

    return () => {
      intentionalClose = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      clearInterval(heartbeat);
      ws.close();
      wsRef.current = null;
    };
  }, [questId, reconnectKey]);

  // Auto-scroll log to bottom as new entries arrive.
  // Depend on the last entry's id (not length) so the effect still fires
  // once the log is capped at 50 and length stops changing.
  const lastLogId = ui.log[ui.log.length - 1]?.id;
  useEffect(() => {
    const el = logScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastLogId]);

  function send(action: TurnAction): boolean {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ type: "action", action }));
    return true;
  }

  // Keep ref in sync so the auto-resolve effect can read it without a stale closure.
  useEffect(() => {
    autoResolveRef.current = autoResolve;
    localStorage.setItem("combat_auto_resolve", String(autoResolve));
  }, [autoResolve]);

  // Mirror the latest combat state into a ref so the long-lived WS event
  // handler (whose useEffect deps don't include `ui`) can always read
  // current actor positions when dispatching canvas particles + projectiles.
  useEffect(() => {
    stateRef.current = ui.state;
  }, [ui.state]);

  // Auto-resolve monster and merc turns: fires ~800ms after the turn becomes
  // active so the player still sees the transition before it resolves.
  const { state: stateForAuto } = ui;
  useEffect(() => {
    if (!stateForAuto || stateForAuto.status !== "active") return;
    const actorId = stateForAuto.turn_order[stateForAuto.turn_index % stateForAuto.turn_order.length];
    const isNonPlayer = isMonsterActor(actorId) || isAllyNpcActor(actorId);
    if (!isNonPlayer) return;
    // Ally NPCs always auto-resolve; monsters respect the autoResolve toggle.
    if (isMonsterActor(actorId) && !autoResolveRef.current) return;
    if (autoResolvedTurnRef.current === stateForAuto.turn_index) return;
    const timer = setTimeout(() => {
      if (isMonsterActor(actorId) && !autoResolveRef.current) return;
      const action = isAllyNpcActor(actorId) ? { kind: "ally_npc_act" as const } : { kind: "monster_act" as const };
      const fired = send(action);
      if (fired) autoResolvedTurnRef.current = stateForAuto.turn_index;
    }, 800);
    return () => clearTimeout(timer);
  }, [stateForAuto?.turn_index, stateForAuto?.status, autoResolve]);

  function exit() {
    // Just navigate away — combat state stays in D1 so the player can resume
    // from the dashboard. Use the EndBanner's Abandon control (or the dashboard's
    // explicit abandon button) to actually clear web combat state.
    onExit();
  }

  // Tower mid-cycle transition. POSTs start_web_combat to clear the
  // just-cleared floor's state and spin up the next floor's fight, then
  // resets local UI and reopens the WS so the new state frames replace the
  // victory modal in-place — no dashboard bounce.
  async function continueClimbing() {
    try {
      await fetch(`/api/quest/${questId}/start_web_combat`, {
        method: "POST",
        credentials: "include",
      });
    } catch (err) {
      toast.error(`Couldn't start next floor: ${(err as Error).message}`);
      return;
    }
    dispatch({ kind: "reset" });
    setVictoryModalReady(false);
    setDiceRolls([]);
    setLastSlash(null);
    setLastLunge(null);
    setLastForesee(null);
    autoResolvedTurnRef.current = -1;
    setReconnectKey((k) => k + 1);
  }

  // Tower post-boss: advance into the next cycle in place. Calls /tower/continue
  // to clear awaiting_choice and stage the next cycle's first floor, then
  // start_web_combat to spin up the fight. Same UI reset as continueClimbing.
  async function pressOnAfterBoss() {
    try {
      const res = await fetch(`/api/quest/${questId}/tower/continue`, {
        method: "POST",
        credentials: "include",
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!data.ok) {
        toast.error(`Couldn't press on: ${data.error ?? "unknown"}`);
        return;
      }
      await fetch(`/api/quest/${questId}/start_web_combat`, {
        method: "POST",
        credentials: "include",
      });
    } catch (err) {
      toast.error(`Couldn't press on: ${(err as Error).message}`);
      return;
    }
    dispatch({ kind: "reset" });
    setVictoryModalReady(false);
    setDiceRolls([]);
    setLastSlash(null);
    setLastLunge(null);
    setLastForesee(null);
    autoResolvedTurnRef.current = -1;
    setReconnectKey((k) => k + 1);
  }

  // Tower post-boss: bank the cycle's spoils and return to town.
  async function bankAndExit() {
    try {
      await fetch(`/api/quest/${questId}/tower/exit`, {
        method: "POST",
        credentials: "include",
      });
    } catch (err) {
      toast.error(`Couldn't bank spoils: ${(err as Error).message}`);
      return;
    }
    exit();
  }

  const state = ui.state;
  const currentActorId =
    state && state.status === "active"
      ? state.turn_order[state.turn_index % state.turn_order.length]
      : null;
  const myTurn = currentActorId === selfId;
  const isInactivePlayerTurn = !myTurn && currentActorId !== null && !isMonsterActor(currentActorId) && !isAllyNpcActor(currentActorId);

  // Skip-turn button becomes active after 8 s of waiting on another player.
  const [skipReady, setSkipReady] = useState(false);
  useEffect(() => {
    if (!isInactivePlayerTurn) { setSkipReady(false); return; }
    const t = setTimeout(() => setSkipReady(true), 8000);
    return () => clearTimeout(t);
  }, [isInactivePlayerTurn, currentActorId]);

  // Auto-skip when it's my turn but I'm frozen. The engine rejects move
  // while frozen and the attack-phase tick auto-skips, but without this
  // helper the player just sees disabled buttons and has to manually
  // click "Wait" — which feels broken. Sending wait fires the same
  // tickAtTurnStart that emits turn_skip + advances the turn.
  const meFrozen = !!state?.fighters.find((f) => f.id === selfId)?.effects?.some((e) => e.type === "frozen");
  useEffect(() => {
    if (!myTurn || !meFrozen || !state || state.status !== "active") return;
    // Small delay so the player visibly registers their turn started
    // (avatar tinted blue, "Frozen — turn skipped" log entry) before
    // the turn auto-advances. Otherwise it feels like nothing happened.
    const t = setTimeout(() => {
      send({ kind: "wait", actor: selfId });
    }, 800);
    return () => clearTimeout(t);
  }, [myTurn, meFrozen, state?.status, selfId]);

  const ended =
    state?.status === "victory" || state?.status === "defeat" || state?.status === "fled";

  // Gate victory/defeat modals so they don't interrupt dice animation.
  // If dice are rolling when combat ends, wait for them to settle (~1.8s).
  useEffect(() => {
    if (state?.status !== "victory") { setVictoryModalReady(false); return; }
    const delay = diceRolls.length > 0 ? 1800 : 0;
    const t = setTimeout(() => setVictoryModalReady(true), delay);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.status]);

  useEffect(() => {
    if (state?.status !== "defeat" && state?.status !== "fled") { setDefeatModalReady(false); return; }
    const delay = diceRolls.length > 0 ? 1800 : 0;
    const t = setTimeout(() => setDefeatModalReady(true), delay);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.status]);

  const me = state?.fighters.find((f) => f.id === selfId);
  const myMana = me?.mana ?? 0;
  // Pulled once per combat session — the loadout doesn't change mid-fight.
  // Falls back to the full class kit while in flight or if the fetch errors,
  // so abilities still render even when the talents endpoint is unreachable.
  const [equippedLoadout, setEquippedLoadout] = useState<AbilityLoadout | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/character/talents").then((r) => r.ok ? r.json() : null).then((raw) => {
      const j = raw as { loadout?: AbilityLoadout } | null;
      if (!cancelled && j?.loadout) setEquippedLoadout(j.loadout);
    }).catch(() => { /* fall through to class-kit fallback */ });
    return () => { cancelled = true; };
  }, []);
  const myActiveAbilities: ActiveAbilityDef[] = useMemo(() => {
    if (!me) return [];
    if (!equippedLoadout) return activeAbilities(classByName(me.class).abilities);
    const out: ActiveAbilityDef[] = [];
    for (const id of equippedLoadout.active) {
      if (!id) continue;
      const node = findNode(id);
      if (node && node.ability.kind === "active") out.push(node.ability as ActiveAbilityDef);
    }
    return out;
  }, [me, equippedLoadout]);
  const liveMonsters = state?.monsters.filter((m) => m.hp > 0) ?? [];
  const [targetMonsterId, setTargetMonsterId] = useState<string | null>(null);
  // Auto-select the only live monster; clear stale target when that monster dies.
  useEffect(() => {
    if (liveMonsters.length === 1) setTargetMonsterId(liveMonsters[0].id ?? null);
    else if (targetMonsterId !== null && !liveMonsters.find((m) => m.id === targetMonsterId)) {
      setTargetMonsterId(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveMonsters.map((m) => `${m.id}:${m.hp}`).join(",")]);
  const effectiveTarget = liveMonsters.length === 1 ? (liveMonsters[0].id ?? null) : targetMonsterId;

  // Spotlight = boss if any, else the current target. Renders huge in the
  // center column of the 3-col theatre grid; everything else flanks L/R.
  const spotlightMonster = (() => {
    if (!state?.monsters || state.monsters.length === 0) return null;
    const boss = state.monsters.find((m) => m.is_boss && m.hp > 0);
    if (boss) return boss;
    if (effectiveTarget !== null) {
      const t = state.monsters.find((m) => (m.id ?? null) === effectiveTarget);
      if (t && t.hp > 0) return t;
    }
    return liveMonsters[0] ?? state.monsters[0] ?? null;
  })();
  const spotlightId = spotlightMonster?.id ?? null;
  const flankMonsters = state?.monsters.filter((m, i) => {
    const mid = m.id ?? String(i);
    return mid !== (spotlightId ?? String(state.monsters.indexOf(m)));
  }) ?? [];
  const half = Math.ceil(flankMonsters.length / 2);
  const leftFlank = flankMonsters.slice(0, half);
  const rightFlank = flankMonsters.slice(half);

  function fireUseItem(itemId: number, targetId?: string) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      toast.error("Disconnected — reconnecting. Try again in a moment.");
      return;
    }
    send({ kind: "use_item", actor: selfId, item_id: itemId, target_id: targetId });
    // Don't optimistically remove — if the server rejects (e.g. catalog
    // mismatch, no live foe), the optimistic remove silently loses the
    // item from the picker until a full refresh. The item_used broadcast
    // triggers loadItems() which syncs within ~200ms anyway, and a server
    // error frame produces a toast so the user knows it didn't fire.
    setItemPicker("closed");
  }

  // Keyboard hotkeys 1-4 for the first four loadout actives. Skips when an
  // input/textarea/contenteditable is focused, or any modifier key is held —
  // we don't want to hijack Cmd+1 / browser tab shortcuts.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return;
      }
      const n = parseInt(e.key, 10);
      if (!Number.isFinite(n) || n < 1 || n > 4) return;
      const ability = myActiveAbilities[n - 1];
      if (!ability) return;
      if (!myTurn) return;
      if (myMana < ability.mana_cost) return;
      const cooldown = state?.cooldowns?.[selfId]?.[ability.id] ?? 0;
      if (cooldown > 0) return;
      e.preventDefault();
      // If already aiming this ability, cancel; otherwise fire.
      if (aimingAction?.kind === "ability" && aimingAction.ability.id === ability.id) {
        setAimingAction(null);
      } else {
        fireAbility(ability);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myActiveAbilities, myTurn, myMana, aimingAction, state?.cooldowns, selfId]);

  function fireAbility(ability: ActiveAbilityDef) {
    if (ability.needs_position_picker) {
      setMigratePicker(true);
      return;
    }
    const aliveFighters = state?.fighters.filter((f) => f.hp > 0) ?? [];
    if (ability.target === "single_ally" && aliveFighters.length > 1) {
      setAllyPickerAbility(ability);
      return;
    }
    if (ability.target === "any") {
      setAnyPickerAbility(ability);
      return;
    }
    // Hex mode + single_enemy → require the player to click a target on the
    // grid (aim mode). Skipped when there's no choice to make.
    if (ui.state?.hex_range_enabled && ability.target === "single_enemy") {
      setAimingAction({ kind: "ability", ability });
      return;
    }
    send({
      kind: "ability",
      actor: selfId,
      ability_id: ability.id,
      target_id: ability.target === "single_enemy" ? (effectiveTarget ?? undefined) : undefined,
    });
  }

  // Commits a queued aim action against the picked target. Called from the
  // canvas click handler when the player taps a valid pawn in aim mode.
  function commitAim(targetActorId: string) {
    if (!aimingAction) return;
    if (aimingAction.kind === "attack") {
      send({ kind: "attack", actor: selfId, target_id: targetActorId });
    } else {
      send({ kind: "ability", actor: selfId, ability_id: aimingAction.ability.id, target_id: targetActorId });
    }
    setTargetMonsterId(targetActorId);
    setAimingAction(null);
  }

  function fireAllyAbility(targetId: string) {
    if (!allyPickerAbility) return;
    if (allyPickerAbility.id === "protect" && targetId !== selfId) {
      const existingProtect = (state?.ability_state as { paladin_protect?: { paladin_id: string; target_id: string } } | undefined)?.paladin_protect;
      if (existingProtect?.paladin_id === selfId && existingProtect.target_id !== targetId) {
        setAllyPickerAbility(null);
        setProtectConfirm({ pendingTargetId: targetId });
        return;
      }
    }
    send({ kind: "ability", actor: selfId, ability_id: allyPickerAbility.id, target: targetId });
    setAllyPickerAbility(null);
  }

  function confirmProtect() {
    if (!protectConfirm) return;
    send({ kind: "ability", actor: selfId, ability_id: "protect", target: protectConfirm.pendingTargetId });
    setProtectConfirm(null);
  }

  function fireAnyAbility(pick: { kind: "monster"; id: string } | { kind: "fighter"; id: string }) {
    if (!anyPickerAbility) return;
    if (pick.kind === "monster") {
      send({ kind: "ability", actor: selfId, ability_id: anyPickerAbility.id, target_id: pick.id });
    } else {
      send({ kind: "ability", actor: selfId, ability_id: anyPickerAbility.id, target: pick.id });
    }
    setAnyPickerAbility(null);
  }

  function fireMigrate(targetId: string, position: "front" | "back") {
    send({ kind: "ability", actor: selfId, ability_id: "migrate", target: targetId, position });
    setMigratePicker(false);
  }

  async function fireGive(itemId: number, toUserId: string) {
    const res = await fetch(`/api/inventory/${itemId}/give`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to_user_id: toUserId }),
    });
    if (res.ok) await loadItems();
    setGivePicker("closed");
  }

  // Themed combat backdrop — picks a scenery key off the quest id so the
  // same fight always opens in the same room. Replaces the old "blow up
  // the monster portrait" backdrop, which left every fight looking like
  // an enemy splash screen.
  const scene = pickScene(questId);
  // Lazy-fetch the flux-generated scenery image via the existing view-art
  // endpoint. Null until the first cache hit lands; CombatBackdropLayer
  // (CSS/SVG scenery) renders underneath the whole time so the room is
  // never empty. On cache miss the worker schedules generation; a second
  // mount (or page reload) will land the URL.
  const [bgArtUrl, setBgArtUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const key = viewArtKeyForScene(scene);
    fetch(`/api/art/view/${encodeURIComponent(key)}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() as Promise<{ url: string | null }> : null))
      .then((body) => {
        if (cancelled || !body) return;
        setBgArtUrl(body.url);
      })
      .catch(() => { /* ignore — fallback already painted */ });
    return () => { cancelled = true; };
  }, [scene]);
  const isPickerOpen = itemPicker !== "closed" || migratePicker || allyPickerAbility !== null || anyPickerAbility !== null || givePicker !== "closed" || protectConfirm !== null;
  const otherPosition = me?.position === "front" ? "back" : "front";
  const isMonsterTurn = currentActorId !== null && isMonsterActor(currentActorId);

  return (
    <CombatParticlesProvider>
    <div style={{ position: "fixed", inset: 0, background: "#0a0b0e", display: "flex", flexDirection: "column", overflow: "hidden", fontFamily: "Inter, system-ui, sans-serif" }}>

      {/* 40px top bar */}
      <div style={{ background: "rgba(10,11,14,0.95)", borderBottom: "1px solid #1e2028", padding: "0 12px", height: 40, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, zIndex: 10 }}>
        <button onClick={exit} style={{ background: "none", border: "none", color: "#9aa0a6", cursor: "pointer", fontSize: 13, padding: "4px 8px", borderRadius: 6, display: "flex", alignItems: "center", gap: 6, fontFamily: "inherit" }}>
          <Icon name="footprint" size={13} /> Dashboard
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {import.meta.env.DEV && (
            <button
              onClick={() => setDevOpen(true)}
              style={{ background: "none", border: "1px solid #2a2d44", color: "#a78bfa", cursor: "pointer", fontSize: 11, padding: "2px 7px", borderRadius: 5, display: "flex", alignItems: "center", gap: 4, fontFamily: "inherit" }}
            >
              <Icon name="cog" size={11} /> dev
            </button>
          )}
          <span style={{ fontSize: 11, color: ui.connection === "open" ? "#39ff14" : ui.connection === "connecting" || ui.connection === "reconnecting" ? "#fbbf24" : "#fca5a5" }}>
            {ui.connection === "open"
              ? "● live"
              : ui.connection === "connecting"
              ? "○ …"
              : ui.connection === "reconnecting"
              ? "↻ reconnecting…"
              : "× disconnected"}
          </span>
        </div>
      </div>
      {devOpen && import.meta.env.DEV && (
        <CombatDevModal
          questId={questId}
          onClose={() => setDevOpen(false)}
          onDone={() => { setDevOpen(false); setReconnectKey((k) => k + 1); }}
        />
      )}

      {/* Room view — flex: 1, flat dark background. The old themed scenery
          backdrop (CombatBackdropLayer SVG + full-screen flux room photo +
          atmospheric gradient) is retired in hex mode: the AI-generated
          terrain now lives INSIDE the canvas and fills the actual play
          area, not the whole page. Slack/legacy combats still render the
          full backdrop for parity. */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden", minHeight: 0, background: "#0a0b10" }}>
        {!ui.state?.hex_range_enabled && <CombatBackdropLayer scene={scene} />}
        {!ui.state?.hex_range_enabled && bgArtUrl && (
          <img
            src={bgArtUrl}
            alt=""
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              opacity: 0.78,
              transition: "opacity 600ms ease",
              pointerEvents: "none",
            }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
        )}
        {!ui.state?.hex_range_enabled && (
          <div
            aria-hidden
            style={{
              position: "absolute", inset: 0, pointerEvents: "none",
              background: "linear-gradient(to bottom, rgba(0,0,0,0.30) 0%, rgba(0,0,0,0.05) 38%, rgba(0,0,0,0.78) 100%)",
            }}
          />
        )}
        {/* DOM particle overlay — retired in hex mode (canvas particles
            cover everything, positioned to actor pawns instead of screen
            center). Slack-compat / legacy combats still see it. */}
        {!ui.state?.hex_range_enabled && <CombatParticles />}

        {/* Pre-combat state — shown while the QuestRoom DO boots and the WS
            handshake completes. Themed to the rest of the combat UI (gold
            accents, display font) so the transition from quest banner →
            engagement → live combat reads as one continuous beat. */}
        {!state && (
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%,-50%)",
              textAlign: "center",
              padding: "0 24px",
              maxWidth: 420,
              width: "100%",
              boxSizing: "border-box",
              zIndex: 5,
            }}
          >
            <div
              aria-hidden
              style={{
                width: 64,
                height: 64,
                margin: "0 auto 18px",
                borderRadius: "50%",
                border: "2px solid rgba(251,191,36,0.18)",
                borderTopColor: "var(--accent-gold)",
                animation: "spin 1.1s linear infinite",
                boxShadow: "0 0 24px rgba(251,191,36,0.25)",
              }}
            />
            <div
              style={{
                font: "10px/1 var(--font-mono)",
                color: "var(--fg-mute)",
                textTransform: "uppercase",
                letterSpacing: 1.6,
                marginBottom: 8,
              }}
            >
              {ui.connection === "reconnecting" ? "Reconnecting" : "Engagement"}
            </div>
            <div
              style={{
                font: "26px/1.1 var(--font-display)",
                color: "var(--fg-1)",
                marginBottom: 10,
              }}
            >
              {ui.connection === "reconnecting"
                ? "Holding the line…"
                : "Drawing steel…"}
            </div>
            <p
              style={{
                margin: 0,
                color: "var(--fg-mute)",
                fontSize: 13,
                lineHeight: 1.5,
              }}
            >
              {ui.connection === "reconnecting"
                ? "Lost the signal — picking the thread back up."
                : "Spinning up the battlefield. This should only take a moment."}
            </p>
            {ui.error && (
              <p
                style={{
                  margin: "14px 0 0",
                  color: "var(--tone-bad)",
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                }}
              >
                {ui.error}
              </p>
            )}
          </div>
        )}

        {state && (
          <>
            {/* Floating initiative strip — top center */}
            <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: 8 }}>
              <InitStrip
                turnOrder={state.turn_order}
                turnIndex={state.turn_index}
                round={state.round}
                selfId={selfId}
                fighters={state.fighters}
                monsters={state.monsters}
              />
            </div>

            {/* Monster theatre — 3-col grid: flank L | spotlight | flank R.
                Spotlight is the boss-if-present-else-target, ringed in gold/red.
                Other monsters split across left/right flanks. Right rail
                reserves 300px so the combat log doesn't overlap flanks.
                On mobile collapses to a single column: spotlight on top,
                flanks below as scrollable chip rows.
                Hidden entirely in battlefield-first (hex) mode — the grid
                shows actor positions and callouts handle name + HP. */}
            {!state.hex_range_enabled && (
            <div style={isMobile ? {
              position: "absolute",
              top: 50, left: 0, right: 0, bottom: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 10,
              padding: "0 10px",
              zIndex: 4,
              pointerEvents: "none",
              overflowY: "auto",
            } : {
              position: "absolute",
              top: 60, left: 0, right: 300, bottom: 0,
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.5fr) minmax(0, 1fr)",
              alignItems: "center",
              gap: 12,
              padding: "0 16px",
              zIndex: 4,
              pointerEvents: "none",
            }}>
              {(() => {
                const renderMonsterCard = (m: Monster, i: number) => {
                  const mid = m.id ?? String(i);
                  return (
                    <MonsterCard
                      key={mid}
                      monster={m}
                      round={state.round}
                      showSageReading={me?.class === "Staff Sage"}
                      sageTarget={me?.class === "Staff Sage" && lastForesee ? (() => { const tid = lastForesee.predicted_targets?.[mid] ?? lastForesee.predicted_target; return tid ? (state.fighters.find((f) => f.id === tid)?.name ?? tid) : null; })() : null}
                      markedBy={
                        state.ability_state?.mark &&
                        state.round <= state.ability_state.mark.expires_after_round &&
                        (!state.ability_state.mark.monster_id || state.ability_state.mark.monster_id === (m.id ?? String(i)))
                          ? (state.fighters.find((f) => f.id === state.ability_state!.mark!.marked_by)?.name ?? state.ability_state.mark.marked_by)
                          : undefined
                      }
                      isTargeted={effectiveTarget !== null && (m.id ?? null) === effectiveTarget}
                      smiteDebuffed={!!((state.ability_state as { paladin_smite_debuff?: Record<string, number> } | undefined)?.paladin_smite_debuff?.[mid])}
                      discouraged={(state.ability_state as { discourage?: Record<string, number> } | undefined)?.discourage?.[mid] ?? 0}
                      vulnerable={(state.ability_state as { vulnerable?: Record<string, { expires_after_round: number; magnitude: number }> } | undefined)?.vulnerable?.[mid]}
                      taunt={(() => { const t = (state.ability_state as { taunt?: { actor_id: string; swings_remaining: number } } | undefined)?.taunt; return t && t.swings_remaining > 0 ? { actor_name: state.fighters.find((f) => f.id === t.actor_id)?.name ?? t.actor_id, swings: t.swings_remaining } : undefined; })()}
                      illOmen={(state.ability_state as { ill_omen?: Record<string, { accumulated: number; monster_turns_remaining: number }> } | undefined)?.ill_omen?.[mid]}
                      slashSeq={lastSlash?.id === mid ? lastSlash.seq : 0}
                      lungeSeq={lastLunge?.id === mid ? lastLunge.seq : 0}
                      dustSeq={hitDustSeq[mid] ?? 0}
                      onClick={liveMonsters.length > 1 && m.hp > 0 ? () => setTargetMonsterId(m.id ?? null) : undefined}
                    />
                  );
                };
                // Left flank column (desktop) / row of flank chips above
                // spotlight (mobile).
                const leftCol = (
                  <div style={isMobile ? {
                    display: "flex", flexDirection: "row", gap: 8,
                    flexWrap: "wrap", justifyContent: "center",
                    pointerEvents: "auto", width: "100%",
                  } : {
                    display: "flex", flexDirection: "column", gap: 10,
                    alignItems: "stretch", justifyContent: "center",
                    pointerEvents: "auto", minWidth: 0,
                  }}>
                    {leftFlank.map((m) => renderMonsterCard(m, state.monsters.indexOf(m)))}
                  </div>
                );
                // Spotlight column — circular portrait inside a rotating
                // dashed ring per the design handoff (Combat B Study.html).
                const spotlightCol = spotlightMonster ? (() => {
                  const spotIdx = state.monsters.indexOf(spotlightMonster);
                  const spotId = spotlightMonster.id ?? String(spotIdx);
                  return (
                    <div style={{
                      display: "flex", justifyContent: "center", alignItems: "center",
                      pointerEvents: "auto",
                    }}>
                      <SpotlightMonster
                        monster={spotlightMonster}
                        round={state.round}
                        showSageReading={me?.class === "Staff Sage"}
                        sageTarget={me?.class === "Staff Sage" && lastForesee ? (() => { const tid = lastForesee.predicted_targets?.[spotId] ?? lastForesee.predicted_target; return tid ? (state.fighters.find((f) => f.id === tid)?.name ?? tid) : null; })() : null}
                        markedBy={
                          state.ability_state?.mark &&
                          state.round <= state.ability_state.mark.expires_after_round &&
                          (!state.ability_state.mark.monster_id || state.ability_state.mark.monster_id === spotId)
                            ? (state.fighters.find((f) => f.id === state.ability_state!.mark!.marked_by)?.name ?? state.ability_state.mark.marked_by)
                            : undefined
                        }
                        isTargeted={effectiveTarget !== null && (spotlightMonster.id ?? null) === effectiveTarget}
                        smiteDebuffed={!!((state.ability_state as { paladin_smite_debuff?: Record<string, number> } | undefined)?.paladin_smite_debuff?.[spotId])}
                        discouraged={(state.ability_state as { discourage?: Record<string, number> } | undefined)?.discourage?.[spotId] ?? 0}
                        vulnerable={(state.ability_state as { vulnerable?: Record<string, { expires_after_round: number; magnitude: number }> } | undefined)?.vulnerable?.[spotId]}
                        taunt={(() => { const t = (state.ability_state as { taunt?: { actor_id: string; swings_remaining: number } } | undefined)?.taunt; return t && t.swings_remaining > 0 ? { actor_name: state.fighters.find((f) => f.id === t.actor_id)?.name ?? t.actor_id, swings: t.swings_remaining } : undefined; })()}
                        illOmen={(state.ability_state as { ill_omen?: Record<string, { accumulated: number; monster_turns_remaining: number }> } | undefined)?.ill_omen?.[spotId]}
                        slashSeq={lastSlash?.id === spotId ? lastSlash.seq : 0}
                        lungeSeq={lastLunge?.id === spotId ? lastLunge.seq : 0}
                        dustSeq={hitDustSeq[spotId] ?? 0}
                        compact={isMobile}
                        onClick={liveMonsters.length > 1 && spotlightMonster.hp > 0 ? () => setTargetMonsterId(spotlightMonster.id ?? null) : undefined}
                      />
                    </div>
                  );
                })() : <div />;
                // Right flank column (desktop) / row of flank chips below
                // spotlight (mobile).
                const rightCol = (
                  <div style={isMobile ? {
                    display: "flex", flexDirection: "row", gap: 8,
                    flexWrap: "wrap", justifyContent: "center",
                    pointerEvents: "auto", width: "100%",
                  } : {
                    display: "flex", flexDirection: "column", gap: 10,
                    alignItems: "stretch", justifyContent: "center",
                    pointerEvents: "auto", minWidth: 0,
                  }}>
                    {rightFlank.map((m) => renderMonsterCard(m, state.monsters.indexOf(m)))}
                  </div>
                );
                return <>{leftCol}{spotlightCol}{rightCol}</>;
              })()}
            </div>
            )}

            {/* Left column — dice rolls, below the initiative strip */}
            <div style={{ position: "absolute", top: 60, left: 12, zIndex: 6, maxWidth: isMobile ? 90 : "min(200px, 16vw)" }}>
              <DiceRollDisplay rolls={diceRolls} align="left" />
            </div>

            {/* Right rail — combat log on top (flex: 1 absorbs leftover height)
                + participant dock below (all live fighters + monsters, always
                visible). Hidden on mobile since the rail's too narrow to be
                useful there. */}
            {!isMobile && (
              <div style={{
                position: "absolute", top: 12, right: 12, bottom: 12, width: "min(280px, 22vw)",
                display: "flex", flexDirection: "column", gap: 8, zIndex: 6,
                background: "rgba(0,0,0,0.6)", border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 8, backdropFilter: "blur(6px)", padding: "8px 6px 6px",
              }}>
                <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                  <CombatLog log={ui.log} scrollRef={logScrollRef} />
                </div>
                {(() => {
                  // Fighters: include downed so the rail reflects who needs a
                  // revive. Monsters: hide once dead — no value lingering on a
                  // corpse, and gauntlet waves swap in fresh foes.
                  const allFighters = state.fighters;
                  const liveMons = state.monsters.filter((m) => m.hp > 0);
                  if (allFighters.length === 0 && liveMons.length === 0) return null;
                  return (
                    <div style={{
                      flex: "0 1 auto",
                      maxHeight: "55%",
                      overflowY: "auto",
                      display: "flex", flexDirection: "column", gap: 4,
                      paddingTop: 6,
                      borderTop: "1px solid rgba(255,255,255,0.08)",
                    }}>
                      {allFighters.map((f) => {
                        const pawn: PawnLike = {
                          id: f.id, name: f.name,
                          hp: f.hp, max_hp: f.max_hp,
                          mana: f.mana, max_mana: f.max_mana,
                          class: f.class, level: f.level,
                          shield: f.shield,
                          armor_power: f.armor_power,
                          effects: (f.effects ?? []) as never,
                        };
                        const themeColor = f.id === selfId ? "#7dd3fc" : "#a78bfa";
                        return (
                          <RailParticipantCard
                            key={f.id}
                            pawn={pawn}
                            side="fighter"
                            themeColor={themeColor}
                            isSelf={f.id === selfId}
                            isCurrent={currentActorId === f.id}
                            isHovered={hoveredPawnId === f.id}
                            isPinned={pinnedPawnId === f.id}
                            onMouseEnter={() => setHoveredPawnId(f.id)}
                            onMouseLeave={() => setHoveredPawnId((prev) => prev === f.id ? null : prev)}
                            onClick={() => {
                              // First click pins (or unpins); second click on
                              // an already-pinned card opens the full sheet.
                              if (pinnedPawnId === f.id) {
                                setSheetSubject({
                                  pawn,
                                  side: "fighter",
                                  themeColor,
                                  isSelf: f.id === selfId,
                                  loadout: f.id === selfId ? equippedLoadout ?? undefined : undefined,
                                  equippedPassiveIds: f.equipped_passive_ids,
                                });
                              } else {
                                setPinnedPawnId(f.id);
                              }
                            }}
                          />
                        );
                      })}
                      {liveMons.map((m) => {
                        const pawn: PawnLike = {
                          id: m.id ?? "", name: m.name,
                          hp: m.hp, max_hp: m.max_hp,
                          tier: m.tier, is_boss: m.is_boss,
                          shield: m.shield ?? 0,
                          armor_power: 2 * m.tier,
                          art_url: m.art_url,
                          effects: (m.effects ?? []) as never,
                        };
                        const themeColor = m.is_boss ? "#f87171" : "#fca5a5";
                        const monsterId = m.id ?? "";
                        return (
                          <RailParticipantCard
                            key={monsterId}
                            pawn={pawn}
                            side="monster"
                            themeColor={themeColor}
                            isCurrent={currentActorId === m.id}
                            isHovered={hoveredPawnId === monsterId}
                            isPinned={pinnedPawnId === monsterId}
                            onMouseEnter={() => setHoveredPawnId(monsterId)}
                            onMouseLeave={() => setHoveredPawnId((prev) => prev === monsterId ? null : prev)}
                            onClick={() => {
                              if (pinnedPawnId === monsterId) {
                                setSheetSubject({
                                  pawn,
                                  side: "monster",
                                  themeColor,
                                  monsterExtras: {
                                    weapon_range: m.weapon_range,
                                    range_tiles: m.range_tiles,
                                    move_range: m.move_range,
                                    specials: m.specials,
                                    element_weakness: m.element_weakness,
                                    element_resistance: m.element_resistance,
                                    attack_damage_type: m.attack_damage_type,
                                    boss_phase: m.boss_phase,
                                  },
                                });
                              } else {
                                setPinnedPawnId(monsterId);
                              }
                            }}
                          />
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Pick-a-target prompt */}
            {myTurn && liveMonsters.length > 1 && targetMonsterId === null && !isPickerOpen && !state.hex_range_enabled && (
              <div style={{ position: "absolute", bottom: 10, left: "50%", transform: "translateX(-50%)", zIndex: 7, background: "rgba(30,26,46,0.92)", border: "1px solid #c084fc", borderRadius: 8, padding: "6px 18px", color: "#e9d5ff", fontSize: 13, fontWeight: 600, backdropFilter: "blur(6px)", whiteSpace: "nowrap" }}>
                Click a monster to target it
              </div>
            )}

            {/* Battlefield-first hex grid view. The hex grid IS the combat
                scene — the dense card layout above is hidden when
                hex_range_enabled is set. Pawn callouts are absolutely
                positioned over the canvas using positions reported by the
                grid component. */}
            {state.hex_range_enabled && state.grid && (() => {
              // Portrait grid is 9×11 → taller than wide. Tune hex size so the
              // arena fits the available vertical space on each device.
              const HEX_SIZE = isMobile ? 14 : 24;
              const canvasDisplayW = canvasSize.w;
              const canvasDisplayH = canvasSize.h;

              // Aim-mode banner floating at the top of the battlefield —
              // tells the player to click an enemy pawn (with a Cancel button).
              const aimBanner = aimingAction && (
                <div style={{
                  position: "absolute",
                  top: 8,
                  left: "50%",
                  transform: "translateX(-50%)",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  zIndex: 41,
                  pointerEvents: "auto",
                  background: "rgba(251,146,60,0.95)",
                  color: "#0e0f12",
                  borderRadius: 6,
                  padding: "4px 12px",
                  fontWeight: 700,
                  fontSize: 12,
                  letterSpacing: 0.5,
                  boxShadow: "0 4px 12px rgba(0,0,0,0.55)",
                }}>
                  <span>
                    {aimingAction.kind === "attack" ? "ATTACK" : aimingAction.ability.name.toUpperCase()} —
                    {" "}click an enemy
                  </span>
                  <button
                    onClick={() => setAimingAction(null)}
                    style={{
                      background: "rgba(15,23,42,0.85)",
                      border: "1px solid rgba(15,23,42,0.7)",
                      borderRadius: 4,
                      padding: "1px 8px",
                      color: "#fff",
                      fontSize: 11,
                      cursor: "pointer",
                      fontWeight: 600,
                    }}
                  >
                    Cancel
                  </button>
                </div>
              );

              // Phase/Skip-Move floating chip at the top of the battlefield.
              const phaseChip = !aimingAction && myTurn && (
                <div style={{
                  position: "absolute",
                  top: 8,
                  left: "50%",
                  transform: "translateX(-50%)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  zIndex: 40,
                  pointerEvents: "auto",
                }}>
                  <span style={{
                    padding: "3px 12px",
                    borderRadius: 4,
                    background: state.turn_phase === "move" ? "rgba(34,197,94,0.85)" : "rgba(248,113,113,0.85)",
                    color: "#fff",
                    fontWeight: 700,
                    fontSize: 11,
                    letterSpacing: 0.6,
                    boxShadow: "0 2px 8px rgba(0,0,0,0.45)",
                  }}>
                    {state.turn_phase === "move" ? "MOVE" : "ATTACK"}
                  </span>
                  {state.turn_phase === "move" && me?.pos && (
                    <button
                      onClick={() => send({ kind: "move" as never, actor: selfId, to: me.pos! } as never)}
                      style={{
                        background: "rgba(15,23,42,0.85)",
                        border: "1px solid rgba(148,163,184,0.5)",
                        borderRadius: 4,
                        padding: "2px 10px",
                        color: "#e5e7eb",
                        fontSize: 11,
                        cursor: "pointer",
                        fontWeight: 600,
                      }}
                      title="Stay in place — advance to attack phase"
                    >
                      Skip Move
                    </button>
                  )}
                </div>
              );

              return (
                <div
                  ref={battlefieldFrameRef}
                  style={{
                    position: "absolute",
                    top: 50,
                    left: 0,
                    // Right edge tracks the combat log's actual left edge.
                    // Log is positioned `right: 12` with `width: min(280px, 22vw)`,
                    // so the canvas right edge is `12 + log.width + 8` for a small
                    // visual gap. This calc keeps the canvas flush against the log
                    // even when the viewport is narrow and the log shrinks below
                    // 280px — the old hard-coded `right: 300` left a big dead
                    // strip in that case.
                    right: isMobile ? 0 : "calc(min(280px, 22vw) + 20px)",
                    bottom: 12,
                    zIndex: 5,
                    pointerEvents: "none",
                  }}
                >
                  <div style={{
                    position: "relative",
                    pointerEvents: "auto",
                    width: "100%",
                    height: "100%",
                  }}>
                    {phaseChip}
                    {aimBanner}
                    <CombatHexGrid
                      state={state as never}
                      myActorId={selfId}
                      currentActorId={currentActorId}
                      isMyTurn={myTurn}
                      viewportWidth={battlefieldSize.w}
                      viewportHeight={battlefieldSize.h}
                      turnPhase={state.turn_phase ?? "attack"}
                      hexSize={HEX_SIZE}
                      apiRef={hexApiRef}
                      backgroundUrl={battlefieldArtUrl}
                      targetMonsterId={effectiveTarget}
                      previewedTargetIds={(() => {
                        // Aim mode wins — show every valid target the player
                        // could click. Falls back to hover preview otherwise.
                        if (aimingAction) {
                          // For attack/single_enemy abilities, every live in-range
                          // monster is fair game. We don't filter by range here
                          // (engine rejects out-of-range), but the glow makes
                          // it obvious where the player can aim.
                          return liveMonsters.map((m) => m.id ?? "").filter(Boolean);
                        }
                        if (!previewedKind) return [];
                        if (previewedKind.scope === "all_enemies") {
                          const r = previewedKind.radiusTiles;
                          const casterPos = me?.pos;
                          const inRange = (typeof r === "number" && r > 0 && casterPos)
                            ? (m: { pos?: { q: number; r: number } | null }) => !!m.pos && hexDistance(casterPos, m.pos) <= r
                            : () => true;
                          return liveMonsters.filter(inRange).map((m) => m.id ?? "").filter(Boolean);
                        }
                        if (previewedKind.scope === "all_allies") {
                          const r = previewedKind.radiusTiles;
                          const casterPos = me?.pos;
                          const allies = state.fighters.filter((f) => f.hp > 0);
                          if (typeof r === "number" && r > 0 && casterPos) {
                            return allies.filter((f) => f.pos && hexDistance(casterPos, f.pos) <= r).map((f) => f.id);
                          }
                          return allies.map((f) => f.id);
                        }
                        if (previewedKind.scope === "single_enemy" && effectiveTarget) return [effectiveTarget];
                        if (previewedKind.scope === "single_ally") return [previewedKind.actorId];
                        if (previewedKind.scope === "self") return [previewedKind.actorId];
                        return [];
                      })()}
                      previewedTargetKind={
                        aimingAction
                          ? "enemy"
                          : previewedKind?.scope === "all_allies" || previewedKind?.scope === "single_ally" || previewedKind?.scope === "self"
                            ? "ally"
                            : "enemy"
                      }
                      aimActive={!!aimingAction}
                      aimRangeTiles={
                        aimingAction?.kind === "ability" && typeof aimingAction.ability.range_tiles === "number"
                          ? aimingAction.ability.range_tiles
                          : undefined
                      }
                      aimAoeRadiusTiles={
                        aimingAction?.kind === "ability" && typeof aimingAction.ability.aoe_radius_tiles === "number"
                          ? aimingAction.ability.aoe_radius_tiles
                          : undefined
                      }
                      onPawnHoverChange={setHoveredPawnId}
                      onPawnPositionsChange={setPawnPositions}
                      onCanvasResize={setCanvasSize}
                      onHexClick={(hex) => {
                        // Identify occupant first — tapping a pawn always toggles
                        // its callout pin, separately from game actions.
                        const fighter = state.fighters.find((f) => f.hp > 0 && f.pos && f.pos.q === hex.q && f.pos.r === hex.r);
                        const monster = state.monsters.find((m) => m.hp > 0 && m.pos && m.pos.q === hex.q && m.pos.r === hex.r);
                        const occupantId = fighter?.id ?? monster?.id ?? null;

                        // Aim mode: commit the queued attack/ability on the clicked enemy pawn.
                        if (aimingAction && monster?.id) {
                          // Reachability gate: cube-coord hex distance vs the
                          // EFFECTIVE range for the active action — basic
                          // attack uses weapon range; abilities use their
                          // explicit `range_tiles` if declared, else weapon range.
                          const dq = (me?.pos?.q ?? 0) - (monster.pos?.q ?? 0);
                          const dr = (me?.pos?.r ?? 0) - (monster.pos?.r ?? 0);
                          const ds = -dq - dr;
                          const dist = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds));
                          const weaponRange = me?.weapon_range === "ranged"
                            ? (5 + Math.floor(Math.max(0, (me?.stats?.dex ?? 5) - 5) / 4))
                            : me?.weapon_range === "focus"
                              ? (3 + Math.floor(Math.max(0, (me?.stats?.int_stat ?? 5) - 5) / 4))
                              : 1;
                          const range = aimingAction.kind === "ability"
                            ? (aimingAction.ability.range_tiles ?? weaponRange)
                            : weaponRange;
                          if (dist > range) {
                            toast.error("Out of range");
                            return;
                          }
                          commitAim(monster.id);
                          return;
                        }
                        // Clicking off-pawn while aiming cancels aim.
                        if (aimingAction && !occupantId) {
                          setAimingAction(null);
                          // …and falls through to the move handler below so
                          // an empty-hex tap can still move during MOVE phase.
                        }

                        if (occupantId) {
                          // Toggle pin (mobile + accessibility).
                          setPinnedPawnId((prev) => prev === occupantId ? null : occupantId);
                          // Click on an enemy pawn during MY attack phase selects
                          // it as the target — the player then clicks Attack or
                          // an ability button to fire. No auto-attack here.
                          if (monster && myTurn && state.turn_phase === "attack") {
                            setTargetMonsterId(monster.id ?? null);
                          }
                          return;
                        }

                        if (!myTurn || !currentActorId) return;
                        // Empty hex tap in move phase: try to move there.
                        if (state.turn_phase === "move") {
                          send({ kind: "move" as never, actor: selfId, to: hex } as never);
                        }
                      }}
                    />
                  </div>
                  {/* Bottom-left dock removed — participant info now lives in
                      the right rail under the combat log, where hover/pin
                      state highlights the matching rail card. */}
                </div>
              );
            })()}

            {/* Combat-end tint (before modal appears). Stays up until BOTH
                the dice-settle delay finishes AND the server outcome has
                arrived — without the second condition there'd be a brief
                blank gap between the banner disappearing and the modal
                rendering on a fast no-dice exit. */}
            {ended && state.status !== "victory" && (!defeatModalReady || !ui.outcome) && (
              <div style={{ position: "absolute", inset: 0, background: "rgba(80,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20 }}>
                <div style={{ fontFamily: DISPLAY_FONT, fontSize: 44, color: "#fca5a5", textShadow: "0 0 24px rgba(252,165,165,0.5)" }}>
                  {state.status === "fled" ? "ESCAPED" : "DEFEATED"}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Party chips row — hidden in battlefield-first mode; pawn callouts
          on the grid carry the same info. */}
      {state && !state.hex_range_enabled && (
        <div style={{
          background: "var(--bg-deep)",
          borderTop: "1px solid var(--border-base)",
          borderBottom: "1px solid var(--border-faint)",
          padding: isMobile ? "6px 10px 5px" : "13px 24px 12px",
          flexShrink: 0,
          zIndex: 8,
        }}>
          <PartyChips fighters={state.fighters} selfId={selfId} flashIds={flashIds} hitDustSeq={hitDustSeq} healBurstSeq={healBurstSeq} shieldBurstSeq={shieldBurstSeq} onClickSelf={onOpenInventory} abilityState={state.ability_state} round={state.round} currentActorId={currentActorId} />
        </div>
      )}

      {/* Pickers — all portal-based modals */}
      {state?.status === "active" && itemPicker === "open" && (
        <InventoryFullScreen
          items={items}
          inQuest={true}
          selfId={selfId}
          characterLevel={state.fighters.find((f) => f.id === selfId)?.level}
          effects={state.fighters.find((f) => f.id === selfId)?.effects ?? []}
          onEquip={async (id) => {
            // Mid-combat swap: hit the equip endpoint, refresh inventory,
            // and the WS handler picks up the new fighter stats from the
            // DO's refreshFromD1 broadcast (see worker.ts).
            const r = await fetch(`/api/inventory/${id}/equip`, { method: "POST", credentials: "include" });
            if (!r.ok) {
              const err = await r.json().catch(() => ({ error: "unknown" })) as { error?: string };
              toast.error(`Can't equip: ${err.error ?? r.statusText}`);
              return;
            }
            await loadItems();
          }}
          onUnequip={async (id) => {
            const r = await fetch(`/api/inventory/${id}/unequip`, { method: "POST", credentials: "include" });
            if (!r.ok) {
              const err = await r.json().catch(() => ({ error: "unknown" })) as { error?: string };
              toast.error(`Can't unequip: ${err.error ?? r.statusText}`);
              return;
            }
            await loadItems();
          }}
          onSell={() => {}}
          onUse={(id) => {
            const item = items.find((i) => i.id === id);
            if (item?.item_type === "revive") {
              setItemPicker({ reviveItemId: id });
            } else {
              fireUseItem(id);
            }
          }}
          onGive={() => {}}
          onClose={() => setItemPicker("closed")}
        />
      )}
      {state?.status === "active" && typeof itemPicker === "object" && "reviveItemId" in itemPicker && (
        <ReviveTargetPicker
          fighters={state.fighters as unknown as CombatFighter[]}
          onPick={(targetId) => fireUseItem((itemPicker as { reviveItemId: number }).reviveItemId, targetId)}
          onCancel={() => setItemPicker("open")}
        />
      )}
      {state?.status === "active" && migratePicker && (
        <MigratePicker
          fighters={state.fighters}
          selfId={selfId}
          onPick={fireMigrate}
          onCancel={() => setMigratePicker(false)}
        />
      )}
      {state?.status === "active" && allyPickerAbility && (
        <AllyPicker
          fighters={state.fighters}
          ability={allyPickerAbility}
          onPick={fireAllyAbility}
          onCancel={() => setAllyPickerAbility(null)}
        />
      )}
      {state?.status === "active" && anyPickerAbility && (
        <AnyTargetPicker
          fighters={state.fighters}
          monsters={state.monsters}
          ability={anyPickerAbility}
          onPick={fireAnyAbility}
          onCancel={() => setAnyPickerAbility(null)}
        />
      )}
      {state?.status === "active" && protectConfirm && (() => {
        const existingProtect = (state.ability_state as { paladin_protect?: { paladin_id: string; target_id: string } } | undefined)?.paladin_protect;
        const existingName = state.fighters.find((f) => f.id === existingProtect?.target_id)?.name ?? "an ally";
        const pendingName = state.fighters.find((f) => f.id === protectConfirm.pendingTargetId)?.name ?? "an ally";
        return (
          <PickerModal title={<><Icon name="crowned-heart" /> Replace protection?</>} onClose={() => setProtectConfirm(null)}>
            <p style={{ margin: "0 0 16px", color: "#d1d5db", fontSize: 14 }}>
              {existingName} is currently under your protection. Replace with {pendingName}?
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={confirmProtect}
                style={{ flex: 1, background: "#7c2020", border: "1px solid #a33030", color: "#f5f5f5", borderRadius: 6, padding: "8px 0", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}
              >
                Replace
              </button>
              <button
                onClick={() => setProtectConfirm(null)}
                style={{ flex: 1, background: "#1e2028", border: "1px solid #2a2d44", color: "#9aa0a6", borderRadius: 6, padding: "8px 0", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}
              >
                Cancel
              </button>
            </div>
          </PickerModal>
        );
      })()}
      {state?.status === "active" && givePicker === "selectItem" && (
        <GiveItemPicker
          items={items as unknown as CombatItem[]}
          onPickItem={(id) => setGivePicker({ itemId: id })}
          onCancel={() => setGivePicker("closed")}
        />
      )}
      {state?.status === "active" && typeof givePicker === "object" && "itemId" in givePicker && (
        <GiveTargetPicker
          fighters={state.fighters as unknown as CombatFighter[]}
          selfId={selfId}
          onPick={(id) => void fireGive((givePicker as { itemId: number }).itemId, id)}
          onCancel={() => setGivePicker("selectItem")}
        />
      )}

      {/* Action bar — CBtn row */}
      {state?.status === "active" && !isPickerOpen && (() => {
        const targetMonster = effectiveTarget !== null
          ? state.monsters.find((m) => (m.id ?? null) === effectiveTarget && m.hp > 0)
          : null;
        const noTarget = liveMonsters.length > 1 && !targetMonster;
        const actorName = me?.name ?? state.fighters.find((f) => f.id === currentActorId)?.name ?? "—";
        const actorClass = me?.class ?? state.fighters.find((f) => f.id === currentActorId)?.class;
        const showTurncard = !isMobile;
        return (
        <div style={{
          background: "var(--bg-deep)",
          borderTop: "1px solid var(--border-faint)",
          // Reserve safe-area for iOS home indicator so the bar never sits
          // under the gesture stripe. The constant `env(safe-area-inset-bottom)`
          // is 0 on platforms without a notch.
          padding: isMobile
            ? "8px 10px calc(10px + env(safe-area-inset-bottom, 0px))"
            : "12px 24px 16px",
          flexShrink: 0,
          display: "grid",
          gridTemplateColumns: showTurncard ? "220px 1fr" : "1fr",
          gap: showTurncard ? 18 : 6,
          alignItems: "center",
        }}>
          {/* Active-turn card (left) */}
          {showTurncard && (
            <div style={{
              background: "var(--bg-card-2)",
              border: "1px solid var(--accent-gold-warm)",
              borderRadius: "var(--radius-lg)",
              padding: "11px 13px",
              minWidth: 0,
            }}>
              <div style={{
                font: "9px/1 var(--font-mono)",
                textTransform: "uppercase",
                letterSpacing: 1,
                color: "var(--accent-gold-warm)",
              }}>
                {myTurn ? "Your turn" : "Active turn"}
              </div>
              <div style={{
                font: "17px/1.1 var(--font-display)",
                color: "var(--fg-1)",
                marginTop: 5,
                display: "flex",
                alignItems: "center",
                gap: 7,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}>
                {actorName}
              </div>
              {actorClass && (
                <div style={{
                  font: "10px/1 var(--font-mono)",
                  color: "var(--accent-arcane-2)",
                  textTransform: "uppercase",
                  letterSpacing: 0.4,
                  marginTop: 4,
                }}>
                  {actorClass}
                </div>
              )}
              <div style={{
                font: "10px/1.3 var(--font-mono)",
                color: noTarget ? "var(--tone-bad)" : "var(--fg-mute)",
                marginTop: 7,
              }}>
                {noTarget ? (
                  <>No target — <b style={{ color: "var(--tone-bad-2)" }}>pick an enemy</b></>
                ) : targetMonster ? (
                  <>Targeting <b style={{ color: "var(--accent-gold-warm)" }}>{targetMonster.name}</b></>
                ) : (
                  <>Ready to act</>
                )}
              </div>
            </div>
          )}
          {/* Ability bar. On mobile we cap the bar height and let it scroll
              vertically — the buttons used to wrap into 3–4 rows on short
              phone viewports, pushing Flee/Auto under the iOS home bar.
              Capping the height keeps every action reachable. */}
          <div style={{
            display: "flex",
            gap: isMobile ? 6 : 8,
            alignItems: "center",
            flexWrap: "wrap",
            minWidth: 0,
            maxHeight: isMobile ? "32vh" : undefined,
            overflowY: isMobile ? "auto" : "visible",
            WebkitOverflowScrolling: "touch",
            paddingBottom: isMobile ? 2 : 0,
          }}>
          {/* Turn status hint */}
          {!myTurn && (
            <div style={{ width: "100%", textAlign: "center", fontSize: 11, color: "var(--fg-mute)", fontStyle: "italic", paddingBottom: 2, display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
              <span>{isMonsterTurn && !autoResolve ? "Enemy turn" : isMonsterTurn ? "Enemy turn — auto-resolving…" : `Waiting for ${state.fighters.find((f) => f.id === currentActorId)?.name ?? "another player"}…`}</span>
              {isInactivePlayerTurn && (
                <button
                  onClick={() => currentActorId && send({ kind: "wait", actor: currentActorId })}
                  disabled={!skipReady}
                  title={skipReady ? "Skip this player's turn" : "Available after 8 seconds"}
                  style={{
                    background: skipReady ? "var(--bg-input)" : "var(--bg-input-2)",
                    border: `1px solid ${skipReady ? "var(--border-strong)" : "var(--border-base)"}`,
                    borderRadius: "var(--radius-md)",
                    color: skipReady ? "var(--fg-3)" : "var(--fg-faint)",
                    fontSize: 11,
                    fontFamily: "inherit",
                    padding: "3px 10px",
                    cursor: skipReady ? "pointer" : "not-allowed",
                    transition: "all 0.3s ease",
                  }}
                >
                  Skip turn
                </button>
              )}
            </div>
          )}
          <CBtn
            label={aimingAction?.kind === "attack" ? "Aiming…" : "Attack"}
            icon="sword"
            color={aimingAction?.kind === "attack" ? "#fb923c" : "#b89b3a"}
            disabled={!myTurn}
            onClick={() => {
              // Click Attack again while aiming = cancel.
              if (aimingAction?.kind === "attack") { setAimingAction(null); return; }
              // Hex mode → enter aim, otherwise fire immediately on current
              // selected target (legacy single-monster + front/back combat).
              if (state.hex_range_enabled) setAimingAction({ kind: "attack" });
              else send({ kind: "attack", actor: selfId, target_id: effectiveTarget });
            }}
            onMouseEnter={() => setPreviewedKind({ scope: "single_enemy" })}
            onMouseLeave={() => setPreviewedKind(null)}
          />
          {myActiveAbilities.map((ability, abilityIndex) => {
            const cooldown = state?.cooldowns?.[selfId]?.[ability.id] ?? 0;
            const isAiming = aimingAction?.kind === "ability" && aimingAction.ability.id === ability.id;
            const hotkey = abilityIndex < 4 ? abilityIndex + 1 : undefined;
            return (
              <CBtn
                key={ability.id}
                label={isAiming ? "Aiming…" : ability.name}
                icon={ability.icon}
                color={isAiming ? "#fb923c" : "#d946ef"}
                manaCost={ability.mana_cost > 0 ? ability.mana_cost : undefined}
                tooltip={ability.blurb}
                cooldown={cooldown}
                hotkey={hotkey}
                disabled={!myTurn || myMana < ability.mana_cost}
                onClick={() => {
                  if (isAiming) { setAimingAction(null); return; }
                  fireAbility(ability);
                }}
                onMouseEnter={() => {
                  const t = ability.target;
                  // For all_* scopes, pass the ability's aoe_radius_tiles so
                  // the preview honors the same caster-centered radius the
                  // engine enforces (e.g. Prod Fire's 3-hex burst).
                  const radiusTiles = ability.aoe_radius_tiles;
                  if (t === "all_enemies") setPreviewedKind({ scope: "all_enemies", radiusTiles });
                  else if (t === "all_allies") setPreviewedKind({ scope: "all_allies", radiusTiles });
                  else if (t === "single_enemy") setPreviewedKind({ scope: "single_enemy" });
                  else if (t === "self") setPreviewedKind({ scope: "self", actorId: selfId });
                  else if (t === "single_ally") setPreviewedKind({ scope: "all_allies", radiusTiles });
                  else setPreviewedKind(null);
                }}
                onMouseLeave={() => setPreviewedKind(null)}
              />
            );
          })}
          {/* Position swap — only meaningful in legacy front/back combat.
              In hex mode actor location IS the position, set via the move
              phase, so this button is hidden. */}
          {!state.hex_range_enabled && (
            <CBtn variant="dark" label={otherPosition === "front" ? "Front" : "Back"} icon={otherPosition === "front" ? "muscle-up" : "fall-down"} color="#6b7280" disabled={!myTurn} onClick={() => send({ kind: "position", actor: selfId, to: otherPosition })} />
          )}
          <CBtn label="Item" icon="knapsack" color="#c084fc" disabled={!myTurn || items.length === 0} onClick={() => setItemPicker("open")} />
          {items.some((i) => !i.equipped) && state.fighters.filter((f) => f.hp > 0 && f.id !== selfId).length > 0 && (
            <CBtn label="Give" icon="conversation" color="#fcd34d" disabled={!myTurn} onClick={() => setGivePicker("selectItem")} />
          )}
          {/* Divider separates the colored ability actions from the muted
              utility actions (Mark / Wait / Flee), matching the design's
              grouping in the .abar. Hidden when the row wraps (flex-basis 0). */}
          <span className="adiv" aria-hidden />
          <CBtn variant="dark" label="Mark" icon="targeted" color="#f97316" disabled={liveMonsters.length > 1 && targetMonsterId === null} onClick={() => send({ kind: "mark", actor: selfId, target_id: effectiveTarget })} />
          <CBtn variant="dark" label="Wait" icon="hourglass" color="#475569" disabled={!myTurn} onClick={() => send({ kind: "wait", actor: selfId })} />
          {/* No flee inside the Tower — commit through each cycle. The exit
              valve is the post-boss "Call it a day" prompt. */}
          {liveMonsters[0]?.tower_floor === undefined && (
            <CBtn variant="dark" label="Flee" icon="footprint" color="#9aa0a6" disabled={!myTurn} onClick={() => send({ kind: "flee", actor: selfId })} />
          )}
          {isMonsterTurn && !autoResolve && (
            <CBtn label="Resolve" icon="dragon" color="#5c1f1f" onClick={() => send({ kind: "monster_act" })} />
          )}
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--fg-faint)", cursor: "pointer", marginLeft: 6 }}>
            <input type="checkbox" checked={autoResolve} onChange={(e) => setAutoResolve(e.target.checked)} style={{ accentColor: "#5c1f1f" }} />
            Auto
          </label>
          </div>
        </div>
        );
      })()}

      {/* Victory modal — delayed until dice settle AND the server's outcome
          event arrives. The outcome broadcast fires only after the server has
          committed markQuestStatus(completed) — without this gate the Back
          button could fire onExit before the quest was marked complete in
          D1, and the dashboard's /api/quest/active refetch would return the
          just-finished quest as still active, bouncing the user back to the
          Quest screen with a "Start Combat" button. */}
      {ended && state?.status === "victory" && victoryModalReady && ui.outcome && (
        <VictoryModal
          outcome={ui.outcome}
          selfId={selfId}
          fighters={state.fighters}
          monsters={state.monsters}
          rawEvents={ui.rawEvents}
          questId={questId}
          onBack={exit}
          onContinueClimbing={continueClimbing}
          onPressOnAfterBoss={pressOnAfterBoss}
          onBankAndExit={bankAndExit}
        />
      )}

      {/* Defeat / fled modal — same gating as victory: wait for both the
          dice-settle delay and the server outcome before exposing Back. */}
      {ended && state?.status !== "victory" && defeatModalReady && ui.outcome && (
        <DefeatModal
          status={state.status as "defeat" | "fled"}
          outcome={ui.outcome}
          selfId={selfId}
          fighters={state.fighters}
          monsters={state.monsters}
          rawEvents={ui.rawEvents}
          onBack={exit}
        />
      )}

      {/* Disconnection warning — only when combat is still live AND auto-reconnect
          has exhausted its attempts. Transient drops surface as "reconnecting…" in
          the status chip instead of a blocking modal. */}
      {ui.connection === "closed" && !ended && (
        <DisconnectedModal onReconnect={() => {
          reconnectAttemptsRef.current = 0;
          setReconnectKey((k) => k + 1);
        }} />
      )}
      {/* Full character sheet — opened by clicking the docked pawn card. */}
      {sheetSubject && (
        <CharacterSheetModal subject={sheetSubject} onClose={() => setSheetSubject(null)} />
      )}
    </div>
    </CombatParticlesProvider>
  );
}

function DisconnectedModal({ onReconnect }: { onReconnect: () => void }): JSX.Element {
  return (
    <div style={{
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.75)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 900,
    }}>
      <div style={{
        background: "#1a1d23",
        border: "1px solid #ef4444",
        borderRadius: 12,
        padding: "32px 40px",
        textAlign: "center",
        maxWidth: 360,
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}>
        <span style={{ fontSize: 36 }}>⚡</span>
        <div style={{ color: "#f1f5f9", fontSize: 18, fontWeight: 700, fontFamily: DISPLAY_FONT }}>Connection Lost</div>
        <div style={{ color: "#94a3b8", fontSize: 14 }}>
          Your combat connection dropped. The battle is still going — reconnect to rejoin.
        </div>
        <button
          onClick={onReconnect}
          style={{
            marginTop: 4,
            padding: "10px 24px",
            background: "#2563eb",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            fontWeight: 700,
            fontSize: 15,
            cursor: "pointer",
          }}
        >
          Reconnect
        </button>
      </div>
    </div>
  );
}

// Spotlight monster — the cinematic centerpiece of the theatre. Per design,
// this is a 184px circular portrait inside a 280px rotating dashed gold/red
// ring, with a crown pill above ("★ BOSS Tier N" red or "◎ Focused Target"
// gold). Name in 34px display below the ring, element/tier subtitle, big HP
// number + bar, then status pills. Preserves every animation and ability
// indicator from MonsterCard.
function SpotlightMonster({
  monster,
  round,
  showSageReading,
  sageTarget,
  markedBy,
  isTargeted = false,
  smiteDebuffed = false,
  discouraged = 0,
  vulnerable,
  taunt,
  illOmen,
  slashSeq = 0,
  lungeSeq = 0,
  dustSeq = 0,
  compact = false,
  onClick,
}: {
  monster: Monster;
  round: number;
  showSageReading: boolean;
  sageTarget?: string | null;
  markedBy?: string;
  isTargeted?: boolean;
  smiteDebuffed?: boolean;
  discouraged?: number;
  vulnerable?: { expires_after_round: number; magnitude: number };
  taunt?: { actor_name: string; swings: number };
  illOmen?: { accumulated: number; monster_turns_remaining: number };
  slashSeq?: number;
  lungeSeq?: number;
  dustSeq?: number;
  /** Mobile: smaller ring + portrait + spacing. */
  compact?: boolean;
  onClick?: () => void;
}) {
  const isDead = monster.hp <= 0;
  // Defeat clock — same pattern as MonsterCard so the rotateX animation
  // plays for ~1.1s before the component unmounts.
  const [defeatedAt, setDefeatedAt] = useState<number | null>(null);
  useEffect(() => {
    if (monster.hp <= 0 && defeatedAt === null) setDefeatedAt(Date.now());
    else if (monster.hp > 0 && defeatedAt !== null) setDefeatedAt(null);
  }, [monster.hp, defeatedAt]);
  useEffect(() => {
    if (defeatedAt === null) return;
    const t = setTimeout(() => setDefeatedAt((v) => v), 1150);
    return () => clearTimeout(t);
  }, [defeatedAt]);
  if (defeatedAt !== null && Date.now() > defeatedAt + 1100) return null;

  const animClass = !isDead
    ? "gq-monster-lunge-card"
    : "gq-monster-defeated-card";

  // Sage's reading bounds — identical to MonsterCard.
  const sageLo = 1 + monster.tier;
  const sageHi = 6 + monster.tier + (monster.is_boss && monster.boss_phase === 2 ? monster.tier : 0);

  const ringPx = compact ? 170 : 280;
  const portraitPx = compact ? 112 : 184;
  // Portrait border priority: targeted (gold), then marked (orange-gold),
  // then boss (red), then default muted edge for non-boss non-target.
  const portraitBorder = isDead
    ? "var(--border-base)"
    : isTargeted
      ? "var(--accent-gold-warm)"
      : markedBy
        ? "#f59e0b"
        : monster.is_boss
          ? "var(--tone-bad-3)"
          : "var(--border-muted)";
  // Ring color: red for boss, gold otherwise.
  const ringColor = monster.is_boss
    ? "rgba(220,38,38,0.42)"
    : "rgba(251,191,36,0.4)";
  const ringGlow = monster.is_boss
    ? "0 0 22px rgba(220,38,38,0.4)"
    : "0 0 22px rgba(251,191,36,0.55), inset 0 0 12px 0 rgba(251,191,36,0.15)";

  // Crown pill above the ring.
  const crownLabel = monster.is_boss
    ? `★ Boss · Tier ${monster.tier}`
    : "◎ Focused Target";
  const crownColor = monster.is_boss ? "var(--tone-bad-2)" : "var(--accent-gold-warm)";
  const crownBorder = monster.is_boss ? "var(--tone-bad-3)" : "var(--accent-gold-warm)";

  const hp = Math.max(0, monster.hp);
  const hpPct = monster.max_hp > 0 ? hp / monster.max_hp : 0;
  const hpColor = hpPct < 0.25
    ? "var(--tone-bad-2)"
    : hpPct < 0.5
      ? "var(--accent-gold-warm)"
      : "var(--tone-good-2)";

  return (
    <div
      key={`spotlight-${monster.id ?? ""}-${isDead ? "dead" : lungeSeq}`}
      className={animClass}
      style={{
        position: "relative",
        textAlign: "center",
        cursor: onClick && !isDead ? "pointer" : undefined,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 0,
        width: "100%",
        minWidth: 0,
      }}
      onClick={!isDead && onClick ? onClick : undefined}
    >
      {/* Marked-by ribbon above the ring (e.g. Mark ability) */}
      {markedBy && !isDead && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            background: "#78350f",
            border: "2px solid #f59e0b",
            borderRadius: 12,
            padding: "2px 10px",
            marginBottom: 4,
            boxShadow: "0 0 12px #f59e0b80",
            zIndex: 10,
          }}
        >
          <Icon name="targeted" size={14} color="#fbbf24" />
          <span style={{ fontSize: 11, fontWeight: 700, color: "#fbbf24", whiteSpace: "nowrap" }}>{markedBy}</span>
        </div>
      )}

      {/* Ring + portrait. The rotating dashed ring is a positioned overlay
          on top of the portrait so the spin animation doesn't fight the
          lunge/hit-flash animations applied to the outer wrapper. */}
      <div
        style={{
          width: ringPx,
          height: ringPx,
          position: "relative",
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "radial-gradient(circle at 50% 40%, rgba(239,68,68,0.08), transparent 70%)",
        }}
      >
        {/* Rotating dashed ring (decorative; pointer-events: none) */}
        {!isDead && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: compact ? 12 : 16,
              borderRadius: "50%",
              border: `1px dashed ${ringColor}`,
              boxShadow: ringGlow,
              animation: "spin 26s linear infinite",
              pointerEvents: "none",
            }}
          />
        )}
        {/* Crown pill above the ring */}
        <div
          style={{
            position: "absolute",
            top: -4,
            left: "50%",
            transform: "translateX(-50%)",
            font: "700 10px/1 var(--font-body)",
            letterSpacing: 1.5,
            textTransform: "uppercase",
            color: crownColor,
            background: "var(--bg-void)",
            border: `1px solid ${crownBorder}`,
            padding: "4px 10px",
            borderRadius: 999,
            whiteSpace: "nowrap",
            zIndex: 3,
          }}
        >
          {crownLabel}
        </div>
        {/* Target pulse overlay — separate so it doesn't fight the lunge anim */}
        {isTargeted && !isDead && (
          <div
            className="gq-monster-targeted"
            style={{
              position: "absolute",
              width: portraitPx,
              height: portraitPx,
              borderRadius: "50%",
              pointerEvents: "none",
            }}
          />
        )}
        {/* Slash streak re-mounts when slashSeq bumps */}
        {slashSeq > 0 && !isDead && (
          <div aria-hidden style={{ position: "absolute", width: portraitPx, height: portraitPx, overflow: "hidden", borderRadius: "50%", pointerEvents: "none" }}>
            <span key={`slash-${slashSeq}`} className="gq-slash-streak" />
          </div>
        )}
        {/* Dust puffs anchor on the wrapper. */}
        <HitDust seq={dustSeq} />
        {/* Portrait circle */}
        <Avatar
          src={monster.art_url}
          alt={monster.name}
          size={portraitPx}
          radius={portraitPx}
          fallbackIcon="dragon"
          fallbackColor={markedBy ? "#f59e0b" : "var(--tone-bad-2)"}
          border={`2px solid ${portraitBorder}`}
        />
      </div>

      {/* Name */}
      <h1
        style={{
          font: `${compact ? 18 : 34}px/1 var(--font-display)`,
          color: "var(--fg-1)",
          margin: `${compact ? 6 : 16}px 0 4px`,
        }}
      >
        {monster.name}
      </h1>

      {/* Element · Tier subtitle */}
      <div style={{
        font: "11px/1 var(--font-mono)",
        color: "var(--fg-mute)",
        textTransform: "uppercase",
        letterSpacing: 1,
        display: "flex",
        alignItems: "center",
        gap: 6,
        flexWrap: "wrap",
        justifyContent: "center",
      }}>
        {monster.tower_floor !== undefined && (
          <>
            <Icon name="tower-flag" size={11} color="var(--accent-gold)" />
            <span style={{ color: "var(--accent-gold)", fontWeight: 600 }}>
              Floor {monster.tower_floor}
              {monster.tower_cycle ? ` · Cycle ${monster.tower_cycle}` : ""}
            </span>
            <span>·</span>
          </>
        )}
        <span>Tier {monster.tier}</span>
        {monster.is_boss && <span>· Boss (phase {monster.boss_phase})</span>}
        {monster.wave && monster.total_waves && (
          <span>· Wave {monster.wave}/{monster.total_waves}</span>
        )}
        <span>· Round {round}</span>
      </div>

      {/* Element attack-type / weakness / resistance chips */}
      {((monster.attack_damage_type && monster.attack_damage_type !== "physical") || monster.element_weakness || monster.element_resistance) && !isDead && (
        <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap", justifyContent: "center" }}>
          {monster.attack_damage_type && monster.attack_damage_type !== "physical" && (() => {
            const t = monster.attack_damage_type;
            const icon = t === "fire" ? "🔥" : t === "ice" ? "❄️" : t === "lightning" ? "⚡" : "✨";
            const color = t === "fire" ? "#fb923c" : t === "ice" ? "#7dd3fc" : t === "lightning" ? "#fde047" : "#c084fc";
            return (
              <span
                title={`Attacks deal ${t} damage — bypasses armor pool`}
                style={{
                  fontSize: 10, fontWeight: 700, background: color + "22",
                  border: `1px solid ${color}55`, color, borderRadius: 4,
                  padding: "1px 5px", textTransform: "uppercase", letterSpacing: 0.4,
                }}
              >
                {icon} {t} attacks
              </span>
            );
          })()}
          {monster.element_weakness && (
            <span style={{ fontSize: 10, background: "#7f1d1d22", border: "1px solid #f8717144", color: "#fca5a5", borderRadius: 4, padding: "1px 5px" }}>
              {monster.element_weakness === "fire" ? "🔥" : monster.element_weakness === "ice" ? "❄️" : "⚡"} weak
            </span>
          )}
          {monster.element_resistance && (
            <span style={{ fontSize: 10, background: "#1e3a5f22", border: "1px solid #60a5fa44", color: "#93c5fd", borderRadius: 4, padding: "1px 5px" }}>
              {monster.element_resistance === "fire" ? "🔥" : monster.element_resistance === "ice" ? "❄️" : "⚡"} resist
            </span>
          )}
        </div>
      )}

      {/* HP line — number + bar */}
      <div
        style={{
          margin: `${compact ? 6 : 14}px auto 0`,
          width: compact ? "min(280px, 100%)" : 340,
          maxWidth: "100%",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <span style={{
          font: `${compact ? 20 : 24}px/1 var(--font-display)`,
          color: hpColor,
          whiteSpace: "nowrap",
          fontVariantNumeric: "tabular-nums",
        }}>
          {hp}
          <span style={{ fontSize: 13, color: "var(--fg-mute)" }}>/{monster.max_hp}</span>
        </span>
        <BigHpBar current={hp} max={monster.max_hp} />
      </div>

      {/* Status pills row */}
      {((monster.effects && monster.effects.length > 0) || smiteDebuffed || discouraged > 0 || (vulnerable && round <= vulnerable.expires_after_round) || (illOmen && illOmen.monster_turns_remaining > 0) || !!taunt) && !isDead && (
        <div style={{
          display: "flex", gap: 6,
          justifyContent: "center", flexWrap: "wrap",
          marginTop: 12, minHeight: 22,
          width: "100%", boxSizing: "border-box",
          padding: "0 8px",
        }}>
          {monster.effects?.map((e, i) => {
            const def = EFFECT_PILLS[e.type];
            return def ? <def.pill key={i} effect={e} size="lg" /> : null;
          })}
          {taunt && (
            <StatusPill size="lg" color="#f59e0b" icon="shield-reflect" label="taunted" suffix={`${taunt.swings}sw`} title={`Taunted: forced to attack ${taunt.actor_name} for ${taunt.swings} more swing${taunt.swings === 1 ? "" : "s"}`} />
          )}
          {smiteDebuffed && (
            <StatusPill size="lg" color="#f87171" icon="axe-swing" label="breakpoint" suffix="½ dmg" title="Breakpoint: this monster deals 50% less damage on its next swing" />
          )}
          {discouraged > 0 && (
            <StatusPill size="lg" color="#f87171" icon="morbid-humour" label="mocked" suffix={`${discouraged}c`} title={`Mocked: disadvantage on next ${discouraged} roll${discouraged === 1 ? "" : "s"}`} />
          )}
          {vulnerable && round <= vulnerable.expires_after_round && (
            <StatusPill size="lg" color="#fb923c" icon="crossed-swords" label="vulnerable" suffix={`+${vulnerable.magnitude}%`} title={`Vulnerable: takes ${vulnerable.magnitude}% more damage (${vulnerable.expires_after_round - round + 1} round${vulnerable.expires_after_round - round + 1 === 1 ? "" : "s"} left)`} />
          )}
          {illOmen && illOmen.monster_turns_remaining > 0 && (
            <StatusPill size="lg" color="#c084fc" icon="death-skull" label="stack overflow" suffix={`${illOmen.monster_turns_remaining}t`} title={`Stack Overflow: ${illOmen.accumulated} damage accumulated — bursts in ${illOmen.monster_turns_remaining} monster turn${illOmen.monster_turns_remaining === 1 ? "" : "s"}`} />
          )}
        </div>
      )}

      {showSageReading && !isDead && (
        <div style={{ ...muted, fontSize: 11, marginTop: 8 }}>
          <Icon name="scroll-unfurled" /> Sage's Reading: next swing ~{sageLo}–{sageHi} HP
          {sageTarget ? <> → <span style={{ color: "#e2e8f0" }}>{sageTarget}</span></> : ""}
        </div>
      )}
    </div>
  );
}

function MonsterCard({
  monster,
  round,
  showSageReading,
  sageTarget,
  markedBy,
  isTargeted = false,
  smiteDebuffed = false,
  discouraged = 0,
  vulnerable,
  taunt,
  illOmen,
  slashSeq = 0,
  lungeSeq = 0,
  dustSeq = 0,
  onClick,
}: {
  monster: Monster;
  round: number;
  showSageReading: boolean;
  sageTarget?: string | null;
  markedBy?: string;
  isTargeted?: boolean;
  smiteDebuffed?: boolean;
  discouraged?: number;
  vulnerable?: { expires_after_round: number; magnitude: number };
  taunt?: { actor_name: string; swings: number };
  illOmen?: { accumulated: number; monster_turns_remaining: number };
  slashSeq?: number;
  lungeSeq?: number;
  dustSeq?: number;
  onClick?: () => void;
}) {
  const isDead = monster.hp <= 0;
  // Card-local defeat clock.
  const [defeatedAt, setDefeatedAt] = useState<number | null>(null);
  useEffect(() => {
    if (monster.hp <= 0 && defeatedAt === null) setDefeatedAt(Date.now());
    else if (monster.hp > 0 && defeatedAt !== null) setDefeatedAt(null);
  }, [monster.hp, defeatedAt]);
  useEffect(() => {
    if (defeatedAt === null) return;
    const t = setTimeout(() => setDefeatedAt((v) => v), 1150);
    return () => clearTimeout(t);
  }, [defeatedAt]);
  if (defeatedAt !== null && Date.now() > defeatedAt + 1100) return null;

  const classes = [
    !isDead ? "gq-monster-lunge-card" : "gq-monster-defeated-card",
  ].filter(Boolean).join(" ");

  const sageLo = 1 + monster.tier;
  const sageHi = 6 + monster.tier + (monster.is_boss && monster.boss_phase === 2 ? monster.tier : 0);
  const borderColor = isDead ? "#2a2d33" : isTargeted ? "#fbbf24" : markedBy ? "#f59e0b" : "#7c2020";
  return (
    <div
      key={`mc-${monster.id ?? ""}-${isDead ? "dead" : lungeSeq}`}
      className={classes}
      style={{ ...card, padding: 12, borderColor, display: "flex", gap: 10, alignItems: "flex-start", position: "relative", cursor: onClick && !isDead ? "pointer" : undefined, transition: "border-color 0.15s" }}
      onClick={!isDead && onClick ? onClick : undefined}
    >
      {/* Target pulse on its own overlay so it never fights the lunge animation */}
      {isTargeted && !isDead && (
        <div className="gq-monster-targeted" style={{ position: "absolute", inset: 0, borderRadius: 8, pointerEvents: "none" }} />
      )}
      {/* Slash streak re-mounts when slashSeq bumps */}
      {slashSeq > 0 && !isDead && (
        <div aria-hidden style={{ position: "absolute", inset: 0, overflow: "hidden", borderRadius: 8, pointerEvents: "none" }}>
          <span key={`slash-${slashSeq}`} className="gq-slash-streak" />
        </div>
      )}
      {/* Dust puff on every landed hit. Same component as the fighter
          cards — re-keys its WAAPI animations whenever dustSeq bumps. */}
      <HitDust seq={dustSeq} />
      {markedBy && !isDead && (
        <div style={{ position: "absolute", top: -12, right: -8, display: "flex", alignItems: "center", gap: 4, background: "#78350f", border: "2px solid #f59e0b", borderRadius: 12, padding: "2px 8px", zIndex: 10, boxShadow: "0 0 12px #f59e0b80" }}>
          <Icon name="targeted" size={14} color="#fbbf24" />
          <span style={{ fontSize: 11, fontWeight: 700, color: "#fbbf24", whiteSpace: "nowrap" }}>{markedBy}</span>
        </div>
      )}
      <Avatar
        src={monster.art_url}
        alt={monster.name}
        size={72}
        radius={8}
        fallbackIcon="dragon"
        fallbackColor={markedBy ? "#f59e0b" : "#7c2020"}
        border={`1px solid ${borderColor}`}
        style={{ flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#f5f5f5", fontFamily: DISPLAY_FONT }}>{monster.name}</div>
            <div style={{ ...muted, fontSize: 12, display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
              {monster.tower_floor !== undefined && (
                <>
                  <Icon name="tower-flag" size={12} color="#fbbf24" />
                  <span style={{ color: "#fbbf24", fontWeight: 600 }}>
                    Floor {monster.tower_floor}
                    {monster.tower_cycle ? ` · Cycle ${monster.tower_cycle}` : ""}
                  </span>
                  <span>·</span>
                </>
              )}
              <span>Tier {monster.tier}</span>
              {monster.is_boss && <span>· Boss (phase {monster.boss_phase})</span>}
              {monster.wave && monster.total_waves && <span>· Wave {monster.wave}/{monster.total_waves}</span>}
              <span>· Round {round}</span>
            </div>
            {((monster.attack_damage_type && monster.attack_damage_type !== "physical") || monster.element_weakness || monster.element_resistance) && !isDead && (
              <div style={{ display: "flex", gap: 6, marginTop: 3, flexWrap: "wrap" }}>
                {monster.attack_damage_type && monster.attack_damage_type !== "physical" && (() => {
                  const t = monster.attack_damage_type;
                  const icon = t === "fire" ? "🔥" : t === "ice" ? "❄️" : t === "lightning" ? "⚡" : "✨";
                  const color = t === "fire" ? "#fb923c" : t === "ice" ? "#7dd3fc" : t === "lightning" ? "#fde047" : "#c084fc";
                  return (
                    <span
                      title={`Attacks deal ${t} damage — bypasses armor pool`}
                      style={{
                        fontSize: 10, fontWeight: 700, background: color + "22",
                        border: `1px solid ${color}55`, color, borderRadius: 4,
                        padding: "1px 5px", textTransform: "uppercase", letterSpacing: 0.4,
                      }}
                    >
                      {icon} {t} attacks
                    </span>
                  );
                })()}
                {monster.element_weakness && (
                  <span style={{ fontSize: 10, background: "#7f1d1d22", border: "1px solid #f8717144", color: "#fca5a5", borderRadius: 4, padding: "1px 5px" }}>
                    {monster.element_weakness === "fire" ? "🔥" : monster.element_weakness === "ice" ? "❄️" : "⚡"} weak
                  </span>
                )}
                {monster.element_resistance && (
                  <span style={{ fontSize: 10, background: "#1e3a5f22", border: "1px solid #60a5fa44", color: "#93c5fd", borderRadius: 4, padding: "1px 5px" }}>
                    {monster.element_resistance === "fire" ? "🔥" : monster.element_resistance === "ice" ? "❄️" : "⚡"} resist
                  </span>
                )}
              </div>
            )}
          </div>
          <div style={{ ...muted, fontVariantNumeric: "tabular-nums" }}>
            {Math.max(0, monster.hp)} / {monster.max_hp}
          </div>
        </div>
        <BigHpBar current={Math.max(0, monster.hp)} max={monster.max_hp} />
        {((monster.effects && monster.effects.length > 0) || smiteDebuffed || discouraged > 0 || (vulnerable && round <= vulnerable.expires_after_round) || (illOmen && illOmen.monster_turns_remaining > 0) || !!taunt) && !isDead && (
          <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
            {monster.effects?.map((e, i) => {
              const def = EFFECT_PILLS[e.type];
              return def ? <def.pill key={i} effect={e} size="lg" /> : null;
            })}
            {taunt && (
              <StatusPill size="lg" color="#f59e0b" icon="shield-reflect" label="taunted" suffix={`${taunt.swings}sw`} title={`Taunted: forced to attack ${taunt.actor_name} for ${taunt.swings} more swing${taunt.swings === 1 ? "" : "s"}`} />
            )}
            {smiteDebuffed && (
              <StatusPill size="lg" color="#f87171" icon="axe-swing" label="breakpoint" suffix="½ dmg" title="Breakpoint: this monster deals 50% less damage on its next swing" />
            )}
            {discouraged > 0 && (
              <StatusPill size="lg" color="#f87171" icon="morbid-humour" label="mocked" suffix={`${discouraged}c`} title={`Mocked: disadvantage on next ${discouraged} roll${discouraged === 1 ? "" : "s"}`} />
            )}
            {vulnerable && round <= vulnerable.expires_after_round && (
              <StatusPill size="lg" color="#fb923c" icon="crossed-swords" label="vulnerable" suffix={`+${vulnerable.magnitude}%`} title={`Vulnerable: takes ${vulnerable.magnitude}% more damage (${vulnerable.expires_after_round - round + 1} round${vulnerable.expires_after_round - round + 1 === 1 ? "" : "s"} left)`} />
            )}
            {illOmen && illOmen.monster_turns_remaining > 0 && (
              <StatusPill size="lg" color="#c084fc" icon="death-skull" label="stack overflow" suffix={`${illOmen.monster_turns_remaining}t`} title={`Stack Overflow: ${illOmen.accumulated} damage accumulated — bursts in ${illOmen.monster_turns_remaining} monster turn${illOmen.monster_turns_remaining === 1 ? "" : "s"}`} />
            )}
          </div>
        )}
        {showSageReading && !isDead && (
          <div style={{ ...muted, fontSize: 11, marginTop: 6 }}>
            <Icon name="scroll-unfurled" /> Sage's Reading: next swing ~{sageLo}–{sageHi} HP{sageTarget ? <> → <span style={{ color: "#e2e8f0" }}>{sageTarget}</span></> : ""}
          </div>
        )}
      </div>
    </div>
  );
}

function InitiativeTrack({
  order,
  currentIndex,
  fighters,
  monsters,
  selfId,
}: {
  order: string[];
  currentIndex: number;
  fighters: Fighter[];
  monsters: Monster[];
  selfId: string;
}) {
  return (
    <div style={card}>
      <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 10 }}>
        Initiative
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
        {order.map((id, i) => {
          const isMon = isMonsterActor(id);
          const monster = isMon ? (monsters.find((m) => m.id === id) ?? monsters[0]) : null;
          const fighter = isMon ? null : fighters.find((f) => f.id === id);
          const name = isMon ? (monster?.name ?? "Monster") : fighter?.name ?? id;
          const init = isMon ? (monster?.initiative ?? 0) : fighter?.initiative ?? 0;
          const isCurrent = i === currentIndex;
          const isSelf = id === selfId;
          const portrait = isMon
            ? (monster?.art_url ?? null)
            : fighter ? charPortraitUrl(fighter.name) : null;
          const portraitFallback = isMon ? null : classPortraitUrl(fighter?.class ?? "");
          const borderColor = isCurrent ? "#b89b3a" : isSelf ? "#3a7bd5" : "#2a2d33";
          const AVATAR = 72;
          const RADIUS = 10;
          return (
            <div key={id} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, width: AVATAR + 8 }}>
              {/* avatar card */}
              <div style={{
                width: AVATAR + 4,
                height: AVATAR + 4,
                borderRadius: RADIUS + 2,
                border: `2px solid ${borderColor}`,
                boxShadow: isCurrent ? `0 0 12px ${borderColor}90, 0 0 4px ${borderColor}40` : "none",
                background: isCurrent ? `${borderColor}18` : "#0e0f12",
                overflow: "hidden",
                transition: "box-shadow 300ms, border-color 300ms",
                flexShrink: 0,
              }}>
                <Avatar
                  src={portrait}
                  fallbackSrc={portraitFallback}
                  alt={name}
                  size={AVATAR}
                  radius={RADIUS}
                  fallbackIcon={isMon ? "dragon" : "player"}
                  fallbackColor={isMon ? (isCurrent ? "#ef4444" : "#7a3030") : "#4a5568"}
                  style={{
                    background: isMon ? (isCurrent ? "#3a0a0a" : "#1a0808") : "#1d1f23",
                    border: "none",
                  }}
                />
              </div>
              {/* name + init */}
              <div style={{ textAlign: "center" }}>
                <div style={{
                  fontSize: 11, fontWeight: isCurrent ? 700 : 500,
                  color: isCurrent ? "#f5f5f5" : "#9aa0a6",
                  fontFamily: DISPLAY_FONT,
                  maxWidth: AVATAR + 8,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {isMon ? name.split(" ")[0] : (isSelf ? "You" : name.split(" ")[0])}
                </div>
                <div style={{
                  fontSize: 13, fontWeight: 700,
                  color: isCurrent ? "#b89b3a" : "#6b7280",
                  marginTop: 1,
                }}>
                  {init}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PartySection({
  fighters,
  currentActorId,
  selfId,
}: {
  fighters: Fighter[];
  currentActorId: string | null;
  selfId: string;
}) {
  const front = fighters.filter((f) => f.position === "front");
  const back = fighters.filter((f) => f.position === "back");
  const rowLabel: React.CSSProperties = {
    ...muted, fontSize: 10, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 6,
  };
  return (
    <div style={card}>
      <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 10 }}>
        Party
      </div>
      {front.length > 0 && (
        <div style={{ marginBottom: back.length > 0 ? 12 : 0 }}>
          <div style={rowLabel}>⚔️ Front row</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
            {front.map((f) => (
              <FighterRow key={f.id} fighter={f} self={f.id === selfId} current={f.id === currentActorId} />
            ))}
          </div>
        </div>
      )}
      {back.length > 0 && (
        <div>
          <div style={rowLabel}>🛡️ Back row</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
            {back.map((f) => (
              <FighterRow key={f.id} fighter={f} self={f.id === selfId} current={f.id === currentActorId} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Inject shield-particle keyframes once per page load.
function FighterHpRow({ hp, maxHp, shield, armorPower }: { hp: number; maxHp: number; shield: number; armorPower: number }) {
  const armorMax = Math.floor(armorPower / 2);
  const total = maxHp + armorMax;
  const hpFrac = maxHp > 0 ? hp / maxHp : 0;
  const hpCol = hpFrac < 0.25 ? "#dc2626" : hpFrac < 0.5 ? "#d97706" : "#16a34a";
  // HP occupies left (maxHp/total) of bar; shield occupies right (armorMax/total), anchored at the boundary.
  const hpWidth = total > 0 ? (hp / total) * 100 : 0;
  const shieldStart = total > 0 ? (maxHp / total) * 100 : 100;
  const shieldWidth = total > 0 ? (shield / total) * 100 : 0;
  const hasShield = armorMax > 0 && shield > 0;
  return (
    <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
      <div
        className="bar"
        style={{
          flex: 1,
          boxShadow: hasShield ? "0 0 5px rgba(96,165,250,.45)" : "none",
        }}
      >
        <i style={{ width: `${hpWidth}%`, background: hpCol }} />
        {armorMax > 0 && shield > 0 && (
          <i style={{
            left: `${shieldStart}%`,
            width: `${shieldWidth}%`,
            background: "repeating-linear-gradient(45deg,#93c5fd,#93c5fd 4px,#60a5fa 4px,#60a5fa 8px)",
          }} />
        )}
      </div>
      <div style={{ ...muted, fontSize: 11, minWidth: 48, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {hp}/{maxHp}
        {armorMax > 0 && <div style={{ fontSize: 10, color: shield === 0 ? "#ef4444" : "#7dd3fc", display: "flex", alignItems: "center", gap: 2 }}><Icon name="shield" size={9} color={shield === 0 ? "#ef4444" : "#7dd3fc"} />{shield}/{armorMax}</div>}
      </div>
    </div>
  );
}

function FighterRow({ fighter, self, current }: { fighter: Fighter; self: boolean; current: boolean }) {
  const down = fighter.hp <= 0;
  const portrait = charPortraitUrl(fighter.name);
  return (
    <div
      style={{
        position: "relative",
        padding: 12,
        background: "#1d1f23",
        borderRadius: 8,
        border: current ? "1px solid #b89b3a" : self ? "1px solid #3a7bd5" : fighter.shield > 0 ? "1px solid rgba(96,165,250,0.4)" : "1px solid transparent",
        opacity: down ? 0.5 : 1,
        display: "flex",
        gap: 12,
        alignItems: "stretch",
        animation: fighter.shield > 0 && !down ? "gq-shield-pulse 2.5s ease-in-out infinite" : undefined,
      }}
    >
      {fighter.shield > 0 && !down && <ShieldGlow />}
      <Avatar
        src={portrait}
        fallbackSrc={classPortraitUrl(fighter.class)}
        alt={`${fighter.class} portrait`}
        size={56}
        radius={6}
        fallbackIcon="player"
        fallbackColor="#6a7080"
        style={{ alignSelf: "center" }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 14, fontFamily: DISPLAY_FONT }}>{fighter.name}</span>
          {fighter.slack_username && (
            <span style={{ fontSize: 12, color: "#7dd3fc" }}>@{fighter.slack_username}</span>
          )}
          <span style={{ ...muted, fontSize: 12 }}>
            {fighter.class} · <span title={(fighter.scars?.length ?? 0) > 0 ? fighter.scars.join(", ") : undefined}>Lv {fighter.level}</span>
          </span>
          <span style={badge(
            fighter.position === "front" ? "#2a1f3a" : "#1a2a1a",
            fighter.position === "front" ? "#c084fc" : "#86efac",
            fighter.position === "front" ? "#4a2f6a" : "#2a5a2a",
          )}>
            {fighter.position}
          </span>
          {self && (
            <span style={badge("#1f2a3a", "#7dd3fc", "#2a3a5a")}>you</span>
          )}
          {down && (
            <span style={badge("#3a1f1f", "#ff7676", "#5a2a2a")}>downed</span>
          )}
        </div>
        {fighter.effects && fighter.effects.length > 0 && (
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 4, marginTop: 4 }}>
            {fighter.effects.map((e, i) => {
              const def = EFFECT_PILLS[e.type];
              return def ? <def.pill key={i} effect={e} size="md" /> : null;
            })}
          </div>
        )}
        {/* HP bar row — matches mana bar layout so numbers stay column-aligned */}
        <FighterHpRow hp={fighter.hp} maxHp={fighter.max_hp} shield={fighter.shield} armorPower={fighter.armor_power} />
        {fighter.max_mana > 0 && (
          <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
            <div
              style={{
                flex: 1,
                height: 4,
                background: "#0e0f12",
                borderRadius: 2,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${(fighter.mana / Math.max(1, fighter.max_mana)) * 100}%`,
                  height: "100%",
                  background: "#6366f1",
                }}
              />
            </div>
            <div style={{ ...muted, fontSize: 11, minWidth: 48, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
              {fighter.mana}/{fighter.max_mana}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MigratePicker({
  fighters,
  selfId,
  onPick,
  onCancel,
}: {
  fighters: Fighter[];
  selfId: string;
  onPick: (targetId: string, position: "front" | "back") => void;
  onCancel: () => void;
}) {
  const [targetId, setTargetId] = useState<string>(selfId);
  const [position, setPosition] = useState<"front" | "back">("front");
  const target = fighters.find((f) => f.id === targetId);
  const alreadyThere = target?.position === position;
  const btnBase: React.CSSProperties = {
    padding: "8px 14px", background: "#1a1c21", border: "1px solid #2a2d33",
    borderRadius: 6, color: "#f5f5f5", cursor: "pointer", fontSize: 13, fontFamily: "inherit",
  };
  return (
    <PickerModal title={<><Icon name="grass" /> Migrate — who and where?</>} onClose={onCancel}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
        {fighters.filter((f) => f.hp > 0).map((f) => (
          <button key={f.id} onClick={() => setTargetId(f.id)}
            style={{ ...btnBase, background: targetId === f.id ? "#2a5a3a" : "#1a1c21", border: `1px solid ${targetId === f.id ? "#166534" : "#2a2d33"}` }}>
            {f.name} · {f.position}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        <button onClick={() => setPosition("front")}
          style={{ ...btnBase, background: position === "front" ? "#2a5a3a" : "#1a1c21", border: `1px solid ${position === "front" ? "#166534" : "#2a2d33"}` }}>
          <Icon name="muscle-up" /> Front
        </button>
        <button onClick={() => setPosition("back")}
          style={{ ...btnBase, background: position === "back" ? "#2a5a3a" : "#1a1c21", border: `1px solid ${position === "back" ? "#166534" : "#2a2d33"}` }}>
          <Icon name="fall-down" /> Back
        </button>
      </div>
      {alreadyThere && (
        <div style={{ fontSize: 12, color: "#9aa0a6", marginBottom: 8 }}>Already in {position} row.</div>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={() => onPick(targetId, position)} disabled={alreadyThere}
          style={{ ...btnBase, background: alreadyThere ? "#1a1c21" : "#166534", opacity: alreadyThere ? 0.5 : 1, color: "#86efac" }}>
          Migrate
        </button>
        <button onClick={onCancel} style={{ ...btnBase }}>Cancel</button>
      </div>
    </PickerModal>
  );
}

function AllyPicker({
  fighters,
  ability,
  onPick,
  onCancel,
}: {
  fighters: Fighter[];
  ability: ActiveAbilityDef;
  onPick: (targetId: string) => void;
  onCancel: () => void;
}) {
  const btnBase: React.CSSProperties = {
    padding: "8px 14px", background: "#1a1c21", border: "1px solid #2a2d33",
    borderRadius: 6, color: "#f5f5f5", cursor: "pointer", fontSize: 13, fontFamily: "inherit",
  };
  const alive = fighters.filter((f) => f.hp > 0);
  return (
    <PickerModal title={<><Icon name={ability.icon} /> {ability.name} — pick an ally</>} onClose={onCancel}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
        {alive.map((f) => (
          <button key={f.id} onClick={() => onPick(f.id)} style={{ ...btnBase, borderColor: "#a855f7" }}>
            {f.name} · {f.hp}/{f.max_hp} HP
          </button>
        ))}
      </div>
      <button onClick={onCancel} style={{ ...btnBase }}>Cancel</button>
    </PickerModal>
  );
}

function AnyTargetPicker({
  fighters,
  monsters,
  ability,
  onPick,
  onCancel,
}: {
  fighters: Fighter[];
  monsters: Monster[];
  ability: ActiveAbilityDef;
  onPick: (pick: { kind: "monster"; id: string } | { kind: "fighter"; id: string }) => void;
  onCancel: () => void;
}) {
  const btnBase: React.CSSProperties = {
    padding: "8px 14px", background: "#1a1c21", border: "1px solid #2a2d33",
    borderRadius: 6, color: "#f5f5f5", cursor: "pointer", fontSize: 13, fontFamily: "inherit",
  };
  const aliveFighters = fighters.filter((f) => f.hp > 0);
  const aliveMonsters = monsters.filter((m) => m.hp > 0);
  return (
    <PickerModal title={<><Icon name={ability.icon} /> {ability.name} — pick a target</>} onClose={onCancel}>
      {aliveFighters.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: "#a78bfa", fontWeight: 600, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Allies</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
            {aliveFighters.map((f) => (
              <button key={f.id} onClick={() => onPick({ kind: "fighter", id: f.id })}
                style={{ ...btnBase, borderColor: "#a855f7" }}>
                {f.name} · {f.hp}/{f.max_hp} HP
              </button>
            ))}
          </div>
        </>
      )}
      {aliveMonsters.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: "#f87171", fontWeight: 600, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Enemies</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
            {aliveMonsters.map((m) => (
              <button key={m.id} onClick={() => onPick({ kind: "monster", id: m.id ?? "" })}
                style={{ ...btnBase, borderColor: "#f87171" }}>
                {m.name} · {m.hp}/{m.max_hp} HP
              </button>
            ))}
          </div>
        </>
      )}
      <button onClick={onCancel} style={{ ...btnBase }}>Cancel</button>
    </PickerModal>
  );
}

function ActionBtn({
  label,
  hint,
  disabled,
  onClick,
}: {
  label: React.ReactNode;
  hint: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...button,
        flex: "1 1 140px",
        marginTop: 0,
        background: disabled ? "#2a2d33" : "#3a7bd5",
        color: disabled ? "#6a7080" : "#fff",
        cursor: disabled ? "not-allowed" : "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <span>{label}</span>
      <span style={{ fontSize: 11, fontWeight: 400, opacity: 0.8 }}>{hint}</span>
    </button>
  );
}

function MonsterHitEntry({
  monsterName, targetName, raw_damage, damage_after_armor, damage_after_position,
  shield_absorbed, hp_damage, damage_type, resistance_reduction,
}: {
  monsterName: string; targetName: string;
  raw_damage: number; damage_after_armor: number;
  damage_after_position: number; shield_absorbed: number; hp_damage: number;
  damage_type?: "physical" | "magic" | "fire" | "ice" | "lightning";
  resistance_reduction?: number;
}) {
  const [open, setOpen] = useState(false);
  const armorReduction = raw_damage - damage_after_armor;
  const positionReduction = damage_after_armor - damage_after_position;
  const dtype = damage_type ?? "physical";

  // Non-physical attacks bypass the armor pool entirely. Show that up
  // front so the player knows why shield/armor didn't soak the hit.
  const nonPhysical = dtype !== "physical";
  const dtypeIcon =
    dtype === "fire" ? "🔥" :
    dtype === "ice" ? "❄️" :
    dtype === "lightning" ? "⚡" :
    dtype === "magic" ? "✨" : "⚔";
  const dtypeColor =
    dtype === "fire" ? "#f97316" :
    dtype === "ice" ? "#38bdf8" :
    dtype === "lightning" ? "#fbbf24" :
    dtype === "magic" ? "#a855f7" : undefined;

  const tags: string[] = [];
  if (armorReduction > 0) tags.push(`−${armorReduction} armor`);
  if (positionReduction > 0) tags.push(`−${positionReduction} cover`);
  if (shield_absorbed > 0) tags.push(`−${shield_absorbed} shield`);
  if ((resistance_reduction ?? 0) > 0) tags.push(`−${resistance_reduction} resist`);

  const badColor = TONE_COLOR["bad"];
  const mutedColor = TONE_COLOR["muted"];

  return (
    <div style={{ color: badColor }}>
      <span>
        <Icon name="fire-symbol" />{" "}
        {monsterName} hits {targetName} for{" "}
        <strong>{hp_damage} HP</strong>{" "}
        <span
          title={nonPhysical ? `${dtype} damage — bypasses armor` : "physical damage — soaked by armor first"}
          style={{
            fontSize: 11, fontWeight: 700, padding: "1px 6px", borderRadius: 4,
            background: nonPhysical ? `${dtypeColor}22` : "#1f2937",
            color: nonPhysical ? dtypeColor : mutedColor,
            border: `1px solid ${nonPhysical ? dtypeColor + "55" : "#374151"}`,
            verticalAlign: "middle",
            textTransform: "uppercase", letterSpacing: 0.5,
          }}
        >
          {dtypeIcon} {dtype}
        </span>
        {nonPhysical && (
          <span style={{ color: mutedColor, fontSize: 11, marginLeft: 6 }}>
            bypasses armor
          </span>
        )}
        {tags.length > 0 && <span style={{ color: mutedColor }}> ({tags.join(", ")})</span>}
        {" "}
        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            background: "none", border: "1px solid #3a3d44", borderRadius: 3,
            color: mutedColor, cursor: "pointer", fontSize: 10, padding: "1px 5px",
            fontFamily: "inherit", verticalAlign: "middle", lineHeight: 1.4,
          }}
        >
          {open ? "▲ Hide" : "Details ▼"}
        </button>
      </span>
      {open && (
        <div style={{
          marginTop: 6, marginLeft: 18, padding: "6px 10px",
          background: "#131519", borderRadius: 6, border: "1px solid #2a2d33",
          fontSize: 11, color: mutedColor, display: "grid",
          gridTemplateColumns: "max-content 1fr", gap: "3px 12px",
        }}>
          <span>⚔ Raw damage</span><span style={{ color: "#e5e7eb" }}>{raw_damage}</span>
          <span>{dtypeIcon} Damage type</span>
          <span style={{ color: dtypeColor ?? "#e5e7eb", textTransform: "capitalize" }}>
            {dtype}{nonPhysical && <span style={{ color: mutedColor }}> — bypasses armor pool</span>}
          </span>
          {armorReduction > 0 && <>
            <span>🛡 Armor</span>
            <span>−{armorReduction} → <span style={{ color: "#e5e7eb" }}>{damage_after_armor}</span></span>
          </>}
          {(resistance_reduction ?? 0) > 0 && <>
            <span>🌀 Resist</span>
            <span>−{resistance_reduction}</span>
          </>}
          {positionReduction > 0 && <>
            <span>↩ Back row</span>
            <span>−{positionReduction} → <span style={{ color: "#e5e7eb" }}>{damage_after_position}</span></span>
          </>}
          {shield_absorbed > 0 && <>
            <span>🔷 Shield</span>
            <span>−{shield_absorbed} absorbed</span>
          </>}
          <span style={{ borderTop: "1px solid #2a2d33", paddingTop: 3 }}>❤ HP lost</span>
          <span style={{ borderTop: "1px solid #2a2d33", paddingTop: 3, color: badColor, fontWeight: 600 }}>{hp_damage}</span>
        </div>
      )}
    </div>
  );
}

function ConfettiOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const colors = ["#86efac", "#fbbf24", "#a855f7", "#7dd3fc", "#fb7185", "#34d399", "#f9a8d4"];
    interface Particle { x: number; y: number; vx: number; vy: number; color: string; w: number; h: number; rot: number; rotV: number }
    const particles: Particle[] = Array.from({ length: 90 }, () => ({
      x: Math.random() * canvas.width,
      y: -20 - Math.random() * 120,
      vx: (Math.random() - 0.5) * 3,
      vy: 2.5 + Math.random() * 3,
      color: colors[Math.floor(Math.random() * colors.length)],
      w: 7 + Math.random() * 9,
      h: 4 + Math.random() * 5,
      rot: Math.random() * Math.PI * 2,
      rotV: (Math.random() - 0.5) * 0.18,
    }));
    let frame: number;
    let t = 0;
    function draw() {
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height);
      t++;
      for (const p of particles) {
        p.x += p.vx + Math.sin(t / 18 + p.x * 0.05) * 0.6;
        p.y += p.vy;
        p.rot += p.rotV;
        if (p.y > canvas!.height + 20) p.y = -20;
        ctx!.save();
        ctx!.translate(p.x, p.y);
        ctx!.rotate(p.rot);
        const alpha = t > 200 ? Math.max(0, 1 - (t - 200) / 60) : 1;
        ctx!.globalAlpha = alpha;
        ctx!.fillStyle = p.color;
        ctx!.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx!.restore();
      }
      if (t < 260) frame = requestAnimationFrame(draw);
      else ctx!.clearRect(0, 0, canvas!.width, canvas!.height);
    }
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);
  return <canvas ref={canvasRef} style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 200 }} />;
}

function VictoryModal({
  outcome,
  selfId,
  fighters,
  monsters,
  rawEvents,
  questId,
  onBack,
  onContinueClimbing,
  onPressOnAfterBoss,
  onBankAndExit,
}: {
  outcome: OutcomeSummary | null;
  selfId: string;
  fighters: Fighter[];
  monsters: Monster[];
  rawEvents: CombatEvent[];
  questId: number;
  onBack: () => void;
  // Tower mid-cycle: clicking "Continue climbing" triggers an in-place
  // floor-to-floor transition (no dashboard bounce). Optional so the modal
  // still works in non-tower contexts where the prop isn't supplied.
  onContinueClimbing?: () => void;
  // Tower post-boss (cycle cleared): "Press on" advances into the next
  // cycle in-place; "Bank spoils" calls /tower/exit and heads home.
  onPressOnAfterBoss?: () => void;
  onBankAndExit?: () => void;
}) {
  const burndown = useMemo(
    () => buildBurndown(rawEvents, fighters, monsters),
    [rawEvents, fighters, monsters],
  );
  const towerFloor = outcome?.tower_floor_cleared;
  const towerAwaitingChoice = outcome?.tower_awaiting_choice;
  const title = towerAwaitingChoice
    ? "CYCLE CLEARED"
    : towerFloor
    ? "FLOOR CLEARED"
    : "VICTORY";

  const [minimized, setMinimized] = useState(false);

  if (minimized) {
    return (
      <div style={{
        position: "fixed",
        bottom: 24,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 100,
      }}>
        <button
          onClick={() => setMinimized(false)}
          className="btn btn-gold"
          style={{ whiteSpace: "nowrap", boxShadow: "0 4px 24px rgba(0,0,0,0.6)" }}
        >
          ↩ View results
        </button>
      </div>
    );
  }

  return (
    <>
    <ConfettiOverlay />
    <div style={{
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.88)",
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "center",
      zIndex: 100,
      padding: 24,
      overflowY: "auto",
    }}>
      <div style={{
        background: "var(--bg-panel)",
        border: "1px solid var(--tone-good-2)",
        borderRadius: "var(--radius-2xl)",
        boxShadow: "var(--shadow-modal)",
        padding: 32,
        maxWidth: 520,
        width: "100%",
        boxSizing: "border-box",
        margin: "auto",
      }}>
        <div style={{
          fontSize: 36, fontWeight: 800,
          color: "var(--accent-gold)",
          textAlign: "center", marginBottom: 4,
          fontFamily: "var(--font-display)",
          letterSpacing: 1,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
        }}>
          {title === "VICTORY" && <Icon name="party-flags" size={28} color="var(--accent-gold)" />}
          {title}
          {title === "VICTORY" && <Icon name="party-flags" size={28} color="var(--accent-gold)" />}
        </div>
        <div style={{ textAlign: "center", marginBottom: 12 }}>
          <button
            onClick={() => setMinimized(true)}
            style={{
              background: "none", border: "none", cursor: "pointer",
              color: "var(--fg-faint)", fontSize: 12,
              padding: "2px 8px", borderRadius: 4,
              textDecoration: "underline",
            }}
          >
            View combat log
          </button>
        </div>
        {!outcome && <p style={{ ...muted, textAlign: "center" }}>Resolving outcome…</p>}
        {outcome && (
          <>
            {(outcome.is_boss || outcome.elite) && (
              <div style={{ ...muted, fontSize: 12, textAlign: "center", marginBottom: 12, color: "var(--fg-mute)" }}>
                {outcome.is_boss && "Boss "}{outcome.elite && "Elite "} pool: {outcome.total_pool_xp} XP · {outcome.total_pool_gold}g
              </div>
            )}
            {outcome.rewards.length >= 2 && (() => {
              const pct = outcome.rewards.length === 2 ? 10 : outcome.rewards.length === 3 ? 20 : 25;
              return (
                <div style={{
                  textAlign: "center", fontSize: 12, fontWeight: 600,
                  color: "var(--tone-good)", marginBottom: 10,
                  background: "rgba(34,197,94,0.08)",
                  border: "1px solid rgba(34,197,94,0.25)",
                  borderRadius: "var(--radius-md)",
                  padding: "4px 10px",
                  display: "inline-block", width: "100%",
                  boxSizing: "border-box",
                }}>
                  <Icon name="party-popper" size={13} color="var(--tone-good)" /> Party Bonus: +{pct}% XP
                </div>
              );
            })()}
            <div style={{ display: "grid", gap: 8, marginBottom: 16 }}>
              {outcome.rewards.map((r) => (
                <RewardRow
                  key={r.user_id}
                  reward={r}
                  fighterName={fighters.find((x) => x.id === r.user_id)?.name ?? r.user_id}
                  isSelf={r.user_id === selfId}
                  won={true}
                />
              ))}
            </div>
            {rawEvents.length > 0 && <BurndownChart data={burndown} selfId={selfId} />}
            {towerFloor && !towerAwaitingChoice && (
              <p style={{ ...muted, fontSize: 12, textAlign: "center", marginBottom: 12, color: "var(--fg-mute)" }}>
                {outcome?.tower_next_floor_kind === "rest"
                  ? "Floor cleared. A rest stop is next — check the dashboard."
                  : outcome?.tower_next_floor_kind === "boss"
                  ? "Floor cleared. The boss waits above — engage when ready."
                  : "Floor cleared. The next floor awaits."}
              </p>
            )}
          </>
        )}
        {(() => {
          // Tower post-boss: surface Press on / Bank spoils inline so the
          // player doesn't have to dashboard-bounce to make the choice.
          const fullWidth: React.CSSProperties = {
            width: "100%",
            justifyContent: "center",
            marginTop: 8,
          };
          if (towerAwaitingChoice && onPressOnAfterBoss && onBankAndExit) {
            return (
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button
                  onClick={onPressOnAfterBoss}
                  className="btn btn-ghost"
                  style={{ flex: 1, justifyContent: "center" }}
                >
                  Press on (next cycle)
                </button>
                <button
                  onClick={onBankAndExit}
                  className="btn btn-gold"
                  style={{ flex: 1, justifyContent: "center" }}
                >
                  Bank spoils
                </button>
              </div>
            );
          }
          // Rest floor next: start_web_combat would 400 (non_combat_room).
          // Route back through onBack so refresh() loads the rest-stop UI
          // instead of leaving CombatPage stuck on "Loading combat…".
          const nextKind = outcome?.tower_next_floor_kind;
          const inPlaceClimb = towerFloor && !towerAwaitingChoice && nextKind !== "rest";
          const label = towerFloor && !towerAwaitingChoice
            ? nextKind === "rest"
              ? "To the rest stop"
              : nextKind === "boss"
              ? "Engage the boss"
              : "Continue climbing"
            : "Back to town";
          return (
            <button
              onClick={inPlaceClimb && onContinueClimbing ? onContinueClimbing : onBack}
              className="btn btn-gold"
              style={fullWidth}
            >
              {label}
            </button>
          );
        })()}
      </div>
    </div>
    </>
  );
}

function DefeatModal({
  status,
  outcome,
  selfId,
  fighters,
  monsters,
  rawEvents,
  onBack,
}: {
  status: "defeat" | "fled";
  outcome: OutcomeSummary | null;
  selfId: string;
  fighters: Fighter[];
  monsters: Monster[];
  rawEvents: CombatEvent[];
  onBack: () => void;
}) {
  const fled = status === "fled";
  const burndown = useMemo(
    () => buildBurndown(rawEvents, fighters, monsters),
    [rawEvents, fighters, monsters],
  );

  return (
    <div style={{
      position: "fixed", inset: 0,
      background: "rgba(0,0,0,0.92)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 100, padding: 24,
    }}>
      <div style={{
        background: "var(--bg-panel)",
        border: `1px solid ${fled ? "var(--accent-gold-warm)" : "var(--tone-bad-3)"}`,
        borderRadius: "var(--radius-2xl)",
        boxShadow: "var(--shadow-modal)",
        padding: 32,
        maxWidth: 520, width: "100%", maxHeight: "85vh", overflowY: "auto", boxSizing: "border-box",
      }}>
        <div style={{ textAlign: "center", marginBottom: 20 }}>
          <Icon name={fled ? "footprint" : "death-skull"} size={48} color={fled ? "var(--accent-gold)" : "var(--tone-bad-2)"} />
          <div style={{
            fontSize: 36, fontWeight: 800,
            color: fled ? "var(--accent-gold)" : "var(--tone-bad)",
            marginTop: 8,
            fontFamily: "var(--font-display)",
            letterSpacing: 1,
          }}>
            {fled ? "ESCAPED" : "DEFEAT"}
          </div>
          {!fled && (
            <p style={{ ...muted, fontSize: 13, marginTop: 4, color: "var(--fg-mute)" }}>The party has fallen.</p>
          )}
        </div>

        {!outcome && <p style={{ ...muted, textAlign: "center", color: "var(--fg-mute)" }}>Resolving outcome…</p>}
        {outcome && (
          <div style={{ display: "grid", gap: 10, marginBottom: 16 }}>
            {outcome.rewards.map((r) => {
              const fighter = fighters.find((f) => f.id === r.user_id);
              const isSelf = r.user_id === selfId;
              const sd = r.soft_death;
              return (
                <div key={r.user_id} style={{
                  padding: 14,
                  borderRadius: "var(--radius-lg)",
                  background: "var(--bg-void)",
                  border: `1px solid ${isSelf ? "var(--tone-bad-3)" : "var(--border-faint)"}`,
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: sd ? 10 : 0 }}>
                    <span style={{ fontWeight: 700, color: "var(--fg-1)" }}>
                      {fighter?.name ?? r.user_id}
                      {isSelf && <span style={{ ...muted, fontSize: 12, marginLeft: 6, color: "var(--fg-mute)" }}>(you)</span>}
                    </span>
                    {!sd && <span style={{ ...muted, fontSize: 12, color: "var(--fg-mute)" }}>survived</span>}
                  </div>
                  {sd && (
                    <div style={{ display: "grid", gap: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, color: "var(--accent-gold)" }}>
                        <Icon name="death-skull" size={16} color="var(--tone-bad-2)" />
                        <span style={{ color: "var(--tone-bad)", fontWeight: 600 }}>Downed</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "var(--accent-gold)" }}>
                        <Icon name="gold-bar" size={14} color="var(--accent-gold)" />
                        <span>Lost <strong style={{ color: "var(--tone-bad-2)" }}>{sd.gold_lost}g</strong></span>
                      </div>
                      {sd.item_lost && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "var(--fg-2)" }}>
                          <Icon name="drop-weapon" size={14} color="var(--tone-fire)" />
                          <span>Dropped <strong style={{ color: "var(--tone-fire)" }}>{sd.item_lost}</strong></span>
                        </div>
                      )}
                      {sd.scar && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "var(--fg-3)" }}>
                          <Icon name="bleeding-hearts" size={14} color="var(--tone-bad-3)" />
                          <span>Scar: <em style={{ color: "var(--tone-bad)" }}>"{sd.scar}"</em></span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {rawEvents.length > 0 && <BurndownChart data={burndown} selfId={selfId} />}
        <button
          onClick={onBack}
          className={fled ? "btn btn-gold" : "btn btn-ghost"}
          style={{ marginTop: 8, width: "100%", justifyContent: "center" }}
        >
          Back to town
        </button>
      </div>
    </div>
  );
}

function EndBanner({
  status,
  outcome,
  selfId,
  fighters,
}: {
  status: "defeat" | "fled";
  outcome: OutcomeSummary | null;
  selfId: string;
  fighters: Fighter[];
}) {
  const fled = status === "fled";
  const labelText = fled ? "ESCAPED" : "DEFEAT";
  const borderColor = fled ? "#b89b3a" : "#7c2020";
  const bg = fled ? "#241e0d" : "#28100f";
  const fg = fled ? "#facc15" : "#fca5a5";
  return (
    <div style={{ ...card, borderColor, background: bg, textAlign: "center" }}>
      <div style={{ fontSize: 32, fontWeight: 800, color: fg, fontFamily: DISPLAY_FONT }}>{labelText}</div>
      {!outcome && <p style={muted}>Resolving outcome…</p>}
      {outcome && (
        <div style={{ marginTop: 12, textAlign: "left" }}>
          <div style={{ display: "grid", gap: 8 }}>
            {outcome.rewards.map((r) => (
              <RewardRow
                key={r.user_id}
                reward={r}
                fighterName={fighters.find((x) => x.id === r.user_id)?.name ?? r.user_id}
                isSelf={r.user_id === selfId}
                won={false}
              />
            ))}
          </div>
          <p style={{ ...muted, marginTop: 12, textAlign: "center" }}>
            Click <strong>← Dashboard</strong> to return.
          </p>
        </div>
      )}
    </div>
  );
}

const LOOT_ICON: Record<string, string> = {
  weapon: "sword",
  armor: "shield",
  consumable: "potion",
  magic: "crystal-ball",
  revive: "crowned-heart",
  tool: "hammer",
  scroll: "scroll-unfurled",
};

const RARITY_COLOR: Record<string, string> = {
  common: "#9aa0a6",
  uncommon: "#22c55e",
  rare: "#a855f7",
};

// Strip the boring "Weapon (power N)" / "Armor (power N)" / "Item (power N)"
// placeholders that loot drops used when AI flavor hadn't been applied.
// Pre-deploy quests still have these in their treasure arrays; render a typed
// label instead so the victory screen doesn't show "Item (power 2)".
function displayLootName(item: { item_name: string; item_type: string }): string {
  if (/^(Weapon|Armor|Item) \(power \d+\)$/.test(item.item_name)) {
    return item.item_type.charAt(0).toUpperCase() + item.item_type.slice(1);
  }
  return item.item_name;
}

function LootCard({ item, index }: { item: LootDrop; index: number }) {
  const color = RARITY_COLOR[item.rarity] ?? "#9aa0a6";
  // Prefer the smart icon resolver (name + flavor + slot aware) so weapons
  // whose flavor mentions "gun" pick up the blunderbuss icon, etc. Falls
  // back to the simple type-based LOOT_ICON for items the resolver can't
  // categorize.
  const icon = lootIcon({
    item_type: item.item_type,
    weapon_range: item.weapon_range,
    item_name: item.item_name,
    flavor: item.flavor,
  }) || LOOT_ICON[item.item_type] || "chest";
  const displayName = displayLootName(item);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        background: "#111827",
        border: `1.5px solid ${color}55`,
        borderLeft: `4px solid ${color}`,
        borderRadius: 8,
        padding: "10px 14px",
        animationName: "dice-roll-in",
        animationDuration: "500ms",
        animationDelay: `${index * 120}ms`,
        animationTimingFunction: "cubic-bezier(0.22,1,0.36,1)",
        animationFillMode: "both",
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 8,
          background: `${color}18`,
          border: `1px solid ${color}44`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          fontSize: 22,
          color,
        }}
      >
        <Icon name={icon} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: "#f5f5f5", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {displayName}
        </div>
        <div style={{ fontSize: 11, color, textTransform: "capitalize", marginTop: 2 }}>
          {item.rarity} {item.item_type}
          {item.power > 0 && <span style={{ color: "#e2e8f0", marginLeft: 4 }}>+{item.power}</span>}
          {item.level_req != null && item.level_req > 1 && (
            <span style={{ marginLeft: 6, color: "#9ca3af" }}>· Req L{item.level_req}</span>
          )}
        </div>
        {item.flavor && (
          <div style={{ fontSize: 11, color: "#6b7280", fontStyle: "italic", marginTop: 3 }}>
            "{item.flavor}"
          </div>
        )}
      </div>
    </div>
  );
}

function RewardRow({
  reward,
  fighterName,
  isSelf,
  won,
}: {
  reward: FighterReward;
  fighterName: string;
  isSelf: boolean;
  won: boolean;
}) {
  return (
    <div
      style={{
        padding: 12,
        background: "#0e0f12",
        borderRadius: 8,
        border: isSelf ? "1px solid #3a7bd5" : "1px solid transparent",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontWeight: 700, color: "#f5f5f5" }}>{fighterName}</span>
          {isSelf && <span style={{ ...muted, fontSize: 12 }}>(you)</span>}
        </div>
        <div style={{ fontSize: 13, fontVariantNumeric: "tabular-nums", color: "#e6e6e6" }}>
          {won
            ? `+${reward.xp_awarded} XP · +${reward.gold_awarded}g`
            : reward.soft_death
              ? "downed"
              : "—"}
        </div>
      </div>
      <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 10, fontSize: 11 }}>
        {reward.damage_dealt > 0 && <span style={{ color: "#f87171", display: "flex", alignItems: "center", gap: 3 }}><Icon name="health-decrease" size={11} color="#f87171" /> {reward.damage_dealt} dealt</span>}
        {reward.damage_taken > 0 && <span style={{ color: "#94a3b8", display: "flex", alignItems: "center", gap: 3 }}><Icon name="health-decrease" size={11} color="#94a3b8" /> {reward.damage_taken} taken</span>}
        {reward.healing_done > 0 && <span style={{ color: "#4ade80", display: "flex", alignItems: "center", gap: 3 }}><Icon name="health-potion" size={11} color="#4ade80" /> {reward.healing_done} healed</span>}
        {reward.shielding_done > 0 && <span style={{ color: "#7dd3fc", display: "flex", alignItems: "center", gap: 3 }}><Icon name="health-normal" size={11} color="#7dd3fc" /> {reward.shielding_done} shielded</span>}
        {reward.kills > 0 && <span style={{ color: "#facc15", display: "flex", alignItems: "center", gap: 3 }}><Icon name="death-skull" size={11} color="#facc15" /> killing blow</span>}
      </div>
      {reward.level_up && (
        <div style={{ marginTop: 6, fontSize: 13, color: "#facc15", fontWeight: 600 }}>
          ⭐ Level {reward.new_level}!
        </div>
      )}
      {reward.loot.length > 0 && (
        <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
          {reward.loot.map((it, i) => (
            <LootCard key={i} item={it} index={i} />
          ))}
        </div>
      )}
      {reward.soft_death && (
        <div style={{ marginTop: 6, fontSize: 12, color: "#fca5a5" }}>
          <Icon name="death-skull" /> −{reward.soft_death.gold_lost}g
          {reward.soft_death.item_lost && ` · lost ${reward.soft_death.item_lost}`}
          {reward.soft_death.scar && ` · scar: "${reward.soft_death.scar}"`}
        </div>
      )}
    </div>
  );
}

// ─── styles + helpers ──────────────────────────────────────────────────────

function badge(bg: string, fg: string, border: string): React.CSSProperties {
  return {
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 1,
    padding: "2px 6px",
    borderRadius: 4,
    border: `1px solid ${border}`,
    fontWeight: 600,
    background: bg,
    color: fg,
  };
}

// Compact party HP chips row below the room view.
function PartyChips({ fighters, selfId, flashIds, hitDustSeq, healBurstSeq, shieldBurstSeq, onClickSelf, abilityState, round, currentActorId }: {
  fighters: Fighter[]; selfId: string; flashIds: Set<string>;
  hitDustSeq: Record<string, number>;
  healBurstSeq: Record<string, number>;
  shieldBurstSeq: Record<string, number>;
  onClickSelf?: () => void;
  abilityState?: { [key: string]: unknown };
  round?: number;
  currentActorId?: string | null;
}) {
  const front = fighters.filter((f) => f.position === "front");
  const back = fighters.filter((f) => f.position === "back");
  const sofState = abilityState?.shield_of_faith as { expires_after_round: number } | undefined;
  const sofRoundsLeft = sofState != null ? sofState.expires_after_round - (round ?? 0) + 1 : 0;
  const sofActive = sofRoundsLeft > 0;
  const protectState = abilityState?.paladin_protect as { paladin_id: string; target_id: string } | undefined;
  const holyRageMap = abilityState?.holy_rage as Record<string, number> | undefined;
  const vanishedMap = abilityState?.vanished as Record<string, number> | undefined;
  const envenomMap = abilityState?.envenomed_weapon as Record<string, { stacks: number; charges: number }> | undefined;
  const encourageMap = abilityState?.encourage as Record<string, number> | undefined;
  const hymnState = abilityState?.battle_hymn as { expires_after_round: number } | undefined;
  const hymnActive = hymnState != null && (round ?? 0) <= hymnState.expires_after_round;
  const tauntFortifyMap = abilityState?.taunt_fortify as Record<string, { turns_remaining: number }> | undefined;
  const resilientMap = abilityState?.resilient as Record<string, number[]> | undefined;
  const braceMap = abilityState?.brace as Record<string, { pct: number; turns_remaining: number }> | undefined;
  const aliveBard = fighters.find((f) => f.hp > 0 && f.class === "Frontend Bard");
  const bardAuraBonus = aliveBard
    ? 1 + Math.floor(aliveBard.level / 5) + (hymnActive ? 2 + aliveBard.magic_mod : 0)
    : 0;
  const goodFortune = abilityState?.good_fortune as { caster_id: string; target_id: string; amount: number } | undefined;
  const blizzardState = abilityState?.blizzard as { caster_id: string; charges: number } | undefined;

  const compactMode = fighters.length >= 5;

  function renderChip(f: Fighter) {
    const pct = f.max_hp > 0 ? Math.max(0, f.hp / f.max_hp) : 0;
    const hpCol = f.hp <= 0
      ? "var(--tone-bad-3)"
      : pct < 0.25
        ? "var(--tone-bad-2)"
        : pct < 0.5
          ? "var(--accent-gold-warm)"
          : "var(--tone-good-2)";
    const isFlash = flashIds.has(f.id);
    const isSelf = f.id === selfId;
    const isActive = !!currentActorId && f.id === currentActorId && f.hp > 0;
    const clickable = isSelf && !!onClickSelf;
    const down = f.hp <= 0;
    // Any active shield surfaces in the .pcard chrome — blue stripe over
    // the HP bar, accent border, and the subtle pulse glow. The previous
    // gate `shield > armor_power/2` swallowed shields below 50%, which
    // hid the bar overlay even when shield was actively absorbing hits.
    const hasShield = f.shield > 0 && f.hp > 0;

    // pcard border resolution: active > self > shielded > default
    const borderColor = isActive
      ? "var(--accent-gold-warm)"
      : isSelf
        ? "var(--accent-ink-blue-2)"
        : hasShield
          ? "rgba(96,165,250,0.45)"
          : "var(--border-faint)";
    const boxShadow = isActive ? "0 0 0 1px var(--accent-gold-warm)" : undefined;
    const background = down ? "#1a0a0a" : "var(--bg-card-2)";
    const opacity = down ? 0.65 : 1;

    const chipArmorMax = Math.floor((f.armor_power ?? 0) / 2);
    const chipTotal = f.max_hp + chipArmorMax;
    const chipHpWidth = chipTotal > 0 ? (f.hp / chipTotal) * 100 : 0;
    const chipShieldStart = chipTotal > 0 ? (f.max_hp / chipTotal) * 100 : 100;
    const chipShieldWidth = chipTotal > 0 ? (f.shield / chipTotal) * 100 : 0;
    const padding = compactMode ? 8 : "9px 10px";

    return (
      /* Outer wrapper: owns layout slot + hit-shake class.
         Keeping it separate from the inner card means gq-hit-flash (CSS)
         and gq-shield-pulse (inline) never compete on the same element —
         inline style would win and suppress the shake animation. */
      <div
        key={f.id}
        className={isFlash ? "gq-hit-flash" : undefined}
        style={{ flex: "1 1 0", minWidth: 0, maxWidth: 230 }}
      >
      <div
        onClick={clickable ? onClickSelf : undefined}
        title={clickable ? "Open inventory" : undefined}
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          background,
          border: `1px solid ${borderColor}`,
          boxShadow,
          borderRadius: "var(--radius-lg)",
          padding,
          opacity,
          cursor: clickable ? "pointer" : "default",
          animation: hasShield ? "gq-shield-pulse 2.5s ease-in-out infinite" : undefined,
          fontFamily: "var(--font-body)",
          boxSizing: "border-box",
        }}
      >
        <HitDust seq={hitDustSeq[f.id] ?? 0} />
        <HealBurst seq={healBurstSeq[f.id] ?? 0} />
        <ShieldBurst seq={shieldBurstSeq[f.id] ?? 0} />
        {hasShield && <ShieldGlow />}

        {/* "Your turn" gold flag chip top-left */}
        {isActive && (
          <span style={{
            position: "absolute", top: -8, left: 10,
            font: "700 8px/1 var(--font-body)",
            letterSpacing: 0.5, textTransform: "uppercase",
            background: "var(--accent-gold-warm)", color: "#1a1300",
            padding: "3px 7px", borderRadius: 4,
            whiteSpace: "nowrap",
          }}>
            {isSelf ? "Your turn" : "Active"}
          </span>
        )}

        {/* Top row: avatar + name/class */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          {!down ? (
            <Avatar
              src={charPortraitUrl(f.name)}
              fallbackSrc={classPortraitUrl(f.class)}
              alt={f.name}
              size={30}
              radius={5}
              fallbackIcon="player"
              fallbackColor="var(--fg-faint)"
              border="1px solid var(--border-base)"
            />
          ) : (
            <div style={{
              width: 30, height: 30, flexShrink: 0,
              background: "var(--bg-void)",
              border: "1px solid var(--border-base)",
              borderRadius: 5,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <Icon name="death-skull" size={18} color="var(--tone-bad-2)" />
            </div>
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{
              font: "700 12px/1.1 var(--font-body)",
              color: "var(--fg-1)",
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            }}>
              {f.name}
              {isSelf && (
                <span style={{ color: "var(--accent-ink-blue)", fontWeight: 500, marginLeft: 4 }}>
                  (you)
                </span>
              )}
            </div>
            {!compactMode && (
              <div style={{
                font: "8px/1.2 var(--font-mono)",
                color: "var(--accent-arcane-2)",
                textTransform: "uppercase",
                letterSpacing: 0.4,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                marginTop: 2,
              }}>
                {f.class} · L{f.level}
              </div>
            )}
          </div>
        </div>

        {/* HP row */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
          <span style={{ font: "8px/1 var(--font-mono)", color: "var(--fg-mute)", width: 18, flexShrink: 0 }}>HP</span>
          <div
            className="bar"
            style={{
              flex: 1,
              height: 6,
              boxShadow: hasShield ? "0 0 5px rgba(96,165,250,.45)" : "none",
            }}
          >
            <i style={{ width: `${chipHpWidth}%`, background: hpCol }} />
            {chipArmorMax > 0 && f.shield > 0 && (
              <i style={{
                left: `${chipShieldStart}%`,
                width: `${chipShieldWidth}%`,
                background: "repeating-linear-gradient(45deg,#93c5fd,#93c5fd 4px,#60a5fa 4px,#60a5fa 8px)",
              }} />
            )}
          </div>
          <span style={{
            font: "8px/1 var(--font-mono)",
            color: down ? "var(--tone-bad-2)" : "var(--fg-3)",
            flexShrink: 0,
            whiteSpace: "nowrap",
          }}>
            {down ? "DOWN" : `${f.hp}/${f.max_hp}`}
          </span>
        </div>

        {/* MP row — only show if fighter has mana capacity */}
        {f.max_mana > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
            <span style={{ font: "8px/1 var(--font-mono)", color: "var(--fg-mute)", width: 18, flexShrink: 0 }}>MP</span>
            <div className="bar" style={{ flex: 1, height: 4 }}>
              <i style={{
                width: `${(f.max_mana > 0 ? f.mana / f.max_mana : 0) * 100}%`,
                background: "var(--accent-arcane)",
              }} />
            </div>
            <span style={{
              font: "8px/1 var(--font-mono)",
              color: "var(--fg-3)",
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}>
              {f.mana}/{f.max_mana}
            </span>
          </div>
        )}

        {/* Armor "shield broken" indicator — preserved from old layout */}
        {(f.armor_power > 0 || f.shield > 0) && (() => {
          const armorMax = f.armor_power > 0 ? Math.floor(f.armor_power / 2) : f.shield;
          const depleted = f.shield === 0;
          if (!depleted || armorMax === 0) return null;
          return (
            <div style={{
              font: "8px/1 var(--font-mono)",
              color: "var(--tone-bad-2)",
              fontWeight: 700,
              marginTop: 3,
            }}>
              🛡 broken
            </div>
          );
        })()}
        {(() => {
          const isProtected = protectState?.target_id === f.id;
          const holyRageTotal = holyRageMap?.[f.id] ?? 0;
          const holyRageBonus = Math.floor(holyRageTotal * 0.1);
          const vanishSwings = vanishedMap?.[f.id] ?? 0;
          const envenomEntry = envenomMap?.[f.id];
          const hasFortune = goodFortune?.target_id === f.id;
          const blizzardCharges = blizzardState?.caster_id === f.id ? blizzardState.charges : 0;
          const encourageCharges = encourageMap?.[f.id] ?? 0;
          const showAura = bardAuraBonus > 0;
          const fortifyTurns = (tauntFortifyMap?.[f.id]?.turns_remaining ?? 0) > 0 ? tauntFortifyMap![f.id].turns_remaining : 0;
          const resilientStacks = (resilientMap?.[f.id] ?? []).filter((exp) => exp >= (round ?? 1)).length;
          const braceEntry = braceMap?.[f.id];
          const braceTurns = (braceEntry?.turns_remaining ?? 0) > 0 ? braceEntry!.turns_remaining : 0;
          const hasExtra = sofActive || isProtected || holyRageTotal > 0 || vanishSwings > 0 || !!envenomEntry || hasFortune || blizzardCharges > 0 || encourageCharges > 0 || showAura || fortifyTurns > 0 || resilientStacks > 0 || braceTurns > 0;
          if (!f.effects?.length && !hasExtra) return null;
          return (
            <div style={{ position: "absolute", top: -6, right: 6, display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-end", zIndex: 2 }}>
              {f.effects?.map((e, i) => {
                const def = EFFECT_PILLS[e.type];
                return def ? <def.pill key={i} effect={e} size="sm" /> : null;
              })}
              {vanishSwings > 0 && <StatusPill size="sm" color="#818cf8" icon="player-dodge" label="vanish" suffix={`${vanishSwings}sw`} title={`Vanished: untargetable for ${vanishSwings} swing${vanishSwings === 1 ? "" : "s"}; next hit auto-crits`} />}
              {envenomEntry && <StatusPill size="sm" color="#4ade80" icon="vial" label="payload" suffix={`×${envenomEntry.stacks} ×${envenomEntry.charges}`} title={`Malicious Payload: next ${envenomEntry.charges} hit${envenomEntry.charges === 1 ? "" : "s"} apply ${envenomEntry.stacks} stacks of poison`} />}
              {sofActive && <StatusPill size="sm" color="#60a5fa" icon="round-shield" label="coverage" suffix={`${sofRoundsLeft}r`} title={`Test Coverage: +5 AC (${sofRoundsLeft} round${sofRoundsLeft === 1 ? "" : "s"} left)`} />}
              {isProtected && <StatusPill size="sm" color="#a78bfa" icon="crowned-heart" label="protected" suffix="½ dmg" title="Protected: taking half damage, absorbed by the paladin" />}
              {holyRageTotal > 0 && <StatusPill size="sm" color="#f97316" icon="fire" label="regr. rage" suffix={`+${holyRageBonus}`} title={`Regression Rage: next attack deals +${holyRageBonus} bonus damage`} />}
              {encourageCharges > 0 && <StatusPill size="sm" color="#4ade80" icon="conversation" label="adv" suffix={`${encourageCharges}c`} title={`Encouraged: advantage on next ${encourageCharges} roll${encourageCharges === 1 ? "" : "s"}`} />}
              {showAura && <StatusPill size="sm" color="#f59e0b" icon="aura" label="morale boost" suffix={`+${bardAuraBonus}`} title={`Morale Boost: +${bardAuraBonus} bonus damage${hymnActive ? ` (Battle Hymn active until round ${hymnState!.expires_after_round})` : ""}`} />}
              {braceTurns > 0 && <StatusPill size="sm" color="#38bdf8" icon="aura" label="brace" suffix={`-${braceEntry!.pct}% ${braceTurns}t`} title={`Brace: -${braceEntry!.pct}% incoming damage for ${braceTurns} more turn${braceTurns === 1 ? "" : "s"}`} />}
              {fortifyTurns > 0 && <StatusPill size="sm" color="#94a3b8" icon="shield-reflect" label="fortify" suffix={`${fortifyTurns}t`} title={`Taunt Fortify: all incoming damage routes through armor for ${fortifyTurns} more turn${fortifyTurns === 1 ? "" : "s"}`} />}
              {resilientStacks > 0 && <StatusPill size="sm" color="#f59e0b" icon="bolt-shield" label="resilient" suffix={`×${resilientStacks}`} title={`Resilient: ${resilientStacks} active stack${resilientStacks === 1 ? "" : "s"} — raises shield cap and effective armor by ${resilientStacks * 2}+ per stack`} />}
              {hasFortune && <StatusPill size="sm" color="#fbbf24" icon="crystal-ball" label="fortune" suffix={`+${goodFortune!.amount}hp`} title={`Good Fortune: delayed heal for ${goodFortune!.amount} HP activates next turn`} />}
              {blizzardCharges > 0 && <StatusPill size="sm" color="#93c5fd" icon="snowflake" label="blizzard" suffix={`${blizzardCharges}t`} title={`Blizzard active: deals AoE frost damage at end of each turn (${blizzardCharges} turn${blizzardCharges === 1 ? "" : "s"} left)`} />}
            </div>
          );
        })()}
      </div>
      </div>
    );
  }
  const standing = fighters.filter((f) => f.hp > 0).length;
  const downCount = fighters.length - standing;
  // Render front then back as a single flat flex row. Front/back labels
  // are emitted as tiny meta chips inside the row when both ranks exist,
  // so the dispatch is still readable without consuming card width.
  const showRankBadges = front.length > 0 && back.length > 0;

  return (
    <div>
      {/* Row header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 9 }}>
        <span style={{
          font: "9px/1 var(--font-mono)",
          color: "var(--accent-ink-blue)",
          textTransform: "uppercase",
          letterSpacing: 1,
        }}>
          Your Party · {fighters.length}{downCount > 0 ? ` · ${downCount} down` : ""}
        </span>
        <span style={{ font: "10px/1 var(--font-mono)", color: "var(--fg-mute)" }}>
          {standing} standing
        </span>
      </div>
      {/* Flat party flex; overflows horizontally on narrow viewports.
          Padding gives room for:
          - "Your turn" flag (top: -8) and status badges (top: -6)
          - gq-shield-pulse box-shadow (spreads ~20px) — overflow:auto on a
            scroll container clips box-shadow to the padding box, so the
            padding must exceed the shadow radius on all sides. */}
      <div style={{
        display: "flex",
        gap: 9,
        alignItems: "stretch",
        overflowX: "auto",
        paddingTop: 20,
        paddingBottom: 20,
        paddingLeft: 2,
        paddingRight: 2,
        marginTop: -8,
        marginBottom: -8,
      }}>
        {showRankBadges && front.length > 0 && (
          <span style={{
            font: "8px/1 var(--font-mono)",
            color: "var(--fg-mute-3)",
            textTransform: "uppercase",
            letterSpacing: 1.5,
            alignSelf: "center",
            flexShrink: 0,
          }}>F</span>
        )}
        {front.map(renderChip)}
        {showRankBadges && back.length > 0 && (
          <span style={{
            font: "8px/1 var(--font-mono)",
            color: "var(--fg-mute-3)",
            textTransform: "uppercase",
            letterSpacing: 1.5,
            alignSelf: "center",
            flexShrink: 0,
          }}>B</span>
        )}
        {back.map(renderChip)}
      </div>
    </div>
  );
}

const page: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  width: "100%",
  padding: 24,
  boxSizing: "border-box",
};
const combatGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
  gap: 16,
  alignItems: "start",
};
const topBar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};
const card: React.CSSProperties = {
  background: "#15171b",
  padding: 24,
  borderRadius: 12,
  width: "100%",
  border: "1px solid #2a2d33",
  boxSizing: "border-box",
};
const muted: React.CSSProperties = { color: "#9aa0a6", fontSize: 14, margin: 0 };
const button: React.CSSProperties = {
  marginTop: 12,
  width: "100%",
  padding: "12px 14px",
  fontSize: 16,
  fontWeight: 600,
  borderRadius: 8,
  border: "none",
  background: "#3a7bd5",
  color: "#fff",
  cursor: "pointer",
};
const exitBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #2a2d33",
  color: "#e6e6e6",
  padding: "6px 12px",
  borderRadius: 8,
  fontSize: 13,
  cursor: "pointer",
};

