import { forwardRef, useEffect, useState } from "react";
import type { CSSProperties, MouseEventHandler, HTMLAttributes, ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  FloatingFocusManager,
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
} from "@floating-ui/react";
import { findCatalogEntry, sellPriceFor, xpForLevel, type StatKey } from "@gantt-quest/core";
import { charPortraitUrl, classPortraitUrl } from "../CombatShared";
import { Icon } from "../icons";
import type {
  Character,
  EffectType,
  EquipSlot,
  InventorySort,
  Item,
  KnownCharacter,
} from "../types";
import {
  CATALOG_EFFECT,
  EFFECT_COLOR,
  EFFECT_ICON,
  RARITY_COLOR,
  SLOT_ICON,
  SLOT_LABELS,
} from "../constants";
import { DISPLAY_FONT, card, h2, muted, smallBadge, smallActionBtn } from "../styles";
import {
  describeItemEffect,
  itemIcon,
  itemIconColor,
  slotLabel,
  sortItems,
  statBonusSummary,
  resourceDisplayName,
} from "../utils";
import { Banner, RarityBadge } from "./ui";

// ── Unified item cell ─────────────────────────────────────────────────────
// mode="icon"     — fixed square, power badge circle       (InventoryCard)
// mode="compact"  — fixed square, icon + truncated name    (doll slots)
// mode="detailed" — auto-height, icon + full stats + price (pack grid)
type ItemCellMode = "icon" | "compact" | "detailed";

export const ItemCell = forwardRef<
  HTMLDivElement,
  {
    item: Item;
    size?: number;
    mode?: ItemCellMode;
    selected?: boolean;
    isOver?: boolean;
    isDragging?: boolean;
    isMatch?: boolean;
    showSellPrice?: boolean;
    characterLevel?: number;
    /** Client-side stack size for grouped pack items (consumables, scrolls,
        etc.). Renders a "×N" badge in the top-right corner when > 1. The
        cell still represents a single item id under the hood. */
    stackCount?: number;
    cursor?: CSSProperties["cursor"];
    /** Render the design-handoff rarity left-stripe (3px solid rarity color)
        instead of the uniform 2px border. Used on doll slots + bag tiles. */
    rarityStripe?: boolean;
    onClick?: MouseEventHandler<HTMLDivElement>;
  } & Omit<HTMLAttributes<HTMLDivElement>, "onClick">
