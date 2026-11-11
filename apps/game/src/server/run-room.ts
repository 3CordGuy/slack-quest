// RunRoom: one Durable Object per voyage (run), addressed by run code.
//
// - WebSockets use the hibernation API, so an idle room costs nothing.
// - D1 is the system of record. this.world is only a cache and is reloaded
//   from runs.state_json after hibernation.
// - Every change is persisted before it is broadcast.
// - Turn timers are DO Alarms. Enemy turns resolve inside the reducer, so
//   nothing waits on a connected client to make progress.
// - Model calls happen outside the action queue and come back in as
//   ordinary server-only actions (begin, npc_reply, epilogue).

import { DurableObject } from "cloudflare:workers";
import {
  CLIENT_ACTIONS,
  awaitingKey,
  buildBible,
  cannedFill,
  clientView,
  createWorld,
  makeRng,
  pickFrame,
  seedFromString,
  stepWorld,
  type WorldAction,
  type WorldEffect,
  type WorldEvent,
  type WorldState,
} from "@gantt-quest/world";
import { generateFill, npcTurn, writeEpilogue } from "./ai";
import { applyGrant, applyPenalty, conversationStatement, getRun, heroInitFor, saveRunStatements, type Env } from "./db";

const TURN_MS = 120_000;
const CLOSE_AFTER_END_MS = 10 * 60_000;

interface Attachment {
  playerId: string;
}

