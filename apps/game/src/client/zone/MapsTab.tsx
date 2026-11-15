// The dev toolbox's Maps tab: make a zone to try fights in and walk into
// it, and, while one is on screen, set up whatever is being tested: put an
// enemy group down, paint the ground, add a stand-in crewmate, heal up,
// end the fight, stop the enemy taking turns, show how far each group sees.
//
// Making a map is a dev route (worker.ts, /api/dev/zone); everything done
// to an open one is a dev action over its socket (zoneDev.ts), which the
// server refuses outside a development deployment.

import { useState } from "react";
import { DEFAULT_ZONE_OPTIONS, ENEMIES, HERO_CLASSES, SURFACE_INFO, type SurfaceKind, type ZoneBiome, type ZoneSize } from "@gantt-quest/world";
import { api, PROFILE } from "../api";
import { setZoneDev, useZoneDev } from "./zoneDev";

const SIZES: ZoneSize[] = ["small", "medium", "large"];
const BIOMES: ZoneBiome[] = ["meadow", "woods", "caves", "shore"];
const SURFACES = Object.keys(SURFACE_INFO) as SurfaceKind[];
const KINDS = Object.keys(ENEMIES);
const LEVELS = ["none", "a little", "some", "a lot"];
const OPTIONS_KEY = "gq.dev.zone";

const recall = (): Record<string, unknown> => {
  try {
    return JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "{}");
  } catch {
    return {};
  }
};

