// Web app Worker. Handles /api/* routes; static assets and SPA fallback come
// from the ASSETS binding (configured in wrangler.jsonc). Shares the same D1
// instance as the Slack worker so codes issued by /sq web-login are visible
// here. The QuestRoom Durable Object (defined below) coordinates live web-mode
// combat over WebSocket.

import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

import {
  classByName,
  createCombatState,
  step,
  type CombatInit,
  type CombatState,
  type RollFn,
  type TurnAction,
} from "@gantt-quest/core";
import {
  consumeWebLoginCode,
  createWebSession,
  deleteWebCombatState,
  deleteWebSession,
  getActiveQuestForCharacter,
  getCharacter,
  getEquipped,
  getInventory,
  getQuestParty,
  getRecentQuestsForCharacter,
  getWebCombatState,
  getWebSession,
  saveWebCombatState,
} from "@gantt-quest/db";

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  QUEST_ROOM: DurableObjectNamespace<QuestRoom>;
}

const SESSION_COOKIE = "sq_session";
const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;

const app = new Hono<{ Bindings: Env }>();

// POST /api/auth/verify { code: "123456" } → sets session cookie on success.
app.post("/api/auth/verify", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { code?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!/^\d{6}$/.test(code)) {
    return c.json({ error: "invalid_code" }, 400);
  }

  const redeemed = await consumeWebLoginCode(c.env.DB, code);
  if (!redeemed) {
    return c.json({ error: "invalid_or_expired" }, 401);
  }

  const session = await createWebSession(
    c.env.DB,
    redeemed.slack_user_id,
    redeemed.slack_team_id,
  );

  setCookie(c, SESSION_COOKIE, session.session_id, {
    httpOnly: true,
    sameSite: "Lax",
    secure: true,
    maxAge: SESSION_MAX_AGE_SEC,
    path: "/",
  });
  return c.json({ ok: true });
});

app.post("/api/auth/logout", async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (sessionId) await deleteWebSession(c.env.DB, sessionId);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

// Returns the authenticated user's character (or null if they haven't created
// one yet via /sq quest in Slack).
app.get("/api/me", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  return c.json({
    slack_user_id: session.slack_user_id,
    slack_team_id: session.slack_team_id,
    character,
  });
});

app.get("/api/inventory", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const items = await getInventory(c.env.DB, session.slack_user_id);
  return c.json({ items });
});

// Returns the user's currently-active quest (with scene state + party) or
// { quest: null } if they're not in one. Polled by the active-quest panel.
app.get("/api/quest/active", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest) return c.json({ quest: null });
  const party = await getQuestParty(c.env.DB, quest.id);
  return c.json({ quest, party });
});

// Most-recent completed/failed quests for the signed-in user. Used to render
// the history card.
app.get("/api/quests/recent", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const quests = await getRecentQuestsForCharacter(
    c.env.DB,
    session.slack_user_id,
    10,
  );
  return c.json({ quests });
});

