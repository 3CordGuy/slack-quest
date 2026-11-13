import { describe, expect, it } from "vitest";
import { HARBOR_APOTHECARY, HARBOR_GALLEY, HARBOR_GATHER, HARBOR_LIGHTHOUSE, HARBOR_WRECK, HARBOR_SMITHY, HARBOR_GRID, HARBOR_BOARD, HARBOR_PIERS, HARBOR_PLOTS, HARBOR_RING, HARBOR_SHOP, HARBOR_SPAWN, HARBOR_WORKS, generateHarbor, harborPath, tileAt } from "./index";

describe("harbor map", () => {
  const map = generateHarbor();

  it("is the same every time", () => {
    expect(generateHarbor()).toEqual(map);
  });

  it("puts piers on dock tiles with open water beyond them", () => {
    expect(HARBOR_PIERS).toHaveLength(3);
    for (const pier of HARBOR_PIERS) {
      expect(tileAt(map, pier)!.biome).toBe("dock");
      expect(tileAt(map, { q: pier.q, r: pier.r + 1 })!.biome).toBe("water");
    }
  });

  it("lets a player walk from the plaza to every plot, pier and the notice board", () => {
    expect(HARBOR_PLOTS).toHaveLength(12);
    expect(new Set(HARBOR_PLOTS.map((p) => `${p.q},${p.r}`)).size).toBe(12);
    for (const target of [...HARBOR_PLOTS, ...HARBOR_PIERS, HARBOR_BOARD, HARBOR_SHOP, HARBOR_RING, HARBOR_WORKS, HARBOR_APOTHECARY, HARBOR_SMITHY, HARBOR_GALLEY]) {
      const path = harborPath(map, HARBOR_SPAWN, target);
      expect(path, `${target.q},${target.r}`).not.toBeNull();
      expect(path!.at(-1)).toEqual(target);
      expect(path!.every((p) => tileAt(map, p)!.biome !== "water")).toBe(true);
    }
  });

  it("puts the gathering spots on free, walkable hexes at the edges", () => {
    const used = [...HARBOR_PLOTS, ...HARBOR_PIERS, HARBOR_BOARD, HARBOR_SHOP, HARBOR_RING, HARBOR_SPAWN, HARBOR_APOTHECARY, HARBOR_SMITHY, HARBOR_GALLEY].map((p) => `${p.q},${p.r}`);
    const spots = Object.values(HARBOR_GATHER);
    expect(new Set(spots.map((p) => `${p.q},${p.r}`)).size).toBe(3);
    for (const spot of spots) {
      expect(used).not.toContain(`${spot.q},${spot.r}`);
      expect(tileAt(map, spot)!.biome).not.toBe("water");
      // At the island's edge: the sea is beside each of them.
      const beside = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]].map(([q, r]) => tileAt(map, { q: spot.q + q, r: spot.r + r })?.biome);
      expect(beside).toContain("water");
      expect(harborPath(map, HARBOR_SPAWN, spot)!.at(-1)).toEqual(spot);
    }
    expect(tileAt(map, { q: HARBOR_GATHER.fishing.q, r: HARBOR_GATHER.fishing.r + 1 })!.biome).toBe("water");
    expect(tileAt(map, HARBOR_GATHER.felling)!.biome).toBe("forest");
    expect(tileAt(map, HARBOR_GATHER.quarry)!.biome).toBe("hills");
  });

  it("refuses the sea, off-map hexes and standing still", () => {
    const sea = map.tiles.find((t) => t.biome === "water")!;
    expect(harborPath(map, HARBOR_SPAWN, sea)).toBeNull();
    expect(harborPath(map, HARBOR_SPAWN, { q: 99, r: 99 })).toBeNull();
    expect(harborPath(map, HARBOR_SPAWN, HARBOR_SPAWN)).toBeNull();
  });

  it("is a walled port: each place stands on cobbles, the wall and the sea cannot be crossed", () => {
    const biomes = new Set(map.tiles.map((t) => t.biome));
    for (const b of ["cobble", "mud", "rampart", "water", "dock"]) expect(biomes.has(b as never), b).toBe(true);
    // The places people use stand on cobbles, and only they do.
    for (const pos of [HARBOR_BOARD, HARBOR_SHOP, HARBOR_RING, HARBOR_SPAWN, HARBOR_WORKS, HARBOR_APOTHECARY, HARBOR_SMITHY, HARBOR_GALLEY]) expect(tileAt(map, pos)?.biome).toBe("cobble");
    expect(map.tiles.filter((t) => t.biome === "cobble").length).toBe(9);
    const wall = map.tiles.find((t) => t.biome === "rampart")!;
    expect(harborPath(map, HARBOR_SPAWN, wall)).toBeNull();
    // Rocks and the wreck are out in the water, out of reach.
    const scenery = map.pois.filter((p) => p.kind === "rocks" || p.kind === "wreck");
    expect(scenery.length).toBeGreaterThan(3);
    for (const p of scenery) {
      expect(tileAt(map, p.pos)?.biome).toBe("water");
      expect(harborPath(map, HARBOR_SPAWN, p.pos)).toBeNull();
    }
    // No mooring is fouled by a rock.
    for (const pier of HARBOR_PIERS) expect(scenery.some((p) => p.pos.q === pier.q && p.pos.r === pier.r + 1)).toBe(false);
  });

  it("puts the apothecary beside the market stall and the smithy beside the sparring ring, off the plots", () => {
    const plots = new Set(HARBOR_PLOTS.map((p) => `${p.q},${p.r}`));
    const near = (a: { q: number; r: number }, b: { q: number; r: number }) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.q + a.r - b.q - b.r)) === 1;
    for (const spot of [HARBOR_APOTHECARY, HARBOR_SMITHY]) expect(plots.has(`${spot.q},${spot.r}`)).toBe(false);
    expect(near(HARBOR_APOTHECARY, HARBOR_SHOP)).toBe(true);
    expect(near(HARBOR_SMITHY, HARBOR_RING)).toBe(true);
    expect(map.pois.find((p) => p.id === "apothecary")?.pos).toEqual(HARBOR_APOTHECARY);
    expect(map.pois.find((p) => p.id === "smithy")?.pos).toEqual(HARBOR_SMITHY);
  });

  it("puts the galley on the quay by the piers, off the plots and the other places", () => {
    const taken = [...HARBOR_PLOTS, ...HARBOR_PIERS, HARBOR_BOARD, HARBOR_SHOP, HARBOR_RING, HARBOR_SPAWN, HARBOR_WORKS, HARBOR_APOTHECARY, HARBOR_SMITHY, ...Object.values(HARBOR_GATHER)];
    expect(taken.some((p) => p.q === HARBOR_GALLEY.q && p.r === HARBOR_GALLEY.r)).toBe(false);
    // Down by the water: south of the plaza, a short walk from a pier.
    const dist = (a: { q: number; r: number }, b: { q: number; r: number }) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.q + a.r - b.q - b.r));
    expect(HARBOR_GALLEY.r).toBeGreaterThan(HARBOR_SPAWN.r);
    expect(Math.min(...HARBOR_PIERS.map((p) => dist(p, HARBOR_GALLEY)))).toBeLessThanOrEqual(3);
    expect(map.pois.find((p) => p.id === "galley")).toMatchObject({ kind: "galley", pos: HARBOR_GALLEY });
    // Every pier can still be walked to without crossing the galley.
    for (const pier of HARBOR_PIERS) expect(harborPath(map, HARBOR_SPAWN, pier)!.some((p) => p.q === HARBOR_GALLEY.q && p.r === HARBOR_GALLEY.r)).toBe(false);
  });

  it("is a round island: sea on every side, and hut plots that are not laid out in rows", () => {
    const land = map.tiles.filter((t) => t.biome !== "water" && t.biome !== "dock");
    const col = (t: { q: number; r: number }) => t.q + Math.floor(t.r / 2);
    // No land on the map's border, so the sea goes all the way round.
    for (const t of land) {
      expect(t.r).toBeGreaterThanOrEqual(0);
      expect(t.r).toBeLessThan(HARBOR_GRID.rows - 1);
      expect(col(t)).toBeGreaterThan(0);
      expect(col(t)).toBeLessThan(HARBOR_GRID.cols - 2);
    }
    // About as wide as it is deep (a row is 0.866 of a column).
    const wide = Math.max(...land.map(col)) - Math.min(...land.map(col));
    const deep = (Math.max(...land.map((t) => t.r)) - Math.min(...land.map((t) => t.r))) * 0.866;
    expect(Math.abs(wide - deep)).toBeLessThan(1.5);
    // The plots are scattered: no row holds more than three of them.
    const perRow = new Map<number, number>();
    for (const p of HARBOR_PLOTS) perRow.set(p.r, (perRow.get(p.r) ?? 0) + 1);
    expect(Math.max(...perRow.values())).toBeLessThanOrEqual(3);
    expect(perRow.size).toBeGreaterThanOrEqual(6);
  });

  it("stands the lighthouse on the south-east point over the wreck, reachable and clear of every other place", () => {
    const taken = [...HARBOR_PLOTS, ...HARBOR_PIERS, HARBOR_BOARD, HARBOR_SHOP, HARBOR_RING, HARBOR_SPAWN, HARBOR_WORKS, HARBOR_APOTHECARY, HARBOR_SMITHY, HARBOR_GALLEY, ...Object.values(HARBOR_GATHER)];
    expect(taken.some((p) => p.q === HARBOR_LIGHTHOUSE.q && p.r === HARBOR_LIGHTHOUSE.r)).toBe(false);
    expect(map.pois.find((p) => p.id === "lighthouse")).toMatchObject({ kind: "lighthouse", pos: HARBOR_LIGHTHOUSE });
    // On the shore, not the plaza: bare ground with the sea beside it, and the wreck one hex off.
    expect(tileAt(map, HARBOR_LIGHTHOUSE)!.biome).toBe("mud");
    const dist = (a: { q: number; r: number }, b: { q: number; r: number }) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.q + a.r - b.q - b.r));
    expect(dist(HARBOR_LIGHTHOUSE, HARBOR_WRECK)).toBe(1);
    expect(map.tiles.some((t) => t.biome === "water" && dist(t, HARBOR_LIGHTHOUSE) === 1)).toBe(true);
    expect(harborPath(map, HARBOR_SPAWN, HARBOR_LIGHTHOUSE)!.at(-1)).toEqual(HARBOR_LIGHTHOUSE);
  });
});
