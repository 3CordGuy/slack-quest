-- Fishing, rebuilt: caught fish are kept as fish, each with its own weight
-- and length, and every player has a Catch Book of personal bests. Each crew
-- keeps one record per species (the pub belongs to a crew).

CREATE TABLE fish (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL REFERENCES players(id),
  species       TEXT NOT NULL,             -- an id in FISH (packages/world/src/fishcatalog.ts)
  grams         INTEGER NOT NULL,
  mm            INTEGER NOT NULL,
  specimen      INTEGER NOT NULL DEFAULT 0,
  spot          TEXT NOT NULL,             -- where it was caught: west | middle | east | shore | sea
  caught_at     INTEGER NOT NULL,
  place         TEXT NOT NULL DEFAULT 'icebox', -- icebox | trophy | hut | pub | sold
  furnishing_id INTEGER                    -- the hut mount it hangs on, when place = 'hut'
);
CREATE INDEX fish_by_player ON fish (player_id, place);

-- The Catch Book: one row per species a player has met. caught = 0 with lost > 0 is "got away".
CREATE TABLE fish_bests (
  player_id TEXT NOT NULL REFERENCES players(id),
  species   TEXT NOT NULL,
  grams     INTEGER NOT NULL DEFAULT 0,    -- the heaviest landed, kept or thrown back
  mm        INTEGER NOT NULL DEFAULT 0,
  fish_id   TEXT,                          -- that one, if it was kept
  first_at  INTEGER,                       -- first landed
  best_at   INTEGER,
  caught    INTEGER NOT NULL DEFAULT 0,
  lost      INTEGER NOT NULL DEFAULT 0,
  specimen  INTEGER NOT NULL DEFAULT 0,    -- a specimen has been landed
  PRIMARY KEY (player_id, species)
);

-- Crew records: the heaviest kept catch of each species by anyone in the crew.
CREATE TABLE fish_records (
  crew_id   TEXT NOT NULL,
  species   TEXT NOT NULL,
  grams     INTEGER NOT NULL,
  mm        INTEGER NOT NULL,
  fish_id   TEXT,
  player_id TEXT NOT NULL,
  caught_at INTEGER NOT NULL,
  PRIMARY KEY (crew_id, species)
);
