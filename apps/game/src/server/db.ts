// D1 access for the overworld game. D1 is the system of record for
// players, characters, inventory and run state.

import type { StatKey, Stats } from "@gantt-quest/core";
import {
  applyXp,
  equipProblem,
  heroClass,
  loadoutOf,
  sellPrice,
  shopStock,
  weaponItem,
  type HarborBoard,
  type HarborLogEntry,
  type HarborShip,
  type HeroInit,
  type ItemDef,
  type ItemKind,
  type Rarity,
  type ShopEntry,
  type Slot,
  type WorldState,
} from "@gantt-quest/world";
import type { HarborRoom } from "./harbor-room";
import type { RunRoom } from "./run-room";

export interface Env {
  DB: D1Database;
  AI?: Ai;
  ASSETS: Fetcher;
  RUN_ROOM: DurableObjectNamespace<RunRoom>;
  HARBOR_ROOM: DurableObjectNamespace<HarborRoom>;
  /** "mock" replaces Workers AI with a scripted stand-in. */
  AI_MODE?: string;
}

export interface Player {
  id: string;
  name: string;
}

export interface CharacterRow {
  player_id: string;
  name: string;
  class_id: string;
  status: "draft" | "active";
  level: number;
  xp: number;
  str: number;
  int_stat: number;
  vit: number;
  agi: number;
  dex: number;
  unspent_points: number;
  gold: number;
}

export interface InventoryRow {
  id: number;
  kind: ItemKind;
  ref: string;
  name: string;
  rarity: Rarity;
  slot: Slot;
  power: number;
  level_req: number;
  icon: string;
  stat_bonus_json: string;
  equipped: number;
}

export function rowToItem(row: InventoryRow): ItemDef {
  return {
    kind: row.kind,
    ref: row.ref,
    name: row.name,
    rarity: row.rarity,
    slot: row.slot,
    power: row.power,
    statBonus: JSON.parse(row.stat_bonus_json) as Partial<Stats>,
    levelReq: row.level_req,
    icon: row.icon,
  };
}

function insertItem(db: D1Database, playerId: string, item: ItemDef, equipped: boolean): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO inventory (player_id, kind, ref, name, rarity, slot, power, level_req, icon, stat_bonus_json, equipped, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(playerId, item.kind, item.ref, item.name, item.rarity, item.slot, item.power, item.levelReq, item.icon, JSON.stringify(item.statBonus), equipped ? 1 : 0, Date.now());
}

async function getItem(db: D1Database, playerId: string, itemId: number): Promise<InventoryRow | null> {
  return db.prepare("SELECT * FROM inventory WHERE id = ? AND player_id = ?").bind(itemId, playerId).first<InventoryRow>();
}

const now = () => Date.now();
const STAT_COLUMNS: StatKey[] = ["str", "int_stat", "vit", "agi", "dex"];

export const statsOf = (c: CharacterRow): Stats => ({ str: c.str, int_stat: c.int_stat, vit: c.vit, agi: c.agi, dex: c.dex });

// ---------- players and sessions ----------

export async function createGuest(db: D1Database, name: string): Promise<{ player: Player; token: string }> {
  const player = { id: crypto.randomUUID(), name };
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
  await db.batch([
    db.prepare("INSERT INTO players (id, name, created_at) VALUES (?, ?, ?)").bind(player.id, name, now()),
    db.prepare("INSERT INTO sessions (token, player_id, created_at) VALUES (?, ?, ?)").bind(token, player.id, now()),
  ]);
  return { player, token };
}

export async function playerForToken(db: D1Database, token: string): Promise<Player | null> {
  return db
    .prepare("SELECT p.id, p.name FROM sessions s JOIN players p ON p.id = s.player_id WHERE s.token = ?")
    .bind(token)
    .first<Player>();
}

// ---------- characters ----------

export async function getCharacter(db: D1Database, playerId: string): Promise<CharacterRow | null> {
  return db.prepare("SELECT * FROM characters WHERE player_id = ?").bind(playerId).first<CharacterRow>();
}

export async function getInventory(db: D1Database, playerId: string): Promise<InventoryRow[]> {
  const res = await db.prepare("SELECT * FROM inventory WHERE player_id = ? ORDER BY id").bind(playerId).all<InventoryRow>();
  return res.results;
}

