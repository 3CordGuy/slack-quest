// Expedition leaderboards — five categories mounted under Town > Leaderboards.
// Each category is a self-contained card with its own fetch, list rendering,
// and metric formatting. We reuse Avatar + classPortraitUrl so portraits look
// the same as everywhere else in the app.

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Avatar, Icon } from "../icons";
import { classPortraitUrl } from "../CombatShared";
import { card, h2, muted } from "../styles";
import type {
  ExpeditionFastestClearEntry,
  ExpeditionMostClearedEntry,
  ExpeditionStreakEntry,
  ExpeditionNodesEntry,
  ExpeditionEliteEntry,
} from "../types";

type Tab =
  | "fastest-clear"
  | "most-cleared"
  | "streak"
  | "nodes"
  | "elite";

interface TabSpec {
  id: Tab;
  label: string;
  icon: string;
  blurb: string;
}

const TABS: TabSpec[] = [
  { id: "fastest-clear", label: "Fastest Clear", icon: "stopwatch",     blurb: "Shortest start-to-finish on a completed expedition." },
  { id: "most-cleared",  label: "Most Cleared",  icon: "trophy",        blurb: "Total completed expeditions credited to each delver." },
  { id: "streak",        label: "Streak",        icon: "crowned-heart", blurb: "Consecutive completed expeditions with no failed or abandoned run between them." },
  { id: "nodes",         label: "Nodes Resolved", icon: "footprint",    blurb: "Lifetime nodes resolved across every expedition you joined." },
  { id: "elite",         label: "Elite Slayer",  icon: "death-skull",   blurb: "Completed expeditions that included at least one elite-node victory." },
];

/* Shared row props used by all five category renderers below. */
interface RowMeta {
  rank: number;
  slack_user_id: string;
  name: string;
  className: string;
  level: number;
  metric: ReactNode;
  metricLabel: string;
  isSelf: boolean;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function rankBadgeColor(rank: number): string {
  if (rank === 1) return "var(--accent-gold)";
  if (rank === 2) return "var(--rarity-common)";
  if (rank === 3) return "var(--accent-gold-dark)";
  return "var(--fg-mute)";
}

function LeaderRow({ row }: { row: RowMeta }) {
  const portrait = classPortraitUrl(row.className);
  const rowStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "32px 44px minmax(0, 1fr) auto",
    alignItems: "center",
    gap: 10,
    padding: "8px 10px",
    border: row.isSelf
      ? "1px solid var(--accent-gold)"
      : "1px solid var(--border-base)",
    borderRadius: "var(--radius-md)",
    background: row.isSelf
      ? "rgba(251,191,36,0.06)"
      : "var(--bg-panel)",
  };
  return (
    <div style={rowStyle}>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          fontWeight: 700,
          color: rankBadgeColor(row.rank),
          textAlign: "center",
        }}
      >
        {row.rank}
      </div>
      <Avatar
        src={portrait}
        alt={`${row.className} portrait`}
        size={40}
        radius={6}
        fallbackIcon="player"
      />
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            font: "13px/1.1 var(--font-display)",
            color: "var(--fg-1)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {row.name}
          {row.isSelf && (
            <span
              style={{
                marginLeft: 6,
                fontSize: 9,
                color: "var(--accent-gold)",
                textTransform: "uppercase",
                letterSpacing: 1,
              }}
            >
              You
            </span>
          )}
        </div>
        <div
          style={{
            ...muted,
            fontSize: 10,
            marginTop: 2,
            textTransform: "uppercase",
            letterSpacing: 0.6,
          }}
        >
          {row.className} · L{row.level}
        </div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 14,
            color: "var(--fg-1)",
            fontWeight: 700,
            lineHeight: 1,
          }}
        >
          {row.metric}
        </div>
        <div
          style={{
            ...muted,
            fontSize: 9,
            marginTop: 3,
            textTransform: "uppercase",
            letterSpacing: 0.8,
          }}
        >
          {row.metricLabel}
        </div>
      </div>
    </div>
  );
}

