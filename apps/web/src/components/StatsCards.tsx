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

function TowerLeaderboardCard({ entries, selfId }: { entries: TowerLeaderboardEntry[]; selfId: string }) {
  return (
    <div style={{ ...card, borderColor: "#854d0e" }}>
      <h2 style={{ ...h2, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
        <Icon name="tower-flag" size={22} color="#fbbf24" /> Tower of Ascension
      </h2>
      <p style={{ ...muted, fontSize: 11, marginTop: -4, marginBottom: 10 }}>
        Highest floor reached · ties broken by total tower kills.
      </p>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #2a2d33" }}>
              <th style={{ textAlign: "left", padding: "4px 8px 4px 0", color: "#7a7d83", fontWeight: 500 }}>#</th>
              <th style={{ textAlign: "left", padding: "4px 8px", color: "#7a7d83", fontWeight: 500 }}>Player</th>
              <th style={{ textAlign: "right", padding: "4px 8px", color: "#7a7d83", fontWeight: 500, whiteSpace: "nowrap" }}>Best</th>
              <th style={{ textAlign: "right", padding: "4px 8px", color: "#7a7d83", fontWeight: 500, whiteSpace: "nowrap" }}>Kills</th>
              <th style={{ textAlign: "right", padding: "4px 0 4px 8px", color: "#7a7d83", fontWeight: 500, whiteSpace: "nowrap" }}>Climbed</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => {
              const rank = i + 1;
              const rankColor = rank === 1 ? "#fbbf24" : rank === 2 ? "#d1d5db" : rank === 3 ? "#cd7c2f" : "#7a7d83";
              const isSelf = e.slack_user_id === selfId;
              return (
                <tr key={e.slack_user_id} style={{ borderBottom: "1px solid #1e2025", background: isSelf ? "#1d2128" : "transparent" }}>
                  <td style={{ padding: "6px 8px 6px 0", color: rankColor, fontWeight: rank <= 3 ? 700 : 400 }}>{rank}</td>
                  <td style={{ padding: "6px 8px" }}>
                    <div style={{ fontWeight: isSelf ? 700 : 500, color: isSelf ? "#fbbf24" : "#f5f5f5" }}>
                      {e.name} {isSelf && <span style={{ ...muted, fontSize: 11, fontWeight: 400 }}>(you)</span>}
                    </div>
                    <div style={{ color: "#7a7d83", fontSize: 11 }}>{e.class}</div>
                  </td>
                  <td style={{ padding: "6px 8px", textAlign: "right", color: "#fbbf24", fontWeight: 700 }}>Floor {e.tower_best_floor}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right", color: "#fca5a5", fontWeight: 600 }}>{e.tower_kills}</td>
                  <td style={{ padding: "6px 0 6px 8px", textAlign: "right", color: "#9aa0a6" }}>{e.tower_floors_climbed}</td>
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

export { QuestStatsCard, QuestLeaderboardCard, TowerLeaderboardCard, RecentQuestsCard, RecentQuestRow };
