// Floating callout balloon that hangs off a pawn on the hex grid.
//
// Compact:  rounded-square avatar (character or monster art) + name + a
//           segmented HP/shield bar matching the rest of the design system.
// Expanded: same header but with class + level (or tier) and a thicker
//           HP/shield bar, plus mana for fighters and status pills.
//
// Auto-expanded when the actor is the current turn. Otherwise expanded on
// hover. Position is computed from screen coords by the parent and clamped
// to stay inside the canvas bounds.

import type { CSSProperties } from "react";

import { EFFECT_META, type EffectType } from "@gantt-quest/core";

import { Avatar, Icon } from "./icons";
import { charPortraitUrl, classPortraitUrl } from "./CombatShared";

export interface PawnLike {
  id: string;
  name: string;
  hp: number;
  max_hp: number;
  // Filled differently for fighters vs monsters.
  mana?: number;
  max_mana?: number;
  class?: string;
  level?: number;
  tier?: number;
  is_boss?: boolean;
  shield?: number;
  // Equipped armor power — used to compute armor_max (floor(armor_power / 2))
  // for the segmented HP+shield bar.
  armor_power?: number;
  // Monster-only: AI portrait URL from Flux generation.
  art_url?: string | null;
  effects?: { type: EffectType; magnitude: number; remaining: number }[];
}

export interface PawnCalloutProps {
  // Screen-space anchor (the center of the pawn on the canvas).
  anchorX: number;
  anchorY: number;
  // The actor — either a Fighter or a Monster.
  pawn: PawnLike;
  // "fighter" | "monster" controls color theming.
  side: "fighter" | "monster";
  // Class color or monster ring color used for the border accent.
  themeColor: string;
  // Whether to render the expanded card or just the compact chip.
  expanded: boolean;
  // Set when this pawn IS the local user.
  isSelf?: boolean;
  // Set when this pawn IS the current turn's actor.
  isCurrent?: boolean;
  // The size of the pawn (used to offset the callout above it).
  pawnRadius: number;
  // Direction to flip: defaults to "above". Set "below" when the pawn is in
  // the top row of the grid (no headroom).
  direction?: "above" | "below";
  // Container width — for horizontal clamping so callouts don't clip.
  containerWidth: number;
  // Pass-through mouse handlers.
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onClick?: () => void;
}

const COMPACT_WIDTH = 150;
const EXPANDED_WIDTH = 220;
const GAP = 10;
const AVATAR_COMPACT = 30;
const AVATAR_EXPANDED = 44;

