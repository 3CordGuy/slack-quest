// HutRoom: one Durable Object per hut (named by its owner's player id), for
// the walk-in room where the owner and visiting crewmates see each other and
// the furniture.
//
// Presence, walking and chat work as they do in HarborRoom: a relay with no
// tick loop and no alarm, with who is here kept in each socket's attachment
// so it survives hibernation. The hut's tier and furniture live in D1; this
// object keeps a copy in memory that it reloads after hibernating. Only the
// owner may move furniture, and every change is written to D1 before anyone
// is told about it.

import { DurableObject } from "cloudflare:workers";
import {
  FURNISHINGS,
  HARBOR_MAX_SAY,
  STORAGE_CHEST,
  freeSpot,
  placedFurnishings,
  hutDoor,
  hutPath,
  hutRoom,
  placeProblem,
  validFacing,
  type Furnishing,
  type HarborPlayer,
  type HutClientMessage,
  type HutServerMessage,
  type WorldMap,
} from "@gantt-quest/world";
import { carryState, crewFor, furnishingStatement, getCharacter, getHut, getStored, hasShack, heroInitFor, homeOf, rowToItem, takeStoredItem, type Env, type Player } from "./db";

/** What a player with nothing at all is given the first time they open their own hut. */
const STARTER_SET = ["table", "chair", "rug"];

interface Hut {
  tier: number;
  room: WorldMap;
  furnishings: Furnishing[];
}

/**
 * The Worker's side of `GET /api/hut/:owner/ws`: check that this player may
 * walk into that hut, then hand the socket to the hut's room. A hut is open
 * to its owner and to members of the owner's crew.
 */
export async function enterHut(env: Env, player: Player, ownerId: string, request: Request): Promise<Response> {
  const [character, owner, crew, ownerCrew] = await Promise.all([
    getCharacter(env.DB, player.id),
    ownerId === player.id ? null : getCharacter(env.DB, ownerId),
    crewFor(env.DB, player.id),
    ownerId === player.id ? null : crewFor(env.DB, ownerId),
  ]);
  if (character?.status !== "active") return new Response("Create a character first.", { status: 409 });
  const mine = ownerId === player.id;
  // The same answer whether the hut does not exist or belongs to another crew.
  if (!mine && (owner?.status !== "active" || !crew || ownerCrew?.id !== crew.id)) {
    return new Response("That hut is not in your crew's Harbor.", { status: 403 });
  }
  // A hut stands on a plot, once its shack is up: until then there is nothing to walk into.
  if (!(await hasShack(env.DB, ownerId))) {
    const bought = (await homeOf(env.DB, ownerId)).plot !== null;
    const reason = mine
      ? bought ? "Your plot has only a resource bin on it. Fill it and the shack goes up." : "You have no hut yet. Buy a plot in the Harbor first."
      : bought ? "Their shack is not built yet." : "They have not built a hut yet.";
    return new Response(reason, { status: 403 });
  }
  const headers = new Headers(request.headers);
  headers.set("x-hut-owner", ownerId);
  headers.set("x-hut-owner-name", encodeURIComponent(mine ? character.name : owner!.name));
  headers.set("x-player-id", player.id);
  headers.set("x-player-name", encodeURIComponent(character.name));
  headers.set("x-player-class", character.class_id);
  headers.set("x-player-level", String(character.level));
  return env.HUT_ROOM.get(env.HUT_ROOM.idFromName(ownerId)).fetch(new Request(request.url, { headers }));
}

export class HutRoom extends DurableObject<Env> {
  /** Cached copy of the hut. Gone after hibernation; D1 has the truth. */
  private hut: Hut | null = null;
  private loading: Promise<Hut> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private async read(ownerId: string): Promise<Hut> {
    const { tier, furnishings } = await getHut(this.env.DB, ownerId);
    return { tier, room: hutRoom(tier), furnishings };
  }

  /** The hut, from memory or D1. Concurrent callers share one read. */
  private load(ownerId: string, fresh = false): Promise<Hut> {
    if (this.hut && !fresh) return Promise.resolve(this.hut);
    this.loading ??= this.read(ownerId)
      .then((hut) => (this.hut = hut))
      .finally(() => (this.loading = null));
    return this.loading;
  }