/** Create or overwrite the player's draft character with freshly rolled stats. */
export async function saveDraft(db: D1Database, playerId: string, name: string, classId: string, stats: Stats): Promise<void> {
  await db
    .prepare(
      `INSERT INTO characters (player_id, name, class_id, status, str, int_stat, vit, agi, dex, created_at)
       VALUES (?1, ?2, ?3, 'draft', ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT(player_id) DO UPDATE SET name = ?2, class_id = ?3, str = ?4, int_stat = ?5, vit = ?6, agi = ?7, dex = ?8
       WHERE characters.status = 'draft'`,
    )
    .bind(playerId, name, classId, stats.str, stats.int_stat, stats.vit, stats.agi, stats.dex, now())
    .run();
}

/** Lock in the draft and hand out the class's starting weapon. */
export async function confirmCharacter(db: D1Database, playerId: string): Promise<boolean> {
  const c = await getCharacter(db, playerId);
  if (!c || c.status !== "draft") return false;
  const cls = heroClass(c.class_id);
  if (!cls) return false;
  const weapon = weaponItem(cls.weapons[0]);
  await db.batch([
    db.prepare("UPDATE characters SET status = 'active' WHERE player_id = ?").bind(playerId),
    insertItem(db, playerId, weapon, true),
  ]);
  return true;
}

/** Re-roll: the character and everything it owns is discarded. */
export async function deleteCharacter(db: D1Database, playerId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM inventory WHERE player_id = ?").bind(playerId),
    db.prepare("DELETE FROM characters WHERE player_id = ?").bind(playerId),
  ]);
}

export async function spendPoint(db: D1Database, playerId: string, stat: string): Promise<boolean> {
  if (!STAT_COLUMNS.includes(stat as StatKey)) return false;
  // `stat` is checked against the fixed column list above before being inlined.
  const res = await db
    .prepare(`UPDATE characters SET ${stat} = ${stat} + 1, unspent_points = unspent_points - 1 WHERE player_id = ? AND status = 'active' AND unspent_points > 0`)
    .bind(playerId)
    .run();
  return res.meta.changes > 0;
}

/** Equip an item, swapping out whatever is in its slot. Returns an error message or null. */
export async function equipItem(db: D1Database, playerId: string, itemId: number): Promise<string | null> {
  const [row, c] = await Promise.all([getItem(db, playerId, itemId), getCharacter(db, playerId)]);
  if (!row || !c) return "No such item.";
  const problem = equipProblem(rowToItem(row), c.class_id, c.level);
  if (problem) return `${problem}.`;
  await db.batch([
    db.prepare("UPDATE inventory SET equipped = 0 WHERE player_id = ? AND slot = ?").bind(playerId, row.slot),
    db.prepare("UPDATE inventory SET equipped = 1 WHERE id = ?").bind(itemId),
  ]);
  return null;
}

export async function unequipItem(db: D1Database, playerId: string, itemId: number): Promise<string | null> {
  const row = await getItem(db, playerId, itemId);
  if (!row) return "No such item.";
  // Abilities come from the weapon, so the main hand is only ever swapped.
  if (row.slot === "main_hand") return "You need a weapon in hand. Equip another to swap.";
  await db.prepare("UPDATE inventory SET equipped = 0 WHERE id = ?").bind(itemId).run();
  return null;
}

/** Sell an unequipped item to the market stall. Returns the gold paid, or an error message. */
export async function sellItem(db: D1Database, playerId: string, itemId: number): Promise<number | string> {
  const row = await getItem(db, playerId, itemId);
  if (!row) return "No such item.";
  if (row.equipped) return "Unequip it first.";
  const gold = sellPrice(rowToItem(row));
  const res = await db.batch([
    db.prepare("DELETE FROM inventory WHERE id = ? AND player_id = ? AND equipped = 0").bind(itemId, playerId),
    db.prepare("UPDATE characters SET gold = gold + ? WHERE player_id = ? AND changes() > 0").bind(gold, playerId),
  ]);
  return res[0].meta.changes > 0 ? gold : "No such item.";
}

// ---------- the market stall ----------

const DAY_MS = 24 * 60 * 60_000;

