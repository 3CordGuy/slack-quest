-- Pub Errands: timed NPC-driven mini-quests offered at the pub.
--
-- Players talk to a named patron, accept an errand (Courier / Procure /
-- Investigate / Mercy), wait the duration in wall-clock time, then collect
-- a reward bag of gold + xp + occasional flavor items. Trust accrues per
-- (character, patron) and gates which errand kinds are offered.
--
-- Yields are rolled lazily on first read after expires_at — same pattern as
-- gathering_tasks (0051_camp.sql). Deterministic by errand id so a status
-- fetch and a claim agree on the same outcome.
--
-- pub_errand_offers: today's rotating offerings, scoped by channel so each
-- channel-pub shares the same daily roster. taken_by flips when a player
-- accepts the offer (pub_errands.id), preventing two players from grabbing
-- the same slot.
--
-- pub_errands: one row per accepted errand. input_resources_json captures
-- the Procure inputs at accept time so cancel can refund without rolling.
--
-- pub_trust: per-(character, patron) trust score 0..10. rare_claimed flips
-- to 1 once the patron's one-shot trust-10 rare errand has been finished.

CREATE TABLE pub_errand_offers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id   TEXT NOT NULL,
  patron_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,        -- 'courier' | 'procure' | 'investigate' | 'mercy' | 'rare'
  tier         TEXT NOT NULL,        -- 'short' | 'medium' | 'long' — drives duration + payout
  generated_at INTEGER NOT NULL,
  taken_by     INTEGER                -- pub_errands.id once accepted; NULL while open
);
CREATE INDEX idx_pub_errand_offers_channel ON pub_errand_offers(channel_id, generated_at);

CREATE TABLE pub_errands (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id           TEXT NOT NULL REFERENCES characters(slack_user_id) ON DELETE CASCADE,
  patron_id              TEXT NOT NULL,
  kind                   TEXT NOT NULL,
  tier                   TEXT NOT NULL,
  started_at             INTEGER NOT NULL,
  expires_at             INTEGER NOT NULL,
  yield_json             TEXT,        -- rolled lazily after expires_at
  claimed_at             INTEGER,     -- NULL until collected
  cancelled_at           INTEGER,     -- mutually exclusive with claimed_at
  input_resources_json   TEXT         -- captured Procure inputs for refund-on-cancel
);
CREATE INDEX idx_pub_errands_active ON pub_errands(character_id, claimed_at, cancelled_at);

CREATE TABLE pub_trust (
  character_id  TEXT NOT NULL REFERENCES characters(slack_user_id) ON DELETE CASCADE,
  patron_id     TEXT NOT NULL,
  score         INTEGER NOT NULL DEFAULT 0,
  rare_claimed  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (character_id, patron_id)
);
