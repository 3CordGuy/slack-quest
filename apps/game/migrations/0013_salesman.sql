-- Traveling salesmen in the pub. Who visits, and what they carry, is derived
-- from the crew and the time; only what each player bought on a visit is
-- stored, so each entry can be bought once per player per visit.
CREATE TABLE salesman_purchases (
  player_id  TEXT NOT NULL REFERENCES players(id),
  crew_id    TEXT NOT NULL,
  visit      INTEGER NOT NULL,
  salesman   TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, crew_id, visit, salesman, idx)
);
