// The town chest in D1 (packages/world/src/townchest.ts): one store a crew
// shares, in tabs. What is in it is the crew's; what goes in comes out of a
// hero's own pack, and what comes out goes into one.
//
// Each move is one batch, whose first statement takes the thing from where
// it is (and does nothing if it is no longer there, or there is no room for
// it where it is going), and whose second puts it where it goes only if the
// first did something. So nothing is made or lost by two of the crew
// reaching in at once.
//
// A stack (materials, lodestones) is a count that moves between the hero's
// own tables and `town_stacks`. A piece of gear is a row that leaves the
// hero's `inventory` for `town_gear`, and comes back as a row in the
// `inventory` of whoever takes it out, under the id it always had.

import {
  STACK_MAX,
  STARTING_TABS,
  TAB_KINDS,
  TOWN_TABS_MAX,
  TOWN_TAB_CELLS,
  addedSlots,
  cleanTabColor,
  cleanTabName,
  gearPutProblem,
  itemCells,
  movedTabs,
  stackPutProblem,
  stackSort,
  tabUsed,
  townTabCost,
  type Slot,
  type TabColor,
  type TabKind,
} from "@gantt-quest/world";
import { CELLS_SQL, carryState, packHasRoomSql, spendStatements, type InventoryRow } from "./db";

/** A piece of gear in the chest, as an `inventory` row would say it: `id` is the one it had in a pack, and has again in the pack of whoever takes it out. */
export type TownGear = Pick<InventoryRow, "id" | "kind" | "ref" | "name" | "rarity" | "slot" | "power" | "level_req" | "icon" | "stat_bonus_json" | "upgrades">;
export interface TownTab {
  id: number;
  name: string;
  kind: TabKind;
  /** The colour the crew gave it, if they gave it one. */
  color: TabColor | null;
  gear: TownGear[];
  /** The stacks in it: each kind of thing, and how many. */
  stacks: { kind: string; qty: number }[];
}
export interface ChestView {
  tabs: TownTab[];
  /** What the next tab would cost in gold, or null if the chest has all the tabs it can. */
  nextTab: number | null;
}

interface TabRow {
  id: number;
  name: string;
  kind: string;
  color: string | null;
}
const GEAR_COLS = "kind, ref, name, rarity, slot, power, level_req, icon, stat_bonus_json, upgrades";
/** SQL for the squares filled in tab `tab` (a number, written in): its gear by footprint, and a square a stack. */
const usedSql = (tab: number) =>
  `((SELECT COALESCE(SUM(${CELLS_SQL}), 0) FROM town_gear WHERE tab_id = ${tab}) + (SELECT COALESCE(SUM((qty + ${STACK_MAX - 1}) / ${STACK_MAX}), 0) FROM town_stacks WHERE tab_id = ${tab} AND qty > 0))`;
/** The table a hero's own stacks of a sort are kept in. Both are (player_id, kind, qty). */
const PACK_TABLE = { material: "resources", lodestone: "consumables" } as const;
const whole = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

/** A crew's tabs, in order: made, the first time they are asked for. */
async function tabsOf(db: D1Database, crewId: string): Promise<TabRow[]> {
  const read = () => db.prepare("SELECT id, name, kind, color FROM town_tabs WHERE crew_id = ? ORDER BY position, id").bind(crewId).all<TabRow>();
  const found = (await read()).results;
  if (found.length > 0) return found;
  // Only if there are still none: two who open it at once make one set between them.
  await db.batch(
    STARTING_TABS.map((t, i) =>
      db.prepare("INSERT INTO town_tabs (crew_id, name, kind, position, created_at) SELECT ?1, ?2, ?3, ?4, ?5 WHERE (SELECT COUNT(*) FROM town_tabs WHERE crew_id = ?1) = ?4").bind(crewId, t.name, t.kind, i, Date.now()),
    ),
  );
  return (await read()).results;
}

/** A crew's town chest: every tab, and what is in it. */
export async function chestFor(db: D1Database, crewId: string): Promise<ChestView> {
  const tabs = await tabsOf(db, crewId);
  const ids = tabs.map((t) => t.id).join(",") || "0";
  const [gear, stacks] = await Promise.all([
    db.prepare(`SELECT id, tab_id, ${GEAR_COLS} FROM town_gear WHERE tab_id IN (${ids}) ORDER BY id`).all<TownGear & { tab_id: number }>(),
    db.prepare(`SELECT tab_id, kind, qty FROM town_stacks WHERE tab_id IN (${ids}) AND qty > 0 ORDER BY kind`).all<{ tab_id: number; kind: string; qty: number }>(),
  ]);
  const general = tabs.filter((t) => t.kind === "general").length;
  return {
    tabs: tabs.map((t) => ({
      id: t.id,
      name: t.name,
      kind: TAB_KINDS.includes(t.kind as TabKind) ? (t.kind as TabKind) : "general",
      color: cleanTabColor(t.color),
      gear: gear.results.filter((g) => g.tab_id === t.id).map(({ tab_id: _tab, ...g }) => g),
      // Only what is a stack at all: anything else in the table is not shown, and cannot be taken.
      stacks: stacks.results.filter((s) => s.tab_id === t.id && stackSort(s.kind)).map(({ kind, qty }) => ({ kind, qty })),
    })),
    nextTab: tabs.length >= TOWN_TABS_MAX ? null : townTabCost(general),
  };
}

