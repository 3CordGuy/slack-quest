import { Component, forwardRef, useEffect, useRef, useState } from "react";
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import type { CSSProperties, ErrorInfo, ReactNode } from "react";
import toast from "react-hot-toast";
import {
  FloatingFocusManager,
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
} from "@floating-ui/react";

import { classByName, deriveAll, findCatalogEntry, priceFor, sellPriceFor, xpForLevel, type Achievement, type EarnedAchievement, type StatKey, type Stats } from "@gantt-quest/core";

import { CombatPage } from "./CombatPage";
import { DungeonView } from "./DungeonView";
import { GridDungeonView } from "./GridDungeonView";
import { LobbyView } from "./LobbyView";
import { Avatar, EmojiIcon, Icon, KeyIcon } from "./icons";

// One-liner describing the in-game effect of an item, in plain mechanics
// (not flavor). Used by the inventory's Info toggle so players can see
// what "+5" actually means instead of guessing.
function describeItemEffect(item: {
  item_type: string;
  power: number;
  weapon_range?: "melee" | "ranged" | "focus" | null;
  item_name: string;
  slot?: string | null;
  item_subtype?: string | null;
  stat_bonus?: Record<string, number> | null;
}): React.ReactNode {
  const p = item.power;
  const lead = (name: string) => <Icon name={name} style={{ marginRight: 6 }} />;
  const statLine = item.stat_bonus ? statBonusSummary(item.stat_bonus) : "";
  switch (item.item_type) {
    case "weapon":
      if (item.weapon_range === "focus") {
        return <>{lead("crystal-ball")}Focus weapon: adds +{p} to heal & shield rolls (no attack/cast damage). +1 max mana while equipped.</>;
      }
      if (item.weapon_range === "ranged") {
        return <>{lead("crossbow")}Ranged weapon: +{p} attack/cast damage. Can attack from back row.</>;
      }
      return <>{lead("sword")}Melee weapon: +{p} attack/cast damage. Front row only for attack.</>;
    case "armor": {
      const slot = item.slot;
      // Pure stat accessories — no armor contribution
      if (slot === "boots" || slot === "ring" || slot === "amulet") {
        return <>{lead(slot === "boots" ? "boots" : slot === "ring" ? "ring" : "gem-chain")}{statLine || "Passive stat bonus."}</>;
      }
      // Gloves — minor armor + stat bonus
      if (slot === "off_hand" && item.item_subtype === "gloves") {
        const gloveArmor = Math.floor(p / 3);
        return <>{lead("gloves")}Gloves: contributes {p > 0 ? `+${gloveArmor} to armor pool` : "no armor"}{statLine ? `. ${statLine}` : "."}</>;
      }
      // Shield — full armor contribution + stat bonus
      if (slot === "off_hand") {
        return <>{lead("shield")}Shield: adds +{p} to armor pool{statLine ? `. ${statLine}` : "."}</>;
      }
      // Helmet — half armor
      if (slot === "helmet") {
        return <>{lead("heavy-helm")}Helmet: contributes floor({p}/2) = {Math.floor(p / 2)} to armor pool{statLine ? `. ${statLine}` : "."}</>;
      }
      // Pants — quarter armor
      if (slot === "pants") {
        return <>{lead("armored-pants")}Pants: contributes floor({p}/4) = {Math.floor(p / 4)} to armor pool{statLine ? `. ${statLine}` : "."}</>;
      }
      // Body armor (default)
      return <>{lead("chest-armor")}Armor: reduces incoming damage by {Math.max(1, Math.floor(p / 2))}{statLine ? `. ${statLine}` : "."}</>;
    }
    case "consumable":
      return <>{lead("bubbling-potion")}Restores {p} HP on use. Single-use.</>;
    case "magic":
      return <>{lead("crystal-ball")}Permanently grants +{p} max mana on use (capped at 5).</>;
    case "revive":
      return <>{lead("crowned-heart")}Revives a downed party member to {p}% of their max HP. Combat-only.</>;
    case "tool":
    case "scroll": {
      const entry = findCatalogEntry(item.item_name);
      const base = entry?.blurb ?? "Catalog item.";
      const powerNote = p > 0 ? ` (power ${p})` : "";
      return <>{lead(item.item_type === "scroll" ? "scroll-unfurled" : "anvil")}{base}{powerNote}</>;
    }
    default:
      return <>Item: +{p}.</>;
  }
}

// Maps catalog item names to the status effect they apply and who it targets.
const CATALOG_EFFECT: Record<string, { effect: EffectType; target: "self" | "monster" }> = {
  "Espresso Shot": { effect: "regen",     target: "self"    },
  "Regen Draft":   { effect: "regen",     target: "self"    },
  "Poison Vial":   { effect: "poisoned",  target: "monster" },
  "Venom Vial":    { effect: "poisoned",  target: "monster" },
  "Battle Elixir": { effect: "empowered", target: "self"    },
};

// User-friendly text for error codes returned by the worker. Anything not
// listed here falls back to the raw `error` string from the response body.
const ERROR_LABELS: Record<string, string> = {
  cooldown: "Catching your breath — try again later.",
  already_full: "Already at full HP/mana — no rest needed.",
  no_rest_mid_quest: "Can't rest mid-quest. Finish the fight first.",
  no_long_rest_mid_quest: "Long rest blocked mid-quest. Wrap up first.",
  downed: "You're downed — wait for the cooldown.",
  no_character: "Roll a character in Slack first.",
  unauthenticated: "Session expired — log in again.",
  not_yours: "That item isn't yours.",
  already_equipped: "Already equipped.",
  consumable_not_equippable: "Consumables can't be equipped — use them.",
  bad_item_id: "Bad item id.",
  bad_quest_id: "Bad quest id.",
  not_in_party: "You're not in this party.",
  web_mode: "This quest is being run from the web — head there.",
  slack_mode: "This quest was started in Slack — use Slack commands to fight.",
  cant_give_to_self: "Can't give an item to yourself.",
  unequip_first: "Unequip the item first before giving or selling.",
  recipient_no_character: "That player hasn't rolled a character yet.",
  mid_quest: "Not available mid-quest.",
  insufficient_gold: "Not enough gold.",
  unknown_drink: "Unknown drink.",
  drink_cap_reached: "The bartender cuts you off — you've had your fill before the fight.",
  invalid_stake: "Invalid stake amount.",
  invalid_throw: "Invalid throw — pick stone, parchment, or dagger.",
  match_already_open: "There's already an open match in your channel.",
  no_channel: "No channel found — join a quest first.",
  match_not_found: "Match not found.",
  match_not_open: "Match is no longer open.",
  match_taken: "Someone else accepted the match first.",
  cant_accept_own_match: "You can't accept your own match.",
  cant_bet_on_own_match: "You can't bet on your own match.",
  already_bet: "You've already placed a bet on this match.",
  invalid_side: "Pick initiator or challenger.",
  invalid_bet_amount: "Bet must be 5g, 10g, or 25g.",
  not_initiator: "Only the initiator can cancel the match.",
  already_resolved: "Match is already resolved.",
};

// fetch + parse + toast on error. Returns { ok, body } so callers can inspect
// success payloads. Use this for any user-triggered POST that returns either
// `{ ok: true, ... }` or `{ error: "code", ... }`.
async function postJson(
  url: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; body: Record<string, unknown> | null }> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "include", ...init });
  } catch (err) {
    toast.error(`Network error: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, body: null };
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const code = typeof body?.error === "string" ? body.error : `http_${res.status}`;
    const message = ERROR_LABELS[code] ?? code;
    // Friendly addendum for cooldown timers — show minutes remaining.
    if (code === "cooldown" && typeof body?.ready_in_ms === "number") {
      const mins = Math.max(1, Math.ceil(body.ready_in_ms / 60_000));
      toast.error(`${message} (~${mins}m)`);
    } else {
      toast.error(message);
    }
    return { ok: false, body };
  }
  return { ok: true, body };
}

// v0.4: read-only views + opt-in web-mode combat. When the active quest is
// a `standard` or `boss` variant, the player can open a dedicated combat
// page that drives a Durable-Object-backed turn-based loop via WebSocket.

interface Character {
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
  gold: number;
  scars: string[];
  keys_bronze: number;
  keys_silver: number;
  keys_gold: number;
  position: "front" | "back";
  downed_until: number | null;
  // Primary stats (Phase 1). Present on characters migrated via 0032.
  str?: number;
  int_stat?: number;
  vit?: number;
  agi?: number;
  dex?: number;
  unspent_points?: number;
  notification_pref?: "thread" | "dm";
}

type ItemType =
  | "weapon"
  | "armor"
  | "consumable"
  | "magic"
  | "revive"
  | "tool"
  | "scroll";
type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";
type WeaponRange = "melee" | "ranged" | "focus";

type EquipSlot = "main_hand" | "off_hand" | "body" | "helmet" | "pants" | "boots" | "ring" | "amulet";

interface Item {
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
}

type QuestVariant = "standard" | "boss" | "gauntlet" | "dungeon" | "bounty_pack";
type EffectType = "regen" | "bleeding" | "burning" | "poisoned" | "empowered" | "frozen" | "shocked";

interface StatusEffect {
  type: EffectType;
  magnitude: number;
  remaining: number;
  source?: string;
}

type ExpeditionNodeType = "combat" | "trap" | "lockbox" | "npc" | "treasure" | "merchant";

type SkillType = "str" | "dex" | "int";
type KeyTier = "bronze" | "silver" | "gold";

interface TrapChoice {
  text: string;
  emoji: string;
  skill: SkillType;
  fail_damage: number;
}

interface LootOption {
  name: string;
  item_type: ItemType;
  power: number;
  rarity: Rarity;
  flavor: string;
  weapon_range?: WeaponRange | null;
  slot?: EquipSlot;
  stat_bonus?: Record<string, number>;
  item_subtype?: string;
}

interface NpcOffer {
  greeting: string;
  item: LootOption;
}

interface ExpeditionNode {
  type: ExpeditionNodeType;
  scene: string;
  monster_name?: string;
  monster_max_hp?: number;
  tier?: number;
  trap_choices?: TrapChoice[];
  loot_options?: LootOption[];
  lock_tier?: KeyTier;
  npc?: NpcOffer;
}

interface ExpeditionState {
  theme: string;
  current: number;
  nodes: ExpeditionNode[];
  pending_doors?: number[];
  pool?: number[];
  middle_count?: number;
  visited_count?: number;
  visited_indices?: number[];
  sealed_doors?: number[];
}

type DungeonDirection = "n" | "e" | "s" | "w";

interface MonsterSpec {
  name: string;
  hp: number;
  max_hp: number;
  tier: number;
  is_boss?: boolean;
  art_url?: string | null;
}

type DungeonObjectEffect =
  | { effect: "open_exit"; direction: DungeonDirection; reveals_node: string }
  | { effect: "spawn_item"; item: LootOption }
  | { effect: "trigger_encounter"; monsters: MonsterSpec[] }
  | { effect: "flavor"; text: string };

interface DungeonObject {
  id: string;
  name: string;
  takeable: boolean;
  used: boolean;
  on_use?: DungeonObjectEffect;
}

interface DungeonNode {
  id: string;
  name?: string;
  description: string;
  art_url?: string;
  exits: Partial<Record<DungeonDirection, string>>;
  objects: DungeonObject[];
  encounter?: { monsters: MonsterSpec[]; cleared: boolean };
  visited: boolean;
}

interface DungeonGraph {
  nodes: Record<string, DungeonNode>;
  current: string;
  visited: string[];
}

interface SceneJson {
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
  expedition?: ExpeditionState;
  graph?: DungeonGraph;
  monster_art_url?: string | null;
}

interface ActiveQuest {
  id: number;
  elite: boolean;
  scene: SceneJson;
}

interface RecentQuest {
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

interface QuestStats {
  total: number;
  wins: number;
  losses: number;
  win_rate: number;
  current_streak: number;
  best_streak: number;
  elite_wins: number;
  by_variant: Record<string, { wins: number; total: number }>;
}

interface QuestLeaderboardEntry {
  slack_user_id: string;
  name: string;
  slack_username: string | null;
  class: string;
  level: number;
  wins: number;
  total_quests: number;
  elite_wins: number;
}

interface MeResponse {
  slack_user_id: string;
  slack_team_id: string;
  character: Character | null;
  class_art_url?: string | null;
  char_art_url?: string | null;
}

interface InventoryResponse {
  items: Item[];
  art_url?: string | null;
}

interface ShopItem {
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
  // Computed server-side from power (same rule as inventory): a power-9
  // weapon needs level 3 to equip. Surfaced here so the shop UI can warn
  // before the player drops gold on something they can't use yet.
  level_req: number;
}

interface StapleItem {
  id: string;
  name: string;
  emoji: string;
  effect: "heal_hp" | "restore_mana";
  power: number;
  price: number;
  blurb: string;
}

interface ShopResponse {
  stock: ShopItem[];
  staples?: StapleItem[];
  gold: number;
  // Character's current level. Used by ShopRow to colour the level-req
  // badge red when the player can't yet equip the item.
  level?: number;
  channel_id?: string;
  needs_restock?: boolean;
  purchases_this_cycle?: number;
  purchase_cap?: number;
  error?: string;
  art_url?: string | null;
}

interface HaggleResult {
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

interface InnRoom {
  id: string;
  name: string;
  price: number;
  refills: { hp: boolean; mana: boolean };
  blurb: string;
  iconName: string;
}

interface InnResponse {
  rooms: InnRoom[];
  gold: number;
  hp: number;
  max_hp: number;
  mana: number;
  max_mana: number;
  art_url?: string | null;
  error?: string;
}

interface SmithyItem {
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

interface SmithyResponse {
  items: SmithyItem[];
  gold: number;
  art_url?: string | null;
  error?: string;
}

// Pub / drinks
interface DrinkItem {
  id: string;
  name: string;
  emoji: string;
  price: number;
  actual_price: number;
  is_daily_special: boolean;
  blurb: string;
  fight_duration?: true;
}

interface DrinkBuff {
  kind: "buff_attack" | "buff_magic" | "buff_next_crit";
  magnitude: number;
  remaining: number;
  drink_id: string;
  fight_duration?: true;
}

// Stone-Parchment-Dagger
type SpdThrow = "stone" | "parchment" | "dagger";

interface SpdOpenMatch {
  id: number;
  initiator_user_id: string;
  initiator_name: string;
  initiator_stake: number;
  challenger_user_id: string | null;
  status: string;
  created_at: number;
  expires_at: number;
}

interface SpdBet {
  side: "initiator" | "challenger";
  amount: number;
}

interface SpdBetTotals {
  initiator: number;
  challenger: number;
}

interface SpdData {
  open_match: SpdOpenMatch | null;
  my_bet: SpdBet | null;
  bet_totals: SpdBetTotals;
}

// SPD resolution result (returned from /accept)
interface SpdResult {
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

interface PubNpcOption {
  index: number;
  player_says: string;
  has_payload: boolean;
}

interface PubTalkResponse {
  npc_says: string;
  options: PubNpcOption[];
  payload_applied: string | null;
  is_terminal: boolean;
}

interface PubNpc {
  id: string;
  role: "bartender" | "regular";
  name: string;
  archetype: string;
}

interface PubLeaderboardEntry {
  user_id: string;
  name: string;
  slack_username: string | null;
  games: number;
  wins: number;
  net: number;
}

interface PubResponse {
  drinks: DrinkItem[];
  drink_buff: DrinkBuff | null;
  gold: number;
  drinks_remaining: number;
  spd?: SpdData;
  art_url?: string | null;
  error?: string;
  npcs?: { bartender: PubNpc | null; regulars: PubNpc[] };
  leaderboard?: PubLeaderboardEntry[];
}

// Liars' Roll pending state (after start, before decide)
interface LiarsRoundPending {
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

// Liars' Roll result (after decide)
interface LiarsRoundResult {
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

// Give: known characters for picker
// Portrait URL helpers. Custom per-character portraits live at
// /img/art/v3/character/<slug>.png and the class-default fallback at
// /img/art/views/v6/class_<class_id>.png. The Adventurers list and the
// AdventurerSheet both prefer the custom portrait — falling back to the
// class image only when the custom one 404s — so updates to a character's
// portrait show up consistently across the dashboard.
function adventurerSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "unnamed";
}
function adventurerCharPortrait(name: string): string {
  return `/img/art/v3/character/${adventurerSlug(name)}.png`;
}
function adventurerClassPortrait(className: string): string {
  return `/img/art/views/v6/class_${className.toLowerCase().replace(/[\s-]+/g, "_")}.png`;
}

interface KnownCharacter {
  slack_user_id: string;
  name: string;
  class: string;
  level: number;
  xp: number;
  hp: number;
  max_hp: number;
  last_active: number; // unix seconds
  slack_username: string | null;
  scars: string[];
  achievements?: EarnedAchievement[];
  // Primary stats (Phase 1 / optional — present after migration 0032).
  str?: number;
  int_stat?: number;
  vit?: number;
  agi?: number;
  dex?: number;
  unspent_points?: number;
  downed_until?: number | null;
}

interface AchievementsResponse {
  definitions: Achievement[];
  earned: EarnedAchievement[];
  new_achievements?: string[];
}

interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
}

interface ActiveQuestResponse {
  quest: ActiveQuest | null;
  party?: Character[];
  has_web_combat?: boolean;
}

interface JoinableQuest {
  quest_id: number;
  channel_id: string;
  variant: QuestVariant;
  elite: boolean;
  monster_name: string;
  monster_max_hp: number;
  scene: string;
}

interface RecentQuestsResponse {
  quests: RecentQuest[];
}

type TownSection = "job_board" | "pub" | "shop" | "inn" | "smithy" | "hunt" | "apothecary";

interface TownArt {
  overview_art_url: string | null;
  pub_art_url: string | null;
  shop_art_url: string | null;
  inn_art_url: string | null;
  smithy_art_url: string | null;
  apothecary_art_url: string | null;
  outskirts_art_url: string | null;
}

interface ApothecaryDownedChar {
  slack_user_id: string;
  name: string;
  class: string;
  downed_until: number;
  slack_username: string | null;
}

interface ApothecaryStapleItem {
  id: string;
  name: string;
  emoji: string;
  effect: "poison_enemy" | "regen_self" | "empower_self";
  turns: number;
  blurb: string;
  power: number;
  price: number;
}

interface ApothecaryResponse {
  downed: ApothecaryDownedChar[];
  staples: ApothecaryStapleItem[];
  gold: number;
  revive_count: number;
  art_url: string | null;
  error?: string;
}

interface JobListing {
  id: string;
  variant: "standard" | "boss" | "dungeon" | "gauntlet" | "bounty_pack";
  monster_count?: number;
  required_level: number;
  title: string;
  blurb: string;
  reward_summary: string;
}

interface BoardResponse {
  town_name: string;
  jobs: JobListing[];
  claims: Record<string, { taken_by: string }>;
  character_level: number;
  refresh_stamp: number;
}

type LoadState =
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
      shop: ShopResponse | null;
      joinable: JoinableQuest | null;
      inn: InnResponse | null;
      smithy: SmithyResponse | null;
      pub: PubResponse | null;
      apothecary: ApothecaryResponse | null;
      townArt: TownArt | null;
      board: BoardResponse | null;
    };

class CombatErrorBoundary extends Component<{ children: ReactNode; onReset: () => void }, { crashed: boolean; message: string }> {
  constructor(props: { children: ReactNode; onReset: () => void }) {
    super(props);
    this.state = { crashed: false, message: "" };
  }
  static getDerivedStateFromError(err: unknown) {
    return { crashed: true, message: err instanceof Error ? err.message : String(err) };
  }
  componentDidCatch(err: Error, info: ErrorInfo) {
    console.error("[CombatPage] render error:", err, info);
  }
  render() {
    if (this.state.crashed) {
      return (
        <div style={{ background: "#0e0f12", minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, color: "#f5f5f5" }}>
          <p style={{ color: "#fca5a5" }}>Combat display error — {this.state.message}</p>
          <button
            style={{ padding: "8px 20px", borderRadius: 6, border: "1px solid #6366f1", background: "#1d1f23", color: "#f5f5f5", cursor: "pointer" }}
            onClick={() => { this.setState({ crashed: false, message: "" }); this.props.onReset(); }}
          >
            ← Return to dashboard
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function App() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [activeCombat, setActiveCombat] = useState<{ questId: number } | null>(null);
  const [toastQueue, setToastQueue] = useState<Achievement[]>([]);

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = `@keyframes achievement-in { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }`;
    document.head.appendChild(style);
    return () => { style.remove(); };
  }, []);

  // True after the user explicitly backed out of CombatPage — suppresses
  // auto-resume on subsequent refresh() calls (e.g. after a shop purchase)
  // until they click Resume or combat ends. Reset when combat actually ends.
  // Stored in a ref because refresh() is called synchronously after the
  // dismiss flag is flipped — useState wouldn't propagate in time.
  const combatDismissedRef = useRef(false);
  const setCombatDismissed = (v: boolean) => {
    combatDismissedRef.current = v;
  };
  // Tracks whether D1 still holds a web combat state for the active quest,
  // so the dashboard can offer a Resume button after Back.
  const [hasWebCombat, setHasWebCombat] = useState(false);
  // Modal state — haggle outcome and generic confirm. Rendered at the top
  // of the dashboard tree so they're not subtree-scoped to a single card.
  const [haggleResult, setHaggleResult] = useState<HaggleResult | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [townSection, setTownSection] = useState<TownSection | null>(null);
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const isMobile = useMobileViewport();

  useEffect(() => {
    void refresh();
  }, []);

  // Toast once when a joinable quest first appears
  const prevJoinableIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (state.kind !== "auth") return;
    const jId = state.joinable?.quest_id ?? null;
    if (jId !== null && jId !== prevJoinableIdRef.current) {
      const j = state.joinable!;
      toast(`⚔ ${j.monster_name} stirs — a ${j.variant} quest is open!`, { duration: 7000 });
    }
    prevJoinableIdRef.current = jId;
  }, [state.kind === "auth" ? state.joinable?.quest_id : null]);

  // Background poll — keep the dashboard in sync with partymate activity
  // (joins, shop buys, slack-driven combat). Paused when CombatPage is open
  // (the WS keeps that screen live) and when the tab is hidden to save battery.
  useEffect(() => {
    if (activeCombat) return;
    const POLL_MS = 15_000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      if (!document.hidden) void refresh();
      timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [activeCombat]);

  async function refresh() {
    const meRes = await fetch("/api/me", { credentials: "include" });
    if (meRes.status === 401) {
      setState({ kind: "anon" });
      return;
    }
    const me = (await meRes.json()) as MeResponse;

    let inventory: Item[] = [];
    let inventoryArtUrl: string | null = null;
    let activeQuest: { quest: ActiveQuest; party: Character[] } | null = null;
    let lobbyQuest: { quest: { id: number; created_by: string; scene: Record<string, unknown>; lobby_expires_at: number | null; mode: string }; party: { slack_user_id: string; name: string; invite_status: string; ready: boolean }[] } | null = null;
    let recent: RecentQuest[] = [];
    let questStats: QuestStats | null = null;
    let leaderboard: QuestLeaderboardEntry[] = [];
    let shop: ShopResponse | null = null;
    let joinable: JoinableQuest | null = null;
    let inn: InnResponse | null = null;
    let smithy: SmithyResponse | null = null;
    let pub: PubResponse | null = null;
    let apothecary: ApothecaryResponse | null = null;
    let townArt: TownArt | null = null;
    let board: BoardResponse | null = null;
    if (me.character) {
      const [invRes, qRes, lobbyRes, recentRes, statsRes, leaderboardRes, shopRes, joinableRes, innRes, smithyRes, pubRes, townRes, boardRes, apoRes] = await Promise.all([
        fetch("/api/inventory", { credentials: "include" }),
        fetch("/api/quest/active", { credentials: "include" }),
        fetch("/api/quest/lobby", { credentials: "include" }),
        fetch("/api/quests/recent", { credentials: "include" }),
        fetch("/api/stats", { credentials: "include" }),
        fetch("/api/leaderboard", { credentials: "include" }),
        fetch("/api/shop", { credentials: "include" }),
        fetch("/api/quest/joinable", { credentials: "include" }),
        fetch("/api/inn", { credentials: "include" }),
        fetch("/api/smithy", { credentials: "include" }),
        fetch("/api/pub", { credentials: "include" }),
        fetch("/api/town", { credentials: "include" }),
        fetch("/api/board", { credentials: "include" }),
        fetch("/api/apothecary", { credentials: "include" }),
      ]);
      if (invRes.ok) {
        const body = (await invRes.json()) as InventoryResponse;
        inventory = body.items;
        inventoryArtUrl = body.art_url ?? null;
      }
      if (qRes.ok) {
        const body = (await qRes.json()) as ActiveQuestResponse;
        if (body.quest) {
          activeQuest = { quest: body.quest, party: body.party ?? [] };
          setHasWebCombat(!!body.has_web_combat);
          // Auto-resume CombatPage on initial load (or after combat ends and
          // a new one starts). Skipped if the user explicitly backed out —
          // they'll see a Resume button on the dashboard instead.
          if (body.has_web_combat && !combatDismissedRef.current) {
            setActiveCombat({ questId: body.quest.id });
          }
          // Combat ended (D1 state cleared) — reset the dismiss flag so a
          // future fight on the same quest will auto-resume again.
          if (!body.has_web_combat && combatDismissedRef.current) {
            setCombatDismissed(false);
          }
        } else {
          setHasWebCombat(false);
          setCombatDismissed(false);
        }
      }
      if (lobbyRes.ok) {
        const body = (await lobbyRes.json()) as { quest: { id: number; created_by: string; scene: Record<string, unknown>; lobby_expires_at: number | null; mode: string } | null; party?: { slack_user_id: string; name: string; invite_status: string; ready: boolean }[] };
        if (body.quest) lobbyQuest = { quest: body.quest, party: body.party ?? [] };
      }
      if (recentRes.ok) {
        recent = ((await recentRes.json()) as RecentQuestsResponse).quests;
      }
      if (statsRes.ok) {
        questStats = (await statsRes.json()) as QuestStats;
      }
      if (leaderboardRes.ok) {
        leaderboard = ((await leaderboardRes.json()) as { entries: QuestLeaderboardEntry[] }).entries;
      }
      if (shopRes.ok) {
        shop = (await shopRes.json()) as ShopResponse;
      } else {
        const body = (await shopRes.json().catch(() => ({}))) as ShopResponse;
        shop = body.error ? body : null;
      }
      if (joinableRes.ok) {
        const body = (await joinableRes.json()) as { joinable: JoinableQuest | null };
        joinable = body.joinable;
      }
      // Inn / Smithy gracefully degrade to null on error responses (mid-quest,
      // no character, etc.) — UI hides those cards in that state.
      if (innRes.ok) {
        inn = (await innRes.json()) as InnResponse;
      } else {
        const body = (await innRes.json().catch(() => ({}))) as InnResponse;
        inn = body.error ? body : null;
      }
      if (smithyRes.ok) {
        smithy = (await smithyRes.json()) as SmithyResponse;
      } else {
        const body = (await smithyRes.json().catch(() => ({}))) as SmithyResponse;
        smithy = body.error ? body : null;
      }
      if (pubRes.ok) {
        pub = (await pubRes.json()) as PubResponse;
      } else {
        const body = (await pubRes.json().catch(() => ({}))) as PubResponse;
        pub = body.error ? body : null;
      }
      if (townRes.ok) {
        townArt = (await townRes.json()) as TownArt;
      }
      if (boardRes.ok) {
        board = (await boardRes.json()) as BoardResponse;
      }
      if (apoRes.ok) {
        apothecary = (await apoRes.json()) as ApothecaryResponse;
      } else {
        const body = (await apoRes.json().catch(() => ({}))) as ApothecaryResponse;
        apothecary = body.error ? body : null;
      }

      // Fetch achievements — clears pending on the server, fires toasts for new ones
      const achRes = await fetch("/api/achievements", { credentials: "include" });
      if (achRes.ok) {
        const achBody = (await achRes.json()) as AchievementsResponse;
        if (achBody.new_achievements && achBody.new_achievements.length > 0) {
          const newDefs = achBody.new_achievements
            .map((id) => achBody.definitions.find((d) => d.id === id))
            .filter((d): d is Achievement => !!d);
          if (newDefs.length > 0) {
            setToastQueue((q) => [...q, ...newDefs]);
          }
        }
      }
    }
    setState({ kind: "auth", me, inventory, inventoryArtUrl, activeQuest, lobbyQuest, recent, questStats, leaderboard, shop, joinable, inn, smithy, pub, apothecary, townArt, board });
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    setState({ kind: "anon" });
  }

  async function refreshMe() {
    const res = await fetch("/api/me", { credentials: "include", cache: "no-store" });
    if (!res.ok) return;
    const me = (await res.json()) as MeResponse;
    setState((prev) => prev.kind === "auth" ? { ...prev, me } : prev);
  }

  async function refreshPub() {
    const res = await fetch("/api/pub", { credentials: "include", cache: "no-store" });
    const body = res.ok
      ? (await res.json()) as PubResponse
      : ((await res.json().catch(() => ({}))) as PubResponse);
    const pub = body.error ? body : res.ok ? body : null;
    setState((prev) => prev.kind === "auth" ? { ...prev, pub } : prev);
  }

  async function refreshShop() {
    const res = await fetch("/api/shop", { credentials: "include", cache: "no-store" });
    const body = res.ok
      ? (await res.json()) as ShopResponse
      : ((await res.json().catch(() => ({}))) as ShopResponse);
    const shop = body.error ? body : res.ok ? body : null;
    setState((prev) => prev.kind === "auth" ? { ...prev, shop } : prev);
  }

  async function restockShop() {
    await fetch("/api/shop/restock", { method: "POST", credentials: "include" });
    await refreshShop();
  }

  async function refreshApothecary() {
    const res = await fetch("/api/apothecary", { credentials: "include", cache: "no-store" });
    const body = res.ok
      ? (await res.json()) as ApothecaryResponse
      : ((await res.json().catch(() => ({}))) as ApothecaryResponse);
    const apothecary = body.error ? body : res.ok ? body : null;
    setState((prev) => prev.kind === "auth" ? { ...prev, apothecary } : prev);
  }

  async function apothecaryBuyStaple(stapleId: string) {
    const res = await fetch(`/api/apothecary/staple/${stapleId}/buy`, { method: "POST", credentials: "include" });
    const body = await res.json() as { ok?: boolean; error?: string; gold_remaining?: number };
    if (!res.ok) {
      if (body.error === "insufficient_gold") { toast.error("Not enough gold."); }
      else { toast.error("Purchase failed."); }
      return;
    }
    toast.success("Added to inventory.");
    void refreshApothecary();
    void refresh();
  }

  async function apothecaryRevive(targetUserId: string, targetName: string) {
    const res = await fetch(`/api/apothecary/revive/${targetUserId}`, { method: "POST", credentials: "include" });
    const body = await res.json() as { ok?: boolean; error?: string; hp_restored?: number; target_name?: string };
    if (!res.ok) {
      if (body.error === "no_revive_item") { toast.error("You need a Revive item to do that."); }
      else if (body.error === "not_downed") { toast.error(`${targetName} is no longer downed.`); }
      else { toast.error("Revive failed."); }
      return;
    }
    toast.success(`${body.target_name ?? targetName} revived with ${body.hp_restored ?? 50}% HP!`);
    void refreshApothecary();
  }

  async function spendStatPoint(stat: StatKey) {
    const res = await fetch("/api/character/spend", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stat }),
    });
    const body = await res.json() as { ok?: boolean; error?: string };
    if (!res.ok) {
      if (body.error === "no_unspent_points") toast.error("No unspent points.");
      else toast.error("Could not spend point.");
      return;
    }
    toast.success(`${stat === "int_stat" ? "INT" : stat.toUpperCase()} increased!`);
    void refreshMe();
  }

  async function saveNotifyPref(pref: "thread" | "dm") {
    const res = await fetch("/api/settings/notify", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pref }),
    });
    if (!res.ok) { toast.error("Could not save preference."); return; }
    toast.success(`Turn notifications set to ${pref === "dm" ? "direct messages" : "channel broadcasts"}.`);
    void refreshMe();
  }

  async function rerollCharacter() {
    const res = await fetch("/api/character/reroll", { method: "POST", credentials: "include" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (body.error === "mid_quest") { toast.error("Finish your quest before rerolling."); return; }
      toast.error("Reroll failed."); return;
    }
    const body = await res.json().catch(() => ({})) as { ok?: boolean; character?: Character; art_url?: string | null };
    // Apply the returned portrait immediately so the UI shows the new character
    // without waiting for the full refresh to hit /api/me.
    if (body.character) {
      setState((prev) => {
        if (prev.kind !== "auth") return prev;
        return {
          ...prev,
          me: {
            ...prev.me,
            character: body.character!,
            char_art_url: body.art_url ?? null,
          },
        };
      });
    }
    toast.success("New hero rolled!");
    void refresh();
  }

  async function startCombat(questId: number) {
    const { ok } = await postJson(`/api/quest/${questId}/start_web_combat`, { method: "POST" });
    if (!ok) return;
    setCombatDismissed(false);
    setActiveCombat({ questId });
  }

  async function chooseDoor(questId: number, pick: number) {
    const { ok } = await postJson(`/api/quest/${questId}/dungeon/choose_door`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pick }),
    });
    if (ok) void refresh();
  }

  async function trapChoose(questId: number, pick: number) {
    const { ok } = await postJson(`/api/quest/${questId}/dungeon/trap_choose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pick }),
    });
    if (ok) void refresh();
  }

  async function lockboxChoose(questId: number, pick: number) {
    const { ok } = await postJson(`/api/quest/${questId}/dungeon/lockbox_choose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pick }),
    });
    if (ok) void refresh();
  }

  async function npcChoose(questId: number, pick: number) {
    const { ok } = await postJson(`/api/quest/${questId}/dungeon/npc_choose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pick }),
    });
    if (ok) void refresh();
  }

  async function merchantChoose(questId: number, pick: number) {
    const { ok } = await postJson(`/api/quest/${questId}/dungeon/merchant_choose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pick }),
    });
    if (ok) void refresh();
  }

  async function graphMove(questId: number, direction: DungeonDirection) {
    const res = await fetch(`/api/quest/${questId}/dungeon/graph/move`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction }),
    });
    const body = await res.json() as { ok?: boolean; error?: string; has_encounter?: boolean };
    if (!res.ok) {
      if (body.error === "encounter_active") toast.error("Finish the encounter first!");
      else if (body.error === "no_exit") toast.error("No exit in that direction.");
      else toast.error("Can't move there.");
      return;
    }
    void refresh();
  }

  async function graphTakeObject(questId: number, objectId: string) {
    const res = await fetch(`/api/quest/${questId}/dungeon/graph/take`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ object_id: objectId }),
    });
    const body = await res.json() as { ok?: boolean; error?: string; item?: { id: number; name: string } };
    if (!res.ok) { toast.error("Couldn't take that."); return; }
    toast.success(`Picked up ${body.item?.name ?? "item"}!`);
    void refresh();
  }

  async function graphUseObject(questId: number, objectId: string) {
    const res = await fetch(`/api/quest/${questId}/dungeon/graph/use`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ object_id: objectId }),
    });
    const body = await res.json() as { ok?: boolean; error?: string; effect?: string; text?: string; direction?: string; item?: { name: string; rarity: string } };
    if (!res.ok) { toast.error("Nothing happens."); return; }
    if (body.effect === "flavor" && body.text) toast(body.text, { duration: 6000 });
    else if (body.effect === "open_exit") toast.success(`A passage to the ${body.direction?.toUpperCase()} opens!`);
    else if (body.effect === "spawn_item") toast.success(`Found: ${body.item?.name ?? "item"}!`);
    else if (body.effect === "trigger_encounter") toast("⚔ An enemy appears!");
    void refresh();
  }

  async function equipItem(itemId: number) {
    const { ok } = await postJson(`/api/inventory/${itemId}/equip`, { method: "POST" });
    if (ok) void refresh();
  }

  async function unequipItem(itemId: number) {
    const { ok } = await postJson(`/api/inventory/${itemId}/unequip`, { method: "POST" });
    if (ok) void refresh();
  }

  function sellItem(itemId: number) {
    const item = state.kind === "auth" ? state.inventory.find((i) => i.id === itemId) : null;
    if (!item) return;
    const price = sellPriceFor(item.item_type, item.rarity, { power: item.power, sharpens_count: item.sharpens_count });
    setConfirm({
      title: `Sell ${item.item_name}?`,
      message: `You'll receive ${price}g. This can't be undone.`,
      confirmLabel: "Sell",
      destructive: true,
      onConfirm: async () => {
        const { ok, body } = await postJson(`/api/inventory/${itemId}/sell`, { method: "POST" });
        if (ok) {
          if (body && typeof body.price === "number") toast.success(`Sold for ${body.price}g.`);
          void refresh();
        }
      },
    });
  }

  async function useItem(itemId: number) {
    const { ok, body } = await postJson(`/api/inventory/${itemId}/use`, { method: "POST" });
    if (ok) {
      if (body?.kind === "heal") {
        const healed = typeof body.healed === "number" ? body.healed : 0;
        if (healed > 0) toast.success(`+${healed} HP`);
        else toast("Already at full HP — item consumed.");
      } else if (body?.kind === "mana") {
        const restored = typeof body.restored === "number" ? body.restored : 0;
        if (restored > 0) toast.success(`+${restored} mana`);
        else toast("Mana already full — item consumed.");
      } else if (body?.kind === "mana_bump") {
        toast.success(`+${body.added ?? 0} max mana`);
      }
      void refresh();
    }
  }

  async function giveItem(itemId: number, toUserId: string, toName: string) {
    const item = state.kind === "auth" ? state.inventory.find((i) => i.id === itemId) : null;
    if (!item) return;
    setConfirm({
      title: `Give ${item.item_name} to ${toName}?`,
      message: `This will transfer the item to ${toName}. This cannot be undone.`,
      confirmLabel: "Give",
      onConfirm: async () => {
        const { ok, body } = await postJson(`/api/inventory/${itemId}/give`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to_user_id: toUserId }),
        });
        if (ok) {
          toast.success(`Gave ${body?.item_name ?? item.item_name} to ${toName}.`);
          void refresh();
        }
      },
    });
  }

  async function rest(kind: "short" | "long") {
    const { ok, body } = await postJson(`/api/character/rest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
    });
    if (!ok) return;
    if (body && typeof body.healed === "number") {
      toast.success(`Short rest: +${body.healed} HP.`);
    } else if (body && body.kind === "long") {
      toast.success("Long rest: full heal.");
    }
    void refresh();
  }

  async function shopBuy(itemId: number, itemName: string) {
    const { ok } = await postJson(`/api/shop/${itemId}/buy`, { method: "POST" });
    if (ok) {
      toast.success(`${itemName} acquired!`);
      void refresh();
    }
  }

  async function shopHaggle(itemId: number) {
    const { ok, body } = await postJson(`/api/shop/${itemId}/haggle`, { method: "POST" });
    if (!ok) return;
    if (body && typeof body.flavor === "string") {
      setHaggleResult(body as unknown as HaggleResult);
    }
    void refresh();
  }

  async function innStay(roomId: string) {
    const { ok, body } = await postJson(`/api/inn/${roomId}/stay`, { method: "POST" });
    if (!ok) return;
    if (body) {
      const parts: string[] = [];
      if (typeof body.hp_gained === "number" && body.hp_gained > 0) parts.push(`+${body.hp_gained} HP`);
      if (typeof body.mana_gained === "number" && body.mana_gained > 0) parts.push(`+${body.mana_gained} mana`);
      if (parts.length > 0) toast.success(`Inn rest: ${parts.join(", ")}.`);
    }
    void refresh();
  }

  async function smithySharpen(itemId: number, itemName: string, cost: number, verb: string) {
    setConfirm({
      title: `${verb} ${itemName}?`,
      message: `Pay ${cost}g to apply one level of ${verb.toLowerCase()}.`,
      confirmLabel: verb,
      onConfirm: async () => {
        const { ok, body } = await postJson(`/api/smithy/${itemId}/sharpen`, { method: "POST" });
        if (!ok) return;
        if (body && body.item && typeof body.item === "object") {
          const item = body.item as { new_power: number; old_power: number };
          toast.success(`${verb}d to +${item.new_power} (was +${item.old_power}).`);
        }
        void refresh();
      },
    });
  }

  async function buyDrink(drinkId: string) {
    const { ok, body } = await postJson(`/api/pub/drink/${drinkId}`, { method: "POST" });
    if (!ok) return;
    if (body && typeof body.emoji === "string" && typeof body.drink_name === "string") {
      toast.success(`${body.emoji} ${body.drink_name}: ${body.summary ?? ""}`);
    }
    void refresh();
  }

  async function shopBuyStaple(stapleId: string) {
    const { ok, body } = await postJson(`/api/shop/staple/${stapleId}/buy`, { method: "POST" });
    if (!ok) return;
    if (body && typeof body.paid === "number") {
      toast.success(`Bought for ${body.paid}g.`);
    }
    void refresh();
  }

  function sellKeyConfirmed(tier: "bronze" | "silver" | "gold") {
    setConfirm({
      title: `Sell a ${tier} key?`,
      message: `Trades one ${tier} key for gold.`,
      confirmLabel: "Sell key",
      destructive: true,
      onConfirm: () => { void sellKey(tier); },
    });
  }

  async function sellKey(tier: "bronze" | "silver" | "gold") {
    const { ok } = await postJson(`/api/keys/sell`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier }),
    });
    if (ok) void refresh();
  }

  async function transmuteKey(fromTier: "bronze" | "silver") {
    const { ok } = await postJson(`/api/keys/transmute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_tier: fromTier }),
    });
    if (ok) void refresh();
  }

  async function joinQuest() {
    const { ok } = await postJson(`/api/quest/join`, { method: "POST" });
    if (ok) void refresh();
  }

  async function startQuest(variant: QuestVariant, elite: boolean, monsterCount?: number) {
    const { ok } = await postJson(`/api/quest/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variant, elite, ...(monsterCount && monsterCount > 1 ? { monster_count: monsterCount } : {}) }),
    });
    if (ok) void refresh();
  }

  async function takeJob(jobId: string) {
    const { ok } = await postJson("/api/board/take", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId }),
    });
    if (ok) void refresh();
  }

  async function startHunt(tier: number, monsterCount: number) {
    const { ok } = await postJson("/api/hunt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier, monster_count: monsterCount }),
    });
    if (ok) void refresh();
  }

  async function treasureTake(questId: number, pick: number) {
    const { ok } = await postJson(`/api/quest/${questId}/dungeon/treasure_take`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pick }),
    });
    if (ok) void refresh();
  }

  if (state.kind === "loading") return <Centered>Loading…</Centered>;
  if (state.kind === "anon") return <Login onSuccess={refresh} />;

  // Dungeon quests use the immersive DungeonView full-screen experience.
  // This check runs before the activeCombat guard so dungeon combat stays
  // in-room instead of launching the separate CombatPage.
  // Grid dungeons (scene.graph present) use the new GridDungeonView;
  // legacy linear expeditions use the original DungeonView.
  if (state.kind === "auth" && state.activeQuest?.quest.scene.variant === "dungeon" && state.me.character) {
    const aq = state.activeQuest;
    const chr = state.me.character;
    if (aq.quest.scene.graph) {
      return (
        <>
          <GridDungeonView
            questId={aq.quest.id}
            selfId={state.me.slack_user_id}
            scene={aq.quest.scene as unknown as Parameters<typeof GridDungeonView>[0]["scene"]}
            party={aq.party as unknown as Parameters<typeof GridDungeonView>[0]["party"]}
            character={chr as unknown as Parameters<typeof GridDungeonView>[0]["character"]}
            hasWebCombat={hasWebCombat}
            onOpenInventory={() => setInventoryOpen(true)}
            onExit={() => void refresh()}
            onRefresh={() => void refresh()}
          />
          {inventoryOpen && (
            <InventoryFullScreen
              items={state.inventory}
              inQuest={true}
              selfId={state.me.slack_user_id}
              characterLevel={chr.level}
              character={chr}
              onEquip={equipItem}
              onUnequip={unequipItem}
              onSell={sellItem}
              onUse={useItem}
              onGive={giveItem}
              onClose={() => setInventoryOpen(false)}
            />
          )}
        </>
      );
    }
    return (
      <DungeonView
        questId={aq.quest.id}
        selfId={state.me.slack_user_id}
        scene={aq.quest.scene}
        party={aq.party}
        character={chr}
        hasWebCombat={hasWebCombat}
        myKeys={{ bronze: chr.keys_bronze, silver: chr.keys_silver, gold: chr.keys_gold }}
        onChooseDoor={(pick) => chooseDoor(aq.quest.id, pick)}
        onTrapChoose={(pick) => trapChoose(aq.quest.id, pick)}
        onLockboxChoose={(pick) => lockboxChoose(aq.quest.id, pick)}
        onNpcChoose={(pick) => npcChoose(aq.quest.id, pick)}
        onMerchantChoose={(pick) => merchantChoose(aq.quest.id, pick)}
        onTreasureTake={(pick) => treasureTake(aq.quest.id, pick)}
        onExit={() => void refresh()}
        onRefresh={() => void refresh()}
      />
    );
  }

  if (activeCombat) {
    const chr = state.me.character;
    return (
      <CombatErrorBoundary onReset={() => { setActiveCombat(null); setCombatDismissed(true); void refresh(); }}>
        <CombatPage
          questId={activeCombat.questId}
          selfId={state.me.slack_user_id}
          onOpenInventory={chr ? () => setInventoryOpen(true) : undefined}
          onExit={() => {
            setActiveCombat(null);
            setCombatDismissed(true);
            // Optimistically clear activeQuest so React 18's automatic batching
            // renders a clean town view immediately — avoids the brief "engagement
            // screen" flash before refresh() returns the completed quest state.
            setState((prev) => prev.kind === "auth" ? { ...prev, activeQuest: null } : prev);
            void refresh();
          }}
        />
        {inventoryOpen && chr && (
          <InventoryFullScreen
            items={state.inventory}
            inQuest={true}
            selfId={state.me.slack_user_id}
            characterLevel={chr.level}
            character={chr}
            onEquip={equipItem}
            onUnequip={unequipItem}
            onSell={sellItem}
            onUse={useItem}
            onGive={giveItem}
            onClose={() => setInventoryOpen(false)}
          />
        )}
      </CombatErrorBoundary>
    );
  }
  const inQuest = !!state.activeQuest;

  // Town section main content
  let sectionContent: React.ReactNode = null;
  if (!inQuest) {
    if (townSection === null) {
      sectionContent = (
        <>
          <TownMap
            art={state.townArt}
            onNavigate={setTownSection}
          />
          {state.joinable && (
            <JoinableQuestCard joinable={state.joinable} onJoin={joinQuest} />
          )}
          {state.questStats && state.questStats.total > 0 && (
            <QuestStatsCard stats={state.questStats} />
          )}
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 16, alignItems: "start" }}>
            {state.me.character && state.recent.length > 0 && (
              <RecentQuestsCard quests={state.recent} />
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <AdventurersCard selfId={state.me.slack_user_id} />
              {state.leaderboard.length > 0 && (
                <QuestLeaderboardCard entries={state.leaderboard} selfId={state.me.slack_user_id} />
              )}
            </div>
          </div>
        </>
      );
    } else {
      const townNav = <TownNav active={townSection} onNavigate={setTownSection} />;
      if (townSection === "job_board") {
        sectionContent = (
          <JobBoardSection
            board={state.board}
            overviewArt={state.townArt?.overview_art_url ?? null}
            selfId={state.me.slack_user_id}
            characterLevel={state.me.character?.level ?? 0}
            joinable={state.joinable}
            navOverlay={townNav}
            onTakeJob={takeJob}
            onStartQuest={startQuest}
            onJoin={joinQuest}
          />
        );
      } else if (townSection === "pub" && state.me.character && state.pub) {
        sectionContent = (
          <>
            <PubCard
              pub={state.pub}
              navOverlay={townNav}
              onBuyDrink={buyDrink}
              onRefresh={refreshPub}
            />
            <LiarsRollCard gold={state.pub.gold} onRefresh={refreshPub} />
            <SpdCard pub={state.pub} selfId={state.me.slack_user_id} onRefresh={refreshPub} />
            {state.pub.leaderboard && state.pub.leaderboard.length > 0 && (
              <PubLeaderboardCard entries={state.pub.leaderboard} />
            )}
          </>
        );
      } else if (townSection === "shop" && state.me.character && state.shop) {
        sectionContent = (
          <ShopCard
            shop={state.shop}
            navOverlay={townNav}
            onBuy={shopBuy}
            onHaggle={shopHaggle}
            onBuyStaple={shopBuyStaple}
            onRefresh={refreshShop}
            onRestock={restockShop}
          />
        );
      } else if (townSection === "inn" && state.me.character && state.inn) {
        sectionContent = (
          <InnCard inn={state.inn} navOverlay={townNav} onStay={innStay} />
        );
      } else if (townSection === "smithy" && state.me.character && state.smithy) {
        sectionContent = (
          <SmithyCard smithy={state.smithy} navOverlay={townNav} onSharpen={smithySharpen} />
        );
      } else if (townSection === "hunt" && state.me.character) {
        sectionContent = (
          <HuntSection
            characterLevel={state.me.character.level}
            overviewArt={state.townArt?.outskirts_art_url ?? null}
            navOverlay={townNav}
            onStartHunt={startHunt}
          />
        );
      } else if (townSection === "apothecary" && state.me.character) {
        sectionContent = (
          <ApothecaryCard
            apothecary={state.apothecary}
            navOverlay={townNav}
            selfId={state.me.slack_user_id}
            onBuyStaple={apothecaryBuyStaple}
            onRevive={apothecaryRevive}
            onRefresh={refreshApothecary}
          />
        );
      } else {
        sectionContent = townNav;
      }
    }
  }

  return (
    <Centered>
      <DashboardLayout
        main={
          <>
            {!state.activeQuest && state.lobbyQuest && (
              <LobbyView
                selfId={state.me.slack_user_id}
                onQuestStarted={() => void refresh()}
              />
            )}
            {state.activeQuest && (
              <ActiveQuestCard
                quest={state.activeQuest.quest}
                party={state.activeQuest.party}
                selfId={state.me.slack_user_id}
                combatInProgress={hasWebCombat}
                onStartCombat={() => startCombat(state.activeQuest!.quest.id)}
                onChooseDoor={(pick) => chooseDoor(state.activeQuest!.quest.id, pick)}
                onTrapChoose={(pick) => trapChoose(state.activeQuest!.quest.id, pick)}
                onLockboxChoose={(pick) => lockboxChoose(state.activeQuest!.quest.id, pick)}
                onNpcChoose={(pick) => npcChoose(state.activeQuest!.quest.id, pick)}
                onTreasureTake={(pick) => treasureTake(state.activeQuest!.quest.id, pick)}
                onMerchantChoose={(pick) => merchantChoose(state.activeQuest!.quest.id, pick)}
                onGraphMove={(dir) => graphMove(state.activeQuest!.quest.id, dir)}
                onGraphTake={(objectId) => graphTakeObject(state.activeQuest!.quest.id, objectId)}
                onGraphUse={(objectId) => graphUseObject(state.activeQuest!.quest.id, objectId)}
                myKeys={state.me.character ? {
                  bronze: state.me.character.keys_bronze,
                  silver: state.me.character.keys_silver,
                  gold: state.me.character.keys_gold,
                } : null}
              />
            )}
            {sectionContent}
          </>
        }
        side={
          <>
            <CharacterCard
              me={state.me}
              inventory={state.inventory}
              inQuest={!!state.activeQuest}
              onRest={rest}
              onSellKey={sellKeyConfirmed}
              onTransmuteKey={transmuteKey}
              onLogout={logout}
              onReroll={rerollCharacter}
              onSpend={spendStatPoint}
              onSaveNotifyPref={saveNotifyPref}
            />
            {state.me.character && (
              <InventoryCard
                items={state.inventory}
                inQuest={!!state.activeQuest}
                artUrl={state.inventoryArtUrl}
                selfId={state.me.slack_user_id}
                characterLevel={state.me.character.level}
                onEquip={equipItem}
                onUnequip={unequipItem}
                onSell={sellItem}
                onUse={useItem}
                onGive={giveItem}
                onOpenFull={() => setInventoryOpen(true)}
              />
            )}
          </>
        }
        footer={undefined}
      />
      {haggleResult && (
        <HaggleResultDialog result={haggleResult} onClose={() => setHaggleResult(null)} />
      )}
      {confirm && (
        <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      )}
      <AchievementToastStack
        queue={toastQueue}
        onDismiss={(id) => setToastQueue((q) => q.filter((a) => a.id !== id))}
      />
      {inventoryOpen && state.kind === "auth" && state.me.character && (
        <InventoryFullScreen
          items={state.inventory}
          inQuest={!!state.activeQuest}
          selfId={state.me.slack_user_id}
          characterLevel={state.me.character.level}
          character={state.me.character}
          onEquip={equipItem}
          onUnequip={unequipItem}
          onSell={sellItem}
          onUse={useItem}
          onGive={giveItem}
          onClose={() => setInventoryOpen(false)}
        />
      )}
    </Centered>
  );
}

