// Inside a hut: a small room drawn by the same renderer as the Harbor, where
// everyone present sees each other and the furniture. The owner furnishes it
// from the Furnish panel; a visiting crewmate can only look.

import { useEffect, useMemo, useRef, useState } from "react";
import type { HexPos } from "@gantt-quest/core";
import { FURNISHINGS, HERO_CLASSES, hutRoom, hutTier, placedFurnishings, poiAt, type Furnishing } from "@gantt-quest/world";
import type { Me } from "./api";
import { DragPanel } from "./DragPanel";
import { WorldRenderer, type RenderState } from "./render/WorldRenderer";
import { useHut } from "./useHut";
import "./hut.css";

const className = (id: string) => HERO_CLASSES.find((c) => c.id === id)?.name ?? id;
const same = (a: HexPos, b: HexPos) => a.q === b.q && a.r === b.r;
const defOf = (f: Furnishing) => FURNISHINGS[f.defId];

export function HutView({ ownerId, me, onLeave }: { ownerId: string; me: Me; onLeave(): void }) {
  const mount = useRef<HTMLDivElement>(null);
  const renderer = useRef<WorldRenderer | null>(null);
  const [hover, setHover] = useState<HexPos | null>(null);
  const [text, setText] = useState("");
  /** A furnishing picked up to be put down on the next floor hex clicked. */
  const [holding, setHolding] = useState<number | null>(null);
  /** The placed furnishing whose controls are showing. */
  const [selected, setSelected] = useState<number | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);

  const hut = useHut(ownerId, (id, path) => renderer.current?.playEvents([{ t: "moved", heroId: id, path }]));
  const { you, players, furnishings, canEdit, tier, owner } = hut;
  const room = useMemo(() => (tier === null ? null : hutRoom(tier)), [tier]);
  const placed = useMemo(() => placedFurnishings(furnishings), [furnishings]);
  const stored = furnishings.filter((f) => f.q === null);
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
      heroes: players.map((p) => ({ id: p.id, classId: p.classId, pos: p.pos, label: p.name, outfit: p.outfit })),
      turn: null,
      battle: null,
      story: null,
      npcs: {},
      freeRoam: true,
      indoors: true,
      props: placed.map((f) => ({ id: f.id, model: defOf(f)?.model ?? f.defId, pos: { q: f.q, r: f.r }, facing: f.facing, selected: f.id === selected || f.id === holding })),
    };
  }, [ownerId, tier, room, players, you, placed, selected, holding]);
  const latest = useRef(scene);
  latest.current = scene;

  // The renderer is created once; its click handler reads the current state through this ref.
  const click = useRef<(pos: HexPos) => void>(() => {});
  click.current = (pos) => {
    const piece = placed.find((f) => same({ q: f.q, r: f.r }, pos));
    if (canEdit && holding !== null) {
      // Clicking the piece being moved puts it back where it was.
      if (piece?.id !== holding) hut.send({ type: "place", id: holding, to: pos });
      setSelected(holding);
      setHolding(null);
    } else if (canEdit && piece) {
      setSelected(piece.id);
    } else {
      setSelected(null);
      hut.send({ type: "move", to: pos });
    }
  };

  useEffect(() => {
    const r = new WorldRenderer(mount.current!, { onHexClick: (pos) => click.current(pos), onHover: setHover });
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
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (setHolding(null), setSelected(null));
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Dev-only handle for driving the hut from the console or a test script.
  if (import.meta.env.DEV) (window as unknown as { __hut: unknown }).__hut = { hut };

  const mine = ownerId === me.player.id;
  const title = mine ? "Your hut" : owner ? `${owner.name}'s hut` : "A hut";
  const self = players.find((p) => p.id === you);
  const atDoor = !!self && !!room && poiAt(room, self.pos)?.kind === "door";
  const hoverPiece = hover ? placed.find((f) => same({ q: f.q, r: f.r }, hover)) : undefined;
  const tip = hoverPiece ? hoverPiece.label : hover && room && poiAt(room, hover)?.kind === "door" ? "The door" : null;
  const say = () => {
    if (!text.trim()) return;
    hut.send({ type: "say", text });
    setText("");
  };
  const pick = (id: number) => {
    setSelected(null);
    setHolding((h) => (h === id ? null : id));
  };

  return (
    <div className="run hut-view">
      <div className="stage" ref={mount} />
      <div className="topbar">
        <strong>{title}</strong>
        {tier !== null && <span className="muted">{hutTier(tier).name}</span>}
        <span className="spacer" />
        {hut.status !== "open" && !hut.error && <span className="bad">connecting…</span>}
        <button className="small" onClick={onLeave}>Leave</button>
      </div>

      {canEdit && (
        <DragPanel id="hut.furnish" title="Furnish" foldOnPhone className="story panel hut-furnish">
          {chosen ? (
            <div className="hut-chosen">
              <strong>{chosen.label}</strong>
              <p className="muted">{defOf(chosen)?.blurb}</p>
              <div className="row">
                <button className="small" onClick={() => hut.send({ type: "rotate", id: chosen.id })}>Rotate</button>
                <button className="small" onClick={() => pick(chosen.id)}>Move</button>
                <button className="small" onClick={() => (hut.send({ type: "pick_up", id: chosen.id }), setSelected(null))}>Put away</button>
              </div>
            </div>
          ) : held ? (
            <p className="hut-hint">Click a floor hex to put the <strong>{held.label}</strong> down. <button className="link" onClick={() => setHolding(null)}>Cancel</button></p>
          ) : (
            <p className="muted">Pick something from storage, then click a floor hex. Click a placed piece to turn it or put it away.</p>
          )}
          {hut.refused && <p className="bad">{hut.refused}</p>}

          <h3>In storage</h3>
          {stored.length === 0 && <p className="muted">Nothing in storage.</p>}
          <ul className="hut-list">
            {stored.map((f) => (
              <li key={f.id}>
                <button className={holding === f.id ? "selected" : ""} title={defOf(f)?.blurb} onClick={() => pick(f.id)}>
                  {f.label}{defOf(f)?.kind === "trophy" && <span className="tag">trophy</span>}
                </button>
              </li>
            ))}
          </ul>

          <h3>In the room</h3>
          {placed.length === 0 && <p className="muted">Nothing placed yet.</p>}
          <ul className="hut-list">
            {placed.map((f) => (
              <li key={f.id}>
                <button className={selected === f.id || holding === f.id ? "selected" : ""} title={defOf(f)?.blurb} onClick={() => (setHolding(null), setSelected((s) => (s === f.id ? null : f.id)))}>
                  {f.label}
                </button>
              </li>
            ))}
          </ul>
        </DragPanel>
      )}

      {you && <>
      <DragPanel id="hut.crew" title="Inside" foldOnPhone className="crew">
        <div className="panel">
          <h3>{players.length} here now</h3>
          <ul className="roster">
            {players.map((p) => (
              <li key={p.id}>
                <span><i className="dot on" /> <strong>{p.name}</strong>{p.id === you && <span className="tag">you</span>}{p.id === ownerId && p.id !== you && <span className="tag">owner</span>}</span>
                <span className="muted">{className(p.classId)} · {p.level}</span>
              </li>
            ))}
          </ul>
        </div>
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

      <DragPanel id="hut.turn" title="Here" compact className="turnbar panel">
        {atDoor ? <span>The door back to the Harbor.</span>
          : canEdit ? <span className="muted">Click a hex to walk. Furnish the room from the Furnish panel.</span>
          : <span className="muted">Click a hex to walk. Only {owner?.name ?? "the owner"} can move the furniture.</span>}
        <button className={atDoor ? "primary" : ""} onClick={onLeave}>Leave</button>
      </DragPanel>
      </>}

      {tip && <div className="tip">{tip}</div>}
      {hut.error && (
        <div className="hut-refused panel">
          <p>{hut.error}</p>
          <button className="primary" onClick={onLeave}>Back to the Harbor</button>
        </div>
      )}
    </div>
  );
}
