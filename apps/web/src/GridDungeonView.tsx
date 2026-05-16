// Grid-based dungeon view — first-person crawl through a 2D grid of rooms.
// Replaces the legacy linear expedition. Renders shape-aware room backgrounds,
// a true 2D minimap, compass navigation (N/E/S/W), door interactions with
// keys/pick/bash, and room content overlays.

import { useEffect, useReducer, useRef, useState } from "react";
import toast from "react-hot-toast";
import { isMonsterActor } from "@gantt-quest/core";
import { Avatar, Icon } from "./icons";

const DISPLAY_FONT = "'Uncial Antiqua', serif";

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

interface MonsterSpec { name: string; hp: number; max_hp: number; tier: number; is_boss?: boolean; art_url?: string | null }
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
  | { kind: "npc"; greeting: string; offer: LootOption; resolved: boolean }
  | { kind: "merchant"; greeting: string; stock: LootOption[]; resolved: boolean };

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
  | { kind: "monster_act" }
  | { kind: "use_item"; actor: string; item_id: number; target_id?: string };

interface OutcomeSummary {
  status: "victory" | "defeat";
  rewards: Array<{ user_id: string; xp_awarded: number; gold_awarded: number; level_up: boolean; new_level: number; loot: Array<{ item_name: string; rarity: string }>; soft_death: { gold_lost: number } | null }>;
  monster_name: string;
}

