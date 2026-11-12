-- A little XP from the Harbor's pastimes, capped per UTC day. One row per
-- player, kept the way gathering stamina is: `day` is the UTC date the
-- counts are for, and a row from an earlier day counts as zero.

CREATE TABLE harbor_xp (
  player_id TEXT PRIMARY KEY REFERENCES players(id),
  day       TEXT NOT NULL,              -- UTC date (YYYY-MM-DD) that `used` and `spars` count for
  used      INTEGER NOT NULL DEFAULT 0, -- Harbor XP given on `day`
  spars     INTEGER NOT NULL DEFAULT 0  -- sparring bouts counted for XP on `day`
);
