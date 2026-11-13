import { describe, expect, it } from "vitest";
import { hexDistance } from "@gantt-quest/core";
import { PUB_BARKEEP_POS, PUB_BUFF_CAPS, PUB_COUNTER, PUB_DEALER_POS, PUB_DEALER_STAND, PUB_DICE, PUB_FITTINGS, PUB_GRID, PUB_MENU, PUB_REGULAR_SPOTS, PUB_SALESMAN_POS, PUB_SHOALS, PUB_TRADER, capPubBuff, hutGrid, poiAt, pubBuff, pubPath, pubRoom, tileAt } from "./index";

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

  it("puts the contract dealer beside the pillar, with room in front to walk up", () => {
    const pillar = PUB_FITTINGS.find((f) => f.model === "pillar")!;
    expect(hexDistance(pillar, PUB_DEALER_POS)).toBe(1);
    expect(hexDistance(PUB_DEALER_STAND, PUB_DEALER_POS)).toBe(1);
    expect(poiAt(room, PUB_DEALER_STAND)?.kind).toBe("dealer");
    expect(pubPath(room, door, PUB_DEALER_STAND)!.at(-1)).toEqual(PUB_DEALER_STAND);
    expect(pubPath(room, door, PUB_DEALER_POS)).toBeNull();
  });

  it("still lets a customer reach every place to stand", () => {
    for (const to of [PUB_COUNTER, PUB_DICE, PUB_SHOALS, PUB_TRADER, PUB_DEALER_STAND, ...PUB_REGULAR_SPOTS.map((s) => s.stand)]) {
      expect(pubPath(room, door, to), `${to.q},${to.r}`).not.toBeNull();
    }
  });

  it("counts one drink and one meal, whatever is ordered", () => {
    expect(pubBuff(["ale"])).toEqual({ focus: 0, potions: 0, maxHp: 2, xpPct: 0 });
    expect(pubBuff(["rum", "stew"])).toEqual({ focus: 1, potions: 0, maxHp: 4, xpPct: 0 });
    // A second drink does not stack, and an unknown item is ignored.
    expect(pubBuff(["ale", "rum", "moonshine"])).toEqual({ focus: 0, potions: 0, maxHp: 2, xpPct: 0 });
  });

  it("never lets a buff exceed what the menu can give", () => {
    expect(capPubBuff({ focus: 9, potions: 9, maxHp: 99, xpPct: 99 })).toEqual(PUB_BUFF_CAPS);
    expect(PUB_BUFF_CAPS.potions).toBe(0);
    for (const item of PUB_MENU) expect(item.price).toBeGreaterThan(0);
  });
});
