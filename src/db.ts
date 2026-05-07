// D1 query helpers. Raw prepared statements — no ORM.

import type { ItemType, Rarity } from "./flavor";

export interface Item {
  id: number;
  character_id: string;
  item_name: string;
  item_type: ItemType;
  power: number;
  rarity: Rarity;
  flavor: string | null;
  equipped: boolean;
}

interface ItemRow extends Omit<Item, "equipped"> {
  equipped: number;
}

function rowToItem(row: ItemRow): Item {
  return { ...row, equipped: row.equipped === 1 };
}

export interface Character {
  slack_user_id: string;
  slack_team_id: string;
  name: string;
  class: string;
  level: number;
  xp: number;
  hp: number;
  max_hp: number;
  mana: number;
  max_mana: number;
  shield: number;
  gold: number;
  scars: string[];
  downed_until: number | null;
  created_at: number;
  last_active: number;
}

interface CharacterRow extends Omit<Character, "scars"> {
  scars: string;
}

function rowToCharacter(row: CharacterRow): Character {
  return { ...row, scars: JSON.parse(row.scars) as string[] };
}

export async function getCharacter(db: D1Database, userId: string): Promise<Character | null> {
  const row = await db
    .prepare("SELECT * FROM characters WHERE slack_user_id = ?")
    .bind(userId)
    .first<CharacterRow>();
  return row ? rowToCharacter(row) : null;
}

export interface CreateCharacterInput {
  slack_user_id: string;
  slack_team_id: string;
  name: string;
  class: string;
  hp: number;
  max_hp: number;
}

export async function createCharacter(
  db: D1Database,
  input: CreateCharacterInput,
): Promise<Character> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO characters
       (slack_user_id, slack_team_id, name, class, level, xp, hp, max_hp, gold, scars, created_at, last_active)
       VALUES (?, ?, ?, ?, 1, 0, ?, ?, 10, '[]', ?, ?)`,
    )
    .bind(
      input.slack_user_id,
      input.slack_team_id,
      input.name,
      input.class,
      input.hp,
      input.max_hp,
      now,
      now,
    )
    .run();
  const row = await getCharacter(db, input.slack_user_id);
  if (!row) throw new Error("Failed to read back created character");
  return row;
}

export type QuestVariant = "standard" | "boss" | "gauntlet" | "expedition";

export interface GauntletWave {
  name: string;
  max_hp: number;
  scene: string;
}

// An expedition node is one screen of an expedition quest. Types map to player actions:
//   "fork" → players use /dnd choose 1|2 to advance
//   "combat" → players use /dnd attack/cast (existing combat resolves it)
//   "treasure" → players use /dnd take 1|2 to claim one item from the chest
export type ExpeditionNodeType = "fork" | "combat" | "treasure";

export interface ExpeditionNode {
  type: ExpeditionNodeType;
  scene: string;
  // fork-only
  choices?: string[];
  // treasure-only — pre-rolled and AI-named at expedition start
  loot_options?: Array<{
    name: string;
    item_type: ItemType;
    power: number;
    rarity: Rarity;
    flavor: string;
  }>;
}

export interface ExpeditionState {
  theme: string;
  current: number; // index into nodes
  nodes: ExpeditionNode[];
  path_taken: string[]; // labels of fork choices
  // Expedition combat uses scene_json's monster_name/hp/max_hp at the combat node.
}

export interface SceneJson {
  monster_name: string;
  monster_hp: number;
  monster_max_hp: number;
  tier: number;
  scene: string;
  variant?: QuestVariant;
  // Boss-only: tracks the 50% HP power-up transition.
  boss_phase?: 1 | 2;
  // Gauntlet-only: current wave index (1-based) and queued upcoming waves.
  wave?: number;
  total_waves?: number;
  upcoming_waves?: GauntletWave[];
  // Expedition-only.
  expedition?: ExpeditionState;
}

export interface ActiveQuest {
  id: number;
  channel_id: string;
  thread_ts: string;
  elite: boolean;
  scene: SceneJson;
}

interface QuestRow {
  id: number;
  channel_id: string;
  thread_ts: string;
  elite: number;
  scene_json: string;
}

// Returns the active quest for a character, with scene data loaded.
export async function getActiveQuestForCharacter(
  db: D1Database,
  userId: string,
): Promise<ActiveQuest | null> {
  const row = await db
    .prepare(
      `SELECT q.id, q.thread_ts, q.channel_id, q.elite, q.scene_json
       FROM quests q
       JOIN quest_party qp ON qp.quest_id = q.id
       WHERE qp.character_id = ? AND q.status = 'active'
       LIMIT 1`,
    )
    .bind(userId)
    .first<QuestRow>();
  if (!row) return null;
  return {
    id: row.id,
    channel_id: row.channel_id,
    thread_ts: row.thread_ts,
    elite: row.elite === 1,
    scene: JSON.parse(row.scene_json) as SceneJson,
  };
}

export async function createQuest(
  db: D1Database,
  args: {
    channel_id: string;
    thread_ts: string;
    elite: boolean;
    scene: SceneJson;
    created_by: string;
  },
): Promise<number> {
  const now = Date.now();
  const result = await db
    .prepare(
      `INSERT INTO quests (channel_id, thread_ts, status, elite, scene_json, created_by, created_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?)`,
    )
    .bind(
      args.channel_id,
      args.thread_ts,
      args.elite ? 1 : 0,
      JSON.stringify(args.scene),
      args.created_by,
      now,
    )
    .run();
  const questId = result.meta.last_row_id;
  await db
    .prepare("INSERT INTO quest_party (quest_id, character_id, joined_at) VALUES (?, ?, ?)")
    .bind(questId, args.created_by, now)
    .run();
  return questId;
}

// Generic scene save — used after a guarded action when no concurrent writer is possible
// (e.g. wave/treasure advancement that's already gated by a kill-blow conditional update).
export async function saveScene(
  db: D1Database,
  questId: number,
  scene: SceneJson,
): Promise<void> {
  await db
    .prepare("UPDATE quests SET scene_json = ? WHERE id = ?")
    .bind(JSON.stringify(scene), questId)
    .run();
}

// Atomic scene write conditional on the prior monster_hp matching `expectedMonsterHp`.
// Returns true if the write landed, false if another player got there first (lost-update).
// Combat actions go through this so two simultaneous attacks can't both apply damage to
// the same starting HP value.
export async function tryUpdateScene(
  db: D1Database,
  questId: number,
  scene: SceneJson,
  expectedMonsterHp: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE quests SET scene_json = ?
       WHERE id = ?
         AND CAST(json_extract(scene_json, '$.monster_hp') AS INTEGER) = ?`,
    )
    .bind(JSON.stringify(scene), questId, expectedMonsterHp)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// Atomic scene write conditional on the expedition's `current` node index matching.
