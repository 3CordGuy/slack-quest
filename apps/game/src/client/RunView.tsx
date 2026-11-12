// A voyage in progress: the Three.js island with the HUD over it. Covers
// the ship (lobby), the overworld, NPC conversation, battle and the ending.

import { useEffect, useMemo, useRef, useState } from "react";
import { hexDistance, type HexPos } from "@gantt-quest/core";
import {
  MAX_NPC_MESSAGES,
  MAX_PERSUADE_ATTEMPTS,
  MOVE_COST,
  brewBag,
  brewBuff,
  brewById,
  STAT_LABEL,
  findPath,
  eatsChowder,
  heroPct,
  poiAt,
  tileAt,
  type CheckResult,
  type ClientState,
  type Poi,
  type WorldEvent,
  TRAIT_BY_ID,
} from "@gantt-quest/world";
import * as World from "@gantt-quest/world";
import type { Me } from "./api";
import { ContractPicker, contractName } from "./board/ContractPicker";
import { ContractResult } from "./board/ContractResult";
import { ContractStatus } from "./board/ContractStatus";
import { BEAT_MS, BattleIntro, BattleRecap, FindCard, INTRO_BEATS, INTRO_MS, blowsIn, findFor, introFor, recapFor, settleBattle, type Find, type Intro, type Recap } from "./BattleBeats";
import { BattleHud, useCountdown } from "./BattleHud";
import { DragPanel } from "./DragPanel";
import { SailingView } from "./SailingView";
import { HutSpoils, blueprintName, isTrophy, perkText, resourceText } from "./hutDrops";
import { InventoryScreen } from "./InventoryScreen";
import { Trading } from "./TradePanel";
import { HeroSheet, useHeroSheet } from "./HeroSheet";
import { WorldRenderer } from "./render/WorldRenderer";
import { useRun, type RunConnection } from "./useRun";
import { itemName, label } from "./labels";

/** The least time the crossing stays on screen once a ship has sailed. */
const MIN_CROSSING_MS = 4500;

const className = (id: string) => label("class", id);
const POI_LABEL: Record<string, string> = { landing: "The Landing", hut: "Hut", lair: "Lair", shrine: "Old shrine", cache: "Hidden cache", camp: "Brigand camp" };

const PICKUP_LABEL: Record<string, string> = { herbs: "A patch of herbs", mushrooms: "A ring of mushrooms", wood: "A pile of wood", stone: "A pile of stones" };

