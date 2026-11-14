// Table stakes on the server, against a real SQLite database with the game's
// migrations applied (the same stand-in for D1 as fishing.test.ts): a table
// opens free or at any whole stake up to STAKE_MAX, a free game moves no gold
// at the start or the end, and a stake the seats cannot cover is refused.

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { STAKE_MAX, diceSplit, type DiceRequest, type HarborPlayer } from "@gantt-quest/world";
import type { Env } from "../src/server/db";
import { DICE_RULES, StakeTable } from "../src/server/stake-table";

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

function addPlayer(id: string, name: string, gold: number) {
  sql.prepare("INSERT INTO players (id, name, created_at) VALUES (?, ?, 0)").run(id, name);
  sql.prepare("INSERT INTO characters (player_id, name, class_id, status, str, int_stat, vit, agi, dex, gold, created_at) VALUES (?, ?, 'cleric', 'active', 5, 5, 5, 5, 5, ?, 0)").run(id, name, gold);
}
const gold = (id: string) => (sql.prepare("SELECT gold FROM characters WHERE player_id = ?").get(id) as { gold: number }).gold;

beforeEach(() => {
  ({ sql, db } = openDb());
  addPlayer("ann", "Ann", 0);
  addPlayer("bob", "Bob", 1500);
});

/** A dice table with Ann and Bob standing at it; `walk` moves Bob away, which forfeits his seat mid-game. */
function room() {
  const at = DICE_RULES.spot;
  const players: HarborPlayer[] = [
    { id: "ann", name: "Ann", classId: "cleric", level: 1, pos: at },
    { id: "bob", name: "Bob", classId: "cleric", level: 1, pos: at },
  ];
  const store = new Map<string, unknown>();
  const sockets = players.map((p, i) => ({
    tag: p.id,
    sent: [] as { type: string; text?: string; table?: { phase: string; ante: number; pot: number; winner: string | null } | null }[],
    deserializeAttachment: () => players[i],
    serializeAttachment() {},
    send(m: string) {
      this.sent.push(JSON.parse(m));
    },
  }));
  const ctx = {
    storage: { get: async (k: string) => store.get(k), put: async (k: string, v: unknown) => void store.set(k, v), delete: async (k: string) => void store.delete(k) },
    getWebSockets: (tag?: string) => sockets.filter((s) => !tag || s.tag === tag),
  } as unknown as DurableObjectState;
  const table = new StakeTable<Parameters<typeof DICE_RULES.view>[0], DiceRequest>(ctx, { DB: db } as Env, DICE_RULES);
  const ws = sockets as unknown as WebSocket[];
  const ask = (who: 0 | 1, request: DiceRequest) => table.handle(ws[who], players[who], request);
  const last = (who: 0 | 1) => sockets[who].sent.at(-1)!;
  const walk = async () => {
    players[1] = { ...players[1], pos: { q: at.q + 1, r: at.r } };
    await table.reconcile();
  };
  return { ask, last, walk };
}

describe("table stakes on the server", () => {
  it("plays a free game with no gold at all, start to finish", async () => {
    const t = room();
    await t.ask(0, { type: "open", ante: 0 });
    await t.ask(1, { type: "sit" });
    await t.ask(0, { type: "start" });
    expect(t.last(0).table).toMatchObject({ phase: "playing", ante: 0, pot: 0 });
    await t.walk();
    expect(t.last(0).table).toMatchObject({ phase: "done", winner: "ann" });
    expect([gold("ann"), gold("bob")]).toEqual([0, 1500]);
  });

  it("opens at any whole stake up to the most, and pays the pot less the house's cut", async () => {
    sql.prepare("UPDATE characters SET gold = 100 WHERE player_id = 'ann'").run();
    const t = room();
    await t.ask(1, { type: "open", ante: 37 });
    await t.ask(0, { type: "sit" });
    await t.ask(1, { type: "start" });
    expect([gold("ann"), gold("bob")]).toEqual([63, 1463]);
    // Bob walks off and forfeits: Ann takes the pot.
    await t.walk();
    expect(t.last(0).table).toMatchObject({ phase: "done", winner: "ann" });
    expect(gold("ann")).toBe(63 + diceSplit(74).prize);
  });

  it("refuses a stake that is not a whole number from 0 to the most, or that the opener cannot cover", async () => {
    const t = room();
    for (const ante of [-1, 2.5, STAKE_MAX + 1, "10" as unknown as number]) {
      await t.ask(1, { type: "open", ante });
      expect(t.last(1)).toMatchObject({ type: "diceError", text: `Pick a stake: free, or a whole number of gold up to ${STAKE_MAX}.` });
    }
    await t.ask(0, { type: "open", ante: 1 });
    expect(t.last(0)).toMatchObject({ type: "diceError", text: "You cannot afford that ante." });
    await t.ask(1, { type: "open", ante: STAKE_MAX });
    expect(t.last(1).table).toMatchObject({ phase: "open", ante: STAKE_MAX });
    // Ann has nothing: she can sit at a free table but not at this one.
    await t.ask(0, { type: "sit" });
    expect(t.last(0)).toMatchObject({ type: "diceError", text: "You cannot afford the ante." });
  });
});
