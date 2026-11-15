// Trading between crewmates: reading an untrusted side of the table, the
// checks it must pass when it is laid out and again when the trade is
// settled, and whether a pack has the room for what a trade brings.

import { describe, expect, it } from "vitest";
import { STACK_MAX, TRADE_CELLS, TRADE_MAX_GOLD, TRADE_MAX_QTY, emptySide, readTradeSide, sideCells, sideIsEmpty, sideProblem, tradeGoodsText, tradeRoomProblem, type TradeHoldings, type TradeSide } from "./index";

const holder: TradeHoldings = {
  gold: 100,
  resources: { wood: 10, iron: 2 },
  items: [
    { id: 1, equipped: true, name: "Mace", cells: 6 },
    { id: 2, equipped: false, name: "Old Ring", cells: 1 },
    { id: 3, equipped: false, name: "Leather Cap", cells: 4 },
    { id: 4, equipped: false, name: "Old Chest Key", stored: true },
  ],
};
const side = (s: Partial<TradeSide> = {}): TradeSide => ({ ...emptySide(), ...s });
const read = (raw: unknown) => {
  const res = readTradeSide(raw);
  return res.ok ? res.side : res.error;
};

describe("readTradeSide", () => {
  it("reads a full side and fills in what is left out", () => {
    expect(read({ items: [2], gold: 5, resources: { wood: 3 } })).toEqual({ items: [2], gold: 5, resources: { wood: 3 } });
    expect(read({ gold: 5 })).toEqual({ items: [], gold: 5, resources: {} });
    expect(read({})).toEqual(emptySide());
    expect(read(undefined)).toEqual(emptySide());
  });

  it("drops zero amounts rather than storing them, and lists materials in the catalogue's order", () => {
    expect(read({ gold: 0, resources: { wood: 0, stone: 2 } })).toEqual({ items: [], gold: 0, resources: { stone: 2 } });
    expect(JSON.stringify(read({ resources: { iron: 1, wood: 2 } }))).toBe(JSON.stringify(read({ resources: { wood: 2, iron: 1 } })));
  });

  it("refuses what is not a whole positive amount of a known thing", () => {
    expect(read("gold")).toMatch(/not readable/);
    expect(read({ gold: 1.5 })).toMatch(/whole number/);
    expect(read({ gold: -1 })).toMatch(/whole number/);
    expect(read({ gold: "5" })).toMatch(/whole number/);
    expect(read({ resources: { wood: -2 } })).toMatch(/whole number/);
    expect(read({ resources: { rubies: 1 } })).toMatch(/"rubies" is not something/);
    expect(read({ items: [1.5] })).toMatch(/not readable/);
    expect(read({ items: "all" })).toMatch(/not readable/);
    expect(read({ furnishings: [1] })).toMatch(/not "furnishings"/);
  });
});

describe("sideProblem", () => {
  it("allows unequipped gear, gold and materials the player holds", () => {
    expect(sideProblem(side({ items: [2, 3], gold: 100, resources: { wood: 10 } }), holder)).toBeNull();
    expect(sideProblem(emptySide(), holder)).toBeNull();
  });

  it("refuses an equipped or a stored item, by name", () => {
    expect(sideProblem(side({ items: [1] }), holder)).toBe("Unequip Mace first.");
    expect(sideProblem(side({ items: [4] }), holder)).toMatch(/Old Chest Key is in storage at home/);
  });

  it("refuses an item the player does not hold, or the same one twice", () => {
    expect(sideProblem(side({ items: [9] }), holder)).toMatch(/no longer have/);
    expect(sideProblem(side({ items: [2, 2] }), holder)).toMatch(/twice/);
  });

  it("caps the gold and materials on one side, and what fits on the table", () => {
    const rich: TradeHoldings = { ...holder, gold: TRADE_MAX_GOLD * 2, resources: { wood: TRADE_MAX_QTY * 2 } };
    expect(sideProblem(side({ gold: TRADE_MAX_GOLD + 1 }), rich)).toMatch(/No more than/);
    expect(sideProblem(side({ resources: { wood: TRADE_MAX_QTY + 1 } }), rich)).toMatch(/No more than/);
    const laden: TradeHoldings = { gold: 0, resources: {}, items: Array.from({ length: TRADE_CELLS + 1 }, (_, i) => ({ id: i + 1, equipped: false })) };
    expect(sideProblem(side({ items: laden.items.slice(0, TRADE_CELLS).map((i) => i.id) }), laden)).toBeNull();
    expect(sideProblem(side({ items: laden.items.map((i) => i.id) }), laden)).toMatch(/more than fits on the table/);
  });

  it("refuses amounts that are not whole and positive, however the side was built", () => {
    expect(sideProblem(side({ gold: -5 }), holder)).toMatch(/whole number/);
    expect(sideProblem(side({ gold: 1.5 }), holder)).toMatch(/whole number/);
    expect(sideProblem(side({ resources: { wood: -1 } }), holder)).toMatch(/whole number/);
  });

  it("refuses more gold or materials than the player holds", () => {
    expect(sideProblem(side({ gold: 101 }), holder)).toBe("You do not have 101 gold.");
    expect(sideProblem(side({ resources: { wood: 11 } }), holder)).toBe("You do not have 11 wood.");
    expect(sideProblem(side({ resources: { stone: 1 } }), holder)).toBe("You do not have 1 stone.");
  });

  it("names the player when someone else is being told", () => {
    expect(sideProblem(side({ items: [1] }), holder, "Ann")).toBe("Ann is wearing Mace now.");
    expect(sideProblem(side({ items: [9] }), holder, "Ann")).toBe("Ann no longer has one of those items.");
    expect(sideProblem(side({ gold: 101 }), holder, "Ann")).toBe("Ann does not have 101 gold.");
  });
});

