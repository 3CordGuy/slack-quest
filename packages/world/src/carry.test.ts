// The carry limit and where gear goes when the pack is full.

import { STARTING_STATS } from "@gantt-quest/core";
import { describe, expect, it } from "vitest";
import { CARRY_BASE, PACK_CELLS, PACK_COLS, PACK_ROWS, SLOT_SIZE, STACK_MAX, WEAPON_SIZE, addStats, itemCells, itemSize, addedSlots, materialSlots, stackSlots, carryLimit, carryProblem, carryRoom, lootPlace, lootPlaceText, storeProblem, takeProblem, sideProblem } from "./index";

describe("the pack", () => {
  it("is the same grid for every hero, whatever their Strength", () => {
    expect(PACK_CELLS).toBe(PACK_COLS * PACK_ROWS);
    expect(carryLimit({ str: 0 })).toBe(PACK_CELLS);
    expect(carryLimit(STARTING_STATS.qa_paladin)).toBe(carryLimit(STARTING_STATS.staff_sage));
    expect(CARRY_BASE).toBe(PACK_CELLS);
  });

  it("gives gear a footprint by its slot, and weapons one by their kind", () => {
    expect(itemSize({ slot: "ring", ref: "ring" })).toEqual({ w: 1, h: 1 });
    expect(itemSize({ slot: "body", ref: "coat" })).toEqual({ w: 2, h: 3 });
    expect(itemSize({ slot: "main_hand", ref: "mace" })).toEqual({ w: 2, h: 3 });
    expect(itemSize({ slot: "main_hand", ref: "greatsword" })).toEqual({ w: 2, h: 4 });
    expect(itemSize({ slot: "main_hand", ref: "daggers" })).toEqual({ w: 1, h: 3 });
    expect(itemCells({ slot: "main_hand", ref: "staff" })).toBe(8);
  });

  it("has no footprint taller or wider than the grid", () => {
    for (const f of [...Object.values(SLOT_SIZE), ...Object.values(WEAPON_SIZE)]) {
      expect(f.h).toBeLessThanOrEqual(PACK_ROWS);
      expect(f.w).toBeLessThanOrEqual(PACK_COLS);
    }
  });

  it("sends loot home when its footprint does not fit, not just when the pack is brim full", () => {
    expect(lootPlace({ carried: 55, limit: 60, hasHome: true, room: 2 }, 6)).toBe("storage");
    expect(lootPlace({ carried: 54, limit: 60, hasHome: true, room: 2 }, 6)).toBe("pack");
  });
});

describe("stacks of materials", () => {
  it("fill one slot per STACK_MAX of a kind", () => {
    expect(stackSlots(0)).toBe(0);
    expect(stackSlots(1)).toBe(1);
    expect(stackSlots(STACK_MAX)).toBe(1);
    expect(stackSlots(STACK_MAX + 1)).toBe(2);
    expect(materialSlots({ wood: 150, stone: 3, gem: 0 })).toBe(3);
  });

  it("only take a new slot when a stack spills over", () => {
    expect(addedSlots(10, 5)).toBe(0);
    expect(addedSlots(0, 5)).toBe(1);
    expect(addedSlots(STACK_MAX - 1, 2)).toBe(1);
  });
});

describe("carryProblem", () => {
  it("allows anything that fits, and adding nothing", () => {
    expect(carryProblem({ carried: 6, limit: 9 }, 3)).toBeNull();
    expect(carryProblem({ carried: 12, limit: 9 }, 0)).toBeNull();
  });

  it("refuses with the numbers when full", () => {
    expect(carryProblem({ carried: 9, limit: 9 }, 1)).toBe("Your pack is full: you carry 9 of 9. Send something to storage first.");
  });

  it("says how much room is left when only some fits", () => {
    expect(carryProblem({ carried: 7, limit: 9 }, 3)).toMatch(/room for 2 more/);
  });

  it("names someone else", () => {
    expect(carryProblem({ carried: 9, limit: 9 }, 1, "Mira")).toMatch(/^Mira's pack is full/);
  });

  it("still refuses when already over the limit, and room is never negative", () => {
    expect(carryProblem({ carried: 11, limit: 9 }, 1)).toMatch(/full/);
    expect(carryRoom({ carried: 11, limit: 9 })).toBe(0);
  });
});

describe("lootPlace: nothing earned is lost", () => {
  it("goes into the pack while there is room", () => {
    expect(lootPlace({ carried: 8, limit: 9, hasHome: true, room: 5 })).toBe("pack");
    expect(lootPlace({ carried: 8, limit: 9, hasHome: false, room: 0 })).toBe("pack");
  });

  it("overflows to a container at home with room", () => {
    expect(lootPlace({ carried: 9, limit: 9, hasHome: true, room: 1 })).toBe("storage");
    expect(lootPlace({ carried: 12, limit: 9, hasHome: true, room: 3 })).toBe("storage");
  });

  it("is carried over the limit with no home, or every container full", () => {
    expect(lootPlace({ carried: 9, limit: 9, hasHome: false, room: 0 })).toBe("overfull");
    expect(lootPlace({ carried: 9, limit: 9, hasHome: true, room: 0 })).toBe("overfull");
  });

  it("tells the player whenever it did not go into the pack", () => {
    expect(lootPlaceText("pack", "Rusty Sword")).toBeNull();
    expect(lootPlaceText("storage", "Rusty Sword")).toMatch(/Rusty Sword was sent to storage at home/);
    expect(lootPlaceText("overfull", "Rusty Sword")).toMatch(/over the limit/);
  });
});

describe("storage", () => {
  it("takes unequipped carried items, only with a home that has room", () => {
    const home = { hasHome: true, room: 3 };
    expect(storeProblem({ equipped: false, stored: false }, home)).toBeNull();
    expect(storeProblem({ equipped: true, stored: false }, home)).toBe("Unequip it first.");
    expect(storeProblem({ equipped: false, stored: true }, home)).toMatch(/already in storage/);
    expect(storeProblem({ equipped: false, stored: false }, { hasHome: false, room: 0 })).toMatch(/no storage yet/);
    expect(storeProblem({ equipped: false, stored: false }, { hasHome: true, room: 0 })).toMatch(/chest at home is full/);
    expect(storeProblem(null, home)).toBe("No such item.");
  });

  it("gives back only what is stored, and only if it fits", () => {
    expect(takeProblem({ stored: true }, { carried: 8, limit: 9 })).toBeNull();
    expect(takeProblem({ stored: true }, { carried: 9, limit: 9 })).toMatch(/full/);
    expect(takeProblem({ stored: false }, { carried: 0, limit: 9 })).toMatch(/not in your storage/);
    expect(takeProblem(null, { carried: 0, limit: 9 })).toMatch(/not in your storage/);
  });
});

describe("trading a stored item", () => {
  it("is refused until it is taken out at home", () => {
    const side = { gold: 0, resources: {}, items: [5] };
    const holder = { gold: 0, resources: {}, items: [{ id: 5, equipped: false, stored: true, name: "Old Ring" }] };
    expect(sideProblem(side, holder)).toMatch(/Old Ring is in storage at home/);
    expect(sideProblem(side, holder, "Mira")).toMatch(/Mira has put Old Ring in storage/);
  });
});
