// Players in D1: guests and their sessions, and signing in with a code
// sent by email.

import { now, type Player } from "./rows";

// ---------- players and sessions ----------

export async function createGuest(db: D1Database, name: string): Promise<{ player: Player; token: string }> {
  const player: Player = { id: crypto.randomUUID(), name, email: null };
  const token = newToken();
  await db.batch([
    db.prepare("INSERT INTO players (id, name, created_at) VALUES (?, ?, ?)").bind(player.id, name, now()),
    db.prepare("INSERT INTO sessions (token, player_id, created_at) VALUES (?, ?, ?)").bind(token, player.id, now()),
  ]);
  return { player, token };
}

const newToken = () => `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");

export async function createSession(db: D1Database, playerId: string): Promise<string> {
  const token = newToken();
  await db.prepare("INSERT INTO sessions (token, player_id, created_at) VALUES (?, ?, ?)").bind(token, playerId, now()).run();
  return token;
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
}

// ---------- email sign-in ----------

const CODE_TTL_MS = 15 * 60_000;
/** Shortest gap between two code requests for one address. */
const CODE_COOLDOWN_MS = 30_000;
const MAX_CODE_ATTEMPTS = 5;

/** Trimmed and lower-cased, or null if it does not look like an address. */
export function normalizeEmail(raw: unknown): string | null {
  const email = String(raw ?? "").trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/** Issue a fresh six-digit code, replacing any earlier one. Returns "wait" if one was sent moments ago. */
export async function issueEmailCode(db: D1Database, email: string): Promise<string | "wait"> {
  const last = await db.prepare("SELECT created_at FROM email_login_codes WHERE email = ?").bind(email).first<{ created_at: number }>();
  if (last && now() - last.created_at < CODE_COOLDOWN_MS) return "wait";
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  await db
    .prepare(
      `INSERT INTO email_login_codes (email, code, attempts, expires_at, created_at) VALUES (?1, ?2, 0, ?3, ?4)
       ON CONFLICT(email) DO UPDATE SET code = ?2, attempts = 0, expires_at = ?3, created_at = ?4`,
    )
    .bind(email, code, now() + CODE_TTL_MS, now())
    .run();
  return code;
}

/** Check a code. It is used up by a correct guess, by expiring, or by too many wrong guesses. */
export async function consumeEmailCode(db: D1Database, email: string, code: string): Promise<boolean> {
  const row = await db.prepare("SELECT code, attempts, expires_at FROM email_login_codes WHERE email = ?").bind(email).first<{ code: string; attempts: number; expires_at: number }>();
  if (!row) return false;
  const burn = () => db.prepare("DELETE FROM email_login_codes WHERE email = ?").bind(email).run();
  if (row.expires_at < now() || row.attempts >= MAX_CODE_ATTEMPTS) {
    await burn();
    return false;
  }
  if (row.code !== code) {
    await db.prepare("UPDATE email_login_codes SET attempts = attempts + 1 WHERE email = ?").bind(email).run();
    return false;
  }
  await burn();
  return true;
}

export async function playerByEmail(db: D1Database, email: string): Promise<Player | null> {
  return db.prepare("SELECT id, name, email FROM players WHERE email = ?").bind(email).first<Player>();
}

/** Turn a guest into a durable account. False if the address was claimed in the meantime. */
export async function attachEmail(db: D1Database, playerId: string, email: string): Promise<boolean> {
  try {
    const res = await db.prepare("UPDATE players SET email = ? WHERE id = ? AND email IS NULL").bind(email, playerId).run();
    return res.meta.changes > 0;
  } catch {
    return false;
  }
}

export async function createPlayerWithEmail(db: D1Database, email: string): Promise<Player> {
  const player: Player = { id: crypto.randomUUID(), name: "Sailor", email };
  await db.prepare("INSERT INTO players (id, name, email, created_at) VALUES (?, ?, ?, ?)").bind(player.id, player.name, email, now()).run();
  return player;
}

export async function playerForToken(db: D1Database, token: string): Promise<Player | null> {
  return db
    .prepare("SELECT p.id, p.name, p.email FROM sessions s JOIN players p ON p.id = s.player_id WHERE s.token = ?")
    .bind(token)
    .first<Player>();
}
