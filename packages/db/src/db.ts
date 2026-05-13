// D1 query helpers. Raw prepared statements — no ORM.

import type { EffectType, ItemType, Rarity, WeaponRange } from "@gantt-quest/core";

// Active status effect on a character or monster. Ticks on the affected actor's
// own combat action / monster turn. Cleared at quest end.
export interface StatusEffect {
  type: EffectType;
  magnitude: number;       // per-tick HP delta (positive for HoT, positive number stored, sign derived from kind)
  remaining: number;       // ticks left before the effect expires
  source?: string;         // free-form attribution shown in flavor (e.g. "Espresso Shot")
}

export interface Item {
  id: number;
  character_id: string;
  item_name: string;
  item_type: ItemType;
  power: number;
  rarity: Rarity;
  flavor: string | null;
  equipped: boolean;
  weapon_range: WeaponRange | null; // null for non-weapons; legacy weapon rows
                                    // also null and read as "melee".
}

interface ItemRow extends Omit<Item, "equipped"> {
  equipped: number;
}

function rowToItem(row: ItemRow): Item {
  return { ...row, equipped: row.equipped === 1 };
}

export type BattlePosition = "front" | "back";

export type KeyTier = "bronze" | "silver" | "gold";

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
  last_rest_at: number | null;
  last_long_rest_at: number | null;
  position: BattlePosition;
  keys_bronze: number;
  keys_silver: number;
  keys_gold: number;
  // Active status effects (regen, bleeding, etc.). JSON-serialized in DB; cleared
  // at quest end. Empty array when none.
  effects: StatusEffect[];
  created_at: number;
  last_active: number;
}

interface CharacterRow extends Omit<Character, "scars" | "effects"> {
  scars: string;
  effects: string;
}

