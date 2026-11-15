// The sea bag: a window down the right-hand side of the view, as tall as
// what is in it and centred top to bottom, with the view still in sight
// beside it. At the top, the hero's eight equipment slots laid out as
// they are worn, each the size of what goes in it (a tall slot for each
// hand, helm over coat, the small things between), with a second ring and a
// belt drawn in for gear still to come. Under them the pack: a
// grid twelve squares across and five down, where every thing takes up its
// own footprint (a ring one square, a coat two by three, a staff two by
// four) and a material sits in stacks, a square a stack.
//
// A chest opened in the hut is a second window of the same screen: the same
// grid, twelve across and as many rows deep as the chest is big, in the
// middle of the view with the bag beside it. The two share one hand, so a
// thing lifted out of either can be set down in the other.
//
// A trade with a crewmate is a third window of the same screen, in the chest's
// place: their side of the table above, yours below. Your side is a grid
// like a chest's: things go onto it out of the pack and come back the same
// ways, and stay yours until both of you have accepted (TradePanel.tsx).
//
// It is handled like a chest of real things:
//   click          pick a thing up; it follows the pointer
//   drag           the same in one move: press, carry, let go where it should lie
//   click again    set it down where the outline shows. Onto one other
//                  thing in the same grid, the two change places and you
//                  are left holding that one. Onto an equipment slot, it is worn.
//   shift + click  wear it, or take it off, straight away; with a chest
//                  open, send it across to the other grid instead
//   right click    put back what you are holding (so does Escape); with a
//                  chest open, on a stack of material: move part of it across
// Pointing at a thing shows its card, compared with what is worn. A strip
// between the gear and the pack names the hero and totals what the gear
// gives (hit points, armor, weapon power); with gear in hand it offers to
// sell it or send it home instead. Where
// things lie is remembered per browser (ui/packLayout.ts); the server only
// counts squares. Stats, traits and skills are in the logbook (Logbook.tsx).
//
// A thing sent between the bag and a chest is drawn where it is going at
// once, before the server has answered: the moves are sent one at a time, in
// order, and each is shown over what the server last said until its answer
// (and the fresh lists after it) are in. A move the server refuses goes back.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { CatchPanel } from "./CatchPanel";
import {
  CARRY_FORMULA,
  CHEST_COLS,
  FURNISHINGS,
  TRADE_CELLS,
  TRADE_ROWS,
  PACK_COLS,
  PACK_ROWS,
  RARITY_COLOR,
  SLOTS,
  SLOT_ICON,
  SLOT_LABEL,
  STACK_MAX,
  STALL_BUYS,
  addedSlots,
  armorBlock,
  carryProblem,
  equipProblem,
  itemCells,
  itemSize,
  loadoutOf,
  maxHpFor,
  sellPrice,
  stackSlots,
  type Furnishing,
  type HutClientMessage,
  type ResourceKind,
  type Resources,
  type Slot,
  type TradeSide,
} from "@gantt-quest/world";
import { api, type Hut, type InventoryItem, type Me } from "./api";
import { useAct } from "./Harbor";
import { Icon, ItemDetail, ItemTile, toOwned, type OwnedItem } from "./items";
import { label } from "./labels";
import { ThingIcon, furnishingIcon, resourceIcon } from "./thingIcons";
import { layoutPack, loadSaved, saveSaved, under, type Saved, type Shape, type Spot } from "./ui/packLayout";
import { DollChart, type ChartSlot } from "./ui/DollChart";
import { SplitPrompt, stackName, toStacks, type Stack } from "./ui/Slots";
import { uiZoom } from "./uiScale";
import "./ui/slots.css";

/** Where the pointer is, in screen pixels. */
type Point = { clientX: number; clientY: number };

/** A square of the pack's grid, in CSS pixels (slots.css reads it as --u). */
const U = 51;
/** How wide the bag is, and the gap kept between it and a chest (the camera's buttons stand in it): as slots.css. */
const BAG_W = U * PACK_COLS + 46;
const CHEST_GAP = 104;

/** Where each equipment slot sits over the grid's width, in squares. A hand's slot is as tall as the longest weapon. */
const DOLL: Record<Slot, { x: number; y: number; w: number; h: number }> = {
  main_hand: { x: 0.5, y: 1.9, w: 2, h: 4 },
  off_hand: { x: 9.5, y: 1.9, w: 2, h: 4 },
  helmet: { x: 5, y: 0.6, w: 2, h: 2 },
  amulet: { x: 7.5, y: 1.95, w: 1, h: 1 },
  body: { x: 5, y: 3.25, w: 2, h: 3 },
  ring: { x: 3.5, y: 3.75, w: 1, h: 1 },
  legs: { x: 2.7, y: 5.55, w: 2, h: 2 },
  boots: { x: 7.3, y: 5.55, w: 2, h: 2 },
};
/** Slots drawn for gear that is still to come: a second ring beside the coat, a belt under it. Nothing goes in them yet. */
const TO_COME = [
  { id: "ring2", label: "Ring", icon: "ring", x: 7.5, y: 3.75, w: 1, h: 1 },
  { id: "belt", label: "Belt", icon: null, x: 5, y: 6.95, w: 2, h: 1 },
] as const;
const DOLL_ROWS = 8.7;
/** Every slot's place, for the chart behind them to be drawn round. */
const CHART_SLOTS: ChartSlot[] = [...Object.values(DOLL), ...TO_COME];

const shapeOf = (s: Stack): Shape => ({ key: s.key, ...(s.t === "gear" ? itemSize(s.item) : { w: 1, h: 1 }) });
/** The biggest a square icon can be drawn in a footprint, on squares `u` pixels wide. */
const iconPx = (w: number, h: number, u = U) => Math.round(Math.min(w, h) * u * (Math.min(w, h) === 1 ? 0.82 : 0.9));

/** The two grids a thing can lie in: the pack, and the one open beside it (a chest, or your side of a trade). */
type Zone = "pack" | "chest";
/** What is in hand, and where it was lifted from: a grid, or off the figure. */
type Held = { stack: Stack; from: Zone | "worn" };
type Verdict = "ok" | "swap" | "bad";
/** A decoration kept in a chest lies on its grid too, a square each. */
const decorKey = (id: number) => `decor:${id}`;

/** A chest, crate or cupboard of the hut, open beside the bag. */
export interface OpenChest {
  box: Furnishing;
  /** Every furnishing of the hut: the decorations kept in the chest, and those that could be. */
  furnishings: Furnishing[];
  /** The owner's hut, for what its containers hold; null while it is being read. */
  own: Hut | null;
  send(message: HutClientMessage): void;
  /** Pick a decoration up to set it down in the room. */
  carry(id: number): void;
  onClose(): void;
}

