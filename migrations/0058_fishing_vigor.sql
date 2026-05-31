-- Fishing mini-game vigor — separate from mining and forage so each node
-- has its own bursty cadence. Same shape as vigor_full_at: timestamp when
-- vigor will next be full (cap 3); null / past = full. Each Quick Cast
-- pushes this forward by 1 hour.
ALTER TABLE characters ADD COLUMN fish_vigor_full_at INTEGER;

-- Plays-counter for the Fastest Hook leaderboard. Without this, a single
-- lucky 80ms one-shot tops the board forever; the leaderboard query gates
-- on (fish_plays >= 5) so the ranking reflects actual skill.
ALTER TABLE characters ADD COLUMN fish_plays INTEGER NOT NULL DEFAULT 0;

-- In-flight fishing games. One row per character at a time. The server
-- picks bite_at_ms at /cast (relative ms from cast time) so it can
-- validate the player's reaction window without trusting the client.
CREATE TABLE fish_games (
  character_id    TEXT PRIMARY KEY REFERENCES characters(slack_user_id) ON DELETE CASCADE,
  phase           TEXT NOT NULL DEFAULT 'waiting',  -- 'waiting' | 'reeling'
  cast_at         INTEGER NOT NULL,                 -- ms epoch when the player cast
  bite_at_ms      INTEGER NOT NULL,                 -- ms after cast_at when the bite fires
  reaction_ms     INTEGER,                          -- recorded at /strike, null until then
  quality_score   REAL,                             -- recorded at /reel, 0..1
  bite_window_ms  INTEGER NOT NULL                  -- DEX-modulated catch window at cast time
);
