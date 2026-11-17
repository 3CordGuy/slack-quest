// The atlas in D1: what a crew has done on its chart. The chart itself is
// worked out from the crew's id (packages/world/src/atlas.ts) and is never
// stored; a node has a row here from the first time it is opened.
//
// A world is a crew: the atlas is keyed by crew id, so a new crew starts a
// fresh chart, and its seed is the crew's id, as the salesman's and the
// regulars' are. The chart's seed is no secret (it only says where things lie);
// the seed a node's map and its dice are made from is rolled afresh and never
// leaves the server.

import { atlasNodeById, atlasOpen, atlasView, cleanStone, makeRng, nodeOptions, rollStone, stoneKey, stoneOn, stoneProblem, type AtlasNodeView, type Lodestone } from "@gantt-quest/world";
import { CAVE_IDLE_MS, createZoneRow, crewPlaces, type ZoneRow } from "./zones";

/** The seed of a crew's chart. */
export const atlasSeed = (crewId: string): string => crewId;

interface NodeRow {
  node: string;
  status: "open" | "cleared";
  zone_code: string | null;
  attempts: number;
  /** The lodestone set into it (what it carries, joined with '+'), or null. */
  stone: string | null;
}

/**
 * A node as the chart is sent: what a crew sees of it, and (on one being fought through) its map and who is
 * on it; and the lodestone set into it, if one is. Its own `mods` are as the chart made them: what the stone
 * adds is worked out from the two (`stoneOn`).
 */
export type ChartNode = AtlasNodeView & { zone?: string; here?: string[]; stone?: Lodestone };
export interface Chart {
  /** What the chart was worked out from: the client makes the land it lies on from the same (atlasMap.ts). */
  seed: string;
  nodes: ChartNode[];
  /** The lodestones in the crew's case: each kind it has, and how many. */
  stones: { stone: Lodestone; qty: number }[];
}

const rowsOf = async (db: D1Database, crewId: string) =>
  (await db.prepare("SELECT node, status, zone_code, attempts, stone FROM atlas_nodes WHERE crew_id = ?").bind(crewId).all<NodeRow>()).results;

/** The lodestones in a crew's case, the ones that carry most first. */
export async function stonesOf(db: D1Database, crewId: string): Promise<Chart["stones"]> {
  const rows = (await db.prepare("SELECT mods, qty FROM atlas_stones WHERE crew_id = ? AND qty > 0").bind(crewId).all<{ mods: string; qty: number }>()).results;
  return rows
    .flatMap((r) => {
      const stone = cleanStone(r.mods);
      return stone ? [{ stone, qty: r.qty }] : [];
    })
    .sort((a, b) => b.stone.length - a.stone.length || stoneKey(a.stone).localeCompare(stoneKey(b.stone)));
}

/** Put a lodestone in a crew's case: one found in a bounty. */
export async function addStone(db: D1Database, crewId: string, raw: unknown): Promise<void> {
  const stone = cleanStone(raw);
  if (!stone) return;
  await db.prepare("INSERT INTO atlas_stones (crew_id, mods, qty) VALUES (?1, ?2, 1) ON CONFLICT(crew_id, mods) DO UPDATE SET qty = qty + 1").bind(crewId, stoneKey(stone)).run();
}

/** The map still being fought through for a node: made for it, not cleared, and visited lately. Null if there is none. */
async function liveZone(db: D1Database, code: string | null): Promise<string | null> {
  if (!code) return null;
  const row = await db.prepare("SELECT code FROM zones WHERE code = ? AND status != 'cleared' AND updated_at > ?").bind(code, Date.now() - CAVE_IDLE_MS).first<{ code: string }>();
  return row?.code ?? null;
}

