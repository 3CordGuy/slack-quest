// HarborRoom: one Durable Object per crew, holding that crew's shared,
// walkable Harbor.
//
// It is a relay, not a simulation. Players walk freely; the object checks
// each requested path against the fixed Harbor map and tells everyone
// present. There is no tick loop and no alarm. Who is here and where they
// stand lives in each socket's attachment, so it survives hibernation
// without touching D1. Crew membership, ships and the voyage log are read
// from D1, which stays the system of record.

import { DurableObject } from "cloudflare:workers";
import {
  HARBOR_MAX_SAY,
  HARBOR_PIERS,
  HARBOR_PLOTS,
  HARBOR_PUB,
  HARBOR_SPAWN,
  UNSTICK_COOLDOWN_MS,
  generateHarbor,
  fishSpotAt,
  harborPath,
  type HarborClientMessage,
  type HarborPlayer,
  type HarborServerMessage,
} from "@gantt-quest/world";
import { getCrew, harborBoard, heroInitFor, type Env } from "./db";
import { readXpPost, relayXp } from "./harbor-xp";

const MAP = generateHarbor();

export class HarborRoom extends DurableObject<Env> {
  /** When each player last asked to be put back at the spawn. In memory only: a light limit, and a hibernation resets it. */
  private unstuckAt = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private players(except?: WebSocket): HarborPlayer[] {
    const seen = new Map<string, HarborPlayer>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const p = ws.deserializeAttachment() as HarborPlayer | null;
      if (p) seen.set(p.id, p);
    }
    return [...seen.values()];
  }

  private broadcast(message: HarborServerMessage, except?: WebSocket) {
    const data = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(data);
      } catch {
        // Socket is closing; webSocketClose will follow.
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const crewId = request.headers.get("x-crew-id");
    if (!crewId) return new Response("missing crew", { status: 400 });

    // A ship changed (launched, boarded, sailed, came home): re-read the board.
    if (new URL(request.url).pathname === "/refresh") {
      if (this.ctx.getWebSockets().length > 0) {
        this.broadcast({ type: "board", ...(await harborBoard(this.env.DB, crewId, HARBOR_PIERS.length)) });
      }
      return new Response("ok");
    }

    // A hero earned XP: show it over their head, if they are here.
    if (new URL(request.url).pathname === "/xp") {
      const msg = await readXpPost(request);
      if (msg) relayXp(this.ctx, msg, (m) => this.broadcast(m));
      return new Response("ok");
    }

    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const id = request.headers.get("x-player-id");
    const crew = await getCrew(this.env.DB, crewId);
    if (!id || !crew) return new Response("missing player or crew", { status: 400 });

    // One socket per player. A new tab takes over, standing where the old one stood.
    // Someone stepping out of a hut or the pub arrives at its door.
    const at = new URL(request.url).searchParams.get("at");
    let pos = (at === "pub" ? HARBOR_PUB : at !== null && /^\d{1,2}$/.test(at) ? HARBOR_PLOTS[Number(at)] : undefined) ?? HARBOR_SPAWN;
    for (const old of this.ctx.getWebSockets(id)) {
      pos = (old.deserializeAttachment() as HarborPlayer | null)?.pos ?? pos;
      old.serializeAttachment(null);
      old.close(4000, "replaced by a newer connection");
    }
    const hero = await heroInitFor(this.env.DB, id);
    const player: HarborPlayer = {
      id,
      name: decodeURIComponent(request.headers.get("x-player-name") ?? "Sailor"),
      classId: request.headers.get("x-player-class") ?? "",
      level: hero?.level ?? Number(request.headers.get("x-player-level") ?? 1),
      xp: hero?.xp,
      pos,
      outfit: hero?.outfit,
    };

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [id]);
    pair[1].serializeAttachment(player);

    const board = await harborBoard(this.env.DB, crewId, HARBOR_PIERS.length);
    pair[1].send(JSON.stringify({ type: "snapshot", you: id, crew, players: this.players(), ...board } satisfies HarborServerMessage));
    this.broadcast({ type: "joined", player }, pair[1]);
    // Their arrival may also be news for the roster (a brand-new member).
    this.broadcast({ type: "board", ...board }, pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > 2000) return;
    const player = ws.deserializeAttachment() as HarborPlayer | null;
    if (!player) return;
    let msg: HarborClientMessage;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    if (msg.type === "move") {
      const to = { q: Number(msg.to?.q), r: Number(msg.to?.r) };
      if (!Number.isInteger(to.q) || !Number.isInteger(to.r)) return;
      const path = harborPath(MAP, player.pos, to);
      if (!path) return;
      // Walking off rolls the bedroll back up.
      ws.serializeAttachment({ ...player, pos: path[path.length - 1], bedroll: undefined, fishing: undefined } satisfies HarborPlayer);
      this.broadcast({ type: "moved", id: player.id, path });
    } else if (msg.type === "refresh") {
      // They changed gear or levelled: re-read the character and show everyone the new look.
      const hero = await heroInitFor(this.env.DB, player.id);
      if (!hero) return;
      const next: HarborPlayer = { ...player, name: hero.name, classId: hero.classId, level: hero.level, xp: hero.xp, outfit: hero.outfit };
      ws.serializeAttachment(next);
      this.broadcast({ type: "joined", player: next });
    } else if (msg.type === "bedroll") {
      // Purely for show: the rest itself is decided by the server over HTTP. Not on a place, a street corner is fine.
      if (MAP.pois.some((p) => p.pos.q === player.pos.q && p.pos.r === player.pos.r)) return;
      const next: HarborPlayer = { ...player, bedroll: player.pos };
      ws.serializeAttachment(next);
      this.broadcast({ type: "joined", player: next });
    } else if (msg.type === "fishing") {
      // Purely for show, like the bedroll: the sitting itself is the server's over HTTP. Only at a fishing spot.
      const on = msg.on === true && fishSpotAt(player.pos) !== null;
      if (!!player.fishing === on) return;
      const next: HarborPlayer = { ...player, fishing: on || undefined };
      ws.serializeAttachment(next);
      this.broadcast({ type: "joined", player: next });
    } else if (msg.type === "unstick") {
      // A stuck or lost hero goes back where heroes arrive. Only ever the sender's own hero: the socket says who that is.
      const now = Date.now();
      if (now - (this.unstuckAt.get(player.id) ?? -Infinity) < UNSTICK_COOLDOWN_MS) return;
      this.unstuckAt.set(player.id, now);
      ws.serializeAttachment({ ...player, pos: HARBOR_SPAWN, bedroll: undefined } satisfies HarborPlayer);
      this.broadcast({ type: "placed", id: player.id, pos: HARBOR_SPAWN });
    } else if (msg.type === "say") {
      const text = String(msg.text ?? "").replace(/\s+/g, " ").trim().slice(0, HARBOR_MAX_SAY);
      if (text) this.broadcast({ type: "said", id: player.id, name: player.name, text });
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    const player = ws.deserializeAttachment() as HarborPlayer | null;
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      // Already closed.
    }
    // A replaced socket has its attachment cleared, so the player has not really left.
    if (player) this.broadcast({ type: "left", id: player.id }, ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011);
  }
}
