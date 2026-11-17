// The atlas as a world to look at: the hex map the chart's nodes stand on.
//
// The world is as endless as the chart (atlas.ts) and worked out the same
// way, from the chart's seed and a hex alone: seas and their coasts, sand
// along the shore, grass, forest, and ridges of hills that climb into
// mountains. A node stands on its own hex of it (`AtlasNode.hex`), and its
// ground is whatever lies there, so a wooded isle really is in the woods.
//
// What a crew is shown is a window of it, big enough for every node they can
// see and a margin round them:
//
//   - Round each node the ground is made fit to stand on: a clearing in the
//     woods, an islet where a node falls in the sea, a few crags behind a
//     sea cave, a green under the Harbor's lighthouse.
//   - Roads are trodden between the nodes a crew has reached, wherever the
//     way lies over grass.
//   - Everything further than a few hexes from the Harbor, a cleared node or
//     an open one is fog: the ground is there, and is not shown.
//
// The map is an ordinary WorldMap, so the view draws it with the same
// renderer as the Harbor. Its hexes are the world's, shifted so the window's
// corner is 0,0 (`origin` says by how much).

import { allHexesInGrid, hexDistance, posKey, type HexGrid, type HexPos } from "@gantt-quest/core";
import { ATLAS_SPACING, atlasNoise, atlasRegion, type AtlasNodeView } from "./atlas";
import { HARBOR_SIDES } from "./harbor";
import { BASE_HEIGHT, type Biome, type Blocker, type Poi, type Tile, type WorldMap } from "./map";
import { hexesBetween } from "./zone/geometry";

export interface AtlasWorld {
  map: WorldMap;
  /** The world hex that is 0,0 on the map: take it from a node's hex to get where the node stands on the map. */
  origin: HexPos;
}

/** A world hex as it lies on a window's map. */
export const onAtlasMap = (world: Pick<AtlasWorld, "origin">, hex: HexPos): HexPos => ({ q: hex.q - world.origin.q, r: hex.r - world.origin.r });

/** How many hexes of margin a window keeps round the nodes it shows. */
const MARGIN = 7;
/** The biggest a window is made, in hexes. A chart that has outgrown it is shown round its open nodes. */
const MAX_COLS = 96;
const MAX_ROWS = 84;
/** How far the fog is lifted round the Harbor and a cleared node, and round a node that is only open. */
export const ATLAS_SIGHT = ATLAS_SPACING + 2;
export const ATLAS_GLIMPSE = 3;

type Ground = Pick<Tile, "biome" | "h" | "blocker" | "grass">;

/** The lie of the land at a hex of the world, before anything is put on it. `memo` saves working the same noise out twice. */
export function atlasGround(seed: string, hex: HexPos, memo?: Map<string, number>): Ground {
  const at = (tag: string, scale: number) => atlasNoise(seed, tag, hex, scale, memo);
  const sea = at("sea", 3.1);
  const fine = at("fine", 0.34);
  const lift = (biome: Biome, more = 0): Ground => ({ biome, h: BASE_HEIGHT[biome] + more + fine * 0.05 });
  if (sea < 0.34) return { biome: "water", h: BASE_HEIGHT.water };
  // Ridges: hills that climb into mountains along their spine.
  const ridge = at("ridge", 1.25);
  if (ridge > 0.68 && sea > 0.42) return { ...lift("hills", Math.min(0.9, (ridge - 0.68) * 4)), ...(ridge > 0.8 && fine > 0.55 ? { blocker: "boulders" as Blocker } : {}) };
  // The strand: sand wherever the sea is near.
  if (sea < 0.39) return lift("sand");
  const region = atlasRegion(seed, hex, memo);
  if (region === "shore") return fine > 0.8 ? lift("plains") : lift("sand");
  if (region === "woods") return fine < 0.7 ? lift("forest") : lift("plains");
  return fine > 0.74 ? lift("forest") : { ...lift("plains"), ...(fine < 0.16 ? { grass: "tall" as const } : {}) };
}

/**
 * The world as a crew sees it: a map with every node they are shown on it, the ground round each made
 * fit to stand on, roads between the ones they have reached, and fog over what is far from all of them.
 */
