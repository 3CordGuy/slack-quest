// D1 access for the overworld game. D1 is the system of record for
// players, characters, inventory and run state.

import type { StatKey, Stats } from "@gantt-quest/core";
import {
  FURNISHINGS,
  HUT_TIERS,
  applyXp,
  buyFurnitureProblem,
  craftProblem,
  displacedFurnishings,
  equipProblem,
  gearSheet,
  heroClass,
  gatherDay,
  PLOT_PRICE,
  hutPerks,
  pubBuff,
  pubItem,
  nextHutTier,
  sellPrice,
  shopStock,
  upgradeProblem,
  weaponItem,
  RESOURCE_KINDS,
  STARTER_BLUEPRINTS,
  type FurnishingGrant,
  type HarborBoard,
  type HarborLogEntry,
  type HarborShip,
  type HeroInit,
  type HutSummary,
  type ResourceKind,
  type Resources,
  type ItemDef,
  type ItemKind,
  type Rarity,
  type ShopEntry,
  type Slot,
  type WorldState,
} from "@gantt-quest/world";
import type { HarborRoom } from "./harbor-room";
import { crewWorks } from "./projects";
import type { HutRoom } from "./hut-room";
import type { PubRoom } from "./pub-room";
import type { RunRoom } from "./run-room";

export interface Env {
  DB: D1Database;
  AI?: Ai;
  ASSETS: Fetcher;
  RUN_ROOM: DurableObjectNamespace<RunRoom>;
  HARBOR_ROOM: DurableObjectNamespace<HarborRoom>;
  HUT_ROOM: DurableObjectNamespace<HutRoom>;
  PUB_ROOM: DurableObjectNamespace<PubRoom>;
  /** "mock" replaces Workers AI with a scripted stand-in. */
  AI_MODE?: string;
  /** Email Sending binding. Without it (and MAIL_FROM_ADDRESS) sign-in codes go to the log. */
  EMAIL?: SendEmail;
  MAIL_FROM_ADDRESS?: string;
  MAIL_FROM_NAME?: string;
}

export interface Player {
  id: string;
  name: string;
  /** Null for a guest: the account exists only in this browser's cookie. */
  email: string | null;
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
  const player: Player = { id: crypto.randomUUID(), name, email: null };
  const token = newToken();
  await db.batch([
    db.prepare("INSERT INTO players (id, name, created_at) VALUES (?, ?, ?)").bind(player.id, name, now()),
    db.prepare("INSERT INTO sessions (token, player_id, created_at) VALUES (?, ?, ?)").bind(token, player.id, now()),
  ]);
  return { player, token };
}

