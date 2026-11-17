// A crew's chart in D1 (src/server/atlas.ts), against a real SQLite database
// with the game's migrations applied (the same stand-in for D1 as
// storage.test.ts).

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { ATLAS_HOME, PLAIN_STONE_COST, STACK_MAX, TOWN_CHEST_COLS, TOWN_CHEST_ROWS, atlasNodeById, chestRowCost, needsStone, stoneItem, type ZoneModId, type ZoneOptions } from "@gantt-quest/world";
import { atlasSeed, chartFor, clearNode, devClearNode, devResetChart, enterProblem, openNode } from "../src/server/atlas";
import { applyZoneGrant } from "../src/server/db";
import { cutStone, gainStone, lodestonesOf } from "../src/server/lodestones";
import { chestAddRow, chestFor, chestPut, chestTake } from "../src/server/townchest";
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
/** Put a lodestone in someone's pack: a plain one, or one that carries these. */
const give = (who: string, stone: ZoneModId[] = []) =>
  sql.prepare("INSERT INTO consumables (player_id, kind, qty) VALUES (?, ?, 1) ON CONFLICT(player_id, kind) DO UPDATE SET qty = qty + 1").run(who, stoneItem(stone));
/** Set out for a place, with a plain lodestone in its slot where it needs one. */
const went = async (node: unknown, crew = CREW, by = "ann", party = 2) => {
  const needs = needsStone(atlasNodeById(atlasSeed(crew), node)!);
  if (needs) give(by);
  const res = await openNode(db, crew, by, node, party, needs ? "" : undefined);
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
  it("are a hero's own, in the pack: each kind counted, the ones that carry most first", async () => {
    give("ann", ["hardy"]);
    give("ann", ["hardy"]);
    give("ann");
    give("ann", ["tangled", "savage"]);
    await gainStone(db, "bo", ["swift"]).run();
    // Something else in the pack is no lodestone.
    sql.prepare("INSERT INTO consumables (player_id, kind, qty) VALUES ('ann', 'healing', 3)").run();
    expect(await lodestonesOf(db, "ann")).toEqual([{ stone: ["tangled", "savage"], qty: 1 }, { stone: ["hardy"], qty: 2 }, { stone: [], qty: 1 }]);
    expect(await lodestonesOf(db, "bo")).toEqual([{ stone: ["swift"], qty: 1 }]);
    expect(await lodestonesOf(db, "cy")).toEqual([]);
  });

  it("one found in a bounty goes into the pack of the hero who found it", async () => {
    await applyZoneGrant(db, "ann", { xp: 5, resources: {}, stone: ["fouled", "swift"] });
    await applyZoneGrant(db, "ann", { xp: 5, resources: {}, stone: "nonsense" });
    await applyZoneGrant(db, "ann", { xp: 5, resources: {} });
    expect(await lodestonesOf(db, "ann")).toEqual([{ stone: ["fouled", "swift"], qty: 1 }]);
  });

  it("must be in a place's slot to set out for it, anywhere but beside the Harbor, and is spent from the pack of whoever sets out", async () => {
    const node = first();
    const far = beyond(node);
    // Beside the Harbor: none needed.
    expect((await openNode(db, CREW, "ann", node, 2)) as { fresh: boolean }).toMatchObject({ fresh: true });
    await clearNode(db, CREW, node);
    // Beyond it: refused without one, with one that is not held, and with nonsense.
    expect(await openNode(db, CREW, "ann", far, 2)).toMatchObject({ status: 409, error: expect.stringMatching(/needs a lodestone/) });
    expect(await openNode(db, CREW, "ann", far, 2, "")).toMatchObject({ status: 409, error: expect.stringMatching(/You have no plain lodestone/) });
    expect(await openNode(db, CREW, "ann", far, 2, "rainy")).toMatchObject({ status: 400 });
    give("bo");
    // Bo's stone is not Ann's.
    expect(await openNode(db, CREW, "ann", far, 2, "")).toMatchObject({ status: 409 });
    expect(await lodestonesOf(db, "bo")).toEqual([{ stone: [], qty: 1 }]);
    const a = await openNode(db, CREW, "bo", far, 2, "");
    expect(a).toMatchObject({ fresh: true });
    expect(await lodestonesOf(db, "bo")).toEqual([]);
    // Whoever follows joins the same map, and spends nothing, whatever they hold out.
    give("ann", ["hardy"]);
    expect(await openNode(db, CREW, "ann", far, 2, "hardy")).toEqual({ code: (a as { code: string }).code, fresh: false });
    expect(await lodestonesOf(db, "ann")).toEqual([{ stone: ["hardy"], qty: 1 }]);
    // A plain stone adds nothing to the map, and the chart says one is in the slot.
    expect((JSON.parse((await getZoneRow(db, (a as { code: string }).code))!.options_json) as ZoneOptions).mods ?? []).toEqual(atlasNodeById(atlasSeed(CREW), far)!.mods);
    expect((await chartFor(db, CREW)).nodes.find((n) => n.id === far)).toMatchObject({ state: "open", stone: [] });
  });

  it("one that carries something makes the place's map carry it too, and the slot is empty again once that map is let go", async () => {
    const node = first();
    give("ann", ["hardy", "numerous"]);
    give("ann", ["hardy", "numerous"]);
    // Set into a place beside the Harbor, which needs none: it takes all the same.
    const a = await openNode(db, CREW, "ann", node, 2, "numerous+hardy");
    if ("error" in a) throw new Error(a.error);
    expect((JSON.parse((await getZoneRow(db, a.code))!.options_json) as ZoneOptions).mods).toEqual(["hardy", "numerous"]);
    expect((await chartFor(db, CREW)).nodes.find((n) => n.id === node)).toMatchObject({ zone: a.code, stone: ["hardy", "numerous"] });
    expect(await lodestonesOf(db, "ann")).toEqual([{ stone: ["hardy", "numerous"], qty: 1 }]);
    // Left alone too long, the map is gone and so is the stone that made it: the next is made plain.
    sql.prepare("UPDATE zones SET updated_at = ? WHERE code = ?").run(Date.now() - CAVE_IDLE_MS - 1000, a.code);
    expect((await chartFor(db, CREW)).nodes.find((n) => n.id === node)!.stone).toBeUndefined();
    const b = await openNode(db, CREW, "bo", node, 2);
    if ("error" in b) throw new Error(b.error);
    expect((JSON.parse((await getZoneRow(db, b.code))!.options_json) as ZoneOptions).mods ?? []).toEqual([]);
    expect((await chartFor(db, CREW)).nodes.find((n) => n.id === node)!.stone).toBeUndefined();
  });

  it("a plain one can be cut from stone and iron, and not without them", async () => {
    expect(await cutStone(db, "ann")).toMatch(/stone and iron/);
    for (const [kind, qty] of Object.entries(PLAIN_STONE_COST)) sql.prepare("INSERT INTO resources (player_id, kind, qty) VALUES ('ann', ?, ?)").run(kind, qty! * 2 + 1);
    expect(await cutStone(db, "ann")).toBeNull();
    expect(await cutStone(db, "ann")).toBeNull();
    expect(await lodestonesOf(db, "ann")).toEqual([{ stone: [], qty: 2 }]);
    // What was left is not enough for a third.
    expect(await cutStone(db, "ann")).toMatch(/stone and iron/);
    expect(sql.prepare("SELECT kind, qty FROM resources WHERE player_id = 'ann' ORDER BY kind").all()).toEqual(Object.keys(PLAIN_STONE_COST).sort().map((kind) => ({ kind, qty: 1 })));
  });
});

