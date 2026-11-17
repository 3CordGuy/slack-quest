// The atlas as a world to look at: the hex map the chart's nodes stand on.
//
// The world is as endless as the chart (atlas.ts) and worked out the same
// way, from the chart's seed and a hex alone: seas and their coasts, sand
// along the shore, grass, forest, and ridges of hills that climb into
// mountains. A node stands on its own hex of it (`AtlasNode.hex`), and its
// ground is whatever lies there, so a wooded isle really is in the woods.
//
// What a crew is shown is a window of it: the ground round whatever hex the
// view is looking at, as far as the view can see before the distance is lost
// in mist. The view asks for another as the camera travels, so the world
// never comes to an edge.
//
//   - Round each node the ground is made fit to stand on: a clearing in the
//     woods, an islet where a node falls in the sea, a few crags behind a
//     sea cave (with its mouth in them), a green under the Harbor's lighthouse.
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
import { ATLAS_SPACING, atlasClime, atlasNoise, atlasRegion, type AtlasNodeView } from "./atlas";
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

/**
 * How each climate bends the lie of the land. `sea` is how much of it is under water (the greenwood's share
 * is 0.34: the dunes are dry and the mire half drowned); `strand` how wide the shore beyond the water is;
 * `ridge` how readily hills rise; `woods` how much of what would be forest is (the dunes have a tree here and there).
 */
const LIE: Record<Clime, { sea: number; strand: number; ridge: number; woods: number }> = {
  greenwood: { sea: 0.34, strand: 0.05, ridge: 0.68, woods: 1 },
  // Its shallows are frozen over: a wide shelf of ice where a strand would be.
  frost: { sea: 0.3, strand: 0.09, ridge: 0.64, woods: 0.8 },
  dunes: { sea: 0.22, strand: 0.03, ridge: 0.66, woods: 0.12 },
  mire: { sea: 0.4, strand: 0.03, ridge: 0.78, woods: 0.9 },
  // No sea: the low ground is molten, with a crust at its edge.
  ash: { sea: 0.21, strand: 0.05, ridge: 0.6, woods: 0.45 },
};

/** The lie of the land at a hex of the world, before anything is put on it. `memo` saves working the same noise out twice. */
export function atlasGround(seed: string, hex: HexPos, memo?: Map<string, number>): Ground {
  const at = (tag: string, scale: number) => atlasNoise(seed, tag, hex, scale, memo);
  const clime = atlasClime(seed, hex, memo);
  const lie = LIE[clime];
  // Where it is, so the view can paint it: left out for the greenwood, which is how ground looks unless told otherwise.
  const here = clime === "greenwood" ? {} : { clime };
  const sea = at("sea", 3.1);
  const fine = at("fine", 0.34);
  const lift = (biome: Biome, more = 0): Ground => ({ biome, h: BASE_HEIGHT[biome] + more + fine * 0.05, ...here });
  // In the ashlands what lies lowest is not water: it is drawn as low, bare ground, and painted as the fire it is.
  if (sea < lie.sea) return clime === "ash" ? { biome: "sand", h: BASE_HEIGHT.water + 0.02, ...here } : { biome: "water", h: BASE_HEIGHT.water, ...here };
  // Ridges: hills that climb into mountains along their spine.
  const ridge = at("ridge", 1.25);
  if (ridge > lie.ridge && sea > lie.sea + 0.08) return { ...lift("hills", Math.min(1.1, (ridge - lie.ridge) * 4.5)), ...(ridge > lie.ridge + 0.12 && fine > 0.55 ? { blocker: "boulders" as Blocker } : {}) };
  // The strand: sand wherever the sea is near (ice, in the frost; a crust of cooled rock, in the ashlands).
  if (sea < lie.sea + lie.strand) return clime === "frost" || clime === "ash" ? { biome: "sand", h: BASE_HEIGHT.water + 0.06 + fine * 0.03, ...here } : lift("sand");
  // The mire is pocked with pools.
  if (clime === "mire" && fine < 0.2) return { biome: "water", h: BASE_HEIGHT.water, ...here };
  const region = atlasRegion(seed, hex, memo);
  const wooded = (share: number) => fine < share * lie.woods;
  if (region === "shore") return clime === "greenwood" || clime === "dunes" ? (fine > 0.8 ? lift("plains") : lift("sand")) : wooded(0.25) ? lift("forest") : lift("plains");
  if (region === "woods") return wooded(0.7) ? lift("forest") : lift("plains");
  return fine > 1 - 0.26 * lie.woods ? lift("forest") : { ...lift("plains"), ...(fine < 0.16 && clime === "greenwood" ? { grass: "tall" as const } : {}) };
}

/**
 * The world as a crew sees it, round `centre` (a hex of the world) and as far as `reach` from it: the ground
 * round each node they know, made fit to stand on, and which of it the cloud is lifted from.
 */
export function atlasWorld(seed: string, nodes: readonly AtlasNodeView[], centre: HexPos = { q: 0, r: 0 }, reach = ATLAS_VIEW): AtlasWorld {
  const memo = new Map<string, number>();
  // Only what a node near the window can light, or make of the ground, matters to it.
  const known = nodes.flatMap((n) => (n.state !== "fogged" && hexDistance(n.hex, centre) <= reach + ATLAS_FARSIGHT + ATLAS_RIM ? [n] : []));

  // ---------- what stands where ----------
  /** The ground a node makes of the hexes round it, by world hex. */
  const made = new Map<string, Ground>();
  const put = (hex: HexPos, ground: Ground) => made.set(posKey(hex), ground);
  for (const n of known) {
    const here = atlasGround(seed, n.hex, memo);
    // Whatever it makes of the ground is still ground of the climate it lies in.
    const flat = (biome: Biome): Ground => ({ biome, h: BASE_HEIGHT[biome], ...(here.clime ? { clime: here.clime } : {}) });
    const ring = HARBOR_SIDES.map((d) => ({ q: n.hex.q + d.q, r: n.hex.r + d.r }));
    if (n.kind === "harbor") {
      // Home: a green with the lighthouse on it. (Not cobbles: the renderer takes cobbles for a wet, walled port.)
      put(n.hex, flat("plains"));
      for (const p of ring) put(p, flat("plains"));
      continue;
    }
    // Somewhere to stand: open ground of the region's own kind, and an islet of sand where the node falls in the sea.
    const sandy = n.biome === "shore" || here.biome === "water" || here.biome === "sand";
    put(n.hex, flat(n.kind === "seacave" || sandy ? "sand" : "plains"));
    ring.forEach((p, side) => {
      const was = atlasGround(seed, p, memo);
      // A sea cave has crags at its back.
      if (n.kind === "seacave" && (side === 5 || side === 0 || side === 4)) put(p, { ...flat("hills"), h: BASE_HEIGHT.hills + 0.35 });
      else if (was.biome === "water" && here.biome === "water") put(p, flat("sand"));
      else if (was.blocker) put(p, { biome: was.biome, h: was.h, ...(was.clime ? { clime: was.clime } : {}) });
    });
  }

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

  // Row by row, so the same ground comes out the same whatever order the nodes were given in.
  const order = (a: HexPos, b: HexPos) => a.r - b.r || a.q - b.q;
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
