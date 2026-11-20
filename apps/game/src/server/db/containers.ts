// What a chest, crate or cupboard in a hut holds, in D1: how full it is,
// and materials and gear moved between it and the owner's pack.

import { FURNISHINGS, RESOURCE_KINDS, RESOURCE_LABEL, addedSlots, carryProblem, itemCells, storageFree } from "@gantt-quest/world";
import { CARRIED_SQL, CELLS_SQL, STACKS_SQL, carryState, keepStatement } from "./inventory";
import { getItem, type InventoryRow } from "./rows";

// ---------- containers: what a chest, crate or cupboard holds ----------

/** How many squares of a container are filled: one per decoration in it, gear by its footprint, and one per stack of material. */
export async function containerUsed(db: D1Database, playerId: string, containerId: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM furnishings WHERE in_id = ?1 AND player_id = ?2)
            + (SELECT COALESCE(SUM(${CELLS_SQL}), 0) FROM inventory WHERE stored_in = ?1 AND player_id = ?2)
            + (SELECT ${STACKS_SQL} FROM stash WHERE furnishing_id = ?1 AND player_id = ?2 AND qty > 0) AS used`,
    )
    .bind(containerId, playerId)
    .first<{ used: number }>();
  return row?.used ?? 0;
}

/** The owner's container `containerId`, or null if it is not theirs or holds nothing. */
async function ownContainer(db: D1Database, playerId: string, containerId: number): Promise<{ defId: string } | null> {
  if (!Number.isSafeInteger(containerId)) return null;
  const row = await db.prepare("SELECT def_id AS defId FROM furnishings WHERE id = ? AND player_id = ?").bind(containerId, playerId).first<{ defId: string }>();
  return row && FURNISHINGS[row.defId]?.storage ? row : null;
}

/**
 * Move materials between the owner's pool and a container: a positive `qty`
 * puts that many in, a negative one takes them out. Returns an error, or null.
 * Each side is only changed if the other had them.
 */
export async function stashMaterial(db: D1Database, playerId: string, containerId: number, kind: unknown, qty: unknown): Promise<string | null> {
  const k = RESOURCE_KINDS.find((r) => r === kind);
  if (!k) return "That is not a material.";
  if (typeof qty !== "number" || !Number.isSafeInteger(qty) || qty === 0) return "Move at least one.";
  const box = await ownContainer(db, playerId, containerId);
  if (!box) return "That does not hold anything.";
  const n = Math.abs(qty);
  if (qty > 0) {
    const [has, used] = await Promise.all([
      db.prepare("SELECT qty FROM stash WHERE furnishing_id = ? AND kind = ? AND qty > 0").bind(containerId, k).first<{ qty: number }>(),
      containerUsed(db, playerId, containerId),
    ]);
    if (addedSlots(has?.qty ?? 0, n) > storageFree(box.defId, used)) return "It is full.";
    const res = await db.batch([
      db.prepare("UPDATE resources SET qty = qty - ?3 WHERE player_id = ?1 AND kind = ?2 AND qty >= ?3").bind(playerId, k, n),
      db
        .prepare("INSERT INTO stash (furnishing_id, player_id, kind, qty) SELECT ?1, ?2, ?3, ?4 WHERE changes() > 0 ON CONFLICT(furnishing_id, kind) DO UPDATE SET qty = qty + excluded.qty")
        .bind(containerId, playerId, k, n),
    ]);
    return res[0].meta.changes > 0 ? null : `You do not have ${n} ${RESOURCE_LABEL[k].toLowerCase()}.`;
  }
  // Coming out, the stacks have to fit in the pack.
  const [carry, held] = await Promise.all([
    carryState(db, playerId),
    db.prepare("SELECT qty FROM resources WHERE player_id = ? AND kind = ?").bind(playerId, k).first<{ qty: number }>(),
  ]);
  const full = carry && carryProblem(carry, addedSlots(held?.qty ?? 0, n));
  if (full) return full;
  const res = await db.batch([
    db.prepare("UPDATE stash SET qty = qty - ?4 WHERE furnishing_id = ?1 AND player_id = ?2 AND kind = ?3 AND qty >= ?4").bind(containerId, playerId, k, n),
    db
      .prepare("INSERT INTO resources (player_id, kind, qty) SELECT ?1, ?2, ?3 WHERE changes() > 0 ON CONFLICT(player_id, kind) DO UPDATE SET qty = qty + excluded.qty")
      .bind(playerId, k, n),
    db.prepare("DELETE FROM stash WHERE furnishing_id = ? AND qty <= 0").bind(containerId),
  ]);
  return res[0].meta.changes > 0 ? null : `There are not ${n} ${RESOURCE_LABEL[k].toLowerCase()} in there.`;
}

/** Put a piece of gear from the bag into a container. Worn gear has to be taken off first. Returns an error, or null. */
export async function stowGear(db: D1Database, playerId: string, containerId: number, itemId: number): Promise<string | null> {
  const [box, item, used] = await Promise.all([ownContainer(db, playerId, containerId), getItem(db, playerId, itemId), containerUsed(db, playerId, containerId)]);
  if (!box) return "That does not hold anything.";
  if (!item) return "No such item.";
  if (item.equipped) return "Take it off first.";
  if (storageFree(box.defId, used) < itemCells(item)) return "It is too full for that.";
  // The room in the container is checked again inside the write, as for "Send to storage".
  const res = await keepStatement(db, playerId, itemId, containerId, FURNISHINGS[box.defId].storage!).run();
  return res.meta.changes > 0 ? null : "It filled up, or that item moved. Try again.";
}

/**
 * Take a piece of gear out of whatever container holds it, back into the
 * pack. Refused if the pack is full; the count is checked again inside the
 * write. The route only calls this for a player standing in their own hut.
 */
export async function unstowGear(db: D1Database, playerId: string, itemId: number): Promise<string | null> {
  if (!Number.isSafeInteger(itemId)) return "No such item.";
  const [carry, row] = await Promise.all([carryState(db, playerId), db.prepare("SELECT slot, ref FROM inventory WHERE id = ? AND player_id = ?").bind(itemId, playerId).first<Pick<InventoryRow, "slot" | "ref">>()]);
  if (!carry) return "Create a character first.";
  const cells = row ? itemCells(row) : 1;
  const full = carryProblem(carry, cells);
  if (full) return full;
  const res = await db
    .prepare(`UPDATE inventory SET stored_in = NULL WHERE id = ?2 AND player_id = ?1 AND stored_in IS NOT NULL AND ${CARRIED_SQL} + ${CELLS_SQL} <= ?3`)
    .bind(playerId, itemId, carry.limit)
    .run();
  if (res.meta.changes > 0) return null;
  const fresh = await carryState(db, playerId);
  return (fresh && carryProblem(fresh, cells)) || "That is not in a container.";
}
