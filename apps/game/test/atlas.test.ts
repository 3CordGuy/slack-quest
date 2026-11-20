// A crew's chart in D1 (src/server/atlas.ts), against a real SQLite database
// with the game's migrations applied (the stand-in for D1 in d1.ts).

import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { ATLAS_HOME, GEM_PRICE, PLAIN_STONE_COST, STACK_MAX, TOWN_TABS_MAX, TOWN_TAB_CELLS, atlasNodeById, attuneCost, modsOf, nodePlace, townTabCost, needsStone, rerollCost, stoneItem, temperCost, type ZoneMod, type ZoneOptions } from "@gantt-quest/world";
import { atlasSeed, chartFor, clearNode, devClearNode, devResetChart, enterProblem, openNode, scoutNode } from "../src/server/atlas";
import { applyZoneGrant, carryState, sellMaterial } from "../src/server/db";
import { sellGems } from "../src/server/lapidary";
import { attuneStone, cutStone, fuseStones, gainStone, lodestonesOf, rerollStone, temperStone } from "../src/server/lodestones";
import { chestBuyTab, chestColorTab, chestFor, chestMoveTab, chestPutGear, chestPutStack, chestRenameTab, chestTakeGear, chestTakeStack } from "../src/server/townchest";
import { CAVE_IDLE_MS, getZoneRow } from "../src/server/zones";
import { addHero, openDb } from "./d1";

let sql: DatabaseSync;
let db: D1Database;
const CREW = "CREWAA";
const OTHER = "CREWBB";

beforeEach(() => {
  ({ sql, db } = openDb());
  const at = Date.now();
  for (const [id, name, crew] of [["ann", "Ann", CREW], ["bo", "Bo", CREW], ["cy", "Cy", OTHER]]) addHero(sql, { id, name, crew, at });
});

const home = (crew = CREW) => atlasNodeById(atlasSeed(crew), ATLAS_HOME)!;
const first = (crew = CREW) => home(crew).links[0];
/** A node a ring out that a route runs to from `from`. */
const beyond = (from: string, crew = CREW) => atlasNodeById(atlasSeed(crew), from)!.links.find((id) => atlasNodeById(atlasSeed(crew), id)!.ring === 2)!;
const states = async (crew = CREW) => new Map((await chartFor(db, crew)).nodes.map((n) => [n.id, n.state]));
/** Put a lodestone in someone's pack: a plain one, or one that carries these. */
const give = (who: string, stone: ZoneMod[] = []) =>
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