const newToken = () => `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");

export async function createSession(db: D1Database, playerId: string): Promise<string> {
  const token = newToken();
  await db.prepare("INSERT INTO sessions (token, player_id, created_at) VALUES (?, ?, ?)").bind(token, playerId, now()).run();
  return token;
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
}

// ---------- email sign-in ----------

const CODE_TTL_MS = 15 * 60_000;
/** Shortest gap between two code requests for one address. */
const CODE_COOLDOWN_MS = 30_000;
const MAX_CODE_ATTEMPTS = 5;

/** Trimmed and lower-cased, or null if it does not look like an address. */
export function normalizeEmail(raw: unknown): string | null {
  const email = String(raw ?? "").trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/** Issue a fresh six-digit code, replacing any earlier one. Returns "wait" if one was sent moments ago. */
export async function issueEmailCode(db: D1Database, email: string): Promise<string | "wait"> {
  const last = await db.prepare("SELECT created_at FROM email_login_codes WHERE email = ?").bind(email).first<{ created_at: number }>();
  if (last && now() - last.created_at < CODE_COOLDOWN_MS) return "wait";
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  await db
    .prepare(
      `INSERT INTO email_login_codes (email, code, attempts, expires_at, created_at) VALUES (?1, ?2, 0, ?3, ?4)
       ON CONFLICT(email) DO UPDATE SET code = ?2, attempts = 0, expires_at = ?3, created_at = ?4`,
    )
    .bind(email, code, now() + CODE_TTL_MS, now())
    .run();
  return code;
}

/** Check a code. It is used up by a correct guess, by expiring, or by too many wrong guesses. */
export async function consumeEmailCode(db: D1Database, email: string, code: string): Promise<boolean> {
  const row = await db.prepare("SELECT code, attempts, expires_at FROM email_login_codes WHERE email = ?").bind(email).first<{ code: string; attempts: number; expires_at: number }>();
  if (!row) return false;
  const burn = () => db.prepare("DELETE FROM email_login_codes WHERE email = ?").bind(email).run();
  if (row.expires_at < now() || row.attempts >= MAX_CODE_ATTEMPTS) {
    await burn();
    return false;
  }
  if (row.code !== code) {
    await db.prepare("UPDATE email_login_codes SET attempts = attempts + 1 WHERE email = ?").bind(email).run();
    return false;
  }
  await burn();
  return true;
}

export async function playerByEmail(db: D1Database, email: string): Promise<Player | null> {
  return db.prepare("SELECT id, name, email FROM players WHERE email = ?").bind(email).first<Player>();
}

/** Turn a guest into a durable account. False if the address was claimed in the meantime. */
export async function attachEmail(db: D1Database, playerId: string, email: string): Promise<boolean> {
  try {
    const res = await db.prepare("UPDATE players SET email = ? WHERE id = ? AND email IS NULL").bind(email, playerId).run();
    return res.meta.changes > 0;
  } catch {
    return false;
  }
}

export async function createPlayerWithEmail(db: D1Database, email: string): Promise<Player> {
  const player: Player = { id: crypto.randomUUID(), name: "Sailor", email };
  await db.prepare("INSERT INTO players (id, name, email, created_at) VALUES (?, ?, ?, ?)").bind(player.id, player.name, email, now()).run();
  return player;
}

export async function playerForToken(db: D1Database, token: string): Promise<Player | null> {
  return db
    .prepare("SELECT p.id, p.name, p.email FROM sessions s JOIN players p ON p.id = s.player_id WHERE s.token = ?")
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
  const [inventory, orders, placed] = await Promise.all([
    getInventory(db, playerId),
    pubOrders(db, playerId),
    db.prepare("SELECT def_id AS defId, q FROM furnishings WHERE player_id = ? AND q IS NOT NULL").bind(playerId).all<{ defId: string; q: number }>(),
  ]);
  const worn = inventory.filter((i) => i.equipped).map(rowToItem);
  return {
    id: c.player_id,
    name: c.name,
    classId: c.class_id,
    level: c.level,
    xp: c.xp,
    unspent: c.unspent_points,
    base: statsOf(c),
    ...gearSheet(c.class_id, worn),
    // What the furniture standing in their hut gives them on a voyage.
    hutPerks: hutPerks(placed.results),
    // And what they have eaten and drunk at the pub since their last one.
    pubBuff: pubBuff(orders),
  };
}

// ---------- the pub ----------

/** The ids of what a hero has eaten and drunk and not yet used: at most one drink and one meal. */
export async function pubOrders(db: D1Database, playerId: string): Promise<string[]> {
  const rows = await db.prepare("SELECT item_id FROM pub_buffs WHERE player_id = ? ORDER BY kind").bind(playerId).all<{ item_id: string }>();
  return rows.results.map((r) => r.item_id);
}

/**
 * Buy something off the pub's menu. The price comes from the menu, never the
 * caller. Gold is taken and the order recorded together: the second
 * statement only writes if the first one found the gold.
 */
export async function orderAtPub(db: D1Database, playerId: string, itemId: string): Promise<string | { rested: boolean }> {
  const item = pubItem(itemId);
  if (!item) return "That is not on the menu.";
  const today = gatherDay(Date.now());
  const [paid, , rest] = await db.batch([
    db.prepare("UPDATE characters SET gold = gold - ?1 WHERE player_id = ?2 AND status = 'active' AND gold >= ?1").bind(item.price, playerId),
    db
      .prepare("INSERT INTO pub_buffs (player_id, kind, item_id, bought_at) SELECT ?1, ?2, ?3, ?4 WHERE changes() > 0 ON CONFLICT (player_id, kind) DO UPDATE SET item_id = excluded.item_id, bought_at = excluded.bought_at")
      .bind(playerId, item.kind, item.id, Date.now()),
    // A meal (not a drink) also gives back one of today's gathering outings, once a day, and only if one has been used.
    db
      .prepare("UPDATE gathering SET used = used - 1, meal_day = ?2 WHERE player_id = ?1 AND ?3 = 'food' AND changes() > 0 AND day = ?2 AND used > 0 AND (meal_day IS NULL OR meal_day <> ?2)")
      .bind(playerId, today, item.kind),
  ]);
  return paid.meta.changes > 0 ? { rested: rest.meta.changes > 0 } : "You cannot afford that.";
}

/** Home from a voyage, however it went: these heroes can gather again today as if they had not been out. */
export async function restoreGathering(db: D1Database, playerIds: string[]): Promise<void> {
  if (playerIds.length === 0) return;
  await db.prepare(`UPDATE gathering SET used = 0 WHERE player_id IN (${playerIds.map(() => "?").join(",")})`).bind(...playerIds).run();
}

/** A voyage has begun: what these heroes ate and drank is used up. */
export async function clearPubOrders(db: D1Database, playerIds: string[]): Promise<void> {
  if (playerIds.length === 0) return;
  await db.prepare(`DELETE FROM pub_buffs WHERE player_id IN (${playerIds.map(() => "?").join(",")})`).bind(...playerIds).run();
}

// ---------- rewards ----------

/** Write XP, gold and an item to the character as they are earned. */
export async function applyGrant(
  db: D1Database,
  code: string,
  playerId: string,
  grant: { xp: number; gold: number; item: ItemDef | null; resources?: Resources; blueprint?: string; furnishing?: FurnishingGrant },
): Promise<void> {
  const c = await getCharacter(db, playerId);
  if (!c) return;
  const gold = grant.gold;
  const stmts: D1PreparedStatement[] = [];
  if (grant.item) stmts.push(insertItem(db, playerId, grant.item, false));
  if (grant.resources) stmts.push(...resourceStatements(db, playerId, grant.resources));
  if (grant.blueprint) stmts.push(blueprintStatement(db, playerId, grant.blueprint));
  if (grant.furnishing) stmts.push(furnishingStatement(db, playerId, grant.furnishing));
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
  /** JSON array of the Harbor projects the crew had built at launch. */
  projects_json: string;
}

/** `projects` are the Harbor projects the crew has built; they are fixed on the run at launch. */
export async function createRun(db: D1Database, playerId: string, crewId: string | null, projects: string[] = []): Promise<string> {
  // No vowels, so codes never spell anything.
  const alphabet = "BCDFGHJKLMNPQRSTVWXZ";
  for (let attempt = 0; attempt < 5; attempt++) {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    const code = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
    try {
      await db
        .prepare("INSERT INTO runs (code, seed, status, created_by, crew_id, projects_json, created_at, updated_at) VALUES (?, ?, 'lobby', ?, ?, ?, ?, ?)")
        .bind(code, crypto.randomUUID(), playerId, crewId, JSON.stringify(projects), now(), now())
        .run();
      return code;
    } catch {
      // Code collision; try another.
    }
  }
  throw new Error("could not allocate a run code");
}

export async function getRun(db: D1Database, code: string): Promise<RunRow | null> {
  return db.prepare("SELECT code, seed, status, state_json, crew_id, projects_json FROM runs WHERE code = ?").bind(code).first<RunRow>();
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
    // Moving to another crew leaves the old Harbor's plot behind.
    db.prepare("UPDATE huts SET plot = NULL WHERE player_id = ? AND NOT EXISTS (SELECT 1 FROM crew_members WHERE player_id = ?1 AND crew_id = ?2)").bind(playerId, crewId),
    db.prepare("INSERT INTO crew_members (crew_id, player_id, joined_at) VALUES (?, ?, ?)").bind(crewId, playerId, now()),
  ]);
  return crew;
}

export async function leaveCrew(db: D1Database, playerId: string): Promise<void> {
  // A plot is land in one crew's Harbor: leaving the crew gives it up. The hut's contents stay with the player.
  await db.batch([
    db.prepare("DELETE FROM crew_members WHERE player_id = ?").bind(playerId),
    db.prepare("UPDATE huts SET plot = NULL WHERE player_id = ?").bind(playerId),
  ]);
}

/** The plot a player owns in their crew's Harbor, or null. */
export async function plotOf(db: D1Database, playerId: string): Promise<number | null> {
  const row = await db.prepare("SELECT plot FROM huts WHERE player_id = ?").bind(playerId).first<{ plot: number | null }>();
  return row?.plot ?? null;
}

/**
 * Buy a plot in the crew's Harbor. One plot a player, one player a plot. The
 * gold only moves if the plot is still free and the buyer has none, and the
 * plot is only written if the gold moved.
 */
export async function buyPlot(db: D1Database, crewId: string, playerId: string, plot: number, plots: number): Promise<string | null> {
  if (!Number.isInteger(plot) || plot < 0 || plot >= plots) return "There is no such plot.";
  const [paid] = await db.batch([
    db
      .prepare(
        `UPDATE characters SET gold = gold - ?1 WHERE player_id = ?2 AND status = 'active' AND gold >= ?1
         AND NOT EXISTS (SELECT 1 FROM huts WHERE player_id = ?2 AND plot IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM huts h JOIN crew_members m ON m.player_id = h.player_id WHERE m.crew_id = ?3 AND h.plot = ?4)`,
      )
      .bind(PLOT_PRICE, playerId, crewId, plot),
    db.prepare("INSERT INTO huts (player_id, tier, plot) SELECT ?1, 1, ?2 WHERE changes() > 0 ON CONFLICT (player_id) DO UPDATE SET plot = excluded.plot").bind(playerId, plot),
  ]);
  if (paid.meta.changes > 0) return null;
  if ((await plotOf(db, playerId)) !== null) return "You already own a plot.";
  const taken = await db.prepare("SELECT 1 FROM huts h JOIN crew_members m ON m.player_id = h.player_id WHERE m.crew_id = ? AND h.plot = ?").bind(crewId, plot).first();
  return taken ? "Someone has already bought that plot." : `A plot costs ${PLOT_PRICE} gold.`;
}

const LOBBY_STALE_MS = 2 * 60 * 60_000;
const VOYAGE_STALE_MS = 12 * 60 * 60_000;

/** Everything on a Harbor's notice board: who is in the crew, which ships are moored or away, and recent voyages. */
export async function harborBoard(db: D1Database, crewId: string, pierCount: number): Promise<HarborBoard> {
  const [works, members, runs] = await Promise.all([
    crewWorks(db, crewId),
    db
      .prepare(
        `SELECT m.player_id AS id, c.name, c.class_id AS classId, c.level, COALESCE(h.tier, 1) AS hutTier, h.plot AS plot
         FROM crew_members m JOIN characters c ON c.player_id = m.player_id AND c.status = 'active'
         LEFT JOIN huts h ON h.player_id = m.player_id
         WHERE m.crew_id = ? ORDER BY m.joined_at, m.player_id`,
      )
      .bind(crewId)
      .all<{ id: string; name: string; classId: string; level: number; hutTier: number; plot: number | null }>(),
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
  return { members: members.results, ships, log, works };
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
export function furnishingStatement(db: D1Database, playerId: string, furnishing: FurnishingGrant, meta: unknown = {}): D1PreparedStatement {
  return db
    .prepare("INSERT INTO furnishings (player_id, def_id, label, meta_json, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(playerId, furnishing.defId, furnishing.label, JSON.stringify(meta), now());
}

/** A player's hut tier, materials, known blueprints and furnishings. Everyone has a tier 1 hut by default. */
export async function getHut(db: D1Database, playerId: string): Promise<HutSummary> {
  const [hut, resources, blueprints, furnishings] = await Promise.all([
    db.prepare("SELECT tier FROM huts WHERE player_id = ?").bind(playerId).first<{ tier: number }>(),
    db.prepare("SELECT kind, qty FROM resources WHERE player_id = ? AND qty > 0").bind(playerId).all<{ kind: ResourceKind; qty: number }>(),
    db.prepare("SELECT blueprint_id FROM blueprints WHERE player_id = ?").bind(playerId).all<{ blueprint_id: string }>(),
    db
      .prepare("SELECT id, def_id AS defId, label, q, r, facing FROM furnishings WHERE player_id = ? ORDER BY id")
      .bind(playerId)
      .all<HutSummary["furnishings"][number]>(),
  ]);
  return {
    tier: hut?.tier ?? 1,
    resources: Object.fromEntries(resources.results.map((r) => [r.kind, r.qty])),
    blueprints: [...new Set([...STARTER_BLUEPRINTS, ...blueprints.results.map((b) => b.blueprint_id)])],
    furnishings: furnishings.results,
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

// ---------- huts: spending gold and materials ----------

/**
 * Statements that take `gold` and `resources` from a player, all or nothing.
 * The first checks every amount (and `alsoIf`, if given) and takes the gold;
 * each one after it runs only if the one before it changed a row. Follow them
 * with whatever is being paid for, guarded by `changes() > 0` in the same way,
 * and run the lot as one batch: either everything happens or nothing does.
 *
 * Amounts and `alsoIf` are inlined, so they must come from the catalogue,
 * never from a request.
 */
function spendStatements(db: D1Database, playerId: string, gold: number, resources: Resources, alsoIf = "1"): D1PreparedStatement[] {
  const kinds = RESOURCE_KINDS.filter((k) => (resources[k] ?? 0) > 0);
  const amount = (n: number) => Math.max(0, Math.floor(n));
  const enough = kinds.map((k) => `COALESCE((SELECT qty FROM resources WHERE player_id = ?1 AND kind = '${k}'), 0) >= ${amount(resources[k]!)}`);
  const price = amount(gold);
  return [
    db
      .prepare(`UPDATE characters SET gold = gold - ${price} WHERE player_id = ?1 AND status = 'active' AND gold >= ${price} AND ${["(" + alsoIf + ")", ...enough].join(" AND ")}`)
      .bind(playerId),
    ...kinds.map((k) => db.prepare(`UPDATE resources SET qty = qty - ${amount(resources[k]!)} WHERE player_id = ?1 AND kind = '${k}' AND changes() > 0`).bind(playerId)),
  ];
}

/** A new furnishing into storage, but only if the statement before it in the batch changed a row. */
function paidFurnishingStatement(db: D1Database, playerId: string, defId: string): D1PreparedStatement {
  return db
    .prepare("INSERT INTO furnishings (player_id, def_id, label, meta_json, created_at) SELECT ?, ?, ?, '{}', ? WHERE changes() > 0")
    .bind(playerId, defId, FURNISHINGS[defId].name, now());
}

/** Craft a furnishing from materials. Returns an error message, or null once it is in storage. */
export async function craftFurnishing(db: D1Database, playerId: string, defId: string): Promise<string | null> {
  const [c, hut] = await Promise.all([getCharacter(db, playerId), getHut(db, playerId)]);
  if (c?.status !== "active") return "Create a character first.";
  const problem = craftProblem(defId, hut.blueprints, hut.resources);
  if (problem) return problem;
  const res = await db.batch([...spendStatements(db, playerId, 0, FURNISHINGS[defId].recipe!), paidFurnishingStatement(db, playerId, defId)]);
  // The materials went elsewhere between the check and the batch: nothing was spent.
  return res[res.length - 1].meta.changes > 0 ? null : "You no longer have the materials for that.";
}

/** Buy a furnishing at the market stall. The price is the catalogue's; the client names only the piece. */
export async function buyFurniture(db: D1Database, playerId: string, defId: string): Promise<string | null> {
  const c = await getCharacter(db, playerId);
  if (c?.status !== "active") return "Create a character first.";
  const problem = buyFurnitureProblem(defId, c.gold);
  if (problem) return problem;
  const res = await db.batch([...spendStatements(db, playerId, FURNISHINGS[defId].price!, {}), paidFurnishingStatement(db, playerId, defId)]);
  return res[res.length - 1].meta.changes > 0 ? null : "Not enough gold.";
}

/**
 * Make the player's hut one tier bigger. Returns an error message, or the new
 * tier. Furniture the new room has no place for goes back to storage in the
 * same batch (growing never displaces anything, but the rule is kept here so
 * a change to the room shapes cannot strand a piece inside a wall).
 */
export async function upgradeHut(db: D1Database, playerId: string): Promise<string | { tier: number }> {
  const [c, hut] = await Promise.all([getCharacter(db, playerId), getHut(db, playerId)]);
  if (c?.status !== "active") return "Create a character first.";
  const problem = upgradeProblem(hut.tier, c.gold, hut.resources);
  if (problem) return problem;
  const next = nextHutTier(hut.tier)!;
  // The tier is checked again inside the batch, so two requests at once cannot both pay.
  const stillThisTier = `COALESCE((SELECT tier FROM huts WHERE player_id = ?1), ${HUT_TIERS[0].tier}) = ${Math.floor(hut.tier)}`;
  const spend = spendStatements(db, playerId, next.gold, next.resources, stillThisTier);
  const res = await db.batch([
    ...spend,
    db
      .prepare("INSERT INTO huts (player_id, tier) SELECT ?1, ?2 WHERE changes() > 0 ON CONFLICT(player_id) DO UPDATE SET tier = ?2")
      .bind(playerId, next.tier),
    ...displacedFurnishings(next.tier, hut.furnishings).map((f) =>
      db.prepare("UPDATE furnishings SET q = NULL, r = NULL WHERE id = ?1 AND player_id = ?2 AND (SELECT tier FROM huts WHERE player_id = ?2) = ?3").bind(f.id, playerId, next.tier),
    ),
  ]);
  return res[spend.length].meta.changes > 0 ? { tier: next.tier } : "You no longer have what that costs.";
}
