// Screens a player passes through before reaching the shared Harbor:
// character creation (roll and re-roll starting stats) and choosing a crew.
// The character sheet itself lives in InventoryScreen.tsx.

import { useMemo, useRef, useState } from "react";
import { STARTING_STATS } from "@gantt-quest/core";
import { HERO_CLASSES, RARITY_COLOR, STAT_BLURB, STAT_KEYS, STAT_LABEL, WEAPON_ICON, statPct } from "@gantt-quest/world";
import { EmailSignIn } from "./Account";
import { api, type Character, type Me, type StatKey } from "./api";
import { Icon } from "./items";
import { blurb, label } from "./labels";
import { spriteDataUrl } from "./render/sprites";
import { AnchorMark, HarborBackdrop, HarborTitle } from "./Welcome";

/** The game's name, as the browser tab shows it (index.html). */
const GAME_TITLE = "The Harbor of Heylets";

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
  const [signInOpen, setSignInOpen] = useState(false);
  const returning = useRef<HTMLDetailsElement>(null);
  const showSignIn = () => {
    setSignInOpen(true);
    // Wait for the panel to open, then bring it into view and put the cursor in the email box.
    requestAnimationFrame(() => {
      returning.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      returning.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    });
  };
  return (
    <>
      <HarborBackdrop />
      <div className="harbor">
        <header className="harbor-hero">
          <AnchorMark />
          <HarborTitle name={GAME_TITLE} />
          <p className="harbor-tagline">Your crew's base between voyages. Every island is a new story.</p>
          {!me.player.email && !hasCharacter && (
            <p className="harbor-returning-hint">
              Played before? <button className="link" onClick={showSignIn}>Sign in to pick up your character</button>
            </p>
          )}
        </header>
        {error && <div className="banner error" role="alert">{error}</div>}
        {hasCharacter ? <CrewGate busy={busy} act={act} invite={invite} /> : <Creation draft={me.character} busy={busy} act={act} invite={invite} />}
        {me.player.email ? (
          <p className="muted signed-in">Signed in as {me.player.email}.</p>
        ) : (
          <details ref={returning} className="panel returning" open={signInOpen} onToggle={(e) => setSignInOpen(e.currentTarget.open)}>
            <summary>
              <span className="returning-title">Played before?</span>
              <span className="muted">Sign in with your email to pick up your character, gear and crew.</span>
            </summary>
            <EmailSignIn onDone={refresh} hasCharacter={hasCharacter} />
          </details>
        )}
      </div>
    </>
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


/** What each class is for in a party, shown as tags on its card. Flavour only: the rules never read it. */
const ROLES: Record<string, string[]> = {
  qa_paladin: ["Tank", "Melee"],
  devops_mage: ["Caster", "Healer"],
  refactor_rogue: ["Striker", "Fast"],
  backend_druid: ["Healer", "Control"],
  frontend_bard: ["Buffer", "Support"],
  staff_sage: ["Caster", "Burst"],
  sre_warden: ["Tank", "Guard"],
  data_warlock: ["Caster", "Curses"],
};
const STAT_SHORT: Record<StatKey, string> = { str: "STR", int_stat: "INT", vit: "VIT", agi: "AGI", dex: "DEX" };
/** Cells in a stat bar. Starting stats run 2 to 11. */
const BAR_CELLS = 12;

/** The stat a class leans on most, from its baseline. */
const mainStat = (classId: string): StatKey => {
  const base = STARTING_STATS[classId];
  return STAT_KEYS.reduce((best, k) => (base[k] > base[best] ? k : best), STAT_KEYS[0]);
};

/** A stat as a row of pixel cells, with the class baseline marked. Unrolled, it shows the baseline alone. */
function StatBar({ stat, value, base, rolled }: { stat: StatKey; value: number; base: number; rolled: boolean }) {
  const delta = value - base;
  const id = `stat-${stat}`;
  return (
    <div className={`statbar ${rolled ? "rolled" : ""}`}>
      <span className="statbar-name" title={STAT_LABEL[stat]}>
        <abbr title={STAT_LABEL[stat]}>{STAT_SHORT[stat]}</abbr>
        <span className="statbar-long">{STAT_LABEL[stat]}</span>
      </span>
      <span className="statbar-cells" role="meter" aria-label={STAT_LABEL[stat]} aria-valuemin={0} aria-valuemax={BAR_CELLS} aria-valuenow={value} aria-describedby={`${id}-blurb`}>
        {Array.from({ length: BAR_CELLS }, (_, i) => (
          <span key={i} className={`cell ${i < value ? (i < base ? "on" : "up") : i < base ? "lost" : ""} ${i === base - 1 ? "base" : ""}`} />
        ))}
      </span>
      <span className="statbar-value" aria-hidden>{value}</span>
      <span className={`statbar-delta ${delta > 0 ? "good" : delta < 0 ? "bad" : "muted"}`}>{rolled ? (delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : "±0") : ""}</span>
      <span className="statbar-pct muted">{statPct(value)}%</span>
      <span className="statbar-blurb" id={`${id}-blurb`}>{STAT_BLURB[stat]}</span>
    </div>
  );
}

function Creation({ draft, busy, act, invite }: { draft: Character | null; busy: boolean; act: Act; invite: string | null }) {
  const [name, setName] = useState(draft?.name ?? "");
  const [classId, setClassId] = useState(draft?.class_id ?? HERO_CLASSES[0].id);
  const rolled = draft && draft.class_id === classId ? draft : null;
  const validName = name.trim().length >= 2;
  const cls = HERO_CLASSES.find((c) => c.id === classId) ?? HERO_CLASSES[0];
  const sprites = useMemo(() => Object.fromEntries(HERO_CLASSES.map((c) => [c.id, spriteDataUrl(c.id)])), []);
  const base = STARTING_STATS[classId];

  return (
    <section className="panel creation" aria-labelledby="creation-title">
      <h2 id="creation-title">Create your character</h2>
      {invite && <p className="banner">You were invited to a crew. Create a character first, then you can join it.</p>}

      <div className="step">
        <h3 className="step-title"><span className="step-num">1</span><label htmlFor="hero-name">Name your hero</label></h3>
        <input id="hero-name" className="hero-name" value={name} maxLength={20} autoComplete="nickname" onChange={(e) => setName(e.target.value)} placeholder="What do they call you?" aria-describedby="hero-name-hint" />
        <p id="hero-name-hint" className={`hint ${name && !validName ? "bad" : "muted"}`}>Two to twenty characters.</p>
      </div>

      <div className="step">
        <h3 className="step-title" id="class-title"><span className="step-num">2</span>Choose a class</h3>
        <div className="class-grid" role="group" aria-labelledby="class-title">
          {HERO_CLASSES.map((c) => {
            const on = classId === c.id;
            const main = mainStat(c.id);
            return (
              <button key={c.id} className={`class-card ${on ? "selected" : ""}`} aria-pressed={on} onClick={() => setClassId(c.id)}>
                <span className="cc-head">
                  <span className="cc-figure"><img className="pixel-icon" src={sprites[c.id]} alt="" width={54} height={66} /></span>
                  <span className="cc-title">
                    <strong className="cc-name">{label("class", c.id)}</strong>
                    <span className="cc-tags">
                      {(ROLES[c.id] ?? []).map((r) => <span key={r} className={`role-tag role-${r.toLowerCase()}`}>{r}</span>)}
                      <span className="role-tag stat-tag" title={`Leans on ${STAT_LABEL[main]}`}>{STAT_SHORT[main]}</span>
                    </span>
                  </span>
                  {on && <span className="cc-check" aria-hidden>✔</span>}
                </span>
                <span className="cc-blurb">{blurb("class", c.id)}</span>
                {c.passive && (
                  <span className="cc-passive"><span className="cc-passive-label">Passive</span>{c.passive}</span>
                )}
                <span className="cc-weapon">
                  <Icon name={WEAPON_ICON[c.weapons[0]] ?? "broadsword"} color={RARITY_COLOR.common} size={18} />
                  <span>Starts with <strong>{label("weapon", c.weapons[0])}</strong></span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="step">
        <h3 className="step-title"><span className="step-num">3</span>Roll your stats</h3>
        <div className="hero-sheet">
          <div className="hero-portrait">
            <span className="hero-plinth"><img className="pixel-icon" src={sprites[classId]} alt="" width={108} height={132} /></span>
            <strong className="hero-portrait-name">{name.trim() || "Your hero"}</strong>
            <span className="muted">{label("class", classId)}</span>
            <span className="cc-weapon">
              <Icon name={WEAPON_ICON[cls.weapons[0]] ?? "broadsword"} color={RARITY_COLOR.common} size={18} />
              {label("weapon", cls.weapons[0])}
            </span>
          </div>
          <div className="stat-sheet">
            <p className="muted stat-sheet-note" aria-live="polite">
              {rolled ? "Your rolled stats. Green cells beat the class baseline; dashed red ones fall short of it. Re-roll as often as you like." : `${label("class", classId)} baseline. Roll to see where your hero lands.`}
            </p>
            {STAT_KEYS.map((k) => (
              <StatBar key={k} stat={k} value={rolled ? rolled[k] : base[k]} base={base[k]} rolled={!!rolled} />
            ))}
            <p className="muted small-print">The % is your chance per die when that stat is tested.</p>
          </div>
        </div>
        <div className="creation-actions">
          <button className={`big ${rolled ? "" : "roll"}`} disabled={busy || !validName} onClick={() => act(() => api.roll(classId, name))} aria-describedby={!validName ? "hero-name-hint" : undefined}>
            <span aria-hidden>🎲</span> {rolled ? "Re-roll stats" : "Roll stats"}
          </button>
          <button className="primary big" disabled={busy || !rolled || !validName} onClick={() => act(() => api.confirm())}>
            Begin with these <span aria-hidden>▸</span>
          </button>
          {!validName ? <span className="muted hint">Name your hero to roll.</span> : !rolled ? <span className="muted hint">Roll once to unlock Begin.</span> : null}
        </div>
      </div>
    </section>
  );
}
