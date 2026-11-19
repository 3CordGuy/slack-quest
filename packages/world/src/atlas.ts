// The atlas: a sea chart of landfalls that spreads out from the Harbor, one
// to a world (a crew). Each node is a map to sail to and fight on (a zone:
// see ./zone), and clearing one opens the ones its routes lead to.
//
// The chart has no edge. It is an endless lattice of hex cells with one node
// to a cell, and everything about a node (where it lies, what it is called,
// its ground, how dangerous it is, what modifiers it carries, which
// neighbours its routes run to) is worked out from the chart's seed and the
// cell alone. So nothing is stored until a crew opens a node, and the same
// seed always charts the same sea.
//
//   ring       how many cells out from the Harbor a node lies. It sets the
//              enemy's level, and how many modifiers a node may carry.
//   routes     every node has one route to a neighbour a ring nearer the
//              Harbor, so any node can be reached; and a share of the other
//              pairs of neighbours are joined too, for ways round.
//   regions    ground comes from slow noise over the chart, so there are
//              stretches of woods and runs of shore, not a scatter.
//   climates   and over those, far slower, lie the climates: the greenwood
//              round the Harbor, and beyond it great tracts of frost, dunes,
//              mire and ashlands, each many places across. The same kinds
//              of ground are in each, and look nothing alike.
//   sea caves  now and then a node is a cave: a delve (zone/delve.ts), with
//              chests and a hoard, cleared when the last chest is open.
//   lookouts   high ground, craggy to fight on. From one the crew has
//              cleared they see a long way: the cloud lifts far round it.
//   lairs      something big has made its den there, and its own kind keep
//              it company. A level above its ring, and its bounty is that
//              of a place three rings further out.
//   lodestones a crew may set a stone into a place before setting out for
//              it (lodestone.ts): what the stone carries is added to what
//              the place has.
//
// What a crew sees of it (`atlasView`) is the nodes it has cleared, the ones
// open to it (a route from the Harbor or from a cleared node), and a ring of
// fog beyond those: where there is something, and nothing more.

import type { HexPos } from "@gantt-quest/core";
import type { Clime } from "./map";
import { makeRng, seedFromString, type Rng } from "./rng";
import { zoneOptions } from "./zone/gen";
import { siteFor } from "./zone/sites";
import { PERIL_IDS, ZONE_MODS, cleanMods, modOf, rollMod, type ZoneMod, type ZoneModId } from "./zone/mods";
import type { ZoneBiome, ZoneOptions } from "./zone/types";

/** A cell of the chart, in axial hex coordinates. The Harbor is at 0,0. */
export interface AtlasCell {
  q: number;
  r: number;
}

export type AtlasNodeKind = "harbor" | "landfall" | "seacave" | "lookout" | "lair";

export interface AtlasNode {
  /** "q,r": the node's cell, and its name in the database. */
  id: string;
  cell: AtlasCell;
  /** The hex of the world it stands on (atlasMap.ts): near its cell's middle, but never in a ruled row (atlasHex). */
  hex: HexPos;
  name: string;
  kind: AtlasNodeKind;
  biome: ZoneBiome;
  /** The climate it lies in. */
  clime: Clime;
  /** Cells out from the Harbor: 0 for the Harbor itself. */
  ring: number;
  /** The level of what stands on it. */
  level: number;
  /** The perils it carries of its own (zone/mods.ts). A place has no boons of its own: those come on a lodestone. */
  mods: ZoneMod[];
  /** The nodes its routes run to. */
  links: string[];
}

export type AtlasNodeState = "harbor" | "cleared" | "open" | "fogged";

/** A node as a crew is shown it. A fogged one is only somewhere a route leads: no name, no ground, nothing about what is there. */
export type AtlasNodeView =
  | (AtlasNode & { state: "harbor" | "cleared" | "open" })
  | { id: string; hex: HexPos; ring: number; links: string[]; state: "fogged" };

