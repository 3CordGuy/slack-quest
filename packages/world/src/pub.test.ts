import { describe, expect, it } from "vitest";
import { PUB_BARKEEP_POS, PUB_BUFF_CAPS, PUB_COUNTER, PUB_DICE, PUB_FITTINGS, PUB_GRID, PUB_MENU, capPubBuff, hutGrid, pubBuff, pubPath, pubRoom, tileAt } from "./index";

describe("the pub", () => {
  const room = pubRoom();
  const door = room.pois.find((p) => p.kind === "door")!.pos;

  it("is bigger than the largest hut", () => {
    const lodge = hutGrid(3);
    expect(PUB_GRID.cols).toBeGreaterThan(lodge.cols);
    expect(PUB_GRID.rows).toBeGreaterThan(lodge.rows);
  });

  it("stands its fittings and its barkeep on separate floor hexes", () => {
    const spots = [...PUB_FITTINGS, PUB_BARKEEP_POS];
    for (const f of spots) expect(tileAt(room, f)?.biome, `${f.q},${f.r}`).toBe("floor");
    expect(new Set(spots.map((f) => `${f.q},${f.r}`)).size).toBe(spots.length);
  });

  it("lets a customer reach the counter and the dice table, but not the barkeep's side", () => {
    expect(pubPath(room, door, PUB_COUNTER)!.at(-1)).toEqual(PUB_COUNTER);
    expect(pubPath(room, door, PUB_DICE)!.at(-1)).toEqual(PUB_DICE);
    expect(pubPath(room, door, PUB_BARKEEP_POS)).toBeNull();
    expect(pubPath(room, door, PUB_FITTINGS[0])).toBeNull();
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
