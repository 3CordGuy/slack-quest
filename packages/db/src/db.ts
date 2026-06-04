// D1 query helpers. Raw prepared statements — no ORM.

import type { AbilityLoadout, DamageType, DrinkBuff, EffectType, ElementType, EarnedAchievement, EquipSlot, ItemRoll, ItemType, Rarity, RolledAffix, StatKey, Stats, TalentNodeDef, TownState, WeaponRange } from "@gantt-quest/core";
import { classIdForTree, deriveMaxMana, emptyLoadoutForLevel, findNode, MAX_ACTIVE_SLOTS, nodesForClass, passiveSlotsForLevel, pointCostForRank, startingStatsForClass } from "@gantt-quest/core";

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
  // Stack count for resources (ores / herbs / fish). Always 1 for gear /
  // consumables — those use the per-row pattern.
  qty: number;
  // Apothecary Concentrate stacks on consumable potions (0..APOTHECARY_POTENCY_CAP).
  // Each stack boosts the potion's effective power by +25% at use time.
  potency_stacks: number;
  // Gear-affix system (migration 0063, design doc:
  // docs/gear-affixes-and-uniques.md). null on consumables/tools/resources;
  // legacy rows backfill item_level from power and treat affixes as empty.
  item_level: number | null;
  affixes: RolledAffix[];          // [] if none rolled (common items, legacy rows)
  unique_id: string | null;        // UNIQUE_REGISTRY key, legendary only
  set_id: string | null;           // SET_REGISTRY key, set pieces only
}

interface ItemRow extends Omit<Item, "equipped" | "stat_bonus" | "affixes"> {
  equipped: number;
  stat_bonus: string | null; // stored as JSON text in D1
  affixes: string | null;    // stored as JSON text in D1
}

function rowToItem(row: ItemRow): Item {
  return {
    ...row,
    equipped: row.equipped === 1,
    stat_bonus: row.stat_bonus ? JSON.parse(row.stat_bonus) as Record<string, number> : null,
    affixes: row.affixes ? JSON.parse(row.affixes) as RolledAffix[] : [],
    // Legacy rows pre-migration get item_level synthesized from power so
    // downstream gating (level_req, tooltip iLvl display) stays sane.
    item_level: row.item_level ?? row.power,
    unique_id: row.unique_id ?? null,
    set_id: row.set_id ?? null,
  };
}

export type BattlePosition = "front" | "back";

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
  // Pub merc slot — id from the MERCS catalog. Null when nobody is hired.
  // Cleared when the active quest ends.
  hired_merc_id: string | null;
  // Climb-the-Tower lifetime stats. Incremented per-kill / per-cycle by the
  // tower flow. tower_best_floor is monotonic; tower_floors_climbed sums across
  // every cycle including incomplete ones; tower_kills counts enemies slain
  // inside any tower run.
  tower_floors_climbed: number;
  tower_kills: number;
  tower_best_floor: number;
  // Which slot (1-3) this active character occupies. Used by the web slot
  // picker to know which slot to snapshot into when activating another saved
  // character. Slack does not surface slots; legacy rows default to 1.
  active_slot: number;
  // Camp + errand activity counters (migration 0054). Power the camp/smithy/
  // errand achievement set + the rested-gather bonus. Incremented at claim
  // / craft / errand-complete time; never decremented.
  camp_ore_mined: number;
  camp_herbs_foraged: number;
  camp_fish_caught: number;
  camp_deep_claimed: number;
  smithy_crafts: number;
  errands_completed: number;
  errands_courier: number;
  errands_procure: number;
  errands_investigate: number;
  errands_mercy: number;
  errands_long: number;
  /** Last time the player's *main* (slot 1) claimed a gather. Drives the
      +50% rested bonus when ≥24h has passed at the next gather start.
      Null = never gathered. */
  last_gather_claimed_at: number | null;
  /** Mining mini-game lifetime rich-vein strikes (migration 0055). */
  mine_rich_hits: number;
  /** Foraging mini-game lifetime rare finds (migration 0055, phase 2). */
  forage_rare_finds: number;
  /** Fishing mini-game fastest bite reaction in ms (migration 0055, phase 2). */
  fish_best_ms: number;
  /** Timestamp (ms) when vigor will next be full. Null/past = full vigor
      (cap 3). Each Quick Strike push this forward by 1 hour. Current vigor
      is computed as MAX(0, 3 - ceil((vigor_full_at - now) / 1hr)). */
  vigor_full_at: number | null;
  /** DEPRECATED: forage vigor (migration 0057). Replaced by forage_stock_full_at
      in migration 0059. Kept in the schema for backward-compat; not read. */
  forage_vigor_full_at: number | null;
  /** DEPRECATED: fishing vigor (migration 0058). Replaced by fish_stock_full_at. */
  fish_vigor_full_at: number | null;
  /** Total Quick Cast plays — gates the Fastest Hook leaderboard so a
      lucky one-shot doesn't dominate. */
  fish_plays: number;
  /** Mining harvestable stock — when this timestamp is past/null, the mine
      has its full 10-stock. Each play depletes stock by the resources pulled
      and pushes this forward by units × 1hr. Stock refills naturally over time. */
  mine_stock_full_at: number | null;
  /** Forage harvestable stock — same shape as mine_stock_full_at. */
  forage_stock_full_at: number | null;
  /** Fishing harvestable stock — same shape. */
  fish_stock_full_at: number | null;
  /** Email address for magic-code sign-in (migration 0060). Null on Slack-only
      and unlinked guest accounts. Unique when set. */
  email: string | null;
  /** 1 when this row was created via /api/auth/guest (random uuid id, no email).
      Flips to 0 once the player links an email. Surfaced in the popover so
      guests see a "Save your character" CTA. */
  is_guest: number;
  /** Cumulative max-mana added by magic crystals (migration 0061). Stored
      separately from the INT+level formula so level-ups don't wipe crystal
      progress. max_mana = deriveMaxMana(int_stat, level) + mana_bonus. */
  mana_bonus: number;
  /** Talent tree points pool (migration 0062). +1 granted per level via
      awardSpoils. Spent on ability rank purchases via /api/character/talents/buy. */
  talent_points: number;
  /** Equipped ability loadout (migration 0062). Null on first read for
      pre-rollout characters; getCharacter() lazy-seeds with the player's
      class starter kit and the matching character_talents rank-1 rows. */
  ability_loadout: AbilityLoadout | null;
}

interface CharacterRow extends Omit<Character, "scars" | "effects" | "drink_buff" | "achievements" | "pending_achievements" | "ability_loadout"> {
  scars: string;
  effects: string;
  drink_buff_json: string | null;
  achievements: string;
  pending_achievements: string;
  ability_loadout: string | null;
}

function rowToCharacter(row: CharacterRow): Character {
  return {
    ...row,
    scars: JSON.parse(row.scars) as string[],
    effects: JSON.parse(row.effects) as StatusEffect[],
    drink_buff: row.drink_buff_json ? (JSON.parse(row.drink_buff_json) as DrinkBuff) : null,
    achievements: JSON.parse(row.achievements ?? "[]") as EarnedAchievement[],
    pending_achievements: JSON.parse(row.pending_achievements ?? "[]") as string[],
    ability_loadout: row.ability_loadout ? (JSON.parse(row.ability_loadout) as AbilityLoadout) : null,
  };
}

// Build the starter loadout for a player who's never touched the talent tree:
// first 4 active class abilities → active slots, first passive → passive slot.
// Pads with nulls if the class kit is smaller than the slot count.
function buildStarterLoadout(className: string, level: number): { loadout: AbilityLoadout; seededNodeIds: string[] } {
  const empty = emptyLoadoutForLevel(level);
  const classId = classIdForTree(className);
  if (!classId) return { loadout: empty, seededNodeIds: [] };
  const nodes = nodesForClass(classId);
  const activeNodes = nodes.filter((n) => n.ability.kind === "active");
  const passiveNodes = nodes.filter((n) => n.ability.kind === "passive");
  const passiveSlots = passiveSlotsForLevel(level);
  const active: (string | null)[] = Array.from({ length: MAX_ACTIVE_SLOTS }, (_, i) => activeNodes[i]?.id ?? null);
  const passive: (string | null)[] = Array.from({ length: passiveSlots }, (_, i) => passiveNodes[i]?.id ?? null);
  const seededNodeIds = [
    ...active.filter((id): id is string => id !== null),
    ...passive.filter((id): id is string => id !== null),
  ];
  return { loadout: { active, passive }, seededNodeIds };
}

// Persist the starter loadout + rank-1 character_talents rows for an existing
// player on first read after the talent rollout. Idempotent — if rows already
// exist (PRIMARY KEY conflict on character_talents), the INSERT OR IGNORE skips.
async function seedDefaultLoadout(db: D1Database, character: Character): Promise<Character> {
  const { loadout, seededNodeIds } = buildStarterLoadout(character.class, character.level);
  const now = Date.now();
  const writes: D1PreparedStatement[] = [];
  writes.push(
    db.prepare("UPDATE characters SET ability_loadout = ? WHERE slack_user_id = ?")
      .bind(JSON.stringify(loadout), character.slack_user_id),
  );
  for (const nodeId of seededNodeIds) {
    writes.push(
      db.prepare("INSERT OR IGNORE INTO character_talents (character_id, node_id, rank, acquired_at) VALUES (?, ?, 1, ?)")
        .bind(character.slack_user_id, nodeId, now),
    );
  }
  if (writes.length > 0) await db.batch(writes);
  return { ...character, ability_loadout: loadout };
}

export async function getCharacter(db: D1Database, userId: string): Promise<Character | null> {
  const row = await db
    .prepare("SELECT * FROM characters WHERE slack_user_id = ?")
    .bind(userId)
    .first<CharacterRow>();
  if (!row) return null;
  const character = rowToCharacter(row);
  if (character.ability_loadout === null) {
    return seedDefaultLoadout(db, character);
  }
  return character;
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
  // and effects (defaulting to '[]') all rely on the ALTER TABLE DEFAULTs
  // from their respective migrations.
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


export type QuestVariant = "standard" | "boss" | "gauntlet" | "tower";

// One floor of a tower run. Stored on SceneJson.upcoming_waves[] as the
// pre-rolled queue. `kind` flags whether the engine should fight, the player
// should pick from a merchant stock, or it's the cycle boss; `rest_stock` is
// only present on rest floors; `boss_treasure` is only present on boss floors.
export interface TowerFloorPlan {
  // Absolute floor number (1, 2, … 11, 12, …). Persists across cycles.
  floor: number;
  kind: "combat" | "rest" | "boss";
  // combat/boss monster (omitted on rest)
  monster?: MonsterSpec;
  // rest stop merchant offering (omitted on combat/boss)
  rest_stock?: LootOption[];
  // boss hoard granted on kill (omitted on combat/rest)
  boss_treasure?: LootOption[];
}

// Read-time scene hook. Kept as a passthrough so call sites have a single
// place to wire future migrations if/when the scene shape evolves again.
function normalizeScene(scene: SceneJson): SceneJson {
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
  tier?: number;
  // Gear-affix system (design doc: docs/gear-affixes-and-uniques.md).
  // Optional so legacy persisted scenes still parse — read paths treat
  // missing fields as legacy and the picked item ends up affix-less.
  item_level?: number | null;
  affixes?: RolledAffix[];
  unique_id?: string | null;
  set_id?: string | null;
}

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
  // Attack damage type: determines armor vs. resistance routing when this monster hits.
  // undefined → "physical" (backward-compat with persisted scene_json).
  attack_damage_type?: DamageType;
  // Player damage type weakness/resistance — separate from elemental proc affinities.
  damage_weakness?: DamageType;
  damage_resistance?: DamageType;
  // Current armor pool. Physical player attacks deplete it before HP; cast bypasses.
  // undefined → defaults to tier at combat init. Updated in scene_json between turns.
  armor?: number;
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
  //   • battle_hymn: party attacks get +bonus for this many more uses (Bard)
  //   • action_counters: per-user action count, used by periodic passives
  //     such as Mana Font (1 mana every 3 turns).
  // Cleared on scene transitions like passives_used.
  ability_state?: {
    taunt?: { user_id: string; swings_remaining: number };
    vanished?: Record<string, number>;
    battle_hymn?: number;
    // Frontend Bard — Encourage: fighter's next N to-hit rolls use advantage.
    encourage?: Record<string, number>;
    // Frontend Bard — Mock: monster's next N to-hit rolls use disadvantage.
    discourage?: Record<string, number>;
    // Staff Sage Foresee — re-appends the intel readout to the Sage's
    // ephemeral for this many more of their own combat turns.
    foresee_turns?: number;
    // Per-user action counters for periodic passives.
    action_counters?: Record<string, number>;
  };
  // Set true when the quest was accepted from the Job Board (vs. started
  // directly via /sq quest <variant>). Drives a reward bonus at victory
  // time — the town pays extra for posted contracts. Absent / false on
  // self-started quests.
  from_job_board?: boolean;
  // Multi-monster pack for standard/hunt quests. When present, buildInitialCombatState
  // uses this instead of synthesising a single monster from the root fields.
  monsters?: MonsterSpec[];
  // Attack damage type for the primary (single) monster. undefined → "physical".
  // For pack quests, each MonsterSpec carries its own attack_damage_type instead.
  monster_attack_type?: DamageType;
  // Damage type weakness/resistance on the primary monster.
  monster_damage_weakness?: DamageType;
  monster_damage_resistance?: DamageType;
  // Current armor pool for the primary monster. Physical player attacks deplete it.
  // undefined → tier (full) on the first hit of a new fight. For pack quests,
  // each MonsterSpec.armor carries the per-monster pool.
  monster_armor?: number;
  // Tower-only — absolute floor number (1, 2, … 11, 12, …) of the monster
  // currently in the scene.
  tower_floor?: number;
  // Tower-only — current cycle (1 = floors 1-10, 2 = floors 11-20, etc.).
  tower_cycle?: number;
  // Tower-only — kind of the current floor. Drives UI: "combat" engages the
  // monster, "rest" shows the merchant card, "boss" engages and on win flips
  // to the awaiting-choice screen.
  tower_floor_kind?: "combat" | "rest" | "boss";
  // Tower-only — pre-rolled remaining floors in this cycle. Drained by the
  // floor-advance helper; replenished on cycle continue.
  tower_queue?: TowerFloorPlan[];
  // Tower-only — pre-rolled merchant stock for the current rest floor.
  // Cleared once the party leaves the floor via /tower/rest_advance.
  tower_rest_stock?: LootOption[];
  // Tower-only — claim map for the current rest floor. Keys are stringified
  // item indices ("0".."2"); values are the claimer's slack_user_id. Each
  // party member can claim at most one item per rest stop. Cleared on
  // rest_advance.
  tower_rest_claims?: Record<string, string>;
  // Tower-only — cumulative enemies slain across this run.
  tower_kills_run?: number;
  // Tower-only — true between a boss kill and the player picking
  // continue / exit. Blocks any further combat or movement.
  tower_awaiting_choice?: boolean;
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
  // Quest creator's slack_user_id. Exposed so the web UI can gate
  // creator-only affordances (open reinforcement, cancel, lock).
  created_by: string;
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
  created_by: string;
}

