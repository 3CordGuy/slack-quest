import { useEffect, useReducer, useRef, useState } from "react";
import toast from "react-hot-toast";
import { isMonsterActor } from "@gantt-quest/core";

import { Avatar, Icon } from "./icons";

const DISPLAY_FONT = "'Metamorphous', serif";

// Live web-mode combat. Connects to the QuestRoom Durable Object via WS,
// renders the current state, animates incoming events through a scrolling
// log, and lets the active player submit actions.

interface StatusEffect {
  type: "regen" | "bleeding" | "burning" | "poisoned";
  magnitude: number;
  remaining: number;
  source?: string;
}

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
  art_url?: string;
}

interface CombatState {
  fighters: Fighter[];
  monsters: Monster[];
  turn_order: string[];
  turn_index: number;
  round: number;
  status: "pending" | "active" | "victory" | "defeat" | "fled";
  ability_state?: {
    mark?: { marked_by: string; expires_after_round: number };
    [key: string]: unknown;
  };
}

// Class display name → flux R2 portrait URL. Pattern mirrors getOrScheduleViewArt
// + ART_VERSION on the worker side; constructed client-side so the WS state
// doesn't have to carry a URL per fighter. 404 silently hides via <img onError>.
const CLASS_PORTRAIT_BASE = "/img/art/views/v6";
const CLASS_ID_BY_NAME: Record<string, string> = {
  "DevOps Mage": "devops_mage",
  "QA Paladin": "qa_paladin",
  "Backend Druid": "backend_druid",
  "Frontend Bard": "frontend_bard",
  "Staff Sage": "staff_sage",
  "Refactor Rogue": "refactor_rogue",
  "SRE Warden": "sre_warden",
  "Data Wizard": "data_warlock",
  "Data Warlock": "data_warlock", // legacy alias for pre-rename DO state
};
function classPortraitUrl(className: string): string | null {
  const id = CLASS_ID_BY_NAME[className];
  return id ? `${CLASS_PORTRAIT_BASE}/class_${id}.png` : null;
}
// Mirrors BARD_AURA_HYMN_DAMAGE in combat_machine.ts — keep in sync.
const BARD_HYMN_BONUS = 3;

// Per-character portrait — same key the server writes in getOrScheduleCharacterArt.
// Avatar's onError fallback handles the case where the portrait hasn't generated yet.
const CHAR_ART_VERSION = "v3";
function slugifyName(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "unnamed";
}
function charPortraitUrl(name: string): string {
  return `/img/art/${CHAR_ART_VERSION}/character/${slugifyName(name)}.png`;
}

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
      target: string;
      raw_damage: number;
      damage_after_position: number;
      damage_after_armor: number;
      shield_absorbed: number;
      hp_damage: number;
    }
  | { type: "boss_phase_transition"; new_phase: 2 }
  | { type: "fighter_down"; target: string }
  | { type: "monster_down"; killed_by: string }
  | { type: "heal_applied"; actor: string; target: string; amount: number; rolled: number }
  | { type: "shield_applied"; actor: string; target: string; amount: number; rolled: number }
  | { type: "signature_used"; actor: string; damage: number; formula: string; mana_spent: number }
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
  | { type: "ability_containerize"; swings: number }
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
  | { type: "ability_battle_hymn"; actor: string; charges_added: number }
  | {
      type: "ability_foresee";
      actor: string;
      predicted_target: string | null;
      damage_lo: number;
      damage_hi: number;
      net_lo: number;
      net_hi: number;
      verdict: "safe" | "at_risk" | "lethal";
      probabilities: Array<{ id: string; position: "front" | "back"; pct: number }>;
      triage: Array<{ id: string; hp: number; max_hp: number; shield: number; position: "front" | "back" }>;
      active: { containerize: number; taunt_actor: string | null; taunt_swings: number; vanished: string[] };
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
  | { type: "battle_hymn_consumed"; actor: string; bonus: number; remaining: number }
  | { type: "mark_applied"; actor: string; expires_after_round: number; bonus: number }
  | { type: "mark_bonus"; actor: string; bonus: number }
  | { type: "passive_warden_shield"; actor: string; amount: number }
  | { type: "passive_mage_free_sig"; actor: string }
  | { type: "passive_druid_regen"; actor: string; amount: number }
  | { type: "passive_rogue_first_crit"; actor: string }
  | { type: "passive_bard_aura"; actor: string; source: string; bonus: number }
  | { type: "passive_warlock_bleed"; actor: string; magnitude: number; duration: number }
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
  | { type: "victory" }
  | { type: "defeat" }
  | { type: "rejected"; reason: string }
  | ItemUsedEvent;

type TurnAction =
  | { kind: "attack"; actor: string; target_id?: string | null }
  | { kind: "cast"; actor: string; target_id?: string | null }
  | { kind: "heal"; actor: string; target: string }
  | { kind: "shield"; actor: string; target: string }
  | { kind: "signature"; actor: string; target_id?: string | null }
  | { kind: "flee"; actor: string }
  | { kind: "position"; actor: string; to: "front" | "back" }
  | { kind: "wait"; actor: string }
  | { kind: "mark"; actor: string }
  | {
      kind: "ability";
      actor: string;
      ability_id: string;
      target?: string;
      position?: "front" | "back";
    }
  | { kind: "monster_act" }
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
  status: "victory" | "defeat";
  rewards: FighterReward[];
  monster_name: string;
  monster_tier: number;
  total_pool_xp: number;
  total_pool_gold: number;
  elite: boolean;
  is_boss: boolean;
  dungeon_room_cleared?: boolean;
  dungeon_doors?: Array<{ type: string; monster_name: string | null; scene: string | null }>;
}

type LogEntry =
  | { kind?: "entry"; id: number; content: React.ReactNode; tone: "info" | "good" | "bad" | "muted" | "flavor" }
  | { kind: "divider"; id: number; label: string }
  | {
      kind: "monster_hit"; id: number;
      monsterName: string; targetName: string;
      raw_damage: number; damage_after_armor: number;
      damage_after_position: number; shield_absorbed: number; hp_damage: number;
    };

interface UiState {
  connection: "connecting" | "open" | "closed";
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
  | { kind: "flavor"; value: { kind: "hit" | "victory" | "death" | "flee"; actor: string; text: string } };

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
  }
}

