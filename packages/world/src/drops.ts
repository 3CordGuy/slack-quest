// What a searched cache gives for the hut: materials, and now and then a
// blueprint or a piece of decor.
//
// Pure functions of an Rng.

import { FURNISHINGS, type ResourceKind, type Resources } from "./hut";
import type { Rng } from "./rng";

/** A piece of furniture or a trophy handed to a hero. */
export interface FurnishingGrant {
  defId: string;
  label: string;
}

/** What a cache search can turn up besides gold and gear. */
export const CACHE_RESOURCES: ResourceKind[] = ["wood", "stone", "copper"];
export const CACHE_DROP_UNITS: [number, number] = [2, 4];
export const CACHE_BLUEPRINT_CHANCE = 0.15;
export const CACHE_DECOR_CHANCE = 0.06;
/** Decor that can be found ready-made. */
export const CACHE_DECOR: string[] = ["lantern", "banner", "rug", "candle", "mug", "books", "skull", "bottle", "coin_pile"];
/** Blueprints that have to be found: everything that cannot be crafted without one. */
export const FOUND_BLUEPRINTS: string[] = Object.values(FURNISHINGS).filter((f) => f.needsBlueprint).map((f) => f.id);

/** `units` pieces of material, each one of `kinds`. */
function spread(rng: Rng, kinds: readonly ResourceKind[], units: number): Resources {
  const out: Resources = {};
  for (let i = 0; i < units; i++) {
    const kind = rng.pick(kinds);
    out[kind] = (out[kind] ?? 0) + 1;
  }
  return out;
}

export interface CacheDrops {
  resources: Resources;
  blueprint?: string;
  furnishing?: FurnishingGrant;
}

/**
 * What a cache search that found something yields for the hut. `known` are
 * blueprints the hero has already picked up on this map, which are not
 * handed out twice.
 */
export function cacheDrops(rng: Rng, known: readonly string[] = []): CacheDrops {
  const [min, max] = CACHE_DROP_UNITS;
  const out: CacheDrops = { resources: spread(rng, CACHE_RESOURCES, rng.int(min, max)) };
  if (rng.chance(CACHE_BLUEPRINT_CHANCE)) {
    const fresh = FOUND_BLUEPRINTS.filter((id) => !known.includes(id));
    if (fresh.length > 0) out.blueprint = rng.pick(fresh);
  }
  if (rng.chance(CACHE_DECOR_CHANCE)) {
    const defId = rng.pick(CACHE_DECOR);
    out.furnishing = { defId, label: FURNISHINGS[defId].name };
  }
  return out;
}
