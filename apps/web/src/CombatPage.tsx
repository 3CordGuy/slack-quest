import { useEffect, useReducer, useRef } from "react";

// Live web-mode combat. Connects to the QuestRoom Durable Object via WS,
// renders the current state, animates incoming events through a scrolling
// log, and lets the active player submit actions.

interface StatusEffect {
  type: "regen" | "bleeding" | "burning" | "poisoned";
  magnitude: number;
  remaining: number;
  source?: string;
}

interface Fighter {
  id: string;
  name: string;
  class: string;
  level: number;
  hp: number;
  max_hp: number;
  mana: number;
  max_mana: number;
  shield: number;
  position: "front" | "back";
  attack_mod: number;
  magic_mod: number;
  weapon_power: number;
  armor_power: number;
  initiative: number;
  effects: StatusEffect[];
}

interface Monster {
  name: string;
  hp: number;
  max_hp: number;
  tier: number;
  initiative: number;
  effects: StatusEffect[];
  is_boss: boolean;
  boss_phase: 1 | 2;
}

interface CombatState {
  fighters: Fighter[];
  monster: Monster;
  turn_order: string[];
  turn_index: number;
  round: number;
  status: "pending" | "active" | "victory" | "defeat";
}

const MONSTER_ID = "__monster__";

type CombatEvent =
  | { type: "begin"; turn_order: string[]; initiatives: Record<string, number> }
  | { type: "turn_start"; actor: string; round: number }
  | { type: "roll"; actor: string; die: string; value: number; purpose: string }
  | {
      type: "hit_check";
      actor: string;
      target: string;
      roll: number;
      modifier: number;
      total: number;
      ac: number;
      hit: boolean;
    }
  | { type: "player_hit"; actor: string; target: string; damage: number; crit: boolean; formula: string }
  | {
      type: "monster_attack";
      target: string;
      raw_damage: number;
      damage_after_position: number;
      damage_after_armor: number;
      shield_absorbed: number;
      hp_damage: number;
    }
  | { type: "boss_phase_transition"; new_phase: 2 }
  | { type: "fighter_down"; target: string }
  | { type: "monster_down"; killed_by: string }
  | { type: "victory" }
  | { type: "defeat" }
  | { type: "rejected"; reason: string };

type TurnAction =
  | { kind: "attack"; actor: string }
  | { kind: "cast"; actor: string }
  | { kind: "wait"; actor: string }
  | { kind: "monster_act" };

interface UiState {
  connection: "connecting" | "open" | "closed";
  state: CombatState | null;
  log: { id: number; text: string; tone: "info" | "good" | "bad" | "muted" }[];
  error: string | null;
}

type UiAction =
  | { kind: "connection"; value: UiState["connection"] }
  | { kind: "state"; value: CombatState }
  | { kind: "events"; value: CombatEvent[] }
  | { kind: "error"; value: string };

let nextLogId = 1;

function reducer(s: UiState, a: UiAction): UiState {
  switch (a.kind) {
    case "connection":
      return { ...s, connection: a.value };
    case "state":
      return { ...s, state: a.value };
    case "events":
      return {
        ...s,
        log: [...s.log, ...a.value.flatMap((e) => formatEvent(e, s.state))].slice(-50),
      };
    case "error":
      return { ...s, error: a.value };
  }
}

