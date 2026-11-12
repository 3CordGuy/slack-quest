// Trading against a real SQLite database with the game's migrations applied.
//
// D1 is stood in for by Node's built-in SQLite behind the few D1 methods the
// trade code uses; a batch is one transaction, as it is on D1. This file
// lives outside src/ because the app's tsconfig has no Node types.

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { TRADE_TTL_MS, type TradeOffer } from "@gantt-quest/world";
import { acceptTrade, closeTrade, listTrades, proposeTrade, settleStatements } from "../src/server/trade";

type Row = Record<string, unknown>;

class Stmt {
  constructor(private sql: DatabaseSync, private text: string, private args: unknown[] = []) {}
  bind(...args: unknown[]) {
    return new Stmt(this.sql, this.text, args);
  }
  exec() {
    const stmt = this.sql.prepare(this.text);
    if (/^\s*(SELECT|WITH)/i.test(this.text)) return { results: stmt.all(...(this.args as never[])) as Row[], meta: { changes: 0, last_row_id: 0 } };
    const res = stmt.run(...(this.args as never[]));
    return { results: [] as Row[], meta: { changes: Number(res.changes), last_row_id: Number(res.lastInsertRowid) } };
  }
  async run() {
    return this.exec();
  }
  async all() {
    return this.exec();
  }
  async first() {
    return this.exec().results[0] ?? null;
  }
}

function openDb() {
  const sql = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) sql.exec(readFileSync(new URL(file, dir), "utf8"));
  const db = {
    prepare: (text: string) => new Stmt(sql, text),
    async batch(stmts: Stmt[]) {
      sql.exec("BEGIN");
      try {
        const out = stmts.map((s) => s.exec());
        sql.exec("COMMIT");
        return out;
      } catch (err) {
        sql.exec("ROLLBACK");
        throw err;
      }
    },
  };
  return { sql, db: db as unknown as D1Database };
}

let sql: DatabaseSync;
let db: D1Database;
/** Inventory ids: Ann's worn mace, her spare ring and cap; Bo's worn staff. */
const MACE = 1;
const RING = 2;
const CAP = 3;

const one = <T = Row>(text: string, ...args: (string | number)[]) => sql.prepare(text).get(...args) as T;
const gold = (id: string) => one<{ gold: number }>("SELECT gold FROM characters WHERE player_id = ?", id).gold;
const qty = (id: string, kind: string) => one<{ qty: number } | undefined>("SELECT qty FROM resources WHERE player_id = ? AND kind = ?", id, kind)?.qty ?? 0;
const owner = (item: number) => one<{ player_id: string; equipped: number }>("SELECT player_id, equipped FROM inventory WHERE id = ?", item);
const trade = (id: number) => one<{ status: string; reason: string | null }>("SELECT status, reason FROM trades WHERE id = ?", id);
/** Everything that could move, so "nothing moved" is one comparison. */
const snapshot = () => ({
  gold: sql.prepare("SELECT player_id, gold FROM characters ORDER BY player_id").all(),
  resources: sql.prepare("SELECT * FROM resources ORDER BY player_id, kind").all(),
  inventory: sql.prepare("SELECT id, player_id, equipped FROM inventory ORDER BY id").all(),
});

function addRun(code: string, status: string, heroes: string[], updatedAt = Date.now()) {
  sql
    .prepare("INSERT OR REPLACE INTO runs (code, seed, status, state_json, created_by, crew_id, created_at, updated_at) VALUES (?, 's', ?, ?, 'ann', 'CREWAA', ?, ?)")
    .run(code, status, JSON.stringify({ phase: status, heroes: heroes.map((id) => ({ id, name: id })) }), updatedAt, updatedAt);
}

const offer = (to: string, give: Partial<TradeOffer["give"]>, ask: Partial<TradeOffer["ask"]> = {}) => ({ to, give, ask });

async function propose(from: string, raw: unknown, run: string | null = null): Promise<number> {
  const res = await proposeTrade(db, from, raw, run);
  if ("error" in res) throw new Error(res.error);
  return res.id;
}
const errorOf = (res: object) => ("error" in res ? (res.error as string) : null);

