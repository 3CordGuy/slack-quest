import { useEffect, useState, useCallback } from "react";
import { Icon } from "./icons";

// Types matching what the API returns
interface LobbyMember {
  slack_user_id: string;
  name: string;
  invite_status: "pending" | "accepted" | "declined";
  ready: boolean;
}

interface LobbyQuestData {
  id: number;
  mode: string;
  created_by: string;
  scene: { monster_name?: string; variant?: string; expedition?: { theme: string } | null };
  lobby_expires_at: number | null;
}

interface TeamMember {
  slack_user_id: string;
  name: string;
  class: string;
  level: number;
  hp: number;
  max_hp: number;
}

export function LobbyView({
  selfId,
  onQuestStarted,
}: {
  selfId: string;
  onQuestStarted: () => void;
}) {
  const [quest, setQuest] = useState<LobbyQuestData | null>(null);
  const [party, setParty] = useState<LobbyMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [inviting, setInviting] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/quest/lobby", { credentials: "include" });
    if (!res.ok) return;
    const body = (await res.json()) as { quest: LobbyQuestData | null; party?: LobbyMember[] };
    if (!body.quest) {
      onQuestStarted();
      return;
    }
    setQuest(body.quest);
    setParty(body.party ?? []);
    setLoading(false);
  }, [onQuestStarted]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [refresh]);

  async function loadTeamMembers() {
    const res = await fetch("/api/characters", { credentials: "include" });
    if (!res.ok) return;
    const body = (await res.json()) as { characters?: TeamMember[] };
    setTeamMembers(body.characters ?? []);
  }

  async function openInvite() {
    await loadTeamMembers();
    setShowInvite(true);
  }

  async function invite(targetUserId: string) {
    if (!quest || inviting) return;
    setInviting(targetUserId);
    try {
      await fetch(`/api/quest/${quest.id}/lobby/invite`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_user_id: targetUserId }),
      });
      await refresh();
    } finally {
      setInviting(null);
    }
  }

  async function act(endpoint: string) {
    if (!quest || acting) return;
    setActing(true);
    try {
      const res = await fetch(`/api/quest/${quest.id}/lobby/${endpoint}`, {
        method: "POST",
        credentials: "include",
      });
      const body = (await res.json()) as { ok?: boolean; started?: boolean };
      if (body.started) {
        onQuestStarted();
        return;
      }
      await refresh();
    } finally {
      setActing(false);
    }
  }

  const me = party.find((m) => m.slack_user_id === selfId);
  const isCreator = quest?.created_by === selfId;
  const accepted = party.filter((m) => m.invite_status === "accepted");
  const allReady = accepted.length > 0 && accepted.every((m) => m.ready);

  const expiresIn = quest?.lobby_expires_at
    ? Math.max(0, Math.ceil((quest.lobby_expires_at - Date.now()) / 1000))
    : null;
  const expiresLabel =
    expiresIn !== null
      ? expiresIn > 60
        ? `${Math.ceil(expiresIn / 60)}m`
        : `${expiresIn}s`
      : null;

  const questLabel = quest?.scene.expedition?.theme
    ? `Dungeon — ${quest.scene.expedition.theme}`
    : quest?.scene.variant === "boss"
      ? `Boss — ${quest?.scene.monster_name ?? "?"}`
      : quest?.scene.variant === "gauntlet"
        ? `Gauntlet — ${quest?.scene.monster_name ?? "?"}`
        : (quest?.scene.monster_name ?? "Quest");

  // Which team members are not already in the party
  const partyIds = new Set(party.map((m) => m.slack_user_id));
  const inviteable = teamMembers.filter((m) => !partyIds.has(m.slack_user_id));

  if (loading) {
    return (
      <div style={{ padding: 24, color: "#9ca3af", textAlign: "center" }}>
        Loading lobby…
      </div>
    );
  }
  if (!quest) return null;

  const btnBase: React.CSSProperties = {
    padding: "9px 18px",
    borderRadius: 8,
    border: "none",
    fontWeight: 600,
    fontSize: 14,
    cursor: acting ? "not-allowed" : "pointer",
    opacity: acting ? 0.6 : 1,
    transition: "opacity 0.15s",
  };

  return (
    <div
      style={{
        background: "#0e1117",
        border: "2px solid #2563eb",
        borderRadius: 14,
        padding: 24,
        maxWidth: 480,
        width: "100%",
      }}
    >
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <div
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 1,
            color: "#60a5fa",
            marginBottom: 4,
          }}
        >
          Quest Lobby
        </div>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#f5f5f5" }}>{questLabel}</div>
        {expiresLabel && (
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
            Auto-starts in {expiresLabel}
          </div>
        )}
      </div>

      {/* Party roster */}
      <div style={{ display: "grid", gap: 8, marginBottom: 20 }}>
        {party.map((m) => {
          const statusIcon =
            m.invite_status === "declined" ? (
              <Icon name="plain-dagger" size={13} color="#ef4444" />
            ) : m.invite_status === "pending" ? (
              <Icon name="conversation" size={13} color="#f59e0b" />
            ) : m.ready ? (
              <Icon name="trophy" size={13} color="#22c55e" />
            ) : (
              <Icon name="bed" size={13} color="#9ca3af" />
            );
          const statusLabel =
            m.invite_status === "declined"
              ? "Declined"
              : m.invite_status === "pending"
                ? "Invite pending"
                : m.ready
                  ? "Ready"
                  : "Joined, not ready";
          const isSelf = m.slack_user_id === selfId;
          return (
            <div
              key={m.slack_user_id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 12px",
                background: isSelf ? "#0f1f3d" : "#13161c",
                borderRadius: 8,
                border: isSelf ? "1px solid #2563eb" : "1px solid #1f2937",
              }}
            >
              <span style={{ fontWeight: isSelf ? 700 : 400, color: "#f5f5f5", fontSize: 14 }}>
                {m.name}
                {isSelf && (
                  <span style={{ color: "#60a5fa", fontSize: 12, marginLeft: 6 }}>(you)</span>
                )}
              </span>
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  fontSize: 12,
                  color: "#9ca3af",
                }}
              >
                {statusIcon} {statusLabel}
              </span>
            </div>
          );
        })}
      </div>

      {/* Invite player picker — creator only */}
      {isCreator && showInvite && (
        <div
          style={{
            background: "#13161c",
            border: "1px solid #1f2937",
            borderRadius: 10,
            padding: 14,
            marginBottom: 16,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 10,
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, color: "#9ca3af" }}>
              Invite a player
            </span>
            <button
              onClick={() => setShowInvite(false)}
              style={{
                background: "none",
                border: "none",
                color: "#6b7280",
                cursor: "pointer",
                fontSize: 16,
                lineHeight: 1,
                padding: "0 4px",
              }}
            >
              ×
            </button>
          </div>
          {inviteable.length === 0 ? (
            <div style={{ fontSize: 13, color: "#6b7280" }}>
              All available players are already in the lobby.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 6 }}>
              {inviteable.map((tm) => (
                <div
                  key={tm.slack_user_id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "7px 10px",
                    background: "#0e1117",
                    borderRadius: 7,
                    border: "1px solid #1f2937",
                  }}
                >
                  <div>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#f5f5f5" }}>
                      {tm.name}
                    </span>
                    <span style={{ fontSize: 11, color: "#6b7280", marginLeft: 8 }}>
                      Lv{tm.level} {tm.class}
                    </span>
                  </div>
                  <button
                    disabled={inviting === tm.slack_user_id}
                    onClick={() => void invite(tm.slack_user_id)}
                    style={{
                      padding: "5px 12px",
                      borderRadius: 6,
                      border: "none",
                      background: "#1d4ed8",
                      color: "#fff",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: inviting === tm.slack_user_id ? "not-allowed" : "pointer",
                      opacity: inviting === tm.slack_user_id ? 0.6 : 1,
                    }}
                  >
                    {inviting === tm.slack_user_id ? "…" : "Invite"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {me?.invite_status === "pending" && (
          <>
            <button
              disabled={acting}
              onClick={() => void act("accept")}
              style={{ ...btnBase, background: "#16a34a", color: "#fff" }}
            >
              Accept Invite
            </button>
            <button
              disabled={acting}
              onClick={() => void act("decline")}
              style={{
                ...btnBase,
                background: "#1f2937",
                color: "#9ca3af",
                border: "1px solid #374151",
              }}
            >
              Decline
            </button>
          </>
        )}
        {me?.invite_status === "accepted" && !me.ready && (
          <button
            disabled={acting || allReady}
            onClick={() => void act("ready")}
            style={{ ...btnBase, background: "#2563eb", color: "#fff" }}
          >
            Ready Up
          </button>
        )}
        {me?.invite_status === "accepted" && me.ready && (
          <div
            style={{
              fontSize: 13,
              color: "#22c55e",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Icon name="trophy" size={13} color="#22c55e" /> You're ready — waiting for others…
          </div>
        )}
        {isCreator && !showInvite && (
          <button
            onClick={() => void openInvite()}
            style={{
              ...btnBase,
              background: "#1f2937",
              color: "#9ca3af",
              border: "1px solid #374151",
            }}
          >
            + Invite Player
          </button>
        )}
        {isCreator && (
          <button
            disabled={acting}
            onClick={() => void act("force_start")}
            style={{ ...btnBase, background: "#7c3aed", color: "#fff", marginLeft: "auto" }}
          >
            Force Start
          </button>
        )}
      </div>
    </div>
  );
}
