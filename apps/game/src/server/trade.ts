// Giving and trading between crewmates, in D1.
//
// The rules of an offer are in packages/world/src/trade.ts. This file stores
// offers and moves the goods. Nothing is held in escrow while an offer is
// open, so everything is checked again when it is accepted, twice over:
//
//   1. On a fresh read, with the same pure checks as when it was proposed,
//      so a refusal can say exactly what is wrong.
//   2. Inside the batch that moves the goods. Its first statement marks the
//      offer accepted only if every condition still holds (the item rows
//      still belong to the giver and are not worn, both sides have the gold
//      and materials, both are still in the crew and neither is in a fight)
//      and stamps it with a one-time token. Every statement after it moves
//      goods only if it finds that token. A D1 batch is one transaction, so
//      either the whole trade happens or none of it does.
//
// Amounts and ownership always come from the stored offer and from D1,
// never from the request that accepts it.

import { RESOURCE_KINDS, TRADE_TTL_MS, carryProblem, isGift, readTradeOffer, tradeProblem, upgradedName, type TradeGoods, type TradeHoldings, type TradeOffer, type WorldState } from "@gantt-quest/world";
import { carryState, type InventoryRow } from "./db";

/** A voyage nobody has touched for this long is taken to be abandoned, as on the dock board. */
const VOYAGE_STALE_MS = 12 * 60 * 60_000;
/** How long a settled or refused offer stays in the list, so both sides hear how it ended. */
const RECENT_MS = 60_000;

interface TradeRow {
  id: number;
  crew_id: string;
  from_id: string;
  to_id: string;
  run_code: string | null;
  give_json: string;
  ask_json: string;
  status: string;
  reason: string | null;
  created_at: number;
  closed_at: number | null;
}

/** An open offer as either side sees it. The items are read live, so one that has since gone is simply missing. */
export interface TradeView {
  id: number;
  from: { id: string; name: string };
  to: { id: string; name: string };
  /** The voyage it was made on, or null for one made in the Harbor. */
  runCode: string | null;
  give: TradeGoods & { items: InventoryRow[]; /** Promised items the giver no longer has to give. */ missing: number };
  ask: TradeGoods;
  gift: boolean;
  expiresAt: number;
}

/** How an offer of the last minute ended. */
export interface TradeOutcome {
  id: number;
  status: "accepted" | "declined" | "withdrawn" | "failed";
  reason: string | null;
  /** True if the viewer made the offer. */
  mine: boolean;
  /** The other player's name. */
  other: string;
}

export interface TradeList {
  open: TradeView[];
  recent: TradeOutcome[];
}

const offerOf = (row: TradeRow): TradeOffer => ({
  to: row.to_id,
  give: JSON.parse(row.give_json) as TradeOffer["give"],
  ask: JSON.parse(row.ask_json) as TradeOffer["ask"],
});

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

interface Party {
  name: string;
  holdings: TradeHoldings;
}

/** A player's name and everything they could trade, or null without an active character. */
async function party(db: D1Database, playerId: string): Promise<Party | null> {
  const [c, res, inv] = await db.batch([
    db.prepare("SELECT name, gold FROM characters WHERE player_id = ? AND status = 'active'").bind(playerId),
    db.prepare("SELECT kind, qty FROM resources WHERE player_id = ? AND qty > 0").bind(playerId),
    db.prepare("SELECT id, name, upgrades, equipped, stored_in FROM inventory WHERE player_id = ?").bind(playerId),
  ]);
  const character = c.results[0] as { name: string; gold: number } | undefined;
  if (!character) return null;
  return {
    name: character.name,
    holdings: {
      gold: character.gold,
      resources: Object.fromEntries((res.results as { kind: string; qty: number }[]).map((r) => [r.kind, r.qty])),
      items: (inv.results as { id: number; name: string; upgrades: number; equipped: number; stored_in: number | null }[]).map((i) => ({ id: i.id, name: upgradedName(i.name, i.upgrades), equipped: !!i.equipped, stored: i.stored_in !== null })),
    },
  };
}

