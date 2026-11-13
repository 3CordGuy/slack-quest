// Selling fish: the fishmonger on the quay, whose prices move every six hours,
// and Old Tam at the pub, who pays a steady price for what he can cook. And
// where kept fish wait to be sold: the icebox (fresh catch, by weight) and the
// trophy chest (specimens, kept for good).
//
// The fishmonger's board is seeded by crew and by slot, like the salesmen's
// visits, so everyone in a crew sees the same rates and nothing is stored.

import { FISH, FISH_IDS, KEPT_HAUL_PRICE, type FishDef } from "./fishcatalog";
import { marketPrice, tamPrice } from "./fishing";
import { makeRng, seedFromString } from "./rng";

/** How long one board of prices stands. */
export const FISH_BOARD_MS = 6 * 60 * 60_000;
/** The fishmonger's rates run between these, against a fish's base price. */
export const FISH_RATE_MIN = 0.6;
export const FISH_RATE_MAX = 1.6;
/** The kinds chalked up as wanted on each board, and what that does to their price. */
export const FISH_WANTED = 2;
export const FISH_WANTED_BONUS = 2;
/** The icebox holds this much fresh fish. Treasure from the sea (a ship's bell) is kept apart and does not count. */
export const ICEBOX_G = 60_000;
/** The trophy chest: specimens and treasure, kept until mounted or sold. */
export const TROPHY_SLOTS = 6;

export type FishBuyer = "market" | "tam";

export interface FishBoard {
  slot: number;
  startsAt: number;
  endsAt: number;
  /** Today's rate for each kind the fishmonger buys by weight. */
  rates: Record<string, number>;
  /** Chalked up: these pay FISH_WANTED_BONUS times their rate. */
  wanted: string[];
}

/** Whether a catch counts against the icebox: anything alive. Kept treasures do not. */
export const inIcebox = (def: FishDef): boolean => def.kind !== "haul";

/** Kinds the fishmonger prices by weight (everything alive but Old Ironjaw, who is never for sale off the board). */
const BOARD_KINDS = FISH_IDS.filter((id) => FISH[id].kind !== "haul" && FISH[id].rarity !== "mythic");

/** The fishmonger's board for a crew (or a crewless player: `key` is either id) at `at`, epoch ms. */
export function fishBoard(key: string, at: number): FishBoard {
  const slot = Math.floor(at / FISH_BOARD_MS);
  const rng = makeRng(seedFromString(`fishmonger|${key}|${slot}`));
  const rates: Record<string, number> = {};
  for (const id of BOARD_KINDS) rates[id] = Math.round((FISH_RATE_MIN + (FISH_RATE_MAX - FISH_RATE_MIN) * rng.next()) * 100) / 100;
  // Wanted kinds are the ones people actually catch: nothing from the open sea, and no legendaries.
  const pool = BOARD_KINDS.filter((id) => !FISH[id].water.includes("sea") && (FISH[id].rarity === "common" || FISH[id].rarity === "uncommon"));
  const wanted: string[] = [];
  while (wanted.length < FISH_WANTED && pool.length > 0) wanted.push(...pool.splice(Math.floor(rng.next() * pool.length), 1));
  return { slot, startsAt: slot * FISH_BOARD_MS, endsAt: (slot + 1) * FISH_BOARD_MS, rates, wanted };
}

/** What `buyer` pays for one catch, or null if they will not take it. */
export function fishSalePrice(fish: { species: string; grams: number; specimen: boolean }, buyer: FishBuyer, board: FishBoard): number | null {
  const def = FISH[fish.species];
  if (!def) return null;
  if (buyer === "tam") return tamPrice(def, fish.grams);
  if (def.kind === "haul") return KEPT_HAUL_PRICE[def.id] ?? null;
  const rate = (board.rates[def.id] ?? 1) * (board.wanted.includes(def.id) ? FISH_WANTED_BONUS : 1);
  return marketPrice(def, fish.grams, fish.specimen, rate);
}

/** Why a fish cannot go into the trophy chest, or null if it can. */
export function trophyProblem(fish: { species: string; specimen: boolean }, inChest: number): string | null {
  const def = FISH[fish.species];
  if (!def || (def.kind === "haul" && !def.keep)) return "Only fish and treasure go in the trophy chest.";
  // Treasure from the sea (a ship's bell) is always worth keeping; a fish only if it is a specimen.
  if (def.kind !== "haul" && !fish.specimen) return "Only a specimen is worth keeping for good.";
  if (inChest >= TROPHY_SLOTS) return `The trophy chest holds ${TROPHY_SLOTS}. Sell or mount one first.`;
  return null;
}

/** Why a fish cannot go back in the icebox, or null if it can. */
export function iceboxProblem(fish: { species: string; grams: number }, iceboxG: number): string | null {
  if (FISH[fish.species] && inIcebox(FISH[fish.species]) && iceboxG + fish.grams > ICEBOX_G) return "There is no room in the icebox for it.";
  return null;
}

/**
 * Where a sitting's kept catches go when it ends: into the icebox while there
 * is room (in the order they were caught), and the rest straight to a buyer
 * on the quay. Old Tam takes what he can cook; the fishmonger the rest, at the
 * board's rate.
 */
export function stowCatch<T extends { species: string; grams: number; specimen: boolean }>(items: T[], iceboxG: number, board: FishBoard): { stowed: T[]; sold: (T & { gold: number; buyer: FishBuyer })[] } {
  const stowed: T[] = [];
  const sold: (T & { gold: number; buyer: FishBuyer })[] = [];
  let room = ICEBOX_G - iceboxG;
  for (const f of items) {
    const def = FISH[f.species];
    if (!inIcebox(def) || f.grams <= room) {
      stowed.push(f);
      if (inIcebox(def)) room -= f.grams;
      continue;
    }
    const tam = fishSalePrice(f, "tam", board);
    const buyer: FishBuyer = tam !== null ? "tam" : "market";
    sold.push({ ...f, gold: (buyer === "tam" ? tam : fishSalePrice(f, "market", board)) ?? 0, buyer });
  }
  return { stowed, sold };
}
