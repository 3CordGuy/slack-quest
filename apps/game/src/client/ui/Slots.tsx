// Slots: the squares a pack, a chest or one side of a trade is made of, and
// what sits in them. A piece of gear takes a slot; a material sits in stacks
// of up to STACK_MAX, each stack a slot, and so does what is carried to drink
// or throw (potions, flasks, bombs), which lives in the pack only, and so do
// lodestones (each kind of stone its own stacks).
//
// The controls are the same wherever slots appear:
//   click          look at it
//   shift + click  move the whole thing across (wear it, stow it, offer it)
//   right click    move part of a stack: asks how many
//   drag           gear onto the figure, or back to the pack
// A view decides what "across" means and passes the handlers in.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { RESOURCE_KINDS, STACK_MAX, THROWABLES, THROWABLE_KINDS, stoneKey, stoneName, type Lodestone, type ResourceKind, type Resources, type Throwable } from "@gantt-quest/world";
import { Icon, type OwnedItem } from "../items";
import { ITEM_ICON, STONE_ICON } from "../zone/actionIcons";
import { itemName, label } from "../labels";
import { ThingIcon, resourceIcon } from "../thingIcons";
import "./slots.css";

export type Stack =
  | { t: "gear"; key: string; item: OwnedItem }
  /** `total` is all the player holds of the kind here, across its stacks. */
  | { t: "mat"; key: string; kind: ResourceKind; qty: number; total: number }
  /** Something to drink or throw on a map. */
  | { t: "use"; key: string; kind: Throwable; qty: number; total: number }
  /** Lodestones that carry the same: put into a place's slot on the atlas to set out for it. */
  | { t: "stone"; key: string; stone: Lodestone; qty: number; total: number };

/** A material as the stacks it fills, fullest first. */
export function matStacks(kind: ResourceKind, total: number): Stack[] {
  const out: Stack[] = [];
  for (let left = total, i = 0; left > 0; left -= STACK_MAX, i++) out.push({ t: "mat", key: `mat:${kind}:${i}`, kind, qty: Math.min(STACK_MAX, left), total });
  return out;
}

/** A kind of thing to drink or throw as the stacks it fills, fullest first. */
export function useStacks(kind: Throwable, total: number): Stack[] {
  const out: Stack[] = [];
  for (let left = total, i = 0; left > 0; left -= STACK_MAX, i++) out.push({ t: "use", key: `use:${kind}:${i}`, kind, qty: Math.min(STACK_MAX, left), total });
  return out;
}

/** Lodestones that carry the same as the stacks they fill, fullest first. */
export function stoneStacks(stone: Lodestone, total: number): Stack[] {
  const out: Stack[] = [];
  for (let left = total, i = 0; left > 0; left -= STACK_MAX, i++) out.push({ t: "stone", key: `stone:${stoneKey(stone)}:${i}`, stone, qty: Math.min(STACK_MAX, left), total });
  return out;
}

/** Everything in a pack or a container, as slots: the gear, then what there is to drink or throw, the lodestones, then each material's stacks. */
export function toStacks(gear: OwnedItem[], materials: Resources, consumables: Partial<Record<Throwable, number>> = {}, lodestones: { stone: Lodestone; qty: number }[] = []): Stack[] {
  return [
    ...gear.map((item): Stack => ({ t: "gear", key: `gear:${item.id}`, item })),
    ...THROWABLE_KINDS.flatMap((k) => useStacks(k, consumables[k] ?? 0)),
    ...lodestones.flatMap((h) => stoneStacks(h.stone, h.qty)),
    ...RESOURCE_KINDS.flatMap((k) => matStacks(k, materials[k] ?? 0)),
  ];
}

export const stackName = (s: Stack) => (s.t === "gear" ? itemName(s.item) : s.t === "use" ? THROWABLES[s.kind].name : s.t === "stone" ? stoneName(s.stone) : label("resource", s.kind));

/** The picture of a stack that is not gear, `size` pixels square. */
export function StackIcon({ stack, size }: { stack: Exclude<Stack, { t: "gear" }>; size: number }) {
  if (stack.t === "stone") return <Icon name={STONE_ICON(stack.stone.length).name} color={STONE_ICON(stack.stone.length).color} size={size} />;
  return stack.t === "use" ? <Icon name={ITEM_ICON[stack.kind].name} color={ITEM_ICON[stack.kind].color} size={size} /> : <ThingIcon icon={resourceIcon(stack.kind)} size={size} />;
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
