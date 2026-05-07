-- Make quests.created_by nullable + ON DELETE SET NULL so perma-death of a
-- character can leave their historical quests intact. SQLite doesn't allow
-- altering FK constraints in place — recreate the table.

CREATE TABLE quests_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id   TEXT NOT NULL,
  thread_ts    TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'active',
  elite        INTEGER NOT NULL DEFAULT 0,
  scene_json   TEXT NOT NULL,
  created_by   TEXT REFERENCES characters(slack_user_id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  completed_at INTEGER
);

INSERT INTO quests_new (id, channel_id, thread_ts, status, elite, scene_json, created_by, created_at, completed_at)
SELECT id, channel_id, thread_ts, status, elite, scene_json, created_by, created_at, completed_at
FROM quests;

DROP TABLE quests;
ALTER TABLE quests_new RENAME TO quests;

CREATE INDEX idx_quests_status ON quests(status);
