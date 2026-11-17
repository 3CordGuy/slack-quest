// The crew's shared Harbor: a walkable place where everyone present sees
// each other. Ships are moored and boarded at the docks, each member has a
// hut, and the notice board carries the news of each release of the game (with
// a bouncing "!" over it until you have read the newest).

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAudioScene } from "./audio/useAudioScene";
import type { HexPos } from "@gantt-quest/core";
import { GATHER_SPOTS, GATHER_SPOT_IDS, HARBOR_APOTHECARY, HARBOR_BOARD, HARBOR_CAVE, HARBOR_GALLEY, HARBOR_LIGHTHOUSE, HARBOR_SMITHY, HARBOR_GATHER, HARBOR_NAME, HARBOR_PIERS, HARBOR_PLOTS, HARBOR_PLOT_FACING, HARBOR_PUB, HARBOR_RING, HARBOR_SHOP, HARBOR_SPAWN, HARBOR_WORKS, MAX_PARTY, PLOT_PRICE, RESOURCE_KINDS, SHACK_COST, binFill, binNeeds, builtProjects, BOOK_TITLE, fishSpotAt, harborDoor, seaEdge, tileAt, waterSpotAt, type FishSpot, FISH_SPOTS, generateHarbor, projectById, projectProgress, harborPoi, hutTier, poiAt, salesman, type GatherSpot, type HarborShip, type Resources } from "@gantt-quest/world";
import { api, type Me } from "./api";
import { CatchPanel } from "./CatchPanel";
import { AccountPanel } from "./Account";
import { CrewRoster, type RosterMember } from "./CrewRoster";
import { NoticeBoard } from "./board/NoticeBoard";
import { AttentionMark } from "./AttentionMark";
import { PlaceTitle } from "./PlaceTitle";
import { hasUnseen } from "../releases";
import { OptionsMenu } from "./OptionsMenu";
import { DragPanel } from "./DragPanel";
import { HudBar } from "./ui/Hud";
import { Logbook } from "./Logbook";
import { GatherPanel } from "./GatherPanel";
import { HeroSheet, useHeroSheet } from "./HeroSheet";
import { LOOK_CHANGED } from "./ChangeLook";
import { InventoryScreen } from "./InventoryScreen";
import { ShopScreen } from "./ShopScreen";
import { TileAction } from "./TileAction";
import { Trading } from "./TradePanel";
import { WorldRenderer, type RenderState } from "./render/WorldRenderer";
import { useHarbor } from "./useHarbor";
import { useSalesman } from "./salesmanClock";
import { WorksPanel } from "./works/WorksPanel";
import { label } from "./labels";
import { xpEvents } from "./xpEvents";

const same = (a: HexPos, b: HexPos) => a.q === b.q && a.r === b.r;
/**
 * The Harbor opens seen from a little east of south, about eighteen degrees off the rows of hexes: its streets
 * and lanes are laid along those rows, and squared to the screen they look ruled. From here the buildings on
 * the north side of the High Street and along both hut lanes show their fronts.
 */
const HARBOR_VIEW_YAW = 0.32;

