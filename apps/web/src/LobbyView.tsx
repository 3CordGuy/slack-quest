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
  position: "front" | "back";
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
  const isGauntlet = s.variant === "gauntlet";
  const isBoss = s.variant === "boss";
  const tier = s.tier ?? 1;

  const tierColor = tier >= 5 ? "var(--tone-bad-2)" : tier >= 3 ? "var(--accent-gold-warm)" : "var(--fg-mute-3)";
  const eliteLabel = quest.elite ? <span style={{ color: "var(--accent-gold-warm)", fontSize: 11, fontWeight: 700, marginLeft: 6, letterSpacing: 0.5 }}>ELITE</span> : null;

  const rowStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "8px 12px", background: "var(--bg-card-2)",
    borderRadius: "var(--radius-md)",
    border: "1px solid var(--border-faint)", marginBottom: 4,
    flexWrap: "wrap", gap: 6,
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 14, color: "var(--fg-1)", fontWeight: 600,
    fontFamily: "var(--font-display)", letterSpacing: 0.2,
  };
  const statStyle: React.CSSProperties = {
    fontSize: 12, color: "var(--fg-mute-2)", display: "flex", gap: 10,
    fontFamily: "var(--font-mono)",
  };

  if (isGauntlet) {
    const waves = s.total_waves ?? 1;
    const monsters: LobbyMonster[] = s.monsters?.length
      ? s.monsters
      : [{ name: s.monster_name ?? "?", max_hp: s.monster_max_hp ?? 0, tier }];
    return (
      <div style={{ marginBottom: 16 }}>
        <div style={{
          fontSize: 11, textTransform: "uppercase", letterSpacing: 1,
          color: "var(--fg-faintest)", marginBottom: 6,
          fontFamily: "var(--font-mono)",
        }}>
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
      <div style={{
        fontSize: 11, textTransform: "uppercase", letterSpacing: 1,
        color: "var(--fg-faintest)", marginBottom: 6,
        fontFamily: "var(--font-mono)",
      }}>
        {monsters.length > 1 ? `${monsters.length} Enemies` : isBoss ? "Boss" : "Enemy"}
      </div>
      {monsters.map((m, i) => (
        <div key={i} style={rowStyle}>
          <span style={labelStyle}>
            {m.name}
            {m.is_boss && <span style={{ color: "var(--tone-bad-2)", fontSize: 11, marginLeft: 6, fontWeight: 700, letterSpacing: 0.5 }}>BOSS</span>}
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

  // Pick the local player's starting battle row. Saved to the character
  // row immediately so it survives reloads + carries into the fight's
  // initial fighter state. Server pushes a lobby state refresh so other
  // party members see the updated pill without polling.
  async function togglePosition() {
    if (!me || acting) return;
    const next = me.position === "front" ? "back" : "front";
    setActing(true);
    try {
      await fetch("/api/character/position", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position: next }),
      });
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

  const questLabel = quest?.scene.variant === "boss"
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
        background: needsMyAction ? "var(--accent-gold-warm)" : "var(--accent-ink-blue-2)",
        color: needsMyAction ? "#000" : "#fff",
        border: "none",
        borderRadius: "var(--radius-md) 0 0 var(--radius-md)",
        padding: "12px 8px",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.5,
        fontFamily: "var(--font-body)",
        boxShadow: needsMyAction
          ? "-2px 0 18px rgba(245, 158, 11, 0.7)"
          : "var(--shadow-pop)",
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
          background: needsMyAction ? "#000" : "var(--accent-gold-warm)",
          color: needsMyAction ? "var(--accent-gold-warm)" : "#000",
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

  const drawerContent = (
    <>
      {tab}
      {/* Backdrop — closes drawer when clicking outside */}
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 999,
            background: "rgba(0,0,0,0.55)",
          }}
        />
      )}
      {/* Drawer panel */}
      <div
        style={{
          position: "fixed",
          top: 0,
          right: open ? 0 : -400,
          width: "min(380px, 100vw)",
          maxWidth: "100vw",
          height: "100vh",
          zIndex: 1000,
          background: "var(--bg-panel)",
          borderLeft: "1px solid var(--border-base)",
          boxShadow: "var(--shadow-modal)",
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
            color: quest?.status === "active" ? "var(--tone-bad-3)" : "var(--accent-ink-blue)",
            marginBottom: 6,
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            fontFamily: "var(--font-mono)",
          }}
        >
          <span>{quest?.status === "active" ? "🆘 Reinforcement Lobby" : "Quest Lobby"}</span>
          {quest?.locked && (
            <span className="pill" style={{ color: "var(--accent-gold)", borderColor: "var(--accent-gold-dark)" }}>
              🔒 Locked
            </span>
          )}
        </div>
        <div style={{
          fontSize: 22,
          fontWeight: 400,
          color: "var(--fg-1)",
          fontFamily: "var(--font-display)",
          lineHeight: 1.2,
        }}>
          {questLabel}
        </div>
        {expiresLabel && quest?.status !== "active" && (
          <div style={{
            fontSize: 12,
            color: "var(--fg-mute-3)",
            marginTop: 6,
            fontFamily: "var(--font-mono)",
            letterSpacing: 0.3,
          }}>
            Auto-starts in {expiresLabel}
          </div>
        )}
        {quest?.status === "active" && (
          <div style={{
            fontSize: 12,
            color: "var(--accent-flavor)",
            marginTop: 6,
            fontStyle: "italic",
            fontFamily: "var(--font-body)",
          }}>
            Fight in progress. Accepting joins you straight into combat.
          </div>
        )}
      </div>

      {/* Enemy preview */}
      {quest && <EnemyPreview quest={quest} />}

      {/* Party roster */}
      <div style={{ display: "grid", gap: 8, marginBottom: 20 }}>
        {party.map((m) => {
          const isSelf = m.slack_user_id === selfId;
          const declined = m.invite_status === "declined";
          const pending = m.invite_status === "pending";
          const accepted = m.invite_status === "accepted";

          // Status pill colors per design system
          let pillBg = "var(--bg-input)";
          let pillBorder = "var(--border-base)";
          let pillColor = "var(--fg-mute)";
          let pillLabel = "WAITING";
          let statusIcon: React.ReactNode = <Icon name="bed" size={13} color="var(--fg-mute-2)" />;
          if (declined) {
            pillBg = "var(--bg-input)";
            pillBorder = "var(--tone-bad-2)";
            pillColor = "var(--tone-bad-2)";
            pillLabel = "DECLINED";
            statusIcon = <Icon name="plain-dagger" size={13} color="var(--tone-bad-2)" />;
          } else if (pending) {
            pillBg = "var(--bg-input)";
            pillBorder = "var(--border-base)";
            pillColor = "var(--fg-mute)";
            pillLabel = "WAITING";
            statusIcon = <Icon name="conversation" size={13} color="var(--accent-gold-warm)" />;
          } else if (accepted && m.ready) {
            pillBg = "var(--tone-good-bg)";
            pillBorder = "var(--tone-good-2)";
            pillColor = "var(--tone-good-2)";
            pillLabel = "READY!";
            statusIcon = <Icon name="trophy" size={13} color="var(--tone-good-2)" />;
          } else if (accepted) {
            pillBg = "var(--accent-ink-deep)";
            pillBorder = "var(--accent-ink-blue)";
            pillColor = "var(--accent-ink-blue)";
            pillLabel = "READY";
            statusIcon = <Icon name="bed" size={13} color="var(--accent-ink-blue)" />;
          }

          return (
            <div
              key={m.slack_user_id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                flexWrap: "wrap",
                padding: "10px 12px",
                background: isSelf ? "var(--accent-ink-deep)" : "var(--bg-card-2)",
                borderRadius: "var(--radius-lg)",
                border: isSelf
                  ? "1px solid var(--accent-ink-blue-2)"
                  : "1px solid var(--border-faint)",
                opacity: declined ? 0.5 : 1,
              }}
            >
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0, gap: 2, flex: "1 1 auto" }}>
                <span style={{
                  fontWeight: isSelf ? 700 : 600,
                  color: declined ? "var(--tone-bad-2)" : "var(--fg-1)",
                  fontSize: 14,
                  fontFamily: "var(--font-display)",
                  letterSpacing: 0.2,
                  display: "inline-flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 6,
                }}>
                  <span>{m.name}</span>
                  <span style={{
                    color: "var(--accent-gold)",
                    fontSize: 11,
                    fontWeight: 700,
                    fontFamily: "var(--font-mono)",
                  }}>
                    L{m.level}
                  </span>
                  {/* Position pill so the whole party can see who's
                      front vs back before combat starts. Self can flip
                      via the toggle button in the action row. */}
                  {m.invite_status === "accepted" && (
                    <span
                      className="pill"
                      title={`${m.position === "front" ? "Front" : "Back"} row`}
                      style={{
                        background: m.position === "front" ? "var(--accent-arcane-bg)" : "var(--tone-good-bg)",
                        color: m.position === "front" ? "var(--accent-arcane-2)" : "var(--tone-good)",
                        borderColor: m.position === "front" ? "var(--accent-arcane-3)" : "var(--tone-good-br)",
                      }}
                    >
                      {m.position === "front" ? "Front" : "Back"}
                    </span>
                  )}
                  {isSelf && (
                    <span style={{
                      color: "var(--accent-ink-blue)",
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                    }}>
                      (you)
                    </span>
                  )}
                </span>
                {m.slack_username && (
                  <span style={{
                    color: "var(--fg-mute-3)",
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                  }}>
                    @{m.slack_username}
                  </span>
                )}
              </span>
              <span
                className="pill"
                style={{
                  background: pillBg,
                  borderColor: pillBorder,
                  color: pillColor,
                  flexShrink: 0,
                }}
              >
                {statusIcon} {pillLabel}
              </span>
            </div>
          );
        })}
      </div>

      {/* Invite player picker — creator only */}
      {isCreator && showInvite && (
        <div
          style={{
            background: "var(--bg-card-2)",
            border: "1px solid var(--border-faint)",
            borderRadius: "var(--radius-xl)",
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
            <span style={{
              fontSize: 11,
              fontWeight: 700,
              color: "var(--fg-mute)",
              textTransform: "uppercase",
              letterSpacing: 1,
              fontFamily: "var(--font-mono)",
            }}>
              Invite a player
            </span>
            <button
              onClick={() => setShowInvite(false)}
              style={{
                background: "none",
                border: "none",
                color: "var(--fg-mute-3)",
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
            <div style={{
              fontSize: 12,
              color: "var(--accent-flavor)",
              fontStyle: "italic",
            }}>
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
                    gap: 8,
                    flexWrap: "wrap",
                    padding: "8px 10px",
                    background: "var(--bg-deep)",
                    borderRadius: "var(--radius-md)",
                    border: "1px solid var(--border-faint)",
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", minWidth: 0, gap: 2, flex: "1 1 auto" }}>
                    <span style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--fg-1)",
                      fontFamily: "var(--font-display)",
                      letterSpacing: 0.2,
                      display: "inline-flex",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: 6,
                    }}>
                      <span>{tm.name}</span>
                      <span style={{
                        fontSize: 11,
                        color: "var(--accent-gold)",
                        fontWeight: 700,
                        fontFamily: "var(--font-mono)",
                      }}>
                        L{tm.level}
                      </span>
                      <span style={{
                        fontSize: 11,
                        color: "var(--fg-mute-3)",
                        fontFamily: "var(--font-mono)",
                      }}>
                        {tm.class}
                      </span>
                    </span>
                    {tm.slack_username && (
                      <span style={{
                        fontSize: 11,
                        color: "var(--fg-mute-3)",
                        fontFamily: "var(--font-mono)",
                      }}>
                        @{tm.slack_username}
                      </span>
                    )}
                  </div>
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={inviting === tm.slack_user_id}
                    onClick={() => void invite(tm.slack_user_id)}
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
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {/* Reinforcement mode: pending invitee on an active quest. One-click
            "Join the Fight!" pulls them straight into combat (server handles
            accept+ready+notifyFighterJoined atomically). */}
        {me?.invite_status === "pending" && quest?.status === "active" && (
          <>
            <button
              className="btn btn-gold"
              disabled={acting}
              onClick={() => void act("ready")}
            >
              {acting ? "Setting out…" : "⚔ Join the Fight!"}
            </button>
            <button
              className="btn btn-ghost"
              disabled={acting}
              onClick={() => void act("decline")}
            >
              Decline
            </button>
          </>
        )}
        {/* Pre-combat lobby: standard accept/decline */}
        {me?.invite_status === "pending" && quest?.status !== "active" && (
          <>
            <button
              className="btn btn-primary"
              disabled={acting}
              onClick={() => void act("accept")}
            >
              Accept Invite
            </button>
            <button
              className="btn btn-ghost"
              disabled={acting}
              onClick={() => void act("decline")}
            >
              Decline
            </button>
          </>
        )}
        {/* Position picker — available to any accepted member (and the
            creator, who's auto-accepted) before they ready up. Once
            ready or after combat starts, position changes via the
            in-combat /position action instead. */}
        {me?.invite_status === "accepted" && !me.ready && (
          <button
            className="btn"
            disabled={acting}
            onClick={() => void togglePosition()}
            title={me.position === "front"
              ? "Currently FRONT — eats hits first. Click to drop to BACK row."
              : "Currently BACK — reduced melee damage taken. Click to step up to FRONT row."}
            style={{
              background: me.position === "front" ? "var(--accent-arcane-bg)" : "var(--tone-good-bg)",
              color: me.position === "front" ? "var(--accent-arcane-2)" : "var(--tone-good)",
              border: `1px solid ${me.position === "front" ? "var(--accent-arcane-3)" : "var(--tone-good-br)"}`,
            }}
          >
            <Icon name={me.position === "front" ? "muscle-up" : "fall-down"} size={13} color={me.position === "front" ? "var(--accent-arcane-2)" : "var(--tone-good)"} />
            {me.position === "front" ? "Front row" : "Back row"}
          </button>
        )}
        {me?.invite_status === "accepted" && !me.ready && (
          <button
            className={allReady ? "btn btn-gold" : "btn btn-primary"}
            disabled={acting}
            onClick={() => void act("ready")}
          >
            {acting ? "Setting out…" : allReady ? "Set Out" : "Ready Up"}
          </button>
        )}
        {me?.invite_status === "accepted" && me.ready && quest?.status !== "active" && (
          <div
            style={{
              fontSize: 12,
              color: hasPending ? "var(--accent-gold-warm)" : "var(--tone-good-2)",
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontStyle: "italic",
              fontFamily: "var(--font-body)",
              padding: "8px 4px",
            }}
          >
            {hasPending
              ? <><Icon name="conversation" size={13} color="var(--accent-gold-warm)" /> Waiting for pending invites — or Force Start to skip them</>
              : <><Icon name="trophy" size={13} color="var(--tone-good-2)" /> You're ready — waiting for others…</>
            }
          </div>
        )}
        {me?.invite_status === "accepted" && me.ready && quest?.status === "active" && isCreator && (
          <div style={{
            fontSize: 12,
            color: "var(--accent-flavor)",
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontStyle: "italic",
            padding: "8px 4px",
          }}>
            <Icon name="conversation" size={13} color="var(--accent-flavor)" /> Reinforcements pending — they'll join the fight as they ready up
          </div>
        )}
        {isCreator && !showInvite && !quest?.locked && (
          <button
            className="btn btn-ghost"
            onClick={() => void openInvite()}
          >
            + Invite Player
          </button>
        )}
        {isCreator && quest?.locked && (
          <div className="pill" style={{
            color: "var(--accent-gold)",
            borderColor: "var(--accent-gold-dark)",
            background: "var(--bg-input)",
            padding: "4px 8px",
          }}>
            <Icon name="locked-fortress" size={13} color="var(--accent-gold)" /> Locked — no new invites
          </div>
        )}
        {/* Creator-only: lock toggle + cancel */}
        {isCreator && (
          <button
            className="btn btn-ghost"
            disabled={acting}
            onClick={() => void toggleLock()}
            title={quest?.locked ? "Unlock — re-allow invites" : "Lock — block new invites"}
            style={{
              marginLeft: "auto",
              ...(quest?.locked
                ? { background: "var(--accent-gold-dark)", color: "#fff", borderColor: "var(--accent-gold-dark)" }
                : {}),
            }}
          >
            {quest?.locked ? "🔓 Unlock" : "🔒 Lock"}
          </button>
        )}
        {isCreator && (
          <button
            className="btn btn-ghost"
            disabled={acting}
            onClick={() => void cancelLobby()}
            title={quest?.status === "active"
              ? "Close recruitment — active fight continues"
              : "Cancel & delete the lobby entirely"}
            style={{
              background: "var(--bg-input)",
              color: "var(--tone-bad)",
              borderColor: "var(--tone-bad-3)",
            }}
          >
            🗑 {quest?.status === "active" ? "Close Recruit" : "Cancel"}
          </button>
        )}
        {/* Force start only meaningful pre-combat */}
        {isCreator && quest?.status !== "active" && (
          <button
            className="btn"
            disabled={acting}
            onClick={() => void act("force_start")}
            style={{
              background: "var(--accent-arcane-3)",
              color: "#fff",
            }}
          >
            Force Start
          </button>
        )}
      </div>{/* action buttons */}
    </div>{/* inner content div */}

      {/* Party Chat */}
      {questId && (
        <div style={{
          borderTop: "1px solid var(--border-faint)",
          display: "flex",
          flexDirection: "column",
          marginTop: 16,
          paddingTop: 12,
        }}>
          <div style={{
            fontSize: 11,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: 1,
            color: "var(--fg-faintest)",
            marginBottom: 8,
            paddingLeft: 2,
            fontFamily: "var(--font-mono)",
          }}>
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
              <div style={{
                color: "var(--accent-flavor)",
                fontSize: 12,
                fontStyle: "italic",
                paddingLeft: 2,
              }}>
                No messages yet. Say hello!
              </div>
            ) : (
              messages.map((m) => (
                <div key={m.id} style={{ fontSize: 13, lineHeight: 1.4 }}>
                  <span style={{
                    fontWeight: 700,
                    color: m.user_id === selfId ? "var(--accent-ink-blue)" : "var(--accent-arcane)",
                    marginRight: 6,
                    fontFamily: "var(--font-display)",
                    letterSpacing: 0.2,
                  }}>
                    {m.user_id === selfId ? "You" : m.user_name}
                  </span>
                  <span style={{ color: "var(--fg-3)" }}>{m.message}</span>
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
                background: "var(--bg-card-2)",
                border: "1px solid var(--border-faint)",
                borderRadius: "var(--radius-md)",
                color: "var(--fg-1)",
                fontSize: 13,
                padding: "8px 10px",
                outline: "none",
                fontFamily: "var(--font-body)",
              }}
            />
            <button
              className="btn btn-primary btn-sm"
              disabled={sending || !chatInput.trim()}
              onClick={() => void sendMessage()}
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
