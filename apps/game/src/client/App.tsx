// Two places: the Harbor (between voyages) and an Island (a live run).
// The hash carries the run code so a voyage survives a reload: #run/BCDF.

import { useCallback, useEffect, useState } from "react";
import { loadMe, type Me } from "./api";
import { Harbor } from "./Harbor";
import { RunView } from "./RunView";

const runCodeFromHash = () => /^#run\/([A-Za-z]{4})$/.exec(location.hash)?.[1].toUpperCase() ?? null;

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState(runCodeFromHash);

  const refresh = useCallback(() => loadMe().then(setMe, (e: Error) => setError(e.message)), []);
  useEffect(() => {
    void refresh();
    const onHash = () => setCode(runCodeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [refresh]);

  if (error) return <div className="centre"><div className="panel">Something went wrong: {error}</div></div>;
  if (!me) return <div className="centre"><div className="panel">Rowing ashore…</div></div>;
  if (code && me.character?.status === "active") {
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
  return <Harbor me={me} refresh={refresh} pendingCode={code} />;
}
