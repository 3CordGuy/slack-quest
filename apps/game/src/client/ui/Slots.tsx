// Slots: the squares a pack, a chest or one side of a trade is made of, and
// what sits in them. A piece of gear takes a slot; a material sits in stacks
// of up to STACK_MAX, each stack a slot.
//
// The controls are the same wherever slots appear:
//   click          look at it
//   shift + click  move the whole thing across (wear it, stow it, offer it)
//   right click    move part of a stack: asks how many
//   drag           gear onto the figure, or back to the pack
// A view decides what "across" means and passes the handlers in.

import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type ReactNode } from "react";
import { RARITY_COLOR, RESOURCE_KINDS, STACK_MAX, type ResourceKind, type Resources } from "@gantt-quest/world";
import { Icon, type OwnedItem } from "../items";
import { itemName, label } from "../labels";
import { ThingIcon, resourceIcon } from "../thingIcons";
import "./slots.css";

export type Stack =
  | { t: "gear"; key: string; item: OwnedItem }
  /** `total` is all the player holds of the kind here, across its stacks. */
  | { t: "mat"; key: string; kind: ResourceKind; qty: number; total: number };

/** A material as the stacks it fills, fullest first. */
export function matStacks(kind: ResourceKind, total: number): Stack[] {
  const out: Stack[] = [];
  for (let left = total, i = 0; left > 0; left -= STACK_MAX, i++) out.push({ t: "mat", key: `mat:${kind}:${i}`, kind, qty: Math.min(STACK_MAX, left), total });
  return out;
}

/** Everything in a pack or a container, as slots: the gear, then each material's stacks. */
export function toStacks(gear: OwnedItem[], materials: Resources): Stack[] {
  return [...gear.map((item): Stack => ({ t: "gear", key: `gear:${item.id}`, item })), ...RESOURCE_KINDS.flatMap((k) => matStacks(k, materials[k] ?? 0))];
}

export const stackName = (s: Stack) => (s.t === "gear" ? itemName(s.item) : label("resource", s.kind));

interface TileProps {
  stack: Stack;
  selected?: boolean;
  locked?: boolean;
  match?: boolean;
  /** Dimmed and marked: already on the other side (an offer). */
  taken?: boolean;
  size?: number;
  onClick?(e: MouseEvent): void;
  /** Shift + click. */
  onQuick?(): void;
  /** Right click (or ctrl + click). */
  onSplit?(at: { x: number; y: number }): void;
  onDragStart?(e: DragEvent): void;
  children?: ReactNode;
}

export function StackTile({ stack, selected, locked, match, taken, size = 40, onClick, onQuick, onSplit, onDragStart, children }: TileProps) {
  const color = stack.t === "gear" ? RARITY_COLOR[stack.item.rarity] : undefined;
  const hint = [onQuick && "Shift-click to move it", onSplit && stack.t === "mat" && "right-click to move part"].filter(Boolean).join(", ");
  return (
    <button
      className={`tile ${stack.t} ${selected ? "selected" : ""} ${locked ? "locked" : ""} ${match ? "match" : ""} ${taken ? "taken" : ""}`}
      style={color ? { borderColor: color } : undefined}
      title={`${stackName(stack)}${stack.t === "mat" ? ` × ${stack.qty}` : ""}${hint ? `\n${hint}` : ""}`}
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      onClick={(e) => {
        if (e.shiftKey && onQuick) return onQuick();
        if ((e.ctrlKey || e.metaKey) && onSplit) return onSplit({ x: e.clientX, y: e.clientY });
        onClick?.(e);
      }}
      onContextMenu={(e) => {
        if (!onSplit) return;
        e.preventDefault();
        onSplit({ x: e.clientX, y: e.clientY });
      }}
    >
      {stack.t === "gear" ? (
        <>
          <Icon name={stack.item.icon} color={color!} size={size} />
          {stack.item.levelReq > 1 && <span className="badge tl">L{stack.item.levelReq}</span>}
          {stack.item.power > 0 && <span className="badge br">+{stack.item.power}</span>}
        </>
      ) : (
        <>
          <ThingIcon icon={resourceIcon(stack.kind)} size={size} />
          <span className="badge br qty">{stack.qty}</span>
        </>
      )}
      {children}
    </button>
  );
}

/** A grid of `total` slots: the tiles given, then empty squares. Tiles past `total` are over the limit. */
export function SlotGrid({ total, children, over = false, label: name, ...drop }: { total: number; children: ReactNode[]; over?: boolean; label: string; onDragOver?(e: DragEvent): void; onDragLeave?(): void; onDrop?(e: DragEvent): void }) {
  const filled = children.length;
  return (
    <div className={`slot-grid ${over ? "over" : ""}`} role="group" aria-label={name} {...drop}>
      {children.map((tile, i) => (i >= total ? <span key={i} className="slot-over">{tile}</span> : tile))}
      {Array.from({ length: Math.max(0, total - filled) }, (_, i) => <span key={`e${i}`} className="tile empty slot-empty" aria-hidden />)}
    </div>
  );
}

/** How many of a stack to move: a slider from 1 to `max`, with Half and All. Opens at the pointer; Enter moves, Escape or a press outside closes. */
export function SplitPrompt({ name, max, at, verb = "Move", onPick, onClose }: { name: string; max: number; at: { x: number; y: number }; verb?: string; onPick(n: number): void; onClose(): void }) {
  const [n, setN] = useState(Math.max(1, Math.ceil(max / 2)));
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Enter") onPick(n);
    };
    addEventListener("pointerdown", down, { capture: true });
    addEventListener("keydown", key, { capture: true });
    return () => {
      removeEventListener("pointerdown", down, { capture: true });
      removeEventListener("keydown", key, { capture: true });
    };
  }, [n, onPick, onClose]);
  const style: CSSProperties = { left: Math.max(8, Math.min(at.x - 110, innerWidth - 236)), top: Math.max(8, Math.min(at.y + 10, innerHeight - 150)) };
  return (
    <div ref={box} className="split-prompt panel" style={style} role="dialog" aria-label={`How many ${name.toLowerCase()}`}>
      <strong>{verb} {n} <span className="muted">of {max} {name.toLowerCase()}</span></strong>
      <input autoFocus type="range" min={1} max={max} step={1} value={n} style={{ "--fill": `${max > 1 ? ((n - 1) / (max - 1)) * 100 : 100}%` } as CSSProperties} onChange={(e) => setN(Number(e.target.value))} />
      <div className="row">
        <button className="small" onClick={() => setN(1)}>1</button>
        <button className="small" onClick={() => setN(Math.max(1, Math.ceil(max / 2)))}>Half</button>
        <button className="small" onClick={() => setN(max)}>All</button>
        <span className="spacer" />
        <button className="small primary" onClick={() => onPick(n)}>{verb}</button>
      </div>
    </div>
  );
}
