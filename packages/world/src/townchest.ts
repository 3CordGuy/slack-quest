// The town chest: one store the whole crew shares, kept at the works.
//
// It has tabs, each for one sort of thing, and each a grid of squares that
// stacks sit in as they do in a pack (a square a stack of up to STACK_MAX).
// Anyone in the crew may put in what they carry and take out what is there.
// A tab starts small and is made bigger a row at a time: whoever pays for
// the row pays for everyone.
//
//   lodestones  the stones that open a place on the atlas (lodestone.ts),
//               so a crew can pool what it finds.
//   materials   what is gathered and built with.
//
// Gear has no tab yet: a piece of gear takes a shape in a pack, not a
// square, and the chest's grids do not know shapes.

import { RESOURCE_KINDS, type ResourceKind, type Resources } from "./hut";
import { STACK_MAX, addedSlots, stackSlots } from "./carry";
import { stoneOfItem } from "./lodestone";

export type ChestTab = "lodestones" | "materials";
export const CHEST_TABS: { id: ChestTab; name: string; blurb: string }[] = [
  { id: "lodestones", name: "Lodestones", blurb: "Stones for the atlas. Take one out to put it into a place's slot." },
  { id: "materials", name: "Materials", blurb: "What the crew has gathered: for building, brewing and the smith." },
];
const TAB_IDS = CHEST_TABS.map((t) => t.id);

/** How many squares across a tab is, how many rows it starts with, and the most it can be made. */
export const TOWN_CHEST_COLS = 6;
export const TOWN_CHEST_ROWS = 2;
export const TOWN_CHEST_ROWS_MAX = 8;
/** The most that can be moved in one go. */
export const TOWN_CHEST_MOVE_MAX = STACK_MAX * TOWN_CHEST_COLS;

/** The tab an id names, or null. */
export const chestTab = (raw: unknown): ChestTab | null => (TAB_IDS.includes(raw as ChestTab) ? (raw as ChestTab) : null);

/** Whether a kind of thing (a material's kind, or a lodestone's as an item) belongs in a tab. */
export function chestTakes(tab: ChestTab, kind: unknown): boolean {
  if (typeof kind !== "string") return false;
  return tab === "lodestones" ? stoneOfItem(kind) !== null : RESOURCE_KINDS.includes(kind as ResourceKind);
}

/** How many squares of a tab what is in it fills. */
export const chestUsed = (held: Record<string, number>): number => Object.values(held).reduce((n, qty) => n + stackSlots(qty), 0);

/** Why `n` more of a kind will not go into a tab of this many rows holding `held`, or null if it will. */
export function chestPutProblem(tab: ChestTab, rows: number, held: Record<string, number>, kind: unknown, n: number): string | null {
  if (!chestTakes(tab, kind)) return "That does not belong in this tab.";
  if (!Number.isInteger(n) || n < 1 || n > TOWN_CHEST_MOVE_MAX) return "That is not an amount.";
  return chestUsed(held) + addedSlots(held[kind as string] ?? 0, n) > rows * TOWN_CHEST_COLS ? "There is no room left in this tab. It can be made bigger." : null;
}

/** What the next row of a tab costs, when it has `rows` already: more each time. Null once it is as big as it gets. */
export function chestRowCost(rows: number): { gold: number; resources: Resources } | null {
  if (rows >= TOWN_CHEST_ROWS_MAX) return null;
  const step = Math.max(1, rows - TOWN_CHEST_ROWS + 1);
  return { gold: 60 * step, resources: { wood: 8 * step, iron: 2 * step } };
}
