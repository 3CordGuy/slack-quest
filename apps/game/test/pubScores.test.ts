// The pub's leaderboard, against a real SQLite database with the game's
// migrations applied (the same stand-in for D1 as fishing.test.ts): a
// finished game is written in the batch that pays its pot, wins and gold add
// up per crew, game and player, streaks reset on a loss, and the board reads
// back in order.

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { HarborPlayer } from "@gantt-quest/world";
import type { Env } from "../src/server/db";
import { pubLeaderboard, scoreStatements, type PubLeaderboard, type PubResult } from "../src/server/pub-scores";
import { CREW_RULES, StakeTable } from "../src/server/stake-table";

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

const CREW = "CREWAA";
const OTHER = "CREWBB";

let sql: DatabaseSync;
let db: D1Database;

function addPlayer(id: string, name: string, crew: string | null, gold = 100) {
  const at = Date.now();
  sql.prepare("INSERT INTO players (id, name, created_at) VALUES (?, ?, ?)").run(id, name, at);
  sql.prepare("INSERT INTO characters (player_id, name, class_id, status, str, int_stat, vit, agi, dex, gold, created_at) VALUES (?, ?, 'cleric', 'active', 5, 5, 5, 5, 5, ?, ?)").run(id, name, gold, at);
  if (crew) sql.prepare("INSERT INTO crew_members (crew_id, player_id, joined_at) VALUES (?, ?, ?)").run(crew, id, at);
}

beforeEach(() => {
  ({ sql, db } = openDb());
  const at = Date.now();
  addPlayer("ann", "Ann", null);
  sql.prepare("INSERT INTO crews (id, name, created_by, created_at) VALUES (?, 'Crew', 'ann', ?)").run(CREW, at);
  sql.prepare("INSERT INTO crews (id, name, created_by, created_at) VALUES (?, 'Others', 'ann', ?)").run(OTHER, at);
  sql.prepare("INSERT INTO crew_members (crew_id, player_id, joined_at) VALUES (?, 'ann', ?)").run(CREW, at);
  addPlayer("bob", "Bob", CREW);
  addPlayer("cat", "Cat", CREW);
  addPlayer("dan", "Dan", OTHER);
});

const record = (crew: string | null, result: PubResult) => db.batch(scoreStatements(db, crew, result));
const dice = (winner: string | null, seats = ["ann", "bob"], ante = 10): PubResult => ({ game: "dice", ante, seats: seats.map((id) => ({ id })), winner, prize: Math.floor(ante * seats.length * 0.9) });
const board = async (player = "ann") => (await pubLeaderboard(db, player)) as PubLeaderboard;

describe("recording a finished game", () => {
  it("adds a game played for every seat and the win, prize and streak for the winner", async () => {
    await record(CREW, dice("ann"));
    const { dice: rows } = await board();
    expect(rows.map((r) => [r.name, r.played, r.wins, r.goldWon, r.net, r.streak, r.bestStreak])).toEqual([
      ["Ann", 1, 1, 18, 8, 1, 1],
      ["Bob", 1, 0, 0, -10, 0, 0],
    ]);
  });

  it("adds games up, resets a streak on a loss and keeps the best", async () => {
    await record(CREW, dice("ann"));
    await record(CREW, dice("ann"));
    await record(CREW, dice("bob"));
    await record(CREW, dice("ann"));
    const ann = (await board()).dice.find((r) => r.playerId === "ann")!;
    expect(ann).toMatchObject({ played: 4, wins: 3, goldWon: 54, net: 14, streak: 1, bestStreak: 2 });
  });

  it("keeps each game apart, and the most cargo in a Cargo and Krakens game", async () => {
    const totals: Record<string, number> = { ann: 9, bob: 4 };
    await record(CREW, { game: "crew", ante: 5, seats: [{ id: "ann" }, { id: "bob" }], winner: "ann", prize: 9, cargo: (id) => totals[id] });
    totals.ann = 6;
    totals.bob = 11;
    await record(CREW, { game: "crew", ante: 5, seats: [{ id: "ann" }, { id: "bob" }], winner: "bob", prize: 9, cargo: (id) => totals[id] });
    // A game saved before totals: no cargo, and the best stands.
    await record(CREW, { game: "crew", ante: 5, seats: [{ id: "ann" }], winner: null, prize: 0, cargo: () => null });
    const b = await board();
    expect(b.dice).toEqual([]);
    expect(b.crew.map((r) => [r.name, r.played, r.wins, r.best])).toEqual([
      ["Bob", 2, 1, 11],
      ["Ann", 3, 1, 9],
    ]);
  });

  it("keeps Turn the Tide on a board of its own", async () => {
    await record(CREW, { game: "tide", ante: 20, seats: [{ id: "ann" }, { id: "bob" }, { id: "cat" }], winner: "cat", prize: 54 });
    const b = await board();
    expect([b.dice, b.shoals, b.crew]).toEqual([[], [], []]);
    expect(b.tide.map((r) => [r.name, r.played, r.wins, r.goldWon, r.net])).toEqual([
      ["Cat", 1, 1, 54, 34],
      ["Ann", 1, 0, 0, -20],
      ["Bob", 1, 0, 0, -20],
    ]);
  });

  it("is per crew, and writes nothing for a room that does not know its crew", async () => {
    await record(CREW, dice("ann"));
    await record(OTHER, dice("dan", ["dan"]));
    expect(scoreStatements(db, null, dice("ann"))).toEqual([]);
    expect((await board()).dice.map((r) => r.name)).toEqual(["Ann", "Bob"]);
    expect((await board("dan")).dice.map((r) => r.name)).toEqual(["Dan"]);
  });

  it("orders by wins, then gold won, and marks who has left the crew", async () => {
    await record(CREW, dice("cat", ["cat", "bob"], 20));
    await record(CREW, dice("ann", ["ann", "bob"], 5));
    await record(CREW, dice("bob", ["ann", "bob"], 5));
    await record(CREW, dice("bob", ["ann", "bob"], 5));
    sql.prepare("DELETE FROM crew_members WHERE player_id = 'cat'").run();
    const rows = (await board()).dice;
    expect(rows.map((r) => [r.name, r.wins, r.goldWon, r.member])).toEqual([
      ["Bob", 2, 18, true],
      ["Cat", 1, 36, false],
      ["Ann", 1, 9, true],
    ]);
  });

  it("is only for crews", async () => {
    addPlayer("eve", "Eve", null);
    expect(await pubLeaderboard(db, "eve")).toBe("The pub is for crews. Join one first.");
  });
});