// Used by /dnd choose and /dnd take so a fast second invoker doesn't overwrite the
// first vote's advancement.
export async function trySaveExpeditionAdvance(
  db: D1Database,
  questId: number,
  scene: SceneJson,
  expectedCurrent: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE quests SET scene_json = ?
       WHERE id = ?
         AND CAST(json_extract(scene_json, '$.expedition.current') AS INTEGER) = ?`,
    )
    .bind(JSON.stringify(scene), questId, expectedCurrent)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function setCharacterHp(
  db: D1Database,
  userId: string,
  hp: number,
): Promise<void> {
  await db
    .prepare("UPDATE characters SET hp = ?, last_active = ? WHERE slack_user_id = ?")
    .bind(Math.max(0, hp), Date.now(), userId)
    .run();
}

// Writes both HP and shield in one statement — used after the monster turn since
// shield consumption and HP loss are entangled.
export async function setCharacterHpAndShield(
  db: D1Database,
  userId: string,
  hp: number,
  shield: number,
): Promise<void> {
  await db
    .prepare("UPDATE characters SET hp = ?, shield = ?, last_active = ? WHERE slack_user_id = ?")
    .bind(Math.max(0, hp), Math.max(0, shield), Date.now(), userId)
    .run();
}

// Heal a target up to max_hp. Returns the actual HP healed (may be less if near max).
export async function healCharacter(
  db: D1Database,
  target: Character,
  amount: number,
): Promise<number> {
  const newHp = Math.min(target.max_hp, target.hp + amount);
  const healed = newHp - target.hp;
  await db
    .prepare("UPDATE characters SET hp = ?, last_active = ? WHERE slack_user_id = ?")
    .bind(newHp, Date.now(), target.slack_user_id)
    .run();
  return healed;
}

// Add to target's shield buffer, capped at cap. Returns actual shield added.
export async function addShield(
  db: D1Database,
  target: Character,
  amount: number,
  cap: number,
): Promise<number> {
  const newShield = Math.min(cap, target.shield + amount);
  const added = newShield - target.shield;
  await db
    .prepare("UPDATE characters SET shield = ?, last_active = ? WHERE slack_user_id = ?")
    .bind(newShield, Date.now(), target.slack_user_id)
    .run();
  return added;
}

// Revives a downed character: clears downed_until, restores HP to a percentage of max.
export async function reviveCharacter(
  db: D1Database,
  target: Character,
  hpPercent: number,
): Promise<number> {
  const restored = Math.max(1, Math.floor(target.max_hp * (hpPercent / 100)));
  await db
    .prepare(
      `UPDATE characters SET hp = ?, downed_until = NULL, last_active = ?
       WHERE slack_user_id = ?`,
    )
    .bind(restored, Date.now(), target.slack_user_id)
    .run();
  return restored;
}

export async function markQuestStatus(
  db: D1Database,
  questId: number,
  status: "completed" | "failed",
): Promise<void> {
  await db
    .prepare("UPDATE quests SET status = ?, completed_at = ? WHERE id = ?")
    .bind(status, Date.now(), questId)
    .run();
}

export async function appendLog(
  db: D1Database,
  questId: number,
  actor: string,
  action: string,
  outcome: string,
): Promise<void> {
  await db
    .prepare("INSERT INTO quest_log (quest_id, actor, action, outcome, ts) VALUES (?, ?, ?, ?, ?)")
    .bind(questId, actor, action, outcome, Date.now())
    .run();
}

// Awards XP and gold; applies any level-ups and returns the deltas.
// Level-up effects: max_hp += 1d6, hp restored to new max, mana refilled to max,
// and every 5 levels max_mana grows by 1 (capped at maxManaCap).
export async function awardSpoils(
  db: D1Database,
  character: Character,
  xp: number,
  gold: number,
  hpRollPerLevel: () => number,
  xpForLevel: (level: number) => number,
  maxManaCap: number,
): Promise<{
  levelsGained: number;
  newLevel: number;
  newMaxHp: number;
  newHp: number;
  newMaxMana: number;
  newMana: number;
}> {
  let level = character.level;
  let maxHp = character.max_hp;
  let maxMana = character.max_mana;
  const totalXp = character.xp + xp;
  let levelsGained = 0;
  while (totalXp >= xpForLevel(level + 1)) {
    level += 1;
    levelsGained += 1;
    maxHp += hpRollPerLevel();
    if (level % 5 === 0 && maxMana < maxManaCap) {
      maxMana += 1;
    }
  }
  const newHp = levelsGained > 0 ? maxHp : character.hp;
  // Mana refills to max on any level-up (parallel to HP refill).
  const newMana = levelsGained > 0 ? maxMana : character.mana;
  await db
    .prepare(
      `UPDATE characters
       SET xp = ?, gold = gold + ?, level = ?,
           max_hp = ?, hp = ?,
           max_mana = ?, mana = ?,
           last_active = ?
       WHERE slack_user_id = ?`,
    )
    .bind(totalXp, gold, level, maxHp, newHp, maxMana, newMana, Date.now(), character.slack_user_id)
    .run();
  return { levelsGained, newLevel: level, newMaxHp: maxHp, newHp, newMaxMana: maxMana, newMana };
}

// Refills mana to max — called between quests so each quest start has a fresh signature.
export async function refillMana(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare("UPDATE characters SET mana = max_mana, last_active = ? WHERE slack_user_id = ?")
    .bind(Date.now(), userId)
    .run();
}

// Atomic mana deduction. Returns true if the player had >= amount and it was spent.
// Used by /sq signature so two simultaneous casts can't both spend the same point.
export async function tryDeductMana(
  db: D1Database,
  userId: string,
  amount: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE characters SET mana = mana - ?, last_active = ?
       WHERE slack_user_id = ? AND mana >= ?`,
    )
    .bind(amount, Date.now(), userId, amount)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// Increases max_mana by `amount`, clamped to cap. Also bumps current mana by the
