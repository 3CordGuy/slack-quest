// A zone: a map the party walks freely and fights on, turn by turn, on the
// tiles themselves. The rules are packages/world/src/zone; this is the
// picture of them and the hands on them.
//
// Out of a fight a click walks you there; a click on an enemy runs you up
// to it, and that is what starts a fight. In one, on your turn, the bar's
// slots are what you can do: pick one and the map shows how far it reaches
// and what it would cover; click a target and it is done. Movement is a
// click on any lit hex, in as many pieces as you like. Something from the
// pack is thrown where you click, or (a potion) drunk if you click yourself.
// In a delve a click on a chest opens it, a click on a crate breaks at it
// with your own blow, and a click on glowing mushrooms picks them (each walks
// you up to it first).
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
  CRATE_HP,
  ENEMIES,
  FLEE_RANGE,
  FREE_WALK,
  pathIn,
  HARBOR_CAVE,
  SURFACE_INFO,
  THROWABLES,
  abilityArea,
  abilityDice,
  checkAbility,
  checkCommon,
  checkThrow,
  commonCost,
  crateAt,
  crateBlow,
  crateHp,
  defenceOf,
  diceText,
  healDice,
  isCrateId,
  jumpRange,
  previewAttack,
  sees,
  statMod,
  tacticOf,
  throwRange,
  tileAt,
  FORCE_DC,
  unopened,
  zoneBlast,
  zoneReach,
  type CommonAction,
  type GroundSurface,
  type Poi,
  type Roll,
  type Throwable,
  type Unit,
  type ZoneEvent,
  type ZoneState,
  type ZoneView as ZoneViewState,
  modName,
  stoneName,
} from "@gantt-quest/world";
import { api, type Me } from "./api";
import { CrewRoster, type RosterMember } from "./CrewRoster";
import { InventoryScreen } from "./InventoryScreen";
import { Trading } from "./TradePanel";
import { useAudioScene } from "./audio/useAudioScene";
import { sounds } from "./audio/gameSounds";
import { OptionsMenu } from "./OptionsMenu";
import * as THREE from "three";
import { SpellFx } from "./render/SpellFx";
import { TacticsLayer, type Overlay } from "./render/TacticsLayer";
import { spriteDataUrl } from "./render/sprites";
import { WorldRenderer, hexToWorld, tileTop, type RenderState } from "./render/WorldRenderer";
import { HudBar, type HudSlot } from "./ui/Hud";
import { useCountdown } from "./ui/useCountdown";
import { useZone } from "./useZone";
import { Icon } from "./items";
import { label } from "./labels";
import { THROW_COLOR, aimKind, fxFor } from "./zone/abilityFx";
import { COMMON_ICON, ITEM_ICON, abilityIcon } from "./zone/actionIcons";
import { BAR_SLOTS, assignSlot, barChoices, loadBar, moveSlot, saveBar } from "./zone/hotbar";
import { setZoneDev, useZoneDev } from "./zone/zoneDev";
import "./zone/zone.css";

/** What is waiting for a click on the map. */
type Pick = { kind: "ability"; id: string } | { kind: "common"; what: CommonAction } | { kind: "item"; item: Throwable };

/** The part of the state the picture shows, which lags the truth while events play out. */
interface Picture {
  units: Unit[];
  surfaces: Record<string, GroundSurface>;
  /** The places on the map: a chest is drawn thrown open, and a crate knocked about or broken, as each is shown happening. */
  pois: Poi[];
}

const asState = (view: ZoneViewState) => view as unknown as ZoneState;

/** How long a leave asked for mid-fight waits for the Flee before it is given up. */
const LEAVING_WAIT_MS = 6000;

/** The things that are done, as against what comes of them: each starts a new run of results. */
const CAUSES = new Set<ZoneEvent["t"]>(["used", "moved", "jumped", "shoved", "reaction", "turn", "round", "fight_start", "fight_end"]);

/**
 * Which events land on several at once, and which is the last of its run. What comes of one thing done
 * (a blast, a flask, a round of fire underfoot) is every event up to the next thing done; when that
 * reaches more than one fighter they are all shown together, a beat apart, and not one after another.
 */
function runs(events: ZoneEvent[]): { many: boolean[]; last: boolean[] } {
  const many = events.map(() => false);
  const last = events.map(() => false);
  let start = 0;
  const close = (end: number) => {
    if (end === start) return;
    const reached = new Set<string>();
    for (let k = start; k < end; k++) {
      const ev = events[k];
      if (ev.t === "hit" || ev.t === "miss" || ev.t === "heal" || ev.t === "tick") reached.add(ev.target);
      if (ev.t === "crate_hit") reached.add(ev.poi);
    }
    for (let k = start; k < end; k++) many[k] = reached.size > 1;
    last[end - 1] = true;
    start = end;
  };
  events.forEach((ev, i) => {
    if (CAUSES.has(ev.t)) close(i);
  });
  close(events.length);
  return { many, last };
}

/**
 * How long the picture dwells on each thing that happened, in ms. `many`: it is one of several that
 * land together. `next`: what follows, so that going down or catching fire comes on the heels of the blow.
 */
function dwell(ev: ZoneEvent, many: boolean, next: ZoneEvent | undefined): number {
  const follows = (id: string) => !!next && ((next.t === "down" && next.id === id) || (next.t === "condition" && next.target === id));
  switch (ev.t) {
    case "moved": return Math.min(2400, ev.path.length * 400);
    case "roll": return ev.roll.kind === "initiative" ? 110 : many ? 0 : 440;
    case "used": return ev.what.startsWith("throw:") ? 620 : 280;
    case "hit": case "heal": case "tick": return many ? 130 : follows(ev.target) ? 200 : 380;
    case "miss": return many ? 130 : 380;
    case "condition": return many ? 50 : 150;
    case "down": return many ? 130 : 320;
    case "skip": return 320;
    case "surface": return many ? 80 : 240;
    case "up": case "fight_join": case "round": return 240;
    case "burst": case "reaction": return 300;
    case "shoved": return 400;
    // The crouch, the leap and the landing: what follows waits for the feet to come down.
    case "jumped": return 700;
    case "fight_start": return 1300;
    case "fight_end": return 700;
    case "fled": return 420;
    case "cleared": return 900;
    // The lid swings and the glints spill; a blow at a crate lands before it breaks.
    case "opened": return 700;
    case "crate_hit": return many ? 130 : 420;
    case "crate_broken": return 450;
    default: return 0;
  }
}
/** The conditions on a unit, as badges over its head: in CONDITION_INFO's colours, with rounds left. */
const badgesOf = (u: Unit) => u.conditions.map((c) => ({ kind: c.kind, color: CONDITION_INFO[c.kind].color, rounds: c.rounds }));

/** How a lit torch is drawn in a hand (figures.ts drawTorch). */
const TORCH_IN_HAND = { icon: "torch", ref: "torch", rarity: "common" as const };

/** The breath after several have been struck at once, before the next thing is shown. */
const AFTER_MANY = 340;

/** What an attack is called, for its look and sound: an ability's name, or an enemy attack's own. */
const blowName = (what: string) => ABILITIES[what]?.name ?? what;

type CrewPlaces = Awaited<ReturnType<typeof api.crewPlaces>>["members"];