function CategoryShell({
  tab,
  rows,
  loading,
  empty,
}: {
  tab: TabSpec;
  rows: RowMeta[];
  loading: boolean;
  empty: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <p style={{ ...muted, fontSize: 12, margin: 0 }}>{tab.blurb}</p>
      {loading && rows.length === 0 ? (
        <div style={{ ...muted, fontSize: 12, padding: 12, textAlign: "center" }}>
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <div style={{ ...muted, fontSize: 12, padding: 12, textAlign: "center" }}>
          {empty}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          {rows.map((r) => (
            <LeaderRow key={`${r.slack_user_id}-${r.rank}`} row={r} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Top-level component ──────────────────────────────────────────────── */

export function ExpeditionLeaderboards({ selfId }: { selfId: string }) {
  const [tab, setTab] = useState<Tab>("fastest-clear");
  const activeTab = TABS.find((t) => t.id === tab) ?? TABS[0];
  return (
    <div style={card}>
      <h2
        style={{
          ...h2,
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: 0,
          marginBottom: 14,
        }}
      >
        <Icon name="trophy" size={20} color="var(--accent-gold)" />
        Expedition Leaderboards
      </h2>

      {/* Tab strip */}
      <div
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          marginBottom: 14,
        }}
      >
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 10px",
                border: active
                  ? "1px solid var(--accent-gold)"
                  : "1px solid var(--border-base)",
                background: active
                  ? "rgba(251,191,36,0.10)"
                  : "var(--bg-panel)",
                color: active ? "var(--fg-1)" : "var(--fg-2)",
                borderRadius: "var(--radius-md)",
                cursor: "pointer",
                font: "600 11px/1 var(--font-body)",
                textTransform: "uppercase",
                letterSpacing: 0.6,
              }}
            >
              <Icon name={t.icon} size={12} color={active ? "var(--accent-gold)" : "var(--fg-mute)"} />
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === "fastest-clear" && (
        <FastestClearCategory tab={activeTab} selfId={selfId} />
      )}
      {tab === "most-cleared" && (
        <MostClearedCategory tab={activeTab} selfId={selfId} />
      )}
      {tab === "streak" && (
        <StreakCategory tab={activeTab} selfId={selfId} />
      )}
      {tab === "nodes" && (
        <NodesCategory tab={activeTab} selfId={selfId} />
      )}
      {tab === "elite" && (
        <EliteCategory tab={activeTab} selfId={selfId} />
      )}
    </div>
  );
}

/* ─── Category fetchers ──────────────────────────────────────────────────
   Each one fetches once on mount and renders RowMeta[]. Kept separate so
   their entry shapes stay type-safe and the metric formatting lives next
   to the fetch. */

function useLeaderboard<T>(path: string): { rows: T[]; loading: boolean } {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(path, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setRows((data as { entries: T[] }).entries ?? []);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);
  return { rows, loading };
}

function FastestClearCategory({ tab, selfId }: { tab: TabSpec; selfId: string }) {
  const { rows, loading } = useLeaderboard<ExpeditionFastestClearEntry>(
    "/api/leaderboard/expedition/fastest-clear",
  );
  const mapped: RowMeta[] = rows.map((e, i) => ({
    rank: i + 1,
    slack_user_id: e.slack_user_id,
    name: e.name,
    className: e.class,
    level: e.level,
    metric: formatDuration(e.duration_ms),
    metricLabel: "Time",
    isSelf: e.slack_user_id === selfId,
  }));
  return (
    <CategoryShell
      tab={tab}
      rows={mapped}
      loading={loading}
      empty="No completed expeditions yet."
    />
  );
}

function MostClearedCategory({ tab, selfId }: { tab: TabSpec; selfId: string }) {
  const { rows, loading } = useLeaderboard<ExpeditionMostClearedEntry>(
    "/api/leaderboard/expedition/most-cleared",
  );
  const mapped: RowMeta[] = rows.map((e, i) => ({
    rank: i + 1,
    slack_user_id: e.slack_user_id,
    name: e.name,
    className: e.class,
    level: e.level,
    metric: e.completed_count.toLocaleString(),
    metricLabel: "Cleared",
    isSelf: e.slack_user_id === selfId,
  }));
  return (
    <CategoryShell
      tab={tab}
      rows={mapped}
      loading={loading}
      empty="No expedition clears recorded yet."
    />
  );
}

function StreakCategory({ tab, selfId }: { tab: TabSpec; selfId: string }) {
  const { rows, loading } = useLeaderboard<ExpeditionStreakEntry>(
    "/api/leaderboard/expedition/streak",
  );
  const mapped: RowMeta[] = rows.map((e, i) => ({
    rank: i + 1,
    slack_user_id: e.slack_user_id,
    name: e.name,
    className: e.class,
    level: e.level,
    metric: (
      <span>
        {e.best_streak}
        <span style={{ ...muted, marginLeft: 4, fontSize: 10 }}>
          (now {e.current_streak})
        </span>
      </span>
    ),
    metricLabel: "Best",
    isSelf: e.slack_user_id === selfId,
  }));
  return (
    <CategoryShell
      tab={tab}
      rows={mapped}
      loading={loading}
      empty="No streaks yet — finish a few back-to-back to break ground here."
    />
  );
}

function NodesCategory({ tab, selfId }: { tab: TabSpec; selfId: string }) {
  const { rows, loading } = useLeaderboard<ExpeditionNodesEntry>(
    "/api/leaderboard/expedition/nodes",
  );
  const mapped: RowMeta[] = rows.map((e, i) => ({
    rank: i + 1,
    slack_user_id: e.slack_user_id,
    name: e.name,
    className: e.class,
    level: e.level,
    metric: e.total_nodes.toLocaleString(),
    metricLabel: "Nodes",
    isSelf: e.slack_user_id === selfId,
  }));
  return (
    <CategoryShell
      tab={tab}
      rows={mapped}
      loading={loading}
      empty="No nodes resolved yet."
    />
  );
}

/* Compact "open me" tile that surfaces the leaderboards modal from the
   main town dashboard. Sits next to the other leaderboard cards so the
   feature is discoverable without crowding the WardMap radial. */
export function ExpeditionLeaderboardsTile({ onOpen }: { onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...card,
        display: "flex",
        alignItems: "center",
        gap: 12,
        cursor: "pointer",
        border: hover
          ? "1px solid var(--accent-gold)"
          : "1px solid var(--border-base)",
        background: hover
          ? "rgba(251,191,36,0.06)"
          : "var(--bg-card)",
        textAlign: "left",
        font: "inherit",
        color: "inherit",
        transition: "border-color 0.15s, background 0.15s",
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 8,
          background: "rgba(251,191,36,0.10)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <Icon name="trophy" size={22} color="var(--accent-gold)" />
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ ...h2, margin: 0, fontSize: 16 }}>Expedition Leaderboards</div>
        <div style={{ ...muted, fontSize: 12, marginTop: 4 }}>
          Fastest clears, biggest streaks, elite slayers.
        </div>
      </div>
      <Icon name="footprint" size={14} color="var(--fg-mute)" />
    </button>
  );
}

function EliteCategory({ tab, selfId }: { tab: TabSpec; selfId: string }) {
  const { rows, loading } = useLeaderboard<ExpeditionEliteEntry>(
    "/api/leaderboard/expedition/elite",
  );
  const mapped: RowMeta[] = rows.map((e, i) => ({
    rank: i + 1,
    slack_user_id: e.slack_user_id,
    name: e.name,
    className: e.class,
    level: e.level,
    metric: e.elite_clears.toLocaleString(),
    metricLabel: "Elite Wins",
    isSelf: e.slack_user_id === selfId,
  }));
  return (
    <CategoryShell
      tab={tab}
      rows={mapped}
      loading={loading}
      empty="No elite clears yet — drop into an expedition and bring one down."
    />
  );
}