// same delta. Used when a magic-type item is consumed.
export async function bumpMaxMana(
  db: D1Database,
  character: Character,
  amount: number,
  cap: number,
): Promise<{ added: number; newMaxMana: number; newMana: number }> {
  const newMaxMana = Math.min(cap, character.max_mana + amount);
  const added = newMaxMana - character.max_mana;
  const newMana = Math.min(newMaxMana, character.mana + added);
  await db
    .prepare(
      `UPDATE characters SET max_mana = ?, mana = ?, last_active = ?
       WHERE slack_user_id = ?`,
    )
    .bind(newMaxMana, newMana, Date.now(), character.slack_user_id)
    .run();
  return { added, newMaxMana, newMana };
}

// Soft death: 25% gold loss, 1 random item drop, downed timer, +1 scar.
// Drop preference order: unequipped consumables → unequipped gear → equipped gear.
// Returns what was lost so callers can narrate it.
export async function applySoftDeath(
  db: D1Database,
  character: Character,
  scar: string,
  cooldownMs: number,
): Promise<{ goldLost: number; itemLost: string | null }> {
  const goldLost = Math.floor(character.gold * 0.25);
  const remainingGold = character.gold - goldLost;
  const downedUntil = Date.now() + cooldownMs;
  const newScars = [...character.scars, scar];

  const itemRow = await db
    .prepare(
      `SELECT id, item_name FROM inventory
       WHERE character_id = ?
       ORDER BY equipped ASC,
                CASE item_type WHEN 'consumable' THEN 0 ELSE 1 END ASC,
                RANDOM()
       LIMIT 1`,
    )
    .bind(character.slack_user_id)
    .first<{ id: number; item_name: string }>();

  if (itemRow) {
    await db.prepare("DELETE FROM inventory WHERE id = ?").bind(itemRow.id).run();
  }

  await db
    .prepare(
      `UPDATE characters
       SET hp = max_hp, gold = ?, scars = ?, downed_until = ?, last_active = ?
       WHERE slack_user_id = ?`,
    )
    .bind(remainingGold, JSON.stringify(newScars), downedUntil, Date.now(), character.slack_user_id)
    .run();

  return { goldLost, itemLost: itemRow?.item_name ?? null };
}

