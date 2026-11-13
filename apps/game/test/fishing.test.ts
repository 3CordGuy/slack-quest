// Fishing sittings on the server, against a real SQLite database with the
// game's migrations applied (the same stand-in for D1 as trade.test.ts):
// stamina spent when a sitting ends rather than when it starts, the fish
// kept, the Catch Book, crew records, and the idle close.

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOK_TITLE, FISH, PAGE_REWARD, SITTING_IDLE_MS, gatherDay, type GatherChoice, type GatherView } from "@gantt-quest/world";
import { catchBook, hangAtHome, mountInPub, unmountInPub } from "../src/server/catchbook";
import { getHut, type Env } from "../src/server/db";
import { playFight } from "../../../packages/world/src/fishbot";
import { gatherStatus, startOuting, stepOuting } from "../src/server/gather";
import { fishStock, gildedRod, moveFish, sellFish } from "../src/server/fishmarket";

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

/** Fish until a living catch (not a haul, and not one that fills the creel) is landed, then keep it. */
async function keepAFish(): Promise<string> {
  for (let i = 0; i < 60; i++) {
    at(clock + 1000);
    const view = await catchOne();
    const pending = view.sitting!.pending;
    if (!pending) continue;
    // Hauls are not fish; and one big enough to fill the creel would end the sitting before the test wants it to.
    if (FISH[pending.species].kind === "haul" || pending.grams > 20_000) {
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

describe("selling and keeping fish", () => {
  const put = (id: string, species: string, grams: number, specimen = 0, place = "icebox", who = "ann") =>
    sql.prepare("INSERT INTO fish (id, player_id, species, grams, mm, specimen, spot, caught_at, place) VALUES (?, ?, ?, ?, 300, ?, 'west', ?, ?)").run(id, who, species, grams, specimen, T0, place);
  const gold = () => one<{ gold: number }>("SELECT gold FROM characters WHERE player_id = 'ann'").gold;
  const place = (id: string) => one<{ place: string }>("SELECT place FROM fish WHERE id = ?", id).place;

  it("lists the icebox and the chest with what each buyer would pay", async () => {
    put("h1", "herring", 400);
    put("s1", "silver_king", 30_000, 1, "trophy");
    const stock = await fishStock(db, "ann");
    expect(stock.icebox.map((f) => f.id)).toEqual(["h1"]);
    expect(stock.trophy.map((f) => f.id)).toEqual(["s1"]);
    expect(stock.icebox[0].tam).toBeGreaterThan(0);
    expect(stock.trophy[0].tam).toBeNull();
    expect(stock.trophy[0].market).toBeGreaterThan(0);
    expect(stock.iceboxG).toBe(400);
  });

  it("sells to Old Tam what he cooks, and pays once however often it is asked", async () => {
    put("h1", "herring", 400);
    put("s1", "silver_king", 30_000, 1);
    const before = gold();
    expect(await sellFish(db, "ann", ["s1"], "tam")).toMatch(/Old Tam will not take/);
    const r = await sellFish(db, "ann", ["h1"], "tam");
    if (typeof r === "string") throw new Error(r);
    expect(r.sold).toHaveLength(1);
    expect(gold()).toBe(before + r.sold[0].gold);
    expect(place("h1")).toBe("sold");
    expect(await sellFish(db, "ann", ["h1"], "tam")).toMatch(/not yours/);
    expect(gold()).toBe(before + r.sold[0].gold);
  });

  it("sells to the fishmonger at the board's price, and will not sell someone else's fish", async () => {
    put("s1", "silver_king", 30_000, 1);
    put("b1", "herring", 300, 0, "icebox", "bo");
    const r = await sellFish(db, "ann", ["s1"], "market");
    if (typeof r === "string") throw new Error(r);
    expect(r.sold[0].gold).toBeGreaterThan(0);
    expect(await sellFish(db, "ann", ["b1"], "market")).toMatch(/not yours/);
  });

  it("keeps only specimens in the trophy chest, up to its size", async () => {
    put("h1", "herring", 400);
    expect(await moveFish(db, "ann", "h1", "trophy")).toMatch(/specimen/);
    for (let i = 0; i < 6; i++) put(`t${i}`, "bluefin", 20_000, 1, "trophy");
    put("s1", "silver_king", 30_000, 1);
    expect(await moveFish(db, "ann", "s1", "trophy")).toMatch(/holds 6/);
    const back = await moveFish(db, "ann", "t0", "icebox");
    expect(typeof back === "string" ? back : "ok").toBe("ok");
    expect(typeof (await moveFish(db, "ann", "s1", "trophy"))).not.toBe("string");
    expect(place("s1")).toBe("trophy");
  });

  it("sells what will not fit in the icebox when a sitting ends", async () => {
    // Full to the brim, so whatever is kept, however small, will not fit.
    put("full", "halibut", 60_000);
    await startOuting(db, "ann", "fishing", "middle");
    await keepAFish();
    const before = gold();
    const done = await step({ t: "bank" });
    expect(done.sitting!.sold.length).toBeGreaterThan(0);
    expect(gold()).toBeGreaterThan(before);
    const sold = done.sitting!.sold[0].id;
    expect(place(sold)).toBe("sold");
  });
});

describe("the Catch Book, records and mounts", () => {
  const caught = (species: string, who = "ann") => sql.prepare("INSERT OR IGNORE INTO fish_bests (player_id, species, grams, mm, caught, first_at) VALUES (?, ?, 100, 100, 1, 0)").run(who, species);

  it("rewards the page a sitting finishes: its wall piece, once, and the book for the last", async () => {
    await startOuting(db, "ann", "fishing", "west");
    // Land something, then have everything else on its page already in the book.
    let pending: string | undefined;
    for (let i = 0; i < 60 && !pending; i++) {
      at(clock + 1000);
      pending = (await catchOne()).sitting!.pending?.species;
    }
    const page = FISH[pending!].page;
    for (const f of Object.values(FISH)) if (f.page === page && f.id !== pending) caught(f.id);
    await step({ t: "keep" });
    const done = await step({ t: "bank" });
    expect(done.sitting!.book.pages).toEqual([page]);
    expect(one("SELECT page FROM book_rewards WHERE player_id = 'ann'")).toMatchObject({ page });
    expect((sql.prepare("SELECT def_id FROM furnishings WHERE player_id = 'ann'").all() as { def_id: string }[]).map((r) => r.def_id)).toContain(PAGE_REWARD[page]);
    const book = await catchBook(db, "ann");
    expect(book.claimed).toContain(page);
    expect(book.title).toBeNull();
  });

  it("hangs only the crew's record fish on the pub wall, by the one who caught it", async () => {
    sql.prepare("INSERT INTO fish (id, player_id, species, grams, mm, specimen, spot, caught_at, place) VALUES ('rec', 'ann', 'bluefin', 90000, 1900, 1, 'middle', 0, 'trophy'), ('other', 'ann', 'bluefin', 20000, 1100, 1, 'middle', 0, 'trophy')").run();
    sql.prepare("INSERT INTO fish_records (crew_id, species, grams, mm, fish_id, player_id, caught_at) VALUES ('CREWAA', 'bluefin', 90000, 1900, 'rec', 'ann', 0)").run();
    expect(await mountInPub(db, "ann", "other")).toMatch(/record fish/);
    expect(await mountInPub(db, "bo", "rec")).toMatch(/not yours/);
    const wall = await mountInPub(db, "ann", "rec");
    if (typeof wall === "string") throw new Error(wall);
    expect(wall.mounts).toMatchObject([{ slot: 0, fishId: "rec", species: "bluefin", name: "Ann" }]);
    expect(one("SELECT place FROM fish WHERE id = 'rec'")).toMatchObject({ place: "pub" });
    expect(await unmountInPub(db, "bo", "rec")).toMatch(/not yours/);
    const down = await unmountInPub(db, "ann", "rec");
    if (typeof down === "string") throw new Error(down);
    expect(down.mounts).toEqual([]);
    expect(one("SELECT place FROM fish WHERE id = 'rec'")).toMatchObject({ place: "trophy" });
  });

  it("hangs a fish from the trophy chest on a Mounted Fish at home, and takes it down again", async () => {
    const env = { DB: db } as unknown as Env;
    sql.prepare("INSERT INTO fish (id, player_id, species, grams, mm, specimen, spot, caught_at, place) VALUES ('t1', 'ann', 'halibut', 60000, 1800, 1, 'east', 0, 'trophy'), ('i1', 'ann', 'herring', 300, 250, 0, 'middle', 0, 'icebox')").run();
    const mount = Number(sql.prepare("INSERT INTO furnishings (player_id, def_id, label, meta_json, created_at) VALUES ('ann', 'mounted_fish', 'Mounted Fish', '{}', 0)").run().lastInsertRowid);
    expect(await hangAtHome(env, "ann", mount, "i1")).toMatch(/trophy chest/);
    expect(await hangAtHome(env, "ann", mount, "t1")).toEqual({ ok: true });
    expect(one("SELECT place, furnishing_id FROM fish WHERE id = 't1'")).toMatchObject({ place: "hut", furnishing_id: mount });
    const hut = await getHut(db, "ann");
    expect(hut.furnishings.find((f) => f.id === mount)?.fish).toMatchObject({ id: "t1", species: "halibut", mm: 1800 });
    expect(await hangAtHome(env, "ann", mount, null)).toEqual({ ok: true });
    expect(one("SELECT place FROM fish WHERE id = 't1'")).toMatchObject({ place: "trophy" });
    expect((await getHut(db, "ann")).furnishings.find((f) => f.id === mount)?.fish).toBeNull();
  });
});

describe("fishing from a boat", () => {
  const boat = (defId: string) => sql.prepare("INSERT INTO furnishings (player_id, def_id, label, meta_json, created_at) VALUES ('ann', ?, ?, '{}', 0)").run(defId, defId);

  it("needs a boat to fish afloat, and a rowboat for the open sea", async () => {
    expect(await startOuting(db, "ann", "fishing", "coast_west")).toMatch(/need a boat/);
    boat("float_barrel");
    expect(await startOuting(db, "ann", "fishing", "sea")).toMatch(/rowboat/);
    const r = await startOuting(db, "ann", "fishing", "wreck");
    if (typeof r === "string") throw new Error(r);
    // Cast out to sea from there: the server knows it is only a barrel.
    expect(await stepOuting(db, "ann", { t: "cast", power: 0.5, spot: "sea", vessel: "rowboat" })).toMatch(/rowboat/);
  });

  it("carries more in a rowboat, and brings up the open sea's fish", async () => {
    boat("rowboat");
    const r = await startOuting(db, "ann", "fishing", "sea");
    if (typeof r === "string") throw new Error(r);
    const plain = 25_000 + 9 * 1000;
    expect(r.outing!.sitting!.creelLimitG).toBe(plain + 20_000);
    const cast = await stepOuting(db, "ann", { t: "cast", power: 0.5 });
    if (typeof cast === "string") throw new Error(cast);
    expect(cast.outing!.sitting!.spot).toBe("sea");
  });
});

describe("the gilded rod", () => {
  it("goes to whoever has filled the Catch Book", async () => {
    expect(await gildedRod(db, "ann")).toBe(false);
    sql.prepare("UPDATE characters SET title = ? WHERE player_id = 'ann'").run(BOOK_TITLE);
    expect(await gildedRod(db, "ann")).toBe(true);
    expect(await gildedRod(db, "bo")).toBe(false);
  });
});