/** The trade table, open beside the bag. Your side of it is the grid beside the pack; closing the screen cancels the trade. */
export interface OpenTrade {
  /** The other player's name. */
  with: string;
  /** Their side, as the server last listed it. */
  theirs: { gear: OwnedItem[]; resources: Resources; gold: number; ok: boolean; missing: number };
  /** Your side, and whether you have accepted the table as it stands. */
  mine: TradeSide;
  mineOk: boolean;
  /** Lay out your side afresh. */
  setMine(next: TradeSide): void;
  /** Why the table cannot be accepted as it stands, or null. */
  problem: string | null;
  /** What the server said about the last thing asked of it, if it refused. */
  note: string | null;
  /** A change or an answer is on its way. */
  busy: boolean;
  /** Accept the table, or take that back. */
  accept(ok: boolean): void;
}

interface Props {
  me: Me;
  refresh(): Promise<unknown>;
  onClose(): void;
  /** Opened during a voyage: gear can be changed, but the catch stays at home. */
  onIsland?: boolean;
  /** A chest of the hut, open beside the bag. `refresh` must re-read the hut as well. */
  chest?: OpenChest | null;
  /** A trade with a crewmate, open beside the bag in a chest's place. */
  trade?: OpenTrade | null;
}

/**
 * One grid of squares with things lying on it at their own size: the pack, or a chest.
 * It reports the square under the pointer and what is done to each thing; the screen decides what that means.
 */
