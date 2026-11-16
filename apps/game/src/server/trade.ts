// Trading between crewmates, in D1.
//
// The rules of a trade are in packages/world/src/trade.ts: a table two
// players stand at, each laying out their own side and each accepting what
// they see. This file stores the table and moves the goods.
//
// A row of `trades` is one table. `give_json` is the side of the player who
// opened it (`from_id`), `ask_json` the other's. `rev` counts every change to
// either side; an acceptance names the rev it saw and is refused if the table
// has changed since, and a change takes both acceptances back. So nobody
// agrees to one thing and gets another.
//
// Nothing is held in escrow while the table is open, so everything is
// checked again when the second player accepts, twice over:
//
//   1. On a fresh read, with the same pure checks as when each side was laid
//      out, so a refusal can say exactly what is wrong.
//   2. Inside the batch that moves the goods. Its gate statement marks the
//      trade settled only if both have accepted this rev and every condition
//      still holds (the item rows still belong to whoever offered them and
//      are not worn, both sides have the gold and materials and the room,
//      both are still in the crew and neither is in a fight) and stamps it
//      with a one-time token. Every statement after it moves goods only if
//      it finds that token. A D1 batch is one transaction, so either the
//      whole trade happens or none of it does.
//
// Amounts and ownership always come from the stored table and from D1, never
// from the request that accepts it.

import { RESOURCE_KINDS, TRADE_TTL_MS, emptySide, itemCells, readTradeSide, sideIsEmpty, sideProblem, tradeRoomProblem, upgradedName, type Resources, type Slot, type TradeHoldings, type TradeLoad, type TradeSide, type WorldState } from "@gantt-quest/world";
import { CELLS_SQL, carriedSql, carryState, type Env, type InventoryRow } from "./db";

/** A voyage nobody has touched for this long is taken to be abandoned, as on the dock board. */
const VOYAGE_STALE_MS = 12 * 60 * 60_000;
/** How long a settled or cancelled trade stays in the list, so both sides hear how it ended. */
const RECENT_MS = 60_000;

interface TradeRow {
  id: number;
  crew_id: string;
  from_id: string;
  to_id: string;
  run_code: string | null;
  give_json: string;
  ask_json: string;
  from_ok: number;
  to_ok: number;
  rev: number;
  status: string;
  reason: string | null;
  created_at: number;
  closed_at: number | null;
}

/** One side of the table as it is shown. The items are read live, so one that has since gone is simply missing. */
export interface TradeSideView {
  gold: number;
  resources: Resources;
  items: InventoryRow[];
  /** Items laid out that their owner no longer has to give. */
  missing: number;
  /** Whether this player has accepted the table as it stands. */
  ok: boolean;
}

/** An open trade as one of its two players sees it. */
export interface TradeView {
  id: number;
  /** Counts every change to either side: sent back with an acceptance. */
  rev: number;
  /** The other player. */
  with: { id: string; name: string };
  /** True if the viewer opened the trade. */
  opened: boolean;
  /** The voyage it was opened on, or null for one opened in the Harbor. */
  runCode: string | null;
  mine: TradeSideView;
  theirs: TradeSideView;
  expiresAt: number;
}

/** How a trade of the last minute ended. */
export interface TradeOutcome {
  id: number;
  status: "accepted" | "declined" | "withdrawn" | "failed";
  reason: string | null;
  /** True if the viewer opened the trade. */
  mine: boolean;
  /** The other player: their name and id. */
  other: string;
  otherId: string;
}

export interface TradeList {
  open: TradeView[];
  recent: TradeOutcome[];
}

