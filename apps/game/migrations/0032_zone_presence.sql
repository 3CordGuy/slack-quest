-- Who is out on which zone right now, and whether they are in a fight there. A ZoneRoom writes a
-- row when a player's socket opens, updates `fighting` as fights start and end, and removes the row
-- when the socket closes; the Harbor removes it too when the player turns up there. The crew's
-- roster reads it to say where a crewmate is and to let others teleport to them (never into a fight).
CREATE TABLE zone_presence (
  player_id TEXT PRIMARY KEY REFERENCES players(id),
  code      TEXT NOT NULL,
  fighting  INTEGER NOT NULL DEFAULT 0,
  seen_at   INTEGER NOT NULL
);
