// Trading against a real SQLite database with the game's migrations applied.
//
// D1 is stood in for by Node's built-in SQLite behind the few D1 methods the
// trade code uses; a batch is one transaction, as it is on D1. This file
// lives outside src/ because the app's tsconfig has no Node types.

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { PACK_CELLS, TRADE_TTL_MS, type TradeSide } from "@gantt-quest/world";
import { acceptTrade, closeTrade, listTrades, openTrade, setTradeSide, settleStatements } from "../src/server/trade";

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
/** Inventory ids: Ann's worn mace, her spare ring and cap; Bo's worn staff and spare boots. */
const MACE = 1;
const RING = 2;
const CAP = 3;
const BOOTS = 5;

const one = <T = Row>(text: string, ...args: (string | number)[]) => sql.prepare(text).get(...args) as T;
const gold = (id: string) => one<{ gold: number }>("SELECT gold FROM characters WHERE player_id = ?", id).gold;
const qty = (id: string, kind: string) => one<{ qty: number } | undefined>("SELECT qty FROM resources WHERE player_id = ? AND kind = ?", id, kind)?.qty ?? 0;
const owner = (item: number) => one<{ player_id: string; equipped: number }>("SELECT player_id, equipped FROM inventory WHERE id = ?", item);
const trade = (id: number) => one<{ status: string; reason: string | null; rev: number; from_ok: number; to_ok: number }>("SELECT status, reason, rev, from_ok, to_ok FROM trades WHERE id = ?", id);
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

const side = (s: Partial<TradeSide> = {}): TradeSide => ({ items: [], gold: 0, resources: {}, ...s });
const errorOf = (res: object) => ("error" in res ? (res.error as string) : null);

/** Open the table between two players; returns the trade's id. */
async function open(from: string, to: string, run: string | null = null): Promise<number> {
  const res = await openTrade(db, from, to, run);
  if ("error" in res) throw new Error(res.error);
  return res.id;
}
/** Lay out one player's side; returns the table's rev. */
async function lay(who: string, id: number, s: Partial<TradeSide>): Promise<number> {
  const res = await setTradeSide(db, who, id, side(s));
  if ("error" in res) throw new Error(res.error);
  return res.rev;
}
/** Both accept the table as it stands; returns what the second acceptance said. */
async function shake(id: number, first = "ann", second = "bo") {
  const { rev } = trade(id);
  expect(await acceptTrade(db, first, id, rev)).toMatchObject({ ok: true, settled: false });
  return acceptTrade(db, second, id, rev);
}

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
  item.run("bo", "armor", "boots", "Sea Boots", "boots", 0, at);
  sql.prepare("INSERT INTO resources (player_id, kind, qty) VALUES ('ann', 'wood', 10), ('bo', 'stone', 5), ('bo', 'wood', 1)").run();
});

describe("a gift", () => {
  it("arrives once both have accepted: the item unequipped, the gold and the materials", async () => {
    const id = await open("ann", "bo");
    const rev = await lay("ann", id, { items: [RING], gold: 30, resources: { wood: 4 } });
    expect(await acceptTrade(db, "ann", id, rev)).toMatchObject({ ok: true, settled: false });
    // Bo sees Ann's side, and that she has accepted it.
    const seen = (await listTrades(db, "bo")).open[0];
    expect(seen).toMatchObject({ id, rev, opened: false, with: { id: "ann", name: "Ann" }, theirs: { gold: 30, resources: { wood: 4 }, missing: 0, ok: true }, mine: { gold: 0, items: [], ok: false } });
    expect(seen.theirs.items.map((i) => i.id)).toEqual([RING]);
    // Nothing has moved yet.
    expect([owner(RING).player_id, gold("ann")]).toEqual(["ann", 100]);
    expect(await acceptTrade(db, "bo", id, rev)).toMatchObject({ ok: true, settled: true });
    expect(owner(RING)).toEqual({ player_id: "bo", equipped: 0 });
    expect([gold("ann"), gold("bo")]).toEqual([70, 130]);
    expect([qty("ann", "wood"), qty("bo", "wood")]).toEqual([6, 5]);
    expect(trade(id).status).toBe("accepted");
    // Both hear how it ended.
    expect((await listTrades(db, "ann")).recent).toMatchObject([{ id, status: "accepted", mine: true, other: "Bo" }]);
    expect((await listTrades(db, "bo")).recent).toMatchObject([{ id, status: "accepted", mine: false, other: "Ann" }]);
  });

  it("gives a material the other has never held", async () => {
    const id = await open("bo", "ann");
    await lay("bo", id, { resources: { stone: 2 } });
    expect(await shake(id)).toMatchObject({ settled: true });
    expect([qty("ann", "stone"), qty("bo", "stone")]).toEqual([2, 3]);
  });
});

