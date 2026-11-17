-- The smith and the apothecary keep shop inside their buildings now, sell from their own stock for
-- gold, and can be haggled with (packages/world/src/keepers.ts). One row for each thing a player
-- haggled over or bought from a keeper on a day:
--   ask    what they asked for when they haggled ('nudge', 'push', 'lowball'), or NULL if they have not.
--          One try a day for each thing.
--   pct    how much came off the price for the rest of that day: 0 if the keeper would not have it.
--   bought how many of it they have bought that day, against the keeper's daily limit.
-- `entry` names the thing: 'flask:healing', 'gear:2' (the smith's rack, by index), 'work:123' (the
-- smith's work on inventory item 123). `day` is the UTC date, as for gathering.
CREATE TABLE keeper_deals (
  player_id TEXT NOT NULL REFERENCES players(id),
  shop      TEXT NOT NULL,
  day       TEXT NOT NULL,
  entry     TEXT NOT NULL,
  ask       TEXT,
  pct       INTEGER NOT NULL DEFAULT 0,
  bought    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, shop, day, entry)
);
