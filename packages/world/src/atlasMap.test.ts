import { describe, expect, it } from "vitest";
import { allHexesInGrid, hexDistance, posKey } from "@gantt-quest/core";
import { ATLAS_HOME, ATLAS_SPACING, atlasNodeById, atlasView, type AtlasNodeView } from "./atlas";
import { ATLAS_GLIMPSE, ATLAS_SIGHT, atlasGround, atlasWorld, onAtlasMap } from "./atlasMap";
import type { Tile } from "./map";

const SEEDS = ["CREWAA", "CREWBB", "ZGHPQH"];
/** A chart with the first few landfalls cleared, each a route on from the last. */
function charted(seed: string, steps: number): AtlasNodeView[] {
  const cleared = new Set<string>();
  let from = ATLAS_HOME;
  for (let i = 0; i < steps; i++) {
    const next = atlasNodeById(seed, from)!.links.find((id) => id !== ATLAS_HOME && !cleared.has(id) && atlasNodeById(seed, id)!.ring >= atlasNodeById(seed, from)!.ring)!;
    cleared.add(next);
    from = next;
  }
  return atlasView(seed, cleared);
}
const tileOf = (world: ReturnType<typeof atlasWorld>, node: AtlasNodeView): Tile | undefined => {
  const at = onAtlasMap(world, node.hex);
  return world.map.tiles.find((t) => t.q === at.q && t.r === at.r);
};

describe("the world the chart lies on", () => {
  it("is the same land for the same seed, and other land for another", () => {
    const spots = [{ q: 0, r: 0 }, { q: 7, r: -3 }, { q: -12, r: 20 }, { q: 31, r: 4 }, { q: -40, r: -9 }, { q: 3, r: 55 }];
    for (const seed of SEEDS) for (const p of spots) expect(atlasGround(seed, p)).toEqual(atlasGround(seed, p));
    const lie = (seed: string) => Array.from({ length: 400 }, (_, i) => atlasGround(seed, { q: (i % 20) * 3 - 30, r: Math.floor(i / 20) * 3 - 30 }).biome).join(" ");
    expect(lie("CREWAA")).not.toBe(lie("CREWBB"));
  });

  it("has seas, sand, grass, forest and hills, with the sea and the land each in a good share", () => {
    for (const seed of SEEDS) {
      const count: Record<string, number> = {};
      for (let q = -60; q <= 60; q += 2) for (let r = -60; r <= 60; r += 2) count[atlasGround(seed, { q, r }).biome] = (count[atlasGround(seed, { q, r }).biome] ?? 0) + 1;
      const total = Object.values(count).reduce((a, b) => a + b, 0);
      expect(Object.keys(count).sort(), seed).toEqual(["forest", "hills", "plains", "sand", "water"]);
      expect(count.water / total, seed).toBeGreaterThan(0.08);
      expect(count.water / total, seed).toBeLessThan(0.5);
      for (const kind of ["forest", "plains", "sand", "hills"]) expect(count[kind] / total, `${seed} ${kind}`).toBeGreaterThan(0.03);
    }
  });

  it("puts every node a few hexes from its neighbours, never two on one hex", () => {
    for (const seed of SEEDS) {
      const nodes = charted(seed, 4);
      for (const a of nodes) {
        for (const b of nodes) {
          if (a.id < b.id) expect(hexDistance(a.hex, b.hex), `${a.id} ${b.id}`).toBeGreaterThanOrEqual(ATLAS_SPACING - 2);
        }
      }
    }
  });
});

