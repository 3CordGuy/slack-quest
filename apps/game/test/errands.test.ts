// The pub's regulars against a real SQLite database with the game's
// migrations applied, as in trade.test.ts: D1 is stood in for by Node's
// built-in SQLite, and a batch is one transaction.

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ERRANDS_PER_DAY, HARBOR_XP_DAILY_CAP, RESOURCE_KINDS, TRADES_PER_DAY, errandFor, regularsOn, type Errand, type QuestGoal, type Resources } from "@gantt-quest/world";
import { dropErrand, handInErrand, regularsView, takeErrand, tradeWithRegular, type ErrandPaid, type RegularsView } from "../src/server/errands";

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
let sql: DatabaseSync;
let db: D1Database;

const one = <T = Row>(text: string, ...args: (string | number)[]) => sql.prepare(text).get(...args) as T;
const gold = (id = "ann") => one<{ gold: number }>("SELECT gold FROM characters WHERE player_id = ?", id).gold;
const xp = (id = "ann") => one<{ xp: number; level: number }>("SELECT xp, level FROM characters WHERE player_id = ?", id);
const qty = (kind: string, id = "ann") => one<{ qty: number } | undefined>("SELECT qty FROM resources WHERE player_id = ? AND kind = ?", id, kind)?.qty ?? 0;
const give = (r: Resources, id = "ann") => {
  for (const k of RESOURCE_KINDS) if (r[k]) sql.prepare("INSERT INTO resources (player_id, kind, qty) VALUES (?, ?, ?) ON CONFLICT(player_id, kind) DO UPDATE SET qty = qty + excluded.qty").run(id, k, r[k]!);
};
const snapshot = () => ({
  gold: sql.prepare("SELECT player_id, gold, xp FROM characters ORDER BY player_id").all(),
  resources: sql.prepare("SELECT * FROM resources WHERE qty > 0 ORDER BY player_id, kind").all(),
  harborXp: sql.prepare("SELECT * FROM harbor_xp ORDER BY player_id").all(),
});
const paid = (r: string | ErrandPaid): ErrandPaid => {
  if (typeof r === "string") throw new Error(r);
  return r;
};
const view = async () => {
  const v = await regularsView(db, "ann");
  if (typeof v === "string") throw new Error(v);
  return v;
};

/** Noon UTC on the first day from 2026-11-01 on which `pick` finds a regular and their offer. */
function dayWhere(pick: (e: Errand) => boolean, skip = 0): { at: number; errand: Errand } {
  let found = 0;
  for (let i = 0; i < 400; i++) {
    const at = Date.UTC(2026, 10, 1, 12) + i * 86_400_000;
    const day = new Date(at).toISOString().slice(0, 10);
    const errand = regularsOn(CREW, day).map((r) => errandFor(CREW, day, r)).find(pick);
    if (errand && found++ === skip) return { at, errand };
  }
  throw new Error("no such day");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  ({ sql, db } = openDb());
  const at = Date.UTC(2026, 9, 1);
  for (const [id, name, crew] of [["ann", "Ann", CREW], ["bo", "Bo", CREW], ["cy", "Cy", null]] as const) {
    sql.prepare("INSERT INTO players (id, name, created_at) VALUES (?, ?, ?)").run(id, name, at);
    sql.prepare("INSERT INTO characters (player_id, name, class_id, status, str, int_stat, vit, agi, dex, gold, created_at) VALUES (?, ?, 'cleric', 'active', 5, 5, 5, 5, 5, 100, ?)").run(id, name, at);
    if (crew) {
      sql.prepare("INSERT OR IGNORE INTO crews (id, name, created_by, created_at) VALUES (?, ?, ?, ?)").run(crew, crew, id, at);
      sql.prepare("INSERT INTO crew_members (crew_id, player_id, joined_at) VALUES (?, ?, ?)").run(crew, id, at);
    }
  }
});
afterEach(() => vi.useRealTimers());

describe("who is in", () => {
  it("shows today's three regulars and their offers, the same as the rules derive", async () => {
    const { at } = dayWhere(() => true);
    vi.setSystemTime(at);
    const v = await view();
    const day = new Date(at).toISOString().slice(0, 10);
    expect(v.day).toBe(day);
    expect(v.regulars.map((r) => r.regular)).toEqual(regularsOn(CREW, day).map((r) => r.id));
    expect(v.regulars.map((r) => r.spot)).toEqual([0, 1, 2]);
    expect(v.regulars.map((r) => r.offer)).toEqual(regularsOn(CREW, day).map((r) => errandFor(CREW, day, r)));
    expect(v).toMatchObject({ handedIn: 0, cap: ERRANDS_PER_DAY, away: [] });
  });

  it("is for crews only", async () => {
    expect(await regularsView(db, "cy")).toMatch(/crew/);
    expect(await takeErrand(db, "cy", "gretta")).toMatch(/crew/);
  });

  it("refuses a regular who is not in today", async () => {
    const { at } = dayWhere(() => true);
    vi.setSystemTime(at);
    const day = new Date(at).toISOString().slice(0, 10);
    const out = ["gretta", "pike", "wen", "moss", "dacey"].find((id) => !regularsOn(CREW, day).some((r) => r.id === id))!;
    expect(await takeErrand(db, "ann", out)).toMatch(/not in/);
    expect(await tradeWithRegular(db, "ann", out)).toMatch(/not in/);
    expect(await handInErrand(db, "ann", out)).toMatch(/not in/);
    expect(await takeErrand(db, "ann", "nobody")).toMatch(/not in/);
  });
});