export const ATLAS_HOME = "0,0";
/** How far out a node may be named at all: a guard on what comes off the wire, far beyond anywhere a crew will sail. */
export const ATLAS_REACH = 500;
/** The share of pairs of neighbours joined by a route, besides the one route every node has toward the Harbor. */
const EXTRA_ROUTES = 0.42;
/** How many hexes of the world lie between one cell's middle and the next: about how far apart two places are. */
export const ATLAS_SPACING = 5;
/**
 * How far the lattice of cells is bent out of true, in hexes, so the places do not lie in rows. The bend is
 * slow (neighbours are carried the same way, and stay apart), and each place is nudged a little on its own besides.
 */
const WARP = 1.7;
const WARP_SCALE = 2.2;
const NUDGE = 0.7;
/** Two places are joined by a route of the second kind (not the one each has toward the Harbor) only if they lie this near. */
const ROUTE_REACH = ATLAS_SPACING + 1;
/** One node in so many, from the second ring out, is a sea cave; one in so many more a lookout; and from the third ring, a lair. */
const SEACAVE_CHANCE = 0.16;
const LOOKOUT_CHANCE = 0.07;
const LAIR_CHANCE = 0.07;
/** A lair's bounty is that of a place this many rings further out. */
export const LAIR_RINGS = 3;
/** What has made its den in a lair, by the ground it is on; and, in some climates, whatever the ground. */
const LAIR_BEAST: Record<ZoneBiome, string> = { meadow: "alpha", woods: "great_bear", shore: "guardian", caves: "haunt" };
const CLIME_BEAST: Partial<Record<Clime, string>> = { mire: "broodmother" };

const DIRS: AtlasCell[] = [{ q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }];
const idOf = (c: AtlasCell) => `${c.q},${c.r}`;
const ringOf = (c: AtlasCell) => (Math.abs(c.q) + Math.abs(c.r) + Math.abs(c.q + c.r)) / 2;
const around = (c: AtlasCell): AtlasCell[] => DIRS.map((d) => ({ q: c.q + d.q, r: c.r + d.r }));
/** Where a hex of the world lies on the page, in cells: pointy hexes, `ATLAS_SPACING` of them to a cell. */
const page = (hex: HexPos) => ({ x: (hex.q + hex.r / 2) / ATLAS_SPACING, y: (hex.r * Math.sqrt(3)) / 2 / ATLAS_SPACING });
const rngFor = (seed: string, tag: string, key: string): Rng => makeRng(seedFromString(`atlas|${seed}|${tag}|${key}`));
const roll = (seed: string, tag: string, key: string) => rngFor(seed, tag, key).next();

/** The cell an id names, or null if it is not one (or lies out past anywhere the chart is asked about). */
export function atlasCell(id: unknown): AtlasCell | null {
  if (typeof id !== "string") return null;
  const m = /^(-?\d{1,4}),(-?\d{1,4})$/.exec(id);
  if (!m) return null;
  const cell = { q: Number(m[1]), r: Number(m[2]) };
  return ringOf(cell) <= ATLAS_REACH && idOf(cell) === id ? cell : null;
}

/** The hex nearest a point given in fractions of a hex (cube rounding). */
function hexRound(fq: number, fr: number): HexPos {
  const fs = -fq - fr;
  let q = Math.round(fq);
  let r = Math.round(fr);
  const s = Math.round(fs);
  const [dq, dr, ds] = [Math.abs(q - fq), Math.abs(r - fr), Math.abs(s - fs)];
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q: q + 0, r: r + 0 };
}
const hexGap = (a: HexPos, b: HexPos) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;

/**
 * The hex of the world a cell's node stands on: the cell's middle, carried off by the slow bend of the
 * lattice and nudged a little on its own. The Harbor stands dead on its middle, at 0,0.
 */
