// ExpeditionLobbyView — sidebar drawer for the pre-run expedition party
// gathering. Mirrors the visual identity of LobbyView (chips, roster cards,
// gold action button) but is deliberately simpler:
//
//   * No party chat or websocket connection — expedition pre-run is the
//     planning phase, not a live combat coordination surface.
//   * No ready-up phase or auto-start timer — the creator decides when to
//     /begin once invitees have accepted.
//   * No reinforcement / mid-run join — the lobby is pre-run only, gated
//     server-side by `expeditions.current_node IS NULL`.
//
// Decision (see PR notes): we forked rather than extracted a polymorphic
// LobbyShell because most of LobbyView's surface (WS chat, ready toggle,
// position picker, reinforcement) doesn't apply here, and forking is a
// shorter path to the visual identity we need.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";

interface LobbyMember {
  character_id: string;
  name: string;
  slack_username: string | null;
  level: number;
  class: string;
  invite_status: "pending" | "accepted" | "declined";
}

interface ExpeditionLobby {
  id: number;
  created_by: string;
  created_at: number;
  status: "lobby" | "active";
  my_invite_status: "pending" | "accepted" | "declined";
  members: LobbyMember[];
}

interface TeamMember {
  slack_user_id: string;
  name: string;
  slack_username: string | null;
  class: string;
  level: number;
}

/**
 * Drawer for a pending expedition lobby. Mounted whenever the user has a
 * lobby-state expedition in flight (creator OR pending invitee). Notifies
 * the parent via `onLobbyClosed` when the lobby is gone — either because
 * it began (status flipped to active), the creator cancelled, or this user
 * declined out.
 */