describe("a fetch", () => {
  it("is taken, shows progress, and is handed in for gold, materials and XP", async () => {
    const { at, errand } = dayWhere((e) => e.kind === "fetch");
    if (errand.kind !== "fetch") throw new Error();
    vi.setSystemTime(at);
    expect(await takeErrand(db, "ann", errand.regular)).toEqual({ errand });
    expect(await takeErrand(db, "ann", errand.regular)).toMatch(/already on it/);

    // Short of it: refused, and nothing moves.
    const [k] = RESOURCE_KINDS.filter((x) => errand.need[x]);
    give({ ...errand.need, [k]: errand.need[k]! - 1 });
    let held = (await view()).regulars.find((r) => r.regular === errand.regular)!.held!;
    expect(held).toMatchObject({ ready: false });
    expect(held.have[k]).toBe(errand.need[k]! - 1);
    expect(held.problem).toMatch(/You need 1 more/);
    const before = snapshot();
    expect(await handInErrand(db, "ann", errand.regular)).toMatch(/You need 1 more/);
    expect(snapshot()).toEqual(before);

    // With all of it: the materials go, the reward comes.
    give({ [k]: 1 });
    held = (await view()).regulars.find((r) => r.regular === errand.regular)!.held!;
    expect(held).toMatchObject({ ready: true, problem: null });
    const res = paid(await handInErrand(db, "ann", errand.regular));
    expect(res.reward).toEqual(errand.reward);
    expect(res.xp).toMatchObject({ granted: errand.reward.xp });
    for (const x of RESOURCE_KINDS) if (errand.need[x]) expect(qty(x)).toBe(errand.reward.resources?.[x] ?? 0);
    for (const x of RESOURCE_KINDS) if (errand.reward.resources?.[x] && !errand.need[x]) expect(qty(x)).toBe(errand.reward.resources[x]);
    expect(gold()).toBe(100 + errand.reward.gold);
    expect(xp()).toEqual({ xp: res.xp!.xp, level: res.xp!.level });
    expect(one<{ used: number }>("SELECT used FROM harbor_xp WHERE player_id = 'ann'").used).toBe(errand.reward.xp);

    // Done for today: no second payout, and the offer is closed.
    const after = snapshot();
    expect(await handInErrand(db, "ann", errand.regular)).toMatch(/no job/);
    expect(await takeErrand(db, "ann", errand.regular)).toMatch(/tomorrow/);
    expect(snapshot()).toEqual(after);
    const v = await view();
    expect(v.handedIn).toBe(1);
    expect(v.regulars.find((r) => r.regular === errand.regular)).toMatchObject({ held: null, doneToday: true });
  });

  it("pays once when two hand-ins arrive together", async () => {
    const { at, errand } = dayWhere((e) => e.kind === "fetch");
    if (errand.kind !== "fetch") throw new Error();
    vi.setSystemTime(at);
    await takeErrand(db, "ann", errand.regular);
    // Enough for two hand-ins, so only the claim can stop the second.
    give(errand.need);
    give(errand.need);
    const results = await Promise.all([handInErrand(db, "ann", errand.regular), handInErrand(db, "ann", errand.regular)]);
    expect(results.filter((r) => typeof r !== "string")).toHaveLength(1);
    expect(gold()).toBe(100 + errand.reward.gold);
    for (const x of RESOURCE_KINDS) if (errand.need[x]) expect(qty(x)).toBe(errand.need[x]! + (errand.reward.resources?.[x] ?? 0));
    expect(one<{ used: number }>("SELECT used FROM harbor_xp WHERE player_id = 'ann'").used).toBe(errand.reward.xp);
  });

  it("can be given up, and taken again", async () => {
    const { at, errand } = dayWhere((e) => e.kind === "fetch");
    vi.setSystemTime(at);
    await takeErrand(db, "ann", errand.regular);
    expect(await dropErrand(db, "ann", errand.regular)).toBeNull();
    expect(await dropErrand(db, "ann", errand.regular)).toMatch(/no job/);
    expect(await takeErrand(db, "ann", errand.regular)).toEqual({ errand });
  });
});