export function ZoneView({ code, me, refresh, onLeave }: { code: string; me: Me; refresh(): Promise<unknown>; onLeave(): void }) {
  const mount = useRef<HTMLDivElement>(null);
  const renderer = useRef<WorldRenderer | null>(null);
  const layer = useRef<TacticsLayer | null>(null);
  const spells = useRef<SpellFx | null>(null);
  /** The map as the effects need it: the middle of a hex's top, `lift` above it. */
  const mapNow = useRef<ZoneViewState["map"] | null>(null);
  const point = (pos: HexPos, lift = 0) => {
    const { x, z } = hexToWorld(pos);
    return new THREE.Vector3(x, tileTop(mapNow.current ? tileAt(mapNow.current, pos) : undefined) + lift, z + (lift > 0 ? 0.25 : 0));
  };
  const [picture, setPicture] = useState<Picture | null>(null);
  const [feed, setFeed] = useState<string[]>([]);
  const [roll, setRoll] = useState<Roll | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  /** The last enemy in a cave has fallen: ask whether to climb out now. */
  const [clearedAsk, setClearedAsk] = useState(false);
  /** A place on the crew's atlas has been cleared and its bounty paid: ask whether to go back to the atlas. */
  const [chartAsk, setChartAsk] = useState(false);
  const [pick, setPick] = useState<Pick | null>(null);
  const [focus, setFocus] = useState(false);
  const [hover, setHover] = useState<HexPos | null>(null);
  const [playAs, setPlayAs] = useState<string | null>(null);
  /** The bar's eighteen slots, by key (zone/hotbar.ts), and the slot whose contents are being chosen. */
  const [bar, setBar] = useState<string[]>([]);
  const [barMenu, setBarMenu] = useState<number | null>(null);
  /** The crew and where each of them is, asked for every few seconds; and who the trade table is open with. */
  const [crew, setCrew] = useState<CrewPlaces>([]);
  const [tradeWith, setTradeWith] = useState<string | null>(null);
  /** The sea bag, open over the map. */
  const [bag, setBag] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** A fight has just broken out: the screen says so for a moment. */
  const [intro, setIntro] = useState(false);
  /** Whoever the picture is showing act right now (an enemy mid-turn, while the server already waits on you). */
  const [spot, setSpot] = useState<string | null>(null);
  /** The enemy's turn is still being shown, though the server may already be waiting on you: not yours to play yet. */
  const [watching, setWatching] = useState(false);
  /** The label that rides beside the pointer: moved by hand, so the whole view is not drawn again for every pixel. */
  const cursor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    const ask = () => api.crewPlaces().then((r) => live && setCrew(r.members), () => undefined);
    ask();
    const t = setInterval(ask, 6000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 3500);
    return () => clearTimeout(t);
  }, [note]);
  /** Go to where a crewmate is: their map (beside them), or the Harbor if they are not out on one. */
  const teleportTo = (id: string) => {
    api.teleport(id).then(({ zone: to }) => {
      if (!to) return onLeave();
      try {
        sessionStorage.setItem("gq.zone.near", id);
      } catch {
        // Storage is off: they arrive at the map's start.
      }
      location.hash = `zone/${to}`;
    }, (e: Error) => setNote(e.message));
  };
  const names = useRef(new Map<string, string>());
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const settled = useRef<Picture | null>(null);
  const dev = useZoneDev();

  // ---------- the connection, and playing out what happened ----------

  const zone = useZone(code, (next, events, prev) => {
    for (const u of next.units) names.current.set(u.id, u.name);
    mapNow.current = next.map;
    const name = (id: string | null | undefined) => (id ? (names.current.get(id) ?? (isCrateId(next, id) ? "the crate" : "Someone")) : "Something");
    // Anything still playing from the last update is finished at once.
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
    const end: Picture = { units: next.units, surfaces: next.surfaces, pois: next.map.pois };
    const from = settled.current;
    settled.current = end;
    if (!prev || !from || events.length === 0) {
      // Nothing to play out: whatever was being shown is over.
      setSpot(null);
      setWatching(false);
      return setPicture(end);
    }
    const yours = (id: string) => next.units.some((u) => u.id === id && (u.id === next.you || u.controller === next.you));
    // The turn has passed to the enemy in this: it is watched through before the turn is yours again.
    setWatching(!!next.encounter && events.some((ev) => ev.t === "turn" && !ev.ids.some(yours)));
    const { many, last } = runs(events);

    const draft: Picture = structuredClone(from);
    /** The thing last used, whose blows the hits and misses after it are. */
    let use: { id: string; what: string; look: ReturnType<typeof fxFor>; last: THREE.Vector3 | null } | null = null;
    const find = (id: string) => draft.units.find((u) => u.id === id);
    const lines: string[] = [];
    let at = 0;
    const later = (run: () => void) => timers.current.push(setTimeout(run, at));
    /** Whoever the last thing shown was done by, so a new actor can be announced once as their turn comes up. */
    let acting: string | null = null;
    const nowActing = (id: string) => {
      if (id === acting) return;
      acting = id;
      const unit = find(id);
      const foe = unit?.side === "enemy";
      const where = unit?.pos;
      later(() => {
        setSpot(id);
        // An enemy's turn is heard, and the view goes to it. Your own is announced by its own event.
        if (foe && next.encounter) {
          sounds.zone("turn.enemy");
          if (where) renderer.current?.lookAt(where);
        }
      });
    };
    for (const [i, ev] of events.entries()) {
      const say = (line: string) => later(() => setFeed((f) => [...f, line].slice(-40)));
      const view = renderer.current;
      /** The unit makes its gesture (a cast, or a bow drawn), and `go`, what leaves its hand, runs as the gesture ends: at once with no view to draw it. */
      const cast = (id: string, name: string, x: number, z: number, go: () => void, thrown = false) => (view ? view.cast(id, name, x, z, go, thrown) : go());
      if ((ev.t === "moved" || ev.t === "used" || ev.t === "jumped") && next.encounter?.order.includes(ev.id)) nowActing(ev.id);
      if (ev.t === "moved") {
        const u = find(ev.id);
        if (u) u.pos = ev.path[ev.path.length - 1];
        later(() => view?.walkUnit(ev.id, ev.path));
      } else if (ev.t === "jumped") {
        const u = find(ev.id);
        if (u) u.pos = ev.to;
        // A leap, not a walk; the view sounds it, timed to the landing.
        later(() => (view ? view.leapUnit(ev.id, ev.to) : sounds.zone("jump")));
      } else if (ev.t === "shoved") {
        const u = find(ev.target);
        const to = ev.to;
        if (u && to) u.pos = to;
        later(() => {
          // Flung back and off their feet; with nowhere to go, flattened where they stand.
          sounds.zone("shove", view?.whereIs(ev.target));
          if (to) view?.knock(ev.target, to);
          else view?.floor(ev.target);
          timers.current.push(setTimeout(() => sounds.zone("fall", view?.whereIs(ev.target)), 260));
        });
        say(to ? `${name(ev.id)} shoves ${name(ev.target)} back.` : `${name(ev.id)} shoves ${name(ev.target)}, who has nowhere to go and falls.`);
      } else if (ev.t === "used") {
        // Getting away has a line of its own (fled).
        if (ev.what !== "flee") say(`${name(ev.id)}: ${ev.name}${ev.target ? ` on ${name(ev.target)}` : ""}.`);
        const user = find(ev.id);
        const from = user ? point(user.pos, 0.9) : null;
        const thrown = ev.what.startsWith("throw:") ? (ev.what.slice(6) as Throwable) : null;
        const look = fxFor(ev.what === "attack" ? ev.name : ev.what, ev.what === "attack" && !ev.target);
        // Where each target of this use stood, so lightning can run from one to the next.
        use = { id: ev.id, what: ev.what === "attack" ? ev.name : ev.what, look, last: from };
        // What it covers, for the things that come up out of the ground or roll across it.
        const covered = user && ABILITIES[ev.what] ? abilityArea(asState({ ...next, units: draft.units }), user, ev.what, ev.at) : [];
        later(() => {
          const fxs = spells.current;
          view?.floatOver(ev.id, ev.name, "#fff1c9");
          if (!fxs || !from || !user) return;
          if (thrown && ev.at) {
            sounds.zone("throw", view?.whereIs(ev.id));
            const land = point(ev.at, 0.05);
            cast(
              ev.id,
              ev.name,
              land.x,
              land.z,
              () =>
                fxs.launch("flask", from, land, THROW_COLOR[thrown], () => {
                  sounds.zone("shatter", { x: land.x, z: land.z });
                  fxs.ring(land, 2.4, THROW_COLOR[thrown]);
                }),
              true,
            );
            return;
          }
          if (ev.what.startsWith("drink:")) return fxs.motes(point(user.pos, 0.3), "#7dff9a");
          const aim = ev.at ? point(ev.at, 0.05) : null;
          if (look.kind === "meteor" && aim) {
            cast(ev.id, ev.name, aim.x, aim.z, () => fxs.launch("meteor", from, aim, look.color, () => fxs.ring(aim, 2.6, look.color)));
          } else if (look.kind === "storm" && aim) {
            cast(ev.id, ev.name, aim.x, aim.z, () => {
              fxs.spark([aim.clone().add(new THREE.Vector3(0.6, 9, -0.4)), aim], look.color);
              fxs.ring(aim, 2.6, look.color);
            });
          } else if (look.kind === "lob" && aim) {
            cast(ev.id, ev.name, aim.x, aim.z, () => fxs.launch("bolt", from, aim, look.color, () => fxs.ring(aim, 2.4, look.color)));
          } else if (look.kind === "beam" && covered.length > 0) {
            const end = point(covered[covered.length - 1], 0.9);
            cast(ev.id, ev.name, end.x, end.z, () => fxs.beam(from, end, look.color));
          } else if (look.kind === "erupt" && covered.length > 0) {
            cast(ev.id, ev.name, point(covered[0]).x, point(covered[0]).z, () => fxs.erupt(covered.map((p) => point(p)), look.color));
          } else if (look.kind === "ring") {
            // Struck all round (a song, played): the ring goes out as the blow lands.
            const ring = () => fxs.ring(point(user.pos, 0.05), ev.what === "attack" ? 3.6 : covered.length > 6 ? 3.6 : 1.9, look.color);
            if (view) view.burst(ev.id, ev.name, ABILITIES[ev.what]?.stat === "int_stat", ring);
            else ring();
          } else if (look.kind === "bless") {
            // A guard is braced behind; a heal or a blessing is played or cast, toward whoever it is for.
            const whom = ev.target && ev.target !== ev.id ? find(ev.target) : null;
            if (ev.what === "shield_wall" || ev.what === "hold_the_line") view?.brace(ev.id);
            else view?.bless(ev.id, whom ? point(whom.pos) : null);
          }
        });
      } else if (ev.t === "roll") {
        if (ev.roll.kind === "initiative") {
          // Each fighter's roll comes up over their head, one after another.
          later(() => {
            sounds.zone("roll");
            view?.floatOver(ev.roll.id, String(ev.roll.total), "#ffe9a8");
          });
        } else if (!many[i]) {
          // One of several struck at once has no card of its own: the numbers over their heads say how each fared.
          later(() => {
            sounds.zone(ev.roll.crit ? "roll.crit" : "roll");
            setRoll(ev.roll);
          });
        }
      } else if (ev.t === "hit" || ev.t === "miss") {
        const hit = ev.t === "hit";
        const target = find(ev.target);
        const actor = ev.actor ? find(ev.actor) : undefined;
        if (hit && target) target.hp = Math.max(0, target.hp - ev.amount);
        const mark = hit ? () => view?.floatOver(ev.target, `-${ev.amount}`, ev.crit ? "#ffd23f" : "#ff6b6b") : () => view?.floatOver(ev.target, "miss", "#c9d1e0");
        const what = blowName(ev.what);
        // How this blow gets there: thrown or struck all at once (the picture is already playing), flown, or dealt by hand.
        const mine = use && use.id === ev.actor ? use : null;
        const kind = !ev.actor || ev.actor === ev.target || ev.what.startsWith("throw:") || ev.what === "shove" ? "none" : (mine?.look.kind ?? "melee");
        const color = mine?.look.color ?? "#dfe9ff";
        const to = target ? point(target.pos, 0.8) : null;
        const from = actor ? point(actor.pos, 0.9) : null;
        const chained = mine?.last ?? from;
        if (mine && to) mine.last = to;
        later(() => {
          const fxs = spells.current;
          if (kind === "melee") return view?.blow(ev.actor!, ev.target, what, { crit: hit && ev.crit, landed: hit, onImpact: mark });
          if (fxs && from && to && (kind === "arrow" || kind === "bolt")) {
            // A miss flies wide of the mark.
            const end = hit ? to : to.clone().add(new THREE.Vector3(0.7, 0.5, 0.5));
            cast(ev.actor!, what, to.x, to.z, () =>
              fxs.launch(kind, from, end, color, () => {
                view?.landed(ev.target, what, hit, hit && ev.crit, ev.actor);
                mark();
              }),
            );
            return;
          }
          if (fxs && chained && to && kind === "spark") {
            cast(ev.actor!, what, to.x, to.z, () => {
              fxs.spark([chained, to], color);
              view?.landed(ev.target, what, hit, hit && ev.crit, ev.actor);
              mark();
            });
            return;
          }
          if (kind !== "none") view?.landed(ev.target, what, hit, hit && ev.crit, ev.actor);
          mark();
        });
        say(hit ? `${name(ev.target)} takes ${ev.amount}${ev.crit ? " (critical hit)" : ""}.` : `${name(ev.actor)} misses ${name(ev.target)}.`);
      } else if (ev.t === "heal") {
        const u = find(ev.target);
        if (u) u.hp = Math.min(u.maxHp, u.hp + ev.amount);
        later(() => {
          sounds.heal(blowName(ev.what), view?.whereIs(ev.target));
          const healed = find(ev.target);
          if (healed) spells.current?.motes(point(healed.pos, 0.3), use?.look.kind === "bless" ? use.look.color : "#7dff9a");
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
        // The view goes to the middle of it, and the screen says a fight is on while the dice come up.
        const fighters = ev.units.map(find).filter((u): u is Unit => !!u);
        const mid = fighters.length > 0 ? { q: fighters.reduce((n, u) => n + u.pos.q, 0) / fighters.length, r: fighters.reduce((n, u) => n + u.pos.r, 0) / fighters.length } : null;
        const centre = mid ? fighters.reduce((best, u) => (Math.hypot(u.pos.q - mid.q, u.pos.r - mid.r) < Math.hypot(best.pos.q - mid.q, best.pos.r - mid.r) ? u : best)).pos : null;
        later(() => {
          sounds.stinger("battle_start");
          sounds.zone("initiative");
          setIntro(true);
          timers.current.push(setTimeout(() => setIntro(false), 1700));
          if (centre) view?.lookAt(centre);
        });
        say("A fight breaks out. Roll for initiative.");
      } else if (ev.t === "fight_join") {
        say(`${name(ev.id)} joins the fight.`);
      } else if (ev.t === "round") {
        say(`Round ${ev.n}.`);
      } else if (ev.t === "turn") {
        if (ev.ids.some(yours)) {
          const mine = next.units.find((u) => ev.ids.includes(u.id) && yours(u.id));
          later(() => {
            sounds.yourTurn();
            setBanner("Your turn");
            setSpot(null);
            setWatching(false);
            if (mine) view?.lookAt(mine.pos);
          });
        }
      } else if (ev.t === "fled") {
        later(() => {
          sounds.flee(true, view?.whereIs(ev.id));
          view?.floatOver(ev.id, "Got away", "#ffd98a");
          if (yours(ev.id)) setBanner("You got away");
        });
        say(`${name(ev.id)} gets away from the fight.`);
      } else if (ev.t === "fight_end") {
        later(() => {
          // Getting away was heard as it happened: no stinger for a fight nobody won.
          if (ev.outcome !== "fled") sounds.stinger(ev.outcome);
          setBanner(ev.outcome === "victory" ? "Victory" : ev.outcome === "defeat" ? "Defeated" : "Got away");
        });
        say(ev.outcome === "victory" ? "The fight is won." : ev.outcome === "defeat" ? "The fight is lost. You wake where you started." : "Nobody is left in the fight: it is over. The enemy go back to their posts and bind their wounds; those that fell stay fallen.");
      } else if (ev.t === "spoils") {
        const found = [
          ...(ev.gold ? [`${ev.gold} gold`] : []),
          ...Object.entries(ev.resources).filter(([, n]) => n).map(([kind, n]) => `${n} ${label("resource", kind).toLowerCase()}`),
          ...(ev.item ? [ev.item] : []),
          ...(ev.potions ? [ev.potions === 1 ? "a healing potion" : `${ev.potions} healing potions`] : []),
          ...(ev.torches ? [ev.torches === 1 ? "a torch" : `${ev.torches} torches`] : []),
          ...(ev.blueprint ? ["a blueprint"] : []),
          ...(ev.furnishing ? [ev.furnishing] : []),
          ...(ev.stone ? [`a ${stoneName(ev.stone).toLowerCase()} (${ev.stone.map((id) => modName(id)).join(", ")}) for the crew's case`] : []),
        ];
        // A crate pays no XP: only what was in it is told.
        if (ev.xp > 0) say(`${name(ev.id)} earns ${ev.xp} XP${found.length > 0 ? ` and takes ${found.join(", ")}` : ""}.`);
        else if (found.length > 0) say(`${name(ev.id)} takes ${found.join(", ")}.`);
        // And over their head, one thing at a time: gold first, then the XP, then whatever else.
        const pops = [
          ...(ev.gold ? [{ text: `+${ev.gold} gold`, color: "#ffd23f" }] : []),
          ...(ev.xp > 0 ? [{ text: `+${ev.xp} XP`, color: "#ffe27a", xp: ev.xp }] : []),
          ...Object.entries(ev.resources).filter(([, n]) => n).map(([kind, n]) => ({ text: `+${n} ${label("resource", kind).toLowerCase()}`, color: "#e8dcc0" })),
          ...(ev.item ? [{ text: `+${ev.item}`, color: "#c4b5fd" }] : []),
          ...(ev.potions ? [{ text: ev.potions === 1 ? "+1 healing potion" : `+${ev.potions} healing potions`, color: "#ff8a8a" }] : []),
          ...(ev.torches ? [{ text: ev.torches === 1 ? "+1 torch" : `+${ev.torches} torches`, color: "#ffb070" }] : []),
          ...(ev.blueprint ? [{ text: "+a blueprint", color: "#9fd8ff" }] : []),
          ...(ev.furnishing ? [{ text: `+${ev.furnishing}`, color: "#9fd8ff" }] : []),
          ...(ev.stone ? [{ text: `+${stoneName(ev.stone)}`, color: "#7fd0ff" }] : []),
        ];
        if (pops.length > 0) later(() => view?.pickups(ev.id, pops));
        // Your own level, XP and materials as the server now has them.
        if (ev.id === next.you) later(() => void refresh());
      } else if (ev.t === "cleared") {
        later(() => {
          setBanner("Cleared");
          // A cave: offer the way out (or a while longer to open what is left).
          if (next.options.biome === "caves") setClearedAsk(true);
        });
        say("Nothing else stirs here.");
      } else if (ev.t === "bounty") {
        // A place on the atlas, cleared: its bounty has just been shared out (the spoils before this).
        later(() => {
          setBanner(`${next.options.name ?? "It"} is cleared`);
          setClearedAsk(false);
          setChartAsk(true);
        });
        say(`${next.options.name ?? "This place"} is cleared. Its bounty is shared out, and the routes beyond it are open.`);
      } else if (ev.t === "key") {
        // On the ring: over whoever found it, or (from a beaten band) your own hero, as the ring is everyone's.
        const finder = ev.id ?? next.you;
        later(() => view?.pickups(finder, [{ text: "+1 key", color: "#ffd98a" }]));
        say(ev.from === "chest" ? `${ev.id ? name(ev.id) : "Someone"} finds a key in it. (${ev.keys} on the ring)` : `A key falls from the beaten band. (${ev.keys} on the ring)`);
      } else if (ev.t === "foraged") {
        say(`${name(ev.id)} picks the glowing mushrooms.`);
      } else if (ev.t === "door") {
        say(ev.how === "key" ? `${name(ev.id)} unlocks the door.` : ev.how === "forced" ? `${name(ev.id)} forces the door: it gives way with a crash.` : `${name(ev.id)} throws a shoulder at the door: it holds.`);
      } else if (ev.t === "noise") {
        say("The noise carries through the tunnels. Something is coming.");
      } else if (ev.t === "opened") {
        const chest = draft.pois.find((p) => p.id === ev.poi);
        if (chest) chest.cleared = true;
        later(() => {
          const top = chest ? view?.poiSpot(chest) : null;
          sounds.zone("chest_open", top ? { x: top.x, z: top.z } : undefined);
          view?.openChest(ev.poi);
          // The glints spill out once the lid is a little way up.
          if (top) timers.current.push(setTimeout(() => spells.current?.spill(top, ev.loot === "hoard"), 110));
        });
        say(`${name(ev.id)} opens ${ev.loot === "hoard" ? "the hoard" : ev.loot === "vault" ? "the strongbox" : "a chest"}.`);
      } else if (ev.t === "crate_hit") {
        const box = draft.pois.find((p) => p.id === ev.poi);
        if (box) box.hp = Math.max(0, crateHp(box) - ev.amount);
        const shown = box ? { ...box } : null;
        // A blow by hand, a shot or a spark is shown reaching it; a blast, a bomb or the fire under it is already playing.
        const mine = use && use.id === ev.actor ? use : null;
        const look = !ev.actor || ev.what === "fire" || ev.what.startsWith("throw:") ? null : (mine?.look.kind ?? "melee");
        const what = blowName(ev.what);
        const actor = ev.actor ? find(ev.actor) : undefined;
        const from = actor ? point(actor.pos, 0.9) : null;
        later(() => {
          const fxs = spells.current;
          const at = shown ? view?.poiSpot(shown) : null;
          const impact = () => {
            sounds.zone("crate_hit", at ? { x: at.x, z: at.z } : undefined);
            view?.shakePoi(ev.poi, ev.amount >= 6 ? 1.4 : 1);
            view?.floatAt(ev.poi, `-${ev.amount}`, ev.what === "fire" ? "#ffa94d" : "#ff6b6b");
            if (at) fxs?.splinters(at, 5);
          };
          if (!at || !from || !look) return impact();
          if (look === "melee") return view ? view.strikeAt(ev.actor!, at, what, impact) : impact();
          if (fxs && (look === "arrow" || look === "bolt")) return cast(ev.actor!, what, at.x, at.z, () => fxs.launch(look, from, at, mine?.look.color ?? "#dfe9ff", impact));
          if (fxs && look === "spark") return cast(ev.actor!, what, at.x, at.z, () => { fxs.spark([from, at], mine?.look.color ?? "#dfe9ff"); impact(); });
          impact();
        });
        say(`The crate takes ${ev.amount}${ev.what === "fire" ? " from the fire" : ""}.`);
      } else if (ev.t === "crate_broken") {
        const box = draft.pois.find((p) => p.id === ev.poi);
        const whole = box ? { ...box, cleared: false } : null;
        if (box) Object.assign(box, { cleared: true, hp: 0 });
        later(() => {
          const at = whole ? view?.poiSpot(whole) : null;
          sounds.zone("crate_break", at ? { x: at.x, z: at.z } : undefined);
          if (at) spells.current?.splinters(at, 18, true);
        });
        say(ev.id ? `${name(ev.id)} breaks the crate open.` : "The crate burns through and falls apart.");
      } else if (ev.t === "stowed") {
        say(ev.place === "storage" ? `${ev.item} goes home to the storage chest: the pack is full.` : `${ev.item} is crammed into the pack, over what it holds.`);
      } else if (ev.t === "lit") {
        say(`${name(ev.id)} lights a torch.`);
      } else if (ev.t === "torch_out") {
        say(`${name(ev.id)}'s torch gutters out.`);
      } else if (ev.t === "took_torch") {
        if (ev.stowed) later(() => view?.pickups(ev.id, [{ text: "+1 torch", color: "#ffb070" }]));
        say(ev.stowed ? `${name(ev.id)} puts out a torch and stows it in the pack.` : `${name(ev.id)} picks up a burning torch.`);
      } else if (ev.t === "light" && !ev.on) {
        // Gone from the ground because someone took it up is not burning out.
        const taken = events.some((e) => e.t === "took_torch" && e.at.q === ev.at.q && e.at.r === ev.at.r);
        if (!taken) say("A torch on the ground burns out.");
      } else if (ev.t === "joined") {
        say(`${name(ev.id)} arrives.`);
      }
      // What the picture shows once this event has been seen.
      const shown: Picture = structuredClone(draft);
      later(() => setPicture(shown));
      at += dwell(ev, many[i], events[i + 1]) + (many[i] && last[i] ? AFTER_MANY : 0);
    }
    if (lines.length > 0) setFeed((f) => [...f, ...lines].slice(-40));
    later(() => {
      setPicture(end);
      setSpot(null);
      setWatching(false);
    });
  });
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const state = zone.state;
  const enc = state?.encounter ?? null;
  // Which of your own you are playing: your hero, or a stand-in whose turn it is.
  // What your own hero carries comes out of your pack: when the count on the map changes, the pack is read again.
  const carried = JSON.stringify(state?.units.find((u) => u.id === state.you)?.items ?? null);
  useEffect(() => {
    if (carried !== "null") void refresh();
  }, [carried]);
  const mine = useMemo(() => state?.units.filter((u) => u.side === "hero" && (u.id === state.you || u.controller === state.you)) ?? [], [state]);
  const ready = (u: Unit) => !!enc && enc.acting.includes(u.id) && !enc.done.includes(u.id) && !u.down;
  const act = mine.find((u) => u.id === playAs && (!enc || !enc.order.includes(u.id) || ready(u))) ?? mine.find(ready) ?? mine.find((u) => u.id === state?.you) ?? mine[0];
  const fighting = !!act && !!enc?.order.includes(act.id);
  // While an enemy's turn is still being shown the turn is not yet yours to play, though the server already
  // waits on you: what they did is seen through, and the health it cost is on the bars, before you answer it.
  const myTurn = !!act && fighting && ready(act) && !watching;
  /** A unit as the picture shows it now: its health moves as each blow and heal lands, not ahead of them. */
  const seen = (u: Unit) => picture?.units.find((x) => x.id === u.id) ?? u;
  const budget = act && enc ? enc.budgets[act.id] : undefined;
  const deadline = useCountdown(enc?.deadline);

  // The bar is the one this class was last left with, made to fit the abilities in hand.
  const barFor = act ? `${act.kind}|${act.abilities.join(",")}` : "";
  useEffect(() => {
    if (act) setBar(loadBar(act.kind, act.abilities));
    setBarMenu(null);
  }, [barFor]);
  const arrange = (next: string[]) => {
    setBar(next);
    if (act) saveBar(act.kind, next);
  };

  useAudioScene(mine.some((u) => enc?.order.includes(u.id)) ? "battle" : state?.options.biome === "caves" ? "caverns" : "island");

  // ---------- the renderer ----------

  const click = useRef<(pos: HexPos) => void>(() => {});
  useEffect(() => {
    const view = new WorldRenderer(mount.current!, { onHexClick: (pos) => click.current(pos), onHover: setHover });
    renderer.current = view;
    layer.current = new TacticsLayer(view);
    spells.current = new SpellFx(view);
    return () => {
      layer.current?.dispose();
      layer.current = null;
      spells.current?.dispose();
      spells.current = null;
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
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__gqZone = { state: zone.state, send, layer: layer.current, view: renderer.current };
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
      // Chests and crates as the picture has them: thrown open, or knocked about and broken, as each is shown.
      map: { ...state.map, pois: picture.pois },
      // A lit torch is held in the off hand, where a shield would be.
      heroes: picture.units.filter((u) => u.side === "hero").map((u) => ({ id: u.id, classId: u.kind, pos: u.pos, name: u.name, outfit: u.torch ? { ...u.outfit, [u.torchHand === "main" ? "main_hand" : "off_hand"]: TORCH_IN_HAND } : u.outfit, torch: !!u.torch, effects: badgesOf(u), level: u.level, xp: 0, hp: u.hp, maxHp: u.maxHp, down: u.down, prone: u.conditions.some((c) => c.kind === "prone"), active: turn(u.id) })),
      // What the dark hides is not drawn: out of a fight the server does not even send it.
      units: picture.units.filter((u) => u.side === "enemy" && !state.dark?.includes(u.id)).map((u) => ({ id: u.id, kind: u.kind, pos: u.pos, name: u.name, hp: inFight(u.id) || u.hp < u.maxHp ? u.hp / u.maxHp : undefined, down: u.down, prone: u.conditions.some((c) => c.kind === "prone"), active: u.id === spot, hostile: inFight(u.id), effects: badgesOf(u) })),
      turn: null,
      story: null,
      npcs: {},
      // Lit tiles are a turn's movement; walking freely, nothing is lit.
      freeRoam: !fighting,
      // Underground, light comes only from torches (held, or lying where they were thrown) and fire.
      lights: state.options.biome === "caves" ? Object.keys(state.lights ?? {}).map((k) => { const [q, r] = k.split(",").map(Number); return { q, r }; }) : undefined,
      reach,
    };
    view.setState(scene);
    layer.current?.setMap(state.map);
    layer.current?.setSurfaces(picture.surfaces);
  }, [state, picture, reach, act?.id, fighting, code, enc, spot]);

  // ---------- what a pick reaches, and what it would cover ----------

  const z = state ? asState(state) : null;
  const unitOn = (pos: HexPos | null) => (pos && state ? state.units.find((u) => u.pos.q === pos.q && u.pos.r === pos.r) : undefined);
  /** A crate still whole on this hex. */
  const crateOn = (pos: HexPos | null) => (pos && state ? crateAt(state, pos) : undefined);
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
      else if (hover && (unitOn(hover) || (crateOn(hover) && (tactic.shape === "single" || tactic.shape === "chain")))) out.push({ hexes: [hover], color: tactic.shape === "ally" ? "#7dff9a" : "#ff6b6b", fill: 0.3, line: 0.9 });
    } else if (pick.kind === "item") {
      const def = THROWABLES[pick.item];
      const tint = def.surface ? SURFACE_INFO[def.surface.kind].color : "#7dff9a";
      out.push({ hexes: within(throwRange(statMod(act.stats?.str ?? 5)), true), color: "#ffd23f", fill: 0.1, line: 0.8 });
      // Your own hex: a potion clicked there is drunk, and a torch lit to hold, not thrown.
      const self = def.drink || (def.light && !act.torch);
      if (self) out.push({ hexes: [act.pos], color: def.light ? "#ffb070" : "#7dff9a", fill: 0.3, line: 0.9 });
      if (hover && !(self && hover.q === act.pos.q && hover.r === act.pos.r)) {
        const area = zoneBlast(state.map, hover, def.radius);
        out.push({ hexes: area, color: tint, fill: 0.22, line: 0.9 });
        // Where it lands gets the most of it.
        if (def.heal) out.push({ hexes: [hover], color: tint, fill: 0.4 });
      }
    } else if (pick.what === "jump") {
      out.push({ hexes: within(jumpRange(statMod(act.stats?.str ?? 5)), true).filter((t) => !unitOn(t)), color: "#8fd3ff", fill: 0.14, line: 0.8 });
      if (hover) out.push({ hexes: [hover], color: "#8fd3ff", fill: 0.35, line: 0.9 });
    } else {
      out.push({ hexes: within(1, false), color: pick.what === "help" ? "#7dff9a" : "#ffd23f", fill: 0.12, line: 0.8 });
    }
    return out;
  }, [state, z, act, pick, hover, dev.showAlert, dev.tool]);
  useEffect(() => layer.current?.setOverlays(overlays), [overlays]);

  // ---------- what a move would cost, at the pointer ----------

  // Further than this turn's movement reaches: how far it would be, so the way can be shown in red.
  const far = useMemo(() => {
    if (!z || !act || !budget || !myTurn || picking || !hover || reach.has(posKey(hover))) return null;
    return zoneReach(z, act, budget.move + 18);
  }, [z, act, budget, myTurn, picking, hover, reach]);
  const moveTip = useMemo(() => {
    if (!state || !enc || !act || !budget || !myTurn || picking || !hover) return null;
    const near = reach.get(posKey(hover));
    const got = near ?? far?.get(posKey(hover));
    if (!got) return { none: true as const };
    if (got.cost === 0) return null;
    const from = near ? reach : far!;
    const path = pathIn(from, hover) ?? [];
    // Enemies whose reach the way out of here leaves, and who still have a blow to answer it with.
    const drawn = new Set<string>();
    let at = act.pos;
    if (!budget.disengaged) {
      for (const step of path) {
        for (const u of state.units) {
          if (u.side !== act.side && !u.down && enc.order.includes(u.id) && !enc.reacted.includes(u.id) && hexDistance(u.pos, at) === 1 && hexDistance(u.pos, step) > 1) drawn.add(u.id);
        }
        at = step;
      }
    }
    const ground = [...new Set(path.map((p) => state.surfaces[posKey(p)]?.kind).filter((k): k is "poison" | "fire" | "ice" => k === "poison" || k === "fire" || k === "ice"))];
    return {
      none: false as const,
      cost: got.cost,
      left: budget.move,
      // Out of reach, or somebody is standing there.
      beyond: !near,
      taken: !got.stop,
      drawn: drawn.size,
      ground,
      steps: near ? [] : path.map((pos) => ({ pos, ok: (from.get(posKey(pos))?.cost ?? Infinity) <= budget.move })),
    };
  }, [state, enc, act, budget, myTurn, picking, hover, reach, far]);
  useEffect(() => layer.current?.setPath(moveTip && !moveTip.none ? moveTip.steps : []), [moveTip]);

  // A marker over whoever's turn it is: gold for yours, pale for a crewmate's, red for the enemy's.
  useEffect(() => {
    const marks: { id: string; color: string }[] = [];
    if (enc && state) {
      if (spot) marks.push({ id: spot, color: state.units.find((u) => u.id === spot)?.side === "enemy" ? "#ff4d4d" : "#fff1c9" });
      else for (const id of enc.acting) if (!enc.done.includes(id)) marks.push({ id, color: mine.some((u) => u.id === id) ? "#ffd23f" : "#fff1c9" });
    }
    layer.current?.setTurnMarkers(marks);
  }, [enc, state, spot, mine]);

  // The line of a shot, a spell or a throw to where the pointer is: pale when it can be made, red when it cannot.
  useEffect(() => {
    const aimed = (() => {
      if (!z || !act || !pick || !hover || (hover.q === act.pos.q && hover.r === act.pos.r)) return null;
      mapNow.current = z.map;
      const there = unitOn(hover);
      const box = there ? undefined : crateOn(hover);
      const from = point(act.pos, 1.0);
      const to = point(hover, there ? 0.8 : box ? 0.45 : 0.05);
      const distance = from.distanceTo(to);
      if (pick.kind === "item") return { from, to, height: SpellFx.arcHeight("flask", distance), color: checkThrow(z, act, pick.item, hover) ? "#ff6b6b" : "#fff1c9" };
      if (pick.kind !== "ability") return null;
      const tactic = tacticOf(pick.id);
      if (tactic.reach === "melee" || tactic.shape === "line" || tactic.shape === "self" || tactic.shape === "burst" || tactic.shape === "adjacent") return null;
      const wrong = checkAbility(z, act, pick.id, tactic.shape === "blast" ? { at: hover } : { target: there?.id ?? box?.id });
      // Aimed at open ground with something that needs a target: no line at all.
      if (tactic.shape !== "blast" && !there && !box) return null;
      return { from, to, height: SpellFx.arcHeight(aimKind(pick.id) === "arrow" ? "arrow" : "bolt", distance) + (tactic.shape === "blast" ? 0.6 : 0), color: wrong ? "#ff6b6b" : "#fff1c9" };
    })();
    layer.current?.setArc(aimed);
  }, [z, act, pick, hover]);

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
    if (!pick) {
      // A click on a torch burning on the ground right beside you takes it up; from further off, it is walked to.
      if (state.lights?.[posKey(pos)] && hexDistance(pos, act.pos) <= 1) return zone.send({ type: "pickup", unit: act.id, at: pos });
      // A click on a locked door works it from beside it (a key if there is one, else a shoulder), or walks up to it first.
      const door = state.map.pois.find((p) => p.kind === "gate" && !p.cleared && p.pos.q === pos.q && p.pos.r === pos.r);
      if (door) {
        if (hexDistance(door.pos, act.pos) <= 1) return zone.send({ type: "unlock", unit: act.id, poi: door.id });
        const beside = [...reach.values()].filter((r) => r.stop && hexDistance(r.pos, door.pos) === 1).sort((a, b) => a.cost - b.cost)[0];
        if (beside) zone.send({ type: "move", unit: act.id, to: beside.pos });
        return;
      }
      // A click on a chest opens it from beside it, or walks up to it first.
      const chest = state.map.pois.find((p) => p.kind === "cache" && !p.cleared && p.pos.q === pos.q && p.pos.r === pos.r);
      if (chest) {
        if (hexDistance(chest.pos, act.pos) <= 1) return zone.send({ type: "open", unit: act.id, poi: chest.id });
        const beside = [...reach.values()].filter((r) => r.stop && hexDistance(r.pos, chest.pos) === 1).sort((a, b) => a.cost - b.cost)[0];
        if (beside) zone.send({ type: "move", unit: act.id, to: beside.pos });
        return;
      }
      // A click on a crate breaks at it with your own blow, if anything of yours reaches it; else it walks you up to it.
      const box = crateOn(pos);
      if (box) {
        const blow = crateBlow(asState(state), act, box.id);
        if (blow) return use(blow, { target: box.id });
        const beside = [...reach.values()].filter((r) => r.stop && hexDistance(r.pos, box.pos) === 1).sort((a, b) => a.cost - b.cost)[0];
        if (beside && beside.cost > 0) zone.send({ type: "move", unit: act.id, to: beside.pos });
        return;
      }
      // A click on an enemy means "go up to it": the nearest hex beside it that can be reached.
      if (there && there.side === "enemy" && !there.down) {
        const beside = [...reach.values()].filter((r) => r.stop && hexDistance(r.pos, there.pos) === 1).sort((a, b) => a.cost - b.cost)[0];
        if (beside && beside.cost > 0) zone.send({ type: "move", unit: act.id, to: beside.pos });
        return;
      }
      // A click on glowing mushrooms picks them from beside them (or among them), or walks up to them first.
      const patch = state.map.pois.find((p) => p.kind === "glowcap" && !p.cleared && p.pos.q === pos.q && p.pos.r === pos.r);
      if (patch) {
        if (hexDistance(patch.pos, act.pos) <= 1) return zone.send({ type: "forage", unit: act.id, poi: patch.id });
        const beside = [...reach.values()].filter((r) => r.stop && hexDistance(r.pos, patch.pos) <= 1).sort((a, b) => a.cost - b.cost)[0];
        if (beside) zone.send({ type: "move", unit: act.id, to: beside.pos });
        return;
      }
      return zone.send({ type: "move", unit: act.id, to: pos });
    }
    if (pick.kind === "ability") {
      const shape = tacticOf(pick.id).shape;
      if (shape === "blast" || shape === "line") return use(pick.id, { at: pos });
      // An ally ability clicked on open ground is meant for yourself.
      if (shape === "ally") return use(pick.id, { target: there?.side === "hero" ? there.id : act.id });
      const box = crateOn(pos);
      if (there) use(pick.id, { target: there.id });
      else if (box && (shape === "single" || shape === "chain")) use(pick.id, { target: box.id });
    } else if (pick.kind === "item") {
      // Clicked on yourself, something drinkable is drunk and a torch is lit to hold; anywhere else it is thrown there.
      const onSelf = pos.q === act.pos.q && pos.r === act.pos.r;
      const def = THROWABLES[pick.item];
      if (def.drink && onSelf) zone.send({ type: "drink", unit: act.id, item: pick.item });
      else if (def.light && onSelf && !act.torch) zone.send({ type: "light", unit: act.id });
      else zone.send({ type: "throw", unit: act.id, item: pick.item, at: pos });
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

  /** Back up to the Harbor: out of a cave, standing at its mouth. From a place on the atlas, back to the atlas. */
  const leave = () => {
    if (state?.options.tier) {
      location.hash = "atlas";
      return;
    }
    if (state?.options.biome === "caves") {
      try {
        sessionStorage.setItem("gq.harborAt", `${HARBOR_CAVE.q},${HARBOR_CAVE.r}`);
      } catch {
        // Storage is off: the usual spot it is.
      }
    }
    onLeave();
  };
  /**
   * Going somewhere from the middle of a fight (off the map, or to a crewmate): the hero flees it first, and
   * goes once the server has them out of it, or stays if it says no. Nobody leaves a hero behind in a fight.
   * It is meant for that moment only: if they are not out of it soon after (an enemy came close enough to draw
   * them straight back in), it is dropped, and does not go off whenever the fight happens to end.
   */
  const [leaving, setLeaving] = useState<{ go: () => void } | null>(null);
  useEffect(() => {
    if (!leaving) return;
    if (!fighting) {
      setLeaving(null);
      leaving.go();
    } else if (zone.error) setLeaving(null);
  }, [leaving, fighting, zone.error]);
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => setLeaving(null), LEAVING_WAIT_MS);
    return () => clearTimeout(t);
  }, [leaving]);

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
  // Getting away: on your turn, with the Action (a Rogue's Bonus action) for it, and no enemy in the fight within FLEE_RANGE.
  const fleeCost = commonCost("flee", act.kind);
  const fleeBlock = !fighting ? "That is for a fight." : !myTurn ? "Wait for your turn." : !budget?.[fleeCost] ? `You have used your ${costName(fleeCost)} this turn.` : checkCommon(asState(state), act, "flee", {}, budget ?? null);
  /** From the middle of a fight: flee it, then `go` once out of it. */
  const fleeThen = (go: () => void) => {
    zone.clearError();
    setLeaving({ go });
    common("flee");
  };
  const fleeAndLeave = () => fleeThen(leave);
  /** Everything that could be on the bar, by key, as it stands right now. */
  const entries: Record<string, HudSlot> = {};
  for (const id of act.abilities) {
    const def = ABILITIES[id];
    const tactic = tacticOf(id);
    const wait = act.cooldowns[id] ?? 0;
    const reachText = tactic.shape === "self" ? "yourself" : tactic.shape === "burst" ? `everyone within ${tactic.radius}` : tactic.reach === "melee" ? (tactic.shape === "adjacent" ? "every enemy beside you" : "an enemy beside you") : `${tactic.shape === "line" ? `a line of ${tactic.length}` : `range ${tactic.range}`}${tactic.shape === "blast" ? `, blast ${tactic.radius}` : ""}`;
    const dice = def.damage ? `${diceText(abilityDice(def))} damage` : def.heal ? `heals ${diceText(healDice(def))}` : "";
    entries[`ab:${id}`] = {
      id: `ab:${id}`,
      icon: { ...abilityIcon(id), flat: true },
      name: def.name,
      line: [costName(tactic.cost), reachText, dice].filter(Boolean).join(" · "),
      more: `${def.blurb}${tactic.cooldown ? ` Then ${tactic.cooldown} turn${tactic.cooldown === 1 ? "" : "s"} before it can be used again.` : ""}`,
      wait: wait || undefined,
      picked: pick?.kind === "ability" && pick.id === id,
      spent: !canPay(tactic.cost) || (fighting && wait > 0),
      run: () => choose(id),
    };
  }
  for (const what of Object.keys(COMMON_ICON) as CommonAction[]) {
    const cost = commonCost(what, act.kind);
    const needsFight = what === "dash" || what === "disengage" || what === "flee";
    entries[`do:${what}`] = {
      id: `do:${what}`,
      icon: { ...COMMON_ICON[what], flat: true },
      name: COMMON_ACTIONS[what].name,
      line: costName(cost),
      more: what === "flee" && myTurn && fleeBlock ? `${COMMON_ACTIONS[what].blurb} ${fleeBlock}` : COMMON_ACTIONS[what].blurb,
      picked: pick?.kind === "common" && pick.what === what,
      spent: !canPay(cost) || (needsFight && !fighting) || (what === "flee" && !!fleeBlock),
      run: () => (needsFight ? common(what) : setPick((p) => (p?.kind === "common" && p.what === what ? null : { kind: "common", what }))),
    };
  }
  for (const item of Object.keys(ITEM_ICON) as Throwable[]) {
    const def = THROWABLES[item];
    const have = act.items[item] ?? 0;
    // A torch lit in the hand can be thrown with none left in the pack.
    const held = !!def.light && (act.torch ?? 0) > 0;
    entries[`it:${item}`] = {
      id: `it:${item}`,
      icon: ITEM_ICON[item],
      name: held ? `${def.name} (lit, ${act.torch} rounds left)` : def.name,
      line: def.drink ? "Throw it (Action), or click yourself to drink it (Bonus action)" : def.light ? (held ? "Throw the lit torch down where it should burn (Action)" : "Throw it lit (Action), or click yourself to light it to hold (Bonus action)") : "Throw it (Action)",
      more: def.blurb,
      count: have,
      picked: pick?.kind === "item" && pick.item === item,
      // Thrown for an Action; a potion can still be drunk, or a torch lit, when only the Bonus action is left.
      spent: (have <= 0 && !held) || !(canPay("action") || ((!!def.drink || (!!def.light && !held)) && canPay("bonus"))),
      run: () => setPick((p) => (p?.kind === "item" && p.item === item ? null : { kind: "item", item })),
    };
  }
  const slots = Array.from({ length: BAR_SLOTS }, (_, i) => entries[bar[i] ?? ""] ?? null);

  // Whoever is being shown acting, while the enemy's turn plays out; otherwise whoever the server waits on.
  const waitingFor = enc && !myTurn ? (watching && spot ? (names.current.get(spot) ?? "someone") : enc.acting.map((id) => names.current.get(id) ?? "someone").join(" and ")) : undefined;
  // A torch burning on the ground within reach, to pick up.
  const torchBeside = act && state.lights ? Object.keys(state.lights).map((k) => { const [q, r] = k.split(",").map(Number); return { q, r }; }).find((p) => hexDistance(p, act.pos) <= 1) : undefined;
  // A locked door within reach, and the keys on the party's ring.
  const doorBeside = act ? state.map.pois.find((p) => p.kind === "gate" && !p.cleared && hexDistance(p.pos, act.pos) <= 1) : undefined;
  const keys = state.keys ?? 0;
  const keysText = keys === 1 ? "1 key" : `${keys} keys`;
  // A cave's chests, and its way out.
  const caves = state.options.biome === "caves";
  const chestBeside = act ? state.map.pois.find((p) => p.kind === "cache" && !p.cleared && hexDistance(p.pos, act.pos) <= 1) : undefined;
  const chestName = (p: { loot?: string }, cap = false) => {
    const n = p.loot === "hoard" ? "the hoard" : p.loot === "vault" ? "the strongbox" : "the chest";
    return cap ? n.charAt(0).toUpperCase() + n.slice(1) : n;
  };
  const chestGuarded = (p: { guard?: string }) => !!p.guard && state.units.some((u) => u.group === p.guard && !u.down);
  // A crate beside you, and what of yours would break at it.
  const crateBeside = act ? state.map.pois.find((p) => p.kind === "crate" && !p.cleared && hexDistance(p.pos, act.pos) <= 1) : undefined;
  const crateHit = crateBeside ? crateBlow(asState(state), act, crateBeside.id) : null;
  // Glowing mushrooms within reach, to pick.
  const glowBeside = act ? state.map.pois.find((p) => p.kind === "glowcap" && !p.cleared && hexDistance(p.pos, act.pos) <= 1) : undefined;
  // The way out: the cave's mouth, or (should a cave ever come without one) where heroes arrive.
  const mouthAt = state.map.pois.find((p) => p.kind === "landing")?.pos ?? state.start;
  const atMouth = caves && !!act && hexDistance(mouthAt, act.pos) <= 1;
  const place: ReactNode = pick
    ? <>{pick.kind === "ability" ? ABILITIES[pick.id].name : pick.kind === "item" ? THROWABLES[pick.item].name : COMMON_ACTIONS[pick.what].name} <span className="muted">· {pick.kind === "item" && THROWABLES[pick.item].drink ? "click where to throw it, or yourself to drink it" : pick.kind === "item" && THROWABLES[pick.item].light && !act?.torch ? "click where to throw it, or yourself to light it to hold" : "click a target on the map"}, or Esc to put it back</span></>
    : dev.tool
      ? <>Dev tool <span className="muted">· {dev.tool.tool === "spawn" ? "click a hex to place the group" : "click hexes to paint"}</span></>
      : (!enc || !fighting) && doorBeside
        ? <>A locked door <span className="muted">· {keys > 0 ? `${keysText} on the ring: one opens it` : "no key: it can be forced, but not quietly"}</span></>
      : (!enc || !fighting) && chestBeside
        ? <>{chestName(chestBeside, true)} <span className="muted">· {chestGuarded(chestBeside) ? "its guards still stand over it" : "right beside you"}</span></>
        : (!enc || !fighting) && atMouth
          ? <>The way out <span className="muted">· the cave mouth, back up to the Harbor</span></>
          : enc && !fighting && enc.fled?.includes(act.id)
            ? <>Got away <span className="muted">· the fight goes on; an enemy in it coming within {FLEE_RANGE} hexes brings you back</span></>
          : !enc || !fighting
        ? <>Exploring <span className="muted">· click a hex to walk{enc ? ". A fight is on nearby: walk in to join it" : ""}</span></>
        : myTurn
          ? <>{mine.length > 1 ? `${act.name}'s turn` : "Your turn"} <span className="muted">· round {enc.round}</span></>
          : <>Round {enc.round} <span className="muted">· waiting for {waitingFor}</span></>;

  // ---------- what is under the pointer ----------

  const under = unitOn(hover);
  const ground = hover ? tileAt(state.map, hover) : undefined;
  const hoverTorch = hover ? state.lights?.[posKey(hover)] : undefined;
  const hoverDoor = hover ? state.map.pois.find((p) => p.kind === "gate" && p.pos.q === hover.q && p.pos.r === hover.r) : undefined;
  const hoverChest = hover ? state.map.pois.find((p) => p.kind === "cache" && p.pos.q === hover.q && p.pos.r === hover.r) : undefined;
  // A crate as the picture shows it, so its health drops as each blow is seen to land.
  const hoverCrate = hover ? (picture?.pois ?? state.map.pois).find((p) => p.kind === "crate" && p.pos.q === hover.q && p.pos.r === hover.r) : undefined;
  const hoverMouth = !!hover && caves && state.map.pois.some((p) => p.kind === "landing" && p.pos.q === hover.q && p.pos.r === hover.r);
  const hoverGlow = hover ? state.map.pois.find((p) => p.kind === "glowcap" && p.pos.q === hover.q && p.pos.r === hover.r) : undefined;
  const preview = under && z && pick?.kind === "ability" && under.side !== act.side ? previewAttack(z, act, pick.id, under) : null;
  const surface = hover ? state.surfaces[posKey(hover)] : undefined;

  return (
    <div
      className={`run zone-view ${picking ? "picking" : ""} ${fighting ? "in-fight" : ""} ${myTurn ? "my-turn" : ""}`}
      onContextMenu={(e) => { if (pick) { e.preventDefault(); setPick(null); } }}
      onPointerMove={(e) => { if (cursor.current) cursor.current.style.transform = `translate(${e.clientX + 18}px, ${e.clientY + 14}px)`; }}
    >
      <div className="stage" ref={mount} />
      {/* The edge of the screen while a fight is on: red while you wait, gold when it is yours. */}
      <div className="zone-frame" aria-hidden />

      {intro && (
        <div className="zone-intro" role="status">
          <div className="zone-intro-band">
            <strong>Combat</strong>
            <span>Roll for initiative</span>
          </div>
        </div>
      )}

      <div ref={cursor} className={`zone-cursor ${moveTip ? "" : "off"} ${moveTip && (moveTip.none || moveTip.beyond || moveTip.taken) ? "bad" : ""}`} aria-hidden>
        {moveTip && (moveTip.none ? (
          <strong>No way there</strong>
        ) : (
          <>
            <span className="zone-cursor-cost"><strong>{moveTip.cost}</strong> / {moveTip.left}</span>
            <span className="zone-cursor-note">{moveTip.beyond ? `${moveTip.cost - moveTip.left} too far` : moveTip.taken ? "someone is standing there" : `${moveTip.left - moveTip.cost} left after`}</span>
            {moveTip.drawn > 0 && <span className="zone-cursor-warn">Draws {moveTip.drawn === 1 ? "an attack" : `${moveTip.drawn} attacks`} as you leave</span>}
            {moveTip.ground.map((k) => <span key={k} className="zone-cursor-warn" style={{ color: SURFACE_INFO[k].color }}>Through {SURFACE_INFO[k].name.toLowerCase()}</span>)}
          </>
        ))}
      </div>

      {enc && (
        <div className="zone-order" aria-label="Turn order">
          <span className="zone-round">Round<strong>{enc.round}</strong></span>
          {enc.order.map((id, i) => {
            const u = (picture?.units ?? state.units).find((x) => x.id === id);
            if (!u) return null;
            const turn = spot ? id === spot : enc.acting.includes(id) && !enc.done.includes(id);
            const spent = !spot && enc.acting.includes(id) && enc.done.includes(id);
            // Heroes side by side in the order take their turns together: drawn joined up.
            const before = state.units.find((x) => x.id === enc.order[i - 1]);
            const joined = u.side === "hero" && before?.side === "hero";
            return (
              <button
                key={id}
                type="button"
                className={`zone-face ${u.side} ${turn ? "turn" : ""} ${spent ? "spent" : ""} ${u.down ? "down" : ""} ${joined ? "joined" : ""} ${mine.some((m) => m.id === id) ? "mine" : ""}`}
                title={`${u.name} · ${u.hp}/${u.maxHp} HP · initiative ${enc.init[id]}`}
                onClick={() => renderer.current?.lookAt(u.pos)}
              >
                <img className="pixel-icon" src={spriteDataUrl(u.kind, u.outfit)} alt="" draggable={false} />
                <span className="zone-hp"><i style={{ width: `${(100 * u.hp) / u.maxHp}%` }} /></span>
                <span className="zone-face-name">{u.name.split(" ")[0]}</span>
              </button>
            );
          })}
        </div>
      )}

      {mine.length > 1 && (
        <div className="zone-party panel">
          {mine.map((u) => (
            <button key={u.id} className={`small ${u.id === act.id ? "primary" : ""}`} disabled={u.down || (!!enc?.order.includes(u.id) && !ready(u))} onClick={() => setPlayAs(u.id)}>
              {u.name.split(" ")[0]} · {seen(u).hp}/{u.maxHp}
            </button>
          ))}
        </div>
      )}

      <div className="feed zone-feed" aria-live="polite">{feed.slice(-8).map((line, i) => <div key={feed.length - 8 + i}>{line}</div>)}</div>

      {banner && <div className="zone-banner">{banner}</div>}
      {clearedAsk && caves && !fighting && (
        // The last of them is down: point the way out (the mouth), or look round first.
        <div className="zone-ask">
          <div className="panel">
            <h3>The cave is clear</h3>
            <p>{unopened(state) > 0 ? `${unopened(state) === 1 ? "A chest is" : `${unopened(state)} chests are`} still unopened down here.` : "Everything down here has been found."} The way out is back at the cave mouth.</p>
            <p className="zone-ask-buttons">
              <button className="primary" onClick={() => { renderer.current?.lookAt(mouthAt); setClearedAsk(false); }}>Show the way out</button>
              <button onClick={() => setClearedAsk(false)}>Keep exploring</button>
            </p>
          </div>
        </div>
      )}

      {chartAsk && !fighting && (
        // Cleared: back to the atlas, where the routes beyond it are now open. A sea cave is left by its mouth.
        <div className="zone-ask">
          <div className="panel">
            <h3>{state.options.name ?? "This place"} is cleared</h3>
            <p>Its bounty has been shared out, and the routes beyond it are open on the atlas.{caves && !atMouth ? " The way out is back at the cave mouth." : ""}</p>
            <p className="zone-ask-buttons">
              {caves && !atMouth
                ? <button className="primary" onClick={() => { renderer.current?.lookAt(mouthAt); setChartAsk(false); }}>Show the way out</button>
                : <button className="primary" onClick={leave}>Back to the atlas</button>}
              <button onClick={() => setChartAsk(false)}>Stay a while</button>
            </p>
          </div>
        </div>
      )}

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
          ) : hoverTorch ? (
            <>
              <strong>A burning torch</strong>{" "}
              <span className="muted">· {hoverTorch.rounds} round{hoverTorch.rounds === 1 ? "" : "s"} of light left{act && hexDistance(hover!, act.pos) <= 1 ? " · click to pick it up" : ""}</span>
            </>
          ) : hoverDoor ? (
            <>
              <strong>A locked door</strong>{" "}
              <span className="muted">· {hoverDoor.cleared ? "standing open" : keys > 0 ? `${keysText} on the ring` : "no key: force it (loud)"}{!hoverDoor.cleared && act && hexDistance(hoverDoor.pos, act.pos) <= 1 ? " · click to open it" : ""}</span>
            </>
          ) : hoverCrate ? (
            <>
              <strong>{hoverCrate.cleared ? "A broken crate" : "Crate"}</strong>{" "}
              <span className="muted">
                {hoverCrate.cleared
                  ? "· splinters, nothing left in it"
                  : `· ${crateHp(hoverCrate)}/${hoverCrate.maxHp ?? CRATE_HP} HP · ${pick?.kind === "ability" ? "every blow at it lands" : crateBlow(asState(state), act, hoverCrate.id) ? "click to break it open" : "click to walk up to it"}`}
              </span>
              {!hoverCrate.cleared && <div className="muted">Old boards: wood inside, and maybe a few coins, a potion or a torch.</div>}
            </>
          ) : hoverGlow ? (
            <>
              <strong>{hoverGlow.cleared ? "Picked mushrooms" : "Glowing mushrooms"}</strong>{" "}
              <span className="muted">· {hoverGlow.cleared ? "only the stalks are left" : `pick them for mushrooms · ${hexDistance(hoverGlow.pos, act.pos) <= 1 ? "click to pick them" : "click to walk up to them"}`}</span>
              {!hoverGlow.cleared && <div className="muted">They light the rock round them until they are picked.</div>}
            </>
          ) : hoverChest ? (
            <>
              <strong>{chestName(hoverChest, true)}</strong>{" "}
              <span className="muted">· {hoverChest.cleared ? "emptied" : chestGuarded(hoverChest) ? "guarded: its band still stands" : hexDistance(hoverChest.pos, act.pos) <= 1 ? "click to open it" : "click to walk up to it"}</span>
            </>
          ) : hoverMouth ? (
            <>
              <strong>The cave mouth</strong> <span className="muted">· the way out, back up to the Harbor</span>
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
      {note && !zone.error && <div className="toast note">{note}</div>}

      {crew.length > 1 && (
        <div className="zone-crew roster-panel crew-cards">
          <CrewRoster
            you={state.you}
            heading={<>{crew.filter((m) => m.zone?.code === code).length} of {crew.length} on this map</>}
            members={crew.map((m): RosterMember => ({ id: m.id, name: m.name, classId: m.classId, level: m.level, here: m.zone?.code === code, outfit: state.units.find((u) => u.id === m.id)?.outfit, tags: m.zone?.fighting ? ["in a fight"] : m.zone && m.zone.code !== code ? ["on another map"] : !m.zone ? ["not on a map"] : undefined }))}
            menu={(m) => {
              if (m.id === state.you) return [];
              const where = crew.find((x) => x.id === m.id)?.zone;
              return [
                { label: "Trade", run: () => setTradeWith(m.id) },
                {
                  label: where ? "Teleport to them" : "Go to the Harbor",
                  blocked: where?.fighting && where.code !== code ? "In a fight" : where?.code === code ? "Already on this map" : !where && caves && !atMouth ? "Walk back to the cave mouth to leave" : fighting && fleeBlock ? `You are in a fight. ${fleeBlock}` : undefined,
                  // From the middle of a fight of your own, you flee it first.
                  run: () => (fighting ? fleeThen(() => teleportTo(m.id)) : teleportTo(m.id)),
                },
              ];
            }}
          />
        </div>
      )}
      {me.character && <Trading me={me} partners={crew.filter((m) => m.id !== state.you)} withId={tradeWith} onWith={setTradeWith} refresh={refresh} nudge={zone.trades} />}
      {bag && !tradeWith && me.character && (
        <InventoryScreen
          me={me}
          onIsland
          // Gear changed here is gear changed on the map: the server reads the hero again (and leaves them be in a fight).
          refresh={() => refresh().then(() => zone.resheet())}
          onClose={() => setBag(false)}
          gearLocked={enc?.order.includes(state.you) ? "A fight is on: what you are wearing stays as it is until it is over." : undefined}
          usable={{
            use: (item) => {
              setBag(false);
              setPick({ kind: "item", item });
            },
            // The bag is your own hero's: a stand-in you are playing carries its own.
            blocked: (item) =>
              act.id !== state.you ? "This is your own pack. Play your own hero to use what is in it."
              : (act.items[item] ?? 0) <= 0 ? "You have none left."
              : !entries[`it:${item}`]?.spent ? undefined
              : fighting && !myTurn ? "It is not your turn."
              : "You have neither an Action nor a Bonus action left for it this turn.",
          }}
        />
      )}

      {barMenu !== null && (
        <div className="zone-barmenu panel" role="dialog" aria-label="Choose what goes in this slot">
          <div className="zone-barmenu-head">
            <strong>Slot {barMenu < 9 ? barMenu + 1 : `Shift ${barMenu - 8}`}</strong>
            <span className="muted">Pick what goes here. Drag slots on the bar to swap them.</span>
            <button className="link" onClick={() => setBarMenu(null)}>Close</button>
          </div>
          <div className="zone-barmenu-list">
            {barChoices(act.abilities).map((key) => {
              const entry = entries[key];
              if (!entry) return null;
              return (
                <button key={key} className={`zone-barmenu-item ${bar[barMenu] === key ? "selected" : ""}`} title={entry.more} onClick={() => { arrange(assignSlot(bar, barMenu, key)); setBarMenu(null); }}>
                  <Icon name={entry.icon.name} color={entry.icon.color} size={27} flat={entry.icon.flat} />
                  <span>{entry.name}{entry.count !== undefined ? ` × ${entry.count}` : ""}</span>
                </button>
              );
            })}
            <button className="zone-barmenu-item" onClick={() => { arrange(assignSlot(bar, barMenu, "")); setBarMenu(null); }}><span>Leave it empty</span></button>
          </div>
        </div>
      )}

      <HudBar
        me={me}
        place={place}
        hp={{ now: seen(act).hp, max: act.maxHp }}
        meter={{ name: "Focus", note: "spend one to roll an attack with advantage", now: act.focus, max: act.maxFocus, kind: "focus" }}
        pips={fighting && budget ? [
          { label: "Action", now: budget.action ? 1 : 0, max: 1, kind: "action" },
          { label: "Bonus action", now: budget.bonus ? 1 : 0, max: 1, kind: "bonus" },
          { label: "Movement", now: budget.move, max: budget.moveMax, kind: "move" },
        ] : []}
        // The keys the party has found, on its one ring.
        chips={keys > 0 ? <span className="hud-chip" title="Keys to locked doors: any key opens any door">{keysText}</span> : undefined}
        slots={slots}
        onSlotMove={(from, to) => arrange(moveSlot(bar, from, to))}
        onSlotMenu={(index) => setBarMenu((open) => (open === index ? null : index))}
        // Either hand takes a lit torch: put one there to light it. In the main hand it is swung as a weapon.
        torch={{
          rounds: act.torch ?? null,
          hand: act.torchHand === "main" ? "main" : "off",
          carried: act.items.torch ?? 0,
          light: !act.torch && (act.items.torch ?? 0) > 0 && !act.down && (!fighting || (myTurn && !!budget?.bonus)) ? (hand) => zone.send({ type: "light", unit: act.id, ...(hand === "main" ? { hand } : {}) }) : undefined,
          why: fighting && !myTurn ? "Wait for your turn." : fighting && !budget?.bonus ? "You have used your Bonus action this turn." : undefined,
        }}
        // While the trade table is open it has the bag beside it already.
        onBag={() => !tradeWith && setBag((open) => !open)}
        turn={enc && fighting ? { seconds: deadline, onEnd: myTurn ? () => zone.send({ type: "end_turn", unit: act.id }) : undefined, waitingFor } : undefined}
        menu={<OptionsMenu title={state.options.name ?? `Map ${code}`} subtitle={<>{state.options.biome} · {state.options.size}{state.options.tier ? ` · ${state.options.tier} ${state.options.tier === 1 ? "ring" : "rings"} out` : ""}</>} actions={[caves
          ? {
              label: "Leave the cave",
              hint: !atMouth ? "The way out is the cave mouth: walk back to it to leave." : !fighting ? "Back up to the Harbor. The cave stays as you left it." : fleeBlock ? `In a fight: you can leave once you could flee it. ${fleeBlock}` : "Flee the fight and climb back up to the Harbor.",
              disabled: !atMouth || (fighting && !!fleeBlock),
              run: fighting ? fleeAndLeave : leave,
            }
          : {
              label: "Leave the map",
              hint: !fighting ? "Back to the Harbor. The map stays as you left it." : fleeBlock ? `In a fight: you can leave once you could flee it. ${fleeBlock}` : "Flee the fight and go back to the Harbor.",
              disabled: fighting && !!fleeBlock,
              run: fighting ? fleeAndLeave : leave,
            }]} />}
      >
        {torchBeside && (!fighting || myTurn) && (
          <button className="small" disabled={fighting && !budget?.bonus} title={fighting ? "A Bonus action" : undefined} onClick={() => zone.send({ type: "pickup", unit: act.id, at: torchBeside })}>
            {act.torch ? "Stow the torch" : "Pick up the torch"}
          </button>
        )}
        {doorBeside && (!fighting || myTurn) && (
          <button className="small primary" disabled={fighting && !budget?.action} title={keys > 0 ? "Uses a key off the ring" : `A Strength roll (${FORCE_DC} or better). Loud: the nearest band within earshot will come.`} onClick={() => zone.send({ type: "unlock", unit: act.id, poi: doorBeside.id })}>
            {keys > 0 ? "Unlock the door" : "Force the door"}
          </button>
        )}
        {chestBeside && (!fighting || myTurn) && (
          <button className="small primary" disabled={chestGuarded(chestBeside) || (fighting && !budget?.action)} title={chestGuarded(chestBeside) ? "Its guards still stand over it" : fighting ? "An Action" : undefined} onClick={() => zone.send({ type: "open", unit: act.id, poi: chestBeside.id })}>
            Open {chestName(chestBeside)}
          </button>
        )}
        {glowBeside && (!fighting || myTurn) && (
          <button className="small" disabled={fighting && !budget?.action} title={fighting ? "An Action" : "Mushrooms for the apothecary. Picked, they stop glowing."} onClick={() => zone.send({ type: "forage", unit: act.id, poi: glowBeside.id })}>
            Pick the mushrooms
          </button>
        )}
        {/* Out of a cave the way you came in: only at its mouth. Any other map can be left from anywhere. */}
        {(!caves || atMouth) && (
          // In the middle of a fight it is the way out for one who could flee it: they flee, then go.
          <button
            className="small"
            disabled={fighting && !!fleeBlock}
            title={!fighting ? "Back up to the Harbor. The map stays as you left it." : fleeBlock ? `Not in the middle of a fight, unless you could flee it. ${fleeBlock}` : `Flee the fight (${costName(fleeCost)}) and go back up to the Harbor.`}
            onClick={fighting ? fleeAndLeave : leave}
          >
            {caves ? "Leave the cave" : "Leave the map"}
          </button>
        )}
        {fighting && myTurn && (
          <button
            className="small"
            disabled={!!fleeBlock}
            title={fleeBlock ?? `${costName(fleeCost)}: out of the fight and free to walk. It goes on without you, and an enemy in it coming within ${FLEE_RANGE} hexes brings you back.`}
            onClick={() => common("flee")}
          >
            Flee
          </button>
        )}
        <button className={`small ${focus ? "primary" : ""}`} disabled={act.focus <= 0} aria-pressed={focus} title="Spend 1 Focus on your next attack to roll it with advantage" onClick={() => setFocus((f) => !f)}>Focus {act.focus}</button>
        {crateBeside && (!fighting || myTurn) && (
          <button className="small" disabled={!crateHit || (fighting && !budget?.action)} title={crateHit ? `${ABILITIES[crateHit].name}${fighting ? ", for an Action" : ""}: every blow at a crate lands` : "Nothing you have reaches it"} onClick={() => crateHit && use(crateHit, { target: crateBeside.id })}>
            Break the crate
          </button>
        )}
      </HudBar>
    </div>
  );
}
