-- 🪨📜🗡 Stone-Parchment-Dagger — multiplayer pub mini-game.
--
-- Two players face off (initiator + challenger), each stakes gold,
-- spectators side-bet on either player. House bumps the winner's pot
-- by a percentage of the total wagered. Throw types live in code
-- (flavor.ts) so we can iterate without migrations.
--
-- Match lifecycle:
--   open       — initiator has staked + thrown, waiting for an opponent
--   resolving  — both staked + thrown; resolution about to land (transient)
--   done       — resolved, payouts recorded
--   cancelled  — initiator cancelled OR 24h lazy expiry; stakes/bets refunded
--
-- One open match per channel at a time (enforced in handlers; index
-- supports the check). Lazy expiry: any open match older than 24h is
-- swept to cancelled+refunded when handlePub/handleTown next renders.
--
-- spd_bets carries one row per (match, bettor) — primary key prevents
-- double-betting and serves as the race guard at INSERT OR IGNORE time.

CREATE TABLE spd_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  initiator_user_id TEXT NOT NULL,
  initiator_stake INTEGER NOT NULL,
  initiator_throw TEXT NOT NULL,           -- 'stone' | 'parchment' | 'dagger'
  challenger_user_id TEXT,                 -- null while open
  challenger_throw TEXT,                   -- null while open
  status TEXT NOT NULL DEFAULT 'open',     -- open | resolving | done | cancelled
  winner_user_id TEXT,                     -- null on tie or while open
  house_bump INTEGER,                      -- recorded at resolution
  message_ts TEXT,                         -- public-channel message ts; used to thread updates
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE INDEX idx_spd_matches_channel_status ON spd_matches(channel_id, status);

CREATE TABLE spd_bets (
  match_id INTEGER NOT NULL,
  bettor_user_id TEXT NOT NULL,
  side TEXT NOT NULL,                      -- 'initiator' | 'challenger'
  amount INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, bettor_user_id)
);
