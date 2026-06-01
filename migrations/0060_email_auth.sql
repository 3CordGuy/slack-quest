-- Email-based authentication, replacing the Slack 6-digit code as the
-- primary onboarding path. Slack's flow (consumeWebLoginCode against the
-- existing web_login_codes table) stays in place for backward compat;
-- this migration adds parallel infrastructure for email + guest accounts.
--
--   characters.email    : nullable; UNIQUE so each email maps to at most one
--                         character. Null on guests until they "Save your
--                         character" by attaching an email.
--   characters.is_guest : 1 when the row was created via /api/auth/guest
--                         (random uuid id, no email). Flips to 0 once the
--                         player links an email. Drives the "Guest" badge
--                         in the avatar UI.
--   email_login_codes   : short-lived 6-digit codes mailed to the player.
--                         15-minute TTL; rows wiped on consume or expire.

ALTER TABLE characters ADD COLUMN email    TEXT;
ALTER TABLE characters ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX idx_characters_email ON characters(email) WHERE email IS NOT NULL;

CREATE TABLE email_login_codes (
  email      TEXT NOT NULL,
  code       TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (email, code)
);
CREATE INDEX idx_email_login_codes_expires ON email_login_codes(expires_at);
