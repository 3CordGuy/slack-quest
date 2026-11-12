// The galley in D1: the crew's shared larder, cooking into it, and taking it
// aboard when a ship sails.
//
// The rules (dishes, recipes, caps) live in packages/world/src/galley.ts.
// Cooking is one batch built on `spendStatements`: the materials are taken
// and the larder filled together or not at all. The galley being built and
// the dish's cap are checked again inside the batch, so two crewmates
// cooking at once cannot overfill it.

import { GALLEY_PROJECT, HARBOR_XP, cleanLarder, cookProblem, dishById, type Larder, type Resources } from "@gantt-quest/world";
import { prepareXp, xpOutcome, type XpResult } from "./harbor-xp";
import { crewFor, spendStatements } from "./db";
import { builtProjectIds, projectStock } from "./projects";

/** What a crew's larder holds right now. */
export async function larderOf(db: D1Database, crewId: string | null): Promise<Larder> {
  if (!crewId) return cleanLarder({});
  const rows = await db.prepare("SELECT dish_id, qty FROM galley_larder WHERE crew_id = ?").bind(crewId).all<{ dish_id: string; qty: number }>();
  return cleanLarder(Object.fromEntries(rows.results.map((r) => [r.dish_id, r.qty])));
}

export interface GalleyView {
  /** Whether this player is in a crew at all: the larder is the crew's. */
  inCrew: boolean;
  built: boolean;
  larder: Larder;
  resources: Resources;
}

export async function galleyView(db: D1Database, playerId: string): Promise<GalleyView> {
  const crew = await crewFor(db, playerId);
  const [built, larder, stock] = await Promise.all([
    crew ? builtProjectIds(db, crew.id).then((ids) => ids.includes(GALLEY_PROJECT)) : Promise.resolve(false),
    larderOf(db, crew?.id ?? null),
    projectStock(db, playerId),
  ]);
  const { gold: _gold, ...resources } = stock;
  return { inCrew: !!crew, built, larder, resources };
}

/** Cook one dish into the crew's larder. Returns an error message, or the XP it gave. */
export async function cook(db: D1Database, playerId: string, dishId: string): Promise<string | { xp?: XpResult }> {
  const view = await galleyView(db, playerId);
  if (!view.inCrew) return "Join a crew first: the galley cooks for a crew's ship.";
  const problem = cookProblem(dishId, view);
  if (problem) return problem;
  const def = dishById(dishId)!;
  // Checked again as the batch runs: the galley still stands for this player's crew, and the dish has room.
  const crewOf = "(SELECT crew_id FROM crew_members WHERE player_id = ?1)";
  const stillOk = [
    `EXISTS (SELECT 1 FROM crew_projects WHERE crew_id = ${crewOf} AND project_id = '${GALLEY_PROJECT}' AND built_at IS NOT NULL)`,
    `COALESCE((SELECT qty FROM galley_larder WHERE crew_id = ${crewOf} AND dish_id = '${def.id}'), 0) < ${def.cap}`,
  ].join(" AND ");
  const spend = spendStatements(db, playerId, 0, def.recipe, stillOk);
  const xp = await prepareXp(db, playerId, HARBOR_XP.cook);
  const res = await db.batch([
    ...spend,
    db
      .prepare(
        `INSERT INTO galley_larder (crew_id, dish_id, qty) SELECT crew_id, ?2, 1 FROM crew_members WHERE player_id = ?1 AND changes() > 0
         ON CONFLICT (crew_id, dish_id) DO UPDATE SET qty = qty + 1`,
      )
      .bind(playerId, def.id),
    ...(xp?.statements() ?? []),
  ]);
  return res[spend.length].meta.changes > 0 ? { xp: xpOutcome(xp, res) } : "You no longer have what that takes, or the larder is full.";
}

/**
 * A crew's ship is sailing: empty the larder and hand back what was in it,
 * for the voyage to take aboard. One statement, so a dish cooked a moment
 * later stays in the larder for the next ship.
 */
export async function takeLarder(db: D1Database, crewId: string | null): Promise<Larder | undefined> {
  if (!crewId) return undefined;
  const rows = await db.prepare("DELETE FROM galley_larder WHERE crew_id = ? RETURNING dish_id, qty").bind(crewId).all<{ dish_id: string; qty: number }>();
  if (rows.results.length === 0) return undefined;
  return cleanLarder(Object.fromEntries(rows.results.map((r) => [r.dish_id, r.qty])));
}

