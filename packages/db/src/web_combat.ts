// Persistence layer for web-mode combat state. The QuestRoom DO calls these
// to rehydrate after hibernation/eviction and to checkpoint after every turn.
// Schema lives in migration 0015_web_combat_state.sql.

import type { CombatState } from "@gantt-quest/core";

export async function getWebCombatState(
  db: D1Database,
  questId: number,
): Promise<CombatState | null> {
  const row = await db
    .prepare("SELECT state FROM web_combat_state WHERE quest_id = ?")
    .bind(questId)
    .first<{ state: string }>();
  if (!row) return null;
  return JSON.parse(row.state) as CombatState;
}

// Upserts the per-quest combat state. Called after every successful step()
// in the QuestRoom DO so D1 stays the system of record (per the project's DO
// rules — see memory/feedback_durable_objects.md).
export async function saveWebCombatState(
  db: D1Database,
  questId: number,
  state: CombatState,
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO web_combat_state (quest_id, state, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(quest_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
    )
    .bind(questId, JSON.stringify(state), now)
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
