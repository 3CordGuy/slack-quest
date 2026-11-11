import { describe, expect, it } from "vitest";
import { HARBOR_BOARD, HARBOR_PIERS, HARBOR_PLOTS, HARBOR_SPAWN, generateHarbor, harborPath, tileAt } from "./index";

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
    for (const target of [...HARBOR_PLOTS, ...HARBOR_PIERS, HARBOR_BOARD]) {
      const path = harborPath(map, HARBOR_SPAWN, target);
      expect(path, `${target.q},${target.r}`).not.toBeNull();
      expect(path!.at(-1)).toEqual(target);
      expect(path!.every((p) => tileAt(map, p)!.biome !== "water")).toBe(true);
    }
  });

  it("refuses the sea, off-map hexes and standing still", () => {
    const sea = map.tiles.find((t) => t.biome === "water")!;
    expect(harborPath(map, HARBOR_SPAWN, sea)).toBeNull();
    expect(harborPath(map, HARBOR_SPAWN, { q: 99, r: 99 })).toBeNull();
    expect(harborPath(map, HARBOR_SPAWN, HARBOR_SPAWN)).toBeNull();
  });
});
