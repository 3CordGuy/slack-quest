// A hut in D1: the materials its owner holds, the blueprints they know
// and the furnishings they own, read whole by getHut. What a container
// holds is in containers.ts, what is built and bought in spending.ts, and
// the ground the hut stands on in plots.ts.

import { RESOURCE_KINDS, STARTER_BLUEPRINTS, type FurnishingGrant, type HutSummary, type ResourceKind, type Resources } from "@gantt-quest/world";
import { now, type Env } from "./rows";

// ---------- huts: materials, blueprints and furnishings ----------

/** Statements that add (or, with negative amounts, spend) resources. Amounts never go below zero. */
export function resourceStatements(db: D1Database, playerId: string, resources: Resources): D1PreparedStatement[] {
  return RESOURCE_KINDS.filter((kind) => resources[kind]).map((kind) =>
    db
      .prepare(
        `INSERT INTO resources (player_id, kind, qty) VALUES (?1, ?2, MAX(0, ?3))
         ON CONFLICT(player_id, kind) DO UPDATE SET qty = MAX(0, qty + ?3)`,
      )
      .bind(playerId, kind, resources[kind]!),
  );
}

export function blueprintStatement(db: D1Database, playerId: string, blueprintId: string): D1PreparedStatement {
  return db.prepare("INSERT OR IGNORE INTO blueprints (player_id, blueprint_id) VALUES (?, ?)").bind(playerId, blueprintId);
}

/** A new furnishing goes into storage, unplaced. */
export function furnishingStatement(db: D1Database, playerId: string, furnishing: FurnishingGrant): D1PreparedStatement {
  return db
    .prepare("INSERT INTO furnishings (player_id, def_id, label, meta_json, created_at) VALUES (?, ?, ?, '{}', ?)")
    .bind(playerId, furnishing.defId, furnishing.label, now());
}

/** A player's hut tier, materials, known blueprints and furnishings. Everyone has a tier 1 hut by default. */
export async function getHut(db: D1Database, playerId: string): Promise<HutSummary> {
  const [hut, resources, blueprints, furnishings, stash, stowed] = await Promise.all([
    db.prepare("SELECT tier FROM huts WHERE player_id = ?").bind(playerId).first<{ tier: number }>(),
    db.prepare("SELECT kind, qty FROM resources WHERE player_id = ? AND qty > 0").bind(playerId).all<{ kind: ResourceKind; qty: number }>(),
    db.prepare("SELECT blueprint_id FROM blueprints WHERE player_id = ?").bind(playerId).all<{ blueprint_id: string }>(),
    db
      .prepare("SELECT id, def_id AS defId, label, q, r, facing, x, z, y, angle, on_id AS onId, in_id AS inId, meta_json AS meta FROM furnishings WHERE player_id = ? ORDER BY id")
      .bind(playerId)
      .all<HutSummary["furnishings"][number] & { meta?: string | null }>(),
    db
      .prepare("SELECT furnishing_id AS containerId, kind, qty FROM stash WHERE player_id = ? AND qty > 0 ORDER BY furnishing_id, kind")
      .bind(playerId)
      .all<HutSummary["stash"][number]>(),
    db
      .prepare("SELECT id AS itemId, stored_in AS containerId, name, icon, slot, rarity, kind, ref, power, level_req, stat_bonus_json, upgrades FROM inventory WHERE player_id = ? AND stored_in IS NOT NULL ORDER BY id")
      .bind(playerId)
      .all<HutSummary["stowed"][number]>(),
  ]);
  return {
    tier: hut?.tier ?? 1,
    resources: Object.fromEntries(resources.results.map((r) => [r.kind, r.qty])),
    blueprints: [...new Set([...STARTER_BLUEPRINTS, ...blueprints.results.map((b) => b.blueprint_id)])],
    // A Mounted Fish carries the catch hung on it; nothing else uses its meta yet.
    furnishings: furnishings.results.map(({ meta, ...f }) => (f.defId === "mounted_fish" ? { ...f, fish: (JSON.parse(meta || "{}") as { fish?: HutSummary["furnishings"][number]["fish"] }).fish ?? null } : f)),
    stash: stash.results,
    stowed: stowed.results,
  };
}

/** Ask a hut's room to re-read the hut from D1 and tell everyone inside. Never throws. */
export async function refreshHut(env: Env, ownerId: string): Promise<void> {
  try {
    await env.HUT_ROOM.get(env.HUT_ROOM.idFromName(ownerId)).fetch("https://hut/refresh", { headers: { "x-hut-owner": ownerId } });
  } catch (err) {
    console.warn("hut:refresh-failed", { err: err instanceof Error ? err.message : String(err) });
  }
}
