// Inside a hut: a small room drawn by the same renderer as the Harbor, where
// everyone present sees each other and the furniture.
//
// Clicking a piece uses it: the owner rests in their bed and opens their
// chests, and anyone can warm up at a fire, read a shelf or look at the rest
// (useOf in hutroom.ts). The hero walks over first, and while they stand
// beside something usable its action floats over their head (TileAction).
//
// Decorating is a mode of its own, the owner's alone ("Decorate" in the bar):
// the Storage and Craft panels, picking pieces up, setting them down, turning
// them, putting them away. There, clicking a placed piece floats its controls
// above it (HutToolbar). Leaving the mode lets go of anything carried.

import { useEffect, useMemo, useRef, useState } from "react";
import type { HexPos } from "@gantt-quest/core";
import { FURNISHINGS, besideHexes, coveredHexes, hutPath, isBeside, useOf, useProblem, type FurnishingUse, craftProblem, footprintOf, hutPerks, hutRoom, hutTier, isMounted, isSmall, nextHutTier, placeProblem, placedFurnishings, poiAt, smallPlaceProblem, turnOf, upgradeProblem, wallPlaceProblem, wrapAngle, type Furnishing } from "@gantt-quest/world";
import { api, type Hut, type Me } from "./api";
import { CrewRoster } from "./CrewRoster";
import { DragPanel } from "./DragPanel";
import { CostChips, PerkMeter, ResourceChips } from "./hutDrops";
import { TileAction } from "./TileAction";
import { HutToolbar, ICON, PixelIcon, type ToolAction } from "./HutToolbar";
import { WorldRenderer, type PlaceTarget, type RenderState } from "./render/WorldRenderer";
import { HutContainer } from "./HutContainer";
import { HeroSheet, useHeroSheet } from "./HeroSheet";
import { useHut } from "./useHut";
import "./hut.css";
import { blurb, label } from "./labels";
import { ThingIcon, furnishingIcon } from "./thingIcons";
import { xpEvents } from "./xpEvents";
import { StaminaBolts } from "./StaminaBolts";

const same = (a: HexPos, b: HexPos) => a.q === b.q && a.r === b.r;
const defOf = (f: Furnishing) => FURNISHINGS[f.defId];
/** A snapped turn: furniture to the hex's six facings, a small thing in twenty-fourths (15°). */
const snapStep = (defId: string) => (isSmall(defId) ? Math.PI / 12 : Math.PI / 3);
/** A free turn's step from a key or a toolbar button: 5°. */
const FINE = Math.PI / 36;
/** The next snapped turn from `angle` in direction `dir`: an angle between notches goes to the nearest one that way. */
function snapTurn(angle: number, dir: 1 | -1, step: number): number {
  const at = angle / step;
  const near = Math.round(at);
  const from = Math.abs(at - near) < 1e-3 ? near : dir > 0 ? Math.floor(at) : Math.ceil(at);
  return wrapAngle((from + dir) * step);
}
/** Turning snaps to notches unless switched off; the choice is remembered on this device. */
const SNAP_KEY = "hut.snap";
const readSnap = () => {
  try {
    return localStorage.getItem(SNAP_KEY) !== "off";
  } catch {
    return true;
  }
};
/** Where a floor piece stands, for the rules. */
const spotOf = (f: Furnishing) => ({ x: f.x, z: f.z, angle: turnOf(f) });

/** What a piece can do, as short tags under its name. */
function tags(defId: string): string[] {
  const def = FURNISHINGS[defId];
  if (!def) return [];
  const out: string[] = [];
  if (def.size === "small") out.push("small");
  if (def.mount) out.push("wall");
  if (def.light) out.push(def.light === "fire" ? "fire" : "light");
  if (def.surface) out.push("top");
  if (def.storage) out.push(`holds ${def.storage}`);
  if (def.kind === "trophy") out.push("trophy");
  return out;
}

/** Everything that can be crafted, starter recipes first. */
const RECIPES = Object.values(FURNISHINGS).filter((f) => f.recipe).sort((a, b) => Number(!!a.needsBlueprint) - Number(!!b.needsBlueprint));

/** What a use is called, on the button over the hero's head and in the tooltip. */
const USE_VERB: Record<FurnishingUse, string> = { rest: "Rest", open: "Open", warm: "Warm up", read: "Read", look: "Look" };
/** Which use wins when the hero stands beside several things at once. */
const USE_ORDER: FurnishingUse[] = ["rest", "open", "warm", "read"];

/** Which panel a message belongs in. */
type Where = "storage" | "craft" | "hut" | "box";

