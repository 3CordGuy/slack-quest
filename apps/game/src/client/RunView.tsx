// A voyage in progress: the Three.js island with the HUD over it. Covers
// the ship (lobby), the overworld, NPC conversation, battle and the ending.

import { useEffect, useMemo, useRef, useState } from "react";
import { hexDistance, type HexPos } from "@gantt-quest/core";
import {
  EFFECT_INFO,
  HERO_CLASSES,
  MAX_NPC_MESSAGES,
  MAX_PERSUADE_ATTEMPTS,
  MOVE_COST,
  STAT_LABEL,
  findPath,
  heroPct,
  poiAt,
  tileAt,
  type CheckResult,
  type ClientState,
  type Poi,
  type WorldEvent,
} from "@gantt-quest/world";
import * as World from "@gantt-quest/world";
import type { Me } from "./api";
import { BattleHud, useCountdown } from "./BattleHud";
import { DragPanel } from "./DragPanel";
import { InventoryScreen } from "./InventoryScreen";
import { WorldRenderer } from "./render/WorldRenderer";
import { useRun, type RunConnection } from "./useRun";

const className = (id: string) => HERO_CLASSES.find((c) => c.id === id)?.name ?? id;
const POI_LABEL: Record<string, string> = { landing: "The Landing", hut: "Hut", lair: "Lair", shrine: "Old shrine", cache: "Hidden cache", camp: "Brigand camp" };

function poiName(state: ClientState, poi: Poi): string {
  return state.story?.poiNames[poi.id] ?? POI_LABEL[poi.kind] ?? poi.kind;
}

interface Shown {
  who: string;
  check: CheckResult;
}

/** Turn events into feed lines. `names` maps hero and combatant ids to display names. */
function describe(events: WorldEvent[], state: ClientState, names: Map<string, string>): string[] {
  const n = (id: string) => names.get(id) ?? "Someone";
  const out: string[] = [];
  for (const ev of events) {
    switch (ev.t) {
      case "joined": out.push(`${ev.name} came aboard.`); break;
      case "round": out.push(`Day ${ev.round}. ${ev.doom} day${ev.doom === 1 ? "" : "s"} remain.`); break;
      case "turn_start": out.push(`${n(ev.heroId)}'s turn: ${ev.mp} movement.`); break;
      case "poi_revealed": {
        const poi = state.map.pois.find((p) => p.id === ev.poiId);
        out.push(`Discovered ${poi ? poiName(state, poi) : "something"}!`);
        break;
      }
      case "rest": out.push(`${n(ev.heroId)} rests at the ${ev.where}: +${ev.hp} HP${ev.focus ? `, +${ev.focus} focus` : ""}.`); break;
      case "search": out.push(ev.found ? `${n(ev.heroId)} turns up something in the cache.` : `${n(ev.heroId)} finds nothing but dust.`); break;
      case "level_up": out.push(`${n(ev.heroId)} reached level ${ev.level}!`); break;
      case "gold": out.push(`${n(ev.heroId)} gains ${ev.amount} gold.`); break;
      case "xp": out.push(`${n(ev.heroId)} gains ${ev.amount} XP.`); break;
      case "loot": out.push(`${n(ev.heroId)} found ${ev.item.name} (${ev.item.rarity}).`); break;
      case "key_item": out.push(`${n(ev.heroId)} now carries ${ev.name}.`); break;
      case "rite": out.push(ev.text); break;
      case "objective": out.push(`Objective complete: ${state.story?.objectives.find((o) => o.id === ev.id)?.text ?? ev.id}`); break;
      case "battle_start": out.push("Battle!"); break;
      case "battle_end": out.push(ev.status === "victory" ? "The fight is won." : ev.status === "fled" ? "The party got away." : "The party has fallen."); break;
      case "ended": out.push(ev.reason); break;
      case "battle": {
        const b = ev.ev;
        if (b.t === "hit") out.push(`${n(b.actor)}: ${b.ability} hits ${n(b.target)} for ${b.amount}${b.perfect ? " (perfect!)" : ""}.`);
        else if (b.t === "miss") out.push(`${n(b.actor)}: ${b.ability} misses ${n(b.target)}.`);
        else if (b.t === "heal") out.push(`${n(b.actor)}: ${b.ability} restores ${b.amount} HP to ${n(b.target)}.`);
        else if (b.t === "effect") out.push(`${n(b.target)} is ${EFFECT_INFO[b.effect].name.toLowerCase()}.`);
        else if (b.t === "tick") out.push(`${n(b.target)} takes ${b.amount} from ${EFFECT_INFO[b.effect].name.toLowerCase()}.`);
        else if (b.t === "skip") out.push(`${n(b.id)} is stunned and loses the turn.`);
        else if (b.t === "down") out.push(`${n(b.id)} goes down!`);
        else if (b.t === "flee") out.push(b.ok ? `${n(b.actor)} leads the retreat.` : `${n(b.actor)} fails to break away.`);
        break;
      }
    }
  }
  return out;
}