/** A crew's chart: the Harbor, what they have cleared, what is open to them and the fog beyond, with who is out on what. */
export async function chartFor(db: D1Database, crewId: string): Promise<Chart> {
  const [rows, places, stones] = await Promise.all([rowsOf(db, crewId), crewPlaces(db, crewId), stonesOf(db, crewId)]);
  const cleared = new Set(rows.filter((r) => r.status === "cleared").map((r) => r.node));
  const open = new Map(rows.filter((r) => r.status === "open" && r.zone_code).map((r) => [r.node, r.zone_code!]));
  const set = new Map(rows.flatMap((r) => (r.status === "open" && r.stone ? [[r.node, cleanStone(r.stone)] as const] : [])));
  const nodes: ChartNode[] = [];
  for (const node of atlasView(atlasSeed(crewId), cleared)) {
    const zone = node.state === "open" ? await liveZone(db, open.get(node.id) ?? null) : null;
    const stone = node.state === "open" ? set.get(node.id) : null;
    nodes.push({ ...node, ...(zone ? { zone, here: places.filter((m) => m.zone?.code === zone).map((m) => m.name) } : {}), ...(stone ? { stone } : {}) });
  }
  return { seed: atlasSeed(crewId), nodes, stones };
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
  // A fresh map, and a different one each time: the last was cleared out by time, not by the crew. Its seed is
  // rolled here and kept here (the chart's own is the crew's id, which anyone in the crew can read).
  const attempt = (mine?.attempts ?? 0) + 1;
  // With what a lodestone set into it adds to its own.
  const stone = cleanStone(mine?.stone);
  const options = nodeOptions(seed, node, Math.min(4, Math.max(1, Math.round(party))), stone ? stoneOn(node, stone).added : []);
  const code = await createZoneRow(db, playerId, options, crypto.randomUUID().slice(0, 12), "atlas", crewId, node.id);
  await db
    .prepare(
      `INSERT INTO atlas_nodes (crew_id, node, status, zone_code, attempts, opened_by, opened_at) VALUES (?1, ?2, 'open', ?3, ?4, ?5, ?6)
       ON CONFLICT(crew_id, node) DO UPDATE SET zone_code = ?3, attempts = ?4, opened_by = ?5, opened_at = ?6 WHERE atlas_nodes.status != 'cleared'`,
    )
    .bind(crewId, node.id, code, attempt, playerId, Date.now())
    .run();
  return { code, fresh: true };
}

/**
 * Set a lodestone from the crew's case into a node, before anyone sets out for it: what the stone carries is
 * added to the node's own when its map is made. The stone is spent. Refused if the crew has no such stone, the
 * node is not open to them, it has a stone in it already, its map is already being fought through, or the
 * stone would change nothing there.
 */
export async function setStone(db: D1Database, crewId: string, playerId: string, nodeId: unknown, raw: unknown): Promise<{ ok: true } | { error: string; status: 400 | 409 }> {
  const seed = atlasSeed(crewId);
  const node = atlasNodeById(seed, nodeId);
  const stone = cleanStone(raw);
  if (!node || node.kind === "harbor") return { error: "There is no such place.", status: 400 };
  if (!stone) return { error: "That is no lodestone.", status: 400 };
  const rows = await rowsOf(db, crewId);
  const mine = rows.find((r) => r.node === node.id);
  if (mine?.status === "cleared") return { error: `${node.name} is cleared already.`, status: 409 };
  if (!atlasOpen(seed, new Set(rows.filter((r) => r.status === "cleared").map((r) => r.node)), node.id)) return { error: "No route runs there yet.", status: 409 };
  if (mine?.stone) return { error: `${node.name} has a lodestone set in it already.`, status: 409 };
  if (await liveZone(db, mine?.zone_code ?? null)) return { error: "The crew has already set out for it: it is too late to change what is there.", status: 409 };
  const problem = stoneProblem(node, stone);
  if (problem) return { error: problem, status: 409 };
  // Into the node, if the crew has such a stone and none has been set there meanwhile; then out of the case.
  const key = stoneKey(stone);
  const res = await db
    .prepare(
      `INSERT INTO atlas_nodes (crew_id, node, status, attempts, opened_by, opened_at, stone)
       SELECT ?1, ?2, 'open', 0, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM atlas_stones WHERE crew_id = ?1 AND mods = ?5 AND qty >= 1)
       ON CONFLICT(crew_id, node) DO UPDATE SET stone = excluded.stone WHERE atlas_nodes.stone IS NULL AND atlas_nodes.status != 'cleared'`,
    )
    .bind(crewId, node.id, playerId, Date.now(), key)
    .run();
  if (res.meta.changes === 0) return { error: "The crew has no such lodestone.", status: 409 };
  await db.prepare("UPDATE atlas_stones SET qty = qty - 1 WHERE crew_id = ? AND mods = ? AND qty >= 1").bind(crewId, key).run();
  await db.prepare("DELETE FROM atlas_stones WHERE crew_id = ? AND qty <= 0").bind(crewId).run();
  return { ok: true };
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

/** Put a lodestone in the crew's case, as one would be found a good way out. Dev deployments only. */
export async function devGrantStone(db: D1Database, crewId: string): Promise<void> {
  await addStone(db, crewId, rollStone(makeRng(Math.floor(Math.random() * 2 ** 31)), 4 + Math.floor(Math.random() * 8)));
}

/** Wipe a crew's chart back to the Harbor and the six landfalls round it. Dev deployments only. */
export async function devResetChart(db: D1Database, crewId: string): Promise<void> {
  await db.prepare("DELETE FROM atlas_nodes WHERE crew_id = ?").bind(crewId).run();
}
