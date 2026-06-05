-- Expedition Map v1 — see docs/expedition-map.md
--
-- Three+1 new tables for the Slay-the-Spire-style branching expedition mode,
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
  -- Run-long shrine buffs accumulated this expedition. JSON array of
  -- { kind: "max_hp" | "mana_refill" | "stat", value: number, stat?: string,
  --   node_id: string, applied_at: number }. Pass 2 reads this when seeding
  -- the next combat to apply the run's stacked HP bonus and to refresh mana
  -- on a "mana_refill" shrine. Empty array on start.
  buffs_json    TEXT NOT NULL DEFAULT '[]',
  created_by    TEXT NOT NULL REFERENCES characters(slack_user_id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  completed_at  INTEGER
);
CREATE INDEX idx_expeditions_status ON expeditions(status);
CREATE INDEX idx_expeditions_created_by ON expeditions(created_by);

CREATE TABLE expedition_party (
  expedition_id INTEGER NOT NULL REFERENCES expeditions(id) ON DELETE CASCADE,
  character_id  TEXT NOT NULL REFERENCES characters(slack_user_id) ON DELETE CASCADE,
  joined_at     INTEGER NOT NULL,
  -- Pass 2: per-character HP/mana carried between nodes. NULL on row insert
  -- (start of expedition); first time a combat node resolves the worker
  -- writes the post-fight values here, and the next combat seeds from these.
  -- See docs/expedition-map.md open question #1 (HP/mana between nodes).
  current_hp    INTEGER,
  current_mana  INTEGER,
  max_hp        INTEGER,                            -- effective max incl. run buffs
  max_mana      INTEGER,
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

-- One-row-per-character index of "what expedition is this character actively
-- in right now." PRIMARY KEY on character_id makes the SQLite engine enforce
-- the "at most one active expedition per character" invariant at insert time,
-- which is how /api/expedition/start defends against the start-race TOCTOU
-- (two concurrent /start calls from the same user). On expedition end (status
-- → completed|failed|abandoned) the worker deletes the membership row;
-- ON DELETE CASCADE handles the row when the expedition itself is removed.
CREATE TABLE active_expedition_membership (
  character_id  TEXT PRIMARY KEY REFERENCES characters(slack_user_id) ON DELETE CASCADE,
  expedition_id INTEGER NOT NULL REFERENCES expeditions(id) ON DELETE CASCADE
);
CREATE INDEX idx_active_expedition_membership_expedition
  ON active_expedition_membership(expedition_id);

-- Back-pointer on quests: when a combat node spawns a quest, this is set so
-- the quest resolution callback knows which expedition to advance. Nullable
-- so one-off quests are unaffected.
ALTER TABLE quests ADD COLUMN from_expedition_id INTEGER REFERENCES expeditions(id);
CREATE INDEX idx_quests_from_expedition ON quests(from_expedition_id);
