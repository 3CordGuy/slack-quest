// Trading between crewmates: reading an untrusted offer, and the checks it
// must pass before it is stored and again before it is settled.

import { describe, expect, it } from "vitest";
import { TRADE_MAX_GOLD, TRADE_MAX_ITEMS, TRADE_MAX_QTY, isGift, readTradeOffer, tradeGoodsText, tradeProblem, type TradeHoldings, type TradeOffer } from "./index";

const giver: TradeHoldings = {
  gold: 100,
  resources: { wood: 10, iron: 2 },
  items: [
    { id: 1, equipped: true, name: "Mace" },
    { id: 2, equipped: false, name: "Old Ring" },
    { id: 3, equipped: false, name: "Leather Cap" },
  ],
};
const taker: TradeHoldings = { gold: 50, resources: { stone: 5 }, items: [] };
const offer = (give: Partial<TradeOffer["give"]> = {}, ask: Partial<TradeOffer["ask"]> = {}): TradeOffer => ({
  to: "b",
  give: { items: [], gold: 0, resources: {}, ...give },
  ask: { gold: 0, resources: {}, ...ask },
});
const problem = (o: TradeOffer, withTaker = false) => tradeProblem(o, { from: "a", giver, ...(withTaker ? { taker, takerName: "Bo" } : {}) });
const read = (raw: unknown) => {
  const res = readTradeOffer(raw);
  return res.ok ? res.offer : res.error;
};

describe("readTradeOffer", () => {
  it("reads a full offer and fills in what is left out", () => {
    expect(read({ to: "b", give: { items: [2], gold: 5, resources: { wood: 3 } }, ask: { gold: 0, resources: { stone: 1 } } })).toEqual({
      to: "b",
      give: { items: [2], gold: 5, resources: { wood: 3 } },
      ask: { gold: 0, resources: { stone: 1 } },
    });
    expect(read({ to: "b", give: { gold: 1 } })).toEqual(offer({ gold: 1 }));
  });

  it("drops zero amounts rather than storing them", () => {
    expect(read({ to: "b", give: { gold: 1, resources: { wood: 0 } } })).toEqual(offer({ gold: 1 }));
  });

  it.each([
    ["a fraction of gold", { to: "b", give: { gold: 1.5 } }],
    ["negative gold", { to: "b", give: { gold: -5 } }],
    ["gold as text", { to: "b", give: { gold: "5" } }],
    ["a negative material", { to: "b", give: { resources: { wood: -1 } } }],
    ["a fraction of a material", { to: "b", ask: { resources: { wood: 0.5 } } }],
    ["an unknown material", { to: "b", give: { resources: { gems: 1 } } }],
    ["furnishings", { to: "b", give: { furnishings: [1] } }],
    ["blueprints", { to: "b", give: { blueprints: ["bed"] } }],
    ["asking for items", { to: "b", give: { gold: 1 }, ask: { items: [4] } }],
    ["item ids that are not ids", { to: "b", give: { items: ["2"] } }],
    ["a negative item id", { to: "b", give: { items: [-2] } }],
    ["nobody named", { give: { gold: 1 } }],
    ["not an object", "gold please"],
  ])("refuses %s", (_, raw) => {
    expect(typeof read(raw)).toBe("string");
  });
});

describe("tradeProblem", () => {
  it("allows a gift of an unequipped item, gold and materials", () => {
    const gift = offer({ items: [2, 3], gold: 100, resources: { wood: 10 } });
    expect(problem(gift)).toBeNull();
    expect(isGift(gift)).toBe(true);
  });

  it("allows a two-way trade and knows it is not a gift", () => {
    const swap = offer({ items: [2] }, { gold: 50, resources: { stone: 5 } });
    expect(problem(swap, true)).toBeNull();
    expect(isGift(swap)).toBe(false);
  });

  it("refuses a trade with yourself", () => {
    expect(tradeProblem(offer({ gold: 1 }), { from: "b", giver })).toMatch(/yourself/);
  });

  it("refuses an offer that gives nothing, even if it asks for something", () => {
    expect(problem(offer())).toMatch(/something/);
    expect(problem(offer({}, { gold: 10 }))).toMatch(/something/);
  });

  it("refuses an equipped item, by name", () => {
    expect(problem(offer({ items: [1] }))).toBe("Unequip Mace first.");
  });

  it("refuses an item the giver does not hold, or the same one twice", () => {
    expect(problem(offer({ items: [99] }))).toMatch(/no longer have/);
    expect(problem(offer({ items: [2, 2] }))).toMatch(/twice/);
  });

  it("caps the items, gold and materials in one offer", () => {
    const many = Array.from({ length: TRADE_MAX_ITEMS + 1 }, (_, i) => i + 10);
    expect(problem(offer({ items: many }))).toMatch(/No more than/);
    expect(problem(offer({ gold: TRADE_MAX_GOLD + 1 }))).toMatch(/No more than/);
    expect(problem(offer({ gold: 1 }, { resources: { stone: TRADE_MAX_QTY + 1 } }))).toMatch(/No more than/);
  });

  it("refuses amounts that are not whole and positive, however the offer was built", () => {
    expect(problem(offer({ gold: 2.5 }))).toMatch(/whole number/);
    expect(problem(offer({ gold: -1 }))).toMatch(/whole number/);
    expect(problem(offer({ resources: { wood: -3 } }))).toMatch(/whole number/);
    expect(problem(offer({ gold: Number.NaN }))).toMatch(/whole number/);
  });

  it("refuses the same thing on both sides", () => {
    expect(problem(offer({ gold: 5 }, { gold: 1 }))).toMatch(/both sides/);
    expect(problem(offer({ resources: { wood: 1 } }, { resources: { wood: 1 } }))).toMatch(/both sides/);
  });

  it("refuses more gold or materials than the giver holds", () => {
    expect(problem(offer({ gold: 101 }))).toBe("You do not have 101 gold.");
    expect(problem(offer({ resources: { iron: 3 } }))).toBe("You do not have 3 iron.");
    expect(problem(offer({ resources: { fur: 1 } }))).toBe("You do not have 1 fur.");
  });

  it("checks what is asked only when the other side's holdings are known", () => {
    const steep = offer({ gold: 1 }, { resources: { stone: 6 } });
    expect(problem(steep)).toBeNull();
    expect(problem(steep, true)).toBe("Bo does not have 6 stone.");
    expect(problem(offer({ items: [2] }, { gold: 51 }), true)).toBe("Bo does not have 51 gold.");
  });

  it("names the giver when the taker is the one being told", () => {
    expect(tradeProblem(offer({ items: [1] }), { from: "a", giver, giverName: "Ann", takerName: "You" })).toBe("Ann is wearing Mace now.");
    expect(tradeProblem(offer({ items: [99] }), { from: "a", giver, giverName: "Ann" })).toBe("Ann no longer has one of those items.");
    expect(tradeProblem(offer({ gold: 101 }), { from: "a", giver, giverName: "Ann" })).toBe("Ann does not have 101 gold.");
    expect(tradeProblem(offer({ items: [2] }, { gold: 60 }), { from: "a", giver, taker, giverName: "Ann", takerName: "You" })).toBe("You do not have 60 gold.");
  });
});

describe("tradeGoodsText", () => {
  it("lists gold first, then materials in catalogue order", () => {
    expect(tradeGoodsText({ gold: 30, resources: { bone: 1, wood: 2 } })).toBe("30 gold, 2 wood, 1 bone");
    expect(tradeGoodsText({ gold: 0, resources: {} })).toBe("");
  });
});