/**
 * The heroes among `ids` who are in a fight right now: aboard a voyage whose
 * stored phase is `battle`. The Durable Object writes a voyage to D1 before
 * it tells anyone, so the row is as current as anything a client has seen.
 */
const FIGHTING_SQL = `SELECT 1 FROM runs r, json_each(r.state_json, '$.heroes') h
  WHERE r.status = 'battle' AND r.state_json IS NOT NULL AND r.updated_at > ? AND json_extract(h.value, '$.id') IN (?, ?)`;

interface Refusal {
  /** Told to the player who asked. */
  error: string;
  /** The same thing with both players named, for the offer's record. */
  reason: string;
  /** True if the offer can never go through and should be closed; false if it only has to wait. */
  final: boolean;
}

interface Terms {
  crewId: string;
  from: string;
  to: string;
  runCode: string | null;
}

/**
 * Why this offer cannot be made (viewer is the proposer) or settled (viewer
 * is the one accepting) right now, or null if it can. Everything here is read
 * from D1.
 */
async function refusal(db: D1Database, offer: TradeOffer, terms: Terms, viewer: string, at: number): Promise<Refusal | null> {
  const { from, to } = terms;
  const [giver, taker, members, fights, run] = await Promise.all([
    party(db, from),
    party(db, to),
    db.prepare("SELECT COUNT(*) AS n FROM crew_members WHERE crew_id = ? AND player_id IN (?, ?)").bind(terms.crewId, from, to).first<{ n: number }>(),
    db
      .prepare(`SELECT DISTINCT json_extract(h.value, '$.id') AS id FROM runs r, json_each(r.state_json, '$.heroes') h
        WHERE r.status = 'battle' AND r.state_json IS NOT NULL AND r.updated_at > ? AND json_extract(h.value, '$.id') IN (?, ?)`)
      .bind(at - VOYAGE_STALE_MS, from, to)
      .all<{ id: string }>(),
    terms.runCode ? db.prepare("SELECT status, state_json FROM runs WHERE code = ?").bind(terms.runCode).first<{ status: string; state_json: string | null }>() : null,
  ]);
  const same = (text: string, final: boolean): Refusal => ({ error: text, reason: text, final });
  if (!giver || !taker) return same("There is no such crewmate to trade with.", true);
  if ((members?.n ?? 0) !== 2) return same("Trading is between members of the same crew.", true);

  const name = (id: string) => (id === from ? giver.name : taker.name);
  const fighting = fights.results.map((r) => r.id);
  if (fighting.length > 0) {
    // The viewer first, so "You are in a fight" wins over naming the other.
    const who = fighting.includes(viewer) ? viewer : fighting[0];
    const wait = "Trading waits until the fight is over.";
    return { error: `${who === viewer ? "You are" : `${name(who)} is`} in a fight. ${wait}`, reason: `${name(who)} is in a fight. ${wait}`, final: false };
  }
  if (terms.runCode) {
    const state = run?.state_json ? (JSON.parse(run.state_json) as WorldState) : null;
    if (!run || !state || run.status === "victory" || run.status === "defeat") return same("That voyage is over.", true);
    if (run.status === "battle") return same("The crew is in a fight. Trading waits until the fight is over.", false);
    if (run.status !== "overworld") return same("Trading on a voyage starts once the crew is ashore.", false);
    const aboard = new Set(state.heroes.map((h) => h.id));
    if (!aboard.has(from) || !aboard.has(to)) return same("On an island you can only trade with a hero on the same voyage.", true);
  }

  // The proposer may ask for more than the other holds; it is only checked once they try to accept.
  const check = (giverName: string, takerName: string) => tradeProblem(offer, { from, giver: giver.holdings, taker: viewer === to ? taker.holdings : undefined, giverName, takerName });
  const error = check(viewer === from ? "You" : giver.name, viewer === to ? "You" : taker.name);
  if (error) return { error, reason: check(giver.name, taker.name) ?? error, final: true };

  // Gear has to fit in the taker's pack. Checked only on accepting: until
  // then they may make room. A full pack waits rather than closing the offer.
  const items = offer.give.items.length;
  if (viewer === to && items > 0) {
    const carry = await carryState(db, to);
    const full = carry && carryProblem(carry, items, "You");
    if (full) return { error: full, reason: carryProblem(carry, items, taker.name)!, final: false };
  }
  return null;
}