function useIsMobile(breakpoint = 700) {
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.innerWidth < breakpoint);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < breakpoint);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [breakpoint]);
  return isMobile;
}

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError("Enter a 6-digit code.");
      return;
    }
    setPending(true);
    setError(null);
    const res = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ code }),
    });
    setPending(false);
    if (res.ok) {
      onSuccess();
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setError(
      body.error === "invalid_or_expired"
        ? "Invalid or expired code. Run /gq web-login in Slack for a new one."
        : "Couldn't verify. Try again.",
    );
  }

  return (
    <Centered>
      <div style={card}>
        <h1 style={h1}>Gantt Quest™</h1>
        <p style={muted}>
          Run <code style={kbd}>/gq web-login</code> in Slack to get a 6-digit
          code, then paste it below.
        </p>
        <form onSubmit={submit}>
          <input
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="123456"
            style={input}
            autoFocus
          />
          <button type="submit" disabled={pending} style={button}>
            {pending ? "Verifying…" : "Sign in"}
          </button>
        </form>
        {error && <p style={{ ...muted, color: "#c0392b" }}>{error}</p>}
      </div>
    </Centered>
  );
}

const DUNGEON_QUIPS = [
  "Licking envelopes...",
  "Finding the critical path...",
  "Arguing with the compiler...",
  "Reticulating splines...",
  "Partitioning the dungeon table...",
  "Rolling for encounter seeds...",
  "Deploying goblin infrastructure...",
  "Checking the backlog...",
  "Migrating the kobold schema...",
  "Resolving merge conflicts...",
  "Spinning up monster containers...",
  "Running goblin unit tests...",
  "Calculating technical debt...",
  "Allocating dungeon memory...",
  "Garbage collecting old traps...",
  "Compiling boss stats...",
  "Indexing treasure tables...",
  "Minifying the dungeon map...",
  "Transpiling ancient runes...",
  "Scaffolding the dungeon rooms...",
  "Installing trap dependencies...",
  "Debouncing monster spawns...",
  "Bundling loot drops...",
  "Optimizing the critical hit path...",
  "Linting the quest description...",
  "Running dungeon CI pipeline...",
  "Seeding the random number generator...",
  "Normalizing monster HP...",
  "Patching the dragon's firewall...",
  "Hydrating the puzzle state...",
  "Lazy loading the sub-boss...",
  "Memoizing the treasure map...",
  "Refactoring the skeleton code...",
  "Documenting nothing...",
  "Closing 47 browser tabs...",
  "Asking the AI nicely...",
  "Waiting for the AI to think...",
  "Negotiating with the dungeon master...",
  "Bribing the RNG...",
  "Rolling for flavor text...",
  "Generating procedural excuses...",
  "Herding the kobolds...",
  "Waking the sleeping dragon...",
  "Sharpening the puzzle edges...",
  "Greasing the trap hinges...",
  "Counting the treasure coins...",
  "Drafting the NPC dialogue...",
  "Stress-testing the dungeon walls...",
  "Proofreading the evil monologue...",
  "Tuning the ambient dungeon ambiance...",
  "Placing the 'secret' button...",
  "Connecting corridor nodes...",
  "Balancing the encounter table...",
  "Generating lore nobody will read...",
  "Summoning demons from the database...",
  "Calculating pathfinding for 30 goblins...",
  "Applying dark mode to the dungeon...",
  "Finding parking for the dragon...",
  "Persuading the mimic to behave...",
  "Filing paperwork for the boss fight...",
  "Checking if the treasure is load-bearing...",
  "Ensuring ADA compliance in the dungeon...",
  "Placing unnecessary torches...",
  "Polishing the boss's monologue...",
  "Arguing about room naming conventions...",
  "Deciding if the chest is a mimic...",
  "Randomizing the dead ends...",
  "Triple-checking the exit...",
  "Hiding the macguffin...",
  "Scheduling the ambush...",
  "Overengineering the puzzle...",
  "Reviewing the monster's PR...",
  "Approving the goblin's PTO request...",
  "Sourcing ethically-farmed loot...",
  "Loading ancient prophecy...",
  "Annotating the treasure map...",
  "Translating the rune inscriptions...",
  "Adjusting monster difficulty sliders...",
  "Generating 47 locked doors...",
  "Placing the one key you need...",
  "Balancing the loot economy...",
  "Installing the boss's dialogue tree...",
  "Verifying the dungeon doesn't softlock...",
  "Nesting callbacks in the trap logic...",
  "Spinning up the skeleton microservice...",
  "Querying the Dungeon-as-a-Service API...",
  "Rate limiting the goblin spawner...",
  "Provisioning a haunted room...",
  "Configuring the fog of war...",
  "Adding last-minute twists...",
  "Second-guessing everything...",
  "Clicking 'Generate' one more time...",
  "Definitely not panicking...",
  "This is fine. The dungeon is fine.",
  "Almost there... probably...",
  "Making sure the boss is scary enough...",
  "Confirming the dragon ate already...",
  "Checking if the wizard is available...",
  "Sourcing authentic cobblestone textures...",
  "Just one more yield point...",
  "Warming up the dungeon...",
  "The servers are thinking very hard...",
];

function DungeonLoadingBar() {
  const [progress, setProgress] = useState(0);
  const [quip, setQuip] = useState(
    () => DUNGEON_QUIPS[Math.floor(Math.random() * DUNGEON_QUIPS.length)],
  );
  const [quipVisible, setQuipVisible] = useState(true);

  useEffect(() => {
    const totalMs = 15_000;
    const tickMs = 80;
    const step = tickMs / totalMs;
    const t = setInterval(() => setProgress((p) => Math.min(1, p + step)), tickMs);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      setQuipVisible(false);
      setTimeout(() => {
        setQuip(DUNGEON_QUIPS[Math.floor(Math.random() * DUNGEON_QUIPS.length)]);
        setQuipVisible(true);
      }, 250);
    }, 3_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ height: 4, background: "#0e1520", borderRadius: 2, overflow: "hidden" }}>
        <div
          style={{
            height: "100%",
            background: "linear-gradient(90deg, #1e3a5f, #7dd3fc)",
            borderRadius: 2,
            width: `${progress * 100}%`,
            transition: "width 0.08s linear",
          }}
        />
      </div>
      <p style={{
        ...muted,
        fontSize: 11,
        marginTop: 7,
        textAlign: "center",
        fontStyle: "italic",
        opacity: quipVisible ? 0.85 : 0,
        transition: "opacity 0.25s ease",
      }}>
        {quip}
      </p>
    </div>
  );
}

