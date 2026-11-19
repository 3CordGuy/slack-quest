// The loot window: what a fallen enemy carried, what is in a chest thrown
// open, or the spoils of a place cleared, as a small grid of the sea bag's own
// squares. Each thing is drawn as it would be in the bag: the same picture,
// its rarity's colour washed over its square, how many of it in the corner,
// and (pointed at) the same card out to the side.
//
//   click a thing       take it
//   drag a thing        onto the sea bag (a "text/gq-loot" drag carrying its index)
//   Take all, E, Space  take everything
//   ×, Esc              close
//
// `blocked` ("Not in the middle of a fight") greys the lot and says why:
// nothing can be taken until it is lifted. The window decides nothing: it
// reports what was asked for, and the view (and the server) do the taking.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { FURNISHINGS, RARITY_COLOR, SLOT_LABEL, THROWABLES, armorBlock, modEffect, modName, modSide, stoneName, type ItemDef, type LootItem, type Slot } from "@gantt-quest/world";
import { Icon, ItemDetail, bonusSummary, powerLabel } from "../items";
import { blurb, itemName, label } from "../labels";
import { BlueprintIcon, GOLD_ICON, ThingIcon, furnishingIcon, resourceIcon } from "../thingIcons";
import { ITEM_ICON, STONE_ICON } from "./actionIcons";
import "../ui/slots.css";
import "./fight.css";

export type { LootItem };

export interface LootPanelProps {
  /** Whose, or what: "Dire Wolf", "Iron-bound chest", "Spoils of Gull Rock". */
  title: string;
  subtitle?: string;
  kind: "body" | "chest" | "spoils";
  items: LootItem[];
  /** Why nothing can be taken just now, if it cannot. */
  blocked?: string;
  onTake: (index: number) => void;
  onTakeAll: () => void;
  onClose: () => void;
  /**
   * Who is looking, so a piece of gear's card can say whether they can use it and set it against what they wear
   * (the bag's own card). Without it the card just says what the piece is.
   */
  viewer?: { classId: string; level: number; worn?: (slot: Slot) => ItemDef | null | undefined };
}

/** What a thing in a loot window is called. */
export function lootName(item: LootItem): string {
  switch (item.t) {
    case "gold": return "Gold";
    case "res": return label("resource", item.kind);
    case "use": return THROWABLES[item.kind].name;
    case "gear": return itemName(item.item);
    case "stone": return stoneName(item.stone);
    case "blueprint": return `Blueprint: ${label("furnishing", item.id)}`;
    case "furnishing": return item.grant.label;
  }
}

/** How many of it there are, where it is a thing that is counted. */
export const lootCount = (item: LootItem): number | undefined => (item.t === "gold" || item.t === "res" || item.t === "use" ? item.n : undefined);

/** Its picture, as the bag draws the same thing. */
export function LootIcon({ item, size }: { item: LootItem; size: number }) {
  switch (item.t) {
    case "gold": return <ThingIcon icon={GOLD_ICON} size={size} />;
    case "res": return <ThingIcon icon={resourceIcon(item.kind)} size={size} />;
    case "use": return <Icon name={ITEM_ICON[item.kind].name} color={ITEM_ICON[item.kind].color} size={size} />;
    case "gear": return <Icon name={item.item.icon} color={RARITY_COLOR[item.item.rarity]} size={size} />;
    case "stone": return <Icon name={STONE_ICON(item.stone.length).name} color={STONE_ICON(item.stone.length).color} size={size} />;
    case "blueprint": return <BlueprintIcon defId={item.id} size={Math.round(size * 0.86)} />;
    case "furnishing": return <ThingIcon icon={furnishingIcon(item.grant.defId)} size={size} />;
  }
}

/** The colour washed over its square: a piece of gear's rarity, and a quiet one of its own for the rest. */
function tintOf(item: LootItem): string | undefined {
  switch (item.t) {
    case "gear": return RARITY_COLOR[item.item.rarity];
    case "gold": return "#f4c64e";
    case "stone": return STONE_ICON(item.stone.length).color;
    case "blueprint": return "#6b9bd0";
    case "furnishing": return "#c084fc";
    default: return undefined;
  }
}

