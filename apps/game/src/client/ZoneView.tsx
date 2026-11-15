// A zone: a map the party walks freely and fights on, turn by turn, on the
// tiles themselves. The rules are packages/world/src/zone; this is the
// picture of them and the hands on them.
//
// Out of a fight a click walks you there. In one, on your turn, the bar's
// nine slots are what you can do: pick one and the map shows how far it
// reaches and what it would cover; click a target and it is done. Movement
// is a click on any lit hex, in as many pieces as you like.
//
// The server answers each action with the whole state and a list of what
// happened. The state is believed at once by the bar (so you can keep
// acting), but the picture catches up one event at a time: a walk is
// walked, a blow lands, the bar over a head drops when it does.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { hexDistance, posKey, type HexPos } from "@gantt-quest/core";
import {
  ABILITIES,
  ALERT_RANGE,
  COMMON_ACTIONS,
  CONDITION_INFO,
  ENEMIES,
  FREE_WALK,
  SURFACE_INFO,
  THROWABLES,
  abilityArea,
  abilityDice,
  commonCost,
  defenceOf,
  diceText,
  healDice,
  jumpRange,
  previewAttack,
  sees,
  statMod,
  tacticOf,
  throwRange,
  tileAt,
  zoneBlast,
  zoneReach,
  type CommonAction,
  type GroundSurface,
  type Roll,
  type Throwable,
  type Unit,
  type ZoneEvent,
  type ZoneState,
  type ZoneView as ZoneViewState,
} from "@gantt-quest/world";
import type { Me } from "./api";
import { useAudioScene } from "./audio/useAudioScene";
import { sounds } from "./audio/gameSounds";
import { OptionsMenu } from "./OptionsMenu";
import { TacticsLayer, type Overlay } from "./render/TacticsLayer";
import { WorldRenderer, hexToWorld, type RenderState } from "./render/WorldRenderer";
import { HudBar, type HudSlot } from "./ui/Hud";
import { useCountdown } from "./ui/useCountdown";
import { useZone } from "./useZone";
import { setZoneDev, useZoneDev } from "./zone/zoneDev";
import "./zone/zone.css";

/** What is waiting for a click on the map. */
type Pick = { kind: "ability"; id: string } | { kind: "common"; what: CommonAction } | { kind: "throw"; item: Throwable };

/** The part of the state the picture shows, which lags the truth while events play out. */
interface Picture {
  units: Unit[];
  surfaces: Record<string, GroundSurface>;
}

const asState = (view: ZoneViewState) => view as unknown as ZoneState;
const THROW_ORDER: Throwable[] = ["poison", "fire", "oil", "water", "healing"];
const COMMON_ORDER: CommonAction[] = ["dash", "disengage", "jump", "shove", "help", "potion"];

/** How long the picture dwells on each thing that happened, in ms. */
function dwell(ev: ZoneEvent): number {
  switch (ev.t) {
    case "moved": return Math.min(2400, ev.path.length * 400);
    case "roll": return ev.roll.kind === "initiative" ? 0 : 520;
    case "used": return 320;
    case "hit": case "miss": return 430;
    case "heal": case "tick": return 380;
    case "condition": return 160;
    case "down": case "skip": return 320;
    case "surface": case "up": case "fight_join": case "round": return 240;
    case "burst": case "reaction": return 300;
    case "shoved": case "jumped": return 400;
    case "fight_start": return 900;
    case "fight_end": return 700;
    default: return 0;
  }
}

/** What an attack is called, for its look and sound: an ability's name, or an enemy attack's own. */
const blowName = (what: string) => ABILITIES[what]?.name ?? what;

