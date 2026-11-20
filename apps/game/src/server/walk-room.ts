// What the walk-in rooms have in common. The Harbor (harbor-room.ts), a hut
// (hut-room.ts) and the pub (pub-room.ts) are each a Durable Object that
// relays the people walking about in it, and this is that relay: who is
// here, telling them things, a newer tab taking over from an older one,
// walking, looking, getting unstuck, talking, leaving, and XP shown over a
// hero's head.
//
// Who is here and where they stand is each socket's attachment (a
// HarborPlayer), so it survives hibernation without touching D1. A socket
// whose attachment has been cleared has nobody behind it: a newer tab of
// the same player took over. The only things kept in memory are two light
// rate limits, which a hibernation resets.
//
// A room holds one `Walkers`, typed with the messages that room sends, and
// keeps its own rules in its own file: where people arrive, which way they
// may walk, who may come in, and whatever else the room is for. A new
// walk-in room is a Durable Object that does the same:
//
//   fetch             `/xp` to xpPosted; on an upgrade, takeOver (where they
//                     stand), walkerFrom (who they are), admit, then the
//                     room's own snapshot and a "joined" to everyone else
//   webSocketMessage  read; "move" is hexAsked, the room's own path, walk;
//                     "look", "unstick", "say" and "emote" are look, unstick, say
//                     and emote
//   webSocketClose    closed

import type { HexPos } from "@gantt-quest/core";
import { EMOTE_MIN_MS, HARBOR_MAX_SAY, LOOK_MIN_MS, UNSTICK_COOLDOWN_MS, validEmote, validLook, type EmoteMessage, type HarborPlayer, type HeroInit, type LookMessage, type XpMessage } from "@gantt-quest/world";
import { readXpPost, relayXp } from "./harbor-xp";

/** What every walk-in room tells its sockets about the people in it. Each room's own messages include these. */
export type WalkerMessage =
  | { type: "joined"; player: HarborPlayer }
  | { type: "left"; id: string }
  | { type: "moved"; id: string; path: HexPos[] }
  | { type: "placed"; id: string; pos: HexPos }
  | { type: "said"; id: string; name: string; text: string }
  | LookMessage
  | EmoteMessage
  | XpMessage;

/** A room's own messages, given that they include the ones sent from here. For a room whose messages lack one of those, nothing can be sent at all. */
type Sendable<Out> = [WalkerMessage] extends [Out] ? Out : never;

/** Send something down one socket. One that is closing throws, and its webSocketClose will follow: that is let go. */
export function sendTo(ws: WebSocket, message: object): void {
  post(ws, JSON.stringify(message));
}

function post(ws: WebSocket, data: string): void {
  try {
    ws.send(data);
  } catch {
    // Socket is closing; webSocketClose will follow.
  }
}

/** Every socket here with someone behind it, and who that is. `except`: a socket to leave out (one that is closing). */
export function attended(ctx: DurableObjectState, except?: WebSocket): { ws: WebSocket; player: HarborPlayer }[] {
  const out: { ws: WebSocket; player: HarborPlayer }[] = [];
  for (const ws of ctx.getWebSockets()) {
    if (ws === except) continue;
    const player = ws.deserializeAttachment() as HarborPlayer | null;
    if (player) out.push({ ws, player });
  }
  return out;
}

/**
 * Finish closing a socket whose other end has closed: with the code it closed with, or a plain 1000 where it
 * gave none (1005) or the connection dropped (1006), neither of which may be sent.
 */
export function closeBack(ws: WebSocket, code: number): void {
  try {
    ws.close(code === 1005 || code === 1006 ? 1000 : code);
  } catch {
    // Already closed.
  }
}

/**
 * A trade changed: tell each player it concerns (every `to` the Worker named) to look again, if they are here.
 * Nobody else hears of it. Sockets are found by their player's id, which every room tags them with.
 */
export function tellTrades(ctx: DurableObjectState, to: string[]): Response {
  const data = JSON.stringify({ type: "trades" });
  for (const id of to) for (const ws of ctx.getWebSockets(id)) post(ws, data);
  return new Response("ok");
}

