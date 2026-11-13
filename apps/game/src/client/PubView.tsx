// Inside the pub: a room bigger than any hut, drawn by the same renderer,
// where the crew sees each other. Stand at the menu board to order food and
// drink or have a word with Old Tam; stand at the dice table to play. The
// contract dealer, by the pillar at the end of the bar, has the contracts and
// the crew's goal.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAudioScene } from "./audio/useAudioScene";
import { hexDistance, hexNeighbors, type HexPos } from "@gantt-quest/core";
import { PUB_BARKEEP, PUB_BARKEEP_POS, PUB_COUNTER, PUB_DEALER, PUB_DEALER_POS, PUB_DEALER_STAND, PUB_DICE, PUB_FITTINGS, PUB_GRID, PUB_MAX_TALK, PUB_MENU, PUB_REGULAR_SPOTS, PUB_SALESMAN_POS, PUB_SHOALS, PUB_TRADER, dueIn, gatherDay, poiAt, pubPath, pubRoom, regularsOn, salesman, type Perk, type RegularId } from "@gantt-quest/world";
import { CatchPanel } from "./CatchPanel";
import { api, type Me, type PubTab, type RegularsView } from "./api";
import { RegularPanel } from "./RegularPanel";
import { DealerPanel } from "./board/DealerPanel";
import { DiceTable } from "./DiceTable";
import { ShoalsTable } from "./ShoalsTable";
import { SalesmanPanel } from "./SalesmanPanel";
import { useSalesman } from "./salesmanClock";
import { CrewRoster } from "./CrewRoster";
import { DragPanel } from "./DragPanel";
import { OptionsMenu } from "./OptionsMenu";
import { perkText } from "./hutDrops";
import { ThingIcon, pubIcon } from "./thingIcons";
import { TileAction } from "./TileAction";
import { WorldRenderer, type RenderState } from "./render/WorldRenderer";
import { fancy } from "./render/fancy";
import { harborOutlook, type Outlook } from "./render/harborOutlook";
import { usePub } from "./usePub";
import { HeroSheet, useHeroSheet } from "./HeroSheet";
import { blurb, label } from "./labels";
import { xpEvents } from "./xpEvents";
import "./hut.css";
import "./pub.css";

const same = (a: HexPos, b: HexPos) => a.q === b.q && a.r === b.r;
/** A regular's unit id in the scene. */
const regularUnit = (id: string) => `regular:${id}`;
const ROOM = pubRoom();
const DOOR = ROOM.pois.find((p) => p.kind === "door")!.pos;

interface TalkLine {
  who: string;
  text: string;
}

/** One thing ordered at the bar, with its icon, or what to say when there is none. */
function Having({ item, none }: { item: { id: string } | undefined; none: string }) {
  if (!item) return <strong>{none}</strong>;
  return <span className="pub-having"><ThingIcon icon={pubIcon(item.id)} size={18} /><strong>{label("pub", item.id)}</strong></span>;
}