/**
 * Open an offer from `playerId`. `raw` is the request body and is read and
 * checked here; `runCode` says the proposer is on that voyage's island (the
 * server confirms it). Returns the new offer's id and the crew, or why not.
 */
export async function proposeTrade(db: D1Database, playerId: string, raw: unknown, runCode: string | null): Promise<{ error: string } | { id: number; crewId: string }> {
  const read = readTradeOffer(raw);
  if (!read.ok) return { error: read.error };
  const { offer } = read;
  if (offer.to === playerId) return { error: "You cannot trade with yourself." };
  const crew = await db.prepare("SELECT crew_id FROM crew_members WHERE player_id = ?").bind(playerId).first<{ crew_id: string }>();
  if (!crew) return { error: "Join a crew first." };
  const at = Date.now();
  const refused = await refusal(db, offer, { crewId: crew.crew_id, from: playerId, to: offer.to, runCode }, playerId, at);
  if (refused) return { error: refused.error };
  const pair = pairKey(playerId, offer.to);
  try {
    const res = await db.batch([
      // An offer nobody answered makes way for a new one.
      db.prepare("UPDATE trades SET status = 'expired', closed_at = ?1 WHERE pair = ?2 AND status = 'open' AND created_at <= ?3").bind(at, pair, at - TRADE_TTL_MS),
      db
        .prepare("INSERT INTO trades (crew_id, from_id, to_id, pair, run_code, give_json, ask_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(crew.crew_id, playerId, offer.to, pair, runCode, JSON.stringify(offer.give), JSON.stringify(offer.ask), at),
    ]);
    return { id: res[1].meta.last_row_id, crewId: crew.crew_id };
  } catch (err) {
    // The one-open-offer-per-pair index refused it.
    if (!String(err instanceof Error ? err.message : err).includes("UNIQUE")) throw err;
    return { error: "You two already have an offer open. Settle that one first." };
  }
}

/**
 * The batch that settles an offer. The first statement is the gate: it marks
 * the offer accepted and stamps `token` on it only if every condition holds
 * at that moment. Each statement after it moves goods only if the offer
 * carries that token, so a second attempt (whose gate changes nothing, and
 * whose token is therefore nowhere) moves nothing.
 */
export function settleStatements(
  db: D1Database,
  row: Pick<TradeRow, "id" | "crew_id" | "from_id" | "to_id" | "run_code">,
  offer: TradeOffer,
  token: string,
  at: number,
  /** How many unequipped items the taker may carry; the items given must fit under it. */
  takerLimit = Number.MAX_SAFE_INTEGER,
): D1PreparedStatement[] {
  const { from_id: from, to_id: to } = row;
  const conditions: string[] = [];
  const binds: (string | number)[] = [];
  const need = (sql: string, ...values: (string | number)[]) => {
    conditions.push(sql);
    binds.push(...values);
  };
  need("(SELECT COUNT(*) FROM crew_members WHERE crew_id = ? AND player_id IN (?, ?)) = 2", row.crew_id, from, to);
  need("(SELECT COUNT(*) FROM characters WHERE status = 'active' AND player_id IN (?, ?)) = 2", from, to);
  need(`NOT EXISTS (${FIGHTING_SQL})`, at - VOYAGE_STALE_MS, from, to);
  if (row.run_code) {
    need(
      `EXISTS (SELECT 1 FROM runs r WHERE r.code = ? AND r.status = 'overworld'
        AND (SELECT COUNT(*) FROM json_each(r.state_json, '$.heroes') h WHERE json_extract(h.value, '$.id') IN (?, ?)) = 2)`,
      row.run_code,
      from,
      to,
    );
  }
  const { items } = offer.give;
  if (items.length > 0) {
    need(`(SELECT COUNT(*) FROM inventory WHERE player_id = ? AND equipped = 0 AND stored_in IS NULL AND id IN (${items.map(() => "?").join(", ")})) = ?`, from, ...items, items.length);
    need("(SELECT COUNT(*) FROM inventory WHERE player_id = ? AND equipped = 0 AND stored_in IS NULL) + ? <= ?", to, items.length, takerLimit);
  }
  for (const [who, goods] of [[from, offer.give], [to, offer.ask]] as const) {
    if (goods.gold > 0) need("(SELECT gold FROM characters WHERE player_id = ?) >= ?", who, goods.gold);
    for (const kind of RESOURCE_KINDS) {
      const qty = goods.resources[kind] ?? 0;
      if (qty > 0) need("COALESCE((SELECT qty FROM resources WHERE player_id = ? AND kind = ?), 0) >= ?", who, kind, qty);
    }
  }

  const settled = "EXISTS (SELECT 1 FROM trades WHERE id = ? AND settle_token = ?)";
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(`UPDATE trades SET status = 'accepted', settle_token = ?, closed_at = ? WHERE id = ? AND status = 'open' AND to_id = ? AND created_at > ? AND ${conditions.join(" AND ")}`)
      .bind(token, at, row.id, to, at - TRADE_TTL_MS, ...binds),
  ];
  if (items.length > 0) {
    // The gear arrives in the other pack, not worn.
    stmts.push(
      db
        .prepare(`UPDATE inventory SET player_id = ? WHERE player_id = ? AND equipped = 0 AND stored_in IS NULL AND id IN (${items.map(() => "?").join(", ")}) AND ${settled}`)
        .bind(to, from, ...items, row.id, token),
    );
  }
  for (const [giver, taker, goods] of [[from, to, offer.give], [to, from, offer.ask]] as const) {
    if (goods.gold > 0) {
      stmts.push(
        db.prepare(`UPDATE characters SET gold = gold - ? WHERE player_id = ? AND ${settled}`).bind(goods.gold, giver, row.id, token),
        db.prepare(`UPDATE characters SET gold = gold + ? WHERE player_id = ? AND ${settled}`).bind(goods.gold, taker, row.id, token),
      );
    }
    for (const kind of RESOURCE_KINDS) {
      const qty = goods.resources[kind] ?? 0;
      if (qty <= 0) continue;
      stmts.push(
        db.prepare(`UPDATE resources SET qty = qty - ? WHERE player_id = ? AND kind = ? AND ${settled}`).bind(qty, giver, kind, row.id, token),
        db
          .prepare(`INSERT INTO resources (player_id, kind, qty) SELECT ?, ?, ? WHERE ${settled} ON CONFLICT(player_id, kind) DO UPDATE SET qty = qty + excluded.qty`)
          .bind(taker, kind, qty, row.id, token),
      );
    }
  }
  return stmts;
}