function formatEvent(e: CombatEvent, state: CombatState | null): UiState["log"] {
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
    tone: Extract<LogEntry, { kind?: "entry" }>["tone"],
  ): UiState["log"] => [{
    id: nextLogId++,
    content: icon ? <><Icon name={icon} /> {content}</> : content,
    tone,
  }];
  switch (e.type) {
    case "begin":
      return row("crossed-swords", "Combat begins. Rolling initiative…", "info");
    case "turn_start": {
      const actor = nameOf(e.actor);
      const label = actor === (state?.monsters[0]?.name ?? "monster")
        ? `Monster's Turn · Round ${e.round}`
        : `${actor}'s Turn · Round ${e.round}`;
      return [{ kind: "divider", id: nextLogId++, label }];
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
    case "monster_attack":
      return [{
        kind: "monster_hit" as const,
        id: nextLogId++,
        monsterName: state?.monsters[0]?.name ?? "Monster",
        targetName: nameOf(e.target),
        raw_damage: e.raw_damage,
        damage_after_armor: e.damage_after_armor,
        damage_after_position: e.damage_after_position,
        shield_absorbed: e.shield_absorbed,
        hp_damage: e.hp_damage,
      }];
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
    case "shield_applied":
      return row(
        "shield",
        <>{nameOf(e.actor)} → {nameOf(e.target)}: +{e.amount} shield{e.rolled > e.amount ? ` (rolled ${e.rolled}, capped)` : ""}</>,
        "good",
      );
    case "signature_used":
      return row("wax-seal", <>{nameOf(e.actor)} signature: {e.damage} dmg  [{e.formula}]  −{e.mana_spent} mana</>, "good");
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
        : e.effect === "poisoned" ? "monster-skull"
        : e.effect === "burning" ? "fire"
        : "bleeding-hearts";
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
      return row("cubes", <>Stasis container — monster will skip {e.swings} swing.</>, "good");
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
      return row("aura", <>Battle Hymn — next {e.charges_added} party attacks deal +{BARD_HYMN_BONUS} dmg.</>, "good");
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
            return <span key={f.id} style={{ marginRight: 8 }}>{dot} {nameOf(f.id)} {f.hp}/{f.max_hp}{f.shield > 0 ? <> +{f.shield}<Icon name="shield" /></> : ""}</span>;
          })}</>, "info")
        : [];
      const active = e.active;
      const effectNotes = active ? [
        (active.containerize ?? 0) > 0 && `Containerize ×${active.containerize}`,
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
      return row("cubes", "The monster's swing fizzles — containerized.", "good");
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
    case "battle_hymn_consumed":
      return row("aura", <>Hymn boosts {nameOf(e.actor)} by +{e.bonus} ({e.remaining} left).</>, "good");
    case "mark_applied":
      return row("targeted", <>{nameOf(e.actor)} marks the monster — party +{e.bonus} dmg until end of round {e.expires_after_round}.</>, "good");
    case "mark_bonus":
      return row("targeted", <>Focus-fire: +{e.bonus} dmg from {nameOf(e.actor)}.</>, "good");
    case "passive_warden_shield":
      return row("shield", <>{nameOf(e.actor)} hardens up — +{e.amount} shield (passive).</>, "good");
    case "passive_mage_free_sig":
      return row("wax-seal", <>{nameOf(e.actor)}'s first signature is free.</>, "good");
    case "passive_druid_regen":
      return row("grass", <>{nameOf(e.actor)} regen +{e.amount} HP (passive).</>, "good");
    case "passive_rogue_first_crit":
      return row("plain-dagger", <>{nameOf(e.actor)}'s first strike — guaranteed crit!</>, "good");
    case "passive_bard_aura":
      return row("aura", <>Bardic Aura: +{e.bonus} dmg from {nameOf(e.source)}'s song.</>, "good");
    case "passive_warlock_bleed":
      return [{
        id: nextLogId++,
        content: <><Icon name="death-skull" /> Cursed Strike: <Icon name="bleeding-hearts" color="#dc2626" /> bleed {e.magnitude}/turn × {e.duration} on monster.</>,
        tone: "good",
      }];
    case "passive_paladin_auto_heal":
      return row("fairy-wand", <>Lay on Hands: {nameOf(e.paladin)} → {nameOf(e.target)} +{e.amount} HP.</>, "good");
    case "drink_buff_consumed":
      if (e.kind === "buff_next_crit") {
        return row("lucky-fish", <>Lucky Sip — guaranteed crit, +{e.bonus} damage.{e.remaining === 0 ? " Buff wears off." : ""}</>, "good");
      }
      return row(
        "spell-book",
        <>{nameOf(e.actor)} drink buff: +{e.bonus} {e.kind === "buff_attack" ? "attack" : "magic"}{e.remaining === 0 ? " — wears off" : ` (${e.remaining} left)`}.</>,
        "good",
      );
    case "victory":
      return [{ id: nextLogId++, content: <strong>VICTORY</strong>, tone: "good" }];
    case "defeat":
      return [{ id: nextLogId++, content: <strong>DEFEAT</strong>, tone: "bad" }];
    case "rejected":
      return [{ id: nextLogId++, content: <>⚠ rejected: {e.reason}</>, tone: "bad" }];
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
}: {
  questId: number;
  selfId: string;
  onExit: () => void;
}) {
  const [ui, dispatch] = useReducer(reducer, {
    connection: "connecting",
    state: null,
    log: [],
    error: null,
    outcome: null,
  });
  const [picking, setPicking] = useState<"heal" | "shield" | null>(null);
  const [itemPicker, setItemPicker] = useState<"closed" | "open" | { reviveItemId: number }>("closed");
  const [migratePicker, setMigratePicker] = useState<boolean>(false);
  const [givePicker, setGivePicker] = useState<"closed" | "selectItem" | { itemId: number }>("closed");
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [autoResolve, setAutoResolve] = useState<boolean>(
    () => localStorage.getItem("combat_auto_resolve") === "true",
  );
  const autoResolveRef = useRef(autoResolve);
  // Tracks the last turn_index for which we fired an auto-resolve so we don't double-fire.
  const autoResolvedTurnRef = useRef<number>(-1);
  const [reconnectKey, setReconnectKey] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const logScrollRef = useRef<HTMLDivElement | null>(null);
  const [diceRolls, setDiceRolls] = useState<DiceRollEntry[]>([]);
  const diceRollCounterRef = useRef(0);
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
    dispatch({ kind: "connection", value: "connecting" });
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/ws/quest/${questId}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    // Heartbeat every 45s to keep the Cloudflare WS alive (60s idle limit).
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 45_000);

    ws.onopen = () => dispatch({ kind: "connection", value: "open" });
    ws.onclose = () => dispatch({ kind: "connection", value: "closed" });
    ws.onerror = () => {
      toast.error("WebSocket error");
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
              setDiceRolls((prev) => [...prev.slice(-5), entry]);
              setTimeout(() => setDiceRolls((prev) => prev.filter((r) => r.id !== id)), 14000);
            }
            // Fire passive toasts immediately so they appear while dice are visible.
            if (evt.type === "passive_rogue_first_crit") {
              toast("🗡 First Strike — guaranteed crit!", { icon: "⚡", duration: 4000 });
            } else if (evt.type === "passive_warden_shield") {
              toast(`🛡 Hardened Up — +${(evt as { amount: number }).amount} shield`, { duration: 3000 });
            } else if (evt.type === "passive_mage_free_sig") {
              toast("✨ First signature is free!", { duration: 3000 });
            } else if (evt.type === "passive_paladin_auto_heal") {
              toast(`💛 Lay on Hands — +${(evt as { amount: number }).amount} HP`, { duration: 3000 });
            }
          }
          // Refresh inventory after any item use so the picker reflects the new state.
          if (msg.events.some((evt: { type?: string }) => evt.type === "item_used")) {
            void loadItems();
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

  // Auto-resolve monster turn: fires monster_act ~800ms after the monster's turn
  // becomes active, so the player still sees the turn transition before it resolves.
  const { state: stateForAuto } = ui;
  useEffect(() => {
    if (!autoResolveRef.current) return;
    if (!stateForAuto || stateForAuto.status !== "active") return;
    const actorId = stateForAuto.turn_order[stateForAuto.turn_index % stateForAuto.turn_order.length];
    if (!isMonsterActor(actorId)) return;
    if (autoResolvedTurnRef.current === stateForAuto.turn_index) return;
    const timer = setTimeout(() => {
      if (!autoResolveRef.current) return;
      const fired = send({ kind: "monster_act" });
      if (fired) autoResolvedTurnRef.current = stateForAuto.turn_index;
    }, 800);
    return () => clearTimeout(timer);
    // autoResolve is in deps so flipping the checkbox on while a monster turn
    // is already active re-evaluates the effect and schedules a resolve.
  }, [stateForAuto?.turn_index, stateForAuto?.status, autoResolve]);

  function exit() {
    // Just navigate away — combat state stays in D1 so the player can resume
    // from the dashboard. Use the EndBanner's Abandon control (or the dashboard's
    // explicit abandon button) to actually clear web combat state.
    onExit();
  }

  const state = ui.state;
  const currentActorId =
    state && state.status === "active"
      ? state.turn_order[state.turn_index % state.turn_order.length]
      : null;
  const myTurn = currentActorId === selfId;
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
  const myAbility = me ? ABILITY_BY_CLASS[me.class] ?? null : null;
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

  function fireOnTarget(targetId: string) {
    if (!picking) return;
    send({ kind: picking, actor: selfId, target: targetId } as TurnAction);
    setPicking(null);
  }

  function fireUseItem(itemId: number, targetId?: string) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      toast.error("Disconnected — reconnecting. Try again in a moment.");
      return;
    }
    send({ kind: "use_item", actor: selfId, item_id: itemId, target_id: targetId });
    // Optimistically remove from local list; loadItems() confirms the real state
    // once the server broadcasts the item_used event.
    setItems((prev) => prev.filter((i) => i.id !== itemId));
    setItemPicker("closed");
  }

  function fireAbility() {
    if (!myAbility) return;
    if (myAbility.needs_migrate_picker) {
      setMigratePicker(true);
      return;
    }
    send({ kind: "ability", actor: selfId, ability_id: myAbility.id });
  }

  function fireMigrate(targetId: string, position: "front" | "back") {
    if (!myAbility) return;
    send({
      kind: "ability",
      actor: selfId,
      ability_id: myAbility.id,
      target: targetId,
      position,
    });
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

  return (
    <div style={page}>
      <div style={topBar}>
        <button onClick={exit} style={exitBtn}>
          ← Dashboard
        </button>
        <span style={{ fontSize: 12, color: ui.connection === "open" ? "#39ff14" : ui.connection === "connecting" ? "#9aa0a6" : "#fca5a5" }}>
          {ui.connection === "open" ? "● connected" : ui.connection === "connecting" ? "○ connecting" : "× disconnected"}
        </span>
      </div>

      {!state && (
        <div style={card}>
          <p style={muted}>Loading combat…</p>
          {ui.error && <p style={{ ...muted, color: "#c0392b" }}>{ui.error}</p>}
        </div>
      )}

      {state && (
        <div style={combatGrid}>
          {/* ── Left column: initiative · enemy · party ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <InitiativeTrack
              order={state.turn_order}
              currentIndex={state.turn_index % state.turn_order.length}
              fighters={state.fighters}
              monsters={state.monsters}
              selfId={selfId}
            />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {state.monsters.map((m, i) => (
                <MonsterCard
                  key={m.id ?? i}
                  monster={m}
                  round={state.round}
                  showSageReading={me?.class === "Staff Sage"}
                  isMarked={!!(state.ability_state?.mark && state.round <= state.ability_state.mark.expires_after_round)}
                  isTargeted={effectiveTarget !== null && (m.id ?? null) === effectiveTarget}
                  onClick={liveMonsters.length > 1 && m.hp > 0 ? () => setTargetMonsterId(m.id ?? null) : undefined}
                />
              ))}
            </div>
            {!myTurn && state.status === "active" && currentActorId !== null && isMonsterActor(currentActorId) && !autoResolve && (
              <button style={{ ...button, marginTop: 0, background: "#5c1f1f" }} onClick={() => send({ kind: "monster_act" })}>
                <Icon name="dragon-head" /> Resolve monster turn
              </button>
            )}
            {state.status === "active" && (
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#9098a8", cursor: "pointer", userSelect: "none" }}>
                <input
                  type="checkbox"
                  checked={autoResolve}
                  onChange={(e) => setAutoResolve(e.target.checked)}
                  style={{ accentColor: "#5c1f1f", cursor: "pointer" }}
                />
                Auto-resolve enemy turns
              </label>
            )}
            <PartySection fighters={state.fighters} currentActorId={currentActorId} selfId={selfId} />
          </div>

          {/* ── Right column: actions · log ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {state.status === "active" && picking && (
              <TargetPicker
                kind={picking}
                fighters={state.fighters}
                onPick={fireOnTarget}
                onCancel={() => setPicking(null)}
              />
            )}
            {state.status === "active" && itemPicker === "open" && (
              <ItemPicker
                items={items}
                onPickNoTarget={(id) => fireUseItem(id)}
                onPickRevive={(id) => setItemPicker({ reviveItemId: id })}
                onCancel={() => setItemPicker("closed")}
              />
            )}
            {state.status === "active" &&
              typeof itemPicker === "object" &&
              "reviveItemId" in itemPicker && (
                <ReviveTargetPicker
                  fighters={state.fighters}
                  onPick={(targetId) => fireUseItem(itemPicker.reviveItemId, targetId)}
                  onCancel={() => setItemPicker("open")}
                />
              )}
            {state.status === "active" && migratePicker && (
              <MigratePicker
                fighters={state.fighters}
                selfId={selfId}
                onPick={fireMigrate}
                onCancel={() => setMigratePicker(false)}
              />
            )}
            {state.status === "active" && givePicker === "selectItem" && (
              <GiveItemPicker
                items={items}
                onPickItem={(id) => setGivePicker({ itemId: id })}
                onCancel={() => setGivePicker("closed")}
              />
            )}
            {state.status === "active" && typeof givePicker === "object" && "itemId" in givePicker && (
              <GiveTargetPicker
                fighters={state.fighters}
                selfId={selfId}
                onPick={(toId) => void fireGive((givePicker as { itemId: number }).itemId, toId)}
                onCancel={() => setGivePicker("selectItem")}
              />
            )}
            {state.status === "active" && myTurn && liveMonsters.length > 1 && targetMonsterId === null && !picking && itemPicker === "closed" && !migratePicker && givePicker === "closed" && (
              <div style={{ ...card, textAlign: "center", padding: "10px 14px", borderColor: "#c084fc", background: "#1e1a2e" }}>
                <span style={{ color: "#e9d5ff", fontSize: 13, fontWeight: 600 }}>Pick a target</span>
                <span style={{ color: "#9ca3af", fontSize: 12, marginLeft: 8 }}>Click a monster above to select it</span>
              </div>
            )}
            {state.status === "active" && !picking && itemPicker === "closed" && !migratePicker && givePicker === "closed" && (
              <ActionBar
                disabled={!myTurn || (liveMonsters.length > 1 && targetMonsterId === null)}
                mana={myMana}
                hasItems={items.some((i) => isCombatUsable(i.item_type))}
                selfPosition={me?.position ?? "front"}
                ability={myAbility}
                onAct={(kind) => {
                  if (kind === "heal" || kind === "shield") {
                    // Solo quest: no one else to target, so skip the picker.
                    if (state.fighters.length === 1) {
                      send({ kind, actor: selfId, target: selfId } as TurnAction);
                    } else {
                      setPicking(kind);
                    }
                  } else if (kind === "use_item") {
                    setItemPicker("open");
                  } else if (kind === "swap_position") {
                    const to = me?.position === "front" ? "back" : "front";
                    send({ kind: "position", actor: selfId, to });
                  } else if (kind === "ability") {
                    fireAbility();
                  } else if (kind === "attack" || kind === "cast" || kind === "signature") {
                    send({ kind, actor: selfId, target_id: effectiveTarget } as TurnAction);
                  } else if (kind === "flee" || kind === "wait" || kind === "mark") {
                    send({ kind, actor: selfId } as TurnAction);
                  }
                }}
              />
            )}
            {state.status === "active" && givePicker === "closed" && !picking && itemPicker === "closed" && !migratePicker && items.some((i) => !i.equipped) && state.fighters.filter((f) => f.hp > 0 && f.id !== selfId).length > 0 && (
              <button
                onClick={() => setGivePicker("selectItem")}
                style={{
                  background: "none", border: "1px solid #3a3d44", borderRadius: 6,
                  color: "#9ca3af", cursor: "pointer", padding: "4px 10px",
                  fontSize: 11, fontFamily: "inherit", marginTop: 0,
                }}
              >
                <Icon name="ammo-bag" size={10} /> Give item to ally
              </button>
            )}
            <EventLog log={ui.log} scrollRef={logScrollRef} />
            {ended && state.status !== "victory" && !defeatModalReady && (
              <div style={{ ...card, borderColor: "#7c2020", background: "#28100f", textAlign: "center" }}>
                <div style={{ fontSize: 28, fontWeight: 800, color: "#fca5a5", fontFamily: DISPLAY_FONT }}>
                  <Icon name="death-skull" /> {state.status === "fled" ? "ESCAPED" : "DEFEAT"}
                </div>
                <p style={{ ...muted, fontSize: 13 }}>Resolving outcome…</p>
              </div>
            )}
          </div>
        </div>
      )}

      <DiceRollDisplay rolls={diceRolls} />

      {/* Victory modal — delayed until dice settle */}
      {ended && state?.status === "victory" && victoryModalReady && (
        <VictoryModal
          outcome={ui.outcome}
          selfId={selfId}
          fighters={state.fighters}
          questId={questId}
          onBack={exit}
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

      {/* Disconnection warning — only when combat is still live */}
      {ui.connection === "closed" && !ended && (
        <DisconnectedModal onReconnect={() => setReconnectKey((k) => k + 1)} />
      )}
    </div>
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
  isMarked = false,
  isTargeted = false,
  onClick,
}: {
  monster: Monster;
  round: number;
  showSageReading: boolean;
  isMarked?: boolean;
  isTargeted?: boolean;
  onClick?: () => void;
}) {
  // Sage's Reading — passive tells the Sage the monster's tier-derived swing range.
  const sageLo = 1 + monster.tier;
  const sageHi = 6 + monster.tier + (monster.is_boss && monster.boss_phase === 2 ? monster.tier : 0);
  return (
    <div
      style={{ ...card, borderColor: isTargeted ? "#b89b3a" : isMarked ? "#f59e0b" : "#7c2020", boxShadow: isTargeted ? "0 0 0 2px #fbbf24" : undefined, display: "flex", gap: 16, alignItems: "flex-start", position: "relative", cursor: onClick ? "pointer" : undefined, transition: "border-color 0.15s, box-shadow 0.15s" }}
      onClick={onClick}
    >
      {/* Marked target indicator */}
      {isMarked && (
        <div style={{
          position: "absolute",
          top: -10,
          right: -10,
          width: 36,
          height: 36,
          borderRadius: "50%",
          background: "#78350f",
          border: "2px solid #f59e0b",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 10,
          boxShadow: "0 0 12px #f59e0b80",
        }}>
          <Icon name="targeted" size={20} color="#fbbf24" />
        </div>
      )}
      {/* Portrait */}
      <Avatar
        src={monster.art_url}
        alt={monster.name}
        size={96}
        radius={10}
        fallbackIcon="dragon-head"
        fallbackColor={isMarked ? "#f59e0b" : "#7c2020"}
        border={`1px solid ${isMarked ? "#f59e0b" : "#7c2020"}`}
        style={{ flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#f5f5f5", fontFamily: DISPLAY_FONT }}>{monster.name}</div>
            <div style={{ ...muted, fontSize: 12 }}>
              Tier {monster.tier}
              {monster.is_boss && ` · Boss (phase ${monster.boss_phase})`}
              {monster.wave && monster.total_waves && ` · Wave ${monster.wave}/${monster.total_waves}`}
              {` · Round ${round}`}
            </div>
          </div>
          <div style={{ ...muted, fontVariantNumeric: "tabular-nums" }}>
            {monster.hp} / {monster.max_hp}
          </div>
        </div>
        <BigHpBar current={monster.hp} max={monster.max_hp} />
        {showSageReading && (
          <div style={{ ...muted, fontSize: 11, marginTop: 6 }}>
            <Icon name="scroll-unfurled" /> Sage's Reading: next swing ~{sageLo}–{sageHi} HP
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
                  fallbackIcon={isMon ? "dragon-head" : "player"}
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

function FighterHpRow({ hp, maxHp, shield }: { hp: number; maxHp: number; shield: number }) {
  const pct = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
  const color = pct < 0.25 ? "#dc2626" : pct < 0.5 ? "#d97706" : "#16a34a";
  return (
    <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 8, background: "#0e0f12", borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: `${pct * 100}%`, height: "100%", background: color, transition: "width 0.3s ease" }} />
      </div>
      <div style={{ ...muted, fontSize: 11, minWidth: 48, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {hp}/{maxHp}
        {shield > 0 && <span style={{ color: "#7c83ff", marginLeft: 4 }}>+{shield}</span>}
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
        padding: 12,
        background: "#1d1f23",
        borderRadius: 8,
        border: current ? "1px solid #b89b3a" : self ? "1px solid #3a7bd5" : "1px solid transparent",
        opacity: down ? 0.5 : 1,
        display: "flex",
        gap: 12,
        alignItems: "stretch",
      }}
    >
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
        {/* Status effects */}
        {fighter.effects && fighter.effects.length > 0 && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 4, marginTop: 2 }}>
            {fighter.effects.map((e, i) => {
              const [color, icon] = e.type === "regen" ? ["#4ade80", "regeneration"]
                : e.type === "bleeding" ? ["#f87171", "bleeding-hearts"]
                : e.type === "burning" ? ["#fb923c", "fire"]
                : ["#c084fc", "poison-cloud"];
              return (
                <span
                  key={i}
                  title={`${e.type} ×${e.magnitude} (${e.remaining} turns${e.source ? ` — ${e.source}` : ""})`}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 3,
                    background: `${color}22`, border: `1px solid ${color}55`,
                    borderRadius: 4, padding: "1px 5px",
                    fontSize: 10, color, fontWeight: 600,
                  }}
                >
                  <Icon name={icon} size={9} /> {e.magnitude}×{e.remaining}t
                </span>
              );
            })}
          </div>
        )}
        {/* HP bar row — matches mana bar layout so numbers stay column-aligned */}
        <FighterHpRow hp={fighter.hp} maxHp={fighter.max_hp} shield={fighter.shield} />
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

type ActionKind =
  | "attack"
  | "cast"
  | "heal"
  | "shield"
  | "signature"
  | "flee"
  | "wait"
  | "use_item"
  | "swap_position"
  | "mark"
  | "ability";

// Class → active ability spec. Mirrors packages/core/src/flavor.ts ABILITIES.
// Kept inline here to avoid coupling the page to the core barrel.
interface AbilityUiSpec {
  id: string;
  name: string;
  iconName: string;            // rpg-awesome ra-* class
  mana_cost: number;
  blurb: string;
  // migrate is the only ability that needs a target+position picker.
  needs_migrate_picker?: boolean;
}

const ABILITY_BY_CLASS: Record<string, AbilityUiSpec> = {
  "SRE Warden":      { id: "taunt",              name: "Taunt",             iconName: "shield",           mana_cost: 2, blurb: "Monster targets you for 2 swings" },
  "DevOps Mage":     { id: "containerize",       name: "Containerize",      iconName: "cubes",            mana_cost: 2, blurb: "Monster skips next swing" },
  "QA Paladin":      { id: "regression_shield",  name: "Regression Shield", iconName: "fairy-wand",       mana_cost: 2, blurb: "+3 shield to all party" },
  "Refactor Rogue":  { id: "vanish",             name: "Vanish",            iconName: "player-dodge",     mana_cost: 2, blurb: "Untargetable for 2 swings" },
  "Data Wizard":     { id: "soul_drain",         name: "Soul Drain",        iconName: "death-skull",      mana_cost: 2, blurb: "1d6+mag dmg, heal 50%" },
  "Data Warlock":    { id: "soul_drain",         name: "Soul Drain",        iconName: "death-skull",      mana_cost: 2, blurb: "1d6+mag dmg, heal 50%" }, // legacy alias
  "Frontend Bard":   { id: "battle_hymn",        name: "Battle Hymn",       iconName: "aura",             mana_cost: 2, blurb: `+${BARD_HYMN_BONUS} dmg on next N party attacks (N scales with level)` },
  "Staff Sage":      { id: "foresee",            name: "Foresee",           iconName: "scroll-unfurled",  mana_cost: 1, blurb: "Full battle intel: next target, net damage, party triage, targeting odds. Persists 2 turns." },
  "Backend Druid":   { id: "migrate",            name: "Migrate",           iconName: "grass",            mana_cost: 1, blurb: "Move a partymate to front/back", needs_migrate_picker: true },
};

// Items the worker has dispatch for in handleUseItem. Tools / scrolls are
// catalog-dispatched, so even though we filter by type here, the worker
// can still reject named items it doesn't yet support (e.g. Crowbar,
// Production Outage) — UI surfaces the error message inline.
function isCombatUsable(t: string): boolean {
  return (
    t === "consumable" ||
    t === "magic" ||
    t === "revive" ||
    t === "tool" ||
    t === "scroll"
  );
}

function ActionBar({
  disabled,
  mana,
  hasItems,
  selfPosition,
  ability,
  onAct,
}: {
  disabled: boolean;
  mana: number;
  hasItems: boolean;
  selfPosition: "front" | "back";
  ability: AbilityUiSpec | null;
  onAct: (kind: ActionKind) => void;
}) {
  const otherRow = selfPosition === "front" ? "back" : "front";
  return (
    <div style={{ ...card, display: "flex", gap: 8, flexWrap: "wrap" }}>
      <ActionBtn label={<><Icon name="sword" /> Attack</>} hint="d20+atk vs AC · 1d6 dmg" disabled={disabled} onClick={() => onAct("attack")} />
      <ActionBtn label={<><Icon name="arcing-bolt" /> Cast</>} hint="d20+mag vs AC · 1d8 dmg" disabled={disabled} onClick={() => onAct("cast")} />
      <ActionBtn
        label={<><Icon name="wax-seal" /> Sig</>}
        hint={mana > 0 ? "Class signature · 1 mana" : "No mana"}
        disabled={disabled || mana < 1}
        onClick={() => onAct("signature")}
      />
      {ability && (
        <ActionBtn
          label={<><Icon name={ability.iconName} /> {ability.name}</>}
          hint={mana >= ability.mana_cost ? `${ability.blurb} · ${ability.mana_cost} mana` : "Not enough mana"}
          disabled={disabled || mana < ability.mana_cost}
          onClick={() => onAct("ability")}
        />
      )}
      <ActionBtn label={<><Icon name="health-increase" /> Heal</>} hint="1d6+mag · pick target" disabled={disabled} onClick={() => onAct("heal")} />
      <ActionBtn label={<><Icon name="shield" /> Shield</>} hint="1d6+mag · pick target" disabled={disabled} onClick={() => onAct("shield")} />
      <ActionBtn
        label={<><Icon name="ammo-bag" /> Item</>}
        hint={hasItems ? "Consumable / magic / revive / tool / scroll" : "Nothing usable"}
        disabled={disabled || !hasItems}
        onClick={() => onAct("use_item")}
      />
      <ActionBtn
        label={<><Icon name={otherRow === "front" ? "muscle-up" : "fall-down"} /> {otherRow === "front" ? "To front" : "To back"}</>}
        hint={otherRow === "front" ? "Soak hits · full damage" : "Less hit risk · 60% dmg taken"}
        disabled={disabled}
        onClick={() => onAct("swap_position")}
      />
      <ActionBtn label={<><Icon name="targeted" /> Mark</>} hint="Party gets +2 dmg on monster for 2 rounds" disabled={disabled} onClick={() => onAct("mark")} />
      <ActionBtn label={<><Icon name="footprint" /> Flee</>} hint="d20+mod vs DC 10+tier" disabled={disabled} onClick={() => onAct("flee")} />
      <ActionBtn label={<><Icon name="hourglass" /> Wait</>} hint="Skip your turn" disabled={disabled} onClick={() => onAct("wait")} />
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
  return (
    <div style={card}>
      <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}><Icon name="grass" /> Migrate — who and where?</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        {fighters
          .filter((f) => f.hp > 0)
          .map((f) => (
            <button
              key={f.id}
              onClick={() => setTargetId(f.id)}
              style={{
                ...button,
                background: targetId === f.id ? "#2a5a3a" : "#222",
                fontSize: 13,
              }}
            >
              {f.name} · {f.position}
            </button>
          ))}
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <button
          onClick={() => setPosition("front")}
          style={{ ...button, background: position === "front" ? "#2a5a3a" : "#222", fontSize: 13 }}
        >
          <Icon name="muscle-up" /> Front
        </button>
        <button
          onClick={() => setPosition("back")}
          style={{ ...button, background: position === "back" ? "#2a5a3a" : "#222", fontSize: 13 }}
        >
          <Icon name="fall-down" /> Back
        </button>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          onClick={() => onPick(targetId, position)}
          disabled={alreadyThere}
          style={{ ...button, opacity: alreadyThere ? 0.5 : 1 }}
        >
          Migrate
        </button>
        <button onClick={onCancel} style={{ ...button, background: "#444" }}>
          Cancel
        </button>
      </div>
      {alreadyThere && (
        <div style={{ ...muted, fontSize: 12, marginTop: 6 }}>
          Already in {position} row.
        </div>
      )}
    </div>
  );
}

function combatItemEffect(item: InventoryItem): React.ReactNode {
  const p = item.power;
  switch (item.item_type) {
    case "consumable": return <>Restores {p} HP. Single-use.</>;
    case "magic":      return <>+{p} max mana permanently (capped at 5).</>;
    case "revive":     return <>Revive a downed ally to {p}% HP.</>;
    case "tool":
    case "scroll":     return <>Combat tool (power {p}).</>;
    default:           return <>+{p} power.</>;
  }
}

function ItemPicker({
  items,
  onPickNoTarget,
  onPickRevive,
  onCancel,
}: {
  items: InventoryItem[];
  onPickNoTarget: (id: number) => void;
  onPickRevive: (id: number) => void;
  onCancel: () => void;
}) {
  const usable = items.filter((i) => isCombatUsable(i.item_type));
  return (
    <div style={card}>
      <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}><Icon name="ammo-bag" /> Use which?</div>
      {usable.length === 0 && (
        <p style={{ ...muted, fontSize: 13 }}>Nothing usable in combat.</p>
      )}
      <div style={{ display: "grid", gap: 8 }}>
        {usable.map((it) => (
          <button
            key={it.id}
            onClick={() => {
              if (it.item_type === "revive") onPickRevive(it.id);
              else onPickNoTarget(it.id);
            }}
            style={{
              ...button,
              marginTop: 0,
              padding: "10px 14px",
              background: "#1d1f23",
              border: "1px solid #2a2d33",
              textAlign: "left",
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: 4,
            }}
          >
            <span style={{ display: "flex", justifyContent: "space-between", width: "100%", alignItems: "baseline" }}>
              <span style={{ fontWeight: 600 }}>{it.item_name}</span>
              <span style={{ ...muted, fontSize: 11 }}>{it.rarity}</span>
            </span>
            <span style={{ fontSize: 12, color: "#86efac" }}>
              {combatItemEffect(it)}
            </span>
            {it.flavor && (
              <span style={{ ...muted, fontSize: 11, fontStyle: "italic" }}>
                "{it.flavor}"
              </span>
            )}
          </button>
        ))}
      </div>
      <button
        onClick={onCancel}
        style={{ ...button, marginTop: 8, background: "transparent", border: "1px solid #2a2d33", color: "#9aa0a6" }}
      >
        Cancel
      </button>
    </div>
  );
}

function ReviveTargetPicker({
  fighters,
  onPick,
  onCancel,
}: {
  fighters: Fighter[];
  onPick: (id: string) => void;
  onCancel: () => void;
}) {
  const downed = fighters.filter((f) => f.hp <= 0);
  return (
    <div style={card}>
      <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}><Icon name="crowned-heart" /> Revive who?</div>
      {downed.length === 0 && (
        <p style={{ ...muted, fontSize: 13 }}>No downed allies.</p>
      )}
      <div style={{ display: "grid", gap: 8 }}>
        {downed.map((f) => (
          <button
            key={f.id}
            onClick={() => onPick(f.id)}
            style={{
              ...button,
              marginTop: 0,
              padding: "10px 14px",
              background: "#1d1f23",
              border: "1px solid #2a2d33",
              textAlign: "left",
            }}
          >
            {f.name} <span style={{ ...muted, fontSize: 12 }}>· {f.class}</span>
          </button>
        ))}
      </div>
      <button
        onClick={onCancel}
        style={{ ...button, marginTop: 8, background: "transparent", border: "1px solid #2a2d33", color: "#9aa0a6" }}
      >
        Back
      </button>
    </div>
  );
}

function GiveItemPicker({
  items,
  onPickItem,
  onCancel,
}: {
  items: InventoryItem[];
  onPickItem: (id: number) => void;
  onCancel: () => void;
}) {
  const giveable = items.filter((i) => !i.equipped);
  return (
    <div style={card}>
      <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}><Icon name="ammo-bag" /> Give which item?</div>
      {giveable.length === 0 && <p style={{ ...muted, fontSize: 13 }}>No items to give.</p>}
      <div style={{ display: "grid", gap: 8 }}>
        {giveable.map((it) => (
          <button
            key={it.id}
            onClick={() => onPickItem(it.id)}
            style={{
              ...button, marginTop: 0, padding: "8px 12px",
              background: "#1d1f23", border: "1px solid #2a2d33",
              textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "baseline",
            }}
          >
            <span style={{ fontWeight: 600 }}>{it.item_name}</span>
            <span style={{ ...muted, fontSize: 11 }}>+{it.power} · {it.rarity}</span>
          </button>
        ))}
      </div>
      <button onClick={onCancel} style={{ ...button, marginTop: 8, background: "transparent", border: "1px solid #2a2d33", color: "#9aa0a6" }}>Cancel</button>
    </div>
  );
}

function GiveTargetPicker({
  fighters,
  selfId,
  onPick,
  onCancel,
}: {
  fighters: Fighter[];
  selfId: string;
  onPick: (id: string) => void;
  onCancel: () => void;
}) {
  const eligible = fighters.filter((f) => f.hp > 0 && f.id !== selfId);
  return (
    <div style={card}>
      <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}><Icon name="player" /> Give to who?</div>
      {eligible.length === 0 && <p style={{ ...muted, fontSize: 13 }}>No alive allies.</p>}
      <div style={{ display: "grid", gap: 8 }}>
        {eligible.map((f) => (
          <button
            key={f.id}
            onClick={() => onPick(f.id)}
            style={{
              ...button, marginTop: 0, padding: "10px 14px",
              background: "#1d1f23", border: "1px solid #2a2d33", textAlign: "left",
            }}
          >
            {f.name} <span style={{ ...muted, fontSize: 12 }}>· {f.class}</span>
          </button>
        ))}
      </div>
      <button onClick={onCancel} style={{ ...button, marginTop: 8, background: "transparent", border: "1px solid #2a2d33", color: "#9aa0a6" }}>Back</button>
    </div>
  );
}

function TargetPicker({
  kind,
  fighters,
  onPick,
  onCancel,
}: {
  kind: "heal" | "shield";
  fighters: Fighter[];
  onPick: (id: string) => void;
  onCancel: () => void;
}) {
  // Only valid for living fighters (heal/shield can't target a downed
  // character — revive will handle that when it lands).
  const targets = fighters.filter((f) => f.hp > 0);
  const label = kind === "heal"
    ? <><Icon name="health-increase" /> Heal who?</>
    : <><Icon name="shield" /> Shield who?</>;
  return (
    <div style={{ ...card }}>
      <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}>{label}</div>
      <div style={{ display: "grid", gap: 8 }}>
        {targets.map((f) => (
          <button
            key={f.id}
            onClick={() => onPick(f.id)}
            style={{
              ...button,
              marginTop: 0,
              padding: "10px 14px",
              background: "#1d1f23",
              border: "1px solid #2a2d33",
              textAlign: "left",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>
              {f.name}{" "}
              <span style={{ ...muted, fontSize: 12 }}>
                · {f.class}
              </span>
            </span>
            <span style={{ ...muted, fontVariantNumeric: "tabular-nums" }}>
              {f.hp}/{f.max_hp}
              {f.shield > 0 && <span style={{ color: "#7c83ff" }}> +{f.shield}</span>}
            </span>
          </button>
        ))}
      </div>
      <button
        onClick={onCancel}
        style={{ ...button, marginTop: 8, background: "transparent", border: "1px solid #2a2d33", color: "#9aa0a6" }}
      >
        Cancel
      </button>
    </div>
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

function MonsterHitEntry({ line }: { line: Extract<LogEntry, { kind: "monster_hit" }> }) {
  const [open, setOpen] = useState(false);
  const armorReduction = line.raw_damage - line.damage_after_armor;
  const positionReduction = line.damage_after_armor - line.damage_after_position;

  const tags: string[] = [];
  if (armorReduction > 0) tags.push(`−${armorReduction} armor`);
  if (positionReduction > 0) tags.push(`−${positionReduction} back row`);
  if (line.shield_absorbed > 0) tags.push(`−${line.shield_absorbed} shield`);

  const badColor = TONE_COLOR["bad"];
  const mutedColor = TONE_COLOR["muted"];

  return (
    <div style={{ color: badColor }}>
      <span>
        <Icon name="fire-symbol" />{" "}
        {line.monsterName} hits {line.targetName} for{" "}
        <strong>{line.hp_damage} HP</strong>
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
          <span>⚔ Raw damage</span><span style={{ color: "#e5e7eb" }}>{line.raw_damage}</span>
          {armorReduction > 0 && <>
            <span>🛡 Armor</span>
            <span>−{armorReduction} → <span style={{ color: "#e5e7eb" }}>{line.damage_after_armor}</span></span>
          </>}
          {positionReduction > 0 && <>
            <span>↩ Back row</span>
            <span>−{positionReduction} → <span style={{ color: "#e5e7eb" }}>{line.damage_after_position}</span></span>
          </>}
          {line.shield_absorbed > 0 && <>
            <span>🔷 Shield</span>
            <span>−{line.shield_absorbed} absorbed</span>
          </>}
          <span style={{ borderTop: "1px solid #2a2d33", paddingTop: 3 }}>❤ HP lost</span>
          <span style={{ borderTop: "1px solid #2a2d33", paddingTop: 3, color: badColor, fontWeight: 600 }}>{line.hp_damage}</span>
        </div>
      )}
    </div>
  );
}

function EventLog({
  log,
  scrollRef,
}: {
  log: UiState["log"];
  scrollRef: React.MutableRefObject<HTMLDivElement | null>;
}) {
  return (
    <div style={card}>
      <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8 }}>
        Combat log
      </div>
      <div
        ref={scrollRef}
        style={{
          maxHeight: 280,
          overflowY: "auto",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 13,
          background: "#0e0f12",
          borderRadius: 8,
          padding: 12,
          display: "grid",
          gap: 4,
        }}
      >
        {log.length === 0 && <span style={muted}>Waiting for events…</span>}
        {log.map((line) => {
          if (line.kind === "divider") {
            return (
              <div key={line.id} style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                margin: "6px 0 2px",
                color: "#4b5563",
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: 1,
              }}>
                <div style={{ flex: 1, height: 1, background: "#2a2d33" }} />
                {line.label}
                <div style={{ flex: 1, height: 1, background: "#2a2d33" }} />
              </div>
            );
          }
          if (line.kind === "monster_hit") {
            return <MonsterHitEntry key={line.id} line={line} />;
          }
          return (
            <div key={line.id} style={{ color: TONE_COLOR[line.tone ?? "info"] }}>

              {line.content}
            </div>
          );
        })}
      </div>
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
}: {
  outcome: OutcomeSummary | null;
  selfId: string;
  fighters: Fighter[];
  questId: number;
  onBack: () => void;
}) {
  const [choosingDoor, setChoosingDoor] = useState(false);
  const dungeonRoom = outcome?.dungeon_room_cleared;
  const dungeonDoors = outcome?.dungeon_doors;
  const hasDoorChoice = dungeonRoom && dungeonDoors && dungeonDoors.length > 0;
  const title = dungeonRoom ? "ROOM CLEARED" : "VICTORY";

  async function pickDoor(pick: number) {
    if (choosingDoor) return;
    setChoosingDoor(true);
    try {
      await fetch(`/api/quest/${questId}/dungeon/choose_door`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pick }),
      });
    } finally {
      onBack();
    }
  }

  return (
    <>
    <ConfettiOverlay />
    <div style={{
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.88)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 100,
      padding: 24,
    }}>
      <div style={{
        background: "#0f2818",
        border: "2px solid #16a34a",
        borderRadius: 16,
        padding: 32,
        maxWidth: 520,
        width: "100%",
        maxHeight: "85vh",
        overflowY: "auto",
        boxSizing: "border-box",
      }}>
        <div style={{ fontSize: 36, fontWeight: 800, color: "#86efac", textAlign: "center", marginBottom: 4, fontFamily: DISPLAY_FONT }}>
          {title}
        </div>
        {!outcome && <p style={{ ...muted, textAlign: "center" }}>Resolving outcome…</p>}
        {outcome && (
          <>
            {(outcome.is_boss || outcome.elite) && (
              <div style={{ ...muted, fontSize: 12, textAlign: "center", marginBottom: 12 }}>
                {outcome.is_boss && "Boss "}{outcome.elite && "Elite "} pool: {outcome.total_pool_xp} XP · {outcome.total_pool_gold}g
              </div>
            )}
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
            {hasDoorChoice && (
              <div style={{ marginBottom: 16 }}>
                <p style={{ ...muted, fontSize: 13, textAlign: "center", marginBottom: 12 }}>
                  🚪 Two paths diverge ahead. Choose your next room:
                </p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  {dungeonDoors.map((door, i) => {
                    const dirs = ["🧭 North", "🧭 East", "🧭 South", "🧭 West"];
                    const dir = dirs[i] ?? `🧭 Door ${i + 1}`;
                    const roomLabel = door.type === "combat"
                      ? `⚔️ ${door.monster_name ?? "Combat"}`
                      : door.type === "treasure"
                      ? "🎁 Treasure"
                      : door.type === "boss"
                      ? `💀 ${door.monster_name ?? "Boss"}`
                      : door.type === "npc"
                      ? "🧙 NPC"
                      : door.type === "trap"
                      ? "⚠️ Trap"
                      : door.type === "lockbox"
                      ? "🔒 Lockbox"
                      : "Room";
                    return (
                      <button
                        key={i}
                        disabled={choosingDoor}
                        onClick={() => void pickDoor(i + 1)}
                        style={{
                          ...button,
                          background: "#1a3a4a",
                          border: "1.5px solid #38bdf8",
                          color: "#e0f2fe",
                          padding: "14px 10px",
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          gap: 4,
                          opacity: choosingDoor ? 0.6 : 1,
                        }}
                      >
                        <span style={{ fontSize: 13, fontFamily: DISPLAY_FONT, color: "#7dd3fc" }}>{dir}</span>
                        <span style={{ fontSize: 12 }}>{roomLabel}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {dungeonRoom && !hasDoorChoice && (
              <p style={{ ...muted, fontSize: 12, textAlign: "center", marginBottom: 12 }}>
                Room cleared. Check the dashboard for the next room.
              </p>
            )}
          </>
        )}
        {!hasDoorChoice && (
          <button onClick={onBack} style={{ ...button, marginTop: 8, background: "#16a34a" }}>
            Back to town
          </button>
        )}
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

function LootCard({ item, index }: { item: LootDrop; index: number }) {
  const color = RARITY_COLOR[item.rarity] ?? "#9aa0a6";
  const icon  = LOOT_ICON[item.item_type] ?? "chest";
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
          {item.item_name}
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
        {reward.damage_dealt > 0 && <span style={{ color: "#f87171" }}>⚔ {reward.damage_dealt} dealt</span>}
        {reward.damage_taken > 0 && <span style={{ color: "#94a3b8" }}>🛡 {reward.damage_taken} taken</span>}
        {reward.healing_done > 0 && <span style={{ color: "#4ade80" }}>💚 {reward.healing_done} healed</span>}
        {reward.shielding_done > 0 && <span style={{ color: "#7dd3fc" }}>🔷 {reward.shielding_done} shielded</span>}
        {reward.kills > 0 && <span style={{ color: "#facc15" }}>🏆 killing blow</span>}
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

// ─── 2D dice ───────────────────────────────────────────────────────────────

interface DiceRollEntry {
  id: number;
  die: string;
  value: number;
  actor: string;
  purpose: string;
}

// Inject tumble + fade keyframes once into the document head.
let _diceStylesInjected = false;
function injectDiceStyles() {
  if (_diceStylesInjected || typeof document === "undefined") return;
  _diceStylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    @keyframes dice-roll-in {
      0%   { transform: rotate(0deg)   scale(0)    translateY(-40px); opacity: 0; }
      55%  { transform: rotate(630deg) scale(1.14) translateY(0);     opacity: 1; }
      75%  { transform: rotate(705deg) scale(0.93); }
      88%  { transform: rotate(716deg) scale(1.06); }
      100% { transform: rotate(720deg) scale(1); }
    }
    @keyframes dice-fade-out {
      0%   { opacity: 1; transform: scale(1)   translateY(0);   }
      100% { opacity: 0; transform: scale(0.7) translateY(18px); }
    }
  `;
  document.head.appendChild(s);
}

// SVG polygons for each die type. Viewbox is 0 0 100 100.
const DIE_SHAPE: Record<string, { points: string; textY: number }> = {
  d4:  { points: "50,6 96,90 4,90",                                textY: 70 },
  d6:  { points: "8,8 92,8 92,92 8,92",                            textY: 56 },
  d8:  { points: "50,4 96,50 50,96 4,50",                          textY: 56 },
  d10: { points: "50,4 93,34 76,90 24,90 7,34",                    textY: 58 },
  d12: { points: "50,4 91,27 98,70 70,96 30,96 2,70 9,27",         textY: 58 },
  d20: { points: "50,4 91,28 91,72 50,96 9,72 9,28",               textY: 56 },
};
const DEFAULT_SHAPE = DIE_SHAPE.d20;

// Pip positions [col, row] in a 3×3 grid (0=left/top, 1=center, 2=right/bottom).
const D6_PIPS: Record<number, [number, number][]> = {
  1: [[1,1]],
  2: [[0,0],[2,2]],
  3: [[0,0],[1,1],[2,2]],
  4: [[0,0],[2,0],[0,2],[2,2]],
  5: [[0,0],[2,0],[1,1],[0,2],[2,2]],
  6: [[0,0],[2,0],[0,1],[2,1],[0,2],[2,2]],
};

function DiceRollDisplay({ rolls }: { rolls: DiceRollEntry[] }) {
  useEffect(() => { injectDiceStyles(); }, []);
  if (rolls.length === 0) return null;
  const enemyRolls = rolls.filter((r) => isMonsterActor(r.actor));
  const partyRolls = rolls.filter((r) => !isMonsterActor(r.actor));
  const rowStyle: React.CSSProperties = {
    display: "flex",
    gap: 14,
    flexWrap: "wrap",
    justifyContent: "center",
    alignItems: "flex-start",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 9,
    color: "#6b7280",
    textTransform: "uppercase",
    letterSpacing: 1.5,
    fontFamily: "ui-monospace, monospace",
    textAlign: "center",
    marginBottom: 6,
  };
  return (
    <div style={{
      position: "fixed",
      bottom: 40,
      left: "50%",
      transform: "translateX(-50%)",
      display: "flex",
      flexDirection: "column",
      gap: 28,
      zIndex: 200,
      pointerEvents: "none",
    }}>
      {enemyRolls.length > 0 && (
        <div>
          <div style={{ ...labelStyle, color: "#9c4242" }}>Enemy</div>
          <div style={rowStyle}>
            {enemyRolls.map((r) => <DiceFace key={r.id} roll={r} />)}
          </div>
        </div>
      )}
      {partyRolls.length > 0 && (
        <div>
          <div style={{ ...labelStyle, color: "#4a7c8c" }}>Party</div>
          <div style={rowStyle}>
            {partyRolls.map((r) => <DiceFace key={r.id} roll={r} />)}
          </div>
        </div>
      )}
    </div>
  );
}

const PURPOSE_LABEL: Record<string, string> = {
  hit_check:      "To Hit",
  damage_attack:  "Damage",
  damage_cast:    "Spell Dmg",
  damage_monster: "Monster Dmg",
  signature:      "Signature",
  heal:           "Healing",
  shield:         "Shield",
  flee_check:     "Escape",
  initiative:     "Initiative",
};

function DiceFace({ roll }: { roll: DiceRollEntry }) {
  const maxFace = parseInt(roll.die.replace("d", ""), 10) || 20;
  const shape   = DIE_SHAPE[roll.die] ?? DEFAULT_SHAPE;
  const isD6    = roll.die === "d6";

  const [display,  setDisplay]  = useState<number>(() => Math.ceil(Math.random() * maxFace));
  const [settled,  setSettled]  = useState(false);
  const [fading,   setFading]   = useState(false);

  // Shuffle for ~650ms then snap to the real value.
  useEffect(() => {
    let count = 0;
    const total = 13;
    const iv = setInterval(() => {
      count++;
      if (count >= total) {
        clearInterval(iv);
        setDisplay(roll.value);
        setSettled(true);
      } else {
        setDisplay(Math.ceil(Math.random() * maxFace));
      }
    }, 50);
    // Begin fade-out after 10s.
    const fadeTimer = setTimeout(() => setFading(true), 10000);
    return () => { clearInterval(iv); clearTimeout(fadeTimer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roll.id]);

  const isCrit   = roll.die === "d20" && roll.value === maxFace;
  const isFumble = roll.die === "d20" && roll.value === 1;

  const strokeColor = settled
    ? (isCrit ? "#22c55e" : isFumble ? "#ef4444" : "#7dd3fc")
    : "#4a5568";
  const fillColor   = settled
    ? (isCrit ? "#052e12" : isFumble ? "#2e0505" : "#0d1b2e")
    : "#111827";
  const numColor    = settled
    ? (isCrit ? "#86efac" : isFumble ? "#fca5a5" : "#f5f5f5")
    : "#6b7280";

  const SIZE = 92;

  return (
    <div style={{
      width: SIZE,
      height: SIZE,
      position: "relative",
      filter: settled ? `drop-shadow(0 0 8px ${strokeColor}60)` : "none",
      animationName: fading ? "dice-fade-out" : "dice-roll-in",
      animationDuration: fading ? "350ms" : "700ms",
      animationTimingFunction: fading ? "ease-in" : "cubic-bezier(0.22,1,0.36,1)",
      animationFillMode: "forwards",
      transition: "filter 200ms",
    }}>
      {/* Die shape */}
      <svg
        width={SIZE} height={SIZE}
        viewBox="0 0 100 100"
        style={{ position: "absolute", top: 0, left: 0 }}
      >
        <polygon
          points={shape.points}
          fill={fillColor}
          stroke={strokeColor}
          strokeWidth={settled ? 3.5 : 2.5}
          strokeLinejoin="round"
          style={{ transition: "fill 150ms, stroke 150ms" }}
        />
        {/* Die label inside the shape */}
        <text
          x="50" y="16"
          textAnchor="middle"
          fontSize="9"
          fill="#6b7280"
          fontFamily="ui-monospace, monospace"
          letterSpacing="1"
          style={{ textTransform: "uppercase" }}
        >
          {roll.die.toUpperCase()}
        </text>
      </svg>

      {/* Value — pips for d6, number for everything else */}
      <div style={{
        position: "absolute",
        top: 0, left: 0,
        width: SIZE, height: SIZE,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}>
        {isD6 && settled ? (
          <D6Pips value={display} color={numColor} />
        ) : (
          <span style={{
            fontSize: roll.die === "d4" ? 22 : 28,
            fontWeight: 900,
            color: numColor,
            fontVariantNumeric: "tabular-nums",
            lineHeight: 1,
            transition: "color 200ms",
            fontFamily: "ui-monospace, monospace",
          }}>
            {display}
          </span>
        )}
      </div>

      {/* Purpose label below shape after settling */}
      {settled && roll.purpose && (
        <div style={{
          position: "absolute",
          bottom: -18,
          left: "50%",
          transform: "translateX(-50%)",
          fontSize: 10,
          color: "#9ca3af",
          whiteSpace: "nowrap",
          fontFamily: "system-ui, sans-serif",
          letterSpacing: 0.3,
          fontWeight: 500,
        }}>
          {PURPOSE_LABEL[roll.purpose] ?? roll.purpose}
        </div>
      )}
    </div>
  );
}

function D6Pips({ value, color }: { value: number; color: string }) {
  const pips = D6_PIPS[Math.min(6, Math.max(1, value))] ?? [];
  const cells: [number, number][] = [[0,0],[1,0],[2,0],[0,1],[1,1],[2,1],[0,2],[1,2],[2,2]];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 12px)", gap: 5 }}>
      {cells.map(([c, r]) => {
        const active = pips.some(([pc, pr]) => pc === c && pr === r);
        return (
          <div key={`${c},${r}`} style={{
            width: 10, height: 10, borderRadius: "50%",
            background: active ? color : "transparent",
            transition: "background 100ms",
          }} />
        );
      })}
    </div>
  );
}

// ─── styles + helpers ──────────────────────────────────────────────────────

// Animated HP bar — the lost portion flashes red then shrinks away.
function HpBarCore({
  current,
  max,
  height,
  borderRadius,
  marginTop,
  healthColor,
}: {
  current: number;
  max: number;
  height: number;
  borderRadius: number;
  marginTop: number;
  healthColor: (pct: number) => string;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  const color = healthColor(pct);
  const prevPctRef = useRef(pct);
  // damagePct: the "ghost" segment (right of the current bar) that flashes red
  const [damagePct, setDamagePct] = useState(0);
  const [damageVisible, setDamageVisible] = useState(false);

  useEffect(() => {
    const prev = prevPctRef.current;
    if (pct < prev - 0.001) {
      const lost = prev - pct;
      setDamagePct(lost);
      setDamageVisible(true);
      // After 500ms flash, begin shrink by hiding
      const hide = setTimeout(() => setDamageVisible(false), 500);
      // After transition completes, zero out
      const clear = setTimeout(() => setDamagePct(0), 1100);
      prevPctRef.current = pct;
      return () => { clearTimeout(hide); clearTimeout(clear); };
    }
    prevPctRef.current = pct;
  }, [pct]);

  return (
    <div style={{
      marginTop,
      width: "100%",
      height,
      background: "#0e0f12",
      borderRadius,
      overflow: "hidden",
      position: "relative",
    }}>
      {/* Current HP */}
      <div style={{
        position: "absolute", left: 0, top: 0,
        width: `${pct * 100}%`, height: "100%",
        background: color,
        transition: "width 300ms ease",
        zIndex: 1,
      }} />
      {/* Damage ghost — sits right of current bar, flashes then shrinks */}
      {damagePct > 0 && (
        <div style={{
          position: "absolute",
          left: `${pct * 100}%`,
          top: 0,
          width: damageVisible ? `${damagePct * 100}%` : "0%",
          height: "100%",
          background: "#ef4444",
          transition: damageVisible ? "none" : "width 600ms ease",
          zIndex: 2,
          opacity: damageVisible ? 1 : 0,
        }} />
      )}
    </div>
  );
}

function BigHpBar({ current, max }: { current: number; max: number }) {
  return (
    <HpBarCore
      current={current}
      max={max}
      height={14}
      borderRadius={7}
      marginTop={10}
      healthColor={(pct) => pct < 0.25 ? "#dc2626" : pct < 0.5 ? "#d97706" : "#16a34a"}
    />
  );
}

function HpBar({ current, max }: { current: number; max: number }) {
  return (
    <HpBarCore
      current={current}
      max={max}
      height={8}
      borderRadius={4}
      marginTop={6}
      healthColor={(pct) => pct < 0.25 ? "#dc2626" : pct < 0.5 ? "#d97706" : "#16a34a"}
    />
  );
}

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

const TONE_COLOR: Record<string, string> = {
  info: "#e6e6e6",
  good: "#86efac",
  bad: "#fca5a5",
  muted: "#9aa0a6",
  flavor: "#f5d390",
};

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
