// Inside the pub: a room bigger than any hut, drawn by the same renderer,
// where the crew sees each other. Stand at the menu board to order a meal
// or have a word with Old Tam; stand at the dice table to play. The
// dealer, by the pillar at the end of the bar, has word of the regulars'
// errands.

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode, type RefObject, useLayoutEffect } from "react";
import { useAudioScene } from "./audio/useAudioScene";
import { hexDistance, hexNeighbors, type HexPos } from "@gantt-quest/core";
import { PUB_BARKEEP, PUB_BARKEEP_POS, PUB_COUNTER, PUB_DEALER, PUB_DEALER_POS, PUB_DEALER_STAND, PUB_FITTINGS, PUB_GRID, PUB_LEADERBOARD, PUB_MAX_TALK, PUB_MENU, PUB_REGULAR_SPOTS, PUB_SALESMAN_POS, PUB_SEATS, PUB_TRADER, dueIn, gatherDay, poiAt, pubMountSpots, pubPath, pubRoom, PUB_MOUNT_SLOTS, regularsOn, salesman, outfitOf, type PubClientMessage, type RegularId, type XpMessage } from "@gantt-quest/world";
import { toOwned } from "./items";
import { withLook } from "./render/sprites";
import { CatchPanel } from "./CatchPanel";
import { RecordBoard } from "./CatchBook";
import { ChatInput } from "./ChatInput";
import { api, type Me, type PubWall, type RegularsView } from "./api";
import { RegularPanel } from "./RegularPanel";
import { DealerPanel } from "./board/DealerPanel";
import { DiceTable } from "./DiceTable";
import { ShoalsTable } from "./ShoalsTable";
import { CrewTable } from "./CrewTable";
import { PubLeaderboard } from "./PubLeaderboard";
import { TideTable } from "./TideTable";
import { WinBanner } from "./WinBanner";
import { SalesmanPanel } from "./SalesmanPanel";
import { useSalesman } from "./salesmanClock";
import { CrewRoster } from "./CrewRoster";
import { DragPanel } from "./DragPanel";
import { OptionsMenu } from "./OptionsMenu";
import { HudBar } from "./ui/Hud";
import { InventoryScreen } from "./InventoryScreen";
import { Logbook } from "./Logbook";
import { ThingIcon, pubIcon } from "./thingIcons";
import { TileAction } from "./TileAction";
import { WorldRenderer, type RenderState } from "./render/WorldRenderer";
import { fancy } from "./render/fancy";
import { harborOutlook, type Outlook } from "./render/harborOutlook";
import { usePub, type PubConnection, type PubTables } from "./usePub";
import type { SeatLook, StageHost } from "./useTableStage";
import { HeroSheet, useHeroSheet } from "./HeroSheet";
import { blurb, label } from "./labels";
import { xpEvents } from "./xpEvents";
import "./hut.css";
import "./pub.css";

/** Where the record fish hang, by wall slot. */
const MOUNT_SPOTS = pubMountSpots(PUB_MOUNT_SLOTS);

const same = (a: HexPos, b: HexPos) => a.q === b.q && a.r === b.r;
/** A regular's unit id in the scene. */
const regularUnit = (id: string) => `regular:${id}`;
const ROOM = pubRoom();
const DOOR = ROOM.pois.find((p) => p.kind === "door")!.pos;

// ---------- the game tables ----------

