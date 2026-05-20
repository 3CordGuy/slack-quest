// First-person immersive dungeon crawler view.
// Renders the full-screen dungeon experience: room backgrounds, monster overlay,
// combat panel, minimap, party bar. Manages its own WS connection for combat.
//
// Mount condition: activeQuest.scene.variant === "dungeon"
// Unmount: user exits to town (onExit) or quest completes.

import { useEffect, useReducer, useRef, useState } from "react";
import toast from "react-hot-toast";
import { isMonsterActor } from "@gantt-quest/core";
import { Avatar, Icon } from "./icons";

const DISPLAY_FONT = "'Metamorphous', serif";

// ─── Types (mirrors CombatPage; duplicated to keep DungeonView self-contained) ──

interface StatusEffect {
  type: "regen" | "bleeding" | "burning" | "poisoned" | "frozen" | "shocked";
  magnitude: number;
  remaining: number;
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
  art_url?: string;
}

interface CombatState {
  fighters: Fighter[];
  monsters: Monster[];
  turn_order: string[];
  turn_index: number;
  round: number;
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
  rewards: Array<{
    user_id: string;
    xp_awarded: number;
    gold_awarded: number;
    level_up: boolean;
    new_level: number;
    loot: Array<{ item_name: string; item_type: string; power: number; rarity: string; flavor?: string }>;
    soft_death: { gold_lost: number; item_lost: string | null; scar: string } | null;
  }>;
  monster_name: string;
  dungeon_room_cleared?: boolean;
  dungeon_doors?: Array<{ type: string; monster_name: string | null; scene: string | null }>;
}

interface LogEntry {
  id: number;
  text: string;
  tone: "info" | "good" | "bad" | "muted";
}

interface WsUiState {
  connection: "connecting" | "open" | "closed";
  state: CombatState | null;
  log: LogEntry[];
  outcome: OutcomeSummary | null;
}

// ─── App-level types (subset of App.tsx) ──────────────────────────────────────

type ExpeditionNodeType = "combat" | "trap" | "lockbox" | "npc" | "treasure" | "merchant";
type KeyTier = "bronze" | "silver" | "gold";
type SkillType = "str" | "dex" | "int";