>(function ItemCell(
  { item, size = 72, mode = "icon", selected, isOver, isDragging, isMatch,
    showSellPrice, characterLevel, stackCount, cursor, rarityStripe, onClick, style: extraStyle, ...rest },
  ref,
) {
  const rc = RARITY_COLOR[item.rarity];
  const borderColor = isOver ? "#7dd3fc"
    : selected ? "#fff"
    : item.equipped ? "#b89b3a"
    : isMatch ? "#c084fc"
    : `${rc}99`;
  // When rarityStripe is set, the left edge becomes a solid 3px rarity bar
  // while the other three sides keep the standard 2px state-aware border.
  const stripeBorder = rarityStripe
    ? {
        borderTop: `2px solid ${borderColor}`,
        borderRight: `2px solid ${borderColor}`,
        borderBottom: `2px solid ${borderColor}`,
        borderLeft: `3px solid ${rc}`,
      }
    : { border: `2px solid ${borderColor}` };
  const iconSize = mode === "detailed" ? 40 : mode === "compact" ? 38 : 28;
  const elementEmoji = item.element === "fire" ? "🔥" : item.element === "ice" ? "❄️" : item.element === "lightning" ? "⚡" : null;
  const powerValue = item.power > 0
    ? item.power
    : (item.stat_bonus ? Object.values(item.stat_bonus).reduce((a: number, b: number) => a + b, 0) : 0);
  const isLevelLocked = !item.equipped && (characterLevel ?? Infinity) < (item.level_req ?? 1);
  const sellPrice = showSellPrice
    ? sellPriceFor(item.item_type, item.rarity, { power: item.power, sharpens_count: item.sharpens_count })
    : null;

  return (
    <div
      ref={ref}
      onClick={onClick}
      title={item.item_name}
      style={{
        width: mode !== "detailed" ? size : undefined,
        height: mode !== "detailed" ? size : undefined,
        padding: mode === "detailed" ? "10px 8px 8px" : undefined,
        background: selected ? "#1e1c2e" : isOver ? "#151d2e" : "#1d1f23",
        ...stripeBorder,
        borderRadius: mode === "icon" ? 8 : 10,
        cursor: cursor ?? (onClick ? "pointer" : undefined),
        position: "relative",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: mode !== "detailed" ? "center" : undefined,
        gap: mode !== "icon" ? 2 : undefined,
        opacity: isDragging ? 0.35 : isLevelLocked ? 0.45 : 1,
        boxShadow: isMatch ? "0 0 8px #c084fc44" : selected ? `0 0 0 1px ${rc}66` : undefined,
        transition: "border-color 0.1s, background 0.1s",
        touchAction: "none",
        flexShrink: 0,
        textAlign: "center",
        ...extraStyle,
      }}
      {...rest}
    >
      {(item.level_req ?? 1) > 1 && (
        <div style={{ position: "absolute", top: 4, [item.equipped ? "right" : "left"]: 4, background: "#1d1f23", border: "1px solid #4b5563", borderRadius: 3, fontSize: 8, fontWeight: 700, padding: "1px 3px", lineHeight: 1, color: "#9ca3af" }}>L{item.level_req}</div>
      )}
      {item.sharpens_count > 0 && mode !== "detailed" && (
        <div style={{ position: "absolute", top: 4, right: 4, background: "#1d1f23", border: "1px solid #b45309", borderRadius: 3, fontSize: 8, fontWeight: 700, padding: "1px 3px", lineHeight: 1, color: "#fb923c", display: "flex", alignItems: "center", gap: 2 }}>
          <Icon name="anvil" size={8} color="#fb923c" />{"×"}{item.sharpens_count}
        </div>
      )}
      <Icon name={itemIcon(item)} size={iconSize} color={itemIconColor(item) ?? rc} />
      {item.item_type === "resource" && (item.qty ?? 1) > 0 && (mode === "icon" || mode === "compact") && (
        <div style={{ position: "absolute", bottom: 3, right: 3, minWidth: 18, height: 18, background: "#0a0b0e", border: `1px solid ${rc}55`, borderRadius: "50%", fontSize: 9, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", color: rc, lineHeight: 1, padding: "0 2px" }}>
          ×{item.qty ?? 1}
        </div>
      )}
      {(stackCount ?? 1) > 1 && (
        <div
          title={`Stack of ${stackCount}`}
          style={{
            position: "absolute",
            top: mode === "detailed" ? 6 : 4,
            right: mode === "detailed" ? 6 : 4,
            minWidth: 20, height: 18,
            background: "#0a0b0e",
            border: `1px solid ${rc}`,
            borderRadius: 9,
            fontSize: 10, fontWeight: 700,
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "#f5f5f5",
            lineHeight: 1, padding: "0 5px",
            boxShadow: `0 0 0 2px ${rc}33`,
          }}
        >
          ×{stackCount}
        </div>
      )}
      {item.item_type !== "resource" && (mode === "icon" || (mode === "compact" && powerValue > 0)) && (
        <div style={{ position: "absolute", bottom: 3, right: 3, minWidth: 18, height: 18, background: "#0a0b0e", border: `1px solid ${rc}55`, borderRadius: "50%", fontSize: 9, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", color: rc, lineHeight: 1, padding: "0 2px" }}>
          +{powerValue}
        </div>
      )}
      {(item.potency_stacks ?? 0) > 0 && mode !== "detailed" && (
        <div style={{ position: "absolute", top: 4, left: 4, background: "#1d1f23", border: "1px solid #7e22ce", borderRadius: 3, fontSize: 8, fontWeight: 700, padding: "1px 3px", lineHeight: 1, color: "#c084fc" }} title={`Concentrated ×${item.potency_stacks}`}>
          ✦×{item.potency_stacks}
        </div>
      )}
      {elementEmoji && mode === "icon" && (
        <div style={{ position: "absolute", bottom: 3, left: 3, fontSize: 9, lineHeight: 1 }} title={item.element ?? undefined}>
          {elementEmoji}
        </div>
      )}
      {mode === "compact" && (
        <div style={{ fontSize: 10, color: "#9ca3af", lineHeight: 1.1, maxWidth: size - 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: "0 4px" }}>
          {resourceDisplayName(item)}
        </div>
      )}
      {mode === "detailed" && (
        <>
          <div style={{ marginTop: 2, fontSize: 10, fontWeight: 600, color: "#e2e8f0", lineHeight: 1.3, wordBreak: "break-word" }}>{resourceDisplayName(item)}</div>
          <div style={{ fontSize: 10, color: rc, fontWeight: 600 }}>+{powerValue}</div>
          <div style={{ fontSize: 9, color: "#6b7280" }}>{slotLabel(item)}</div>
          {item.stat_bonus && statBonusSummary(item.stat_bonus) && (
            <div style={{ fontSize: 8, color: "#86efac" }}>{statBonusSummary(item.stat_bonus)}</div>
          )}
          {elementEmoji && (
            <div style={{ fontSize: 9, color: "#9ca3af" }}>{elementEmoji} {item.element}</div>
          )}
          {showSellPrice && sellPrice !== null && (
            <div style={{ fontSize: 9, color: "#fbbf24" }}>{sellPrice}g</div>
          )}
        </>
      )}
    </div>
  );
});

export function ItemSlot({ item, selected, onSelect, characterLevel }: { item: Item; selected: boolean; onSelect: (el: HTMLElement) => void; characterLevel?: number }) {
  return (
    <ItemCell
      item={item}
      size={72}
      mode="icon"
      selected={selected}
      characterLevel={characterLevel}
      onClick={(e) => onSelect(e.currentTarget)}
    />
  );
}

// Side-by-side stat comparison between a candidate item and the item
// currently equipped in the same slot. Renders one row per differing stat
// with a ▲ green-up / ▼ red-down arrow matching the design handoff's spec.
function StatDiffPanel({ candidate, equipped }: { candidate: Item; equipped: Item }) {
  // `power` covers atk on weapons, mag on focus, armor on armor pieces.
  // We collapse it under one "Power" row since the source item record
  // doesn't disambiguate by item_type for this number.
  const a: Record<string, number> = { power: candidate.power };
  const b: Record<string, number> = { power: equipped.power };
  if (candidate.stat_bonus) for (const [k, v] of Object.entries(candidate.stat_bonus)) a[k] = (a[k] ?? 0) + v;
  if (equipped.stat_bonus)  for (const [k, v] of Object.entries(equipped.stat_bonus))  b[k] = (b[k] ?? 0) + v;
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
  const labelFor = (k: string) =>
    k === "power"   ? "Power"
    : k === "str"   ? "STR"
    : k === "int_stat" ? "INT"
    : k === "vit"   ? "VIT"
    : k === "agi"   ? "AGI"
    : k === "dex"   ? "DEX"
    : k.toUpperCase();
  const rows = keys
    .map((k) => ({ k, av: a[k] ?? 0, bv: b[k] ?? 0 }))
    .filter((r) => r.av !== 0 || r.bv !== 0);
  if (rows.length === 0) return null;
  // Net verdict — sum every row's diff. Positive = upgrade (green border),
  // negative = downgrade (red), zero = sidegrade (neutral). Drives the
  // panel's border + header tag so the player can read intent at a glance
  // without scanning every row.
  const net = rows.reduce((acc, r) => acc + (r.av - r.bv), 0);
  const verdict = net > 0 ? "upgrade" : net < 0 ? "downgrade" : "sidegrade";
  const verdictColor = verdict === "upgrade"
    ? "#4ade80"
    : verdict === "downgrade" ? "#f87171" : "#94a3b8";
  const verdictBg = verdict === "upgrade"
    ? "rgba(74, 222, 128, 0.08)"
    : verdict === "downgrade"
      ? "rgba(248, 113, 113, 0.08)"
      : "rgba(148, 163, 184, 0.06)";
  return (
    <div style={{
      marginBottom: 12,
      padding: "10px 12px",
      background: verdictBg,
      border: `2px solid ${verdictColor}`,
      borderRadius: 8,
      boxShadow: `0 0 0 1px ${verdictColor}33`,
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        marginBottom: 8,
      }}>
        <div style={{
          font: "11px/1 var(--font-mono)",
          textTransform: "uppercase",
          letterSpacing: 1.1,
          color: "#e2e8f0",
          fontWeight: 700,
        }}>
          vs Equipped
        </div>
        <span style={{
          font: "700 10px/1 var(--font-mono)",
          textTransform: "uppercase",
          letterSpacing: 1,
          color: verdictColor,
          background: `${verdictColor}22`,
          border: `1px solid ${verdictColor}`,
          borderRadius: 4,
          padding: "3px 7px",
          whiteSpace: "nowrap",
        }}>
          {verdict}{net !== 0 ? ` ${net > 0 ? `+${net}` : net}` : ""}
        </span>
      </div>
      <div style={{
        font: "11px/1.3 var(--font-body)",
        color: "#cbd5e1",
        marginBottom: 8,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}>
        {equipped.item_name}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map(({ k, av, bv }) => {
          const diff = av - bv;
          const arrow = diff > 0 ? "▲" : diff < 0 ? "▼" : "•";
          const color = diff > 0 ? "#4ade80" : diff < 0 ? "#f87171" : "#94a3b8";
          return (
            <div key={k} style={{
              display: "grid",
              gridTemplateColumns: "64px 1fr auto",
              alignItems: "center",
              gap: 10,
              font: "13px/1.3 var(--font-body)",
            }}>
              <span style={{
                color: "#e2e8f0",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                fontSize: 11,
              }}>{labelFor(k)}</span>
              <span style={{ fontFamily: "var(--font-mono)", color: "#f5f5f5", fontSize: 13 }}>
                <b style={{ fontWeight: 700 }}>{av}</b>
                <span style={{ color: "#6b7280", margin: "0 6px" }}>vs</span>
                <span style={{ color: "#9ca3af" }}>{bv}</span>
              </span>
              <span style={{
                font: "700 13px/1 var(--font-mono)",
                color,
                whiteSpace: "nowrap",
                minWidth: 50,
                textAlign: "right",
              }}>
                {arrow} {diff > 0 ? `+${diff}` : diff}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ItemDetailPopover({
  item,
  inQuest,
  selfId,
  characterLevel,
  equippedInSlot,
  onEquip,
  onUnequip,
  onSell,
  onUse,
  onGive,
  onClose,
  inline,
}: {
  item: Item;
  inQuest: boolean;
  selfId: string;
  characterLevel?: number;
  /** The item currently equipped in this item's slot, if any. When the
      displayed item is unequipped and a comparison exists, the popover
      renders a stat-diff (▲ +N / ▼ −N) section. */
  equippedInSlot?: Item | null;
  onEquip: (itemId: number) => void;
  onUnequip: (itemId: number) => void;
  onSell: (itemId: number) => void;
  onUse: (itemId: number) => void;
  onGive: (itemId: number, toUserId: string, toName: string) => void;
  onClose: () => void;
  inline?: boolean;
}) {
  const [showGivePicker, setShowGivePicker] = useState(false);
  const [characters, setCharacters] = useState<KnownCharacter[]>([]);
  const [charsLoading, setCharsLoading] = useState(false);

  async function openGivePicker() {
    setShowGivePicker(true);
    if (characters.length === 0) {
      setCharsLoading(true);
      try {
        const res = await fetch("/api/characters", { credentials: "include" });
        if (res.ok) {
          const body = (await res.json()) as { characters: KnownCharacter[] };
          setCharacters(body.characters);
        }
      } finally {
        setCharsLoading(false);
      }
    }
  }

  const meetsLevel = (characterLevel ?? 1) >= (item.level_req ?? 1);
  const canEquip = !item.equipped && item.slot !== null && meetsLevel;
  const canSell = !item.equipped && !inQuest;
  const canUse =
    !item.equipped && (item.item_type === "consumable" || item.item_type === "magic");
  const canGive = !item.equipped;
  const rc = RARITY_COLOR[item.rarity];

  return (
    <div
      style={{
        ...(inline ? {} : { width: 240, boxShadow: "0 8px 32px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.04)" }),
        background: "#12141a",
        border: `1px solid ${rc}55`,
        borderRadius: 10,
        padding: "14px 14px 12px",
        fontFamily: "inherit",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
        <div
          style={{
            width: 40,
            height: 40,
            background: "#0e0f12",
            border: `2px solid ${rc}66`,
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Icon name={itemIcon(item)} size={22} color={itemIconColor(item) ?? rc} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, color: "#f5f5f5", fontSize: 13, lineHeight: 1.3, wordBreak: "break-word", fontFamily: DISPLAY_FONT }}>
            {resourceDisplayName(item)}
          </div>
          <div style={{ display: "flex", gap: 5, marginTop: 4, flexWrap: "wrap" }}>
            <RarityBadge rarity={item.rarity} />
            {item.equipped && (
              <span style={{ ...smallBadge, background: "#3a2a00", color: "#b89b3a", borderColor: "#b89b3a55" }}>
                equipped
              </span>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 18, padding: 0, lineHeight: 1, flexShrink: 0 }}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {/* Type line */}
      <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: item.sharpens_count > 0 ? 4 : 8 }}>
        {slotLabel(item)}
        {item.item_type === "weapon" && item.weapon_range && ` · ${item.weapon_range}`}
        {item.power > 0 && <>{" · "}+{item.power} power</>}
      </div>
      {item.sharpens_count > 0 && (
        <div style={{ fontSize: 11, color: "#fb923c", marginBottom: 8, display: "flex", alignItems: "center", gap: 4 }}>
          <Icon name="anvil" size={11} color="#fb923c" />
          {item.sharpens_count === 3 ? "Fully upgraded" : `Upgraded ${item.sharpens_count}×`} · base power was +{item.power - item.sharpens_count}
        </div>
      )}
      {item.stat_bonus && statBonusSummary(item.stat_bonus) && (
        <div style={{ fontSize: 11, color: "#86efac", marginBottom: 8, fontWeight: 600 }}>
          {statBonusSummary(item.stat_bonus)}
        </div>
      )}

      {/* Stat-diff vs the item currently equipped in the same slot */}
      {!item.equipped && equippedInSlot && equippedInSlot.id !== item.id && (
        <StatDiffPanel candidate={item} equipped={equippedInSlot} />
      )}

      {/* Flavor */}
      {item.flavor && (
        <div
          style={{
            ...muted,
            fontSize: 12,
            fontStyle: "italic",
            marginBottom: 10,
            lineHeight: 1.5,
            borderLeft: `2px solid ${rc}44`,
            paddingLeft: 8,
          }}
        >
          {item.flavor}
        </div>
      )}

      {/* Effect */}
      <div
        style={{
          background: "#0a0b0e",
          borderRadius: 6,
          padding: "8px 10px",
          fontSize: 12,
          color: "#cbd5e1",
          lineHeight: 1.5,
          marginBottom: item.item_type === "tool" || item.item_type === "scroll" ? 6 : 12,
        }}
      >
        {describeItemEffect(item)}
      </div>
      {/* Status effect chip for items that apply effects */}
      {(() => {
        const entry = findCatalogEntry(item.item_name);
        const applies = entry ? CATALOG_EFFECT[entry.name] : undefined;
        if (!applies) return null;
        const col = EFFECT_COLOR[applies.effect as EffectType];
        const icon = EFFECT_ICON[applies.effect as EffectType];
        const targetLabel = applies.target === "self" ? "self" : "monster";
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
            <span style={{ fontSize: 10, color: "#6b7280" }}>Applies:</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, background: col + "22", border: `1px solid ${col}55`, color: col, borderRadius: 4, padding: "2px 7px" }}>
              <Icon name={icon} size={10} color={col} /> {applies.effect}
            </span>
            <span style={{ fontSize: 10, color: "#6b7280" }}>→ {targetLabel}</span>
          </div>
        );
      })()}

      {/* Level requirement badge */}
      {item.slot !== null && !item.equipped && !meetsLevel && (
        <div style={{ fontSize: 11, color: "#f87171", fontWeight: 600, marginBottom: 10 }}>
          Requires level {item.level_req}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {canEquip && (
          <button onClick={() => onEquip(item.id)} style={smallActionBtn("#1f3a1f", "#86efac")}>Equip</button>
        )}
        {item.equipped && (
          <button onClick={() => onUnequip(item.id)} style={smallActionBtn("#2a1a1a", "#fca5a5")}>Unequip</button>
        )}
        {canUse && (
          <button onClick={() => onUse(item.id)} style={smallActionBtn("#1f2a3a", "#7dd3fc")}>Use</button>
        )}
        {canGive && (
          <button
            onClick={() => { if (showGivePicker) { setShowGivePicker(false); } else { void openGivePicker(); } }}
            style={smallActionBtn(showGivePicker ? "#3a2030" : "#2a2030", showGivePicker ? "#f9a8d4" : "#c084fc")}
          >
            Give
          </button>
        )}
        {canSell && (
          <button onClick={() => onSell(item.id)} style={smallActionBtn("#33363d", "#e6e6e6")}>
            Sell · {sellPriceFor(item.item_type, item.rarity, { power: item.power, sharpens_count: item.sharpens_count })}g
          </button>
        )}
      </div>

      {/* Give picker */}
      {showGivePicker && (
        <div style={{ marginTop: 10, padding: "8px 10px", background: "#0a0b0e", borderRadius: 6, border: "1px solid #2a2d33", fontSize: 12 }}>
          <div style={{ ...muted, marginBottom: 6 }}>Give to:</div>
          {charsLoading && <div style={muted}>Loading players…</div>}
          {!charsLoading && characters.length === 0 && <div style={muted}>No other players found.</div>}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {characters.filter((ch) => ch.slack_user_id !== selfId).map((ch) => (
              <button
                key={ch.slack_user_id}
                style={smallActionBtn("#1a1a2e", "#c084fc")}
                onClick={() => { setShowGivePicker(false); onGive(item.id, ch.slack_user_id, ch.name); }}
              >
                {ch.name} ({ch.class})
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── dnd-kit sub-components for InventoryFullScreen ──────────────────────────

// Class-themed glyph used by FigureTile when no class portrait art is
// available. Mirrors the design handoff's `crystal-wand` placeholder for
// the DevOps Mage and matches the rpg-awesome / game-icons.net set.
const CLASS_GLYPH: Record<string, string> = {
  "DevOps Mage": "crystal-wand",
  "QA Paladin": "bolt-shield",
  "Backend Druid": "aura",
  "Frontend Bard": "music-spell",
  "Staff Sage": "wizard-staff",
  "Refactor Rogue": "cloak-dagger",
  "SRE Warden": "round-shield",
  "Data Warlock": "death-skull",
};

// Center figure tile in the paper-doll grid — sized to span four 96px slots.
// Shows the class portrait when available, falls back to a class glyph on the
// void background. Matches the design's 96×190 figure idiom.
export function FigureTile({
  character,
  height,
}: {
  character: Character;
  height: number;
}) {
  const [portraitFailed, setPortraitFailed] = useState(false);
  const [fellBack, setFellBack] = useState(false);
  // Prefer the per-character art (unique, generated). Fall back to the
  // shared class portrait if the character art 404s (e.g. art job still
  // queued), then to a class glyph if even that's missing.
  const charPortrait = charPortraitUrl(character.name);
  const classPortrait = classPortraitUrl(character.class);
  const portrait = !fellBack ? charPortrait : classPortrait;
  const glyph = CLASS_GLYPH[character.class] ?? "crystal-wand";
  const classShort = character.class.split(" ").slice(-1)[0] ?? character.class;
  return (
    <div
      style={{
        // Flex-grow to fill the gap between the two slot columns. minWidth
        // preserves the design's 96px floor on tight viewports.
        flex: 1,
        minWidth: 96,
        // A soft ceiling so the figure doesn't bloat on ultra-wide layouts.
        maxWidth: 240,
        margin: "0 8px",
        height,
        background: "var(--bg-void)",
        border: "1px solid var(--border-base)",
        borderRadius: "var(--radius-lg)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        overflow: "hidden",
      }}
      title={`${character.name} · ${character.class}`}
    >
      {portrait && !portraitFailed ? (
        <img
          src={portrait}
          alt={character.class}
          style={{ width: "100%", flex: 1, objectFit: "cover", minHeight: 0 }}
          onError={() => {
            if (!fellBack && classPortrait) setFellBack(true);
            else setPortraitFailed(true);
          }}
        />
      ) : (
        <Icon name={glyph} size={54} color="var(--accent-arcane-2)" />
      )}
      <div style={{
        font: "9px/1 var(--font-mono)",
        color: "var(--fg-faintest)",
        textTransform: "uppercase",
        letterSpacing: 1,
        paddingBottom: 6,
        whiteSpace: "nowrap",
      }}>
        L{character.level} {classShort}
      </div>
    </div>
  );
}

export function DollSlotCell({
  slot, item, isHighlighted, isSelected, onSlotClick, onItemClick, characterLevel,
}: {
  slot: EquipSlot; item: Item | undefined;
  isHighlighted: boolean; isSelected: boolean;
  onSlotClick: (slot: EquipSlot) => void;
  onItemClick: (itemId: number) => void;
  characterLevel?: number;
}) {
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `drop-slot-${slot}`, data: { slot } });
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: item ? `doll-item-${item.id}` : `empty-slot-${slot}`,
    data: item ? { itemId: item.id, equipped: true } : undefined,
    disabled: !item,
  });
  const mergeRef = (el: HTMLElement | null) => { setDropRef(el); setDragRef(el); };
  const S = 96;
  const label = SLOT_LABELS[slot];
  if (item) {
    return (
      <ItemCell
        ref={mergeRef}
        item={item}
        size={S}
        mode="compact"
        rarityStripe
        selected={isSelected}
        isOver={isOver}
        isDragging={isDragging}
        characterLevel={characterLevel}
        cursor="grab"
        onClick={() => onItemClick(item.id)}
        {...(listeners as HTMLAttributes<HTMLDivElement>)}
        {...(attributes as HTMLAttributes<HTMLDivElement>)}
      />
    );
  }
  const emptyEdge = isOver ? "#7dd3fc88" : isHighlighted ? "#c084fc55" : "#1e2128";
  return (
    <div ref={setDropRef} onClick={() => onSlotClick(slot)} title={`${label} — empty`}
      style={{
        width: S, height: S, background: isOver ? "#151d2e" : "#141618",
        borderTop: `2px dashed ${emptyEdge}`,
        borderRight: `2px dashed ${emptyEdge}`,
        borderBottom: `2px dashed ${emptyEdge}`,
        // Design uses a faint solid-grey left stripe on empty slots so each
        // slot still reads as a placeholder for a rarity-stripe item.
        borderLeft: "3px dashed var(--border-strong)",
        borderRadius: 10, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4,
        cursor: "pointer", transition: "border-color 0.15s, background 0.15s",
      }}
    >
      <Icon name={SLOT_ICON[slot]} size={30}
        color={isOver ? "#7dd3fc55" : isHighlighted ? "#c084fc66" : "#2e3440"}
        style={slot === "main_hand" ? { transform: "scaleX(-1)" } : undefined}
      />
      <div style={{ fontSize: 11, color: isOver ? "#7dd3fc88" : isHighlighted ? "#c084fc88" : "#374151", textAlign: "center", lineHeight: 1.2 }}>{label}</div>
    </div>
  );
}

export function DroppablePackPanel({ children }: { children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: "pack-drop-zone" });
  return (
    <div ref={setNodeRef} style={{
      flex: 1, overflowY: "auto", padding: 18,
      outline: isOver ? "2px dashed #7dd3fc44" : "2px dashed transparent",
      outlineOffset: -6, borderRadius: 8, transition: "outline-color 0.15s",
    }}>
      {children}
    </div>
  );
}

export function DraggablePackItem({
  item, isSelected, isMatch, viewMode, onSelect, characterLevel, stackCount,
}: {
  item: Item; isSelected: boolean; isMatch: boolean;
  viewMode: "grid" | "list"; onSelect: () => void; characterLevel?: number;
  /** Client-side stack count for the bag grid — purely cosmetic, dnd-kit
      still operates on the representative item's id. */
  stackCount?: number;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `pack-item-${item.id}`,
    data: { itemId: item.id, equipped: false, itemSlot: item.slot },
  });
  const rc = RARITY_COLOR[item.rarity];
  const sellPrice = sellPriceFor(item.item_type, item.rarity, { power: item.power, sharpens_count: item.sharpens_count });
  const isLevelLocked = (characterLevel ?? Infinity) < (item.level_req ?? 1);
  if (viewMode === "list") {
    const listEdge = isSelected ? "#fff" : isMatch ? "#c084fc" : "#2a2d33";
    return (
      <div ref={setNodeRef} {...listeners} {...attributes} onClick={onSelect}
        style={{
          display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
          borderRadius: 8, background: isSelected ? "#1e1c2e" : "#1d1f23",
          borderTop: `1px solid ${listEdge}`,
          borderRight: `1px solid ${listEdge}`,
          borderBottom: `1px solid ${listEdge}`,
          borderLeft: `3px solid ${rc}`,
          cursor: isDragging ? "grabbing" : "grab", opacity: isDragging ? 0.35 : isLevelLocked ? 0.45 : 1,
          transition: "background 0.1s", boxShadow: isMatch ? "0 0 6px #c084fc33" : undefined,
          touchAction: "none",
        }}
      >
        <Icon name={itemIcon(item)} size={20} color={itemIconColor(item) ?? rc} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#f5f5f5", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {resourceDisplayName(item)}
            {(stackCount ?? 1) > 1 && (
              <span style={{ marginLeft: 6, fontSize: 11, color: rc, fontWeight: 700 }}>×{stackCount}</span>
            )}
          </div>
          <div style={{ fontSize: 10, color: "#6b7280", marginTop: 1 }}>
            {slotLabel(item)}{item.stat_bonus && statBonusSummary(item.stat_bonus) ? ` · ${statBonusSummary(item.stat_bonus)}` : ""}
          </div>
        </div>
        {(item.level_req ?? 1) > 1 && (
          <span style={{ fontSize: 10, color: "#6b7280", flexShrink: 0 }}>L{item.level_req}</span>
        )}
        {item.element && (
          <span style={{ fontSize: 12, flexShrink: 0 }} title={item.element}>
            {item.element === "fire" ? "🔥" : item.element === "ice" ? "❄️" : "⚡"}
          </span>
        )}
        <span style={{ ...smallBadge, borderColor: `${rc}55`, color: rc, background: `${rc}15`, flexShrink: 0 }}>{item.rarity}</span>
        <span style={{ fontSize: 11, color: rc, fontWeight: 600, flexShrink: 0, minWidth: 30, textAlign: "right" }}>+{item.power}</span>
        <span style={{ fontSize: 11, color: "#fbbf24", flexShrink: 0, minWidth: 28, textAlign: "right" }}>{sellPrice}g</span>
      </div>
    );
  }
  return (
    <ItemCell
      ref={setNodeRef}
      item={item}
      mode="detailed"
      rarityStripe
      selected={isSelected}
      isDragging={isDragging}
      isMatch={isMatch}
      showSellPrice
      characterLevel={characterLevel}
      stackCount={stackCount}
      cursor={isDragging ? "grabbing" : "grab"}
      onClick={onSelect}
      {...(listeners as HTMLAttributes<HTMLDivElement>)}
      {...(attributes as HTMLAttributes<HTMLDivElement>)}
    />
  );
}

export function DragItemPreview({
  item,
  size,
}: {
  item: Item;
  /** Optional rect captured from the drag source. Sized to match so the
      cursor stays anchored exactly where the user grabbed. Falls back to
      the legacy 80px fixed-size preview when no rect is available. */
  size?: { width: number; height: number } | null;
}) {
  const rc = RARITY_COLOR[item.rarity];
  // Icon scales with the preview; clamped so very wide bag tiles don't
  // produce a comically huge icon while tiny mobile cells don't shrink it
  // past readability.
  const w = size?.width ?? 80;
  const h = size?.height ?? 96;
  const iconSize = Math.min(48, Math.max(20, Math.floor(Math.min(w, h) * 0.42)));
  return (
    <div
      style={{
        width: w,
        height: h,
        background: "#1d1f23",
        border: `2px solid ${rc}`,
        borderRadius: 10,
        padding: "8px 6px 6px",
        textAlign: "center",
        boxShadow: "0 8px 24px rgba(0,0,0,0.7)",
        opacity: 0.95,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        boxSizing: "border-box",
        pointerEvents: "none",
      }}
    >
      <Icon name={itemIcon(item)} size={iconSize} color={itemIconColor(item) ?? rc} />
      <div style={{
        fontSize: 9,
        fontWeight: 600,
        color: "#e2e8f0",
        lineHeight: 1.3,
        wordBreak: "break-word",
        overflow: "hidden",
        textOverflow: "ellipsis",
        maxWidth: "100%",
      }}>
        {item.item_name}
      </div>
    </div>
  );
}

function BagFilterTabs({
  filter,
  onChange,
  counts,
}: {
  filter: "all" | "weapon" | "armor" | "consumable";
  onChange: (f: "all" | "weapon" | "armor" | "consumable") => void;
  counts: { all: number; weapon: number; armor: number; consumable: number };
}) {
  const tabs: { id: "all" | "weapon" | "armor" | "consumable"; label: string }[] = [
    { id: "all", label: "All" },
    { id: "weapon", label: "Weapons" },
    { id: "armor", label: "Armor" },
    { id: "consumable", label: "Consumables" },
  ];
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {tabs.map((t) => {
        const on = filter === t.id;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            style={{
              font: "11px/1 var(--font-body)",
              padding: "6px 11px",
              borderRadius: "var(--radius-md)",
              background: on ? "var(--accent-ink-deep)" : "var(--bg-input)",
              border: `1px solid ${on ? "var(--accent-ink-blue-2)" : "var(--border-base)"}`,
              color: on ? "var(--fg-1)" : "var(--fg-mute-2)",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            {t.label}
            <span style={{
              font: "10px/1 var(--font-mono)",
              color: on ? "var(--accent-ink-blue)" : "var(--fg-mute-3)",
            }}>
              {counts[t.id]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Combat-relevant totals derived from equipped gear + base stats. Matches the
// design's "Loadout Totals" panel below the paper-doll.
// Attack/Magic = STR/INT modifier formulas from constants.PRIMARY_STAT_META.
// Armor is recomputed from equipped slots so it updates reactively when the
// player equips/unequips without waiting on the server to refresh the
// character record (which doesn't carry armor_power on /api/me anyway).
// Crit derives from DEX (cap 10%).
export function LoadoutTotals({
  character,
  items,
}: {
  character: Character;
  items: Item[];
}) {
  const equipped = items.filter((i) => i.equipped);
  const bonus: Partial<Record<StatKey, number>> = {};
  for (const it of equipped) {
    if (!it.stat_bonus) continue;
    for (const [k, v] of Object.entries(it.stat_bonus)) {
      bonus[k as StatKey] = (bonus[k as StatKey] ?? 0) + v;
    }
  }
  const effStat = (k: StatKey) => (character[k] ?? 5) + (bonus[k] ?? 0);
  // Basic attacks add the main-hand weapon's full power on top of the STR mod
  // (combat.ts:resolvePlayerHit). Focus weapons feed Magic via the signature
  // `wpn = floor(power/2)` term used by every caster ability that includes a
  // weapon component.
  const mainHand = equipped.find(
    (i) => i.item_type === "weapon" && (i.slot === "main_hand" || i.slot === null),
  );
  const weaponAtk = mainHand?.power ?? 0;
  const focusMag = mainHand?.weapon_range === "focus" ? Math.floor((mainHand.power ?? 0) / 2) : 0;
  const atkMod = Math.floor((effStat("str") - 5) / 2) + weaponAtk;
  const magMod = Math.floor((effStat("int_stat") - 5) / 2) + focusMag;
  // Mirrors computeArmorPowerFromSlots in worker.ts:
  //   body = power, helmet = floor(p/2), pants = floor(p/4),
  //   shield off_hand = power.
  const slotPower = (slot: EquipSlot) =>
    equipped.find((i) => i.slot === slot)?.power ?? 0;
  const offHand = equipped.find((i) => i.slot === "off_hand");
  const shieldPower = offHand?.item_subtype === "shield" ? offHand.power : 0;
  const armorNow =
    slotPower("body") +
    Math.floor(slotPower("helmet") / 2) +
    Math.floor(slotPower("pants") / 4) +
    shieldPower;
  const critPct = Math.round(
    Math.min(10, Math.max(0, (effStat("dex") - 5))),
  );
  const fmtSigned = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
  const rows: { label: string; value: string; color?: string }[] = [
    { label: "Attack", value: fmtSigned(atkMod), color: atkMod > 0 ? "var(--tone-good)" : undefined },
    { label: "Magic",  value: fmtSigned(magMod), color: magMod > 0 ? "var(--tone-good)" : undefined },
    { label: "Armor",  value: `${armorNow}`,     color: armorNow > 0 ? "var(--fg-1)" : undefined },
    { label: "Crit",   value: `${critPct}%`,     color: critPct > 0 ? "var(--tone-good)" : undefined },
  ];
  return (
    <div
      style={{
        alignSelf: "stretch",
        padding: "10px 12px",
        background: "var(--bg-card-2)",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--border-faint)",
      }}
    >
      <div style={{
        font: "10px/1 var(--font-mono)",
        textTransform: "uppercase",
        letterSpacing: 1,
        color: "var(--fg-faintest)",
        marginBottom: 10,
      }}>
        Loadout Totals
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map((r) => (
          <div key={r.label} style={{
            display: "flex",
            justifyContent: "space-between",
            font: "12px/1.4 var(--font-body)",
          }}>
            <span style={{ color: "var(--fg-mute)" }}>{r.label}</span>
            <span style={{
              fontFamily: "var(--font-mono)",
              color: r.color ?? "var(--fg-3)",
            }}>{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Client-side stacking for the bag grid ──────────────────────────────────
// Resources already arrive pre-stacked (qty column, server-side). Other
// stackables — consumables, scrolls, magic, revives, tools — arrive as
// individual rows. The bag fills up fast with "Health Potion ×7" rendered
// as seven tiles, which is noisy. Group identical bag entries here so each
// distinct item gets a single tile with a stack-count badge.
//
// Equipped, weapon, and armor items deliberately don't stack — weapons and
// armor almost always have unique stat rolls, and equipping a stack would
// be ambiguous. Resources keep their existing `qty` badge regardless.
type ItemStack = { item: Item; ids: number[] };

function stackableKey(it: Item): string | null {
  if (it.item_type === "weapon" || it.item_type === "armor" || it.item_type === "resource") {
    return null;
  }
  return [
    it.item_name,
    it.item_type,
    it.power,
    it.rarity,
    it.level_req ?? 1,
    it.element ?? "",
    it.item_subtype ?? "",
    it.sharpens_count ?? 0,
    it.potency_stacks ?? 0,
    it.stat_bonus ? JSON.stringify(it.stat_bonus) : "",
  ].join("|");
}

function stackPackItems(items: Item[]): ItemStack[] {
  const byKey = new Map<string, ItemStack>();
  const result: ItemStack[] = [];
  for (const it of items) {
    const k = stackableKey(it);
    if (!k) {
      result.push({ item: it, ids: [it.id] });
      continue;
    }
    const existing = byKey.get(k);
    if (existing) {
      existing.ids.push(it.id);
    } else {
      const stack: ItemStack = { item: it, ids: [it.id] };
      byKey.set(k, stack);
      result.push(stack);
    }
  }
  return result;
}

function useIsMobile(breakpoint = 700) {
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.innerWidth < breakpoint);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < breakpoint);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [breakpoint]);
  return isMobile;
}

export function InventoryFullScreen({
  items,
  inQuest,
  selfId,
  characterLevel,
  character,
  characterSheet,
  onEquip,
  onUnequip,
  onSell,
  onUse,
  onGive,
  onClose,
}: {
  items: Item[];
  inQuest: boolean;
  selfId: string;
  characterLevel?: number;
  character?: Character;
  /** Optional pre-built CharacterCard JSX shown at the top of the left
      Equipped column — used by App.tsx to fold the character sheet into
      the inventory now that the right sidebar is gone. */
  characterSheet?: ReactNode;
  onEquip: (itemId: number) => void;
  onUnequip: (itemId: number) => void;
  onSell: (itemId: number) => void;
  onUse: (itemId: number) => void;
  onGive: (itemId: number, toUserId: string, toName: string) => void;
  onClose: () => void;
}) {
  const [sort, setSort] = useState<InventorySort>("type");
  const [viewMode, setViewMode] = useState<"grid" | "list">(
    () => (localStorage.getItem("inv_view") === "list" ? "list" : "grid"),
  );
  function changeViewMode(mode: "grid" | "list") {
    localStorage.setItem("inv_view", mode);
    setViewMode(mode);
  }
  // Esc closes the modal — capture early so it beats any inner handlers.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);
  const dollEquipBonuses: Partial<Record<StatKey, number>> = {};
  for (const item of items) {
    if (item.equipped && item.stat_bonus) {
      for (const [k, v] of Object.entries(item.stat_bonus)) {
        dollEquipBonuses[k as StatKey] = (dollEquipBonuses[k as StatKey] ?? 0) + v;
      }
    }
  }
  const sorted = sortItems(items, sort);
  const allPackItems = sorted.filter((i) => !i.equipped);
  // Bag filter tabs — All / Weapons / Armor / Consumables.
  // "consumable" covers consumable + magic + scroll + revive in this codebase
  // (anything used from the bag rather than worn).
  type BagFilter = "all" | "weapon" | "armor" | "consumable";
  const [bagFilter, setBagFilter] = useState<BagFilter>("all");
  const packItems = allPackItems.filter((i) => {
    if (bagFilter === "all") return true;
    if (bagFilter === "weapon") return i.item_type === "weapon";
    if (bagFilter === "armor") return i.item_type === "armor";
    return i.item_type === "consumable" || i.item_type === "magic"
        || i.item_type === "scroll" || i.item_type === "revive";
  });
  // No bag cap right now — just surface the raw item count next to the
  // filter tabs so the player sees how big their pack is.
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = selectedId != null ? items.find((i) => i.id === selectedId) ?? null : null;
  const [highlightSlot, setHighlightSlot] = useState<EquipSlot | null>(null);
  const [activeItemId, setActiveItemId] = useState<number | null>(null);
  // Source rect captured at drag-start. DragOverlay preserves the cursor's
  // relative offset from the source's top-left, so if the preview's size
  // differs from the source the cursor appears to drift. Sizing the preview
  // to match the source keeps the grab anchor under the cursor.
  const [dragRect, setDragRect] = useState<{ width: number; height: number } | null>(null);
  const [mobileTab, setMobileTab] = useState<"doll" | "pack">("pack");
  const isMobile = useIsMobile();
  const activeItem = activeItemId != null ? items.find((i) => i.id === activeItemId) ?? null : null;

  // Require 5px of movement before a drag activates — lets regular clicks
  // fire on doll slots and pack items without starting an unintended drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function equippedForSlot(slot: EquipSlot): Item | undefined {
    return items.find((i) => i.equipped && (
      i.slot === slot
      || (slot === "main_hand" && !i.slot && i.item_type === "weapon")
      || (slot === "body" && !i.slot && i.item_type === "armor")
    ));
  }

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current as { itemId: number } | undefined;
    if (data) setActiveItemId(data.itemId);
    const initial = event.active.rect.current.initial;
    if (initial) setDragRect({ width: initial.width, height: initial.height });
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveItemId(null);
    setDragRect(null);
    const { active, over } = event;
    if (!over) return;
    const data = active.data.current as { itemId: number; equipped: boolean } | undefined;
    if (!data) return;
    const overId = over.id.toString();
    if (overId.startsWith("drop-slot-")) {
      if (!data.equipped) onEquip(data.itemId);
    } else if (overId === "pack-drop-zone" && data.equipped) {
      onUnequip(data.itemId);
    }
  }

  const SORT_LABELS: { key: InventorySort; label: string }[] = [
    { key: "type", label: "Type" },
    { key: "rarity", label: "Rarity" },
    { key: "power", label: "Power" },
    { key: "lvl", label: "Lvl" },
  ];

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 500,
        background: "rgba(0,0,0,0.92)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 12,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: "#12141a",
          border: "1px solid #2a2d33",
          borderRadius: 12,
          width: isMobile ? "100vw" : "min(1200px, 96vw)",
          height: isMobile ? "100dvh" : "92vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          position: "relative",
          boxShadow: "0 24px 64px rgba(0,0,0,0.8)",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: isMobile ? "12px 14px" : "14px 18px", borderBottom: "1px solid #2a2d33", flexShrink: 0, gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 16, fontWeight: 700, color: "#f5f5f5", fontFamily: DISPLAY_FONT }}>Inventory</span>
            <span style={{ ...muted, fontSize: 12 }}>{items.length} item{items.length !== 1 ? "s" : ""}</span>
            {character && (() => {
              const xpAtLevel = xpForLevel(character.level);
              const xpAtNext = xpForLevel(character.level + 1);
              const xpInto = Math.max(0, (character.xp ?? 0) - xpAtLevel);
              const xpSpan = Math.max(1, xpAtNext - xpAtLevel);
              const xpPct = Math.min(100, (xpInto / xpSpan) * 100);
              return (
                <div style={{
                  display: "flex", alignItems: "center", gap: 10,
                  minWidth: isMobile ? 0 : 260, flex: 1,
                }}>
                  <div style={{
                    display: "flex", flexDirection: "column", lineHeight: 1.05,
                    minWidth: 0,
                  }}>
                    <span style={{
                      fontFamily: DISPLAY_FONT,
                      fontSize: isMobile ? 14 : 16,
                      color: "var(--accent-arcane, #c084fc)",
                      letterSpacing: 0.4,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}>
                      {character.class}
                    </span>
                    <span style={{
                      font: "10px/1 var(--font-mono)",
                      color: "var(--accent-gold, #fbbf24)",
                      textTransform: "uppercase",
                      letterSpacing: 1.2,
                      marginTop: 3,
                    }}>
                      Level {character.level}
                    </span>
                  </div>
                  <div style={{ flex: 1, minWidth: 80 }}>
                    <div style={{
                      display: "flex", justifyContent: "space-between",
                      font: "9px/1 var(--font-mono)",
                      color: "var(--fg-mute, #9ca3af)",
                      textTransform: "uppercase",
                      letterSpacing: 0.8,
                      marginBottom: 3,
                    }}>
                      <span style={{ color: "var(--accent-gold, #fbbf24)" }}>XP</span>
                      <span>{xpInto} / {xpSpan}</span>
                    </div>
                    <div style={{
                      height: 6, borderRadius: 999,
                      background: "var(--bg-void, #0a0b0e)",
                      border: "1px solid #2a2d33",
                      overflow: "hidden",
                    }}>
                      <div style={{
                        width: `${xpPct}%`,
                        height: "100%",
                        background: "linear-gradient(90deg, var(--accent-gold-deep, #b45309), var(--accent-gold, #fbbf24))",
                        transition: "width 0.4s ease",
                      }} />
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {!isMobile && SORT_LABELS.map(({ key, label }) => (
              <button key={key} onClick={() => setSort(key)}
                style={{
                  background: sort === key ? "#2a2d3a" : "none",
                  color: sort === key ? "#c084fc" : "#6b7280",
                  border: sort === key ? "1px solid #c084fc55" : "1px solid transparent",
                  borderRadius: 20, padding: "3px 12px", fontSize: 12,
                  fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                }}
              >{label}</button>
            ))}
            {!isMobile && <div style={{ width: 1, height: 16, background: "#2a2d33", margin: "0 2px" }} />}
            {!isMobile && (["grid", "list"] as const).map((mode) => (
              <button key={mode} onClick={() => changeViewMode(mode)} title={mode === "grid" ? "Grid view" : "List view"}
                style={{
                  background: viewMode === mode ? "#2a2d3a" : "none",
                  color: viewMode === mode ? "#7dd3fc" : "#6b7280",
                  border: viewMode === mode ? "1px solid #7dd3fc55" : "1px solid transparent",
                  borderRadius: 6, padding: "3px 8px", fontSize: 14,
                  cursor: "pointer", fontFamily: "inherit", lineHeight: 1,
                }}
              >{mode === "grid" ? "⊞" : "☰"}</button>
            ))}
            <button onClick={onClose}
              style={{ background: "none", border: "1px solid #3a3d44", borderRadius: 6, color: "#9ca3af", cursor: "pointer", padding: "4px 10px", fontSize: 13, fontFamily: "inherit", marginLeft: 4 }}
            >✕</button>
          </div>
        </div>

        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          {isMobile ? (
            /* ── Mobile: tab bar + single-panel view ── */
            <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
              {/* Tab bar */}
              <div style={{ display: "flex", borderBottom: "1px solid #2a2d33", flexShrink: 0 }}>
                {([["doll", "Equipped"], ["pack", `Pack (${packItems.length})`]] as const).map(([tab, label]) => (
                  <button key={tab} onClick={() => setMobileTab(tab)}
                    style={{
                      flex: 1, padding: "10px 0", fontSize: 13, fontWeight: 600, fontFamily: DISPLAY_FONT,
                      background: "none", border: "none", cursor: "pointer",
                      color: mobileTab === tab ? "#f5f5f5" : "#6b7280",
                      borderBottom: mobileTab === tab ? "2px solid #c084fc" : "2px solid transparent",
                      marginBottom: -1,
                    }}
                  >{label}</button>
                ))}
              </div>

              {/* Tab content */}
              <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
                {mobileTab === "doll" ? (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                    {characterSheet && (
                      <div style={{ alignSelf: "stretch", width: "100%" }}>{characterSheet}</div>
                    )}
                    <div style={{ ...muted, fontSize: 10, textTransform: "uppercase", letterSpacing: 1.5, alignSelf: "flex-start" }}>Tap a slot to highlight matchable items</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 72px)", gap: 5 }}>
                      {([null, "helmet", null, "main_hand", "body", "off_hand", "amulet", "pants", "ring", null, "boots", null] as (EquipSlot | null)[]).map((s, i) => {
                        if (!s) return <div key={i} style={{ width: 72, height: 72 }} />;
                        const item = equippedForSlot(s);
                        const isHighlighted = highlightSlot === s;
                        const isSelected = selectedId === (item?.id ?? -1);
                        if (item) {
                          return (
                            <ItemCell
                              key={s}
                              item={item}
                              size={72}
                              mode="compact"
                              selected={isSelected}
                              characterLevel={characterLevel}
                              onClick={() => setSelectedId(isSelected ? null : item.id)}
                            />
                          );
                        }
                        return (
                          <div key={s} onClick={() => setHighlightSlot(isHighlighted ? null : s)}
                            style={{ width: 72, height: 72, background: "#141618", border: isHighlighted ? "2px solid #c084fc55" : "2px dashed #1e2128", borderRadius: 8, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, cursor: "pointer" }}
                          >
                            <Icon name={SLOT_ICON[s]} size={22} color={isHighlighted ? "#c084fc66" : "#2e3440"} style={s === "main_hand" ? { transform: "scaleX(-1)" } : undefined} />
                            <div style={{ fontSize: 9, color: isHighlighted ? "#c084fc88" : "#374151", textAlign: "center", fontFamily: DISPLAY_FONT }}>{SLOT_LABELS[s]}</div>
                          </div>
                        );
                      })}
                    </div>
                    {highlightSlot && (
                      <div style={{ fontSize: 11, color: "#c084fc88", textAlign: "center" }}>
                        Switch to Pack tab to equip in {SLOT_LABELS[highlightSlot]}
                      </div>
                    )}
                    {character?.str !== undefined && (
                      <div style={{ alignSelf: "stretch", padding: "10px 12px", background: "#16181c", borderRadius: 8, border: "1px solid #2a2d33" }}>
                        <div style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 6, fontFamily: DISPLAY_FONT }}>Primary Stats</div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 4 }}>
                          {(["str", "int_stat", "vit", "agi", "dex"] as StatKey[]).map((key) => {
                            const base = character[key] ?? 5;
                            const bonus = dollEquipBonuses[key] ?? 0;
                            return (
                              <div key={key} style={{ textAlign: "center", background: "#1d1f23", borderRadius: 5, padding: "5px 3px" }}>
                                <div style={{ fontSize: 8, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.8, fontFamily: DISPLAY_FONT }}>
                                  {key === "int_stat" ? "INT" : key.toUpperCase()}
                                </div>
                                <div style={{ fontSize: 14, fontWeight: 700, color: "#f5f5f5", lineHeight: 1.2, fontFamily: DISPLAY_FONT }}>{base + bonus}</div>
                                {bonus > 0 && <div style={{ fontSize: 7, color: "#86efac" }}>+{bonus}</div>}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  /* Pack tab */
                  <>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
                      <BagFilterTabs filter={bagFilter} onChange={setBagFilter} counts={{
                        all: allPackItems.length,
                        weapon: allPackItems.filter((i) => i.item_type === "weapon").length,
                        armor: allPackItems.filter((i) => i.item_type === "armor").length,
                        consumable: allPackItems.filter((i) => i.item_type === "consumable" || i.item_type === "magic" || i.item_type === "scroll" || i.item_type === "revive").length,
                      }} />
                      <span style={{ font: "11px/1 var(--font-mono)", color: "var(--fg-mute)" }}>
                        {allPackItems.length}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
                      {SORT_LABELS.map(({ key, label }) => (
                        <button key={key} onClick={() => setSort(key)}
                          style={{ background: sort === key ? "#2a2d3a" : "none", color: sort === key ? "#c084fc" : "#6b7280", border: sort === key ? "1px solid #c084fc55" : "1px solid #2a2d33", borderRadius: 20, padding: "4px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
                        >{label}</button>
                      ))}
                    </div>
                    {packItems.length === 0 ? (
                      <div style={{ color: "#374151", fontSize: 13, textAlign: "center", marginTop: 32 }}>
                        {allPackItems.length === 0 ? "Nothing in your pack" : `No ${bagFilter === "all" ? "" : bagFilter + " "}items match`}
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {stackPackItems(packItems).map(({ item, ids }) => {
                          const rc = RARITY_COLOR[item.rarity];
                          const isSelected = ids.includes(selectedId ?? -1);
                          const isMatch = highlightSlot !== null && item.slot === highlightSlot;
                          const stackCount = ids.length;
                          return (
                            <div key={item.id} onClick={() => setSelectedId(selectedId === item.id ? null : item.id)}
                              style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 10, background: isSelected ? "#1e1c2e" : "#1d1f23", border: `1px solid ${isSelected ? "#fff" : isMatch ? "#c084fc" : "#2a2d33"}`, cursor: "pointer", boxShadow: isMatch ? "0 0 6px #c084fc33" : undefined }}
                            >
                              <Icon name={itemIcon(item)} size={28} color={itemIconColor(item) ?? rc} />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 14, fontWeight: 600, color: "#f5f5f5", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                  {resourceDisplayName(item)}
                                  {stackCount > 1 && (
                                    <span style={{ marginLeft: 6, fontSize: 12, color: rc, fontWeight: 700 }}>×{stackCount}</span>
                                  )}
                                </div>
                                <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
                                  {slotLabel(item)}{item.stat_bonus && statBonusSummary(item.stat_bonus) ? ` · ${statBonusSummary(item.stat_bonus)}` : ""}
                                </div>
                              </div>
                              {(item.level_req ?? 1) > 1 && (
                                <span style={{ fontSize: 10, color: "#6b7280", flexShrink: 0 }}>L{item.level_req}</span>
                              )}
                              <div style={{ flexShrink: 0, textAlign: "right" }}>
                                <div style={{ fontSize: 12, color: rc, fontWeight: 600 }}>+{item.power}</div>
                                <span style={{ ...smallBadge, borderColor: `${rc}55`, color: rc, background: `${rc}15` }}>{item.rarity}</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Bottom sheet — item detail */}
              {selected && (
                <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 10, background: "#12141a", borderTop: "1px solid #2a2d33", borderRadius: "12px 12px 0 0", maxHeight: "60vh", overflowY: "auto", padding: 18, boxShadow: "0 -8px 32px rgba(0,0,0,0.7)" }}>
                  <ItemDetailPopover
                    item={selected} inQuest={inQuest} selfId={selfId} characterLevel={characterLevel} inline
                    equippedInSlot={selected.slot ? equippedForSlot(selected.slot) ?? null : null}
                    onEquip={(id) => { onEquip(id); setSelectedId(null); }}
                    onUnequip={(id) => { onUnequip(id); setSelectedId(null); }}
                    onSell={(id) => { onSell(id); setSelectedId(null); }}
                    onUse={(id) => { onUse(id); setSelectedId(null); }}
                    onGive={(id, uid, name) => { onGive(id, uid, name); setSelectedId(null); }}
                    onClose={() => setSelectedId(null)}
                  />
                </div>
              )}
            </div>
          ) : (
            /* ── Desktop: 3-panel layout ── */
            <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
              {/* Left — character sheet + paper doll */}
              <div style={{ width: 360, flexShrink: 0, borderRight: "1px solid #2a2d33", overflowY: "auto", padding: "20px 8px", display: "flex", flexDirection: "column", alignItems: "stretch", gap: 14 }}>
                {characterSheet && (
                  <div style={{ alignSelf: "stretch", width: "100%" }}>{characterSheet}</div>
                )}
                <div style={{ ...muted, fontSize: 10, textTransform: "uppercase", letterSpacing: 1.5, alignSelf: "flex-start", fontFamily: DISPLAY_FONT }}>Equipped — drag items here to equip</div>
                {(() => {
                  const slotCellHeight = 96;
                  const gap = 6;
                  const colHeight = slotCellHeight * 4 + gap * 3;
                  const renderSlot = (s: EquipSlot) => (
                    <DollSlotCell
                      key={s}
                      slot={s}
                      item={equippedForSlot(s)}
                      isHighlighted={highlightSlot === s}
                      isSelected={selectedId === (equippedForSlot(s)?.id ?? -1)}
                      onSlotClick={(sl) => setHighlightSlot(highlightSlot === sl ? null : sl)}
                      onItemClick={(id) => setSelectedId(selectedId === id ? null : id)}
                      characterLevel={characterLevel}
                    />
                  );
                  const leftSlots: EquipSlot[] = ["helmet", "body", "amulet", "ring"];
                  const rightSlots: EquipSlot[] = ["main_hand", "off_hand", "pants", "boots"];
                  return (
                    <div style={{ display: "flex", alignItems: "stretch", justifyContent: "space-between", width: "100%" }}>
                      <div style={{ display: "grid", gridTemplateRows: `repeat(4, ${slotCellHeight}px)`, gap }}>
                        {leftSlots.map(renderSlot)}
                      </div>
                      {character ? (
                        <FigureTile character={character} height={colHeight} />
                      ) : (
                        <div style={{ flex: 1, minWidth: 96, height: colHeight }} />
                      )}
                      <div style={{ display: "grid", gridTemplateRows: `repeat(4, ${slotCellHeight}px)`, gap }}>
                        {rightSlots.map(renderSlot)}
                      </div>
                    </div>
                  );
                })()}
                {highlightSlot && (
                  <div style={{ fontSize: 11, color: "#c084fc88", marginTop: 4, textAlign: "center" }}>
                    Drag or click a matching item to equip in {SLOT_LABELS[highlightSlot]}
                  </div>
                )}
                {character?.hp !== undefined && (() => {
                  const hpPct = character.max_hp > 0 ? Math.max(0, character.hp / character.max_hp) : 0;
                  const hpCol = hpPct < 0.25 ? "#dc2626" : hpPct < 0.5 ? "#d97706" : "#16a34a";
                  const armorMax = Math.floor((character.armor_power ?? 0) / 2);
                  const shieldPct = armorMax > 0 ? Math.min(1, character.shield / armorMax) : 0;
                  return (
                    <div style={{ alignSelf: "stretch", padding: "10px 12px", background: "var(--bg-card-2)", borderRadius: "var(--radius-md)", border: "1px solid var(--border-faint)", display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ font: "10px/1 var(--font-mono)", textTransform: "uppercase", letterSpacing: 1, color: "var(--fg-faintest)", marginBottom: 2 }}>Vitals</div>
                      {/* HP bar */}
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ font: "9px/1 var(--font-mono)", color: "var(--fg-mute)", width: 22, flexShrink: 0, textTransform: "uppercase", letterSpacing: 0.8 }}>HP</span>
                        <div className="bar" style={{ flex: 1 }}>
                          <i style={{ width: `${hpPct * 100}%`, background: hpCol }} />
                        </div>
                        <span style={{ font: "10px/1 var(--font-mono)", color: "var(--fg-3)", minWidth: 44, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {character.hp}/{character.max_hp}
                        </span>
                      </div>
                      {/* Shield bar — only shown when character has armor */}
                      {armorMax > 0 && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ font: "9px/1 var(--font-mono)", color: "#7dd3fc", width: 22, flexShrink: 0, textTransform: "uppercase", letterSpacing: 0.8 }}>SH</span>
                          <div className="bar" style={{ flex: 1, boxShadow: character.shield > 0 ? "0 0 5px rgba(96,165,250,.35)" : "none" }}>
                            <i style={{ width: `${shieldPct * 100}%`, background: "repeating-linear-gradient(45deg,#93c5fd,#93c5fd 4px,#60a5fa 4px,#60a5fa 8px)" }} />
                          </div>
                          <span style={{ font: "10px/1 var(--font-mono)", color: character.shield > 0 ? "#7dd3fc" : "var(--fg-mute)", minWidth: 44, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                            {character.shield}/{armorMax}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })()}
                {character?.str !== undefined && (
                  <LoadoutTotals character={character} items={items} />
                )}
                {character?.str !== undefined && (
                  <div style={{ alignSelf: "stretch", padding: "10px 12px", background: "#16181c", borderRadius: 8, border: "1px solid #2a2d33" }}>
                    <div style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 6, fontFamily: DISPLAY_FONT }}>Primary Stats</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 4 }}>
                      {(["str", "int_stat", "vit", "agi", "dex"] as StatKey[]).map((key) => {
                        const base = character[key] ?? 5;
                        const bonus = dollEquipBonuses[key] ?? 0;
                        return (
                          <div key={key} style={{ textAlign: "center", background: "#1d1f23", borderRadius: 5, padding: "5px 3px" }}>
                            <div style={{ fontSize: 8, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.8, fontFamily: DISPLAY_FONT }}>
                              {key === "int_stat" ? "INT" : key.toUpperCase()}
                            </div>
                            <div style={{ fontSize: 14, fontWeight: 700, color: "#f5f5f5", lineHeight: 1.2, fontFamily: DISPLAY_FONT }}>{base + bonus}</div>
                            {bonus > 0 && <div style={{ fontSize: 7, color: "#86efac" }}>+{bonus}</div>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Center — pack */}
              <DroppablePackPanel>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, gap: 8, flexWrap: "wrap" }}>
                  <BagFilterTabs filter={bagFilter} onChange={setBagFilter} counts={{
                    all: allPackItems.length,
                    weapon: allPackItems.filter((i) => i.item_type === "weapon").length,
                    armor: allPackItems.filter((i) => i.item_type === "armor").length,
                    consumable: allPackItems.filter((i) => i.item_type === "consumable" || i.item_type === "magic" || i.item_type === "scroll" || i.item_type === "revive").length,
                  }} />
                  <span style={{ font: "11px/1 var(--font-mono)", color: "var(--fg-mute)" }}>
                    {allPackItems.length} item{allPackItems.length === 1 ? "" : "s"}
                  </span>
                </div>
                <div style={{ ...muted, fontSize: 10, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 12, fontFamily: DISPLAY_FONT }}>
                  Drag equipped items here to unequip
                </div>
                {packItems.length === 0 ? (
                  <div style={{ color: "#374151", fontSize: 13, textAlign: "center", marginTop: 32 }}>
                    {allPackItems.length === 0 ? "Nothing in your pack" : `No ${bagFilter === "all" ? "" : bagFilter + " "}items match`}
                  </div>
                ) : viewMode === "grid" ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 10 }}>
                    {stackPackItems(packItems).map(({ item, ids }) => (
                      <DraggablePackItem key={item.id} item={item}
                        isSelected={ids.includes(selectedId ?? -1)}
                        isMatch={highlightSlot !== null && item.slot === highlightSlot}
                        viewMode="grid"
                        characterLevel={characterLevel}
                        stackCount={ids.length}
                        onSelect={() => setSelectedId(selectedId === item.id ? null : item.id)}
                      />
                    ))}
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    {stackPackItems(packItems).map(({ item, ids }) => (
                      <DraggablePackItem key={item.id} item={item}
                        isSelected={ids.includes(selectedId ?? -1)}
                        isMatch={highlightSlot !== null && item.slot === highlightSlot}
                        viewMode="list"
                        characterLevel={characterLevel}
                        stackCount={ids.length}
                        onSelect={() => setSelectedId(selectedId === item.id ? null : item.id)}
                      />
                    ))}
                  </div>
                )}
              </DroppablePackPanel>

              {/* Right — detail pane */}
              {selected ? (
                <div style={{ width: 280, flexShrink: 0, borderLeft: "1px solid #2a2d33", overflowY: "auto", padding: 18 }}>
                  <ItemDetailPopover
                    item={selected} inQuest={inQuest} selfId={selfId} characterLevel={characterLevel} inline
                    equippedInSlot={selected.slot ? equippedForSlot(selected.slot) ?? null : null}
                    onEquip={(id) => { onEquip(id); setSelectedId(null); }}
                    onUnequip={(id) => { onUnequip(id); setSelectedId(null); }}
                    onSell={(id) => { onSell(id); setSelectedId(null); }}
                    onUse={(id) => { onUse(id); setSelectedId(null); }}
                    onGive={(id, uid, name) => { onGive(id, uid, name); setSelectedId(null); }}
                    onClose={() => setSelectedId(null)}
                  />
                </div>
              ) : (
                <div style={{ width: 280, flexShrink: 0, borderLeft: "1px solid #2a2d33", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <div style={{ color: "#374151", fontSize: 12, textAlign: "center", padding: 16 }}>Select an item to view details</div>
                </div>
              )}
            </div>
          )}

          <DragOverlay dropAnimation={null}>
            {activeItem ? <DragItemPreview item={activeItem} size={dragRect} /> : null}
          </DragOverlay>
        </DndContext>
      </div>
    </div>
  );
}

export function InventoryCard({
  items,
  inQuest,
  artUrl,
  selfId,
  characterLevel,
  onEquip,
  onUnequip,
  onSell,
  onUse,
  onGive,
  onOpenFull,
}: {
  items: Item[];
  inQuest: boolean;
  artUrl: string | null;
  selfId: string;
  characterLevel?: number;
  onEquip: (itemId: number) => void;
  onUnequip: (itemId: number) => void;
  onSell: (itemId: number) => void;
  onUse: (itemId: number) => void;
  onGive: (itemId: number, toUserId: string, toName: string) => void;
  onOpenFull?: () => void;
}) {
  const [sort, setSort] = useState<InventorySort>("type");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const { refs, floatingStyles, context } = useFloating({
    open: selectedId !== null,
    onOpenChange: (open) => { if (!open) setSelectedId(null); },
    middleware: [offset(10), flip({ padding: 8 }), shift({ padding: 8 })],
    placement: "right",
    whileElementsMounted: autoUpdate,
  });

  const { getFloatingProps } = useInteractions([
    useDismiss(context, { outsidePress: true }),
  ]);

  function toggleSelect(id: number, el: HTMLElement) {
    if (selectedId === id) {
      setSelectedId(null);
      refs.setReference(null);
    } else {
      setSelectedId(id);
      refs.setReference(el);
    }
  }

  const [highlightSlot, setHighlightSlot] = useState<EquipSlot | null>(null);
  const equippedForSlot = (slot: EquipSlot) => items.find(
    (i) => i.equipped && (i.slot === slot || (i.slot === null && (
      (slot === "main_hand" && i.item_type === "weapon") ||
      (slot === "body" && i.item_type === "armor")
    )))
  );

  const sorted = sortItems(items, sort);
  const packItems = sorted.filter((i) => !i.equipped);
  const selected = selectedId != null ? items.find((i) => i.id === selectedId) ?? null : null;

  function renderDollSlot(slot: EquipSlot) {
    const item = equippedForSlot(slot);
    const isHighlighted = highlightSlot === slot;
    const label = SLOT_LABELS[slot];
    if (item) {
      return (
        <div key={slot} style={{ position: "relative" }}>
          {isHighlighted && (
            <div style={{ position: "absolute", inset: 0, borderRadius: 9, border: "2px solid #c084fc", zIndex: 2, pointerEvents: "none" }} />
          )}
          <ItemSlot item={item} selected={selectedId === item.id} characterLevel={characterLevel} onSelect={(el) => { toggleSelect(item.id, el); setHighlightSlot(null); }} />
        </div>
      );
    }
    return (
      <div
        key={slot}
        onClick={() => setHighlightSlot(isHighlighted ? null : slot)}
        title={`${label} — empty`}
        style={{
          width: 72, height: 72,
          background: "#141618",
          border: isHighlighted ? "2px solid #c084fc55" : "2px dashed #1e2128",
          borderRadius: 8,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3,
          cursor: "pointer",
          transition: "border-color 0.15s",
        }}
      >
        <Icon name={SLOT_ICON[slot]} size={20} color={isHighlighted ? "#c084fc66" : "#2e3440"} style={slot === "main_hand" ? { transform: "scaleX(-1)" } : undefined} />
        <div style={{ fontSize: 8, color: isHighlighted ? "#c084fc88" : "#374151", textAlign: "center", lineHeight: 1.2 }}>
          {label}
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div style={card}>
        <Banner src={artUrl} alt="Inventory" />
        <h2 style={h2}>Inventory</h2>
        <p style={muted}>Empty. Win a quest or visit the shop in Slack.</p>
      </div>
    );
  }

  const SORT_LABELS: { key: InventorySort; label: string }[] = [
    { key: "type", label: "Type" },
    { key: "rarity", label: "Rarity" },
    { key: "power", label: "Power" },
    { key: "lvl", label: "Lvl" },
  ];

  return (
    <div style={card}>
      <Banner src={artUrl} alt="Inventory" />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h2 style={{ ...h2, margin: 0 }}>Inventory</h2>
        {onOpenFull && items.length > 0 && (
          <button
            onClick={onOpenFull}
            title="Open full inventory"
            style={{
              background: "none", border: "1px solid #2a2d33", borderRadius: 6,
              color: "#9ca3af", cursor: "pointer", padding: "3px 8px",
              fontSize: 11, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4,
            }}
          >
            <Icon name="perspective-dice-six" size={11} /> Full view
          </button>
        )}
      </div>
      {inQuest && (
        <p style={{ ...muted, fontSize: 12, marginTop: 8 }}>
          Selling is disabled while a quest is active.
        </p>
      )}
      {/* Equipment paper-doll */}
      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase" as const, letterSpacing: 0.8, fontWeight: 600, marginBottom: 6, fontFamily: DISPLAY_FONT }}>
          Equipped
        </div>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 72px)", gap: 4 }}>
            {([null, "helmet", null, "main_hand", "body", "off_hand", "amulet", "pants", "ring", null, "boots", null] as (EquipSlot | null)[]).map((s, i) =>
              s ? renderDollSlot(s) : <div key={i} style={{ width: 72, height: 72 }} />
            )}
          </div>
        </div>
      </div>
      {/* Pack */}
      {packItems.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" as const }}>
            <span style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase" as const, letterSpacing: 0.8, fontWeight: 600, fontFamily: DISPLAY_FONT }}>
              Pack ({packItems.length})
            </span>
            {SORT_LABELS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setSort(key)}
                style={{
                  background: sort === key ? "#2a2d3a" : "#1d1f23",
                  color: sort === key ? "#c084fc" : "#9aa0a6",
                  border: sort === key ? "1px solid #c084fc55" : "1px solid #2a2d33",
                  borderRadius: 20,
                  padding: "3px 10px",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  transition: "all 0.1s",
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, 72px)", gap: 6 }}>
            {packItems.map((item) => (
              <div key={item.id} style={{ position: "relative" }}>
                {highlightSlot !== null && item.slot === highlightSlot && (
                  <div style={{ position: "absolute", inset: 0, borderRadius: 9, border: "2px solid #c084fc", zIndex: 2, pointerEvents: "none" }} />
                )}
                <ItemSlot item={item} selected={selectedId === item.id} characterLevel={characterLevel} onSelect={(el) => toggleSelect(item.id, el)} />
              </div>
            ))}
          </div>
        </div>
      )}
      {/* Floating popover — rendered outside the card via portal */}
      {selected && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} initialFocus={-1}>
            <div
              ref={refs.setFloating}
              style={{ ...floatingStyles, zIndex: 1000, outline: "none" }}
              {...getFloatingProps()}
            >
              <ItemDetailPopover
                item={selected}
                inQuest={inQuest}
                selfId={selfId}
                characterLevel={characterLevel}
                equippedInSlot={selected.slot ? equippedForSlot(selected.slot) ?? null : null}
                onEquip={(id) => { onEquip(id); setSelectedId(null); }}
                onUnequip={(id) => { onUnequip(id); setSelectedId(null); }}
                onSell={(id) => { onSell(id); setSelectedId(null); }}
                onUse={(id) => { onUse(id); setSelectedId(null); }}
                onGive={(id, uid, name) => { onGive(id, uid, name); setSelectedId(null); }}
                onClose={() => setSelectedId(null)}
              />
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </div>
  );
}
