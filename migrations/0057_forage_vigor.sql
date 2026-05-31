-- Foraging mini-game vigor — separate from the mining pool so each node
-- has its own bursty cadence. Same shape as vigor_full_at: timestamp when
-- vigor will next be full (cap 3); null / past = full. Each Quick Forage
-- pushes this forward by 1 hour.
ALTER TABLE characters ADD COLUMN forage_vigor_full_at INTEGER;

-- In-flight foraging games. One row per character at a time — an active row
-- means the player has a Quick Forage open. The grid is server-authoritative
-- (no signed state needed) and gets deleted on bank/abandon.
CREATE TABLE forage_games (
  character_id   TEXT PRIMARY KEY REFERENCES characters(slack_user_id) ON DELETE CASCADE,
  grid_json      TEXT NOT NULL,       -- 4x4 array of ForageCellKind values
  revealed_json  TEXT NOT NULL DEFAULT '[]',  -- array of [r,c] coordinates revealed so far
  hp_taken       INTEGER NOT NULL DEFAULT 0,
  flips_total    INTEGER NOT NULL,    -- the budget granted at start (5-7 based on INT)
  started_at     INTEGER NOT NULL
);