interface TrapChoice { text: string; emoji: string; skill: SkillType; fail_damage: number }
interface LootOption { name: string; item_type: string; power: number; rarity: string; flavor: string; slot?: string | null; stat_bonus?: Record<string, number> | null }
interface NpcOffer { greeting: string; item: LootOption }
interface ExpeditionNode {
  type: ExpeditionNodeType;
  scene: string;
  monster_name?: string;
  monster_max_hp?: number;
  monster_art_url?: string | null;
  tier?: number;
  trap_choices?: TrapChoice[];
  loot_options?: LootOption[];
  lock_tier?: KeyTier;
  npc?: NpcOffer;
}
interface ExpeditionState {
  theme: string;
  current: number;
  nodes: ExpeditionNode[];
  pending_doors?: number[];
  middle_count?: number;
  visited_count?: number;
  sealed_doors?: number[];
}
interface SceneJson {
  monster_name: string;
  monster_hp: number;
  monster_max_hp: number;
  tier: number;
  scene: string;
  variant?: string;
  monster_art_url?: string | null;
  expedition?: ExpeditionState;
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
  armor_power?: number;
  keys_bronze: number;
  keys_silver: number;
  keys_gold: number;
  position: "front" | "back";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let nextLogId = 1;

function roomBgUrl(nodeType: ExpeditionNodeType, nodeIndex: number, isBoss: boolean): string {
  const variant = (nodeIndex % 4) + 1;
  const key = isBoss ? `dungeon_boss_${variant}` : `dungeon_${nodeType}_${variant}`;
  return `/img/art/views/v6/${key}.png`;
}

function hpColor(current: number, max: number): string {
  const pct = max > 0 ? current / max : 0;
  if (pct > 0.5) return "#22c55e";
  if (pct > 0.25) return "#f59e0b";
  return "#ef4444";
}

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

function slugifyName(n: string): string {
  return n.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "unnamed";
}
function charPortraitUrl(name: string): string {
  return `/img/art/v3/character/${slugifyName(name)}.png`;
}

function formatCombatEvent(e: { type: string; [k: string]: unknown }, nameOf: (id: string) => string): LogEntry | null {
  const row = (text: string, tone: LogEntry["tone"]): LogEntry => ({ id: nextLogId++, text, tone });
  switch (e.type) {
    case "begin": return row("Combat begins — rolling initiative…", "info");
    case "player_hit": return row(`${nameOf(e.actor as string)} hits for ${e.damage} dmg${e.crit ? " (CRIT!)" : ""}`, "good");
    case "monster_attack": return row(`Monster strikes — ${e.hp_damage} HP damage`, "bad");
    case "boss_phase_transition": return row("The boss enters phase 2!", "bad");
    case "fighter_down": return row(`${nameOf(e.target as string)} is down!`, "bad");
    case "monster_down": return row(`${nameOf(e.killed_by as string)} lands the killing blow!`, "good");
    case "heal_applied": return row(`${nameOf(e.actor as string)}: +${e.amount} HP healed`, "good");
    case "shield_applied": return row(`${nameOf(e.actor as string)}: +${e.amount} shield`, "good");
    case "signature_used": return row(`${nameOf(e.actor as string)} signature: ${e.damage} dmg`, "good");
    case "victory": return row("Victory!", "good");
    case "defeat": return row("The party falls…", "bad");
    case "fled": return row("The party escapes!", "muted");
    case "wave_transition": return row(`Wave ${e.new_wave}/${e.total_waves}: ${e.to_monster} arrives`, "info");
    default: return null;
  }
}

// ─── WS reducer ───────────────────────────────────────────────────────────────

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
      const nameOf = (id: string) => {
        if (isMonsterActor(id)) return s.state?.monsters?.[0]?.name ?? "monster";
        return s.state?.fighters.find((f) => f.id === id)?.name ?? id;
      };
      const newEntries = a.value.flatMap((e) => {
        const entry = formatCombatEvent(e, nameOf);
        return entry ? [entry] : [];
      });
      return { ...s, log: [...s.log, ...newEntries].slice(-20) };
    }
    case "outcome": return { ...s, outcome: a.value };
  }
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function HpBar({ current, max, color, height = 6 }: { current: number; max: number; color?: string; height?: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  const c = color ?? hpColor(current, max);
  return (
    <div style={{ height, background: "#1a1c21", borderRadius: height / 2, overflow: "hidden" }}>
      <div style={{ width: `${pct * 100}%`, height: "100%", background: c, borderRadius: height / 2, transition: "width 0.3s ease" }} />
    </div>
  );
}

// Rooms snake through a grid: row 0 goes →, row 1 goes ←, row 2 goes →, etc.
// Corridors are drawn as SVG lines between room centers.
const MINIMAP_ROW_WIDTH = 3;
const R = 10;   // room square size (px)
const G = 7;    // gap between rooms (corridor width)
const CELL = R + G; // grid unit

function minimapPos(idx: number): { cx: number; cy: number } {
  const row = Math.floor(idx / MINIMAP_ROW_WIDTH);
  const posInRow = idx % MINIMAP_ROW_WIDTH;
  const col = row % 2 === 0 ? posInRow : MINIMAP_ROW_WIDTH - 1 - posInRow;
  return { cx: col * CELL + R / 2, cy: row * CELL + R / 2 };
}

function Minimap({ expedition }: { expedition: ExpeditionState }) {
  const n = expedition.nodes.length;
  const current = expedition.current;
  const sealed = expedition.sealed_doors ?? [];

  const numRows = Math.ceil(n / MINIMAP_ROW_WIDTH);
  const svgW = MINIMAP_ROW_WIDTH * CELL - G;
  const svgH = numRows * CELL - G;

  // Node type icons for SVG text
  const typeGlyph: Record<string, string> = {
    combat: "⚔", trap: "⚠", lockbox: "🔒",
    npc: "👤", treasure: "★", merchant: "₿",
  };

  return (
    <div style={{
      position: "absolute",
      top: 12,
      right: 12,
      background: "rgba(0,0,0,0.78)",
      border: "1px solid rgba(255,255,255,0.14)",
      borderRadius: 8,
      padding: "7px 9px 5px",
      display: "flex",
      flexDirection: "column",
      gap: 4,
      backdropFilter: "blur(6px)",
      userSelect: "none",
    }}>
      <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1 }}>
        {expedition.theme.length > 22 ? expedition.theme.slice(0, 20) + "…" : expedition.theme}
      </div>
      <svg width={svgW} height={svgH} style={{ display: "block" }}>
        {/* Corridors — draw first so rooms render on top */}
        {Array.from({ length: n - 1 }, (_, i) => {
          const a = minimapPos(i);
          const b = minimapPos(i + 1);
          const visited = i < current;
          const active = i === current - 1 || i === current;
          return (
            <line
              key={`c${i}`}
              x1={a.cx} y1={a.cy} x2={b.cx} y2={b.cy}
              stroke={visited ? "#4b5563" : "#1f2937"}
              strokeWidth={active ? 3 : 2}
            />
          );
        })}

        {/* Room squares */}
        {Array.from({ length: n }, (_, i) => {
          const { cx, cy } = minimapPos(i);
          const isCurrent = i === current;
          const isPast = i < current;
          const isSealed = sealed.includes(i);
          const isBoss = i === n - 2;
          const isTreasure = i === n - 1;
          const node = expedition.nodes[i];

          const size = (isBoss || isTreasure) ? R + 2 : R;
          const x = cx - size / 2;
          const y = cy - size / 2;

          let fill = "#111318";
          let stroke = "#2a2d33";
          let strokeW = 1;
          if (isCurrent) { fill = "#f5f5dc"; stroke = "#f5f5dc"; strokeW = 1.5; }
          else if (isSealed) { fill = "#1a0000"; stroke = "#5c1f1f"; }
          else if (isPast) { fill = "#374151"; stroke = "#4b5563"; }
          else if (isBoss) { stroke = "#7f1d1d"; }
          else if (isTreasure) { stroke = "#92400e"; }

          return (
            <g key={`r${i}`}>
              <rect x={x} y={y} width={size} height={size} fill={fill} stroke={stroke} strokeWidth={strokeW} rx={2} />
              {/* Pulsing dot for current room */}
              {isCurrent && (
                <circle cx={cx} cy={cy} r={2.5} fill="#0e0f12" />
              )}
              {/* Boss marker */}
              {isBoss && !isCurrent && (
                <circle cx={cx} cy={cy} r={2} fill={isPast ? "#6b7280" : "#fca5a5"} />
              )}
              {/* Treasure marker */}
              {isTreasure && !isCurrent && (
                <circle cx={cx} cy={cy} r={2} fill={isPast ? "#6b7280" : "#fbbf24"} />
              )}
              {/* Lockbox key dot */}
              {node?.type === "lockbox" && !isCurrent && !isPast && (
                <circle cx={cx} cy={cy} r={1.5} fill="#60a5fa" />
              )}
            </g>
          );
        })}
      </svg>
      <div style={{ fontSize: 9, color: "#6b7280", textAlign: "right" }}>
        {current + 1}/{n}
      </div>
    </div>
  );
}

