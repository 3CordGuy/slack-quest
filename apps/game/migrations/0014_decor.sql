-- Decor: small things placed freely within a hex or on top of furniture, and
-- containers that hold decorations, gear and materials.

-- A small thing's offset and turn: from the middle of its hex, or, standing
-- on another furnishing (on_id), from the middle of that piece's top.
ALTER TABLE furnishings ADD COLUMN x REAL NOT NULL DEFAULT 0;
ALTER TABLE furnishings ADD COLUMN z REAL NOT NULL DEFAULT 0;
ALTER TABLE furnishings ADD COLUMN angle REAL NOT NULL DEFAULT 0;
ALTER TABLE furnishings ADD COLUMN on_id INTEGER;
-- Kept inside a container (another furnishing) rather than placed or in storage.
ALTER TABLE furnishings ADD COLUMN in_id INTEGER;

-- Gear kept in a container: out of the bag, so it cannot be worn or sold until it is taken out.
ALTER TABLE inventory ADD COLUMN stored_in INTEGER;

-- Stacks of materials kept in a container, out of the owner's pool.
CREATE TABLE stash (
  furnishing_id INTEGER NOT NULL,
  player_id     TEXT NOT NULL REFERENCES players(id),
  kind          TEXT NOT NULL,
  qty           INTEGER NOT NULL,
  PRIMARY KEY (furnishing_id, kind)
);
CREATE INDEX idx_stash_player ON stash(player_id);
