import { describe, expect, it } from "vitest";
import { FISH } from "./fishcatalog";
import { FISH_BOARD_MS, FISH_RATE_MAX, FISH_RATE_MIN, FISH_WANTED, FISH_WANTED_BONUS, ICEBOX_G, TROPHY_SLOTS, fishBoard, fishSalePrice, iceboxProblem, stowCatch, trophyProblem } from "./fishmarket";

const T = 1_800_000_000_000;
const herring = { species: "herring", grams: 400, specimen: false };

describe("the fishmonger's board", () => {
  it("is the same for everyone in a crew through a slot, and changes with the next", () => {
    const a = fishBoard("CREW", T);
    expect(fishBoard("CREW", a.startsAt)).toEqual(a);
    expect(fishBoard("CREW", a.endsAt - 1)).toEqual(a);
    expect(fishBoard("CREW", a.endsAt)).not.toEqual(a);
    expect(fishBoard("OTHER", T)).not.toEqual(a);
    expect(a.endsAt - a.startsAt).toBe(FISH_BOARD_MS);
  });

  it("keeps every rate in range and wants a couple of everyday kinds", () => {
    for (let i = 0; i < 50; i++) {
      const b = fishBoard("CREW", T + i * FISH_BOARD_MS);
      for (const r of Object.values(b.rates)) {
        expect(r).toBeGreaterThanOrEqual(FISH_RATE_MIN);
        expect(r).toBeLessThanOrEqual(FISH_RATE_MAX);
      }
      expect(b.wanted).toHaveLength(FISH_WANTED);
      for (const id of b.wanted) {
        expect(["common", "uncommon"]).toContain(FISH[id].rarity);
        expect(FISH[id].water).not.toContain("sea");
      }
      expect(b.rates.ironjaw).toBeUndefined();
    }
  });

  it("pays more for a wanted kind", () => {
    const b = fishBoard("CREW", T);
    const id = b.wanted[0];
    const plain = { ...b, wanted: [] };
    const fish = { species: id, grams: 2000, specimen: false };
    expect(fishSalePrice(fish, "market", b)).toBeGreaterThanOrEqual(Math.round(fishSalePrice(fish, "market", plain)! * FISH_WANTED_BONUS) - 1);
  });
});

describe("buyers", () => {
  it("has Old Tam buy only what he can cook, at a price that does not move", () => {
    expect(fishSalePrice(herring, "tam", fishBoard("A", T))).toBe(fishSalePrice(herring, "tam", fishBoard("B", T + 5 * FISH_BOARD_MS)));
    expect(fishSalePrice({ species: "silver_king", grams: 30_000, specimen: true }, "tam", fishBoard("A", T))).toBeNull();
  });

  it("has the fishmonger take treasure at a flat price, and nothing for junk", () => {
    const b = fishBoard("A", T);
    expect(fishSalePrice({ species: "ships_bell", grams: 20_000, specimen: false }, "market", b)).toBeGreaterThan(0);
    expect(fishSalePrice({ species: "boot", grams: 900, specimen: false }, "market", b)).toBeNull();
  });
});

describe("keeping fish", () => {
  it("lets only specimens into the trophy chest, and only so many", () => {
    expect(trophyProblem({ species: "herring", specimen: false }, 0)).toMatch(/specimen/);
    expect(trophyProblem({ species: "bluefin", specimen: true }, 0)).toBeNull();
    expect(trophyProblem({ species: "bluefin", specimen: true }, TROPHY_SLOTS)).toMatch(/holds/);
    expect(trophyProblem({ species: "ships_bell", specimen: false }, 0)).toMatch(/Only fish/);
  });

  it("will not overfill the icebox", () => {
    expect(iceboxProblem({ species: "halibut", grams: 30_000 }, ICEBOX_G - 10_000)).toBeTruthy();
    expect(iceboxProblem({ species: "halibut", grams: 10_000 }, ICEBOX_G - 10_000)).toBeNull();
    expect(iceboxProblem({ species: "ships_bell", grams: 30_000 }, ICEBOX_G)).toBeNull();
  });

  it("stows a catch while there is room and sells the rest on the quay", () => {
    const b = fishBoard("A", T);
    const catches = [
      { species: "herring", grams: 400, specimen: false },
      { species: "halibut", grams: 40_000, specimen: true },
      { species: "silver_king", grams: 30_000, specimen: true },
      { species: "ships_bell", grams: 25_000, specimen: false },
    ];
    const { stowed, sold } = stowCatch(catches, 15_000, b);
    expect(stowed.map((f) => f.species)).toEqual(["herring", "halibut", "ships_bell"]);
    expect(sold).toHaveLength(1);
    expect(sold[0]).toMatchObject({ species: "silver_king", buyer: "market" });
    expect(sold[0].gold).toBeGreaterThan(0);
    // Something Tam cooks goes to him.
    const full = stowCatch([{ species: "pollock", grams: 3000, specimen: false }], ICEBOX_G, b);
    expect(full.sold[0].buyer).toBe("tam");
  });
});
