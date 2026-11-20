// HutRoom: one Durable Object per hut (named by its owner's player id), for
// the walk-in room where the owner and visiting crewmates see each other and
// the furniture.
//
// Presence, walking and chat work as they do in HarborRoom (walk-room.ts): a
// relay with no tick loop and no alarm, with who is here kept in each
// socket's attachment so it survives hibernation. The hut's tier and
// furniture live in D1; this object keeps a copy in memory that it reloads
// after hibernating. Only the owner may move furniture, and every change is
// written to D1 before anyone is told about it.

import { DurableObject } from "cloudflare:workers";
import {
  FURNISHINGS,
  HOME_FREEBIES,
  coveredHexes,
  freeSpot,
  placedFurnishings,
  hutDoor,
  hutPath,
  hutRoom,
  isFlat,
  isMounted,
  isSmall,
  lieDownProblem,
  placeProblem,
  putInProblem,
  smallPlaceProblem,
  turnOf,
  validFacing,
  wallPlaceProblem,
  wrapAngle,
  type Furnishing,
  type HutClientMessage,
  type HutServerMessage,
  type Placed,
  type WorldMap, } from "@gantt-quest/world";
import { containerUsed, crewFor, furnishingStatement, getCharacter, getHut, hasShack, heroInitFor, homeOf, type Env, type Player } from "./db";
import { Walkers, hexAsked, walkerFrom, withHero } from "./walk-room";

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
  /** Who is here: presence, walking and chat. */
  private here: Walkers<HutServerMessage>;
  /** Cached copy of the hut. Gone after hibernation; D1 has the truth. */
  private hut: Hut | null = null;
  private loading: Promise<Hut> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.here = new Walkers(ctx);
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
   * start with. Every home also comes with a free storage chest and a free
   * wardrobe (HOME_FREEBIES), standing in the room; a hut built before one
   * existed gets it on the owner's next visit. Each insert checks for its
   * piece itself, so two tabs at once cannot both add one.
   */
  private async stock(ownerId: string): Promise<Hut> {
    const hut = await this.load(ownerId, true);
    const statements: D1PreparedStatement[] = [];
    if (hut.furnishings.length === 0) {
      statements.push(...STARTER_SET.map((defId) => furnishingStatement(this.env.DB, ownerId, { defId, label: FURNISHINGS[defId].name })));
    }
    // Each free piece takes the next free spot, clear of the ones set down before it.
    const placed: Placed[] = placedFurnishings(hut.furnishings);
    for (const defId of HOME_FREEBIES) {
      if (hut.furnishings.some((f) => f.defId === defId)) continue;
      const spot = freeSpot(hut.room, placed, defId, hutDoor(hut.tier));
      if (spot) placed.push({ ...spot, defId });
      statements.push(
        this.env.DB
          .prepare(
            `INSERT INTO furnishings (player_id, def_id, label, meta_json, q, r, facing, created_at)
             SELECT ?1, ?2, ?3, '{}', ?4, ?5, 0, ?6 WHERE NOT EXISTS (SELECT 1 FROM furnishings WHERE player_id = ?1 AND def_id = ?2)`,
          )
          .bind(ownerId, defId, FURNISHINGS[defId].name, spot?.q ?? null, spot?.r ?? null, Date.now()),
      );
    }
    if (statements.length === 0) return hut;
    await this.env.DB.batch(statements);
    return this.load(ownerId, true);
  }

  /** The owner's id is the tag every socket in this room carries besides its player's. */
  private ownerId(ws: WebSocket): string | null {
    return this.ctx.getTags(ws).find((t) => t.startsWith("owner:"))?.slice(6) ?? null;
  }

  async fetch(request: Request): Promise<Response> {
    const ownerId = request.headers.get("x-hut-owner");
    if (!ownerId) return new Response("missing hut", { status: 400 });
    const { pathname } = new URL(request.url);

    // Is this player standing in this hut right now? Asked before gear comes out of a container:
    // what is kept at home can only be taken out at home.
    if (pathname === "/present") {
      const who = request.headers.get("x-player-id");
      return new Response(who && this.ctx.getWebSockets(who).length > 0 ? "yes" : "no");
    }

    // A hero earned XP: show it over their head, if they are here.
    if (pathname === "/xp") return this.here.xpPosted(request);

    // The hut changed from outside this room (a new furnishing, a bigger hut): re-read it.
    if (pathname === "/refresh") {
      if (this.ctx.getWebSockets().length > 0) {
        const hut = await this.load(ownerId, true);
        this.here.broadcast({ type: "furnishings", tier: hut.tier, furnishings: hut.furnishings });
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

    // One socket per player. A new tab takes over, standing where the old one stood; anyone else arrives in the door.
    const pos = this.here.takeOver(id, hutDoor(hut.tier));
    const player = walkerFrom(request, id, await heroInitFor(this.env.DB, id), pos);

    const pair = new WebSocketPair();
    this.here.admit(pair[1], player, `owner:${ownerId}`);
    this.here.send(pair[1], {
      type: "snapshot",
      you: id,
      owner: { id: ownerId, name: decodeURIComponent(request.headers.get("x-hut-owner-name") ?? "Someone") },
      tier: hut.tier,
      canEdit,
      players: this.here.players(),
      furnishings: hut.furnishings,
    });
    this.here.broadcast({ type: "joined", player }, pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const heard = this.here.read<HutClientMessage>(ws, message);
    const ownerId = this.ownerId(ws);
    if (!heard || !ownerId) return;
    const { player, msg } = heard;

    if (msg.type === "say") return this.here.say(player, msg.text);
    const hut = await this.load(ownerId);

    if (msg.type === "move") {
      const to = hexAsked(msg.to);
      if (!to) return;
      // A walk may end on a stool, to sit on it, unless someone else already is.
      const path = hutPath(hut.room, hut.furnishings, player.pos, to, undefined, this.here.othersAt(player.id));
      if (!path) return;
      // Walking off gets them up out of bed, which everyone is shown.
      const up = this.here.walk(ws, player, path, { bed: undefined });
      if (player.bed !== undefined) this.here.broadcast({ type: "joined", player: up });
      return;
    }

    if (msg.type === "lie_down") {
      // Purely for show, like a bedroll in the Harbor: the rest itself is `/api/rest`, which checks the cooldown.
      const problem = lieDownProblem(hut.room, hut.furnishings, Number(msg.id), player.pos, player.id === ownerId);
      if (problem) return this.here.send(ws, { type: "refused", reason: problem });
      return this.here.show(ws, { ...player, bed: Number(msg.id) });
    }

    if (msg.type === "look") return this.here.look(ws, player, msg.look);

    if (msg.type === "refresh") {
      // They saved a new look (from the wardrobe or their sheet) or changed gear: re-read the hero and show everyone.
      const hero = await heroInitFor(this.env.DB, player.id);
      if (hero) this.here.show(ws, withHero(player, hero));
      return;
    }

    if (msg.type === "unstick") {
      // Back to the door.
      this.here.unstick(ws, player, hutDoor(hut.tier));
      return;
    }

    if (msg.type !== "place" && msg.type !== "pick_up" && msg.type !== "rotate" && msg.type !== "put_in") return;
    const refuse = (reason: string) => this.here.send(ws, { type: "refused", reason });
    if (player.id !== ownerId) return refuse("Only the owner can move the furniture.");
    const piece = hut.furnishings.find((f) => f.id === Number(msg.id));
    if (!piece) return refuse("You do not own that.");
    const small = isSmall(piece.defId);
    const mounted = isMounted(piece.defId);
    const others = hut.furnishings.filter((f) => f !== piece);
    /** Small things standing on this piece. They ride along when it moves and go back to storage with it. */
    const riders = others.filter((f) => f.onId === piece.id);
    /** Everything but this piece and what rides on it: what it must keep clear of. */
    const rest = others.filter((f) => f.onId !== piece.id);
    /** Why a floor piece cannot stand at this spot: the room's rules, then anyone standing where it would go. */
    const floorProblem = (to: { q: number; r: number }, spot: { x: number; z: number; angle: number }, turningInPlace = false) => {
      const problem = placeProblem(hut.room, rest, piece.defId, to, spot);
      if (problem) return problem;
      // A rug goes down under people's feet. Turning a piece where it stands never pushes out someone standing on its own hex.
      if (isFlat(piece.defId)) return null;
      const covered = coveredHexes(piece.defId, to, spot).filter((h) => !turningInPlace || h.q !== to.q || h.r !== to.r);
      return this.here.players().some((p) => covered.some((h) => h.q === p.pos.q && h.r === p.pos.r)) ? "Someone is standing there." : null;
    };

    type Spot = Pick<Furnishing, "q" | "r" | "facing" | "x" | "z" | "y" | "angle" | "onId" | "inId">;
    const stored: Spot = { q: null, r: null, facing: piece.facing, x: 0, z: 0, y: 0, angle: piece.angle, onId: null, inId: null };
    let next: Spot;
    /** Where the riders end up: with the piece on its new hex, or back in storage. */
    let ridersTo: "follow" | "storage" | "stay" = "stay";
    const num = (v: unknown, fallback: number) => (v === undefined ? fallback : Number(v));

    if (msg.type === "place") {
      const to = { q: Number(msg.to?.q), r: Number(msg.to?.r) };
      if (mounted) {
        const spot = { pos: to, side: Number(msg.facing), x: num(msg.x, 0), y: num(msg.y, 0) };
        const problem = wallPlaceProblem(hut.room, rest, piece.defId, spot);
        if (problem) return refuse(problem);
        next = { q: to.q, r: to.r, facing: spot.side, x: spot.x, z: 0, y: spot.y, angle: 0, onId: null, inId: null };
        ridersTo = "follow";
      } else if (small) {
        const angle = num(msg.angle, piece.angle);
        const x = num(msg.x, 0);
        const z = num(msg.z, 0);
        if (msg.on !== undefined) {
          const on = Number(msg.on);
          const problem = smallPlaceProblem(hut.room, others, piece.defId, { on, x, z, angle });
          if (problem) return refuse(problem);
          const base = others.find((f) => f.id === on)!;
          next = { q: base.q, r: base.r, facing: 0, x, z, y: 0, angle: wrapAngle(angle), onId: on, inId: null };
        } else {
          const problem = smallPlaceProblem(hut.room, others, piece.defId, { pos: to, x, z, angle });
          if (problem) return refuse(problem);
          next = { q: to.q, r: to.r, facing: 0, x, z, y: 0, angle: wrapAngle(angle), onId: null, inId: null };
        }
      } else {
        // A whole turn in `angle`; a facing in sixths from an older client; or else the way it faced before.
        if (msg.facing !== undefined && !validFacing(msg.facing)) return refuse("It cannot face that way.");
        const angle = msg.angle !== undefined ? Number(msg.angle) : msg.facing !== undefined ? turnOf({ facing: msg.facing }) : turnOf(piece);
        const spot = { x: num(msg.x, 0), z: num(msg.z, 0), angle };
        // Its own riders move with it, so they do not count as in the way.
        const problem = floorProblem(to, spot);
        if (problem) return refuse(problem);
        next = { q: to.q, r: to.r, facing: 0, x: spot.x, z: spot.z, y: 0, angle: wrapAngle(angle), onId: null, inId: null };
        ridersTo = "follow";
      }
    } else if (msg.type === "pick_up") {
      if (piece.q === null && piece.inId === null) return;
      next = stored;
      ridersTo = "storage";
    } else if (msg.type === "put_in") {
      const into = others.find((f) => f.id === Number(msg.into));
      const used = into ? await containerUsed(this.env.DB, ownerId, into.id) : 0;
      const problem = putInProblem(piece, into, used);
      if (problem) return refuse(problem);
      next = { ...stored, inId: into!.id };
      ridersTo = "storage";
    } else {
      if (piece.q === null || piece.r === null) return refuse("Put it down before turning it.");
      if (mounted) return refuse("It hangs flat on the wall.");
      if (msg.facing !== undefined && !validFacing(msg.facing)) return refuse("It cannot face that way.");
      const step = small ? Math.PI / 12 : Math.PI / 3;
      const angle = msg.angle !== undefined ? Number(msg.angle) : msg.facing !== undefined ? turnOf({ facing: msg.facing }) : turnOf(piece) + step;
      if (!Number.isFinite(angle)) return refuse("It cannot face that way.");
      if (!small && piece.onId === null) {
        // A long piece turned where it stands may now poke through a wall or into a neighbour.
        const problem = floorProblem({ q: piece.q, r: piece.r }, { x: piece.x, z: piece.z, angle }, true);
        if (problem) return refuse(problem);
      }
      next = { ...piece, facing: 0, angle: wrapAngle(angle) };
    }

    // The copy in memory changes at once, so a request arriving while D1 is
    // being written is checked against the new layout. Nobody is told until
    // the write has landed; if it fails the change is undone.
    const moved = riders.map((f) => ({ f, before: { ...f } }));
    const before = { ...piece };
    const pick = (f: Furnishing): Spot => ({ q: f.q, r: f.r, facing: f.facing, x: f.x, z: f.z, y: f.y, angle: f.angle, onId: f.onId, inId: f.inId });
    Object.assign(piece, pick({ ...piece, ...next }));
    for (const { f } of moved) {
      if (ridersTo === "follow") Object.assign(f, { q: piece.q, r: piece.r });
      else if (ridersTo === "storage") Object.assign(f, { q: null, r: null, x: 0, z: 0, y: 0, angle: 0, onId: null });
    }
    const save = (f: Furnishing) =>
      this.env.DB.prepare("UPDATE furnishings SET q = ?, r = ?, facing = ?, x = ?, z = ?, y = ?, angle = ?, on_id = ?, in_id = ? WHERE id = ? AND player_id = ?")
        .bind(f.q, f.r, f.facing, f.x, f.z, f.y, f.angle, f.onId, f.inId, f.id, ownerId);
    try {
      await this.env.DB.batch([save(piece), ...(ridersTo === "stay" ? [] : moved.map(({ f }) => save(f)))]);
    } catch (err) {
      Object.assign(piece, before);
      for (const { f, before: b } of moved) Object.assign(f, b);
      console.warn("hut:save-failed", { err: err instanceof Error ? err.message : String(err) });
      return refuse("That could not be saved. Try again.");
    }
    this.here.broadcast({ type: "furnishings", tier: hut.tier, furnishings: hut.furnishings });
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.here.closed(ws, code);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011);
  }
}
