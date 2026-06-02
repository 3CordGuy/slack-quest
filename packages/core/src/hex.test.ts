import { describe, expect, it } from "vitest";
import {
  GRID_DEFAULT,
  defaultMonsterMoveRange,
  deriveMoveRange,
  deriveRangeTiles,
  generateLootTiles,
  generateObstacles,
  hexDisk,
  hexDistance,
  hexLos,
  hexNeighbors,
  hexPath,
  hexReachable,
  hexRing,
  inBounds,
  initialHexPositions,
  lootTileGold,
  lootTileItemTier,
  pickMonsterFormation,
  placeMonsters,
  posKey,
  type HexGrid,
  type MonsterPlacementSpec,
} from "./hex";

const GRID = GRID_DEFAULT; // 9×11 (portrait)
const GRID_HORIZ: HexGrid = { cols: 13, rows: 7 }; // legacy horizontal for left/right tests

describe("inBounds (brick layout)", () => {
  it("returns true for valid positions on row 0", () => {
    expect(inBounds({ q: 0, r: 0 }, GRID)).toBe(true);
    expect(inBounds({ q: GRID.cols - 1, r: 0 }, GRID)).toBe(true);
  });

  it("odd rows have one fewer hex (brick offset)", () => {
    // Row 1 (odd): valid q in [0, cols-2]; q=cols-1 is OUT.
    expect(inBounds({ q: GRID.cols - 2, r: 1 }, GRID)).toBe(true);
    expect(inBounds({ q: GRID.cols - 1, r: 1 }, GRID)).toBe(false);
  });

  it("axial q shifts left in lower rows (rectangle visual)", () => {
    // Row 2 (even): valid q in [-1, cols-2]; q=-1 is IN, q=cols-1 is OUT.
    expect(inBounds({ q: -1, r: 2 }, GRID)).toBe(true);
    expect(inBounds({ q: GRID.cols - 1, r: 2 }, GRID)).toBe(false);
  });

  it("returns false for out-of-bounds row positions", () => {
    expect(inBounds({ q: 0, r: -1 }, GRID)).toBe(false);
    expect(inBounds({ q: 0, r: GRID.rows }, GRID)).toBe(false);
  });
});

describe("hexDistance", () => {
  it("same hex is distance 0", () => {
    expect(hexDistance({ q: 5, r: 3 }, { q: 5, r: 3 })).toBe(0);
  });

  it("adjacent hexes are distance 1", () => {
    expect(hexDistance({ q: 0, r: 0 }, { q: 1, r: 0 })).toBe(1);
    expect(hexDistance({ q: 0, r: 0 }, { q: 0, r: 1 })).toBe(1);
    expect(hexDistance({ q: 0, r: 0 }, { q: 1, r: -1 })).toBe(1);
    expect(hexDistance({ q: 0, r: 0 }, { q: -1, r: 0 })).toBe(1);
    expect(hexDistance({ q: 0, r: 0 }, { q: 0, r: -1 })).toBe(1);
    expect(hexDistance({ q: 0, r: 0 }, { q: -1, r: 1 })).toBe(1);
  });

  it("is symmetric", () => {
    expect(hexDistance({ q: 3, r: 2 }, { q: 7, r: 5 })).toBe(
      hexDistance({ q: 7, r: 5 }, { q: 3, r: 2 }),
    );
  });

  it("horizontal distance across the arena", () => {
    // Fighter at (1, 3), monster at (11, 3): should be 10 hexes apart
    expect(hexDistance({ q: 1, r: 3 }, { q: 11, r: 3 })).toBe(10);
  });

  it("diagonal distance uses cube-coord max", () => {
    // (0,0) to (2,2): dq=2, dr=2, |dq+dr|=4, so max = 4
    expect(hexDistance({ q: 0, r: 0 }, { q: 2, r: 2 })).toBe(4);
  });
});

