-- Expedition Map v1 — see docs/expedition-map.md
--
-- Three new tables for the Slay-the-Spire-style branching expedition mode,
-- plus a nullable back-pointer column on `quests` so combat-kind nodes can
-- spawn a regular quest row that knows which expedition spawned it.
--
-- All additive. Existing one-off quests have from_expedition_id = NULL.

CREATE TABLE expeditions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id    TEXT NOT NULL,                           -- mirrors quests.channel_id (web:<userid> for solo)
  status        TEXT NOT NULL DEFAULT 'active',          -- active|completed|failed|abandoned
  seed          TEXT NOT NULL,                           -- deterministic generation seed
  map_json      TEXT NOT NULL,                           -- canonical generated graph; nodes + edges
  current_node  TEXT,                                    -- node id; null until first pick
  created_by    TEXT NOT NULL REFERENCES characters(slack_user_id),
  created_at    INTEGER NOT NULL,
  completed_at  INTEGER
);
CREATE INDEX idx_expeditions_status ON expeditions(status);
CREATE INDEX idx_expeditions_created_by ON expeditions(created_by);

CREATE TABLE expedition_party (
  expedition_id INTEGER NOT NULL REFERENCES expeditions(id) ON DELETE CASCADE,
  character_id  TEXT NOT NULL REFERENCES characters(slack_user_id) ON DELETE CASCADE,
  joined_at     INTEGER NOT NULL,
  PRIMARY KEY (expedition_id, character_id)
);
CREATE INDEX idx_expedition_party_character ON expedition_party(character_id);

CREATE TABLE expedition_node_progress (
  expedition_id INTEGER NOT NULL REFERENCES expeditions(id) ON DELETE CASCADE,
  node_id       TEXT NOT NULL,
  resolved_at   INTEGER NOT NULL,
  outcome_json  TEXT NOT NULL,                            -- per-kind payload
  PRIMARY KEY (expedition_id, node_id)
);

-- Back-pointer on quests: when a combat node spawns a quest, this is set so
-- the quest resolution callback knows which expedition to advance. Nullable
-- so one-off quests are unaffected.
ALTER TABLE quests ADD COLUMN from_expedition_id INTEGER REFERENCES expeditions(id);
CREATE INDEX idx_quests_from_expedition ON quests(from_expedition_id);
