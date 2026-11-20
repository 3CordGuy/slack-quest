// The dev toolbox's seeding (src/server/dev.ts), against a real SQLite
// database with the game's migrations applied (the stand-in for D1 in d1.ts).

import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { CARRY_BASE, GEAR_BASES, STACK_MAX, WEAPONS, itemCells, itemOfRef, makeRng, slotOfRef } from "@gantt-quest/world";
import { carryState } from "../src/server/db";
import { SEED_MAX, isDev, seedGear, seedGold, seedMaterial } from "../src/server/dev";
import { addHero, openDb, type Row } from "./d1";

let sql: DatabaseSync;
let db: D1Database;

const one = <T = Row>(text: string, ...args: (string | number)[]) => sql.prepare(text).get(...args) as T;
const gold = () => one<{ gold: number }>("SELECT gold FROM characters WHERE player_id = 'ann'").gold;
const pack = () => sql.prepare("SELECT * FROM inventory WHERE player_id = 'ann' AND equipped = 0 AND stored_in IS NULL ORDER BY id").all() as Row[];
const held = (kind: string) => one<{ qty: number } | undefined>("SELECT qty FROM resources WHERE player_id = 'ann' AND kind = ?", kind)?.qty ?? 0;
/** Fill the pack with rings, a square each. */
function fillPack(n: number) {
  const item = sql.prepare("INSERT INTO inventory (player_id, kind, ref, name, rarity, slot, equipped, created_at) VALUES ('ann', 'trinket', 'ring', ?, 'common', 'ring', 0, ?)");
  for (let i = 0; i < n; i++) item.run(`Ring ${i}`, Date.now());
}

beforeEach(() => {
  ({ sql, db } = openDb());
  const at = Date.now();
  addHero(sql, { id: "ann", name: "Ann", level: 4, gold: 50, at });
  // Someone who has signed in but not made a hero yet.
  sql.prepare("INSERT INTO players (id, name, created_at) VALUES ('new', 'New', ?)").run(at);
});

describe("the dev toolbox is for development deployments", () => {
  it("only where ENVIRONMENT is dev", () => {
    expect(isDev({ ENVIRONMENT: "dev" })).toBe(true);
    expect(isDev({ ENVIRONMENT: "production" })).toBe(false);
    expect(isDev({})).toBe(false);
  });
});

describe("seeding gold", () => {
  it("adds to the purse and says what it holds", async () => {
    expect(await seedGold(db, "ann", 1000)).toEqual({ gold: 1050 });
    expect(gold()).toBe(1050);
  });

  it("takes gold with a negative amount, never below nothing", async () => {
    expect(await seedGold(db, "ann", -20)).toEqual({ gold: 30 });
    expect(await seedGold(db, "ann", -500)).toEqual({ gold: 0 });
  });

  it("refuses anything but a whole amount within the limit", async () => {
    for (const bad of [0, 1.5, "100", null, undefined, Number.NaN, SEED_MAX + 1, -SEED_MAX - 1]) expect(typeof (await seedGold(db, "ann", bad))).toBe("string");
    expect(gold()).toBe(50);
  });

  it("needs a hero", async () => {
    expect(await seedGold(db, "new", 100)).toMatch(/character/);
  });
});

