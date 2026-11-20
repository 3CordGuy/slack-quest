// Three places: the screens before you have a character and a crew, the
// crew's shared Harbor, and a map out through the waygate (a zone). The hash
// carries the map's code so it survives a reload (#zone/BCDF), or a crew
// invite (#crew/BCDFGH). #atlas is the crew's atlas; #hut/<player id> is the
// inside of that crew member's hut; #pub, #smithy, #apothecary, #galley and
// #lapidary are the insides of those buildings.

import { Suspense, isValidElement, lazy, useCallback, useEffect, useRef, useState } from "react";
import { dismissBoot } from "./boot";
import { leaveFor } from "./render/handover";
import { compilesAhead } from "./render/graphics";
import { placesStaging } from "./render/preload";
import { KEEPER_HOUSES, isKeeperHouse, type KeeperHouse } from "@gantt-quest/world";
import { loadMe, type Me } from "./api";
import { loadContent } from "./content";
// The admin page is loaded on demand (below), but its stylesheet is still read here, where the page used to be
// imported: loaded late, the sheet would come after every other and win where it now loses. (The other two
// screens loaded on demand have no sheet of their own.)
import "./admin/admin.css";
import { AtlasView } from "./atlas/AtlasView";
import { Harbor } from "./Harbor";
import { HarborView } from "./HarborView";
import { HutView } from "./HutView";
import { KeeperView } from "./KeeperView";
import { PubView } from "./PubView";
import { ZoneView } from "./ZoneView";

