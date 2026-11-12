// The crew's shared Harbor: a walkable place where everyone present sees
// each other. Ships are moored and boarded at the docks, each member has a
// hut, and the notice board keeps the crew roster and voyage log.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { HexPos } from "@gantt-quest/core";
import { GATHER_SPOTS, GATHER_SPOT_IDS, HARBOR_APOTHECARY, HARBOR_BOARD, HARBOR_SMITHY, HARBOR_GATHER, HARBOR_NAME, HARBOR_PIERS, HARBOR_PLOTS, HARBOR_PUB, HARBOR_RING, HARBOR_SHOP, HARBOR_WORKS, MAX_PARTY, PLOT_PRICE, RESOURCE_KINDS, SHACK_COST, binFill, binNeeds, builtProjects, generateHarbor, harborPoi, hutTier, poiAt, salesman, type GatherSpot, type HarborShip, type Resources } from "@gantt-quest/world";
import { api, type Me } from "./api";
import { AccountPanel } from "./Account";
import { NoticeBoard } from "./board/NoticeBoard";
import { DragPanel } from "./DragPanel";
import { GatherPanel } from "./GatherPanel";
import { HeroSheet, useHeroSheet } from "./HeroSheet";
import { InventoryScreen } from "./InventoryScreen";
import { ShopScreen } from "./ShopScreen";
import { SparView } from "./SparView";
import { TileAction } from "./TileAction";
import { Trading } from "./TradePanel";
import { WorldRenderer, type RenderState } from "./render/WorldRenderer";
import { useHarbor } from "./useHarbor";
import { useSalesman } from "./salesmanClock";
import { WorksPanel } from "./works/WorksPanel";
import { ApothecaryPanel, SmithyPanel } from "./works/WorkshopPanels";
import { label } from "./labels";
import { xpEvents } from "./xpEvents";

