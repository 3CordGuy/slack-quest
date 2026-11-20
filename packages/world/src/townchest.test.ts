import { describe, expect, it } from "vitest";
import { STACK_MAX } from "./carry";
import { TOWN_STACK_MAX, TOWN_TAB_CELLS, TOWN_TAB_NAME, cleanTabColor, cleanTabName, gearPutProblem, movedTabs, stackPutProblem, stackSort, tabTakesGear, tabTakesStack, tabUsed, townTabCost } from "./townchest";

describe("the town chest's tabs", () => {
  it("each take their own: a general tab anything, the others only their sort, and gear only the general", () => {
    expect(stackSort("wood")).toBe("material");
    expect(stackSort("lodestone")).toBe("lodestone");
    expect(stackSort("lodestone:hardy2+gilded")).toBe("lodestone");
    expect(stackSort("healing")).toBeNull();
    expect(stackSort(7)).toBeNull();
    for (const kind of ["wood", "lodestone", "lodestone:swift"]) expect(tabTakesStack("general", kind), kind).toBe(true);
    expect(tabTakesStack("general", "healing")).toBe(false);
    expect(tabTakesStack("materials", "wood")).toBe(true);
    expect(tabTakesStack("materials", "lodestone")).toBe(false);
    expect(tabTakesStack("lodestones", "lodestone:swift")).toBe(true);
    expect(tabTakesStack("lodestones", "wood")).toBe(false);
    expect(tabTakesGear("general")).toBe(true);
    expect(tabTakesGear("materials")).toBe(false);
    expect(tabTakesGear("lodestones")).toBe(false);
  });

  it("a general tab holds what fits its squares: gear by its footprint, a square a stack", () => {
    expect(tabUsed([], {})).toBe(0);
    expect(tabUsed([8, 2], { wood: 1, stone: STACK_MAX + 1 })).toBe(13);
    const full = tabUsed([TOWN_TAB_CELLS - 1], {});
    expect(gearPutProblem("general", full, 1)).toBeNull();
    expect(gearPutProblem("general", full, 2)).toMatch(/no room/);
    expect(gearPutProblem("materials", 0, 1)).toMatch(/does not belong/);
    // A stack onto one that has room takes no new square.
    const held = { wood: 5 };
    const used = tabUsed([TOWN_TAB_CELLS - 1], held);
    expect(stackPutProblem("general", used, held, "wood", STACK_MAX - 5)).toBeNull();
    expect(stackPutProblem("general", used, held, "wood", STACK_MAX - 4)).toMatch(/no room/);
    expect(stackPutProblem("general", used, held, "stone", 1)).toMatch(/no room/);
    expect(stackPutProblem("general", 0, {}, "healing", 1)).toMatch(/does not belong/);
    for (const n of [0, -2, 1.5, NaN, 1e9, "3"]) expect(stackPutProblem("general", 0, {}, "wood", n), String(n)).toMatch(/not an amount/);
  });

  it("a materials or lodestones tab has no squares to run out of, only so many of each thing", () => {
    expect(stackPutProblem("materials", 0, { wood: 4000 }, "wood", 5000)).toBeNull();
    expect(stackPutProblem("materials", 0, { wood: TOWN_STACK_MAX - 1 }, "wood", 2)).toMatch(/holds no more/);
    expect(stackPutProblem("lodestones", 0, {}, "lodestone:hardy", 12)).toBeNull();
    expect(stackPutProblem("lodestones", 0, {}, "wood", 1)).toMatch(/does not belong/);
  });

  it("cost more gold each, and are named as typed, tidied", () => {
    expect(townTabCost(1)).toBeGreaterThan(0);
    expect(townTabCost(3)).toBeGreaterThan(townTabCost(2));
    expect(cleanTabName("  Spare   gear ")).toBe("Spare gear");
    expect(cleanTabName("x".repeat(60))!.length).toBe(TOWN_TAB_NAME);
    for (const bad of ["", "   ", null, 4]) expect(cleanTabName(bad)).toBeNull();
  });

  it("take a colour from the few there are, and stand in the order they are moved into", () => {
    expect(cleanTabColor("teal")).toBe("teal");
    for (const bad of ["#ff0000", "puce", "", null, 3]) expect(cleanTabColor(bad)).toBeNull();
    expect(movedTabs([1, 2, 3, 4], 4, 0)).toEqual([4, 1, 2, 3]);
    expect(movedTabs([1, 2, 3, 4], 1, 2)).toEqual([2, 3, 1, 4]);
    expect(movedTabs([1, 2, 3, 4], 2, 99)).toEqual([1, 3, 4, 2]);
    expect(movedTabs([1, 2, 3, 4], 2, -5)).toEqual([2, 1, 3, 4]);
    expect(movedTabs([1, 2, 3], 3, 2)).toEqual([1, 2, 3]);
    expect(movedTabs([1, 2, 3], 9, 0)).toBeNull();
    expect(movedTabs([1, 2, 3], 1, 1.5)).toBeNull();
    expect(movedTabs([1, 2, 3], 1, "0")).toBeNull();
  });
});
