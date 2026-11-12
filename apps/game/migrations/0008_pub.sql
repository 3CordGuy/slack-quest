-- What a hero has eaten and drunk at the pub: at most one drink and one meal.
-- The rows are deleted when that hero's next voyage begins.
CREATE TABLE pub_buffs (
  player_id TEXT NOT NULL REFERENCES players(id),
  kind TEXT NOT NULL CHECK (kind IN ('drink', 'food')),
  item_id TEXT NOT NULL,
  bought_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, kind)
);
