// Inside the pub: a room bigger than any hut, drawn by the same renderer,
// where the crew sees each other. Stand at the menu board to order food and
// drink or have a word with Old Tam; stand at the dice table to play.

import { useEffect, useMemo, useRef, useState } from "react";
import type { HexPos } from "@gantt-quest/core";
import { HERO_CLASSES, PUB_BARKEEP, PUB_BARKEEP_POS, PUB_COUNTER, PUB_DICE, PUB_FITTINGS, PUB_MAX_TALK, PUB_MENU, PUB_SHOALS, poiAt, pubRoom, type Perk } from "@gantt-quest/world";
import { api, type Me, type PubTab } from "./api";
import { DiceTable } from "./DiceTable";
import { ShoalsTable } from "./ShoalsTable";
import { DragPanel } from "./DragPanel";
import { perkText } from "./hutDrops";
import { WorldRenderer, type RenderState } from "./render/WorldRenderer";
import { usePub } from "./usePub";
import "./hut.css";
import "./pub.css";

const className = (id: string) => HERO_CLASSES.find((c) => c.id === id)?.name ?? id;
const same = (a: HexPos, b: HexPos) => a.q === b.q && a.r === b.r;
const ROOM = pubRoom();
const DOOR = ROOM.pois.find((p) => p.kind === "door")!.pos;

interface TalkLine {
  who: string;
  text: string;
}

