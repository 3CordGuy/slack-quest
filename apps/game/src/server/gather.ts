// Gathering outings in D1: stamina, the outing in progress, and the payout.
//
// The outing's state (seed and RNG included) lives in `gathering.session_json`
// and never leaves the server; clients get `gatherView` of it. Every write is
// conditional on the row still being as it was read, so two requests racing
// cannot start two outings, replay a roll or be paid twice.

import {
  GATHER_DAILY_OUTINGS,
  REST_COOLDOWN_MS,
  REST_OUTINGS,
  restProblem,
  restReadyAt,
  type RestPlace,
  GATHER_SPOTS,
  GATHER_SPOT_IDS,
  RESOURCE_KINDS,
  gatherDay,
  gatherPayout,
  gatherResetAt,
  gatherView,
  gatherXp,
  perfectSplitXp,
  harborXpStatus,
  outingsLeft,
  startGather,
  statPct,
  stepGather,
  type GatherChoice,
  type GatherSpot,
  type GatherState,
  type GatherView,
  type HarborXpStatus,
  type Resources,
  FISH_SPOTS,
  FISH_SPOT_IDS,
  closeIdleSitting,
  sittingIdle,
  startSitting,
  type AnglerStats,
  type FishSpot,
  ROWBOAT_CREEL_G,
  vesselProblem,
} from "@gantt-quest/world";
import { heroInitFor } from "./db";
import { closeSitting, type SittingPaid } from "./fishing";
import { ownedVessel } from "./fishmarket";
import { prepareXp, readHarborXp, xpOutcome, type XpResult } from "./harbor-xp";

export interface GatherStatus {
  stamina: { left: number; max: number; resetsAt: number };
  /** Harbor XP still to be had today, from any pastime. */
  harborXp: HarborXpStatus;
  /** When the player may next rest, in ms (0 or past: now). */
  restReadyAt: number;
  /** The hero's chance per roll at each spot, from their stats and gear. */
  chances: Record<GatherSpot, number>;
  /** The outing in progress, or the one that just ended. */
  outing: GatherView | null;
}

interface Row {
  day: string;
  used: number;
  session_json: string | null;
  rested_at: number | null;
}

const readRow = (db: D1Database, playerId: string) =>
  db.prepare("SELECT day, used, session_json, rested_at FROM gathering WHERE player_id = ?").bind(playerId).first<Row>();

/** The hero's value for each spot's stat, gear included. Null without an active character. */
async function gatherStats(db: D1Database, playerId: string): Promise<Record<GatherSpot, number> | null> {
  const hero = await heroInitFor(db, playerId);
  if (!hero) return null;
  const of = (spot: GatherSpot) => hero.base[GATHER_SPOTS[spot].stat] + (hero.bonus[GATHER_SPOTS[spot].stat] ?? 0);
  return { fishing: of("fishing"), felling: of("felling"), quarry: of("quarry") };
}

/** What a hero brings to the pier: Strength and Dexterity, gear included. */
async function anglerStats(db: D1Database, playerId: string): Promise<AnglerStats | null> {
  const hero = await heroInitFor(db, playerId);
  if (!hero) return null;
  return { str: hero.base.str + (hero.bonus.str ?? 0), dex: hero.base.dex + (hero.bonus.dex ?? 0) };
}

/**
 * A fishing sitting left alone too long ends by itself, the catch kept and
 * the stamina spent. Nothing ticks to do it: it is noticed here, the next
 * time the player's gathering is looked at. Returns the sitting it closed and
 * what that paid, if it closed one.
 */
async function settleIdle(db: D1Database, playerId: string, row: Row | null): Promise<{ ended: GatherState; paid: SittingPaid } | null> {
  if (!row?.session_json) return null;
  const state = JSON.parse(row.session_json) as GatherState;
  const now = Date.now();
  if (!sittingIdle(state, now)) return null;
  const ended = closeIdleSitting(state, now);
  const paid = await closeSitting(db, playerId, row.session_json, ended);
  return paid ? { ended, paid } : null;
}

async function status(db: D1Database, playerId: string, stats: Record<GatherSpot, number>, ended?: GatherState): Promise<GatherStatus> {
  const [row, xpRecord] = await Promise.all([readRow(db, playerId), readHarborXp(db, playerId)]);
  const now = Date.now();
  return {
    stamina: { left: outingsLeft(row, now), max: GATHER_DAILY_OUTINGS, resetsAt: gatherResetAt(now) },
    harborXp: harborXpStatus(xpRecord, now),
    restReadyAt: restReadyAt(row?.rested_at),
    chances: { fishing: statPct(stats.fishing), felling: statPct(stats.felling), quarry: statPct(stats.quarry) },
    outing: ended ? gatherView(ended, now) : row?.session_json ? gatherView(JSON.parse(row.session_json) as GatherState, now) : null,
  };
}