describe("a two-way trade", () => {
  it("moves both sides: gear, gold and materials each way", async () => {
    const id = await open("ann", "bo");
    await lay("ann", id, { items: [CAP], gold: 10, resources: { wood: 2 } });
    await lay("bo", id, { items: [BOOTS], gold: 25, resources: { stone: 3 } });
    expect(await shake(id, "bo", "ann")).toMatchObject({ settled: true });
    expect([owner(CAP).player_id, owner(BOOTS).player_id]).toEqual(["bo", "ann"]);
    expect([gold("ann"), gold("bo")]).toEqual([115, 85]);
    expect([qty("ann", "wood"), qty("bo", "wood"), qty("ann", "stone"), qty("bo", "stone")]).toEqual([8, 3, 3, 2]);
  });

  it("cannot be settled twice, or touched by anyone but its two players", async () => {
    const id = await open("ann", "bo");
    const rev = await lay("ann", id, { gold: 10 });
    expect(errorOf(await setTradeSide(db, "cy", id, side({ gold: 1 })))).toMatch(/no longer open/);
    expect(errorOf(await acceptTrade(db, "cy", id, rev))).toMatch(/no longer open/);
    expect(errorOf(await closeTrade(db, "cy", id))).toMatch(/no longer open/);
    expect(await shake(id)).toMatchObject({ settled: true });
    expect(errorOf(await acceptTrade(db, "bo", id, rev))).toMatch(/no longer open/);
    expect([gold("ann"), gold("bo")]).toEqual([90, 110]);
  });

  it("needs something on the table", async () => {
    const id = await open("ann", "bo");
    expect(errorOf(await acceptTrade(db, "ann", id, trade(id).rev))).toMatch(/Put something in the trade/);
  });
});

describe("accepting", () => {
  it("is taken back from both when either side changes, and a stale acceptance is refused", async () => {
    const id = await open("ann", "bo");
    const first = await lay("ann", id, { items: [RING] });
    await acceptTrade(db, "bo", id, first);
    expect(trade(id)).toMatchObject({ from_ok: 0, to_ok: 1 });
    // Ann swaps the ring for the cap just as she "accepts" what Bo agreed to.
    const second = await lay("ann", id, { items: [CAP] });
    expect(second).toBe(first + 1);
    expect(trade(id)).toMatchObject({ from_ok: 0, to_ok: 0 });
    expect(errorOf(await acceptTrade(db, "bo", id, first))).toMatch(/offer changed/);
    expect(await acceptTrade(db, "ann", id, second)).toMatchObject({ settled: false });
    expect([owner(RING).player_id, owner(CAP).player_id]).toEqual(["ann", "ann"]);
    expect(await acceptTrade(db, "bo", id, second)).toMatchObject({ settled: true });
    expect([owner(RING).player_id, owner(CAP).player_id]).toEqual(["ann", "bo"]);
  });

  it("stands when the same side is laid out again", async () => {
    const id = await open("ann", "bo");
    const rev = await lay("ann", id, { gold: 5, resources: { wood: 1 } });
    await acceptTrade(db, "bo", id, rev);
    expect(await lay("ann", id, { resources: { wood: 1 }, gold: 5 })).toBe(rev);
    expect(trade(id).to_ok).toBe(1);
  });

  it("can be taken back before the other accepts", async () => {
    const id = await open("ann", "bo");
    const rev = await lay("ann", id, { gold: 5 });
    await acceptTrade(db, "ann", id, rev);
    expect(await acceptTrade(db, "ann", id, rev, false)).toMatchObject({ ok: true, settled: false });
    expect(trade(id).from_ok).toBe(0);
    expect(await acceptTrade(db, "bo", id, rev)).toMatchObject({ settled: false });
    expect(gold("bo")).toBe(100);
  });
});

