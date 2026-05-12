// Web app auth: 6-digit login codes + session cookies.
// Schema lives in migration 0014_web_auth.sql.

const CODE_TTL_MS = 5 * 60 * 1000;             // 5 min
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_CODE_ATTEMPTS = 5;

export interface WebLoginCodeIssue {
  code: string;        // 6-digit string, zero-padded
  expires_at: number;  // ms epoch
}

// Issues a fresh 6-digit code for the given Slack user. Invalidates any existing
// unconsumed code for that user first, so each user has at most one live code at
// a time and re-running /sq web-login always supersedes the previous attempt.
export async function issueWebLoginCode(
  db: D1Database,
  slack_user_id: string,
  slack_team_id: string,
): Promise<WebLoginCodeIssue> {
  const now = Date.now();
  const expires_at = now + CODE_TTL_MS;
  const code = randomSixDigitCode();

  await db.batch([
    db
      .prepare(
        `UPDATE web_login_codes SET consumed_at = ?
         WHERE slack_user_id = ? AND consumed_at IS NULL`,
      )
      .bind(now, slack_user_id),
    db
      .prepare(
        `INSERT INTO web_login_codes
         (code, slack_user_id, slack_team_id, expires_at, attempts, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
      )
      .bind(code, slack_user_id, slack_team_id, expires_at, now),
  ]);

  return { code, expires_at };
}

export interface WebLoginCodeRedemption {
  slack_user_id: string;
  slack_team_id: string;
}

// Atomically consumes a 6-digit code. Returns the identifying Slack user on
// success, null on any failure (unknown code, expired, already consumed, too
// many failed attempts). Each failed attempt bumps the attempts counter so
// brute force gets locked out at MAX_CODE_ATTEMPTS tries within the 5-min
// window.
export async function consumeWebLoginCode(
  db: D1Database,
  code: string,
): Promise<WebLoginCodeRedemption | null> {
  const now = Date.now();
  const update = await db
    .prepare(
      `UPDATE web_login_codes SET consumed_at = ?
       WHERE code = ?
         AND consumed_at IS NULL
         AND expires_at > ?
         AND attempts < ?`,
    )
    .bind(now, code, now, MAX_CODE_ATTEMPTS)
    .run();

  if ((update.meta.changes ?? 0) === 0) {
    // Best-effort attempt counter bump. Only meaningful if the code exists and
    // hasn't been consumed; the WHERE filter no-ops for already-consumed rows.
    await db
      .prepare(
        `UPDATE web_login_codes SET attempts = attempts + 1
         WHERE code = ? AND consumed_at IS NULL`,
      )
      .bind(code)
      .run();
    return null;
  }

  const row = await db
    .prepare(`SELECT slack_user_id, slack_team_id FROM web_login_codes WHERE code = ?`)
    .bind(code)
    .first<WebLoginCodeRedemption>();
  return row ?? null;
}

export interface WebSession {
  session_id: string;
  slack_user_id: string;
  slack_team_id: string;
  expires_at: number;
}

// Creates a session for the redeemed Slack user and returns the new session_id
// (a random UUID) to set as an HttpOnly cookie. 30-day TTL.
export async function createWebSession(
  db: D1Database,
  slack_user_id: string,
  slack_team_id: string,
): Promise<WebSession> {
  const now = Date.now();
  const expires_at = now + SESSION_TTL_MS;
  const session_id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO web_sessions
       (session_id, slack_user_id, slack_team_id, expires_at, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(session_id, slack_user_id, slack_team_id, expires_at, now, now)
    .run();
  return { session_id, slack_user_id, slack_team_id, expires_at };
}

// Resolves a session cookie to its Slack user, or null if expired/unknown.
// Refreshes last_seen_at on every hit so we can later prune idle sessions.
export async function getWebSession(
  db: D1Database,
  session_id: string,
): Promise<WebSession | null> {
  const now = Date.now();
  const row = await db
    .prepare(
      `SELECT session_id, slack_user_id, slack_team_id, expires_at
       FROM web_sessions WHERE session_id = ? AND expires_at > ?`,
    )
    .bind(session_id, now)
    .first<WebSession>();
  if (!row) return null;
  // Fire-and-forget last_seen bump. Cheap; not awaited.
  db.prepare(`UPDATE web_sessions SET last_seen_at = ? WHERE session_id = ?`)
    .bind(now, session_id)
    .run();
  return row;
}

export async function deleteWebSession(db: D1Database, session_id: string): Promise<void> {
  await db.prepare(`DELETE FROM web_sessions WHERE session_id = ?`).bind(session_id).run();
}

// Six-digit zero-padded random code via Web Crypto. ~20 bits of entropy is
// enough given the 5-min expiry + 5-attempt lockout + per-user invalidation.
function randomSixDigitCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1_000_000).padStart(6, "0");
}
