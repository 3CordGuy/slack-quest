-- Web-mode combat state. The QuestRoom Durable Object is the live coordination
-- layer (WS fan-out, in-memory cache); D1 is the system of record so a
-- hibernating DO can rehydrate and a 24h-paused combat survives DO eviction
-- without losing progress.
--
-- One row per active web-mode quest. JSON-serialized CombatState from
-- @gantt-quest/core's combat_machine. Cleared when the quest ends.

CREATE TABLE web_combat_state (
  quest_id INTEGER PRIMARY KEY REFERENCES quests(id) ON DELETE CASCADE,
  state TEXT NOT NULL,           -- JSON-serialized CombatState
  updated_at INTEGER NOT NULL    -- ms epoch of last DO write
);

CREATE INDEX idx_web_combat_state_updated ON web_combat_state(updated_at);