interface LogEntry { id: number; text: string; tone: "info" | "good" | "bad" | "muted" }

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
  const row = (text: string, tone: LogEntry["tone"]): LogEntry => ({ id: nextLogId++, text, tone });
  switch (e.type) {
    case "begin": return row("Combat begins — rolling initiative…", "info");
    case "player_hit": return row(`${nameOf(e.actor as string)} hits for ${e.damage} dmg${e.crit ? " (CRIT!)" : ""}`, "good");
    case "monster_attack": return row(`Monster strikes — ${e.hp_damage} HP damage`, "bad");
    case "fighter_down": return row(`${nameOf(e.target as string)} is down!`, "bad");
    case "monster_down": return row(`${nameOf(e.killed_by as string)} lands the killing blow!`, "good");
    case "heal_applied": return row(`${nameOf(e.actor as string)}: +${e.amount} HP healed`, "good");
    case "shield_applied": return row(`${nameOf(e.actor as string)}: +${e.amount} shield`, "good");
    case "signature_used": return row(`${nameOf(e.actor as string)} signature: ${e.damage} dmg`, "good");
    case "victory": return row("Victory!", "good");
    case "defeat": return row("The party falls…", "bad");
    case "fled": return row("The party escapes!", "muted");
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

function PartyBar({ fighters, selfId, party }: {
  fighters: Fighter[] | null; selfId: string; party: Character[];
}) {
  const seen = new Set<string>();
  type Member = { key: string; name: string; cls: string; hp: number; max_hp: number; mana: number; max_mana: number; shield: number; isSelf: boolean; isDead: boolean };
  const members: Member[] = fighters
    ? fighters.map((f) => ({ key: f.id, name: f.name, cls: f.class, hp: f.hp, max_hp: f.max_hp, mana: f.mana, max_mana: f.max_mana, shield: f.shield, isSelf: f.id === selfId, isDead: f.hp <= 0 }))
    : party.flatMap((c) => {
        if (seen.has(c.slack_user_id)) return [];
        seen.add(c.slack_user_id);
        return [{ key: c.slack_user_id, name: c.name, cls: c.class, hp: c.hp, max_hp: c.max_hp, mana: c.mana, max_mana: c.max_mana, shield: c.shield, isSelf: c.slack_user_id === selfId, isDead: c.hp <= 0 }];
      });
  return (
    <div style={{ background: "rgba(10,11,14,0.96)", borderTop: "1px solid #1e2028", padding: "8px 12px", display: "flex", gap: 10, alignItems: "center", overflowX: "auto", flexShrink: 0 }}>
      {members.map((f) => (
        <div key={f.key} style={{ display: "flex", alignItems: "center", gap: 8, background: f.isSelf ? "rgba(245,245,220,0.06)" : "transparent", border: f.isSelf ? "1px solid rgba(245,245,220,0.15)" : "1px solid transparent", borderRadius: 8, padding: "4px 8px", opacity: f.isDead ? 0.45 : 1, flexShrink: 0, minWidth: 140 }}>
          <Avatar src={charPortraitUrl(f.name)} fallbackSrc={classPortraitUrl(f.cls)} alt={f.name} size={36} radius={5} fallbackIcon="player" fallbackColor="#4a5568" border="1px solid #2a2d33" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#e2e8f0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</div>
            <HpBar current={f.hp} max={f.max_hp} height={5} />
            <div style={{ fontSize: 10, color: "#9aa0a6", marginTop: 1 }}>
              {f.hp}/{f.max_hp} HP{f.shield > 0 && <span style={{ color: "#60a5fa", marginLeft: 4 }}>+{f.shield}<Icon name="shield" size={9} /></span>}
            </div>
            <div style={{ display: "flex", gap: 3, marginTop: 2 }}>
              {Array.from({ length: f.max_mana }, (_, mi) => (
                <div key={mi} style={{ width: 7, height: 7, borderRadius: "50%", background: mi < f.mana ? "#818cf8" : "#1e2028", border: "1px solid #3a3d43" }} />
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function MonsterOverlay({ monster, isBoss }: { monster: Monster | null; isBoss: boolean }) {
  if (!monster || monster.hp <= 0) return null;
  return (
    <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -65%)", background: "rgba(10,11,14,0.88)", border: `1px solid ${isBoss ? "#fca5a5" : "#2a2d33"}`, borderRadius: 12, padding: "10px 14px", minWidth: 220, maxWidth: 300, backdropFilter: "blur(8px)", boxShadow: isBoss ? "0 0 32px rgba(239,68,68,0.3)" : "0 4px 24px rgba(0,0,0,0.6)" }}>
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
    <div style={{ background: "rgba(10,11,14,0.92)", borderBottom: "1px solid #1e2028", padding: "5px 12px", display: "flex", gap: 6, alignItems: "center", overflowX: "auto", flexShrink: 0 }}>
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
    case "t_n": e.add("e"); e.add("s"); e.add("w"); break;
    case "t_e": e.add("n"); e.add("s"); e.add("w"); break;
    case "t_s": e.add("n"); e.add("e"); e.add("w"); break;
    case "t_w": e.add("n"); e.add("e"); e.add("s"); break;
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
    <div style={{ position: "absolute", top: 12, right: 12, background: "rgba(0,0,0,0.78)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 8, padding: "8px 10px 6px", backdropFilter: "blur(6px)", userSelect: "none" }}>
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
          if (isBoss && !isCurrent) bg = isVisited ? "#7f1d1d" : "#5c1f1f";
          return (
            <div key={idx} style={{ position: "relative", width: CELL, height: CELL, background: bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <ShapeIcon shape={node.shape} size={CELL - 2} />
              {isCurrent && <div style={{ position: "absolute", top: 1, right: 1, width: 4, height: 4, background: "#ef4444", borderRadius: "50%" }} />}
              {isBoss && !isCurrent && <div style={{ position: "absolute", top: 1, right: 1, width: 4, height: 4, background: "#fca5a5", borderRadius: "50%" }} />}
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
    <div style={{ position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)", display: "grid", gridTemplateColumns: "60px 60px 60px", gridTemplateRows: "32px 32px 32px", gap: 4, alignItems: "center", justifyItems: "center", padding: 6, background: "rgba(0,0,0,0.5)", borderRadius: 10, backdropFilter: "blur(4px)" }}>
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
  onExit: () => void;
  onRefresh: () => void;
}

export function GridDungeonView({
  questId, selfId, scene, party, character, hasWebCombat, onExit, onRefresh,
}: GridDungeonViewProps) {
  const graph = scene.graph!;
  const currentNode = graph.nodes[graph.current];
  const content = currentNode.content;
  const isBoss = content?.kind === "boss";
  const isCombatRoom = content?.kind === "encounter" || content?.kind === "boss";
  const monsterAlive = isCombatRoom && !(content as { cleared: boolean }).cleared;

  const [combatActive, setCombatActive] = useState(hasWebCombat && monsterAlive);
  const [ws, dispatch] = useReducer(wsReducer, { connection: "connecting" as const, state: null, log: [], outcome: null });
  const wsRef = useRef<WebSocket | null>(null);
  const [autoResolve, setAutoResolve] = useState(true);
  const autoResolveRef = useRef(true);
  const autoResolvedTurnRef = useRef(-1);
  const [doorPrompt, setDoorPrompt] = useState<{ dir: DungeonDirection; door: GridDoor } | null>(null);
  const [moving, setMoving] = useState(false);
  const [contentBusy, setContentBusy] = useState(false);

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

  return (
    <div style={{ position: "fixed", inset: 0, background: "#0a0b0e", display: "flex", flexDirection: "column", overflow: "hidden", fontFamily: "Inter, system-ui, sans-serif" }}>
      {/* Top bar */}
      <div style={{ background: "rgba(10,11,14,0.95)", borderBottom: "1px solid #1e2028", padding: "0 12px", height: 44, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, zIndex: 10 }}>
        <button onClick={onExit} style={{ background: "none", border: "none", color: "#9aa0a6", cursor: "pointer", fontSize: 13, padding: "4px 8px", borderRadius: 6, display: "flex", alignItems: "center", gap: 6 }}>
          <Icon name="footprint" size={13} /> Exit
        </button>
        <div style={{ fontSize: 12, fontFamily: DISPLAY_FONT, color: "#c4a35a" }}>
          {currentNode.shape?.replace(/_/g, " ") ?? "room"} · {content?.kind ?? "—"}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {combatActive && <span style={{ fontSize: 11, color: ws.connection === "open" ? "#39ff14" : "#9aa0a6" }}>{ws.connection === "open" ? "● live" : "○ …"}</span>}
          <span style={{ fontSize: 11, color: "#9aa0a6" }}>
            <Icon name="key" size={10} color="#b45309" /> {character.keys_bronze}
            <Icon name="key" size={10} color="#d1d5db" style={{ marginLeft: 4 }} /> {character.keys_silver}
            <Icon name="key" size={10} color="#fbbf24" style={{ marginLeft: 4 }} /> {character.keys_gold}
          </span>
        </div>
      </div>

      {/* Initiative strip (combat only) */}
      {combatActive && combatState && <InitStrip state={combatState} selfId={selfId} />}

      {/* Room view */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden", minHeight: 0 }}>
        <img src={bgUrl} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to bottom, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.05) 40%, rgba(0,0,0,0.55) 100%)", pointerEvents: "none" }} />

        {/* Monster overlay during combat */}
        {combatActive && liveMonsters.length > 0 && <MonsterOverlay monster={liveMonsters[0]} isBoss={isBoss} />}

        {/* Content figure overlay — when the room contains a person or
            object, paint a visible indicator on the scene so the room
            doesn't look empty. Only shows for non-chamber, non-dead-end
            shapes where the bg art is just an empty corridor. */}
        {!combatActive && content && currentNode.shape && needsFigureOverlay(currentNode.shape, content) && (
          <ContentFigureOverlay content={content} />
        )}

        {/* Minimap */}
        <GridMinimap graph={graph} />

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

      {/* Content interaction overlay (non-combat rooms with stuff to do) */}
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

      {/* Combat panel (in-room) */}
      {combatActive && !combatEnded && combatState && (
        <CombatPanel
          state={combatState}
          selfId={selfId}
          onSend={send}
          autoResolve={autoResolve}
          setAutoResolve={setAutoResolve}
          log={ws.log}
          myTurn={myTurn}
          isMonsterTurn={isMonsterTurn}
        />
      )}

      {/* Party bar */}
      <PartyBar fighters={combatActive ? (combatState?.fighters ?? null) : null} selfId={selfId} party={party.length > 0 ? party : [character]} />
    </div>
  );
}

// True when the room's bg is a generic corridor (no content baked into the
// art) AND the content kind is a "visible thing in the room". In those cases
// we overlay a figure/object indicator so the scene isn't empty-looking.
function needsFigureOverlay(shape: RoomShape, content: GridRoomContent): boolean {
  // Dead-ends and chambers already get content-baked art.
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
  // Icon + label centered on the scene. Big enough to read at a glance,
  // not so big it hides the corridor art.
  let icon = "player";
  let color = "#d1d5db";
  let label = "";
  switch (content.kind) {
    case "npc": icon = "hood"; color = "#fef3c7"; label = "A traveler"; break;
    case "merchant": icon = "shop"; color = "#fcd34d"; label = "Merchant"; break;
    case "loot": icon = "ammo-bag"; color = "#a7f3d0"; label = "Loot"; break;
    case "key_pickup": {
      const tier = content.tier;
      color = tier === "gold" ? "#fbbf24" : tier === "silver" ? "#d1d5db" : "#b45309";
      icon = "key"; label = `${tier[0].toUpperCase()}${tier.slice(1)} key`;
      break;
    }
    case "lockbox": icon = "chest-armor"; color = "#60a5fa"; label = "Locked chest"; break;
    case "trap": icon = "bear-trap"; color = "#fca5a5"; label = "Trap"; break;
  }
  return (
    <div style={{
      position: "absolute",
      top: "42%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 8,
      padding: "12px 20px",
      background: "rgba(0,0,0,0.45)",
      border: `1px solid ${color}`,
      borderRadius: 12,
      backdropFilter: "blur(4px)",
      boxShadow: `0 0 24px ${color}40`,
      pointerEvents: "none",
    }}>
      <Icon name={icon} size={48} color={color} />
      <div style={{ fontFamily: DISPLAY_FONT, fontSize: 14, color, letterSpacing: 1 }}>{label}</div>
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
  if (!content) return null;
  if (content.kind === "empty" || content.kind === "entry") return null;

  if ((content.kind === "encounter" || content.kind === "boss") && !content.cleared) {
    const m = content.monsters[0];
    if (!m) return null;
    return (
      <div style={{ background: content.kind === "boss" ? "rgba(80,10,10,0.95)" : "rgba(10,11,14,0.95)", borderTop: `1px solid ${content.kind === "boss" ? "#7f1d1d" : "#1e2028"}`, padding: "12px 16px", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: content.kind === "boss" ? "#fca5a5" : "#f5f5f5", fontFamily: DISPLAY_FONT }}>
            {content.kind === "boss" && <Icon name="dragon-head" size={14} color="#fca5a5" />} {m.name}
          </div>
          <HpBar current={m.hp} max={m.max_hp} color={content.kind === "boss" ? "#ef4444" : undefined} height={5} />
          <div style={{ fontSize: 11, color: "#9aa0a6", marginTop: 2 }}>{m.hp}/{m.max_hp} HP{content.kind === "boss" ? " · BOSS" : ""}</div>
        </div>
        <button onClick={onEnterCombat} style={{ padding: "8px 20px", background: content.kind === "boss" ? "#7f1d1d" : "#b89b3a", border: `1px solid ${content.kind === "boss" ? "#991b1b" : "#c4a35a"}`, borderRadius: 8, color: content.kind === "boss" ? "#fca5a5" : "#0e0f12", fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 6 }}>
          <Icon name="sword" size={14} /> Engage
        </button>
      </div>
    );
  }

  if (content.kind === "loot" && !content.taken) {
    return (
      <OverlayPanel title="Found items">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
          {content.items.map((opt, i) => (
            <button key={i} onClick={() => onTakeLoot(i)} style={lootBtn}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>{opt.name}</div>
              <div style={{ fontSize: 11, color: "#9aa0a6" }}>power {opt.power} · {opt.rarity}</div>
            </button>
          ))}
        </div>
      </OverlayPanel>
    );
  }

  if (content.kind === "key_pickup" && !content.taken) {
    const tierColor = content.tier === "gold" ? "#fbbf24" : content.tier === "silver" ? "#d1d5db" : "#b45309";
    return (
      <OverlayPanel title={`A ${content.tier} key`}>
        <button
          onClick={onTakeKey}
          style={{ padding: "10px 14px", background: "#131519", border: `1px solid ${tierColor}`, borderRadius: 8, color: tierColor, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <Icon name="key" color={tierColor} /> Take the {content.tier} key
        </button>
      </OverlayPanel>
    );
  }

  if (content.kind === "trap" && !content.resolved) {
    return (
      <OverlayPanel title="A trap is set">
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {content.choices.map((c, i) => (
            <button key={i}
              onClick={async () => {
                const res = await fetch(`/api/quest/${questId}/dungeon/grid/trap`, {
                  method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ pick: i + 1 }),
                });
                if (res.ok) {
                  const b = await res.json() as { success: boolean; roll: number; total: number; dc: number; damage: number };
                  toast(`${c.skill.toUpperCase()}: ${b.roll} → ${b.total} vs DC ${b.dc} — ${b.success ? "passed" : `failed (-${b.damage} HP)`}`);
                  onRefresh();
                } else toast.error("Trap choice failed");
              }}
              style={{ padding: "10px 14px", background: "#131519", border: "1px solid #2a2d33", borderRadius: 8, color: "#d1d5db", cursor: "pointer", textAlign: "left", fontSize: 12, display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 18 }}>{c.emoji}</span>
              <div>
                <div style={{ fontWeight: 600 }}>{c.text}</div>
                <div style={{ fontSize: 11, color: "#9aa0a6" }}>{c.skill.toUpperCase()} check — {c.fail_damage} dmg on fail</div>
              </div>
            </button>
          ))}
        </div>
      </OverlayPanel>
    );
  }

  if (content.kind === "lockbox" && !content.resolved) {
    const tier = content.lock_tier;
    const tierColor = tier === "gold" ? "#fbbf24" : tier === "silver" ? "#d1d5db" : "#b45309";
    return (
      <OverlayPanel title={`Locked chest — needs ${tier} key`}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
          {content.options.map((opt, i) => (
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

  if (content.kind === "npc" && !content.resolved) {
    return (
      <OverlayPanel title="A traveler">
        <p style={{ fontSize: 13, color: "#d1d5db", fontStyle: "italic", margin: "0 0 10px" }}>{content.greeting}</p>
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
            Accept: {content.offer.name}
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

  if (content.kind === "merchant" && !content.resolved) {
    return (
      <OverlayPanel title="Merchant">
        <p style={{ fontSize: 13, color: "#d1d5db", fontStyle: "italic", margin: "0 0 10px" }}>{content.greeting}</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
          {content.stock.map((opt, i) => (
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

function CombatPanel({ state, selfId, onSend, autoResolve, setAutoResolve, log, myTurn, isMonsterTurn }: {
  state: CombatState; selfId: string;
  onSend: (a: TurnAction) => boolean;
  autoResolve: boolean; setAutoResolve: (b: boolean) => void;
  log: LogEntry[]; myTurn: boolean; isMonsterTurn: boolean;
}) {
  const me = state.fighters.find((f) => f.id === selfId);
  const mana = me?.mana ?? 0;
  const liveMonsters = state.monsters.filter((m) => m.hp > 0);
  const target = liveMonsters[0]?.id ?? null;

  return (
    <div style={{ background: "rgba(10,11,14,0.97)", borderTop: "1px solid #1e2028", flexShrink: 0, overflow: "hidden" }}>
      <div style={{ padding: "6px 12px 4px", display: "flex", flexDirection: "column", gap: 2, maxHeight: 64, overflowY: "auto" }}>
        {log.slice(-3).map((e) => (
          <div key={e.id} style={{ fontSize: 12, color: e.tone === "good" ? "#86efac" : e.tone === "bad" ? "#fca5a5" : e.tone === "info" ? "#93c5fd" : "#9aa0a6" }}>{e.text}</div>
        ))}
      </div>
      <div style={{ padding: "6px 10px 8px", display: "flex", gap: 5, flexWrap: "wrap", borderTop: "1px solid #1a1c21" }}>
        {myTurn && (
          <>
            <CBtn label="Attack" color="#b89b3a" onClick={() => onSend({ kind: "attack", actor: selfId, target_id: target })} />
            <CBtn label="Cast" color="#818cf8" disabled={mana < 1} onClick={() => onSend({ kind: "cast", actor: selfId, target_id: target })} />
            <CBtn label="Signature" color="#a78bfa" disabled={mana < 2} onClick={() => onSend({ kind: "signature", actor: selfId, target_id: target })} />
            <CBtn label="Flee" color="#4b5563" onClick={() => onSend({ kind: "flee", actor: selfId })} />
          </>
        )}
        {!myTurn && isMonsterTurn && !autoResolve && (
          <CBtn label="Resolve enemy" color="#5c1f1f" onClick={() => onSend({ kind: "monster_act" })} />
        )}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#4a5568", cursor: "pointer" }}>
            <input type="checkbox" checked={autoResolve} onChange={(e) => setAutoResolve(e.target.checked)} style={{ accentColor: "#5c1f1f" }} />
            Auto
          </label>
        </div>
      </div>
    </div>
  );
}

function CBtn({ label, color, disabled, onClick }: { label: string; color: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{ padding: "5px 12px", background: disabled ? "#1a1c21" : color, border: `1px solid ${disabled ? "#2a2d33" : color}`, borderRadius: 6, color: disabled ? "#4a5568" : "#0e0f12", fontSize: 12, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }}>{label}</button>
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
