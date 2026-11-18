// A small notice when this tab is running an older build than the one deployed.
//
// The game is deployed often and a tab can stay open for days. It keeps the code it loaded, while the
// server moves on, and nothing on the page says so. This asks the server which build is out (see
// ../build.ts): a little after the page loads, every few minutes, and when the tab is looked at again.
// It only tells the player and offers to load the new one: it takes no focus and stops nothing, so a
// fight can be finished first.

import { useEffect, useState } from "react";
import { BUILD_ID, isStale } from "../build";
import { RELEASES, incomingNotes, newestTagged, parseReleases, releaseTitle, type Release } from "../releases";
import { ReleaseLines } from "./ReleaseLines";

/** How long after the page loads before the first look: out of the way of everything else starting up. */
const FIRST_MS = 10_000;
const EVERY_MS = 5 * 60_000;
/** Coming back to the tab asks again, unless it was asked this recently. */
const FRESH_MS = 60_000;

/**
 * Development only: `?stale` makes this tab act like one left open since an older release, so the notice
 * and its list can be seen without deploying anything. `?stale=game-v2026.11.17.7` names the release the
 * tab was left on; `?stale` alone is the one before the newest. The list still comes from the server.
 */
function leftOpenSince(): readonly Release[] | null {
  if (!import.meta.env.DEV) return null;
  const q = new URLSearchParams(location.search);
  if (!q.has("stale")) return null;
  const since = q.get("stale") || RELEASES.filter((r) => !r.unreleased)[1]?.id;
  const at = RELEASES.findIndex((r) => r.id === since);
  return at >= 0 ? RELEASES.slice(at) : [];
}
const PRETEND = leftOpenSince();
/** The releases this tab's build lists, and the build it is. */
const MINE = PRETEND ?? RELEASES;
const MY_BUILD = PRETEND ? `${BUILD_ID}-stale` : BUILD_ID;

/** A newer build, and what it brings that this tab's build does not have. */
interface Newer {
  build: string;
  incoming: Release[];
}

/**
 * The build the server has deployed and the releases it has on top of this tab's, or null when it cannot
 * say (offline, or a server from before this). A server from before the notes sends none.
 */
async function deployedBuild(): Promise<Newer | null> {
  try {
    const res = await fetch(`/api/version?since=${encodeURIComponent(newestTagged(MINE) ?? "")}`, { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { build?: unknown; incoming?: unknown };
    return typeof data.build === "string" ? { build: data.build, incoming: incomingNotes(parseReleases(data.incoming), MINE) } : null;
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
  const [newer, setNewer] = useState<Newer | null>(null);
  /** The build the player said "Later" to: a newer one still asks again. */
  const [put, setPut] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** The list of what the newer build brings is open. */
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let last = 0;
    let gone = false;
    const look = async () => {
      last = Date.now();
      const deployed = await deployedBuild();
      if (!gone && deployed && isStale(MY_BUILD, deployed.build)) setNewer(deployed);
    };
    const first = setTimeout(look, PRETEND ? 500 : FIRST_MS);
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

  if (!newer || newer.build === put) return null;
  const { incoming } = newer;
  const listed = open && incoming.length > 0;
  return (
    <div className={`new-version ${listed ? "open" : ""}`} role="status" aria-live="polite">
      <span className="new-version-text">
        A newer version of the game is out.{" "}
        {incoming.length > 0 && (
          <button className="link new-version-more" aria-expanded={listed} aria-controls="new-version-notes" onClick={() => setOpen((o) => !o)}>
            {listed ? "Hide the list" : "What's in this release?"}
          </button>
        )}
      </span>
      <span className="new-version-actions">
        <button className="primary" disabled={loading} onClick={() => { setLoading(true); void loadNewVersion(); }}>
          {loading ? "Loading…" : "Load it now"}
        </button>
        <button disabled={loading} onClick={() => setPut(newer.build)}>Later</button>
      </span>
      {listed && (
        <div id="new-version-notes" className="new-version-notes">
          {incoming.map((r) => (
            <section key={r.id}>
              {incoming.length > 1 && <h3>{releaseTitle(r)}</h3>}
              <ReleaseLines notes={r.notes} />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
