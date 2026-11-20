// The finite pack and the storage chest, against a real SQLite database with
// the game's migrations applied (the stand-in for D1 in d1.ts).

import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { CARRY_BASE, FURNISHINGS, itemCells, GATHER_DAILY_OUTINGS, STORAGE_CHEST, gatherDay, type ItemDef } from "@gantt-quest/world";
import { applyZoneGrant, buyShopItem, carryState, craftFurnishing, equipItem, getInventory, getShop, sellItem, setAbilitySlot, stashMaterial, storeItem, stowGear, unstowGear } from "../src/server/db";
import { rest } from "../src/server/gather";
import { setPresence } from "../src/server/zones";
import { buyFromSalesman, getSalesman } from "../src/server/salesman";
import { acceptTrade, openTrade, setTradeSide } from "../src/server/trade";
import { addHero, openDb, type Row } from "./d1";

let sql: DatabaseSync;
let db: D1Database;
/** Every pack is the same grid. The rings these tests fill it with take a square each. */
const LIMIT = CARRY_BASE;

const loot: ItemDef = { kind: "trinket", ref: "ring", name: "Sea Ring", rarity: "rare", slot: "ring", power: 0, statBonus: {}, levelReq: 1, icon: "ring" };
/** What a map pays a hero who found `item` on it; says where the item went. */
const grant = async (item: ItemDef | null = loot) => (await applyZoneGrant(db, "ann", { xp: 0, resources: {}, gold: 0, item })).place;
const one = <T = Row>(text: string, ...args: (string | number)[]) => sql.prepare(text).get(...args) as T;
const carried = () => one<{ n: number }>("SELECT COUNT(*) AS n FROM inventory WHERE player_id = 'ann' AND equipped = 0 AND stored_in IS NULL").n;
const stored = () => one<{ n: number }>("SELECT COUNT(*) AS n FROM inventory WHERE player_id = 'ann' AND stored_in IS NOT NULL").n;
const gold = (id = "ann") => one<{ gold: number }>("SELECT gold FROM characters WHERE player_id = ?", id).gold;
const packIds = () => (sql.prepare("SELECT id FROM inventory WHERE player_id = 'ann' AND equipped = 0 AND stored_in IS NULL ORDER BY id").all() as { id: number }[]).map((r) => r.id);

function fillPack(n: number) {
  const item = sql.prepare("INSERT INTO inventory (player_id, kind, ref, name, rarity, slot, equipped, created_at) VALUES ('ann', 'trinket', 'ring', ?, 'common', 'ring', 0, ?)");
  for (let i = 0; i < n; i++) item.run(`Ring ${i}`, Date.now());
}
/** A built shack, with the free Storage Chest standing in it. Returns the chest's id. */
const CHEST_SLOTS = FURNISHINGS[STORAGE_CHEST].storage!;
function buildShack(): number {
  sql.prepare("INSERT INTO huts (player_id, tier, plot, bin_json) VALUES ('ann', 1, 0, NULL)").run();
  return Number(sql.prepare("INSERT INTO furnishings (player_id, def_id, label, q, r, created_at) VALUES ('ann', 'storage_chest', 'Storage Chest', 1, 1, 0)").run().lastInsertRowid);
}

beforeEach(() => {
  ({ sql, db } = openDb());
  const at = Date.now();
  for (const [id, name, str] of [["ann", "Ann", 2], ["bo", "Bo", 9]] as const) addHero(sql, { id, name, str, gold: 5000, crew: "CREWAA", at });
  // Ann wears a mace; worn gear does not count against the pack.
  sql.prepare("INSERT INTO inventory (player_id, kind, ref, name, rarity, slot, equipped, created_at) VALUES ('ann', 'weapon', 'mace', 'Mace', 'common', 'main_hand', 1, ?)").run(at);
});