export function atlasHex(seed: string, cell: AtlasCell): HexPos {
  const mid: HexPos = { q: cell.q * ATLAS_SPACING, r: cell.r * ATLAS_SPACING };
  if (ringOf(cell) === 0) return mid;
  const id = idOf(cell);
  // Across the page and down it, in hexes; then back into the hexes' own two directions.
  const dx = (atlasNoise(seed, "bend-x", mid, WARP_SCALE) - 0.5) * 2 * WARP + (roll(seed, "nudge-x", id) - 0.5) * 2 * NUDGE;
  const dy = (atlasNoise(seed, "bend-y", mid, WARP_SCALE) - 0.5) * 2 * WARP + (roll(seed, "nudge-y", id) - 0.5) * 2 * NUDGE;
  const dr = dy / (Math.sqrt(3) / 2);
  return hexRound(mid.q + dx - dr / 2, mid.r + dr);
}

/** The neighbour a ring nearer the Harbor that a node's own route runs to. Every node but the Harbor has one. */
function inward(seed: string, cell: AtlasCell): AtlasCell {
  const ring = ringOf(cell);
  const nearer = around(cell).filter((n) => ringOf(n) === ring - 1);
  return nearer[Math.floor(roll(seed, "in", idOf(cell)) * nearer.length)];
}

/** Whether a route runs between two cells that lie side by side. */
function joined(seed: string, a: AtlasCell, b: AtlasCell): boolean {
  if (ringOf(a) === 0 || ringOf(b) === 0) return true;
  if (idOf(inward(seed, a)) === idOf(b) || idOf(inward(seed, b)) === idOf(a)) return true;
  // A way round, for some of the pairs that lie near each other: never a long straight haul.
  if (hexGap(atlasHex(seed, a), atlasHex(seed, b)) > ROUTE_REACH) return false;
  const [lo, hi] = [idOf(a), idOf(b)].sort();
  return roll(seed, "route", `${lo}|${hi}`) < EXTRA_ROUTES;
}

/**
 * Slow noise over the world, 0 to 1, at a hex: a hashed value at each corner of a coarse grid `scale` cells
 * across, blended between them. `memo` keeps the corners already worked out (a whole map asks for the same ones).
 */
export function atlasNoise(seed: string, tag: string, hex: HexPos, scale: number, memo?: Map<string, number>): number {
  const { x, y } = page(hex);
  const fx = x / scale;
  const fy = y / scale;
  const [x0, y0] = [Math.floor(fx), Math.floor(fy)];
  const ease = (t: number) => t * t * (3 - 2 * t);
  const [tx, ty] = [ease(fx - x0), ease(fy - y0)];
  const at = (ix: number, iy: number) => {
    const key = `${tag}|${ix},${iy}`;
    let v = memo?.get(key);
    if (v === undefined) {
      v = roll(seed, tag, `${ix},${iy}`);
      memo?.set(key, v);
    }
    return v;
  };
  const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
  const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
  return top * (1 - ty) + bottom * ty;
}

/** The ground of the region a hex of the world lies in. */
export function atlasRegion(seed: string, hex: HexPos, memo?: Map<string, number>): "shore" | "meadow" | "woods" {
  const v = atlasNoise(seed, "ground", hex, 2.4, memo);
  return v < 0.4 ? "shore" : v < 0.6 ? "meadow" : "woods";
}

/** How many cells across a climate's slow noise is: a tract of one climate is a few of these wide. */
const CLIME_SCALE = 10;
/** The Harbor's own country is greenwood this many cells out, and the climates come into their own over this many more. */
const HOME_GREEN = 3;
const CLIME_RISE = 5;

/**
 * The climate a hex of the world lies in. Two slow noises, how warm it is and how wet, give great tracts of
 * each; a little fine noise at their borders lets one run raggedly into the next. Near the Harbor both are
 * drawn in toward the middle, so home is always greenwood and the wilder climates lie further out.
 */
export function atlasClime(seed: string, hex: HexPos, memo?: Map<string, number>): Clime {
  const { x, y } = page(hex);
  const out = Math.min(1, Math.max(0, (Math.hypot(x, y) - HOME_GREEN) / CLIME_RISE));
  if (out === 0) return "greenwood";
  const ragged = (atlasNoise(seed, "clime-edge", hex, 0.45, memo) - 0.5) * 0.07;
  // Stretched away from the middle (blended noise keeps to it), then drawn back in near home.
  const far = (tag: string) => 0.5 + (atlasNoise(seed, tag, hex, CLIME_SCALE, memo) - 0.5) * 1.7 * out + ragged;
  const warm = far("warm");
  const wet = far("wet");
  if (warm < 0.34) return "frost";
  if (warm > 0.66) return wet > 0.5 ? "ash" : "dunes";
  return wet > 0.7 ? "mire" : "greenwood";
}

