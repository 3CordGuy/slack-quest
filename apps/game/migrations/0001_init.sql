-- Overworld game schema. Separate database from the legacy slack-quest D1.

CREATE TABLE players (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  player_id  TEXT NOT NULL REFERENCES players(id),
  created_at INTEGER NOT NULL
);

-- One character per player. `draft` while the player is still rolling
-- starting stats at creation; `active` once confirmed.
CREATE TABLE characters (
  player_id      TEXT PRIMARY KEY REFERENCES players(id),
  name           TEXT NOT NULL,
  class_id       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft',
  level          INTEGER NOT NULL DEFAULT 1,
  xp             INTEGER NOT NULL DEFAULT 0,
  str            INTEGER NOT NULL,
  int_stat       INTEGER NOT NULL,
  vit            INTEGER NOT NULL,
  agi            INTEGER NOT NULL,
  dex            INTEGER NOT NULL,
  unspent_points INTEGER NOT NULL DEFAULT 0,
  gold           INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

CREATE TABLE inventory (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id       TEXT NOT NULL REFERENCES players(id),
  kind            TEXT NOT NULL,          -- weapon | trinket
  ref             TEXT NOT NULL,          -- weapon id or trinket id
  name            TEXT NOT NULL,
  rarity          TEXT NOT NULL,
  slot            TEXT NOT NULL,          -- weapon | trinket
  stat_bonus_json TEXT NOT NULL DEFAULT '{}',
  equipped        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_inventory_player ON inventory(player_id);

-- A run is one voyage to one island. state_json is the full WorldState and
-- is the system of record; the Durable Object only caches it.
CREATE TABLE runs (
  code       TEXT PRIMARY KEY,
  seed       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'lobby',  -- lobby | generating | overworld | battle | victory | defeat
  bible_json TEXT,
  state_json TEXT,
  created_by TEXT NOT NULL REFERENCES players(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE run_players (
  code      TEXT NOT NULL REFERENCES runs(code),
  player_id TEXT NOT NULL REFERENCES players(id),
  xp_earned   INTEGER NOT NULL DEFAULT 0,
  gold_earned INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (code, player_id)
);

-- Append-only action log. With runs.seed this replays a run exactly.
CREATE TABLE run_actions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL REFERENCES runs(code),
  action_json TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_run_actions_code ON run_actions(code, id);

CREATE TABLE npc_conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL REFERENCES runs(code),
  npc_id     TEXT NOT NULL,
  speaker    TEXT NOT NULL,   -- player id, or 'npc'
  text       TEXT NOT NULL,
  meta_json  TEXT,            -- for npc lines: the raw intent and whether it was allowed
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_npc_conversations_code ON npc_conversations(code, npc_id, id);
