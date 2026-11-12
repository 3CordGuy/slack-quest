// The notice board's bookkeeping: how each hero's contract came out, and
// the crew's shared goal for the week.
//
// A crew has one goal per period (packages/world/src/contracts.ts decides
// what a period is and which goal it gets). There is no timer: the row for a
// period is created the first time anyone reads the board or a voyage makes
// progress in it. Progress only ever comes from a voyage's own events and
// effects, on the server.

import {
  CONTRACTS,
  crewGoalById,
  crewGoalProgress,
  goalPeriod,
  goalPeriodEnd,
  pickCrewGoal,
  type ContractReward,
  type WorldEffect,
  type WorldEvent,
  type WorldState,
} from "@gantt-quest/world";

interface GoalRow {
  period: string;
  goal_id: string;
  progress: number;
  target: number;
  rewarded: number;
}

export interface CrewGoalView {
  id: string;
  text: string;
  progress: number;
  target: number;
  /** Gold each member is paid when it is filled. */
  reward: number;
  /** Filled and paid out. */
  rewarded: boolean;
  period: string;
  /** Epoch ms when the next goal is posted. */
  endsAt: number;
}

export interface NoticeBoard {
  goal: CrewGoalView | null;
  contracts: { id: string; name: string; text: string; reward: ContractReward }[];
}

/** This period's goal for a crew, posting it if nobody has yet. Null only if the stored goal is no longer in the game. */
async function activeGoal(db: D1Database, crewId: string, at: number): Promise<GoalRow | null> {
  const period = goalPeriod(at);
  const select = () =>
    db.prepare("SELECT period, goal_id, progress, target, rewarded FROM crew_goals WHERE crew_id = ? AND period = ?").bind(crewId, period).first<GoalRow>();
  const existing = await select();
  if (existing) return existing;
  // Periods sort as text ("2026-W09" < "2026-W46"), so the latest row is the goal before this one.
  const last = await db.prepare("SELECT goal_id FROM crew_goals WHERE crew_id = ? AND period < ? ORDER BY period DESC LIMIT 1").bind(crewId, period).first<{ goal_id: string }>();
  const def = pickCrewGoal(crewId, period, last?.goal_id);
  // One goal per crew per period: if two requests race, the second insert does nothing.
  await db
    .prepare("INSERT INTO crew_goals (crew_id, period, goal_id, progress, target) SELECT ?1, ?2, ?3, 0, ?4 WHERE NOT EXISTS (SELECT 1 FROM crew_goals WHERE crew_id = ?1 AND period = ?2)")
    .bind(crewId, period, def.id, def.target)
    .run();
  return select();
}

export async function noticeBoard(db: D1Database, crewId: string | null, at = Date.now()): Promise<NoticeBoard> {
  const row = crewId ? await activeGoal(db, crewId, at) : null;
  const def = row ? crewGoalById(row.goal_id) : undefined;
  return {
    goal: row && def
      ? { id: def.id, text: def.text, progress: Math.min(row.progress, row.target), target: row.target, reward: def.reward, rewarded: !!row.rewarded, period: row.period, endsAt: goalPeriodEnd(at) }
      : null,
    contracts: CONTRACTS.map(({ id, name, text, reward }) => ({ id, name, text, reward })),
  };
}

/** Add to the crew's goal and, the first time it is full, pay every current member. Returns true if it paid out. */
async function addGoalProgress(db: D1Database, crewId: string, goal: GoalRow, amount: number, reward: number): Promise<boolean> {
  const key = [crewId, goal.period, goal.goal_id] as const;
  const where = "crew_id = ? AND period = ? AND goal_id = ?";
  const res = await db.batch([
    db.prepare(`UPDATE crew_goals SET progress = MIN(target, progress + ?) WHERE ${where}`).bind(amount, ...key),
    // Claim the payout. Only one caller ever flips `rewarded`, and the payment below runs only for that caller.
    db.prepare(`UPDATE crew_goals SET rewarded = 1 WHERE ${where} AND rewarded = 0 AND progress >= target`).bind(...key),
    db
      .prepare("UPDATE characters SET gold = gold + ?1 WHERE changes() > 0 AND player_id IN (SELECT player_id FROM crew_members WHERE crew_id = ?2)")
      .bind(reward, crewId),
  ]);
  return res[1].meta.changes > 0;
}

/**
 * Bookkeeping for one applied step of a voyage: when it ended the run, how
 * each hero's contract came out; and whatever it adds to the crew's goal.
 * Returns true if the step filled the goal and the crew was paid.
 */
export async function recordStep(
  db: D1Database,
  crewId: string | null,
  prev: WorldState,
  step: { state: WorldState; events: WorldEvent[]; effects: WorldEffect[] },
): Promise<boolean> {
  if (step.effects.some((e) => e.kind === "run_end")) {
    const rows = step.state.heroes.filter((h) => h.contract);
    if (rows.length > 0) {
      await db.batch(
        rows.map((h) => {
          const met = h.contract!.outcome === "met" ? 1 : 0;
          // The reducer pays a met contract in the same step, through an ordinary grant, so done and rewarded agree.
          return db
            .prepare(
              `INSERT INTO run_contracts (code, player_id, contract_id, done, rewarded) VALUES (?1, ?2, ?3, ?4, ?4)
               ON CONFLICT(code, player_id) DO UPDATE SET contract_id = ?3, done = ?4, rewarded = ?4`,
            )
            .bind(step.state.code, h.id, h.contract!.id, met);
        }),
      );
    }
  }

  if (!crewId || (step.events.length === 0 && step.effects.length === 0)) return false;
  // Cheap pre-check before touching D1: could this step count toward any goal at all?
  const relevant =
    step.events.some((e) => e.t === "ended" || e.t === "contract" || (e.t === "battle" && e.ev.t === "down")) ||
    step.effects.some((e) => e.kind === "grant" && e.resources);
  if (!relevant) return false;
  const goal = await activeGoal(db, crewId, Date.now());
  const def = goal ? crewGoalById(goal.goal_id) : undefined;
  if (!goal || !def || goal.rewarded) return false;
  const amount = crewGoalProgress(def, prev, step);
  if (amount <= 0) return false;
  return addGoalProgress(db, crewId, goal, amount, def.reward);
}