export function MapsTab() {
  const dev = useZoneDev();
  const [options, setOptions] = useState(() => ({ ...DEFAULT_ZONE_OPTIONS, lead: "", seed: "", ...recall() }));
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [spawn, setSpawn] = useState({ kind: "wolf", count: 2 });
  const [paint, setPaint] = useState<{ surface: SurfaceKind | "clear"; wide: boolean }>({ surface: "poison", wide: true });
  const [standIn, setStandIn] = useState(HERO_CLASSES[0].id);
  const set = (change: Partial<typeof options>) => {
    const next = { ...options, ...change };
    setOptions(next);
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(next));
    } catch {
      // Blocked storage: the choices last until the page is closed.
    }
  };

  const generate = () => {
    setBusy(true);
    const { lead, seed, ...rest } = options;
    api
      .devZone({ ...rest, kinds: lead ? [lead] : [], seed: seed.trim() || undefined })
      .then(({ code, seed: used }) => {
        setSaid({ text: `Map ${code}, from seed "${used}". Walking in.` });
        location.hash = `zone/${code}`;
      })
      .catch((err: Error) => setSaid({ text: err.message, bad: true }))
      .finally(() => setBusy(false));
  };
  const number = (key: "groups" | "clear" | "party", min: number, max: number, label: string) => (
    <label>
      {label}
      <input type="number" min={min} max={max} value={options[key]} onChange={(e) => set({ [key]: Math.max(min, Math.min(max, Number(e.target.value) || min)) })} />
    </label>
  );
  const level = (key: "elevation" | "obstacles", label: string) => (
    <label>
      {label}
      <select value={options[key]} onChange={(e) => set({ [key]: Number(e.target.value) })}>
        {LEVELS.map((name, i) => <option key={i} value={i}>{name}</option>)}
      </select>
    </label>
  );
  const send = dev.open?.send;
  const tool = dev.tool;
  const link = dev.open ? `${location.origin}${location.pathname}?p=${PROFILE === "2" ? "3" : "2"}#zone/${dev.open.code}` : "";

  return (
    <fieldset className="dev-seed dev-maps" disabled={busy}>
      <p><strong>Make a map</strong> <span className="muted">and walk into it. The start is open ground; the enemy stand beyond it.</span></p>
      <div className="dev-row">
        <label>
          Size
          <select value={options.size} onChange={(e) => set({ size: e.target.value as ZoneSize })}>{SIZES.map((s) => <option key={s}>{s}</option>)}</select>
        </label>
        <label>
          Ground
          <select value={options.biome} onChange={(e) => set({ biome: e.target.value as ZoneBiome })}>{BIOMES.map((b) => <option key={b}>{b}</option>)}</select>
        </label>
      </div>
      <div className="dev-row">
        {number("groups", 0, 6, "Enemy groups")}
        <label>
          Led by
          <select value={options.lead} onChange={(e) => set({ lead: e.target.value })}>
            <option value="">whatever suits</option>
            {KINDS.filter((k) => k !== "dummy").map((k) => <option key={k} value={k}>{ENEMIES[k].name}</option>)}
            <option value="dummy">{ENEMIES.dummy.name}</option>
          </select>
        </label>
        {number("party", 1, 4, "Sized for")}
      </div>
      <div className="dev-row">
        {level("elevation", "High ground")}
        {level("obstacles", "Clutter")}
        {number("clear", 2, 8, "Open start")}
      </div>
      <div className="dev-row">
        <label>
          Seed
          <input value={options.seed} placeholder="a new one each time" onChange={(e) => set({ seed: e.target.value })} />
        </label>
        <button className="small primary" onClick={generate}>Make it and walk in</button>
      </div>

      {dev.open && send && (
        <>
          <p><strong>Map {dev.open.code}</strong> <span className="muted">is on screen.</span></p>
          <div className="dev-row">
            <button className="small" onClick={() => send({ op: "heal" })}>Heal and restock everyone</button>
            <button className="small" onClick={() => send({ op: "end_fight" })}>End the fight</button>
            <button className="small" onClick={() => send({ op: "clear_surfaces" })}>Clear the ground</button>
          </div>
          <div className="dev-row">
            <label><input type="checkbox" onChange={(e) => send({ op: "ai", off: e.target.checked })} /> Enemy takes no turns</label>
            <label><input type="checkbox" checked={dev.showAlert} onChange={(e) => setZoneDev({ showAlert: e.target.checked })} /> Show where each group can see</label>
          </div>
          <div className="dev-row">
            <label>
              Enemy
              <select value={spawn.kind} onChange={(e) => setSpawn({ ...spawn, kind: e.target.value })}>{KINDS.map((k) => <option key={k} value={k}>{ENEMIES[k].name}</option>)}</select>
            </label>
            <label>
              How many
              <input type="number" min={1} max={6} value={spawn.count} onChange={(e) => setSpawn({ ...spawn, count: Math.max(1, Math.min(6, Number(e.target.value) || 1)) })} />
            </label>
            <button className={`small ${tool?.tool === "spawn" ? "selected" : ""}`} onClick={() => setZoneDev({ tool: tool?.tool === "spawn" ? null : { tool: "spawn", kinds: Array.from({ length: spawn.count }, () => spawn.kind) } })}>
              {tool?.tool === "spawn" ? "Done placing" : "Place a group: click the map"}
            </button>
          </div>
          <div className="dev-row">
            <label>
              Ground
              <select value={paint.surface} onChange={(e) => setPaint({ ...paint, surface: e.target.value as SurfaceKind | "clear" })}>
                {SURFACES.map((s) => <option key={s} value={s}>{SURFACE_INFO[s].name}</option>)}
                <option value="clear">Clear it</option>
              </select>
            </label>
            <label><input type="checkbox" checked={paint.wide} onChange={(e) => setPaint({ ...paint, wide: e.target.checked })} /> a hex and those round it</label>
            <button className={`small ${tool?.tool === "paint" ? "selected" : ""}`} onClick={() => setZoneDev({ tool: tool?.tool === "paint" ? null : { tool: "paint", surface: paint.surface === "clear" ? null : paint.surface, wide: paint.wide } })}>
              {tool?.tool === "paint" ? "Done painting" : "Paint: click the map"}
            </button>
          </div>
          <div className="dev-row">
            <label>
              Stand-in crewmate
              <select value={standIn} onChange={(e) => setStandIn(e.target.value)}>{HERO_CLASSES.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            </label>
            <button className="small" onClick={() => send({ op: "standin", classId: standIn })}>Add one beside you</button>
          </div>
          <p className="muted">A second player: open <a href={link} target="_blank" rel="noreferrer">this link</a> in another window. Stand-ins are yours to play on their turns.</p>
        </>
      )}
      <p className={`dev-said ${said?.bad ? "bad" : "muted"}`} role="status">{said?.text}</p>
    </fieldset>
  );
}