export interface ShopView {
  /** Epoch ms when the stock next changes. */
  refreshAt: number;
  entries: (ShopEntry & { bought: boolean })[];
}

export async function getShop(db: D1Database, playerId: string): Promise<ShopView | null> {
  const c = await getCharacter(db, playerId);
  if (!c || c.status !== "active") return null;
  const day = Math.floor(now() / DAY_MS);
  const bought = await db.prepare("SELECT idx FROM shop_purchases WHERE player_id = ? AND day = ?").bind(playerId, day).all<{ idx: number }>();
  const taken = new Set(bought.results.map((r) => r.idx));
  return {
    refreshAt: (day + 1) * DAY_MS,
    entries: shopStock(`${playerId}|${day}`, c.class_id, c.level).map((e) => ({ ...e, bought: taken.has(e.index) })),
  };
}

/** Buy one entry of today's stock. The stock is re-derived here, so the client cannot name its own item or price. */
export async function buyShopItem(db: D1Database, playerId: string, index: number): Promise<string | null> {
  const [shop, c] = await Promise.all([getShop(db, playerId), getCharacter(db, playerId)]);
  const entry = shop?.entries.find((e) => e.index === index);
  if (!shop || !c || !entry) return "The stall has nothing like that.";
  if (entry.bought) return "Already sold.";
  if (c.gold < entry.price) return "Not enough gold.";
  const day = Math.floor(now() / DAY_MS);
  try {
    // The purchase row's primary key makes a double-buy fail the whole batch.
    const res = await db.batch([
      db.prepare("INSERT INTO shop_purchases (player_id, day, idx) VALUES (?, ?, ?)").bind(playerId, day, index),
      db.prepare("UPDATE characters SET gold = gold - ?1 WHERE player_id = ?2 AND gold >= ?1").bind(entry.price, playerId),
      insertItem(db, playerId, entry.item, false),
    ]);
    if (res[1].meta.changes === 0) {
      // Gold went elsewhere between the check and the batch: undo.
      await db.batch([
        db.prepare("DELETE FROM shop_purchases WHERE player_id = ? AND day = ? AND idx = ?").bind(playerId, day, index),
        db.prepare("DELETE FROM inventory WHERE id = ?").bind(res[2].meta.last_row_id),
      ]);
      return "Not enough gold.";
    }
  } catch {
    return "Already sold.";
  }
  return null;
}

/** Everything a run needs to know about a character when it boards. */
export async function heroInitFor(db: D1Database, playerId: string): Promise<HeroInit | null> {
  const c = await getCharacter(db, playerId);
  if (!c || c.status !== "active") return null;
  const loadout = loadoutOf((await getInventory(db, playerId)).filter((i) => i.equipped).map(rowToItem));
  return {
    id: c.player_id,
    name: c.name,
    classId: c.class_id,
    level: c.level,
    xp: c.xp,
    unspent: c.unspent_points,
    base: statsOf(c),
    bonus: loadout.bonus,
    weapon: loadout.weapon ?? heroClass(c.class_id)!.weapons[0],
    weaponPower: loadout.weaponPower,
    armor: loadout.armor,
  };
}

// ---------- rewards ----------

/** Write XP, gold and an item to the character as they are earned. */
export async function applyGrant(
  db: D1Database,
  code: string,
  playerId: string,
  grant: { xp: number; gold: number; item: ItemDef | null },
): Promise<void> {
  const c = await getCharacter(db, playerId);
  if (!c) return;
  const gold = grant.gold;
  const stmts: D1PreparedStatement[] = [];
  if (grant.item) stmts.push(insertItem(db, playerId, grant.item, false));
  const next = applyXp({ classId: c.class_id, level: c.level, xp: c.xp, stats: statsOf(c), unspent: c.unspent_points }, grant.xp);
  stmts.push(
    db
      .prepare("UPDATE characters SET level = ?, xp = ?, str = ?, int_stat = ?, vit = ?, agi = ?, dex = ?, unspent_points = ?, gold = gold + ? WHERE player_id = ?")
      .bind(next.level, next.xp, next.stats.str, next.stats.int_stat, next.stats.vit, next.stats.agi, next.stats.dex, next.unspent, gold, playerId),
    db
      .prepare(
        `INSERT INTO run_players (code, player_id, xp_earned, gold_earned) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(code, player_id) DO UPDATE SET xp_earned = xp_earned + ?3, gold_earned = gold_earned + ?4`,
      )
      .bind(code, playerId, grant.xp, gold),
  );
  await db.batch(stmts);
}