/** Who is walking in: what the Worker put in the request's headers, their hero as it is now, and where they are to stand. */
export function walkerFrom(request: Request, id: string, hero: HeroInit | null, pos: HexPos): HarborPlayer {
  return {
    id,
    name: decodeURIComponent(request.headers.get("x-player-name") ?? "Sailor"),
    classId: request.headers.get("x-player-class") ?? "",
    level: hero?.level ?? Number(request.headers.get("x-player-level") ?? 1),
    xp: hero?.xp,
    pos,
    outfit: hero?.outfit,
  };
}

/** Someone already here, with their hero read again: a new name, level or look. */
export function withHero(player: HarborPlayer, hero: HeroInit): HarborPlayer {
  return { ...player, name: hero.name, classId: hero.classId, level: hero.level, xp: hero.xp, outfit: hero.outfit };
}

/** The hex a "move" asks to walk to, or null if what was sent is not one. */
export function hexAsked(to: unknown): HexPos | null {
  const asked = to as { q?: unknown; r?: unknown } | null | undefined;
  const hex = { q: Number(asked?.q), r: Number(asked?.r) };
  return Number.isInteger(hex.q) && Number.isInteger(hex.r) ? hex : null;
}

/**
 * The people walking about one room. `Out` is the room's own union of messages to its clients: what the room
 * sends through here is checked against it, and it has to include the messages sent from here (WalkerMessage).
 */
export class Walkers<Out> {
  /** When each player last asked to be put back where people arrive. In memory only: a light limit, and a hibernation resets it. */
  private unstuckAt = new Map<string, number>();
  /** When each player's look was last passed on, so a waving pointer cannot flood the room. */
  private lookedAt = new Map<string, number>();
  /** When each player last emoted, so a held key cannot flood the room. */
  private emotedAt = new Map<string, number>();

  constructor(private ctx: DurableObjectState) {
    // Pings are answered by the runtime, without waking the room.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ---------- who is here, and telling them ----------

  /** Everyone here, each once however many sockets they have. `except`: a socket to leave out. */
  players(except?: WebSocket): HarborPlayer[] {
    const seen = new Map<string, HarborPlayer>();
    for (const { player } of attended(this.ctx, except)) seen.set(player.id, player);
    return [...seen.values()];
  }

  /** Where everyone but this player stands: what a walk may not end on (a stool someone else is sitting on). */
  othersAt(id: string): HexPos[] {
    return this.players().filter((p) => p.id !== id).map((p) => p.pos);
  }

  /** Tell one socket. */
  send(ws: WebSocket, message: Sendable<Out>): void {
    post(ws, JSON.stringify(message));
  }

  /** Tell every socket here. `except`: one to leave out. */
  broadcast(message: Sendable<Out>, except?: WebSocket): void {
    this.toAll(JSON.stringify(message), except);
  }

  /** `broadcast`, for what is sent from here: one of every room's messages, whichever room this is. */
  private tell(message: WalkerMessage, except?: WebSocket): void {
    this.toAll(JSON.stringify(message), except);
  }

  private toAll(data: string, except?: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) if (ws !== except) post(ws, data);
  }

  // ---------- walking in ----------

  /**
   * One socket per player: a newer tab takes over from any older one of theirs, which is closed (4000) with its
   * attachment cleared, so that its closing is not taken for the player leaving. Gives where the newcomer is to
   * stand: where the older tab stood, or `pos` if there was none.
   */
  takeOver(id: string, pos: HexPos): HexPos {
    for (const old of this.ctx.getWebSockets(id)) {
      pos = (old.deserializeAttachment() as HarborPlayer | null)?.pos ?? pos;
      old.serializeAttachment(null);
      old.close(4000, "replaced by a newer connection");
    }
    return pos;
  }

  /** Take the server's end of a new socket into the room as this player. It is tagged with their id, to be found by, and with any `tags` the room adds. */
  admit(ws: WebSocket, player: HarborPlayer, ...tags: string[]): void {
    this.ctx.acceptWebSocket(ws, [player.id, ...tags]);
    ws.serializeAttachment(player);
  }

  // ---------- what the people here send ----------

