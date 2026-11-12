-- Gathering at the Harbor: fishing, felling and the quarry. One row per
-- player holds both their stamina (outings started on a UTC day) and the
-- outing in progress, so a reload picks it up where it was.

CREATE TABLE gathering (
  player_id    TEXT PRIMARY KEY REFERENCES players(id),
  day          TEXT NOT NULL,              -- UTC date (YYYY-MM-DD) that `used` counts for
  used         INTEGER NOT NULL DEFAULT 0, -- outings started on `day`
  session_json TEXT,                       -- the outing in progress (server-side state, seed included); null when none
  claim        TEXT                        -- set as an outing is closed; its payout is written only against this value
);