describe("a trade one side can no longer cover", () => {
  it.each([
    ["the item was sold", () => sql.prepare("DELETE FROM inventory WHERE id = ?").run(RING), /Ann no longer has one of those items/],
    ["the gold was spent", () => sql.prepare("UPDATE characters SET gold = 5 WHERE player_id = 'ann'").run(), /Ann does not have 30 gold/],
    ["the item was put on", () => sql.prepare("UPDATE inventory SET equipped = 1 WHERE id = ?").run(RING), /Ann is wearing Old Ring/],
  ])("moves nothing when %s, and stays open to be put right", async (_, change, said) => {
    const id = await open("ann", "bo");
    const rev = await lay("ann", id, { items: [RING], gold: 30 });
    await acceptTrade(db, "ann", id, rev);
    change();
    const before = snapshot();
    expect(errorOf(await acceptTrade(db, "bo", id, rev))).toMatch(said);
    expect(snapshot()).toEqual(before);
    expect(trade(id).status).toBe("open");
    // Ann lays out what she does have, and it goes through.
    const next = await lay("ann", id, { gold: 5 });
    await acceptTrade(db, "ann", id, next);
    expect(await acceptTrade(db, "bo", id, next)).toMatchObject({ settled: true });
    expect(gold("bo")).toBe(105);
  });

  it("names you when it is your own side that falls short", async () => {
    const id = await open("ann", "bo");
    const rev = await lay("ann", id, { gold: 30 });
    sql.prepare("UPDATE characters SET gold = 5 WHERE player_id = 'ann'").run();
    expect(errorOf(await acceptTrade(db, "ann", id, rev))).toBe("You do not have 30 gold.");
  });
});

describe("room in the pack", () => {
  const fill = (who: string, n: number) => {
    const ring = sql.prepare("INSERT INTO inventory (player_id, kind, ref, name, rarity, slot, equipped, created_at) VALUES (?, 'trinket', 'ring', 'Filler', 'common', 'ring', 0, 0)");
    for (let i = 0; i < n; i++) ring.run(who);
  };

  it("is needed for the gear that is coming, and what leaves makes it", async () => {
    // Bo's pack: the boots (four squares), a stack each of stone and wood, and rings to the brim.
    fill("bo", PACK_CELLS - 4 - 2);
    const id = await open("ann", "bo");
    const rev = await lay("ann", id, { items: [CAP] });
    await acceptTrade(db, "ann", id, rev);
    expect(errorOf(await acceptTrade(db, "bo", id, rev))).toMatch(/Your pack is full/);
    expect(trade(id).status).toBe("open");
    expect(owner(CAP).player_id).toBe("ann");
    // Handing the boots over makes the room for the cap.
    await lay("bo", id, { items: [BOOTS] });
    expect(await shake(id)).toMatchObject({ settled: true });
    expect([owner(CAP).player_id, owner(BOOTS).player_id]).toEqual(["bo", "ann"]);
  });
});