const FIRST = [
  "Gull", "Widow's", "Salt", "Drowned", "Lantern", "Brine", "Kelp", "Thistle", "Crooked", "Grey",
  "Amber", "Wrecker's", "Tinker's", "Mizzen", "Fathom", "Barnacle", "Squall", "Ember", "Moss", "Heron",
  "Cinder", "Marrow", "Bellman's", "Tarry", "Whistling", "Low", "Stray", "Cutler's", "Hag's", "Pale",
  "Nettle", "Rook", "Sorrel", "Dunlin", "Cooper's", "Wicker", "Rust", "Sable", "Petrel", "Longshore",
];
/** The first words in a chart's own order, kept per seed: working it out is the same shuffle every time. */
const shuffled = new Map<string, string[]>();
/**
 * The first word of a node's name. It steps through the chart's own shuffle of the list as the cells
 * do (7 a cell one way, 13 the other), so no two landfalls side by side share one.
 */
function firstWord(seed: string, cell: AtlasCell): string {
  let words = shuffled.get(seed);
  if (!words) {
    const rng = rngFor(seed, "names", "first");
    words = [...FIRST];
    for (let i = words.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [words[i], words[j]] = [words[j], words[i]];
    }
    if (shuffled.size > 64) shuffled.clear();
    shuffled.set(seed, words);
  }
  const n = words.length;
  return words[(((cell.q * 7 + cell.r * 13) % n) + n) % n];
}
const LAST: Record<ZoneBiome, string[]> = {
  meadow: ["Isle", "Holm", "Green", "Down", "Lea", "Rise"],
  woods: ["Wood", "Thicket", "Grove", "Holt", "Tangle", "Copse"],
  shore: ["Cove", "Strand", "Spit", "Shoals", "Bar", "Landing"],
  caves: ["Grotto", "Sea Cave", "Sump", "Gullet", "Hole", "Cellars"],
};

/** What a place is called in a climate that is not the greenwood, whatever its ground. */
const CLIME_LAST: Record<Exclude<Clime, "greenwood">, string[]> = {
  frost: ["Floe", "Drift", "Fell", "Rime", "Tarn", "Hollow", "Scarp", "Firth"],
  dunes: ["Dunes", "Wadi", "Mesa", "Wells", "Flats", "Reach", "Sands", "Cairn"],
  mire: ["Mire", "Fen", "Slough", "Carr", "Bog", "Reeds", "Wash", "Sedge"],
  ash: ["Cinders", "Scar", "Slag", "Crater", "Kiln", "Embers", "Vent", "Clinker"],
};

/** What a lookout and a lair are called, whatever ground or climate they are in. */
const KIND_LAST: Partial<Record<AtlasNodeKind, string[]>> = {
  lookout: ["Lookout", "Watch", "Height", "Crag", "Beacon", "Tor"],
  lair: ["Den", "Lair", "Warren", "Roost", "Hold", "Maw"],
};

/** How dangerous a ring is: the level of what stands there. A ring out is a level up. */
export const atlasLevel = (ring: number): number => Math.max(1, Math.min(40, Math.round(ring)));
/** How many modifiers a node in this ring may carry: none beside the Harbor, more the further out. */
export function atlasModCount(ring: number): [number, number] {
  return ring <= 1 ? [0, 0] : ring <= 3 ? [0, 1] : ring <= 6 ? [1, 2] : [1, 3];
}

