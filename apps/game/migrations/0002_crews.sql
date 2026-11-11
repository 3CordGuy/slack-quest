-- Crews: a group of players who share one Harbor. A player belongs to at
-- most one crew at a time. Ships (runs) launched from a Harbor carry its
-- crew id so they show on that Harbor's dock board and voyage log.

CREATE TABLE crews (
  id         TEXT PRIMARY KEY,   -- also the invite code
  name       TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES players(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE crew_members (
  crew_id   TEXT NOT NULL REFERENCES crews(id),
  player_id TEXT NOT NULL UNIQUE REFERENCES players(id),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (crew_id, player_id)
);
CREATE INDEX idx_crew_members_crew ON crew_members(crew_id, joined_at);

ALTER TABLE runs ADD COLUMN crew_id TEXT REFERENCES crews(id);
CREATE INDEX idx_runs_crew ON runs(crew_id, updated_at);
