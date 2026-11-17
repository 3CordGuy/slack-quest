-- The town chest (packages/world/src/townchest.ts): one store a crew shares, standing in the plaza. It opens
-- like a chest at home, and has tabs: general ones (a grid of squares for gear and stacks, the kind a crew
-- buys more of), and one each for materials and for lodestones. A crew's first three tabs are made the first
-- time its chest is opened. A tab's name, its colour (one of a few, or none) and where it stands among the
-- others are the crew's to change.
CREATE TABLE town_tabs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  crew_id    TEXT NOT NULL REFERENCES crews(id),
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'general',   -- general | materials | lodestones
  color      TEXT,
  position   INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX town_tabs_crew ON town_tabs (crew_id, position);

-- The stacks in a tab: a row for each kind of thing, and how many. `kind` is a material's kind, or a
-- lodestone's kind as an item ('lodestone', or 'lodestone:' and what it carries).
CREATE TABLE town_stacks (
  tab_id INTEGER NOT NULL REFERENCES town_tabs(id),
  kind   TEXT NOT NULL,
  qty    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tab_id, kind)
);

-- The gear in a tab. A piece put in leaves its owner's `inventory` and is written here; taken out, it is
-- written into the taker's `inventory` and leaves here. So what is in the chest is nobody's until it is taken.
-- The columns are the ones of `inventory` that say what the piece is. `id` is the one the piece had in
-- `inventory`, and has again when it is taken out (`inventory` never gives an id out twice), so a piece is
-- the same piece wherever it lies.
CREATE TABLE town_gear (
  id              INTEGER PRIMARY KEY,
  tab_id          INTEGER NOT NULL REFERENCES town_tabs(id),
  kind            TEXT NOT NULL,
  ref             TEXT NOT NULL,
  name            TEXT NOT NULL,
  rarity          TEXT NOT NULL,
  slot            TEXT NOT NULL,
  power           INTEGER NOT NULL DEFAULT 0,
  level_req       INTEGER NOT NULL DEFAULT 1,
  icon            TEXT NOT NULL DEFAULT '',
  stat_bonus_json TEXT NOT NULL DEFAULT '{}',
  upgrades        INTEGER NOT NULL DEFAULT 0,
  put_by          TEXT REFERENCES players(id),
  put_at          INTEGER NOT NULL
);
CREATE INDEX town_gear_tab ON town_gear (tab_id);
