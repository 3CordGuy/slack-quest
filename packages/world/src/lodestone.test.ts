import { describe, expect, it } from "vitest";
import { atlasNode, atlasTier, nodeOptions, type AtlasNode } from "./atlas";
import { PLAIN_STONE_COST, STONE_MODS, cleanStone, needsStone, rollStone, stoneChance, stoneItem, stoneKey, stoneName, stoneOfItem, stoneOn } from "./lodestone";
import { makeRng } from "./rng";
import { MAX_MODS, ZONE_MODS, ZONE_MOD_IDS, bountyPay, modsOf, type ZoneModId } from "./zone";

const place = (mods: ZoneModId[], kind: AtlasNode["kind"] = "landfall") => ({ mods, kind });

describe("a lodestone", () => {
  it("is the list of what it carries, in the modifiers' own order, however it was written down", () => {
    expect(cleanStone(["savage", "tangled"])).toEqual(["tangled", "savage"]);
    expect(cleanStone("savage+tangled")).toEqual(["tangled", "savage"]);
    expect(stoneKey(cleanStone("swift+hardy+craggy")!)).toBe("craggy+hardy+swift");
    // A plain one carries nothing.
    expect(cleanStone("")).toEqual([]);
    expect(cleanStone([])).toEqual([]);
    // Not a stone: nothing at all, too much, something unknown, the same thing twice, two kinds of ground.
    for (const bad of [null, undefined, 7, "tangled+craggy+hardy+swift", "tangled+rainy", "hardy+hardy", "fouled+frozen", ["hardy", 3]]) expect(cleanStone(bad), JSON.stringify(bad)).toBeNull();
  });

  it("is an item in a pack: one kind for the plain ones, and one for each thing a stone can carry", () => {
    expect(stoneItem([])).toBe("lodestone");
    expect(stoneItem(["tangled", "savage"])).toBe("lodestone:tangled+savage");
    expect(stoneOfItem("lodestone")).toEqual([]);
    expect(stoneOfItem("lodestone:savage+tangled")).toEqual(["tangled", "savage"]);
    for (const other of ["healing", "lodestone:", "lodestone:rainy", "lodestones", 4, null]) expect(stoneOfItem(other), String(other)).toBeNull();
    // A plain one can always be cut, from what a hero can gather.
    expect(Object.values(PLAIN_STONE_COST).every((n) => n > 0)).toBe(true);
  });

  it("is needed to set out for anywhere but the places beside the Harbor", () => {
    expect(needsStone({ ring: 0, kind: "harbor" })).toBe(false);
    expect(needsStone({ ring: 1, kind: "landfall" })).toBe(false);
    expect(needsStone({ ring: 2, kind: "landfall" })).toBe(true);
    expect(needsStone({ ring: 9, kind: "lair" })).toBe(true);
  });

  it("is named for how much it carries", () => {
    expect(stoneName([])).toBe("Plain lodestone");
    expect(stoneName(["hardy"])).toBe("Dull lodestone");
    expect(stoneName(["tangled", "hardy"])).toBe("Bright lodestone");
    expect(stoneName(["tangled", "hardy", "swift"])).toBe("Singing lodestone");
  });

  it("is found carrying one modifier near the Harbor and up to three far out, more often the further out", () => {
    for (const [tier, most] of [[1, 1], [3, 1], [5, 2], [7, 2], [9, 3], [30, 3]] as const) {
      const sizes = new Set<number>();
      for (let i = 0; i < 300; i++) {
        const stone = rollStone(makeRng(i * 7 + tier), tier);
        expect(cleanStone(stone), `${tier}: ${stone}`).toEqual(stone);
        sizes.add(stone.length);
      }
      expect(Math.max(...sizes), `tier ${tier}`).toBe(most);
      expect(Math.min(...sizes), `tier ${tier}`).toBe(Math.max(1, most - 1));
    }
    expect(stoneChance(1)).toBeLessThan(stoneChance(6));
    expect(stoneChance(1)).toBeGreaterThanOrEqual(0.5);
    expect(stoneChance(400)).toBeLessThanOrEqual(0.9);
    expect(STONE_MODS).toBe(3);
  });
});

describe("setting a lodestone into a place", () => {
  it("adds what the stone carries to what the place has", () => {
    expect(stoneOn(place([]), ["tangled", "hardy"])).toEqual({ added: ["tangled", "hardy"], mods: ["tangled", "hardy"] });
    expect(stoneOn(place(["craggy"]), ["hardy"])).toEqual({ added: ["hardy"], mods: ["craggy", "hardy"] });
    // A plain one adds nothing.
    expect(stoneOn(place(["craggy"]), [])).toEqual({ added: [], mods: ["craggy"] });
  });

  it("does not take twice, nor lay a second kind of ground over the first, nor load a place past what it can carry", () => {
    expect(stoneOn(place(["hardy"]), ["hardy", "swift"]).added).toEqual(["swift"]);
    expect(stoneOn(place(["fouled"]), ["frozen", "savage"]).added).toEqual(["savage"]);
    const full = ZONE_MOD_IDS.filter((id) => ZONE_MODS[id].kind === "enemy").slice(0, MAX_MODS);
    expect(stoneOn(place(full.slice(0, 3)), ["tangled", "craggy"]).added).toEqual(["tangled"]);
    expect(stoneOn(place(full), ["tangled"]).added).toEqual([]);
    expect(stoneOn(place(["fouled"]), ["frozen"])).toEqual({ added: [], mods: ["fouled"] });
  });

  it("under the earth takes only what changes the enemy", () => {
    expect(stoneOn(place([], "seacave"), ["tangled", "hardy"]).added).toEqual(["hardy"]);
    expect(stoneOn(place([], "seacave"), ["tangled", "fouled"]).added).toEqual([]);
  });

  it("makes the place's map with the stone's modifiers on it, and its bounty the richer", () => {
    const seed = "CREWAA";
    const node = atlasNode(seed, { q: 2, r: 1 });
    const stone: ZoneModId[] = ["hardy", "numerous"];
    const { added, mods } = stoneOn(node, stone);
    expect(added.length).toBeGreaterThan(0);
    const plain = nodeOptions(seed, node, 2);
    const set = nodeOptions(seed, node, 2, added);
    expect(set.mods).toEqual(mods);
    expect(modsOf(set).pay).toBeGreaterThan(modsOf(plain).pay);
    expect(bountyPay(set.tier!, modsOf(set).pay).xp).toBeGreaterThan(bountyPay(plain.tier!, modsOf(plain).pay).xp);
    // Everything else about the map is as it was.
    expect({ ...set, mods: undefined }).toEqual({ ...plain, mods: undefined });
  });
});

describe("a lair's bounty", () => {
  it("is paid as a place some rings further out", () => {
    expect(atlasTier({ ring: 4, kind: "lair" })).toBeGreaterThan(atlasTier({ ring: 4, kind: "landfall" }));
    expect(atlasTier({ ring: 0, kind: "landfall" })).toBe(1);
  });
});