/** The most recent roll among a batch of events, for the slot display. */
function lastCheck(events: WorldEvent[], names: Map<string, string>): Shown | null {
  let shown: Shown | null = null;
  for (const ev of events) {
    if (ev.t === "check") shown = { who: names.get(ev.heroId) ?? "", check: ev.check };
    else if (ev.t === "battle" && ev.ev.t === "check") shown = { who: names.get(ev.ev.actor) ?? "", check: ev.ev.check };
  }
  return shown;
}

export function RunView({ code, me, refresh, onLeave }: { code: string; me: Me; refresh(): Promise<unknown>; onLeave(): void }) {
  const [inventory, setInventory] = useState(false);
  const mount = useRef<HTMLDivElement>(null);
  const renderer = useRef<WorldRenderer | null>(null);
  const latest = useRef<ClientState | null>(null);
  const names = useRef(new Map<string, string>());
  const [feed, setFeed] = useState<string[]>([]);
  const [shown, setShown] = useState<Shown | null>(null);
  const [hover, setHover] = useState<HexPos | null>(null);

  const run = useRun(code, (events, state) => {
    latest.current = state;
    for (const h of state.heroes) names.current.set(h.id, h.name);
    for (const c of state.battle?.combatants ?? []) names.current.set(c.id, c.name);
    renderer.current?.setState(state);
    renderer.current?.playEvents(events);
    const lines = describe(events, state, names.current);
    if (lines.length) setFeed((f) => [...f, ...lines].slice(-40));
    const check = lastCheck(events, names.current);
    if (check) setShown(check);
  });
  const send = useRef(run.send);
  send.current = run.send;

  useEffect(() => {
    const r = new WorldRenderer(mount.current!, {
      onHexClick: (pos) => {
        const s = latest.current;
        if (s?.phase === "overworld" && s.turn?.heroId === s.you) send.current({ type: "move", to: pos });
      },
      onHover: setHover,
    });
    renderer.current = r;
    if (latest.current) r.setState(latest.current);
    return () => {
      r.dispose();
      renderer.current = null;
    };
  }, []);

  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), 2600);
    return () => clearTimeout(t);
  }, [shown]);
  useEffect(() => {
    if (!run.error) return;
    const t = setTimeout(run.clearError, 4000);
    return () => clearTimeout(t);
  }, [run.error, run.clearError]);

  const state = run.state;
  // Dev-only handle for driving a run from the console or a test script.
  if (import.meta.env.DEV) (window as unknown as { __gq: unknown }).__gq = { state, send: run.send, World };

  return (
    <div className={`run ${state?.phase === "battle" ? "in-battle" : ""}`}>
      <div className="stage" ref={mount} />
      {!state && <div className="overlay"><div className="panel">{run.error ?? "Hailing the ship…"}{run.error && <p><button onClick={onLeave}>Back to the Harbor</button></p>}</div></div>}
      {state && (
        <>
          <TopBar state={state} code={code} status={run.status} onLeave={onLeave} onInventory={() => { void refresh(); setInventory(true); }} />
          {state.phase === "lobby" && <Lobby state={state} run={run} code={code} />}
          {state.phase === "generating" && <div className="overlay"><div className="panel"><h2>Land ho…</h2><p className="muted">The lookout is making out the shape of the island.</p></div></div>}
          {(state.phase === "overworld" || state.phase === "battle") && (
            <>
              <Story state={state} />
              <Crew state={state} online={run.online} />
              <Feed lines={feed} />
              {state.phase === "overworld" && <TurnBar state={state} run={run} />}
              {state.phase === "overworld" && <Chat state={state} run={run} />}
              {state.phase === "battle" && <BattleHud battle={state.battle!} you={state.you} onAction={(action) => run.send({ type: "battle", action })} />}
              {hover && state.phase === "overworld" && <HexTip state={state} hover={hover} />}
            </>
          )}
          {state.phase === "ended" && <Ending state={state} onLeave={onLeave} />}
          {shown && <Slots shown={shown} />}
          {inventory && me.character && state.phase !== "battle" && (
            <InventoryScreen
              me={me}
              onIsland
              // After any change, have the voyage pick up what the hero is now wearing.
              refresh={async () => {
                await refresh();
                run.regear();
              }}
              onClose={() => setInventory(false)}
            />
          )}
          {run.error && <div className="toast">{run.error}</div>}
        </>
      )}
    </div>
  );
}

