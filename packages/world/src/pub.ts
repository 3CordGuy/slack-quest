// The crew's pub: a room off the Harbor, bigger than any hut, with a bar, a
// barkeep, tables and the dice table.
//
// Like the Harbor and the huts it has no reducer. People walk freely and the
// PubRoom Durable Object checks each request against what is here: the room,
// the fittings that are walked around, and the menu.
//
// Food and drink are small one-voyage boosts. A hero carries at most one
// drink and one meal; ordering another of the same kind replaces it. They are
// used up when that hero's next voyage begins.

import type { HexGrid, HexPos } from "@gantt-quest/core";
import type { DiceRequest, DiceView } from "./dice";
import type { ShoalsRequest, ShoalsView } from "./shoals";
import { harborPoi, type HarborPlayer, type XpMessage } from "./harbor";
import type { Perk } from "./hut";
import { buildRoom, hutPath } from "./hutroom";
import type { WorldMap } from "./map";

/** The floor is 10 by 7: larger than the biggest hut (8 by 6). */
export const PUB_GRID: HexGrid = { cols: 12, rows: 9 };

/** Offset coordinates (column, row) to the axial coordinates the map uses. */
const at = (col: number, row: number): HexPos => ({ q: col - Math.floor(row / 2), r: row });

/** Where a customer stands to order or to talk to the barkeep. */
export const PUB_COUNTER: HexPos = at(3, 3);
/** Where players stand to sit at the dice table. */
export const PUB_DICE: HexPos = at(7, 5);
/** Where players stand to sit at the Shoals table. */
export const PUB_SHOALS: HexPos = at(5, 5);
/** The barkeep's spot, behind the bar. */
export const PUB_BARKEEP_POS: HexPos = at(3, 1);
export const PUB_BARKEEP = { id: "barkeep", name: "Old Tam" } as const;
/** Where a traveling salesman stands when one is in (see salesman.ts): the corner by the far wall. Nobody else stands there. */
export const PUB_SALESMAN_POS: HexPos = at(10, 4);
/** Where a customer stands to trade with the salesman. */
export const PUB_TRADER: HexPos = at(9, 4);
/**
 * Where the day's regulars (see regulars.ts) stand, in the order they take
 * them, each with the hex a customer walks to when the regular is clicked.
 * Nobody else stands on a regular's spot, whether or not one is in.
 */
export const PUB_REGULAR_SPOTS: { pos: HexPos; stand: HexPos }[] = [
  { pos: at(8, 2), stand: at(7, 2) },
  { pos: at(1, 4), stand: at(2, 4) },
  { pos: at(4, 7), stand: at(4, 6) },
];

export interface PubFitting {
  id: number;
  model: string;
  q: number;
  r: number;
  facing: number;
}

const fit = (id: number, model: string, col: number, row: number, facing = 0): PubFitting => ({ id, model, ...at(col, row), facing });

/** The furniture. It never moves, and it is walked around. */
export const PUB_FITTINGS: PubFitting[] = [
  fit(1, "bar", 2, 2),
  fit(2, "bar", 3, 2),
  fit(3, "bar", 4, 2),
  fit(4, "keg", 1, 1),
  fit(5, "keg", 5, 1),
  fit(6, "hearth", 9, 1),
  fit(7, "table", 8, 3),
  fit(8, "chair", 7, 3, 1),
  fit(9, "chair", 9, 3, 4),
  fit(10, "table", 2, 6),
  fit(11, "chair", 1, 6, 1),
  fit(12, "chair", 3, 6, 4),
  fit(13, "table", 9, 6),
  fit(14, "chair", 8, 6, 1),
  // The salesmen's sea chest, beside the corner they take.
  fit(15, "chest", 10, 6, 5),
];

/** The room: the same every time. The counter, the two game tables and the trader's spot are places to stand, not obstacles. */
export function pubRoom(): WorldMap {
  const room = buildRoom(PUB_GRID);
  return { ...room, pois: [...room.pois, harborPoi("counter", "counter", PUB_COUNTER), harborPoi("dice", "dice", PUB_DICE), harborPoi("shoals", "shoals", PUB_SHOALS), harborPoi("trader", "trader", PUB_TRADER)] };
}

