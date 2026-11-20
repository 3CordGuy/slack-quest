import { describe, expect, it } from "vitest";
import { EMOTES, emoteTyped, validEmote, HARBOR_APOTHECARY, HARBOR_LAPIDARY, HARBOR_BOATS, HARBOR_BRIDGE, HARBOR_BUILDINGS, HARBOR_CAVE, HARBOR_CAVE_STEPS, HARBOR_CHEST, HARBOR_COURT, HARBOR_DECOR, HARBOR_FIXTURES, HARBOR_FORECOURT, HARBOR_GALLEY, HARBOR_MAX_PATH, HARBOR_GATE, HARBOR_GATHER, HARBOR_HEART_AT, HARBOR_HOME_ROADS, HARBOR_LIGHTHOUSE, HARBOR_MOLE, HARBOR_PUB, HARBOR_WAYGATE, HARBOR_WRECK, HARBOR_SMITHY, HARBOR_GRID, HARBOR_BOARD, HARBOR_PIERS, HARBOR_PLOTS, HARBOR_RING, HARBOR_SHOP, HARBOR_SPAWN, HARBOR_SQUARE, HARBOR_WORKS, HARBOR_OAK, HARBOR_ROADS, HARBOR_SIDES, findPath, footing, frontOf, generateHarbor, roadHexes, harborDoor, harborPath, tileAt } from "./index";

type Hex = { q: number; r: number };
const key = (p: Hex) => `${p.q},${p.r}`;
const dist = (a: Hex, b: Hex) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.q + a.r - b.q - b.r));
const around = (p: Hex) => [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]].map(([q, r]) => ({ q: p.q + q, r: p.r + r }));