describe("the town chest", () => {
  const tabOf = async (tab: string, crew = CREW) => (await chestFor(db, crew)).tabs.find((t) => t.id === tab)!;
  const mats = (who: string) => Object.fromEntries((sql.prepare("SELECT kind, qty FROM resources WHERE player_id = ? AND qty > 0").all(who) as { kind: string; qty: number }[]).map((r) => [r.kind, r.qty]));
  const hand = (who: string, kind: string, qty: number) => sql.prepare("INSERT INTO resources (player_id, kind, qty) VALUES (?, ?, ?) ON CONFLICT(player_id, kind) DO UPDATE SET qty = qty + excluded.qty").run(who, kind, qty);

  it("starts empty, with a tab for lodestones and one for materials", async () => {
    const chest = await chestFor(db, CREW);
    expect(chest.tabs.map((t) => t.id)).toEqual(["lodestones", "materials"]);
    expect(chest.tabs.every((t) => t.rows === TOWN_CHEST_ROWS && t.held.length === 0)).toBe(true);
  });

  it("takes what one of the crew puts in out of their pack, and gives it to whichever of them takes it out", async () => {
    hand("ann", "wood", 30);
    give("ann", ["hardy"]);
    give("ann", ["hardy"]);
    expect(await chestPut(db, CREW, "ann", "materials", "wood", 20)).toBeNull();
    expect(await chestPut(db, CREW, "ann", "lodestones", stoneItem(["hardy"]), 2)).toBeNull();
    expect(mats("ann")).toEqual({ wood: 10 });
    expect(await lodestonesOf(db, "ann")).toEqual([]);
    expect((await tabOf("materials")).held).toEqual([{ kind: "wood", qty: 20 }]);
    expect((await tabOf("lodestones")).held).toEqual([{ kind: "lodestone:hardy", qty: 2 }]);
    // Bo, of the same crew, takes some out.
    expect(await chestTake(db, CREW, "bo", "materials", "wood", 15)).toBeNull();
    expect(await chestTake(db, CREW, "bo", "lodestones", "lodestone:hardy", 1)).toBeNull();
    expect(mats("bo")).toEqual({ wood: 15 });
    expect(await lodestonesOf(db, "bo")).toEqual([{ stone: ["hardy"], qty: 1 }]);
    expect((await tabOf("materials")).held).toEqual([{ kind: "wood", qty: 5 }]);
    // Another crew's chest is another chest.
    expect((await tabOf("materials", OTHER)).held).toEqual([]);
    expect(await chestTake(db, OTHER, "cy", "materials", "wood", 1)).toMatch(/not that many/);
  });

  it("gives nothing that is not there, and takes nothing that is not carried or does not belong", async () => {
    hand("ann", "wood", 5);
    expect(await chestPut(db, CREW, "ann", "materials", "wood", 6)).toMatch(/no longer carry/);
    expect(await chestPut(db, CREW, "ann", "lodestones", "wood", 1)).toMatch(/does not belong/);
    expect(await chestPut(db, CREW, "ann", "materials", "lodestone", 1)).toMatch(/does not belong/);
    expect(await chestPut(db, CREW, "ann", "gear", "wood", 1)).toMatch(/no such tab/);
    expect(await chestPut(db, CREW, "ann", "materials", "wood", 0)).toMatch(/not an amount/);
    expect(await chestPut(db, CREW, "ann", "materials", "wood", 5)).toBeNull();
    expect(await chestTake(db, CREW, "bo", "materials", "wood", 6)).toMatch(/not that many/);
    expect(await chestTake(db, CREW, "bo", "materials", "wood", -1)).toMatch(/not an amount/);
    expect(await chestTake(db, CREW, "bo", "materials", "healing", 1)).toMatch(/no such thing/);
    // Nothing moved by any of it but the one that went in.
    expect(mats("ann")).toEqual({});
    expect(mats("bo")).toEqual({});
    expect((await tabOf("materials")).held).toEqual([{ kind: "wood", qty: 5 }]);
  });

  it("holds no more than its squares, until someone pays for another row: for the whole crew, and dearer each time", async () => {
    const squares = TOWN_CHEST_ROWS * TOWN_CHEST_COLS;
    sql.prepare("INSERT INTO town_chest (crew_id, tab, kind, qty) VALUES (?, 'materials', 'stone', ?)").run(CREW, STACK_MAX * squares);
    hand("ann", "wood", 40);
    expect(await chestPut(db, CREW, "ann", "materials", "wood", 1)).toMatch(/no room/);
    // Not without the gold and the materials for it.
    sql.prepare("UPDATE characters SET gold = 0 WHERE player_id = 'bo'").run();
    expect(await chestAddRow(db, CREW, "bo", "materials")).toMatch(/gold and materials/);
    const cost = chestRowCost(TOWN_CHEST_ROWS)!;
    for (const [kind, qty] of Object.entries(cost.resources)) hand("bo", kind, qty!);
    sql.prepare("UPDATE characters SET gold = ? WHERE player_id = 'bo'").run(cost.gold + 7);
    expect(await chestAddRow(db, CREW, "bo", "materials")).toBeNull();
    expect((await tabOf("materials")).rows).toBe(TOWN_CHEST_ROWS + 1);
    expect((await tabOf("lodestones")).rows).toBe(TOWN_CHEST_ROWS);
    expect((sql.prepare("SELECT gold FROM characters WHERE player_id = 'bo'").get() as { gold: number }).gold).toBe(7);
    expect(mats("bo")).toEqual({});
    // Now Ann's wood goes in.
    expect(await chestPut(db, CREW, "ann", "materials", "wood", 40)).toBeNull();
    // The next row costs more than Bo has left.
    expect(chestRowCost(TOWN_CHEST_ROWS + 1)!.gold).toBeGreaterThan(cost.gold);
    expect(await chestAddRow(db, CREW, "bo", "materials")).toMatch(/gold and materials/);
  });
});
