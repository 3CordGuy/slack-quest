import type { Achievement, EarnedAchievement } from "@gantt-quest/core";

export interface Character {
  slack_user_id: string;
  slack_username: string | null;
  name: string;
  class: string;
  level: number;
  xp: number;
  hp: number;
  max_hp: number;
  mana: number;
  max_mana: number;
  shield: number;
  armor_power?: number;
  gold: number;
  scars: string[];
  position: "front" | "back";
  downed_until: number | null;
  str?: number;
  int_stat?: number;
  vit?: number;
  agi?: number;
  dex?: number;
  unspent_points?: number;
  notification_pref?: "thread" | "dm";
  active_slot?: number;
}

export type ItemType =
  | "weapon"
  | "armor"
  | "consumable"
  | "magic"
  | "revive"
  | "tool"
  | "scroll"
  | "resource";
export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";
export type WeaponRange = "melee" | "ranged" | "focus";
export type EquipSlot = "main_hand" | "off_hand" | "body" | "helmet" | "pants" | "boots" | "ring" | "amulet";

export interface Item {
  id: number;
  character_id: string;
  item_name: string;
  item_type: ItemType;
  power: number;
  rarity: Rarity;
  flavor: string | null;
  equipped: boolean;
  weapon_range: WeaponRange | null;
  sharpens_count: number;
  slot: EquipSlot | null;
  stat_bonus: Record<string, number> | null;
  item_subtype: string | null;
  level_req: number;
  element: "fire" | "ice" | "lightning" | null;
  qty?: number;
  potency_stacks?: number;
}

export type QuestVariant = "standard" | "boss" | "gauntlet" | "bounty_pack" | "tower";
export type EffectType = "regen" | "bleeding" | "burning" | "poisoned" | "empowered" | "frozen" | "shocked";

export interface StatusEffect {
  type: EffectType;
  magnitude: number;
  remaining: number;
  source?: string;
}

export interface LootOption {
  name: string;
  item_type: ItemType;
  power: number;
  rarity: Rarity;
  flavor: string;
  weapon_range?: WeaponRange | null;
  slot?: EquipSlot;
  stat_bonus?: Record<string, number>;
  item_subtype?: string;
  level_req?: number;
}

export interface MonsterSpec {
  name: string;
  hp: number;
  max_hp: number;
  tier: number;
  is_boss?: boolean;
  art_url?: string | null;
  attack_damage_type?: string;
  element_weakness?: string;
  element_resistance?: string;
  damage_weakness?: string;
  damage_resistance?: string;
}

export interface TowerRestStockItem {
  name: string;
  item_type: string;
  power: number;
  rarity: string;
  flavor?: string;
}

export interface SceneJson {
  monster_name: string;
  monster_hp: number;
  monster_max_hp: number;
  tier: number;
  scene: string;
  variant?: QuestVariant;
  boss_phase?: 1 | 2;
  wave?: number;
  total_waves?: number;
  monster_effects?: StatusEffect[];
  monster_art_url?: string | null;
  monsters?: MonsterSpec[];
  monster_attack_type?: string;
  monster_damage_weakness?: string;
  monster_damage_resistance?: string;
  tower_floor?: number;
  tower_cycle?: number;
  tower_floor_kind?: "combat" | "rest" | "boss";
  tower_awaiting_choice?: boolean;
  tower_kills_run?: number;
  tower_rest_stock?: TowerRestStockItem[];
  tower_rest_claims?: Record<string, string>;
}

export interface ActiveQuest {
  id: number;
  elite: boolean;
  scene: SceneJson;
  created_by: string;
}

