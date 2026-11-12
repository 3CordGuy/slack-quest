// What an island gives for the hut: materials from fights and caches, the
// odd blueprint or piece of decor from a cache, and a trophy for the story.
//
// Pure functions of an Rng. Each returns values in the shape the reducer's
// `grant` helper takes, so world.ts only has to pass them along.

import { ENEMIES } from "./content";
import { FURNISHINGS, TROPHY_FOR_FRAME, addResources, type ResourceKind, type Resources } from "./hut";
import type { Rng } from "./rng";
import type { StoryBible } from "./story";
import type { FurnishingGrant } from "./world";

const BEAST: ResourceKind[] = ["fur", "bone"];
const ARMED: ResourceKind[] = ["iron", "copper"];

/** What each kind of enemy leaves behind. An enemy not listed leaves nothing. */
export const ENEMY_DROPS: Record<string, ResourceKind[]> = {
  wolf: BEAST,
  alpha: BEAST,
  bandit: ARMED,
  archer: ARMED,
  brute: ARMED,
  cultist: ARMED,
  villain: ARMED,
  guardian: ["stone"],
};

/** Units of material from one enemy: [min, max]. */
export const ENEMY_DROP_UNITS: [number, number] = [1, 3];
export const BOSS_DROP_UNITS: [number, number] = [4, 6];

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

/** Materials one hero takes from a won fight against these enemies. */
export function battleDrops(rng: Rng, enemyKinds: readonly string[]): Resources {
  const total: Resources = {};
  for (const kind of enemyKinds) {
    const kinds = ENEMY_DROPS[kind];
    if (!kinds) continue;
    const [min, max] = ENEMIES[kind]?.boss ? BOSS_DROP_UNITS : ENEMY_DROP_UNITS;
    addResources(total, spread(rng, kinds, rng.int(min, max)));
  }
  return total;
}

export interface CacheDrops {
  resources: Resources;
  blueprint?: string;
  furnishing?: FurnishingGrant;
}

/**
 * What a cache search that found something yields for the hut. `known` are
 * blueprints the hero has already picked up this voyage, which are not
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

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The trophy every hero takes home for winning this story, named after it. */
export function storyTrophy(bible: Pick<StoryBible, "frameId" | "title" | "relicName" | "villain"> & Partial<Pick<StoryBible, "islandName">>): FurnishingGrant | undefined {
  const defId = TROPHY_FOR_FRAME[bible.frameId];
  if (!defId || !FURNISHINGS[defId]) return undefined;
  const what =
    defId === "trophy_pelt" ? `Pelt of ${bible.villain.name}`
    : defId === "trophy_core" ? `Core of ${bible.villain.name}`
    : defId === "trophy_token" ? `Thanks from ${bible.frameId === "lift_curse" ? (bible.islandName ?? "the island") : bible.relicName}`
    : capital(bible.relicName);
  return { defId, label: `${what} · ${bible.title}` };
}
