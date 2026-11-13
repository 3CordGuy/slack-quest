-- The pub's regulars and their small jobs (packages/world/src/regulars.ts).
-- Who is in, and what each one has going, is derived from the crew and the
-- UTC day; only what a player took on is stored.
--
-- One row per player, regular and offer day. A fetch or a quest is written
-- when it is taken (done_at NULL) and closed when handed in. A trade is
-- written on the first swap of the day, already closed, and `count` counts
-- the swaps. `claim` is set by the statement that pays out; the statements
-- that move gold, materials and XP run only if they find it, so one batch
-- pays once however many requests arrive together.
CREATE TABLE errands (
  player_id   TEXT NOT NULL REFERENCES players(id),
  regular     TEXT NOT NULL,
  day         TEXT NOT NULL,               -- UTC date (YYYY-MM-DD) of the offer
  kind        TEXT NOT NULL CHECK (kind IN ('fetch', 'trade', 'quest')),
  errand_json TEXT NOT NULL,               -- the terms as offered, so a job taken yesterday means the same today
  accepted_at INTEGER NOT NULL,
  done_at     INTEGER,                     -- handed in (or first traded); NULL while held
  count       INTEGER NOT NULL DEFAULT 0,  -- trades made on this offer
  claim       TEXT,
  PRIMARY KEY (player_id, regular, day)
);
-- One job held at a time with each regular.
CREATE UNIQUE INDEX idx_errands_open ON errands(player_id, regular) WHERE done_at IS NULL;
-- Jobs handed in today, for the daily cap.
CREATE INDEX idx_errands_done ON errands(player_id, done_at);
