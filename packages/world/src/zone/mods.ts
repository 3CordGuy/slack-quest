// Modifiers: what makes one map unlike the next beyond its ground and its
// size. The atlas rolls a few onto each node (atlas.ts), a lodestone carries
// some more (lodestone.ts); a map's options carry them (`ZoneOptions.mods`),
// and everything that reads a map's danger or its pay asks `modsOf` what
// they add up to.
//
// There are two sides to them.
//
//   perils  make the map harder, and its bounty the bigger for it: the
//           harder the map, the better it pays. A map peril changes the
//           ground (more clutter, more high ground, a bigger map, patches
//           of something that does not wear off); an enemy peril changes
//           whoever stands on it (how much they take, how hard and how
//           surely they hit, how far they move, how many there are).
//   boons   make nothing harder. Each is more of one thing in the bounty:
//           gold, experience, gear, lodestones. They are multiplied by
//           what the perils add, so a boon is worth most on a hard map.
//
// A modifier has ranks: the same thing, more so. And each has a weight, how
// often it turns up where modifiers are rolled: the ones worth most are the
// rarest. Not every roll is a good one: a stone may carry a peril nobody
// wanted and no boon at all.
//
// As a map carries it, a modifier is its id, with its rank on the end above
// the first: "hardy", "hardy2", "hardy3".

import type { SurfaceKind, ZoneOptions, ZoneSize } from "./types";

export type ZoneModId =
  | "tangled" | "craggy" | "sprawling" | "smouldering" | "fouled" | "slick" | "frozen"
  | "hardy" | "savage" | "swift" | "numerous"
  | "gilded" | "storied" | "laden" | "lodebearing";
/** A modifier as a map or a stone carries it: its id, and its rank on the end if that is above the first. */
export type ZoneMod = ZoneModId | `${ZoneModId}${2 | 3}`;

/** What a modifier does at one rank. */
interface ModEffect {
  /** What it does, in a line. */
  blurb: string;
  /** How much more clearing the map pays, as a share (0.15 is 15% more). Nothing, for a boon. */
  pay: number;
  /** Steps of clutter and of high ground added (each runs 0 to 3). */
  obstacles?: number;
  elevation?: number;
  /** This many more enemy groups. */
  groups?: number;
  /** How many times the usual patches of its ground lie about. */
  patches?: number;
  /** Enemy health, as a multiplier. */
  hp?: number;
  /** Added to every enemy attack's damage and its bonus to hit. */
  edge?: number;
  /** Hexes of movement added to every enemy's turn. */
  move?: number;
  /** More in every group: another of whoever came with its leader. */
  extras?: number;
  /** A boon's share more of the bounty's gold, of its experience, of its chance of gear, and of its chance of a lodestone. */
  gold?: number;
  xp?: number;
  gear?: number;
  stones?: number;
}

export interface ZoneModDef extends ModEffect {
  id: ZoneModId;
  name: string;
  /** What it changes: the ground, the enemy, or (a boon) the bounty. A map modifier means nothing in a sea cave, whose ground is the caverns' own. */
  kind: "map" | "enemy" | "boon";
  /** How often it turns up where modifiers are rolled, against the others: the commonest are 10. */
  weight: number;
  /** The map is this size whatever it would have been. */
  size?: ZoneSize;
  /** Patches of this lie on the ground and stay. */
  hazard?: SurfaceKind;
  /** What it does at the second rank and the third, where it has them: whatever is said here in place of the first rank's. */
  more?: ModEffect[];
}