// The read-then-write race: these run the settling batch directly, skipping
// the friendly check that acceptTrade makes first, as if the holdings had
// changed in the moment between the two.
describe("the settling batch on its own", () => {
  const swap = { give: side({ items: [RING, CAP], gold: 10, resources: { wood: 2 } }), ask: side({ items: [BOOTS], resources: { stone: 3 } }) };
  /** A table both have accepted, as the batch would find it. */
  const agreed = async (run: string | null = null) => {
    const id = await open("ann", "bo", run);
    await lay("ann", id, swap.give);
    await lay("bo", id, swap.ask);
    sql.prepare("UPDATE trades SET from_ok = 1, to_ok = 1 WHERE id = ?").run(id);
    return id;
  };
  const settle = async (id: number, run: string | null = null) => {
    const res = await db.batch(settleStatements(db, { id, crew_id: "CREWAA", from_id: "ann", to_id: "bo", run_code: run, rev: trade(id).rev }, swap, `token-${Math.random()}`, Date.now()));
    return res.map((r) => r.meta.changes);
  };

  it("moves everything when every condition holds, and nothing the second time", async () => {
    const id = await agreed();
    expect((await settle(id)).every((n) => n === 1 || n === 2)).toBe(true);
    expect([owner(RING).player_id, owner(BOOTS).player_id, gold("bo"), qty("bo", "wood"), qty("ann", "stone")]).toEqual(["bo", "ann", 110, 3, 3]);
    const after = snapshot();
    expect((await settle(id)).every((n) => n === 0)).toBe(true);
    expect(snapshot()).toEqual(after);
  });

  it.each([
    ["an item was sold", () => sql.prepare("DELETE FROM inventory WHERE id = ?").run(CAP)],
    ["an item was equipped", () => sql.prepare("UPDATE inventory SET equipped = 1 WHERE id = ?").run(RING)],
    ["an item now belongs to someone else", () => sql.prepare("UPDATE inventory SET player_id = 'cy' WHERE id = ?").run(RING)],
    ["the other's item was sold", () => sql.prepare("DELETE FROM inventory WHERE id = ?").run(BOOTS)],
    ["one side's gold was spent", () => sql.prepare("UPDATE characters SET gold = 9 WHERE player_id = 'ann'").run()],
    ["one side's wood was spent", () => sql.prepare("UPDATE resources SET qty = 1 WHERE player_id = 'ann' AND kind = 'wood'").run()],
    ["the other's stone was spent", () => sql.prepare("UPDATE resources SET qty = 2 WHERE player_id = 'bo' AND kind = 'stone'").run()],
    ["the other's stone row is gone", () => sql.prepare("DELETE FROM resources WHERE player_id = 'bo' AND kind = 'stone'").run()],
    ["one of them left the crew", () => sql.prepare("DELETE FROM crew_members WHERE player_id = 'bo'").run()],
    ["one of them re-rolled their character", () => sql.prepare("UPDATE characters SET status = 'draft' WHERE player_id = 'ann'").run()],
    ["one walked into a fight", () => addRun("FGHT", "battle", ["ann"])],
    ["the other walked into a fight", () => addRun("FGHT", "battle", ["bo", "cy"])],
    ["one took their acceptance back", () => sql.prepare("UPDATE trades SET to_ok = 0").run()],
    ["a side changed since", () => sql.prepare("UPDATE trades SET rev = rev + 1").run()],
    ["the trade was cancelled", () => sql.prepare("UPDATE trades SET status = 'withdrawn'").run()],
    ["the trade was already settled", () => sql.prepare("UPDATE trades SET status = 'accepted', settle_token = 'earlier'").run()],
    ["the trade lapsed", () => sql.prepare("UPDATE trades SET created_at = ?").run(Date.now() - TRADE_TTL_MS - 1)],
  ])("moves nothing if %s", async (_, change) => {
    const id = await agreed();
    const rev = trade(id).rev;
    change();
    const before = snapshot();
    const res = await db.batch(settleStatements(db, { id, crew_id: "CREWAA", from_id: "ann", to_id: "bo", run_code: null, rev }, swap, "token", Date.now()));
    expect(res.map((r) => r.meta.changes).every((n) => n === 0)).toBe(true);
    expect(snapshot()).toEqual(before);
  });

  it("holds an island trade to its voyage: both aboard, and ashore", async () => {
    addRun("ISLE", "overworld", ["ann", "bo"]);
    const id = await agreed("ISLE");
    addRun("ISLE", "battle", ["ann", "bo"]);
    expect((await settle(id, "ISLE"))[0]).toBe(0);
    addRun("ISLE", "victory", ["ann", "bo"]);
    expect((await settle(id, "ISLE"))[0]).toBe(0);
    addRun("ISLE", "overworld", ["ann", "cy"]);
    expect((await settle(id, "ISLE"))[0]).toBe(0);
    addRun("ISLE", "overworld", ["ann", "bo"]);
    expect((await settle(id, "ISLE"))[0]).toBe(1);
    expect(owner(CAP).player_id).toBe("bo");
  });
});