const BIOME_LABEL: Record<string, string> = { plains: "Plains", forest: "Forest", hills: "Hills", water: "Sea", dock: "Dock" };

/** What the hovered hex is, what it costs to enter, and what walking there would cost this turn. */
function HexTip({ state, hover }: { state: ClientState; hover: HexPos }) {
  const tile = tileAt(state.map, hover);
  if (!tile) return null;
  const poi = poiAt(state.map, hover);
  const cost = MOVE_COST[tile.biome];
  const me = state.heroes.find((h) => h.id === state.you);
  const turn = state.turn?.heroId === state.you ? state.turn : null;
  let walk: string | null = null;
  if (turn && me && Number.isFinite(cost) && !(me.pos.q === hover.q && me.pos.r === hover.r)) {
    const route = findPath(state.map, me.pos, hover, turn.mp);
    walk = route ? `${route.cost} of your ${turn.mp} movement to walk here` : "out of reach this turn";
  }
  return (
    <div className="tip">
      <strong>{poi ? `${poiName(state, poi)}${poi.cleared ? " (cleared)" : ""}` : BIOME_LABEL[tile.biome]}</strong>
      {poi && <span className="muted"> · {BIOME_LABEL[tile.biome]}</span>}
      <span className="muted"> · {Number.isFinite(cost) ? `${cost} movement to enter` : "cannot be crossed"}</span>
      {walk && <span className={walk.startsWith("out") ? "bad" : "good"}> · {walk}</span>}
      {poi && !poi.cleared && poi.enemies.length > 0 && <span className="bad"> · heroes inside the red line join a fight here</span>}
    </div>
  );
}

function TopBar({ state, code, status, onLeave, onInventory }: { state: ClientState; code: string; status: string; onLeave(): void; onInventory(): void }) {
  const fighting = state.phase === "battle";
  return (
    <div className="topbar">
      <strong>{state.story?.title ?? "A ship at the Harbor"}</strong>
      {state.story && <span className="muted wide-only">{state.story.islandName}</span>}
      {state.round > 0 && state.phase !== "ended" && (
        <span className={state.doom <= 3 ? "bad" : ""}>Day {state.round} · {state.doom} day{state.doom === 1 ? "" : "s"} left</span>
      )}
      <span className="spacer" />
      {status !== "open" && <span className="bad">reconnecting…</span>}
      <span className="muted wide-only">Ship {code}</span>
      {state.phase !== "ended" && (
        <button className="small" disabled={fighting} title={fighting ? "Not during a fight" : "Your gear and stats"} onClick={onInventory}>
          Inventory
        </button>
      )}
      <button className="small" onClick={onLeave}>Harbor</button>
    </div>
  );
}

function Lobby({ state, run, code }: { state: ClientState; run: RunConnection; code: string }) {
  const me = state.heroes.find((h) => h.id === state.you);
  const host = state.hostId === state.you;
  const waiting = state.heroes.filter((h) => h.id !== state.hostId && !h.ready).length;
  return (
    <div className="overlay">
      <div className="panel lobby">
        <h2>Aboard the ship</h2>
        <p className="muted">Share this code so your crew can board:</p>
        <div className="code">{code}</div>
        <ul className="crew-list">
          {state.heroes.map((h) => (
            <li key={h.id}>
              <span><strong>{h.name}</strong> <span className="muted">{className(h.classId)} · Level {h.level}</span></span>
              <span className={h.id === state.hostId || h.ready ? "good" : "muted"}>{h.id === state.hostId ? "captain" : h.ready ? "ready" : "not ready"}</span>
            </li>
          ))}
        </ul>
        {host ? (
          <button className="primary" disabled={waiting > 0} onClick={() => run.send({ type: "start" })}>
            {waiting > 0 ? `Waiting on ${waiting} crew…` : "Set sail"}
          </button>
        ) : (
          <button className="primary" onClick={() => run.send({ type: "ready", ready: !me?.ready })}>{me?.ready ? "Not ready" : "Ready"}</button>
        )}
      </div>
    </div>
  );
}