/** A card's heading: the picture, the name, and a word for what kind of thing it is. */
function Head({ item, tag, color }: { item: LootItem; tag: string; color?: string }) {
  return (
    <div className="detail-head">
      <span className="detail-icon" style={{ borderColor: color ?? "var(--line)" }}><LootIcon item={item} size={54} /></span>
      <div>
        <strong style={color ? { color } : undefined}>{lootName(item)}</strong>
        <div><span className="tag" style={{ marginLeft: 0, ...(color ? { color, borderColor: color } : {}) }}>{tag}</span></div>
      </div>
    </div>
  );
}

/** The card for the thing pointed at: what it is, what it does, and how to take it. */
function LootCard({ item, viewer, how }: { item: LootItem; viewer?: LootPanelProps["viewer"]; how: string }) {
  let body: ReactNode;
  switch (item.t) {
    case "gear": {
      const g = item.item;
      const color = RARITY_COLOR[g.rarity];
      body = viewer ? (
        <ItemDetail item={g} current={viewer.worn ? (viewer.worn(g.slot) ?? null) : undefined} classId={viewer.classId} level={viewer.level} />
      ) : (
        <div className="detail">
          <Head item={item} tag={g.rarity} color={color} />
          <p className="muted">
            {SLOT_LABEL[g.slot]}
            {g.power > 0 && ` · +${g.power} ${powerLabel(g).toLowerCase()}`}
            {g.kind === "armor" && ` (blocks ${armorBlock(g.power)} on its own)`}
          </p>
          {bonusSummary(g) && <p className="good">{bonusSummary(g)}</p>}
          {g.levelReq > 1 && <p className="muted">Requires level {g.levelReq}</p>}
        </div>
      );
      break;
    }
    case "gold":
      body = <div className="mat-detail"><Head item={item} tag="coin" /><p><strong>{item.n}</strong> gold, for your purse.</p></div>;
      break;
    case "res":
      body = (
        <div className="mat-detail">
          <Head item={item} tag="material" />
          <p><strong>{item.n}</strong> of it. {blurb("resource", item.kind)}</p>
          <p className="muted">Spent on crafting, building, crew projects and the workshops.</p>
        </div>
      );
      break;
    case "use": {
      const def = THROWABLES[item.kind];
      body = (
        <div className="mat-detail">
          <Head item={item} tag={def.drink ? "to drink or throw" : def.light ? "to light or throw" : "to throw"} />
          <p className="muted">{def.blurb}</p>
          {item.n > 1 && <p><strong>{item.n}</strong> of them.</p>}
        </div>
      );
      break;
    }
    case "stone":
      body = (
        <div className="mat-detail">
          <Head item={item} tag="for the atlas" />
          {item.stone.length === 0 ? (
            <p className="muted">It carries nothing: it opens a place and changes nothing about it.</p>
          ) : (
            <ul className="stone-carries">
              {item.stone.map((id) => (
                <li key={id}>
                  <strong>{modName(id)}</strong> <span className="muted">· {modSide(id)}</span>
                  <br />
                  <span className="muted">{modEffect(id).blurb}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="muted">Put into a place's slot on the atlas to set out for it.</p>
        </div>
      );
      break;
    case "blueprint":
      body = (
        <div className="mat-detail">
          <Head item={item} tag="blueprint" color="#9cc4f0" />
          <p className="muted">{blurb("furnishing", item.id)}</p>
          <p>Learn it, and the piece can be built at home from then on.</p>
        </div>
      );
      break;
    case "furnishing":
      body = (
        <div className="mat-detail">
          <Head item={item} tag={FURNISHINGS[item.grant.defId]?.kind === "trophy" ? "trophy" : "for your hut"} />
          <p className="muted">{blurb("furnishing", item.grant.defId)}</p>
          <p>Sent home: set it out in your hut.</p>
        </div>
      );
      break;
  }
  return (
    <aside className="loot-card panel" role="tooltip">
      {body}
      <p className="loot-how">{how}</p>
    </aside>
  );
}

const WORD: Record<LootPanelProps["kind"], string> = { body: "Fallen", chest: "Chest", spoils: "Spoils" };
const typing = (e: KeyboardEvent) => !!(e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]");

export function LootPanel({ title, subtitle, kind, items, blocked, onTake, onTakeAll, onClose, viewer }: LootPanelProps) {
  const [hover, setHover] = useState<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const can = !blocked && items.length > 0;

  // The keys, for as long as the window is open. The newest handlers, without rebinding on every render.
  const now = useRef({ can, onTakeAll, onClose });
  now.current = { can, onTakeAll, onClose };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      const takeAll = e.code === "KeyE" || e.code === "Space";
      if (e.key !== "Escape" && !takeAll) return;
      // The window has these keys while it is open: nothing behind it (the menu, the map) hears them.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") now.current.onClose();
      else if (now.current.can && !e.repeat) now.current.onTakeAll();
    };
    addEventListener("keydown", onKey, { capture: true });
    return () => removeEventListener("keydown", onKey, { capture: true });
  }, []);

  // What the pointer was over may be gone once something is taken.
  const shown = hover !== null && hover < items.length && dragging === null ? items[hover] : null;

  // A key for each square that stays with its thing as others are taken from before it.
  const seenSigs = new Map<string, number>();
  const keys = items.map((item) => {
    const sig = item.t === "gear" ? `gear:${item.item.ref}:${item.item.rarity}:${item.item.name}` : item.t === "stone" ? `stone:${item.stone.join("+")}` : item.t === "blueprint" ? `bp:${item.id}` : item.t === "furnishing" ? `furn:${item.grant.defId}` : item.t === "gold" ? "gold" : `${item.t}:${item.kind}`;
    const nth = seenSigs.get(sig) ?? 0;
    seenSigs.set(sig, nth + 1);
    return `${sig}#${nth}`;
  });

  return (
    <div className={`fight-ui fight-loot panel window ${kind} ${blocked ? "blocked" : ""}`} role="dialog" aria-label={`${WORD[kind]}: ${title}`}>
      <span className="win-plate">{title}</span>
      <button type="button" className="bag-close hud-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>×</button>
      {subtitle && <p className="loot-sub">{subtitle}</p>}
      {blocked && <p className="loot-blocked" role="note">{blocked}</p>}

      {items.length === 0 ? (
        <p className="loot-none">Nothing left.</p>
      ) : (
        <div className="loot-wrap">
          <div className="loot-grid" role="group" aria-label="What is in it" onPointerLeave={() => setHover(null)}>
            {items.map((item, i) => {
              const n = lootCount(item);
              const tint = tintOf(item);
              return (
                <button
                  key={keys[i]}
                  type="button"
                  className={`loot-slot ${item.t} ${dragging === i ? "dragging" : ""}`}
                  style={{ "--i": i, ...(tint ? { "--tint": tint } : {}) } as CSSProperties}
                  aria-label={`${lootName(item)}${n !== undefined ? `, ${n}` : ""}${blocked ? "" : ": take it"}`}
                  aria-disabled={!!blocked}
                  draggable={!blocked}
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/gq-loot", String(i));
                    e.dataTransfer.effectAllowed = "move";
                    setDragging(i);
                    setHover(null);
                  }}
                  onDragEnd={() => setDragging(null)}
                  onPointerEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  onClick={() => { if (!blocked) onTake(i); }}
                >
                  <LootIcon item={item} size={46} />
                  {n !== undefined && <span className="badge br qty">{n}</span>}
                  {item.t === "gear" && item.item.power > 0 && <span className="badge br">+{item.item.power}</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <footer className="loot-foot">
        <span className="loot-hint">{items.length === 0 ? "" : blocked ? "Look, but nothing can be taken yet." : "Click to take, or drag to your bag."}</span>
        <button type="button" className="primary loot-all" disabled={!can} title={blocked ?? (items.length === 0 ? "Nothing left to take" : "Take everything (E or Space)")} onClick={onTakeAll}>
          Take all <kbd>E</kbd>
        </button>
      </footer>

      {shown && <LootCard item={shown} viewer={viewer} how={blocked ?? "Click to take it, or drag it to your bag."} />}
    </div>
  );
}