interface QuestOption {
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

const QUEST_OPTIONS: QuestOption[] = [
  {
    id: "standard",
    label: "Standard",
    icon: "sword",
    accentColor: "#86efac",
    bg: "#1a2e1a",
    border: "#22543d",
    lockedBorder: "#2a2d33",
    tag: "Single encounter",
    description:
      "The dungeon master conjures a single AI-generated foe scaled to your party's level. A reliable source of XP, gold, and loot.",
    rewards: "Normal XP & gold",
    beginLabel: "Begin Standard Quest",
    pendingLabel: "Rolling…",
    minLevel: 1,
  },
  {
    id: "boss",
    label: "Boss",
    icon: "crown",
    accentColor: "#fca5a5",
    bg: "#2e1a1a",
    border: "#7f1d1d",
    lockedBorder: "#2a2d33",
    tag: "Climactic single foe",
    description:
      "One fearsome creature with elevated HP and an extra tier of attack power. Every action matters — a single mistake can turn the tide.",
    rewards: "Bonus XP + chance at rare drop",
    beginLabel: "Challenge the Boss",
    pendingLabel: "Rolling…",
    minLevel: 3,
  },
  {
    id: "gauntlet",
    label: "Gauntlet",
    icon: "crossed-swords",
    accentColor: "#c4b5fd",
    bg: "#1e1a2e",
    border: "#4c1d95",
    lockedBorder: "#2a2d33",
    tag: "3 waves, no recovery",
    description:
      "Three enemies back-to-back with no rest between waves. HP and mana carry over — positioning and resource management are everything.",
    rewards: "3× monster loot + milestone bonus",
    beginLabel: "Enter the Gauntlet",
    pendingLabel: "Rolling…",
    minLevel: 5,
  },
  {
    id: "dungeon",
    label: "Dungeon",
    icon: "tower",
    accentColor: "#7dd3fc",
    bg: "#111e2e",
    border: "#1e3a5f",
    lockedBorder: "#2a2d33",
    tag: "Multi-room crawl",
    description:
      "A 5-7 room AI-generated crawl — combat encounters, traps, lockboxes, and NPC events lead through a sub-boss to a treasure vault. Takes ~15s to generate.",
    rewards: "2.5× rewards + dungeon keys",
    beginLabel: "Descend into the Dungeon",
    pendingLabel: "Generating dungeon…",
    minLevel: 1,
  },
];

function StartQuestCard({
  characterLevel,
  onStart,
}: {
  characterLevel: number;
  onStart: (variant: QuestVariant, elite: boolean) => void;
}) {
  const [elite, setElite] = useState(false);
  const [selected, setSelected] = useState<QuestVariant | null>(null);
  const [pending, setPending] = useState<QuestVariant | null>(null);

  const selectedOption = QUEST_OPTIONS.find((o) => o.id === selected) ?? null;

  function go() {
    if (!selected || pending) return;
    setPending(selected);
    onStart(selected, elite);
  }

  return (
    <div style={{ ...card, borderColor: "#b89b3a" }}>
      <h2 style={h2}>Start a new quest</h2>

      {/* 2×2 radio card grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 }}>
        {QUEST_OPTIONS.map((opt) => {
          const locked = characterLevel < opt.minLevel;
          const isSelected = selected === opt.id;
          return (
            <button
              key={opt.id}
              disabled={locked || pending !== null}
              onClick={() => setSelected(isSelected ? null : opt.id)}
              style={{
                background: isSelected ? opt.bg : "#16181c",
                border: `2px solid ${isSelected ? opt.border : locked ? opt.lockedBorder : "#2a2d33"}`,
                borderRadius: 8,
                padding: "12px 14px",
                cursor: locked ? "not-allowed" : "pointer",
                textAlign: "left",
                opacity: locked ? 0.45 : 1,
                transition: "border-color 0.15s, background 0.15s",
                position: "relative",
              }}
            >
              {isSelected && (
                <span style={{
                  position: "absolute", top: 6, right: 8,
                  fontSize: 11, color: opt.accentColor, fontWeight: 700,
                }}>✓</span>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
                <Icon name={opt.icon} color={locked ? "#4a5060" : opt.accentColor} size={16} />
                <span style={{ fontWeight: 600, fontSize: 13, color: locked ? "#4a5060" : opt.accentColor, fontFamily: DISPLAY_FONT }}>
                  {opt.label}
                </span>
              </div>
              <div style={{ fontSize: 11, color: locked ? "#3a3d44" : "#6b7280" }}>
                {locked ? `Requires level ${opt.minLevel}` : opt.tag}
              </div>
            </button>
          );
        })}
      </div>

      {/* Description panel — expands when a variant is selected */}
      {selectedOption && (
        <div style={{
          marginTop: 12,
          padding: "14px 16px",
          background: selectedOption.bg,
          border: `1px solid ${selectedOption.border}`,
          borderRadius: 8,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <Icon name={selectedOption.icon} color={selectedOption.accentColor} size={18} />
            <span style={{ fontWeight: 700, fontSize: 14, color: selectedOption.accentColor, fontFamily: DISPLAY_FONT }}>
              {selectedOption.label}
            </span>
          </div>
          <p style={{ ...muted, fontSize: 13, margin: 0, lineHeight: 1.55 }}>
            {selectedOption.description}
          </p>
          <div style={{ marginTop: 8, fontSize: 12, color: "#9ca3af" }}>
            <Icon name="gold-bar" size={11} color="#fbbf24" /> {selectedOption.rewards}
          </div>

          {/* Elite toggle + begin button */}
          <label style={{
            display: "flex", alignItems: "center", gap: 8,
            marginTop: 14, fontSize: 13, color: "#e6e6e6", cursor: "pointer",
          }}>
            <input
              type="checkbox"
              checked={elite}
              onChange={(e) => setElite(e.target.checked)}
              style={{ accentColor: "#dc2626" }}
            />
            <span>
              <strong>Elite mode</strong>
              <span style={{ ...muted, marginLeft: 6 }}>(perma-death; tier bumped by 1)</span>
            </span>
          </label>

          <button
            onClick={go}
            disabled={pending !== null}
            style={{
              ...button,
              marginTop: 12,
              width: "100%",
              background: elite ? "#3a1a1a" : selectedOption.bg,
              color: selectedOption.accentColor,
              border: `1px solid ${elite ? "#7f1d1d" : selectedOption.border}`,
              fontWeight: 700,
              opacity: pending ? 0.6 : 1,
            }}
          >
            {pending
              ? selectedOption.pendingLabel
              : <><Icon name={selectedOption.icon} /> {selectedOption.beginLabel}</>}
          </button>
          {pending === "dungeon" && <DungeonLoadingBar />}
        </div>
      )}
    </div>
  );
}

function JoinableQuestCard({
  joinable,
  onJoin,
}: {
  joinable: JoinableQuest;
  onJoin: () => void;
}) {
  return (
    <div style={{ ...card, borderColor: "#7dd3fc" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h2 style={h2}>Quest in progress</h2>
        <SmallBadge>{joinable.variant}</SmallBadge>
        {joinable.elite && <SmallBadge>elite</SmallBadge>}
      </div>
      <p style={{ ...muted, fontSize: 13, marginTop: 8 }}>
        <strong style={{ color: "#f5f5f5" }}>{joinable.monster_name}</strong> ({joinable.monster_max_hp} HP)
      </p>
      {joinable.scene && (
        <p style={{ ...muted, fontSize: 13, fontStyle: "italic", marginTop: 4 }}>{joinable.scene}</p>
      )}
      <button
        onClick={onJoin}
        style={{ ...button, marginTop: 16, background: "#1f2a3a", color: "#7dd3fc" }}
      >
        <Icon name="shield" /> Join the fight
      </button>
      <p style={{ ...muted, fontSize: 11, marginTop: 8 }}>
        Monster max HP scales by 40% for the joiner. Your mana refills on join.
      </p>
    </div>
  );
}

function ActiveQuestCard({
  quest,
  party,
  selfId,
  combatInProgress,
  onStartCombat,
  onChooseDoor,
  onTrapChoose,
  onLockboxChoose,
  onNpcChoose,
  onTreasureTake,
  onMerchantChoose,
  onGraphMove,
  onGraphTake,
  onGraphUse,
  myKeys,
}: {
  quest: ActiveQuest;
  party: Character[];
  selfId: string;
  combatInProgress: boolean;
  onStartCombat: () => void;
  onChooseDoor: (pick: number) => void;
  onTrapChoose: (pick: number) => void;
  onLockboxChoose: (pick: number) => void;
  onNpcChoose: (pick: number) => void;
  onTreasureTake: (pick: number) => void;
  onMerchantChoose: (pick: number) => void;
  onGraphMove: (dir: DungeonDirection) => void;
  onGraphTake: (objectId: string) => void;
  onGraphUse: (objectId: string) => void;
  myKeys: { bronze: number; silver: number; gold: number } | null;
}) {
  const s = quest.scene;
  const variant = s.variant ?? "standard";
  const [inspected, setInspected] = useState<Character | null>(null);
  const selfMember = party.find((p) => p.slack_user_id === selfId) ?? null;
  const otherParty = party.filter((p) => p.slack_user_id !== selfId);

  return (
    <div style={{ ...card, borderColor: "#b89b3a", borderWidth: 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h2 style={h2}>Active Quest</h2>
        <VariantBadge variant={variant} />
        {quest.elite && <SmallBadge>elite</SmallBadge>}
        {variant === "boss" && s.boss_phase === 2 && (
          <SmallBadge>phase 2</SmallBadge>
        )}
        {variant === "gauntlet" && s.wave && s.total_waves && (
          <SmallBadge>
            wave {s.wave}/{s.total_waves}
          </SmallBadge>
        )}
        {variant === "dungeon" && s.expedition && (() => {
          const exp = s.expedition;
          const visited = exp.visited_count ?? 1;
          const middleTotal = (exp.middle_count ?? 0) + 4;
          return (
            <SmallBadge>room {visited}/{middleTotal}</SmallBadge>
          );
        })()}
      </div>
      {variant === "dungeon" && s.expedition?.theme && (
        <div style={{ ...muted, fontSize: 12, marginTop: 4, fontStyle: "italic" }}>
          🗺️ {s.expedition.theme}
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        {s.monster_art_url && (
          <ClickablePortrait
            src={s.monster_art_url}
            alt={s.monster_name}
            width="100%"
            height="auto"
            borderRadius={8}
            style={{ maxHeight: 280, objectFit: "cover", marginBottom: 12 }}
          />
        )}
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 600, color: "#f5f5f5", fontFamily: DISPLAY_FONT }}>
            {s.monster_name || "—"}
          </div>
          <div style={{ ...muted, fontVariantNumeric: "tabular-nums" }}>
            {s.monster_hp} / {s.monster_max_hp} HP
          </div>
        </div>
        <HpBar current={s.monster_hp} max={s.monster_max_hp} flavor="monster" />
        {s.monster_effects && s.monster_effects.length > 0 && (
          <EffectChips effects={s.monster_effects} />
        )}
      </div>

      {s.scene && (
        <div
          style={{
            ...muted,
            marginTop: 12,
            fontStyle: "italic",
            lineHeight: 1.5,
          }}
        >
          {s.scene}
        </div>
      )}

      {party.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div
            style={{
              ...muted,
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: 1.5,
              marginBottom: 8,
            }}
          >
            Party
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {selfMember && (
              <PartyMember
                fighter={selfMember}
                self={true}
              />
            )}
            {otherParty.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div
                  style={{
                    ...muted,
                    fontSize: 11,
                    textTransform: "uppercase",
                    letterSpacing: 1.5,
                    marginBottom: 6,
                  }}
                >
                  Other players ({otherParty.length})
                </div>
                <div style={{ display: "grid", gap: 8 }}>
                  {otherParty.map((p) => (
                    <PartyMember
                      key={p.slack_user_id}
                      fighter={p}
                      self={false}
                      onInspect={() => setInspected(p)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {inspected && (
        <CharacterInspectDialog
          character={inspected}
          onClose={() => setInspected(null)}
        />
      )}
      {(() => {
        // Graph dungeon takes priority over legacy expedition.
        if (s.graph) {
          const graph = s.graph;
          const node = graph.nodes[graph.current];
          const hasEncounter = !!(node?.encounter && !node.encounter.cleared);
          return (
            <>
              <GraphDungeonPanel
                graph={graph}
                node={node ?? null}
                onMove={onGraphMove}
                onTake={onGraphTake}
                onUse={onGraphUse}
              />
              {hasEncounter && (
                <button
                  onClick={onStartCombat}
                  style={{ ...button, marginTop: 12, background: "#b89b3a", color: "#0e0f12" }}
                >
                  <Icon name="sword" /> {combatInProgress ? "Resume Combat" : "Open Combat"}
                </button>
              )}
            </>
          );
        }
        const currentNode = s.expedition?.nodes[s.expedition.current];
        const pendingDoors = s.expedition?.pending_doors ?? [];
        if (variant === "dungeon" && pendingDoors.length > 0) {
          return (
            <DoorPicker
              doors={pendingDoors.map((idx) => s.expedition!.nodes[idx])}
              onPick={onChooseDoor}
            />
          );
        }
        if (variant === "dungeon" && currentNode?.type === "trap" && currentNode.trap_choices) {
          return <TrapPicker choices={currentNode.trap_choices} onPick={onTrapChoose} />;
        }
        if (
          variant === "dungeon" &&
          currentNode?.type === "lockbox" &&
          currentNode.loot_options &&
          currentNode.lock_tier
        ) {
          return (
            <LockboxPicker
              options={currentNode.loot_options}
              lockTier={currentNode.lock_tier}
              myKeys={myKeys}
              onPick={onLockboxChoose}
            />
          );
        }
        if (variant === "dungeon" && currentNode?.type === "npc" && currentNode.npc) {
          return <NpcPicker npc={currentNode.npc} onPick={onNpcChoose} />;
        }
        if (
          variant === "dungeon" &&
          currentNode?.type === "merchant" &&
          currentNode.loot_options
        ) {
          return (
            <MerchantPicker
              node={currentNode}
              onPick={onMerchantChoose}
            />
          );
        }
        if (
          variant === "dungeon" &&
          currentNode?.type === "treasure" &&
          currentNode.loot_options
        ) {
          return <TreasurePicker options={currentNode.loot_options} onPick={onTreasureTake} />;
        }
        const combatAvailable =
          variant === "standard" ||
          variant === "boss" ||
          variant === "gauntlet" ||
          (variant === "dungeon" && currentNode?.type === "combat" && s.monster_hp > 0);
        if (combatAvailable) {
          return (
            <button
              onClick={onStartCombat}
              style={{ ...button, marginTop: 20, background: "#b89b3a", color: "#0e0f12" }}
            >
              <Icon name="sword" /> {combatInProgress ? "Resume Combat" : "Open Combat"}
            </button>
          );
        }
        return null;
      })()}
    </div>
  );
}

const SKILL_LABEL: Record<SkillType, string> = { str: "STR", dex: "DEX", int: "INT" };

function TrapPicker({
  choices,
  onPick,
}: {
  choices: TrapChoice[];
  onPick: (pick: number) => void;
}) {
  return (
    <div style={{ marginTop: 20 }}>
      <div
        style={{
          ...muted,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 1.5,
          marginBottom: 8,
        }}
      >
        <Icon name="bear-trap" /> Trap — choose your approach
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {choices.map((c, i) => (
          <button
            key={i}
            onClick={() => onPick(i + 1)}
            style={{
              padding: "12px 14px",
              background: "#1d1f23",
              border: "1px solid #2a2d33",
              borderRadius: 8,
              textAlign: "left",
              cursor: "pointer",
              color: "#e6e6e6",
              fontFamily: "inherit",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 20 }}>{c.emoji}</span>
              <span style={{ fontWeight: 600 }}>{c.text}</span>
              <span style={{ ...muted, fontSize: 11 }}>
                · {SKILL_LABEL[c.skill]} check · fail = −{c.fail_damage} HP
              </span>
            </div>
          </button>
        ))}
      </div>
      <p style={{ ...muted, fontSize: 11, marginTop: 8 }}>
        Class experts auto-pass their skill. Others roll d6 — pass on 4+.
      </p>
    </div>
  );
}

const KEY_RANK: Record<KeyTier, number> = { bronze: 0, silver: 1, gold: 2 };
const KEY_LABEL: Record<KeyTier, string> = { bronze: "bronze", silver: "silver", gold: "gold" };

function hasMatchingKey(
  myKeys: { bronze: number; silver: number; gold: number } | null,
  lock: KeyTier,
): boolean {
  if (!myKeys) return false;
  return (
    (KEY_RANK.bronze >= KEY_RANK[lock] && myKeys.bronze > 0) ||
    (KEY_RANK.silver >= KEY_RANK[lock] && myKeys.silver > 0) ||
    (KEY_RANK.gold >= KEY_RANK[lock] && myKeys.gold > 0)
  );
}

function LockboxPicker({
  options,
  lockTier,
  myKeys,
  onPick,
}: {
  options: LootOption[];
  lockTier: KeyTier;
  myKeys: { bronze: number; silver: number; gold: number } | null;
  onPick: (pick: number) => void;
}) {
  const canUnlock = hasMatchingKey(myKeys, lockTier);
  return (
    <div style={{ marginTop: 20 }}>
      <div
        style={{
          ...muted,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 1.5,
          marginBottom: 8,
        }}
      >
        <Icon name="cubes" /> Lockbox — <KeyIcon tier={lockTier} /> {KEY_LABEL[lockTier]} lock {canUnlock ? "(you have a key)" : "(no matching key)"}
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {options.map((opt, i) => (
          <button
            key={i}
            onClick={() => onPick(i + 1)}
            disabled={!canUnlock}
            style={{
              padding: "12px 14px",
              background: canUnlock ? "#1d1f23" : "#15171b",
              border: "1px solid " + (canUnlock ? "#2a2d33" : "#222428"),
              borderRadius: 8,
              textAlign: "left",
              cursor: canUnlock ? "pointer" : "not-allowed",
              color: canUnlock ? "#e6e6e6" : "#6a7080",
              fontFamily: "inherit",
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 600 }}>{opt.name}</span>
              <span style={{ ...muted, fontSize: 11 }}>
                · {opt.rarity} {opt.slot ? SLOT_LABELS[opt.slot] : opt.item_type} +{opt.power}{opt.stat_bonus && statBonusSummary(opt.stat_bonus) ? ` · ${statBonusSummary(opt.stat_bonus)}` : ""}
              </span>
            </div>
            {opt.flavor && (
              <div style={{ ...muted, fontSize: 12, marginTop: 4, fontStyle: "italic" }}>
                {opt.flavor}
              </div>
            )}
          </button>
        ))}
        <button
          onClick={() => onPick(options.length + 1)}
          style={{
            padding: "12px 14px",
            background: "transparent",
            border: "1px solid #2a2d33",
            borderRadius: 8,
            cursor: "pointer",
            color: "#9aa0a6",
            fontFamily: "inherit",
          }}
        >
          Skip (no key spent)
        </button>
      </div>
    </div>
  );
}

function TreasurePicker({
  options,
  onPick,
}: {
  options: LootOption[];
  onPick: (pick: number) => void;
}) {
  return (
    <div style={{ marginTop: 20 }}>
      <div
        style={{
          ...muted,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 1.5,
          marginBottom: 8,
        }}
      >
        <Icon name="gold-bar" /> Treasure — pick one. Sealing the dungeon.
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {options.map((opt, i) => (
          <button
            key={i}
            onClick={() => onPick(i + 1)}
            style={{
              padding: "12px 14px",
              background: "#1d1f23",
              border: "1px solid #b89b3a",
              borderRadius: 8,
              textAlign: "left",
              cursor: "pointer",
              color: "#e6e6e6",
              fontFamily: "inherit",
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 600 }}>{opt.name}</span>
              <span style={{ ...muted, fontSize: 11 }}>
                · {opt.rarity} {opt.slot ? SLOT_LABELS[opt.slot] : opt.item_type} +{opt.power}{opt.stat_bonus && statBonusSummary(opt.stat_bonus) ? ` · ${statBonusSummary(opt.stat_bonus)}` : ""}
              </span>
            </div>
            {opt.flavor && (
              <div style={{ ...muted, fontSize: 12, marginTop: 4, fontStyle: "italic" }}>
                {opt.flavor}
              </div>
            )}
          </button>
        ))}
      </div>
      <p style={{ ...muted, fontSize: 11, marginTop: 8 }}>
        Other option is left in the chest. Quest completes; spoils awarded to the party.
      </p>
    </div>
  );
}

const DIR_LABEL: Record<DungeonDirection, string> = { n: "N", e: "E", s: "S", w: "W" };
const DIR_FULL: Record<DungeonDirection, string> = { n: "North", e: "East", s: "South", w: "West" };

function GraphDungeonPanel({
  graph,
  node,
  onMove,
  onTake,
  onUse,
}: {
  graph: DungeonGraph;
  node: DungeonNode | null;
  onMove: (dir: DungeonDirection) => void;
  onTake: (objectId: string) => void;
  onUse: (objectId: string) => void;
}) {
  if (!node) return <div style={{ ...muted, marginTop: 16, fontStyle: "italic" }}>Dungeon state corrupted.</div>;

  const allDirs: DungeonDirection[] = ["n", "e", "s", "w"];
  const activeObjects = node.objects.filter(o => !o.used || o.takeable);

  return (
    <div style={{ marginTop: 16 }}>
      {node.name && (
        <div style={{ fontSize: 13, fontWeight: 600, color: "#b89b3a", marginBottom: 6, fontFamily: DISPLAY_FONT }}>
          {node.name}
        </div>
      )}
      <div style={{ ...muted, fontStyle: "italic", lineHeight: 1.5, marginBottom: 12 }}>
        {node.description}
      </div>

      {node.encounter && !node.encounter.cleared && (
        <div style={{ background: "#1a0d0d", border: "1px solid #7a3030", borderRadius: 6, padding: "8px 12px", marginBottom: 12 }}>
          <span style={{ color: "#e06060", fontWeight: 600 }}>
            ⚔ {node.encounter.monsters[0]?.name ?? "Enemy"} lurks here. Fight before moving!
          </span>
        </div>
      )}
      {node.encounter?.cleared && (
        <div style={{ color: "#5a9e5a", fontSize: 12, marginBottom: 10 }}>✓ Encounter cleared</div>
      )}

      {/* Compass exits */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 6 }}>
          Exits
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {allDirs.map((dir) => {
            const targetId = node.exits[dir];
            if (!targetId) return null;
            const targetNode = graph.nodes[targetId];
            const explored = targetNode?.visited ?? false;
            const blocked = !!(node.encounter && !node.encounter.cleared);
            return (
              <button
                key={dir}
                onClick={() => !blocked && onMove(dir)}
                disabled={blocked}
                title={`${DIR_FULL[dir]}${explored ? "" : " (unexplored)"}`}
                style={{
                  padding: "6px 14px",
                  background: blocked ? "#1a1c20" : "#1d1f23",
                  border: `1px solid ${blocked ? "#333" : "#3a3d44"}`,
                  borderRadius: 6,
                  color: blocked ? "#555" : (explored ? "#e6e6e6" : "#b89b3a"),
                  cursor: blocked ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                  fontWeight: 600,
                  fontSize: 13,
                  opacity: blocked ? 0.5 : 1,
                }}
              >
                {DIR_LABEL[dir]}{!explored ? " ?" : ""}
              </button>
            );
          })}
          {allDirs.every(d => !node.exits[d]) && (
            <span style={{ ...muted, fontSize: 13, fontStyle: "italic" }}>No exits.</span>
          )}
        </div>
      </div>

      {/* Objects */}
      {activeObjects.length > 0 && (
        <div>
          <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 6 }}>
            Objects
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            {activeObjects.map((obj) => (
              <div key={obj.id} style={{ display: "flex", alignItems: "center", gap: 8, background: "#1d1f23", border: "1px solid #2a2d33", borderRadius: 6, padding: "8px 12px" }}>
                <span style={{ flex: 1, color: "#e6e6e6", fontSize: 13 }}>{obj.name}</span>
                {obj.takeable && !obj.used && (
                  <button
                    onClick={() => onTake(obj.id)}
                    style={{ padding: "4px 10px", background: "#23351a", border: "1px solid #3a5528", borderRadius: 4, color: "#8bc96e", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}
                  >
                    Take
                  </button>
                )}
                {obj.on_use && !obj.used && (
                  <button
                    onClick={() => onUse(obj.id)}
                    style={{ padding: "4px 10px", background: "#1a2535", border: "1px solid #2a3d5a", borderRadius: 4, color: "#6ea8c9", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}
                  >
                    Use
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Merchant room: buy an item from the in-dungeon merchant or walk past.
// pick 1..N = buy item N; pick N+1 = walk past (stock evaporates once advanced).
function MerchantPicker({
  node,
  onPick,
}: {
  node: ExpeditionNode;
  onPick: (pick: number) => void;
}) {
  const stock = node.loot_options ?? [];
  const greeting = node.npc?.greeting;
  return (
    <div style={{ marginTop: 20 }}>
      <div
        style={{
          ...muted,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 1.5,
          marginBottom: 8,
        }}
      >
        <Icon name="gem-pendant" /> Merchant
      </div>
      {greeting && (
        <p style={{ ...muted, fontSize: 13, fontStyle: "italic", marginBottom: 8 }}>
          "{greeting}"
        </p>
      )}
      {stock.length === 0 ? (
        <p style={{ ...muted, fontSize: 13, marginBottom: 8 }}>
          The merchant's stall is empty — you bought everything good.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {stock.map((opt, i) => {
            const price = priceFor(opt.item_type, opt.rarity);
            return (
              <button
                key={i}
                onClick={() => onPick(i + 1)}
                style={{
                  padding: "12px 14px",
                  background: "#1d1f23",
                  border: "1px solid #2a2d33",
                  borderRadius: 8,
                  textAlign: "left",
                  cursor: "pointer",
                  color: "#e6e6e6",
                  fontFamily: "inherit",
                }}
              >
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                  <div>
                    <span style={{ fontWeight: 600 }}>{opt.name}</span>
                    <span style={{ ...muted, fontSize: 11, marginLeft: 6 }}>
                      · {opt.rarity} {opt.slot ? SLOT_LABELS[opt.slot] : opt.item_type} +{opt.power}{opt.stat_bonus && statBonusSummary(opt.stat_bonus) ? ` · ${statBonusSummary(opt.stat_bonus)}` : ""}
                    </span>
                  </div>
                  <span style={{ color: "#fbbf24", fontWeight: 600, fontSize: 13 }}>{price}g</span>
                </div>
                {opt.flavor && (
                  <div style={{ ...muted, fontSize: 12, marginTop: 4, fontStyle: "italic" }}>
                    {opt.flavor}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
      <button
        onClick={() => onPick(stock.length + 1)}
        style={{
          marginTop: 8,
          padding: "10px 14px",
          background: "transparent",
          border: "1px solid #2a2d33",
          borderRadius: 8,
          cursor: "pointer",
          color: "#9aa0a6",
          fontFamily: "inherit",
          width: "100%",
        }}
      >
        Walk past
      </button>
      <p style={{ ...muted, fontSize: 11, marginTop: 8 }}>
        Stock evaporates once you leave. Prices match the town shop.
      </p>
    </div>
  );
}

function NpcPicker({ npc, onPick }: { npc: NpcOffer; onPick: (pick: number) => void }) {
  return (
    <div style={{ marginTop: 20 }}>
      <div
        style={{
          ...muted,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 1.5,
          marginBottom: 8,
        }}
      >
        <Icon name="hood" /> Stranger
      </div>
      <p style={{ ...muted, fontSize: 13, fontStyle: "italic", marginBottom: 8 }}>
        “{npc.greeting}”
      </p>
      <p style={{ ...muted, fontSize: 12, marginBottom: 12 }}>
        Offers: <strong>{npc.item.name}</strong> ({npc.item.rarity} {npc.item.slot ? SLOT_LABELS[npc.item.slot] : npc.item.item_type} +{npc.item.power}{npc.item.stat_bonus && statBonusSummary(npc.item.stat_bonus) ? ` · ${statBonusSummary(npc.item.stat_bonus)}` : ""})
      </p>
      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "1fr 1fr" }}>
        <button
          onClick={() => onPick(1)}
          style={{
            ...button,
            marginTop: 0,
            background: "#1f3a1f",
            color: "#86efac",
            border: "1px solid #2a5a2a",
          }}
        >
          Trust
        </button>
        <button
          onClick={() => onPick(2)}
          style={{
            ...button,
            marginTop: 0,
            background: "#33363d",
            color: "#e6e6e6",
          }}
        >
          Refuse
        </button>
      </div>
      <p style={{ ...muted, fontSize: 11, marginTop: 8 }}>
        Trust rolls d6 + class trust mod — 1-2 betrayed, 3 tainted (item + bleed),
        4+ clean.
      </p>
    </div>
  );
}

// ra-* icon names for dungeon room types, rendered via <Icon name={...}>.
const ROOM_TYPE_ICON: Record<ExpeditionNodeType, string> = {
  combat: "sword",
  trap: "bear-trap",
  lockbox: "cubes",
  npc: "crystal-wand",
  treasure: "gold-bar",
  merchant: "gem-pendant",
};

function DoorPicker({
  doors,
  onPick,
}: {
  doors: ExpeditionNode[];
  onPick: (pick: number) => void;
}) {
  return (
    <div style={{ marginTop: 20 }}>
      <div
        style={{
          ...muted,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 1.5,
          marginBottom: 8,
        }}
      >
        Pick a door
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {doors.map((node, i) => (
          <button
            key={i}
            onClick={() => onPick(i + 1)}
            style={{
              padding: "12px 14px",
              background: "#1d1f23",
              border: "1px solid #b89b3a",
              borderRadius: 8,
              textAlign: "left",
              cursor: "pointer",
              color: "#e6e6e6",
              fontFamily: "inherit",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Icon name={ROOM_TYPE_ICON[node.type]} size={20} color="#cbd5e1" />
              <span style={{ fontWeight: 600, textTransform: "capitalize" }}>{node.type}</span>
              {node.type === "combat" && node.monster_name && (
                <span style={{ ...muted, fontSize: 12 }}>· {node.monster_name}</span>
              )}
            </div>
            {node.scene && (
              <div style={{ ...muted, fontSize: 12, marginTop: 4, fontStyle: "italic" }}>
                {node.scene}
              </div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function PartyMember({ fighter, self, onInspect }: { fighter: Character; self: boolean; onInspect?: () => void }) {
  const downed =
    fighter.downed_until !== null && fighter.downed_until > Date.now();
  return (
    <div
      style={{
        padding: 12,
        background: "#1d1f23",
        borderRadius: 8,
        border: self ? "1px solid #3a7bd5" : "1px solid transparent",
        opacity: downed ? 0.6 : 1,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 15, fontFamily: DISPLAY_FONT }}>
            {fighter.name}
          </span>
          {fighter.slack_username && (
            <span style={{ fontSize: 12, color: "#7dd3fc" }}>@{fighter.slack_username}</span>
          )}
          <span style={{ ...muted, fontSize: 12 }}>
            {fighter.class} • Lv {fighter.level}
          </span>
          {self && <SmallBadge>you</SmallBadge>}
          {downed && (
            <span style={{ ...smallBadge, background: "#3a1f1f", color: "#ff7676", borderColor: "#5a2a2a" }}>
              downed
            </span>
          )}
          <PositionBadge position={fighter.position} />
        </div>
        <div style={{ ...muted, fontVariantNumeric: "tabular-nums" }}>
          {fighter.hp}/{fighter.max_hp}
          {fighter.shield > 0 && (
            <span style={{ color: "#7c83ff", marginLeft: 8 }}>+{fighter.shield} sh</span>
          )}
        </div>
      </div>
      <HpBar current={fighter.hp} max={fighter.max_hp} flavor="player" />
      {fighter.max_mana > 0 && (
        <div style={{ marginTop: 6 }}>
          <ManaBar current={fighter.mana} max={fighter.max_mana} />
        </div>
      )}
      {!self && onInspect && (
        <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
          <button
            onClick={onInspect}
            style={{
              ...button,
              padding: "8px 10px",
              fontSize: 12,
              background: "#1f2a3a",
              color: "#7dd3fc",
              borderRadius: 6,
            }}
          >
            Inspect
          </button>
        </div>
      )}
    </div>
  );
}

const DOLL_LAYOUT: (EquipSlot | null)[] = [
  null, "helmet", null,
  "main_hand", "body", "off_hand",
  "amulet", "pants", "ring",
  null, "boots", null,
];

function ReadOnlyDoll({ items }: { items: Item[] }) {
  const bySlot = (slot: EquipSlot) => items.find((i) => i.slot === slot);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 52px)", gap: 4, justifyContent: "center" }}>
      {DOLL_LAYOUT.map((slot, i) => {
        if (!slot) return <div key={i} />;
        const item = bySlot(slot);
        const rc = item ? RARITY_COLOR[item.rarity as Rarity] : null;
        return (
          <div
            key={slot}
            title={item ? `${item.item_name} (+${item.power})` : SLOT_LABELS[slot]}
            style={{
              width: 52, height: 52,
              border: `1px solid ${rc ? `${rc}66` : "#2a2d33"}`,
              borderRadius: 8,
              background: item ? `${rc}11` : "#0e0f12",
              display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center",
              gap: 2, position: "relative", overflow: "hidden",
            }}
          >
            {item ? (
              <>
                <Icon name={SLOT_ICON[slot]} size={22} color={rc ?? "#6b7280"} />
                <span style={{ fontSize: 9, color: rc ?? "#6b7280", fontWeight: 700, lineHeight: 1 }}>+{item.power}</span>
                {item.sharpens_count > 0 && (
                  <div style={{ position: "absolute", top: 2, right: 2, fontSize: 7, color: "#fb923c", fontWeight: 700 }}>
                    ×{item.sharpens_count}
                  </div>
                )}
              </>
            ) : (
              <Icon name={SLOT_ICON[slot]} size={18} color="#2a2d33" />
            )}
          </div>
        );
      })}
    </div>
  );
}

function CharacterInspectDialog({
  character,
  onClose,
}: {
  character: Character;
  onClose: () => void;
}) {
  const isDowned = character.downed_until !== null && character.downed_until > Date.now();
  const cxpAtLevel = xpForLevel(character.level);
  const cxpAtNext = xpForLevel(character.level + 1);
  const cxpIntoLevel = Math.max(0, character.xp - cxpAtLevel);
  const cxpSpan = cxpAtNext - cxpAtLevel;
  const cxpPct = cxpSpan > 0 ? Math.min(1, cxpIntoLevel / cxpSpan) : 1;
  const [equippedItems, setEquippedItems] = useState<Item[]>([]);
  useEffect(() => {
    fetch(`/api/character/${encodeURIComponent(character.slack_user_id)}/equipped`, { credentials: "include" })
      .then((r) => r.json() as Promise<{ items?: Item[] }>)
      .then((d) => { if (d.items) setEquippedItems(d.items); })
      .catch(() => {});
  }, [character.slack_user_id]);
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.78)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        zIndex: 999,
      }}
      role="dialog"
      aria-modal="true"
    >
      <div
        style={{
          width: "min(760px, 100%)",
          maxHeight: "calc(100vh - 40px)",
          overflowY: "auto",
          background: "#111214",
          border: "1px solid #2a2d33",
          borderRadius: 16,
          padding: 22,
          boxShadow: "0 18px 60px rgba(0,0,0,0.45)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 18,
          }}
        >
          <div>
            <h2 style={h2}>Inspect {character.name}</h2>
            <p style={{ ...muted, margin: 0 }}>
              {character.class} • Lv {character.level}
              {character.slack_username ? ` • @${character.slack_username}` : ""}
            </p>
            <div style={{ marginTop: 6, minWidth: 200 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#6b7280", marginBottom: 3 }}>
                <span style={{ color: "#d97706", fontWeight: 600, fontFamily: DISPLAY_FONT }}>XP</span>
                <span>{cxpIntoLevel} / {cxpSpan} → Lv {character.level + 1}</span>
              </div>
              <div style={{ height: 5, background: "#1a1a1f", borderRadius: 3, overflow: "hidden" }}>
                <div style={{
                  width: `${cxpPct * 100}%`,
                  height: "100%",
                  background: "linear-gradient(90deg, #92400e, #fbbf24)",
                  borderRadius: 3,
                }} />
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              ...button,
              background: "#1f2a3a",
              color: "#cbd5e1",
              padding: "10px 14px",
            }}
          >
            Close
          </button>
        </div>

        <Stats>
          <Stat
            label="HP"
            icon={<Icon name="health-normal" color="#86efac" size={36} />}
            value={`${character.hp} / ${character.max_hp}`}
          />
          <Stat
            label="Mana"
            icon={<Icon name="wizard-staff" color="#a78bfa" size={36} />}
            value={`${character.mana} / ${character.max_mana}`}
          />
          <Stat
            label="Position"
            icon={<Icon name="flag" color="#fbbf24" size={36} />}
            value={character.position}
          />
          <Stat
            label="Scars"
            icon={<Icon name="death-skull" color="#ef4444" size={36} />}
            value={
              <span title={character.scars.length > 0 ? character.scars.join(", ") : undefined}>
                {character.scars.length}
              </span>
            }
          />
          <Stat
            label="Keys"
            icon={<Icon name="key" color="#d1d5db" size={36} />}
            value={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <KeyIcon tier="bronze" size={16} /> {character.keys_bronze}
                <KeyIcon tier="silver" size={16} /> {character.keys_silver}
                <KeyIcon tier="gold" size={16} /> {character.keys_gold}
              </span>
            }
          />
          <Stat
            label="Gold"
            icon={<Icon name="cash" color="#fbbf24" size={36} />}
            value={character.gold.toString()}
          />
          <Stat
            label="Status"
            icon={<Icon name="shield" color="#7dd3fc" size={36} />}
            value={isDowned ? "Downed" : "Ready"}
          />
        </Stats>
        {equippedItems.length > 0 && (
          <div style={{ marginTop: 20, borderTop: "1px solid #1e2028", paddingTop: 16 }}>
            <div style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>
              Equipped
            </div>
            <ReadOnlyDoll items={equippedItems} />
          </div>
        )}
      </div>
    </div>
  );
}

function HpBar({
  current,
  max,
  flavor,
}: {
  current: number;
  max: number;
  flavor: "monster" | "player";
}) {
  const pct = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  let color = "#16a34a";
  if (pct < 0.25) color = "#dc2626";
  else if (pct < 0.5) color = "#d97706";
  if (flavor === "monster") {
    if (pct < 0.25) color = "#fca5a5";
    else if (pct < 0.5) color = "#fbbf24";
    else color = "#ef4444";
  }
  return (
    <div
      style={{
        marginTop: 6,
        width: "100%",
        height: 8,
        background: "#0e0f12",
        borderRadius: 4,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${pct * 100}%`,
          height: "100%",
          background: color,
          transition: "width 200ms ease",
        }}
      />
    </div>
  );
}

function ManaBar({ current, max }: { current: number; max: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <div style={{ ...muted, fontSize: 11, minWidth: 36 }}>
        {current}/{max}
      </div>
      <div
        style={{
          flex: 1,
          height: 6,
          background: "#0e0f12",
          borderRadius: 3,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct * 100}%`,
            height: "100%",
            background: "#6366f1",
          }}
        />
      </div>
    </div>
  );
}

function EffectChips({ effects }: { effects: StatusEffect[] }) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        marginTop: 8,
      }}
    >
      {effects.map((eff, i) => (
        <span
          key={i}
          style={{
            ...smallBadge,
            background: EFFECT_COLOR[eff.type] + "22",
            color: EFFECT_COLOR[eff.type],
            borderColor: EFFECT_COLOR[eff.type] + "55",
          }}
        >
          <Icon name={EFFECT_ICON[eff.type]} color={EFFECT_COLOR[eff.type]} /> {eff.type} {eff.remaining}t
        </span>
      ))}
    </div>
  );
}

function VariantBadge({ variant }: { variant: QuestVariant }) {
  return <SmallBadge>{variant}</SmallBadge>;
}

function PositionBadge({ position }: { position: "front" | "back" }) {
  return (
    <span
      style={{
        ...smallBadge,
        background: position === "front" ? "#3a2d1f" : "#1f2a3a",
        color: position === "front" ? "#fbbf24" : "#7dd3fc",
        borderColor: position === "front" ? "#5a432a" : "#2a3a5a",
      }}
    >
      {position}
    </span>
  );
}

function AdventurersCard({ selfId }: { selfId: string }) {
  const [characters, setCharacters] = useState<KnownCharacter[]>([]);
  const [loading, setLoading] = useState(true);
  const [sheet, setSheet] = useState<KnownCharacter | null>(null);

  useEffect(() => {
    fetch("/api/characters", { credentials: "include" })
      .then((r) => r.ok ? r.json() as Promise<{ characters: KnownCharacter[] }> : Promise.resolve({ characters: [] }))
      .then((b) => setCharacters(b.characters))
      .finally(() => setLoading(false));
  }, [selfId]);

  if (loading || characters.length === 0) return null;

  const nowMs = Date.now();

  return (
    <>
      <div style={card}>
        <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 10 }}>
          <Icon name="player" size={11} /> Adventurers
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {characters.slice(0, 8).map((ch) => {
            const msAgo = nowMs - (ch.last_active ?? 0);
            const secsAgo = Math.floor(msAgo / 1000);
            const isOnline = msAgo < 15 * 60 * 1000;
            const isRecent = msAgo < 60 * 60 * 1000;
            const ago = secsAgo < 60 ? "just now"
              : secsAgo < 3600 ? `${Math.floor(secsAgo / 60)}m ago`
              : secsAgo < 86400 ? `${Math.floor(secsAgo / 3600)}h ago`
              : `${Math.floor(secsAgo / 86400)}d ago`;
            const hpPct = ch.max_hp > 0 ? Math.max(0, Math.min(1, ch.hp / ch.max_hp)) : 0;
            // Prefer the per-character custom portrait, fall back to the
            // class default if the user hasn't generated one (or it 404s).
            const portraitSrc = adventurerCharPortrait(ch.name);
            const fallbackPortrait = adventurerClassPortrait(ch.class);

            const isDowned = ch.downed_until != null && ch.downed_until > nowMs;
            return (
              <button
                key={ch.slack_user_id}
                onClick={() => setSheet(ch)}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "6px 8px", borderRadius: 6, background: "#16181c",
                  border: `1px solid ${isDowned ? "#7f1d1d44" : "transparent"}`, cursor: "pointer", width: "100%",
                  textAlign: "left", fontFamily: "inherit",
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = isDowned ? "#7f1d1d88" : "#2a2d33"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = isDowned ? "#7f1d1d44" : "transparent"; }}
              >
                <div style={{ position: "relative", flexShrink: 0 }}>
                  <Avatar src={portraitSrc} fallbackSrc={fallbackPortrait} alt={ch.name} size={32} radius={4} fallbackIcon="player" fallbackColor="#4a5568" style={{ opacity: isDowned ? 0.5 : 1 }} />
                  {isDowned ? (
                    <span style={{
                      position: "absolute", bottom: -1, right: -1,
                      width: 12, height: 12, borderRadius: "50%",
                      background: "#7f1d1d", border: "1.5px solid #16181c",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      <Icon name="death-skull" size={7} color="#f87171" />
                    </span>
                  ) : isOnline && (
                    <span style={{
                      position: "absolute", bottom: -1, right: -1,
                      width: 8, height: 8, borderRadius: "50%",
                      background: "#22c55e", border: "1.5px solid #16181c",
                    }} />
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                    <span style={{ fontWeight: 600, fontSize: 12, color: "#f5f5f5", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ch.name}</span>
                    <span style={{ ...muted, fontSize: 11, flexShrink: 0 }}>Lv {ch.level}</span>
                  </div>
                  <div style={{ display: "flex", gap: 4, overflow: "hidden" }}>
                    <span style={{ ...muted, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ch.class}</span>
                    {ch.slack_username && <span style={{ fontSize: 11, color: "#7dd3fc", flexShrink: 0 }}>@{ch.slack_username}</span>}
                  </div>
                  <div style={{ marginTop: 3, height: 3, background: "#0e0f12", borderRadius: 2, overflow: "hidden" }}>
                    <div style={{ width: `${hpPct * 100}%`, height: "100%", background: hpPct < 0.25 ? "#dc2626" : hpPct < 0.5 ? "#d97706" : "#16a34a" }} />
                  </div>
                </div>
                <span style={{ ...muted, fontSize: 10, flexShrink: 0, color: isOnline ? "#22c55e" : isRecent ? "#9ca3af" : "#4a5060" }}>{ago}</span>
              </button>
            );
          })}
        </div>
      </div>
      {sheet && (
        <AdventurerSheet
          character={sheet}
          isOwn={sheet.slack_user_id === selfId}
          onClose={() => setSheet(null)}
        />
      )}
    </>
  );
}

function AchievementToast({ def, onDismiss }: { def: Achievement; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 5000);
    return () => clearTimeout(t);
  }, []);
  const gradient = `linear-gradient(135deg, ${def.gradient[0]}, ${def.gradient[1]})`;
  const glowColor = def.gradient[1];
  return (
    <div
      onClick={onDismiss}
      style={{
        display: "flex", alignItems: "center", gap: 12,
        background: "#13141a", border: "1px solid #2a2d33",
        borderRadius: 12, padding: "12px 16px",
        boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
        cursor: "pointer", minWidth: 280, maxWidth: 320,
        animation: "achievement-in 0.3s ease",
      }}
    >
      <div style={{
        width: 44, height: 44, borderRadius: "50%",
        background: gradient,
        display: "flex", alignItems: "center", justifyContent: "center",
        flexShrink: 0,
        boxShadow: `0 0 12px 3px ${glowColor}55`,
      }}>
        <i className={`ra ra-${def.icon}`} style={{ fontSize: 18, color: "#fff" }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 10, color: "#f59e0b", textTransform: "uppercase", letterSpacing: 1, fontWeight: 600, fontFamily: DISPLAY_FONT }}>
          Achievement Unlocked!
        </div>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#f5f5f5", marginTop: 2, fontFamily: DISPLAY_FONT }}>{def.title}</div>
        <div style={{ fontSize: 11, color: "#9ca3af", fontStyle: "italic", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{def.flavor}</div>
      </div>
    </div>
  );
}

function AchievementToastStack({ queue, onDismiss }: { queue: Achievement[]; onDismiss: (id: string) => void }) {
  if (queue.length === 0) return null;
  return (
    <div style={{
      position: "fixed", bottom: 24, right: 24,
      display: "flex", flexDirection: "column", gap: 10,
      zIndex: 9999, pointerEvents: "none",
    }}>
      {queue.map((def) => (
        <div key={def.id} style={{ pointerEvents: "auto" }}>
          <AchievementToast def={def} onDismiss={() => onDismiss(def.id)} />
        </div>
      ))}
    </div>
  );
}

function TrophyBadge({ def, earned, isOwn }: { def: Achievement; earned: EarnedAchievement | null; isOwn: boolean }) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: "top",
    middleware: [offset(8), flip(), shift({ padding: 8 })],
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([useDismiss(context)]);
  const isEarned = earned !== null;
  const gradient = `linear-gradient(135deg, ${def.gradient[0]}, ${def.gradient[1]})`;
  const glowColor = def.gradient[1];

  return (
    <>
      <button
        ref={refs.setReference}
        {...getReferenceProps()}
        onClick={() => isEarned && setOpen((o) => !o)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title={isEarned ? def.title : isOwn ? "???" : undefined}
        style={{
          width: 44, height: 44,
          borderRadius: "50%",
          background: gradient,
          border: "none",
          cursor: isEarned ? "pointer" : "default",
          display: "flex", alignItems: "center", justifyContent: "center",
          filter: isEarned ? undefined : "grayscale(1)",
          opacity: isEarned ? 1 : 0.2,
          boxShadow: isEarned ? `0 0 10px 2px ${glowColor}44, 0 0 4px 1px ${glowColor}88` : undefined,
          transition: "box-shadow 0.2s, opacity 0.2s",
          flexShrink: 0,
          position: "relative",
        }}
      >
        <i className={`ra ra-${def.icon}`} style={{ fontSize: 18, color: "#fff", textShadow: "0 1px 3px rgba(0,0,0,0.5)" }} />
        {isEarned && hovered && (
          <div style={{
            position: "absolute", bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
            background: "#1d1f23", border: "1px solid #2a2d33", borderRadius: 6,
            padding: "4px 8px", fontSize: 11, color: "#f5f5f5", whiteSpace: "nowrap",
            pointerEvents: "none", zIndex: 10,
          }}>
            {def.title}
          </div>
        )}
        {!isEarned && isOwn && hovered && (
          <div style={{
            position: "absolute", bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
            background: "#1d1f23", border: "1px solid #2a2d33", borderRadius: 6,
            padding: "4px 8px", fontSize: 11, color: "#6b7280", whiteSpace: "nowrap",
            pointerEvents: "none", zIndex: 10,
          }}>
            ???
          </div>
        )}
      </button>
      {isEarned && open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} initialFocus={-1}>
            <div
              ref={refs.setFloating}
              {...getFloatingProps()}
              style={{
                ...floatingStyles,
                background: "#13141a",
                border: "1px solid #2a2d33",
                borderRadius: 12,
                padding: 16,
                width: 240,
                zIndex: 500,
                boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
                <div style={{
                  width: 52, height: 52, borderRadius: "50%",
                  background: gradient,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  boxShadow: `0 0 14px 3px ${glowColor}55`,
                  flexShrink: 0,
                }}>
                  <i className={`ra ra-${def.icon}`} style={{ fontSize: 22, color: "#fff" }} />
                </div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13, color: "#f5f5f5", fontFamily: DISPLAY_FONT }}>{def.title}</div>
                  <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 2, textTransform: "uppercase", letterSpacing: 0.5, fontFamily: DISPLAY_FONT }}>{def.category}</div>
                </div>
              </div>
              <div style={{ fontSize: 12, color: "#818cf8", fontStyle: "italic", marginBottom: 6, lineHeight: 1.4 }}>{def.flavor}</div>
              <div style={{ fontSize: 11, color: "#9ca3af", lineHeight: 1.4, marginBottom: 8 }}>{def.description}</div>
              {earned && (
                <div style={{ fontSize: 10, color: "#4ade80", borderTop: "1px solid #2a2d33", paddingTop: 6 }}>
                  Earned {new Date(earned.unlocked_at).toLocaleDateString()}
                </div>
              )}
              <button
                onClick={() => setOpen(false)}
                style={{ position: "absolute", top: 8, right: 8, background: "none", border: "none", color: "#6b7280", cursor: "pointer", fontSize: 14, padding: 4 }}
              >✕</button>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}

function TrophyShelf({ earned, allDefs, isOwn }: { earned: EarnedAchievement[]; allDefs: Achievement[]; isOwn: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const earnedMap = new Map(earned.map((e) => [e.id, e]));
  const allEarnedDefs = isOwn ? allDefs : allDefs.filter((d) => earnedMap.has(d.id));
  if (allEarnedDefs.length === 0 && !isOwn) return null;

  // Collapsed: show last 5 most recently earned
  const sortedEarned = [...earned].sort((a, b) => b.unlocked_at - a.unlocked_at);
  const recent5Ids = new Set(sortedEarned.slice(0, 5).map((e) => e.id));
  const collapsedDefs = allDefs.filter((d) => recent5Ids.has(d.id));
  const visibleDefs = expanded ? allEarnedDefs : collapsedDefs;
  const count = earned.length;
  const label = isOwn ? `${count} / ${allDefs.length} earned` : `${count} earned`;
  const canExpand = allEarnedDefs.length > 5 || (isOwn && allDefs.length > 5);

  return (
    <div style={{ padding: "12px", background: "#1d1f23", borderRadius: 8, border: "1px solid #2a2d33" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: "#9ca3af", textTransform: "uppercase", letterSpacing: 1 }}>
          <Icon name="trophy" size={10} /> Trophies · {label}
        </div>
        {canExpand && (
          <button
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? "Collapse" : "Show all"}
            style={{
              background: "none", border: "none", cursor: "pointer", padding: "2px 4px",
              color: "#6b7280", fontFamily: "inherit", fontSize: 11, display: "flex", alignItems: "center", gap: 3,
            }}
          >
            {expanded ? "▼" : "▶"} {expanded ? "Less" : "All"}
          </button>
        )}
      </div>
      {count === 0 && !expanded ? (
        <p style={{ ...muted, fontSize: 12, margin: 0 }}>No trophies earned yet.</p>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {visibleDefs.map((def) => (
            <TrophyBadge key={def.id} def={def} earned={earnedMap.get(def.id) ?? null} isOwn={isOwn} />
          ))}
        </div>
      )}
    </div>
  );
}

function AdventurerSheet({ character, isOwn = false, onClose }: { character: KnownCharacter; isOwn?: boolean; onClose: () => void }) {
  const [sheetEarned, setSheetEarned] = useState<EarnedAchievement[]>(character.achievements ?? []);
  const [sheetDefs, setSheetDefs] = useState<Achievement[]>([]);
  const [sheetEquipped, setSheetEquipped] = useState<Item[]>([]);

  useEffect(() => {
    const url = isOwn ? "/api/achievements" : `/api/achievements/${character.slack_user_id}`;
    fetch(url, { credentials: "include" })
      .then((r) => r.ok ? r.json() as Promise<AchievementsResponse> : null)
      .then((body) => {
        if (body) {
          setSheetEarned(body.earned);
          setSheetDefs(body.definitions);
        }
      })
      .catch(() => {});
  }, [character.slack_user_id, isOwn]);

  useEffect(() => {
    fetch(`/api/character/${encodeURIComponent(character.slack_user_id)}/equipped`, { credentials: "include" })
      .then((r) => r.json() as Promise<{ items?: Item[] }>)
      .then((d) => { if (d.items) setSheetEquipped(d.items); })
      .catch(() => {});
  }, [character.slack_user_id]);

  const msAgo = Date.now() - (character.last_active ?? 0);
  const secsAgo = Math.floor(msAgo / 1000);
  const hpPct = character.max_hp > 0 ? Math.max(0, Math.min(1, character.hp / character.max_hp)) : 0;
  const xpAtLevel = xpForLevel(character.level);
  const xpAtNext = xpForLevel(character.level + 1);
  const xpIntoLevel = Math.max(0, character.xp - xpAtLevel);
  const xpSpan = xpAtNext - xpAtLevel;
  const xpPct = xpSpan > 0 ? Math.min(1, xpIntoLevel / xpSpan) : 1;
  const portraitSrc = adventurerCharPortrait(character.name);
  const fallbackPortrait = adventurerClassPortrait(character.class);
  const ago = secsAgo < 60 ? "just now"
    : secsAgo < 3600 ? `${Math.floor(secsAgo / 60)}m ago`
    : secsAgo < 86400 ? `${Math.floor(secsAgo / 3600)}h ago`
    : `${Math.floor(secsAgo / 86400)}d ago`;
  const isOnline = msAgo < 15 * 60 * 1000;

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 200 }}
      />
      <div style={{
        position: "fixed", top: 0, right: 0, bottom: 0, width: 300,
        background: "#13141a", borderLeft: "1px solid #2a2d33",
        zIndex: 201, overflowY: "auto", padding: "24px 20px",
        display: "flex", flexDirection: "column", gap: 16,
      }}>
        <button
          onClick={onClose}
          style={{
            position: "absolute", top: 14, right: 14,
            background: "none", border: "none", color: "#6b7280",
            cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 4,
          }}
        >✕</button>

        <Avatar src={portraitSrc} fallbackSrc={fallbackPortrait} alt={character.name} size={80} radius={8} fallbackIcon="player" fallbackColor="#4a5568" />

        <div>
          <h2 style={{ ...h2, margin: "0 0 2px" }}>{character.name}</h2>
          {character.slack_username && (
            <div style={{ fontSize: 13, color: "#7dd3fc", marginBottom: 2 }}>@{character.slack_username}</div>
          )}
          <div style={{ ...muted, fontSize: 13 }}>{character.class}</div>
          {classByName(character.class)?.blurb && (
            <div style={{ fontSize: 11, color: "#6b7280", fontStyle: "italic", marginTop: 3, lineHeight: 1.4 }}>
              {classByName(character.class)?.blurb}
            </div>
          )}
          <div style={{ ...muted, fontSize: 12, marginTop: 4, color: isOnline ? "#22c55e" : "#6b7280" }}>
            {isOnline ? "● Online" : `Last seen ${ago}`}
          </div>
        </div>

        <div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
            <span style={{ color: "#9ca3af" }}><Icon name="player" size={10} /> Level {character.level}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#9ca3af", marginBottom: 4 }}>
            <span><Icon name="health-normal" size={10} /> HP</span>
            <span style={{ color: hpPct < 0.25 ? "#fca5a5" : "#f5f5f5" }}>{character.hp} / {character.max_hp}</span>
          </div>
          <div style={{ height: 6, background: "#1d1f23", borderRadius: 3, overflow: "hidden", marginBottom: 12 }}>
            <div style={{ width: `${hpPct * 100}%`, height: "100%", background: hpPct < 0.25 ? "#dc2626" : hpPct < 0.5 ? "#d97706" : "#16a34a", transition: "width 0.3s" }} />
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#9ca3af", marginBottom: 4 }}>
            <span><Icon name="lightning-sword" size={10} /> XP</span>
            <span style={{ color: "#f5f5f5" }}>{xpIntoLevel} / {xpSpan}</span>
          </div>
          <div style={{ height: 6, background: "#1d1f23", borderRadius: 3, overflow: "hidden" }}>
            <div style={{ width: `${xpPct * 100}%`, height: "100%", background: "#6366f1", transition: "width 0.3s" }} />
          </div>
        </div>

        {character.str !== undefined && (() => {
          const stats: Stats = {
            str: character.str ?? 5,
            int_stat: character.int_stat ?? 5,
            vit: character.vit ?? 5,
            agi: character.agi ?? 5,
            dex: character.dex ?? 5,
          };
          const derived = deriveAll(stats, character.level);
          return (
            <div style={{ padding: "10px 12px", background: "#1d1f23", borderRadius: 8, border: "1px solid #2a2d33" }}>
              <div style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1, marginBottom: 7, fontFamily: DISPLAY_FONT }}>Stats</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 4, marginBottom: 7 }}>
                {(["str", "int_stat", "vit", "agi", "dex"] as StatKey[]).map((key) => (
                  <div key={key} style={{ textAlign: "center", background: "#13141a", borderRadius: 5, padding: "5px 3px" }}>
                    <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", fontFamily: DISPLAY_FONT }}>{key === "int_stat" ? "INT" : key.toUpperCase()}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#f5f5f5", fontFamily: DISPLAY_FONT }}>{stats[key]}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 9px", fontSize: 10, color: "#9ca3af" }}>
                <span>ATK {derived.attack_mod >= 0 ? `+${derived.attack_mod}` : derived.attack_mod}</span>
                <span>MAG {derived.magic_mod >= 0 ? `+${derived.magic_mod}` : derived.magic_mod}</span>
                <span>Dodge {Math.round(derived.dodge_chance * 100)}%</span>
                <span>Crit +{Math.round(derived.crit_bonus * 100)}%</span>
              </div>
            </div>
          );
        })()}

        {sheetEquipped.length > 0 && (
          <div style={{ padding: "10px 12px", background: "#1d1f23", borderRadius: 8, border: "1px solid #2a2d33" }}>
            <div style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8, fontFamily: DISPLAY_FONT }}>Equipment</div>
            <ReadOnlyDoll items={sheetEquipped} />
          </div>
        )}

        {character.scars && character.scars.length > 0 && (
          <div style={{ padding: "10px 12px", background: "#1d1f23", borderRadius: 8, border: "1px solid #2a2d33" }}>
            <div style={{ fontSize: 11, color: "#ef4444", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
              <Icon name="death-skull" size={10} /> {character.scars.length === 1 ? "1 Scar" : `${character.scars.length} Scars`}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {character.scars.map((scar, i) => (
                <div key={i} style={{ fontSize: 12, color: "#9ca3af", fontStyle: "italic" }}>"{scar}"</div>
              ))}
            </div>
          </div>
        )}

        {(sheetDefs.length > 0 || (isOwn && sheetEarned.length >= 0)) && (
          <TrophyShelf earned={sheetEarned} allDefs={sheetDefs} isOwn={isOwn} />
        )}
      </div>
    </>
  );
}

const PRIMARY_STAT_META: Record<string, { color: string; label: string; tooltip: (v: number, level: number) => string }> = {
  str:      { color: "#f87171", label: "STR", tooltip: (v) => `Attack modifier\nfloor((${v} − 5) / 2) = ${Math.floor((v - 5) / 2) >= 0 ? "+" : ""}${Math.floor((v - 5) / 2)}\nAdded to weapon damage rolls` },
  int_stat: { color: "#7dd3fc", label: "INT", tooltip: (v) => `Magic modifier\nfloor((${v} − 5) / 2) = ${Math.floor((v - 5) / 2) >= 0 ? "+" : ""}${Math.floor((v - 5) / 2)}\nAdded to spell & heal rolls\n\nStarting mana\n1 + floor(${v} / 4) = ${1 + Math.floor(v / 4)}` },
  vit:      { color: "#86efac", label: "VIT", tooltip: (v, level) => `Max HP\n16 + 2×${v} + 2×${level} = ${16 + 2 * v + 2 * level}\n\nArmor bonus\nfloor(max(0, ${v} − 5) / 4) = +${Math.floor(Math.max(0, v - 5) / 4)}\nPassive armor above 5 VIT` },
  agi:      { color: "#34d399", label: "AGI", tooltip: (v) => `Dodge chance\nmin(15%, (${v} − 5) × 1%) = ${Math.round(Math.min(0.15, Math.max(0, v - 5) * 0.01) * 100)}%\nFully negates a hit when dodged\n\nInitiative bonus\nfloor((${v} − 5) / 2) = ${Math.floor((v - 5) / 2) >= 0 ? "+" : ""}${Math.floor((v - 5) / 2)}\nAdded to d6 initiative roll` },
  dex:      { color: "#fbbf24", label: "DEX", tooltip: (v) => `Crit bonus\nmax(0, (${v} − 5) × 1%) = +${Math.round(Math.min(0.10, Math.max(0, v - 5) * 0.01) * 100)}%\nBonus crit chance (cap 10%)` },
};

function PrimaryStatCard({
  statKey, value, bonus, level,
}: {
  statKey: string; value: number; bonus: number; level: number;
}) {
  const [hovered, setHovered] = useState(false);
  const meta = PRIMARY_STAT_META[statKey];
  if (!meta) return null;
  return (
    <div
      style={{ position: "relative" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{
        textAlign: "center", borderRadius: 6, padding: "6px 4px",
        background: hovered ? "#22252c" : "#1d1f23",
        border: `1px solid ${hovered ? meta.color + "66" : "transparent"}`,
        cursor: "default", transition: "background 0.12s, border-color 0.12s",
      }}>
        <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.8, fontFamily: DISPLAY_FONT }}>
          {meta.label}
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, color: hovered ? meta.color : "#f5f5f5", lineHeight: 1.2, fontFamily: DISPLAY_FONT, transition: "color 0.12s" }}>
          {value}
        </div>
        {bonus > 0 && (
          <div style={{ fontSize: 8, color: "#86efac", lineHeight: 1.3 }}>+{bonus} gear</div>
        )}
      </div>
      {hovered && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: "50%",
          transform: "translateX(-50%)",
          background: "#0e1014", border: `1px solid ${meta.color}44`,
          borderRadius: 7, padding: "7px 10px", zIndex: 50,
          minWidth: 170, maxWidth: 230,
          boxShadow: `0 4px 16px rgba(0,0,0,0.7), 0 0 0 1px ${meta.color}22`,
          pointerEvents: "none",
          whiteSpace: "pre-line",
        }}>
          <div style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4, fontFamily: DISPLAY_FONT }}>{meta.label}</div>
          <div style={{ fontSize: 11, color: "#c9cdd4", lineHeight: 1.55, fontFamily: "monospace" }}>{meta.tooltip(value, level)}</div>
        </div>
      )}
    </div>
  );
}

function DerivedStatCard({
  icon, label, value, color, formula,
}: {
  icon: string; label: string; value: string; color: string; formula: string;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{ position: "relative" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{
        background: hovered ? "#22252c" : "#1d1f23",
        borderRadius: 7, padding: "6px 4px 5px",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
        border: `1px solid ${hovered ? color + "66" : color + "22"}`,
        cursor: "default", transition: "background 0.12s, border-color 0.12s",
      }}>
        <Icon name={icon} size={18} color={color} />
        <div style={{ fontSize: 14, fontWeight: 800, color, lineHeight: 1, fontFamily: DISPLAY_FONT }}>{value}</div>
        <div style={{ fontSize: 8, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.7, lineHeight: 1, fontFamily: DISPLAY_FONT }}>{label}</div>
      </div>
      {hovered && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: "50%",
          transform: "translateX(-50%)",
          background: "#0e1014", border: `1px solid ${color}44`,
          borderRadius: 7, padding: "7px 10px", zIndex: 50,
          minWidth: 160, maxWidth: 220,
          boxShadow: `0 4px 16px rgba(0,0,0,0.7), 0 0 0 1px ${color}22`,
          pointerEvents: "none",
          whiteSpace: "pre-line",
        }}>
          <div style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4, fontFamily: DISPLAY_FONT }}>{label}</div>
          <div style={{ fontSize: 11, color: "#c9cdd4", lineHeight: 1.55, fontFamily: "monospace" }}>{formula}</div>
        </div>
      )}
    </div>
  );
}

function CharacterCard({
  me,
  inventory,
  inQuest,
  onRest,
  onSellKey,
  onTransmuteKey,
  onLogout,
  onReroll,
  onSpend,
  onSaveNotifyPref,
}: {
  me: MeResponse;
  inventory: Item[];
  inQuest: boolean;
  onRest: (kind: "short" | "long") => void;
  onSellKey: (tier: "bronze" | "silver" | "gold") => void;
  onTransmuteKey: (fromTier: "bronze" | "silver") => void;
  onLogout: () => void;
  onReroll: () => Promise<void>;
  onSpend?: (stat: StatKey) => void;
  onSaveNotifyPref?: (pref: "thread" | "dm") => Promise<void>;
}) {
  const [trophyDefs, setTrophyDefs] = useState<Achievement[]>([]);
  const [trophyEarned, setTrophyEarned] = useState<EarnedAchievement[]>([]);
  useEffect(() => {
    fetch("/api/achievements")
      .then((r) => r.ok ? r.json() as Promise<AchievementsResponse> : null)
      .then((data) => {
        if (!data) return;
        setTrophyDefs(data.definitions);
        setTrophyEarned(data.earned);
      })
      .catch(() => {});
  }, [me.character?.slack_user_id]);
  const c = me.character;
  if (!c) {
    return (
      <div style={card}>
        <h1 style={h1}>No character yet</h1>
        <p style={muted}>
          Roll one up in Slack with <code style={kbd}>/gq quest</code>, then
          reload here.
        </p>
      </div>
    );
  }
  const xpAtLevel = xpForLevel(c.level);
  const xpAtNext = xpForLevel(c.level + 1);
  const xpIntoLevel = Math.max(0, c.xp - xpAtLevel);
  const xpSpan = xpAtNext - xpAtLevel;
  const xpPct = xpSpan > 0 ? Math.min(1, xpIntoLevel / xpSpan) : 1;
  const fullyRecovered = c.hp >= c.max_hp && c.mana >= c.max_mana;
  const downed = c.downed_until !== null && c.downed_until > Date.now();
  const equippedBySlot = (slot: EquipSlot) => inventory.find((i) => i.equipped && (i.slot === slot || (i.slot === null && i.item_type === (slot === "main_hand" ? "weapon" : slot === "body" ? "armor" : ""))));
  const bodyArmor = equippedBySlot("body");
  const helmetArmor = equippedBySlot("helmet");
  const pantsArmor = equippedBySlot("pants");
  const shieldArmor = inventory.find((i) => i.equipped && (i.slot === "off_hand" || i.item_subtype === "shield"));
  const armorPower = (bodyArmor?.power ?? 0) + Math.floor((helmetArmor?.power ?? 0) / 2) + Math.floor((pantsArmor?.power ?? 0) / 4) + (shieldArmor?.power ?? 0);
  const restDisabled = inQuest || downed || fullyRecovered;
  const portrait = me.char_art_url ?? me.class_art_url;
  const equipBonuses: Partial<Record<StatKey, number>> = {};
  for (const item of inventory) {
    if (item.equipped && item.stat_bonus) {
      for (const [k, v] of Object.entries(item.stat_bonus)) {
        equipBonuses[k as StatKey] = (equipBonuses[k as StatKey] ?? 0) + v;
      }
    }
  }
  const baseStats: Stats = {
    str: c.str ?? 5,
    int_stat: c.int_stat ?? 5,
    vit: c.vit ?? 5,
    agi: c.agi ?? 5,
    dex: c.dex ?? 5,
  };
  const primaryStats: Stats = {
    str: baseStats.str + (equipBonuses.str ?? 0),
    int_stat: baseStats.int_stat + (equipBonuses.int_stat ?? 0),
    vit: baseStats.vit + (equipBonuses.vit ?? 0),
    agi: baseStats.agi + (equipBonuses.agi ?? 0),
    dex: baseStats.dex + (equipBonuses.dex ?? 0),
  };
  const derivedStats = deriveAll(primaryStats, c.level);
  const hasUnspentPoints = (c.unspent_points ?? 0) > 0;
  const statHasData = c.str !== undefined;
  return (
    <div style={{ ...card, position: "relative" }}>
      <AccountPopover onLogout={onLogout} onReroll={onReroll} character={c} onSaveNotifyPref={onSaveNotifyPref} />
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 4 }}>
        <Avatar
          src={portrait}
          alt={`${c.class} portrait`}
          size={72}
          radius={8}
          fallbackIcon="player"
          fallbackColor="#6a7080"
        />
        <div style={{ minWidth: 0 }}>
          <h1 style={{ ...h1, margin: 0 }}>{c.name}</h1>
          {c.slack_username && (
            <p style={{ ...muted, margin: "2px 0 0", fontSize: 12, color: "#7dd3fc" }}>
              @{c.slack_username}
            </p>
          )}
          <p style={{ ...muted, margin: "4px 0 0" }}>
            {c.class} • Lv {c.level}
          </p>
          <p style={{ margin: "4px 0 0", fontSize: 11, color: "#6b7280", fontStyle: "italic", lineHeight: 1.4 }}>
            {classByName(c.class)?.blurb}
          </p>
          <div style={{ marginTop: 6, minWidth: 160 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#6b7280", marginBottom: 3 }}>
              <span style={{ color: "#d97706", fontWeight: 600 }}>XP</span>
              <span>{xpIntoLevel} / {xpSpan}</span>
            </div>
            <div style={{ height: 5, background: "#1a1a1f", borderRadius: 3, overflow: "hidden" }}>
              <div style={{
                width: `${xpPct * 100}%`,
                height: "100%",
                background: "linear-gradient(90deg, #92400e, #fbbf24)",
                borderRadius: 3,
                transition: "width 0.4s ease",
              }} />
            </div>
          </div>
        </div>
      </div>
      <Stats>
        <Stat
          label="HP"
          icon={<Icon name="health-normal" color="#86efac" size={36} />}
          tooltip={[
            `VIT ${primaryStats.vit}  ·  Level ${c.level}`,
            `16 + 2×${primaryStats.vit} + 2×${c.level} = ${c.max_hp} max HP`,
            c.shield > 0 ? `Shield: +${c.shield} (absorbs hits first)` : "",
          ].filter(Boolean).join("\n")}
          value={
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span>{c.hp} / {c.max_hp}</span>
              {c.shield > 0 && (
                <span style={{ fontSize: 13, color: "#7dd3fc", fontWeight: 500 }}>
                  +{c.shield} <Icon name="shield" size={12} />
                </span>
              )}
            </div>
          }
        />
        <Stat
          label="Mana"
          icon={<Icon name="wizard-staff" color="#a78bfa" size={36} />}
          tooltip={`INT ${primaryStats.int_stat}\n2 + floor((INT − 4) / 2) + floor(level / 6) = ${c.max_mana} max mana\nSpent to cast signature abilities`}
          value={`${c.mana} / ${c.max_mana}`}
        />
        <Stat
          label="Armor"
          icon={<Icon name="shield" color="#9ca3af" size={36} />}
          tooltip={armorPower > 0
            ? `Armor power ${armorPower}\nReduces incoming damage by floor(${armorPower}/2) = ${Math.floor(armorPower / 2)}${derivedStats.armor_bonus > 0 ? `\n+${derivedStats.armor_bonus} bonus from VIT ${primaryStats.vit}` : ""}`
            : `No armor equipped\nEquip body armor, helmet, pants,\nor a shield to reduce damage`}
          value={armorPower > 0 ? `+${armorPower}` : <span style={muted}>—</span>}
        />
        <Stat
          label="Gold"
          icon={<Icon name="cash" color="#fbbf24" size={36} />}
          tooltip={`Current balance: ${c.gold}g\nEarned from kills, quests, and selling\nSpend at the Shop or Apothecary`}
          value={c.gold.toString()}
        />
        <Stat
          label="Scars"
          icon={<Icon name="death-skull" color="#ef4444" size={36} />}
          tooltip={c.scars.length > 0
            ? `${c.scars.length} permanent ${c.scars.length === 1 ? "penalty" : "penalties"}\n${c.scars.join("\n")}`
            : "No scars yet\nEarned by dying in combat\n(soft death mode — capped at 3)"}
          value={c.scars.length.toString()}
        />
        <div style={{ padding: 12, background: "#1d1f23", borderRadius: 8, display: "flex", alignItems: "center", gap: 12, position: "relative" }}>
          <div style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36 }}>
            <Icon name="key" color="#d1d5db" size={36} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.8, lineHeight: 1, fontFamily: DISPLAY_FONT }}>Keys</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: "#f5f5f5", marginTop: 3 }}>
              <KeysPopover
                keys={{ bronze: c.keys_bronze, silver: c.keys_silver, gold: c.keys_gold }}
                onSellKey={onSellKey}
                onTransmuteKey={onTransmuteKey}
              />
            </div>
          </div>
        </div>
      </Stats>
      {/* Primary stats block — only shown after migration 0032 */}
      {(statHasData || hasUnspentPoints) && (
        <div style={{ marginTop: 12, padding: "10px 12px", background: "#16181c", borderRadius: 8, border: "1px solid #2a2d33" }}>
          <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 8, fontFamily: DISPLAY_FONT }}>Primary Stats</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 5, marginBottom: 8 }}>
            {(["str", "int_stat", "vit", "agi", "dex"] as StatKey[]).map((key) => (
              <PrimaryStatCard
                key={key}
                statKey={key}
                value={primaryStats[key]}
                bonus={equipBonuses[key] ?? 0}
                level={c.level}
              />
            ))}
          </div>
          {(() => {
            const { str, int_stat: int, vit, agi, dex } = primaryStats;
            const atkVal = derivedStats.attack_mod >= 0 ? `+${derivedStats.attack_mod}` : `${derivedStats.attack_mod}`;
            const magVal = derivedStats.magic_mod >= 0 ? `+${derivedStats.magic_mod}` : `${derivedStats.magic_mod}`;
            const dodgePct = Math.round(derivedStats.dodge_chance * 100);
            const critPct  = Math.round(derivedStats.crit_bonus * 100);
            const initVal  = derivedStats.initiative_bonus >= 0 ? `+${derivedStats.initiative_bonus}` : `${derivedStats.initiative_bonus}`;
            const stats: { icon: string; label: string; value: string; color: string; formula: string }[] = [
              {
                icon: "sword-brandish", label: "Attack", value: atkVal, color: "#f87171",
                formula: `STR ${str}\nfloor((${str} − 5) / 2) = ${atkVal}\nAdded to weapon damage rolls`,
              },
              {
                icon: "wizard-staff", label: "Magic", value: magVal, color: "#7dd3fc",
                formula: `INT ${int}\nfloor((${int} − 5) / 2) = ${magVal}\nAdded to spell & heal rolls`,
              },
              {
                icon: "dodging", label: "Dodge", value: `${dodgePct}%`, color: "#34d399",
                formula: `AGI ${agi}\nmin(15%, (${agi} − 5) × 1%) = ${dodgePct}%\nChance to fully negate a hit`,
              },
              {
                icon: "target-poster", label: "Crit", value: `+${critPct}%`, color: "#fbbf24",
                formula: `DEX ${dex}\nmax(0, (${dex} − 5) × 1%) = +${critPct}%\nBonus crit chance (cap 10%)`,
              },
              {
                icon: "coffee-cup", label: "Init", value: initVal, color: "#fb923c",
                formula: `AGI ${agi}\nfloor((${agi} − 5) / 2) = ${initVal}\nAdded to d6 initiative roll`,
              },
              ...(derivedStats.armor_bonus > 0 ? [{
                icon: "round-shield", label: "Armor", value: `+${derivedStats.armor_bonus}`, color: "#a78bfa",
                formula: `VIT ${vit}\nfloor((${vit} − 5) / 4) = +${derivedStats.armor_bonus}\nBonus armor on top of gear`,
              }] : []),
            ];
            return (
              <div style={{ display: "grid", gridTemplateColumns: `repeat(${stats.length}, 1fr)`, gap: 5 }}>
                {stats.map((s) => <DerivedStatCard key={s.label} {...s} />)}
              </div>
            );
          })()}
          {hasUnspentPoints && onSpend && (
            <div style={{ marginTop: 10, padding: "8px 10px", background: "#0f172a", borderRadius: 6, border: "1px solid #3b82f6" }}>
              <div style={{ fontSize: 11, color: "#7dd3fc", marginBottom: 7 }}>
                +{c.unspent_points} unspent {c.unspent_points === 1 ? "point" : "points"} — choose a stat:
              </div>
              <div style={{ display: "flex", gap: 5 }}>
                {(["str", "int_stat", "vit", "agi", "dex"] as StatKey[]).map((key) => (
                  <button
                    key={key}
                    onClick={() => onSpend(key)}
                    style={{
                      flex: 1, padding: "5px 0",
                      background: "#1e3a5f", border: "1px solid #3b82f6",
                      borderRadius: 5, color: "#93c5fd", fontSize: 10,
                      fontWeight: 700, cursor: "pointer",
                      textTransform: "uppercase", letterSpacing: 0.5,
                    }}
                  >
                    {key === "int_stat" ? "INT" : key.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {/* Camp section */}
      <div style={{ marginTop: 16, padding: "10px 12px", background: "#16181c", borderRadius: 8, border: "1px solid #2a2d33" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <span style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, fontFamily: DISPLAY_FONT }}>
            <Icon name="campfire" size={11} /> Camp
          </span>
          {(downed || (!downed && inQuest)) && (
            <span style={{ ...muted, fontSize: 11 }}>
              {downed ? "Downed — wait cooldown" : "Disabled mid-quest"}
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => onRest("short")}
            disabled={restDisabled}
            style={{ ...smallActionBtn(restDisabled ? "#2a2d33" : "#1f3a1f", restDisabled ? "#6a7080" : "#86efac"), flex: 1 }}
          >
            <Icon name="campfire" /> Short rest
          </button>
          <button
            onClick={() => onRest("long")}
            disabled={restDisabled}
            style={{ ...smallActionBtn(restDisabled ? "#2a2d33" : "#1f2a3a", restDisabled ? "#6a7080" : "#7dd3fc"), flex: 1 }}
          >
            <Icon name="moon-sun" /> Long rest
          </button>
        </div>
      </div>
      {trophyDefs.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <TrophyShelf earned={trophyEarned} allDefs={trophyDefs} isOwn={true} />
        </div>
      )}
    </div>
  );
}

function KeysPopover({
  keys,
  onSellKey,
  onTransmuteKey,
}: {
  keys: { bronze: number; silver: number; gold: number };
  onSellKey: (tier: "bronze" | "silver" | "gold") => void;
  onTransmuteKey: (fromTier: "bronze" | "silver") => void;
}) {
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    placement: "bottom-end",
    whileElementsMounted: autoUpdate,
  });
  const { getFloatingProps } = useInteractions([useDismiss(context)]);
  const total = keys.bronze + keys.silver + keys.gold;

  return (
    <>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <KeyIcon tier="bronze" size={14} /> {keys.bronze}
        <KeyIcon tier="silver" size={14} /> {keys.silver}
        <KeyIcon tier="gold" size={14} /> {keys.gold}
      </span>
      {total > 0 && (
        <button
          ref={refs.setReference}
          onClick={() => setOpen((v) => !v)}
          title="Sell or transmute keys"
          style={{
            position: "absolute", top: 8, right: 8,
            background: "none", border: "1px solid #3a3d44", borderRadius: 5,
            color: "#9ca3af", cursor: "pointer", padding: "2px 5px",
            lineHeight: 1, fontFamily: "inherit", display: "flex", gap: 2, alignItems: "center",
          }}
        >
          <KeyIcon tier="bronze" size={10} />
          <KeyIcon tier="silver" size={10} />
          <KeyIcon tier="gold" size={10} />
        </button>
      )}
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={{ ...floatingStyles, zIndex: 200 }}
            {...getFloatingProps()}
          >
            <KeyActionsPanel keys={keys} onSellKey={(t) => { onSellKey(t); setOpen(false); }} onTransmuteKey={(t) => { onTransmuteKey(t); setOpen(false); }} />
          </div>
        </FloatingPortal>
      )}
    </>
  );
}

