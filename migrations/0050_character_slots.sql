-- Multi-character slots (web only). The active character continues to live in
-- the `characters` table — one row per slack_user_id, unchanged. Up to two
-- additional saved builds are stashed as JSON snapshots in `character_slots`.
-- Switching slots = snapshot the current active, restore the target snapshot.
--
-- Slot identity (1, 2, 3) is stable across switches. The active character
-- carries its slot number on `characters.active_slot`; the empty slots are
-- the set {1,2,3} minus active_slot minus occupied character_slots rows.
--
-- Decoupled from the characters lifecycle (no FK) so a Slack /gq new doesn't
-- silently nuke web-saved slots — the user can still activate a saved slot to
-- resurrect a stashed build.

ALTER TABLE characters ADD COLUMN active_slot INTEGER NOT NULL DEFAULT 1;

CREATE TABLE character_slots (
  slack_user_id   TEXT NOT NULL,
  slot            INTEGER NOT NULL CHECK (slot >= 1 AND slot <= 3),
  -- Display summary (denormalised for cheap listing without parsing JSON):
  name            TEXT NOT NULL,
  class           TEXT NOT NULL,
  level           INTEGER NOT NULL,
  gender          TEXT,
  -- Full Character row serialized as JSON (excluding slack_user_id/team_id —
  -- always the slot's owning user). Restored verbatim on activate.
  character_json  TEXT NOT NULL,
  -- Full inventory rows as JSON array. Restored as fresh inventory rows
  -- (autoincrement ids are re-issued) on activate.
  inventory_json  TEXT NOT NULL,
  saved_at        INTEGER NOT NULL,
  PRIMARY KEY (slack_user_id, slot)
);
CREATE INDEX idx_character_slots_user ON character_slots(slack_user_id);
