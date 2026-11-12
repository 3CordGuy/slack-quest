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
  STALL_BUYS,
  sellMaterialProblem,
  RESOURCE_LABEL,
  storageFree,
  SHACK_COST,
  binDeposit,
  binNeeds,
  STARTER_BLUEPRINTS,
  addStats,
  STORAGE_CHEST,
  carryLimit,
  carryProblem,
  loadoutOf,
  lootPlace,
  storeProblem,
  parseTraits,
  traitPickError,
  type CarryState,
  type LootPlace,
  type FurnishingGrant,
  type HarborBoard,
  type HarborLogEntry,
  type HarborShip,
  type HeroInit,
  type PublicHero,
  type HutSummary,
  type ResourceKind,
  type Resources,
  type ItemDef,
  type ItemKind,
  type Rarity,
  type ShopEntry,
  type Slot,
  type WorldState,
  HARBOR_XP,
} from "@gantt-quest/world";
import { prepareXp, xpOutcome, type XpResult } from "./harbor-xp";
import type { HarborRoom } from "./harbor-room";
import { crewWorks } from "./projects";
import { brewBagOf } from "./workshops";
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
  /** Secret: comma-separated emails allowed into the admin side. Unset means nobody is an admin. */
  ADMIN_EMAILS?: string;
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
  /** JSON list of picked class trait ids. */
  traits: string;
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
  /** The container at home it is kept in, or null while it is worn or carried. */
  stored_in: number | null;
  /** Steps of work done at the smithy, already counted in `power`. */
  upgrades: number;
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
    ...(row.upgrades ? { upgrades: row.upgrades } : {}),
  };
}

function insertItem(db: D1Database, playerId: string, item: ItemDef, equipped: boolean, storedIn: number | null = null): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO inventory (player_id, kind, ref, name, rarity, slot, power, level_req, icon, stat_bonus_json, equipped, stored_in, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(playerId, item.kind, item.ref, item.name, item.rarity, item.slot, item.power, item.levelReq, item.icon, JSON.stringify(item.statBonus), equipped ? 1 : 0, storedIn, Date.now());
}

/**
 * A new unequipped item into the pack, but only if the statement before it
 * in the batch changed a row. Put the pack's room check in that statement
 * (see `buyShopItem`): this one does not look at the limit.
 */
export function paidItemStatement(db: D1Database, playerId: string, item: ItemDef): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO inventory (player_id, kind, ref, name, rarity, slot, power, level_req, icon, stat_bonus_json, equipped, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ? WHERE changes() > 0",
    )
    .bind(playerId, item.kind, item.ref, item.name, item.rarity, item.slot, item.power, item.levelReq, item.icon, JSON.stringify(item.statBonus), Date.now());
}

