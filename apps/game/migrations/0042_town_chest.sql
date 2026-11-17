-- The town chest (packages/world/src/townchest.ts): one store a crew shares, kept at the works. It has
-- tabs, each for one sort of thing (lodestones; materials), and each holds stacks: a row here for each
-- kind of thing in a tab, and how many. `kind` is a material's kind, or a lodestone's kind as an item
-- ('lodestone', or 'lodestone:' and what it carries).
CREATE TABLE town_chest (
  crew_id TEXT NOT NULL REFERENCES crews(id),
  tab     TEXT NOT NULL,
  kind    TEXT NOT NULL,
  qty     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (crew_id, tab, kind)
);

-- How many rows of squares a tab has been made, once anyone has paid for more than it starts with.
CREATE TABLE town_chest_tabs (
  crew_id TEXT NOT NULL REFERENCES crews(id),
  tab     TEXT NOT NULL,
  rows    INTEGER NOT NULL,
  PRIMARY KEY (crew_id, tab)
);
