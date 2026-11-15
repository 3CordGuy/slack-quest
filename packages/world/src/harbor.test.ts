import { describe, expect, it } from "vitest";
import { HARBOR_APOTHECARY, HARBOR_BUILDINGS, HARBOR_CAVE, HARBOR_GALLEY, HARBOR_GATHER, HARBOR_LIGHTHOUSE, HARBOR_PUB, HARBOR_WRECK, HARBOR_SMITHY, HARBOR_GRID, HARBOR_BOARD, HARBOR_PIERS, HARBOR_PLOTS, HARBOR_RING, HARBOR_SHOP, HARBOR_SPAWN, HARBOR_WORKS, findPath, footing, generateHarbor, harborDoor, harborPath, tileAt } from "./index";

type Hex = { q: number; r: number };
const key = (p: Hex) => `${p.q},${p.r}`;
const dist = (a: Hex, b: Hex) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.q + a.r - b.q - b.r));
const around = (p: Hex) => [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]].map(([q, r]) => ({ q: p.q + q, r: p.r + r }));

describe("harbor map", () => {
  const map = generateHarbor();
  /** Every hex a hero stands on to use a place. */
  const doors = [...HARBOR_PLOTS, HARBOR_BOARD, HARBOR_SHOP, HARBOR_RING, HARBOR_PUB, HARBOR_WORKS, HARBOR_APOTHECARY, HARBOR_SMITHY, HARBOR_GALLEY, HARBOR_LIGHTHOUSE, HARBOR_CAVE, ...Object.values(HARBOR_GATHER)];
  const built = HARBOR_BUILDINGS.flatMap((b) => footing(b.door, b.shape));

  it("is the same every time", () => {
    expect(generateHarbor()).toEqual(map);
  });

  it("puts piers on dock tiles with open water beyond them, and planking back to the shore", () => {
    expect(HARBOR_PIERS).toHaveLength(3);
    for (const pier of HARBOR_PIERS) {
      expect(tileAt(map, pier)!.biome).toBe("dock");
      expect(tileAt(map, { q: pier.q, r: pier.r + 1 })!.biome).toBe("water");
      expect(tileAt(map, { q: pier.q - 1, r: pier.r + 1 })!.biome).toBe("water");
      // A pier is more than its head: the walk out to it is over planks.
      expect(harborPath(map, HARBOR_SPAWN, pier)!.filter((p) => tileAt(map, p)!.biome === "dock").length).toBeGreaterThanOrEqual(2);
    }
  });

  it("lets a player walk from the plaza to every place's door, every plot and every pier, on dry land", () => {
    expect(HARBOR_PLOTS).toHaveLength(12);
    expect(new Set(doors.map(key)).size).toBe(doors.length);
    for (const target of [...doors, ...HARBOR_PIERS]) {
      const path = harborPath(map, HARBOR_SPAWN, target);
      expect(path, key(target)).not.toBeNull();
      expect(path!.at(-1)).toEqual(target);
      expect(path!.every((p) => tileAt(map, p)!.biome !== "water" && !tileAt(map, p)!.built)).toBe(true);
    }
  });

  it("stands each building on the ground behind its door, which nobody can walk through", () => {
    // Two hexes behind the door, three in a diamond with the doorstep, or a ring of seven.
    expect(footing({ q: 0, r: 0 }, "pair")).toHaveLength(2);
    expect(footing({ q: 0, r: 0 }, "trio")).toHaveLength(3);
    const flower = footing({ q: 0, r: 0 }, "flower");
    expect(flower).toHaveLength(7);
    // The ring's middle is two rows behind the door, with the other six round it.
    const middle = { q: 1, r: -2 };
    expect(flower.filter((p) => dist(p, middle) === 1)).toHaveLength(6);
    for (const shape of ["pair", "trio", "flower"] as const) {
      // The door touches the building: its two nearest hexes are the ones behind it.
      expect(footing({ q: 0, r: 0 }, shape).filter((p) => dist(p, { q: 0, r: 0 }) === 1)).toHaveLength(2);
    }
    // No building stands on another, on a door, on the plaza or on a pier.
    expect(new Set(built.map(key)).size).toBe(built.length);
    const open = new Set([...doors, HARBOR_SPAWN, ...around(HARBOR_SPAWN), ...HARBOR_PIERS].map(key));
    for (const p of built) {
      expect(open.has(key(p)), key(p)).toBe(false);
      const tile = tileAt(map, p)!;
      expect(tile.built).toBe(true);
      expect(tile.biome).not.toBe("water");
      expect(harborPath(map, HARBOR_SPAWN, p), key(p)).toBeNull();
      // The default terrain cost refuses it too: that is what the client's walking preview uses.
      expect(findPath(map, HARBOR_SPAWN, p)).toBeNull();
    }
    expect(map.tiles.filter((t) => t.built).length).toBe(built.length);
    // The ground under a building is level with its doorstep, so it does not float or sink.
    for (const b of HARBOR_BUILDINGS) for (const p of footing(b.door, b.shape)) expect(tileAt(map, p)!.h).toBe(tileAt(map, b.door)!.h);
  });

  it("gives the pub four tiles and the lighthouse a ring of seven with the tower in the middle", () => {
    const pub = HARBOR_BUILDINGS.find((b) => b.id === "pub")!;
    expect(footing(pub.door, pub.shape).length + 1).toBe(4);
    const lighthouse = HARBOR_BUILDINGS.find((b) => b.id === "lighthouse")!;
    expect(footing(lighthouse.door, lighthouse.shape)).toHaveLength(7);
    // The main buildings take more ground than a hut does.
    const size = (id: string) => footing(HARBOR_BUILDINGS.find((b) => b.id === id)!.door, HARBOR_BUILDINGS.find((b) => b.id === id)!.shape).length;
    for (const id of ["pub", "apothecary", "smithy", "galley"]) expect(size(id)).toBeGreaterThan(size("plot:0"));
    expect(size("lighthouse")).toBeGreaterThan(size("pub"));
  });

  it("says which door a building's ground belongs to", () => {
    for (const b of HARBOR_BUILDINGS) for (const p of footing(b.door, b.shape)) expect(harborDoor(p)).toEqual(b.door);
    // Open ground and the doors themselves belong to no building.
    expect(harborDoor(HARBOR_SPAWN)).toBeNull();
    expect(harborDoor(HARBOR_PUB)).toBeNull();
  });

  it("puts the gathering spots on free, walkable hexes at the edges", () => {
    const used = [...HARBOR_PLOTS, ...HARBOR_PIERS, HARBOR_BOARD, HARBOR_SHOP, HARBOR_RING, HARBOR_SPAWN, HARBOR_APOTHECARY, HARBOR_SMITHY, HARBOR_GALLEY, ...built].map(key);
    const spots = Object.values(HARBOR_GATHER);
    expect(new Set(spots.map(key)).size).toBe(3);
    for (const spot of spots) {
      expect(used).not.toContain(key(spot));
      expect(tileAt(map, spot)!.biome).not.toBe("water");
      // At the island's edge: the sea is beside each of them.
      expect(around(spot).map((p) => tileAt(map, p)?.biome)).toContain("water");
      expect(harborPath(map, HARBOR_SPAWN, spot)!.at(-1)).toEqual(spot);
    }
    // The fish shack's jetty runs out over the water in front of it.
    expect(tileAt(map, { q: HARBOR_GATHER.fishing.q, r: HARBOR_GATHER.fishing.r + 1 })!.biome).toBe("water");
    expect(tileAt(map, { q: HARBOR_GATHER.fishing.q - 1, r: HARBOR_GATHER.fishing.r + 1 })!.biome).toBe("water");
    expect(tileAt(map, HARBOR_GATHER.felling)!.biome).toBe("forest");
    expect(tileAt(map, HARBOR_GATHER.quarry)!.biome).toBe("hills");
  });

  it("refuses the sea, off-map hexes and standing still", () => {
    const sea = map.tiles.find((t) => t.biome === "water")!;
    expect(harborPath(map, HARBOR_SPAWN, sea)).toBeNull();
    expect(harborPath(map, HARBOR_SPAWN, { q: 99, r: 99 })).toBeNull();
    expect(harborPath(map, HARBOR_SPAWN, HARBOR_SPAWN)).toBeNull();
  });

  it("is a walled port: the town stands on cobbles, the wall and the sea cannot be crossed", () => {
    const biomes = new Set(map.tiles.map((t) => t.biome));
    for (const b of ["cobble", "mud", "rampart", "water", "dock"]) expect(biomes.has(b as never), b).toBe(true);
    // The plaza is cobbled all round where everyone arrives, and so are the town's places and the ground they stand on.
    for (const pos of [HARBOR_SPAWN, ...around(HARBOR_SPAWN), HARBOR_BOARD, HARBOR_RING]) expect(tileAt(map, pos)?.biome).toBe("cobble");
    for (const id of ["pub", "works", "shop", "apothecary", "smithy", "galley"]) {
      const b = HARBOR_BUILDINGS.find((x) => x.id === id)!;
      for (const pos of [b.door, ...footing(b.door, b.shape)]) expect(tileAt(map, pos)?.biome, id).toBe("cobble");
    }
    // Huts stand on the grass, not on paving.
    for (const plot of HARBOR_PLOTS) expect(tileAt(map, plot)?.biome).toBe("plains");
    const wall = map.tiles.find((t) => t.biome === "rampart")!;
    expect(harborPath(map, HARBOR_SPAWN, wall)).toBeNull();
    // Rocks and the wreck are out in the water, out of reach.
    const scenery = map.pois.filter((p) => p.kind === "rocks" || p.kind === "wreck");
    expect(scenery.length).toBeGreaterThan(3);
    for (const p of scenery) {
      expect(tileAt(map, p.pos)?.biome).toBe("water");
      expect(harborPath(map, HARBOR_SPAWN, p.pos)).toBeNull();
    }
    // No mooring is fouled by a rock: a ship lies in the water two rows deep beyond its pier.
    for (const pier of HARBOR_PIERS) expect(scenery.some((p) => dist(p.pos, pier) <= 3 && p.pos.r > pier.r)).toBe(false);
  });

  it("puts the caverns' mouth in the north wall, with the wall behind it", () => {
    expect(tileAt(map, HARBOR_CAVE)!.biome).toBe("hills");
    expect(HARBOR_CAVE.r).toBeLessThan(HARBOR_SPAWN.r - 8);
    for (const p of footing(HARBOR_CAVE, "pair")) expect(tileAt(map, p)!.biome).toBe("rampart");
    expect(map.pois.find((p) => p.id === "cave")?.pos).toEqual(HARBOR_CAVE);
  });

  it("puts the apothecary near the market stall and the smithy near the sparring ring, off the plots", () => {
    const plots = new Set(HARBOR_PLOTS.map(key));
    for (const spot of [HARBOR_APOTHECARY, HARBOR_SMITHY]) expect(plots.has(key(spot))).toBe(false);
    expect(dist(HARBOR_APOTHECARY, HARBOR_SHOP)).toBeLessThanOrEqual(4);
    expect(dist(HARBOR_SMITHY, HARBOR_RING)).toBeLessThanOrEqual(4);
    expect(map.pois.find((p) => p.id === "apothecary")?.pos).toEqual(HARBOR_APOTHECARY);
    expect(map.pois.find((p) => p.id === "smithy")?.pos).toEqual(HARBOR_SMITHY);
  });

  it("puts the galley on the quay by the piers, off the plots and the other places", () => {
    const taken = [...HARBOR_PLOTS, ...HARBOR_PIERS, HARBOR_BOARD, HARBOR_SHOP, HARBOR_RING, HARBOR_SPAWN, HARBOR_WORKS, HARBOR_APOTHECARY, HARBOR_SMITHY, ...Object.values(HARBOR_GATHER)];
    expect(taken.some((p) => key(p) === key(HARBOR_GALLEY))).toBe(false);
    // Down by the water: south of the plaza, a short walk from a pier.
    expect(HARBOR_GALLEY.r).toBeGreaterThan(HARBOR_SPAWN.r);
    expect(Math.min(...HARBOR_PIERS.map((p) => dist(p, HARBOR_GALLEY)))).toBeLessThanOrEqual(4);
    expect(map.pois.find((p) => p.id === "galley")).toMatchObject({ kind: "galley", pos: HARBOR_GALLEY });
    // Every pier can still be walked to without crossing the galley's doorstep.
    for (const pier of HARBOR_PIERS) expect(harborPath(map, HARBOR_SPAWN, pier)!.some((p) => key(p) === key(HARBOR_GALLEY))).toBe(false);
  });

  it("is a round island: sea on every side, room for the town, and hut plots that are not laid out in rows", () => {
    const land = map.tiles.filter((t) => t.biome !== "water" && t.biome !== "dock");
    const col = (t: Hex) => t.q + Math.floor(t.r / 2);
    // No land on the map's border, so the sea goes all the way round.
    for (const t of land) {
      expect(t.r).toBeGreaterThan(0);
      expect(t.r).toBeLessThan(HARBOR_GRID.rows - 1);
      expect(col(t)).toBeGreaterThan(0);
      expect(col(t)).toBeLessThan(HARBOR_GRID.cols - 2);
    }
    // About as wide as it is deep (a row is 0.866 of a column).
    const wide = Math.max(...land.map(col)) - Math.min(...land.map(col));
    const deep = (Math.max(...land.map((t) => t.r)) - Math.min(...land.map((t) => t.r))) * 0.866;
    expect(Math.abs(wide - deep)).toBeLessThan(2);
    // A town, not a hamlet: some twenty hexes across, and most of it still open ground to walk on.
    expect(wide).toBeGreaterThanOrEqual(18);
    expect(land.filter((t) => !t.built).length).toBeGreaterThan(land.length * 0.8);
    // The plots are scattered: no row holds more than three of them, and no two huts touch.
    const perRow = new Map<number, number>();
    for (const p of HARBOR_PLOTS) perRow.set(p.r, (perRow.get(p.r) ?? 0) + 1);
    expect(Math.max(...perRow.values())).toBeLessThanOrEqual(3);
    expect(perRow.size).toBeGreaterThanOrEqual(6);
    for (const a of HARBOR_PLOTS) for (const b of HARBOR_PLOTS) if (a !== b) expect(dist(a, b)).toBeGreaterThanOrEqual(3);
  });

  it("stands the lighthouse on the south-east point over the wreck, reachable and clear of every other place", () => {
    const taken = [...HARBOR_PLOTS, ...HARBOR_PIERS, HARBOR_BOARD, HARBOR_SHOP, HARBOR_RING, HARBOR_SPAWN, HARBOR_WORKS, HARBOR_APOTHECARY, HARBOR_SMITHY, HARBOR_GALLEY, ...Object.values(HARBOR_GATHER)];
    expect(taken.some((p) => key(p) === key(HARBOR_LIGHTHOUSE))).toBe(false);
    expect(map.pois.find((p) => p.id === "lighthouse")).toMatchObject({ kind: "lighthouse", pos: HARBOR_LIGHTHOUSE });
    // On the shore, not the plaza: bare ground, south and east of the heart, with the sea beside the tower and the wreck against it.
    expect(tileAt(map, HARBOR_LIGHTHOUSE)!.biome).toBe("mud");
    const tower = footing(HARBOR_LIGHTHOUSE, "flower");
    for (const p of tower) expect(tileAt(map, p)!.biome).toBe("mud");
    expect(HARBOR_LIGHTHOUSE.r).toBeGreaterThan(HARBOR_SPAWN.r + 6);
    expect(HARBOR_LIGHTHOUSE.q + HARBOR_LIGHTHOUSE.r / 2).toBeGreaterThan(HARBOR_SPAWN.q + HARBOR_SPAWN.r / 2 + 5);
    expect(Math.min(...tower.map((p) => dist(p, HARBOR_WRECK)))).toBe(1);
    expect(tower.some((p) => around(p).some((n) => tileAt(map, n)?.biome === "water"))).toBe(true);
    expect(harborPath(map, HARBOR_SPAWN, HARBOR_LIGHTHOUSE)!.at(-1)).toEqual(HARBOR_LIGHTHOUSE);
  });
});