const fail = (db: D1Database, id: number, reason: string, at: number) =>
  db.prepare("UPDATE trades SET status = 'failed', reason = ?, closed_at = ? WHERE id = ? AND status = 'open'").bind(reason, at, id).run();

/**
 * Accept an offer made to `playerId`. Either everything in it changes hands
 * or nothing does. If someone no longer holds what they promised the offer
 * is closed with the reason; if someone is in a fight it stays open to be
 * accepted afterwards.
 */
export async function acceptTrade(db: D1Database, playerId: string, tradeId: number): Promise<{ error: string } | { ok: true; crewId: string }> {
  const at = Date.now();
  const row = Number.isSafeInteger(tradeId)
    ? await db.prepare("SELECT * FROM trades WHERE id = ? AND to_id = ? AND status = 'open' AND created_at > ?").bind(tradeId, playerId, at - TRADE_TTL_MS).first<TradeRow>()
    : null;
  if (!row) return { error: "That offer is no longer open." };
  const offer = offerOf(row);
  const terms: Terms = { crewId: row.crew_id, from: row.from_id, to: row.to_id, runCode: row.run_code };
  const closed = "Nothing changed hands, and the offer is closed.";

  const refused = await refusal(db, offer, terms, playerId, at);
  if (refused) {
    if (!refused.final) return { error: refused.error };
    await fail(db, row.id, refused.reason, at);
    return { error: `${refused.error} ${closed}` };
  }
  const takerLimit = (await carryState(db, row.to_id))?.limit ?? 0;
  const res = await db.batch(settleStatements(db, row, offer, crypto.randomUUID(), at, takerLimit));
  if (res[0].meta.changes > 0) return { ok: true, crewId: row.crew_id };

  // Something changed between the read above and the batch (an item sold, gold spent, a fight begun). Nothing moved; find out what.
  const why = await refusal(db, offer, terms, playerId, Date.now());
  if (why && !why.final) return { error: why.error };
  const error = why?.error ?? "Something changed while the trade was being settled.";
  await fail(db, row.id, why?.reason ?? error, Date.now());
  return { error: `${error} ${closed}` };
}