function rowToCharacter(row: CharacterRow): Character {
  return {
    ...row,
    scars: JSON.parse(row.scars) as string[],
    effects: JSON.parse(row.effects) as StatusEffect[],
  };
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
  // Mana, shield, position, last_rest_at, last_long_rest_at, downed_until,
  // tiered keys (keys_bronze/silver/gold), and effects (defaulting to '[]')
  // all rely on the ALTER TABLE DEFAULTs from their respective migrations.
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

export type QuestVariant = "standard" | "boss" | "gauntlet" | "dungeon";

// Read-time scene migration. The "expedition" variant was renamed to "dungeon" once
// the room/keys/traps overhaul made the original name misleading. Any pre-rename
// rows in the DB get normalized here so callers don't have to think about it.
function normalizeScene(scene: SceneJson): SceneJson {
  if ((scene.variant as string) === "expedition") {
    return { ...scene, variant: "dungeon" };
  }
  return scene;
}

export interface GauntletWave {
  name: string;
  max_hp: number;
  scene: string;
}

// An expedition (dungeon) node is one room players step into. Each type maps to a
// different player verb:
//   "combat"   → /sq attack/cast/signature (resolves via existing combat)
//   "trap"     → /sq choose 1|2|3 — class-gated skill check, fail = HP damage
//   "lockbox"  → /sq choose 1|2 — use a key for bonus loot, or skip
//   "npc"      → /sq choose 1|2 — trust (get item) or refuse (free pass)
//   "treasure" → /sq take 1|2 — final reward, always the dungeon's last room
export type ExpeditionNodeType = "combat" | "trap" | "lockbox" | "npc" | "treasure" | "merchant";

export type SkillType = "str" | "dex" | "int";

export interface LootOption {
  name: string;
  item_type: ItemType;
  power: number;
  rarity: Rarity;
  flavor: string;
  weapon_range?: WeaponRange | null;
}

export interface TrapChoice {
  text: string;       // shown to the player, e.g. "Smash through the wall"
  emoji: string;      // 💪/🔧/📜 — visual hint of the skill type
  skill: SkillType;
  fail_damage: number;
}

export interface NpcOffer {
  greeting: string;   // AI-generated NPC line
  item: LootOption;   // what they offer if trusted
}

export interface ExpeditionNode {
  type: ExpeditionNodeType;
  scene: string;

  // combat-only — pre-rolled monster. Sub-boss combats drop silver; standard combats
  // drop bronze. Treasure room is the final reward and isn't preceded by a key drop.
  monster_name?: string;
  monster_max_hp?: number;
  tier?: number;
  drops_key?: boolean;
  drops_key_tier?: KeyTier;

  // trap-only
  trap_choices?: TrapChoice[];

  // npc-only
  npc?: NpcOffer;

  // lockbox + treasure share this — pre-rolled and AI-named at expedition start.
  // Lockboxes also carry a lock_tier (bronze/silver/gold). Higher-tier locks gate
  // better loot and require a key of matching tier or higher to use the key path.
  loot_options?: LootOption[];
  lock_tier?: KeyTier;
}

export interface ExpeditionState {
  theme: string;
  current: number;            // index into nodes (current room)
  nodes: ExpeditionNode[];    // all rooms — middle pool + sub-boss + treasure (last 2)
  path_taken: string[];       // labels of choices made (for AI continuity)
  keys: number;               // 🗝️ — held by party, dropped by combat, spent on lockboxes

  // Door-choice navigation: middle rooms come from a pool ~2× the visited count.
  // After each room resolves, two unvisited middles are presented as doors; player
  // picks one with /sq choose, the other is discarded. Last 2 indices in `nodes`
  // (sub-boss + treasure) aren't in the pool — they're fixed-end.
  pool?: number[];            // unvisited middle-room indices remaining
  pending_doors?: number[];   // [idx1, idx2] — set while a door pick is awaited
  middle_count?: number;      // how many middle rooms the player will visit total
  visited_count?: number;     // how many middle rooms visited so far
  sealed_doors?: number[];    // node indices of doors not picked (for completion map)
  visited_indices?: number[]; // ordered list of node indices walked through
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
  // Active monster status effects (poisoned, etc.). Tick on monster turns.
  // Cleared when the monster dies / scene transitions to a new monster.
  monster_effects?: StatusEffect[];
}

export type QuestMode = "slack" | "web";

export interface ActiveQuest {
  id: number;
  channel_id: string;
  thread_ts: string;
  elite: boolean;
  scene: SceneJson;
  mode: QuestMode;
}

interface QuestRow {
  id: number;
  channel_id: string;
  thread_ts: string;
  elite: number;
  scene_json: string;
  mode: string;
}

// Returns the active quest for a character, with scene data loaded.
export async function getActiveQuestForCharacter(
  db: D1Database,
  userId: string,
): Promise<ActiveQuest | null> {
  const row = await db
    .prepare(
      `SELECT q.id, q.thread_ts, q.channel_id, q.elite, q.scene_json, q.mode
       FROM quests q
       JOIN quest_party qp ON qp.quest_id = q.id
       WHERE qp.character_id = ? AND q.status = 'active'
       LIMIT 1`,
    )
    .bind(userId)
    .first<QuestRow>();
  if (!row) return null;
  return rowToActiveQuest(row);
}

function rowToActiveQuest(row: QuestRow): ActiveQuest {
  return {
    id: row.id,
    channel_id: row.channel_id,
    thread_ts: row.thread_ts,
    elite: row.elite === 1,
    scene: normalizeScene(JSON.parse(row.scene_json) as SceneJson),
    mode: row.mode === "web" ? "web" : "slack",
  };
}

// Updates which surface is driving this quest. Set to 'web' when the player
// opens the QuestRoom DO; Slack combat handlers refuse on 'web' so the two
// surfaces don't race each other against the same scene_json.
export async function setQuestMode(
  db: D1Database,
  questId: number,
  mode: QuestMode,
): Promise<void> {
  await db
    .prepare("UPDATE quests SET mode = ? WHERE id = ?")
    .bind(mode, questId)
    .run();
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

// Updates a character's battle position. No cost; positioning is strategic prep.
export async function setPosition(
  db: D1Database,
  userId: string,
  position: BattlePosition,
): Promise<void> {
  await db
    .prepare("UPDATE characters SET position = ?, last_active = ? WHERE slack_user_id = ?")
    .bind(position, Date.now(), userId)
    .run();
}

// Short rest: partial HP restore + bumps last_rest_at. Caller computes the new HP
// (e.g. current + 50% of missing) and passes it in so the math stays in commands.ts.
export async function applyShortRest(
  db: D1Database,
  userId: string,
  newHp: number,
): Promise<void> {
  const now = Date.now();
  // Short rest also drips +1 mana (capped at max_mana). The 10-min cooldown
  // gates spamming, so this just makes the rest decision more meaningful when
  // you're low on both HP and mana mid-dungeon.
  await db
    .prepare(
      "UPDATE characters SET hp = ?, mana = MIN(max_mana, mana + 1), last_rest_at = ?, last_active = ? WHERE slack_user_id = ?",
    )
    .bind(newHp, now, now, userId)
    .run();
}

// Long rest: full HP restore + bumps last_long_rest_at. Once per 24 hours.
// Doesn't touch last_rest_at — the two cooldowns are independent.
export async function applyLongRest(db: D1Database, userId: string): Promise<void> {
  const now = Date.now();
  await db
    .prepare("UPDATE characters SET hp = max_hp, last_long_rest_at = ?, last_active = ? WHERE slack_user_id = ?")
    .bind(now, now, userId)
    .run();
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
  weapon_range?: WeaponRange | null; // only meaningful for weapons; null otherwise
}

export async function addItem(db: D1Database, input: CreateItemInput): Promise<Item> {
  const result = await db
    .prepare(
      `INSERT INTO inventory (character_id, item_name, item_type, power, rarity, flavor, qty, equipped, weapon_range)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)`,
    )
    .bind(input.character_id, input.item_name, input.item_type, input.power, input.rarity, input.flavor, input.weapon_range ?? null)
    .run();
  const id = result.meta.last_row_id;
  const row = await db
    .prepare("SELECT id, character_id, item_name, item_type, power, rarity, flavor, equipped, weapon_range FROM inventory WHERE id = ?")
    .bind(id)
    .first<ItemRow>();
  if (!row) throw new Error("Failed to read back inserted item");
  return rowToItem(row);
}

export async function getInventory(db: D1Database, characterId: string): Promise<Item[]> {
  const result = await db
    .prepare(
      `SELECT id, character_id, item_name, item_type, power, rarity, flavor, equipped, weapon_range
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
      `SELECT id, character_id, item_name, item_type, power, rarity, flavor, equipped, weapon_range
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

// Adjusts a character's max_mana by `delta` (and current mana proportionally).
// Used when equipping/unequipping focus weapons to grant/refund FOCUS_MAX_MANA_BONUS.
// Negative delta clamps current mana so we don't end up with mana > max_mana.
export async function applyFocusManaShift(
  db: D1Database,
  userId: string,
  delta: number,
): Promise<void> {
  if (delta === 0) return;
  if (delta > 0) {
    await db
      .prepare(`UPDATE characters SET max_mana = max_mana + ?, mana = mana + ?, last_active = ? WHERE slack_user_id = ?`)
      .bind(delta, delta, Date.now(), userId)
      .run();
  } else {
    await db
      .prepare(`UPDATE characters SET max_mana = max_mana + ?, mana = MIN(mana, max_mana + ?), last_active = ? WHERE slack_user_id = ?`)
      .bind(delta, delta, Date.now(), userId)
      .run();
  }
}

export async function getEquipped(
  db: D1Database,
  characterId: string,
  type: ItemType,
): Promise<Item | null> {
  const row = await db
    .prepare(
      `SELECT id, character_id, item_name, item_type, power, rarity, flavor, equipped, weapon_range
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
  weapon_range: WeaponRange | null;
  // Haggle state. NULL = not attempted. "failed" = rolled and failed (no further
  // attempts). "15"/"25"/"30" = succeeded at that % off (price already discounted).
  haggled: string | null;
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
      `SELECT id, channel_id, generated_at, item_name, item_type, power, rarity, flavor, price, bought_by, weapon_range, haggled
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
  weapon_range?: WeaponRange | null;
}

export async function insertShopStock(
  db: D1Database,
  items: ShopStockInput[],
): Promise<void> {
  if (items.length === 0) return;
  const stmts = items.map((it) =>
    db.prepare(
      `INSERT INTO shop_stock (channel_id, generated_at, item_name, item_type, power, rarity, flavor, price, weapon_range)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(it.channel_id, it.generated_at, it.item_name, it.item_type, it.power, it.rarity, it.flavor, it.price, it.weapon_range ?? null),
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
      `SELECT id, channel_id, generated_at, item_name, item_type, power, rarity, flavor, price, bought_by, weapon_range, haggled
       FROM shop_stock WHERE id = ? AND channel_id = ?`,
    )
    .bind(itemId, channelId)
    .first<ShopItem>();
}

// Atomically attempts a haggle on a shop item. Returns true if the row was
// updated (no concurrent haggle won the race). Caller has already rolled the
// outcome — passes the resulting tag ("failed" | "15" | "25" | "30") and the
// new price (unchanged on failure, discounted on success).
export async function trySetHaggleOutcome(
  db: D1Database,
  stockId: number,
  outcome: "failed" | "15" | "25" | "30",
  newPrice: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE shop_stock SET haggled = ?, price = ? WHERE id = ? AND haggled IS NULL AND bought_by IS NULL",
    )
    .bind(outcome, newPrice, stockId)
    .run();
  return (result.meta.changes ?? 0) > 0;
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

// Replaces the character's status-effect array. Used to apply, advance, or clear
// effects. Callers compute the new array (e.g. via tickPlayerEffects in commands.ts)
// and write it back atomically.
export async function setCharacterEffects(
  db: D1Database,
  userId: string,
  effects: StatusEffect[],
): Promise<void> {
  await db
    .prepare("UPDATE characters SET effects = ?, last_active = ? WHERE slack_user_id = ?")
    .bind(JSON.stringify(effects), Date.now(), userId)
    .run();
}

// Clears all effects from every party member of a quest. Called at quest end
// (resolveVictory / resolveDeath / resolveExpeditionVictory / resolveFlee-fail).
export async function clearPartyEffects(db: D1Database, questId: number): Promise<void> {
  await db
    .prepare(
      `UPDATE characters SET effects = '[]', last_active = ?
       WHERE slack_user_id IN (SELECT character_id FROM quest_party WHERE quest_id = ?)`,
    )
    .bind(Date.now(), questId)
    .run();
}

// Adds (or removes, with negative `amount`) tiered dungeon keys on a character.
// Caller is responsible for checking the character has enough before spending.
export async function addCharacterKey(
  db: D1Database,
  userId: string,
  tier: KeyTier,
  amount: number,
): Promise<void> {
  const col = tier === "bronze" ? "keys_bronze" : tier === "silver" ? "keys_silver" : "keys_gold";
  await db
    .prepare(`UPDATE characters SET ${col} = MAX(0, ${col} + ?), last_active = ? WHERE slack_user_id = ?`)
    .bind(amount, Date.now(), userId)
    .run();
}

// Removes an item from inventory (used by /dnd sell).
export async function removeItem(db: D1Database, itemId: number): Promise<void> {
  await db.prepare("DELETE FROM inventory WHERE id = ?").bind(itemId).run();
}

// Transfers ownership of an inventory item to another character. Used by /sq give.
// Force-unequips on transfer so the new owner doesn't end up with two equipped items
// of the same slot. Caller pre-validates that the item belongs to the current owner.
export async function transferItem(
  db: D1Database,
  itemId: number,
  newOwnerId: string,
): Promise<void> {
  await db
    .prepare("UPDATE inventory SET character_id = ?, equipped = 0 WHERE id = ?")
    .bind(newOwnerId, itemId)
    .run();
}

// Average level across all characters — used to scale shop stock to the active community.
export async function averageCharacterLevel(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT AVG(level) AS avg_level FROM characters")
    .first<{ avg_level: number | null }>();
  return Math.max(1, Math.round(row?.avg_level ?? 1));
}

// Total character count — used to scale shop stock size to community size so an
// 8-person channel doesn't get a stock built for 4.
export async function countCharacters(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM characters")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Per-character contribution stats for a quest. Aggregated from quest_log
// outcome strings — we don't store damage in a dedicated column, but every
// combat action's appendLog encodes the numbers in a parseable format.
export interface QuestDamageStats {
  user_id: string;
  damage_dealt: number;     // sum of attack/cast/sig/tool/scroll damage to monsters
  healing_done: number;     // sum of HP healed via /sq heal
  shielding_done: number;   // sum of shield added via /sq shield
  kills: number;            // count of finishing blows
}

// Reads quest_log for a quest, parses outcome strings, returns per-actor stats
// sorted by damage_dealt desc. Used at quest end for the damage-breakdown post.
export async function getQuestDamageStats(
  db: D1Database,
  questId: number,
): Promise<QuestDamageStats[]> {
  const rows = await db
    .prepare(
      `SELECT actor, action, outcome FROM quest_log
       WHERE quest_id = ?
         AND actor != 'monster'
         AND action IN ('attack', 'cast', 'signature', 'tool', 'scroll', 'heal', 'shield')`,
    )
    .bind(questId)
    .all<{ actor: string; action: string; outcome: string | null }>();

  const stats = new Map<string, QuestDamageStats>();
  for (const row of rows.results ?? []) {
    if (!row.outcome) continue;
    let s = stats.get(row.actor);
    if (!s) {
      s = { user_id: row.actor, damage_dealt: 0, healing_done: 0, shielding_done: 0, kills: 0 };
      stats.set(row.actor, s);
    }
    if (row.action === "heal") {
      const m = /\+(\d+)\s*HP/.exec(row.outcome);
      if (m) s.healing_done += parseInt(m[1], 10);
    } else if (row.action === "shield") {
      const m = /\+(\d+)\s*sh/.exec(row.outcome);
      if (m) s.shielding_done += parseInt(m[1], 10);
    } else {
      // attack / cast / signature / tool / scroll → damage to monster
      const dmgMatch = /(\d+)\s*dmg/.exec(row.outcome);
      if (dmgMatch) s.damage_dealt += parseInt(dmgMatch[1], 10);
      if (/\(kill\)/.test(row.outcome)) s.kills += 1;
    }
  }
  return Array.from(stats.values()).sort((a, b) => b.damage_dealt - a.damage_dealt);
}

// Recent monster names from this channel's last N quests (any status). Passed
// to the AI scene generator as an avoid-list so back-to-back quests don't keep
// summoning "the Schemaless Shrieker." Uses JSON path extraction for speed.
//
// For dungeon and gauntlet quests, monster_name is the FINAL one (the last
// monster fought / on scene). It misses earlier waves and dungeon rooms. v1
// acceptable — eliminates the most-visible repetition (entry combat + boss).
export async function getRecentMonsterNames(
  db: D1Database,
  channelId: string,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT json_extract(scene_json, '$.monster_name') AS name
       FROM quests
       WHERE channel_id = ?
       ORDER BY id DESC
       LIMIT ?`,
    )
    .bind(channelId, limit)
    .all<{ name: string | null }>();
  const names: string[] = [];
  for (const r of rows.results ?? []) {
    if (r.name && typeof r.name === "string" && r.name.trim() && r.name !== "—") {
      names.push(r.name);
    }
  }
  return names;
}

// How many items the user has bought from the current shop cycle (matched by
// generated_at). Used to enforce a per-player purchase cap per cycle.
export async function countPurchasesInCycle(
  db: D1Database,
  channelId: string,
  userId: string,
  cycleGeneratedAt: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM shop_stock
       WHERE channel_id = ? AND generated_at = ? AND bought_by = ?`,
    )
    .bind(channelId, cycleGeneratedAt, userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
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
      `SELECT id, channel_id, thread_ts, elite, scene_json, mode
       FROM quests
       WHERE channel_id = ? AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(channelId)
    .first<QuestRow>();
  if (!row) return null;
  return rowToActiveQuest(row);
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
// All "combat-tier" player actions reset the cooldown — attack, cast, flee, signature,
// heal, shield, revive, and position changes (repositioning consumes a turn).
// Bookkeeping rows (monster turns, victory, death, join, expedition advance) don't.
export async function cooldownRemaining(
  db: D1Database,
  questId: number,
  userId: string,
  cooldownMs: number,
): Promise<number> {
  // Honors a 'cooldown_reset' floor: combat actions before the most recent reset
  // are filtered out. Used by Rebase Scroll to wipe party cooldowns mid-fight.
  // 'tool' and 'scroll' are in the action list so tool/scroll uses gate further uses.
  const row = await db
    .prepare(
      `SELECT MAX(ts) AS last_ts FROM quest_log
       WHERE quest_id = ? AND actor = ?
         AND action IN ('attack', 'cast', 'flee', 'signature', 'heal', 'shield', 'revive', 'position', 'tool', 'scroll')
         AND ts > COALESCE(
           (SELECT MAX(ts) FROM quest_log WHERE quest_id = ? AND actor = ? AND action = 'cooldown_reset'),
           0
         )`,
    )
    .bind(questId, userId, questId, userId)
    .first<{ last_ts: number | null }>();
  const last = row?.last_ts ?? 0;
  const elapsed = Date.now() - last;
  return Math.max(0, cooldownMs - elapsed);
}

// Inserts a 'cooldown_reset' floor for each given user on a quest. cooldownRemaining
// treats this as a floor — combat actions logged BEFORE the most recent reset don't
// count, so the user's effective cooldown drops to 0. Used by the Rebase Scroll.
export async function resetCooldownsFor(
  db: D1Database,
  questId: number,
  userIds: string[],
): Promise<void> {
  if (userIds.length === 0) return;
  const ts = Date.now();
  const stmts = userIds.map((uid) =>
    db
      .prepare("INSERT INTO quest_log (quest_id, actor, action, outcome, ts) VALUES (?, ?, 'cooldown_reset', NULL, ?)")
      .bind(questId, uid, ts),
  );
  await db.batch(stmts);
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

export interface RecentQuestSummary {
  id: number;
  status: "completed" | "failed";
  elite: boolean;
  monster_name: string;
  variant: QuestVariant;
  boss_phase?: 1 | 2;
  wave?: number;
  total_waves?: number;
  created_at: number;
  completed_at: number | null;
}

// Player-scoped history: the most recent N completed/failed quests this user
// participated in, newest first. monster_name is the FINAL scene's monster
// (for dungeons/gauntlets this is the last fight, not every encounter — fine
// for a history list).
export async function getRecentQuestsForCharacter(
  db: D1Database,
  userId: string,
  limit: number,
): Promise<RecentQuestSummary[]> {
  const result = await db
    .prepare(
      `SELECT q.id, q.status, q.elite, q.scene_json, q.created_at, q.completed_at
       FROM quests q
       JOIN quest_party qp ON qp.quest_id = q.id
       WHERE qp.character_id = ? AND q.status IN ('completed', 'failed')
       ORDER BY COALESCE(q.completed_at, q.created_at) DESC
       LIMIT ?`,
    )
    .bind(userId, limit)
    .all<{
      id: number;
      status: "completed" | "failed";
      elite: number;
      scene_json: string;
      created_at: number;
      completed_at: number | null;
    }>();
  return (result.results ?? []).map((r) => {
    const scene = normalizeScene(JSON.parse(r.scene_json) as SceneJson);
    return {
      id: r.id,
      status: r.status,
      elite: r.elite === 1,
      monster_name: scene.monster_name ?? "—",
      variant: scene.variant ?? "standard",
      boss_phase: scene.boss_phase,
      wave: scene.wave,
      total_waves: scene.total_waves,
      created_at: r.created_at,
      completed_at: r.completed_at,
    };
  });
}
