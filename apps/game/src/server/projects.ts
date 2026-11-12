// Harbor projects in D1: what a crew has paid toward each one, which are
// built, and the log of who gave what.
//
// The rules (catalogue, what a gift may be) live in
// packages/world/src/projects.ts. This file reads the state those rules
// need and writes an accepted gift as one batch.

import {
  PROJECTS,
  PROJECT_COST_KINDS,
  checkContribution,
  projectById,
  projectCostKinds,
  type CrewProject,
  type HarborWorks,
  type ProjectAmounts,
  type ProjectCostKind,
  type ProjectGift,
} from "@gantt-quest/world";

const GIFTS_SHOWN = 12;
const isKind = (k: string): k is ProjectCostKind => (PROJECT_COST_KINDS as readonly string[]).includes(k);

/** A crew's progress on every project in the catalogue, and the latest gifts. */
export async function crewWorks(db: D1Database, crewId: string): Promise<HarborWorks> {
  const [built, paid, gifts] = await db.batch([
    db.prepare("SELECT project_id, built_at FROM crew_projects WHERE crew_id = ?").bind(crewId),
    db.prepare("SELECT project_id, kind, qty FROM crew_project_paid WHERE crew_id = ? AND qty > 0").bind(crewId),
    db
      .prepare(
        `SELECT g.project_id AS projectId, g.kind, g.qty, g.created_at AS at, c.name
         FROM crew_project_gifts g LEFT JOIN characters c ON c.player_id = g.player_id
         WHERE g.crew_id = ? ORDER BY g.id DESC LIMIT ${GIFTS_SHOWN}`,
      )
      .bind(crewId),
  ]);
  const builtAt = new Map((built.results as { project_id: string; built_at: number | null }[]).map((r) => [r.project_id, r.built_at]));
  const projects: CrewProject[] = PROJECTS.map((def) => ({ id: def.id, paid: {}, builtAt: builtAt.get(def.id) ?? null }));
  for (const row of paid.results as { project_id: string; kind: string; qty: number }[]) {
    const project = projects.find((p) => p.id === row.project_id);
    if (project && isKind(row.kind)) project.paid[row.kind] = row.qty;
  }
  return {
    projects,
    gifts: (gifts.results as (Omit<ProjectGift, "name"> & { name: string | null })[]).filter((g) => isKind(g.kind)).map((g) => ({ ...g, name: g.name ?? "Someone" })),
  };
}

/** Ids of the projects a crew has finished. */
export async function builtProjectIds(db: D1Database, crewId: string | null): Promise<string[]> {
  if (!crewId) return [];
  const rows = await db.prepare("SELECT project_id FROM crew_projects WHERE crew_id = ? AND built_at IS NOT NULL ORDER BY project_id").bind(crewId).all<{ project_id: string }>();
  return rows.results.map((r) => r.project_id).filter((id) => !!projectById(id));
}

/** What a player has to give: their gold and hut materials. */
export async function projectStock(db: D1Database, playerId: string): Promise<ProjectAmounts> {
  const [gold, resources] = await db.batch([
    db.prepare("SELECT gold FROM characters WHERE player_id = ? AND status = 'active'").bind(playerId),
    db.prepare("SELECT kind, qty FROM resources WHERE player_id = ? AND qty > 0").bind(playerId),
  ]);
  const stock: ProjectAmounts = {};
  const g = (gold.results[0] as { gold: number } | undefined)?.gold ?? 0;
  if (g > 0) stock.gold = g;
  for (const row of resources.results as { kind: string; qty: number }[]) if (isKind(row.kind)) stock[row.kind] = row.qty;
  return stock;
}

/**
 * Give toward a crew project from the player's own stock. `give` is the
 * client's request and is checked here against what the player holds and
 * what the project still needs. Returns an error string, or whether the gift
 * finished the project.
 *
 * The write is one batch: for each kind given, log the gift, take it from
 * the player, add it to the project; then mark the project built if every
 * cost is now met. The checks above run on a read that may be stale by the
 * time the batch runs (a crewmate gave the same thing a moment earlier), so
 * the tables' own constraints refuse an over-payment or an overdraft and the
 * whole batch is rolled back.
 */
export async function contribute(db: D1Database, crewId: string, playerId: string, projectId: string, give: unknown): Promise<{ error: string } | { completed: boolean }> {
  const [works, stock] = await Promise.all([crewWorks(db, crewId), projectStock(db, playerId)]);
  const project = works.projects.find((p) => p.id === projectId);
  const check = checkContribution(projectId, { paid: project?.paid ?? {}, built: !!project && project.builtAt !== null }, stock, give);
  if (!check.ok) return { error: check.error };
  const def = projectById(projectId)!;
  const at = Date.now();
  const key = [crewId, projectId] as const;

  const stmts: D1PreparedStatement[] = [db.prepare("INSERT OR IGNORE INTO crew_projects (crew_id, project_id) VALUES (?, ?)").bind(...key)];
  for (const kind of projectCostKinds(def)) {
    const qty = check.give[kind];
    if (!qty) continue;
    const held = kind === "gold" ? "(SELECT gold FROM characters WHERE player_id = ?3)" : "(SELECT qty FROM resources WHERE player_id = ?3 AND kind = ?4)";
    stmts.push(
      // NULL (already built, or nothing held) and a negative remainder both break the row's constraints.
      db
        .prepare(
          `INSERT INTO crew_project_gifts (crew_id, project_id, player_id, kind, qty, left_after, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5,
             CASE WHEN EXISTS (SELECT 1 FROM crew_projects WHERE crew_id = ?1 AND project_id = ?2 AND built_at IS NOT NULL) THEN NULL ELSE ${held} - ?5 END,
             ?6)`,
        )
        .bind(...key, playerId, kind, qty, at),
      kind === "gold"
        ? db.prepare("UPDATE characters SET gold = gold - ? WHERE player_id = ?").bind(qty, playerId)
        : db.prepare("UPDATE resources SET qty = qty - ? WHERE player_id = ? AND kind = ?").bind(qty, playerId, kind),
      db
        .prepare(
          `INSERT INTO crew_project_paid (crew_id, project_id, kind, qty, cap) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(crew_id, project_id, kind) DO UPDATE SET qty = qty + excluded.qty, cap = excluded.cap`,
        )
        .bind(...key, kind, qty, def.cost[kind]!),
    );
  }
  // Built when every cost in the catalogue is met by what is now stored.
  const kinds = projectCostKinds(def);
  const met = kinds.map(() => "(kind = ? AND qty >= ?)").join(" OR ");
  stmts.push(
    db
      .prepare(
        `UPDATE crew_projects SET built_at = ? WHERE crew_id = ? AND project_id = ? AND built_at IS NULL
         AND (SELECT COUNT(*) FROM crew_project_paid WHERE crew_id = ? AND project_id = ? AND (${met})) = ?`,
      )
      .bind(at, ...key, ...key, ...kinds.flatMap((k) => [k, def.cost[k]!]), kinds.length),
  );

  try {
    const res = await db.batch(stmts);
    return { completed: res[res.length - 1].meta.changes > 0 };
  } catch (err) {
    console.warn("projects:gift-refused", { projectId, err: err instanceof Error ? err.message : String(err) });
    return { error: `Someone else just gave to the ${def.name}, or your stock changed. Look again and give what is still needed.` };
  }
}
