// The atlas as a world to look at: the hex map the chart's nodes stand on.
//
// The world is as endless as the chart (atlas.ts) and worked out the same
// way, from the chart's seed and a hex alone: seas and their coasts, sand
// along the shore, grass, forest, and ridges of hills that climb into
// mountains. A node stands on its own hex of it (`AtlasNode.hex`), and what
// lies there is what the node is (`atlasLie` in atlas.ts, which both this
// ground and the node are made from): a place drawn on sand is a desert, one
// in the trees is in the woods, one among the peaks is high, broken ground.
//
// What a crew is shown is a window of it: the ground round whatever hex the
// view is looking at, as far as the view can see before the distance is lost
// in mist. The view asks for another as the camera travels, so the world
// never comes to an edge.
//
//   - Round each node the ground is made fit to stand on, and plainly the
//     land its map is made of (`standing`): a clearing with trees all round
//     it in the woods, an islet where a node falls in the sea, a shelf among
//     the peaks in the hills (and under a lookout anywhere), a few crags
//     behind a sea cave (with its mouth in them), a green under the Harbor's
//     lighthouse.
//   - Only the ground within a few hexes of the Harbor, a cleared node or an
//     open one is lit. Everything else is under cloud: the ground is there,
//     and is not handed over at all, save a few hexes past the lit ground's
//     edge, where the cloud thins and the land shows through it.
//
// The map is an ordinary WorldMap, so the view draws it with the same
// renderer as the Harbor, but its hexes are the world's own: a tile is at
// the hex of the world it is, not counted from a corner, and there is no
// tile where there is only cloud. So one window and the next agree about
// every hex they share, and a view can swap one for the other under the
// camera with nothing seeming to move. The cloud, the nodes and the routes
// between them are the view's to draw (the client's atlas/ folder).

import { hexDistance, posKey, type HexPos } from "@gantt-quest/core";
import { ATLAS_SPACING, atlasLie, type AtlasNodeView } from "./atlas";
import { HARBOR_SIDES } from "./harbor";
import { BASE_HEIGHT, type Biome, type Blocker, type Clime, type Poi, type Tile, type WorldMap } from "./map";

export interface AtlasWorld {
  /** The ground the crew can see round the window's middle, and a little past its edge: tiles at the world's own hexes, none where there is only cloud. */
  map: WorldMap;
  /** The hexes of it the cloud is lifted from. The rest of the map's tiles lie under the cloud's thinning edge. */
  lit: HexPos[];
  /** The same, as the view wants it to part a cloud that is not made of hexes: round each of these hexes, as far as `reach` hexes. */
  clear: { hex: HexPos; reach: number }[];
}

/** How far a window reaches from its middle, in hexes: further than the view sees before the distance is lost in mist. */
export const ATLAS_VIEW = 62;
/** How far the cloud is lifted round the Harbor and a cleared node, round a node that is only open, and round a lookout the crew has cleared. */
export const ATLAS_SIGHT = ATLAS_SPACING + 2;
export const ATLAS_GLIMPSE = 2;
export const ATLAS_FARSIGHT = ATLAS_SPACING * 3 + 1;
/** How far past the lit ground the land is still handed over, to show through the cloud's edge. */
export const ATLAS_RIM = 3;

type Ground = Pick<Tile, "biome" | "h" | "blocker" | "grass" | "clime">;

/** Ground of a climate: the climate is left off the greenwood's, which is how ground looks unless told otherwise. */
const inClime = (clime: Clime) => (clime === "greenwood" ? {} : { clime });

/**
 * The ground at a hex of the world, before anything is put on it: the lie of the land there (`atlasLie`, which
 * also says what a place standing on it is), as a tile to draw. `memo` saves working the same noise out twice.
 */
