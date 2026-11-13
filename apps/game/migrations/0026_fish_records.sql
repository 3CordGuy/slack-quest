-- Fishing, records and mounts: which Catch Book pages a player has been
-- rewarded for, the record fish hung on each crew's pub wall, and the title
-- a full Catch Book earns.

CREATE TABLE book_rewards (
  player_id  TEXT NOT NULL REFERENCES players(id),
  page       TEXT NOT NULL,              -- a Catch Book page, or 'book' for the whole of it
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, page)
);

CREATE TABLE pub_mounts (
  crew_id   TEXT NOT NULL,
  slot      INTEGER NOT NULL,            -- 0 to PUB_MOUNT_SLOTS - 1, a place on the pub's wall
  fish_id   TEXT NOT NULL,
  species   TEXT NOT NULL,
  player_id TEXT NOT NULL,
  PRIMARY KEY (crew_id, slot)
);
CREATE UNIQUE INDEX pub_mounts_one_per_kind ON pub_mounts (crew_id, species);

ALTER TABLE characters ADD COLUMN title TEXT;
