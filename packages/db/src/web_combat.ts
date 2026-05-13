// Persistence layer for web-mode combat state. The QuestRoom DO calls these
// to rehydrate after hibernation/eviction and to checkpoint after every turn.
// Schema lives in migrations/0023_web_combat_state.sql and the log column was
// added by 0025_web_combat_log.sql.

import type { CombatState } from "@gantt-quest/core";

// Log entries are stored as opaque JSON — they can be engine CombatEvents or
// worker-side events (e.g. item_used). Callers re-cast when needed.
export interface WebCombatSnapshot {
  state: CombatState;
  log: unknown[];
}

export async function getWebCombatState(
  db: D1Database,
  questId: number,
): Promise<CombatState | null> {
  const snap = await getWebCombatSnapshot(db, questId);
  return snap?.state ?? null;
}

export async function getWebCombatSnapshot(
  db: D1Database,
  questId: number,
): Promise<WebCombatSnapshot | null> {
  const row = await db
    .prepare("SELECT state, log_json FROM web_combat_state WHERE quest_id = ?")
    .bind(questId)
    .first<{ state: string; log_json: string }>();
  if (!row) return null;
  return {
    state: JSON.parse(row.state) as CombatState,
    log: row.log_json ? (JSON.parse(row.log_json) as unknown[]) : [],
  };
}

// Upserts the per-quest combat state. Called after every successful step()
// in the QuestRoom DO so D1 stays the system of record (per the project's DO
// rules — see memory/feedback_durable_objects.md).
export async function saveWebCombatState(
  db: D1Database,
  questId: number,
  state: CombatState,
  log?: unknown[],
): Promise<void> {
  const now = Date.now();
  if (log === undefined) {
    // State-only update — keep whatever log is already in D1 (don't blank it).
    await db
      .prepare(
        `INSERT INTO web_combat_state (quest_id, state, updated_at, log_json)
         VALUES (?, ?, ?, '[]')
         ON CONFLICT(quest_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      )
      .bind(questId, JSON.stringify(state), now)
      .run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO web_combat_state (quest_id, state, updated_at, log_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(quest_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at, log_json = excluded.log_json`,
    )
    .bind(questId, JSON.stringify(state), now, JSON.stringify(log))
    .run();
}

export async function deleteWebCombatState(
  db: D1Database,
  questId: number,
): Promise<void> {
  await db
    .prepare("DELETE FROM web_combat_state WHERE quest_id = ?")
    .bind(questId)
    .run();
}
