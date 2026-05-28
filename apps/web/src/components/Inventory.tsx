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
import { findCatalogEntry, sellPriceFor, type StatKey } from "@gantt-quest/core";
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
    cursor?: CSSProperties["cursor"];
    onClick?: MouseEventHandler<HTMLDivElement>;
  } & Omit<HTMLAttributes<HTMLDivElement>, "onClick">
>(function ItemCell(
  { item, size = 72, mode = "icon", selected, isOver, isDragging, isMatch,
    showSellPrice, characterLevel, cursor, onClick, style: extraStyle, ...rest },
  ref,
) {
  const rc = RARITY_COLOR[item.rarity];
  const borderColor = isOver ? "#7dd3fc"
    : selected ? "#fff"
    : item.equipped ? "#b89b3a"
    : isMatch ? "#c084fc"
    : `${rc}99`;
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
        border: `2px solid ${borderColor}`,
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
      {(mode === "icon" || (mode === "compact" && powerValue > 0)) && (
        <div style={{ position: "absolute", bottom: 3, right: 3, minWidth: 18, height: 18, background: "#0a0b0e", border: `1px solid ${rc}55`, borderRadius: "50%", fontSize: 9, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", color: rc, lineHeight: 1, padding: "0 2px" }}>
          +{powerValue}
        </div>
      )}
      {elementEmoji && mode === "icon" && (
        <div style={{ position: "absolute", bottom: 3, left: 3, fontSize: 9, lineHeight: 1 }} title={item.element ?? undefined}>
          {elementEmoji}
        </div>
      )}
      {mode === "compact" && (
        <div style={{ fontSize: 10, color: "#9ca3af", lineHeight: 1.1, maxWidth: size - 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: "0 4px" }}>
          {item.item_name}
        </div>
      )}
      {mode === "detailed" && (
        <>
          <div style={{ marginTop: 2, fontSize: 10, fontWeight: 600, color: "#e2e8f0", lineHeight: 1.3, wordBreak: "break-word" }}>{item.item_name}</div>
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

export function ItemDetailPopover({
  item,
  inQuest,
  selfId,
  characterLevel,
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
            {item.item_name}
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
  return (
    <div ref={setDropRef} onClick={() => onSlotClick(slot)} title={`${label} — empty`}
      style={{
        width: S, height: S, background: isOver ? "#151d2e" : "#141618",
        border: isOver ? "2px solid #7dd3fc88" : isHighlighted ? "2px solid #c084fc55" : "2px dashed #1e2128",
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
  item, isSelected, isMatch, viewMode, onSelect, characterLevel,
}: {
  item: Item; isSelected: boolean; isMatch: boolean;
  viewMode: "grid" | "list"; onSelect: () => void; characterLevel?: number;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `pack-item-${item.id}`,
    data: { itemId: item.id, equipped: false, itemSlot: item.slot },
  });
  const rc = RARITY_COLOR[item.rarity];
  const sellPrice = sellPriceFor(item.item_type, item.rarity, { power: item.power, sharpens_count: item.sharpens_count });
  const isLevelLocked = (characterLevel ?? Infinity) < (item.level_req ?? 1);
  if (viewMode === "list") {
    return (
      <div ref={setNodeRef} {...listeners} {...attributes} onClick={onSelect}
        style={{
          display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
          borderRadius: 8, background: isSelected ? "#1e1c2e" : "#1d1f23",
          border: `1px solid ${isSelected ? "#fff" : isMatch ? "#c084fc" : "#2a2d33"}`,
          cursor: isDragging ? "grabbing" : "grab", opacity: isDragging ? 0.35 : isLevelLocked ? 0.45 : 1,
          transition: "background 0.1s", boxShadow: isMatch ? "0 0 6px #c084fc33" : undefined,
          touchAction: "none",
        }}
      >
        <Icon name={itemIcon(item)} size={20} color={itemIconColor(item) ?? rc} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#f5f5f5", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.item_name}</div>
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
      selected={isSelected}
      isDragging={isDragging}
      isMatch={isMatch}
      showSellPrice
      characterLevel={characterLevel}
      cursor={isDragging ? "grabbing" : "grab"}
      onClick={onSelect}
      {...(listeners as HTMLAttributes<HTMLDivElement>)}
      {...(attributes as HTMLAttributes<HTMLDivElement>)}
    />
  );
}

export function DragItemPreview({ item }: { item: Item }) {
  const rc = RARITY_COLOR[item.rarity];
  return (
    <div style={{ width: 80, background: "#1d1f23", border: `2px solid ${rc}`, borderRadius: 10, padding: "8px 6px 6px", textAlign: "center", boxShadow: "0 8px 24px rgba(0,0,0,0.7)", opacity: 0.95 }}>
      <Icon name={itemIcon(item)} size={32} color={itemIconColor(item) ?? rc} />
      <div style={{ marginTop: 5, fontSize: 9, fontWeight: 600, color: "#e2e8f0", lineHeight: 1.3, wordBreak: "break-word" }}>{item.item_name}</div>
    </div>
  );
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
  const packItems = sorted.filter((i) => !i.equipped);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = selectedId != null ? items.find((i) => i.id === selectedId) ?? null : null;
  const [highlightSlot, setHighlightSlot] = useState<EquipSlot | null>(null);
  const [activeItemId, setActiveItemId] = useState<number | null>(null);
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
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveItemId(null);
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
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 16, fontWeight: 700, color: "#f5f5f5", fontFamily: DISPLAY_FONT }}>Inventory</span>
            <span style={{ ...muted, fontSize: 12 }}>{items.length} item{items.length !== 1 ? "s" : ""}</span>
            {character && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, paddingLeft: 12, borderLeft: "1px solid #2a2d33", fontSize: 12, color: "#9aa0a6", flexWrap: "wrap" }}>
                <span style={{ color: "#f5f5f5", fontWeight: 600, fontFamily: DISPLAY_FONT }}>{character.name}</span>
                <span style={{ color: "#c084fc" }}>{character.class}</span>
                <span title="Level">Lv {character.level}</span>
                <span style={{ color: "#86efac" }} title="HP"><Icon name="health-normal" size={11} /> {character.hp}/{character.max_hp}</span>
                {character.max_mana > 0 && (
                  <span style={{ color: "#a78bfa" }} title="Mana"><Icon name="wizard-staff" size={11} /> {character.mana}/{character.max_mana}</span>
                )}
                <span style={{ color: "#fbbf24" }} title="Gold"><Icon name="gold-bar" size={11} /> {character.gold}g</span>
              </div>
            )}
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
                    <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
                      {SORT_LABELS.map(({ key, label }) => (
                        <button key={key} onClick={() => setSort(key)}
                          style={{ background: sort === key ? "#2a2d3a" : "none", color: sort === key ? "#c084fc" : "#6b7280", border: sort === key ? "1px solid #c084fc55" : "1px solid #2a2d33", borderRadius: 20, padding: "4px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
                        >{label}</button>
                      ))}
                    </div>
                    {packItems.length === 0 ? (
                      <div style={{ color: "#374151", fontSize: 13, textAlign: "center", marginTop: 32 }}>Nothing in your pack</div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {packItems.map((item) => {
                          const rc = RARITY_COLOR[item.rarity];
                          const isSelected = selectedId === item.id;
                          const isMatch = highlightSlot !== null && item.slot === highlightSlot;
                          return (
                            <div key={item.id} onClick={() => setSelectedId(isSelected ? null : item.id)}
                              style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 10, background: isSelected ? "#1e1c2e" : "#1d1f23", border: `1px solid ${isSelected ? "#fff" : isMatch ? "#c084fc" : "#2a2d33"}`, cursor: "pointer", boxShadow: isMatch ? "0 0 6px #c084fc33" : undefined }}
                            >
                              <Icon name={itemIcon(item)} size={28} color={itemIconColor(item) ?? rc} />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 14, fontWeight: 600, color: "#f5f5f5", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.item_name}</div>
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
              {/* Left — paper doll */}
              <div style={{ width: 340, flexShrink: 0, borderRight: "1px solid #2a2d33", overflowY: "auto", padding: "20px 16px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                <div style={{ ...muted, fontSize: 10, textTransform: "uppercase", letterSpacing: 1.5, alignSelf: "flex-start", fontFamily: DISPLAY_FONT }}>Equipped — drag items here to equip</div>
                <div style={{ display: "flex", justifyContent: "center" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 96px)", gap: 6 }}>
                    {([null, "helmet", null, "main_hand", "body", "off_hand", "amulet", "pants", "ring", null, "boots", null] as (EquipSlot | null)[]).map((s, i) =>
                      s
                        ? <DollSlotCell key={s} slot={s} item={equippedForSlot(s)}
                            isHighlighted={highlightSlot === s} isSelected={selectedId === (equippedForSlot(s)?.id ?? -1)}
                            onSlotClick={(sl) => setHighlightSlot(highlightSlot === sl ? null : sl)}
                            onItemClick={(id) => setSelectedId(selectedId === id ? null : id)}
                            characterLevel={characterLevel}
                          />
                        : <div key={i} style={{ width: 96, height: 96 }} />
                    )}
                  </div>
                </div>
                {highlightSlot && (
                  <div style={{ fontSize: 11, color: "#c084fc88", marginTop: 4, textAlign: "center" }}>
                    Drag or click a matching item to equip in {SLOT_LABELS[highlightSlot]}
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

              {/* Center — pack */}
              <DroppablePackPanel>
                <div style={{ ...muted, fontSize: 10, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 12, fontFamily: DISPLAY_FONT }}>
                  Pack {packItems.length > 0 ? `(${packItems.length})` : "(empty)"} — drag equipped items here to unequip
                </div>
                {packItems.length === 0 ? (
                  <div style={{ color: "#374151", fontSize: 13, textAlign: "center", marginTop: 32 }}>Nothing in your pack</div>
                ) : viewMode === "grid" ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 10 }}>
                    {packItems.map((item) => (
                      <DraggablePackItem key={item.id} item={item}
                        isSelected={selectedId === item.id}
                        isMatch={highlightSlot !== null && item.slot === highlightSlot}
                        viewMode="grid"
                        characterLevel={characterLevel}
                        onSelect={() => setSelectedId(selectedId === item.id ? null : item.id)}
                      />
                    ))}
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    {packItems.map((item) => (
                      <DraggablePackItem key={item.id} item={item}
                        isSelected={selectedId === item.id}
                        isMatch={highlightSlot !== null && item.slot === highlightSlot}
                        viewMode="list"
                        characterLevel={characterLevel}
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
            {activeItem ? <DragItemPreview item={activeItem} /> : null}
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
