// The bag shows what the hero was last read as holding, so every answer that pays an outing has to be one the
// client knows to read the hero again for (client/gatherPaid.ts). Here that rule is held against the server's own
// answers (startOuting, stepOuting and gatherStatus, on a real SQLite database with the game's migrations): an
// answer says "paid" exactly when the pack in the database has just changed, at the quarry, at the tree line and
// for a fishing sitting left alone.

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MINE_RECOVER_MS, SITTING_IDLE_MS, type GatherChoice, type Resources } from "@gantt-quest/world";
import { outingPaid } from "../src/client/gatherPaid";
import { gatherStatus, startOuting, stepOuting } from "../src/server/gather";

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
let clock: number;
const T0 = Date.UTC(2026, 10, 18, 9, 0, 0);
const at = (ms: number) => vi.setSystemTime((clock = ms));

/** What the database says is in the pack: what `/api/me` would hand the bag. */
function pack(): Resources {
  const rows = sql.prepare("SELECT kind, qty FROM resources WHERE player_id = 'ann' AND qty > 0").all() as { kind: keyof Resources; qty: number }[];
  return Object.fromEntries(rows.map((r) => [r.kind, r.qty]));
}

async function step(choice: GatherChoice) {
  const r = await stepOuting(db, "ann", choice);
  if (typeof r === "string") throw new Error(r);
  return r;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(T0);
  sql = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) sql.exec(readFileSync(new URL(file, dir), "utf8"));
  db = { prepare: (text: string) => new Stmt(sql, text), batch: async (stmts: Stmt[]) => stmts.map((s) => s.exec()) } as unknown as D1Database;
  sql.prepare("INSERT INTO players (id, name, created_at) VALUES ('ann', 'Ann', ?)").run(T0);
  sql.prepare("INSERT INTO characters (player_id, name, class_id, status, str, int_stat, vit, agi, dex, gold, created_at) VALUES ('ann', 'Ann', 'qa_paladin', 'active', 9, 5, 9, 5, 9, 100, ?)").run(T0);
  sql.prepare("INSERT INTO crews (id, name, created_by, created_at) VALUES ('CREWAA', 'Crew', 'ann', ?)").run(T0);
  sql.prepare("INSERT INTO crew_members (crew_id, player_id, joined_at) VALUES ('CREWAA', 'ann', ?)").run(T0);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("an answer that pays an outing is one the bag is read again for", () => {
  it("the quarry: nothing while the face is being worked, then the haul, stone and all, in the pack", async () => {
    // The same face every time: the seed is the one thing the server draws for itself.
    vi.spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(into: T): T => {
      if (into instanceof Uint32Array) into.fill(20261118);
      return into;
    });
    const started = await startOuting(db, "ann", "quarry");
    if (typeof started === "string") throw new Error(started);
    expect(outingPaid(started)).toBe(false);
    expect(outingPaid(await step({ t: "dig" }))).toBe(false);

    // Tap along the top row, where nothing can fall, until some stone has come out.
    let view = (await gatherStatus(db, "ann") as Exclude<Awaited<ReturnType<typeof gatherStatus>>, string>).outing!;
    for (let swing = 1; swing <= 36 && !view.haul.stone; swing++) {
      const rock = view.mine!.rocks.filter((r) => !r.broken).sort((a, b) => a.cell - b.cell)[0];
      at(T0 + swing * (MINE_RECOVER_MS + 60));
      const r = await step({ t: "blows", blows: [{ cell: rock.cell, power: 1, at: swing * (MINE_RECOVER_MS + 60) - 20 }] });
      expect(outingPaid(r)).toBe(false);
      view = r.outing!;
    }
    expect(view.haul.stone).toBe(1);
    expect(pack()).toEqual({});

    const hauled = await step({ t: "bank" });
    expect(outingPaid(hauled)).toBe(true);
    // What the card says came out is what the pack now holds, and the whole haul is in it.
    expect(hauled.paid).toEqual(view.haul);
    expect(hauled.outing!.payout).toEqual(hauled.paid);
    expect(pack()).toEqual(hauled.paid);

    // Looking again afterwards is not a second payment.
    const after = await gatherStatus(db, "ann");
    if (typeof after === "string") throw new Error(after);
    expect(outingPaid(after)).toBe(false);
    expect(pack()).toEqual(hauled.paid);
  });

  it("the tree line: the round's end pays the wood", async () => {
    await startOuting(db, "ann", "felling");
    expect(outingPaid(await step({ t: "begin" }))).toBe(false);
    at(T0 + 31_000);
    const done = await step({ t: "chopped", chops: [] });
    expect(outingPaid(done)).toBe(true);
    expect(done.paid!.wood).toBeGreaterThan(0);
    expect(pack()).toEqual(done.paid);
  });

  it("a fishing sitting left alone: the look that finds it closed says it was paid", async () => {
    const started = await startOuting(db, "ann", "fishing", "west");
    if (typeof started === "string") throw new Error(started);
    expect(outingPaid(started)).toBe(false);
    at(clock + SITTING_IDLE_MS + 1000);
    const found = await gatherStatus(db, "ann");
    if (typeof found === "string") throw new Error(found);
    expect(found.outing!.status).toBe("banked");
    expect(outingPaid(found)).toBe(true);
    const again = await gatherStatus(db, "ann");
    if (typeof again === "string") throw new Error(again);
    expect(outingPaid(again)).toBe(false);
  });
});