function KeyActionsPanel({
  keys,
  onSellKey,
  onTransmuteKey,
}: {
  keys: { bronze: number; silver: number; gold: number };
  onSellKey: (tier: "bronze" | "silver" | "gold") => void;
  onTransmuteKey: (fromTier: "bronze" | "silver") => void;
}) {
  return (
    <div style={{ padding: 12, background: "#1d1f23", borderRadius: 8, border: "1px solid #2a2d33", boxShadow: "0 8px 24px rgba(0,0,0,0.6)", minWidth: 200 }}>
      <div
        style={{
          ...muted,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 1.5,
          marginBottom: 8,
        }}
      >
        Keys
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        {(["bronze", "silver", "gold"] as const).map((tier) => {
          const count = keys[tier];
          if (count === 0) return null;
          const sellPrice = tier === "bronze" ? 5 : tier === "silver" ? 25 : 100;
          const canTransmute = tier !== "gold" && count >= 3;
          return (
            <div
              key={tier}
              style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}
            >
              <KeyIcon tier={tier} size={16} />
              <span style={{ fontWeight: 600, color: "#f5f5f5" }}>{count}</span>
              <span style={{ ...muted, fontSize: 12, flex: 1 }}>{tier}</span>
              <button onClick={() => onSellKey(tier)} style={smallActionBtn("#33363d", "#e6e6e6")}>
                Sell · {sellPrice}g
              </button>
              {tier !== "gold" && (
                <button
                  onClick={() => onTransmuteKey(tier as "bronze" | "silver")}
                  disabled={!canTransmute}
                  style={smallActionBtn(
                    canTransmute ? "#1f2a3a" : "#2a2d33",
                    canTransmute ? "#7dd3fc" : "#6a7080",
                  )}
                >
                  Transmute · 3→1
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Lazy AI-generated banner. `src` may be null on first miss (flux gen kicked
// off via ctx.waitUntil server-side); the next dashboard poll picks up the
// real URL. Null → nothing rendered. Click to expand.
// Full-bleed hero image with a nav ribbon overlaid at the top.
// Used by full-screen town sections (pub, shop, inn, smithy).
// card padding is 32px, so we bleed -32px on each edge.
function LocationHero({
  src,
  label,
  nav,
  flush = false,
}: {
  src?: string | null;
  label: string;
  nav: React.ReactNode;
  flush?: boolean;
}) {
  return (
    <div style={{
      ...(flush
        ? { width: "100%", margin: "0 0 0", borderRadius: 0 }
        : {
            width: "calc(100% + calc(var(--card-pad, 32px) * 2))",
            margin: "calc(-1 * var(--card-pad, 32px)) calc(-1 * var(--card-pad, 32px)) 20px",
            borderRadius: "12px 12px 0 0",
          }),
      overflow: "hidden",
      position: "relative",
      background: "#0d0d10",
      ...(src ? { aspectRatio: "16/7" } : { minHeight: 56 }),
    }}>
      {src && (
        <img
          src={src}
          alt={label}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          onError={(e) => { e.currentTarget.style.display = "none"; }}
        />
      )}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0,
        background: "rgba(10,11,14,0.6)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        padding: "10px 20px",
      }}>
        {nav}
      </div>
      {src && (
        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0,
          background: "linear-gradient(transparent, rgba(10,11,14,0.88))",
          padding: "36px 20px 14px",
        }}>
          <span style={{ color: "#f1e8c8", fontSize: 17, fontWeight: 600, letterSpacing: 0.5 }}>
            {label}
          </span>
        </div>
      )}
    </div>
  );
}

function Banner({ src, alt }: { src: string | null | undefined; alt: string }) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  if (!src) return null;
  return (
    <>
      <div
        onClick={() => setOpen(true)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          width: "calc(100% + 32px)",
          margin: "-16px -16px 12px",
          aspectRatio: "3 / 2",
          overflow: "hidden",
          borderRadius: "8px 8px 0 0",
          cursor: "zoom-in",
          position: "relative",
        }}
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          style={{
            width: "100%", height: "100%", objectFit: "cover", display: "block",
            transition: "transform 0.2s ease",
            transform: hovered ? "scale(1.03)" : "scale(1)",
          }}
          onError={(e) => {
            (e.currentTarget.parentElement as HTMLDivElement).style.display = "none";
          }}
        />
      </div>
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: "fixed", inset: 0,
            background: "rgba(0,0,0,0.85)",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 9999, cursor: "zoom-out",
          }}
        >
          <img
            src={src}
            alt={alt}
            style={{
              maxWidth: "min(90vw, 800px)",
              maxHeight: "85vh",
              borderRadius: 12,
              objectFit: "contain",
              boxShadow: "0 16px 48px rgba(0,0,0,0.8)",
            }}
          />
        </div>
      )}
    </>
  );
}

type InventorySort = "type" | "rarity" | "power" | "lvl";

function sortItems(items: Item[], sort: InventorySort): Item[] {
  return [...items].sort((a, b) => {
    switch (sort) {
      case "type": {
        const ti = ITEM_TYPE_ORDER.indexOf(a.item_type) - ITEM_TYPE_ORDER.indexOf(b.item_type);
        if (ti !== 0) return ti;
        return RARITY_RANK[b.rarity] - RARITY_RANK[a.rarity];
      }
      case "rarity":
        return RARITY_RANK[b.rarity] - RARITY_RANK[a.rarity] || a.item_name.localeCompare(b.item_name);
      case "power":
        return b.power - a.power || RARITY_RANK[b.rarity] - RARITY_RANK[a.rarity];
      case "lvl": {
        const al = a.level_req ?? 1;
        const bl = b.level_req ?? 1;
        return bl - al || RARITY_RANK[b.rarity] - RARITY_RANK[a.rarity] || a.item_name.localeCompare(b.item_name);
      }
    }
  });
}

