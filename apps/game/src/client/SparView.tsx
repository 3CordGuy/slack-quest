// The Harbor's sparring ring: a practice fight for one hero, in their real
// gear, against a training dummy or an enemy of their choosing.
//
// The whole bout runs in this browser on the same battle rules a voyage
// uses. Nothing is sent to the server, so nothing is won, lost or saved, and
// the rest of the crew does not see it. While it is open this view borrows
// the Harbor's renderer: a bout is drawn by handing it the Harbor scene with
// a battle attached.

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  ABILITIES,
  DUMMY_KIND,
  EFFECT_INFO,
  ENEMIES,
  HERO_CLASSES,
  STAT_LABEL,
  WEAPONS,
  createBattle,
  gearSheet,
  heroCombatant,
  makeRng,
  stepBattle,
  type BattleAction,
  type BattleEvent,
  type BattleState,
  type BattleStatus,
  type CheckResult,
  type HeroSheet,
  type Rng,
} from "@gantt-quest/world";
import type { Me } from "./api";
import { BattleHud } from "./BattleHud";
import { toOwned } from "./items";
import { spriteDataUrl } from "./render/sprites";
import type { RenderState, WorldRenderer } from "./render/WorldRenderer";
import "./spar.css";

/** The Harbor POI a bout is staged over. */
const RING_POI = "ring";
const MAX_OPPONENTS = 3;
/** Seconds the renderer gives each blow; matches the beat in WorldRenderer.playEvents. */
const BEAT_MS = 380;

const OPPONENTS = Object.values(ENEMIES).sort((a, b) => rank(a.kind) - rank(b.kind));
function rank(kind: string): number {
  return kind === DUMMY_KIND ? 0 : ENEMIES[kind].boss ? 2 : 1;
}

/** The player's character and equipped gear, as the battle rules see a hero. */
function sheetOf(me: Me, id: string): HeroSheet {
  const c = me.character!;
  const worn = me.inventory.map(toOwned).filter((i) => i.equipped);
  return {
    id,
    name: c.name,
    classId: c.class_id,
    level: c.level,
    base: { str: c.str, int_stat: c.int_stat, vit: c.vit, agi: c.agi, dex: c.dex },
    ...gearSheet(c.class_id, worn),
  };
}

function describe(ev: BattleEvent, n: (id: string) => string): string | null {
  switch (ev.t) {
    case "hit": return `${n(ev.actor)}: ${ev.ability} hits ${n(ev.target)} for ${ev.amount}${ev.perfect ? " (perfect!)" : ""}.`;
    case "miss": return `${n(ev.actor)}: ${ev.ability} misses ${n(ev.target)}.`;
    case "heal": return `${n(ev.actor)}: ${ev.ability} restores ${ev.amount} HP to ${n(ev.target)}.`;
    case "effect": return `${n(ev.target)} is ${EFFECT_INFO[ev.effect].name.toLowerCase()}.`;
    case "tick": return `${n(ev.target)} takes ${ev.amount} from ${EFFECT_INFO[ev.effect].name.toLowerCase()}.`;
    case "skip": return `${n(ev.id)} is stunned and loses the turn.`;
    case "down": return `${n(ev.id)} goes down!`;
    case "flee": return ev.ok ? `${n(ev.actor)} steps out of the ring.` : `${n(ev.actor)} fails to break away.`;
    default: return null;
  }
}

const RESULT: Record<Exclude<BattleStatus, "active">, { title: string; line: string; tone: string }> = {
  victory: { title: "You win the bout", line: "A clean finish.", tone: "good" },
  defeat: { title: "You are knocked down", line: "Only your pride is hurt.", tone: "bad" },
  fled: { title: "You step out of the ring", line: "The bout is called off.", tone: "muted" },
};

interface Bout {
  battle: BattleState;
  rng: Rng;
}

interface Props {
  me: Me;
  /** The Harbor as it is drawn when nobody is fighting. */
  scene: RenderState;
  renderer: RefObject<WorldRenderer | null>;
  onClose(): void;
}