beforeEach(() => {
  ({ sql, db } = openDb());
  const at = Date.now();
  for (const [id, name, crew] of [["ann", "Ann", "CREWAA"], ["bo", "Bo", "CREWAA"], ["cy", "Cy", "CREWBB"]]) {
    sql.prepare("INSERT INTO players (id, name, created_at) VALUES (?, ?, ?)").run(id, name, at);
    sql.prepare("INSERT INTO characters (player_id, name, class_id, status, str, int_stat, vit, agi, dex, gold, created_at) VALUES (?, ?, 'cleric', 'active', 5, 5, 5, 5, 5, 100, ?)").run(id, name, at);
    sql.prepare("INSERT OR IGNORE INTO crews (id, name, created_by, created_at) VALUES (?, ?, ?, ?)").run(crew, crew, id, at);
    sql.prepare("INSERT INTO crew_members (crew_id, player_id, joined_at) VALUES (?, ?, ?)").run(crew, id, at);
  }
  const item = sql.prepare("INSERT INTO inventory (player_id, kind, ref, name, rarity, slot, equipped, created_at) VALUES (?, ?, ?, ?, 'common', ?, ?, ?)");
  item.run("ann", "weapon", "mace", "Mace", "main_hand", 1, at);
  item.run("ann", "trinket", "ring", "Old Ring", "ring", 0, at);
  item.run("ann", "armor", "cap", "Leather Cap", "helmet", 0, at);
  item.run("bo", "weapon", "staff", "Staff", "main_hand", 1, at);
  sql.prepare("INSERT INTO resources (player_id, kind, qty) VALUES ('ann', 'wood', 10), ('bo', 'stone', 5), ('bo', 'wood', 1)").run();
});

describe("a gift", () => {
  it("arrives: the item unequipped, the gold and the materials", async () => {
    const id = await propose("ann", offer("bo", { items: [RING], gold: 30, resources: { wood: 4 } }));
    const list = await listTrades(db, "bo");
    expect(list.open).toHaveLength(1);
    expect(list.open[0]).toMatchObject({ id, gift: true, from: { id: "ann", name: "Ann" }, give: { gold: 30, resources: { wood: 4 }, missing: 0 } });
    expect(list.open[0].give.items.map((i) => i.name)).toEqual(["Old Ring"]);

    expect(await acceptTrade(db, "bo", id)).toEqual({ ok: true, crewId: "CREWAA" });
    expect(owner(RING)).toEqual({ player_id: "bo", equipped: 0 });
    expect([gold("ann"), gold("bo")]).toEqual([70, 130]);
    expect([qty("ann", "wood"), qty("bo", "wood")]).toEqual([6, 5]);
    expect(trade(id).status).toBe("accepted");
    expect((await listTrades(db, "ann")).recent).toEqual([{ id, status: "accepted", reason: null, mine: true, other: "Bo" }]);
  });

  it("gives a material the other has never held", async () => {
    const id = await propose("bo", offer("ann", { resources: { stone: 5 } }));
    expect(errorOf(await acceptTrade(db, "ann", id))).toBeNull();
    expect([qty("bo", "stone"), qty("ann", "stone")]).toEqual([0, 5]);
  });
});

describe("a two-way trade", () => {
  it("moves both sides", async () => {
    const id = await propose("ann", offer("bo", { items: [RING, CAP], resources: { wood: 2 } }, { gold: 60, resources: { stone: 3 } }));
    expect(errorOf(await acceptTrade(db, "bo", id))).toBeNull();
    expect([owner(RING).player_id, owner(CAP).player_id]).toEqual(["bo", "bo"]);
    expect([gold("ann"), gold("bo")]).toEqual([160, 40]);
    expect([qty("ann", "wood"), qty("bo", "wood"), qty("ann", "stone"), qty("bo", "stone")]).toEqual([8, 3, 3, 2]);
  });

  it("cannot be accepted twice, or by anyone but the player it was made to", async () => {
    const id = await propose("ann", offer("bo", { gold: 10 }));
    expect(errorOf(await acceptTrade(db, "ann", id))).toMatch(/no longer open/);
    expect(errorOf(await acceptTrade(db, "cy", id))).toMatch(/no longer open/);
    expect(errorOf(await acceptTrade(db, "bo", id))).toBeNull();
    expect(errorOf(await acceptTrade(db, "bo", id))).toMatch(/no longer open/);
    expect([gold("ann"), gold("bo")]).toEqual([90, 110]);
  });
});

