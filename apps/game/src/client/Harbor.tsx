// The Harbor: the base of operations between voyages. Character creation
// (roll and re-roll starting stats), the character sheet, gear, and the
// docks where a ship is launched or boarded.

import { useState } from "react";
import { STARTING_STATS } from "@gantt-quest/core";
import { HERO_CLASSES, STAT_KEYS, STAT_LABEL, WEAPONS, statPct, xpToNext } from "@gantt-quest/world";
import { api, type Character, type InventoryItem, type Me, type StatKey } from "./api";

interface Props {
  me: Me;
  refresh(): Promise<unknown>;
  /** A run code from the URL the player could not join yet (no character). */
  pendingCode: string | null;
}

export function Harbor({ me, refresh, pendingCode }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
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

  return (
    <div className="harbor">
      <header>
        <h1>The Harbor</h1>
        <p className="muted">Your base between voyages. Every island is a new story.</p>
      </header>
      {error && <div className="banner error">{error}</div>}
      {me.character?.status === "active" ? (
        <Sheet character={me.character} inventory={me.inventory} busy={busy} act={act} setError={setError} />
      ) : (
        <Creation draft={me.character} busy={busy} act={act} pendingCode={pendingCode} />
      )}
    </div>
  );
}

function StatRow({ stat, value, base, children }: { stat: StatKey; value: number; base?: number; children?: React.ReactNode }) {
  const delta = base === undefined ? 0 : value - base;
  return (
    <div className="stat-row">
      <span className="stat-name">{STAT_LABEL[stat]}</span>
      <span className="stat-value">{value}</span>
      <span className={delta > 0 ? "good" : delta < 0 ? "bad" : "muted"}>{base === undefined ? "" : delta > 0 ? `+${delta}` : delta || "·"}</span>
      <span className="muted">{statPct(value)}% per roll</span>
      {children}
    </div>
  );
}

function Creation({ draft, busy, act, pendingCode }: { draft: Character | null; busy: boolean; act(fn: () => Promise<unknown>): void; pendingCode: string | null }) {
  const [name, setName] = useState(draft?.name ?? "");
  const [classId, setClassId] = useState(draft?.class_id ?? HERO_CLASSES[0].id);
  const rolled = draft && draft.class_id === classId ? draft : null;
  const validName = name.trim().length >= 2;

  return (
    <section className="panel">
      <h2>Create your character</h2>
      {pendingCode && <p className="banner">You were invited aboard ship {pendingCode}. Create a character and you will board it.</p>}
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

function Sheet({
  character: c,
  inventory,
  busy,
  act,
  setError,
}: {
  character: Character;
  inventory: InventoryItem[];
  busy: boolean;
  act(fn: () => Promise<unknown>): void;
  setError(e: string | null): void;
}) {
  const [join, setJoin] = useState("");
  const cls = HERO_CLASSES.find((k) => k.id === c.class_id);
  const bonus = (stat: StatKey) =>
    inventory.filter((i) => i.equipped).reduce((a, i) => a + ((JSON.parse(i.stat_bonus_json) as Partial<Record<StatKey, number>>)[stat] ?? 0), 0);
  const sail = async () => {
    try {
      const { code } = await api.createRun();
      location.hash = `run/${code}`;
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const describe = (i: InventoryItem) => {
    const b = JSON.parse(i.stat_bonus_json) as Partial<Record<StatKey, number>>;
    const parts = STAT_KEYS.filter((k) => b[k]).map((k) => `+${b[k]} ${STAT_LABEL[k]}`);
    if (i.kind === "weapon") parts.push(WEAPONS[i.ref]?.abilities.length + " abilities");
    return parts.join(", ");
  };

  return (
    <div className="harbor-grid">
      <section className="panel">
        <h2>
          {c.name} <span className="muted">· {cls?.name} · Level {c.level}</span>
        </h2>
        <div className="bar" title={`${c.xp} / ${xpToNext(c.level)} XP`}>
          <div className="bar-fill xp" style={{ width: `${(100 * c.xp) / xpToNext(c.level)}%` }} />
        </div>
        <p className="muted">
          {c.xp} / {xpToNext(c.level)} XP · {c.gold} gold
          {c.unspent_points > 0 && <strong className="good"> · {c.unspent_points} stat point{c.unspent_points > 1 ? "s" : ""} to spend</strong>}
        </p>
        <div className="stats">
          {STAT_KEYS.map((k) => (
            <StatRow key={k} stat={k} value={c[k] + bonus(k)}>
              {c.unspent_points > 0 && (
                <button className="small" disabled={busy} onClick={() => act(() => api.spend(k))}>
                  +1
                </button>
              )}
            </StatRow>
          ))}
        </div>
        <h3>Gear</h3>
        <ul className="gear">
          {inventory.map((i) => (
            <li key={i.id} className={`rarity-${i.rarity}`}>
              <span>
                <strong>{i.name}</strong> <span className="muted">{describe(i)}</span>
              </span>
              {i.equipped ? (
                <span className="tag">equipped</span>
              ) : (
                <button className="small" disabled={busy} onClick={() => act(() => api.equip(i.id))}>
                  Equip
                </button>
              )}
            </li>
          ))}
        </ul>
        <button
          className="danger small"
          disabled={busy}
          onClick={() => {
            if (confirm("Re-roll? This discards the character and all its gear.")) act(() => api.reroll());
          }}
        >
          Re-roll character
        </button>
      </section>

      <section className="panel">
        <h2>The docks</h2>
        <p className="muted">Load up a ship and sail for an island. Each island is one session: a small world with its own story.</p>
        <button className="primary" disabled={busy} onClick={sail}>
          Set sail for a new island
        </button>
        <h3>Board a friend's ship</h3>
        <div className="row">
          <input value={join} maxLength={4} placeholder="CODE" onChange={(e) => setJoin(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))} />
          <button disabled={join.length !== 4} onClick={() => (location.hash = `run/${join}`)}>
            Board
          </button>
        </div>
      </section>
    </div>
  );
}
