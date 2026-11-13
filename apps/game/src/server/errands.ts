// The pub's regulars: the server's side. Who is in and what each has going
// come from packages/world/src/regulars.ts, derived from the crew and the
// day; the client only ever names a regular, never terms or a reward.
//
// Paying out is one D1 batch. Its first statement closes the job (or counts
// the trade) and writes a fresh claim token, but only if everything still
// holds: the job is open, the day's cap has room, and the materials are
// there. Every statement after it (take the materials, pay gold, give
// materials, then the XP) runs only if it finds that token, so two requests
// at once pay once, and a short player pays nothing.

import {
  ERRANDS_PER_DAY,
  NO_FACTS,
  RESOURCE_KINDS,
  acceptProblem,
  dayStart,
  errandFor,
  errandProgress,
  gatherDay,
  handInProblem,
  parseErrand,
  regular,
  regularsOn,
  swapProblem,
  type Errand,
  type ErrandRecord,
  type ErrandReward,
  type QuestFacts,
  type RegularId,
  type Resources,
} from "@gantt-quest/world";
import { crewFor, getCharacter, getHut } from "./db";
import { prepareXp, xpOutcome, type XpResult } from "./harbor-xp";

/** One regular's standing with this player, as the panel shows it. */
export interface RegularView {
  regular: RegularId;
  /** Which of the pub's regular spots they stand on. */
  spot: number;
  /** Today's offer. */
  offer: Errand;
  /** A job taken from them and not yet handed in, from today or an earlier day. */
  held: (ErrandRecord & { have: Resources; ready: boolean; problem: string | null }) | null;
  /** Today's offer is a job that has been handed in. */
  doneToday: boolean;
  /** Trades made on today's offer. */
  traded: number;
  /** Why the offer cannot be taken or traded now, if it cannot. */
  problem: string | null;
  /** What the player holds toward today's offer. */
  have: Resources;
}

export interface RegularsView {
  day: string;
  regulars: RegularView[];
  /** Jobs held with regulars who are not in today. */
  away: (ErrandRecord & { ready: boolean })[];
  /** Jobs handed in today, and how many may be. */
  handedIn: number;
  cap: number;
}

interface ErrandRow {
  regular: string;
  day: string;
  errand_json: string;
  accepted_at: number;
  done_at: number | null;
  count: number;
}

const toRecord = (row: ErrandRow): ErrandRecord | null => {
  const errand = parseErrand(row.errand_json);
  return errand && { errand, acceptedAt: row.accepted_at, doneAt: row.done_at, count: row.count };
};

/** A fresh token for one payout. Hex only, so it is safe to write into SQL. */
const token = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function context(db: D1Database, playerId: string) {
  const [c, crew] = await Promise.all([getCharacter(db, playerId), crewFor(db, playerId)]);
  if (c?.status !== "active") return "Create a character first.";
  if (!crew) return "The pub is for crews. Join one first.";
  return { c, crew };
}

/** This player's rows that matter now: every open job, and every row for today's offers. */
async function rowsFor(db: D1Database, playerId: string, day: string): Promise<ErrandRow[]> {
  const rows = await db
    .prepare("SELECT regular, day, errand_json, accepted_at, done_at, count FROM errands WHERE player_id = ?1 AND (done_at IS NULL OR day = ?2)")
    .bind(playerId, day)
    .all<ErrandRow>();
  return rows.results;
}

async function handedInSince(db: D1Database, playerId: string, since: number): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM errands WHERE player_id = ?1 AND kind <> 'trade' AND done_at >= ?2").bind(playerId, since).first<{ n: number }>();
  return row?.n ?? 0;
}

/** When each kind of deed a quest asks for was last done, from what the game already records. */
interface FactTimes {
  rested_at: number | null;
  gave_at: number | null;
  won_at: number | null;
  contract_at: number | null;
}

