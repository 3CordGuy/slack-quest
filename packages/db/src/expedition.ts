// D1 helpers for the expedition map. See migrations/0066_expeditions.sql
// and docs/expedition-map.md.

import type { D1Database } from "@cloudflare/workers-types";
import type { ExpeditionMap } from "@gantt-quest/core";

export type ExpeditionStatus = "active" | "completed" | "failed" | "abandoned";

export interface ExpeditionRow {
  id: number;
  channel_id: string;
  status: ExpeditionStatus;
  seed: string;
  map_json: string;
  current_node: string | null;
  created_by: string;
  created_at: number;
  completed_at: number | null;
}

export interface ExpeditionProgressRow {
  expedition_id: number;
  node_id: string;
  resolved_at: number;
  outcome_json: string;
}

/**
 * Error thrown when `createExpedition` cannot insert the
 * `active_expedition_membership` row for one of the party members because that
 * member is already in another active expedition. Callers should catch this
 * and return a 409 / 400 to the client.
 *
 * We surface this as a typed error (rather than relying on the raw SQLite
 * UNIQUE-constraint message) so the worker doesn't have to string-match the
 * D1 driver's error text — which has changed across runtime versions.
 */
export class ExpeditionMembershipConflictError extends Error {
  constructor(public readonly characterId: string) {
    super(`character ${characterId} is already in an active expedition`);
    this.name = "ExpeditionMembershipConflictError";
  }
}

/**
 * Reserve an expedition id by inserting a placeholder row up front, then let
 * the caller fill in the deterministic seed + map_json. This is the only way
 * to know the id before generating the deterministic map (which is keyed off
 * `(expedition_id, party_signature)`).
 *
 * The placeholder row is inserted with empty seed/map and status='active' —
 * we IMMEDIATELY overwrite seed and map_json in the same request via
 * `finalizeExpeditionMap`, and gate any other read of the row on the
 * membership invariant. The reservation cannot leak because:
 *   - the membership row is inserted in the same call; if it conflicts the
 *     reservation row is rolled back (we delete it on failure);
 *   - even if a concurrent reader sees the placeholder, they cannot pick
 *     anything (current_node is NULL and `available_picks` requires a real
 *     map_json — we INSERT with `map_json='{}'` which `availablePicks` rejects
 *     by failing the JSON-shape check up front in the worker).
 *
 * On membership conflict throws `ExpeditionMembershipConflictError` and does
 * NOT leave any row behind.
 */
export async function createExpedition(
  db: D1Database,
  args: {
    channel_id: string;
    seed: string;
    map: ExpeditionMap;
    created_by: string;
    party: readonly string[];
  },
): Promise<number> {
  const now = Date.now();
  const result = await db
    .prepare(
      `INSERT INTO expeditions (channel_id, status, seed, map_json, current_node, created_by, created_at)
       VALUES (?, 'active', ?, ?, NULL, ?, ?)`,
    )
    .bind(args.channel_id, args.seed, JSON.stringify(args.map), args.created_by, now)
    .run();
  const id = result.meta.last_row_id as number;

  // Insert party + active-membership rows. Membership is the gate that
  // prevents the start-race TOCTOU; if any insert fails because the character
  // is already in another active expedition we tear down the half-built
  // expedition row so the next attempt sees a clean slate.
  try {
    for (const cid of args.party) {
      await db
        .prepare(
          `INSERT INTO expedition_party (expedition_id, character_id, joined_at)
           VALUES (?, ?, ?)`,
        )
        .bind(id, cid, now)
        .run();
      try {
        await db
          .prepare(
            `INSERT INTO active_expedition_membership (character_id, expedition_id)
             VALUES (?, ?)`,
          )
          .bind(cid, id)
          .run();
      } catch (err) {
        // SQLite UNIQUE-constraint violation on character_id — someone else
        // started an expedition with this character in parallel.
        throw new ExpeditionMembershipConflictError(cid);
      }
    }
  } catch (err) {
    // Best-effort cleanup. ON DELETE CASCADE on `expedition_party` and
    // `active_expedition_membership` rows clears those automatically.
    try {
      await db.prepare(`DELETE FROM expeditions WHERE id = ?`).bind(id).run();
    } catch {
      // swallow — this is cleanup on the error path; surfacing the cleanup
      // error would mask the real cause.
    }
    throw err;
  }
  return id;
}

/**
 * Overwrite the seed and map_json on an already-inserted expedition row.
 * Used by `/api/expedition/start` to swap the bootstrap placeholder for the
 * deterministic map keyed off the freshly-allocated expedition id.
 */
export async function finalizeExpeditionMap(
  db: D1Database,
  id: number,
  seed: string,
  map: ExpeditionMap,
): Promise<void> {
  await db
    .prepare(`UPDATE expeditions SET seed = ?, map_json = ? WHERE id = ?`)
    .bind(seed, JSON.stringify(map), id)
    .run();
}

