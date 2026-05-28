import { Component, useEffect, useRef, useState } from "react";
import type { CSSProperties, ErrorInfo, ReactNode } from "react";
import toast from "react-hot-toast";

import { CLASSES, findCatalogEntry, priceFor, sellPriceFor, type Achievement, type StatKey } from "@gantt-quest/core";

import { CombatPage } from "./CombatPage";
import { LobbyView } from "./LobbyView";
import { Avatar, EmojiIcon, Icon } from "./icons";
import { issueWebLoginCode } from "@gantt-quest/db";

import type {
  Character, ItemType, Rarity, WeaponRange, EquipSlot, Item, QuestVariant, EffectType,
  StatusEffect, LootOption, MonsterSpec, TowerRestStockItem, SceneJson, ActiveQuest,
  RecentQuest, QuestStats, QuestLeaderboardEntry, TowerLeaderboardEntry, MeResponse,
  InventoryResponse, ShopItem, StapleItem, ShopResponse, HaggleResult, InnRoom, InnResponse,
  SmithyItem, SmithyStockListing, SmithyResponse, DrinkItem, DrinkBuff, SpdThrow, SpdOpenMatch,
  SpdBet, SpdBetTotals, SpdData, SpdResult, PubNpcOption, PubTalkResponse, PubNpc,
  PubLeaderboardEntry, MercSpec, PubResponse, LiarsRoundPending, LiarsRoundResult, KnownCharacter,
  AchievementsResponse, ConfirmRequest, ActiveQuestResponse, JoinableQuest, RecentQuestsResponse,
  TownSection, TownArt, ApothecaryDownedChar, ApothecaryStapleItem, ApothecaryResponse,
  JobListing, BoardResponse, LoadState, SlotsListResponse, QuestOption, InventorySort,
} from "./types";
import {
  CATALOG_EFFECT, ERROR_LABELS, RARITY_COLOR, RARITY_RANK, EFFECT_COLOR, EFFECT_ICON,
  ITEM_TYPE_ORDER, ITEM_TYPE_LABELS, SLOT_LABELS, SLOT_ICON,
  VARIANT_LABEL, VARIANT_STYLE, ART_PLACEHOLDERS, DEFAULT_ART_PLACEHOLDER,
  LIARS_TRUST_MULT_DISPLAY, LIARS_CHALLENGE_MULT_DISPLAY, GAME_LABELS, HUNT_PACK_LABEL,
  HAGGLE_LABEL, QUEST_OPTIONS, DISTRICT_CONFIG,
} from "./constants";
import { DISPLAY_FONT, card, h1, h2, muted, input, button, kbd, refreshBtn, smallBadge, smallActionBtn } from "./styles";
import {
  postJson,
  slotLabel, statBonusSummary, itemIcon, itemIconColor, sortItems,
  describeItemEffect,
} from "./utils";
import {
  LocationHero, Banner, RarityBadge, SmallBadge,
  RefreshButton, RestockButton, ModalBackdrop, HaggleResultDialog, ConfirmDialog,
} from "./components/ui";
import { PubCard, PubLeaderboardCard, LiarsRollCard, SpdCard } from "./components/Pub";
import { QuestStatsCard, QuestLeaderboardCard, TowerLeaderboardCard, RecentQuestsCard } from "./components/StatsCards";
import { ShopCard, InnCard, SmithyCard, ApothecaryCard } from "./components/Merchants";
import {
  PartyMember, ReadOnlyDoll, CharacterInspectDialog,
  HpBar, ArmorBar, ManaBar,
  EffectChips, VariantBadge, PositionBadge,
  AdventurersCard,
  AchievementToast, AchievementToastStack, TrophyBadge, TrophyShelf,
  AdventurerSheet,
  PrimaryStatCard, DerivedStatCard,
  CharacterCard,
  CharacterSlotsModal,
  Stats, Stat, Stack,
} from "./components/Character";
import { InventoryCard, InventoryFullScreen, DollSlotCell, DroppablePackPanel, DraggablePackItem, DragItemPreview, ItemCell, ItemSlot, ItemDetailPopover } from "./components/Inventory";
import { StartQuestCard, JoinableQuestCard, TownNav, JobPostingCard, StepPicker, HuntSection, JobBoardSection, DistrictTile, TownMap } from "./components/Town";


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
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const isMobile = useMobileViewport();

  useEffect(() => {
    void refresh();
  }, []);

  // Pending notifications (gifts, etc.) — fetched on initial mount and
  // whenever the tab becomes visible. The endpoint is read-and-clear so
  // a given toast fires exactly once per delivery, never duplicates
  // across tabs/devices (first fetch wins).
  useEffect(() => {
    if (state.kind !== "auth") return;
    async function fetchPending() {
      try {
        const res = await fetch("/api/notifications/pending", { credentials: "include" });
        if (!res.ok) return;
        const body = (await res.json()) as {
          notifications?: Array<{
            id: number;
            kind: string;
            payload: Record<string, unknown>;
            created_at: number;
          }>;
        };
        for (const n of body.notifications ?? []) {
          if (n.kind === "item_received") {
            const p = n.payload as {
              from_name?: string;
              item_name?: string;
              item_type?: string;
              rarity?: string;
            };
            const rarityIcon =
              p.rarity === "legendary" ? "✨" :
              p.rarity === "epic" ? "💜" :
              p.rarity === "rare" ? "🔷" :
              p.rarity === "uncommon" ? "🟢" : "🎁";
            toast(
              `${rarityIcon} ${p.from_name ?? "Someone"} gave you ${p.item_name ?? "an item"}!`,
              { duration: 6000 },
            );
          }
        }
      } catch {
        // Silent — notification fetch is best-effort.
      }
    }
    void fetchPending();
    const onVisibility = () => {
      if (!document.hidden) void fetchPending();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [state.kind]);

  // Toast once when a joinable quest first appears. JSX form so we can
  // include an inline "Join fight" button — saves the player a trip up
  // to the quest card. Click dismisses the toast and fires the same
  // joinQuest() that the card's Join button uses; on success the
  // dashboard refreshes and the active quest card replaces the join
  // card. On failure (already on a quest, downed, etc.) the join
  // endpoint silently no-ops; the toast just disappears.
  const prevJoinableIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (state.kind !== "auth") return;
    const jId = state.joinable?.quest_id ?? null;
    if (jId !== null && jId !== prevJoinableIdRef.current) {
      const j = state.joinable!;
      toast(
        (t) => (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              ⚔ <strong>{j.monster_name}</strong> stirs — a {j.variant} quest is open!
            </span>
            <button
              onClick={() => {
                void joinQuest();
                toast.dismiss(t.id);
              }}
              style={{
                padding: "5px 12px",
                background: "#7f1d1d",
                border: "1px solid #b91c1c",
                borderRadius: 6,
                color: "#fecaca",
                fontWeight: 700,
                fontSize: 12,
                cursor: "pointer",
                letterSpacing: 0.3,
                whiteSpace: "nowrap",
              }}
            >
              ⚔ Join fight
            </button>
          </div>
        ),
        { duration: 10000 },
      );
    }
    prevJoinableIdRef.current = jId;
  }, [state.kind === "auth" ? state.joinable?.quest_id : null]);

  // Toast once when a lobby invite first appears for me. Fires for both
  // brand-new lobbies and for transitions where my row changed to pending
  // on a still-open lobby. Dedup'd on questId so we don't re-toast each poll.
  const prevLobbyToastRef = useRef<number | null>(null);
  useEffect(() => {
    if (state.kind !== "auth") return;
    const lobby = state.lobbyQuest;
    if (!lobby) {
      prevLobbyToastRef.current = null;
      return;
    }
    const me = lobby.party.find((m) => m.slack_user_id === state.me.slack_user_id);
    const myStatus = me?.invite_status ?? null;
    const qId = lobby.quest.id;
    if (qId !== prevLobbyToastRef.current && myStatus === "pending") {
      toast(`🛡 You've been invited to a quest lobby! Open the LOBBY tab →`, { duration: 7000 });
      prevLobbyToastRef.current = qId;
    } else if (qId === prevLobbyToastRef.current && myStatus !== "pending") {
      // Reset so a later re-invite (rare but possible) re-toasts.
      // No-op: keep dedup until lobby goes away entirely.
    }
  }, [
    state.kind === "auth" ? state.lobbyQuest?.quest.id : null,
    state.kind === "auth"
      ? state.lobbyQuest?.party.find((m) => m.slack_user_id === state.me.slack_user_id)?.invite_status
      : null,
  ]);

  // Background poll — keep the dashboard in sync with partymate activity
  // (joins, shop buys, slack-driven combat). Paused when CombatPage is open
  // (the WS keeps that screen live) and when the tab is hidden to save battery.
  useEffect(() => {
    if (activeCombat) return;
    // 5s on the dashboard so lobby invites surface fast; the longer 15s
    // baseline was leaving teammates oblivious to fresh invites while
    // browsing town. All in free tier; see cost analysis discussion.
    const POLL_MS = 5_000;
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
    let towerLeaderboard: TowerLeaderboardEntry[] = [];
    let shop: ShopResponse | null = null;
    let joinable: JoinableQuest | null = null;
    let inn: InnResponse | null = null;
    let smithy: SmithyResponse | null = null;
    let pub: PubResponse | null = null;
    let apothecary: ApothecaryResponse | null = null;
    let townArt: TownArt | null = null;
    let board: BoardResponse | null = null;
    if (me.character) {
      const [invRes, qRes, lobbyRes, recentRes, statsRes, leaderboardRes, towerLbRes, shopRes, joinableRes, innRes, smithyRes, pubRes, townRes, boardRes, apoRes] = await Promise.all([
        fetch("/api/inventory", { credentials: "include" }),
        fetch("/api/quest/active", { credentials: "include" }),
        fetch("/api/quest/lobby", { credentials: "include" }),
        fetch("/api/quests/recent", { credentials: "include" }),
        fetch("/api/stats", { credentials: "include" }),
        fetch("/api/leaderboard", { credentials: "include" }),
        fetch("/api/leaderboard/tower", { credentials: "include" }),
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
      if (towerLbRes.ok) {
        towerLeaderboard = ((await towerLbRes.json()) as { entries: TowerLeaderboardEntry[] }).entries;
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
        smithy = body.error === "mid_quest" ? body : null;
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
    setState({ kind: "auth", me, inventory, inventoryArtUrl, activeQuest, lobbyQuest, recent, questStats, leaderboard, towerLeaderboard, shop, joinable, inn, smithy, pub, apothecary, townArt, board });
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

  async function apothecarySelfRevive() {
    const res = await fetch("/api/apothecary/self_revive", { method: "POST", credentials: "include" });
    const body = await res.json() as { ok?: boolean; error?: string; cost?: { gold: number; xp: number } };
    if (!res.ok || !body.ok) {
      if (body.error === "not_downed") toast.error("You're not downed anymore.");
      else toast.error("Self-revive failed.");
      return;
    }
    const c = body.cost ?? { gold: 0, xp: 0 };
    toast.success(`Back on your feet. Cost: ${c.gold}g + ${c.xp} XP.`);
    void Promise.all([refreshMe(), refreshApothecary()]);
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

  async function rerollCharacter(className?: string) {
    const res = await fetch("/api/character/reroll", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(className ? { class: className } : {}),
    });
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

  // Open a reinforcement lobby on an active quest. Server-side is a no-op
  // beyond returning the lobby snapshot — but we refresh so the lobby drawer
  // mounts immediately for the creator (with the invite UI ready). The
  // creator's row is already in quest_party with invite_status='accepted'
  // from the original lobby flow.
  async function openRecruitment(questId: number) {
    const { ok } = await postJson(`/api/quest/${questId}/recruit`, { method: "POST" });
    if (!ok) return;
    toast("🆘 Reinforcement lobby open — invite players from the LOBBY tab.", { duration: 5000 });
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
    }, { skipErrorToast: true });
    if (!ok) {
      if (body?.error === "cooldown" && typeof body.ready_in_ms === "number") {
        const ms = body.ready_in_ms;
        const hrs = Math.floor(ms / (60 * 60 * 1000));
        const mins = Math.max(1, Math.ceil((ms % (60 * 60 * 1000)) / 60_000));
        const eta = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
        const flavor = kind === "long"
          ? "Gathering more firewood"
          : "Bandages still drying";
        toast.error(`${flavor} (cooldown resets in ${eta})`);
      } else {
        const code = typeof body?.error === "string" ? body.error : "unknown";
        toast.error(ERROR_LABELS[code] ?? code);
      }
      return;
    }
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

  async function smithyBuy(stockId: number, itemName: string, price: number) {
    setConfirm({
      title: `Buy ${itemName}?`,
      message: `Pay ${price}g for ${itemName}. It'll land in your inventory unequipped.`,
      confirmLabel: "Buy",
      onConfirm: async () => {
        const { ok, body } = await postJson(`/api/smithy/buy/${stockId}`, { method: "POST" });
        if (!ok) return;
        if (body && body.item && typeof body.item === "object") {
          toast.success(`Bought ${itemName}.`);
        }
        void refresh();
      },
    });
  }

  async function smithyRepair(cost: number) {
    setConfirm({
      title: "Repair Armor?",
      message: `Pay ${cost}g to restore your armor to full.`,
      confirmLabel: "Repair",
      onConfirm: async () => {
        const { ok, body } = await postJson("/api/smithy/repair", { method: "POST" });
        if (!ok) return;
        if (body && typeof body.armor_restored === "number") {
          toast.success(`Armor repaired (+${body.armor_restored} restored).`);
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

  async function hireMerc(mercId: string) {
    const { ok, body } = await postJson(`/api/pub/hire/${mercId}`, { method: "POST" });
    if (!ok) {
      if (body?.error === "insufficient_gold") toast.error("Not enough gold.");
      else if (body?.error === "already_hired") toast.error("You already have a merc.");
      return;
    }
    toast.success("Merc hired! They'll fight with you next quest.");
    void refreshPub();
  }

  async function dismissMerc() {
    const { ok } = await postJson("/api/pub/dismiss-merc", { method: "POST" });
    if (!ok) return;
    toast.success("Merc dismissed.");
    void refreshPub();
  }

  async function shopBuyStaple(stapleId: string) {
    const { ok, body } = await postJson(`/api/shop/staple/${stapleId}/buy`, { method: "POST" });
    if (!ok) return;
    if (body && typeof body.paid === "number") {
      toast.success(`Bought for ${body.paid}g.`);
    }
    void refresh();
  }

  async function joinQuest() {
    const { ok } = await postJson(`/api/quest/join`, { method: "POST" });
    if (ok) void refresh();
  }

  async function startQuest(variant: QuestVariant, elite: boolean, invitees: string[] = []) {
    if (invitees.length > 0) {
      const { ok } = await postJson(`/api/quest/start_with_party`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant, elite, invitees }),
      });
      if (ok) void refresh();
    } else {
      const { ok } = await postJson(`/api/quest/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant, elite }),
      });
      if (ok) void refresh();
    }
  }

  async function takeJob(jobId: string) {
    const { ok } = await postJson("/api/board/take", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId }),
    });
    if (ok) void refresh();
  }

  async function startHunt(tier: number, monsterCount: number, invitees: string[] = []) {
    const { ok } = await postJson("/api/hunt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier, monster_count: monsterCount, invitees }),
    });
    if (ok) void refresh();
  }

  if (state.kind === "loading") return <Centered>Loading…</Centered>;
  if (state.kind === "anon") return <Login onSuccess={refresh} />;

  // Tower: pause for non-combat floor states (rest stop / post-boss choice).
  // Combat + boss floors fall through to the normal combat flow.
  if (
    state.kind === "auth" &&
    state.activeQuest?.quest.scene.variant === "tower" &&
    state.me.character &&
    (state.activeQuest.quest.scene.tower_floor_kind === "rest" ||
      state.activeQuest.quest.scene.tower_awaiting_choice)
  ) {
    const aq = state.activeQuest;
    return (
      <TowerInterlude
        questId={aq.quest.id}
        scene={aq.quest.scene}
        party={aq.party}
        selfId={state.me.slack_user_id}
        onAdvance={() => void refresh()}
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
        {confirm && (
          <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
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
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {state.towerLeaderboard.length > 0 && (
                <TowerLeaderboardCard entries={state.towerLeaderboard} selfId={state.me.slack_user_id} />
              )}
              {state.me.character && state.recent.length > 0 && (
                <RecentQuestsCard quests={state.recent} />
              )}
            </div>
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
              onHireMerc={hireMerc}
              onDismissMerc={dismissMerc}
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
          <SmithyCard smithy={state.smithy} navOverlay={townNav} characterLevel={state.me.character.level} onSharpen={smithySharpen} onRepair={smithyRepair} onBuy={smithyBuy} />
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
            onSelfRevive={apothecarySelfRevive}
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
            {(state.lobbyQuest || state.activeQuest) && (
              <LobbyView
                selfId={state.me.slack_user_id}
                activeQuestId={state.activeQuest?.quest.id ?? null}
                onQuestStarted={async () => {
                  // Capture before the refresh — lobbyQuest may be null in
                  // reinforcement scenarios where LobbyView is mounted on
                  // state.activeQuest. Bail safely if we never had a lobby.
                  const lobbyQuest = state.lobbyQuest;
                  await refresh();
                  if (!lobbyQuest) return;
                  void startCombat(lobbyQuest.quest.id);
                }}
              />
            )}
            {state.activeQuest && (
              <ActiveQuestCard
                quest={state.activeQuest.quest}
                party={state.activeQuest.party}
                selfId={state.me.slack_user_id}
                combatInProgress={hasWebCombat}
                onStartCombat={() => startCombat(state.activeQuest!.quest.id)}
                onOpenRecruitment={() => openRecruitment(state.activeQuest!.quest.id)}
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
              onLogout={logout}
              onReroll={rerollCharacter}
              onSpend={spendStatPoint}
              onSaveNotifyPref={saveNotifyPref}
              onOpenDevTools={import.meta.env.DEV ? () => setDevToolsOpen(true) : undefined}
              onRefresh={async () => { await refresh(); await refreshMe(); }}
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
      {devToolsOpen && import.meta.env.DEV && state.kind === "auth" && state.me.character && (
        <DevToolsModal
          character={state.me.character}
          onClose={() => setDevToolsOpen(false)}
          onRefresh={refreshMe}
        />
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

  async function dummyDevAuth() {
    const res = await fetch("/api/dev/login", { method: "POST" });
    const { code } = (await res.json()) as { code: string };
    setCode(code);
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
          {import.meta.env.DEV && (
            <button
              type="button"
              onClick={dummyDevAuth}
              style={{ ...button, background: "#1f2a3a", color: "#7dd3fc", border: "1px solid #2a3d55" }}
            >
              Dev login
            </button>
          )}
        </form>
        {error && <p style={{ ...muted, color: "#c0392b" }}>{error}</p>}
      </div>
    </Centered>
  );
}




// Full-screen interlude for non-combat tower floors (rest stop + post-boss
// choice). Renders the merchant picker or the press-on/bank prompt; on
// resolution it calls onAdvance which triggers an App-level refresh and
// drops the user back into the next floor's combat flow.
function TowerInterlude({
  questId,
  scene,
  party,
  selfId,
  onAdvance,
}: {
  questId: number;
  scene: SceneJson;
  party: Character[];
  selfId: string;
  onAdvance: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const floor = scene.tower_floor ?? 0;
  const cycle = scene.tower_cycle ?? 1;
  const kills = scene.tower_kills_run ?? 0;

  // Generic post helper that triggers App-level refresh on success.
  // Used for /tower/continue, /tower/exit, and /tower/rest_advance — each
  // of those mutates scene_json and the next render shows the new state.
  async function call(path: string, body?: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/quest/${questId}${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : "{}",
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!data.ok) throw new Error(data.error ?? "request_failed");
      onAdvance();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Pick-an-item helper. Refreshes activeQuest after each successful
  // claim so the claim badge appears immediately. Uses a separate
  // pendingIdx so we can show a per-button spinner without disabling the
  // whole card.
  const [pendingIdx, setPendingIdx] = useState<number | null>(null);
  async function pickItem(idx: number) {
    if (pendingIdx !== null || busy) return;
    setPendingIdx(idx);
    setErr(null);
    try {
      const res = await fetch(`/api/quest/${questId}/tower/rest_pick`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: idx }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!data.ok) throw new Error(data.error ?? "request_failed");
      // Refresh activeQuest so the new claim is reflected in scene.tower_rest_claims.
      onAdvance();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPendingIdx(null);
    }
  }

  const wrapper: React.CSSProperties = { padding: "32px 16px", maxWidth: 540, margin: "0 auto" };
  const pickerBtn: React.CSSProperties = {
    width: "100%",
    padding: "12px 14px",
    fontSize: 15,
    borderRadius: 8,
    border: "1px solid #2a2d33",
    background: "#1a1c20",
    color: "#f5f5f5",
    cursor: "pointer",
    textAlign: "left",
  };

  if (scene.tower_awaiting_choice) {
    return (
      <div style={wrapper}>
        <div style={{ ...card, borderColor: "#854d0e" }}>
          <div style={{ fontSize: 12, color: "#fbbf24", textTransform: "uppercase", letterSpacing: 1.5, display: "flex", alignItems: "center", gap: 6 }}>
            <Icon name="tower-flag" size={14} color="#fbbf24" /> Cycle {cycle} cleared
          </div>
          <h2 style={{ ...h2, marginTop: 4 }}>You stand atop floor {floor}.</h2>
          <p style={muted}>
            The boss lies broken. Tower kills this run: <strong>{kills}</strong>. Press on into
            cycle {cycle + 1} for steeper rewards, or bank your spoils and descend.
          </p>
          {err && <div style={{ color: "#fca5a5", marginTop: 12 }}>Error: {err}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button
              style={{ ...button, background: "#854d0e", color: "#fef3c7", marginTop: 0, flex: 1, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}
              disabled={busy}
              onClick={() => void call("/tower/continue")}
            >
              <Icon name="tower-flag" size={16} color="#fef3c7" /> Press on (Floor {floor + 1})
            </button>
            <button
              style={{ ...pickerBtn, fontWeight: 600, textAlign: "center", flex: 1 }}
              disabled={busy}
              onClick={() => void call("/tower/exit")}
            >
              🛌 Call it a day
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Rest stop floor — claim up to one item each, then "Press on" together.
  const stock = scene.tower_rest_stock ?? [];
  const claims = scene.tower_rest_claims ?? {};
  const partyById = new Map(party.map((p) => [p.slack_user_id, p]));
  const myClaimedIdx = Object.entries(claims).find(([, uid]) => uid === selfId)?.[0];
  const iHaveClaimed = myClaimedIdx !== undefined;

  return (
    <div style={wrapper}>
      <div style={{ ...card, borderColor: "#854d0e" }}>
        <div style={{ fontSize: 12, color: "#fbbf24", textTransform: "uppercase", letterSpacing: 1.5 }}>
          🛌 Floor {floor} · Cycle {cycle}
        </div>
        <h2 style={{ ...h2, marginTop: 4 }}>Rest stop</h2>
        <p style={muted}>
          The party is fully healed. A hooded trader has set out three trinkets — each party member
          can take at most one. When you're ready, press on into the next floor.
        </p>
        {err && <div style={{ color: "#fca5a5", marginTop: 12 }}>Error: {err}</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
          {stock.map((it, idx) => {
            const claimedBy = claims[String(idx)];
            const claimedByMe = claimedBy === selfId;
            const claimer = claimedBy ? partyById.get(claimedBy) : null;
            const canTake = !claimedBy && !iHaveClaimed;
            const isPending = pendingIdx === idx;
            return (
              <div
                key={idx}
                style={{
                  ...pickerBtn,
                  cursor: canTake ? "pointer" : "default",
                  opacity: claimedBy && !claimedByMe ? 0.55 : 1,
                  borderColor: claimedByMe ? "#fbbf24" : "#2a2d33",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <strong>{it.name}</strong>
                  <span style={{ ...muted, fontSize: 12 }}>
                    ({it.item_type}, power {it.power}, {it.rarity})
                  </span>
                  {claimedBy && (
                    <span style={{
                      marginLeft: "auto",
                      fontSize: 11,
                      fontWeight: 600,
                      color: claimedByMe ? "#fbbf24" : "#9aa0a6",
                      padding: "2px 8px",
                      borderRadius: 4,
                      background: claimedByMe ? "#2d2410" : "#1a1c20",
                    }}>
                      {claimedByMe ? "you took this" : `taken by ${claimer?.name ?? claimedBy}`}
                    </span>
                  )}
                </div>
                {it.flavor && <div style={{ ...muted, fontSize: 12, marginTop: 4 }}>{it.flavor}</div>}
                {canTake && (
                  <button
                    style={{
                      marginTop: 8,
                      padding: "6px 12px",
                      borderRadius: 6,
                      border: "1px solid #b89b3a",
                      background: "#2d2410",
                      color: "#fbbf24",
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                    disabled={isPending}
                    onClick={() => void pickItem(idx)}
                  >
                    {isPending ? "Taking…" : "Take"}
                  </button>
                )}
              </div>
            );
          })}
          <button
            style={{
              ...button,
              background: "#854d0e",
              color: "#fef3c7",
              marginTop: 12,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
            }}
            disabled={busy || pendingIdx !== null}
            onClick={() => void call("/tower/rest_advance")}
          >
            <Icon name="tower-flag" size={16} color="#fef3c7" /> Press on (Floor {floor + 1})
          </button>
        </div>
      </div>
    </div>
  );
}

function ActiveQuestCard({
  quest,
  party,
  selfId,
  combatInProgress,
  onStartCombat,
  onOpenRecruitment,
}: {
  quest: ActiveQuest;
  party: Character[];
  selfId: string;
  combatInProgress: boolean;
  onStartCombat: () => void;
  onOpenRecruitment: () => void;
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
        {/* Threat profile pills — same color/icon language as the in-combat
            MonsterCard. Shown pre-Engage so players can plan loadouts /
            resist gear / approach order before clicking "Open Combat".
            Reads from the primary monster (pack[0]) or the top-level scene
            fields for solo quests. */}
        {(() => {
          const m0 = s.monsters?.[0];
          const attackType: "physical" | "magic" | "fire" | "ice" | "lightning" =
            (m0?.attack_damage_type ?? s.monster_attack_type ?? "physical") as
              "physical" | "magic" | "fire" | "ice" | "lightning";
          const elementWeak = m0?.element_weakness;
          const elementResist = m0?.element_resistance;
          const damageWeak = m0?.damage_weakness ?? s.monster_damage_weakness;
          const damageResist = m0?.damage_resistance ?? s.monster_damage_resistance;
          const showAttack = attackType !== "physical";
          if (!showAttack && !elementWeak && !elementResist && !damageWeak && !damageResist) {
            return null;
          }
          const dtypeIcon = (t: string) =>
            t === "fire" ? "🔥" : t === "ice" ? "❄️" : t === "lightning" ? "⚡" : t === "magic" ? "✨" : "⚔";
          const dtypeColor = (t: string) =>
            t === "fire" ? "#fb923c" :
            t === "ice" ? "#7dd3fc" :
            t === "lightning" ? "#fde047" :
            t === "magic" ? "#c084fc" : "#9aa0a6";
          return (
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              {showAttack && (
                <span
                  title={`Attacks deal ${attackType} damage — bypasses your armor pool`}
                  style={{
                    fontSize: 10, fontWeight: 700,
                    background: dtypeColor(attackType) + "22",
                    border: `1px solid ${dtypeColor(attackType)}55`,
                    color: dtypeColor(attackType), borderRadius: 4,
                    padding: "2px 6px", textTransform: "uppercase", letterSpacing: 0.4,
                  }}
                >
                  {dtypeIcon(attackType)} {attackType} attacks
                </span>
              )}
              {elementWeak && (
                <span
                  title={`Vulnerable to ${elementWeak} element procs — fire/ice/lightning weapons stack effects faster`}
                  style={{
                    fontSize: 10, fontWeight: 700,
                    background: "#7f1d1d22", border: "1px solid #f8717144",
                    color: "#fca5a5", borderRadius: 4, padding: "2px 6px",
                    textTransform: "uppercase", letterSpacing: 0.4,
                  }}
                >
                  {dtypeIcon(elementWeak)} {elementWeak} weak
                </span>
              )}
              {elementResist && (
                <span
                  title={`Resists ${elementResist} element procs`}
                  style={{
                    fontSize: 10, fontWeight: 700,
                    background: "#1e3a5f22", border: "1px solid #60a5fa44",
                    color: "#93c5fd", borderRadius: 4, padding: "2px 6px",
                    textTransform: "uppercase", letterSpacing: 0.4,
                  }}
                >
                  {dtypeIcon(elementResist)} {elementResist} resist
                </span>
              )}
              {damageWeak && damageWeak !== elementWeak && (
                <span
                  title={`Takes extra damage from ${damageWeak} attacks`}
                  style={{
                    fontSize: 10, fontWeight: 700,
                    background: "#7f1d1d22", border: "1px solid #f8717144",
                    color: "#fca5a5", borderRadius: 4, padding: "2px 6px",
                    textTransform: "uppercase", letterSpacing: 0.4,
                  }}
                >
                  {dtypeIcon(damageWeak)} {damageWeak} vuln
                </span>
              )}
              {damageResist && damageResist !== elementResist && (
                <span
                  title={`Takes reduced damage from ${damageResist} attacks`}
                  style={{
                    fontSize: 10, fontWeight: 700,
                    background: "#1e3a5f22", border: "1px solid #60a5fa44",
                    color: "#93c5fd", borderRadius: 4, padding: "2px 6px",
                    textTransform: "uppercase", letterSpacing: 0.4,
                  }}
                >
                  {dtypeIcon(damageResist)} {damageResist} tough
                </span>
              )}
            </div>
          );
        })()}
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
        const combatAvailable =
          variant === "standard" ||
          variant === "boss" ||
          variant === "gauntlet" ||
          // Tower combat + boss floors. Rest floors and the post-boss
          // awaiting-choice state route to TowerInterlude up-stack and
          // never reach the dashboard, but be defensive about both.
          (variant === "tower" &&
            (s.tower_floor_kind === "combat" || s.tower_floor_kind === "boss") &&
            !s.tower_awaiting_choice);
        if (combatAvailable) {
          const isCreator = quest.created_by === selfId;
          return (
            <div style={{ display: "flex", gap: 10, marginTop: 20, flexWrap: "wrap" }}>
              <button
                onClick={onStartCombat}
                style={{ ...button, flex: 1, minWidth: 200, background: "#b89b3a", color: "#0e0f12" }}
              >
                <Icon name="sword" /> {combatInProgress ? "Resume Combat" : "Open Combat"}
              </button>
              {isCreator && (
                <button
                  onClick={onOpenRecruitment}
                  title="Open a reinforcement lobby. Invitees who accept will join the fight in progress."
                  style={{
                    ...button,
                    background: "#1f2937",
                    color: "#fca5a5",
                    border: "1px solid #7f1d1d",
                  }}
                >
                  🆘 Call Reinforcements
                </button>
              )}
            </div>
          );
        }
        return null;
      })()}
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

// DEV ONLY — shown from AccountPopover in local env (import.meta.env.DEV).
function DevToolsModal({
  character,
  onClose,
  onRefresh,
}: {
  character: Character;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [goldAmount, setGoldAmount] = useState("1000");
  const [levelAmount, setLevelAmount] = useState(String(character.level));
  const [busy, setBusy] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [itemType, setItemType] = useState("weapon");
  const [itemName, setItemName] = useState("Dev Sword");
  const [itemPower, setItemPower] = useState("15");
  const [itemRarity, setItemRarity] = useState("rare");
  const [itemRange, setItemRange] = useState("melee");
  const [itemSlot, setItemSlot] = useState("main_hand");
  const [itemElement, setItemElement] = useState("");
  const [statBonuses, setStatBonuses] = useState({ str: "", int_stat: "", vit: "", agi: "", dex: "" });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  async function devAction(endpoint: string, body?: object) {
    setBusy(endpoint);
    setLastAction(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.ok) {
        await onRefresh();
        setLastAction("Done!");
      } else {
        const err = await res.json().catch(() => ({})) as { error?: string };
        setLastAction(`Error: ${err.error ?? res.status}`);
      }
    } catch {
      setLastAction("Network error");
    } finally {
      setBusy(null);
    }
  }

  const isDowned = character.downed_until != null && character.downed_until > Date.now();
  const isFullHp = character.hp >= character.max_hp;
  const isFullMana = character.mana >= character.max_mana;
  const targetLevel = Math.floor(Number(levelAmount));
  const levelValid = Number.isFinite(targetLevel) && targetLevel >= 1 && targetLevel <= 99 && targetLevel !== character.level;

  const devBtn = (bg: string, fg: string, disabled = false): React.CSSProperties => ({
    ...smallActionBtn(disabled ? "#1a1c20" : bg, disabled ? "#4b5563" : fg),
    padding: "6px 14px",
    fontSize: 13,
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? "default" : "pointer",
  });
  const inputStyle: React.CSSProperties = {
    background: "#1a1c20", border: "1px solid #2a2d33", borderRadius: 6,
    color: "#e5e7eb", padding: "5px 10px", fontSize: 13, width: 90,
    fontFamily: "inherit",
  };
  const selectStyle: React.CSSProperties = {
    ...inputStyle, width: "auto", cursor: "pointer",
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000, padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#13151a",
          border: "1px solid #2a2d33",
          borderRadius: 12,
          padding: 24,
          width: "100%",
          maxWidth: 520,
          boxShadow: "0 10px 40px rgba(0,0,0,0.7)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="cog" size={16} color="#a78bfa" />
            <span style={{ fontSize: 16, fontWeight: 700, color: "#a78bfa" }}>Dev Tools</span>
          </div>
          <button onClick={onClose} style={{ ...smallActionBtn("#1a1c20", "#6b7280"), padding: "2px 8px" }}>✕</button>
        </div>

        {/* Status */}
        <div style={{ background: "#1a1c20", borderRadius: 8, padding: "10px 14px", display: "flex", gap: 20, fontSize: 13 }}>
          <span><span style={{ color: "#6b7280" }}>Lv </span><span style={{ color: "#e5e7eb", fontWeight: 600 }}>{character.level}</span></span>
          <span><span style={{ color: "#6b7280" }}>HP </span><span style={{ color: "#f87171", fontWeight: 600 }}>{character.hp}/{character.max_hp}</span></span>
          <span><span style={{ color: "#6b7280" }}>MP </span><span style={{ color: "#60a5fa", fontWeight: 600 }}>{character.mana}/{character.max_mana}</span></span>
          <span><span style={{ color: "#6b7280" }}>Gold </span><span style={{ color: "#fbbf24", fontWeight: 600 }}>{character.gold}g</span></span>
          {isDowned && <span style={{ color: "#fca5a5", fontWeight: 600 }}>DOWNED</span>}
        </div>

        {/* Restore row */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            disabled={!!busy || isFullHp}
            onClick={() => void devAction("/api/dev/heal")}
            style={devBtn("#1f3a1f", "#86efac", isFullHp)}
          >
            {busy === "/api/dev/heal" ? "…" : <><Icon name="health" size={13} /> Heal to full</>}
          </button>
          <button
            disabled={!!busy || isFullMana}
            onClick={() => void devAction("/api/dev/mana")}
            style={devBtn("#1a2a3a", "#60a5fa", isFullMana)}
          >
            {busy === "/api/dev/mana" ? "…" : <><Icon name="crystals" size={13} /> Restore mana</>}
          </button>
          <button
            disabled={!!busy || !isDowned}
            onClick={() => void devAction("/api/dev/revive")}
            style={devBtn("#2a0a0a", "#fca5a5", !isDowned)}
          >
            {busy === "/api/dev/revive" ? "…" : <><Icon name="aura" size={13} /> Revive</>}
          </button>
        </div>

        {/* Gold row */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="number"
            min={1}
            max={1000000}
            value={goldAmount}
            onChange={(e) => setGoldAmount(e.target.value)}
            style={{ ...inputStyle, color: "#fbbf24" }}
          />
          <button
            disabled={!!busy || !Number.isFinite(Number(goldAmount)) || Number(goldAmount) <= 0}
            onClick={() => void devAction("/api/dev/gold", { amount: Number(goldAmount) })}
            style={devBtn("#2a1f0a", "#fbbf24")}
          >
            {busy === "/api/dev/gold" ? "…" : <><Icon name="gold-bar" size={13} /> Give gold</>}
          </button>
        </div>

        {/* Level row */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="number"
            min={1}
            max={99}
            value={levelAmount}
            onChange={(e) => setLevelAmount(e.target.value)}
            style={inputStyle}
          />
          <button
            disabled={!!busy || !levelValid}
            onClick={() => void devAction("/api/dev/level", { level: targetLevel })}
            style={devBtn("#1a1a2e", "#a78bfa", !levelValid)}
            title={targetLevel < character.level ? "Down-leveling resets stat allocation to the class baseline and restores all free points for that level" : undefined}
          >
            {busy === "/api/dev/level" ? "…" : <><Icon name="level-three-advanced" size={13} /> Set level</>}
          </button>
        </div>

        {/* Cooldowns */}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            disabled={!!busy}
            onClick={() => void devAction("/api/dev/cooldowns")}
            style={devBtn("#1a1a2a", "#c4b5fd")}
            title="Resets all time-based cooldowns in the app (e.g. shop, rests)"
          >
            {busy === "/api/dev/cooldowns" ? "…" : <><Icon name="clockwork" size={13} /> Reset cooldowns</>}
          </button>
        </div>

        {/* Give item */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>Give Item</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <select
              value={itemType}
              onChange={(e) => {
                const t = e.target.value;
                setItemType(t);
                setItemSlot(t === "armor" ? "body" : "main_hand");
              }}
              style={selectStyle}
            >
              <option value="weapon">Weapon</option>
              <option value="armor">Armor</option>
              <option value="consumable">Consumable</option>
              <option value="magic">Magic</option>
              <option value="revive">Revive</option>
              <option value="tool">Tool</option>
              <option value="scroll">Scroll</option>
            </select>
            <input
              value={itemName}
              onChange={(e) => setItemName(e.target.value)}
              placeholder="Item name"
              style={{ ...inputStyle, width: 150 }}
            />
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              type="number"
              min={0}
              max={999}
              value={itemPower}
              onChange={(e) => setItemPower(e.target.value)}
              style={inputStyle}
              placeholder="Power"
            />
            <select value={itemRarity} onChange={(e) => setItemRarity(e.target.value)} style={selectStyle}>
              <option value="common">Common</option>
              <option value="uncommon">Uncommon</option>
              <option value="rare">Rare</option>
              <option value="epic">Epic</option>
              <option value="legendary">Legendary</option>
            </select>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {itemType === "weapon" && (
              <select value={itemRange} onChange={(e) => setItemRange(e.target.value)} style={selectStyle}>
                <option value="melee">Melee</option>
                <option value="ranged">Ranged</option>
                <option value="focus">Focus</option>
              </select>
            )}
            {(itemType === "weapon" || itemType === "armor") && (
              <select value={itemSlot} onChange={(e) => setItemSlot(e.target.value)} style={selectStyle}>
                {itemType === "weapon" ? (
                  <>
                    <option value="main_hand">Main hand</option>
                    <option value="off_hand">Off hand</option>
                  </>
                ) : (
                  <>
                    <option value="body">Body</option>
                    <option value="helmet">Helmet</option>
                    <option value="pants">Pants</option>
                    <option value="boots">Boots</option>
                    <option value="ring">Ring</option>
                    <option value="amulet">Amulet</option>
                    <option value="off_hand">Off hand</option>
                  </>
                )}
              </select>
            )}
            {(itemType === "weapon" || itemType === "armor") && (
              <select value={itemElement} onChange={(e) => setItemElement(e.target.value)} style={selectStyle}>
                <option value="">No element</option>
                <option value="fire">Fire</option>
                <option value="ice">Ice</option>
                <option value="lightning">Lightning</option>
              </select>
            )}
          </div>
          {itemType === "armor" && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "#6b7280", minWidth: 60 }}>Stat bonus</span>
              {(["str", "int_stat", "vit", "agi", "dex"] as const).map((stat) => (
                <label key={stat} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                  <span style={{ fontSize: 10, color: "#9ca3af" }}>{stat === "int_stat" ? "int" : stat}</span>
                  <input
                    type="number"
                    min={0}
                    max={20}
                    value={statBonuses[stat]}
                    onChange={(e) => setStatBonuses((prev) => ({ ...prev, [stat]: e.target.value }))}
                    style={{ ...inputStyle, width: 44, padding: "4px 6px", textAlign: "center" }}
                    placeholder="0"
                  />
                </label>
              ))}
            </div>
          )}
          <div>
            <button
              disabled={!!busy || !itemName.trim() || !Number.isFinite(Number(itemPower)) || Number(itemPower) < 0}
              onClick={() => {
                const bonuses: Record<string, number> = {};
                if (itemType === "armor") {
                  for (const [k, v] of Object.entries(statBonuses)) {
                    const n = Math.floor(Number(v));
                    if (Number.isFinite(n) && n > 0) bonuses[k] = n;
                  }
                }
                void devAction("/api/dev/item", {
                  type: itemType,
                  name: itemName.trim(),
                  power: Math.floor(Number(itemPower)),
                  rarity: itemRarity,
                  weapon_range: itemType === "weapon" ? itemRange : undefined,
                  slot: (itemType === "weapon" || itemType === "armor") ? itemSlot : undefined,
                  element: itemElement || undefined,
                  stat_bonus: Object.keys(bonuses).length > 0 ? bonuses : undefined,
                });
              }}
              style={devBtn("#0f1e2e", "#7dd3fc")}
            >
              {busy === "/api/dev/item" ? "…" : <><Icon name="chest" size={13} /> Give item</>}
            </button>
          </div>
        </div>

        {lastAction && (
          <div style={{ fontSize: 12, color: lastAction.startsWith("Error") ? "#fca5a5" : "#86efac", textAlign: "center" }}>
            {lastAction}
          </div>
        )}
      </div>
    </div>
  );
}
