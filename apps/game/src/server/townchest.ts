// The town chest in D1 (packages/world/src/townchest.ts): one store a crew
// shares, in tabs. What is in it is the crew's; what goes in comes out of a
// hero's own pack, and what comes out goes into one.
//
// Each move is one batch, whose first statement takes the thing from where
// it is (and does nothing if it is no longer there, or there is no room for
// it where it is going), and whose second puts it where it goes only if the
// first did something. So nothing is made or lost by two of the crew
// reaching in at once.

import { TOWN_CHEST_ROWS, CHEST_TABS, addedSlots, chestPutProblem, chestRowCost, chestTab, chestTakes, type ChestTab } from "@gantt-quest/world";
import { carryState, packHasRoomSql, spendStatements } from "./db";

export interface ChestTabView {
  id: ChestTab;
  /** How many rows of squares it has. */
  rows: number;
  /** What is in it: each kind, and how many. */
  held: { kind: string; qty: number }[];
}
export interface ChestView {
  tabs: ChestTabView[];
}

/** The table a hero's own things of a tab's sort are kept in. Both are (player_id, kind, qty). */
const PACK_TABLE: Record<ChestTab, string> = { lodestones: "consumables", materials: "resources" };

/** A crew's town chest: every tab, how big it is and what is in it. */
export async function chestFor(db: D1Database, crewId: string): Promise<ChestView> {
  const [held, sizes] = await Promise.all([
    db.prepare("SELECT tab, kind, qty FROM town_chest WHERE crew_id = ? AND qty > 0 ORDER BY kind").bind(crewId).all<{ tab: string; kind: string; qty: number }>(),
    db.prepare("SELECT tab, rows FROM town_chest_tabs WHERE crew_id = ?").bind(crewId).all<{ tab: string; rows: number }>(),
  ]);
  return {
    tabs: CHEST_TABS.map(({ id }) => ({
      id,
      rows: sizes.results.find((s) => s.tab === id)?.rows ?? TOWN_CHEST_ROWS,
      // Only what belongs there: anything else in the table is not shown, and cannot be taken.
      held: held.results.filter((h) => h.tab === id && chestTakes(id, h.kind)).map(({ kind, qty }) => ({ kind, qty })),
    })),
  };
}

const heldIn = (view: ChestView, tab: ChestTab) => Object.fromEntries(view.tabs.find((t) => t.id === tab)!.held.map((h) => [h.kind, h.qty]));

/** Put `n` of a kind of thing from a hero's pack into a tab of their crew's chest. Returns why not, or null once it is in. */
export async function chestPut(db: D1Database, crewId: string, playerId: string, rawTab: unknown, kind: unknown, n: unknown): Promise<string | null> {
  const tab = chestTab(rawTab);
  if (!tab) return "There is no such tab.";
  const view = await chestFor(db, crewId);
  const problem = chestPutProblem(tab, view.tabs.find((t) => t.id === tab)!.rows, heldIn(view, tab), kind, n as number);
  if (problem) return problem;
  const res = await db.batch([
    db.prepare(`UPDATE ${PACK_TABLE[tab]} SET qty = qty - ?3 WHERE player_id = ?1 AND kind = ?2 AND qty >= ?3`).bind(playerId, kind, n),
    db.prepare("INSERT INTO town_chest (crew_id, tab, kind, qty) SELECT ?1, ?2, ?3, ?4 WHERE changes() > 0 ON CONFLICT(crew_id, tab, kind) DO UPDATE SET qty = qty + ?4").bind(crewId, tab, kind, n),
  ]);
  return res[0].meta.changes > 0 ? null : "You no longer carry that many.";
}

/** Take `n` of a kind of thing out of a tab of the crew's chest, into a hero's pack. Returns why not, or null once it is out. */
export async function chestTake(db: D1Database, crewId: string, playerId: string, rawTab: unknown, kind: unknown, n: unknown): Promise<string | null> {
  const tab = chestTab(rawTab);
  if (!tab || !chestTakes(tab, kind)) return "There is no such thing in the chest.";
  if (!Number.isInteger(n) || (n as number) < 1) return "That is not an amount.";
  const count = n as number;
  const [carry, mine] = await Promise.all([
    carryState(db, playerId),
    db.prepare(`SELECT qty FROM ${PACK_TABLE[tab]} WHERE player_id = ? AND kind = ?`).bind(playerId, kind).first<{ qty: number }>(),
  ]);
  if (!carry) return "Create a character first.";
  // A new stack takes a square of the pack: the pack must have it, when the thing is taken and not only now.
  const squares = addedSlots(mine?.qty ?? 0, count);
  const res = await db.batch([
    db.prepare(`UPDATE town_chest SET qty = qty - ?5 WHERE crew_id = ?2 AND tab = ?3 AND kind = ?4 AND qty >= ?5 AND (${squares > 0 ? packHasRoomSql(carry.limit, squares) : "?1 = ?1"})`).bind(playerId, crewId, tab, kind, count),
    db.prepare(`INSERT INTO ${PACK_TABLE[tab]} (player_id, kind, qty) SELECT ?1, ?2, ?3 WHERE changes() > 0 ON CONFLICT(player_id, kind) DO UPDATE SET qty = qty + ?3`).bind(playerId, kind, count),
  ]);
  if (res[0].meta.changes === 0) return "There are not that many left in the chest, or your pack has no room for them.";
  await db.prepare("DELETE FROM town_chest WHERE crew_id = ? AND qty <= 0").bind(crewId).run();
  return null;
}

/**
 * Make a tab a row bigger, for the whole crew, out of one hero's gold and materials. Returns why not, or
 * null once it is done. Two who pay at once pay for one row between them: the second's payment is refused.
 */
export async function chestAddRow(db: D1Database, crewId: string, playerId: string, rawTab: unknown): Promise<string | null> {
  const tab = chestTab(rawTab);
  if (!tab) return "There is no such tab.";
  // The crew's id goes into the statement as text: only one that is plainly an id.
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(crewId)) return "There is no such crew.";
  const rows = (await chestFor(db, crewId)).tabs.find((t) => t.id === tab)!.rows;
  const cost = chestRowCost(rows);
  if (!cost) return "That tab is as big as it can be made.";
  const stillThatSize = `COALESCE((SELECT rows FROM town_chest_tabs WHERE crew_id = '${crewId}' AND tab = '${tab}'), ${TOWN_CHEST_ROWS}) = ${rows}`;
  const spend = spendStatements(db, playerId, cost.gold, cost.resources, stillThatSize);
  const res = await db.batch([
    ...spend,
    db.prepare("INSERT INTO town_chest_tabs (crew_id, tab, rows) SELECT ?1, ?2, ?3 WHERE changes() > 0 ON CONFLICT(crew_id, tab) DO UPDATE SET rows = ?3").bind(crewId, tab, rows + 1),
  ]);
  return res[spend.length].meta.changes > 0 ? null : "You have not the gold and materials for it in your pack.";
}