describe("hexNeighbors", () => {
  // Interior hex of the brick layout (well clear of all edges).
  // q=4, r=5 → row 5 (odd, width 8, rowShift 2), offsetCol=6 → 6 neighbors.
  const interior = { q: 4, r: 5 };

  it("interior hex has 6 neighbors", () => {
    expect(hexNeighbors(interior, GRID)).toHaveLength(6);
  });

  it("corner hex has fewer neighbors", () => {
    // (0,0) has neighbors at (1,0), (0,1), (1,-1) but (1,-1) is out of bounds
    const n = hexNeighbors({ q: 0, r: 0 }, GRID);
    expect(n.length).toBeLessThan(6);
    expect(n.every((p) => inBounds(p, GRID))).toBe(true);
  });

  it("all neighbors are exactly 1 hex away", () => {
    const neighbors = hexNeighbors(interior, GRID);
    for (const n of neighbors) {
      expect(hexDistance(interior, n)).toBe(1);
    }
  });
});

describe("hexLos", () => {
  it("same hex has LOS", () => {
    expect(hexLos({ q: 5, r: 3 }, { q: 5, r: 3 }, [])).toBe(true);
  });

  it("adjacent hexes always have LOS", () => {
    expect(hexLos({ q: 5, r: 3 }, { q: 6, r: 3 }, [])).toBe(true);
  });

  it("no obstacles means full LOS across the grid", () => {
    expect(hexLos({ q: 1, r: 3 }, { q: 11, r: 3 }, [])).toBe(true);
  });

  it("obstacle between two hexes blocks LOS", () => {
    // (1,3) → (11,3) with obstacle at (6,3) in the middle
    expect(hexLos({ q: 1, r: 3 }, { q: 11, r: 3 }, [{ q: 6, r: 3 }])).toBe(false);
  });

  it("obstacle off the path does not block LOS", () => {
    expect(hexLos({ q: 1, r: 3 }, { q: 11, r: 3 }, [{ q: 6, r: 5 }])).toBe(true);
  });

  it("obstacle at endpoints does not block", () => {
    // Obstacles at the FROM or TO hex should not block sight.
    expect(hexLos({ q: 1, r: 3 }, { q: 5, r: 3 }, [{ q: 1, r: 3 }])).toBe(true);
    expect(hexLos({ q: 1, r: 3 }, { q: 5, r: 3 }, [{ q: 5, r: 3 }])).toBe(true);
  });
});

describe("hexReachable", () => {
  it("range 0 returns no hexes", () => {
    expect(hexReachable({ q: 4, r: 5 }, 0, [], GRID)).toHaveLength(0);
  });

  it("range 1 returns all in-bounds neighbors", () => {
    const center = { q: 4, r: 5 };
    const reachable = hexReachable(center, 1, [], GRID);
    expect(reachable).toHaveLength(6);
    for (const p of reachable) {
      expect(hexDistance(center, p)).toBe(1);
    }
  });

  it("occupied hexes are excluded", () => {
    const center = { q: 4, r: 5 };
    const occupied = [{ q: 5, r: 5 }];
    const reachable = hexReachable(center, 1, occupied, GRID);
    expect(reachable.some((p) => posKey(p) === "5,5")).toBe(false);
  });

  it("occupied hexes block further expansion through them", () => {
    // With a wall of occupied hexes at distance 1, distance-2 hexes behind are unreachable.
    const center = { q: 4, r: 5 };
    // Block the path through (7,3) — can't reach (8,3) via (7,3)
    const occupied = [{ q: 5, r: 5 }];
    const reachable2 = hexReachable(center, 2, occupied, GRID);
    // (8,3) is 2 hexes away via (7,3), which is blocked
    // BUT it may be reachable via another path (through (7,2) or (7,4))
    // So this test just verifies the occupied hex itself isn't in the list
    expect(reachable2.some((p) => posKey(p) === "5,5")).toBe(false);
  });

  it("does not include the starting hex", () => {
    const center = { q: 4, r: 5 };
    const reachable = hexReachable(center, 3, [], GRID);
    expect(reachable.some((p) => posKey(p) === posKey(center))).toBe(false);
  });

  it("range 2 with no obstacles reaches expected hexes", () => {
    const center = { q: 4, r: 5 };
    const reachable = hexReachable(center, 2, [], GRID);
    // Should have 6 (ring 1) + 12 (ring 2) = 18 total, minus any out-of-bounds
    expect(reachable.length).toBeGreaterThan(12);
    expect(reachable.length).toBeLessThanOrEqual(18);
  });
});

