// The atlas: the crew's world, as a view of its own. A small world of hexes
// seen from a long way up: seas and their coasts, sand, clumps of little
// trees, ridges of small peaks. The Harbor's lighthouse stands in the middle
// of it; the places the crew can go stand on their own hexes round it, lit,
// with routes laid on the ground between them; and everything far from
// anywhere they know lies under a sea of cloud, with the places out there
// and the routes to them drawn dark on top of it.
//
// The ground is drawn by the same renderer as every other map
// (WorldRenderer, told the map is `far`). The land itself is worked out here
// from the chart's seed (packages/world/src/atlasMap.ts): the server sends
// only the chart (server/atlas.ts), which is what it decides. The world has
// no edge, so what the renderer holds is a window of it round wherever the
// camera is looking, and as the camera travels the view hands it the next.
// The cloud (AtlasCloud.ts), the places and the routes (AtlasLayer.ts) are
// things in that world; only their names and what is known at a glance are
// laid over it here. The places nothing is known of are worked out here too,
// from the same seed and by the same rules as the server's.
//
// It opens from above the cloud: the camera comes down and round while the
// cloud parts outward from the Harbor. Picking a place shows what is known
// of it and lights the way there from the Harbor; Set out goes to its map,
// and coming back from one lands here again.
//
// Nothing is shown of a place until it is clicked: then a small panel
// stands beside it, and goes with it as the map is moved. It holds the
// place's one slot, for a lodestone (packages/world/src/lodestone.ts): a
// stone out of the hero's own pack is put into it before setting out, and is
// spent as the map is made, with what it carries added to the place's own.
// Anywhere but beside the Harbor there must be one. What a stone carries is
// told by pointing at it. Stones are cut and worked down in the Harbor, at
// the stonecutter's bench, before coming up here.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hexDistance, type HexPos } from "@gantt-quest/core";
import { ATLAS_HOME, ATLAS_SPACING, ATLAS_VIEW, LAIR_RINGS, modEffect, modName, modSide, atlasNodeById, atlasTier, atlasWorld, bountyPay, modsOf, needsStone, stoneKey, stoneName, stoneOn, type AtlasNode, type Lodestone } from "@gantt-quest/world";
import { api, type Chart, type ChartNode, type Me } from "../api";
import { useAudioScene } from "../audio/useAudioScene";
import { InventoryScreen } from "../InventoryScreen";
import { Icon } from "../items";
import { STONE_ICON } from "../zone/actionIcons";
import { worldToHex } from "../render/footsteps";
import { WorldRenderer, type RenderState } from "../render/WorldRenderer";
import { uiZoom } from "../uiScale";
import { AtlasCloud, CLOUD_TOP } from "./AtlasCloud";
import { AtlasLayer, type AtlasMark, type AtlasRoute, type Rise } from "./AtlasLayer";
import "./atlas.css";

type Known = Extract<ChartNode, { state: "harbor" | "cleared" | "open" }>;
const known = (n: ChartNode | undefined): n is Known => !!n && n.state !== "fogged";
const GROUND: Record<Known["biome"], string> = { meadow: "Open ground", woods: "Deep woods", shore: "A stretch of shore", caves: "A sea cave" };
/** The climate a place lies in, as the card says it. */
const CLIME: Record<Known["clime"], string> = { greenwood: "the Greenwood", frost: "the Frost", dunes: "the Dunes", mire: "the Mire", ash: "the Ashlands" };
/** How often the chart is asked for again: a crewmate may have cleared something. */
const REFRESH_MS = 10_000;
/** Places lose what is written under them when they are drawn closer together than this, in pixels. */
const CROWDED_PX = 120;
/** How far the camera may travel from the middle of the window it was given before it is given another, in hexes. */
const DRIFT = 9;
/** How long the opening takes, in milliseconds: the title holds the screen, then gives way to the card and the top bar. */
const OPENING_MS = 3600;
/** How far to the side of its place the panel for it stands, in pixels, and how near the edge of the view it may come. */
const PANEL_OUT = 34;
const PANEL_EDGE = 10;
/** Where a place picked before setting out is remembered, so coming back lands on it. */
const FOCUS_KEY = "gq.atlas.at";

