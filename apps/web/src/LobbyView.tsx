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
  slack_username: string | null;
  level: number;
  invite_status: "pending" | "accepted" | "declined";
  ready: boolean;
}

interface LobbyMonster {
  name: string;
  max_hp: number;
  tier: number;
  is_boss?: boolean;
}

interface LobbyQuestData {
  id: number;
  mode: string;
  created_by: string;
  elite: boolean;
  scene: {
    monster_name?: string;
    variant?: string;
    tier?: number;
    monster_max_hp?: number;
    total_waves?: number;
    monsters?: LobbyMonster[];
    expedition?: { theme: string } | null;
    graph?: { nodes?: unknown[] } | null;
  };
  lobby_expires_at: number | null;
  locked?: boolean;
  // Distinguishes pre-combat (status='lobby') from mid-combat reinforcement
  // (status='active'). Reinforcement skips the auto-start countdown and the
  // ready-up flow is "I'm joining the fight right now".
  status?: "lobby" | "active" | "completed" | "failed";
}

interface TeamMember {
  slack_user_id: string;
  name: string;
  slack_username: string | null;
  class: string;
  level: number;
  hp: number;
  max_hp: number;
}

function EnemyPreview({ quest }: { quest: LobbyQuestData }) {
  const s = quest.scene;
  const isDungeon = s.variant === "dungeon" || !!s.expedition || !!s.graph;
  const isGauntlet = s.variant === "gauntlet";
  const isBoss = s.variant === "boss";
  const tier = s.tier ?? 1;

  const tierColor = tier >= 5 ? "#ef4444" : tier >= 3 ? "#f59e0b" : "#6b7280";
  const eliteLabel = quest.elite ? <span style={{ color: "#f59e0b", fontSize: 11, fontWeight: 700, marginLeft: 6 }}>ELITE</span> : null;

  const rowStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "6px 10px", background: "#13161c", borderRadius: 6,
    border: "1px solid #1f2937", marginBottom: 4,
  };
  const labelStyle: React.CSSProperties = { fontSize: 13, color: "#d1d5db", fontWeight: 600 };
  const statStyle: React.CSSProperties = { fontSize: 12, color: "#9ca3af", display: "flex", gap: 10 };

  if (isDungeon) {
    return (
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1, color: "#4b5563", marginBottom: 6 }}>Dungeon</div>
        <div style={rowStyle}>
          <span style={labelStyle}>
            {s.expedition?.theme ?? "Dungeon Expedition"}{eliteLabel}
          </span>
          <span style={{ ...statStyle }}>
            <span style={{ color: tierColor }}>Tier {tier}</span>
          </span>
        </div>
        <div style={{ fontSize: 12, color: "#6b7280", paddingLeft: 2 }}>Multiple rooms — enemies revealed as you explore.</div>
      </div>
    );
  }

  if (isGauntlet) {
    const waves = s.total_waves ?? 1;
    const monsters: LobbyMonster[] = s.monsters?.length
      ? s.monsters
      : [{ name: s.monster_name ?? "?", max_hp: s.monster_max_hp ?? 0, tier }];
    return (
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1, color: "#4b5563", marginBottom: 6 }}>
          Gauntlet — {waves} wave{waves !== 1 ? "s" : ""}
        </div>
        {monsters.map((m, i) => (
          <div key={i} style={rowStyle}>
            <span style={labelStyle}>{m.name}{eliteLabel}</span>
            <span style={statStyle}>
              <span style={{ color: tierColor }}>Tier {m.tier}</span>
              <span>❤ {m.max_hp} HP</span>
            </span>
          </div>
        ))}
      </div>
    );
  }

  // Standard / boss / bounty pack
  const monsters: LobbyMonster[] = s.monsters?.length
    ? s.monsters
    : [{ name: s.monster_name ?? "?", max_hp: s.monster_max_hp ?? 0, tier, is_boss: isBoss }];

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1, color: "#4b5563", marginBottom: 6 }}>
        {monsters.length > 1 ? `${monsters.length} Enemies` : isBoss ? "Boss" : "Enemy"}
      </div>
      {monsters.map((m, i) => (
        <div key={i} style={rowStyle}>
          <span style={labelStyle}>
            {m.name}
            {m.is_boss && <span style={{ color: "#ef4444", fontSize: 11, marginLeft: 6 }}>BOSS</span>}
            {eliteLabel}
          </span>
          <span style={statStyle}>
            <span style={{ color: tierColor }}>Tier {m.tier}</span>
            <span>❤ {m.max_hp} HP</span>
          </span>
        </div>
      ))}
    </div>
  );
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

  // Track whether we ever loaded a lobby. If we DID and then the endpoint
  // starts returning null, that's a "lobby just ended" signal (quest
  // started, was cancelled, etc.) and we bubble up via onQuestStarted.
  // If we NEVER loaded one, null is just "no lobby for you right now" —
  // we render nothing and stay quiet (LobbyView may be mounted because
  // the active quest exists but has no recruitment open).
  const hadQuestRef = useRef(false);
  const refresh = useCallback(async () => {
    const res = await fetch("/api/quest/lobby", { credentials: "include" });
    if (!res.ok) {
      setLoading(false);
      return;
    }
    const body = (await res.json()) as { quest: LobbyQuestData | null; party?: LobbyMember[] };
    if (!body.quest) {
      if (hadQuestRef.current) {
        // Lobby just ended (started, cancelled, declined). Fire once;
        // reset the flag so subsequent null fetches don't re-trigger.
        hadQuestRef.current = false;
        setQuest(null);
        setParty([]);
        onQuestStarted();
      }
      // Either way, stop loading. Subsequent renders see quest=null and
      // bail at `if (!quest) return null`.
      setLoading(false);
      return;
    }
    hadQuestRef.current = true;
    setQuest(body.quest);
    setParty(body.party ?? []);
    setLoading(false);
  }, [onQuestStarted]);

  // WebSocket connection: live state + chat. Falls back to polling if the
  // upgrade fails (LOBBY_ROOM unbound in local dev, network block, etc.).
  // `wsConnected` flips poll cadence — polls stop when WS is alive.
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  // Initial HTTP load (gives us the quest id we need for the WS upgrade) +
  // a slower poll-as-fallback that's only active when WS isn't connected.
  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      if (!wsConnected) void refresh();
    }, 8000);
    return () => clearInterval(t);
  }, [refresh, wsConnected]);

  // Establish WS once we know the questId. Reconnects if the underlying
  // connection drops (manual exponential-ish backoff).
  useEffect(() => {
    if (!questId) return;
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 1000;

    const connect = () => {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${window.location.host}/api/quest/${questId}/lobby/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
        retryDelay = 1000;
      };
      ws.onmessage = (ev) => {
        let msg: { type: string; [k: string]: unknown };
        try {
          msg = JSON.parse(ev.data as string);
        } catch {
          return;
        }
        if (msg.type === "state") {
          const q = msg.quest as LobbyQuestData;
          const p = msg.party as LobbyMember[];
          setQuest(q);
          setParty(p);
          setLoading(false);
        } else if (msg.type === "chat") {
          const m = msg.message as ChatMessage;
          lastMessageAt.current = m.created_at;
          setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
        } else if (msg.type === "chat_history") {
          const list = (msg.messages as ChatMessage[]) ?? [];
          if (list.length > 0) {
            lastMessageAt.current = list[list.length - 1].created_at;
            setMessages(list);
          }
        } else if (msg.type === "lock_changed") {
          setQuest((q) => (q ? { ...q, locked: !!msg.locked } : q));
        } else if (msg.type === "started") {
          onQuestStarted();
        } else if (msg.type === "cancelled") {
          onQuestStarted(); // bubbles up to App.tsx refresh; lobby will vanish
        }
      };
      ws.onclose = () => {
        setWsConnected(false);
        wsRef.current = null;
        if (closed) return;
        // Reconnect with light backoff. Capped at 8s.
        retryDelay = Math.min(retryDelay * 1.5, 8000);
        retryTimer = setTimeout(connect, retryDelay);
      };
      ws.onerror = () => {
        // ws.onclose will fire after the error; let it handle reconnect.
      };
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      try { wsRef.current?.close(1000, "unmount"); } catch { /* noop */ }
      wsRef.current = null;
    };
  }, [questId, onQuestStarted]);

  // Heartbeat to keep the WS alive (ignored by server, but keeps proxies
  // from culling the connection).
  useEffect(() => {
    if (!wsConnected) return;
    const t = setInterval(() => {
      try {
        wsRef.current?.send(JSON.stringify({ type: "ping" }));
      } catch { /* socket closed; ignore */ }
    }, 25000);
    return () => clearInterval(t);
  }, [wsConnected]);

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
      // Prefer WS — instant fan-out to all listeners; no D1 write.
      // Falls back to the REST endpoint if the socket is closed.
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "chat", message: text }));
      } else {
        await fetch(`/api/quest/${questId}/chat`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text }),
        });
      }
    } finally {
      setSending(false);
    }
  }

  // Creator-only lobby control: toggle join lock or cancel entirely.
  async function toggleLock() {
    if (!quest || acting) return;
    setActing(true);
    try {
      await fetch(`/api/quest/${quest.id}/lobby/lock`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locked: !quest.locked }),
      });
      // WS state push will reflect the change; no manual refresh needed.
    } finally {
      setActing(false);
    }
  }

  async function cancelLobby() {
    if (!quest || acting) return;
    if (!confirm(
      quest.status === "active"
        ? "Cancel reinforcement recruitment? (Active fight continues.)"
        : "Cancel this lobby? The quest will be deleted entirely.",
    )) return;
    setActing(true);
    try {
      await fetch(`/api/quest/${quest.id}/lobby/cancel`, {
        method: "POST",
        credentials: "include",
      });
      onQuestStarted(); // re-fetch dashboard; lobby disappears
    } finally {
      setActing(false);
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

  // Pulse the floating tab when I personally have an outstanding action:
  //   - I'm pending (need to accept/decline)
  //   - I'm accepted but not ready (need to ready up)
  // Pulse stops when I've done my part — even if others haven't yet.
  const needsMyAction =
    me?.invite_status === "pending" ||
    (me?.invite_status === "accepted" && !me.ready);

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
        background: needsMyAction ? "#f59e0b" : "#2563eb",
        color: needsMyAction ? "#000" : "#fff",
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
        boxShadow: needsMyAction
          ? "-2px 0 18px rgba(245, 158, 11, 0.7)"
          : "-2px 0 12px rgba(0,0,0,0.4)",
        transition: "right 0.25s ease, background 0.25s ease, box-shadow 0.25s ease",
        animation: needsMyAction && !open ? "lobbyTabPulse 1.4s ease-in-out infinite" : "none",
      }}
    >
      <Icon name="conversation" size={16} color={needsMyAction ? "#000" : "#fff"} />
      <span style={{ writingMode: "vertical-rl", textOrientation: "mixed", transform: "rotate(180deg)" }}>
        LOBBY
      </span>
      {pendingCount > 0 && (
        <span style={{
          background: needsMyAction ? "#000" : "#f59e0b",
          color: needsMyAction ? "#f59e0b" : "#000",
          borderRadius: "50%",
          width: 16, height: 16, fontSize: 10, fontWeight: 700,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {pendingCount}
        </span>
      )}
      <style>{`
        @keyframes lobbyTabPulse {
          0%, 100% { box-shadow: -2px 0 18px rgba(245, 158, 11, 0.7); }
          50% { box-shadow: -2px 0 28px rgba(245, 158, 11, 1.0), 0 0 0 4px rgba(245, 158, 11, 0.35); }
        }
      `}</style>
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
            color: quest?.status === "active" ? "#dc2626" : "#60a5fa",
            marginBottom: 4,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {quest?.status === "active" ? "🆘 Reinforcement Lobby" : "Quest Lobby"}
          {quest?.locked && <span style={{ color: "#fbbf24" }}>🔒 Locked</span>}
        </div>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#f5f5f5" }}>{questLabel}</div>
        {expiresLabel && quest?.status !== "active" && (
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
            Auto-starts in {expiresLabel}
          </div>
        )}
        {quest?.status === "active" && (
          <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 4 }}>
            Fight in progress. Accepting joins you straight into combat.
          </div>
        )}
      </div>

      {/* Enemy preview */}
      {quest && <EnemyPreview quest={quest} />}

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
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0, gap: 1 }}>
                <span style={{ fontWeight: isSelf ? 700 : 400, color: "#f5f5f5", fontSize: 14 }}>
                  {m.name}
                  <span style={{ color: "#fbbf24", fontSize: 11, marginLeft: 6, fontWeight: 600 }}>L{m.level}</span>
                  {isSelf && (
                    <span style={{ color: "#60a5fa", fontSize: 12, marginLeft: 6 }}>(you)</span>
                  )}
                </span>
                {m.slack_username && (
                  <span style={{ color: "#6b7280", fontSize: 11, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}>
                    @{m.slack_username}
                  </span>
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
                  <div style={{ display: "flex", flexDirection: "column", minWidth: 0, gap: 1 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#f5f5f5" }}>
                      {tm.name}
                      <span style={{ fontSize: 11, color: "#fbbf24", marginLeft: 8, fontWeight: 600 }}>
                        L{tm.level}
                      </span>
                      <span style={{ fontSize: 11, color: "#6b7280", marginLeft: 6 }}>
                        {tm.class}
                      </span>
                    </span>
                    {tm.slack_username && (
                      <span style={{ fontSize: 11, color: "#6b7280", fontFamily: "ui-monospace, SFMono-Regular, monospace" }}>
                        @{tm.slack_username}
                      </span>
                    )}
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
        {/* Reinforcement mode: pending invitee on an active quest. One-click
            "Join the Fight!" pulls them straight into combat (server handles
            accept+ready+notifyFighterJoined atomically). */}
        {me?.invite_status === "pending" && quest?.status === "active" && (
          <>
            <button
              disabled={acting}
              onClick={() => void act("ready")}
              style={{ ...btnBase, background: "#dc2626", color: "#fff" }}
            >
              ⚔ Join the Fight!
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
        {/* Pre-combat lobby: standard accept/decline */}
        {me?.invite_status === "pending" && quest?.status !== "active" && (
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
        {me?.invite_status === "accepted" && me.ready && quest?.status !== "active" && (
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
        {me?.invite_status === "accepted" && me.ready && quest?.status === "active" && isCreator && (
          <div style={{ fontSize: 13, color: "#9ca3af", display: "flex", alignItems: "center", gap: 6 }}>
            <Icon name="conversation" size={13} color="#9ca3af" /> Reinforcements pending — they'll join the fight as they ready up
          </div>
        )}
        {isCreator && !showInvite && !quest?.locked && (
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
        {isCreator && quest?.locked && (
          <div style={{
            fontSize: 12,
            color: "#fbbf24",
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "9px 12px",
            background: "#1c1408",
            border: "1px solid #92400e",
            borderRadius: 8,
          }}>
            <Icon name="locked-fortress" size={13} color="#fbbf24" /> Locked — no new invites
          </div>
        )}
        {/* Creator-only: lock toggle + cancel */}
        {isCreator && (
          <button
            disabled={acting}
            onClick={() => void toggleLock()}
            title={quest?.locked ? "Unlock — re-allow invites" : "Lock — block new invites"}
            style={{
              ...btnBase,
              background: quest?.locked ? "#92400e" : "#1f2937",
              color: quest?.locked ? "#fff" : "#9ca3af",
              border: quest?.locked ? "none" : "1px solid #374151",
              marginLeft: "auto",
            }}
          >
            {quest?.locked ? "🔓 Unlock" : "🔒 Lock"}
          </button>
        )}
        {isCreator && (
          <button
            disabled={acting}
            onClick={() => void cancelLobby()}
            title={quest?.status === "active"
              ? "Close recruitment — active fight continues"
              : "Cancel & delete the lobby entirely"}
            style={{
              ...btnBase,
              background: "#1f1414",
              color: "#fca5a5",
              border: "1px solid #7f1d1d",
            }}
          >
            🗑 {quest?.status === "active" ? "Close Recruit" : "Cancel"}
          </button>
        )}
        {/* Force start only meaningful pre-combat */}
        {isCreator && quest?.status !== "active" && (
          <button
            disabled={acting}
            onClick={() => void act("force_start")}
            style={{ ...btnBase, background: "#7c3aed", color: "#fff" }}
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
