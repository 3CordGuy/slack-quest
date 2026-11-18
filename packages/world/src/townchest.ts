// The town chest: one store the whole crew shares. It stands in the Harbor's
// plaza (harbor.ts: HARBOR_CHEST), where anyone can walk up to it, and it
// opens like a chest at home: beside the pack, with things dragged across.
// Anyone in the crew may put in what they carry and take out what is there.
//
// It has tabs. A crew starts with three, and may buy more.
//
//   general     a grid like a sea chest's (CHEST_COLS across, TOWN_TAB_ROWS
//               down): gear by its footprint, and stacks of materials and
//               of lodestones a square each. The tabs a crew buys are these.
//   materials   one place for each kind of material, and no squares to run
//               out of: what the crew has gathered, at a glance.
//   lodestones  the stones that open a place on the atlas, sorted by how
//               much they carry.
//
// A tab has a name and may have a colour, which anyone in the crew may
// change, and the tabs stand in whatever order the crew drags them into.
// The next general tab costs gold, more each time, out of the pack of
// whoever buys it for everyone.

import { RESOURCE_KINDS, CHEST_COLS, type ResourceKind } from "./hut";
import { addedSlots, stackSlots } from "./carry";
import { stoneOfItem } from "./lodestone";

export type TabKind = "general" | "materials" | "lodestones";
export const TAB_KINDS: TabKind[] = ["general", "materials", "lodestones"];

/** The tabs a crew's chest has from the start. */
export const STARTING_TABS: { name: string; kind: TabKind }[] = [
  { name: "Chest", kind: "general" },
  { name: "Materials", kind: "materials" },
  { name: "Lodestones", kind: "lodestones" },
];

/** How many rows of squares a general tab has, and so how many squares. */
export const TOWN_TAB_ROWS = 8;
export const TOWN_TAB_CELLS = CHEST_COLS * TOWN_TAB_ROWS;
/** The most tabs a chest has, all told. */
export const TOWN_TABS_MAX = 12;
/** The longest a tab's name may be. */
export const TOWN_TAB_NAME = 18;
/** The most of one kind of thing a materials or lodestones tab holds, and the most moved in one go. */
export const TOWN_STACK_MAX = 9999;

/** The colours a tab can be given. What each looks like is the client's business. */
export const TOWN_TAB_COLORS = ["brass", "red", "orange", "gold", "green", "teal", "blue", "violet", "rose", "slate"] as const;
export type TabColor = (typeof TOWN_TAB_COLORS)[number];
/** A tab's colour as it was sent, if it is one of them. Null for anything else: the tab goes back to having none. */
export const cleanTabColor = (raw: unknown): TabColor | null => (TOWN_TAB_COLORS.includes(raw as TabColor) ? (raw as TabColor) : null);

/**
 * The order of a chest's tabs (their ids) once the one called `id` has been moved to stand `to`th (from 0;
 * past either end is the end). Null if there is no such tab or `to` is not a place.
 */
export function movedTabs(order: readonly number[], id: unknown, to: unknown): number[] | null {
  const from = order.indexOf(id as number);
  if (from < 0 || typeof to !== "number" || !Number.isInteger(to)) return null;
  const rest = order.filter((t) => t !== id);
  rest.splice(Math.max(0, Math.min(rest.length, to)), 0, id as number);
  return rest;
}

/** What the next general tab costs in gold, when the chest has this many general tabs already: more each time. */
export const townTabCost = (general: number): number => 150 * Math.max(1, general);

/** A tab's name as it was typed, made fit to keep: trimmed, its spaces single, not too long. Null if nothing is left. */
export function cleanTabName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim().slice(0, TOWN_TAB_NAME).trim();
  return name.length > 0 ? name : null;
}

/** What a stack is, by its kind as an item: a material, a lodestone, or neither. */
export const stackSort = (kind: unknown): "material" | "lodestone" | null =>
  typeof kind !== "string" ? null : RESOURCE_KINDS.includes(kind as ResourceKind) ? "material" : stoneOfItem(kind) !== null ? "lodestone" : null;

/** Whether a tab of this kind takes gear, and whether it takes a stack of this kind of thing. */
export const tabTakesGear = (tab: TabKind): boolean => tab === "general";
export function tabTakesStack(tab: TabKind, kind: unknown): boolean {
  const sort = stackSort(kind);
  return sort !== null && (tab === "general" || (tab === "materials" ? sort === "material" : sort === "lodestone"));
}

/** How many squares of a general tab are filled: each piece of gear's footprint, and a square a stack. */
export const tabUsed = (gearCells: readonly number[], stacks: Record<string, number>): number =>
  gearCells.reduce((n, c) => n + c, 0) + Object.values(stacks).reduce((n, qty) => n + stackSlots(qty), 0);

/** Why `n` more of a kind of thing will not go into a tab, or null if it will. `used` is the squares filled in it now; `held` what stacks it holds. */
export function stackPutProblem(tab: TabKind, used: number, held: Record<string, number>, kind: unknown, n: unknown): string | null {
  if (!tabTakesStack(tab, kind)) return "That does not belong in this tab.";
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > TOWN_STACK_MAX) return "That is not an amount.";
  const have = held[kind as string] ?? 0;
  if (tab !== "general") return have + n > TOWN_STACK_MAX ? "This tab holds no more of that." : null;
  return used + addedSlots(have, n) > TOWN_TAB_CELLS ? "There is no room left in this tab." : null;
}

/** Why a piece of gear of this many squares will not go into a tab, or null if it will. */
export function gearPutProblem(tab: TabKind, used: number, cells: number): string | null {
  if (!tabTakesGear(tab)) return "Gear does not belong in this tab.";
  return used + cells > TOWN_TAB_CELLS ? "There is no room left in this tab." : null;
}