describe("the daily cap", () => {
  /** Mark `n` jobs handed in today with regulars who are not the one asked. */
  const handedIn = (n: number, at: number) => {
    for (let i = 0; i < n; i++) {
      sql
        .prepare("INSERT INTO errands (player_id, regular, day, kind, errand_json, accepted_at, done_at) VALUES ('ann', ?, ?, 'fetch', '{}', ?, ?)")
        .run(`old${i}`, `2026-01-0${i + 1}`, at - 1000, at - 1000);
    }
  };

  it("stops hand-ins past the day's cap, paying nothing", async () => {
    const { at, errand } = dayWhere((e) => e.kind === "fetch");
    if (errand.kind !== "fetch") throw new Error();
    vi.setSystemTime(at);
    await takeErrand(db, "ann", errand.regular);
    give(errand.need);
    handedIn(ERRANDS_PER_DAY, at);
    const before = snapshot();
    expect(await handInErrand(db, "ann", errand.regular)).toMatch(/Come back tomorrow/);
    expect(snapshot()).toEqual(before);
    // Tomorrow it goes through.
    vi.setSystemTime(at + 86_400_000);
    const tomorrow = new Date(at + 86_400_000).toISOString().slice(0, 10);
    if (regularsOn(CREW, tomorrow).some((r) => r.id === errand.regular)) expect(typeof (await handInErrand(db, "ann", errand.regular))).toBe("object");
  });

  it("holds when two hand-ins race for the last place", async () => {
    // A day with two fetches, so two different jobs can be handed in at once.
    const { at } = dayWhere((e) => e.kind === "fetch" && regularsOn(CREW, e.day).filter((r) => errandFor(CREW, e.day, r).kind === "fetch").length >= 2);
    vi.setSystemTime(at);
    const day = new Date(at).toISOString().slice(0, 10);
    const fetches = regularsOn(CREW, day).map((r) => errandFor(CREW, day, r)).filter((e) => e.kind === "fetch");
    for (const e of fetches.slice(0, 2)) {
      await takeErrand(db, "ann", e.regular);
      if (e.kind === "fetch") give(e.need);
    }
    handedIn(ERRANDS_PER_DAY - 1, at);
    const results = await Promise.all(fetches.slice(0, 2).map((e) => handInErrand(db, "ann", e.regular)));
    expect(results.filter((r) => typeof r !== "string")).toHaveLength(1);
    expect(results.find((r) => typeof r === "string")).toMatch(/tomorrow/);
    expect((await view()).handedIn).toBe(ERRANDS_PER_DAY);
  });

  it("still pays gold once the day's Harbor XP is used up, just no XP", async () => {
    const { at, errand } = dayWhere((e) => e.kind === "fetch");
    if (errand.kind !== "fetch") throw new Error();
    vi.setSystemTime(at);
    sql.prepare("INSERT INTO harbor_xp (player_id, day, used, spars) VALUES ('ann', ?, ?, 0)").run(new Date(at).toISOString().slice(0, 10), HARBOR_XP_DAILY_CAP);
    await takeErrand(db, "ann", errand.regular);
    give(errand.need);
    const xpBefore = xp();
    const res = paid(await handInErrand(db, "ann", errand.regular));
    expect(res.xp).toMatchObject({ granted: 0 });
    expect(xp()).toEqual(xpBefore);
    expect(gold()).toBe(100 + errand.reward.gold);
  });
});

describe("a trade", () => {
  it("swaps the materials, a few times a day, and only with them in hand", async () => {
    const { at, errand } = dayWhere((e) => e.kind === "trade");
    if (errand.kind !== "trade") throw new Error();
    vi.setSystemTime(at);
    const [take] = RESOURCE_KINDS.filter((k) => errand.give[k]);
    const [back] = RESOURCE_KINDS.filter((k) => errand.get[k]);
    expect(await tradeWithRegular(db, "ann", errand.regular)).toMatch(/You need/);
    expect(await takeErrand(db, "ann", errand.regular)).toMatch(/trade/);

    give({ [take]: errand.give[take]! * (TRADES_PER_DAY + 1) });
    for (let i = 1; i <= TRADES_PER_DAY; i++) {
      const res = paid(await tradeWithRegular(db, "ann", errand.regular));
      expect(res.reward.resources).toEqual(errand.get);
      expect(qty(take)).toBe(errand.give[take]! * (TRADES_PER_DAY + 1 - i));
      expect(qty(back)).toBe(errand.get[back]! * i);
      expect((await view()).regulars.find((r) => r.regular === errand.regular)!.traded).toBe(i);
    }
    const before = snapshot();
    expect(await tradeWithRegular(db, "ann", errand.regular)).toMatch(/tomorrow/);
    expect(snapshot()).toEqual(before);
    // Trades are not jobs: they leave the day's cap alone.
    expect((await view()).handedIn).toBe(0);
  });

  it("does not go over the limit when trades arrive together", async () => {
    const { at, errand } = dayWhere((e) => e.kind === "trade");
    if (errand.kind !== "trade") throw new Error();
    vi.setSystemTime(at);
    const [take] = RESOURCE_KINDS.filter((k) => errand.give[k]);
    give({ [take]: 100 });
    const results = await Promise.all(Array.from({ length: TRADES_PER_DAY + 2 }, () => tradeWithRegular(db, "ann", errand.regular)));
    expect(results.filter((r) => typeof r !== "string")).toHaveLength(TRADES_PER_DAY);
    expect(qty(take)).toBe(100 - errand.give[take]! * TRADES_PER_DAY);
  });
});