describe("scouting a place before a muster is called for it", () => {
  /** Everything in the database, table by table: scouting must leave it exactly as it was. */
  const everything = () =>
    JSON.stringify((sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(({ name }) => [name, sql.prepare(`SELECT * FROM "${name}"`).all()]));
  /** What scouting says of a place nobody is on and anyone may set out for. */
  const placeOf = (id: string, crew = CREW) => {
    const node = atlasNodeById(atlasSeed(crew), id)!;
    return { node: id, place: node.name, site: nodePlace(atlasSeed(crew), node), level: node.level };
  };
  /** Scout, and expect the refusal `openNode` gives for the same thing, with nothing written by either. */
  const refused = async (id: unknown, stone?: unknown) => {
    const before = everything();
    const scouted = await scoutNode(db, CREW, id, stone);
    expect(everything()).toBe(before);
    expect(scouted).toHaveProperty("error");
    expect(scouted).toEqual(await openNode(db, CREW, "ann", id, 2, stone));
    expect(everything()).toBe(before);
    return scouted;
  };

  it("says what the place is called, what kind of place it is and its level, and makes and spends nothing", async () => {
    const node = first();
    give("ann", ["hardy"]);
    const before = everything();
    expect(await scoutNode(db, CREW, node)).toEqual(placeOf(node));
    expect(placeOf(node).site).toEqual(expect.stringMatching(/\S/));
    // With a stone in the slot it says the same, and the stone stays in the pack.
    expect(await scoutNode(db, CREW, node, "hardy")).toEqual(placeOf(node));
    expect(await scoutNode(db, CREW, node, null)).toEqual(placeOf(node));
    expect(everything()).toBe(before);
    expect(sql.prepare("SELECT COUNT(*) AS n FROM zones").get()).toEqual({ n: 0 });
    expect(sql.prepare("SELECT COUNT(*) AS n FROM atlas_nodes").get()).toEqual({ n: 0 });
    expect(await lodestonesOf(db, "ann")).toEqual([{ stone: ["hardy"], qty: 1 }]);
    // Every landfall beside the Harbor can be scouted, and each is its own place.
    const all = await Promise.all(home().links.map((id) => scoutNode(db, CREW, id)));
    expect(all).toEqual(home().links.map((id) => placeOf(id)));
    expect(everything()).toBe(before);
  });

  it("refuses what setting out refuses, in the same words", async () => {
    const node = first();
    const far = beyond(node);
    expect(await refused(far)).toMatchObject({ status: 409, error: expect.stringMatching(/No route/) });
    // No route is said before anything about the stone, as it is on setting out.
    expect(await refused(far, "")).toMatchObject({ status: 409, error: expect.stringMatching(/No route/) });
    expect(await refused(ATLAS_HOME)).toMatchObject({ status: 400 });
    expect(await refused("nowhere")).toMatchObject({ status: 400 });
    expect(await refused({ q: 1, r: 0 })).toMatchObject({ status: 400 });
    expect(await refused(undefined)).toMatchObject({ status: 400 });
    expect(await refused(node, "rainy")).toMatchObject({ status: 400, error: "That is no lodestone." });

    await clearNode(db, CREW, node);
    expect(await refused(node)).toMatchObject({ status: 409, error: expect.stringMatching(/cleared already/) });
    expect(await refused(node, "")).toMatchObject({ status: 409, error: expect.stringMatching(/cleared already/) });
    // Beyond it a route now runs, and the place needs a lodestone in its slot.
    expect(await refused(far)).toMatchObject({ status: 409, error: expect.stringMatching(/needs a lodestone/) });
    expect(await refused(far, null)).toMatchObject({ status: 409, error: expect.stringMatching(/needs a lodestone/) });
    expect(await refused(far, "rainy")).toMatchObject({ status: 400, error: "That is no lodestone." });
  });

  it("does not look in the pack: a stone that is not held is found out when the muster starts", async () => {
    const node = first();
    await clearNode(db, CREW, node);
    const far = beyond(node);
    const before = everything();
    expect(await scoutNode(db, CREW, far, "")).toEqual(placeOf(far));
    expect(await scoutNode(db, CREW, far, "hardy+numerous")).toEqual(placeOf(far));
    expect(everything()).toBe(before);
    // Setting out is where it is refused.
    expect(await openNode(db, CREW, "ann", far, 2, "")).toMatchObject({ status: 409, error: expect.stringMatching(/You have no plain lodestone/) });
  });

  it("gives the map already being fought through there, whatever is held out, and the place again once that map is let go", async () => {
    const node = first();
    const a = await went(node);
    const before = everything();
    expect(await scoutNode(db, CREW, node)).toEqual({ live: a.code });
    // Joining needs no stone and looks at none, as on setting out: not even at one that is no stone.
    expect(await scoutNode(db, CREW, node, "hardy")).toEqual({ live: a.code });
    expect(await scoutNode(db, CREW, node, "rainy")).toEqual({ live: a.code });
    expect(await openNode(db, CREW, "bo", node, 2, "rainy")).toEqual({ code: a.code, fresh: false });
    expect(everything()).toBe(before);
    // The other landfalls are no nearer to having a map, and another crew's chart is not this one's.
    expect(await scoutNode(db, CREW, home().links[1])).toEqual(placeOf(home().links[1]));
    expect(await scoutNode(db, OTHER, first(OTHER))).toEqual(placeOf(first(OTHER), OTHER));

    // A place that needs a stone: the map made with one is joined without one.
    await clearNode(db, CREW, node);
    const far = beyond(node);
    const b = await went(far);
    expect(await scoutNode(db, CREW, far)).toEqual({ live: b.code });

    // Left alone too long, that map is gone: the place is there to be set out for again, with a stone.
    sql.prepare("UPDATE zones SET updated_at = ? WHERE code = ?").run(Date.now() - CAVE_IDLE_MS - 1000, b.code);
    const later = everything();
    expect(await scoutNode(db, CREW, far)).toMatchObject({ status: 409, error: expect.stringMatching(/needs a lodestone/) });
    expect(await scoutNode(db, CREW, far, "")).toEqual(placeOf(far));
    expect(everything()).toBe(later);
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
  /** A crew's tab of a kind: the first of them. */
  const tabOf = async (kind: string, crew = CREW) => (await chestFor(db, crew)).tabs.find((t) => t.kind === kind)!;
  const mats = (who: string) => Object.fromEntries((sql.prepare("SELECT kind, qty FROM resources WHERE player_id = ? AND qty > 0").all(who) as { kind: string; qty: number }[]).map((r) => [r.kind, r.qty]));
  const hand = (who: string, kind: string, qty: number) => sql.prepare("INSERT INTO resources (player_id, kind, qty) VALUES (?, ?, ?) ON CONFLICT(player_id, kind) DO UPDATE SET qty = qty + excluded.qty").run(who, kind, qty);
  /** Put a piece of gear in someone's pack, and give its id: a ring (a square) unless another slot is named. */
  const gear = (who: string, name = "Brass Ring", slot = "ring", worn = 0) =>
    Number(
      sql
        .prepare("INSERT INTO inventory (player_id, kind, ref, name, rarity, slot, power, level_req, icon, stat_bonus_json, equipped, created_at, upgrades) VALUES (?, 'trinket', 'brass_ring', ?, 'rare', ?, 4, 2, 'ring', '{\"str\":2}', ?, 1, 1)")
        .run(who, name, slot, worn).lastInsertRowid,
    );
  const pack = (who: string) => (sql.prepare("SELECT name FROM inventory WHERE player_id = ? ORDER BY id").all(who) as { name: string }[]).map((r) => r.name);
  const gold = (who: string) => (sql.prepare("SELECT gold FROM characters WHERE player_id = ?").get(who) as { gold: number }).gold;

  it("starts with a chest, a tab for materials and one for lodestones, all empty, and makes them once", async () => {
    const chest = await chestFor(db, CREW);
    expect(chest.tabs.map((t) => [t.name, t.kind])).toEqual([["Chest", "general"], ["Materials", "materials"], ["Lodestones", "lodestones"]]);
    expect(chest.tabs.every((t) => t.gear.length === 0 && t.stacks.length === 0)).toBe(true);
    expect(chest.nextTab).toBe(townTabCost(1));
    expect((await chestFor(db, CREW)).tabs.map((t) => t.id)).toEqual(chest.tabs.map((t) => t.id));
    // Another crew's chest is another chest.
    const theirs = await chestFor(db, OTHER);
    expect(theirs.tabs.length).toBe(3);
    expect(theirs.tabs.some((t) => chest.tabs.some((mine) => mine.id === t.id))).toBe(false);
  });

  it("takes a piece of gear out of one pack, keeps what it is, and gives it to whichever of the crew takes it out", async () => {
    const ring = gear("ann");
    const chest = await tabOf("general");
    expect(await chestPutGear(db, CREW, "ann", chest.id, ring)).toBeNull();
    expect(pack("ann")).toEqual([]);
    const [kept] = (await tabOf("general")).gear;
    expect(kept).toMatchObject({ id: ring, name: "Brass Ring", rarity: "rare", slot: "ring", ref: "brass_ring", power: 4, level_req: 2, upgrades: 1, stat_bonus_json: '{"str":2}' });
    // Bo, of the same crew, takes it out: it is Bo's now, and nobody's twice.
    expect(await chestTakeGear(db, CREW, "bo", kept.id)).toBeNull();
    expect(pack("bo")).toEqual(["Brass Ring"]);
    expect((await tabOf("general")).gear).toEqual([]);
    expect(await chestTakeGear(db, CREW, "ann", kept.id)).toMatch(/no longer in the chest/);
    // It is the same piece it was: its id with it.
    expect(sql.prepare("SELECT id, power, level_req, upgrades, equipped, stored_in FROM inventory WHERE player_id = 'bo'").get()).toEqual({ id: ring, power: 4, level_req: 2, upgrades: 1, equipped: 0, stored_in: null });
    // A piece made after it gets an id of its own, not the one that was out of the table for a while.
    const next = gear("ann");
    expect(next).toBeGreaterThan(ring);
    expect(await chestPutGear(db, CREW, "bo", (await tabOf("general")).id, ring)).toBeNull();
    expect(gear("ann", "Another")).toBeGreaterThan(next);
  });

  it("takes no gear that is worn, is somebody else's, or is meant for a tab that does not hold gear", async () => {
    const chest = await tabOf("general");
    const worn = gear("ann", "Worn Ring", "ring", 1);
    const bos = gear("bo", "Bo's Ring");
    const mine = gear("ann");
    expect(await chestPutGear(db, CREW, "ann", chest.id, worn)).toMatch(/no such thing/);
    expect(await chestPutGear(db, CREW, "ann", chest.id, bos)).toMatch(/no such thing/);
    expect(await chestPutGear(db, CREW, "ann", (await tabOf("materials")).id, mine)).toMatch(/does not belong/);
    expect(await chestPutGear(db, CREW, "ann", (await tabOf("general", OTHER)).id, mine)).toMatch(/no such tab/);
    expect(await chestPutGear(db, CREW, "ann", "1", mine)).toMatch(/no such tab/);
    expect(pack("ann")).toEqual(["Worn Ring", "Brass Ring"]);
    // And gives none to somebody outside the crew.
    expect(await chestPutGear(db, CREW, "ann", chest.id, mine)).toBeNull();
    const [kept] = (await tabOf("general")).gear;
    expect(await chestTakeGear(db, OTHER, "cy", kept.id)).toMatch(/no longer in the chest/);
    expect((await tabOf("general")).gear.length).toBe(1);
  });

  it("holds gear only while it has the squares, and gives it only to a pack with room", async () => {
    const chest = await tabOf("general");
    // All but two of its squares are filled.
    sql.prepare("INSERT INTO town_stacks (tab_id, kind, qty) VALUES (?, 'stone', ?)").run(chest.id, STACK_MAX * (TOWN_TAB_CELLS - 2));
    const helm = gear("ann", "Helm", "helmet");
    const ring = gear("ann");
    expect(await chestPutGear(db, CREW, "ann", chest.id, helm)).toMatch(/no room/);
    expect(await chestPutGear(db, CREW, "ann", chest.id, ring)).toBeNull();
    expect(pack("ann")).toEqual(["Helm"]);
    // Bo's pack is full to the brim: the ring stays where it is.
    const { limit, carried } = (await carryState(db, "bo"))!;
    for (let i = carried; i < limit; i++) gear("bo", `Ring ${i}`);
    const [kept] = (await tabOf("general")).gear;
    expect(await chestTakeGear(db, CREW, "bo", kept.id)).toMatch(/no room/);
    expect((await tabOf("general")).gear.length).toBe(1);
    expect(pack("bo")).not.toContain("Brass Ring");
  });

  it("moves stacks between a pack and the tab that takes them", async () => {
    hand("ann", "wood", 30);
    give("ann", ["hardy"]);
    give("ann", ["hardy"]);
    const [chest, materials, stones] = [await tabOf("general"), await tabOf("materials"), await tabOf("lodestones")];
    expect(await chestPutStack(db, CREW, "ann", materials.id, "wood", 20)).toBeNull();
    expect(await chestPutStack(db, CREW, "ann", stones.id, stoneItem(["hardy"]), 1)).toBeNull();
    // A general tab takes either.
    expect(await chestPutStack(db, CREW, "ann", chest.id, "wood", 4)).toBeNull();
    expect(await chestPutStack(db, CREW, "ann", chest.id, stoneItem(["hardy"]), 1)).toBeNull();
    expect(mats("ann")).toEqual({ wood: 6 });
    expect(await lodestonesOf(db, "ann")).toEqual([]);
    expect((await tabOf("materials")).stacks).toEqual([{ kind: "wood", qty: 20 }]);
    expect((await tabOf("lodestones")).stacks).toEqual([{ kind: "lodestone:hardy", qty: 1 }]);
    expect((await tabOf("general")).stacks).toEqual([{ kind: "lodestone:hardy", qty: 1 }, { kind: "wood", qty: 4 }]);
    // Bo takes some out.
    expect(await chestTakeStack(db, CREW, "bo", materials.id, "wood", 15)).toBeNull();
    expect(await chestTakeStack(db, CREW, "bo", chest.id, "lodestone:hardy", 1)).toBeNull();
    expect(mats("bo")).toEqual({ wood: 15 });
    expect(await lodestonesOf(db, "bo")).toEqual([{ stone: ["hardy"], qty: 1 }]);
    expect((await tabOf("materials")).stacks).toEqual([{ kind: "wood", qty: 5 }]);
    expect((await tabOf("general")).stacks).toEqual([{ kind: "wood", qty: 4 }]);
  });

  it("gives nothing that is not there, and takes nothing that is not carried or does not belong", async () => {
    hand("ann", "wood", 5);
    const [materials, stones] = [await tabOf("materials"), await tabOf("lodestones")];
    expect(await chestPutStack(db, CREW, "ann", materials.id, "wood", 6)).toMatch(/no longer carry/);
    expect(await chestPutStack(db, CREW, "ann", stones.id, "wood", 1)).toMatch(/does not belong/);
    expect(await chestPutStack(db, CREW, "ann", materials.id, "lodestone", 1)).toMatch(/does not belong/);
    expect(await chestPutStack(db, CREW, "ann", 99999, "wood", 1)).toMatch(/no such tab/);
    expect(await chestPutStack(db, CREW, "ann", materials.id, "wood", 0)).toMatch(/not an amount/);
    expect(await chestPutStack(db, CREW, "ann", materials.id, "wood", 5)).toBeNull();
    expect(await chestTakeStack(db, CREW, "bo", materials.id, "wood", 6)).toMatch(/not that many/);
    expect(await chestTakeStack(db, CREW, "bo", materials.id, "wood", -1)).toMatch(/not an amount/);
    expect(await chestTakeStack(db, CREW, "bo", materials.id, "healing", 1)).toMatch(/no such thing/);
    expect(await chestTakeStack(db, OTHER, "cy", materials.id, "wood", 1)).toMatch(/no such thing/);
    // Nothing moved by any of it but the one that went in.
    expect(mats("ann")).toEqual({});
    expect(mats("bo")).toEqual({});
    expect((await tabOf("materials")).stacks).toEqual([{ kind: "wood", qty: 5 }]);
  });

  it("a general tab holds no more stacks than its squares; the materials tab has none to run out of", async () => {
    const [chest, materials] = [await tabOf("general"), await tabOf("materials")];
    sql.prepare("INSERT INTO town_stacks (tab_id, kind, qty) VALUES (?, 'stone', ?)").run(chest.id, STACK_MAX * TOWN_TAB_CELLS);
    hand("ann", "wood", 400);
    expect(await chestPutStack(db, CREW, "ann", chest.id, "wood", 1)).toMatch(/no room/);
    expect(await chestPutStack(db, CREW, "ann", materials.id, "wood", 400)).toBeNull();
    expect(mats("ann")).toEqual({});
  });

  it("gets another tab for gold, for the whole crew and dearer each time, up to so many", async () => {
    const cost = townTabCost(1);
    expect(await chestBuyTab(db, CREW, "bo")).toMatch(/gold/);
    sql.prepare("UPDATE characters SET gold = ? WHERE player_id = 'bo'").run(cost + townTabCost(2) - 1);
    expect(await chestBuyTab(db, CREW, "bo", "  Spare   gear ")).toBeNull();
    const chest = await chestFor(db, CREW);
    expect(chest.tabs.map((t) => [t.name, t.kind])).toEqual([["Chest", "general"], ["Materials", "materials"], ["Lodestones", "lodestones"], ["Spare gear", "general"]]);
    expect(chest.nextTab).toBe(townTabCost(2));
    expect(townTabCost(2)).toBeGreaterThan(cost);
    expect(gold("bo")).toBe(townTabCost(2) - 1);
    // The next costs more than Bo has left, and nothing is taken for it.
    expect(await chestBuyTab(db, CREW, "bo")).toMatch(/gold/);
    expect(gold("bo")).toBe(townTabCost(2) - 1);
    // Ann's gear goes into the new one. The other crew's chest is as it was.
    expect(await chestPutGear(db, CREW, "ann", chest.tabs[3].id, gear("ann"))).toBeNull();
    expect((await chestFor(db, OTHER)).tabs.length).toBe(3);
    // A chest has only so many.
    sql.prepare("UPDATE characters SET gold = 1000000 WHERE player_id = 'bo'").run();
    for (let n = 4; n < TOWN_TABS_MAX; n++) expect(await chestBuyTab(db, CREW, "bo"), String(n)).toBeNull();
    expect((await chestFor(db, CREW)).nextTab).toBeNull();
    const before = gold("bo");
    expect(await chestBuyTab(db, CREW, "bo")).toMatch(/all the tabs/);
    expect(gold("bo")).toBe(before);
  });

  it("lets anyone in the crew name a tab again, and nobody else", async () => {
    const stones = await tabOf("lodestones");
    expect(await chestRenameTab(db, CREW, stones.id, "  Keys to the   sea ")).toBeNull();
    expect((await tabOf("lodestones")).name).toBe("Keys to the sea");
    expect(await chestRenameTab(db, CREW, stones.id, "   ")).toMatch(/needs a name/);
    expect(await chestRenameTab(db, OTHER, stones.id, "Ours")).toMatch(/no such tab/);
    expect((await tabOf("lodestones")).name).toBe("Keys to the sea");
  });

  it("lets the crew colour a tab, and move the tabs about", async () => {
    const [chest, materials, stones] = (await chestFor(db, CREW)).tabs;
    expect(chest.color).toBeNull();
    expect(await chestColorTab(db, CREW, stones.id, "teal")).toBeNull();
    expect((await tabOf("lodestones")).color).toBe("teal");
    // Not a colour there is: the tab goes back to having none. Nor another crew's tab.
    expect(await chestColorTab(db, CREW, stones.id, "#ff0000")).toBeNull();
    expect((await tabOf("lodestones")).color).toBeNull();
    expect(await chestColorTab(db, OTHER, stones.id, "red")).toMatch(/no such tab/);
    const order = async (crew = CREW) => (await chestFor(db, crew)).tabs.map((t) => t.id);
    expect(await chestMoveTab(db, CREW, stones.id, 0)).toBeNull();
    expect(await order()).toEqual([stones.id, chest.id, materials.id]);
    expect(await chestMoveTab(db, CREW, stones.id, 99)).toBeNull();
    expect(await order()).toEqual([chest.id, materials.id, stones.id]);
    expect(await chestMoveTab(db, CREW, materials.id, 0)).toBeNull();
    expect(await order()).toEqual([materials.id, chest.id, stones.id]);
    expect(await chestMoveTab(db, CREW, 99999, 0)).toMatch(/no such tab/);
    expect(await chestMoveTab(db, OTHER, chest.id, 0)).toMatch(/no such tab/);
    expect(await chestMoveTab(db, CREW, chest.id, "first")).toMatch(/no such/);
    // A tab bought after that stands last, and what is in a tab moves with it.
    sql.prepare("UPDATE characters SET gold = 1000 WHERE player_id = 'ann'").run();
    hand("ann", "wood", 3);
    expect(await chestPutStack(db, CREW, "ann", materials.id, "wood", 3)).toBeNull();
    expect(await chestBuyTab(db, CREW, "ann")).toBeNull();
    const now = (await chestFor(db, CREW)).tabs;
    expect(now.slice(0, 3).map((t) => t.id)).toEqual([materials.id, chest.id, stones.id]);
    expect(now[0].stacks).toEqual([{ kind: "wood", qty: 3 }]);
    expect(now[3].kind).toBe("general");
  });
});

describe("the Lapidary: the lodestone bench, and gems", () => {
  const gold = (who: string) => (sql.prepare("SELECT gold FROM characters WHERE player_id = ?").get(who) as { gold: number }).gold;
  const hand = (who: string, kind: string, qty: number) => sql.prepare("INSERT INTO resources (player_id, kind, qty) VALUES (?, ?, ?) ON CONFLICT(player_id, kind) DO UPDATE SET qty = qty + excluded.qty").run(who, kind, qty);
  const count = async (who: string) => (await lodestonesOf(db, who)).reduce((n, h) => n + h.qty, 0);

  it("buys gems for gold, only the ones held, and the market stall no longer does", async () => {
    const gems = () => (sql.prepare("SELECT qty FROM resources WHERE player_id = 'ann' AND kind = 'gem'").get() as { qty: number } | undefined)?.qty ?? 0;
    expect(await sellGems(db, "ann", 1)).toMatch(/no gems/);
    hand("ann", "gem", 5);
    const had = gold("ann");
    expect(await sellGems(db, "ann", 2)).toBe(2 * GEM_PRICE);
    expect(gems()).toBe(3);
    expect(gold("ann")).toBe(had + 2 * GEM_PRICE);
    // Not more than are held, not a part of one, and not somebody else's.
    expect(await sellGems(db, "ann", 4)).toMatch(/only have 3 gems/);
    for (const bad of [0, -1, 1.5, "2", null, undefined]) expect(await sellGems(db, "ann", bad)).toMatch(/at least one/);
    expect(await sellGems(db, "bo", 1)).toMatch(/no gems/);
    expect(await sellGems(db, "nobody", 1)).toMatch(/character/);
    expect(gems()).toBe(3);
    expect(gold("ann")).toBe(had + 2 * GEM_PRICE);
    // The stall sends them on: nothing is taken and nothing paid.
    expect(await sellMaterial(db, "ann", "gem", 1)).toMatch(/Lapidary/);
    expect(gems()).toBe(3);
    expect(await sellGems(db, "ann", 3)).toBe(3 * GEM_PRICE);
    expect(gems()).toBe(0);
  });

  it("fuses three stones that carry the same into one that carries one more, and uses the three up", async () => {
    for (let i = 0; i < 3; i++) give("ann");
    const plain = await fuseStones(db, "ann", ["", "", ""]);
    if (typeof plain === "string") throw new Error(plain);
    expect(plain.made.length).toBe(1);
    expect(await lodestonesOf(db, "ann")).toEqual([{ stone: plain.made, qty: 1 }]);
    // Three different ones: two of what they carried.
    sql.prepare("DELETE FROM consumables WHERE player_id = 'ann'").run();
    give("ann", ["hardy"]);
    give("ann", ["swift"]);
    give("ann", ["tangled"]);
    const two = await fuseStones(db, "ann", ["hardy", "swift", "tangled"]);
    if (typeof two === "string") throw new Error(two);
    expect(two.made.length).toBe(2);
    expect(two.made.every((id) => ["hardy", "swift", "tangled"].includes(id))).toBe(true);
    expect(await lodestonesOf(db, "ann")).toEqual([{ stone: two.made, qty: 1 }]);
  });

  it("fuses nothing it is not given three of in the pack, and uses nothing up when it does not", async () => {
    give("ann", ["hardy"]);
    give("ann", ["hardy"]);
    give("ann");
    expect(await fuseStones(db, "ann", ["hardy", "hardy", "hardy"])).toMatch(/no longer have/);
    expect(await fuseStones(db, "ann", ["hardy", "hardy", ""])).toMatch(/same number/);
    expect(await fuseStones(db, "ann", ["hardy", "hardy"])).toMatch(/takes 3/);
    expect(await fuseStones(db, "ann", ["hardy", "hardy", "rainy"])).toMatch(/no lodestone/);
    expect(await fuseStones(db, "ann", "hardy")).toMatch(/takes 3/);
    // Bo's are not Ann's.
    for (let i = 0; i < 3; i++) give("bo", ["swift"]);
    expect(await fuseStones(db, "ann", ["swift", "swift", "swift"])).toMatch(/no longer have/);
    expect(await count("ann")).toBe(3);
    expect(await count("bo")).toBe(3);
  });

  it("attunes a stone to one more thing, for gold and what that thing is made of", async () => {
    give("ann", ["swift"]);
    const cost = attuneCost(["swift"], "hardy");
    // Not without the gold and the material.
    sql.prepare("UPDATE characters SET gold = 0 WHERE player_id = 'ann'").run();
    expect(await attuneStone(db, "ann", "swift", "hardy")).toMatch(/no longer have/);
    sql.prepare("UPDATE characters SET gold = ? WHERE player_id = 'ann'").run(cost.gold + 3);
    expect(await attuneStone(db, "ann", "swift", "hardy")).toMatch(/no longer have/);
    for (const [kind, qty] of Object.entries(cost.resources)) hand("ann", kind, qty! + 1);
    expect(await attuneStone(db, "ann", "swift", "hardy")).toEqual({ made: ["hardy", "swift"] });
    expect(await lodestonesOf(db, "ann")).toEqual([{ stone: ["hardy", "swift"], qty: 1 }]);
    expect(gold("ann")).toBe(3);
    expect(sql.prepare("SELECT qty FROM resources WHERE player_id = 'ann' AND kind = 'fur'").get()).toEqual({ qty: 1 });
    // What cannot be: twice, a stone not held, nonsense.
    expect(await attuneStone(db, "ann", "hardy+swift", "hardy")).toMatch(/already/);
    expect(await attuneStone(db, "ann", "tangled", "hardy")).toMatch(/no longer have/);
    expect(await attuneStone(db, "ann", "hardy+swift", "rainy")).toMatch(/no such thing/);
    expect(await count("ann")).toBe(1);
  });

  it("rerolls what a stone carries for gold: as many things, and not the same", async () => {
    give("ann", ["hardy", "swift"]);
    sql.prepare("UPDATE characters SET gold = ? WHERE player_id = 'ann'").run(rerollCost(["hardy", "swift"]) + 5);
    const done = await rerollStone(db, "ann", "hardy+swift");
    if (typeof done === "string") throw new Error(done);
    expect(done.made.length).toBe(2);
    expect(done.made).not.toEqual(["hardy", "swift"]);
    expect(await lodestonesOf(db, "ann")).toEqual([{ stone: done.made, qty: 1 }]);
    expect(gold("ann")).toBe(5);
    // Not without the gold; and a plain one has nothing to change.
    expect(await rerollStone(db, "ann", done.made)).toMatch(/no longer have/);
    give("ann");
    expect(await rerollStone(db, "ann", "")).toMatch(/nothing to change/);
    expect(await count("ann")).toBe(2);
  });
});

describe("ranks and boons", () => {
  const hand = (who: string, kind: string, qty: number) => sql.prepare("INSERT INTO resources (player_id, kind, qty) VALUES (?, ?, ?) ON CONFLICT(player_id, kind) DO UPDATE SET qty = qty + excluded.qty").run(who, kind, qty);

  it("tempers one thing a stone carries up a rank, for gold, its material and gems; and no further than it goes", async () => {
    give("ann", ["hardy", "swift"]);
    const cost = temperCost("hardy");
    sql.prepare("UPDATE characters SET gold = ? WHERE player_id = 'ann'").run(cost.gold);
    // Not without the gems.
    for (const [kind, qty] of Object.entries(cost.resources)) if (kind !== "gem") hand("ann", kind, qty!);
    expect(await temperStone(db, "ann", "hardy+swift", "hardy")).toMatch(/no longer have/);
    hand("ann", "gem", cost.resources.gem!);
    expect(await temperStone(db, "ann", "hardy+swift", "hardy")).toEqual({ made: ["hardy2", "swift"] });
    expect(await lodestonesOf(db, "ann")).toEqual([{ stone: ["hardy2", "swift"], qty: 1 }]);
    expect((sql.prepare("SELECT gold FROM characters WHERE player_id = 'ann'").get() as { gold: number }).gold).toBe(0);
    // What cannot be: a thing it does not carry, the rank it used to have, a stone not held.
    expect(await temperStone(db, "ann", "hardy2+swift", "savage")).toMatch(/does not carry/);
    expect(await temperStone(db, "ann", "hardy2+swift", "hardy")).toMatch(/does not carry/);
    expect(await temperStone(db, "ann", "hardy+swift", "hardy")).toMatch(/no longer have/);
    give("ann", ["swift2"]);
    expect(await temperStone(db, "ann", "swift2", "swift2")).toMatch(/as much of it/);
  });

  it("a stone's ranks and boons go onto the map made with it, over the place's own", async () => {
    const node = first();
    give("ann", ["hardy2", "gilded"]);
    const a = await openNode(db, CREW, "ann", node, 2, "gilded+hardy2");
    if ("error" in a) throw new Error(a.error);
    const options = JSON.parse((await getZoneRow(db, a.code))!.options_json) as ZoneOptions;
    expect(options.mods).toEqual(["hardy2", "gilded"]);
    expect(modsOf(options)).toMatchObject({ hp: 1.65, gold: 0.33 });
    expect((await chartFor(db, CREW)).nodes.find((n) => n.id === node)!.stone).toEqual(["hardy2", "gilded"]);
  });
});