describe("the window a crew is shown", () => {
  it("holds every node they can see, well inside its edge, on a map with a tile for every hex", () => {
    for (const seed of SEEDS) {
      for (const steps of [0, 2, 5]) {
        const nodes = charted(seed, steps);
        const world = atlasWorld(seed, nodes);
        expect(atlasWorld(seed, nodes)).toEqual(world);
        const { cols, rows } = world.map.grid;
        expect(world.map.tiles.map(posKey)).toEqual(allHexesInGrid(world.map.grid).map(posKey));
        for (const n of nodes) {
          const at = onAtlasMap(world, n.hex);
          const col = at.q + Math.floor(at.r / 2);
          expect(col, n.id).toBeGreaterThanOrEqual(5);
          expect(col, n.id).toBeLessThanOrEqual(cols - 6);
          expect(at.r, n.id).toBeGreaterThanOrEqual(5);
          expect(at.r, n.id).toBeLessThanOrEqual(rows - 6);
        }
      }
    }
  });

  it("gives every node they know somewhere to stand, and a place on the map", () => {
    for (const seed of SEEDS) {
      const nodes = charted(seed, 5);
      const world = atlasWorld(seed, nodes);
      for (const n of nodes) {
        const tile = tileOf(world, n)!;
        // Somewhere a route leads and nothing more: the land there may be in sight, but nothing is made of it.
        if (n.state === "fogged") {
          expect(world.map.pois.some((p) => p.id === `node:${n.id}`), n.id).toBe(false);
          continue;
        }
        expect(["plains", "sand"], `${n.id} on ${tile.biome}`).toContain(tile.biome);
        expect(tile.blocker, n.id).toBeUndefined();
        const poi = world.map.pois.find((p) => p.id === `node:${n.id}`)!;
        expect(poi.pos).toEqual(onAtlasMap(world, n.hex));
        expect(poi.kind).toBe(n.kind === "harbor" ? "lighthouse" : n.kind === "seacave" ? "cave" : "camp");
        expect(poi.cleared).toBe(n.state !== "open");
      }
      expect(world.map.pois).toHaveLength(nodes.filter((n) => n.state !== "fogged").length);
    }
  });

  it("lifts the fog round the Harbor and what is cleared, a little round what is open, and nowhere else", () => {
    for (const seed of SEEDS) {
      const nodes = charted(seed, 3);
      const world = atlasWorld(seed, nodes);
      const reached = nodes.filter((n) => n.state === "harbor" || n.state === "cleared");
      const open = nodes.filter((n) => n.state === "open");
      let fogged = 0;
      for (const t of world.map.tiles) {
        const hex = { q: t.q + world.origin.q, r: t.r + world.origin.r };
        const seen = reached.some((n) => hexDistance(n.hex, hex) <= ATLAS_SIGHT) || open.some((n) => hexDistance(n.hex, hex) <= ATLAS_GLIMPSE);
        expect(t.biome === "fog", posKey(t)).toBe(!seen);
        if (!seen) fogged++;
      }
      // The window has a margin of the unknown all round it.
      expect(fogged / world.map.tiles.length, seed).toBeGreaterThan(0.25);
      expect(fogged / world.map.tiles.length, seed).toBeLessThan(0.9);
    }
  });

  it("treads roads between the nodes they have reached, on grass and sand only, each step joined both ways", () => {
    const SIDES = [{ q: 1, r: -1 }, { q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 }, { q: -1, r: 0 }, { q: 0, r: -1 }];
    let roads = 0;
    for (const seed of SEEDS) {
      const world = atlasWorld(seed, charted(seed, 4));
      const byKey = new Map(world.map.tiles.map((t) => [posKey(t), t]));
      for (const t of world.map.tiles) {
        if (!t.path) continue;
        roads++;
        expect(["plains", "sand"], posKey(t)).toContain(t.biome);
        SIDES.forEach((d, side) => {
          if (!(t.path! & (1 << side))) return;
          const next = byKey.get(posKey({ q: t.q + d.q, r: t.r + d.r }))!;
          expect(next.path! & (1 << ((side + 3) % 6)), `${posKey(t)} side ${side}`).toBeGreaterThan(0);
        });
      }
      // The Harbor's own hex is on a road out.
      const home = byKey.get(posKey(onAtlasMap(world, { q: 0, r: 0 })))!;
      expect(home.biome).toBe("plains");
      expect(home.path).toBeGreaterThan(0);
    }
    expect(roads).toBeGreaterThan(20);
  });

  it("keeps to a size it can be drawn at, however much has been cleared", () => {
    const seed = "CREWAA";
    // Everything within nine rings cleared: far more than fits.
    const cleared = new Set<string>();
    for (let q = -9; q <= 9; q++) for (let r = -9; r <= 9; r++) if ((Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2 <= 9 && (q || r)) cleared.add(`${q},${r}`);
    const world = atlasWorld(seed, atlasView(seed, cleared));
    expect(world.map.grid.cols).toBeLessThanOrEqual(96);
    expect(world.map.grid.rows).toBeLessThanOrEqual(84);
    expect(world.map.tiles).toHaveLength(allHexesInGrid(world.map.grid).length);
  });
});
