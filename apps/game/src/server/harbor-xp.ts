// A little XP from the Harbor's pastimes, written in the same D1 batch as the
// pastime's own result, and announced to whichever rooms the hero is in.
//
// The award is worked out on a read of the character and the day's record
// (`harborXpAward`), then written as two statements appended to the
// pastime's batch:
//
//   1. the day's record, only if the pastime went through (`guard`) and only
//      if this award still fits under the cap (two racing awards cannot both
//      squeeze in);
//   2. the character's new level, XP, stats and unspent points, only if the
//      record was just written (`changes() > 0`) and the character is still
//      as it was read, so a level-up is never applied twice.
//
// If either does not apply, the pastime still happens; it just pays no XP.
//
// A `bonus` (a felling outing's perfect splits) is given on top, whatever the
// cap: it goes to the character but not into the day's record.

import { HARBOR_XP_DAILY_CAP, SPAR_XP_DAILY_BOUTS, gatherDay, harborXpAward, harborXpStatus, harborXpText, sparBoutsLeft, type HarborXpRecord, type HarborPlayer, type HarborXpStatus, type XpMessage } from "@gantt-quest/world";
import { crewFor, getCharacter, statsOf, type Env } from "./db";

/** What the client is told about an award, and what the rooms broadcast. */
export interface XpResult {
  /** All XP given, the bonus included. */
  granted: number;
  asked: number;
  level: number;
  xp: number;
  levelsGained: number;
  /** Harbor XP left today, after this award. */
  left: number;
  /** For the pastime's result: "+4 XP.", or why there was none. */
  text: string;
}

export interface PreparedXp {
  /** Statements to append to the pastime's batch, after the one that decides it. */
  statements(guard?: string): D1PreparedStatement[];
  /** The award if it is written; read `applied(results)` to know. */
  result: XpResult;
  /** Did the award land? Pass the batch results for the statements this returned. */
  applied(results: D1Result[]): boolean;
}

export async function readHarborXp(db: D1Database, playerId: string): Promise<HarborXpRecord | null> {
  return db.prepare("SELECT day, used, spars FROM harbor_xp WHERE player_id = ?").bind(playerId).first<HarborXpRecord>();
}

export async function harborXpFor(db: D1Database, playerId: string): Promise<HarborXpStatus> {
  return harborXpStatus(await readHarborXp(db, playerId), Date.now());
}

/**
 * Work out an award of `amount` Harbor XP (plus `opts.bonus` outside the cap)
 * and the statements that write it. Null without an active character.
 * `guard` (SQL, may use ?1 for the player) decides whether the pastime went
 * through; the default is that the statement just before these changed a row.
 */
export async function prepareXp(db: D1Database, playerId: string, amount: number, opts: { spar?: boolean; bonus?: number } = {}): Promise<PreparedXp | null> {
  const [c, record] = await Promise.all([getCharacter(db, playerId), readHarborXp(db, playerId)]);
  if (c?.status !== "active") return null;
  const now = Date.now();
  const award = harborXpAward({ classId: c.class_id, level: c.level, xp: c.xp, stats: statsOf(c), unspent: c.unspent_points }, record, amount, now, opts.spar, opts.bonus);
  const result: XpResult = {
    granted: award.granted + award.bonus,
    asked: award.asked,
    level: award.next.level,
    xp: award.next.xp,
    levelsGained: award.next.levelsGained,
    left: HARBOR_XP_DAILY_CAP - award.record.used,
    text: harborXpText({ granted: award.granted, asked: award.asked, bonus: award.bonus, levelsGained: award.next.levelsGained }),
  };
  const spars = opts.spar ? 1 : 0;
  // Nothing to give (the cap is reached, or the day's bouts are used up, and no bonus): nothing to write.
  if (award.granted + award.bonus <= 0) {
    const text = opts.spar && award.asked > 0 && sparBoutsLeft(record, now) === 0 ? `No XP: only ${SPAR_XP_DAILY_BOUTS} bouts a day count.` : result.text;
    return { statements: () => [], result: { ...result, level: c.level, xp: c.xp, text }, applied: () => false };
  }
  const n = award.next;
  return {
    result,
    statements(guard = "changes() > 0") {
      return [
        db
          .prepare(
            `INSERT INTO harbor_xp (player_id, day, used, spars) SELECT ?1, ?2, ?3, ?5 WHERE (${guard})
             ON CONFLICT(player_id) DO UPDATE SET
               used = CASE WHEN day = ?2 THEN used + ?3 ELSE ?3 END,
               spars = CASE WHEN day = ?2 THEN spars + ?5 ELSE ?5 END,
               day = ?2
             WHERE day <> ?2 OR (used + ?3 <= ?4 AND spars + ?5 <= ?6)`,
          )
          .bind(playerId, gatherDay(now), award.granted, HARBOR_XP_DAILY_CAP, spars, SPAR_XP_DAILY_BOUTS),
        db
          .prepare(
            `UPDATE characters SET level = ?2, xp = ?3, str = ?4, int_stat = ?5, vit = ?6, agi = ?7, dex = ?8, unspent_points = ?9
             WHERE player_id = ?1 AND status = 'active' AND level = ?10 AND xp = ?11 AND changes() > 0`,
          )
          .bind(playerId, n.level, n.xp, n.stats.str, n.stats.int_stat, n.stats.vit, n.stats.agi, n.stats.dex, n.unspent, c.level, c.xp),
      ];
    },
    applied: (results) => (results[results.length - 1]?.meta.changes ?? 0) > 0,
  };
}

