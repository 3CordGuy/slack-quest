// The atlas: the crew's world, as a view of its own. A wide map of hexes
// like the Harbor's, seen from a long way up: seas and their coasts, sand,
// forest, ridges of hills. The Harbor stands in the middle of it; the places
// the crew can go lie round it, joined by routes, and everything far from
// anywhere they know is under fog.
//
// The ground is drawn by the same renderer as every other map
// (WorldRenderer, told the map is `far`). The land itself is worked out here
// from the chart's seed (packages/world/src/atlasMap.ts): the server sends
// only the chart (server/atlas.ts), which is what it decides. Markers, their
// names and the routes between them are laid over the map and follow it as
// the camera moves. Picking a place shows what is known of it; Set out goes
// to its map, and coming back from one lands here again.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hexDistance } from "@gantt-quest/core";
import { ATLAS_HOME, ATLAS_SPACING, ZONE_MODS, atlasWorld, bountyPay, modsOf, onAtlasMap } from "@gantt-quest/world";
import { api, type Chart, type ChartNode, type Me } from "../api";
import { useAudioScene } from "../audio/useAudioScene";
import { WorldRenderer, type RenderState } from "../render/WorldRenderer";
import { uiZoom } from "../uiScale";
import "./atlas.css";

type Known = Extract<ChartNode, { state: "harbor" | "cleared" | "open" }>;
const known = (n: ChartNode | undefined): n is Known => !!n && n.state !== "fogged";
const GROUND: Record<Known["biome"], string> = { meadow: "Open meadow", woods: "Deep woods", shore: "A stretch of shore", caves: "A sea cave" };
/** How often the chart is asked for again: a crewmate may have cleared something. */
const REFRESH_MS = 10_000;
/** Markers lose their names when the places are drawn closer together than this, in pixels. */
const CROWDED_PX = 96;
/** Where a place picked before setting out is remembered, so coming back lands on it. */
const FOCUS_KEY = "gq.atlas.at";

