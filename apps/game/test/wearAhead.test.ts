// Gear put on or taken off in the sea bag is shown before the server answers (client/wearAhead.ts). Here the
// rule the bag shows it by is held against the server's own (equipItem and unequipItem, on a real SQLite
// database with the game's migrations): after any run of changes the two agree on what is worn and what is
// hidden. Also covered: a refused change goes back when it comes off the list, and which look is drawn for
// your own hero while the room they stand in has yet to hear.

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { makeRng, outfitKey, outfitOf, type ItemDef, type Outfit } from "@gantt-quest/world";
import { equipItem, getInventory, insertItem, setGearHidden, unequipItem } from "../src/server/db";
import { LOOK_HOLD_MS, lookToDraw, wornAhead, type LookAhead, type WearChange } from "../src/client/wearAhead";

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

const piece = (ref: string, slot: ItemDef["slot"], extra: Partial<ItemDef> = {}): ItemDef => ({ kind: "armor", ref, name: ref, rarity: "common", slot, power: 1, statBonus: {}, levelReq: 1, icon: ref, ...extra });
/** What the pack says of each piece, as the bag compares it: worn or not, hidden or not. */
const state = (rows: { id: number; equipped: number; hidden?: number }[]) => rows.map((r) => [r.id, r.equipped ? 1 : 0, r.hidden ? 1 : 0]);

beforeEach(async () => {
  sql = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) sql.exec(readFileSync(new URL(file, dir), "utf8"));
  db = { prepare: (text: string) => new Stmt(sql, text), batch: async (stmts: Stmt[]) => stmts.map((s) => s.exec()) } as unknown as D1Database;
  const at = Date.now();
  sql.prepare("INSERT INTO players (id, name, created_at) VALUES ('ann', 'Ann', ?)").run(at);
  sql.prepare("INSERT INTO characters (player_id, name, class_id, status, level, str, int_stat, vit, agi, dex, gold, created_at) VALUES ('ann', 'Ann', 'qa_paladin', 'active', 3, 9, 4, 9, 4, 4, 100, ?)").run(at);
  // Two helms (one worn, and hidden), two pairs of boots (neither worn), a coat (worn), and a helm above her level.
  for (const [item, worn] of [[piece("hat", "helmet"), true], [piece("helm", "helmet"), false], [piece("shoes", "boots"), false], [piece("seaboots", "boots"), false], [piece("coat", "body"), true], [piece("crown", "helmet", { levelReq: 9 }), false]] as const) {
    await insertItem(db, "ann", item, worn).run();
  }
  const hat = (await getInventory(db, "ann")).find((r) => r.ref === "hat")!;
  expect(await setGearHidden(db, "ann", hat.id, true)).toBeNull();
});

