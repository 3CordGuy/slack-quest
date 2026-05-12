-- Web app authentication. Two tables:
--
-- `web_login_codes` — short-lived 6-digit codes issued by /sq web-login. The user
-- pastes the code into the web app; the server consumes it and issues a session.
-- Each user has at most one unconsumed code at a time (re-running web-login
-- invalidates the previous code).
--
-- `web_sessions` — long-lived HttpOnly session tokens set as a cookie after a
-- successful code redemption. session_id is a random UUID; identity is the
-- linked slack_user_id from the originating code.

CREATE TABLE web_login_codes (
  code TEXT PRIMARY KEY,
  slack_user_id TEXT NOT NULL,
  slack_team_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,    -- ms epoch, ~5 min after issue
  consumed_at INTEGER,             -- ms epoch when redeemed (NULL = still valid)
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_web_login_codes_user ON web_login_codes(slack_user_id, consumed_at);
CREATE INDEX idx_web_login_codes_expires ON web_login_codes(expires_at);

CREATE TABLE web_sessions (
  session_id TEXT PRIMARY KEY,    -- random UUID
  slack_user_id TEXT NOT NULL,
  slack_team_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,    -- ms epoch, ~30 days after issue
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_web_sessions_user ON web_sessions(slack_user_id);
CREATE INDEX idx_web_sessions_expires ON web_sessions(expires_at);
