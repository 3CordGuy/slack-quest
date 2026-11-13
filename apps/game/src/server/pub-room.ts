// PubRoom: one Durable Object per crew, for the inside of the Harbor's pub.
//
// Presence, walking and chat work as they do in the Harbor and the huts: a
// relay with no tick loop and no alarm, with who is here kept in each
// socket's attachment so it survives hibernation. The room and its fittings
// are fixed, so nothing about them is stored. The two game tables live here
// too (see stake-table.ts). Ordering food and drink, and talking to the barkeep,
// are plain HTTP routes in worker.ts; this object only relays people.

import { DurableObject } from "cloudflare:workers";
import { HARBOR_MAX_SAY, UNSTICK_COOLDOWN_MS, pubPath, pubRoom, type DiceGame, type DiceRequest, type HarborPlayer, type PubClientMessage, type PubServerMessage, type ShoalsGame, type ShoalsRequest } from "@gantt-quest/world";
import { crewFor, getCharacter, heroInitFor, type Env, type Player } from "./db";
import { DICE_RULES, SHOALS_RULES, StakeTable } from "./stake-table";
import { readXpPost, relayXp } from "./harbor-xp";

const ROOM = pubRoom();
const DOOR = ROOM.pois.find((p) => p.kind === "door")!.pos;

/** The Worker's side of `GET /api/pub/ws`: the pub belongs to a crew, so only its members get in. */
export async function enterPub(env: Env, player: Player, request: Request): Promise<Response> {
  const [character, crew] = await Promise.all([getCharacter(env.DB, player.id), crewFor(env.DB, player.id)]);
  if (character?.status !== "active") return new Response("Create a character first.", { status: 409 });
  if (!crew) return new Response("The pub is for crews. Join one first.", { status: 403 });
  const headers = new Headers(request.headers);
  headers.set("x-player-id", player.id);
  headers.set("x-player-name", encodeURIComponent(character.name));
  headers.set("x-player-class", character.class_id);
  headers.set("x-player-level", String(character.level));
  return env.PUB_ROOM.get(env.PUB_ROOM.idFromName(crew.id)).fetch(new Request(request.url, { headers }));
}

export class PubRoom extends DurableObject<Env> {
  private dice: StakeTable<DiceGame, DiceRequest>;
  private shoals: StakeTable<ShoalsGame, ShoalsRequest>;
  /** When each player last asked to be put back at the door. In memory only: a light limit. */
  private unstuckAt = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.dice = new StakeTable(ctx, env, DICE_RULES);
    this.shoals = new StakeTable(ctx, env, SHOALS_RULES);
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

  private send(ws: WebSocket, message: PubServerMessage) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // Socket is closing; webSocketClose will follow.
    }
  }

  private broadcast(message: PubServerMessage, except?: WebSocket) {
    for (const ws of this.ctx.getWebSockets()) if (ws !== except) this.send(ws, message);
  }

  async fetch(request: Request): Promise<Response> {
    // A hero earned XP: show it over their head, if they are here.
    if (new URL(request.url).pathname === "/xp") {
      const msg = await readXpPost(request);
      if (msg) relayXp(this.ctx, msg, (m) => this.broadcast(m));
      return new Response("ok");
    }
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const id = request.headers.get("x-player-id");
    if (!id) return new Response("missing player", { status: 400 });

    // One socket per player. A new tab takes over, standing where the old one stood.
    let pos = DOOR;
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
    this.send(pair[1], { type: "snapshot", you: id, players: this.players() });
    this.broadcast({ type: "joined", player }, pair[1]);
    await this.dice.welcome(pair[1], player);
    await this.shoals.welcome(pair[1], player);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > 2000) return;
    const player = ws.deserializeAttachment() as HarborPlayer | null;
    if (!player) return;
    let msg: PubClientMessage;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    if (msg.type === "move") {
      const to = { q: Number(msg.to?.q), r: Number(msg.to?.r) };
      if (!Number.isInteger(to.q) || !Number.isInteger(to.r)) return;
      const path = pubPath(ROOM, player.pos, to);
      if (!path) return;
      ws.serializeAttachment({ ...player, pos: path[path.length - 1] } satisfies HarborPlayer);
      this.broadcast({ type: "moved", id: player.id, path });
      // Walking away from a game table gives up a seat there.
      await this.dice.reconcile();
      await this.shoals.reconcile();
    } else if (msg.type === "unstick") {
      // A stuck or lost hero goes back to the door. Only ever the sender's own hero.
      const now = Date.now();
      if (now - (this.unstuckAt.get(player.id) ?? -Infinity) < UNSTICK_COOLDOWN_MS) return;
      this.unstuckAt.set(player.id, now);
      ws.serializeAttachment({ ...player, pos: DOOR } satisfies HarborPlayer);
      this.broadcast({ type: "placed", id: player.id, pos: DOOR });
      // Like walking away, it gives up a seat at a game table.
      await this.dice.reconcile();
      await this.shoals.reconcile();
    } else if (msg.type === "say") {
      const text = String(msg.text ?? "").replace(/\s+/g, " ").trim().slice(0, HARBOR_MAX_SAY);
      if (text) this.broadcast({ type: "said", id: player.id, name: player.name, text });
    } else if (msg.type === "dice") {
      await this.dice.handle(ws, player, msg.action);
    } else if (msg.type === "shoals") {
      await this.shoals.handle(ws, player, msg.action);
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
    if (player) {
      this.broadcast({ type: "left", id: player.id }, ws);
      await this.dice.reconcile(ws);
      await this.shoals.reconcile(ws);
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011);
  }
}