// Starts (or resumes) web-mode combat for the user's active quest. Snapshots
// the party + monster from D1 into a CombatState, rolls initiative, and saves
// to web_combat_state. Idempotent: if a state already exists for this quest,
// the existing one is returned untouched so a refresh in the middle of a
// fight doesn't reset progress.
//
// v1 limits: standard + boss variants only. Gauntlet/dungeon stay on Slack.
app.post("/api/quest/:id/start_web_combat", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);

  const existing = await getWebCombatState(c.env.DB, questId);
  if (existing) return c.json({ quest_id: questId, state: existing });

  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest || quest.id !== questId) {
    return c.json({ error: "quest_not_active_for_user" }, 404);
  }
  const variant = quest.scene.variant ?? "standard";
  if (variant !== "standard" && variant !== "boss") {
    return c.json({ error: "unsupported_variant", variant }, 400);
  }

  const party = await getQuestParty(c.env.DB, questId);
  const fighters: CombatInit["fighters"] = [];
  for (const member of party) {
    const [weapon, armor] = await Promise.all([
      getEquipped(c.env.DB, member.slack_user_id, "weapon"),
      getEquipped(c.env.DB, member.slack_user_id, "armor"),
    ]);
    const cls = classByName(member.class);
    fighters.push({
      id: member.slack_user_id,
      name: member.name,
      class: member.class,
      level: member.level,
      hp: member.hp,
      max_hp: member.max_hp,
      mana: member.mana,
      max_mana: member.max_mana,
      shield: member.shield,
      position: member.position,
      attack_mod: cls.attack_mod,
      magic_mod: cls.magic_mod,
      weapon_power: weapon?.power ?? 0,
      armor_power: armor?.power ?? 0,
    });
  }

  const init: CombatInit = {
    fighters,
    monster: {
      name: quest.scene.monster_name,
      hp: quest.scene.monster_hp,
      max_hp: quest.scene.monster_max_hp,
      tier: quest.scene.tier,
      is_boss: variant === "boss",
      boss_phase: quest.scene.boss_phase,
    },
  };
  const initial = createCombatState(init);
  const begun = step(initial, { kind: "begin" }, productionRoll);
  await saveWebCombatState(c.env.DB, questId, begun.state);
  return c.json({ quest_id: questId, state: begun.state });
});

// Clears the web combat state for a quest. Used when the player exits the
// combat page. Doesn't touch the underlying quest row — quest outcome
// resolution (XP/gold/loot) lives in Phase 2d.
app.post("/api/quest/:id/end_web_combat", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const party = await getQuestParty(c.env.DB, questId);
  if (!party.some((p) => p.slack_user_id === session.slack_user_id)) {
    return c.json({ error: "not_in_party" }, 403);
  }
  await deleteWebCombatState(c.env.DB, questId);
  return c.json({ ok: true });
});

// WS upgrade for live combat. Session-gated and party-membership-checked
// (the user must be in this quest's party). The DO is keyed by quest_id so
// every party member talking about quest 42 lands in the same instance.
app.get("/api/ws/quest/:id", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("expected websocket", 426);
  }
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.text("unauthenticated", 401);

  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.text("bad quest id", 400);

  // Party-membership gate. We won't ship action authorization from inside
  // the DO; that's the worker's job before we hand off the WS.
  const party = await getQuestParty(c.env.DB, questId);
  if (!party.some((p) => p.slack_user_id === session.slack_user_id)) {
    return c.text("not in party", 403);
  }

  const doId = c.env.QUEST_ROOM.idFromName(`quest:${questId}`);
  const stub = c.env.QUEST_ROOM.get(doId);
  // Pass quest_id + user_id along so the DO knows who connected.
  const url = new URL(c.req.url);
  url.searchParams.set("quest", String(questId));
  url.searchParams.set("user", session.slack_user_id);
  return stub.fetch(new Request(url.toString(), c.req.raw));
});

// Health check. Anything else falls through to the ASSETS binding via the
// wrangler `not_found_handling: single-page-application` config.
app.get("/api/health", (c) => c.json({ ok: true }));

async function currentSession(db: D1Database, cookieHeader: string | undefined) {
  if (!cookieHeader) return null;
  const match = /(?:^|;\s*)sq_session=([^;]+)/.exec(cookieHeader);
  if (!match) return null;
  return getWebSession(db, decodeURIComponent(match[1]));
}

export default app;

