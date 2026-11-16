import { describe, expect, it } from "vitest";
import { posKey } from "@gantt-quest/core";
import { findPath, generateMap, reachable, tileCost } from "./map";

const SEEDS = ["a", "b", "c", "d", "e", "f", "g", "h", "seed1", "x9", "storm", "reef"];

describe("trees and boulders that cannot be walked through", () => {
  it("stand only on forest and hills, never on a place, and cost Infinity to enter", () => {
    for (const seed of SEEDS) {
      const map = generateMap(seed);
      const places = new Set(map.pois.map((p) => posKey(p.pos)));
      for (const t of map.tiles.filter((t) => t.blocker)) {
        expect(t.blocker).toBe(t.biome === "forest" ? "trees" : "boulders");
        expect(["forest", "hills"]).toContain(t.biome);
        expect(places.has(posKey(t))).toBe(false);
        expect(tileCost(t)).toBe(Infinity);
      }
    }
  });

  it("shut nothing off: every hex that could be walked to without them still can be", () => {
    let total = 0;
    for (const seed of SEEDS) {
      const map = generateMap(seed);
      const landing = map.pois.find((p) => p.id === "landing")!.pos;
      const blocked = map.tiles.filter((t) => t.blocker);
      total += blocked.length;
      const now = reachable(map, landing);
      for (const t of blocked) delete t.blocker;
      const before = reachable(map, landing);
      expect(now.size).toBe(before.size - blocked.length);
      for (const p of map.pois) expect(now.has(posKey(p.pos))).toBe(true);
      // No more than about a sixth of the land.
      expect(blocked.length).toBeLessThanOrEqual(Math.round(map.tiles.filter((t) => t.biome !== "water").length * 0.17));
    }
    expect(total).toBeGreaterThan(SEEDS.length * 5);
  });

  it("are walked round, not through", () => {
    for (const seed of SEEDS) {
      const map = generateMap(seed);
      const landing = map.pois.find((p) => p.id === "landing")!.pos;
      for (const p of map.pois) {
        const route = findPath(map, landing, p.pos);
        expect(route).not.toBeNull();
        for (const step of route!.path) expect(map.tiles.find((t) => t.q === step.q && t.r === step.r)!.blocker).toBeUndefined();
      }
    }
  });
});
