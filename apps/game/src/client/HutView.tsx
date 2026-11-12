// Inside a hut: a small room drawn by the same renderer as the Harbor, where
// everyone present sees each other and the furniture. The owner furnishes it
// from the Furnish panel; a visiting crewmate can only look.

import { useEffect, useMemo, useRef, useState } from "react";
import type { HexPos } from "@gantt-quest/core";
import { FURNISHINGS, craftProblem, hutPerks, hutRoom, hutTier, isSmall, nextHutTier, placeProblem, placedFurnishings, poiAt, smallPlaceProblem, upgradeProblem, type Furnishing } from "@gantt-quest/world";
import { api, type Hut, type Me } from "./api";
import { DragPanel } from "./DragPanel";
import { CostChips, PerkMeter, ResourceChips } from "./hutDrops";
import { TileAction } from "./TileAction";
import { WorldRenderer, type PlaceTarget, type RenderState } from "./render/WorldRenderer";
import { HutContainer } from "./HutContainer";
import { useHut } from "./useHut";
import "./hut.css";
import { blurb, label } from "./labels";

const className = (id: string) => label("class", id);
const same = (a: HexPos, b: HexPos) => a.q === b.q && a.r === b.r;
const defOf = (f: Furnishing) => FURNISHINGS[f.defId];
/** One notch of a small thing's turn: a twenty-fourth of a circle. */
const NOTCH = Math.PI / 12;
const TAU = Math.PI * 2;
const wrap = (a: number) => ((a % TAU) + TAU) % TAU;

/** What a piece can do, as short tags under its name. */
function tags(defId: string): string[] {
  const def = FURNISHINGS[defId];
  if (!def) return [];
  const out: string[] = [];
  if (def.size === "small") out.push("small");
  if (def.light) out.push(def.light === "fire" ? "fire" : "light");
  if (def.surface) out.push("top");
  if (def.storage) out.push(`holds ${def.storage}`);
  if (def.kind === "trophy") out.push("trophy");
  return out;
}

/** Everything that can be crafted, starter recipes first. */
const RECIPES = Object.values(FURNISHINGS).filter((f) => f.recipe).sort((a, b) => Number(!!a.needsBlueprint) - Number(!!b.needsBlueprint));

type Tab = "furnish" | "craft" | "upgrade";

