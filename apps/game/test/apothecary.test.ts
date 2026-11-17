// Brewing potions and flasks for the pack at the apothecary, against a real
// SQLite database with the game's migrations applied (the same stand-in for
// D1 as storage.test.ts).

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { APOTHECARY_PROJECT, CARRY_BASE } from "@gantt-quest/world";
import { consumablesOf } from "../src/server/consumables";
import { carryState } from "../src/server/db";
import { apothecaryView, brewFlask } from "../src/server/workshops";

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

const give = (kind: string, qty: number) => sql.prepare("INSERT INTO resources (player_id, kind, qty) VALUES ('ann', ?, ?) ON CONFLICT(player_id, kind) DO UPDATE SET qty = excluded.qty").run(kind, qty);
const holds = (kind: string) => (sql.prepare("SELECT qty FROM resources WHERE player_id = 'ann' AND kind = ?").get(kind) as { qty: number } | undefined)?.qty ?? 0;
const build = () => sql.prepare("INSERT INTO crew_projects (crew_id, project_id, built_at) VALUES ('CREWAA', ?, ?)").run(APOTHECARY_PROJECT, Date.now());

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

describe("brewing for the pack", () => {
  it("turns what it takes into one more in the pack, each time, for as long as the materials last", async () => {
    build();
    give("herbs", 7);
    expect(await brewFlask(db, "ann", "healing")).not.toBeTypeOf("string");
    expect(await brewFlask(db, "ann", "healing")).not.toBeTypeOf("string");
    expect(await consumablesOf(db, "ann")).toEqual({ healing: 2 });
    expect(holds("herbs")).toBe(1);
    // A stack of them is one square of the pack, however many are in it.
    expect((await carryState(db, "ann"))!.carried).toBe(2);
    expect(await brewFlask(db, "ann", "healing")).toMatch(/3 herbs/);
    expect(await consumablesOf(db, "ann")).toEqual({ healing: 2 });
    expect((await apothecaryView(db, "ann")).carried).toEqual({ healing: 2 });
  });

  it("needs the apothecary built, and makes only what there is a recipe for", async () => {
    give("fur", 5);
    expect(await brewFlask(db, "ann", "water")).toMatch(/not built/);
    build();
    expect(await brewFlask(db, "ann", "elixir")).toMatch(/does not make/);
    expect(await brewFlask(db, "ann", "water")).not.toBeTypeOf("string");
    expect(await consumablesOf(db, "ann")).toEqual({ water: 1 });
    expect(holds("fur")).toBe(4);
  });

  it("needs a free square of the pack for the first of a kind, and none for one more of a kind already carried", async () => {
    build();
    give("fur", 5);
    give("bone", 9);
    // Fill the pack to the brim with rings, less the two squares the materials take.
    const ring = sql.prepare("INSERT INTO inventory (player_id, kind, ref, name, rarity, slot, equipped, created_at) VALUES ('ann', 'trinket', 'ring', ?, 'common', 'ring', 0, ?)");
    for (let i = 0; i < CARRY_BASE - 3; i++) ring.run(`Ring ${i}`, Date.now());
    expect(await brewFlask(db, "ann", "water")).not.toBeTypeOf("string");
    expect((await carryState(db, "ann"))!.carried).toBe(CARRY_BASE);
    expect(await brewFlask(db, "ann", "oil")).toMatch(/pack is full/);
    expect(holds("bone")).toBe(9);
    expect(await brewFlask(db, "ann", "water")).not.toBeTypeOf("string");
    expect(await consumablesOf(db, "ann")).toEqual({ water: 2 });
  });
});