export function AtlasView({ me, onLeave }: { me: Me; onLeave(): void }) {
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
  /** The markers and the routes between them, by id: moved by hand each frame, as the camera is not React's. */
  const marks = useRef(new Map<string, HTMLElement>());
  const lines = useRef(new Map<string, SVGLineElement>());
  useAudioScene("harbor");

  const load = useCallback(() => api.atlas().then((c) => (setChart(c), setError(null)), (e: Error) => setError(e.message)), []);
  useEffect(() => {
    void load();
    const every = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(every);
  }, [load]);

  // ---------- the world ----------

  const nodes = useMemo(() => chart?.nodes ?? [], [chart]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const world = useMemo(() => (chart ? atlasWorld(chart.seed, chart.nodes) : null), [chart]);
  const routes = useMemo(() => {
    const out: { key: string; a: ChartNode; b: ChartNode; kind: "sailed" | "open" | "fog" }[] = [];
    const sailed = (n: ChartNode) => n.state === "harbor" || n.state === "cleared";
    for (const a of nodes) {
      for (const id of a.links) {
        const b = byId.get(id);
        if (!b || a.id >= b.id) continue;
        out.push({ key: `${a.id}|${b.id}`, a, b, kind: a.state === "fogged" || b.state === "fogged" ? "fog" : sailed(a) && sailed(b) ? "sailed" : "open" });
      }
    }
    return out;
  }, [nodes, byId]);

  const pick = useRef<(id: string | null) => void>(() => {});
  pick.current = setPicked;
  const at = useRef({ world, nodes });
  at.current = { world, nodes };
  useEffect(() => {
    const view = new WorldRenderer(mount.current!, {
      // A click on the ground picks the place standing there (or beside it), or puts the card away.
      onHexClick: (pos) => {
        const { world: w, nodes: all } = at.current;
        if (!w) return;
        const near = all.filter(known).map((n) => ({ n, d: hexDistance(onAtlasMap(w, n.hex), pos) })).sort((a, b) => a.d - b.d)[0];
        pick.current(near && near.d <= 1 ? near.n.id : null);
      },
      onHover: () => {},
    });
    renderer.current = view;
    return () => {
      renderer.current = null;
      view.dispose();
    };
  }, []);

  /** The window's place in the world: when it shifts (more has been cleared), the map is a new one to the renderer. */
  const frame = world ? `${world.origin.q},${world.origin.r}:${world.map.grid.cols}x${world.map.grid.rows}` : "";
  const looked = useRef("");
  useEffect(() => {
    const view = renderer.current;
    if (!view || !world || !chart) return;
    const scene: RenderState = {
      code: `atlas:${chart.seed}:${frame}`,
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
    // A new map opens on the place last picked, or on the Harbor.
    if (looked.current !== frame) {
      looked.current = frame;
      const focus = byId.get(picked ?? "") ?? byId.get(ATLAS_HOME);
      if (focus) view.lookAt(onAtlasMap(world, focus.hex));
    }
  }, [world, chart, frame]);

  // The markers and routes follow the map: placed every frame, outside of state.
  useEffect(() => {
    let raf = 0;
    const place = () => {
      raf = requestAnimationFrame(place);
      const view = renderer.current;
      const { world: w, nodes: all } = at.current;
      if (!view || !w) return;
      const z = uiZoom();
      const where = new Map<string, { x: number; y: number; on: boolean }>();
      for (const n of all) {
        const p = view.screenOf(onAtlasMap(w, n.hex), 0.5);
        if (p) where.set(n.id, p);
        const el = marks.current.get(n.id);
        if (!el) continue;
        el.style.visibility = p?.on ? "visible" : "hidden";
        if (p) el.style.transform = `translate(${Math.round(p.x / z)}px, ${Math.round(p.y / z)}px)`;
      }
      for (const [key, line] of lines.current) {
        const [a, b] = key.split("|").map((id) => where.get(id));
        line.style.visibility = a && b && (a.on || b.on) ? "visible" : "hidden";
        if (!a || !b) continue;
        line.setAttribute("x1", String(a.x / z));
        line.setAttribute("y1", String(a.y / z));
        line.setAttribute("x2", String(b.x / z));
        line.setAttribute("y2", String(b.y / z));
      }
      // From far enough up, the names would run into each other: they are put away.
      const home = all.find((n) => n.id === ATLAS_HOME);
      const [p0, p1] = home ? [view.screenOf(onAtlasMap(w, home.hex)), view.screenOf(onAtlasMap(w, { q: home.hex.q + ATLAS_SPACING, r: home.hex.r }))] : [null, null];
      if (p0 && p1) root.current?.classList.toggle("crowded", Math.hypot(p1.x - p0.x, p1.y - p0.y) / z < CROWDED_PX);
    };
    raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---------- what is done with a place ----------

  const node = byId.get(picked ?? "");
  const shown = known(node) ? node : null;
  const level = me.character?.level ?? 1;
  const cleared = nodes.filter((n) => n.state === "cleared").length;
  const pay = shown && shown.kind !== "harbor" ? bountyPay(Math.max(1, shown.ring), modsOf({ mods: shown.mods }).pay) : null;
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
      const { code } = await api.openNode(n.id);
      remember(n.id);
      location.hash = `zone/${code}`;
    } catch (e) {
      setError((e as Error).message);
      void load();
    } finally {
      setBusy(false);
    }
  };
  const dev = async (op: "clear" | "reset", id?: string) => {
    setBusy(true);
    setError(null);
    try {
      setChart(await api.devAtlas(op, id));
      if (op === "reset") setPicked(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const show = (n: ChartNode) => world && renderer.current?.lookAt(onAtlasMap(world, n.hex));
  const close = () => {
    remember(null);
    onLeave();
  };

  return (
    <div className="run atlas-view" ref={root}>
      <div className="stage" ref={mount} />

      <svg className="atlas-routes" aria-hidden>
        {routes.map((r) => (
          <line key={r.key} className={`route ${r.kind}`} ref={(el) => { if (el) lines.current.set(r.key, el); else lines.current.delete(r.key); }} />
        ))}
      </svg>
      <div className="atlas-marks">
        {nodes.map((n) =>
          known(n) ? (
            <div key={n.id} className="atlas-mark-at" ref={(el) => { if (el) marks.current.set(n.id, el); else marks.current.delete(n.id); }}>
              <button
                type="button"
                className={`atlas-mark ${n.state} ${n.kind} ${n.zone ? "busy" : ""} ${picked === n.id ? "picked" : ""}`}
                aria-label={`${n.name}${n.state === "open" ? `, open, level ${n.level}` : n.state === "cleared" ? ", cleared" : ""}`}
                aria-pressed={picked === n.id}
                title={n.name}
                onClick={() => setPicked((was) => (was === n.id ? null : n.id))}
              >
                {n.mods.length > 0 && n.state === "open" && (
                  <span className="atlas-pips" aria-hidden>
                    {n.mods.map((id) => <i key={id} className={ZONE_MODS[id].kind} title={ZONE_MODS[id].name} />)}
                  </span>
                )}
                <span className="atlas-orb">
                  {n.state === "open" ? n.level : n.state === "cleared" ? "✓" : "⚓"}
                  {n.zone && <span className="atlas-there" title={n.here?.length ? `${n.here.join(", ")} ${n.here.length === 1 ? "is" : "are"} there` : "Being fought through"}>{n.here?.length || "!"}</span>}
                </span>
                <span className="atlas-name">{n.name}</span>
              </button>
            </div>
          ) : (
            <div key={n.id} className="atlas-mark-at" aria-hidden ref={(el) => { if (el) marks.current.set(n.id, el); else marks.current.delete(n.id); }}>
              <span className="atlas-mark fogged"><span className="atlas-orb">?</span></span>
            </div>
          ),
        )}
      </div>

      <header className="atlas-top">
        <span className="win-plate atlas-title">The Atlas</span>
        <button className="atlas-close" onClick={close} title="Back to the Harbor">Close atlas</button>
      </header>

      <aside className="atlas-card panel" aria-live="polite">
        {error && <p className="bad" role="alert">{error}</p>}
        {!chart && !error && <p className="muted">Unrolling the atlas…</p>}
        {chart && !shown && (
          <>
            <h3>{me.crew?.name ?? "The crew"}'s world</h3>
            <p className="muted">Pick a place to see what is known of it. A route runs to the bright ones: from the Harbor, or from somewhere the crew has cleared.</p>
            <p className="muted">Clearing a place opens the ones its routes lead on to, and lifts the fog round it. Further out is more dangerous, and pays better.</p>
            <p className="atlas-tally">{cleared === 0 ? "Nothing cleared yet." : `${cleared} cleared.`}</p>
          </>
        )}
        {shown && shown.kind === "harbor" && (
          <>
            <h3>The Harbor</h3>
            <p className="muted">Home. Every route starts here.</p>
            <p className="atlas-tally">{cleared === 0 ? "Nothing cleared yet." : `${cleared} cleared.`}</p>
            <p className="atlas-go"><button className="primary" onClick={close}>Go back there</button></p>
          </>
        )}
        {shown && shown.kind !== "harbor" && (
          <>
            <h3>{shown.name}</h3>
            <p className="atlas-kind">
              {GROUND[shown.biome]} <span className="muted">· {shown.ring} {shown.ring === 1 ? "ring" : "rings"} out</span>
            </p>
            {shown.state === "cleared" ? (
              <p className="good">Cleared. The routes beyond it are open.</p>
            ) : (
              <>
                <p>
                  What is there is <strong className={shown.level > level + 1 ? "bad" : shown.level < level ? "good" : "atlas-even"}>level {shown.level}</strong>
                  <span className="muted"> · you are level {level}</span>
                </p>
                {shown.kind === "seacave" && <p className="muted">Dark inside, with chests to open and a hoard at the bottom. It is cleared when the last of them is open.</p>}
                {shown.mods.length > 0 ? (
                  <ul className="atlas-mods">
                    {shown.mods.map((id) => (
                      <li key={id} className={ZONE_MODS[id].kind}>
                        <strong>{ZONE_MODS[id].name}</strong> <span className="muted">· {ZONE_MODS[id].kind === "map" ? "the ground" : "the enemy"}</span>
                        <br />
                        <span className="small-note">{ZONE_MODS[id].blurb}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">Nothing out of the ordinary about it.</p>
                )}
                {pay && (
                  <p className="atlas-pay">
                    Clearing it pays everyone there <strong>{pay.xp} XP</strong> and <strong>{pay.gold[0]} to {pay.gold[1]} gold</strong>
                    {pay.gear >= 1 ? ", with a piece of gear." : `, and a ${Math.round(pay.gear * 100)}% chance of a piece of gear.`}
                  </p>
                )}
                {shown.zone && <p className="atlas-even">{shown.here?.length ? `${shown.here.join(", ")} ${shown.here.length === 1 ? "is" : "are"} there now.` : "The crew has gone in there already."}</p>}
                <p className="atlas-go">
                  <button className="primary" disabled={busy} onClick={() => void setOut(shown)}>{shown.zone ? "Join them" : "Set out"}</button>
                  <button className="small" onClick={() => show(shown)}>Show it</button>
                </p>
              </>
            )}
            {me.devTools && shown.state === "open" && <p><button className="small" disabled={busy} onClick={() => void dev("clear", shown.id)}>Dev: clear it</button></p>}
          </>
        )}
        {me.devTools && chart && <p className="atlas-dev"><button className="small" disabled={busy} onClick={() => void dev("reset")}>Dev: wipe the atlas</button></p>}
      </aside>
    </div>
  );
}