export const ZONE_MODS: Record<ZoneModId, ZoneModDef> = {
  // ---- perils: the ground ----
  tangled: { id: "tangled", name: "Tangled", kind: "map", weight: 10, blurb: "Thick with rock and trees: little open ground, and cover everywhere.", pay: 0.1, obstacles: 2, more: [{ blurb: "Choked with rock and trees: hardly a clear hex on it.", pay: 0.16, obstacles: 3 }] },
  craggy: { id: "craggy", name: "Craggy", kind: "map", weight: 10, blurb: "Hills and crowns of high ground all over it.", pay: 0.1, elevation: 2, more: [{ blurb: "All crags and crowns: hardly a level hex on it.", pay: 0.16, elevation: 3 }] },
  sprawling: { id: "sprawling", name: "Sprawling", kind: "map", weight: 5, blurb: "A big place, with one more band on it.", pay: 0.2, size: "large", groups: 1, more: [{ blurb: "A big place, with two more bands on it.", pay: 0.34, groups: 2 }] },
  smouldering: {
    id: "smouldering", name: "Smouldering", kind: "map", weight: 7, blurb: "Fire burns on the ground in patches, and does not go out.", pay: 0.15, hazard: "fire",
    more: [{ blurb: "Fire burns over much of the ground, and does not go out.", pay: 0.24, patches: 1.7 }, { blurb: "The place is alight from end to end.", pay: 0.34, patches: 2.5 }],
  },
  fouled: {
    id: "fouled", name: "Fouled", kind: "map", weight: 7, blurb: "Pools of poison lie about, and stay.", pay: 0.15, hazard: "poison",
    more: [{ blurb: "Poison lies over much of the ground, and stays.", pay: 0.24, patches: 1.7 }, { blurb: "The ground is poison nearly everywhere.", pay: 0.34, patches: 2.5 }],
  },
  slick: {
    id: "slick", name: "Slick", kind: "map", weight: 10, blurb: "Oil on the ground in patches: slow going, and one spark sets it off.", pay: 0.1, hazard: "oil",
    more: [{ blurb: "Oil over much of the ground: slow going, and one spark sets it off.", pay: 0.16, patches: 1.7 }, { blurb: "Oil nearly everywhere. One spark.", pay: 0.24, patches: 2.5 }],
  },
  frozen: {
    id: "frozen", name: "Frozen", kind: "map", weight: 10, blurb: "Sheets of ice that will not melt on their own.", pay: 0.1, hazard: "ice",
    more: [{ blurb: "Ice over much of the ground, that will not melt on its own.", pay: 0.16, patches: 1.7 }, { blurb: "Ice nearly everywhere.", pay: 0.24, patches: 2.5 }],
  },
  // ---- perils: the enemy ----
  hardy: { id: "hardy", name: "Hardy", kind: "enemy", weight: 5, blurb: "Everything here takes a third more killing.", pay: 0.2, hp: 1.3, more: [{ blurb: "Everything here takes two thirds more killing.", pay: 0.36, hp: 1.65 }, { blurb: "Everything here takes twice the killing.", pay: 0.55, hp: 2 }] },
  savage: { id: "savage", name: "Savage", kind: "enemy", weight: 5, blurb: "They hit harder, and miss less.", pay: 0.2, edge: 1, more: [{ blurb: "They hit a good deal harder, and seldom miss.", pay: 0.36, edge: 2 }, { blurb: "They hit like a falling mast, and do not miss.", pay: 0.55, edge: 3 }] },
  swift: { id: "swift", name: "Swift", kind: "enemy", weight: 7, blurb: "They cover one more hex a turn.", pay: 0.15, move: 1, more: [{ blurb: "They cover two more hexes a turn.", pay: 0.28, move: 2 }] },
  numerous: { id: "numerous", name: "Numerous", kind: "enemy", weight: 3, blurb: "One more in every band.", pay: 0.25, extras: 1, more: [{ blurb: "Two more in every band.", pay: 0.46, extras: 2 }] },
  // ---- boons: the bounty ----
  gilded: { id: "gilded", name: "Gilded", kind: "boon", weight: 5, blurb: "A third more gold in its bounty.", pay: 0, gold: 0.33, more: [{ blurb: "Two thirds more gold in its bounty.", pay: 0, gold: 0.66 }, { blurb: "Twice the gold in its bounty.", pay: 0, gold: 1 }] },
  storied: { id: "storied", name: "Storied", kind: "boon", weight: 5, blurb: "A quarter more experience in its bounty.", pay: 0, xp: 0.25, more: [{ blurb: "Half as much experience again in its bounty.", pay: 0, xp: 0.5 }, { blurb: "Four fifths more experience in its bounty.", pay: 0, xp: 0.8 }] },
  laden: { id: "laden", name: "Laden", kind: "boon", weight: 3, blurb: "A better chance of gear in its bounty, and of a better piece.", pay: 0, gear: 0.2, more: [{ blurb: "A much better chance of gear in its bounty, and of a better piece.", pay: 0, gear: 0.35 }, { blurb: "Gear in its bounty, as near as makes no odds, and good.", pay: 0, gear: 0.5 }] },
  lodebearing: { id: "lodebearing", name: "Lodebearing", kind: "boon", weight: 2, blurb: "A better chance of a lodestone in its bounty, and of one that carries more.", pay: 0, stones: 0.2, more: [{ blurb: "A much better chance of a lodestone in its bounty, and of one that carries more.", pay: 0, stones: 0.35 }, { blurb: "A lodestone in its bounty, as near as makes no odds, and a fine one.", pay: 0, stones: 0.5 }] },
};

export const ZONE_MOD_IDS = Object.keys(ZONE_MODS) as ZoneModId[];
/** The perils, and the boons: the two sides. */
export const PERIL_IDS = ZONE_MOD_IDS.filter((id) => ZONE_MODS[id].kind !== "boon");
export const BOON_IDS = ZONE_MOD_IDS.filter((id) => ZONE_MODS[id].kind === "boon");
/** The most perils a map carries, and the most boons. */
export const MAX_MODS = 4;
export const MAX_BOONS = 3;

/** How many ranks a modifier has. */
export const modRanks = (id: ZoneModId): number => 1 + (ZONE_MODS[id].more?.length ?? 0);

/** A modifier as it is carried: its id, with its rank on the end above the first. */
export const modToken = (id: ZoneModId, rank = 1): ZoneMod => (rank <= 1 ? id : (`${id}${Math.min(modRanks(id), rank)}` as ZoneMod));

