// ZoneRoom: one Durable Object per zone (a map a party walks freely and
// fights on), addressed by the zone's code.
//
// It follows RunRoom's rules:
// - WebSockets use the hibernation API, so an idle room costs nothing.
// - D1 is the system of record. this.zone is only a cache and is reloaded
//   from zones.state_json after hibernation.
// - Every change is persisted before it is broadcast, in as few trips to
//   D1 as the order allows: what a hero used from their pack and the zone
//   itself go in one batch, the pack first.
// - The turn timer is a DO Alarm. Enemy turns resolve inside the reducer, so
//   nothing waits on a connected client to make progress.
// - What a won fight pays (XP and materials) is written before the zone is
//   saved, as the pack is.
//
// What a hero carries to drink or throw is their own pack's (consumables.ts):
// it is read as they walk in and again before each one is used, and what was
// used is taken out of the pack before the zone is saved.
//
// Walking freely needs no clock at all: the reducer walks a hero's whole
// path at once and says where they ended up, as the Harbor does.
//
// A client may show what it did before it hears back (client/zone/ahead.ts),
// so it numbers its actions. The number comes back to that socket alone: on
// the update that carries what the action did, or on the error that refused
// it. That is all the room does for it: the room still decides everything.
//
// The tiles of a map never change, and they are most of what a state weighs,
// so a client that says it keeps them (x-zone-lean) is sent them once per
// socket and not with every update after. That they have been sent is
// written on the socket itself, which outlives the room's hibernation.

import { DurableObject } from "cloudflare:workers";
import { THROWABLE_KINDS, ZONE_CLIENT_ACTIONS, createZone, ensureMouth, stepZone, zoneAwaiting, zoneHero, zoneOptions, zoneView, type ZoneAction, type ZoneEvent, type ZoneState } from "@gantt-quest/world";
import { consumablesOf, gainConsumables, kitStatements, spendConsumables, type Consumables } from "./consumables";
import { applyZoneGrant, crewFor, heroInitFor, refreshHarbor, type Env } from "./db";
import { isDev } from "./dev";
import { clearNode } from "./atlas";
import { clearPresence, getZoneRow, saveZoneStatement, setPresence, zoneStatus } from "./zones";

/** How long a turn in a fight may take before it ends itself. */
export const ZONE_TURN_MS = 90_000;

interface Attachment {
  playerId: string;
  /** This client keeps the map's tiles from the first update it is sent, and needs them only once. */
  lean?: boolean;
  /** This socket has been sent the tiles. */
  tiles?: boolean;
}

/** The action being answered: whose socket asked, and the number they gave it (if they gave one). */
interface Asked {
  ws: WebSocket;
  n?: number;
}

const isHex = (v: unknown): v is { q: number; r: number } => !!v && typeof v === "object" && Number.isInteger((v as { q: unknown }).q) && Number.isInteger((v as { r: unknown }).r);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 64;
const SURFACES = ["poison", "fire", "oil", "water", "ice", "slime"];

/**
 * A client's message as an action, or null if it is not one. Who it is from comes from the socket,
 * never from the message, and anything misshapen is dropped here so the reducer only sees whole actions.
 * Dev actions pass only on a development deployment.
 */