describe("a side", () => {
  it("is empty with nothing on it", () => {
    expect(sideIsEmpty(emptySide())).toBe(true);
    expect(sideIsEmpty(side({ resources: { wood: 0 } }))).toBe(true);
    expect(sideIsEmpty(side({ gold: 1 }))).toBe(false);
    expect(sideIsEmpty(side({ items: [2] }))).toBe(false);
    expect(sideIsEmpty(side({ resources: { wood: 1 } }))).toBe(false);
  });

  it("takes up its gear's footprints and a square a stack of material", () => {
    expect(sideCells(side({ items: [2, 3] }), holder)).toBe(5);
    expect(sideCells(side({ resources: { wood: STACK_MAX + 1, iron: 1 } }), holder)).toBe(3);
    expect(sideCells(side({ gold: 500 }), holder)).toBe(0);
  });
});

describe("tradeRoomProblem", () => {
  const nothing = { cells: 0, resources: {} };

  it("lets gear into a pack with the squares for it", () => {
    expect(tradeRoomProblem({ carried: 54, limit: 60 }, {}, nothing, { cells: 6, resources: {} })).toBeNull();
    expect(tradeRoomProblem({ carried: 55, limit: 60 }, {}, nothing, { cells: 6, resources: {} })).toMatch(/Your pack is full: this trade would leave it holding 61 of 60/);
    expect(tradeRoomProblem({ carried: 55, limit: 60 }, {}, nothing, { cells: 6, resources: {} }, "Bo")).toMatch(/^Bo's pack is full/);
  });

  it("counts what is handed over as gone", () => {
    expect(tradeRoomProblem({ carried: 60, limit: 60 }, {}, { cells: 4, resources: {} }, { cells: 4, resources: {} })).toBeNull();
    expect(tradeRoomProblem({ carried: 60, limit: 60 }, {}, { cells: 1, resources: {} }, { cells: 4, resources: {} })).toMatch(/pack is full/);
  });

  it("counts materials by the stacks they make", () => {
    // Topping up a stack takes no square; starting one does.
    expect(tradeRoomProblem({ carried: 60, limit: 60 }, { wood: 10 }, nothing, { cells: 0, resources: { wood: 5 } })).toBeNull();
    expect(tradeRoomProblem({ carried: 60, limit: 60 }, { wood: STACK_MAX }, nothing, { cells: 0, resources: { wood: 1 } })).toMatch(/pack is full/);
    expect(tradeRoomProblem({ carried: 60, limit: 60 }, {}, nothing, { cells: 0, resources: { stone: 1 } })).toMatch(/pack is full/);
    // Handing a whole stack over frees its square for the one that is coming.
    expect(tradeRoomProblem({ carried: 60, limit: 60 }, { wood: 10 }, { cells: 0, resources: { wood: 10 } }, { cells: 0, resources: { stone: 1 } })).toBeNull();
  });

  it("never stops a trade that leaves the pack no fuller", () => {
    expect(tradeRoomProblem({ carried: 70, limit: 60 }, {}, { cells: 6, resources: {} }, { cells: 4, resources: {} })).toBeNull();
    expect(tradeRoomProblem({ carried: 70, limit: 60 }, {}, nothing, nothing)).toBeNull();
  });
});

describe("tradeGoodsText", () => {
  it("lists gold first, then materials in catalogue order", () => {
    expect(tradeGoodsText({ gold: 30, resources: { iron: 1, wood: 2 } })).toBe("30 gold, 2 wood, 1 iron");
    expect(tradeGoodsText({ gold: 0, resources: {} })).toBe("");
  });
});
