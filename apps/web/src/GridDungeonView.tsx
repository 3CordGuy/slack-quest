// Grid-based dungeon view — first-person crawl through a 2D grid of rooms.
// Replaces the legacy linear expedition. Renders shape-aware room backgrounds,
// a true 2D minimap, compass navigation (N/E/S/W), door interactions with
// keys/pick/bash, and room content overlays.

import { useEffect, useReducer, useRef, useState } from "react";
import toast from "react-hot-toast";
import { isMonsterActor } from "@gantt-quest/core";
import { Avatar, Icon } from "./icons";
import { CombatParticles, triggerBurst } from "./CombatParticles";
import {
  DISPLAY_FONT, ensureCombatAnimStyles, useIsMobile,
  slugifyName, charPortraitUrl, classPortraitUrl,
  CBtn, DiceRollEntry, DiceRollDisplay, PickerModal,
  UseItemTile, MONSTER_TARGET_TOOLS, RARITY_TINT, lootIcon,
  InitStrip, CombatLog, LogEntry, CombatItem,
  HitDust,
  HealBurst,
  ShieldBurst,
  ShieldGlow,
  CombatDevModal,
  StatusEffect,
  EFFECT_PILLS,
  CombatPanel,
  type PanelCombatState,
  type PanelTurnAction,
} from "./CombatShared";
ensureCombatAnimStyles();

// Minimap and combat log share a fixed width on the right side of the room
// view (~1/8 of viewport on desktop). On mobile they move to the bottom.

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
  | { kind: "lockbox"; lock_tier: KeyTier; options: LootOption[]; resolved: boolean; opened?: boolean; claims?: Record<string, string> }
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
  armor_power?: number;
  keys_bronze: number;
  keys_silver: number;
  keys_gold: number;
  position: "front" | "back";
}

// ─── Combat WS types (subset, mirrors CombatPage) ───────────────────────────

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
  // Mirrors CombatPage's Monster type so the dungeon's MonsterCard renders
  // the same damage-type / element pills as the standard quest cards.
  element_weakness?: "fire" | "ice" | "lightning";
  element_resistance?: "fire" | "ice" | "lightning";
  attack_damage_type?: "physical" | "magic" | "fire" | "ice" | "lightning";
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
  | { kind: "flee"; actor: string }
  | { kind: "position"; actor: string; to: "front" | "back" }
  | { kind: "wait"; actor: string }
  | { kind: "mark"; actor: string }
  | { kind: "ability"; actor: string; ability_id: string; target_id?: string; target?: string; position?: "front" | "back" }
  | { kind: "monster_act" }
  | { kind: "use_item"; actor: string; item_id: number; target_id?: string };