/** The perils a node carries: a few picked by weight from those that suit it, one kind of ground at most, at ranks its ring can show. */
function rollMods(rng: Rng, ring: number, kind: AtlasNodeKind): ZoneMod[] {
  const [lo, hi] = atlasModCount(ring);
  const want = rng.int(lo, hi);
  // A sea cave's ground is the caverns' own: only what changes the enemy means anything there.
  const pool = PERIL_IDS.filter((id) => kind !== "seacave" || ZONE_MODS[id].kind === "enemy");
  const out: ZoneModId[] = [];
  const picked: ZoneMod[] = [];
  for (let tries = 0; out.length < want && tries < 24; tries++) {
    const mod = rollMod(rng, pool, ring, (id) => !out.includes(id) && !(ZONE_MODS[id].hazard && out.some((o) => ZONE_MODS[o].hazard)));
    if (!mod) break;
    out.push(modOf(mod)!.id);
    picked.push(mod);
  }
  // In the order they are listed, so the same set always reads the same.
  return cleanMods(picked);
}

/** The node in a cell of a chart. The same seed and cell always give the same node. */
export function atlasNode(seed: string, cell: AtlasCell): AtlasNode {
  const id = idOf(cell);
  const ring = ringOf(cell);
  const hex = atlasHex(seed, cell);
  const links = around(cell).filter((n) => joined(seed, cell, n)).map(idOf);
  if (ring === 0) return { id, cell, hex, name: "The Harbor", kind: "harbor", biome: "shore", clime: "greenwood", ring: 0, level: 1, mods: [], links };
  const rng = rngFor(seed, "node", id);
  // One throw decides what it is: a sea cave, a lookout, a lair, or (most of them) a landfall.
  const what = rng.next();
  const kind: AtlasNodeKind =
    ring >= 2 && what < SEACAVE_CHANCE ? "seacave"
    : ring >= 2 && what < SEACAVE_CHANCE + LOOKOUT_CHANCE ? "lookout"
    : ring >= 3 && what < SEACAVE_CHANCE + LOOKOUT_CHANCE + LAIR_CHANCE ? "lair"
    : "landfall";
  const biome = kind === "seacave" ? "caves" : atlasRegion(seed, hex);
  const clime = atlasClime(seed, hex);
  // A cave is a cave wherever it is, and a lookout or a lair is named for what it is; anywhere else out of the
  // greenwood is named for its climate.
  const last = rng.pick(LAST[biome]);
  const own = KIND_LAST[kind];
  const name = `${firstWord(seed, cell)} ${own ? rngFor(seed, "kind-name", id).pick(own) : clime === "greenwood" || kind === "seacave" ? last : rngFor(seed, "clime-name", id).pick(CLIME_LAST[clime])}`;
  return { id, cell, hex, name, kind, biome, clime, ring, level: atlasLevel(ring + (kind === "lair" ? 1 : 0)), mods: rollMods(rng, ring, kind), links };
}

/** The node an id names on a chart, or null if the id is not a node's. */
export function atlasNodeById(seed: string, id: unknown): AtlasNode | null {
  const cell = atlasCell(id);
  return cell ? atlasNode(seed, cell) : null;
}

/**
 * Whether a crew that has cleared `cleared` may open this node: it is not the Harbor, not cleared
 * already, and a route runs to it from the Harbor or from a node they have cleared.
 */
export function atlasOpen(seed: string, cleared: ReadonlySet<string>, id: unknown): boolean {
  const node = atlasNodeById(seed, id);
  if (!node || node.kind === "harbor" || cleared.has(node.id)) return false;
  return node.links.some((l) => l === ATLAS_HOME || cleared.has(l));
}

/**
 * The chart as a crew sees it: the Harbor, what they have cleared, what is open to them, and a ring
 * of fog beyond that. Routes are listed only between nodes that are shown.
 */
