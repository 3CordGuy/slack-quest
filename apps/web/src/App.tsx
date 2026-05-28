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

import { CLASSES, classByName, deriveAll, findCatalogEntry, priceFor, sellPriceFor, xpForLevel, type Achievement, type EarnedAchievement, type StatKey, type Stats } from "@gantt-quest/core";

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
  ITEM_TYPE_ORDER, ITEM_TYPE_LABELS, SLOT_LABELS, SLOT_ICON, DOLL_LAYOUT,
  VARIANT_LABEL, VARIANT_STYLE, ART_PLACEHOLDERS, DEFAULT_ART_PLACEHOLDER,
  LIARS_TRUST_MULT_DISPLAY, LIARS_CHALLENGE_MULT_DISPLAY, GAME_LABELS, HUNT_PACK_LABEL,
  HAGGLE_LABEL, QUEST_OPTIONS, PRIMARY_STAT_META, DISTRICT_CONFIG,
} from "./constants";
import { DISPLAY_FONT, card, h1, h2, muted, input, button, kbd, refreshBtn, smallBadge, smallActionBtn } from "./styles";
import {
  postJson, adventurerSlug, adventurerCharPortrait, adventurerClassPortrait,
  slotLabel, statBonusSummary, itemIcon, itemIconColor, sortItems, groupByType,
  artPlaceholder, drinkBuffLabel, formatDuration, formatRelative, describeItemEffect,
} from "./utils";
import {
  LocationHero, Banner, RarityBadge, SmallBadge,
  RefreshButton, RestockButton, ModalBackdrop, HaggleResultDialog, ConfirmDialog,
} from "./components/ui";
import { PubCard, PubLeaderboardCard, LiarsRollCard, SpdCard } from "./components/Pub";
import { QuestStatsCard, QuestLeaderboardCard, TowerLeaderboardCard, RecentQuestsCard } from "./components/StatsCards";
import { ShopCard, InnCard, SmithyCard, ApothecaryCard } from "./components/Merchants";


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