export interface RecentQuest {
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

export interface TowerLeaderboardEntry {
  slack_user_id: string;
  name: string;
  class: string;
  slack_username: string | null;
  tower_best_floor: number;
  tower_kills: number;
  tower_floors_climbed: number;
}

export interface MeResponse {
  slack_user_id: string;
  slack_team_id: string;
  character: Character | null;
  class_art_url?: string | null;
  char_art_url?: string | null;
}

export interface InventoryResponse {
  items: Item[];
  art_url?: string | null;
}

export interface ShopItem {
  id: number;
  item_name: string;
  item_type: ItemType;
  power: number;
  rarity: Rarity;
  flavor: string | null;
  price: number;
  bought_by: string | null;
  weapon_range: WeaponRange | null;
  haggled: "failed" | "15" | "25" | "30" | null;
  level_req: number;
}

export interface StapleItem {
  id: string;
  name: string;
  emoji: string;
  effect: "heal_hp" | "restore_mana";
  power: number;
  price: number;
  blurb: string;
}

export interface ShopResponse {
  stock: ShopItem[];
  staples?: StapleItem[];
  gold: number;
  level?: number;
  channel_id?: string;
  needs_restock?: boolean;
  purchases_this_cycle?: number;
  purchase_cap?: number;
  error?: string;
  art_url?: string | null;
}

export interface HaggleResult {
  item_name: string;
  outcome: "failed" | "15" | "25" | "30";
  bucket: "failed" | "modest" | "solid" | "steal";
  flavor: string;
  roll: number;
  modifier: number;
  total: number;
  old_price: number;
  new_price: number;
}

export interface InnRoom {
  id: string;
  name: string;
  price: number;
  refills: { hp: boolean; mana: boolean };
  blurb: string;
  iconName: string;
}

export interface InnResponse {
  rooms: InnRoom[];
  gold: number;
  hp: number;
  max_hp: number;
  mana: number;
  max_mana: number;
  art_url?: string | null;
  error?: string;
}

export interface SmithyItem {
  id: number;
  item_name: string;
  item_type: ItemType;
  weapon_range: WeaponRange | null;
  power: number;
  sharpens_count: number;
  cap: number;
  cost: number;
  verb: { verb: string; past: string; noun: string; iconName: string; stat: string };
}

export interface SmithyStockListing {
  id: number;
  item_name: string;
  item_type: string;
  power: number;
  rarity: string;
  flavor: string | null;
  price: number;
  slot: string | null;
  item_subtype: string | null;
  stat_bonus: Record<string, number> | null;
  level_req: number;
}

export interface SmithyResponse {
  items: SmithyItem[];
  gold: number;
  armorRepair?: { current: number; max: number; cost: number } | null;
  stock?: SmithyStockListing[];
  stockExpiresAt?: number | null;
  art_url?: string | null;
  error?: string;
}

export interface DrinkItem {
  id: string;
  name: string;
  emoji: string;
  price: number;
  actual_price: number;
  is_daily_special: boolean;
  blurb: string;
  fight_duration?: true;
}

export interface DrinkBuff {
  kind: "buff_attack" | "buff_magic" | "buff_next_crit";
  magnitude: number;
  remaining: number;
  drink_id: string;
  fight_duration?: true;
}

export type SpdThrow = "stone" | "parchment" | "dagger";

export interface SpdOpenMatch {
  id: number;
  initiator_user_id: string;
  initiator_name: string;
  initiator_stake: number;
  challenger_user_id: string | null;
  status: string;
  created_at: number;
  expires_at: number;
}

export interface SpdBet {
  side: "initiator" | "challenger";
  amount: number;
}

export interface SpdBetTotals {
  initiator: number;
  challenger: number;
}

export interface SpdData {
  open_match: SpdOpenMatch | null;
  my_bet: SpdBet | null;
  bet_totals: SpdBetTotals;
}

export interface SpdResult {
  match_id: number;
  initiator_throw: SpdThrow;
  challenger_throw: SpdThrow;
  tie: boolean;
  winner_user_id: string | null;
  payout: number;
  house_bump: number;
  gold: number;
  initiator_name: string;
}

export interface PubNpcOption {
  index: number;
  player_says: string;
  has_payload: boolean;
}

export interface PubTalkResponse {
  npc_says: string;
  options: PubNpcOption[];
  payload_applied: string | null;
  is_terminal: boolean;
}

export interface PubNpc {
  id: string;
  role: "bartender" | "regular";
  name: string;
  archetype: string;
}

export interface PubLeaderboardEntry {
  user_id: string;
  name: string;
  slack_username: string | null;
  games: number;
  wins: number;
  net: number;
}

export interface MercSpec {
  id: string;
  name: string;
  blurb: string;
  cost: number;
  class_label: string;
  level: number;
  hp: number;
  max_hp: number;
  attack_mod: number;
  weapon_power: number;
  position: "front" | "back";
  weapon_range: "melee" | "ranged";
}

export interface PubResponse {
  drinks: DrinkItem[];
  drink_buff: DrinkBuff | null;
  gold: number;
  drinks_remaining: number;
  spd?: SpdData;
  art_url?: string | null;
  error?: string;
  npcs?: { bartender: PubNpc | null; regulars: PubNpc[] };
  leaderboard?: PubLeaderboardEntry[];
  mercs?: MercSpec[];
  hired_merc?: MercSpec | null;
}

export interface LiarsRoundPending {
  round_id: number;
  stake: number;
  player_dice: number[];
  player_sum: number;
  claim: string;
  claim_label: string;
  trust_mult: number;
  challenge_mult: number;
  house_cut_pct: number;
}

export interface LiarsRoundResult {
  outcome: string;
  correct: boolean;
  choice: "trust" | "challenge";
  lied: boolean;
  truth_label: string;
  claim_label: string;
  player_dice: number[];
  bartender_dice: number[];
  combined: number;
  payout: number;
  gold: number;
}

export interface KnownCharacter {
  slack_user_id: string;
  name: string;
  class: string;
  level: number;
  xp: number;
  hp: number;
  max_hp: number;
  last_active: number;
  slack_username: string | null;
  scars: string[];
  achievements?: EarnedAchievement[];
  str?: number;
  int_stat?: number;
  vit?: number;
  agi?: number;
  dex?: number;
  unspent_points?: number;
  downed_until?: number | null;
}

export interface AchievementsResponse {
  definitions: Achievement[];
  earned: EarnedAchievement[];
  new_achievements?: string[];
}

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
}

