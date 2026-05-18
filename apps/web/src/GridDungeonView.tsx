// Grid-based dungeon view — first-person crawl through a 2D grid of rooms.
// Replaces the legacy linear expedition. Renders shape-aware room backgrounds,
// a true 2D minimap, compass navigation (N/E/S/W), door interactions with
// keys/pick/bash, and room content overlays.

import { useEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import toast from "react-hot-toast";
import { isMonsterActor } from "@gantt-quest/core";
import { Avatar, Icon } from "./icons";

const DISPLAY_FONT = "'Metamorphous', serif";

// Minimap and combat log share a fixed width on the right side of the room
// view (~1/8 of viewport on desktop). On mobile they move to the bottom.
function useIsMobile(breakpoint = 700): boolean {
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.innerWidth < breakpoint);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < breakpoint);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [breakpoint]);
  return isMobile;
}

// Inject hit-flash keyframes once. The animation lasts ~550ms; cards get a
// "hit-flash" class for that long when their target is hit by an attack.
const HIT_FLASH_CSS = `
@keyframes gq-hit-shake {
  0%   { transform: translate(0, 0); }
  10%  { transform: translate(-5px, -2px); }
  20%  { transform: translate(5px, 2px); }
  30%  { transform: translate(-4px, 1px); }
  40%  { transform: translate(4px, -1px); }
  55%  { transform: translate(-2px, 0); }
  70%  { transform: translate(2px, 0); }
  100% { transform: translate(0, 0); }
}
@keyframes gq-hit-tint {
  0%   { box-shadow: inset 0 0 0 0 rgba(239,68,68,0); }
  20%  { box-shadow: inset 0 0 0 9999px rgba(239,68,68,0.45); }
  60%  { box-shadow: inset 0 0 0 9999px rgba(239,68,68,0.28); }
  100% { box-shadow: inset 0 0 0 0 rgba(239,68,68,0); }
}
.gq-hit-flash {
  animation: gq-hit-shake 550ms ease-in-out, gq-hit-tint 550ms ease-out;
}
/* Monster lunge — when the enemy attacks, its card pushes downward
   (toward the player) and snaps back. Communicates the swing. The
   *-card variant operates in the card's own space (translate Y only)
   so it works inside MonsterStrip's flex layout without depending on
   the old absolute -50%/-65% centering. */
@keyframes gq-monster-lunge-card {
  0%   { transform: translateY(0); }
  35%  { transform: translateY(20px) scale(1.04); }
  60%  { transform: translateY(10px) scale(1.02); }
  100% { transform: translateY(0); }
}
.gq-monster-lunge-card {
  animation: gq-monster-lunge-card 520ms cubic-bezier(0.22, 1.4, 0.36, 1) both;
}
/* Slash effect when a player lands a hit on the enemy. A diagonal white
   streak sweeps across the monster card; lasts ~420ms then fades. The
   streak element re-keys per hit so each shot fires a fresh animation. */
@keyframes gq-slash-sweep {
  0%   { opacity: 0; transform: translate(-110%, -50%) rotate(-22deg) scaleX(0.6); }
  18%  { opacity: 1; }
  60%  { opacity: 0.9; transform: translate(110%, -50%) rotate(-22deg) scaleX(1.4); }
  100% { opacity: 0; transform: translate(130%, -50%) rotate(-22deg) scaleX(1.4); }
}
.gq-slash-streak {
  position: absolute;
  top: 50%; left: 0;
  width: 70%;
  height: 6px;
  background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.9) 30%, rgba(254,202,202,1) 50%, rgba(255,255,255,0.9) 70%, transparent 100%);
  filter: drop-shadow(0 0 8px rgba(252,165,165,0.9)) drop-shadow(0 0 14px rgba(239,68,68,0.55));
  pointer-events: none;
  transform-origin: 50% 50%;
  animation: gq-slash-sweep 420ms ease-out forwards;
  border-radius: 6px;
}
/* Monster defeat — fall backwards, fade out, shrink. Triggered when HP
   reaches 0 so the card lingers for ~1.1s before unmounting. The
   *-card variant uses card-local transforms (no absolute centering)
   so each MonsterCard in a strip falls independently. */
@keyframes gq-monster-defeated-card {
  0%   { transform: rotateX(0deg) scale(1) translateY(0); opacity: 1; filter: brightness(1) saturate(1); }
  25%  { transform: rotateX(-12deg) scale(1.03) translateY(0); opacity: 1; filter: brightness(1.35) saturate(1.4); }
  70%  { transform: rotateX(-65deg) scale(0.92) translateY(40px); opacity: 0.55; filter: brightness(0.6) saturate(0.4); }
  100% { transform: rotateX(-85deg) scale(0.78) translateY(55px); opacity: 0; filter: brightness(0.2) saturate(0); }
}
.gq-monster-defeated-card {
  animation: gq-monster-defeated-card 1100ms cubic-bezier(0.45, 0, 0.65, 1) forwards;
  transform-style: preserve-3d;
  perspective: 600px;
}
/* Targeted-card pulse — subtle gold inner glow on the picked enemy.
   Pairs with the gold border so the active target is obvious even
   while another monster is animating. */
@keyframes gq-target-pulse {
  0%, 100% { box-shadow: 0 0 16px rgba(251,191,36,0.4), inset 0 0 0 0 rgba(251,191,36,0); }
  50%      { box-shadow: 0 0 22px rgba(251,191,36,0.55), inset 0 0 12px 0 rgba(251,191,36,0.15); }
}
.gq-monster-targeted {
  animation: gq-target-pulse 1800ms ease-in-out infinite;
}
/* Victory / defeat overlay enters with a staged fade so it doesn't just
   appear on top of the monster animation. Tint fades up first, then the
   banner pops; the whole thing reads as a beat rather than a cut. */
@keyframes gq-outcome-tint {
  0%   { opacity: 0; backdrop-filter: blur(0); }
  100% { opacity: 1; backdrop-filter: blur(4px); }
}
@keyframes gq-outcome-banner {
  0%   { opacity: 0; transform: scale(0.7) translateY(20px); letter-spacing: 0; }
  60%  { opacity: 1; transform: scale(1.12) translateY(0); letter-spacing: 6px; }
  100% { opacity: 1; transform: scale(1) translateY(0); letter-spacing: 3px; }
}
.gq-outcome-tint { animation: gq-outcome-tint 700ms ease-out both; animation-delay: 600ms; }
.gq-outcome-banner { animation: gq-outcome-banner 900ms cubic-bezier(0.22, 1.4, 0.36, 1) both; animation-delay: 900ms; }
`;

if (typeof document !== "undefined" && !document.getElementById("gq-hit-flash-style")) {
  const s = document.createElement("style");
  s.id = "gq-hit-flash-style";
  s.textContent = HIT_FLASH_CSS;
  document.head.appendChild(s);
}

// ─── Types mirrored from db (the web app doesn't import db directly) ─────────

type DungeonDirection = "n" | "e" | "s" | "w";
type KeyTier = "bronze" | "silver" | "gold";
type RoomShape =
  | "dead_n" | "dead_e" | "dead_s" | "dead_w"
  | "straight_ns" | "straight_ew"
  | "corner_ne" | "corner_nw" | "corner_se" | "corner_sw"
  | "t_n" | "t_e" | "t_s" | "t_w"
  | "cross" | "chamber" | "entry" | "boss";

interface GridDoor {
  state: "open" | "locked" | "barred" | "broken";
  lock_tier?: KeyTier;
  pick_dc?: number;
  bash_dc?: number;
}

interface MonsterSpec { name: string; hp: number; max_hp: number; tier: number; is_boss?: boolean; art_url?: string | null; flavor?: string | null }
interface LootOption {
  name: string;
  item_type: string;
  power: number;
  rarity: string;
  flavor: string;
  slot?: string | null;
  stat_bonus?: Record<string, number> | null;
  weapon_range?: "melee" | "ranged" | "focus" | null;
  item_subtype?: string | null;
}
interface TrapChoice { text: string; emoji: string; skill: "str" | "dex" | "int"; fail_damage: number }

type GridRoomContent =
  | { kind: "empty" }
  | { kind: "entry" }
  | { kind: "encounter"; monsters: MonsterSpec[]; cleared: boolean }
  | { kind: "boss"; monsters: MonsterSpec[]; cleared: boolean; treasure: LootOption[] }
  | { kind: "loot"; items: LootOption[]; taken: boolean }
  | { kind: "key_pickup"; tier: KeyTier; taken: boolean }
  | { kind: "trap"; choices: TrapChoice[]; resolved: boolean }
  | { kind: "lockbox"; lock_tier: KeyTier; options: LootOption[]; resolved: boolean }
  | { kind: "npc"; greeting: string; offer: LootOption; resolved: boolean; art_url?: string | null }
  | { kind: "merchant"; greeting: string; stock: LootOption[]; resolved: boolean; art_url?: string | null };

interface GridNode {
  id: string;
  description: string;
  exits: Partial<Record<DungeonDirection, string>>;
  doors?: Partial<Record<DungeonDirection, GridDoor>>;
  content?: GridRoomContent;
  shape?: RoomShape;
  x?: number;
  y?: number;
  visited: boolean;
  // Legacy AI-graph dungeons (pre-grid) populate `encounter` instead of
  // `content`. Tracked here so we can render Engage / monster overlay for
  // legacy in-flight quests.
  encounter?: { monsters: MonsterSpec[]; cleared: boolean };
}

interface GridGraph {
  nodes: Record<string, GridNode>;
  current: string;
  visited: string[];
  grid_width?: number;
  grid_height?: number;
}

interface SceneJson {
  monster_name: string;
  monster_hp: number;
  monster_max_hp: number;
  tier: number;
  scene: string;
  variant?: string;
  monster_art_url?: string | null;
  graph?: GridGraph;
}

interface Character {
  slack_user_id: string;
  slack_username: string | null;
  name: string;
  class: string;
  level: number;
  hp: number;
  max_hp: number;
  mana: number;
  max_mana: number;
  shield: number;
  keys_bronze: number;
  keys_silver: number;
  keys_gold: number;
  position: "front" | "back";
}

// ─── Combat WS types (subset, mirrors CombatPage) ───────────────────────────

interface StatusEffect { type: "regen" | "bleeding" | "burning" | "poisoned"; magnitude: number; remaining: number }

interface Fighter {
  id: string; name: string; class: string; level: number;
  hp: number; max_hp: number; mana: number; max_mana: number; shield: number;
  position: "front" | "back"; attack_mod: number; magic_mod: number;
  weapon_power: number; armor_power: number; initiative: number;
  effects: StatusEffect[]; scars: string[];
}

interface Monster {
  id?: string; name: string; hp: number; max_hp: number; tier: number;
  initiative: number; effects: StatusEffect[]; is_boss: boolean;
  boss_phase: 1 | 2; art_url?: string;
}

interface CombatState {
  fighters: Fighter[]; monsters: Monster[]; turn_order: string[];
  turn_index: number; round: number;
  status: "pending" | "active" | "victory" | "defeat" | "fled";
  // Per-fight scratch state from the engine. Only the bits the UI cares
  // about are typed — mark is the marked-target tag emitted by `mark_applied`.
  ability_state?: {
    mark?: { marked_by: string; expires_after_round: number };
    [k: string]: unknown;
  };
}

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
  | { kind: "ability"; actor: string; ability_id: string; target?: string; position?: "front" | "back" }
  | { kind: "monster_act" }
  | { kind: "use_item"; actor: string; item_id: number; target_id?: string };

// Class → active ability spec (mirrors CombatPage.ABILITY_BY_CLASS).
interface AbilityUiSpec {
  id: string; name: string; iconName: string; mana_cost: number; blurb: string;
  // migrate needs a partymate + position picker; not supported in grid view
  // for v1 — we just disable the button with a note.
  needs_picker?: boolean;
}
const ABILITY_BY_CLASS: Record<string, AbilityUiSpec> = {
  "SRE Warden":     { id: "taunt",             name: "Taunt",      iconName: "shield",          mana_cost: 2, blurb: "Monster targets you for 2 swings" },
  "DevOps Mage":    { id: "containerize",      name: "Container",  iconName: "cubes",           mana_cost: 2, blurb: "Monster skips next swing" },
  "QA Paladin":     { id: "regression_shield", name: "Regress",    iconName: "fairy-wand",      mana_cost: 2, blurb: "+3 shield to all party" },
  "Refactor Rogue": { id: "vanish",            name: "Vanish",     iconName: "hood",            mana_cost: 2, blurb: "Untargetable for 2 swings" },
  "Data Wizard":    { id: "soul_drain",        name: "Soul Drain", iconName: "death-skull",     mana_cost: 2, blurb: "1d6+mag dmg, heal 50%" },
  "Data Warlock":   { id: "soul_drain",        name: "Soul Drain", iconName: "death-skull",     mana_cost: 2, blurb: "1d6+mag dmg, heal 50%" },
  "Frontend Bard":  { id: "battle_hymn",       name: "Hymn",       iconName: "aura",            mana_cost: 2, blurb: "+dmg buff on next party attacks" },
  "Staff Sage":     { id: "foresee",           name: "Foresee",    iconName: "scroll-unfurled", mana_cost: 1, blurb: "Full battle intel for 2 turns" },
  "Backend Druid":  { id: "migrate",           name: "Migrate",    iconName: "leaf",            mana_cost: 1, blurb: "Move a partymate to front/back", needs_picker: true },
};

interface OutcomeSummary {
  status: "victory" | "defeat";
  rewards: Array<{ user_id: string; xp_awarded: number; gold_awarded: number; level_up: boolean; new_level: number; loot: Array<{ item_name: string; rarity: string }>; soft_death: { gold_lost: number } | null }>;
  monster_name: string;
}

interface LogEntry {
  id: number;
  text: string;
  tone: "info" | "good" | "bad" | "muted";
  // Optional sub-line shown only when the user toggles "Details" — the
  // d20 roll, formula, AC, etc. Hidden by default for a cleaner log.
  detail?: string;
  // Visual band. "party" = green left-rule + faint tint, "enemy" = red,
  // "divider" = horizontal rule (turn change), null = inline neutral
  // (begin / victory / wave headers, etc.).
  side?: "party" | "enemy" | "divider" | null;
  // For divider rows: which side acts next ("party" / "enemy"), so the
  // following block of events gets a matching accent before any per-entry
  // side classification.
  divider_side?: "party" | "enemy" | null;
}

interface WsUiState {
  connection: "connecting" | "open" | "closed";
  state: CombatState | null;
  log: LogEntry[];
  outcome: OutcomeSummary | null;
}

let nextLogId = 1;

function hpColor(c: number, m: number): string {
  const p = m > 0 ? c / m : 0;
  return p > 0.5 ? "#22c55e" : p > 0.25 ? "#f59e0b" : "#ef4444";
}

function slugifyName(n: string): string {
  return n.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "unnamed";
}
function charPortraitUrl(name: string): string { return `/img/art/v3/character/${slugifyName(name)}.png`; }