interface OutcomeSummary {
  status: "victory" | "defeat";
  rewards: Array<{ user_id: string; xp_awarded: number; gold_awarded: number; level_up: boolean; new_level: number; loot: Array<{ item_name: string; rarity: string }>; soft_death: { gold_lost: number } | null }>;
  monster_name: string;
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
  const row = (content: React.ReactNode, tone: LogEntry["tone"], detail?: string, side?: LogEntry["side"]): LogEntry => ({ id: nextLogId++, content, tone, detail, side: side ?? null });
  const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
  switch (e.type) {
    case "begin": return row("Combat begins — rolling initiative…", "info");
    case "turn_start": {
      const actorId = String(e.actor ?? "");
      const dividerSide: "party" | "enemy" = isMonsterActor(actorId) ? "enemy" : "party";
      return {
        id: nextLogId++,
        content: `${nameOf(actorId)} — round ${e.round}`,
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

function PartyBar({ fighters, selfId, party, onClickSelf, flashIds, hitDustSeq, healBurstSeq, shieldBurstSeq }: {
  fighters: Fighter[] | null; selfId: string; party: Character[];
  onClickSelf?: () => void;
  flashIds?: Set<string>;
  hitDustSeq?: Record<string, number>;
  healBurstSeq?: Record<string, number>;
  shieldBurstSeq?: Record<string, number>;
}) {
  const seen = new Set<string>();
  type Member = {
    key: string; name: string; cls: string; level: number;
    position: "front" | "back";
    hp: number; max_hp: number; mana: number; max_mana: number;
    shield: number; armor_power: number;
    isSelf: boolean; isDead: boolean;
    effects: StatusEffect[];
  };
  const members: Member[] = fighters
    ? fighters.map((f) => ({
        key: f.id, name: f.name, cls: f.class, level: f.level, position: f.position,
        hp: f.hp, max_hp: f.max_hp, mana: f.mana, max_mana: f.max_mana,
        shield: f.shield, armor_power: f.armor_power,
        isSelf: f.id === selfId, isDead: f.hp <= 0,
        effects: f.effects ?? [],
      }))
    : party.flatMap((c) => {
        if (seen.has(c.slack_user_id)) return [];
        seen.add(c.slack_user_id);
        return [{
          key: c.slack_user_id, name: c.name, cls: c.class, level: c.level, position: c.position,
          hp: c.hp, max_hp: c.max_hp, mana: c.mana, max_mana: c.max_mana,
          shield: c.shield, armor_power: c.armor_power ?? 0,
          isSelf: c.slack_user_id === selfId, isDead: c.hp <= 0,
          effects: [], // REST party data doesn't carry effects — only the WS state does
        }];
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
        <HitDust seq={hitDustSeq?.[f.key] ?? 0} />
        <HealBurst seq={healBurstSeq?.[f.key] ?? 0} />
        <ShieldBurst seq={shieldBurstSeq?.[f.key] ?? 0} />
        {f.shield > Math.floor(f.armor_power / 2) && !f.isDead && <ShieldGlow />}
        <Avatar src={charPortraitUrl(f.name)} fallbackSrc={classPortraitUrl(f.cls)} alt={f.name} size={56} radius={6} fallbackIcon="player" fallbackColor="#4a5568" border="1px solid #2a2d33" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", paddingRight: 30 }}>{f.name}</div>
          <HpBar current={f.hp} max={f.max_hp} height={7} />
          {(() => { const armorMax = f.armor_power > 0 ? Math.floor(f.armor_power / 2) : f.shield; return (armorMax > 0 || f.shield > 0) ? <div style={{ height: 4, background: f.shield === 0 ? "#3b1515" : "#0e0f12", borderRadius: 2, overflow: "hidden", marginTop: 2 }} title={f.shield === 0 ? "Armor depleted" : `Armor: ${f.shield}/${armorMax}`}><div style={{ width: `${armorMax > 0 ? Math.min(1, f.shield / armorMax) * 100 : 100}%`, height: "100%", background: "#6b7280", transition: "width 0.3s ease" }} /></div> : null; })()}
          <div style={{ fontSize: 11, color: "#9aa0a6", marginTop: 2 }}>
            {f.hp}/{f.max_hp} HP
          </div>
          <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
            {Array.from({ length: f.max_mana }, (_, mi) => (
              <div key={mi} style={{ width: 9, height: 9, borderRadius: "50%", background: mi < f.mana ? "#818cf8" : "#1e2028", border: "1px solid #3a3d43" }} />
            ))}
          </div>
          {/* Status effect pills — shared EFFECT_PILLS from CombatShared.
              Empty for legacy REST party-data fighters since /api/quest/active
              doesn't expose effects. */}
          {f.effects.length > 0 && (
            <div style={{ display: "flex", gap: 4, marginTop: 5, flexWrap: "wrap" }}>
              {f.effects.map((e, i) => {
                const def = EFFECT_PILLS[e.type];
                return def ? <def.pill key={i} effect={e} size="sm" /> : null;
              })}
            </div>
          )}
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
function MonsterCard({ monster, isBoss, isHit, lungeTick, slashTick, dustSeq, isMarked, isTargeted, size, onClick }: {
  monster: Monster;
  isBoss: boolean;
  isHit: boolean;
  // Re-mounts the card on bump so the lunge keyframe re-fires.
  lungeTick: number;
  // Re-mounts the slash streak on bump (when this card was the hit target).
  slashTick: number;
  // Per-card dust burst counter. Bumps trigger a HitDust puff.
  dustSeq: number;
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
  // Only put hit-flash and lunge on the outer card. The targeted pulse goes
  // on a separate inner overlay so its `animation` declaration can never
  // override the lunge animation (both would be single-class rules competing
  // on the same element — last rule in the stylesheet wins).
  const classes = [
    isHit && !isDead ? "gq-hit-flash" : null,
    !isDead ? "gq-monster-lunge-card" : "gq-monster-defeated-card",
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
        boxShadow: isBoss && !isDead ? "0 0 32px rgba(239,68,68,0.3)" : "0 4px 24px rgba(0,0,0,0.6)",
        cursor: onClick && !isDead ? "pointer" : "default",
        transition: "border-color 0.15s",
        flexShrink: 0,
      }}
    >
      {/* Target-pulse overlay — lives on its own element so its animation
          never clashes with the card-level lunge/hit-flash animations. */}
      {isTargeted && !isDead && (
        <div className="gq-monster-targeted" style={{ position: "absolute", inset: 0, borderRadius: 11, pointerEvents: "none" }} />
      )}
      {monster.art_url
        ? <img src={monster.art_url} alt={monster.name} style={{ width: "100%", height: artHeight, objectFit: "cover", borderRadius: 8, marginBottom: 8, display: "block" }} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        : (
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: artHeight, marginBottom: 8 }}>
            <Icon name="dragon" size={isPrimary ? 72 : 52} color={isBoss ? "#fca5a5" : "#7c2020"} />
          </div>
        )
      }
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div style={{ fontFamily: DISPLAY_FONT, fontSize: nameFontSize, fontWeight: 700, color: isBoss ? "#fca5a5" : "#f5f5f5", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{monster.name}</div>
        <div style={{ fontSize: 11, color: "#9aa0a6", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{Math.max(0, monster.hp)} / {monster.max_hp}</div>
      </div>
      {/* Damage-type / element pills — mirror the standard quest MonsterCard
          so dungeon enemies surface the same threat info (fire attacks
          bypass armor, etc.) instead of looking visually identical to a
          plain physical mob. */}
      {((monster.attack_damage_type && monster.attack_damage_type !== "physical") || monster.element_weakness || monster.element_resistance) && !isDead && (
        <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
          {monster.attack_damage_type && monster.attack_damage_type !== "physical" && (() => {
            const t = monster.attack_damage_type;
            const icon = t === "fire" ? "🔥" : t === "ice" ? "❄️" : t === "lightning" ? "⚡" : "✨";
            const color = t === "fire" ? "#fb923c" : t === "ice" ? "#7dd3fc" : t === "lightning" ? "#fde047" : "#c084fc";
            return (
              <span
                title={`Attacks deal ${t} damage — bypasses armor pool`}
                style={{
                  fontSize: 9, fontWeight: 700, background: color + "33",
                  border: `1px solid ${color}66`, color, borderRadius: 4,
                  padding: "1px 5px", textTransform: "uppercase", letterSpacing: 0.4,
                }}
              >
                {icon} {t}
              </span>
            );
          })()}
          {monster.element_weakness && (
            <span style={{ fontSize: 9, background: "#7f1d1d33", border: "1px solid #f8717166", color: "#fca5a5", borderRadius: 4, padding: "1px 5px", fontWeight: 700, letterSpacing: 0.3 }}>
              {monster.element_weakness === "fire" ? "🔥" : monster.element_weakness === "ice" ? "❄️" : "⚡"} weak
            </span>
          )}
          {monster.element_resistance && (
            <span style={{ fontSize: 9, background: "#1e3a5f33", border: "1px solid #60a5fa66", color: "#93c5fd", borderRadius: 4, padding: "1px 5px", fontWeight: 700, letterSpacing: 0.3 }}>
              {monster.element_resistance === "fire" ? "🔥" : monster.element_resistance === "ice" ? "❄️" : "⚡"} resist
            </span>
          )}
        </div>
      )}
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
      {/* Cartoony dust puff on landed hits. Shares the HitDust component
          with the fighter cards so monsters and players get matching VFX. */}
      <HitDust seq={dustSeq} />
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
        <div style={{ position: "absolute", top: 6, right: 6, display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end", zIndex: 9 }}>
          {monster.effects.map((e, i) => {
            const def = EFFECT_PILLS[e.type];
            return def ? <def.pill key={i} effect={e} size="md" /> : null;
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
function MonsterStrip({ monsters, flashIds, lastSlash, lastLunge, markedMonsterId, targetMonsterId, hitDustSeq, onTarget }: {
  monsters: Monster[];
  flashIds: Set<string>;
  // Most-recent slash event — id of the hit monster + a monotonic seq.
  // The MonsterCard with the matching id re-keys its slash element so
  // the animation fires only on the actual target.
  lastSlash: { id: string; seq: number } | null;
  lastLunge: { id: string; seq: number } | null;
  markedMonsterId: string | null;
  targetMonsterId: string | null;
  // Per-id dust counter shared with PartyBar. Bumped from flashHit() so
  // monsters and fighters both get cartoony puffs on hit.
  hitDustSeq?: Record<string, number>;
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
            dustSeq={hitDustSeq?.[id] ?? 0}
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
  const [devOpen, setDevOpen] = useState(false);
  const [wsReconnectKey, setWsReconnectKey] = useState(0);
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
  // Floating animated dice — incoming `roll` events spawn dice that tumble
  // and settle to the rolled value, then fade after ~10s.
  const [diceRolls, setDiceRolls] = useState<DiceRollEntry[]>([]);
  const diceRollCounterRef = useRef(0);
  // Per-fighter dust counter. Bumped from flashHit so every flash also
  // spawns a fresh dust puff on the affected card. Monsters get flashed
  // too but the dust is purely a player-side affordance (the strip is
  // already busy with slash streaks + lunge animations).
  const [hitDustSeq, setHitDustSeq] = useState<Record<string, number>>({});
  const [healBurstSeq, setHealBurstSeq] = useState<Record<string, number>>({});
  const [shieldBurstSeq, setShieldBurstSeq] = useState<Record<string, number>>({});
  function flashHit(id: string) {
    setFlashIds((prev) => { const n = new Set(prev); n.add(id); return n; });
    setTimeout(() => {
      setFlashIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
    }, 600);
    setHitDustSeq((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
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
              triggerBurst("hit");
            }
            // monster_attack: monster hits a fighter. Always lunge the
            // attacking monster's card (the swing happened regardless of
            // damage). Flash the fighter only when hp_damage > 0.
            if (evt.type === "monster_attack" && typeof evt.actor === "string") {
              setLastLunge({ id: evt.actor, seq: ++animSeqRef.current });
            }
            if (evt.type === "monster_attack" && typeof evt.target === "string" && (evt.hp_damage as number) > 0) {
              flashHit(evt.target as string);
              triggerBurst("hit");
            }
            // Elemental procs: player → monster (elemental_proc) and
            // monster → fighter (monster_elemental_proc). Burst the
            // matching element so the player sees the spell land.
            if (evt.type === "elemental_proc" && !evt.resisted) {
              const el = String(evt.element);
              if (el === "fire" || el === "ice" || el === "lightning") triggerBurst(el);
            }
            if (evt.type === "monster_elemental_proc") {
              const el = String(evt.element);
              if (el === "fire" || el === "ice" || el === "lightning") triggerBurst(el);
            }
            if (evt.type === "heal_applied" && typeof (evt as { target?: string }).target === "string") {
              const tgt = (evt as unknown as { target: string }).target;
              setHealBurstSeq((prev) => ({ ...prev, [tgt]: (prev[tgt] ?? 0) + 1 }));
            }
            if (evt.type === "shield_applied" && typeof (evt as { target?: string }).target === "string") {
              const tgt = (evt as unknown as { target: string }).target;
              setShieldBurstSeq((prev) => ({ ...prev, [tgt]: (prev[tgt] ?? 0) + 1 }));
            }
            if (evt.type === "turn_skip") triggerBurst("frozen");
            if (evt.type === "victory") triggerBurst("victory");
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
  }, [questId, wsReconnectKey]);

  // Auto-resolve monster and merc turns
  const stateForAuto = ws.state;
  useEffect(() => {
    if (!stateForAuto || stateForAuto.status !== "active") return;
    const actorId = stateForAuto.turn_order[stateForAuto.turn_index % stateForAuto.turn_order.length];
    const isNonPlayer = isMonsterActor(actorId) || isMercActor(actorId);
    if (!isNonPlayer) return;
    if (isMonsterActor(actorId) && !autoResolveRef.current) return;
    if (autoResolvedTurnRef.current === stateForAuto.turn_index) return;
    const action = isMercActor(actorId) ? { kind: "merc_act" as const } : { kind: "monster_act" as const };
    const t = setTimeout(() => {
      if (isMonsterActor(actorId) && !autoResolveRef.current) return;
      const fired = send(action);
      if (fired) autoResolvedTurnRef.current = stateForAuto.turn_index;
    }, 800);
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
          {import.meta.env.DEV && (
            <button
              onClick={() => setDevOpen(true)}
              style={{ background: "none", border: "1px solid #2a2d44", color: "#a78bfa", cursor: "pointer", fontSize: 11, padding: "2px 7px", borderRadius: 5, display: "flex", alignItems: "center", gap: 4, fontFamily: "inherit" }}
            >
              <Icon name="cog" size={11} /> dev
            </button>
          )}
          {combatActive && <span style={{ fontSize: 11, color: ws.connection === "open" ? "#39ff14" : "#9aa0a6" }}>{ws.connection === "open" ? "● live" : "○ …"}</span>}
          <span style={{ fontSize: 11, color: "#9aa0a6" }}>
            <Icon name="key" size={10} color="#b45309" /> {character.keys_bronze}
            <Icon name="key" size={10} color="#d1d5db" style={{ marginLeft: 4 }} /> {character.keys_silver}
            <Icon name="key" size={10} color="#fbbf24" style={{ marginLeft: 4 }} /> {character.keys_gold}
          </span>
        </div>
      </div>

      {devOpen && import.meta.env.DEV && (
        <CombatDevModal
          questId={questId}
          onClose={() => setDevOpen(false)}
          onDone={() => { setDevOpen(false); setWsReconnectKey((k) => k + 1); }}
        />
      )}

      {/* Room view */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden", minHeight: 0, background: "#1c1f2e" }}>
        <img src={bgUrl} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to bottom, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.05) 40%, rgba(0,0,0,0.55) 100%)", pointerEvents: "none" }} />

        {/* Floating initiative strip (combat only) — top center overlay */}
        {combatActive && combatState && (
          <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: 8 }}>
            <InitStrip turnOrder={combatState.turn_order} turnIndex={combatState.turn_index} round={combatState.round} selfId={selfId} fighters={combatState.fighters} monsters={combatState.monsters} />
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
              hitDustSeq={hitDustSeq}
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
                <CombatLog log={ws.log} scrollRef={logScrollRef} />
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
          selfId={selfId}
          characterClass={character.class}
        />
      )}

      {/* Party bar (BLUE area) — its own row above the action buttons. */}
      <PartyBar
        fighters={combatActive ? (combatState?.fighters ?? null) : null}
        selfId={selfId}
        party={party.length > 0 ? party : [character]}
        onClickSelf={onOpenInventory}
        flashIds={flashIds}
        hitDustSeq={hitDustSeq}
        healBurstSeq={healBurstSeq}
        shieldBurstSeq={shieldBurstSeq}
      />

      {/* Action buttons row (RED area) — own row at the very bottom. Always
          rendered while combat is active so the player never sees an empty
          bottom bar; falls back to a connecting/loading state if the WS
          hasn't seeded combatState yet. */}
      {combatActive && !combatEnded && (
        combatState ? (
          <CombatPanel
            state={combatState as unknown as PanelCombatState}
            selfId={selfId}
            onSend={send as (a: PanelTurnAction) => boolean}
            autoResolve={autoResolve}
            setAutoResolve={setAutoResolve}
            myTurn={myTurn}
            isMonsterTurn={isMonsterTurn}
            items={items as unknown as CombatItem[]}
            onRefreshItems={loadItems}
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
      <div style={{ position: "fixed", bottom: 280, left: "50%", transform: "translateX(-50%)", zIndex: 200, pointerEvents: "none" }}>
        <DiceRollDisplay rolls={diceRolls} />
      </div>

      {/* Particle bursts — fire/ice/lightning/hit/frozen/victory. Fixed
          overlay so bursts can appear regardless of which inner view
          (combat, dungeon nav) is mounted. */}
      <div style={{ position: "fixed", inset: 0, zIndex: 150, pointerEvents: "none" }}>
        <CombatParticles />
      </div>
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
            <Icon name="dragon" size={64} color={borderColor} />
            <Icon name="dragon" size={64} color={borderColor} />
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <div style={{ fontFamily: DISPLAY_FONT, fontSize: 15, fontWeight: 700, color: isBoss ? "#fca5a5" : "#f5f5f5" }}>
            {isBoss && <Icon name="dragon" size={13} color="#fca5a5" />} {m.name}
            {isBoss && <Icon name="dragon" size={13} color="#fca5a5" />} {m.name}
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

function ContentOverlay({ node, content, onEnterCombat, onTakeLoot, onTakeKey, onRefresh, questId, selfId, characterClass }: {
  node: GridNode; content: GridRoomContent | undefined;
  onEnterCombat: () => void; onTakeLoot: (idx: number) => void; onTakeKey: () => void;
  onRefresh: () => void; questId: number;
  selfId: string;
  // Used to gate the Sage's Foresee preview on the closed-chest panel.
  // Only the sage class id ("staff_sage") sees chest contents before
  // the key is spent.
  characterClass: string;
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
            {isBoss && <Icon name="dragon" size={14} color="#fca5a5" />} {m.name}
            {isBoss && <Icon name="dragon" size={14} color="#fca5a5" />} {m.name}
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
    // Legacy lockboxes from before two-step flow (no `opened` field) keep
    // using the original single-pick UI for backwards compat.
    const isLegacy = c.opened === undefined;
    const claims = c.claims ?? {};
    const isSage = characterClass === "staff_sage";

    if (isLegacy) {
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

    // CLOSED chest — show locked panel + Open button. Sage gets a foresee
    // preview; everyone else sees just a count of mystery slots.
    if (!c.opened) {
      return (
        <OverlayPanel title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Icon name="key" color={tierColor} size={14} /> Locked chest — needs {tier} key
          </span>
        }>
          <p style={{ fontSize: 13, color: "#9aa0a6", margin: "0 0 12px", fontStyle: "italic" }}>
            A chest sits sealed. {c.options.length} item{c.options.length === 1 ? "" : "s"} await within. Spend a {tier} key to open — your whole party can claim from the contents.
          </p>
          <button
            onClick={async () => {
              const res = await fetch(`/api/quest/${questId}/dungeon/grid/lockbox/open`, {
                method: "POST", credentials: "include",
              });
              if (res.ok) { toast.success("Chest opened"); onRefresh(); }
              else { const b = await res.json().catch(() => ({})) as { error?: string }; toast.error(b.error === "no_key" ? `No ${tier} key` : "Could not open"); }
            }}
            style={{ padding: "10px 18px", background: tierColor + "22", border: `1.5px solid ${tierColor}`, borderRadius: 8, color: tierColor, cursor: "pointer", fontSize: 13, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 8 }}>
            <Icon name="key" color={tierColor} size={14} /> Open with {tier} key
          </button>
          {isSage && (
            <div style={{ marginTop: 14, padding: "10px 12px", background: "#1c1c2a", borderRadius: 8, border: "1px dashed #6366f1" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#a5b4fc", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
                <Icon name="crystal-ball" size={12} color="#a5b4fc" /> Sage's Foresee
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 6 }}>
                {c.options.map((opt, i) => (
                  <LootOptionTile key={i} opt={opt} disabled onClick={() => {}} />
                ))}
              </div>
              <div style={{ fontSize: 11, color: "#6b7280", fontStyle: "italic", marginTop: 6 }}>
                Your sight pierces the lid. Only you see this.
              </div>
            </div>
          )}
        </OverlayPanel>
      );
    }

    // OPEN chest — items claimable. Each option shows claimed-by badge if
    // taken. Auto-resolves server-side when all claimed.
    const remainingCount = c.options.filter((_, i) => !claims[String(i)]).length;
    return (
      <OverlayPanel title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Icon name="cubes" color={tierColor} size={14} /> Open chest — claim what you want
        </span>
      }>
        <p style={{ fontSize: 12, color: "#9aa0a6", margin: "0 0 10px" }}>
          Anyone in the party can claim. {remainingCount === 0 ? "All taken — close to continue." : `${remainingCount} item${remainingCount === 1 ? "" : "s"} left.`}
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
          {c.options.map((opt, i) => {
            const claimer = claims[String(i)];
            const claimedByMe = claimer === selfId;
            const claimedByOther = !!claimer && !claimedByMe;
            return (
              <div key={i} style={{ position: "relative" }}>
                <LootOptionTile
                  opt={opt}
                  disabled={!!claimer}
                  onClick={async () => {
                    if (claimer) return;
                    const res = await fetch(`/api/quest/${questId}/dungeon/grid/lockbox/claim`, {
                      method: "POST", credentials: "include",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ pick: i + 1 }),
                    });
                    if (res.ok) { toast.success(`Claimed ${opt.name}`); onRefresh(); }
                    else { const b = await res.json().catch(() => ({})) as { error?: string }; toast.error(b.error ?? "Could not claim"); }
                  }}
                />
                {claimer && (
                  <div style={{
                    position: "absolute", top: 6, right: 6,
                    fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
                    padding: "2px 6px", borderRadius: 4,
                    background: claimedByMe ? "#16a34a99" : "#37415199",
                    color: claimedByMe ? "#dcfce7" : "#cbd5e1",
                    border: `1px solid ${claimedByMe ? "#22c55e" : "#475569"}`,
                  }}>
                    {claimedByMe ? "you" : "claimed"}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
          <button
            onClick={async () => {
              const res = await fetch(`/api/quest/${questId}/dungeon/grid/lockbox/close`, {
                method: "POST", credentials: "include",
              });
              if (res.ok) { onRefresh(); }
              else { toast.error("Could not close"); }
            }}
            style={{ padding: "6px 14px", background: "#1f2937", border: "1px solid #374151", borderRadius: 6, color: "#cbd5e1", cursor: "pointer", fontSize: 12 }}>
            {remainingCount === 0 ? "Continue" : "Close chest"}
          </button>
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
  level_req?: number;
  rarity?: string;
  flavor?: string | null;
  slot?: string | null;
  stat_bonus?: Record<string, number> | null;
  weapon_range?: "melee" | "ranged" | "focus" | null;
  item_subtype?: string | null;
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
        <Icon name={lootIcon({ ...opt, item_name: opt.name })} size={18} color={tint} />
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
