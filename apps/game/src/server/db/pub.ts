// The pub's menu in D1: ordering a meal. (The `pub_buffs` table, which kept
// what a hero had eaten and drunk for their next voyage, is no longer read
// or written.)

import { gatherDay, pubItem } from "@gantt-quest/world";

// ---------- the pub ----------

/**
 * Buy a meal off the pub's menu. The price comes from the menu, never the
 * caller. Gold is taken and the outing given back together: the second
 * statement only writes if the first one found the gold.
 */
export async function orderAtPub(db: D1Database, playerId: string, itemId: string): Promise<string | { rested: boolean }> {
  const item = pubItem(itemId);
  if (!item) return "That is not on the menu.";
  const today = gatherDay(Date.now());
  const [paid, rest] = await db.batch([
    db.prepare("UPDATE characters SET gold = gold - ?1 WHERE player_id = ?2 AND status = 'active' AND gold >= ?1").bind(item.price, playerId),
    // A meal gives back one of today's gathering outings, once a day, and only if one has been used.
    db
      .prepare("UPDATE gathering SET used = used - 1, meal_day = ?2 WHERE player_id = ?1 AND changes() > 0 AND day = ?2 AND used > 0 AND (meal_day IS NULL OR meal_day <> ?2)")
      .bind(playerId, today),
  ]);
  return paid.meta.changes > 0 ? { rested: rest.meta.changes > 0 } : "You cannot afford that.";
}