export function atlasView(seed: string, cleared: ReadonlySet<string>): AtlasNodeView[] {
  const known = new Map<string, AtlasNode>();
  for (const id of [ATLAS_HOME, ...cleared]) {
    const node = atlasNodeById(seed, id);
    if (node) known.set(node.id, node);
  }
  const open = new Map<string, AtlasNode>();
  for (const node of known.values()) {
    for (const link of node.links) {
      if (known.has(link) || open.has(link)) continue;
      const next = atlasNodeById(seed, link);
      if (next) open.set(next.id, next);
    }
  }
  const fog = new Map<string, AtlasNode>();
  for (const node of open.values()) {
    for (const link of node.links) {
      if (known.has(link) || open.has(link) || fog.has(link)) continue;
      const next = atlasNodeById(seed, link);
      if (next) fog.set(next.id, next);
    }
  }
  const shown = (id: string) => known.has(id) || open.has(id) || fog.has(id);
  // Fog knows only the routes that lead out of it to somewhere open: not what lies between two unknowns.
  const seen = (node: AtlasNode) => node.links.filter(shown);
  return [
    ...[...known.values()].map((n): AtlasNodeView => ({ ...n, links: seen(n), state: n.kind === "harbor" ? "harbor" : "cleared" })),
    ...[...open.values()].map((n): AtlasNodeView => ({ ...n, links: seen(n), state: "open" })),
    ...[...fog.values()].map((n): AtlasNodeView => ({ id: n.id, hex: n.hex, ring: n.ring, links: n.links.filter((l) => open.has(l)), state: "fogged" })),
  ];
}

/** The ring a node's bounty is paid as: its own, or further out for a lair. */
export const atlasTier = (node: Pick<AtlasNode, "ring" | "kind">): number => Math.max(1, node.ring + (node.kind === "lair" ? LAIR_RINGS : 0));

/** The kind of place a node is (zone/sites.ts): what its map is laid out as. The same node is always the same kind of place. */
export const nodeSite = (seed: string, node: Pick<AtlasNode, "id" | "kind" | "biome" | "clime">): string =>
  siteFor(node.biome, node.clime, node.kind === "lookout" ? "lookout" : node.kind === "lair" ? "lair" : "landfall", roll(seed, "site", node.id));

/**
 * What a node's map is made from, for a party of this many. The ring sets the level; the ground, the climate and
 * what the place is (its site) set the rest. The nodes beside the Harbor are small and gentle; further out a
 * place is a sprawl with several bands on it. `more` is what a lodestone set into the node adds to its own
 * modifiers (lodestone.ts: `stoneOn(node, stone).added`), and `stone` how much that stone carried in all (left
 * out with no stone): the lodestones in the place's spoils are reckoned from it.
 */
export function nodeOptions(seed: string, node: AtlasNode, party: number, more: readonly ZoneMod[] = [], stone?: number): ZoneOptions {
  const rng = rngFor(seed, "lay", node.id);
  const near = node.ring <= 1;
  const base = { party, level: node.level, threat: near ? 1 : 2, mods: cleanMods([...node.mods, ...more]), tier: atlasTier(node), name: node.name, clime: node.clime, ...(stone !== undefined ? { stone } : {}) };
  if (node.kind === "seacave") return zoneOptions({ ...base, size: "medium", biome: "caves", delve: true });
  const site = nodeSite(seed, node);
  // High, broken ground: whoever holds the top has the best of it.
  if (node.kind === "lookout") return zoneOptions({ ...base, site, size: "medium", biome: node.biome, groups: rng.int(3, 4), elevation: 3, obstacles: 1, clear: 4 });
  // The beast itself in its den, with a band of whatever else lives there about it, and more bands out on the
  // ground round it (never a second beast).
  if (node.kind === "lair") {
    return zoneOptions({ ...base, site, size: "medium", biome: node.biome, groups: 3, kinds: [CLIME_BEAST[node.clime] ?? LAIR_BEAST[node.biome]], elevation: rng.int(1, 2), obstacles: rng.int(1, 2), clear: 4 });
  }
  return zoneOptions({
    ...base,
    site,
    size: near ? "small" : "medium",
    biome: node.biome,
    groups: near ? rng.int(2, 3) : rng.int(3, 5),
    elevation: rng.int(1, node.biome === "shore" ? 2 : 3),
    obstacles: rng.int(0, 1) + (node.biome === "woods" ? 1 : 0),
    clear: 4,
  });
}
