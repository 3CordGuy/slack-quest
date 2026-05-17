// Grid-based dungeon view — first-person crawl through a 2D grid of rooms.
// Replaces the legacy linear expedition. Renders shape-aware room backgrounds,
// a true 2D minimap, compass navigation (N/E/S/W), door interactions with
// keys/pick/bash, and room content overlays.

import { useEffect, useReducer, useRef, useState } from "react";
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
/* Monster lunge — when the enemy attacks, the centred monster card pushes
   downward (toward the player) and snaps back. Communicates the swing. */
@keyframes gq-monster-lunge {
  0%   { transform: translate(-50%, -65%); }
  35%  { transform: translate(-50%, -45%) scale(1.04); }
  60%  { transform: translate(-50%, -55%) scale(1.02); }
  100% { transform: translate(-50%, -65%); }
}
.gq-monster-lunge {
  animation: gq-monster-lunge 520ms cubic-bezier(0.22, 1.4, 0.36, 1) both;
}
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
interface LootOption { name: string; item_type: string; power: number; rarity: string; flavor: string; slot?: string | null; stat_bonus?: Record<string, number> | null }
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
  | { kind: "outcome"; value: OutcomeSummary };

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
  }
}

function formatCombatEvent(e: { type: string; [k: string]: unknown }, nameOf: (id: string) => string): LogEntry | null {
  const row = (text: string, tone: LogEntry["tone"], detail?: string): LogEntry => ({ id: nextLogId++, text, tone, detail });
  const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
  switch (e.type) {
    case "begin": return row("Combat begins — rolling initiative…", "info");
    case "turn_start": return row(`— ${nameOf(e.actor as string)}'s turn (round ${e.round})`, "muted");
    case "hit_check": return row(
      e.hit ? "Hit lands" : "Attack misses",
      e.hit ? "good" : "bad",
      `d20 ${e.roll}${sign(e.modifier as number)} = ${e.total} vs AC ${e.ac}`,
    );
    case "player_hit": return row(
      `${nameOf(e.actor as string)} hits for ${e.damage} dmg${e.crit ? " (CRIT!)" : ""}`,
      "good",
      typeof e.formula === "string" ? String(e.formula) : undefined,
    );
    case "monster_attack": return row(
      `Monster strikes — ${e.hp_damage} HP damage`,
      "bad",
      `raw ${e.raw_damage} · armor ${(e.raw_damage as number) - (e.damage_after_armor as number)} · shield ${e.shield_absorbed} → ${e.hp_damage} HP`,
    );
    case "fighter_down": return row(`${nameOf(e.target as string)} is down!`, "bad");
    case "monster_down": return row(`${nameOf(e.killed_by as string)} lands the killing blow!`, "good");
    case "heal_applied": return row(
      `${nameOf(e.actor as string)}: +${e.amount} HP healed`,
      "good",
      (e.rolled as number) > (e.amount as number) ? `rolled ${e.rolled}, clamped to ${e.amount}` : undefined,
    );
    case "shield_applied": return row(
      `${nameOf(e.actor as string)}: +${e.amount} shield`,
      "good",
      (e.rolled as number) > (e.amount as number) ? `rolled ${e.rolled}, clamped to ${e.amount}` : undefined,
    );
    case "signature_used": return row(
      `${nameOf(e.actor as string)} signature: ${e.damage} dmg`,
      "good",
      `${e.formula ?? ""} · −${e.mana_spent ?? 0} mana`,
    );
    case "flee_check": return row(
      e.success ? `${nameOf(e.actor as string)} escapes!` : `${nameOf(e.actor as string)} fails to escape`,
      e.success ? "good" : "bad",
      `d20 ${e.roll}${sign(e.modifier as number)} = ${e.total} vs DC ${e.dc}`,
    );
    case "victory": return row("Victory!", "good");
    case "defeat": return row("The party falls…", "bad");
    case "fled": return row("The party escapes!", "muted");
    case "ability_used": return row(`${nameOf(e.actor as string)} uses ${e.name}`, "good", `−${e.mana_spent ?? 0} mana`);
    case "wave_transition": return row(`Wave ${e.new_wave}/${e.total_waves}: ${e.to_monster} arrives`, "info");
    case "mark_applied": return row(`${nameOf(e.actor as string)} marks the target`, "info", `+${e.bonus} dmg through round ${e.expires_after_round}`);
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

function MonsterOverlay({ monster, isBoss, flashIds, lungeTick }: { monster: Monster | null; isBoss: boolean; flashIds?: Set<string>; lungeTick?: number }) {
  if (!monster || monster.hp <= 0) return null;
  const isHit = !!(monster.id && flashIds?.has(monster.id));
  // Combine hit-flash + monster-lunge classes. The lunge is animation-based
  // and only fires when the element re-mounts on each lungeTick bump, so we
  // include it in the key.
  const classes = [isHit ? "gq-hit-flash" : null, "gq-monster-lunge"].filter(Boolean).join(" ");
  return (
    <div
      key={`monster-overlay-${lungeTick ?? 0}`}
      className={classes}
      style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -65%)", background: "rgba(10,11,14,0.88)", border: `1px solid ${isBoss ? "#fca5a5" : "#2a2d33"}`, borderRadius: 12, padding: "10px 14px", minWidth: 220, maxWidth: 300, backdropFilter: "blur(8px)", boxShadow: isBoss ? "0 0 32px rgba(239,68,68,0.3)" : "0 4px 24px rgba(0,0,0,0.6)" }}>
      {monster.art_url && (
        <img src={monster.art_url} alt={monster.name} style={{ width: "100%", height: 140, objectFit: "cover", borderRadius: 8, marginBottom: 8, display: "block" }} />
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div style={{ fontFamily: DISPLAY_FONT, fontSize: 15, fontWeight: 700, color: isBoss ? "#fca5a5" : "#f5f5f5" }}>{monster.name}</div>
        <div style={{ fontSize: 12, color: "#9aa0a6", fontVariantNumeric: "tabular-nums" }}>{monster.hp} / {monster.max_hp}</div>
      </div>
      <HpBar current={monster.hp} max={monster.max_hp} color={isBoss ? "#ef4444" : undefined} height={6} />
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

function ShapeIcon({ shape, size }: { shape: RoomShape | undefined; size: number }) {
  // Draw the shape as small SVG line art. Each shape has its corridor "openings"
  // matching the exit directions.
  const s = size;
  const c = s / 2;
  const stroke = "#9aa0a6";
  const sw = 1.5;
  const exits = exitsForShape(shape ?? "chamber");
  // The room body is a centered square; corridors extend from the body to the
  // edge in each exit direction.
  const bodyR = s * 0.18;
  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} style={{ display: "block" }}>
      {/* Corridor stubs */}
      {exits.has("n") && <line x1={c} y1={0} x2={c} y2={c} stroke={stroke} strokeWidth={sw} />}
      {exits.has("e") && <line x1={c} y1={c} x2={s} y2={c} stroke={stroke} strokeWidth={sw} />}
      {exits.has("s") && <line x1={c} y1={c} x2={c} y2={s} stroke={stroke} strokeWidth={sw} />}
      {exits.has("w") && <line x1={0} y1={c} x2={c} y2={c} stroke={stroke} strokeWidth={sw} />}
      {/* Room body */}
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

function GridMinimap({ graph }: { graph: GridGraph }) {
  const w = graph.grid_width ?? 4;
  const h = graph.grid_height ?? 4;
  const current = graph.nodes[graph.current];
  const visited = new Set(graph.visited);
  return (
    <div style={{ userSelect: "none" }}>
      <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Map</div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${w}, ${CELL}px)`, gridTemplateRows: `repeat(${h}, ${CELL}px)`, gap: 1, background: "#1a1c21" }}>
        {Array.from({ length: w * h }, (_, idx) => {
          const x = idx % w;
          const y = Math.floor(idx / w);
          const node = Object.values(graph.nodes).find((n) => n.x === x && n.y === y);
          if (!node) {
            return <div key={idx} style={{ width: CELL, height: CELL, background: "#0a0b0e" }} />;
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
          return (
            <div key={idx} style={{ position: "relative", width: CELL, height: CELL, background: bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <ShapeIcon shape={node.shape} size={CELL - 2} />
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
  const [doorPrompt, setDoorPrompt] = useState<{ dir: DungeonDirection; door: GridDoor } | null>(null);
  const [moving, setMoving] = useState(false);
  const [contentBusy, setContentBusy] = useState(false);
  const [items, setItems] = useState<UsableItem[]>([]);
  // IDs (fighter id OR monster id) currently being flashed-red after a hit.
  // Cleared 600ms after the event lands.
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  // Monster lunge counter — bumped on every monster_attack that lands. The
  // MonsterOverlay re-keys when this changes, re-running the lunge animation.
  const [monsterLungeTick, setMonsterLungeTick] = useState(0);
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

  // Combat WS
  useEffect(() => {
    if (!combatActive) {
      wsRef.current?.close();
      wsRef.current = null;
      return;
    }
    dispatch({ kind: "connection", value: "connecting" });
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/ws/quest/${questId}`;
    const sock = new WebSocket(url);
    wsRef.current = sock;
    const heartbeat = setInterval(() => { if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "ping" })); }, 45_000);
    sock.onopen = () => dispatch({ kind: "connection", value: "open" });
    sock.onclose = () => dispatch({ kind: "connection", value: "closed" });
    sock.onerror = () => toast.error("Combat connection lost");
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
            // player_hit: actor (player) hits target (monster). Flash the monster.
            if (evt.type === "player_hit" && typeof evt.target === "string") {
              flashHit(evt.target);
            }
            // monster_attack: monster hits target (fighter), only flash if damage landed.
            if (evt.type === "monster_attack" && typeof evt.target === "string" && (evt.hp_damage as number) > 0) {
              flashHit(evt.target as string);
              // Bump the lunge counter so the monster card jabs downward toward
              // the party. Visualises the swing even when auto-resolve is on.
              setMonsterLungeTick((t) => t + 1);
            }
            // roll: dice events become floating animated polygons.
            if (evt.type === "roll") {
              const id = ++diceRollCounterRef.current;
              const entry: DiceRollEntry = {
                id,
                die: String(evt.die),
                value: Number(evt.value),
                actor: String(evt.actor),
                purpose: String(evt.purpose ?? ""),
              };
              setDiceRolls((prev) => [...prev.slice(-7), entry]);
              setTimeout(() => setDiceRolls((prev) => prev.filter((r) => r.id !== id)), 14000);
            }
          }
        } else if (msg.type === "outcome" && msg.outcome) {
          dispatch({ kind: "outcome", value: msg.outcome });
        }
      } catch { /* ignore bad frames */ }
    };
    return () => { clearInterval(heartbeat); sock.close(); wsRef.current = null; };
  }, [questId, combatActive]);

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

  // On combat victory, refresh quest state
  useEffect(() => {
    if (ws.outcome?.status === "victory") {
      const t = setTimeout(() => { onRefresh(); setCombatActive(false); }, 2500);
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
  const liveMonsters = combatState?.monsters.filter((m) => m.hp > 0) ?? [];
  const isMonsterTurn = currentActorId ? isMonsterActor(currentActorId) : false;
  const combatEnded = combatState?.status === "victory" || combatState?.status === "defeat" || combatState?.status === "fled";

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
    : { position: "absolute", top: 12, right: 12, width: "min(300px, 22vw)", display: "flex", flexDirection: "column", gap: 8, zIndex: 6 };
  const railItemStyle: React.CSSProperties = isMobile && showLog ? { flex: 1, minWidth: 0 } : { width: "100%" };

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

        {/* Monster overlay during combat */}
        {combatActive && liveMonsters.length > 0 && <MonsterOverlay monster={liveMonsters[0]} isBoss={isBoss} flashIds={flashIds} lungeTick={monsterLungeTick} />}

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
            background: "rgba(0,0,0,0.6)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 8,
            backdropFilter: "blur(6px)",
            display: "flex",
            flexDirection: isMobile ? "row" : "column",
          }}>
            <div style={{ padding: "8px 10px 6px", borderRight: isMobile ? "1px solid rgba(255,255,255,0.08)" : "none", borderBottom: !isMobile ? "1px solid rgba(255,255,255,0.08)" : "none", flex: isMobile ? 1 : "0 0 auto" }}>
              <GridMinimap graph={graph} />
            </div>
            {combatActive && ws.log.length > 0 && (
              <div style={{ padding: "6px 10px 8px", flex: isMobile ? 1 : "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
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
                <div style={{
                  maxHeight: isMobile ? 100 : 240,
                  overflowY: "auto",
                  background: "#0e0f12",
                  borderRadius: 6,
                  padding: "8px 10px",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 12,
                  lineHeight: 1.45,
                  display: "flex", flexDirection: "column", gap: 3,
                }}>
                  {ws.log.slice(-20).map((e) => (
                    <div key={e.id} style={{
                      color: e.tone === "good" ? "#86efac" : e.tone === "bad" ? "#fca5a5" : e.tone === "info" ? "#93c5fd" : "#9aa0a6",
                      wordBreak: "break-word",
                    }}>
                      <div>{e.text}</div>
                      {logDetails && e.detail && (
                        <div style={{ fontSize: 11, color: "#6b7280", paddingLeft: 10 }}>
                          ↳ {e.detail}
                        </div>
                      )}
                    </div>
                  ))}
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

        {/* Combat victory/defeat overlay */}
        {combatActive && combatEnded && ws.outcome && (
          <div style={{ position: "absolute", inset: 0, background: ws.outcome.status === "victory" ? "rgba(0,80,20,0.6)" : "rgba(80,0,0,0.6)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, backdropFilter: "blur(4px)", zIndex: 20 }}>
            <div style={{ fontFamily: DISPLAY_FONT, fontSize: 32, color: ws.outcome.status === "victory" ? "#86efac" : "#fca5a5" }}>
              {ws.outcome.status === "victory" ? "Victory!" : "Defeated…"}
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
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
          {c.items.map((opt, i) => (
            <button key={i} onClick={() => onTakeLoot(i)} style={lootBtn}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>{opt.name}</div>
              <div style={{ fontSize: 11, color: "#9aa0a6" }}>power {opt.power} · {opt.rarity}</div>
            </button>
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
      <OverlayPanel title={`Locked chest — needs ${tier} key`}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
          {c.options.map((opt, i) => (
            <button key={i}
              onClick={async () => {
                const res = await fetch(`/api/quest/${questId}/dungeon/grid/lockbox`, {
                  method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ pick: i + 1 }),
                });
                if (res.ok) { toast.success("Chest opened"); onRefresh(); }
                else { const b = await res.json().catch(() => ({})) as { error?: string }; toast.error(b.error === "no_key" ? `No ${tier} key` : "Could not open"); }
              }}
              style={{ padding: "10px", background: "#131519", border: `1px solid ${tierColor}`, borderRadius: 8, color: "#d1d5db", cursor: "pointer", textAlign: "left", fontSize: 12 }}>
              <div style={{ fontWeight: 600 }}>{opt.name}</div>
              <div style={{ fontSize: 11, color: "#9aa0a6" }}>power {opt.power} · {opt.rarity}</div>
            </button>
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
      <OverlayPanel title="Merchant">
        <p style={{ fontSize: 13, color: "#d1d5db", fontStyle: "italic", margin: "0 0 10px" }}>{c.greeting}</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
          {c.stock.map((opt, i) => (
            <button key={i}
              onClick={async () => {
                const res = await fetch(`/api/quest/${questId}/dungeon/grid/merchant`, {
                  method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ pick: i + 1 }),
                });
                if (res.ok) { toast.success("Purchased"); onRefresh(); }
                else { const b = await res.json().catch(() => ({})) as { error?: string }; toast.error(b.error === "insufficient_gold" ? "Not enough gold" : "Could not buy"); }
              }}
              style={lootBtn}>
              <div style={{ fontWeight: 600 }}>{opt.name}</div>
              <div style={{ fontSize: 11, color: "#9aa0a6" }}>power {opt.power} · {opt.rarity}</div>
            </button>
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
}

function CombatPanel({ state, selfId, onSend, autoResolve, setAutoResolve, myTurn, isMonsterTurn, items, characterClass }: {
  state: CombatState; selfId: string;
  onSend: (a: TurnAction) => boolean;
  autoResolve: boolean; setAutoResolve: (b: boolean) => void;
  myTurn: boolean; isMonsterTurn: boolean;
  items: UsableItem[];
  characterClass: string;
}) {
  const me = state.fighters.find((f) => f.id === selfId);
  const mana = me?.mana ?? 0;
  const myPos = me?.position ?? "front";
  const liveMonsters = state.monsters.filter((m) => m.hp > 0);
  const target = liveMonsters[0]?.id ?? null;
  const [picking, setPicking] = useState<"heal" | "shield" | null>(null);
  const [itemOpen, setItemOpen] = useState(false);
  // Give flow: select item → select ally. itemId stays set across the two-step picker.
  const [givePicker, setGivePicker] = useState<"closed" | "selectItem" | { itemId: number }>("closed");
  const usable = items.filter((it) => !it.equipped && ["consumable", "magic", "revive"].includes(it.item_type));
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

      {/* Inline give pickers — step 1 (item) then step 2 (ally) */}
      {givePicker === "selectItem" && myTurn && (
        <div style={{ padding: "6px 12px 4px", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", borderBottom: "1px solid #1a1c21" }}>
          <span style={{ fontSize: 11, color: "#9aa0a6" }}>Give which item?</span>
          {giveable.length === 0 && <span style={{ fontSize: 11, color: "#4a5568" }}>No items to give</span>}
          {giveable.map((it) => (
            <button key={it.id}
              onClick={() => setGivePicker({ itemId: it.id })}
              style={{ padding: "3px 10px", background: "#291515", border: "1px solid #663a3a", borderRadius: 5, color: "#fcd34d", fontSize: 11, cursor: "pointer" }}>
              {it.item_name}
            </button>
          ))}
          <button onClick={() => setGivePicker("closed")} style={{ padding: "3px 8px", background: "none", border: "1px solid #2a2d33", borderRadius: 5, color: "#9aa0a6", fontSize: 11, cursor: "pointer" }}>✕</button>
        </div>
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

      {/* Inline item picker */}
      {itemOpen && myTurn && (
        <div style={{ padding: "6px 12px 4px", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", borderBottom: "1px solid #1a1c21" }}>
          <span style={{ fontSize: 11, color: "#9aa0a6" }}>Use item:</span>
          {usable.length === 0 && <span style={{ fontSize: 11, color: "#4a5568" }}>No usable items</span>}
          {usable.map((it) => (
            <button key={it.id}
              onClick={() => { onSend({ kind: "use_item", actor: selfId, item_id: it.id }); setItemOpen(false); }}
              style={{ padding: "3px 10px", background: "#1a1529", border: "1px solid #4c1d95", borderRadius: 5, color: "#c4b5fd", fontSize: 11, cursor: "pointer" }}>
              {it.item_name}
            </button>
          ))}
          <button onClick={() => setItemOpen(false)} style={{ padding: "3px 8px", background: "none", border: "1px solid #2a2d33", borderRadius: 5, color: "#9aa0a6", fontSize: 11, cursor: "pointer" }}>✕</button>
        </div>
      )}

      {/* Turn status hint (when not the player's turn) */}
      {turnStatus && (
        <div style={{ padding: "2px 12px 0", fontSize: 11, color: "#9aa0a6", fontStyle: "italic" }}>{turnStatus}</div>
      )}

      {/* Action buttons — vertical-style (icon top, label, mana below) */}
      <div style={{ padding: "8px 10px 10px", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
        <CBtn label="Attack" icon="sword" color="#b89b3a" disabled={!myTurn || !target} onClick={() => onSend({ kind: "attack", actor: selfId, target_id: target })} />
        <CBtn label="Cast" icon="crystal-wand" color="#818cf8" manaCost={1} disabled={!myTurn || mana < 1 || !target} onClick={() => onSend({ kind: "cast", actor: selfId, target_id: target })} />
        <CBtn label="Signature" icon="wax-seal" color="#a78bfa" manaCost={2} disabled={!myTurn || mana < 2 || !target} onClick={() => onSend({ kind: "signature", actor: selfId, target_id: target })} />
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

function OverlayPanel({ title, children }: { title: string; children: React.ReactNode }) {
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
  const labelStyle: React.CSSProperties = { fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1.5, fontFamily: "ui-monospace, monospace", textAlign: "center", marginBottom: 6 };
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
    const fadeTimer = setTimeout(() => setFading(true), 10000);
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