function Story({ state }: { state: ClientState }) {
  const [open, setOpen] = useState(true);
  if (!state.story) return null;
  return (
    <DragPanel id="run.story" title="Story" foldOnPhone className="story panel">
      <button className="link" onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"} story</button>
      {open && <p>{state.story.premise}</p>}
      <ul className="objectives">
        {state.story.objectives.map((o) => (
          <li key={o.id} className={o.done ? "done" : ""}>{o.done ? "☑" : "☐"} {o.text}</li>
        ))}
      </ul>
      {state.story.demand && (
        <p className={`demand ${state.story.demand.done ? "done" : ""}`}>
          {state.story.demand.done ? "☑" : "☐"} {state.story.demand.npcName} asks that you {state.story.demand.text}.
        </p>
      )}
    </DragPanel>
  );
}

function Pips({ n, max }: { n: number; max: number }) {
  return <span className="pips" title={`${n} / ${max} focus`}>{Array.from({ length: max }, (_, i) => <i key={i} className={i < n ? "on" : ""} />)}</span>;
}

function Crew({ state, online }: { state: ClientState; online: string[] }) {
  return (
    <DragPanel id="run.crew" title="Crew" foldOnPhone className="crew">
      {state.heroes.map((h) => {
        const c = state.battle?.combatants.find((x) => x.id === h.id);
        const hp = c?.hp ?? h.hp;
        const focus = c?.focus ?? h.focus;
        return (
          <div key={h.id} className={`panel hero-card ${state.turn?.heroId === h.id && state.phase === "overworld" ? "active" : ""} ${online.includes(h.id) ? "" : "offline"}`}>
            <div><strong>{h.name}</strong>{h.id === state.you && <span className="tag">you</span>}</div>
            <div className="muted">{className(h.classId)} · Lv {h.level}{(h.armor ?? 0) > 0 ? ` · armor ${h.armor}` : ""}{online.includes(h.id) ? "" : " · away"}</div>
            <div className="bar"><div className="bar-fill hp" style={{ width: `${(100 * hp) / h.maxHp}%` }} /><span>{hp} / {h.maxHp}</span></div>
            <div className="muted"><Pips n={focus} max={h.maxFocus} /> · {c?.potions ?? h.potions} potion{(c?.potions ?? h.potions) === 1 ? "" : "s"}</div>
          </div>
        );
      })}
    </DragPanel>
  );
}

function Feed({ lines }: { lines: string[] }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [lines]);
  return (
    <div className="feed">
      {lines.slice(-8).map((l, i) => <div key={`${i}-${l}`}>{l}</div>)}
      <div ref={end} />
    </div>
  );
}

function Slots({ shown }: { shown: Shown }) {
  const { check } = shown;
  return (
    <div className="slots panel">
      <div><strong>{shown.who}</strong> · {check.label}{check.stat ? ` · ${STAT_LABEL[check.stat]}` : ""} · {check.pct}%</div>
      <div className="slot-row">
        {check.rolls.map((ok, i) => <span key={i} className={`slot ${ok ? "hit" : "miss"} ${i < check.focus ? "focus" : ""}`}>{ok ? "✔" : "✖"}</span>)}
      </div>
      <div className={check.perfect ? "good" : check.fumble ? "bad" : "muted"}>{check.perfect ? "Perfect!" : check.fumble ? "Fumble" : `${check.successes} of ${check.rolls.length}`}</div>
    </div>
  );
}

function TurnBar({ state, run }: { state: ClientState; run: RunConnection }) {
  const turn = state.turn;
  const left = useCountdown(turn?.deadline);
  if (!turn) return null;
  const mine = turn.heroId === state.you;
  const hero = state.heroes.find((h) => h.id === turn.heroId)!;
  const poi = poiAt(state.map, hero.pos);
  const rite = poi && state.story?.rites.find((r) => r.poi === poi.id && r.ready && !r.done);
  const action = !poi || turn.acted ? null
    : rite ? rite.label
    : poi.kind === "landing" ? "Rest at the ship"
    : poi.kind === "shrine" ? (poi.usedBy.includes(hero.id) ? null : "Pray at the shrine")
    : poi.kind === "cache" ? (poi.cleared ? null : "Search the cache")
    : poi.kind === "camp" ? (poi.cleared ? null : "Attack the camp")
    : poi.kind === "lair" ? (poi.cleared ? null : `Storm ${poiName(state, poi)}`)
    : null;
  return (
    <DragPanel id="run.turn" title="Your turn" compact className="turnbar panel">
      {mine ? (
        <>
          <strong>Your turn</strong>
          <span>{turn.mp} movement left</span>
          <span className="muted">Click a lit hex to move. Plains cost 1, forest and hills 2.</span>
          {action && <button className="primary" onClick={() => run.send({ type: "interact" })}>{action}</button>}
          <button onClick={() => run.send({ type: "end_turn" })}>End turn</button>
        </>
      ) : (
        <span>Waiting for <strong>{hero.name}</strong>…</span>
      )}
      {left !== null && <span className={left <= 15 ? "bad" : "muted"}>{left}s</span>}
    </DragPanel>
  );
}

