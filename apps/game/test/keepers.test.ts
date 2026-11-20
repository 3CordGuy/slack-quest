// The keepers' shops against a real SQLite database with the game's migrations applied (the stand-in for D1 in
// d1.ts): brewing potions and flasks for the pack at the apothecary, buying from the smith and the apothecary,
// haggling with them, a meal at the pub, and the galley, which is only a room.

import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { APOTHECARY_PROJECT, CARRY_BASE, GALLEY_PROJECT, SHELF_DAILY, SHELF_PRICES, SMITHY_PROJECT, gatherDay, shelfKey, workKey } from "@gantt-quest/world";
import { consumablesOf } from "../src/server/consumables";
import { carryState, orderAtPub } from "../src/server/db";
import { apothecaryView, brewFlask, buyFromKeeper, galleyView, haggle, smithItem, smithyView } from "../src/server/workshops";
import { addHero, openDb } from "./d1";

let sql: DatabaseSync;
let db: D1Database;

const gold = () => (sql.prepare("SELECT gold FROM characters WHERE player_id = 'ann'").get() as { gold: number }).gold;
const setGold = (n: number) => sql.prepare("UPDATE characters SET gold = ? WHERE player_id = 'ann'").run(n);
const give = (kind: string, qty: number) => sql.prepare("INSERT INTO resources (player_id, kind, qty) VALUES ('ann', ?, ?) ON CONFLICT(player_id, kind) DO UPDATE SET qty = excluded.qty").run(kind, qty);
const holds = (kind: string) => (sql.prepare("SELECT qty FROM resources WHERE player_id = 'ann' AND kind = ?").get(kind) as { qty: number } | undefined)?.qty ?? 0;
const build = (project = APOTHECARY_PROJECT) => sql.prepare("INSERT INTO crew_projects (crew_id, project_id, built_at) VALUES ('CREWAA', ?, ?)").run(project, Date.now());

beforeEach(() => {
  ({ sql, db } = openDb());
  addHero(sql, { id: "ann", name: "Ann", crew: "CREWAA" });
});

describe("brewing for the pack", () => {
  it("turns what it takes into one more in the pack, each time, for as long as the materials last", async () => {
    build();
    give("herbs", 7);
    expect(await brewFlask(db, "ann", "healing")).not.toBeTypeOf("string");
    expect(await brewFlask(db, "ann", "healing")).not.toBeTypeOf("string");
    expect(await consumablesOf(db, "ann")).toEqual({ healing: 2 });
    expect(holds("herbs")).toBe(1);
    // A stack of them is one square of the pack, however many are in it.
    expect((await carryState(db, "ann"))!.carried).toBe(2);
    expect(await brewFlask(db, "ann", "healing")).toMatch(/3 herbs/);
    expect(await consumablesOf(db, "ann")).toEqual({ healing: 2 });
    expect((await apothecaryView(db, "ann")).carried).toEqual({ healing: 2 });
  });

  it("makes torches two at a time from a piece of wood and a fur", async () => {
    build();
    give("wood", 1);
    give("fur", 1);
    expect(await brewFlask(db, "ann", "torch")).not.toBeTypeOf("string");
    expect(await consumablesOf(db, "ann")).toEqual({ torch: 2 });
    expect(holds("wood")).toBe(0);
    expect(await brewFlask(db, "ann", "torch")).toMatch(/1 wood, 1 fur/);
  });

  it("needs the apothecary built, and makes only what there is a recipe for", async () => {
    give("fur", 5);
    expect(await brewFlask(db, "ann", "water")).toMatch(/not built/);
    build();
    expect(await brewFlask(db, "ann", "elixir")).toMatch(/does not make/);
    expect(await brewFlask(db, "ann", "water")).not.toBeTypeOf("string");
    expect(await consumablesOf(db, "ann")).toEqual({ water: 1 });
    expect(holds("fur")).toBe(4);
  });

  it("needs a free square of the pack for the first of a kind, and none for one more of a kind already carried", async () => {
    build();
    give("fur", 5);
    give("bone", 9);
    // Fill the pack to the brim with rings, less the two squares the materials take.
    const ring = sql.prepare("INSERT INTO inventory (player_id, kind, ref, name, rarity, slot, equipped, created_at) VALUES ('ann', 'trinket', 'ring', ?, 'common', 'ring', 0, ?)");
    for (let i = 0; i < CARRY_BASE - 3; i++) ring.run(`Ring ${i}`, Date.now());
    expect(await brewFlask(db, "ann", "water")).not.toBeTypeOf("string");
    expect((await carryState(db, "ann"))!.carried).toBe(CARRY_BASE);
    expect(await brewFlask(db, "ann", "oil")).toMatch(/pack is full/);
    expect(holds("bone")).toBe(9);
    expect(await brewFlask(db, "ann", "water")).not.toBeTypeOf("string");
    expect(await consumablesOf(db, "ann")).toEqual({ water: 2 });
  });
});

