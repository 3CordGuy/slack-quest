// Three places: the screens before you have a character and a crew, the
// crew's shared Harbor, and an Island (a live voyage). The hash carries the
// voyage code so it survives a reload (#run/BCDF), or a crew invite
// (#crew/BCDFGH).

import { useCallback, useEffect, useState } from "react";
import { loadMe, type Me } from "./api";
import { Harbor } from "./Harbor";
import { HarborView } from "./HarborView";
import { RunView } from "./RunView";

const runCodeFromHash = () => /^#run\/([A-Za-z]{4})$/.exec(location.hash)?.[1].toUpperCase() ?? null;
const inviteFromHash = () => /^#crew\/([A-Za-z]{6})$/.exec(location.hash)?.[1].toUpperCase() ?? null;

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState(runCodeFromHash);
  const [invite, setInvite] = useState(inviteFromHash);

  const refresh = useCallback(() => loadMe().then(setMe, (e: Error) => setError(e.message)), []);
  useEffect(() => {
    void refresh();
    const onHash = () => {
      setCode(runCodeFromHash());
      setInvite(inviteFromHash());
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
        onLeave={() => {
          location.hash = "";
          void refresh();
        }}
      />
    );
  }
  // An invite to a different crew than your own takes you back to the gate to accept it.
  if (ready && me.crew && (!invite || invite === me.crew.id)) return <HarborView me={me} refresh={refresh} />;
  return <Harbor me={me} refresh={refresh} invite={invite} />;
}