/** A stored side. Rows from before trades had two full sides hold no items on the second. */
function sideOf(json: string): TradeSide {
  const raw = JSON.parse(json) as Partial<TradeSide>;
  return { items: Array.isArray(raw.items) ? raw.items : [], gold: raw.gold ?? 0, resources: raw.resources ?? {} };
}
/** A side as it is stored: always written the same way, so two that are alike compare alike. */
const store = (side: TradeSide) => JSON.stringify({ items: side.items, gold: side.gold, resources: Object.fromEntries(RESOURCE_KINDS.filter((k) => side.resources[k]).map((k) => [k, side.resources[k]])) });

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
    db.prepare("SELECT id, name, upgrades, equipped, stored_in, slot, ref FROM inventory WHERE player_id = ?").bind(playerId),
  ]);
  const character = c.results[0] as { name: string; gold: number } | undefined;
  if (!character) return null;
  return {
    name: character.name,
    holdings: {
      gold: character.gold,
      resources: Object.fromEntries((res.results as { kind: string; qty: number }[]).map((r) => [r.kind, r.qty])),
      items: (inv.results as { id: number; name: string; upgrades: number; equipped: number; stored_in: number | null; slot: Slot; ref: string }[]).map((i) => ({
        id: i.id,
        name: upgradedName(i.name, i.upgrades),
        equipped: !!i.equipped,
        stored: i.stored_in !== null,
        cells: itemCells(i),
      })),
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
  /** The same thing with both players named, for the trade's record. */
  reason: string;
  /** True if the trade can never go through and should be closed; false if it only has to wait, or be put right. */
  final: boolean;
}

interface Terms {
  crewId: string;
  from: string;
  to: string;
  runCode: string | null;
}

/**
 * Why these two cannot trade right now (opening the table, or settling it),
 * or null if they can. `sides`, when given, are checked too: that each
 * player still has what they laid out, and the room for what is coming.
 * Everything here is read from D1.
 */
async function refusal(db: D1Database, terms: Terms, viewer: string, at: number, sides?: { give: TradeSide; ask: TradeSide }): Promise<Refusal | null> {
  const { from, to } = terms;
  const [opener, other, members, fights, run] = await Promise.all([
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
  if (!opener || !other) return same("There is no such crewmate to trade with.", true);
  if ((members?.n ?? 0) !== 2) return same("Trading is between members of the same crew.", true);

  const name = (id: string) => (id === from ? opener.name : other.name);
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
  if (!sides) return null;

  // Each player still has what they laid out. The table stays open: they can put it right.
  for (const [who, p, side] of [[from, opener, sides.give], [to, other, sides.ask]] as const) {
    const error = sideProblem(side, p.holdings, who === viewer ? "You" : p.name);
    if (error) return { error, reason: sideProblem(side, p.holdings, p.name) ?? error, final: false };
  }
  // And each pack has the room for what is coming, once what is leaving has left.
  const load = (side: TradeSide, p: Party): TradeLoad => ({ cells: side.items.reduce((n, id) => n + (p.holdings.items.find((i) => i.id === id)?.cells ?? 1), 0), resources: side.resources });
  const out = { [from]: load(sides.give, opener), [to]: load(sides.ask, other) };
  for (const [who, p, mine, coming] of [[from, opener, out[from], out[to]], [to, other, out[to], out[from]]] as const) {
    const carry = await carryState(db, who);
    if (!carry) continue;
    const full = tradeRoomProblem(carry, p.holdings.resources, mine, coming, who === viewer ? "You" : p.name);
    if (full) return { error: full, reason: tradeRoomProblem(carry, p.holdings.resources, mine, coming, p.name) ?? full, final: false };
  }
  return null;
}

/**
 * Open the table between `playerId` and `to`, or find the one already open
 * between them. `runCode` says the player is on that voyage's island (the
 * server confirms it). Returns the trade's id and the crew, or why not.
 */
export async function openTrade(db: D1Database, playerId: string, to: unknown, runCode: string | null): Promise<{ error: string } | { id: number; crewId: string }> {
  if (typeof to !== "string" || to.length === 0 || to.length > 64) return { error: "Name the crewmate to trade with." };
  if (to === playerId) return { error: "You cannot trade with yourself." };
  const crew = await db.prepare("SELECT crew_id FROM crew_members WHERE player_id = ?").bind(playerId).first<{ crew_id: string }>();
  if (!crew) return { error: "Join a crew first." };
  const at = Date.now();
  const refused = await refusal(db, { crewId: crew.crew_id, from: playerId, to, runCode }, playerId, at);
  if (refused) return { error: refused.error };
  const pair = pairKey(playerId, to);
  const standing = () => db.prepare("SELECT id, run_code FROM trades WHERE pair = ? AND status = 'open' AND created_at > ?").bind(pair, at - TRADE_TTL_MS).first<{ id: number; run_code: string | null }>();
  const open = await standing();
  // The same table, whoever opened it, as long as it was opened in the same place.
  if (open && open.run_code === runCode) return { id: open.id, crewId: crew.crew_id };
  try {
    const res = await db.batch([
      // A table nobody settled, or one left behind in another place, makes way for a new one.
      db.prepare("UPDATE trades SET status = 'expired', closed_at = ?1 WHERE pair = ?2 AND status = 'open' AND (created_at <= ?3 OR ?4 = 1)").bind(at, pair, at - TRADE_TTL_MS, open ? 1 : 0),
      db
        .prepare("INSERT INTO trades (crew_id, from_id, to_id, pair, run_code, give_json, ask_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(crew.crew_id, playerId, to, pair, runCode, store(emptySide()), store(emptySide()), at),
    ]);
    return { id: res[1].meta.last_row_id, crewId: crew.crew_id };
  } catch (err) {
    // The one-open-trade-per-pair index refused it: the other player opened the table in the same moment.
    if (!String(err instanceof Error ? err.message : err).includes("UNIQUE")) throw err;
    const theirs = await standing();
    return theirs ? { id: theirs.id, crewId: crew.crew_id } : { error: "That trade could not be opened. Try again." };
  }
}

/** The open trade `tradeId` that `playerId` is one of the two players of, or null. */
const openRow = (db: D1Database, playerId: string, tradeId: number, at: number) =>
  Number.isSafeInteger(tradeId)
    ? db.prepare("SELECT * FROM trades WHERE id = ?1 AND (from_id = ?2 OR to_id = ?2) AND status = 'open' AND created_at > ?3").bind(tradeId, playerId, at - TRADE_TTL_MS).first<TradeRow>()
    : null;

const GONE = "That trade is no longer open.";

/**
 * Lay out `playerId`'s side of the table: `raw` replaces it. Both
 * acceptances are taken back, since the table is no longer what either
 * agreed to. Returns the table's new rev, or why not.
 */
export async function setTradeSide(db: D1Database, playerId: string, tradeId: number, raw: unknown): Promise<{ error: string } | { rev: number }> {
  const read = readTradeSide(raw);
  if (!read.ok) return { error: read.error };
  const [row, me] = await Promise.all([openRow(db, playerId, tradeId, Date.now()), party(db, playerId)]);
  if (!row || !me) return { error: GONE };
  const problem = sideProblem(read.side, me.holdings);
  if (problem) return { error: problem };
  const column = row.from_id === playerId ? "give_json" : "ask_json";
  const next = store(read.side);
  // Laying out the same thing again changes nothing, and takes no acceptance back.
  if (next === store(sideOf(row[column]))) return { rev: row.rev };
  const res = await db.batch([
    db.prepare(`UPDATE trades SET ${column} = ?, from_ok = 0, to_ok = 0, rev = rev + 1 WHERE id = ? AND status = 'open'`).bind(next, row.id),
    db.prepare("SELECT rev FROM trades WHERE id = ?").bind(row.id),
  ]);
  return res[0].meta.changes > 0 ? { rev: (res[1].results[0] as { rev: number }).rev } : { error: GONE };
}

/**
 * The statements that settle a trade. The first is the gate: it marks the
 * trade settled and stamps `token` on it only if both players have accepted
 * this rev and every condition holds at that moment. Each statement after it
 * moves goods only if the trade carries that token, so a second attempt
 * (whose gate changes nothing, and whose token is therefore nowhere) moves
 * nothing.
 */
export function settleStatements(
  db: D1Database,
  row: Pick<TradeRow, "id" | "crew_id" | "from_id" | "to_id" | "run_code" | "rev">,
  sides: { give: TradeSide; ask: TradeSide },
  token: string,
  at: number,
  /** How many squares each pack may hold: what arrives must fit under it once what leaves has left. */
  limits: { from: number; to: number } = { from: Number.MAX_SAFE_INTEGER, to: Number.MAX_SAFE_INTEGER },
): D1PreparedStatement[] {
  const { from_id: from, to_id: to } = row;
  const conditions: string[] = [];
  const binds: (string | number)[] = [];
  const need = (sql: string, ...values: (string | number)[]) => {
    conditions.push(sql);
    binds.push(...values);
  };
  const marks = (ids: number[]) => ids.map(() => "?").join(", ");
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
  // [who gives, who takes, what, the taker's pack limit]
  const ways = [[from, to, sides.give, limits.to, sides.ask], [to, from, sides.ask, limits.from, sides.give]] as const;
  for (const [giver, taker, goods, limit, back] of ways) {
    const { items } = goods;
    if (items.length > 0) {
      need(`(SELECT COUNT(*) FROM inventory WHERE player_id = ? AND equipped = 0 AND stored_in IS NULL AND id IN (${marks(items)})) = ?`, giver, ...items, items.length);
      // The taker's pack must have the squares for the gear that is coming, counting what they hand over as gone.
      // A swap that leaves the pack no fuller always goes, even from a pack already over its limit (as tradeRoomProblem).
      const cells = (ids: number[]) => `(SELECT COALESCE(SUM(${CELLS_SQL}), 0) FROM inventory WHERE id IN (${marks(ids)}))`;
      const more = back.items.length > 0 ? `(${cells(items)} - ${cells(back.items)})` : cells(items);
      const moreBinds = [...items, ...back.items];
      need(`(${more} <= 0 OR ${carriedSql("?")} + ${more} <= ?)`, ...moreBinds, taker, taker, taker, ...moreBinds, limit);
    }
    if (goods.gold > 0) need("(SELECT gold FROM characters WHERE player_id = ?) >= ?", giver, goods.gold);
    for (const kind of RESOURCE_KINDS) {
      const qty = goods.resources[kind] ?? 0;
      if (qty > 0) need("COALESCE((SELECT qty FROM resources WHERE player_id = ? AND kind = ?), 0) >= ?", giver, kind, qty);
    }
  }

  const settled = "EXISTS (SELECT 1 FROM trades WHERE id = ? AND settle_token = ?)";
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(`UPDATE trades SET status = 'accepted', settle_token = ?, closed_at = ? WHERE id = ? AND status = 'open' AND from_ok = 1 AND to_ok = 1 AND rev = ? AND created_at > ? AND ${conditions.join(" AND ")}`)
      .bind(token, at, row.id, row.rev, at - TRADE_TTL_MS, ...binds),
  ];
  for (const [giver, taker, goods] of ways) {
    const { items } = goods;
    if (items.length > 0) {
      // The gear arrives in the other pack, not worn.
      stmts.push(
        db
          .prepare(`UPDATE inventory SET player_id = ? WHERE player_id = ? AND equipped = 0 AND stored_in IS NULL AND id IN (${marks(items)}) AND ${settled}`)
          .bind(taker, giver, ...items, row.id, token),
      );
    }
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

const CHANGED = "The offer changed. Look it over, then accept again.";

/**
 * `playerId` accepts the table as it stood at `rev` (or, with `ok` false,
 * takes their acceptance back). When the other player has accepted too,
 * everything on the table changes hands in one batch, or nothing does.
 * `settled` says whether it did. A trade that can never go through (someone
 * has left the crew, the voyage is over) is closed with the reason; one that
 * only has to wait or be put right stays open with both acceptances taken back.
 */
export async function acceptTrade(db: D1Database, playerId: string, tradeId: number, rev: number, ok = true): Promise<{ error: string } | { ok: true; settled: boolean; crewId: string }> {
  const at = Date.now();
  const row = await openRow(db, playerId, tradeId, at);
  if (!row) return { error: GONE };
  const mine = row.from_id === playerId ? "from_ok" : "to_ok";
  if (!ok) {
    await db.prepare(`UPDATE trades SET ${mine} = 0 WHERE id = ? AND status = 'open'`).bind(row.id).run();
    return { ok: true, settled: false, crewId: row.crew_id };
  }
  if (rev !== row.rev) return { error: CHANGED };
  const sides = { give: sideOf(row.give_json), ask: sideOf(row.ask_json) };
  if (sideIsEmpty(sides.give) && sideIsEmpty(sides.ask)) return { error: "Put something in the trade first." };
  const terms: Terms = { crewId: row.crew_id, from: row.from_id, to: row.to_id, runCode: row.run_code };
  const closed = "Nothing changed hands, and the trade is closed.";

  const refused = await refusal(db, terms, playerId, at, sides);
  if (refused) {
    if (!refused.final) return { error: refused.error };
    await fail(db, row.id, refused.reason, at);
    return { error: `${refused.error} ${closed}` };
  }
  const mark = db.prepare(`UPDATE trades SET ${mine} = 1 WHERE id = ? AND status = 'open' AND rev = ?`).bind(row.id, row.rev);
  const bothWill = row.from_id === playerId ? !!row.to_ok : !!row.from_ok;
  if (!bothWill) {
    const res = await mark.run();
    return res.meta.changes > 0 ? { ok: true, settled: false, crewId: row.crew_id } : { error: CHANGED };
  }

  // The other has already accepted this rev: mark this one and settle, in one transaction.
  const [fromCarry, toCarry] = await Promise.all([carryState(db, row.from_id), carryState(db, row.to_id)]);
  const res = await db.batch([mark, ...settleStatements(db, row, sides, crypto.randomUUID(), at, { from: fromCarry?.limit ?? 0, to: toCarry?.limit ?? 0 })]);
  if (res[1].meta.changes > 0) return { ok: true, settled: true, crewId: row.crew_id };
  if (res[0].meta.changes === 0) return { error: CHANGED };

  // Accepted, but nothing moved. Either the other took their acceptance back in that moment (then this one simply
  // stands), or something changed between the read above and the batch (an item sold, gold spent, a fight begun).
  const now = await db.prepare("SELECT status, from_ok, to_ok FROM trades WHERE id = ?").bind(row.id).first<Pick<TradeRow, "status" | "from_ok" | "to_ok">>();
  if (now?.status === "open" && !(now.from_ok && now.to_ok)) return { ok: true, settled: false, crewId: row.crew_id };
  const why = await refusal(db, terms, playerId, Date.now(), sides);
  if (why?.final) {
    await fail(db, row.id, why.reason, Date.now());
    return { error: `${why.error} ${closed}` };
  }
  // Both look again before anything moves.
  await db.prepare("UPDATE trades SET from_ok = 0, to_ok = 0 WHERE id = ? AND status = 'open'").bind(row.id).run();
  return { error: why?.error ?? "Something changed while the trade was being settled. Nothing changed hands." };
}

/** Walk away from the table: the trade is cancelled, whoever opened it. */
export async function closeTrade(db: D1Database, playerId: string, tradeId: number): Promise<{ error: string } | { ok: true }> {
  if (!Number.isSafeInteger(tradeId)) return { error: GONE };
  const res = await db
    .prepare("UPDATE trades SET status = CASE WHEN from_id = ?1 THEN 'withdrawn' ELSE 'declined' END, closed_at = ?2 WHERE id = ?3 AND status = 'open' AND (from_id = ?1 OR to_id = ?1)")
    .bind(playerId, Date.now(), tradeId)
    .run();
  return res.meta.changes > 0 ? { ok: true } : { error: GONE };
}

/** The trades `playerId` has open, as they see them, and how the ones that closed in the last minute ended. */
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
  const sides = new Map(open.map((r) => [r.id, { give: sideOf(r.give_json), ask: sideOf(r.ask_json) }]));
  const ids = [...new Set([...sides.values()].flatMap((s) => [...s.give.items, ...s.ask.items]))];
  const items = ids.length
    ? (await db.prepare(`SELECT * FROM inventory WHERE equipped = 0 AND stored_in IS NULL AND id IN (${ids.map(() => "?").join(", ")})`).bind(...ids).all<InventoryRow & { player_id: string }>()).results
    : [];
  const view = (side: TradeSide, owner: string, ok: number): TradeSideView => {
    const held = side.items.flatMap((id) => items.filter((i) => i.id === id && i.player_id === owner));
    return { gold: side.gold, resources: side.resources, items: held, missing: side.items.length - held.length, ok: !!ok };
  };
  return {
    open: open.map((r) => {
      const { give, ask } = sides.get(r.id)!;
      const opened = r.from_id === playerId;
      const theirs = view(opened ? ask : give, opened ? r.to_id : r.from_id, opened ? r.to_ok : r.from_ok);
      const mine = view(opened ? give : ask, playerId, opened ? r.from_ok : r.to_ok);
      return {
        id: r.id,
        rev: r.rev,
        with: opened ? { id: r.to_id, name: r.to_name ?? "Someone" } : { id: r.from_id, name: r.from_name ?? "Someone" },
        opened,
        runCode: r.run_code,
        mine,
        theirs,
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
        otherId: r.from_id === playerId ? r.to_id : r.from_id,
      })),
  };
}

/**
 * Tell the other player at a table that it changed, wherever they are: the
 * crew's Harbor, any voyage they are on, and the map they are out on. Each room passes it to that
 * player's own socket only, and their client asks for its trades again (the
 * player who made the change has already asked). Nothing is sent to a room
 * nobody is in, so this is how a crewmate's request shows up without anyone
 * polling for it.
 */
export async function announceTrade(env: Env, tradeId: number, actor: string): Promise<void> {
  if (!Number.isSafeInteger(tradeId)) return;
  try {
    const row = await env.DB.prepare("SELECT crew_id, from_id, to_id FROM trades WHERE id = ?").bind(tradeId).first<Pick<TradeRow, "crew_id" | "from_id" | "to_id">>();
    if (!row || (actor !== row.from_id && actor !== row.to_id)) return;
    const who = actor === row.from_id ? row.to_id : row.from_id;
    const runs = await env.DB.prepare(
      `SELECT DISTINCT r.code FROM runs r, json_each(r.state_json, '$.heroes') h
        WHERE r.crew_id = ? AND r.updated_at > ? AND r.status NOT IN ('victory', 'defeat') AND r.state_json IS NOT NULL AND json_extract(h.value, '$.id') = ?`,
    )
      .bind(row.crew_id, Date.now() - VOYAGE_STALE_MS, who)
      .all<{ code: string }>();
    const zone = await env.DB.prepare("SELECT code FROM zone_presence WHERE player_id = ?").bind(who).first<{ code: string }>();
    const to = `?to=${encodeURIComponent(who)}`;
    await Promise.all([
      env.HARBOR_ROOM.get(env.HARBOR_ROOM.idFromName(row.crew_id)).fetch(`https://harbor/trades${to}`, { headers: { "x-crew-id": row.crew_id } }),
      ...runs.results.map((r) => env.RUN_ROOM.get(env.RUN_ROOM.idFromName(r.code)).fetch(`https://run/trades${to}`)),
      ...(zone ? [env.ZONE_ROOM.get(env.ZONE_ROOM.idFromName(zone.code)).fetch(`https://zone/trades${to}`)] : []),
    ]);
  } catch (err) {
    // They will see it the next time they look: on opening the bag, or when their connection comes back.
    console.warn("trade:announce-failed", { tradeId, err: err instanceof Error ? err.message : String(err) });
  }
}