  /**
   * The owner opening a hut while owning no furnishings at all gets a few to
   * start with. Every home also comes with one free storage chest, standing
   * in the room; a hut built before chests existed gets it on the owner's
   * next visit. The insert checks for a chest itself, so two tabs at once
   * cannot both add one.
   */
  private async stock(ownerId: string): Promise<Hut> {
    const hut = await this.load(ownerId, true);
    const statements: D1PreparedStatement[] = [];
    if (hut.furnishings.length === 0) {
      statements.push(...STARTER_SET.map((defId) => furnishingStatement(this.env.DB, ownerId, { defId, label: FURNISHINGS[defId].name })));
    }
    if (!hut.furnishings.some((f) => f.defId === STORAGE_CHEST)) {
      const spot = freeSpot(hut.room, placedFurnishings(hut.furnishings), STORAGE_CHEST, hutDoor(hut.tier));
      statements.push(
        this.env.DB
          .prepare(
            `INSERT INTO furnishings (player_id, def_id, label, meta_json, q, r, facing, created_at)
             SELECT ?1, ?2, ?3, '{}', ?4, ?5, 0, ?6 WHERE NOT EXISTS (SELECT 1 FROM furnishings WHERE player_id = ?1 AND def_id = ?2)`,
          )
          .bind(ownerId, STORAGE_CHEST, FURNISHINGS[STORAGE_CHEST].name, spot?.q ?? null, spot?.r ?? null, Date.now()),
      );
    }
    if (statements.length === 0) return hut;
    await this.env.DB.batch(statements);
    return this.load(ownerId, true);
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

  private send(ws: WebSocket, message: HutServerMessage) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // Socket is closing; webSocketClose will follow.
    }
  }

  private broadcast(message: HutServerMessage, except?: WebSocket) {
    for (const ws of this.ctx.getWebSockets()) if (ws !== except) this.send(ws, message);
  }

  /**
   * Tell the owner, on every socket they have in this room, what is in their
   * storage chest and how full their pack is. Visitors never see it.
   */
  private async sendChest(ownerId: string): Promise<void> {
    const sockets = this.ctx.getWebSockets(ownerId);
    if (sockets.length === 0) return;
    const [rows, carry] = await Promise.all([getStored(this.env.DB, ownerId), carryState(this.env.DB, ownerId)]);
    const message: HutServerMessage = { type: "chest", items: rows.map((r) => ({ ...rowToItem(r), id: r.id })), carried: carry?.carried ?? 0, limit: carry?.limit ?? 0 };
    for (const ws of sockets) this.send(ws, message);
  }

  /** The owner's id is the tag every socket in this room carries besides its player's. */
  private ownerId(ws: WebSocket): string | null {
    return this.ctx.getTags(ws).find((t) => t.startsWith("owner:"))?.slice(6) ?? null;
  }

  async fetch(request: Request): Promise<Response> {
    const ownerId = request.headers.get("x-hut-owner");
    if (!ownerId) return new Response("missing hut", { status: 400 });

    // The hut changed from outside this room (a new furnishing, a bigger hut): re-read it.
    if (new URL(request.url).pathname === "/refresh") {
      if (this.ctx.getWebSockets().length > 0) {
        const hut = await this.load(ownerId, true);
        this.broadcast({ type: "furnishings", tier: hut.tier, furnishings: hut.furnishings });
        // Gear may have gone into or out of the chest from the inventory screen.
        await this.sendChest(ownerId);
      } else {
        this.hut = null;
      }
      return new Response("ok");
    }

    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const id = request.headers.get("x-player-id");
    if (!id) return new Response("missing player", { status: 400 });
    const canEdit = id === ownerId;
    const hut = canEdit ? await this.stock(ownerId) : await this.load(ownerId);

    // One socket per player. A new tab takes over, standing where the old one stood.
    let pos = hutDoor(hut.tier);
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
      outfit: (await heroInitFor(this.env.DB, id))?.outfit,
    };

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [id, `owner:${ownerId}`]);
    pair[1].serializeAttachment(player);
    this.send(pair[1], {
      type: "snapshot",
      you: id,
      owner: { id: ownerId, name: decodeURIComponent(request.headers.get("x-hut-owner-name") ?? "Someone") },
      tier: hut.tier,
      canEdit,
      players: this.players(),
      furnishings: hut.furnishings,
    });
    this.broadcast({ type: "joined", player }, pair[1]);
    if (canEdit) await this.sendChest(ownerId);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > 2000) return;
    const player = ws.deserializeAttachment() as HarborPlayer | null;
    const ownerId = this.ownerId(ws);
    if (!player || !ownerId) return;
    let msg: HutClientMessage;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    if (msg.type === "say") {
      const text = String(msg.text ?? "").replace(/\s+/g, " ").trim().slice(0, HARBOR_MAX_SAY);
      if (text) this.broadcast({ type: "said", id: player.id, name: player.name, text });
      return;
    }
    if (msg.type === "take") {
      // Only here, on the owner's own socket in their own hut, can anything come out of storage.
      if (player.id !== ownerId) return this.send(ws, { type: "refused", reason: "Only the owner can open the storage chest." });
      const error = await takeStoredItem(this.env.DB, ownerId, Number(msg.id));
      if (error) this.send(ws, { type: "refused", reason: error });
      await this.sendChest(ownerId);
      return;
    }

    const hut = await this.load(ownerId);

    if (msg.type === "move") {
      const to = { q: Number(msg.to?.q), r: Number(msg.to?.r) };
      if (!Number.isInteger(to.q) || !Number.isInteger(to.r)) return;
      const path = hutPath(hut.room, hut.furnishings, player.pos, to);
      if (!path) return;
      ws.serializeAttachment({ ...player, pos: path[path.length - 1] } satisfies HarborPlayer);
      this.broadcast({ type: "moved", id: player.id, path });
      return;
    }

    if (msg.type !== "place" && msg.type !== "pick_up" && msg.type !== "rotate") return;
    const refuse = (reason: string) => this.send(ws, { type: "refused", reason });
    if (player.id !== ownerId) return refuse("Only the owner can move the furniture.");
    const piece = hut.furnishings.find((f) => f.id === Number(msg.id));
    if (!piece) return refuse("You do not own that.");

    let next: Pick<Furnishing, "q" | "r" | "facing">;
    if (msg.type === "place") {
      const to = { q: Number(msg.to?.q), r: Number(msg.to?.r) };
      const facing = msg.facing === undefined ? piece.facing : msg.facing;
      if (!validFacing(facing)) return refuse("It cannot face that way.");
      const problem = placeProblem(hut.room, hut.furnishings.filter((f) => f !== piece), piece.defId, to);
      if (problem) return refuse(problem);
      if (this.players().some((p) => p.pos.q === to.q && p.pos.r === to.r)) return refuse("Someone is standing there.");
      next = { q: to.q, r: to.r, facing };
    } else if (msg.type === "pick_up") {
      if (piece.q === null) return;
      next = { q: null, r: null, facing: piece.facing };
    } else {
      if (piece.q === null) return refuse("Put it down before turning it.");
      const facing = msg.facing === undefined ? (piece.facing + 1) % 6 : msg.facing;
      if (!validFacing(facing)) return refuse("It cannot face that way.");
      next = { q: piece.q, r: piece.r, facing };
    }

    // The copy in memory changes at once, so a request arriving while D1 is
    // being written is checked against the new layout. Nobody is told until
    // the write has landed; if it fails the change is undone.
    const before = { q: piece.q, r: piece.r, facing: piece.facing };
    Object.assign(piece, next);
    try {
      await this.env.DB.prepare("UPDATE furnishings SET q = ?, r = ?, facing = ? WHERE id = ? AND player_id = ?")
        .bind(next.q, next.r, next.facing, piece.id, ownerId)
        .run();
    } catch (err) {
      Object.assign(piece, before);
      console.warn("hut:save-failed", { err: err instanceof Error ? err.message : String(err) });
      return refuse("That could not be saved. Try again.");
    }
    this.broadcast({ type: "furnishings", tier: hut.tier, furnishings: hut.furnishings });
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
