// The finite pack and the storage chest, against a real SQLite database with
// the game's migrations applied (the same stand-in for D1 as trade.test.ts).

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { CARRY_BASE, type ItemDef } from "@gantt-quest/world";
import { applyGrant, buyShopItem, carryState, equipItem, getInventory, getShop, sellItem, storeItem, takeStoredItem } from "../src/server/db";
import { acceptTrade, proposeTrade } from "../src/server/trade";

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
/** Ann has Strength 2, so her pack holds CARRY_BASE + 2 = 5. */
const LIMIT = CARRY_BASE + 2;

const loot: ItemDef = { kind: "trinket", ref: "ring", name: "Sea Ring", rarity: "rare", slot: "ring", power: 0, statBonus: {}, levelReq: 1, icon: "ring" };
const grant = (item: ItemDef | null = loot) => applyGrant(db, "RUNA", "ann", { xp: 0, gold: 0, item });
const one = <T = Row>(text: string, ...args: (string | number)[]) => sql.prepare(text).get(...args) as T;
const carried = () => one<{ n: number }>("SELECT COUNT(*) AS n FROM inventory WHERE player_id = 'ann' AND equipped = 0 AND stored = 0").n;
const stored = () => one<{ n: number }>("SELECT COUNT(*) AS n FROM inventory WHERE player_id = 'ann' AND stored = 1").n;
const gold = (id = "ann") => one<{ gold: number }>("SELECT gold FROM characters WHERE player_id = ?", id).gold;
const packIds = () => (sql.prepare("SELECT id FROM inventory WHERE player_id = 'ann' AND equipped = 0 AND stored = 0 ORDER BY id").all() as { id: number }[]).map((r) => r.id);

function fillPack(n: number) {
  const item = sql.prepare("INSERT INTO inventory (player_id, kind, ref, name, rarity, slot, equipped, created_at) VALUES ('ann', 'trinket', 'ring', ?, 'common', 'ring', 0, ?)");
  for (let i = 0; i < n; i++) item.run(`Ring ${i}`, Date.now());
}
const buildShack = () => sql.prepare("INSERT INTO huts (player_id, tier, plot, bin_json) VALUES ('ann', 1, 0, NULL)").run();

beforeEach(() => {
  ({ sql, db } = openDb());
  const at = Date.now();
  for (const [id, name, str] of [["ann", "Ann", 2], ["bo", "Bo", 9]] as const) {
    sql.prepare("INSERT INTO players (id, name, created_at) VALUES (?, ?, ?)").run(id, name, at);
    sql.prepare("INSERT INTO characters (player_id, name, class_id, status, str, int_stat, vit, agi, dex, gold, created_at) VALUES (?, ?, 'qa_paladin', 'active', ?, 5, 5, 5, 5, 5000, ?)").run(id, name, str, at);
    sql.prepare("INSERT OR IGNORE INTO crews (id, name, created_by, created_at) VALUES ('CREWAA', 'Crew', ?, ?)").run(id, at);
    sql.prepare("INSERT INTO crew_members (crew_id, player_id, joined_at) VALUES ('CREWAA', ?, ?)").run(id, at);
  }
  // The voyage loot is earned on.
  sql.prepare("INSERT INTO runs (code, seed, status, created_by, crew_id, created_at, updated_at) VALUES ('RUNA', 's', 'overworld', 'ann', 'CREWAA', ?, ?)").run(at, at);
  // Ann wears a mace; worn gear does not count against the pack.
  sql.prepare("INSERT INTO inventory (player_id, kind, ref, name, rarity, slot, equipped, created_at) VALUES ('ann', 'weapon', 'mace', 'Mace', 'common', 'main_hand', 1, ?)").run(at);
});

describe("carryState", () => {
  it("counts only unequipped, carried items, and adds Strength from gear", async () => {
    fillPack(2);
    expect(await carryState(db, "ann")).toEqual({ carried: 2, limit: LIMIT, stored: 0, hasHome: false });
    sql.prepare("INSERT INTO inventory (player_id, kind, ref, name, rarity, slot, stat_bonus_json, equipped, created_at) VALUES ('ann', 'trinket', 'ring', 'Ring of Might', 'rare', 'ring', '{\"str\":3}', 1, 0)").run();
    expect((await carryState(db, "ann"))!.limit).toBe(LIMIT + 3);
  });

  it("knows a bought plot is not a home until its shack stands", async () => {
    sql.prepare("INSERT INTO huts (player_id, tier, plot, bin_json) VALUES ('ann', 1, 0, '{}')").run();
    expect((await carryState(db, "ann"))!.hasHome).toBe(false);
    sql.prepare("UPDATE huts SET bin_json = NULL WHERE player_id = 'ann'").run();
    expect((await carryState(db, "ann"))!.hasHome).toBe(true);
  });
});

