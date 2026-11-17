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
//   sea caves  now and then a node is a cave: a delve (zone/delve.ts), with
//              chests and a hoard, cleared when the last chest is open.
//
// What a crew sees of it (`atlasView`) is the nodes it has cleared, the ones
// open to it (a route from the Harbor or from a cleared node), and a ring of
// fog beyond those: where there is something, and nothing more.

import { makeRng, seedFromString, type Rng } from "./rng";
import { zoneOptions } from "./zone/gen";
import { ZONE_MODS, ZONE_MOD_IDS, type ZoneModId } from "./zone/mods";
import type { ZoneBiome, ZoneOptions } from "./zone/types";

/** A cell of the chart, in axial hex coordinates. The Harbor is at 0,0. */
export interface AtlasCell {
  q: number;
  r: number;
}

export type AtlasNodeKind = "harbor" | "landfall" | "seacave";

export interface AtlasNode {
  /** "q,r": the node's cell, and its name in the database. */
  id: string;
  cell: AtlasCell;
  /** Where it is drawn, in cells: the cell's middle, nudged, so the chart does not look ruled. */
  x: number;
  y: number;
  name: string;
  kind: AtlasNodeKind;
  biome: ZoneBiome;
  /** Cells out from the Harbor: 0 for the Harbor itself. */
  ring: number;
  /** The level of what stands on it. */
  level: number;
  mods: ZoneModId[];
  /** The nodes its routes run to. */
  links: string[];
}

export type AtlasNodeState = "harbor" | "cleared" | "open" | "fogged";

/** A node as a crew is shown it. A fogged one is only somewhere a route leads: no name, no ground, nothing about what is there. */
export type AtlasNodeView =
  | (AtlasNode & { state: "harbor" | "cleared" | "open" })
  | { id: string; x: number; y: number; ring: number; links: string[]; state: "fogged" };

export const ATLAS_HOME = "0,0";
/** How far out a node may be named at all: a guard on what comes off the wire, far beyond anywhere a crew will sail. */
export const ATLAS_REACH = 500;
/** The share of pairs of neighbours joined by a route, besides the one route every node has toward the Harbor. */
const EXTRA_ROUTES = 0.3;
/** How far a node is nudged off the middle of its cell, in cells. */
const JITTER = 0.26;
/** One node in so many, from the second ring out, is a sea cave. */
const SEACAVE_CHANCE = 0.16;

const DIRS: AtlasCell[] = [{ q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }];
const idOf = (c: AtlasCell) => `${c.q},${c.r}`;
const ringOf = (c: AtlasCell) => (Math.abs(c.q) + Math.abs(c.r) + Math.abs(c.q + c.r)) / 2;
const around = (c: AtlasCell): AtlasCell[] => DIRS.map((d) => ({ q: c.q + d.q, r: c.r + d.r }));
/** The middle of a cell on the page: pointy hexes, a cell wide. */
const centre = (c: AtlasCell) => ({ x: c.q + c.r / 2, y: (c.r * Math.sqrt(3)) / 2 });
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
  const [lo, hi] = [idOf(a), idOf(b)].sort();
  return roll(seed, "route", `${lo}|${hi}`) < EXTRA_ROUTES;
}

/** Slow noise over the chart, 0 to 1: a hashed value at each corner of a coarse grid, blended between them. */
function noise(seed: string, tag: string, x: number, y: number, scale: number): number {
  const fx = x / scale;
  const fy = y / scale;
  const [x0, y0] = [Math.floor(fx), Math.floor(fy)];
  const ease = (t: number) => t * t * (3 - 2 * t);
  const [tx, ty] = [ease(fx - x0), ease(fy - y0)];
  const at = (ix: number, iy: number) => roll(seed, tag, `${ix},${iy}`);
  const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
  const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
  return top * (1 - ty) + bottom * ty;
}

/** The ground of the region a cell lies in. */
function regionBiome(seed: string, cell: AtlasCell): ZoneBiome {
  const { x, y } = centre(cell);
  const v = noise(seed, "ground", x, y, 3.2);
  return v < 0.4 ? "shore" : v < 0.6 ? "meadow" : "woods";
}

