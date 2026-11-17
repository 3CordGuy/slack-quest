// What a hero carries to drink or throw, in D1: so many of each kind, in
// stacks in the pack beside the materials (and counted with them toward what
// the pack holds, see carriedSql in db.ts). A map's room reads them when the
// hero walks in and before each one is used, and takes away what was used.

import { STARTING_ITEMS, THROWABLE_KINDS, cleanItems, type Throwable } from "@gantt-quest/world";

export type Consumables = Partial<Record<Throwable, number>>;

/** What a hero's pack holds to drink or throw, by kind. */
export async function consumablesOf(db: D1Database, playerId: string): Promise<Consumables> {
  const rows = await db.prepare("SELECT kind, qty FROM consumables WHERE player_id = ? AND qty > 0").bind(playerId).all<{ kind: string; qty: number }>();
  return cleanItems(Object.fromEntries(rows.results.map((r) => [r.kind, r.qty])));
}

/** Take what was used out of a hero's pack: a statement a kind, each doing nothing if they no longer hold that many. */
export function spendConsumables(db: D1Database, playerId: string, used: Consumables): D1PreparedStatement[] {
  return THROWABLE_KINDS.filter((k) => (used[k] ?? 0) > 0).map((k) =>
    db.prepare("UPDATE consumables SET qty = qty - ?3 WHERE player_id = ?1 AND kind = ?2 AND qty >= ?3").bind(playerId, k, used[k]!),
  );
}

/** Statements that put what was picked up on a map into the pack. */
export function gainConsumables(db: D1Database, playerId: string, gained: Consumables): D1PreparedStatement[] {
  return THROWABLE_KINDS.filter((k) => (gained[k] ?? 0) > 0).map((k) =>
    db.prepare("INSERT INTO consumables (player_id, kind, qty) VALUES (?1, ?2, ?3) ON CONFLICT(player_id, kind) DO UPDATE SET qty = qty + ?3").bind(playerId, k, gained[k]!),
  );
}

/**
 * The kit every hero starts with: each kind brought up to its starting number, and never down. For a
 * new hero as they are confirmed, and for the dev toolbox's restock.
 */
export function kitStatements(db: D1Database, playerId: string): D1PreparedStatement[] {
  return THROWABLE_KINDS.filter((k) => (STARTING_ITEMS[k] ?? 0) > 0).map((k) =>
    db
      .prepare("INSERT INTO consumables (player_id, kind, qty) VALUES (?1, ?2, ?3) ON CONFLICT(player_id, kind) DO UPDATE SET qty = MAX(qty, excluded.qty)")
      .bind(playerId, k, STARTING_ITEMS[k]!),
  );
}
