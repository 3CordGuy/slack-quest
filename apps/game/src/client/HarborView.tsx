// The crew's shared Harbor: a walkable place where everyone present sees
// each other. Ships are moored and boarded at the docks, each member has a
// hut, and the notice board keeps the crew roster and voyage log.

import { useEffect, useMemo, useRef, useState } from "react";
import type { HexPos } from "@gantt-quest/core";
import { HARBOR_PIERS, HARBOR_PLOTS, HERO_CLASSES, MAX_PARTY, generateHarbor, harborPoi, poiAt, type HarborShip } from "@gantt-quest/world";
import { api, type Me } from "./api";
import { Sheet, useAct } from "./Harbor";
import { WorldRenderer, type RenderState } from "./render/WorldRenderer";
import { useHarbor } from "./useHarbor";

const className = (id: string) => HERO_CLASSES.find((c) => c.id === id)?.name ?? id;
const same = (a: HexPos, b: HexPos) => a.q === b.q && a.r === b.r;

export function HarborView({ me, refresh }: { me: Me; refresh(): Promise<unknown> }) {
  const mount = useRef<HTMLDivElement>(null);
  const renderer = useRef<WorldRenderer | null>(null);
  const [hover, setHover] = useState<HexPos | null>(null);
  const [sheet, setSheet] = useState(false);
  const [copied, setCopied] = useState(false);
  const [text, setText] = useState("");
  const [launchError, setLaunchError] = useState<string | null>(null);
  const { busy, error: actError, act } = useAct(refresh);
  const chatEnd = useRef<HTMLDivElement>(null);

  const harbor = useHarbor((id, path) => renderer.current?.playEvents([{ t: "moved", heroId: id, path }]));
  const send = useRef(harbor.send);
  send.current = harbor.send;
  const base = useMemo(generateHarbor, []);
  const { board, players, you } = harbor;
  const moored = board.ships.filter((s) => s.pier !== null);

  // The Harbor as the renderer sees it: the fixed map plus a hut per member and a ship per moored voyage.
  const scene = useMemo<RenderState | null>(() => {
    if (!you) return null;
    const pois = [
      ...base.pois,
      ...board.members.slice(0, HARBOR_PLOTS.length).map((m, i) => harborPoi(`plot:${m.id}`, "plot", HARBOR_PLOTS[i])),
      ...moored.map((s) => harborPoi(`ship:${s.code}`, "pier", HARBOR_PIERS[s.pier!])),
    ];
    return {
      code: "harbor",
      you,
      phase: "overworld",
      round: 0,
      map: { ...base, pois },
      heroes: players.map((p) => ({ id: p.id, classId: p.classId, pos: p.pos, label: p.name })),
      turn: null,
      battle: null,
      story: null,
      npcs: {},
      freeRoam: true,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, board, players, you]);
  const latest = useRef(scene);
  latest.current = scene;

  useEffect(() => {
    const r = new WorldRenderer(mount.current!, { onHexClick: (to) => send.current({ type: "move", to }), onHover: setHover });
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
  }, [harbor.chat.length]);

  // Dev-only handle for driving the Harbor from the console or a test script.
  if (import.meta.env.DEV) (window as unknown as { __harbor: unknown }).__harbor = { harbor };
  const self = players.find((p) => p.id === you);
  const shipHere = self ? moored.find((s) => same(HARBOR_PIERS[s.pier!], self.pos)) : undefined;
  const plotIndex = self ? HARBOR_PLOTS.findIndex((p) => same(p, self.pos)) : -1;
  const hutOwner = plotIndex >= 0 ? board.members[plotIndex] : undefined;
  const hoverPoi = scene && hover ? poiAt(scene.map, hover) : undefined;
  const tip = !hoverPoi ? null
    : hoverPoi.kind === "board" ? "Notice board"
    : hoverPoi.kind === "plot" ? `${board.members.find((m) => `plot:${m.id}` === hoverPoi.id)?.name ?? "Someone"}'s hut`
    : hoverPoi.kind === "pier" ? `${moored.find((s) => `ship:${s.code}` === hoverPoi.id)?.captain ?? "A"}'s ship`
    : null;

  const board_ = (ship: HarborShip) => (location.hash = `run/${ship.code}`);
  const launch = async () => {
    setLaunchError(null);
    try {
      const { code } = await api.createRun();
      location.hash = `run/${code}`;
    } catch (e) {
      setLaunchError((e as Error).message);
    }
  };
  const invite = harbor.crew ? `${location.origin}${location.pathname}#crew/${harbor.crew.id}` : "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invite);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      prompt("Copy this invite link:", invite);
    }
  };
  const say = () => {
    if (!text.trim()) return;
    harbor.send({ type: "say", text });
    setText("");
  };
  const error = harbor.error ?? actError ?? launchError;

  return (
    <div className="run harbor-view">
      <div className="stage" ref={mount} />
      <div className="topbar">
        <strong>The Harbor</strong>
        <span className="muted">{harbor.crew?.name ?? me.crew?.name}</span>
        <span className="spacer" />
        {harbor.status !== "open" && <span className="bad">connecting…</span>}
        {harbor.crew && <span className="muted">Invite code {harbor.crew.id}</span>}
        <button className="small" onClick={copy}>{copied ? "Copied" : "Copy invite link"}</button>
        <button className="small" onClick={() => setSheet(true)}>
          {me.character?.name}{me.character && me.character.unspent_points > 0 ? " ●" : ""}
        </button>
      </div>

      <div className="story panel docks">
        <h3>Docks</h3>
        {board.ships.length === 0 && <p className="muted">No ships in port. Moor one and your crew can walk aboard.</p>}
        <ul className="ships">
          {board.ships.map((s) => {
            const mine = !!me.character && s.aboard.includes(me.character.name);
            return (
              <li key={s.code}>
                <span>
                  <strong>{s.phase === "lobby" ? `${s.captain}'s ship` : (s.title ?? "Setting out")}</strong>
                  <span className="muted">
                    {" "}{s.phase === "lobby" ? `${s.aboard.length}/${MAX_PARTY} aboard` : `at sea${s.day ? ` · day ${s.day}` : ""}`}
                    {s.aboard.length > 0 && ` · ${s.aboard.join(", ")}`}
                  </span>
                </span>
                {s.phase === "lobby" && (mine || s.aboard.length < MAX_PARTY) && <button className="small" onClick={() => board_(s)}>{mine ? "Return" : "Board"}</button>}
                {s.phase !== "lobby" && mine && <button className="small" onClick={() => board_(s)}>Rejoin</button>}
              </li>
            );
          })}
        </ul>
        <button className="primary" onClick={launch}>Moor a new ship</button>
        <h3>Voyage log</h3>
        {board.log.length === 0 && <p className="muted">No voyages yet.</p>}
        <ul className="log">
          {board.log.map((v) => (
            <li key={v.code}>
              <span className={v.outcome === "victory" ? "good" : "bad"}>{v.outcome === "victory" ? "Won" : "Lost"}</span> <strong>{v.title}</strong>
              <span className="muted"> · {v.crew.join(", ")}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="crew">
        <div className="panel">
          <h3>Crew · {players.length} here</h3>
          <ul className="roster">
            {board.members.map((m) => {
              const here = players.some((p) => p.id === m.id);
              return (
                <li key={m.id} className={here ? "" : "away"}>
                  <span><i className={`dot ${here ? "on" : ""}`} /> <strong>{m.name}</strong>{m.id === you && <span className="tag">you</span>}</span>
                  <span className="muted">{className(m.classId)} · {m.level}</span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <div className="chat panel harbor-chat">
        <div className="chat-lines">
          {harbor.chat.length === 0 && <div className="muted">Crew chat. Only people in the Harbor right now see it.</div>}
          {harbor.chat.map((l, i) => <div key={i} className="line hero"><strong>{l.name}: </strong>{l.text}</div>)}
          <div ref={chatEnd} />
        </div>
        <div className="row">
          <input value={text} maxLength={200} placeholder="Say something to the crew…" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && say()} />
          <button disabled={!text.trim()} onClick={say}>Say</button>
        </div>
      </div>

      <div className="turnbar panel">
        {shipHere ? (
          <>
            <span>{shipHere.captain}'s ship · {shipHere.aboard.length}/{MAX_PARTY} aboard</span>
            <button className="primary" onClick={() => board_(shipHere)}>Walk aboard</button>
          </>
        ) : hutOwner ? (
          <span>{hutOwner.id === you ? "Your hut. Decorating and upgrades are coming." : `${hutOwner.name}'s hut.`}</span>
        ) : (
          <span className="muted">Click a hex to walk. Ships are boarded at the piers.</span>
        )}
      </div>

      {tip && <div className="tip">{tip}</div>}
      {error && <div className="toast">{error}</div>}
      {sheet && me.character && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && setSheet(false)}>
          <div className="sheet-wrap">
            <Sheet character={me.character} inventory={me.inventory} busy={busy} act={act} />
            <div className="row">
              <button onClick={() => setSheet(false)}>Close</button>
              <span className="spacer" />
              <button
                className="danger small"
                disabled={busy}
                onClick={() => {
                  if (confirm("Leave this crew? You can rejoin with its invite code.")) void act(() => api.leaveCrew());
                }}
              >
                Leave crew
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