describe("materials in the pack", () => {
  const give = (kind: string, qty: number) => sql.prepare("INSERT INTO resources (player_id, kind, qty) VALUES ('ann', ?, ?)").run(kind, qty);
  const held = (kind: string) => one<{ qty: number } | undefined>("SELECT qty FROM resources WHERE player_id = 'ann' AND kind = ?", kind)?.qty ?? 0;
  const inChest = (kind: string) => one<{ qty: number } | undefined>("SELECT SUM(qty) AS qty FROM stash WHERE player_id = 'ann' AND kind = ?", kind)?.qty ?? 0;

  it("fill a slot per stack of 99, beside the gear", async () => {
    fillPack(1);
    give("wood", 150);
    give("stone", 4);
    expect((await carryState(db, "ann"))!.carried).toBe(1 + 2 + 1);
  });

  it("take a chest slot per stack, and only come out while the pack has room", async () => {
    const chest = buildShack();
    give("wood", 120);
    expect(await stashMaterial(db, "ann", chest, "wood", 120)).toBeNull();
    expect(held("wood")).toBe(0);
    expect((await carryState(db, "ann"))!.room).toBe(CHEST_SLOTS - 2);
    fillPack(LIMIT);
    expect(await stashMaterial(db, "ann", chest, "wood", -10)).toMatch(/full/);
    expect(inChest("wood")).toBe(120);
  });

  it("are spent from the chests at home when the pack is short", async () => {
    const chest = buildShack();
    const [defId, def] = Object.entries(FURNISHINGS).find(([, f]) => f.recipe && Object.keys(f.recipe).length === 1 && !f.minTier)!;
    const [kind, qty] = Object.entries(def.recipe!)[0] as [string, number];
    sql.prepare("INSERT OR IGNORE INTO blueprints (player_id, blueprint_id) VALUES ('ann', ?)").run(defId);
    give(kind, 1);
    sql.prepare("INSERT INTO stash (furnishing_id, player_id, kind, qty) VALUES (?, 'ann', ?, ?)").run(chest, kind, qty + 5);
    expect(typeof (await craftFurnishing(db, "ann", defId))).toBe("object");
    expect(held(kind) + inChest(kind)).toBe(6);
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM furnishings WHERE player_id = 'ann' AND def_id = ?", defId).n).toBe(1);
  });
});

