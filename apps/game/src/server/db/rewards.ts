// What a map pays a hero, written to D1 as it is earned.

import { applyXp, cleanStone, itemCells, lootPlace, stoneItem, type FurnishingGrant, type ItemDef, type LootPlace, type Resources } from "@gantt-quest/world";
import { getCharacter } from "./characters";
import { blueprintStatement, furnishingStatement, resourceStatements } from "./huts";
import { carryState, containersWithRoom } from "./inventory";
import { insertItem, statsOf } from "./rows";

// ---------- rewards ----------

/**
 * What a map pays a hero, written as it is earned: XP (levelling them up as it goes), gold, materials
 * and whatever else was found. Returns the levels gained and where a piece of gear went: the pack if
 * it has room, else a container at home, else the pack anyway, over the limit. Earned gear is never lost.
 */
export async function applyZoneGrant(
  db: D1Database,
  playerId: string,
  grant: { xp: number; resources: Resources; gold?: number; item?: ItemDef | null; blueprint?: string; furnishing?: FurnishingGrant; items?: Partial<Record<string, number>>; stone?: unknown },
): Promise<{ levelsGained: number; place: LootPlace | null }> {
  const [c, carry, boxes] = await Promise.all([getCharacter(db, playerId), grant.item ? carryState(db, playerId) : null, grant.item ? containersWithRoom(db, playerId) : []]);
  if (!c) return { levelsGained: 0, place: null };
  const next = applyXp({ classId: c.class_id, level: c.level, xp: c.xp, stats: statsOf(c), unspent: c.unspent_points }, grant.xp);
  const stmts: D1PreparedStatement[] = [...resourceStatements(db, playerId, grant.resources)];
  // A piece of gear goes in the pack if it has room, else the best container at home with room; it is never lost.
  const place = carry && grant.item ? lootPlace(carry, itemCells(grant.item)) : null;
  if (grant.item) {
    const cells = itemCells(grant.item);
    stmts.push(insertItem(db, playerId, grant.item, false, place === "storage" ? (boxes.find((b) => b.free >= cells)?.id ?? boxes[0]?.id ?? null) : null));
  }
  if (grant.blueprint) stmts.push(blueprintStatement(db, playerId, grant.blueprint));
  if (grant.furnishing) stmts.push(furnishingStatement(db, playerId, grant.furnishing));
  for (const [kind, qty] of Object.entries(grant.items ?? {})) {
    if (!qty || qty <= 0) continue;
    stmts.push(db.prepare("INSERT INTO consumables (player_id, kind, qty) VALUES (?1, ?2, ?3) ON CONFLICT(player_id, kind) DO UPDATE SET qty = qty + ?3").bind(playerId, kind, qty));
  }
  // A lodestone found in a bounty goes in the pack with the rest: a kind of item of its own (see server/lodestones.ts).
  const stone = grant.stone === undefined ? null : cleanStone(grant.stone);
  if (stone) stmts.push(db.prepare("INSERT INTO consumables (player_id, kind, qty) VALUES (?1, ?2, 1) ON CONFLICT(player_id, kind) DO UPDATE SET qty = qty + 1").bind(playerId, stoneItem(stone)));
  stmts.push(
    db
      .prepare("UPDATE characters SET level = ?, xp = ?, str = ?, int_stat = ?, vit = ?, agi = ?, dex = ?, unspent_points = ?, gold = gold + ? WHERE player_id = ?")
      .bind(next.level, next.xp, next.stats.str, next.stats.int_stat, next.stats.vit, next.stats.agi, next.stats.dex, next.unspent, grant.gold ?? 0, playerId),
  );
  await db.batch(stmts);
  return { levelsGained: next.levelsGained, place };
}