function PackGrid({ zone, name, u, rows, baseRows, stacks, decor = [], spots, held, target, lockedOf, onCell, onSetDown, onHover, onPress, onPick, onQuick, onSplit, onDecor, pickedDecor }: {
  /** "theirs" is the other player's side of a trade: there to be looked at, not handled. */
  zone: Zone | "theirs";
  name: string;
  /** A square, in CSS pixels. */
  u: number;
  /** Rows drawn, and how many of them the grid really has: the rest is spill. */
  rows: number;
  baseRows: number;
  stacks: Stack[];
  decor?: Furnishing[];
  spots: Map<string, Spot>;
  held: Held | null;
  /** Where the thing in hand would be set down here. */
  target: { at: Spot; w: number; h: number; verdict: Verdict } | null;
  lockedOf?(s: Stack): boolean;
  onCell(at: Spot | null): void;
  onSetDown(e: Point): void;
  onHover(key: string | null): void;
  onPress(s: Stack, e: Point): void;
  onPick(s: Stack, e: Point): void;
  onQuick(s: Stack): void;
  onSplit?(s: Stack & { t: "mat" }, at: { x: number; y: number }): void;
  onDecor?(id: number): void;
  pickedDecor?: number | null;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const move = (e: ReactPointerEvent) => {
    const r = grid.current?.getBoundingClientRect();
    if (!r) return;
    const x = Math.floor(((e.clientX - r.left) / r.width) * PACK_COLS);
    const y = Math.floor(((e.clientY - r.top) / r.height) * rows);
    onCell(x >= 0 && x < PACK_COLS && y >= 0 && y < rows ? { x, y } : null);
  };
  return (
    <div
      ref={grid}
      className="pack-grid-2"
      data-zone={zone}
      role="group"
      aria-label={name}
      style={{ height: rows * u, "--spill": `${baseRows * u}px` } as CSSProperties}
      onPointerMove={move}
      onPointerLeave={() => { onCell(null); onHover(null); }}
      onClick={(e) => held && onSetDown(e)}
    >
      {stacks.map((s) => {
        const at = spots.get(s.key);
        if (!at) return null;
        const { w, h } = shapeOf(s);
        const color = s.t === "gear" ? RARITY_COLOR[s.item.rarity] : undefined;
        return (
          <button
            key={s.key}
            className={`pack-item ${s.t} ${held?.from === zone && held.stack.key === s.key ? "lifted" : ""} ${lockedOf?.(s) ? "locked" : ""} ${at.y + h > baseRows ? "spilt" : ""}`}
            style={{ left: at.x * u, top: at.y * u, width: w * u, height: h * u, ...(color ? { "--tint": color } : {}) } as CSSProperties}
            aria-label={`${stackName(s)}${s.t === "mat" ? `, ${s.qty}` : ""}`}
            onPointerEnter={() => !held && onHover(s.key)}
            onPointerDown={(e) => {
              if (!held && e.button === 0 && !e.shiftKey) onPress(s, e);
            }}
            onClick={(e) => {
              if (held) return; // The grid sets it down.
              e.stopPropagation();
              if (e.shiftKey) onQuick(s);
              else onPick(s, e);
            }}
            onContextMenu={(e: ReactMouseEvent) => {
              if (held || !onSplit || s.t !== "mat") return;
              e.preventDefault();
              e.stopPropagation();
              onSplit(s, { x: e.clientX, y: e.clientY });
            }}
          >
            {s.t === "gear" ? <Icon name={s.item.icon} color={color!} size={iconPx(w, h, u)} /> : <ThingIcon icon={resourceIcon(s.kind)} size={iconPx(1, 1, u)} />}
            {s.t === "mat" && <span className="badge br qty">{s.qty}</span>}
            {s.t === "gear" && s.item.power > 0 && w > 1 && <span className="badge br">+{s.item.power}</span>}
          </button>
        );
      })}
      {decor.map((f) => {
        const at = spots.get(decorKey(f.id));
        if (!at) return null;
        return (
          <button
            key={decorKey(f.id)}
            className={`pack-item decor ${pickedDecor === f.id ? "picked" : ""} ${at.y + 1 > baseRows ? "spilt" : ""}`}
            style={{ left: at.x * u, top: at.y * u, width: u, height: u }}
            title={`${f.label}: a decoration kept in here`}
            aria-pressed={pickedDecor === f.id}
            onClick={(e) => {
              if (held) return;
              e.stopPropagation();
              onDecor?.(f.id);
            }}
          >
            <ThingIcon icon={furnishingIcon(f.defId)} size={iconPx(1, 1, u)} />
          </button>
        );
      })}
      {target && <span className={`pack-target ${target.verdict}`} style={{ left: target.at.x * u, top: target.at.y * u, width: target.w * u, height: target.h * u }} aria-hidden />}
    </div>
  );
}

export function InventoryScreen({ me, refresh, onClose, onIsland = false, chest = null, trade = null }: Props) {
  const c = me.character!;
  const { busy, error, act } = useAct(refresh);
  const [catchOpen, setCatchOpen] = useState(false);
  const [saved, setSaved] = useState<Saved>(() => loadSaved(me.player.id));
  /** What is in hand: lifted out of the pack or the chest, or off the figure. */
  const [held, setHeld] = useState<Held | null>(null);
  const [hover, setHover] = useState<{ zone: Zone | "worn" | "theirs"; key: string } | null>(null);
  /** The square under the pointer, and which grid it is in. */
  const [cell, setCell] = useState<(Spot & { zone: Zone }) | null>(null);
  /** A stack of material being split across to the other grid. */
  const [split, setSplit] = useState<{ stack: Stack & { t: "mat" }; into: boolean; at: { x: number; y: number } } | null>(null);
  /** The decoration in the chest that was last clicked, for its buttons under the grid. */
  const [pickedDecor, setPickedDecor] = useState<number | null>(null);
  const [addPiece, setAddPiece] = useState("");
  /** Moves between the bag and a chest that are still on their way to the server: where each thing is shown meanwhile. */
  const [gearAt, setGearAt] = useState<Map<number, { item: OwnedItem; to: Zone; box: number; op: number }>>(() => new Map());
  /** The same for materials: how many of a kind are shown on each side while a move of them is under way. */
  const [matAt, setMatAt] = useState<Map<ResourceKind, { pack: number; chest: number; box: number; op: number }>>(() => new Map());
  /** The moves go to the server one after another, so each answer is about a state the screen knows. */
  const sending = useRef<Promise<unknown>>(Promise.resolve());
  const opCount = useRef(0);
  /** Why a move was not even sent: no room on the other side. */
  const [refused, setRefused] = useState<string | null>(null);
  const float = useRef<HTMLDivElement>(null);
  /** A press on a thing that may turn into a drag: where it began, and whether it has moved far enough to count. */
  const press = useRef<{ stack: Stack; from: Held["from"]; x: number; y: number; dragging: boolean } | null>(null);
  /** The newest of the handlers a drag's release calls, so the window's listeners need not be re-made every render. */
  const drop = useRef<{ onGrid(at: Point): void; onSlot(slot: Slot): void }>({ onGrid: () => undefined, onSlot: () => undefined });
  /** The view's width in the screen's own pixels: a chest's squares shrink to fit beside the bag. */
  const [viewW, setViewW] = useState(() => innerWidth / uiZoom());
  const [viewH, setViewH] = useState(() => innerHeight / uiZoom());
  useEffect(() => {
    const on = () => (setViewW(innerWidth / uiZoom()), setViewH(innerHeight / uiZoom()));
    addEventListener("resize", on);
    return () => removeEventListener("resize", on);
  }, []);

  const items = useMemo(() => me.inventory.map(toOwned), [me.inventory]);
  const carry = me.carry;
  const worn = useMemo(() => new Map(items.filter((i) => i.equipped).map((i) => [i.slot, i])), [items]);
  /** The pack as it is shown: what the server lists, with the moves still under way already made. */
  const packGear = useMemo(() => {
    const out = items.filter((i) => !i.equipped && gearAt.get(i.id)?.to !== "chest" && !trade?.mine.items.includes(i.id));
    for (const g of gearAt.values()) if (g.to === "pack" && !items.some((i) => i.id === g.item.id)) out.push(g.item);
    return out;
  }, [items, gearAt, trade?.mine.items]);
  const packMats = useMemo(() => {
    const out: Resources = { ...(me.materials ?? {}) };
    for (const [k, m] of matAt) out[k] = m.pack;
    // What is laid on the trade table is still yours, but it is on the table, not in the pack.
    for (const [k, n] of Object.entries(trade?.mine.resources ?? {}) as [ResourceKind, number][]) out[k] = Math.max(0, (out[k] ?? 0) - n);
    return out;
  }, [me.materials, matAt, trade?.mine.resources]);
  const stacks = useMemo(() => toStacks(packGear, packMats), [packGear, packMats]);
  const shapes = useMemo(() => stacks.map(shapeOf), [stacks]);
  const layout = useMemo(() => layoutPack(shapes, saved), [shapes, saved]);
  const wornStacks = [...worn.values()].map((item): Stack => ({ t: "gear", key: `gear:${item.id}`, item }));

  // ---- the grid beside the pack: a chest's, when one is open, or your side of a trade ----
  const box = chest?.box ?? null;
  const boxId = box?.id ?? null;
  const own = chest?.own ?? null;
  /** Which grid is open beside the pack, for remembering where things lie in it: a chest's id, or -1 for the trade table. */
  const sideId = boxId ?? (trade ? -1 : null);
  const sideOpen = sideId !== null;
  /** The materials in this chest, by kind. */
  const kept = useMemo(() => {
    const out: Resources = {};
    if (trade) return { ...trade.mine.resources };
    for (const s of own?.stash ?? []) if (s.containerId === boxId) out[s.kind] = s.qty;
    for (const [k, m] of matAt) if (m.box === boxId) out[k] = m.chest;
    return out;
  }, [own, boxId, matAt, trade?.mine.resources]);
  const chestStacks = useMemo(() => {
    // Your side of the table: the gear you laid on it, in the order it was laid, and the materials.
    if (trade) return toStacks(trade.mine.items.flatMap((id) => items.filter((i) => i.id === id && !i.equipped)), kept);
    if (boxId === null) return [];
    const listed = (own?.stowed ?? []).filter((g) => g.containerId === boxId).map((g) => toOwned({ ...g, id: g.itemId, equipped: 0 } as unknown as InventoryItem));
    const gear = listed.filter((i) => gearAt.get(i.id)?.to !== "pack");
    for (const g of gearAt.values()) if (g.to === "chest" && g.box === boxId && !listed.some((i) => i.id === g.item.id)) gear.push(g.item);
    return toStacks(gear, kept);
  }, [own, boxId, kept, gearAt, trade?.mine.items, items]);
  const inside = useMemo(() => (boxId === null ? [] : (chest?.furnishings ?? []).filter((f) => f.inId === boxId)), [chest?.furnishings, boxId]);
  const looseDecor = boxId === null ? [] : (chest?.furnishings ?? []).filter((f) => f.q === null && f.inId === null && f.id !== boxId && !FURNISHINGS[f.defId]?.storage);
  const chestShapes = useMemo(() => [...chestStacks.map(shapeOf), ...inside.map((f): Shape => ({ key: decorKey(f.id), w: 1, h: 1 }))], [chestStacks, inside]);
  const chestTotal = trade ? TRADE_CELLS : box ? FURNISHINGS[box.defId]?.storage ?? 0 : 0;
  const chestRows = Math.max(1, Math.ceil(chestTotal / CHEST_COLS));
  /** Where things lie in this chest: as last arranged here, or as remembered for it. */
  const [chestEdits, setChestEdits] = useState<{ id: number; saved: Saved } | null>(null);
  const chestSaved = useMemo(() => (sideId === null ? {} : chestEdits?.id === sideId ? chestEdits.saved : boxId === null ? {} : loadSaved(me.player.id, boxId)), [sideId, boxId, chestEdits, me.player.id]);
  const chestLayout = useMemo(() => layoutPack(chestShapes, chestSaved, chestRows), [chestShapes, chestSaved, chestRows]);
  const chestUsed = chestShapes.reduce((n, s) => n + s.w * s.h, 0);
  const chestFree = Math.max(0, chestTotal - chestUsed);
  /** A chest's squares: the pack's size where the view is wide enough for both, smaller where it is not. */
  const wideU = Math.max(30, Math.min(U, Math.floor((viewW - 44 - BAG_W - CHEST_GAP - 16 - 46) / CHEST_COLS)));
  /** The trade table is two grids tall, so its squares also shrink to the height there is above the bottom bar. */
  const CU = trade ? Math.max(28, Math.min(wideU, Math.floor((viewH - 188 - 290) / (TRADE_ROWS * 2)))) : wideU;

  // ---- their side of the trade: there to be looked at ----
  const theirStacks = useMemo(() => (trade ? toStacks(trade.theirs.gear, trade.theirs.resources) : []), [trade?.theirs.gear, trade?.theirs.resources]);
  const theirShapes = useMemo(() => theirStacks.map(shapeOf), [theirStacks]);
  /** Where their things lie, kept so they do not shuffle as more are laid down. */
  const [theirSaved, setTheirSaved] = useState<Saved>({});
  const theirLayout = useMemo(() => layoutPack(theirShapes, theirSaved, TRADE_ROWS), [theirShapes, theirSaved]);
  useEffect(() => {
    if (theirShapes.some((s) => !theirSaved[s.key])) setTheirSaved(Object.fromEntries(theirLayout.spots));
  }, [theirShapes, theirSaved, theirLayout]);

  /** Whether a thing (or `n` of a stack) fits in the chest by the count of its squares. */
  const fitsIn = (s: Stack, n = s.t === "mat" ? s.qty : 1) => (s.t === "gear" ? itemCells(s.item) : addedSlots(kept[s.kind] ?? 0, n)) <= chestFree;
  /** The squares of the pack that are filled, as it is shown (the server's count runs behind while moves are under way). */
  const packUsed = shapes.reduce((n, s) => n + s.w * s.h, 0);
  /** Why a thing cannot come out into the pack, or null. */
  const outProblem = (s: Stack, n = s.t === "mat" ? s.qty : 1) => (trade ? null : carry ? carryProblem({ carried: packUsed, limit: carry.limit }, s.t === "gear" ? itemCells(s.item) : addedSlots(packMats[s.kind] ?? 0, n)) : null);

  /** Show a move at once, send it when the ones before it are done, and stop showing it over the server's lists once its own answer and the lists after it are in. */
  const send = (show: (op: number) => void, run: () => Promise<unknown>) => {
    const op = ++opCount.current;
    setRefused(null);
    show(op);
    const settled = <K, V extends { op: number }>(was: Map<K, V>) => ([...was.values()].some((v) => v.op === op) ? new Map([...was].filter(([, v]) => v.op !== op)) : was);
    sending.current = sending.current
      .then(() => act(run))
      .finally(() => {
        setGearAt(settled);
        setMatAt(settled);
      });
  };
  /** Across between the pack and the open chest: `to` is the side it goes to. */
  const moveTo = (to: Zone, s: Stack, n = s.t === "mat" ? s.qty : 1) => {
    if (trade) {
      // Onto your side of the table, or back off it: nothing leaves the pack for real until the trade is settled.
      if (to === "chest" && !fitsIn(s, n)) return setRefused("That is more than fits on the table.");
      setRefused(null);
      const mine = trade.mine;
      if (s.t === "gear") {
        const others = mine.items.filter((id) => id !== s.item.id);
        return trade.setMine({ ...mine, items: to === "chest" ? [...others, s.item.id] : others });
      }
      const laid = mine.resources[s.kind] ?? 0;
      const next = to === "chest" ? laid + Math.min(n, packMats[s.kind] ?? 0) : laid - Math.min(n, laid);
      const resources = { ...mine.resources };
      if (next > 0) resources[s.kind] = next;
      else delete resources[s.kind];
      return trade.setMine({ ...mine, resources });
    }
    if (boxId === null) return;
    const b = boxId;
    const problem = to === "chest" ? (fitsIn(s, n) ? null : `The ${box?.label ?? "chest"} is too full for that.`) : outProblem(s, n);
    if (problem) return setRefused(problem);
    if (s.t === "gear") {
      const item = s.item;
      send((op) => setGearAt((was) => new Map(was).set(item.id, { item, to, box: b, op })), () => api.stow(to === "chest" ? b : null, item.id));
    } else {
      const kind = s.kind;
      const from = to === "chest" ? packMats[kind] ?? 0 : kept[kind] ?? 0;
      const qty = Math.min(n, from);
      if (qty <= 0) return;
      const pack = (packMats[kind] ?? 0) + (to === "chest" ? -qty : qty);
      const chest = (kept[kind] ?? 0) + (to === "chest" ? qty : -qty);
      send((op) => setMatAt((was) => new Map(was).set(kind, { pack, chest, box: b, op })), () => api.stash(b, kind, to === "chest" ? qty : -qty));
    }
  };
  const moveIn = (s: Stack, n?: number) => moveTo("chest", s, n);
  const moveOut = (s: Stack, n?: number) => moveTo("pack", s, n);

  const stacksOf = (z: Zone) => (z === "chest" ? chestStacks : stacks);
  const layoutOf = (z: Zone) => (z === "chest" ? chestLayout : layout);
  const rememberIn = (z: Zone, changes: Saved, forget: string[] = []) => {
    const next = new Map(layoutOf(z).spots);
    for (const k of forget) next.delete(k);
    for (const [k, at] of Object.entries(changes)) next.set(k, at);
    if (z === "pack") {
      saveSaved(me.player.id, next);
      setSaved(Object.fromEntries(next));
    } else if (sideId !== null) {
      if (boxId !== null) saveSaved(me.player.id, next, boxId);
      setChestEdits({ id: sideId, saved: Object.fromEntries(next) });
    }
  };
  const tidy = (z: Zone) => {
    const fresh = layoutPack([...(z === "chest" ? chestShapes : shapes)].sort((a, b) => b.h - a.h || b.w - a.w), {}, z === "chest" ? chestRows : PACK_ROWS);
    if (z === "pack") {
      saveSaved(me.player.id, fresh.spots);
      setSaved(Object.fromEntries(fresh.spots));
    } else if (sideId !== null) {
      if (boxId !== null) saveSaved(me.player.id, fresh.spots, boxId);
      setChestEdits({ id: sideId, saved: Object.fromEntries(fresh.spots) });
    }
  };

  // A thing that has just arrived is given the first gap, and then keeps it: what was already lying there does not
  // shuffle up when something else comes or goes.
  useEffect(() => {
    if (!shapes.some((s) => !saved[s.key])) return;
    saveSaved(me.player.id, layout.spots);
    setSaved(Object.fromEntries(layout.spots));
  }, [shapes, saved, layout, me.player.id]);
  useEffect(() => {
    if (sideId === null || !chestShapes.some((s) => !chestSaved[s.key])) return;
    if (boxId !== null) saveSaved(me.player.id, chestLayout.spots, boxId);
    setChestEdits({ id: sideId, saved: Object.fromEntries(chestLayout.spots) });
  }, [sideId, boxId, chestShapes, chestSaved, chestLayout, me.player.id]);

  // What is in hand follows the pointer. Escape puts it back, or closes the chest, or the bag.
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = press.current;
      // A press that has travelled a little is a drag: the thing comes up off the grid.
      if (p && !p.dragging && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 6) {
        p.dragging = true;
        lift(p.stack, p.from, e);
      }
      if (!float.current) return;
      const z = uiZoom();
      float.current.style.left = `${e.clientX / z}px`;
      float.current.style.top = `${e.clientY / z}px`;
    };
    const up = (e: PointerEvent) => {
      const p = press.current;
      press.current = null;
      if (!p?.dragging) return;
      // Let go over a grid or a slot and it is set down there; anywhere else and it goes back.
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const slot = under?.closest<HTMLElement>(".doll-slot")?.dataset.slot as Slot | undefined;
      if (slot) drop.current.onSlot(slot);
      else if (under?.closest(".pack-grid-2")) drop.current.onGrid(e);
      else setHeld(null);
      // The release would otherwise count as a click on whatever is under it.
      const swallow = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => removeEventListener("click", swallow, { capture: true }), 0);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || catchOpen) return;
      if (held) setHeld(null);
      else if (chest) chest.onClose();
      else onClose();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
    addEventListener("keydown", key);
    return () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      removeEventListener("keydown", key);
    };
  }, [held, onClose, catchOpen, chest]);
  // A thing in hand that is no longer where it was lifted from (sold, stowed, traded away, its chest shut) is let go of.
  useEffect(() => {
    if (!held) return;
    const from = held.from === "worn" ? wornStacks : stacksOf(held.from);
    if (!from.some((s) => s.key === held.stack.key)) setHeld(null);
  });
  // A decoration that has left the chest has no buttons to show.
  useEffect(() => {
    if (pickedDecor !== null && !inside.some((f) => f.id === pickedDecor)) setPickedDecor(null);
  }, [pickedDecor, inside]);

  const equip = (id: number) => act(() => api.equip(id));
  const unequip = (id: number) => act(() => api.unequip(id));
  const lift = (stack: Stack, from: Held["from"], e: Point) => {
    setHeld({ stack, from });
    setHover(null);
    // Put the picture under the pointer at once, before it next moves.
    requestAnimationFrame(() => {
      if (!float.current) return;
      const z = uiZoom();
      float.current.style.left = `${e.clientX / z}px`;
      float.current.style.top = `${e.clientY / z}px`;
    });
  };

  // Where the thing in hand would be set down: centred on the pointer's square, kept inside that grid.
  const heldShape = held ? shapeOf(held.stack) : null;
  const aim = (() => {
    if (!held || !heldShape || !cell) return null;
    const z = cell.zone;
    const rows = z === "chest" ? chestRows : PACK_ROWS;
    const at = { x: Math.max(0, Math.min(PACK_COLS - heldShape.w, cell.x - Math.floor((heldShape.w - 1) / 2))), y: Math.max(0, Math.min(rows - heldShape.h, cell.y - Math.floor((heldShape.h - 1) / 2))) };
    const across = held.from !== z;
    // Coming from elsewhere it is a newcomer here, whatever shares its name: nothing under it is "itself".
    const hits = under(z === "chest" ? chestShapes : shapes, layoutOf(z).spots, across ? { ...heldShape, key: "" } : heldShape, at.x, at.y);
    const verdict: Verdict =
      heldShape.h > rows ? "bad"
      // Within a grid a thing may change places with one other (not a decoration, which stays put).
      : !across ? (hits.length === 0 ? "ok" : hits.length === 1 && !hits[0].startsWith("decor:") ? "swap" : "bad")
      : hits.length > 0 ? "bad"
      // Off the figure it goes into the pack; between the grids there has to be the room on the other side.
      : held.from === "worn" ? (z === "pack" ? "ok" : "bad")
      : z === "chest" ? (fitsIn(held.stack) ? "ok" : "bad")
      : outProblem(held.stack) ? "bad" : "ok";
    return { zone: z, at, hits, verdict };
  })();
  const targetIn = (z: Zone) => (aim && aim.zone === z && heldShape ? { at: aim.at, w: heldShape.w, h: heldShape.h, verdict: aim.verdict } : null);

  const setDown = (e: Point) => {
    if (!held || !aim || aim.verdict === "bad") return;
    const { zone, at, hits } = aim;
    const s = held.stack;
    if (held.from === "worn") {
      rememberIn("pack", { [s.key]: at });
      setHeld(null);
      if (s.t === "gear") void unequip(s.item.id);
    } else if (held.from === zone) {
      if (aim.verdict === "swap") {
        const other = stacksOf(zone).find((o) => o.key === hits[0])!;
        rememberIn(zone, { [s.key]: at }, [other.key]);
        lift(other, zone, e);
      } else {
        rememberIn(zone, { [s.key]: at });
        setHeld(null);
      }
    } else {
      // Across to the other grid: it lies where it was put, if it is a thing of its own or the first of its kind there.
      if (s.t === "gear") rememberIn(zone, { [s.key]: at });
      else if (!(zone === "chest" ? kept[s.kind] : packMats[s.kind])) rememberIn(zone, { [`mat:${s.kind}:0`]: at });
      setHeld(null);
      if (zone === "chest") moveIn(s);
      else moveOut(s);
    }
  };

  /** Set what is in hand on the figure: gear from the pack is worn (the server puts it in its own slot); anything else is put back. */
  const wearHeld = () => {
    const inHand = held?.stack.t === "gear" && held.from === "pack" ? held.stack.item : null;
    if (inHand && !equipProblem(inHand, c.class_id, c.level)) void equip(inHand.id);
    setHeld(null);
  };
  drop.current = { onGrid: setDown, onSlot: wearHeld };

  /** What a grid needs to hear from the things on it. */
  const gridHandlers = (zone: Zone) => ({
    onCell: (at: Spot | null) => setCell((was) => (at ? (was?.zone === zone && was.x === at.x && was.y === at.y ? was : { ...at, zone }) : was?.zone === zone ? null : was)),
    onSetDown: setDown,
    onHover: (key: string | null) => setHover(key ? { zone, key } : null),
    onPress: (s: Stack, e: Point) => { press.current = { stack: s, from: zone, x: e.clientX, y: e.clientY, dragging: false }; },
    onPick: (s: Stack, e: Point) => lift(s, zone, e),
  });
  const putBack = (e: ReactMouseEvent) => {
    if (!held) return;
    e.preventDefault();
    setHeld(null);
  };

  const slotCell = (slot: Slot) => {
    const item = worn.get(slot);
    const at = DOLL[slot];
    const inHand = held?.stack.t === "gear" && held.from === "pack" ? held.stack.item : null;
    // The slot the thing in hand belongs in lights up; one it cannot be worn in at all is marked.
    const fits = inHand?.slot === slot;
    const cannot = fits && !!equipProblem(inHand!, c.class_id, c.level);
    const style: CSSProperties = { left: at.x * U, top: at.y * U, width: at.w * U, height: at.h * U, ...(item ? ({ borderColor: RARITY_COLOR[item.rarity], "--tint": RARITY_COLOR[item.rarity] } as CSSProperties) : {}) };
    return (
      <button
        key={slot}
        className={`doll-slot ${item ? "" : "empty"} ${fits ? (cannot ? "cannot" : "fits") : ""} ${held?.from === "worn" && held.stack.key === `gear:${item?.id}` ? "lifted" : ""}`}
        style={style}
        title={item ? undefined : `${SLOT_LABEL[slot]}: empty`}
        onPointerEnter={() => !held && setHover(item ? { zone: "worn", key: `gear:${item.id}` } : null)}
        onPointerLeave={() => setHover(null)}
        data-slot={slot}
        onPointerDown={(e) => {
          if (!held && item && e.button === 0 && !e.shiftKey) press.current = { stack: { t: "gear", key: `gear:${item.id}`, item }, from: "worn", x: e.clientX, y: e.clientY, dragging: false };
        }}
        onClick={(e) => {
          if (held) {
            wearHeld();
          } else if (item) {
            if (e.shiftKey) void unequip(item.id);
            else lift({ t: "gear", key: `gear:${item.id}`, item }, "worn", e);
          }
        }}
      >
        {item ? <Icon name={item.icon} color={RARITY_COLOR[item.rarity]} size={iconPx(at.w, at.h)} /> : <Icon name={SLOT_ICON[slot]} color="#4a4336" size={iconPx(at.w, Math.min(at.h, at.w))} silhouette />}
        {!item && <span className="slot-name">{SLOT_LABEL[slot]}</span>}
        {item && item.power > 0 && <span className="badge br">+{item.power}</span>}
      </button>
    );
  };

  // What the gear worn adds up to, for the strip under it.
  const loadout = loadoutOf([...worn.values()]);
  const bonus = loadout.bonus;
  const stats = { str: c.str + (bonus.str ?? 0), int_stat: c.int_stat + (bonus.int_stat ?? 0), vit: c.vit + (bonus.vit ?? 0), agi: c.agi + (bonus.agi ?? 0), dex: c.dex + (bonus.dex ?? 0) };
  const shown = hover ? (hover.zone === "worn" ? wornStacks : hover.zone === "theirs" ? theirStacks : stacksOf(hover.zone)).find((s) => s.key === hover.key) ?? null : null;
  const holding = held?.stack.t === "gear" && held.from === "pack" ? held.stack.item : null;
  const picked = inside.find((f) => f.id === pickedDecor) ?? null;

  return (
    <div className={`overlay inv-overlay bag-overlay ${sideOpen ? "with-chest" : ""}`}>
      {trade && (
        <div className={`bag trade-window panel window ${held ? "holding" : ""}`} role="dialog" aria-label={`Trade with ${trade.with}`} style={{ "--u": `${CU}px` } as CSSProperties} onContextMenu={putBack}>
          <span className="win-plate">Trade</span>
          <button className="bag-close hud-btn" aria-label="Cancel the trade" title="Cancel the trade (Esc)" onClick={onClose}>×</button>
          <div className="trade-tabs"><span className="trade-tab">{trade.with}</span></div>

          {/* Each side's box is ringed in green once that player has accepted the table as it stands. */}
          <section className={`trade-box ${trade.theirs.ok ? "ok" : ""}`} aria-label={`${trade.with}'s offer${trade.theirs.ok ? ", accepted" : ""}`}>
            <h3>{trade.with}'s offer{trade.theirs.ok && <span className="trade-said">Accepted</span>}</h3>
            <div className="pack-wrap">
              <PackGrid
                zone="theirs"
                name={`${trade.with}'s offer`}
                u={CU}
                rows={theirLayout.rows}
                baseRows={TRADE_ROWS}
                stacks={theirStacks}
                spots={theirLayout.spots}
                held={null}
                target={null}
                onCell={() => undefined}
                onSetDown={() => undefined}
                onHover={(key) => setHover(key ? { zone: "theirs", key } : null)}
                onPress={() => undefined}
                onPick={() => undefined}
                onQuick={() => undefined}
              />
            </div>
            <div className="trade-gold" title={`Gold ${trade.with} adds to the trade`}><Icon name="cash" color="#ffd23f" size={20} /><strong>{trade.theirs.gold}</strong><span className="muted">gold</span></div>
          </section>

          <section className={`trade-box ${trade.mineOk ? "ok" : ""}`} aria-label={`Your offer${trade.mineOk ? ", accepted" : ""}`}>
            <h3>Your offer{trade.mineOk && <span className="trade-said">Accepted</span>}</h3>
            <div className="pack-wrap">
              <PackGrid
                zone="chest"
                name="Your offer"
                u={CU}
                rows={chestLayout.rows}
                baseRows={TRADE_ROWS}
                stacks={chestStacks}
                spots={chestLayout.spots}
                held={held}
                target={targetIn("chest")}
                {...gridHandlers("chest")}
                // Shift-click: back into the pack.
                onQuick={(s) => moveOut(s)}
                onSplit={(s, at) => setSplit({ stack: s, into: false, at })}
              />
            </div>
            <label className="trade-gold" title="Gold you add to the trade">
              <Icon name="cash" color="#ffd23f" size={20} />
              <input
                type="number"
                min={0}
                max={c.gold}
                step={1}
                inputMode="numeric"
                placeholder="0"
                aria-label="Gold you offer"
                value={trade.mine.gold || ""}
                onChange={(e) => trade.setMine({ ...trade.mine, gold: Math.max(0, Math.min(c.gold, Math.floor(Number(e.target.value)) || 0)) })}
              />
              <span className="muted">of your {c.gold} gold</span>
            </label>
          </section>

          {trade.theirs.missing > 0 && <p className="bad trade-note">{trade.with} no longer has {trade.theirs.missing === 1 ? "one of the things" : "some of the things"} they offered.</p>}
          {(trade.note ?? refused ?? (trade.mineOk ? null : trade.problem)) && <p className="bad trade-note" role="status">{trade.note ?? refused ?? trade.problem}</p>}
          <footer className="bag-foot trade-foot">
            <button className={trade.mineOk ? "" : "primary"} disabled={trade.busy || (!trade.mineOk && !!trade.problem)} onClick={() => trade.accept(!trade.mineOk)}>
              {trade.mineOk ? "Cancel accept" : "Accept"}
            </button>
            <span className="muted trade-state">
              {trade.mineOk && trade.theirs.ok ? "Trading…" : trade.mineOk ? `Waiting for ${trade.with} to accept.` : trade.theirs.ok ? `${trade.with} has accepted.` : "Shift-click or drag things from your bag."}
            </span>
            <span className="spacer" />
            <button onClick={onClose}>Cancel</button>
          </footer>
        </div>
      )}
      {chest && box && (
        <div className={`bag chest-window panel window ${held ? "holding" : ""}`} role="dialog" aria-label={box.label} style={{ "--u": `${CU}px` } as CSSProperties} onContextMenu={putBack}>
          <span className="win-plate">{box.label}</span>
          <button className="bag-close hud-btn" aria-label={`Close the ${box.label}`} title="Close (Esc)" onClick={chest.onClose}>×</button>
          {!own ? <p className="muted chest-wait">Counting…</p> : (
            <div className="pack-wrap">
              <PackGrid
                zone="chest"
                name={`In the ${box.label}`}
                u={CU}
                rows={chestLayout.rows}
                baseRows={chestRows}
                stacks={chestStacks}
                decor={inside}
                spots={chestLayout.spots}
                held={held}
                target={targetIn("chest")}
                {...gridHandlers("chest")}
                // Shift-click: straight out into the pack. The server says why not, if the pack has no room.
                onQuick={(s) => moveOut(s)}
                onSplit={(s, at) => setSplit({ stack: s, into: false, at })}
                onDecor={(id) => setPickedDecor((was) => (was === id ? null : id))}
                pickedDecor={pickedDecor}
              />
            </div>
          )}

          {(picked || looseDecor.length > 0) && (
            <div className="chest-decor">
              {picked && (
                <div className="hut-box-row">
                  <span className="with-icon"><ThingIcon icon={furnishingIcon(picked.defId)} size={27} />{picked.label}</span>
                  <button className="small" onClick={() => chest.carry(picked.id)}>Set out</button>
                  <button className="small" onClick={() => chest.send({ type: "pick_up", id: picked.id })}>To storage</button>
                </div>
              )}
              {looseDecor.length > 0 && (
                <div className="row">
                  <select value={addPiece} onChange={(e) => setAddPiece(e.target.value)} aria-label="Decoration to put in">
                    <option value="">A decoration from storage…</option>
                    {looseDecor.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                  </select>
                  <button className="small" disabled={!addPiece || chestFree < 1} onClick={() => (chest.send({ type: "put_in", id: Number(addPiece), into: box.id }), setAddPiece(""))}>Put in</button>
                </div>
              )}
            </div>
          )}

          <footer className="bag-foot">
            <span
              className={`carry ${chestUsed > chestTotal ? "bad" : chestUsed === chestTotal ? "warn" : "muted"}`}
              title={`${CHEST_COLS} × ${chestRows} squares. Each thing takes its own footprint; a stack of up to ${STACK_MAX} of a material takes one, and so does a decoration. What is kept in here is used for crafting and building at home.`}
            >
              {chestUsed} / {chestTotal}{chestUsed > chestTotal ? " · over" : ""}
            </span>
            <span className="muted chest-keys">Shift-click sends a thing across · right-click splits a stack</span>
            <span className="spacer" />
            <button className="small" title="Pack everything tight, biggest first" onClick={() => tidy("chest")}>Tidy</button>
          </footer>
        </div>
      )}

      <div className={`bag panel window ${held ? "holding" : ""}`} role="dialog" aria-label="Sea bag" style={{ "--u": `${U}px` } as CSSProperties} onContextMenu={putBack}>
        <span className="win-plate">Sea Bag</span>
        <button className="bag-close hud-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>×</button>
        {(error ?? (trade ? null : refused)) && <div className="banner error">{error ?? refused}</div>}

        <div className="bag-doll" style={{ height: DOLL_ROWS * U }}>
          <DollChart slots={CHART_SLOTS} unit={U} focus={{ x: DOLL.body.x + DOLL.body.w / 2, y: DOLL.body.y + DOLL.body.h / 2 }} pad={{ x: 3, y: 8 }} />
          {SLOTS.map(slotCell)}
          {TO_COME.map((t) => (
            <span
              key={t.id}
              className={`doll-slot empty to-come ${t.id}`}
              style={{ left: t.x * U, top: t.y * U, width: t.w * U, height: t.h * U }}
              title={`${t.label}: nothing to wear here yet`}
              // Set down here, a thing just goes back where it was.
              onClick={() => held && setHeld(null)}
            >
              {t.icon && <Icon name={t.icon} color="#4a4336" size={iconPx(1, 1)} silhouette />}
              <span className="slot-name">{t.label}</span>
            </span>
          ))}
        </div>

        {/* Between the gear and the pack: who this is and what the gear adds up to; or, with a thing in hand, what can be done with it. */}
        <div className="bag-strip">
          {holding ? (
            <>
              <strong className="bag-who" style={{ color: RARITY_COLOR[holding.rarity] }}>{holding.name}</strong>
              <span className="spacer" />
              {!trade && <button className="small" disabled={busy} onClick={() => { setHeld(null); void act(() => api.sell(holding.id)); }}>Sell · {sellPrice(holding)}g</button>}
              {!sideOpen && (
                <button
                  className="small"
                  disabled={busy || !carry?.hasHome || carry.room <= 0}
                  title={!carry?.hasHome ? "You have no storage yet. Build a shack on a plot in the Harbor." : carry.room <= 0 ? "Every chest at home is full." : "Off to a chest in your hut. Take it back from inside the hut."}
                  onClick={() => { setHeld(null); void act(() => api.store(holding.id)); }}
                >
                  Send to storage
                </button>
              )}
            </>
          ) : (
            <>
              <strong className="bag-who">{c.name}</strong>
              <span className="spacer" />
              <span className="bag-stat" title="Hit points at the start of a voyage"><Icon name="crowned-heart" color="#d8342a" size={18} flat />{maxHpFor(stats, c.level)}</span>
              <span className="bag-stat" title={`Armor: each enemy hit is reduced by ${armorBlock(loadout.armor)}, up to half the hit`}><Icon name="round-shield" color="#7fc4e8" size={18} flat />{loadout.armor}</span>
              <span className="bag-stat" title="Weapon power: added to the damage of every ability"><Icon name="broadsword" color="#f4c64e" size={18} flat />+{loadout.weaponPower}</span>
            </>
          )}
        </div>

        <div className="pack-wrap">
          <PackGrid
            zone="pack"
            name="Your pack"
            u={U}
            rows={layout.rows}
            baseRows={PACK_ROWS}
            stacks={stacks}
            spots={layout.spots}
            held={held}
            target={targetIn("pack")}
            lockedOf={(s) => s.t === "gear" && !!equipProblem(s.item, c.class_id, c.level)}
            {...gridHandlers("pack")}
            // Shift-click: into the chest, or onto the trade table, while one is open; otherwise gear is worn.
            onQuick={(s) => {
              if (sideOpen) moveIn(s);
              else if (s.t === "gear" && !equipProblem(s.item, c.class_id, c.level)) void equip(s.item.id);
            }}
            onSplit={sideOpen ? (s, at) => setSplit({ stack: s, into: true, at }) : undefined}
          />
        </div>

        <footer className="bag-foot">
          <span className="gold" title="Gold"><Icon name="cash" color="#ffd23f" size={18} /> {c.gold}</span>
          {carry && (
            <span
              className={`carry ${packUsed > carry.limit ? "bad" : packUsed === carry.limit ? "warn" : "muted"}`}
              title={`The pack is ${CARRY_FORMULA}. Each thing takes its own footprint; a stack of up to ${STACK_MAX} of a material takes one.${carry.hasHome ? ` ${carry.room} free squares in the chests at home.` : " No storage yet: build a shack on a plot in the Harbor for a chest."}`}
            >
              {packUsed} / {carry.limit}{packUsed > carry.limit ? " · over" : ""}
            </span>
          )}
          <span className="spacer" />
          <button className="small" title="Pack everything tight, biggest first" onClick={() => tidy("pack")}>Tidy</button>
          {!onIsland && <button className="small" onClick={() => setCatchOpen(true)} title="The icebox and the trophy chest">Your catch</button>}
        </footer>

        {/* The card stands out to the bag's left. With a chest open there, it lies over the gear instead, clear of both grids (unless it is the gear being looked at). */}
        {shown && !held && !split && hover && (
          <aside className={`bag-card panel ${sideOpen && hover.zone !== "worn" ? "over-doll" : ""}`}>
            {shown.t === "gear"
              ? <ItemDetail item={shown.item} current={worn.get(shown.item.slot) ?? null} equipped={shown.item.equipped} classId={c.class_id} level={c.level} />
              : <MaterialDetail kind={shown.kind} total={shown.total} where={hover.zone === "theirs" ? "theirs" : hover.zone === "chest" ? (trade ? "offer" : "chest") : "pack"} />}
          </aside>
        )}
      </div>

      {held && (
        <div ref={float} className="held-float" aria-hidden>
          {held.stack.t === "gear"
            ? <Icon name={held.stack.item.icon} color={RARITY_COLOR[held.stack.item.rarity]} size={iconPx(heldShape!.w, heldShape!.h)} />
            : <ThingIcon icon={resourceIcon(held.stack.kind)} size={iconPx(1, 1)} />}
        </div>
      )}
      {split && (
        <SplitPrompt
          name={stackName(split.stack)}
          // Into the chest: as many as fit in its free squares (topping up a part-full stack first). Out: the stack.
          max={split.into ? Math.min(split.stack.qty, chestFree * STACK_MAX + (stackSlots(kept[split.stack.kind] ?? 0) * STACK_MAX - (kept[split.stack.kind] ?? 0))) || 1 : split.stack.qty}
          at={split.at}
          verb={split.into ? (trade ? "Offer" : "Stow") : trade ? "Take back" : "Take"}
          onPick={(n) => {
            (split.into ? moveIn : moveOut)(split.stack, n);
            setSplit(null);
          }}
          onClose={() => setSplit(null)}
        />
      )}
      {catchOpen && <CatchPanel buyer={null} onClose={() => setCatchOpen(false)} />}
    </div>
  );
}