export function AtlasView({ me, refresh, onLeave }: { me: Me; refresh(): Promise<void>; onLeave(): void }) {
  const mount = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const renderer = useRef<WorldRenderer | null>(null);
  const [chart, setChart] = useState<Chart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(FOCUS_KEY);
    } catch {
      return null;
    }
  });
  const [hovered, setHovered] = useState<string | null>(null);
  /** The hex of the world the window the renderer holds is round. Null until the chart is in. */
  const [centre, setCentre] = useState<HexPos | null>(null);
  const layer = useRef<AtlasLayer | null>(null);
  const cloud = useRef<AtlasCloud | null>(null);
  /** Opened from the Harbor (not come back to from a map): it opens grandly, the title holding the screen while the cloud parts. */
  const [opening, setOpening] = useState(() => picked === null);
  /** The world is on the screen (it is made behind a veil first): the opening starts from here. */
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    if (!opening || !onScreen) return;
    const done = setTimeout(() => setOpening(false), OPENING_MS);
    return () => clearTimeout(done);
  }, [opening, onScreen]);
  /** What is written under each place, by id: moved by hand each frame, as the camera is not React's. */
  const tags = useRef(new Map<string, HTMLElement>());
  /** The panel of the place picked: it stands beside the place, and is moved with it. */
  const panel = useRef<HTMLDivElement>(null);
  const pickedHex = useRef<HexPos | null>(null);
  useAudioScene("harbor");

  /** The chart as it last came, as text: one that says nothing new is not a new chart (and no reason to redraw the world). */
  const last = useRef("");
  const take = useCallback((c: Chart) => {
    const text = JSON.stringify(c);
    if (text !== last.current) setChart(c);
    last.current = text;
  }, []);
  /** Why the chart could not be fetched, the last time it was tried: said until it can be. (What went wrong doing something is `error`, and stays until the next thing is tried.) */
  const [unreached, setUnreached] = useState<string | null>(null);
  const load = useCallback(() => api.atlas().then((c) => (take(c), setUnreached(null)), (e: Error) => setUnreached(e.message)), [take]);
  useEffect(() => {
    void load();
    const every = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(every);
  }, [load]);

  // ---------- the world ----------

  const nodes = useMemo(() => chart?.nodes ?? [], [chart]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  // The window opens round the place last picked, or the Harbor.
  useEffect(() => {
    if (centre || !chart) return;
    setCentre((byId.get(picked ?? "") ?? byId.get(ATLAS_HOME))?.hex ?? { q: 0, r: 0 });
  }, [chart, centre, byId, picked]);
  const world = useMemo(() => (chart && centre ? atlasWorld(chart.seed, chart.nodes, centre) : null), [chart, centre]);
  /** The places nothing is known of, as the rules make them from the seed: kept, as one is the same however often it is asked for. */
  const unknown = useRef({ seed: "", nodes: new Map<string, AtlasNode | null>() });
  /** Every place on the window: the chart's own, and the ones under the cloud. */
  const near = useMemo<ChartNode[]>(() => {
    if (!chart || !centre) return [];
    if (unknown.current.seed !== chart.seed) unknown.current = { seed: chart.seed, nodes: new Map() };
    const kept = unknown.current.nodes;
    const out: ChartNode[] = [];
    const span = Math.ceil(ATLAS_VIEW / ATLAS_SPACING) + 1;
    const mid = { q: Math.round(centre.q / ATLAS_SPACING), r: Math.round(centre.r / ATLAS_SPACING) };
    for (let dq = -span; dq <= span; dq++) {
      for (let dr = -span; dr <= span; dr++) {
        const id = `${mid.q + dq},${mid.r + dr}`;
        const charted = byId.get(id);
        if (charted) {
          if (hexDistance(charted.hex, centre) <= ATLAS_VIEW) out.push(charted);
          continue;
        }
        if (!kept.has(id)) kept.set(id, atlasNodeById(chart.seed, id) ?? null);
        const n = kept.get(id);
        if (n && hexDistance(n.hex, centre) <= ATLAS_VIEW) out.push({ id, hex: n.hex, ring: n.ring, links: n.links, state: "fogged" });
      }
    }
    return out;
  }, [chart, centre, byId]);
  /** The routes between them, and which end each was laid from (a route on to somewhere open, from the end the crew holds). */
  const routes = useMemo(() => {
    const list: AtlasRoute[] = [];
    const from = new Map<string, string>();
    const on = new Map(near.map((n) => [n.id, n]));
    const reached = (n: ChartNode) => n.state === "harbor" || n.state === "cleared";
    for (const a of near) {
      for (const id of a.links) {
        const b = on.get(id);
        if (!b || a.id >= b.id) continue;
        const kind = a.state === "fogged" || b.state === "fogged" ? "fog" : reached(a) && reached(b) ? "sailed" : "open";
        const [first, last] = kind === "open" && !reached(a) ? [b, a] : [a, b];
        const key = `${a.id}|${b.id}`;
        list.push({ key, a: first.hex, b: last.hex, kind });
        from.set(key, first.id);
      }
    }
    return { list, from };
  }, [near]);
  /** The way from the Harbor to the place picked, through places the crew has cleared: the routes to follow, in order. */
  const path = useMemo(() => {
    const goal = byId.get(picked ?? "");
    if (!known(goal) || goal.kind === "harbor") return [];
    const held = (id: string) => {
      const n = byId.get(id);
      return !!n && (n.state === "harbor" || n.state === "cleared");
    };
    const came = new Map<string, string>([[ATLAS_HOME, ""]]);
    const queue = [ATLAS_HOME];
    while (queue.length > 0 && !came.has(goal.id)) {
      const id = queue.shift()!;
      for (const next of byId.get(id)?.links ?? []) {
        if (came.has(next) || !(held(next) || next === goal.id)) continue;
        came.set(next, id);
        if (held(next)) queue.push(next);
      }
    }
    const steps: { key: string; back: boolean }[] = [];
    for (let id = goal.id; came.get(id); id = came.get(id)!) {
      const before = came.get(id)!;
      const key = before < id ? `${before}|${id}` : `${id}|${before}`;
      steps.unshift({ key, back: (routes.from.get(key) ?? before) !== before });
    }
    return steps;
  }, [byId, picked, routes]);

  const at = useRef({ near, centre });
  at.current = { near, centre };
  /** The place standing on a hex of the world, or on one beside it. */
  const placeAt = (pos: HexPos | null): string | null => {
    if (!pos) return null;
    const best = at.current.near.filter(known).map((n) => ({ n, d: hexDistance(n.hex, pos) })).sort((a, b) => a.d - b.d)[0];
    return best && best.d <= 1 ? best.n.id : null;
  };
  const point = useRef(placeAt);
  point.current = placeAt;
  useEffect(() => {
    const view = new WorldRenderer(mount.current!, {
      // A click on a place picks it; a click on open ground puts the card away.
      onHexClick: (pos) => setPicked(point.current(pos)),
      onHover: (pos) => setHovered(point.current(pos)),
    });
    renderer.current = view;
    cloud.current = new AtlasCloud(view, ATLAS_VIEW);
    layer.current = new AtlasLayer(view);
    // Dev server only: the cloud and the places, to poke at from the console.
    if (import.meta.env.DEV) (globalThis as { __gqAtlas?: unknown }).__gqAtlas = { cloud: cloud.current, layer: layer.current };
    return () => {
      layer.current?.dispose();
      cloud.current?.dispose();
      layer.current = cloud.current = null;
      renderer.current = null;
      view.dispose();
    };
  }, []);

  const looked = useRef(false);
  useEffect(() => {
    const view = renderer.current;
    const over = cloud.current;
    if (!view || !over || !world || !chart || !centre) return;
    // One map to the renderer, however many windows of it there are: the camera stays where it is from one to the next.
    const scene: RenderState = {
      code: `atlas:${chart.seed}`,
      far: true,
      you: "",
      phase: "overworld",
      round: 0,
      map: world.map,
      heroes: [],
      turn: null,
      story: null,
      npcs: {},
      freeRoam: true,
    };
    view.setState(scene);
    over.set(world.clear, centre);
    // On the ground where the cloud has lifted (or is thin enough to see through), on top of the cloud elsewhere.
    const rise: Rise = (x, z) => {
      const ground = view.groundAt(x, z);
      return ground && over.over(worldToHex(x, z)) < 0.5 ? { y: ground.top, aloft: false } : { y: CLOUD_TOP + 0.04, aloft: true };
    };
    const marks = near.map<AtlasMark>((n) => ({
      id: n.id,
      hex: n.hex,
      look: n.state,
      ...(known(n) && (n.kind === "lookout" || n.kind === "lair") ? { crown: n.kind } : {}),
      // A mote for everything odd about it, what a lodestone has added among them.
      ...(known(n) && n.state === "open" ? { motes: stoneOn(n, n.stone ?? []).mods.map((id) => modEffect(id).kind), busy: !!n.zone, danger: Math.min(1.2, (n.level - 1) * 0.12) } : {}),
    }));
    layer.current?.set(marks, routes.list, rise);
    if (looked.current) return;
    looked.current = true;
    // It opens on the place last picked, or on the Harbor: from above the cloud, which parts outward from there.
    const focus = byId.get(picked ?? "") ?? byId.get(ATLAS_HOME);
    if (!focus) return;
    view.lookAt(focus.hex);
    if (opening) {
      view.swoop(170, 1.3, -0.7, 4.5);
      over.open(focus.hex, 3.6, 0.5);
    } else over.open(focus.hex, 1.5);
  }, [world, chart]);
  useEffect(() => layer.current?.setPicked(picked), [picked, world]);
  useEffect(() => layer.current?.setHovered(hovered), [hovered, world]);
  useEffect(() => layer.current?.setPath(path), [path]);

  // What is written under the places follows the map, and the window follows the camera: every frame, outside of state.
  useEffect(() => {
    let raf = 0;
    const place = () => {
      raf = requestAnimationFrame(place);
      const view = renderer.current;
      const { near: all, centre: mid } = at.current;
      if (!view || !mid) return;
      if (view.revealed) setOnScreen(true);
      const z = uiZoom();
      for (const n of all) {
        const el = tags.current.get(n.id);
        if (!el) continue;
        const p = view.screenOf(n.hex);
        el.style.visibility = p?.on ? "" : "hidden";
        if (p) el.style.transform = `translate(${Math.round(p.x / z)}px, ${Math.round(p.y / z)}px)`;
      }
      // The panel of the place picked stands to its right, or to its left where there is no room, and is kept on the screen.
      const box = panel.current;
      if (box && pickedHex.current) {
        const p = view.screenOf(pickedHex.current, 0.4);
        const wide = (root.current?.clientWidth ?? innerWidth) / z;
        const tall = (root.current?.clientHeight ?? innerHeight) / z;
        box.style.visibility = p?.on ? "" : "hidden";
        if (p) {
          const [x, y] = [p.x / z, p.y / z];
          const left = x + PANEL_OUT + box.offsetWidth > wide - PANEL_EDGE && x - PANEL_OUT - box.offsetWidth > PANEL_EDGE;
          const top = Math.max(PANEL_EDGE, Math.min(tall - box.offsetHeight - PANEL_EDGE, y - box.offsetHeight / 2));
          box.style.transform = `translate(${Math.round(left ? x - PANEL_OUT - box.offsetWidth : x + PANEL_OUT)}px, ${Math.round(top)}px)`;
          box.classList.toggle("left", left);
        }
      }
      // From far enough up, what is written would run together: it is put away.
      const [p0, p1] = [view.screenOf(mid), view.screenOf({ q: mid.q + ATLAS_SPACING, r: mid.r })];
      if (p0 && p1) root.current?.classList.toggle("crowded", Math.hypot(p1.x - p0.x, p1.y - p0.y) / z < CROWDED_PX);
      // The camera has travelled: the world goes on, so it is given the window round where it is now.
      const looking = view.focus();
      if (hexDistance(looking, mid) > DRIFT) setCentre(looking);
    };
    raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---------- what is done with a place ----------

  const node = byId.get(picked ?? "");
  const shown = known(node) ? node : null;
  pickedHex.current = shown?.hex ?? null;
  const level = me.character?.level ?? 1;
  const cleared = nodes.filter((n) => n.state === "cleared").length;
  const furthest = Math.max(0, ...nodes.filter((n) => n.state === "cleared").map((n) => n.ring));
  /** The lodestone put into the slot of the place picked, out of the pack: not spent until someone sets out. */
  const [slotted, setSlotted] = useState<Lodestone | null>(null);
  useEffect(() => setSlotted(null), [picked]);
  /** The sea bag is open beside the atlas: a lodestone is dragged (or shift-clicked) from it into the slot of the place picked. */
  const [bag, setBag] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
      if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key.toLowerCase() === "b" || e.key.toLowerCase() === "i")) setBag((open) => !open);
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
  /** The lodestone pointed at, in the slot or the pack: what it carries is told while it is. */
  const [over, setOver] = useState<Lodestone | null>(null);
  useEffect(() => {
    setOver(null);
    setError(null);
  }, [picked]);
  const held = me.lodestones ?? [];
  /** The stone in the slot is still one the hero holds (it may have been spent elsewhere meanwhile). */
  const inSlot = slotted && held.some((h) => stoneKey(h.stone) === stoneKey(slotted)) ? slotted : null;
  /** Whether the place picked has a map being fought through already: its slot is filled, or was never needed, and is shut. */
  const begun = !!shown?.zone;
  /** What the place carries: its own, and what the lodestone in its slot adds (the one its map was made with, or the one put in now). */
  const carried = shown ? stoneOn(shown, (begun ? shown.stone : inSlot) ?? []) : { mods: [], added: [] };
  const needs = !!shown && shown.state === "open" && needsStone(shown);
  // The harder the map, the better it pays; and its boons are a share more of that.
  const sum = modsOf({ mods: carried.mods });
  const pay = shown && shown.kind !== "harbor" ? bountyPay(atlasTier(shown), sum.pay, sum) : null;
  const remember = (id: string | null) => {
    try {
      if (id) sessionStorage.setItem(FOCUS_KEY, id);
      else sessionStorage.removeItem(FOCUS_KEY);
    } catch {
      // Storage is off: coming back lands on the Harbor.
    }
  };
  const setOut = async (n: Known) => {
    setBusy(true);
    setError(null);
    try {
      const { code } = await api.openNode(n.id, n.zone || !inSlot ? undefined : stoneKey(inSlot));
      remember(n.id);
      // The stone is gone from the pack.
      void refresh();
      location.hash = `zone/${code}`;
    } catch (e) {
      setError((e as Error).message);
      void load();
    } finally {
      setBusy(false);
    }
  };
  const dev = async (op: "clear" | "reset" | "stone", id?: string) => {
    setBusy(true);
    setError(null);
    try {
      take(await api.devAtlas(op, id));
      if (op === "reset") setPicked(null);
      // A lodestone found goes into the pack.
      if (op === "stone") await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const show = (n: ChartNode) => renderer.current?.lookAt(n.hex);
  const close = () => {
    remember(null);
    onLeave();
  };

  return (
    <div className={`run atlas-view ${hovered ? "pointing" : ""} ${opening ? "opening" : ""}`} ref={root}>
      <div className="stage" ref={mount} />
      <div className="atlas-vignette" aria-hidden />
      {opening && onScreen && (
        <div className="atlas-opening" aria-hidden>
          <span className="atlas-opening-title">The Atlas</span>
          <span className="atlas-opening-sub">{me.crew?.name ?? "The crew"}'s world</span>
        </div>
      )}

      <div className="atlas-tags" aria-hidden>
        {near.filter(known).map((n) => (
          <div key={n.id} className="atlas-tag-at" ref={(el) => { if (el) tags.current.set(n.id, el); else tags.current.delete(n.id); }}>
            <div className={`atlas-tag is-${n.state} is-${n.kind} ${picked === n.id ? "picked" : ""} ${hovered === n.id ? "pointed" : ""}`}>
              <span className="atlas-name">{n.name}</span>
              {n.state === "open" && (
                <span className="atlas-glance">
                  <span className="atlas-level">Lv {n.level}</span>
                  {n.kind === "lair" && <span className="atlas-what lair">Lair</span>}
                  {n.kind === "lookout" && <span className="atlas-what lookout">Lookout</span>}
                  {stoneOn(n, n.stone ?? []).mods.map((id) => <i key={id} className={modEffect(id).kind} />)}
                  {n.zone && <span className="atlas-there">{n.here?.length ? `${n.here.length} there` : "begun"}</span>}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      <header className="atlas-top">
        <div className="atlas-heading">
          <span className="win-plate atlas-title">The Atlas</span>
          {chart && <span className="atlas-reckoning">{cleared === 0 ? "Nothing cleared yet" : `${cleared} cleared · ${furthest} ${furthest === 1 ? "ring" : "rings"} out`}</span>}
          {!shown && (error ?? unreached) && <span className="atlas-reckoning bad" role="alert">{error ?? unreached}</span>}
          {!chart && !unreached && <span className="atlas-reckoning">Unrolling the atlas…</span>}
        </div>
        <button className="atlas-close" onClick={close} title="Back down to the Harbor, at the lighthouse">Close atlas</button>
        <div className="atlas-corner">
          <button className="small" onClick={() => { const home = byId.get(ATLAS_HOME); if (home) show(home); }} title="Bring the Harbor back to the middle">Find the Harbor</button>
          <button className="small" onClick={() => setBag((open) => !open)} title="Your sea bag (I): drag a lodestone from it into a place's slot">{bag ? "Close the bag" : "Sea bag"}</button>
          {me.devTools && chart && <button className="small" disabled={busy} onClick={() => void dev("stone")}>Dev: find a lodestone</button>}
          {me.devTools && chart && <button className="small" disabled={busy} onClick={() => void dev("reset")}>Dev: wipe the atlas</button>}
        </div>
      </header>

      {/* The sea bag, beside the atlas: a lodestone goes from it into the slot of the place picked. */}
      {bag && me.character && (
        <InventoryScreen
          me={me}
          refresh={refresh}
          onClose={() => setBag(false)}
          stones={{
            put: (stone) => setSlotted(stone),
            blocked: () => (!shown || shown.kind === "harbor" || shown.state !== "open" ? "Pick a place on the atlas that is open to you first: its slot takes the stone." : begun ? "The crew has set out for it already: its slot is shut." : undefined),
          }}
        />
      )}

      {/* The place picked: a small panel beside it, that goes with it as the map moves. */}
      {shown && (
        <div className="atlas-panel-at" ref={panel}>
          <section className="atlas-panel panel" aria-live="polite" aria-label={shown.name}>
            <button className="atlas-panel-shut" onClick={() => setPicked(null)} aria-label="Put it away" title="Put it away">×</button>
            <h3>{shown.name}</h3>
            {shown.kind === "harbor" ? (
              <>
                <p className="atlas-line muted">Home. Every route starts here.</p>
                <p className="atlas-go"><button className="primary" onClick={close}>Go back down</button></p>
              </>
            ) : (
              <>
                <p className="atlas-line">
                  {shown.kind === "lair" ? <span className="atlas-what lair" title={`Something big has made its den here, with others for company. It pays as a place ${LAIR_RINGS} rings further out would.`}>Lair</span>
                    : shown.kind === "lookout" ? <span className="atlas-what lookout" title="High, broken ground. Clearing it lifts the cloud far round it.">Lookout</span>
                    : shown.kind === "seacave" ? <span className="atlas-what cave" title="Dark inside, with chests to open and a hoard at the bottom. It is cleared when the last of them is open.">Sea cave</span>
                    : null}
                  {shown.state === "open" && <strong className={shown.level > level + 1 ? "bad" : shown.level < level ? "good" : "atlas-even"} title={`What is there is level ${shown.level}; you are level ${level}`}>Level {shown.level}</strong>}
                  <span className={`atlas-clime ${shown.clime}`} title={GROUND[shown.biome]}>{CLIME[shown.clime]}</span>
                  {/* What is odd about the place itself, told by pointing at each. */}
                  {shown.state === "open" && shown.mods.length > 0 && (
                    <span className="atlas-own">
                      {shown.mods.map((id) => <i key={id} className={modEffect(id).kind} title={`${modName(id)}: ${modEffect(id).blurb}`} />)}
                    </span>
                  )}
                </p>
                {shown.state === "cleared" ? (
                  <p className="good">Cleared. The routes beyond it are open.</p>
                ) : (
                  <>
                    <div className={`atlas-slot-row ${begun ? "shut" : ""}`}>
                      {/* The place's one slot. A stone dragged or clicked from the pack beside it goes in; a click takes it out again. */}
                      <button
                        type="button"
                        data-stone-slot
                        className={`atlas-slot ${inSlot || (begun && shown.stone) ? "filled" : ""} ${needs && !inSlot && !begun ? "wanting" : ""}`}
                        aria-disabled={begun || !inSlot}
                        aria-label={begun ? "The slot is shut: the map is made" : inSlot ? `${stoneName(inSlot)}: take it out again` : "An empty slot for a lodestone"}
                        onClick={() => !begun && setSlotted(null)}
                        onMouseEnter={() => setOver(begun ? (shown.stone ?? null) : inSlot)}
                        onMouseLeave={() => setOver(null)}
                        onDragOver={(e) => { if (!begun) e.preventDefault(); }}
                        onDrop={(e) => {
                          e.preventDefault();
                          const found = held.find((h) => stoneKey(h.stone) === e.dataTransfer.getData("text/lodestone"));
                          if (found && !begun) setSlotted(found.stone);
                        }}
                      >
                        {begun
                          ? shown.stone && <Icon name={STONE_ICON(shown.stone.length).name} color={STONE_ICON(shown.stone.length).color} size={40} />
                          : inSlot && <Icon name={STONE_ICON(inSlot.length).name} color={STONE_ICON(inSlot.length).color} size={40} />}
                      </button>
                      {begun ? (
                        <span className="muted">{shown.here?.length ? `${shown.here.join(", ")} ${shown.here.length === 1 ? "is" : "are"} there.` : "The crew has set out."}</span>
                      ) : (
                        <div className="atlas-pack">
                          {held.map(({ stone, qty }) => {
                            const key = stoneKey(stone);
                            const icon = STONE_ICON(stone.length);
                            return (
                              <button
                                key={key}
                                type="button"
                                className={`atlas-pack-stone ${inSlot && stoneKey(inSlot) === key ? "chosen" : ""}`}
                                draggable
                                aria-label={`${stoneName(stone)}, ${qty} in your pack: put it into the slot`}
                                onDragStart={(e) => e.dataTransfer.setData("text/lodestone", key)}
                                onClick={() => setSlotted(inSlot && stoneKey(inSlot) === key ? null : stone)}
                                onMouseEnter={() => setOver(stone)}
                                onMouseLeave={() => setOver(null)}
                              >
                                <Icon name={icon.name} color={icon.color} size={30} />
                                <span className="atlas-pack-qty">{qty}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    {!begun && !inSlot && <p className="atlas-line muted">{!needs ? "No lodestone needed beside the Harbor." : held.length > 0 ? "Put a lodestone in the slot to set out." : "It takes a lodestone, and you carry none. One can be cut at the stonecutter's bench in the Harbor."}</p>}
                    {pay && <p className="atlas-line atlas-bounty" title={pay.gear >= 1 ? "With a piece of gear" : `And a ${Math.round(pay.gear * 100)}% chance of a piece of gear`}>Bounty <strong>{pay.xp} XP</strong> · <strong>{pay.gold[0]}–{pay.gold[1]} gold</strong></p>}
                    {error && <p className="bad" role="alert">{error}</p>}
                    <p className="atlas-go">
                      <button className="primary" disabled={busy || (!begun && needs && !inSlot)} onClick={() => void setOut(shown)}>{begun ? "Join them" : "Set out"}</button>
                      {me.devTools && <button className="small" disabled={busy} onClick={() => void dev("clear", shown.id)}>Dev: clear it</button>}
                    </p>
                  </>
                )}
              </>
            )}
            {/* What the lodestone pointed at carries: beside the panel, while it is pointed at. */}
            {over && shown.kind !== "harbor" && (
              <aside className="atlas-stone-card panel">
                <strong>{stoneName(over)}</strong>
                {over.length === 0 ? (
                  <p className="muted">Carries nothing: it opens the place, and changes nothing about it.</p>
                ) : (
                  <ul>
                    {over.map((id) => {
                      const takes = begun || stoneOn(shown, over).added.includes(id);
                      return (
                        <li key={id} className={`${modEffect(id).kind} ${takes ? "" : "spent"}`}>
                          <strong>{modName(id)}</strong> <span className="muted">· {modSide(id)}{takes ? "" : " · will not take here"}</span>
                          <br />
                          <span className="small-note">{modEffect(id).blurb}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </aside>
            )}
          </section>
        </div>
      )}

    </div>
  );
}