export function zoneActionFrom(raw: unknown, by: string, dev: boolean): ZoneAction | null {
  const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!ZONE_CLIENT_ACTIONS.has(a.type as ZoneAction["type"])) return null;
  const hex = (v: unknown) => (isHex(v) ? { q: v.q, r: v.r } : undefined);
  const target = text(a.target) ? a.target : undefined;
  if (a.type === "dev") {
    const d = (a.dev && typeof a.dev === "object" ? a.dev : {}) as Record<string, unknown>;
    if (!dev) return null;
    if (d.op === "spawn" && Array.isArray(d.kinds) && isHex(d.at)) return { type: "dev", by, dev: { op: "spawn", kinds: d.kinds.filter(text).slice(0, 6), at: hex(d.at)! } };
    if (d.op === "paint" && Array.isArray(d.hexes) && (d.kind === null || SURFACES.includes(d.kind as string))) {
      return { type: "dev", by, dev: { op: "paint", kind: d.kind as never, hexes: d.hexes.filter(isHex).slice(0, 60).map((p) => hex(p)!) } };
    }
    if (d.op === "standin" && text(d.classId)) return { type: "dev", by, dev: { op: "standin", classId: d.classId } };
    if (d.op === "ai") return { type: "dev", by, dev: { op: "ai", off: !!d.off } };
    if (d.op === "heal" || d.op === "end_fight" || d.op === "start_fight" || d.op === "clear_surfaces") return { type: "dev", by, dev: { op: d.op } };
    return null;
  }
  if (!text(a.unit)) return null;
  if (a.type === "move") return isHex(a.to) ? { type: "move", by, unit: a.unit, to: hex(a.to)! } : null;
  if (a.type === "use") return text(a.ability) ? { type: "use", by, unit: a.unit, ability: a.ability, target, at: hex(a.at), focus: !!a.focus } : null;
  if (a.type === "common") return text(a.what) ? { type: "common", by, unit: a.unit, what: a.what as never, target, at: hex(a.at) } : null;
  if (a.type === "throw") return text(a.item) && isHex(a.at) ? { type: "throw", by, unit: a.unit, item: a.item as never, at: hex(a.at)! } : null;
  if (a.type === "drink") return text(a.item) ? { type: "drink", by, unit: a.unit, item: a.item as never } : null;
  if (a.type === "pickup") return isHex(a.at) ? { type: "pickup", by, unit: a.unit, at: hex(a.at)! } : null;
  if (a.type === "open") return text(a.poi) ? { type: "open", by, unit: a.unit, poi: a.poi } : null;
  if (a.type === "unlock") return text(a.poi) ? { type: "unlock", by, unit: a.unit, poi: a.poi } : null;
  if (a.type === "forage") return text(a.poi) ? { type: "forage", by, unit: a.unit, poi: a.poi } : null;
  if (a.type === "light") return { type: "light", by, unit: a.unit, ...(a.hand === "main" ? { hand: "main" as const } : {}) };
  if (a.type === "stow") return { type: "stow", by, unit: a.unit };
  return { type: "end_turn", by, unit: a.unit };
}

/** How many of each kind a hero has fewer of after a step than before it (`sign` 1), or more of (`sign` -1). */
function usedBy(prev: ZoneState, next: ZoneState, id: string, sign: 1 | -1 = 1): Consumables {
  const had = prev.units.find((u) => u.id === id)?.items ?? {};
  const has = next.units.find((u) => u.id === id)?.items ?? {};
  const used: Consumables = {};
  for (const kind of THROWABLE_KINDS) {
    const n = sign * ((had[kind] ?? 0) - (has[kind] ?? 0));
    if (n > 0) used[kind] = n;
  }
  return used;
}

