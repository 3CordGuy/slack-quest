import { describe, expect, it } from "vitest";
import {
  FAR_GOODS,
  FOUND_BLUEPRINTS,
  FURNISHINGS,
  PUB_FITTINGS,
  PUB_SALESMAN_POS,
  PUB_TRADER,
  SALESMAN_SLOT_MS,
  SALESMEN,
  STALL_BUYS,
  STALL_FURNITURE,
  nextSalesmanVisit,
  pubPath,
  pubRoom,
  rarityIndex,
  salesProblem,
  salesmanStock,
  salesmanVisitAt,
  salesmanVisitInSlot,
  tileAt,
  type SalesBuyer,
  type SalesmanVisit,
} from "./index";

const WEEK_SLOTS = (7 * 24 * 60 * 60_000) / SALESMAN_SLOT_MS;
const visitOf = (salesmanId: SalesmanVisit["salesmanId"], visit = 1234): SalesmanVisit => ({ visit, salesmanId, startsAt: 0, endsAt: SALESMAN_SLOT_MS });
const buyer = (over: Partial<SalesBuyer> = {}): SalesBuyer => ({ gold: 10_000, resources: { herbs: 50, mushrooms: 50 }, blueprints: [], bought: [], ...over });

describe("when traveling salesmen visit", () => {
  const t = Date.UTC(2026, 10, 12, 15, 30);

  it("is the same for the same crew and time, and changes between crews", () => {
    for (let i = 0; i < 200; i++) {
      const at = t + i * 3_600_000;
      expect(salesmanVisitAt("crew-a", at)).toEqual(salesmanVisitAt("crew-a", at));
    }
    const a = Array.from({ length: 200 }, (_, s) => salesmanVisitInSlot("crew-a", s + 100)?.salesmanId ?? "-").join();
    const b = Array.from({ length: 200 }, (_, s) => salesmanVisitInSlot("crew-b", s + 100)?.salesmanId ?? "-").join();
    expect(a).not.toEqual(b);
  });

  it("covers the whole slot it is in", () => {
    const slot = Array.from({ length: 500 }, (_, i) => i + 80_000).find((s) => salesmanVisitInSlot("crew-a", s))!;
    const v = salesmanVisitInSlot("crew-a", slot)!;
    expect(v.endsAt - v.startsAt).toBe(SALESMAN_SLOT_MS);
    expect(salesmanVisitAt("crew-a", v.startsAt)).toEqual(v);
    expect(salesmanVisitAt("crew-a", v.endsAt - 1)).toEqual(v);
    expect(salesmanVisitAt("crew-a", v.startsAt - 1)).toBeNull();
    expect(salesmanVisitAt("crew-a", v.endsAt)).toBeNull();
  });

  it("always leaves a gap between visits, and comes a few times a week", () => {
    for (const crew of ["crew-a", "crew-b", "x7Hq2"]) {
      const slots = Array.from({ length: WEEK_SLOTS * 20 }, (_, i) => salesmanVisitInSlot(crew, 80_000 + i));
      for (let i = 1; i < slots.length; i++) expect(!!slots[i] && !!slots[i - 1]).toBe(false);
      const perWeek = slots.filter(Boolean).length / 20;
      expect(perWeek).toBeGreaterThan(3);
      expect(perWeek).toBeLessThan(8);
    }
  });

  it("brings every salesman round in time", () => {
    const seen = new Set(Array.from({ length: WEEK_SLOTS * 8 }, (_, i) => salesmanVisitInSlot("crew-a", 80_000 + i)?.salesmanId).filter(Boolean));
    expect(seen.size).toBe(SALESMEN.length);
  });

  it("knows when the next one is due, and it is a real visit after now", () => {
    const next = nextSalesmanVisit("crew-a", t)!;
    expect(next.startsAt).toBeGreaterThan(t);
    expect(salesmanVisitAt("crew-a", next.startsAt)).toEqual(next);
    for (let at = t; at < next.startsAt; at += SALESMAN_SLOT_MS) {
      const now = salesmanVisitAt("crew-a", at);
      if (now) expect(now.visit).toBe(Math.floor(t / SALESMAN_SLOT_MS));
    }
  });

  it("has no visitor for a missing crew", () => {
    expect(salesmanVisitAt("", t)).toBeNull();
  });
});