/** A table game, by the name its messages go by. */
type Game = keyof PubTables;
type TableView<G extends Game> = NonNullable<PubTables[G]>;
/** What whoever sits down is handed, the same at every table. */
interface Seat {
  you: string;
  gold: number;
  lastXp: XpMessage | null;
  looks: Record<string, SeatLook>;
  world: RefObject<WorldRenderer | null>;
  host: Omit<StageHost, "world">;
}
/** What a game's panel is given: the seat, its own table, and the way to ask for a move there. */
interface PanelProps<G extends Game> extends Seat {
  table: PubTables[G];
  error: string | null;
  send(action: Extract<PubClientMessage, { type: G }>["action"]): void;
}
/** A game table in the pub. */
interface PubTable {
  /** The game: the name its messages go by, and the kind of the place in the room you sit at to play it. */
  game: Game;
  hex: HexPos;
  /** What a pointer over its hex is told. */
  tip: string;
  /** Where you are, standing at it. */
  place: string;
  /** You are in a game of it that is under way. */
  holding(pub: PubConnection, you: string | null): boolean;
  /** Its panel, for whoever is sitting at it. */
  panel(pub: PubConnection, seat: Seat): ReactNode;
}
/** `holding`: whether someone in a seat is still in a game under way, so that walking off would forfeit it. */
function table<G extends Game>(game: G, Panel: ComponentType<PanelProps<G>>, at: { tip: string; place: string; holding(seat: TableView<G>["seats"][number]): boolean }): PubTable {
  return {
    game,
    hex: ROOM.pois.find((p) => p.kind === game)!.pos,
    tip: at.tip,
    place: at.place,
    holding: (pub, you) => {
      const view = pub.tables[game];
      return view?.phase === "playing" && (view.seats as TableView<G>["seats"][number][]).some((s) => s.id === you && at.holding(s));
    },
    panel: (pub, seat) => <Panel {...seat} table={pub.tables[game] ?? null} error={pub.tableErrors[game] ?? null} send={(action) => pub.send({ type: game, action } as PubClientMessage)} />,
  };
}
/** The pub's game tables. A new one is its panel and a line here, with its messages in packages/world/src/pub.ts. */
const TABLES: PubTable[] = [
  table("dice", DiceTable, { tip: "Dice table: a bluffing game for a small stake", place: "At the dice table.", holding: (s) => s.count > 0 }),
  table("shoals", ShoalsTable, { tip: "Shoals: lay your markers, bid, and sail without running aground", place: "At the Shoals table.", holding: (s) => s.count > 0 }),
  table("crew", CrewTable, { tip: "Cargo and Krakens: roll a ship, then gamble for a captain and cargo, and beware the Kraken", place: "At the Cargo and Krakens table.", holding: (s) => s.contending && !s.forfeited }),
  table("tide", TideTable, { tip: "Turn the Tide: a card game of one-card hands, where the Moon decides whether high or low wins", place: "At the Turn the Tide card table.", holding: (s) => !s.forfeited }),
];
/** Where a pointer over the leaderboard lands: its own hex, the two wall hexes behind it (its top is in front of them), and the floor where it is read. */
const BOARD_HEXES: HexPos[] = [PUB_LEADERBOARD.pos, { q: PUB_LEADERBOARD.pos.q, r: PUB_LEADERBOARD.pos.r - 1 }, { q: PUB_LEADERBOARD.pos.q + 1, r: PUB_LEADERBOARD.pos.r - 1 }, PUB_LEADERBOARD.stand];
const onBoard = (pos: HexPos) => BOARD_HEXES.some((h) => same(h, pos));

interface TalkLine {
  who: string;
  text: string;
}

/**
 * `resting`: the player is somewhere else, and the pub is kept, built but put away: not drawn, not connected, none
 * of its panels up. It is made that way with the game (App's Buildings), so that walking in is at once.
 */