describe("gear shown worn before the server answers", () => {
  it("agrees with the server after any run of putting on and taking off", async () => {
    const rng = makeRng(20261117);
    const start = await getInventory(db, "ann");
    // Everything she is able to wear: the crown is above her level, and the bag never shows that one worn.
    const wearable = start.filter((r) => r.ref !== "crown");
    const changes: WearChange[] = [];
    for (let op = 1; op <= 80; op++) {
      const row = wearable[rng.int(0, wearable.length - 1)];
      const on = rng.int(0, 1) === 1;
      expect(on ? await equipItem(db, "ann", row.id) : await unequipItem(db, "ann", row.id)).toBeNull();
      changes.push({ op, itemId: row.id, on });
      // Every change so far, laid over the pack as it was first told, is the pack as the server now has it.
      expect(state(wornAhead(start, changes)), `after change ${op}`).toEqual(state(await getInventory(db, "ann")));
    }
    // And it was a real run: both helms and both pairs of boots were worn at some point.
    for (const ref of ["hat", "helm", "shoes", "seaboots"]) expect(changes.some((c) => c.on && wearable.find((r) => r.id === c.itemId)?.ref === ref), ref).toBe(true);
  });

  it("takes off what was in the slot, and shows a piece again that was hidden", async () => {
    const start = await getInventory(db, "ann");
    const [hat, helm] = [start.find((r) => r.ref === "hat")!, start.find((r) => r.ref === "helm")!];
    expect(hat.hidden).toBe(1);
    const swapped = wornAhead(start, [{ op: 1, itemId: helm.id, on: true }]);
    expect(swapped.find((r) => r.id === helm.id)).toMatchObject({ equipped: 1 });
    expect(swapped.find((r) => r.id === hat.id)).toMatchObject({ equipped: 0, hidden: 0 });
    // The coat, in another slot, is left as it was; and the list handed in is not changed.
    expect(swapped.find((r) => r.ref === "coat")).toBe(start.find((r) => r.ref === "coat"));
    expect(start.find((r) => r.id === hat.id)).toMatchObject({ equipped: 1, hidden: 1 });
    // Drawn, the helm is on her head where nothing was shown before.
    const drawn = (rows: typeof start) => outfitOf(rows.filter((r) => r.equipped).map((r) => ({ ...piece(r.ref, r.slot as ItemDef["slot"]), ...(r.hidden ? { hidden: true } : {}) })));
    expect(drawn(start).helmet).toBeUndefined();
    expect(drawn(swapped).helmet?.ref).toBe("helm");
  });

  it("goes back to what the pack says when a refused change comes off the list", async () => {
    const start = await getInventory(db, "ann");
    const crown = start.find((r) => r.ref === "crown")!;
    // The server refuses it, and the pack is as it was.
    expect(await equipItem(db, "ann", crown.id)).toBe("Requires level 9.");
    expect(state(await getInventory(db, "ann"))).toEqual(state(start));
    // Had the bag shown it, taking the change off the list is all it takes to put the crown back and the hat on again.
    const shown = wornAhead(start, [{ op: 1, itemId: crown.id, on: true }]);
    expect(shown.find((r) => r.id === crown.id)?.equipped).toBe(1);
    expect(wornAhead(start, [])).toBe(start);
    // And a change still on its way behind the refused one stands on its own.
    const boots = start.find((r) => r.ref === "seaboots")!;
    expect(await equipItem(db, "ann", boots.id)).toBeNull();
    expect(state(wornAhead(start, [{ op: 2, itemId: boots.id, on: true }]))).toEqual(state(await getInventory(db, "ann")));
  });

  it("leaves the pack alone for a piece that is not in it", async () => {
    const start = await getInventory(db, "ann");
    expect(wornAhead(start, [{ op: 1, itemId: 9999, on: true }])).toBe(start);
  });
});

describe("the look drawn for your own hero", () => {
  const look = (helmet: string | null): Outfit => (helmet ? { helmet: { icon: helmet, ref: helmet, rarity: "common" } } : {});
  const old = look("hat");
  const next = look("helm");
  /** The bag showing the helm, first shown while the room was telling the hat. */
  const ahead = (extra: Partial<LookAhead> = {}): LookAhead => ({ shown: next, settledAt: null, toldThen: outfitKey(old), ...extra });

  it("is the room's when the bag has shown nothing", () => {
    expect(lookToDraw(null, old, 0)).toEqual({ outfit: old, over: false });
  });

  it("is the bag's while a change is on its way, whatever the room tells", () => {
    expect(lookToDraw(ahead(), old, 0)).toEqual({ outfit: next, over: false });
    expect(lookToDraw(ahead(), next, 99_999)).toEqual({ outfit: next, over: false });
  });

  it("stays the bag's once the change is answered, until the room tells the same look", () => {
    const told = ahead({ settledAt: 1000, toldThen: outfitKey(old) });
    expect(lookToDraw(told, old, 1500)).toEqual({ outfit: next, over: false });
    expect(lookToDraw(told, next, 1500)).toEqual({ outfit: next, over: true });
  });

  it("gives way to the room after long enough, caught up or not", () => {
    const told = ahead({ settledAt: 1000, toldThen: outfitKey(old) });
    expect(lookToDraw(told, old, 1000 + LOOK_HOLD_MS - 1).over).toBe(false);
    expect(lookToDraw(told, old, 1000 + LOOK_HOLD_MS)).toEqual({ outfit: old, over: true });
  });

  it("does not take the room's old look for catching up after a piece is swapped and swapped straight back", () => {
    // Shown: the hat again. The room is still telling the hat it told all along, and has the helm to tell yet.
    const back = ahead({ shown: old, settledAt: 1000, toldThen: outfitKey(old) });
    expect(lookToDraw(back, old, 1200)).toEqual({ outfit: old, over: false });
    expect(lookToDraw(back, next, 1400)).toEqual({ outfit: old, over: false });
    expect(lookToDraw(back, old, 1000 + LOOK_HOLD_MS)).toEqual({ outfit: old, over: true });
  });
});