export class RunRoom extends DurableObject<Env> {
  private world: WorldState | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** Run `fn` after everything queued before it. Keeps actions strictly ordered across awaits. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch((err) => console.error("run-room:queue-error", err));
    return next;
  }

  private async load(code?: string): Promise<WorldState> {
    if (this.world) return this.world;
    const runCode = code ?? (await this.ctx.storage.get<string>("code"));
    if (!runCode) throw new Error("run room has no code");
    const row = await getRun(this.env.DB, runCode);
    if (!row) throw new Error(`run ${runCode} not found`);
    this.world = row.state_json ? (JSON.parse(row.state_json) as WorldState) : createWorld(row.code, row.seed);
    if (code) await this.ctx.storage.put("code", code);
    return this.world;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const code = request.headers.get("x-run-code");
    const playerId = request.headers.get("x-player-id");
    if (!code || !playerId) return new Response("missing run or player", { status: 400 });

    const error = await this.serial(async () => {
      const world = await this.load(code);
      if (world.heroes.some((h) => h.id === playerId)) return null;
      const hero = await heroInitFor(this.env.DB, playerId);
      if (!hero) return "You need a character before boarding.";
      return this.apply({ type: "join", hero });
    });
    if (error) return new Response(error, { status: 409 });

    // One socket per player: a new tab takes over from the old one.
    for (const old of this.ctx.getWebSockets(playerId)) old.close(4000, "replaced by a newer connection");
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [playerId]);
    pair[1].serializeAttachment({ playerId } satisfies Attachment);

    await this.serial(async () => {
      await this.resumeTimer();
      this.broadcast([]);
    });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let msg: { type?: string; action?: { type?: string } };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (msg.type !== "action" || !msg.action || !CLIENT_ACTIONS.has(msg.action.type as WorldAction["type"])) return;
    const { playerId } = ws.deserializeAttachment() as Attachment;
    // The acting hero always comes from the socket, never from the message.
    const action = { ...msg.action, heroId: playerId } as WorldAction;
    const error = await this.serial(async () => {
      await this.load();
      return this.apply(action);
    });
    if (error) ws.send(JSON.stringify({ type: "error", message: error }));
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      // Already closed.
    }
    await this.serial(async () => {
      await this.load();
      this.broadcast([]);
    });
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011);
  }

  async alarm(): Promise<void> {
    await this.serial(async () => {
      const world = await this.load();
      const sockets = this.ctx.getWebSockets();
      if (world.phase === "ended") {
        // The voyage is over; do not hold idle sockets open.
        for (const ws of sockets) ws.close(1000, "voyage over");
        return;
      }
      // Nobody aboard: pause. resumeTimer restarts the clock on reconnect.
      if (sockets.length === 0) return;
      const deadline = world.turn?.deadline ?? world.battle?.deadline ?? null;
      if (deadline && Date.now() < deadline - 500) {
        await this.ctx.storage.setAlarm(deadline);
        return;
      }
      await this.apply({ type: "timeout" });
    });
  }

  // ---------- core loop ----------

  /** Step the world, persist, broadcast, then kick off any async effects. Returns an error string or null. */
  private async apply(action: WorldAction): Promise<string | null> {
    const prev = this.world!;
    const res = stepWorld(prev, action);
    if (!res.ok) return res.error;
    const next = res.state;

    if (awaitingKey(next) !== awaitingKey(prev)) await this.armTimer(next);
    this.world = next;

    const db = this.env.DB;
    const stmts = saveRunStatements(db, next, action);
    for (const ev of res.events) {
      if (ev.t === "chat" && ev.line.who !== "system") {
        const speaker = ev.line.who === "hero" && "heroId" in action ? action.heroId : "npc";
        const meta = action.type === "npc_reply" ? { intent: action.output.intent, verdicts: res.events.filter((e) => e.t === "npc_intent") } : null;
        stmts.push(conversationStatement(db, next.code, ev.line.npcId, speaker, ev.line.text, meta));
      }
    }
    await db.batch(stmts);
    // Rewards reach the character as they are earned, not at the end of the run.
    for (const effect of res.effects) {
      if (effect.kind === "grant") await applyGrant(db, next.code, effect.heroId, effect);
      else if (effect.kind === "penalty") await applyPenalty(db, effect.heroId, effect.goldPct, effect.cap);
    }

    this.broadcast(res.events);
    for (const effect of res.effects) this.dispatch(effect);
    return null;
  }

  private dispatch(effect: WorldEffect) {
    if (effect.kind === "story_gen") this.ctx.waitUntil(this.generateStory());
    else if (effect.kind === "npc_call") this.ctx.waitUntil(this.npcReply(effect));
    else if (effect.kind === "epilogue") this.ctx.waitUntil(this.epilogue());
  }

  private broadcast(events: WorldEvent[]) {
    const world = this.world;
    if (!world) return;
    const sockets = this.ctx.getWebSockets();
    const online = [...new Set(sockets.map((ws) => (ws.deserializeAttachment() as Attachment).playerId))];
    for (const ws of sockets) {
      const { playerId } = ws.deserializeAttachment() as Attachment;
      try {
        ws.send(JSON.stringify({ type: "update", state: clientView(world, playerId), events, online }));
      } catch {
        // Socket is closing; webSocketClose will follow.
      }
    }
  }

  // ---------- timers ----------

  private async armTimer(world: WorldState) {
    if (world.phase === "ended") {
      await this.ctx.storage.setAlarm(Date.now() + CLOSE_AFTER_END_MS);
      return;
    }
    const deadline = awaitingKey(world) ? Date.now() + TURN_MS : null;
    if (world.turn && world.phase === "overworld") world.turn.deadline = deadline;
    if (world.battle) world.battle.deadline = deadline;
    if (deadline) await this.ctx.storage.setAlarm(deadline);
    else await this.ctx.storage.deleteAlarm();
  }

  /** Called when someone connects: restart a clock that lapsed while the ship was empty. */
  private async resumeTimer() {
    const world = this.world!;
    if (!awaitingKey(world)) return;
    const deadline = world.turn?.deadline ?? world.battle?.deadline ?? null;
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || !deadline || deadline < Date.now()) await this.armTimer(world);
  }

  // ---------- model-backed effects ----------

  private async generateStory() {
    const world = this.world!;
    const rng = makeRng(seedFromString(`story|${world.seed}`));
    const frame = pickFrame(rng);
    const fallback = cannedFill(frame, rng);
    const fill = (await generateFill(this.env, frame, world.heroes.map((h) => h.name))) ?? fallback;
    const error = await this.serial(() => this.apply({ type: "begin", bible: buildBible(frame, fill) }));
    if (error) {
      console.warn("run-room:story-rejected", { error });
      await this.serial(() => this.apply({ type: "begin", bible: buildBible(frame, fallback) }));
    }
  }

  private async npcReply(effect: Extract<WorldEffect, { kind: "npc_call" }>) {
    const world = this.world!;
    const sheet = world.bible?.npcs.find((n) => n.id === effect.npcId);
    const run = world.npcs[effect.npcId];
    if (!world.bible || !sheet || !run) return;
    const output = (await npcTurn(this.env, {
      bible: world.bible,
      sheet,
      run,
      state: world,
      heroName: world.heroes.find((h) => h.id === effect.heroId)?.name ?? "A hero",
      text: effect.text,
      check: effect.check,
      history: world.chat.filter((l) => l.npcId === effect.npcId),
    })) ?? { say: `${sheet.name} studies you in silence, then looks away.`, intent: null, attitudeDelta: 0 };
    await this.serial(() => this.apply({ type: "npc_reply", npcId: effect.npcId, heroId: effect.heroId, output }));
  }

  private async epilogue() {
    const text = await writeEpilogue(this.env, this.world!);
    await this.serial(() => this.apply({ type: "epilogue", text }));
  }
}
