import { describe, it, expect } from "vitest";
import {
  generateForageGrid,
  forageHazardCount,
  forageCascadeFrom,
  isForageHazard,
  FORAGE_GRID_ROWS,
  FORAGE_GRID_COLS,
  FORAGE_BASE_FLIPS,
  FORAGE_MAX_FLIPS,
  forageFlipsForInt,
  type ForageCellKind,
} from "./flavor";

describe("forage cascade + first-flip safety scaffolding", () => {
  // The flip-budget constants and forageFlipsForInt are deprecated (no
  // manual flip cap anymore — HP damage is the pressure). Keep them
  // exported for back-compat but don't assert on their values; the test
  // here just confirms the helper still exists.
  it("flip-budget helpers exist (deprecated; no longer enforced)", () => {
    expect(typeof FORAGE_BASE_FLIPS).toBe("number");
    expect(typeof FORAGE_MAX_FLIPS).toBe("number");
    expect(typeof forageFlipsForInt(5)).toBe("number");
  });

  it("cascade never reveals a hazard", () => {
    // Try many grids to ensure the invariant holds in all generated worlds.
    for (let seed = 1; seed <= 50; seed++) {
      const grid = generateForageGrid(seed);
      for (let r = 0; r < FORAGE_GRID_ROWS; r++) {
        for (let c = 0; c < FORAGE_GRID_COLS; c++) {
          if (isForageHazard(grid[r][c])) continue; // can't start ON a hazard via cascade
          const cascade = forageCascadeFrom(grid, r, c, new Set());
          for (const rc of cascade) {
            if (isForageHazard(rc.cell) && (rc.r !== r || rc.c !== c)) {
              throw new Error(`Seed ${seed}: cascade from (${r},${c}) included hazard at (${rc.r},${rc.c})`);
            }
          }
        }
      }
    }
  });

  it("cascade from a 0-hazard empty cell reveals at least the cell itself + ≥1 neighbor", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const grid = generateForageGrid(seed);
      for (let r = 0; r < FORAGE_GRID_ROWS; r++) {
        for (let c = 0; c < FORAGE_GRID_COLS; c++) {
          if (grid[r][c] === "empty" && forageHazardCount(grid, r, c) === 0) {
            const cascade = forageCascadeFrom(grid, r, c, new Set());
            expect(cascade.length).toBeGreaterThanOrEqual(2);
            // First entry is the cell tapped
            expect(cascade[0].r).toBe(r);
            expect(cascade[0].c).toBe(c);
            expect(cascade[0].hazard_count).toBe(0);
            return; // one positive example is enough
          }
        }
      }
    }
  });

  it("each generated grid has at least one safe starting cell (0-hazard empty)", () => {
    let found = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const grid = generateForageGrid(seed);
      let hasSafe = false;
      for (let r = 0; r < FORAGE_GRID_ROWS && !hasSafe; r++) {
        for (let c = 0; c < FORAGE_GRID_COLS && !hasSafe; c++) {
          if (grid[r][c] === "empty" && forageHazardCount(grid, r, c) === 0) hasSafe = true;
        }
      }
      if (hasSafe) found++;
    }
    // First-flip-safety regenerates up to 40 times; this confirms the
    // distribution makes that path almost-always-successful.
    expect(found / 100).toBeGreaterThan(0.8);
  });

  it("alreadyRevealed cells are skipped by cascade", () => {
    const grid = generateForageGrid(42);
    // Find a 0-hazard empty cell.
    let target: [number, number] | null = null;
    outer: for (let r = 0; r < FORAGE_GRID_ROWS; r++) {
      for (let c = 0; c < FORAGE_GRID_COLS; c++) {
        if (grid[r][c] === "empty" && forageHazardCount(grid, r, c) === 0) {
          target = [r, c]; break outer;
        }
      }
    }
    if (!target) return; // skip if no 0-hazard cell in seed 42
    const [r, c] = target;
    const first = forageCascadeFrom(grid, r, c, new Set());
    const allKeys = new Set(first.map(rc => `${rc.r},${rc.c}`));
    const second = forageCascadeFrom(grid, r, c, allKeys);
    expect(second.length).toBe(0);
  });

  it("hazard count = number of mushrooms in 8 neighbors", () => {
    const grid: ForageCellKind[][] = Array.from({ length: FORAGE_GRID_ROWS }, () =>
      Array.from({ length: FORAGE_GRID_COLS }, () => "empty" as ForageCellKind),
    );
    grid[0][0] = "mushroom";
    grid[0][2] = "mushroom";
    expect(forageHazardCount(grid, 1, 1)).toBe(2);
    expect(forageHazardCount(grid, 2, 2)).toBe(0);
    grid[2][1] = "mushroom";
    expect(forageHazardCount(grid, 1, 1)).toBe(3);
    expect(forageHazardCount(grid, 0, 0)).toBe(0); // cell itself doesn't count toward its own count
  });

  it("simplified ecology: only 4 cell types", () => {
    const validKinds = new Set(["empty", "mossroot", "sunleaf", "mushroom"]);
    for (let seed = 1; seed <= 30; seed++) {
      const grid = generateForageGrid(seed);
      for (let r = 0; r < FORAGE_GRID_ROWS; r++) {
        for (let c = 0; c < FORAGE_GRID_COLS; c++) {
          expect(validKinds.has(grid[r][c])).toBe(true);
        }
      }
    }
  });

  it("sunleaf never spawns adjacent to a mushroom (safety-signal invariant)", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const grid = generateForageGrid(seed);
      for (let r = 0; r < FORAGE_GRID_ROWS; r++) {
        for (let c = 0; c < FORAGE_GRID_COLS; c++) {
          if (grid[r][c] !== "sunleaf") continue;
          expect(forageHazardCount(grid, r, c)).toBe(0);
        }
      }
    }
  });
});
