// Which release notes a player has read: the notice board's "!" (see
// src/releases.ts for where the notes come from).

import { RELEASES } from "../releases";

/** The newest release this player has read, or null if they never have. */
export async function seenRelease(db: D1Database, playerId: string): Promise<string | null> {
  const row = await db.prepare("SELECT seen_release FROM players WHERE id = ?").bind(playerId).first<{ seen_release: string | null }>();
  return row?.seen_release ?? null;
}

/**
 * Note that a player has read the board up to this release. Only a release
 * this build lists is stored, so the column never holds anything else.
 * Returns false for an id it does not know.
 */
export async function markReleaseSeen(db: D1Database, playerId: string, id: string): Promise<boolean> {
  if (!RELEASES.some((r) => r.id === id)) return false;
  await db.prepare("UPDATE players SET seen_release = ? WHERE id = ?").bind(id, playerId).run();
  return true;
}
