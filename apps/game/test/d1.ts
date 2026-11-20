// The stand-in for D1 that the server's tests run on: Node's built-in SQLite
// with the game's migrations applied, behind the few D1 methods the server
// uses. A batch is one transaction, as it is on D1. Also here: the rows most
// of those tests start from (a player with a hero, and their crew).
//
// Not a test file itself. It lives outside src/ because the app's tsconfig
// has no Node types.

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export type Row = Record<string, unknown>;

/** Every migration, in order. Read once for a test file, however many databases it opens. */
let migrations: string[] | undefined;
function migrationSql(): string[] {
  if (!migrations) {
    const dir = new URL("../migrations/", import.meta.url);
    migrations = readdirSync(dir).sort().map((file) => readFileSync(new URL(file, dir), "utf8"));
  }
  return migrations;
}

/** One prepared statement, as D1 hands one out. `answered`, if given, is waited on before it runs (see `openDb`). */
export class Stmt {
  constructor(private sql: DatabaseSync, private text: string, private args: unknown[] = [], private answered?: () => Promise<void>) {}
  bind(...args: unknown[]) {
    return new Stmt(this.sql, this.text, args, this.answered);
  }
  exec() {
    const stmt = this.sql.prepare(this.text);
    if (/^\s*(SELECT|WITH)/i.test(this.text)) return { results: stmt.all(...(this.args as never[])) as Row[], meta: { changes: 0, last_row_id: 0 } };
    const res = stmt.run(...(this.args as never[]));
    return { results: [] as Row[], meta: { changes: Number(res.changes), last_row_id: Number(res.lastInsertRowid) } };
  }
  async run() {
    if (this.answered) await this.answered();
    return this.exec();
  }
  async all() {
    if (this.answered) await this.answered();
    return this.exec();
  }
  async first() {
    if (this.answered) await this.answered();
    return this.exec().results[0] ?? null;
  }
}

/**
 * A fresh database in memory with every migration applied: `sql` to set rows up and look at them directly, `db`
 * to hand to the server's code as its D1. `answered` is waited on before each statement or batch runs, for a
 * test that wants the database to take a turn of the event loop to answer, as D1 does over the network.
 */
export function openDb(opts: { answered?: () => Promise<void> } = {}): { sql: DatabaseSync; db: D1Database } {
  const sql = new DatabaseSync(":memory:");
  for (const text of migrationSql()) sql.exec(text);
  const db = {
    prepare: (text: string) => new Stmt(sql, text, [], opts.answered),
    async batch(stmts: Stmt[]) {
      if (opts.answered) await opts.answered();
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

export interface HeroSeed {
  id: string;
  name: string;
  /** The test Paladin unless said. */
  classId?: string;
  status?: "active" | "draft";
  level?: number;
  /** Each stat is 5 unless said. */
  str?: number;
  int_stat?: number;
  vit?: number;
  agi?: number;
  dex?: number;
  /** 100 unless said. */
  gold?: number;
  /** The crew they are in, made (named "Crew", theirs) if it is not there yet. */
  crew?: string | null;
  /** When all of it was written: now, unless said. */
  at?: number;
}

/** A player and their hero, and their place in a crew if one is named. */
export function addHero(sql: DatabaseSync, hero: HeroSeed): void {
  const at = hero.at ?? Date.now();
  sql.prepare("INSERT INTO players (id, name, created_at) VALUES (?, ?, ?)").run(hero.id, hero.name, at);
  sql
    .prepare("INSERT INTO characters (player_id, name, class_id, status, level, str, int_stat, vit, agi, dex, gold, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(hero.id, hero.name, hero.classId ?? "qa_paladin", hero.status ?? "active", hero.level ?? 1, hero.str ?? 5, hero.int_stat ?? 5, hero.vit ?? 5, hero.agi ?? 5, hero.dex ?? 5, hero.gold ?? 100, at);
  if (hero.crew) {
    addCrew(sql, hero.crew, hero.id, at);
    sql.prepare("INSERT INTO crew_members (crew_id, player_id, joined_at) VALUES (?, ?, ?)").run(hero.crew, hero.id, at);
  }
}

/** A crew, if there is none by that id yet. Its founder has to be a player already. */
export function addCrew(sql: DatabaseSync, id: string, createdBy: string, at = Date.now(), name = "Crew"): void {
  sql.prepare("INSERT OR IGNORE INTO crews (id, name, created_by, created_at) VALUES (?, ?, ?, ?)").run(id, name, createdBy, at);
}