describe("carryState", () => {
  it("counts the squares of unequipped, carried items, by their footprints", async () => {
    fillPack(2);
    expect(await carryState(db, "ann")).toEqual({ carried: 2, limit: LIMIT, stored: 0, hasHome: false, room: 0 });
    // A coat is two squares by three; a greatsword two by four.
    sql.prepare("INSERT INTO inventory (player_id, kind, ref, name, rarity, slot, equipped, created_at) VALUES ('ann', 'armor', 'coat', 'Coat', 'common', 'body', 0, 0)").run();
    sql.prepare("INSERT INTO inventory (player_id, kind, ref, name, rarity, slot, equipped, created_at) VALUES ('ann', 'weapon', 'greatsword', 'Greatsword', 'common', 'main_hand', 0, 0)").run();
    expect((await carryState(db, "ann"))!.carried).toBe(2 + 6 + 8);
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

  it("is carried over the limit when every chest at home is full", async () => {
    const chest = buildShack();
    fillPack(LIMIT + CHEST_SLOTS);
    for (const id of packIds().slice(0, CHEST_SLOTS)) sql.prepare("UPDATE inventory SET stored_in = ? WHERE id = ?").run(chest, id);
    expect((await carryState(db, "ann"))!.room).toBe(0);
    expect(await grant()).toBe("overfull");
    expect(stored()).toBe(CHEST_SLOTS);
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

  it("sells while there is room for the thing's footprint", async () => {
    const shop = await getShop(db, "ann");
    const cells = itemCells(shop!.entries[0].item);
    fillPack(LIMIT - cells);
    expect(await buyShopItem(db, "ann", shop!.entries[0].index)).toBeNull();
    expect(carried()).toBe(LIMIT - cells + 1);
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

  it("gives back only while there is room in the pack", async () => {
    buildShack();
    fillPack(LIMIT);
    const [first] = packIds();
    await storeItem(db, "ann", first);
    fillPack(1);
    expect(await unstowGear(db, "ann", first)).toMatch(/pack is full/);
    expect(stored()).toBe(1);
    await storeItem(db, "ann", packIds()[0]);
    expect(await unstowGear(db, "ann", first)).toBeNull();
    expect(carried()).toBe(LIMIT);
  });

  it("goes into the free chest first, and refuses once every container is full", async () => {
    const chest = buildShack();
    const crate = Number(sql.prepare("INSERT INTO furnishings (player_id, def_id, label, created_at) VALUES ('ann', 'crate', 'Crate', 0)").run().lastInsertRowid);
    fillPack(CHEST_SLOTS + FURNISHINGS.crate.storage! + 1);
    await storeItem(db, "ann", packIds()[0]);
    expect(one<{ stored_in: number }>("SELECT stored_in FROM inventory WHERE stored_in IS NOT NULL").stored_in).toBe(chest);
    while (stored() < CHEST_SLOTS + FURNISHINGS.crate.storage!) expect(await storeItem(db, "ann", packIds()[0])).toBeNull();
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM inventory WHERE stored_in = ?", crate).n).toBe(FURNISHINGS.crate.storage!);
    expect(await storeItem(db, "ann", packIds()[0])).toMatch(/chest at home is full/);
    // A chosen container is checked too.
    expect(await stowGear(db, "ann", chest, packIds()[0])).toMatch(/full/);
  });

  it("counts gear by its footprint, as the pack does", async () => {
    const chest = buildShack();
    const coat = (name: string) =>
      Number(sql.prepare("INSERT INTO inventory (player_id, kind, ref, name, rarity, slot, equipped, created_at) VALUES ('ann', 'armor', 'coat', ?, 'common', 'body', 0, 0)").run(name).lastInsertRowid);
    // A coat is two squares by three.
    expect(await stowGear(db, "ann", chest, coat("Coat"))).toBeNull();
    expect((await carryState(db, "ann"))!.room).toBe(CHEST_SLOTS - 6);
    // With five squares left a second coat does not go in, from the hut or from afar; a ring does.
    fillPack(CHEST_SLOTS - 6 - 5);
    for (const id of packIds()) sql.prepare("UPDATE inventory SET stored_in = ? WHERE id = ?").run(chest, id);
    const second = coat("Second Coat");
    expect(await stowGear(db, "ann", chest, second)).toMatch(/full/);
    expect(await storeItem(db, "ann", second)).toMatch(/room for something that size/);
    fillPack(1);
    expect(await stowGear(db, "ann", chest, packIds().find((id) => id !== second)!)).toBeNull();
    expect((await carryState(db, "ann"))!.room).toBe(4);
  });

  it("will not sell, equip or take what is not there", async () => {
    buildShack();
    fillPack(1);
    const [id] = packIds();
    await storeItem(db, "ann", id);
    expect(await sellItem(db, "ann", id)).toMatch(/kept at home/);
    expect(await equipItem(db, "ann", id)).toMatch(/kept at home/);
    expect(await unstowGear(db, "bo", id)).toMatch(/not in a container/);
    expect(await unstowGear(db, "ann", 1)).toMatch(/not in a container/);
  });
});

describe("trades", () => {
  /** Bo opens the table with Ann and lays out `items`; both then try to accept. Returns what each acceptance said. */
  const give = async (items: number[]) => {
    const made = await openTrade(db, "bo", "ann");
    if ("error" in made) throw new Error(made.error);
    const laid = await setTradeSide(db, "bo", made.id, { items });
    if ("error" in laid) throw new Error(laid.error);
    const giver = await acceptTrade(db, "bo", made.id, laid.rev);
    return { id: made.id, rev: laid.rev, giver, said: await acceptTrade(db, "ann", made.id, laid.rev) };
  };

  it("wait while the taker's pack is full, and go through once there is room", async () => {
    buildShack();
    fillPack(LIMIT);
    sql.prepare("INSERT INTO inventory (player_id, kind, ref, name, rarity, slot, equipped, created_at) VALUES ('bo', 'trinket', 'ring', 'Gift', 'common', 'ring', 0, 0)").run();
    const gift = one<{ id: number }>("SELECT id FROM inventory WHERE name = 'Gift'").id;
    const { id, rev, giver, said } = await give([gift]);
    // Neither can accept a trade the pack has no room for: each is told whose pack it is.
    expect("error" in giver && giver.error).toMatch(/Ann's pack is full/);
    expect("error" in said && said.error).toMatch(/Your pack is full/);
    expect(one<{ status: string }>("SELECT status FROM trades WHERE id = ?", id).status).toBe("open");
    await storeItem(db, "ann", packIds()[0]);
    expect(await acceptTrade(db, "bo", id, rev)).toMatchObject({ ok: true, settled: false });
    expect(await acceptTrade(db, "ann", id, rev)).toMatchObject({ ok: true, settled: true });
    expect(one<{ player_id: string }>("SELECT player_id FROM inventory WHERE id = ?", gift).player_id).toBe("ann");
  });

  it("cannot hand over a stored item", async () => {
    buildShack();
    fillPack(1);
    const [id] = packIds();
    await storeItem(db, "ann", id);
    const made = await openTrade(db, "ann", "bo");
    if ("error" in made) throw new Error(made.error);
    const laid = await setTradeSide(db, "ann", made.id, { items: [id] });
    expect("error" in laid && laid.error).toMatch(/in storage at home/);
  });
});

describe("the pub's curio dealer", () => {
  it("will not sell gear into a full pack, and takes no gold", async () => {
    fillPack(LIMIT);
    const view = await getSalesman(db, "ann", "curio");
    if (typeof view === "string" || !view.here) throw new Error("no salesman");
    const gear = view.here.entries.find((e) => e.goods.kind === "item")!;
    expect(gear.problem).toMatch(/pack is full/);
    expect(await buyFromSalesman(db, "ann", gear.index, "curio")).toMatch(/pack is full/);
    expect(gold()).toBe(5000);
    expect(carried()).toBe(LIMIT);
    // Make room for its footprint (Ann has no home here, so drop rings rather than store them).
    const cells = gear.goods.kind === "item" ? itemCells(gear.goods.item) : 1;
    for (const id of packIds().slice(0, cells)) sql.prepare("DELETE FROM inventory WHERE id = ?").run(id);
    expect(await buyFromSalesman(db, "ann", gear.index, "curio")).toMatchObject({ got: { index: gear.index } });
    expect(carried()).toBe(LIMIT - cells + 1);
  });
});

// Resting in your bed (or from the hut's bar) is the same server call: the
// cooldown is decided here, whatever the client shows.
describe("resting at home", () => {
  it("gives every outing back, then refuses until the cooldown is over", async () => {
    buildShack();
    sql.prepare("INSERT INTO gathering (player_id, day, used) VALUES ('ann', ?, ?)").run(gatherDay(Date.now()), GATHER_DAILY_OUTINGS);
    const first = await rest(db, "ann", "hut");
    expect(typeof first).toBe("object");
    expect((first as { stamina: { left: number } }).stamina.left).toBe(GATHER_DAILY_OUTINGS);
    // Tired again straight away: still too soon.
    sql.prepare("UPDATE gathering SET used = 2 WHERE player_id = 'ann'").run();
    const again = await rest(db, "ann", "hut");
    expect(again).toMatch(/rest again|just rested/i);
    expect(one<{ used: number }>("SELECT used FROM gathering WHERE player_id = 'ann'").used).toBe(2);
  });
});

describe("class ability slots", () => {
  const pools = { qa_paladin: [{ id: "bash", level: 1 }, { id: "cleave", level: 1 }, { id: "block", level: 50 }] };
  const slots = () => one<{ ability_loadout: string }>("SELECT ability_loadout FROM characters WHERE player_id = 'ann'").ability_loadout;

  it("starts empty, then keeps what is slotted", async () => {
    expect(slots()).toBe("[]");
    expect(await setAbilitySlot(db, "ann", 0, "bash", pools)).toBeNull();
    expect(JSON.parse(slots())).toEqual(["bash", null, null]);
    expect(await setAbilitySlot(db, "ann", 2, "cleave", pools)).toBeNull();
    expect(JSON.parse(slots())).toEqual(["bash", null, "cleave"]);
  });

  it("trades places when an ability is moved to another slot, and empties a slot", async () => {
    await setAbilitySlot(db, "ann", 0, "bash", pools);
    await setAbilitySlot(db, "ann", 1, "bash", pools);
    expect(JSON.parse(slots())).toEqual([null, "bash", null]);
    expect(await setAbilitySlot(db, "ann", 1, null, pools)).toBeNull();
    expect(JSON.parse(slots())).toEqual([null, null, null]);
  });

  it("refuses what the class lacks, what the level has not opened, and a slot that is not there", async () => {
    expect(await setAbilitySlot(db, "ann", 0, "shock", pools)).toMatch(/class's abilities/);
    expect(await setAbilitySlot(db, "ann", 0, "block", pools)).toMatch(/level 50/);
    expect(await setAbilitySlot(db, "ann", 3, "bash", pools)).toMatch(/no such slot/);
    expect(slots()).toBe("[]");
  });

  it("is refused out on a zone, and allowed again back in the Harbor", async () => {
    await setPresence(db, "ann", "ZONEAA", false);
    expect(await setAbilitySlot(db, "ann", 0, "bash", pools)).toMatch(/only be changed in the Harbor/);
    expect(slots()).toBe("[]");
    sql.prepare("DELETE FROM zone_presence WHERE player_id = 'ann'").run();
    expect(await setAbilitySlot(db, "ann", 0, "bash", pools)).toBeNull();
  });
});