const FIRST = ["Gull", "Widow's", "Salt", "Drowned", "Lantern", "Brine", "Kelp", "Thistle", "Crooked", "Grey", "Amber", "Wrecker's", "Tinker's", "Mizzen", "Fathom", "Barnacle", "Squall", "Ember", "Moss", "Heron", "Cinder", "Marrow", "Bellman's", "Tarry", "Whistling", "Low", "Stray", "Cutler's", "Hag's", "Pale"];
const LAST: Record<ZoneBiome, string[]> = {
  meadow: ["Isle", "Holm", "Green", "Down", "Lea", "Rise"],
  woods: ["Wood", "Thicket", "Grove", "Holt", "Tangle", "Copse"],
  shore: ["Cove", "Strand", "Spit", "Shoals", "Bar", "Landing"],
  caves: ["Grotto", "Sea Cave", "Sump", "Gullet", "Hole", "Cellars"],
};

/** How dangerous a ring is: the level of what stands there. A ring out is a level up. */
export const atlasLevel = (ring: number): number => Math.max(1, Math.min(40, Math.round(ring)));
/** How many modifiers a node in this ring may carry: none beside the Harbor, more the further out. */
export function atlasModCount(ring: number): [number, number] {
  return ring <= 1 ? [0, 0] : ring <= 3 ? [0, 1] : ring <= 6 ? [1, 2] : [1, 3];
}

/** The modifiers a node carries: a few picked from those that suit it, one kind of ground at most. */
function rollMods(rng: Rng, ring: number, kind: AtlasNodeKind): ZoneModId[] {
  const [lo, hi] = atlasModCount(ring);
  const want = rng.int(lo, hi);
  // A sea cave's ground is the caverns' own: only what changes the enemy means anything there.
  const pool = ZONE_MOD_IDS.filter((id) => kind !== "seacave" || ZONE_MODS[id].kind === "enemy");
  const out: ZoneModId[] = [];
  for (let tries = 0; out.length < want && tries < 24; tries++) {
    const id = rng.pick(pool);
    if (out.includes(id) || (ZONE_MODS[id].hazard && out.some((o) => ZONE_MODS[o].hazard))) continue;
    out.push(id);
  }
  // In the order they are listed, so the same set always reads the same.
  return ZONE_MOD_IDS.filter((id) => out.includes(id));
}

/** The node in a cell of a chart. The same seed and cell always give the same node. */
export function atlasNode(seed: string, cell: AtlasCell): AtlasNode {
  const id = idOf(cell);
  const ring = ringOf(cell);
  const mid = centre(cell);
  const links = around(cell).filter((n) => joined(seed, cell, n)).map(idOf);
  if (ring === 0) return { id, cell, x: mid.x, y: mid.y, name: "The Harbor", kind: "harbor", biome: "shore", ring: 0, level: 1, mods: [], links };
  const rng = rngFor(seed, "node", id);
  const x = mid.x + (rng.next() * 2 - 1) * JITTER;
  const y = mid.y + (rng.next() * 2 - 1) * JITTER;
  const kind: AtlasNodeKind = ring >= 2 && rng.chance(SEACAVE_CHANCE) ? "seacave" : "landfall";
  const biome = kind === "seacave" ? "caves" : regionBiome(seed, cell);
  const first = rng.pick(FIRST);
  const name = `${first} ${rng.pick(LAST[biome])}`;
  return { id, cell, x, y, name, kind, biome, ring, level: atlasLevel(ring), mods: rollMods(rng, ring, kind), links };
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
    ...[...fog.values()].map((n): AtlasNodeView => ({ id: n.id, x: n.x, y: n.y, ring: n.ring, links: n.links.filter((l) => open.has(l)), state: "fogged" })),
  ];
}

/**
 * What a node's map is made from, for a party of this many. The ring sets the level; the ground and
 * the modifiers set the rest. The nodes beside the Harbor are small and gentle.
 */
export function nodeOptions(seed: string, node: AtlasNode, party: number): ZoneOptions {
  const rng = rngFor(seed, "lay", node.id);
  const near = node.ring <= 1;
  const base = { party, level: node.level, threat: near ? 1 : 2, mods: node.mods, tier: Math.max(1, node.ring) };
  if (node.kind === "seacave") return zoneOptions({ ...base, size: "medium", biome: "caves", delve: true });
  return zoneOptions({
    ...base,
    size: near ? "small" : "medium",
    biome: node.biome,
    groups: near ? rng.int(1, 2) : rng.int(2, 3),
    elevation: rng.int(0, node.biome === "shore" ? 1 : 2),
    obstacles: rng.int(0, 1) + (node.biome === "woods" ? 1 : 0),
    clear: 4,
  });
}
