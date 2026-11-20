// The build a tab should be running, and the notice board's release notes:
// which of them a player has read.

import { BUILD_ID } from "../../build";
import { releasesSince } from "../../releases";
import { markReleaseSeen } from "../releases";
import type { GameApp } from "./shared";

/** Open to anyone: registered before the sign-in check. */
export function versionRoutes(app: GameApp): void {
  /**
   * The build now deployed (see build.ts). A tab asks from time to time and tells its player when it is running
   * an older one. Open to anyone and never cached: it must be this Worker's own answer, and it says nothing
   * that the page's script does not.
   *
   * A tab that names the newest release it knows (`?since=game-v2026.11.18.3`) is also told what this build
   * brings on top of it: the notice board's notes for every release after that one (see releases.ts).
   */
  app.get("/api/version", (c) => {
    c.header("Cache-Control", "no-store");
    const since = c.req.query("since");
    return c.json(since === undefined ? { build: BUILD_ID } : { build: BUILD_ID, incoming: releasesSince(since) });
  });
}

export function releaseRoutes(app: GameApp): void {
  // ---------- the notice board: release notes ----------

  // The player has read the board's notes up to this release; the "!" over the board goes.
  app.post("/api/releases/seen", async (c) => {
    const body = await c.req.json<{ id?: unknown }>().catch(() => ({}) as { id?: unknown });
    const id = typeof body.id === "string" ? body.id : "";
    if (!(await markReleaseSeen(c.env.DB, c.get("player").id, id))) return c.json({ error: "No such release." }, 400);
    return c.json({ seenRelease: id });
  });
}
