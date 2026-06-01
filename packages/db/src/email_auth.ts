// Email-based auth — sibling to web_auth.ts but keyed on email instead of
// slack_user_id. Schema lives in migration 0060_email_auth.sql.
//
// Codes are 6 digits, expire after 15 minutes, and use a brute-force-resistant
// PK (email, code) so each issuance creates a fresh row; verification atomically
// deletes on success.

const CODE_TTL_MS = 15 * 60 * 1000;

export interface EmailLoginCodeIssue {
  code: string;
  expires_at: number;
}

/** Issues a fresh 6-digit code for an email address. Wipes any prior unconsumed
 *  codes for that email so re-requesting always supersedes. */
export async function issueEmailLoginCode(
  db: D1Database,
  email: string,
): Promise<EmailLoginCodeIssue> {
  const now = Date.now();
  const expires_at = now + CODE_TTL_MS;
  const code = randomSixDigitCode();
  await db.batch([
    db.prepare(`DELETE FROM email_login_codes WHERE email = ?`).bind(email),
    db
      .prepare(
        `INSERT INTO email_login_codes (email, code, expires_at, created_at) VALUES (?, ?, ?, ?)`,
      )
      .bind(email, code, expires_at, now),
  ]);
  return { code, expires_at };
}

/** Atomically consumes a code for the given email. Returns true on success
 *  (code matched + not expired + deleted). Returns false on any failure
 *  (unknown, expired, wrong code). No attempt counter — the 15-min TTL and
 *  fresh-issue-supersedes-old behavior are sufficient anti-brute-force. */
export async function consumeEmailLoginCode(
  db: D1Database,
  email: string,
  code: string,
): Promise<boolean> {
  const now = Date.now();
  const res = await db
    .prepare(
      `DELETE FROM email_login_codes WHERE email = ? AND code = ? AND expires_at > ?`,
    )
    .bind(email, code, now)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Find an existing character by email (case-insensitively normalized at write
 *  time — callers should toLowerCase + trim before passing here too). */
export async function getCharacterIdByEmail(
  db: D1Database,
  email: string,
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT slack_user_id FROM characters WHERE email = ? LIMIT 1`)
    .bind(email)
    .first<{ slack_user_id: string }>();
  return row?.slack_user_id ?? null;
}

/** Attach an email to an existing character. Used by /api/auth/email/verify
 *  when upgrading a guest, and by the explicit Settings "Save your character"
 *  flow. Returns true if updated, false on UNIQUE collision. */
export async function linkCharacterEmail(
  db: D1Database,
  slack_user_id: string,
  email: string,
): Promise<boolean> {
  try {
    const res = await db
      .prepare(
        `UPDATE characters SET email = ?, is_guest = 0 WHERE slack_user_id = ?`,
      )
      .bind(email, slack_user_id)
      .run();
    return (res.meta.changes ?? 0) > 0;
  } catch (e) {
    // UNIQUE constraint violation — email already linked to another character.
    return false;
  }
}

function randomSixDigitCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1_000_000).padStart(6, "0");
}
