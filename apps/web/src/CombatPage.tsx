import { useEffect, useReducer, useRef, useState } from "react";
import toast from "react-hot-toast";
import { isMonsterActor, classByName, activeAbilities, type ActiveAbilityDef, isAllyNpcActor } from "@gantt-quest/core";

import { Avatar, Icon } from "./icons";
import { CombatParticles, CombatParticlesProvider, triggerBurst } from "./CombatParticles";
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
  HpBar,
  CBtn,
  DiceRollDisplay,
  DiceRollEntry,
  InitStrip,
  CombatLog,
  LogEntry,
  ItemPicker,
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
  | { type: "player_hit"; actor: string; target: string; damage: number; crit: boolean; formula: string }
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
      return { connection: "connecting", state: null, log: [], error: null, outcome: null };
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
      const head = <><Icon name="ammo-bag" /> {nameOf(e.actor)} used {e.item_name}</>;
      if (eff.kind === "heal") {
        return [{ id: nextLogId++, content: <>{head}: +{eff.amount} HP</>, tone: "good" }];
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
    error: null,
    outcome: null,
  });
  const [itemPicker, setItemPicker] = useState<"closed" | "open" | { reviveItemId: number }>("closed");
  const [migratePicker, setMigratePicker] = useState<boolean>(false);
  const [allyPickerAbility, setAllyPickerAbility] = useState<ActiveAbilityDef | null>(null);
  const [anyPickerAbility, setAnyPickerAbility] = useState<ActiveAbilityDef | null>(null);
  const [protectConfirm, setProtectConfirm] = useState<{ pendingTargetId: string } | null>(null);
  const [givePicker, setGivePicker] = useState<"closed" | "selectItem" | { itemId: number }>("closed");
  const [items, setItems] = useState<InventoryItem[]>([]);
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

  // Inventory loaded once on mount; refreshed after each item_used event so
  // the picker reflects post-use state. Authoritative source is D1 via
  // /api/inventory.
  async function loadItems() {
    const res = await fetch("/api/inventory", { credentials: "include" });
    if (res.ok) setItems(((await res.json()) as { items: InventoryItem[] }).items);
  }
  useEffect(() => {
    void loadItems();
  }, []);


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
          dispatch({ kind: "state", value: normalised });
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
            // Particle bursts.
            if (evt.type === "elemental_proc" && !evt.resisted) {
              triggerBurst(evt.element === "fire" ? "fire" : evt.element === "ice" ? "ice" : "lightning");
            }
            // Monster procs a status on a fighter — burst on element type +
            // a toast if it landed on the local player (otherwise the
            // status pill in their roster row may go unnoticed).
            if (evt.type === "monster_elemental_proc") {
              triggerBurst(evt.element === "fire" ? "fire" : evt.element === "ice" ? "ice" : "lightning");
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
  const myActiveAbilities = me ? activeAbilities(classByName(me.class).abilities) : [];
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
    send({
      kind: "ability",
      actor: selfId,
      ability_id: ability.id,
      target_id: ability.target === "single_enemy" ? (effectiveTarget ?? undefined) : undefined,
    });
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

  // Background art: first live monster's portrait, or first monster fallback.
  const bgArtUrl = state?.monsters.find((m) => m.hp > 0)?.art_url ?? state?.monsters[0]?.art_url ?? null;
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

      {/* Room view — flex: 1, background art + floating overlays */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden", minHeight: 0, background: bgArtUrl ? undefined : "#1c1f2e" }}>
        {bgArtUrl && (
          <img src={bgArtUrl} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        )}
        <div style={{ position: "absolute", inset: 0, background: bgArtUrl
          ? "linear-gradient(to bottom, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0.05) 35%, rgba(0,0,0,0.70) 100%)"
          : "linear-gradient(to bottom, rgba(0,0,0,0.10) 0%, rgba(0,0,0,0.00) 40%, rgba(0,0,0,0.40) 100%)",
          pointerEvents: "none" }} />
        <CombatParticles />

        {/* Loading state */}
        {!state && (
          <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", color: "#9aa0a6", fontSize: 14, textAlign: "center" }}>
            <p style={{ margin: 0 }}>Loading combat…</p>
            {ui.error && <p style={{ margin: "8px 0 0", color: "#c0392b" }}>{ui.error}</p>}
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

            {/* Monster strip — center of room */}
            <div style={{
              position: "absolute",
              top: "50%", left: "50%",
              transform: "translate(-50%, -65%)",
              display: "flex", gap: 10, flexWrap: "wrap",
              alignItems: "flex-start", justifyContent: "center",
              maxWidth: "80vw", zIndex: 4,
            }}>
              {state.monsters.map((m, i) => {
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
              })}
            </div>

            {/* Left column — dice rolls, below the initiative strip */}
            <div style={{ position: "absolute", top: 60, left: 12, zIndex: 6, maxWidth: isMobile ? 90 : "min(200px, 16vw)" }}>
              <DiceRollDisplay rolls={diceRolls} align="left" />
            </div>

            {/* Right rail — combat log (hidden on mobile; too narrow to be useful) */}
            {!isMobile && (
              <div style={{
                position: "absolute", top: 12, right: 12, bottom: 12, width: "min(280px, 22vw)",
                display: "flex", flexDirection: "column", zIndex: 6,
                background: "rgba(0,0,0,0.6)", border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 8, backdropFilter: "blur(6px)", padding: "8px 6px 6px",
              }}>
                <CombatLog log={ui.log} scrollRef={logScrollRef} />
              </div>
            )}

            {/* Pick-a-target prompt */}
            {myTurn && liveMonsters.length > 1 && targetMonsterId === null && !isPickerOpen && (
              <div style={{ position: "absolute", bottom: 10, left: "50%", transform: "translateX(-50%)", zIndex: 7, background: "rgba(30,26,46,0.92)", border: "1px solid #c084fc", borderRadius: 8, padding: "6px 18px", color: "#e9d5ff", fontSize: 13, fontWeight: 600, backdropFilter: "blur(6px)", whiteSpace: "nowrap" }}>
                Click a monster to target it
              </div>
            )}

            {/* Combat-end tint (before modal appears) */}
            {ended && state.status !== "victory" && !defeatModalReady && (
              <div style={{ position: "absolute", inset: 0, background: "rgba(80,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20 }}>
                <div style={{ fontFamily: DISPLAY_FONT, fontSize: 44, color: "#fca5a5", textShadow: "0 0 24px rgba(252,165,165,0.5)" }}>
                  {state.status === "fled" ? "ESCAPED" : "DEFEATED"}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Party chips row */}
      {state && (
        <div style={{ background: "rgba(10,11,14,0.92)", borderTop: "1px solid #1e2028", padding: "6px 10px", flexShrink: 0, zIndex: 8 }}>
          <PartyChips fighters={state.fighters} selfId={selfId} flashIds={flashIds} hitDustSeq={hitDustSeq} healBurstSeq={healBurstSeq} shieldBurstSeq={shieldBurstSeq} onClickSelf={onOpenInventory} abilityState={state.ability_state} round={state.round} />
        </div>
      )}

      {/* Pickers — all portal-based modals */}
      {state?.status === "active" && itemPicker === "open" && (
        <ItemPicker
          items={items as unknown as CombatItem[]}
          onPickNoTarget={(id) => fireUseItem(id)}
          onPickRevive={(id) => setItemPicker({ reviveItemId: id })}
          onCancel={() => setItemPicker("closed")}
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
      {state?.status === "active" && !isPickerOpen && (
        <div style={{ background: "rgba(10,11,14,0.92)", borderTop: "1px solid #1e2028", padding: isMobile ? "4px 6px 6px" : "8px 10px 10px", flexShrink: 0, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
          {/* Turn status hint */}
          {!myTurn && (
            <div style={{ width: "100%", textAlign: "center", fontSize: 11, color: "#9aa0a6", fontStyle: "italic", paddingBottom: 2, display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
              <span>{isMonsterTurn && !autoResolve ? "Enemy turn" : isMonsterTurn ? "Enemy turn — auto-resolving…" : `Waiting for ${state.fighters.find((f) => f.id === currentActorId)?.name ?? "another player"}…`}</span>
              {isInactivePlayerTurn && (
                <button
                  onClick={() => currentActorId && send({ kind: "wait", actor: currentActorId })}
                  disabled={!skipReady}
                  title={skipReady ? "Skip this player's turn" : "Available after 8 seconds"}
                  style={{
                    background: skipReady ? "#292d36" : "#1a1d23",
                    border: `1px solid ${skipReady ? "#4a5568" : "#2a2d33"}`,
                    borderRadius: 6,
                    color: skipReady ? "#cbd5e1" : "#4a5568",
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
          <CBtn label="Attack" icon="sword" color="#b89b3a" disabled={!myTurn || (liveMonsters.length > 1 && targetMonsterId === null)} onClick={() => send({ kind: "attack", actor: selfId, target_id: effectiveTarget })} />
          {myActiveAbilities.map((ability) => {
            const needsTarget = ability.target === "single_enemy";
            const targetMissing = needsTarget && liveMonsters.length > 1 && targetMonsterId === null;
            const cooldown = state?.cooldowns?.[selfId]?.[ability.id] ?? 0;
            return (
              <CBtn
                key={ability.id}
                label={ability.name}
                icon={ability.icon}
                color="#d946ef"
                manaCost={ability.mana_cost > 0 ? ability.mana_cost : undefined}
                tooltip={ability.blurb}
                cooldown={cooldown}
                disabled={!myTurn || myMana < ability.mana_cost || targetMissing}
                onClick={() => fireAbility(ability)}
              />
            );
          })}
          {/* Position swap — available even in solo. Was previously
              gated on multi-fighter parties, which left solo players
              stuck if their persisted position was "back" with no way
              to swap. Back row still matters in solo (reduces melee
              damage from front-positioned monsters). */}
          <CBtn label={otherPosition === "front" ? "Front" : "Back"} icon={otherPosition === "front" ? "muscle-up" : "fall-down"} color="#6b7280" disabled={!myTurn} onClick={() => send({ kind: "position", actor: selfId, to: otherPosition })} />
          <CBtn label="Item" icon="ammo-bag" color="#c084fc" disabled={!myTurn || !items.some((i) => isCombatUsable(i.item_type))} onClick={() => setItemPicker("open")} />
          {items.some((i) => !i.equipped) && state.fighters.filter((f) => f.hp > 0 && f.id !== selfId).length > 0 && (
            <CBtn label="Give" icon="conversation" color="#fcd34d" disabled={!myTurn} onClick={() => setGivePicker("selectItem")} />
          )}
          <CBtn label="Mark" icon="targeted" color="#f97316" disabled={liveMonsters.length > 1 && targetMonsterId === null} onClick={() => send({ kind: "mark", actor: selfId, target_id: effectiveTarget })} />
          <CBtn label="Wait" icon="hourglass" color="#475569" disabled={!myTurn} onClick={() => send({ kind: "wait", actor: selfId })} />
          {/* No flee inside the Tower — commit through each cycle. The exit
              valve is the post-boss "Call it a day" prompt. */}
          {liveMonsters[0]?.tower_floor === undefined && (
            <CBtn label="Flee" icon="footprint" color="#9aa0a6" disabled={!myTurn} onClick={() => send({ kind: "flee", actor: selfId })} />
          )}
          {isMonsterTurn && !autoResolve && (
            <CBtn label="Resolve" icon="dragon" color="#5c1f1f" onClick={() => send({ kind: "monster_act" })} />
          )}
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#4a5568", cursor: "pointer", marginLeft: 6 }}>
            <input type="checkbox" checked={autoResolve} onChange={(e) => setAutoResolve(e.target.checked)} style={{ accentColor: "#5c1f1f" }} />
            Auto
          </label>
        </div>
      )}

      {/* Victory modal — delayed until dice settle */}
      {ended && state?.status === "victory" && victoryModalReady && (
        <VictoryModal
          outcome={ui.outcome}
          selfId={selfId}
          fighters={state.fighters}
          questId={questId}
          onBack={exit}
          onContinueClimbing={continueClimbing}
          onPressOnAfterBoss={pressOnAfterBoss}
          onBankAndExit={bankAndExit}
        />
      )}

      {/* Defeat / fled modal — delayed until dice settle */}
      {ended && state?.status !== "victory" && defeatModalReady && (
        <DefeatModal
          status={state.status as "defeat" | "fled"}
          outcome={ui.outcome}
          selfId={selfId}
          fighters={state.fighters}
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
  const pct = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
  const color = pct < 0.25 ? "#dc2626" : pct < 0.5 ? "#d97706" : "#16a34a";
  const armorMax = Math.floor(armorPower / 2);
  const armorPct = armorMax > 0 ? Math.max(0, Math.min(1, shield / armorMax)) : 0;
  return (
    <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ height: 8, background: "#0e0f12", borderRadius: 4, overflow: "hidden" }}>
          <div style={{ width: `${pct * 100}%`, height: "100%", background: color, transition: "width 0.3s ease" }} />
        </div>
        {armorMax > 0 && (
          <div style={{ height: 4, background: shield === 0 ? "#3b1515" : "#0e0f12", borderRadius: 2, overflow: "hidden" }} title={shield === 0 ? "Armor depleted" : `Armor: ${shield}/${armorMax}`}>
            <div style={{ width: `${armorPct * 100}%`, height: "100%", background: "#6b7280", transition: "width 0.3s ease" }} />
          </div>
        )}
      </div>
      <div style={{ ...muted, fontSize: 11, minWidth: 48, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {hp}/{maxHp}
        {armorMax > 0 && <div style={{ fontSize: 10, color: shield === 0 ? "#ef4444" : "#6b7280" }}>{shield}/{armorMax} 🛡</div>}
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
  if (positionReduction > 0) tags.push(`−${positionReduction} back row`);
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
  questId,
  onBack,
  onContinueClimbing,
  onPressOnAfterBoss,
  onBankAndExit,
}: {
  outcome: OutcomeSummary | null;
  selfId: string;
  fighters: Fighter[];
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
  const towerFloor = outcome?.tower_floor_cleared;
  const towerAwaitingChoice = outcome?.tower_awaiting_choice;
  const title = towerAwaitingChoice
    ? "CYCLE CLEARED"
    : towerFloor
    ? "FLOOR CLEARED"
    : "VICTORY";

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
        background: "#0f2818",
        border: "2px solid #16a34a",
        borderRadius: 16,
        padding: 32,
        maxWidth: 520,
        width: "100%",
        boxSizing: "border-box",
        margin: "auto",
      }}>
        <div style={{ fontSize: 36, fontWeight: 800, color: "#86efac", textAlign: "center", marginBottom: 4, fontFamily: DISPLAY_FONT, display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
          {title === "VICTORY" && <Icon name="party-flags" size={28} color="#86efac" />}
          {title}
          {title === "VICTORY" && <Icon name="party-flags" size={28} color="#86efac" />}
        </div>
        {!outcome && <p style={{ ...muted, textAlign: "center" }}>Resolving outcome…</p>}
        {outcome && (
          <>
            {(outcome.is_boss || outcome.elite) && (
              <div style={{ ...muted, fontSize: 12, textAlign: "center", marginBottom: 12 }}>
                {outcome.is_boss && "Boss "}{outcome.elite && "Elite "} pool: {outcome.total_pool_xp} XP · {outcome.total_pool_gold}g
              </div>
            )}
            {outcome.rewards.length >= 2 && (() => {
              const pct = outcome.rewards.length === 2 ? 10 : outcome.rewards.length === 3 ? 20 : 25;
              return (
                <div style={{
                  textAlign: "center", fontSize: 12, fontWeight: 600,
                  color: "#86efac", marginBottom: 10,
                  background: "#0a2010", borderRadius: 6, padding: "4px 10px",
                  display: "inline-block", width: "100%",
                }}>
                  <Icon name="party-popper" size={13} color="#86efac" /> Party Bonus: +{pct}% XP
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
            {towerFloor && !towerAwaitingChoice && (
              <p style={{ ...muted, fontSize: 12, textAlign: "center", marginBottom: 12 }}>
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
          if (towerAwaitingChoice && onPressOnAfterBoss && onBankAndExit) {
            return (
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button
                  onClick={onPressOnAfterBoss}
                  style={{ ...button, marginTop: 0, background: "#854d0e", color: "#fef3c7", flex: 1 }}
                >
                  🗼 Press on (next cycle)
                </button>
                <button
                  onClick={onBankAndExit}
                  style={{ ...button, marginTop: 0, background: "#16a34a", flex: 1 }}
                >
                  🛌 Bank spoils
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
              ? "🛌 To the rest stop"
              : nextKind === "boss"
              ? "👑 Engage the boss"
              : "🗼 Continue climbing"
            : "Back to town";
          return (
            <button
              onClick={inPlaceClimb && onContinueClimbing ? onContinueClimbing : onBack}
              style={{ ...button, marginTop: 8, background: "#16a34a" }}
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
  onBack,
}: {
  status: "defeat" | "fled";
  outcome: OutcomeSummary | null;
  selfId: string;
  fighters: Fighter[];
  onBack: () => void;
}) {
  const fled = status === "fled";

  return (
    <div style={{
      position: "fixed", inset: 0,
      background: "rgba(0,0,0,0.92)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 100, padding: 24,
    }}>
      <div style={{
        background: fled ? "#241e0d" : "#1c0a09",
        border: `2px solid ${fled ? "#b89b3a" : "#7c2020"}`,
        borderRadius: 16, padding: 32,
        maxWidth: 520, width: "100%", maxHeight: "85vh", overflowY: "auto", boxSizing: "border-box",
      }}>
        <div style={{ textAlign: "center", marginBottom: 20 }}>
          <Icon name={fled ? "footprint" : "death-skull"} size={48} color={fled ? "#facc15" : "#ef4444"} />
          <div style={{ fontSize: 36, fontWeight: 800, color: fled ? "#facc15" : "#fca5a5", marginTop: 8, fontFamily: DISPLAY_FONT }}>
            {fled ? "ESCAPED" : "DEFEAT"}
          </div>
          {!fled && (
            <p style={{ ...muted, fontSize: 13, marginTop: 4 }}>The party has fallen.</p>
          )}
        </div>

        {!outcome && <p style={{ ...muted, textAlign: "center" }}>Resolving outcome…</p>}
        {outcome && (
          <div style={{ display: "grid", gap: 10, marginBottom: 16 }}>
            {outcome.rewards.map((r) => {
              const fighter = fighters.find((f) => f.id === r.user_id);
              const isSelf = r.user_id === selfId;
              const sd = r.soft_death;
              return (
                <div key={r.user_id} style={{
                  padding: 14, borderRadius: 10,
                  background: "#0e0f12",
                  border: `1px solid ${isSelf ? "#7c2020" : "#1e1e1e"}`,
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: sd ? 10 : 0 }}>
                    <span style={{ fontWeight: 700, color: "#f5f5f5" }}>
                      {fighter?.name ?? r.user_id}
                      {isSelf && <span style={{ ...muted, fontSize: 12, marginLeft: 6 }}>(you)</span>}
                    </span>
                    {!sd && <span style={{ ...muted, fontSize: 12 }}>survived</span>}
                  </div>
                  {sd && (
                    <div style={{ display: "grid", gap: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, color: "#fbbf24" }}>
                        <Icon name="death-skull" size={16} color="#ef4444" />
                        <span style={{ color: "#fca5a5", fontWeight: 600 }}>Downed</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#fbbf24" }}>
                        <Icon name="gold-bar" size={14} color="#fbbf24" />
                        <span>Lost <strong style={{ color: "#ef4444" }}>{sd.gold_lost}g</strong></span>
                      </div>
                      {sd.item_lost && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#e2e8f0" }}>
                          <Icon name="drop-weapon" size={14} color="#f97316" />
                          <span>Dropped <strong style={{ color: "#f97316" }}>{sd.item_lost}</strong></span>
                        </div>
                      )}
                      {sd.scar && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#d1d5db" }}>
                          <Icon name="bleeding-hearts" size={14} color="#dc2626" />
                          <span>Scar: <em style={{ color: "#fca5a5" }}>"{sd.scar}"</em></span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <button onClick={onBack} style={{ ...button, marginTop: 8, background: fled ? "#78350f" : "#7c2020" }}>
          ← Back to town
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
function PartyChips({ fighters, selfId, flashIds, hitDustSeq, healBurstSeq, shieldBurstSeq, onClickSelf, abilityState, round }: {
  fighters: Fighter[]; selfId: string; flashIds: Set<string>;
  hitDustSeq: Record<string, number>;
  healBurstSeq: Record<string, number>;
  shieldBurstSeq: Record<string, number>;
  onClickSelf?: () => void;
  abilityState?: { [key: string]: unknown };
  round?: number;
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

  function renderChip(f: Fighter) {
    const pct = f.max_hp > 0 ? Math.max(0, f.hp / f.max_hp) : 0;
    const hpCol = pct > 0.5 ? "#22c55e" : pct > 0.25 ? "#f59e0b" : "#ef4444";
    const isFlash = flashIds.has(f.id);
    const isSelf = f.id === selfId;
    const clickable = isSelf && !!onClickSelf;
    return (
      <div
        key={f.id}
        className={isFlash ? "gq-hit-flash" : undefined}
        onClick={clickable ? onClickSelf : undefined}
        title={clickable ? "Open inventory" : undefined}
        style={{
          position: "relative",
          display: "flex", alignItems: "center", gap: 8,
          background: isSelf ? "rgba(245,245,220,0.09)" : "rgba(255,255,255,0.04)",
          border: isSelf ? "1px solid rgba(245,245,220,0.22)" : f.shield > Math.floor(f.armor_power / 2) && f.hp > 0 ? "1px solid rgba(96,165,250,0.4)" : "1px solid rgba(255,255,255,0.07)",
          animation: f.shield > Math.floor(f.armor_power / 2) && f.hp > 0 ? "gq-shield-pulse 2.5s ease-in-out infinite" : undefined,
          borderRadius: 8, padding: "5px 10px",
          opacity: f.hp <= 0 ? 0.45 : 1, flexShrink: 0,
          minWidth: 130,
          cursor: clickable ? "pointer" : "default",
        }}
      >
        <HitDust seq={hitDustSeq[f.id] ?? 0} />
        <HealBurst seq={healBurstSeq[f.id] ?? 0} />
        <ShieldBurst seq={shieldBurstSeq[f.id] ?? 0} />
        {f.shield > Math.floor(f.armor_power / 2) && f.hp > 0 && <ShieldGlow />}
        <Avatar src={charPortraitUrl(f.name)} fallbackSrc={classPortraitUrl(f.class)} alt={f.name} size={40} radius={5} fallbackIcon="player" fallbackColor="#4a5568" border="1px solid #2a2d33" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#e2e8f0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</div>
          <div style={{ height: 5, background: "#0e0f12", borderRadius: 3, overflow: "hidden", marginTop: 3 }}>
            <div style={{ width: `${pct * 100}%`, height: "100%", background: hpCol, transition: "width 0.3s ease" }} />
          </div>
          <div style={{ fontSize: 10, color: "#9aa0a6", marginTop: 2 }}>
            {f.hp}/{f.max_hp} HP
          </div>
          {(f.armor_power > 0 || f.shield > 0) && (() => {
            const armorMax = f.armor_power > 0 ? Math.floor(f.armor_power / 2) : f.shield;
            const armorPct = armorMax > 0 ? Math.max(0, f.shield / armorMax) : 1;
            const depleted = f.shield === 0;
            return (
              <>
                <div style={{ height: 4, background: "#1e2028", borderRadius: 2, overflow: "hidden", marginTop: 3, border: "1px solid #2a2d33" }}>
                  <div style={{ width: `${armorPct * 100}%`, height: "100%", background: depleted ? "#374151" : "#94a3b8", transition: "width 0.3s ease" }} />
                </div>
                <div style={{ fontSize: 10, color: depleted ? "#f87171" : "#94a3b8", marginTop: 2, fontWeight: depleted ? 700 : 400 }}>
                  {f.shield}/{armorMax} 🛡{depleted ? " broken" : ""}
                </div>
              </>
            );
          })()}
        </div>
        {/* Mana orbs — grid with capped row count so a 4–6-mana fighter
            wraps into a 2nd column instead of growing the chip taller
            than the avatar. 3 rows × auto columns: 1–3 mana = single
            column, 4–6 mana = two columns. */}
        <div style={{
          display: "grid",
          gridAutoFlow: "column",
          gridTemplateRows: "repeat(3, 7px)",
          columnGap: 3,
          rowGap: 2,
          alignItems: "center",
          justifyItems: "center",
        }}>
          {Array.from({ length: f.max_mana }, (_, mi) => (
            <div key={mi} style={{ width: 7, height: 7, borderRadius: "50%", background: mi < f.mana ? "#818cf8" : "#1e2028", border: "1px solid #3a3d43" }} />
          ))}
        </div>
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
            <div style={{ position: "absolute", top: -8, right: -4, display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-end" }}>
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
    );
  }
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
      {front.length > 0 && (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 8, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1.5, writingMode: "vertical-rl", transform: "rotate(180deg)" }}>Front</span>
          {front.map(renderChip)}
        </div>
      )}
      {back.length > 0 && (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 8, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1.5, writingMode: "vertical-rl", transform: "rotate(180deg)" }}>Back</span>
          {back.map(renderChip)}
        </div>
      )}
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

