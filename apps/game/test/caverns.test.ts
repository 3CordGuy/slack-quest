// Delves into the Haunted Caverns are stored and listed as their own kind of
// run, against a real SQLite database with the game's migrations applied (the
// same stand-in for D1 as storage.test.ts).

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createRun, getRun, harborBoard } from "../src/server/db";

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
  const db = { prepare: (text: string) => new Stmt(sql, text), batch: async (stmts: Stmt[]) => stmts.map((s) => s.exec()) };
  return { sql, db: db as unknown as D1Database };
}

let sql: DatabaseSync;
let db: D1Database;

beforeEach(() => {
  ({ sql, db } = openDb());
  const at = Date.now();
  sql.prepare("INSERT INTO players (id, name, created_at) VALUES ('ann', 'Ann', ?)").run(at);
  sql.prepare("INSERT INTO characters (player_id, name, class_id, status, str, int_stat, vit, agi, dex, gold, created_at) VALUES ('ann', 'Ann', 'qa_paladin', 'active', 5, 5, 5, 5, 5, 100, ?)").run(at);
  sql.prepare("INSERT INTO crews (id, name, created_by, created_at) VALUES ('CREWAA', 'Crew', 'ann', ?)").run(at);
  sql.prepare("INSERT INTO crew_members (crew_id, player_id, joined_at) VALUES ('CREWAA', 'ann', ?)").run(at);
});

describe("delves", () => {
  it("are stored as caverns runs, and runs default to voyages", async () => {
    const delve = await createRun(db, "ann", "CREWAA", [], "caverns");
    const voyage = await createRun(db, "ann", "CREWAA");
    expect((await getRun(db, delve))!.kind).toBe("caverns");
    expect((await getRun(db, voyage))!.kind).toBe("voyage");
  });

  it("gather at the cave mouth: listed on the board with their kind, but never given a pier", async () => {
    const delve = await createRun(db, "ann", "CREWAA", [], "caverns");
    const voyage = await createRun(db, "ann", "CREWAA");
    const board = await harborBoard(db, "CREWAA", 3);
    const byCode = Object.fromEntries(board.ships.map((s) => [s.code, s]));
    expect(byCode[delve]).toMatchObject({ kind: "caverns", pier: null, phase: "lobby" });
    expect(byCode[voyage]).toMatchObject({ kind: "voyage", pier: 0 });
  });
});