// ---------- through the table itself ----------

/** A table game that ends the moment anyone asks: just enough to drive StakeTable from open to paid. */
interface Toy {
  ante: number;
  phase: "open" | "playing" | "done";
  seats: { id: string; name: string; total?: number }[];
  winner: string | null;
  pot: number;
}
type ToyRequest = { type: string; ante?: number };

const TOY = {
  ...(CREW_RULES as unknown as Record<string, unknown>),
  requests: new Set(["open", "sit", "start", "win"]),
  isAnte: (n: unknown) => n === 10 || n === 0,
  create: (_seed: number, ante: number, host: { id: string; name: string }): Toy => ({ ante, phase: "open", seats: [{ ...host }], winner: null, pot: 0 }),
  step(game: Toy, player: HarborPlayer, request: ToyRequest) {
    if (request.type === "sit") return { ok: true, state: { ...game, seats: [...game.seats, { id: player.id, name: player.name }] } };
    if (request.type === "start") return { ok: true, state: { ...game, phase: "playing", pot: game.ante * game.seats.length } };
    // The asker wins, with seven cargo; everyone else has three.
    return { ok: true, state: { ...game, phase: "done", winner: player.id, seats: game.seats.map((s) => ({ ...s, total: s.id === player.id ? 7 : 3 })) } };
  },
  leave: (game: Toy) => ({ ok: true, state: game }),
  view: (game: Toy) => game,
  prize: (pot: number) => pot - 2,
  isOut: () => false,
} as unknown as ConstructorParameters<typeof StakeTable<Toy, ToyRequest>>[2];

function room(players: HarborPlayer[]) {
  const store = new Map<string, unknown>();
  const sockets = players.map((p) => ({ tag: p.id, sent: [] as unknown[], deserializeAttachment: () => p, serializeAttachment() {}, send(m: string) { this.sent.push(JSON.parse(m)); } }));
  const ctx = {
    storage: { get: async (k: string) => store.get(k), put: async (k: string, v: unknown) => void store.set(k, v), delete: async (k: string) => void store.delete(k) },
    getWebSockets: (tag?: string) => sockets.filter((s) => !tag || s.tag === tag),
  } as unknown as DurableObjectState;
  return { ctx, sockets: sockets as unknown as WebSocket[] };
}

describe("a game paid out at the table", () => {
  const spot = CREW_RULES.spot;
  const ann: HarborPlayer = { id: "ann", name: "Ann", classId: "cleric", level: 1, pos: spot };
  const bob: HarborPlayer = { id: "bob", name: "Bob", classId: "cleric", level: 1, pos: spot };
  const gold = (id: string) => (sql.prepare("SELECT gold FROM characters WHERE player_id = ?").get(id) as { gold: number }).gold;

  async function play(crewId: string | null, ante = 10) {
    const { ctx, sockets } = room([ann, bob]);
    const table = new StakeTable<Toy, ToyRequest>(ctx, { DB: db } as Env, TOY, () => crewId);
    await table.handle(sockets[0], ann, { type: "open", ante });
    await table.handle(sockets[1], bob, { type: "sit" });
    await table.handle(sockets[0], ann, { type: "start" });
    await table.handle(sockets[1], bob, { type: "win" });
  }

  it("pays the pot, gives the XP and puts the game on the board, cargo and all", async () => {
    await play(CREW);
    expect([gold("ann"), gold("bob")]).toEqual([90, 108]);
    const xp = sql.prepare("SELECT used FROM harbor_xp WHERE player_id = 'bob'").get() as { used: number } | undefined;
    expect(xp?.used).toBeGreaterThan(0);
    const rows = (await board()).crew;
    expect(rows.map((r) => [r.name, r.played, r.wins, r.goldWon, r.net, r.best])).toEqual([
      ["Bob", 1, 1, 18, 8, 7],
      ["Ann", 1, 0, 0, -10, 3],
    ]);
  });

  it("puts a free game on the board, with no gold and no Harbor XP", async () => {
    await play(CREW, 0);
    expect([gold("ann"), gold("bob")]).toEqual([100, 100]);
    expect(sql.prepare("SELECT used FROM harbor_xp WHERE player_id = 'bob'").get()).toBeUndefined();
    const rows = (await board()).crew;
    expect(rows.map((r) => [r.name, r.played, r.wins, r.goldWon, r.net, r.best])).toEqual([
      ["Bob", 1, 1, 0, 0, 7],
      ["Ann", 1, 0, 0, 0, 3],
    ]);
  });

  it("still pays when the room does not know its crew yet", async () => {
    await play(null);
    expect(gold("bob")).toBe(108);
    expect((sql.prepare("SELECT COUNT(*) AS n FROM pub_scores").get() as { n: number }).n).toBe(0);
  });
});