export class ZoneRoom extends DurableObject<Env> {
  private zone: ZoneState | null = null;
  /** On a zone the atlas made: whose chart and which node of it, and whether that node has been marked cleared from here. */
  private landfall: { crewId: string; node: string; told: boolean } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** Whether each player here was last written down as fighting, so presence is only rewritten when it changes. */
  private fighting = new Map<string, boolean>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** Run `fn` after everything queued before it. Keeps actions strictly ordered across awaits. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch((err) => console.error("zone-room:queue-error", err));
    return next;
  }

  private async load(code?: string): Promise<ZoneState> {
    if (this.zone) return this.zone;
    const zoneCode = code ?? (await this.ctx.storage.get<string>("code"));
    if (!zoneCode) throw new Error("zone room has no code");
    const row = await getZoneRow(this.env.DB, zoneCode);
    if (!row) throw new Error(`zone ${zoneCode} not found`);
    // A cave saved before it had a mouth gets one now, so it can be left (ensureMouth).
    this.zone = row.state_json ? ensureMouth(JSON.parse(row.state_json) as ZoneState) : createZone(row.code, row.seed, zoneOptions(JSON.parse(row.options_json)));
    this.landfall = row.kind === "atlas" && row.crew_id && row.node ? { crewId: row.crew_id, node: row.node, told: row.status === "cleared" } : null;
    if (code) await this.ctx.storage.put("code", code);
    return this.zone;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      // A trade changed: tell the player it concerns to look again, if they are here and connected.
      const url = new URL(request.url);
      if (url.pathname !== "/trades") return new Response("expected websocket", { status: 426 });
      for (const to of url.searchParams.getAll("to")) {
        for (const ws of this.ctx.getWebSockets(to)) {
          try {
            ws.send(JSON.stringify({ type: "trades" }));
          } catch {
            // Socket is closing; webSocketClose will follow.
          }
        }
      }
      return new Response("ok");
    }
    const code = request.headers.get("x-zone-code");
    const playerId = request.headers.get("x-player-id");
    const near = request.headers.get("x-zone-near") ?? undefined;
    if (!code || !playerId) return new Response("missing zone or player", { status: 400 });

    const error = await this.serial(async () => {
      await this.load(code);
      // Read afresh each time: the hero may have changed gear since they were last here.
      const hero = await heroInitFor(this.env.DB, playerId);
      if (!hero) return "You need a character first.";
      return this.apply({ type: "join", hero: zoneHero(hero, await consumablesOf(this.env.DB, playerId)), near });
    });
    if (error) return new Response(error, { status: 409 });

    // One socket per player: a new tab takes over from the old one.
    for (const old of this.ctx.getWebSockets(playerId)) old.close(4000, "replaced by a newer connection");
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [playerId]);
    pair[1].serializeAttachment({ playerId, ...(request.headers.get("x-zone-lean") === "1" ? { lean: true } : {}) } satisfies Attachment);

    await this.serial(async () => {
      await this.resumeTimer();
      this.fighting.delete(playerId);
      await this.notePresence();
      this.broadcast([]);
    });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > 8000) return;
    let msg: { type?: string; action?: unknown; n?: unknown };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    const { playerId } = ws.deserializeAttachment() as Attachment;
    if (msg.type === "sheet") {
      // Gear was changed in the bag: the hero is read again. In a fight the reducer leaves them as they were.
      await this.serial(async () => {
        await this.load();
        const hero = await heroInitFor(this.env.DB, playerId);
        if (hero) await this.apply({ type: "join", hero: zoneHero(hero, await consumablesOf(this.env.DB, playerId)) });
      });
      return;
    }
    if (msg.type !== "action") return;
    // The client's own number for this action, sent back with its answer so it can tell which of its actions was answered.
    const n = typeof msg.n === "number" && Number.isSafeInteger(msg.n) && msg.n >= 0 ? msg.n : undefined;
    const action = zoneActionFrom(msg.action, playerId, isDev(this.env));
    if (!action) {
      // Not an action at all. A client waiting on a number is told so; anything else is dropped as before.
      if (n !== undefined) ws.send(JSON.stringify({ type: "error", message: "That could not be done.", ack: n }));
      return;
    }
    // Throwing, drinking, lighting a torch, picking one up or putting one away as your own hero draws on (or adds to) your own pack. (A stand-in has no pack: it carries the kit it was given.)
    const pack = (action.type === "throw" || action.type === "drink" || action.type === "light" || action.type === "pickup" || action.type === "stow") && action.unit === playerId ? playerId : undefined;
    const error = await this.serial(async () => {
      await this.load();
      return this.apply(action, pack, { ws, n });
    });
    if (error) ws.send(JSON.stringify({ type: "error", message: error, ...(n !== undefined ? { ack: n } : {}) }));
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      // Already closed.
    }
    const { playerId } = (ws.deserializeAttachment() as Attachment | null) ?? { playerId: "" };
    await this.serial(async () => {
      const zone = await this.load();
      // Gone from the zone, unless another tab of theirs is still here.
      if (playerId && !this.ctx.getWebSockets(playerId).some((other) => other !== ws)) {
        // Their hero (and any stand-in they play) stays where it is, but nothing draws it into a fight while they are gone.
        if (zone.units.some((u) => u.side === "hero" && (u.id === playerId || u.controller === playerId) && !u.away)) await this.apply({ type: "away", player: playerId, away: true });
        this.fighting.delete(playerId);
        await clearPresence(this.env.DB, playerId, zone.code);
        this.tellHarbor(playerId);
      }
      this.broadcast([]);
    });
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011);
  }

  async alarm(): Promise<void> {
    await this.serial(async () => {
      const zone = await this.load();
      // Nobody here: pause. resumeTimer restarts the clock when someone comes back.
      if (this.ctx.getWebSockets().length === 0) return;
      const deadline = zone.encounter?.deadline ?? null;
      if (deadline && Date.now() < deadline - 500) {
        await this.ctx.storage.setAlarm(deadline);
        return;
      }
      if (zone.encounter) await this.apply({ type: "timeout" });
    });
  }

  /**
   * Step the zone, persist, then broadcast. Returns an error string or null. `pack`: the player whose own
   * hero this draws a potion or flask from; their pack is read first and what was used is taken out of it.
   * `from`: the socket that asked, which is told its own number back on the update (or, by the caller, on the error).
   */
  private async apply(action: ZoneAction, pack?: string, from?: Asked): Promise<string | null> {
    const db = this.env.DB;
    let prev = this.zone!;
    // Time out of a fight has gone by since the last thing done here (zone/clock.ts): it passes first.
    let passed: ZoneEvent[] = [];
    if (action.type !== "time") {
      const timed = stepZone(prev, { type: "time", now: Date.now() });
      if (timed.ok) {
        prev = timed.state;
        passed = timed.events;
      }
    }
    if (pack) {
      // What they carry is what their pack holds now, whatever the map last heard.
      const held = stepZone(prev, { type: "stock", unit: pack, items: await consumablesOf(db, pack) });
      if (held.ok) prev = held.state;
    }
    let res: ReturnType<typeof stepZone>;
    try {
      res = stepZone(prev, action);
    } catch (err) {
      console.error("zone-room:step-failed", { type: action.type, err: err instanceof Error ? err.message : String(err) });
      return "That could not be done.";
    }
    if (!res.ok) {
      // Refused, but the count may have been wrong on screen (the pack held fewer than the map thought): put it right.
      if (prev !== this.zone) {
        this.zone = prev;
        await saveZoneStatement(db, prev).run();
        this.broadcast(passed);
      }
      return res.error;
    }
    const next = res.state;
    if (zoneAwaiting(next) !== zoneAwaiting(prev)) await this.armTimer(next);
    this.zone = next;
    // The pack first: a potion drunk is gone from it even if the room goes away before the zone is saved.
    const writes: D1PreparedStatement[] = [];
    if (pack) writes.push(...spendConsumables(db, pack, usedBy(prev, next, pack)), ...gainConsumables(db, pack, usedBy(prev, next, pack, -1)));
    // The dev toolbox's restock is real too, for every player's hero here.
    if (action.type === "dev" && action.dev.op === "heal") for (const u of next.units) if (u.side === "hero" && !u.controller) writes.push(...kitStatements(db, u.id));
    const grants = res.effects.filter((effect) => effect.type === "grant");
    if (grants.length === 0) {
      // The common case, and one trip to D1 for all of it: the pack's rows and then the zone, in that order.
      await db.batch([...writes, saveZoneStatement(db, next)]);
    } else {
      if (writes.length > 0) await db.batch(writes);
      // What a won fight paid, written before the zone is saved (and so before anyone is told of it).
      for (const effect of grants) {
        const { place } = await applyZoneGrant(db, effect.heroId, effect);
        // A full pack never loses what was found, but the hero hears where it went.
        if (effect.item && (place === "storage" || place === "overfull")) res.events.push({ t: "stowed", id: effect.heroId, item: effect.item.name, place });
        // The roster shows each hero's level.
        this.tellHarbor(effect.heroId);
      }
      await saveZoneStatement(db, next).run();
    }
    // A landfall cleared (nobody left to fight, nothing left to open) is cleared on the crew's chart: once, and
    // the Harbor is told, so a chart that is open there shows the routes beyond it.
    const landfall = this.landfall;
    if (landfall && !landfall.told && zoneStatus(next) === "cleared") {
      landfall.told = true;
      await clearNode(db, landfall.crewId, landfall.node);
      this.ctx.waitUntil(refreshHarbor(this.env, landfall.crewId));
    }
    await this.notePresence();
    this.broadcast([...passed, ...res.events], from);
    return null;
  }

  /** Write down, for everyone connected, that they are here and whether they are in a fight: only what has changed. */
  private async notePresence() {
    const zone = this.zone;
    if (!zone) return;
    for (const playerId of this.online()) {
      const now = !!zone.encounter?.order.includes(playerId);
      if (this.fighting.get(playerId) === now) continue;
      this.fighting.set(playerId, now);
      await setPresence(this.env.DB, playerId, zone.code, now);
      this.tellHarbor(playerId);
    }
  }

  /** The crew's Harbor shows where its members are: tell it to look again. */
  private tellHarbor(playerId: string) {
    this.ctx.waitUntil(
      crewFor(this.env.DB, playerId)
        .then((crew) => refreshHarbor(this.env, crew?.id ?? null))
        .catch((err) => console.warn("zone-room:harbor-refresh-failed", { err: err instanceof Error ? err.message : String(err) })),
    );
  }

  /** Players connected right now. */
  private online(): string[] {
    return [...new Set(this.ctx.getWebSockets().map((ws) => (ws.deserializeAttachment() as Attachment).playerId))];
  }

  /** Tell everyone here the state and what happened. `from`: whose action this answers; their socket alone gets their number back. */
  private broadcast(events: ZoneEvent[], from?: Asked) {
    const zone = this.zone;
    if (!zone) return;
    const online = this.online();
    for (const ws of this.ctx.getWebSockets()) {
      const seat = ws.deserializeAttachment() as Attachment;
      const view = zoneView(zone, seat.playerId);
      // The tiles go once to a client that keeps them: everything else about the map (its places) goes every time.
      const { tiles: _tiles, ...rest } = view.map;
      const state = seat.lean && seat.tiles ? { ...view, map: rest } : view;
      try {
        // `acks` tells a client that this room answers numbered actions, so it is safe for it to show them ahead.
        ws.send(JSON.stringify({ type: "update", state, events, online, acks: true, ...(from?.ws === ws && from.n !== undefined ? { ack: from.n } : {}) }));
        if (seat.lean && !seat.tiles) ws.serializeAttachment({ ...seat, tiles: true } satisfies Attachment);
      } catch {
        // Socket is closing; webSocketClose will follow.
      }
    }
  }

  /** A new turn is being waited on (or none is): set its deadline and the alarm that ends it. */
  private async armTimer(zone: ZoneState) {
    const deadline = zoneAwaiting(zone) ? Date.now() + ZONE_TURN_MS : null;
    if (zone.encounter) zone.encounter.deadline = deadline;
    if (deadline) await this.ctx.storage.setAlarm(deadline);
    else await this.ctx.storage.deleteAlarm();
  }

  /** Called when someone connects: restart a clock that lapsed while the zone was empty. */
  private async resumeTimer() {
    const zone = this.zone!;
    if (!zoneAwaiting(zone)) return;
    const deadline = zone.encounter?.deadline ?? null;
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || !deadline || deadline < Date.now()) {
      await this.armTimer(zone);
      await saveZoneStatement(this.env.DB, zone).run();
    }
  }
}
