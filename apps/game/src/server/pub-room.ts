// PubRoom: one Durable Object per crew, for the inside of the Harbor's pub.
//
// Presence, walking and chat work as they do in the Harbor and the huts
// (walk-room.ts): a relay with no tick loop and no alarm, with who is here
// kept in each socket's attachment so it survives hibernation. The room and
// its fittings are fixed, so nothing about them is stored. The game tables
// live here too (see stake-table.ts). Ordering a meal, and talking to
// the barkeep, are plain HTTP routes (routes/pub.ts); this object only relays
// people (and, via /bubble, what is said to and by the barkeep).

import { DurableObject } from "cloudflare:workers";
import { pubPath, pubRoom, type PubClientMessage, type PubServerMessage } from "@gantt-quest/world";
import { crewFor, getCharacter, heroInitFor, type Env, type Player } from "./db";
import { pubTables, type PubTable } from "./stake-table";
import type { PubGame } from "./pub-scores";
import { Walkers, hexAsked, walkerFrom } from "./walk-room";

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
  headers.set("x-crew-id", crew.id);
  return env.PUB_ROOM.get(env.PUB_ROOM.idFromName(crew.id)).fetch(new Request(request.url, { headers }));
}

export class PubRoom extends DurableObject<Env> {
  /** Who is here: presence, walking and chat. */
  private here: Walkers<PubServerMessage>;
  /** The game tables, by the `type` of the messages that reach them. */
  private tables: Map<PubGame, PubTable>;
  /** Whose pub this is, for the leaderboard. Kept in storage: the room is named after the crew, but cannot read its own name. */
  private crewId: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.here = new Walkers(ctx);
    this.tables = pubTables(ctx, env, () => this.crewId);
    void ctx.blockConcurrencyWhile(async () => {
      this.crewId = (await ctx.storage.get<string>("crewId")) ?? null;
    });
  }

  /** Seated players must be standing at their table: each table in turn settles who no longer is. `gone` is a socket that is closing. */
  private async reconcileTables(gone?: WebSocket): Promise<void> {
    for (const table of this.tables.values()) await table.reconcile(gone);
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    // A hero earned XP: show it over their head, if they are here.
    if (pathname === "/xp") return this.here.xpPosted(request);
    // A word with the barkeep (said over HTTP): hang it over the speaker for everyone here.
    if (pathname === "/bubble") {
      const body = (await request.json().catch(() => null)) as { id?: unknown; text?: unknown } | null;
      const id = typeof body?.id === "string" ? body.id : "";
      const text = String(body?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
      if (id && text) this.here.broadcast({ type: "bubble", id, text });
      return new Response("ok");
    }
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const id = request.headers.get("x-player-id");
    if (!id) return new Response("missing player", { status: 400 });
    const crewId = request.headers.get("x-crew-id");
    if (crewId && crewId !== this.crewId) {
      this.crewId = crewId;
      await this.ctx.storage.put("crewId", crewId);
    }

    // One socket per player. A new tab takes over, standing where the old one stood; anyone else arrives at the door.
    const pos = this.here.takeOver(id, DOOR);
    const player = walkerFrom(request, id, await heroInitFor(this.env.DB, id), pos);

    const pair = new WebSocketPair();
    this.here.admit(pair[1], player);
    this.here.send(pair[1], { type: "snapshot", you: id, players: this.here.players() });
    this.here.broadcast({ type: "joined", player }, pair[1]);
    for (const table of this.tables.values()) await table.welcome(pair[1], player);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const heard = this.here.read<PubClientMessage>(ws, message);
    if (!heard) return;
    const { player, msg } = heard;

    if (msg.type === "move") {
      const to = hexAsked(msg.to);
      if (!to) return;
      // A walk may end on a stool, to sit on it, unless someone else already is.
      const path = pubPath(ROOM, player.pos, to, this.here.othersAt(player.id));
      if (!path) return;
      this.here.walk(ws, player, path);
      // Walking away from a game table gives up a seat there.
      await this.reconcileTables();
    } else if (msg.type === "look") {
      this.here.look(ws, player, msg.look);
    } else if (msg.type === "unstick") {
      // Back to the door. Like walking away, it gives up a seat at a game table.
      if (this.here.unstick(ws, player, DOOR)) await this.reconcileTables();
    } else if (msg.type === "say") {
      this.here.say(player, msg.text);
    } else if (msg.type === "emote") {
      this.here.emote(player, msg.emote);
    } else {
      // Anything else is for a game table, by its game's name. One there is no table for is dropped.
      await this.tables.get(msg.type)?.handle(ws, player, msg.action);
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    // Leaving the pub gives up a seat at a game table too.
    if (this.here.closed(ws, code)) await this.reconcileTables(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011);
  }
}