function poiName(state: ClientState, poi: Poi): string {
  if (poi.kind === "pickup") return PICKUP_LABEL[poi.find ?? ""] ?? "Something lying about";
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
      case "rest":
        out.push(
          ev.ate === "chowder"
            ? `${n(ev.heroId)} eats a bowl of the galley's chowder at the ${ev.where}: +${ev.hp} HP${ev.focus ? `, +${ev.focus} focus` : ""}. ${ev.left ? `${ev.left} left in the hold.` : "That was the last of it."}`
            : `${n(ev.heroId)} rests at the ${ev.where}: +${ev.hp} HP${ev.focus ? `, +${ev.focus} focus` : ""}.`,
        );
        break;
      case "ambush": {
        const who = ev.kinds.length > 1 ? `${ev.kinds.length} ${ev.kinds[0] === "wolf" ? "wolves" : "raiders"}` : ev.kinds[0] === "wolf" ? "a wolf" : "a raider";
        out.push(ev.by === "band" ? `In the night ${who} ${ev.kinds.length > 1 ? "find" : "finds"} ${n(ev.heroId)}!` : `${n(ev.heroId)} runs into ${who} on the road!`);
        break;
      }
      case "forage":
        out.push(
          ev.kind === "wolves" ? `Wolves break from the trees at ${n(ev.heroId)}!`
            : ev.kind === "berries" ? (ev.hp ? `${n(ev.heroId)} finds a bramble heavy with berries. +${ev.hp} HP.` : `${n(ev.heroId)} finds berries, but is not hungry.`)
            : ev.kind === "wood" ? `${n(ev.heroId)} comes on a fallen tree, dry enough to carry off.`
            : ev.kind === "bones" ? `${n(ev.heroId)} finds an old carcass picked clean, and takes the bones.`
            : `${n(ev.heroId)} catches a glint under the roots: someone buried coin here.`,
        );
        break;
      case "pickup":
        out.push(
          ev.find === "herbs" ? `${n(ev.heroId)} stops to pick herbs.`
            : ev.find === "mushrooms" ? `${n(ev.heroId)} gathers a handful of mushrooms.`
            : ev.find === "wood" ? `${n(ev.heroId)} shoulders some of a woodpile.`
            : `${n(ev.heroId)} loads up a few good stones.`,
        );
        break;
      case "search": out.push(ev.found ? `${n(ev.heroId)} turns up something in the cache.` : `${n(ev.heroId)} finds nothing but dust.`); break;
      case "level_up": out.push(`${n(ev.heroId)} reached level ${ev.level}!`); break;
      case "gold": out.push(`${n(ev.heroId)} gains ${ev.amount} gold.`); break;
      case "xp": out.push(`${n(ev.heroId)} gains ${ev.amount} XP.`); break;
      case "loot": out.push(`${n(ev.heroId)} found ${itemName(ev.item)} (${ev.item.rarity}).`); break;
      case "pack_full":
        out.push(ev.heroId === state.you
          ? World.lootPlaceText(ev.place, ev.item)!
          : `${n(ev.heroId)}'s pack is full: ${ev.item} ${ev.place === "storage" ? "goes to their storage chest at home" : "is carried over the limit"}.`);
        break;
      case "key_item": out.push(`${n(ev.heroId)} now carries ${ev.name}.`); break;
      case "resources": out.push(`${n(ev.heroId)} gathers ${resourceText(ev.resources)}.`); break;
      case "blueprint": out.push(`${n(ev.heroId)} found a blueprint: ${blueprintName(ev.blueprint)}.`); break;
      case "furnishing": out.push(isTrophy(ev.furnishing) ? `${n(ev.heroId)} takes a trophy home: ${ev.furnishing.label}.` : `${n(ev.heroId)} found a ${ev.furnishing.label} for the hut.`); break;
      case "rite": out.push(ev.text); break;
      case "harbor_boon": out.push(ev.text); break;
      case "objective": out.push(`Objective complete: ${state.story?.objectives.find((o) => o.id === ev.id)?.text ?? ev.id}`); break;
      case "battle_start": out.push("Battle!"); break;
      case "battle_end": out.push(ev.status === "victory" ? "The fight is won." : ev.status === "fled" ? "The party got away." : "The fight is lost."); break;
      case "carried_back": out.push(`${ev.heroIds.map(n).join(" and ")} ${ev.heroIds.length === 1 ? "is" : "are"} carried back to the ship on their last legs. The voyage goes on.`); break;
      case "ended": out.push(ev.reason); break;
      case "contract": out.push(`${n(ev.heroId)}'s contract (${contractName(ev.contractId) ?? ev.contractId}) ${ev.met ? "is fulfilled!" : "went unfulfilled."}`); break;
      case "battle": {
        const b = ev.ev;
        if (b.t === "hit") out.push(`${n(b.actor)}: ${b.ability} hits ${n(b.target)} for ${b.amount}${b.perfect ? " (perfect!)" : ""}.`);
        else if (b.t === "miss") out.push(b.heal ? `${n(b.actor)}: ${b.ability} fails.` : `${n(b.actor)}: ${b.ability} misses ${n(b.target)}.`);
        else if (b.t === "heal") out.push(`${n(b.actor)}: ${b.ability} restores ${b.amount} HP to ${n(b.target)}.`);
        else if (b.t === "effect") out.push(`${n(b.target)} is ${label("effect", b.effect).toLowerCase()}.`);
        else if (b.t === "tick") out.push(`${n(b.target)} takes ${b.amount} from ${label("effect", b.effect).toLowerCase()}.`);
        else if (b.t === "skip") out.push(`${n(b.id)} is stunned and loses the turn.`);
        else if (b.t === "trait") out.push(`${n(b.id)}: ${TRAIT_BY_ID[b.trait]?.name ?? b.trait}!`);
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
  const [tradeWith, setTradeWith] = useState<string | null>(null);
  const mount = useRef<HTMLDivElement>(null);
  const renderer = useRef<WorldRenderer | null>(null);
  const latest = useRef<ClientState | null>(null);
  const names = useRef(new Map<string, string>());
  const [feed, setFeed] = useState<string[]>([]);
  /** An islander the player just clicked: once they are in earshot, the chat opens and its box takes the keyboard. */
  const [talkTo, setTalkTo] = useState<{ id: string; at: number } | null>(null);
  // Pacing around a fight: an opening card, the finished fight held on screen, and its recap. See BattleBeats.
  const [intro, setIntro] = useState<Intro | null>(null);
  const [held, setHeld] = useState<ClientState | null>(null);
  const [recap, setRecap] = useState<Recap | null>(null);
  const holding = useRef<ClientState | null>(null);
  const introTimer = useRef<ReturnType<typeof setTimeout>>();
  const recapTimer = useRef<ReturnType<typeof setTimeout>>();
  const [find, setFind] = useState<Find | null>(null);
  const findTimer = useRef<ReturnType<typeof setTimeout>>();
  /** Let go of a finished fight and show the island as it now is. */
  const release = () => {
    clearTimeout(recapTimer.current);
    holding.current = null;
    setHeld(null);
    setRecap(null);
    if (latest.current) renderer.current?.setState(latest.current);
  };
  const [shown, setShown] = useState<Shown | null>(null);
  const [hover, setHover] = useState<HexPos | null>(null);

  const run = useRun(code, (events, state) => {
    const prev = latest.current;
    latest.current = state;
    for (const h of state.heroes) names.current.set(h.id, h.name);
    for (const c of state.battle?.combatants ?? []) names.current.set(c.id, c.name);

    const opening = introFor(events, state, names.current);
    // A cache opened: say what was in it, after the dice have been seen.
    const found = findFor(events, state.you, names.current);
    if (found) {
      clearTimeout(findTimer.current);
      findTimer.current = setTimeout(() => setFind(found), 1300);
    }
    if (prev?.battle && events.some((e) => e.t === "battle_end")) {
      // The fight is over on the server. Keep it on screen as it stood while the last blows land, then say how it went.
      const settled = settleBattle(prev.battle, events);
      const frozen: ClientState = { ...prev, phase: "battle", battle: settled };
      holding.current = frozen;
      setHeld(frozen);
      renderer.current?.setState(frozen);
      renderer.current?.playEvents(events);
      const summary = recapFor(events, settled, state);
      clearTimeout(recapTimer.current);
      recapTimer.current = setTimeout(() => setRecap(summary), blowsIn(events) * BEAT_MS + 1100);
    } else if (opening) {
      // A new fight: whatever was being held gives way, and the first blows wait for the opening card.
      release();
      setIntro(opening);
      clearTimeout(introTimer.current);
      introTimer.current = setTimeout(() => setIntro(null), INTRO_MS);
      renderer.current?.setState(state);
      renderer.current?.playEvents(events, INTRO_BEATS);
    } else if (!holding.current) {
      renderer.current?.setState(state);
      renderer.current?.playEvents(events);
    }
    const lines = describe(events, state, names.current);
    if (lines.length) setFeed((f) => [...f, ...lines].slice(-40));
    const check = lastCheck(events, names.current);
    // A fight's first roll waits for its opening card to clear, like its first blow.
    if (check && opening) setTimeout(() => setShown(check), INTRO_MS);
    else if (check) setShown(check);
  });
  const send = useRef(run.send);
  send.current = run.send;
  const heroSheet = useHeroSheet();

  useEffect(() => {
    const r = new WorldRenderer(mount.current!, {
      onHexClick: (pos) => {
        const s = latest.current;
        // Clicking where an islander stands means "talk to them": the chat opens with its box ready to type in.
        const npc = s?.story?.npcs.find((n) => {
          const poi = s.map.pois.find((p) => p.id === n.poi);
          return poi && poi.pos.q === pos.q && poi.pos.r === pos.r && !s.npcs[n.id]?.hostile;
        });
        setTalkTo(npc ? { id: npc.id, at: Date.now() } : null);
        // Already beside them: talking is the whole point, so do not also try to walk onto their doorstep.
        const me = s?.heroes.find((h) => h.id === s.you);
        if (npc && me && hexDistance(me.pos, pos) <= 1) return;
        if (s?.phase === "overworld" && s.turn?.heroId === s.you) send.current({ type: "move", to: pos });
      },
      onHover: setHover,
      onHeroClick: heroSheet.onHeroClick,
      onHeroHover: heroSheet.onHeroHover,
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

  // While a finished fight is held on screen, everything is drawn from it rather than from the live state.
  const state = held ?? run.state;
  // Trading is for the walk, not the fight: a panel left open closes when one starts.
  const ashore = run.state?.phase === "overworld" && !held;
  useEffect(() => {
    if (!ashore) setTradeWith(null);
  }, [ashore]);
  // Dev-only handle for driving a run from the console or a test script.
  if (import.meta.env.DEV) (window as unknown as { __gq: unknown }).__gq = { state, send: run.send, World };

  // The crossing is shown while the story is written, and for a few seconds at least, so a quick answer does not flash by.
  const [sailing, setSailing] = useState(false);
  const sailedAt = useRef(0);
  const writing = state?.phase === "generating";
  useEffect(() => {
    if (writing) {
      sailedAt.current = Date.now();
      setSailing(true);
      return;
    }
    const left = Math.max(0, MIN_CROSSING_MS - (Date.now() - sailedAt.current));
    const timer = setTimeout(() => setSailing(false), left);
    return () => clearTimeout(timer);
  }, [writing]);

  return (
    <div className={`run ${state?.phase === "battle" ? "in-battle" : ""}`}>
      <div className="stage" ref={mount} />
      {!state && <div className="overlay"><div className="panel">{run.error ?? "Hailing the ship…"}{run.error && <p><button onClick={onLeave}>Back to the Harbor</button></p>}</div></div>}
      {state && (
        <>
          <TopBar state={state} code={code} status={run.status} onLeave={onLeave} onInventory={() => { void refresh(); setInventory(true); }} />
          {state.phase === "lobby" && <Lobby state={state} run={run} code={code} />}
          {sailing && <SailingView names={state.heroes.map((h) => h.name)} />}
          {(state.phase === "overworld" || state.phase === "battle") && (
            <>
              <Story state={state} />
              <Crew state={state} online={run.online} onTrade={ashore ? setTradeWith : undefined} />
              <Feed lines={feed} />
              {state.phase === "overworld" && <TurnBar state={state} run={run} />}
              <SkipVoteBar state={state} run={run} />
              {ashore && me.character && <Trading me={me} partners={state.heroes.filter((h) => h.id !== state.you)} withId={tradeWith} onWith={setTradeWith} refresh={refresh} run={code} />}
              {state.phase === "overworld" && <Chat state={state} run={run} talkTo={talkTo} onTalked={() => setTalkTo(null)} />}
              {state.phase === "battle" && !held && !intro && <BattleHud battle={state.battle!} you={state.you} onAction={(action) => run.send({ type: "battle", action })} />}
              {intro && !held && <BattleIntro intro={intro} />}
              {held && recap && <BattleRecap recap={recap} you={state.you} onDone={release} />}
              {find && !held && !intro && <FindCard find={find} onDone={() => setFind(null)} />}
              {state.phase === "overworld" && heroSheet.open && (() => {
                const h = state.heroes.find((x) => x.id === heroSheet.open);
                return h && <HeroSheet id={h.id} you={state.you} pinned={heroSheet.pinned} onClose={heroSheet.close} live={{ hp: h.hp, maxHp: h.maxHp, focus: h.focus, maxFocus: h.maxFocus }} />;
              })()}
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
      {state.larder && state.larder.chowder > 0 && state.phase !== "ended" && (
        <span className="larder-chip" title="From the galley's larder. A hero resting at the landing eats one when the plain rest would leave them short: back to full HP and focus.">
          Chowder ×{state.larder.chowder}
        </span>
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
              <span>
                <strong>{h.name}</strong> <span className="muted">{className(h.classId)} · Level {h.level}{h.contract ? ` · ${contractName(h.contract.id)}` : ""}</span>
                {perkText(h.hutPerks) && <span className="hut-perks" title="From the furniture in their hut"> · Hut: {perkText(h.hutPerks)}</span>}
                {perkText(h.pubBuff) && <span className="hut-perks" title="From what they ate and drank at the pub. This voyage only."> · Pub: {perkText(h.pubBuff)}</span>}
                {perkText(brewBuff(h.brews)) && <span className="hut-perks" title={`Brewed at the apothecary: ${brewBag(h.brews).map((id) => brewById(id)?.name).join(", ")}. Used up when the ship sails.`}> · Brews: {perkText(brewBuff(h.brews))}</span>}
              </span>
              <span className={h.id === state.hostId || h.ready ? "good" : "muted"}>{h.id === state.hostId ? "captain" : h.ready ? "ready" : "not ready"}</span>
            </li>
          ))}
        </ul>
        <ContractPicker state={state} run={run} />
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
      <ContractStatus state={state} />
    </DragPanel>
  );
}

function Pips({ n, max }: { n: number; max: number }) {
  return <span className="pips" title={`${n} / ${max} focus`}>{Array.from({ length: max }, (_, i) => <i key={i} className={i < n ? "on" : ""} />)}</span>;
}

function Crew({ state, online, onTrade }: { state: ClientState; online: string[]; onTrade?: (id: string) => void }) {
  return (
    <DragPanel id="run.crew" title="Crew" foldOnPhone className="crew">
      {state.heroes.map((h) => {
        const c = state.battle?.combatants.find((x) => x.id === h.id);
        const hp = c?.hp ?? h.hp;
        const focus = c?.focus ?? h.focus;
        return (
          <div key={h.id} className={`panel hero-card ${state.turn?.heroId === h.id && state.phase === "overworld" ? "active" : ""} ${online.includes(h.id) ? "" : "offline"}`}>
            <div>
              <strong>{h.name}</strong>{h.id === state.you && <span className="tag">you</span>}
              {onTrade && h.id !== state.you && <button className="small trade-btn" title={`Give or trade with ${h.name}`} onClick={() => onTrade(h.id)}>Trade</button>}
            </div>
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
    : poi.kind === "landing" ? (state.larder && eatsChowder(hero, state.larder.chowder) ? "Rest and eat a chowder" : "Rest at the ship")
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

function Chat({ state, run, talkTo, onTalked }: { state: ClientState; run: RunConnection; talkTo: { id: string; at: number } | null; onTalked(): void }) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const [unfold, setUnfold] = useState(0);
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
  // The islander the player clicked is in earshot: open the panel if it was folded, and put the cursor in the box.
  useEffect(() => {
    if (!talkTo || talkTo.id !== npc?.id) return;
    setUnfold((n) => n + 1);
    // After the panel has unfolded and drawn its box. Not cancelled when the request is cleared just below.
    setTimeout(() => input.current?.focus(), 60);
    onTalked();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [talkTo, npc?.id]);
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
    <DragPanel id="run.chat" title="Talk" compact className="chat panel" unfold={unfold}>
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
            <input ref={input} value={text} maxLength={280} placeholder={`Speak to ${npc.name}…`} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
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
        <ContractResult state={state} />
        <h3>What you bring home</h3>
        {earned ? (
          <ul className="gear">
            <li><span>{earned.xp} XP · {earned.gold} gold</span></li>
            {earned.items.map((item, i) => <li key={i} className={`rarity-${item.rarity}`}><span><strong>{itemName(item)}</strong> <span className="muted">{item.rarity}</span></span></li>)}
          </ul>
        ) : (
          <p className="muted">Nothing but the story.</p>
        )}
        {earned && <HutSpoils earned={earned} />}
        {!won && <p className="muted">A little gold was lost in the retreat. Your character is safe.</p>}
        <button className="primary" onClick={onLeave}>Sail back to the Harbor</button>
      </div>
    </div>
  );
}

/**
 * While the crew waits on someone else's turn, a vote to skip it. One vote
 * does it if they have left; otherwise more than half of the others here.
 * The server ends the turn exactly as its own timer would.
 */
function SkipVoteBar({ state, run }: { state: ClientState; run: ReturnType<typeof useRun> }) {
  const skip = run.skip;
  if (!skip || skip.heroId === state.you) return null;
  const name = state.heroes.find((h) => h.id === skip.heroId)?.name ?? "this hero";
  const away = !run.online.includes(skip.heroId);
  const voted = skip.votes.includes(state.you);
  // Someone still here can only be skipped if enough of the rest are here to outvote them.
  const others = state.heroes.filter((h) => h.id !== skip.heroId && run.online.includes(h.id)).length;
  if (!away && others < skip.needed) return null;
  return (
    <div className="panel skip-vote" role="status">
      <span>
        Waiting on <strong>{name}</strong>{away ? <span className="bad"> · away</span> : null}
        {skip.votes.length > 0 && <span className="muted"> · {skip.votes.length} of {skip.needed} voted to skip</span>}
      </span>
      <button className="small" disabled={voted} onClick={run.voteSkip}>
        {voted ? "You voted to skip" : skip.needed <= 1 ? `Skip ${name}'s turn` : `Vote to skip ${name}'s turn`}
      </button>
    </div>
  );
}
