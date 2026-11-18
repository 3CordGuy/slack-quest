-- The atlas: a crew's chart of landfalls (packages/world/src/atlas.ts). The chart itself is worked out
-- from the crew's id and is never stored; what is kept here is only what a crew has done on it. A node
-- has a row from the first time it is opened: 'open' while the crew is fighting through it, 'cleared'
-- once they have. `zone_code` is the map made for it (a new one is made if that is left idle too long,
-- and `attempts` counts them, so each is a different map).
CREATE TABLE atlas_nodes (
  crew_id    TEXT NOT NULL REFERENCES crews(id),
  node       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',
  zone_code  TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  opened_by  TEXT REFERENCES players(id),
  opened_at  INTEGER NOT NULL,
  cleared_at INTEGER,
  PRIMARY KEY (crew_id, node)
);

-- The node a zone was made for, on a zone the atlas made (kind 'atlas'): its room marks that node
-- cleared for the crew when the map is.
ALTER TABLE zones ADD COLUMN node TEXT;