export function PubView({ me, refresh, onLeave }: { me: Me; refresh(): Promise<unknown>; onLeave(): void }) {
  useAudioScene("pub");
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

  const visitor = useSalesman(me.crew?.id);
  const seller = visitor.here ? salesman(visitor.here.salesmanId) : undefined;
  const due = visitor.next ? salesman(visitor.next.salesmanId) : undefined;
  /** Old Tam's word on the corner: who is in, or who is due. */
  const word = seller ? `${seller.name}, ${seller.trade}, has the corner by the far wall until ${new Date(visitor.here!.endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`
    : due ? `Nobody in the corner. ${due.name}, ${due.trade}, is due ${dueIn(visitor.next!.startsAt - visitor.now)}.`
    : "Nobody in the corner, and nobody due that I know of.";
  const sellerHere = useRef(!!seller);
  sellerHere.current = !!seller;

  /** The day the regulars are for: who is in follows from it and the crew, as on the server. */
  const [day, setDay] = useState(() => gatherDay(Date.now()));
  useEffect(() => {
    const t = setInterval(() => setDay(gatherDay(Date.now())), 60_000);
    return () => clearInterval(t);
  }, []);
  const cast = useMemo(() => (me.crew ? regularsOn(me.crew.id, day) : []), [me.crew, day]);
  /** Where this player stands with each regular, from the server. */
  const [regs, setRegs] = useState<RegularsView | null>(null);
  const loadRegs = useCallback(() => api.regulars().then(setRegs, () => undefined), []);
  useEffect(() => {
    void loadRegs();
  }, [loadRegs, day, me.character?.gold]);
  /** The regular whose panel is open. */
  const [talkTo, setTalkTo] = useState<RegularId | null>(null);
  const [sellingFish, setSellingFish] = useState(false);
  // Opening a regular's panel reads the job again (a quest may have been done elsewhere since),
  // and brings them to the middle of the screen, clear of the panel.
  useEffect(() => {
    if (!talkTo) return;
    void loadRegs();
    const spot = castRef.current.findIndex((r) => r.id === talkTo);
    if (spot >= 0) renderer.current?.lookAt(PUB_REGULAR_SPOTS[spot].pos);
  }, [talkTo, loadRegs]);
  /** The regular just clicked: their panel opens once you are beside them. */
  const wantTalk = useRef<RegularId | null>(null);
  /** The contract dealer's panel is open. It opens once you are beside them if you clicked them, and closes when you walk away. */
  const [dealing, setDealing] = useState(false);
  const wantDeal = useRef(false);
  const castRef = useRef(cast);
  castRef.current = cast;

  const pub = usePub(
    (id, path) => renderer.current?.playEvents([{ t: "moved", heroId: id, path }]),
    (m) => {
      renderer.current?.playEvents(xpEvents(m));
      // Your own win: your sheet's level and XP are stale.
      if (m.id === pub.you) void refresh();
    },
    (id, text) => renderer.current?.say(id, text),
  );
  const { you, players } = pub;
  const self = players.find((p) => p.id === you);
  /** How each player is drawn, for their seat at the Shoals table. */
  const looks = useMemo(() => Object.fromEntries(players.map((p) => [p.id, { classId: p.classId, outfit: p.outfit }])), [players]);

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
        ...players.map((p) => ({ id: p.id, classId: p.classId, pos: p.pos, label: p.name, outfit: p.outfit, level: p.level, xp: p.xp })),
        // The barkeep stands behind his bar and is drawn like anyone else.
        { id: PUB_BARKEEP.id, classId: "npc", pos: PUB_BARKEEP_POS, label: PUB_BARKEEP.name },
        // The contract dealer, by the pillar at the end of the bar.
        { id: PUB_DEALER.id, classId: PUB_DEALER.look, pos: PUB_DEALER_POS, label: PUB_DEALER.name },
        // A traveling salesman, when one is in, takes the corner by the far wall.
        ...(seller ? [{ id: "salesman", classId: seller.look, pos: PUB_SALESMAN_POS, label: seller.name }] : []),
        // The day's regulars, each on their own spot.
        ...cast.map((r, i) => ({ id: regularUnit(r.id), classId: r.look, pos: PUB_REGULAR_SPOTS[i].pos, label: r.name })),
      ],
      turn: null,
      battle: null,
      story: null,
      npcs: {},
      freeRoam: true,
      indoors: true,
      props: PUB_FITTINGS.map((f) => ({ id: f.id, model: f.model, pos: { q: f.q, r: f.r }, facing: f.facing })),
    };
  }, [players, you, seller, cast]);
  const latest = useRef(scene);
  latest.current = scene;
  const send = useRef(pub.send);
  send.current = pub.send;

  const heroSheet = useHeroSheet();

  useEffect(() => {
    const r = new WorldRenderer(mount.current!, { onHexClick: (to) => {
        if (pinned.current) return;
        // Clicking a regular walks you up beside them, and opens a word with them once there.
        const spot = PUB_REGULAR_SPOTS.findIndex((s) => same(s.pos, to));
        const who = spot >= 0 ? castRef.current[spot] : undefined;
        wantTalk.current = who?.id ?? null;
        if (who) return send.current({ type: "move", to: PUB_REGULAR_SPOTS[spot].stand });
        // Clicking the contract dealer (or the hex in front of them) walks you up, and opens their papers once there.
        wantDeal.current = same(to, PUB_DEALER_POS) || same(to, PUB_DEALER_STAND);
        if (wantDeal.current) return send.current({ type: "move", to: PUB_DEALER_STAND });
        // Clicking the salesman walks you up to their table.
        send.current({ type: "move", to: sellerHere.current && same(to, PUB_SALESMAN_POS) ? PUB_TRADER : to });
      }, onHover: setHover });
    renderer.current = r;
    if (latest.current) r.setState(latest.current);
    // With fancy graphics, the pub has windows onto the real Harbor outside: a second view of it, drawn off screen.
    let outlook: Outlook | null = null;
    const windows = () => {
      if (fancy.get() && !outlook) {
        outlook = harborOutlook();
        r.setOutlook(outlook.view);
      } else if (!fancy.get() && outlook) {
        r.setOutlook(null);
        outlook.dispose();
        outlook = null;
      }
    };
    windows();
    const unwatch = fancy.subscribe(windows);
    return () => {
      unwatch();
      r.setOutlook(null);
      outlook?.dispose();
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
  // Sitting at a table: first person, until you stand up. Standing up walks you out to the floor beside it.
  const [stood, setStood] = useState<"dice" | "shoals" | null>(null);
  const seatedAt: "dice" | "shoals" | null = atDice && stood !== "dice" ? "dice" : atShoals && stood !== "shoals" ? "shoals" : null;
  useEffect(() => {
    if (stood === "dice" && !atDice) setStood(null);
    if (stood === "shoals" && !atShoals) setStood(null);
  }, [stood, atDice, atShoals]);
  const standFrom = (table: "dice" | "shoals") => {
    setStood(table);
    const from = table === "dice" ? PUB_DICE : PUB_SHOALS;
    const away = hexNeighbors(from, PUB_GRID).filter((n) => ![PUB_COUNTER, PUB_DICE, PUB_SHOALS, PUB_TRADER, PUB_DEALER_STAND].some((p) => same(p, n)) && pubPath(ROOM, from, n));
    // The floor south of the table first, toward the room.
    away.sort((a, b) => b.r - a.r);
    if (away[0]) pub.send({ type: "move", to: away[0] });
  };
  const atTrader = !!self && same(self.pos, PUB_TRADER);
  const atDealer = !!self && same(self.pos, PUB_DEALER_STAND);
  // Walking up to the dealer: a word of greeting, and their papers if you clicked them. Walking away puts them away.
  useEffect(() => {
    if (!atDealer) {
      setDealing(false);
      return;
    }
    renderer.current?.say(PUB_DEALER.id, PUB_DEALER.hello);
    if (wantDeal.current) setDealing(true);
    wantDeal.current = false;
  }, [atDealer]);
  /** The regular you are standing beside, if any. */
  const nearSpot = self ? PUB_REGULAR_SPOTS.findIndex((s) => hexDistance(s.pos, self.pos) === 1) : -1;
  const near = nearSpot >= 0 ? cast[nearSpot] : undefined;
  const talking = talkTo && near?.id === talkTo ? regs?.regulars.find((v) => v.regular === talkTo) : undefined;
  const hoverRegular = hover ? cast[PUB_REGULAR_SPOTS.findIndex((s) => same(s.pos, hover))] : undefined;
  // Walking up to a regular: they say hello, and if you clicked them, their panel opens. Walking away closes it.
  const nearId = near?.id ?? null;
  useEffect(() => {
    if (!nearId) {
      setTalkTo(null);
      return;
    }
    const who = castRef.current.find((r) => r.id === nearId);
    if (who) renderer.current?.say(regularUnit(who.id), who.hello);
    if (wantTalk.current === nearId) setTalkTo(nearId);
    wantTalk.current = null;
  }, [nearId]);
  const gold = me.character?.gold ?? 0;
  const hoverPoi = hover ? poiAt(ROOM, hover) : undefined;
  const tip = hoverRegular ? `${hoverRegular.name}, ${hoverRegular.trade}. Click to walk up and talk.`
    : hover && same(hover, PUB_BARKEEP_POS) ? `${PUB_BARKEEP.name}, the barkeep. Stand at the menu board to talk to him.`
    : hover && seller && same(hover, PUB_SALESMAN_POS) ? `${seller.name}, ${seller.trade}. Click to walk up and trade.`
    : hover && same(hover, PUB_DEALER_POS) ? `${PUB_DEALER.name}, ${PUB_DEALER.trade}. Click to walk up: contracts and the crew's goal.`
    : !hoverPoi ? null
    : hoverPoi.kind === "counter" ? "The menu board: order here, or have a word with the barkeep"
    : hoverPoi.kind === "dice" ? "Dice table: a bluffing game for a small stake"
    : hoverPoi.kind === "dealer" ? `Where you stand to deal with ${PUB_DEALER.name}: contracts and the crew's goal`
    : hoverPoi.kind === "trader" ? (seller ? `Trade with ${seller.name}, ${seller.trade}` : "The corner where traveling salesmen set up. Empty for now.")
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
    <div className={`run hut-view pub-view${seatedAt ? " seated" : ""}`}>
      <div className="stage" ref={mount} />
      <div className="topbar">
        <strong>The pub</strong>
        <span className="muted">{me.crew?.name}</span>
        <span className="spacer" />
        <span className="gold">{gold} gold</span>
        {pub.status !== "open" && !pub.error && <span className="bad">connecting…</span>}
        <button className="small" onClick={onLeave}>Leave</button>
        <OptionsMenu
          reset={pub.status !== "open" ? undefined : {
            to: "the door",
            run: () => {
              pub.send({ type: "unstick" });
              renderer.current?.lookAt(DOOR);
            },
          }}
          resetBlocked="Waiting for the pub to connect."
        />
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
                  <ThingIcon icon={pubIcon(item.id)} size={36} />
                  <div className="grow">
                    <strong>{label("pub", item.id)}</strong> <span className="tag">{item.kind}</span>
                    <div className="muted">{blurb("pub", item.id)} <span className="good">{buffText(item.buff)}</span></div>
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
            In you: <Having item={having("drink")} none="no drink" /> and <Having item={having("food")} none="no meal" />
            {tab && perkText(tab.buff) && <span className="good"> · next voyage: {perkText(tab.buff)}</span>}
          </p>

          <h3>{PUB_BARKEEP.name}</h3>
          <p className="row">
            <span className="muted grow">He buys fish for the stew, at the same price every day.</span>
            <button className="small" onClick={() => setSellingFish(true)}>Sell him fish</button>
          </p>
          <div className="pub-talk">
            {talk.length === 0 && <div className="muted">He is wiping a mug that is already clean. Say something.</div>}
            {talk.length === 0 && <div className="line npc"><strong>{PUB_BARKEEP.name}: </strong>{word}</div>}
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

      {you && sellingFish && <CatchPanel buyer="tam" onGold={() => void refresh()} onClose={() => setSellingFish(false)} />}
      {you && atTrader && seller && <SalesmanPanel me={me} refresh={refresh} />}
      {you && atDealer && dealing && <DealerPanel refresh={refresh} onClose={() => setDealing(false)} />}
      {you && talking && regs && <RegularPanel key={talking.regular} view={talking} handedIn={regs.handedIn} cap={regs.cap} reload={loadRegs} refresh={refresh} onClose={() => setTalkTo(null)} />}
      {you && seatedAt === "shoals" && <ShoalsTable table={pub.shoals} you={you} gold={gold} error={pub.shoalsError} lastXp={pub.lastXp} looks={looks} world={renderer} host={{ hex: PUB_SHOALS, hide: players.filter((p) => same(p.pos, PUB_SHOALS)).map((p) => p.id), onStand: () => standFrom("shoals") }} send={(action) => pub.send({ type: "shoals", action })} />}
      {you && seatedAt === "dice" && <DiceTable table={pub.dice} you={you} gold={gold} error={pub.diceError} lastXp={pub.lastXp} looks={looks} world={renderer} host={{ hex: PUB_DICE, hide: players.filter((p) => same(p.pos, PUB_DICE)).map((p) => p.id), onStand: () => standFrom("dice") }} send={(action) => pub.send({ type: "dice", action })} />}

      {you && <>
      <DragPanel id="pub.crew" title="Inside" foldOnPhone className="crew roster-panel">
        <CrewRoster
          you={you}
          heading={<>{players.length} in the pub</>}
          members={players.map((p) => ({ id: p.id, name: p.name, classId: p.classId, level: p.level, outfit: p.outfit, here: true }))}
          onOpen={heroSheet.toggle}
          openId={heroSheet.open}
        />
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
          : near ? <span>Beside {near.name}, {near.trade}.</span>
          : atDealer ? <span>Beside {PUB_DEALER.name}, {PUB_DEALER.trade}.</span>
          : atTrader ? (seller ? <span>At {seller.name}'s table.</span> : <span className="muted">The corner is empty.{due && ` ${due.name} is due ${dueIn(visitor.next!.startsAt - visitor.now)}.`}</span>)
          : seller ? <span className="pub-visitor">{seller.name}, {seller.trade}, is in the corner by the far wall.</span>
          : <span className="muted">Click a hex to walk. Order at the menu board; contracts are with {PUB_DEALER.short} by the pillar; the game tables are across the room.</span>}
        {near && !holdingDice && <button className="primary" disabled={!!talking} onClick={() => setTalkTo(near.id)}>Talk to {near.short}</button>}
        {atDealer && !holdingDice && <button className="primary" disabled={dealing} onClick={() => setDealing(true)}>See contracts</button>}
        <button className={atDoor ? "primary" : ""} disabled={holdingDice} onClick={onLeave}>Leave</button>
      </DragPanel>
      {atDoor && self && !holdingDice && <TileAction renderer={renderer} pos={self.pos} unitId={self.id} label="Leave" run={onLeave} />}
      {near && self && !talking && !holdingDice && <TileAction renderer={renderer} pos={self.pos} unitId={self.id} label={`Talk to ${near.short}`} run={() => setTalkTo(near.id)} />}
      {atDealer && self && !dealing && !holdingDice && <TileAction renderer={renderer} pos={self.pos} unitId={self.id} label="See contracts" run={() => setDealing(true)} />}
      </>}

      {tip && <div className="tip">{tip}</div>}
      {pub.error && (
        <div className="hut-refused panel">
          <p>{pub.error}</p>
          <button className="primary" onClick={onLeave}>Back to the Harbor</button>
        </div>
      )}
      {heroSheet.open && you && <HeroSheet id={heroSheet.open} you={you} onClose={heroSheet.close} />}
    </div>
  );
}
