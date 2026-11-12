// Shared item UI: the pixel-art icon, the item tile, and the detail panel with
// its comparison against what is equipped. Used by the inventory screen and
// the market stall.

import type { DragEvent, ReactNode } from "react";
import type { StatKey } from "@gantt-quest/core";
import {
  ABILITIES,
  RARITY_COLOR,
  SLOT_LABEL,
  STAT_KEYS,
  STAT_LABEL,
  WEAPONS,
  armorBlock,
  equipProblem,
  type ItemDef,
} from "@gantt-quest/world";
import type { InventoryItem } from "./api";
import { itemArtUrl } from "./itemArt";

/** An inventory row as the game rules see it, keeping its id and equipped flag. */
export type OwnedItem = ItemDef & { id: number; equipped: boolean };

export function toOwned(row: InventoryItem): OwnedItem {
  return {
    id: row.id,
    equipped: !!row.equipped,
    kind: row.kind,
    ref: row.ref,
    name: row.name,
    rarity: row.rarity,
    slot: row.slot,
    power: row.power,
    statBonus: JSON.parse(row.stat_bonus_json) as ItemDef["statBonus"],
    levelReq: row.level_req,
    icon: row.icon,
  };
}

/**
 * A pixel-art item icon. `color` is the accent (the item's rarity colour).
 * Sizes that are a multiple of 18 keep every art pixel the same size.
 */
export function Icon({ name, color, size = 36, silhouette = false }: { name: string; color: string; size?: number; silhouette?: boolean }) {
  return <img className="pixel-icon" aria-hidden alt="" draggable={false} width={size} height={size} src={itemArtUrl(name, color, silhouette)} />;
}

export const powerLabel = (item: ItemDef) => (item.kind === "weapon" ? "Power" : "Armor");

export function bonusSummary(item: ItemDef): string {
  return STAT_KEYS.filter((k) => item.statBonus[k]).map((k) => `+${item.statBonus[k]} ${STAT_LABEL[k]}`).join(", ");
}

interface TileProps {
  item: ItemDef;
  selected?: boolean;
  /** Dimmed: the viewer cannot equip it. */
  locked?: boolean;
  /** Glowing: it fits the slot the player just clicked. */
  match?: boolean;
  onClick?: () => void;
  onDragStart?: (e: DragEvent) => void;
  children?: ReactNode;
}

export function ItemTile({ item, selected, locked, match, onClick, onDragStart, children }: TileProps) {
  const color = RARITY_COLOR[item.rarity];
  return (
    <button
      className={`tile ${selected ? "selected" : ""} ${locked ? "locked" : ""} ${match ? "match" : ""}`}
      style={{ borderColor: color }}
      title={item.name}
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      onClick={onClick}
    >
      <Icon name={item.icon} color={color} size={36} />
      {item.levelReq > 1 && <span className="badge tl">L{item.levelReq}</span>}
      {item.power > 0 && <span className="badge br">+{item.power}</span>}
      {children}
    </button>
  );
}

type Verdict = "UPGRADE" | "DOWNGRADE" | "SIDEGRADE" | "SAME";

/** Row-by-row difference between a candidate and what is in its slot now. */
export function compare(candidate: ItemDef, current: ItemDef | null): { rows: { label: string; from: number; to: number }[]; verdict: Verdict } {
  const rows = [{ label: powerLabel(candidate), from: current?.power ?? 0, to: candidate.power }];
  for (const k of STAT_KEYS) {
    const from = current?.statBonus[k] ?? 0;
    const to = candidate.statBonus[k] ?? 0;
    if (from || to) rows.push({ label: STAT_LABEL[k as StatKey], from, to });
  }
  const shown = rows.filter((r) => r.from || r.to);
  const up = shown.some((r) => r.to > r.from);
  const down = shown.some((r) => r.to < r.from);
  return { rows: shown, verdict: up && down ? "SIDEGRADE" : up ? "UPGRADE" : down ? "DOWNGRADE" : "SAME" };
}

export function VerdictTag({ verdict }: { verdict: Verdict }) {
  return <span className={`verdict ${verdict.toLowerCase()}`}>{verdict}</span>;
}

interface DetailProps {
  item: ItemDef;
  /** What the viewer has in this item's slot, or null. Omit to skip the comparison. */
  current?: ItemDef | null;
  equipped?: boolean;
  classId: string;
  level: number;
  children?: ReactNode;
}

/** Everything about one item, plus how it stacks up against the equipped one. */
export function ItemDetail({ item, current, equipped, classId, level, children }: DetailProps) {
  const color = RARITY_COLOR[item.rarity];
  const problem = equipProblem(item, classId, level);
  const diff = current !== undefined && !equipped ? compare(item, current) : null;
  const abilities = item.kind === "weapon" ? (WEAPONS[item.ref]?.abilities ?? []) : [];
  return (
    <div className="detail">
      <div className="detail-head">
        <span className="detail-icon" style={{ borderColor: color }}><Icon name={item.icon} color={color} size={54} /></span>
        <div>
          <strong style={{ color }}>{item.name}</strong>
          <div>
            <span className="tag" style={{ color, borderColor: color, marginLeft: 0 }}>{item.rarity}</span>
            {equipped && <span className="tag">equipped</span>}
          </div>
        </div>
      </div>
      <p className="muted">
        {SLOT_LABEL[item.slot]}
        {item.power > 0 && ` · +${item.power} ${powerLabel(item).toLowerCase()}`}
        {item.kind === "armor" && ` (blocks ${armorBlock(item.power)} on its own)`}
      </p>
      {bonusSummary(item) && <p className="good">{bonusSummary(item)}</p>}
      {abilities.length > 0 && (
        <ul className="abilities">
          {abilities.map((id) => {
            const a = ABILITIES[id];
            return <li key={id}><strong>{a.name}</strong> <span className="muted">{a.rolls} × {STAT_LABEL[a.stat]} · {a.blurb}</span></li>;
          })}
        </ul>
      )}
      {item.kind === "trinket" && !bonusSummary(item) && <p className="muted">A plain keepsake.</p>}
      {problem && <p className="bad">{problem}</p>}
      {diff && (
        <div className={`diff ${diff.verdict.toLowerCase()}`}>
          <div className="diff-head">
            <span className="muted">vs {current ? current.name : "empty slot"}</span>
            <VerdictTag verdict={diff.verdict} />
          </div>
          {diff.rows.map((r) => (
            <div key={r.label} className="diff-row">
              <span>{r.label}</span>
              <span className="muted">{r.from} → {r.to}</span>
              <span className={r.to > r.from ? "good" : r.to < r.from ? "bad" : "muted"}>
                {r.to > r.from ? `▲ ${r.to - r.from}` : r.to < r.from ? `▼ ${r.from - r.to}` : "·"}
              </span>
            </div>
          ))}
        </div>
      )}
      {children && <div className="row detail-actions">{children}</div>}
    </div>
  );
}