/** What a material is and where it goes. */
function MaterialDetail({ kind, total, where = "pack" }: { kind: ResourceKind; total: number; where?: "pack" | "chest" | "offer" | "theirs" }) {
  const price = (STALL_BUYS as Partial<Record<ResourceKind, number>>)[kind];
  return (
    <div className="mat-detail">
      <div className="detail-head">
        <span className="detail-icon" style={{ borderColor: "var(--line)" }}><ThingIcon icon={resourceIcon(kind)} size={54} /></span>
        <div>
          <strong>{label("resource", kind)}</strong>
          <div><span className="tag" style={{ marginLeft: 0 }}>material</span></div>
        </div>
      </div>
      <p>{where === "chest" ? "Kept in here:" : where === "offer" ? "You offer" : where === "theirs" ? "Offered to you:" : "You carry"} <strong>{total}</strong>, {Math.ceil(total / STACK_MAX)} square{total > STACK_MAX ? "s" : ""} of up to {STACK_MAX}.</p>
      <p className="muted">Spent from your pack on crafting, building, crew projects and the workshops. Inside your own hut, what is in its chests counts too.</p>
      {where === "chest" || where === "offer"
        ? <p className="muted">Shift-click to take the stack {where === "offer" ? "back" : "out"}, or right-click to take part of it.</p>
        : where === "pack" && <p className="muted">Stow it in a chest in your hut to free the square, or hand it to a crewmate in a trade.</p>}
      {price && <p className="muted">The market stall buys it for {price}g each.</p>}
    </div>
  );
}

// Kept for callers that list gear outside the bag.
export { ItemTile };