function formatEvent(e: CombatEvent, state: CombatState | null): UiState["log"] {
  const nameOf = (id: string) => {
    if (id === MONSTER_ID) return state?.monster.name ?? "monster";
    return state?.fighters.find((f) => f.id === id)?.name ?? id;
  };
  switch (e.type) {
    case "begin":
      return [{ id: nextLogId++, text: "⚔️  Combat begins. Rolling initiative…", tone: "info" }];
    case "turn_start":
      return [{ id: nextLogId++, text: `▶ ${nameOf(e.actor)}'s turn (round ${e.round})`, tone: "muted" }];
    case "roll":
      return [
        {
          id: nextLogId++,
          text: `🎲 ${nameOf(e.actor)} rolled ${e.die} → ${e.value}  ·  ${e.purpose}`,
          tone: "muted",
        },
      ];
    case "hit_check":
      return [
        {
          id: nextLogId++,
          text: e.hit
            ? `✅ HIT  ${e.roll}${signed(e.modifier)} = ${e.total} vs AC ${e.ac}`
            : `❌ MISS  ${e.roll}${signed(e.modifier)} = ${e.total} vs AC ${e.ac}`,
          tone: e.hit ? "good" : "bad",
        },
      ];
    case "player_hit":
      return [
        {
          id: nextLogId++,
          text: `💥 ${nameOf(e.actor)} → ${nameOf(e.target)}: ${e.damage}${
            e.crit ? " (CRIT)" : ""
          }  [${e.formula}]`,
          tone: "good",
        },
      ];
    case "monster_attack":
      return [
        {
          id: nextLogId++,
          text:
            `💢 monster → ${nameOf(e.target)}: ${e.hp_damage} hp` +
            (e.shield_absorbed > 0 ? ` (+${e.shield_absorbed} shield)` : "") +
            (e.damage_after_position !== e.damage_after_armor
              ? ` [pos→ -${e.damage_after_armor - e.damage_after_position} mit]`
              : ""),
          tone: "bad",
        },
      ];
    case "boss_phase_transition":
      return [{ id: nextLogId++, text: "🔥 The boss enters phase 2!", tone: "bad" }];
    case "fighter_down":
      return [{ id: nextLogId++, text: `💀 ${nameOf(e.target)} is down.`, tone: "bad" }];
    case "monster_down":
      return [
        { id: nextLogId++, text: `🏆 ${nameOf(e.killed_by)} lands the killing blow.`, tone: "good" },
      ];
    case "victory":
      return [{ id: nextLogId++, text: "VICTORY", tone: "good" }];
    case "defeat":
      return [{ id: nextLogId++, text: "DEFEAT", tone: "bad" }];
    case "rejected":
      return [{ id: nextLogId++, text: `⚠ rejected: ${e.reason}`, tone: "bad" }];
  }
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

export function CombatPage({
  questId,
  selfId,
  onExit,
}: {
  questId: number;
  selfId: string;
  onExit: () => void;
}) {
  const [ui, dispatch] = useReducer(reducer, {
    connection: "connecting",
    state: null,
    log: [],
    error: null,
  });
  const wsRef = useRef<WebSocket | null>(null);
  const logScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/ws/quest/${questId}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => dispatch({ kind: "connection", value: "open" });
    ws.onclose = () => dispatch({ kind: "connection", value: "closed" });
    ws.onerror = () => dispatch({ kind: "error", value: "WebSocket error" });
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as
          | { type: "state"; state: CombatState }
          | { type: "events"; events: CombatEvent[] }
          | { type: "error"; message: string };
        if (msg.type === "state") dispatch({ kind: "state", value: msg.state });
        else if (msg.type === "events") dispatch({ kind: "events", value: msg.events });
        else if (msg.type === "error") dispatch({ kind: "error", value: msg.message });
      } catch {
        dispatch({ kind: "error", value: "bad message" });
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [questId]);

  // Auto-scroll log to bottom as new entries arrive.
  useEffect(() => {
    const el = logScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ui.log.length]);

  function send(action: TurnAction) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "action", action }));
  }

  async function exit() {
    try {
      await fetch(`/api/quest/${questId}/end_web_combat`, {
        method: "POST",
        credentials: "include",
      });
    } finally {
      onExit();
    }
  }

  const state = ui.state;
  const currentActorId =
    state && state.status === "active"
      ? state.turn_order[state.turn_index % state.turn_order.length]
      : null;
  const myTurn = currentActorId === selfId;
  const ended = state?.status === "victory" || state?.status === "defeat";

  return (
    <div style={page}>
      <div style={topBar}>
        <button onClick={exit} style={exitBtn}>
          ← Back
        </button>
        <span style={{ ...muted, fontSize: 12 }}>
          {ui.connection === "open" ? "● connected" : ui.connection === "connecting" ? "○ connecting" : "× disconnected"}
        </span>
      </div>

      {!state && (
        <div style={card}>
          <p style={muted}>Loading combat…</p>
          {ui.error && <p style={{ ...muted, color: "#c0392b" }}>{ui.error}</p>}
        </div>
      )}

      {state && (
        <>
          <MonsterCard monster={state.monster} round={state.round} />
          <InitiativeTrack
            order={state.turn_order}
            currentIndex={state.turn_index % state.turn_order.length}
            fighters={state.fighters}
            monster={state.monster}
            selfId={selfId}
          />
          <PartySection fighters={state.fighters} currentActorId={currentActorId} selfId={selfId} />
          {state.status === "active" && (
            <ActionBar disabled={!myTurn} onAct={(kind) => send({ kind, actor: selfId } as TurnAction)} />
          )}
          {!myTurn && state.status === "active" && currentActorId === MONSTER_ID && (
            <button style={{ ...button, background: "#5c1f1f" }} onClick={() => send({ kind: "monster_act" })}>
              Resolve monster turn
            </button>
          )}
          <EventLog log={ui.log} scrollRef={logScrollRef} />
          {ended && <EndBanner status={state.status as "victory" | "defeat"} />}
        </>
      )}
    </div>
  );
}

