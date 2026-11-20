import { describe, expect, it } from "vitest";
import { DISHES, HAGGLE_ASKS, HEX_DIRS, KEEPER_HOUSES, KEEPER_PLACES, KEEPER_SHOPS, POT_PRICES, isKeeperHouse, isKeeperShop, keeperWallPieces, potDish, potKey, forgeStock, haggleChance, haggleLine, haggleOutcome, haggledPrice, keeperPath, keeperRoom, smithyCost } from "./index";

describe("the keepers' rooms", () => {
  it("lets a customer walk from the door to the keeper in every one, around the fittings", () => {
    for (const shop of KEEPER_HOUSES) {
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

describe("the Lapidary", () => {
  it("is a keeper's room like the others, with a keeper of its own, and is not one of the crew's shops", () => {
    expect(KEEPER_HOUSES).toEqual([...KEEPER_SHOPS, "lapidary"]);
    expect(isKeeperHouse("lapidary")).toBe(true);
    // Nothing is haggled over there, and nobody had to build it.
    expect(isKeeperShop("lapidary")).toBe(false);
    const place = KEEPER_PLACES.lapidary;
    expect(place.title).toBe("The Lapidary");
    expect(place.keeper.id).toBe("keeper:lapidary");
    // Nobody shares a name or a look with her.
    for (const shop of KEEPER_SHOPS) {
      expect(KEEPER_PLACES[shop].keeper.name).not.toBe(place.keeper.name);
      expect(KEEPER_PLACES[shop].keeper.look).not.toBe(place.keeper.look);
    }
    // Her wheel is one of the fittings, and nothing stands on her spot or the customer's.
    expect(place.fittings.find((f) => f.id === place.work.fitting)?.model).toBe("lap_wheel");
    expect(new Set(place.fittings.map((f) => `${f.q},${f.r}`)).size).toBe(place.fittings.length);
    for (const f of place.fittings) for (const p of [place.keeperPos, place.stand]) expect(`${f.q},${f.r}`).not.toBe(`${p.q},${p.r}`);
  });

  it("hangs its lights round the walls, clear of the case and the shelves", () => {
    const room = keeperRoom("lapidary");
    const pieces = keeperWallPieces("lapidary");
    expect(pieces.map((p) => p.model)).toEqual(KEEPER_PLACES.lapidary.wall);
    expect(new Set(pieces.map((p) => `${p.pos.q},${p.pos.r},${p.side}`)).size).toBe(pieces.length);
    const tall = KEEPER_PLACES.lapidary.fittings.filter((f) => ["lodestone_case", "stone_shelf", "stone_shelf_lit"].includes(f.model)).map((f) => `${f.q},${f.r}`);
    expect(tall).toHaveLength(3);
    for (const p of pieces) {
      const front = { q: p.pos.q + HEX_DIRS[p.side].q, r: p.pos.r + HEX_DIRS[p.side].r };
      expect(room.tiles.find((t) => t.q === front.q && t.r === front.r)?.biome).toBe("floor");
      expect(tall).not.toContain(`${front.q},${front.r}`);
    }
  });
});

describe("the smithy's walls", () => {
  it("hangs each weapon and light on its own spot of a back or side wall, facing the floor and not over the forge or a rack", () => {
    const room = keeperRoom("smithy");
    const pieces = keeperWallPieces("smithy");
    expect(pieces).toHaveLength(KEEPER_PLACES.smithy.wall!.length);
    expect(new Set(pieces.map((p) => `${p.pos.q},${p.pos.r},${p.side}`)).size).toBe(pieces.length);
    const tall = KEEPER_PLACES.smithy.fittings.filter((f) => ["forge", "weapon_rack", "armor_stand"].includes(f.model)).map((f) => `${f.q},${f.r}`);
    for (const p of pieces) {
      expect(room.tiles.find((t) => t.q === p.pos.q && t.r === p.pos.r)?.biome).toBe("wall");
      const front = { q: p.pos.q + HEX_DIRS[p.side].q, r: p.pos.r + HEX_DIRS[p.side].r };
      expect(room.tiles.find((t) => t.q === front.q && t.r === front.r)?.biome).toBe("floor");
      expect(tall).not.toContain(`${front.q},${front.r}`);
    }
    // The apothecary's walls have only candles, hung lower than the smith's weapons.
    expect(keeperWallPieces("apothecary").map((p) => p.model)).toEqual(KEEPER_PLACES.apothecary.wall);
    for (const p of keeperWallPieces("smithy")) expect(p.y).toBe(p.model === "sconce" || p.model === "wall_lantern" ? 1.35 : 1.72);
  });
});

describe("the galley", () => {
  it("hangs its pans, onions and lights round the walls, clear of the range and the shelves", () => {
    const room = keeperRoom("galley");
    const pieces = keeperWallPieces("galley");
    expect(pieces.map((p) => p.model)).toEqual(KEEPER_PLACES.galley.wall);
    expect(new Set(pieces.map((p) => `${p.pos.q},${p.pos.r},${p.side}`)).size).toBe(pieces.length);
    const tall = KEEPER_PLACES.galley.fittings.filter((f) => ["cook_range", "larder_shelf", "plate_dresser"].includes(f.model)).map((f) => `${f.q},${f.r}`);
    expect(tall).toHaveLength(3);
    for (const p of pieces) {
      const front = { q: p.pos.q + HEX_DIRS[p.side].q, r: p.pos.r + HEX_DIRS[p.side].r };
      expect(room.tiles.find((t) => t.q === front.q && t.r === front.r)?.biome).toBe("floor");
      expect(tall).not.toContain(`${front.q},${front.r}`);
    }
  });

  it("prices every dish, and names each by a key that leads back to it", () => {
    for (const d of DISHES) {
      expect(POT_PRICES[d.id]).toBeGreaterThan(0);
      expect(potDish(potKey(d.id))).toBe(d.id);
    }
    expect(potDish("dish:gruel")).toBeUndefined();
    expect(potDish("flask:fire")).toBeUndefined();
    // The cook answers a haggle like the others do.
    expect(haggleLine("galley", { ask: "lowball", pct: 35 })).toMatch(/\w/);
    expect(haggleLine("galley", { ask: "nudge", pct: 0 }, 1)).toMatch(/\w/);
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
