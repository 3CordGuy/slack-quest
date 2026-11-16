import { describe, expect, it } from "vitest";
import { HARBOR_APOTHECARY, HARBOR_BUILDINGS, HARBOR_CAVE, HARBOR_GALLEY, HARBOR_GATHER, HARBOR_LIGHTHOUSE, HARBOR_PUB, HARBOR_WRECK, HARBOR_SMITHY, HARBOR_GRID, HARBOR_BOARD, HARBOR_PIERS, HARBOR_PLOTS, HARBOR_RING, HARBOR_SHOP, HARBOR_SPAWN, HARBOR_WORKS, HARBOR_OAK, HARBOR_ROADS, HARBOR_SIDES, findPath, footing, frontOf, generateHarbor, roadHexes, harborDoor, harborPath, tileAt } from "./index";

type Hex = { q: number; r: number };
const key = (p: Hex) => `${p.q},${p.r}`;
const dist = (a: Hex, b: Hex) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.q + a.r - b.q - b.r));
const around = (p: Hex) => [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]].map(([q, r]) => ({ q: p.q + q, r: p.r + r }));

describe("harbor map", () => {
  const map = generateHarbor();
  /** Every hex a hero stands on to use a place. */
  const doors = [...HARBOR_PLOTS, HARBOR_BOARD, HARBOR_SHOP, HARBOR_RING, HARBOR_PUB, HARBOR_WORKS, HARBOR_APOTHECARY, HARBOR_SMITHY, HARBOR_GALLEY, HARBOR_LIGHTHOUSE, HARBOR_CAVE, ...Object.values(HARBOR_GATHER)];
  const built = HARBOR_BUILDINGS.flatMap((b) => footing(b.door, b.shape, b.facing));

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
    for (const b of HARBOR_BUILDINGS) for (const p of footing(b.door, b.shape, b.facing)) expect(tileAt(map, p)!.h).toBe(tileAt(map, b.door)!.h);
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
    for (const b of HARBOR_BUILDINGS) for (const p of footing(b.door, b.shape, b.facing)) expect(harborDoor(p)).toEqual(b.door);
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
      for (const pos of [b.door, ...footing(b.door, b.shape, b.facing)]) expect(tileAt(map, pos)?.biome, id).toBe("cobble");
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

  it("puts the apothecary on the High Street with the market stall and the smithy by the sparring ring, off the plots", () => {
    const plots = new Set(HARBOR_PLOTS.map(key));
    for (const spot of [HARBOR_APOTHECARY, HARBOR_SMITHY]) expect(plots.has(key(spot))).toBe(false);
    const highStreet = new Set(roadHexes(HARBOR_ROADS[0]).map(key));
    const facing = (door: Hex) => HARBOR_BUILDINGS.find((b) => key(b.door) === key(door))!.facing;
    for (const spot of [HARBOR_APOTHECARY, HARBOR_SHOP, HARBOR_PUB]) expect(frontOf(spot, facing(spot)).some((p) => highStreet.has(key(p)))).toBe(true);
    // The pub's front is to the south, toward the view the Harbor opens on; the apothecary faces it across the street.
    expect(facing(HARBOR_PUB) ?? 0).toBe(0);
    expect(facing(HARBOR_APOTHECARY)).toBe(3);
    expect(dist(HARBOR_SMITHY, HARBOR_RING)).toBeLessThanOrEqual(4);
    expect(map.pois.find((p) => p.id === "apothecary")?.pos).toEqual(HARBOR_APOTHECARY);
    expect(map.pois.find((p) => p.id === "smithy")?.pos).toEqual(HARBOR_SMITHY);
  });

  it("puts the galley on the quay by the piers, off the plots and the other places", () => {
    const taken = [...HARBOR_PLOTS, ...HARBOR_PIERS, HARBOR_BOARD, HARBOR_SHOP, HARBOR_RING, HARBOR_SPAWN, HARBOR_WORKS, HARBOR_APOTHECARY, HARBOR_SMITHY, ...Object.values(HARBOR_GATHER)];
    expect(taken.some((p) => key(p) === key(HARBOR_GALLEY))).toBe(false);
    // Down by the water: south of the plaza, a short walk from a pier.
    expect(HARBOR_GALLEY.r).toBeGreaterThan(HARBOR_SPAWN.r);
    expect(Math.min(...HARBOR_PIERS.map((p) => dist(p, HARBOR_GALLEY)))).toBeLessThanOrEqual(5);
    expect(map.pois.find((p) => p.id === "galley")).toMatchObject({ kind: "galley", pos: HARBOR_GALLEY });
    // Every pier can still be walked to without crossing the galley's doorstep.
    for (const pier of HARBOR_PIERS) expect(harborPath(map, HARBOR_SPAWN, pier)!.some((p) => key(p) === key(HARBOR_GALLEY))).toBe(false);
  });

  it("is a round island: sea on every side, room for the town, and hut plots spread along the lanes", () => {
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
    // The plots are spread over the town, not crowded in one corner, and no two share a doorstep or touch it.
    expect(new Set(HARBOR_PLOTS.map((p) => p.r)).size).toBeGreaterThanOrEqual(6);
    for (const a of HARBOR_PLOTS) for (const b of HARBOR_PLOTS) if (a !== b) expect(dist(a, b)).toBeGreaterThanOrEqual(2);
  });

  it("turns a building's ground about its door, a sixth at a time, with its front opposite", () => {
    const door = { q: 5, r: 5 };
    for (const shape of ["pair", "trio", "flower"] as const) {
      const sizes = new Set<number>();
      for (let facing = 0; facing < 6; facing++) {
        const ground = footing(door, shape, facing);
        sizes.add(ground.length);
        // Still touching the door on two sides, and never on the hexes in front of it.
        expect(ground.filter((p) => dist(p, door) === 1)).toHaveLength(2);
        for (const front of frontOf(door, facing)) {
          expect(dist(front, door)).toBe(1);
          expect(ground.map(key)).not.toContain(key(front));
        }
      }
      expect(sizes.size).toBe(1);
      // Six turns is all the way round.
      expect(footing(door, shape, 6)).toEqual(footing(door, shape, 0));
    }
    // Facing 0 stands north of the door, as it always has; half a turn stands it south.
    expect(footing(door, "pair", 0).every((p) => p.r < door.r)).toBe(true);
    expect(footing(door, "pair", 3).every((p) => p.r > door.r)).toBe(true);
  });

  it("fronts every building onto a road: the town's places onto cobbles, huts onto a dirt lane", () => {
    for (const b of HARBOR_BUILDINGS) {
      if (b.id === "lighthouse" || b.id === "fishing") continue;
      const front = frontOf(b.door, b.facing).map((p) => tileAt(map, p)!);
      if (b.id.startsWith("plot")) {
        // A path from the hut's doorstep out to the lane in front of it.
        const step = tileAt(map, b.door)!;
        expect(step.path, b.id).toBeTruthy();
        expect(front.some((t) => t.path || t.biome === "cobble"), b.id).toBe(true);
      } else expect(front.some((t) => t.biome === "cobble"), b.id).toBe(true);
    }
    for (const id of ["pub", "apothecary", "works", "galley"]) expect(map.pois.find((p) => p.id === id)?.facing, id).toBe(HARBOR_BUILDINGS.find((b) => b.id === id)!.facing || undefined);
  });

  it("stands one old oak on a hill at the back of the island, in tall grass, where nothing else is", () => {
    const top = tileAt(map, HARBOR_OAK)!;
    // The oak's own hex: grass, the highest ground on the island that is not wall or rock, and not to be walked onto.
    expect(top.biome).toBe("plains");
    expect(top.blocker).toBe("oak");
    expect(map.tiles.filter((t) => t.blocker).map(key)).toEqual([key(HARBOR_OAK)]);
    expect(harborPath(map, HARBOR_SPAWN, HARBOR_OAK)).toBeNull();
    expect(findPath(map, HARBOR_SPAWN, HARBOR_OAK)).toBeNull();
    // North of the plaza: the back of the island as it is first seen.
    expect(HARBOR_OAK.r).toBeLessThan(HARBOR_SPAWN.r - 5);
    // The hill round it: six hexes of open grass, each lower than the top and higher than the plain, all to be climbed.
    const ring = around(HARBOR_OAK).map((p) => tileAt(map, p)!);
    const plain = Math.max(...map.tiles.filter((t) => t.biome === "plains" && !t.grass).map((t) => t.h));
    for (const t of ring) {
      expect(t.biome).toBe("plains");
      expect(t.built || t.path || t.blocker).toBeFalsy();
      expect(t.h).toBeLessThan(top.h);
      expect(t.h).toBeGreaterThan(plain);
      expect(t.grass).toBe("tall");
      expect(harborPath(map, HARBOR_SPAWN, t)!.at(-1)).toEqual({ q: t.q, r: t.r });
    }
    // Tall grass runs on past the hill's foot, and is only ever on open grass.
    const tall = map.tiles.filter((t) => t.grass === "tall");
    expect(tall.length).toBeGreaterThan(12);
    for (const t of tall) {
      expect(t.biome).toBe("plains");
      expect(t.built).toBeFalsy();
    }
    // Nothing of the town is on the hill: no door, no plot, no building's ground.
    const hill = new Set([HARBOR_OAK, ...around(HARBOR_OAK)].map(key));
    for (const p of [...doors, ...built]) expect(hill.has(key(p)), key(p)).toBe(false);
  });

  it("joins its dirt paths: each side a path runs out through meets another path, or a street, the quay or the edge of the woods", () => {
    const paths = map.tiles.filter((t) => t.path);
    expect(paths.length).toBeGreaterThan(20);
    let junctions = 0;
    for (const t of paths) {
      expect(t.biome).toBe("plains");
      expect(t.built).toBeFalsy();
      let sides = 0;
      for (let side = 0; side < 6; side++) {
        if (!(t.path! & (1 << side))) continue;
        sides++;
        const n = tileAt(map, { q: t.q + HARBOR_SIDES[side].q, r: t.r + HARBOR_SIDES[side].r })!;
        if (n.path) expect(n.path & (1 << ((side + 3) % 6)), `${key(t)} -> ${key(n)}`).toBeTruthy();
        else expect(["cobble", "mud", "dock", "forest", "hills"]).toContain(n.biome);
      }
      if (sides >= 3) junctions++;
    }
    // The huts' doorsteps branch off the lanes: there are junctions, not only runs.
    expect(junctions).toBeGreaterThan(4);
    // Every road is laid where it says: a street's hexes are cobbled, a lane's grass ones are path.
    for (const road of HARBOR_ROADS)
      for (const p of roadHexes(road)) {
        const t = tileAt(map, p)!;
        if (road.kind === "cobble") expect(t.biome, key(p)).toBe("cobble");
        else if (t.biome === "plains") expect(t.path, key(p)).toBeTruthy();
      }
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
