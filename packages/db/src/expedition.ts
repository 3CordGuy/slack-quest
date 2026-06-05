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
  // Bulk-insert party rows. D1 batch API would be neater but the loop keeps
  // this dependency-free.
  for (const cid of args.party) {
    await db
      .prepare(
        `INSERT INTO expedition_party (expedition_id, character_id, joined_at)
         VALUES (?, ?, ?)`,
      )
      .bind(id, cid, now)
      .run();
  }
  return id;
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

export async function setExpeditionStatus(
  db: D1Database,
  id: number,
  status: ExpeditionStatus,
): Promise<void> {
  const completedAt = status === "completed" || status === "failed" || status === "abandoned"
    ? Date.now()
    : null;
  await db
    .prepare(
      `UPDATE expeditions SET status = ?, completed_at = ? WHERE id = ?`,
    )
    .bind(status, completedAt, id)
    .run();
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
 * only be in one active expedition at a time (enforced at start).
 */
export async function getActiveExpeditionForCharacter(
  db: D1Database,
  userId: string,
): Promise<ExpeditionRow | null> {
  const row = await db
    .prepare(
      `SELECT e.id, e.channel_id, e.status, e.seed, e.map_json, e.current_node, e.created_by, e.created_at, e.completed_at
       FROM expeditions e
       JOIN expedition_party ep ON ep.expedition_id = e.id
       WHERE ep.character_id = ? AND e.status = 'active'
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