const CLASS_PORTRAIT_BASE = "/img/art/views/v6";
const CLASS_ID_BY_NAME: Record<string, string> = {
  "DevOps Mage": "devops_mage", "QA Paladin": "qa_paladin", "Backend Druid": "backend_druid",
  "Frontend Bard": "frontend_bard", "Staff Sage": "staff_sage", "Refactor Rogue": "refactor_rogue",
  "SRE Warden": "sre_warden", "Data Wizard": "data_warlock", "Data Warlock": "data_warlock",
};
function classPortraitUrl(name: string): string | null {
  const id = CLASS_ID_BY_NAME[name];
  return id ? `${CLASS_PORTRAIT_BASE}/class_${id}.png` : null;
}

// Room background URL composition. The prompts in ai.ts use these key shapes:
// - Specials: room_entry, room_boss
// - Dead-ends: room_dead_<dir>_<empty|treasure|lockbox|npc>  (always suffixed)
// - Chamber: room_chamber_<empty|combat|loot|treasure|npc|merchant|trap>  (always suffixed)
// - Corridor shapes (straight, corner, T, cross): bare shape name
function roomBgUrl(shape: RoomShape | undefined, content: GridRoomContent | undefined): string {
  const base = "/img/art/views/v6";
  const s: RoomShape = shape ?? "chamber";

  // Specials override based on content kind
  if (content?.kind === "entry") return `${base}/room_entry.png`;
  if (content?.kind === "boss" || s === "boss") return `${base}/room_boss.png`;
  if (s === "entry") return `${base}/room_entry.png`;

  const c = content?.kind ?? "empty";

  // Dead-ends: every variant has a content suffix
  if (s.startsWith("dead_")) {
    const sub = c === "loot" || c === "key_pickup" ? "treasure"
      : c === "lockbox" ? "lockbox"
      : c === "npc" || c === "merchant" ? "npc"
      : "empty";
    return `${base}/room_${s}_${sub}.png`;
  }

  // Chambers: always have a content suffix
  if (s === "chamber") {
    const sub = c === "encounter" ? "combat"
      : c === "loot" || c === "key_pickup" ? "loot"
      : c === "merchant" ? "merchant"
      : c === "npc" ? "npc"
      : c === "trap" ? "trap"
      : c === "lockbox" ? "treasure"
      : "empty";
    return `${base}/room_chamber_${sub}.png`;
  }

  // Corridor shapes: bare name (no content variant — overlay handles NPC/etc)
  return `${base}/room_${s}.png`;
}

// ─── WS reducer (combat) ─────────────────────────────────────────────────────

type WsAction =
  | { kind: "connection"; value: WsUiState["connection"] }
  | { kind: "state"; value: CombatState }
  | { kind: "events"; value: Array<{ type: string; [k: string]: unknown }> }
  | { kind: "outcome"; value: OutcomeSummary }
  | { kind: "reset" };

function wsReducer(s: WsUiState, a: WsAction): WsUiState {
  switch (a.kind) {
    case "connection": return { ...s, connection: a.value };
    case "state": return { ...s, state: a.value };
    case "events": {
      const nameOf = (id: string) => isMonsterActor(id)
        ? s.state?.monsters?.[0]?.name ?? "monster"
        : s.state?.fighters.find((f) => f.id === id)?.name ?? id;
      const newEntries: LogEntry[] = [];
      for (const e of a.value) {
        const entry = formatCombatEvent(e, nameOf);
        if (entry) newEntries.push(entry);
      }
      return { ...s, log: [...s.log, ...newEntries].slice(-20) };
    }
    case "outcome": return { ...s, outcome: a.value };
    // Reset between fights: clear stale outcome + log so the victory
    // overlay from a previous combat doesn't bleed into the next one.
    case "reset": return { connection: s.connection, state: null, log: [], outcome: null };
  }
}

function formatCombatEvent(e: { type: string; [k: string]: unknown }, nameOf: (id: string) => string): LogEntry | null {
  const row = (text: string, tone: LogEntry["tone"], detail?: string, side?: LogEntry["side"]): LogEntry => ({ id: nextLogId++, text, tone, detail, side: side ?? null });
  const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
  switch (e.type) {
    case "begin": return row("Combat begins — rolling initiative…", "info");
    case "turn_start": {
      const actorId = String(e.actor ?? "");
      const dividerSide: "party" | "enemy" = isMonsterActor(actorId) ? "enemy" : "party";
      return {
        id: nextLogId++,
        text: `${nameOf(actorId)} — round ${e.round}`,
        tone: "muted",
        side: "divider",
        divider_side: dividerSide,
      };
    }
    case "hit_check": return row(
      e.hit ? "Hit lands" : "Attack misses",
      e.hit ? "good" : "bad",
      `d20 ${e.roll}${sign(e.modifier as number)} = ${e.total} vs AC ${e.ac}`,
      isMonsterActor(String(e.actor ?? "")) ? "enemy" : "party",
    );
    case "player_hit": return row(
      `${nameOf(e.actor as string)} hits for ${e.damage} dmg${e.crit ? " (CRIT!)" : ""}`,
      "good",
      typeof e.formula === "string" ? String(e.formula) : undefined,
      "party",
    );
    case "monster_attack": return row(
      `Monster strikes — ${e.hp_damage} HP damage`,
      "bad",
      `raw ${e.raw_damage} · armor ${(e.raw_damage as number) - (e.damage_after_armor as number)} · shield ${e.shield_absorbed} → ${e.hp_damage} HP`,
      "enemy",
    );
    case "fighter_down": return row(`${nameOf(e.target as string)} is down!`, "bad", undefined, "enemy");
    case "monster_down": return row(`${nameOf(e.killed_by as string)} lands the killing blow!`, "good", undefined, "party");
    case "heal_applied": return row(
      `${nameOf(e.actor as string)}: +${e.amount} HP healed`,
      "good",
      (e.rolled as number) > (e.amount as number) ? `rolled ${e.rolled}, clamped to ${e.amount}` : undefined,
      "party",
    );
    case "shield_applied": return row(
      `${nameOf(e.actor as string)}: +${e.amount} shield`,
      "good",
      (e.rolled as number) > (e.amount as number) ? `rolled ${e.rolled}, clamped to ${e.amount}` : undefined,
      "party",
    );
    case "signature_used": return row(
      `${nameOf(e.actor as string)} signature: ${e.damage} dmg`,
      "good",
      `${e.formula ?? ""} · −${e.mana_spent ?? 0} mana`,
      "party",
    );
    case "flee_check": return row(
      e.success ? `${nameOf(e.actor as string)} escapes!` : `${nameOf(e.actor as string)} fails to escape`,
      e.success ? "good" : "bad",
      `d20 ${e.roll}${sign(e.modifier as number)} = ${e.total} vs DC ${e.dc}`,
      "party",
    );
    case "victory": return row("Victory!", "good");
    case "defeat": return row("The party falls…", "bad");
    case "fled": return row("The party escapes!", "muted");
    case "ability_used": return row(`${nameOf(e.actor as string)} uses ${e.name}`, "good", `−${e.mana_spent ?? 0} mana`, "party");
    case "wave_transition": return row(`Wave ${e.new_wave}/${e.total_waves}: ${e.to_monster} arrives`, "info");
    case "mark_applied": return row(`${nameOf(e.actor as string)} marks the target`, "info", `+${e.bonus} dmg through round ${e.expires_after_round}`, "party");
    default: return null;
  }
}

// ─── Shared bits: HpBar, PartyBar, MonsterOverlay, InitStrip ─────────────────

