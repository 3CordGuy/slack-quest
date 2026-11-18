// Renaming a hero from their sheet, against a real SQLite database with the game's migrations applied
// (the same stand-in for D1 as apothecary.test.ts).

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanHeroName, renameCharacter } from "../src/server/db";

type Row = Record<string, unknown>;

class Stmt {
  constructor(private sql: DatabaseSync, private text: string, private args: unknown[] = []) {}
  bind(...args: unknown[]) {
    return new Stmt(this.sql, this.text, args);
  }
  exec() {
    const stmt = this.sql.prepare(this.text);
    if (/^\s*(SELECT|WITH)/i.test(this.text)) return { results: stmt.all(...(this.args as never[])) as Row[], meta: { changes: 0 } };
    const res = stmt.run(...(this.args as never[]));
    return { results: [] as Row[], meta: { changes: Number(res.changes) } };
  }
  async run() {
    return this.exec();
  }
  async first() {
    return this.exec().results[0] ?? null;
  }
}

let sql: DatabaseSync;
let db: D1Database;
const nameOf = (id: string) => (sql.prepare("SELECT name FROM characters WHERE player_id = ?").get(id) as { name: string }).name;

beforeEach(() => {
  sql = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) sql.exec(readFileSync(new URL(file, dir), "utf8"));
  db = { prepare: (text: string) => new Stmt(sql, text) } as unknown as D1Database;
  const at = Date.now();
  for (const [id, name, status] of [["ann", "Ann", "active"], ["bob", "Bob", "active"], ["cat", "Cat", "draft"]]) {
    sql.prepare("INSERT INTO players (id, name, created_at) VALUES (?, ?, ?)").run(id, name, at);
    sql.prepare("INSERT INTO characters (player_id, name, class_id, status, str, int_stat, vit, agi, dex, created_at) VALUES (?, ?, 'qa_paladin', ?, 5, 5, 5, 5, 5, ?)").run(id, name, status, at);
  }
});

describe("cleanHeroName", () => {
  it("tidies spaces and keeps 2 to 20 characters", () => {
    expect(cleanHeroName("  Salt   Annie ")).toBe("Salt Annie");
    expect(cleanHeroName("A")).toBeNull();
    expect(cleanHeroName("x".repeat(21))).toBeNull();
    expect(cleanHeroName(undefined)).toBeNull();
  });
});

describe("renameCharacter", () => {
  it("renames your own hero", async () => {
    expect(await renameCharacter(db, "ann", "Salt Annie")).toBeNull();
    expect(nameOf("ann")).toBe("Salt Annie");
  });

  it("refuses another hero's name in any case, but lets you change your own capitals", async () => {
    expect(await renameCharacter(db, "ann", "BOB")).toMatch(/already/);
    expect(nameOf("ann")).toBe("Ann");
    expect(await renameCharacter(db, "ann", "ANN")).toBeNull();
    expect(nameOf("ann")).toBe("ANN");
  });

  it("does not rename a hero still being made", async () => {
    expect(await renameCharacter(db, "cat", "Kit")).toMatch(/No hero/);
    expect(nameOf("cat")).toBe("Cat");
  });
});
