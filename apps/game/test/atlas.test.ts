// A crew's chart in D1 (src/server/atlas.ts), against a real SQLite database
// with the game's migrations applied (the same stand-in for D1 as
// storage.test.ts).

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { ATLAS_HOME, atlasNodeById, type ZoneOptions } from "@gantt-quest/world";
import { addStone, atlasSeed, chartFor, clearNode, devClearNode, devGrantStone, devResetChart, enterProblem, openNode, setStone, stonesOf } from "../src/server/atlas";
import { CAVE_IDLE_MS, getZoneRow } from "../src/server/zones";

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
const CREW = "CREWAA";
const OTHER = "CREWBB";

beforeEach(() => {
  sql = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) sql.exec(readFileSync(new URL(file, dir), "utf8"));
  db = { prepare: (text: string) => new Stmt(sql, text), batch: async (stmts: Stmt[]) => stmts.map((s) => s.exec()) } as unknown as D1Database;
  const at = Date.now();
  for (const [id, name, crew] of [["ann", "Ann", CREW], ["bo", "Bo", CREW], ["cy", "Cy", OTHER]]) {
    sql.prepare("INSERT INTO players (id, name, created_at) VALUES (?, ?, ?)").run(id, name, at);
    sql.prepare("INSERT INTO characters (player_id, name, class_id, status, str, int_stat, vit, agi, dex, gold, created_at) VALUES (?, ?, 'qa_paladin', 'active', 5, 5, 5, 5, 5, 100, ?)").run(id, name, at);
    sql.prepare("INSERT OR IGNORE INTO crews (id, name, created_by, created_at) VALUES (?, 'Crew', ?, ?)").run(crew, id, at);
    sql.prepare("INSERT INTO crew_members (crew_id, player_id, joined_at) VALUES (?, ?, ?)").run(crew, id, at);
  }
});

const home = (crew = CREW) => atlasNodeById(atlasSeed(crew), ATLAS_HOME)!;
const first = (crew = CREW) => home(crew).links[0];
/** A node a ring out that a route runs to from `from`. */
const beyond = (from: string, crew = CREW) => atlasNodeById(atlasSeed(crew), from)!.links.find((id) => atlasNodeById(atlasSeed(crew), id)!.ring === 2)!;
const states = async (crew = CREW) => new Map((await chartFor(db, crew)).nodes.map((n) => [n.id, n.state]));
const went = async (node: unknown, crew = CREW, by = "ann", party = 2) => {
  const res = await openNode(db, crew, by, node, party);
  if ("error" in res) throw new Error(res.error);
  return res;
};

