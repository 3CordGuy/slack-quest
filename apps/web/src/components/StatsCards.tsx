import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "../icons";
import { formatDuration, formatRelative } from "../utils";
import { VARIANT_LABEL } from "../constants";
import { card, h2, muted, DISPLAY_FONT } from "../styles";
import { SmallBadge } from "./ui";
import type { QuestStats, QuestLeaderboardEntry, TowerLeaderboardEntry, RecentQuest } from "../types";

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

/* ─── Hall of Renown shared scaffolding ─────────────────────────────── */

export type RenownEntry = {
  id: string;
  name: string;
  subtitle: string;        // e.g. "Mage · L7" or just "L7 Mage"
  metric: ReactNode;        // big metric value (already formatted)
  metricLabel: string;     // e.g. "Renown"
  iconName: string;        // small icon for list rows / podium
  isSelf?: boolean;
};

type Period = "week" | "season" | "all";

const MEDAL_COLORS: Record<1 | 2 | 3, string> = {
  1: "var(--accent-gold)",
  2: "var(--rarity-common)",      // silver-ish
  3: "var(--accent-gold-dark)",   // bronze
};

function useIsMobile(breakpoint = 640) {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia(`(max-width: ${breakpoint}px)`).matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    if (mq.addEventListener) mq.addEventListener("change", handler);
    else mq.addListener(handler);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", handler);
      else mq.removeListener(handler);
    };
  }, [breakpoint]);
  return isMobile;
}

