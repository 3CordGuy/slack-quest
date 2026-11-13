// Fishing sittings on the server, against a real SQLite database with the
// game's migrations applied (the same stand-in for D1 as trade.test.ts):
// stamina spent when a sitting ends rather than when it starts, the fish
// kept, the Catch Book, crew records, and the idle close.

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FISH, SITTING_IDLE_MS, gatherDay, type GatherChoice, type GatherView } from "@gantt-quest/world";
import { playFight } from "../../../packages/world/src/fishbot";
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
let clock: number;
const T0 = Date.UTC(2026, 10, 13, 9, 0, 0);
const at = (ms: number) => vi.setSystemTime((clock = ms));
const one = <T = Row>(text: string, ...args: (string | number)[]) => sql.prepare(text).get(...args) as T;
const used = () => one<{ used: number } | undefined>("SELECT used FROM gathering WHERE player_id = 'ann'")?.used ?? 0;

async function step(choice: GatherChoice) {
  const r = await stepOuting(db, "ann", choice);
  if (typeof r === "string") throw new Error(r);
  return r;
}

/** Cast, strike on the bite and fight it out. Returns the view after the fight. */
async function catchOne(): Promise<GatherView> {
  let view = (await step({ t: "cast", power: 0.7 })).outing!;
  const cast = view.sitting!.cast!;
  const castAt = clock;
  at(castAt + cast.biteMs + 40);
  view = (await step({ t: "hook", at: cast.biteMs + 20 })).outing!;
  expect(view.sitting!.cast!.hooked).toBe(true);
  const { end, edges } = playFight(cast.script, view.sitting!.ease);
  at(clock + end.t + 300);
  return (await step({ t: "fought", edges })).outing!;
}