// ─── Durable Object ─────────────────────────────────────────────────────────
//
// QuestRoom owns one quest's live combat. Followed rules (per
// memory/feedback_durable_objects.md):
//   1. WebSocket Hibernation API — ctx.acceptWebSocket() lets the DO sleep
//      between turns without dropping the connection or billing active.
//   2. D1 is the system of record — every step() result is persisted via
//      saveWebCombatState before broadcasting. Instance-variable caches
//      (this.cache*) survive only within an active execution; on wake we
//      rehydrate from D1.
//   3. No setTimeout/setInterval — DO Alarms or lazy-on-action timing only.
//   4. No background tickers — status effects apply on the actor's next turn.
//   5. Idle WS disconnect — connection inactivity is fine; the DO closes
//      sockets the runtime tells it have gone away. (No explicit timer here
//      — adding it would need DO Alarms, deferred until we see real abuse.)

interface ClientToServer {
  type: "action";
  action: TurnAction;
}

interface ServerToClient {
  type: "state" | "events" | "error";
  state?: CombatState;
  events?: unknown[];
  message?: string;
}

interface WsAttachment {
  quest_id: number;
  user_id: string;
}

const productionRoll: RollFn = (sides) => Math.floor(Math.random() * sides) + 1;

export class QuestRoom extends DurableObject<Env> {
  // We hold a best-effort in-memory cache of the combat state, but always
  // reload from D1 when uncertain (post-hibernate) and always persist back
  // to D1 before broadcasting.
  private cacheState: CombatState | null = null;
  private cacheQuestId: number | null = null;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const questId = parseInt(url.searchParams.get("quest") ?? "", 10);
    const userId = url.searchParams.get("user") ?? "";
    if (!Number.isFinite(questId) || !userId) {
      return new Response("bad params", { status: 400 });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernation: tells the runtime to deliver future messages to
    // this.webSocketMessage()/Close() even if the DO hibernates between them.
    this.ctx.acceptWebSocket(server);
    // `this.ctx` is the DurableObjectState provided by the DurableObject base.
    const attach: WsAttachment = { quest_id: questId, user_id: userId };
    server.serializeAttachment(attach);

    // Send initial state snapshot if combat already exists for this quest.
    const state = await this.loadState(questId);
    if (state) {
      this.sendOne(server, { type: "state", state });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // Called by the runtime when a client sends a frame. Survives hibernation.
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attach = ws.deserializeAttachment() as WsAttachment | null;
    if (!attach) {
      ws.close(1008, "missing attachment");
      return;
    }

    let parsed: ClientToServer | null = null;
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      parsed = JSON.parse(text) as ClientToServer;
    } catch {
      this.sendOne(ws, { type: "error", message: "invalid json" });
      return;
    }

    if (!parsed || parsed.type !== "action" || !parsed.action) {
      this.sendOne(ws, { type: "error", message: "expected { type: 'action', action: {...} }" });
      return;
    }

    const state = await this.loadState(attach.quest_id);
    if (!state) {
      this.sendOne(ws, { type: "error", message: "no combat in progress" });
      return;
    }

    const result = step(state, parsed.action, productionRoll);
    // Persist even on rejected actions? No — state didn't change. Only save
    // when the state actually advanced.
    const stateChanged = result.state !== state;
    if (stateChanged) {
      await saveWebCombatState(this.env.DB, attach.quest_id, result.state);
      this.cacheState = result.state;
    }

    // Broadcast events + the new state to every connected client.
    this.broadcast({ type: "events", events: result.events });
    if (stateChanged) {
      this.broadcast({ type: "state", state: result.state });
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    // Nothing to do — the runtime removes the closed socket from
    // getWebSockets() on its own. No alarms or timers to clean up.
  }

  private async loadState(questId: number): Promise<CombatState | null> {
    if (this.cacheState && this.cacheQuestId === questId) return this.cacheState;
    const state = await getWebCombatState(this.env.DB, questId);
    if (state) {
      this.cacheState = state;
      this.cacheQuestId = questId;
    }
    return state;
  }

  private sendOne(ws: WebSocket, msg: ServerToClient): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Closed socket; let the runtime clean up.
    }
  }

  private broadcast(msg: ServerToClient): void {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        // Closed socket; runtime cleans up.
      }
    }
  }
}
