-- Lodestones (packages/world/src/lodestone.ts): stones that carry modifiers, found in the bounty of a place
-- a crew clears on its atlas and set into another to make its map harder and its bounty richer.
--
-- A crew's stones are kept in its own case, with the atlas: one row for each kind of stone it has (a stone
-- is nothing but what it carries, the modifiers' ids joined with '+'), and how many.
CREATE TABLE atlas_stones (
  crew_id TEXT NOT NULL REFERENCES crews(id),
  mods    TEXT NOT NULL,
  qty     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (crew_id, mods)
);

-- The stone set into a node, written the same way: null for none. It is set before anyone has set out for
-- the node (so the node may have a row with no map yet), and stays with the node if its map is let go and
-- another made.
ALTER TABLE atlas_nodes ADD COLUMN stone TEXT;
