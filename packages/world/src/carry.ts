// What a hero can carry, and where things go when the pack is full.
//
// The pack is a grid, PACK_COLS squares across and PACK_ROWS down, the same
// for every hero. A thing takes up the squares of its footprint: a ring one,
// a helm two by two, a coat two by three, a staff two by four. A material
// (wood, stone, herbs...) sits in stacks of up to STACK_MAX, one square a
// stack. Worn gear takes no room. The rules count squares: a hero can take
// a thing on while its squares, added to those already filled, fit in the
// pack. Where each thing lies in the grid is the player's own business (the
// client arranges it), so a pack that is nearly full of awkward shapes may
// need tidying before the last thing shows a place.
//
// Everything else waits in the containers of their hut (hut.ts `storage`:
// the free Storage Chest every home has, plus any chests, crates and
// cupboards they add), where each thing takes one slot whatever its shape.
// Gear can be sent there from anywhere, but only taken out while standing
// in your own hut. Materials are spent from the pack; crafting and building
// inside your own hut also reach into its containers.
//
// Nothing earned is ever lost to a full pack. Loot that does not fit goes
// to a container at home with room; with no home yet, or every container
// full, it goes into the pack anyway, over the limit, and the hero simply
// cannot take on more until they are back under it. Buying and trades are
// refused instead, since the player can choose not to.

import type { Stats } from "@gantt-quest/core";
import type { Slot } from "./gear";
import { RESOURCE_KINDS, type Resources } from "./hut";

/** The pack's grid. */
export const PACK_COLS = 12;
export const PACK_ROWS = 5;
/** Squares in the pack. */
export const PACK_CELLS = PACK_COLS * PACK_ROWS;
/** Kept for callers that still ask for the base: the whole pack. Strength no longer changes it. */
export const CARRY_BASE = PACK_CELLS;
/** The most of one material in one square, in the pack or in a container. */
export const STACK_MAX = 99;

/** Squares across and down. */
export interface PackSize {
  w: number;
  h: number;
}

/** What each kind of gear takes up. */
export const SLOT_SIZE: Record<Slot, PackSize> = {
  main_hand: { w: 2, h: 3 },
  off_hand: { w: 2, h: 2 },
  body: { w: 2, h: 3 },
  helmet: { w: 2, h: 2 },
  legs: { w: 2, h: 2 },
  boots: { w: 2, h: 2 },
  ring: { w: 1, h: 1 },
  amulet: { w: 1, h: 1 },
};

const LONG: PackSize = { w: 2, h: 4 };
const SLIM: PackSize = { w: 1, h: 3 };
const SQUARE: PackSize = { w: 2, h: 2 };
/** Weapons that are not the usual two by three, by their id (content.ts WEAPONS). */
export const WEAPON_SIZE: Record<string, PackSize> = {
  // Two-handed, and as long as the pack allows.
  greatsword: LONG, staff: LONG, root_staff: LONG, coral_staff: LONG, barometer_rod: LONG, void_staff: LONG, pager_axe: LONG, maul: LONG, boarding_pike: LONG, shortbow: LONG,
  // Slim things that slide in beside the rest.
  blunderbuss: LONG, harpoon_gun: LONG, pistol: SLIM,
  daggers: SLIM, gaff_hook: SLIM, flute: SLIM, sickle: SLIM, scepter: SLIM,
  // Books, orbs, bells and the squeeze box.
  tome: SQUARE, grimoire: SQUARE, orb: SQUARE, astrolabe: SQUARE, bilge_chalice: SQUARE, ships_bell: SQUARE, accordion: SQUARE,
};

/** The squares a piece of gear takes up in the pack. */
export function itemSize(item: { slot: Slot; ref: string }): PackSize {
  return (item.slot === "main_hand" ? WEAPON_SIZE[item.ref] : undefined) ?? SLOT_SIZE[item.slot] ?? { w: 1, h: 1 };
}

/** How many squares that is. */
export const itemCells = (item: { slot: Slot; ref: string }) => {
  const { w, h } = itemSize(item);
  return w * h;
};