function InventoryCard({
  items,
  inQuest,
  artUrl,
  selfId,
  characterLevel,
  onEquip,
  onUnequip,
  onSell,
  onUse,
  onGive,
  onOpenFull,
}: {
  items: Item[];
  inQuest: boolean;
  artUrl: string | null;
  selfId: string;
  characterLevel?: number;
  onEquip: (itemId: number) => void;
  onUnequip: (itemId: number) => void;
  onSell: (itemId: number) => void;
  onUse: (itemId: number) => void;
  onGive: (itemId: number, toUserId: string, toName: string) => void;
  onOpenFull?: () => void;
}) {
  const [sort, setSort] = useState<InventorySort>("type");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const { refs, floatingStyles, context } = useFloating({
    open: selectedId !== null,
    onOpenChange: (open) => { if (!open) setSelectedId(null); },
    middleware: [offset(10), flip({ padding: 8 }), shift({ padding: 8 })],
    placement: "right",
    whileElementsMounted: autoUpdate,
  });

  const { getFloatingProps } = useInteractions([
    useDismiss(context, { outsidePress: true }),
  ]);

  function toggleSelect(id: number, el: HTMLElement) {
    if (selectedId === id) {
      setSelectedId(null);
      refs.setReference(null);
    } else {
      setSelectedId(id);
      refs.setReference(el);
    }
  }

  const [highlightSlot, setHighlightSlot] = useState<EquipSlot | null>(null);
  const equippedForSlot = (slot: EquipSlot) => items.find(
    (i) => i.equipped && (i.slot === slot || (i.slot === null && (
      (slot === "main_hand" && i.item_type === "weapon") ||
      (slot === "body" && i.item_type === "armor")
    )))
  );

  const sorted = sortItems(items, sort);
  const packItems = sorted.filter((i) => !i.equipped);
  const selected = selectedId != null ? items.find((i) => i.id === selectedId) ?? null : null;

  function renderDollSlot(slot: EquipSlot) {
    const item = equippedForSlot(slot);
    const isHighlighted = highlightSlot === slot;
    const label = SLOT_LABELS[slot];
    if (item) {
      return (
        <div key={slot} style={{ position: "relative" }}>
          {isHighlighted && (
            <div style={{ position: "absolute", inset: 0, borderRadius: 9, border: "2px solid #c084fc", zIndex: 2, pointerEvents: "none" }} />
          )}
          <ItemSlot item={item} selected={selectedId === item.id} characterLevel={characterLevel} onSelect={(el) => { toggleSelect(item.id, el); setHighlightSlot(null); }} />
        </div>
      );
    }
    return (
      <div
        key={slot}
        onClick={() => setHighlightSlot(isHighlighted ? null : slot)}
        title={`${label} — empty`}
        style={{
          width: 72, height: 72,
          background: "#141618",
          border: isHighlighted ? "2px solid #c084fc55" : "2px dashed #1e2128",
          borderRadius: 8,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3,
          cursor: "pointer",
          transition: "border-color 0.15s",
        }}
      >
        <Icon name={SLOT_ICON[slot]} size={20} color={isHighlighted ? "#c084fc66" : "#2e3440"} style={slot === "main_hand" ? { transform: "scaleX(-1)" } : undefined} />
        <div style={{ fontSize: 8, color: isHighlighted ? "#c084fc88" : "#374151", textAlign: "center", lineHeight: 1.2 }}>
          {label}
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div style={card}>
        <Banner src={artUrl} alt="Inventory" />
        <h2 style={h2}>Inventory</h2>
        <p style={muted}>Empty. Win a quest or visit the shop in Slack.</p>
      </div>
    );
  }

  const SORT_LABELS: { key: InventorySort; label: string }[] = [
    { key: "type", label: "Type" },
    { key: "rarity", label: "Rarity" },
    { key: "power", label: "Power" },
    { key: "lvl", label: "Lvl" },
  ];

  return (
    <div style={card}>
      <Banner src={artUrl} alt="Inventory" />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h2 style={{ ...h2, margin: 0 }}>Inventory</h2>
        {onOpenFull && items.length > 0 && (
          <button
            onClick={onOpenFull}
            title="Open full inventory"
            style={{
              background: "none", border: "1px solid #2a2d33", borderRadius: 6,
              color: "#9ca3af", cursor: "pointer", padding: "3px 8px",
              fontSize: 11, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4,
            }}
          >
            <Icon name="perspective-dice-six" size={11} /> Full view
          </button>
        )}
      </div>
      {inQuest && (
        <p style={{ ...muted, fontSize: 12, marginTop: 8 }}>
          Selling is disabled while a quest is active.
        </p>
      )}
      {/* Equipment paper-doll */}
      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase" as const, letterSpacing: 0.8, fontWeight: 600, marginBottom: 6, fontFamily: DISPLAY_FONT }}>
          Equipped
        </div>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 72px)", gap: 4 }}>
            {([null, "helmet", null, "main_hand", "body", "off_hand", "amulet", "pants", "ring", null, "boots", null] as (EquipSlot | null)[]).map((s, i) =>
              s ? renderDollSlot(s) : <div key={i} style={{ width: 72, height: 72 }} />
            )}
          </div>
        </div>
      </div>
      {/* Pack */}
      {packItems.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" as const }}>
            <span style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase" as const, letterSpacing: 0.8, fontWeight: 600, fontFamily: DISPLAY_FONT }}>
              Pack ({packItems.length})
            </span>
            {SORT_LABELS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setSort(key)}
                style={{
                  background: sort === key ? "#2a2d3a" : "#1d1f23",
                  color: sort === key ? "#c084fc" : "#9aa0a6",
                  border: sort === key ? "1px solid #c084fc55" : "1px solid #2a2d33",
                  borderRadius: 20,
                  padding: "3px 10px",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  transition: "all 0.1s",
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, 72px)", gap: 6 }}>
            {packItems.map((item) => (
              <div key={item.id} style={{ position: "relative" }}>
                {highlightSlot !== null && item.slot === highlightSlot && (
                  <div style={{ position: "absolute", inset: 0, borderRadius: 9, border: "2px solid #c084fc", zIndex: 2, pointerEvents: "none" }} />
                )}
                <ItemSlot item={item} selected={selectedId === item.id} characterLevel={characterLevel} onSelect={(el) => toggleSelect(item.id, el)} />
              </div>
            ))}
          </div>
        </div>
      )}
      {/* Floating popover — rendered outside the card via portal */}
      {selected && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} initialFocus={-1}>
            <div
              ref={refs.setFloating}
              style={{ ...floatingStyles, zIndex: 1000, outline: "none" }}
              {...getFloatingProps()}
            >
              <ItemDetailPopover
                item={selected}
                inQuest={inQuest}
                selfId={selfId}
                characterLevel={characterLevel}
                onEquip={(id) => { onEquip(id); setSelectedId(null); }}
                onUnequip={(id) => { onUnequip(id); setSelectedId(null); }}
                onSell={(id) => { onSell(id); setSelectedId(null); }}
                onUse={(id) => { onUse(id); setSelectedId(null); }}
                onGive={(id, uid, name) => { onGive(id, uid, name); setSelectedId(null); }}
                onClose={() => setSelectedId(null)}
              />
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </div>
  );
}

// ── dnd-kit sub-components for InventoryFullScreen ──────────────────────────

function DollSlotCell({
  slot, item, isHighlighted, isSelected, onSlotClick, onItemClick, characterLevel,
}: {
  slot: EquipSlot; item: Item | undefined;
  isHighlighted: boolean; isSelected: boolean;
  onSlotClick: (slot: EquipSlot) => void;
  onItemClick: (itemId: number) => void;
  characterLevel?: number;
}) {
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `drop-slot-${slot}`, data: { slot } });
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: item ? `doll-item-${item.id}` : `empty-slot-${slot}`,
    data: item ? { itemId: item.id, equipped: true } : undefined,
    disabled: !item,
  });
  const mergeRef = (el: HTMLElement | null) => { setDropRef(el); setDragRef(el); };
  const S = 96;
  const label = SLOT_LABELS[slot];
  if (item) {
    return (
      <ItemCell
        ref={mergeRef}
        item={item}
        size={S}
        mode="compact"
        selected={isSelected}
        isOver={isOver}
        isDragging={isDragging}
        characterLevel={characterLevel}
        cursor="grab"
        onClick={() => onItemClick(item.id)}
        {...(listeners as React.HTMLAttributes<HTMLDivElement>)}
        {...(attributes as React.HTMLAttributes<HTMLDivElement>)}
      />
    );
  }
  return (
    <div ref={setDropRef} onClick={() => onSlotClick(slot)} title={`${label} — empty`}
      style={{
        width: S, height: S, background: isOver ? "#151d2e" : "#141618",
        border: isOver ? "2px solid #7dd3fc88" : isHighlighted ? "2px solid #c084fc55" : "2px dashed #1e2128",
        borderRadius: 10, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4,
        cursor: "pointer", transition: "border-color 0.15s, background 0.15s",
      }}
    >
      <Icon name={SLOT_ICON[slot]} size={30}
        color={isOver ? "#7dd3fc55" : isHighlighted ? "#c084fc66" : "#2e3440"}
        style={slot === "main_hand" ? { transform: "scaleX(-1)" } : undefined}
      />
      <div style={{ fontSize: 11, color: isOver ? "#7dd3fc88" : isHighlighted ? "#c084fc88" : "#374151", textAlign: "center", lineHeight: 1.2 }}>{label}</div>
    </div>
  );
}

function DroppablePackPanel({ children }: { children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: "pack-drop-zone" });
  return (
    <div ref={setNodeRef} style={{
      flex: 1, overflowY: "auto", padding: 18,
      outline: isOver ? "2px dashed #7dd3fc44" : "2px dashed transparent",
      outlineOffset: -6, borderRadius: 8, transition: "outline-color 0.15s",
    }}>
      {children}
    </div>
  );
}

function DraggablePackItem({
  item, isSelected, isMatch, viewMode, onSelect, characterLevel,
}: {
  item: Item; isSelected: boolean; isMatch: boolean;
  viewMode: "grid" | "list"; onSelect: () => void; characterLevel?: number;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `pack-item-${item.id}`,
    data: { itemId: item.id, equipped: false, itemSlot: item.slot },
  });
  const rc = RARITY_COLOR[item.rarity];
  const sellPrice = sellPriceFor(item.item_type, item.rarity, { power: item.power, sharpens_count: item.sharpens_count });
  const isLevelLocked = (characterLevel ?? Infinity) < (item.level_req ?? 1);
  if (viewMode === "list") {
    return (
      <div ref={setNodeRef} {...listeners} {...attributes} onClick={onSelect}
        style={{
          display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
          borderRadius: 8, background: isSelected ? "#1e1c2e" : "#1d1f23",
          border: `1px solid ${isSelected ? "#fff" : isMatch ? "#c084fc" : "#2a2d33"}`,
          cursor: isDragging ? "grabbing" : "grab", opacity: isDragging ? 0.35 : isLevelLocked ? 0.45 : 1,
          transition: "background 0.1s", boxShadow: isMatch ? "0 0 6px #c084fc33" : undefined,
          touchAction: "none",
        }}
      >
        <Icon name={itemIcon(item)} size={20} color={itemIconColor(item) ?? rc} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#f5f5f5", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.item_name}</div>
          <div style={{ fontSize: 10, color: "#6b7280", marginTop: 1 }}>
            {slotLabel(item)}{item.stat_bonus && statBonusSummary(item.stat_bonus) ? ` · ${statBonusSummary(item.stat_bonus)}` : ""}
          </div>
        </div>
        {(item.level_req ?? 1) > 1 && (
          <span style={{ fontSize: 10, color: "#6b7280", flexShrink: 0 }}>L{item.level_req}</span>
        )}
        {item.element && (
          <span style={{ fontSize: 12, flexShrink: 0 }} title={item.element}>
            {item.element === "fire" ? "🔥" : item.element === "ice" ? "❄️" : "⚡"}
          </span>
        )}
        <span style={{ ...smallBadge, borderColor: `${rc}55`, color: rc, background: `${rc}15`, flexShrink: 0 }}>{item.rarity}</span>
        <span style={{ fontSize: 11, color: rc, fontWeight: 600, flexShrink: 0, minWidth: 30, textAlign: "right" }}>+{item.power}</span>
        <span style={{ fontSize: 11, color: "#fbbf24", flexShrink: 0, minWidth: 28, textAlign: "right" }}>{sellPrice}g</span>
      </div>
    );
  }
  return (
    <ItemCell
      ref={setNodeRef}
      item={item}
      mode="detailed"
      selected={isSelected}
      isDragging={isDragging}
      isMatch={isMatch}
      showSellPrice
      characterLevel={characterLevel}
      cursor={isDragging ? "grabbing" : "grab"}
      onClick={onSelect}
      {...(listeners as React.HTMLAttributes<HTMLDivElement>)}
      {...(attributes as React.HTMLAttributes<HTMLDivElement>)}
    />
  );
}

function DragItemPreview({ item }: { item: Item }) {
  const rc = RARITY_COLOR[item.rarity];
  return (
    <div style={{ width: 80, background: "#1d1f23", border: `2px solid ${rc}`, borderRadius: 10, padding: "8px 6px 6px", textAlign: "center", boxShadow: "0 8px 24px rgba(0,0,0,0.7)", opacity: 0.95 }}>
      <Icon name={itemIcon(item)} size={32} color={itemIconColor(item) ?? rc} />
      <div style={{ marginTop: 5, fontSize: 9, fontWeight: 600, color: "#e2e8f0", lineHeight: 1.3, wordBreak: "break-word" }}>{item.item_name}</div>
    </div>
  );
}

