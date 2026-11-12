// HutRoom: one Durable Object per hut, for the walk-in room where its owner
// and visiting crewmates see each other and the furniture.
//
// Placeholder. The binding and class exist so the database, config and
// routes can be agreed first; the room itself is built in the huts work.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./db";

export class HutRoom extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    return new Response("Huts are not open yet.", { status: 501 });
  }
}
