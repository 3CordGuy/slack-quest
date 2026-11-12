// How much gear a hero can carry, and where gear goes when the pack is full.
//
// A hero carries a pack of unequipped gear whose size grows with Strength
// (base plus what their gear gives). Worn gear does not count. Everything
// else waits in the containers of their hut (hut.ts `storage`: the free
// Storage Chest every home has, plus any chests, crates and cupboards they
// add): items can be sent there from anywhere, but only taken out while
// standing in your own hut.
//
// Hut materials (wood, stone, herbs...) are not gear and never count: they
// live in their own heaps, not in the pack.
//
// Nothing earned is ever lost to a full pack. Loot that does not fit goes
// to a container at home with room; with no home yet, or every container
// full, it goes into the pack anyway, over the limit, and the hero simply
// cannot take on more until they are back under it. Buying and trades are refused instead, since the player
// can choose not to.

import type { Stats } from "@gantt-quest/core";

/** Slots every hero has, however weak. */
export const CARRY_BASE = 3;
/** Extra slots per point of Strength. */
export const CARRY_PER_STR = 1;

/** "3 + Strength", for showing the rule next to the number. */
export const CARRY_FORMULA = `${CARRY_BASE} + Strength`;

/** Carried slots for these total stats (base plus gear). */
export function carryLimit(stats: Pick<Stats, "str">): number {
  return CARRY_BASE + CARRY_PER_STR * Math.max(0, Math.floor(stats.str));
}

/** A hero's pack, as a server reads it. */
export interface CarryState {
  /** Unequipped items carried now. */
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
 * Why `who` cannot take `adding` more items into their pack, or null if
 * they can. `who` is "You" or a name.
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
export function lootPlace(s: Pick<CarryState, "carried" | "limit" | "hasHome" | "room">): LootPlace {
  if (s.carried < s.limit) return "pack";
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
export function takeProblem(item: { stored: boolean } | null, s: Pick<CarryState, "carried" | "limit">): string | null {
  if (!item || !item.stored) return "That is not in your storage.";
  return carryProblem(s, 1);
}
