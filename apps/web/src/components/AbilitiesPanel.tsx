// Abilities tab for the Inventory screen. Lists the player's class talent
// tree, shows owned vs. locked nodes, lets them buy ranks (spend talent_points)
// and configure their equipped loadout (4 active slots + 1-3 passive slots).
//
// API surface (worker.ts):
//   GET  /api/character/talents       — { talent_points, owned, loadout, level, class }
//   POST /api/character/talents/buy   — { node_id, target_rank } → { ok, character }
//   POST /api/character/talents/respec — () → { ok, character, paid }
//   POST /api/character/loadout       — { active, passive } → { ok, character }

import { useEffect, useMemo, useState } from "react";
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
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? "loadout_failed");
      } else {
        await refresh();
        onCharacterUpdated?.();
      }
    } finally {
      setBusy(false);
    }
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

  const ownedRank = (id: string) => data.owned[id] ?? 0;
  const equippedIds = new Set<string>([
    ...(data.loadout?.active ?? []).filter((x): x is string => !!x),
    ...(data.loadout?.passive ?? []).filter((x): x is string => !!x),
  ]);
  const passiveSlotCount = passiveSlotsForLevel(data.level);
  const canAffordRespec = (characterGold ?? 0) >= RESPEC_GOLD;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, flex: 1, minHeight: 0 }}>
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
      <div style={{ flex: 1, overflowY: "auto", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 8, alignContent: "start" }}>
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
        <NodeDetail
          node={selectedNode}
          rank={ownedRank(selectedNode.id)}
          points={data.talent_points}
          level={data.level}
          onBuy={(targetRank) => buyRank(selectedNode, targetRank)}
          onClose={() => setSelectedId(null)}
          busy={busy}
        />
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
        background: filled ? "#1e1c2e" : "#141618",
        border: isPicking
          ? "2px solid #c084fc"
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
        boxShadow: isPicking ? "0 0 8px #c084fc66" : undefined,
      }}
    >
      {filled ? (
        <>
          <Icon name={(node.ability as { icon?: string }).icon ?? "ace"} size={26} color="#c084fc" />
          <div style={{ fontSize: 8, color: "#fff", textAlign: "center", lineHeight: 1.1, fontWeight: 600 }}>
            {node.ability.name}
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); onClear(); }}
            title={`Unequip ${node.ability.name}`}
            style={{
              position: "absolute",
              top: -6,
              right: -6,
              width: 18,
              height: 18,
              padding: 0,
              borderRadius: 9,
              background: "#1d1f23",
              border: "1px solid #4b5563",
              color: "#9ca3af",
              fontSize: 11,
              lineHeight: 1,
              cursor: "pointer",
              fontFamily: "inherit",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >×</button>
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
  points,
  level,
  onBuy,
  onClose,
  busy,
}: {
  node: TalentNodeDef;
  rank: number;
  points: number;
  level: number;
  onBuy: (targetRank: number) => void;
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
      {canRankUp ? (
        <button
          disabled={busy || !meetsLevel || !meetsCost}
          onClick={() => onBuy(targetRank)}
          style={{
            background: meetsLevel && meetsCost ? "#1e1c2e" : "#1d1f23",
            color: meetsLevel && meetsCost ? "#c084fc" : "#6b7280",
            border: `1px solid ${meetsLevel && meetsCost ? "#c084fc55" : "#2a2d33"}`,
            borderRadius: 6,
            padding: "8px 12px",
            fontSize: 12,
            fontWeight: 700,
            cursor: meetsLevel && meetsCost && !busy ? "pointer" : "not-allowed",
            fontFamily: "inherit",
            textAlign: "left",
          }}
        >
          {rank === 0
            ? `Unlock (${cost} pt${cost === 1 ? "" : "s"})`
            : `Rank up to ${targetRank} (${cost} pts)`}
          {!meetsLevel && <span style={{ color: "#fca5a5", marginLeft: 6 }}>— L{levelReq} required</span>}
          {meetsLevel && !meetsCost && <span style={{ color: "#fca5a5", marginLeft: 6 }}>— need {cost} points</span>}
        </button>
      ) : (
        <div style={{ fontSize: 11, color: "#9ca3af" }}>Max rank reached.</div>
      )}
    </div>
  );
}
