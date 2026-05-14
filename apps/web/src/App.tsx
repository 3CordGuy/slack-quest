import { useEffect, useRef, useState } from "react";
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

import { findCatalogEntry, priceFor } from "@gantt-quest/core";

import { CombatPage } from "./CombatPage";
import { Avatar, EmojiIcon, Icon, KeyIcon } from "./icons";

// One-liner describing the in-game effect of an item, in plain mechanics
// (not flavor). Used by the inventory's Info toggle so players can see
// what "+5" actually means instead of guessing.
function describeItemEffect(item: {
  item_type: string;
  power: number;
  weapon_range?: "melee" | "ranged" | "focus" | null;
  item_name: string;
}): React.ReactNode {
  const p = item.power;
  const lead = (name: string) => <Icon name={name} style={{ marginRight: 6 }} />;
  switch (item.item_type) {
    case "weapon":
      if (item.weapon_range === "focus") {
        return <>{lead("crystal-ball")}Focus weapon: adds +{p} to heal & shield rolls (no attack/cast damage). +1 max mana while equipped.</>;
      }
      if (item.weapon_range === "ranged") {
        return <>{lead("crossbow")}Ranged weapon: +{p} attack/cast damage. Can attack from back row.</>;
      }
      return <>{lead("sword")}Melee weapon: +{p} attack/cast damage. Front row only for attack.</>;
    case "armor":
      return <>{lead("shield")}Armor: reduces incoming damage by floor({p}/2) = {Math.floor(p / 2)} (min 1).</>;
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
  cant_give_to_self: "Can't give an item to yourself.",
  unequip_first: "Unequip the item first before giving or selling.",
  recipient_no_character: "That player hasn't rolled a character yet.",
  mid_quest: "Not available mid-quest.",
  insufficient_gold: "Not enough gold.",
  unknown_drink: "Unknown drink.",
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
}

type ItemType =
  | "weapon"
  | "armor"
  | "consumable"
  | "magic"
  | "revive"
  | "tool"
  | "scroll";
type Rarity = "common" | "uncommon" | "rare";
type WeaponRange = "melee" | "ranged" | "focus";

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
}

type QuestVariant = "standard" | "boss" | "gauntlet" | "dungeon";
type EffectType = "regen" | "bleeding" | "burning" | "poisoned";

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
}

interface MeResponse {
  slack_user_id: string;
  slack_team_id: string;
  character: Character | null;
  class_art_url?: string | null;
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
}

interface DrinkBuff {
  kind: "buff_attack" | "buff_magic" | "buff_next_crit";
  magnitude: number;
  remaining: number;
  drink_id: string;
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

interface PubResponse {
  drinks: DrinkItem[];
  drink_buff: DrinkBuff | null;
  gold: number;
  spd?: SpdData;
  art_url?: string | null;
  error?: string;
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
interface KnownCharacter {
  slack_user_id: string;
  name: string;
  class: string;
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

type TownSection = "job_board" | "pub" | "shop" | "inn" | "smithy" | "hunt";

interface TownArt {
  overview_art_url: string | null;
  pub_art_url: string | null;
  shop_art_url: string | null;
  inn_art_url: string | null;
  smithy_art_url: string | null;
}

interface JobListing {
  id: string;
  variant: "standard" | "boss" | "dungeon" | "gauntlet";
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
      recent: RecentQuest[];
      shop: ShopResponse | null;
      joinable: JoinableQuest | null;
      inn: InnResponse | null;
      smithy: SmithyResponse | null;
      pub: PubResponse | null;
      townArt: TownArt | null;
      board: BoardResponse | null;
    };

export function App() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [activeCombat, setActiveCombat] = useState<{ questId: number } | null>(null);
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

