// Fishing: where you can fish from, what comes up on the line, how big it
// is, and what it is worth.
//
// A sitting (sitting.ts) rolls one catch per cast with `rollCatch` and
// `rollSize`, then hands it to the fight (fishfight.ts). Everything here runs
// on the server only: the client is told what it caught once it is landed.

import { FISH, FISH_IDS, KEPT_HAUL_PRICE, type FishDef, type FishRarity, type Water } from "./fishcatalog";
import type { Rng } from "./rng";

/** Where a sitting is fished from: a pier head, the old shore spot, or (by rowboat) the open sea. */
export type FishSpot = "west" | "middle" | "east" | "shore" | "sea";
export const FISH_SPOT_IDS: FishSpot[] = ["west", "middle", "east", "shore", "sea"];

export interface FishSpotDef {
  id: FishSpot;
  name: string;
  water: Water;
  /** How far a full cast reaches, 0 to 1: the shore only gets short casts. */
  maxCast: number;
  /** Not yet fishable: the open sea waits for boats. */
  closed?: string;
}

export const FISH_SPOTS: Record<FishSpot, FishSpotDef> = {
  west: { id: "west", name: "The west pier", water: "shallows", maxCast: 1 },
  middle: { id: "middle", name: "The middle pier", water: "mouth", maxCast: 1 },
  east: { id: "east", name: "The east pier", water: "deep", maxCast: 1 },
  shore: { id: "shore", name: "The shore", water: "shallows", maxCast: 0.5 },
  sea: { id: "sea", name: "The open sea", water: "sea", maxCast: 1, closed: "You need a boat to get out there." },
};

/** Bites per hundred, by rarity, before a cast's reach shifts them. */
export const RARITY_WEIGHT: Record<FishRarity, number> = { common: 60, uncommon: 25, rare: 10, legendary: 1.5, mythic: 0.05 };
/** The share of bites that are hauls (junk and treasure) rather than anything alive. */
export const HAUL_SHARE = 0.12;
/** Specimens are in the top fifth of their kind's weight. Every rare or better catch is one. */
export const SPECIMEN_SHARE = 0.2;

/** How far out a cast lands, in metres, for a reach of 0 to 1. */
export const castMetres = (reach: number): number => Math.round(5 + 30 * Math.max(0, Math.min(1, reach)));

/** A far cast finds rarer fish: commons thin out, rare and legendary bites grow. */
function reachWeight(rarity: FishRarity, reach: number): number {
  const base = RARITY_WEIGHT[rarity];
  if (rarity === "common") return base * (1.2 - 0.4 * reach);
  if (rarity === "uncommon") return base;
  if (rarity === "rare") return base * (0.6 + 0.8 * reach);
  return base * (0.4 + 1.2 * reach);
}

function weighted<T>(rng: Rng, items: [T, number][]): T {
  const total = items.reduce((a, [, w]) => a + w, 0);
  let roll = rng.next() * total;
  for (const [item, w] of items) if ((roll -= w) < 0) return item;
  return items[items.length - 1][0];
}

/** What bites on a cast into `water` that reached `reach` (0 to 1) of the way out. */
export function rollCatch(rng: Rng, water: Water, reach: number): FishDef {
  const haul = rng.next() < HAUL_SHARE;
  const pool = FISH_IDS.map((id) => FISH[id]).filter((f) => f.water.includes(water) && (f.kind === "haul") === haul);
  return weighted(rng, pool.map((f) => [f, haul ? RARITY_WEIGHT[f.rarity] : reachWeight(f.rarity, reach)] as [FishDef, number]));
}

export interface FishSize {
  grams: number;
  mm: number;
  specimen: boolean;
}

/**
 * How big this one is. Most are small; a far cast leans a little larger.
 * Weight follows length cubed between the kind's ends, give or take how well
 * fed it is.
 */
export function rollSize(rng: Rng, def: FishDef, reach: number): FishSize {
  const [l0, l1] = def.lengthCm;
  const [w0, w1] = def.weightKg;
  const r = Math.pow(rng.next(), 2.2 - 0.6 * Math.max(0, Math.min(1, reach)));
  const length = l0 + (l1 - l0) * r;
  const cube = l1 === l0 ? r : (length ** 3 - l0 ** 3) / (l1 ** 3 - l0 ** 3);
  const condition = 0.9 + 0.2 * rng.next();
  const kg = Math.max(w0 * 0.9, Math.min(w1 * 1.08, (w0 + (w1 - w0) * cube) * condition));
  const grams = Math.max(1, Math.round(kg * 1000));
  const rare = def.rarity === "rare" || def.rarity === "legendary" || def.rarity === "mythic";
  const specimen = def.kind !== "haul" && (rare || kg >= w0 + (1 - SPECIMEN_SHARE) * (w1 - w0));
  return { grams, mm: Math.round(length * 10), specimen };
}

/** The fishmonger's price: by weight, at today's `rate`, a quarter more for a specimen. Plain hauls are worth nothing. */
export function marketPrice(def: FishDef, grams: number, specimen: boolean, rate = 1): number {
  if (def.kind === "haul") return KEPT_HAUL_PRICE[def.id] ?? 0;
  return Math.max(1, Math.round(def.pricePerKg * Math.pow(grams / 1000, 0.85) * rate * (specimen ? 1.25 : 1)));
}

/** What Old Tam pays for the pub's kitchen: steady and a little under the market. Null for anything he will not cook. */
export function tamPrice(def: FishDef, grams: number): number | null {
  if (!def.kitchen) return null;
  return Math.max(1, Math.round(0.8 * def.pricePerKg * Math.pow(grams / 1000, 0.9)));
}

/** "1.24 kg", "860 g". */
export function formatWeight(grams: number): string {
  return grams >= 1000 ? `${(grams / 1000).toFixed(grams >= 100_000 ? 0 : grams >= 10_000 ? 1 : 2)} kg` : `${grams} g`;
}

/** "62 cm", "2.4 m". */
export function formatLength(mm: number): string {
  return mm >= 1000 ? `${(mm / 1000).toFixed(1)} m` : `${Math.round(mm / 10)} cm`;
}
