import { useEffect, useReducer, useRef, useState } from "react";
import toast from "react-hot-toast";

import DiceBox from "@3d-dice/dice-box";
import "@3d-dice/dice-box/dist/style.css";

import { Icon } from "./icons";

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
  monster: Monster;
  turn_order: string[];
  turn_index: number;
  round: number;
  status: "pending" | "active" | "victory" | "defeat" | "fled";
}

const MONSTER_ID = "__monster__";

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
  "Data Warlock": "data_warlock",
};
function classPortraitUrl(className: string): string | null {
  const id = CLASS_ID_BY_NAME[className];
  return id ? `${CLASS_PORTRAIT_BASE}/class_${id}.png` : null;
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
  | { type: "victory" }
  | { type: "defeat" }
  | { type: "rejected"; reason: string }
  | ItemUsedEvent;

type TurnAction =
  | { kind: "attack"; actor: string }
  | { kind: "cast"; actor: string }
  | { kind: "heal"; actor: string; target: string }
  | { kind: "shield"; actor: string; target: string }
  | { kind: "signature"; actor: string }
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
}

interface FighterReward {
  user_id: string;
  damage_dealt: number;
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
}

interface UiState {
  connection: "connecting" | "open" | "closed";
  state: CombatState | null;
  log: { id: number; content: React.ReactNode; tone: "info" | "good" | "bad" | "muted" | "flavor" }[];
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
    case "events":
      return {
        ...s,
        log: [...s.log, ...a.value.flatMap((e) => formatEvent(e, s.state))].slice(-50),
      };
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
    if (id === MONSTER_ID) return state?.monster.name ?? "monster";
    return state?.fighters.find((f) => f.id === id)?.name ?? id;
  };
  const row = (
    icon: string | null,
    content: React.ReactNode,
    tone: UiState["log"][number]["tone"],
  ): UiState["log"] => [{
    id: nextLogId++,
    content: icon ? <><Icon name={icon} /> {content}</> : content,
    tone,
  }];
  switch (e.type) {
    case "begin":
      return row("crossed-swords", "Combat begins. Rolling initiative…", "info");
    case "turn_start":
      return row("perspective-dice-one", <>{nameOf(e.actor)}'s turn (round {e.round})</>, "muted");
    case "roll":
      return row("perspective-dice-six", <>{nameOf(e.actor)} rolled {e.die} → {e.value}  ·  {e.purpose}</>, "muted");
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
      return row(
        "fire-symbol",
        <>monster → {nameOf(e.target)}: {e.hp_damage} hp
          {e.shield_absorbed > 0 ? ` (+${e.shield_absorbed} shield)` : ""}
          {e.damage_after_position !== e.damage_after_armor
            ? ` [pos→ -${e.damage_after_armor - e.damage_after_position} mit]`
            : ""}
        </>,
        "bad",
      );
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
      return row("fairy-wand", <>{nameOf(e.actor)} signature: {e.damage} dmg  [{e.formula}]  −{e.mana_spent} mana</>, "good");
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
        return [{ id: nextLogId++, content: <>{head}: {eff.amount} dmg to {state?.monster.name ?? "monster"}{note}</>, tone: "good" }];
      } else if (eff.kind === "self_effect") {
        return [{
          id: nextLogId++,
          content: <>{head}: {nameOf(eff.target)} gains <Icon name="aura" color="#16a34a" /> regen +{eff.magnitude} × {eff.remaining}</>,
          tone: "good",
        }];
      } else if (eff.kind === "monster_effect") {
        return [{
          id: nextLogId++,
          content: <>{head}: {state?.monster.name ?? "monster"} <Icon name="monster-skull" color="#a855f7" /> {eff.effect} {eff.magnitude} × {eff.remaining}</>,
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
      const summary = e.grants.length === 0
        ? "everyone at cap"
        : e.grants.map((g) => `+${g.amount} ${nameOf(g.target)}`).join(", ");
      return row("fairy-wand", <>Regression Shield — {summary}.</>, "good");
    }
    case "ability_vanish":
      return row("plain-dagger", <>{nameOf(e.actor)} vanishes — untargetable for {e.swings} swings.</>, "good");
    case "ability_soul_drain":
      return row("death-skull", <>Soul Drain: {e.damage} dmg, +{e.healed} HP  [{e.formula}]</>, "good");
    case "ability_battle_hymn":
      return row("aura", <>Battle Hymn — next {e.charges_added} party attacks deal +2 dmg.</>, "good");
    case "ability_foresee": {
      const who = e.predicted_target ? nameOf(e.predicted_target) : "no committed target";
      return row("scroll-unfurled", <>Foresee — monster looks ready to hit {who} for ~{e.damage_lo}-{e.damage_hi} HP.</>, "info");
    }
    case "ability_migrate":
      return row("grass", <>{nameOf(e.actor)} shifts {nameOf(e.target)} to the {e.to} row.</>, "info");
    case "monster_swing_skipped":
      return row("cubes", "The monster's swing fizzles — containerized.", "good");
    case "monster_target_redirected":
      return row(
        e.reason === "taunt" ? "shield" : "plain-dagger",
        e.reason === "taunt"
          ? <>Taunt redirects: {nameOf(e.from)} → {nameOf(e.to)}</>
          : <>Vanish slips {nameOf(e.from)} — monster picks {nameOf(e.to)} instead.</>,
        "good",
      );
    case "monster_target_blocked":
      return row(
        "plain-dagger",
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
      return row("crystal-wand", <>{nameOf(e.actor)}'s first signature is free.</>, "good");
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
    case "victory":
      return [{ id: nextLogId++, content: <strong>VICTORY</strong>, tone: "good" }];
    case "defeat":
      return [{ id: nextLogId++, content: <strong>DEFEAT</strong>, tone: "bad" }];
    case "rejected":
      return [{ id: nextLogId++, content: <>⚠ rejected: {e.reason}</>, tone: "bad" }];
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
  const [items, setItems] = useState<InventoryItem[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const logScrollRef = useRef<HTMLDivElement | null>(null);
  const diceContainerRef = useRef<HTMLDivElement | null>(null);
  const diceBoxRef = useRef<any>(null);
  const diceInitStartedRef = useRef(false);
  const diceReadyRef = useRef(false);
  const pendingDiceRollsRef = useRef<string[]>([]);
  const [diceReady, setDiceReady] = useState(false);

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

  // Initialize DiceBox once the container div is in the DOM. The container
  // is only rendered after the first `state` message arrives, so we depend
  // on `state` to re-run until the div exists. `diceInitStartedRef` (not
  // `diceBoxRef`, which cleanup clears) prevents re-init on every update.
  useEffect(() => {
    if (diceInitStartedRef.current) return;
    if (!diceContainerRef.current) return;
    diceInitStartedRef.current = true;
    let box: InstanceType<typeof DiceBox> | null = null;
    try {
      box = new DiceBox(diceContainerRef.current, {
        assetPath: "/assets/dice-box/",
      });
      diceBoxRef.current = box;
    } catch {
      toast.error("Failed to initialize dice animation.");
      return;
    }
    box.init()
      .then(() => {
        diceReadyRef.current = true;
        setDiceReady(true);
        for (const notation of pendingDiceRollsRef.current) {
          diceBoxRef.current?.roll(notation);
        }
        pendingDiceRollsRef.current = [];
      })
      .catch(() => {
        toast.error("Failed to initialize dice animation.");
      });
    return () => {
      if (box && typeof box.destroy === "function") {
        box.destroy();
        diceBoxRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.state]);

  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/ws/quest/${questId}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => dispatch({ kind: "connection", value: "open" });
    ws.onclose = () => dispatch({ kind: "connection", value: "closed" });
    ws.onerror = () => {
      toast.error("WebSocket error");
      dispatch({ kind: "error", value: "WebSocket error" });
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as
          | { type: "state"; state: CombatState }
          | { type: "events"; events: CombatEvent[] }
          | { type: "error"; message: string }
          | { type: "outcome"; outcome: OutcomeSummary }
          | { type: "flavor"; flavor: { kind: "hit" | "victory" | "death" | "flee"; actor: string; text: string } }
          | { type: "log_replay"; events: unknown[] };
        if (msg.type === "state") dispatch({ kind: "state", value: msg.state });
        else if (msg.type === "events") {
          dispatch({ kind: "events", value: msg.events });
          for (const evt of msg.events) {
            if (evt.type === "roll") {
              const notation = `${evt.die}`;
              if (diceReadyRef.current && diceBoxRef.current) {
                diceBoxRef.current.roll(notation);
              } else {
                pendingDiceRollsRef.current.push(notation);
              }
            }
          }
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
      ws.close();
      wsRef.current = null;
    };
  }, [questId]);

  // Auto-scroll log to bottom as new entries arrive.
  useEffect(() => {
    const el = logScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ui.log.length]);

  function send(action: TurnAction) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "action", action }));
  }

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
  const me = state?.fighters.find((f) => f.id === selfId);
  const myMana = me?.mana ?? 0;
  const myAbility = me ? ABILITY_BY_CLASS[me.class] ?? null : null;

  function fireOnTarget(targetId: string) {
    if (!picking) return;
    send({ kind: picking, actor: selfId, target: targetId } as TurnAction);
    setPicking(null);
  }

  function fireUseItem(itemId: number, targetId?: string) {
    send({ kind: "use_item", actor: selfId, item_id: itemId, target_id: targetId });
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
          {/* ── Left column: enemy · initiative · party · dice ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <MonsterCard
              monster={state.monster}
              round={state.round}
              showSageReading={me?.class === "Staff Sage"}
            />
            {!myTurn && state.status === "active" && currentActorId === MONSTER_ID && (
              <button style={{ ...button, marginTop: 0, background: "#5c1f1f" }} onClick={() => send({ kind: "monster_act" })}>
                ⚔️ Resolve monster turn
              </button>
            )}
            <InitiativeTrack
              order={state.turn_order}
              currentIndex={state.turn_index % state.turn_order.length}
              fighters={state.fighters}
              monster={state.monster}
              selfId={selfId}
            />
            <PartySection fighters={state.fighters} currentActorId={currentActorId} selfId={selfId} />
            <div
              ref={diceContainerRef}
              style={{
                width: "100%",
                minHeight: 200,
                borderRadius: 12,
                overflow: "hidden",
                background: "#111",
              }}
            />
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
            {state.status === "active" && !picking && itemPicker === "closed" && !migratePicker && (
              <ActionBar
                disabled={!myTurn}
                mana={myMana}
                hasItems={items.some((i) => isCombatUsable(i.item_type))}
                selfPosition={me?.position ?? "front"}
                ability={myAbility}
                onAct={(kind) => {
                  if (kind === "heal" || kind === "shield") {
                    setPicking(kind);
                  } else if (kind === "use_item") {
                    setItemPicker("open");
                  } else if (kind === "swap_position") {
                    const to = me?.position === "front" ? "back" : "front";
                    send({ kind: "position", actor: selfId, to });
                  } else if (kind === "ability") {
                    fireAbility();
                  } else if (kind === "signature" || kind === "flee" || kind === "attack" || kind === "cast" || kind === "wait" || kind === "mark") {
                    send({ kind, actor: selfId } as TurnAction);
                  }
                }}
              />
            )}
            <EventLog log={ui.log} scrollRef={logScrollRef} />
            {ended && state.status !== "victory" && (
              <EndBanner
                status={state.status as "defeat" | "fled"}
                outcome={ui.outcome}
                selfId={selfId}
                fighters={state.fighters}
              />
            )}
          </div>
        </div>
      )}

      {/* Victory modal — overlays everything */}
      {ended && state?.status === "victory" && (
        <VictoryModal
          outcome={ui.outcome}
          selfId={selfId}
          fighters={state.fighters}
          onBack={exit}
        />
      )}
    </div>
  );
}

function MonsterCard({
  monster,
  round,
  showSageReading,
}: {
  monster: Monster;
  round: number;
  showSageReading: boolean;
}) {
  // Sage's Reading — passive tells the Sage the monster's tier-derived swing range.
  const sageLo = 1 + monster.tier;
  const sageHi = 6 + monster.tier + (monster.is_boss && monster.boss_phase === 2 ? monster.tier : 0);
  return (
    <div style={{ ...card, borderColor: "#7c2020", display: "flex", gap: 16, alignItems: "flex-start" }}>
      {monster.art_url ? (
        <img
          src={monster.art_url}
          alt={monster.name}
          style={{
            width: 96,
            height: 96,
            borderRadius: 10,
            objectFit: "cover",
            flexShrink: 0,
            border: "1px solid #7c2020",
          }}
          onError={(e) => { e.currentTarget.style.display = "none"; }}
        />
      ) : (
        <div style={{
          width: 96, height: 96, borderRadius: 10, flexShrink: 0,
          background: "#1d1f23", border: "1px solid #7c2020",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <Icon name="dragon-head" size={40} color="#7c2020" />
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#f5f5f5" }}>{monster.name}</div>
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
  monster,
  selfId,
}: {
  order: string[];
  currentIndex: number;
  fighters: Fighter[];
  monster: Monster;
  selfId: string;
}) {
  return (
    <div style={card}>
      <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8 }}>
        Initiative
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {order.map((id, i) => {
          const name = id === MONSTER_ID ? monster.name : fighters.find((f) => f.id === id)?.name ?? id;
          const init = id === MONSTER_ID ? monster.initiative : fighters.find((f) => f.id === id)?.initiative ?? 0;
          const isCurrent = i === currentIndex;
          const isSelf = id === selfId;
          return (
            <div
              key={id}
              style={{
                padding: "8px 12px",
                borderRadius: 20,
                background: isCurrent ? "#b89b3a" : "#1d1f23",
                color: isCurrent ? "#0e0f12" : "#e6e6e6",
                fontSize: 13,
                fontWeight: 600,
                border: isSelf && !isCurrent ? "1px solid #3a7bd5" : "1px solid transparent",
              }}
            >
              {name} · {init}
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

function FighterRow({ fighter, self, current }: { fighter: Fighter; self: boolean; current: boolean }) {
  const down = fighter.hp <= 0;
  const portrait = classPortraitUrl(fighter.class);
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
      {portrait ? (
        <img
          src={portrait}
          alt={`${fighter.class} portrait`}
          style={{
            width: 56,
            height: 56,
            borderRadius: 6,
            objectFit: "cover",
            border: "1px solid #2a2d33",
            flexShrink: 0,
            alignSelf: "center",
          }}
          onError={(e) => { e.currentTarget.style.display = "none"; }}
        />
      ) : (
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 6,
            background: "#0e0f12",
            border: "1px solid #2a2d33",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            alignSelf: "center",
            flexShrink: 0,
          }}
        >
          <Icon name="player" size={28} color="#6a7080" />
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 14 }}>{fighter.name}</span>
            {fighter.slack_username && (
              <span style={{ fontSize: 12, color: "#7dd3fc" }}>@{fighter.slack_username}</span>
            )}
            <span style={{ ...muted, fontSize: 12 }}>
              {fighter.class} · <span title={fighter.scars.length > 0 ? fighter.scars.join(", ") : undefined}>Lv {fighter.level}</span>
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
          <div style={{ ...muted, fontVariantNumeric: "tabular-nums" }}>
            {fighter.hp}/{fighter.max_hp}
            {fighter.shield > 0 && (
              <span style={{ color: "#7c83ff", marginLeft: 6 }}>+{fighter.shield}</span>
            )}
          </div>
        </div>
        <HpBar current={fighter.hp} max={fighter.max_hp} />
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
            <div style={{ ...muted, fontSize: 11, minWidth: 36, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
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
  "Refactor Rogue":  { id: "vanish",             name: "Vanish",            iconName: "plain-dagger",     mana_cost: 2, blurb: "Untargetable for 2 swings" },
  "Data Warlock":    { id: "soul_drain",         name: "Soul Drain",        iconName: "death-skull",      mana_cost: 2, blurb: "1d6+mag dmg, heal 50%" },
  "Frontend Bard":   { id: "battle_hymn",        name: "Battle Hymn",       iconName: "aura",             mana_cost: 2, blurb: "+2 dmg on next 2 party attacks" },
  "Staff Sage":      { id: "foresee",            name: "Foresee",           iconName: "scroll-unfurled",  mana_cost: 1, blurb: "Read monster's next target" },
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
      <ActionBtn label={<><Icon name="crystal-ball" /> Cast</>} hint="d20+mag vs AC · 1d8 dmg" disabled={disabled} onClick={() => onAct("cast")} />
      <ActionBtn
        label={<><Icon name="fairy-wand" /> Sig</>}
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

function ItemPicker({
  items,
  onPickNoTarget,
  onPickRevive,
  onCancel,
}: {
  items: InventoryItem[];
  onPickNoTarget: (id: number) => void;       // consumable / magic / tool / scroll
  onPickRevive: (id: number) => void;          // needs a target picker step
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
              gap: 2,
            }}
          >
            <span style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
              <span style={{ fontWeight: 600 }}>{it.item_name}</span>
              <span style={{ ...muted, fontSize: 12 }}>
                {it.item_type} · {it.rarity} · +{it.power}
              </span>
            </span>
            {it.flavor && (
              <span style={{ ...muted, fontSize: 11, fontStyle: "italic" }}>
                {it.flavor}
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
          fontSize: 12,
          background: "#0e0f12",
          borderRadius: 8,
          padding: 12,
          display: "grid",
          gap: 4,
        }}
      >
        {log.length === 0 && <span style={muted}>Waiting for events…</span>}
        {log.map((line) => (
          <div key={line.id} style={{ color: TONE_COLOR[line.tone] }}>
            {line.content}
          </div>
        ))}
      </div>
    </div>
  );
}

function VictoryModal({
  outcome,
  selfId,
  fighters,
  onBack,
}: {
  outcome: OutcomeSummary | null;
  selfId: string;
  fighters: Fighter[];
  onBack: () => void;
}) {
  const dungeonRoom = outcome?.dungeon_room_cleared;
  const title = dungeonRoom ? "ROOM CLEARED" : "VICTORY";
  return (
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
        <div style={{ fontSize: 36, fontWeight: 800, color: "#86efac", textAlign: "center", marginBottom: 4 }}>
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
            {dungeonRoom && (
              <p style={{ ...muted, fontSize: 12, textAlign: "center", marginBottom: 12 }}>
                Room cleared. Use Slack /gq choose to pick the next door.
              </p>
            )}
          </>
        )}
        <button onClick={onBack} style={{ ...button, marginTop: 8, background: "#16a34a" }}>
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
      <div style={{ fontSize: 32, fontWeight: 800, color: fg }}>{labelText}</div>
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
          <span style={{ ...muted, fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
            · {reward.damage_dealt} dmg
          </span>
        </div>
        <div style={{ fontSize: 13, fontVariantNumeric: "tabular-nums", color: "#e6e6e6" }}>
          {won
            ? `+${reward.xp_awarded} XP · +${reward.gold_awarded}g`
            : reward.soft_death
              ? "downed"
              : "—"}
        </div>
      </div>
      {reward.level_up && (
        <div style={{ marginTop: 6, fontSize: 13, color: "#facc15", fontWeight: 600 }}>
          ⭐ Level {reward.new_level}!
        </div>
      )}
      {reward.loot.length > 0 && (
        <div style={{ marginTop: 6, display: "grid", gap: 4 }}>
          {reward.loot.map((it, i) => (
            <div key={i} style={{ fontSize: 12, color: "#86efac" }}>
              🎁 {it.item_name} · {it.rarity} {it.item_type} +{it.power}
            </div>
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

function BigHpBar({ current, max }: { current: number; max: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  const color = pct < 0.25 ? "#fca5a5" : pct < 0.5 ? "#fbbf24" : "#ef4444";
  return (
    <div
      style={{
        marginTop: 10,
        width: "100%",
        height: 14,
        background: "#0e0f12",
        borderRadius: 7,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${pct * 100}%`,
          height: "100%",
          background: color,
          transition: "width 200ms ease",
        }}
      />
    </div>
  );
}

function HpBar({ current, max }: { current: number; max: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  const color = pct < 0.25 ? "#dc2626" : pct < 0.5 ? "#d97706" : "#16a34a";
  return (
    <div
      style={{
        marginTop: 6,
        width: "100%",
        height: 8,
        background: "#0e0f12",
        borderRadius: 4,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${pct * 100}%`,
          height: "100%",
          background: color,
          transition: "width 200ms ease",
        }}
      />
    </div>
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
