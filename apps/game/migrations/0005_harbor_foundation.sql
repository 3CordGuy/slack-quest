-- Shared tables for the Harbor work that is being built in parallel: huts
-- and their contents, crafting resources and blueprints, notice-board
-- contracts and crew goals. Created together so the tracks do not each need
-- their own migration.

CREATE TABLE huts (
  player_id TEXT PRIMARY KEY REFERENCES players(id),
  tier      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE resources (
  player_id TEXT NOT NULL REFERENCES players(id),
  kind      TEXT NOT NULL,           -- wood | stone | iron | copper | fur | bone
  qty       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, kind)
);

CREATE TABLE blueprints (
  player_id    TEXT NOT NULL REFERENCES players(id),
  blueprint_id TEXT NOT NULL,        -- a furnishing id from packages/world/src/hut.ts
  PRIMARY KEY (player_id, blueprint_id)
);

-- A piece of furniture or a trophy a player owns. q/r are null while it is
-- in storage; set, it stands on that hex of the owner's hut.
CREATE TABLE furnishings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id  TEXT NOT NULL REFERENCES players(id),
  def_id     TEXT NOT NULL,
  label      TEXT NOT NULL,          -- display name; for a trophy, names the story it came from
  meta_json  TEXT NOT NULL DEFAULT '{}',
  q          INTEGER,
  r          INTEGER,
  facing     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_furnishings_player ON furnishings(player_id);

-- The personal contract a hero took before a voyage.
CREATE TABLE run_contracts (
  code        TEXT NOT NULL REFERENCES runs(code),
  player_id   TEXT NOT NULL REFERENCES players(id),
  contract_id TEXT NOT NULL,
  done        INTEGER NOT NULL DEFAULT 0,
  rewarded    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (code, player_id)
);

-- A goal the whole crew fills together. `period` identifies the stretch it
-- belongs to (for example a week number).
CREATE TABLE crew_goals (
  crew_id  TEXT NOT NULL REFERENCES crews(id),
  period   TEXT NOT NULL,
  goal_id  TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  target   INTEGER NOT NULL,
  rewarded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (crew_id, period, goal_id)
);
