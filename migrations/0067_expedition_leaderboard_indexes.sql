-- Expedition leaderboard supporting indexes.
--
-- The leaderboard queries in apps/web/src/worker.ts (and packages/db/src/db.ts
-- helpers `get*ExpeditionLeaderboard`) scan `expeditions` and
-- `expedition_node_progress` frequently. The base 0066_expeditions.sql migration
-- already created:
--   idx_expeditions_status          (status)
--   idx_expeditions_created_by      (created_by)
--   idx_expedition_party_character  (character_id)
--   (expedition_id, node_id)        — PRIMARY KEY on expedition_node_progress
--
-- What's still missing for fast leaderboard reads:
--   * a composite (status, completed_at) index so the fastest-clear board's
--     `WHERE status = 'completed' ORDER BY completed_at` can range-scan
--     without re-sorting all 'completed' rows;
--   * a covering (status, id) index so the most-cleared / nodes / elite
--     counts can hash-join from `expedition_party` -> `expeditions` and
--     filter by status without a table scan.
--
-- All additive, all CREATE INDEX IF NOT EXISTS so re-applying is safe.

CREATE INDEX IF NOT EXISTS idx_expeditions_status_completed_at
  ON expeditions(status, completed_at);

CREATE INDEX IF NOT EXISTS idx_expeditions_status_id
  ON expeditions(status, id);
