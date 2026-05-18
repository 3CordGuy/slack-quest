// D1 query helpers. Raw prepared statements — no ORM.

import type { DrinkBuff, EffectType, ElementType, EarnedAchievement, EquipSlot, ItemType, Rarity, StatKey, Stats, TownState, WeaponRange } from "@gantt-quest/core";
import { deriveMaxMana, startingStatsForClass } from "@gantt-quest/core";

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
  // Number of times this item has been sharpened at the smithy. Capped at
  // SMITHY_SHARPEN_CAP (3) in handlers — beyond that the smith refuses.
  // current_power - sharpens_count = original_power (useful for the cap math).
  sharpens_count: number;
  // Phase 2 additions — null on pre-migration rows; present on new drops.
  slot: EquipSlot | null;
  stat_bonus: Record<string, number> | null; // e.g. { int_stat: 2 }
  item_subtype: string | null;               // "shield" for off_hand shields
  // Phase 3 — minimum character level to equip. Defaults to 1 on legacy rows.
  level_req: number;
  // Elemental affinity rolled at drop time. null for non-weapons, focus weapons,
  // and common/uncommon weapons. Only rare+ melee/ranged weapons can have an element.
  element: ElementType | null;
}

interface ItemRow extends Omit<Item, "equipped" | "stat_bonus"> {
  equipped: number;
  stat_bonus: string | null; // stored as JSON text in D1
}

function rowToItem(row: ItemRow): Item {
  return {
    ...row,
    equipped: row.equipped === 1,
    stat_bonus: row.stat_bonus ? JSON.parse(row.stat_bonus) as Record<string, number> : null,
  };
}

export type BattlePosition = "front" | "back";

export type KeyTier = "bronze" | "silver" | "gold";

// "m" or "f" — null for legacy characters rolled before the field existed.
// Drives pronoun choice in AI flavor text and gender of the per-character
// art so regenerations don't swing between presentations.
export type CharGender = "m" | "f";

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
  // Primary stats (migration 0032). Drive derived combat numbers via
  // statSnapshot() in @gantt-quest/core. Pre-migration rows return DEFAULT_STATS
  // values (5 each) — the migration backfills real allocations by class+level.
  str: number;
  int_stat: number;
  vit: number;
  agi: number;
  dex: number;
  // Free points the player can spend via /gq spend <stat>. Migration 0032
  // seeds (level - 1) for every existing row so retroactive levels grant
  // retroactive allocations.
  unspent_points: number;
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
  // "m" or "f" — null for legacy pre-gender rolls. Pure flavor / art-anchor.
  gender: CharGender | null;
  // Single active drink buff from the pub. Null when no buff is in flight.
  // Stored as JSON on drink_buff_json; one buff at a time (second drink
  // replaces the first). See flavor.ts/DrinkBuff for shape.
  drink_buff: DrinkBuff | null;
  slack_username: string | null;
  achievements: EarnedAchievement[];
  pending_achievements: string[];
  apothecary_purchases: number;
  revives_given: number;
  created_at: number;
  last_active: number;
  notification_pref: "thread" | "dm";
}

interface CharacterRow extends Omit<Character, "scars" | "effects" | "drink_buff" | "achievements" | "pending_achievements"> {
  scars: string;
  effects: string;
  drink_buff_json: string | null;
  achievements: string;
  pending_achievements: string;
}

function rowToCharacter(row: CharacterRow): Character {
  return {
    ...row,
    scars: JSON.parse(row.scars) as string[],
    effects: JSON.parse(row.effects) as StatusEffect[],
    drink_buff: row.drink_buff_json ? (JSON.parse(row.drink_buff_json) as DrinkBuff) : null,
    achievements: JSON.parse(row.achievements ?? "[]") as EarnedAchievement[],
    pending_achievements: JSON.parse(row.pending_achievements ?? "[]") as string[],
  };
}

export async function getCharacter(db: D1Database, userId: string): Promise<Character | null> {
  const row = await db
    .prepare("SELECT * FROM characters WHERE slack_user_id = ?")
    .bind(userId)
    .first<CharacterRow>();
  return row ? rowToCharacter(row) : null;
}

export async function setNotificationPref(
  db: D1Database,
  userId: string,
  pref: "thread" | "dm",
): Promise<void> {
  await db
    .prepare("UPDATE characters SET notification_pref = ?, last_active = ? WHERE slack_user_id = ?")
    .bind(pref, Date.now(), userId)
    .run();
}

export interface CreateCharacterInput {
  slack_user_id: string;
  slack_team_id: string;
  name: string;
  class: string;
  hp: number;
  max_hp: number;
  gender: CharGender;
}