export function ExpeditionLobbyView({
  selfId,
  onLobbyClosed,
  onBegan,
}: {
  selfId: string;
  /** Called when /api/expedition/lobby starts returning null after we had
   *  previously seen a lobby. Triggers a parent refresh. */
  onLobbyClosed: () => void;
  /** Called after a successful /begin so the parent can immediately route
   *  into the Expedition map view. */
  onBegan: (expeditionId: number) => void;
}) {
  const [open, setOpen] = useState(true);
  const [lobby, setLobby] = useState<ExpeditionLobby | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [inviting, setInviting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hadLobbyRef = useRef(false);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/expedition/lobby", { credentials: "include" });
    if (!res.ok) {
      setLoading(false);
      return;
    }
    const body = (await res.json()) as { lobby: ExpeditionLobby | null };
    if (!body.lobby) {
      if (hadLobbyRef.current) {
        hadLobbyRef.current = false;
        setLobby(null);
        onLobbyClosed();
      }
      setLoading(false);
      return;
    }
    hadLobbyRef.current = true;
    setLobby(body.lobby);
    setLoading(false);
  }, [onLobbyClosed]);

  useEffect(() => {
    void refresh();
    // No websocket here — expedition lobby is low-frequency (invites + accept
    // are user-initiated, not live multiplayer chat). 5s poll is plenty.
    const t = setInterval(() => void refresh(), 5000);
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
    if (!lobby || inviting) return;
    setInviting(targetUserId);
    setError(null);
    try {
      const res = await fetch(`/api/expedition/${lobby.id}/invite`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ character_id: targetUserId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(prettyInviteError(body.error));
      }
      await refresh();
    } finally {
      setInviting(null);
    }
  }

  async function accept() {
    if (!lobby || acting) return;
    setActing(true);
    setError(null);
    try {
      const res = await fetch(`/api/expedition/${lobby.id}/accept`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(prettyAcceptError(body.error));
      }
      await refresh();
    } finally {
      setActing(false);
    }
  }

  async function decline() {
    if (!lobby || acting) return;
    if (!confirm("Decline this expedition invite?")) return;
    setActing(true);
    try {
      await fetch(`/api/expedition/${lobby.id}/decline`, {
        method: "POST",
        credentials: "include",
      });
      // After decline the lobby endpoint returns null for us; refresh will
      // fire onLobbyClosed.
      await refresh();
    } finally {
      setActing(false);
    }
  }

  async function begin() {
    if (!lobby || acting) return;
    setActing(true);
    setError(null);
    try {
      const res = await fetch(`/api/expedition/${lobby.id}/begin`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; pending?: number };
        setError(prettyBeginError(body.error, body.pending));
        return;
      }
      onBegan(lobby.id);
    } finally {
      setActing(false);
    }
  }

  async function cancelLobby() {
    if (!lobby || acting) return;
    if (!confirm("Cancel this expedition? The lobby will be removed entirely.")) return;
    setActing(true);
    try {
      await fetch(`/api/expedition/${lobby.id}/cancel`, {
        method: "POST",
        credentials: "include",
      });
      await refresh();
    } finally {
      setActing(false);
    }
  }

  const me = lobby?.members.find((m) => m.character_id === selfId);
  const isCreator = lobby?.created_by === selfId;
  const accepted = lobby?.members.filter((m) => m.invite_status === "accepted") ?? [];
  const pendingCount = lobby?.members.filter((m) => m.invite_status === "pending").length ?? 0;
  const memberIds = new Set(lobby?.members.map((m) => m.character_id));
  const inviteable = teamMembers.filter(
    (m) => !memberIds.has(m.slack_user_id) && m.slack_user_id !== selfId,
  );
  const needsMyAction = me?.invite_status === "pending";

  const tab = (
    <button
      onClick={() => setOpen((o) => !o)}
      style={{
        position: "fixed",
        right: open ? 380 : 0,
        top: "50%",
        transform: "translateY(-50%)",
        zIndex: 1001,
        background: needsMyAction ? "var(--accent-gold-warm)" : "var(--accent-arcane-3)",
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
        animation: needsMyAction && !open ? "expLobbyTabPulse 1.4s ease-in-out infinite" : "none",
      }}
    >
      <Icon name="conversation" size={16} color={needsMyAction ? "#000" : "#fff"} />
      <span style={{ writingMode: "vertical-rl", textOrientation: "mixed", transform: "rotate(180deg)" }}>
        EXPEDITION
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
        @keyframes expLobbyTabPulse {
          0%, 100% { box-shadow: -2px 0 18px rgba(245, 158, 11, 0.7); }
          50% { box-shadow: -2px 0 28px rgba(245, 158, 11, 1.0), 0 0 0 4px rgba(245, 158, 11, 0.35); }
        }
      `}</style>
    </button>
  );

  if (loading) {
    return typeof document !== "undefined" ? createPortal(tab, document.body) : null;
  }
  if (!lobby) return null;

  const drawerContent = (
    <>
      {tab}
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 999,
            background: "rgba(0,0,0,0.55)",
          }}
        />
      )}
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
          {/* Header */}
          <div style={{ marginBottom: 16 }}>
            <div
              style={{
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: 1,
                color: "var(--accent-arcane-2)",
                marginBottom: 6,
                fontFamily: "var(--font-mono)",
              }}
            >
              Expedition Lobby
            </div>
            <div style={{
              fontSize: 22,
              fontWeight: 400,
              color: "var(--fg-1)",
              fontFamily: "var(--font-display)",
              lineHeight: 1.2,
            }}>
              A Longer Road
            </div>
            <div style={{
              fontSize: 12,
              color: "var(--fg-mute-3)",
              marginTop: 6,
              fontFamily: "var(--font-body)",
            }}>
              Pre-run only — once the run begins, no parachuting in.
            </div>
          </div>

          {/* Roster */}
          <div style={{ display: "grid", gap: 8, marginBottom: 20 }}>
            {lobby.members.map((m) => {
              const isSelf = m.character_id === selfId;
              const pending = m.invite_status === "pending";
              const isAccepted = m.invite_status === "accepted";

              let pillBg = "var(--bg-input)";
              let pillBorder = "var(--border-base)";
              let pillColor = "var(--fg-mute)";
              let pillLabel = "PENDING";
              let statusIcon: React.ReactNode = <Icon name="conversation" size={13} color="var(--accent-gold-warm)" />;
              if (pending) {
                pillBg = "var(--bg-input)";
                pillBorder = "var(--border-base)";
                pillColor = "var(--accent-gold-warm)";
                pillLabel = "INVITED";
              } else if (isAccepted) {
                pillBg = "var(--accent-ink-deep)";
                pillBorder = "var(--accent-ink-blue)";
                pillColor = "var(--accent-ink-blue)";
                pillLabel = m.character_id === lobby.created_by ? "PICKER" : "JOINED";
                statusIcon = <Icon name="trophy" size={13} color="var(--accent-ink-blue)" />;
              }

              return (
                <div
                  key={m.character_id}
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
                  }}
                >
                  <span style={{ display: "flex", flexDirection: "column", minWidth: 0, gap: 2, flex: "1 1 auto" }}>
                    <span style={{
                      fontWeight: isSelf ? 700 : 600,
                      color: "var(--fg-1)",
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
                      <span style={{
                        color: "var(--fg-mute-3)",
                        fontSize: 11,
                        fontFamily: "var(--font-mono)",
                      }}>
                        {m.class}
                      </span>
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

          {/* Invite picker — creator only */}
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
                  No available teammates to invite.
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

          {error && (
            <div style={{
              marginBottom: 12,
              padding: "8px 12px",
              background: "var(--bg-input)",
              border: "1px solid var(--tone-bad-3)",
              borderRadius: "var(--radius-md)",
              color: "var(--tone-bad-2)",
              fontSize: 12,
              fontFamily: "var(--font-body)",
            }}>
              {error}
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {/* Invitee: accept/decline */}
            {me?.invite_status === "pending" && (
              <>
                <button
                  className="btn btn-primary"
                  disabled={acting}
                  onClick={() => void accept()}
                >
                  {acting ? "Joining…" : "Accept Invite"}
                </button>
                <button
                  className="btn btn-ghost"
                  disabled={acting}
                  onClick={() => void decline()}
                >
                  Decline
                </button>
              </>
            )}
            {/* Creator: invite + begin/cancel */}
            {isCreator && !showInvite && (
              <button
                className="btn btn-ghost"
                onClick={() => void openInvite()}
              >
                + Invite Player
              </button>
            )}
            {isCreator && (
              <button
                className={pendingCount === 0 ? "btn btn-gold" : "btn btn-primary"}
                disabled={acting || pendingCount > 0}
                onClick={() => void begin()}
                title={pendingCount > 0
                  ? "Waiting on pending invites — accept or decline first."
                  : "Begin the expedition. Lobby closes; no more invites."}
              >
                {acting
                  ? "Setting out…"
                  : pendingCount > 0
                    ? `Waiting on ${pendingCount}…`
                    : accepted.length > 1
                      ? "Begin Expedition"
                      : "Begin Solo"}
              </button>
            )}
            {isCreator && (
              <button
                className="btn btn-ghost"
                disabled={acting}
                onClick={() => void cancelLobby()}
                style={{
                  marginLeft: "auto",
                  background: "var(--bg-input)",
                  color: "var(--tone-bad)",
                  borderColor: "var(--tone-bad-3)",
                }}
              >
                🗑 Cancel
              </button>
            )}
            {/* Accepted invitee, waiting on creator */}
            {!isCreator && me?.invite_status === "accepted" && (
              <div
                style={{
                  fontSize: 12,
                  color: "var(--accent-flavor)",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontStyle: "italic",
                  fontFamily: "var(--font-body)",
                  padding: "8px 4px",
                }}
              >
                <Icon name="conversation" size={13} color="var(--accent-flavor)" />
                Waiting on the picker to begin the run…
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );

  return typeof document !== "undefined" ? createPortal(drawerContent, document.body) : null;
}

function prettyInviteError(error: string | undefined): string {
  switch (error) {
    case "target_in_expedition": return "That player is already in another expedition.";
    case "target_on_quest": return "That player is on a quest right now.";
    case "already_invited": return "They're already in the lobby.";
    case "target_not_found": return "Player not found on your team.";
    case "not_creator": return "Only the picker can invite players.";
    case "not_in_lobby": return "Lobby is no longer open.";
    default: return `Invite failed: ${error ?? "unknown error"}`;
  }
}

function prettyAcceptError(error: string | undefined): string {
  switch (error) {
    case "already_in_expedition": return "You're already in another expedition.";
    case "member_on_quest": return "You're on a quest — finish or abandon it first.";
    case "not_pending": return "Your invite is no longer pending.";
    case "not_in_lobby": return "The lobby has already closed.";
    default: return `Couldn't accept: ${error ?? "unknown error"}`;
  }
}

function prettyBeginError(error: string | undefined, pending?: number): string {
  if (error === "pending_invites") {
    return `Can't begin — ${pending ?? "some"} invite${(pending ?? 2) === 1 ? "" : "s"} still pending.`;
  }
  switch (error) {
    case "not_creator": return "Only the picker can begin the run.";
    case "not_in_lobby": return "Lobby state changed; refresh.";
    case "already_started": return "Already underway.";
    default: return `Couldn't begin: ${error ?? "unknown error"}`;
  }
}
