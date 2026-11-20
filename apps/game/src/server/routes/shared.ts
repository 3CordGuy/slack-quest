// What the route modules share: the app's types, and the questions more
// than one of them puts to a room. A helper only one module uses lives in
// that module.

import type { Hono } from "hono";
import type { Env, Player } from "../db";
import { crewPlaces } from "../zones";

/** What every handler is given: the Worker's bindings, and (past the sign-in check) the player asking. */
export type AppEnv = { Bindings: Env; Variables: { player: Player } };
/** The app each route module registers its routes on (worker.ts makes it and calls them in order). */
export type GameApp = Hono<AppEnv>;

/** True if the player has a socket open in their own hut's room right now: they are standing in it. */
export async function inOwnHut(env: Env, playerId: string): Promise<boolean> {
  try {
    const res = await env.HUT_ROOM.get(env.HUT_ROOM.idFromName(playerId)).fetch("https://hut/present", { headers: { "x-hut-owner": playerId, "x-player-id": playerId } });
    return (await res.text()) === "yes";
  } catch {
    return false;
  }
}

/** Whoever of a crew is in the Harbor now, and the asker with them: who a map made this moment is sized for. */
export async function harborParty(env: Env, crewId: string, playerId: string) {
  const here = await env.HARBOR_ROOM.get(env.HARBOR_ROOM.idFromName(crewId))
    .fetch("https://harbor/present", { headers: { "x-crew-id": crewId } })
    .then((r) => (r.ok ? (r.json() as Promise<{ ids: string[] }>) : { ids: [] }))
    .then((r) => new Set([...r.ids, playerId]), () => new Set([playerId]));
  return (await crewPlaces(env.DB, crewId)).filter((m) => here.has(m.id));
}