  /**
   * A message from a socket, and who is behind it. Null if there is nothing to act on: it is not text, is too
   * long or is not JSON, or a newer tab has taken over from this socket.
   */
  read<In>(ws: WebSocket, message: string | ArrayBuffer): { player: HarborPlayer; msg: In } | null {
    if (typeof message !== "string" || message.length > 2000) return null;
    const player = ws.deserializeAttachment() as HarborPlayer | null;
    if (!player) return null;
    try {
      return { player, msg: JSON.parse(message) as In };
    } catch {
      return null;
    }
  }

  /**
   * They walk `path`, a way the room has found for them, and stand where it ends: kept on their socket, and
   * everyone is told. `ends`: what walking off puts an end to in this room (a bedroll, lying in bed). Gives them
   * as they now are.
   */
  walk(ws: WebSocket, player: HarborPlayer, path: HexPos[], ends: Partial<HarborPlayer> = {}): HarborPlayer {
    const next: HarborPlayer = { ...player, pos: path[path.length - 1], ...ends };
    ws.serializeAttachment(next);
    this.tell({ type: "moved", id: player.id, path });
    return next;
  }

  /** Which way they are looking: passed on to everyone else here, and not kept. At most one per LOOK_MIN_MS from each player. */
  look(ws: WebSocket, player: HarborPlayer, asked: unknown): void {
    const look = validLook(asked);
    const now = Date.now();
    if (look === null || now - (this.lookedAt.get(player.id) ?? -Infinity) < LOOK_MIN_MS) return;
    this.lookedAt.set(player.id, now);
    this.tell({ type: "looked", id: player.id, look }, ws);
  }

  /**
   * A stuck or lost hero is put straight onto `pos`, where people arrive in this room, and everyone is told.
   * Only ever the sender's own hero: the socket says who that is. At most once per UNSTICK_COOLDOWN_MS for each
   * player: false if this one came too soon and was dropped. `ends`: as for `walk`.
   */
  unstick(ws: WebSocket, player: HarborPlayer, pos: HexPos, ends: Partial<HarborPlayer> = {}): boolean {
    const now = Date.now();
    if (now - (this.unstuckAt.get(player.id) ?? -Infinity) < UNSTICK_COOLDOWN_MS) return false;
    this.unstuckAt.set(player.id, now);
    ws.serializeAttachment({ ...player, pos, ...ends } satisfies HarborPlayer);
    this.tell({ type: "placed", id: player.id, pos });
    return true;
  }

  /** A line of chat, tidied and cut to length, to everyone here (the speaker too). Nothing, if nothing is left of it. */
  say(player: HarborPlayer, said: unknown): void {
    const text = String(said ?? "").replace(/\s+/g, " ").trim().slice(0, HARBOR_MAX_SAY);
    if (text) this.tell({ type: "said", id: player.id, name: player.name, text });
  }

  /** An emote (a wave, a dance and so on), shown to everyone here (the one emoting too) and not kept. At most one per EMOTE_MIN_MS from each player. */
  emote(player: HarborPlayer, asked: unknown): void {
    const emote = validEmote(asked);
    const now = Date.now();
    if (emote === null || now - (this.emotedAt.get(player.id) ?? -Infinity) < EMOTE_MIN_MS) return;
    this.emotedAt.set(player.id, now);
    this.tell({ type: "emoted", id: player.id, emote });
  }

  /** Something about a hero that everyone sees has changed (their gear, a bedroll laid out): kept on their socket, and everyone is shown them again. */
  show(ws: WebSocket, player: HarborPlayer): void {
    ws.serializeAttachment(player);
    this.tell({ type: "joined", player });
  }

  // ---------- leaving, and news from the Worker ----------

  /**
   * A socket has closed: it is closed from this end too, and if someone was behind it everyone else is told they
   * have left. Gives who that was, or null for a socket a newer tab took over: its attachment was cleared, so the
   * player has not really left.
   */
  closed(ws: WebSocket, code: number): HarborPlayer | null {
    const player = ws.deserializeAttachment() as HarborPlayer | null;
    closeBack(ws, code);
    if (player) this.tell({ type: "left", id: player.id }, ws);
    return player;
  }

  /** The Worker's `POST /xp`: a hero earned XP. If they are here, it is noted on their socket and shown over their head to everyone. */
  async xpPosted(request: Request): Promise<Response> {
    const msg = await readXpPost(request);
    if (msg) relayXp(this.ctx, msg, (m) => this.tell(m));
    return new Response("ok");
  }
}
