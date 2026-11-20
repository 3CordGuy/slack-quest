// HarborRoom: one Durable Object per crew, holding that crew's shared,
// walkable Harbor.
//
// It is a relay, not a simulation. Players walk freely; the object checks
// each requested path against the fixed Harbor map and tells everyone
// present. There is no tick loop. Who is here and where they stand lives in
// each socket's attachment, so it survives hibernation without touching D1.
// Crew membership and the crew's board are read from D1, which stays
// the system of record. The relay itself (who is here, walking, looking,
// chat, leaving) is the one the huts and the pub use too: walk-room.ts.
//
// The one thing it keeps of its own is the crew's muster (packages/world/
// src/muster.ts): someone setting out for a place on the atlas, and who of
// those in town is coming. That is in the object's storage, with an alarm
// for when its time runs out, so it outlives a hibernation too; when it
// starts, the map is made here, for as many as said they were ready.

import { DurableObject } from "cloudflare:workers";
import {
  HARBOR_PLOTS,
  HARBOR_PUB,
  HARBOR_SPAWN,
  generateHarbor,
  fishSpotAt,
  waterSpotAt,
  harborPath,
  type HarborClientMessage,
  type HarborPlayer,
  type HarborServerMessage,
  type Vessel,
  MUSTER_ANSWERS,
  MUSTER_LINGER_MS,
  answerMuster,
  callMuster,
  musterDue,
  musterOpen,
  musterShown,
  type Muster,
  type MusterAnswer,
  type MusterMember, } from "@gantt-quest/world";
import type { HexPos } from "@gantt-quest/core";
import { getCrew, harborBoard, heroInitFor, type Env } from "./db";
import { gildedRod, ownedVessel } from "./fishmarket";
import { clearPresence } from "./zones";
import { openNode } from "./atlas";
import { Walkers, hexAsked, tellTrades, walkerFrom, withHero } from "./walk-room";

/** A muster as it is kept: with the crew it is for and the lodestone set into the place, neither of which is sent to anyone. */
interface KeptMuster {
  crewId: string;
  stone?: unknown;
  muster: Muster;
  /** Its map is being made right now: it takes no more answers, and nothing starts it a second time. */
  starting?: boolean;
}

const MAP = generateHarbor();

/** A hex asked for as "q,r", if a hero could have walked (or, with this boat, rowed) there from where heroes arrive. */
function standingAt(at: string | null, vessel: Vessel | null): HexPos | undefined {
  const m = at?.match(/^(-?\d{1,3}),(-?\d{1,3})$/);
  if (!m) return undefined;
  const pos = { q: Number(m[1]), r: Number(m[2]) };
  return harborPath(MAP, HARBOR_SPAWN, pos, vessel) ? pos : undefined;
}

