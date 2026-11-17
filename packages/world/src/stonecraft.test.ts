import { describe, expect, it } from "vitest";
import { RESOURCE_KINDS } from "./hut";
import { STONE_MODS, cleanStone, type Lodestone } from "./lodestone";
import { makeRng } from "./rng";
import { ATTUNE_MATERIALS, FUSE_COUNT, attuneCost, attuneProblem, attuned, fuse, fuseProblem, reroll, rerollCost, rerollProblem } from "./stonecraft";
import { ZONE_MODS, ZONE_MOD_IDS } from "./zone/mods";

describe("fusing lodestones", () => {
  it("takes three that carry the same number of things, and less than a stone can", () => {
    expect(FUSE_COUNT).toBe(3);
    expect(fuseProblem([[], [], []])).toBeNull();
    expect(fuseProblem([["hardy"], ["swift"], ["hardy"]])).toBeNull();
    expect(fuseProblem([[], []])).toMatch(/takes 3/);
    expect(fuseProblem([[], [], [], []])).toMatch(/takes 3/);
    expect(fuseProblem([[], ["hardy"], []])).toMatch(/same number/);
    const full: Lodestone = ["tangled", "hardy", "swift"];
    expect(fuseProblem([full, full, full])).toMatch(/no more/);
  });

  it("makes one that carries one more, out of what the three carried so far as that goes", () => {
    for (let i = 0; i < 200; i++) {
      const rng = makeRng(i * 31 + 5);
      // Three plain ones: something, from nothing.
      const one = fuse(rng, [[], [], []]);
      expect(one.length).toBe(1);
      expect(cleanStone(one)).toEqual(one);
      // Three that carry one thing each, all different: two of the three.
      const two = fuse(rng, [["hardy"], ["swift"], ["tangled"]]);
      expect(two.length).toBe(2);
      expect(two.every((id) => ["hardy", "swift", "tangled"].includes(id))).toBe(true);
      // Three alike: what they carried, and one thing more.
      const more = fuse(rng, [["hardy"], ["hardy"], ["hardy"]]);
      expect(more.length).toBe(2);
      expect(more).toContain("hardy");
      // Never two kinds of ground, though all three brought one.
      const ground = fuse(rng, [["fouled", "hardy"], ["frozen", "swift"], ["slick", "savage"]]);
      expect(ground.length).toBe(3);
      expect(cleanStone(ground)).toEqual(ground);
      expect(ground.filter((id) => ZONE_MODS[id].hazard).length).toBeLessThanOrEqual(1);
    }
  });
});

describe("attuning a lodestone", () => {
  it("adds one chosen thing to a stone with room for it", () => {
    expect(attuneProblem([], "hardy")).toBeNull();
    expect(attuned([], "hardy")).toEqual(["hardy"]);
    expect(attuned(["swift"], "tangled")).toEqual(["tangled", "swift"]);
    expect(attuneProblem(["hardy"], "hardy")).toMatch(/already/);
    expect(attuneProblem(["tangled", "hardy", "swift"], "savage")).toMatch(/all a lodestone can/);
    expect(attuneProblem(["fouled"], "frozen")).toMatch(/kind of ground/);
    expect(attuneProblem([], "rainy")).toMatch(/no such thing/);
    expect(attuneProblem([], 4)).toMatch(/no such thing/);
  });

  it("costs the material each thing is made of, and more the more the stone carries", () => {
    for (const id of ZONE_MOD_IDS) {
      const kinds = Object.keys(ATTUNE_MATERIALS[id]);
      expect(kinds.length, id).toBeGreaterThan(0);
      expect(kinds.every((k) => (RESOURCE_KINDS as readonly string[]).includes(k)), id).toBe(true);
      const [first, second, third] = [attuneCost([], id), attuneCost(["tangled"].filter((m) => m !== id) as Lodestone, id), attuneCost(["tangled", "craggy"].filter((m) => m !== id) as Lodestone, id)];
      expect(first.gold).toBeGreaterThan(0);
      expect(second.gold).toBeGreaterThanOrEqual(first.gold);
      expect(third.gold).toBeGreaterThanOrEqual(second.gold);
      for (const kind of kinds) expect(first.resources[kind as keyof typeof first.resources]).toBe(ATTUNE_MATERIALS[id][kind as keyof typeof first.resources]);
    }
    expect(attuneCost(["tangled"], "hardy")).toEqual({ gold: attuneCost([], "hardy").gold * 2, resources: { fur: ATTUNE_MATERIALS.hardy.fur! * 2 } });
  });
});

describe("rerolling a lodestone", () => {
  it("gives one that carries as much, and never just what it had; a plain one has nothing to change", () => {
    expect(rerollProblem([])).toMatch(/nothing to change/);
    expect(rerollProblem(["hardy"])).toBeNull();
    expect(rerollCost(["hardy", "swift"])).toBeGreaterThan(rerollCost(["hardy"]));
    for (let size = 1; size <= STONE_MODS; size++) {
      const stone = ZONE_MOD_IDS.filter((id) => !ZONE_MODS[id].hazard).slice(0, size);
      for (let i = 0; i < 150; i++) {
        const made = reroll(makeRng(i * 17 + size), stone);
        expect(made.length).toBe(size);
        expect(cleanStone(made)).toEqual(made);
        expect(made.join("+")).not.toBe(stone.join("+"));
      }
    }
  });
});
