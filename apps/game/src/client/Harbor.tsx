// Screens a player passes through before reaching the shared Harbor:
// character creation (roll and re-roll starting stats) and choosing a crew.
// The character sheet itself lives in InventoryScreen.tsx.

import { useState } from "react";
import { STARTING_STATS } from "@gantt-quest/core";
import { HARBOR_NAME, HERO_CLASSES, STAT_BLURB, STAT_KEYS, STAT_LABEL, WEAPONS, statPct } from "@gantt-quest/world";
import { EmailSignIn } from "./Account";
import { api, type Character, type Me, type StatKey } from "./api";

type Act = (fn: () => Promise<unknown>) => Promise<void>;

/** Run an API call, then reload the player; surfaces any error. */
export function useAct(refresh: () => Promise<unknown>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act: Act = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, act };
}

interface Props {
  me: Me;
  refresh(): Promise<unknown>;
  /** A crew invite code from the URL (#crew/CODE), offered as the default. */
  invite: string | null;
}

export function Harbor({ me, refresh, invite }: Props) {
  const { busy, error, act } = useAct(refresh);
  const hasCharacter = me.character?.status === "active";
  return (
    <div className="harbor">
      <header>
        <h1>{HARBOR_NAME}</h1>
        <p className="muted">Your crew's base between voyages. Every island is a new story.</p>
      </header>
      {error && <div className="banner error">{error}</div>}
      {hasCharacter ? <CrewGate busy={busy} act={act} invite={invite} /> : <Creation draft={me.character} busy={busy} act={act} invite={invite} />}
      {me.player.email ? (
        <p className="muted signed-in">Signed in as {me.player.email}.</p>
      ) : (
        <section className="panel returning">
          <h2>Played before?</h2>
          <p className="muted">Sign in with your email to pick up your character, gear and crew.</p>
          <EmailSignIn onDone={refresh} hasCharacter={hasCharacter} />
        </section>
      )}
    </div>
  );
}

function CrewGate({ busy, act, invite }: { busy: boolean; act: Act; invite: string | null }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState(invite ?? "");
  return (
    <div className="harbor-grid">
      <section className="panel">
        <h2>Join a crew</h2>
        <p className="muted">A crew shares one Harbor: you see each other there, moor ships at the same docks and keep one voyage log. Paste the invite code a crewmate sent you.</p>
        <div className="row">
          <input value={code} maxLength={6} placeholder="INVITE" onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))} />
          <button className="primary" disabled={busy || code.length !== 6} onClick={() => act(() => api.joinCrew(code))}>
            Join
          </button>
        </div>
      </section>
      <section className="panel">
        <h2>Found a crew</h2>
        <p className="muted">Start a new Harbor and invite others to it.</p>
        <div className="row">
          <input value={name} maxLength={30} placeholder="Crew name" onChange={(e) => setName(e.target.value)} />
          <button disabled={busy || name.trim().length < 2} onClick={() => act(() => api.createCrew(name))}>
            Found
          </button>
        </div>
      </section>
    </div>
  );
}

function StatRow({ stat, value, base, children }: { stat: StatKey; value: number; base?: number; children?: React.ReactNode }) {
  const delta = base === undefined ? 0 : value - base;
  return (
    <div className="stat-row" title={STAT_BLURB[stat]}>
      <span className="stat-name">{STAT_LABEL[stat]}</span>
      <span className="stat-value">{value}</span>
      <span className={delta > 0 ? "good" : delta < 0 ? "bad" : "muted"}>{base === undefined ? "" : delta > 0 ? `+${delta}` : delta || "·"}</span>
      <span className="muted">{statPct(value)}% per roll</span>
      {children}
      <span className="stat-blurb">{STAT_BLURB[stat]}</span>
    </div>
  );
}

function Creation({ draft, busy, act, invite }: { draft: Character | null; busy: boolean; act: Act; invite: string | null }) {
  const [name, setName] = useState(draft?.name ?? "");
  const [classId, setClassId] = useState(draft?.class_id ?? HERO_CLASSES[0].id);
  const rolled = draft && draft.class_id === classId ? draft : null;
  const validName = name.trim().length >= 2;

  return (
    <section className="panel">
      <h2>Create your character</h2>
      {invite && <p className="banner">You were invited to a crew. Create a character first, then you can join it.</p>}
      <label className="field">
        <span>Name</span>
        <input value={name} maxLength={20} onChange={(e) => setName(e.target.value)} placeholder="What do they call you?" />
      </label>
      <div className="class-grid">
        {HERO_CLASSES.map((c) => (
          <button key={c.id} className={`class-card ${classId === c.id ? "selected" : ""}`} onClick={() => setClassId(c.id)}>
            <strong>{c.name}</strong>
            <span>{c.blurb}</span>
            <span className="muted">Starts with {WEAPONS[c.weapons[0]].name}</span>
          </button>
        ))}
      </div>
      {rolled ? (
        <div className="stats">
          <p className="muted">Rolled stats, compared with the class baseline. Re-roll as often as you like.</p>
          {STAT_KEYS.map((k) => (
            <StatRow key={k} stat={k} value={rolled[k]} base={STARTING_STATS[classId][k]} />
          ))}
        </div>
      ) : (
        <p className="muted">Roll to see this class's starting stats.</p>
      )}
      <div className="row">
        <button disabled={busy || !validName} onClick={() => act(() => api.roll(classId, name))}>
          {rolled ? "Re-roll stats" : "Roll stats"}
        </button>
        <button className="primary" disabled={busy || !rolled || !validName} onClick={() => act(() => api.confirm())}>
          Begin with these
        </button>
      </div>
    </section>
  );
}
