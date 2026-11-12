// Inside a hut: a small room drawn by the same renderer as the Harbor, where
// everyone present sees each other and the furniture. The owner picks pieces
// out of the Storage panel to place them, makes new ones in the Craft panel,
// and grows the hut from the Hut panel. Clicking a placed piece floats its
// controls above it (HutToolbar); a container opens into a panel of its own.
// A visiting crewmate can only look.

import { useEffect, useMemo, useRef, useState } from "react";
import type { HexPos } from "@gantt-quest/core";
import { FURNISHINGS, craftProblem, hutPerks, hutRoom, hutTier, isSmall, nextHutTier, placeProblem, placedFurnishings, poiAt, smallPlaceProblem, upgradeProblem, type Furnishing } from "@gantt-quest/world";
import { api, type Hut, type Me } from "./api";
import { DragPanel } from "./DragPanel";
import { CostChips, PerkMeter, ResourceChips } from "./hutDrops";
import { TileAction } from "./TileAction";
import { HutToolbar, type ToolAction } from "./HutToolbar";
import { WorldRenderer, type PlaceTarget, type RenderState } from "./render/WorldRenderer";
import { HutContainer } from "./HutContainer";
import { HeroSheet, useHeroSheet } from "./HeroSheet";
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

/** Which panel a message belongs in. */
type Where = "storage" | "craft" | "hut" | "box";

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
      heroes: players.map((p) => ({ id: p.id, classId: p.classId, pos: p.pos, label: p.name, outfit: p.outfit, level: p.level, xp: p.xp })),
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
      const spot = target.on !== undefined ? { on: Number(target.on), x: target.x, z: target.z, angle: turn.angle } : { pos: target.pos, x: target.x, z: target.z, angle: turn.angle };
      return smallPlaceProblem(room, others, held.defId, spot);
    }
    // Its own riders move with it.
    return placeProblem(room, others.filter((f) => f.onId !== held.id), held.defId, target.pos) ?? (players.some((p) => same(p.pos, target.pos)) ? "Someone is standing there." : null);
  };
  const place = useRef<(target: PlaceTarget) => void>(() => {});
  place.current = (target) => {
    if (!held) return;
    // A spot it cannot go: say why, and keep hold of it.
    const problem = whyNot.current(target);
    if (problem) return setRefusal(problem);
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
  /**
   * Turn what is carried, or (with nothing carried) the piece chosen: furniture
   * a sixth of a turn, a small thing `notches` twenty-fourths.
   */
  const turnBy = useRef<(dir: 1 | -1, notches?: number) => void>(() => {});
  turnBy.current = (dir, notches = 1) => {
    if (held) {
      setTurn((t) => ({ facing: (t.facing + dir + 6) % 6, angle: wrap(t.angle + dir * notches * NOTCH) }));
    } else if (chosen) {
      if (isSmall(chosen.defId)) hut.send({ type: "rotate", id: chosen.id, angle: wrap(chosen.angle + dir * notches * NOTCH) });
      else hut.send({ type: "rotate", id: chosen.id, facing: (chosen.facing + dir + 6) % 6 });
    }
  };
  const propClick = useRef<(id: number) => boolean>(() => false);
  propClick.current = (id) => {
    if (!canEdit || holding !== null) return false;
    setSelected((s) => (s === id ? null : id));
    return true;
  };

  const heroSheet = useHeroSheet();

  useEffect(() => {
    const r = new WorldRenderer(mount.current!, {
      onHexClick: (pos) => click.current(pos),
      onHover: setHover,
      onHeroClick: heroSheet.onHeroClick,
      onHeroHover: heroSheet.onHeroHover,
      onPropClick: (id) => propClick.current(Number(id)),
      onPropHover: (id) => setHoverProp(id === null ? null : Number(id)),
      onPlace: (target) => place.current(target),
      canPlace: (target) => whyNot.current(target) === null,
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
      if (e.key === "Escape") (setHolding(null), setSelected(null), setOpened(null));
      else if (e.key === "[") turnBy.current(-1);
      else if (e.key === "]") turnBy.current(1);
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
      await fn();
      setNote({ where, text: done, ok: true });
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

  // A refusal from the room shows as a toast, and goes after a few seconds.
  useEffect(() => setRefusal(hut.refused), [hut.refused]);
  useEffect(() => {
    if (!refusal) return;
    const t = setTimeout(() => setRefusal(null), 4000);
    return () => clearTimeout(t);
  }, [refusal]);

  /** The floating controls for the chosen piece. */
  const tools: ToolAction[] = [];
  if (chosen && canEdit && !held) {
    const small = isSmall(chosen.defId);
    tools.push({ key: "move", icon: "move", title: "Move: pick it up and set it down somewhere else", run: () => pick(chosen.id) });
    if (small) {
      tools.push(
        { key: "left", icon: "left", title: "Turn left 45°", run: () => turnBy.current(-1, 3) },
        { key: "fine-left", icon: "fineLeft", title: "Turn left a notch (15°, or [ )", run: () => turnBy.current(-1) },
        { key: "fine-right", icon: "fineRight", title: "Turn right a notch (15°, or ] )", run: () => turnBy.current(1) },
        { key: "right", icon: "right", title: "Turn right 45°", run: () => turnBy.current(1, 3) },
      );
    } else {
      tools.push(
        { key: "left", icon: "left", title: "Turn left a sixth ( [ )", run: () => turnBy.current(-1) },
        { key: "right", icon: "right", title: "Turn right a sixth ( ] )", run: () => turnBy.current(1) },
      );
    }
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

      {canEdit && (
        <DragPanel id="hut.storage" title="Storage" foldOnPhone className="story panel hut-storage">
          {held ? (
            <p className="hut-hint">
              Click to set the <strong>{held.label}</strong> down.{" "}
              {isSmall(held.defId) ? "It goes anywhere in a hex, or on a table, desk or other top. " : ""}
              <kbd>[</kbd> <kbd>]</kbd> or Shift + wheel turns it. <button className="link" onClick={() => setHolding(null)}>Cancel</button>
            </p>
          ) : (
            <p className="muted">Pick a piece up to place it. Small things go anywhere in a hex, or on top of a table, desk, dresser or chest. Click a placed piece for its controls.</p>
          )}
          {noteIn("storage")}
          {stored.length === 0 && <p className="muted">Nothing in storage. Make something in the Craft panel.</p>}
          {[["Furniture", storedBig], ["Small things", storedSmall]].map(([heading, list]) => (list as Furnishing[]).length > 0 && (
            <div key={heading as string}>
              <h4>{heading as string}</h4>
              <ul className="hut-list">
                {(list as Furnishing[]).map((f) => (
                  <li key={f.id}>
                    <button className={holding === f.id ? "selected" : ""} title={`${blurb("furnishing", f.defId)} Pick it up to place it.`} onClick={() => pick(f.id)}>
                      {f.label}{tags(f.defId).filter((t) => t !== "small").map((t) => <span key={t} className="tag">{t}</span>)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </DragPanel>
      )}

      {canEdit && (
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
                    <div>
                      <strong>{label("furnishing", def.id)}</strong>
                      <span className="muted"> · {known ? blurb("furnishing", def.id) : "Blueprint not found yet. Islands hide them."}</span>
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
                {canEdit ? (
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
          <HutContainer box={box} furnishings={furnishings} own={own} bag={me.inventory} pack={me.carry} send={hut.send} act={act} carry={pick} />
        </DragPanel>
      )}

      {chosen && tools.length > 0 && (
        <HutToolbar renderer={renderer} propId={chosen.id} name={chosen.label} tags={tags(chosen.defId)} actions={tools} />
      )}
      {refusal && <div className="toast" role="status">{refusal}</div>}

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
          : canEdit ? <span className="muted">Click a hex to walk. Place pieces from the Storage panel; click one for its controls.</span>
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
      {heroSheet.open && you && <HeroSheet id={heroSheet.open} you={you} pinned={heroSheet.pinned} onClose={heroSheet.close} />}
    </div>
  );
}