/** A walkable route across the pub, or null. The barkeep's side of the bar is his alone, the salesmen's corner theirs, and the regulars' spots theirs. */
export function pubPath(room: WorldMap, from: HexPos, to: HexPos): HexPos[] | null {
  return hutPath(room, [...PUB_FITTINGS, PUB_BARKEEP_POS, PUB_SALESMAN_POS, ...PUB_REGULAR_SPOTS.map((s) => s.pos)], from, to);
}

// ---------- the menu ----------

export type PubKind = "drink" | "food";

export interface PubItem {
  id: string;
  name: string;
  kind: PubKind;
  price: number;
  blurb: string;
  /** What it adds on the next voyage. */
  buff: Perk;
}

export const PUB_MENU: PubItem[] = [
  { id: "ale", name: "Harbor Ale", kind: "drink", price: 8, blurb: "Flat, warm and dependable.", buff: { maxHp: 2 } },
  { id: "rum", name: "Spiced Rum", kind: "drink", price: 14, blurb: "Clears the head, briefly.", buff: { focus: 1 } },
  { id: "stew", name: "Fish Stew", kind: "food", price: 12, blurb: "Mostly fish.", buff: { maxHp: 4 } },
  { id: "pie", name: "Sailor's Pie", kind: "food", price: 18, blurb: "Eaten slowly, with stories.", buff: { xpPct: 5 } },
];

export const pubItem = (id: string): PubItem | undefined => PUB_MENU.find((i) => i.id === id);

/**
 * What a hero's food and drink add up to. At most one of each kind counts,
 * whatever is passed in, so the most a pub can give is one drink plus one meal.
 */
export function pubBuff(itemIds: readonly string[]): Required<Perk> {
  const total: Required<Perk> = { focus: 0, potions: 0, maxHp: 0, xpPct: 0 };
  const had = new Set<PubKind>();
  for (const id of itemIds) {
    const item = pubItem(id);
    if (!item || had.has(item.kind)) continue;
    had.add(item.kind);
    for (const key of Object.keys(total) as (keyof Perk)[]) total[key] += item.buff[key] ?? 0;
  }
  return total;
}

/** The most any pub order can give, used to bound whatever a caller sends. */
export const PUB_BUFF_CAPS: Required<Perk> = (() => {
  const cap: Required<Perk> = { focus: 0, potions: 0, maxHp: 0, xpPct: 0 };
  for (const kind of ["drink", "food"] as PubKind[]) {
    for (const key of Object.keys(cap) as (keyof Perk)[]) {
      cap[key] += Math.max(0, ...PUB_MENU.filter((i) => i.kind === kind).map((i) => i.buff[key] ?? 0));
    }
  }
  return cap;
})();

export function capPubBuff(buff: Perk | undefined): Required<Perk> {
  const out: Required<Perk> = { focus: 0, potions: 0, maxHp: 0, xpPct: 0 };
  for (const key of Object.keys(out) as (keyof Perk)[]) out[key] = Math.max(0, Math.min(PUB_BUFF_CAPS[key], Math.floor(buff?.[key] ?? 0)));
  return out;
}

/** Longest thing a customer may say to the barkeep. */
export const PUB_MAX_TALK = 200;

// ---------- wire types ----------

export type PubServerMessage =
  | { type: "snapshot"; you: string; players: HarborPlayer[] }
  | { type: "joined"; player: HarborPlayer }
  | { type: "left"; id: string }
  | { type: "moved"; id: string; path: HexPos[] }
  | { type: "placed"; id: string; pos: HexPos }
  | { type: "said"; id: string; name: string; text: string }
  | { type: "dice"; table: DiceView | null }
  | { type: "diceError"; text: string }
  | { type: "shoals"; table: ShoalsView | null }
  | { type: "shoalsError"; text: string }
  | XpMessage;

export type PubClientMessage =
  | { type: "move"; to: HexPos }
  | { type: "say"; text: string }
  /** Back to the door, for a stuck or lost hero. */
  | { type: "unstick" }
  | { type: "dice"; action: DiceRequest }
  | { type: "shoals"; action: ShoalsRequest };