async function getItem(db: D1Database, playerId: string, itemId: number): Promise<InventoryRow | null> {
  return db.prepare("SELECT * FROM inventory WHERE id = ? AND player_id = ? AND stored_in IS NULL").bind(itemId, playerId).first<InventoryRow>();
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

/** Everything the player has with them: worn gear and the pack. Not what is in storage at home. */
export async function getInventory(db: D1Database, playerId: string): Promise<InventoryRow[]> {
  // Gear kept in a hut's container is out of the bag until it is taken out.
  const res = await db.prepare("SELECT * FROM inventory WHERE player_id = ? AND stored_in IS NULL ORDER BY id").bind(playerId).all<InventoryRow>();
  return res.results;
}

// ---------- the pack, and storage in the hut's containers ----------

/** SQL for how many unequipped items player ?1 carries right now (not kept in a container). */
const CARRIED_SQL = "(SELECT COUNT(*) FROM inventory WHERE player_id = ?1 AND equipped = 0 AND stored_in IS NULL)";
/**
 * SQL, true while player ?1's pack has room for one more under `limit`. The
 * limit is inlined, so it must come from `carryState`, never a request. For
 * the `alsoIf` of `spendStatements`.
 */
export const packHasRoomSql = (limit: number) => `${CARRIED_SQL} < ${Math.max(0, Math.floor(limit))}`;
/** SQL that is true if player ?1 has a hut standing, and so somewhere to keep things. */
const HAS_HOME_SQL = "EXISTS (SELECT 1 FROM huts WHERE player_id = ?1 AND plot IS NOT NULL AND bin_json IS NULL)";
/** SQL for the slots used in container `box` of player ?1: decorations, gear and kinds of material in it (as `containerUsed`). */
const usedSql = (box: string) => `((SELECT COUNT(*) FROM furnishings WHERE in_id = ${box} AND player_id = ?1)
  + (SELECT COUNT(*) FROM inventory WHERE stored_in = ${box} AND player_id = ?1)
  + (SELECT COUNT(*) FROM stash WHERE furnishing_id = ${box} AND player_id = ?1 AND qty > 0))`;

/**
 * The player's containers with a free slot, best first: the free Storage
 * Chest, then whichever has the most room.
 */
async function containersWithRoom(db: D1Database, playerId: string): Promise<{ id: number; defId: string; free: number }[]> {
  const rows = await db
    .prepare(`SELECT f.id, f.def_id AS defId, ${usedSql("f.id")} AS used FROM furnishings f WHERE f.player_id = ?1`)
    .bind(playerId)
    .all<{ id: number; defId: string; used: number }>();
  return rows.results
    .filter((r) => FURNISHINGS[r.defId]?.storage)
    .map((r) => ({ id: r.id, defId: r.defId, free: storageFree(r.defId, r.used) }))
    .filter((r) => r.free > 0)
    .sort((a, b) => Number(b.defId === STORAGE_CHEST) - Number(a.defId === STORAGE_CHEST) || b.free - a.free || a.id - b.id);
}

/**
 * How full the player's pack is, how big it may be (Strength, base plus
 * worn gear), how much gear is kept at home, whether they have a home and
 * how many free slots its containers have. Null without a character.
 */
export async function carryState(db: D1Database, playerId: string): Promise<CarryState | null> {
  const [[c, worn, counts, home], boxes] = await Promise.all([
    db.batch([
      db.prepare("SELECT * FROM characters WHERE player_id = ?1").bind(playerId),
      db.prepare("SELECT * FROM inventory WHERE player_id = ?1 AND equipped = 1").bind(playerId),
      db.prepare(`SELECT ${CARRIED_SQL} AS carried, (SELECT COUNT(*) FROM inventory WHERE player_id = ?1 AND stored_in IS NOT NULL) AS stored`).bind(playerId),
      db.prepare(`SELECT ${HAS_HOME_SQL} AS yes`).bind(playerId),
    ]),
    containersWithRoom(db, playerId),
  ]);
  const character = c.results[0] as CharacterRow | undefined;
  if (!character) return null;
  const bonus = loadoutOf((worn.results as InventoryRow[]).map(rowToItem)).bonus;
  const n = counts.results[0] as { carried: number; stored: number };
  const hasHome = !!(home.results[0] as { yes: number }).yes;
  return {
    carried: n.carried,
    stored: n.stored,
    limit: carryLimit(addStats(statsOf(character), bonus)),
    hasHome,
    room: hasHome ? boxes.reduce((sum, b) => sum + b.free, 0) : 0,
  };
}

/**
 * Statement that keeps item `itemId` in container `boxId` of player ?1, only
 * if it is still carried, there is a home and the container still has a
 * free slot.
 */
const keepStatement = (db: D1Database, playerId: string, itemId: number, boxId: number, slots: number) =>
  db
    .prepare(`UPDATE inventory SET stored_in = ?3 WHERE id = ?2 AND player_id = ?1 AND equipped = 0 AND stored_in IS NULL AND ${HAS_HOME_SQL} AND ${usedSql("?3")} < ?4`)
    .bind(playerId, itemId, boxId, slots);

/**
 * Send an unequipped item to storage at home: into the free Storage Chest,
 * or another container with room. Works from anywhere, as long as there is
 * a home with room. Returns an error message or null.
 */
export async function storeItem(db: D1Database, playerId: string, itemId: number): Promise<string | null> {
  const [row, carry, boxes] = await Promise.all([getItem(db, playerId, itemId), carryState(db, playerId), containersWithRoom(db, playerId)]);
  if (!carry) return "Create a character first.";
  const problem = storeProblem(row && { equipped: !!row.equipped, stored: false }, carry);
  if (problem) return problem;
  const box = boxes[0];
  const res = await keepStatement(db, playerId, itemId, box.id, FURNISHINGS[box.defId].storage!).run();
  return res.meta.changes > 0 ? null : "That item or your chests changed just now. Try again.";
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

/** Pick a class trait. Null on success, else why not. Picks are for keeps. */
export async function pickTrait(db: D1Database, playerId: string, traitId: string): Promise<string | null> {
  const c = await getCharacter(db, playerId);
  if (!c || c.status !== "active") return "No character.";
  const picked = parseTraits(c.traits);
  const error = traitPickError(c.class_id, c.level, picked, traitId);
  if (error) return error;
  // Only if the list is still what was read, so two quick clicks can't both land.
  const res = await db
    .prepare("UPDATE characters SET traits = ? WHERE player_id = ? AND status = 'active' AND traits = ?")
    .bind(JSON.stringify([...picked, traitId]), playerId, c.traits)
    .run();
  return res.meta.changes > 0 ? null : "Try again.";
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

/** For an item `getItem` cannot see: says so if it is kept in a container at home. */
async function keptAtHome(db: D1Database, playerId: string, itemId: number): Promise<string | null> {
  const row = await db.prepare("SELECT 1 AS yes FROM inventory WHERE id = ? AND player_id = ? AND stored_in IS NOT NULL").bind(itemId, playerId).first();
  return row ? "That is kept at home. Take it out there first." : null;
}

/** Equip an item, swapping out whatever is in its slot. Returns an error message or null. */
export async function equipItem(db: D1Database, playerId: string, itemId: number): Promise<string | null> {
  const [row, c] = await Promise.all([getItem(db, playerId, itemId), getCharacter(db, playerId)]);
  if (!row || !c) return (await keptAtHome(db, playerId, itemId)) ?? "No such item.";
  const problem = equipProblem(rowToItem(row), c.class_id, c.level);
  if (problem) return `${problem}.`;
  // Swapping never changes how many are carried: one comes off as the other goes on.
  await db.batch([
    db.prepare("UPDATE inventory SET equipped = 0 WHERE player_id = ?1 AND slot = ?2 AND EXISTS (SELECT 1 FROM inventory WHERE id = ?3 AND stored_in IS NULL)").bind(playerId, row.slot, itemId),
    db.prepare("UPDATE inventory SET equipped = 1 WHERE id = ? AND stored_in IS NULL").bind(itemId),
  ]);
  return null;
}

export async function unequipItem(db: D1Database, playerId: string, itemId: number): Promise<string | null> {
  const row = await getItem(db, playerId, itemId);
  if (!row) return "No such item.";
  // Abilities come from the weapon, so the main hand is only ever swapped.
  if (row.slot === "main_hand") return "You need a weapon in hand. Equip another to swap.";
  // Into the pack even if that puts it over the limit: nothing is ever dropped.
  await db.prepare("UPDATE inventory SET equipped = 0 WHERE id = ?").bind(itemId).run();
  return null;
}

/** Sell an unequipped item to the market stall. Returns the gold paid, or an error message. */
export async function sellItem(db: D1Database, playerId: string, itemId: number): Promise<number | string> {
  const row = await getItem(db, playerId, itemId);
  if (!row) return (await keptAtHome(db, playerId, itemId)) ?? "No such item.";
  if (row.equipped) return "Unequip it first.";
  const gold = sellPrice(rowToItem(row));
  const res = await db.batch([
    db.prepare("DELETE FROM inventory WHERE id = ? AND player_id = ? AND equipped = 0 AND stored_in IS NULL").bind(itemId, playerId),
    db.prepare("UPDATE characters SET gold = gold + ? WHERE player_id = ? AND changes() > 0").bind(gold, playerId),
  ]);
  return res[0].meta.changes > 0 ? gold : "No such item.";
}

/**
 * Sell foraged materials to the market stall. Returns the gold paid, or an
 * error. The price is the catalogue's; the materials and the gold move in one
 * batch, and the gold only if the materials were there to take.
 */
export async function sellMaterial(db: D1Database, playerId: string, kind: unknown, qty: unknown): Promise<number | string> {
  const [c, hut] = await Promise.all([getCharacter(db, playerId), getHut(db, playerId)]);
  if (c?.status !== "active") return "Create a character first.";
  const problem = sellMaterialProblem(kind, qty, hut.resources);
  if (problem) return problem;
  const k = kind as ResourceKind;
  const n = qty as number;
  const gold = STALL_BUYS[k]! * n;
  const [taken] = await db.batch([
    db.prepare("UPDATE resources SET qty = qty - ?3 WHERE player_id = ?1 AND kind = ?2 AND qty >= ?3").bind(playerId, k, n),
    db.prepare("UPDATE characters SET gold = gold + ?2 WHERE player_id = ?1 AND status = 'active' AND changes() > 0").bind(playerId, gold),
  ]);
  return taken.meta.changes > 0 ? gold : "You no longer have that many.";
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
  const [shop, c, carry] = await Promise.all([getShop(db, playerId), getCharacter(db, playerId), carryState(db, playerId)]);
  const entry = shop?.entries.find((e) => e.index === index);
  if (!shop || !c || !carry || !entry) return "The stall has nothing like that.";
  if (entry.bought) return "Already sold.";
  if (c.gold < entry.price) return "Not enough gold.";
  const full = carryProblem(carry, 1);
  if (full) return full;
  const day = Math.floor(now() / DAY_MS);
  try {
    // The first statement checks the gold and the room in the pack again and
    // records the purchase; each one after it runs only if the one before it
    // changed a row. The purchase row's primary key makes a double-buy fail
    // the whole batch.
    const res = await db.batch([
      db
        .prepare(`INSERT INTO shop_purchases (player_id, day, idx) SELECT ?1, ?2, ?3 WHERE (SELECT gold FROM characters WHERE player_id = ?1) >= ?4 AND ${CARRIED_SQL} < ?5`)
        .bind(playerId, day, index, entry.price, carry.limit),
      db.prepare("UPDATE characters SET gold = gold - ?1 WHERE player_id = ?2 AND changes() > 0").bind(entry.price, playerId),
      paidItemStatement(db, playerId, entry.item),
    ]);
    if (res[2].meta.changes === 0) {
      // Gold or room went elsewhere between the check and the batch: nothing happened.
      const fresh = await carryState(db, playerId);
      return (fresh && carryProblem(fresh, 1)) || "Not enough gold.";
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
  const [inventory, orders, placed, brews] = await Promise.all([
    getInventory(db, playerId),
    pubOrders(db, playerId),
    db.prepare("SELECT def_id AS defId, q FROM furnishings WHERE player_id = ? AND q IS NOT NULL").bind(playerId).all<{ defId: string; q: number }>(),
    brewBagOf(db, playerId),
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
    traits: parseTraits(c.traits),
    ...gearSheet(c.class_id, worn),
    // What the furniture standing in their hut gives them on a voyage.
    hutPerks: hutPerks(placed.results),
    // And what they have eaten and drunk at the pub since their last one.
    pubBuff: pubBuff(orders),
    // And the brews in their bag from the apothecary.
    brews,
  };
}

/**
 * A hero as their crewmates and shipmates see them: the sheet that opens on
 * clicking them. Null unless the viewer is that hero, shares their crew, or
 * has sailed on a voyage with them. Only game facts leave here.
 */
export async function publicHero(db: D1Database, viewerId: string, heroId: string): Promise<PublicHero | null> {
  if (viewerId !== heroId) {
    const known = await db
      .prepare(
        `SELECT 1 AS ok WHERE EXISTS (SELECT 1 FROM crew_members a JOIN crew_members b ON a.crew_id = b.crew_id WHERE a.player_id = ?1 AND b.player_id = ?2)
           OR EXISTS (SELECT 1 FROM run_players a JOIN run_players b ON a.code = b.code WHERE a.player_id = ?1 AND b.player_id = ?2)`,
      )
      .bind(viewerId, heroId)
      .first<{ ok: number }>();
    if (!known) return null;
  }
  const [hero, inventory] = await Promise.all([heroInitFor(db, heroId), getInventory(db, heroId)]);
  if (!hero) return null;
  return {
    id: hero.id,
    name: hero.name,
    classId: hero.classId,
    level: hero.level,
    xp: hero.xp,
    base: hero.base,
    bonus: hero.bonus,
    weaponPower: hero.weaponPower,
    armor: hero.armor,
    gear: inventory.filter((i) => i.equipped).map(rowToItem),
    hutPerks: hero.hutPerks,
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
/**
 * Write XP, gold and an item to the character as they are earned. Returns
 * where the item went: the pack if it has room, else the storage chest at
 * home, else the pack anyway, over the limit. Earned gear is never lost.
 */
export async function applyGrant(
  db: D1Database,
  code: string,
  playerId: string,
  grant: { xp: number; gold: number; item: ItemDef | null; resources?: Resources; blueprint?: string; furnishing?: FurnishingGrant },
): Promise<LootPlace | null> {
  const [c, carry, boxes] = await Promise.all([
    getCharacter(db, playerId),
    grant.item ? carryState(db, playerId) : null,
    grant.item ? containersWithRoom(db, playerId) : [],
  ]);
  if (!c) return null;
  const gold = grant.gold;
  const stmts: D1PreparedStatement[] = [];
  const place = carry ? lootPlace(carry) : null;
  // Overflow goes into the best container with room (the free Storage Chest first).
  if (grant.item) stmts.push(insertItem(db, playerId, grant.item, false, place === "storage" ? boxes[0]?.id ?? null : null));
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
  return place;
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

/**
 * A player's plot and, while their shack is still to be raised, what is in the
 * resource bin on it. `bin` is null once the shack stands.
 */
export async function homeOf(db: D1Database, playerId: string): Promise<{ plot: number | null; bin: Resources | null }> {
  const row = await db.prepare("SELECT plot, bin_json FROM huts WHERE player_id = ?").bind(playerId).first<{ plot: number | null; bin_json: string | null }>();
  return { plot: row?.plot ?? null, bin: row?.plot != null && row.bin_json !== null ? parseBin(row.bin_json) : null };
}

/** True if the player has a plot with a shack standing on it: a hut to walk into and rest in. */
export async function hasShack(db: D1Database, playerId: string): Promise<boolean> {
  const home = await homeOf(db, playerId);
  return home.plot !== null && home.bin === null;
}

function parseBin(json: string): Resources {
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const out: Resources = {};
    for (const k of RESOURCE_KINDS) {
      const n = Math.floor(Number(raw?.[k] ?? 0));
      if (n > 0) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Put materials into the resource bin on the player's plot: as much of each
 * kind as they hold, up to what the shack still needs. Once the bin is full
 * the shack goes up. Each kind moves in a pair of statements, the second
 * running only if the first took the materials, and the bin is checked again
 * inside them so two requests at once cannot overfill it.
 */
export async function fillBin(db: D1Database, playerId: string): Promise<string | { put: Resources; bin: Resources | null }> {
  const [home, hut] = await Promise.all([homeOf(db, playerId), getHut(db, playerId)]);
  if (home.plot === null) return "You have no plot to build on.";
  if (home.bin === null) return "Your shack is already standing.";
  const put = binDeposit(home.bin, hut.resources);
  const kinds = RESOURCE_KINDS.filter((k) => (put[k] ?? 0) > 0);
  if (kinds.length === 0) {
    const need = binNeeds(home.bin);
    return `The bin still wants ${RESOURCE_KINDS.filter((k) => need[k]).map((k) => `${need[k]} ${RESOURCE_LABEL[k].toLowerCase()}`).join(" and ")}, and you have none to put in.`;
  }
  const inBin = (k: string) => `COALESCE(json_extract(bin_json, '$.${k}'), 0)`;
  const statements = kinds.flatMap((k) => [
    db
      .prepare(
        `UPDATE resources SET qty = qty - ?2 WHERE player_id = ?1 AND kind = '${k}' AND qty >= ?2
         AND EXISTS (SELECT 1 FROM huts WHERE player_id = ?1 AND plot IS NOT NULL AND bin_json IS NOT NULL AND ${inBin(k)} + ?2 <= ?3)`,
      )
      .bind(playerId, put[k], SHACK_COST[k] ?? 0),
    db.prepare(`UPDATE huts SET bin_json = json_set(bin_json, '$.${k}', ${inBin(k)} + ?2) WHERE player_id = ?1 AND changes() > 0`).bind(playerId, put[k]),
  ]);
  const full = RESOURCE_KINDS.filter((k) => (SHACK_COST[k] ?? 0) > 0).map((k) => `${inBin(k)} >= ${Math.floor(SHACK_COST[k]!)}`);
  statements.push(db.prepare(`UPDATE huts SET bin_json = NULL WHERE player_id = ?1 AND bin_json IS NOT NULL AND ${full.join(" AND ")}`).bind(playerId));
  const res = await db.batch(statements);
  const moved: Resources = {};
  kinds.forEach((k, i) => {
    if (res[i * 2 + 1].meta.changes > 0) moved[k] = put[k];
  });
  if (Object.keys(moved).length === 0) return "The bin or your materials changed just now. Try again.";
  return { put: moved, bin: (await homeOf(db, playerId)).bin };
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
    // New ground has only a resource bin on it; the shack goes up once the bin is filled.
    db
      .prepare("INSERT INTO huts (player_id, tier, plot, bin_json) SELECT ?1, 1, ?2, '{}' WHERE changes() > 0 ON CONFLICT (player_id) DO UPDATE SET plot = excluded.plot, bin_json = '{}'")
      .bind(playerId, plot),
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
        `SELECT m.player_id AS id, c.name, c.class_id AS classId, c.level, COALESCE(h.tier, 1) AS hutTier, h.plot AS plot, h.bin_json AS bin
         FROM crew_members m JOIN characters c ON c.player_id = m.player_id AND c.status = 'active'
         LEFT JOIN huts h ON h.player_id = m.player_id
         WHERE m.crew_id = ? ORDER BY m.joined_at, m.player_id`,
      )
      .bind(crewId)
      .all<{ id: string; name: string; classId: string; level: number; hutTier: number; plot: number | null; bin: string | null }>(),
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
  // Members whose shack is not up yet carry what is in its bin, so the site can be drawn filling up.
  const roster = members.results.map(({ bin, ...m }) => (m.plot !== null && bin !== null ? { ...m, bin: parseBin(bin) } : m));
  return { members: roster, ships, log, works };
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
  const [hut, resources, blueprints, furnishings, stash, stowed] = await Promise.all([
    db.prepare("SELECT tier FROM huts WHERE player_id = ?").bind(playerId).first<{ tier: number }>(),
    db.prepare("SELECT kind, qty FROM resources WHERE player_id = ? AND qty > 0").bind(playerId).all<{ kind: ResourceKind; qty: number }>(),
    db.prepare("SELECT blueprint_id FROM blueprints WHERE player_id = ?").bind(playerId).all<{ blueprint_id: string }>(),
    db
      .prepare("SELECT id, def_id AS defId, label, q, r, facing, x, z, angle, on_id AS onId, in_id AS inId FROM furnishings WHERE player_id = ? ORDER BY id")
      .bind(playerId)
      .all<HutSummary["furnishings"][number]>(),
    db
      .prepare("SELECT furnishing_id AS containerId, kind, qty FROM stash WHERE player_id = ? AND qty > 0 ORDER BY furnishing_id, kind")
      .bind(playerId)
      .all<HutSummary["stash"][number]>(),
    db
      .prepare("SELECT id AS itemId, stored_in AS containerId, name, icon, slot, rarity FROM inventory WHERE player_id = ? AND stored_in IS NOT NULL ORDER BY id")
      .bind(playerId)
      .all<HutSummary["stowed"][number]>(),
  ]);
  return {
    tier: hut?.tier ?? 1,
    resources: Object.fromEntries(resources.results.map((r) => [r.kind, r.qty])),
    blueprints: [...new Set([...STARTER_BLUEPRINTS, ...blueprints.results.map((b) => b.blueprint_id)])],
    furnishings: furnishings.results,
    stash: stash.results,
    stowed: stowed.results,
  };
}

// ---------- containers: what a chest, crate or cupboard holds ----------

/** How many slots of a container are filled: decorations in it, gear in it, and one per kind of material. */
export async function containerUsed(db: D1Database, playerId: string, containerId: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM furnishings WHERE in_id = ?1 AND player_id = ?2)
            + (SELECT COUNT(*) FROM inventory WHERE stored_in = ?1 AND player_id = ?2)
            + (SELECT COUNT(*) FROM stash WHERE furnishing_id = ?1 AND player_id = ?2 AND qty > 0) AS used`,
    )
    .bind(containerId, playerId)
    .first<{ used: number }>();
  return row?.used ?? 0;
}

/** The owner's container `containerId`, or null if it is not theirs or holds nothing. */
async function ownContainer(db: D1Database, playerId: string, containerId: number): Promise<{ defId: string } | null> {
  if (!Number.isSafeInteger(containerId)) return null;
  const row = await db.prepare("SELECT def_id AS defId FROM furnishings WHERE id = ? AND player_id = ?").bind(containerId, playerId).first<{ defId: string }>();
  return row && FURNISHINGS[row.defId]?.storage ? row : null;
}

/**
 * Move materials between the owner's pool and a container: a positive `qty`
 * puts that many in, a negative one takes them out. Returns an error, or null.
 * Each side is only changed if the other had them.
 */
export async function stashMaterial(db: D1Database, playerId: string, containerId: number, kind: unknown, qty: unknown): Promise<string | null> {
  const k = RESOURCE_KINDS.find((r) => r === kind);
  if (!k) return "That is not a material.";
  if (typeof qty !== "number" || !Number.isSafeInteger(qty) || qty === 0) return "Move at least one.";
  const box = await ownContainer(db, playerId, containerId);
  if (!box) return "That does not hold anything.";
  const n = Math.abs(qty);
  if (qty > 0) {
    const [has, used] = await Promise.all([
      db.prepare("SELECT qty FROM stash WHERE furnishing_id = ? AND kind = ? AND qty > 0").bind(containerId, k).first<{ qty: number }>(),
      containerUsed(db, playerId, containerId),
    ]);
    if (!has && storageFree(box.defId, used) < 1) return "It is full.";
    const res = await db.batch([
      db.prepare("UPDATE resources SET qty = qty - ?3 WHERE player_id = ?1 AND kind = ?2 AND qty >= ?3").bind(playerId, k, n),
      db
        .prepare("INSERT INTO stash (furnishing_id, player_id, kind, qty) SELECT ?1, ?2, ?3, ?4 WHERE changes() > 0 ON CONFLICT(furnishing_id, kind) DO UPDATE SET qty = qty + excluded.qty")
        .bind(containerId, playerId, k, n),
    ]);
    return res[0].meta.changes > 0 ? null : `You do not have ${n} ${RESOURCE_LABEL[k].toLowerCase()}.`;
  }
  const res = await db.batch([
    db.prepare("UPDATE stash SET qty = qty - ?4 WHERE furnishing_id = ?1 AND player_id = ?2 AND kind = ?3 AND qty >= ?4").bind(containerId, playerId, k, n),
    db
      .prepare("INSERT INTO resources (player_id, kind, qty) SELECT ?1, ?2, ?3 WHERE changes() > 0 ON CONFLICT(player_id, kind) DO UPDATE SET qty = qty + excluded.qty")
      .bind(playerId, k, n),
    db.prepare("DELETE FROM stash WHERE furnishing_id = ? AND qty <= 0").bind(containerId),
  ]);
  return res[0].meta.changes > 0 ? null : `There are not ${n} ${RESOURCE_LABEL[k].toLowerCase()} in there.`;
}

/** Put a piece of gear from the bag into a container. Worn gear has to be taken off first. Returns an error, or null. */
export async function stowGear(db: D1Database, playerId: string, containerId: number, itemId: number): Promise<string | null> {
  const [box, item, used] = await Promise.all([ownContainer(db, playerId, containerId), getItem(db, playerId, itemId), containerUsed(db, playerId, containerId)]);
  if (!box) return "That does not hold anything.";
  if (!item) return "No such item.";
  if (item.equipped) return "Take it off first.";
  if (storageFree(box.defId, used) < 1) return "It is full.";
  // The room in the container is checked again inside the write, as for "Send to storage".
  const res = await keepStatement(db, playerId, itemId, containerId, FURNISHINGS[box.defId].storage!).run();
  return res.meta.changes > 0 ? null : "It filled up, or that item moved. Try again.";
}

/**
 * Take a piece of gear out of whatever container holds it, back into the
 * pack. Refused if the pack is full; the count is checked again inside the
 * write. The route only calls this for a player standing in their own hut.
 */
export async function unstowGear(db: D1Database, playerId: string, itemId: number): Promise<string | null> {
  if (!Number.isSafeInteger(itemId)) return "No such item.";
  const carry = await carryState(db, playerId);
  if (!carry) return "Create a character first.";
  const full = carryProblem(carry, 1);
  if (full) return full;
  const res = await db
    .prepare(`UPDATE inventory SET stored_in = NULL WHERE id = ?2 AND player_id = ?1 AND stored_in IS NOT NULL AND ${CARRIED_SQL} < ?3`)
    .bind(playerId, itemId, carry.limit)
    .run();
  if (res.meta.changes > 0) return null;
  const fresh = await carryState(db, playerId);
  return (fresh && carryProblem(fresh, 1)) || "That is not in a container.";
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
export function spendStatements(db: D1Database, playerId: string, gold: number, resources: Resources, alsoIf = "1"): D1PreparedStatement[] {
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
export function paidFurnishingStatement(db: D1Database, playerId: string, defId: string): D1PreparedStatement {
  return db
    .prepare("INSERT INTO furnishings (player_id, def_id, label, meta_json, created_at) SELECT ?, ?, ?, '{}', ? WHERE changes() > 0")
    .bind(playerId, defId, FURNISHINGS[defId].name, now());
}

/** Craft a furnishing from materials. Returns an error message, or null once it is in storage. */
export async function craftFurnishing(db: D1Database, playerId: string, defId: string): Promise<string | { xp?: XpResult }> {
  const [c, hut] = await Promise.all([getCharacter(db, playerId), getHut(db, playerId)]);
  if (c?.status !== "active") return "Create a character first.";
  const problem = craftProblem(defId, hut.blueprints, hut.resources);
  if (problem) return problem;
  const xp = await prepareXp(db, playerId, HARBOR_XP.craft);
  const made = [...spendStatements(db, playerId, 0, FURNISHINGS[defId].recipe!), paidFurnishingStatement(db, playerId, defId)];
  const res = await db.batch([...made, ...(xp?.statements() ?? [])]);
  // The materials went elsewhere between the check and the batch: nothing was spent.
  return res[made.length - 1].meta.changes > 0 ? { xp: xpOutcome(xp, res) } : "You no longer have the materials for that.";
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
      db.prepare("UPDATE furnishings SET q = NULL, r = NULL, on_id = NULL WHERE id = ?1 AND player_id = ?2 AND (SELECT tier FROM huts WHERE player_id = ?2) = ?3").bind(f.id, playerId, next.tier),
    ),
  ]);
  return res[spend.length].meta.changes > 0 ? { tier: next.tier } : "You no longer have what that costs.";
}
