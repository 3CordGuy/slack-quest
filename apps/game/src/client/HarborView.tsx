// The crew's shared Harbor: a walkable place where everyone present sees
// each other. Each member has a hut, the waygate opens onto the crew's atlas,
// and the notice board carries the news of each release of the game (with
// a bouncing "!" over it until you have read the newest).

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAudioScene } from "./audio/useAudioScene";
import type { HexPos } from "@gantt-quest/core";
import { GATHER_SPOTS, GATHER_SPOT_IDS, HARBOR_APOTHECARY, HARBOR_LAPIDARY, HARBOR_BOARD, HARBOR_BUILDINGS, footing, HARBOR_CAVE, HARBOR_WAYGATE, HARBOR_CHEST, HARBOR_GALLEY, HARBOR_LIGHTHOUSE, HARBOR_SMITHY, HARBOR_GATHER, HARBOR_NAME, HARBOR_PLOTS, HARBOR_PLOT_FACING, HARBOR_PUB, HARBOR_RING, HARBOR_SHOP, HARBOR_SPAWN, HARBOR_WORKS, PLOT_PRICE, RESOURCE_KINDS, SHACK_COST, binFill, binNeeds, builtProjects, BOOK_TITLE, fishSpotAt, harborDoor, seaEdge, tileAt, waterSpotAt, type FishSpot, FISH_SPOTS, generateHarbor, projectById, projectProgress, harborPoi, hutTier, poiAt, salesman, type GatherSpot, type Resources } from "@gantt-quest/world";
import type { Poi } from "@gantt-quest/world";
import { MusterPanel, useMuster } from "./atlas/Muster";
import { api, type Me } from "./api";
import { CatchPanel } from "./CatchPanel";
import { ChatInput } from "./ChatInput";
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
import { useOwnLook } from "./ownLook";
import { useSalesman } from "./salesmanClock";
import { WorksPanel } from "./works/WorksPanel";
import { TownChest, readChestAhead } from "./chest/TownChest";
import { label } from "./labels";
import { xpEvents } from "./xpEvents";

const same = (a: HexPos, b: HexPos) => a.q === b.q && a.r === b.r;
/**
 * The Harbor opens seen from a little east of south, about eighteen degrees off the rows of hexes: its streets
 * and lanes are laid along those rows, and squared to the screen they look ruled. From here the buildings on
 * the island's edge, turned in toward the square, show their fronts.
 */
const HARBOR_VIEW_YAW = 0.32;