export interface ActiveQuestResponse {
  quest: ActiveQuest | null;
  party?: Character[];
  has_web_combat?: boolean;
}

export interface JoinableQuest {
  quest_id: number;
  channel_id: string;
  variant: QuestVariant;
  elite: boolean;
  monster_name: string;
  monster_max_hp: number;
  scene: string;
}

export interface RecentQuestsResponse {
  quests: RecentQuest[];
}

export type TownSection = "job_board" | "pub" | "shop" | "inn" | "smithy" | "camp" | "apothecary";

// Sub-tab within My Camp. "hunt" is the legacy free-hunt launcher moved inside
// camp; the gathering nodes (mine/forage/fish) sit alongside it.
export type CampTab = "hunt" | "mine" | "forage" | "fish" | "build";
export type CampNode = "mine" | "forage" | "fish";
export type CampTier = "quick" | "standard" | "deep";

export interface CampTierSpec {
  tier: CampTier;
  label: string;
  duration_ms: number;
  base_xp: number;
  base_gold: number;
}

export interface CampNodeSpec {
  node: CampNode;
  label: string;
  icon: string;
  primary: string;
  uncommon: string;
  rare: string;
  blurb: string;
}

export interface CampUpgradeSpec {
  key: string;
  label: string;
  blurb: string;
  icon: string;
  gold_cost: number;
  level_req: number;
  effect: { kind: "extra_slot" } | { kind: "future" };
  coming_soon?: boolean;
}

export interface GatheringYield {
  resources: Array<{ name: string; qty: number }>;
  xp: number;
  gold: number;
  gold_strike?: boolean;
}

export interface ActiveGatheringTask {
  id: number;
  node: CampNode;
  tier: CampTier;
  worker_slot: number;
  started_at: number;
  expires_at: number;
  ready: boolean;
  yield: GatheringYield | null;
}

export interface CampStatusResponse {
  now: number;
  active: ActiveGatheringTask[];
  slots: { total: number; in_use: number; available: number };
  upgrades_built: string[];
  upgrades_catalog: CampUpgradeSpec[];
  gold: number;
  level: number;
}

// ─── Pub Errands ──────────────────────────────────────────────────────────────

export type PubErrandKind = "courier" | "procure" | "investigate" | "mercy" | "rare";
export type PubErrandTier = "short" | "medium" | "long";

export interface PubPatron {
  id: string;
  name: string;
  archetype: string;
  blurb: string;
  icon: string;
  procure_resource_node: CampNode;
  rare_item: { item_name: string; item_type: ItemType; power: number; rarity: Rarity; slot?: EquipSlot; blurb: string };
  tip_pool: Array<{ item_name: string; item_type: ItemType; power: number; rarity: Rarity; weight: number; blurb: string }>;
}

