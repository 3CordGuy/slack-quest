-- Characters: 1 row per Slack user who has joined the game.
CREATE TABLE characters (
  slack_user_id TEXT PRIMARY KEY,
  slack_team_id TEXT NOT NULL,
  name          TEXT NOT NULL,
  class         TEXT NOT NULL,
  level         INTEGER NOT NULL DEFAULT 1,
  xp            INTEGER NOT NULL DEFAULT 0,
  hp            INTEGER NOT NULL,
  max_hp        INTEGER NOT NULL,
  gold          INTEGER NOT NULL DEFAULT 10,
  scars         TEXT    NOT NULL DEFAULT '[]', -- JSON array of strings
  downed_until  INTEGER,                       -- unix ms; null if not downed
  created_at    INTEGER NOT NULL,
  last_active   INTEGER NOT NULL
);

CREATE TABLE inventory (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id TEXT NOT NULL REFERENCES characters(slack_user_id) ON DELETE CASCADE,
  item_name    TEXT NOT NULL,
  qty          INTEGER NOT NULL DEFAULT 1,
  flavor       TEXT
);
CREATE INDEX idx_inventory_character ON inventory(character_id);

-- Quests: one row per started quest. thread_ts links it to the Slack thread.
CREATE TABLE quests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id  TEXT NOT NULL,
  thread_ts   TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'active', -- active|completed|failed
  elite       INTEGER NOT NULL DEFAULT 0,     -- 0|1; perma-death enabled
  scene_json  TEXT NOT NULL,                  -- {monster_name, monster_hp, monster_max_hp, tier, scene}
  created_by  TEXT NOT NULL REFERENCES characters(slack_user_id),
  created_at  INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX idx_quests_status ON quests(status);

CREATE TABLE quest_party (
  quest_id     INTEGER NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES characters(slack_user_id) ON DELETE CASCADE,
  joined_at    INTEGER NOT NULL,
  PRIMARY KEY (quest_id, character_id)
);

CREATE TABLE quest_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  quest_id INTEGER NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
  actor    TEXT NOT NULL, -- character slack_user_id or 'narrator'
  action   TEXT NOT NULL,
  outcome  TEXT,
  ts       INTEGER NOT NULL
);
CREATE INDEX idx_quest_log_quest ON quest_log(quest_id);