describe("a crew's chart", () => {
  it("starts with the Harbor and the six landfalls round it open, and is another sea for another crew", async () => {
    const chart = await chartFor(db, CREW);
    expect(chart.nodes.filter((n) => n.state === "harbor").map((n) => n.id)).toEqual([ATLAS_HOME]);
    expect(chart.nodes.filter((n) => n.state === "open")).toHaveLength(6);
    expect(chart.nodes.filter((n) => n.state === "cleared")).toEqual([]);
    const names = (crew: string) => home(crew).links.map((id) => atlasNodeById(atlasSeed(crew), id)!.name);
    expect(names(CREW)).not.toEqual(names(OTHER));
  });

  it("makes a map for a landfall the first time it is sailed to, and the same one for whoever follows", async () => {
    const node = first();
    const a = await went(node, CREW, "ann", 2);
    expect(a.fresh).toBe(true);
    const zone = (await getZoneRow(db, a.code))!;
    expect(zone).toMatchObject({ kind: "atlas", crew_id: CREW, node, status: "open" });
    const options = JSON.parse(zone.options_json) as ZoneOptions;
    expect(options).toMatchObject({ tier: 1, level: 1, party: 2, name: atlasNodeById(atlasSeed(CREW), node)!.name });

    const b = await went(node, CREW, "bo", 4);
    expect(b).toEqual({ code: a.code, fresh: false });
    // The chart shows it is being fought through.
    const shown = (await chartFor(db, CREW)).nodes.find((n) => n.id === node)!;
    expect(shown).toMatchObject({ state: "open", zone: a.code, here: [] });
    sql.prepare("INSERT INTO zone_presence (player_id, code, fighting, seen_at) VALUES ('bo', ?, 0, ?)").run(a.code, Date.now());
    expect((await chartFor(db, CREW)).nodes.find((n) => n.id === node)!.here).toEqual(["Bo"]);
  });

  it("makes a fresh, different map once the last has been left alone too long", async () => {
    const node = first();
    const a = await went(node);
    sql.prepare("UPDATE zones SET updated_at = ? WHERE code = ?").run(Date.now() - CAVE_IDLE_MS - 1000, a.code);
    const b = await went(node);
    expect(b.fresh).toBe(true);
    expect(b.code).not.toBe(a.code);
    expect((await getZoneRow(db, b.code))!.seed).not.toBe((await getZoneRow(db, a.code))!.seed);
    expect(sql.prepare("SELECT attempts, zone_code FROM atlas_nodes WHERE crew_id = ? AND node = ?").get(CREW, node)).toEqual({ attempts: 2, zone_code: b.code });
  });

  it("opens nothing a route does not yet run to, and nothing twice", async () => {
    const node = first();
    const far = beyond(node);
    expect(await openNode(db, CREW, "ann", far, 2)).toMatchObject({ status: 409, error: expect.stringMatching(/No route/) });
    expect(await openNode(db, CREW, "ann", ATLAS_HOME, 2)).toMatchObject({ status: 400 });
    expect(await openNode(db, CREW, "ann", "nowhere", 2)).toMatchObject({ status: 400 });
    expect(await openNode(db, CREW, "ann", { q: 1, r: 0 }, 2)).toMatchObject({ status: 400 });

    await went(node);
    expect(await clearNode(db, CREW, node)).toBe(true);
    expect(await clearNode(db, CREW, node)).toBe(false);
    expect(await openNode(db, CREW, "ann", node, 2)).toMatchObject({ status: 409, error: expect.stringMatching(/cleared already/) });
    // And now a route runs on from it.
    expect((await went(far)).fresh).toBe(true);
  });

  it("shows a cleared landfall as cleared and the ones beyond it as open, for that crew only", async () => {
    const node = first();
    const far = beyond(node);
    expect((await states()).get(far)).toBe("fogged");
    await went(node);
    await clearNode(db, CREW, node);
    const now = await states();
    expect(now.get(node)).toBe("cleared");
    expect(now.get(far)).toBe("open");
    // A cleared landfall has no map to join.
    expect((await chartFor(db, CREW)).nodes.find((n) => n.id === node)).not.toHaveProperty("zone");
    expect([...(await states(OTHER)).values()].filter((s) => s === "cleared")).toEqual([]);
  });

  it("keeps a landfall to the crew whose chart it is on", async () => {
    const zone = (await getZoneRow(db, (await went(first())).code))!;
    expect(enterProblem(zone, CREW)).toBeNull();
    expect(enterProblem(zone, OTHER)).toMatch(/another crew/);
    expect(enterProblem(zone, null)).toMatch(/another crew/);
    // Any other kind of zone is open to whoever has its code, as before.
    expect(enterProblem({ kind: "caves", crew_id: CREW }, OTHER)).toBeNull();
    expect(enterProblem({ kind: "dev", crew_id: null }, null)).toBeNull();
  });

  it("lets the dev toolbox clear a landfall that is open, and wipe the chart", async () => {
    const node = first();
    expect(await devClearNode(db, CREW, beyond(node))).toMatch(/No route/);
    expect(await devClearNode(db, CREW, node)).toBeNull();
    expect(await devClearNode(db, CREW, node)).toMatch(/cleared already/);
    expect((await states()).get(node)).toBe("cleared");
    await devResetChart(db, CREW);
    expect((await states()).get(node)).toBe("open");
  });
});