/** Fish until a living catch (not a haul) is landed, then keep it. */
async function keepAFish(): Promise<string> {
  for (let i = 0; i < 60; i++) {
    at(clock + 1000);
    const view = await catchOne();
    const pending = view.sitting!.pending;
    if (!pending) continue;
    if (FISH[pending.species].kind === "haul") {
      await step({ t: "release" });
      continue;
    }
    await step({ t: "keep" });
    return pending.species;
  }
  throw new Error("No fish in sixty casts.");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(T0);
  ({ sql, db } = openDb());
  for (const [id, name] of [["ann", "Ann"], ["bo", "Bo"]] as const) {
    sql.prepare("INSERT INTO players (id, name, created_at) VALUES (?, ?, ?)").run(id, name, T0);
    sql.prepare("INSERT INTO characters (player_id, name, class_id, status, str, int_stat, vit, agi, dex, gold, created_at) VALUES (?, ?, 'qa_paladin', 'active', 9, 5, 5, 5, 9, 100, ?)").run(id, name, T0);
    sql.prepare("INSERT OR IGNORE INTO crews (id, name, created_by, created_at) VALUES ('CREWAA', 'Crew', ?, ?)").run(id, T0);
    sql.prepare("INSERT INTO crew_members (crew_id, player_id, joined_at) VALUES ('CREWAA', ?, ?)").run(id, T0);
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe("starting a sitting", () => {
  it("needs stamina but does not spend it", async () => {
    const r = await startOuting(db, "ann", "fishing", "west");
    if (typeof r === "string") throw new Error(r);
    expect(r.stamina.left).toBe(3);
    expect(used()).toBe(0);
    expect(r.outing!.sitting!.spot).toBe("west");
  });

  it("is refused when the day's stamina is spent", async () => {
    sql.prepare("INSERT INTO gathering (player_id, day, used) VALUES ('ann', ?, 3)").run(gatherDay(T0));
    expect(await startOuting(db, "ann", "fishing", "east")).toMatch(/worn out/);
  });

  it("is refused at the open sea until there are boats", async () => {
    expect(await startOuting(db, "ann", "fishing", "sea")).toMatch(/boat/);
    expect(await startOuting(db, "ann", "fishing", "pond")).toMatch(/cannot fish/);
  });

  it("leaves the old shore casts as they were, spending stamina at the start", async () => {
    const r = await startOuting(db, "ann", "fishing");
    if (typeof r === "string") throw new Error(r);
    expect(used()).toBe(1);
    expect(r.outing!.sitting).toBeNull();
    expect(r.outing!.water).not.toBeNull();
  });
});

describe("ending a sitting", () => {
  it("spends one stamina, keeps the fish, fills the Catch Book and sets a crew record", async () => {
    await startOuting(db, "ann", "fishing", "middle");
    const species = await keepAFish();
    expect(used()).toBe(0);
    const done = await step({ t: "bank" });
    expect(done.outing!.status).toBe("banked");
    expect(used()).toBe(1);
    expect(one("SELECT session_json FROM gathering WHERE player_id = 'ann'")).toMatchObject({ session_json: null });

    const fish = sql.prepare("SELECT species, grams, place FROM fish WHERE player_id = 'ann'").all() as { species: string; grams: number; place: string }[];
    expect(fish.map((f) => f.species)).toContain(species);
    expect(fish.every((f) => f.place === "icebox")).toBe(true);
    expect(done.sitting!.fish.map((f) => f.species)).toContain(species);

    const best = one<{ caught: number; grams: number; fish_id: string }>("SELECT caught, grams, fish_id FROM fish_bests WHERE player_id = 'ann' AND species = ?", species);
    expect(best.caught).toBeGreaterThanOrEqual(1);
    expect(best.fish_id).toBeTruthy();
    expect(done.sitting!.newSpecies).toContain(species);

    const record = one<{ player_id: string; grams: number }>("SELECT player_id, grams FROM fish_records WHERE crew_id = 'CREWAA' AND species = ?", species);
    expect(record.player_id).toBe("ann");
    expect(done.sitting!.records).toContain(species);
    // Harbor XP for the sitting, and a bonus for the new species and the record.
    expect(done.xp!.granted).toBeGreaterThan(4);
  });

  it("cannot be closed, or charged, twice", async () => {
    await startOuting(db, "ann", "fishing", "west");
    await step({ t: "bank" });
    expect(used()).toBe(1);
    expect(await stepOuting(db, "ann", { t: "bank" })).toMatch(/not out gathering/);
    expect(used()).toBe(1);
  });

  it("ends by itself when left alone, the next time anyone looks", async () => {
    await startOuting(db, "ann", "fishing", "east");
    await keepAFish();
    at(clock + SITTING_IDLE_MS + 1000);
    const r = await gatherStatus(db, "ann");
    if (typeof r === "string") throw new Error(r);
    expect(r.outing!.status).toBe("banked");
    expect(r.sitting!.fish.length).toBeGreaterThan(0);
    expect(used()).toBe(1);
    // Looking again changes nothing.
    await gatherStatus(db, "ann");
    expect(used()).toBe(1);
    expect((sql.prepare("SELECT COUNT(*) AS n FROM fish WHERE player_id = 'ann'").get() as { n: number }).n).toBe(r.sitting!.fish.length);
  });

  it("closes an idle sitting before starting another outing", async () => {
    await startOuting(db, "ann", "fishing", "west");
    at(clock + SITTING_IDLE_MS + 1000);
    const r = await startOuting(db, "ann", "quarry");
    expect(typeof r).not.toBe("string");
    expect(used()).toBe(2);
  });

  it("leaves a crew record standing against a lighter fish", async () => {
    // Bo holds every record, at a weight nothing reaches.
    const insert = sql.prepare("INSERT INTO fish_records (crew_id, species, grams, mm, fish_id, player_id, caught_at) VALUES ('CREWAA', ?, 1000000000, 1, NULL, 'bo', 0)");
    for (const id of Object.keys(FISH)) insert.run(id);
    await startOuting(db, "ann", "fishing", "west");
    const species = await keepAFish();
    const done = await step({ t: "bank" });
    expect(done.sitting!.records).toEqual([]);
    expect(one<{ player_id: string }>("SELECT player_id FROM fish_records WHERE crew_id = 'CREWAA' AND species = ?", species).player_id).toBe("bo");
  });

  it("records what got away", async () => {
    await startOuting(db, "ann", "fishing", "east");
    at(clock + 1000);
    const cast = (await step({ t: "cast", power: 1 })).outing!.sitting!.cast!;
    at(clock + cast.biteMs + 40);
    await step({ t: "hook", at: cast.biteMs + 20 });
    // Cut the line.
    const cut = await step({ t: "reel" });
    const species = cut.outing!.sitting!.lost[0];
    await step({ t: "bank" });
    expect(one("SELECT caught, lost FROM fish_bests WHERE player_id = 'ann' AND species = ?", species)).toMatchObject({ caught: 0, lost: 1 });
  });
});
