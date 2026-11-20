import { describe, expect, it } from "vitest";
import { hexDistance } from "@gantt-quest/core";
import {
  HEX_DIRS,
  PUB_BARKEEP_POS,
  PUB_COUNTER,
  PUB_CREW,
  PUB_DEALER_POS,
  PUB_DEALER_STAND,
  PUB_DICE,
  PUB_FITTINGS,
  PUB_GRID,
  PUB_LEADERBOARD,
  PUB_MENU,
  PUB_MOUNT_SLOTS,
  PUB_REGULAR_SPOTS,
  PUB_SALESMAN_POS,
  PUB_SEATS,
  PUB_SHOALS,
  PUB_TIDE,
  PUB_TRADER,
  hutGrid,
  poiAt,
  pubMountSpots,
  pubPath,
  pubRoom,
  tileAt,
  wallFaces,
} from "./index";

describe("the pub", () => {
  const room = pubRoom();
  const door = room.pois.find((p) => p.kind === "door")!.pos;

  it("is bigger than the largest hut", () => {
    const lodge = hutGrid(3);
    expect(PUB_GRID.cols).toBeGreaterThan(lodge.cols);
    expect(PUB_GRID.rows).toBeGreaterThan(lodge.rows);
  });

  it("stands its fittings and its barkeep on separate floor hexes", () => {
    const spots = [...PUB_FITTINGS, PUB_BARKEEP_POS, PUB_DEALER_POS, PUB_SALESMAN_POS, ...PUB_REGULAR_SPOTS.map((s) => s.pos)];
    for (const f of spots) expect(tileAt(room, f)?.biome, `${f.q},${f.r}`).toBe("floor");
    expect(new Set(spots.map((f) => `${f.q},${f.r}`)).size).toBe(spots.length);
  });

  it("lets a customer reach the counter and the dice table, but not the barkeep's side", () => {
    expect(pubPath(room, door, PUB_COUNTER)!.at(-1)).toEqual(PUB_COUNTER);
    expect(pubPath(room, door, PUB_DICE)!.at(-1)).toEqual(PUB_DICE);
    expect(pubPath(room, door, PUB_BARKEEP_POS)).toBeNull();
    expect(pubPath(room, door, PUB_FITTINGS[0])).toBeNull();
  });

  it("puts the dealer beside the pillar, with room in front to walk up", () => {
    const pillar = PUB_FITTINGS.find((f) => f.model === "pillar")!;
    expect(hexDistance(pillar, PUB_DEALER_POS)).toBe(1);
    expect(hexDistance(PUB_DEALER_STAND, PUB_DEALER_POS)).toBe(1);
    expect(poiAt(room, PUB_DEALER_STAND)?.kind).toBe("dealer");
    expect(pubPath(room, door, PUB_DEALER_STAND)!.at(-1)).toEqual(PUB_DEALER_STAND);
    expect(pubPath(room, door, PUB_DEALER_POS)).toBeNull();
  });

  it("lets a customer walk onto a free stool to sit, and not through one", () => {
    expect(PUB_SEATS.length).toBe(PUB_FITTINGS.filter((f) => f.model === "chair").length);
    for (const seat of PUB_SEATS) {
      const path = pubPath(room, door, seat)!;
      expect(path.at(-1), `${seat.q},${seat.r}`).toEqual(seat);
      expect(path.slice(0, -1).some((p) => PUB_SEATS.some((s) => s.q === p.q && s.r === p.r))).toBe(false);
      // Taken by someone else, it is furniture like any other; and whoever sat can walk away again.
      expect(pubPath(room, door, seat, [seat])).toBeNull();
      expect(pubPath(room, seat, door)).not.toBeNull();
    }
  });

  it("still lets a customer reach every place to stand", () => {
    for (const to of [PUB_COUNTER, PUB_DICE, PUB_SHOALS, PUB_CREW, PUB_TRADER, PUB_DEALER_STAND, ...PUB_REGULAR_SPOTS.map((s) => s.stand)]) {
      expect(pubPath(room, door, to), `${to.q},${to.r}`).not.toBeNull();
    }
  });

  it("sells two meals, at the prices they always had", () => {
    expect(PUB_MENU.map((i) => [i.id, i.price])).toEqual([["stew", 12], ["pie", 18]]);
  });
});

describe("the pub's wall", () => {
  it("has a clear spot for every record fish, none of them behind the bar", () => {
    const spots = pubMountSpots(PUB_MOUNT_SLOTS);
    expect(spots).toHaveLength(PUB_MOUNT_SLOTS);
    const fitted = new Set(PUB_FITTINGS.map((f) => `${f.q},${f.r}`));
    for (const s of spots) expect(fitted.has(`${s.pos.q + HEX_DIRS[s.side].q},${s.pos.r + HEX_DIRS[s.side].r}`)).toBe(false);
  });
});

describe("the pub's leaderboard", () => {
  it("stands against the back wall, across two faces, beside clear floor, and blocks no one's way", () => {
    const room = pubRoom();
    const { pos, stand } = PUB_LEADERBOARD;
    const k = (p: { q: number; r: number }) => `${p.q},${p.r}`;
    const step = (p: { q: number; r: number }, side: number) => ({ q: p.q + HEX_DIRS[side].q, r: p.r + HEX_DIRS[side].r });
    // Its two northern neighbours are back-wall hexes, each with a face onto it: the faces it stands across.
    const behind = [5, 0].map((side) => step(pos, side));
    expect(behind.every((w) => w.r === 0)).toBe(true);
    const faces = wallFaces(room).filter((f) => k(step(f.pos, f.side)) === k(pos));
    expect(faces).toHaveLength(2);
    // No record fish hangs on either face it covers.
    expect(pubMountSpots(PUB_MOUNT_SLOTS).filter((f) => k(step(f.pos, f.side)) === k(pos))).toEqual([]);
    const stations = [PUB_DICE, PUB_SHOALS, PUB_CREW, PUB_TIDE, PUB_COUNTER, PUB_TRADER, PUB_DEALER_STAND, ...PUB_REGULAR_SPOTS.map((s) => s.stand)];
    const taken = new Set([...PUB_FITTINGS, ...stations, ...PUB_REGULAR_SPOTS.map((s) => s.pos), PUB_DEALER_POS, PUB_SALESMAN_POS, PUB_BARKEEP_POS].map(k));
    expect(taken.has(k(pos))).toBe(false);
    expect(taken.has(k(stand))).toBe(false);
    expect(hexDistance(pos, stand)).toBe(1);
    // Not beside a regular: standing beside one gives a button on the hex too.
    for (const p of PUB_REGULAR_SPOTS.map((s) => s.pos)) expect(hexDistance(p, stand)).toBeGreaterThan(1);
    // It is walked around, and every place to stand can still be reached from the door.
    const door = room.pois.find((p) => p.kind === "door")!.pos;
    expect(pubPath(room, door, pos)).toBeNull();
    for (const p of [stand, ...stations]) expect(pubPath(room, door, p)).not.toBeNull();
  });
});
