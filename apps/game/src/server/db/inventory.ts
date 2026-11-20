// A hero's inventory in D1: what they wear and carry, how full the pack
// is and the SQL that counts it, sending a piece home to storage, and
// putting gear on and taking it off.

import {
  FURNISHINGS,
  SLOT_SIZE,
  STACK_MAX,
  STORAGE_CHEST,
  WEAPON_SIZE,
  addStats,
  canHide,
  carryLimit,
  equipProblem,
  itemCells,
  loadoutOf,
  storageFree,
  storeProblem,
  type CarryState,
} from "@gantt-quest/world";
import { getCharacter } from "./characters";
import { getItem, rowToItem, statsOf, type CharacterRow, type InventoryRow } from "./rows";

/** Everything the player has with them: worn gear and the pack. Not what is in storage at home. */
export async function getInventory(db: D1Database, playerId: string): Promise<InventoryRow[]> {
  // Gear kept in a hut's container is out of the bag until it is taken out.
  const res = await db.prepare("SELECT * FROM inventory WHERE player_id = ? AND stored_in IS NULL ORDER BY id").bind(playerId).all<InventoryRow>();
  return res.results;
}

// ---------- the pack, and storage in the hut's containers ----------

/** SQL for the slots a table's heaps of materials fill: STACK_MAX to a slot. */
export const STACKS_SQL = `COALESCE(SUM((qty + ${STACK_MAX - 1}) / ${STACK_MAX}), 0)`;
/** SQL for the squares an `inventory` row takes up in the pack: its footprint, from the rules' own tables. */
export const CELLS_SQL = (() => {
  const weapons = Object.entries(WEAPON_SIZE).map(([ref, f]) => `WHEN '${ref}' THEN ${f.w * f.h}`).join(" ");
  const slots = Object.entries(SLOT_SIZE).map(([slot, f]) => (slot === "main_hand" ? `WHEN 'main_hand' THEN CASE ref ${weapons} ELSE ${f.w * f.h} END` : `WHEN '${slot}' THEN ${f.w * f.h}`)).join(" ");
  return `(CASE slot ${slots} ELSE 1 END)`;
})();
/**
 * SQL for how many squares of the pack player `who` fills right now: unequipped gear not kept in a container, stacks of
 * materials, and stacks of what they carry to drink or throw. `who` appears three times: a caller that passes a bare `?` binds it three times.
 */
export const carriedSql = (who: string) => `((SELECT COALESCE(SUM(${CELLS_SQL}), 0) FROM inventory WHERE player_id = ${who} AND equipped = 0 AND stored_in IS NULL)
  + (SELECT ${STACKS_SQL} FROM resources WHERE player_id = ${who} AND qty > 0)
  + (SELECT ${STACKS_SQL} FROM consumables WHERE player_id = ${who} AND qty > 0))`;
export const CARRIED_SQL = carriedSql("?1");
/**
 * SQL, true while player ?1's pack has room for `cells` more squares under
 * `limit`. Both are inlined, so they must come from `carryState` and the
 * rules, never a request. For the `alsoIf` of `spendStatements`.
 */
export const packHasRoomSql = (limit: number, cells = 1) => `${CARRIED_SQL} + ${Math.max(1, Math.floor(cells))} <= ${Math.max(0, Math.floor(limit))}`;
/** SQL that is true if player ?1 has a hut standing, and so somewhere to keep things. */
const HAS_HOME_SQL = "EXISTS (SELECT 1 FROM huts WHERE player_id = ?1 AND plot IS NOT NULL AND bin_json IS NULL)";
/** SQL for the squares used in container `box` of player ?1: a square a decoration, gear by its footprint, a square a stack of material (as `containerUsed`). */
export const usedSql = (box: string) => `((SELECT COUNT(*) FROM furnishings WHERE in_id = ${box} AND player_id = ?1)
  + (SELECT COALESCE(SUM(${CELLS_SQL}), 0) FROM inventory WHERE stored_in = ${box} AND player_id = ?1)
  + (SELECT ${STACKS_SQL} FROM stash WHERE furnishing_id = ${box} AND player_id = ?1 AND qty > 0))`;

/**
 * The player's containers with a free square, best first: the free Storage
 * Chest, then whichever has the most room.
 */
export async function containersWithRoom(db: D1Database, playerId: string): Promise<{ id: number; defId: string; free: number }[]> {
  const rows = await db
    .prepare(`SELECT f.id, f.def_id AS defId, ${usedSql("f.id")} AS used FROM furnishings f WHERE f.player_id = ?1`)
    .bind(playerId)
    .all<{ id: number; defId: string; used: number }>();
  return rows.results
    .filter((r) => FURNISHINGS[r.defId]?.storage)
    .map((r) => ({ id: r.id, defId: r.defId, free: storageFree(r.defId, r.used) }))
    .filter((r) => r.free > 0)
    .sort((a, b) => Number(b.defId === STORAGE_CHEST) - Number(a.defId === STORAGE_CHEST) || b.free - a.free || a.id - b.id);
}

/**
 * How full the player's pack is, how big it may be (Strength, base plus
 * worn gear), how much gear is kept at home, whether they have a home and
 * how many free slots its containers have. Null without a character.
 */