describe("seeding gear", () => {
  it("puts the chosen weapon in the pack, unworn, at the hero's level unless told", async () => {
    const got = await seedGear(db, "ann", { ref: "greatsword", rarity: "epic" });
    if (typeof got === "string") throw new Error(got);
    expect(got.item).toMatchObject({ kind: "weapon", ref: "greatsword", rarity: "epic", slot: "main_hand", name: `Masterwork ${WEAPONS.greatsword.name}` });
    // An epic made at level 4 asks for level 3; one made at level 9 asks for 8.
    expect(got.item.levelReq).toBe(3);
    expect(pack()).toHaveLength(1);
    expect(pack()[0]).toMatchObject({ ref: "greatsword", rarity: "epic", equipped: 0, level_req: 3 });
    const higher = await seedGear(db, "ann", { ref: "greatsword", rarity: "epic", level: 9 });
    expect(typeof higher === "string" ? higher : higher.item.levelReq).toBe(8);
  });

  it("makes armor and trinkets from their bases, with the stat points of their rarity", async () => {
    const got = await seedGear(db, "ann", { ref: "hauberk", rarity: "legendary", level: 1 });
    if (typeof got === "string") throw new Error(got);
    expect(got.item).toMatchObject({ kind: "armor", slot: "body", rarity: "legendary" });
    expect(Object.values(got.item.statBonus).reduce((a, n) => a + (n ?? 0), 0)).toBe(4);
    const ring = await seedGear(db, "ann", { ref: "ring" });
    expect(typeof ring === "string" ? ring : ring.item).toMatchObject({ kind: "trinket", slot: "ring", rarity: "common", power: 0 });
  });

  it("refuses what is not gear, a rarity or a level", async () => {
    expect(await seedGear(db, "ann", { ref: "nonsense" })).toMatch(/No such piece/);
    expect(await seedGear(db, "ann", {})).toMatch(/No such piece/);
    expect(await seedGear(db, "ann", { ref: "mace", rarity: "shiny" })).toMatch(/rarity/);
    expect(await seedGear(db, "ann", { ref: "mace", level: 0 })).toMatch(/level/);
    expect(await seedGear(db, "ann", { ref: "mace", level: 2.5 })).toMatch(/level/);
    expect(pack()).toHaveLength(0);
  });

  it("is refused when the pack has no room for it, like a purchase", async () => {
    fillPack(CARRY_BASE - 1);
    expect(await seedGear(db, "ann", { ref: "mace" })).toMatch(/room|full/);
    expect(await seedGear(db, "ann", { ref: "ring" })).toHaveProperty("item");
    expect((await carryState(db, "ann"))!.carried).toBe(CARRY_BASE);
  });

  it("needs a hero", async () => {
    expect(await seedGear(db, "new", { ref: "mace" })).toMatch(/character/);
  });
});

describe("seeding materials", () => {
  it("adds to the pack and takes away again", async () => {
    expect(await seedMaterial(db, "ann", "wood", 150)).toEqual({ kind: "wood", qty: 150 });
    expect(await seedMaterial(db, "ann", "wood", -50)).toEqual({ kind: "wood", qty: 100 });
    expect(await seedMaterial(db, "ann", "wood", -500)).toEqual({ kind: "wood", qty: 0 });
    expect(held("wood")).toBe(0);
  });

  it("is refused when the new stacks would not fit", async () => {
    fillPack(CARRY_BASE - 1);
    expect(await seedMaterial(db, "ann", "stone", STACK_MAX + 1)).toMatch(/room|full/);
    expect(await seedMaterial(db, "ann", "stone", STACK_MAX)).toEqual({ kind: "stone", qty: STACK_MAX });
    // The stack is full: one more would start another square.
    expect(await seedMaterial(db, "ann", "stone", 1)).toMatch(/room|full/);
  });

  it("refuses what is not a material or a whole amount", async () => {
    expect(await seedMaterial(db, "ann", "gold", 5)).toMatch(/No such material/);
    for (const bad of [0, 0.5, "3", SEED_MAX + 1]) expect(typeof (await seedMaterial(db, "ann", "wood", bad))).toBe("string");
    expect(await seedMaterial(db, "ann", "wood", -1)).toMatch(/no wood/);
    expect(await seedMaterial(db, "new", "wood", 5)).toMatch(/character/);
  });
});

describe("gear by its ref", () => {
  it("covers every weapon and every base, each in its own slot", () => {
    for (const ref of [...Object.keys(WEAPONS), ...GEAR_BASES.map((b) => b.ref)]) {
      const item = itemOfRef(makeRng(7), "qa_paladin", ref, "rare", 5);
      expect(item, ref).toBeDefined();
      expect(item!.ref).toBe(ref);
      expect(item!.slot).toBe(slotOfRef(ref));
      expect(itemCells(item!)).toBeGreaterThan(0);
    }
    expect(itemOfRef(makeRng(7), "qa_paladin", "toString", "rare", 5)).toBeUndefined();
  });
});