  useEffect(() => {
    void refresh();
  }, []);

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
    let recent: RecentQuest[] = [];
    let shop: ShopResponse | null = null;
    let joinable: JoinableQuest | null = null;
    let inn: InnResponse | null = null;
    let smithy: SmithyResponse | null = null;
    let pub: PubResponse | null = null;
    let townArt: TownArt | null = null;
    let board: BoardResponse | null = null;
    if (me.character) {
      const [invRes, qRes, recentRes, shopRes, joinableRes, innRes, smithyRes, pubRes, townRes, boardRes] = await Promise.all([
        fetch("/api/inventory", { credentials: "include" }),
        fetch("/api/quest/active", { credentials: "include" }),
        fetch("/api/quests/recent", { credentials: "include" }),
        fetch("/api/shop", { credentials: "include" }),
        fetch("/api/quest/joinable", { credentials: "include" }),
        fetch("/api/inn", { credentials: "include" }),
        fetch("/api/smithy", { credentials: "include" }),
        fetch("/api/pub", { credentials: "include" }),
        fetch("/api/town", { credentials: "include" }),
        fetch("/api/board", { credentials: "include" }),
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
      if (recentRes.ok) {
        recent = ((await recentRes.json()) as RecentQuestsResponse).quests;
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
    }
    setState({ kind: "auth", me, inventory, inventoryArtUrl, activeQuest, recent, shop, joinable, inn, smithy, pub, townArt, board });
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    setState({ kind: "anon" });
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

  async function equipItem(itemId: number) {
    const { ok } = await postJson(`/api/inventory/${itemId}/equip`, { method: "POST" });
    if (ok) void refresh();
  }

  function sellItem(itemId: number) {
    const item = state.kind === "auth" ? state.inventory.find((i) => i.id === itemId) : null;
    if (!item) return;
    setConfirm({
      title: `Sell ${item.item_name}?`,
      message: `You'll get gold (price depends on rarity). This can't be undone.`,
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
    const { ok } = await postJson(`/api/inventory/${itemId}/use`, { method: "POST" });
    if (ok) void refresh();
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

  async function startQuest(variant: "standard" | "boss" | "gauntlet" | "dungeon", elite: boolean) {
    const { ok } = await postJson(`/api/quest/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variant, elite }),
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

  async function startHunt(tier: number) {
    const { ok } = await postJson("/api/hunt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier }),
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
  if (activeCombat) {
    return (
      <CombatPage
        questId={activeCombat.questId}
        selfId={state.me.slack_user_id}
        onExit={() => {
          // Just navigate away — combat state stays in D1, DO keeps caching.
          // The dashboard will show a Resume button so the user can come back.
          setActiveCombat(null);
          setCombatDismissed(true);
          void refresh();
        }}
      />
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
          {state.me.character && state.recent.length > 0 && (
            <RecentQuestsCard quests={state.recent} />
          )}
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
          <PubCard
            pub={state.pub}
            selfId={state.me.slack_user_id}
            navOverlay={townNav}
            onBuyDrink={buyDrink}
            onRefresh={refresh}
          />
        );
      } else if (townSection === "shop" && state.me.character && state.shop) {
        sectionContent = (
          <ShopCard
            shop={state.shop}
            navOverlay={townNav}
            onBuy={shopBuy}
            onHaggle={shopHaggle}
            onBuyStaple={shopBuyStaple}
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
            overviewArt={state.townArt?.overview_art_url ?? null}
            navOverlay={townNav}
            onStartHunt={startHunt}
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
            />
            {state.me.character && (
              <InventoryCard
                items={state.inventory}
                inQuest={!!state.activeQuest}
                artUrl={state.inventoryArtUrl}
                selfId={state.me.slack_user_id}
                onEquip={equipItem}
                onSell={sellItem}
                onUse={useItem}
                onGive={giveItem}
              />
            )}
          </>
        }
        footer={<SignOutRow onLogout={logout} />}
      />
      {haggleResult && (
        <HaggleResultDialog result={haggleResult} onClose={() => setHaggleResult(null)} />
      )}
      {confirm && (
        <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      )}
    </Centered>
  );
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

function StartQuestCard({
  characterLevel,
  onStart,
}: {
  characterLevel: number;
  onStart: (variant: "standard" | "boss" | "gauntlet" | "dungeon", elite: boolean) => void;
}) {
  const [elite, setElite] = useState(false);
  const [pending, setPending] = useState<"standard" | "boss" | "gauntlet" | "dungeon" | null>(null);
  const bossAllowed = characterLevel >= 3;
  const gauntletAllowed = characterLevel >= 5;
  const dungeonAllowed = characterLevel >= 1;

  function go(variant: "standard" | "boss" | "gauntlet" | "dungeon") {
    setPending(variant);
    onStart(variant, elite);
  }

  return (
    <div style={{ ...card, borderColor: "#b89b3a" }}>
      <h2 style={h2}>Start a new quest</h2>
      <p style={muted}>
        The dungeon master rolls a fresh foe via Workers AI.
      </p>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: 12,
          fontSize: 13,
          color: "#e6e6e6",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={elite}
          onChange={(e) => setElite(e.target.checked)}
          style={{ accentColor: "#dc2626" }}
        />
        <span>
          <strong>Elite mode</strong>
          <span style={{ ...muted, marginLeft: 6 }}>
            (perma-death; tier bumped by 1)
          </span>
        </span>
      </label>
      <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        <button
          onClick={() => go("standard")}
          disabled={pending !== null}
          style={{
            ...button,
            marginTop: 0,
            flex: "1 1 160px",
            background: pending === "standard" ? "#33363d" : "#1f3a1f",
            color: "#86efac",
          }}
        >
          {pending === "standard" ? "Rolling…" : <><Icon name="sword" /> Standard</>}
        </button>
        <button
          onClick={() => go("boss")}
          disabled={pending !== null || !bossAllowed}
          style={{
            ...button,
            marginTop: 0,
            flex: "1 1 160px",
            background:
              pending === "boss" ? "#33363d" : bossAllowed ? "#5c1f1f" : "#2a2d33",
            color: bossAllowed ? "#fca5a5" : "#6a7080",
          }}
          title={bossAllowed ? "Climactic single foe" : "Requires character level 3"}
        >
          {pending === "boss" ? "Rolling…" : <><Icon name="crown" /> {bossAllowed ? "Boss" : "Boss (need L3)"}</>}
        </button>
        <button
          onClick={() => go("gauntlet")}
          disabled={pending !== null || !gauntletAllowed}
          style={{
            ...button,
            marginTop: 0,
            flex: "1 1 160px",
            background:
              pending === "gauntlet" ? "#33363d" : gauntletAllowed ? "#3a2d5c" : "#2a2d33",
            color: gauntletAllowed ? "#c4b5fd" : "#6a7080",
          }}
          title={gauntletAllowed ? "3 waves back-to-back" : "Requires character level 5"}
        >
          {pending === "gauntlet"
            ? "Rolling…"
            : <><Icon name="crossed-swords" /> {gauntletAllowed ? "Gauntlet" : "Gauntlet (need L5)"}</>}
        </button>
        <button
          onClick={() => go("dungeon")}
          disabled={pending !== null || !dungeonAllowed}
          style={{
            ...button,
            marginTop: 0,
            flex: "1 1 160px",
            background:
              pending === "dungeon" ? "#33363d" : dungeonAllowed ? "#1a2d3a" : "#2a2d33",
            color: dungeonAllowed ? "#7dd3fc" : "#6a7080",
          }}
          title="5-7 room dungeon crawl: combat, traps, lockboxes, NPC encounters → sub-boss → treasure (2.5× rewards)"
        >
          {pending === "dungeon"
            ? "Generating dungeon…"
            : <><Icon name="tower" /> Dungeon</>}
        </button>
      </div>
      {pending === "dungeon" && (
        <p style={{ ...muted, fontSize: 11, marginTop: 8 }}>
          Generating 5-7 rooms with AI — this takes ~15s.
        </p>
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
          const middleTotal = (exp.middle_count ?? 0) + 3;
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
          <div style={{ fontSize: 18, fontWeight: 600, color: "#f5f5f5" }}>
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
                · {opt.rarity} {opt.item_type} +{opt.power}
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
                · {opt.rarity} {opt.item_type} +{opt.power}
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
                      · {opt.rarity} {opt.item_type} +{opt.power}
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
        Offers: <strong>{npc.item.name}</strong> ({npc.item.rarity} {npc.item.item_type} +
        {npc.item.power})
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
          <span style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 15 }}>
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

function CharacterInspectDialog({
  character,
  onClose,
}: {
  character: Character;
  onClose: () => void;
}) {
  const isDowned = character.downed_until !== null && character.downed_until > Date.now();
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
              {character.class} • Lv {character.level} • {character.xp} XP
              {character.slack_username ? ` • @${character.slack_username}` : ""}
            </p>
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
            icon={<Icon name="health-increase" color="#86efac" size={14} />}
            value={
              <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6 }}>
                {character.hp} / {character.max_hp}
                {character.shield > 0 && (
                  <span
                    title="Temporary shield buffer (absorbs damage before HP)."
                    style={{ fontSize: 12, color: "#7dd3fc", fontWeight: 500 }}
                  >
                    +{character.shield} <Icon name="shield" size={12} />
                  </span>
                )}
              </span>
            }
          />
          <Stat
            label="Mana"
            icon={<Icon name="crystal-ball" color="#a78bfa" size={14} />}
            value={`${character.mana} / ${character.max_mana}`}
          />
          <Stat
            label="Position"
            icon={<Icon name="flag" color="#fbbf24" size={14} />}
            value={character.position}
          />
          <Stat
            label="Scars"
            icon={<Icon name="death-skull" color="#ef4444" size={14} />}
            value={
              <span title={character.scars.length > 0 ? character.scars.join(", ") : undefined}>
                {character.scars.length}
              </span>
            }
          />
          <Stat
            label="Keys"
            icon={<Icon name="key" color="#d1d5db" size={14} />}
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
            icon={<Icon name="gold-bar" color="#fbbf24" size={14} />}
            value={character.gold.toString()}
          />
          <Stat
            label="Status"
            icon={<Icon name="shield" color="#7dd3fc" size={14} />}
            value={isDowned ? "Downed" : "Ready"}
          />
        </Stats>
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

function CharacterCard({
  me,
  inventory,
  inQuest,
  onRest,
  onSellKey,
  onTransmuteKey,
}: {
  me: MeResponse;
  inventory: Item[];
  inQuest: boolean;
  onRest: (kind: "short" | "long") => void;
  onSellKey: (tier: "bronze" | "silver" | "gold") => void;
  onTransmuteKey: (fromTier: "bronze" | "silver") => void;
}) {
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
  const fullyRecovered = c.hp >= c.max_hp && c.mana >= c.max_mana;
  const downed = c.downed_until !== null && c.downed_until > Date.now();
  const equippedArmor = inventory.find((i) => i.item_type === "armor" && i.equipped);
  const armorPower = equippedArmor?.power ?? 0;
  const restDisabled = inQuest || downed || fullyRecovered;
  const portrait = me.class_art_url;
  return (
    <div style={card}>
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
            {c.class} • Lv {c.level} • {c.xp} XP
          </p>
        </div>
      </div>
      <Stats>
        <Stat
          label="HP"
          icon={<Icon name="health-increase" color="#86efac" size={14} />}
          value={
            <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6 }}>
              {c.hp} / {c.max_hp}
              {c.shield > 0 && (
                <span
                  title="Temporary shield buffer (absorbs damage before HP). Set by /sq shield casts; clears at quest end."
                  style={{ fontSize: 12, color: "#7dd3fc", fontWeight: 500 }}
                >
                  +{c.shield} <Icon name="shield" size={12} />
                </span>
              )}
            </span>
          }
        />
        <Stat
          label="Mana"
          icon={<Icon name="crystal-ball" color="#a78bfa" size={14} />}
          value={`${c.mana} / ${c.max_mana}`}
        />
        <Stat
          label="Armor"
          icon={<Icon name="shield" color="#9ca3af" size={14} />}
          value={
            <span
              title={armorPower > 0
                ? `Equipped armor: reduces incoming damage by floor(${armorPower}/2) = ${Math.floor(armorPower / 2)}.`
                : "No armor equipped."}
            >
              {armorPower > 0 ? `+${armorPower}` : <span style={muted}>—</span>}
            </span>
          }
        />
        <Stat
          label="Gold"
          icon={<Icon name="gold-bar" color="#fbbf24" size={14} />}
          value={c.gold.toString()}
        />
        <Stat
          label="Scars"
          icon={<Icon name="death-skull" color="#ef4444" size={14} />}
          value={
            <span title={c.scars.length > 0 ? c.scars.join(", ") : undefined}>
              {c.scars.length.toString()}
            </span>
          }
        />
        <Stat
          label="Keys"
          icon={<Icon name="key" color="#d1d5db" size={14} />}
          value={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <KeyIcon tier="bronze" size={16} /> {c.keys_bronze}
              <KeyIcon tier="silver" size={16} /> {c.keys_silver}
              <KeyIcon tier="gold" size={16} /> {c.keys_gold}
            </span>
          }
        />
      </Stats>
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button
          onClick={() => onRest("short")}
          disabled={restDisabled}
          style={smallActionBtn(restDisabled ? "#2a2d33" : "#1f3a1f", restDisabled ? "#6a7080" : "#86efac")}
        >
          <Icon name="campfire" /> Short rest
        </button>
        <button
          onClick={() => onRest("long")}
          disabled={restDisabled}
          style={smallActionBtn(restDisabled ? "#2a2d33" : "#1f2a3a", restDisabled ? "#6a7080" : "#7dd3fc")}
        >
          <Icon name="moon-sun" /> Long rest
        </button>
      </div>
      {downed && (
        <p style={{ ...muted, fontSize: 11, marginTop: 8 }}>You're downed — wait the cooldown.</p>
      )}
      {!downed && inQuest && (
        <p style={{ ...muted, fontSize: 11, marginTop: 8 }}>Rest is disabled mid-quest.</p>
      )}
      {!inQuest && (c.keys_bronze + c.keys_silver + c.keys_gold > 0) && (
        <KeyActions
          keys={{ bronze: c.keys_bronze, silver: c.keys_silver, gold: c.keys_gold }}
          onSellKey={onSellKey}
          onTransmuteKey={onTransmuteKey}
        />
      )}
    </div>
  );
}

function KeyActions({
  keys,
  onSellKey,
  onTransmuteKey,
}: {
  keys: { bronze: number; silver: number; gold: number };
  onSellKey: (tier: "bronze" | "silver" | "gold") => void;
  onTransmuteKey: (fromTier: "bronze" | "silver") => void;
}) {
  return (
    <div style={{ marginTop: 16, padding: 12, background: "#1d1f23", borderRadius: 8 }}>
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

type InventorySort = "type" | "rarity" | "power" | "name";

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
      case "name":
        return a.item_name.localeCompare(b.item_name);
    }
  });
}

function InventoryCard({
  items,
  inQuest,
  artUrl,
  selfId,
  onEquip,
  onSell,
  onUse,
  onGive,
}: {
  items: Item[];
  inQuest: boolean;
  artUrl: string | null;
  selfId: string;
  onEquip: (itemId: number) => void;
  onSell: (itemId: number) => void;
  onUse: (itemId: number) => void;
  onGive: (itemId: number, toUserId: string, toName: string) => void;
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

  const sorted = sortItems(items, sort);
  const selected = selectedId != null ? items.find((i) => i.id === selectedId) ?? null : null;

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
    { key: "name", label: "Name" },
  ];

  return (
    <div style={card}>
      <Banner src={artUrl} alt="Inventory" />
      <h2 style={h2}>Inventory</h2>
      {inQuest && (
        <p style={{ ...muted, fontSize: 12, marginTop: 8 }}>
          Selling is disabled while a quest is active.
        </p>
      )}
      {/* Sort bar */}
      <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
        {SORT_LABELS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setSort(key)}
            style={{
              background: sort === key ? "#2a2d3a" : "#1d1f23",
              color: sort === key ? "#c084fc" : "#9aa0a6",
              border: sort === key ? "1px solid #c084fc55" : "1px solid #2a2d33",
              borderRadius: 20,
              padding: "4px 14px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "inherit",
              transition: "all 0.1s",
            }}
          >
            {label}
          </button>
        ))}
        <span style={{ ...muted, fontSize: 12, marginLeft: "auto", alignSelf: "center" }}>
          {items.length} item{items.length !== 1 ? "s" : ""}
        </span>
      </div>
      {/* Slot grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, 72px)",
          gap: 6,
          marginTop: 14,
        }}
      >
        {sorted.map((item) => (
          <ItemSlot
            key={item.id}
            item={item}
            selected={selectedId === item.id}
            onSelect={(el) => toggleSelect(item.id, el)}
          />
        ))}
      </div>
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
                onEquip={(id) => { onEquip(id); setSelectedId(null); }}
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

function ItemSlot({
  item,
  selected,
  onSelect,
}: {
  item: Item;
  selected: boolean;
  onSelect: (el: HTMLElement) => void;
}) {
  const rc = RARITY_COLOR[item.rarity];
  const borderColor = selected ? "#fff" : item.equipped ? "#b89b3a" : `${rc}99`;
  return (
    <div
      onClick={(e) => onSelect(e.currentTarget)}
      title={item.item_name}
      style={{
        width: 72,
        height: 72,
        background: selected ? "#1e1c2e" : "#1d1f23",
        borderRadius: 8,
        border: `2px solid ${borderColor}`,
        position: "relative",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: selected ? `0 0 0 1px ${rc}66` : undefined,
        transition: "border-color 0.1s, background 0.1s",
        flexShrink: 0,
      }}
    >
      {item.equipped && (
        <div
          style={{
            position: "absolute",
            top: 3,
            left: 3,
            width: 14,
            height: 14,
            background: "#b89b3a",
            borderRadius: 3,
            fontSize: 8,
            fontWeight: 800,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#000",
            lineHeight: 1,
          }}
        >
          E
        </div>
      )}
      <Icon name={itemIcon(item)} size={28} color={rc} />
      <div
        style={{
          position: "absolute",
          bottom: 3,
          right: 3,
          minWidth: 18,
          height: 18,
          background: "#0a0b0e",
          border: `1px solid ${rc}55`,
          borderRadius: "50%",
          fontSize: 9,
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: rc,
          padding: "0 2px",
          lineHeight: 1,
        }}
      >
        +{item.power}
      </div>
    </div>
  );
}

function ItemDetailPopover({
  item,
  inQuest,
  selfId,
  onEquip,
  onSell,
  onUse,
  onGive,
  onClose,
}: {
  item: Item;
  inQuest: boolean;
  selfId: string;
  onEquip: (itemId: number) => void;
  onSell: (itemId: number) => void;
  onUse: (itemId: number) => void;
  onGive: (itemId: number, toUserId: string, toName: string) => void;
  onClose: () => void;
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

  const canEquip =
    !item.equipped &&
    item.item_type !== "consumable" &&
    item.item_type !== "magic" &&
    item.item_type !== "revive" &&
    item.item_type !== "tool" &&
    item.item_type !== "scroll";
  const canSell = !item.equipped && !inQuest;
  const canUse =
    !item.equipped && (item.item_type === "consumable" || item.item_type === "magic");
  const canGive = !item.equipped;
  const rc = RARITY_COLOR[item.rarity];

  return (
    <div
      style={{
        width: 240,
        background: "#12141a",
        border: `1px solid ${rc}55`,
        borderRadius: 10,
        padding: "14px 14px 12px",
        boxShadow: "0 8px 32px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.04)",
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
          <Icon name={itemIcon(item)} size={22} color={rc} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, color: "#f5f5f5", fontSize: 13, lineHeight: 1.3, wordBreak: "break-word" }}>
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
      <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
        {ITEM_TYPE_LABELS[item.item_type]}
        {item.item_type === "weapon" && item.weapon_range && ` · ${item.weapon_range}`}
        {" · "}+{item.power} power
      </div>

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
          marginBottom: 12,
        }}
      >
        {describeItemEffect(item)}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {canEquip && (
          <button onClick={() => onEquip(item.id)} style={smallActionBtn("#1f3a1f", "#86efac")}>Equip</button>
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
          <button onClick={() => onSell(item.id)} style={smallActionBtn("#33363d", "#e6e6e6")}>Sell</button>
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
}: {
  shop: ShopResponse;
  navOverlay?: React.ReactNode;
  onBuy: (id: number, name: string) => void;
  onHaggle: (id: number) => void;
  onBuyStaple: (id: string) => void;
}) {
  const hero = navOverlay
    ? <LocationHero src={shop.art_url} label="Shop" nav={navOverlay} />
    : <Banner src={shop.art_url ?? null} alt="Shop" />;
  if (shop.error === "mid_quest") {
    return (
      <div style={card}>
        {hero}
        <h2 style={h2}>Shop</h2>
        <p style={muted}>The shopkeep is afraid of monsters. Finish the quest first.</p>
      </div>
    );
  }
  if (shop.error === "no_channel" || !shop.channel_id) {
    return (
      <div style={card}>
        {hero}
        <h2 style={h2}>Shop</h2>
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
        <h2 style={h2}>Shop</h2>
        <p style={muted}>
          Rolled stock is dry. Run <code style={kbd}>/gq shop</code> in Slack to kick off a restock,
          then refresh here. Staples are still available below.
        </p>
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
      <h2 style={h2}>Shop</h2>
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
                <div style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 15 }}>{s.name}</div>
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
  atCap,
  onBuy,
  onHaggle,
}: {
  item: ShopItem;
  playerGold: number;
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
        <Icon name={itemIcon(item)} size={24} color="#cbd5e1" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 15 }}>{item.item_name}</span>
            <RarityBadge rarity={item.rarity} />
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
        <h2 style={h2}>The Inn</h2>
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
                <div style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 15 }}>{r.name}</div>
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
        <h2 style={h2}>The Smithy</h2>
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
                  <div style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 15 }}>
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
// PUB CARD — Drink menu + Liars' Roll mini-game
// =============================================================================

function PubCard({
  pub,
  selfId,
  navOverlay,
  onBuyDrink,
  onRefresh,
}: {
  pub: PubResponse;
  selfId: string;
  navOverlay?: React.ReactNode;
  onBuyDrink: (drinkId: string) => void;
  onRefresh: () => void;
}) {
  // Liars' Roll state machine: idle → pending (after start) → result → idle
  const [liarsState, setLiarsState] = useState<
    | { phase: "idle" }
    | { phase: "pending"; round: LiarsRoundPending }
    | { phase: "result"; result: LiarsRoundResult }
  >({ phase: "idle" });
  const [liarsLoading, setLiarsLoading] = useState(false);

  // SPD state machine
  const [spdStake, setSpdStake] = useState<number | null>(null);
  const [spdLoading, setSpdLoading] = useState(false);
  const [spdResult, setSpdResult] = useState<SpdResult | null>(null);

  async function startLiars(stake: number) {
    setLiarsLoading(true);
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
      setLiarsLoading(false);
    }
  }

  async function decideLiars(roundId: number, choice: "trust" | "challenge") {
    setLiarsLoading(true);
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
      setLiarsLoading(false);
    }
  }

  // SPD helpers
  async function spdStart(stake: number, throwChoice: SpdThrow) {
    setSpdLoading(true);
    try {
      const { ok } = await postJson("/api/pub/spd/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stake, throw: throwChoice }),
      });
      if (ok) {
        setSpdStake(null);
        onRefresh();
      }
    } finally {
      setSpdLoading(false);
    }
  }

  async function spdAccept(matchId: number, throwChoice: SpdThrow) {
    setSpdLoading(true);
    try {
      const res = await fetch(`/api/pub/spd/${matchId}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ throw: throwChoice }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        const code = typeof body.error === "string" ? body.error : `http_${res.status}`;
        const label = (ERROR_LABELS as Record<string, string>)[code] ?? code;
        toast.error(label);
        return;
      }
      setSpdResult(body as unknown as SpdResult);
      onRefresh();
    } finally {
      setSpdLoading(false);
    }
  }

  async function spdBet(matchId: number, side: "initiator" | "challenger", amount: number) {
    setSpdLoading(true);
    try {
      const { ok } = await postJson(`/api/pub/spd/${matchId}/bet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ side, amount }),
      });
      if (ok) onRefresh();
    } finally {
      setSpdLoading(false);
    }
  }

  async function spdCancel(matchId: number) {
    setSpdLoading(true);
    try {
      const { ok } = await postJson(`/api/pub/spd/${matchId}/cancel`, { method: "POST" });
      if (ok) onRefresh();
    } finally {
      setSpdLoading(false);
    }
  }

  const spd = pub.spd;
  const openMatch = spd?.open_match ?? null;
  const myBet = spd?.my_bet ?? null;
  const betTotals = spd?.bet_totals ?? { initiator: 0, challenger: 0 };

  const iAmInitiator = openMatch?.initiator_user_id === selfId;
  const iAmChallenger = openMatch?.challenger_user_id === selfId;
  const canBet = openMatch !== null && !iAmInitiator && !iAmChallenger && myBet === null;

  const SPD_THROW_LABELS: Record<SpdThrow, string> = { stone: "🪨 Stone", parchment: "📜 Parchment", dagger: "🗡️ Dagger" };

  return (
    <div style={card}>
      {navOverlay
        ? <LocationHero src={pub.art_url} label="The Pub" nav={navOverlay} />
        : pub.art_url ? <Banner src={pub.art_url} alt="The Pub" /> : null}
      <h2 style={h2}>🍺 The Pub</h2>
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
          Active buff: <strong>{drinkBuffLabel(pub.drink_buff)}</strong> · {pub.drink_buff.remaining} action{pub.drink_buff.remaining === 1 ? "" : "s"} remaining
        </div>
      )}

      {/* Drink menu */}
      <div style={{ marginTop: 16 }}>
        <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 10 }}>
          Drink Menu · <span style={{ color: "#fbbf24" }}>{pub.gold}g</span>
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
                <div style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 14, display: "flex", alignItems: "center", gap: 6 }}>
                  {d.name}
                  {d.is_daily_special && (
                    <span style={{ fontSize: 10, background: "#b89b3a22", color: "#fbbf24", border: "1px solid #b89b3a55", borderRadius: 4, padding: "1px 5px", fontWeight: 700 }}>
                      SPECIAL
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
                  disabled={pub.gold < d.actual_price}
                  style={{
                    ...smallActionBtn(pub.gold >= d.actual_price ? "#1f2a3a" : "#222428", pub.gold >= d.actual_price ? "#7dd3fc" : "#7a7d83"),
                    opacity: pub.gold >= d.actual_price ? 1 : 0.6,
                    cursor: pub.gold >= d.actual_price ? "pointer" : "not-allowed",
                  }}
                >
                  Order
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Liars' Roll mini-game */}
      <div style={{ marginTop: 24, borderTop: "1px solid #2a2d33", paddingTop: 16 }}>
        <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 10 }}>
          🎲 Liars&apos; Roll — vs. the Bartender
        </div>
        <p style={{ ...muted, fontSize: 13, marginBottom: 12 }}>
          Both roll 3d6. The bartender claims a zone (Low/Mid/High) — lies 45% of the time.
          Trust ({LIARS_TRUST_MULT_DISPLAY}×) or Challenge ({LIARS_CHALLENGE_MULT_DISPLAY}×)?
        </p>

        {liarsState.phase === "idle" && (
          <div>
            <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}>Pick a stake:</div>
            <div style={{ display: "flex", gap: 8 }}>
              {[10, 25, 50].map((s) => (
                <button
                  key={s}
                  onClick={() => void startLiars(s)}
                  disabled={liarsLoading || pub.gold < s}
                  style={{
                    ...smallActionBtn(pub.gold >= s ? "#2a1f1f" : "#222428", pub.gold >= s ? "#fca5a5" : "#7a7d83"),
                    opacity: pub.gold >= s ? 1 : 0.5,
                    cursor: pub.gold >= s ? "pointer" : "not-allowed",
                  }}
                >
                  🪙 {s}g
                </button>
              ))}
            </div>
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
                <button
                  onClick={() => void decideLiars(r.round_id, "trust")}
                  disabled={liarsLoading}
                  style={smallActionBtn("#1f3a1f", "#86efac")}
                >
                  🤝 Trust ({r.trust_mult}×)
                </button>
                <button
                  onClick={() => void decideLiars(r.round_id, "challenge")}
                  disabled={liarsLoading}
                  style={smallActionBtn("#3a1f1f", "#fca5a5")}
                >
                  🔥 Challenge ({r.challenge_mult}×)
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
              <div
                style={{
                  background: won ? "#1a2a1a" : "#2a1a1a",
                  border: `1px solid ${won ? "#2d5a2d" : "#5a2d2d"}`,
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 10,
                }}
              >
                <div style={{ fontWeight: 700, color: won ? "#86efac" : "#fca5a5", marginBottom: 6 }}>
                  {won
                    ? `${r.choice === "trust" ? "🤝 Trusted correctly" : "🔥 Called the bluff"} — +${r.payout}g!`
                    : `${r.choice === "trust" ? "💸 Trusted a liar" : "💸 Called an honest claim"} — lost the stake.`}
                </div>
                <div style={{ ...muted, fontSize: 13 }}>
                  {r.lied ? "The bartender was lying." : "The bartender told the truth."}{" "}
                  True zone: <strong>{r.truth_label}</strong>.
                </div>
                <div style={{ ...muted, fontSize: 12, marginTop: 4 }}>
                  Your dice: {r.player_dice.join(", ")} · Bartender: {r.bartender_dice.join(", ")} · Combined: {r.combined}
                </div>
                <div style={{ marginTop: 6, color: "#fbbf24", fontSize: 13, fontWeight: 600 }}>
                  Gold: {r.gold}g
                </div>
              </div>
              <button
                onClick={() => setLiarsState({ phase: "idle" })}
                style={smallActionBtn("#222428", "#cbd5e1")}
              >
                Play again
              </button>
            </div>
          );
        })()}
      </div>

      {/* Stone-Parchment-Dagger */}
      <div style={{ marginTop: 24, borderTop: "1px solid #2a2d33", paddingTop: 16 }}>
        <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 10 }}>
          ⚔️ Stone-Parchment-Dagger
        </div>

        {/* Show resolved result */}
        {spdResult && (
          <div>
            <div
              style={{
                background: spdResult.tie
                  ? "#1d2a2d"
                  : spdResult.winner_user_id === selfId
                    ? "#1a2a1a"
                    : "#2a1a1a",
                border: `1px solid ${spdResult.tie ? "#2d4a5a" : spdResult.winner_user_id === selfId ? "#2d5a2d" : "#5a2d2d"}`,
                borderRadius: 8,
                padding: 12,
                marginBottom: 10,
              }}
            >
              <div
                style={{
                  fontWeight: 700,
                  color: spdResult.tie ? "#93c5fd" : spdResult.winner_user_id === selfId ? "#86efac" : "#fca5a5",
                  marginBottom: 6,
                }}
              >
                {spdResult.tie
                  ? "🤝 Tie! Everything refunded."
                  : spdResult.winner_user_id === selfId
                    ? `🏆 You won! +${spdResult.payout}g`
                    : `💸 You lost the match.`}
              </div>
              <div style={{ ...muted, fontSize: 13 }}>
                {spdResult.initiator_name} threw {SPD_THROW_LABELS[spdResult.initiator_throw]} · You threw {SPD_THROW_LABELS[spdResult.challenger_throw]}
              </div>
              {!spdResult.tie && spdResult.house_bump > 0 && (
                <div style={{ ...muted, fontSize: 12, marginTop: 4 }}>
                  House bump: +{spdResult.house_bump}g on total pot
                </div>
              )}
              <div style={{ marginTop: 6, color: "#fbbf24", fontSize: 13, fontWeight: 600 }}>
                Gold: {spdResult.gold}g
              </div>
            </div>
            <button
              onClick={() => setSpdResult(null)}
              style={smallActionBtn("#222428", "#cbd5e1")}
            >
              Done
            </button>
          </div>
        )}

        {/* No result showing — normal SPD view */}
        {!spdResult && (<>
          {/* No open match — allow initiating */}
          {!openMatch && (
            <div>
              <p style={{ ...muted, fontSize: 13, marginBottom: 12 }}>
                Commit a throw secretly. Any pub-goer can accept — loser pays. Winner takes both stakes +20%.
                Side bets pay 2×. Ties refund all.
              </p>
              {spdStake === null ? (
                <div>
                  <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}>Pick a stake:</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {[10, 25, 50].map((s) => (
                      <button
                        key={s}
                        onClick={() => setSpdStake(s)}
                        disabled={spdLoading || pub.gold < s}
                        style={{
                          ...smallActionBtn(pub.gold >= s ? "#2a1f2a" : "#222428", pub.gold >= s ? "#d8b4fe" : "#7a7d83"),
                          opacity: pub.gold >= s ? 1 : 0.5,
                          cursor: pub.gold >= s ? "pointer" : "not-allowed",
                        }}
                      >
                        ⚔️ {s}g
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div>
                  <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}>
                    Stake: <strong style={{ color: "#fbbf24" }}>{spdStake}g</strong> — pick your throw (only you will see it):
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {(["stone", "parchment", "dagger"] as SpdThrow[]).map((t) => (
                      <button
                        key={t}
                        onClick={() => void spdStart(spdStake, t)}
                        disabled={spdLoading}
                        style={smallActionBtn("#2a2010", "#fde68a")}
                      >
                        {SPD_THROW_LABELS[t]}
                      </button>
                    ))}
                    <button
                      onClick={() => setSpdStake(null)}
                      disabled={spdLoading}
                      style={smallActionBtn("#222428", "#94a3b8")}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Open match — and I am the initiator */}
          {openMatch && iAmInitiator && (
            <div>
              <div
                style={{
                  background: "#1d2a1d",
                  border: "1px solid #2d5a2d",
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 10,
                }}
              >
                <div style={{ color: "#86efac", fontWeight: 600, marginBottom: 4 }}>
                  Your match is open — waiting for a challenger
                </div>
                <div style={{ ...muted, fontSize: 13 }}>
                  Stake: <strong style={{ color: "#fbbf24" }}>{openMatch.initiator_stake}g</strong> · Your throw is hidden until someone accepts.
                </div>
                {(betTotals.initiator > 0 || betTotals.challenger > 0) && (
                  <div style={{ ...muted, fontSize: 12, marginTop: 4 }}>
                    Side bets: {betTotals.initiator}g on you · {betTotals.challenger}g on challenger
                  </div>
                )}
              </div>
              <button
                onClick={() => void spdCancel(openMatch.id)}
                disabled={spdLoading}
                style={smallActionBtn("#2a1a1a", "#fca5a5")}
              >
                Cancel match (refunds your stake)
              </button>
            </div>
          )}

          {/* Open match — and I am not the initiator (can accept or bet) */}
          {openMatch && !iAmInitiator && (
            <div>
              <div
                style={{
                  background: "#1d1f23",
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 10,
                  border: "1px solid #3a3d45",
                }}
              >
                <div style={{ color: "#f5f5f5", fontWeight: 600, marginBottom: 4 }}>
                  ⚔️ {openMatch.initiator_name} threw something for {openMatch.initiator_stake}g
                </div>
                <div style={{ ...muted, fontSize: 13 }}>
                  Their throw is secret until you accept. Stakes: {openMatch.initiator_stake}g each — winner gets {openMatch.initiator_stake * 2}g + 20% house bump.
                </div>
                {(betTotals.initiator > 0 || betTotals.challenger > 0) && (
                  <div style={{ ...muted, fontSize: 12, marginTop: 4 }}>
                    Side bets: {betTotals.initiator}g on {openMatch.initiator_name} · {betTotals.challenger}g on challenger
                  </div>
                )}
              </div>

              {/* Challenger throw picker (if not already challenger) */}
              {!iAmChallenger && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}>
                    Accept the challenge — pick your throw:
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {(["stone", "parchment", "dagger"] as SpdThrow[]).map((t) => (
                      <button
                        key={t}
                        onClick={() => void spdAccept(openMatch.id, t)}
                        disabled={spdLoading || pub.gold < openMatch.initiator_stake}
                        style={{
                          ...smallActionBtn(
                            pub.gold >= openMatch.initiator_stake ? "#2a1020" : "#222428",
                            pub.gold >= openMatch.initiator_stake ? "#f9a8d4" : "#7a7d83",
                          ),
                          opacity: pub.gold >= openMatch.initiator_stake ? 1 : 0.5,
                          cursor: pub.gold >= openMatch.initiator_stake ? "pointer" : "not-allowed",
                        }}
                      >
                        {SPD_THROW_LABELS[t]}
                      </button>
                    ))}
                  </div>
                  {pub.gold < openMatch.initiator_stake && (
                    <div style={{ ...muted, fontSize: 12, marginTop: 6, color: "#fca5a5" }}>
                      Need {openMatch.initiator_stake}g to accept (you have {pub.gold}g)
                    </div>
                  )}
                </div>
              )}

              {/* Side bet section */}
              {canBet && (
                <div>
                  <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}>
                    Or place a side bet (pays 2× if your pick wins):
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                    <span style={{ ...muted, fontSize: 12, alignSelf: "center" }}>Back {openMatch.initiator_name}:</span>
                    {[5, 10, 25].map((amt) => (
                      <button
                        key={`init-${amt}`}
                        onClick={() => void spdBet(openMatch.id, "initiator", amt)}
                        disabled={spdLoading || pub.gold < amt}
                        style={{
                          ...smallActionBtn(pub.gold >= amt ? "#2a1f10" : "#222428", pub.gold >= amt ? "#fdba74" : "#7a7d83"),
                          opacity: pub.gold >= amt ? 1 : 0.5,
                          cursor: pub.gold >= amt ? "pointer" : "not-allowed",
                        }}
                      >
                        {amt}g
                      </button>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ ...muted, fontSize: 12, alignSelf: "center" }}>Back challenger:</span>
                    {[5, 10, 25].map((amt) => (
                      <button
                        key={`chall-${amt}`}
                        onClick={() => void spdBet(openMatch.id, "challenger", amt)}
                        disabled={spdLoading || pub.gold < amt}
                        style={{
                          ...smallActionBtn(pub.gold >= amt ? "#10202a" : "#222428", pub.gold >= amt ? "#93c5fd" : "#7a7d83"),
                          opacity: pub.gold >= amt ? 1 : 0.5,
                          cursor: pub.gold >= amt ? "pointer" : "not-allowed",
                        }}
                      >
                        {amt}g
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Already bet */}
              {myBet && (
                <div style={{ ...muted, fontSize: 13, marginTop: 8 }}>
                  You bet {myBet.amount}g on {myBet.side === "initiator" ? openMatch.initiator_name : "the challenger"}.
                </div>
              )}
            </div>
          )}
        </>)}
      </div>
    </div>
  );
}

const LIARS_TRUST_MULT_DISPLAY = "1.7";
const LIARS_CHALLENGE_MULT_DISPLAY = "2.5";

function drinkBuffLabel(buff: DrinkBuff): string {
  if (buff.kind === "buff_attack") return `+${buff.magnitude} attack`;
  if (buff.kind === "buff_magic") return `+${buff.magnitude} magic`;
  return "next attack/cast/sig crits";
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
        </div>
      </div>
    </div>
  );
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
      <div style={{ ...muted, fontSize: 12, textTransform: "uppercase", letterSpacing: 1.5 }}>
        <Icon name="gold-bar" /> Shopkeeper
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: headlineColor, marginTop: 8 }}>
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

function Stat({ label, value, icon }: { label: string; value: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div style={{ padding: 12, background: "#1d1f23", borderRadius: 8 }}>
      <div style={{ ...muted, fontSize: 12, textTransform: "uppercase", display: "flex", alignItems: "center", gap: 6 }}>
        {icon}
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 600, color: "#f5f5f5" }}>
        {value}
      </div>
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

const DISTRICT_CONFIG: {
  key: TownSection;
  label: string;
  icon: string;
  color: string;
  artKey: keyof TownArt;
}[] = [
  { key: "job_board", label: "Job Board", icon: "scroll-unfurled", color: "#b89b3a", artKey: "overview_art_url" },
  { key: "pub",       label: "The Pub",   icon: "beer",            color: "#92400e", artKey: "pub_art_url" },
  { key: "shop",      label: "Shop",      icon: "gold-bar",        color: "#1e3a5f", artKey: "shop_art_url" },
  { key: "inn",       label: "Inn",       icon: "campfire",        color: "#1a3a2a", artKey: "inn_art_url" },
  { key: "smithy",    label: "Smithy",    icon: "anvil",           color: "#2a1a1a", artKey: "smithy_art_url" },
  { key: "hunt",      label: "Outskirts", icon: "sword",           color: "#1a1a2e", artKey: "overview_art_url" },
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
    <div style={{
      display: "flex",
      gap: 6,
      overflowX: "auto",
      padding: "0 0 4px",
      msOverflowStyle: "none",
    }}>
      <button
        onClick={() => onNavigate(null)}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "6px 14px", borderRadius: 20,
          border: "1.5px solid #2a2d33",
          background: "transparent",
          color: "#9ca3af",
          cursor: "pointer", fontSize: 13, fontWeight: 400,
          flexShrink: 0, whiteSpace: "nowrap",
        }}
      >
        <Icon name="tower" size={13} /> Town
      </button>
      {DISTRICT_CONFIG.map((d) => {
        const isActive = d.key === active;
        return (
          <button
            key={d.key}
            onClick={() => onNavigate(d.key)}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "6px 14px", borderRadius: 20,
              border: `1.5px solid ${isActive ? "#b89b3a" : "#2a2d33"}`,
              background: isActive ? "rgba(184,155,58,0.15)" : "transparent",
              color: isActive ? "#f1e8c8" : "#9ca3af",
              cursor: "pointer", fontSize: 13,
              fontWeight: isActive ? 600 : 400,
              flexShrink: 0, whiteSpace: "nowrap",
              transition: "all 0.15s",
            }}
          >
            <Icon name={d.icon} size={13} /> {d.label}
          </button>
        );
      })}
    </div>
  );
}

const VARIANT_STYLE: Record<string, { icon: string; color: string; bg: string; label: string }> = {
  standard: { icon: "sword",         color: "#86efac", bg: "#0a1f0a", label: "STANDARD" },
  boss:     { icon: "crown",         color: "#fca5a5", bg: "#1f0a0a", label: "BOSS" },
  dungeon:  { icon: "tower",         color: "#7dd3fc", bg: "#0a121f", label: "DUNGEON" },
  gauntlet: { icon: "crossed-swords",color: "#c4b5fd", bg: "#130a1f", label: "GAUNTLET" },
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

function HuntSection({
  characterLevel,
  overviewArt,
  navOverlay,
  onStartHunt,
}: {
  characterLevel: number;
  overviewArt: string | null;
  navOverlay: React.ReactNode;
  onStartHunt: (tier: number) => void;
}) {
  const [tier, setTier] = useState(characterLevel);
  const [busy, setBusy] = useState(false);
  const clampedTier = Math.max(1, Math.min(tier, characterLevel));

  // Rough XP preview: 15 * tier^1.2, no multiplier, single fighter.
  const xpEstimate = Math.round(15 * Math.pow(clampedTier, 1.2));
  const goldEstimate = Math.round(8 * Math.pow(clampedTier, 1.2));

  const atLevel = clampedTier === characterLevel;
  const tierLabel = atLevel
    ? "Your level — full rewards"
    : clampedTier >= characterLevel - 2
    ? `Tier ${clampedTier} — slightly easier`
    : `Tier ${clampedTier} — grinding territory`;

  async function handle() {
    setBusy(true);
    try { await onStartHunt(clampedTier); } finally { setBusy(false); }
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

        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>
            Difficulty
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              onClick={() => setTier((t) => Math.max(1, t - 1))}
              disabled={clampedTier <= 1}
              style={{
                width: 32, height: 32, borderRadius: 6,
                border: "1px solid #2a2d33", background: "#1a1d22",
                color: clampedTier <= 1 ? "#3a3d44" : "#e5e7eb",
                cursor: clampedTier <= 1 ? "not-allowed" : "pointer",
                fontSize: 18, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >−</button>
            <div style={{ textAlign: "center", minWidth: 60 }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: "#f1e8c8", lineHeight: 1 }}>
                {clampedTier}
              </div>
              <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>
                TIER
              </div>
            </div>
            <button
              onClick={() => setTier((t) => Math.min(characterLevel, t + 1))}
              disabled={clampedTier >= characterLevel}
              style={{
                width: 32, height: 32, borderRadius: 6,
                border: "1px solid #2a2d33", background: "#1a1d22",
                color: clampedTier >= characterLevel ? "#3a3d44" : "#e5e7eb",
                cursor: clampedTier >= characterLevel ? "not-allowed" : "pointer",
                fontSize: 18, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >+</button>
            <div style={{ fontSize: 12, color: "#9ca3af", marginLeft: 4 }}>{tierLabel}</div>
          </div>
        </div>

        <div style={{
          display: "flex", gap: 20, marginBottom: 20,
          padding: "10px 14px", background: "#0e1014", borderRadius: 8, border: "1px solid #2a2d33",
        }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#a3e635" }}>~{xpEstimate}</div>
            <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>XP</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#fbbf24" }}>~{goldEstimate}</div>
            <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>Gold</div>
          </div>
          <div style={{ fontSize: 11, color: "#6b7280", alignSelf: "center", lineHeight: 1.4 }}>
            Estimated single-fighter rewards.<br />Boss / elite quests give more.
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
          {busy ? "Scouting…" : `Hunt Tier ${clampedTier}`}
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
  onStartQuest: (variant: "standard" | "boss" | "gauntlet" | "dungeon", elite: boolean) => void;
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
          width: 90,
          height: 90,
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
        display: "flex",
        gap: 16,
        padding: "16px 20px 20px",
        overflowX: "auto",
        flexWrap: "wrap",
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

// Picks the best RPG-Awesome icon for an item using type, weapon_range, and
// name keywords. Exact catalog names are matched first, then broad patterns,
// then type/range defaults so there's always a sensible fallback.
function itemIcon(item: {
  item_type: ItemType;
  weapon_range?: WeaponRange | null;
  item_name: string;
}): string {
  const n = item.item_name.toLowerCase();

  switch (item.item_type) {
    case "weapon": {
      if (item.weapon_range === "focus") return "crystal-wand";
      if (/\b(axe|hatchet|cleaver|tomahawk)\b/.test(n))                   return "axe";
      if (/\b(dagger|knife|dirk|shiv|stiletto|shank)\b/.test(n))          return "plain-dagger";
      if (/\b(hammer|maul|mace|club)\b/.test(n))                          return "hammer";
      if (/\b(staff|stave|wand|rod|scepter|sceptre)\b/.test(n))           return "crystal-wand";
      if (/\b(spear|lance|pike|javelin|halberd|polearm)\b/.test(n))       return "spear-head";
      if (/\bcrossbow\b/.test(n))                                          return "crossbow";
      if (/\b(bow|longbow|shortbow|recurve)\b/.test(n))                   return "archer";
      if (/\b(arrow|bolt|quiver)\b/.test(n))                              return "barbed-arrow";
      if (/\b(gun|pistol|revolver|musket|rifle)\b/.test(n))               return "revolver";
      if (/\b(scythe|sickle)\b/.test(n))                                  return "scythe";
      if (/\btrident\b/.test(n))                                          return "trident";
      if (/\b(whip|lash|flail)\b/.test(n))                               return "vine-whip";
      if (/\b(saber|sabre|rapier|foil|estoc)\b/.test(n))                 return "spinning-sword";
      if (/\b(broadsword|greatsword|longsword|claymore)\b/.test(n))      return "broadsword";
      if (item.weapon_range === "ranged")                                  return "crossbow";
      return "sword";
    }

    case "armor": {
      if (/\b(helm|helmet|cap|hat|hood|crown|circlet|coif)\b/.test(n))   return "helmet";
      if (/\b(boot|shoe|greave|sabatons?|sandal)\b/.test(n))             return "boot-stomp";
      if (/\b(glove|gauntlet|bracer|vambrace)\b/.test(n))                return "hand";
      if (/\b(robe|vestment|raiment|cassock)\b/.test(n))                 return "hood";
      if (/\b(cloak|mantle|cape|shroud)\b/.test(n))                      return "hood";
      if (/\b(amulet|pendant|necklace|talisman|charm|locket|ring)\b/.test(n)) return "gem-pendant";
      if (/\b(vest|jerkin|jacket|coat|doublet|tunic)\b/.test(n))         return "vest";
      if (/\b(plate|cuirass|breastplate|full.?armor|heavy)\b/.test(n))   return "heavy-shield";
      if (/\b(chain|mail|maille|hauberk|ringmail)\b/.test(n))            return "circular-shield";
      if (/\b(leather|hide|studded|buckler)\b/.test(n))                  return "round-shield";
      return "shield";
    }

    case "consumable": {
      if (/\b(mushroom|fungi|fungus|shroom)\b/.test(n))                   return "super-mushroom";
      if (/\b(meat|chicken|drumstick|steak|food|ration|bread)\b/.test(n)) return "roast-chicken";
      if (/\b(herb|leaf|clover|root|petal|flower)\b/.test(n))            return "leaf";
      if (/\b(bandage|salve|poultice|balm|ointment)\b/.test(n))          return "medical-pack";
      if (/\b(elixir|essence|tincture|draught|brew)\b/.test(n))          return "heart-bottle";
      if (/\b(mana|arcane)\b/.test(n))                                    return "crystal-ball";
      return "bubbling-potion";
    }

    case "magic": {
      if (/\b(tome|book|grimoire|codex|manual)\b/.test(n))               return "book";
      if (/\b(rune|glyph|sigil)\b/.test(n))                              return "rune-stone";
      if (/\b(crystal|gem|jewel|prism)\b/.test(n))                       return "crystals";
      if (/\b(ring|band)\b/.test(n))                                     return "gem-pendant";
      return "crystal-ball";
    }

    case "revive":
      return "crowned-heart";

    case "tool": {
      if (/caffeine bomb|hotfix grenade/.test(n))                         return "bomb-explosion";
      if (/espresso shot/.test(n))                                        return "coffee-mug";
      if (/poison vial/.test(n))                                          return "poison-cloud";
      if (/\b(bomb|explosive|grenade|nuke)\b/.test(n))                   return "bomb-explosion";
      if (/\b(torch|lantern|light)\b/.test(n))                           return "torch";
      if (/\b(rope|grapple|hook)\b/.test(n))                             return "grappling-hook";
      if (/\b(trap|snare|net)\b/.test(n))                                return "bear-trap";
      if (/\b(lockpick|picks?)\b/.test(n))                               return "key-basic";
      if (/\b(shovel|spade)\b/.test(n))                                  return "shovel";
      if (/\b(vial|flask|bottle)\b/.test(n))                             return "vial";
      return "anvil";
    }

    case "scroll": {
      if (/rebase/.test(n))                                               return "cycle";
      if (/production outage/.test(n))                                    return "lightning-bolt";
      if (/\b(fire|flame|burn|inferno)\b/.test(n))                       return "fire";
      if (/\b(lightning|thunder|storm|shock)\b/.test(n))                 return "lightning-bolt";
      if (/\b(frost|ice|cold|freeze|glacial)\b/.test(n))                 return "snowflake";
      if (/\b(heal|mend|restore|cure|life)\b/.test(n))                   return "health-increase";
      if (/\b(poison|venom|toxin|blight)\b/.test(n))                     return "poison-cloud";
      if (/\b(shadow|dark|void|death|necrotic)\b/.test(n))               return "death-skull";
      if (/\b(shield|protect|ward|barrier)\b/.test(n))                   return "bolt-shield";
      if (/\b(arcane|magic|spell|enchant)\b/.test(n))                    return "fairy-wand";
      return "scroll-unfurled";
    }

    default:
      return "scroll-unfurled";
  }
}

const RARITY_COLOR: Record<Rarity, string> = {
  common: "#8a8f98",
  uncommon: "#16a34a",
  rare: "#7c83ff",
};

const EFFECT_COLOR: Record<EffectType, string> = {
  regen: "#16a34a",
  bleeding: "#dc2626",
  burning: "#f97316",
  poisoned: "#a855f7",
};

// ra-* icon names per status effect. Rendered via <Icon> with EFFECT_COLOR.
const EFFECT_ICON: Record<EffectType, string> = {
  regen: "aura",
  bleeding: "bleeding-hearts",
  burning: "fire",
  poisoned: "monster-skull",
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

const RARITY_RANK: Record<Rarity, number> = { common: 0, uncommon: 1, rare: 2 };

const card: React.CSSProperties = {
  background: "#15171b",
  padding: "var(--card-pad, 32px)",
  borderRadius: 12,
  width: "100%",
  border: "1px solid #2a2d33",
  boxSizing: "border-box",
};
const h1: React.CSSProperties = { margin: 0, fontSize: 28, color: "#f5f5f5" };
const h2: React.CSSProperties = { margin: 0, fontSize: 20, color: "#f5f5f5" };
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
const smallBadge: React.CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 1,
  padding: "2px 6px",
  borderRadius: 4,
  border: "1px solid",
  fontWeight: 600,
};