function InventoryFullScreen({
  items,
  inQuest,
  selfId,
  characterLevel,
  character,
  onEquip,
  onUnequip,
  onSell,
  onUse,
  onGive,
  onClose,
}: {
  items: Item[];
  inQuest: boolean;
  selfId: string;
  characterLevel?: number;
  character?: Character;
  onEquip: (itemId: number) => void;
  onUnequip: (itemId: number) => void;
  onSell: (itemId: number) => void;
  onUse: (itemId: number) => void;
  onGive: (itemId: number, toUserId: string, toName: string) => void;
  onClose: () => void;
}) {
  const [sort, setSort] = useState<InventorySort>("type");
  const [viewMode, setViewMode] = useState<"grid" | "list">(
    () => (localStorage.getItem("inv_view") === "list" ? "list" : "grid"),
  );
  function changeViewMode(mode: "grid" | "list") {
    localStorage.setItem("inv_view", mode);
    setViewMode(mode);
  }
  // Esc closes the modal — capture early so it beats any inner handlers.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);
  const dollEquipBonuses: Partial<Record<StatKey, number>> = {};
  for (const item of items) {
    if (item.equipped && item.stat_bonus) {
      for (const [k, v] of Object.entries(item.stat_bonus)) {
        dollEquipBonuses[k as StatKey] = (dollEquipBonuses[k as StatKey] ?? 0) + v;
      }
    }
  }
  const sorted = sortItems(items, sort);
  const packItems = sorted.filter((i) => !i.equipped);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = selectedId != null ? items.find((i) => i.id === selectedId) ?? null : null;
  const [highlightSlot, setHighlightSlot] = useState<EquipSlot | null>(null);
  const [activeItemId, setActiveItemId] = useState<number | null>(null);
  const [mobileTab, setMobileTab] = useState<"doll" | "pack">("pack");
  const isMobile = useIsMobile();
  const activeItem = activeItemId != null ? items.find((i) => i.id === activeItemId) ?? null : null;

  // Require 5px of movement before a drag activates — lets regular clicks
  // fire on doll slots and pack items without starting an unintended drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function equippedForSlot(slot: EquipSlot): Item | undefined {
    return items.find((i) => i.equipped && (
      i.slot === slot
      || (slot === "main_hand" && !i.slot && i.item_type === "weapon")
      || (slot === "body" && !i.slot && i.item_type === "armor")
    ));
  }

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current as { itemId: number } | undefined;
    if (data) setActiveItemId(data.itemId);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveItemId(null);
    const { active, over } = event;
    if (!over) return;
    const data = active.data.current as { itemId: number; equipped: boolean } | undefined;
    if (!data) return;
    const overId = over.id.toString();
    if (overId.startsWith("drop-slot-")) {
      if (!data.equipped) onEquip(data.itemId);
    } else if (overId === "pack-drop-zone" && data.equipped) {
      onUnequip(data.itemId);
    }
  }

  const SORT_LABELS: { key: InventorySort; label: string }[] = [
    { key: "type", label: "Type" },
    { key: "rarity", label: "Rarity" },
    { key: "power", label: "Power" },
    { key: "lvl", label: "Lvl" },
  ];

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 500,
        background: "rgba(0,0,0,0.92)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 12,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: "#12141a",
          border: "1px solid #2a2d33",
          borderRadius: 12,
          width: isMobile ? "100vw" : "min(1200px, 96vw)",
          height: isMobile ? "100dvh" : "92vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          position: "relative",
          boxShadow: "0 24px 64px rgba(0,0,0,0.8)",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: isMobile ? "12px 14px" : "14px 18px", borderBottom: "1px solid #2a2d33", flexShrink: 0, gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 16, fontWeight: 700, color: "#f5f5f5", fontFamily: DISPLAY_FONT }}>Inventory</span>
            <span style={{ ...muted, fontSize: 12 }}>{items.length} item{items.length !== 1 ? "s" : ""}</span>
            {character && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, paddingLeft: 12, borderLeft: "1px solid #2a2d33", fontSize: 12, color: "#9aa0a6", flexWrap: "wrap" }}>
                <span style={{ color: "#f5f5f5", fontWeight: 600, fontFamily: DISPLAY_FONT }}>{character.name}</span>
                <span style={{ color: "#c084fc" }}>{character.class}</span>
                <span title="Level">Lv {character.level}</span>
                <span style={{ color: "#86efac" }} title="HP"><Icon name="health-normal" size={11} /> {character.hp}/{character.max_hp}</span>
                {character.max_mana > 0 && (
                  <span style={{ color: "#a78bfa" }} title="Mana"><Icon name="wizard-staff" size={11} /> {character.mana}/{character.max_mana}</span>
                )}
                <span style={{ color: "#fbbf24" }} title="Gold"><Icon name="gold-bar" size={11} /> {character.gold}g</span>
                {(character.keys_bronze + character.keys_silver + character.keys_gold) > 0 && (
                  <span style={{ color: "#9aa0a6" }} title="Keys">
                    {character.keys_bronze > 0 && <><Icon name="key" size={10} color="#b45309" /> {character.keys_bronze} </>}
                    {character.keys_silver > 0 && <><Icon name="key" size={10} color="#d1d5db" /> {character.keys_silver} </>}
                    {character.keys_gold > 0 && <><Icon name="key" size={10} color="#fbbf24" /> {character.keys_gold}</>}
                  </span>
                )}
              </div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {!isMobile && SORT_LABELS.map(({ key, label }) => (
              <button key={key} onClick={() => setSort(key)}
                style={{
                  background: sort === key ? "#2a2d3a" : "none",
                  color: sort === key ? "#c084fc" : "#6b7280",
                  border: sort === key ? "1px solid #c084fc55" : "1px solid transparent",
                  borderRadius: 20, padding: "3px 12px", fontSize: 12,
                  fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                }}
              >{label}</button>
            ))}
            {!isMobile && <div style={{ width: 1, height: 16, background: "#2a2d33", margin: "0 2px" }} />}
            {!isMobile && (["grid", "list"] as const).map((mode) => (
              <button key={mode} onClick={() => changeViewMode(mode)} title={mode === "grid" ? "Grid view" : "List view"}
                style={{
                  background: viewMode === mode ? "#2a2d3a" : "none",
                  color: viewMode === mode ? "#7dd3fc" : "#6b7280",
                  border: viewMode === mode ? "1px solid #7dd3fc55" : "1px solid transparent",
                  borderRadius: 6, padding: "3px 8px", fontSize: 14,
                  cursor: "pointer", fontFamily: "inherit", lineHeight: 1,
                }}
              >{mode === "grid" ? "⊞" : "☰"}</button>
            ))}
            <button onClick={onClose}
              style={{ background: "none", border: "1px solid #3a3d44", borderRadius: 6, color: "#9ca3af", cursor: "pointer", padding: "4px 10px", fontSize: 13, fontFamily: "inherit", marginLeft: 4 }}
            >✕</button>
          </div>
        </div>

        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          {isMobile ? (
            /* ── Mobile: tab bar + single-panel view ── */
            <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
              {/* Tab bar */}
              <div style={{ display: "flex", borderBottom: "1px solid #2a2d33", flexShrink: 0 }}>
                {([["doll", "Equipped"], ["pack", `Pack (${packItems.length})`]] as const).map(([tab, label]) => (
                  <button key={tab} onClick={() => setMobileTab(tab)}
                    style={{
                      flex: 1, padding: "10px 0", fontSize: 13, fontWeight: 600, fontFamily: DISPLAY_FONT,
                      background: "none", border: "none", cursor: "pointer",
                      color: mobileTab === tab ? "#f5f5f5" : "#6b7280",
                      borderBottom: mobileTab === tab ? "2px solid #c084fc" : "2px solid transparent",
                      marginBottom: -1,
                    }}
                  >{label}</button>
                ))}
              </div>

              {/* Tab content */}
              <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
                {mobileTab === "doll" ? (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                    <div style={{ ...muted, fontSize: 10, textTransform: "uppercase", letterSpacing: 1.5, alignSelf: "flex-start" }}>Tap a slot to highlight matchable items</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 72px)", gap: 5 }}>
                      {([null, "helmet", null, "main_hand", "body", "off_hand", "amulet", "pants", "ring", null, "boots", null] as (EquipSlot | null)[]).map((s, i) => {
                        if (!s) return <div key={i} style={{ width: 72, height: 72 }} />;
                        const item = equippedForSlot(s);
                        const isHighlighted = highlightSlot === s;
                        const isSelected = selectedId === (item?.id ?? -1);
                        if (item) {
                          return (
                            <ItemCell
                              key={s}
                              item={item}
                              size={72}
                              mode="compact"
                              selected={isSelected}
                              characterLevel={characterLevel}
                              onClick={() => setSelectedId(isSelected ? null : item.id)}
                            />
                          );
                        }
                        return (
                          <div key={s} onClick={() => setHighlightSlot(isHighlighted ? null : s)}
                            style={{ width: 72, height: 72, background: "#141618", border: isHighlighted ? "2px solid #c084fc55" : "2px dashed #1e2128", borderRadius: 8, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, cursor: "pointer" }}
                          >
                            <Icon name={SLOT_ICON[s]} size={22} color={isHighlighted ? "#c084fc66" : "#2e3440"} style={s === "main_hand" ? { transform: "scaleX(-1)" } : undefined} />
                            <div style={{ fontSize: 9, color: isHighlighted ? "#c084fc88" : "#374151", textAlign: "center", fontFamily: DISPLAY_FONT }}>{SLOT_LABELS[s]}</div>
                          </div>
                        );
                      })}
                    </div>
                    {highlightSlot && (
                      <div style={{ fontSize: 11, color: "#c084fc88", textAlign: "center" }}>
                        Switch to Pack tab to equip in {SLOT_LABELS[highlightSlot]}
                      </div>
                    )}
                    {character?.str !== undefined && (
                      <div style={{ alignSelf: "stretch", padding: "10px 12px", background: "#16181c", borderRadius: 8, border: "1px solid #2a2d33" }}>
                        <div style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 6, fontFamily: DISPLAY_FONT }}>Primary Stats</div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 4 }}>
                          {(["str", "int_stat", "vit", "agi", "dex"] as StatKey[]).map((key) => {
                            const base = character[key] ?? 5;
                            const bonus = dollEquipBonuses[key] ?? 0;
                            return (
                              <div key={key} style={{ textAlign: "center", background: "#1d1f23", borderRadius: 5, padding: "5px 3px" }}>
                                <div style={{ fontSize: 8, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.8, fontFamily: DISPLAY_FONT }}>
                                  {key === "int_stat" ? "INT" : key.toUpperCase()}
                                </div>
                                <div style={{ fontSize: 14, fontWeight: 700, color: "#f5f5f5", lineHeight: 1.2, fontFamily: DISPLAY_FONT }}>{base + bonus}</div>
                                {bonus > 0 && <div style={{ fontSize: 7, color: "#86efac" }}>+{bonus}</div>}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  /* Pack tab */
                  <>
                    <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
                      {SORT_LABELS.map(({ key, label }) => (
                        <button key={key} onClick={() => setSort(key)}
                          style={{ background: sort === key ? "#2a2d3a" : "none", color: sort === key ? "#c084fc" : "#6b7280", border: sort === key ? "1px solid #c084fc55" : "1px solid #2a2d33", borderRadius: 20, padding: "4px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
                        >{label}</button>
                      ))}
                    </div>
                    {packItems.length === 0 ? (
                      <div style={{ color: "#374151", fontSize: 13, textAlign: "center", marginTop: 32 }}>Nothing in your pack</div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {packItems.map((item) => {
                          const rc = RARITY_COLOR[item.rarity];
                          const isSelected = selectedId === item.id;
                          const isMatch = highlightSlot !== null && item.slot === highlightSlot;
                          return (
                            <div key={item.id} onClick={() => setSelectedId(isSelected ? null : item.id)}
                              style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 10, background: isSelected ? "#1e1c2e" : "#1d1f23", border: `1px solid ${isSelected ? "#fff" : isMatch ? "#c084fc" : "#2a2d33"}`, cursor: "pointer", boxShadow: isMatch ? "0 0 6px #c084fc33" : undefined }}
                            >
                              <Icon name={itemIcon(item)} size={28} color={itemIconColor(item) ?? rc} />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 14, fontWeight: 600, color: "#f5f5f5", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.item_name}</div>
                                <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
                                  {slotLabel(item)}{item.stat_bonus && statBonusSummary(item.stat_bonus) ? ` · ${statBonusSummary(item.stat_bonus)}` : ""}
                                </div>
                              </div>
                              {(item.level_req ?? 1) > 1 && (
                                <span style={{ fontSize: 10, color: "#6b7280", flexShrink: 0 }}>L{item.level_req}</span>
                              )}
                              <div style={{ flexShrink: 0, textAlign: "right" }}>
                                <div style={{ fontSize: 12, color: rc, fontWeight: 600 }}>+{item.power}</div>
                                <span style={{ ...smallBadge, borderColor: `${rc}55`, color: rc, background: `${rc}15` }}>{item.rarity}</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Bottom sheet — item detail */}
              {selected && (
                <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 10, background: "#12141a", borderTop: "1px solid #2a2d33", borderRadius: "12px 12px 0 0", maxHeight: "60vh", overflowY: "auto", padding: 18, boxShadow: "0 -8px 32px rgba(0,0,0,0.7)" }}>
                  <ItemDetailPopover
                    item={selected} inQuest={inQuest} selfId={selfId} characterLevel={characterLevel} inline
                    onEquip={(id) => { onEquip(id); setSelectedId(null); }}
                    onUnequip={(id) => { onUnequip(id); setSelectedId(null); }}
                    onSell={(id) => { onSell(id); setSelectedId(null); }}
                    onUse={(id) => { onUse(id); setSelectedId(null); }}
                    onGive={(id, uid, name) => { onGive(id, uid, name); setSelectedId(null); }}
                    onClose={() => setSelectedId(null)}
                  />
                </div>
              )}
            </div>
          ) : (
            /* ── Desktop: 3-panel layout ── */
            <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
              {/* Left — paper doll */}
              <div style={{ width: 340, flexShrink: 0, borderRight: "1px solid #2a2d33", overflowY: "auto", padding: "20px 16px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                <div style={{ ...muted, fontSize: 10, textTransform: "uppercase", letterSpacing: 1.5, alignSelf: "flex-start", fontFamily: DISPLAY_FONT }}>Equipped — drag items here to equip</div>
                <div style={{ display: "flex", justifyContent: "center" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 96px)", gap: 6 }}>
                    {([null, "helmet", null, "main_hand", "body", "off_hand", "amulet", "pants", "ring", null, "boots", null] as (EquipSlot | null)[]).map((s, i) =>
                      s
                        ? <DollSlotCell key={s} slot={s} item={equippedForSlot(s)}
                            isHighlighted={highlightSlot === s} isSelected={selectedId === (equippedForSlot(s)?.id ?? -1)}
                            onSlotClick={(sl) => setHighlightSlot(highlightSlot === sl ? null : sl)}
                            onItemClick={(id) => setSelectedId(selectedId === id ? null : id)}
                            characterLevel={characterLevel}
                          />
                        : <div key={i} style={{ width: 96, height: 96 }} />
                    )}
                  </div>
                </div>
                {highlightSlot && (
                  <div style={{ fontSize: 11, color: "#c084fc88", marginTop: 4, textAlign: "center" }}>
                    Drag or click a matching item to equip in {SLOT_LABELS[highlightSlot]}
                  </div>
                )}
                {character?.str !== undefined && (
                  <div style={{ alignSelf: "stretch", padding: "10px 12px", background: "#16181c", borderRadius: 8, border: "1px solid #2a2d33" }}>
                    <div style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 6, fontFamily: DISPLAY_FONT }}>Primary Stats</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 4 }}>
                      {(["str", "int_stat", "vit", "agi", "dex"] as StatKey[]).map((key) => {
                        const base = character[key] ?? 5;
                        const bonus = dollEquipBonuses[key] ?? 0;
                        return (
                          <div key={key} style={{ textAlign: "center", background: "#1d1f23", borderRadius: 5, padding: "5px 3px" }}>
                            <div style={{ fontSize: 8, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.8, fontFamily: DISPLAY_FONT }}>
                              {key === "int_stat" ? "INT" : key.toUpperCase()}
                            </div>
                            <div style={{ fontSize: 14, fontWeight: 700, color: "#f5f5f5", lineHeight: 1.2, fontFamily: DISPLAY_FONT }}>{base + bonus}</div>
                            {bonus > 0 && <div style={{ fontSize: 7, color: "#86efac" }}>+{bonus}</div>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Center — pack */}
              <DroppablePackPanel>
                <div style={{ ...muted, fontSize: 10, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 12, fontFamily: DISPLAY_FONT }}>
                  Pack {packItems.length > 0 ? `(${packItems.length})` : "(empty)"} — drag equipped items here to unequip
                </div>
                {packItems.length === 0 ? (
                  <div style={{ color: "#374151", fontSize: 13, textAlign: "center", marginTop: 32 }}>Nothing in your pack</div>
                ) : viewMode === "grid" ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 10 }}>
                    {packItems.map((item) => (
                      <DraggablePackItem key={item.id} item={item}
                        isSelected={selectedId === item.id}
                        isMatch={highlightSlot !== null && item.slot === highlightSlot}
                        viewMode="grid"
                        characterLevel={characterLevel}
                        onSelect={() => setSelectedId(selectedId === item.id ? null : item.id)}
                      />
                    ))}
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    {packItems.map((item) => (
                      <DraggablePackItem key={item.id} item={item}
                        isSelected={selectedId === item.id}
                        isMatch={highlightSlot !== null && item.slot === highlightSlot}
                        viewMode="list"
                        characterLevel={characterLevel}
                        onSelect={() => setSelectedId(selectedId === item.id ? null : item.id)}
                      />
                    ))}
                  </div>
                )}
              </DroppablePackPanel>

              {/* Right — detail pane */}
              {selected ? (
                <div style={{ width: 280, flexShrink: 0, borderLeft: "1px solid #2a2d33", overflowY: "auto", padding: 18 }}>
                  <ItemDetailPopover
                    item={selected} inQuest={inQuest} selfId={selfId} characterLevel={characterLevel} inline
                    onEquip={(id) => { onEquip(id); setSelectedId(null); }}
                    onUnequip={(id) => { onUnequip(id); setSelectedId(null); }}
                    onSell={(id) => { onSell(id); setSelectedId(null); }}
                    onUse={(id) => { onUse(id); setSelectedId(null); }}
                    onGive={(id, uid, name) => { onGive(id, uid, name); setSelectedId(null); }}
                    onClose={() => setSelectedId(null)}
                  />
                </div>
              ) : (
                <div style={{ width: 280, flexShrink: 0, borderLeft: "1px solid #2a2d33", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <div style={{ color: "#374151", fontSize: 12, textAlign: "center", padding: 16 }}>Select an item to view details</div>
                </div>
              )}
            </div>
          )}

          <DragOverlay dropAnimation={null}>
            {activeItem ? <DragItemPreview item={activeItem} /> : null}
          </DragOverlay>
        </DndContext>
      </div>
    </div>
  );
}

// ── Unified item cell ─────────────────────────────────────────────────────
// mode="icon"     — fixed square, power badge circle       (InventoryCard)
// mode="compact"  — fixed square, icon + truncated name    (doll slots)
// mode="detailed" — auto-height, icon + full stats + price (pack grid)
type ItemCellMode = "icon" | "compact" | "detailed";

const ItemCell = forwardRef<
  HTMLDivElement,
  {
    item: Item;
    size?: number;
    mode?: ItemCellMode;
    selected?: boolean;
    isOver?: boolean;
    isDragging?: boolean;
    isMatch?: boolean;
    showSellPrice?: boolean;
    characterLevel?: number;
    cursor?: CSSProperties["cursor"];
    onClick?: React.MouseEventHandler<HTMLDivElement>;
  } & Omit<React.HTMLAttributes<HTMLDivElement>, "onClick">
>(function ItemCell(
  { item, size = 72, mode = "icon", selected, isOver, isDragging, isMatch,
    showSellPrice, characterLevel, cursor, onClick, style: extraStyle, ...rest },
  ref,
) {
  const rc = RARITY_COLOR[item.rarity];
  const borderColor = isOver ? "#7dd3fc"
    : selected ? "#fff"
    : item.equipped ? "#b89b3a"
    : isMatch ? "#c084fc"
    : `${rc}99`;
  const iconSize = mode === "detailed" ? 40 : mode === "compact" ? 38 : 28;
  const elementEmoji = item.element === "fire" ? "🔥" : item.element === "ice" ? "❄️" : item.element === "lightning" ? "⚡" : null;
  const powerValue = item.power > 0
    ? item.power
    : (item.stat_bonus ? Object.values(item.stat_bonus).reduce((a: number, b: number) => a + b, 0) : 0);
  const isLevelLocked = !item.equipped && (characterLevel ?? Infinity) < (item.level_req ?? 1);
  const sellPrice = showSellPrice
    ? sellPriceFor(item.item_type, item.rarity, { power: item.power, sharpens_count: item.sharpens_count })
    : null;

  return (
    <div
      ref={ref}
      onClick={onClick}
      title={item.item_name}
      style={{
        width: mode !== "detailed" ? size : undefined,
        height: mode !== "detailed" ? size : undefined,
        padding: mode === "detailed" ? "10px 8px 8px" : undefined,
        background: selected ? "#1e1c2e" : isOver ? "#151d2e" : "#1d1f23",
        border: `2px solid ${borderColor}`,
        borderRadius: mode === "icon" ? 8 : 10,
        cursor: cursor ?? (onClick ? "pointer" : undefined),
        position: "relative",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: mode !== "detailed" ? "center" : undefined,
        gap: mode !== "icon" ? 2 : undefined,
        opacity: isDragging ? 0.35 : isLevelLocked ? 0.45 : 1,
        boxShadow: isMatch ? "0 0 8px #c084fc44" : selected ? `0 0 0 1px ${rc}66` : undefined,
        transition: "border-color 0.1s, background 0.1s",
        touchAction: "none",
        flexShrink: 0,
        textAlign: "center",
        ...extraStyle,
      }}
      {...rest}
    >
      {(item.level_req ?? 1) > 1 && (
        <div style={{ position: "absolute", top: 4, [item.equipped ? "right" : "left"]: 4, background: "#1d1f23", border: "1px solid #4b5563", borderRadius: 3, fontSize: 8, fontWeight: 700, padding: "1px 3px", lineHeight: 1, color: "#9ca3af" }}>L{item.level_req}</div>
      )}
      {item.sharpens_count > 0 && mode !== "detailed" && (
        <div style={{ position: "absolute", top: 4, right: 4, background: "#1d1f23", border: "1px solid #b45309", borderRadius: 3, fontSize: 8, fontWeight: 700, padding: "1px 3px", lineHeight: 1, color: "#fb923c", display: "flex", alignItems: "center", gap: 2 }}>
          <Icon name="anvil" size={8} color="#fb923c" />{"×"}{item.sharpens_count}
        </div>
      )}
      <Icon name={itemIcon(item)} size={iconSize} color={itemIconColor(item) ?? rc} />
      {(mode === "icon" || (mode === "compact" && powerValue > 0)) && (
        <div style={{ position: "absolute", bottom: 3, right: 3, minWidth: 18, height: 18, background: "#0a0b0e", border: `1px solid ${rc}55`, borderRadius: "50%", fontSize: 9, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", color: rc, lineHeight: 1, padding: "0 2px" }}>
          +{powerValue}
        </div>
      )}
      {elementEmoji && mode === "icon" && (
        <div style={{ position: "absolute", bottom: 3, left: 3, fontSize: 9, lineHeight: 1 }} title={item.element ?? undefined}>
          {elementEmoji}
        </div>
      )}
      {mode === "compact" && (
        <div style={{ fontSize: 10, color: "#9ca3af", lineHeight: 1.1, maxWidth: size - 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: "0 4px" }}>
          {item.item_name}
        </div>
      )}
      {mode === "detailed" && (
        <>
          <div style={{ marginTop: 2, fontSize: 10, fontWeight: 600, color: "#e2e8f0", lineHeight: 1.3, wordBreak: "break-word" }}>{item.item_name}</div>
          <div style={{ fontSize: 10, color: rc, fontWeight: 600 }}>+{powerValue}</div>
          <div style={{ fontSize: 9, color: "#6b7280" }}>{slotLabel(item)}</div>
          {item.stat_bonus && statBonusSummary(item.stat_bonus) && (
            <div style={{ fontSize: 8, color: "#86efac" }}>{statBonusSummary(item.stat_bonus)}</div>
          )}
          {elementEmoji && (
            <div style={{ fontSize: 9, color: "#9ca3af" }}>{elementEmoji} {item.element}</div>
          )}
          {showSellPrice && sellPrice !== null && (
            <div style={{ fontSize: 9, color: "#fbbf24" }}>{sellPrice}g</div>
          )}
        </>
      )}
    </div>
  );
});

function ItemSlot({ item, selected, onSelect, characterLevel }: { item: Item; selected: boolean; onSelect: (el: HTMLElement) => void; characterLevel?: number }) {
  return (
    <ItemCell
      item={item}
      size={72}
      mode="icon"
      selected={selected}
      characterLevel={characterLevel}
      onClick={(e) => onSelect(e.currentTarget)}
    />
  );
}

function ItemDetailPopover({
  item,
  inQuest,
  selfId,
  characterLevel,
  onEquip,
  onUnequip,
  onSell,
  onUse,
  onGive,
  onClose,
  inline,
}: {
  item: Item;
  inQuest: boolean;
  selfId: string;
  characterLevel?: number;
  onEquip: (itemId: number) => void;
  onUnequip: (itemId: number) => void;
  onSell: (itemId: number) => void;
  onUse: (itemId: number) => void;
  onGive: (itemId: number, toUserId: string, toName: string) => void;
  onClose: () => void;
  inline?: boolean;
}) {
  const [showGivePicker, setShowGivePicker] = useState(false);
  const [characters, setCharacters] = useState<KnownCharacter[]>([]);
  const [charsLoading, setCharsLoading] = useState(false);

  async function openGivePicker() {
    setShowGivePicker(true);
    if (characters.length === 0) {
      setCharsLoading(true);
      try {
        const res = await fetch("/api/characters", { credentials: "include" });
        if (res.ok) {
          const body = (await res.json()) as { characters: KnownCharacter[] };
          setCharacters(body.characters);
        }
      } finally {
        setCharsLoading(false);
      }
    }
  }

  const meetsLevel = (characterLevel ?? 1) >= (item.level_req ?? 1);
  const canEquip = !item.equipped && item.slot !== null && meetsLevel;
  const canSell = !item.equipped && !inQuest;
  const canUse =
    !item.equipped && (item.item_type === "consumable" || item.item_type === "magic");
  const canGive = !item.equipped;
  const rc = RARITY_COLOR[item.rarity];

  return (
    <div
      style={{
        ...(inline ? {} : { width: 240, boxShadow: "0 8px 32px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.04)" }),
        background: "#12141a",
        border: `1px solid ${rc}55`,
        borderRadius: 10,
        padding: "14px 14px 12px",
        fontFamily: "inherit",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
        <div
          style={{
            width: 40,
            height: 40,
            background: "#0e0f12",
            border: `2px solid ${rc}66`,
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Icon name={itemIcon(item)} size={22} color={itemIconColor(item) ?? rc} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, color: "#f5f5f5", fontSize: 13, lineHeight: 1.3, wordBreak: "break-word", fontFamily: DISPLAY_FONT }}>
            {item.item_name}
          </div>
          <div style={{ display: "flex", gap: 5, marginTop: 4, flexWrap: "wrap" }}>
            <RarityBadge rarity={item.rarity} />
            {item.equipped && (
              <span style={{ ...smallBadge, background: "#3a2a00", color: "#b89b3a", borderColor: "#b89b3a55" }}>
                equipped
              </span>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 18, padding: 0, lineHeight: 1, flexShrink: 0 }}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {/* Type line */}
      <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: item.sharpens_count > 0 ? 4 : 8 }}>
        {slotLabel(item)}
        {item.item_type === "weapon" && item.weapon_range && ` · ${item.weapon_range}`}
        {item.power > 0 && <>{" · "}+{item.power} power</>}
      </div>
      {item.sharpens_count > 0 && (
        <div style={{ fontSize: 11, color: "#fb923c", marginBottom: 8, display: "flex", alignItems: "center", gap: 4 }}>
          <Icon name="anvil" size={11} color="#fb923c" />
          {item.sharpens_count === 3 ? "Fully upgraded" : `Upgraded ${item.sharpens_count}×`} · base power was +{item.power - item.sharpens_count}
        </div>
      )}
      {item.stat_bonus && statBonusSummary(item.stat_bonus) && (
        <div style={{ fontSize: 11, color: "#86efac", marginBottom: 8, fontWeight: 600 }}>
          {statBonusSummary(item.stat_bonus)}
        </div>
      )}

      {/* Flavor */}
      {item.flavor && (
        <div
          style={{
            ...muted,
            fontSize: 12,
            fontStyle: "italic",
            marginBottom: 10,
            lineHeight: 1.5,
            borderLeft: `2px solid ${rc}44`,
            paddingLeft: 8,
          }}
        >
          {item.flavor}
        </div>
      )}

      {/* Effect */}
      <div
        style={{
          background: "#0a0b0e",
          borderRadius: 6,
          padding: "8px 10px",
          fontSize: 12,
          color: "#cbd5e1",
          lineHeight: 1.5,
          marginBottom: item.item_type === "tool" || item.item_type === "scroll" ? 6 : 12,
        }}
      >
        {describeItemEffect(item)}
      </div>
      {/* Status effect chip for items that apply effects */}
      {(() => {
        const entry = findCatalogEntry(item.item_name);
        const applies = entry ? CATALOG_EFFECT[entry.name] : undefined;
        if (!applies) return null;
        const col = EFFECT_COLOR[applies.effect];
        const icon = EFFECT_ICON[applies.effect];
        const targetLabel = applies.target === "self" ? "self" : "monster";
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
            <span style={{ fontSize: 10, color: "#6b7280" }}>Applies:</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, background: col + "22", border: `1px solid ${col}55`, color: col, borderRadius: 4, padding: "2px 7px" }}>
              <Icon name={icon} size={10} color={col} /> {applies.effect}
            </span>
            <span style={{ fontSize: 10, color: "#6b7280" }}>→ {targetLabel}</span>
          </div>
        );
      })()}

      {/* Level requirement badge */}
      {item.slot !== null && !item.equipped && !meetsLevel && (
        <div style={{ fontSize: 11, color: "#f87171", fontWeight: 600, marginBottom: 10 }}>
          Requires level {item.level_req}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {canEquip && (
          <button onClick={() => onEquip(item.id)} style={smallActionBtn("#1f3a1f", "#86efac")}>Equip</button>
        )}
        {item.equipped && (
          <button onClick={() => onUnequip(item.id)} style={smallActionBtn("#2a1a1a", "#fca5a5")}>Unequip</button>
        )}
        {canUse && (
          <button onClick={() => onUse(item.id)} style={smallActionBtn("#1f2a3a", "#7dd3fc")}>Use</button>
        )}
        {canGive && (
          <button
            onClick={() => { if (showGivePicker) { setShowGivePicker(false); } else { void openGivePicker(); } }}
            style={smallActionBtn(showGivePicker ? "#3a2030" : "#2a2030", showGivePicker ? "#f9a8d4" : "#c084fc")}
          >
            Give
          </button>
        )}
        {canSell && (
          <button onClick={() => onSell(item.id)} style={smallActionBtn("#33363d", "#e6e6e6")}>
            Sell · {sellPriceFor(item.item_type, item.rarity, { power: item.power, sharpens_count: item.sharpens_count })}g
          </button>
        )}
      </div>

      {/* Give picker */}
      {showGivePicker && (
        <div style={{ marginTop: 10, padding: "8px 10px", background: "#0a0b0e", borderRadius: 6, border: "1px solid #2a2d33", fontSize: 12 }}>
          <div style={{ ...muted, marginBottom: 6 }}>Give to:</div>
          {charsLoading && <div style={muted}>Loading players…</div>}
          {!charsLoading && characters.length === 0 && <div style={muted}>No other players found.</div>}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {characters.filter((ch) => ch.slack_user_id !== selfId).map((ch) => (
              <button
                key={ch.slack_user_id}
                style={smallActionBtn("#1a1a2e", "#c084fc")}
                onClick={() => { setShowGivePicker(false); onGive(item.id, ch.slack_user_id, ch.name); }}
              >
                {ch.name} ({ch.class})
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function smallActionBtn(bg: string, fg: string): React.CSSProperties {
  return {
    background: bg,
    color: fg,
    border: "1px solid #2a2d33",
    borderRadius: 6,
    padding: "4px 12px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
  };
}

function RarityBadge({ rarity }: { rarity: Rarity }) {
  const color = RARITY_COLOR[rarity];
  return (
    <span
      style={{
        ...smallBadge,
        background: `${color}22`,
        color,
        borderColor: `${color}55`,
      }}
    >
      {rarity}
    </span>
  );
}

function SmallBadge({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        ...smallBadge,
        background: "#2a2d33",
        color: "#c4c4c4",
        borderColor: "#3a3d44",
      }}
    >
      {children}
    </span>
  );
}

const HAGGLE_LABEL: Record<"failed" | "15" | "25" | "30", string> = {
  failed: "haggle failed",
  "15": "15% off",
  "25": "25% off",
  "30": "30% off",
};

function ShopCard({
  shop,
  navOverlay,
  onBuy,
  onHaggle,
  onBuyStaple,
  onRefresh,
  onRestock,
}: {
  shop: ShopResponse;
  navOverlay?: React.ReactNode;
  onBuy: (id: number, name: string) => void;
  onHaggle: (id: number) => void;
  onBuyStaple: (id: string) => void;
  onRefresh: () => Promise<void>;
  onRestock?: () => Promise<void>;
}) {
  const hero = navOverlay
    ? <LocationHero src={shop.art_url} label="Shop" nav={navOverlay} />
    : <Banner src={shop.art_url ?? null} alt="Shop" />;
  if (shop.error === "mid_quest") {
    return (
      <div style={card}>
        {hero}
        {!navOverlay && <h2 style={h2}>Shop</h2>}
        <p style={muted}>The shopkeep is afraid of monsters. Finish the quest first.</p>
      </div>
    );
  }
  if (shop.error === "no_channel" || !shop.channel_id) {
    return (
      <div style={card}>
        {hero}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          {!navOverlay && <h2 style={{ ...h2, margin: 0 }}>Shop</h2>}
          <RefreshButton onRefresh={onRefresh} />
        </div>
        <p style={muted}>
          No shop channel yet — start a quest in Slack first so we know which channel's shop to show.
        </p>
      </div>
    );
  }
  if (shop.needs_restock) {
    return (
      <div style={card}>
        {hero}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          {!navOverlay && <h2 style={{ ...h2, margin: 0 }}>Shop</h2>}
          <RefreshButton onRefresh={onRefresh} />
        </div>
        <p style={muted}>The shopkeep's shelves are bare.</p>
        {onRestock && (
          <RestockButton onRestock={onRestock} />
        )}
        {shop.staples && shop.staples.length > 0 && (
          <StaplesSection staples={shop.staples} gold={shop.gold} onBuyStaple={onBuyStaple} />
        )}
      </div>
    );
  }
  const available = shop.stock.filter((s) => !s.bought_by);
  const capUsed = shop.purchases_this_cycle ?? 0;
  const cap = shop.purchase_cap ?? 2;
  const atCap = capUsed >= cap;
  return (
    <div style={card}>
      {hero}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <h2 style={{ ...h2, margin: 0 }}>Shop</h2>
        <RefreshButton onRefresh={onRefresh} />
      </div>
      <p style={muted}>
        {available.length}/{shop.stock.length} items available · you have{" "}
        <strong style={{ color: "#fbbf24" }}>{shop.gold}g</strong> · {capUsed}/{cap} bought
        this cycle.
      </p>
      <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
        {shop.stock.map((s) => (
          <ShopRow
            key={s.id}
            item={s}
            playerGold={shop.gold}
            playerLevel={shop.level ?? 1}
            atCap={atCap}
            onBuy={onBuy}
            onHaggle={onHaggle}
          />
        ))}
      </div>
      <p style={{ ...muted, fontSize: 11, marginTop: 8 }}>
        Haggle is a free action (per item, once per cycle). Bards / Sages / Rogues get a
        bonus on the d6.
      </p>
      {shop.staples && shop.staples.length > 0 && (
        <StaplesSection staples={shop.staples} gold={shop.gold} onBuyStaple={onBuyStaple} />
      )}
    </div>
  );
}

// Always-in-stock potions — fixed prices, no buy cap, no haggle. Mirrors the
// slack "🧺 Always in stock" section. Buy buttons gate on gold balance.
function StaplesSection({
  staples,
  gold,
  onBuyStaple,
}: {
  staples: StapleItem[];
  gold: number;
  onBuyStaple: (id: string) => void;
}) {
  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8 }}>
        <Icon name="bubbling-potion" /> Always in stock
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {staples.map((s) => {
          const canAfford = gold >= s.price;
          return (
            <div
              key={s.id}
              style={{
                padding: 12,
                background: "#1d1f23",
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <div style={{ fontSize: 22 }}>{s.emoji}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 15, fontFamily: DISPLAY_FONT }}>{s.name}</div>
                <div style={{ ...muted, fontSize: 12, marginTop: 2 }}>{s.blurb}</div>
              </div>
              <div style={{ color: "#fbbf24", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                {s.price}g
              </div>
              <button
                onClick={() => onBuyStaple(s.id)}
                disabled={!canAfford}
                style={{
                  ...smallActionBtn(canAfford ? "#1f3a1f" : "#222428", canAfford ? "#86efac" : "#7a7d83"),
                  opacity: canAfford ? 1 : 0.6,
                  cursor: canAfford ? "pointer" : "not-allowed",
                }}
              >
                Buy
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ShopRow({
  item,
  playerGold,
  playerLevel,
  atCap,
  onBuy,
  onHaggle,
}: {
  item: ShopItem;
  playerGold: number;
  playerLevel: number;
  atCap: boolean;
  onBuy: (id: number, name: string) => void;
  onHaggle: (id: number) => void;
}) {
  const [showInfo, setShowInfo] = useState(false);
  const [pressing, setPressing] = useState(false);
  const sold = !!item.bought_by;
  const canAfford = playerGold >= item.price;
  const canBuy = !sold && canAfford && !atCap;
  const canHaggle = !sold && !item.haggled;
  const levelReq = item.level_req ?? Math.max(1, Math.ceil(item.power / 3));
  const underLevel = playerLevel < levelReq;
  return (
    <div
      style={{
        padding: 12,
        background: "#1d1f23",
        borderRadius: 8,
        opacity: sold ? 0.5 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Icon name={itemIcon(item)} size={24} color={itemIconColor(item) ?? "#cbd5e1"} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 15, fontFamily: DISPLAY_FONT }}>{item.item_name}</span>
            <RarityBadge rarity={item.rarity} />
            {levelReq > 1 && (
              <span
                title={underLevel ? `Requires level ${levelReq} to equip — you're level ${playerLevel}` : `Requires level ${levelReq} to equip`}
                style={{
                  ...smallBadge,
                  borderColor: underLevel ? "#dc262688" : "#3a3d44",
                  color: underLevel ? "#fca5a5" : "#9ca3af",
                  background: underLevel ? "#7f1d1d22" : "transparent",
                }}
              >
                L{levelReq}{underLevel ? " ⚠" : ""}
              </span>
            )}
            {item.item_type === "weapon" && item.weapon_range === "ranged" && (
              <SmallBadge>ranged</SmallBadge>
            )}
            {item.item_type === "weapon" && item.weapon_range === "focus" && (
              <SmallBadge>focus</SmallBadge>
            )}
            {item.haggled && (
              <SmallBadge>{HAGGLE_LABEL[item.haggled]}</SmallBadge>
            )}
          </div>
          {item.flavor && (
            <div style={{ ...muted, fontSize: 12, fontStyle: "italic", marginTop: 2 }}>
              {item.flavor}
            </div>
          )}
        </div>
        <div
          style={{
            fontVariantNumeric: "tabular-nums",
            color: canAfford ? "#fbbf24" : "#c0392b",
            fontWeight: 600,
            fontSize: 13,
          }}
        >
          +{item.power} · {item.price}g
        </div>
      </div>
      {showInfo && (
        <div
          style={{
            marginTop: 8,
            padding: "8px 10px",
            background: "#0e0f12",
            borderRadius: 6,
            border: "1px solid #2a2d33",
            color: "#cbd5e1",
            fontSize: 12,
          }}
        >
          {describeItemEffect(item)}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, marginTop: 8, justifyContent: "flex-end" }}>
        <button
          onClick={() => setShowInfo((v) => !v)}
          style={smallActionBtn("#222428", "#cbd5e1")}
          aria-expanded={showInfo}
        >
          {showInfo ? "Hide" : "Info"}
        </button>
        {!sold && canHaggle && (
          <button onClick={() => onHaggle(item.id)} style={smallActionBtn("#33363d", "#e6e6e6")}>
            Haggle
          </button>
        )}
        {!sold && (
          <button
            onClick={() => onBuy(item.id, item.item_name)}
            onPointerDown={() => canBuy && setPressing(true)}
            onPointerUp={() => setPressing(false)}
            onPointerLeave={() => setPressing(false)}
            disabled={!canBuy}
            style={{
              ...smallActionBtn(canBuy ? "#1f3a1f" : "#2a2d33", canBuy ? "#86efac" : "#6a7080"),
              transform: pressing ? "scale(0.92)" : "scale(1)",
              transition: "transform 0.08s",
            }}
          >
            {atCap ? "Cap reached" : !canAfford ? "Need more gold" : "Buy"}
          </button>
        )}
        {sold && (
          <span style={{ ...muted, fontSize: 11, alignSelf: "center" }}>Sold.</span>
        )}
      </div>
    </div>
  );
}

function InnCard({
  inn,
  navOverlay,
  onStay,
}: {
  inn: InnResponse;
  navOverlay?: React.ReactNode;
  onStay: (roomId: string) => void;
}) {
  const hero = navOverlay
    ? <LocationHero src={inn.art_url} label="The Inn" nav={navOverlay} />
    : <Banner src={inn.art_url ?? null} alt="The Inn" />;
  if (inn.error === "mid_quest") {
    return (
      <div style={card}>
        {hero}
        {!navOverlay && <h2 style={h2}>The Inn</h2>}
        <p style={muted}>The innkeep won't take questing parties. Finish the fight first.</p>
      </div>
    );
  }
  return (
    <div style={card}>
      {hero}
      <h2 style={h2}>The Inn</h2>
      <p style={muted}>
        A small hearth crackles in the corner. The innkeep looks up. <em>"Room for the night?"</em>
      </p>
      <p style={{ ...muted, fontSize: 12, marginTop: 4 }}>
        HP {inn.hp}/{inn.max_hp} · Mana {inn.mana}/{inn.max_mana} ·{" "}
        <span style={{ color: "#fbbf24", fontWeight: 600 }}>{inn.gold}g</span>
      </p>
      <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
        {inn.rooms.map((r) => {
          const wouldRefillHp = r.refills.hp && inn.hp < inn.max_hp;
          const wouldRefillMana = r.refills.mana && inn.mana < inn.max_mana;
          const useful = wouldRefillHp || wouldRefillMana;
          const canAfford = inn.gold >= r.price;
          const label = !useful
            ? `Already rested`
            : !canAfford
              ? `Need ${r.price}g`
              : `Stay — ${r.price}g`;
          return (
            <div
              key={r.id}
              style={{
                padding: 12,
                background: "#1d1f23",
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <Icon name={r.iconName} size={22} color="#cbd5e1" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 15, fontFamily: DISPLAY_FONT }}>{r.name}</div>
                <div style={{ ...muted, fontSize: 12, marginTop: 2 }}>{r.blurb}</div>
              </div>
              <button
                onClick={() => onStay(r.id)}
                disabled={!useful || !canAfford}
                style={{
                  ...smallActionBtn(
                    useful && canAfford ? "#1f3a1f" : "#222428",
                    useful && canAfford ? "#86efac" : "#7a7d83",
                  ),
                  opacity: useful && canAfford ? 1 : 0.6,
                  cursor: useful && canAfford ? "pointer" : "not-allowed",
                }}
              >
                {label}
              </button>
            </div>
          );
        })}
      </div>
      <p style={{ ...muted, fontSize: 11, marginTop: 8 }}>
        Inn rest bypasses the 24h long-rest cooldown.
      </p>
    </div>
  );
}

function SmithyCard({
  smithy,
  navOverlay,
  onSharpen,
}: {
  smithy: SmithyResponse;
  navOverlay?: React.ReactNode;
  onSharpen: (itemId: number, itemName: string, cost: number, verb: string) => void;
}) {
  const hero = navOverlay
    ? <LocationHero src={smithy.art_url} label="The Smithy" nav={navOverlay} />
    : <Banner src={smithy.art_url ?? null} alt="The Smithy" />;
  if (smithy.error === "mid_quest") {
    return (
      <div style={card}>
        {hero}
        {!navOverlay && <h2 style={h2}>The Smithy</h2>}
        <p style={muted}>The smith won't take your steel mid-quest — wrap up the fight first.</p>
      </div>
    );
  }
  return (
    <div style={card}>
      {hero}
      <h2 style={h2}>The Smithy</h2>
      <p style={muted}>
        <em>"Bring me steel and gold. I'll make it sing."</em>
      </p>
      <p style={{ ...muted, fontSize: 12, marginTop: 4 }}>
        <span style={{ color: "#fbbf24", fontWeight: 600 }}>{smithy.gold}g</span>{" "}
        · each upgrade adds <strong>+1</strong>; capped at <strong>3</strong> per item.
      </p>
      {smithy.items.length === 0 ? (
        <p style={muted}>
          Nothing equipped to work on. Equip a weapon or armor first, then come back.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          {smithy.items.map((it) => {
            const atCap = it.sharpens_count >= it.cap;
            const canAfford = smithy.gold >= it.cost;
            const remaining = it.cap - it.sharpens_count;
            const label = atCap
              ? `Maxed`
              : canAfford
                ? `${it.verb.verb} +1 — ${it.cost}g`
                : `Need ${it.cost}g`;
            const meter = "●".repeat(it.sharpens_count) + "○".repeat(remaining);
            return (
              <div
                key={it.id}
                style={{
                  padding: 12,
                  background: "#1d1f23",
                  borderRadius: 8,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <Icon name={it.verb.iconName} size={22} color="#cbd5e1" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 15, fontFamily: DISPLAY_FONT }}>
                    {it.item_name} <span style={{ color: "#fbbf24", fontWeight: 500 }}>+{it.power}</span>{" "}
                    <span style={{ ...muted, fontSize: 11 }}>{it.verb.stat}</span>
                  </div>
                  <div style={{ ...muted, fontSize: 12, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
                    {meter} ({it.sharpens_count}/{it.cap} {it.verb.noun})
                  </div>
                </div>
                <button
                  onClick={() => onSharpen(it.id, it.item_name, it.cost, it.verb.verb)}
                  disabled={atCap || !canAfford}
                  style={{
                    ...smallActionBtn(
                      !atCap && canAfford ? "#1f3a1f" : "#222428",
                      !atCap && canAfford ? "#86efac" : "#7a7d83",
                    ),
                    opacity: !atCap && canAfford ? 1 : 0.6,
                    cursor: !atCap && canAfford ? "pointer" : "not-allowed",
                  }}
                >
                  {label}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// PUB NPC CONVERSATIONS
// =============================================================================

function NpcSection({ npcs }: { npcs: { bartender: PubNpc | null; regulars: PubNpc[] } }) {
  const [active, setActive] = useState<PubNpc | null>(null);
  const all = [npcs.bartender, ...npcs.regulars].filter((n): n is PubNpc => n !== null);

  return (
    <div style={{ marginTop: 24, borderTop: "1px solid #2a2d33", paddingTop: 16 }}>
      <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 10 }}>
        <Icon name="player" size={11} /> At the Bar
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: active ? 16 : 0 }}>
        {all.map((npc) => (
          <button
            key={npc.id}
            onClick={() => setActive(active?.id === npc.id ? null : npc)}
            style={{
              padding: "5px 12px",
              borderRadius: 6,
              border: `1px solid ${active?.id === npc.id ? "#6366f1" : "#2a2d33"}`,
              background: active?.id === npc.id ? "#1e1e3a" : "#16181c",
              color: active?.id === npc.id ? "#a5b4fc" : "#d1d5db",
              cursor: "pointer", fontSize: 12, fontFamily: "inherit",
            }}
          >
            <Icon name="conversation" size={10} /> {npc.name}
            {npc.role === "bartender" && <span style={{ ...muted, fontSize: 10, marginLeft: 4 }}>(bartender)</span>}
          </button>
        ))}
      </div>
      {active && <NpcConversation key={active.id} npc={active} onClose={() => setActive(null)} />}
    </div>
  );
}

function NpcConversation({ npc, onClose }: { npc: PubNpc; onClose: () => void }) {
  const [path, setPath] = useState("");
  const [dialog, setDialog] = useState<PubTalkResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function talk(newPath: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/pub/talk/${npc.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ path: newPath }),
      });
      const body = (await res.json()) as PubTalkResponse & { error?: string };
      if (!res.ok) {
        setError(body.error ?? "Something went wrong.");
        return;
      }
      setPath(newPath);
      setDialog(body);
    } finally {
      setLoading(false);
    }
  }

  // Auto-open on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void talk(""); }, []);

  return (
    <div style={{
      background: "#16181c", border: "1px solid #2a2d33", borderRadius: 8,
      padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <span style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 13 }}>
          {npc.name}
          <span style={{ ...muted, fontSize: 11, fontWeight: 400, marginLeft: 6 }}>({npc.archetype})</span>
        </span>
        {path && (
          <button
            onClick={() => { setPath(""); setDialog(null); void talk(""); }}
            style={{ background: "none", border: "none", color: "#6b7280", cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}
          >
            ↺ restart
          </button>
        )}
      </div>

      {loading && <p style={{ ...muted, fontSize: 13 }}>…</p>}
      {error && <p style={{ color: "#fca5a5", fontSize: 13 }}>{error}</p>}

      {dialog && !loading && (
        <>
          <p style={{ color: "#e5e7eb", fontSize: 14, lineHeight: 1.55, margin: 0, fontStyle: "italic" }}>
            &ldquo;{dialog.npc_says}&rdquo;
          </p>

          {dialog.payload_applied && (
            <div style={{
              padding: "6px 10px", borderRadius: 6,
              background: "#1a2a1a", border: "1px solid #2d5a2d",
              color: "#86efac", fontSize: 12,
            }}>
              🎁 {dialog.payload_applied}
            </div>
          )}

          {!dialog.is_terminal ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {dialog.options.map((opt) => (
                <button
                  key={opt.index}
                  onClick={() => {
                    const next = path ? `${path},${opt.index}` : String(opt.index);
                    void talk(next);
                  }}
                  style={{
                    padding: "8px 12px", borderRadius: 6, textAlign: "left",
                    border: "1px solid #2a2d33", background: "#1d1f23",
                    color: "#d1d5db", cursor: "pointer", fontSize: 13,
                    fontFamily: "inherit",
                  }}
                >
                  {opt.has_payload && <span style={{ color: "#fbbf24", marginRight: 5 }}>✦</span>}
                  {opt.player_says}
                </button>
              ))}
            </div>
          ) : (
            <button
              onClick={onClose}
              style={{
                padding: "6px 12px", borderRadius: 6, border: "1px solid #2a2d33",
                background: "none", color: "#9ca3af", cursor: "pointer",
                fontSize: 12, fontFamily: "inherit", alignSelf: "flex-start",
              }}
            >
              🚪 Walk away
            </button>
          )}
        </>
      )}
    </div>
  );
}

// =============================================================================
// PUB CARD — Drink menu + Liars' Roll mini-game
// =============================================================================

function PubCard({
  pub,
  navOverlay,
  onBuyDrink,
  onRefresh,
}: {
  pub: PubResponse;
  navOverlay?: React.ReactNode;
  onBuyDrink: (drinkId: string) => void;
  onRefresh: () => Promise<void>;
}) {
  return (
    <div style={card}>
      {navOverlay
        ? <LocationHero src={pub.art_url} label="The Pub" nav={navOverlay} />
        : pub.art_url ? <Banner src={pub.art_url} alt="The Pub" /> : null}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: navOverlay ? 0 : undefined }}>
        {!navOverlay && <h2 style={{ ...h2, margin: 0 }}><Icon name="beer-stein" size={18} /> The Pub</h2>}
        <RefreshButton onRefresh={onRefresh} style={{ marginLeft: "auto" }} />
      </div>
      <p style={{ ...muted, marginTop: 4 }}>
        <em>"Smoke, sawdust, a thousand failed deployments worth of regret in the air."</em>
      </p>

      {/* Active drink buff display */}
      {pub.drink_buff && (
        <div
          style={{
            marginTop: 12,
            padding: "8px 12px",
            background: "#1a2a1a",
            border: "1px solid #2d5a2d",
            borderRadius: 8,
            fontSize: 13,
            color: "#86efac",
          }}
        >
          Active buff: <strong>{drinkBuffLabel(pub.drink_buff)}</strong> · {pub.drink_buff.fight_duration ? "lasts this fight" : `${pub.drink_buff.remaining} action${pub.drink_buff.remaining === 1 ? "" : "s"} remaining`}
        </div>
      )}

      {/* Drink menu */}
      <div style={{ marginTop: 16 }}>
        <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>Drink Menu · <span style={{ color: "#fbbf24" }}>{pub.gold}g</span></span>
          <span style={{ color: pub.drinks_remaining > 0 ? "#86efac" : "#fca5a5" }}>
            <Icon name="beer-stein" size={10} /> {pub.drinks_remaining}/{2} before quest
          </span>
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          {pub.drinks.map((d) => (
            <div
              key={d.id}
              style={{
                padding: "10px 12px",
                background: "#1d1f23",
                borderRadius: 8,
                border: d.is_daily_special ? "1px solid #b89b3a" : "1px solid transparent",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <span style={{ fontSize: 20 }}>{d.emoji}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 14, display: "flex", alignItems: "center", gap: 6, fontFamily: DISPLAY_FONT }}>
                  {d.name}
                  {d.is_daily_special && (
                    <span style={{ fontSize: 10, background: "#b89b3a22", color: "#fbbf24", border: "1px solid #b89b3a55", borderRadius: 4, padding: "1px 5px", fontWeight: 700 }}>
                      SPECIAL
                    </span>
                  )}
                  {d.fight_duration && (
                    <span style={{ fontSize: 10, background: "#1a2a3a", color: "#7dd3fc", border: "1px solid #1e4a6a", borderRadius: 4, padding: "1px 5px", fontWeight: 700 }}>
                      FULL FIGHT
                    </span>
                  )}
                </div>
                <div style={{ ...muted, fontSize: 12, marginTop: 2 }}>{d.blurb}</div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
                <div style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, color: "#fbbf24", fontSize: 14 }}>
                  {d.actual_price}g
                  {d.is_daily_special && (
                    <span style={{ ...muted, textDecoration: "line-through", marginLeft: 4, fontSize: 11 }}>{d.price}g</span>
                  )}
                </div>
                <button
                  onClick={() => onBuyDrink(d.id)}
                  disabled={pub.gold < d.actual_price || pub.drinks_remaining <= 0}
                  style={{
                    ...smallActionBtn(pub.gold >= d.actual_price && pub.drinks_remaining > 0 ? "#1f2a3a" : "#222428", pub.gold >= d.actual_price && pub.drinks_remaining > 0 ? "#7dd3fc" : "#7a7d83"),
                    opacity: pub.gold >= d.actual_price && pub.drinks_remaining > 0 ? 1 : 0.6,
                    cursor: pub.gold >= d.actual_price && pub.drinks_remaining > 0 ? "pointer" : "not-allowed",
                  }}
                >
                  {pub.drinks_remaining <= 0 ? "Cutoff" : "Order"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* At the Bar — NPC conversations */}
      {pub.npcs && (pub.npcs.bartender || pub.npcs.regulars.length > 0) && (
        <NpcSection npcs={pub.npcs} />
      )}
    </div>
  );
}

const LIARS_TRUST_MULT_DISPLAY = "1.7";
const LIARS_CHALLENGE_MULT_DISPLAY = "2.5";

// =============================================================================
// GAME CARDS — Liars' Roll and SPD as standalone cards
// =============================================================================

function GameCardHeader({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
      <div style={{
        width: 56, height: 56, borderRadius: 10,
        background: "#16181c", border: "1px solid #2a2d33",
        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
      }}>
        <Icon name={icon} size={32} />
      </div>
      <div>
        <div style={{ fontWeight: 700, fontSize: 16, color: "#f5f5f5", fontFamily: DISPLAY_FONT }}>{title}</div>
        <div style={{ ...muted, fontSize: 12, marginTop: 2 }}>{subtitle}</div>
      </div>
    </div>
  );
}

function StakeButtons({
  stakes,
  gold,
  disabled,
  btnStyle,
  customInputStyle,
  onPick,
}: {
  stakes: number[];
  gold: number;
  disabled: boolean;
  btnStyle: (canAfford: boolean) => React.CSSProperties;
  customInputStyle: React.CSSProperties;
  onPick: (amount: number) => void;
}) {
  const [showCustom, setShowCustom] = useState(false);
  const [customVal, setCustomVal] = useState("");

  if (showCustom) {
    const parsed = parseInt(customVal, 10);
    const valid = !isNaN(parsed) && parsed >= 1 && parsed <= gold;
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="number"
          min={1}
          max={gold}
          value={customVal}
          onChange={(e) => setCustomVal(e.target.value)}
          placeholder="amount"
          autoFocus
          style={{
            width: 90, padding: "4px 8px", borderRadius: 6,
            border: "1px solid #3a3d44", background: "#0e0f12",
            color: "#f5f5f5", fontSize: 13, fontFamily: "inherit",
          }}
        />
        <button
          disabled={disabled || !valid}
          onClick={() => { onPick(parsed); setShowCustom(false); setCustomVal(""); }}
          style={{ ...customInputStyle, opacity: valid ? 1 : 0.4, cursor: valid ? "pointer" : "not-allowed" }}
        >
          Bet
        </button>
        <button
          onClick={() => { setShowCustom(false); setCustomVal(""); }}
          style={smallActionBtn("#222428", "#94a3b8")}
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {stakes.map((s) => (
        <button
          key={s}
          onClick={() => onPick(s)}
          disabled={disabled || gold < s}
          style={{ ...btnStyle(gold >= s), opacity: gold >= s ? 1 : 0.5, cursor: gold >= s ? "pointer" : "not-allowed" }}
        >
          <Icon name="gold-bar" size={11} /> {s}g
        </button>
      ))}
      <button
        onClick={() => setShowCustom(true)}
        disabled={disabled || gold < 1}
        style={{ ...smallActionBtn("#1a1c24", "#94a3b8"), opacity: gold >= 1 ? 1 : 0.5, cursor: gold >= 1 ? "pointer" : "not-allowed" }}
      >
        Custom…
      </button>
    </div>
  );
}

function LiarsRollCard({ gold, onRefresh }: { gold: number; onRefresh: () => Promise<void> }) {
  const [liarsState, setLiarsState] = useState<
    | { phase: "idle" }
    | { phase: "pending"; round: LiarsRoundPending }
    | { phase: "result"; result: LiarsRoundResult }
  >({ phase: "idle" });
  const [loading, setLoading] = useState(false);

  async function startLiars(stake: number) {
    setLoading(true);
    try {
      const res = await fetch("/api/pub/liars/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ stake }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        const code = typeof body.error === "string" ? body.error : `http_${res.status}`;
        toast.error(code === "insufficient_gold" ? "Not enough gold." : code);
        return;
      }
      setLiarsState({ phase: "pending", round: body as unknown as LiarsRoundPending });
    } finally {
      setLoading(false);
    }
  }

  async function decideLiars(roundId: number, choice: "trust" | "challenge") {
    setLoading(true);
    try {
      const res = await fetch(`/api/pub/liars/${roundId}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ choice }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        toast.error(typeof body.error === "string" ? body.error : "Something went wrong.");
        return;
      }
      setLiarsState({ phase: "result", result: body as unknown as LiarsRoundResult });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={card}>
      <GameCardHeader
        icon="perspective-dice-six"
        title="Liars' Roll"
        subtitle={`Both roll 3d6. Bartender claims a zone — lies 45% of the time. Trust (${LIARS_TRUST_MULT_DISPLAY}×) or Challenge (${LIARS_CHALLENGE_MULT_DISPLAY}×)?`}
      />

      {liarsState.phase === "idle" && (
        <div>
          <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}>Pick a stake:</div>
          <StakeButtons
            stakes={[10, 25, 50]}
            gold={gold}
            disabled={loading}
            btnStyle={(can) => ({ ...smallActionBtn(can ? "#2a1f1f" : "#222428", can ? "#fca5a5" : "#7a7d83") })}
            customInputStyle={smallActionBtn("#2a1f1f", "#fca5a5")}
            onPick={(s) => void startLiars(s)}
          />
        </div>
      )}

      {liarsState.phase === "pending" && (() => {
        const r = liarsState.round;
        return (
          <div>
            <div style={{ background: "#1d1f23", borderRadius: 8, padding: 12, marginBottom: 10 }}>
              <div style={{ color: "#f5f5f5", fontWeight: 600, marginBottom: 4 }}>
                Bartender&apos;s claim: <span style={{ color: "#fbbf24" }}>{r.claim_label}</span>
              </div>
              <div style={{ ...muted, fontSize: 13 }}>
                Your dice: {r.player_dice.join(", ")} (sum: <strong>{r.player_sum}</strong>)
              </div>
              <div style={{ ...muted, fontSize: 12, marginTop: 4 }}>
                Stake: {r.stake}g · Trust pays {r.trust_mult}× · Challenge pays {r.challenge_mult}× · {r.house_cut_pct}% house rake on wins
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => void decideLiars(r.round_id, "trust")} disabled={loading} style={smallActionBtn("#1f3a1f", "#86efac")}>
                <Icon name="hand" size={12} /> Trust ({r.trust_mult}×)
              </button>
              <button onClick={() => void decideLiars(r.round_id, "challenge")} disabled={loading} style={smallActionBtn("#3a1f1f", "#fca5a5")}>
                <Icon name="fire" size={12} /> Challenge ({r.challenge_mult}×)
              </button>
            </div>
          </div>
        );
      })()}

      {liarsState.phase === "result" && (() => {
        const r = liarsState.result;
        const won = r.payout > 0;
        return (
          <div>
            <div style={{ background: won ? "#1a2a1a" : "#2a1a1a", border: `1px solid ${won ? "#2d5a2d" : "#5a2d2d"}`, borderRadius: 8, padding: 12, marginBottom: 10 }}>
              <div style={{ fontWeight: 700, color: won ? "#86efac" : "#fca5a5", marginBottom: 6, fontFamily: DISPLAY_FONT }}>
                {won
                  ? r.choice === "trust" ? <><Icon name="hand" size={13} /> Trusted correctly — +{r.payout}g!</> : <><Icon name="fire" size={13} /> Called the bluff — +{r.payout}g!</>
                  : r.choice === "trust" ? <><Icon name="daggers" size={13} /> Trusted a liar — lost the stake.</> : <><Icon name="daggers" size={13} /> Called an honest claim — lost the stake.</>}
              </div>
              <div style={{ ...muted, fontSize: 13 }}>
                {r.lied ? "The bartender was lying." : "The bartender told the truth."}{" "}
                True zone: <strong>{r.truth_label}</strong>.
              </div>
              <div style={{ ...muted, fontSize: 12, marginTop: 4 }}>
                Your dice: {r.player_dice.join(", ")} · Bartender: {r.bartender_dice.join(", ")} · Combined: {r.combined}
              </div>
              <div style={{ marginTop: 6, color: "#fbbf24", fontSize: 13, fontWeight: 600 }}>Gold: {r.gold}g</div>
            </div>
            <button onClick={() => { setLiarsState({ phase: "idle" }); onRefresh(); }} style={smallActionBtn("#222428", "#cbd5e1")}>
              Play again
            </button>
          </div>
        );
      })()}
    </div>
  );
}

function SpdCard({ pub, selfId, onRefresh }: { pub: PubResponse; selfId: string; onRefresh: () => Promise<void> }) {
  const [spdStake, setSpdStake] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [spdResult, setSpdResult] = useState<SpdResult | null>(null);

  const SPD_THROW_LABELS: Record<SpdThrow, React.ReactNode> = {
    stone: <><Icon name="rune-stone" size={12} /> Stone</>,
    parchment: <><Icon name="scroll-unfurled" size={12} /> Parchment</>,
    dagger: <><Icon name="plain-dagger" size={12} /> Dagger</>,
  };

  async function spdStart(stake: number, throwChoice: SpdThrow) {
    setLoading(true);
    try {
      const { ok } = await postJson("/api/pub/spd/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stake, throw: throwChoice }) });
      if (ok) { setSpdStake(null); onRefresh(); }
    } finally { setLoading(false); }
  }

  async function spdAccept(matchId: number, throwChoice: SpdThrow) {
    setLoading(true);
    try {
      const res = await fetch(`/api/pub/spd/${matchId}/accept`, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ throw: throwChoice }) });
      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok) { const code = typeof body.error === "string" ? body.error : `http_${res.status}`; toast.error((ERROR_LABELS as Record<string, string>)[code] ?? code); return; }
      setSpdResult(body as unknown as SpdResult);
      onRefresh();
    } finally { setLoading(false); }
  }

  async function spdBet(matchId: number, side: "initiator" | "challenger", amount: number) {
    setLoading(true);
    try {
      const { ok } = await postJson(`/api/pub/spd/${matchId}/bet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ side, amount }) });
      if (ok) onRefresh();
    } finally { setLoading(false); }
  }

  async function spdCancel(matchId: number) {
    setLoading(true);
    try {
      const { ok } = await postJson(`/api/pub/spd/${matchId}/cancel`, { method: "POST" });
      if (ok) onRefresh();
    } finally { setLoading(false); }
  }

  const spd = pub.spd;
  const openMatch = spd?.open_match ?? null;
  const myBet = spd?.my_bet ?? null;
  const betTotals = spd?.bet_totals ?? { initiator: 0, challenger: 0 };
  const iAmInitiator = openMatch?.initiator_user_id === selfId;
  const iAmChallenger = openMatch?.challenger_user_id === selfId;
  const canBet = openMatch !== null && !iAmInitiator && !iAmChallenger && myBet === null;

  return (
    <div style={card}>
      <GameCardHeader
        icon="plain-dagger"
        title="Stone-Parchment-Dagger"
        subtitle="Commit a throw secretly. Loser pays winner both stakes +20%. Side bets pay 2×. Ties refund all."
      />

      {spdResult && (
        <div>
          <div style={{ background: spdResult.tie ? "#1d2a2d" : spdResult.winner_user_id === selfId ? "#1a2a1a" : "#2a1a1a", border: `1px solid ${spdResult.tie ? "#2d4a5a" : spdResult.winner_user_id === selfId ? "#2d5a2d" : "#5a2d2d"}`, borderRadius: 8, padding: 12, marginBottom: 10 }}>
            <div style={{ fontWeight: 700, color: spdResult.tie ? "#93c5fd" : spdResult.winner_user_id === selfId ? "#86efac" : "#fca5a5", marginBottom: 6, fontFamily: DISPLAY_FONT }}>
              {spdResult.tie ? <><Icon name="hand" size={13} /> Tie! Everything refunded.</> : spdResult.winner_user_id === selfId ? <><Icon name="trophy" size={13} /> You won! +{spdResult.payout}g</> : <><Icon name="daggers" size={13} /> You lost the match.</>}
            </div>
            <div style={{ ...muted, fontSize: 13 }}>
              {spdResult.initiator_name} threw {SPD_THROW_LABELS[spdResult.initiator_throw]} · You threw {SPD_THROW_LABELS[spdResult.challenger_throw]}
            </div>
            {!spdResult.tie && spdResult.house_bump > 0 && <div style={{ ...muted, fontSize: 12, marginTop: 4 }}>House bump: +{spdResult.house_bump}g on total pot</div>}
            <div style={{ marginTop: 6, color: "#fbbf24", fontSize: 13, fontWeight: 600 }}>Gold: {spdResult.gold}g</div>
          </div>
          <button onClick={() => { setSpdResult(null); onRefresh(); }} style={smallActionBtn("#222428", "#cbd5e1")}>Done</button>
        </div>
      )}

      {!spdResult && (<>
        {!openMatch && (
          <div>
            {spdStake === null ? (
              <div>
                <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}>Pick a stake:</div>
                <StakeButtons
                  stakes={[10, 25, 50]}
                  gold={pub.gold}
                  disabled={loading}
                  btnStyle={(can) => ({ ...smallActionBtn(can ? "#2a1f2a" : "#222428", can ? "#d8b4fe" : "#7a7d83") })}
                  customInputStyle={smallActionBtn("#2a1f2a", "#d8b4fe")}
                  onPick={(s) => setSpdStake(s)}
                />
              </div>
            ) : (
              <div>
                <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}>
                  Stake: <strong style={{ color: "#fbbf24" }}>{spdStake}g</strong> — pick your throw (only you will see it):
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {(["stone", "parchment", "dagger"] as SpdThrow[]).map((t) => (
                    <button key={t} onClick={() => void spdStart(spdStake, t)} disabled={loading} style={smallActionBtn("#2a2010", "#fde68a")}>
                      {SPD_THROW_LABELS[t]}
                    </button>
                  ))}
                  <button onClick={() => setSpdStake(null)} disabled={loading} style={smallActionBtn("#222428", "#94a3b8")}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}

        {openMatch && iAmInitiator && (
          <div>
            <div style={{ background: "#1d2a1d", border: "1px solid #2d5a2d", borderRadius: 8, padding: 12, marginBottom: 10 }}>
              <div style={{ color: "#86efac", fontWeight: 600, marginBottom: 4 }}>Your match is open — waiting for a challenger</div>
              <div style={{ ...muted, fontSize: 13 }}>Stake: <strong style={{ color: "#fbbf24" }}>{openMatch.initiator_stake}g</strong> · Your throw is hidden until someone accepts.</div>
              {(betTotals.initiator > 0 || betTotals.challenger > 0) && <div style={{ ...muted, fontSize: 12, marginTop: 4 }}>Side bets: {betTotals.initiator}g on you · {betTotals.challenger}g on challenger</div>}
            </div>
            <button onClick={() => void spdCancel(openMatch.id)} disabled={loading} style={smallActionBtn("#2a1a1a", "#fca5a5")}>Cancel match (refunds your stake)</button>
          </div>
        )}

        {openMatch && !iAmInitiator && (
          <div>
            <div style={{ background: "#1d1f23", borderRadius: 8, padding: 12, marginBottom: 10, border: "1px solid #3a3d45" }}>
              <div style={{ color: "#f5f5f5", fontWeight: 600, marginBottom: 4 }}>⚔️ {openMatch.initiator_name} threw something for {openMatch.initiator_stake}g</div>
              <div style={{ ...muted, fontSize: 13 }}>Their throw is secret until you accept. Winner gets {openMatch.initiator_stake * 2}g + 20% bump.</div>
              {(betTotals.initiator > 0 || betTotals.challenger > 0) && <div style={{ ...muted, fontSize: 12, marginTop: 4 }}>Side bets: {betTotals.initiator}g on {openMatch.initiator_name} · {betTotals.challenger}g on challenger</div>}
            </div>

            {!iAmChallenger && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}>Accept the challenge — pick your throw:</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {(["stone", "parchment", "dagger"] as SpdThrow[]).map((t) => (
                    <button key={t} onClick={() => void spdAccept(openMatch.id, t)} disabled={loading || pub.gold < openMatch.initiator_stake}
                      style={{ ...smallActionBtn(pub.gold >= openMatch.initiator_stake ? "#2a1020" : "#222428", pub.gold >= openMatch.initiator_stake ? "#f9a8d4" : "#7a7d83"), opacity: pub.gold >= openMatch.initiator_stake ? 1 : 0.5, cursor: pub.gold >= openMatch.initiator_stake ? "pointer" : "not-allowed" }}>
                      {SPD_THROW_LABELS[t]}
                    </button>
                  ))}
                </div>
                {pub.gold < openMatch.initiator_stake && <div style={{ ...muted, fontSize: 12, marginTop: 6, color: "#fca5a5" }}>Need {openMatch.initiator_stake}g to accept (you have {pub.gold}g)</div>}
              </div>
            )}

            {canBet && (
              <div>
                <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}>Or place a side bet (pays 2× if your pick wins):</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ ...muted, fontSize: 12 }}>Back {openMatch.initiator_name}:</span>
                  <StakeButtons
                    stakes={[5, 10, 25]}
                    gold={pub.gold}
                    disabled={loading}
                    btnStyle={(can) => ({ ...smallActionBtn(can ? "#2a1f10" : "#222428", can ? "#fdba74" : "#7a7d83") })}
                    customInputStyle={smallActionBtn("#2a1f10", "#fdba74")}
                    onPick={(amt) => void spdBet(openMatch.id, "initiator", amt)}
                  />
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ ...muted, fontSize: 12 }}>Back challenger:</span>
                  <StakeButtons
                    stakes={[5, 10, 25]}
                    gold={pub.gold}
                    disabled={loading}
                    btnStyle={(can) => ({ ...smallActionBtn(can ? "#10202a" : "#222428", can ? "#93c5fd" : "#7a7d83") })}
                    customInputStyle={smallActionBtn("#10202a", "#93c5fd")}
                    onPick={(amt) => void spdBet(openMatch.id, "challenger", amt)}
                  />
                </div>
              </div>
            )}

            {myBet && <div style={{ ...muted, fontSize: 13, marginTop: 8 }}>You bet {myBet.amount}g on {myBet.side === "initiator" ? openMatch.initiator_name : "the challenger"}.</div>}
          </div>
        )}
      </>)}
    </div>
  );
}

const GAME_LABELS: Record<string, string> = { liars: "Liar's Roll", spd_match: "SPD match", spd_bet: "SPD side-bet" };

function PubLeaderboardCard({ entries }: { entries: PubLeaderboardEntry[] }) {
  return (
    <div style={card}>
      <h2 style={{ ...h2, marginBottom: 12 }}>
        <Icon name="trophy" size={1} /> Pub Leaderboard
      </h2>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #2a2d33" }}>
              <th style={{ textAlign: "left", padding: "4px 8px 4px 0", color: "#7a7d83", fontWeight: 500, whiteSpace: "nowrap" }}>#</th>
              <th style={{ textAlign: "left", padding: "4px 8px", color: "#7a7d83", fontWeight: 500 }}>Player</th>
              <th style={{ textAlign: "right", padding: "4px 8px", color: "#7a7d83", fontWeight: 500, whiteSpace: "nowrap" }}>Games</th>
              <th style={{ textAlign: "right", padding: "4px 8px", color: "#7a7d83", fontWeight: 500, whiteSpace: "nowrap" }}>Wins</th>
              <th style={{ textAlign: "right", padding: "4px 0 4px 8px", color: "#7a7d83", fontWeight: 500, whiteSpace: "nowrap" }}>Net</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => {
              const rank = i + 1;
              const rankColor = rank === 1 ? "#fbbf24" : rank === 2 ? "#d1d5db" : rank === 3 ? "#cd7c2f" : "#7a7d83";
              const netColor = e.net > 0 ? "#86efac" : e.net < 0 ? "#fca5a5" : "#7a7d83";
              const winRate = e.games > 0 ? Math.round((e.wins / e.games) * 100) : 0;
              return (
                <tr key={e.user_id} style={{ borderBottom: "1px solid #1e2025" }}>
                  <td style={{ padding: "6px 8px 6px 0", color: rankColor, fontWeight: rank <= 3 ? 700 : 400 }}>{rank}</td>
                  <td style={{ padding: "6px 8px" }}>
                    <div style={{ fontWeight: 500, color: "#f5f5f5" }}>{e.name}</div>
                    {e.slack_username && <div style={{ color: "#7a7d83", fontSize: 11 }}>@{e.slack_username}</div>}
                  </td>
                  <td style={{ padding: "6px 8px", textAlign: "right", color: "#cbd5e1" }}>{e.games}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right", color: "#cbd5e1" }}>{e.wins} <span style={{ color: "#7a7d83", fontSize: 11 }}>({winRate}%)</span></td>
                  <td style={{ padding: "6px 0 6px 8px", textAlign: "right", color: netColor, fontWeight: 600 }}>
                    {e.net > 0 ? "+" : ""}{e.net}g
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p style={{ ...muted, fontSize: 11, marginTop: 10 }}>All-time across Liar's Roll, SPD matches, and side bets.</p>
    </div>
  );
}

function drinkBuffLabel(buff: DrinkBuff): string {
  if (buff.kind === "buff_attack") return `+${buff.magnitude} attack`;
  if (buff.kind === "buff_magic") return `+${buff.magnitude} magic`;
  return "next attack/cast/sig crits";
}

const VARIANT_LABEL: Record<string, string> = {
  standard: "Standard",
  boss: "Boss",
  gauntlet: "Gauntlet",
  dungeon: "Dungeon",
};

function QuestStatsCard({ stats }: { stats: QuestStats }) {
  const variants = Object.entries(stats.by_variant).sort((a, b) => b[1].total - a[1].total);
  return (
    <div style={card}>
      <h2 style={{ ...h2, marginBottom: 16 }}>
        <Icon name="trophy" size={18} /> Quest Record
      </h2>
      {/* W–L summary row */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 16 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#86efac", lineHeight: 1 }}>{stats.wins}</div>
          <div style={{ ...muted, fontSize: 11, marginTop: 2 }}>Wins</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#fca5a5", lineHeight: 1 }}>{stats.losses}</div>
          <div style={{ ...muted, fontSize: 11, marginTop: 2 }}>Losses</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#f5f5f5", lineHeight: 1 }}>{stats.win_rate}%</div>
          <div style={{ ...muted, fontSize: 11, marginTop: 2 }}>Win rate</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#fbbf24", lineHeight: 1 }}>{stats.current_streak}</div>
          <div style={{ ...muted, fontSize: 11, marginTop: 2 }}>Streak</div>
        </div>
        {stats.best_streak > 1 && (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: "#c084fc", lineHeight: 1 }}>{stats.best_streak}</div>
            <div style={{ ...muted, fontSize: 11, marginTop: 2 }}>Best streak</div>
          </div>
        )}
        {stats.elite_wins > 0 && (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: "#f97316", lineHeight: 1 }}>{stats.elite_wins}</div>
            <div style={{ ...muted, fontSize: 11, marginTop: 2 }}>Elite wins</div>
          </div>
        )}
      </div>
      {/* Per-variant pills */}
      {variants.length > 1 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {variants.map(([v, s]) => {
            const wr = s.total > 0 ? Math.round((s.wins / s.total) * 100) : 0;
            return (
              <div
                key={v}
                style={{
                  background: "#1d1f23",
                  border: "1px solid #2a2d33",
                  borderRadius: 8,
                  padding: "6px 10px",
                  fontSize: 12,
                }}
              >
                <span style={{ color: "#c4c4c4", fontWeight: 600 }}>{VARIANT_LABEL[v] ?? v}</span>
                <span style={{ ...muted, marginLeft: 6 }}>{s.wins}/{s.total}</span>
                <span style={{ color: wr >= 50 ? "#86efac" : "#fca5a5", marginLeft: 4, fontWeight: 600 }}>{wr}%</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function QuestLeaderboardCard({ entries, selfId }: { entries: QuestLeaderboardEntry[]; selfId: string }) {
  return (
    <div style={card}>
      <h2 style={{ ...h2, marginBottom: 12 }}>
        <Icon name="trophy" size={1} /> Hall of Heroes
      </h2>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #2a2d33" }}>
              <th style={{ textAlign: "left", padding: "4px 8px 4px 0", color: "#7a7d83", fontWeight: 500 }}>#</th>
              <th style={{ textAlign: "left", padding: "4px 8px", color: "#7a7d83", fontWeight: 500 }}>Player</th>
              <th style={{ textAlign: "right", padding: "4px 8px", color: "#7a7d83", fontWeight: 500, whiteSpace: "nowrap" }}>W</th>
              <th style={{ textAlign: "right", padding: "4px 8px", color: "#7a7d83", fontWeight: 500, whiteSpace: "nowrap" }}>W%</th>
              <th style={{ textAlign: "right", padding: "4px 0 4px 8px", color: "#7a7d83", fontWeight: 500, whiteSpace: "nowrap" }}>Elite</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => {
              const rank = i + 1;
              const rankColor = rank === 1 ? "#fbbf24" : rank === 2 ? "#d1d5db" : rank === 3 ? "#cd7c2f" : "#7a7d83";
              const wr = e.total_quests > 0 ? Math.round((e.wins / e.total_quests) * 100) : 0;
              const isSelf = e.slack_user_id === selfId;
              return (
                <tr key={e.slack_user_id} style={{ borderBottom: "1px solid #1e2025", background: isSelf ? "#1d2128" : "transparent" }}>
                  <td style={{ padding: "6px 8px 6px 0", color: rankColor, fontWeight: rank <= 3 ? 700 : 400 }}>{rank}</td>
                  <td style={{ padding: "6px 8px" }}>
                    <div style={{ fontWeight: isSelf ? 700 : 500, color: isSelf ? "#a5b4fc" : "#f5f5f5" }}>
                      {e.name} {isSelf && <span style={{ ...muted, fontSize: 11, fontWeight: 400 }}>(you)</span>}
                    </div>
                    <div style={{ color: "#7a7d83", fontSize: 11 }}>L{e.level} {e.class}</div>
                  </td>
                  <td style={{ padding: "6px 8px", textAlign: "right", color: "#86efac", fontWeight: 600 }}>{e.wins}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right", color: wr >= 50 ? "#86efac" : "#fca5a5" }}>{wr}%</td>
                  <td style={{ padding: "6px 0 6px 8px", textAlign: "right", color: e.elite_wins > 0 ? "#f97316" : "#7a7d83", fontWeight: e.elite_wins > 0 ? 600 : 400 }}>
                    {e.elite_wins > 0 ? e.elite_wins : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RecentQuestsCard({ quests }: { quests: RecentQuest[] }) {
  return (
    <div style={card}>
      <h2 style={h2}>Recent Quests</h2>
      <div style={{ display: "grid", gap: 8, marginTop: 16 }}>
        {quests.map((q) => (
          <RecentQuestRow key={q.id} q={q} />
        ))}
      </div>
    </div>
  );
}

function RecentQuestRow({ q }: { q: RecentQuest }) {
  const won = q.status === "completed";
  const when = q.completed_at ?? q.created_at;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: 12,
        background: "#1d1f23",
        borderRadius: 8,
      }}
    >
      <Icon name={won ? "trophy" : "death-skull"} size={20} color={won ? "#fbbf24" : "#fca5a5"} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 15 }}>
            {q.monster_name}
          </span>
          <SmallBadge>{q.variant}</SmallBadge>
          {q.elite && <SmallBadge>elite</SmallBadge>}
          {q.variant === "boss" && q.boss_phase === 2 && (
            <SmallBadge>phase 2</SmallBadge>
          )}
          {q.variant === "gauntlet" && q.wave && q.total_waves && (
            <SmallBadge>
              wave {q.wave}/{q.total_waves}
            </SmallBadge>
          )}
        </div>
        <div style={{ ...muted, fontSize: 12, marginTop: 2 }}>
          {won ? "Won" : "Lost"} · {formatRelative(when)}
          {q.duration_ms != null && q.duration_ms > 0 && (
            <> · {formatDuration(q.duration_ms)}</>
          )}
          {q.party_size > 1 && (
            <> · {q.party_size} players</>
          )}
        </div>
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return "just now";
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function SignOutRow({ onLogout }: { onLogout: () => void }) {
  return (
    <button onClick={onLogout} style={{ ...button, background: "#33363d" }}>
      Sign out
    </button>
  );
}

function AccountPopover({
  onLogout,
  onReroll,
  character,
  onSaveNotifyPref,
}: {
  onLogout: () => void;
  onReroll: () => Promise<void>;
  character: { name: string; notification_pref?: "thread" | "dm" } | null;
  onSaveNotifyPref?: (pref: "thread" | "dm") => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [rerollStep, setRerollStep] = useState<"idle" | "confirm">("idle");
  const [rerolling, setRerolling] = useState(false);
  const [showNotifyModal, setShowNotifyModal] = useState(false);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: (v) => { setOpen(v); if (!v) setRerollStep("idle"); },
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    placement: "top-start",
    whileElementsMounted: autoUpdate,
  });
  const { getFloatingProps } = useInteractions([useDismiss(context)]);

  async function confirmReroll() {
    setRerolling(true);
    await onReroll();
    setRerolling(false);
    setOpen(false);
    setRerollStep("idle");
  }

  return (
    <>
      <button
        ref={refs.setReference}
        onClick={() => { setOpen((v) => !v); setRerollStep("idle"); }}
        title="Account"
        style={{
          position: "absolute", top: 8, right: 8,
          background: "none", border: "1px solid #3a3d44", borderRadius: 5,
          color: "#9ca3af", cursor: "pointer", padding: "3px 7px",
          lineHeight: 1, fontFamily: "inherit", display: "flex", alignItems: "center",
        }}
      >
        <Icon name="gears" size={14} />
      </button>
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={{ ...floatingStyles, zIndex: 300 }}
            {...getFloatingProps()}
          >
            <div style={{ padding: 12, background: "#1d1f23", borderRadius: 8, border: "1px solid #2a2d33", boxShadow: "0 8px 24px rgba(0,0,0,0.6)", minWidth: 220, display: "flex", flexDirection: "column", gap: 6 }}>
              {/* Sign Out */}
              <button
                onClick={() => { setOpen(false); onLogout(); }}
                style={{ ...smallActionBtn("#1a1c20", "#f87171"), textAlign: "left" }}
              >
                <Icon name="player" size={13} /> Sign out
              </button>

              {/* Notifications */}
              {onSaveNotifyPref && (
                <button
                  onClick={() => { setOpen(false); setShowNotifyModal(true); }}
                  style={{ ...smallActionBtn("#1a1c20", "#93c5fd"), textAlign: "left" }}
                >
                  <Icon name="bell" size={13} /> Notifications
                </button>
              )}

              {/* Reroll */}
              <div style={{ borderTop: "1px solid #2a2d33", paddingTop: 8, marginTop: 2 }}>
                {rerollStep === "idle" ? (
                  <button
                    onClick={() => setRerollStep("confirm")}
                    style={{ ...smallActionBtn("#1a1c20", "#fde68a"), width: "100%", textAlign: "left" }}
                  >
                    <Icon name="dice-six-faces-random" size={13} /> Reroll character
                  </button>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ fontSize: 12, color: "#f5f5f5", fontWeight: 600 }}>Reroll {character?.name ?? "your character"}?</div>
                    <div style={{ fontSize: 11, color: "#9ca3af", lineHeight: 1.4 }}>
                      All gear, gold, and levels will be lost. Free to do — the forfeit is the cost.
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        onClick={confirmReroll}
                        disabled={rerolling}
                        style={{ ...smallActionBtn("#2a0f0f", "#fca5a5"), flex: 1 }}
                      >
                        {rerolling ? "Rolling…" : "Confirm reroll"}
                      </button>
                      <button onClick={() => setRerollStep("idle")} style={smallActionBtn("#222428", "#6b7280")}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </FloatingPortal>
      )}
      {showNotifyModal && onSaveNotifyPref && (
        <NotifyPrefModal
          current={character?.notification_pref ?? "thread"}
          onSave={async (pref) => { await onSaveNotifyPref(pref); setShowNotifyModal(false); }}
          onClose={() => setShowNotifyModal(false)}
        />
      )}
    </>
  );
}

function NotifyPrefModal({
  current,
  onSave,
  onClose,
}: {
  current: "thread" | "dm";
  onSave: (pref: "thread" | "dm") => Promise<void>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<"thread" | "dm">(current);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    await onSave(selected);
    setSaving(false);
  }

  const opts: { value: "thread" | "dm"; label: string; desc: string }[] = [
    { value: "thread", label: "Channel broadcast", desc: "Posts your turn in the quest thread and @mentions you in the channel." },
    { value: "dm",     label: "Direct message",    desc: "Sends you a private DM when it's your turn." },
  ];

  return (
    <ModalBackdrop onCancel={onClose}>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#f5f5f5", marginBottom: 4 }}>Turn notifications</div>
      <div style={{ fontSize: 13, color: "#9ca3af", marginBottom: 20 }}>How would you like to be pinged when it's your turn in combat?</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {opts.map((opt) => {
          const active = selected === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => setSelected(opt.value)}
              style={{
                background: active ? "#1f2d3d" : "#1a1c20",
                border: `1px solid ${active ? "#3b82f6" : "#2a2d33"}`,
                borderRadius: 8,
                padding: "12px 14px",
                textAlign: "left",
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{
                  width: 14, height: 14, borderRadius: "50%",
                  border: `2px solid ${active ? "#3b82f6" : "#4a5060"}`,
                  background: active ? "#3b82f6" : "transparent",
                  flexShrink: 0,
                }} />
                <span style={{ fontWeight: 600, fontSize: 13, color: active ? "#93c5fd" : "#e6e6e6" }}>{opt.label}</span>
              </div>
              <div style={{ fontSize: 12, color: "#6b7280", paddingLeft: 22, lineHeight: 1.4 }}>{opt.desc}</div>
            </button>
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
        <button type="button" onClick={onClose} style={{ ...button, background: "#33363d" }}>Cancel</button>
        <button type="button" onClick={handleSave} disabled={saving} style={button}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </ModalBackdrop>
  );
}

// Reusable centered backdrop with a card inside. Click outside closes via
// onCancel; clicking the card itself doesn't bubble.
function ModalBackdrop({ children, onCancel }: { children: React.ReactNode; onCancel: () => void }) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#1a1c20",
          border: "1px solid #2a2d33",
          borderRadius: 12,
          padding: 24,
          maxWidth: 460,
          width: "100%",
          boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

// Shopkeeper haggle outcome dialog. Headline summarizes the roll; flavor
// is one of the canned NPC lines from core's HAGGLE_LINES table.
function HaggleResultDialog({
  result,
  onClose,
}: {
  result: HaggleResult;
  onClose: () => void;
}) {
  const failed = result.bucket === "failed";
  const steal = result.bucket === "steal";
  const headline = failed
    ? "Haggle failed."
    : steal
      ? `STEAL! −30% off.`
      : `−${result.outcome}% off.`;
  const headlineColor = failed ? "#fca5a5" : steal ? "#fbbf24" : "#86efac";
  return (
    <ModalBackdrop onCancel={onClose}>
      <div style={{ ...muted, fontSize: 12, textTransform: "uppercase", letterSpacing: 1.5, fontFamily: DISPLAY_FONT }}>
        <Icon name="gold-bar" /> Shopkeeper
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: headlineColor, marginTop: 8, fontFamily: DISPLAY_FONT }}>
        {headline}
      </div>
      <div style={{ ...muted, fontSize: 13, marginTop: 4 }}>
        {result.item_name} · 1d6{result.modifier > 0 ? `+${result.modifier}` : result.modifier < 0 ? `${result.modifier}` : ""} = {result.total}
      </div>
      <p style={{ color: "#e6e6e6", fontStyle: "italic", marginTop: 16, lineHeight: 1.5 }}>
        “{result.flavor}”
      </p>
      {!failed && (
        <div style={{ ...muted, fontSize: 13, marginTop: 12 }}>
          Price: <span style={{ textDecoration: "line-through" }}>{result.old_price}g</span>{" "}
          → <strong style={{ color: "#86efac" }}>{result.new_price}g</strong>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 20 }}>
        <button onClick={onClose} style={button}>OK</button>
      </div>
    </ModalBackdrop>
  );
}

// Generic confirm dialog — replaces native window.confirm() so styling
// matches the rest of the app and the destructive action color stays
// consistent.
function ConfirmDialog({
  request,
  onClose,
}: {
  request: ConfirmRequest;
  onClose: () => void;
}) {
  return (
    <ModalBackdrop onCancel={onClose}>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#f5f5f5" }}>{request.title}</div>
      <p style={{ ...muted, marginTop: 8, lineHeight: 1.5 }}>{request.message}</p>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
        <button onClick={onClose} style={{ ...button, background: "#33363d" }}>Cancel</button>
        <button
          onClick={() => {
            request.onConfirm();
            onClose();
          }}
          style={{
            ...button,
            background: request.destructive ? "#7c2020" : "#1f3a1f",
            color: request.destructive ? "#fecaca" : "#86efac",
          }}
        >
          {request.confirmLabel ?? "Confirm"}
        </button>
      </div>
    </ModalBackdrop>
  );
}

function Stats({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 12,
        marginTop: 16,
      }}
    >
      {children}
    </div>
  );
}

function Stat({ label, value, icon, tooltip }: { label: string; value: React.ReactNode; icon?: React.ReactNode; tooltip?: string }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{ padding: 12, background: "#1d1f23", borderRadius: 8, display: "flex", alignItems: "center", gap: 12, position: "relative", cursor: tooltip ? "default" : undefined }}
      onMouseEnter={() => tooltip && setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {icon && (
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36 }}>
          {icon}
        </div>
      )}
      <div style={{ minWidth: 0 }}>
        <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.8, lineHeight: 1, fontFamily: DISPLAY_FONT }}>
          {label}
        </div>
        <div style={{ fontSize: 18, fontWeight: 600, color: "#f5f5f5", marginTop: 3, fontFamily: DISPLAY_FONT }}>
          {value}
        </div>
      </div>
      {tooltip && hovered && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: 0,
          background: "#0e1014", border: "1px solid #2a2d33",
          borderRadius: 7, padding: "7px 10px", zIndex: 50,
          minWidth: 180, maxWidth: 260,
          boxShadow: "0 4px 16px rgba(0,0,0,0.7)",
          pointerEvents: "none", whiteSpace: "pre-line",
        }}>
          <div style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4 }}>{label}</div>
          <div style={{ fontSize: 11, color: "#c9cdd4", lineHeight: 1.55, fontFamily: "monospace" }}>{tooltip}</div>
        </div>
      )}
    </div>
  );
}

function Stack({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        width: "100%",
        maxWidth: 560,
      }}
    >
      {children}
    </div>
  );
}