describe("what salesmen sell", () => {
  it("is seeded: the same visit gives the same stock, another visit another", () => {
    for (const s of SALESMEN) {
      expect(salesmanStock("crew-a", visitOf(s.id), "p1", "qa_paladin", 5)).toEqual(salesmanStock("crew-a", visitOf(s.id), "p1", "qa_paladin", 5));
    }
    const runs = new Set(Array.from({ length: 6 }, (_, i) => JSON.stringify(salesmanStock("crew-a", visitOf("curio", 1000 + i), "p1", "qa_paladin", 5))));
    expect(runs.size).toBeGreaterThan(1);
  });

  it("shows the whole crew the same wares, except the curio dealer's gear", () => {
    for (const id of ["plans", "far", "herbs"] as const) {
      expect(salesmanStock("crew-a", visitOf(id), "p1", "qa_paladin", 3)).toEqual(salesmanStock("crew-a", visitOf(id), "p2", "devops_mage", 9));
    }
    // Gear is each player's own: two crewmates of the same class and level see different pieces.
    const names = (player: string) => salesmanStock("crew-a", visitOf("curio"), player, "qa_paladin", 5).map((e) => (e.goods.kind === "item" ? e.goods.item.name + JSON.stringify(e.goods.item.statBonus) : ""));
    expect(names("p1")).toEqual(names("p1"));
    expect(names("p1")).not.toEqual(names("p2"));
    const curios = salesmanStock("crew-a", visitOf("curio"), "p1", "devops_mage", 5);
    for (const e of curios) if (e.goods.kind === "item" && e.goods.item.kind === "weapon") expect(["staff"]).toContain(e.goods.item.ref);
  });

  it("gives the curio dealer only rare or better gear, dearer than the stall", () => {
    for (let v = 0; v < 30; v++) {
      for (const e of salesmanStock("crew-a", visitOf("curio", v), "p1", "refactor_rogue", 4)) {
        expect(e.goods.kind).toBe("item");
        if (e.goods.kind !== "item") continue;
        expect(rarityIndex(e.goods.item.rarity)).toBeGreaterThanOrEqual(rarityIndex("rare"));
        expect(e.price).toBeGreaterThan(0);
      }
    }
  });

  it("gives the plans peddler only blueprints that are otherwise found, three different ones", () => {
    const stock = salesmanStock("crew-a", visitOf("plans"), "p1", "qa_paladin", 1);
    expect(stock).toHaveLength(3);
    const ids = stock.map((e) => (e.goods.kind === "blueprint" ? e.goods.defId : ""));
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(FOUND_BLUEPRINTS).toContain(id);
  });

  it("gives the far-goods trader furnishings that the stall does not sell and nobody can craft", () => {
    for (const id of Object.keys(FAR_GOODS)) {
      expect(FURNISHINGS[id]).toBeDefined();
      expect(FURNISHINGS[id].recipe).toBeUndefined();
      expect(STALL_FURNITURE.map((f) => f.id)).not.toContain(id);
    }
    for (const e of salesmanStock("crew-a", visitOf("far"), "p1", "qa_paladin", 1)) expect(e.goods.kind === "furnishing" && FAR_GOODS[e.goods.defId]).toBe(e.price);
  });

  it("has the herbalist pay more a piece than the stall does", () => {
    for (let v = 0; v < 30; v++) {
      for (const e of salesmanStock("crew-a", visitOf("herbs", v), "p1", "qa_paladin", 1)) {
        expect(e.price).toBe(0);
        const pieces = (e.materials.herbs ?? 0) + (e.materials.mushrooms ?? 0);
        expect(pieces).toBeGreaterThan(0);
        expect(e.goods.kind === "gold" && e.goods.gold / pieces).toBeGreaterThan(Math.max(STALL_BUYS.herbs!, STALL_BUYS.mushrooms!));
      }
    }
  });
});

describe("buying from a salesman", () => {
  const curio = salesmanStock("crew-a", visitOf("curio"), "p1", "qa_paladin", 5)[0];
  const plan = salesmanStock("crew-a", visitOf("plans"), "p1", "qa_paladin", 5)[0];
  const herbs = salesmanStock("crew-a", visitOf("herbs"), "p1", "qa_paladin", 5)[0];

  it("lets a buyer with the means take each entry once", () => {
    expect(salesProblem(curio, buyer())).toBeNull();
    expect(salesProblem(curio, buyer({ bought: [curio.index] }))).toMatch(/already/);
  });

  it("refuses what is not on the table, or what cannot be paid for", () => {
    expect(salesProblem(undefined, buyer())).toMatch(/nothing like that/);
    expect(salesProblem(curio, buyer({ gold: curio.price - 1 }))).toBe("Not enough gold.");
    expect(salesProblem(herbs, buyer({ resources: {} }))).toMatch(/You need/);
  });

  it("will not sell a blueprint the buyer already knows", () => {
    expect(plan.goods.kind).toBe("blueprint");
    if (plan.goods.kind === "blueprint") expect(salesProblem(plan, buyer({ blueprints: [plan.goods.defId] }))).toMatch(/know that blueprint/);
  });
});

describe("the salesmen's corner of the pub", () => {
  const room = pubRoom();
  const door = room.pois.find((p) => p.kind === "door")!.pos;

  it("is floor that nobody walks onto, with a reachable spot to trade from", () => {
    expect(tileAt(room, PUB_SALESMAN_POS)?.biome).toBe("floor");
    for (const f of PUB_FITTINGS) expect(`${f.q},${f.r}`).not.toBe(`${PUB_SALESMAN_POS.q},${PUB_SALESMAN_POS.r}`);
    expect(pubPath(room, door, PUB_SALESMAN_POS)).toBeNull();
    expect(pubPath(room, door, PUB_TRADER)!.at(-1)).toEqual(PUB_TRADER);
  });
});