export function HutView({ ownerId, me, refresh, onLeave }: { ownerId: string; me: Me; refresh(): Promise<unknown>; onLeave(): void }) {
  const mount = useRef<HTMLDivElement>(null);
  const renderer = useRef<WorldRenderer | null>(null);
  const [hover, setHover] = useState<HexPos | null>(null);
  const [text, setText] = useState("");
  /** A furnishing picked up to be put down on the next floor hex clicked. */
  const [holding, setHolding] = useState<number | null>(null);
  /** How the carried piece is turned: furniture in sixths, small things in radians. */
  const [turn, setTurn] = useState({ facing: 0, angle: 0 });
  /** The placed furnishing whose controls are showing. */
  const [selected, setSelected] = useState<number | null>(null);
  /** The prop under the pointer, for its tooltip. */
  const [hoverProp, setHoverProp] = useState<number | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>("furnish");
  /** The owner's materials, blueprints and gold. Re-read after anything is spent. */
  const [own, setOwn] = useState<Hut | null>(null);
  const [busy, setBusy] = useState(false);
  const [spendError, setSpendError] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);

  const hut = useHut(ownerId, (id, path) => renderer.current?.playEvents([{ t: "moved", heroId: id, path }]));
  const { you, players, furnishings, canEdit, tier, owner } = hut;
  const room = useMemo(() => (tier === null ? null : hutRoom(tier)), [tier]);
  const placed = useMemo(() => placedFurnishings(furnishings), [furnishings]);
  const stored = furnishings.filter((f) => f.q === null && f.inId === null);
  const storedBig = stored.filter((f) => !isSmall(f.defId));
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
      heroes: players.map((p) => ({ id: p.id, classId: p.classId, pos: p.pos, label: p.name, outfit: p.outfit })),
      turn: null,
      battle: null,
      story: null,
      npcs: {},
      freeRoam: true,
      indoors: true,
      props: placed.map((f) => ({
        id: f.id,
        model: defOf(f)?.model ?? f.defId,
        pos: { q: f.q, r: f.r },
        facing: f.facing,
        selected: f.id === selected || f.id === holding,
        small: isSmall(f.defId),
        x: f.x,
        z: f.z,
        angle: f.angle,
        on: f.onId ?? undefined,
        surface: defOf(f)?.surface,
      })),
      holding: held && canEdit ? { model: defOf(held)?.model ?? held.defId, small: isSmall(held.defId), facing: turn.facing, angle: turn.angle } : null,
    };
  }, [ownerId, tier, room, players, you, placed, selected, holding, held, canEdit, turn]);
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
      // Clicking a container (the free Storage Chest, say) opens it in the Furnish panel.
      if (FURNISHINGS[piece.defId]?.storage) setTab("furnish");
    } else {
      setSelected(null);
      hut.send({ type: "move", to: pos });
    }
  };

  /** Whether the carried piece may go at `target`, by the same rules the server checks. */
  const fits = useRef<(target: PlaceTarget) => boolean>(() => true);
  fits.current = (target) => {
    if (!held || !room) return false;
    const others = furnishings.filter((f) => f.id !== held.id);
    if (isSmall(held.defId)) {
      const spot = target.on !== undefined ? { on: Number(target.on), x: target.x, z: target.z, angle: turn.angle } : { pos: target.pos, x: target.x, z: target.z, angle: turn.angle };
      return smallPlaceProblem(room, others, held.defId, spot) === null;
    }
    // Its own riders move with it.
    if (placeProblem(room, others.filter((f) => f.onId !== held.id), held.defId, target.pos)) return false;
    return !players.some((p) => same(p.pos, target.pos));
  };
  const place = useRef<(target: PlaceTarget) => void>(() => {});
  place.current = (target) => {
    if (!held) return;
    const small = isSmall(held.defId);
    hut.send({
      type: "place",
      id: held.id,
      to: target.pos,
      ...(small ? { x: target.x, z: target.z, angle: turn.angle, ...(target.on !== undefined ? { on: Number(target.on) } : {}) } : { facing: turn.facing }),
    });
    setSelected(held.id);
    setHolding(null);
  };
  /** Turn what is carried, or (with nothing carried) the piece chosen, one notch. */
  const turnBy = useRef<(dir: 1 | -1) => void>(() => {});
  turnBy.current = (dir) => {
    if (held) {
      setTurn((t) => ({ facing: (t.facing + dir + 6) % 6, angle: wrap(t.angle + dir * NOTCH) }));
    } else if (chosen) {
      if (isSmall(chosen.defId)) hut.send({ type: "rotate", id: chosen.id, angle: wrap(chosen.angle + dir * NOTCH) });
      else hut.send({ type: "rotate", id: chosen.id, facing: (chosen.facing + dir + 6) % 6 });
    }
  };
  const propClick = useRef<(id: number) => boolean>(() => false);
  propClick.current = (id) => {
    if (!canEdit || holding !== null) return false;
    setSelected((s) => (s === id ? null : id));
    return true;
  };

  useEffect(() => {
    const r = new WorldRenderer(mount.current!, {
      onHexClick: (pos) => click.current(pos),
      onHover: setHover,
      onPropClick: (id) => propClick.current(Number(id)),
      onPropHover: (id) => setHoverProp(id === null ? null : Number(id)),
      onPlace: (target) => place.current(target),
      canPlace: (target) => fits.current(target),
      onTurnHeld: (dir) => turnBy.current(dir),
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
      if (e.key === "Escape") (setHolding(null), setSelected(null));
      else if (e.key === "[") turnBy.current(-1);
      else if (e.key === "]") turnBy.current(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Dev-only handle for driving the hut from the console or a test script.
  if (import.meta.env.DEV) (window as unknown as { __hut: unknown }).__hut = { hut, renderer };

  const mine = ownerId === me.player.id;
  const loadOwn = () => api.hut().then(setOwn, (e: Error) => setSpendError(e.message));
  useEffect(() => {
    if (mine) void loadOwn();
  }, [mine]);
  /** Craft or upgrade: the server decides, then the panel re-reads what is left. */
  const spend = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setSpendError(null);
    setMade(null);
    try {
      await fn();
      setMade(done);
    } catch (e) {
      setSpendError((e as Error).message);
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
  const tip = hoverPiece ? hoverPiece.label : hover && room && poiAt(room, hover)?.kind === "door" ? "The door" : null;
  /** What the last rest did, or why it did nothing. */
  const [rested, setRested] = useState<{ text: string; ok: boolean } | null>(null);
  const restAtHome = async () => {
    try {
      const res = await api.rest("hut");
      setRested({ text: `You sleep in your own bed and wake rested: your stamina is full again, ${res.stamina.left} of ${res.stamina.max} outings.`, ok: true });
    } catch (e) {
      setRested({ text: (e as Error).message, ok: false });
    }
  };
  const say = () => {
    if (!text.trim()) return;
    hut.send({ type: "say", text });
    setText("");
  };
  const pick = (id: number) => {
    const piece = furnishings.find((f) => f.id === id);
    if (piece) setTurn({ facing: piece.facing, angle: piece.angle });
    setSelected(null);
    setHolding((h) => (h === id ? null : id));
  };
  /** Gear or materials in or out of a container: then re-read the hut and the bag. */
  const act = (fn: () => Promise<unknown>) => {
    setSpendError(null);
    void fn()
      .catch((e: Error) => setSpendError(e.message))
      .finally(() => void Promise.all([loadOwn(), refresh()]));
  };
  const onTop = chosen ? placed.filter((f) => f.onId === chosen.id) : [];
  // Opening a container re-reads what it holds, which may have changed since the panel last looked.
  const openBox = chosen && defOf(chosen)?.storage ? chosen.id : null;
  useEffect(() => {
    if (mine && openBox !== null) void loadOwn();
  }, [mine, openBox]);

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
          <div className="hut-tabs">
            {(["furnish", "craft", "upgrade"] as Tab[]).map((t) => (
              <button key={t} className={`small ${tab === t ? "selected" : ""}`} onClick={() => (setTab(t), setMade(null), setSpendError(null))}>
                {t === "furnish" ? "Furnish" : t === "craft" ? "Craft" : "Upgrade"}
              </button>
            ))}
          </div>
          {tab !== "furnish" && spendError && <p className="bad">{spendError}</p>}
          {tab !== "furnish" && made && <p className="good">{made}</p>}

          {tab === "furnish" && <>
          {held ? (
            <p className="hut-hint">
              Click to set the <strong>{held.label}</strong> down.{" "}
              {isSmall(held.defId) ? "It goes anywhere in a hex, or on a table, desk or other top. " : ""}
              <kbd>[</kbd> <kbd>]</kbd> or Shift + wheel turns it. <button className="link" onClick={() => setHolding(null)}>Cancel</button>
            </p>
          ) : chosen ? (
            <div className="hut-chosen">
              <strong>{chosen.label}</strong>
              <div className="hut-tags">{tags(chosen.defId).map((t) => <span key={t} className="tag">{t}</span>)}</div>
              <p className="muted">{blurb("furnishing", chosen.defId)}</p>
              <div className="row">
                <button className="small" title="Turn left ( [ )" onClick={() => turnBy.current(-1)}>⟲</button>
                <button className="small" title="Turn right ( ] )" onClick={() => turnBy.current(1)}>⟳</button>
                <button className="small" onClick={() => pick(chosen.id)}>Move</button>
                <button className="small" onClick={() => (hut.send({ type: "pick_up", id: chosen.id }), setSelected(null))}>Put away</button>
              </div>
              {onTop.length > 0 && <p className="muted">On top: {onTop.map((f) => f.label).join(", ")}. They move with it, and go back to storage if it is put away.</p>}
              {defOf(chosen)?.storage && (
                <HutContainer box={chosen} furnishings={furnishings} own={own} bag={me.inventory} pack={me.carry} send={hut.send} act={act} carry={pick} />
              )}
            </div>
          ) : (
            <p className="muted">Pick something from storage, then click where it goes. Small things go anywhere in a hex, or on top of a table, desk, dresser or chest. Click a placed piece to turn it, move it, or open it.</p>
          )}
          {hut.refused && <p className="bad">{hut.refused}</p>}
          {spendError && <p className="bad">{spendError}</p>}

          <h3>In storage</h3>
          {stored.length === 0 && <p className="muted">Nothing in storage.</p>}
          {[["Furniture", storedBig], ["Small things", storedSmall]].map(([heading, list]) => (list as Furnishing[]).length > 0 && (
            <div key={heading as string}>
              <h4>{heading as string}</h4>
              <ul className="hut-list">
                {(list as Furnishing[]).map((f) => (
                  <li key={f.id}>
                    <button className={holding === f.id ? "selected" : ""} title={blurb("furnishing", f.defId)} onClick={() => pick(f.id)}>
                      {f.label}{tags(f.defId).filter((t) => t !== "small").map((t) => <span key={t} className="tag">{t}</span>)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <h3>In the room</h3>
          {placed.length === 0 && <p className="muted">Nothing placed yet.</p>}
          <ul className="hut-list">
            {placed.map((f) => (
              <li key={f.id}>
                <button className={selected === f.id || holding === f.id ? "selected" : ""} title={blurb("furnishing", f.defId)} onClick={() => (setHolding(null), setSelected((s) => (s === f.id ? null : f.id)))}>
                  {f.label}
                </button>
              </li>
            ))}
          </ul>

          <h3>Voyage perks</h3>
          <p className="muted">What the pieces standing in the room give you when you board a ship, and the most a hut can give.</p>
          <PerkMeter perks={perks} />
          </>}

          {tab === "craft" && <>
            {!own ? <p className="muted">Counting your materials…</p> : <>
              <ResourceChips resources={own.resources} all />
              <ul className="hut-recipes">
                {RECIPES.map((def) => {
                  const known = !def.needsBlueprint || own.blueprints.includes(def.id);
                  const problem = craftProblem(def.id, own.blueprints, own.resources);
                  return (
                    <li key={def.id} className={known ? "" : "locked"}>
                      <div>
                        <strong>{label("furnishing", def.id)}</strong>
                        <span className="muted"> · {known ? blurb("furnishing", def.id) : "Blueprint not found yet. Islands hide them."}</span>
                      </div>
                      <div className="row">
                        <CostChips cost={def.recipe!} have={own.resources} />
                        <span className="spacer" />
                        <button className="small primary" disabled={busy || !!problem} title={problem ?? "Goes into storage"} onClick={() => void spend(() => api.craft(def.id), `${label("furnishing", def.id)} crafted. It is in storage.`)}>
                          Craft
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>}
          </>}

          {tab === "upgrade" && tier !== null && <>
            <p>Your hut is a <strong>{hutTier(tier).name}</strong>: a floor of {hutTier(tier).cols} by {hutTier(tier).rows}.</p>
            {!bigger ? <p className="muted">It is as big as huts get.</p> : !own ? <p className="muted">Counting your materials…</p> : <>
              <h3>{bigger.name}</h3>
              <p className="muted">A floor of {bigger.cols} by {bigger.rows}, and a bigger building in the Harbor. Everything placed stays where it stands.</p>
              <div className="row">
                <CostChips cost={bigger.resources} have={own.resources} gold={bigger.gold} haveGold={own.gold} />
              </div>
              {upgradeProblem(tier, own.gold, own.resources) && <p className="muted">{upgradeProblem(tier, own.gold, own.resources)}</p>}
              <button className="primary" disabled={busy || !!upgradeProblem(tier, own.gold, own.resources)} onClick={() => void spend(() => api.upgradeHut(), `Your hut is now a ${bigger.name}.`)}>
                Build the {bigger.name}
              </button>
            </>}
          </>}
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
        {canEdit && <button title="Sleep in your own bed: all your gathering outings back, once every twenty minutes" onClick={() => void restAtHome()}>Rest</button>}
        {rested && <span className={rested.ok ? "good" : "bad"}>{rested.text}</span>}
        <button className={atDoor ? "primary" : ""} onClick={onLeave}>Leave</button>
      </DragPanel>
      {atDoor && self && <TileAction renderer={renderer} pos={self.pos} unitId={self.id} label="Leave" run={onLeave} />}
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
