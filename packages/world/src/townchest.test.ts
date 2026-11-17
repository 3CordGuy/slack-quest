import { describe, expect, it } from "vitest";
import { STACK_MAX } from "./carry";
import { TOWN_CHEST_COLS, TOWN_CHEST_ROWS, TOWN_CHEST_ROWS_MAX, CHEST_TABS, chestPutProblem, chestRowCost, chestTab, chestTakes, chestUsed } from "./townchest";

describe("the town chest", () => {
  it("has a tab for lodestones and one for materials, and each takes only its own", () => {
    expect(CHEST_TABS.map((t) => t.id)).toEqual(["lodestones", "materials"]);
    expect(chestTab("lodestones")).toBe("lodestones");
    expect(chestTab("gear")).toBeNull();
    expect(chestTakes("lodestones", "lodestone")).toBe(true);
    expect(chestTakes("lodestones", "lodestone:hardy+swift")).toBe(true);
    expect(chestTakes("lodestones", "wood")).toBe(false);
    expect(chestTakes("lodestones", "healing")).toBe(false);
    expect(chestTakes("materials", "wood")).toBe(true);
    expect(chestTakes("materials", "lodestone")).toBe(false);
    expect(chestTakes("materials", 7)).toBe(false);
  });

  it("holds stacks, a square each, and no more than its rows have squares for", () => {
    expect(chestUsed({})).toBe(0);
    expect(chestUsed({ wood: 1, stone: STACK_MAX, iron: STACK_MAX + 1 })).toBe(4);
    const full: Record<string, number> = { wood: STACK_MAX * (TOWN_CHEST_ROWS * TOWN_CHEST_COLS - 1), stone: 5 };
    // Onto a stack that has room: no new square needed.
    expect(chestPutProblem("materials", TOWN_CHEST_ROWS, full, "stone", STACK_MAX - 5)).toBeNull();
    expect(chestPutProblem("materials", TOWN_CHEST_ROWS, full, "stone", STACK_MAX - 4)).toMatch(/no room/);
    expect(chestPutProblem("materials", TOWN_CHEST_ROWS, full, "iron", 1)).toMatch(/no room/);
    // A row more, and it goes.
    expect(chestPutProblem("materials", TOWN_CHEST_ROWS + 1, full, "iron", 1)).toBeNull();
    expect(chestPutProblem("materials", TOWN_CHEST_ROWS, {}, "lodestone", 1)).toMatch(/does not belong/);
    for (const n of [0, -2, 1.5, NaN, 1e9]) expect(chestPutProblem("materials", TOWN_CHEST_ROWS, {}, "wood", n), String(n)).toMatch(/not an amount/);
  });

  it("is made bigger a row at a time, each row dearer than the last, up to so many", () => {
    let last = 0;
    for (let rows = TOWN_CHEST_ROWS; rows < TOWN_CHEST_ROWS_MAX; rows++) {
      const cost = chestRowCost(rows)!;
      expect(cost.gold).toBeGreaterThan(last);
      expect(Object.values(cost.resources).every((n) => n! > 0)).toBe(true);
      last = cost.gold;
    }
    expect(chestRowCost(TOWN_CHEST_ROWS_MAX)).toBeNull();
  });
});
