// ZoneRoom: one Durable Object per zone (a map a party walks freely and
// fights on), addressed by the zone's code.
//
// It follows RunRoom's rules:
// - WebSockets use the hibernation API, so an idle room costs nothing.
// - D1 is the system of record. this.zone is only a cache and is reloaded
//   from zones.state_json after hibernation.
// - Every change is persisted before it is broadcast.
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

import { DurableObject } from "cloudflare:workers";
import { THROWABLE_KINDS, ZONE_CLIENT_ACTIONS, createZone, stepZone, zoneAwaiting, zoneHero, zoneOptions, zoneView, type ZoneAction, type ZoneEvent, type ZoneState } from "@gantt-quest/world";
import { consumablesOf, gainConsumables, kitStatements, spendConsumables, type Consumables } from "./consumables";
import { applyZoneGrant, crewFor, heroInitFor, refreshHarbor, type Env } from "./db";
import { isDev } from "./dev";
import { clearPresence, getZoneRow, saveZoneStatement, setPresence } from "./zones";

/** How long a turn in a fight may take before it ends itself. */
export const ZONE_TURN_MS = 90_000;

interface Attachment {
  playerId: string;
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
  if (a.type === "light") return { type: "light", by, unit: a.unit, ...(a.hand === "main" ? { hand: "main" as const } : {}) };
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
    this.zone = row.state_json ? (JSON.parse(row.state_json) as ZoneState) : createZone(row.code, row.seed, zoneOptions(JSON.parse(row.options_json)));
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
    pair[1].serializeAttachment({ playerId } satisfies Attachment);

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
    let msg: { type?: string; action?: unknown };
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
    const action = zoneActionFrom(msg.action, playerId, isDev(this.env));
    if (!action) return;
    // Throwing, drinking, lighting a torch or picking one up as your own hero draws on (or adds to) your own pack. (A stand-in has no pack: it carries the kit it was given.)
    const pack = (action.type === "throw" || action.type === "drink" || action.type === "light" || action.type === "pickup") && action.unit === playerId ? playerId : undefined;
    const error = await this.serial(async () => {
      await this.load();
      return this.apply(action, pack);
    });
    if (error) ws.send(JSON.stringify({ type: "error", message: error }));
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
   */
  private async apply(action: ZoneAction, pack?: string): Promise<string | null> {
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
    for (const write of writes) await write.run();
    // What a won fight paid, written before the zone is saved (and so before anyone is told of it).
    for (const effect of res.effects) {
      if (effect.type !== "grant") continue;
      const { place } = await applyZoneGrant(db, effect.heroId, effect);
      // A full pack never loses what was found, but the hero hears where it went.
      if (effect.item && (place === "storage" || place === "overfull")) res.events.push({ t: "stowed", id: effect.heroId, item: effect.item.name, place });
      // The roster shows each hero's level.
      this.tellHarbor(effect.heroId);
    }
    await saveZoneStatement(db, next).run();
    await this.notePresence();
    this.broadcast([...passed, ...res.events]);
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

  private broadcast(events: ZoneEvent[]) {
    const zone = this.zone;
    if (!zone) return;
    const online = this.online();
    for (const ws of this.ctx.getWebSockets()) {
      const { playerId } = ws.deserializeAttachment() as Attachment;
      try {
        ws.send(JSON.stringify({ type: "update", state: zoneView(zone, playerId), events, online }));
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