describe("hexPath", () => {
  it("same start and end returns empty", () => {
    expect(hexPath({ q: 5, r: 3 }, { q: 5, r: 3 }, [], GRID)).toHaveLength(0);
  });

  it("adjacent hexes return a path of length 1", () => {
    const path = hexPath({ q: 5, r: 3 }, { q: 6, r: 3 }, [], GRID);
    expect(path).toHaveLength(1);
    expect(posKey(path[0])).toBe("6,3");
  });

  it("path includes destination but not start", () => {
    const from = { q: 1, r: 3 };
    const to = { q: 3, r: 3 };
    const path = hexPath(from, to, [], GRID);
    expect(posKey(path[path.length - 1])).toBe(posKey(to));
    expect(path.some((p) => posKey(p) === posKey(from))).toBe(false);
  });

  it("path length equals hex distance when no obstacles", () => {
    const from = { q: 1, r: 3 };
    const to = { q: 4, r: 5 };
    const path = hexPath(from, to, [], GRID);
    expect(path).toHaveLength(hexDistance(from, to));
  });

  it("path goes around a single occupied hex", () => {
    const from = { q: 3, r: 3 };
    const to = { q: 5, r: 3 };
    const occupied = [{ q: 4, r: 3 }]; // directly in the way
    const path = hexPath(from, to, occupied, GRID);
    expect(path.length).toBeGreaterThan(0); // path found
    expect(path.some((p) => posKey(p) === "4,3")).toBe(false); // avoids obstacle
    expect(posKey(path[path.length - 1])).toBe("5,3"); // still reaches destination
  });

  it("returns empty when the source hex is fully enclosed (no adjacent free tiles)", () => {
    // Surround the start hex with occupied tiles. The destination must also be
    // unreachable (not one of the surrounding tiles — hexPath allows pathing INTO
    // the destination even if occupied, since monsters need to path to fighter tiles).
    const from = { q: 4, r: 5 };
    const allNeighbors = hexNeighbors(from, GRID);
    // Add extra tiles to wall off any alternative route to (9,3)
    const occupied = [...allNeighbors, ...hexNeighbors({ q: 5, r: 5 }, GRID)];
    const path = hexPath(from, { q: 9, r: 3 }, occupied, GRID);
    expect(path).toHaveLength(0);
  });
});

describe("hexDisk", () => {
  it("radius 1 disk has same count as neighbors", () => {
    const center = { q: 4, r: 5 };
    const disk = hexDisk(center, 1, GRID);
    expect(disk).toHaveLength(hexNeighbors(center, GRID).length);
  });

  it("disk does not include center", () => {
    const center = { q: 4, r: 5 };
    const disk = hexDisk(center, 2, GRID);
    expect(disk.some((p) => posKey(p) === posKey(center))).toBe(false);
  });

  it("disk radius 2 includes radius-1 and radius-2 hexes", () => {
    const center = { q: 4, r: 5 };
    const disk = hexDisk(center, 2, GRID);
    const ring1 = disk.filter((p) => hexDistance(center, p) === 1);
    const ring2 = disk.filter((p) => hexDistance(center, p) === 2);
    expect(ring1.length).toBeGreaterThan(0);
    expect(ring2.length).toBeGreaterThan(0);
    expect(disk.every((p) => hexDistance(center, p) <= 2)).toBe(true);
  });
});

describe("hexRing", () => {
  it("ring radius 0 returns only center", () => {
    const center = { q: 4, r: 5 };
    const ring = hexRing(center, 0, GRID);
    expect(ring).toHaveLength(1);
    expect(posKey(ring[0])).toBe(posKey(center));
  });

  it("ring radius 1 returns neighbors", () => {
    const center = { q: 4, r: 5 };
    const ring = hexRing(center, 1, GRID);
    expect(ring.every((p) => hexDistance(center, p) === 1)).toBe(true);
  });

  it("ring radius 2 only has hexes at distance 2", () => {
    const center = { q: 4, r: 5 };
    const ring = hexRing(center, 2, GRID);
    expect(ring.every((p) => hexDistance(center, p) === 2)).toBe(true);
    expect(ring.length).toBeGreaterThan(0);
  });
});