describe("a quest", () => {
  /** Record the deed a quest asks for, at `at`, the way the game does. */
  function doDeed(goal: QuestGoal, at: number) {
    if (goal === "rest") sql.prepare("INSERT INTO gathering (player_id, day, used, rested_at) VALUES ('ann', '2026-01-01', 0, ?) ON CONFLICT(player_id) DO UPDATE SET rested_at = excluded.rested_at").run(at);
    if (goal === "give") {
      sql.prepare("INSERT INTO crew_project_gifts (crew_id, project_id, player_id, kind, qty, left_after, created_at) VALUES (?, 'smithy', 'ann', 'wood', 1, 0, ?)").run(CREW, at);
    }
    if (goal === "voyage" || goal === "contract") {
      sql.prepare("INSERT INTO runs (code, seed, status, created_by, created_at, updated_at) VALUES ('RUN1', 's', ?, 'ann', ?, ?)").run(goal === "voyage" ? "victory" : "defeat", at - 5000, at);
      if (goal === "voyage") sql.prepare("INSERT INTO run_players (code, player_id, xp_earned, gold_earned) VALUES ('RUN1', 'ann', 10, 10)").run();
      else sql.prepare("INSERT INTO run_contracts (code, player_id, contract_id, done, rewarded) VALUES ('RUN1', 'ann', 'swift', 1, 1)").run();
    }
  }

  for (const goal of ["rest", "give", "voyage", "contract"] as QuestGoal[]) {
    it(`${goal}: counts only what is done after it is taken`, async () => {
      const { at, errand } = dayWhere((e) => e.kind === "quest" && e.goal === goal);
      if (errand.kind !== "quest") throw new Error();
      vi.setSystemTime(at);
      // Done before the job was taken: it does not count.
      doDeed(goal, at - 60_000);
      await takeErrand(db, "ann", errand.regular);
      expect(await handInErrand(db, "ann", errand.regular)).toMatch(/Not done yet/);
      expect((await view()).regulars.find((r) => r.regular === errand.regular)!.held).toMatchObject({ ready: false });

      vi.setSystemTime(at + 60_000);
      sql.exec("DELETE FROM run_players; DELETE FROM run_contracts; DELETE FROM runs; DELETE FROM crew_project_gifts;");
      doDeed(goal, at + 30_000);
      expect((await view()).regulars.find((r) => r.regular === errand.regular)!.held).toMatchObject({ ready: true, problem: null });
      const res = paid(await handInErrand(db, "ann", errand.regular));
      expect(gold()).toBe(100 + errand.reward.gold);
      expect(res.xp?.granted).toBe(errand.reward.xp);
      for (const k of RESOURCE_KINDS) expect(qty(k)).toBe(errand.reward.resources?.[k] ?? 0);
    });
  }

  it("is still held on a later day, and blocks a new job from the same regular until handed in", async () => {
    const { at, errand } = dayWhere((e) => e.kind === "quest" && e.goal === "voyage");
    vi.setSystemTime(at);
    await takeErrand(db, "ann", errand.regular);
    // The next day this regular is in with a job to take.
    let later = at;
    let v: RegularsView;
    for (;;) {
      later += 86_400_000;
      vi.setSystemTime(later);
      v = await view();
      const here = v.regulars.find((r) => r.regular === errand.regular);
      if (!here) {
        expect(v.away.map((a) => a.errand.id)).toEqual([errand.id]);
        continue;
      }
      if (here.offer.kind !== "trade") break;
    }
    const here = v.regulars.find((r) => r.regular === errand.regular)!;
    expect(here.held?.errand).toEqual(errand);
    expect(here.problem).toMatch(/Finish the job/);
    expect(await takeErrand(db, "ann", errand.regular)).toMatch(/Finish the job/);
    doDeed("voyage", later);
    vi.setSystemTime(later + 1);
    expect(typeof (await handInErrand(db, "ann", errand.regular))).toBe("object");
    expect(typeof (await takeErrand(db, "ann", errand.regular))).toBe("object");
  });
});