function HpBar({ current, max, color, height = 6 }: { current: number; max: number; color?: string; height?: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  return (
    <div style={{ height, background: "#1a1c21", borderRadius: height / 2, overflow: "hidden" }}>
      <div style={{ width: `${pct * 100}%`, height: "100%", background: color ?? hpColor(current, max), borderRadius: height / 2, transition: "width 0.3s ease" }} />
    </div>
  );
}

function PartyBar({ fighters, selfId, party, onClickSelf, flashIds }: {
  fighters: Fighter[] | null; selfId: string; party: Character[];
  onClickSelf?: () => void;
  flashIds?: Set<string>;
}) {
  const seen = new Set<string>();
  type Member = { key: string; name: string; cls: string; level: number; position: "front" | "back"; hp: number; max_hp: number; mana: number; max_mana: number; shield: number; isSelf: boolean; isDead: boolean };
  const members: Member[] = fighters
    ? fighters.map((f) => ({ key: f.id, name: f.name, cls: f.class, level: f.level, position: f.position, hp: f.hp, max_hp: f.max_hp, mana: f.mana, max_mana: f.max_mana, shield: f.shield, isSelf: f.id === selfId, isDead: f.hp <= 0 }))
    : party.flatMap((c) => {
        if (seen.has(c.slack_user_id)) return [];
        seen.add(c.slack_user_id);
        return [{ key: c.slack_user_id, name: c.name, cls: c.class, level: c.level, position: c.position, hp: c.hp, max_hp: c.max_hp, mana: c.mana, max_mana: c.max_mana, shield: c.shield, isSelf: c.slack_user_id === selfId, isDead: c.hp <= 0 }];
      });

  const backRow = members.filter((m) => m.position === "back");
  const frontRow = members.filter((m) => m.position === "front");

  function renderCard(f: Member) {
    const isHit = flashIds?.has(f.key) ?? false;
    return (
      <div key={f.key}
        className={isHit ? "gq-hit-flash" : undefined}
        onClick={f.isSelf && onClickSelf ? onClickSelf : undefined}
        title={f.isSelf && onClickSelf ? "Open inventory" : undefined}
        style={{
          position: "relative",
          display: "flex", alignItems: "center", gap: 10,
          background: f.isSelf ? "rgba(245,245,220,0.10)" : "rgba(255,255,255,0.04)",
          border: f.isSelf ? "1px solid rgba(245,245,220,0.28)" : "1px solid rgba(255,255,255,0.08)",
          borderRadius: 10,
          padding: "8px 12px",
          opacity: f.isDead ? 0.45 : 1,
          flexShrink: 0,
          minWidth: typeof window !== "undefined" && window.innerWidth < 700 ? 0 : 200,
          flex: typeof window !== "undefined" && window.innerWidth < 700 ? "1 1 auto" : "0 0 auto",
          cursor: f.isSelf && onClickSelf ? "pointer" : "default",
        }}>
        {/* Lvl badge in top-right corner */}
        <div style={{
          position: "absolute", top: 4, right: 6,
          fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
          color: "#fcd34d", background: "rgba(0,0,0,0.55)",
          padding: "1px 6px", borderRadius: 4,
          fontFamily: "ui-monospace, monospace",
        }}>
          LV {f.level}
        </div>
        <Avatar src={charPortraitUrl(f.name)} fallbackSrc={classPortraitUrl(f.cls)} alt={f.name} size={56} radius={6} fallbackIcon="player" fallbackColor="#4a5568" border="1px solid #2a2d33" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", paddingRight: 30 }}>{f.name}</div>
          <HpBar current={f.hp} max={f.max_hp} height={7} />
          <div style={{ fontSize: 11, color: "#9aa0a6", marginTop: 2 }}>
            {f.hp}/{f.max_hp} HP{f.shield > 0 && <span style={{ color: "#60a5fa", marginLeft: 4 }}>+{f.shield}<Icon name="shield" size={10} /></span>}
          </div>
          <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
            {Array.from({ length: f.max_mana }, (_, mi) => (
              <div key={mi} style={{ width: 9, height: 9, borderRadius: "50%", background: mi < f.mana ? "#818cf8" : "#1e2028", border: "1px solid #3a3d43" }} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Two rows, both center-aligned. Front above Back. On mobile the row
  // labels move inline above each row (saves horizontal space and avoids
  // the cramped narrow-column look).
  const partyIsMobile = typeof window !== "undefined" && window.innerWidth < 700;
  const rowStyle: React.CSSProperties = { display: "flex", gap: partyIsMobile ? 8 : 12, justifyContent: "center", flexWrap: "wrap", alignItems: "center" };
  const labelStyle: React.CSSProperties = partyIsMobile
    ? { fontSize: 8, fontWeight: 700, letterSpacing: 1.2, color: "#6b7280", textTransform: "uppercase", padding: "0 4px" }
    : { fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: "#6b7280", alignSelf: "center", textTransform: "uppercase", minWidth: 38 };
  return (
    <div style={{
      background: "rgba(10,11,14,0.55)",
      border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: 12,
      backdropFilter: "blur(10px)",
      WebkitBackdropFilter: "blur(10px)",
      boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
      padding: partyIsMobile ? "8px 8px" : "10px 12px",
      display: "flex", flexDirection: "column", gap: partyIsMobile ? 4 : 8,
    }}>
      {/* Front row above Back row — Front stands closer to the foe, which
          is at the top of the screen in first-person view. */}
      <div style={rowStyle}>
        <div style={labelStyle}>Front</div>
        {frontRow.length === 0 ? <span style={{ fontSize: 11, color: "#4a5568", alignSelf: "center", fontStyle: "italic" }}>—</span> : frontRow.map(renderCard)}
      </div>
      <div style={rowStyle}>
        <div style={labelStyle}>Back</div>
        {backRow.length === 0 ? <span style={{ fontSize: 11, color: "#4a5568", alignSelf: "center", fontStyle: "italic" }}>—</span> : backRow.map(renderCard)}
      </div>
    </div>
  );
}

// Single monster card. Used by MonsterStrip — one card per monster.
// Card-local state manages its own defeat animation lifecycle so each
// monster falls back independently when it dies (in a multi-monster
// fight, killing one shouldn't restart the other's animation).
function MonsterCard({ monster, isBoss, isHit, lungeTick, slashTick, isMarked, isTargeted, size, onClick }: {
  monster: Monster;
  isBoss: boolean;
  isHit: boolean;
  // Re-mounts the card on bump so the lunge keyframe re-fires.
  lungeTick: number;
  // Re-mounts the slash streak on bump (when this card was the hit target).
  slashTick: number;
  isMarked: boolean;
  isTargeted: boolean;
  // "primary" = single-monster centered look, "strip" = smaller card
  // in a row of monsters. Drives art height + card width.
  size: "primary" | "strip";
  onClick?: () => void;
}) {
  const isDead = monster.hp <= 0;
  // Card-local defeat clock. Triggered when HP first transitions to 0,
  // resets if HP returns >0 (e.g. revive). Stays mounted with the
  // gq-monster-defeated keyframes running, then unmounts at +1100ms.
  const [defeatedAt, setDefeatedAt] = useState<number | null>(null);
  useEffect(() => {
    if (monster.hp <= 0 && defeatedAt === null) {
      setDefeatedAt(Date.now());
    } else if (monster.hp > 0 && defeatedAt !== null) {
      setDefeatedAt(null);
    }
  }, [monster.hp, defeatedAt]);
  useEffect(() => {
    if (defeatedAt === null) return;
    const t = setTimeout(() => setDefeatedAt((v) => v), 1150); // nudge re-render past unmount window
    return () => clearTimeout(t);
  }, [defeatedAt]);
  if (defeatedAt !== null && Date.now() > defeatedAt + 1100) return null;

  const isPrimary = size === "primary";
  const cardWidth = isPrimary ? undefined : 200;
  const artHeight = isPrimary ? 140 : 100;
  const nameFontSize = isPrimary ? 15 : 13;
  const classes = [
    isHit && !isDead ? "gq-hit-flash" : null,
    !isDead ? "gq-monster-lunge-card" : "gq-monster-defeated-card",
    isTargeted ? "gq-monster-targeted" : null,
  ].filter(Boolean).join(" ");
  const borderColor = isDead ? "#2a2d33" : isTargeted ? "#fbbf24" : isBoss ? "#fca5a5" : "#2a2d33";
  return (
    <div
      key={`monster-card-${monster.id ?? ""}-${isDead ? "defeated" : lungeTick}`}
      className={classes}
      onClick={!isDead && onClick ? onClick : undefined}
      role={onClick ? "button" : undefined}
      title={onClick && !isDead ? `Target ${monster.name}` : undefined}
      style={{
        position: "relative",
        background: "rgba(10,11,14,0.88)",
        border: `2px solid ${borderColor}`,
        borderRadius: 12,
        padding: isPrimary ? "10px 14px" : "8px 10px",
        minWidth: cardWidth ?? 220,
        maxWidth: isPrimary ? 300 : cardWidth,
        width: cardWidth,
        backdropFilter: "blur(8px)",
        boxShadow: isBoss && !isDead ? "0 0 32px rgba(239,68,68,0.3)" : isTargeted ? "0 0 16px rgba(251,191,36,0.4)" : "0 4px 24px rgba(0,0,0,0.6)",
        cursor: onClick && !isDead ? "pointer" : "default",
        transition: "border-color 0.15s, box-shadow 0.15s",
        flexShrink: 0,
      }}
    >
      {monster.art_url && (
        <img src={monster.art_url} alt={monster.name} style={{ width: "100%", height: artHeight, objectFit: "cover", borderRadius: 8, marginBottom: 8, display: "block" }} />
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div style={{ fontFamily: DISPLAY_FONT, fontSize: nameFontSize, fontWeight: 700, color: isBoss ? "#fca5a5" : "#f5f5f5", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{monster.name}</div>
        <div style={{ fontSize: 11, color: "#9aa0a6", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{Math.max(0, monster.hp)} / {monster.max_hp}</div>
      </div>
      <HpBar current={Math.max(0, monster.hp)} max={monster.max_hp} color={isBoss ? "#ef4444" : undefined} height={6} />
      {/* Slash streak — re-mounts when slashTick bumps. Lives in its
          own overflow-hidden layer so it clips to the card edge without
          the parent's overflow having to be hidden. */}
      {slashTick > 0 && !isDead && (
        <div
          aria-hidden
          style={{ position: "absolute", inset: 0, overflow: "hidden", borderRadius: 12, pointerEvents: "none" }}
        >
          <span key={`slash-${slashTick}`} className="gq-slash-streak" />
        </div>
      )}
      {isMarked && !isDead && (
        <div
          title="Marked target — party gets bonus damage"
          style={{
            position: "absolute",
            top: -10, right: -10,
            width: 28, height: 28,
            borderRadius: "50%",
            background: "#78350f",
            border: "2px solid #f59e0b",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 10,
            boxShadow: "0 0 12px rgba(245,158,11,0.6)",
          }}
        >
          <Icon name="targeted" size={16} color="#fbbf24" />
        </div>
      )}
      {monster.effects && monster.effects.length > 0 && !isDead && (
        <div style={{ position: "absolute", top: 6, right: 6, display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-end", zIndex: 9 }}>
          {monster.effects.map((e, i) => {
            const [color, icon] = e.type === "regen" ? ["#4ade80", "regeneration"]
              : e.type === "bleeding" ? ["#f87171", "bleeding-hearts"]
              : e.type === "burning" ? ["#fb923c", "fire"]
              : ["#c084fc", "poison-cloud"];
            return (
              <span
                key={i}
                title={`${e.type} ×${e.magnitude} (${e.remaining} turns)`}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 3,
                  background: `${color}33`, border: `1px solid ${color}88`,
                  borderRadius: 4, padding: "1px 5px",
                  fontSize: 10, color, fontWeight: 700,
                  textShadow: "0 1px 2px rgba(0,0,0,0.8)",
                }}
              >
                <Icon name={icon} size={9} /> {e.magnitude}×{e.remaining}t
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Renders all monsters in the encounter. One monster → centered "primary"
// card (matches the old single-monster overlay look). Two or more →
// horizontal row of smaller cards centered above the party. Click-to-
// target sets targetMonsterId; the targeted card gets a gold border.
function MonsterStrip({ monsters, flashIds, lastSlash, lastLunge, markedMonsterId, targetMonsterId, onTarget }: {
  monsters: Monster[];
  flashIds: Set<string>;
  // Most-recent slash event — id of the hit monster + a monotonic seq.
  // The MonsterCard with the matching id re-keys its slash element so
  // the animation fires only on the actual target.
  lastSlash: { id: string; seq: number } | null;
  lastLunge: { id: string; seq: number } | null;
  markedMonsterId: string | null;
  targetMonsterId: string | null;
  onTarget: (id: string) => void;
}) {
  if (monsters.length === 0) return null;
  const isSingle = monsters.length === 1;
  // Targeting is only useful when there are 2+ live monsters. With one,
  // the engine auto-resolves to that monster anyway.
  const liveCount = monsters.filter((m) => m.hp > 0).length;
  const showTargeting = liveCount > 1;
  return (
    <div
      style={{
        position: "absolute",
        top: "50%", left: "50%",
        transform: "translate(-50%, -65%)",
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        justifyContent: "center",
        maxWidth: "92vw",
        flexWrap: "wrap",
      }}
    >
      {monsters.map((m) => {
        const id = m.id ?? "";
        return (
          <MonsterCard
            key={id || m.name}
            monster={m}
            isBoss={!!m.is_boss}
            isHit={flashIds.has(id)}
            lungeTick={lastLunge?.id === id ? lastLunge.seq : 0}
            slashTick={lastSlash?.id === id ? lastSlash.seq : 0}
            isMarked={markedMonsterId === id}
            isTargeted={showTargeting && targetMonsterId === id}
            size={isSingle ? "primary" : "strip"}
            onClick={showTargeting && m.hp > 0 ? () => onTarget(id) : undefined}
          />
        );
      })}
    </div>
  );
}

function InitStrip({ state, selfId }: { state: CombatState; selfId: string }) {
  const currentIdx = state.turn_index % state.turn_order.length;
  return (
    <div style={{
      background: "rgba(10,11,14,0.55)",
      border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: 999,
      backdropFilter: "blur(10px)",
      WebkitBackdropFilter: "blur(10px)",
      boxShadow: "0 6px 24px rgba(0,0,0,0.4)",
      padding: "6px 14px",
      display: "flex", gap: 8, alignItems: "center", maxWidth: "min(720px, 92vw)", overflowX: "auto",
    }}>
      <span style={{ fontSize: 10, color: "#9aa0a6", textTransform: "uppercase", letterSpacing: 1, marginRight: 4, whiteSpace: "nowrap" }}>Turn order</span>
      {state.turn_order.map((id, i) => {
        const isCurrent = i === currentIdx;
        const isMonster = isMonsterActor(id);
        const fighter = state.fighters.find((f) => f.id === id);
        const monster = isMonster ? state.monsters.find((m) => m.id === id) ?? state.monsters[0] : null;
        const label = isMonster ? (monster?.name?.split(" ")[0] ?? "Enemy") : (fighter?.name?.split(" ")[0] ?? id);
        const isSelf = id === selfId;
        const isDead = fighter ? fighter.hp <= 0 : monster ? monster.hp <= 0 : false;
        return (
          <div key={i} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, border: isCurrent ? "1px solid #f5f5dc" : "1px solid transparent", background: isCurrent ? "rgba(245,245,220,0.12)" : "transparent", color: isDead ? "#4a5568" : isMonster ? "#fca5a5" : isSelf ? "#f5f5dc" : "#d1d5db", fontWeight: isCurrent ? 700 : 400, whiteSpace: "nowrap", opacity: isDead ? 0.5 : 1, textDecoration: isDead ? "line-through" : "none" }}>{label}</div>
        );
      })}
      <span style={{ fontSize: 10, color: "#4a5568", marginLeft: 4, whiteSpace: "nowrap" }}>round {state.round}</span>
    </div>
  );
}

// ─── Grid Minimap (true 2D) ──────────────────────────────────────────────────
// Renders the actual room grid. Each cell shows the room's shape as small
// line-art so the player can visually parse the dungeon layout.

const CELL = 18; // px per cell
const WALL = 2;  // wall thickness

function ShapeIcon({ shape }: { shape: RoomShape | undefined }) {
  // Draw the shape as small SVG line art. Uses a fixed viewBox and scales to
  // its parent cell — so cells can be any pixel size and the art tracks.
  const VB = 20;
  const c = VB / 2;
  const stroke = "#9aa0a6";
  const sw = 1.5;
  const exits = exitsForShape(shape ?? "chamber");
  const bodyR = VB * 0.18;
  return (
    <svg width="100%" height="100%" viewBox={`0 0 ${VB} ${VB}`} preserveAspectRatio="xMidYMid meet" style={{ display: "block" }}>
      {exits.has("n") && <line x1={c} y1={0} x2={c} y2={c} stroke={stroke} strokeWidth={sw} />}
      {exits.has("e") && <line x1={c} y1={c} x2={VB} y2={c} stroke={stroke} strokeWidth={sw} />}
      {exits.has("s") && <line x1={c} y1={c} x2={c} y2={VB} stroke={stroke} strokeWidth={sw} />}
      {exits.has("w") && <line x1={0} y1={c} x2={c} y2={c} stroke={stroke} strokeWidth={sw} />}
      <circle cx={c} cy={c} r={bodyR} fill={stroke} />
    </svg>
  );
}

function exitsForShape(shape: RoomShape): Set<DungeonDirection> {
  const e = new Set<DungeonDirection>();
  switch (shape) {
    case "dead_n": e.add("n"); break;
    case "dead_e": e.add("e"); break;
    case "dead_s": e.add("s"); break;
    case "dead_w": e.add("w"); break;
    case "straight_ns": e.add("n"); e.add("s"); break;
    case "straight_ew": e.add("e"); e.add("w"); break;
    case "corner_ne": e.add("n"); e.add("e"); break;
    case "corner_nw": e.add("n"); e.add("w"); break;
    case "corner_se": e.add("s"); e.add("e"); break;
    case "corner_sw": e.add("s"); e.add("w"); break;
    // T-junction naming matches packages/db shapeFromExits: t_X = "T points
    // X direction" = the wall is on the OPPOSITE side. So t_n has open
    // exits on N + the two perpendicular sides; the S wall is closed.
    case "t_n": e.add("n"); e.add("e"); e.add("w"); break; // no s
    case "t_e": e.add("n"); e.add("e"); e.add("s"); break; // no w
    case "t_s": e.add("e"); e.add("s"); e.add("w"); break; // no n
    case "t_w": e.add("n"); e.add("s"); e.add("w"); break; // no e
    case "cross": e.add("n"); e.add("e"); e.add("s"); e.add("w"); break;
    default: break;
  }
  return e;
}

function GridMinimap({ graph, fluid = false }: { graph: GridGraph; fluid?: boolean }) {
  const w = graph.grid_width ?? 4;
  const h = graph.grid_height ?? 4;
  const current = graph.nodes[graph.current];
  const visited = new Set(graph.visited);
  // Fluid mode: grid cells size to 1fr inside a container with fixed
  // aspectRatio = w/h. The wrapping flex column constrains both axes via
  // max-width / max-height so the map stays inside the rail while keeping
  // its aspect ratio. Fixed mode: each cell is CELL px (legacy chip).
  const gridStyle: React.CSSProperties = fluid
    ? {
        display: "grid",
        gridTemplateColumns: `repeat(${w}, 1fr)`,
        gridTemplateRows: `repeat(${h}, 1fr)`,
        gap: 1,
        background: "#1a1c21",
        aspectRatio: `${w} / ${h}`,
        maxWidth: "100%",
        maxHeight: "100%",
        width: "100%",
      }
    : {
        display: "grid",
        gridTemplateColumns: `repeat(${w}, ${CELL}px)`,
        gridTemplateRows: `repeat(${h}, ${CELL}px)`,
        gap: 1,
        background: "#1a1c21",
      };
  const wrapStyle: React.CSSProperties = fluid
    ? { userSelect: "none", display: "flex", flexDirection: "column", alignItems: "center", minHeight: 0, flex: "1 1 auto" }
    : { userSelect: "none" };
  return (
    <div style={wrapStyle}>
      <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4, alignSelf: fluid ? "flex-start" : undefined, flexShrink: 0 }}>Map</div>
      <div style={gridStyle}>
        {Array.from({ length: w * h }, (_, idx) => {
          const x = idx % w;
          const y = Math.floor(idx / w);
          const node = Object.values(graph.nodes).find((n) => n.x === x && n.y === y);
          if (!node) {
            return <div key={idx} style={fluid ? { background: "#0a0b0e" } : { width: CELL, height: CELL, background: "#0a0b0e" }} />;
          }
          const isCurrent = node.id === graph.current;
          const isVisited = visited.has(node.id);
          const content = node.content?.kind;
          const isBoss = content === "boss";
          const isEntry = content === "entry";
          const isTreasure = content === "loot" || content === "key_pickup";
          const isLockbox = content === "lockbox";
          let bg = isCurrent ? "#f5f5dc" : isVisited ? "#374151" : "#1a1c21";
          // Boss room only telegraphs once the player has actually been there.
          // Unvisited boss rooms look like any other unexplored cell so the
          // map doesn't spoil the layout.
          if (isBoss && !isCurrent && isVisited) bg = "#7f1d1d";
          const cellStyle: React.CSSProperties = fluid
            ? { position: "relative", background: bg, display: "flex", alignItems: "center", justifyContent: "center", minWidth: 0, minHeight: 0 }
            : { position: "relative", width: CELL, height: CELL, background: bg, display: "flex", alignItems: "center", justifyContent: "center" };
          return (
            <div key={idx} style={cellStyle}>
              <ShapeIcon shape={node.shape} />
              {isCurrent && <div style={{ position: "absolute", top: 1, right: 1, width: 4, height: 4, background: "#ef4444", borderRadius: "50%" }} />}
              {isBoss && !isCurrent && isVisited && <div style={{ position: "absolute", top: 1, right: 1, width: 4, height: 4, background: "#fca5a5", borderRadius: "50%" }} />}
              {isEntry && !isCurrent && <div style={{ position: "absolute", top: 1, right: 1, width: 4, height: 4, background: "#86efac", borderRadius: "50%" }} />}
              {isTreasure && isVisited && !isCurrent && <div style={{ position: "absolute", bottom: 1, right: 1, width: 4, height: 4, background: "#fbbf24", borderRadius: "50%" }} />}
              {isLockbox && isVisited && !isCurrent && <div style={{ position: "absolute", bottom: 1, right: 1, width: 4, height: 4, background: "#60a5fa", borderRadius: "50%" }} />}
              {/* Door indicators — only render on visited rooms so unvisited
                  doors aren't telegraphed. Once you've been in the room you
                  can physically see the doors, so they show on the map. */}
              {isVisited && (["n", "e", "s", "w"] as DungeonDirection[]).map((dir) => {
                const door = node.doors?.[dir];
                if (!door || door.state === "open" || door.state === "broken") return null;
                const color = door.state === "locked" ? "#ef4444" : "#f59e0b";
                const pos: React.CSSProperties = dir === "n" ? { top: 0, left: 2, right: 2, height: WALL } :
                  dir === "s" ? { bottom: 0, left: 2, right: 2, height: WALL } :
                  dir === "e" ? { right: 0, top: 2, bottom: 2, width: WALL } :
                  { left: 0, top: 2, bottom: 2, width: WALL };
                return <div key={dir} style={{ position: "absolute", background: color, ...pos }} />;
              })}
            </div>
          );
        })}
      </div>
      {current && (
        <div style={{ fontSize: 9, color: "#6b7280", textAlign: "center", marginTop: 4 }}>
          ({current.x},{current.y})
        </div>
      )}
    </div>
  );
}

// ─── Compass Navigation ──────────────────────────────────────────────────────

function CompassNav({ node, onMove, disabled }: { node: GridNode; onMove: (dir: DungeonDirection) => void; disabled: boolean }) {
  const has = (d: DungeonDirection) => !!node.exits[d];
  const door = (d: DungeonDirection) => node.doors?.[d];
  function btn(dir: DungeonDirection, label: string) {
    if (!has(dir)) return <div style={{ width: 60, height: 32 }} />; // placeholder for grid spacing
    const d = door(dir);
    const isLocked = d?.state === "locked";
    const isBarred = d?.state === "barred";
    const color = isLocked ? "#ef4444" : isBarred ? "#f59e0b" : "#9aa0a6";
    return (
      <button
        onClick={() => onMove(dir)}
        disabled={disabled}
        title={isLocked ? "Locked door" : isBarred ? "Barred door" : "Move " + dir.toUpperCase()}
        style={{
          width: 60, height: 32, padding: 0,
          background: "rgba(10,11,14,0.85)",
          border: `1px solid ${color}`, borderRadius: 6,
          color, fontSize: 13, fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
          opacity: disabled ? 0.4 : 1,
        }}
      >
        {label}
        {(isLocked || isBarred) && <Icon name={isLocked ? "key" : "shield"} size={11} />}
      </button>
    );
  }
  return (
    <div style={{ position: "absolute", bottom: 130, left: "50%", transform: "translateX(-50%)", display: "grid", gridTemplateColumns: "60px 60px 60px", gridTemplateRows: "32px 32px 32px", gap: 4, alignItems: "center", justifyItems: "center", padding: 6, background: "rgba(0,0,0,0.55)", borderRadius: 10, backdropFilter: "blur(4px)", zIndex: 7 }}>
      <div /> {btn("n", "N")} <div />
      {btn("w", "W")} <div style={{ width: 60, height: 32, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Icon name="footprint" size={16} color="#6b7280" />
      </div> {btn("e", "E")}
      <div /> {btn("s", "S")} <div />
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

interface GridDungeonViewProps {
  questId: number;
  selfId: string;
  scene: SceneJson;
  party: Character[];
  character: Character;
  hasWebCombat: boolean;
  onOpenInventory?: () => void;
  onExit: () => void;
  onRefresh: () => void;
}

export function GridDungeonView({
  questId, selfId, scene, party, character, hasWebCombat, onOpenInventory, onExit, onRefresh,
}: GridDungeonViewProps) {
  const graph = scene.graph!;
  const currentNode = graph.nodes[graph.current];
  const content = currentNode.content;
  // Legacy AI-graph dungeons (pre-grid) don't have node.content but DO have
  // node.encounter with the same monster info. Synthesize content from it so
  // the rest of the view (Engage button, monster overlay, etc.) works on
  // legacy quests without crashing.
  const legacyEncounter = !content && currentNode.encounter && !currentNode.encounter.cleared
    ? currentNode.encounter
    : null;
  const isBoss = content?.kind === "boss";
  const isCombatRoom = content?.kind === "encounter" || content?.kind === "boss" || !!legacyEncounter;
  const monsterAlive = isCombatRoom && (legacyEncounter ? true : !(content as { cleared: boolean }).cleared);

  const [combatActive, setCombatActive] = useState(hasWebCombat && monsterAlive);
  const [ws, dispatch] = useReducer(wsReducer, { connection: "connecting" as const, state: null, log: [], outcome: null });
  const wsRef = useRef<WebSocket | null>(null);
  const [autoResolve, setAutoResolve] = useState(true);
  const autoResolveRef = useRef(true);
  const autoResolvedTurnRef = useRef(-1);
  // Auto-scroll combat log to bottom when entries arrive. We key on the
  // last entry's id rather than .length — the log is capped at 20 entries
  // via slice, so length plateaus and a length-only dep stops firing once
  // we hit the cap. The id is monotonic so it always changes on new entries.
  const logScrollRef = useRef<HTMLDivElement | null>(null);
  const lastLogId = ws.log[ws.log.length - 1]?.id ?? 0;
  useEffect(() => {
    const el = logScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lastLogId]);
  const [doorPrompt, setDoorPrompt] = useState<{ dir: DungeonDirection; door: GridDoor } | null>(null);
  const [moving, setMoving] = useState(false);
  const [contentBusy, setContentBusy] = useState(false);
  const [items, setItems] = useState<UsableItem[]>([]);
  // IDs (fighter id OR monster id) currently being flashed-red after a hit.
  // Cleared 600ms after the event lands.
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  // Per-target animation triggers. Multi-monster combat means a slash or
  // lunge applies to ONE specific monster, not the whole strip. We track
  // { id, seq } so the matching MonsterCard re-keys its animation while
  // the others stay put.
  const [lastSlash, setLastSlash] = useState<{ id: string; seq: number } | null>(null);
  const [lastLunge, setLastLunge] = useState<{ id: string; seq: number } | null>(null);
  const animSeqRef = useRef(0);
  // Player's currently-picked target. Auto-falls back to the lowest-HP
  // live monster when null. Cleared between fights via the reset action.
  const [targetMonsterId, setTargetMonsterId] = useState<string | null>(null);
  // Combat log details toggle — when true, log entries show the dice / formula
  // sub-line under their summary. Persisted across remounts for the session.
  const [logDetails, setLogDetails] = useState<boolean>(() => typeof window !== "undefined" && localStorage.getItem("gq_log_details") === "1");
  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem("gq_log_details", logDetails ? "1" : "0");
  }, [logDetails]);
  // Floating animated dice — incoming `roll` events spawn dice that tumble
  // and settle to the rolled value, then fade after ~10s.
  const [diceRolls, setDiceRolls] = useState<DiceRollEntry[]>([]);
  const diceRollCounterRef = useRef(0);
  function flashHit(id: string) {
    setFlashIds((prev) => { const n = new Set(prev); n.add(id); return n; });
    setTimeout(() => {
      setFlashIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
    }, 600);
  }

  async function loadItems() {
    const res = await fetch("/api/inventory", { credentials: "include" });
    if (res.ok) setItems(((await res.json()) as { items: UsableItem[] }).items);
  }
  useEffect(() => { void loadItems(); }, []);

  useEffect(() => { autoResolveRef.current = autoResolve; }, [autoResolve]);
  // Mirror combatActive into a ref so onmessage can read the latest value
  // without a stale closure when the WS is long-lived across combat transitions.
  const combatActiveRef = useRef(combatActive);
  useEffect(() => { combatActiveRef.current = combatActive; }, [combatActive]);

  // Quest WS — stays open for the full dungeon session (not just combat).
  // Handles both combat messages and dungeon_move room-sync notifications.
  useEffect(() => {
    dispatch({ kind: "connection", value: "connecting" });
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/ws/quest/${questId}`;
    const sock = new WebSocket(url);
    wsRef.current = sock;
    const heartbeat = setInterval(() => { if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "ping" })); }, 45_000);
    sock.onopen = () => dispatch({ kind: "connection", value: "open" });
    sock.onclose = () => dispatch({ kind: "connection", value: "closed" });
    sock.onerror = () => { if (combatActiveRef.current) toast.error("Combat connection lost"); };
    sock.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type: string; state?: CombatState & { monster?: Monster }; events?: Array<{ type: string; [k: string]: unknown }>; outcome?: OutcomeSummary };
        if (msg.type === "state" && msg.state) {
          const s = msg.state;
          const normalised: CombatState = "monsters" in s && Array.isArray(s.monsters) ? s : { ...s, monsters: [(s as unknown as { monster: Monster }).monster] };
          dispatch({ kind: "state", value: normalised });
        } else if (msg.type === "events" && msg.events) {
          dispatch({ kind: "events", value: msg.events });
          if (msg.events.some((e) => e.type === "item_used")) void loadItems();
          for (const evt of msg.events) {
            // player_hit: actor (player) hits target (monster). Flash the
            // monster card red AND fire a slash streak across it. The
            // slash is per-target so multi-monster strips only animate
            // the actually-hit card.
            if (evt.type === "player_hit" && typeof evt.target === "string") {
              const id = evt.target;
              flashHit(id);
              setLastSlash({ id, seq: ++animSeqRef.current });
            }
            // monster_attack: monster hits a fighter. Always lunge the
            // attacking monster's card (the swing happened regardless of
            // damage). Flash the fighter only when hp_damage > 0.
            if (evt.type === "monster_attack" && typeof evt.actor === "string") {
              setLastLunge({ id: evt.actor, seq: ++animSeqRef.current });
            }
            if (evt.type === "monster_attack" && typeof evt.target === "string" && (evt.hp_damage as number) > 0) {
              flashHit(evt.target as string);
            }
            // roll: dice events become floating animated polygons. When the
            // PLAYER rolls (not a monster) and no player rolls are currently
            // on screen, clear any lingering enemy dice so the new attack
            // gets a fresh stage. Multi-roll batches (e.g. d20 + d6 for
            // hit + damage) keep accumulating in the same turn.
            if (evt.type === "roll") {
              const id = ++diceRollCounterRef.current;
              const entry: DiceRollEntry = {
                id,
                die: String(evt.die),
                value: Number(evt.value),
                actor: String(evt.actor),
                purpose: String(evt.purpose ?? ""),
              };
              if (!isMonsterActor(String(evt.actor))) {
                setDiceRolls((prev) => {
                  const hasPlayerRoll = prev.some((r) => !isMonsterActor(r.actor));
                  return hasPlayerRoll ? [...prev, entry] : [entry];
                });
              } else {
                setDiceRolls((prev) => [...prev.slice(-7), entry]);
              }
              // ~5s total on screen (was 14s — felt sticky). DiceFace fades
              // from 3.5s; this cleanup is the hard removal.
              setTimeout(() => setDiceRolls((prev) => prev.filter((r) => r.id !== id)), 5000);
            }
          }
        } else if (msg.type === "outcome" && msg.outcome) {
          dispatch({ kind: "outcome", value: msg.outcome });
        } else if (msg.type === "dungeon_move") {
          // Another party member moved rooms — refresh the quest scene.
          onRefresh();
        }
      } catch { /* ignore bad frames */ }
    };
    return () => { clearInterval(heartbeat); sock.close(); wsRef.current = null; };
  }, [questId]);

  // Auto-resolve monster turns
  const stateForAuto = ws.state;
  useEffect(() => {
    if (!autoResolveRef.current) return;
    if (!stateForAuto || stateForAuto.status !== "active") return;
    const actorId = stateForAuto.turn_order[stateForAuto.turn_index % stateForAuto.turn_order.length];
    if (!isMonsterActor(actorId)) return;
    if (autoResolvedTurnRef.current === stateForAuto.turn_index) return;
    const t = setTimeout(() => { if (!autoResolveRef.current) return; const fired = send({ kind: "monster_act" }); if (fired) autoResolvedTurnRef.current = stateForAuto.turn_index; }, 800);
    return () => clearTimeout(t);
  }, [stateForAuto?.turn_index, stateForAuto?.status, autoResolve]);

  // On combat victory, refresh quest state. After the overlay's grace
  // window, drop combat and clear the WS slate so re-entering the same
  // room or moving on doesn't re-show "Victory!".
  useEffect(() => {
    if (ws.outcome?.status === "victory") {
      // 3.2s window: ~1.1s monster defeat fall, ~0.6s tint fade-in,
      // ~0.9s banner pop, ~0.6s breathe. Then refresh + exit.
      const t = setTimeout(() => {
        onRefresh();
        setCombatActive(false);
        dispatch({ kind: "reset" });
        setTargetMonsterId(null);
        setLastSlash(null);
        setLastLunge(null);
      }, 3200);
      return () => clearTimeout(t);
    }
  }, [ws.outcome?.status]);

  function send(action: TurnAction): boolean {
    const s = wsRef.current;
    if (!s || s.readyState !== WebSocket.OPEN) return false;
    s.send(JSON.stringify({ type: "action", action }));
    return true;
  }

  async function enterCombat() {
    const res = await fetch(`/api/quest/${questId}/start_web_combat`, { method: "POST", credentials: "include" });
    if (!res.ok) { toast.error("Could not start combat"); return; }
    // Clear any lingering victory/defeat overlay from a previous fight so it
    // doesn't flash during the brief window before the new state arrives.
    dispatch({ kind: "reset" });
    setTargetMonsterId(null);
    setLastSlash(null);
    setLastLunge(null);
    setCombatActive(true);
  }

  async function tryMoveTo(dir: DungeonDirection) {
    if (moving) return;
    setMoving(true);
    try {
      const res = await fetch(`/api/quest/${questId}/dungeon/graph/move`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction: dir }),
      });
      if (res.status === 423) {
        const body = await res.json() as { door: GridDoor };
        setDoorPrompt({ dir, door: body.door });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        toast.error(body.error ?? "Cannot move that way");
        return;
      }
      onRefresh();
    } finally {
      setMoving(false);
    }
  }

  async function useKeyOnDoor(dir: DungeonDirection) {
    const res = await fetch(`/api/quest/${questId}/dungeon/grid/use_key`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction: dir }),
    });
    if (!res.ok) { const b = await res.json().catch(() => ({})) as { error?: string }; toast.error(b.error ?? "No key"); return; }
    toast.success("Door unlocked");
    setDoorPrompt(null);
    onRefresh();
  }

  async function pickLock(dir: DungeonDirection) {
    const res = await fetch(`/api/quest/${questId}/dungeon/grid/pick`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction: dir }),
    });
    if (!res.ok) { toast.error("Could not pick"); return; }
    const b = await res.json() as { success: boolean; roll: number; total: number; dc: number };
    toast(`Pick: ${b.roll} → ${b.total} vs DC ${b.dc}: ${b.success ? "OK" : "fail"}`);
    if (b.success) { setDoorPrompt(null); onRefresh(); }
  }

  async function bashDoor(dir: DungeonDirection) {
    const res = await fetch(`/api/quest/${questId}/dungeon/grid/bash`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction: dir }),
    });
    if (!res.ok) { toast.error("Could not bash"); return; }
    const b = await res.json() as { success: boolean; roll: number; total: number; dc: number; damage_dealt: number };
    toast(`Bash: ${b.roll} → ${b.total} vs DC ${b.dc}: ${b.success ? "BROKEN" : `failed (-${b.damage_dealt} HP)`}`);
    if (b.success) { setDoorPrompt(null); onRefresh(); }
    else { onRefresh(); }
  }

  // ── Content interactions ──
  async function takeLoot(idx: number) {
    if (contentBusy) return;
    setContentBusy(true);
    try {
      const res = await fetch(`/api/quest/${questId}/dungeon/grid/take`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pick: idx + 1 }),
      });
      if (res.ok) { toast.success("Picked up"); onRefresh(); }
      else toast.error("Could not pick up");
    } finally { setContentBusy(false); }
  }

  async function takeKey() {
    if (contentBusy) return;
    setContentBusy(true);
    try {
      const res = await fetch(`/api/quest/${questId}/dungeon/grid/take`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.ok) { const b = await res.json() as { tier?: string }; toast.success(`Got the ${b.tier} key`); onRefresh(); }
      else toast.error("Could not pick up");
    } finally { setContentBusy(false); }
  }

  // Combat state
  const combatState = ws.state;
  const currentActorId = combatState?.status === "active" ? combatState.turn_order[combatState.turn_index % combatState.turn_order.length] : null;
  const myTurn = currentActorId === selfId;
  const allMonsters = combatState?.monsters ?? [];
  const liveMonsters = allMonsters.filter((m) => m.hp > 0);
  const isMonsterTurn = currentActorId ? isMonsterActor(currentActorId) : false;
  const combatEnded = combatState?.status === "victory" || combatState?.status === "defeat" || combatState?.status === "fled";

  // Auto-target: when there's exactly one live monster, target it. When
  // the picked target dies, switch to the lowest-HP live monster so the
  // player isn't stuck on a corpse. Keyed on the live-id list so it
  // re-runs whenever monsters die/spawn.
  const liveIdsKey = liveMonsters.map((m) => m.id ?? "").join(",");
  useEffect(() => {
    if (liveMonsters.length === 0) {
      setTargetMonsterId(null);
      return;
    }
    if (liveMonsters.length === 1) {
      setTargetMonsterId(liveMonsters[0].id ?? null);
      return;
    }
    // Multi-monster: if current target is dead/missing, pick the lowest
    // HP live monster (focus-fire the wounded one).
    setTargetMonsterId((cur) => {
      const stillAlive = cur && liveMonsters.some((m) => m.id === cur);
      if (stillAlive) return cur;
      const lowestHp = [...liveMonsters].sort((a, b) => a.hp - b.hp)[0];
      return lowestHp.id ?? null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveIdsKey]);
  const effectiveTarget = liveMonsters.length > 0 ? (targetMonsterId ?? liveMonsters[0].id ?? null) : null;

  const bgUrl = roomBgUrl(currentNode.shape, content);
  const isMobile = useIsMobile(700);
  // Right-rail container that holds minimap + combat log.
  // - Desktop: top-right, vertical stack, ~22vw wide.
  // - Mobile: bottom of room view. If combat (log visible) → full-width row;
  //   if exploring (no log) → small chip top-right to save room view space.
  const showLog = combatActive && ws.log.length > 0;
  const railStyle: React.CSSProperties = isMobile
    ? (showLog
        ? { position: "absolute", left: 8, right: 8, bottom: 8, display: "flex", flexDirection: "row", gap: 8, zIndex: 6 }
        : { position: "absolute", top: 8, right: 8, display: "flex", flexDirection: "column", gap: 8, zIndex: 6 })
    // Desktop: anchor rail to both top and bottom so the combined map+log
    // pane fills the full vertical height of the room view. The map keeps
    // its aspect ratio (fluid mode); the log flexes to take remaining space.
    : { position: "absolute", top: 12, right: 12, bottom: 12, width: "min(300px, 22vw)", display: "flex", flexDirection: "column", gap: 8, zIndex: 6 };
  const railItemStyle: React.CSSProperties = isMobile && showLog ? { flex: 1, minWidth: 0 } : { width: "100%" };
  const useFluidMap = !isMobile || showLog;

  return (
    <div style={{ position: "fixed", inset: 0, background: "#0a0b0e", display: "flex", flexDirection: "column", overflow: "hidden", fontFamily: "Inter, system-ui, sans-serif" }}>
      {/* Top bar — slimmed: exit, keys + status. Room type/content removed
          (it was redundant with the scene itself + minimap). */}
      <div style={{ background: "rgba(10,11,14,0.95)", borderBottom: "1px solid #1e2028", padding: "0 12px", height: 40, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, zIndex: 10 }}>
        <button onClick={onExit} style={{ background: "none", border: "none", color: "#9aa0a6", cursor: "pointer", fontSize: 13, padding: "4px 8px", borderRadius: 6, display: "flex", alignItems: "center", gap: 6 }}>
          <Icon name="footprint" size={13} /> Exit
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {combatActive && <span style={{ fontSize: 11, color: ws.connection === "open" ? "#39ff14" : "#9aa0a6" }}>{ws.connection === "open" ? "● live" : "○ …"}</span>}
          <span style={{ fontSize: 11, color: "#9aa0a6" }}>
            <Icon name="key" size={10} color="#b45309" /> {character.keys_bronze}
            <Icon name="key" size={10} color="#d1d5db" style={{ marginLeft: 4 }} /> {character.keys_silver}
            <Icon name="key" size={10} color="#fbbf24" style={{ marginLeft: 4 }} /> {character.keys_gold}
          </span>
        </div>
      </div>

      {/* Room view */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden", minHeight: 0 }}>
        <img src={bgUrl} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to bottom, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.05) 40%, rgba(0,0,0,0.55) 100%)", pointerEvents: "none" }} />

        {/* Floating initiative strip (combat only) — top center overlay */}
        {combatActive && combatState && (
          <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: 8 }}>
            <InitStrip state={combatState} selfId={selfId} />
          </div>
        )}

        {/* Monster strip during combat. One monster → centered "primary"
            card (visual continuity with the old single overlay). Two or
            more → row of smaller cards, click-to-target. Each card owns
            its own defeat animation so kills don't restart sibling anims. */}
        {combatActive && allMonsters.length > 0 && (() => {
          const mark = combatState?.ability_state?.mark;
          const markActive = !!(mark && combatState && combatState.round <= mark.expires_after_round);
          // The marked monster is the most recently target_id'd by /sq mark.
          // Engine doesn't store which monster — mark_applied event carries
          // it. For now: highlight the current target if mark is active.
          const markedId = markActive ? effectiveTarget : null;
          return (
            <MonsterStrip
              monsters={allMonsters}
              flashIds={flashIds}
              lastSlash={lastSlash}
              lastLunge={lastLunge}
              markedMonsterId={markedId}
              targetMonsterId={effectiveTarget}
              onTarget={setTargetMonsterId}
            />
          );
        })()}

        {/* Content figure overlay — when the room contains a person or
            object, paint a visible indicator on the scene so the room
            doesn't look empty. Only shows for non-chamber, non-dead-end
            shapes where the bg art is just an empty corridor. */}
        {!combatActive && content && currentNode.shape && needsFigureOverlay(currentNode.shape, content) && (
          <ContentFigureOverlay content={content} />
        )}

        {/* Right rail — single combined pane with minimap on top, combat log
            below. On desktop: vertical column on the right side at ~1/8
            viewport wide. On mobile: bottom of the room view, horizontal.
            Log has a Details toggle: simple text default, expand to show
            dice rolls (d20 + mod = total vs AC etc) and formulas. */}
        <div style={railStyle}>
          <div style={{
            ...railItemStyle,
            // On desktop, the inner pane fills the rail's full height so
            // the map sits at the top and the log expands beneath it.
            flex: !isMobile ? 1 : undefined,
            minHeight: !isMobile ? 0 : undefined,
            background: "rgba(0,0,0,0.6)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 8,
            backdropFilter: "blur(6px)",
            display: "flex",
            flexDirection: isMobile ? "row" : "column",
            overflow: "hidden",
          }}>
            <div style={{
              padding: "8px 10px 6px",
              borderRight: isMobile ? "1px solid rgba(255,255,255,0.08)" : "none",
              borderBottom: !isMobile && showLog ? "1px solid rgba(255,255,255,0.08)" : "none",
              // Desktop with log: map area sizes to its content (aspect-
              // ratio'd map). Desktop without log: map area takes the
              // whole pane, map grows to fit. Mobile: split with log.
              flex: isMobile ? 1 : (showLog ? "0 0 auto" : "1 1 auto"),
              minHeight: 0,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
            }}>
              <GridMinimap graph={graph} fluid={useFluidMap} />
            </div>
            {combatActive && ws.log.length > 0 && (
              <div style={{ padding: "6px 10px 8px", flex: isMobile ? 1 : "1 1 auto", minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4, flexShrink: 0 }}>
                  <div style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1.5, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>Combat log</div>
                  <button
                    onClick={() => setLogDetails((v) => !v)}
                    title={logDetails ? "Hide dice / formulas" : "Show dice / formulas"}
                    style={{ background: "none", border: "1px solid #2a2d33", color: logDetails ? "#fcd34d" : "#6b7280", fontSize: 9, padding: "1px 6px", borderRadius: 3, cursor: "pointer", letterSpacing: 0.5, fontFamily: "ui-monospace, monospace" }}>
                    DETAILS
                  </button>
                </div>
                {/* Legacy combat log: inset dark panel, monospace, 13px, generous
                    line-height; events flow like a console scrollback. */}
                <div ref={logScrollRef} style={{
                  maxHeight: isMobile ? 100 : undefined,
                  flex: isMobile ? undefined : "1 1 auto",
                  minHeight: 0,
                  overflowY: "auto",
                  background: "#0e0f12",
                  borderRadius: 6,
                  padding: "8px 10px",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 12,
                  lineHeight: 1.45,
                  display: "flex", flexDirection: "column", gap: 3,
                }}>
                  {ws.log.slice(-20).map((e) => {
                    const toneColor = e.tone === "good" ? "#86efac" : e.tone === "bad" ? "#fca5a5" : e.tone === "info" ? "#93c5fd" : "#9aa0a6";
                    if (e.side === "divider") {
                      // Turn-change divider: thin rule + actor name on a
                      // tinted slab so the eye can find "where am I in the
                      // round" at a glance.
                      const accent = e.divider_side === "enemy" ? "#7f1d1d" : "#166534";
                      const label = e.divider_side === "enemy" ? "#fca5a5" : "#86efac";
                      return (
                        <div key={e.id} style={{
                          display: "flex", alignItems: "center", gap: 6,
                          margin: "2px -10px 1px",
                          padding: "1px 10px",
                          background: `linear-gradient(90deg, ${accent}33 0%, transparent 100%)`,
                          borderTop: `1px solid ${accent}55`,
                          borderBottom: `1px solid ${accent}22`,
                          fontSize: 10, letterSpacing: 1, textTransform: "uppercase",
                          color: label, fontWeight: 700,
                        }}>
                          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.text}</span>
                        </div>
                      );
                    }
                    // Side-colored left rule + subtle bg tint so eye can
                    // scan party-vs-enemy bursts without reading text.
                    const sideAccent = e.side === "party" ? "#16a34a" : e.side === "enemy" ? "#dc2626" : "transparent";
                    return (
                      <div key={e.id} style={{
                        color: toneColor,
                        wordBreak: "break-word",
                        paddingLeft: e.side ? 7 : 0,
                        borderLeft: e.side ? `2px solid ${sideAccent}88` : "none",
                        background: e.side ? `${sideAccent}11` : "transparent",
                        borderRadius: 2,
                      }}>
                        <div>{e.text}</div>
                        {logDetails && e.detail && (
                          <div style={{ fontSize: 11, color: "#6b7280", paddingLeft: 10 }}>
                            ↳ {e.detail}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Scene description (non-combat) */}
        {!combatActive && currentNode.description && (
          <div style={{ position: "absolute", top: 12, left: 12, maxWidth: 360, background: "rgba(0,0,0,0.6)", padding: "8px 12px", borderRadius: 8, backdropFilter: "blur(4px)" }}>
            <p style={{ fontSize: 13, color: "#d1d5db", fontStyle: "italic", margin: 0, lineHeight: 1.4 }}>{currentNode.description}</p>
          </div>
        )}

        {/* Compass navigation (non-combat, no content blocking) */}
        {!combatActive && !blocksMovement(content) && <CompassNav node={currentNode} onMove={tryMoveTo} disabled={moving} />}

        {/* Door interaction modal */}
        {doorPrompt && (
          <DoorInteractionModal
            dir={doorPrompt.dir}
            door={doorPrompt.door}
            character={character}
            onUseKey={() => useKeyOnDoor(doorPrompt.dir)}
            onPick={() => pickLock(doorPrompt.dir)}
            onBash={() => bashDoor(doorPrompt.dir)}
            onCancel={() => setDoorPrompt(null)}
          />
        )}

        {/* Combat victory/defeat overlay — staged fade so the monster's
            defeat animation gets a clean ~0.6s solo before the tint
            covers it. Banner pops a beat after with letter-spacing flare. */}
        {combatActive && combatEnded && ws.outcome && (
          <div
            className="gq-outcome-tint"
            style={{ position: "absolute", inset: 0, background: ws.outcome.status === "victory" ? "rgba(0,80,20,0.55)" : "rgba(80,0,0,0.6)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, zIndex: 20 }}
          >
            <div
              className="gq-outcome-banner"
              style={{ fontFamily: DISPLAY_FONT, fontSize: 44, color: ws.outcome.status === "victory" ? "#86efac" : "#fca5a5", textShadow: ws.outcome.status === "victory" ? "0 0 24px rgba(134,239,172,0.6)" : "0 0 24px rgba(252,165,165,0.5)" }}
            >
              {ws.outcome.status === "victory" ? "VICTORY" : "DEFEATED"}
            </div>
            {ws.outcome.status === "defeat" && (
              <button onClick={onExit} style={{ padding: "8px 20px", background: "#5c1f1f", border: "1px solid #7f1d1d", borderRadius: 6, color: "#fca5a5", cursor: "pointer" }}>Return to town</button>
            )}
          </div>
        )}

      </div>

      {/* Content interaction overlay (non-combat rooms with stuff to do).
          Renders ABOVE the party bar so an encounter's enemy HP bar lives
          between the centred monster card and the heroes — matching the
          first-person spatial metaphor (foes overhead, heroes at the bottom). */}
      {!combatActive && (
        <ContentOverlay
          node={currentNode}
          content={content}
          onEnterCombat={enterCombat}
          onTakeLoot={takeLoot}
          onTakeKey={takeKey}
          onRefresh={onRefresh}
          questId={questId}
        />
      )}

      {/* Party bar (BLUE area) — its own row above the action buttons. */}
      <PartyBar
        fighters={combatActive ? (combatState?.fighters ?? null) : null}
        selfId={selfId}
        party={party.length > 0 ? party : [character]}
        onClickSelf={onOpenInventory}
        flashIds={flashIds}
      />

      {/* Action buttons row (RED area) — own row at the very bottom. Always
          rendered while combat is active so the player never sees an empty
          bottom bar; falls back to a connecting/loading state if the WS
          hasn't seeded combatState yet. */}
      {combatActive && !combatEnded && (
        combatState ? (
          <CombatPanel
            state={combatState}
            selfId={selfId}
            onSend={send}
            autoResolve={autoResolve}
            setAutoResolve={setAutoResolve}
            myTurn={myTurn}
            isMonsterTurn={isMonsterTurn}
            items={items}
            characterClass={character.class}
            targetMonsterId={effectiveTarget}
          />
        ) : (
          <div style={{ background: "rgba(10,11,14,0.92)", borderTop: "1px solid #1e2028", padding: "16px", flexShrink: 0, textAlign: "center", color: "#9aa0a6", fontSize: 13 }}>
            <Icon name="hourglass" size={14} /> Connecting to combat…
            <button
              onClick={() => { setCombatActive(false); setTimeout(() => setCombatActive(true), 100); }}
              style={{ marginLeft: 12, padding: "4px 10px", background: "#1a1c21", border: "1px solid #2a2d33", borderRadius: 5, color: "#9aa0a6", fontSize: 11, cursor: "pointer" }}>
              Retry
            </button>
          </div>
        )
      )}

      {/* (Party bar is now a floating overlay inside the room view above.) */}

      {/* Animated dice rolls — float in mid-screen above everything */}
      <DiceRollDisplay rolls={diceRolls} />
    </div>
  );
}

// True when the room's bg is a generic corridor (no content baked into the
// art) AND the content kind is a "visible thing in the room". In those cases
// we overlay a figure/object indicator so the scene isn't empty-looking.
function needsFigureOverlay(shape: RoomShape, content: GridRoomContent): boolean {
  // Encounters and bosses ALWAYS overlay regardless of shape — the bg art
  // never includes the actual monster, and the player should see what
  // they're about to fight before clicking Engage.
  if ((content.kind === "encounter" || content.kind === "boss") && !content.cleared) return true;
  // Other content overlays only on corridor shapes (dead-ends and chambers
  // already get content-baked art).
  if (shape.startsWith("dead_") || shape === "chamber" || shape === "entry" || shape === "boss") return false;
  if (content.kind === "npc" && !content.resolved) return true;
  if (content.kind === "merchant" && !content.resolved) return true;
  if (content.kind === "loot" && !content.taken) return true;
  if (content.kind === "key_pickup" && !content.taken) return true;
  if (content.kind === "lockbox" && !content.resolved) return true;
  if (content.kind === "trap" && !content.resolved) return true;
  return false;
}

function ContentFigureOverlay({ content }: { content: GridRoomContent }) {
  // Encounter/boss rooms show the actual monster portrait — same visual
  // language as in-combat MonsterOverlay so the player knows exactly what
  // they're about to engage.
  if ((content.kind === "encounter" || content.kind === "boss") && !content.cleared) {
    const m = content.monsters[0];
    if (!m) return null;
    const isBoss = content.kind === "boss";
    const borderColor = isBoss ? "#fca5a5" : "#fcd34d";
    return (
      <div style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -55%)",
        background: "rgba(10,11,14,0.88)",
        border: `2px solid ${borderColor}`,
        borderRadius: 12,
        padding: "10px 14px",
        minWidth: 220,
        maxWidth: 300,
        backdropFilter: "blur(8px)",
        boxShadow: isBoss ? "0 0 36px rgba(239,68,68,0.4)" : "0 0 28px rgba(252,211,77,0.3)",
        pointerEvents: "none",
      }}>
        {m.art_url && (
          <img src={m.art_url} alt={m.name} style={{
            width: "100%", height: 150, objectFit: "cover",
            borderRadius: 8, marginBottom: 8, display: "block",
          }} />
        )}
        {!m.art_url && (
          <div style={{ display: "flex", justifyContent: "center", padding: "20px 0" }}>
            <Icon name="dragon-head" size={64} color={borderColor} />
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <div style={{ fontFamily: DISPLAY_FONT, fontSize: 15, fontWeight: 700, color: isBoss ? "#fca5a5" : "#f5f5f5" }}>
            {isBoss && <Icon name="dragon-head" size={13} color="#fca5a5" />} {m.name}
          </div>
          <div style={{ fontSize: 12, color: "#9aa0a6", fontVariantNumeric: "tabular-nums" }}>
            {m.hp}/{m.max_hp}
          </div>
        </div>
        <HpBar current={m.hp} max={m.max_hp} color={isBoss ? "#ef4444" : undefined} height={5} />
      </div>
    );
  }

  // NPCs and merchants with a generated portrait render as an actual figure
  // overlay so the player sees a real person in the scene.
  if ((content.kind === "npc" || content.kind === "merchant") && content.art_url) {
    const isMerchant = content.kind === "merchant";
    const borderColor = isMerchant ? "#fcd34d" : "#fef3c7";
    const label = isMerchant ? "Merchant" : "A traveler";
    return (
      <div style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -55%)",
        background: "rgba(10,11,14,0.88)",
        border: `2px solid ${borderColor}`,
        borderRadius: 12,
        padding: "8px 10px 10px",
        width: 200,
        backdropFilter: "blur(8px)",
        boxShadow: `0 0 28px ${borderColor}40`,
        pointerEvents: "none",
      }}>
        <img src={content.art_url} alt={label} style={{
          width: "100%", height: 180, objectFit: "cover",
          borderRadius: 8, display: "block",
        }} />
        <div style={{ fontFamily: DISPLAY_FONT, fontSize: 15, fontWeight: 700, color: borderColor, textAlign: "center", marginTop: 6, letterSpacing: 1 }}>
          {label}
        </div>
      </div>
    );
  }

  // Other content kinds: icon + label centered on the scene.
  let icon = "player";
  let color = "#d1d5db";
  let label = "";
  switch (content.kind) {
    case "npc": icon = "hood"; color = "#fef3c7"; label = "A traveler"; break;
    case "merchant": icon = "gold-bar"; color = "#fcd34d"; label = "Merchant"; break;
    case "loot": icon = "gold-bar"; color = "#a7f3d0"; label = "Loot"; break;
    case "key_pickup": {
      const tier = content.tier;
      color = tier === "gold" ? "#fbbf24" : tier === "silver" ? "#d1d5db" : "#b45309";
      icon = "key"; label = `${tier[0].toUpperCase()}${tier.slice(1)} key`;
      break;
    }
    case "lockbox": icon = "key"; color = "#60a5fa"; label = "Locked chest"; break;
    case "trap": icon = "bolt-shield"; color = "#fca5a5"; label = "Trap"; break;
  }
  return (
    <div style={{
      position: "absolute",
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 10,
      padding: "16px 28px",
      background: "rgba(0,0,0,0.62)",
      border: `2px solid ${color}`,
      borderRadius: 14,
      backdropFilter: "blur(6px)",
      boxShadow: `0 0 36px ${color}50`,
      pointerEvents: "none",
    }}>
      <Icon name={icon} size={80} color={color} />
      <div style={{ fontFamily: DISPLAY_FONT, fontSize: 18, color, letterSpacing: 1.5, textShadow: "0 2px 8px rgba(0,0,0,0.8)" }}>{label}</div>
    </div>
  );
}

function blocksMovement(content: GridRoomContent | undefined): boolean {
  if (!content) return false;
  if (content.kind === "encounter" && !content.cleared) return true;
  if (content.kind === "boss" && !content.cleared) return true;
  if (content.kind === "trap" && !content.resolved) return true;
  return false;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function DoorInteractionModal({ dir, door, character, onUseKey, onPick, onBash, onCancel }: {
  dir: DungeonDirection; door: GridDoor; character: Character;
  onUseKey: () => void; onPick: () => void; onBash: () => void; onCancel: () => void;
}) {
  const tier = door.lock_tier ?? "bronze";
  const tierKeys = tier === "bronze" ? character.keys_bronze : tier === "silver" ? character.keys_silver : character.keys_gold;
  const tierColor = tier === "gold" ? "#fbbf24" : tier === "silver" ? "#d1d5db" : "#b45309";
  const isLocked = door.state === "locked";
  return (
    <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 30, backdropFilter: "blur(4px)" }}>
      <div style={{ background: "#0e0f12", border: "1px solid #2a2d33", borderRadius: 12, padding: 20, minWidth: 320, maxWidth: 420 }}>
        <div style={{ fontFamily: DISPLAY_FONT, fontSize: 18, color: isLocked ? "#fca5a5" : "#f59e0b", marginBottom: 6 }}>
          {isLocked ? "Locked Door" : "Barred Door"} — {dir.toUpperCase()}
        </div>
        <div style={{ fontSize: 12, color: "#9aa0a6", marginBottom: 14 }}>
          {isLocked ? `Requires a ${tier} key.` : "The way is barred. Force it open?"}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {isLocked && (
            <button
              onClick={onUseKey}
              disabled={tierKeys <= 0}
              style={{ padding: "10px 14px", background: tierKeys > 0 ? "#1a2e1a" : "#1a1c21", border: `1px solid ${tierKeys > 0 ? "#166534" : "#2a2d33"}`, borderRadius: 8, color: tierKeys > 0 ? "#86efac" : "#4a5568", cursor: tierKeys > 0 ? "pointer" : "not-allowed", textAlign: "left", display: "flex", alignItems: "center", gap: 10 }}>
              <Icon name="key" color={tierColor} size={16} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>Use {tier} key</div>
                <div style={{ fontSize: 11, opacity: 0.8 }}>You have {tierKeys}</div>
              </div>
            </button>
          )}
          {isLocked && door.pick_dc != null && (
            <button onClick={onPick} style={{ padding: "10px 14px", background: "#1a1e29", border: "1px solid #3a4566", borderRadius: 8, color: "#93c5fd", cursor: "pointer", textAlign: "left", display: "flex", alignItems: "center", gap: 10 }}>
              <Icon name="plain-dagger" size={16} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>Pick lock</div>
                <div style={{ fontSize: 11, opacity: 0.8 }}>DEX check vs DC {door.pick_dc}</div>
              </div>
            </button>
          )}
          {door.bash_dc != null && (
            <button onClick={onBash} style={{ padding: "10px 14px", background: "#291515", border: "1px solid #663a3a", borderRadius: 8, color: "#fca5a5", cursor: "pointer", textAlign: "left", display: "flex", alignItems: "center", gap: 10 }}>
              <Icon name="sword" size={16} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>Bash</div>
                <div style={{ fontSize: 11, opacity: 0.8 }}>STR check vs DC {door.bash_dc} · 1d6 dmg on fail</div>
              </div>
            </button>
          )}
          <button onClick={onCancel} style={{ padding: "8px 14px", background: "none", border: "1px solid #2a2d33", borderRadius: 8, color: "#9aa0a6", cursor: "pointer", fontSize: 12 }}>← Turn back</button>
        </div>
      </div>
    </div>
  );
}

function ContentOverlay({ node, content, onEnterCombat, onTakeLoot, onTakeKey, onRefresh, questId }: {
  node: GridNode; content: GridRoomContent | undefined;
  onEnterCombat: () => void; onTakeLoot: (idx: number) => void; onTakeKey: () => void;
  onRefresh: () => void; questId: number;
}) {
  // Legacy AI-graph fallback: synthesise an encounter content from the
  // node.encounter field so legacy quests still see the Engage panel.
  const effectiveContent: GridRoomContent | undefined = content
    ?? (node.encounter && !node.encounter.cleared
      ? { kind: "encounter" as const, monsters: node.encounter.monsters, cleared: false }
      : undefined);
  if (!effectiveContent) return null;
  if (effectiveContent.kind === "empty" || effectiveContent.kind === "entry") return null;
  const c = effectiveContent;

  if ((c.kind === "encounter" || c.kind === "boss") && !c.cleared) {
    const m = c.monsters[0];
    if (!m) return null;
    const isBoss = c.kind === "boss";
    return (
      <div style={{ background: isBoss ? "rgba(80,10,10,0.95)" : "rgba(10,11,14,0.95)", borderTop: `1px solid ${isBoss ? "#7f1d1d" : "#1e2028"}`, padding: "12px 16px", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: isBoss ? "#fca5a5" : "#f5f5f5", fontFamily: DISPLAY_FONT }}>
            {isBoss && <Icon name="dragon-head" size={14} color="#fca5a5" />} {m.name}
          </div>
          {m.flavor && (
            <div style={{ fontSize: 12, color: "#d1d5db", fontStyle: "italic", marginTop: 4, marginBottom: 6, lineHeight: 1.4, maxWidth: 560 }}>
              {m.flavor}
            </div>
          )}
          <HpBar current={m.hp} max={m.max_hp} color={isBoss ? "#ef4444" : undefined} height={5} />
          <div style={{ fontSize: 11, color: "#9aa0a6", marginTop: 2 }}>{m.hp}/{m.max_hp} HP{isBoss ? " · BOSS" : ""}</div>
        </div>
        <button onClick={onEnterCombat} style={{ padding: "8px 20px", background: isBoss ? "#7f1d1d" : "#b89b3a", border: `1px solid ${isBoss ? "#991b1b" : "#c4a35a"}`, borderRadius: 8, color: isBoss ? "#fca5a5" : "#0e0f12", fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 6, alignSelf: "center", flexShrink: 0 }}>
          <Icon name="sword" size={14} /> Engage
        </button>
      </div>
    );
  }

  if (c.kind === "loot" && !c.taken) {
    return (
      <OverlayPanel title="Found items">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 }}>
          {c.items.map((opt, i) => (
            <LootOptionTile key={i} opt={opt} onClick={() => onTakeLoot(i)} />
          ))}
        </div>
      </OverlayPanel>
    );
  }

  if (c.kind === "key_pickup" && !c.taken) {
    const tierColor = c.tier === "gold" ? "#fbbf24" : c.tier === "silver" ? "#d1d5db" : "#b45309";
    return (
      <OverlayPanel title={`A ${c.tier} key`}>
        <button
          onClick={onTakeKey}
          style={{ padding: "10px 14px", background: "#131519", border: `1px solid ${tierColor}`, borderRadius: 8, color: tierColor, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <Icon name="key" color={tierColor} /> Take the {c.tier} key
        </button>
      </OverlayPanel>
    );
  }

  if (c.kind === "trap" && !c.resolved) {
    return (
      <OverlayPanel title="A trap is set">
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {c.choices.map((tc, i) => (
            <button key={i}
              onClick={async () => {
                const res = await fetch(`/api/quest/${questId}/dungeon/grid/trap`, {
                  method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ pick: i + 1 }),
                });
                if (res.ok) {
                  const b = await res.json() as { success: boolean; roll: number; total: number; dc: number; damage: number };
                  toast(`${tc.skill.toUpperCase()}: ${b.roll} → ${b.total} vs DC ${b.dc} — ${b.success ? "passed" : `failed (-${b.damage} HP)`}`);
                  onRefresh();
                } else toast.error("Trap choice failed");
              }}
              style={{ padding: "10px 14px", background: "#131519", border: "1px solid #2a2d33", borderRadius: 8, color: "#d1d5db", cursor: "pointer", textAlign: "left", fontSize: 12, display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 18 }}>{tc.emoji}</span>
              <div>
                <div style={{ fontWeight: 600 }}>{tc.text}</div>
                <div style={{ fontSize: 11, color: "#9aa0a6" }}>{tc.skill.toUpperCase()} check — {tc.fail_damage} dmg on fail</div>
              </div>
            </button>
          ))}
        </div>
      </OverlayPanel>
    );
  }

  if (c.kind === "lockbox" && !c.resolved) {
    const tier = c.lock_tier;
    const tierColor = tier === "gold" ? "#fbbf24" : tier === "silver" ? "#d1d5db" : "#b45309";
    return (
      <OverlayPanel title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Icon name="key" color={tierColor} size={14} /> Locked chest — needs {tier} key
        </span>
      }>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
          {c.options.map((opt, i) => (
            <LootOptionTile
              key={i}
              opt={opt}
              onClick={async () => {
                const res = await fetch(`/api/quest/${questId}/dungeon/grid/lockbox`, {
                  method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ pick: i + 1 }),
                });
                if (res.ok) { toast.success("Chest opened"); onRefresh(); }
                else { const b = await res.json().catch(() => ({})) as { error?: string }; toast.error(b.error === "no_key" ? `No ${tier} key` : "Could not open"); }
              }}
            />
          ))}
        </div>
      </OverlayPanel>
    );
  }

  if (c.kind === "npc" && !c.resolved) {
    return (
      <OverlayPanel title="A traveler">
        <p style={{ fontSize: 13, color: "#d1d5db", fontStyle: "italic", margin: "0 0 10px" }}>{c.greeting}</p>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={async () => {
              const res = await fetch(`/api/quest/${questId}/dungeon/grid/npc`, {
                method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pick: 1 }),
              });
              if (res.ok) { toast.success("Accepted"); onRefresh(); }
            }}
            style={{ padding: "7px 14px", background: "#1a2e1a", border: "1px solid #166534", borderRadius: 6, color: "#86efac", cursor: "pointer" }}>
            Accept: {c.offer.name}
          </button>
          <button
            onClick={async () => {
              const res = await fetch(`/api/quest/${questId}/dungeon/grid/npc`, {
                method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pick: 0 }),
              });
              if (res.ok) onRefresh();
            }}
            style={{ padding: "7px 14px", background: "none", border: "1px solid #2a2d33", borderRadius: 6, color: "#9aa0a6", cursor: "pointer" }}>Decline</button>
        </div>
      </OverlayPanel>
    );
  }

  if (c.kind === "merchant" && !c.resolved) {
    return (
      <OverlayPanel title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Icon name="gold-bar" color="#fbbf24" size={14} /> Merchant
        </span>
      }>
        <p style={{ fontSize: 13, color: "#d1d5db", fontStyle: "italic", margin: "0 0 10px" }}>{c.greeting}</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
          {c.stock.map((opt, i) => (
            <LootOptionTile
              key={i}
              opt={opt}
              price={priceForDisplay(opt.item_type, opt.rarity)}
              onClick={async () => {
                const res = await fetch(`/api/quest/${questId}/dungeon/grid/merchant`, {
                  method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ pick: i + 1 }),
                });
                if (res.ok) { toast.success("Purchased"); onRefresh(); }
                else { const b = await res.json().catch(() => ({})) as { error?: string }; toast.error(b.error === "insufficient_gold" ? "Not enough gold" : "Could not buy"); }
              }}
            />
          ))}
        </div>
      </OverlayPanel>
    );
  }

  return null;
}

interface UsableItem {
  id: number;
  item_name: string;
  item_type: string;
  power: number;
  equipped: boolean;
  rarity?: string;
  flavor?: string | null;
  slot?: string | null;
  stat_bonus?: Record<string, number> | null;
  weapon_range?: "melee" | "ranged" | "focus" | null;
  item_subtype?: string | null;
}

function CombatPanel({ state, selfId, onSend, autoResolve, setAutoResolve, myTurn, isMonsterTurn, items, characterClass, targetMonsterId }: {
  state: CombatState; selfId: string;
  onSend: (a: TurnAction) => boolean;
  autoResolve: boolean; setAutoResolve: (b: boolean) => void;
  myTurn: boolean; isMonsterTurn: boolean;
  items: UsableItem[];
  characterClass: string;
  // Currently-picked enemy. Parent manages this via MonsterStrip click-
  // to-target; we just use it as the target_id for attack/cast/sig.
  targetMonsterId: string | null;
}) {
  const me = state.fighters.find((f) => f.id === selfId);
  const mana = me?.mana ?? 0;
  const myPos = me?.position ?? "front";
  const liveMonsters = state.monsters.filter((m) => m.hp > 0);
  // Use the parent-managed target; fall back to first live monster if
  // unset (e.g. mid-state-transition).
  const target = targetMonsterId && liveMonsters.some((m) => m.id === targetMonsterId)
    ? targetMonsterId
    : (liveMonsters[0]?.id ?? null);
  const [picking, setPicking] = useState<"heal" | "shield" | null>(null);
  const [itemOpen, setItemOpen] = useState(false);
  // Give flow: select item → select ally. itemId stays set across the two-step picker.
  const [givePicker, setGivePicker] = useState<"closed" | "selectItem" | { itemId: number }>("closed");
  const usable = items.filter((it) => !it.equipped && ["consumable", "magic", "revive", "tool"].includes(it.item_type));
  const giveable = items.filter((it) => !it.equipped);
  const otherFighters = state.fighters.filter((f) => f.id !== selfId && f.hp > 0);
  const ability = ABILITY_BY_CLASS[characterClass] ?? null;

  async function fireGive(itemId: number, toUserId: string) {
    await fetch(`/api/inventory/${itemId}/give`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to_user_id: toUserId }),
    });
    setGivePicker("closed");
  }

  // Disabled state for the action row when it isn't the player's turn.
  // Buttons stay visible so the bottom row doesn't disappear; they grey out
  // and the user gets a turn-status hint instead of an empty bar.
  const otherActor = state.fighters.find((f) => f.id === state.turn_order[state.turn_index % state.turn_order.length]);
  const turnStatus = myTurn
    ? null
    : isMonsterTurn
      ? (autoResolve ? "Enemy turn — auto-resolving…" : null)
      : `Waiting for ${otherActor?.name ?? "another player"}…`;

  return (
    <div style={{ background: "rgba(10,11,14,0.92)", borderTop: "1px solid #1e2028", flexShrink: 0, overflow: "hidden", backdropFilter: "blur(6px)" }}>
      {/* Inline target picker for heal/shield (slides in above the buttons) */}
      {picking && myTurn && (
        <div style={{ padding: "6px 12px 4px", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", borderBottom: "1px solid #1a1c21" }}>
          <span style={{ fontSize: 11, color: "#9aa0a6" }}>{picking === "heal" ? "Heal who?" : "Shield who?"}</span>
          {state.fighters.filter((f) => f.hp > 0).map((f) => (
            <button key={f.id}
              onClick={() => { onSend({ kind: picking, actor: selfId, target: f.id }); setPicking(null); }}
              style={{ padding: "3px 10px", background: "#1a2e1a", border: "1px solid #166534", borderRadius: 5, color: "#86efac", fontSize: 11, cursor: "pointer" }}>
              {f.name.split(" ")[0]} {f.hp}/{f.max_hp}
            </button>
          ))}
          <button onClick={() => setPicking(null)} style={{ padding: "3px 8px", background: "none", border: "1px solid #2a2d33", borderRadius: 5, color: "#9aa0a6", fontSize: 11, cursor: "pointer" }}>✕</button>
        </div>
      )}

      {/* Give-item: step 1 (item) as a modal, step 2 (ally) stays inline. */}
      {givePicker === "selectItem" && myTurn && (
        <PickerModal title="Give which item?" onClose={() => setGivePicker("closed")}>
          {giveable.length === 0 ? (
            <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>No items to give.</p>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
              {giveable.map((it) => (
                <LootOptionTile
                  key={it.id}
                  opt={itemToLootOpt(it)}
                  onClick={() => setGivePicker({ itemId: it.id })}
                />
              ))}
            </div>
          )}
        </PickerModal>
      )}
      {typeof givePicker === "object" && "itemId" in givePicker && myTurn && (
        <div style={{ padding: "6px 12px 4px", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", borderBottom: "1px solid #1a1c21" }}>
          <span style={{ fontSize: 11, color: "#9aa0a6" }}>Give to whom?</span>
          {otherFighters.length === 0 && <span style={{ fontSize: 11, color: "#4a5568" }}>No allies in combat</span>}
          {otherFighters.map((f) => (
            <button key={f.id}
              onClick={() => void fireGive(givePicker.itemId, f.id)}
              style={{ padding: "3px 10px", background: "#1a2e1a", border: "1px solid #166534", borderRadius: 5, color: "#86efac", fontSize: 11, cursor: "pointer" }}>
              {f.name.split(" ")[0]}
            </button>
          ))}
          <button onClick={() => setGivePicker("selectItem")} style={{ padding: "3px 8px", background: "none", border: "1px solid #2a2d33", borderRadius: 5, color: "#9aa0a6", fontSize: 11, cursor: "pointer" }}>← back</button>
        </div>
      )}

      {/* Item picker — modal so the cards have room to breathe */}
      {itemOpen && myTurn && (
        <PickerModal title="Use item" onClose={() => setItemOpen(false)}>
          {usable.length === 0 ? (
            <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>No usable items in your pack.</p>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
              {usable.map((it) => (
                <LootOptionTile
                  key={it.id}
                  opt={itemToLootOpt(it)}
                  onClick={() => {
                    onSend({ kind: "use_item", actor: selfId, item_id: it.id });
                    setItemOpen(false);
                  }}
                />
              ))}
            </div>
          )}
        </PickerModal>
      )}

      {/* Turn status hint (when not the player's turn) */}
      {turnStatus && (
        <div style={{ padding: "2px 12px 0", fontSize: 11, color: "#9aa0a6", fontStyle: "italic" }}>{turnStatus}</div>
      )}

      {/* Action buttons — vertical-style (icon top, label, mana below) */}
      <div style={{ padding: "8px 10px 10px", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
        <CBtn label="Attack" icon="sword" color="#b89b3a" disabled={!myTurn || !target} onClick={() => onSend({ kind: "attack", actor: selfId, target_id: target })} />
        <CBtn label="Cast" icon="crystal-wand" color="#818cf8" manaCost={1} disabled={!myTurn || mana < 1 || !target} onClick={() => onSend({ kind: "cast", actor: selfId, target_id: target })} />
        <CBtn label="Signature" icon="wax-seal" color="#a78bfa" manaCost={1} disabled={!myTurn || mana < 1 || !target} onClick={() => onSend({ kind: "signature", actor: selfId, target_id: target })} />
        {ability && (
          <CBtn
            label={ability.name}
            icon={ability.iconName}
            color="#d946ef"
            manaCost={ability.mana_cost}
            disabled={!myTurn || mana < ability.mana_cost || !!ability.needs_picker}
            onClick={() => onSend({ kind: "ability", actor: selfId, ability_id: ability.id })}
          />
        )}
        <CBtn label="Heal" icon="health-increase" color="#22c55e" manaCost={1} disabled={!myTurn || mana < 1} onClick={() => { setPicking("heal"); setItemOpen(false); }} />
        <CBtn label="Shield" icon="shield" color="#60a5fa" manaCost={1} disabled={!myTurn || mana < 1} onClick={() => { setPicking("shield"); setItemOpen(false); }} />
        <CBtn label={myPos === "front" ? "Back row" : "Front row"} icon={myPos === "front" ? "perspective-dice-two" : "perspective-dice-one"} color="#6b7280" disabled={!myTurn} onClick={() => onSend({ kind: "position", actor: selfId, to: myPos === "front" ? "back" : "front" })} />
        <CBtn label="Item" icon="ammo-bag" color="#c084fc" disabled={!myTurn || usable.length === 0} onClick={() => { setItemOpen((o) => !o); setPicking(null); setGivePicker("closed"); }} />
        <CBtn label="Give" icon="conversation" color="#fcd34d" disabled={!myTurn || giveable.length === 0 || otherFighters.length === 0} onClick={() => { setGivePicker("selectItem"); setItemOpen(false); setPicking(null); }} />
        <CBtn label="Mark" icon="target-poster" color="#f97316" disabled={!myTurn || !target} onClick={() => onSend({ kind: "mark", actor: selfId })} />
        <CBtn label="Wait" icon="hourglass" color="#475569" disabled={!myTurn} onClick={() => onSend({ kind: "wait", actor: selfId })} />
        <CBtn label="Flee" icon="run" color="#9aa0a6" disabled={!myTurn} onClick={() => onSend({ kind: "flee", actor: selfId })} />
        {!myTurn && isMonsterTurn && !autoResolve && (
          <CBtn label="Resolve" icon="dragon-head" color="#5c1f1f" onClick={() => onSend({ kind: "monster_act" })} />
        )}
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#4a5568", cursor: "pointer", marginLeft: 6 }}>
          <input type="checkbox" checked={autoResolve} onChange={(e) => setAutoResolve(e.target.checked)} style={{ accentColor: "#5c1f1f" }} />
          Auto
        </label>
      </div>
    </div>
  );
}

function CBtn({ label, icon, color, disabled, manaCost, onClick }: {
  label: string;
  icon?: string;
  color: string;
  disabled?: boolean;
  manaCost?: number;
  onClick: () => void;
}) {
  // Classic dungeon-crawler skill-button: icon prominent on top, label below,
  // mana cost as small numeric info beneath. Square-ish so a row of them
  // reads as a control panel rather than a chip row.
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={manaCost ? `${label} (costs ${manaCost} mana)` : label}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 3,
        padding: "8px 6px",
        width: 78,
        height: 78,
        background: disabled ? "#1a1c21" : color,
        border: `2px solid ${disabled ? "#2a2d33" : color}`,
        borderRadius: 8,
        color: disabled ? "#4a5568" : "#0e0f12",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        transition: "opacity 0.15s, transform 0.08s, filter 0.1s",
        flexShrink: 0,
      }}
      onMouseDown={(e) => { if (!disabled) e.currentTarget.style.transform = "translateY(1px)"; }}
      onMouseUp={(e) => { e.currentTarget.style.transform = ""; }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = ""; }}
    >
      {icon && <Icon name={icon} size={26} />}
      <span style={{ fontSize: 12, fontWeight: 700, lineHeight: 1, letterSpacing: 0.3 }}>{label}</span>
      <span style={{
        fontSize: 10, fontWeight: 700, lineHeight: 1, minHeight: 10,
        color: disabled ? "#4a5568" : "rgba(0,0,0,0.7)",
      }}>
        {manaCost ? `−${manaCost} mana` : ""}
      </span>
    </button>
  );
}

function OverlayPanel({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ background: "rgba(10,11,14,0.97)", borderTop: "1px solid #1e2028", padding: "10px 14px", flexShrink: 0, maxHeight: "38vh", overflowY: "auto" }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, color: "#9aa0a6", marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

const lootBtn: React.CSSProperties = {
  padding: "10px", background: "#131519", border: "1px solid #2a2d33", borderRadius: 8,
  color: "#d1d5db", cursor: "pointer", textAlign: "left", fontSize: 12,
};

// Rarity → border + name color. Kept inline so this module doesn't depend
// on the dashboard's RARITY_COLOR export.
const RARITY_TINT: Record<string, string> = {
  common: "#8a8f98",
  uncommon: "#16a34a",
  rare: "#3b82f6",
  epic: "#a855f7",
  legendary: "#f59e0b",
};

// Pick a sensible icon for a LootOption. Slot wins for non-weapons; weapons
// fall back to weapon_range or generic sword. Mirrors apps/web/src/App.tsx
// itemIcon() but trimmed to the fields LootOption carries.
function lootIcon(opt: { item_type: string; slot?: string | null; weapon_range?: "melee" | "ranged" | "focus" | null; item_subtype?: string | null }): string {
  if (opt.slot && opt.slot !== "main_hand") {
    switch (opt.slot) {
      case "off_hand":  return opt.item_subtype === "gloves" ? "gloves" : "round-shield";
      case "body":      return "chest-armor";
      case "helmet":    return "heavy-helm";
      case "pants":     return "armored-pants";
      case "boots":     return "boots";
      case "ring":      return "ring";
      case "amulet":    return "gem-chain";
    }
  }
  if (opt.item_type === "weapon") {
    if (opt.weapon_range === "focus") return "crystal-wand";
    if (opt.weapon_range === "ranged") return "crossbow";
    return "sword";
  }
  if (opt.item_type === "armor")     return "chest-armor";
  if (opt.item_type === "consumable") return "bubbling-potion";
  if (opt.item_type === "magic")     return "crystal-ball";
  if (opt.item_type === "revive")    return "crowned-heart";
  if (opt.item_type === "tool")      return "anvil";
  if (opt.item_type === "scroll")    return "scroll-unfurled";
  return "anvil";
}

// Human-readable secondary line for a loot tile: slot · range · stat bonuses.
function lootSubLabel(opt: LootOption): string {
  const parts: string[] = [];
  if (opt.slot && opt.slot !== "main_hand") {
    const slotLabel = opt.slot.replace("_", " ");
    parts.push(slotLabel);
  } else if (opt.item_type === "weapon") {
    parts.push(opt.weapon_range ?? "melee");
  } else if (opt.item_type === "consumable") {
    parts.push(`${opt.power} HP`);
  } else if (opt.item_type === "magic") {
    parts.push(`+${opt.power} max mana`);
  } else if (opt.item_type === "revive") {
    parts.push(`revive · ${opt.power}%`);
  } else {
    parts.push(opt.item_type);
  }
  if (opt.power > 0 && opt.item_type !== "consumable" && opt.item_type !== "magic" && opt.item_type !== "revive") {
    parts.push(`pwr ${opt.power}`);
  }
  if (opt.stat_bonus) {
    const bonuses = Object.entries(opt.stat_bonus)
      .filter(([, v]) => v !== 0)
      .map(([k, v]) => `+${v} ${k === "int_stat" ? "INT" : k.toUpperCase()}`)
      .join(", ");
    if (bonuses) parts.push(bonuses);
  }
  return parts.join(" · ");
}

// Display-friendly name: strip the boring "Weapon (power N)" / "Armor (power N)"
// / "Item (power N)" placeholders that grid dungeons use when AI-flavored
// names aren't generated. Falls back to a typed label.
function displayLootName(opt: LootOption): string {
  if (/^(Weapon|Armor|Item) \(power \d+\)$/.test(opt.name)) {
    if (opt.slot && opt.slot !== "main_hand") {
      const slot = opt.slot.replace("_", " ");
      return slot.charAt(0).toUpperCase() + slot.slice(1);
    }
    if (opt.item_type === "weapon") {
      const range = opt.weapon_range ?? "melee";
      return `${range.charAt(0).toUpperCase() + range.slice(1)} weapon`;
    }
    return opt.item_type.charAt(0).toUpperCase() + opt.item_type.slice(1);
  }
  return opt.name;
}

// Reusable visual tile for loot / lockbox / merchant choices. Rarity-tinted
// border, type icon, name, secondary line (slot/range/stats), optional
// flavor blurb, and an optional price (merchant only). The whole tile is a
// button so the existing onClick handlers continue to work unchanged.
function LootOptionTile({ opt, price, disabled, onClick }: {
  opt: LootOption;
  price?: number;
  disabled?: boolean;
  onClick: () => void;
}) {
  const tint = RARITY_TINT[opt.rarity] ?? "#2a2d33";
  const name = displayLootName(opt);
  const sub = lootSubLabel(opt);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={opt.flavor || undefined}
      style={{
        padding: "10px", background: "#131519",
        border: `1px solid ${tint}55`, borderLeft: `3px solid ${tint}`,
        borderRadius: 8, color: "#d1d5db", textAlign: "left", fontSize: 12,
        cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
        display: "flex", flexDirection: "column", gap: 4,
      }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Icon name={lootIcon(opt)} size={18} color={tint} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, color: tint, fontSize: 13, lineHeight: 1.2 }}>{name}</div>
          <div style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5 }}>
            {opt.rarity}{sub ? ` · ${sub}` : ""}
          </div>
        </div>
        {typeof price === "number" && (
          <div style={{ fontSize: 13, fontWeight: 700, color: "#fbbf24", whiteSpace: "nowrap" }}>{price}g</div>
        )}
      </div>
      {opt.flavor && (
        <div style={{ fontSize: 11, color: "#9aa0a6", fontStyle: "italic", lineHeight: 1.35 }}>{opt.flavor}</div>
      )}
    </button>
  );
}

// Convert an inventory item (combat-side UsableItem) into the LootOption
// shape that LootOptionTile understands. Lets the in-combat use-item /
// give-item pickers reuse the same rarity-tinted card visuals as the
// merchant / lockbox / loot tiles. `flavor`/`rarity` fall back to common
// when absent so legacy items still render.
function itemToLootOpt(it: UsableItem): LootOption {
  return {
    name: it.item_name,
    item_type: it.item_type,
    power: it.power,
    rarity: it.rarity ?? "common",
    flavor: it.flavor ?? "",
    slot: it.slot ?? null,
    stat_bonus: it.stat_bonus ?? null,
    weapon_range: it.weapon_range ?? null,
    item_subtype: it.item_subtype ?? null,
  };
}

// Centered modal used by in-combat pickers (Use Item, Give Item) so card
// grids have real estate. Click-outside or ✕ closes; Esc handled at the
// component level. Rendered via a portal to document.body so it escapes
// the CombatPanel's `backdrop-filter` containing block (which otherwise
// scopes `position: fixed` to the panel and clips the modal).
function PickerModal({ title, onClose, children }: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000, padding: 16, backdropFilter: "blur(4px)",
      }}>
      <div style={{
        background: "#12141a", border: "1px solid #2a2d33", borderRadius: 12,
        width: "min(700px, 100%)", maxHeight: "85vh", display: "flex",
        flexDirection: "column", boxShadow: "0 24px 64px rgba(0,0,0,0.8)",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #2a2d33", flexShrink: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#f5f5f5", fontFamily: DISPLAY_FONT }}>{title}</div>
          <button onClick={onClose} style={{ background: "none", border: "1px solid #3a3d44", borderRadius: 6, color: "#9ca3af", cursor: "pointer", padding: "3px 10px", fontSize: 13 }}>✕</button>
        </div>
        <div style={{ padding: 16, overflowY: "auto", flex: 1 }}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}

// Rarity-based fallback price for grid dungeons where we don't have a
// type-aware priceFor handy. Mirrors core's SHOP_PRICE for weapons/armor,
// scaled slightly for consumables/magic. Used only for display in the
// merchant card — server still computes authoritative price via priceFor.
function priceForDisplay(type: string, rarity: string): number {
  const base: Record<string, number> = { common: 25, uncommon: 60, rare: 140, epic: 320, legendary: 720 };
  const r = base[rarity] ?? 25;
  if (type === "consumable" || type === "tool") return Math.round(r * 0.4);
  if (type === "magic" || type === "revive")    return Math.round(r * 1.2);
  return r;
}

// Inventory modal lives in App.tsx (uses the dashboard's InventoryFullScreen
// with full drag-and-drop, paper-doll, give/use/equip). The party-bar click
// calls onOpenInventory which App.tsx routes to that modal.

// ─── Animated dice rolls (ported from CombatPage) ─────────────────────────────
// On every `roll` WS event we push an entry into diceRolls; DiceRollDisplay
// renders each one as a tumbling polygon that settles to the rolled value,
// then fades after ~10s. Self-cleans after 14s via setTimeout.

interface DiceRollEntry {
  id: number;
  die: string;
  value: number;
  actor: string;
  purpose: string;
}

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

const DIE_SHAPE: Record<string, { points: string; textY: number }> = {
  d4:  { points: "50,6 96,90 4,90",                                textY: 70 },
  d6:  { points: "8,8 92,8 92,92 8,92",                            textY: 56 },
  d8:  { points: "50,4 96,50 50,96 4,50",                          textY: 56 },
  d10: { points: "50,4 93,34 76,90 24,90 7,34",                    textY: 58 },
  d12: { points: "50,4 91,27 98,70 70,96 30,96 2,70 9,27",         textY: 58 },
  d20: { points: "50,4 91,28 91,72 50,96 9,72 9,28",               textY: 56 },
};
const DEFAULT_SHAPE = DIE_SHAPE.d20;

const D6_PIPS: Record<number, [number, number][]> = {
  1: [[1,1]],
  2: [[0,0],[2,2]],
  3: [[0,0],[1,1],[2,2]],
  4: [[0,0],[2,0],[0,2],[2,2]],
  5: [[0,0],[2,0],[1,1],[0,2],[2,2]],
  6: [[0,0],[2,0],[0,1],[2,1],[0,2],[2,2]],
};

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

function DiceRollDisplay({ rolls }: { rolls: DiceRollEntry[] }) {
  useEffect(() => { injectDiceStyles(); }, []);
  if (rolls.length === 0) return null;
  const enemyRolls = rolls.filter((r) => isMonsterActor(r.actor));
  const partyRolls = rolls.filter((r) => !isMonsterActor(r.actor));
  const rowStyle: React.CSSProperties = { display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "center", alignItems: "flex-start" };
  // Pill labels: solid dark bg + colored ring + drop-shadow. Readable on
  // any room background — the previous flat text vanished against busy
  // art (monster portraits especially).
  const pillStyle = (color: string, ring: string): React.CSSProperties => ({
    fontSize: 10, fontWeight: 800, color,
    textTransform: "uppercase", letterSpacing: 2,
    fontFamily: "ui-monospace, monospace",
    background: "rgba(10,11,14,0.92)",
    border: `1px solid ${ring}`,
    padding: "3px 12px",
    borderRadius: 999,
    marginBottom: 8,
    display: "inline-block",
    boxShadow: "0 2px 12px rgba(0,0,0,0.6)",
    textShadow: "0 0 6px rgba(0,0,0,0.8)",
  });
  return (
    <div style={{
      position: "fixed",
      bottom: 280,
      left: "50%",
      transform: "translateX(-50%)",
      display: "flex",
      flexDirection: "column",
      gap: 28,
      zIndex: 200,
      pointerEvents: "none",
    }}>
      {enemyRolls.length > 0 && (
        <div style={{ textAlign: "center" }}>
          <div style={pillStyle("#fca5a5", "#7f1d1d")}>Enemy</div>
          <div style={rowStyle}>
            {enemyRolls.map((r) => <DiceFace key={r.id} roll={r} />)}
          </div>
        </div>
      )}
      {partyRolls.length > 0 && (
        <div style={{ textAlign: "center" }}>
          <div style={pillStyle("#86efac", "#166534")}>Party</div>
          <div style={rowStyle}>
            {partyRolls.map((r) => <DiceFace key={r.id} roll={r} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function DiceFace({ roll }: { roll: DiceRollEntry }) {
  const maxFace = parseInt(roll.die.replace("d", ""), 10) || 20;
  const shape = DIE_SHAPE[roll.die] ?? DEFAULT_SHAPE;
  const isD6 = roll.die === "d6";

  const [display, setDisplay] = useState<number>(() => Math.ceil(Math.random() * maxFace));
  const [settled, setSettled] = useState(false);
  const [fading, setFading] = useState(false);

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
    const fadeTimer = setTimeout(() => setFading(true), 3500);
    return () => { clearInterval(iv); clearTimeout(fadeTimer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roll.id]);

  const isCrit = roll.die === "d20" && roll.value === maxFace;
  const isFumble = roll.die === "d20" && roll.value === 1;
  const strokeColor = settled ? (isCrit ? "#22c55e" : isFumble ? "#ef4444" : "#7dd3fc") : "#4a5568";
  const fillColor = settled ? (isCrit ? "#052e12" : isFumble ? "#2e0505" : "#0d1b2e") : "#111827";
  const numColor = settled ? (isCrit ? "#86efac" : isFumble ? "#fca5a5" : "#f5f5f5") : "#6b7280";
  const SIZE = 80;

  return (
    <div style={{
      width: SIZE, height: SIZE, position: "relative",
      filter: settled ? `drop-shadow(0 0 8px ${strokeColor}60)` : "none",
      animationName: fading ? "dice-fade-out" : "dice-roll-in",
      animationDuration: fading ? "350ms" : "700ms",
      animationTimingFunction: fading ? "ease-in" : "cubic-bezier(0.22,1,0.36,1)",
      animationFillMode: "forwards",
      transition: "filter 200ms",
    }}>
      <svg width={SIZE} height={SIZE} viewBox="0 0 100 100" style={{ position: "absolute", top: 0, left: 0 }}>
        <polygon points={shape.points} fill={fillColor} stroke={strokeColor} strokeWidth={settled ? 3.5 : 2.5} strokeLinejoin="round" style={{ transition: "fill 150ms, stroke 150ms" }} />
        <text x="50" y="16" textAnchor="middle" fontSize="9" fill="#6b7280" fontFamily="ui-monospace, monospace" letterSpacing="1" style={{ textTransform: "uppercase" }}>
          {roll.die.toUpperCase()}
        </text>
      </svg>
      <div style={{ position: "absolute", top: 0, left: 0, width: SIZE, height: SIZE, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {isD6 && settled ? (
          <D6Pips value={display} color={numColor} />
        ) : (
          <span style={{ fontSize: roll.die === "d4" ? 18 : 24, fontWeight: 900, color: numColor, fontVariantNumeric: "tabular-nums", lineHeight: 1, transition: "color 200ms", fontFamily: "ui-monospace, monospace" }}>
            {display}
          </span>
        )}
      </div>
      {settled && roll.purpose && (
        <div style={{ position: "absolute", bottom: -16, left: "50%", transform: "translateX(-50%)", fontSize: 9, color: "#9ca3af", whiteSpace: "nowrap", letterSpacing: 0.3, fontWeight: 500 }}>
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
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 10px)", gap: 4 }}>
      {cells.map(([c, r], i) => {
        const active = pips.some(([pc, pr]) => pc === c && pr === r);
        return <div key={i} style={{ width: 10, height: 10, borderRadius: "50%", background: active ? color : "transparent" }} />;
      })}
    </div>
  );
}