/** Decline an offer made to `playerId`, or withdraw one they made. */
export async function closeTrade(db: D1Database, playerId: string, tradeId: number): Promise<{ error: string } | { ok: true }> {
  if (!Number.isSafeInteger(tradeId)) return { error: "That offer is no longer open." };
  const res = await db
    .prepare("UPDATE trades SET status = CASE WHEN from_id = ?1 THEN 'withdrawn' ELSE 'declined' END, closed_at = ?2 WHERE id = ?3 AND status = 'open' AND (from_id = ?1 OR to_id = ?1)")
    .bind(playerId, Date.now(), tradeId)
    .run();
  return res.meta.changes > 0 ? { ok: true } : { error: "That offer is no longer open." };
}

/** The offers `playerId` has open, made or received, and how the ones that closed in the last minute ended. */
export async function listTrades(db: D1Database, playerId: string): Promise<TradeList> {
  const at = Date.now();
  const rows = await db
    .prepare(
      `SELECT t.*, f.name AS from_name, o.name AS to_name
       FROM trades t LEFT JOIN characters f ON f.player_id = t.from_id LEFT JOIN characters o ON o.player_id = t.to_id
       WHERE (t.from_id = ?1 OR t.to_id = ?1)
         AND ((t.status = 'open' AND t.created_at > ?2) OR (t.status IN ('accepted', 'declined', 'withdrawn', 'failed') AND t.closed_at > ?3))
       ORDER BY t.id`,
    )
    .bind(playerId, at - TRADE_TTL_MS, at - RECENT_MS)
    .all<TradeRow & { from_name: string | null; to_name: string | null }>();
  const open = rows.results.filter((r) => r.status === "open");
  const offers = new Map(open.map((r) => [r.id, offerOf(r)]));
  const ids = [...new Set([...offers.values()].flatMap((o) => o.give.items))];
  const items = ids.length
    ? (await db.prepare(`SELECT * FROM inventory WHERE equipped = 0 AND stored_in IS NULL AND id IN (${ids.map(() => "?").join(", ")})`).bind(...ids).all<InventoryRow & { player_id: string }>()).results
    : [];
  return {
    open: open.map((r) => {
      const offer = offers.get(r.id)!;
      const held = offer.give.items.flatMap((id) => items.filter((i) => i.id === id && i.player_id === r.from_id));
      return {
        id: r.id,
        from: { id: r.from_id, name: r.from_name ?? "Someone" },
        to: { id: r.to_id, name: r.to_name ?? "Someone" },
        runCode: r.run_code,
        give: { gold: offer.give.gold, resources: offer.give.resources, items: held, missing: offer.give.items.length - held.length },
        ask: offer.ask,
        gift: isGift(offer),
        expiresAt: r.created_at + TRADE_TTL_MS,
      };
    }),
    recent: rows.results
      .filter((r) => r.status !== "open")
      .map((r) => ({
        id: r.id,
        status: r.status as TradeOutcome["status"],
        reason: r.reason,
        mine: r.from_id === playerId,
        other: (r.from_id === playerId ? r.to_name : r.from_name) ?? "Someone",
      })),
  };
}
