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
  HARBOR_SPAWN,
  generateHarbor,
  harborPath,
  type HarborClientMessage,
  type HarborPlayer,
  type HarborServerMessage,
} from "@gantt-quest/world";
import { getCrew, harborBoard, type Env } from "./db";

const MAP = generateHarbor();

export class HarborRoom extends DurableObject<Env> {
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

    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const id = request.headers.get("x-player-id");
    const crew = await getCrew(this.env.DB, crewId);
    if (!id || !crew) return new Response("missing player or crew", { status: 400 });

    // One socket per player. A new tab takes over, standing where the old one stood.
    let pos = HARBOR_SPAWN;
    for (const old of this.ctx.getWebSockets(id)) {
      pos = (old.deserializeAttachment() as HarborPlayer | null)?.pos ?? pos;
      old.serializeAttachment(null);
      old.close(4000, "replaced by a newer connection");
    }
    const player: HarborPlayer = {
      id,
      name: decodeURIComponent(request.headers.get("x-player-name") ?? "Sailor"),
      classId: request.headers.get("x-player-class") ?? "",
      level: Number(request.headers.get("x-player-level") ?? 1),
      pos,
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
      ws.serializeAttachment({ ...player, pos: path[path.length - 1] } satisfies HarborPlayer);
      this.broadcast({ type: "moved", id: player.id, path });
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
