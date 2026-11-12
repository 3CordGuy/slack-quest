-- The apothecary and the smithy, two Harbor crew projects.

-- A hero's brew bag: what they have brewed at the apothecary and not yet
-- taken to sea. At most one of each brew; the rows a voyage used are deleted
-- when it sails.
CREATE TABLE brews (
  player_id TEXT NOT NULL REFERENCES players(id),
  brew_id TEXT NOT NULL,
  brewed_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, brew_id)
);

-- Steps of work done on an item at the smithy (+1 power each, already
-- counted in `power`). It stays on the row, so it goes with the item in a trade.
ALTER TABLE inventory ADD COLUMN upgrades INTEGER NOT NULL DEFAULT 0 CHECK (upgrades BETWEEN 0 AND 3);