export function HutView({ ownerId, me, refresh, onLeave }: { ownerId: string; me: Me; refresh(): Promise<unknown>; onLeave(): void }) {
  const mount = useRef<HTMLDivElement>(null);
  const renderer = useRef<WorldRenderer | null>(null);
  const [hover, setHover] = useState<HexPos | null>(null);
  const [text, setText] = useState("");
  /** A furnishing picked up to be put down on the next floor hex clicked. */
  const [holding, setHolding] = useState<number | null>(null);
  /**
   * Whether this player has put the hanging lamp out, for mood light from the
   * room's own candles, lanterns and fires. Each player's own view, remembered per hut.
   */
  const lampKey = `gq.hutLamp.${ownerId}`;
  /** Your gathering stamina, and when you may next rest: bolts on your plate, and the owner's Rest button. Read on the way in and after each rest. */
  const [stamina, setStamina] = useState<Awaited<ReturnType<typeof api.gather>> | null>(null);
  useEffect(() => {
    void api.gather().then(setStamina, () => setStamina(null));
  }, []);
  const [lampOff, setLampOff] = useState(() => {
    try {
      return localStorage.getItem(lampKey) === "off";
    } catch {
      return false;
    }
  });
  const toggleLamp = () =>
    setLampOff((off) => {
      try {
        localStorage.setItem(lampKey, off ? "on" : "off");
      } catch {
        // Storage is off: the choice lasts until the page closes.
      }
      return !off;
    });
  /** How the carried piece is turned, in radians. */
  const [turn, setTurn] = useState(0);
  /** Whether turning snaps to notches (the hex's facings, or 15° for small things). Alt flips it while held. */
  const [snap, setSnap] = useState(readSnap);
  const toggleSnap = () =>
    setSnap((on) => {
      try {
        localStorage.setItem(SNAP_KEY, on ? "off" : "on");
      } catch {
        // Private browsing: it is only forgotten.
      }
      return !on;
    });
  /** A placed piece being turned: shown at once, sent once the turning stops. */
  const [turning, setTurning] = useState<{ id: number; angle: number } | null>(null);
  /** The placed furnishing whose controls are showing. */
  const [selected, setSelected] = useState<number | null>(null);
  /** The prop under the pointer, for its tooltip. */
  const [hoverProp, setHoverProp] = useState<number | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  /** The container whose contents panel is open. */
  const [opened, setOpened] = useState<number | null>(null);
  /** The owner's materials, blueprints and gold. Re-read after anything is spent. */
  const [own, setOwn] = useState<Hut | null>(null);
  const [busy, setBusy] = useState(false);
  /** Why the room (or the rules, before asking it) said no; shown for a few seconds. */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** The last thing done or refused, shown in the panel it happened in. */
  const [note, setNote] = useState<{ where: Where; text: string; ok: boolean } | null>(null);
  const noteIn = (where: Where) => note && note.where === where ? <p className={note.ok ? "good" : "bad"}>{note.text}</p> : null;

  const hut = useHut(
    ownerId,
    (id, path) => renderer.current?.playEvents([{ t: "moved", heroId: id, path }]),
    (m) => renderer.current?.playEvents(xpEvents(m)),
    (id, text) => renderer.current?.say(id, text),
  );
  const { you, players, furnishings, canEdit, tier, owner } = hut;
  /** Edit mode: the owner is decorating. Everything that changes the room happens only here; outside it a click uses a piece. */
  const [editing, setEditing] = useState(false);
  const decorating = canEdit && editing;
  /** A piece to use once the hero has walked over to it. */
  const [pending, setPending] = useState<number | null>(null);
  /** Use a placed piece: walk over to it first if need be. Set further down, where everything it needs is known. */
  const usePiece = useRef<(id: number) => void>(() => {});
  const room = useMemo(() => (tier === null ? null : hutRoom(tier)), [tier]);
  const placed = useMemo(() => placedFurnishings(furnishings), [furnishings]);
  const stored = furnishings.filter((f) => f.q === null && f.inId === null);
  const storedBig = stored.filter((f) => !isSmall(f.defId) && !isMounted(f.defId));
  const storedWall = stored.filter((f) => isMounted(f.defId));
  const storedSmall = stored.filter((f) => isSmall(f.defId));
  const chosen = placed.find((f) => f.id === selected) ?? null;
  const held = furnishings.find((f) => f.id === holding) ?? null;

  const scene = useMemo<RenderState | null>(() => {
    if (!you || !room) return null;
    return {
      code: `hut:${ownerId}:${tier}`,
      you,
      phase: "overworld",
      round: 0,
      map: room,
      heroes: players.map((p) => {
        // Lying on their bed after a rest, until they walk off (HutRoom's lie_down).
        const bed = p.bed !== undefined ? placed.find((f) => f.id === p.bed) : undefined;
        const lying = bed ? { pos: { q: bed.q, r: bed.r }, asleep: true, at: { x: bed.x, z: bed.z, y: 0.3 } } : { pos: p.pos };
        return { id: p.id, classId: p.classId, label: p.name, outfit: p.outfit, level: p.level, xp: p.xp, ...lying };
      }),
      turn: null,
      battle: null,
      story: null,
      npcs: {},
      freeRoam: true,
      indoors: true,
      lampOff,
      stamina: stamina ? { left: stamina.stamina.left, max: stamina.stamina.max } : undefined,
      props: placed.map((f) => {
        const def = defOf(f);
        const small = isSmall(f.defId);
        const mount = def?.mount;
        const turned = turning?.id === f.id ? { facing: 0, angle: turning.angle } : { facing: f.facing, angle: f.angle };
        const fp = footprintOf(f.defId);
        return {
          id: f.id,
          model: def?.model ?? f.defId,
          pos: { q: f.q, r: f.r },
          ...(mount ? { facing: f.facing, angle: 0 } : turned),
          selected: f.id === selected || f.id === holding,
          small,
          mount: !!mount,
          x: f.x,
          z: f.z,
          y: f.y,
          on: f.onId ?? undefined,
          surface: def?.surface,
          ring: mount ? Math.max(mount.w, mount.h) / 2 + 0.08 : Math.max(0.35, (fp.round ? fp.w : Math.hypot(fp.w, fp.d)) / 2 + 0.08),
          covers: !small && !mount && f.onId === null ? coveredHexes(f.defId, f, { x: f.x, z: f.z, angle: turnOf(turned) }) : undefined,
        };
      }),
      holding: held && decorating ? { model: defOf(held)?.model ?? held.defId, small: isSmall(held.defId), mount: defOf(held)?.mount, facing: 0, angle: turn } : null,
    };
  }, [ownerId, tier, room, players, you, placed, selected, holding, held, decorating, turn, turning, lampOff, stamina]);
  const latest = useRef(scene);
  latest.current = scene;
  const snapRef = useRef(snap);
  snapRef.current = snap;

  // The renderer is created once; its click handler reads the current state through this ref.
  const click = useRef<(pos: HexPos) => void>(() => {});
  click.current = (pos) => {
    const piece = placed.find((f) => same({ q: f.q, r: f.r }, pos));
    setPending(null);
    if (!decorating && piece) {
      usePiece.current(piece.id);
    } else if (decorating && holding !== null) {
      // Clicking the piece being moved puts it back where it was. (Setting it down goes through `place`.)
      setSelected(holding);
      setHolding(null);
    } else if (decorating && piece) {
      setSelected(piece.id);
    } else if (selected !== null) {
      // With a piece chosen, a click on the floor only lets go of it.
      setSelected(null);
    } else {
      setSelected(null);
      hut.send({ type: "move", to: pos });
    }
  };

  /** Why the carried piece may not go at `target`, by the same rules the server checks, or null if it may. */
  const whyNot = useRef<(target: PlaceTarget) => string | null>(() => null);
  whyNot.current = (target) => {
    if (!held || !room) return "Nothing is being carried.";
    const others = furnishings.filter((f) => f.id !== held.id);
    if (isSmall(held.defId)) {
      const spot = target.on !== undefined ? { on: Number(target.on), x: target.x, z: target.z, angle: turn } : { pos: target.pos, x: target.x, z: target.z, angle: turn };
      return smallPlaceProblem(room, others, held.defId, spot);
    }
    // Its own riders move with it.
    const rest = others.filter((f) => f.onId !== held.id);
    if (isMounted(held.defId)) {
      if (!target.wall) return "Point at a back or side wall.";
      return wallPlaceProblem(room, rest, held.defId, { pos: target.pos, side: target.wall.side, x: target.x, y: target.wall.y });
    }
    return floorTrouble(held, target.pos, { x: target.x, z: target.z, angle: turn }, rest);
  };
  /** Why a floor piece cannot stand at `spot`, by the rules and for anyone standing where it would go (see HutRoom). */
  const floorTrouble = (piece: Furnishing, pos: HexPos, spot: { x: number; z: number; angle: number }, rest: Furnishing[], turningInPlace = false): string | null => {
    if (!room) return "Nothing is being carried.";
    const problem = placeProblem(room, rest, piece.defId, pos, spot);
    if (problem) return problem;
    const covered = coveredHexes(piece.defId, pos, spot).filter((h) => !turningInPlace || !same(h, pos));
    return players.some((p) => covered.some((h) => same(h, p.pos))) ? "Someone is standing there." : null;
  };
  const place = useRef<(target: PlaceTarget) => void>(() => {});
  place.current = (target) => {
    if (!held) return;
    // A spot it cannot go: say why, and keep hold of it.
    const problem = whyNot.current(target);
    if (problem) return setRefusal(problem);
    if (target.wall) {
      hut.send({ type: "place", id: held.id, to: target.pos, facing: target.wall.side, x: target.x, y: target.wall.y });
    } else {
      hut.send({ type: "place", id: held.id, to: target.pos, x: target.x, z: target.z, angle: turn, ...(target.on !== undefined ? { on: Number(target.on) } : {}) });
    }
    setSelected(held.id);
    setHolding(null);
  };

  // Turning a placed piece shows at once and is sent when the turning stops, so holding a key down is one save, not thirty.
  const sendTurn = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!turning) return;
    if (sendTurn.current) clearTimeout(sendTurn.current);
    sendTurn.current = setTimeout(() => {
      hut.send({ type: "rotate", id: turning.id, angle: turning.angle });
      sendTurn.current = null;
    }, 220);
  }, [turning]);
  // Once the room has the new turn (or said no), the piece is drawn from what it says again.
  useEffect(() => setTurning(null), [furnishings, hut.refused]);

  /**
   * Turn what is carried, or (with nothing carried) the piece chosen. Snapped,
   * it goes to the next notch: the hex's six facings for furniture, 15° for a
   * small thing. Free, it turns `by` radians (5° unless said).
   */
  const turnBy = useRef<(dir: 1 | -1, free: boolean, by?: number) => void>(() => {});
  turnBy.current = (dir, free, by = FINE) => {
    const piece = held ?? chosen;
    if (!piece || isMounted(piece.defId)) return;
    const next = (from: number) => (free ? wrapAngle(from + dir * by) : snapTurn(from, dir, snapStep(piece.defId)));
    if (held) return setTurn(next);
    if (!chosen) return;
    const from = turning?.id === chosen.id ? turning.angle : turnOf(chosen);
    const angle = next(from);
    // Big pieces can be too long to turn where they stand: say so before asking.
    if (!isSmall(chosen.defId) && chosen.onId === null) {
      const problem = floorTrouble(chosen, chosen, { x: chosen.x, z: chosen.z, angle }, furnishings.filter((f) => f.id !== chosen.id && f.onId !== chosen.id), true);
      if (problem) return setRefusal(problem);
    }
    setTurning({ id: chosen.id, angle });
  };
  /** The wheel, while carrying: snapped, a notch per click (not too fast on a trackpad); free, as far as it moves. */
  const lastWheel = useRef(0);
  const wheelTurn = useRef<(dir: 1 | -1, amount: number, alt: boolean) => void>(() => {});
  wheelTurn.current = (dir, amount, alt) => {
    if (snap !== alt) {
      const now = performance.now();
      if (now - lastWheel.current < 90) return;
      lastWheel.current = now;
      turnBy.current(dir, false);
    } else {
      turnBy.current(dir, true, amount * (Math.PI / 18));
    }
  };
  const propClick = useRef<(id: number) => boolean>(() => false);
  propClick.current = (id) => {
    if (!decorating) {
      setPending(null);
      usePiece.current(id);
      return true;
    }
    if (holding !== null) return false;
    setSelected((s) => (s === id ? null : id));
    return true;
  };

  const heroSheet = useHeroSheet();

  useEffect(() => {
    const r = new WorldRenderer(mount.current!, {
      onHexClick: (pos) => click.current(pos),
      onHover: setHover,
      onPropClick: (id) => propClick.current(Number(id)),
      onPropHover: (id) => setHoverProp(id === null ? null : Number(id)),
      onPlace: (target) => place.current(target),
      canPlace: (target) => whyNot.current(target) === null,
      onTurnHeld: (dir, amount, alt) => wheelTurn.current(dir, amount, alt),
    });
    renderer.current = r;
    if (latest.current) r.setState(latest.current);
    return () => {
      r.dispose();
      renderer.current = null;
    };
  }, []);
  useEffect(() => {
    if (scene) renderer.current?.setState(scene);
  }, [scene]);
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "end" });
  }, [hut.chat.length]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      // By code as well as key: Alt with a bracket types another character on a Mac.
      const dir = e.code === "BracketLeft" || e.key === "[" ? -1 : e.code === "BracketRight" || e.key === "]" ? 1 : 0;
      if (e.key === "Escape") (setHolding(null), setSelected(null), setOpened(null));
      else if (dir) {
        e.preventDefault();
        turnBy.current(dir, snapRef.current === e.altKey);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Dev-only handle for driving the hut from the console or a test script.
  if (import.meta.env.DEV) (window as unknown as { __hut: unknown }).__hut = { hut, renderer };

  const mine = ownerId === me.player.id;
  const loadOwn = () => api.hut().then(setOwn, (e: Error) => setNote({ where: "storage", text: e.message, ok: false }));
  useEffect(() => {
    if (mine) void loadOwn();
  }, [mine]);
  /** Craft or upgrade: the server decides, then the panel re-reads what is left. */
  const spend = async (where: Where, fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setNote(null);
    try {
      // Crafting pays a little Harbor XP; say so after what was done.
      const xp = ((await fn()) as { xp?: { text?: string } } | undefined)?.xp?.text;
      setNote({ where, text: xp ? `${done} ${xp}` : done, ok: true });
    } catch (e) {
      setNote({ where, text: (e as Error).message, ok: false });
    } finally {
      await Promise.all([loadOwn(), refresh()]);
      setBusy(false);
    }
  };
  const perks = useMemo(() => hutPerks(furnishings), [furnishings]);
  const bigger = tier === null ? null : nextHutTier(tier);
  const title = mine ? "Your hut" : owner ? `${owner.name}'s hut` : "A hut";
  const self = players.find((p) => p.id === you);
  const atDoor = !!self && !!room && poiAt(room, self.pos)?.kind === "door";
  const hoverPiece = (hoverProp !== null ? placed.find((f) => f.id === hoverProp) : undefined) ?? (hover ? placed.find((f) => same({ q: f.q, r: f.r }, hover) && f.onId === null && !isSmall(f.defId)) : undefined);
  /** Over a piece: what it is and gives, and outside edit mode what a click does (or whose it is). */
  const pieceTip = (f: Furnishing) => {
    const about = `${f.label}: ${blurb("furnishing", f.defId)}`;
    if (decorating) return about;
    const use = useOf(f.defId);
    const problem = useProblem(f.defId, canEdit, owner?.name);
    return problem ? `${about} ${problem}` : use === "look" ? about : `${about} Click to ${USE_VERB[use].toLowerCase()}.`;
  };
  const tip = hoverPiece ? pieceTip(hoverPiece) : hover && room && poiAt(room, hover)?.kind === "door" ? "The door" : null;
  /** Ticks once a minute while a rest is cooling down, so "rest again in" counts down. */
  const [clock, setClock] = useState(() => Date.now());
  const coolingUntil = stamina?.restReadyAt ?? 0;
  useEffect(() => {
    if (coolingUntil <= Date.now()) return;
    const t = setInterval(() => setClock(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [coolingUntil]);
  const restIn = Math.max(0, Math.ceil((coolingUntil - clock) / 60_000));
  const tired = !!stamina && stamina.stamina.left < stamina.stamina.max;
  /** Why resting would do nothing right now, or null (the server has the last word). */
  const restBlocked = !stamina ? null : !tired ? "You are not tired. Rest after you have been out gathering." : restIn > 0 ? `You can rest again in ${restIn} min.` : null;
  const staminaLine = stamina && `${stamina.stamina.left} of ${stamina.stamina.max} outings${restIn > 0 ? ` · rest again in ${restIn} min` : ""}`;
  /** A short note that fades: what a rest did, or why it did nothing. */
  const [notice, setNotice] = useState<{ text: string; ok: boolean; n: number } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);
  const [resting, setResting] = useState(false);
  /** Rest at home (the server checks the cooldown and that you are in your own hut). On a bed, lie down on it for everyone to see. */
  const restAtHome = async (bedId?: number) => {
    setResting(true);
    try {
      const res = await api.rest("hut");
      setStamina(res);
      setClock(Date.now());
      if (bedId !== undefined) hut.send({ type: "lie_down", id: bedId });
      setNotice({ text: `You wake rested: ${res.stamina.left} of ${res.stamina.max} outings.`, ok: true, n: Date.now() });
    } catch (e) {
      setNotice({ text: (e as Error).message, ok: false, n: Date.now() });
    } finally {
      setResting(false);
    }
  };
  const say = () => {
    if (!text.trim()) return;
    hut.send({ type: "say", text });
    setText("");
  };
  /** Do what a piece does, standing beside it (or, for a look, from anywhere). */
  const doUse = useRef<(piece: Furnishing) => void>(() => {});
  doUse.current = (piece) => {
    const about = blurb("furnishing", piece.defId);
    const use = useOf(piece.defId);
    if (use === "rest") {
      if (restBlocked) return setNotice({ text: restBlocked, ok: false, n: Date.now() });
      void restAtHome(piece.id);
    } else if (use === "open") {
      setOpened(piece.id);
    } else if (use === "warm") {
      setNotice({ text: `You warm your hands at the ${piece.label}. ${about}`, ok: true, n: Date.now() });
    } else if (use === "read") {
      setNotice({ text: `You leaf through the ${piece.label}. ${about}`, ok: true, n: Date.now() });
    } else {
      setNotice({ text: `${piece.label}: ${about}`, ok: true, n: Date.now() });
    }
  };
  usePiece.current = (id) => {
    const piece = placed.find((f) => f.id === id);
    if (!piece || !room || !self) return;
    const use = useOf(piece.defId);
    // A visitor is told what it is and whose it is; the server would refuse them anyway.
    const problem = useProblem(piece.defId, canEdit, owner?.name);
    if (problem) return setNotice({ text: `${piece.label}: ${problem}`, ok: false, n: Date.now() });
    if (use === "look") return doUse.current(piece);
    // No walk across the room for a rest that will not happen.
    if (use === "rest" && restBlocked) return setNotice({ text: restBlocked, ok: false, n: Date.now() });
    if (isBeside(room, furnishings, piece, self.pos)) return doUse.current(piece);
    const routes = besideHexes(room, furnishings, piece)
      .map((h) => hutPath(room, furnishings, self.pos, h))
      .filter((r): r is HexPos[] => !!r)
      .sort((a, b) => a.length - b.length);
    if (routes.length === 0) return setNotice({ text: `You cannot get to the ${piece.label}.`, ok: false, n: Date.now() });
    hut.send({ type: "move", to: routes[0][routes[0].length - 1] });
    setPending(piece.id);
  };
  // Once the hero has walked over and stopped, use what they walked to. Given up after a while (a refused walk).
  useEffect(() => {
    if (pending === null) return;
    const piece = placed.find((f) => f.id === pending);
    if (!piece || !room || !self || !isBeside(room, furnishings, piece, self.pos)) return;
    // The walk is drawn frame by frame; a tab in the background barely draws, so do not wait on it for ever.
    const since = Date.now();
    const wait = setInterval(() => {
      if (renderer.current?.isWalking(self.id) && Date.now() - since < 3000) return;
      clearInterval(wait);
      setPending(null);
      doUse.current(piece);
    }, 80);
    return () => clearInterval(wait);
  }, [pending, self?.pos.q, self?.pos.r, placed, furnishings, room]);
  useEffect(() => {
    if (pending === null) return;
    const t = setTimeout(() => setPending(null), 10_000);
    return () => clearTimeout(t);
  }, [pending]);
  /** Lying on their bed after a rest: the bar and the button over their head wait until they get up. */
  const asleep = self?.bed !== undefined && placed.some((f) => f.id === self.bed);
  /** What the hero stands beside and may use, for the button over their head: the most useful first. */
  const besideUse = (() => {
    if (decorating || !room || !self || asleep || pending !== null) return null;
    const near = placed.filter((f) => useOf(f.defId) !== "look" && !useProblem(f.defId, canEdit) && isBeside(room, furnishings, f, self.pos));
    near.sort((a, b) => USE_ORDER.indexOf(useOf(a.defId)) - USE_ORDER.indexOf(useOf(b.defId)));
    const piece = near[0];
    if (!piece) return null;
    const use = useOf(piece.defId);
    return { piece, label: use === "open" ? `Open ${piece.label}` : USE_VERB[use] };
  })();
  /** Leave edit mode: whatever was being carried goes back where it was, as Cancel does. */
  const toggleEditing = () => {
    setHolding(null);
    setSelected(null);
    setPending(null);
    setEditing((on) => !on);
  };
  /** The bar's Rest: to the bed if there is one placed, else right where you stand. */
  const bed = placed.find((f) => f.defId === "bed");
  const restFromBar = () => (bed ? usePiece.current(bed.id) : void restAtHome());

  const pick = (id: number) => {
    const piece = furnishings.find((f) => f.id === id);
    if (piece) setTurn(turnOf(piece));
    setSelected(null);
    setHolding((h) => (h === id ? null : id));
  };
  /** Gear or materials in or out of a container: then re-read the hut and the bag. */
  const act = (fn: () => Promise<unknown>) => {
    setNote(null);
    void fn()
      .catch((e: Error) => setNote({ where: "box", text: e.message, ok: false }))
      .finally(() => void Promise.all([loadOwn(), refresh()]));
  };
  const onTop = chosen ? placed.filter((f) => f.onId === chosen.id) : [];
  const box = opened !== null ? furnishings.find((f) => f.id === opened && defOf(f)?.storage) ?? null : null;
  // Opening a container re-reads what it holds, which may have changed since the panel last looked.
  useEffect(() => {
    if (mine && opened !== null) void loadOwn();
  }, [mine, opened]);
  // A container that is put away (or into another) closes.
  useEffect(() => {
    if (opened !== null && (!box || box.q === null)) setOpened(null);
  }, [opened, box]);
  // Outside edit mode a chest is used standing beside it: walking away closes it.
  const besideBox = !!box && !!room && !!self && isBeside(room, furnishings, box, self.pos);
  useEffect(() => {
    if (!decorating && opened !== null && box && !besideBox) setOpened(null);
  }, [decorating, opened, box, besideBox]);

  // A refusal from the room shows as a toast, and goes after a few seconds.
  useEffect(() => setRefusal(hut.refused), [hut.refused]);
  useEffect(() => {
    if (!refusal) return;
    const t = setTimeout(() => setRefusal(null), 4000);
    return () => clearTimeout(t);
  }, [refusal]);

  /** Buttons to turn a floor piece: to the next notch either way, and 5° either way, plus the snapping switch. */
  const turnTools = (defId: string): ToolAction[] => {
    const notch = isSmall(defId) ? "15°" : "a sixth";
    return [
      { key: "left", icon: "left", title: `Turn left ${notch} ( [ )`, run: () => turnBy.current(-1, false) },
      { key: "fine-left", icon: "fineLeft", title: "Turn left 5° (Alt + [ )", run: () => turnBy.current(-1, true) },
      { key: "fine-right", icon: "fineRight", title: "Turn right 5° (Alt + ] )", run: () => turnBy.current(1, true) },
      { key: "right", icon: "right", title: `Turn right ${notch} ( ] )`, run: () => turnBy.current(1, false) },
      { key: "snap", icon: "snap", title: snap ? "Snapping on: [ ], ] and Shift + wheel turn to the notches. Click to turn freely." : "Snapping off: [ ], ] and Shift + wheel turn freely. Click to snap to the notches.", active: snap, run: toggleSnap },
    ];
  };

  /** The floating controls for the chosen piece. */
  const tools: ToolAction[] = [];
  if (chosen && decorating && !held) {
    tools.push({ key: "move", icon: "move", title: isMounted(chosen.defId) ? "Move: take it down and hang it somewhere else" : "Move: pick it up and set it down somewhere else", run: () => pick(chosen.id) });
    if (!isMounted(chosen.defId)) tools.push(...turnTools(chosen.defId));
    if (defOf(chosen)?.storage) {
      tools.push({ key: "open", icon: "open", title: opened === chosen.id ? "Close: hide what it holds" : "Open: see what it holds", active: opened === chosen.id, run: () => setOpened((o) => (o === chosen.id ? null : chosen.id)) });
    }
    const riders = onTop.length > 0 ? ` (and what stands on it: ${onTop.map((f) => f.label).join(", ")})` : "";
    tools.push({ key: "away", icon: "away", title: `Put away: back into storage${riders}`, run: () => (hut.send({ type: "pick_up", id: chosen.id }), setSelected(null)) });
  }

  return (
    <div className={`run hut-view ${canEdit && box ? "box-open" : ""}`}>
      <div className="stage" ref={mount} />
      <div className="topbar">
        <strong>{title}</strong>
        {tier !== null && <span className="muted">{hutTier(tier).name}</span>}
        <span className="spacer" />
        {hut.status !== "open" && !hut.error && <span className="bad">connecting…</span>}
        <button className="small" onClick={onLeave}>Leave</button>
      </div>

      {decorating && (
        <DragPanel id="hut.storage" title="Storage" foldOnPhone className="story panel hut-storage">
          {held ? (
            isMounted(held.defId) ? (
              <p className="hut-hint">
                Point at a back or side wall and click to hang the <strong>{held.label}</strong> there, as high as you point. <button className="link" onClick={() => setHolding(null)}>Cancel</button>
              </p>
            ) : (
              <>
                <p className="hut-hint">
                  Click to set the <strong>{held.label}</strong> down.{" "}
                  {isSmall(held.defId) ? "It goes anywhere in a hex, or on a table, shelf or other top. " : "It goes anywhere inside a hex, against a wall or another piece. "}
                  <kbd>[</kbd> <kbd>]</kbd> or Shift + wheel turns it{snap ? " to the notches; hold Alt to turn freely" : " freely; hold Alt to snap"}. <button className="link" onClick={() => setHolding(null)}>Cancel</button>
                </p>
                <div className="hut-turn">
                  {turnTools(held.defId).map((t) => (
                    <button key={t.key} className={`small ${t.active ? "selected" : ""}`} title={t.title} aria-label={t.title} onClick={t.run}>
                      {{ left: "⟲", fineLeft: "‹", fineRight: "›", right: "⟳", snap: t.active ? "Snap on" : "Snap off" }[t.icon as string] ?? t.key}
                    </button>
                  ))}
                </div>
              </>
            )
          ) : (
            <p className="muted">Pick a piece up to place it. Furniture goes anywhere inside a hex, wall pieces hang on the back and side walls, and small things go anywhere, or on top of a table, shelf, dresser or chest. Click a placed piece for its controls.</p>
          )}
          {noteIn("storage")}
          {stored.length === 0 && <p className="muted">Nothing in storage. Make something in the Craft panel.</p>}
          {[["Furniture", storedBig], ["On the walls", storedWall], ["Small things", storedSmall]].map(([heading, list]) => (list as Furnishing[]).length > 0 && (
            <div key={heading as string}>
              <h4>{heading as string}</h4>
              <ul className="hut-list">
                {(list as Furnishing[]).map((f) => (
                  <li key={f.id}>
                    <button className={holding === f.id ? "selected" : ""} title={`${blurb("furnishing", f.defId)} Pick it up to place it.`} onClick={() => pick(f.id)}>
                      <ThingIcon icon={furnishingIcon(f.defId)} size={27} />{f.label}{tags(f.defId).filter((t) => t !== "small").map((t) => <span key={t} className="tag">{t}</span>)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </DragPanel>
      )}

      {decorating && (
        <DragPanel id="hut.craft" title="Craft" foldOnPhone startFolded className="panel hut-craft">
          {noteIn("craft")}
          {!own ? <p className="muted">Counting your materials…</p> : <>
            <ResourceChips resources={own.resources} all />
            <ul className="hut-recipes">
              {RECIPES.map((def) => {
                const known = !def.needsBlueprint || own.blueprints.includes(def.id);
                const problem = craftProblem(def.id, own.blueprints, own.resources);
                return (
                  <li key={def.id} className={known ? "" : "locked"}>
                    <div className="with-icon">
                      <ThingIcon icon={furnishingIcon(def.id)} size={36} />
                      <span className="grow">
                      <strong>{label("furnishing", def.id)}</strong>
                      <span className="muted"> · {known ? blurb("furnishing", def.id) : "Blueprint not found yet. Islands hide them."}</span>
                      </span>
                    </div>
                    <div className="row">
                      <CostChips cost={def.recipe!} have={own.resources} />
                      <span className="spacer" />
                      <button className="small primary" disabled={busy || !!problem} title={problem ?? "Goes into storage"} onClick={() => void spend("craft", () => api.craft(def.id), `${label("furnishing", def.id)} crafted. It is in storage.`)}>
                        Craft
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>}
        </DragPanel>
      )}

      {you && tier !== null && (
        <DragPanel id="hut.info" title="Hut" foldOnPhone startFolded className="panel hut-info">
          {noteIn("hut")}
          <p>{mine ? "Your hut" : `${owner?.name ?? "This"}'s hut`} is a <strong>{hutTier(tier).name}</strong>: a floor of {hutTier(tier).cols} by {hutTier(tier).rows}.</p>
          {canEdit && (!bigger ? <p className="muted">It is as big as huts get.</p> : !own ? <p className="muted">Counting your materials…</p> : <>
            <h4>Build the {bigger.name}</h4>
            <p className="muted">A floor of {bigger.cols} by {bigger.rows}, and a bigger building in the Harbor. Everything placed stays where it stands.</p>
            <div className="row">
              <CostChips cost={bigger.resources} have={own.resources} gold={bigger.gold} haveGold={own.gold} />
            </div>
            {upgradeProblem(tier, own.gold, own.resources) && <p className="muted">{upgradeProblem(tier, own.gold, own.resources)}</p>}
            <button className="primary" disabled={busy || !!upgradeProblem(tier, own.gold, own.resources)} onClick={() => void spend("hut", () => api.upgradeHut(), `Your hut is now a ${bigger.name}.`)}>
              Build the {bigger.name}
            </button>
          </>)}

          <h4>Voyage perks</h4>
          <p className="muted">What the pieces standing in the room give {mine ? "you" : "their owner"} when boarding a ship, and the most a hut can give.</p>
          <PerkMeter perks={perks} />

          <h4>In the room</h4>
          {placed.length === 0 && <p className="muted">Nothing placed yet.</p>}
          <ul className="hut-list">
            {placed.map((f) => (
              <li key={f.id}>
                {decorating ? (
                  <button className={selected === f.id || holding === f.id ? "selected" : ""} title={blurb("furnishing", f.defId)} onClick={() => {
                    setHolding(null);
                    setSelected((s) => (s === f.id ? null : f.id));
                    // Picked from the list, it may be off screen (a phone shows little of the room): bring it into view.
                    renderer.current?.lookAt({ q: f.q, r: f.r });
                  }}>
                    {f.label}
                  </button>
                ) : (
                  <span title={blurb("furnishing", f.defId)}>{f.label}</span>
                )}
              </li>
            ))}
          </ul>
        </DragPanel>
      )}

      {canEdit && box && (
        <DragPanel id="hut.box" title={box.label} className="panel hut-boxpanel">
          <div className="row">
            <span className="muted">{blurb("furnishing", box.defId)}</span>
            <span className="spacer" />
            <button className="small" onClick={() => setOpened(null)}>Close</button>
          </div>
          {noteIn("box")}
          <HutContainer box={box} furnishings={furnishings} own={own} bag={me.inventory} pack={me.carry} send={hut.send} act={act} carry={(id) => (setEditing(true), pick(id))} />
        </DragPanel>
      )}

      {chosen && tools.length > 0 && (
        <HutToolbar renderer={renderer} propId={chosen.id} name={chosen.label} tags={tags(chosen.defId)} actions={tools} />
      )}
      {refusal ? <div className="toast" role="status">{refusal}</div>
        : notice && <div key={notice.n} className={`toast fade ${notice.ok ? "note" : ""}`} role="status">{notice.text}</div>}

      {you && <>
      <DragPanel id="hut.crew" title="Inside" foldOnPhone className="crew roster-panel">
        <CrewRoster
          you={you}
          heading={<>{players.length} in the hut</>}
          members={players.map((p) => ({ id: p.id, name: p.name, classId: p.classId, level: p.level, outfit: p.outfit, here: true, tags: p.id === ownerId && p.id !== you ? ["owner"] : undefined }))}
          onOpen={heroSheet.toggle}
          openId={heroSheet.open}
        />
      </DragPanel>

      <DragPanel id="hut.chat" title="Hut chat" foldOnPhone className="chat panel harbor-chat">
        <div className="chat-lines">
          {hut.chat.length === 0 && <div className="muted">Only people inside this hut see what is said here.</div>}
          {hut.chat.map((l, i) => <div key={i} className="line hero"><strong>{l.name}: </strong>{l.text}</div>)}
          <div ref={chatEnd} />
        </div>
        <div className="row">
          <input value={text} maxLength={200} placeholder="Say something…" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && say()} />
          <button disabled={!text.trim()} onClick={say}>Say</button>
        </div>
      </DragPanel>

      <DragPanel id="hut.turn" title="Here" compact className="turnbar panel hut-here">
        <p className={`hut-here-hint ${atDoor ? "" : "muted"}`}>
          {atDoor ? "The door back to the Harbor."
            : decorating ? "Decorating: click a piece for its controls, or pick one out of Storage. Done when you are finished."
            : canEdit ? "Click a hex to walk, or a piece to use it: sleep in the bed, open a chest."
            : `Click a piece to look at it. Only ${owner?.name ?? "the owner"} can move the furniture.`}
        </p>
        <div className="hut-here-row">
          {canEdit && (
            <>
              {stamina && (
                <span className="hut-stamina" title={staminaLine ?? undefined}>
                  <StaminaBolts left={stamina.stamina.left} max={stamina.stamina.max} size={16} />
                  {restIn > 0 && <span className="muted"> rest in {restIn} min</span>}
                </span>
              )}
              <button disabled={resting || !!restBlocked || asleep} title={restBlocked ?? (bed ? `Walk to your ${bed.label} and sleep: all your gathering outings back, once every twenty minutes` : "Sleep here: all your gathering outings back, once every twenty minutes")} onClick={restFromBar}>Rest</button>
              <button className={`hut-decorate ${decorating ? "selected" : ""}`} aria-pressed={decorating} aria-label={decorating ? "Done decorating" : "Decorate"} title={decorating ? "Done decorating: back to using things (anything carried goes back where it was)" : "Decorate: move, turn, put away and craft furniture"} onClick={toggleEditing}>
                <PixelIcon rows={ICON.hammer} /><span className="hut-decorate-label">{decorating ? "Done" : "Decorate"}</span>
              </button>
            </>
          )}
          <span className="spacer" />
          <button className={lampOff ? "" : "lamp-on"} aria-pressed={!lampOff} title={lampOff ? "Light the hanging lamp" : "Put the hanging lamp out and let the candles, lanterns and fire light the room"} onClick={toggleLamp}>
            {lampOff ? "Lamp off" : "Lamp on"}
          </button>
          <button className={atDoor ? "primary" : ""} onClick={onLeave}>Leave</button>
        </div>
      </DragPanel>
      {atDoor && self && <TileAction renderer={renderer} pos={self.pos} unitId={self.id} label="Leave" run={onLeave} />}
      {!atDoor && self && besideUse && <TileAction renderer={renderer} pos={self.pos} unitId={self.id} label={besideUse.label} run={() => doUse.current(besideUse.piece)} />}
      </>}

      {tip && <div className="tip">{tip}</div>}
      {hut.error && (
        <div className="hut-refused panel">
          <p>{hut.error}</p>
          <button className="primary" onClick={onLeave}>Back to the Harbor</button>
        </div>
      )}
      {heroSheet.open && you && <HeroSheet id={heroSheet.open} you={you} onClose={heroSheet.close} />}
    </div>
  );
}