describe("what cannot be laid on the table", () => {
  it("an equipped item", async () => {
    const id = await open("ann", "bo");
    expect(errorOf(await setTradeSide(db, "ann", id, side({ items: [MACE] })))).toBe("Unequip Mace first.");
  });

  it("someone else's item, more than is held, or anything that is not gear, gold or materials", async () => {
    const id = await open("ann", "bo");
    expect(errorOf(await setTradeSide(db, "bo", id, side({ items: [RING] })))).toMatch(/no longer have/);
    expect(errorOf(await setTradeSide(db, "ann", id, side({ gold: 101 })))).toBe("You do not have 101 gold.");
    expect(errorOf(await setTradeSide(db, "ann", id, side({ resources: { wood: 11 } })))).toBe("You do not have 11 wood.");
    expect(errorOf(await setTradeSide(db, "ann", id, side({ gold: -5 })))).toMatch(/whole number/);
    expect(errorOf(await setTradeSide(db, "ann", id, { furnishings: [1] }))).toMatch(/furnishings/);
    // None of that changed the table.
    expect(trade(id).rev).toBe(0);
  });
});

describe("the table", () => {
  it("is not opened with yourself, a stranger, or another crew", async () => {
    expect(errorOf(await openTrade(db, "ann", "ann", null))).toMatch(/yourself/);
    expect(errorOf(await openTrade(db, "ann", "nobody", null))).toMatch(/no such crewmate/);
    expect(errorOf(await openTrade(db, "ann", "cy", null))).toMatch(/same crew/);
    expect(errorOf(await openTrade(db, "ann", 7, null))).toMatch(/Name the crewmate/);
  });

  it("is one between two players, whoever opens it, until one walks away", async () => {
    const id = await open("ann", "bo");
    expect(await open("bo", "ann")).toBe(id);
    expect(await open("ann", "bo")).toBe(id);
    expect(await closeTrade(db, "bo", id)).toEqual({ ok: true });
    expect(trade(id).status).toBe("declined");
    expect((await listTrades(db, "ann")).recent).toMatchObject([{ id, status: "declined", mine: true, other: "Bo" }]);
    const again = await open("bo", "ann");
    expect(again).not.toBe(id);
    expect(await closeTrade(db, "bo", again)).toEqual({ ok: true });
    expect(trade(again).status).toBe("withdrawn");
  });

  it("lapses if nobody settles it, and makes way for a new one", async () => {
    const id = await open("ann", "bo");
    const rev = await lay("ann", id, { gold: 1 });
    sql.prepare("UPDATE trades SET created_at = ? WHERE id = ?").run(Date.now() - TRADE_TTL_MS - 1, id);
    expect((await listTrades(db, "bo")).open).toEqual([]);
    expect(errorOf(await acceptTrade(db, "bo", id, rev))).toMatch(/no longer open/);
    expect(await open("bo", "ann")).not.toBe(id);
    expect(trade(id).status).toBe("expired");
  });
});