function MonsterCard({ monster, round }: { monster: Monster; round: number }) {
  return (
    <div style={{ ...card, borderColor: "#7c2020" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#f5f5f5" }}>{monster.name}</div>
          <div style={{ ...muted, fontSize: 12 }}>
            Tier {monster.tier}
            {monster.is_boss && ` · Boss (phase ${monster.boss_phase})`}
            {` · Round ${round}`}
          </div>
        </div>
        <div style={{ ...muted, fontVariantNumeric: "tabular-nums" }}>
          {monster.hp} / {monster.max_hp}
        </div>
      </div>
      <BigHpBar current={monster.hp} max={monster.max_hp} />
    </div>
  );
}

function InitiativeTrack({
  order,
  currentIndex,
  fighters,
  monster,
  selfId,
}: {
  order: string[];
  currentIndex: number;
  fighters: Fighter[];
  monster: Monster;
  selfId: string;
}) {
  return (
    <div style={card}>
      <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8 }}>
        Initiative
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {order.map((id, i) => {
          const name = id === MONSTER_ID ? monster.name : fighters.find((f) => f.id === id)?.name ?? id;
          const init = id === MONSTER_ID ? monster.initiative : fighters.find((f) => f.id === id)?.initiative ?? 0;
          const isCurrent = i === currentIndex;
          const isSelf = id === selfId;
          return (
            <div
              key={id}
              style={{
                padding: "8px 12px",
                borderRadius: 20,
                background: isCurrent ? "#b89b3a" : "#1d1f23",
                color: isCurrent ? "#0e0f12" : "#e6e6e6",
                fontSize: 13,
                fontWeight: 600,
                border: isSelf && !isCurrent ? "1px solid #3a7bd5" : "1px solid transparent",
              }}
            >
              {name} · {init}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PartySection({
  fighters,
  currentActorId,
  selfId,
}: {
  fighters: Fighter[];
  currentActorId: string | null;
  selfId: string;
}) {
  return (
    <div style={card}>
      <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8 }}>
        Party
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {fighters.map((f) => (
          <FighterRow
            key={f.id}
            fighter={f}
            self={f.id === selfId}
            current={f.id === currentActorId}
          />
        ))}
      </div>
    </div>
  );
}

function FighterRow({ fighter, self, current }: { fighter: Fighter; self: boolean; current: boolean }) {
  const down = fighter.hp <= 0;
  return (
    <div
      style={{
        padding: 12,
        background: "#1d1f23",
        borderRadius: 8,
        border: current ? "1px solid #b89b3a" : self ? "1px solid #3a7bd5" : "1px solid transparent",
        opacity: down ? 0.5 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 14 }}>{fighter.name}</span>
          <span style={{ ...muted, fontSize: 12 }}>
            {fighter.class} · Lv {fighter.level} · {fighter.position}
          </span>
          {self && (
            <span style={badge("#1f2a3a", "#7dd3fc", "#2a3a5a")}>you</span>
          )}
          {down && (
            <span style={badge("#3a1f1f", "#ff7676", "#5a2a2a")}>downed</span>
          )}
        </div>
        <div style={{ ...muted, fontVariantNumeric: "tabular-nums" }}>
          {fighter.hp}/{fighter.max_hp}
          {fighter.shield > 0 && (
            <span style={{ color: "#7c83ff", marginLeft: 6 }}>+{fighter.shield}</span>
          )}
        </div>
      </div>
      <HpBar current={fighter.hp} max={fighter.max_hp} />
      {fighter.max_mana > 0 && (
        <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ ...muted, fontSize: 11, minWidth: 36 }}>
            {fighter.mana}/{fighter.max_mana}
          </div>
          <div
            style={{
              flex: 1,
              height: 4,
              background: "#0e0f12",
              borderRadius: 2,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${(fighter.mana / Math.max(1, fighter.max_mana)) * 100}%`,
                height: "100%",
                background: "#6366f1",
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ActionBar({ disabled, onAct }: { disabled: boolean; onAct: (kind: "attack" | "cast" | "wait") => void }) {
  return (
    <div style={{ ...card, display: "flex", gap: 8, flexWrap: "wrap" }}>
      <ActionBtn label="Attack" hint="d20 + atk vs AC · 1d6 dmg" disabled={disabled} onClick={() => onAct("attack")} />
      <ActionBtn label="Cast" hint="d20 + mag vs AC · 1d8 dmg" disabled={disabled} onClick={() => onAct("cast")} />
      <ActionBtn label="Wait" hint="Skip your turn" disabled={disabled} onClick={() => onAct("wait")} />
    </div>
  );
}

function ActionBtn({
  label,
  hint,
  disabled,
  onClick,
}: {
  label: string;
  hint: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...button,
        flex: "1 1 140px",
        marginTop: 0,
        background: disabled ? "#2a2d33" : "#3a7bd5",
        color: disabled ? "#6a7080" : "#fff",
        cursor: disabled ? "not-allowed" : "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <span>{label}</span>
      <span style={{ fontSize: 11, fontWeight: 400, opacity: 0.8 }}>{hint}</span>
    </button>
  );
}

function EventLog({
  log,
  scrollRef,
}: {
  log: UiState["log"];
  scrollRef: React.MutableRefObject<HTMLDivElement | null>;
}) {
  return (
    <div style={card}>
      <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8 }}>
        Combat log
      </div>
      <div
        ref={scrollRef}
        style={{
          maxHeight: 280,
          overflowY: "auto",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 12,
          background: "#0e0f12",
          borderRadius: 8,
          padding: 12,
          display: "grid",
          gap: 4,
        }}
      >
        {log.length === 0 && <span style={muted}>Waiting for events…</span>}
        {log.map((line) => (
          <div key={line.id} style={{ color: TONE_COLOR[line.tone] }}>
            {line.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function EndBanner({ status }: { status: "victory" | "defeat" }) {
  const win = status === "victory";
  return (
    <div
      style={{
        ...card,
        borderColor: win ? "#16a34a" : "#7c2020",
        background: win ? "#0f2818" : "#28100f",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 32, fontWeight: 800, color: win ? "#86efac" : "#fca5a5" }}>
        {win ? "VICTORY" : "DEFEAT"}
      </div>
      <p style={muted}>
        Click <strong>← Back</strong> to return. Outcome resolution (XP, loot) is wired in Phase 2d.
      </p>
    </div>
  );
}

// ─── styles + helpers ──────────────────────────────────────────────────────

function BigHpBar({ current, max }: { current: number; max: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  const color = pct < 0.25 ? "#fca5a5" : pct < 0.5 ? "#fbbf24" : "#ef4444";
  return (
    <div
      style={{
        marginTop: 10,
        width: "100%",
        height: 14,
        background: "#0e0f12",
        borderRadius: 7,
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

function HpBar({ current, max }: { current: number; max: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  const color = pct < 0.25 ? "#dc2626" : pct < 0.5 ? "#d97706" : "#16a34a";
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

function badge(bg: string, fg: string, border: string): React.CSSProperties {
  return {
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 1,
    padding: "2px 6px",
    borderRadius: 4,
    border: `1px solid ${border}`,
    fontWeight: 600,
    background: bg,
    color: fg,
  };
}

const TONE_COLOR: Record<string, string> = {
  info: "#e6e6e6",
  good: "#86efac",
  bad: "#fca5a5",
  muted: "#9aa0a6",
};

const page: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  width: "100%",
  maxWidth: 720,
  margin: "0 auto",
  padding: 24,
};
const topBar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};
const card: React.CSSProperties = {
  background: "#15171b",
  padding: 24,
  borderRadius: 12,
  width: "100%",
  border: "1px solid #2a2d33",
  boxSizing: "border-box",
};
const muted: React.CSSProperties = { color: "#9aa0a6", fontSize: 14, margin: 0 };
const button: React.CSSProperties = {
  marginTop: 12,
  width: "100%",
  padding: "12px 14px",
  fontSize: 16,
  fontWeight: 600,
  borderRadius: 8,
  border: "none",
  background: "#3a7bd5",
  color: "#fff",
  cursor: "pointer",
};
const exitBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #2a2d33",
  color: "#e6e6e6",
  padding: "6px 12px",
  borderRadius: 8,
  fontSize: 13,
  cursor: "pointer",
};