// Wide scene/banner image — click to expand full-screen. Used for landscape
// art (monster scene, quest banners). For square portraits use <Avatar>.
function ClickablePortrait({
  src,
  alt,
  width = "100%",
  height = "auto",
  borderRadius = 8,
  style: extraStyle,
}: {
  src: string;
  alt: string;
  width?: number | string;
  height?: number | string;
  borderRadius?: number;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <img
        src={src}
        alt={alt}
        onClick={() => setOpen(true)}
        style={{
          width,
          height,
          borderRadius,
          objectFit: "cover",
          display: "block",
          cursor: "zoom-in",
          ...extraStyle,
        }}
        onError={(e) => { e.currentTarget.style.display = "none"; }}
      />
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.85)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            cursor: "zoom-out",
          }}
        >
          <img
            src={src}
            alt={alt}
            style={{
              maxWidth: "min(90vw, 800px)",
              maxHeight: "85vh",
              borderRadius: 12,
              objectFit: "contain",
              boxShadow: "0 16px 48px rgba(0,0,0,0.8)",
            }}
          />
        </div>
      )}
    </>
  );
}

function ApothecaryCard({
  apothecary,
  navOverlay,
  selfId,
  onBuyStaple,
  onRevive,
  onRefresh,
}: {
  apothecary: ApothecaryResponse | null;
  navOverlay?: React.ReactNode;
  selfId: string;
  onBuyStaple: (stapleId: string) => void;
  onRevive: (targetUserId: string, targetName: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const hero = navOverlay
    ? <LocationHero src={apothecary?.art_url} label="Apothecary" nav={navOverlay} />
    : <Banner src={apothecary?.art_url ?? null} alt="Apothecary" />;

  if (!apothecary) {
    return (
      <div style={card}>
        {hero}
        <h2 style={h2}>Apothecary</h2>
        <p style={muted}>The apothecary is closed. Finish your quest first.</p>
      </div>
    );
  }

  if (apothecary.error === "mid_quest") {
    return (
      <div style={card}>
        {hero}
        {!navOverlay && <h2 style={h2}>Apothecary</h2>}
        <p style={muted}>The apothecary won't deal with you mid-quest. Wrap up the fight first.</p>
      </div>
    );
  }

  const downed = apothecary.downed.filter((d) => d.slack_user_id !== selfId);
  const isSelfDowned = apothecary.downed.some((d) => d.slack_user_id === selfId);

  return (
    <div style={card}>
      {hero}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <h2 style={{ ...h2, margin: 0 }}>Apothecary</h2>
        <RefreshButton onRefresh={onRefresh} />
      </div>
      <p style={muted}>
        <em>"Venom, vigor, or revival — I deal in all three."</em>
      </p>
      <p style={{ ...muted, fontSize: 12, marginTop: 4 }}>
        You have <strong style={{ color: "#fbbf24" }}>{apothecary.gold}g</strong>
        {apothecary.revive_count > 0 && (
          <> · <strong style={{ color: "#f472b6" }}>{apothecary.revive_count} revive{apothecary.revive_count !== 1 ? "s" : ""}</strong> in pack</>
        )}
      </p>

      {/* Maimed adventurers panel */}
      {(downed.length > 0 || isSelfDowned) && (
        <div style={{ marginTop: 20 }}>
          <div style={{ ...muted, fontSize: 11, textTransform: "uppercase" as const, letterSpacing: 1.5, marginBottom: 8 }}>
            <Icon name="fall-down" /> Maimed Adventurers
          </div>
          {isSelfDowned && (
            <div style={{
              padding: "10px 12px",
              background: "#1f0a0a",
              border: "1px solid #7f1d1d44",
              borderRadius: 8,
              marginBottom: 8,
              color: "#fca5a5",
              fontSize: 13,
            }}>
              ☠ You are downed — wait for a companion with a revive item to help you.
            </div>
          )}
          {downed.map((d) => {
            const timeLeftMs = d.downed_until - Date.now();
            const hrs = Math.floor(timeLeftMs / 3600000);
            const mins = Math.floor((timeLeftMs % 3600000) / 60000);
            const timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
            const canRevive = apothecary.revive_count > 0;
            return (
              <div
                key={d.slack_user_id}
                style={{
                  padding: 12,
                  background: "#1a0a0a",
                  borderRadius: 8,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  marginBottom: 6,
                  border: "1px solid #7f1d1d33",
                }}
              >
                <Icon name="fall-down" size={20} color="#f87171" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 14 }}>{d.name}</div>
                  <div style={{ ...muted, fontSize: 12 }}>{d.class} · downed for {timeStr} more</div>
                </div>
                <button
                  onClick={() => onRevive(d.slack_user_id, d.name)}
                  disabled={!canRevive}
                  title={canRevive ? "Use a revive item to restore them to 50% HP" : "You need a revive item"}
                  style={{
                    ...smallActionBtn(canRevive ? "#2d1a3a" : "#222428", canRevive ? "#e879f9" : "#7a7d83"),
                    opacity: canRevive ? 1 : 0.5,
                    cursor: canRevive ? "pointer" : "not-allowed",
                  }}
                >
                  Revive
                </button>
              </div>
            );
          })}
          {downed.length === 0 && !isSelfDowned && null}
        </div>
      )}
      {apothecary.downed.length === 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ ...muted, fontSize: 11, textTransform: "uppercase" as const, letterSpacing: 1.5, marginBottom: 8 }}>
            <Icon name="fall-down" /> Maimed Adventurers
          </div>
          <p style={{ ...muted, fontSize: 13 }}>No adventurers are downed right now.</p>
        </div>
      )}

      {/* Apothecary staples */}
      <div style={{ marginTop: 20 }}>
        <div style={{ ...muted, fontSize: 11, textTransform: "uppercase" as const, letterSpacing: 1.5, marginBottom: 8 }}>
          <Icon name="bubbling-potion" /> Concoctions
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          {apothecary.staples.map((s) => {
            const canAfford = apothecary.gold >= s.price;
            const powerLine = s.effect === "poison_enemy"
              ? `${s.power} poison/tick × ${s.turns} turns`
              : s.effect === "regen_self"
                ? `${s.power} HP/tick × ${s.turns} turns`
                : `+25% damage × ${s.turns} turns`;
            return (
              <div
                key={s.id}
                style={{
                  padding: 12,
                  background: "#1d1f23",
                  borderRadius: 8,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <div style={{ width: 36, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Icon
                    name={s.effect === "poison_enemy" ? "vial" : s.effect === "regen_self" ? "health-increase" : "bubbling-potion"}
                    size={28}
                    color={s.effect === "poison_enemy" ? "#a3e635" : s.effect === "regen_self" ? "#4ade80" : "#c084fc"}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 15, fontFamily: DISPLAY_FONT }}>{s.name}</div>
                  <div style={{ ...muted, fontSize: 12, marginTop: 2 }}>{s.blurb}</div>
                  <div style={{ color: "#86efac", fontSize: 11, marginTop: 3 }}>{powerLine}</div>
                </div>
                <div style={{ color: "#fbbf24", fontWeight: 600, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                  {s.price}g
                </div>
                <button
                  onClick={() => onBuyStaple(s.id)}
                  disabled={!canAfford}
                  style={{
                    ...smallActionBtn(canAfford ? "#1a2d1a" : "#222428", canAfford ? "#86efac" : "#7a7d83"),
                    opacity: canAfford ? 1 : 0.6,
                    cursor: canAfford ? "pointer" : "not-allowed",
                  }}
                >
                  Buy
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const DISTRICT_CONFIG: {
  key: TownSection;
  label: string;
  icon: string;
  color: string;
  artKey: keyof TownArt;
}[] = [
  { key: "job_board", label: "Job Board", icon: "scroll-unfurled", color: "#b89b3a", artKey: "overview_art_url" },
  { key: "pub",       label: "The Pub",   icon: "beer-stein",      color: "#92400e", artKey: "pub_art_url" },
  { key: "shop",      label: "Shop",      icon: "gold-bar",        color: "#1e3a5f", artKey: "shop_art_url" },
  { key: "inn",       label: "Inn",       icon: "bed",             color: "#1a3a2a", artKey: "inn_art_url" },
  { key: "smithy",      label: "Smithy",      icon: "anvil",          color: "#2a1a1a", artKey: "smithy_art_url" },
  { key: "apothecary", label: "Apothecary",  icon: "poison-bottle",  color: "#1a2d1a", artKey: "apothecary_art_url" },
  { key: "hunt",       label: "Outskirts",   icon: "sword",          color: "#1a1a2e", artKey: "outskirts_art_url" },
];

// Persistent top navigation shown whenever a town section is active.
function TownNav({
  active,
  onNavigate,
}: {
  active: TownSection;
  onNavigate: (section: TownSection | null) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      <button
        onClick={() => onNavigate(null)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
          padding: "7px 10px", borderRadius: 8,
          border: "1.5px solid #2a2d33",
          background: "transparent",
          color: "#9ca3af",
          cursor: "pointer", fontSize: 12, fontWeight: 400,
          flex: "0 0 auto",
        }}
        title="Town overview"
      >
        <Icon name="tower" size={13} />
      </button>
      {DISTRICT_CONFIG.map((d) => {
        const isActive = d.key === active;
        return (
          <button
            key={d.key}
            onClick={() => onNavigate(d.key)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
              padding: "7px 6px", borderRadius: 8,
              border: `1.5px solid ${isActive ? "#b89b3a" : "#2a2d33"}`,
              background: isActive ? "rgba(184,155,58,0.15)" : "transparent",
              color: isActive ? "#f1e8c8" : "#9ca3af",
              cursor: "pointer", fontSize: 12,
              fontWeight: isActive ? 600 : 400,
              flex: 1, minWidth: 0,
              transition: "all 0.15s",
              whiteSpace: "nowrap", overflow: "hidden",
            }}
          >
            <Icon name={d.icon} size={12} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{d.label}</span>
          </button>
        );
      })}
    </div>
  );
}

const VARIANT_STYLE: Record<string, { icon: string; color: string; bg: string; label: string }> = {
  standard:     { icon: "sword",         color: "#86efac", bg: "#0a1f0a", label: "STANDARD" },
  boss:         { icon: "crown",         color: "#fca5a5", bg: "#1f0a0a", label: "BOSS" },
  dungeon:      { icon: "tower",         color: "#7dd3fc", bg: "#0a121f", label: "DUNGEON" },
  gauntlet:     { icon: "crossed-swords",color: "#c4b5fd", bg: "#130a1f", label: "GAUNTLET" },
  bounty_pack:  { icon: "dragon-head",   color: "#fb923c", bg: "#1f0e00", label: "BOUNTY PACK" },
};

function JobPostingCard({
  job,
  claim,
  characterLevel,
  selfId,
  onTake,
}: {
  job: JobListing;
  claim: { taken_by: string } | undefined;
  characterLevel: number;
  selfId: string;
  onTake: () => void;
}) {
  const [pending, setPending] = useState(false);
  const isTaken = !!claim;
  const isMyClaim = claim?.taken_by === selfId;
  const meetsLevel = characterLevel >= job.required_level;
  const vs = VARIANT_STYLE[job.variant] ?? VARIANT_STYLE.standard;

  return (
    <div style={{
      background: isTaken ? "#141416" : vs.bg,
      border: `1px solid ${isTaken ? "#22242a" : vs.color + "44"}`,
      borderRadius: 10,
      padding: "14px 16px",
      opacity: isTaken && !isMyClaim ? 0.6 : 1,
      position: "relative",
    }}>
      {/* Variant badge + level row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 4,
          background: vs.color + "1a", border: `1px solid ${vs.color}44`,
          borderRadius: 4, padding: "2px 8px",
        }}>
          <Icon name={vs.icon} size={11} color={vs.color} />
          <span style={{ fontSize: 10, fontWeight: 700, color: vs.color, letterSpacing: 0.6 }}>
            {vs.label}
          </span>
        </div>
        {job.required_level > 1 && (
          <span style={{ fontSize: 11, color: "#6a7080" }}>L{job.required_level}+</span>
        )}
        {job.variant === "bounty_pack" && job.monster_count && job.monster_count > 1 && (
          <span style={{
            fontSize: 10, fontWeight: 700, color: "#fb923c",
            background: "#fb923c1a", border: "1px solid #fb923c44",
            borderRadius: 4, padding: "2px 7px",
          }}>
            ×{job.monster_count} enemies
          </span>
        )}
        {isMyClaim && (
          <span style={{ fontSize: 11, color: "#86efac", marginLeft: "auto" }}>✓ Claimed by you</span>
        )}
        {isTaken && !isMyClaim && (
          <span style={{ fontSize: 11, color: "#6a7080", marginLeft: "auto" }}>✓ Taken</span>
        )}
      </div>

      <div style={{ fontWeight: 600, color: isTaken ? "#6a7080" : "#f1f5f9", marginBottom: 6, fontSize: 14, lineHeight: 1.3 }}>
        {job.title}
      </div>

      <p style={{ ...muted, fontSize: 12, margin: "0 0 10px", fontStyle: "italic", lineHeight: 1.5 }}>
        {job.blurb}
      </p>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "#9ca3af" }}>
          <Icon name="gold-bar" size={11} color="#f1c26b" style={{ marginRight: 4 }} />{job.reward_summary}
        </span>
        {!isTaken && !meetsLevel && (
          <span style={{ fontSize: 12, color: "#6a7080" }}>
            🔒 Need L{job.required_level}
          </span>
        )}
        {!isTaken && meetsLevel && (
          <button
            onClick={() => { setPending(true); onTake(); }}
            disabled={pending}
            style={{
              ...button, padding: "5px 14px", marginTop: 0, fontSize: 12,
              background: pending ? "#2a2d33" : "#2a1f0a",
              color: pending ? "#6a7080" : "#f1e8c8",
              border: `1px solid ${vs.color}55`,
            }}
          >
            {pending ? "Claiming…" : "🪙 Take Job"}
          </button>
        )}
      </div>
    </div>
  );
}

const HUNT_PACK_LABEL = ["", "Solo", "Pair", "Trio"] as const;

function StepPicker({
  value, min, max, onChange, label,
}: { value: number; min: number; max: number; onChange: (n: number) => void; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <button
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        style={{
          width: 32, height: 32, borderRadius: 6,
          border: "1px solid #2a2d33", background: "#1a1d22",
          color: value <= min ? "#3a3d44" : "#e5e7eb",
          cursor: value <= min ? "not-allowed" : "pointer",
          fontSize: 18, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >−</button>
      <div style={{ textAlign: "center", minWidth: 56 }}>
        <div style={{ fontSize: 28, fontWeight: 700, color: "#f1e8c8", lineHeight: 1, fontFamily: DISPLAY_FONT }}>
          {value}
        </div>
        <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>{label}</div>
      </div>
      <button
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        style={{
          width: 32, height: 32, borderRadius: 6,
          border: "1px solid #2a2d33", background: "#1a1d22",
          color: value >= max ? "#3a3d44" : "#e5e7eb",
          cursor: value >= max ? "not-allowed" : "pointer",
          fontSize: 18, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >+</button>
    </div>
  );
}

function HuntSection({
  characterLevel,
  overviewArt,
  navOverlay,
  onStartHunt,
}: {
  characterLevel: number;
  overviewArt: string | null;
  navOverlay: React.ReactNode;
  onStartHunt: (tier: number, monsterCount: number) => void;
}) {
  const [tier, setTier] = useState(characterLevel);
  const [monsterCount, setMonsterCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const clampedTier = Math.max(1, Math.min(tier, characterLevel));

  const packMultiplier = monsterCount === 3 ? 2.2 : monsterCount === 2 ? 1.5 : 1;
  const xpEstimate = Math.round(15 * Math.pow(clampedTier, 1.2) * packMultiplier);
  const goldEstimate = Math.round(8 * Math.pow(clampedTier, 1.2) * packMultiplier);

  const atLevel = clampedTier === characterLevel;
  const tierLabel = atLevel
    ? "Your level — full rewards"
    : clampedTier >= characterLevel - 2
    ? `Tier ${clampedTier} — slightly easier`
    : `Tier ${clampedTier} — grinding territory`;

  const packLabel = monsterCount === 1
    ? "Solo fight — normal XP"
    : monsterCount === 2
    ? "Pair — harder, +50% rewards"
    : "Trio — brutal, ×2.2 rewards";

  async function handle() {
    setBusy(true);
    try { await onStartHunt(clampedTier, monsterCount); } finally { setBusy(false); }
  }

  return (
    <div style={{ ...card, padding: 0 }}>
      <LocationHero src={overviewArt} label="Outskirts" nav={navOverlay} flush />
      <div style={{ padding: "var(--card-pad, 32px)" }}>
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#f1e8c8", marginBottom: 4 }}>
            Free Hunt
          </div>
          <div style={{ fontSize: 12, color: "#9ca3af", lineHeight: 1.5 }}>
            Pick a tier and head into the outskirts. No job board contract — rewards scale
            with the tier you choose, so lower tiers mean faster fights but smaller gains.
          </div>
        </div>

        {/* Two pickers side by side */}
        <div style={{ display: "flex", gap: 32, marginBottom: 16, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>
              Difficulty
            </div>
            <StepPicker value={clampedTier} min={1} max={characterLevel} onChange={setTier} label="TIER" />
            <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 6 }}>{tierLabel}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>
              Pack size
            </div>
            <StepPicker value={monsterCount} min={1} max={3} onChange={setMonsterCount} label={HUNT_PACK_LABEL[monsterCount]} />
            <div style={{ fontSize: 12, color: monsterCount > 1 ? "#fbbf24" : "#9ca3af", marginTop: 6 }}>{packLabel}</div>
          </div>
        </div>

        <div style={{
          display: "flex", gap: 20, marginBottom: 20,
          padding: "10px 14px", background: "#0e1014", borderRadius: 8, border: "1px solid #2a2d33",
        }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#a3e635" }}>~{xpEstimate}</div>
            <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2, fontFamily: DISPLAY_FONT }}>XP</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#fbbf24" }}>~{goldEstimate}</div>
            <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2, fontFamily: DISPLAY_FONT }}>Gold</div>
          </div>
          <div style={{ fontSize: 11, color: "#6b7280", alignSelf: "center", lineHeight: 1.4 }}>
            Estimated single-fighter rewards.<br />Actual split across party members.
          </div>
        </div>

        <button
          onClick={handle}
          disabled={busy}
          style={{
            width: "100%", padding: "12px 0", borderRadius: 8,
            border: "none", background: busy ? "#2a2d33" : "#7c3aed",
            color: busy ? "#6b7280" : "#fff",
            fontSize: 15, fontWeight: 600, cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "Scouting…" : `Hunt Tier ${clampedTier}${monsterCount > 1 ? ` · ${HUNT_PACK_LABEL[monsterCount]}` : ""}`}
        </button>
      </div>
    </div>
  );
}

function JobBoardSection({
  board,
  overviewArt,
  selfId,
  characterLevel,
  joinable,
  navOverlay,
  onTakeJob,
  onStartQuest,
  onJoin,
}: {
  board: BoardResponse | null;
  overviewArt: string | null;
  selfId: string;
  characterLevel: number;
  joinable: JoinableQuest | null;
  navOverlay: React.ReactNode;
  onTakeJob: (jobId: string) => void;
  onStartQuest: (variant: QuestVariant, elite: boolean) => void;
  onJoin: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Bulletin board card */}
      <div style={{
        ...card,
        borderColor: "#5c4010",
        background: "linear-gradient(180deg, #1e1508 0%, #130f05 100%)",
        padding: 0,
        overflow: "hidden",
      }}>
        <LocationHero flush src={overviewArt} label={`${board?.town_name ?? "Town"} — Job Board`} nav={navOverlay} />

        {/* Board subheader */}
        <div style={{
          borderBottom: "1px solid #2a1c08",
          padding: "12px 20px",
        }}>
          <p style={{ ...muted, margin: 0, fontSize: 12 }}>
            Three contracts posted today. Each can only be claimed by one adventurer — first come, first served.
          </p>
        </div>

        {/* Job listings */}
        <div style={{ padding: "16px 20px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
          {board && board.jobs.length > 0 ? (
            board.jobs.map((job) => (
              <JobPostingCard
                key={job.id}
                job={job}
                claim={board.claims[job.id]}
                characterLevel={characterLevel}
                selfId={selfId}
                onTake={() => onTakeJob(job.id)}
              />
            ))
          ) : (
            <p style={{ ...muted, fontSize: 13 }}>
              The board is bare — run <code>/sq board</code> in Slack to seed today's postings.
            </p>
          )}
        </div>

        <div style={{
          borderTop: "1px solid #2a1c08",
          padding: "10px 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}>
          <span style={{ ...muted, fontSize: 11 }}>
            <Icon name="hourglass" size={11} style={{ marginRight: 4 }} />Postings refresh daily.
          </span>
        </div>
      </div>

      {/* Divider */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ flex: 1, height: 1, background: "#22242a" }} />
        <span style={{ ...muted, fontSize: 12 }}>or start any quest</span>
        <div style={{ flex: 1, height: 1, background: "#22242a" }} />
      </div>

      {joinable ? (
        <JoinableQuestCard joinable={joinable} onJoin={onJoin} />
      ) : (
        <StartQuestCard characterLevel={characterLevel} onStart={onStartQuest} />
      )}
    </div>
  );
}

function DistrictTile({
  label,
  icon,
  color,
  artUrl,
  onClick,
}: {
  label: string;
  icon: string;
  color: string;
  artUrl: string | null;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, cursor: "pointer" }}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        style={{
          width: "100%",
          aspectRatio: "1 / 1",
          borderRadius: 12,
          overflow: "hidden",
          border: `2px solid ${hovered ? "#7dd3fc" : "#2a2d33"}`,
          background: color,
          position: "relative",
          transition: "border-color 0.15s, transform 0.15s, box-shadow 0.15s",
          transform: hovered ? "scale(1.06)" : "scale(1)",
          boxShadow: hovered ? "0 4px 20px rgba(125,209,252,0.25)" : "none",
          flexShrink: 0,
        }}
      >
        {artUrl ? (
          <img
            src={artUrl}
            alt={label}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            onError={(e) => { e.currentTarget.style.display = "none"; }}
          />
        ) : (
          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name={icon} size={36} color="#9ca3af" />
          </div>
        )}
        {artUrl && (
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,0.35)",
          }}>
            <Icon name={icon} size={28} color="rgba(255,255,255,0.85)" />
          </div>
        )}
      </div>
      <span style={{ fontSize: 12, color: "#cbd5e1", fontWeight: 500, textAlign: "center" }}>{label}</span>
    </div>
  );
}

function TownMap({
  art,
  onNavigate,
}: {
  art: TownArt | null;
  onNavigate: (section: TownSection) => void;
}) {
  return (
    <div style={{ ...card, padding: 0, overflow: "hidden" }}>
      {/* Town overview image */}
      <div style={{ position: "relative", width: "100%", aspectRatio: "16/7", background: "#111" }}>
        {art?.overview_art_url ? (
          <img
            src={art.overview_art_url}
            alt="Town of Heylets"
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        ) : (
          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ color: "#4b5563", fontSize: 13 }}>Generating town map…</span>
          </div>
        )}
        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0,
          background: "linear-gradient(transparent, rgba(14,15,18,0.95))",
          padding: "32px 20px 14px",
        }}>
          <h2 style={{ ...h2, margin: 0, color: "#f1e8c8", letterSpacing: 1 }}>Town of Heylets</h2>
          <p style={{ ...muted, margin: "2px 0 0", fontSize: 12 }}>Choose your destination</p>
        </div>
      </div>

      {/* District tiles */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))",
        gap: 12,
        padding: "16px 20px 20px",
      }}>
        {DISTRICT_CONFIG.map((d) => (
          <DistrictTile
            key={d.key}
            label={d.label}
            icon={d.icon}
            color={d.color}
            artUrl={art ? art[d.artKey] : null}
            onClick={() => onNavigate(d.key)}
          />
        ))}
      </div>
    </div>
  );
}