export function SparView({ me, scene, renderer, onClose }: Props) {
  const [kind, setKind] = useState(DUMMY_KIND);
  const [count, setCount] = useState(1);
  const [bout, setBout] = useState<Bout | null>(null);
  const [feed, setFeed] = useState<string[]>([]);
  const [shown, setShown] = useState<{ who: string; check: CheckResult } | null>(null);
  const [result, setResult] = useState<Exclude<BattleStatus, "active"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Events from the latest step, waiting for the renderer to have the state they belong to. */
  const queue = useRef<BattleEvent[]>([]);

  const sheet = useMemo(() => sheetOf(me, scene.you), [me, scene.you]);
  const def = ENEMIES[kind];
  const many = def.boss ? 1 : count;
  const battle = bout?.battle ?? null;

  // Draw the bout over the ring, or the plain Harbor while choosing an opponent.
  const view = useMemo<RenderState>(
    () => (battle ? { ...scene, phase: "battle", battle: { ...battle, npcId: null, deadline: null } } : scene),
    [scene, battle],
  );
  useEffect(() => {
    const r = renderer.current;
    if (!r) return;
    r.setState(view);
    r.playEvents(queue.current.splice(0).map((ev) => ({ t: "battle", ev })));
  }, [view, renderer]);

  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), 2600);
    return () => clearTimeout(t);
  }, [shown]);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 3000);
    return () => clearTimeout(t);
  }, [error]);

  // Hold the result back until the last blows have played out.
  const status = battle?.status ?? "active";
  const blows = useRef(0);
  useEffect(() => {
    if (status === "active") return;
    const t = setTimeout(() => setResult(status), 500 + blows.current * BEAT_MS);
    return () => clearTimeout(t);
  }, [status, bout]);

  /** Show what a step did: the feed, the roll, and the renderer's animations. */
  const report = (next: BattleState, events: BattleEvent[]) => {
    const names = new Map(next.combatants.map((c) => [c.id, c.name]));
    const n = (id: string) => names.get(id) ?? "Someone";
    const lines = events.map((ev) => describe(ev, n)).filter((l): l is string => !!l);
    if (lines.length) setFeed((f) => [...f, ...lines].slice(-40));
    for (const ev of events) if (ev.t === "check") setShown({ who: n(ev.actor), check: ev.check });
    blows.current = events.filter((ev) => ev.t === "hit" || ev.t === "miss" || ev.t === "heal" || ev.t === "tick").length;
    queue.current.push(...events);
  };

  const begin = () => {
    // A fresh seed, a rested hero and a new set of opponents for every bout.
    const rng = makeRng(crypto.getRandomValues(new Uint32Array(1))[0]);
    const created = createBattle(
      { heroes: [heroCombatant(sheet)], enemyKinds: Array.from({ length: many }, () => kind), avgLevel: sheet.level, poiId: RING_POI },
      rng,
    );
    queue.current = [];
    setFeed([`${sheet.name} squares up to ${many > 1 ? `${many} × ` : ""}${def.name}.`]);
    setResult(null);
    setShown(null);
    report(created.state, created.events);
    setBout({ battle: created.state, rng });
  };

  const act = (action: BattleAction) => {
    if (!bout || bout.battle.status !== "active") return;
    const res = stepBattle(bout.battle, sheet.id, action, bout.rng);
    if (!res.ok) return setError(res.error);
    report(res.state, res.events);
    setBout({ battle: res.state, rng: bout.rng });
  };

  const choose = () => {
    setBout(null);
    setResult(null);
    setShown(null);
  };

  const weapon = WEAPONS[sheet.weapon];
  const className = HERO_CLASSES.find((c) => c.id === sheet.classId)?.name ?? sheet.classId;

  return (
    <div className="spar">
      {!battle && (
        <div className="overlay">
          <div className="panel spar-pick">
            <h2>The sparring ring</h2>
            <p className="muted">A practice bout. You start rested, in the gear you are wearing. Nothing is won, lost or saved.</p>
            <div className="spar-hero">
              <img className="pixel-icon" alt="" src={spriteDataUrl(sheet.classId, sheet.outfit)} />
              <div>
                <strong>{sheet.name}</strong> <span className="muted">{className} · Level {sheet.level}</span>
                <div className="muted">{weapon?.name ?? "Unarmed"}{sheet.weaponPower > 0 ? ` · +${sheet.weaponPower} damage` : ""}{sheet.armor > 0 ? ` · armor ${sheet.armor}` : ""}</div>
                <ul className="spar-abilities">
                  {(weapon?.abilities ?? []).map((id) => {
                    const a = ABILITIES[id];
                    return <li key={id}><strong>{a.name}</strong> <span className="muted">{a.rolls} × {STAT_LABEL[a.stat]} · {a.blurb}</span></li>;
                  })}
                </ul>
              </div>
            </div>
            <h3>Opponent</h3>
            <div className="spar-opponents">
              {OPPONENTS.map((e) => (
                <button key={e.kind} className={`spar-opponent ${kind === e.kind ? "selected" : ""}`} aria-pressed={kind === e.kind} onClick={() => setKind(e.kind)}>
                  <img className="pixel-icon" alt="" src={spriteDataUrl(e.kind)} />
                  <strong>{e.name}</strong>
                  <span className="muted">{e.kind === DUMMY_KIND ? "Barely hits back" : e.boss ? "Boss · no fleeing" : e.attacks.map((a) => a.name).join(", ")}</span>
                </button>
              ))}
            </div>
            <div className="row spar-count">
              <span>How many:</span>
              {Array.from({ length: MAX_OPPONENTS }, (_, i) => i + 1).map((n) => (
                <button key={n} className={`small ${many === n ? "selected" : ""}`} aria-pressed={many === n} disabled={!!def.boss && n > 1} onClick={() => setCount(n)}>{n}</button>
              ))}
              {def.boss && <span className="muted">A boss fights alone.</span>}
            </div>
            <div className="row spar-buttons">
              <button className="primary" onClick={begin}>Spar</button>
              <button onClick={onClose}>Leave</button>
            </div>
          </div>
        </div>
      )}

      {battle && (
        <>
          <div className="spar-banner panel">
            <span>Sparring · <span className="muted">nothing is at stake</span></span>
            <button className="small" onClick={choose}>End bout</button>
          </div>
          <div className="feed spar-feed">
            {feed.slice(-8).map((l, i) => <div key={`${i}-${l}`}>{l}</div>)}
          </div>
          <BattleHud battle={battle} you={sheet.id} onAction={act} />
          {shown && (
            <div className="slots panel">
              <div><strong>{shown.who}</strong> · {shown.check.label}{shown.check.stat ? ` · ${STAT_LABEL[shown.check.stat]}` : ""} · {shown.check.pct}%</div>
              <div className="slot-row">
                {shown.check.rolls.map((ok, i) => <span key={i} className={`slot ${ok ? "hit" : "miss"} ${i < shown.check.focus ? "focus" : ""}`}>{ok ? "✔" : "✖"}</span>)}
              </div>
              <div className={shown.check.perfect ? "good" : shown.check.fumble ? "bad" : "muted"}>{shown.check.perfect ? "Perfect!" : shown.check.fumble ? "Fumble" : `${shown.check.successes} of ${shown.check.rolls.length}`}</div>
            </div>
          )}
          {result && (
            <div className="overlay">
              <div className="panel spar-result">
                <h2 className={RESULT[result].tone}>{RESULT[result].title}</h2>
                <p>{RESULT[result].line} <span className="muted">Nothing was won or lost.</span></p>
                <div className="row spar-buttons">
                  <button className="primary" onClick={begin}>Again</button>
                  <button onClick={choose}>Change opponent</button>
                  <button onClick={onClose}>Leave</button>
                </div>
              </div>
            </div>
          )}
          {error && <div className="toast">{error}</div>}
        </>
      )}
    </div>
  );
}
