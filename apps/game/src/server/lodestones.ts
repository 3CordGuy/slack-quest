// Lodestones in D1 (packages/world/src/lodestone.ts): a hero's own, carried
// in the pack. They are kept with what there is to drink or throw (the
// `consumables` table: a kind and how many), each kind of stone its own
// kind of item, so they stack, take a square of the pack a stack, and are
// counted toward what the pack holds like anything else in it (carriedSql
// in db.ts). Nothing here reads them as something to drink or throw:
// `consumablesOf` passes over any kind it does not know.

import { PLAIN_STONE_COST, STONE_ITEM, addedSlots, stoneItem, stoneKey, stoneOfItem, type Lodestone } from "@gantt-quest/world";
import { carryState, packHasRoomSql, spendStatements } from "./db";

export interface HeldStone {
  stone: Lodestone;
  qty: number;
}

/** The lodestones in a hero's pack: each kind they hold and how many, the ones that carry most first. */
export async function lodestonesOf(db: D1Database, playerId: string): Promise<HeldStone[]> {
  const rows = await db
    .prepare("SELECT kind, qty FROM consumables WHERE player_id = ?1 AND qty > 0 AND (kind = ?2 OR kind LIKE ?3)")
    .bind(playerId, STONE_ITEM, `${STONE_ITEM}:%`)
    .all<{ kind: string; qty: number }>();
  return rows.results
    .flatMap((r) => {
      const stone = stoneOfItem(r.kind);
      return stone ? [{ stone, qty: r.qty }] : [];
    })
    .sort((a, b) => b.stone.length - a.stone.length || stoneKey(a.stone).localeCompare(stoneKey(b.stone)));
}

/** A statement that puts a lodestone in a hero's pack: one found in a bounty. */
export function gainStone(db: D1Database, playerId: string, stone: Lodestone): D1PreparedStatement {
  return db.prepare("INSERT INTO consumables (player_id, kind, qty) VALUES (?1, ?2, 1) ON CONFLICT(player_id, kind) DO UPDATE SET qty = qty + 1").bind(playerId, stoneItem(stone));
}

/** Take one lodestone out of a hero's pack. False if they hold none like it. */
export async function spendStone(db: D1Database, playerId: string, stone: Lodestone): Promise<boolean> {
  const res = await db.prepare("UPDATE consumables SET qty = qty - 1 WHERE player_id = ?1 AND kind = ?2 AND qty >= 1").bind(playerId, stoneItem(stone)).run();
  return res.meta.changes > 0;
}

/**
 * Cut a plain lodestone from stone and iron, into the pack. The materials are taken and the stone gained in
 * one batch, which checks again that the materials are there and (for the first of a stack, which takes a
 * square) that the pack has the room. Returns why not, or null once it is in the pack.
 */
export async function cutStone(db: D1Database, playerId: string): Promise<string | null> {
  const [carry, held] = await Promise.all([carryState(db, playerId), lodestonesOf(db, playerId)]);
  const plain = held.find((h) => h.stone.length === 0)?.qty ?? 0;
  const squares = addedSlots(plain, 1);
  const spend = spendStatements(db, playerId, 0, PLAIN_STONE_COST, squares > 0 && carry ? packHasRoomSql(carry.limit, squares) : "1");
  const res = await db.batch([
    ...spend,
    db.prepare("INSERT INTO consumables (player_id, kind, qty) SELECT ?1, ?2, 1 WHERE changes() > 0 ON CONFLICT(player_id, kind) DO UPDATE SET qty = qty + 1").bind(playerId, STONE_ITEM),
  ]);
  return res[spend.length].meta.changes > 0 ? null : "You have not the stone and iron for it, or the room in your pack.";
}