/** "10 wood and 6 stone". */
const costText = (r: Resources) => {
  const parts = RESOURCE_KINDS.filter((k) => (r[k] ?? 0) > 0).map((k) => `${r[k]} ${label("resource", k).toLowerCase()}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "nothing");
};

/** The hex the notice board itself stands on (it is read from the hex beside it): the "!" floats over this one. */
const BOARD_STANDS = footing(HARBOR_BOARD, "single", HARBOR_BUILDINGS.find((b) => b.id === "board")?.facing)[0];

/**
 * The things used from a hex of the street beside them (the town chest, the notice board, the waygate:
 * a `single` footing). That hex is ground people walk over, so a click on it is only a walk. A building's
 * doorstep is its own, and a click on it means the building.
 */
const BESIDE = new Set(HARBOR_BUILDINGS.filter((b) => b.shape === "single").map((b) => b.id));

/**
 * The place a pointer is on: the one whose model it is on (`model`, its id, as the renderer picked it), or whose
 * ground that hex is, or whose doorstep it is. Hovering and clicking both ask this, so what lights up under the
 * pointer is what a click walks to and goes into.
 */
function placeUnder(pois: Poi[], at: HexPos, model?: string | null): Poi | undefined {
  if (model) return pois.find((p) => p.id === model);
  const door = harborDoor(at);
  if (door) return pois.find((p) => same(p.pos, door));
  const on = pois.find((p) => same(p.pos, at));
  return on && !BESIDE.has(on.id) ? on : undefined;
}

/**
 * Every place in the Harbor is a structure to be used (it lights up under the pointer, and a click on it walks the
 * hero to its door and, see `goIn`, in) but these: the rocks and the wreck, which are scenery; and a plot for sale or being built on, which lights up only for whoever has something to do there (see
 * `lights`, in the view). A new kind of place lights up without being added anywhere.
 */
const NO_STRUCTURE = new Set<Poi["kind"]>(["rocks", "wreck", "lot", "site"]);

/**
 * The place a hero stands at and what there is to do there: `run` is its main button, in the bar along the
 * bottom. Walked to by a click on the place itself, it is gone into on arriving with nothing more to press:
 * `enter` if it has one, else `run`.
 */
interface Here {
  title: ReactNode;
  label: string;
  run(): void;
  /** Offered in the bar only, and never done unasked (open ground to sleep on). */
  quiet?: boolean;
  /** Shut for now: it says so and offers nothing. */
  closed?: boolean;
  also?: { label: string; run(): void };
  /**
   * Done only by pressing its button, which also floats over the hero's head: for what spends or commits
   * something the player may not have meant (gold for a plot, materials into a bin), and for what is no way in.
   */
  press?: boolean;
  /** What a click on the place does on arriving, where that is not `run`. */
  enter?(): void;
}
/** What walking up to a place by clicking it does on arriving, if anything: its way in. The one rule for every place. */
const goIn = (here: Here | null): (() => void) | null => (!here || here.closed || here.quiet ? null : here.enter ?? (here.press ? null : here.run));

/**
 * `resting`: the player is somewhere else (inside one of the Harbor's buildings, out on a map, at the atlas), and
 * the Harbor is kept behind it, built but put away: not drawn, not connected, none of its panels up. Coming back
 * to it is then at once.
 */
export function HarborView({ me, refresh, resting = false }: { me: Me; refresh(): Promise<unknown>; resting?: boolean }) {
  useAudioScene("harbor", !resting);
  /** Whether the Harbor was made put away (the game was opened somewhere else: on a map, in a building). */
  const born = useRef(resting);
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
  /** The town chest, on its dais on the west shore: the crew's shared store. */
  const [chest, setChest] = useState(false);
  /**
   * A place was clicked (its model, its ground or its doorstep): the hero is walking to its door, and goes in on
   * getting there. The door's hex. Any other click, on the ground or on another place, drops it.
   */
  const [want, setWant] = useState<HexPos | null>(null);
  /** The place whose model the pointer is on, by its id: `hover` alone cannot tell a roof from the ground at its door. */
  const [hoverPlace, setHoverPlace] = useState<string | null>(null);
  const [account, setAccount] = useState(false);
  const [tradeWith, setTradeWith] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const chatEnd = useRef<HTMLDivElement>(null);

  const harbor = useHarbor(
    (id, path) => renderer.current?.playEvents([{ t: "moved", heroId: id, path }]),
    (m) => renderer.current?.playEvents(xpEvents(m)),
    (id, text) => renderer.current?.say(id, text),
    !resting,
  );
  // The crew's muster, told down the Harbor's socket: whoever says they are ready is taken to the map when it starts.
  const muster = useMuster(harbor.you ?? me.player.id, { pushed: harbor.muster, onStart: () => void refresh() });
  // A traveling salesman in the pub is worth a mention out here.
  const salesmanNow = useSalesman(me.crew?.id);
  const send = useRef(harbor.send);
  send.current = harbor.send;
  const base = useMemo(generateHarbor, []);
  /** Your gathering outings left today, drawn as lightning bolts on your plate. Read on the way in and after anything that spends or restores them. */
  const [stamina, setStamina] = useState<{ left: number; max: number } | null>(null);
  const { board, players, you } = harbor;
  // Your own hero is drawn in what the bag shows while a change of gear is on its way; otherwise as the room tells.
  const ownOutfit = useOwnLook(players.find((p) => p.id === you)?.outfit);
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

  // The Harbor as the renderer sees it: the fixed map plus a hut per member.
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
    ];
    return {
      code: "harbor",
      you,
      map: { ...base, pois },
      heroes: players.map((p) => ({ id: p.id, classId: p.classId, pos: p.pos, label: p.name, outfit: p.id === you ? ownOutfit : p.outfit, asleep: !!p.bedroll && same(p.bedroll, p.pos), rod: p.fishing ? (p.gilded ? "gilded" : true) : false, boat: tileAt(base, p.pos)?.biome === "water" ? p.vessel ?? "barrel" : undefined, level: p.level, xp: p.xp })),
      freeRoam: true,
      homeYaw: HARBOR_VIEW_YAW,
      // Bedrolls laid out by whoever is resting.
      props: players.filter((p) => p.bedroll).map((p, i) => ({ id: 9000 + i, model: "bedroll", pos: p.bedroll!, facing: 0 })),
      stamina: stamina ?? undefined,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, board, players, you, stamina, ownOutfit]);
  const latest = useRef(scene);
  latest.current = scene;
  const heroSheet = useHeroSheet();

  useEffect(() => {
    // A click anywhere on a place (its model, the ground it stands on, a building's doorstep) is a walk to its
    // door and the going in: nothing more to press on arriving (see `want`). A click anywhere else is only a walk.
    const r = new WorldRenderer(mount.current!, {
      onHexClick: (to, place) => {
        const aimed = latest.current ? placeUnder(latest.current.map.pois, to, place) : undefined;
        setWant(aimed ? { ...aimed.pos } : null);
        send.current({ type: "move", to: aimed?.pos ?? harborDoor(to) ?? to });
      },
      onHover: setHover,
      onHoverPlace: setHoverPlace,
    }, { resting: born.current });
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
  // Put away while a building has the screen. (A layout effect: before the building's own view is made, in the same pass.)
  useLayoutEffect(() => {
    if (!resting) return;
    renderer.current?.setResting(true);
    // Whatever was open or under way out here is over.
    setWant(null);
    setHover(null);
    setHoverPlace(null);
    setGather(null);
    for (const close of [setSheet, setBook, setShop, setNotices, setFishmonger, setWorks, setChest, setAccount]) close(false);
    setTradeWith(null);
  }, [resting]);
  // And brought back on stepping out of it, fading in over the building's last picture (render/handover.ts).
  useEffect(() => {
    if (!resting) renderer.current?.setResting(false);
  }, [resting]);
  // With the bag open your hero turns to face you, so you can see what they are wearing.
  useEffect(() => {
    renderer.current?.setFacingFront(sheet);
  }, [sheet]);
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "end" });
  }, [harbor.chat.length]);

  // Dev-only handle for driving the Harbor from the console or a test script.
  if (import.meta.env.DEV) (window as unknown as { __harbor: unknown }).__harbor = { harbor, view: renderer.current };
  const self = players.find((p) => p.id === you);
  const plotIndex = self ? HARBOR_PLOTS.findIndex((p) => same(p, self.pos)) : -1;
  const hutOwner = plotIndex >= 0 ? board.members.find((m) => m.plot === plotIndex) : undefined;
  const myPlot = board.members.find((m) => m.id === you)?.plot ?? null;
  const gold = me.character?.gold ?? 0;
  // Pointing at the ground a building stands on is pointing at the building.
  const hoverPoi = scene && hover ? poiAt(scene.map, harborDoor(hover) ?? hover) : undefined;
  // The structure the pointer is on that a click would walk to and go into: it lights up with a glowing outline,
  // and the pointer becomes a hand. (A touch screen has no pointer to hover with: there a tap is the click.)
  const aimed = scene && hover ? placeUnder(scene.map.pois, hover, hoverPlace) : undefined;
  const lights = !!aimed && (!NO_STRUCTURE.has(aimed.kind) || (aimed.kind === "lot" && myPlot === null) || aimed.id === `site:${you}`);
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
    : hoverPoi.kind === "lighthouse" ? (lit ? "The lighthouse: it lights the way home" : lighthouseFill > 0 ? "The lighthouse going up, out on the point" : "A bare point over the wreck, where the lighthouse will stand")
    : hoverPoi.kind === "waygate" ? (board.maps?.[0] ? `The waygate, open to ${board.maps[0].place}: step through` : "The waygate, shut: it opens onto the crew's atlas")
    : hoverPoi.kind === "apothecary" ? (apothecaryBuilt ? "The apothecary: potions and flasks, bought or brewed, and a keeper to haggle with" : "The apothecary's building site: a crew project at the works")
    : hoverPoi.kind === "lapidary" ? "The Lapidary: lodestones cut and worked for the atlas, and gems bought"
    : hoverPoi.kind === "smithy" ? (smithyBuilt ? "The smithy: arms and armour off the rack, your own sharpened or reinforced, and a smith to haggle with" : "The smithy's building site: a crew project at the works")
    : hoverPoi.kind === "galley" ? (galleyBuilt ? "The galley: the cook is in, with nothing to sell" : "The galley's building site: a crew project at the works")
    : hoverPoi.kind === "lot" ? (myPlot === null ? `A plot for sale: ${PLOT_PRICE} gold` : "An empty plot")
    : hoverPoi.kind === "site" ? (hoverPoi.id === `site:${you}` ? "Your plot: fill the bin and the shack goes up" : `${board.members.find((m) => `site:${m.id}` === hoverPoi.id)?.name ?? "Someone"}'s plot: building a shack`)
    : hoverPoi.kind === "plot" ? `${board.members.find((m) => `plot:${m.id}` === hoverPoi.id)?.name ?? "Someone"}'s ${hutTier(hoverPoi.tier ?? 1).name.toLowerCase()}`
    : null;

  /** The place's name alone, hung over it on a plate while it is pointed at (the tip says what it is for). */
  const ownerOf = (prefix: string) => board.members.find((m) => `${prefix}:${m.id}` === hoverPoi?.id);
  const title = !hoverPoi ? null
    : hoverPoi.kind === "cave" ? "The Haunted Caverns"
    : hoverPoi.kind === "townchest" ? "The Town Chest"
    : hoverPoi.kind === "lapidary" ? "The Lapidary"
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
    : hoverPoi.kind === "waygate" ? "The Waygate"
    : hoverPoi.kind === "apothecary" ? "The Apothecary"
    : hoverPoi.kind === "smithy" ? "The Smithy"
    : hoverPoi.kind === "galley" ? "The Galley"
    : hoverPoi.kind === "lot" ? "Plot for Sale"
    : hoverPoi.kind === "site" ? (hoverPoi.id === `site:${you}` ? "Your Plot" : `${ownerOf("site")?.name ?? "Someone"}'s Plot`)
    : hoverPoi.kind === "plot" ? (hoverPoi.id === `plot:${you}` ? `Your ${hutTier(hoverPoi.tier ?? 1).name}` : `${ownerOf("plot")?.name ?? "Someone"}'s ${hutTier(hoverPoi.tier ?? 1).name}`)
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
  const atLapidary = !!self && same(self.pos, HARBOR_LAPIDARY);
  const atChest = !!self && same(self.pos, HARBOR_CHEST);
  const atWaygate = !!self && same(self.pos, HARBOR_WAYGATE);
  // Where the waygate would take you without the atlas: the map a crewmate is out on, or the one you last walked off.
  const outThere = board.members.find((m) => m.id !== you && m.zone);
  // The map the crew has open out through the gate (the latest, if there are several): while there is one the gate
  // stands open, and stepping through it goes there.
  const openMap = board.maps?.[0];
  const gateOpen = !!openMap || !!harbor.muster?.code;
  // Shut, the gate is a knot of stone and brass asleep on its plinth; a map being opened bursts it out into the air.
  useEffect(() => {
    renderer.current?.setWaygateOpen(gateOpen);
  }, [gateOpen]);
  const lastMap = (() => {
    try {
      return sessionStorage.getItem("gq.atlas.zone");
    } catch {
      return null;
    }
  })();
  // A place was clicked: the hero goes in once they have walked up to its door and stopped (at once, if they stand
  // there already). What going in is comes from the place under their feet (`here`, below), the same that the bar's
  // button does, so the two cannot differ.
  const atWant = !!self && !!want && same(self.pos, want);
  const hereNow = useRef<Here | null>(null);
  useEffect(() => {
    if (!want || !atWant) return;
    const arrived = () => {
      if (you && renderer.current?.isWalking(you)) return;
      clearInterval(tick);
      setWant(null);
      goIn(hereNow.current)?.();
    };
    // Never looked at in the moment of the click itself: a walk is shown at once (useHarbor's showWalk), the hero's
    // place first and the walking of it handed to the renderer a moment after, and in between they would seem to
    // stand at the door already.
    const first = setTimeout(arrived, 0);
    const tick = setInterval(arrived, 60);
    return () => {
      clearTimeout(first);
      clearInterval(tick);
    };
  }, [want, atWant, you]);
  // What is in the chest is read ahead: on coming into the Harbor, and again on setting off toward it. So it opens at once.
  const wantChest = !!want && same(want, HARBOR_CHEST);
  useEffect(() => {
    if (wantChest || !chest) readChestAhead();
  }, [wantChest, chest]);
  // Its lid swings back while it is open, and falls shut after.
  useEffect(() => {
    renderer.current?.setChestOpen(chest);
  }, [chest]);
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
  // The sparring ring is shut while it is rebuilt on the new combat (fights on the tiles themselves):
  // it says so and offers nothing to do.
  const shut = (title: ReactNode) => ({ title, label: "", run: () => {}, closed: true });
  // The place under your feet and the one thing to do there, shown in the bar below. A hero who walked here by
  // clicking the place has it done for them on arriving (`goIn`); where it must be pressed (`press`), its button
  // floats over them as well.
  const here: Here | null =
    atBoard ? { title: unseen ? "The notice board · something new is pinned up" : "The notice board", label: "Read the notice board", run: () => setNotices(true) }
    : atWaygate ? {
        title: <>The waygate <span className="muted">· {outThere ? `${outThere.name} is out through it${outThere.zone?.fighting ? ", in a fight" : ""}` : openMap ? `open to ${openMap.place}` : "shut. It opens onto the crew's atlas"}</span></>,
        label: outThere ? `Step through to ${outThere.name}` : openMap ? `Step through to ${openMap.place}` : "Open the atlas",
        run: () => (location.hash = outThere?.zone ? `zone/${outThere.zone.code}` : openMap ? `zone/${openMap.code}` : "atlas"),
        // A click on the gate itself goes where it stands open to: the map the crew has open; shut, the atlas, where
        // the crew has been and where it could go next. (Stepping straight through to a crewmate, who may be in a
        // fight, is asked for with the button.)
        enter: () => (location.hash = openMap ? `zone/${openMap.code}` : "atlas"),
        also: outThere || openMap ? { label: "Open the atlas", run: () => (location.hash = "atlas") } : lastMap ? { label: "Step back through", run: () => (location.hash = `zone/${lastMap}`) } : undefined,
      }
    : atChest ? { title: <>The town chest <span className="muted">· the crew's shared store, in tabs: gear, materials, lodestones</span></>, label: "Open the town chest", run: () => setChest(true) }
    // The Lapidary was never a building site: it is open from a crew's first day, for nobody goes out without a lodestone.
    : atLapidary ? { title: <>The Lapidary <span className="muted">· lodestones for the atlas are cut and worked here, and gems bought</span></>, label: "Go in", run: () => goInside(`${HARBOR_LAPIDARY.q},${HARBOR_LAPIDARY.r}`, "lapidary") }
    : atCave ? { title: <>The Haunted Caverns <span className="muted">· something lurks in the dark</span></>, label: "Go down", run: goDown }
    : atShop ? { title: "The market stall", label: "Browse the wares", run: () => setShop(true) }
    : atRing ? shut(<>The sparring ring <span className="muted">· being rebuilt for a new way of fighting. Coming soon.</span></>)
    : gatherHere ? {
        title: gatherHere === "fishing" && pierHere ? FISH_SPOTS[pierHere].name : GATHER_SPOTS[gatherHere].name,
        label: gatherHere === "fishing" ? (pierHere === "sea" ? "Row out and cast" : "Cast a line") : gatherHere === "felling" ? "Take up the axe" : "Work the seam",
        run: () => setGather(gatherHere),
        // A click on the fish shack is a call on the fishmonger, whose stall it is. A click on the tree line or the
        // quarry opens its card, where setting out (and the energy it costs) has a button of its own. A pier head or
        // a boat is no structure to click: there the button floats over the hero, as it always has.
        enter: pierHere === "shore" ? () => setFishmonger(true) : undefined,
        press: gatherHere === "fishing" && pierHere !== "shore",
        // The shore spot is also the fishmonger's stall.
        also: pierHere === "shore" ? { label: "The fishmonger", run: () => setFishmonger(true) } : undefined,
      }
    : atPub ? { title: visitor ? <>The pub <span className="pub-visitor">· {visitor.name}, {visitor.trade}, is in</span></> : "The pub", label: "Go in", run: () => goInside("pub", "pub") }
    : atWorks ? { title: "The works", label: "See the crew's projects", run: () => setWorks(true) }
    // The lighthouse lights the way home. (The atlas is opened at the waygate, in the square.)
    : atLighthouse ? (lit
        ? { title: <>The lighthouse <span className="muted">· it lights the way home. The atlas is opened at the waygate, in the square.</span></>, label: "Show me the waygate", run: () => renderer.current?.lookAt(HARBOR_WAYGATE), press: true }
        : { title: <>The lighthouse's point <span className="muted">· the tower is paid for at the works</span></>, label: "See the crew's projects", run: () => setWorks(true) })
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
        // It takes the materials out of your bag.
        press: true,
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
        // It costs gold.
        press: true,
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
  hereNow.current = here;
  // Anything laid over the Harbor takes the floating button away.
  const panelOpen = sheet || book || shop || notices || !!gather || fishmonger || works || account || !!tradeWith;
  // Nothing lights up behind a window, or while a gathering outing has the view.
  const glowId = lights && !panelOpen ? aimed.id : null;
  useEffect(() => {
    renderer.current?.setGlow(glowId);
  }, [glowId]);
  const error = harbor.error;

  // Put away: only the stage is kept, with the view built on it. No panel, bar or key of the Harbor's is up.
  // (The stage is keyed, here and below, so it is the same element either way and keeps its canvas.)
  if (resting) return <div className="run harbor-view" style={{ display: "none" }}><div key="stage" className="stage" ref={mount} /></div>;
  return (
    <div className="run harbor-view">
      {/* Someone of the crew is setting out for a place on the atlas, and asks who is coming. */}
      {muster.muster && <MusterPanel muster={muster.muster} me={harbor.you ?? me.player.id} onSay={muster.say} busy={muster.busy} error={muster.error} />}
      <div key="stage" className="stage" ref={mount} />
      {/* Down the left-hand side: the docks at the top, the crew's cards in the middle (the talk sits under them). */}
      <div className="hud-left">
        <DragPanel id="harbor.docks" title="Docks" foldOnPhone className="story panel docks">
          <p className="muted">The crew's atlas is opened at the waygate, in the middle of the square: everywhere you have found, and the routes that run on from there. When one of you sets out, everyone in town is asked whether they are coming. Setting out takes a lodestone: they are cut and worked at the Lapidary, the narrow shop with a gem for a sign, where Tilda also buys gems. What the crew shares is kept in the town chest, on its dais down on the west shore.</p>
          <p>
            <button className="small" onClick={() => renderer.current?.lookAt(HARBOR_WAYGATE)}>Show me the waygate</button> <button className="small" onClick={() => renderer.current?.lookAt(HARBOR_LAPIDARY)}>Show me the Lapidary</button> <button className="small" onClick={() => renderer.current?.lookAt(HARBOR_CHEST)}>Show me the town chest</button>
          </p>
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
        <ChatInput placeholder="Say something to the crew…" onSay={(text) => harbor.send({ type: "say", text })} />
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
        onBag={() => !tradeWith && (chest ? setChest(false) : setSheet((open) => !open))}
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

      {/* A place gone into by clicking it has no button over the hero: only what must be pressed (`press`) keeps one. */}
      {here?.press && !here.closed && self && !panelOpen && <TileAction renderer={renderer} pos={self.pos} unitId={self.id} label={here.label} run={here.run} />}
      {tip && <div className="tip">{tip}</div>}
      {title && hoverPoi && !panelOpen && <PlaceTitle renderer={renderer} poiId={hoverPoi.id} title={title} />}
      {error && <div className="toast">{error}</div>}
      {note && !error && <div className="toast note">{note}</div>}
      {sheet && !tradeWith && !chest && me.character && <InventoryScreen me={me} refresh={refreshAll} onClose={() => setSheet(false)} onLogbook={() => { setSheet(false); setBook(true); }} />}
      {book && me.character && <Logbook me={me} refresh={refreshAll} onClose={() => setBook(false)} />}
      {account && <AccountPanel me={me} refresh={refresh} onClose={() => setAccount(false)} />}
      {notices && <NoticeBoard seen={me.seenRelease} onSeen={() => void refresh()} onClose={() => setNotices(false)} />}
      {unseen && !panelOpen && !atBoard && <AttentionMark renderer={renderer} pos={BOARD_STANDS} lift={2.35} label="Something new on the notice board" />}
      {works && <WorksPanel works={board.works} refresh={refresh} onClose={() => setWorks(false)} />}
      {chest && me.character && <TownChest me={me} refresh={refresh} onClose={() => setChest(false)} />}
      {gather && me.character && <GatherPanel spot={gather} onRod={(on) => harbor.send({ type: "fishing", on })} pier={pierHere ?? undefined} at={self?.pos} vessel={self?.vessel ?? null} gilded={me.character?.title === BOOK_TITLE} renderer={renderer} onClose={() => setGather(null)} onStamina={setStamina} onPaid={() => void refresh()} />}
      {fishmonger && me.character && <CatchPanel buyer="market" onGold={() => void refresh()} onClose={() => setFishmonger(false)} />}
      {shop && me.character && <ShopScreen me={me} refresh={refreshAll} onClose={() => setShop(false)} />}
      {me.character && <Trading me={me} partners={board.members.filter((m) => m.id !== you)} withId={tradeWith} onWith={setTradeWith} refresh={refresh} nudge={harbor.trades} />}
      {heroSheet.open && you && <HeroSheet id={heroSheet.open} you={you} onClose={heroSheet.close} logbook={me.character ? { hero: me.character, open: () => { heroSheet.close(); setBook(true); } } : undefined} />}
    </div>
  );
}