/** Soft death: lose a capped slice of gold, nothing else. */
export async function applyPenalty(db: D1Database, playerId: string, goldPct: number, cap: number): Promise<void> {
  await db
    .prepare("UPDATE characters SET gold = gold - MIN(?, CAST(gold * ? AS INTEGER)) WHERE player_id = ?")
    .bind(cap, goldPct, playerId)
    .run();
}

// ---------- runs ----------

export interface RunRow {
  code: string;
  seed: string;
  status: string;
  state_json: string | null;
  crew_id: string | null;
}

export async function createRun(db: D1Database, playerId: string, crewId: string | null): Promise<string> {
  // No vowels, so codes never spell anything.
  const alphabet = "BCDFGHJKLMNPQRSTVWXZ";
  for (let attempt = 0; attempt < 5; attempt++) {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    const code = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
    try {
      await db
        .prepare("INSERT INTO runs (code, seed, status, created_by, crew_id, created_at, updated_at) VALUES (?, ?, 'lobby', ?, ?, ?, ?)")
        .bind(code, crypto.randomUUID(), playerId, crewId, now(), now())
        .run();
      return code;
    } catch {
      // Code collision; try another.
    }
  }
  throw new Error("could not allocate a run code");
}

export async function getRun(db: D1Database, code: string): Promise<RunRow | null> {
  return db.prepare("SELECT code, seed, status, state_json, crew_id FROM runs WHERE code = ?").bind(code).first<RunRow>();
}

export function saveRunStatements(db: D1Database, state: WorldState, action: unknown): D1PreparedStatement[] {
  const status = state.phase === "ended" ? (state.result?.outcome ?? "defeat") : state.phase;
  return [
    db
      .prepare("UPDATE runs SET state_json = ?, bible_json = ?, status = ?, updated_at = ? WHERE code = ?")
      .bind(JSON.stringify(state), state.bible ? JSON.stringify(state.bible) : null, status, now(), state.code),
    db.prepare("INSERT INTO run_actions (code, action_json, created_at) VALUES (?, ?, ?)").bind(state.code, JSON.stringify(action), now()),
  ];
}

export function conversationStatement(
  db: D1Database,
  code: string,
  npcId: string,
  speaker: string,
  text: string,
  meta: unknown = null,
): D1PreparedStatement {
  return db
    .prepare("INSERT INTO npc_conversations (code, npc_id, speaker, text, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(code, npcId, speaker, text, meta ? JSON.stringify(meta) : null, now());
}

// ---------- crews and the Harbor ----------

export interface Crew {
  id: string;
  name: string;
}

function randomCode(length: number): string {
  // No vowels, so codes never spell anything.
  const alphabet = "BCDFGHJKLMNPQRSTVWXZ";
  return [...crypto.getRandomValues(new Uint8Array(length))].map((b) => alphabet[b % alphabet.length]).join("");
}

export async function crewFor(db: D1Database, playerId: string): Promise<Crew | null> {
  return db
    .prepare("SELECT c.id, c.name FROM crew_members m JOIN crews c ON c.id = m.crew_id WHERE m.player_id = ?")
    .bind(playerId)
    .first<Crew>();
}

export async function getCrew(db: D1Database, crewId: string): Promise<Crew | null> {
  return db.prepare("SELECT id, name FROM crews WHERE id = ?").bind(crewId).first<Crew>();
}

/** Found a crew and make the founder its first member. Leaves any crew they were in. */
export async function createCrew(db: D1Database, playerId: string, name: string): Promise<Crew> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = randomCode(6);
    try {
      await db.batch([
        db.prepare("INSERT INTO crews (id, name, created_by, created_at) VALUES (?, ?, ?, ?)").bind(id, name, playerId, now()),
        db.prepare("DELETE FROM crew_members WHERE player_id = ?").bind(playerId),
        db.prepare("INSERT INTO crew_members (crew_id, player_id, joined_at) VALUES (?, ?, ?)").bind(id, playerId, now()),
      ]);
      return { id, name };
    } catch {
      // Code collision; try another.
    }
  }
  throw new Error("could not allocate a crew code");
}