describe("harbor map", () => {
  const map = generateHarbor();
  /** Every hex a hero stands on to use a place. */
  const doors = [...HARBOR_PLOTS, HARBOR_BOARD, HARBOR_SHOP, HARBOR_RING, HARBOR_PUB, HARBOR_WORKS, HARBOR_APOTHECARY, HARBOR_SMITHY, HARBOR_GALLEY, HARBOR_LIGHTHOUSE, HARBOR_CAVE, HARBOR_CHEST, HARBOR_LAPIDARY, HARBOR_WAYGATE, ...Object.values(HARBOR_GATHER)];
  /** The ground nobody walks through: under every building, and under the big pieces of the town's dressing. */
  const built = [...HARBOR_BUILDINGS.flatMap((b) => footing(b.door, b.shape, b.facing)), ...HARBOR_FIXTURES];

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
    // (The plaza is the court round the waygate, which hangs over its middle.)
    const open = new Set([...doors, HARBOR_SPAWN, ...HARBOR_COURT, ...HARBOR_PIERS].map(key));
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
    for (const id of ["pub", "works", "shop", "apothecary", "smithy", "galley", "lapidary"]) {
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

  it("rings the island with its places: each on the shoreline with the sea at its back, turned to face the waygate, a paved lane out to it, and nothing built inside the ring", () => {
    const square = new Set(HARBOR_SQUARE.map(key));
    const facing = (door: Hex) => HARBOR_BUILDINGS.find((b) => key(b.door) === key(door))!.facing;
    const fronts = (door: Hex, street: Set<string>) => frontOf(door, facing(door)).some((p) => street.has(key(p)));
    const hexes = (i: number) => roadHexes(HARBOR_ROADS[i]);
    const street = (i: number) => new Set(hexes(i).map(key));
    const far = (p: Hex) => Math.hypot(p.q + p.r / 2 - (HARBOR_GATE.q + HARBOR_GATE.r / 2), (p.r - HARBOR_GATE.r) * 0.866);
    /** The water's edge: the sea, a pier's planking, the quay's paving along it, or the cliff the caverns open in. */
    const quay = street(7);
    const edge = (p: Hex) => ["water", "dock", "rampart"].includes(tileAt(map, p)?.biome ?? "water") || quay.has(key(p));
    const places = HARBOR_BUILDINGS.filter((b) => !b.id.startsWith("plot") && !["waygate", "lighthouse", "fishing"].includes(b.id));
    expect(places.map((b) => b.id).sort()).toEqual(["apothecary", "board", "galley", "lapidary", "pub", "shop", "smithy", "townchest", "works"]);
    for (const b of places) {
      const ground = footing(b.door, b.shape, b.facing);
      // On the shoreline: its ground touches the water's edge. (The board, which is the pub's, stands beside the pub
      // a hex in from the strand.)
      if (b.id === "board") expect(ground.some((p) => around(p).some((n) => around(n).some(edge))), b.id).toBe(true);
      else expect(ground.some((p) => around(p).some(edge)), b.id).toBe(true);
      // Turned in: its door is on the side of it toward the gate, nearer the gate than any of its ground.
      expect(far(b.door), b.id).toBeLessThan(Math.min(...ground.map(far)));
    }
    // So are the places that were always on the shore, and the caverns' mouth is in the cliff.
    for (const id of ["lighthouse", "fishing"]) {
      const b = HARBOR_BUILDINGS.find((x) => x.id === id)!;
      expect(footing(b.door, b.shape, b.facing).some((p) => around(p).some(edge)), id).toBe(true);
    }
    expect(around(HARBOR_CAVE).some((p) => tileAt(map, p)?.biome === "rampart")).toBe(true);
    expect(around(HARBOR_RING).some(edge)).toBe(true);
    // Nothing built inside the ring: but for the gate itself, and the well and the keepers of the caverns (which
    // are dressing), no hex within five of the gate has anything standing on it, and no wall or wood is left there.
    const fixtures = new Set(HARBOR_FIXTURES.map(key));
    for (const t of map.tiles) {
      if (dist(t, HARBOR_GATE) > 5) continue;
      expect(["plains", "cobble", "mud"], key(t)).toContain(t.biome);
      if (t.built) expect(key(t) === key(HARBOR_GATE) || fixtures.has(key(t)), key(t)).toBe(true);
    }
    // The wall is only the cliff the caverns open in, and the woods only the felling copse: the rest of the shore is open.
    const col = (t: Hex) => t.q + Math.floor(t.r / 2);
    const town = map.tiles.filter((t) => col(t) < Math.min(...HARBOR_BRIDGE.map(col)));
    for (const t of town.filter((x) => x.biome === "rampart")) expect(dist(t, HARBOR_CAVE), key(t)).toBeLessThanOrEqual(6);
    for (const t of town.filter((x) => x.biome === "forest")) expect(dist(t, HARBOR_GATHER.felling), key(t)).toBeLessThanOrEqual(2);
    // They face five ways among them, and stand in every quarter about the gate.
    expect(new Set(places.map((b) => b.facing ?? 0)).size).toBeGreaterThanOrEqual(5);
    const quarters = new Set(places.filter((b) => b.shape !== "single").map((b) => `${b.door.q + b.door.r / 2 > HARBOR_GATE.q + HARBOR_GATE.r / 2 ? "east" : "west"} ${b.door.r > HARBOR_GATE.r ? "south" : "north"}`));
    expect(quarters.size).toBe(4);
    // A paved lane runs out to each, like a spoke: from the square's rim, or branching off the High Street or a road to the quay.
    const [west, east] = [street(0), street(1)];
    expect(square.has(key(hexes(0).at(-1)!))).toBe(true);
    expect(square.has(key(hexes(1)[0]))).toBe(true);
    for (const i of [4, 6]) expect(square.has(key(hexes(i)[0])), `road ${i}`).toBe(true);
    for (const i of [8, 9]) expect(east.has(key(hexes(i)[0])), `road ${i}`).toBe(true);
    for (const i of [10, 13]) expect(west.has(key(hexes(i)[0])), `road ${i}`).toBe(true);
    expect(street(3).has(key(hexes(11)[0]))).toBe(true);
    for (const i of [4, 6, 8, 9, 10, 11, 13]) expect(HARBOR_ROADS[i].kind, `road ${i}`).toBe("cobble");
    expect(fronts(HARBOR_SHOP, street(4))).toBe(true);
    expect(fronts(HARBOR_SMITHY, street(6))).toBe(true);
    expect(fronts(HARBOR_WORKS, street(8))).toBe(true);
    expect(fronts(HARBOR_PUB, street(8))).toBe(true);
    expect(fronts(HARBOR_BOARD, street(8))).toBe(true);
    expect(fronts(HARBOR_APOTHECARY, street(9))).toBe(true);
    expect(fronts(HARBOR_LAPIDARY, street(10))).toBe(true);
    expect(fronts(HARBOR_GALLEY, street(11))).toBe(true);
    expect(fronts(HARBOR_CHEST, street(13))).toBe(true);
    // The High Street runs shore to shore: the sparring ring on the strand at its west end, the bridge at its east.
    expect(key(hexes(0)[0])).toBe(key(HARBOR_RING));
    expect(dist(hexes(1).at(-1)!, HARBOR_BRIDGE[0])).toBe(1);
    // Round the shore: the board beside the pub; the Lapidary the next place round from the smithy, by the ring;
    // the chest the next round from the ring.
    expect(dist(HARBOR_BOARD, HARBOR_PUB)).toBeLessThanOrEqual(2);
    const lapidary = HARBOR_BUILDINGS.find((b) => b.id === "lapidary")!;
    expect(lapidary.shape).toBe("pair");
    expect(dist(HARBOR_LAPIDARY, HARBOR_SMITHY)).toBeLessThanOrEqual(5);
    expect(dist(HARBOR_LAPIDARY, HARBOR_RING)).toBeLessThanOrEqual(3);
    expect(map.pois.find((p) => p.id === "lapidary")).toMatchObject({ kind: "lapidary", pos: HARBOR_LAPIDARY });
    expect(dist(HARBOR_CHEST, HARBOR_RING)).toBeLessThanOrEqual(3);
    // Gaps between neighbours all the way round: no two places' ground touches.
    const all = HARBOR_BUILDINGS.filter((b) => !b.id.startsWith("plot") && b.id !== "waygate");
    for (const a of all) for (const b of all) {
      if (a.id >= b.id) continue;
      for (const p of footing(a.door, a.shape, a.facing)) for (const s of footing(b.door, b.shape, b.facing)) expect(dist(p, s), `${a.id} and ${b.id}`).toBeGreaterThanOrEqual(2);
    }
    expect(map.pois.find((p) => p.id === "apothecary")?.pos).toEqual(HARBOR_APOTHECARY);
    expect(map.pois.find((p) => p.id === "smithy")?.pos).toEqual(HARBOR_SMITHY);
  });

  it("leaves every place its own clear front: nothing built before a door, nothing standing on the line from a door to its street", () => {
    const stands = new Map<string, string>(HARBOR_BUILDINGS.flatMap((b) => footing(b.door, b.shape, b.facing).map((p) => [key(p), b.id] as [string, string])));
    for (const f of HARBOR_FIXTURES) stands.set(key(f), "a fixture");
    const where = (p: Hex, corner?: number) => {
      const x = Math.sqrt(3) * (p.q + p.r / 2), z = 1.5 * p.r;
      return corner === undefined ? { x, z } : { x: x + Math.sin((corner * Math.PI) / 3), z: z - Math.cos((corner * Math.PI) / 3) };
    };
    for (const b of HARBOR_BUILDINGS) {
      // The two hexes a door looks out between are open ground: no other place's building, and no well or statue.
      for (const p of frontOf(b.door, b.facing)) {
        expect(stands.get(key(p)), `${b.id}'s front`).toBeUndefined();
        expect(tileAt(map, p)?.built, `${b.id}'s front`).toBeFalsy();
      }
      // Nor is another place's doorstep its own building's front: neighbours stand side by side, not face to back.
      for (const other of HARBOR_BUILDINGS) if (other !== b) expect(footing(other.door, other.shape, other.facing).map(key), `${other.id} before ${b.id}`).not.toContain(key(b.door));
      // And no lamp, bench or planter stands on the point straight before the door, between those two hexes.
      const before = where(b.door, ((b.facing ?? 0) + 3) % 6);
      for (const d of HARBOR_DECOR) {
        const at = where(d.at, d.corner);
        expect(Math.hypot(at.x - before.x, at.z - before.z), `${d.kind} before ${b.id}`).toBeGreaterThan(0.5);
      }
    }
    // The notice board is beside the pub, in line with its front, and turned the way the pub is turned.
    const pub = HARBOR_BUILDINGS.find((b) => b.id === "pub")!;
    const board = HARBOR_BUILDINGS.find((b) => b.id === "board")!;
    const boardAt = footing(board.door, board.shape, board.facing)[0];
    expect(board.facing ?? 0).toBe(pub.facing ?? 0);
    expect(frontOf(pub.door, pub.facing).map(key)).not.toContain(key(boardAt));
    // In line with its front: along the row of hexes through the pub's door that runs across the way the pub faces,
    // one or two hexes from the door, and with open ground between it and the pub's wall.
    const across = [1, 4].map((turn) => HARBOR_SIDES[((pub.facing ?? 0) + turn) % 6]);
    const inLine = across.flatMap((d) => [1, 2].map((k) => key({ q: pub.door.q + d.q * k, r: pub.door.r + d.r * k })));
    expect(inLine).toContain(key(boardAt));
    expect(footing(pub.door, pub.shape, pub.facing).every((p) => dist(p, boardAt) >= 2)).toBe(true);
  });

  it("hides nothing usable behind a building: no door, station or gathering spot stands in a place's shadow as the view opens, or against its back", () => {
    // The Harbor opens seen from a little east of south, looking north-north-west and down. What a building hides is
    // the ground just behind it on that line: of the six hexes round each hex it stands on, the two to the north,
    // and the one two rows due north. The lighthouse's tower is far taller: three rows behind its middle.
    const behind = [{ q: 0, r: -1 }, { q: 1, r: -1 }, { q: 1, r: -2 }];
    const behindTower = [...behind, { q: 0, r: -2 }, { q: 0, r: -3 }, { q: 1, r: -3 }];
    const shadows = (b: (typeof HARBOR_BUILDINGS)[number]): Hex[] => {
      const ground = footing(b.door, b.shape, b.facing);
      if (b.id === "lighthouse") {
        const middle = ground.find((p) => ground.filter((o) => dist(o, p) === 1).length === 6)!;
        return behindTower.map((d) => ({ q: middle.q + d.q, r: middle.r + d.r }));
      }
      return ground.flatMap((p) => behind.map((d) => ({ q: p.q + d.q, r: p.r + d.r })));
    };
    /** Everything a hero goes to: every door and plot, the things read or opened from beside them, the gathering spots, the ring, the mouth of the caverns, the pier heads. */
    const usable: { what: string; at: Hex; of?: string }[] = [
      ...HARBOR_BUILDINGS.map((b) => ({ what: `${b.id}'s door`, at: b.door, of: b.id })),
      ...HARBOR_BUILDINGS.filter((b) => b.shape === "single").map((b) => ({ what: b.id, at: footing(b.door, b.shape, b.facing)[0], of: b.id })),
      ...Object.entries(HARBOR_GATHER).map(([what, at]) => ({ what, at, of: what })),
      { what: "the sparring ring", at: HARBOR_RING },
      { what: "the caverns' mouth", at: HARBOR_CAVE },
      ...HARBOR_PIERS.map((at, i) => ({ what: `pier ${i}`, at })),
    ];
    for (const b of HARBOR_BUILDINGS) {
      // (A thing on one hex, a chest or a board, is no taller than a hero: it hides nothing. And the huts on the
      // housing island are small and close together by design: this is the town's rule.)
      if (b.shape === "single" || b.id.startsWith("plot")) continue;
      const hidden = new Set(shadows(b).map(key));
      const ground = footing(b.door, b.shape, b.facing);
      for (const u of usable) {
        if (u.of === b.id) continue;
        expect(hidden.has(key(u.at)), `${u.what} behind ${b.id}`).toBe(false);
        // Nor does a gathering spot, the ring or a thing on its own hex stand against another building's wall.
        if (!u.what.endsWith("door")) for (const p of ground) expect(dist(p, u.at), `${u.what} against ${b.id}`).toBeGreaterThanOrEqual(2);
      }
    }
    // The felling copse stands in the open on the north-west shore, at the end of a track of its own, its trees
    // behind it and to the side as the view opens, not in front.
    const felling = HARBOR_GATHER.felling;
    expect(roadHexes(HARBOR_ROADS[14]).at(-1)).toEqual(felling);
    expect(HARBOR_ROADS[14].kind).toBe("dirt");
    const copse = map.tiles.filter((t) => t.biome === "forest" && dist(t, felling) <= 2 && key(t) !== key(felling));
    expect(copse.length).toBeGreaterThanOrEqual(2);
    for (const t of copse) expect(t.r, key(t)).toBeLessThanOrEqual(felling.r);
    expect(dist(felling, HARBOR_SMITHY)).toBeLessThanOrEqual(5);
  });

  it("keeps every walk within what one request may ask for, and the daily places a short walk from the gate", () => {
    const steps = (from: Hex, to: Hex) => harborPath(map, from, to)!.length;
    // The longest walk there is from where heroes arrive: to any door, plot, pier or gathering spot.
    const longest = Math.max(...[...doors, ...HARBOR_PIERS].filter((p) => key(p) !== key(HARBOR_SPAWN)).map((p) => steps(HARBOR_SPAWN, p)));
    expect(longest).toBeLessThanOrEqual(HARBOR_MAX_PATH - 10);
    // And from anywhere to anywhere among them: the far end of the housing island to the caverns, the fish shack to the last hut.
    for (const from of [HARBOR_CAVE, HARBOR_GATHER.fishing, HARBOR_LIGHTHOUSE, HARBOR_WORKS]) for (const to of HARBOR_PLOTS) expect(steps(from, to), `${key(from)} to ${key(to)}`).toBeLessThanOrEqual(HARBOR_MAX_PATH);
    // What a crew uses every day: the chest a few steps from where the gate is used, the stall and the board not many more.
    expect(steps(HARBOR_WAYGATE, HARBOR_CHEST)).toBeLessThanOrEqual(9);
    expect(steps(HARBOR_WAYGATE, HARBOR_SHOP)).toBeLessThanOrEqual(7);
    // (The board is the pub's, and the pub is on the far shore: it is the one daily thing that is a real walk.)
    expect(steps(HARBOR_WAYGATE, HARBOR_BOARD)).toBeLessThanOrEqual(11);
    expect(steps(HARBOR_SPAWN, HARBOR_WAYGATE)).toBe(1);
  });

  it("puts the galley on the quay by the piers, off the plots and the other places", () => {
    const taken = [...HARBOR_PLOTS, ...HARBOR_PIERS, HARBOR_BOARD, HARBOR_SHOP, HARBOR_RING, HARBOR_SPAWN, HARBOR_WORKS, HARBOR_APOTHECARY, HARBOR_SMITHY, ...Object.values(HARBOR_GATHER)];
    expect(taken.some((p) => key(p) === key(HARBOR_GALLEY))).toBe(false);
    // Down by the water: south of the plaza, its back to the quay, a short way from a pier.
    expect(HARBOR_GALLEY.r).toBeGreaterThan(HARBOR_SPAWN.r);
    const galley = HARBOR_BUILDINGS.find((b) => b.id === "galley")!;
    const stands = footing(galley.door, galley.shape, galley.facing);
    expect(Math.min(...HARBOR_PIERS.flatMap((p) => stands.map((s) => dist(p, s))))).toBeLessThanOrEqual(5);
    const quay = new Set(roadHexes(HARBOR_ROADS[7]).map(key));
    expect(stands.some((s) => around(s).some((p) => quay.has(key(p))))).toBe(true);
    expect(map.pois.find((p) => p.id === "galley")).toMatchObject({ kind: "galley", pos: HARBOR_GALLEY });
    // Every pier can still be walked to without crossing the galley's doorstep.
    for (const pier of HARBOR_PIERS) expect(harborPath(map, HARBOR_SPAWN, pier)!.some((p) => key(p) === key(HARBOR_GALLEY))).toBe(false);
  });

  it("is a round island with a smaller one east of it: sea on every side of both, room for the town on one, and every hut plot scattered over the other across a bridge", () => {
    const land = map.tiles.filter((t) => t.biome !== "water" && t.biome !== "dock");
    const col = (t: Hex) => t.q + Math.floor(t.r / 2);
    // No land on the map's border, so the sea goes all the way round.
    for (const t of land) {
      expect(t.r).toBeGreaterThan(0);
      expect(t.r).toBeLessThan(HARBOR_GRID.rows - 1);
      expect(col(t)).toBeGreaterThan(0);
      expect(col(t)).toBeLessThan(HARBOR_GRID.cols - 2);
    }
    // The town's island: about as wide as it is deep (a row is 0.866 of a column).
    const bridge = HARBOR_BRIDGE.map(col);
    const mid = (Math.min(...bridge) + Math.max(...bridge)) / 2;
    const town = land.filter((t) => col(t) < mid);
    const housing = land.filter((t) => col(t) > mid);
    expect(town.length + housing.length).toBe(land.length);
    const wide = Math.max(...town.map(col)) - Math.min(...town.map(col));
    const deep = (Math.max(...town.map((t) => t.r)) - Math.min(...town.map((t) => t.r))) * 0.866;
    expect(Math.abs((Math.max(...town.map(col)) + Math.min(...town.map(col))) / 2 - HARBOR_HEART_AT.col)).toBeLessThan(1.5);
    expect(Math.abs(wide - deep)).toBeLessThan(2);
    // A town, not a hamlet: some twenty hexes across, and most of it still open ground to walk on.
    expect(wide).toBeGreaterThanOrEqual(18);
    expect(land.filter((t) => !t.built).length).toBeGreaterThan(land.length * 0.8);
    // The housing island: smaller than the town's, round too, open water between the two, and no wall on it.
    const homeWide = Math.max(...housing.map(col)) - Math.min(...housing.map(col));
    const homeDeep = (Math.max(...housing.map((t) => t.r)) - Math.min(...housing.map((t) => t.r))) * 0.866;
    expect(Math.abs(homeWide - homeDeep)).toBeLessThan(2.5);
    expect(homeWide).toBeGreaterThanOrEqual(8);
    expect(homeWide).toBeLessThan(wide);
    expect(housing.some((t) => t.biome === "rampart")).toBe(false);
    for (const t of town) for (const h of housing) if (Math.abs(t.r - h.r) <= 1) expect(Math.abs(col(t) - col(h))).toBeGreaterThan(1);
    // The bridge: planking over the water from the end of the High Street, the only way across on foot.
    expect(HARBOR_BRIDGE.length).toBeGreaterThanOrEqual(2);
    for (const p of HARBOR_BRIDGE) expect(tileAt(map, p)!.biome).toBe("dock");
    const street = roadHexes(HARBOR_ROADS[1]);
    expect(dist(street.at(-1)!, HARBOR_BRIDGE[0])).toBe(1);
    expect(dist(HARBOR_BRIDGE.at(-1)!, roadHexes(HARBOR_HOME_ROADS[0])[1])).toBe(1);
    // Nobody lives in town: every plot is on the housing island, each walked to over the bridge.
    for (const plot of HARBOR_PLOTS) {
      expect(housing.some((t) => key(t) === key(plot)), key(plot)).toBe(true);
      const walk = harborPath(map, HARBOR_SPAWN, plot)!;
      expect(HARBOR_BRIDGE.every((p) => walk.some((w) => key(w) === key(p))), key(plot)).toBe(true);
    }
    for (const b of HARBOR_BUILDINGS) if (!b.id.startsWith("plot")) expect(town.some((t) => key(t) === key(b.door)), b.id).toBe(true);
    // Scattered, not set out with a ruler: the huts face at least four different ways, their doors lie on many
    // rows, and the paths wind (none runs straight for more than three steps).
    expect(new Set(HARBOR_BUILDINGS.filter((b) => b.id.startsWith("plot")).map((b) => b.facing ?? 0)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(HARBOR_PLOTS.map((p) => p.r)).size).toBeGreaterThanOrEqual(5);
    expect(HARBOR_HOME_ROADS).toHaveLength(4);
    for (const road of HARBOR_HOME_ROADS) {
      expect(road.kind).toBe("dirt");
      expect(new Set(road.steps).size, "a path that turns").toBeGreaterThanOrEqual(road.steps.length > 3 ? 2 : 1);
      for (let i = 0; i + 3 < road.steps.length; i++) expect(new Set(road.steps.slice(i, i + 4)).size).toBeGreaterThan(1);
    }
    // Room to breathe: no hut's ground touches another's.
    const huts = HARBOR_BUILDINGS.filter((b) => b.id.startsWith("plot")).map((b) => footing(b.door, b.shape, b.facing));
    huts.forEach((a, i) => huts.forEach((b, j) => i < j && a.forEach((p) => b.forEach((q) => expect(dist(p, q), `plot ${i} and plot ${j}`).toBeGreaterThanOrEqual(1)))));
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

  it("hangs the waygate in the middle of the square, with heroes arriving beside it and a paved court all round it", () => {
    const gate = HARBOR_BUILDINGS.find((b) => b.id === "waygate")!;
    expect(map.pois.find((p) => p.id === "waygate")).toMatchObject({ kind: "waygate", pos: HARBOR_WAYGATE });
    expect(footing(gate.door, gate.shape, gate.facing)).toEqual([HARBOR_GATE]);
    expect(harborDoor(HARBOR_GATE)).toEqual(HARBOR_WAYGATE);
    // The square is the gate's hex and the two rings round it: nineteen hexes, all cobbled, and nothing in it but the gate.
    expect(HARBOR_SQUARE).toHaveLength(19);
    for (const p of HARBOR_SQUARE) {
      expect(tileAt(map, p)!.biome, key(p)).toBe("cobble");
      expect(!!tileAt(map, p)!.built, key(p)).toBe(key(p) === key(HARBOR_GATE));
    }
    // Used constantly: heroes arrive beside the gate, and where they stand to step through is beside both.
    expect(dist(HARBOR_SPAWN, HARBOR_GATE)).toBe(1);
    expect(dist(HARBOR_WAYGATE, HARBOR_GATE)).toBe(1);
    expect(dist(HARBOR_WAYGATE, HARBOR_SPAWN)).toBe(1);
    // Both on the south side of it, which the view opens from: nobody stands hidden behind the gate.
    expect(HARBOR_SPAWN.r).toBeGreaterThan(HARBOR_GATE.r);
    expect(HARBOR_WAYGATE.r).toBeGreaterThan(HARBOR_GATE.r);
    // The court: the six hexes round the gate, all level, every one of them open.
    expect(HARBOR_COURT).toHaveLength(6);
    for (const p of HARBOR_COURT) {
      expect(dist(p, HARBOR_GATE)).toBe(1);
      expect(tileAt(map, p)!.h).toBe(tileAt(map, HARBOR_GATE)!.h);
      expect(harborPath(map, HARBOR_SPAWN, p) ?? [HARBOR_SPAWN]).toContainEqual(p);
    }
    // Every street starts from the square's rim: the High Street's two halves, the two roads to the quay (which
    // reach its paving), the walk to the galley, the lane to the caverns and the builders' lane.
    const square = new Set(HARBOR_SQUARE.map(key));
    const quay = new Set(roadHexes(HARBOR_ROADS[7]).map(key));
    for (const i of [0, 1, 2, 3, 4, 5, 6]) {
      const hexes = roadHexes(HARBOR_ROADS[i]);
      const end = i === 0 ? hexes.at(-1)! : hexes[0];
      expect(dist(end, HARBOR_GATE), `road ${i}`).toBe(2);
      expect(square.has(key(end))).toBe(true);
    }
    for (const road of [HARBOR_ROADS[2], HARBOR_ROADS[3]]) expect(around(roadHexes(road).at(-1)!).some((p) => quay.has(key(p)))).toBe(true);
    expect(roadHexes(HARBOR_ROADS[5]).at(-1)).toEqual(HARBOR_CAVE);
  });

  it("paves the quay along the water from the west pier to the lighthouse's point, with the crane on a mole of its own", () => {
    const quay = roadHexes(HARBOR_ROADS[7]);
    expect(HARBOR_ROADS[7].kind).toBe("cobble");
    for (const p of quay) {
      expect(tileAt(map, p)!.biome).toBe("cobble");
      expect(tileAt(map, p)!.built).toBeFalsy();
      // The water's edge: the sea, a pier or the mole is beside every hex of it.
      expect(around(p).some((n) => ["water", "dock"].includes(tileAt(map, n)!.biome) || key(n) === key(HARBOR_MOLE)), key(p)).toBe(true);
    }
    // Every pier is stepped onto straight off the quay, and the lighthouse's door is beside its east end.
    for (const pier of HARBOR_PIERS) {
      const walk = harborPath(map, HARBOR_SPAWN, pier)!;
      const first = walk.findIndex((p) => tileAt(map, p)!.biome === "dock");
      expect(quay.map(key)).toContain(key(walk[first - 1]));
    }
    expect(dist(quay.at(-1)!, HARBOR_LIGHTHOUSE)).toBe(1);
    // The mole: stone built out into the harbour, the sea on its other sides, and the crane filling it.
    const mole = tileAt(map, HARBOR_MOLE)!;
    expect(mole.biome).toBe("cobble");
    expect(mole.built).toBe(true);
    expect(around(HARBOR_MOLE).filter((p) => tileAt(map, p)!.biome === "water").length).toBeGreaterThanOrEqual(3);
    expect(HARBOR_DECOR.find((d) => d.kind === "crane")?.at).toEqual(HARBOR_MOLE);
    // It fouls no mooring: no pier or its head is beside it.
    for (const pier of HARBOR_PIERS) expect(dist(pier, HARBOR_MOLE)).toBeGreaterThan(1);
  });

  it("raises a paved forecourt under the caverns' mouth, with the lane climbing to it by two steps", () => {
    const street = tileAt(map, HARBOR_SPAWN)!.h;
    const court = HARBOR_FORECOURT.map((p) => tileAt(map, p)!);
    for (const t of court) {
      expect(t.biome).toBe("cobble");
      expect(t.h).toBe(court[0].h);
    }
    expect(court[0].h).toBeGreaterThan(street);
    // Under the mouth: the mouth opens onto it, and it is lower than the rock the mouth is cut into.
    expect(HARBOR_FORECOURT.filter((p) => dist(p, HARBOR_CAVE) === 1).length).toBeGreaterThanOrEqual(2);
    expect(court[0].h).toBeLessThan(tileAt(map, HARBOR_CAVE)!.h);
    // The steps: each higher than the last, the top one below the forecourt, and the lane runs over both.
    const lane = roadHexes(HARBOR_ROADS[5]).map(key);
    const steps = HARBOR_CAVE_STEPS.map((p) => tileAt(map, p)!);
    expect(steps.map((t) => t.biome)).toEqual(["cobble", "cobble"]);
    expect(steps[0].h).toBeGreaterThan(street);
    expect(steps[1].h).toBeGreaterThan(steps[0].h);
    expect(court[0].h).toBeGreaterThan(steps[1].h);
    for (const p of HARBOR_CAVE_STEPS) expect(lane).toContain(key(p));
    expect(HARBOR_FORECOURT.some((p) => lane.includes(key(p)))).toBe(true);
    // A stone figure stands either side of it, the same distance from the mouth.
    const figures = HARBOR_DECOR.filter((d) => d.kind === "statue");
    expect(figures).toHaveLength(2);
    for (const f of figures) expect(HARBOR_FORECOURT.map(key)).toContain(key(f.at));
    expect(dist(figures[0].at, HARBOR_CAVE)).toBe(dist(figures[1].at, HARBOR_CAVE));
    // The walk up from the square goes over the steps and the forecourt to the mouth.
    const walk = harborPath(map, HARBOR_SPAWN, HARBOR_CAVE)!.map(key);
    expect(walk.some((k) => HARBOR_FORECOURT.map(key).includes(k))).toBe(true);
  });

  it("dresses the town without getting in anyone's way: small things on the corners of hexes, big ones on a hex of their own", () => {
    const fixtures = new Set(HARBOR_FIXTURES.map(key));
    const roads = new Set(HARBOR_ROADS.flatMap(roadHexes).map(key));
    const taken = new Set([...doors, HARBOR_SPAWN, ...around(HARBOR_SPAWN), ...HARBOR_PIERS, ...HARBOR_BUILDINGS.flatMap((b) => footing(b.door, b.shape, b.facing))].map(key));
    // Not a scatter: a few dozen pieces for the whole town, and most of those the housing island's gardens, the
    // bridge's rail and the stones of the gate's court.
    expect(HARBOR_DECOR.length).toBeGreaterThan(30);
    expect(HARBOR_DECOR.length).toBeLessThan(70);
    expect(HARBOR_DECOR.filter((d) => !["garden", "railpost", "pillar", "pillar_broken", "stump"].includes(d.kind)).length).toBeLessThan(40);
    const spots = new Set<string>();
    for (const d of HARBOR_DECOR) {
      const t = tileAt(map, d.at);
      expect(t, `${d.kind} ${key(d.at)}`).toBeTruthy();
      expect(t!.biome, `${d.kind} ${key(d.at)}`).not.toBe("water");
      // No two pieces on the same spot.
      const spot = `${key(d.at)}:${d.corner ?? "middle"}`;
      expect(spots.has(spot), spot).toBe(false);
      spots.add(spot);
      if (d.corner === undefined) {
        // In the middle of a hex: it fills the hex, which is nobody's door, no road, and not where anyone arrives.
        expect(fixtures.has(key(d.at)), `${d.kind} ${key(d.at)}`).toBe(true);
        expect(t!.built).toBe(true);
        expect(taken.has(key(d.at)), key(d.at)).toBe(false);
        expect(roads.has(key(d.at)), key(d.at)).toBe(false);
        expect(harborPath(map, HARBOR_SPAWN, d.at)).toBeNull();
        expect(harborDoor(d.at)).toBeNull();
      } else {
        expect(Number.isInteger(d.corner) && d.corner >= 0 && d.corner < 6, spot).toBe(true);
        // On a corner: the hex it is given by is open ground, not the sea's side of a wall or the inside of a building.
        expect(t!.biome, spot).not.toBe("rampart");
      }
    }
    // Where each piece stands on the ground, a hex being a unit from its middle to a corner (a corner is three
    // hexes' corner: the same point whichever of them names it).
    const where = (d: (typeof HARBOR_DECOR)[number]) => {
      const x = Math.sqrt(3) * (d.at.q + d.at.r / 2), z = 1.5 * d.at.r;
      return d.corner === undefined ? { x, z } : { x: x + Math.sin((d.corner * Math.PI) / 3), z: z - Math.cos((d.corner * Math.PI) / 3) };
    };
    const places = HARBOR_DECOR.map(where);
    places.forEach((a, i) => places.forEach((b, j) => i < j && expect(Math.hypot(a.x - b.x, a.z - b.z), `${HARBOR_DECOR[i].kind} and ${HARBOR_DECOR[j].kind}`).toBeGreaterThan(0.5)));
    // Nothing tall stands by the hex everyone arrives on, or by the one they use the gate from: only the court's
    // own stones are on their corners, and none of those a whole one. The view of both is clear.
    for (const hex of [HARBOR_SPAWN, HARBOR_WAYGATE]) {
      const mid = where({ kind: "lamp", at: hex });
      places.forEach((p, i) => {
        if (Math.hypot(p.x - mid.x, p.z - mid.z) > 1.2) return;
        expect(["pillar_broken", "stump"], `${HARBOR_DECOR[i].kind} by ${key(hex)}`).toContain(HARBOR_DECOR[i].kind);
      });
    }
    // The court's stones: one on each of its six corners, each two hexes' breadth from the gate.
    const gateAt = where({ kind: "lamp", at: HARBOR_GATE });
    const stones = places.filter((p, i) => ["pillar", "pillar_broken", "stump"].includes(HARBOR_DECOR[i].kind) && Math.abs(Math.hypot(p.x - gateAt.x, p.z - gateAt.z) - 2) < 0.01);
    expect(stones).toHaveLength(6);
    // The fixtures cut nothing off: every door, plot and pier is still walked to (the walk test above), and so is every hex beside one.
    for (const f of HARBOR_FIXTURES) {
      const open = around(f).filter((p) => {
        const t = tileAt(map, p);
        return t && !t.built && !t.blocker && !["water", "rampart"].includes(t.biome);
      });
      expect(open.length, key(f)).toBeGreaterThanOrEqual(2);
      for (const p of open) expect(harborPath(map, HARBOR_SPAWN, p), key(p)).not.toBeNull();
    }
    // A well on the green between the roads to the quay, lamps along the streets and the quay.
    expect(HARBOR_DECOR.filter((d) => d.kind === "well")).toHaveLength(1);
    // A well on the open green between the square and the places at the edge, lamps along the streets and the quay.
    const well = HARBOR_DECOR.find((d) => d.kind === "well")!.at;
    expect(tileAt(map, well)!.biome).toBe("plains");
    expect(dist(well, HARBOR_GATE)).toBeGreaterThan(2);
    expect(dist(well, HARBOR_GATE)).toBeLessThanOrEqual(5);
    // Lamps only where one would stand: a dozen at most, one of them at every pier head and each end of the bridge.
    const lampAt = HARBOR_DECOR.filter((d) => d.kind === "lamp").map((d) => d.at);
    expect(lampAt.length).toBeGreaterThanOrEqual(6);
    expect(lampAt.length).toBeLessThanOrEqual(12);
    for (const pier of HARBOR_PIERS) expect(lampAt.map(key)).toContain(key(pier));
    expect(lampAt.filter((p) => HARBOR_BRIDGE.some((b) => dist(b, p) === 1))).toHaveLength(2);
  });

  it("floats every small boat on the water beside a pier or the quay, clear of the ships' moorings", () => {
    expect(HARBOR_BOATS.length).toBeGreaterThanOrEqual(1);
    expect(HARBOR_BOATS.length).toBeLessThanOrEqual(3);
    const quay = new Set(roadHexes(HARBOR_ROADS[7]).map(key));
    for (const boat of HARBOR_BOATS) {
      // On water, never on land or sand; and alongside planking or the quay's paving, to be made fast to.
      expect(tileAt(map, boat.at)!.biome, key(boat.at)).toBe("water");
      expect(around(boat.at).some((p) => tileAt(map, p)?.biome === "dock" || quay.has(key(p))), key(boat.at)).toBe(true);
      // A ship lies in the water beyond each pier head: no boat is moored there, or under a pier head's own planking.
      for (const pier of HARBOR_PIERS) {
        expect(boat.at.r, key(boat.at)).toBeLessThanOrEqual(pier.r);
        expect(key(boat.at)).not.toBe(key({ q: pier.q, r: pier.r + 1 }));
        expect(key(boat.at)).not.toBe(key({ q: pier.q - 1, r: pier.r + 1 }));
      }
      // And no two share a berth.
      expect(HARBOR_BOATS.filter((b) => dist(b.at, boat.at) < 2)).toHaveLength(1);
    }
    // Nothing boat-shaped is left lying on the land.
    expect(HARBOR_DECOR.some((d) => (d.kind as string) === "skiff")).toBe(false);
  });

  it("takes a track from the end of the pub's lane up the east side to the quarry", () => {
    const lane = roadHexes(HARBOR_ROADS[12]);
    expect(lane[0]).toEqual(roadHexes(HARBOR_ROADS[8]).at(-1));
    expect(lane.at(-1)).toEqual(HARBOR_GATHER.quarry);
    const walk = harborPath(map, HARBOR_SPAWN, HARBOR_GATHER.quarry)!;
    expect(walk.at(-1)).toEqual(HARBOR_GATHER.quarry);
    for (const p of lane.slice(0, -1)) expect(tileAt(map, p)!.path || tileAt(map, p)!.biome === "cobble", key(p)).toBeTruthy();
  });
});

describe("emotes", () => {
  it("knows its emotes and nothing else", () => {
    for (const e of EMOTES) expect(validEmote(e)).toBe(e);
    expect(validEmote("moonwalk")).toBeNull();
    expect(validEmote(undefined)).toBeNull();
    expect(validEmote(["wave"])).toBeNull();
  });

  it("reads an emote typed into chat", () => {
    expect(emoteTyped("/wave")).toBe("wave");
    expect(emoteTyped("  /DANCE ")).toBe("dance");
    expect(emoteTyped("/breakdance")).toBe("breakdance");
    expect(emoteTyped("/runningman")).toBe("runningman");
    expect(emoteTyped("/dab")).toBe("dab");
    expect(emoteTyped("/bow please")).toBeNull();
    expect(emoteTyped("wave")).toBeNull();
    expect(emoteTyped("/shrug")).toBeNull();
  });
});