describe("fights", () => {
  it("keep the table shut while either player is in one", async () => {
    addRun("FGHT", "battle", ["bo"]);
    expect(errorOf(await openTrade(db, "ann", "bo", null))).toBe("Bo is in a fight. Trading waits until the fight is over.");
    expect(errorOf(await openTrade(db, "bo", "ann", null))).toBe("You are in a fight. Trading waits until the fight is over.");
  });

  it("refuse an acceptance, move nothing, and leave the trade open for afterwards", async () => {
    const id = await open("ann", "bo");
    await lay("ann", id, { items: [RING] });
    const rev = await lay("bo", id, { gold: 20 });
    await acceptTrade(db, "ann", id, rev);
    addRun("FGHT", "battle", ["ann"]);
    const before = snapshot();
    expect(errorOf(await acceptTrade(db, "bo", id, rev))).toBe("Ann is in a fight. Trading waits until the fight is over.");
    expect(snapshot()).toEqual(before);
    expect(trade(id).status).toBe("open");
    addRun("FGHT", "overworld", ["ann"]);
    expect(await acceptTrade(db, "bo", id, rev)).toMatchObject({ settled: true });
    expect([owner(RING).player_id, gold("ann")]).toEqual(["bo", 120]);
  });

  it("do not count once the voyage is long abandoned", async () => {
    addRun("FGHT", "battle", ["bo"], Date.now() - 13 * 60 * 60_000);
    const id = await open("ann", "bo");
    await lay("ann", id, { gold: 1 });
    expect(await shake(id)).toMatchObject({ settled: true });
  });
});

describe("on an island", () => {
  it("allows a trade between two heroes of a voyage that is ashore", async () => {
    addRun("ISLE", "overworld", ["ann", "bo"]);
    const id = await open("ann", "bo", "ISLE");
    await lay("ann", id, { items: [CAP] });
    expect((await listTrades(db, "bo")).open[0].runCode).toBe("ISLE");
    expect(await shake(id)).toMatchObject({ settled: true });
    expect(owner(CAP)).toEqual({ player_id: "bo", equipped: 0 });
  });

  it("opens a fresh table when the two meet somewhere else", async () => {
    const harbor = await open("ann", "bo");
    addRun("ISLE", "overworld", ["ann", "bo"]);
    const island = await open("bo", "ann", "ISLE");
    expect(island).not.toBe(harbor);
    expect(trade(harbor).status).toBe("expired");
  });

  it.each(["lobby", "generating", "battle", "victory", "defeat"])("refuses while the voyage is in %s", async (status) => {
    addRun("ISLE", status, ["ann", "bo"]);
    expect(errorOf(await openTrade(db, "ann", "bo", "ISLE"))).toBeTruthy();
  });

  it("refuses a hero who is not aboard, and a voyage that does not exist", async () => {
    addRun("ISLE", "overworld", ["ann"]);
    expect(errorOf(await openTrade(db, "ann", "bo", "ISLE"))).toMatch(/same voyage/);
    expect(errorOf(await openTrade(db, "ann", "bo", "NOPE"))).toMatch(/voyage is over/);
  });

  it("refuses an acceptance once a fight has begun, and closes the trade once the voyage has ended", async () => {
    addRun("ISLE", "overworld", ["ann", "bo"]);
    const id = await open("ann", "bo", "ISLE");
    const rev = await lay("ann", id, { gold: 5 });
    addRun("ISLE", "battle", ["ann", "bo"]);
    expect(errorOf(await acceptTrade(db, "bo", id, rev))).toMatch(/in a fight/);
    expect(trade(id).status).toBe("open");
    addRun("ISLE", "defeat", ["ann", "bo"]);
    expect(errorOf(await acceptTrade(db, "bo", id, rev))).toMatch(/voyage is over.*trade is closed/);
    expect(trade(id).status).toBe("failed");
    expect([gold("ann"), gold("bo")]).toEqual([100, 100]);
  });
});
