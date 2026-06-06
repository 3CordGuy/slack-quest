// Abilities tab for the Inventory screen. Lists the player's class talent
// tree, shows owned vs. locked nodes, lets them buy ranks (spend talent_points)
// and configure their equipped loadout (4 active slots + 1-3 passive slots).
//
// API surface (worker.ts):
//   GET  /api/character/talents       — { talent_points, owned, loadout, level, class }
//   POST /api/character/talents/buy   — { node_id, target_rank } → { ok, character }
//   POST /api/character/talents/respec — () → { ok, character, paid }
//   POST /api/character/loadout       — { active, passive } → { ok, character }

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AbilityLoadout,
  ClassId,
  TalentCategory,
  TalentNodeDef,
} from "@gantt-quest/core";
import {
  MAX_ACTIVE_SLOTS,
  nodesForClass,
  passiveSlotsForLevel,
  pointCostForRank,
  classIdForTree,
} from "@gantt-quest/core";
import { Icon } from "../icons";
import { HoverTooltip } from "./ui";
import { useIsMobile } from "../CombatShared";

const RESPEC_GOLD = 500;
const DISPLAY_FONT = "var(--font-display, 'Cinzel', serif)";

type TalentApi = {
  talent_points: number;
  owned: Record<string, number>;
  loadout: AbilityLoadout | null;
  level: number;
  class: string;
};

type SubKind = "active" | "passive";
type CategoryFilter = "all" | TalentCategory;

const CATEGORY_LABELS: Record<CategoryFilter, string> = {
  all: "All",
  damage: "Damage",
  control: "Control",
  support: "Support",
  defense: "Defense",
  utility: "Utility",
};