export function atlasGround(seed: string, hex: HexPos, memo?: Map<string, number>): Ground {
  const { land, clime, fine, up, lea } = atlasLie(seed, hex, memo);
  const here = inClime(clime);
  const lift = (biome: Biome, more = 0): Ground => ({ biome, h: BASE_HEIGHT[biome] + more + fine * 0.05, ...here });
  switch (land) {
    // In the ashlands what lies lowest is not water: it is drawn as low, bare ground, and painted as the fire it is.
    case "sea":
      return clime === "ash" ? { biome: "sand", h: BASE_HEIGHT.water + 0.02, ...here } : { biome: "water", h: BASE_HEIGHT.water, ...here };
    // Hills that climb into mountains along the spine of their ridge.
    case "hills":
      return { ...lift("hills", Math.min(1.1, up * 4.5)), ...(up > 0.12 && fine > 0.55 ? { blocker: "boulders" as Blocker } : {}) };
    // Sand wherever the sea is near (ice, in the frost; a crust of cooled rock, in the ashlands).
    case "strand":
      return clime === "frost" || clime === "ash" ? { biome: "sand", h: BASE_HEIGHT.water + 0.06 + fine * 0.03, ...here } : lift("sand");
    case "sand":
      return lift("sand");
    case "forest":
      return lift("forest");
    case "grass":
      return { ...lift("plains"), ...(lea && fine < 0.16 && clime === "greenwood" ? { grass: "tall" as const } : {}) };
  }
}

/** The six hexes round a hex, in the order of its sides. */
const ringOf = (hex: HexPos): HexPos[] => HARBOR_SIDES.map((d) => ({ q: hex.q + d.q, r: hex.r + d.r }));

/**
 * The ground a place makes of its own hex and the six round it, so that what it stands on is plainly the land
 * its map is made of (`atlasLie` at its hex: nothing here is decided twice), and is fit to stand on:
 *
 *   the sea     an islet of sand (of ice, in the frost; of cooled rock, in the fire)
 *   a strand    the sand it is
 *   open sand   the sand it is
 *   open ground itself, with the trees beside it thinned: a green, not a clearing
 *   forest      a clearing, with trees on every side of it that will grow them
 *   hills       a shelf of open ground high among the peaks, with crags at its back
 *
 * And what the place is can say more than its land does: a lookout stands on such a shelf wherever it is, a sea
 * cave on sand with crags (and its mouth) behind, and the Harbor on a green.
 */
function standing(seed: string, n: Exclude<AtlasNodeView, { state: "fogged" }>, memo: Map<string, number>): Made[] {
  const lie = atlasLie(seed, n.hex, memo);
  // Whatever it makes of the ground is still ground of the climate it lies in.
  const here = inClime(lie.clime);
  const flat = (biome: Biome, h = BASE_HEIGHT[biome]): Ground => ({ biome, h, ...here });
  const out: Made[] = [];
  const put = (hex: HexPos, ground: Ground, rank: Made["rank"] = 0) => out.push({ hex, ground, rank });
  const ring = ringOf(n.hex);
  if (n.kind === "harbor") {
    // Home: a green with the lighthouse on it. (Not cobbles: the renderer takes cobbles for a wet, walled port.)
    put(n.hex, flat("plains"), 2);
    for (const p of ring) put(p, flat("plains"), 1);
    return out;
  }
  const high = n.kind === "lookout" || (lie.land === "hills" && n.kind !== "seacave");
  // Sand where its map is sand underfoot: by the sea, on open sand, and anywhere at all in the dunes that is not green.
  const sandy = n.kind === "seacave" || lie.land === "sea" || lie.land === "strand" || lie.land === "sand" || (high && lie.clime === "dunes");
  put(n.hex, flat(sandy ? "sand" : "plains", high ? BASE_HEIGHT.hills + SHELF : undefined), 2);
  ring.forEach((p, side) => {
    const was = atlasLie(seed, p, memo);
    const ground = atlasGround(seed, p, memo);
    // A sea cave has crags at its back, and so has a place up in the hills (or a lookout, wherever it is).
    if ((n.kind === "seacave" || high) && (side === 5 || side === 0 || side === 4)) put(p, flat("hills", BASE_HEIGHT.hills + (high ? SHELF + 0.25 : 0.35)), 1);
    else if (lie.land === "sea" && was.land === "sea") put(p, flat("sand"));
    else if (lie.land === "forest" && was.land === "grass") put(p, { biome: "forest", h: BASE_HEIGHT.forest + was.fine * 0.05, ...inClime(was.clime) });
    else if (lie.land === "grass" && was.land === "forest") put(p, { biome: "plains", h: BASE_HEIGHT.plains + was.fine * 0.05, ...inClime(was.clime) });
    else if (ground.blocker) put(p, { biome: ground.biome, h: ground.h, ...(ground.clime ? { clime: ground.clime } : {}) });
  });
  return out;
}
/** How far above the foot of the hills a place up in them stands. */
const SHELF = 0.2;
/**
 * Ground a place makes of a hex. Where two places near each other would make different things of the same hex,
 * the higher `rank` has it: a place's own hex (2) over the crags at a place's back and the Harbor's green (1),
 * over the trees and sand beside one (0).
 */
