-- Liars' Roll v2 — bluff variant against the pub bartender.
--
-- The round's truth state (bartender's secret dice + whether they're
-- lying about the zone) is stored server-side so it can't leak through
-- button payloads. Without this, a clever player could inspect the
-- decide-button value before clicking and always pick the winning
-- option — which would let them mint gold.
--
-- Each round is one stake → reveal → decide → resolve cycle. Rows are
-- ephemeral: created on stake-commit, finalized on decide. Old open
-- rounds are harmless (player abandoned mid-flow); they linger until
-- a periodic sweep cleans them. No sweep is implemented in v1 — the
-- table size will stay small (~one row per liars play, finalized on
-- decision).

CREATE TABLE liars_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  stake INTEGER NOT NULL,
  player_dice TEXT NOT NULL,             -- JSON array, e.g. "[3,5,2]"
  bartender_dice TEXT NOT NULL,
  claim TEXT NOT NULL,                   -- 'low' | 'medium' | 'high'
  lied INTEGER NOT NULL,                 -- 0 truthful claim, 1 lying claim
  status TEXT NOT NULL DEFAULT 'open',   -- open | resolved
  outcome TEXT,                          -- null while open; 'trust_win' | 'trust_lose' | 'challenge_win' | 'challenge_lose' on resolve
  payout INTEGER,                        -- gross winnings paid to user (0 if loss)
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE INDEX idx_liars_rounds_user ON liars_rounds(user_id, status);
