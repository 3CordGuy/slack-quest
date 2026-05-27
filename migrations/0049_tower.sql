-- Climb-the-Tower lifetime stats per character.
--   tower_floors_climbed : sum of floors cleared across every tower run
--                          (including runs that ended in a wipe partway up).
--   tower_kills          : enemies slain inside any tower run.
--   tower_best_floor     : monotonic high-water mark of the deepest floor
--                          reached on any single run. Drives the leaderboard.
ALTER TABLE characters ADD COLUMN tower_floors_climbed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN tower_kills          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN tower_best_floor     INTEGER NOT NULL DEFAULT 0;