interface Made {
  hex: HexPos;
  ground: Ground;
  rank: 0 | 1 | 2;
}

/**
 * The world as a crew sees it, round `centre` (a hex of the world) and as far as `reach` from it: the ground
 * round each node they know, made fit to stand on, and which of it the cloud is lifted from.
 */
export function atlasWorld(seed: string, nodes: readonly AtlasNodeView[], centre: HexPos = { q: 0, r: 0 }, reach = ATLAS_VIEW): AtlasWorld {
  const memo = new Map<string, number>();
  // Only what a node near the window can light, or make of the ground, matters to it.
  const order = (a: HexPos, b: HexPos) => a.r - b.r || a.q - b.q;
  // (In the order of their hexes, so the same ground comes out the same whatever order the nodes were given in.)
  const known = nodes.flatMap((n) => (n.state !== "fogged" && hexDistance(n.hex, centre) <= reach + ATLAS_FARSIGHT + ATLAS_RIM ? [n] : [])).sort((a, b) => order(a.hex, b.hex));

  // ---------- what stands where ----------
  /** The ground the nodes make of their own hexes and the hexes round them, by world hex. */
  const laid = new Map<string, Made>();
  for (const n of known) {
    for (const m of standing(seed, n, memo)) if ((laid.get(posKey(m.hex))?.rank ?? -1) <= m.rank) laid.set(posKey(m.hex), m);
  }
  const made = new Map([...laid].map(([key, m]) => [key, m.ground]));

  // ---------- what the cloud is lifted from ----------
  const lit = new Map<string, HexPos>();
  const shown = new Map<string, HexPos>();
  /** Every hex within `radius` of `mid` that is on the window, into `into`. */
  const round = (mid: HexPos, radius: number, into: Map<string, HexPos>) => {
    for (let dq = -radius; dq <= radius; dq++) {
      for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) {
        const hex = { q: mid.q + dq, r: mid.r + dr };
        if (hexDistance(hex, centre) <= reach) into.set(posKey(hex), hex);
      }
    }
  };
  const clear: AtlasWorld["clear"] = [];
  for (const n of known) {
    const far = n.state === "open" ? ATLAS_GLIMPSE : n.kind === "lookout" ? ATLAS_FARSIGHT : ATLAS_SIGHT;
    round(n.hex, far, lit);
    round(n.hex, far + ATLAS_RIM, shown);
    clear.push({ hex: n.hex, reach: far });
  }

  // Row by row.
  const tiles: Tile[] = [...shown.values()].sort(order).map((hex) => ({ ...hex, ...(made.get(posKey(hex)) ?? atlasGround(seed, hex, memo)) }));

  // ---------- what is built there ----------
  // The Harbor's lighthouse, and the mouth of each sea cave, in the crags at its back. (A node itself is the view's to draw.)
  const pois: Poi[] = [];
  const stand = (id: string, kind: Poi["kind"], pos: HexPos, cleared: boolean) => {
    if (lit.has(posKey(pos))) pois.push({ id, kind, pos, hidden: false, cleared, usedBy: [], enemies: [] });
  };
  for (const n of known) {
    if (n.kind === "harbor") stand(`node:${n.id}`, "lighthouse", n.hex, true);
    else if (n.kind === "seacave") stand(`node:${n.id}`, "cave", { q: n.hex.q + HARBOR_SIDES[5].q, r: n.hex.r + HARBOR_SIDES[5].r }, n.state !== "open");
  }

  // The grid is only how far across the window reaches: its tiles are not counted from a corner of it.
  return { map: { grid: { cols: reach * 2 + 1, rows: reach * 2 + 1 }, tiles, pois }, lit: [...lit.values()].sort(order), clear };
}