/** "10 wood and 6 stone". */
const costText = (r: Resources) => {
  const parts = RESOURCE_KINDS.filter((k) => (r[k] ?? 0) > 0).map((k) => `${r[k]} ${label("resource", k).toLowerCase()}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "nothing");
};

export function HarborView({ me, refresh }: { me: Me; refresh(): Promise<unknown> }) {
  useAudioScene("harbor");
  const mount = useRef<HTMLDivElement>(null);
  const renderer = useRef<WorldRenderer | null>(null);
  const [hover, setHover] = useState<HexPos | null>(null);
  const [sheet, setSheet] = useState(false);
  const [book, setBook] = useState(false);
  const [shop, setShop] = useState(false);
  const [notices, setNotices] = useState(false);
  const [gather, setGather] = useState<GatherSpot | null>(null);
  const [fishmonger, setFishmonger] = useState(false);
  const [works, setWorks] = useState(false);
  const [account, setAccount] = useState(false);
  const [tradeWith, setTradeWith] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [text, setText] = useState("");
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
  /** Your gathering outings left today, drawn as lightning bolts on your plate. Read on the way in and after anything that spends or restores them. */
  const [stamina, setStamina] = useState<{ left: number; max: number } | null>(null);
  const { board, players, you } = harbor;
  /** Go to where a crewmate is: the zone they are on (beside them), if the server says they can be joined. */
  const teleportTo = (id: string) => {
    api.teleport(id).then(({ zone, name }) => {
      if (!zone) return setNote(`${name} is not out on a map.`);
      try {
        sessionStorage.setItem("gq.zone.near", id);
      } catch {
        // Storage is off: they arrive at the map's start.
      }
      location.hash = `zone/${zone}`;
    }, (e: Error) => setNote(e.message));
  };
  // The whole crew, with whoever is walking the Harbor right now marked here (and drawn in what they wear),
  // and whoever is out on a map marked as that.
  const roster: RosterMember[] = useMemo(() => board.members.map((m) => {
    const p = players.find((x) => x.id === m.id);
    return { id: m.id, name: m.name, classId: m.classId, level: p?.level ?? m.level, here: !!p && !m.zone, outfit: p?.outfit, tags: m.zone ? [m.zone.fighting ? "in a fight" : "on a map"] : undefined };
  }), [board.members, players]);
  const hereCount = roster.filter((m) => m.here).length;
  const moored = board.ships.filter((s) => s.pier !== null);
  const built = builtProjects(board.works);
  const lit = built.includes("lighthouse");
  const apothecaryBuilt = built.includes("apothecary");
  const smithyBuilt = built.includes("smithy");
  const galleyBuilt = built.includes("galley");
  // How far the crew has got with the lighthouse, which sets which stage of building is drawn on its spit.
  const projectFill = (id: string) => {
    if (built.includes(id)) return 1;
    const paid = board.works?.projects.find((p) => p.id === id)?.paid;
    return paid ? Math.round(projectProgress(projectById(id)!, paid) * 100) / 100 : 0;
  };
  const lighthouseFill = projectFill("lighthouse");

  // The Harbor as the renderer sees it: the fixed map plus a hut per member and a ship per moored voyage.
  const scene = useMemo<RenderState | null>(() => {
    if (!you) return null;
    const pois = [
      // The lighthouse's spit, and the apothecary's, smithy's and galley's spots, are building sites until the crew has paid for them.
      ...base.pois.map((p) => (p.id === "lighthouse" ? { ...p, cleared: lit, fill: lighthouseFill } : p.id === "apothecary" ? { ...p, cleared: apothecaryBuilt, fill: projectFill("apothecary") } : p.id === "smithy" ? { ...p, cleared: smithyBuilt, fill: projectFill("smithy") } : p.id === "galley" ? { ...p, cleared: galleyBuilt, fill: projectFill("galley") } : p)),
      // A plot someone has bought has their hut on it, or a resource bin while the shack is still to go up; the rest are staked out and for sale.
      ...HARBOR_PLOTS.map((pos, i) => {
        const owner = board.members.find((m) => m.plot === i);
        const facing = HARBOR_PLOT_FACING[i];
        if (!owner) return harborPoi(`lot:${i}`, "lot", pos, facing);
        if (owner.bin) return { ...harborPoi(`site:${owner.id}`, "site", pos, facing), fill: binFill(owner.bin) };
        return { ...harborPoi(`plot:${owner.id}`, "plot", pos, facing), tier: owner.hutTier ?? 1 };
      }),
      ...moored.map((s) => harborPoi(`ship:${s.code}`, "pier", HARBOR_PIERS[s.pier!])),
    ];
    return {
      code: "harbor",
      you,
      phase: "overworld",
      round: 0,
      map: { ...base, pois },
      heroes: players.map((p) => ({ id: p.id, classId: p.classId, pos: p.pos, label: p.name, outfit: p.outfit, asleep: !!p.bedroll && same(p.bedroll, p.pos), rod: p.fishing ? (p.gilded ? "gilded" : true) : false, boat: tileAt(base, p.pos)?.biome === "water" ? p.vessel ?? "barrel" : undefined, level: p.level, xp: p.xp })),
      turn: null,
      story: null,
      npcs: {},
      freeRoam: true,
      homeYaw: HARBOR_VIEW_YAW,
      // Bedrolls laid out by whoever is resting.
      props: players.filter((p) => p.bedroll).map((p, i) => ({ id: 9000 + i, model: "bedroll", pos: p.bedroll!, facing: 0 })),
      stamina: stamina ?? undefined,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, board, players, you, stamina]);
  const latest = useRef(scene);
  latest.current = scene;
  const heroSheet = useHeroSheet();

  useEffect(() => {
    // A click anywhere on a building is a walk to its door.
    const r = new WorldRenderer(mount.current!, { onHexClick: (to) => send.current({ type: "move", to: harborDoor(to) ?? to }), onHover: setHover });
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
  // With the bag open your hero turns to face you, so you can see what they are wearing.
  useEffect(() => {
    renderer.current?.setFacingFront(sheet);
  }, [sheet]);
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
  // Pointing at the ground a building stands on is pointing at the building.
  const hoverPoi = scene && hover ? poiAt(scene.map, harborDoor(hover) ?? hover) : undefined;
  const visitHere = salesmanNow.here;
  const visitor = visitHere ? salesman(visitHere.salesmanId) : undefined;
  /** A release with notes this player has not read: the board wears a "!". An older server sends no seenRelease, and then there is none. */
  const unseen = me.seenRelease !== undefined && hasUnseen(me.seenRelease);
  const tip = !hoverPoi ? null
    : hoverPoi.kind === "cave" ? "The Haunted Caverns: go down and fight what lurks in the dark"
    : hoverPoi.kind === "board" ? (unseen ? "Notice board: news of what has changed. Something new is pinned up!" : "Notice board: news of what has changed")
    : hoverPoi.kind === "shop" ? "Market stall: gear, and furniture for your hut"
    : hoverPoi.kind === "ring" ? "Sparring ring: being rebuilt"
    : hoverPoi.kind === "fishing" ? "The fishmonger's stall: sell your catch at today's prices. Cast a line here too, or from the end of any pier"
    : hoverPoi.kind === "felling" || hoverPoi.kind === "quarry" ? `${GATHER_SPOTS[hoverPoi.kind].name}: gather hut materials`
    : hoverPoi.kind === "rocks" ? "Rocks. Ships that miss the channel find them."
    : hoverPoi.kind === "wreck" ? "A wreck on the rocks. Nobody remembers her name."
    : hoverPoi.kind === "pub" ? (visitor ? `The pub: a traveling salesman is in. ${visitor.name}, ${visitor.trade}` : "The pub: food, drink, Old Tam and the dice table")
    : hoverPoi.kind === "works" ? "The works: crew projects"
    : hoverPoi.kind === "lighthouse" ? (lit ? "The lighthouse: the crew's atlas is kept in its lamp room, with the whole world to see from up there" : lighthouseFill > 0 ? "The lighthouse going up: the crew's atlas is kept out here on the point" : "A bare point over the wreck, where the lighthouse will stand: the crew's atlas is kept out here")
    : hoverPoi.kind === "apothecary" ? (apothecaryBuilt ? "The apothecary: potions and flasks, bought or brewed, and a keeper to haggle with" : "The apothecary's building site: a crew project at the works")
    : hoverPoi.kind === "smithy" ? (smithyBuilt ? "The smithy: arms and armour off the rack, your own sharpened or reinforced, and a smith to haggle with" : "The smithy's building site: a crew project at the works")
    : hoverPoi.kind === "galley" ? (galleyBuilt ? "The galley: go in to cook chowder and stores into the crew's larder" : "The galley's building site: a crew project at the works")
    : hoverPoi.kind === "lot" ? (myPlot === null ? `A plot for sale: ${PLOT_PRICE} gold` : "An empty plot")
    : hoverPoi.kind === "site" ? (hoverPoi.id === `site:${you}` ? "Your plot: fill the bin and the shack goes up" : `${board.members.find((m) => `site:${m.id}` === hoverPoi.id)?.name ?? "Someone"}'s plot: building a shack`)
    : hoverPoi.kind === "plot" ? `${board.members.find((m) => `plot:${m.id}` === hoverPoi.id)?.name ?? "Someone"}'s ${hutTier(hoverPoi.tier ?? 1).name.toLowerCase()}`
    : hoverPoi.kind === "pier" ? `${moored.find((s) => `ship:${s.code}` === hoverPoi.id)?.captain ?? "A"}'s ship`
    : null;

  /** The place's name alone, hung over it on a plate while it is pointed at (the tip says what it is for). */
  const ownerOf = (prefix: string) => board.members.find((m) => `${prefix}:${m.id}` === hoverPoi?.id);
  const title = !hoverPoi ? null
    : hoverPoi.kind === "cave" ? "The Haunted Caverns"
    : hoverPoi.kind === "board" ? "Notice Board"
    : hoverPoi.kind === "shop" ? "Market Stall"
    : hoverPoi.kind === "ring" ? "Sparring Ring"
    : hoverPoi.kind === "fishing" ? "The Fishmonger"
    : hoverPoi.kind === "felling" ? "The Tree Line"
    : hoverPoi.kind === "quarry" ? "The Quarry"
    : hoverPoi.kind === "wreck" ? "The Wreck"
    : hoverPoi.kind === "pub" ? "The Pub"
    : hoverPoi.kind === "works" ? "The Works"
    : hoverPoi.kind === "lighthouse" ? (lit || lighthouseFill > 0 ? "The Lighthouse" : "Lighthouse Point")
    : hoverPoi.kind === "apothecary" ? "The Apothecary"
    : hoverPoi.kind === "smithy" ? "The Smithy"
    : hoverPoi.kind === "galley" ? "The Galley"
    : hoverPoi.kind === "lot" ? "Plot for Sale"
    : hoverPoi.kind === "site" ? (hoverPoi.id === `site:${you}` ? "Your Plot" : `${ownerOf("site")?.name ?? "Someone"}'s Plot`)
    : hoverPoi.kind === "plot" ? (hoverPoi.id === `plot:${you}` ? `Your ${hutTier(hoverPoi.tier ?? 1).name}` : `${ownerOf("plot")?.name ?? "Someone"}'s ${hutTier(hoverPoi.tier ?? 1).name}`)
    : hoverPoi.kind === "pier" ? `${moored.find((s) => `ship:${s.code}` === hoverPoi.id)?.captain ?? "A"}'s Ship`
    : null;
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
  // And after a new look, saved from their sheet (ChangeLook).
  const refreshRef = useRef(refreshAll);
  refreshRef.current = refreshAll;
  useEffect(() => {
    const onLook = () => void refreshRef.current();
    window.addEventListener(LOOK_CHANGED, onLook);
    return () => window.removeEventListener(LOOK_CHANGED, onLook);
  }, []);
  const atShop = !!self && same(self.pos, HARBOR_SHOP);
  const atBoard = !!self && same(self.pos, HARBOR_BOARD);
  const atRing = !!self && same(self.pos, HARBOR_RING);
  // Fishing is from any pier head as well as the shore spot.
  // Afloat (a boat under them on a water hex): the water's own spot, or the open sea from the edge in a rowboat.
  const onWater = !!self && tileAt(base, self.pos)?.biome === "water";
  const afloatSpot: FishSpot | null = !self || !onWater ? null : self.vessel === "rowboat" && seaEdge(base, self.pos) ? "sea" : waterSpotAt(base, self.pos);
  const pierHere: FishSpot | null = self ? fishSpotAt(self.pos) ?? afloatSpot : null;
  const gatherHere = self ? (GATHER_SPOT_IDS.find((id) => same(self.pos, HARBOR_GATHER[id])) ?? (pierHere ? "fishing" : undefined)) : undefined;
  const atPub = !!self && same(self.pos, HARBOR_PUB);
  const atCave = !!self && same(self.pos, HARBOR_CAVE);
  const atWorks = !!self && same(self.pos, HARBOR_WORKS);
  const atApothecary = !!self && same(self.pos, HARBOR_APOTHECARY);
  const atSmithy = !!self && same(self.pos, HARBOR_SMITHY);
  const atGalley = !!self && same(self.pos, HARBOR_GALLEY);
  const atLighthouse = !!self && same(self.pos, HARBOR_LIGHTHOUSE);
  // Resting: the server keeps the clock; this is only what it last told us, counted down for show.
  const [restReadyAt, setRestReadyAt] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    api.gather().then((g) => {
      setRestReadyAt(g.restReadyAt);
      setStamina({ left: g.stamina.left, max: g.stamina.max });
    }, () => undefined);
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
      setStamina({ left: res.stamina.left, max: res.stamina.max });
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
  /** Down into the caves: the crew's cave if one is still being fought through, else a fresh one. Leaving it comes back to the mouth. */
  const goDown = () => {
    api.caves().then(({ code }) => goInside(`${HARBOR_CAVE.q},${HARBOR_CAVE.r}`, `zone/${code}`), (e: Error) => setNote(e.message));
  };
  // Voyages and sparring are shut while they are rebuilt on the new combat (fights on the tiles
  // themselves): each place says so and offers nothing to do.
  const shut = (title: ReactNode) => ({ title, label: "", run: () => {}, closed: true });
  // The place under your feet and the one thing to do there, shown in the bar below and floated over the hex.
  const here: { title: ReactNode; label: string; run(): void; quiet?: boolean; closed?: boolean; also?: { label: string; run(): void } } | null =
    atBoard ? { title: unseen ? "The notice board · something new is pinned up" : "The notice board", label: "Read the notice board", run: () => setNotices(true) }
    : atCave ? { title: <>The Haunted Caverns <span className="muted">· something lurks in the dark</span></>, label: "Go down", run: goDown }
    : shipHere ? { ...shut(<>{shipHere.captain}'s ship <span className="muted">· laid up while voyages are rebuilt</span></>), also: pierHere ? { label: "Cast a line", run: () => setGather("fishing") } : undefined }
    : atShop ? { title: "The market stall", label: "Browse the wares", run: () => setShop(true) }
    : atRing ? shut(<>The sparring ring <span className="muted">· being rebuilt for a new way of fighting. Coming soon.</span></>)
    : gatherHere ? {
        title: gatherHere === "fishing" && pierHere ? FISH_SPOTS[pierHere].name : GATHER_SPOTS[gatherHere].name,
        label: gatherHere === "fishing" ? (pierHere === "sea" ? "Row out and cast" : "Cast a line") : gatherHere === "felling" ? "Take up the axe" : "Work the seam",
        run: () => setGather(gatherHere),
        // The shore spot is also the fishmonger's stall.
        also: pierHere === "shore" ? { label: "The fishmonger", run: () => setFishmonger(true) } : undefined,
      }
    : atPub ? { title: visitor ? <>The pub <span className="pub-visitor">· {visitor.name}, {visitor.trade}, is in</span></> : "The pub", label: "Go in", run: () => goInside("pub", "pub") }
    : atWorks ? { title: "The works", label: "See the crew's projects", run: () => setWorks(true) }
    // The way into the atlas: from the lamp room once the tower is up, from the bare point until then (where the works is still a step away).
    : atLighthouse ? {
        title: lit ? <>The lighthouse <span className="muted">· the crew's atlas is kept in its lamp room</span></> : <>The lighthouse's point <span className="muted">· the crew's atlas is kept out here. The tower is paid for at the works.</span></>,
        label: "Open the atlas",
        run: () => (location.hash = "atlas"),
        also: lit ? undefined : { label: "See the crew's projects", run: () => setWorks(true) },
      }
    // A workshop still to be built points to the works, where the crew pays for it.
    : atApothecary ? (apothecaryBuilt
        ? { title: "The apothecary", label: "Go in", run: () => goInside(`${HARBOR_APOTHECARY.q},${HARBOR_APOTHECARY.r}`, "apothecary") }
        : { title: <>The apothecary's building site <span className="muted">· paid for at the works</span></>, label: "See the crew's projects", run: () => setWorks(true) })
    : atSmithy ? (smithyBuilt
        ? { title: "The smithy", label: "Go in", run: () => goInside(`${HARBOR_SMITHY.q},${HARBOR_SMITHY.r}`, "smithy") }
        : { title: <>The smithy's building site <span className="muted">· paid for at the works</span></>, label: "See the crew's projects", run: () => setWorks(true) })
    : atGalley ? (galleyBuilt
        ? { title: "The galley", label: "Go in", run: () => goInside(`${HARBOR_GALLEY.q},${HARBOR_GALLEY.r}`, "galley") }
        : { title: <>The galley's building site <span className="muted">· paid for at the works</span></>, label: "See the crew's projects", run: () => setWorks(true) })
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
    // Out on the water there is nothing to do but row, or fish.
    : onWater ? null
    // Anywhere else is ground you can sleep on.
    : self ? {
        title: restIn > 0 ? <>Your bedroll <span className="muted">· you can rest again in {restIn} min</span></> : "Open ground",
        label: restIn > 0 ? `Rest in ${restIn} min` : "Lay out your bedroll and rest",
        run: () => void restHere(),
        // Offered in the bar only: a button over your head on every bit of open ground would be noise.
        quiet: true,
      }
    : null;
  // Anything laid over the Harbor takes the floating button away.
  const panelOpen = sheet || book || shop || notices || !!gather || fishmonger || works || account || !!tradeWith;
  const error = harbor.error;

  return (
    <div className="run harbor-view">
      <div className="stage" ref={mount} />
      {/* Down the left-hand side: the docks at the top, the crew's cards in the middle (the talk sits under them). */}
      <div className="hud-left">
        <DragPanel id="harbor.docks" title="Docks" foldOnPhone className="story panel docks">
          <p className="muted">The crew's atlas is kept out at the lighthouse: everywhere you have found, and the routes that run on from there. Walk out to the point to open it.</p>
          <p><button className="small" onClick={() => renderer.current?.lookAt(HARBOR_LIGHTHOUSE)}>Show me the lighthouse</button></p>
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

        <div className="crew roster-panel crew-cards">
          <CrewRoster
            you={you}
            heading={<>{hereCount} of {roster.length} here</>}
            members={roster}
            onOpen={heroSheet.toggle}
            openId={heroSheet.open}
            menu={(m) => {
              if (m.id === you) return [];
              const away = board.members.find((x) => x.id === m.id)?.zone;
              return [
                { label: "Trade", run: () => setTradeWith(m.id) },
                { label: "Teleport to them", blocked: away?.fighting ? "In a fight" : away ? undefined : m.here ? "Already here with you" : "Not out on a map", run: () => teleportTo(m.id) },
              ];
            }}
          />
        </div>
      </div>

      <DragPanel id="harbor.chat" title="Crew chat" foldOnPhone expandable className="chat panel harbor-chat">
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

      {/* Put away while a gathering outing (fishing, felling, the quarry) has the view: nothing on it is any use
          there, and the game's own controls drop to the bottom of the screen (--hud-h goes with it). */}
      {!(gather && me.character) && <HudBar
        me={me}
        place={here && !here.quiet ? here.title : undefined}
        rest={onWater ? undefined : {
          run: () => void restHere(),
          disabled: restIn > 0,
          hint: restIn > 0 ? `Rest: you can lay out your bedroll again in ${restIn} min` : "Rest: lay out your bedroll here and sleep a while. Gathering outings come back.",
        }}
        meter={stamina ? { name: "Energy", note: "gathering outings left today", now: stamina.left, max: stamina.max, kind: "stamina" } : undefined}
        chips={harbor.status === "paused" ? <span className="hud-chip">away</span> : harbor.status !== "open" ? <span className="hud-chip bad">connecting…</span> : undefined}
        // While the trade table is open it has the bag beside it already.
        onBag={() => !tradeWith && setSheet((open) => !open)}
        onBook={() => setBook(true)}
        menu={
          <OptionsMenu
            title={HARBOR_NAME}
            subtitle={<>{harbor.crew?.name ?? me.crew?.name}{harbor.crew && <> · invite code {harbor.crew.id}</>}</>}
            actions={[
              { label: copied ? "Invite link copied" : "Copy the crew's invite link", run: () => void copy(), stay: true },
              { label: me.player.email ? "Account" : "Save your progress", hint: me.player.email ?? "Guest account: not saved yet", tone: me.player.email ? undefined : "nudge", run: () => setAccount(true) },
              ...(me.isAdmin ? [{ label: "Admin", run: () => { location.hash = "#admin"; } }] : []),
            ]}
            reset={harbor.status !== "open" ? undefined : {
              to: "the plaza, where everyone arrives",
              run: () => {
                harbor.send({ type: "unstick" });
                renderer.current?.lookAt(HARBOR_SPAWN);
              },
            }}
            resetBlocked="Waiting for the Harbor to connect."
          />
        }
      >
        {here && !here.quiet && !here.closed && <button className="primary" onClick={here.run}>{here.label}</button>}
        {here?.also && <button onClick={here.also.run}>{here.also.label}</button>}
      </HudBar>}

      {here && !here.quiet && !here.closed && self && !panelOpen && <TileAction renderer={renderer} pos={self.pos} unitId={self.id} label={here.label} run={here.run} />}
      {tip && <div className="tip">{tip}</div>}
      {title && hoverPoi && !panelOpen && <PlaceTitle renderer={renderer} poiId={hoverPoi.id} title={title} />}
      {error && <div className="toast">{error}</div>}
      {note && !error && <div className="toast note">{note}</div>}
      {sheet && !tradeWith && me.character && <InventoryScreen me={me} refresh={refreshAll} onClose={() => setSheet(false)} />}
      {book && me.character && <Logbook me={me} refresh={refreshAll} onClose={() => setBook(false)} />}
      {account && <AccountPanel me={me} refresh={refresh} onClose={() => setAccount(false)} />}
      {notices && <NoticeBoard seen={me.seenRelease} onSeen={() => void refresh()} onClose={() => setNotices(false)} />}
      {unseen && !panelOpen && !atBoard && <AttentionMark renderer={renderer} pos={HARBOR_BOARD} lift={2.35} label="Something new on the notice board" />}
      {works && <WorksPanel works={board.works} refresh={refresh} onClose={() => setWorks(false)} />}
      {gather && me.character && <GatherPanel spot={gather} onRod={(on) => harbor.send({ type: "fishing", on })} pier={pierHere ?? undefined} at={self?.pos} vessel={self?.vessel ?? null} gilded={me.character?.title === BOOK_TITLE} shipBeside={!!shipHere} renderer={renderer} onClose={() => setGather(null)} onStamina={setStamina} />}
      {fishmonger && me.character && <CatchPanel buyer="market" onGold={() => void refresh()} onClose={() => setFishmonger(false)} />}
      {shop && me.character && <ShopScreen me={me} refresh={refreshAll} onClose={() => setShop(false)} />}
      {me.character && <Trading me={me} partners={board.members.filter((m) => m.id !== you)} withId={tradeWith} onWith={setTradeWith} refresh={refresh} nudge={harbor.trades} />}
      {heroSheet.open && you && <HeroSheet id={heroSheet.open} you={you} onClose={heroSheet.close} />}
    </div>
  );
}