/** What to tell the client once the batch has run: the award, or none if it did not land. */
export function xpOutcome(xp: PreparedXp | null, results: D1Result[]): XpResult | undefined {
  if (!xp) return undefined;
  if (xp.applied(results) || xp.result.granted <= 0) return xp.result;
  return { ...xp.result, granted: 0, levelsGained: 0, text: harborXpText({ granted: 0, asked: xp.result.asked }) };
}

/** The message every room sends for an award. */
export function xpMessage(playerId: string, r: XpResult): XpMessage {
  return { type: "xp", id: playerId, amount: r.granted, level: r.level, xp: r.xp, levelsGained: r.levelsGained };
}

/**
 * Tell the rooms the hero might be standing in: their crew's Harbor, their
 * own hut, and the crew's pub. Each room only passes it on if the hero is
 * there. Never throws.
 */
export async function announceXp(env: Env, playerId: string, r: XpResult): Promise<void> {
  if (r.granted <= 0) return;
  const body = JSON.stringify(xpMessage(playerId, r));
  const post = async (stub: { fetch(url: string, init: RequestInit): Promise<Response> }, url: string, headers: Record<string, string>) => {
    try {
      await stub.fetch(url, { method: "POST", body, headers });
    } catch (err) {
      console.warn("xp:announce-failed", { url, err: err instanceof Error ? err.message : String(err) });
    }
  };
  const crew = await crewFor(env.DB, playerId);
  await Promise.all([
    crew ? post(env.HARBOR_ROOM.get(env.HARBOR_ROOM.idFromName(crew.id)), "https://harbor/xp", { "x-crew-id": crew.id }) : null,
    crew ? post(env.PUB_ROOM.get(env.PUB_ROOM.idFromName(crew.id)), "https://pub/xp", {}) : null,
    post(env.HUT_ROOM.get(env.HUT_ROOM.idFromName(playerId)), "https://hut/xp", { "x-hut-owner": playerId }),
  ]);
}

/**
 * A hero in this room just earned XP (the Worker wrote it to D1 first): note
 * the new level and XP on their socket, so latecomers see the right plate,
 * and tell everyone here so the sparkle plays over their head.
 */
export function relayXp(ctx: DurableObjectState, msg: XpMessage, send: (m: XpMessage) => void): boolean {
  const mine = ctx.getWebSockets(msg.id);
  if (mine.length === 0) return false;
  for (const ws of mine) {
    const p = ws.deserializeAttachment() as HarborPlayer | null;
    if (p) ws.serializeAttachment({ ...p, level: msg.level, xp: msg.xp } satisfies HarborPlayer);
  }
  send(msg);
  return true;
}

/** Read an xp message posted by the Worker. Null if it is not one. */
export async function readXpPost(request: Request): Promise<XpMessage | null> {
  try {
    const m = (await request.json()) as XpMessage;
    if (m?.type !== "xp" || typeof m.id !== "string") return null;
    const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : 0);
    return { type: "xp", id: m.id, amount: num(m.amount), level: Math.max(1, num(m.level)), xp: num(m.xp), levelsGained: num(m.levelsGained) };
  } catch {
    return null;
  }
}