export class HarborRoom extends DurableObject<Env> {
  /** Who is here: presence, walking and chat. */
  private here: Walkers<HarborServerMessage>;
  /** The muster whose map is being made this moment (its id): set before anything is waited on, so nothing in this room starts it twice. */
  private startingMuster: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.here = new Walkers(ctx);
  }

  async fetch(request: Request): Promise<Response> {
    const crewId = request.headers.get("x-crew-id");
    if (!crewId) return new Response("missing crew", { status: 400 });
    const { pathname, searchParams } = new URL(request.url);

    // Something the board shows changed (a member, a hut, a project, a map opened): re-read it.
    if (pathname === "/refresh") {
      if (this.ctx.getWebSockets().length > 0) {
        this.here.broadcast({ type: "board", ...(await harborBoard(this.env.DB, crewId)) });
      }
      return new Response("ok");
    }

    // A trade changed: tell the player it concerns to look again, if they are here. Nobody else hears of it.
    if (pathname === "/trades") return tellTrades(this.ctx, searchParams.getAll("to"));

    // Who is walking the Harbor right now: the crewmates who would go down into the caves together.
    if (pathname === "/present") {
      return Response.json({ ids: this.here.players().map((p) => p.id) });
    }

    // The crew's muster: how it stands; one called; an answer to it. (The worker has checked who is asking.)
    if (pathname === "/muster") return Response.json({ muster: await this.musterNow() });
    if (pathname === "/muster/call") {
      const body = (await request.json().catch(() => null)) as { by?: MusterMember; to?: { node: string; place: string; site?: string; level?: number }; stone?: unknown } | null;
      if (!body?.by?.id || !body.to?.node) return Response.json({ error: "Nothing to muster for." }, { status: 400 });
      const kept = await this.ctx.storage.get<KeptMuster>("muster");
      if (kept && musterOpen(kept.muster)) {
        return Response.json({ error: kept.muster.by.id === body.by.id ? "You are mustering already." : `${kept.muster.by.name} is mustering for ${kept.muster.place}: answer that first.` }, { status: 409 });
      }
      // Nobody else in town: there is nobody to ask, and the worker makes the map at once.
      const asked = this.here.players().filter((p) => p.id !== body.by!.id).map((p) => ({ id: p.id, name: p.name }));
      if (asked.length === 0) return Response.json({ alone: true });
      const muster = callMuster(crypto.randomUUID().slice(0, 8), { id: body.by.id, name: body.by.name }, body.to, asked, Date.now());
      await this.ctx.storage.put("muster", { crewId, stone: body.stone, muster } satisfies KeptMuster);
      await this.ctx.storage.setAlarm(muster.deadline);
      this.here.broadcast({ type: "muster", muster });
      return Response.json({ muster });
    }
    if (pathname === "/muster/answer") {
      const body = (await request.json().catch(() => null)) as { who?: MusterMember; answer?: MusterAnswer } | null;
      const kept = await this.ctx.storage.get<KeptMuster>("muster");
      if (!body?.who?.id || !body.answer || !MUSTER_ANSWERS.includes(body.answer)) return Response.json({ error: "That is no answer." }, { status: 400 });
      if (!kept || !musterOpen(kept.muster)) return Response.json({ error: "There is no muster to answer." }, { status: 409 });
      if (kept.starting || this.startingMuster === kept.muster.id) return Response.json({ error: "They are setting out this moment." }, { status: 409 });
      const res = answerMuster(kept.muster, { id: body.who.id, name: body.who.name }, body.answer, Date.now());
      if ("error" in res) return Response.json({ error: res.error }, { status: 409 });
      if (res.cancel) return Response.json({ muster: await this.endMuster({ ...kept, muster: { ...res.muster, failed: `${res.muster.by.name} called it off.` } }) });
      if (res.start) return Response.json({ muster: await this.startMuster({ ...kept, muster: res.muster }) });
      await this.ctx.storage.put("muster", { ...kept, muster: res.muster } satisfies KeptMuster);
      this.here.broadcast({ type: "muster", muster: res.muster });
      return Response.json({ muster: res.muster });
    }

    // A hero earned XP: show it over their head, if they are here.
    if (pathname === "/xp") return this.here.xpPosted(request);

    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const id = request.headers.get("x-player-id");
    if (!id) return new Response("missing player or crew", { status: 400 });
    // The crew, and what everyone will see of this hero (their boat, their look, a gilded rod). The four readings
    // do not wait on one another, so they are asked for together.
    const db = this.env.DB;
    const [crew, vessel, hero, gilded] = await Promise.all([getCrew(db, crewId), ownedVessel(db, id), heroInitFor(db, id), gildedRod(db, id)]);
    if (!crew) return new Response("missing player or crew", { status: 400 });

    // One socket per player. A new tab takes over, standing where the old one stood.
    // Someone stepping out of a hut or the pub arrives at its door.
    // Someone back from being away (their socket was closed while idle) asks to stand where they stood.
    const at = searchParams.get("at");
    const asked = (at === "pub" ? HARBOR_PUB : at !== null && /^\d{1,2}$/.test(at) ? HARBOR_PLOTS[Number(at)] : standingAt(at, vessel)) ?? HARBOR_SPAWN;
    const pos = this.here.takeOver(id, asked);
    const player: HarborPlayer = { ...walkerFrom(request, id, hero, pos), vessel, gilded };

    // The muster as it stands, looked up before this socket is in the room: if looking drops one that has lapsed,
    // the room is told so once, and this socket once below.
    const muster = await this.musterNow();
    const pair = new WebSocketPair();
    this.here.admit(pair[1], player);

    // Here, so not out on a zone: whatever a room that went away without saying so left written down is cleared.
    await clearPresence(this.env.DB, id);
    const board = await harborBoard(this.env.DB, crewId);
    pair[1].send(JSON.stringify({ type: "snapshot", you: id, crew, players: this.here.players(), ...board } satisfies HarborServerMessage));
    // Someone is mustering: one who walks in while it is on is asked too. (And one who walks back in after it is
    // over is told there is none, so nothing they last heard is left showing.)
    pair[1].send(JSON.stringify({ type: "muster", muster } satisfies HarborServerMessage));
    this.here.broadcast({ type: "joined", player }, pair[1]);
    // Their arrival may also be news for the roster (a brand-new member).
    this.here.broadcast({ type: "board", ...board }, pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // ---------- the muster ----------

  /** The muster worth telling anyone about: one waiting for answers, or one that ended a moment ago. */
  private async musterNow(): Promise<Muster | null> {
    const kept = await this.ctx.storage.get<KeptMuster>("muster");
    if (!kept) return null;
    if (musterShown(kept.muster, Date.now())) return kept.muster;
    await this.dropMuster();
    return null;
  }

  /** It has been told long enough: forgotten, and the room is told there is none. */
  private async dropMuster(): Promise<void> {
    await this.ctx.storage.delete("muster");
    this.here.broadcast({ type: "muster", muster: null });
  }

  /** Someone a muster was waiting on has left town without answering: it stops waiting for them, and starts if they were the last. */
  private async musterLeft(id: string): Promise<void> {
    const kept = await this.ctx.storage.get<KeptMuster>("muster");
    if (!kept || kept.starting || this.startingMuster === kept.muster.id || !musterOpen(kept.muster)) return;
    const { muster } = kept;
    if (!muster.asked.some((a) => a.id === id) || muster.ready.some((r) => r.id === id) || muster.declined.includes(id)) return;
    const next: KeptMuster = { ...kept, muster: { ...muster, asked: muster.asked.filter((a) => a.id !== id) } };
    if (musterDue(next.muster, Date.now())) return void (await this.startMuster(next));
    await this.ctx.storage.put("muster", next);
    this.here.broadcast({ type: "muster", muster: next.muster });
  }

  /** It is over, one way or the other: kept a little while so everyone hears how it ended, and told to the room. */
  private async endMuster(kept: KeptMuster): Promise<Muster> {
    const muster: Muster = { ...kept.muster, endedAt: Date.now() };
    await this.ctx.storage.put("muster", { crewId: kept.crewId, muster } satisfies KeptMuster);
    await this.ctx.storage.setAlarm(Date.now() + MUSTER_LINGER_MS);
    this.here.broadcast({ type: "muster", muster });
    return muster;
  }

  /** They set out: the map is made for as many as are ready, with the caller's lodestone, and everyone is told its code. */
  private async startMuster(kept: KeptMuster): Promise<Muster> {
    // Making the map waits on the database, and the room hears other things meanwhile (an answer, the alarm, the
    // caller's "start"): it is marked as starting first, in the room's own storage, so none of them starts it again.
    if (this.startingMuster === kept.muster.id) return kept.muster;
    this.startingMuster = kept.muster.id;
    const now = await this.ctx.storage.get<KeptMuster>("muster");
    if (now && now.muster.id === kept.muster.id && (now.starting || !musterOpen(now.muster))) return now.muster;
    await this.ctx.storage.put("muster", { ...kept, starting: true } satisfies KeptMuster);
    const { muster } = kept;
    const went = await openNode(this.env.DB, kept.crewId, muster.by.id, muster.node, muster.ready.length, kept.stone).catch((err: unknown) => ({ error: err instanceof Error ? err.message : "The map could not be made.", status: 409 as const }));
    const ended = await this.endMuster({ ...kept, muster: "error" in went ? { ...muster, failed: went.error } : { ...muster, code: went.code } });
    // The chart has changed: the board says so.
    if (!("error" in went) && this.ctx.getWebSockets().length > 0) this.here.broadcast({ type: "board", ...(await harborBoard(this.env.DB, kept.crewId)) });
    return ended;
  }

  /** The muster's time is up (it starts with whoever is ready), or one that ended has been told long enough. */
  async alarm(): Promise<void> {
    const kept = await this.ctx.storage.get<KeptMuster>("muster");
    if (!kept) return;
    const now = Date.now();
    if (kept.starting) return;
    if (musterOpen(kept.muster)) {
      if (musterDue(kept.muster, now)) await this.startMuster(kept);
      else await this.ctx.storage.setAlarm(kept.muster.deadline);
    } else if (!musterShown(kept.muster, now)) await this.dropMuster();
    else await this.ctx.storage.setAlarm((kept.muster.endedAt ?? now) + MUSTER_LINGER_MS);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const heard = this.here.read<HarborClientMessage>(ws, message);
    if (!heard) return;
    const { player, msg } = heard;

    if (msg.type === "move") {
      const to = hexAsked(msg.to);
      if (!to) return;
      // With a boat, out onto the water: a barrel along the coast, a rowboat anywhere.
      const path = harborPath(MAP, player.pos, to, player.vessel ?? null);
      if (!path) {
        // No way there. A client shows its own walks at the click and counts the answers (client/useHarbor.ts), so
        // it is told this one was not made, and where its hero really stands. Nobody else saw anything, so nobody else is told.
        ws.send(JSON.stringify({ type: "stayed", id: player.id, pos: player.pos } satisfies HarborServerMessage));
        return;
      }
      // Walking off rolls the bedroll back up, and puts the rod away.
      this.here.walk(ws, player, path, { bedroll: undefined, fishing: undefined });
    } else if (msg.type === "refresh") {
      // They changed gear or levelled: re-read the character and show everyone the new look. The three
      // readings do not wait on one another, so they are asked for together.
      const [hero, vessel, gilded] = await Promise.all([heroInitFor(this.env.DB, player.id), ownedVessel(this.env.DB, player.id), gildedRod(this.env.DB, player.id)]);
      if (hero) this.here.show(ws, { ...withHero(player, hero), vessel, gilded });
    } else if (msg.type === "bedroll") {
      // Purely for show: the rest itself is decided by the server over HTTP. Not on a place, a street corner is fine.
      if (MAP.pois.some((p) => p.pos.q === player.pos.q && p.pos.r === player.pos.r)) return;
      this.here.show(ws, { ...player, bedroll: player.pos });
    } else if (msg.type === "fishing") {
      // Purely for show, like the bedroll: the sitting itself is the server's over HTTP. Only at a fishing spot.
      const on = msg.on === true && (fishSpotAt(player.pos) !== null || waterSpotAt(MAP, player.pos) !== null);
      if (!!player.fishing === on) return;
      this.here.show(ws, { ...player, fishing: on || undefined });
    } else if (msg.type === "look") {
      this.here.look(ws, player, msg.look);
    } else if (msg.type === "unstick") {
      // Back where heroes arrive, with the bedroll rolled up.
      this.here.unstick(ws, player, HARBOR_SPAWN, { bedroll: undefined });
    } else if (msg.type === "say") {
      this.here.say(player, msg.text);
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    const player = this.here.closed(ws, code);
    // Nobody waits for an answer from someone who has walked out of town. (They can still say they are coming,
    // from wherever they went: the atlas shows the muster too.)
    if (player && this.ctx.getWebSockets(player.id).every((other) => other === ws)) await this.musterLeft(player.id);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011);
  }
}