async function factTimes(db: D1Database, playerId: string): Promise<FactTimes> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT rested_at FROM gathering WHERE player_id = ?1) AS rested_at,
         (SELECT MAX(created_at) FROM crew_project_gifts WHERE player_id = ?1) AS gave_at,
         (SELECT MAX(r.updated_at) FROM runs r JOIN run_players rp ON rp.code = r.code WHERE rp.player_id = ?1 AND r.status = 'victory') AS won_at,
         (SELECT MAX(r.updated_at) FROM runs r JOIN run_contracts rc ON rc.code = r.code WHERE rc.player_id = ?1 AND rc.done = 1) AS contract_at`,
    )
    .bind(playerId)
    .first<FactTimes>();
  return row ?? { rested_at: null, gave_at: null, won_at: null, contract_at: null };
}

/** The deeds done after a job was taken. */
function factsSince(t: FactTimes, since: number): QuestFacts {
  const after = (at: number | null) => at !== null && at > since;
  return { rested: after(t.rested_at), gave: after(t.gave_at), wonVoyage: after(t.won_at), metContract: after(t.contract_at) };
}

export async function regularsView(db: D1Database, playerId: string, now = Date.now()): Promise<RegularsView | string> {
  const ctx = await context(db, playerId);
  if (typeof ctx === "string") return ctx;
  const day = gatherDay(now);
  const [rows, hut, times, handedIn] = await Promise.all([rowsFor(db, playerId, day), getHut(db, playerId), factTimes(db, playerId), handedInSince(db, playerId, dayStart(now))]);
  const records = rows.map((row) => ({ row, record: toRecord(row) })).filter((r): r is { row: ErrandRow; record: ErrandRecord } => !!r.record);
  const open = (id: string) => records.find((r) => r.row.regular === id && r.record.doneAt === null)?.record ?? null;
  const ofToday = (id: string) => records.find((r) => r.row.regular === id && r.row.day === day)?.record ?? null;
  const resources = hut.resources;

  const here = regularsOn(ctx.crew.id, day);
  const regulars = here.map((who, spot): RegularView => {
    const offer = errandFor(ctx.crew.id, day, who);
    const heldRec = open(who.id);
    const todayRec = ofToday(who.id);
    const held = heldRec && (() => {
      const facts = factsSince(times, heldRec.acceptedAt);
      return { ...heldRec, ...errandProgress(heldRec.errand, resources, facts), problem: handInProblem(heldRec, { resources, handedInToday: handedIn, facts }) };
    })();
    const problem = offer.kind === "trade" ? swapProblem(offer, todayRec, resources) : acceptProblem(offer, heldRec, todayRec);
    return {
      regular: who.id,
      spot,
      offer,
      held,
      doneToday: offer.kind !== "trade" && !!todayRec && todayRec.doneAt !== null,
      traded: offer.kind === "trade" ? (todayRec?.count ?? 0) : 0,
      problem,
      have: errandProgress(offer, resources, NO_FACTS).have,
    };
  });
  const away = records
    .filter((r) => r.record.doneAt === null && !here.some((who) => who.id === r.row.regular))
    .map((r) => ({ ...r.record, ready: errandProgress(r.record.errand, resources, factsSince(times, r.record.acceptedAt)).ready }));
  return { day, regulars, away, handedIn, cap: ERRANDS_PER_DAY };
}

/** The regular named, if they are in today, and today's offer from them. */
function inToday(crewId: string, day: string, regularId: unknown) {
  const who = regular(regularId);
  if (!who || !regularsOn(crewId, day).some((r) => r.id === who.id)) return null;
  return { who, offer: errandFor(crewId, day, who) };
}

/** Take on a regular's job for today. */
export async function takeErrand(db: D1Database, playerId: string, regularId: unknown, now = Date.now()): Promise<string | { errand: Errand }> {
  const ctx = await context(db, playerId);
  if (typeof ctx === "string") return ctx;
  const day = gatherDay(now);
  const found = inToday(ctx.crew.id, day, regularId);
  if (!found) return "They are not in today.";
  const rows = await rowsFor(db, playerId, day);
  const held = rows.find((r) => r.regular === found.who.id && r.done_at === null);
  const today = rows.find((r) => r.regular === found.who.id && r.day === day);
  const problem = acceptProblem(found.offer, held ? toRecord(held) : null, today ? toRecord(today) : null);
  if (problem) return problem;
  try {
    // The primary key stops a second take of today's offer; the open index, a second job held with them.
    await db
      .prepare("INSERT INTO errands (player_id, regular, day, kind, errand_json, accepted_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(playerId, found.who.id, day, found.offer.kind, JSON.stringify(found.offer), now)
      .run();
  } catch {
    return "You are already on a job for them.";
  }
  return { errand: found.offer };
}

/** Give up a job held with a regular. Nothing was paid, so nothing is taken back. */
export async function dropErrand(db: D1Database, playerId: string, regularId: unknown): Promise<string | null> {
  const who = regular(regularId);
  if (!who) return "There is nobody by that name here.";
  const res = await db.prepare("DELETE FROM errands WHERE player_id = ? AND regular = ? AND done_at IS NULL").bind(playerId, who.id).run();
  return res.meta.changes > 0 ? null : "You have no job from them.";
}

/** SQL that is true if every amount in `need` is in player ?1's materials. */
function enoughSql(need: Resources): string {
  const parts = RESOURCE_KINDS.filter((k) => (need[k] ?? 0) > 0).map((k) => `COALESCE((SELECT qty FROM resources WHERE player_id = ?1 AND kind = '${k}'), 0) >= ${Math.floor(need[k]!)}`);
  return parts.length > 0 ? parts.join(" AND ") : "1";
}

/** Statements that take `take` and pay `reward` (gold and materials) to player ?1, each only if `claimed` holds. */
function payStatements(db: D1Database, playerId: string, claimed: string, take: Resources, reward: ErrandReward): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  for (const k of RESOURCE_KINDS) {
    const n = Math.floor(take[k] ?? 0);
    if (n > 0) out.push(db.prepare(`UPDATE resources SET qty = qty - ${n} WHERE player_id = ?1 AND kind = '${k}' AND qty >= ${n} AND ${claimed}`).bind(playerId));
  }
  const gold = Math.max(0, Math.floor(reward.gold));
  if (gold > 0) out.push(db.prepare(`UPDATE characters SET gold = gold + ${gold} WHERE player_id = ?1 AND status = 'active' AND ${claimed}`).bind(playerId));
  for (const k of RESOURCE_KINDS) {
    const n = Math.floor(reward.resources?.[k] ?? 0);
    if (n > 0) {
      out.push(
        db
          .prepare(`INSERT INTO resources (player_id, kind, qty) SELECT ?1, '${k}', ${n} WHERE ${claimed} ON CONFLICT(player_id, kind) DO UPDATE SET qty = qty + ${n}`)
          .bind(playerId),
      );
    }
  }
  return out;
}

export interface ErrandPaid {
  errand: Errand;
  reward: ErrandReward;
  xp?: XpResult;
}

/** Hand in a held job: the materials for a fetch go, and the reward comes. */
export async function handInErrand(db: D1Database, playerId: string, regularId: unknown, now = Date.now()): Promise<string | ErrandPaid> {
  const ctx = await context(db, playerId);
  if (typeof ctx === "string") return ctx;
  const day = gatherDay(now);
  if (!inToday(ctx.crew.id, day, regularId)) return "They are not in today. Hand it in when they are.";
  const who = regular(regularId)!;
  const [rows, hut, times, handedIn] = await Promise.all([rowsFor(db, playerId, day), getHut(db, playerId), factTimes(db, playerId), handedInSince(db, playerId, dayStart(now))]);
  const row = rows.find((r) => r.regular === who.id && r.done_at === null);
  const record = row ? toRecord(row) : null;
  const facts = record ? factsSince(times, record.acceptedAt) : NO_FACTS;
  const problem = handInProblem(record, { resources: hut.resources, handedInToday: handedIn, facts });
  if (problem || !record || !row) return problem ?? "You have no job from them to hand in.";
  const { errand } = record;
  if (errand.kind === "trade") return "That is a trade, not a job.";

  const take = errand.kind === "fetch" ? errand.need : {};
  const tok = token();
  const claimed = `EXISTS (SELECT 1 FROM errands WHERE player_id = ?1 AND claim = '${tok}')`;
  const xp = await prepareXp(db, playerId, errand.reward.xp);
  const claim = db
    .prepare(
      `UPDATE errands SET done_at = ?4, claim = ?5 WHERE player_id = ?1 AND regular = ?2 AND day = ?3 AND done_at IS NULL
         AND (SELECT COUNT(*) FROM errands WHERE player_id = ?1 AND kind <> 'trade' AND done_at >= ?6) < ${ERRANDS_PER_DAY}
         AND ${enoughSql(take)}`,
    )
    .bind(playerId, who.id, row.day, now, tok, dayStart(now));
  const pay = payStatements(db, playerId, claimed, take, errand.reward);
  const xpStatements = xp?.statements(claimed) ?? [];
  const res = await db.batch([claim, ...pay, ...xpStatements]);
  if (res[0].meta.changes === 0) {
    // Something changed between the read and the batch: it was handed in already, the cap filled, or the materials went.
    const [after, hutAfter, handedAfter] = await Promise.all([rowsFor(db, playerId, day), getHut(db, playerId), handedInSince(db, playerId, dayStart(now))]);
    const still = after.find((r) => r.regular === who.id && r.done_at === null);
    return handInProblem(still ? toRecord(still) : null, { resources: hutAfter.resources, handedInToday: handedAfter, facts }) ?? "That job is already handed in.";
  }
  return { errand, reward: errand.reward, xp: xpOutcome(xp, res.slice(1 + pay.length)) };
}

/** Make today's trade with a regular, once. */
export async function tradeWithRegular(db: D1Database, playerId: string, regularId: unknown, now = Date.now()): Promise<string | ErrandPaid> {
  const ctx = await context(db, playerId);
  if (typeof ctx === "string") return ctx;
  const day = gatherDay(now);
  const found = inToday(ctx.crew.id, day, regularId);
  if (!found) return "They are not in today.";
  const { who, offer } = found;
  const [rows, hut] = await Promise.all([rowsFor(db, playerId, day), getHut(db, playerId)]);
  const today = rows.find((r) => r.regular === who.id && r.day === day);
  const problem = swapProblem(offer, today ? toRecord(today) : null, hut.resources);
  if (problem || offer.kind !== "trade") return problem ?? "They are not trading today.";

  const tok = token();
  const claimed = `EXISTS (SELECT 1 FROM errands WHERE player_id = ?1 AND claim = '${tok}')`;
  const reward: ErrandReward = { xp: offer.reward.xp, gold: offer.reward.gold, resources: offer.get };
  const xp = await prepareXp(db, playerId, reward.xp);
  // The first trade of the day writes the row; each one after counts on it. Either only with the materials in hand and swaps left.
  const claim = db
    .prepare(
      `INSERT INTO errands (player_id, regular, day, kind, errand_json, accepted_at, done_at, count, claim)
       SELECT ?1, ?2, ?3, 'trade', ?4, ?5, ?5, 1, ?6 WHERE ${enoughSql(offer.give)}
       ON CONFLICT(player_id, regular, day) DO UPDATE SET count = count + 1, claim = ?6 WHERE kind = 'trade' AND count < ?7`,
    )
    .bind(playerId, who.id, day, JSON.stringify(offer), now, tok, offer.times);
  const pay = payStatements(db, playerId, claimed, offer.give, reward);
  const xpStatements = xp?.statements(claimed) ?? [];
  const res = await db.batch([claim, ...pay, ...xpStatements]);
  if (res[0].meta.changes === 0) {
    const [after, hutAfter] = await Promise.all([rowsFor(db, playerId, day), getHut(db, playerId)]);
    const todayAfter = after.find((r) => r.regular === who.id && r.day === day);
    return swapProblem(offer, todayAfter ? toRecord(todayAfter) : null, hutAfter.resources) ?? "That trade did not go through.";
  }
  return { errand: offer, reward, xp: xpOutcome(xp, res.slice(1 + pay.length)) };
}