/** Squares that `qty` of one material fills. */
export const stackSlots = (qty: number) => (qty > 0 ? Math.ceil(qty / STACK_MAX) : 0);

/** Squares these materials fill between them. */
export const materialSlots = (resources: Resources) => RESOURCE_KINDS.reduce((n, k) => n + stackSlots(resources[k] ?? 0), 0);

/** Extra squares that adding `more` to a heap of `have` would fill. */
export const addedSlots = (have: number, more: number) => stackSlots(have + more) - stackSlots(have);

/** "12 × 5", for showing the rule next to the number. */
export const CARRY_FORMULA = `${PACK_COLS} × ${PACK_ROWS} squares`;

/** Squares in a hero's pack. The same for everyone; the stats are taken so the callers need not change if that does. */
export function carryLimit(_stats?: Pick<Stats, "str">): number {
  return PACK_CELLS;
}

/** A hero's pack, as a server reads it. */
export interface CarryState {
  /** Squares filled now: the footprints of unequipped gear, plus a square per stack of materials. */
  carried: number;
  limit: number;
  /** Gear kept in containers at home. */
  stored: number;
  /** True once the hero has a hut, and so a chest. */
  hasHome: boolean;
  /** Free slots across the containers at home (shared with decorations and materials). */
  room: number;
}

/** Room left in the pack; never negative, even when over the limit. */
export const carryRoom = (s: Pick<CarryState, "carried" | "limit">) => Math.max(0, s.limit - s.carried);

/**
 * Why `who` cannot take something of `adding` squares into their pack, or
 * null if they can. `who` is "You" or a name.
 */
export function carryProblem(s: Pick<CarryState, "carried" | "limit">, adding: number, who = "You"): string | null {
  if (adding <= 0 || s.carried + adding <= s.limit) return null;
  const room = carryRoom(s);
  const you = who === "You";
  const full = you ? `Your pack is full: you carry ${s.carried} of ${s.limit}.` : `${who}'s pack is full: they carry ${s.carried} of ${s.limit}.`;
  const roomText = room === 0 ? full : you ? `You only have room for ${room} more (${s.carried} of ${s.limit} carried).` : `${who} only has room for ${room} more (${s.carried} of ${s.limit} carried).`;
  return `${roomText} ${you ? "Send something to storage first." : "They need to send something to storage first."}`;
}

/** Where a newly earned item goes. */
export type LootPlace = "pack" | "storage" | "overfull";

/**
 * Where loot lands: in the pack if there is room, else a container at home
 * with a free slot, else the pack anyway, over the limit. Never nowhere.
 */
export function lootPlace(s: Pick<CarryState, "carried" | "limit" | "hasHome" | "room">, cells = 1): LootPlace {
  if (s.carried + cells <= s.limit) return "pack";
  return s.hasHome && s.room > 0 ? "storage" : "overfull";
}

/** The feed line for loot that did not go into the pack, or null if it did. */
export function lootPlaceText(place: LootPlace, itemName: string): string | null {
  if (place === "storage") return `Pack full: ${itemName} was sent to storage at home.`;
  if (place === "overfull") return `Pack full and nowhere at home to keep it: ${itemName} is carried over the limit. Make room in your pack or your hut's chests.`;
  return null;
}

/** Why an item cannot go to storage, or null if it can. */
export function storeProblem(item: { equipped: boolean; stored: boolean } | null, home: Pick<CarryState, "hasHome" | "room">): string | null {
  if (!item) return "No such item.";
  if (item.stored) return "That is already in storage.";
  if (item.equipped) return "Unequip it first.";
  if (!home.hasHome) return "You have no storage yet. Buy a plot in the Harbor and fill its bin to raise a shack; it comes with a chest for what you cannot carry.";
  if (home.room <= 0) return "Every chest at home is full. Make room there, or add another chest, crate or cupboard.";
  return null;
}

/** Why an item cannot be taken out of storage, or null if it can. Only ever asked inside your own hut. */
export function takeProblem(item: { stored: boolean } | null, s: Pick<CarryState, "carried" | "limit">, cells = 1): string | null {
  if (!item || !item.stored) return "That is not in your storage.";
  return carryProblem(s, cells);
}