function Chat({ state, run }: { state: ClientState; run: RunConnection }) {
  const [text, setText] = useState("");
  const [persuade, setPersuade] = useState(false);
  const [focus, setFocus] = useState(0);
  const end = useRef<HTMLDivElement>(null);
  const me = state.heroes.find((h) => h.id === state.you);
  const npc = state.story?.npcs.find((n) => {
    const poi = state.map.pois.find((p) => p.id === n.poi);
    return poi && me && hexDistance(me.pos, poi.pos) <= 1 && !state.npcs[n.id]?.hostile;
  });
  const lines = useMemo(() => state.chat.filter((l) => l.npcId === npc?.id), [state.chat, npc?.id]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [lines.length]);
  if (!npc || !me) return null;
  const npcRun = state.npcs[npc.id];
  const attemptsLeft = MAX_PERSUADE_ATTEMPTS - (npcRun.attempts[me.id] ?? 0);
  const spent = npcRun.messages >= MAX_NPC_MESSAGES;
  const mood = ["Hostile", "Cold", "Wary", "Warming", "Friendly"][npcRun.attitude + 2];
  const submit = () => {
    if (!text.trim() || npcRun.busy || spent) return;
    run.send({ type: "talk", npcId: npc.id, text, persuade: persuade && attemptsLeft > 0, focus: persuade ? focus : 0 });
    setText("");
    setPersuade(false);
    setFocus(0);
  };
  return (
    <DragPanel id="run.chat" title="Talk" compact className="chat panel">
      <div className="chat-head">
        <strong>{npc.name}</strong> <span className="muted">{npc.role}</span>
        <span className="tag">{mood}</span>
      </div>
      <div className="chat-lines">
        {lines.length === 0 && <div className="muted">Say something. They can hear everyone standing nearby.</div>}
        {lines.map((l, i) => (
          <div key={i} className={`line ${l.who}`}>{l.who !== "system" && <strong>{l.name}: </strong>}{l.text}</div>
        ))}
        {npcRun.busy && <div className="muted">{npc.name} is thinking…</div>}
        <div ref={end} />
      </div>
      {spent ? (
        <div className="muted">{npc.name} has nothing more to say.</div>
      ) : (
        <>
          <div className="row">
            <input value={text} maxLength={280} placeholder={`Speak to ${npc.name}…`} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
            <button className="primary" disabled={!text.trim() || npcRun.busy} onClick={submit}>Say</button>
          </div>
          <label className="persuade">
            <input type="checkbox" checked={persuade} disabled={attemptsLeft <= 0} onChange={(e) => setPersuade(e.target.checked)} />
            Persuade: 3 rolls at {heroPct(me, "int_stat")}% Intelligence ({attemptsLeft} attempt{attemptsLeft === 1 ? "" : "s"} left)
            {persuade && me.focus > 0 && (
              <select value={focus} onChange={(e) => setFocus(Number(e.target.value))}>
                {Array.from({ length: Math.min(3, me.focus) + 1 }, (_, i) => <option key={i} value={i}>{i} focus</option>)}
              </select>
            )}
          </label>
        </>
      )}
    </DragPanel>
  );
}

function Ending({ state, onLeave }: { state: ClientState; onLeave(): void }) {
  const result = state.result!;
  const earned = state.earned[state.you];
  const won = result.outcome === "victory";
  return (
    <div className="overlay">
      <div className="panel ending">
        <h2 className={won ? "good" : "bad"}>{won ? "Victory" : "Defeat"}</h2>
        <p><strong>{state.story?.title}</strong></p>
        <p>{result.epilogue ?? "The tale is being written…"}</p>
        <h3>What you bring home</h3>
        {earned ? (
          <ul className="gear">
            <li><span>{earned.xp} XP · {earned.gold} gold</span></li>
            {earned.items.map((item, i) => <li key={i} className={`rarity-${item.rarity}`}><span><strong>{item.name}</strong> <span className="muted">{item.rarity}</span></span></li>)}
          </ul>
        ) : (
          <p className="muted">Nothing but the story.</p>
        )}
        {!won && <p className="muted">A little gold was lost in the retreat. Your character is safe.</p>}
        <button className="primary" onClick={onLeave}>Sail back to the Harbor</button>
      </div>
    </div>
  );
}