/** One of a crew's tabs as it stands: what kind it is, how many of its squares are filled, and what stacks it holds. Null if it is not theirs. */
async function tabOf(db: D1Database, crewId: string, tabId: unknown) {
  if (!whole(tabId)) return null;
  const tab = (await chestFor(db, crewId)).tabs.find((t) => t.id === tabId);
  if (!tab) return null;
  const held = Object.fromEntries(tab.stacks.map((s) => [s.kind, s.qty]));
  return { ...tab, held, used: tabUsed(tab.gear.map((g) => itemCells({ slot: g.slot as Slot, ref: g.ref })), held) };
}

/** Put a piece of gear from a hero's pack into a tab of their crew's chest. Returns why not, or null once it is in. */
export async function chestPutGear(db: D1Database, crewId: string, playerId: string, tabId: unknown, itemId: unknown): Promise<string | null> {
  const tab = await tabOf(db, crewId, tabId);
  if (!tab) return "There is no such tab.";
  if (!whole(itemId)) return "There is no such thing in your pack.";
  const item = await db.prepare("SELECT slot, ref FROM inventory WHERE id = ? AND player_id = ? AND equipped = 0 AND stored_in IS NULL").bind(itemId, playerId).first<{ slot: Slot; ref: string }>();
  if (!item) return "There is no such thing in your pack.";
  const cells = itemCells(item);
  const problem = gearPutProblem(tab.kind, tab.used, cells);
  if (problem) return problem;
  const res = await db.batch([
    db
      .prepare(
        `INSERT INTO town_gear (id, tab_id, ${GEAR_COLS}, put_by, put_at) SELECT id, ?1, ${GEAR_COLS}, ?3, ?4 FROM inventory
         WHERE id = ?2 AND player_id = ?3 AND equipped = 0 AND stored_in IS NULL AND ${usedSql(tab.id)} + ${cells} <= ${TOWN_TAB_CELLS}`,
      )
      .bind(tab.id, itemId, playerId, Date.now()),
    db.prepare("DELETE FROM inventory WHERE id = ?1 AND player_id = ?2 AND changes() > 0").bind(itemId, playerId),
  ]);
  return res[0].meta.changes > 0 ? null : "It is no longer in your pack, or the tab has filled up.";
}

/** Take a piece of gear out of the crew's chest, into a hero's pack. Returns why not, or null once it is out. */
export async function chestTakeGear(db: D1Database, crewId: string, playerId: string, gearId: unknown): Promise<string | null> {
  if (!whole(gearId)) return "There is no such thing in the chest.";
  const [carry, piece] = await Promise.all([
    carryState(db, playerId),
    db.prepare("SELECT g.slot, g.ref FROM town_gear g JOIN town_tabs t ON t.id = g.tab_id WHERE g.id = ? AND t.crew_id = ?").bind(gearId, crewId).first<{ slot: Slot; ref: string }>(),
  ]);
  if (!carry) return "Create a character first.";
  if (!piece) return "It is no longer in the chest.";
  const res = await db.batch([
    db
      .prepare(
        `INSERT INTO inventory (id, player_id, ${GEAR_COLS}, equipped, created_at) SELECT id, ?1, ${GEAR_COLS}, 0, ?3 FROM town_gear
         WHERE id = ?2 AND tab_id IN (SELECT id FROM town_tabs WHERE crew_id = ?4) AND ${packHasRoomSql(carry.limit, itemCells(piece))}`,
      )
      .bind(playerId, gearId, Date.now(), crewId),
    db.prepare("DELETE FROM town_gear WHERE id = ?1 AND changes() > 0").bind(gearId),
  ]);
  return res[0].meta.changes > 0 ? null : "It is no longer in the chest, or your pack has no room for it.";
}

/** Put `n` of a kind of stack from a hero's pack into a tab of their crew's chest. Returns why not, or null once it is in. */
export async function chestPutStack(db: D1Database, crewId: string, playerId: string, tabId: unknown, kind: unknown, n: unknown): Promise<string | null> {
  const tab = await tabOf(db, crewId, tabId);
  if (!tab) return "There is no such tab.";
  const problem = stackPutProblem(tab.kind, tab.used, tab.held, kind, n);
  if (problem) return problem;
  const count = n as number;
  // A new stack in a general tab takes a square of it: the tab must still have one when the stack goes in.
  const room = tab.kind === "general" ? `${usedSql(tab.id)} + ${addedSlots(tab.held[kind as string] ?? 0, count)} <= ${TOWN_TAB_CELLS}` : "1";
  const res = await db.batch([
    db.prepare(`UPDATE ${PACK_TABLE[stackSort(kind)!]} SET qty = qty - ?3 WHERE player_id = ?1 AND kind = ?2 AND qty >= ?3 AND ${room}`).bind(playerId, kind, count),
    db.prepare("INSERT INTO town_stacks (tab_id, kind, qty) SELECT ?1, ?2, ?3 WHERE changes() > 0 ON CONFLICT(tab_id, kind) DO UPDATE SET qty = qty + ?3").bind(tab.id, kind, count),
  ]);
  return res[0].meta.changes > 0 ? null : "You no longer carry that many, or the tab has filled up.";
}