describe("a trade one side can no longer cover", () => {
  it("moves nothing when the giver has sold the item, and is closed with the reason", async () => {
    const id = await propose("ann", offer("bo", { items: [RING, CAP], gold: 10 }, { resources: { stone: 2 } }));
    sql.prepare("DELETE FROM inventory WHERE id = ?").run(RING);
    expect((await listTrades(db, "bo")).open[0].give.missing).toBe(1);
    const before = snapshot();
    expect(errorOf(await acceptTrade(db, "bo", id))).toBe("Ann no longer has one of those items. Nothing changed hands, and the offer is closed.");
    expect(snapshot()).toEqual(before);
    expect(trade(id)).toEqual({ status: "failed", reason: "Ann no longer has one of those items." });
  });

  it("moves nothing when the giver has spent the gold", async () => {
    const id = await propose("ann", offer("bo", { items: [RING], gold: 80 }));
    sql.prepare("UPDATE characters SET gold = 20 WHERE player_id = 'ann'").run();
    const before = snapshot();
    expect(errorOf(await acceptTrade(db, "bo", id))).toMatch(/^Ann does not have 80 gold\./);
    expect(snapshot()).toEqual(before);
    expect(trade(id).status).toBe("failed");
  });

  it("moves nothing when the giver has put the item on", async () => {
    const id = await propose("ann", offer("bo", { items: [CAP] }));
    sql.prepare("UPDATE inventory SET equipped = 1 WHERE id = ?").run(CAP);
    expect(errorOf(await acceptTrade(db, "bo", id))).toMatch(/^Ann is wearing Leather Cap now\./);
    expect(owner(CAP)).toEqual({ player_id: "ann", equipped: 1 });
  });

  it("moves nothing when the one accepting cannot pay what was asked", async () => {
    const id = await propose("ann", offer("bo", { items: [RING] }, { gold: 500, resources: { stone: 5 } }));
    const before = snapshot();
    expect(errorOf(await acceptTrade(db, "bo", id))).toMatch(/^You do not have 500 gold\./);
    expect(snapshot()).toEqual(before);
    expect(trade(id).reason).toBe("Bo does not have 500 gold.");
  });
});

// The read-then-write race: these run the settling batch directly, skipping
// the friendly check that acceptTrade makes first, as if the holdings had
// changed in the moment between the two.
describe("the settling batch on its own", () => {
  const settle = async (id: number, o: TradeOffer, run: string | null = null) => {
    const res = await db.batch(settleStatements(db, { id, crew_id: "CREWAA", from_id: "ann", to_id: "bo", run_code: run }, o, `token-${Math.random()}`, Date.now()));
    return res.map((r) => r.meta.changes);
  };
  const full = (give: Partial<TradeOffer["give"]>, ask: Partial<TradeOffer["ask"]> = {}): TradeOffer => ({ to: "bo", give: { items: [], gold: 0, resources: {}, ...give }, ask: { gold: 0, resources: {}, ...ask } });
  const swap = full({ items: [RING, CAP], gold: 10, resources: { wood: 2 } }, { resources: { stone: 3 } });

  it("moves everything when every condition holds", async () => {
    const id = await propose("ann", swap);
    expect((await settle(id, swap)).every((n) => n === 1 || n === 2)).toBe(true);
    expect([owner(RING).player_id, gold("bo"), qty("bo", "wood"), qty("ann", "stone")]).toEqual(["bo", 110, 3, 3]);
  });

  it.each([
    ["an item was sold", () => sql.prepare("DELETE FROM inventory WHERE id = ?").run(CAP)],
    ["an item was equipped", () => sql.prepare("UPDATE inventory SET equipped = 1 WHERE id = ?").run(RING)],
    ["an item now belongs to someone else", () => sql.prepare("UPDATE inventory SET player_id = 'cy' WHERE id = ?").run(RING)],
    ["the giver's gold was spent", () => sql.prepare("UPDATE characters SET gold = 9 WHERE player_id = 'ann'").run()],
    ["the giver's wood was spent", () => sql.prepare("UPDATE resources SET qty = 1 WHERE player_id = 'ann' AND kind = 'wood'").run()],
    ["the taker's stone was spent", () => sql.prepare("UPDATE resources SET qty = 2 WHERE player_id = 'bo' AND kind = 'stone'").run()],
    ["the taker's stone row is gone", () => sql.prepare("DELETE FROM resources WHERE player_id = 'bo' AND kind = 'stone'").run()],
    ["the taker left the crew", () => sql.prepare("DELETE FROM crew_members WHERE player_id = 'bo'").run()],
    ["the giver re-rolled their character", () => sql.prepare("UPDATE characters SET status = 'draft' WHERE player_id = 'ann'").run()],
    ["the giver walked into a fight", () => addRun("FGHT", "battle", ["ann"])],
    ["the taker walked into a fight", () => addRun("FGHT", "battle", ["bo", "cy"])],
    ["the offer was withdrawn", () => sql.prepare("UPDATE trades SET status = 'withdrawn'").run()],
    ["the offer was already accepted", () => sql.prepare("UPDATE trades SET status = 'accepted', settle_token = 'earlier'").run()],
    ["the offer lapsed", () => sql.prepare("UPDATE trades SET created_at = ?").run(Date.now() - TRADE_TTL_MS - 1)],
  ])("moves nothing if %s", async (_, change) => {
    const id = await propose("ann", swap);
    change();
    const before = snapshot();
    expect(await settle(id, swap)).toEqual(Array(8).fill(0));
    expect(snapshot()).toEqual(before);
  });

  it("holds an island offer to its voyage: both aboard, and ashore", async () => {
    addRun("ISLE", "overworld", ["ann", "bo"]);
    const id = await propose("ann", swap, "ISLE");
    addRun("ISLE", "battle", ["ann", "bo"]);
    expect((await settle(id, swap, "ISLE"))[0]).toBe(0);
    addRun("ISLE", "victory", ["ann", "bo"]);
    expect((await settle(id, swap, "ISLE"))[0]).toBe(0);
    addRun("ISLE", "overworld", ["ann", "cy"]);
    expect((await settle(id, swap, "ISLE"))[0]).toBe(0);
    addRun("ISLE", "overworld", ["ann", "bo"]);
    expect((await settle(id, swap, "ISLE"))[0]).toBe(1);
    expect(owner(CAP).player_id).toBe("bo");
  });
});