export async function gatherStatus(db: D1Database, playerId: string): Promise<(GatherStatus & { sitting?: SittingPaid }) | string> {
  const stats = await gatherStats(db, playerId);
  if (!stats) return "Create a character first.";
  const idle = await settleIdle(db, playerId, await readRow(db, playerId));
  if (idle) return { ...(await status(db, playerId, stats, idle.ended)), sitting: idle.paid };
  return status(db, playerId, stats);
}

/**
 * Rest: get back one outing on a bedroll, or two at home, once every twenty
 * minutes. The one statement only writes if the player is tired today and
 * the cooldown has passed, so two requests cannot both count.
 */
export async function rest(db: D1Database, playerId: string, place: RestPlace): Promise<(GatherStatus & { regained: number }) | string> {
  const stats = await gatherStats(db, playerId);
  if (!stats) return "Create a character first.";
  const now = Date.now();
  const before = await readRow(db, playerId);
  const problem = restProblem(before, now);
  if (problem) return problem;
  const res = await db
    .prepare("UPDATE gathering SET used = MAX(0, used - ?2), rested_at = ?3 WHERE player_id = ?1 AND day = ?4 AND used > 0 AND (rested_at IS NULL OR rested_at <= ?5)")
    .bind(playerId, REST_OUTINGS[place], now, gatherDay(now), now - REST_COOLDOWN_MS)
    .run();
  if (res.meta.changes === 0) return "You have only just rested.";
  const after = await status(db, playerId, stats);
  return { ...after, regained: after.stamina.left - outingsLeft(before, now) };
}

/**
 * Start an outing, spending one of the day's three. Fishing from a pier
 * (`pier` given) starts a sitting instead, which needs stamina left but only
 * spends it when it ends. Returns an error string if refused.
 */
export async function startOuting(db: D1Database, playerId: string, spot: unknown, pier?: unknown): Promise<GatherStatus | string> {
  if (!GATHER_SPOT_IDS.includes(spot as GatherSpot)) return "There is nothing to gather there.";
  const stats = await gatherStats(db, playerId);
  if (!stats) return "Create a character first.";
  await settleIdle(db, playerId, await readRow(db, playerId));
  if (spot === "fishing" && pier !== undefined) return startSittingOuting(db, playerId, pier, stats);
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const state = startGather(spot as GatherSpot, seed, stats[spot as GatherSpot]);
  const today = gatherDay(Date.now());
  // One statement decides it: no outing already under way, and stamina left today.
  const res = await db
    .prepare(
      `INSERT INTO gathering (player_id, day, used, session_json) VALUES (?1, ?2, 1, ?3)
       ON CONFLICT(player_id) DO UPDATE SET used = CASE WHEN day = ?2 THEN used + 1 ELSE 1 END, day = ?2, session_json = ?3
       WHERE session_json IS NULL AND (day <> ?2 OR used < ?4)`,
    )
    .bind(playerId, today, JSON.stringify(state), GATHER_DAILY_OUTINGS)
    .run();
  if (res.meta.changes === 0) {
    const row = await readRow(db, playerId);
    return row?.session_json ? "Finish the outing you are on first." : "You are worn out. Come back tomorrow.";
  }
  return status(db, playerId, stats);
}

/** Sit down to fish at `pier`. Stamina is checked, not spent: the sitting spends it when it ends. */
async function startSittingOuting(db: D1Database, playerId: string, pier: unknown, stats: Record<GatherSpot, number>): Promise<GatherStatus | string> {
  if (!FISH_SPOT_IDS.includes(pier as FishSpot)) return "You cannot fish from there.";
  const spot = FISH_SPOTS[pier as FishSpot];
  if (spot.closed) return spot.closed;
  const [angler, vessel] = await Promise.all([anglerStats(db, playerId), ownedVessel(db, playerId)]);
  if (!angler) return "Create a character first.";
  const afloat = vesselProblem(spot.id, vessel);
  if (afloat) return afloat;
  const now = Date.now();
  // Begun in a rowboat, the boat carries more.
  const extra = spot.vessel && vessel === "rowboat" ? ROWBOAT_CREEL_G : 0;
  const state = startSitting(spot.id, crypto.getRandomValues(new Uint32Array(1))[0], angler, now, extra);
  const today = gatherDay(now);
  // As a start: no outing already under way, and stamina left today. Unlike a start, nothing is spent yet.
  const res = await db
    .prepare(
      `INSERT INTO gathering (player_id, day, used, session_json) VALUES (?1, ?2, 0, ?3)
       ON CONFLICT(player_id) DO UPDATE SET used = CASE WHEN day = ?2 THEN used ELSE 0 END, day = ?2, session_json = ?3
       WHERE session_json IS NULL AND (day <> ?2 OR used < ?4)`,
    )
    .bind(playerId, today, JSON.stringify(state), GATHER_DAILY_OUTINGS)
    .run();
  if (res.meta.changes === 0) {
    const row = await readRow(db, playerId);
    return row?.session_json ? "Finish the outing you are on first." : "You are worn out. Come back tomorrow.";
  }
  return status(db, playerId, stats);
}