function PeriodToggle({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const opts: { id: Period; label: string; soon: boolean }[] = [
    { id: "week", label: "Week", soon: true },
    { id: "season", label: "Season", soon: false },
    { id: "all", label: "All-Time", soon: true },
  ];
  return (
    <div
      role="tablist"
      style={{
        display: "inline-flex",
        gap: 2,
        padding: 2,
        background: "var(--bg-card-2)",
        border: "1px solid var(--border-faint)",
        borderRadius: "var(--radius-lg)",
      }}
    >
      {opts.map((o) => {
        const active = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.id)}
            title={o.soon ? "Coming soon" : undefined}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              letterSpacing: 0.4,
              textTransform: "uppercase",
              padding: "4px 10px",
              borderRadius: 6,
              border: "1px solid",
              borderColor: active ? "var(--border-faint)" : "transparent",
              background: active ? "var(--bg-panel)" : "transparent",
              color: active ? "var(--fg-1)" : "var(--fg-mute)",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function PodiumCard({
  entry,
  rank,
  emphasized,
  iconName,
  metricLabel,
  isMobile,
}: {
  entry: RenownEntry;
  rank: 1 | 2 | 3;
  emphasized: boolean;
  iconName: string;
  metricLabel: string;
  isMobile: boolean;
}) {
  const medalColor = MEDAL_COLORS[rank];
  const borderColor = rank === 1 ? "var(--accent-gold)" : "var(--border-faint)";
  const selfBorder = entry.isSelf ? "var(--accent-ink-blue-2)" : borderColor;
  const bg = entry.isSelf ? "var(--accent-ink-deep)" : "var(--bg-panel)";
  const discSize = emphasized && !isMobile ? 64 : 52;
  const nameSize = emphasized && !isMobile ? 17 : 15;
  const metricSize = emphasized && !isMobile ? 30 : 24;

  return (
    <div
      style={{
        background: bg,
        border: `1px solid ${selfBorder}`,
        borderRadius: "var(--radius-xl)",
        padding: emphasized && !isMobile ? "18px 14px" : "14px 12px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        gap: 6,
        position: "relative",
        boxShadow: rank === 1 ? "0 0 0 1px var(--accent-gold) inset, 0 4px 18px -8px rgba(251,191,36,0.35)" : undefined,
        transform: !isMobile && emphasized ? "translateY(-6px)" : undefined,
      }}
    >
      {/* Medal */}
      <div
        style={{
          position: "absolute",
          top: 8,
          right: 10,
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          fontWeight: 700,
          color: medalColor,
          letterSpacing: 0.5,
        }}
      >
        #{rank}
      </div>
      {/* Avatar disc */}
      <div
        style={{
          width: discSize,
          height: discSize,
          borderRadius: "50%",
          background: "var(--bg-card-2)",
          border: `2px solid ${medalColor}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginTop: 4,
        }}
      >
        <Icon name={iconName} size={Math.round(discSize * 0.55)} color={medalColor} />
      </div>
      {/* Name */}
      <div
        style={{
          fontFamily: DISPLAY_FONT,
          fontSize: nameSize,
          color: entry.isSelf ? "var(--accent-ink-blue-2)" : "var(--fg-1)",
          lineHeight: 1.15,
          marginTop: 2,
          maxWidth: "100%",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {entry.name}
        {entry.isSelf && (
          <span style={{ ...muted, fontFamily: "var(--font-mono)", fontSize: 10, marginLeft: 6 }}>(you)</span>
        )}
      </div>
      {/* Class · Level (mono) */}
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          color: "var(--accent-arcane-2)",
        }}
      >
        {entry.subtitle}
      </div>
      {/* Metric */}
      <div style={{ marginTop: 4 }}>
        <div
          style={{
            fontFamily: DISPLAY_FONT,
            fontSize: metricSize,
            color: "var(--accent-gold)",
            lineHeight: 1,
          }}
        >
          {entry.metric}
        </div>
        <div
          style={{
            ...muted,
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            marginTop: 2,
          }}
        >
          {metricLabel}
        </div>
      </div>
    </div>
  );
}

function FieldRow({
  entry,
  rank,
  iconName,
}: {
  entry: RenownEntry;
  rank: number;
  iconName: string;
}) {
  const [hover, setHover] = useState(false);
  const baseBg = entry.isSelf ? "var(--accent-ink-deep)" : "transparent";
  const hoverBg = entry.isSelf ? "var(--accent-ink-deep)" : "var(--bg-card-2)";
  const borderColor = entry.isSelf ? "var(--accent-ink-blue-2)" : "var(--border-faint)";

  const rowStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "32px 28px 1fr auto",
    alignItems: "center",
    gap: 10,
    padding: "8px 10px",
    borderRadius: "var(--radius-lg)",
    border: `1px solid ${entry.isSelf ? borderColor : "transparent"}`,
    background: hover ? hoverBg : baseBg,
    transition: "background 120ms ease",
  };

  return (
    <div
      style={rowStyle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: "var(--fg-mute)",
          textAlign: "right",
        }}
      >
        #{rank}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Icon name={iconName} size={18} color={entry.isSelf ? "var(--accent-ink-blue-2)" : "var(--fg-mute)"} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontFamily: DISPLAY_FONT,
            fontSize: 14,
            color: entry.isSelf ? "var(--accent-ink-blue-2)" : "var(--fg-1)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {entry.name}
          {entry.isSelf && (
            <span style={{ ...muted, fontFamily: "var(--font-mono)", fontSize: 10, marginLeft: 6 }}>(you)</span>
          )}
        </div>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            letterSpacing: 0.3,
            textTransform: "uppercase",
            color: "var(--accent-arcane-2)",
          }}
        >
          {entry.subtitle}
        </div>
      </div>
      <div
        style={{
          fontFamily: DISPLAY_FONT,
          fontSize: 16,
          color: "var(--accent-gold)",
          textAlign: "right",
          whiteSpace: "nowrap",
        }}
      >
        {entry.metric}
      </div>
    </div>
  );
}

function HallOfRenown({
  title,
  entries,
  metricLabel,
  rowIcon,
  footerNote,
}: {
  title: string;
  entries: RenownEntry[];
  metricLabel: string;
  rowIcon: string;
  footerNote?: string;
}) {
  const [period, setPeriod] = useState<Period>("season");
  const isMobile = useIsMobile();

  const top3 = entries.slice(0, 3);
  const rest = entries.slice(3);

  // Podium order on desktop: 2nd, 1st, 3rd (1st in center).
  const podiumOrder: Array<{ entry: RenownEntry; rank: 1 | 2 | 3 }> = [];
  if (top3[1]) podiumOrder.push({ entry: top3[1], rank: 2 });
  if (top3[0]) podiumOrder.push({ entry: top3[0], rank: 1 });
  if (top3[2]) podiumOrder.push({ entry: top3[2], rank: 3 });

  // Mobile: 1st, 2nd, 3rd (stacked).
  const mobilePodium: Array<{ entry: RenownEntry; rank: 1 | 2 | 3 }> = [];
  if (top3[0]) mobilePodium.push({ entry: top3[0], rank: 1 });
  if (top3[1]) mobilePodium.push({ entry: top3[1], rank: 2 });
  if (top3[2]) mobilePodium.push({ entry: top3[2], rank: 3 });

  const podiumList = isMobile ? mobilePodium : podiumOrder;

  return (
    <div style={card}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <h2 style={{ ...h2, display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
          <Icon name="trophy" size={20} color="var(--accent-gold)" />
          {title}
        </h2>
        <PeriodToggle value={period} onChange={setPeriod} />
      </div>

      {/* Podium */}
      {podiumList.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: isMobile ? "1fr" : "1fr 1.15fr 1fr",
            alignItems: "end",
            gap: 12,
            marginBottom: rest.length > 0 ? 20 : 4,
          }}
        >
          {podiumList.map(({ entry, rank }) => (
            <PodiumCard
              key={entry.id}
              entry={entry}
              rank={rank}
              emphasized={rank === 1}
              iconName={rowIcon}
              metricLabel={metricLabel}
              isMobile={isMobile}
            />
          ))}
        </div>
      )}

      {/* Rest of the field */}
      {rest.length > 0 && (
        <>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              letterSpacing: 1.2,
              textTransform: "uppercase",
              color: "var(--fg-mute)",
              marginBottom: 8,
              marginTop: 4,
            }}
          >
            The Rest of the Field
          </div>
          <div style={{ display: "grid", gap: 4 }}>
            {rest.map((e, i) => (
              <FieldRow key={e.id} entry={e} rank={i + 4} iconName={rowIcon} />
            ))}
          </div>
        </>
      )}

      {footerNote && (
        <p style={{ ...muted, fontSize: 11, marginTop: 12, marginBottom: 0 }}>{footerNote}</p>
      )}
    </div>
  );
}

/* ─── Quest leaderboard ─────────────────────────────────────────────── */

function QuestLeaderboardCard({ entries, selfId }: { entries: QuestLeaderboardEntry[]; selfId: string }) {
  const renown: RenownEntry[] = entries.map((e) => ({
    id: e.slack_user_id,
    name: e.name,
    subtitle: `${e.class} · L${e.level}`,
    metric: e.wins,
    metricLabel: "Renown",
    iconName: "trophy",
    isSelf: e.slack_user_id === selfId,
  }));
  return (
    <HallOfRenown
      title="Hall of Renown"
      entries={renown}
      metricLabel="Renown"
      rowIcon="crowned-heart"
    />
  );
}

/* ─── Tower leaderboard ─────────────────────────────────────────────── */

function TowerLeaderboardCard({ entries, selfId }: { entries: TowerLeaderboardEntry[]; selfId: string }) {
  const renown: RenownEntry[] = entries.map((e) => ({
    id: e.slack_user_id,
    name: e.name,
    subtitle: e.class,
    metric: `F${e.tower_best_floor}`,
    metricLabel: "Best Floor",
    iconName: "tower-flag",
    isSelf: e.slack_user_id === selfId,
  }));
  return (
    <HallOfRenown
      title="Tower Champions"
      entries={renown}
      metricLabel="Best Floor"
      rowIcon="tower-flag"
      footerNote="Highest floor reached · ties broken by total tower kills."
    />
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

export { QuestStatsCard, QuestLeaderboardCard, TowerLeaderboardCard, RecentQuestsCard, RecentQuestRow, HallOfRenown };