function PartyBar({ fighters, selfId, party }: {
  fighters: Fighter[] | null;
  selfId: string;
  party: Character[];
}) {
  // Normalise to a unified shape regardless of combat vs exploration state.
  // Dedup characters by slack_user_id so a solo player doesn't appear twice.
  const seen = new Set<string>();
  type Member = { key: string; name: string; cls: string; hp: number; max_hp: number; mana: number; max_mana: number; shield: number; armor_power: number; isSelf: boolean; isDead: boolean };
  const members: Member[] = fighters
    ? fighters.map((f) => ({
        key: f.id,
        name: f.name,
        cls: f.class,
        hp: f.hp,
        max_hp: f.max_hp,
        mana: f.mana,
        max_mana: f.max_mana,
        shield: f.shield,
        armor_power: f.armor_power,
        isSelf: f.id === selfId,
        isDead: f.hp <= 0,
      }))
    : party.flatMap((c) => {
        if (seen.has(c.slack_user_id)) return [];
        seen.add(c.slack_user_id);
        return [{
          key: c.slack_user_id,
          name: c.name,
          cls: c.class,
          hp: c.hp,
          max_hp: c.max_hp,
          mana: c.mana,
          max_mana: c.max_mana,
          shield: c.shield,
          armor_power: c.armor_power ?? 0,
          isSelf: c.slack_user_id === selfId,
          isDead: c.hp <= 0,
        }];
      });

  return (
    <div style={{
      background: "rgba(10,11,14,0.96)",
      borderTop: "1px solid #1e2028",
      padding: "8px 12px",
      display: "flex",
      gap: 10,
      alignItems: "center",
      overflowX: "auto",
      flexShrink: 0,
    }}>
      {members.map((f) => {
        const portrait = charPortraitUrl(f.name);
        const classPic = classPortraitUrl(f.cls);
        const isSelf = f.isSelf;
        const isDead = f.isDead;
        return (
          <div key={f.key} style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: isSelf ? "rgba(245,245,220,0.06)" : "transparent",
            border: isSelf ? "1px solid rgba(245,245,220,0.15)" : "1px solid transparent",
            borderRadius: 8,
            padding: "4px 8px",
            opacity: isDead ? 0.45 : 1,
            flexShrink: 0,
            minWidth: 140,
          }}>
            <Avatar
              src={portrait}
              fallbackSrc={classPic}
              alt={f.name}
              size={36}
              radius={5}
              fallbackIcon="player"
              fallbackColor="#4a5568"
              border="1px solid #2a2d33"
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#e2e8f0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {f.name}
              </div>
              <HpBar current={f.hp} max={f.max_hp} height={5} />
              {(() => { const armorMax = Math.floor(f.armor_power / 2); return armorMax > 0 ? <div style={{ height: 4, background: f.shield === 0 ? "#3b1515" : "#0e0f12", borderRadius: 2, overflow: "hidden", marginTop: 2 }} title={f.shield === 0 ? "Armor depleted" : `Armor: ${f.shield}/${armorMax}`}><div style={{ width: `${Math.min(1, f.shield / armorMax) * 100}%`, height: "100%", background: "#6b7280", transition: "width 0.3s ease" }} /></div> : null; })()}
              <div style={{ fontSize: 10, color: "#9aa0a6", marginTop: 1 }}>
                {f.hp}/{f.max_hp} HP
              </div>
              <div style={{ display: "flex", gap: 3, marginTop: 2 }}>
                {Array.from({ length: f.max_mana }, (_, mi) => (
                  <div key={mi} style={{
                    width: 7, height: 7,
                    borderRadius: "50%",
                    background: mi < f.mana ? "#818cf8" : "#1e2028",
                    border: "1px solid #3a3d43",
                  }} />
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MonsterOverlay({ monster, scene, isBoss }: { monster: Monster | null; scene: SceneJson; isBoss: boolean }) {
  const name = monster?.name ?? scene.monster_name ?? "—";
  const hp = monster?.hp ?? scene.monster_hp ?? 0;
  const maxHp = monster?.max_hp ?? scene.monster_max_hp ?? 1;
  const artUrl = monster?.art_url ?? scene.monster_art_url;
  const bossPhase = monster?.boss_phase;
  const effects = monster?.effects ?? [];

  if (!name || hp <= 0) return null;

  return (
    <div style={{
      position: "absolute",
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -60%)",
      background: "rgba(10,11,14,0.88)",
      border: `1px solid ${isBoss ? "#fca5a5" : "#2a2d33"}`,
      borderRadius: 12,
      padding: "10px 14px",
      minWidth: 200,
      maxWidth: 280,
      backdropFilter: "blur(8px)",
      boxShadow: isBoss ? "0 0 32px rgba(239,68,68,0.3)" : "0 4px 24px rgba(0,0,0,0.6)",
    }}>
      {artUrl && (
        <img src={artUrl} alt={name} style={{
          width: "100%",
          height: 140,
          objectFit: "cover",
          borderRadius: 8,
          marginBottom: 8,
          display: "block",
        }} />
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div style={{ fontFamily: DISPLAY_FONT, fontSize: 15, fontWeight: 700, color: isBoss ? "#fca5a5" : "#f5f5f5" }}>
          {name}
        </div>
        {bossPhase === 2 && (
          <span style={{ fontSize: 10, color: "#fca5a5", border: "1px solid #fca5a5", borderRadius: 4, padding: "1px 5px" }}>
            PHASE 2
          </span>
        )}
        <div style={{ fontSize: 12, color: "#9aa0a6", fontVariantNumeric: "tabular-nums" }}>
          {hp} / {maxHp}
        </div>
      </div>
      <HpBar current={hp} max={maxHp} color={isBoss ? "#ef4444" : undefined} height={6} />
      {effects.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
          {effects.map((eff, i) => (
            <span key={i} style={{ fontSize: 10, background: "#1a1c21", border: "1px solid #3a3d43", borderRadius: 4, padding: "1px 5px", color: "#9aa0a6" }}>
              {eff.type} ×{eff.remaining}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function InitStrip({ state, selfId }: { state: CombatState; selfId: string }) {
  const actors = state.turn_order;
  const currentIdx = state.turn_index % actors.length;

  return (
    <div style={{
      background: "rgba(10,11,14,0.92)",
      borderBottom: "1px solid #1e2028",
      padding: "5px 12px",
      display: "flex",
      gap: 6,
      alignItems: "center",
      overflowX: "auto",
      flexShrink: 0,
    }}>
      <span style={{ fontSize: 10, color: "#9aa0a6", textTransform: "uppercase", letterSpacing: 1, marginRight: 4, whiteSpace: "nowrap" }}>
        Turn order
      </span>
      {actors.map((id, i) => {
        const isCurrent = i === currentIdx;
        const isMonster = isMonsterActor(id);
        const fighter = state.fighters.find((f) => f.id === id);
        const monster = isMonster ? state.monsters.find((m) => m.id === id) ?? state.monsters[0] : null;
        const label = isMonster ? (monster?.name?.split(" ")[0] ?? "Enemy") : (fighter?.name?.split(" ")[0] ?? id);
        const isSelf = id === selfId;
        const isDead = fighter ? fighter.hp <= 0 : (monster ? monster.hp <= 0 : false);
        return (
          <div key={i} style={{
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 4,
            border: isCurrent ? "1px solid #f5f5dc" : "1px solid transparent",
            background: isCurrent ? "rgba(245,245,220,0.12)" : "transparent",
            color: isDead ? "#4a5568" : isMonster ? "#fca5a5" : isSelf ? "#f5f5dc" : "#d1d5db",
            fontWeight: isCurrent ? 700 : 400,
            whiteSpace: "nowrap",
            opacity: isDead ? 0.5 : 1,
            textDecoration: isDead ? "line-through" : "none",
          }}>
            {label}
          </div>
        );
      })}
      <span style={{ fontSize: 10, color: "#4a5568", marginLeft: 4, whiteSpace: "nowrap" }}>round {state.round}</span>
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────────

interface DungeonViewProps {
  questId: number;
  selfId: string;
  scene: SceneJson;
  party: Character[];
  character: Character;
  hasWebCombat: boolean;
  myKeys: { bronze: number; silver: number; gold: number };
  onChooseDoor: (pick: number) => void;
  onTrapChoose: (pick: number) => void;
  onLockboxChoose: (pick: number) => void;
  onNpcChoose: (pick: number) => void;
  onMerchantChoose: (pick: number) => void;
  onTreasureTake: (pick: number) => void;
  onExit: () => void;
  onRefresh: () => void;
}

export function DungeonView({
  questId,
  selfId,
  scene,
  party,
  character,
  hasWebCombat,
  myKeys,
  onChooseDoor,
  onTrapChoose,
  onLockboxChoose,
  onNpcChoose,
  onMerchantChoose,
  onTreasureTake,
  onExit,
  onRefresh,
}: DungeonViewProps) {
  const expedition = scene.expedition!;
  const currentNode = expedition.nodes[expedition.current];
  const isBoss = expedition.current === expedition.nodes.length - 2;
  const nodeType = currentNode?.type ?? "combat";

  // Whether we've activated web combat for the current combat room
  const [combatActive, setCombatActive] = useState(
    hasWebCombat && nodeType === "combat",
  );
  const [reconnectKey, setReconnectKey] = useState(0);
  const [ws, dispatch] = useReducer(wsReducer, {
    connection: "connecting" as const,
    state: null,
    log: [],
    outcome: null,
  });
  const wsRef = useRef<WebSocket | null>(null);
  const autoResolveRef = useRef(true);
  const logScrollRef = useRef<HTMLDivElement | null>(null);
  const [targeting, setTargeting] = useState<string | null>(null); // monster id to target
  const [autoResolve, setAutoResolve] = useState(true);
  const [pickingSupport, setPickingSupport] = useState<"heal" | "shield" | null>(null);
  const [itemPickerOpen, setItemPickerOpen] = useState(false);
  const [items, setItems] = useState<Array<{ id: number; item_name: string; item_type: string; power: number; equipped: boolean }>>([]);
  const autoResolvedTurnRef = useRef(-1);

  // Connect WS when combat is active
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

    const heartbeat = setInterval(() => {
      if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "ping" }));
    }, 45_000);

    sock.onopen = () => dispatch({ kind: "connection", value: "open" });
    sock.onclose = () => dispatch({ kind: "connection", value: "closed" });
    sock.onerror = () => toast.error("Combat connection lost");
    sock.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as {
          type: string;
          state?: CombatState & { monster?: Monster };
          events?: Array<{ type: string; [k: string]: unknown }>;
          outcome?: OutcomeSummary;
        };
        if (msg.type === "state") {
          const s = msg.state!;
          const normalised: CombatState = "monsters" in s && Array.isArray(s.monsters)
            ? s : { ...s, monsters: [(s as unknown as { monster: Monster }).monster] };
          dispatch({ kind: "state", value: normalised });
        } else if (msg.type === "events" && msg.events) {
          dispatch({ kind: "events", value: msg.events });
          if (msg.events.some((e) => e.type === "item_used")) void loadItems();
        } else if (msg.type === "outcome" && msg.outcome) {
          dispatch({ kind: "outcome", value: msg.outcome });
        }
      } catch { /* ignore bad frames */ }
    };
    return () => {
      clearInterval(heartbeat);
      sock.close();
      wsRef.current = null;
    };
  }, [questId, combatActive, reconnectKey]);

  // Auto-scroll log
  const lastLogId = ws.log[ws.log.length - 1]?.id;
  useEffect(() => {
    if (logScrollRef.current) logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
  }, [lastLogId]);

  // Auto-resolve monster turns
  const stateForAuto = ws.state;
  useEffect(() => {
    autoResolveRef.current = autoResolve;
  }, [autoResolve]);
  useEffect(() => {
    if (!autoResolveRef.current) return;
    if (!stateForAuto || stateForAuto.status !== "active") return;
    const actorId = stateForAuto.turn_order[stateForAuto.turn_index % stateForAuto.turn_order.length];
    if (!isMonsterActor(actorId)) return;
    if (autoResolvedTurnRef.current === stateForAuto.turn_index) return;
    const t = setTimeout(() => {
      if (!autoResolveRef.current) return;
      const fired = send({ kind: "monster_act" });
      if (fired) autoResolvedTurnRef.current = stateForAuto.turn_index;
    }, 800);
    return () => clearTimeout(t);
  }, [stateForAuto?.turn_index, stateForAuto?.status, autoResolve]);

  function send(action: TurnAction): boolean {
    const sock = wsRef.current;
    if (!sock || sock.readyState !== WebSocket.OPEN) return false;
    sock.send(JSON.stringify({ type: "action", action }));
    return true;
  }

  async function enterCombat() {
    const res = await fetch(`/api/quest/${questId}/start_web_combat`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) {
      toast.error("Could not start combat");
      return;
    }
    setCombatActive(true);
  }

  async function loadItems() {
    const res = await fetch("/api/inventory", { credentials: "include" });
    if (res.ok) setItems(((await res.json()) as { items: typeof items }).items);
  }
  useEffect(() => { void loadItems(); }, []);

  // After dungeon room victory, refresh expedition state from server
  useEffect(() => {
    if (ws.outcome?.status === "victory" && ws.outcome?.dungeon_room_cleared) {
      // Let the victory animation show briefly, then refresh expedition state
      const t = setTimeout(() => {
        onRefresh();
        setCombatActive(false);
      }, 3000);
      return () => clearTimeout(t);
    }
  }, [ws.outcome?.status]);

  const combatState = ws.state;
  const currentActorId = combatState?.status === "active"
    ? combatState.turn_order[combatState.turn_index % combatState.turn_order.length]
    : null;
  const myTurn = currentActorId === selfId;
  const liveMonsters = combatState?.monsters.filter((m) => m.hp > 0) ?? [];
  const effectiveTarget = liveMonsters.length === 1 ? (liveMonsters[0].id ?? null) : targeting;
  const combatEnded = combatState?.status === "victory" || combatState?.status === "defeat" || combatState?.status === "fled";
  const isMonsterTurn = currentActorId ? isMonsterActor(currentActorId) : false;

  const bgUrl = roomBgUrl(nodeType as ExpeditionNodeType, expedition.current, isBoss);

  // Determine what non-combat overlay to show
  const pendingDoors = expedition.pending_doors ?? [];
  const showDoorPicker = !combatActive && pendingDoors.length > 0;
  const showTrapPicker = !combatActive && nodeType === "trap" && !!currentNode?.trap_choices;
  const showLockboxPicker = !combatActive && nodeType === "lockbox" && !!currentNode?.loot_options;
  const showNpcPicker = !combatActive && nodeType === "npc" && !!currentNode?.npc;
  const showMerchantPicker = !combatActive && nodeType === "merchant" && !!currentNode?.loot_options;
  const showTreasurePicker = !combatActive && nodeType === "treasure" && !!currentNode?.loot_options;
  const showEnterCombat = !combatActive && nodeType === "combat" && scene.monster_hp > 0;
  const showWaitingRoom = !combatActive && !showDoorPicker && !showTrapPicker && !showLockboxPicker && !showNpcPicker && !showMerchantPicker && !showTreasurePicker && !showEnterCombat;

  return (
    <div style={{
      position: "fixed",
      inset: 0,
      background: "#0a0b0e",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      fontFamily: "Inter, system-ui, sans-serif",
    }}>
      {/* ── Top bar ── */}
      <div style={{
        background: "rgba(10,11,14,0.95)",
        borderBottom: "1px solid #1e2028",
        padding: "0 12px",
        height: 44,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexShrink: 0,
        zIndex: 10,
      }}>
        <button
          onClick={onExit}
          style={{ background: "none", border: "none", color: "#9aa0a6", cursor: "pointer", fontSize: 13, padding: "4px 8px", borderRadius: 6, display: "flex", alignItems: "center", gap: 6 }}
        >
          <Icon name="footprint" size={13} /> Exit Dungeon
        </button>
        <div style={{ fontSize: 12, fontFamily: DISPLAY_FONT, color: "#c4a35a" }}>
          {expedition.theme}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {combatActive && (
            <span style={{ fontSize: 11, color: ws.connection === "open" ? "#39ff14" : "#9aa0a6" }}>
              {ws.connection === "open" ? "● live" : "○ …"}
            </span>
          )}
          <span style={{ fontSize: 11, color: "#9aa0a6" }}>
            Room {expedition.current + 1}/{expedition.nodes.length}
          </span>
        </div>
      </div>

      {/* ── Initiative strip (combat only) ── */}
      {combatActive && combatState && (
        <InitStrip state={combatState} selfId={selfId} />
      )}

      {/* ── Room view (flex-grow) ── */}
      <div style={{
        flex: 1,
        position: "relative",
        overflow: "hidden",
        minHeight: 0,
      }}>
        {/* Room background */}
        <img
          src={bgUrl}
          alt=""
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: "center",
          }}
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
        {/* Gradient overlay for readability */}
        <div style={{
          position: "absolute",
          inset: 0,
          background: "linear-gradient(to bottom, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.05) 40%, rgba(0,0,0,0.5) 100%)",
          pointerEvents: "none",
        }} />

        {/* Monster overlay (combat) */}
        {combatActive && combatState && liveMonsters.length > 0 && (
          <MonsterOverlay
            monster={liveMonsters[0]}
            scene={scene}
            isBoss={isBoss}
          />
        )}

        {/* Multi-monster strip (>1 monster) */}
        {combatActive && combatState && liveMonsters.length > 1 && (
          <div style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -55%)",
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
            justifyContent: "center",
            maxWidth: "85%",
          }}>
            {liveMonsters.map((m) => (
              <div
                key={m.id ?? m.name}
                onClick={() => setTargeting(m.id ?? null)}
                style={{
                  background: "rgba(10,11,14,0.88)",
                  border: `2px solid ${effectiveTarget === (m.id ?? null) ? "#f5f5dc" : "#2a2d33"}`,
                  borderRadius: 10,
                  padding: "8px 12px",
                  minWidth: 140,
                  cursor: "pointer",
                  backdropFilter: "blur(6px)",
                  boxShadow: effectiveTarget === (m.id ?? null) ? "0 0 16px rgba(245,245,220,0.3)" : "none",
                }}>
                {m.art_url && (
                  <img src={m.art_url} alt={m.name} style={{ width: "100%", height: 80, objectFit: "cover", borderRadius: 6, marginBottom: 6, display: "block" }} />
                )}
                <div style={{ fontSize: 13, fontWeight: 600, color: "#f5f5f5", marginBottom: 4 }}>{m.name}</div>
                <HpBar current={m.hp} max={m.max_hp} height={5} />
                <div style={{ fontSize: 10, color: "#9aa0a6", marginTop: 2 }}>{m.hp}/{m.max_hp}</div>
              </div>
            ))}
          </div>
        )}

        {/* Minimap */}
        <Minimap expedition={expedition} />

        {/* Scene flavor text (exploration) */}
        {!combatActive && currentNode?.scene && (
          <div style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            background: "linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0) 100%)",
            padding: "24px 20px 12px",
            pointerEvents: "none",
          }}>
            <p style={{ fontSize: 13, color: "#d1d5db", fontStyle: "italic", margin: 0, lineHeight: 1.5, maxWidth: 500 }}>
              {currentNode.scene}
            </p>
          </div>
        )}

        {/* Combat outcome overlay */}
        {combatActive && combatEnded && ws.outcome && (
          <div style={{
            position: "absolute",
            inset: 0,
            background: ws.outcome.status === "victory" ? "rgba(0,80,20,0.6)" : "rgba(80,0,0,0.6)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            backdropFilter: "blur(4px)",
            zIndex: 20,
          }}>
            <div style={{ fontFamily: DISPLAY_FONT, fontSize: 32, color: ws.outcome.status === "victory" ? "#86efac" : "#fca5a5" }}>
              {ws.outcome.status === "victory" ? "Victory!" : "Defeated…"}
            </div>
            {ws.outcome.rewards.filter((r) => r.user_id === selfId).map((r) => (
              <div key={r.user_id} style={{ fontSize: 13, color: "#d1d5db", textAlign: "center", lineHeight: 1.8 }}>
                <div>+{r.xp_awarded} XP · +{r.gold_awarded} gold</div>
                {r.level_up && <div style={{ color: "#fbbf24" }}>Level up! → {r.new_level}</div>}
                {r.loot.map((l, i) => (
                  <div key={i} style={{ color: "#c084fc" }}>{l.item_name} ({l.rarity})</div>
                ))}
                {r.soft_death && <div style={{ color: "#fca5a5" }}>Lost {r.soft_death.gold_lost} gold</div>}
              </div>
            ))}
            {ws.outcome.status === "victory" && (
              <div style={{ fontSize: 12, color: "#9aa0a6", marginTop: 8 }}>
                Continuing to next room…
              </div>
            )}
            {ws.outcome.status === "defeat" && (
              <button
                onClick={onExit}
                style={{ padding: "8px 20px", background: "#5c1f1f", border: "1px solid #7f1d1d", borderRadius: 6, color: "#fca5a5", cursor: "pointer", fontSize: 13 }}
              >
                Return to town
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Non-combat overlays ── */}
      {showDoorPicker && (
        <DoorOverlay
          doors={pendingDoors.map((idx) => expedition.nodes[idx])}
          onPick={onChooseDoor}
        />
      )}
      {showTrapPicker && currentNode?.trap_choices && (
        <TrapOverlay choices={currentNode.trap_choices} onPick={onTrapChoose} />
      )}
      {showLockboxPicker && currentNode?.loot_options && currentNode.lock_tier && (
        <LockboxOverlay
          options={currentNode.loot_options}
          lockTier={currentNode.lock_tier}
          myKeys={myKeys}
          onPick={onLockboxChoose}
        />
      )}
      {showNpcPicker && currentNode?.npc && (
        <NpcOverlay npc={currentNode.npc} onPick={onNpcChoose} />
      )}
      {showMerchantPicker && currentNode?.loot_options && (
        <MerchantOverlay options={currentNode.loot_options} onPick={onMerchantChoose} />
      )}
      {showTreasurePicker && currentNode?.loot_options && (
        <TreasureOverlay options={currentNode.loot_options} onPick={onTreasureTake} />
      )}
      {showEnterCombat && (
        <EnterCombatBanner
          monsterName={currentNode?.monster_name ?? scene.monster_name}
          monsterHp={scene.monster_hp}
          monsterMaxHp={scene.monster_max_hp}
          isBoss={isBoss}
          onEnter={enterCombat}
        />
      )}
      {showWaitingRoom && nodeType === "combat" && scene.monster_hp <= 0 && (
        <div style={{ background: "rgba(0,40,0,0.8)", borderTop: "1px solid #166534", padding: "10px 16px", textAlign: "center" }}>
          <span style={{ fontSize: 13, color: "#86efac" }}>
            <Icon name="trophy" /> Room cleared — awaiting doors…
          </span>
        </div>
      )}

      {/* ── Combat panel (sliding in above party bar) ── */}
      {combatActive && !combatEnded && combatState && (
        <div style={{
          background: "rgba(10,11,14,0.97)",
          borderTop: "1px solid #1e2028",
          flexShrink: 0,
          overflow: "hidden",
        }}>
          {/* Log — last 3 entries */}
          <div
            ref={logScrollRef}
            style={{
              padding: "6px 12px 4px",
              display: "flex",
              flexDirection: "column",
              gap: 2,
              maxHeight: 72,
              overflowY: "auto",
            }}
          >
            {ws.log.slice(-4).map((entry) => (
              <div key={entry.id} style={{
                fontSize: 12,
                color: entry.tone === "good" ? "#86efac"
                  : entry.tone === "bad" ? "#fca5a5"
                  : entry.tone === "info" ? "#93c5fd"
                  : "#9aa0a6",
                lineHeight: 1.4,
              }}>
                {entry.text}
              </div>
            ))}
            {ws.log.length === 0 && (
              <div style={{ fontSize: 12, color: "#4a5568" }}>Waiting for combat to begin…</div>
            )}
          </div>

          {/* Action panel */}
          {(() => {
            const me = combatState.fighters.find((f) => f.id === selfId);
            const mana = me?.mana ?? 0;
            const myPos = me?.position ?? "front";
            const needsTarget = liveMonsters.length > 1 && !effectiveTarget;
            const usableItems = items.filter((it) => !it.equipped && ["consumable", "magic", "revive"].includes(it.item_type));

            return (
              <div style={{ borderTop: "1px solid #1a1c21" }}>
                {/* Inline target picker for heal/shield */}
                {pickingSupport && myTurn && (
                  <div style={{ padding: "6px 10px 4px", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11, color: "#9aa0a6" }}>
                      {pickingSupport === "heal" ? "Heal who?" : "Shield who?"}
                    </span>
                    {combatState.fighters.filter((f) => f.hp > 0).map((f) => (
                      <button
                        key={f.id}
                        onClick={() => {
                          send({ kind: pickingSupport, actor: selfId, target: f.id });
                          setPickingSupport(null);
                        }}
                        style={{ padding: "3px 10px", background: "#1a2e1a", border: "1px solid #166534", borderRadius: 5, color: "#86efac", fontSize: 11, cursor: "pointer" }}
                      >
                        {f.name.split(" ")[0]} {f.hp}/{f.max_hp}
                      </button>
                    ))}
                    <button onClick={() => setPickingSupport(null)} style={{ padding: "3px 8px", background: "none", border: "1px solid #2a2d33", borderRadius: 5, color: "#9aa0a6", fontSize: 11, cursor: "pointer" }}>✕</button>
                  </div>
                )}
                {/* Inline item picker */}
                {itemPickerOpen && myTurn && (
                  <div style={{ padding: "6px 10px 4px", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11, color: "#9aa0a6" }}>Use item:</span>
                    {usableItems.length === 0 && <span style={{ fontSize: 11, color: "#4a5568" }}>No usable items</span>}
                    {usableItems.map((it) => (
                      <button
                        key={it.id}
                        onClick={() => {
                          send({ kind: "use_item", actor: selfId, item_id: it.id });
                          setItemPickerOpen(false);
                        }}
                        style={{ padding: "3px 10px", background: "#1a1529", border: "1px solid #4c1d95", borderRadius: 5, color: "#c4b5fd", fontSize: 11, cursor: "pointer" }}
                      >
                        {it.item_name}
                      </button>
                    ))}
                    <button onClick={() => setItemPickerOpen(false)} style={{ padding: "3px 8px", background: "none", border: "1px solid #2a2d33", borderRadius: 5, color: "#9aa0a6", fontSize: 11, cursor: "pointer" }}>✕</button>
                  </div>
                )}
                <div style={{ padding: "6px 10px 8px", display: "flex", gap: 5, flexWrap: "wrap" }}>
                  {myTurn && (
                    <>
                      {/* Offensive row */}
                      <CombatBtn label="Attack" icon="sword" color="#b89b3a"
                        disabled={needsTarget}
                        onClick={() => send({ kind: "attack", actor: selfId, target_id: effectiveTarget })} />
                      <CombatBtn label="Cast" icon="crystal-wand" color="#818cf8"
                        disabled={mana < 1 || needsTarget}
                        onClick={() => send({ kind: "cast", actor: selfId, target_id: effectiveTarget })} />
                      <CombatBtn label="Signature" icon="wax-seal" color="#a78bfa"
                        disabled={mana < 2 || needsTarget}
                        onClick={() => send({ kind: "signature", actor: selfId, target_id: effectiveTarget })} />
                      {/* Support row */}
                      <CombatBtn label="Heal" icon="health-increase" color="#22c55e"
                        disabled={mana < 1}
                        onClick={() => { setPickingSupport("heal"); setItemPickerOpen(false); }} />
                      <CombatBtn label="Shield" icon="shield" color="#60a5fa"
                        disabled={mana < 1}
                        onClick={() => { setPickingSupport("shield"); setItemPickerOpen(false); }} />
                      <CombatBtn
                        label={myPos === "front" ? "→ Back" : "→ Front"}
                        icon={myPos === "front" ? "perspective-dice-two" : "perspective-dice-one"}
                        color="#6b7280"
                        onClick={() => send({ kind: "position", actor: selfId, to: myPos === "front" ? "back" : "front" })} />
                      <CombatBtn label="Item" icon="ammo-bag" color="#c084fc"
                        disabled={usableItems.length === 0}
                        onClick={() => { setItemPickerOpen((o) => !o); setPickingSupport(null); }} />
                      <CombatBtn label="Flee" icon="footprint" color="#4b5563"
                        onClick={() => send({ kind: "flee", actor: selfId })} />
                    </>
                  )}
                  {!myTurn && isMonsterTurn && !autoResolve && (
                    <CombatBtn label="Resolve enemy" icon="dragon-head" color="#5c1f1f"
                      onClick={() => send({ kind: "monster_act" })} />
                  )}
                  {!myTurn && !isMonsterTurn && currentActorId && (
                    <span style={{ fontSize: 12, color: "#4a5568", padding: "4px 8px", alignSelf: "center" }}>
                      {combatState.fighters.find((f) => f.id === currentActorId)?.name ?? "Other player"}'s turn…
                    </span>
                  )}
                  <div style={{ marginLeft: "auto", display: "flex", alignItems: "center" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#4a5568", cursor: "pointer" }}>
                      <input type="checkbox" checked={autoResolve} onChange={(e) => setAutoResolve(e.target.checked)} style={{ accentColor: "#5c1f1f" }} />
                      Auto
                    </label>
                  </div>
                </div>
                {needsTarget && myTurn && (
                  <div style={{ padding: "0 12px 6px", fontSize: 11, color: "#c084fc" }}>
                    ↑ Click a monster to target it first
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* ── Party bar ── */}
      <PartyBar
        fighters={combatActive ? (combatState?.fighters ?? null) : null}
        selfId={selfId}
        party={party.length > 0 ? party : [character]}
      />
    </div>
  );
}

// ─── Combat button ─────────────────────────────────────────────────────────────

function CombatBtn({ label, icon, color, disabled, onClick }: {
  label: string; icon: string; color: string; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        padding: "5px 12px",
        background: disabled ? "#1a1c21" : color,
        border: `1px solid ${disabled ? "#2a2d33" : color}`,
        borderRadius: 6,
        color: disabled ? "#4a5568" : "#0e0f12",
        fontSize: 12,
        fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "opacity 0.15s",
      }}
    >
      <Icon name={icon} size={13} />
      {label}
    </button>
  );
}

// ─── Room-type overlays ─────────────────────────────────────────────────────────

function OverlayPanel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: "rgba(10,11,14,0.97)",
      borderTop: "1px solid #1e2028",
      padding: "12px 16px",
      flexShrink: 0,
      maxHeight: "40vh",
      overflowY: "auto",
    }}>
      {children}
    </div>
  );
}

function PanelTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, color: "#9aa0a6", marginBottom: 10 }}>
      {children}
    </div>
  );
}

function DoorOverlay({ doors, onPick }: { doors: ExpeditionNode[]; onPick: (i: number) => void }) {
  const icons = ["door-weld", "door-weld", "door-weld"];
  const nodeIcons: Record<ExpeditionNodeType, string> = {
    combat: "sword", trap: "bear-trap", lockbox: "key",
    npc: "player", treasure: "gold-bar", merchant: "shop",
  };
  return (
    <OverlayPanel>
      <PanelTitle><Icon name="door-weld" /> Choose a door</PanelTitle>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(doors.length, 3)}, 1fr)`, gap: 8 }}>
        {doors.map((door, i) => (
          <button
            key={i}
            onClick={() => onPick(i + 1)}
            style={{
              padding: "12px",
              background: "#131519",
              border: "1px solid #2a2d33",
              borderRadius: 8,
              color: "#d1d5db",
              cursor: "pointer",
              textAlign: "center",
              fontSize: 12,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Icon name={nodeIcons[door.type] ?? icons[i] ?? "door-weld"} size={20} color="#9aa0a6" />
            <span style={{ fontSize: 11, textTransform: "capitalize", color: "#9aa0a6" }}>{door.type}</span>
            {door.monster_name && <span style={{ fontSize: 11, color: "#fca5a5" }}>{door.monster_name}</span>}
          </button>
        ))}
      </div>
    </OverlayPanel>
  );
}

function TrapOverlay({ choices, onPick }: { choices: TrapChoice[]; onPick: (i: number) => void }) {
  return (
    <OverlayPanel>
      <PanelTitle><Icon name="bear-trap" /> Trap — choose your approach</PanelTitle>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {choices.map((c, i) => (
          <button
            key={i}
            onClick={() => onPick(i + 1)}
            style={{
              padding: "10px 14px",
              background: "#131519",
              border: "1px solid #2a2d33",
              borderRadius: 8,
              color: "#d1d5db",
              cursor: "pointer",
              textAlign: "left",
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <span style={{ fontSize: 18, lineHeight: 1 }}>{c.emoji}</span>
            <div>
              <div style={{ fontWeight: 600 }}>{c.text}</div>
              <div style={{ fontSize: 11, color: "#9aa0a6" }}>
                {c.skill.toUpperCase()} check — {c.fail_damage} dmg on fail
              </div>
            </div>
          </button>
        ))}
      </div>
    </OverlayPanel>
  );
}

function LockboxOverlay({ options, lockTier, myKeys, onPick }: {
  options: LootOption[];
  lockTier: KeyTier;
  myKeys: { bronze: number; silver: number; gold: number };
  onPick: (i: number) => void;
}) {
  const tierColor = lockTier === "gold" ? "#fbbf24" : lockTier === "silver" ? "#d1d5db" : "#b45309";
  const hasKey = myKeys[lockTier] > 0;
  return (
    <OverlayPanel>
      <PanelTitle>
        <Icon name="key" color={tierColor} /> Locked chest — {lockTier} key required
        {hasKey
          ? <span style={{ color: tierColor, marginLeft: 8 }}>({myKeys[lockTier]} key{myKeys[lockTier] !== 1 ? "s" : ""})</span>
          : <span style={{ color: "#fca5a5", marginLeft: 8 }}>(no key)</span>
        }
      </PanelTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
        {options.map((opt, i) => (
          <button
            key={i}
            onClick={() => hasKey ? onPick(i + 1) : undefined}
            disabled={!hasKey}
            style={{
              padding: "10px",
              background: "#131519",
              border: `1px solid ${hasKey ? tierColor : "#2a2d33"}`,
              borderRadius: 8,
              color: hasKey ? "#d1d5db" : "#4a5568",
              cursor: hasKey ? "pointer" : "not-allowed",
              textAlign: "left",
              fontSize: 12,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 2 }}>{opt.name}</div>
            <div style={{ fontSize: 11, color: "#9aa0a6" }}>power {opt.power} · {opt.rarity}</div>
          </button>
        ))}
      </div>
      {!hasKey && (
        <button onClick={() => onPick(0)} style={{ marginTop: 8, padding: "6px 12px", background: "none", border: "1px solid #2a2d33", borderRadius: 6, color: "#9aa0a6", cursor: "pointer", fontSize: 12 }}>
          Walk past
        </button>
      )}
    </OverlayPanel>
  );
}

function NpcOverlay({ npc, onPick }: { npc: NpcOffer; onPick: (i: number) => void }) {
  return (
    <OverlayPanel>
      <PanelTitle><Icon name="player" /> Traveler</PanelTitle>
      <p style={{ fontSize: 13, color: "#d1d5db", fontStyle: "italic", marginBottom: 10, lineHeight: 1.5 }}>
        {npc.greeting}
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={() => onPick(1)}
          style={{ padding: "7px 14px", background: "#1a2e1a", border: "1px solid #166534", borderRadius: 6, color: "#86efac", cursor: "pointer", fontSize: 12 }}
        >
          Accept offer: {npc.item.name}
        </button>
        <button
          onClick={() => onPick(0)}
          style={{ padding: "7px 14px", background: "none", border: "1px solid #2a2d33", borderRadius: 6, color: "#9aa0a6", cursor: "pointer", fontSize: 12 }}
        >
          Decline
        </button>
      </div>
    </OverlayPanel>
  );
}

function MerchantOverlay({ options, onPick }: { options: LootOption[]; onPick: (i: number) => void }) {
  return (
    <OverlayPanel>
      <PanelTitle><Icon name="gold-bar" /> Merchant — choose one item to purchase</PanelTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
        {options.map((opt, i) => (
          <button
            key={i}
            onClick={() => onPick(i + 1)}
            style={{ padding: "10px", background: "#131519", border: "1px solid #2a2d33", borderRadius: 8, color: "#d1d5db", cursor: "pointer", textAlign: "left", fontSize: 12 }}
          >
            <div style={{ fontWeight: 600, marginBottom: 2 }}>{opt.name}</div>
            <div style={{ fontSize: 11, color: "#9aa0a6" }}>power {opt.power} · {opt.rarity}</div>
            {opt.flavor && <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2, fontStyle: "italic" }}>{opt.flavor.slice(0, 50)}</div>}
          </button>
        ))}
      </div>
      <button onClick={() => onPick(0)} style={{ marginTop: 8, padding: "6px 12px", background: "none", border: "1px solid #2a2d33", borderRadius: 6, color: "#9aa0a6", cursor: "pointer", fontSize: 12 }}>
        Pass
      </button>
    </OverlayPanel>
  );
}

function TreasureOverlay({ options, onPick }: { options: LootOption[]; onPick: (i: number) => void }) {
  return (
    <OverlayPanel>
      <PanelTitle><Icon name="gold-bar" color="#fbbf24" /> Treasure — choose one</PanelTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8 }}>
        {options.map((opt, i) => (
          <button
            key={i}
            onClick={() => onPick(i + 1)}
            style={{
              padding: "12px",
              background: "#1a1505",
              border: "1px solid #b45309",
              borderRadius: 8,
              color: "#fcd34d",
              cursor: "pointer",
              textAlign: "left",
              fontSize: 12,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 2 }}>{opt.name}</div>
            <div style={{ fontSize: 11, color: "#d97706" }}>power {opt.power} · {opt.rarity}</div>
            {opt.flavor && <div style={{ fontSize: 10, color: "#92400e", marginTop: 4, fontStyle: "italic" }}>{opt.flavor.slice(0, 60)}</div>}
          </button>
        ))}
      </div>
    </OverlayPanel>
  );
}

function EnterCombatBanner({ monsterName, monsterHp, monsterMaxHp, isBoss, onEnter }: {
  monsterName: string;
  monsterHp: number;
  monsterMaxHp: number;
  isBoss: boolean;
  onEnter: () => void;
}) {
  return (
    <div style={{
      background: isBoss ? "rgba(80,10,10,0.95)" : "rgba(10,11,14,0.95)",
      borderTop: `1px solid ${isBoss ? "#7f1d1d" : "#1e2028"}`,
      padding: "12px 16px",
      flexShrink: 0,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: isBoss ? "#fca5a5" : "#f5f5f5", fontFamily: DISPLAY_FONT }}>
          {isBoss && <Icon name="dragon-head" size={14} color="#fca5a5" />} {monsterName}
        </div>
        <HpBar current={monsterHp} max={monsterMaxHp} color={isBoss ? "#ef4444" : undefined} height={5} />
        <div style={{ fontSize: 11, color: "#9aa0a6", marginTop: 2 }}>
          {monsterHp} / {monsterMaxHp} HP{isBoss ? " · BOSS" : ""}
        </div>
      </div>
      <button
        onClick={onEnter}
        style={{
          padding: "8px 20px",
          background: isBoss ? "#7f1d1d" : "#b89b3a",
          border: `1px solid ${isBoss ? "#991b1b" : "#c4a35a"}`,
          borderRadius: 8,
          color: isBoss ? "#fca5a5" : "#0e0f12",
          fontSize: 13,
          fontWeight: 700,
          cursor: "pointer",
          whiteSpace: "nowrap",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <Icon name="sword" size={14} /> Enter Combat
      </button>
    </div>
  );
}
