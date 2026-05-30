import { Component, useEffect, useRef, useState } from "react";
import type { CSSProperties, ErrorInfo, ReactNode } from "react";
import toast from "react-hot-toast";

import { CLASSES, findCatalogEntry, priceFor, sellPriceFor, type Achievement, type StatKey } from "@gantt-quest/core";

import { CombatPage } from "./CombatPage";
import { LobbyView } from "./LobbyView";
import { parseHash, toHash, routesEqual } from "./route";
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
  CampStatusResponse, CampNode, CampTier,
  PubErrandsResponse,
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
  LocationModal, LocationModalWide, AppTopBar, CharacterSlideOver,
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
  AccountPopover,
  Stats, Stat, Stack,
} from "./components/Character";
import { InventoryCard, InventoryFullScreen, DollSlotCell, DroppablePackPanel, DraggablePackItem, DragItemPreview, ItemCell, ItemSlot, ItemDetailPopover } from "./components/Inventory";
import { StartQuestCard, JoinableQuestCard, TownNav, JobPostingCard, StepPicker, HuntSection, JobBoardSection, DistrictTile, TownMap, WardMap } from "./components/Town";
import { Camp } from "./components/Camp";
import { BrewPanel, ForgePanel } from "./components/CampCrafting";
import { PubErrands } from "./components/PubErrands";
import { PubCooking } from "./components/PubCooking";
import { TowerInterlude, ActiveQuestCard, ClickablePortrait } from "./components/Quest";
import { DevToolsModal } from "./components/DevTools";


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

  // Browser back/forward → re-read the hash into state.
  useEffect(() => {
    const onPop = () => {
      const r = parseHash(window.location.hash);
      setTownSectionRaw(r.section);
      setTownSubRaw(r.sub);
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("hashchange", onPop);
    };
  }, []);

  // State → URL. Only pushes when the desired hash differs from the current
  // one, so popstate-driven state updates don't loop back into pushState.
  useEffect(() => {
    const desired = toHash({ section: townSection, sub: townSub });
    const current = window.location.hash || "";
    if (!routesEqual(parseHash(current), parseHash(desired))) {
      window.history.pushState(null, "", desired || window.location.pathname + window.location.search);
    }
  }, [townSection, townSub]);

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
  // URL-routed view state. Hash format: #<slug>[/<sub>] (e.g. #pub/errands).
  // Seeded once from window.location.hash on mount; popstate listener keeps
  // state in sync with browser back/forward.
  const initialRoute = typeof window !== "undefined" ? parseHash(window.location.hash) : { section: null, sub: null };
  const [townSection, setTownSectionRaw] = useState<TownSection | null>(initialRoute.section);
  const [townSub, setTownSubRaw] = useState<string | null>(initialRoute.sub);
  function setTownSection(s: TownSection | null) {
    setTownSectionRaw(s);
    setTownSubRaw(null);
  }
  function setTownSub(s: string | null) {
    setTownSubRaw(s);
  }
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const [characterSheetOpen, setCharacterSheetOpen] = useState(false);
  const [characterSlotsOpen, setCharacterSlotsOpen] = useState(false);
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const isMobile = useMobileViewport();

  // Camp status drives both the My Camp modal and the auto-claim toast that
  // pops when a gathering task finishes while the player is elsewhere. We
  // poll every 30s while authed; the server caps cost (it just returns the
  // task list + lazily-rolled yields). Tasks the player has dismissed
  // locally are tracked in a ref so a refresh doesn't re-trigger the toast.
  const [campStatus, setCampStatus] = useState<CampStatusResponse | null>(null);
  const dismissedReadyTasksRef = useRef<Set<number>>(new Set());
  // Pub errands share the same poll cadence + toast pattern as camp gathering.
  const [pubErrands, setPubErrands] = useState<PubErrandsResponse | null>(null);
  const dismissedErrandsRef = useRef<Set<number>>(new Set());

  async function refreshCampStatus() {
    try {
      const res = await fetch("/api/camp/status", { credentials: "include", cache: "no-store" });
      if (!res.ok) return;
      const body = await res.json() as CampStatusResponse;
      setCampStatus(body);
      // Fire toasts for tasks the user hasn't dismissed yet. Each toast is
      // dismissible; clicking Collect on the strip flips the local ref so
      // we don't re-fire on next poll.
      for (const t of body.active) {
        if (!t.ready) continue;
        if (dismissedReadyTasksRef.current.has(t.id)) continue;
        const nodeLabel = t.node === "mine" ? "Mining" : t.node === "forage" ? "Foraging" : "Fishing";
        const summary = t.yield && t.yield.resources.length > 0
          ? t.yield.resources.map((r) => `${r.qty} × ${r.name}`).join(", ")
          : "ready to collect";
        const nodeIcon = t.node === "mine" ? "ore" : t.node === "forage" ? "grass-mushroom" : "fishing-hook";
        toast(
          (tt) => (
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Icon name={nodeIcon} size={16} color="var(--fg-1)" />
              <span><strong>{nodeLabel} complete</strong> — {summary}</span>
              <button
                onClick={() => { dismissedReadyTasksRef.current.add(t.id); toast.dismiss(tt.id); }}
                style={{ marginLeft: 4, background: "transparent", color: "inherit", border: "none", cursor: "pointer", textDecoration: "underline" }}
              >dismiss</button>
            </span>
          ),
          { id: `gather-${t.id}`, duration: Infinity },
        );
      }
    } catch {
      // Polling errors are silent — next tick retries.
    }
  }

  async function refreshPubErrands() {
    try {
      const res = await fetch("/api/pub/errands", { credentials: "include", cache: "no-store" });
      if (!res.ok) return;
      const body = await res.json() as PubErrandsResponse;
      setPubErrands(body);
      const active = body.active;
      if (active && active.ready && !dismissedErrandsRef.current.has(active.id)) {
        const patron = body.patrons.find((p) => p.id === active.patron_id);
        const name = patron?.name ?? "A patron";
        const yieldData = active.yield;
        const summary = yieldData
          ? [
              yieldData.gold > 0 ? `+${yieldData.gold} gold` : null,
              yieldData.xp > 0 ? `+${yieldData.xp} XP` : null,
              ...yieldData.items.map((it) => it.item_name),
            ].filter(Boolean).join(", ")
          : "ready in the pub";
        toast(
          (tt) => (
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Icon name={patron?.icon ?? "conversation"} size={16} color="var(--fg-1)" />
              <span><strong>{name}</strong> has your reward — {summary}</span>
              <button
                onClick={() => { dismissedErrandsRef.current.add(active.id); toast.dismiss(tt.id); }}
                style={{ marginLeft: 4, background: "transparent", color: "inherit", border: "none", cursor: "pointer", textDecoration: "underline" }}
              >dismiss</button>
            </span>
          ),
          { id: `errand-${active.id}`, duration: Infinity },
        );
      }
    } catch {
      // Polling errors are silent; next tick retries.
    }
  }

  useEffect(() => {
    if (state.kind !== "auth") return;
    void refreshCampStatus();
    void refreshPubErrands();
    const id = setInterval(() => {
      void refreshCampStatus();
      void refreshPubErrands();
    }, 30000);
    return () => clearInterval(id);
  }, [state.kind]);

  // Re-fetch camp status whenever the Camp modal opens so slot counts
  // are always fresh (catches stale data after building a tent).
  useEffect(() => {
    if (state.kind === "auth" && townSection === "camp") {
      void refreshCampStatus();
    }
  }, [townSection, state.kind]);

  async function startPubErrand(offerId: number, inputResourceId?: string) {
    const res = await fetch("/api/pub/errands/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ offer_id: offerId, input_resource_id: inputResourceId }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      toast.error(`Couldn't accept: ${body.error ?? res.statusText}`);
      return;
    }
    toast.success("Errand accepted");
    await Promise.all([refreshPubErrands(), refresh()]);
  }

  async function claimPubErrand(errandId: number) {
    const res = await fetch(`/api/pub/errands/claim/${errandId}`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      toast.error(`Couldn't collect: ${body.error ?? res.statusText}`);
      return;
    }
    const body = await res.json() as {
      yield?: { gold: number; xp: number; items: Array<{ item_name: string }>; lore_fragment?: string };
    };
    const yieldData = body.yield;
    if (yieldData) {
      const parts = [
        yieldData.gold > 0 ? `+${yieldData.gold} gold` : null,
        yieldData.xp > 0 ? `+${yieldData.xp} XP` : null,
        ...yieldData.items.map((it) => it.item_name),
      ].filter(Boolean);
      toast.success(parts.length > 0 ? `Collected — ${parts.join(", ")}` : "Collected");
      if (yieldData.lore_fragment) {
        toast(yieldData.lore_fragment, { id: `lore-${errandId}`, duration: 8000 });
      }
    }
    dismissedErrandsRef.current.add(errandId);
    await Promise.all([refreshPubErrands(), refreshMe(), refresh()]);
  }

  async function cancelPubErrand(errandId: number) {
    const res = await fetch(`/api/pub/errands/cancel/${errandId}`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      toast.error(`Couldn't cancel: ${body.error ?? res.statusText}`);
      return;
    }
    toast.success("Errand cancelled");
    dismissedErrandsRef.current.add(errandId);
    await Promise.all([refreshPubErrands(), refresh()]);
  }

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
            <Icon name="crossed-swords" size={16} color="var(--fg-1)" />
            <span style={{ flex: 1, minWidth: 0 }}>
              <strong>{j.monster_name}</strong> stirs — {j.starter_name ? <><strong>{j.starter_name}</strong> opened</> : "opened"} a {j.variant} quest!
            </span>
            <button
              onClick={() => {
                void joinQuest();
                toast.dismiss(t.id);
              }}
              style={{
                display: "flex", alignItems: "center", gap: 5,
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
              <Icon name="crossed-swords" size={12} color="#fecaca" /> Join fight
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
      const starter = lobby.party.find((m) => m.slack_user_id === lobby.quest.created_by);
      const who = starter?.name ? `${starter.name} ` : "";
      toast(
        () => (
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="shield" size={16} color="var(--fg-1)" />
            <span>{who}invited you to a quest lobby! Open the LOBBY tab →</span>
          </span>
        ),
        { duration: 7000 },
      );
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

  async function saveUsername(username: string) {
    const res = await fetch("/api/settings/username", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string; note?: string };
      throw new Error(body.note ?? body.error ?? "Couldn't save username.");
    }
    toast.success(`Display name set to @${username}`);
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
      if (ok) {
        // Pop the player back to the ward map so the new active-quest banner
        // is immediately visible instead of buried behind the Job Board view.
        setTownSection(null);
        void refresh();
      }
    } else {
      const { ok } = await postJson(`/api/quest/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant, elite }),
      });
      if (ok) {
        setTownSection(null);
        void refresh();
      }
    }
  }

  async function takeJob(jobId: string) {
    const { ok } = await postJson("/api/board/take", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId }),
    });
    if (ok) {
      // Claiming a job creates a new active quest — dismiss the Job Board
      // view so the player sees the new quest banner on the ward map.
      setTownSection(null);
      void refresh();
    }
  }

  async function startHunt(tier: number, monsterCount: number, invitees: string[] = [], isPrivate = false) {
    const { ok } = await postJson("/api/hunt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier, monster_count: monsterCount, invitees, is_private: isPrivate }),
    });
    if (ok) {
      // Close My Camp so the new active-quest banner shows on the ward map.
      setTownSection(null);
      void refresh();
    }
  }

  async function startGather(node: CampNode, tier: CampTier) {
    const res = await fetch("/api/camp/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ node, tier }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      const errMsg =
        body.error === "no_slot"         ? "All tents are busy — collect a finished task first." :
        body.error === "errand_in_flight" ? "Your main character is on a pub errand. Collect it first or use a worker tent slot." :
        body.error === "mid_quest"        ? "Can't gather while in a quest." :
        body.error === "downed"           ? "You're downed — rest at the Inn first." :
        `Couldn't start: ${body.error ?? res.statusText}`;
      toast.error(errMsg);
      await refreshCampStatus(); // sync UI even on failure
      return;
    }
    toast.success("Gathering started");
    await refreshCampStatus();
  }

  async function cancelGather(taskId: number) {
    const res = await fetch(`/api/camp/cancel/${taskId}`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      toast.error(`Couldn't cancel: ${body.error ?? res.statusText}`);
      return;
    }
    toast("Worker recalled.");
    await refreshCampStatus();
  }

  async function claimGather(taskId: number) {
    const res = await fetch(`/api/camp/claim/${taskId}`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      toast.error(`Couldn't collect: ${body.error ?? res.statusText}`);
      return;
    }
    const body = await res.json() as {
      yield?: { resources: Array<{ name: string; qty: number }>; xp: number; gold: number; gold_strike?: boolean };
    };
    const yieldData = body.yield;
    if (yieldData) {
      const resLine = yieldData.resources.map((r) => `${r.qty} × ${r.name}`).join(", ");
      const headline = yieldData.gold_strike
        ? `💰 Struck gold! +${yieldData.gold} gold`
        : resLine
          ? `Collected ${resLine}`
          : "Collected";
      toast.success(headline);
    }
    // Mark this task locally so the polling toast doesn't re-fire on it.
    dismissedReadyTasksRef.current.add(taskId);
    await Promise.all([refreshCampStatus(), refreshMe()]);
    // Refresh inventory in the auth state so the new resources/gold show up.
    void refresh();
  }

  async function buildCampUpgrade(upgradeKey: string) {
    const res = await fetch(`/api/camp/upgrade/${upgradeKey}`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      toast.error(`Couldn't build: ${body.error ?? res.statusText}`);
      return;
    }
    toast.success("Worker tent pitched");
    await Promise.all([refreshCampStatus(), refreshMe()]);
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

  // Build the character sheet JSX once. Rendered inside CharacterSlideOver
  // when the header's character chip is clicked. `hideMenu` suppresses the
  // in-card gear/account popover because the topbar now hosts it.
  const characterSheet = state.kind === "auth" && state.me.character ? (
    <CharacterCard
      me={state.me}
      inventory={state.inventory}
      inQuest={!!state.activeQuest}
      onRest={rest}
      onLogout={logout}
      onReroll={rerollCharacter}
      onSpend={spendStatPoint}
      onSaveNotifyPref={saveNotifyPref}
      onSaveUsername={saveUsername}
      onOpenDevTools={import.meta.env.DEV ? () => setDevToolsOpen(true) : undefined}
      onRefresh={async () => { await refresh(); await refreshMe(); }}
      hideMenu
    />
  ) : undefined;

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

  // The 6 location-modal targets that overlay the ward map. job_board still
  // switches the top-level view (per design), inventory uses its own
  // fullscreen overlay state.
  const LOCATION_MODAL_KEYS: TownSection[] = [
    "pub", "shop", "inn", "smithy", "apothecary", "hunt", "camp",
  ];
  const modalLoc =
    townSection && LOCATION_MODAL_KEYS.includes(townSection) ? townSection : null;
  const showJobBoardView = townSection === "job_board";

  // Town section main content
  let sectionContent: React.ReactNode = null;
  if (!inQuest) {
    if (showJobBoardView) {
      const townNav = <TownNav active="job_board" onNavigate={setTownSection} />;
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
    } else {
      // Default town view: ward map + dashboard extras below.
      sectionContent = (
        <>
          {state.me.character && (
            <WardMap
              character={state.me.character}
              activeQuest={state.activeQuest ? {
                quest: state.activeQuest.quest,
                hasWebCombat,
              } : null}
              jobsOpen={state.board?.jobs.length ?? 0}
              overviewArtUrl={state.townArt?.overview_art_url ?? null}
              activeTasks={campStatus?.active ?? []}
              onOpenLocation={(loc) => setTownSection(loc)}
              onOpenJobBoard={() => setTownSection("job_board")}
              onOpenInventory={() => setInventoryOpen(true)}
              onResumeCombat={() => {
                if (state.activeQuest) startCombat(state.activeQuest.quest.id);
              }}
            />
          )}
          {state.joinable && (
            <JoinableQuestCard joinable={state.joinable} onJoin={joinQuest} />
          )}
          {state.questStats && state.questStats.total > 0 && (
            <QuestStatsCard stats={state.questStats} />
          )}
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "minmax(0, 1fr)" : "minmax(0, 1fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
              {state.towerLeaderboard.length > 0 && (
                <TowerLeaderboardCard entries={state.towerLeaderboard} selfId={state.me.slack_user_id} />
              )}
              {state.me.character && state.recent.length > 0 && (
                <RecentQuestsCard quests={state.recent} />
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
              <AdventurersCard selfId={state.me.slack_user_id} />
              {state.leaderboard.length > 0 && (
                <QuestLeaderboardCard entries={state.leaderboard} selfId={state.me.slack_user_id} />
              )}
            </div>
          </div>
        </>
      );
    }
  }

  // Location modal overlays. Rendered above the dashboard tree below so
  // they can sit over the dimmed ward map without affecting layout.
  function renderLocationModal(): React.ReactNode {
    if (state.kind !== "auth" || !modalLoc || !state.me.character) return null;
    const close = () => setTownSection(null);
    const gold = state.me.character.gold;
    if (modalLoc === "pub" && state.pub) {
      const pub = state.pub;
      return (
        <LocationModalWide
          icon="beer-stein"
          title="The Pub"
          subtitle="Ale · Whiskey · Mercs"
          gold={gold}
          art={state.townArt?.pub_art_url ?? null}
          onClose={close}
          sections={[
            { id: "drinks",   label: "Drinks",   icon: "beer-stein" },
            { id: "mercs",    label: "Mercs",     icon: "crossed-swords" },
            { id: "cooking",  label: "Cooking",   icon: "fish-cooked" },
            { id: "errands",  label: "Errands",   icon: "conversation" },
            { id: "games",    label: "Games",     icon: "perspective-dice-six" },
            { id: "scores",   label: "Scores",    icon: "trophy" },
          ]}
          defaultSection="drinks"
          section={townSub ?? "drinks"}
          onSectionChange={setTownSub}
        >
          {(section) => (
            <>
              {section === "drinks" && (
                <PubCard pub={pub} inModal section="drinks"
                  onBuyDrink={buyDrink} onHireMerc={hireMerc}
                  onDismissMerc={dismissMerc} onRefresh={refreshPub} />
              )}
              {section === "mercs" && (
                <PubCard pub={pub} inModal section="mercs"
                  onBuyDrink={buyDrink} onHireMerc={hireMerc}
                  onDismissMerc={dismissMerc} onRefresh={refreshPub} />
              )}
              {section === "cooking" && (
                <PubCooking
                  characterLevel={state.me.character!.level}
                  gold={state.me.character!.gold}
                  inventory={state.inventory}
                  onAfterCook={async () => { await refresh(); }}
                />
              )}
              {section === "errands" && (
                <PubErrands
                  data={pubErrands}
                  inventory={state.inventory}
                  onStart={startPubErrand}
                  onClaim={claimPubErrand}
                  onCancel={cancelPubErrand}
                />
              )}
              {section === "games" && (
                <>
                  <LiarsRollCard gold={pub.gold} onRefresh={refreshPub} />
                  <SpdCard pub={pub} selfId={state.me.slack_user_id} onRefresh={refreshPub} />
                </>
              )}
              {section === "scores" && pub.leaderboard && pub.leaderboard.length > 0 && (
                <PubLeaderboardCard entries={pub.leaderboard} />
              )}
              {section === "scores" && (!pub.leaderboard || pub.leaderboard.length === 0) && (
                <p style={{ color: "var(--fg-mute)", fontStyle: "italic" }}>No scores yet — play some games.</p>
              )}
            </>
          )}
        </LocationModalWide>
      );
    }
    if (modalLoc === "shop" && state.shop) {
      return (
        <LocationModal
          icon="cash"
          title="The Shop"
          subtitle="Rotating wares"
          gold={gold}
          art={state.shop.art_url ?? state.townArt?.shop_art_url ?? null}
          onClose={close}
          maxWidth={1000}
        >
          <ShopCard
            shop={state.shop}
            inModal
            onBuy={shopBuy}
            onHaggle={shopHaggle}
            onBuyStaple={shopBuyStaple}
            onRefresh={refreshShop}
            onRestock={restockShop}
          />
        </LocationModal>
      );
    }
    if (modalLoc === "inn" && state.inn) {
      return (
        <LocationModal
          icon="bed"
          title="The Inn"
          subtitle="Pick your room"
          gold={gold}
          art={state.inn.art_url ?? state.townArt?.inn_art_url ?? null}
          onClose={close}
          maxWidth={900}
        >
          <InnCard inn={state.inn} inModal onStay={innStay} />
        </LocationModal>
      );
    }
    if (modalLoc === "smithy" && state.smithy) {
      return (
        <LocationModalWide
          icon="anvil"
          title="The Smithy"
          subtitle="Sharpen & repair"
          gold={gold}
          art={state.townArt?.smithy_art_url ?? null}
          onClose={close}
          sections={[
            { id: "equipment", label: "Equipment", icon: "sword" },
            { id: "forge",     label: "Forge",     icon: "forging" },
          ]}
          defaultSection="equipment"
          section={townSub ?? "equipment"}
          onSectionChange={setTownSub}
        >
          {(section) => (
            <>
              {section === "equipment" && (
                <SmithyCard
                  smithy={state.smithy!}
                  inModal
                  characterLevel={state.me.character!.level}
                  onSharpen={smithySharpen}
                  onRepair={smithyRepair}
                  onBuy={smithyBuy}
                />
              )}
              {section === "forge" && (
                <ForgePanel
                  characterLevel={state.me.character!.level}
                  gold={state.me.character!.gold}
                  inventory={state.inventory}
                  onAfterAction={async () => { await refresh(); }}
                />
              )}
            </>
          )}
        </LocationModalWide>
      );
    }
    if (modalLoc === "apothecary") {
      return (
        <LocationModalWide
          icon="poison-bottle"
          title="Apothecary"
          subtitle="Potions & vials"
          gold={gold}
          art={state.townArt?.apothecary_art_url ?? null}
          onClose={close}
          sections={[
            { id: "potions", label: "Potions", icon: "potion" },
            { id: "brew",    label: "Brew",    icon: "bubbling-potion" },
          ]}
          defaultSection="potions"
          section={townSub ?? "potions"}
          onSectionChange={setTownSub}
        >
          {(section) => (
            <>
              {section === "potions" && (
                <ApothecaryCard
                  apothecary={state.apothecary}
                  inModal
                  selfId={state.me.slack_user_id!}
                  onBuyStaple={apothecaryBuyStaple}
                  onRevive={apothecaryRevive}
                  onSelfRevive={apothecarySelfRevive}
                  onRefresh={refreshApothecary}
                />
              )}
              {section === "brew" && (
                <BrewPanel
                  characterLevel={state.me.character!.level}
                  gold={state.me.character!.gold}
                  inventory={state.inventory}
                  onAfterAction={async () => { await refresh(); await refreshApothecary(); }}
                />
              )}
            </>
          )}
        </LocationModalWide>
      );
    }
    if (modalLoc === "hunt") {
      return (
        <LocationModal
          icon="spinning-sword"
          title="Outskirts"
          subtitle="Solo hunts"
          gold={gold}
          art={state.townArt?.outskirts_art_url ?? null}
          onClose={close}
          maxWidth={960}
        >
          <HuntSection
            characterLevel={state.me.character.level}
            overviewArt={state.townArt?.outskirts_art_url ?? null}
            onStartHunt={startHunt}
          />
        </LocationModal>
      );
    }
    if (modalLoc === "camp") {
      const slotsUsed  = campStatus?.slots.in_use  ?? 0;
      const slotsTotal = campStatus?.slots.total ?? 1;
      return (
        <LocationModalWide
          icon="camping-tent"
          title="My Camp"
          subtitle={`${slotsUsed} of ${slotsTotal} ${slotsTotal === 1 ? "tent" : "tents"} in use`}
          gold={gold}
          onClose={close}
          sections={[
            { id: "overview", label: "Overview",  icon: "camping-tent",   art: state.townArt?.camp_overview_art_url ?? null },
            { id: "mine",     label: "Mine",      icon: "ore",            art: state.townArt?.mine_art_url ?? null },
            { id: "forage",   label: "Forage",    icon: "grass-mushroom", art: state.townArt?.forage_art_url ?? null },
            { id: "fish",     label: "Fishing",   icon: "fishing-hook",   art: state.townArt?.fish_art_url ?? null },
            { id: "build",    label: "Build",     icon: "anvil",          art: state.townArt?.camp_build_art_url ?? null },
          ]}
          defaultSection="overview"
          section={townSub ?? "overview"}
          onSectionChange={setTownSub}
        >
          {(activeSection) => (
            <Camp
              characterLevel={state.me.character!.level}
              section={activeSection}
              status={campStatus}
              inventory={state.inventory}
              onStartGather={startGather}
              onClaim={claimGather}
              onCancel={cancelGather}
              onBuildUpgrade={buildCampUpgrade}
            />
          )}
        </LocationModalWide>
      );
    }
    return null;
  }

  // Top bar crumb reflects which dashboard view we're on. Job Board is the
  // only sub-view that swaps the main pane today; everything else (locations,
  // inventory) layers as a modal overlay.
  const crumb = showJobBoardView
    ? "Town · Job Board"
    : modalLoc
      ? `Town · ${modalLoc === "camp" ? "My Camp" : modalLoc === "hunt" ? "Outskirts" : modalLoc[0].toUpperCase() + modalLoc.slice(1)}`
      : "Town · Heylets";

  return (
    <>
      <AppTopBar
        crumb={crumb}
        character={state.me.character}
        onClickCharacter={state.me.character ? () => setCharacterSheetOpen(true) : undefined}
        rightExtras={
          <AccountPopover
            onLogout={logout}
            onReroll={rerollCharacter}
            character={state.me.character}
            onSaveNotifyPref={saveNotifyPref}
            onSaveUsername={saveUsername}
            onOpenDevTools={import.meta.env.DEV ? () => setDevToolsOpen(true) : undefined}
            onOpenCharacterSlots={() => setCharacterSlotsOpen(true)}
            placement="bottom-end"
            buttonStyle={{
              background: "var(--bg-card-2)",
              border: "1px solid var(--border-base)",
              borderRadius: "var(--radius-md)",
              color: "var(--fg-mute)",
              cursor: "pointer",
              padding: "8px 10px",
              lineHeight: 1,
              fontFamily: "inherit",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          />
        }
      />
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
          side={null}
          hideSide
          footer={undefined}
        />
      {renderLocationModal()}
      {characterSheetOpen && characterSheet && (
        <CharacterSlideOver onClose={() => setCharacterSheetOpen(false)}>
          {characterSheet}
        </CharacterSlideOver>
      )}
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
      {characterSlotsOpen && state.kind === "auth" && state.me.character && (
        <CharacterSlotsModal
          activeCharacter={state.me.character}
          inQuest={!!state.activeQuest}
          onClose={() => setCharacterSlotsOpen(false)}
          onChanged={async () => { await refresh(); await refreshMe(); }}
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
    </>
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
      <div
        style={{
          width: "100%",
          maxWidth: 420,
          marginTop: "10vh",
          background: "var(--bg-panel)",
          border: "1px solid var(--border-base)",
          borderRadius: "var(--radius-2xl)",
          boxShadow: "var(--shadow-modal)",
          padding: "32px 28px 28px",
          display: "flex",
          flexDirection: "column",
          gap: 18,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Icon name="tower-flag" size={36} color="var(--accent-gold)" />
          <h1
            style={{
              margin: 0,
              font: "28px/1 var(--font-display)",
              color: "var(--fg-1)",
              letterSpacing: 0.2,
            }}
          >
            Gantt Quest
            <sup style={{ fontSize: 11, color: "var(--accent-gold)", marginLeft: 2 }}>™</sup>
          </h1>
        </div>
        <p
          style={{
            margin: 0,
            font: "12px/1.55 var(--font-mono)",
            color: "var(--fg-mute)",
          }}
        >
          Run{" "}
          <code
            style={{
              font: "12px/1 var(--font-mono)",
              color: "var(--accent-gold)",
              background: "var(--bg-card-2)",
              border: "1px solid var(--border-faint)",
              borderRadius: 4,
              padding: "2px 6px",
            }}
          >
            /gq web-login
          </code>{" "}
          in Slack for a 6-digit code, then paste it below.
        </p>
        <form
          onSubmit={submit}
          style={{ display: "flex", flexDirection: "column", gap: 10 }}
        >
          <input
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="123456"
            autoFocus
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "12px 14px",
              background: "var(--bg-void)",
              border: "1px solid var(--border-base)",
              borderRadius: "var(--radius-md)",
              color: "var(--fg-1)",
              font: "20px/1 var(--font-mono)",
              letterSpacing: "0.4em",
              textAlign: "center",
              outline: "none",
            }}
          />
          <button
            type="submit"
            disabled={pending}
            className="btn btn-primary"
            style={{ width: "100%", justifyContent: "center" }}
          >
            {pending ? "Verifying…" : "Sign in"}
          </button>
          {import.meta.env.DEV && (
            <button
              type="button"
              onClick={dummyDevAuth}
              className="btn btn-ghost"
              style={{ width: "100%", justifyContent: "center" }}
            >
              Dev login
            </button>
          )}
        </form>
        {error && (
          <p
            style={{
              margin: 0,
              font: "12px/1.5 var(--font-mono)",
              color: "var(--tone-bad)",
            }}
          >
            {error}
          </p>
        )}
      </div>
    </Centered>
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
      <div style={{ display: "flex", flexDirection: "column", gap: mobile ? 8 : 16, width: "100%", boxSizing: "border-box", minWidth: 0 }}>
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
        boxSizing: "border-box",
        width: "100%",
        overflowX: "hidden",
        // CSS custom property consumed by `card` const and LocationHero
        ["--card-pad" as string]: mobile ? "16px" : "32px",
      } as React.CSSProperties}
    >
      {children}
    </div>
  );
}