export async function carryState(db: D1Database, playerId: string): Promise<CarryState | null> {
  const [[c, worn, counts, home], boxes] = await Promise.all([
    db.batch([
      db.prepare("SELECT * FROM characters WHERE player_id = ?1").bind(playerId),
      db.prepare("SELECT * FROM inventory WHERE player_id = ?1 AND equipped = 1").bind(playerId),
      db.prepare(`SELECT ${CARRIED_SQL} AS carried, (SELECT COUNT(*) FROM inventory WHERE player_id = ?1 AND stored_in IS NOT NULL) AS stored`).bind(playerId),
      db.prepare(`SELECT ${HAS_HOME_SQL} AS yes`).bind(playerId),
    ]),
    containersWithRoom(db, playerId),
  ]);
  const character = c.results[0] as CharacterRow | undefined;
  if (!character) return null;
  const bonus = loadoutOf((worn.results as InventoryRow[]).map(rowToItem)).bonus;
  const n = counts.results[0] as { carried: number; stored: number };
  const hasHome = !!(home.results[0] as { yes: number }).yes;
  return {
    carried: n.carried,
    stored: n.stored,
    limit: carryLimit(addStats(statsOf(character), bonus)),
    hasHome,
    room: hasHome ? boxes.reduce((sum, b) => sum + b.free, 0) : 0,
  };
}

/**
 * Statement that keeps item `itemId` in container `boxId` of player ?1, only
 * if it is still carried, there is a home and the container still has
 * the squares free for its footprint.
 */
export const keepStatement = (db: D1Database, playerId: string, itemId: number, boxId: number, squares: number) =>
  db
    .prepare(`UPDATE inventory SET stored_in = ?3 WHERE id = ?2 AND player_id = ?1 AND equipped = 0 AND stored_in IS NULL AND ${HAS_HOME_SQL} AND ${usedSql("?3")} + ${CELLS_SQL} <= ?4`)
    .bind(playerId, itemId, boxId, squares);

/**
 * Send an unequipped item to storage at home: into the free Storage Chest,
 * or another container with room. Works from anywhere, as long as there is
 * a home with room. Returns an error message or null.
 */
export async function storeItem(db: D1Database, playerId: string, itemId: number): Promise<string | null> {
  const [row, carry, boxes] = await Promise.all([getItem(db, playerId, itemId), carryState(db, playerId), containersWithRoom(db, playerId)]);
  if (!carry) return "Create a character first.";
  const problem = storeProblem(row && { equipped: !!row.equipped, stored: false }, carry);
  if (problem) return problem;
  // The first container (the free chest first) with the squares for it.
  const cells = itemCells(row!);
  const box = boxes.find((b) => b.free >= cells);
  if (!box) return "No chest at home has the room for something that size. Make room there, or add another chest, crate or cupboard.";
  const res = await keepStatement(db, playerId, itemId, box.id, FURNISHINGS[box.defId].storage!).run();
  return res.meta.changes > 0 ? null : "That item or your chests changed just now. Try again.";
}

/** For an item `getItem` cannot see: says so if it is kept in a container at home. */
export async function keptAtHome(db: D1Database, playerId: string, itemId: number): Promise<string | null> {
  const row = await db.prepare("SELECT 1 AS yes FROM inventory WHERE id = ? AND player_id = ? AND stored_in IS NOT NULL").bind(itemId, playerId).first();
  return row ? "That is kept at home. Take it out there first." : null;
}

/** Equip an item, swapping out whatever is in its slot. Returns an error message or null. */
export async function equipItem(db: D1Database, playerId: string, itemId: number): Promise<string | null> {
  const [row, c] = await Promise.all([getItem(db, playerId, itemId), getCharacter(db, playerId)]);
  if (!row || !c) return (await keptAtHome(db, playerId, itemId)) ?? "No such item.";
  const problem = equipProblem(rowToItem(row), c.class_id, c.level);
  if (problem) return `${problem}.`;
  // Swapping never changes how many are carried: one comes off as the other goes on.
  await db.batch([
    db.prepare("UPDATE inventory SET equipped = 0, hidden = 0 WHERE player_id = ?1 AND slot = ?2 AND EXISTS (SELECT 1 FROM inventory WHERE id = ?3 AND stored_in IS NULL)").bind(playerId, row.slot, itemId),
    db.prepare("UPDATE inventory SET equipped = 1 WHERE id = ? AND stored_in IS NULL").bind(itemId),
  ]);
  return null;
}

export async function unequipItem(db: D1Database, playerId: string, itemId: number): Promise<string | null> {
  const row = await getItem(db, playerId, itemId);
  if (!row) return "No such item.";
  // The weapon comes off like anything else: a hero with nothing in hand fights with bare hands.
  // Into the pack even if that puts it over the limit: nothing is ever dropped.
  await db.prepare("UPDATE inventory SET equipped = 0, hidden = 0 WHERE id = ?").bind(itemId).run();
  return null;
}

/** Show or hide a worn piece on the hero (not one held in the hands). What it does is unchanged either way. Returns an error message or null. */
export async function setGearHidden(db: D1Database, playerId: string, itemId: number, hidden: boolean): Promise<string | null> {
  const row = await getItem(db, playerId, itemId);
  if (row && !canHide(row.slot)) return "What is held in the hands is always shown.";
  const res = await db.prepare("UPDATE inventory SET hidden = ?3 WHERE id = ?2 AND player_id = ?1 AND equipped = 1 AND stored_in IS NULL").bind(playerId, itemId, hidden ? 1 : 0).run();
  return res.meta.changes > 0 ? null : "Only worn gear can be hidden.";
}