export function PubView({ me, refresh, onLeave }: { me: Me; refresh(): Promise<unknown>; onLeave(): void }) {
  const mount = useRef<HTMLDivElement>(null);
  const renderer = useRef<WorldRenderer | null>(null);
  const [hover, setHover] = useState<HexPos | null>(null);
  const [text, setText] = useState("");
  const chatEnd = useRef<HTMLDivElement>(null);
  /** What this hero has ordered and what it will give them. */
  const [tab, setTab] = useState<PubTab | null>(null);
  const [busy, setBusy] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  /** The last order was a meal that gave back a gathering outing. */
  const [rested, setRested] = useState(false);
  /** The conversation with the barkeep. Kept in this browser only. */
  const [talk, setTalk] = useState<TalkLine[]>([]);
  const [ask, setAsk] = useState("");
  const [waiting, setWaiting] = useState(false);
  const talkEnd = useRef<HTMLDivElement>(null);

  const pub = usePub((id, path) => renderer.current?.playEvents([{ t: "moved", heroId: id, path }]));
  const { you, players } = pub;
  const self = players.find((p) => p.id === you);

  // Holding dice: a stray click on the floor would walk away from the table and forfeit, so the floor is ignored until the game is over.
  const holdingDice =
    (pub.dice?.phase === "playing" && pub.dice.seats.some((s) => s.id === you && s.count > 0)) ||
    (pub.shoals?.phase === "playing" && pub.shoals.seats.some((s) => s.id === you && s.count > 0));
  const pinned = useRef(holdingDice);
  pinned.current = holdingDice;
  // Gold moves when a dice game starts and when it ends.
  const dicePhase = `${pub.dice?.phase}|${pub.shoals?.phase}`;
  useEffect(() => {
    if (/playing|done/.test(dicePhase)) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dicePhase]);

  const scene = useMemo<RenderState | null>(() => {
    if (!you) return null;
    return {
      code: "pub",
      you,
      phase: "overworld",
      round: 0,
      map: ROOM,
      heroes: [
        ...players.map((p) => ({ id: p.id, classId: p.classId, pos: p.pos, label: p.name, outfit: p.outfit })),
        // The barkeep stands behind his bar and is drawn like anyone else.
        { id: PUB_BARKEEP.id, classId: "npc", pos: PUB_BARKEEP_POS, label: PUB_BARKEEP.name },
      ],
      turn: null,
      battle: null,
      story: null,
      npcs: {},
      freeRoam: true,
      indoors: true,
      props: PUB_FITTINGS.map((f) => ({ id: f.id, model: f.model, pos: { q: f.q, r: f.r }, facing: f.facing })),
    };
  }, [players, you]);
  const latest = useRef(scene);
  latest.current = scene;
  const send = useRef(pub.send);
  send.current = pub.send;

  useEffect(() => {
    const r = new WorldRenderer(mount.current!, { onHexClick: (to) => !pinned.current && send.current({ type: "move", to }), onHover: setHover });
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
  }, [pub.chat.length]);
  useEffect(() => {
    talkEnd.current?.scrollIntoView({ block: "end" });
  }, [talk.length]);
  useEffect(() => {
    api.pub().then(setTab, () => undefined);
  }, []);

  // Dev-only handle for driving the pub from the console or a test script.
  if (import.meta.env.DEV) (window as unknown as { __pub: unknown }).__pub = { pub };

  const atCounter = !!self && same(self.pos, PUB_COUNTER);
  const atDice = !!self && same(self.pos, PUB_DICE);
  const atShoals = !!self && same(self.pos, PUB_SHOALS);
  const atDoor = !!self && same(self.pos, DOOR);
  const gold = me.character?.gold ?? 0;
  const hoverPoi = hover ? poiAt(ROOM, hover) : undefined;
  const tip = hover && same(hover, PUB_BARKEEP_POS) ? `${PUB_BARKEEP.name}, the barkeep. Stand at the menu board to talk to him.`
    : !hoverPoi ? null
    : hoverPoi.kind === "counter" ? "The menu board: order here, or have a word with the barkeep"
    : hoverPoi.kind === "dice" ? "Dice table: a bluffing game for a small stake"
    : hoverPoi.kind === "shoals" ? "Shoals: lay your markers, bid, and sail without running aground"
    : hoverPoi.kind === "door" ? "The door back to the Harbor"
    : null;

  const say = () => {
    if (!text.trim()) return;
    pub.send({ type: "say", text });
    setText("");
  };
  const order = async (itemId: string) => {
    setBusy(true);
    setOrderError(null);
    try {
      const next = await api.pubOrder(itemId);
      setTab(next);
      setRested(!!next.rested);
      await refresh();
    } catch (e) {
      setOrderError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const speak = async () => {
    const line = ask.trim();
    if (!line || waiting) return;
    setAsk("");
    setWaiting(true);
    setTalk((t) => [...t, { who: me.character?.name ?? "You", text: line }].slice(-20));
    try {
      const { say: reply } = await api.pubTalk(line);
      setTalk((t) => [...t, { who: PUB_BARKEEP.name, text: reply }].slice(-20));
    } catch {
      setTalk((t) => [...t, { who: PUB_BARKEEP.name, text: "(He is busy with a barrel and does not hear you.)" }].slice(-20));
    } finally {
      setWaiting(false);
    }
  };
  const having = (kind: "drink" | "food") => PUB_MENU.find((i) => i.kind === kind && tab?.orders.includes(i.id));
  const buffText = (buff: Perk) => perkText(buff) || "nothing";

  return (
    <div className="run hut-view pub-view">
      <div className="stage" ref={mount} />
      <div className="topbar">
        <strong>The pub</strong>
        <span className="muted">{me.crew?.name}</span>
        <span className="spacer" />
        <span className="gold">{gold} gold</span>
        {pub.status !== "open" && !pub.error && <span className="bad">connecting…</span>}
        <button className="small" onClick={onLeave}>Leave</button>
      </div>

      {you && atCounter && (
        <DragPanel id="pub.bar" title="At the bar" className="story panel pub-bar">
          <h3>The board</h3>
          <p className="muted">One drink and one meal go with you on your next voyage, then they are gone. Ordering another replaces the one you have. A meal also gives back one gathering outing, once a day.</p>
          <ul className="pub-menu">
            {PUB_MENU.map((item) => {
              const mine = tab?.orders.includes(item.id);
              return (
                <li key={item.id} className={mine ? "having" : ""}>
                  <div>
                    <strong>{item.name}</strong> <span className="tag">{item.kind}</span>
                    <div className="muted">{item.blurb} <span className="good">{buffText(item.buff)}</span></div>
                  </div>
                  <button className="small primary" disabled={busy || mine || gold < item.price} title={mine ? "You have this already" : gold < item.price ? "You cannot afford it" : ""} onClick={() => void order(item.id)}>
                    {mine ? "Having it" : `${item.price}g`}
                  </button>
                </li>
              );
            })}
          </ul>
          {orderError && <p className="bad">{orderError}</p>}
          {rested && <p className="good">That set you up: one gathering outing is yours again today.</p>}
          <p>
            In you: <strong>{having("drink")?.name ?? "no drink"}</strong> and <strong>{having("food")?.name ?? "no meal"}</strong>
            {tab && perkText(tab.buff) && <span className="good"> · next voyage: {perkText(tab.buff)}</span>}
          </p>

          <h3>{PUB_BARKEEP.name}</h3>
          <div className="pub-talk">
            {talk.length === 0 && <div className="muted">He is wiping a mug that is already clean. Say something.</div>}
            {talk.map((l, i) => <div key={i} className={l.who === PUB_BARKEEP.name ? "line npc" : "line hero"}><strong>{l.who}: </strong>{l.text}</div>)}
            {waiting && <div className="muted">He thinks about it…</div>}
            <div ref={talkEnd} />
          </div>
          <div className="row">
            <input value={ask} maxLength={PUB_MAX_TALK} placeholder={`Talk to ${PUB_BARKEEP.name}…`} onChange={(e) => setAsk(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void speak()} />
            <button disabled={!ask.trim() || waiting} onClick={() => void speak()}>Say</button>
          </div>
        </DragPanel>
      )}

      {you && atShoals && <ShoalsTable table={pub.shoals} you={you} gold={gold} error={pub.shoalsError} send={(action) => pub.send({ type: "shoals", action })} />}
      {you && atDice && <DiceTable table={pub.dice} you={you} gold={gold} error={pub.diceError} send={(action) => pub.send({ type: "dice", action })} />}

      {you && <>
      <DragPanel id="pub.crew" title="Inside" foldOnPhone className="crew">
        <div className="panel">
          <h3>{players.length} here now</h3>
          <ul className="roster">
            {players.map((p) => (
              <li key={p.id}>
                <span><i className="dot on" /> <strong>{p.name}</strong>{p.id === you && <span className="tag">you</span>}</span>
                <span className="muted">{className(p.classId)} · {p.level}</span>
              </li>
            ))}
          </ul>
        </div>
      </DragPanel>

      <DragPanel id="pub.chat" title="Pub chat" foldOnPhone className="chat panel harbor-chat">
        <div className="chat-lines">
          {pub.chat.length === 0 && <div className="muted">Only people inside the pub see what is said here.</div>}
          {pub.chat.map((l, i) => <div key={i} className="line hero"><strong>{l.name}: </strong>{l.text}</div>)}
          <div ref={chatEnd} />
        </div>
        <div className="row">
          <input value={text} maxLength={200} placeholder="Say something…" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && say()} />
          <button disabled={!text.trim()} onClick={say}>Say</button>
        </div>
      </DragPanel>

      <DragPanel id="pub.turn" title="Here" compact className="turnbar panel">
        {holdingDice ? <span>You are in a game. Walking away forfeits it.</span>
          : atDoor ? <span>The door back to the Harbor.</span>
          : atCounter ? <span>At the bar.</span>
          : atDice ? <span>At the dice table.</span>
          : atShoals ? <span>At the Shoals table.</span>
          : <span className="muted">Click a hex to walk. Order at the menu board; the game tables are across the room.</span>}
        <button className={atDoor ? "primary" : ""} disabled={holdingDice} onClick={onLeave}>Leave</button>
      </DragPanel>
      </>}

      {tip && <div className="tip">{tip}</div>}
      {pub.error && (
        <div className="hut-refused panel">
          <p>{pub.error}</p>
          <button className="primary" onClick={onLeave}>Back to the Harbor</button>
        </div>
      )}
    </div>
  );
}