export interface CreateItemInput {
  character_id: string;
  item_name: string;
  item_type: ItemType;
  power: number;
  rarity: Rarity;
  flavor: string;
}

export async function addItem(db: D1Database, input: CreateItemInput): Promise<Item> {
  const result = await db
    .prepare(
      `INSERT INTO inventory (character_id, item_name, item_type, power, rarity, flavor, qty, equipped)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0)`,
    )
    .bind(input.character_id, input.item_name, input.item_type, input.power, input.rarity, input.flavor)
    .run();
  const id = result.meta.last_row_id;
  const row = await db
    .prepare("SELECT id, character_id, item_name, item_type, power, rarity, flavor, equipped FROM inventory WHERE id = ?")
    .bind(id)
    .first<ItemRow>();
  if (!row) throw new Error("Failed to read back inserted item");
  return rowToItem(row);
}

export async function getInventory(db: D1Database, characterId: string): Promise<Item[]> {
  const result = await db
    .prepare(
      `SELECT id, character_id, item_name, item_type, power, rarity, flavor, equipped
       FROM inventory WHERE character_id = ?
       ORDER BY equipped DESC, item_type ASC,
                CASE rarity WHEN 'rare' THEN 0 WHEN 'uncommon' THEN 1 ELSE 2 END,
                id DESC`,
    )
    .bind(characterId)
    .all<ItemRow>();
  return (result.results ?? []).map(rowToItem);
}

export async function getItem(
  db: D1Database,
  itemId: number,
  characterId: string,
): Promise<Item | null> {
  const row = await db
    .prepare(
      `SELECT id, character_id, item_name, item_type, power, rarity, flavor, equipped
       FROM inventory WHERE id = ? AND character_id = ?`,
    )
    .bind(itemId, characterId)
    .first<ItemRow>();
  return row ? rowToItem(row) : null;
}

// Equips an item, unequipping any other item of the same type for that character.
export async function equipItem(db: D1Database, item: Item): Promise<void> {
  await db.batch([
    db.prepare(
      `UPDATE inventory SET equipped = 0 WHERE character_id = ? AND item_type = ?`,
    ).bind(item.character_id, item.item_type),
    db.prepare("UPDATE inventory SET equipped = 1 WHERE id = ?").bind(item.id),
  ]);
}

export async function getEquipped(
  db: D1Database,
  characterId: string,
  type: ItemType,
): Promise<Item | null> {
  const row = await db
    .prepare(
      `SELECT id, character_id, item_name, item_type, power, rarity, flavor, equipped
       FROM inventory WHERE character_id = ? AND item_type = ? AND equipped = 1
       LIMIT 1`,
    )
    .bind(characterId, type)
    .first<ItemRow>();
  return row ? rowToItem(row) : null;
}

export interface ShopItem {
  id: number;
  channel_id: string;
  generated_at: number;
  item_name: string;
  item_type: ItemType;
  power: number;
  rarity: Rarity;
  flavor: string | null;
  price: number;
  bought_by: string | null;
}

