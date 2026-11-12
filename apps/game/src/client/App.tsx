// Three places: the screens before you have a character and a crew, the
// crew's shared Harbor, and an Island (a live voyage). The hash carries the
// voyage code so it survives a reload (#run/BCDF), or a crew invite
// (#crew/BCDFGH). #hut/<player id> is the inside of that crew member's hut.

import { useCallback, useEffect, useState } from "react";
import { loadMe, type Me } from "./api";
import { Harbor } from "./Harbor";
import { HarborView } from "./HarborView";
import { HutView } from "./HutView";
import { PubView } from "./PubView";
import { RunView } from "./RunView";

const runCodeFromHash = () => /^#run\/([A-Za-z]{4})$/.exec(location.hash)?.[1].toUpperCase() ?? null;
const pubFromHash = () => location.hash === "#pub";
const hutFromHash = () => /^#hut\/([A-Za-z0-9-]{1,64})$/.exec(location.hash)?.[1] ?? null;
const inviteFromHash = () => /^#crew\/([A-Za-z]{6})$/.exec(location.hash)?.[1].toUpperCase() ?? null;

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState(runCodeFromHash);
  const [invite, setInvite] = useState(inviteFromHash);
  const [hut, setHut] = useState(hutFromHash);
  const [pub, setPub] = useState(pubFromHash);

  const refresh = useCallback(() => loadMe().then(setMe, (e: Error) => setError(e.message)), []);
  useEffect(() => {
    void refresh();
    const onHash = () => {
      setCode(runCodeFromHash());
      setInvite(inviteFromHash());
      setHut(hutFromHash());
      setPub(pubFromHash());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [refresh]);

  if (error) return <div className="centre"><div className="panel">Something went wrong: {error}</div></div>;
  if (!me) return <div className="centre"><div className="panel">Rowing ashore…</div></div>;
  const ready = me.character?.status === "active";
  if (code && ready) {
    return (
      <RunView
        code={code}
        me={me}
        refresh={refresh}
        onLeave={() => {
          location.hash = "";
          void refresh();
        }}
      />
    );
  }
  if (pub && ready && me.crew) return <PubView me={me} refresh={refresh} onLeave={() => (location.hash = "")} />;
  if (hut && ready && me.crew) return <HutView key={hut} ownerId={hut} me={me} refresh={refresh} onLeave={() => (location.hash = "")} />;
  // An invite to a different crew than your own takes you back to the gate to accept it.
  if (ready && me.crew && (!invite || invite === me.crew.id)) return <HarborView me={me} refresh={refresh} />;
  return <Harbor me={me} refresh={refresh} invite={invite} />;
}