describe("loot never goes missing", () => {
  it("lands in the pack while there is room", async () => {
    expect(await grant()).toBe("pack");
    expect(carried()).toBe(1);
  });

  it("goes to the chest at home when the pack is full", async () => {
    buildShack();
    fillPack(LIMIT);
    expect(await grant()).toBe("storage");
    expect(carried()).toBe(LIMIT);
    expect(stored()).toBe(1);
  });

  it("is carried over the limit when there is no home", async () => {
    fillPack(LIMIT);
    expect(await grant()).toBe("overfull");
    expect(carried()).toBe(LIMIT + 1);
  });

  it("says nothing about a grant with no item", async () => {
    expect(await grant(null)).toBeNull();
  });
});

describe("the market stall", () => {
  it("refuses a purchase that will not fit, and takes no gold", async () => {
    fillPack(LIMIT);
    const shop = await getShop(db, "ann");
    expect(await buyShopItem(db, "ann", shop!.entries[0].index)).toMatch(/pack is full/);
    expect(gold()).toBe(5000);
    expect(carried()).toBe(LIMIT);
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM shop_purchases").n).toBe(0);
  });

  it("sells while there is room", async () => {
    fillPack(LIMIT - 1);
    const shop = await getShop(db, "ann");
    expect(await buyShopItem(db, "ann", shop!.entries[0].index)).toBeNull();
    expect(carried()).toBe(LIMIT);
    expect(gold()).toBe(5000 - shop!.entries[0].price);
  });
});

describe("the storage chest", () => {
  it("is not there without a home", async () => {
    fillPack(1);
    expect(await storeItem(db, "ann", packIds()[0])).toMatch(/no storage yet/);
  });

  it("takes carried gear from anywhere, never worn gear", async () => {
    buildShack();
    fillPack(1);
    expect(await storeItem(db, "ann", packIds()[0])).toBeNull();
    expect(stored()).toBe(1);
    expect(await storeItem(db, "ann", 1)).toBe("Unequip it first.");
    // And what is stored is not in the inventory the hero carries.
    expect((await getInventory(db, "ann")).map((i) => i.name)).toEqual(["Mace"]);
  });

  it("gives back only while there is room", async () => {
    buildShack();
    fillPack(LIMIT);
    const [first] = packIds();
    await storeItem(db, "ann", first);
    fillPack(1);
    expect(await takeStoredItem(db, "ann", first)).toMatch(/pack is full/);
    expect(stored()).toBe(1);
    await storeItem(db, "ann", packIds()[0]);
    expect(await takeStoredItem(db, "ann", first)).toBeNull();
    expect(carried()).toBe(LIMIT);
  });

  it("will not sell, equip or take what is not there", async () => {
    buildShack();
    fillPack(1);
    const [id] = packIds();
    await storeItem(db, "ann", id);
    expect(await sellItem(db, "ann", id)).toMatch(/in storage/);
    expect(await equipItem(db, "ann", id)).toMatch(/in storage/);
    expect(await takeStoredItem(db, "bo", id)).toMatch(/not in your storage/);
    expect(await takeStoredItem(db, "ann", 1)).toMatch(/not in your storage/);
  });
});

describe("trades", () => {
  it("wait while the taker's pack is full, and go through once there is room", async () => {
    buildShack();
    fillPack(LIMIT);
    sql.prepare("INSERT INTO inventory (player_id, kind, ref, name, rarity, slot, equipped, created_at) VALUES ('bo', 'trinket', 'ring', 'Gift', 'common', 'ring', 0, 0)").run();
    const gift = one<{ id: number }>("SELECT id FROM inventory WHERE name = 'Gift'").id;
    const made = await proposeTrade(db, "bo", { to: "ann", give: { items: [gift] }, ask: {} }, null);
    if ("error" in made) throw new Error(made.error);
    const refused = await acceptTrade(db, "ann", made.id);
    expect("error" in refused && refused.error).toMatch(/pack is full/);
    expect(one<{ status: string }>("SELECT status FROM trades WHERE id = ?", made.id).status).toBe("open");
    await storeItem(db, "ann", packIds()[0]);
    expect(await acceptTrade(db, "ann", made.id)).toMatchObject({ ok: true });
    expect(one<{ player_id: string }>("SELECT player_id FROM inventory WHERE id = ?", gift).player_id).toBe("ann");
  });

  it("cannot hand over a stored item", async () => {
    buildShack();
    fillPack(1);
    const [id] = packIds();
    await storeItem(db, "ann", id);
    const made = await proposeTrade(db, "ann", { to: "bo", give: { items: [id] }, ask: {} }, null);
    expect("error" in made && made.error).toMatch(/in storage at home/);
  });
});
