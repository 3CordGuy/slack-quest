// The market stall in D1: gear and foraged materials sold to it, and the
// day's stock bought from it. (Furniture bought and sold there is with the
// rest of what a hut costs, in spending.ts.)

import { STALL_BUYS, carryProblem, itemCells, sellMaterialProblem, sellPrice, shopStock, type ResourceKind, type ShopEntry } from "@gantt-quest/world";
import { getCharacter } from "./characters";
import { getHut } from "./huts";
import { CARRIED_SQL, carryState, keptAtHome } from "./inventory";
import { getItem, now, paidItemStatement, rowToItem } from "./rows";

/** Sell an unequipped item to the market stall. Returns the gold paid, or an error message. */
export async function sellItem(db: D1Database, playerId: string, itemId: number): Promise<number | string> {
  const row = await getItem(db, playerId, itemId);
  if (!row) return (await keptAtHome(db, playerId, itemId)) ?? "No such item.";
  if (row.equipped) return "Unequip it first.";
  const gold = sellPrice(rowToItem(row));
  const res = await db.batch([
    db.prepare("DELETE FROM inventory WHERE id = ? AND player_id = ? AND equipped = 0 AND stored_in IS NULL").bind(itemId, playerId),
    db.prepare("UPDATE characters SET gold = gold + ? WHERE player_id = ? AND changes() > 0").bind(gold, playerId),
  ]);
  return res[0].meta.changes > 0 ? gold : "No such item.";
}

/**
 * Sell foraged materials to the market stall. Returns the gold paid, or an
 * error. The price is the catalogue's; the materials and the gold move in one
 * batch, and the gold only if the materials were there to take.
 */
export async function sellMaterial(db: D1Database, playerId: string, kind: unknown, qty: unknown): Promise<number | string> {
  const [c, hut] = await Promise.all([getCharacter(db, playerId), getHut(db, playerId)]);
  if (c?.status !== "active") return "Create a character first.";
  const problem = sellMaterialProblem(kind, qty, hut.resources);
  if (problem) return problem;
  const k = kind as ResourceKind;
  const n = qty as number;
  const gold = STALL_BUYS[k]! * n;
  const [taken] = await db.batch([
    db.prepare("UPDATE resources SET qty = qty - ?3 WHERE player_id = ?1 AND kind = ?2 AND qty >= ?3").bind(playerId, k, n),
    db.prepare("UPDATE characters SET gold = gold + ?2 WHERE player_id = ?1 AND status = 'active' AND changes() > 0").bind(playerId, gold),
  ]);
  return taken.meta.changes > 0 ? gold : "You no longer have that many.";
}

// ---------- the market stall ----------

const DAY_MS = 24 * 60 * 60_000;

export interface ShopView {
  /** Epoch ms when the stock next changes. */
  refreshAt: number;
  entries: (ShopEntry & { bought: boolean })[];
}

export async function getShop(db: D1Database, playerId: string): Promise<ShopView | null> {
  const c = await getCharacter(db, playerId);
  if (!c || c.status !== "active") return null;
  const day = Math.floor(now() / DAY_MS);
  const bought = await db.prepare("SELECT idx FROM shop_purchases WHERE player_id = ? AND day = ?").bind(playerId, day).all<{ idx: number }>();
  const taken = new Set(bought.results.map((r) => r.idx));
  return {
    refreshAt: (day + 1) * DAY_MS,
    entries: shopStock(`${playerId}|${day}`, c.class_id, c.level).map((e) => ({ ...e, bought: taken.has(e.index) })),
  };
}

/** Buy one entry of today's stock. The stock is re-derived here, so the client cannot name its own item or price. */
export async function buyShopItem(db: D1Database, playerId: string, index: number): Promise<string | null> {
  const [shop, c, carry] = await Promise.all([getShop(db, playerId), getCharacter(db, playerId), carryState(db, playerId)]);
  const entry = shop?.entries.find((e) => e.index === index);
  if (!shop || !c || !carry || !entry) return "The stall has nothing like that.";
  if (entry.bought) return "Already sold.";
  if (c.gold < entry.price) return "Not enough gold.";
  const cells = itemCells(entry.item);
  const full = carryProblem(carry, cells);
  if (full) return full;
  const day = Math.floor(now() / DAY_MS);
  try {
    // The first statement checks the gold and the room in the pack again and
    // records the purchase; each one after it runs only if the one before it
    // changed a row. The purchase row's primary key makes a double-buy fail
    // the whole batch.
    const res = await db.batch([
      db
        .prepare(`INSERT INTO shop_purchases (player_id, day, idx) SELECT ?1, ?2, ?3 WHERE (SELECT gold FROM characters WHERE player_id = ?1) >= ?4 AND ${CARRIED_SQL} + ?6 <= ?5`)
        .bind(playerId, day, index, entry.price, carry.limit, cells),
      db.prepare("UPDATE characters SET gold = gold - ?1 WHERE player_id = ?2 AND changes() > 0").bind(entry.price, playerId),
      paidItemStatement(db, playerId, entry.item),
    ]);
    if (res[2].meta.changes === 0) {
      // Gold or room went elsewhere between the check and the batch: nothing happened.
      const fresh = await carryState(db, playerId);
      return (fresh && carryProblem(fresh, cells)) || "Not enough gold.";
    }
  } catch {
    return "Already sold.";
  }
  return null;
}
