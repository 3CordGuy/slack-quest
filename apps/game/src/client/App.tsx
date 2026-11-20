// Three places: the screens before you have a character and a crew, the
// crew's shared Harbor, and an Island (a live voyage). The hash carries the
// voyage code so it survives a reload (#run/BCDF), or a crew invite
// (#crew/BCDFGH). #hut/<player id> is the inside of that crew member's hut;
// #pub, #smithy, #apothecary, #galley and #lapidary are the insides of those
// buildings.

import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { isKeeperHouse, type KeeperHouse } from "@gantt-quest/world";
import { loadMe, type Me } from "./api";
import { loadContent } from "./content";
import { AdminView } from "./admin/AdminView";
import { AtlasView } from "./atlas/AtlasView";
import { CatchGallery } from "./CatchGallery";
import { DevToolbox } from "./DevToolbox";
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
    const onHash = () => {
      setInvite(inviteFromHash());
      setHut(hutFromHash());
      setPub(pubFromHash());
      setKeeper(keeperFromHash());
      setZone(zoneFromHash());
      setAtlas(atlasFromHash());
      setAdmin(adminFromHash());
      setCatches(catchesFromHash());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [refresh]);

  if (error) return <div className="centre"><div className="panel">Something went wrong: {error}</div></div>;
  if (!me) return <div className="centre"><div className="panel">Rowing ashore…</div></div>;
  // On a development deployment (local and staging) the dev toolbox sits in the corner of every screen.
  return (
    <>
      <Screen me={me} refresh={refresh} zone={zone} atlas={atlas} invite={invite} hut={hut} pub={pub} keeper={keeper} admin={admin} catches={catches} />
      {me.devTools && <DevToolbox me={me} refresh={refresh} />}
    </>
  );
}

function Screen({ me, refresh, zone, atlas, invite, hut, pub, keeper, admin, catches }: { me: Me; refresh(): Promise<void>; zone: string | null; atlas: boolean; invite: string | null; hut: string | null; pub: boolean; keeper: KeeperHouse | null; admin: boolean; catches: boolean }) {
  const ready = me.character?.status === "active";
  if (FightUiLab && location.hash === "#lab/fightui") return <Suspense fallback={null}><FightUiLab me={me} refresh={refresh} /></Suspense>;
  if (SceneryLab && location.hash === "#lab/scenery") return <Suspense fallback={null}><SceneryLab /></Suspense>;
  if (admin) return <AdminView me={me} onLeave={() => (location.hash = "")} />;
  // Every catch's sprite and model, side by side: for admins, and on a development deployment.
  if (catches && (me.isAdmin || me.devTools || import.meta.env.DEV)) return <CatchGallery onLeave={() => (location.hash = "")} />;
  if (zone && ready) return <ZoneView key={zone} code={zone} me={me} refresh={refresh} onLeave={() => (location.hash = "")} />;
  if (atlas && ready && me.crew) return <AtlasView me={me} refresh={refresh} onLeave={() => (location.hash = "")} />;
  // A voyage or delve link (#run/CODE) lands in the Harbor: both are shut while they are rebuilt on the new combat.
  if (pub && ready && me.crew) return <PubView me={me} refresh={refresh} onLeave={() => (location.hash = "")} />;
  if (keeper && ready && me.crew) return <KeeperView key={keeper} shop={keeper} me={me} refresh={refresh} onLeave={() => (location.hash = "")} />;
  if (hut && ready && me.crew) return <HutView key={hut} ownerId={hut} me={me} refresh={refresh} onLeave={() => (location.hash = "")} />;
  // An invite to a different crew than your own takes you back to the gate to accept it.
  if (ready && me.crew && (!invite || invite === me.crew.id)) return <HarborView me={me} refresh={refresh} />;
  return <Harbor me={me} refresh={refresh} invite={invite} />;
}