export function PubView({ me, refresh, onLeave, resting = false }: { me: Me; refresh(): Promise<unknown>; onLeave(): void; resting?: boolean }) {
  useAudioScene("pub", !resting);
  const born = useRef(resting);
  const mount = useRef<HTMLDivElement>(null);
  const renderer = useRef<WorldRenderer | null>(null);
  const [hover, setHover] = useState<HexPos | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  /** Whether the last meal ordered gave back a gathering outing. Null until one is ordered. */
  const [rested, setRested] = useState<boolean | null>(null);
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
  const [records, setRecords] = useState(false);
  /** The crew's record fish on the wall. Read when the pub opens, and again after the board is used. */
  const [wall, setWall] = useState<PubWall | null>(null);
  const loadWall = useCallback(() => void api.pubWall().then(setWall, () => undefined), []);
  useEffect(loadWall, [loadWall]);
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
  /** The dealer's panel is open. It opens once you are beside them if you clicked them, and closes when you walk away. */
  const [dealing, setDealing] = useState(false);
  const wantDeal = useRef(false);
  const castRef = useRef(cast);
  castRef.current = cast;
  /** The leaderboard on the wall is open. It opens once you are in front of it if you clicked it, and closes when you walk away. */
  const [reading, setReading] = useState(false);
  const wantBoard = useRef(false);

  const pub = usePub(
    (id, path) => renderer.current?.playEvents([{ t: "moved", heroId: id, path }]),
    (m) => {
      renderer.current?.playEvents(xpEvents(m));
      // Your own win: your sheet's level and XP are stale.
      if (m.id === pub.you) void refresh();
    },
    (id, text) => renderer.current?.say(id, text),
    !resting,
  );
  const { you } = pub;
  // Before the room has said who is inside (the pub is loaded with the game, put away), you are stood at the door
  // as your own pack says you look: the room is then drawn once, unseen, with you in it, and walking in has no
  // figure to make. The room's own word replaces this the moment it comes.
  const myLook = useMemo(() => (me.character ? withLook(outfitOf(me.inventory.map(toOwned).filter((i) => i.equipped)), me.character.appearance) : undefined), [me.inventory, me.character]);
  const players = useMemo<typeof pub.players>(
    () => (pub.you || !me.character ? pub.players : [{ id: me.player.id, name: me.character.name, classId: me.character.class_id, level: me.character.level, xp: me.character.xp, pos: DOOR, outfit: myLook } as (typeof pub.players)[number]]),
    [pub.you, pub.players, me.character, me.player.id, myLook],
  );
  const self = players.find((p) => p.id === you);
  /** How each player is drawn, for their seat at the Shoals table. */
  const looks = useMemo(() => Object.fromEntries(players.map((p) => [p.id, { classId: p.classId, outfit: p.outfit }])), [players]);

  // Holding dice: a stray click on the floor would walk away from the table and forfeit, so the floor is ignored until the game is over.
  const holdingDice = TABLES.some((t) => t.holding(pub, you));
  const pinned = useRef(holdingDice);
  pinned.current = holdingDice;
  // Gold moves when a dice game starts and when it ends.
  const dicePhase = TABLES.map((t) => String(pub.tables[t.game]?.phase)).join("|");
  useEffect(() => {
    if (/playing|done/.test(dicePhase)) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dicePhase]);

  // (With nobody known to be inside, put away or just walked into, the room is still built: its people follow.)
  const scene = useMemo<RenderState | null>(() => {
    return {
      code: "pub",
      kind: "pub",
      you: you ?? me.player.id,
      map: ROOM,
      heroes: [
        ...players.map((p) => ({ id: p.id, classId: p.classId, pos: p.pos, label: p.name, outfit: p.outfit, level: p.level, xp: p.xp })),
        // The barkeep stands behind his bar and is drawn like anyone else.
        { id: PUB_BARKEEP.id, classId: "npc", pos: PUB_BARKEEP_POS, label: PUB_BARKEEP.name },
        // The dealer, by the pillar at the end of the bar.
        { id: PUB_DEALER.id, classId: PUB_DEALER.look, pos: PUB_DEALER_POS, label: PUB_DEALER.name },
        // A traveling salesman, when one is in, takes the corner by the far wall.
        ...(seller ? [{ id: "salesman", classId: seller.look, pos: PUB_SALESMAN_POS, label: seller.name }] : []),
        // The day's regulars, each on their own spot.
        ...cast.map((r, i) => ({ id: regularUnit(r.id), classId: r.look, pos: PUB_REGULAR_SPOTS[i].pos, label: r.name })),
      ],
      freeRoam: true,
      indoors: true,
      props: [
        ...PUB_FITTINGS.map((f) => ({ id: f.id, model: f.model, pos: { q: f.q, r: f.r }, facing: f.facing })),
        // The crew's record fish, each on its board on the wall.
        ...(wall?.mounts ?? []).flatMap((m) => {
          const spot = MOUNT_SPOTS[m.slot];
          return spot ? [{ id: `fish-${m.slot}`, model: "mounted_fish", pos: spot.pos, facing: spot.side, mount: true, x: 0, y: 0.62, fish: { species: m.species, mm: m.mm } }] : [];
        }),
        // The leaderboard for the game tables, standing against the back wall. Pushed back into the notch between the two wall faces behind it.
        { id: "leaderboard", model: "tally_board", pos: PUB_LEADERBOARD.pos, facing: 0, z: -0.4 },
      ],
    };
  }, [players, you, seller, cast, wall]);
  const latest = useRef(scene);
  latest.current = scene;
  const send = useRef(pub.send);
  send.current = pub.send;

  const heroSheet = useHeroSheet();

  useEffect(() => {
    const r = new WorldRenderer(mount.current!, { onPropClick: (id) => {
        if (pinned.current) return false;
        // A stool, wherever on it the click landed: walk onto its hex, and sit (whoever is on a stool's hex is drawn sitting on it).
        const stool = PUB_FITTINGS.find((f) => f.id === id && PUB_SEATS.some((s) => same(s, f)));
        if (stool) {
          wantTalk.current = null;
          wantDeal.current = wantBoard.current = false;
          send.current({ type: "move", to: { q: stool.q, r: stool.r } });
          return true;
        }
        // The leaderboard's model, wherever on it the click landed.
        if (id !== "leaderboard") return false;
        readBoard.current();
        return true;
      }, onHexClick: (to) => {
        if (pinned.current) return;
        // Clicking a regular walks you up beside them, and opens a word with them once there.
        const spot = PUB_REGULAR_SPOTS.findIndex((s) => same(s.pos, to));
        const who = spot >= 0 ? castRef.current[spot] : undefined;
        wantTalk.current = who?.id ?? null;
        if (who) return send.current({ type: "move", to: PUB_REGULAR_SPOTS[spot].stand });
        // Clicking the dealer (or the hex in front of them) walks you up, and opens their papers once there.
        wantDeal.current = same(to, PUB_DEALER_POS) || same(to, PUB_DEALER_STAND);
        if (wantDeal.current) return send.current({ type: "move", to: PUB_DEALER_STAND });
        // Clicking the leaderboard (its wall, or the floor in front of it) walks you up to it, and opens it once there.
        wantBoard.current = false;
        if (onBoard(to)) return readBoard.current();
        // Clicking the salesman walks you up to their table.
        send.current({ type: "move", to: sellerHere.current && same(to, PUB_SALESMAN_POS) ? PUB_TRADER : to });
      }, onHover: setHover }, { resting: born.current });
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
  // Put away as the player leaves (a layout effect: before the next place's view is made, in the same pass), with
  // whatever was open in here closed.
  useLayoutEffect(() => {
    if (!resting) return;
    renderer.current?.setResting(true);
    wantTalk.current = null;
    wantDeal.current = wantBoard.current = false;
    setHover(null);
    setTalkTo(null);
    setStood(null);
    for (const close of [setSellingFish, setRecords, setDealing, setReading, setBag, setBook]) close(false);
    heroSheet.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resting]);
  // And brought back as they walk in, fading in over where they came from (render/handover.ts).
  useEffect(() => {
    if (!resting) renderer.current?.setResting(false);
  }, [resting]);
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "end" });
  }, [pub.chat.length]);
  useEffect(() => {
    talkEnd.current?.scrollIntoView({ block: "end" });
  }, [talk.length]);

  // Dev-only handle for driving the pub from the console or a test script.
  if (import.meta.env.DEV) (window as unknown as { __pub: unknown }).__pub = { pub };

  const atCounter = !!self && same(self.pos, PUB_COUNTER);
  /** The game table whose hex you are on, sitting or stood up beside it. */
  const atTable = self ? TABLES.find((t) => same(self.pos, t.hex)) : undefined;
  const atGame = atTable?.game ?? null;
  const atDoor = !!self && same(self.pos, DOOR);
  // Sitting at a table: first person, until you stand up. Standing up walks you out to the floor beside it.
  const [stood, setStood] = useState<Game | null>(null);
  const seatedAt = atTable && stood !== atTable.game ? atTable : null;
  useEffect(() => {
    if (stood && stood !== atGame) setStood(null);
  }, [stood, atGame]);
  const standFrom = (table: PubTable) => {
    setStood(table.game);
    const from = table.hex;
    const away = hexNeighbors(from, PUB_GRID).filter((n) => ![PUB_COUNTER, ...TABLES.map((t) => t.hex), PUB_TRADER, PUB_DEALER_STAND].some((p) => same(p, n)) && !PUB_SEATS.some((s) => same(s, n)) && pubPath(ROOM, from, n));
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
  const atBoard = !!self && same(self.pos, PUB_LEADERBOARD.stand);
  /** Clicking the board: open it if you are there, or walk up and open it once there. */
  const readBoard = useRef(() => {});
  readBoard.current = () => {
    if (atBoard) return setReading(true);
    wantBoard.current = true;
    pub.send({ type: "move", to: PUB_LEADERBOARD.stand });
  };
  // Walking up to the leaderboard opens it if you clicked it; walking away puts it out of reach.
  useEffect(() => {
    if (!atBoard) setReading(false);
    else if (wantBoard.current) setReading(true);
    wantBoard.current = false;
  }, [atBoard]);
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
  /** The sea bag and the logbook, opened from the bottom bar. */
  const [bag, setBag] = useState(false);
  const [book, setBook] = useState(false);
  const hoverPoi = hover ? poiAt(ROOM, hover) : undefined;
  const hoverTable = hoverPoi && TABLES.find((t) => t.game === hoverPoi.kind);
  const tip = hoverRegular ? `${hoverRegular.name}, ${hoverRegular.trade}. Click to walk up and talk.`
    : hover && same(hover, PUB_BARKEEP_POS) ? `${PUB_BARKEEP.name}, the barkeep. Stand at the menu board to talk to him.`
    : hover && seller && same(hover, PUB_SALESMAN_POS) ? `${seller.name}, ${seller.trade}. Click to walk up and trade.`
    : hover && same(hover, PUB_DEALER_POS) ? `${PUB_DEALER.name}, ${PUB_DEALER.trade}. Click to walk up: word on the regulars' errands.`
    : hover && onBoard(hover) ? "The leaderboard: the crew's wins at the game tables. Click to walk up and read it."
    : !hoverPoi ? null
    : hoverTable ? hoverTable.tip
    : hoverPoi.kind === "counter" ? "The menu board: order here, or have a word with the barkeep"
    : hoverPoi.kind === "dealer" ? `Where you stand to deal with ${PUB_DEALER.name}: word on the regulars' errands`
    : hoverPoi.kind === "trader" ? (seller ? `Trade with ${seller.name}, ${seller.trade}` : "The corner where traveling salesmen set up. Empty for now.")
    : hoverPoi.kind === "door" ? "The door back to the Harbor"
    : null;

  const order = async (itemId: string) => {
    setBusy(true);
    setOrderError(null);
    setRested(null);
    try {
      const next = await api.pubOrder(itemId);
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

  // Put away: only the stage is kept, with the view built on it. (The stage is keyed, here and below, so it is the
  // same element either way and keeps its canvas.)
  if (resting) return <div className="run hut-view pub-view" style={{ display: "none" }}><div key="stage" className="stage" ref={mount} /></div>;
  return (
    <div className={`run hut-view pub-view${seatedAt ? " seated" : ""}`}>
      <div key="stage" className="stage" ref={mount} />

      {you && atCounter && (
        <DragPanel id="pub.bar" title="At the bar" className="story panel pub-bar">
          <h3>The board</h3>
          <p className="muted">A meal gives back one gathering outing, once a day. It gives nothing back if you have not been out gathering today, or have already eaten.</p>
          <ul className="pub-menu">
            {PUB_MENU.map((item) => (
              <li key={item.id}>
                <ThingIcon icon={pubIcon(item.id)} size={36} />
                <div className="grow">
                  <strong>{label("pub", item.id)}</strong>
                  <div className="muted">{blurb("pub", item.id)}</div>
                </div>
                <button className="small primary" disabled={busy || gold < item.price} title={gold < item.price ? "You cannot afford it" : ""} onClick={() => void order(item.id)}>
                  {item.price}g
                </button>
              </li>
            ))}
          </ul>
          {orderError && <p className="bad">{orderError}</p>}
          {rested === true && <p className="good">That set you up: one gathering outing is yours again today.</p>}
          {rested === false && <p className="muted">You eat. No outing comes back: you have not been out gathering today, or have already eaten.</p>}

          <h3>{PUB_BARKEEP.name}</h3>
          <p className="row">
            <span className="muted grow">He buys fish for the stew, at the same price every day.</span>
            <button className="small" onClick={() => setSellingFish(true)}>Sell him fish</button>
            <button className="small" onClick={() => setRecords(true)}>Crew records</button>
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

      {you && records && <RecordBoard you={you} onClose={() => (setRecords(false), loadWall())} />}
      {you && sellingFish && <CatchPanel buyer="tam" onGold={() => void refresh()} onClose={() => setSellingFish(false)} />}
      {you && atTrader && seller && <SalesmanPanel me={me} refresh={refresh} />}
      {you && atBoard && reading && <PubLeaderboard you={you} version={dicePhase} onClose={() => setReading(false)} />}
      {you && atDealer && dealing && <DealerPanel onClose={() => setDealing(false)} />}
      {you && talking && regs && <RegularPanel key={talking.regular} view={talking} handedIn={regs.handedIn} cap={regs.cap} reload={loadRegs} refresh={refresh} onClose={() => setTalkTo(null)} />}
      {you && seatedAt && seatedAt.panel(pub, { you, gold, lastXp: pub.lastXp, looks, world: renderer, host: { hex: seatedAt.hex, hide: players.filter((p) => same(p.pos, seatedAt.hex)).map((p) => p.id), onStand: () => standFrom(seatedAt) } })}
      {you && seatedAt && (() => {
        const t = pub.tables[seatedAt.game] ?? null;
        return <WinBanner key={seatedAt.game} table={t} you={you} xp={t && pub.lastXp?.id === t.winner ? pub.lastXp.amount : undefined} />;
      })()}

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

      <DragPanel id="pub.chat" title="Pub chat" foldOnPhone expandable className="chat panel harbor-chat">
        <div className="chat-lines">
          {pub.chat.length === 0 && <div className="muted">Only people inside the pub see what is said here.</div>}
          {pub.chat.map((l, i) => <div key={i} className="line hero"><strong>{l.name}: </strong>{l.text}</div>)}
          <div ref={chatEnd} />
        </div>
        <ChatInput placeholder="Say something…" onSay={(text) => pub.send({ type: "say", text })} onEmote={(emote) => pub.send({ type: "emote", emote })} />
      </DragPanel>

      {/* Put away while seated at a game table: the table's own dock has the moves and the way to stand up, and it
          drops to the bottom of the screen (--hud-h goes with the bar). It comes back on standing up. */}
      {!seatedAt && <HudBar
        me={me}
        place={
          <>
            {holdingDice ? <span>You are in a game. Walking away forfeits it.</span>
              : atDoor ? <span>The door back to the Harbor.</span>
              : atCounter ? <span>At the bar.</span>
              : atTable ? <span>{atTable.place}</span>
              : atBoard ? <span>In front of the leaderboard.</span>
              : near ? <span>Beside {near.name}, {near.trade}.</span>
              : atDealer ? <span>Beside {PUB_DEALER.name}, {PUB_DEALER.trade}.</span>
              : atTrader ? (seller ? <span>At {seller.name}'s table.</span> : <span className="muted">The corner is empty.{due && ` ${due.name} is due ${dueIn(visitor.next!.startsAt - visitor.now)}.`}</span>)
              : seller ? <span className="pub-visitor">{seller.name}, {seller.trade}, is in the corner by the far wall.</span>
              : <span className="muted">Click a hex to walk. Order at the menu board; {PUB_DEALER.short}, by the pillar, knows the regulars' errands; the game tables are across the room, with their leaderboard on the back wall.</span>}
          </>
        }
        chips={pub.status !== "open" && !pub.error ? <span className="hud-chip bad">connecting…</span> : undefined}
        onBag={() => setBag((open) => !open)}
        onBook={() => setBook(true)}
        menu={
          <OptionsMenu
            title={"The pub"}
            subtitle={me.crew?.name}
            actions={[{ label: "Leave", run: onLeave }]}
            reset={pub.status !== "open" ? undefined : {
              to: "the door",
              run: () => {
                pub.send({ type: "unstick" });
                renderer.current?.lookAt(DOOR);
              },
            }}
            resetBlocked="Waiting for the pub to connect."
          />
        }
      >
        {near && !holdingDice && <button className="primary" disabled={!!talking} onClick={() => setTalkTo(near.id)}>Talk to {near.short}</button>}
        {atDealer && !holdingDice && <button className="primary" disabled={dealing} onClick={() => setDealing(true)}>See errands</button>}
        {atBoard && !holdingDice && <button className="primary" disabled={reading} onClick={() => setReading(true)}>Read the board</button>}
        <button className={atDoor ? "primary" : ""} disabled={holdingDice} onClick={onLeave}>Leave</button>
      </HudBar>}
      {bag && me.character && <InventoryScreen me={me} refresh={refresh} onClose={() => setBag(false)} onLogbook={() => { setBag(false); setBook(true); }} />}
      {book && me.character && <Logbook me={me} refresh={refresh} onClose={() => setBook(false)} />}
      {atDoor && self && !holdingDice && <TileAction renderer={renderer} pos={self.pos} unitId={self.id} label="Leave" run={onLeave} />}
      {near && self && !talking && !holdingDice && !atBoard && <TileAction renderer={renderer} pos={self.pos} unitId={self.id} label={`Talk to ${near.short}`} run={() => setTalkTo(near.id)} />}
      {atDealer && self && !dealing && !holdingDice && <TileAction renderer={renderer} pos={self.pos} unitId={self.id} label="See errands" run={() => setDealing(true)} />}
      {atBoard && self && !reading && !holdingDice && <TileAction renderer={renderer} pos={self.pos} unitId={self.id} label="Read the board" run={() => setReading(true)} />}
      </>}

      {tip && <div className="tip">{tip}</div>}
      {pub.error && (
        <div className="hut-refused panel">
          <p>{pub.error}</p>
          <button className="primary" onClick={onLeave}>Back to the Harbor</button>
        </div>
      )}
      {heroSheet.open && you && <HeroSheet id={heroSheet.open} you={you} onClose={heroSheet.close} logbook={me.character ? { hero: me.character, open: () => { heroSheet.close(); setBook(true); } } : undefined} />}
    </div>
  );
}