/** Take `n` of a kind of stack out of a tab of the crew's chest, into a hero's pack. Returns why not, or null once it is out. */
export async function chestTakeStack(db: D1Database, crewId: string, playerId: string, tabId: unknown, kind: unknown, n: unknown): Promise<string | null> {
  const tab = await tabOf(db, crewId, tabId);
  const sort = stackSort(kind);
  if (!tab || !sort) return "There is no such thing in the chest.";
  if (!whole(n) || n < 1) return "That is not an amount.";
  const [carry, mine] = await Promise.all([carryState(db, playerId), db.prepare(`SELECT qty FROM ${PACK_TABLE[sort]} WHERE player_id = ? AND kind = ?`).bind(playerId, kind).first<{ qty: number }>()]);
  if (!carry) return "Create a character first.";
  // A new stack takes a square of the pack: the pack must have it when the thing is taken, and not only now.
  const squares = addedSlots(mine?.qty ?? 0, n);
  const res = await db.batch([
    db.prepare(`UPDATE town_stacks SET qty = qty - ?4 WHERE tab_id = ?2 AND kind = ?3 AND qty >= ?4 AND (${squares > 0 ? packHasRoomSql(carry.limit, squares) : "?1 = ?1"})`).bind(playerId, tab.id, kind, n),
    db.prepare(`INSERT INTO ${PACK_TABLE[sort]} (player_id, kind, qty) SELECT ?1, ?2, ?3 WHERE changes() > 0 ON CONFLICT(player_id, kind) DO UPDATE SET qty = qty + ?3`).bind(playerId, kind, n),
  ]);
  if (res[0].meta.changes === 0) return "There are not that many left in the chest, or your pack has no room for them.";
  await db.prepare("DELETE FROM town_stacks WHERE tab_id = ? AND qty <= 0").bind(tab.id).run();
  return null;
}

/**
 * Buy the chest another general tab, for the whole crew, out of one hero's gold. Returns why not, or null
 * once it is there. Two who buy at once buy one tab between them: the second's gold is not taken.
 */
export async function chestBuyTab(db: D1Database, crewId: string, playerId: string, rawName?: unknown): Promise<string | null> {
  // The crew's id goes into the statement as text: only one that is plainly an id.
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(crewId)) return "There is no such crew.";
  const tabs = await tabsOf(db, crewId);
  if (tabs.length >= TOWN_TABS_MAX) return "The chest has all the tabs it can.";
  const general = tabs.filter((t) => t.kind === "general").length;
  const name = cleanTabName(rawName) ?? `Chest ${general + 1}`;
  const spend = spendStatements(db, playerId, townTabCost(general), {}, `(SELECT COUNT(*) FROM town_tabs WHERE crew_id = '${crewId}') = ${tabs.length}`);
  const res = await db.batch([
    ...spend,
    db.prepare("INSERT INTO town_tabs (crew_id, name, kind, position, created_at) SELECT ?1, ?2, 'general', ?3, ?4 WHERE changes() > 0").bind(crewId, name, tabs.length, Date.now()),
  ]);
  return res[spend.length].meta.changes > 0 ? null : "You have not the gold for it.";
}

/** Give one of a crew's tabs another name. Returns why not, or null once it has it. */
export async function chestRenameTab(db: D1Database, crewId: string, tabId: unknown, rawName: unknown): Promise<string | null> {
  const name = cleanTabName(rawName);
  if (!name) return "A tab needs a name.";
  if (!whole(tabId)) return "There is no such tab.";
  const res = await db.prepare("UPDATE town_tabs SET name = ? WHERE id = ? AND crew_id = ?").bind(name, tabId, crewId).run();
  return res.meta.changes > 0 ? null : "There is no such tab.";
}

/** Give one of a crew's tabs a colour, or (with anything that is not one) take its colour away. Returns why not, or null once it is done. */
export async function chestColorTab(db: D1Database, crewId: string, tabId: unknown, rawColor: unknown): Promise<string | null> {
  if (!whole(tabId)) return "There is no such tab.";
  const res = await db.prepare("UPDATE town_tabs SET color = ? WHERE id = ? AND crew_id = ?").bind(cleanTabColor(rawColor), tabId, crewId).run();
  return res.meta.changes > 0 ? null : "There is no such tab.";
}

/** Move one of a crew's tabs to stand `to`th among them (from 0). Returns why not, or null once they stand so. */
export async function chestMoveTab(db: D1Database, crewId: string, tabId: unknown, to: unknown): Promise<string | null> {
  const order = movedTabs((await tabsOf(db, crewId)).map((t) => t.id), tabId, to);
  if (!order) return "There is no such tab, or no such place for it.";
  await db.batch(order.map((id, i) => db.prepare("UPDATE town_tabs SET position = ? WHERE id = ? AND crew_id = ?").bind(i, id, crewId)));
  return null;
}
