// The Haunted Caverns' layout: carved fresh every time, with things lurking,
// chests to open and now and then a locked door. A delve played on it is
// tested in zone/zone.test.ts.

import { describe, expect, it } from "vitest";
import { hexDistance, posKey } from "@gantt-quest/core";
import { generateCaverns, reachable, tileAt, type WorldMap } from "./index";

const poiById = (map: WorldMap, id: string) => map.pois.find((p) => p.id === id);
const landing = (map: WorldMap) => poiById(map, "landing")!.pos;

describe("the caverns map", () => {
  it("is cave floor in living rock, with a hoard in the deepest chamber and things lurking on the way", () => {
    for (let i = 0; i < 60; i++) {
      const map = generateCaverns(`cave-${i}`);
      for (const t of map.tiles) expect(["cave", "rock", "gate"]).toContain(t.biome);
      const lair = poiById(map, "lair")!;
      const hoard = poiById(map, "hoard")!;
      expect(lair.enemies[0]).toBe("haunt");
      expect(hoard).toMatchObject({ kind: "cache", loot: "hoard", guard: "lair" });
      expect(hexDistance(hoard.pos, lair.pos)).toBe(1);
      expect(map.pois.filter((p) => p.kind === "camp").length).toBeGreaterThanOrEqual(2);
      expect(map.pois.filter((p) => p.kind === "cache" && p.loot === "chest").length).toBeGreaterThanOrEqual(1);
      expect(map.pois.filter((p) => p.kind === "pickup").length).toBeGreaterThanOrEqual(5);
    }
  });

  it("can be walked end to end, but for what is shut behind a locked door", () => {
    for (let i = 0; i < 60; i++) {
      const map = generateCaverns(`walk-${i}`);
      const shut = reachable(map, landing(map));
      const open = reachable(map, landing(map), Infinity, (t) => (t.biome === "rock" ? Infinity : 1));
      const gates = map.pois.filter((p) => p.kind === "gate");
      for (const p of map.pois) {
        expect(open.has(posKey(p.pos)), `${p.id} in walk-${i}`).toBe(true);
        if (p.kind === "gate") continue;
        // Only a strongbox, or the deepest chamber when it is the one shut away, lies behind a door.
        if (!shut.has(posKey(p.pos))) expect(p.loot === "vault" || ((p.id === "lair" || p.id === "hoard") && gates.length > 0), `${p.id} in walk-${i}`).toBe(true);
      }
      // A strongbox is only ever behind a door, and each door really does keep it shut.
      for (const vault of map.pois.filter((p) => p.loot === "vault")) expect(shut.has(posKey(vault.pos))).toBe(false);
    }
  });

  it("has a locked door now and then, and a key to each on the near side", () => {
    let doors = 0;
    let none = 0;
    for (let i = 0; i < 60; i++) {
      const map = generateCaverns(`door-${i}`);
      const gates = map.pois.filter((p) => p.kind === "gate");
      expect(gates.length).toBeLessThanOrEqual(2);
      for (const g of gates) expect(tileAt(map, g.pos)!.biome).toBe("gate");
      const near = reachable(map, landing(map));
      const keys = map.pois.filter((p) => p.key);
      expect(keys.length).toBeLessThanOrEqual(gates.length);
      for (const k of keys) expect(near.has(posKey(k.pos)), `key at ${k.id} in door-${i}`).toBe(true);
      doors += gates.length;
      if (gates.length === 0) none += 1;
    }
    // Not every delve, but most.
    expect(doors).toBeGreaterThan(40);
    expect(none).toBeGreaterThan(5);
  });

  it("is carved differently every time, and the same from the same seed", () => {
    expect(generateCaverns("same")).toEqual(generateCaverns("same"));
    const shapes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const map = generateCaverns(`shape-${i}`);
      shapes.add(map.tiles.filter((t) => t.biome !== "rock").map((t) => posKey(t)).sort().join(" "));
    }
    expect(shapes.size).toBe(20);
  });
});