export function ZoneView({ code, me, onLeave }: { code: string; me: Me; onLeave(): void }) {
  const mount = useRef<HTMLDivElement>(null);
  const renderer = useRef<WorldRenderer | null>(null);
  const layer = useRef<TacticsLayer | null>(null);
  const [picture, setPicture] = useState<Picture | null>(null);
  const [feed, setFeed] = useState<string[]>([]);
  const [roll, setRoll] = useState<Roll | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [pick, setPick] = useState<Pick | null>(null);
  const [focus, setFocus] = useState(false);
  const [hover, setHover] = useState<HexPos | null>(null);
  const [playAs, setPlayAs] = useState<string | null>(null);
  const names = useRef(new Map<string, string>());
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const settled = useRef<Picture | null>(null);
  const dev = useZoneDev();

  // ---------- the connection, and playing out what happened ----------

  const zone = useZone(code, (next, events, prev) => {
    for (const u of next.units) names.current.set(u.id, u.name);
    const name = (id: string | null | undefined) => (id ? (names.current.get(id) ?? "Someone") : "Something");
    // Anything still playing from the last update is finished at once.
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
    const end: Picture = { units: next.units, surfaces: next.surfaces };
    const from = settled.current;
    settled.current = end;
    if (!prev || !from || events.length === 0) return setPicture(end);

    const draft: Picture = structuredClone(from);
    const find = (id: string) => draft.units.find((u) => u.id === id);
    const lines: string[] = [];
    let at = 0;
    const later = (run: () => void) => timers.current.push(setTimeout(run, at));
    for (const ev of events) {
      const say = (line: string) => later(() => setFeed((f) => [...f, line].slice(-40)));
      const view = renderer.current;
      if (ev.t === "moved") {
        const u = find(ev.id);
        if (u) u.pos = ev.path[ev.path.length - 1];
        later(() => view?.walkUnit(ev.id, ev.path));
      } else if (ev.t === "jumped" || (ev.t === "shoved" && ev.to)) {
        const id = ev.t === "jumped" ? ev.id : ev.target;
        const to = ev.to!;
        const u = find(id);
        if (u) u.pos = to;
        later(() => {
          sounds.zone(ev.t === "jumped" ? "jump" : "shove", view?.whereIs(id));
          view?.walkUnit(id, [to]);
        });
        if (ev.t === "shoved") say(`${name(ev.id)} shoves ${name(ev.target)} back.`);
      } else if (ev.t === "shoved") {
        say(`${name(ev.id)} shoves ${name(ev.target)}, who has nowhere to go and falls.`);
      } else if (ev.t === "used") {
        say(`${name(ev.id)}: ${ev.name}${ev.target ? ` on ${name(ev.target)}` : ""}.`);
        later(() => {
          if (ev.what.startsWith("throw:")) sounds.zone("throw", view?.whereIs(ev.id));
          view?.floatOver(ev.id, ev.name, "#fff1c9");
        });
      } else if (ev.t === "roll") {
        if (ev.roll.kind !== "initiative") {
          later(() => {
            sounds.zone(ev.roll.crit ? "roll.crit" : "roll");
            setRoll(ev.roll);
          });
        }
      } else if (ev.t === "hit") {
        const u = find(ev.target);
        if (u) u.hp = Math.max(0, u.hp - ev.amount);
        const land = () => view?.floatOver(ev.target, `-${ev.amount}`, ev.crit ? "#ffd23f" : "#ff6b6b");
        later(() => (ev.actor && ev.actor !== ev.target && !ev.what.startsWith("throw:") ? view?.blow(ev.actor, ev.target, blowName(ev.what), { crit: ev.crit, landed: true, onImpact: land }) : land()));
        say(`${name(ev.target)} takes ${ev.amount}${ev.crit ? " (critical hit)" : ""}.`);
      } else if (ev.t === "miss") {
        const wide = () => view?.floatOver(ev.target, "miss", "#c9d1e0");
        later(() => (ev.what === "shove" ? wide() : view?.blow(ev.actor, ev.target, blowName(ev.what), { onImpact: wide })));
        say(`${name(ev.actor)} misses ${name(ev.target)}.`);
      } else if (ev.t === "heal") {
        const u = find(ev.target);
        if (u) u.hp = Math.min(u.maxHp, u.hp + ev.amount);
        later(() => {
          sounds.heal(blowName(ev.what), view?.whereIs(ev.target));
          view?.glint(ev.target, "#7dff9a");
          view?.floatOver(ev.target, `+${ev.amount}`, "#7dff9a");
        });
      } else if (ev.t === "tick") {
        const u = find(ev.target);
        if (u) u.hp = Math.max(0, u.hp - ev.amount);
        const what = ev.kind in SURFACE_INFO ? SURFACE_INFO[ev.kind as keyof typeof SURFACE_INFO].name : CONDITION_INFO[ev.kind as keyof typeof CONDITION_INFO].name;
        later(() => {
          sounds.tick(ev.kind, view?.whereIs(ev.target));
          view?.floatOver(ev.target, `-${ev.amount}`, "#ffa94d");
        });
        say(`${name(ev.target)} takes ${ev.amount} from ${what.toLowerCase()}.`);
      } else if (ev.t === "condition") {
        const u = find(ev.target);
        if (u && !u.conditions.some((c) => c.kind === ev.kind)) u.conditions.push({ kind: ev.kind, rounds: ev.rounds });
        later(() => {
          sounds.effect(ev.kind, view?.whereIs(ev.target));
          view?.floatOver(ev.target, CONDITION_INFO[ev.kind].name, CONDITION_INFO[ev.kind].color);
        });
        say(`${name(ev.target)} is ${CONDITION_INFO[ev.kind].name}.`);
      } else if (ev.t === "down" || ev.t === "up") {
        const u = find(ev.id);
        if (u) u.down = ev.t === "down";
        if (u && ev.t === "down") u.hp = 0;
        if (u && ev.t === "down") later(() => sounds.down({ side: u.side, kind: u.kind }, view?.whereIs(ev.id)));
        say(ev.t === "down" ? `${name(ev.id)} is down.` : `${name(ev.id)} is back up.`);
      } else if (ev.t === "skip") {
        say(`${name(ev.id)} is ${CONDITION_INFO[ev.kind].name} and loses the turn.`);
      } else if (ev.t === "surface") {
        for (const p of ev.hexes) {
          if (ev.kind) draft.surfaces[posKey(p)] = { kind: ev.kind, rounds: 1, by: null };
          else delete draft.surfaces[posKey(p)];
        }
        if (ev.kind && ev.hexes[0]) later(() => sounds.surface(ev.kind!, hexToWorld(ev.hexes[0])));
      } else if (ev.t === "burst") {
        later(() => sounds.zone("burst", ev.hexes[0] && hexToWorld(ev.hexes[0])));
        say("The poison goes up in flame.");
      } else if (ev.t === "reaction") {
        later(() => sounds.zone("reaction", view?.whereIs(ev.id)));
        say(`${name(ev.id)} strikes at ${name(ev.target)} as they leave reach.`);
      } else if (ev.t === "alert") {
        say(`${name(ev.by)} has been seen.`);
      } else if (ev.t === "fight_start") {
        later(() => {
          sounds.stinger("battle_start");
          sounds.zone("initiative");
          setBanner("A fight!");
        });
        say("A fight breaks out. Roll for initiative.");
      } else if (ev.t === "fight_join") {
        say(`${name(ev.id)} joins the fight.`);
      } else if (ev.t === "round") {
        say(`Round ${ev.n}.`);
      } else if (ev.t === "turn") {
        if (ev.ids.some((id) => next.units.some((u) => u.id === id && (u.id === next.you || u.controller === next.you)))) {
          later(() => {
            sounds.yourTurn();
            setBanner("Your turn");
          });
        }
      } else if (ev.t === "fight_end") {
        later(() => {
          sounds.stinger(ev.outcome);
          setBanner(ev.outcome === "victory" ? "Victory" : "Defeated");
        });
        say(ev.outcome === "victory" ? "The fight is won." : "The fight is lost. You wake where you started.");
      } else if (ev.t === "joined") {
        say(`${name(ev.id)} arrives.`);
      }
      // What the picture shows once this event has been seen.
      const shown: Picture = structuredClone(draft);
      later(() => setPicture(shown));
      at += dwell(ev);
    }
    if (lines.length > 0) setFeed((f) => [...f, ...lines].slice(-40));
    later(() => setPicture(end));
  });
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const state = zone.state;
  const enc = state?.encounter ?? null;
  // Which of your own you are playing: your hero, or a stand-in whose turn it is.
  const mine = useMemo(() => state?.units.filter((u) => u.side === "hero" && (u.id === state.you || u.controller === state.you)) ?? [], [state]);
  const ready = (u: Unit) => !!enc && enc.acting.includes(u.id) && !enc.done.includes(u.id) && !u.down;
  const act = mine.find((u) => u.id === playAs && (!enc || !enc.order.includes(u.id) || ready(u))) ?? mine.find(ready) ?? mine.find((u) => u.id === state?.you) ?? mine[0];
  const fighting = !!act && !!enc?.order.includes(act.id);
  const myTurn = !!act && fighting && ready(act);
  const budget = act && enc ? enc.budgets[act.id] : undefined;
  const deadline = useCountdown(enc?.deadline);

  useAudioScene(mine.some((u) => enc?.order.includes(u.id)) ? "battle" : state?.options.biome === "caves" ? "caverns" : "island");

  // ---------- the renderer ----------

  const click = useRef<(pos: HexPos) => void>(() => {});
  useEffect(() => {
    const view = new WorldRenderer(mount.current!, { onHexClick: (pos) => click.current(pos), onHover: setHover });
    renderer.current = view;
    layer.current = new TacticsLayer(view);
    return () => {
      layer.current?.dispose();
      layer.current = null;
      renderer.current = null;
      view.dispose();
    };
  }, []);

  // The dev toolbox's way in: while this zone is on screen it can send dev actions and arm a tool.
  const send = zone.send;
  useEffect(() => {
    setZoneDev({ open: { code, send: (op) => send({ type: "dev", dev: op }) } });
    return () => setZoneDev({ open: null, tool: null });
  }, [code, send]);

  // In a dev build, the state and a way to act on it, for the console.
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__gqZone = { state: zone.state, send };
  }, [zone.state, send]);

  const picking = !!pick || !!dev.tool;
  const reach = useMemo(() => {
    if (!state || !act || act.down || picking || (fighting && !myTurn)) return new Map();
    return zoneReach(asState(state), act, budget ? budget.move : FREE_WALK);
  }, [state, act, picking, fighting, myTurn, budget]);

  useEffect(() => {
    const view = renderer.current;
    if (!view || !state || !picture) return;
    const inFight = (id: string) => !!enc?.order.includes(id);
    const turn = (id: string) => !!enc && enc.acting.includes(id) && !enc.done.includes(id);
    const scene: RenderState = {
      code: `zone:${code}`,
      kind: state.options.biome === "caves" ? "caverns" : "voyage",
      you: act?.id ?? state.you,
      phase: "overworld",
      round: 0,
      map: state.map,
      heroes: picture.units.filter((u) => u.side === "hero").map((u) => ({ id: u.id, classId: u.kind, pos: u.pos, name: u.name, outfit: u.outfit, level: u.level, xp: 0, hp: u.hp, maxHp: u.maxHp, down: u.down, active: turn(u.id) })),
      units: picture.units.filter((u) => u.side === "enemy").map((u) => ({ id: u.id, kind: u.kind, pos: u.pos, name: u.name, hp: inFight(u.id) || u.hp < u.maxHp ? u.hp / u.maxHp : undefined, down: u.down, active: turn(u.id), hostile: inFight(u.id) })),
      turn: null,
      story: null,
      npcs: {},
      // Lit tiles are a turn's movement; walking freely, nothing is lit.
      freeRoam: !fighting,
      reach,
    };
    view.setState(scene);
    layer.current?.setMap(state.map);
    layer.current?.setSurfaces(picture.surfaces);
  }, [state, picture, reach, act?.id, fighting, code, enc]);

  // ---------- what a pick reaches, and what it would cover ----------

  const z = state ? asState(state) : null;
  const unitOn = (pos: HexPos | null) => (pos && state ? state.units.find((u) => u.pos.q === pos.q && u.pos.r === pos.r) : undefined);
  const within = (range: number, sight: boolean) => (state && act ? state.map.tiles.filter((t) => hexDistance(t, act.pos) <= range && hexDistance(t, act.pos) > 0 && (!sight || sees(state.map, act.pos, t))) : []);

  const overlays = useMemo<Overlay[]>(() => {
    const out: Overlay[] = [];
    if (!state || !z || !act) return out;
    if (dev.showAlert) {
      for (const group of Object.keys(state.groups)) {
        if (state.groups[group].alerted) continue;
        const members = state.units.filter((u) => u.group === group && !u.down);
        out.push({ hexes: state.map.tiles.filter((t) => members.some((m) => hexDistance(m.pos, t) <= ALERT_RANGE && sees(state.map, m.pos, t))), color: "#ff3b3b", fill: 0.08, line: 0.7 });
      }
    }
    if (dev.tool?.tool === "paint" && hover) out.push({ hexes: dev.tool.wide ? zoneBlast(state.map, hover, 1) : [hover], color: dev.tool.surface ? SURFACE_INFO[dev.tool.surface].color : "#ffffff", fill: 0.35, line: 0.9 });
    if (dev.tool?.tool === "spawn" && hover) out.push({ hexes: [hover], color: "#ff3b3b", fill: 0.35, line: 0.9 });
    if (!pick) return out;
    if (pick.kind === "ability") {
      const tactic = tacticOf(pick.id);
      const melee = tactic.reach === "melee";
      if (tactic.shape !== "line") out.push({ hexes: within(melee ? 1 : tactic.range, !melee), color: "#ffd23f", fill: 0.1, line: 0.8 });
      const area = abilityArea(z, act, pick.id, hover ?? undefined);
      if (area.length > 0) out.push({ hexes: area, color: "#ff6b6b", fill: 0.3, line: 0.9 });
      else if (hover && unitOn(hover)) out.push({ hexes: [hover], color: tactic.shape === "ally" ? "#7dff9a" : "#ff6b6b", fill: 0.3, line: 0.9 });
    } else if (pick.kind === "throw") {
      out.push({ hexes: within(throwRange(statMod(act.stats?.str ?? 5)), true), color: "#ffd23f", fill: 0.1, line: 0.8 });
      if (hover) out.push({ hexes: zoneBlast(state.map, hover, THROWABLES[pick.item].radius), color: THROWABLES[pick.item].surface ? SURFACE_INFO[THROWABLES[pick.item].surface!.kind].color : "#7dff9a", fill: 0.35, line: 0.9 });
    } else if (pick.what === "jump") {
      out.push({ hexes: within(jumpRange(statMod(act.stats?.str ?? 5)), true).filter((t) => !unitOn(t)), color: "#8fd3ff", fill: 0.14, line: 0.8 });
      if (hover) out.push({ hexes: [hover], color: "#8fd3ff", fill: 0.35, line: 0.9 });
    } else {
      out.push({ hexes: within(1, false), color: pick.what === "help" ? "#7dff9a" : "#ffd23f", fill: 0.12, line: 0.8 });
    }
    return out;
  }, [state, z, act, pick, hover, dev.showAlert, dev.tool]);
  useEffect(() => layer.current?.setOverlays(overlays), [overlays]);

  // ---------- acting ----------

  const use = (ability: string, aim: { target?: string; at?: HexPos } = {}) => {
    if (!act) return;
    zone.send({ type: "use", unit: act.id, ability, ...aim, focus: focus && ABILITIES[ability]?.damage !== undefined });
    setPick(null);
    setFocus(false);
  };
  const common = (what: CommonAction, aim: { target?: string; at?: HexPos } = {}) => {
    if (!act) return;
    zone.send({ type: "common", unit: act.id, what, ...aim });
    setPick(null);
  };
  const choose = (ability: string) => {
    const shape = tacticOf(ability).shape;
    // Something with nothing to aim goes off at once.
    if (shape === "self" || shape === "adjacent" || shape === "burst") return use(ability);
    setPick((p) => (p?.kind === "ability" && p.id === ability ? null : { kind: "ability", id: ability }));
  };

  click.current = (pos) => {
    if (!state || !act) return;
    const there = unitOn(pos);
    if (dev.tool?.tool === "spawn") return dev.open?.send({ op: "spawn", kinds: dev.tool.kinds, at: pos });
    if (dev.tool?.tool === "paint") return dev.open?.send({ op: "paint", kind: dev.tool.surface, hexes: dev.tool.wide ? zoneBlast(state.map, pos, 1) : [pos] });
    if (!pick) return zone.send({ type: "move", unit: act.id, to: pos });
    if (pick.kind === "ability") {
      const shape = tacticOf(pick.id).shape;
      if (shape === "blast" || shape === "line") return use(pick.id, { at: pos });
      // An ally ability clicked on open ground is meant for yourself.
      if (shape === "ally") return use(pick.id, { target: there?.side === "hero" ? there.id : act.id });
      if (there) use(pick.id, { target: there.id });
    } else if (pick.kind === "throw") {
      zone.send({ type: "throw", unit: act.id, item: pick.item, at: pos });
      setPick(null);
    } else if (pick.what === "jump") common("jump", { at: pos });
    else if (there) common(pick.what, { target: there.id });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && pick) {
        e.stopPropagation();
        setPick(null);
      }
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [pick]);
  // A pick does not outlive the turn it was made on, or the unit it was made for.
  useEffect(() => setPick(null), [act?.id, myTurn]);
  useEffect(() => {
    if (!zone.error) return;
    const t = setTimeout(zone.clearError, 3500);
    return () => clearTimeout(t);
  }, [zone.error, zone.clearError]);
  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 1500);
    return () => clearTimeout(t);
  }, [banner]);
  useEffect(() => {
    if (!roll) return;
    const t = setTimeout(() => setRoll(null), 2600);
    return () => clearTimeout(t);
  }, [roll]);

  if (!state || !act) {
    return (
      <div className="run zone-view">
        <div className="stage" ref={mount} />
        <div className="centre"><div className="panel">{zone.error ?? "Finding the way…"}{zone.error && <p><button onClick={onLeave}>Back to the Harbor</button></p>}</div></div>
      </div>
    );
  }

  // ---------- the bar ----------

  const canPay = (cost: "action" | "bonus") => !fighting || (myTurn && !!budget?.[cost]);
  const costName = (cost: "action" | "bonus") => (cost === "action" ? "Action" : "Bonus action");
  const slots: HudSlot[] = [
    ...act.abilities.slice(0, 3).map((id): HudSlot => {
      const def = ABILITIES[id];
      const tactic = tacticOf(id);
      const wait = act.cooldowns[id] ?? 0;
      const reachText = tactic.shape === "self" ? "yourself" : tactic.shape === "burst" ? `everyone within ${tactic.radius}` : tactic.reach === "melee" ? (tactic.shape === "adjacent" ? "every enemy beside you" : "an enemy beside you") : `${tactic.shape === "line" ? `a line of ${tactic.length}` : `range ${tactic.range}`}${tactic.shape === "blast" ? `, blast ${tactic.radius}` : ""}`;
      const dice = def.damage ? `${diceText(abilityDice(def))} damage` : def.heal ? `heals ${diceText(healDice(def))}` : "";
      return {
        id,
        glyph: def.name.slice(0, 2),
        name: def.name,
        line: [costName(tactic.cost), reachText, dice].filter(Boolean).join(" · "),
        more: `${def.blurb}${tactic.cooldown ? ` Then ${tactic.cooldown} turn${tactic.cooldown === 1 ? "" : "s"} before it can be used again.` : ""}`,
        wait: wait || undefined,
        picked: pick?.kind === "ability" && pick.id === id,
        spent: !canPay(tactic.cost) || (fighting && wait > 0),
        run: () => choose(id),
      };
    }),
    ...COMMON_ORDER.map((what): HudSlot => {
      const cost = commonCost(what, act.kind);
      const needsFight = what === "dash" || what === "disengage";
      return {
        id: what,
        glyph: COMMON_ACTIONS[what].name.slice(0, 2),
        name: COMMON_ACTIONS[what].name,
        line: costName(cost),
        more: COMMON_ACTIONS[what].blurb,
        count: what === "potion" ? act.potions : undefined,
        picked: pick?.kind === "common" && pick.what === what,
        spent: !canPay(cost) || (needsFight && !fighting) || (what === "potion" && act.potions <= 0),
        run: () => (what === "dash" || what === "disengage" || what === "potion" ? common(what) : setPick((p) => (p?.kind === "common" && p.what === what ? null : { kind: "common", what }))),
      };
    }),
  ];

  const waitingFor = enc && !myTurn ? enc.acting.map((id) => names.current.get(id) ?? "someone").join(" and ") : undefined;
  const place: ReactNode = pick
    ? <>{pick.kind === "ability" ? ABILITIES[pick.id].name : pick.kind === "throw" ? THROWABLES[pick.item].name : COMMON_ACTIONS[pick.what].name} <span className="muted">· click a target on the map, or Esc to put it back</span></>
    : dev.tool
      ? <>Dev tool <span className="muted">· {dev.tool.tool === "spawn" ? "click a hex to place the group" : "click hexes to paint"}</span></>
      : !enc || !fighting
        ? <>Exploring <span className="muted">· click a hex to walk{enc ? ". A fight is on nearby: walk in to join it" : ""}</span></>
        : myTurn
          ? <>{mine.length > 1 ? `${act.name}'s turn` : "Your turn"} <span className="muted">· round {enc.round}</span></>
          : <>Round {enc.round} <span className="muted">· waiting for {waitingFor}</span></>;

  // ---------- what is under the pointer ----------

  const under = unitOn(hover);
  const ground = hover ? tileAt(state.map, hover) : undefined;
  const preview = under && z && pick?.kind === "ability" && under.side !== act.side ? previewAttack(z, act, pick.id, under) : null;
  const surface = hover ? state.surfaces[posKey(hover)] : undefined;

  return (
    <div className={`run zone-view ${picking ? "picking" : ""}`} onContextMenu={(e) => { if (pick) { e.preventDefault(); setPick(null); } }}>
      <div className="stage" ref={mount} />

      {enc && (
        <div className="zone-order panel" aria-label="Initiative order">
          <span className="zone-round">Round {enc.round}</span>
          {enc.order.map((id) => {
            const u = (picture?.units ?? state.units).find((x) => x.id === id);
            if (!u) return null;
            const turn = enc.acting.includes(id) && !enc.done.includes(id);
            return (
              <span key={id} className={`zone-chip ${u.side} ${turn ? "turn" : ""} ${u.down ? "down" : ""}`} title={`${u.name} · initiative ${enc.init[id]}`}>
                <strong>{u.name.split(" ")[0]}</strong>
                <span className="zone-hp"><i style={{ width: `${(100 * u.hp) / u.maxHp}%` }} /></span>
              </span>
            );
          })}
        </div>
      )}

      {mine.length > 1 && (
        <div className="zone-party panel">
          {mine.map((u) => (
            <button key={u.id} className={`small ${u.id === act.id ? "primary" : ""}`} disabled={u.down || (!!enc?.order.includes(u.id) && !ready(u))} onClick={() => setPlayAs(u.id)}>
              {u.name.split(" ")[0]} · {u.hp}/{u.maxHp}
            </button>
          ))}
        </div>
      )}

      <div className="feed zone-feed" aria-live="polite">{feed.slice(-8).map((line, i) => <div key={feed.length - 8 + i}>{line}</div>)}</div>

      {banner && <div className="zone-banner">{banner}</div>}

      {roll && (
        <div className={`zone-roll panel ${roll.ok ? "ok" : "no"}`} role="status">
          <span className="zone-roll-what">{names.current.get(roll.id) ?? "Someone"} · {roll.label}{roll.adv !== 0 && <em>{roll.adv > 0 ? " · advantage" : " · disadvantage"}</em>}</span>
          <span className="zone-dice">
            {roll.d20.map((face, i) => <b key={i} className={face === roll.kept && (roll.d20.length === 1 || i === roll.d20.indexOf(roll.kept)) ? "kept" : "dropped"}>{face}</b>)}
          </span>
          <span className="zone-roll-sum">
            {roll.kept} {roll.bonus >= 0 ? "+" : "−"} {Math.abs(roll.bonus)} = <strong>{roll.total}</strong> against {roll.vs}
          </span>
          <span className="zone-roll-out">{roll.crit ? "Critical hit!" : roll.kind === "attack" ? (roll.ok ? "Hit" : "Miss") : roll.kind === "save" ? (roll.ok ? "Saved" : "Failed") : roll.ok ? "Shoved" : "Held firm"}</span>
        </div>
      )}

      {hover && ground && (
        <div className="zone-tip panel">
          {under ? (
            <>
              <strong>{under.name}</strong> <span className="muted">· {under.hp}/{under.maxHp} HP · Defence {defenceOf(under)}{under.down ? " · down" : ""}</span>
              {under.conditions.length > 0 && <div>{under.conditions.map((c) => <span key={c.kind} className="zone-cond" style={{ color: CONDITION_INFO[c.kind].color }} title={CONDITION_INFO[c.kind].blurb}>{CONDITION_INFO[c.kind].name} {c.rounds}</span>)}</div>}
              {under.side === "enemy" && <div className="muted">{ENEMIES[under.kind]?.attacks.map((a) => a.name).join(", ")}</div>}
              {preview && (
                <div className="zone-chance">
                  <strong>{Math.round(preview.chance * 100)}% to hit</strong> <span className="muted">· d20 {preview.bonus >= 0 ? "+" : "−"} {Math.abs(preview.bonus)} against {preview.vs}</span>
                  {preview.notes.map((n) => <div key={n} className="muted">{n}</div>)}
                </div>
              )}
            </>
          ) : (
            <>
              <strong>{ground.biome === "plains" ? "Open ground" : ground.biome === "forest" ? "Trees" : ground.biome === "cave" ? "Cave floor" : ground.biome === "rock" ? "Rock" : ground.biome === "water" ? "Water" : "Ground"}</strong>
              <span className="muted">{(ground.elev ?? 0) > 0 ? ` · ${ground.elev} up` : ""}{ground.biome === "forest" ? " · 2 to cross, cover from shots" : ground.biome === "rock" ? " · blocks the way and the view" : ""}</span>
            </>
          )}
          {surface && <div style={{ color: SURFACE_INFO[surface.kind].color }}>{SURFACE_INFO[surface.kind].name} <span className="muted">· {surface.rounds} round{surface.rounds === 1 ? "" : "s"} · {SURFACE_INFO[surface.kind].blurb}</span></div>}
        </div>
      )}

      {zone.error && <div className="toast">{zone.error}</div>}

      <HudBar
        me={me}
        place={place}
        hp={{ now: act.hp, max: act.maxHp }}
        meter={{ name: "Focus", note: "spend one to roll an attack with advantage", now: act.focus, max: act.maxFocus, kind: "focus" }}
        pips={fighting && budget ? [
          { label: "Action", now: budget.action ? 1 : 0, max: 1, kind: "action" },
          { label: "Bonus action", now: budget.bonus ? 1 : 0, max: 1, kind: "bonus" },
          { label: "Movement", now: budget.move, max: budget.moveMax, kind: "move" },
        ] : []}
        slots={slots}
        turn={enc && fighting ? { seconds: deadline, onEnd: myTurn ? () => zone.send({ type: "end_turn", unit: act.id }) : undefined, waitingFor } : undefined}
        menu={<OptionsMenu title={`Map ${code}`} subtitle={<>{state.options.biome} · {state.options.size}</>} actions={[{ label: "Leave the map", hint: "Back to the Harbor. The map stays as you left it.", run: onLeave }]} />}
      >
        <button className={`small ${focus ? "primary" : ""}`} disabled={act.focus <= 0} aria-pressed={focus} title="Spend 1 Focus on your next attack to roll it with advantage" onClick={() => setFocus((f) => !f)}>Focus {act.focus}</button>
        {THROW_ORDER.map((item) => {
          const have = item === "healing" ? act.potions : (act.items[item] ?? 0);
          return (
            <button key={item} className={`small ${pick?.kind === "throw" && pick.item === item ? "primary" : ""}`} disabled={have <= 0 || !canPay("action")} title={`Throw: ${THROWABLES[item].blurb}`} onClick={() => setPick((p) => (p?.kind === "throw" && p.item === item ? null : { kind: "throw", item }))}>
              {THROWABLES[item].name.split(" ")[0]} {have}
            </button>
          );
        })}
      </HudBar>
    </div>
  );
}