describe("the apothecary's shelf", () => {
  it("sells a flask ready-made for gold, a few of each a day", async () => {
    build();
    setGold(1000);
    const key = shelfKey("healing");
    for (let i = 0; i < SHELF_DAILY; i++) expect(await buyFromKeeper(db, "ann", "apothecary", key)).toEqual({ got: "Healing potion" });
    expect(gold()).toBe(1000 - SHELF_DAILY * SHELF_PRICES.healing);
    expect(await consumablesOf(db, "ann")).toEqual({ healing: SHELF_DAILY });
    expect(await buyFromKeeper(db, "ann", "apothecary", key)).toMatch(/all the healing potions/);
    expect(gold()).toBe(1000 - SHELF_DAILY * SHELF_PRICES.healing);
  });

  it("takes nothing without the gold, and sells nothing before the crew has built the place", async () => {
    setGold(1000);
    expect(await buyFromKeeper(db, "ann", "apothecary", shelfKey("fire"))).toMatch(/not built/);
    build();
    setGold(5);
    expect(await buyFromKeeper(db, "ann", "apothecary", shelfKey("fire"))).toMatch(/Not enough gold/);
    expect(await buyFromKeeper(db, "ann", "apothecary", "flask:elixir")).toMatch(/nothing like that/);
    expect(gold()).toBe(5);
  });
});

