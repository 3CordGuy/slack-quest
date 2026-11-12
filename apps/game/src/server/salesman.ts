// Traveling salesmen: the server's side. Who is in and what they carry come
// from packages/world/src/salesman.ts, derived from the crew and the clock;
// nothing here schedules anything. A purchase re-derives the stock, so the
// client names only an index, never an item or a price.

import { FURNISHINGS, SALESMAN_SLOT_MS, nextSalesmanVisit, salesProblem, salesman, salesmanStock, salesmanVisitAt, type SalesEntry, type SalesmanId, type SalesmanVisit } from "@gantt-quest/world";
import { crewFor, getCharacter, getHut, paidFurnishingStatement, paidItemStatement, spendStatements } from "./db";

export interface SalesmanView {
  /** The visitor in the pub now, if any, and their stock as this player sees it. */
  here: (SalesmanVisit & { entries: (SalesEntry & { bought: boolean; problem: string | null })[] }) | null;
  /** The next one due, if none is in. */
  next: { salesmanId: SalesmanId; startsAt: number } | null;
}

/**
 * The visit at `at`. In the dev server only, `force` names a salesman to
 * put in the pub right now, for testing; production builds ignore it.
 */
function visitNow(crewId: string, at: number, force?: string | null): SalesmanVisit | null {
  if (import.meta.env.DEV && force && salesman(force)) {
    const slot = Math.floor(at / SALESMAN_SLOT_MS);
    return { visit: slot, salesmanId: force as SalesmanId, startsAt: slot * SALESMAN_SLOT_MS, endsAt: (slot + 1) * SALESMAN_SLOT_MS };
  }
  return salesmanVisitAt(crewId, at);
}

async function context(db: D1Database, playerId: string, force?: string | null) {
  const [c, crew] = await Promise.all([getCharacter(db, playerId), crewFor(db, playerId)]);
  if (c?.status !== "active") return "Create a character first.";
  if (!crew) return "The pub is for crews. Join one first.";
  const at = Date.now();
  const visit = visitNow(crew.id, at, force);
  return { c, crew, at, visit };
}

async function boughtOn(db: D1Database, playerId: string, crewId: string, visit: SalesmanVisit): Promise<number[]> {
  const rows = await db
    .prepare("SELECT idx FROM salesman_purchases WHERE player_id = ? AND crew_id = ? AND visit = ? AND salesman = ?")
    .bind(playerId, crewId, visit.visit, visit.salesmanId)
    .all<{ idx: number }>();
  return rows.results.map((r) => r.idx);
}

export async function getSalesman(db: D1Database, playerId: string, force?: string | null): Promise<SalesmanView | string> {
  const ctx = await context(db, playerId, force);
  if (typeof ctx === "string") return ctx;
  const { c, crew, at, visit } = ctx;
  if (!visit) {
    const next = nextSalesmanVisit(crew.id, at);
    return { here: null, next: next && { salesmanId: next.salesmanId, startsAt: next.startsAt } };
  }
  const [bought, hut] = await Promise.all([boughtOn(db, playerId, crew.id, visit), getHut(db, playerId)]);
  const buyer = { gold: c.gold, resources: hut.resources, blueprints: hut.blueprints, bought };
  const entries = salesmanStock(crew.id, visit, c.class_id, c.level).map((e) => ({ ...e, bought: bought.includes(e.index), problem: salesProblem(e, buyer) }));
  return { here: { ...visit, entries }, next: null };
}

/** Buy one entry of the visitor's stock. Returns an error message, or what was had. */
export async function buyFromSalesman(db: D1Database, playerId: string, index: unknown, force?: string | null): Promise<string | { got: SalesEntry }> {
  const ctx = await context(db, playerId, force);
  if (typeof ctx === "string") return ctx;
  const { c, crew, visit } = ctx;
  if (!visit) return "Nobody is selling in the pub just now.";
  const [bought, hut] = await Promise.all([boughtOn(db, playerId, crew.id, visit), getHut(db, playerId)]);
  const entry = salesmanStock(crew.id, visit, c.class_id, c.level).find((e) => e.index === index);
  const problem = salesProblem(entry, { gold: c.gold, resources: hut.resources, blueprints: hut.blueprints, bought });
  if (problem || !entry) return problem ?? "There is nothing like that on the table.";

  const { goods } = entry;
  const give =
    goods.kind === "item" ? paidItemStatement(db, playerId, goods.item)
    : goods.kind === "blueprint" ? db.prepare("INSERT OR IGNORE INTO blueprints (player_id, blueprint_id) SELECT ?, ? WHERE changes() > 0").bind(playerId, goods.defId)
    : goods.kind === "furnishing" ? (FURNISHINGS[goods.defId] ? paidFurnishingStatement(db, playerId, goods.defId) : null)
    : db.prepare("UPDATE characters SET gold = gold + ?2 WHERE player_id = ?1 AND status = 'active' AND changes() > 0").bind(playerId, goods.gold);
  if (!give) return "There is nothing like that on the table.";

  // The price and materials come from the derived stock, never from the request.
  const spend = spendStatements(db, playerId, entry.price, entry.materials);
  const mark = db.prepare("INSERT INTO salesman_purchases (player_id, crew_id, visit, salesman, idx, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(playerId, crew.id, visit.visit, visit.salesmanId, entry.index, Date.now());
  try {
    // The purchase row's primary key makes a second buy fail the whole batch.
    // Each statement after the spend runs only if the one before it changed a row.
    const res = await db.batch([mark, ...spend, give]);
    if (res[1].meta.changes === 0) {
      // Gold or materials went elsewhere between the check and the batch: nothing changed hands.
      await db.prepare("DELETE FROM salesman_purchases WHERE player_id = ? AND crew_id = ? AND visit = ? AND salesman = ? AND idx = ?").bind(playerId, crew.id, visit.visit, visit.salesmanId, entry.index).run();
      return entry.price > 0 ? "Not enough gold." : "You no longer have what that takes.";
    }
  } catch {
    return "You have had that one already. One each, this visit.";
  }
  return { got: entry };
}
