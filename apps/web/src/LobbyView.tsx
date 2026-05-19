import { useEffect, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";

interface ChatMessage {
  id: number;
  user_id: string;
  user_name: string;
  message: string;
  created_at: number;
}

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
  activeQuestId,
  onQuestStarted,
}: {
  selfId: string;
  activeQuestId?: number | null;
  onQuestStarted: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [quest, setQuest] = useState<LobbyQuestData | null>(null);
  const [party, setParty] = useState<LobbyMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [inviting, setInviting] = useState<string | null>(null);

  // Chat state
  const questId = quest?.id ?? activeQuestId ?? null;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [sending, setSending] = useState(false);
  const lastMessageAt = useRef(0);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

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

  // Poll for new chat messages every 3 seconds
  useEffect(() => {
    if (!questId) return;
    const pollChat = async () => {
      const res = await fetch(`/api/quest/${questId}/chat?since=${lastMessageAt.current}`, { credentials: "include" });
      if (!res.ok) return;
      const body = (await res.json()) as { messages?: ChatMessage[] };
      const incoming = body.messages ?? [];
      if (incoming.length > 0) {
        lastMessageAt.current = incoming[incoming.length - 1].created_at;
        setMessages((prev) => [...prev, ...incoming]);
      }
    };
    void pollChat();
    const t = setInterval(() => void pollChat(), 3000);
    return () => clearInterval(t);
  }, [questId]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendMessage() {
    if (!questId || !chatInput.trim() || sending) return;
    setSending(true);
    const text = chatInput.trim();
    setChatInput("");
    try {
      await fetch(`/api/quest/${questId}/chat`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
    } finally {
      setSending(false);
    }
  }

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
  const hasPending = party.some((m) => m.invite_status === "pending");
  const allReady = !hasPending && accepted.length > 0 && accepted.every((m) => m.ready);

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

  const pendingCount = party.filter((m) => m.invite_status === "pending").length;

  // Floating tab always visible so user can reopen the drawer
  const tab = (
    <button
      onClick={() => setOpen((o) => !o)}
      style={{
        position: "fixed",
        right: open ? 380 : 0,
        top: "50%",
        transform: "translateY(-50%)",
        zIndex: 1001,
        background: "#2563eb",
        color: "#fff",
        border: "none",
        borderRadius: open ? "6px 0 0 6px" : "6px 0 0 6px",
        padding: "12px 8px",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.5,
        boxShadow: "-2px 0 12px rgba(0,0,0,0.4)",
        transition: "right 0.25s ease",
      }}
    >
      <Icon name="conversation" size={16} color="#fff" />
      <span style={{ writingMode: "vertical-rl", textOrientation: "mixed", transform: "rotate(180deg)" }}>
        LOBBY
      </span>
      {pendingCount > 0 && (
        <span style={{
          background: "#f59e0b", color: "#000", borderRadius: "50%",
          width: 16, height: 16, fontSize: 10, fontWeight: 700,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {pendingCount}
        </span>
      )}
    </button>
  );

  if (loading) {
    return typeof document !== "undefined" ? createPortal(tab, document.body) : null;
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

  const drawerContent = (
    <>
      {tab}
      {/* Backdrop — closes drawer when clicking outside */}
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 999,
            background: "rgba(0,0,0,0.35)",
          }}
        />
      )}
      {/* Drawer panel */}
      <div
        style={{
          position: "fixed",
          top: 0,
          right: open ? 0 : -400,
          width: 380,
          height: "100vh",
          zIndex: 1000,
          background: "#0e1117",
          borderLeft: "2px solid #2563eb",
          boxShadow: "-4px 0 32px rgba(0,0,0,0.6)",
          transition: "right 0.25s ease",
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
        }}
      >
        <div style={{ padding: 20, flex: 1 }}>
    <div
      style={{
        background: "transparent",
        border: "none",
        borderRadius: 0,
        padding: 0,
        maxWidth: "100%",
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
              color: hasPending ? "#f59e0b" : "#22c55e",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {hasPending
              ? <><Icon name="conversation" size={13} color="#f59e0b" /> Waiting for pending invites — or Force Start to skip them</>
              : <><Icon name="trophy" size={13} color="#22c55e" /> You're ready — waiting for others…</>
            }
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
      </div>{/* action buttons */}
    </div>{/* inner content div */}

      {/* Party Chat */}
      {questId && (
        <div style={{
          borderTop: "1px solid #1f2937",
          display: "flex",
          flexDirection: "column",
          marginTop: 16,
          paddingTop: 12,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, color: "#4b5563", marginBottom: 8, paddingLeft: 2 }}>
            Party Chat
          </div>
          {/* Message list */}
          <div style={{
            height: 180,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            marginBottom: 8,
            paddingRight: 2,
          }}>
            {messages.length === 0 ? (
              <div style={{ color: "#4b5563", fontSize: 12, fontStyle: "italic", paddingLeft: 2 }}>
                No messages yet. Say hello!
              </div>
            ) : (
              messages.map((m) => (
                <div key={m.id} style={{ fontSize: 13, lineHeight: 1.4 }}>
                  <span style={{
                    fontWeight: 700,
                    color: m.user_id === selfId ? "#60a5fa" : "#a78bfa",
                    marginRight: 6,
                  }}>
                    {m.user_id === selfId ? "You" : m.user_name}
                  </span>
                  <span style={{ color: "#d1d5db" }}>{m.message}</span>
                </div>
              ))
            )}
            <div ref={chatEndRef} />
          </div>
          {/* Input */}
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void sendMessage(); }}
              placeholder="Type a message…"
              maxLength={300}
              style={{
                flex: 1,
                background: "#13161c",
                border: "1px solid #1f2937",
                borderRadius: 6,
                color: "#f5f5f5",
                fontSize: 13,
                padding: "7px 10px",
                outline: "none",
              }}
            />
            <button
              disabled={sending || !chatInput.trim()}
              onClick={() => void sendMessage()}
              style={{
                padding: "7px 12px",
                borderRadius: 6,
                border: "none",
                background: sending || !chatInput.trim() ? "#1f2937" : "#2563eb",
                color: sending || !chatInput.trim() ? "#4b5563" : "#fff",
                fontSize: 13,
                fontWeight: 600,
                cursor: sending || !chatInput.trim() ? "not-allowed" : "pointer",
              }}
            >
              Send
            </button>
          </div>
        </div>
      )}

        </div>{/* padding wrapper */}
      </div>{/* drawer panel */}
    </>
  );

  return typeof document !== "undefined" ? createPortal(drawerContent, document.body) : null;
}
