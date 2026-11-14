import { describe, expect, it } from "vitest";
import { BOOK_SLOTS, bookPage } from "./fishcatalog";
import { COUNTED_PAGES, PAGE_REWARD, biteHint, bookFull, bookProgress, bookRewards } from "./catchbook";
import { FURNISHINGS } from "./hut";

const all = (page: Parameters<typeof bookPage>[0]) => bookPage(page).map((f) => f.id);

describe("the Catch Book", () => {
  it("counts each page, and every page but the bonus towards a full book", () => {
    const shallows = new Set(all("shallows"));
    const p = bookProgress(shallows);
    expect(p.find((x) => x.page === "shallows")).toMatchObject({ have: 10, of: 10, done: true });
    expect(p.find((x) => x.page === "mouth")).toMatchObject({ have: 0, done: false });
    expect(COUNTED_PAGES.reduce((a, page) => a + bookPage(page).length, 0)).toBe(BOOK_SLOTS);
    const everything = new Set(COUNTED_PAGES.flatMap(all));
    expect(bookFull(everything)).toBe(true);
    expect(bookFull(new Set([...everything].slice(1)))).toBe(false);
  });

  it("rewards a page only on the catch that finishes it, and the book on the last", () => {
    const nine = new Set(all("shallows").slice(1));
    expect(bookRewards(new Set(), nine)).toEqual({ pages: [], full: false });
    expect(bookRewards(nine, new Set(all("shallows")))).toEqual({ pages: ["shallows"], full: false });
    expect(bookRewards(new Set(all("shallows")), new Set(all("shallows")))).toEqual({ pages: [], full: false });
    const everything = new Set(COUNTED_PAGES.flatMap(all));
    const lessOne = new Set([...everything].filter((id) => id !== "oarfish"));
    expect(bookRewards(lessOne, everything)).toEqual({ pages: ["sea"], full: true });
    expect(bookRewards(everything, new Set([...everything, "ironjaw"]))).toEqual({ pages: ["bonus"], full: false });
  });

  it("has a real wall piece for every page's reward", () => {
    for (const id of Object.values(PAGE_REWARD)) {
      expect(FURNISHINGS[id]?.mount, id).toBeTruthy();
      expect(FURNISHINGS[id].price, id).toBeUndefined();
    }
  });

  it("hints where each kind bites", () => {
    expect(biteHint("sailback")).toMatch(/by boat/);
    expect(biteHint("lingcod")).toMatch(/east pier/);
    expect(biteHint("boot")).toMatch(/anywhere/);
  });
});

describe("the pub's wall", () => {
  it("has a clear spot for every record fish, none of them behind the bar", async () => {
    const { pubMountSpots, PUB_FITTINGS } = await import("./pub");
    const { HEX_DIRS } = await import("./hutroom");
    const { PUB_MOUNT_SLOTS } = await import("./catchbook");
    const spots = pubMountSpots(PUB_MOUNT_SLOTS);
    expect(spots).toHaveLength(PUB_MOUNT_SLOTS);
    const fitted = new Set(PUB_FITTINGS.map((f) => `${f.q},${f.r}`));
    for (const s of spots) expect(fitted.has(`${s.pos.q + HEX_DIRS[s.side].q},${s.pos.r + HEX_DIRS[s.side].r}`)).toBe(false);
  });
});

describe("the pub's leaderboard", () => {
  it("stands against the back wall, across two faces, beside clear floor, and blocks no one's way", async () => {
    const { hexDistance } = await import("@gantt-quest/core");
    const { PUB_LEADERBOARD, PUB_DEALER_POS, PUB_DEALER_STAND, PUB_SALESMAN_POS, PUB_BARKEEP_POS, PUB_FITTINGS, PUB_DICE, PUB_SHOALS, PUB_CREW, PUB_COUNTER, PUB_TRADER, PUB_REGULAR_SPOTS, pubMountSpots, pubPath, pubRoom } = await import("./pub");
    const { HEX_DIRS, wallFaces } = await import("./hutroom");
    const { PUB_MOUNT_SLOTS } = await import("./catchbook");
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
    const stations = [PUB_DICE, PUB_SHOALS, PUB_CREW, PUB_COUNTER, PUB_TRADER, PUB_DEALER_STAND, ...PUB_REGULAR_SPOTS.map((s) => s.stand)];
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
