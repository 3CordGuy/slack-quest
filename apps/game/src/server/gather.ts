// Gathering outings in D1: stamina, the outing in progress, and the payout.
//
// The outing's state (seed and RNG included) lives in `gathering.session_json`
// and never leaves the server; clients get `gatherView` of it. Every write is
// conditional on the row still being as it was read, so two requests racing
// cannot start two outings, replay a roll or be paid twice.

import {
  GATHER_DAILY_OUTINGS,
  GATHER_SPOTS,
  GATHER_SPOT_IDS,
  RESOURCE_KINDS,
  gatherDay,
  gatherPayout,
  gatherResetAt,
  gatherView,
  outingsLeft,
  startGather,
  statPct,
  stepGather,
  type GatherChoice,
  type GatherSpot,
  type GatherState,
  type GatherView,
  type Resources,
} from "@gantt-quest/world";
import { heroInitFor } from "./db";

export interface GatherStatus {
  stamina: { left: number; max: number; resetsAt: number };
  /** The hero's chance per roll at each spot, from their stats and gear. */
  chances: Record<GatherSpot, number>;
  /** The outing in progress, or the one that just ended. */
  outing: GatherView | null;
}

interface Row {
  day: string;
  used: number;
  session_json: string | null;
}

const readRow = (db: D1Database, playerId: string) =>
  db.prepare("SELECT day, used, session_json FROM gathering WHERE player_id = ?").bind(playerId).first<Row>();

/** The hero's value for each spot's stat, gear included. Null without an active character. */
async function gatherStats(db: D1Database, playerId: string): Promise<Record<GatherSpot, number> | null> {
  const hero = await heroInitFor(db, playerId);
  if (!hero) return null;
  const of = (spot: GatherSpot) => hero.base[GATHER_SPOTS[spot].stat] + (hero.bonus[GATHER_SPOTS[spot].stat] ?? 0);
  return { fishing: of("fishing"), felling: of("felling"), quarry: of("quarry") };
}

async function status(db: D1Database, playerId: string, stats: Record<GatherSpot, number>, ended?: GatherState): Promise<GatherStatus> {
  const row = await readRow(db, playerId);
  const now = Date.now();
  return {
    stamina: { left: outingsLeft(row, now), max: GATHER_DAILY_OUTINGS, resetsAt: gatherResetAt(now) },
    chances: { fishing: statPct(stats.fishing), felling: statPct(stats.felling), quarry: statPct(stats.quarry) },
    outing: ended ? gatherView(ended) : row?.session_json ? gatherView(JSON.parse(row.session_json) as GatherState) : null,
  };
}

export async function gatherStatus(db: D1Database, playerId: string): Promise<GatherStatus | string> {
  const stats = await gatherStats(db, playerId);
  return stats ? status(db, playerId, stats) : "Create a character first.";
}

/** Start an outing, spending one of the day's three. Returns an error string if refused. */
export async function startOuting(db: D1Database, playerId: string, spot: unknown): Promise<GatherStatus | string> {
  if (!GATHER_SPOT_IDS.includes(spot as GatherSpot)) return "There is nothing to gather there.";
  const stats = await gatherStats(db, playerId);
  if (!stats) return "Create a character first.";
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

/** Apply one choice to the outing in progress. A finished outing is paid and cleared in the same batch. */
export async function stepOuting(db: D1Database, playerId: string, choice: unknown): Promise<(GatherStatus & { paid?: Resources }) | string> {
  const stats = await gatherStats(db, playerId);
  if (!stats) return "Create a character first.";
  const row = await readRow(db, playerId);
  if (!row?.session_json) return "You are not out gathering.";
  const step = stepGather(JSON.parse(row.session_json) as GatherState, (choice ?? {}) as GatherChoice);
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

  const paid = gatherPayout(next);
  const claim = crypto.randomUUID();
  const [closed] = await db.batch([
    db.prepare("UPDATE gathering SET session_json = NULL, claim = ?1 WHERE player_id = ?2 AND session_json = ?3").bind(claim, playerId, row.session_json),
    ...payoutStatements(db, playerId, claim, paid),
  ]);
  if (closed.meta.changes === 0) return "That was already played. Try again.";
  return { ...(await status(db, playerId, stats, next)), paid };
}