// Two-column dashboard layout. On wide viewports (≥ 900px) renders main
// content on the left and `side` on the right at 360px. On narrow screens
// it falls back to a single stacked column (main above side).
function DashboardLayout({
  main,
  side,
  footer,
  hideSide = false,
}: {
  main: React.ReactNode;
  side: React.ReactNode;
  footer?: React.ReactNode;
  hideSide?: boolean;
}) {
  const wide = useWideViewport();
  const mobile = useMobileViewport();
  if (!wide) {
    // Mobile: stack everything, full viewport width (no 560px cap so tablets
    // breathe). Login keeps its narrower Stack — only the dashboard goes wide.
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: mobile ? 8 : 16, width: "100%" }}>
        {main}
        {!hideSide && side}
        {footer}
      </div>
    );
  }
  if (hideSide) {
    return (
      <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>{main}</div>
        {footer}
      </div>
    );
  }
  return (
    <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 16 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 420px",
          gap: 24,
          alignItems: "start",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>{main}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>{side}</div>
      </div>
      {footer}
    </div>
  );
}

function useWideViewport(): boolean {
  const [wide, setWide] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(min-width: 900px)").matches;
  });
  useEffect(() => {
    const m = window.matchMedia("(min-width: 900px)");
    const handler = (e: MediaQueryListEvent) => setWide(e.matches);
    m.addEventListener("change", handler);
    return () => m.removeEventListener("change", handler);
  }, []);
  return wide;
}

function useMobileViewport(): boolean {
  const [mobile, setMobile] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 639px)").matches;
  });
  useEffect(() => {
    const m = window.matchMedia("(max-width: 639px)");
    const handler = (e: MediaQueryListEvent) => setMobile(e.matches);
    m.addEventListener("change", handler);
    return () => m.removeEventListener("change", handler);
  }, []);
  return mobile;
}

function Centered({ children }: { children: React.ReactNode }) {
  const mobile = useMobileViewport();
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        background: "#0e0f12",
        fontFamily:
          "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color: "#e6e6e6",
        padding: mobile ? 8 : 32,
        // CSS custom property consumed by `card` const and LocationHero
        ["--card-pad" as string]: mobile ? "16px" : "32px",
      } as React.CSSProperties}
    >
      {children}
    </div>
  );
}

const ITEM_TYPE_ORDER: ItemType[] = [
  "weapon",
  "armor",
  "magic",
  "consumable",
  "revive",
  "tool",
  "scroll",
];

const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  weapon: "Weapons",
  armor: "Armor",
  magic: "Magic",
  consumable: "Consumables",
  revive: "Revives",
  tool: "Tools",
  scroll: "Scrolls",
};

const SLOT_LABELS: Record<EquipSlot, string> = {
  main_hand: "Main Hand",
  off_hand: "Off Hand",
  body: "Body",
  helmet: "Helmet",
  pants: "Legs",
  boots: "Boots",
  ring: "Ring",
  amulet: "Amulet",
};

const SLOT_ICON: Record<EquipSlot, string> = {
  main_hand: "hand",
  off_hand: "hand",
  body: "chest-armor",
  helmet: "heavy-helm",
  pants: "armored-pants",
  boots: "boots",
  ring: "ring",
  amulet: "gem-chain",
};

function slotLabel(item: Item): string {
  if (item.slot) return SLOT_LABELS[item.slot];
  return item.item_type.charAt(0).toUpperCase() + item.item_type.slice(1);
}

function statBonusSummary(bonus: Record<string, number> | null): string {
  if (!bonus) return "";
  return Object.entries(bonus)
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `+${v} ${k === "int_stat" ? "INT" : k.toUpperCase()}`)
    .join(", ");
}

// Picks the best icon for an item. Slot takes priority for non-weapon slots
// so the equipped icon always matches its doll ghost placeholder. Weapons use
// keyword matching for variety. The armor fallback handles legacy slotless items.
function itemIcon(item: {
  item_type: ItemType;
  weapon_range?: WeaponRange | null;
  item_name: string;
  slot?: EquipSlot | null;
  item_subtype?: string | null;
}): string {
  const n = item.item_name.toLowerCase();

  // Slot-based fast path — matches the doll ghost icon for every non-weapon slot.
  // main_hand falls through so weapons keep their keyword-matched variety.
  if (item.slot && item.slot !== "main_hand") {
    switch (item.slot) {
      case "off_hand":  return item.item_subtype === "gloves" ? "gloves" : "round-shield";
      case "body":      return "chest-armor";
      case "helmet":    return "heavy-helm";
      case "pants":     return "armored-pants";
      case "boots":     return "boots";
      case "ring":      return "ring";
      case "amulet":    return "gem-chain";
    }
  }

  switch (item.item_type) {
    case "weapon": {
      if (item.weapon_range === "focus") return "crystal-wand";
      if (/\bdaggers\b/.test(n))                                          return "daggers";
      if (/\b(axe|hatchet|cleaver|tomahawk)\b/.test(n))                  return "battle-axe";
      if (/\b(dagger|knife|dirk|shiv|stiletto|shank)\b/.test(n))         return "plain-dagger";
      if (/\b(hammer|maul|mace|club)\b/.test(n))                         return "hammer";
      if (/\b(staff|stave|wand|rod|scepter|sceptre)\b/.test(n))          return "crystal-wand";
      if (/\b(spear|lance|pike|javelin|halberd|polearm)\b/.test(n))      return "barbed-spear";
      if (/\bcrossbow\b/.test(n))                                         return "crossbow";
      if (/\b(bow|longbow|shortbow|recurve)\b/.test(n))                  return "crossbow";
      if (/\bblunderbuss\b/.test(n))                                      return "blunderbuss";
      if (/\b(gun|pistol|revolver|musket|rifle)\b/.test(n))              return "revolver";
      if (/\b(scythe|sickle)\b/.test(n))                                 return "scythe";
      if (/\btrident\b/.test(n))                                         return "trident";
      if (/\b(saber|sabre|rapier|foil|estoc)\b/.test(n))                return "spinning-sword";
      if (/\b(broadsword|greatsword|longsword|claymore)\b/.test(n))     return "broadsword";
      if (item.weapon_range === "ranged")                                 return "crossbow";
      return "sword";
    }

    case "armor": {
      // Slot handles most armor items. This branch is a fallback for legacy
      // slotless items or items whose slot hasn't been backfilled yet.
      if (/\b(helm|helmet|cap|hat|crown|circlet|coif)\b/.test(n))       return "heavy-helm";
      if (/\b(hood|cowl)\b/.test(n))                                     return "hood";
      if (/\b(boot|shoe|greave|sabatons?|sandal)\b/.test(n))            return "boots";
      if (/\b(glove|gauntlet|bracer|vambrace)\b/.test(n))               return "hand";
      if (/\b(cloak|mantle|cape|robe|shroud|vestment|cassock)\b/.test(n)) return "hood";
      if (/\b(amulet|pendant|necklace|talisman|charm|locket)\b/.test(n)) return "gem-chain";
      if (/\b(ring|band)\b/.test(n))                                    return "ring";
      if (/\b(pant|leg|greave|legging|trouser)\b/.test(n))             return "armored-pants";
      if (/\b(shield|buckler|targe)\b/.test(n))                         return "round-shield";
      return "chest-armor";
    }

    case "consumable": {
      if (/\b(mushroom|fungi|fungus|shroom)\b/.test(n))                  return "super-mushroom";
      if (/\b(meat|chicken|drumstick|steak|food|ration|bread)\b/.test(n)) return "roast-chicken";
      if (/\b(herb|leaf|clover|root|petal|flower)\b/.test(n))           return "leaf";
      if (/\b(bandage|salve|poultice|balm|ointment)\b/.test(n))         return "medical-pack";
      if (/\b(elixir|essence|tincture|draught|brew)\b/.test(n))         return "heart-bottle";
      if (/\b(poison|venom|toxin)\b/.test(n))                           return "poison-bottle";
      if (/\b(mana|arcane|flask)\b/.test(n))                             return "potion-ball";
      if (/\b(health|healing|hp|cure|restore|remedy|revitaliz)\b/.test(n)) return "health-potion";
      return "bubbling-potion";
    }

    case "magic": {
      if (/\b(tome|book|grimoire|codex|manual)\b/.test(n))              return "book";
      if (/\b(rune|glyph|sigil)\b/.test(n))                             return "rune-stone";
      if (/\b(crystal|gem|jewel|prism)\b/.test(n))                      return "crystals";
      if (/\b(ring|band)\b/.test(n))                                    return "ring";
      if (/\b(amulet|pendant|necklace|talisman|charm|locket)\b/.test(n)) return "gem-chain";
      return "crystal-ball";
    }

    case "revive":
      return "crowned-heart";

    case "tool": {
      if (/caffeine bomb|hotfix grenade/.test(n))                        return "bomb-explosion";
      if (/espresso shot/.test(n))                                       return "coffee-mug";
      if (/poison vial/.test(n))                                         return "poison-bottle";
      if (/\b(bomb|explosive|grenade|nuke)\b/.test(n))                  return "bomb-explosion";
      if (/\b(torch|lantern|light)\b/.test(n))                          return "torch";
      if (/\b(rope|grapple|hook)\b/.test(n))                            return "grappling-hook";
      if (/\b(trap|snare|net)\b/.test(n))                               return "bear-trap";
      if (/\b(lockpick|picks?)\b/.test(n))                              return "key-basic";
      if (/\b(shovel|spade)\b/.test(n))                                 return "shovel";
      if (/\b(vial|flask|bottle)\b/.test(n))                            return "poison-bottle";
      return "anvil";
    }

    case "scroll": {
      if (/rebase/.test(n))                                              return "cycle";
      if (/production outage/.test(n))                                   return "lightning-saber";
      if (/\b(fire|flame|burn|inferno)\b/.test(n))                      return "fire";
      if (/\b(lightning|thunder|storm|shock)\b/.test(n))                return "lightning-saber";
      if (/\b(frost|ice|cold|freeze|glacial)\b/.test(n))                return "snowflake";
      if (/\b(heal|mend|restore|cure|life)\b/.test(n))                  return "health-increase";
      if (/\b(poison|venom|toxin|blight)\b/.test(n))                    return "poison-cloud";
      if (/\b(shadow|dark|void|death|necrotic)\b/.test(n))              return "death-skull";
      if (/\b(shield|protect|ward|barrier)\b/.test(n))                  return "bolt-shield";
      if (/\b(arcane|magic|spell|enchant)\b/.test(n))                   return "fairy-wand";
      return "scroll-unfurled";
    }

    default:
      return "scroll-unfurled";
  }
}

// Returns an explicit icon color override for items where color carries meaning
// (health = red, mana = indigo), or null to fall through to the rarity color.
function itemIconColor(item: {
  item_type: ItemType;
  item_name: string;
}): string | null {
  const n = item.item_name.toLowerCase();
  if (item.item_type === "consumable" || item.item_type === "tool") {
    if (/\b(health|heal|hp|restore|mend|cure|potion|elixir|life)\b/.test(n)) return "#ef4444";
    if (/\b(mana|mp|arcane|magic|mystic|flask|vial)\b/.test(n))              return "#818cf8";
    if (/\bgreater\b/.test(n) && /\bhealth\b/.test(n))                       return "#ef4444";
  }
  return null;
}

const RARITY_COLOR: Record<Rarity, string> = {
  common: "#8a8f98",
  uncommon: "#16a34a",
  rare: "#3b82f6",
  epic: "#a855f7",
  legendary: "#f59e0b",
};

const EFFECT_COLOR: Record<EffectType, string> = {
  regen: "#16a34a",
  bleeding: "#dc2626",
  burning: "#f97316",
  poisoned: "#a855f7",
  empowered: "#fbbf24",
  frozen: "#93c5fd",
  shocked: "#fef08a",
};

// ra-* icon names per status effect. Rendered via <Icon> with EFFECT_COLOR.
const EFFECT_ICON: Record<EffectType, string> = {
  regen: "aura",
  bleeding: "bleeding-wound",
  burning: "fire",
  poisoned: "poison-cloud",
  empowered: "electric",
  frozen: "ice-bolt",
  shocked: "electric",
};

function groupByType(items: Item[]): Partial<Record<ItemType, Item[]>> {
  const out: Partial<Record<ItemType, Item[]>> = {};
  for (const it of items) {
    (out[it.item_type] ??= []).push(it);
  }
  for (const t of Object.keys(out) as ItemType[]) {
    out[t]!.sort((a, b) => RARITY_RANK[b.rarity] - RARITY_RANK[a.rarity]);
  }
  return out;
}

const RARITY_RANK: Record<Rarity, number> = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };

const card: React.CSSProperties = {
  background: "#15171b",
  padding: "var(--card-pad, 32px)",
  borderRadius: 12,
  width: "100%",
  border: "1px solid #2a2d33",
  boxSizing: "border-box",
};
const DISPLAY_FONT = "'Metamorphous', serif";
const h1: React.CSSProperties = { margin: 0, fontSize: 28, color: "#f5f5f5", fontFamily: DISPLAY_FONT };
const h2: React.CSSProperties = { margin: 0, fontSize: 20, color: "#f5f5f5", fontFamily: DISPLAY_FONT };
const muted: React.CSSProperties = { color: "#9aa0a6", fontSize: 14 };
const input: React.CSSProperties = {
  width: "100%",
  fontSize: 24,
  padding: "12px 14px",
  borderRadius: 8,
  border: "1px solid #2a2d33",
  background: "#0e0f12",
  color: "#f5f5f5",
  marginTop: 16,
  letterSpacing: 4,
  textAlign: "center",
  boxSizing: "border-box",
};
const button: React.CSSProperties = {
  marginTop: 12,
  width: "100%",
  padding: "12px 14px",
  fontSize: 16,
  fontWeight: 600,
  borderRadius: 8,
  border: "none",
  background: "#3a7bd5",
  color: "#fff",
  cursor: "pointer",
};
const kbd: React.CSSProperties = {
  background: "#222428",
  padding: "2px 6px",
  borderRadius: 4,
  fontSize: 13,
};
const refreshBtn: React.CSSProperties = {
  background: "none",
  border: "1px solid #2a2d33",
  borderRadius: 5,
  color: "#9ca3af",
  cursor: "pointer",
  fontSize: 11,
  padding: "3px 8px",
  fontFamily: "inherit",
};

function RefreshButton({ onRefresh, style }: { onRefresh: () => Promise<void>; style?: React.CSSProperties }) {
  const [spinning, setSpinning] = useState(false);
  async function handleClick() {
    setSpinning(true);
    try { await onRefresh(); } finally { setSpinning(false); }
  }
  return (
    <button onClick={handleClick} disabled={spinning} style={{ ...refreshBtn, ...style, opacity: spinning ? 0.6 : 1 }}>
      {spinning ? "…" : "↺ Refresh"}
    </button>
  );
}

function RestockButton({ onRestock }: { onRestock: () => Promise<void> }) {
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");
  async function handleClick() {
    setState("loading");
    try { await onRestock(); setState("done"); } catch { setState("idle"); }
  }
  return (
    <button
      onClick={handleClick}
      disabled={state !== "idle"}
      style={{
        background: "#1a2a1a",
        border: "1px solid #4ade8055",
        borderRadius: 6,
        color: "#4ade80",
        cursor: state === "idle" ? "pointer" : "default",
        fontSize: 12,
        padding: "6px 14px",
        fontFamily: "inherit",
        fontWeight: 600,
        opacity: state === "loading" ? 0.6 : 1,
        marginBottom: 12,
      }}
    >
      {state === "loading" ? "Restocking…" : state === "done" ? "✓ Done" : "🛒 Restock Shop"}
    </button>
  );
}
const smallBadge: React.CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 1,
  padding: "2px 6px",
  borderRadius: 4,
  border: "1px solid",
  fontWeight: 600,
};
