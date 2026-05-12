import { useEffect, useState } from "react";

// Minimal v1 surface: login form → character read-only card. No router; the
// view flips based on whether /api/me returns a session. Once we add more
// pages we'll move to react-router.

interface Character {
  slack_user_id: string;
  name: string;
  class: string;
  level: number;
  xp: number;
  hp: number;
  max_hp: number;
  mana: number;
  max_mana: number;
  shield: number;
  gold: number;
  scars: string[];
  keys_bronze: number;
  keys_silver: number;
  keys_gold: number;
}

interface MeResponse {
  slack_user_id: string;
  slack_team_id: string;
  character: Character | null;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "anon" }
  | { kind: "auth"; me: MeResponse };

export function App() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    const res = await fetch("/api/me", { credentials: "include" });
    if (res.status === 401) {
      setState({ kind: "anon" });
      return;
    }
    const me = (await res.json()) as MeResponse;
    setState({ kind: "auth", me });
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    setState({ kind: "anon" });
  }

  if (state.kind === "loading") return <Centered>Loading…</Centered>;
  if (state.kind === "anon") return <Login onSuccess={refresh} />;
  return <CharacterView me={state.me} onLogout={logout} />;
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
        ? "Invalid or expired code. Run /sq web-login in Slack for a new one."
        : "Couldn't verify. Try again.",
    );
  }

  return (
    <Centered>
      <div style={card}>
        <h1 style={h1}>Slack Quest</h1>
        <p style={muted}>
          Run <code style={kbd}>/sq web-login</code> in Slack to get a 6-digit
          code, then paste it below.
        </p>
        <form onSubmit={submit}>
          <input
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="123456"
            style={input}
            autoFocus
          />
          <button type="submit" disabled={pending} style={button}>
            {pending ? "Verifying…" : "Sign in"}
          </button>
        </form>
        {error && <p style={{ ...muted, color: "#c0392b" }}>{error}</p>}
      </div>
    </Centered>
  );
}

function CharacterView({
  me,
  onLogout,
}: {
  me: MeResponse;
  onLogout: () => void;
}) {
  const c = me.character;
  if (!c) {
    return (
      <Centered>
        <div style={card}>
          <h1 style={h1}>No character yet</h1>
          <p style={muted}>
            Roll one up in Slack with <code style={kbd}>/sq quest</code>, then
            reload here.
          </p>
          <button onClick={onLogout} style={button}>
            Sign out
          </button>
        </div>
      </Centered>
    );
  }
  return (
    <Centered>
      <div style={{ ...card, maxWidth: 520 }}>
        <h1 style={h1}>{c.name}</h1>
        <p style={muted}>
          {c.class} • Lv {c.level} • {c.xp} XP
        </p>
        <Stats>
          <Stat label="HP" value={`${c.hp} / ${c.max_hp}`} />
          <Stat label="Mana" value={`${c.mana} / ${c.max_mana}`} />
          <Stat label="Shield" value={c.shield.toString()} />
          <Stat label="Gold" value={c.gold.toString()} />
          <Stat label="Scars" value={c.scars.length.toString()} />
          <Stat
            label="Keys"
            value={`🥉${c.keys_bronze} 🥈${c.keys_silver} 🥇${c.keys_gold}`}
          />
        </Stats>
        <button onClick={onLogout} style={{ ...button, marginTop: 24 }}>
          Sign out
        </button>
      </div>
    </Centered>
  );
}

function Stats({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 12,
        marginTop: 16,
      }}
    >
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: 12, background: "#1d1f23", borderRadius: 8 }}>
      <div style={{ ...muted, fontSize: 12, textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 600, color: "#f5f5f5" }}>
        {value}
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0e0f12",
        fontFamily:
          "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color: "#e6e6e6",
        padding: 16,
      }}
    >
      {children}
    </div>
  );
}

const card: React.CSSProperties = {
  background: "#15171b",
  padding: 32,
  borderRadius: 12,
  maxWidth: 380,
  width: "100%",
  border: "1px solid #2a2d33",
};
const h1: React.CSSProperties = { margin: 0, fontSize: 28, color: "#f5f5f5" };
const muted: React.CSSProperties = { color: "#9aa0a6", fontSize: 14 };
const input: React.CSSProperties = {
  width: "100%",
  fontSize: 24,
  padding: "12px 14px",
  borderRadius: 8,
  border: "1px solid #2a2d33",
  background: "#0e0f12",
  color: "#f5f5f5",
  marginTop: 16,
  letterSpacing: 4,
  textAlign: "center",
  boxSizing: "border-box",
};
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
const kbd: React.CSSProperties = {
  background: "#222428",
  padding: "2px 6px",
  borderRadius: 4,
  fontSize: 13,
};