export async function createCharacter(
  db: D1Database,
  input: CreateCharacterInput,
): Promise<Character> {
  const now = Date.now();
  // Shield, position, last_rest_at, last_long_rest_at, downed_until,
  // tiered keys (keys_bronze/silver/gold), and effects (defaulting to '[]')
  // all rely on the ALTER TABLE DEFAULTs from their respective migrations.
  //
  // Mana/max_mana are written explicitly at 2/2 (overriding the legacy
  // DEFAULT 1 in migrations/0005_mana.sql). Two is the new floor because
  // every class active ability costs 1-2 mana — starting at 1 made Lvl 1s
  // unable to use their active until the level-5 bump landed.
  //
  // Primary stats (migration 0032) come from STARTING_STATS by class.
  // Pre-migration columns default to 5 each — overriding here so a fresh
  // character lands with proper class flavor from turn 1.
  const stats = startingStatsForClass(input.class);
  await db
    .prepare(
      `INSERT INTO characters
       (slack_user_id, slack_team_id, name, class, gender, level, xp, hp, max_hp, mana, max_mana, gold, scars, created_at, last_active,
        str, int_stat, vit, agi, dex, unspent_points)
       VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, 10, '[]', ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .bind(
      input.slack_user_id,
      input.slack_team_id,
      input.name,
      input.class,
      input.gender,
      input.hp,
      input.max_hp,
      deriveMaxMana(stats.int_stat, 1),
      deriveMaxMana(stats.int_stat, 1),
      now,
      now,
      stats.str,
      stats.int_stat,
      stats.vit,
      stats.agi,
      stats.dex,
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
  // Optional pre-rendered portrait URL — populated when the wave was generated
  // with art enabled. Promoted to scene.monster_art_url when the wave
  // activates. Old gauntlets pre-art won't have it; render code skips silently.
  art_url?: string;
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
  // Phase 2 additions — present when the loot drop originated from rollItem.
  slot?: EquipSlot | null;
  stat_bonus?: Record<string, number> | null;
  item_subtype?: string | null;
  // Phase 3 — caller-supplied level gate; defaults to ceil(power/3) in addItem.
  level_req?: number;
  element?: ElementType | null;
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
  // Optional pre-rendered character portrait URL — set during dungeon
  // construction by generateEncounterArt(kind="npc"|"merchant"). Each NPC
  // and merchant has a generated name so we cache by name slug, which means
  // the same name always renders the same portrait. Old expeditions don't
  // have this; render code falls back to no image when missing.
  art_url?: string;
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
  // AI-generated portrait URL (R2-cached). Pre-rolled at dungeon-creation time
  // alongside the room's other content. Copied to scene.monster_art_url when
  // the room becomes the active scene. Optional — old expeditions don't have it
  // and image-block render must skip silently when missing.
  monster_art_url?: string;

  // trap-only
  trap_choices?: TrapChoice[];
  // AI-generated illustration of the trap scene. Pre-rolled at dungeon-
  // creation time alongside the trap text. Optional — old expeditions
  // (pre-trap-art) don't have it and the image block is skipped silently.
  trap_art_url?: string;

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

// ── Phase 4: Graph Dungeon ────────────────────────────────────────────────────

export type DungeonDirection = "n" | "e" | "s" | "w";

export interface MonsterSpec {
  name: string;
  hp: number;
  max_hp: number;
  tier: number;
  is_boss?: boolean;
  art_url?: string | null;
  // AI-generated scene text introducing the foe ("Standing amid coiled cables,
  // the API Abandoner sneers…"). Shown in the engage banner pre-combat.
  flavor?: string | null;
  element_weakness?: ElementType;
  element_resistance?: ElementType;
}

export type DungeonObjectEffect =
  | { effect: "open_exit"; direction: DungeonDirection; reveals_node: string }
  | { effect: "spawn_item"; item: LootOption }
  | { effect: "trigger_encounter"; monsters: MonsterSpec[] }
  | { effect: "flavor"; text: string };

export interface DungeonObject {
  id: string;
  name: string;
  takeable: boolean;
  used: boolean;
  on_use?: DungeonObjectEffect;
}

export interface DungeonNode {
  id: string;
  name?: string;
  description: string;
  art_url?: string;
  exits: Partial<Record<DungeonDirection, string>>;
  objects: DungeonObject[];
  encounter?: { monsters: MonsterSpec[]; cleared: boolean };
  visited: boolean;

  // ── Grid dungeon enhancements (set when the dungeon was grid-generated).
  // Legacy AI-graph dungeons leave these undefined and fall back to old rendering.
  x?: number;                                              // grid column (0-indexed)
  y?: number;                                              // grid row (0-indexed)
  doors?: Partial<Record<DungeonDirection, GridDoor>>;     // door state per direction
  content?: GridRoomContent;                                // first-class room contents
  shape?: RoomShape;                                        // derived from exit dirs; stored for rendering convenience
}

// Door between two adjacent grid rooms. The door lives "on" the exit; both
// adjacent rooms point to logically-equivalent door records but we store the
// authoritative copy on the room with the lower (x, y).
export interface GridDoor {
  state: "open" | "locked" | "barred" | "broken";
  // For locked doors: the key tier required.
  lock_tier?: KeyTier;
  // DC for the appropriate skill check. Picking is DEX, bashing is STR.
  pick_dc?: number;
  bash_dc?: number;
  // True once any party member has bashed through (lets others walk through
  // without re-rolling).
  visible?: boolean;
}

// First-class room contents — replaces the implicit "encounter + objects[]"
// scheme. A grid-generated room has exactly one content kind (boss rooms have
// content="boss" which carries the monster + treasure together).
export type GridRoomContent =
  | { kind: "empty" }
  | { kind: "entry" }
  | { kind: "encounter"; monsters: MonsterSpec[]; cleared: boolean }
  | { kind: "boss"; monsters: MonsterSpec[]; cleared: boolean; treasure: LootOption[] }
  | { kind: "loot"; items: LootOption[]; taken: boolean }
  | { kind: "key_pickup"; tier: KeyTier; taken: boolean }
  | { kind: "trap"; choices: TrapChoice[]; resolved: boolean }
  | { kind: "lockbox"; lock_tier: KeyTier; options: LootOption[]; resolved: boolean }
  | { kind: "npc"; greeting: string; offer: LootOption; resolved: boolean; art_url?: string | null }
  | { kind: "merchant"; greeting: string; stock: LootOption[]; resolved: boolean; art_url?: string | null };

// Room shape codes drive which background art to render. Derived from the
// exit direction set: e.g. {n, e} → "corner_ne", {n, s} → "straight_ns",
// {n, e, s, w} → "cross". Empty set → "chamber" (entry/boss rooms tend to be
// chambers regardless of exits, but exits decide otherwise).
export type RoomShape =
  | "dead_n" | "dead_e" | "dead_s" | "dead_w"
  | "straight_ns" | "straight_ew"
  | "corner_ne" | "corner_nw" | "corner_se" | "corner_sw"
  | "t_n" | "t_e" | "t_s" | "t_w"
  | "cross"
  | "chamber"
  | "entry"
  | "boss";

// Compute a RoomShape from the set of exit directions and optional content type.
// Special rooms (entry, boss) override the derived shape so their bespoke art
// renders.
export function shapeFromExits(exits: ReadonlySet<DungeonDirection>, contentKind?: GridRoomContent["kind"]): RoomShape {
  if (contentKind === "entry") return "entry";
  if (contentKind === "boss") return "boss";
  const has = (d: DungeonDirection) => exits.has(d);
  const n = has("n"), e = has("e"), s = has("s"), w = has("w");
  const count = (n ? 1 : 0) + (e ? 1 : 0) + (s ? 1 : 0) + (w ? 1 : 0);
  if (count === 4) return "cross";
  if (count === 3) {
    if (!n) return "t_s"; if (!e) return "t_w"; if (!s) return "t_n"; return "t_e";
  }
  if (count === 2) {
    if (n && s) return "straight_ns";
    if (e && w) return "straight_ew";
    if (n && e) return "corner_ne";
    if (n && w) return "corner_nw";
    if (s && e) return "corner_se";
    return "corner_sw";
  }
  if (count === 1) {
    if (n) return "dead_n"; if (e) return "dead_e"; if (s) return "dead_s"; return "dead_w";
  }
  return "chamber";
}

export interface DungeonGraph {
  nodes: Record<string, DungeonNode>;
  current: string;
  visited: string[];

  // Grid dungeons set these so the minimap and traversal know the layout.
  grid_width?: number;
  grid_height?: number;
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
  // Expedition-only (legacy dungeon).
  expedition?: ExpeditionState;
  // Graph dungeon (Phase 4). When set, navigation uses /gq move instead of /gq choose.
  graph?: DungeonGraph;
  // Active monster status effects (poisoned, etc.). Tick on monster turns.
  // Cleared when the monster dies / scene transitions to a new monster.
  monster_effects?: StatusEffect[];
  // Optional public URL of the AI-generated monster portrait. Rendered as an
  // image block above the combat scene. Cached in R2 keyed by name slug —
  // same monster name always renders the same picture across quests. Field
  // is missing on legacy quests (pre-art) and on any path where art gen
  // failed; render code must treat absence as "skip image block".
  monster_art_url?: string;
  // Mark / focus-fire state. When a player marks the current monster, their
  // slack_user_id lands in marked_by and the expiry timestamp in marked_until.
  // Other party members attacking the marked monster get a focus-fire damage
  // bonus until expiry. Self-attacks by the marker DON'T get the bonus —
  // marking is for calling targets, not buffing yourself. Cleared when the
  // monster dies or a new scene/wave/room transitions.
  marked_by?: string;
  marked_until?: number;
  // Telegraphed target — who the monster commits to attack on its NEXT swing.
  // Set after each monster turn resolves (and at relevant transition points)
  // so the party gets a reactive window to heal/shield/reposition that
  // target before the hit lands. performMonsterTurn honors this commitment
  // when the next swing happens (if the target is still a viable fighter);
  // re-picks fresh otherwise. Cleared on scene transitions like the mark.
  monster_telegraph?: { target_user_id: string };
  // Per-fight class-passive trigger log. Keyed by slack_user_id, value is a
  // list of passive-keys that have already fired this fight (so once-per-
  // fight passives like the Rogue's first-attack crit or the Mage's free
  // cast can't repeat). Cleared on every scene transition (room / wave /
  // monster death) so each new fight gets fresh triggers. Always-on passives
  // (Druid regen, Bard aura, Warlock crit-bleed) don't use this — they
  // trigger every time their condition is met.
  passives_used?: Record<string, string[]>;
  // Per-fight active-ability state. Each sub-field tracks a different
  // ongoing effect:
  //   • taunt: forces monster to target this user for N more swings (Warden)
  //   • vanished: { user_id → swings_remaining } map (Rogue Vanish)
  //   • skip_swings: monster skips this many swings (Mage Containerize)
  //   • battle_hymn: party attacks get +bonus for this many more uses (Bard)
  // Cleared on scene transitions like passives_used.
  ability_state?: {
    taunt?: { user_id: string; swings_remaining: number };
    vanished?: Record<string, number>;
    skip_swings?: number;
    battle_hymn?: number;
    // Staff Sage Foresee — re-appends the intel readout to the Sage's
    // ephemeral for this many more of their own combat turns.
    foresee_turns?: number;
  };
  // Set true when the quest was accepted from the Job Board (vs. started
  // directly via /sq quest <variant>). Drives a reward bonus at victory
  // time — the town pays extra for posted contracts. Absent / false on
  // self-started quests.
  from_job_board?: boolean;
  // Multi-monster pack for standard/hunt quests. When present, buildInitialCombatState
  // uses this instead of synthesising a single monster from the root fields.
  monsters?: MonsterSpec[];
}

export type QuestMode = "slack" | "web";

export interface ActiveQuest {
  id: number;
  channel_id: string;
  thread_ts: string;
  elite: boolean;
  scene: SceneJson;
  mode: QuestMode;
  // Pinned-battlefield message ts (migrations/0028_battlefield_ts.sql).
  // Null when the quest hasn't started engine-driven combat yet. Slack's
  // engine handler upserts this: first turn -> chat.postMessage + persist
  // the returned ts; later turns -> chat.update against this ts.
  battlefield_ts: string | null;
  // Recruitment-card message ts (migrations/0031_joinable_ts.sql).
  // Set when the "Join here / Join on web" card is posted. Cleared
  // (message deleted) when the quest is no longer joinable.
  joinable_ts: string | null;
}

interface QuestRow {
  id: number;
  channel_id: string;
  thread_ts: string;
  elite: number;
  scene_json: string;
  mode: string;
  battlefield_ts: string | null;
  joinable_ts: string | null;
}

// Returns the active quest for a character, with scene data loaded.
export async function getActiveQuestForCharacter(
  db: D1Database,
  userId: string,
): Promise<ActiveQuest | null> {
  const row = await db
    .prepare(
      `SELECT q.id, q.thread_ts, q.channel_id, q.elite, q.scene_json, q.mode, q.battlefield_ts, q.joinable_ts
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
    scene: normalizeScene(JSON.parse(row.scene_json) as SceneJson),
    mode: row.mode === "web" ? "web" : "slack",
    battlefield_ts: row.battlefield_ts,
    joinable_ts: row.joinable_ts,
  };
}

// Fetch an active quest by id. Used by cross-surface callers (e.g. the
// QuestRoom DO booting combat from a Slack-side trigger) that have the
// quest id but not the caller's character/channel. Returns null when the
// quest doesn't exist or has already terminated.
export async function getQuestById(
  db: D1Database,
  questId: number,
): Promise<ActiveQuest | null> {
  const row = await db
    .prepare(
      `SELECT id, channel_id, thread_ts, elite, scene_json, mode, battlefield_ts, joinable_ts
       FROM quests
       WHERE id = ? AND status = 'active'
       LIMIT 1`,
    )
    .bind(questId)
    .first<QuestRow>();
  if (!row) return null;
  return {
    id: row.id,
    channel_id: row.channel_id,
    thread_ts: row.thread_ts,
    elite: row.elite === 1,
    scene: normalizeScene(JSON.parse(row.scene_json) as SceneJson),
    mode: row.mode === "web" ? "web" : "slack",
    battlefield_ts: row.battlefield_ts,
    joinable_ts: row.joinable_ts,
  };
}