// Returns the active quest for a character, with scene data loaded.
export async function getActiveQuestForCharacter(
  db: D1Database,
  userId: string,
): Promise<ActiveQuest | null> {
  const row = await db
    .prepare(
      `SELECT q.id, q.thread_ts, q.channel_id, q.elite, q.scene_json, q.mode, q.battlefield_ts, q.joinable_ts, q.created_by
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
    created_by: row.created_by,
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
      `SELECT id, channel_id, thread_ts, elite, scene_json, mode, battlefield_ts, joinable_ts, created_by
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
    created_by: row.created_by,
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
    lobby?: boolean;
    lobby_expires_at?: number;
    is_private?: boolean;
  },
): Promise<number> {
  const now = Date.now();
  const status = args.lobby ? "lobby" : "active";
  const result = await db
    .prepare(
      `INSERT INTO quests (channel_id, thread_ts, status, elite, scene_json, mode, created_by, created_at, lobby_expires_at, is_private)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      args.channel_id,
      args.thread_ts,
      status,
      args.elite ? 1 : 0,
      JSON.stringify(args.scene),
      args.mode,
      args.created_by,
      now,
      args.lobby_expires_at ?? null,
      args.is_private ? 1 : 0,
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
// `effective`, when provided, also bumps the stored max_hp/max_mana columns so
// camp's displayed ceiling stays aligned with the equipment-augmented cap.
export async function applyShortRest(
  db: D1Database,
  userId: string,
  newHp: number,
  effective?: { max_hp: number; max_mana: number },
): Promise<void> {
  const now = Date.now();
  if (effective) {
    await db
      .prepare("UPDATE characters SET hp = ?, max_hp = ?, max_mana = ?, last_rest_at = ?, last_active = ? WHERE slack_user_id = ?")
      .bind(newHp, effective.max_hp, effective.max_mana, now, now, userId)
      .run();
    return;
  }
  await db
    .prepare(
      "UPDATE characters SET hp = ?, last_rest_at = ?, last_active = ? WHERE slack_user_id = ?",
    )
    .bind(newHp, now, now, userId)
    .run();
}

// Long rest: full HP + full mana restore + bumps last_long_rest_at. Once per 24 hours.
// Doesn't touch last_rest_at — the two cooldowns are independent.
// When `effective` is provided, refills to the equipment-augmented caps (and
// bumps the stored max_hp/max_mana to match) so camp HP matches what combat
// computes. Without it, refills to the stored max_hp/max_mana on the row.
export async function applyLongRest(
  db: D1Database,
  userId: string,
  effective?: { max_hp: number; max_mana: number },
): Promise<void> {
  const now = Date.now();
  if (effective) {
    await db
      .prepare("UPDATE characters SET hp = ?, mana = ?, max_hp = ?, max_mana = ?, last_long_rest_at = ?, last_active = ? WHERE slack_user_id = ?")
      .bind(effective.max_hp, effective.max_mana, effective.max_hp, effective.max_mana, now, now, userId)
      .run();
    return;
  }
  await db
    .prepare("UPDATE characters SET hp = max_hp, mana = max_mana, last_long_rest_at = ?, last_active = ? WHERE slack_user_id = ?")
    .bind(now, now, userId)
    .run();
}

// Inn room rest: refills HP and/or mana without consuming either rest cooldown.
// `effective`, when provided, mirrors applyLongRest's behavior: HP/mana refill
// to the equipment-augmented caps and the stored max columns get bumped.
export async function applyInnRest(
  db: D1Database,
  userId: string,
  refills: { hp: boolean; mana: boolean },
  effective?: { max_hp: number; max_mana: number },
): Promise<void> {
  const now = Date.now();
  if (effective) {
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (refills.hp) { sets.push("hp = ?", "max_hp = ?"); binds.push(effective.max_hp, effective.max_hp); }
    if (refills.mana) { sets.push("mana = ?", "max_mana = ?"); binds.push(effective.max_mana, effective.max_mana); }
    if (sets.length === 0) return;
    sets.push("last_active = ?");
    binds.push(now, userId);
    await db
      .prepare(`UPDATE characters SET ${sets.join(", ")} WHERE slack_user_id = ?`)
      .bind(...binds)
      .run();
    return;
  }
  const sets: string[] = [];
  if (refills.hp) sets.push("hp = max_hp");
  if (refills.mana) sets.push("mana = max_mana");
  sets.push("last_active = ?");
  if (sets.length === 1) return;
  await db
    .prepare(`UPDATE characters SET ${sets.join(", ")} WHERE slack_user_id = ?`)
    .bind(now, userId)
    .run();
}

// Tower lifetime-stat bump. Kills + floors-climbed accumulate; best_floor is
// monotonic (only overwritten when the supplied value beats the stored one).
export async function incrementTowerStats(
  db: D1Database,
  userId: string,
  delta: { kills?: number; floorsClimbed?: number; bestFloor?: number },
): Promise<void> {
  const kills = Math.max(0, delta.kills ?? 0);
  const floorsClimbed = Math.max(0, delta.floorsClimbed ?? 0);
  const bestFloor = Math.max(0, delta.bestFloor ?? 0);
  await db
    .prepare(
      `UPDATE characters
         SET tower_kills = tower_kills + ?,
             tower_floors_climbed = tower_floors_climbed + ?,
             tower_best_floor = MAX(tower_best_floor, ?),
             last_active = ?
       WHERE slack_user_id = ?`,
    )
    .bind(kills, floorsClimbed, bestFloor, Date.now(), userId)
    .run();
}

export interface TowerLeaderboardRow {
  slack_user_id: string;
  name: string;
  class: string;
  slack_username: string | null;
  tower_best_floor: number;
  tower_kills: number;
  tower_floors_climbed: number;
}

// Top climbers ordered by deepest floor reached, ties broken by total kills.
// Rows with zero progress are filtered out so the board reads as actual
// participation rather than every character that has ever existed.
export async function getTowerLeaderboard(
  db: D1Database,
  limit = 10,
): Promise<TowerLeaderboardRow[]> {
  const res = await db
    .prepare(
      `SELECT slack_user_id, name, class, slack_username,
              tower_best_floor, tower_kills, tower_floors_climbed
         FROM characters
        WHERE tower_best_floor > 0 OR tower_kills > 0
        ORDER BY tower_best_floor DESC, tower_kills DESC, tower_floors_climbed DESC
        LIMIT ?`,
    )
    .bind(Math.max(1, Math.min(100, limit)))
    .all<TowerLeaderboardRow>();
  return res.results ?? [];
}

// Camp mini-game leaderboard row. Each player has one row with all three
// per-node mastery stats; the UI picks which one to rank by per row.
// fish_plays gates the Fastest Hook board so a lucky one-shot doesn't win.
export interface HarvestLeaderboardRow {
  slack_user_id: string;
  name: string;
  class: string;
  slack_username: string | null;
  mine_rich_hits: number;
  forage_rare_finds: number;
  fish_best_ms: number;
  fish_plays: number;
}

// Pulls a single rows-per-character set with all three mini-game stats so
// the UI can pivot into multiple ranked lists ("Veins Struck" / "Rare Finds"
// / "Fastest Hook") without three separate round trips. Phase 1 ships only
// the mining game, so we order by mine_rich_hits and filter to rows with
// at least one strike; this query will widen when forage/fish ship.
export async function getHarvestLeaderboard(
  db: D1Database,
  limit = 10,
): Promise<HarvestLeaderboardRow[]> {
  const res = await db
    .prepare(
      `SELECT slack_user_id, name, class, slack_username,
              mine_rich_hits, forage_rare_finds, fish_best_ms, fish_plays
         FROM characters
        WHERE mine_rich_hits > 0 OR forage_rare_finds > 0 OR fish_best_ms > 0
        ORDER BY (mine_rich_hits + forage_rare_finds + CASE WHEN fish_best_ms > 0 THEN 1 ELSE 0 END) DESC
        LIMIT ?`,
    )
    .bind(Math.max(1, Math.min(100, limit)))
    .all<HarvestLeaderboardRow>();
  return res.results ?? [];
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
  // max_mana = formula(INT, level) + crystal bonus. Crystal bonus persists
  // across level-ups; the formula part grows automatically with level.
  const formulaMana = deriveMaxMana(character.int_stat ?? 5, level);
  const maxMana = formulaMana + (character.mana_bonus ?? 0);
  const newMana = levelsGained > 0 ? maxMana : Math.min(character.mana, maxMana);
  await db
    .prepare(
      `UPDATE characters
       SET xp = ?, gold = gold + ?, level = ?,
           max_hp = ?, hp = ?,
           max_mana = ?, mana = ?,
           unspent_points = unspent_points + ?,
           talent_points = talent_points + ?,
           last_active = ?
       WHERE slack_user_id = ?`,
    )
    .bind(totalXp, gold, level, maxHp, newHp, maxMana, newMana, levelsGained, levelsGained, Date.now(), character.slack_user_id)
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

// Sets character shield to floor(equipped armor power / 2) at quest start and
// on /sq shield. Uses a correlated sub-select so no extra round-trip is needed.
export async function initArmorPool(db: D1Database, userId: string): Promise<void> {
  const slots = await getAllEquippedSlots(db, userId);
  const armorPower =
    (slots.body?.power ?? 0) +
    Math.floor((slots.helmet?.power ?? 0) / 2) +
    Math.floor((slots.pants?.power ?? 0) / 4) +
    (slots.off_hand?.item_subtype === "shield" ? (slots.off_hand?.power ?? 0) : 0);
  const armorMax = Math.floor(armorPower / 2);
  await db
    .prepare("UPDATE characters SET shield = ?, last_active = ? WHERE slack_user_id = ?")
    .bind(armorMax, Date.now(), userId)
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

// Increments mana_bonus (the persistent crystal contribution) by `amount`.
// max_mana is recalculated as deriveMaxMana(int_stat, level) + new mana_bonus
// so level-ups preserve crystal progress. Current mana is bumped by the same
// delta, clamped to the new max.
export async function bumpMaxMana(
  db: D1Database,
  character: Character,
  amount: number,
): Promise<{ added: number; newMaxMana: number; newMana: number }> {
  const newBonus = (character.mana_bonus ?? 0) + amount;
  const newMaxMana = deriveMaxMana(character.int_stat ?? 5, character.level) + newBonus;
  const added = amount;
  const newMana = Math.min(newMaxMana, character.mana + added);
  await db
    .prepare(
      `UPDATE characters SET mana_bonus = ?, max_mana = ?, mana = ?, last_active = ?
       WHERE slack_user_id = ?`,
    )
    .bind(newBonus, newMaxMana, newMana, Date.now(), character.slack_user_id)
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
  element?: ElementType | null;
  // Gear-affix system (migration 0063). Optional — pre-affix callers leave
  // these null and the engine treats the item as legacy (item_level synthesized
  // from power on read, affixes empty, no unique/set effects).
  item_level?: number | null;
  affixes?: RolledAffix[] | null;
  unique_id?: string | null;
  set_id?: string | null;
}

// Translates a rolled ItemRoll into a CreateItemInput, preserving every
// field that should persist to DB. Centralized so loot-drop / treasure /
// reward call sites don't drift — historically these sites lost roll.slot,
// roll.stat_bonus, roll.element and roll.item_subtype, which broke ring/
// amulet drops and elemental weapons silently. Pass-through plus the new
// affix-system fields (item_level, affixes, unique_id, set_id).
export function itemRollToCreateInput(args: {
  character_id: string;
  roll: ItemRoll;
  item_name: string;
  flavor: string;
}): CreateItemInput {
  const { character_id, roll, item_name, flavor } = args;
  return {
    character_id,
    item_name,
    item_type: roll.type,
    power: roll.power,
    rarity: roll.rarity,
    flavor,
    weapon_range: roll.weapon_range ?? null,
    slot: roll.slot ?? null,
    stat_bonus: (roll.stat_bonus as Record<string, number> | undefined) ?? null,
    item_subtype: roll.item_subtype ?? null,
    element: roll.element ?? null,
    item_level: roll.item_level ?? null,
    affixes: roll.affixes ?? null,
    unique_id: roll.unique_id ?? null,
    set_id: roll.set_id ?? null,
  };
}

// Translates a rotating-stock row (shop, smithy, tower rest stock) into a
// CreateItemInput when a player buys / picks it. Centralizes the field
// passthrough so future affix additions land in one place. The stock-row
// type intentionally accepts the common subset across ShopItem,
// SmithyStockItem, and LootOption — the buy handlers don't need different
// shapes per surface.
export function stockToCreateInput(args: {
  character_id: string;
  stock: {
    item_name: string;
    item_type: ItemType;
    power: number;
    rarity: Rarity;
    flavor: string | null;
    weapon_range?: WeaponRange | null;
    slot?: EquipSlot | null;
    stat_bonus?: Record<string, number> | null;
    item_subtype?: string | null;
    element?: ElementType | null;
    item_level?: number | null;
    affixes?: RolledAffix[];
    unique_id?: string | null;
    set_id?: string | null;
  };
  item_name?: string;
  flavor?: string;
}): CreateItemInput {
  const { character_id, stock } = args;
  return {
    character_id,
    item_name: args.item_name ?? stock.item_name,
    item_type: stock.item_type,
    power: stock.power,
    rarity: stock.rarity,
    flavor: args.flavor ?? stock.flavor ?? "",
    weapon_range: stock.weapon_range ?? null,
    slot: stock.slot ?? null,
    stat_bonus: stock.stat_bonus ?? null,
    item_subtype: stock.item_subtype ?? null,
    element: stock.element ?? null,
    item_level: stock.item_level ?? null,
    affixes: stock.affixes ?? null,
    unique_id: stock.unique_id ?? null,
    set_id: stock.set_id ?? null,
  };
}

const ITEM_COLS = "id, character_id, item_name, item_type, power, rarity, flavor, equipped, weapon_range, sharpens_count, slot, stat_bonus, item_subtype, level_req, element, qty, potency_stacks, item_level, affixes, unique_id, set_id";

export async function addItem(db: D1Database, input: CreateItemInput): Promise<Item> {
  // Infer slot from item_type for legacy callers (shop purchases, etc.) that
  // don't supply an explicit slot. New slot items (rings, amulets…) always
  // supply slot explicitly via the rollItem path.
  const slot: EquipSlot | null = input.slot
    ?? (input.item_type === "weapon" ? "main_hand"
      : input.item_type === "armor" ? "body"
      : null);
  // item_level defaults to power for backwards-compat — matches the rowToItem
  // legacy synthesis so callers that pre-date the affix system stay consistent.
  const itemLevel = input.item_level ?? input.power;
  // level_req: prefer the iLvl-derived formula from the design doc when iLvl
  // is supplied; fall back to the legacy ceil(power/3) for pre-affix callers.
  //
  // Consumables (and the other non-equippable types) are an exception: their
  // `power` is the HP/MP they restore, not gear power, so dividing by 3 to
  // get a level_req produces wildly wrong numbers — a Surf & Stream Platter
  // (power 110) was landing at level_req 37. The recipe's own `level_req`
  // already gates *crafting*; once it's in your inventory it should be
  // usable regardless of level. Default to 1 when no explicit level_req is
  // passed for these types.
  const nonEquippable =
    input.item_type === "consumable"
    || input.item_type === "magic"
    || input.item_type === "revive"
    || input.item_type === "tool"
    || input.item_type === "scroll";
  const levelReq = input.level_req
    ?? (nonEquippable
      ? 1
      : input.item_level != null
        ? Math.max(1, Math.floor(itemLevel / 2))
        : Math.max(1, Math.ceil(input.power / 3)));
  const affixesJson = input.affixes && input.affixes.length > 0 ? JSON.stringify(input.affixes) : null;
  const result = await db
    .prepare(
      `INSERT INTO inventory (character_id, item_name, item_type, power, rarity, flavor, qty, equipped, weapon_range, slot, stat_bonus, item_subtype, level_req, element, item_level, affixes, unique_id, set_id)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.character_id, input.item_name, input.item_type, input.power, input.rarity, input.flavor,
      input.weapon_range ?? null,
      slot,
      input.stat_bonus ? JSON.stringify(input.stat_bonus) : null,
      input.item_subtype ?? null,
      levelReq,
      input.element ?? null,
      itemLevel,
      affixesJson,
      input.unique_id ?? null,
      input.set_id ?? null,
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
  element: ElementType | null;
  // Gear-affix system (migration 0064). Mirrors the inventory shape so
  // buyers receive items with the same affix / unique / set data the roll
  // produced. Legacy rows normalize item_level from power on read.
  item_level: number | null;
  affixes: RolledAffix[];
  unique_id: string | null;
  set_id: string | null;
}

// Returns active shop stock (generated within the cutoff window, available items only),
// or null if a fresh restock is needed.
// Column list shared by getActiveShopStock + getShopItem so the two stay
// in sync as new fields are added.
const SHOP_STOCK_COLS = "id, channel_id, generated_at, item_name, item_type, power, rarity, flavor, price, bought_by, weapon_range, slot, stat_bonus, item_subtype, haggled, element, item_level, affixes, unique_id, set_id";

// Normalizes a shop_stock row read from D1: parses JSON columns, synthesizes
// item_level from power for legacy rows pre-migration-0064, and defaults
// affixes to [] when absent so callers always get a stable array shape.
function normalizeShopRow(row: ShopItem & { stat_bonus: string | null; affixes?: string | null }): ShopItem {
  return {
    ...row,
    stat_bonus: row.stat_bonus ? JSON.parse(row.stat_bonus) as Record<string, number> : null,
    affixes: row.affixes ? JSON.parse(row.affixes) as RolledAffix[] : [],
    item_level: row.item_level ?? row.power,
    unique_id: row.unique_id ?? null,
    set_id: row.set_id ?? null,
  };
}

export async function getActiveShopStock(
  db: D1Database,
  channelId: string,
  windowMs: number,
): Promise<ShopItem[] | null> {
  const cutoff = Date.now() - windowMs;
  const result = await db
    .prepare(
      `SELECT ${SHOP_STOCK_COLS}
       FROM shop_stock
       WHERE channel_id = ? AND generated_at > ?
       ORDER BY id ASC`,
    )
    .bind(channelId, cutoff)
    .all<ShopItem & { stat_bonus: string | null; affixes: string | null }>();
  const rows = result.results ?? [];
  if (rows.length === 0) return null;
  return rows.map(normalizeShopRow);
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
  element?: ElementType | null;
  // Gear-affix system (migration 0064). Optional — pre-affix callers
  // leave these null and the buyer ends up with a legacy-shaped item.
  item_level?: number | null;
  affixes?: RolledAffix[] | null;
  unique_id?: string | null;
  set_id?: string | null;
}

export async function insertShopStock(
  db: D1Database,
  items: ShopStockInput[],
): Promise<void> {
  if (items.length === 0) return;
  const stmts = items.map((it) =>
    db.prepare(
      `INSERT INTO shop_stock (channel_id, generated_at, item_name, item_type, power, rarity, flavor, price, weapon_range, slot, stat_bonus, item_subtype, element, item_level, affixes, unique_id, set_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      it.channel_id, it.generated_at, it.item_name, it.item_type, it.power, it.rarity, it.flavor, it.price,
      it.weapon_range ?? null,
      it.slot ?? null,
      it.stat_bonus ? JSON.stringify(it.stat_bonus) : null,
      it.item_subtype ?? null,
      it.element ?? null,
      it.item_level ?? it.power,
      it.affixes && it.affixes.length > 0 ? JSON.stringify(it.affixes) : null,
      it.unique_id ?? null,
      it.set_id ?? null,
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
      `SELECT ${SHOP_STOCK_COLS}
       FROM shop_stock WHERE id = ? AND channel_id = ?`,
    )
    .bind(itemId, channelId)
    .first<ShopItem & { stat_bonus: string | null; affixes: string | null }>()
    .then((row) => row ? normalizeShopRow(row) : null);
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

// ───── Smithy stock ────────────────────────────────────────────────────────
// Per-channel rotating armor stock. Mirrors shop_stock — everyone in the
// channel sees the same forged-and-ready listing, and a buy stamps it
// SOLD for the rest of the channel. (Was per-character pre-migration
// 0045; character_id is preserved on legacy rows for audit and on new
// rows as "who triggered the restock".)

export interface SmithyStockItem {
  id: number;
  character_id: string;
  channel_id: string | null;
  generated_at: number;
  item_name: string;
  item_type: ItemType;
  power: number;
  rarity: Rarity;
  flavor: string | null;
  price: number;
  slot: EquipSlot | null;
  stat_bonus: Record<string, number> | null;
  item_subtype: string | null;
  bought_by: string | null;
  // Gear-affix system (migration 0064). Same shape as ShopItem; buyers
  // get items with full affix data instead of legacy-shaped plate.
  item_level: number | null;
  affixes: RolledAffix[];
  unique_id: string | null;
  set_id: string | null;
}

export interface SmithyStockInput {
  // Player who triggered the restock. Stored for audit only — read paths
  // filter on channel_id.
  character_id: string;
  channel_id: string;
  generated_at: number;
  item_name: string;
  item_type: ItemType;
  power: number;
  rarity: Rarity;
  flavor: string;
  price: number;
  slot?: EquipSlot | null;
  stat_bonus?: Record<string, number> | null;
  item_subtype?: string | null;
  // Gear-affix system (migration 0064). Optional for pre-affix callers.
  item_level?: number | null;
  affixes?: RolledAffix[] | null;
  unique_id?: string | null;
  set_id?: string | null;
}

const SMITHY_STOCK_COLS = "id, character_id, channel_id, generated_at, item_name, item_type, power, rarity, flavor, price, slot, stat_bonus, item_subtype, bought_by, item_level, affixes, unique_id, set_id";

function normalizeSmithyRow(row: SmithyStockItem & { stat_bonus: string | null; affixes?: string | null }): SmithyStockItem {
  return {
    ...row,
    stat_bonus: row.stat_bonus ? JSON.parse(row.stat_bonus) as Record<string, number> : null,
    affixes: row.affixes ? JSON.parse(row.affixes) as RolledAffix[] : [],
    item_level: row.item_level ?? row.power,
    unique_id: row.unique_id ?? null,
    set_id: row.set_id ?? null,
  };
}

export async function getActiveSmithyStock(
  db: D1Database,
  channelId: string,
  windowMs: number,
): Promise<SmithyStockItem[] | null> {
  const cutoff = Date.now() - windowMs;
  const result = await db
    .prepare(
      `SELECT ${SMITHY_STOCK_COLS}
       FROM smithy_stock
       WHERE channel_id = ? AND generated_at > ?
       ORDER BY id ASC`,
    )
    .bind(channelId, cutoff)
    .all<SmithyStockItem & { stat_bonus: string | null; affixes: string | null }>();
  const rows = result.results ?? [];
  if (rows.length === 0) return null;
  return rows.map(normalizeSmithyRow);
}

export async function insertSmithyStock(
  db: D1Database,
  items: SmithyStockInput[],
): Promise<void> {
  if (items.length === 0) return;
  const stmts = items.map((it) =>
    db.prepare(
      `INSERT INTO smithy_stock (character_id, channel_id, generated_at, item_name, item_type, power, rarity, flavor, price, slot, stat_bonus, item_subtype, item_level, affixes, unique_id, set_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      it.character_id, it.channel_id, it.generated_at, it.item_name, it.item_type, it.power, it.rarity, it.flavor, it.price,
      it.slot ?? null,
      it.stat_bonus ? JSON.stringify(it.stat_bonus) : null,
      it.item_subtype ?? null,
      it.item_level ?? it.power,
      it.affixes && it.affixes.length > 0 ? JSON.stringify(it.affixes) : null,
      it.unique_id ?? null,
      it.set_id ?? null,
    ),
  );
  await db.batch(stmts);
}

// Fetch one stock row by id, scoped to a channel (server-enforced
// membership — callers pass the requesting user's resolved channel).
export async function getSmithyStockItem(
  db: D1Database,
  itemId: number,
  channelId: string,
): Promise<SmithyStockItem | null> {
  const row = await db
    .prepare(
      `SELECT ${SMITHY_STOCK_COLS}
       FROM smithy_stock WHERE id = ? AND channel_id = ?`,
    )
    .bind(itemId, channelId)
    .first<SmithyStockItem & { stat_bonus: string | null; affixes: string | null }>();
  return row ? normalizeSmithyRow(row) : null;
}

// Atomically claim a smithy stock row. Returns true if we won the race.
export async function claimSmithyItem(
  db: D1Database,
  itemId: number,
  buyerId: string,
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE smithy_stock SET bought_by = ? WHERE id = ? AND bought_by IS NULL")
    .bind(buyerId, itemId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function releaseSmithyClaim(db: D1Database, itemId: number): Promise<void> {
  await db
    .prepare("UPDATE smithy_stock SET bought_by = NULL WHERE id = ?")
    .bind(itemId)
    .run();
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
// (resolveVictory / resolveDeath / resolveFlee-fail).
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

// ───── Notifications ───────────────────────────────────────────────────────
// Generic per-user message queue. Kind-discriminated payload; client renders
// based on `kind`. Read-and-clear semantics — listNotifications + delete
// usually run as a pair.

export type NotificationKind = "item_received";

export interface NotificationRow {
  id: number;
  user_id: string;
  kind: NotificationKind;
  payload: unknown;       // JSON-decoded shape varies per kind
  created_at: number;
}

export async function insertNotification(
  db: D1Database,
  userId: string,
  kind: NotificationKind,
  payload: unknown,
): Promise<void> {
  await db
    .prepare(`INSERT INTO notifications (user_id, kind, payload, created_at) VALUES (?, ?, ?, ?)`)
    .bind(userId, kind, JSON.stringify(payload), Date.now())
    .run();
}

// Fetch all pending notifications for a user and delete them in one batch.
// Not strictly atomic in D1 (no transaction across statements), but the
// race window is tiny and the worst case is "user sees a toast twice" or
// "user misses a toast that arrived between SELECT and DELETE" — both
// acceptable. The DELETE bound to the SELECTed ids prevents losing
// brand-new rows that landed after the SELECT.
export async function fetchAndClearNotifications(
  db: D1Database,
  userId: string,
  limit = 25,
): Promise<NotificationRow[]> {
  const rows = await db
    .prepare(
      `SELECT id, user_id, kind, payload, created_at
       FROM notifications WHERE user_id = ?
       ORDER BY created_at ASC LIMIT ?`,
    )
    .bind(userId, limit)
    .all<{ id: number; user_id: string; kind: string; payload: string; created_at: number }>();
  const results = rows.results ?? [];
  if (results.length === 0) return [];
  const ids = results.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");
  await db
    .prepare(`DELETE FROM notifications WHERE id IN (${placeholders})`)
    .bind(...ids)
    .run();
  return results.map((r) => ({
    id: r.id,
    user_id: r.user_id,
    kind: r.kind as NotificationKind,
    payload: JSON.parse(r.payload),
    created_at: r.created_at,
  }));
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
  by_variant: { standard: number; boss: number; gauntlet: number; tower: number };
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
    by_variant: { standard: 0, boss: 0, gauntlet: 0, tower: 0 },
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
    if (v === "standard" || v === "boss" || v === "gauntlet" || v === "tower") {
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
         AND action IN ('attack','cast','signature','ability','tool','scroll','heal','shield','revive','death')`,
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
         AND action IN ('attack', 'cast', 'signature', 'ability', 'tool', 'scroll', 'heal', 'shield')`,
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
// Extracts:
//   • top-level monster_name (always — the only-foe / final wave / boss)
//   • gauntlet: every queued wave's name from upcoming_waves
//
// Deduped, ordered most-recent-first. Caller can slice however many they want
// to feed into the prompt's avoid-list. `questLimit` is QUESTS scanned, not
// names returned — a single gauntlet yields a handful of names.
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
  const effectivePower = applyPotency(item.power, item.potency_stacks ?? 0);
  const newHp = Math.min(character.max_hp, character.hp + effectivePower);
  const healed = newHp - character.hp;
  await db.batch([
    db.prepare("UPDATE characters SET hp = ?, last_active = ? WHERE slack_user_id = ?")
      .bind(newHp, Date.now(), character.slack_user_id),
    db.prepare("DELETE FROM inventory WHERE id = ?").bind(item.id),
  ]);
  return healed;
}

// Returns the N most-recently-active character names. Used to supply an
// avoid-list when AI generates a new character name so names don't repeat.
export async function getRecentCharacterNames(
  db: D1Database,
  limit: number = 20,
): Promise<string[]> {
  const rows = await db
    .prepare("SELECT name FROM characters ORDER BY last_active DESC LIMIT ?")
    .bind(limit)
    .all<{ name: string }>();
  return (rows.results ?? []).map((r) => r.name);
}

// Perma-death. quests.created_by uses ON DELETE SET NULL (see 0002 migration), so
// historical quests survive their creator. Inventory + quest_party cascade as expected.
export async function deleteCharacter(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM characters WHERE slack_user_id = ?").bind(userId).run();
}

// === Shared (per-user) camp state =========================================
// The camp tables (gathering_tasks, camp_upgrades, forage_games, fish_games)
// FK to characters(slack_user_id) ON DELETE CASCADE, and several columns on
// the characters row itself (stock timestamps + lifetime camp counters) also
// belong to "the player", not "this one hero". When the user switches slots,
// rerolls, or rolls a new slot, deleteCharacter() blows all of that away.
// Capture-and-reapply around any characters-row replacement so the camp is
// preserved as a per-user feature.
//
// Excluded on purpose: pub_errands/pub_trust + errands_* counters. Pub trust
// is per-(character, patron) by design and is not part of the "shared camp".

interface GatheringTaskSnapshotRow {
  id: number;
  node: string;
  tier: string;
  worker_slot: number;
  started_at: number;
  expires_at: number;
  yield_json: string | null;
  claimed_at: number | null;
  modifiers_json: string | null;
}
interface CampUpgradeSnapshotRow {
  upgrade_key: string;
  built_at: number;
}
interface ForageGameSnapshotRow {
  grid_json: string;
  revealed_json: string;
  hp_taken: number;
  flips_total: number;
  started_at: number;
}
interface FishGameSnapshotRow {
  phase: string;
  cast_at: number;
  bite_at_ms: number;
  reaction_ms: number | null;
  quality_score: number | null;
  bite_window_ms: number;
}

export interface SharedCampSnapshot {
  mine_stock_full_at: number | null;
  forage_stock_full_at: number | null;
  fish_stock_full_at: number | null;
  camp_ore_mined: number;
  camp_herbs_foraged: number;
  camp_fish_caught: number;
  camp_deep_claimed: number;
  smithy_crafts: number;
  mine_rich_hits: number;
  forage_rare_finds: number;
  fish_best_ms: number;
  fish_plays: number;
  last_gather_claimed_at: number | null;
  gathering_tasks: GatheringTaskSnapshotRow[];
  camp_upgrades: CampUpgradeSnapshotRow[];
  forage_game: ForageGameSnapshotRow | null;
  fish_game: FishGameSnapshotRow | null;
}

const EMPTY_CAMP_SNAPSHOT: SharedCampSnapshot = {
  mine_stock_full_at: null,
  forage_stock_full_at: null,
  fish_stock_full_at: null,
  camp_ore_mined: 0,
  camp_herbs_foraged: 0,
  camp_fish_caught: 0,
  camp_deep_claimed: 0,
  smithy_crafts: 0,
  mine_rich_hits: 0,
  forage_rare_finds: 0,
  fish_best_ms: 0,
  fish_plays: 0,
  last_gather_claimed_at: null,
  gathering_tasks: [],
  camp_upgrades: [],
  forage_game: null,
  fish_game: null,
};

export async function captureSharedCampState(
  db: D1Database,
  userId: string,
): Promise<SharedCampSnapshot> {
  const [charRow, tasksRes, upgradesRes, forageRow, fishRow] = await Promise.all([
    db
      .prepare(
        `SELECT mine_stock_full_at, forage_stock_full_at, fish_stock_full_at,
                camp_ore_mined, camp_herbs_foraged, camp_fish_caught, camp_deep_claimed,
                smithy_crafts, mine_rich_hits, forage_rare_finds, fish_best_ms,
                fish_plays, last_gather_claimed_at
         FROM characters WHERE slack_user_id = ?`,
      )
      .bind(userId)
      .first<Omit<SharedCampSnapshot, "gathering_tasks" | "camp_upgrades" | "forage_game" | "fish_game">>(),
    db
      .prepare(
        `SELECT id, node, tier, worker_slot, started_at, expires_at,
                yield_json, claimed_at, modifiers_json
         FROM gathering_tasks WHERE character_id = ?`,
      )
      .bind(userId)
      .all<GatheringTaskSnapshotRow>(),
    db
      .prepare(`SELECT upgrade_key, built_at FROM camp_upgrades WHERE character_id = ?`)
      .bind(userId)
      .all<CampUpgradeSnapshotRow>(),
    db
      .prepare(
        `SELECT grid_json, revealed_json, hp_taken, flips_total, started_at
         FROM forage_games WHERE character_id = ?`,
      )
      .bind(userId)
      .first<ForageGameSnapshotRow>(),
    db
      .prepare(
        `SELECT phase, cast_at, bite_at_ms, reaction_ms, quality_score, bite_window_ms
         FROM fish_games WHERE character_id = ?`,
      )
      .bind(userId)
      .first<FishGameSnapshotRow>(),
  ]);
  if (!charRow) return EMPTY_CAMP_SNAPSHOT;
  return {
    ...charRow,
    gathering_tasks: tasksRes.results ?? [],
    camp_upgrades: upgradesRes.results ?? [],
    forage_game: forageRow ?? null,
    fish_game: fishRow ?? null,
  };
}

// Reapply a captured snapshot onto the (just-recreated) characters row for
// the same userId. Safe to call with an empty snapshot — the UPDATE writes
// the DB defaults back into place.
export async function applySharedCampState(
  db: D1Database,
  userId: string,
  snap: SharedCampSnapshot,
): Promise<void> {
  await db
    .prepare(
      `UPDATE characters SET
         mine_stock_full_at = ?, forage_stock_full_at = ?, fish_stock_full_at = ?,
         camp_ore_mined = ?, camp_herbs_foraged = ?, camp_fish_caught = ?,
         camp_deep_claimed = ?, smithy_crafts = ?, mine_rich_hits = ?,
         forage_rare_finds = ?, fish_best_ms = ?, fish_plays = ?,
         last_gather_claimed_at = ?
       WHERE slack_user_id = ?`,
    )
    .bind(
      snap.mine_stock_full_at, snap.forage_stock_full_at, snap.fish_stock_full_at,
      snap.camp_ore_mined, snap.camp_herbs_foraged, snap.camp_fish_caught,
      snap.camp_deep_claimed, snap.smithy_crafts, snap.mine_rich_hits,
      snap.forage_rare_finds, snap.fish_best_ms, snap.fish_plays,
      snap.last_gather_claimed_at, userId,
    )
    .run();

  for (const t of snap.gathering_tasks) {
    await db
      .prepare(
        `INSERT INTO gathering_tasks
           (id, character_id, node, tier, worker_slot, started_at, expires_at,
            yield_json, claimed_at, modifiers_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        t.id, userId, t.node, t.tier, t.worker_slot, t.started_at, t.expires_at,
        t.yield_json, t.claimed_at, t.modifiers_json,
      )
      .run();
  }
  for (const u of snap.camp_upgrades) {
    await db
      .prepare(`INSERT INTO camp_upgrades (character_id, upgrade_key, built_at) VALUES (?, ?, ?)`)
      .bind(userId, u.upgrade_key, u.built_at)
      .run();
  }
  if (snap.forage_game) {
    const g = snap.forage_game;
    await db
      .prepare(
        `INSERT INTO forage_games
           (character_id, grid_json, revealed_json, hp_taken, flips_total, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(userId, g.grid_json, g.revealed_json, g.hp_taken, g.flips_total, g.started_at)
      .run();
  }
  if (snap.fish_game) {
    const g = snap.fish_game;
    await db
      .prepare(
        `INSERT INTO fish_games
           (character_id, phase, cast_at, bite_at_ms, reaction_ms, quality_score, bite_window_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(userId, g.phase, g.cast_at, g.bite_at_ms, g.reaction_ms, g.quality_score, g.bite_window_ms)
      .run();
  }
}

// === Multi-character slots (web only) =====================================
// The "active" character lives in the `characters` table as before — one row
// per slack_user_id. Up to two additional saved builds are stashed as JSON
// snapshots in `character_slots`. Switching slots = snapshot current active,
// then restore the target snapshot in its place.

export interface CharacterSlotSummary {
  slot: number;
  name: string;
  class: string;
  level: number;
  gender: CharGender | null;
  saved_at: number;
}

export interface CharacterSlotsView {
  // Slot (1-3) currently held by the live `characters` row, if any.
  active_slot: number | null;
  // Saved (inactive) builds. At most 2 entries — the active character holds
  // the third slot.
  saved: CharacterSlotSummary[];
}

interface CharacterSlotRow {
  slot: number;
  name: string;
  class: string;
  level: number;
  gender: string | null;
  character_json: string;
  inventory_json: string;
  saved_at: number;
}

export async function listCharacterSlots(
  db: D1Database,
  userId: string,
): Promise<CharacterSlotsView> {
  const [active, slotsRes] = await Promise.all([
    db.prepare("SELECT active_slot FROM characters WHERE slack_user_id = ?")
      .bind(userId)
      .first<{ active_slot: number }>(),
    db.prepare(
      "SELECT slot, name, class, level, gender, saved_at FROM character_slots WHERE slack_user_id = ? ORDER BY slot ASC",
    )
      .bind(userId)
      .all<{ slot: number; name: string; class: string; level: number; gender: string | null; saved_at: number }>(),
  ]);
  return {
    active_slot: active?.active_slot ?? null,
    saved: (slotsRes.results ?? []).map((r) => ({
      slot: r.slot,
      name: r.name,
      class: r.class,
      level: r.level,
      gender: (r.gender as CharGender | null) ?? null,
      saved_at: r.saved_at,
    })),
  };
}

// Serializes a character + its inventory into a slot. Used right before
// activating another slot (to preserve the build you're leaving) and when
// creating a new character into an empty slot (to preserve the current one).
async function snapshotActiveToSlot(
  db: D1Database,
  userId: string,
  slot: number,
): Promise<void> {
  const character = await getCharacter(db, userId);
  if (!character) throw new Error("snapshotActiveToSlot: no active character");
  const inventory = await getInventory(db, userId);
  await db
    .prepare(
      `INSERT OR REPLACE INTO character_slots
       (slack_user_id, slot, name, class, level, gender, character_json, inventory_json, saved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      userId,
      slot,
      character.name,
      character.class,
      character.level,
      character.gender,
      JSON.stringify(character),
      JSON.stringify(inventory),
      Date.now(),
    )
    .run();
}

// Writes a Character + Item[] back into the live tables, replacing whatever
// was there. Called by activateSlot after the prior active was snapshotted.
async function restoreSnapshot(
  db: D1Database,
  userId: string,
  slackTeamId: string,
  character: Character,
  inventory: Item[],
  activeSlot: number,
): Promise<void> {
  // Camp is per-user; survive the cascade so tents/gathers/stock/counters
  // persist into the freshly-restored hero. Reapplied after the INSERT below.
  const camp = await captureSharedCampState(db, userId);
  await deleteCharacter(db, userId); // cascades inventory + camp tables
  // keys_bronze/silver/gold are intentionally omitted from the column list —
  // the columns still exist (per the live migrations) but the dungeon system
  // that consumed them was retired, so we let the DB defaults (0) take.
  await db
    .prepare(
      `INSERT INTO characters (
        slack_user_id, slack_team_id, name, class, level, xp, hp, max_hp, mana, max_mana, shield, gold,
        str, int_stat, vit, agi, dex, unspent_points,
        scars, downed_until, last_rest_at, last_long_rest_at, position,
        effects, gender, drink_buff_json, slack_username,
        achievements, pending_achievements,
        apothecary_purchases, revives_given,
        created_at, last_active,
        notification_pref, hired_merc_id,
        tower_floors_climbed, tower_kills, tower_best_floor,
        active_slot
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?,
        ?, ?,
        ?, ?,
        ?, ?, ?,
        ?
      )`,
    )
    .bind(
      userId, slackTeamId, character.name, character.class, character.level, character.xp,
      character.hp, character.max_hp, character.mana, character.max_mana, character.shield, character.gold,
      character.str, character.int_stat, character.vit, character.agi, character.dex, character.unspent_points,
      JSON.stringify(character.scars ?? []), character.downed_until ?? null,
      character.last_rest_at ?? null, character.last_long_rest_at ?? null, character.position,
      JSON.stringify(character.effects ?? []), character.gender,
      character.drink_buff ? JSON.stringify(character.drink_buff) : null, character.slack_username,
      JSON.stringify(character.achievements ?? []), JSON.stringify(character.pending_achievements ?? []),
      character.apothecary_purchases, character.revives_given,
      character.created_at, Date.now(),
      character.notification_pref, character.hired_merc_id,
      character.tower_floors_climbed, character.tower_kills, character.tower_best_floor,
      activeSlot,
    )
    .run();
  // Re-insert inventory with fresh autoincrement ids. character_id is bound to
  // the owner (slack_user_id) — never trusted from the saved blob.
  for (const item of inventory) {
    await db
      .prepare(
        `INSERT INTO inventory (
          character_id, item_name, item_type, power, rarity, flavor, qty, equipped,
          weapon_range, sharpens_count, slot, stat_bonus, item_subtype, level_req, element, potency_stacks,
          item_level, affixes, unique_id, set_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        userId, item.item_name, item.item_type, item.power, item.rarity, item.flavor,
        item.qty ?? 1,
        item.equipped ? 1 : 0, item.weapon_range, item.sharpens_count ?? 0,
        item.slot, item.stat_bonus ? JSON.stringify(item.stat_bonus) : null,
        item.item_subtype, item.level_req ?? 1, item.element ?? null,
        item.potency_stacks ?? 0,
        item.item_level ?? item.power,
        item.affixes && item.affixes.length > 0 ? JSON.stringify(item.affixes) : null,
        item.unique_id ?? null, item.set_id ?? null,
      )
      .run();
  }
  await applySharedCampState(db, userId, camp);
}

// Snapshot the live character into its current slot, then restore the target
// slot's snapshot in its place. No-ops if target_slot is already active.
// Throws if no character is active, or the target slot is empty.
export async function activateCharacterSlot(
  db: D1Database,
  userId: string,
  targetSlot: number,
): Promise<void> {
  const current = await getCharacter(db, userId);
  if (!current) throw new Error("no_active_character");
  if (current.active_slot === targetSlot) return;
  const targetRow = await db
    .prepare(
      "SELECT slot, name, class, level, gender, character_json, inventory_json, saved_at FROM character_slots WHERE slack_user_id = ? AND slot = ?",
    )
    .bind(userId, targetSlot)
    .first<CharacterSlotRow>();
  if (!targetRow) throw new Error("slot_empty");
  const targetChar = JSON.parse(targetRow.character_json) as Character;
  const targetInv = JSON.parse(targetRow.inventory_json) as Item[];

  await snapshotActiveToSlot(db, userId, current.active_slot);
  await db
    .prepare("DELETE FROM character_slots WHERE slack_user_id = ? AND slot = ?")
    .bind(userId, targetSlot)
    .run();
  await restoreSnapshot(db, userId, current.slack_team_id, targetChar, targetInv, targetSlot);
}

// Stash the current active into its slot so the caller can then create a fresh
// character into `targetSlot`. Returns the slot the prior active was saved to.
// Throws if no active character exists, or targetSlot is already occupied
// (either by the active character or an existing snapshot).
export async function reserveSlotForNewCharacter(
  db: D1Database,
  userId: string,
  targetSlot: number,
): Promise<{ prior_slot: number; camp: SharedCampSnapshot }> {
  if (targetSlot < 1 || targetSlot > 3) throw new Error("bad_slot");
  const current = await getCharacter(db, userId);
  if (!current) throw new Error("no_active_character");
  if (current.active_slot === targetSlot) throw new Error("slot_occupied");
  const existing = await db
    .prepare("SELECT 1 FROM character_slots WHERE slack_user_id = ? AND slot = ?")
    .bind(userId, targetSlot)
    .first<{ "1": number }>();
  if (existing) throw new Error("slot_occupied");
  const priorSlot = current.active_slot;
  await snapshotActiveToSlot(db, userId, priorSlot);
  // Hand the camp snapshot back to the caller so it can be reapplied after
  // the new character row is inserted via createCharacter().
  const camp = await captureSharedCampState(db, userId);
  await deleteCharacter(db, userId);
  return { prior_slot: priorSlot, camp };
}

// Set the active_slot column. Used right after createCharacter so a freshly
// rolled character into slot N reports its slot identity correctly.
export async function setActiveSlot(
  db: D1Database,
  userId: string,
  slot: number,
): Promise<void> {
  await db
    .prepare("UPDATE characters SET active_slot = ? WHERE slack_user_id = ?")
    .bind(slot, userId)
    .run();
}

// Permanent delete of a saved (inactive) slot. Cannot remove the active slot —
// use rerollCharacter for that.
export async function deleteCharacterSlot(
  db: D1Database,
  userId: string,
  slot: number,
): Promise<void> {
  await db
    .prepare("DELETE FROM character_slots WHERE slack_user_id = ? AND slot = ?")
    .bind(userId, slot)
    .run();
}

// Find the most recent *public* active quest in a channel (used by /dnd join
// and the web dashboard's joinable-quest poll). Private hunts are filtered
// out so they don't broadcast a "joinable" toast/ping to other players.
export async function getActiveQuestInChannel(
  db: D1Database,
  channelId: string,
): Promise<ActiveQuest | null> {
  const row = await db
    .prepare(
      `SELECT id, channel_id, thread_ts, elite, scene_json, mode, battlefield_ts, joinable_ts, created_by
       FROM quests
       WHERE channel_id = ? AND status = 'active' AND is_private = 0
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
    created_by: row.created_by,
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
  since?: number, // Unix ms — when provided, only games resolved after this time are counted
): Promise<PubLeaderboardEntry[]> {
  const sinceClause = since != null ? `AND resolved_at >= ${since}` : "";
  // Pull the three event sources in parallel. Each query already filters
  // to resolved/done status so we don't have to dance around in-flight
  // matches. SPD bets join their match to pull winner_user_id +
  // channel_id for the gating + payout logic.
  const [liarsRows, spdMatchRows, spdBetRows] = await Promise.all([
    db.prepare(
      `SELECT user_id, stake, payout, outcome
         FROM liars_rounds
        WHERE channel_id = ? AND status = 'resolved' ${sinceClause}`,
    ).bind(channelId).all<{ user_id: string; stake: number; payout: number | null; outcome: string }>(),
    db.prepare(
      `SELECT initiator_user_id, challenger_user_id, initiator_stake, winner_user_id, house_bump
         FROM spd_matches
        WHERE channel_id = ? AND status = 'done' ${sinceClause}`,
    ).bind(channelId).all<{
      initiator_user_id: string; challenger_user_id: string | null;
      initiator_stake: number; winner_user_id: string | null; house_bump: number | null;
    }>(),
    db.prepare(
      `SELECT b.bettor_user_id, b.side, b.amount, m.winner_user_id, m.initiator_user_id, m.challenger_user_id
         FROM spd_bets b
         JOIN spd_matches m ON m.id = b.match_id
        WHERE m.channel_id = ? AND m.status = 'done' ${sinceClause}`,
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
// Bookkeeping rows (monster turns, victory, death, join) don't.
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
  since?: number, // Unix ms — when provided, only quests completed after this time are counted
): Promise<QuestLeaderboardEntry[]> {
  const sinceClause = since != null ? `AND q.completed_at >= ${since}` : "";
  const rows = await db
    .prepare(
      `SELECT c.slack_user_id, c.name, c.slack_username, c.class, c.level,
              COUNT(CASE WHEN q.status = 'completed' ${sinceClause} THEN 1 END) as wins,
              COUNT(CASE WHEN q.status IN ('completed','failed') ${sinceClause} THEN 1 END) as total_quests,
              COUNT(CASE WHEN q.status = 'completed' AND q.elite = 1 ${sinceClause} THEN 1 END) as elite_wins
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

// ─── Lobby system ────────────────────────────────────────────────────────────

export interface LobbyQuest {
  id: number;
  channel_id: string;
  thread_ts: string;
  elite: boolean;
  scene: SceneJson;
  mode: QuestMode;
  created_by: string;
  // For reinforcement lobbies (status=active with pending invitees) this is
  // null — only pre-combat lobbies have an auto-start alarm.
  lobby_expires_at: number | null;
  lobby_ts: string | null;
  // Creator-toggled join lock. When true, new invites/joins are rejected
  // (existing pending invitees can still accept/decline). Independent of
  // status — a locked lobby can still ready up + start.
  locked: boolean;
  // The underlying quest status so LobbyView can distinguish pre-combat
  // (status=lobby) from reinforcement (status=active) flows.
  status: "lobby" | "active" | "completed" | "failed";
}

export interface LobbyPartyMember {
  slack_user_id: string;
  name: string;
  // Slack handle (without the @). Null for synthetic characters with no
  // real Slack presence. Used by the web UI to show "@josh" next to a
  // character display name so you can disambiguate identical names.
  slack_username: string | null;
  // Character level. Surfaced in the lobby roster so party leaders can
  // see "level 10 + level 1" mismatches at a glance.
  level: number;
  // Persisted battle position (front/back). Players can flip this in the
  // lobby before combat starts — it carries straight into the fight's
  // initial fighter state.
  position: "front" | "back";
  invite_status: "pending" | "accepted" | "declined";
  ready: boolean;
}

interface LobbyQuestRow {
  id: number;
  channel_id: string;
  thread_ts: string;
  elite: number;
  scene_json: string;
  mode: string;
  created_by: string;
  lobby_expires_at: number | null;
  lobby_ts: string | null;
  locked: number;
  status: string;
}

function rowToLobbyQuest(row: LobbyQuestRow): LobbyQuest {
  return {
    id: row.id,
    channel_id: row.channel_id,
    thread_ts: row.thread_ts,
    elite: row.elite === 1,
    scene: normalizeScene(JSON.parse(row.scene_json) as SceneJson),
    mode: row.mode === "web" ? "web" : "slack",
    created_by: row.created_by,
    lobby_expires_at: row.lobby_expires_at,
    lobby_ts: row.lobby_ts,
    locked: row.locked === 1,
    status: (row.status as LobbyQuest["status"]) ?? "lobby",
  };
}

// Returns a lobby relevant to the user. Two cases:
//   1. Pre-combat (status='lobby'): user is an invitee (pending/accepted) or
//      the creator.
//   2. Reinforcement (status='active'): EITHER the user is a pending
//      invitee being recruited, OR the user is already an accepted party
//      member on an active quest that has at least one pending invitee —
//      so original members can see/manage the recruitment lobby their
//      creator opened.
// Decline keeps the lobby hidden (users who decline shouldn't be nagged).
// `getLobbyQuestById` returns lobby data for any status; callers decide
// whether to treat status=active as a reinforcement lobby.
export async function getLobbyQuestForCharacter(
  db: D1Database,
  userId: string,
): Promise<LobbyQuest | null> {
  const row = await db
    .prepare(
      `SELECT q.id, q.channel_id, q.thread_ts, q.elite, q.scene_json, q.mode,
              q.created_by, q.lobby_expires_at, q.lobby_ts, q.locked, q.status
       FROM quests q
       JOIN quest_party qp ON qp.quest_id = q.id
       WHERE qp.character_id = ?
         AND qp.invite_status != 'declined'
         AND (
           q.status = 'lobby'
           OR (
             q.status = 'active' AND (
               qp.invite_status = 'pending'
               OR EXISTS (
                 SELECT 1 FROM quest_party qp2
                 WHERE qp2.quest_id = q.id AND qp2.invite_status = 'pending'
               )
             )
           )
         )
       LIMIT 1`,
    )
    .bind(userId)
    .first<LobbyQuestRow>();
  return row ? rowToLobbyQuest(row) : null;
}

export async function getLobbyQuestById(
  db: D1Database,
  questId: number,
): Promise<LobbyQuest | null> {
  const row = await db
    .prepare(
      `SELECT id, channel_id, thread_ts, elite, scene_json, mode,
              created_by, lobby_expires_at, lobby_ts, locked, status
       FROM quests
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(questId)
    .first<LobbyQuestRow>();
  return row ? rowToLobbyQuest(row) : null;
}

export async function getLobbyParty(
  db: D1Database,
  questId: number,
): Promise<LobbyPartyMember[]> {
  const result = await db
    .prepare(
      `SELECT c.slack_user_id, c.name, c.slack_username, c.level, c.position,
              qp.invite_status, qp.ready
       FROM characters c
       JOIN quest_party qp ON qp.character_id = c.slack_user_id
       WHERE qp.quest_id = ?
       ORDER BY qp.joined_at ASC`,
    )
    .bind(questId)
    .all<{
      slack_user_id: string;
      name: string;
      slack_username: string | null;
      level: number;
      position: string;
      invite_status: string;
      ready: number;
    }>();
  return (result.results ?? []).map((r) => ({
    slack_user_id: r.slack_user_id,
    name: r.name,
    slack_username: r.slack_username,
    level: r.level,
    position: (r.position === "back" ? "back" : "front") as "front" | "back",
    invite_status: (r.invite_status ?? "accepted") as LobbyPartyMember["invite_status"],
    ready: r.ready === 1,
  }));
}

export async function addPendingInvitee(
  db: D1Database,
  questId: number,
  userId: string,
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT OR IGNORE INTO quest_party (quest_id, character_id, joined_at, invite_status, ready)
       VALUES (?, ?, ?, 'pending', 0)`,
    )
    .bind(questId, userId, now)
    .run();
}

export async function updateInviteStatus(
  db: D1Database,
  questId: number,
  userId: string,
  status: "accepted" | "declined",
): Promise<void> {
  await db
    .prepare(
      `UPDATE quest_party SET invite_status = ? WHERE quest_id = ? AND character_id = ?`,
    )
    .bind(status, questId, userId)
    .run();
}

export async function updateReadyStatus(
  db: D1Database,
  questId: number,
  userId: string,
  ready: boolean,
): Promise<void> {
  await db
    .prepare(`UPDATE quest_party SET ready = ? WHERE quest_id = ? AND character_id = ?`)
    .bind(ready ? 1 : 0, questId, userId)
    .run();
}

export async function removePendingInvitees(
  db: D1Database,
  questId: number,
): Promise<void> {
  await db
    .prepare(`DELETE FROM quest_party WHERE quest_id = ? AND invite_status = 'pending'`)
    .bind(questId)
    .run();
}

export async function activateQuest(
  db: D1Database,
  questId: number,
): Promise<void> {
  await db
    .prepare(`UPDATE quests SET status = 'active' WHERE id = ?`)
    .bind(questId)
    .run();
}

export async function setLobbyTs(
  db: D1Database,
  questId: number,
  ts: string,
): Promise<void> {
  await db
    .prepare(`UPDATE quests SET lobby_ts = ? WHERE id = ?`)
    .bind(ts, questId)
    .run();
}

// Creator-toggleable join lock. Independent of status — a locked lobby can
// still complete normally (ready up, force start). Invite endpoints check
// this flag and reject new invites when locked.
export async function setQuestLocked(
  db: D1Database,
  questId: number,
  locked: boolean,
): Promise<void> {
  await db
    .prepare(`UPDATE quests SET locked = ? WHERE id = ?`)
    .bind(locked ? 1 : 0, questId)
    .run();
}

// Pre-combat lobby cancel: nuke the quest row and its quest_party rows.
// Caller is responsible for guarding (creator-only, status='lobby').
// Mid-combat reinforcement cancel just drops pending invitees — use
// `removePendingInvitees` for that.
export async function deleteQuestCascade(
  db: D1Database,
  questId: number,
): Promise<void> {
  // No FK cascade defined on quest_party in our schema, so delete explicitly.
  // Order matters only for FKs but doing children-first keeps it tidy.
  await db.batch([
    db.prepare(`DELETE FROM quest_party WHERE quest_id = ?`).bind(questId),
    db.prepare(`DELETE FROM quest_log WHERE quest_id = ?`).bind(questId),
    db.prepare(`DELETE FROM quest_chat WHERE quest_id = ?`).bind(questId),
    db.prepare(`DELETE FROM quests WHERE id = ?`).bind(questId),
  ]);
}

// True iff there's at least one pending invitee. Used to gate the
// reinforcement-lobby UI on the active quest card.
export async function hasPendingInvitees(
  db: D1Database,
  questId: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS one FROM quest_party
       WHERE quest_id = ? AND invite_status = 'pending'
       LIMIT 1`,
    )
    .bind(questId)
    .first<{ one: number }>();
  return !!row;
}

// ─── End lobby system ─────────────────────────────────────────────────────────

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

// ---- Talent tree (migration 0062) ----

interface TalentRow {
  node_id: string;
  rank: number;
}

// Returns the player's owned talent nodes as { node_id: rank }. Empty object
// when they haven't bought anything (or no rows for this character_id).
export async function getCharacterTalents(
  db: D1Database,
  userId: string,
): Promise<Record<string, number>> {
  const rs = await db
    .prepare("SELECT node_id, rank FROM character_talents WHERE character_id = ?")
    .bind(userId)
    .all<TalentRow>();
  const out: Record<string, number> = {};
  for (const row of rs.results ?? []) out[row.node_id] = row.rank;
  return out;
}

export type BuyTalentError =
  | "unknown_node"
  | "wrong_class"
  | "level_too_low"
  | "rank_out_of_range"
  | "rank_not_sequential"
  | "prereq_unmet"
  | "insufficient_points"
  | "no_character";

// Atomically buys the next rank of a node. Validates class match, level req,
// prereqs, and point balance. The DB-level guard (talent_points >= cost) makes
// the spend race-safe under concurrent requests. Returns the updated character
// on success.
export async function buyTalentRank(
  db: D1Database,
  userId: string,
  nodeId: string,
  targetRank: number,
): Promise<{ ok: true; character: Character } | { ok: false; error: BuyTalentError }> {
  const node = findNode(nodeId);
  if (!node) return { ok: false, error: "unknown_node" };
  const character = await getCharacter(db, userId);
  if (!character) return { ok: false, error: "no_character" };
  const classId = classIdForTree(character.class);
  if (classId !== node.class_id) return { ok: false, error: "wrong_class" };
  if (targetRank < 1 || targetRank > node.max_rank) return { ok: false, error: "rank_out_of_range" };
  const owned = await getCharacterTalents(db, userId);
  const currentRank = owned[nodeId] ?? 0;
  if (targetRank !== currentRank + 1) return { ok: false, error: "rank_not_sequential" };
  const levelReq = node.level_req_per_rank[targetRank - 1] ?? 1;
  if (character.level < levelReq) return { ok: false, error: "level_too_low" };
  for (const pr of node.prereq ?? []) {
    if ((owned[pr.node_id] ?? 0) < pr.min_rank) return { ok: false, error: "prereq_unmet" };
  }
  const cost = pointCostForRank(node, targetRank);
  if (character.talent_points < cost) return { ok: false, error: "insufficient_points" };

  const spend = await db
    .prepare("UPDATE characters SET talent_points = talent_points - ? WHERE slack_user_id = ? AND talent_points >= ?")
    .bind(cost, userId, cost)
    .run();
  if (spend.meta.changes === 0) return { ok: false, error: "insufficient_points" };
  await db
    .prepare(
      "INSERT INTO character_talents (character_id, node_id, rank, acquired_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(character_id, node_id) DO UPDATE SET rank = excluded.rank, acquired_at = excluded.acquired_at",
    )
    .bind(userId, nodeId, targetRank, Date.now())
    .run();
  const updated = await getCharacter(db, userId);
  if (!updated) return { ok: false, error: "no_character" };
  return { ok: true, character: updated };
}

// Refunds every spent point, deletes character_talents rows, and resets the
// loadout to the class's starter kit. Charges `goldCost` upfront via an atomic
// DB-level guard so the gold can't go negative under concurrent requests.
export async function respecTalents(
  db: D1Database,
  userId: string,
  goldCost: number,
): Promise<{ ok: true; character: Character } | { ok: false; error: "no_character" | "insufficient_gold" }> {
  const character = await getCharacter(db, userId);
  if (!character) return { ok: false, error: "no_character" };
  const owned = await getCharacterTalents(db, userId);
  const node_ids = Object.keys(owned);
  // Total refund = sum of point_cost_per_rank up to the owned rank for every node.
  let refund = 0;
  for (const id of node_ids) {
    const node = findNode(id);
    if (!node) continue;
    for (let r = 1; r <= owned[id]; r++) refund += pointCostForRank(node, r);
  }
  if (goldCost > 0) {
    const paid = await db
      .prepare("UPDATE characters SET gold = gold - ? WHERE slack_user_id = ? AND gold >= ?")
      .bind(goldCost, userId, goldCost)
      .run();
    if (paid.meta.changes === 0) return { ok: false, error: "insufficient_gold" };
  }
  const { loadout, seededNodeIds } = buildStarterLoadout(character.class, character.level);
  await db.batch([
    db.prepare("DELETE FROM character_talents WHERE character_id = ?").bind(userId),
    db.prepare("UPDATE characters SET talent_points = talent_points + ?, ability_loadout = ? WHERE slack_user_id = ?")
      .bind(refund, JSON.stringify(loadout), userId),
    ...seededNodeIds.map((id) =>
      db.prepare("INSERT OR IGNORE INTO character_talents (character_id, node_id, rank, acquired_at) VALUES (?, ?, 1, ?)")
        .bind(userId, id, Date.now()),
    ),
  ]);
  const updated = await getCharacter(db, userId);
  if (!updated) return { ok: false, error: "no_character" };
  return { ok: true, character: updated };
}

export type SetLoadoutError =
  | "no_character"
  | "bad_shape"
  | "unowned_node"
  | "wrong_class"
  | "wrong_kind"
  | "wrong_slot_count";

// Validates and writes the loadout JSON. Each non-null id must exist in the
// registry, be owned at rank ≥ 1, match the character's class, and match the
// slot kind (active vs passive). Active slot count is fixed at 4; passive slot
// count derives from level.
export async function setAbilityLoadout(
  db: D1Database,
  userId: string,
  loadout: AbilityLoadout,
): Promise<{ ok: true; character: Character } | { ok: false; error: SetLoadoutError }> {
  if (!loadout || !Array.isArray(loadout.active) || !Array.isArray(loadout.passive)) {
    return { ok: false, error: "bad_shape" };
  }
  const character = await getCharacter(db, userId);
  if (!character) return { ok: false, error: "no_character" };
  if (loadout.active.length !== MAX_ACTIVE_SLOTS) return { ok: false, error: "wrong_slot_count" };
  if (loadout.passive.length !== passiveSlotsForLevel(character.level)) return { ok: false, error: "wrong_slot_count" };
  const classId = classIdForTree(character.class);
  const owned = await getCharacterTalents(db, userId);
  const validateSlot = (id: string | null, kind: "active" | "passive"): SetLoadoutError | null => {
    if (id === null) return null;
    const node: TalentNodeDef | undefined = findNode(id);
    if (!node) return "unowned_node";
    if (node.class_id !== classId) return "wrong_class";
    if (node.ability.kind !== kind) return "wrong_kind";
    if ((owned[id] ?? 0) < 1) return "unowned_node";
    return null;
  };
  for (const id of loadout.active) {
    const err = validateSlot(id, "active");
    if (err) return { ok: false, error: err };
  }
  for (const id of loadout.passive) {
    const err = validateSlot(id, "passive");
    if (err) return { ok: false, error: err };
  }
  await db
    .prepare("UPDATE characters SET ability_loadout = ? WHERE slack_user_id = ?")
    .bind(JSON.stringify(loadout), userId)
    .run();
  const updated = await getCharacter(db, userId);
  if (!updated) return { ok: false, error: "no_character" };
  return { ok: true, character: updated };
}

export async function setHiredMerc(
  db: D1Database,
  userId: string,
  mercId: string,
): Promise<void> {
  await db
    .prepare("UPDATE characters SET hired_merc_id = ? WHERE slack_user_id = ?")
    .bind(mercId, userId)
    .run();
}

export async function clearHiredMerc(
  db: D1Database,
  userId: string,
): Promise<void> {
  await db
    .prepare("UPDATE characters SET hired_merc_id = NULL WHERE slack_user_id = ?")
    .bind(userId)
    .run();
}

export async function clearHiredMercForParty(
  db: D1Database,
  questId: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE characters SET hired_merc_id = NULL
         WHERE slack_user_id IN (SELECT character_id FROM quest_party WHERE quest_id = ?)`,
    )
    .bind(questId)
    .run();
}

// =============================================================================
// CAMP: gathering tasks, resources, recipes, camp upgrades
// =============================================================================

export type CampNode = "mine" | "forage" | "fish";
export type CampTier = "quick" | "standard" | "deep";

// Max apothecary Concentrate stacks per potion. Each stack adds +25% potency.
export const APOTHECARY_POTENCY_CAP = 2;

// Apply potency stacks to an item's base power. Each stack multiplies by 1.25
// (round down). potency_stacks defaults to 0 if absent (legacy items).
export function applyPotency(basePower: number, potencyStacks: number): number {
  if (!potencyStacks) return basePower;
  return Math.floor(basePower * Math.pow(1.25, potencyStacks));
}

// Smithy sharpen cap raised from 3 (gold) to 6 total: first 3 use gold,
// next 3 require ore (Smithy Reinforce). Enforced in worker handlers.
export const SMITHY_SHARPEN_GOLD_CAP = 3;
export const SMITHY_SHARPEN_TOTAL_CAP = 6;

export interface GatheringTaskRow {
  id: number;
  character_id: string;
  node: CampNode;
  tier: CampTier;
  worker_slot: number;
  started_at: number;
  expires_at: number;
  yield_json: string | null;
  claimed_at: number | null;
  modifiers_json: string | null;
}

export interface ResourceYieldEntry {
  name: string;       // inventory item_name, with emoji prefix
  qty: number;
}

export interface GatheringYield {
  resources: ResourceYieldEntry[];
  xp: number;
  gold: number;
  // True when a Deep-tier mine rolled the rare gold-vein strike. Surfaces
  // a different toast headline; the gold amount is already included in `gold`.
  gold_strike?: boolean;
}

// Tent perk modifiers snapshot stored on the row at start time. NO_TENT_MODIFIERS
// when legacy / null. Mirrors TentModifiers from @gantt-quest/core but defined
// locally to keep the db package import-free from core (no circular dep).
export interface PersistedTentModifiers {
  duration_pct: number;
  yield_bonus: number;
  rare_bonus_pct: number;
}

export interface GatheringTask extends Omit<GatheringTaskRow, "yield_json" | "modifiers_json"> {
  yield: GatheringYield | null;
  modifiers: PersistedTentModifiers | null;
}

function rowToGatheringTask(row: GatheringTaskRow): GatheringTask {
  return {
    ...row,
    yield: row.yield_json ? (JSON.parse(row.yield_json) as GatheringYield) : null,
    modifiers: row.modifiers_json
      ? (JSON.parse(row.modifiers_json) as PersistedTentModifiers)
      : null,
  };
}

// Active (unclaimed) tasks for a character, oldest first.
export async function listActiveGatheringTasks(
  db: D1Database,
  characterId: string,
): Promise<GatheringTask[]> {
  const result = await db
    .prepare(
      `SELECT * FROM gathering_tasks
        WHERE character_id = ? AND claimed_at IS NULL
        ORDER BY expires_at ASC, id ASC`,
    )
    .bind(characterId)
    .all<GatheringTaskRow>();
  return (result.results ?? []).map(rowToGatheringTask);
}

export async function getGatheringTask(
  db: D1Database,
  taskId: number,
  characterId: string,
): Promise<GatheringTask | null> {
  const row = await db
    .prepare("SELECT * FROM gathering_tasks WHERE id = ? AND character_id = ?")
    .bind(taskId, characterId)
    .first<GatheringTaskRow>();
  return row ? rowToGatheringTask(row) : null;
}

export async function startGatheringTask(
  db: D1Database,
  args: {
    character_id: string;
    node: CampNode;
    tier: CampTier;
    worker_slot: number;
    duration_ms: number;
    modifiers?: PersistedTentModifiers | null;
  },
): Promise<GatheringTask> {
  const now = Date.now();
  const result = await db
    .prepare(
      `INSERT INTO gathering_tasks (character_id, node, tier, worker_slot, started_at, expires_at, modifiers_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      args.character_id,
      args.node,
      args.tier,
      args.worker_slot,
      now,
      now + args.duration_ms,
      args.modifiers ? JSON.stringify(args.modifiers) : null,
    )
    .run();
  const id = result.meta.last_row_id;
  const row = await getGatheringTask(db, Number(id), args.character_id);
  if (!row) throw new Error("Failed to read back gathering task");
  return row;
}

// Persist a rolled yield to the task. Conditional on yield_json IS NULL so two
// concurrent status fetches can't double-roll — the loser's write is dropped
// and they re-read the winner's value.
export async function tryWriteGatheringYield(
  db: D1Database,
  taskId: number,
  yieldData: GatheringYield,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE gathering_tasks SET yield_json = ? WHERE id = ? AND yield_json IS NULL",
    )
    .bind(JSON.stringify(yieldData), taskId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function markGatheringTaskClaimed(
  db: D1Database,
  taskId: number,
  characterId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE gathering_tasks SET claimed_at = ?
        WHERE id = ? AND character_id = ? AND claimed_at IS NULL`,
    )
    .bind(Date.now(), taskId, characterId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// Post-claim bookkeeping for the camp achievement set + rested bonus.
// All deltas are applied in one UPDATE so a single claim is atomic.
// Pass `record_main_claim` true only when the claimed task ran on the
// player's main (worker_slot === 1) — that's what drives the rested
// bonus timer; hired-worker claims don't reset it.
export async function bumpCampClaimStats(
  db: D1Database,
  userId: string,
  deltas: {
    ore?: number;
    herbs?: number;
    fish?: number;
    deep?: number;
  },
  recordMainClaim: boolean,
): Promise<void> {
  const ore = Math.max(0, deltas.ore ?? 0);
  const herbs = Math.max(0, deltas.herbs ?? 0);
  const fish = Math.max(0, deltas.fish ?? 0);
  const deep = Math.max(0, deltas.deep ?? 0);
  const now = Date.now();
  if (recordMainClaim) {
    await db
      .prepare(
        `UPDATE characters
            SET camp_ore_mined        = camp_ore_mined        + ?,
                camp_herbs_foraged    = camp_herbs_foraged    + ?,
                camp_fish_caught      = camp_fish_caught      + ?,
                camp_deep_claimed     = camp_deep_claimed     + ?,
                last_gather_claimed_at = ?
          WHERE slack_user_id = ?`,
      )
      .bind(ore, herbs, fish, deep, now, userId)
      .run();
  } else {
    await db
      .prepare(
        `UPDATE characters
            SET camp_ore_mined        = camp_ore_mined        + ?,
                camp_herbs_foraged    = camp_herbs_foraged    + ?,
                camp_fish_caught      = camp_fish_caught      + ?,
                camp_deep_claimed     = camp_deep_claimed     + ?
          WHERE slack_user_id = ?`,
      )
      .bind(ore, herbs, fish, deep, userId)
      .run();
  }
}

// ── Foraging mini-game DB helpers ──────────────────────────────────────────

export interface ForageGameRow {
  character_id: string;
  grid_json: string;
  revealed_json: string;
  hp_taken: number;
  flips_total: number;
  started_at: number;
}

export async function getForageGame(
  db: D1Database,
  characterId: string,
): Promise<ForageGameRow | null> {
  return await db
    .prepare("SELECT * FROM forage_games WHERE character_id = ?")
    .bind(characterId)
    .first<ForageGameRow>();
}

export async function startForageGame(
  db: D1Database,
  characterId: string,
  gridJson: string,
  flipsTotal: number,
): Promise<void> {
  // INSERT OR REPLACE wipes any abandoned prior game cleanly.
  await db
    .prepare(
      `INSERT OR REPLACE INTO forage_games
       (character_id, grid_json, revealed_json, hp_taken, flips_total, started_at)
       VALUES (?, ?, '[]', 0, ?, ?)`,
    )
    .bind(characterId, gridJson, flipsTotal, Date.now())
    .run();
}

export async function updateForageGame(
  db: D1Database,
  characterId: string,
  revealedJson: string,
  hpTaken: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE forage_games SET revealed_json = ?, hp_taken = ? WHERE character_id = ?`,
    )
    .bind(revealedJson, hpTaken, characterId)
    .run();
}

export async function deleteForageGame(
  db: D1Database,
  characterId: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM forage_games WHERE character_id = ?")
    .bind(characterId)
    .run();
}

// ── Fishing mini-game DB helpers ───────────────────────────────────────────

export interface FishGameRow {
  character_id: string;
  phase: "waiting" | "reeling";
  cast_at: number;
  bite_at_ms: number;
  reaction_ms: number | null;
  quality_score: number | null;
  bite_window_ms: number;
}

export async function getFishGame(
  db: D1Database,
  characterId: string,
): Promise<FishGameRow | null> {
  return await db
    .prepare("SELECT * FROM fish_games WHERE character_id = ?")
    .bind(characterId)
    .first<FishGameRow>();
}

export async function startFishGame(
  db: D1Database,
  characterId: string,
  castAt: number,
  biteAtMs: number,
  biteWindowMs: number,
): Promise<void> {
  // INSERT OR REPLACE clears any stale prior game.
  await db
    .prepare(
      `INSERT OR REPLACE INTO fish_games
       (character_id, phase, cast_at, bite_at_ms, reaction_ms, quality_score, bite_window_ms)
       VALUES (?, 'waiting', ?, ?, NULL, NULL, ?)`,
    )
    .bind(characterId, castAt, biteAtMs, biteWindowMs)
    .run();
}

export async function recordFishStrike(
  db: D1Database,
  characterId: string,
  reactionMs: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE fish_games SET phase = 'reeling', reaction_ms = ? WHERE character_id = ?`,
    )
    .bind(reactionMs, characterId)
    .run();
}

export async function deleteFishGame(
  db: D1Database,
  characterId: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM fish_games WHERE character_id = ?")
    .bind(characterId)
    .run();
}

// Increment lifetime fishing plays — drives the >=5 plays gate on the
// Fastest Hook leaderboard. Called once at /finish per Quick Cast.
export async function bumpFishPlays(
  db: D1Database,
  userId: string,
): Promise<void> {
  await db
    .prepare("UPDATE characters SET fish_plays = fish_plays + 1 WHERE slack_user_id = ?")
    .bind(userId)
    .run();
}

// Best-reaction-time tracker. Updates fish_best_ms only when the new value
// is faster than the current best (or when fish_best_ms is 0 = no prior catch).
export async function updateFishBestMs(
  db: D1Database,
  userId: string,
  reactionMs: number,
): Promise<void> {
  if (reactionMs <= 0) return;
  await db
    .prepare(
      `UPDATE characters
          SET fish_best_ms = ?
        WHERE slack_user_id = ?
          AND (fish_best_ms = 0 OR fish_best_ms > ?)`,
    )
    .bind(reactionMs, userId, reactionMs)
    .run();
}

// Atomic increment for "Flawless Forages" — plays where every revealed cell
// was an herb or landmark (zero hazards). Repurposes forage_rare_finds since
// nightbloom is deep-tier-only.
export async function bumpForageFlawless(
  db: D1Database,
  userId: string,
  delta: number,
): Promise<void> {
  if (delta <= 0) return;
  await db
    .prepare("UPDATE characters SET forage_rare_finds = forage_rare_finds + ? WHERE slack_user_id = ?")
    .bind(delta, userId)
    .run();
}

// Atomic increment for mining mini-game rich-vein strikes. Drives the
// "Veins Struck" row on the Harvest Hall leaderboard.
export async function bumpMineRichHits(
  db: D1Database,
  userId: string,
  delta: number,
): Promise<void> {
  if (delta <= 0) return;
  await db
    .prepare("UPDATE characters SET mine_rich_hits = mine_rich_hits + ? WHERE slack_user_id = ?")
    .bind(delta, userId)
    .run();
}

// Atomic increment for the smithy craft counter. Called once per
// successful runRecipe() with station === "smithy".
export async function bumpSmithyCrafts(
  db: D1Database,
  userId: string,
): Promise<void> {
  await db
    .prepare("UPDATE characters SET smithy_crafts = smithy_crafts + 1 WHERE slack_user_id = ?")
    .bind(userId)
    .run();
}

// Atomic increment for an errand completion. Sets both the overall
// counter and the per-kind/per-tier counter in one statement so the
// achievement check sees consistent state.
export async function bumpErrandStats(
  db: D1Database,
  userId: string,
  kind: "courier" | "procure" | "investigate" | "mercy" | "rare",
  tier: "short" | "medium" | "long",
): Promise<void> {
  const kindCol = {
    courier: "errands_courier",
    procure: "errands_procure",
    investigate: "errands_investigate",
    mercy: "errands_mercy",
    rare: null,
  }[kind];
  const tierCol = tier === "long" ? "errands_long" : null;
  // Always bump the total; conditionally bump the kind/tier counter.
  // Built as a dynamic column list because D1 doesn't support CASE
  // updates that touch different columns in one statement cleanly.
  const cols = ["errands_completed = errands_completed + 1"];
  if (kindCol) cols.push(`${kindCol} = ${kindCol} + 1`);
  if (tierCol) cols.push(`${tierCol} = ${tierCol} + 1`);
  await db
    .prepare(`UPDATE characters SET ${cols.join(", ")} WHERE slack_user_id = ?`)
    .bind(userId)
    .run();
}

// Cancel an unclaimed gathering task. Used when the player wants to free
// up their worker slot — e.g. to go on a hunt that's currently blocked
// because their main character is gathering. No yield is rolled and no
// resources/XP are awarded; the row is removed so the slot opens.
// Returns true if a row was actually deleted.
export async function cancelGatheringTask(
  db: D1Database,
  taskId: number,
  characterId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM gathering_tasks
         WHERE id = ? AND character_id = ? AND claimed_at IS NULL`,
    )
    .bind(taskId, characterId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// Resource upsert. Resources stack by (character_id, item_name) — increment qty
// when a row already exists, otherwise insert a fresh resource row.
export async function addResource(
  db: D1Database,
  characterId: string,
  itemName: string,
  qty: number,
  rarity: Rarity = "common",
  flavor = "",
): Promise<void> {
  if (qty <= 0) return;
  const existing = await db
    .prepare(
      "SELECT id FROM inventory WHERE character_id = ? AND item_name = ? AND item_type = 'resource' LIMIT 1",
    )
    .bind(characterId, itemName)
    .first<{ id: number }>();
  if (existing) {
    await db
      .prepare("UPDATE inventory SET qty = qty + ? WHERE id = ?")
      .bind(qty, existing.id)
      .run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO inventory
       (character_id, item_name, item_type, power, rarity, flavor, qty, equipped, weapon_range, slot, stat_bonus, item_subtype, level_req, element)
       VALUES (?, ?, 'resource', 0, ?, ?, ?, 0, NULL, NULL, NULL, NULL, 1, NULL)`,
    )
    .bind(characterId, itemName, rarity, flavor, qty)
    .run();
}

// Atomically deducts qty from a resource row. Returns true if the row had
// enough; false otherwise (nothing deducted). Used by craft / brew handlers
// to consume recipe inputs without going negative under concurrent requests.
export async function tryConsumeResource(
  db: D1Database,
  characterId: string,
  itemName: string,
  qty: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE inventory SET qty = qty - ?
        WHERE character_id = ? AND item_name = ? AND item_type = 'resource' AND qty >= ?`,
    )
    .bind(qty, characterId, itemName, qty)
    .run();
  if ((result.meta.changes ?? 0) === 0) return false;
  // Delete empty rows so the inventory grid stays tidy.
  await db
    .prepare(
      "DELETE FROM inventory WHERE character_id = ? AND item_name = ? AND item_type = 'resource' AND qty <= 0",
    )
    .bind(characterId, itemName)
    .run();
  return true;
}

export interface CampUpgradeRow {
  upgrade_key: string;
  built_at: number;
}

export async function listCampUpgrades(
  db: D1Database,
  characterId: string,
): Promise<CampUpgradeRow[]> {
  const result = await db
    .prepare("SELECT upgrade_key, built_at FROM camp_upgrades WHERE character_id = ?")
    .bind(characterId)
    .all<CampUpgradeRow>();
  return result.results ?? [];
}

// Atomic upgrade insert. INSERT OR IGNORE so two parallel build clicks won't
// charge twice — the second insert is a no-op and the caller can detect that
// via the returned bool.
export async function tryBuildCampUpgrade(
  db: D1Database,
  characterId: string,
  upgradeKey: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO camp_upgrades (character_id, upgrade_key, built_at)
       VALUES (?, ?, ?)`,
    )
    .bind(characterId, upgradeKey, Date.now())
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// Bumps an inventory item's potency_stacks by 1 (capped at cap). Returns true
// if a stack landed, false if the item was already maxed.
export async function tryAddPotencyStack(
  db: D1Database,
  itemId: number,
  characterId: string,
  cap: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE inventory SET potency_stacks = potency_stacks + 1
        WHERE id = ? AND character_id = ? AND potency_stacks < ?`,
    )
    .bind(itemId, characterId, cap)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// Bumps sharpens_count by 1 — used by both gold sharpen (caller checks gold
// cap of 3) and ore Reinforce (caller checks total cap of 6). Returns true if
// the row exists; existence is already validated by the caller.
export async function bumpSharpens(
  db: D1Database,
  itemId: number,
  characterId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE inventory SET sharpens_count = sharpens_count + 1, power = power + 1
        WHERE id = ? AND character_id = ?`,
    )
    .bind(itemId, characterId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}


// =============================================================================
// PUB ERRANDS: timed NPC-driven mini-quests
// =============================================================================

export type PubErrandKind = "courier" | "procure" | "investigate" | "mercy" | "rare";
export type PubErrandTier = "short" | "medium" | "long";

export interface PubErrandOfferRow {
  id: number;
  channel_id: string;
  patron_id: string;
  kind: PubErrandKind;
  tier: PubErrandTier;
  generated_at: number;
  taken_by: number | null;
}

export interface PubErrandRow {
  id: number;
  character_id: string;
  patron_id: string;
  kind: PubErrandKind;
  tier: PubErrandTier;
  started_at: number;
  expires_at: number;
  yield_json: string | null;
  claimed_at: number | null;
  cancelled_at: number | null;
  input_resources_json: string | null;
}

export interface PubErrand extends Omit<PubErrandRow, "yield_json" | "input_resources_json"> {
  yield: unknown | null;
  input_resources: Array<{ name: string; qty: number }> | null;
}

function rowToPubErrand(row: PubErrandRow): PubErrand {
  return {
    ...row,
    yield: row.yield_json ? JSON.parse(row.yield_json) : null,
    input_resources: row.input_resources_json
      ? (JSON.parse(row.input_resources_json) as Array<{ name: string; qty: number }>)
      : null,
  };
}

// Fetch live (un-taken) offers in a channel, generated within the restock
// window. Caller checks emptiness to decide whether to regenerate.
export async function getActivePubErrandOffers(
  db: D1Database,
  channelId: string,
  windowMs: number,
): Promise<PubErrandOfferRow[]> {
  const cutoff = Date.now() - windowMs;
  const result = await db
    .prepare(
      `SELECT id, channel_id, patron_id, kind, tier, generated_at, taken_by
         FROM pub_errand_offers
        WHERE channel_id = ? AND generated_at > ?
        ORDER BY id ASC`,
    )
    .bind(channelId, cutoff)
    .all<PubErrandOfferRow>();
  return result.results ?? [];
}

export interface PubErrandOfferInput {
  channel_id: string;
  patron_id: string;
  kind: PubErrandKind;
  tier: PubErrandTier;
  generated_at: number;
}

export async function insertPubErrandOffers(
  db: D1Database,
  offers: PubErrandOfferInput[],
): Promise<void> {
  if (offers.length === 0) return;
  const stmts = offers.map((o) =>
    db
      .prepare(
        `INSERT INTO pub_errand_offers (channel_id, patron_id, kind, tier, generated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(o.channel_id, o.patron_id, o.kind, o.tier, o.generated_at),
  );
  await db.batch(stmts);
}

export async function getPubErrandOffer(
  db: D1Database,
  offerId: number,
  channelId: string,
): Promise<PubErrandOfferRow | null> {
  return db
    .prepare(
      `SELECT id, channel_id, patron_id, kind, tier, generated_at, taken_by
         FROM pub_errand_offers WHERE id = ? AND channel_id = ?`,
    )
    .bind(offerId, channelId)
    .first<PubErrandOfferRow>();
}

// Atomic claim — flips taken_by to the new errand id only if still unclaimed.
export async function tryClaimPubErrandOffer(
  db: D1Database,
  offerId: number,
  errandId: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE pub_errand_offers SET taken_by = ? WHERE id = ? AND taken_by IS NULL",
    )
    .bind(errandId, offerId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// Release a claim — used when the errand insert fails or on cancel.
export async function releasePubErrandOffer(
  db: D1Database,
  offerId: number,
): Promise<void> {
  await db
    .prepare("UPDATE pub_errand_offers SET taken_by = NULL WHERE id = ?")
    .bind(offerId)
    .run();
}

export async function getActivePubErrand(
  db: D1Database,
  characterId: string,
): Promise<PubErrand | null> {
  const row = await db
    .prepare(
      `SELECT * FROM pub_errands
        WHERE character_id = ? AND claimed_at IS NULL AND cancelled_at IS NULL
        ORDER BY id DESC LIMIT 1`,
    )
    .bind(characterId)
    .first<PubErrandRow>();
  return row ? rowToPubErrand(row) : null;
}

export async function getPubErrand(
  db: D1Database,
  errandId: number,
  characterId: string,
): Promise<PubErrand | null> {
  const row = await db
    .prepare("SELECT * FROM pub_errands WHERE id = ? AND character_id = ?")
    .bind(errandId, characterId)
    .first<PubErrandRow>();
  return row ? rowToPubErrand(row) : null;
}

export interface StartPubErrandInput {
  character_id: string;
  patron_id: string;
  kind: PubErrandKind;
  tier: PubErrandTier;
  duration_ms: number;
  input_resources?: Array<{ name: string; qty: number }>;
}

export async function startPubErrand(
  db: D1Database,
  args: StartPubErrandInput,
): Promise<PubErrand> {
  const now = Date.now();
  const result = await db
    .prepare(
      `INSERT INTO pub_errands
       (character_id, patron_id, kind, tier, started_at, expires_at, input_resources_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      args.character_id,
      args.patron_id,
      args.kind,
      args.tier,
      now,
      now + args.duration_ms,
      args.input_resources && args.input_resources.length > 0
        ? JSON.stringify(args.input_resources)
        : null,
    )
    .run();
  const id = result.meta.last_row_id;
  const row = await getPubErrand(db, Number(id), args.character_id);
  if (!row) throw new Error("Failed to read back pub errand");
  return row;
}

export async function tryWritePubErrandYield(
  db: D1Database,
  errandId: number,
  yieldData: unknown,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE pub_errands SET yield_json = ? WHERE id = ? AND yield_json IS NULL",
    )
    .bind(JSON.stringify(yieldData), errandId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function markPubErrandClaimed(
  db: D1Database,
  errandId: number,
  characterId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE pub_errands SET claimed_at = ?
        WHERE id = ? AND character_id = ? AND claimed_at IS NULL AND cancelled_at IS NULL`,
    )
    .bind(Date.now(), errandId, characterId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function markPubErrandCancelled(
  db: D1Database,
  errandId: number,
  characterId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE pub_errands SET cancelled_at = ?
        WHERE id = ? AND character_id = ? AND claimed_at IS NULL AND cancelled_at IS NULL`,
    )
    .bind(Date.now(), errandId, characterId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export interface PubTrustRow {
  patron_id: string;
  score: number;
  rare_claimed: number;
}

export async function listPubTrust(
  db: D1Database,
  characterId: string,
): Promise<PubTrustRow[]> {
  const result = await db
    .prepare(
      "SELECT patron_id, score, rare_claimed FROM pub_trust WHERE character_id = ?",
    )
    .bind(characterId)
    .all<PubTrustRow>();
  return result.results ?? [];
}

export async function getPubTrust(
  db: D1Database,
  characterId: string,
  patronId: string,
): Promise<PubTrustRow> {
  const row = await db
    .prepare(
      "SELECT patron_id, score, rare_claimed FROM pub_trust WHERE character_id = ? AND patron_id = ?",
    )
    .bind(characterId, patronId)
    .first<PubTrustRow>();
  return row ?? { patron_id: patronId, score: 0, rare_claimed: 0 };
}

// Bumps trust by +1 (capped at the application-level constant; caller clamps).
// Also marks rare_claimed when the rare errand kind is collected.
export async function bumpPubTrust(
  db: D1Database,
  characterId: string,
  patronId: string,
  delta: number,
  markRare: boolean,
  cap: number,
): Promise<PubTrustRow> {
  const existing = await db
    .prepare(
      "SELECT score, rare_claimed FROM pub_trust WHERE character_id = ? AND patron_id = ?",
    )
    .bind(characterId, patronId)
    .first<{ score: number; rare_claimed: number }>();
  const oldScore = existing?.score ?? 0;
  const oldRare = existing?.rare_claimed ?? 0;
  const newScore = Math.min(cap, Math.max(0, oldScore + delta));
  const newRare = oldRare || (markRare ? 1 : 0);
  if (existing) {
    await db
      .prepare(
        "UPDATE pub_trust SET score = ?, rare_claimed = ? WHERE character_id = ? AND patron_id = ?",
      )
      .bind(newScore, newRare, characterId, patronId)
      .run();
  } else {
    await db
      .prepare(
        "INSERT INTO pub_trust (character_id, patron_id, score, rare_claimed) VALUES (?, ?, ?, ?)",
      )
      .bind(characterId, patronId, newScore, newRare)
      .run();
  }
  return { patron_id: patronId, score: newScore, rare_claimed: newRare };
}