export async function getExpedition(
  db: D1Database,
  id: number,
): Promise<ExpeditionRow | null> {
  const row = await db
    .prepare(
      `SELECT id, channel_id, status, seed, map_json, current_node, created_by, created_at, completed_at
       FROM expeditions WHERE id = ? LIMIT 1`,
    )
    .bind(id)
    .first<ExpeditionRow>();
  return row ?? null;
}

export async function getExpeditionParty(
  db: D1Database,
  id: number,
): Promise<string[]> {
  const r = await db
    .prepare(
      `SELECT character_id FROM expedition_party WHERE expedition_id = ? ORDER BY joined_at ASC`,
    )
    .bind(id)
    .all<{ character_id: string }>();
  return (r.results ?? []).map((row) => row.character_id);
}

export async function getExpeditionProgress(
  db: D1Database,
  id: number,
): Promise<ExpeditionProgressRow[]> {
  const r = await db
    .prepare(
      `SELECT expedition_id, node_id, resolved_at, outcome_json
       FROM expedition_node_progress WHERE expedition_id = ? ORDER BY resolved_at ASC`,
    )
    .bind(id)
    .all<ExpeditionProgressRow>();
  return r.results ?? [];
}

/**
 * Legacy unconditional update — kept for callers that are not racing on
 * `current_node`. Prefer `setExpeditionCurrentNodeIfCurrent` for the pick
 * route, which performs a compare-and-swap and reports whether it won the
 * race.
 */
export async function setExpeditionCurrentNode(
  db: D1Database,
  id: number,
  nodeId: string,
): Promise<void> {
  await db
    .prepare(`UPDATE expeditions SET current_node = ? WHERE id = ?`)
    .bind(nodeId, id)
    .run();
}

/**
 * Compare-and-swap update for the expedition's `current_node`. Used by
 * `/api/expedition/:id/pick` to defend against two concurrent picks both
 * loading the same `current_node`, both validating it, and both winning.
 *
 * Bind `expectedCurrent === null` to require the row's current_node IS NULL
 * (first pick); otherwise we require strict equality. Returns true iff the
 * swap actually happened (UPDATE affected one row). On false the caller
 * should return 409 conflict — another pick won the race.
 *
 * SQL note: SQLite's `IS` operator is null-aware (unlike `=`), which is why
 * we use it for the predicate.
 */
export async function setExpeditionCurrentNodeIfCurrent(
  db: D1Database,
  id: number,
  expectedCurrent: string | null,
  nextNodeId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE expeditions SET current_node = ?
        WHERE id = ? AND current_node IS ?`,
    )
    .bind(nextNodeId, id, expectedCurrent)
    .run();
  // D1's meta.changes is the count of rows affected by the last statement.
  return (result.meta?.changes ?? 0) === 1;
}

export async function setExpeditionStatus(
  db: D1Database,
  id: number,
  status: ExpeditionStatus,
): Promise<void> {
  const terminal = status === "completed" || status === "failed" || status === "abandoned";
  const completedAt = terminal ? Date.now() : null;
  await db
    .prepare(
      `UPDATE expeditions SET status = ?, completed_at = ? WHERE id = ?`,
    )
    .bind(status, completedAt, id)
    .run();
  // Free the active-membership slots for the party so members can start a
  // new expedition. Done after the status update so a concurrent /start
  // racing the abandon at least sees a coherent active row OR the freed slot.
  if (terminal) {
    await db
      .prepare(`DELETE FROM active_expedition_membership WHERE expedition_id = ?`)
      .bind(id)
      .run();
  }
}

export async function recordExpeditionNodeProgress(
  db: D1Database,
  id: number,
  nodeId: string,
  outcome: unknown,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO expedition_node_progress (expedition_id, node_id, resolved_at, outcome_json)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(id, nodeId, Date.now(), JSON.stringify(outcome))
    .run();
}

/**
 * Returns the active expedition for a character, if any. A character may
 * only be in one active expedition at a time (enforced at start by the
 * `active_expedition_membership` table's PK on character_id).
 */
export async function getActiveExpeditionForCharacter(
  db: D1Database,
  userId: string,
): Promise<ExpeditionRow | null> {
  const row = await db
    .prepare(
      `SELECT e.id, e.channel_id, e.status, e.seed, e.map_json, e.current_node, e.created_by, e.created_at, e.completed_at
       FROM expeditions e
       JOIN active_expedition_membership m ON m.expedition_id = e.id
       WHERE m.character_id = ? AND e.status = 'active'
       LIMIT 1`,
    )
    .bind(userId)
    .first<ExpeditionRow>();
  return row ?? null;
}

export async function getRecentExpeditionsForCharacter(
  db: D1Database,
  userId: string,
  limit = 10,
): Promise<ExpeditionRow[]> {
  const r = await db
    .prepare(
      `SELECT e.id, e.channel_id, e.status, e.seed, e.map_json, e.current_node, e.created_by, e.created_at, e.completed_at
       FROM expeditions e
       JOIN expedition_party ep ON ep.expedition_id = e.id
       WHERE ep.character_id = ?
       ORDER BY e.created_at DESC
       LIMIT ?`,
    )
    .bind(userId, limit)
    .all<ExpeditionRow>();
  return r.results ?? [];
}