// Returns active shop stock (generated within the cutoff window, available items only),
// or null if a fresh restock is needed.
export async function getActiveShopStock(
  db: D1Database,
  channelId: string,
  windowMs: number,
): Promise<ShopItem[] | null> {
  const cutoff = Date.now() - windowMs;
  const result = await db
    .prepare(
      `SELECT id, channel_id, generated_at, item_name, item_type, power, rarity, flavor, price, bought_by
       FROM shop_stock
       WHERE channel_id = ? AND generated_at > ?
       ORDER BY id ASC`,
    )
    .bind(channelId, cutoff)
    .all<ShopItem>();
  const rows = result.results ?? [];
  if (rows.length === 0) return null;
  return rows;
}

export interface ShopStockInput {
  channel_id: string;
  generated_at: number;
  item_name: string;
  item_type: ItemType;
  power: number;
  rarity: Rarity;
  flavor: string;
  price: number;
}

export async function insertShopStock(
  db: D1Database,
  items: ShopStockInput[],
): Promise<void> {
  if (items.length === 0) return;
  const stmts = items.map((it) =>
    db.prepare(
      `INSERT INTO shop_stock (channel_id, generated_at, item_name, item_type, power, rarity, flavor, price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(it.channel_id, it.generated_at, it.item_name, it.item_type, it.power, it.rarity, it.flavor, it.price),
  );
  await db.batch(stmts);
}

export async function getShopItem(
  db: D1Database,
  itemId: number,
  channelId: string,
): Promise<ShopItem | null> {
  return db
    .prepare(
      `SELECT id, channel_id, generated_at, item_name, item_type, power, rarity, flavor, price, bought_by
       FROM shop_stock WHERE id = ? AND channel_id = ?`,
    )
    .bind(itemId, channelId)
    .first<ShopItem>();
}

// Marks the stock row as bought atomically (returns true if we got it, false if someone
// else beat us to it). Use this before deducting gold so we never charge twice.
export async function claimShopItem(
  db: D1Database,
  itemId: number,
  buyerId: string,
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE shop_stock SET bought_by = ? WHERE id = ? AND bought_by IS NULL")
    .bind(buyerId, itemId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deductGold(
  db: D1Database,
  userId: string,
  amount: number,
): Promise<void> {
  await db
    .prepare("UPDATE characters SET gold = gold - ?, last_active = ? WHERE slack_user_id = ?")
    .bind(amount, Date.now(), userId)
    .run();
}

// Atomic gold deduction. Returns true if the player had enough gold and it was deducted,
// false if the player's balance fell short (likely from a concurrent purchase). Use this
// for shop buys so we never go negative on a parallel /dnd buy.
export async function tryDeductGold(
  db: D1Database,
  userId: string,
  amount: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE characters SET gold = gold - ?, last_active = ?
       WHERE slack_user_id = ? AND gold >= ?`,
    )
    .bind(amount, Date.now(), userId, amount)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// Reverses a successful claimShopItem. Used to refund a stock claim when the gold
// deduction fails after the claim succeeded.
export async function releaseShopClaim(db: D1Database, itemId: number): Promise<void> {
  await db
    .prepare("UPDATE shop_stock SET bought_by = NULL WHERE id = ?")
    .bind(itemId)
    .run();
}

export async function addGold(
  db: D1Database,
  userId: string,
  amount: number,
): Promise<void> {
  await db
    .prepare("UPDATE characters SET gold = gold + ?, last_active = ? WHERE slack_user_id = ?")
    .bind(amount, Date.now(), userId)
    .run();
}

// Removes an item from inventory (used by /dnd sell).
export async function removeItem(db: D1Database, itemId: number): Promise<void> {
  await db.prepare("DELETE FROM inventory WHERE id = ?").bind(itemId).run();
}

// Average level across all characters — used to scale shop stock to the active community.
export async function averageCharacterLevel(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT AVG(level) AS avg_level FROM characters")
    .first<{ avg_level: number | null }>();
  return Math.max(1, Math.round(row?.avg_level ?? 1));
}

// Consumes the item and updates character HP. Returns the actual HP healed (capped at max).
export async function consumeItem(
  db: D1Database,
  character: Character,
  item: Item,
): Promise<number> {
  const newHp = Math.min(character.max_hp, character.hp + item.power);
  const healed = newHp - character.hp;
  await db.batch([
    db.prepare("UPDATE characters SET hp = ?, last_active = ? WHERE slack_user_id = ?")
      .bind(newHp, Date.now(), character.slack_user_id),
    db.prepare("DELETE FROM inventory WHERE id = ?").bind(item.id),
  ]);
  return healed;
}

// Perma-death. quests.created_by uses ON DELETE SET NULL (see 0002 migration), so
// historical quests survive their creator. Inventory + quest_party cascade as expected.
export async function deleteCharacter(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM characters WHERE slack_user_id = ?").bind(userId).run();
}

// Find the most recent active quest in a channel (used by /dnd join).
export async function getActiveQuestInChannel(
  db: D1Database,
  channelId: string,
): Promise<ActiveQuest | null> {
  const row = await db
    .prepare(
      `SELECT id, channel_id, thread_ts, elite, scene_json
       FROM quests
       WHERE channel_id = ? AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(channelId)
    .first<QuestRow>();
  if (!row) return null;
  return {
    id: row.id,
    channel_id: row.channel_id,
    thread_ts: row.thread_ts,
    elite: row.elite === 1,
    scene: JSON.parse(row.scene_json) as SceneJson,
  };
}

// Returns true if the character was newly inserted; false if they were already a member.
export async function joinQuest(
  db: D1Database,
  questId: number,
  userId: string,
): Promise<boolean> {
  const existing = await db
    .prepare("SELECT 1 FROM quest_party WHERE quest_id = ? AND character_id = ?")
    .bind(questId, userId)
    .first();
  if (existing) return false;
  await db
    .prepare("INSERT INTO quest_party (quest_id, character_id, joined_at) VALUES (?, ?, ?)")
    .bind(questId, userId, Date.now())
    .run();
  return true;
}

export async function getQuestParty(
  db: D1Database,
  questId: number,
): Promise<Character[]> {
  const result = await db
    .prepare(
      `SELECT c.* FROM characters c
       JOIN quest_party qp ON qp.character_id = c.slack_user_id
       WHERE qp.quest_id = ?
       ORDER BY qp.joined_at ASC`,
    )
    .bind(questId)
    .all<CharacterRow>();
  return (result.results ?? []).map(rowToCharacter);
}

// A "fighter" is a party member who can still act: alive HP and not on a cooldown'd downed timer.
export function isFighter(c: Character): boolean {
  return c.hp > 0 && (!c.downed_until || c.downed_until <= Date.now());
}

// Returns ms remaining on the per-character action cooldown for this quest, or 0 if ready.
export async function cooldownRemaining(
  db: D1Database,
  questId: number,
  userId: string,
  cooldownMs: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT MAX(ts) AS last_ts FROM quest_log
       WHERE quest_id = ? AND actor = ? AND action IN ('attack', 'cast', 'flee')`,
    )
    .bind(questId, userId)
    .first<{ last_ts: number | null }>();
  const last = row?.last_ts ?? 0;
  const elapsed = Date.now() - last;
  return Math.max(0, cooldownMs - elapsed);
}

// Bumps monster HP by a multiplier of current max — used when a new player joins
// mid-quest to keep the encounter from being instantly trivialized.
export async function scaleMonsterForJoin(
  db: D1Database,
  questId: number,
  scene: SceneJson,
  ratio: number,
): Promise<SceneJson> {
  const bumpMax = Math.max(1, Math.floor(scene.monster_max_hp * ratio));
  const next: SceneJson = {
    ...scene,
    monster_hp: scene.monster_hp + bumpMax,
    monster_max_hp: scene.monster_max_hp + bumpMax,
  };
  await db
    .prepare("UPDATE quests SET scene_json = ? WHERE id = ?")
    .bind(JSON.stringify(next), questId)
    .run();
  return next;
}

export interface LeaderboardEntry {
  slack_user_id: string;
  name: string;
  class: string;
  level: number;
  xp: number;
  gold: number;
  scars_count: number;
}

export async function getLeaderboard(
  db: D1Database,
  limit: number,
): Promise<LeaderboardEntry[]> {
  const result = await db
    .prepare(
      `SELECT slack_user_id, name, class, level, xp, gold, scars
       FROM characters
       ORDER BY level DESC, xp DESC, gold DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<{ slack_user_id: string; name: string; class: string; level: number; xp: number; gold: number; scars: string }>();
  return (result.results ?? []).map((r) => ({
    slack_user_id: r.slack_user_id,
    name: r.name,
    class: r.class,
    level: r.level,
    xp: r.xp,
    gold: r.gold,
    scars_count: (JSON.parse(r.scars) as string[]).length,
  }));
}