const className = (id: string) => label("class", id);
const same = (a: HexPos, b: HexPos) => a.q === b.q && a.r === b.r;
/** "10 wood and 6 stone". */
const costText = (r: Resources) => {
  const parts = RESOURCE_KINDS.filter((k) => (r[k] ?? 0) > 0).map((k) => `${r[k]} ${label("resource", k).toLowerCase()}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "nothing");
};

export function HarborView({ me, refresh }: { me: Me; refresh(): Promise<unknown> }) {
  const mount = useRef<HTMLDivElement>(null);
  const renderer = useRef<WorldRenderer | null>(null);
  const [hover, setHover] = useState<HexPos | null>(null);
  const [sheet, setSheet] = useState(false);
  const [shop, setShop] = useState(false);
  const [notices, setNotices] = useState(false);
  const [spar, setSpar] = useState(false);
  const [gather, setGather] = useState<GatherSpot | null>(null);
  const [works, setWorks] = useState(false);
  const [workshop, setWorkshop] = useState<"apothecary" | "smithy" | null>(null);
  const [account, setAccount] = useState(false);
  const [tradeWith, setTradeWith] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [text, setText] = useState("");
  const [launchError, setLaunchError] = useState<string | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);

  const harbor = useHarbor(
    (id, path) => renderer.current?.playEvents([{ t: "moved", heroId: id, path }]),
    (m) => renderer.current?.playEvents(xpEvents(m)),
    (id, text) => renderer.current?.say(id, text),
  );
  // A traveling salesman in the pub is worth a mention out here.
  const salesmanNow = useSalesman(me.crew?.id);
  const send = useRef(harbor.send);
  send.current = harbor.send;
  const base = useMemo(generateHarbor, []);
  const { board, players, you } = harbor;
  const moored = board.ships.filter((s) => s.pier !== null);
  const built = builtProjects(board.works);
  const lit = built.includes("lighthouse");
  const apothecaryBuilt = built.includes("apothecary");
  const smithyBuilt = built.includes("smithy");

  // The Harbor as the renderer sees it: the fixed map plus a hut per member and a ship per moored voyage.
  const scene = useMemo<RenderState | null>(() => {
    if (!you) return null;
    const pois = [
      // The works are a building site until the lighthouse stands there.
      // So are the apothecary's and smithy's spots until the crew has paid for them.
      ...base.pois.map((p) => (p.id === "works" ? { ...p, cleared: lit } : p.id === "apothecary" ? { ...p, cleared: apothecaryBuilt } : p.id === "smithy" ? { ...p, cleared: smithyBuilt } : p)),
      // A plot someone has bought has their hut on it, or a resource bin while the shack is still to go up; the rest are staked out and for sale.
      ...HARBOR_PLOTS.map((pos, i) => {
        const owner = board.members.find((m) => m.plot === i);
        if (!owner) return harborPoi(`lot:${i}`, "lot", pos);
        if (owner.bin) return { ...harborPoi(`site:${owner.id}`, "site", pos), fill: binFill(owner.bin) };
        return { ...harborPoi(`plot:${owner.id}`, "plot", pos), tier: owner.hutTier ?? 1 };
      }),
      ...moored.map((s) => harborPoi(`ship:${s.code}`, "pier", HARBOR_PIERS[s.pier!])),
    ];
    return {
      code: "harbor",
      you,
      phase: "overworld",
      round: 0,
      map: { ...base, pois },
      heroes: players.map((p) => ({ id: p.id, classId: p.classId, pos: p.pos, label: p.name, outfit: p.outfit, asleep: !!p.bedroll && same(p.bedroll, p.pos), level: p.level, xp: p.xp })),
      turn: null,
      battle: null,
      story: null,
      npcs: {},
      freeRoam: true,
      // Bedrolls laid out by whoever is resting.
      props: players.filter((p) => p.bedroll).map((p, i) => ({ id: 9000 + i, model: "bedroll", pos: p.bedroll!, facing: 0 })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, board, players, you]);
  const latest = useRef(scene);
  latest.current = scene;
  const heroSheet = useHeroSheet();

  useEffect(() => {
    const r = new WorldRenderer(mount.current!, { onHexClick: (to) => send.current({ type: "move", to }), onHover: setHover, onHeroClick: heroSheet.onHeroClick, onHeroHover: heroSheet.onHeroHover });
    renderer.current = r;
    if (latest.current) r.setState(latest.current);
    return () => {
      r.dispose();
      renderer.current = null;
    };
  }, []);
  useEffect(() => {
    // While the sparring view is open it draws the scene itself, with its bout on top.
    if (scene && !spar) renderer.current?.setState(scene);
  }, [scene, spar]);
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "end" });
  }, [harbor.chat.length]);

  // Dev-only handle for driving the Harbor from the console or a test script.
  if (import.meta.env.DEV) (window as unknown as { __harbor: unknown }).__harbor = { harbor };
  const self = players.find((p) => p.id === you);
  const shipHere = self ? moored.find((s) => same(HARBOR_PIERS[s.pier!], self.pos)) : undefined;
  const plotIndex = self ? HARBOR_PLOTS.findIndex((p) => same(p, self.pos)) : -1;
  const hutOwner = plotIndex >= 0 ? board.members.find((m) => m.plot === plotIndex) : undefined;
  const myPlot = board.members.find((m) => m.id === you)?.plot ?? null;
  const gold = me.character?.gold ?? 0;
  const hoverPoi = scene && hover ? poiAt(scene.map, hover) : undefined;
  const visitHere = salesmanNow.here;
  const visitor = visitHere ? salesman(visitHere.salesmanId) : undefined;
  const tip = !hoverPoi ? null
    : hoverPoi.kind === "board" ? "Notice board: the crew goal and contracts"
    : hoverPoi.kind === "shop" ? "Market stall: gear, and furniture for your hut"
    : hoverPoi.kind === "ring" ? "Sparring ring"
    : hoverPoi.kind === "fishing" || hoverPoi.kind === "felling" || hoverPoi.kind === "quarry" ? `${GATHER_SPOTS[hoverPoi.kind].name}: gather hut materials`
    : hoverPoi.kind === "rocks" ? "Rocks. Ships that miss the channel find them."
    : hoverPoi.kind === "wreck" ? "A wreck on the rocks. Nobody remembers her name."
    : hoverPoi.kind === "pub" ? (visitor ? `The pub: a traveling salesman is in. ${visitor.name}, ${visitor.trade}` : "The pub: food, drink, Old Tam and the dice table")
    : hoverPoi.kind === "works" ? (lit ? "The lighthouse: crew projects" : "The works: crew projects")
    : hoverPoi.kind === "apothecary" ? (apothecaryBuilt ? "The apothecary: brew herbs and mushrooms for your next voyage" : "The apothecary's building site: a crew project at the works")
    : hoverPoi.kind === "smithy" ? (smithyBuilt ? "The smithy: sharpen weapons, reinforce armour" : "The smithy's building site: a crew project at the works")
    : hoverPoi.kind === "lot" ? (myPlot === null ? `A plot for sale: ${PLOT_PRICE} gold` : "An empty plot")
    : hoverPoi.kind === "site" ? (hoverPoi.id === `site:${you}` ? "Your plot: fill the bin and the shack goes up" : `${board.members.find((m) => `site:${m.id}` === hoverPoi.id)?.name ?? "Someone"}'s plot: building a shack`)
    : hoverPoi.kind === "plot" ? `${board.members.find((m) => `plot:${m.id}` === hoverPoi.id)?.name ?? "Someone"}'s ${hutTier(hoverPoi.tier ?? 1).name.toLowerCase()}`
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
  // After a change of gear, have the Harbor show everyone the new look.
  const refreshAll = async () => {
    await refresh();
    harbor.send({ type: "refresh" });
  };
  const atShop = !!self && same(self.pos, HARBOR_SHOP);
  const atBoard = !!self && same(self.pos, HARBOR_BOARD);
  const atRing = !!self && same(self.pos, HARBOR_RING);
  const gatherHere = self ? GATHER_SPOT_IDS.find((id) => same(self.pos, HARBOR_GATHER[id])) : undefined;
  const atPub = !!self && same(self.pos, HARBOR_PUB);
  const atWorks = !!self && same(self.pos, HARBOR_WORKS);
  const atApothecary = !!self && same(self.pos, HARBOR_APOTHECARY);
  const atSmithy = !!self && same(self.pos, HARBOR_SMITHY);
  // Resting: the server keeps the clock; this is only what it last told us, counted down for show.
  const [restReadyAt, setRestReadyAt] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    api.gather().then((g) => setRestReadyAt(g.restReadyAt), () => undefined);
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  const restIn = Math.max(0, Math.ceil((restReadyAt - Date.now()) / 60_000));
  const say_ = (text: string) => {
    setNote(text);
    setTimeout(() => setNote((n) => (n === text ? null : n)), 5000);
  };
  const restHere = async () => {
    try {
      const res = await api.rest("bedroll");
      setRestReadyAt(res.restReadyAt);
      harbor.send({ type: "bedroll" });
      say_(`You sleep a while. ${res.regained} gathering outing${res.regained === 1 ? "" : "s"} back: ${res.stamina.left} of ${res.stamina.max} left today.`);
    } catch (e) {
      say_((e as Error).message);
      api.gather().then((g) => setRestReadyAt(g.restReadyAt), () => undefined);
    }
  };
  const buyPlot = async (plot: number) => {
    try {
      await api.buyPlot(plot);
      await refresh();
      say_(`The plot is yours. Fill the resource bin on it with ${costText(SHACK_COST)} and the shack goes up.`);
    } catch (e) {
      say_((e as Error).message);
    }
  };
  // The bin on your own plot, while the shack is still to go up, and what you hold that could go in it.
  const myBin = hutOwner?.id === you ? hutOwner.bin : undefined;
  const [held, setHeld] = useState<Resources | null>(null);
  useEffect(() => {
    if (!myBin) return;
    let live = true;
    api.hut().then((h) => live && setHeld(h.resources), () => undefined);
    return () => {
      live = false;
    };
  }, [!!myBin]);
  const fillBin = async () => {
    try {
      const res = await api.fillBin();
      setHeld((h) => {
        const next = { ...(h ?? {}) };
        for (const k of RESOURCE_KINDS) if (res.put[k]) next[k] = Math.max(0, (next[k] ?? 0) - res.put[k]!);
        return next;
      });
      await refresh();
      say_(res.bin === null ? `In go ${costText(res.put)}. The bin is full and the shack goes up!` : `In go ${costText(res.put)}. The bin still wants ${costText(binNeeds(res.bin))}.`);
    } catch (e) {
      say_((e as Error).message);
    }
  };
  // Remembered so that leaving a hut or the pub puts you back at its door; without it you come back at the usual spot.
  const goInside = (at: string, hash: string) => {
    try {
      sessionStorage.setItem("gq.harborAt", at);
    } catch {
      // Storage is off: the usual spot it is.
    }
    location.hash = hash;
  };
  // The place under your feet and the one thing to do there, shown in the bar below and floated over the hex.
  const here: { title: ReactNode; label: string; run(): void; quiet?: boolean } | null =
    atBoard ? { title: "The notice board", label: "Read the notice board", run: () => setNotices(true) }
    : shipHere ? { title: `${shipHere.captain}'s ship · ${shipHere.aboard.length}/${MAX_PARTY} aboard`, label: "Walk aboard", run: () => board_(shipHere) }
    : atShop ? { title: "The market stall", label: "Browse the wares", run: () => setShop(true) }
    : atRing ? { title: "The sparring ring", label: "Spar", run: () => setSpar(true) }
    : gatherHere ? {
        title: GATHER_SPOTS[gatherHere].name,
        label: gatherHere === "fishing" ? "Cast a line" : gatherHere === "felling" ? "Take up the axe" : "Work the seam",
        run: () => setGather(gatherHere),
      }
    : atPub ? { title: visitor ? <>The pub <span className="pub-visitor">· {visitor.name}, {visitor.trade}, is in</span></> : "The pub", label: "Go in", run: () => goInside("pub", "pub") }
    : atWorks ? { title: lit ? "The lighthouse" : "The works", label: "See the crew's projects", run: () => setWorks(true) }
    // A workshop still to be built points to the works, where the crew pays for it.
    : atApothecary ? (apothecaryBuilt
        ? { title: "The apothecary", label: "Brew something", run: () => setWorkshop("apothecary") }
        : { title: <>The apothecary's building site <span className="muted">· paid for at the works</span></>, label: "See the crew's projects", run: () => setWorks(true) })
    : atSmithy ? (smithyBuilt
        ? { title: "The smithy", label: "Work your gear", run: () => setWorkshop("smithy") }
        : { title: <>The smithy's building site <span className="muted">· paid for at the works</span></>, label: "See the crew's projects", run: () => setWorks(true) })
    : myBin ? {
        title: (
          <>Your plot <span className="muted">· the shack's resource bin: {RESOURCE_KINDS.filter((k) => SHACK_COST[k]).map((k) => `${myBin[k] ?? 0}/${SHACK_COST[k]} ${label("resource", k).toLowerCase()}`).join(", ")}{held ? ` · you hold ${RESOURCE_KINDS.filter((k) => SHACK_COST[k]).map((k) => `${held[k] ?? 0} ${label("resource", k).toLowerCase()}`).join(", ")}` : ""}</span></>
        ),
        label: "Put materials in the bin",
        run: () => void fillBin(),
      }
    // Someone else's plot with only a bin on it: nothing to do there yet.
    : hutOwner?.bin ? null
    : hutOwner ? {
        title: <>{hutOwner.id === you ? "Your hut" : `${hutOwner.name}'s hut`} <span className="muted">· {hutTier(hutOwner.hutTier ?? 1).name}</span></>,
        label: hutOwner.id === you ? "Enter your hut" : `Enter ${hutOwner.name}'s hut`,
        run: () => goInside(String(plotIndex), `hut/${hutOwner.id}`),
      }
    : plotIndex >= 0 && myPlot === null ? {
        title: <>An empty plot <span className="muted">· {gold >= PLOT_PRICE ? "yours to build on" : `you have ${gold} of ${PLOT_PRICE} gold`}</span></>,
        label: `Buy this plot · ${PLOT_PRICE} gold`,
        run: () => void buyPlot(plotIndex),
      }
    : plotIndex >= 0 ? null
    // Anywhere else is ground you can sleep on.
    : self ? {
        title: restIn > 0 ? <>Your bedroll <span className="muted">· you can rest again in {restIn} min</span></> : "Open ground",
        label: restIn > 0 ? `Rest in ${restIn} min` : "Lay out your bedroll and rest",
        run: () => void restHere(),
        // Offered in the bar only: a button over your head on every bit of open ground would be noise.
        quiet: true,
      }
    : null;
  // Anything laid over the Harbor, the sparring bout included, takes the floating button away.
  const panelOpen = sheet || shop || notices || spar || !!gather || works || !!workshop || account || !!tradeWith;
  const error = harbor.error ?? launchError;

  return (
    <div className="run harbor-view">
      <div className="stage" ref={mount} />
      <div className="topbar">
        <strong>{HARBOR_NAME}</strong>
        <span className="muted">{harbor.crew?.name ?? me.crew?.name}</span>
        <span className="spacer" />
        {harbor.status !== "open" && <span className="bad">connecting…</span>}
        {harbor.crew && <span className="muted wide-only">Invite code {harbor.crew.id}</span>}
        <button className="small" onClick={copy}>{copied ? "Copied" : <>Invite<span className="wide-only"> link</span></>}</button>
        <button className={`small ${me.player.email ? "" : "nudge"}`} title={me.player.email ?? "Guest account: not saved yet"} onClick={() => setAccount(true)}>
          {me.player.email ? "Account" : "Save progress"}
        </button>
        {me.isAdmin && <button className="small" onClick={() => (location.hash = "#admin")}>Admin</button>}
        <button className="small" onClick={() => setSheet(true)}>
          Inventory<span className="wide-only"> · {me.character?.name}</span>{me.character && me.character.unspent_points > 0 ? " ●" : ""}
        </button>
      </div>

      <DragPanel id="harbor.docks" title="Docks" foldOnPhone className="story panel docks">
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
      </DragPanel>

      <DragPanel id="harbor.crew" title="Crew" foldOnPhone className="crew">
        <div className="panel">
          <h3>{players.length} here now</h3>
          <ul className="roster">
            {board.members.map((m) => {
              const here = players.some((p) => p.id === m.id);
              return (
                <li key={m.id} className={here ? "" : "away"}>
                  <span><i className={`dot ${here ? "on" : ""}`} /> <strong>{m.name}</strong>{m.id === you && <span className="tag">you</span>}</span>
                  <span className="muted">
                    {className(m.classId)} · {m.level}
                    {m.id !== you && <button className="small trade-btn" title={`Give or trade with ${m.name}`} onClick={() => setTradeWith(m.id)}>Trade</button>}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </DragPanel>

      <DragPanel id="harbor.chat" title="Crew chat" foldOnPhone className="chat panel harbor-chat">
        <div className="chat-lines">
          {harbor.chat.length === 0 && <div className="muted">Crew chat. Only people in the Harbor right now see it.</div>}
          {harbor.chat.map((l, i) => <div key={i} className="line hero"><strong>{l.name}: </strong>{l.text}</div>)}
          <div ref={chatEnd} />
        </div>
        <div className="row">
          <input value={text} maxLength={200} placeholder="Say something to the crew…" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && say()} />
          <button disabled={!text.trim()} onClick={say}>Say</button>
        </div>
      </DragPanel>

      <DragPanel id="harbor.turn" title="Here" compact className="turnbar panel">
        {here ? (
          <>
            <span>{here.title}</span>
            <button className="primary" onClick={here.run}>{here.label}</button>
          </>
        ) : (
          <span className="muted">Click a hex to walk. Ships are boarded at the piers; gear is traded at the market stall.</span>
        )}
      </DragPanel>

      {here && !here.quiet && self && !panelOpen && <TileAction renderer={renderer} pos={self.pos} unitId={self.id} label={here.label} run={here.run} />}
      {tip && <div className="tip">{tip}</div>}
      {error && <div className="toast">{error}</div>}
      {note && !error && <div className="toast note">{note}</div>}
      {sheet && me.character && <InventoryScreen me={me} refresh={refreshAll} onClose={() => setSheet(false)} />}
      {account && <AccountPanel me={me} refresh={refresh} onClose={() => setAccount(false)} />}
      {notices && <NoticeBoard refresh={refresh} onClose={() => setNotices(false)} />}
      {works && <WorksPanel works={board.works} refresh={refresh} onClose={() => setWorks(false)} />}
      {workshop === "apothecary" && <ApothecaryPanel onClose={() => setWorkshop(null)} />}
      {workshop === "smithy" && <SmithyPanel refresh={refreshAll} onClose={() => setWorkshop(null)} />}
      {spar && scene && me.character && <SparView me={me} scene={scene} renderer={renderer} onClose={() => setSpar(false)} />}
      {gather && me.character && <GatherPanel spot={gather} onClose={() => setGather(null)} />}
      {shop && me.character && <ShopScreen me={me} refresh={refreshAll} onClose={() => setShop(false)} />}
      {me.character && <Trading me={me} partners={board.members.filter((m) => m.id !== you)} withId={tradeWith} onWith={setTradeWith} refresh={refresh} />}
      {heroSheet.open && you && !spar && <HeroSheet id={heroSheet.open} you={you} pinned={heroSheet.pinned} onClose={heroSheet.close} />}
    </div>
  );
}
