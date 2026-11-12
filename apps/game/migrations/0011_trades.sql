-- Offers between crewmates: gear, gold and hut materials one player will
-- hand another, and the gold and materials asked back. An offer is `open`
-- until it is accepted, declined, withdrawn, failed (someone no longer held
-- what they promised) or expired. Nothing is held in escrow: the goods move
-- only when the offer is accepted, in one batch that checks both sides.

CREATE TABLE trades (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  crew_id      TEXT NOT NULL REFERENCES crews(id),
  from_id      TEXT NOT NULL REFERENCES players(id),
  to_id        TEXT NOT NULL REFERENCES players(id),
  -- The two player ids, smaller first, joined by '|': one open offer per pair, whoever made it.
  pair         TEXT NOT NULL,
  -- Set when the offer was made on an island: the voyage both must still be on.
  run_code     TEXT REFERENCES runs(code),
  give_json    TEXT NOT NULL,          -- { items: [inventory ids], gold, resources }
  ask_json     TEXT NOT NULL,          -- { gold, resources }
  status       TEXT NOT NULL DEFAULT 'open',  -- open | accepted | declined | withdrawn | failed | expired
  reason       TEXT,                   -- why it failed, in words
  -- Written by the statement that accepts the offer; the statements that move the goods run only if they find it.
  settle_token TEXT,
  created_at   INTEGER NOT NULL,
  closed_at    INTEGER,
  CHECK (from_id <> to_id)
);
CREATE UNIQUE INDEX idx_trades_open_pair ON trades(pair) WHERE status = 'open';
CREATE INDEX idx_trades_from ON trades(from_id, status);
CREATE INDEX idx_trades_to ON trades(to_id, status);
