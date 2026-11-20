// What a searched cache gives for the hut (drops.ts). What a zone hands out
// with it is in zone/looting.test.ts.

import { describe, expect, it } from "vitest";
import { CACHE_DECOR, CACHE_RESOURCES, FOUND_BLUEPRINTS, FURNISHINGS, RESOURCE_KINDS, cacheDrops, makeRng, type ResourceKind, type Resources } from "./index";

const kindsOf = (r: Resources) => Object.keys(r) as ResourceKind[];
const units = (r: Resources) => Object.values(r).reduce((a, n) => a + (n ?? 0), 0);

describe("cache drops", () => {
  it("only name real materials, blueprints that must be found, and furniture", () => {
    for (const r of CACHE_RESOURCES) expect(RESOURCE_KINDS).toContain(r);
    expect(FOUND_BLUEPRINTS.length).toBeGreaterThan(0);
    for (const id of FOUND_BLUEPRINTS) expect(FURNISHINGS[id]?.needsBlueprint, id).toBe(true);
    for (const id of CACHE_DECOR) expect(FURNISHINGS[id]?.kind, id).toBe("furniture");
  });

  it("are deterministic per seed and only name real things", () => {
    let blueprints = 0;
    let decor = 0;
    const N = 4000;
    for (let seed = 1; seed <= N; seed++) {
      const d = cacheDrops(makeRng(seed));
      expect(cacheDrops(makeRng(seed))).toEqual(d);
      for (const k of kindsOf(d.resources)) expect(CACHE_RESOURCES).toContain(k);
      expect(units(d.resources)).toBeGreaterThanOrEqual(2);
      expect(units(d.resources)).toBeLessThanOrEqual(4);
      if (d.blueprint) {
        blueprints++;
        expect(FOUND_BLUEPRINTS).toContain(d.blueprint);
      }
      if (d.furnishing) {
        decor++;
        expect(CACHE_DECOR).toContain(d.furnishing.defId);
        expect(d.furnishing.label).toBe(FURNISHINGS[d.furnishing.defId].name);
      }
    }
    // Both are occasional, and decor is the rarer of the two.
    expect(blueprints).toBeGreaterThan(N * 0.08);
    expect(blueprints).toBeLessThan(N * 0.25);
    expect(decor).toBeGreaterThan(0);
    expect(decor).toBeLessThan(blueprints);
  });

  it("does not hand out a blueprint already found", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const first = cacheDrops(makeRng(seed)).blueprint;
      if (!first) continue;
      expect(cacheDrops(makeRng(seed), [first]).blueprint).not.toBe(first);
      expect(cacheDrops(makeRng(seed), FOUND_BLUEPRINTS).blueprint).toBeUndefined();
    }
  });
});