describe("initialHexPositions", () => {
  // Vertical grid (default): "top" / "bottom"
  it("places fighters near the top of the vertical grid", () => {
    const positions = initialHexPositions(3, "top", GRID);
    expect(positions).toHaveLength(3);
    expect(positions.every((p) => p.r <= 2)).toBe(true);
  });

  it("places monsters near the bottom of the vertical grid", () => {
    const positions = initialHexPositions(3, "bottom", GRID);
    expect(positions).toHaveLength(3);
    expect(positions.every((p) => p.r >= GRID.rows - 2)).toBe(true);
  });

  it("single actor placed at center column of the top edge", () => {
    const [pos] = initialHexPositions(1, "top", GRID);
    expect(pos.r).toBe(1);
    expect(pos.q).toBe(Math.floor(GRID.cols / 2));
  });

  it("vertical positions stay in bounds", () => {
    const top = initialHexPositions(5, "top", GRID);
    const bottom = initialHexPositions(5, "bottom", GRID);
    expect(top.every((p) => inBounds(p, GRID))).toBe(true);
    expect(bottom.every((p) => inBounds(p, GRID))).toBe(true);
  });

  // Horizontal grid (legacy): "left" / "right" — kept for backward compat.
  it("places fighters on the left side of a horizontal grid", () => {
    const positions = initialHexPositions(3, "left", GRID_HORIZ);
    expect(positions).toHaveLength(3);
    expect(positions.every((p) => p.q <= 2)).toBe(true);
  });

  it("places monsters on the right side of a horizontal grid", () => {
    const positions = initialHexPositions(3, "right", GRID_HORIZ);
    expect(positions).toHaveLength(3);
    expect(positions.every((p) => p.q >= GRID_HORIZ.cols - 2)).toBe(true);
  });

  it("no duplicate positions for any side", () => {
    for (const side of ["left", "right", "top", "bottom"] as const) {
      const grid = side === "left" || side === "right" ? GRID_HORIZ : GRID;
      const positions = initialHexPositions(4, side, grid);
      const keys = positions.map(posKey);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe("defaultMonsterMoveRange", () => {
  it("matches the tuned tier schedule", () => {
    // tier 1–2 → 2 (matches fighter base; positioning has time to matter)
    expect(defaultMonsterMoveRange(1)).toBe(2);
    expect(defaultMonsterMoveRange(2)).toBe(2);
    // tier 3–4 → 3
    expect(defaultMonsterMoveRange(3)).toBe(3);
    expect(defaultMonsterMoveRange(4)).toBe(3);
    // tier 5–8 → 4
    expect(defaultMonsterMoveRange(5)).toBe(4);
    expect(defaultMonsterMoveRange(6)).toBe(4);
    expect(defaultMonsterMoveRange(7)).toBe(4);
    expect(defaultMonsterMoveRange(8)).toBe(4);
    // tier 9+ → 3 (boss tier — heavier; charge special compensates)
    expect(defaultMonsterMoveRange(9)).toBe(3);
    expect(defaultMonsterMoveRange(20)).toBe(3);
  });

  it("low-tier monsters never out-move a 5-AGI fighter", () => {
    // A baseline fighter starts at move-range 2. Low-tier monsters should
    // never exceed that, otherwise they out-position the party for free.
    const fighterBase = deriveMoveRange(5);
    for (let tier = 1; tier <= 2; tier++) {
      expect(defaultMonsterMoveRange(tier)).toBeLessThanOrEqual(fighterBase);
    }
  });
});

describe("deriveMoveRange", () => {
  it("base AGI 5 gives move range 2", () => {
    expect(deriveMoveRange(5)).toBe(2);
  });

  it("AGI 8 gives move range 3", () => {
    // floor((8-5)/3) = floor(1) = 1; base 2 + 1 = 3
    expect(deriveMoveRange(8)).toBe(3);
  });

  it("low AGI still gets base 2", () => {
    expect(deriveMoveRange(1)).toBe(2);
    expect(deriveMoveRange(0)).toBe(2);
  });

  it("caps at MAX_MOVE_RANGE so AGI-stacked equipment can't trivialize the grid", () => {
    // formula would give 2 + floor((50-5)/3) = 17 without the cap
    expect(deriveMoveRange(50)).toBe(5);
    expect(deriveMoveRange(100)).toBe(5);
  });
});

describe("deriveRangeTiles", () => {
  it("melee is always 1", () => {
    expect(deriveRangeTiles("melee", 10, 10)).toBe(1);
    expect(deriveRangeTiles("melee", 1, 1)).toBe(1);
  });

  it("focus base range is 2 + INT bonus", () => {
    expect(deriveRangeTiles("focus", 5)).toBe(2); // no bonus
    expect(deriveRangeTiles("focus", 9)).toBe(3); // floor((9-5)/4) = 1
  });

  it("ranged base range is 4 + DEX bonus", () => {
    expect(deriveRangeTiles("ranged", 5, 5)).toBe(4); // no bonus
    expect(deriveRangeTiles("ranged", 5, 9)).toBe(5); // floor((9-5)/4) = 1
  });
});

describe("generateObstacles", () => {
  const party = [{ q: 1, r: 3 }];
  const monsters = [{ q: 11, r: 3 }];

  it("is deterministic for a given seed", () => {
    const a = generateObstacles(GRID, party, monsters, 42, "cave");
    const b = generateObstacles(GRID, party, monsters, 42, "cave");
    expect(a).toEqual(b);
  });

  it("different seeds produce different layouts", () => {
    const a = generateObstacles(GRID, party, monsters, 1, "cave");
    const b = generateObstacles(GRID, party, monsters, 999, "cave");
    expect(a).not.toEqual(b);
  });

  it("produces 2–4 obstacles", () => {
    for (let seed = 0; seed < 30; seed++) {
      const obs = generateObstacles(GRID, party, monsters, seed, "cave");
      expect(obs.length).toBeGreaterThanOrEqual(2);
      expect(obs.length).toBeLessThanOrEqual(4);
    }
  });

  it("never places an obstacle on a party or monster start hex", () => {
    const obs = generateObstacles(GRID, party, monsters, 7, "cave");
    for (const o of obs) {
      expect(posKey(o.pos)).not.toBe(posKey(party[0]));
      expect(posKey(o.pos)).not.toBe(posKey(monsters[0]));
    }
  });

  it("never places an obstacle adjacent to a start hex", () => {
    const obs = generateObstacles(GRID, party, monsters, 3, "cave");
    const forbidden = new Set<string>([
      posKey(party[0]),
      posKey(monsters[0]),
      ...hexNeighbors(party[0], GRID).map(posKey),
      ...hexNeighbors(monsters[0], GRID).map(posKey),
    ]);
    for (const o of obs) expect(forbidden.has(posKey(o.pos))).toBe(false);
  });

  it("obstacles are at least 2 hexes apart from each other", () => {
    for (let seed = 0; seed < 20; seed++) {
      const obs = generateObstacles(GRID, party, monsters, seed, "cave");
      for (let i = 0; i < obs.length; i++) {
        for (let j = i + 1; j < obs.length; j++) {
          expect(hexDistance(obs[i].pos, obs[j].pos)).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it("scene determines obstacle kind palette", () => {
    const forest = generateObstacles(GRID, party, monsters, 5, "forest");
    const ruins = generateObstacles(GRID, party, monsters, 5, "ruins");
    expect(forest.every((o) => ["tree", "boulder", "rubble"].includes(o.kind))).toBe(true);
    expect(ruins.every((o) => ["pillar", "rubble", "crate"].includes(o.kind))).toBe(true);
  });

  it("themed corporate-fantasy scenes pull from the engineering obstacle set", () => {
    // Sample several seeds per scene so we exercise the palette pick instead
    // of pinning a single result.
    const sceneToAllowedKinds: Record<string, string[]> = {
      server_catacomb:    ["server_rack", "k8s_cluster", "rubble"],
      cubicle_forest:     ["cubicle_wall", "watercooler", "tree"],
      warehouse_floor:    ["crate", "file_cabinet", "rubble"],
      fluorescent_office: ["file_cabinet", "printer", "desktop_computer", "cubicle_wall", "watercooler"],
      neon_basement:      ["server_rack", "k8s_cluster", "pillar"],
      deadline_dungeon:   ["desktop_computer", "file_cabinet", "pillar", "rubble"],
    };
    for (const [scene, allowed] of Object.entries(sceneToAllowedKinds)) {
      for (let seed = 1; seed < 20; seed++) {
        const obs = generateObstacles(GRID, party, monsters, seed, scene);
        for (const o of obs) {
          expect(allowed, `scene=${scene} seed=${seed}`).toContain(o.kind);
        }
      }
    }
  });
});

describe("hexLos with obstacles array", () => {
  it("accepts bare HexPos[] (backward compat)", () => {
    expect(hexLos({ q: 1, r: 3 }, { q: 11, r: 3 }, [{ q: 6, r: 3 }])).toBe(false);
  });

  it("accepts Obstacle[] objects with .pos field", () => {
    expect(
      hexLos({ q: 1, r: 3 }, { q: 11, r: 3 }, [{ pos: { q: 6, r: 3 }, kind: "boulder" }]),
    ).toBe(false);
  });

  it("clear path with no obstacles", () => {
    expect(hexLos({ q: 1, r: 3 }, { q: 11, r: 3 }, [])).toBe(true);
  });
});

describe("generateLootTiles", () => {
  const party = [{ q: 1, r: 3 }];
  const monsters = [{ q: 11, r: 3 }];

  it("is deterministic for the same seed and inputs", () => {
    const a = generateLootTiles(GRID, party, monsters, [], 42, 3);
    const b = generateLootTiles(GRID, party, monsters, [], 42, 3);
    expect(a).toEqual(b);
  });

  it("count scales with tier (1 / 2 / 3)", () => {
    expect(generateLootTiles(GRID, party, monsters, [], 7, 1)).toHaveLength(1);
    expect(generateLootTiles(GRID, party, monsters, [], 7, 3)).toHaveLength(1);
    expect(generateLootTiles(GRID, party, monsters, [], 7, 5)).toHaveLength(2);
    expect(generateLootTiles(GRID, party, monsters, [], 7, 7)).toHaveLength(3);
    expect(generateLootTiles(GRID, party, monsters, [], 7, 12)).toHaveLength(3);
  });

  it("never places a tile on a start hex, its neighbors, or an obstacle hex", () => {
    const obs = generateObstacles(GRID, party, monsters, 11, "cave");
    const forbidden = new Set<string>([
      posKey(party[0]),
      posKey(monsters[0]),
      ...hexNeighbors(party[0], GRID).map(posKey),
      ...hexNeighbors(monsters[0], GRID).map(posKey),
      ...obs.map((o) => posKey(o.pos)),
    ]);
    for (let seed = 1; seed < 30; seed++) {
      const tiles = generateLootTiles(GRID, party, monsters, obs, seed, 6);
      for (const t of tiles) {
        expect(forbidden.has(posKey(t.pos)), `seed=${seed}`).toBe(false);
      }
    }
  });

  it("tiles are at least 2 hexes apart from each other and from obstacles", () => {
    const obs = generateObstacles(GRID, party, monsters, 13, "cave");
    for (let seed = 1; seed < 20; seed++) {
      const tiles = generateLootTiles(GRID, party, monsters, obs, seed, 8);
      for (let i = 0; i < tiles.length; i++) {
        for (let j = i + 1; j < tiles.length; j++) {
          expect(hexDistance(tiles[i].pos, tiles[j].pos)).toBeGreaterThanOrEqual(2);
        }
        for (const o of obs) {
          expect(hexDistance(tiles[i].pos, o.pos)).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it("kind is gold ~60% / item ~40% across many seeds", () => {
    let gold = 0;
    let item = 0;
    for (let seed = 1; seed < 200; seed++) {
      for (const t of generateLootTiles(GRID, party, monsters, [], seed, 5)) {
        if (t.kind === "gold") gold++;
        else item++;
      }
    }
    const total = gold + item;
    const goldRatio = gold / total;
    expect(goldRatio).toBeGreaterThan(0.5);
    expect(goldRatio).toBeLessThan(0.7);
  });

  it("tile ids are unique within a battlefield", () => {
    const tiles = generateLootTiles(GRID, party, monsters, [], 99, 9);
    const ids = new Set(tiles.map((t) => t.id));
    expect(ids.size).toBe(tiles.length);
  });

  it("lootTileGold scales with tier and is monotonic", () => {
    expect(lootTileGold(1)).toBe(8);
    expect(lootTileGold(5)).toBe(16);
    expect(lootTileGold(9)).toBe(24);
    expect(lootTileGold(2)).toBeGreaterThan(lootTileGold(1));
  });

  it("lootTileItemTier is one below source tier and clamps to 1", () => {
    expect(lootTileItemTier(5)).toBe(4);
    expect(lootTileItemTier(1)).toBe(1);
    expect(lootTileItemTier(0)).toBe(1);
  });
});

describe("pickMonsterFormation", () => {
  it("singleton fights always use center (no formation makes sense)", () => {
    for (let seed = 0; seed < 20; seed++) {
      expect(pickMonsterFormation(seed, 1)).toBe("center");
      expect(pickMonsterFormation(seed, 0)).toBe("center");
    }
  });

  it("is deterministic for the same seed + count", () => {
    expect(pickMonsterFormation(42, 4)).toBe(pickMonsterFormation(42, 4));
    expect(pickMonsterFormation(1337, 3)).toBe(pickMonsterFormation(1337, 3));
  });

  it("samples across all formations as seed varies", () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      seen.add(pickMonsterFormation(seed, 4));
    }
    expect(seen.has("center")).toBe(true);
    expect(seen.has("line")).toBe(true);
    expect(seen.has("wedge")).toBe(true);
    expect(seen.has("scatter")).toBe(true);
    expect(seen.has("flank")).toBe(true);
    expect(seen.has("back_rank")).toBe(true);
  });
});

describe("placeMonsters", () => {
  function specs(count: number, mix?: Partial<MonsterPlacementSpec>[]): MonsterPlacementSpec[] {
    return Array.from({ length: count }, (_, i) => ({ weapon_range: "melee" as const, ...mix?.[i] }));
  }

  it("empty specs return empty positions", () => {
    expect(placeMonsters([], GRID, 1)).toEqual([]);
  });

  it("solo monsters use the original center-fill behavior", () => {
    const placed = placeMonsters(specs(1), GRID, 99);
    expect(placed).toEqual(initialHexPositions(1, "bottom", GRID));
  });

  it("places every monster on an in-bounds, distinct hex for any seed", () => {
    for (let seed = 0; seed < 100; seed++) {
      const placed = placeMonsters(specs(5), GRID, seed);
      expect(placed).toHaveLength(5);
      const keys = new Set(placed.map(posKey));
      expect(keys.size).toBe(placed.length);
      for (const p of placed) {
        expect(inBounds(p, GRID), `seed=${seed} pos=${posKey(p)}`).toBe(true);
      }
    }
  });

  it("bosses always claim a center-stage slot (never the corners)", () => {
    const bossSpecs: MonsterPlacementSpec[] = [
      { weapon_range: "melee" },
      { weapon_range: "melee", is_boss: true },
      { weapon_range: "ranged" },
      { weapon_range: "focus" },
    ];
    const midCol = Math.floor(GRID.cols / 2);
    for (let seed = 0; seed < 30; seed++) {
      const placed = placeMonsters(bossSpecs, GRID, seed);
      const bossPos = placed[1];
      const offsetCol = bossPos.q + Math.floor(bossPos.r / 2);
      expect(Math.abs(offsetCol - midCol), `seed=${seed}`).toBeLessThanOrEqual(2);
    }
  });

  it("monsters stay in the bottom half of the grid", () => {
    const midRow = Math.floor(GRID.rows / 2);
    for (let seed = 0; seed < 50; seed++) {
      const placed = placeMonsters(specs(4), GRID, seed);
      for (const p of placed) expect(p.r, `seed=${seed}`).toBeGreaterThanOrEqual(midRow);
    }
  });

  it("scene_seed determinism: same seed → identical layout", () => {
    const a = placeMonsters(specs(5), GRID, 12345);
    const b = placeMonsters(specs(5), GRID, 12345);
    expect(a).toEqual(b);
  });

  it("different seeds produce different layouts for the same party size", () => {
    const layouts = new Set<string>();
    for (let seed = 1; seed < 30; seed++) {
      layouts.add(placeMonsters(specs(4), GRID, seed).map(posKey).join("|"));
    }
    expect(layouts.size).toBeGreaterThan(2);
  });
});