const pubFromHash = () => location.hash === "#pub";
/** Inside the smithy, the apothecary, the galley or the Lapidary (KeeperView). */
const keeperFromHash = (): KeeperHouse | null => {
  const house = location.hash.slice(1);
  return isKeeperHouse(house) ? house : null;
};
/** A zone: a map to walk and fight on (ZoneView). */
const zoneFromHash = () => /^#zone\/([A-Za-z]{4})$/.exec(location.hash)?.[1].toUpperCase() ?? null;
/** The crew's atlas: the world, and where on it they can go (atlas/AtlasView.tsx). */
const atlasFromHash = () => location.hash === "#atlas";
const adminFromHash = () => location.hash === "#admin";
const catchesFromHash = () => location.hash === "#catches";
const hutFromHash = () => /^#hut\/([A-Za-z0-9-]{1,64})$/.exec(location.hash)?.[1] ?? null;
const inviteFromHash = () => /^#crew\/([A-Za-z]{6})$/.exec(location.hash)?.[1].toUpperCase() ?? null;
/** Never shown to an ordinary player (the admin page, the catch gallery, the dev toolbox), so fetched only when one is opened. */
const AdminView = lazy(() => import("./admin/AdminView").then((m) => ({ default: m.AdminView })));
const CatchGallery = lazy(() => import("./CatchGallery").then((m) => ({ default: m.CatchGallery })));
const DevToolbox = lazy(() => import("./DevToolbox").then((m) => ({ default: m.DevToolbox })));
/** A bench for the fight interface with made-up data (development only): #lab/fightui. */
const FightUiLab = import.meta.env.DEV ? lazy(() => import("./zone/FightUiLab")) : null;
/** A sample map carrying every kind of zone scenery, in any climate and over any backdrop (development only): #lab/scenery. */
const SceneryLab = import.meta.env.DEV ? lazy(() => import("./SceneryLab")) : null;

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState(inviteFromHash);
  const [hut, setHut] = useState(hutFromHash);
  const [pub, setPub] = useState(pubFromHash);
  const [keeper, setKeeper] = useState(keeperFromHash);
  const [zone, setZone] = useState(zoneFromHash);
  const [atlas, setAtlas] = useState(atlasFromHash);
  const [admin, setAdmin] = useState(adminFromHash);
  const [catches, setCatches] = useState(catchesFromHash);

  /** Only the answer to the newest question is kept: an older one that comes back late would show the pack as it was. */
  const meAsked = useRef(0);
  const refresh = useCallback(() => {
    const asked = ++meAsked.current;
    return loadMe().then((next) => { if (asked === meAsked.current) setMe(next); }, (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    // The content overrides need a session, so they load after the first /api/me
    // (which signs a new visitor in as a guest) and before anything is drawn.
    loadMe()
      .then(async (first) => {
        await loadContent();
        setMe(first);
      })
      .catch((e: Error) => setError(e.message));
    // Going somewhere else: the place on the screen leaves its picture up first (render/handover.ts), and the
    // next is made a frame or two later, over it.
    const onHash = () => leaveFor(() => {
      setInvite(inviteFromHash());
      setHut(hutFromHash());
      setPub(pubFromHash());
      setKeeper(keeperFromHash());
      setZone(zoneFromHash());
      setAtlas(atlasFromHash());
      setAdmin(adminFromHash());
      setCatches(catchesFromHash());
    });
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [refresh]);

  // Nothing to wait for behind the opening screen.
  if (error) dismissBoot();
  if (error) return <div className="centre"><div className="panel">Something went wrong: {error}</div></div>;
  if (!me) return <div className="centre"><div className="panel">Rowing ashore…</div></div>;
  // On a development deployment (local and staging) the dev toolbox sits in the corner of every screen.
  return (
    <>
      <Screen me={me} refresh={refresh} zone={zone} atlas={atlas} invite={invite} hut={hut} pub={pub} keeper={keeper} admin={admin} catches={catches} />
      {me.devTools && <Suspense fallback={null}><DevToolbox me={me} refresh={refresh} /></Suspense>}
    </>
  );
}

function Screen({ me, refresh, zone, atlas, invite, hut, pub, keeper, admin, catches }: { me: Me; refresh(): Promise<void>; zone: string | null; atlas: boolean; invite: string | null; hut: string | null; pub: boolean; keeper: KeeperHouse | null; admin: boolean; catches: boolean }) {
  const ready = me.character?.status === "active";
  const leave = () => (location.hash = "");
  // Somewhere that is not the town: a lab, the admin page, a map, the atlas.
  const elsewhere = FightUiLab && location.hash === "#lab/fightui" ? <Suspense fallback={null}><FightUiLab me={me} refresh={refresh} /></Suspense>
    : SceneryLab && location.hash === "#lab/scenery" ? <Suspense fallback={null}><SceneryLab /></Suspense>
    : admin ? <Suspense fallback={null}><AdminView me={me} onLeave={leave} /></Suspense>
    // Every catch's sprite and model, side by side: for admins, and on a development deployment.
    : catches && (me.isAdmin || me.devTools || import.meta.env.DEV) ? <Suspense fallback={null}><CatchGallery onLeave={leave} /></Suspense>
    : zone && ready ? <ZoneView key={zone} code={zone} me={me} refresh={refresh} onLeave={leave} />
    : atlas && ready && me.crew ? <AtlasView me={me} refresh={refresh} onLeave={leave} />
    // (An old voyage link, #run/CODE, is no place any more: it falls through to the Harbor.)
    : null;
  // The town is the crew's: before there is a hero and a crew there are only the screens that make them. (An invite
  // to a different crew than your own takes you back to the gate to accept it.)
  const town = ready && !!me.crew && (!invite || invite === me.crew.id);
  // A screen with a view of the world (the town, a map, the atlas) takes the opening screen away itself, once it
  // has something to show (WorldRenderer's reveal). Any other has nothing to wait for.
  const world = isValidElement(elsewhere) ? elsewhere.type === ZoneView || elsewhere.type === AtlasView : town;
  useEffect(() => {
    if (!world) dismissBoot();
  }, [world]);
  if (!town) return elsewhere ?? <Harbor me={me} refresh={refresh} invite={invite} />;
  // The whole town is loaded once and kept: the Harbor, the pub and the workshops, each put away (its `resting`)
  // while the player is somewhere else. So nothing is built on walking through a door, or on coming home from a
  // map. A hut is not kept: what is in one is only known on going in.
  const inside = elsewhere ? null : pub ? "pub" : keeper ?? (hut ? "hut" : null);
  return (
    <>
      <HarborView key="harbor" me={me} refresh={refresh} resting={!!elsewhere || !!inside} />
      <Buildings me={me} refresh={refresh} inside={inside} onLeave={leave} />
      {inside === "hut" && <HutView key={hut} ownerId={hut!} me={me} refresh={refresh} onLeave={leave} />}
      {elsewhere}
    </>
  );
}

/** The town's buildings that are loaded with the game: the pub, then each workshop. */
const BUILDINGS = ["pub", ...KEEPER_HOUSES] as const;

/**
 * The pub and the workshops, all of them, kept for as long as the player is in town or out from it. They are made
 * one after another as the game opens, put away, behind the opening screen (render/preload.ts holds it up until
 * they are ready); the one the player is `inside`, if any, is on the screen.
 *
 * A browser that cannot compile shaders in the background (Firefox: see compilesAhead) would take several times as
 * long over that. There each building is made when it is first walked into, and kept from then on.
 */
function Buildings({ me, refresh, inside, onLeave }: { me: Me; refresh(): Promise<void>; inside: string | null; onLeave(): void }) {
  /** How many have been made so far. One more each turn of the page's loop, so the opening screen goes on moving between them. */
  const [made, setMade] = useState(0);
  const ahead = compilesAhead();
  /** The buildings walked into so far: kept, whether or not they were made with the game. */
  const [seen, setSeen] = useState<readonly string[]>([]);
  if (inside && !seen.includes(inside)) setSeen([...seen, inside]);
  useEffect(() => {
    if (!ahead || made >= BUILDINGS.length) return placesStaging(false);
    placesStaging(true);
    const next = setTimeout(() => setMade((n) => n + 1), 0);
    return () => clearTimeout(next);
  }, [made, ahead]);
  useEffect(() => () => placesStaging(false), []);
  return (
    <>
      {BUILDINGS.map((b, i) => {
        // (The one walked straight into, on a reload inside it, is made at once whatever its turn.)
        if (i >= made && inside !== b && !seen.includes(b)) return null;
        return b === "pub"
          ? <PubView key="pub" me={me} refresh={refresh} onLeave={onLeave} resting={inside !== "pub"} />
          : <KeeperView key={b} shop={b} me={me} refresh={refresh} onLeave={onLeave} resting={inside !== b} />;
      })}
    </>
  );
}
