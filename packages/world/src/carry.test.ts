// The carry limit and where gear goes when the pack is full.

import { STARTING_STATS } from "@gantt-quest/core";
import { describe, expect, it } from "vitest";
import { CARRY_BASE, addStats, carryLimit, carryProblem, carryRoom, lootPlace, lootPlaceText, storeProblem, takeProblem, tradeProblem, type TradeOffer } from "./index";

describe("carryLimit", () => {
  it("is a base plus one slot per point of Strength", () => {
    expect(carryLimit({ str: 0 })).toBe(CARRY_BASE);
    expect(carryLimit({ str: 4 })).toBe(CARRY_BASE + 4);
    expect(carryLimit({ str: 9 })).toBe(CARRY_BASE + 9);
  });

  it("counts Strength from gear as well as the base", () => {
    const base = STARTING_STATS.staff_sage;
    expect(carryLimit(addStats(base, { str: 2 }))).toBe(carryLimit(base) + 2);
  });

  it("never goes below the base, and ignores fractions", () => {
    expect(carryLimit({ str: -3 })).toBe(CARRY_BASE);
    expect(carryLimit({ str: 5.9 })).toBe(CARRY_BASE + 5);
  });

  it("lets a starting Paladin carry noticeably more than a Sage", () => {
    const paladin = carryLimit(STARTING_STATS.qa_paladin);
    const sage = carryLimit(STARTING_STATS.staff_sage);
    expect(paladin - sage).toBeGreaterThanOrEqual(4);
    expect(paladin / sage).toBeGreaterThan(1.5);
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
    const offer: TradeOffer = { to: "b", give: { gold: 0, resources: {}, items: [5] }, ask: { gold: 0, resources: {} } };
    const giver = { gold: 0, resources: {}, items: [{ id: 5, equipped: false, stored: true, name: "Old Ring" }] };
    expect(tradeProblem(offer, { from: "a", giver })).toMatch(/Old Ring is in storage at home/);
    expect(tradeProblem(offer, { from: "a", giver, giverName: "Mira" })).toMatch(/Mira has put Old Ring in storage/);
  });
});