export interface PubErrandOffer {
  id: number;
  patron_id: string;
  kind: PubErrandKind;
  tier: PubErrandTier;
  duration_ms: number;
  base_xp: number;
  base_gold: number;
  procure_qty: number;
}

export interface PubErrandYieldItem {
  item_name: string;
  item_type: ItemType;
  power: number;
  rarity: Rarity;
  slot?: EquipSlot | null;
  blurb: string;
}

export interface PubErrandYield {
  gold: number;
  xp: number;
  items: PubErrandYieldItem[];
  apothecary_discount_stacks?: number;
  lore_fragment?: string;
}

export interface ActivePubErrand {
  id: number;
  patron_id: string;
  kind: PubErrandKind;
  tier: PubErrandTier;
  started_at: number;
  expires_at: number;
  ready: boolean;
  yield: PubErrandYield | null;
  input_resources: Array<{ name: string; qty: number }> | null;
}

export interface PubTrust {
  patron_id: string;
  score: number;
  rare_claimed: boolean;
  cap: number;
}

export interface PubErrandsResponse {
  now: number;
  patrons: PubPatron[];
  offers: PubErrandOffer[];
  active: ActivePubErrand | null;
  trust: PubTrust[];
}

export interface TownArt {
  overview_art_url: string | null;
  pub_art_url: string | null;
  shop_art_url: string | null;
  inn_art_url: string | null;
  smithy_art_url: string | null;
  apothecary_art_url: string | null;
  outskirts_art_url: string | null;
}

export interface ApothecaryDownedChar {
  slack_user_id: string;
  name: string;
  class: string;
  downed_until: number;
  slack_username: string | null;
}

export interface ApothecaryStapleItem {
  id: string;
  name: string;
  emoji: string;
  effect: "poison_enemy" | "regen_self" | "empower_self";
  turns: number;
  blurb: string;
  power: number;
  price: number;
}

export interface SelfReviveQuote {
  gold_cost: number;
  xp_cost: number;
  available_gold: number;
  available_xp_in_level: number;
  level: number;
  downed_until: number;
}

export interface ApothecaryResponse {
  downed: ApothecaryDownedChar[];
  staples: ApothecaryStapleItem[];
  gold: number;
  revive_count: number;
  art_url: string | null;
  self_revive?: SelfReviveQuote | null;
  error?: string;
}

export interface JobListing {
  id: string;
  variant: "standard" | "boss" | "gauntlet" | "bounty_pack";
  monster_count?: number;
  required_level: number;
  title: string;
  blurb: string;
  reward_summary: string;
}

export interface BoardResponse {
  town_name: string;
  jobs: JobListing[];
  claims: Record<string, { taken_by: string }>;
  character_level: number;
  refresh_stamp: number;
}

export type LoadState =
  | { kind: "loading" }
  | { kind: "anon" }
  | {
      kind: "auth";
      me: MeResponse;
      inventory: Item[];
      inventoryArtUrl: string | null;
      activeQuest: { quest: ActiveQuest; party: Character[] } | null;
      lobbyQuest: { quest: { id: number; created_by: string; scene: Record<string, unknown>; lobby_expires_at: number | null; mode: string }; party: { slack_user_id: string; name: string; invite_status: string; ready: boolean }[] } | null;
      recent: RecentQuest[];
      questStats: QuestStats | null;
      leaderboard: QuestLeaderboardEntry[];
      towerLeaderboard: TowerLeaderboardEntry[];
      shop: ShopResponse | null;
      joinable: JoinableQuest | null;
      inn: InnResponse | null;
      smithy: SmithyResponse | null;
      pub: PubResponse | null;
      apothecary: ApothecaryResponse | null;
      townArt: TownArt | null;
      board: BoardResponse | null;
    };

export interface SlotsListResponse {
  active_slot: number | null;
  saved: { slot: number; name: string; class: string; level: number; gender: "m" | "f" | null; saved_at: number }[];
}

export interface QuestOption {
  id: QuestVariant;
  label: string;
  icon: string;
  accentColor: string;
  bg: string;
  border: string;
  lockedBorder: string;
  tag: string;
  description: string;
  rewards: string;
  beginLabel: string;
  pendingLabel: string;
  minLevel: number;
}

export type InventorySort = "type" | "rarity" | "power" | "lvl";
