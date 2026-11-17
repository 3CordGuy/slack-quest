import { describe, expect, it } from "vitest";
import { HAGGLE_ASKS, KEEPER_PLACES, KEEPER_SHOPS, forgeStock, haggleChance, haggleLine, haggleOutcome, haggledPrice, keeperPath, keeperRoom, smithyCost } from "./index";

describe("the keepers' rooms", () => {
  it("lets a customer walk from the door to the keeper in both shops, around the fittings", () => {
    for (const shop of KEEPER_SHOPS) {
      const room = keeperRoom(shop);
      const door = room.pois.find((p) => p.kind === "door")!.pos;
      const place = KEEPER_PLACES[shop];
      expect(keeperPath(shop, room, door, place.stand)).not.toBeNull();
      // The keeper's own spot and the fittings are walked around.
      expect(keeperPath(shop, room, door, place.keeperPos)).toBeNull();
      for (const f of place.fittings) {
        expect(room.tiles.find((t) => t.q === f.q && t.r === f.r)?.biome).toBe("floor");
        expect(keeperPath(shop, room, door, f)).toBeNull();
      }
    }
  });
});

describe("haggling", () => {
  it("is less likely the more is asked, and better for a Bard, and never certain", () => {
    const chances = HAGGLE_ASKS.map((a) => haggleChance(a.id, "qa_paladin"));
    expect([...chances].sort((a, b) => b - a)).toEqual(chances);
    expect(haggleChance("push", "frontend_bard")).toBeGreaterThan(haggleChance("push", "qa_paladin"));
    for (const a of HAGGLE_ASKS) for (const c of ["qa_paladin", "frontend_bard"]) expect(haggleChance(a.id, c)).toBeGreaterThan(0), expect(haggleChance(a.id, c)).toBeLessThan(100);
  });

  it("takes off what was asked when the roll is under the chance, and nothing otherwise", () => {
    expect(haggleOutcome("nudge", "qa_paladin", 0)).toEqual({ ask: "nudge", pct: 10 });
    expect(haggleOutcome("nudge", "qa_paladin", 99.9)).toEqual({ ask: "nudge", pct: 0 });
    expect(haggleLine("smithy", { ask: "lowball", pct: 35 }, 3)).toBeTruthy();
  });

  it("rounds in the keeper's favour and never below a gold piece", () => {
    expect(haggledPrice(28, 10)).toBe(26);
    expect(haggledPrice(1, 35)).toBe(1);
    expect(haggledPrice(0, 35)).toBe(0);
    expect(smithyCost({ kind: "weapon" }, 0, 20)).toEqual({ gold: 32, resources: { iron: 3 } });
    expect(smithyCost({ kind: "armor" }, 0, 20)).toEqual({ gold: 0, resources: { iron: 2, copper: 2 } });
  });
});

describe("the smith's rack", () => {
  it("is the same for the same customer and day, a weapon first and no trinkets", () => {
    const a = forgeStock("ann|2026-11-16", "qa_paladin", 4);
    expect(forgeStock("ann|2026-11-16", "qa_paladin", 4)).toEqual(a);
    expect(a).toHaveLength(4);
    expect(a[0].item.kind).toBe("weapon");
    for (const e of a) expect(e.item.kind).not.toBe("trinket");
    expect(new Set(a.map((e) => e.item.slot)).size).toBe(4);
  });
});