export function PawnCallout({
  anchorX,
  anchorY,
  pawn,
  side,
  themeColor,
  expanded,
  isSelf,
  isCurrent,
  pawnRadius,
  direction = "above",
  containerWidth,
  onMouseEnter,
  onMouseLeave,
  onClick,
}: PawnCalloutProps) {
  const downed = pawn.hp <= 0;
  if (downed) {
    return (
      <DownedChip
        anchorX={anchorX}
        anchorY={anchorY - pawnRadius - GAP}
        name={pawn.name}
      />
    );
  }

  const width = expanded ? EXPANDED_WIDTH : COMPACT_WIDTH;
  // Horizontal clamping: keep the callout inside the container.
  let left = anchorX - width / 2;
  if (left < 4) left = 4;
  if (left + width > containerWidth - 4) left = containerWidth - 4 - width;

  // Vertical: above pawn by default; flip below if in top row.
  const calloutHeight = expanded ? 96 : 42;
  const top = direction === "above"
    ? anchorY - pawnRadius - GAP - calloutHeight
    : anchorY + pawnRadius + GAP;

  const borderColor =
    isCurrent ? "#facc15"
    : side === "fighter" ? themeColor
    : "#dc2626";

  const baseStyle: CSSProperties = {
    position: "absolute",
    left,
    top,
    width,
    background: "rgba(15, 23, 42, 0.94)",
    border: `1px solid ${borderColor}`,
    borderRadius: 8,
    color: "#e5e7eb",
    fontSize: 11,
    pointerEvents: "auto",
    cursor: onClick ? "pointer" : "default",
    zIndex: isCurrent ? 30 : expanded ? 25 : 20,
    backdropFilter: "blur(6px)",
    // Match the canvas pawn tween (PAWN_TWEEN_MS=280) so the callout slides
    // in sync with its pawn. cubic-bezier mimics easeOutCubic used on canvas.
    transition: "top 280ms cubic-bezier(0.33, 1, 0.68, 1), left 280ms cubic-bezier(0.33, 1, 0.68, 1), width 140ms ease",
    boxShadow: isCurrent ? "0 0 12px rgba(250, 204, 21, 0.45)" : "0 2px 8px rgba(0,0,0,0.5)",
    boxSizing: "border-box",
    padding: 6,
    display: "flex",
    flexDirection: "column",
    gap: 6,
  };

  // Avatar source resolution.
  const avatarSrc =
    side === "fighter"
      ? charPortraitUrl(pawn.name)
      : pawn.art_url ?? null;
  const avatarFallback =
    side === "fighter" && pawn.class
      ? classPortraitUrl(pawn.class)
      : null;
  const avatarSize = expanded ? AVATAR_EXPANDED : AVATAR_COMPACT;

  return (
    <div
      style={baseStyle}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
      data-pawn-callout={pawn.id}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <Avatar
          src={avatarSrc}
          fallbackSrc={avatarFallback}
          alt={pawn.name}
          size={avatarSize}
          radius={6}
          fallbackIcon={side === "fighter" ? "player" : "dragon"}
          fallbackColor={side === "fighter" ? "#3a4150" : "#5a1f1f"}
          border={`1px solid ${borderColor}`}
        />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontWeight: 700, fontSize: expanded ? 13 : 11, lineHeight: 1.15, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={pawn.name}>
              {pawn.name}
            </span>
            {isSelf && <span style={badgeStyle("#1f2a3a", "#7dd3fc")}>YOU</span>}
            {pawn.is_boss && <span style={badgeStyle("#3a1f1f", "#fbbf24")}>BOSS</span>}
          </div>
          <div style={{ fontSize: 9, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {side === "fighter"
              ? `${pawn.class ?? "—"} · L${pawn.level ?? 1}`
              : `Tier ${pawn.tier ?? 1}`}
          </div>
        </div>
      </div>

      <SegmentedHpBar
        hp={pawn.hp}
        maxHp={pawn.max_hp}
        shield={pawn.shield ?? 0}
        armorPower={pawn.armor_power ?? 0}
        height={expanded ? 10 : 7}
      />

      {side === "fighter" && pawn.max_mana != null && pawn.max_mana > 0 && (
        <ManaBar value={pawn.mana ?? 0} max={pawn.max_mana} height={expanded ? 5 : 4} />
      )}

      {expanded && pawn.effects && pawn.effects.length > 0 && (
        <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
          {pawn.effects.slice(0, 6).map((e, i) => (
            <span key={i} style={effectPill(e.type)} title={effectTooltipText(e.type, e.magnitude, e.remaining)}>
              {EFFECT_DESCRIPTIONS[e.type]?.label ?? e.type}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Docked pawn card ────────────────────────────────────────────────────────
//
// A non-floating variant of PawnCallout meant to live in a fixed dock below
// the canvas. Same content/visual language as the expanded callout, just
// without the absolute positioning that obscured the battlefield.

export interface DockedPawnCardProps {
  pawn: PawnLike;
  side: "fighter" | "monster";
  themeColor: string;
  isSelf?: boolean;
  isCurrent?: boolean;
  /** When true, the user has explicitly pinned this pawn (vs just hovering). */
  pinned?: boolean;
  /** Called when the user clicks the unpin button. */
  onUnpin?: () => void;
  /** Called when the user clicks the card body — opens the full sheet. */
  onOpenSheet?: () => void;
}

export function DockedPawnCard({
  pawn, side, themeColor, isSelf, isCurrent, pinned, onUnpin, onOpenSheet,
}: DockedPawnCardProps) {
  const downed = pawn.hp <= 0;
  if (downed) return null;

  const borderColor =
    isCurrent ? "#facc15"
    : side === "fighter" ? themeColor
    : "#dc2626";

  const avatarSrc =
    side === "fighter"
      ? charPortraitUrl(pawn.name)
      : pawn.art_url ?? null;
  const avatarFallback =
    side === "fighter" && pawn.class
      ? classPortraitUrl(pawn.class)
      : null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        gap: 10,
        padding: 8,
        background: "rgba(15, 23, 42, 0.94)",
        border: `1px solid ${borderColor}`,
        borderRadius: 8,
        boxShadow: isCurrent ? "0 0 12px rgba(250, 204, 21, 0.45)" : "0 2px 8px rgba(0,0,0,0.55)",
        backdropFilter: "blur(6px)",
        color: "#e5e7eb",
        fontSize: 12,
        minWidth: 240,
        maxWidth: 420,
        boxSizing: "border-box",
        cursor: onOpenSheet ? "pointer" : "default",
        transition: "transform 120ms ease",
      }}
      onClick={onOpenSheet ? () => onOpenSheet() : undefined}
      title={onOpenSheet ? "Click to open the character sheet" : undefined}
      data-docked-pawn={pawn.id}
    >
      <Avatar
        src={avatarSrc}
        fallbackSrc={avatarFallback}
        alt={pawn.name}
        size={48}
        radius={6}
        fallbackIcon={side === "fighter" ? "player" : "dragon"}
        fallbackColor={side === "fighter" ? "#3a4150" : "#5a1f1f"}
        border={`1px solid ${borderColor}`}
      />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontWeight: 700, fontSize: 14, lineHeight: 1.15, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={pawn.name}>
            {pawn.name}
          </span>
          {isSelf && <span style={badgeStyle("#1f2a3a", "#7dd3fc")}>YOU</span>}
          {pawn.is_boss && <span style={badgeStyle("#3a1f1f", "#fbbf24")}>BOSS</span>}
          {isCurrent && <span style={badgeStyle("#3a3a1f", "#facc15")}>TURN</span>}
          <span style={{ flex: 1 }} />
          {pinned && onUnpin && (
            <button
              onClick={(e) => { e.stopPropagation(); onUnpin?.(); }}
              style={{
                background: "rgba(71, 85, 105, 0.6)",
                border: "1px solid rgba(148, 163, 184, 0.4)",
                color: "#e5e7eb",
                fontSize: 10,
                padding: "1px 6px",
                borderRadius: 4,
                cursor: "pointer",
              }}
              title="Unpin (click pawn or press Esc)"
            >
              ✕
            </button>
          )}
        </div>
        <div style={{ fontSize: 10, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.4 }}>
          {side === "fighter"
            ? `${pawn.class ?? "—"} · L${pawn.level ?? 1}`
            : `Tier ${pawn.tier ?? 1}`}
        </div>
        <SegmentedHpBar
          hp={pawn.hp}
          maxHp={pawn.max_hp}
          shield={pawn.shield ?? 0}
          armorPower={pawn.armor_power ?? 0}
          height={10}
        />
        {side === "fighter" && pawn.max_mana != null && pawn.max_mana > 0 && (
          <ManaBar value={pawn.mana ?? 0} max={pawn.max_mana} height={6} />
        )}
        {pawn.effects && pawn.effects.length > 0 && (
          <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
            {pawn.effects.slice(0, 8).map((e, i) => (
              <span key={i} style={effectPill(e.type)} title={effectTooltipText(e.type, e.magnitude, e.remaining)}>
                {EFFECT_DESCRIPTIONS[e.type]?.label ?? e.type}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Bars ─────────────────────────────────────────────────────────────────────

// Mirrors apps/web/src/CombatPage.tsx#FighterHpRow — HP segment on the left,
// shield/armor segment on the right (only when armor_power > 0).
function SegmentedHpBar({
  hp,
  maxHp,
  shield,
  armorPower,
  height,
}: {
  hp: number;
  maxHp: number;
  shield: number;
  armorPower: number;
  height: number;
}) {
  const armorMax = Math.floor(armorPower / 2);
  const total = maxHp + armorMax;
  const hpFrac = maxHp > 0 ? hp / maxHp : 0;
  const hpCol = hpFrac < 0.25 ? "#dc2626" : hpFrac < 0.5 ? "#d97706" : "#16a34a";
  const hpWidth = total > 0 ? (hp / total) * 100 : 0;
  const shieldStart = total > 0 ? (maxHp / total) * 100 : 100;
  const shieldWidth = total > 0 ? (shield / total) * 100 : 0;
  const hasShield = armorMax > 0 && shield > 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div
        style={{
          flex: 1,
          position: "relative",
          height,
          background: "#0e0f12",
          borderRadius: height / 2,
          overflow: "hidden",
          boxShadow: hasShield ? "0 0 5px rgba(96,165,250,.45)" : "none",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0, top: 0, bottom: 0,
            width: `${hpWidth}%`,
            background: hpCol,
            transition: "width 300ms ease",
          }}
        />
        {hasShield && (
          <div
            style={{
              position: "absolute",
              top: 0, bottom: 0,
              left: `${shieldStart}%`,
              width: `${shieldWidth}%`,
              background: "repeating-linear-gradient(45deg,#93c5fd,#93c5fd 4px,#60a5fa 4px,#60a5fa 8px)",
              transition: "width 300ms ease",
            }}
          />
        )}
      </div>
      <div style={{ fontSize: 10, color: "#cbd5e1", minWidth: 36, textAlign: "right", fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
        <div>{hp}/{maxHp}</div>
        {armorMax > 0 && (
          <div style={{ fontSize: 9, color: shield === 0 ? "#ef4444" : "#7dd3fc", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 2, marginTop: 1 }}>
            <Icon name="shield" size={8} color={shield === 0 ? "#ef4444" : "#7dd3fc"} />
            {shield}/{armorMax}
          </div>
        )}
      </div>
    </div>
  );
}

function ManaBar({ value, max, height = 5 }: { value: number; max: number; height?: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ flex: 1, height, background: "#0e0f12", borderRadius: height / 2, overflow: "hidden" }}>
        <div style={{ width: `${pct * 100}%`, height: "100%", background: "#8b5cf6", transition: "width 240ms ease" }} />
      </div>
      <span style={{ fontSize: 9, color: "#a78bfa", minWidth: 28, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {value}/{max}
      </span>
    </div>
  );
}

function DownedChip({ anchorX, anchorY, name }: { anchorX: number; anchorY: number; name: string }) {
  return (
    <div
      style={{
        position: "absolute",
        left: anchorX - 50,
        top: anchorY - 16,
        width: 100,
        textAlign: "center",
        background: "rgba(127, 29, 29, 0.85)",
        color: "#fecaca",
        border: "1px solid rgba(252,165,165,0.4)",
        borderRadius: 4,
        fontSize: 9,
        padding: "2px 4px",
        fontWeight: 700,
        letterSpacing: 0.6,
        zIndex: 15,
        pointerEvents: "none",
      }}
      title={`${name} is downed`}
    >
      × DOWNED
    </div>
  );
}

function badgeStyle(bg: string, fg: string): CSSProperties {
  return {
    padding: "1px 5px",
    borderRadius: 3,
    background: bg,
    color: fg,
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  };
}

const EFFECT_COLOR: Partial<Record<EffectType, string>> = {
  burning: "#fb923c",
  frozen: "#7dd3fc",
  shocked: "#fbbf24",
  poisoned: "#84cc16",
  bleeding: "#dc2626",
  regen: "#22c55e",
  empowered: "#a78bfa",
  stunned: "#94a3b8",
  hexed: "#c084fc",
  entangled: "#65a30d",
  barkskin: "#84cc16",
  animal_form: "#22c55e",
};

// Player-facing copy for every effect the engine can apply. Used for chip
// tooltips on pawn cards and the status section of the character sheet so
// the player understands what each badge actually does mechanically.
// magnitude/remaining are interpolated in the formatter below.
// Display labels + descriptions for status chips and the sheet's effect
// section. Derived from EFFECT_META in @gantt-quest/core so the canonical
// names (Burning, Frozen, Shocked, Poisoned, Bleeding, Stunned/Containerized,
// Hexed, Entangled, Empowered, Barkskin, Animal Form, Regen) and blurbs
// from the engine package are the single source of truth — no risk of the
// UI drifting away from the engine's naming.
//
// A few "soft" event-driven chips (taunt, marked, vulnerable, foreseen,
// shield_of_faith, good_fortune) don't live in EffectType and are described
// here directly. They surface via separate event flows but still appear as
// chips on pawn cards.
export const EFFECT_DESCRIPTIONS: Record<string, { label: string; what: string }> = {
  ...Object.fromEntries(
    (Object.entries(EFFECT_META) as [EffectType, typeof EFFECT_META[EffectType]][]).map(
      ([key, meta]) => [key, { label: meta.name, what: meta.blurb }],
    ),
  ),
  // Event-driven chips that aren't part of EFFECT_META — described here.
  taunt:           { label: "Taunted",         what: "Must attack the taunter — can't pick other targets." },
  marked:          { label: "Marked",          what: "Allies deal +{mag} bonus damage to this target." },
  vulnerable:      { label: "Vulnerable",      what: "Takes +{mag} extra damage from the next hit." },
  foreseen:        { label: "Foreseen",        what: "Attack predicted by the Sage — defenders ready a counter." },
  shield_of_faith: { label: "Shield of Faith", what: "+{mag} shield while active." },
  good_fortune:    { label: "Good Fortune",    what: "Heals {mag} HP at end of turn." },
};

export function effectTooltipText(type: EffectType, magnitude: number, remaining: number): string {
  const d = EFFECT_DESCRIPTIONS[type];
  if (!d) return `${type} (${remaining}t)`;
  const what = d.what.replace("{mag}", String(magnitude));
  return `${d.label} · ${remaining}t left\n${what}`;
}

function effectPill(type: EffectType): CSSProperties {
  const c = EFFECT_COLOR[type] ?? "#94a3b8";
  return {
    // Wider padding + larger font so long engineering labels like
    // "Containerized" / "Firewalled" / "Auto-Heal" read without
    // truncation. Letter-spacing tightened a hair so longer words
    // don't push neighboring chips off the row.
    padding: "2px 7px",
    borderRadius: 4,
    background: "rgba(0,0,0,0.45)",
    border: `1px solid ${c}`,
    color: c,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0.2,
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  };
}