describe("lodestones", () => {
  it("are kept in the crew's case, each kind counted, and are no other crew's", async () => {
    await addStone(db, CREW, ["hardy"]);
    await addStone(db, CREW, "hardy");
    await addStone(db, CREW, ["savage", "tangled"]);
    // Not a stone: nothing is kept.
    await addStone(db, CREW, "rainy");
    await addStone(db, CREW, []);
    // The ones that carry most first.
    expect((await chartFor(db, CREW)).stones).toEqual([{ stone: ["tangled", "savage"], qty: 1 }, { stone: ["hardy"], qty: 2 }]);
    expect((await chartFor(db, OTHER)).stones).toEqual([]);
    await devGrantStone(db, OTHER);
    expect((await stonesOf(db, OTHER)).reduce((n, s) => n + s.qty, 0)).toBe(1);
  });

  it("set into a place before anyone sets out, makes its map carry what the stone does, and is spent", async () => {
    const node = first();
    await addStone(db, CREW, ["hardy", "numerous"]);
    await addStone(db, CREW, ["hardy", "numerous"]);
    expect(await setStone(db, CREW, "ann", node, "numerous+hardy")).toEqual({ ok: true });
    const chart = await chartFor(db, CREW);
    expect(chart.nodes.find((n) => n.id === node)).toMatchObject({ state: "open", stone: ["hardy", "numerous"] });
    expect(chart.nodes.find((n) => n.id === node)!.zone).toBeUndefined();
    expect(chart.stones).toEqual([{ stone: ["hardy", "numerous"], qty: 1 }]);
    // Whoever sets out, the map made has them on it, over what the place had of its own.
    const a = await went(node, CREW, "bo");
    const options = JSON.parse((await getZoneRow(db, a.code))!.options_json) as ZoneOptions;
    expect(options.mods).toEqual(["hardy", "numerous"]);
    // And the next map made for it, if this one is let go.
    sql.prepare("UPDATE zones SET updated_at = ? WHERE code = ?").run(Date.now() - CAVE_IDLE_MS - 1000, a.code);
    const b = await went(node);
    expect((JSON.parse((await getZoneRow(db, b.code))!.options_json) as ZoneOptions).mods).toEqual(["hardy", "numerous"]);
    // Cleared, it is only cleared: the stone is not shown, and is not given back.
    await clearNode(db, CREW, node);
    const after = await chartFor(db, CREW);
    expect(after.nodes.find((n) => n.id === node)).toMatchObject({ state: "cleared" });
    expect(after.nodes.find((n) => n.id === node)!.stone).toBeUndefined();
    expect(after.stones).toEqual([{ stone: ["hardy", "numerous"], qty: 1 }]);
  });

  it("cannot be set where there is no route, nor twice, nor once the crew has set out, nor without the stone", async () => {
    const node = first();
    const other = home().links[1];
    const far = beyond(node);
    await addStone(db, CREW, ["hardy"]);
    await addStone(db, CREW, ["swift"]);
    expect(await setStone(db, CREW, "ann", far, "hardy")).toMatchObject({ status: 409, error: expect.stringMatching(/No route/) });
    expect(await setStone(db, CREW, "ann", ATLAS_HOME, "hardy")).toMatchObject({ status: 400 });
    expect(await setStone(db, CREW, "ann", node, "rainy")).toMatchObject({ status: 400 });
    expect(await setStone(db, CREW, "ann", node, "savage")).toMatchObject({ status: 409, error: expect.stringMatching(/no such lodestone/) });
    // Another crew's case is not this crew's.
    expect(await setStone(db, OTHER, "cy", first(OTHER), "hardy")).toMatchObject({ status: 409, error: expect.stringMatching(/no such lodestone/) });

    expect(await setStone(db, CREW, "ann", node, "hardy")).toEqual({ ok: true });
    expect(await setStone(db, CREW, "bo", node, "swift")).toMatchObject({ status: 409, error: expect.stringMatching(/already/) });
    // Nothing was spent by the refusals.
    expect((await chartFor(db, CREW)).stones).toEqual([{ stone: ["swift"], qty: 1 }]);

    await went(other);
    expect(await setStone(db, CREW, "ann", other, "swift")).toMatchObject({ status: 409, error: expect.stringMatching(/too late/) });
    await clearNode(db, CREW, other);
    expect(await setStone(db, CREW, "ann", other, "swift")).toMatchObject({ status: 409, error: expect.stringMatching(/cleared already/) });
    expect((await chartFor(db, CREW)).stones).toEqual([{ stone: ["swift"], qty: 1 }]);
  });
});
