// HarborRoom: one Durable Object per crew, holding that crew's shared,
// walkable Harbor.
//
// It is a relay, not a simulation. Players walk freely; the object checks
// each requested path against the fixed Harbor map and tells everyone
// present. There is no tick loop. Who is here and where they stand lives in
// each socket's attachment, so it survives hibernation without touching D1.
// Crew membership, ships and the voyage log are read from D1, which stays
// the system of record.
//
// The one thing it keeps of its own is the crew's muster (packages/world/
// src/muster.ts): someone setting out for a place on the atlas, and who of
// those in town is coming. That is in the object's storage, with an alarm
// for when its time runs out, so it outlives a hibernation too; when it
// starts, the map is made here, for as many as said they were ready.

import { DurableObject } from "cloudflare:workers";
import { LOOK_MIN_MS, validLook,
  HARBOR_MAX_SAY,
  HARBOR_PIERS,
  HARBOR_PLOTS,
  HARBOR_PUB,
  HARBOR_SPAWN,
  UNSTICK_COOLDOWN_MS,
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
import { readXpPost, relayXp } from "./harbor-xp";
import { clearPresence } from "./zones";
import { openNode } from "./atlas";

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
  /** When each player last asked to be put back at the spawn. In memory only: a light limit, and a hibernation resets it. */
  private unstuckAt = new Map<string, number>();
  /** When each player's look was last passed on, so a waving pointer cannot flood the room. */
  private lookedAt = new Map<string, number>();
  /** The muster whose map is being made this moment (its id): set before anything is waited on, so nothing in this room starts it twice. */
  private startingMuster: string | null = null;

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

    // A trade changed: tell the player it concerns to look again, if they are here. Nobody else hears of it.
    if (new URL(request.url).pathname === "/trades") {
      for (const to of new URL(request.url).searchParams.getAll("to")) {
        for (const ws of this.ctx.getWebSockets(to)) {
          try {
            ws.send(JSON.stringify({ type: "trades" } satisfies HarborServerMessage));
          } catch {
            // Socket is closing; webSocketClose will follow.
          }
        }
      }
      return new Response("ok");
    }

    // Who is walking the Harbor right now: the crewmates who would go down into the caves together.
    if (new URL(request.url).pathname === "/present") {
      return Response.json({ ids: this.players().map((p) => p.id) });
    }

    // The crew's muster: how it stands; one called; an answer to it. (The worker has checked who is asking.)
    if (new URL(request.url).pathname === "/muster") return Response.json({ muster: await this.musterNow() });
    if (new URL(request.url).pathname === "/muster/call") {
      const body = (await request.json().catch(() => null)) as { by?: MusterMember; to?: { node: string; place: string; site?: string; level?: number }; stone?: unknown } | null;
      if (!body?.by?.id || !body.to?.node) return Response.json({ error: "Nothing to muster for." }, { status: 400 });
      const kept = await this.ctx.storage.get<KeptMuster>("muster");
      if (kept && musterOpen(kept.muster)) {
        return Response.json({ error: kept.muster.by.id === body.by.id ? "You are mustering already." : `${kept.muster.by.name} is mustering for ${kept.muster.place}: answer that first.` }, { status: 409 });
      }
      // Nobody else in town: there is nobody to ask, and the worker makes the map at once.
      const asked = this.players().filter((p) => p.id !== body.by!.id).map((p) => ({ id: p.id, name: p.name }));
      if (asked.length === 0) return Response.json({ alone: true });
      const muster = callMuster(crypto.randomUUID().slice(0, 8), { id: body.by.id, name: body.by.name }, body.to, asked, Date.now());
      await this.ctx.storage.put("muster", { crewId, stone: body.stone, muster } satisfies KeptMuster);
      await this.ctx.storage.setAlarm(muster.deadline);
      this.broadcast({ type: "muster", muster });
      return Response.json({ muster });
    }
    if (new URL(request.url).pathname === "/muster/answer") {
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
      this.broadcast({ type: "muster", muster: res.muster });
      return Response.json({ muster: res.muster });
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
    // Someone back from being away (their socket was closed while idle) asks to stand where they stood.
    const at = new URL(request.url).searchParams.get("at");
    const vessel = await ownedVessel(this.env.DB, id);
    let pos = (at === "pub" ? HARBOR_PUB : at !== null && /^\d{1,2}$/.test(at) ? HARBOR_PLOTS[Number(at)] : standingAt(at, vessel)) ?? HARBOR_SPAWN;
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
      vessel,
      gilded: await gildedRod(this.env.DB, id),
    };

    // The muster as it stands, looked up before this socket is in the room: if looking drops one that has lapsed,
    // the room is told so once, and this socket once below.
    const muster = await this.musterNow();
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [id]);
    pair[1].serializeAttachment(player);

    // Here, so not out on a zone: whatever a room that went away without saying so left written down is cleared.
    await clearPresence(this.env.DB, id);
    const board = await harborBoard(this.env.DB, crewId, HARBOR_PIERS.length);
    pair[1].send(JSON.stringify({ type: "snapshot", you: id, crew, players: this.players(), ...board } satisfies HarborServerMessage));
    // Someone is mustering: one who walks in while it is on is asked too. (And one who walks back in after it is
    // over is told there is none, so nothing they last heard is left showing.)
    pair[1].send(JSON.stringify({ type: "muster", muster } satisfies HarborServerMessage));
    this.broadcast({ type: "joined", player }, pair[1]);
    // Their arrival may also be news for the roster (a brand-new member).
    this.broadcast({ type: "board", ...board }, pair[1]);
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
    this.broadcast({ type: "muster", muster: null });
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
    this.broadcast({ type: "muster", muster: next.muster });
  }

  /** It is over, one way or the other: kept a little while so everyone hears how it ended, and told to the room. */
  private async endMuster(kept: KeptMuster): Promise<Muster> {
    const muster: Muster = { ...kept.muster, endedAt: Date.now() };
    await this.ctx.storage.put("muster", { crewId: kept.crewId, muster } satisfies KeptMuster);
    await this.ctx.storage.setAlarm(Date.now() + MUSTER_LINGER_MS);
    this.broadcast({ type: "muster", muster });
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
    if (!("error" in went) && this.ctx.getWebSockets().length > 0) this.broadcast({ type: "board", ...(await harborBoard(this.env.DB, kept.crewId, HARBOR_PIERS.length)) });
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
      // With a boat, out onto the water: a barrel along the coast, a rowboat anywhere.
      const path = harborPath(MAP, player.pos, to, player.vessel ?? null);
      if (!path) {
        // No way there. A client shows its own walks at the click and counts the answers (client/useHarbor.ts), so
        // it is told this one was not made, and where its hero really stands. Nobody else saw anything, so nobody else is told.
        ws.send(JSON.stringify({ type: "stayed", id: player.id, pos: player.pos } satisfies HarborServerMessage));
        return;
      }
      // Walking off rolls the bedroll back up.
      ws.serializeAttachment({ ...player, pos: path[path.length - 1], bedroll: undefined, fishing: undefined } satisfies HarborPlayer);
      this.broadcast({ type: "moved", id: player.id, path });
    } else if (msg.type === "refresh") {
      // They changed gear or levelled: re-read the character and show everyone the new look. The three
      // readings do not wait on one another, so they are asked for together.
      const [hero, vessel, gilded] = await Promise.all([heroInitFor(this.env.DB, player.id), ownedVessel(this.env.DB, player.id), gildedRod(this.env.DB, player.id)]);
      if (!hero) return;
      const next: HarborPlayer = { ...player, name: hero.name, classId: hero.classId, level: hero.level, xp: hero.xp, outfit: hero.outfit, vessel, gilded };
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
      const on = msg.on === true && (fishSpotAt(player.pos) !== null || waterSpotAt(MAP, player.pos) !== null);
      if (!!player.fishing === on) return;
      const next: HarborPlayer = { ...player, fishing: on || undefined };
      ws.serializeAttachment(next);
      this.broadcast({ type: "joined", player: next });
    } else if (msg.type === "look") {
      // Which way they are looking: passed on to everyone else here, and not kept.
      const look = validLook(msg.look);
      const now = Date.now();
      if (look === null || now - (this.lookedAt.get(player.id) ?? -Infinity) < LOOK_MIN_MS) return;
      this.lookedAt.set(player.id, now);
      this.broadcast({ type: "looked", id: player.id, look }, ws);
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
    // Nobody waits for an answer from someone who has walked out of town. (They can still say they are coming,
    // from wherever they went: the atlas shows the muster too.)
    if (player && this.ctx.getWebSockets(player.id).every((other) => other === ws)) await this.musterLeft(player.id);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011);
  }
}