describe("haggling", () => {
  it("takes the asked share off for the rest of the day when the keeper agrees, and only one try a day", async () => {
    build();
    setGold(1000);
    const key = shelfKey("acid");
    const res = await haggle(db, "ann", "apothecary", key, "push", 0);
    expect(res).toMatchObject({ won: true, list: SHELF_PRICES.acid, price: Math.ceil(SHELF_PRICES.acid * 0.8) });
    const ware = (await apothecaryView(db, "ann")).wares.find((w) => w.key === key)!;
    expect(ware.price).toBe(Math.ceil(SHELF_PRICES.acid * 0.8));
    expect(await haggle(db, "ann", "apothecary", key, "nudge", 0)).toMatch(/had your say/);
    await buyFromKeeper(db, "ann", "apothecary", key);
    expect(gold()).toBe(1000 - Math.ceil(SHELF_PRICES.acid * 0.8));
  });

  it("keeps the price, and the no, when the keeper will not have it", async () => {
    build();
    const key = shelfKey("oil");
    expect(await haggle(db, "ann", "apothecary", key, "lowball", 99)).toMatchObject({ won: false, price: SHELF_PRICES.oil });
    expect(await haggle(db, "ann", "apothecary", key, "nudge", 0)).toMatch(/had your say/);
    expect((await apothecaryView(db, "ann")).wares.find((w) => w.key === key)!.price).toBe(SHELF_PRICES.oil);
  });

  it("knocks the gold off the smith's sharpening, and has nothing to talk down on armour", async () => {
    build(SMITHY_PROJECT);
    setGold(1000);
    give("iron", 10);
    give("copper", 10);
    const add = sql.prepare("INSERT INTO inventory (player_id, kind, ref, name, rarity, slot, equipped, created_at) VALUES ('ann', ?, ?, ?, 'common', ?, 0, ?)");
    const blade = Number(add.run("weapon", "mace", "Mace", "main_hand", Date.now()).lastInsertRowid);
    const coat = Number(add.run("armor", "plate", "Coat", "body", Date.now()).lastInsertRowid);
    expect(await haggle(db, "ann", "smithy", workKey(blade), "lowball", 0)).toMatchObject({ won: true, list: 40, price: 26 });
    expect((await smithyView(db, "ann")).items.find((i) => i.id === blade)!.cost!.gold).toBe(26);
    expect(await smithItem(db, "ann", blade)).not.toBeTypeOf("string");
    expect(gold()).toBe(1000 - 26);
    expect(await haggle(db, "ann", "smithy", workKey(coat), "nudge", 0)).toMatch(/not gold/);
  });

  it("sells from the smith's rack once each, at the haggled price", async () => {
    build(SMITHY_PROJECT);
    setGold(5000);
    const [first] = (await smithyView(db, "ann")).wares;
    expect(await haggle(db, "ann", "smithy", first.key, "nudge", 0)).toMatchObject({ won: true });
    const res = await buyFromKeeper(db, "ann", "smithy", first.key);
    expect(res).not.toBeTypeOf("string");
    expect(gold()).toBe(5000 - Math.ceil(first.list * 0.9));
    expect(await buyFromKeeper(db, "ann", "smithy", first.key)).toMatch(/Sold/);
  });

  it("refuses an ask that is not on the list, and a shop that is not there", async () => {
    build();
    expect(await haggle(db, "ann", "apothecary", shelfKey("fire"), "everything", 0)).toMatch(/Ask for what/);
    expect(await haggle(db, "ann", "pub", shelfKey("fire"), "nudge", 0)).toMatch(/nobody there/);
  });
});

describe("the galley", () => {
  it("is a room once it is built, with nothing to buy or haggle over", async () => {
    expect(await galleyView(db, "ann")).toEqual({ built: false });
    build(GALLEY_PROJECT);
    expect(await galleyView(db, "ann")).toEqual({ built: true });
    expect(await haggle(db, "ann", "galley", "dish:chowder", "nudge", 0)).toMatch(/nobody there/);
  });
});

describe("a meal at the pub", () => {
  const used = () => (sql.prepare("SELECT used FROM gathering WHERE player_id = 'ann'").get() as { used: number }).used;
  const out = (n: number) => sql.prepare("INSERT INTO gathering (player_id, day, used) VALUES ('ann', ?, ?)").run(gatherDay(Date.now()), n);

  it("costs the menu's price and gives back one of today's outings, once a day", async () => {
    setGold(100);
    out(3);
    expect(await orderAtPub(db, "ann", "stew")).toEqual({ rested: true });
    expect(gold()).toBe(88);
    expect(used()).toBe(2);
    // A second meal the same day is paid for, and gives nothing back.
    expect(await orderAtPub(db, "ann", "pie")).toEqual({ rested: false });
    expect(gold()).toBe(70);
    expect(used()).toBe(2);
  });

  it("gives nothing back to someone who has not been out, takes nothing without the gold, and sells no drink", async () => {
    setGold(100);
    out(0);
    expect(await orderAtPub(db, "ann", "stew")).toEqual({ rested: false });
    expect(gold()).toBe(88);
    expect(used()).toBe(0);
    sql.prepare("UPDATE gathering SET used = 2").run();
    setGold(5);
    expect(await orderAtPub(db, "ann", "stew")).toMatch(/cannot afford/);
    expect(gold()).toBe(5);
    expect(used()).toBe(2);
    expect(await orderAtPub(db, "ann", "ale")).toMatch(/not on the menu/);
    // Nothing is kept of what was eaten.
    expect(sql.prepare("SELECT COUNT(*) AS n FROM pub_buffs").get()).toEqual({ n: 0 });
  });
});
