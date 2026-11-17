// A small notice when this tab is running an older build than the one deployed.
//
// The game is deployed often and a tab can stay open for days. It keeps the code it loaded, while the
// server moves on, and nothing on the page says so. This asks the server which build is out (see
// ../build.ts): a little after the page loads, every few minutes, and when the tab is looked at again.
// It only tells the player and offers to load the new one: it takes no focus and stops nothing, so a
// fight can be finished first.

import { useEffect, useState } from "react";
import { BUILD_ID, isStale } from "../build";

/** How long after the page loads before the first look: out of the way of everything else starting up. */
const FIRST_MS = 10_000;
const EVERY_MS = 5 * 60_000;
/** Coming back to the tab asks again, unless it was asked this recently. */
const FRESH_MS = 60_000;

/** The build the server has deployed, or null when it cannot say (offline, or a server from before this). */
async function deployedBuild(): Promise<string | null> {
  try {
    const res = await fetch("/api/version", { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { build?: unknown };
    return typeof data.build === "string" ? data.build : null;
  } catch {
    return null;
  }
}

/** Load the page again, fetching it afresh first so a browser that kept the old page (Safari) lets go of it. */
async function loadNewVersion() {
  await fetch(location.href, { cache: "reload" }).catch(() => undefined);
  location.reload();
}

export function NewVersionNotice() {
  /** The newer build the server reported, once it has. */
  const [newer, setNewer] = useState<string | null>(null);
  /** The build the player said "Later" to: a newer one still asks again. */
  const [put, setPut] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let last = 0;
    let gone = false;
    const look = async () => {
      last = Date.now();
      const deployed = await deployedBuild();
      if (!gone && isStale(BUILD_ID, deployed)) setNewer(deployed);
    };
    const first = setTimeout(look, FIRST_MS);
    const every = setInterval(look, EVERY_MS);
    const seen = () => {
      if (document.visibilityState === "visible" && Date.now() - last > FRESH_MS) void look();
    };
    document.addEventListener("visibilitychange", seen);
    return () => {
      gone = true;
      clearTimeout(first);
      clearInterval(every);
      document.removeEventListener("visibilitychange", seen);
    };
  }, []);

  if (!newer || newer === put) return null;
  return (
    <div className="new-version" role="status" aria-live="polite">
      <span className="new-version-text">A newer version of the game is out.</span>
      <span className="new-version-actions">
        <button className="primary" disabled={loading} onClick={() => { setLoading(true); void loadNewVersion(); }}>
          {loading ? "Loading…" : "Load it now"}
        </button>
        <button disabled={loading} onClick={() => setPut(newer)}>Later</button>
      </span>
    </div>
  );
}