export function atlasWorld(seed: string, nodes: readonly AtlasNodeView[]): AtlasWorld {
  const memo = new Map<string, number>();
  const known = nodes.filter((n) => n.state !== "fogged");
  const reached = known.filter((n) => n.state !== "open");
  const open = known.filter((n) => n.state === "open");

  // ---------- the window ----------
  // Round every node shown; or, once that is too big, round the open ones (the edge of what is known).
  const fits = (set: readonly AtlasNodeView[]) => {
    const r0 = Math.min(...set.map((n) => n.hex.r)) - MARGIN;
    const r1 = Math.max(...set.map((n) => n.hex.r)) + MARGIN;
    const col = (hex: HexPos) => hex.q + Math.floor((hex.r - r0) / 2);
    const c0 = Math.min(...set.map((n) => col(n.hex))) - MARGIN;
    const c1 = Math.max(...set.map((n) => col(n.hex))) + MARGIN;
    return { r0, c0, cols: c1 - c0 + 1, rows: r1 - r0 + 1 };
  };
  let box = fits(nodes.length > 0 ? nodes : [{ hex: { q: 0, r: 0 } } as AtlasNodeView]);
  if ((box.cols > MAX_COLS || box.rows > MAX_ROWS) && open.length > 0) box = fits(open);
  if (box.cols > MAX_COLS || box.rows > MAX_ROWS) {
    // Still too big: the middle of it.
    const [dc, dr] = [Math.max(0, box.cols - MAX_COLS), Math.max(0, box.rows - MAX_ROWS)];
    // An even number of rows off the top keeps the columns where they were.
    const top = Math.floor(dr / 4) * 2;
    box = { r0: box.r0 + top, c0: box.c0 + Math.floor(dc / 2) + top / 2, cols: box.cols - dc, rows: box.rows - dr };
  }
  const grid: HexGrid = { cols: box.cols, rows: box.rows };
  const origin: HexPos = { q: box.c0, r: box.r0 };
  const world = (p: HexPos): HexPos => ({ q: p.q + origin.q, r: p.r + origin.r });

  // ---------- what stands where ----------
  /** The ground a node makes of the hexes round it, by world hex. */
  const made = new Map<string, Ground>();
  const put = (hex: HexPos, ground: Ground) => made.set(posKey(hex), ground);
  const flat = (biome: Biome): Ground => ({ biome, h: BASE_HEIGHT[biome] });
  for (const n of known) {
    const here = atlasGround(seed, n.hex, memo);
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
      if (n.kind === "seacave" && (side === 5 || side === 0 || side === 4)) put(p, { biome: "hills", h: BASE_HEIGHT.hills + 0.35 });
      else if (was.biome === "water" && here.biome === "water") put(p, flat("sand"));
      else if (was.blocker) put(p, { biome: was.biome, h: was.h });
    });
  }

  // ---------- fog ----------
  const lit = (hex: HexPos) => reached.some((n) => hexDistance(n.hex, hex) <= ATLAS_SIGHT) || open.some((n) => hexDistance(n.hex, hex) <= ATLAS_GLIMPSE);

  const tiles: Tile[] = allHexesInGrid(grid).map((p) => {
    const hex = world(p);
    // Fog lies in banks of uneven height, so it reads as hexes of mist and not as a flat sheet.
    if (!lit(hex)) return { q: p.q, r: p.r, biome: "fog", h: BASE_HEIGHT.fog + atlasNoise(seed, "fog", hex, 0.4, memo) * 0.22 };
    return { q: p.q, r: p.r, ...(made.get(posKey(hex)) ?? atlasGround(seed, hex, memo)) };
  });
  const byKey = new Map(tiles.map((t) => [posKey(t), t]));

  // ---------- roads ----------
  // Between the nodes a crew has reached, and out to the ones open to them: trodden wherever the way is over grass.
  const trodden = (t: Tile | undefined): t is Tile => !!t && (t.biome === "plains" || t.biome === "sand");
  const ids = new Map(known.map((n) => [n.id, n]));
  for (const a of known) {
    for (const id of a.links) {
      const b = ids.get(id);
      if (!b || a.id >= b.id) continue;
      const way = [a.hex, ...hexesBetween(a.hex, b.hex), b.hex];
      for (let i = 0; i + 1 < way.length; i++) {
        const side = HARBOR_SIDES.findIndex((d) => way[i].q + d.q === way[i + 1].q && way[i].r + d.r === way[i + 1].r);
        const [from, to] = [byKey.get(posKey(onAtlasMap({ origin }, way[i]))), byKey.get(posKey(onAtlasMap({ origin }, way[i + 1])))];
        if (side < 0 || !trodden(from) || !trodden(to)) continue;
        from.path = (from.path ?? 0) | (1 << side);
        to.path = (to.path ?? 0) | (1 << ((side + 3) % 6));
      }
    }
  }

  // ---------- the places themselves ----------
  const pois: Poi[] = known
    .filter((n) => byKey.has(posKey(onAtlasMap({ origin }, n.hex))))
    .map((n) => ({
      id: `node:${n.id}`,
      kind: n.kind === "harbor" ? "lighthouse" : n.kind === "seacave" ? "cave" : "camp",
      pos: onAtlasMap({ origin }, n.hex),
      hidden: false,
      cleared: n.state !== "open",
      usedBy: [],
      enemies: [],
    }));

  return { map: { grid, tiles, pois }, origin };
}