export function AbilitiesPanel({
  characterGold,
  onCharacterUpdated,
}: {
  characterGold: number | null;
  onCharacterUpdated?: () => void;
}) {
  const [data, setData] = useState<TalentApi | null>(null);
  const [subKind, setSubKind] = useState<SubKind>("active");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickingSlot, setPickingSlot] = useState<{ kind: SubKind; index: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Scroll NodeDetail into view when it mounts/changes. The detail panel
  // renders as a sibling below the flex-1 scrollable node grid; if the
  // user clicked a cell near the bottom of a long list (Ring of Frost
  // being the last devops_mage entry is the canonical case), the panel
  // can appear past the visible viewport with nothing scrolling to it.
  const detailRef = useRef<HTMLDivElement | null>(null);

  async function refresh() {
    try {
      const res = await fetch("/api/character/talents");
      if (!res.ok) {
        setError("Failed to load abilities");
        return;
      }
      const json = (await res.json()) as TalentApi;
      setData(json);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  // When the user selects a node, scroll the detail panel into view so the
  // Buy / Equip / Unequip buttons are always reachable — otherwise clicking
  // a node near the bottom of the scrollable list (e.g. Ring of Frost as
  // the last devops_mage entry) leaves the detail panel below the viewport.
  useEffect(() => {
    if (!selectedId) return;
    const el = detailRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedId]);

  const classId: ClassId | undefined = useMemo(
    () => (data ? classIdForTree(data.class) : undefined),
    [data],
  );
  const allNodes: TalentNodeDef[] = useMemo(
    () => (classId ? nodesForClass(classId) : []),
    [classId],
  );
  const filteredNodes = useMemo(() => {
    return allNodes.filter((n) => {
      if (n.ability.kind !== subKind) return false;
      if (categoryFilter !== "all" && n.category !== categoryFilter) return false;
      return true;
    });
  }, [allNodes, subKind, categoryFilter]);

  const selectedNode = selectedId ? allNodes.find((n) => n.id === selectedId) ?? null : null;

  async function buyRank(node: TalentNodeDef, targetRank: number) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/character/talents/buy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ node_id: node.id, target_rank: targetRank }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? "buy_failed");
      } else {
        await refresh();
        onCharacterUpdated?.();
      }
    } finally {
      setBusy(false);
    }
  }

  async function respec() {
    if (busy) return;
    if (!confirm(`Respec all talent points for ${RESPEC_GOLD} gold?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/character/talents/respec", { method: "POST" });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? "respec_failed");
      } else {
        await refresh();
        onCharacterUpdated?.();
      }
    } finally {
      setBusy(false);
    }
  }

  async function writeLoadout(next: AbilityLoadout) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/character/loadout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        details?: {
          active_received: number;
          active_expected: number;
          passive_received: number;
          passive_expected: number;
          character_level: number;
        };
      };
      if (!res.ok || !json.ok) {
        // Make wrong_slot_count self-explanatory in the UI + console so any
        // future repro tells us which array is off without engine instrumentation.
        if (json.error === "wrong_slot_count" && json.details) {
          const d = json.details;
          const wrongActive = d.active_received !== d.active_expected;
          const wrongPassive = d.passive_received !== d.passive_expected;
          const parts: string[] = [];
          if (wrongActive) parts.push(`active ${d.active_received}/${d.active_expected}`);
          if (wrongPassive) parts.push(`passive ${d.passive_received}/${d.passive_expected}`);
          // eslint-disable-next-line no-console
          console.warn("[loadout] wrong_slot_count", { sent: next, details: d });
          setError(`Slot count off (${parts.join(", ")}) — try refreshing the page.`);
        } else {
          setError(json.error ?? "loadout_failed");
        }
      } else {
        await refresh();
        onCharacterUpdated?.();
      }
    } finally {
      setBusy(false);
    }
  }

  // One-click equip from the detail panel. Mirrors the inventory's item flow
  // where clicking "Equip" auto-routes the item to its matching gear slot.
  // Auto-targets the first empty slot of the matching kind; if every slot is
  // already full, replaces slot 0 (the user can re-arrange via slot-click).
  function quickEquipFromDetail(node: TalentNodeDef) {
    if (!data?.loadout) return;
    const kind = node.ability.kind;
    const slots = kind === "active" ? [...data.loadout.active] : [...data.loadout.passive];
    const emptyIdx = slots.findIndex((s) => s === null);
    const targetIdx = emptyIdx >= 0 ? emptyIdx : 0;
    slots[targetIdx] = node.id;
    writeLoadout({
      active: kind === "active" ? slots : data.loadout.active,
      passive: kind === "passive" ? slots : data.loadout.passive,
    });
  }

  // Finds which slot holds this node and nulls it. No-op if not equipped.
  function quickUnequipFromDetail(node: TalentNodeDef) {
    if (!data?.loadout) return;
    const kind = node.ability.kind;
    const slots = kind === "active" ? [...data.loadout.active] : [...data.loadout.passive];
    const idx = slots.findIndex((s) => s === node.id);
    if (idx < 0) return;
    slots[idx] = null;
    writeLoadout({
      active: kind === "active" ? slots : data.loadout.active,
      passive: kind === "passive" ? slots : data.loadout.passive,
    });
  }

  function equipToSlot(node: TalentNodeDef) {
    if (!pickingSlot || !data?.loadout) return;
    if (pickingSlot.kind !== node.ability.kind) return;
    const slots = pickingSlot.kind === "active" ? [...data.loadout.active] : [...data.loadout.passive];
    slots[pickingSlot.index] = node.id;
    const next: AbilityLoadout = {
      active: pickingSlot.kind === "active" ? slots : data.loadout.active,
      passive: pickingSlot.kind === "passive" ? slots : data.loadout.passive,
    };
    setPickingSlot(null);
    writeLoadout(next);
  }

  function clearSlot(kind: SubKind, index: number) {
    if (!data?.loadout) return;
    const slots = kind === "active" ? [...data.loadout.active] : [...data.loadout.passive];
    slots[index] = null;
    const next: AbilityLoadout = {
      active: kind === "active" ? slots : data.loadout.active,
      passive: kind === "passive" ? slots : data.loadout.passive,
    };
    writeLoadout(next);
  }

  if (!data) {
    return <div style={{ color: "#9ca3af", padding: 20, fontSize: 13 }}>{error ?? "Loading abilities…"}</div>;
  }

  // Marching-ants style border for a slot in pick mode. The dashes scroll
  // around the box (animating border-image-source position via background-
  // position on overlaid linear-gradients). Keyframes are emitted once via
  // an injected <style>; the class is applied in LoadoutSlot when isPicking.

  const ownedRank = (id: string) => data.owned[id] ?? 0;
  const equippedIds = new Set<string>([
    ...(data.loadout?.active ?? []).filter((x): x is string => !!x),
    ...(data.loadout?.passive ?? []).filter((x): x is string => !!x),
  ]);
  const passiveSlotCount = passiveSlotsForLevel(data.level);
  const canAffordRespec = (characterGold ?? 0) >= RESPEC_GOLD;
  // On mobile this panel lives inside a parent that already owns the
  // vertical scroll. Letting the node grid claim flex: 1 + its own
  // overflow:auto makes the panel exactly the height of the outer scroll
  // box — leaving zero room for the NodeDetail equip panel below the grid,
  // which is why the equip card doesn't appear on phones. Detect mobile
  // and let the grid auto-size so NodeDetail flows naturally beneath it
  // and the outer scroll reveals both.
  const isMobile = useIsMobile(640);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, flex: 1, minHeight: 0 }}>
      {/* Marching-ants animation for pick-mode slots. Four background gradients
          paint a dashed border on each side; their positions animate one dash
          unit (8px) over 800ms so the ants appear to chase around the box. */}
      <style>{`
        @keyframes gq-marching-ants {
          0%   { background-position: 0 0, 0 100%, 0 0, 100% 0; }
          100% { background-position: 16px 0, -16px 100%, 0 16px, 100% -16px; }
        }
        .gq-pick-marching {
          background-image:
            linear-gradient(90deg, #c084fc 50%, transparent 50%),
            linear-gradient(90deg, #c084fc 50%, transparent 50%),
            linear-gradient(0deg,  #c084fc 50%, transparent 50%),
            linear-gradient(0deg,  #c084fc 50%, transparent 50%);
          background-repeat: repeat-x, repeat-x, repeat-y, repeat-y;
          background-size: 16px 2px, 16px 2px, 2px 16px, 2px 16px;
          background-position: 0 0, 0 100%, 0 0, 100% 0;
          animation: gq-marching-ants 0.8s linear infinite;
        }
      `}</style>
      {/* Header — talent points + respec */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: DISPLAY_FONT, fontSize: 14, color: "#c084fc", letterSpacing: 0.3 }}>
            Talent Points
          </span>
          <span style={{ font: "16px/1 var(--font-mono)", color: "#fbbf24", fontWeight: 700 }}>
            {data.talent_points}
          </span>
        </div>
        <button
          onClick={respec}
          disabled={busy || !canAffordRespec}
          title={canAffordRespec ? `Respec all talents for ${RESPEC_GOLD}g` : `Need ${RESPEC_GOLD}g to respec`}
          style={{
            background: canAffordRespec ? "#3a2a00" : "#1d1f23",
            color: canAffordRespec ? "#fbbf24" : "#6b7280",
            border: `1px solid ${canAffordRespec ? "#fbbf2455" : "#2a2d33"}`,
            borderRadius: 6,
            padding: "5px 10px",
            fontSize: 11,
            cursor: canAffordRespec && !busy ? "pointer" : "not-allowed",
            fontFamily: "inherit",
          }}
        >
          Respec ({RESPEC_GOLD}g)
        </button>
      </div>

      {/* Sub-filter row */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 4 }}>
          {(["active", "passive"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setSubKind(k)}
              style={{
                background: subKind === k ? "var(--accent-ink-deep, #2a2d3a)" : "var(--bg-input, #1d1f23)",
                color: subKind === k ? "#c084fc" : "#9ca3af",
                border: `1px solid ${subKind === k ? "#c084fc55" : "var(--border-base, #2a2d33)"}`,
                borderRadius: 6,
                padding: "5px 11px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "inherit",
                textTransform: "capitalize",
              }}
            >
              {k}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {(Object.keys(CATEGORY_LABELS) as CategoryFilter[]).map((cat) => (
            <button
              key={cat}
              onClick={() => setCategoryFilter(cat)}
              style={{
                background: categoryFilter === cat ? "#2a2d3a" : "none",
                color: categoryFilter === cat ? "#7dd3fc" : "#6b7280",
                border: `1px solid ${categoryFilter === cat ? "#7dd3fc55" : "#2a2d33"}`,
                borderRadius: 16,
                padding: "3px 9px",
                fontSize: 10,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {CATEGORY_LABELS[cat]}
            </button>
          ))}
        </div>
      </div>

      {/* Equipped loadout strip */}
      <div>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1.5, color: "#6b7280", marginBottom: 6, fontFamily: DISPLAY_FONT }}>
          Equipped — {subKind === "active" ? "Active Slots" : "Passive Slots"}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(subKind === "active" ? data.loadout?.active ?? [] : data.loadout?.passive ?? []).map((id, i) => {
            const node = id ? allNodes.find((n) => n.id === id) : null;
            const isPicking = pickingSlot?.kind === subKind && pickingSlot?.index === i;
            return (
              <LoadoutSlot
                key={i}
                node={node ?? null}
                isPicking={isPicking}
                onPick={() => setPickingSlot(isPicking ? null : { kind: subKind, index: i })}
                onClear={() => clearSlot(subKind, i)}
              />
            );
          })}
          {subKind === "passive" && passiveSlotCount < 3 && (
            <div style={{ alignSelf: "center", fontSize: 10, color: "#6b7280", marginLeft: 6 }}>
              {passiveSlotCount === 1 ? "+2 slots unlock at L10, L30" : "+1 slot unlocks at L30"}
            </div>
          )}
        </div>
        {pickingSlot && (
          <div style={{
            fontSize: 12,
            color: "#e9d5ff",
            background: "#2a1f3a",
            border: "1px solid #c084fc55",
            borderRadius: 6,
            padding: "6px 10px",
            marginTop: 8,
            fontWeight: 600,
          }}>
            ↓ Click any owned {subKind} ability below to equip it here. Click the slot again to cancel.
          </div>
        )}
      </div>

      {/* Node grid */}
      <div style={{
        // On desktop: claim flex space + internally scroll. On mobile: drop
        // both so NodeDetail (sibling below) is reachable via the outer
        // wrapper's scroll instead of being pinned below a sealed flex box.
        ...(isMobile ? {} : { flex: 1, overflowY: "auto" as const }),
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
        gap: 8,
        alignContent: "start",
      }}>
        {filteredNodes.length === 0 ? (
          <div style={{ color: "#374151", fontSize: 13, padding: 20 }}>
            No {subKind} abilities match the {categoryFilter !== "all" ? CATEGORY_LABELS[categoryFilter].toLowerCase() : ""} filter.
          </div>
        ) : (
          filteredNodes.map((node) => (
            <NodeCell
              key={node.id}
              node={node}
              rank={ownedRank(node.id)}
              equipped={equippedIds.has(node.id)}
              selected={selectedId === node.id}
              level={data.level}
              points={data.talent_points}
              isPicking={pickingSlot !== null && pickingSlot.kind === node.ability.kind}
              onClick={() => {
                if (pickingSlot && pickingSlot.kind === node.ability.kind && ownedRank(node.id) >= 1) {
                  equipToSlot(node);
                } else {
                  setSelectedId(selectedId === node.id ? null : node.id);
                }
              }}
            />
          ))
        )}
      </div>

      {/* Detail panel */}
      {selectedNode && (
        <div ref={detailRef}>
        <NodeDetail
          node={selectedNode}
          rank={ownedRank(selectedNode.id)}
          equipped={equippedIds.has(selectedNode.id)}
          points={data.talent_points}
          level={data.level}
          onBuy={(targetRank) => buyRank(selectedNode, targetRank)}
          onEquip={() => quickEquipFromDetail(selectedNode)}
          onUnequip={() => quickUnequipFromDetail(selectedNode)}
          onClose={() => setSelectedId(null)}
          busy={busy}
        />
        </div>
      )}

      {error && (
        <div style={{ background: "#3a0a0a", color: "#fca5a5", padding: "8px 12px", borderRadius: 6, fontSize: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
}

// Shared tooltip body for any TalentNodeDef. Used by NodeCell, LoadoutSlot, and
// anywhere else an ability needs an on-hover blurb (mana / cd / range / AoE).
export function abilityTooltipContent(node: TalentNodeDef, rank?: number): JSX.Element {
  const a = node.ability;
  const mana = a.kind === "active" ? a.mana_cost : null;
  const cd = a.kind === "active" ? a.cooldown_turns : null;
  const range = a.kind === "active" ? a.range_tiles : undefined;
  const aoe = a.kind === "active" ? a.aoe_radius_tiles : undefined;
  return (
    <div>
      <div style={{ fontWeight: 700, color: "#c084fc", marginBottom: 4 }}>
        {a.name}{rank !== undefined && rank > 0 ? ` · R${rank}/${node.max_rank}` : ""}
      </div>
      <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 6, textTransform: "capitalize" }}>
        {node.category} · {a.kind}
      </div>
      <div style={{ fontSize: 12, color: "#d1d5db", lineHeight: 1.45, marginBottom: 6 }}>{a.blurb}</div>
      {node.rank_progression && (
        <div style={{ fontSize: 11, color: "#a78bfa", lineHeight: 1.45, marginBottom: 6, fontStyle: "italic" }}>
          {node.rank_progression}
        </div>
      )}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 11, color: "#9ca3af" }}>
        {mana !== null && mana > 0 && <span>{mana}✦ mana</span>}
        {cd ? <span>{cd}t CD</span> : null}
        {range !== undefined && range > 0 && <span>range {range}</span>}
        {aoe !== undefined && aoe > 0 && <span>AoE {aoe}</span>}
      </div>
    </div>
  );
}

function LoadoutSlot({
  node,
  isPicking,
  onPick,
  onClear,
}: {
  node: TalentNodeDef | null;
  isPicking: boolean;
  onPick: () => void;
  onClear: () => void;
}) {
  const filled = node !== null;
  const slot = (
    <div
      onClick={onPick}
      className={isPicking ? "gq-pick-marching" : undefined}
      title={
        isPicking
          ? "Click an ability below to equip — click slot again to cancel"
          : filled
            ? `Replace ${node.ability.name} — click then pick an ability`
            : "Click then pick an ability to equip"
      }
      style={{
        position: "relative",
        width: 64,
        height: 64,
        // In pick mode the marching-ants class paints the border via inset
        // gradients, so the actual border is transparent to avoid double-stacking.
        // backgroundColor (not background) — `background` shorthand would wipe
        // the gradient images set by the marching-ants class.
        backgroundColor: filled ? "#1e1c2e" : "#141618",
        border: isPicking
          ? "2px solid transparent"
          : filled
            ? "2px solid #b89b3a"
            : "2px dashed #1e2128",
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 3,
        cursor: "pointer",
        padding: 4,
        boxShadow: isPicking ? "0 0 10px #c084fc77" : undefined,
      }}
    >
      {filled ? (
        <>
          <Icon name={(node.ability as { icon?: string }).icon ?? "ace"} size={26} color="#c084fc" />
          <div style={{ fontSize: 8, color: "#fff", textAlign: "center", lineHeight: 1.1, fontWeight: 600 }}>
            {node.ability.name}
          </div>
          {/* Mobile-friendly hit target: the visible badge stays ~18×18, but
              transparent padding extends the tap area to 32×32 (well above
              the iOS 44pt rec when you include the slot border). Offsets are
              recomputed so the visible glyph still sits flush in the corner.
              background-clip ensures the visible chip respects the padding
              boundary instead of bleeding to the full button. */}
          <button
            onClick={(e) => { e.stopPropagation(); onClear(); }}
            onPointerDown={(e) => e.stopPropagation()}
            title={`Unequip ${node.ability.name}`}
            aria-label={`Unequip ${node.ability.name}`}
            style={{
              position: "absolute",
              // Was top/right -6 with an 18×18 button. Now the button is 32×32
              // with 7px of padding, so the visible 18×18 chip lives at the
              // same on-screen position: outer offset = old (-6) - padding (7).
              top: -13,
              right: -13,
              width: 32,
              height: 32,
              padding: 7,
              borderRadius: 16,
              background: "transparent",
              border: "none",
              color: "#9ca3af",
              fontSize: 11,
              lineHeight: 1,
              cursor: "pointer",
              fontFamily: "inherit",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              WebkitTapHighlightColor: "transparent",
              touchAction: "manipulation",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 18,
                height: 18,
                borderRadius: 9,
                background: "#1d1f23",
                border: "1px solid #4b5563",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                lineHeight: 1,
              }}
            >×</span>
          </button>
        </>
      ) : (
        <div style={{ fontSize: 10, color: isPicking ? "#c084fc88" : "#374151" }}>{isPicking ? "pick…" : "empty"}</div>
      )}
    </div>
  );
  if (!filled) return slot;
  return <HoverTooltip content={abilityTooltipContent(node)}>{slot}</HoverTooltip>;
}

function NodeCell({
  node,
  rank,
  equipped,
  selected,
  level,
  points,
  isPicking,
  onClick,
}: {
  node: TalentNodeDef;
  rank: number;
  equipped: boolean;
  selected: boolean;
  level: number;
  points: number;
  isPicking: boolean;
  onClick: () => void;
}) {
  const levelReq = node.level_req_per_rank[Math.max(0, rank)] ?? 1;
  const nextCost = rank < node.max_rank ? pointCostForRank(node, rank + 1) : 0;
  const canBuyNext = rank < node.max_rank && level >= levelReq && points >= nextCost;
  const owned = rank >= 1;
  const dim = !owned && !canBuyNext;
  const borderColor = selected
    ? "#fff"
    : equipped
      ? "#b89b3a"
      : owned
        ? "#c084fc"
        : canBuyNext
          ? "#7dd3fc"
          : "#2a2d33";
  const cell = (
    <div
      onClick={onClick}
      style={{
        background: "#1d1f23",
        border: `1px solid ${borderColor}`,
        borderRadius: 8,
        padding: "8px 10px",
        cursor: "pointer",
        opacity: dim ? 0.55 : 1,
        position: "relative",
        boxShadow: isPicking && owned ? "0 0 6px #c084fc55" : undefined,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Icon name={(node.ability as { icon?: string }).icon ?? "ace"} size={20} color={owned ? "#c084fc" : "#6b7280"} />
        <div style={{ fontSize: 12, fontWeight: 700, color: "#f5f5f5", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {node.ability.name}
        </div>
        <RankPip rank={rank} max={node.max_rank} />
      </div>
      <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 4 }}>
        {node.category} · {node.ability.kind}
        {equipped && <span style={{ color: "#b89b3a", marginLeft: 6 }}>· equipped</span>}
      </div>
    </div>
  );
  return <HoverTooltip content={abilityTooltipContent(node, rank)}>{cell}</HoverTooltip>;
}

function RankPip({ rank, max }: { rank: number; max: number }) {
  const pips: JSX.Element[] = [];
  for (let i = 1; i <= max; i++) {
    pips.push(
      <span
        key={i}
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          background: i <= rank ? "#c084fc" : "transparent",
          border: `1px solid ${i <= rank ? "#c084fc" : "#4b5563"}`,
        }}
      />,
    );
  }
  return <div style={{ display: "flex", gap: 3, flexShrink: 0 }}>{pips}</div>;
}

function NodeDetail({
  node,
  rank,
  equipped,
  points,
  level,
  onBuy,
  onEquip,
  onUnequip,
  onClose,
  busy,
}: {
  node: TalentNodeDef;
  rank: number;
  equipped: boolean;
  points: number;
  level: number;
  onBuy: (targetRank: number) => void;
  onEquip: () => void;
  onUnequip: () => void;
  onClose: () => void;
  busy: boolean;
}) {
  const targetRank = rank + 1;
  const canRankUp = targetRank <= node.max_rank;
  const levelReq = canRankUp ? node.level_req_per_rank[targetRank - 1] ?? 1 : 0;
  const cost = canRankUp ? pointCostForRank(node, targetRank) : 0;
  const meetsLevel = level >= levelReq;
  const meetsCost = points >= cost;

  return (
    <div style={{ background: "#12141a", border: "1px solid #2a2d33", borderRadius: 8, padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Icon name={(node.ability as { icon?: string }).icon ?? "ace"} size={28} color="#c084fc" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#f5f5f5" }}>{node.ability.name}</div>
          <div style={{ fontSize: 11, color: "#9ca3af" }}>{node.category} · {node.ability.kind} · rank {rank}/{node.max_rank}</div>
        </div>
        <button onClick={onClose} style={{ background: "none", border: "1px solid #3a3d44", color: "#9ca3af", borderRadius: 6, padding: "3px 8px", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>✕</button>
      </div>
      <div style={{ fontSize: 12, color: "#d1d5db", lineHeight: 1.45 }}>{node.ability.blurb}</div>
      {node.ability.kind === "active" && (
        <div style={{ fontSize: 11, color: "#9ca3af", display: "flex", gap: 12, flexWrap: "wrap" }}>
          <span>{(node.ability as { mana_cost: number }).mana_cost} mana</span>
          {(node.ability as { cooldown_turns?: number }).cooldown_turns && (
            <span>{(node.ability as { cooldown_turns: number }).cooldown_turns}t CD</span>
          )}
          {(node.ability as { range_tiles?: number }).range_tiles !== undefined && (
            <span>range {(node.ability as { range_tiles: number }).range_tiles}</span>
          )}
          {(node.ability as { aoe_radius_tiles?: number }).aoe_radius_tiles !== undefined && (node.ability as { aoe_radius_tiles: number }).aoe_radius_tiles > 0 && (
            <span>AoE {(node.ability as { aoe_radius_tiles: number }).aoe_radius_tiles}</span>
          )}
        </div>
      )}
      {/* Rank progression — surfaces the R2/R3 effects so players can see
          what they're buying before they spend points. Only shown for nodes
          with max_rank > 1 that opted into a progression description. */}
      {node.max_rank > 1 && node.rank_progression && (
        <div style={{
          fontSize: 11,
          color: "#a78bfa",
          background: "#1e1c2e",
          border: "1px solid #c084fc33",
          borderRadius: 6,
          padding: "6px 10px",
          lineHeight: 1.45,
        }}>
          <span style={{ fontWeight: 700, marginRight: 6, color: "#c084fc", textTransform: "uppercase", letterSpacing: 0.5, fontSize: 10 }}>Ranks</span>
          {node.rank_progression}
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {/* Equip / Unequip — matches the inventory item flow (smallActionBtn).
            Equip is only shown when the node is owned at rank ≥ 1; it auto-
            targets the first empty slot of the matching kind. */}
        {rank >= 1 && !equipped && (
          <button
            disabled={busy}
            onClick={onEquip}
            style={{
              background: "#1f3a1f",
              color: "#86efac",
              border: "1px solid #86efac55",
              borderRadius: 6,
              padding: "6px 12px",
              fontSize: 12,
              fontWeight: 700,
              cursor: busy ? "not-allowed" : "pointer",
              fontFamily: "inherit",
            }}
          >Equip</button>
        )}
        {equipped && (
          <button
            disabled={busy}
            onClick={onUnequip}
            style={{
              background: "#2a1a1a",
              color: "#fca5a5",
              border: "1px solid #fca5a555",
              borderRadius: 6,
              padding: "6px 12px",
              fontSize: 12,
              fontWeight: 700,
              cursor: busy ? "not-allowed" : "pointer",
              fontFamily: "inherit",
            }}
          >Unequip</button>
        )}
        {canRankUp ? (
          <button
            disabled={busy || !meetsLevel || !meetsCost}
            onClick={() => onBuy(targetRank)}
            style={{
              background: meetsLevel && meetsCost ? "#1e1c2e" : "#1d1f23",
              color: meetsLevel && meetsCost ? "#c084fc" : "#6b7280",
              border: `1px solid ${meetsLevel && meetsCost ? "#c084fc55" : "#2a2d33"}`,
              borderRadius: 6,
              padding: "6px 12px",
              fontSize: 12,
              fontWeight: 700,
              cursor: meetsLevel && meetsCost && !busy ? "pointer" : "not-allowed",
              fontFamily: "inherit",
            }}
          >
            {rank === 0
              ? `Unlock (${cost} pt${cost === 1 ? "" : "s"})`
              : `Rank up to ${targetRank} (${cost} pts)`}
            {!meetsLevel && <span style={{ color: "#fca5a5", marginLeft: 6 }}>— L{levelReq} required</span>}
            {meetsLevel && !meetsCost && <span style={{ color: "#fca5a5", marginLeft: 6 }}>— need {cost} points</span>}
          </button>
        ) : (
          <div style={{ fontSize: 11, color: "#9ca3af", alignSelf: "center" }}>Max rank reached</div>
        )}
      </div>
    </div>
  );
}
