import { describe, expect, it } from "vitest";
import { HARBOR_APOTHECARY, HARBOR_GATHER, HARBOR_SMITHY, HARBOR_GRID, HARBOR_BOARD, HARBOR_PIERS, HARBOR_PLOTS, HARBOR_RING, HARBOR_SHOP, HARBOR_SPAWN, HARBOR_WORKS, generateHarbor, harborPath, tileAt } from "./index";

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
    for (const target of [...HARBOR_PLOTS, ...HARBOR_PIERS, HARBOR_BOARD, HARBOR_SHOP, HARBOR_RING, HARBOR_WORKS, HARBOR_APOTHECARY, HARBOR_SMITHY]) {
      const path = harborPath(map, HARBOR_SPAWN, target);
      expect(path, `${target.q},${target.r}`).not.toBeNull();
      expect(path!.at(-1)).toEqual(target);
      expect(path!.every((p) => tileAt(map, p)!.biome !== "water")).toBe(true);
    }
  });

  it("puts the gathering spots on free, walkable hexes at the edges", () => {
    const used = [...HARBOR_PLOTS, ...HARBOR_PIERS, HARBOR_BOARD, HARBOR_SHOP, HARBOR_RING, HARBOR_SPAWN, HARBOR_APOTHECARY, HARBOR_SMITHY].map((p) => `${p.q},${p.r}`);
    const spots = Object.values(HARBOR_GATHER);
    expect(new Set(spots.map((p) => `${p.q},${p.r}`)).size).toBe(3);
    for (const spot of spots) {
      expect(used).not.toContain(`${spot.q},${spot.r}`);
      expect(tileAt(map, spot)!.biome).not.toBe("water");
      const col = spot.q + Math.floor(spot.r / 2);
      const onShore = tileAt(map, { q: spot.q, r: spot.r + 1 })?.biome === "water";
      expect(col <= 1 || col >= HARBOR_GRID.cols - 2 || onShore).toBe(true);
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
    for (const pos of [HARBOR_BOARD, HARBOR_SHOP, HARBOR_RING, HARBOR_SPAWN, HARBOR_WORKS, HARBOR_APOTHECARY, HARBOR_SMITHY]) expect(tileAt(map, pos)?.biome).toBe("cobble");
    expect(map.tiles.filter((t) => t.biome === "cobble").length).toBe(8);
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
});