/** Join a crew by its invite code, leaving any other crew. Returns null if there is no such crew or it is full. */
export async function joinCrew(db: D1Database, playerId: string, crewId: string, maxMembers: number): Promise<Crew | null> {
  const crew = await getCrew(db, crewId);
  if (!crew) return null;
  const count = await db.prepare("SELECT COUNT(*) AS n FROM crew_members WHERE crew_id = ? AND player_id != ?").bind(crewId, playerId).first<{ n: number }>();
  if ((count?.n ?? 0) >= maxMembers) return null;
  await db.batch([
    db.prepare("DELETE FROM crew_members WHERE player_id = ?").bind(playerId),
    db.prepare("INSERT INTO crew_members (crew_id, player_id, joined_at) VALUES (?, ?, ?)").bind(crewId, playerId, now()),
  ]);
  return crew;
}

export async function leaveCrew(db: D1Database, playerId: string): Promise<void> {
  await db.prepare("DELETE FROM crew_members WHERE player_id = ?").bind(playerId).run();
}

const LOBBY_STALE_MS = 2 * 60 * 60_000;
const VOYAGE_STALE_MS = 12 * 60 * 60_000;

/** Everything on a Harbor's notice board: who is in the crew, which ships are moored or away, and recent voyages. */
export async function harborBoard(db: D1Database, crewId: string, pierCount: number): Promise<HarborBoard> {
  const [members, runs] = await Promise.all([
    db
      .prepare(
        `SELECT m.player_id AS id, c.name, c.class_id AS classId, c.level
         FROM crew_members m JOIN characters c ON c.player_id = m.player_id AND c.status = 'active'
         WHERE m.crew_id = ? ORDER BY m.joined_at, m.player_id`,
      )
      .bind(crewId)
      .all<{ id: string; name: string; classId: string; level: number }>(),
    db
      .prepare(
        `SELECT r.code, r.status, r.state_json, r.updated_at, c.name AS creator
         FROM runs r LEFT JOIN characters c ON c.player_id = r.created_by
         WHERE r.crew_id = ? ORDER BY r.created_at DESC LIMIT 30`,
      )
      .bind(crewId)
      .all<{ code: string; status: string; state_json: string | null; updated_at: number; creator: string | null }>(),
  ]);

  const ships: HarborShip[] = [];
  const log: HarborLogEntry[] = [];
  for (const row of runs.results) {
    // Read-only peek for the dock board; no upgrade needed for the fields used here.
    const state = row.state_json ? (JSON.parse(row.state_json) as WorldState) : null;
    const aboard = state?.heroes.map((h) => h.name) ?? [];
    const captain = state?.heroes.find((h) => h.id === state.hostId)?.name ?? row.creator ?? "Someone";
    if (row.status === "victory" || row.status === "defeat") {
      if (log.length < 8) log.push({ code: row.code, title: state?.bible?.title ?? "An uncharted island", outcome: row.status, crew: aboard, at: row.updated_at });
      continue;
    }
    const age = now() - row.updated_at;
    if (age > (row.status === "lobby" ? LOBBY_STALE_MS : VOYAGE_STALE_MS)) continue;
    ships.push({ code: row.code, captain, aboard, phase: row.status, title: state?.bible?.title ?? null, day: state && state.round > 0 ? state.round : null, pier: null });
  }
  // Oldest moored ship takes the first pier.
  ships.reverse();
  let pier = 0;
  for (const ship of ships) if (ship.phase === "lobby" && pier < pierCount) ship.pier = pier++;
  return { members: members.results, ships, log };
}

/** Ask a crew's Harbor to re-read its notice board and tell everyone present. Never throws. */
export async function refreshHarbor(env: Env, crewId: string | null): Promise<void> {
  if (!crewId) return;
  try {
    await env.HARBOR_ROOM.get(env.HARBOR_ROOM.idFromName(crewId)).fetch("https://harbor/refresh", { headers: { "x-crew-id": crewId } });
  } catch (err) {
    console.warn("harbor:refresh-failed", { err: err instanceof Error ? err.message : String(err) });
  }
}
