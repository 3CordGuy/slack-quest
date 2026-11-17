// Buying from the smith and the apothecary in their shops, and haggling with
// them, against a real SQLite database with the game's migrations applied
// (the same stand-in for D1 as apothecary.test.ts).

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { APOTHECARY_PROJECT, SHELF_DAILY, SHELF_PRICES, SMITHY_PROJECT, shelfKey, workKey } from "@gantt-quest/world";
import { consumablesOf } from "../src/server/consumables";
import { apothecaryView, buyFromKeeper, haggle, smithItem, smithyView } from "../src/server/workshops";

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

let sql: DatabaseSync;
let db: D1Database;

const gold = () => (sql.prepare("SELECT gold FROM characters WHERE player_id = 'ann'").get() as { gold: number }).gold;
const setGold = (n: number) => sql.prepare("UPDATE characters SET gold = ? WHERE player_id = 'ann'").run(n);
const give = (kind: string, qty: number) => sql.prepare("INSERT INTO resources (player_id, kind, qty) VALUES ('ann', ?, ?) ON CONFLICT(player_id, kind) DO UPDATE SET qty = excluded.qty").run(kind, qty);
const holds = (kind: string) => (sql.prepare("SELECT qty FROM resources WHERE player_id = 'ann' AND kind = ?").get(kind) as { qty: number } | undefined)?.qty ?? 0;
const build = (project = APOTHECARY_PROJECT) => sql.prepare("INSERT INTO crew_projects (crew_id, project_id, built_at) VALUES ('CREWAA', ?, ?)").run(project, Date.now());

beforeEach(() => {
  sql = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) sql.exec(readFileSync(new URL(file, dir), "utf8"));
  db = {
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
  } as unknown as D1Database;
  const at = Date.now();
  sql.prepare("INSERT INTO players (id, name, created_at) VALUES ('ann', 'Ann', ?)").run(at);
  sql.prepare("INSERT INTO characters (player_id, name, class_id, status, str, int_stat, vit, agi, dex, gold, created_at) VALUES ('ann', 'Ann', 'qa_paladin', 'active', 5, 5, 5, 5, 5, 100, ?)").run(at);
  sql.prepare("INSERT INTO crews (id, name, created_by, created_at) VALUES ('CREWAA', 'Crew', 'ann', ?)").run(at);
  sql.prepare("INSERT INTO crew_members (crew_id, player_id, joined_at) VALUES ('CREWAA', 'ann', ?)").run(at);
});

describe("the apothecary's shelf", () => {
  it("sells a flask ready-made for gold, a few of each a day", async () => {
    build();
    setGold(1000);
    const key = shelfKey("healing");
    for (let i = 0; i < SHELF_DAILY; i++) expect(await buyFromKeeper(db, "ann", "apothecary", key)).toEqual({ got: "Healing potion" });
    expect(gold()).toBe(1000 - SHELF_DAILY * SHELF_PRICES.healing);
    expect(await consumablesOf(db, "ann")).toEqual({ healing: SHELF_DAILY });
    expect(await buyFromKeeper(db, "ann", "apothecary", key)).toMatch(/all the healing potions/);
    expect(gold()).toBe(1000 - SHELF_DAILY * SHELF_PRICES.healing);
  });

  it("takes nothing without the gold, and sells nothing before the crew has built the place", async () => {
    setGold(1000);
    expect(await buyFromKeeper(db, "ann", "apothecary", shelfKey("fire"))).toMatch(/not built/);
    build();
    setGold(5);
    expect(await buyFromKeeper(db, "ann", "apothecary", shelfKey("fire"))).toMatch(/Not enough gold/);
    expect(await buyFromKeeper(db, "ann", "apothecary", "flask:elixir")).toMatch(/nothing like that/);
    expect(gold()).toBe(5);
  });
});

describe("haggling", () => {
  it("takes the asked share off for the rest of the day when the keeper agrees, and only one try a day", async () => {
    build();
    setGold(1000);
    const key = shelfKey("acid");
    const res = await haggle(db, "ann", "apothecary", key, "push", 0);
    expect(res).toMatchObject({ won: true, list: SHELF_PRICES.acid, price: Math.ceil(SHELF_PRICES.acid * 0.8) });
    const ware = (await apothecaryView(db, "ann")).wares.find((w) => w.key === key)!;
    expect(ware.price).toBe(Math.ceil(SHELF_PRICES.acid * 0.8));
    expect(await haggle(db, "ann", "apothecary", key, "nudge", 0)).toMatch(/had your say/);
    await buyFromKeeper(db, "ann", "apothecary", key);
    expect(gold()).toBe(1000 - Math.ceil(SHELF_PRICES.acid * 0.8));
  });

  it("keeps the price, and the no, when the keeper will not have it", async () => {
    build();
    const key = shelfKey("oil");
    expect(await haggle(db, "ann", "apothecary", key, "lowball", 99)).toMatchObject({ won: false, price: SHELF_PRICES.oil });
    expect(await haggle(db, "ann", "apothecary", key, "nudge", 0)).toMatch(/had your say/);
    expect((await apothecaryView(db, "ann")).wares.find((w) => w.key === key)!.price).toBe(SHELF_PRICES.oil);
  });

  it("knocks the gold off the smith's sharpening, and has nothing to talk down on armour", async () => {
    build(SMITHY_PROJECT);
    setGold(1000);
    give("iron", 10);
    give("copper", 10);
    const add = sql.prepare("INSERT INTO inventory (player_id, kind, ref, name, rarity, slot, equipped, created_at) VALUES ('ann', ?, ?, ?, 'common', ?, 0, ?)");
    const blade = Number(add.run("weapon", "mace", "Mace", "main_hand", Date.now()).lastInsertRowid);
    const coat = Number(add.run("armor", "plate", "Coat", "body", Date.now()).lastInsertRowid);
    expect(await haggle(db, "ann", "smithy", workKey(blade), "lowball", 0)).toMatchObject({ won: true, list: 40, price: 26 });
    expect((await smithyView(db, "ann")).items.find((i) => i.id === blade)!.cost!.gold).toBe(26);
    expect(await smithItem(db, "ann", blade)).not.toBeTypeOf("string");
    expect(gold()).toBe(1000 - 26);
    expect(await haggle(db, "ann", "smithy", workKey(coat), "nudge", 0)).toMatch(/not gold/);
  });

  it("sells from the smith's rack once each, at the haggled price", async () => {
    build(SMITHY_PROJECT);
    setGold(5000);
    const [first] = (await smithyView(db, "ann")).wares;
    expect(await haggle(db, "ann", "smithy", first.key, "nudge", 0)).toMatchObject({ won: true });
    const res = await buyFromKeeper(db, "ann", "smithy", first.key);
    expect(res).not.toBeTypeOf("string");
    expect(gold()).toBe(5000 - Math.ceil(first.list * 0.9));
    expect(await buyFromKeeper(db, "ann", "smithy", first.key)).toMatch(/Sold/);
  });

  it("refuses an ask that is not on the list, and a shop that is not there", async () => {
    build();
    expect(await haggle(db, "ann", "apothecary", shelfKey("fire"), "everything", 0)).toMatch(/Ask for what/);
    expect(await haggle(db, "ann", "galley", shelfKey("fire"), "nudge", 0)).toMatch(/nobody there/);
  });
});
