// The atlas in D1: what a crew has done on its chart. The chart itself is
// worked out from the crew's id (packages/world/src/atlas.ts) and is never
// stored; a node has a row here from the first time it is opened.
//
// A world is a crew: the atlas is keyed by crew id, so a new crew starts a
// fresh chart, and its seed is the crew's id, as the salesman's and the
// regulars' are. The seed a node's map is made from never leaves the server.

import { atlasNodeById, atlasOpen, atlasView, nodeOptions, type AtlasNodeView } from "@gantt-quest/world";
import { CAVE_IDLE_MS, createZoneRow, crewPlaces, type ZoneRow } from "./zones";

/** The seed of a crew's chart. */
export const atlasSeed = (crewId: string): string => crewId;

interface NodeRow {
  node: string;
  status: "open" | "cleared";
  zone_code: string | null;
  attempts: number;
}

/** A node as the chart is sent: what a crew sees of it, and (on one being fought through) its map and who is on it. */
export type ChartNode = AtlasNodeView & { zone?: string; here?: string[] };
export interface Chart {
  nodes: ChartNode[];
}

const rowsOf = async (db: D1Database, crewId: string) =>
  (await db.prepare("SELECT node, status, zone_code, attempts FROM atlas_nodes WHERE crew_id = ?").bind(crewId).all<NodeRow>()).results;

/** The map still being fought through for a node: made for it, not cleared, and visited lately. Null if there is none. */
async function liveZone(db: D1Database, code: string | null): Promise<string | null> {
  if (!code) return null;
  const row = await db.prepare("SELECT code FROM zones WHERE code = ? AND status != 'cleared' AND updated_at > ?").bind(code, Date.now() - CAVE_IDLE_MS).first<{ code: string }>();
  return row?.code ?? null;
}

/** A crew's chart: the Harbor, what they have cleared, what is open to them and the fog beyond, with who is out on what. */
export async function chartFor(db: D1Database, crewId: string): Promise<Chart> {
  const [rows, places] = await Promise.all([rowsOf(db, crewId), crewPlaces(db, crewId)]);
  const cleared = new Set(rows.filter((r) => r.status === "cleared").map((r) => r.node));
  const open = new Map(rows.filter((r) => r.status === "open" && r.zone_code).map((r) => [r.node, r.zone_code!]));
  const nodes: ChartNode[] = [];
  for (const node of atlasView(atlasSeed(crewId), cleared)) {
    const zone = node.state === "open" ? await liveZone(db, open.get(node.id) ?? null) : null;
    nodes.push(zone ? { ...node, zone, here: places.filter((m) => m.zone?.code === zone).map((m) => m.name) } : node);
  }
  return { nodes };
}

/**
 * Set sail for a node: the map the crew is already fighting through there, or a fresh one made for a
 * party of this many. Refused unless a route runs to the node from the Harbor or from one they have cleared.
 */
export async function openNode(db: D1Database, crewId: string, playerId: string, nodeId: unknown, party: number): Promise<{ code: string; fresh: boolean } | { error: string; status: 400 | 409 }> {
  const seed = atlasSeed(crewId);
  const node = atlasNodeById(seed, nodeId);
  if (!node || node.kind === "harbor") return { error: "There is no such landfall.", status: 400 };
  const rows = await rowsOf(db, crewId);
  const mine = rows.find((r) => r.node === node.id);
  if (mine?.status === "cleared") return { error: `${node.name} is cleared already.`, status: 409 };
  if (!atlasOpen(seed, new Set(rows.filter((r) => r.status === "cleared").map((r) => r.node)), node.id)) {
    return { error: "No route runs there yet. Clear a landfall beside it first.", status: 409 };
  }
  const live = await liveZone(db, mine?.zone_code ?? null);
  if (live) return { code: live, fresh: false };
  // A fresh map, and a different one each time: the last was cleared out by time, not by the crew.
  const attempt = (mine?.attempts ?? 0) + 1;
  const options = nodeOptions(seed, node, Math.min(4, Math.max(1, Math.round(party))));
  const code = await createZoneRow(db, playerId, options, `${crewId}:${node.id}:${attempt}`, "atlas", crewId, node.id);
  await db
    .prepare(
      `INSERT INTO atlas_nodes (crew_id, node, status, zone_code, attempts, opened_by, opened_at) VALUES (?1, ?2, 'open', ?3, ?4, ?5, ?6)
       ON CONFLICT(crew_id, node) DO UPDATE SET zone_code = ?3, attempts = ?4, opened_by = ?5, opened_at = ?6 WHERE atlas_nodes.status != 'cleared'`,
    )
    .bind(crewId, node.id, code, attempt, playerId, Date.now())
    .run();
  return { code, fresh: true };
}

/** A node's map has been cleared: the node is cleared for the crew. True if this is what cleared it. */
export async function clearNode(db: D1Database, crewId: string, nodeId: string): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO atlas_nodes (crew_id, node, status, attempts, opened_at, cleared_at) VALUES (?1, ?2, 'cleared', 0, ?3, ?3)
       ON CONFLICT(crew_id, node) DO UPDATE SET status = 'cleared', cleared_at = ?3 WHERE atlas_nodes.status != 'cleared'`,
    )
    .bind(crewId, nodeId, Date.now())
    .run();
  return res.meta.changes > 0;
}

/** Why someone of crew `crewId` (null: in no crew) may not walk onto this zone, or null if they may. A landfall is its crew's own. */
export function enterProblem(zone: Pick<ZoneRow, "kind" | "crew_id">, crewId: string | null): string | null {
  return zone.kind === "atlas" && zone.crew_id !== crewId ? "That landfall is on another crew's chart." : null;
}

// ---------- the dev toolbox ----------

/** Clear a node without fighting for it, if it is one the crew could open (or has open). Dev deployments only. */
export async function devClearNode(db: D1Database, crewId: string, nodeId: unknown): Promise<string | null> {
  const seed = atlasSeed(crewId);
  const node = atlasNodeById(seed, nodeId);
  if (!node || node.kind === "harbor") return "There is no such landfall.";
  const cleared = new Set((await rowsOf(db, crewId)).filter((r) => r.status === "cleared").map((r) => r.node));
  if (!atlasOpen(seed, cleared, node.id)) return cleared.has(node.id) ? `${node.name} is cleared already.` : "No route runs there yet.";
  await clearNode(db, crewId, node.id);
  return null;
}

/** Wipe a crew's chart back to the Harbor and the six landfalls round it. Dev deployments only. */
export async function devResetChart(db: D1Database, crewId: string): Promise<void> {
  await db.prepare("DELETE FROM atlas_nodes WHERE crew_id = ?").bind(crewId).run();
}
