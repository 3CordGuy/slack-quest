-- Lightweight per-user notification queue. Generic by `kind` so future
-- alerts (party invites, level-up echoes, etc.) can pile in without
-- another migration. `payload` is opaque JSON; the client switches on
-- `kind` to render. Read-and-clear: rows are DELETEd as the client
-- consumes them via GET /api/notifications/pending.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- 'item_received' (initial use), more later
  payload TEXT NOT NULL,         -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications (user_id, created_at);