/** What a carried modifier is: which one, at what rank. Null if it is none (or a rank it has not got). */
export function modOf(raw: unknown): { id: ZoneModId; rank: number } | null {
  if (typeof raw !== "string") return null;
  const m = /^([a-z]+)([23])?$/.exec(raw);
  if (!m || !(m[1] in ZONE_MODS)) return null;
  const id = m[1] as ZoneModId;
  const rank = m[2] ? Number(m[2]) : 1;
  return rank <= modRanks(id) ? { id, rank } : null;
}

/** What a carried modifier does, at its rank: the first rank's, with whatever its own rank says in its place. */
export function modEffect(mod: ZoneMod): ZoneModDef & { rank: number } {
  const { id, rank } = modOf(mod)!;
  const def = ZONE_MODS[id];
  return { ...def, ...(rank > 1 ? def.more![rank - 2] : {}), rank };
}

const NUMERALS = ["", "", " II", " III"];
/** What a carried modifier is called: its name, and its rank above the first ("Hardy II"). */
export const modName = (mod: ZoneMod): string => {
  const { id, rank } = modOf(mod)!;
  return `${ZONE_MODS[id].name}${NUMERALS[rank]}`;
};
/** Which side of a map a carried modifier is on, in a word: for what is written beside it. */
export const modSide = (mod: ZoneMod): string => ({ map: "the ground", enemy: "the enemy", boon: "the bounty" })[modEffect(mod).kind];

/**
 * Modifiers as they came off the wire, made safe: the ones there are, each once (at the highest rank it was
 * given), with one kind of ground at most, and no more perils or boons than a map carries. In the modifiers'
 * own order.
 */
export function cleanMods(raw: unknown): ZoneMod[] {
  if (!Array.isArray(raw)) return [];
  const rank = new Map<ZoneModId, number>();
  let [perils, boons] = [0, 0];
  for (const one of raw) {
    const mod = modOf(one);
    if (!mod) continue;
    const def = ZONE_MODS[mod.id];
    if (rank.has(mod.id)) {
      rank.set(mod.id, Math.max(rank.get(mod.id)!, mod.rank));
      continue;
    }
    if (def.hazard && [...rank.keys()].some((o) => ZONE_MODS[o].hazard)) continue;
    if (def.kind === "boon" ? boons >= MAX_BOONS : perils >= MAX_MODS) continue;
    if (def.kind === "boon") boons++;
    else perils++;
    rank.set(mod.id, mod.rank);
  }
  return ZONE_MOD_IDS.filter((id) => rank.has(id)).map((id) => modToken(id, rank.get(id)!));
}

/** What a map's modifiers add up to. With none, nothing changes. */
export interface ModSum {
  obstacles: number;
  elevation: number;
  size?: ZoneSize;
  groups: number;
  hazard?: SurfaceKind;
  /** How many times the usual patches of the hazard lie about. */
  patches: number;
  hp: number;
  edge: number;
  move: number;
  extras: number;
  /** The share the perils add to what clearing the map pays. */
  pay: number;
  /** The shares the boons add: of gold, of experience, of the chance of gear, of the chance of a lodestone. */
  gold: number;
  xp: number;
  gear: number;
  stones: number;
}

export function modsOf(options: Pick<ZoneOptions, "mods"> | undefined): ModSum {
  const sum: ModSum = { obstacles: 0, elevation: 0, groups: 0, patches: 1, hp: 1, edge: 0, move: 0, extras: 0, pay: 0, gold: 0, xp: 0, gear: 0, stones: 0 };
  for (const one of options?.mods ?? []) {
    if (!modOf(one)) continue;
    const def = modEffect(one);
    sum.obstacles += def.obstacles ?? 0;
    sum.elevation += def.elevation ?? 0;
    sum.groups += def.groups ?? 0;
    sum.size = def.size ?? sum.size;
    sum.hazard = def.hazard ?? sum.hazard;
    if (def.hazard) sum.patches = def.patches ?? 1;
    sum.hp *= def.hp ?? 1;
    sum.edge += def.edge ?? 0;
    sum.move += def.move ?? 0;
    sum.extras += def.extras ?? 0;
    sum.pay += def.pay;
    sum.gold += def.gold ?? 0;
    sum.xp += def.xp ?? 0;
    sum.gear += def.gear ?? 0;
    sum.stones += def.stones ?? 0;
  }
  return sum;
}

/**
 * One modifier, picked by weight from those of `pool` that `fits` allows (the rarest are worth most), at a
 * rank a place this many rings out can show: the first near the Harbor, the second from five rings out, the
 * third from ten, each less likely than not. Null if nothing fits.
 */
export function rollMod(rng: { next(): number }, pool: readonly ZoneModId[], tier: number, fits: (id: ZoneModId) => boolean = () => true): ZoneMod | null {
  const open = pool.filter(fits);
  const total = open.reduce((n, id) => n + ZONE_MODS[id].weight, 0);
  if (total <= 0) return null;
  let at = rng.next() * total;
  const id = open.find((o) => (at -= ZONE_MODS[o].weight) < 0) ?? open[open.length - 1];
  const high = rng.next();
  const rank = tier >= 10 && high < 0.12 ? 3 : tier >= 5 && high < 0.34 ? 2 : 1;
  return modToken(id, rank);
}