/** Statements that add a payout, each only if this request is the one that closed the outing. */
function payoutStatements(db: D1Database, playerId: string, claim: string, paid: Resources): D1PreparedStatement[] {
  return RESOURCE_KINDS.filter((kind) => paid[kind]).map((kind) =>
    db
      .prepare(
        `INSERT INTO resources (player_id, kind, qty)
         SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM gathering WHERE player_id = ?1 AND claim = ?4)
         ON CONFLICT(player_id, kind) DO UPDATE SET qty = qty + ?3`,
      )
      .bind(playerId, kind, paid[kind]!, claim),
  );
}

/**
 * How far behind the server's own clock a reported stop may be. The client's
 * clock starts when the marker reaches it, after the aim has been saved and
 * sent, so a fair report trails the server by that delay plus the trip back.
 * Too tight and honest players on a slow line are overruled.
 */
const TIMING_SLACK_MS = 3000;

/**
 * Put the server's clock on a timed choice. An aim, the quarry's start and its blows are stamped with now. A stop
 * is judged by when the client says the player pressed, which is what the
 * player saw, and is believed if it falls between when the request arrived
 * and a few seconds before that. Anything else (a stop "from the future", or one
 * far older than the request) is judged at the server's own estimate.
 */
function timed(state: GatherState, choice: GatherChoice, now: number): GatherChoice {
  // A sitting judges its own hook against the clock (sitting.ts): every choice in one just carries the server's time.
  if (state.sitting) return { ...choice, now } as GatherChoice;
  // Felling's rounds and the quarry's clock and blows: when one begins and when its report arrives are always the server's clock, never the client's.
  if (choice.t === "aim" || choice.t === "begin" || choice.t === "chopped" || choice.t === "split" || choice.t === "dig" || choice.t === "blows") return { ...choice, now };
  if (choice.t !== "push" || !state.aim) return choice;
  const elapsed = now - state.aim.startedAt;
  const said = Number(choice.at);
  const at = Number.isFinite(said) && said >= 0 && said <= elapsed + 50 && said >= elapsed - TIMING_SLACK_MS ? said : Math.max(0, elapsed - 150);
  return { ...choice, at };
}

/** Apply one choice to the outing in progress. A finished outing is paid and cleared in the same batch. */
export async function stepOuting(db: D1Database, playerId: string, choice: unknown): Promise<(GatherStatus & { paid?: Resources; xp?: XpResult; sitting?: SittingPaid }) | string> {
  const stats = await gatherStats(db, playerId);
  if (!stats) return "Create a character first.";
  const row = await readRow(db, playerId);
  if (!row?.session_json) return "You are not out gathering.";
  const idle = await settleIdle(db, playerId, row);
  if (idle) return { ...(await status(db, playerId, stats, idle.ended)), paid: idle.paid.paid, xp: idle.paid.xp, sitting: idle.paid };
  const current = JSON.parse(row.session_json) as GatherState;
  let asked = (choice ?? {}) as GatherChoice;
  // A cast afloat is judged against the boat the hero really owns, never one the client names.
  if (current.sitting && asked.t === "cast") asked = { ...asked, vessel: await ownedVessel(db, playerId) };
  else if (asked.t === "cast") asked = { ...asked, vessel: null };
  const step = stepGather(current, timed(current, asked, Date.now()));
  if (step.error) return step.error;
  const next = step.state;

  if (next.status === "active") {
    const res = await db
      .prepare("UPDATE gathering SET session_json = ?1 WHERE player_id = ?2 AND session_json = ?3")
      .bind(JSON.stringify(next), playerId, row.session_json)
      .run();
    if (res.meta.changes === 0) return "That was already played. Try again.";
    return status(db, playerId, stats);
  }

  if (next.sitting) {
    const closed = await closeSitting(db, playerId, row.session_json, next);
    if (!closed) return "That was already played. Try again.";
    return { ...(await status(db, playerId, stats, next)), paid: closed.paid, xp: closed.xp, sitting: closed };
  }

  const paid = gatherPayout(next);
  const claim = crypto.randomUUID();
  // A little XP, more for a good haul, only if this request is the one that closed the outing; and one for every
  // perfect split, outside the daily cap.
  const xp = await prepareXp(db, playerId, gatherXp(next, Object.values(paid).reduce((a, n) => a + (n ?? 0), 0)), { bonus: perfectSplitXp(next) });
  const xpStatements = xp?.statements(`EXISTS (SELECT 1 FROM gathering WHERE player_id = ?1 AND claim = '${claim}')`) ?? [];
  const results = await db.batch([
    db.prepare("UPDATE gathering SET session_json = NULL, claim = ?1 WHERE player_id = ?2 AND session_json = ?3").bind(claim, playerId, row.session_json),
    ...payoutStatements(db, playerId, claim, paid),
    ...xpStatements,
  ]);
  if (results[0].meta.changes === 0) return "That was already played. Try again.";
  return { ...(await status(db, playerId, stats, next)), paid, xp: xpOutcome(xp, results) };
}