describe("what cannot be offered", () => {
  it("an equipped item", async () => {
    expect(errorOf(await proposeTrade(db, "ann", offer("bo", { items: [MACE] }), null))).toBe("Unequip Mace first.");
  });

  it("someone else's item, more than is held, or nothing", async () => {
    expect(errorOf(await proposeTrade(db, "bo", offer("ann", { items: [RING] }), null))).toMatch(/no longer have/);
    expect(errorOf(await proposeTrade(db, "ann", offer("bo", { gold: 101 }), null))).toBe("You do not have 101 gold.");
    expect(errorOf(await proposeTrade(db, "ann", offer("bo", { resources: { wood: 11 } }), null))).toBe("You do not have 11 wood.");
    expect(errorOf(await proposeTrade(db, "ann", offer("bo", {}, { gold: 5 }), null))).toMatch(/something/);
    expect(errorOf(await proposeTrade(db, "ann", offer("bo", { gold: -5 }), null))).toMatch(/whole number/);
    expect(errorOf(await proposeTrade(db, "ann", { to: "bo", give: { furnishings: [1] } }, null))).toMatch(/furnishings/);
  });

  it("anything to yourself, a stranger, or another crew", async () => {
    expect(errorOf(await proposeTrade(db, "ann", offer("ann", { gold: 1 }), null))).toMatch(/yourself/);
    expect(errorOf(await proposeTrade(db, "ann", offer("nobody", { gold: 1 }), null))).toMatch(/no such crewmate/);
    expect(errorOf(await proposeTrade(db, "ann", offer("cy", { gold: 1 }), null))).toMatch(/same crew/);
  });

  it("a second offer while one is open between the two, in either direction", async () => {
    const id = await propose("ann", offer("bo", { gold: 1 }));
    expect(errorOf(await proposeTrade(db, "bo", offer("ann", { gold: 1 }), null))).toMatch(/already have an offer open/);
    expect(await closeTrade(db, "bo", id)).toEqual({ ok: true });
    expect(trade(id).status).toBe("declined");
    const again = await propose("bo", offer("ann", { gold: 1 }));
    expect(await closeTrade(db, "cy", again)).toEqual({ error: "That offer is no longer open." });
    expect(await closeTrade(db, "bo", again)).toEqual({ ok: true });
    expect(trade(again).status).toBe("withdrawn");
  });

  it("an offer nobody answered lapses and makes way for a new one", async () => {
    const id = await propose("ann", offer("bo", { gold: 1 }));
    sql.prepare("UPDATE trades SET created_at = ? WHERE id = ?").run(Date.now() - TRADE_TTL_MS - 1, id);
    expect((await listTrades(db, "bo")).open).toEqual([]);
    expect(errorOf(await acceptTrade(db, "bo", id))).toMatch(/no longer open/);
    await propose("bo", offer("ann", { gold: 1 }));
    expect(trade(id).status).toBe("expired");
  });
});

