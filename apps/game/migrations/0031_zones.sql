-- Zones: self-contained maps a party walks freely and fights on, turn by turn, on the tiles
-- themselves (packages/world/src/zone). One row per map: the seed and options it was made from,
-- and its whole state as the ZoneRoom Durable Object last saved it. `status` is 'open' while
-- everyone is walking freely and 'fight' while a fight is on.
CREATE TABLE zones (
  code         TEXT PRIMARY KEY,
  seed         TEXT NOT NULL,
  options_json TEXT NOT NULL,
  state_json   TEXT,
  status       TEXT NOT NULL DEFAULT 'open',
  created_by   TEXT NOT NULL REFERENCES players(id),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