// Persist the pinned-battlefield message ts after Slack's first
// chat.postMessage of a fight. Subsequent turns chat.update against this
// ts. Cleared at quest completion via the existing cleanup paths (no
// dedicated clearBattlefieldTs needed — quests with status != 'active'
// are never re-rendered).
export async function setBattlefieldTs(
  db: D1Database,
  questId: number,
  ts: string,
): Promise<void> {
  await db
    .prepare("UPDATE quests SET battlefield_ts = ? WHERE id = ?")
    .bind(ts, questId)
    .run();
}

// Updates the quest's thread_ts to the real Slack message ts returned by
// chat.postMessage. Used by web-originated quests: createQuest is called
// with a synthetic placeholder (`web-<timestamp>-<userId>`) because the
// quest row needs to exist before we can announce it; this writes the
// real ts back so subsequent flavor/milestone broadcasts find the actual
// thread. Safe to call on quests that never got announced — the
// placeholder just stays.
export async function setQuestThreadTs(
  db: D1Database,
  questId: number,
  threadTs: string,
): Promise<void> {
  await db
    .prepare("UPDATE quests SET thread_ts = ? WHERE id = ?")
    .bind(threadTs, questId)
    .run();
}

export async function setJoinableTs(
  db: D1Database,
  questId: number,
  ts: string,
): Promise<void> {
  await db
    .prepare("UPDATE quests SET joinable_ts = ? WHERE id = ?")
    .bind(ts, questId)
    .run();
}

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
  mode: QuestMode;
    created_by: string;
  },
): Promise<number> {
  const now = Date.now();
  const result = await db
    .prepare(
      `INSERT INTO quests (channel_id, thread_ts, status, elite, scene_json, mode, created_by, created_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?, ?)`,
    )
    .bind(
      args.channel_id,
      args.thread_ts,
      args.elite ? 1 : 0,
      JSON.stringify(args.scene),
      args.mode,
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
  await db
    .prepare(
      "UPDATE characters SET hp = ?, last_rest_at = ?, last_active = ? WHERE slack_user_id = ?",
    )
    .bind(newHp, now, now, userId)
    .run();
}

// Long rest: full HP + full mana restore + bumps last_long_rest_at. Once per 24 hours.
// Doesn't touch last_rest_at — the two cooldowns are independent.
export async function applyLongRest(db: D1Database, userId: string): Promise<void> {
  const now = Date.now();
  await db
    .prepare("UPDATE characters SET hp = max_hp, mana = max_mana, last_long_rest_at = ?, last_active = ? WHERE slack_user_id = ?")
    .bind(now, now, userId)
    .run();
}

// Inn room rest: refills HP and/or mana without consuming either rest cooldown.
export async function applyInnRest(
  db: D1Database,
  userId: string,
  refills: { hp: boolean; mana: boolean },
): Promise<void> {
  const sets: string[] = [];
  if (refills.hp) sets.push("hp = max_hp");
  if (refills.mana) sets.push("mana = max_mana");
  sets.push("last_active = ?");
  if (sets.length === 1) return;
  await db
    .prepare(`UPDATE characters SET ${sets.join(", ")} WHERE slack_user_id = ?`)
    .bind(Date.now(), userId)
    .run();
}

export async function upsertSlackUsername(
  db: D1Database,
  userId: string,
  username: string,
): Promise<void> {
  if (!username) return;
  await db
    .prepare(
      `UPDATE characters
         SET slack_username = ?
       WHERE slack_user_id = ?
         AND (slack_username IS NULL OR slack_username != ?)`,
    )
    .bind(username, userId, username)
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

// Patches just the monster_art_url field on a quest's scene_json without
// touching anything else. Used by the phase-2 transition flow: when a boss
// drops below 50% HP we kick off a wounded-portrait regen in the background;
// when it finishes we want to swap the URL in but combat may have moved on,
// so a full saveScene would race. json_set patches one field atomically.
export async function patchMonsterArtUrl(
  db: D1Database,
  questId: number,
  url: string,
): Promise<void> {
  await db
    .prepare("UPDATE quests SET scene_json = json_set(scene_json, '$.monster_art_url', ?) WHERE id = ?")
    .bind(url, questId)
    .run();
}

// Awards XP and gold; applies any level-ups and returns the deltas.
// Level-up effects: max_hp += 1d6 per level, hp restored to new max, mana
// recalculated via deriveMaxMana(int_stat, newLevel) and refilled to new max.
export async function awardSpoils(
  db: D1Database,
  character: Character,
  xp: number,
  gold: number,
  hpRollPerLevel: () => number,
  xpForLevel: (level: number) => number,
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
  const totalXp = character.xp + xp;
  let levelsGained = 0;
  while (totalXp >= xpForLevel(level + 1)) {
    level += 1;
    levelsGained += 1;
    maxHp += hpRollPerLevel();
  }
  const newHp = levelsGained > 0 ? maxHp : character.hp;
  // Mana scales with INT and level; recalculate at the new level and refill on level-up.
  const maxMana = deriveMaxMana(character.int_stat ?? 5, level);
  const newMana = levelsGained > 0 ? maxMana : Math.min(character.mana, maxMana);
  await db
    .prepare(
      `UPDATE characters
       SET xp = ?, gold = gold + ?, level = ?,
           max_hp = ?, hp = ?,
           max_mana = ?, mana = ?,
           unspent_points = unspent_points + ?,
           last_active = ?
       WHERE slack_user_id = ?`,
    )
    .bind(totalXp, gold, level, maxHp, newHp, maxMana, newMana, levelsGained, Date.now(), character.slack_user_id)
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

// Grants mana up to the character's max_mana cap. Returns the amount actually
// added (clamped if near cap). Used by trap rewards (INT pass restores mana).
// Mirrors the addShield pattern — caller passes the character so we can
// compute the delta in JS rather than re-reading.
export async function addMana(
  db: D1Database,
  target: Character,
  amount: number,
): Promise<number> {
  const newMana = Math.min(target.max_mana, target.mana + amount);
  const added = newMana - target.mana;
  if (added <= 0) return 0;
  await db
    .prepare("UPDATE characters SET mana = ?, last_active = ? WHERE slack_user_id = ?")
    .bind(newMana, Date.now(), target.slack_user_id)
    .run();
  return added;
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

// Increases max_mana by `amount`. Also bumps current mana by the same delta.
// Used when a magic-type item is consumed. No hard cap — mana scales freely.
export async function bumpMaxMana(
  db: D1Database,
  character: Character,
  amount: number,
): Promise<{ added: number; newMaxMana: number; newMana: number }> {
  const newMaxMana = character.max_mana + amount;
  const added = amount;
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
  // Phase 2 optional fields.
  slot?: EquipSlot | null;
  stat_bonus?: Record<string, number> | null;
  item_subtype?: string | null;
  // Phase 3 — defaults to ceil(power/3), minimum 1.
  level_req?: number;
}

const ITEM_COLS = "id, character_id, item_name, item_type, power, rarity, flavor, equipped, weapon_range, sharpens_count, slot, stat_bonus, item_subtype, level_req";

export async function addItem(db: D1Database, input: CreateItemInput): Promise<Item> {
  // Infer slot from item_type for legacy callers (shop purchases, etc.) that
  // don't supply an explicit slot. New slot items (rings, amulets…) always
  // supply slot explicitly via the rollItem path.
  const slot: EquipSlot | null = input.slot
    ?? (input.item_type === "weapon" ? "main_hand"
      : input.item_type === "armor" ? "body"
      : null);
  const levelReq = input.level_req ?? Math.max(1, Math.ceil(input.power / 3));
  const result = await db
    .prepare(
      `INSERT INTO inventory (character_id, item_name, item_type, power, rarity, flavor, qty, equipped, weapon_range, slot, stat_bonus, item_subtype, level_req)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.character_id, input.item_name, input.item_type, input.power, input.rarity, input.flavor,
      input.weapon_range ?? null,
      slot,
      input.stat_bonus ? JSON.stringify(input.stat_bonus) : null,
      input.item_subtype ?? null,
      levelReq,
    )
    .run();
  const id = result.meta.last_row_id;
  const row = await db
    .prepare(`SELECT ${ITEM_COLS} FROM inventory WHERE id = ?`)
    .bind(id)
    .first<ItemRow>();
  if (!row) throw new Error("Failed to read back inserted item");
  return rowToItem(row);
}

export async function getInventory(db: D1Database, characterId: string): Promise<Item[]> {
  const result = await db
    .prepare(
      `SELECT ${ITEM_COLS}
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
      `SELECT ${ITEM_COLS} FROM inventory WHERE id = ? AND character_id = ?`,
    )
    .bind(itemId, characterId)
    .first<ItemRow>();
  return row ? rowToItem(row) : null;
}

// Equips an item. Unequips any other item in the same slot (when slot is set)
// or same item_type (legacy fallback for pre-migration rows without a slot).
export async function equipItem(db: D1Database, item: Item): Promise<void> {
  const unequipStmt = item.slot
    ? db.prepare(`UPDATE inventory SET equipped = 0 WHERE character_id = ? AND slot = ?`)
        .bind(item.character_id, item.slot)
    : db.prepare(`UPDATE inventory SET equipped = 0 WHERE character_id = ? AND item_type = ?`)
        .bind(item.character_id, item.item_type);
  await db.batch([
    unequipStmt,
    db.prepare("UPDATE inventory SET equipped = 1 WHERE id = ?").bind(item.id),
  ]);
}

// Unequips a single item — opposite of equipItem when the player wants to
// drop a slot without replacing. Used by /sq unequip <id> and the [Unequip]
// inventory button. Safe to call on an already-unequipped item (no-op).
export async function unequipItem(db: D1Database, item: Item): Promise<void> {
  await db
    .prepare("UPDATE inventory SET equipped = 0 WHERE id = ?")
    .bind(item.id)
    .run();
}

// Adjusts a character's max_mana + current mana by `delta`. Used when a
// focus weapon is equipped or unequipped to add/subtract its mana
// ceiling bonus.
//
// Positive delta: max_mana increases AND current mana also bumps up so
// the player immediately has access to the extra mana (no waiting for
// regen). Negative delta: max_mana decreases AND current mana is
// clamped down to the new ceiling if it was above it.
//
// Single UPDATE keeps the two columns consistent — no race window where
// max_mana drops below mana.
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
    // Negative delta: bump max_mana down; clamp current mana to the new
    // max so we don't end up with mana > max_mana.
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
      `SELECT ${ITEM_COLS} FROM inventory WHERE character_id = ? AND item_type = ? AND equipped = 1 LIMIT 1`,
    )
    .bind(characterId, type)
    .first<ItemRow>();
  return row ? rowToItem(row) : null;
}

// Returns every equipped item keyed by slot. Unoccupied slots are null.
// Falls back to item_type-based slot inference for pre-migration rows
// (weapon→main_hand, armor→body) so callers don't need special-casing.
export async function getAllEquippedSlots(
  db: D1Database,
  characterId: string,
): Promise<Record<EquipSlot, Item | null>> {
  const result = await db
    .prepare(`SELECT ${ITEM_COLS} FROM inventory WHERE character_id = ? AND equipped = 1`)
    .bind(characterId)
    .all<ItemRow>();
  const equipped = (result.results ?? []).map(rowToItem);
  const slots: Record<EquipSlot, Item | null> = {
    main_hand: null, off_hand: null, body: null, helmet: null,
    pants: null, boots: null, ring: null, amulet: null,
  };
  for (const item of equipped) {
    const slot: EquipSlot | null = item.slot
      ?? (item.item_type === "weapon" ? "main_hand" : item.item_type === "armor" ? "body" : null);
    if (slot && slot in slots) slots[slot] = item;
  }
  return slots;
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
  slot: EquipSlot | null;
  stat_bonus: Record<string, number> | null;
  item_subtype: string | null;
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
      `SELECT id, channel_id, generated_at, item_name, item_type, power, rarity, flavor, price, bought_by, weapon_range, slot, stat_bonus, item_subtype, haggled
       FROM shop_stock
       WHERE channel_id = ? AND generated_at > ?
       ORDER BY id ASC`,
    )
    .bind(channelId, cutoff)
    .all<ShopItem & { stat_bonus: string | null }>();
  const rows = result.results ?? [];
  if (rows.length === 0) return null;
  return rows.map((row) => ({
    ...row,
    stat_bonus: row.stat_bonus ? JSON.parse(row.stat_bonus) as Record<string, number> : null,
  })) as ShopItem[];
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
  slot?: EquipSlot | null;
  stat_bonus?: Record<string, number> | null;
  item_subtype?: string | null;
}

export async function insertShopStock(
  db: D1Database,
  items: ShopStockInput[],
): Promise<void> {
  if (items.length === 0) return;
  const stmts = items.map((it) =>
    db.prepare(
      `INSERT INTO shop_stock (channel_id, generated_at, item_name, item_type, power, rarity, flavor, price, weapon_range, slot, stat_bonus, item_subtype)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      it.channel_id, it.generated_at, it.item_name, it.item_type, it.power, it.rarity, it.flavor, it.price,
      it.weapon_range ?? null,
      it.slot ?? null,
      it.stat_bonus ? JSON.stringify(it.stat_bonus) : null,
      it.item_subtype ?? null,
    ),
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
      `SELECT id, channel_id, generated_at, item_name, item_type, power, rarity, flavor, price, bought_by, weapon_range, slot, stat_bonus, item_subtype, haggled
       FROM shop_stock WHERE id = ? AND channel_id = ?`,
    )
    .bind(itemId, channelId)
    .first<ShopItem & { stat_bonus: string | null }>()
    .then((row) => {
      if (!row) return null;
      return {
        ...row,
        stat_bonus: row.stat_bonus ? JSON.parse(row.stat_bonus) as Record<string, number> : null,
      } as ShopItem;
    });
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
// Also nukes drink buffs in the same write — pub buffs don't persist past
// the quest they were drunk for, regardless of unspent charges.
export async function clearPartyEffects(db: D1Database, questId: number): Promise<void> {
  await db
    .prepare(
      `UPDATE characters SET effects = '[]', drink_buff_json = NULL, last_active = ?
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

// Median level — far more representative than mean when one high-level outlier exists.
// SQLite lacks MEDIAN(), so we pick the middle row by offset.
export async function medianCharacterLevel(db: D1Database): Promise<number> {
  const countRow = await db
    .prepare("SELECT COUNT(*) AS n FROM characters")
    .first<{ n: number }>();
  const n = countRow?.n ?? 0;
  if (n === 0) return 1;
  const offset = Math.floor(n / 2);
  const row = await db
    .prepare("SELECT level FROM characters ORDER BY level LIMIT 1 OFFSET ?")
    .bind(offset)
    .first<{ level: number }>();
  return Math.max(1, row?.level ?? 1);
}

// Min/max character level range — used to spread shop tiers across the full
// spectrum of active players so low- and high-level characters both find relevant gear.
export async function characterLevelRange(db: D1Database): Promise<{ min: number; max: number }> {
  const row = await db
    .prepare("SELECT MIN(level) AS min_level, MAX(level) AS max_level FROM characters")
    .first<{ min_level: number | null; max_level: number | null }>();
  const min = Math.max(1, row?.min_level ?? 1);
  const max = Math.max(min, row?.max_level ?? 1);
  return { min, max };
}

// Total character count — used to scale shop stock size to community size so an
// 8-person channel doesn't get a stock built for 4.
export async function countCharacters(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM characters")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Lifetime stats for a single user, aggregated across every quest they've
// taken part in. Same parsing approach as getQuestDamageStats — we read
// the quest_log table and parse outcome strings, since we never bothered
// to denormalize damage/heal/shield into dedicated columns.
//
// Quest counts are joined via quest_party (which uses character_id but
// stores slack_user_id values — the column name is legacy).
export interface LifetimeStats {
  user_id: string;
  quests_completed: number;
  quests_failed: number;
  quests_active: number;
  damage_dealt: number;
  healing_done: number;
  shielding_done: number;
  kills: number;            // last-hit count from logged "(kill)" markers
  revives: number;          // count of /sq revive uses
  deaths_soft: number;      // soft-death actions (12h cooldown)
  deaths_perma: number;     // perma-death actions (elite quests)
  by_variant: { standard: number; boss: number; gauntlet: number; dungeon: number };
}

export async function getLifetimeStats(
  db: D1Database,
  userId: string,
): Promise<LifetimeStats> {
  const result: LifetimeStats = {
    user_id: userId,
    quests_completed: 0,
    quests_failed: 0,
    quests_active: 0,
    damage_dealt: 0,
    healing_done: 0,
    shielding_done: 0,
    kills: 0,
    revives: 0,
    deaths_soft: 0,
    deaths_perma: 0,
    by_variant: { standard: 0, boss: 0, gauntlet: 0, dungeon: 0 },
  };

  // 1. Quest counts by status + by variant. quest_party.character_id stores
  // slack_user_id (legacy column name).
  const questRows = await db
    .prepare(
      `SELECT q.status, json_extract(q.scene_json, '$.variant') AS variant
       FROM quests q
       JOIN quest_party qp ON qp.quest_id = q.id
       WHERE qp.character_id = ?`,
    )
    .bind(userId)
    .all<{ status: string; variant: string | null }>();
  for (const row of questRows.results ?? []) {
    if (row.status === "completed") result.quests_completed += 1;
    else if (row.status === "failed") result.quests_failed += 1;
    else if (row.status === "active") result.quests_active += 1;
    const v = row.variant ?? "standard";
    if (v === "standard" || v === "boss" || v === "gauntlet" || v === "dungeon") {
      result.by_variant[v] += 1;
    } else {
      result.by_variant.standard += 1;
    }
  }

  // 2. Damage / heal / shield / kills aggregated from quest_log.
  // Same outcome-string parsing as getQuestDamageStats.
  const logRows = await db
    .prepare(
      `SELECT action, outcome FROM quest_log
       WHERE actor = ?
         AND action IN ('attack','cast','signature','tool','scroll','heal','shield','revive','death')`,
    )
    .bind(userId)
    .all<{ action: string; outcome: string | null }>();
  for (const row of logRows.results ?? []) {
    const o = row.outcome ?? "";
    if (row.action === "heal") {
      const m = /\+(\d+)\s*HP/.exec(o);
      if (m) result.healing_done += parseInt(m[1], 10);
    } else if (row.action === "shield") {
      const m = /\+(\d+)\s*sh/.exec(o);
      if (m) result.shielding_done += parseInt(m[1], 10);
    } else if (row.action === "revive") {
      result.revives += 1;
    } else if (row.action === "death") {
      if (o === "perma") result.deaths_perma += 1;
      else result.deaths_soft += 1;
    } else {
      // attack / cast / signature / tool / scroll → damage to monster
      const dmgMatch = /(\d+)\s*dmg/.exec(o);
      if (dmgMatch) result.damage_dealt += parseInt(dmgMatch[1], 10);
      if (/\(kill\)/.test(o)) result.kills += 1;
    }
  }

  return result;
}

// Per-character contribution stats for a quest. Aggregated from quest_log
// outcome strings — we don't store damage in a dedicated column, but every
// combat action's appendLog encodes the numbers in a parseable format.
export interface QuestDamageStats {
  user_id: string;
  damage_dealt: number;     // sum of attack/cast/sig/tool/scroll damage to monsters
  damage_taken: number;     // sum of monster-attack damage absorbed by this player (HP loss after armor/position)
  healing_done: number;     // sum of HP healed via /sq heal
  shielding_done: number;   // sum of shield added via /sq shield
  kills: number;            // count of finishing blows
}

// Reads quest_log for a quest, parses outcome strings, returns per-actor stats
// sorted by damage_dealt desc. Used at quest end for the damage-breakdown post.
//
// Two log shapes feed this:
//   • Player rows (actor = slack_user_id) — attack/cast/sig/tool/scroll
//     have "<N> dmg" in outcome; heal/shield have "+<N> HP"/"+<N> sh".
//   • Monster rows (actor = 'monster') — attack has "<N> dmg → <name>
//     <@user_id>" in outcome. The user_id tag was added so we can
//     credit damage TAKEN to the right player; legacy rows without the
//     tag are ignored for that stat (damage_dealt etc. unaffected).
export async function getQuestDamageStats(
  db: D1Database,
  questId: number,
): Promise<QuestDamageStats[]> {
  const rows = await db
    .prepare(
      `SELECT actor, action, outcome FROM quest_log
       WHERE quest_id = ?
         AND action IN ('attack', 'cast', 'signature', 'tool', 'scroll', 'heal', 'shield')`,
    )
    .bind(questId)
    .all<{ actor: string; action: string; outcome: string | null }>();

  const stats = new Map<string, QuestDamageStats>();
  const ensure = (userId: string): QuestDamageStats => {
    let s = stats.get(userId);
    if (!s) {
      s = { user_id: userId, damage_dealt: 0, damage_taken: 0, healing_done: 0, shielding_done: 0, kills: 0 };
      stats.set(userId, s);
    }
    return s;
  };

  for (const row of rows.results ?? []) {
    if (!row.outcome) continue;
    if (row.actor === "monster") {
      // Monster attack: "X dmg → Name <@user_id>". Extract the user_id
      // tag and credit damage_taken. Older logs without the tag fall
      // through silently — damage_taken just stays 0 for those quests.
      if (row.action !== "attack") continue;
      const dmgMatch = /(\d+)\s*dmg/.exec(row.outcome);
      const userMatch = /<@([A-Z0-9]+)>/.exec(row.outcome);
      if (dmgMatch && userMatch) {
        ensure(userMatch[1]).damage_taken += parseInt(dmgMatch[1], 10);
      }
      continue;
    }

    const s = ensure(row.actor);
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
// Recent monster names from this channel's last N quests, for the AI scene
// generator's avoid-list. Earlier version only read top-level monster_name,
// which is just the FINAL monster of each quest — a dungeon's sub-boss, a
// gauntlet's last wave, a standard's only foe. That missed dozens of names
// hidden in dungeon middle rooms and gauntlet wave queues, so the AI could
// (and frequently did) re-mint a name that had just been used inside a
// recent dungeon (e.g. "API Abandoner" appearing as a middle room in two
// different dungeons because neither saw the other's roster).
//
// Now extracts ALL monster names per quest:
//   • top-level monster_name (always)
//   • dungeon: every combat node's monster_name from expedition.nodes
//   • gauntlet: every queued wave's name from upcoming_waves
//
// Deduped, ordered most-recent-first. Caller can slice however many they want
// to feed into the prompt's avoid-list. `questLimit` is now QUESTS scanned,
// not names returned — a single dungeon yields ~4-6 names.
export async function getRecentMonsterNames(
  db: D1Database,
  channelId: string,
  questLimit: number,
): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT scene_json FROM quests WHERE channel_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .bind(channelId, questLimit)
    .all<{ scene_json: string }>();

  const names: string[] = [];
  const seen = new Set<string>();
  const tryAdd = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (!trimmed || trimmed === "—") return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    names.push(trimmed);
  };

  for (const r of rows.results ?? []) {
    try {
      const scene = JSON.parse(r.scene_json) as SceneJson;
      tryAdd(scene.monster_name);
      // Dungeon: every combat node's monster (middle rooms + sub-boss).
      // Sub-boss is also the top-level name, but tryAdd dedupes.
      if (scene.expedition?.nodes) {
        for (const node of scene.expedition.nodes) {
          if (node.type === "combat") tryAdd(node.monster_name);
        }
      }
      // Gauntlet: each queued wave's name. The active wave's name lives in
      // monster_name (already captured above); upcoming_waves carries the
      // rest.
      if (scene.upcoming_waves) {
        for (const wave of scene.upcoming_waves) tryAdd(wave.name);
      }
    } catch {
      // Skip malformed scene_json rows — they're rare and shouldn't crash
      // the avoid-list build.
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
      `SELECT id, channel_id, thread_ts, elite, scene_json, mode, battlefield_ts, joinable_ts
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
    scene: normalizeScene(JSON.parse(row.scene_json) as SceneJson),
    mode: row.mode === "web" ? "web" : "slack",
    battlefield_ts: row.battlefield_ts,
    joinable_ts: row.joinable_ts,
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

// Fast headcount of a quest's roster. Used to switch combat cadence: solo
// quests get a shorter action cooldown so the player isn't sitting through
// 45s with nothing to do, while parties keep the slower cadence so other
// players have time to react / coordinate.
//
// A simple COUNT vs the full character JOIN in getQuestParty — keeps the
// hot-path cooldown check cheap (~1ms).
export async function getQuestPartySize(
  db: D1Database,
  questId: number,
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM quest_party WHERE quest_id = ?`)
    .bind(questId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Atomically bumps an item's power + sharpens_count by 1, gated on owner
// match + sharpens_count < cap. Returns true if the update landed. Caller
// is responsible for deducting gold separately (and refunding on failure).
//
// The WHERE clause is the race guard: two simultaneous /sq smithy sharpen
// clicks from the same user can't double-spend a sharpen — only one writes.
// The other gets `false` and the caller re-charges nothing because the
// gold deduct happens BEFORE this call.
export async function sharpenItem(
  db: D1Database,
  itemId: number,
  userId: string,
  cap: number,
): Promise<Item | null> {
  const result = await db
    .prepare(
      `UPDATE inventory
         SET power = power + 1,
             sharpens_count = sharpens_count + 1
       WHERE id = ? AND character_id = ? AND sharpens_count < ?`,
    )
    .bind(itemId, userId, cap)
    .run();
  if (result.meta.changes === 0) return null;
  return getItem(db, itemId, userId);
}

// =============================================================================
// TOWN / PUB
// =============================================================================
// Per-channel town state — single row per channel, JSON blob carries the
// AI-generated town name, bartender, regulars (with baked dialog trees), and
// daily special drink id. Returns null if no state exists OR if `windowMs`
// has elapsed since the last refresh (caller schedules a fresh gen).
export async function getTownState(
  db: D1Database,
  channelId: string,
  windowMs: number,
): Promise<TownState | null> {
  const row = await db
    .prepare(`SELECT channel_id, refreshed_at, state_json FROM town_state WHERE channel_id = ?`)
    .bind(channelId)
    .first<{ channel_id: string; refreshed_at: number; state_json: string }>();
  if (!row) return null;
  if (Date.now() - row.refreshed_at > windowMs) return null;
  return JSON.parse(row.state_json) as TownState;
}

// Reads the raw row even when stale — used by gen code that wants to
// preserve the town NAME across daily refreshes (weekly cadence) while
// rotating the bartender / regulars / special.
export async function getStaleTownState(
  db: D1Database,
  channelId: string,
): Promise<TownState | null> {
  const row = await db
    .prepare(`SELECT state_json FROM town_state WHERE channel_id = ?`)
    .bind(channelId)
    .first<{ state_json: string }>();
  return row ? (JSON.parse(row.state_json) as TownState) : null;
}

export async function saveTownState(
  db: D1Database,
  state: TownState,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO town_state (channel_id, refreshed_at, state_json)
       VALUES (?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET refreshed_at = excluded.refreshed_at, state_json = excluded.state_json`,
    )
    .bind(state.channel_id, state.refreshed_at, JSON.stringify(state))
    .run();
}

// Returns the set of dialog-tree branch paths a player has already claimed
// a payload from for this NPC on this refresh. Empty set if no row, or if
// the row's refresh_date doesn't match (treated as fresh tree → no claims).
export async function getClaimedNpcPaths(
  db: D1Database,
  channelId: string,
  userId: string,
  npcId: string,
  refreshDate: number,
): Promise<Set<string>> {
  const row = await db
    .prepare(
      `SELECT claimed_paths_json, refresh_date FROM npc_payloads_claimed
       WHERE channel_id = ? AND user_id = ? AND npc_id = ?`,
    )
    .bind(channelId, userId, npcId)
    .first<{ claimed_paths_json: string; refresh_date: number }>();
  if (!row) return new Set();
  // Stale claim row for a previous tree refresh — treat as no claims.
  if (row.refresh_date !== refreshDate) return new Set();
  return new Set(JSON.parse(row.claimed_paths_json) as string[]);
}

// Records that a player has claimed the payload at the given branch path.
// Idempotent — re-recording the same path is a no-op. Migrates the row to
// the current refresh_date if it was stale (resetting prior claims).
export async function recordClaimedNpcPath(
  db: D1Database,
  channelId: string,
  userId: string,
  npcId: string,
  refreshDate: number,
  path: string,
): Promise<void> {
  const existing = await getClaimedNpcPaths(db, channelId, userId, npcId, refreshDate);
  existing.add(path);
  const json = JSON.stringify([...existing]);
  await db
    .prepare(
      `INSERT INTO npc_payloads_claimed (channel_id, user_id, npc_id, refresh_date, claimed_paths_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, user_id, npc_id) DO UPDATE SET
         refresh_date = excluded.refresh_date,
         claimed_paths_json = excluded.claimed_paths_json,
         updated_at = excluded.updated_at`,
    )
    .bind(channelId, userId, npcId, refreshDate, json, Date.now())
    .run();
}

// =============================================================================
// PUB GAMES LEADERBOARD
// =============================================================================
//
// Channel-scoped, derived purely from existing tables — no new persistence.
// Every gold flow through Liars' Roll + SPD matches + SPD side bets is
// summed per user; the renderer sorts by net P/L.
//
// "Games played" counts each independent settlement event:
//   - one resolved Liars' round = one event
//   - one done SPD match = one event each for initiator and challenger
//   - one SPD side bet on a done match = one event for the bettor
// A win is an event with net > 0. Ties (refunded SPD matches) don't
// count; cancelled / open / abandoned rows are excluded entirely.

export interface PubLeaderboardEntry {
  user_id: string;
  games: number;
  wins: number;
  net: number;                              // total net gold (positive = profit)
  biggest_win: { amount: number; game: "liars" | "spd_match" | "spd_bet" } | null;
  biggest_loss: { amount: number; game: "liars" | "spd_match" | "spd_bet" } | null;
}

export async function getPubLeaderboard(
  db: D1Database,
  channelId: string,
): Promise<PubLeaderboardEntry[]> {
  // Pull the three event sources in parallel. Each query already filters
  // to resolved/done status so we don't have to dance around in-flight
  // matches. SPD bets join their match to pull winner_user_id +
  // channel_id for the gating + payout logic.
  const [liarsRows, spdMatchRows, spdBetRows] = await Promise.all([
    db.prepare(
      `SELECT user_id, stake, payout, outcome
         FROM liars_rounds
        WHERE channel_id = ? AND status = 'resolved'`,
    ).bind(channelId).all<{ user_id: string; stake: number; payout: number | null; outcome: string }>(),
    db.prepare(
      `SELECT initiator_user_id, challenger_user_id, initiator_stake, winner_user_id, house_bump
         FROM spd_matches
        WHERE channel_id = ? AND status = 'done'`,
    ).bind(channelId).all<{
      initiator_user_id: string; challenger_user_id: string | null;
      initiator_stake: number; winner_user_id: string | null; house_bump: number | null;
    }>(),
    db.prepare(
      `SELECT b.bettor_user_id, b.side, b.amount, m.winner_user_id, m.initiator_user_id, m.challenger_user_id
         FROM spd_bets b
         JOIN spd_matches m ON m.id = b.match_id
        WHERE m.channel_id = ? AND m.status = 'done'`,
    ).bind(channelId).all<{
      bettor_user_id: string; side: string; amount: number;
      winner_user_id: string | null; initiator_user_id: string; challenger_user_id: string | null;
    }>(),
  ]);

  const stats = new Map<string, PubLeaderboardEntry>();
  const ensure = (userId: string): PubLeaderboardEntry => {
    let s = stats.get(userId);
    if (!s) {
      s = { user_id: userId, games: 0, wins: 0, net: 0, biggest_win: null, biggest_loss: null };
      stats.set(userId, s);
    }
    return s;
  };
  const recordEvent = (userId: string, net: number, game: "liars" | "spd_match" | "spd_bet") => {
    const s = ensure(userId);
    s.games += 1;
    s.net += net;
    if (net > 0) {
      s.wins += 1;
      if (!s.biggest_win || net > s.biggest_win.amount) s.biggest_win = { amount: net, game };
    } else if (net < 0) {
      if (!s.biggest_loss || -net > s.biggest_loss.amount) s.biggest_loss = { amount: -net, game };
    }
  };

  // Liars rounds — payout already includes the 5% house rake; loss = -stake.
  for (const r of liarsRows.results ?? []) {
    const won = r.outcome === "trust_win" || r.outcome === "challenge_win";
    const net = won ? ((r.payout ?? 0) - r.stake) : -r.stake;
    recordEvent(r.user_id, net, "liars");
  }

  // SPD matches — winner takes 2× stake + house_bump; loser drops their stake.
  // Ties (winner_user_id null) shouldn't appear here because they're refunded
  // and finalize with winner=null and bump=0; we still skip them defensively.
  for (const m of spdMatchRows.results ?? []) {
    if (!m.winner_user_id || !m.challenger_user_id) continue;
    const bump = m.house_bump ?? 0;
    const winnerNet = m.initiator_stake + bump;       // stake back + opponent's stake (= 2×stake) - own stake = +stake; plus bump
    const loserNet = -m.initiator_stake;
    if (m.winner_user_id === m.initiator_user_id) {
      recordEvent(m.initiator_user_id, winnerNet, "spd_match");
      recordEvent(m.challenger_user_id, loserNet, "spd_match");
    } else {
      recordEvent(m.challenger_user_id, winnerNet, "spd_match");
      recordEvent(m.initiator_user_id, loserNet, "spd_match");
    }
  }

  // SPD bets — winning bet pays 2× (so net = +amount); losing bet net = -amount.
  for (const b of spdBetRows.results ?? []) {
    if (!b.winner_user_id) continue;
    const winningSideUserId = b.winner_user_id === b.initiator_user_id ? b.initiator_user_id : b.challenger_user_id;
    const sideMatchesWinner = (b.side === "initiator" && winningSideUserId === b.initiator_user_id)
      || (b.side === "challenger" && winningSideUserId === b.challenger_user_id);
    const net = sideMatchesWinner ? b.amount : -b.amount;
    recordEvent(b.bettor_user_id, net, "spd_bet");
  }

  return Array.from(stats.values()).sort((a, b) => b.net - a.net);
}
//
// Server-side state for the bluff mini-game. The bartender's secret
// dice + whether they're lying about the zone live here so the round
// can't be exploited by inspecting button payloads. Round row created
// when the player picks a stake; resolved when they click Trust /
// Challenge.

export type LiarsClaim = "low" | "medium" | "high";
export type LiarsOutcome = "trust_win" | "trust_lose" | "challenge_win" | "challenge_lose";

export interface LiarsRound {
  id: number;
  user_id: string;
  channel_id: string;
  stake: number;
  player_dice: number[];
  bartender_dice: number[];
  claim: LiarsClaim;
  lied: boolean;
  status: "open" | "resolved";
  outcome: LiarsOutcome | null;
  payout: number | null;
  created_at: number;
  resolved_at: number | null;
}

interface LiarsRoundRow extends Omit<LiarsRound, "player_dice" | "bartender_dice" | "lied"> {
  player_dice: string;
  bartender_dice: string;
  lied: number;
}

function rowToLiarsRound(row: LiarsRoundRow): LiarsRound {
  return {
    ...row,
    player_dice: JSON.parse(row.player_dice) as number[],
    bartender_dice: JSON.parse(row.bartender_dice) as number[],
    lied: row.lied === 1,
  };
}

export interface CreateLiarsRoundInput {
  user_id: string;
  channel_id: string;
  stake: number;
  player_dice: number[];
  bartender_dice: number[];
  claim: LiarsClaim;
  lied: boolean;
}
export async function createLiarsRound(
  db: D1Database,
  input: CreateLiarsRoundInput,
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO liars_rounds (user_id, channel_id, stake, player_dice, bartender_dice, claim, lied, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.user_id,
      input.channel_id,
      input.stake,
      JSON.stringify(input.player_dice),
      JSON.stringify(input.bartender_dice),
      input.claim,
      input.lied ? 1 : 0,
      Date.now(),
    )
    .run();
  return result.meta.last_row_id as number;
}

export async function getLiarsRound(
  db: D1Database,
  roundId: number,
): Promise<LiarsRound | null> {
  const row = await db
    .prepare(`SELECT * FROM liars_rounds WHERE id = ?`)
    .bind(roundId)
    .first<LiarsRoundRow>();
  return row ? rowToLiarsRound(row) : null;
}

// Race-safe finalize: only writes if status is still 'open'. Caller
// computed payout + outcome; returns true if THIS call's UPDATE won.
// The losing race-claimant gets false back and shouldn't apply gold
// changes (the winner already did).
export async function finalizeLiarsRound(
  db: D1Database,
  roundId: number,
  outcome: LiarsOutcome,
  payout: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE liars_rounds SET status = 'resolved', outcome = ?, payout = ?, resolved_at = ? WHERE id = ? AND status = 'open'`,
    )
    .bind(outcome, payout, Date.now(), roundId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// =============================================================================
// STONE-PARCHMENT-DAGGER
// =============================================================================
//
// Persistent two-player match state + spectator side bets. Matches are
// per-channel (one open at a time, enforced by a single-row query gate),
// bets are per (match, bettor). All amounts are stored as raw gold — no
// derived state is cached on disk; payouts compute fresh at resolution.

export type SpdStatus = "open" | "resolving" | "done" | "cancelled";

export interface SpdMatch {
  id: number;
  channel_id: string;
  initiator_user_id: string;
  initiator_stake: number;
  initiator_throw: string;             // SpdThrow string; typed in callers via flavor.ts cast
  challenger_user_id: string | null;
  challenger_throw: string | null;
  status: SpdStatus;
  winner_user_id: string | null;
  house_bump: number | null;
  message_ts: string | null;
  created_at: number;
  resolved_at: number | null;
  // Last time the initiator surfaced this match via the Bump button.
  // Null = never bumped; the cooldown check then uses created_at as
  // the floor instead. Updated atomically in tryBumpSpdMatch.
  last_bumped_at: number | null;
}

export interface SpdBet {
  match_id: number;
  bettor_user_id: string;
  side: "initiator" | "challenger";
  amount: number;
  created_at: number;
}

// Returns the channel's single in-flight match if any, or null. Used as
// the gate before creating a new match — only one open match per channel.
export async function getOpenSpdMatch(
  db: D1Database,
  channelId: string,
): Promise<SpdMatch | null> {
  return db
    .prepare(
      `SELECT * FROM spd_matches WHERE channel_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`,
    )
    .bind(channelId)
    .first<SpdMatch>();
}

export async function getSpdMatch(
  db: D1Database,
  matchId: number,
): Promise<SpdMatch | null> {
  return db
    .prepare(`SELECT * FROM spd_matches WHERE id = ?`)
    .bind(matchId)
    .first<SpdMatch>();
}

export interface CreateSpdMatchInput {
  channel_id: string;
  initiator_user_id: string;
  initiator_stake: number;
  initiator_throw: string;
}
export async function createSpdMatch(
  db: D1Database,
  input: CreateSpdMatchInput,
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO spd_matches (channel_id, initiator_user_id, initiator_stake, initiator_throw, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(input.channel_id, input.initiator_user_id, input.initiator_stake, input.initiator_throw, Date.now())
    .run();
  return result.meta.last_row_id as number;
}

// Attaches the public-message ts to a match so future state-update posts
// can reply in-thread. Fire-and-forget; non-fatal if it fails.
export async function setSpdMessageTs(
  db: D1Database,
  matchId: number,
  messageTs: string,
): Promise<void> {
  await db
    .prepare(`UPDATE spd_matches SET message_ts = ? WHERE id = ?`)
    .bind(messageTs, matchId)
    .run();
}

// Atomic "accept" + transition to resolving in one shot. The UPDATE's
// WHERE clause is the race guard:
//   - status must still be 'open'
//   - challenger_user_id must still be NULL
//   - the would-be challenger must not be the initiator
// If meta.changes = 0, the second of two simultaneous accepts lost the
// race and the caller refuses with "someone else already accepted."
export async function acceptSpdMatch(
  db: D1Database,
  matchId: number,
  challengerUserId: string,
  challengerThrow: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE spd_matches
          SET challenger_user_id = ?,
              challenger_throw = ?,
              status = 'resolving'
        WHERE id = ?
          AND status = 'open'
          AND challenger_user_id IS NULL
          AND initiator_user_id != ?`,
    )
    .bind(challengerUserId, challengerThrow, matchId, challengerUserId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// Final state write. Single statement so the row is consistent — winner,
// bump, resolution time, and status all land together. Caller has
// already done the payout DB writes for participants + bettors.
export async function finalizeSpdMatch(
  db: D1Database,
  matchId: number,
  winnerUserId: string | null,
  houseBump: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE spd_matches SET status = 'done', winner_user_id = ?, house_bump = ?, resolved_at = ? WHERE id = ?`,
    )
    .bind(winnerUserId, houseBump, Date.now(), matchId)
    .run();
}

// Race-safe cancel: only flips status to 'cancelled' if it was 'open'.
// Caller checks the boolean and runs refunds if true. Used by both
// initiator-cancel and auto-expiry.
export async function cancelSpdMatch(
  db: D1Database,
  matchId: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE spd_matches SET status = 'cancelled', resolved_at = ? WHERE id = ? AND status = 'open'`,
    )
    .bind(Date.now(), matchId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// Race-safe bet placement. INSERT OR IGNORE on the composite PK means
// double-clicks AND simultaneous-spectator races both resolve to one
// row. Returns true if THIS call's INSERT won.
export async function placeSpdBet(
  db: D1Database,
  bet: SpdBet,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO spd_bets (match_id, bettor_user_id, side, amount, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(bet.match_id, bet.bettor_user_id, bet.side, bet.amount, Date.now())
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function getSpdBets(
  db: D1Database,
  matchId: number,
): Promise<SpdBet[]> {
  const result = await db
    .prepare(`SELECT * FROM spd_bets WHERE match_id = ? ORDER BY created_at ASC`)
    .bind(matchId)
    .all<SpdBet>();
  return result.results ?? [];
}

// Looks up THIS user's bet on THIS match (one bet per user enforced by
// the table's PK). Used to refuse double-bets cleanly with the original
// side+amount surfaced.
export async function getSpdBetByUser(
  db: D1Database,
  matchId: number,
  bettorUserId: string,
): Promise<SpdBet | null> {
  return db
    .prepare(`SELECT * FROM spd_bets WHERE match_id = ? AND bettor_user_id = ?`)
    .bind(matchId, bettorUserId)
    .first<SpdBet>();
}

// Atomic Bump: writes last_bumped_at = now ONLY if the match is open,
// owned by the requested user, AND its prior bump (or creation) is
// older than the cooldown cutoff. The WHERE clause is the race +
// cooldown guard — caller checks meta.changes to know if it landed.
//
// Returns true if THIS call's UPDATE won. False = either someone else
// raced us, the cooldown isn't up yet, or the match isn't open.
export async function tryBumpSpdMatch(
  db: D1Database,
  matchId: number,
  initiatorUserId: string,
  cooldownMs: number,
): Promise<boolean> {
  const cutoff = Date.now() - cooldownMs;
  const result = await db
    .prepare(
      `UPDATE spd_matches SET last_bumped_at = ?
       WHERE id = ?
         AND initiator_user_id = ?
         AND status = 'open'
         AND ((last_bumped_at IS NULL AND created_at < ?) OR last_bumped_at < ?)`,
    )
    .bind(Date.now(), matchId, initiatorUserId, cutoff, cutoff)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// Sweeps any open match in the channel that's past its expiry cutoff.
// Returns the swept matches so the caller can refund stakes/bets. Lazy
// — only runs from view paths so we don't need a cron.
export async function findExpiredSpdMatches(
  db: D1Database,
  channelId: string,
  expiryMs: number,
): Promise<SpdMatch[]> {
  const cutoff = Date.now() - expiryMs;
  const result = await db
    .prepare(
      `SELECT * FROM spd_matches WHERE channel_id = ? AND status = 'open' AND created_at < ?`,
    )
    .bind(channelId, cutoff)
    .all<SpdMatch>();
  return result.results ?? [];
}

// =============================================================================
// JOB BOARD CLAIMS
// =============================================================================
//
// Each board posting (per channel, per refresh stamp) can be claimed by
// at most one player. The atomic claim is an INSERT OR IGNORE on the
// composite primary key — if two players click "Take Job" simultaneously,
// exactly one INSERT succeeds and the other is rejected by the uniqueness
// constraint. The caller checks `meta.changes` to know which side won.

export async function tryClaimJob(
  db: D1Database,
  channelId: string,
  refreshStamp: number,
  jobId: string,
  userId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO job_claims (channel_id, refresh_stamp, job_id, taken_by, taken_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(channelId, refreshStamp, jobId, userId, Date.now())
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// Returns a map of job_id → claim info for every job claimed under a
// given (channel, refresh_stamp). Caller folds this into the renderer
// to show "taken by @user" badges and disable claimed buttons.
export async function getJobClaims(
  db: D1Database,
  channelId: string,
  refreshStamp: number,
): Promise<Record<string, { taken_by: string; taken_at: number }>> {
  const result = await db
    .prepare(`SELECT job_id, taken_by, taken_at FROM job_claims WHERE channel_id = ? AND refresh_stamp = ?`)
    .bind(channelId, refreshStamp)
    .all<{ job_id: string; taken_by: string; taken_at: number }>();
  const out: Record<string, { taken_by: string; taken_at: number }> = {};
  for (const row of result.results ?? []) {
    out[row.job_id] = { taken_by: row.taken_by, taken_at: row.taken_at };
  }
  return out;
}

// Reads a single claim if present. Cheaper than getJobClaims for the
// take-handler path which only cares about one job at a time. Returns
// the claimant on win (caller can show "Sorry, @taker beat you to it")
// or null if no claim exists yet.
export async function getJobClaim(
  db: D1Database,
  channelId: string,
  refreshStamp: number,
  jobId: string,
): Promise<{ taken_by: string; taken_at: number } | null> {
  const row = await db
    .prepare(
      `SELECT taken_by, taken_at FROM job_claims
       WHERE channel_id = ? AND refresh_stamp = ? AND job_id = ?`,
    )
    .bind(channelId, refreshStamp, jobId)
    .first<{ taken_by: string; taken_at: number }>();
  return row ?? null;
}

// =============================================================================
// DRINK BUFFS
// =============================================================================
// Single-buff JSON on characters.drink_buff_json. Second drink replaces
// first — no stacking. Cleared at quest end (clearDrinkBuff called from
// the quest-end paths).
export async function setDrinkBuff(
  db: D1Database,
  userId: string,
  buff: DrinkBuff,
): Promise<void> {
  await db
    .prepare(`UPDATE characters SET drink_buff_json = ?, last_active = ? WHERE slack_user_id = ?`)
    .bind(JSON.stringify(buff), Date.now(), userId)
    .run();
}

export async function clearDrinkBuff(
  db: D1Database,
  userId: string,
): Promise<void> {
  await db
    .prepare(`UPDATE characters SET drink_buff_json = NULL WHERE slack_user_id = ?`)
    .bind(userId)
    .run();
}

// Decrement the buff's remaining counter by 1; clears the buff entirely if
// it hits zero. Returns the post-tick buff (or null if it expired). Called
// after each combat action consumes a buff charge.
export async function tickDrinkBuff(
  db: D1Database,
  userId: string,
): Promise<DrinkBuff | null> {
  const row = await db
    .prepare(`SELECT drink_buff_json FROM characters WHERE slack_user_id = ?`)
    .bind(userId)
    .first<{ drink_buff_json: string | null }>();
  if (!row?.drink_buff_json) return null;
  const buff = JSON.parse(row.drink_buff_json) as DrinkBuff;
  const remaining = buff.remaining - 1;
  if (remaining <= 0) {
    await clearDrinkBuff(db, userId);
    return null;
  }
  const next: DrinkBuff = { ...buff, remaining };
  await setDrinkBuff(db, userId, next);
  return next;
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
         AND action IN ('attack', 'cast', 'flee', 'signature', 'ability', 'heal', 'shield', 'revive', 'position', 'tool', 'scroll')
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
  party_size: number;
  duration_ms: number | null;
}

export interface QuestStats {
  total: number;
  wins: number;
  losses: number;
  win_rate: number;
  current_streak: number;
  best_streak: number;
  elite_wins: number;
  by_variant: Record<string, { wins: number; total: number }>;
}

export interface QuestLeaderboardEntry {
  slack_user_id: string;
  name: string;
  slack_username: string | null;
  class: string;
  level: number;
  wins: number;
  total_quests: number;
  elite_wins: number;
}

export async function getRecentQuestsForCharacter(
  db: D1Database,
  userId: string,
  limit: number,
): Promise<RecentQuestSummary[]> {
  const result = await db
    .prepare(
      `SELECT q.id, q.status, q.elite, q.scene_json, q.created_at, q.completed_at,
              COUNT(qp2.character_id) as party_size
       FROM quests q
       JOIN quest_party qp ON qp.quest_id = q.id
       LEFT JOIN quest_party qp2 ON qp2.quest_id = q.id
       WHERE qp.character_id = ? AND q.status IN ('completed', 'failed')
       GROUP BY q.id
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
      party_size: number;
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
      party_size: r.party_size ?? 1,
      duration_ms: r.completed_at ? r.completed_at - r.created_at : null,
    };
  });
}

export async function getQuestStatsForCharacter(
  db: D1Database,
  userId: string,
): Promise<QuestStats> {
  const rows = await db
    .prepare(
      `SELECT q.status, q.elite, json_extract(q.scene_json, '$.variant') as variant
       FROM quests q
       JOIN quest_party qp ON qp.quest_id = q.id
       WHERE qp.character_id = ? AND q.status IN ('completed', 'failed')
       ORDER BY COALESCE(q.completed_at, q.created_at) DESC
       LIMIT 500`,
    )
    .bind(userId)
    .all<{ status: "completed" | "failed"; elite: number; variant: string | null }>();

  const all = rows.results ?? [];
  let wins = 0, losses = 0, eliteWins = 0;
  let currentStreak = 0, bestStreak = 0, runStreak = 0;
  const byVariant: Record<string, { wins: number; total: number }> = {};

  for (const r of all) {
    const won = r.status === "completed";
    won ? wins++ : losses++;
    if (won && r.elite === 1) eliteWins++;
    const v = r.variant ?? "standard";
    if (!byVariant[v]) byVariant[v] = { wins: 0, total: 0 };
    byVariant[v].total++;
    if (won) byVariant[v].wins++;
  }

  // Streak walks from most-recent (index 0) backwards
  for (let i = 0; i < all.length; i++) {
    if (all[i].status === "completed") {
      runStreak++;
      if (i === 0 || currentStreak === 0) currentStreak = runStreak;
      bestStreak = Math.max(bestStreak, runStreak);
    } else {
      if (i === 0) currentStreak = 0;
      runStreak = 0;
    }
  }

  const total = wins + losses;
  return {
    total,
    wins,
    losses,
    win_rate: total > 0 ? Math.round((wins / total) * 100) : 0,
    current_streak: currentStreak,
    best_streak: bestStreak,
    elite_wins: eliteWins,
    by_variant: byVariant,
  };
}

export async function getQuestLeaderboard(
  db: D1Database,
  limit = 10,
): Promise<QuestLeaderboardEntry[]> {
  const rows = await db
    .prepare(
      `SELECT c.slack_user_id, c.name, c.slack_username, c.class, c.level,
              COUNT(CASE WHEN q.status = 'completed' THEN 1 END) as wins,
              COUNT(CASE WHEN q.status IN ('completed','failed') THEN 1 END) as total_quests,
              COUNT(CASE WHEN q.status = 'completed' AND q.elite = 1 THEN 1 END) as elite_wins
       FROM characters c
       LEFT JOIN quest_party qp ON qp.character_id = c.slack_user_id
       LEFT JOIN quests q ON q.id = qp.quest_id AND q.status IN ('completed','failed')
       GROUP BY c.slack_user_id
       HAVING total_quests > 0
       ORDER BY wins DESC, total_quests DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<{
      slack_user_id: string;
      name: string;
      slack_username: string | null;
      class: string;
      level: number;
      wins: number;
      total_quests: number;
      elite_wins: number;
    }>();
  return (rows.results ?? []).map((r) => ({ ...r }));
}

// ── Achievement helpers ───────────────────────────────────────────────────────

export async function grantAchievement(
  db: D1Database,
  userId: string,
  achievementId: string,
): Promise<boolean> {
  const char = await getCharacter(db, userId);
  if (!char) return false;
  if (char.achievements.some((a) => a.id === achievementId)) return false;
  const updated: EarnedAchievement[] = [...char.achievements, { id: achievementId, unlocked_at: Date.now() }];
  const pending = [...char.pending_achievements, achievementId];
  await db
    .prepare("UPDATE characters SET achievements = ?, pending_achievements = ?, last_active = ? WHERE slack_user_id = ?")
    .bind(JSON.stringify(updated), JSON.stringify(pending), Date.now(), userId)
    .run();
  return true;
}

export async function consumePendingAchievements(
  db: D1Database,
  userId: string,
): Promise<string[]> {
  const char = await getCharacter(db, userId);
  if (!char || char.pending_achievements.length === 0) return [];
  await db
    .prepare("UPDATE characters SET pending_achievements = '[]' WHERE slack_user_id = ?")
    .bind(userId)
    .run();
  return char.pending_achievements;
}

export async function incrementApothecaryPurchases(db: D1Database, userId: string): Promise<number> {
  await db.prepare("UPDATE characters SET apothecary_purchases = apothecary_purchases + 1 WHERE slack_user_id = ?")
    .bind(userId).run();
  const row = await db.prepare("SELECT apothecary_purchases FROM characters WHERE slack_user_id = ?")
    .bind(userId).first<{ apothecary_purchases: number }>();
  return row?.apothecary_purchases ?? 1;
}

export async function incrementRevivesGiven(db: D1Database, userId: string): Promise<number> {
  await db.prepare("UPDATE characters SET revives_given = revives_given + 1 WHERE slack_user_id = ?")
    .bind(userId).run();
  const row = await db.prepare("SELECT revives_given FROM characters WHERE slack_user_id = ?")
    .bind(userId).first<{ revives_given: number }>();
  return row?.revives_given ?? 1;
}

// Characters currently on a soft-death cooldown. Used by the Apothecary to
// show who can be revived by a party member with a revive item.
export interface DownedCharacter {
  slack_user_id: string;
  name: string;
  class: string;
  downed_until: number;
  slack_username: string | null;
}

export async function getDownedCharacters(db: D1Database): Promise<DownedCharacter[]> {
  const rows = await db
    .prepare(
      `SELECT slack_user_id, name, class, downed_until, slack_username
       FROM characters WHERE downed_until IS NOT NULL AND downed_until > ?`,
    )
    .bind(Date.now())
    .all<DownedCharacter>();
  return rows.results ?? [];
}

// Atomically spends 1 unspent_point on the chosen primary stat. The WHERE
// guard prevents spending when points = 0. Returns the updated character, or
// null when the write didn't land (no points left or unknown userId).
// stat must be a valid StatKey column name.
export async function spendStatPoint(
  db: D1Database,
  userId: string,
  stat: StatKey,
): Promise<Character | null> {
  // Map StatKey to the exact column name (int_stat uses its column name directly).
  const col = stat === "int_stat" ? "int_stat" : stat;
  const result = await db
    .prepare(
      `UPDATE characters
          SET ${col} = ${col} + 1, unspent_points = unspent_points - 1
        WHERE slack_user_id = ? AND unspent_points > 0`,
    )
    .bind(userId)
    .run();
  if (result.meta.changes === 0) return null;
  return getCharacter(db, userId);
}
