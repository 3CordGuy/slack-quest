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