function StartQuestCard({
  characterLevel,
  onStart,
}: {
  characterLevel: number;
  onStart: (variant: QuestVariant, elite: boolean, invitees: string[]) => void;
}) {
  const [elite, setElite] = useState(false);
  const [selected, setSelected] = useState<QuestVariant | null>(null);
  const [pending, setPending] = useState<QuestVariant | null>(null);
  const [teamMembers, setTeamMembers] = useState<{ slack_user_id: string; name: string; class: string; level: number }[]>([]);
  const [invitees, setInvitees] = useState<Set<string>>(new Set());

  const selectedOption = QUEST_OPTIONS.find((o) => o.id === selected) ?? null;

  useEffect(() => {
    if (!selected) return;
    fetch("/api/characters", { credentials: "include" })
      .then((r) => r.json())
      .then((b) => {
        const body = b as { characters?: { slack_user_id: string; name: string; class: string; level: number }[] };
        setTeamMembers(body.characters ?? []);
      })
      .catch(() => {});
  }, [selected]);

  function toggleInvitee(uid: string) {
    setInvitees((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid); else next.add(uid);
      return next;
    });
  }

  function go() {
    if (!selected || pending) return;
    setPending(selected);
    onStart(selected, elite, [...invitees]);
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

          {/* Party picker */}
          {teamMembers.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
                Invite players (optional)
              </div>
              <div style={{ display: "grid", gap: 5 }}>
                {teamMembers.map((tm) => {
                  const checked = invitees.has(tm.slack_user_id);
                  return (
                    <label
                      key={tm.slack_user_id}
                      style={{
                        display: "flex", alignItems: "center", gap: 10,
                        padding: "7px 10px",
                        background: checked ? "#0f1f3d" : "#0e1117",
                        border: `1px solid ${checked ? "#2563eb" : "#1f2937"}`,
                        borderRadius: 7,
                        cursor: "pointer",
                        fontSize: 13,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleInvitee(tm.slack_user_id)}
                        style={{ accentColor: "#2563eb", flexShrink: 0 }}
                      />
                      <span style={{ fontWeight: 600, color: "#f5f5f5" }}>{tm.name}</span>
                      <span style={{ color: "#6b7280", marginLeft: "auto" }}>Lv{tm.level} {tm.class}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

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
              : invitees.size > 0
                ? <><Icon name="conversation" /> Start Lobby ({invitees.size + 1} players)</>
                : <><Icon name={selectedOption.icon} /> {selectedOption.beginLabel}</>}
          </button>
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
        </div>
      </div>
      <HpBar current={fighter.hp} max={fighter.max_hp} flavor="player" />
      {(fighter.armor_power ?? 0) > 0 && (
        <div style={{ marginTop: 6 }}>
          <ArmorBar current={fighter.shield} max={Math.floor((fighter.armor_power ?? 0) / 2)} />
        </div>
      )}
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

function ArmorBar({ current, max }: { current: number; max: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ ...muted, fontSize: 11, minWidth: 36, color: current === 0 ? "#ef4444" : "#9ca3af" }}>
        {current}/{max} 🛡
      </div>
      <div style={{ flex: 1, height: 6, background: "#0e0f12", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${pct * 100}%`, height: "100%", background: current === 0 ? "#374151" : "#64748b", transition: "width 200ms ease" }} />
      </div>
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
  onLogout,
  onReroll,
  onSpend,
  onSaveNotifyPref,
  onOpenDevTools,
  onRefresh,
}: {
  me: MeResponse;
  inventory: Item[];
  inQuest: boolean;
  onRest: (kind: "short" | "long") => void;
  onLogout: () => void;
  onReroll: (className?: string) => Promise<void>;
  onSpend?: (stat: StatKey) => void;
  onSaveNotifyPref?: (pref: "thread" | "dm") => Promise<void>;
  onOpenDevTools?: () => void;
  onRefresh?: () => Promise<void>;
}) {
  const [slotsOpen, setSlotsOpen] = useState(false);
  const [trophyDefs, setTrophyDefs] = useState<Achievement[]>([]);
  const [trophyEarned, setTrophyEarned] = useState<EarnedAchievement[]>([]);
  const [abilitiesOpen, setAbilitiesOpen] = useState(false);
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
  const shieldArmor = inventory.find((i) => i.equipped && i.slot === "off_hand" && i.item_subtype === "shield");
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
      <AccountPopover onLogout={onLogout} onReroll={onReroll} character={c} onSaveNotifyPref={onSaveNotifyPref} onOpenDevTools={onOpenDevTools} onOpenCharacterSlots={() => setSlotsOpen(true)} />
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
          tooltip={`VIT ${primaryStats.vit}  ·  Level ${c.level}\n16 + 2×${primaryStats.vit} + 2×${c.level} = ${c.max_hp} max HP`}
          value={`${c.hp} / ${c.max_hp}`}
        />
        <Stat
          label="Mana"
          icon={<Icon name="wizard-staff" color="#a78bfa" size={36} />}
          tooltip={`INT ${primaryStats.int_stat}\n2 + floor((INT − 4) / 2) + floor(level / 6) = ${c.max_mana} max mana\nSpent to cast active abilities`}
          value={`${c.mana} / ${c.max_mana}`}
        />
        <Stat
          label="Armor"
          icon={<Icon name="shield" color="#9ca3af" size={36} />}
          tooltip={armorPower > 0
            ? `Armor pool: ${c.shield} / ${Math.floor(armorPower / 2)}\nPhysical hits deplete armor before HP\nRestored on rest or at the smithy\n\nFormula:\n  body (${bodyArmor?.power ?? 0})\n  + helmet/2 (${Math.floor((helmetArmor?.power ?? 0) / 2)})\n  + pants/4 (${Math.floor((pantsArmor?.power ?? 0) / 4)})\n  + shield (${shieldArmor?.power ?? 0})\n  = ${armorPower} armor power\n  ÷ 2 = ${Math.floor(armorPower / 2)} max pool${derivedStats.armor_bonus > 0 ? `\n\n+${derivedStats.armor_bonus} bonus from VIT ${primaryStats.vit}` : ""}`
            : `No armor equipped\nEquip body armor, helmet, pants,\nor a shield to reduce physical damage\n\nFormula:\n  body + helmet/2 + pants/4 + shield\n  = armor power ÷ 2 = max pool`}
          value={armorPower > 0
            ? <span style={{ color: c.shield === 0 ? "#ef4444" : undefined }}>{c.shield} / {Math.floor(armorPower / 2)}</span>
            : <span style={muted}>—</span>}
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
      {/* Abilities section */}
      {(() => {
        const abilities = classByName(c.class)?.abilities ?? [];
        if (abilities.length === 0) return null;
        return (
          <div style={{ marginTop: 12, padding: "10px 12px", background: "#16181c", borderRadius: 8, border: "1px solid #2a2d33" }}>
            <button
              onClick={() => setAbilitiesOpen(o => !o)}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", background: "none", border: "none", cursor: "pointer", padding: 0 }}
            >
              <span style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1.2, fontFamily: DISPLAY_FONT }}>
                Abilities
              </span>
              <span style={{ fontSize: 10, color: "#4a5060", display: "inline-block", transform: abilitiesOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.15s ease" }}>▼</span>
            </button>
            {abilitiesOpen && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                {abilities.map((ab) => (
                  <div key={ab.id} style={{ display: "flex", gap: 8, padding: "7px 8px", background: "#1a1d24", borderRadius: 6, border: "1px solid #2a2d33", alignItems: "flex-start" }}>
                    <div style={{ flexShrink: 0, width: 32, height: 32, background: "#0e0f12", borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 1 }}>
                      {ab.kind === "active"
                        ? <Icon name={ab.icon} size={18} color="#a0aec0" />
                        : <Icon name="abstract-006" size={16} color="#4a5060" />
                      }
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", marginBottom: 3 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: "#e2e8f0", fontFamily: DISPLAY_FONT, lineHeight: 1 }}>{ab.name}</span>
                        <span style={{
                          fontSize: 9, padding: "1px 4px", borderRadius: 3, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", lineHeight: 1.4,
                          background: ab.kind === "active" ? "#1e3a5f" : "#1a2a1a",
                          color: ab.kind === "active" ? "#7dd3fc" : "#86efac",
                        }}>
                          {ab.kind}
                        </span>
                        {ab.kind === "active" && ab.mana_cost > 0 && (
                          <span style={{ fontSize: 9, padding: "1px 4px", borderRadius: 3, background: "#2d1b4e", color: "#c4b5fd", fontWeight: 700, lineHeight: 1.4 }}>
                            {ab.mana_cost} mana
                          </span>
                        )}
                        {ab.kind === "active" && ab.mana_cost === 0 && (
                          <span style={{ fontSize: 9, padding: "1px 4px", borderRadius: 3, background: "#1a2a1a", color: "#4ade80", fontWeight: 700, lineHeight: 1.4 }}>
                            free
                          </span>
                        )}
                        {ab.kind === "active" && (ab.cooldown_turns ?? 0) > 0 && (
                          <span style={{ fontSize: 9, padding: "1px 4px", borderRadius: 3, background: "#2a2010", color: "#fbbf24", fontWeight: 700, lineHeight: 1.4 }}>
                            {ab.cooldown_turns}t CD
                          </span>
                        )}
                        {ab.kind === "passive" && (
                          <span style={{ fontSize: 9, padding: "1px 4px", borderRadius: 3, background: "#1a1a2e", color: "#818cf8", fontWeight: 700, lineHeight: 1.4 }}>
                            {ab.trigger.replace(/_/g, " ")}
                          </span>
                        )}
                      </div>
                      <p style={{ margin: 0, fontSize: 10, color: "#718096", lineHeight: 1.4 }}>{ab.blurb}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}
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
      {slotsOpen && (
        <CharacterSlotsModal
          activeCharacter={c}
          inQuest={inQuest}
          onClose={() => setSlotsOpen(false)}
          onChanged={async () => { if (onRefresh) await onRefresh(); }}
        />
      )}
    </div>
  );
}

function CharacterSlotsModal({
  activeCharacter,
  inQuest,
  onClose,
  onChanged,
}: {
  activeCharacter: { name: string; class: string; level: number; active_slot?: number };
  inQuest: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [view, setView] = useState<SlotsListResponse | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [pickClassFor, setPickClassFor] = useState<number | null>(null);
  const [selectedClass, setSelectedClass] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  async function reload() {
    const res = await fetch("/api/character-slots", { credentials: "include" });
    if (!res.ok) return;
    setView(await res.json() as SlotsListResponse);
  }
  useEffect(() => { void reload(); }, []);

  async function activate(slot: number) {
    setBusy(slot);
    const res = await fetch(`/api/character-slots/${slot}/activate`, { method: "POST", credentials: "include" });
    setBusy(null);
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (body.error === "mid_quest") toast.error("Finish your quest before switching.");
      else toast.error("Switch failed.");
      return;
    }
    toast.success("Character switched.");
    await onChanged();
    onClose();
  }

  async function createInSlot(slot: number, cls: string | null) {
    setBusy(slot);
    const res = await fetch("/api/character-slots/new", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cls ? { slot, class: cls } : { slot }),
    });
    setBusy(null);
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (body.error === "mid_quest") toast.error("Finish your quest before creating a new character.");
      else toast.error("Create failed.");
      return;
    }
    toast.success("New hero rolled!");
    await onChanged();
    onClose();
  }

  async function deleteSlot(slot: number) {
    setBusy(slot);
    const res = await fetch(`/api/character-slots/${slot}`, { method: "DELETE", credentials: "include" });
    setBusy(null);
    setConfirmDelete(null);
    if (!res.ok) { toast.error("Delete failed."); return; }
    toast.success("Slot cleared.");
    await reload();
  }

  // Render 3 slots in order 1..3. For each: active / saved / empty.
  const activeSlot = view?.active_slot ?? activeCharacter.active_slot ?? 1;
  const savedBySlot = new Map<number, SlotsListResponse["saved"][number]>();
  for (const s of view?.saved ?? []) savedBySlot.set(s.slot, s);

  return (
    <ModalBackdrop onCancel={onClose}>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#f5f5f5", marginBottom: 4 }}>Character slots</div>
      <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 16 }}>
        Keep up to three builds. Switching snapshots your active character into its slot.
      </div>
      {inQuest && (
        <div style={{ fontSize: 12, color: "#fca5a5", marginBottom: 12, padding: "6px 10px", background: "#2a1010", borderRadius: 6, border: "1px solid #4a2020" }}>
          You're in a quest — finish or abandon it before switching or creating a character.
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {[1, 2, 3].map((slot) => {
          const isActive = slot === activeSlot;
          const saved = savedBySlot.get(slot);
          const slotBusy = busy === slot;
          return (
            <div
              key={slot}
              style={{
                padding: "10px 12px",
                background: isActive ? "#1a2a1a" : "#16181c",
                borderRadius: 8,
                border: `1px solid ${isActive ? "#3a5a3a" : "#2a2d33"}`,
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <div style={{ fontSize: 11, color: "#6b7280", width: 38, fontWeight: 600 }}>Slot {slot}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                {isActive ? (
                  <>
                    <div style={{ fontSize: 13, color: "#f5f5f5", fontWeight: 600 }}>{activeCharacter.name}</div>
                    <div style={{ fontSize: 11, color: "#86efac" }}>Active • {activeCharacter.class} • Lv {activeCharacter.level}</div>
                  </>
                ) : saved ? (
                  <>
                    <div style={{ fontSize: 13, color: "#f5f5f5", fontWeight: 600 }}>{saved.name}</div>
                    <div style={{ fontSize: 11, color: "#9ca3af" }}>{saved.class} • Lv {saved.level}</div>
                  </>
                ) : (
                  <div style={{ fontSize: 12, color: "#6b7280", fontStyle: "italic" }}>Empty</div>
                )}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {isActive ? (
                  <span style={{ fontSize: 11, color: "#86efac", padding: "4px 8px" }}>Active</span>
                ) : saved ? (
                  <>
                    <button
                      onClick={() => activate(slot)}
                      disabled={inQuest || slotBusy}
                      style={smallActionBtn(inQuest ? "#222428" : "#1a2a1a", inQuest ? "#6b7280" : "#86efac")}
                    >
                      {slotBusy ? "…" : "Activate"}
                    </button>
                    <button
                      onClick={() => setConfirmDelete(slot)}
                      disabled={slotBusy}
                      style={smallActionBtn("#2a0f0f", "#fca5a5")}
                    >
                      Delete
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => { setPickClassFor(slot); setSelectedClass(null); }}
                    disabled={inQuest || slotBusy}
                    style={smallActionBtn(inQuest ? "#222428" : "#1a1c2a", inQuest ? "#6b7280" : "#93c5fd")}
                  >
                    {slotBusy ? "Rolling…" : "Create"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
        <button onClick={onClose} style={smallActionBtn("#222428", "#9ca3af")}>Close</button>
      </div>
      {pickClassFor !== null && (
        <ModalBackdrop onCancel={() => setPickClassFor(null)}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#f5f5f5", marginBottom: 4 }}>Pick a class for slot {pickClassFor}</div>
          <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 12 }}>Leave unselected to roll a random class.</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 12 }}>
            {CLASSES.map((cls) => {
              const on = selectedClass === cls.name;
              return (
                <button
                  key={cls.id}
                  onClick={() => setSelectedClass(on ? null : cls.name)}
                  title={cls.blurb}
                  style={{
                    ...smallActionBtn(on ? "#2a2410" : "#1a1c20", on ? "#fde68a" : "#9ca3af"),
                    fontSize: 11, padding: "5px 8px", textAlign: "left",
                    outline: on ? "1px solid #fde68a44" : "none",
                  }}
                >
                  {cls.name}
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button onClick={() => setPickClassFor(null)} style={smallActionBtn("#222428", "#9ca3af")}>Cancel</button>
            <button
              onClick={() => { const slot = pickClassFor; setPickClassFor(null); void createInSlot(slot, selectedClass); }}
              style={smallActionBtn("#1a2a1a", "#86efac")}
            >
              Roll
            </button>
          </div>
        </ModalBackdrop>
      )}
      {confirmDelete !== null && (
        <ModalBackdrop onCancel={() => setConfirmDelete(null)}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#f5f5f5", marginBottom: 4 }}>Delete slot {confirmDelete}?</div>
          <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 12 }}>
            The saved build will be lost permanently. This doesn't touch your active character.
          </div>
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirmDelete(null)} style={smallActionBtn("#222428", "#9ca3af")}>Cancel</button>
            <button onClick={() => deleteSlot(confirmDelete)} style={smallActionBtn("#2a0f0f", "#fca5a5")}>Delete</button>
          </div>
        </ModalBackdrop>
      )}
    </ModalBackdrop>
  );
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
        const col = EFFECT_COLOR[applies.effect as EffectType];
        const icon = EFFECT_ICON[applies.effect as EffectType];
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
  onOpenDevTools,
  onOpenCharacterSlots,
}: {
  onLogout: () => void;
  onReroll: (className?: string) => Promise<void>;
  character: { name: string; notification_pref?: "thread" | "dm" } | null;
  onSaveNotifyPref?: (pref: "thread" | "dm") => Promise<void>;
  onOpenDevTools?: () => void;
  onOpenCharacterSlots?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [rerollStep, setRerollStep] = useState<"idle" | "pick-class" | "confirm">("idle");
  const [selectedClasses, setSelectedClasses] = useState<Set<string>>(new Set());
  const [selectedClass, setSelectedClass] = useState<string | null>(null);
  const [rerolling, setRerolling] = useState(false);
  const [showNotifyModal, setShowNotifyModal] = useState(false);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: (v) => { setOpen(v); if (!v) { setRerollStep("idle"); setSelectedClasses(new Set()); setSelectedClass(null); } },
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    placement: "top-start",
    whileElementsMounted: autoUpdate,
  });
  const { getFloatingProps } = useInteractions([useDismiss(context)]);

  function rollFromSelection() {
    const pool = Array.from(selectedClasses);
    const picked = pool[Math.floor(Math.random() * pool.length)];
    setSelectedClass(picked);
    setRerollStep("confirm");
  }

  async function confirmReroll() {
    setRerolling(true);
    await onReroll(selectedClass ?? undefined);
    setRerolling(false);
    setOpen(false);
    setRerollStep("idle");
    setSelectedClasses(new Set());
    setSelectedClass(null);
  }

  return (
    <>
      <button
        ref={refs.setReference}
        onClick={() => { setOpen((v) => !v); setRerollStep("idle"); setSelectedClasses(new Set()); setSelectedClass(null); }}
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

              {/* Character slots */}
              {onOpenCharacterSlots && (
                <button
                  onClick={() => { setOpen(false); onOpenCharacterSlots(); }}
                  style={{ ...smallActionBtn("#1a1c20", "#a7f3d0"), textAlign: "left" }}
                >
                  <Icon name="player" size={13} /> Characters
                </button>
              )}

              {/* Dev tools — local env only */}
              {import.meta.env.DEV && onOpenDevTools && (
                <button
                  onClick={() => { setOpen(false); onOpenDevTools(); }}
                  style={{ ...smallActionBtn("#1a1c20", "#a78bfa"), textAlign: "left" }}
                >
                  <Icon name="cog" size={13} /> Dev tools
                </button>
              )}

              {/* Reroll */}
              <div style={{ borderTop: "1px solid #2a2d33", paddingTop: 8, marginTop: 2 }}>
                {rerollStep === "idle" ? (
                  <button
                    onClick={() => setRerollStep("pick-class")}
                    style={{ ...smallActionBtn("#1a1c20", "#fde68a"), width: "100%", textAlign: "left" }}
                  >
                    <Icon name="dice-six-faces-random" size={13} /> Reroll character
                  </button>
                ) : rerollStep === "pick-class" ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <div style={{ fontSize: 12, color: "#f5f5f5", fontWeight: 600 }}>Pick classes to roll from</div>
                      <button
                        onClick={() => setSelectedClasses(selectedClasses.size === CLASSES.length ? new Set() : new Set(CLASSES.map((c) => c.name)))}
                        style={{ ...smallActionBtn("#1a1c20", "#a78bfa"), fontSize: 10, padding: "2px 6px" }}
                      >
                        {selectedClasses.size === CLASSES.length ? "None" : "All"}
                      </button>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                      {CLASSES.map((cls) => {
                        const on = selectedClasses.has(cls.name);
                        return (
                          <button
                            key={cls.id}
                            onClick={() => {
                              const next = new Set(selectedClasses);
                              on ? next.delete(cls.name) : next.add(cls.name);
                              setSelectedClasses(next);
                            }}
                            title={cls.blurb}
                            style={{
                              ...smallActionBtn(on ? "#2a2410" : "#1a1c20", on ? "#fde68a" : "#6b7280"),
                              fontSize: 11, padding: "4px 6px", textAlign: "left",
                              outline: on ? "1px solid #fde68a44" : "none",
                            }}
                          >
                            {cls.name}
                          </button>
                        );
                      })}
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                      <button
                        onClick={rollFromSelection}
                        disabled={selectedClasses.size === 0}
                        style={{ ...smallActionBtn("#1a2a10", "#86efac"), flex: 1 }}
                      >
                        <Icon name="dice-six-faces-random" size={13} /> Roll{selectedClasses.size > 1 ? ` (${selectedClasses.size})` : ""}
                      </button>
                      <button onClick={() => setRerollStep("idle")} style={smallActionBtn("#222428", "#6b7280")}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ fontSize: 12, color: "#f5f5f5", fontWeight: 600 }}>Reroll as {selectedClass}?</div>
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
                      <button onClick={() => { setSelectedClass(null); setRerollStep("pick-class"); }} style={smallActionBtn("#222428", "#6b7280")}>
                        Back
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
  onStartHunt: (tier: number, monsterCount: number, invitees: string[]) => void;
}) {
  const [tier, setTier] = useState(characterLevel);
  const [monsterCount, setMonsterCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [teamMembers, setTeamMembers] = useState<{ slack_user_id: string; name: string; class: string; level: number }[]>([]);
  const [invitees, setInvitees] = useState<Set<string>>(new Set());
  const clampedTier = Math.max(1, Math.min(tier, characterLevel));

  useEffect(() => {
    fetch("/api/characters", { credentials: "include" })
      .then((r) => r.json())
      .then((b) => {
        const body = b as { characters?: { slack_user_id: string; name: string; class: string; level: number }[] };
        setTeamMembers(body.characters ?? []);
      })
      .catch(() => {});
  }, []);

  function toggleInvitee(uid: string) {
    setInvitees((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid); else next.add(uid);
      return next;
    });
  }

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
    try { await onStartHunt(clampedTier, monsterCount, [...invitees]); } finally { setBusy(false); }
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

        {/* Party invite picker */}
        {teamMembers.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, fontWeight: 600 }}>
              Invite players (optional)
            </div>
            <div style={{ display: "grid", gap: 5 }}>
              {teamMembers.map((tm) => {
                const checked = invitees.has(tm.slack_user_id);
                return (
                  <label
                    key={tm.slack_user_id}
                    style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "7px 10px",
                      background: checked ? "#1a0f2e" : "#0e1014",
                      border: `1px solid ${checked ? "#7c3aed" : "#2a2d33"}`,
                      borderRadius: 7, cursor: "pointer", fontSize: 13,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleInvitee(tm.slack_user_id)}
                      style={{ accentColor: "#7c3aed", flexShrink: 0 }}
                    />
                    <span style={{ fontWeight: 600, color: "#f5f5f5" }}>{tm.name}</span>
                    <span style={{ color: "#6b7280", marginLeft: "auto" }}>Lv{tm.level} {tm.class}</span>
                  </label>
                );
              })}
            </div>
          </div>
        )}

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
          {busy ? "Scouting…"
            : invitees.size > 0
              ? `Start Lobby · Tier ${clampedTier} (${invitees.size + 1} players)`
              : `Hunt Tier ${clampedTier}${monsterCount > 1 ? ` · ${HUNT_PACK_LABEL[monsterCount]}` : ""}`}
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
  onStartQuest: (variant: QuestVariant, elite: boolean, invitees: string[]) => void;
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
          <div style={{ width: "100%", height: "100%", background: "#111318", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="perspective-dice-six" size={52} color="#555b6a" style={{ opacity: 0.35 }} />
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
