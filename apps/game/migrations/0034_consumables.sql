-- What a hero carries to drink or throw on a map (healing potions, flasks, bombs): so many of each
-- kind, in stacks in the pack beside the materials. A map reads them when the hero walks in and takes
-- one away each time one is used, so what is left is still there on the next map.
CREATE TABLE consumables (
  player_id TEXT NOT NULL REFERENCES players(id),
  kind      TEXT NOT NULL,
  qty       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, kind)
);

-- Every hero starts with the same small kit (STARTING_ITEMS in packages/world/src/zone/kit.ts, given
-- to a new hero as they are confirmed). Those already out in the world are given it here.
INSERT INTO consumables (player_id, kind, qty)
SELECT c.player_id, k.kind, k.qty
FROM characters c
JOIN (
  SELECT 'healing' AS kind, 2 AS qty
  UNION ALL SELECT 'poison', 2
  UNION ALL SELECT 'fire', 1
  UNION ALL SELECT 'oil', 1
  UNION ALL SELECT 'water', 1
) k
WHERE c.status = 'active';