describe("fights", () => {
  it("refuse a new offer while either player is in one", async () => {
    addRun("FGHT", "battle", ["bo"]);
    expect(errorOf(await proposeTrade(db, "ann", offer("bo", { gold: 1 }), null))).toBe("Bo is in a fight. Trading waits until the fight is over.");
    expect(errorOf(await proposeTrade(db, "bo", offer("ann", { gold: 1 }), null))).toBe("You are in a fight. Trading waits until the fight is over.");
  });

  it("refuse an accept, move nothing, and leave the offer open for afterwards", async () => {
    const id = await propose("ann", offer("bo", { items: [RING] }, { gold: 20 }));
    addRun("FGHT", "battle", ["ann"]);
    const before = snapshot();
    expect(errorOf(await acceptTrade(db, "bo", id))).toBe("Ann is in a fight. Trading waits until the fight is over.");
    expect(snapshot()).toEqual(before);
    expect(trade(id).status).toBe("open");
    addRun("FGHT", "overworld", ["ann"]);
    expect(errorOf(await acceptTrade(db, "bo", id))).toBeNull();
    expect([owner(RING).player_id, gold("ann")]).toEqual(["bo", 120]);
  });

  it("do not count once the voyage is long abandoned", async () => {
    addRun("FGHT", "battle", ["bo"], Date.now() - 13 * 60 * 60_000);
    const id = await propose("ann", offer("bo", { gold: 1 }));
    expect(errorOf(await acceptTrade(db, "bo", id))).toBeNull();
  });
});

describe("on an island", () => {
  it("allows a trade between two heroes of a voyage that is ashore", async () => {
    addRun("ISLE", "overworld", ["ann", "bo"]);
    const id = await propose("ann", offer("bo", { items: [CAP] }), "ISLE");
    expect((await listTrades(db, "bo")).open[0].runCode).toBe("ISLE");
    expect(errorOf(await acceptTrade(db, "bo", id))).toBeNull();
    expect(owner(CAP)).toEqual({ player_id: "bo", equipped: 0 });
  });

  it.each(["lobby", "generating", "battle", "victory", "defeat"])("refuses while the voyage is in %s", async (status) => {
    addRun("ISLE", status, ["ann", "bo"]);
    expect(errorOf(await proposeTrade(db, "ann", offer("bo", { gold: 1 }), "ISLE"))).toBeTruthy();
  });

  it("refuses a hero who is not aboard, and a voyage that does not exist", async () => {
    addRun("ISLE", "overworld", ["ann"]);
    expect(errorOf(await proposeTrade(db, "ann", offer("bo", { gold: 1 }), "ISLE"))).toMatch(/same voyage/);
    expect(errorOf(await proposeTrade(db, "ann", offer("bo", { gold: 1 }), "NOPE"))).toMatch(/voyage is over/);
  });

  it("refuses an accept once a fight has begun, and closes the offer once the voyage has ended", async () => {
    addRun("ISLE", "overworld", ["ann", "bo"]);
    const id = await propose("ann", offer("bo", { gold: 5 }), "ISLE");
    addRun("ISLE", "battle", ["ann", "bo"]);
    expect(errorOf(await acceptTrade(db, "bo", id))).toMatch(/in a fight/);
    expect(trade(id).status).toBe("open");
    addRun("ISLE", "defeat", ["ann", "bo"]);
    expect(errorOf(await acceptTrade(db, "bo", id))).toMatch(/voyage is over.*offer is closed/);
    expect(trade(id).status).toBe("failed");
    expect([gold("ann"), gold("bo")]).toEqual([100, 100]);
  });
});
