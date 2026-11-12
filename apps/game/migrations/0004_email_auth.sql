-- Email sign-in. A guest becomes a durable account by attaching an email;
-- signing in from another browser finds the same player by it.

ALTER TABLE players ADD COLUMN email TEXT;
CREATE UNIQUE INDEX idx_players_email ON players(email) WHERE email IS NOT NULL;

-- One live code per address. A new request replaces the old code; wrong
-- guesses are counted and the code is burned after a few.
CREATE TABLE email_login_codes (
  email      TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
