import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";

import { findCatalogEntry } from "@gantt-quest/core";

import { CombatPage } from "./CombatPage";
import { EmojiIcon, Icon, KeyIcon } from "./icons";

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
type WeaponRange = "melee" | "ranged";

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
    if (me.character) {
      const [invRes, qRes, recentRes, shopRes, joinableRes, innRes, smithyRes] = await Promise.all([
        fetch("/api/inventory", { credentials: "include" }),
        fetch("/api/quest/active", { credentials: "include" }),
        fetch("/api/quests/recent", { credentials: "include" }),
        fetch("/api/shop", { credentials: "include" }),
        fetch("/api/quest/joinable", { credentials: "include" }),
        fetch("/api/inn", { credentials: "include" }),
        fetch("/api/smithy", { credentials: "include" }),
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
    }
    setState({ kind: "auth", me, inventory, inventoryArtUrl, activeQuest, recent, shop, joinable, inn, smithy });
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

  async function shopBuy(itemId: number) {
    const { ok } = await postJson(`/api/shop/${itemId}/buy`, { method: "POST" });
    if (ok) void refresh();
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

  async function startQuest(variant: "standard" | "boss" | "gauntlet", elite: boolean) {
    const { ok } = await postJson(`/api/quest/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variant, elite }),
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
  return (
    <Centered>
      <DashboardLayout
        main={
          <>
            {!state.activeQuest && state.joinable && (
              <JoinableQuestCard joinable={state.joinable} onJoin={joinQuest} />
            )}
            {!state.activeQuest && !state.joinable && state.me.character && (
              <StartQuestCard
                characterLevel={state.me.character.level}
                onStart={startQuest}
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
                myKeys={state.me.character ? {
                  bronze: state.me.character.keys_bronze,
                  silver: state.me.character.keys_silver,
                  gold: state.me.character.keys_gold,
                } : null}
              />
            )}
            {state.me.character && state.shop && !state.activeQuest && (
              <ShopCard
                shop={state.shop}
                onBuy={shopBuy}
                onHaggle={shopHaggle}
                onBuyStaple={shopBuyStaple}
              />
            )}
            {state.me.character && state.inn && !state.activeQuest && (
              <InnCard inn={state.inn} onStay={innStay} />
            )}
            {state.me.character && state.smithy && !state.activeQuest && (
              <SmithyCard smithy={state.smithy} onSharpen={smithySharpen} />
            )}
            {state.me.character && state.recent.length > 0 && (
              <RecentQuestsCard quests={state.recent} />
            )}
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
                onEquip={equipItem}
                onSell={sellItem}
                onUse={useItem}
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
  onStart: (variant: "standard" | "boss" | "gauntlet", elite: boolean) => void;
}) {
  const [elite, setElite] = useState(false);
  const [pending, setPending] = useState<"standard" | "boss" | "gauntlet" | null>(null);
  const bossAllowed = characterLevel >= 3;
  const gauntletAllowed = characterLevel >= 5;

  function go(variant: "standard" | "boss" | "gauntlet") {
    setPending(variant);
    onStart(variant, elite);
  }

  return (
    <div style={{ ...card, borderColor: "#b89b3a" }}>
      <h2 style={h2}>Start a new quest</h2>
      <p style={muted}>
        The dungeon master rolls a fresh foe via Workers AI. Web supports
        standard / boss / gauntlet; full dungeon expedition generation lands
        in a follow-up.
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
      </div>
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
      </div>

      <div style={{ marginTop: 16 }}>
        {s.monster_art_url && (
          <img
            src={s.monster_art_url}
            alt={s.monster_name}
            style={{
              width: "100%",
              maxHeight: 280,
              objectFit: "cover",
              display: "block",
              borderRadius: 8,
              marginBottom: 12,
            }}
            onError={(e) => { e.currentTarget.style.display = "none"; }}
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
        if (variant === "dungeon") {
          return (
            <p style={{ ...muted, fontSize: 13, marginTop: 20 }}>
              Current room: <strong>{currentNode?.type ?? "?"}</strong> — resolve in Slack with{" "}
              <code style={kbd}>/gq choose</code> or <code style={kbd}>/gq take</code>.
            </p>
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
        {portrait ? (
          <img
            src={portrait}
            alt={`${c.class} portrait`}
            style={{
              width: 72,
              height: 72,
              borderRadius: 8,
              objectFit: "cover",
              border: "1px solid #2a2d33",
              flexShrink: 0,
            }}
            onError={(e) => { e.currentTarget.style.display = "none"; }}
          />
        ) : (
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: 8,
              background: "#1d1f23",
              border: "1px solid #2a2d33",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <Icon name="player" size={36} color="#6a7080" />
          </div>
        )}
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
// real URL. Null → nothing rendered.
function Banner({ src, alt }: { src: string | null | undefined; alt: string }) {
  if (!src) return null;
  return (
    <div
      style={{
        width: "calc(100% + 32px)",
        margin: "-16px -16px 12px",
        // 3:2 aspect ratio — on a ~360px-wide card that lands ~240px tall;
        // scales naturally on wider/narrower viewports. Replaces the old
        // fixed 120px-tall strip which read as a header band.
        aspectRatio: "3 / 2",
        overflow: "hidden",
        borderRadius: "8px 8px 0 0",
      }}
    >
      <img
        src={src}
        alt={alt}
        loading="lazy"
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        onError={(e) => {
          // Hide on 404 / failure so the card doesn't show a broken-image icon.
          (e.currentTarget.parentElement as HTMLDivElement).style.display = "none";
        }}
      />
    </div>
  );
}

function InventoryCard({
  items,
  inQuest,
  artUrl,
  onEquip,
  onSell,
  onUse,
}: {
  items: Item[];
  inQuest: boolean;
  artUrl: string | null;
  onEquip: (itemId: number) => void;
  onSell: (itemId: number) => void;
  onUse: (itemId: number) => void;
}) {
  if (items.length === 0) {
    return (
      <div style={card}>
        <Banner src={artUrl} alt="Inventory" />
        <h2 style={h2}>Inventory</h2>
        <p style={muted}>Empty. Win a quest or visit the shop in Slack.</p>
      </div>
    );
  }

  const equipped = items.filter((i) => i.equipped);
  const stowed = items.filter((i) => !i.equipped);
  const groups = groupByType(stowed);

  return (
    <div style={card}>
      <Banner src={artUrl} alt="Inventory" />
      <h2 style={h2}>Inventory</h2>
      {inQuest && (
        <p style={{ ...muted, fontSize: 12, marginTop: 8 }}>
          Selling is disabled while a quest is active.
        </p>
      )}
      {equipped.length > 0 && (
        <Section title="Equipped">
          {equipped.map((it) => (
            <ItemRow key={it.id} item={it} inQuest={inQuest} onEquip={onEquip} onSell={onSell} onUse={onUse} />
          ))}
        </Section>
      )}
      {ITEM_TYPE_ORDER.filter((t) => groups[t]?.length).map((t) => (
        <Section key={t} title={ITEM_TYPE_LABELS[t]}>
          {groups[t]!.map((it) => (
            <ItemRow key={it.id} item={it} inQuest={inQuest} onEquip={onEquip} onSell={onSell} onUse={onUse} />
          ))}
        </Section>
      ))}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginTop: 16 }}>
      <div
        style={{
          ...muted,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 1.5,
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      <div style={{ display: "grid", gap: 8 }}>{children}</div>
    </div>
  );
}

function ItemRow({
  item,
  inQuest,
  onEquip,
  onSell,
  onUse,
}: {
  item: Item;
  inQuest: boolean;
  onEquip: (itemId: number) => void;
  onSell: (itemId: number) => void;
  onUse: (itemId: number) => void;
}) {
  const [showInfo, setShowInfo] = useState(false);
  const canEquip =
    !item.equipped &&
    item.item_type !== "consumable" &&
    item.item_type !== "magic" &&
    item.item_type !== "revive" &&
    item.item_type !== "tool" &&
    item.item_type !== "scroll";
  const canSell = !item.equipped && !inQuest;
  // Out-of-combat use: consumable (heal user) + magic (bump max_mana).
  // Tools / scrolls / revives require combat context — disabled here.
  const canUse =
    !item.equipped && (item.item_type === "consumable" || item.item_type === "magic");
  return (
    <div
      style={{
        padding: 12,
        background: "#1d1f23",
        borderRadius: 8,
        border: item.equipped ? "1px solid #b89b3a" : "1px solid transparent",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Icon name={ITEM_TYPE_ICON[item.item_type]} size={24} color="#cbd5e1" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 15 }}>{item.item_name}</div>
            <RarityBadge rarity={item.rarity} />
            {item.item_type === "weapon" && item.weapon_range === "ranged" && (
              <SmallBadge>ranged</SmallBadge>
            )}
            {item.item_type === "weapon" && item.weapon_range === "focus" && (
              <SmallBadge>focus</SmallBadge>
            )}
          </div>
          {item.flavor && (
            <div style={{ ...muted, fontSize: 12, fontStyle: "italic", marginTop: 2 }}>
              {item.flavor}
            </div>
          )}
        </div>
        <div style={{ fontVariantNumeric: "tabular-nums", color: "#f5f5f5", fontWeight: 600 }}>
          +{item.power}
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
        {canEquip && (
          <button onClick={() => onEquip(item.id)} style={smallActionBtn("#1f3a1f", "#86efac")}>
            Equip
          </button>
        )}
        {canUse && (
          <button onClick={() => onUse(item.id)} style={smallActionBtn("#1f2a3a", "#7dd3fc")}>
            Use
          </button>
        )}
        {canSell && (
          <button onClick={() => onSell(item.id)} style={smallActionBtn("#33363d", "#e6e6e6")}>
            Sell
          </button>
        )}
      </div>
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
  onBuy,
  onHaggle,
  onBuyStaple,
}: {
  shop: ShopResponse;
  onBuy: (id: number) => void;
  onHaggle: (id: number) => void;
  onBuyStaple: (id: string) => void;
}) {
  if (shop.error === "mid_quest") {
    return (
      <div style={card}>
        <Banner src={shop.art_url ?? null} alt="Shop" />
        <h2 style={h2}>Shop</h2>
        <p style={muted}>The shopkeep is afraid of monsters. Finish the quest first.</p>
      </div>
    );
  }
  if (shop.error === "no_channel" || !shop.channel_id) {
    return (
      <div style={card}>
        <Banner src={shop.art_url ?? null} alt="Shop" />
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
        <Banner src={shop.art_url ?? null} alt="Shop" />
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
  onBuy: (id: number) => void;
  onHaggle: (id: number) => void;
}) {
  const [showInfo, setShowInfo] = useState(false);
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
        <Icon name={ITEM_TYPE_ICON[item.item_type]} size={24} color="#cbd5e1" />
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
            onClick={() => onBuy(item.id)}
            disabled={!canBuy}
            style={smallActionBtn(canBuy ? "#1f3a1f" : "#2a2d33", canBuy ? "#86efac" : "#6a7080")}
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
  onStay,
}: {
  inn: InnResponse;
  onStay: (roomId: string) => void;
}) {
  if (inn.error === "mid_quest") {
    return (
      <div style={card}>
        <h2 style={h2}>The Inn</h2>
        <p style={muted}>The innkeep won't take questing parties. Finish the fight first.</p>
      </div>
    );
  }
  return (
    <div style={card}>
      <Banner src={inn.art_url ?? null} alt="The Inn" />
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
  onSharpen,
}: {
  smithy: SmithyResponse;
  onSharpen: (itemId: number, itemName: string, cost: number, verb: string) => void;
}) {
  if (smithy.error === "mid_quest") {
    return (
      <div style={card}>
        <h2 style={h2}>The Smithy</h2>
        <p style={muted}>The smith won't take your steel mid-quest — wrap up the fight first.</p>
      </div>
    );
  }
  return (
    <div style={card}>
      <Banner src={smithy.art_url ?? null} alt="The Smithy" />
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

// Two-column dashboard layout. On wide viewports (≥ 900px) renders main
// content on the left and `side` on the right at 360px. On narrow screens
// it falls back to a single stacked column (main above side).
function DashboardLayout({
  main,
  side,
  footer,
}: {
  main: React.ReactNode;
  side: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const wide = useWideViewport();
  if (!wide) {
    // Mobile: stack everything, full viewport width (no 560px cap so tablets
    // breathe). Login keeps its narrower Stack — only the dashboard goes wide.
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16, width: "100%" }}>
        {main}
        {side}
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

function Centered({ children }: { children: React.ReactNode }) {
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
        padding: 32,
      }}
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

// rpg-awesome ra-* class names — rendered via <Icon name={...}> in card rows.
const ITEM_TYPE_ICON: Record<ItemType, string> = {
  weapon: "sword",
  armor: "shield",
  magic: "crystal-ball",
  consumable: "bubbling-potion",
  revive: "crowned-heart",
  tool: "anvil",
  scroll: "scroll-unfurled",
};

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
  padding: 32,
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
