import { Hono } from "hono";

import type { CombatEvent, CombatState, TurnAction } from "@gantt-quest/core";

import { pregenAllViewArt } from "./ai";
import { handleCommand, handleInteraction, rebuildTownState, startQuestFromLobby } from "./commands";
import { getQuestById } from "@gantt-quest/db";
import {
  parseInteractivePayload,
  parseSlashCommand,
  respondToCommand,
  verifySlackSignature,
} from "./slack";

export interface Env {
  DB: D1Database;
  AI: Ai;
  // R2 bucket for static images (shop header, etc.) served via /img/<key>.
  ASSETS: R2Bucket;
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  ALLOWED_CHANNEL_ID: string; // Set via .dev.vars locally / `wrangler secret put` in prod. Empty = allow any channel.
  // Display name for the bot in user-facing text (help, rules, channel-restriction
  // message). Set via wrangler.jsonc `vars` to override per-workspace branding.
  // Defaults to "Slack Quest" when unset. Helper: `botName(env)` in commands.ts.
  BOT_NAME?: string;
  // Public base URL of this worker (e.g. https://gantt-quest.3cordguy.workers.dev).
  // Used to build absolute image URLs that Slack can fetch for image blocks.
  // Optional — when unset, image blocks are simply omitted.
  IMAGE_BASE_URL?: string;
  // Public base URL of the web app (e.g. https://slack-quest-web.<sub>.workers.dev).
  // Surfaced in the /sq web-login ephemeral so the player can click through to
  // paste their code. Optional — when unset, the code is shown without a link.
  WEB_BASE_URL?: string;
  // Cross-worker DO binding pointing at the web worker's QuestRoom class.
  // Same namespace as the web worker uses; the wrangler config supplies
  // `script_name: "<web-worker-name>"` so this Slack worker can route into
  // the existing DO instance without owning its migrations.
  //
  // Used in PR 3 onward to drive the shared step() engine for combat
  // actions originating from Slack. Optional in v1 deploys that haven't
  // re-deployed wrangler — combat handlers must guard with `if (!env.QUEST_ROOM)`.
  QUEST_ROOM?: DurableObjectNamespace;
  // Routing toggle for the unified engine combat path. Default = legacy
  // cooldown-paced Slack combat (current behavior). Set to "0" to route
  // /gq attack | cast | signature | flee through QuestRoom.serverAction
  // instead — turns become strict-order, drink-buff + AI flavor fanout
  // wiring follow up in later commits on the same branch.
  //
  // The toggle is read at the top of handleCombat. Two code paths share
  // zero state; flipping it mid-quest is fine for new actions, but
  // in-flight legacy combat scenes can't migrate retroactively without
  // re-rolling initiative. See the PR-3 drain plan for the production
  // rollout.
  LEGACY_SLACK_COMBAT?: string;
  // Feature flag: "1" enables STATS_V2 primary stat derivations in combat.
  STATS_V2?: string;
  // Feature flag: "1" routes new dungeon quests through the AI-generated graph
  // dungeon (Phase 4). Legacy expedition dungeons stay active for in-flight
  // quests; new /gq quest dungeon starts use graph navigation.
  DUNGEON_GRAPH?: string;
  // Singleton DO that manages lobby timeout alarms. One instance handles all
  // active lobbies; per-lobby entries keyed by questId in DO storage.
  // Optional: when unset, lobby auto-start is disabled (manual only).
  LOBBY_MANAGER?: DurableObjectNamespace;
}

// Structural stub for the cross-bound QuestRoom DO. We don't import the
// QuestRoom class type from apps/web (that would couple the slack tsc
// build to the web worker's tree) — instead we declare the two RPC
// method signatures we call so TypeScript can type-check the call sites
// here without paying the dependency cost. Engine types (CombatState,
// CombatEvent, TurnAction) come from @gantt-quest/core which both
// workers already depend on.
export interface QuestRoomStub {
  bootstrapFromSlack(questId: number): Promise<
    | { ok: true; state: CombatState; events: CombatEvent[]; created: boolean }
    | { ok: false; reason: string; detail?: string }
  >;
  serverAction(
    questId: number,
    action: TurnAction,
  ): Promise<
    | { ok: true; state: CombatState; events: CombatEvent[]; outcome?: unknown }
    | { ok: false; reason: string }
  >;
  notifyFighterJoined(questId: number, userId: string, newMonsterMaxHp: number): Promise<void>;
}

// Stable name → DO id mapping. Both the web worker (apps/web/src/worker.ts)
// and the Slack worker use this convention so cross-bound stubs route to
// the same instance per quest. Don't change without updating the web worker.
export function questRoomId(
  env: Pick<Env, "QUEST_ROOM">,
  questId: number,
): DurableObjectId | null {
  if (!env.QUEST_ROOM) return null;
  return env.QUEST_ROOM.idFromName(`quest:${questId}`);
}

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("slack-quest is alive."));

// One-shot pre-warm endpoint for the singleton view-art banners (inventory,
// shop, lockbox tiers, merchant, treasure). Runs every prompt through flux
// once and persists to R2 so the first player to hit each surface in Slack
// sees the banner immediately rather than after the lazy-gen completes.
//
// Gated by the same secret used for Slack signature verification — not
// strictly auth, but keeps drive-by traffic from triggering generations.
// Idempotent: already-cached keys are short-circuit no-ops, so running it
// twice is harmless.
app.get("/admin/warm-views", async (c) => {
  const provided = c.req.query("key");
  if (!provided || provided !== c.env.SLACK_SIGNING_SECRET) {
    return c.text("forbidden", 403);
  }
  if (!c.env.IMAGE_BASE_URL) {
    return c.json({ error: "IMAGE_BASE_URL is not configured" }, 500);
  }
  const results = await pregenAllViewArt(c.env.AI, {
    bucket: c.env.ASSETS,
    baseUrl: c.env.IMAGE_BASE_URL,
  });
  return c.json({ ok: true, results });
});

// Serves static images from the ASSETS R2 bucket. Public — no auth needed; Slack
// fetches these to render image blocks in shop / quest displays. Cache headers
// keep traffic to R2 minimal once the image has been seen.
app.get("/img/:key{.+}", async (c) => {
  const key = c.req.param("key");
  const obj = await c.env.ASSETS.get(key);
  if (!obj) return c.text("not found", 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", "public, max-age=86400, immutable");
  return new Response(obj.body, { headers });
});

app.post("/slack/commands", async (c) => {
  const body = await c.req.text();
  const ok = await verifySlackSignature(
    body,
    c.req.header("x-slack-request-timestamp") ?? null,
    c.req.header("x-slack-signature") ?? null,
    c.env.SLACK_SIGNING_SECRET,
  );
  if (!ok) return c.text("invalid signature", 401);

  const payload = parseSlashCommand(body);

  if (c.env.ALLOWED_CHANNEL_ID && payload.channel_id !== c.env.ALLOWED_CHANNEL_ID) {
    const name = c.env.BOT_NAME?.trim() || "Slack Quest";
    return c.json({
      response_type: "ephemeral",
      text: `${name} only runs in the designated channel.`,
    });
  }

  // Wrap handleCommand so any thrown error surfaces as an ephemeral text
  // response instead of a 500 (which Slack reports back to the user as the
  // opaque "invalid_command_response" error). Logs the stack so we can debug
  // via wrangler tail.
  try {
    const response = await handleCommand(payload, c.env, c.executionCtx);
    return c.json(response);
  } catch (err) {
    console.error("command:unhandled", {
      command: payload.command,
      text: payload.text,
      user: payload.user_id,
      err: err instanceof Error ? err.stack || err.message : String(err),
    });
    return c.json({
      response_type: "ephemeral",
      text: `⚠️ Something broke: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

// Block Kit button clicks come here. Slack's interactivity Request URL must be
// set to {worker_url}/slack/interactive in the app config under Interactivity & Shortcuts.
//
// Slack expects an immediate 200 ack for block_actions payloads and renders the
// follow-up via response_url POSTs (unlike slash commands which render the JSON
// response body inline). We POST through respondToCommand for the ephemeral
// confirmation, then return 200.
app.post("/slack/interactive", async (c) => {
  const body = await c.req.text();
  const ok = await verifySlackSignature(
    body,
    c.req.header("x-slack-request-timestamp") ?? null,
    c.req.header("x-slack-signature") ?? null,
    c.env.SLACK_SIGNING_SECRET,
  );
  if (!ok) return c.text("invalid signature", 401);

  const payload = parseInteractivePayload(body);
  if (!payload) return c.text("bad payload", 400);

  if (c.env.ALLOWED_CHANNEL_ID && payload.channel.id !== c.env.ALLOWED_CHANNEL_ID) {
    const name = c.env.BOT_NAME?.trim() || "Slack Quest";
    c.executionCtx.waitUntil(
      respondToCommand(payload.response_url, {
        response_type: "ephemeral",
        text: `${name} only runs in the designated channel.`,
      }),
    );
    return c.text("", 200);
  }

  // Run the action + post the result back to Slack via response_url. We waitUntil
  // both so the worker can return 200 immediately (Slack times out at ~3s).
  c.executionCtx.waitUntil(
    (async () => {
      try {
        const response = await handleInteraction(payload, c.env, c.executionCtx);
        // When the handler sets _deleteOriginal, the actual new content went
        // to the thread via postToThread — response_url is used only to
        // remove the now-stale prompt (with its expired buttons). This keeps
        // the thread clean and avoids the duplicate-render problem where the
        // actor used to see both their ephemeral and the public thread post.
        if (response._deleteOriginal) {
          await respondToCommand(payload.response_url, { delete_original: true });
        } else {
          await respondToCommand(payload.response_url, {
            response_type: response.response_type ?? "ephemeral",
            text: response.text,
            blocks: response.blocks,
            // Only pass replace_original when the handler explicitly opted
            // out (false). Leaving it undefined lets Slack apply its
            // default for block_actions (replace_original: true), which is
            // what most action handlers want.
            ...(response._replaceOriginal === false ? { replace_original: false } : {}),
          });
        }
      } catch (err) {
        await respondToCommand(payload.response_url, {
          response_type: "ephemeral",
          text: `❌ Interaction failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    })(),
  );
  return c.text("", 200);
});

// ─── LobbyManager DO ─────────────────────────────────────────────────────────
// Singleton Durable Object that manages lobby timeout alarms for all active
// quest lobbies. Entries are stored as `lobby:<questId>` in DO storage.
// When a lobby's expiry time arrives, `startQuestFromLobby` is called to
// transition the quest from `lobby` → `active` and post the opening content.

interface LobbyEntry {
  questId: number;
  channelId: string;
  threadTs: string;
  lobbyTs: string | null;
  expiresAt: number;
}

interface TurnNotifEntry {
  questId: number;
  userId: string;
  channelId: string;
  threadTs: string;
  fireAt: number;
}

const TURN_NOTIF_DELAY_MS = 2 * 60 * 1000; // 2 minutes

export class LobbyManager {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  // RPC-over-fetch: POST body is JSON { method, ...args }
  async fetch(req: Request): Promise<Response> {
    const { method, ...args } = (await req.json()) as Record<string, unknown>;
    if (method === "schedule") {
      const { questId, expiresAt, channelId, threadTs, lobbyTs } = args as unknown as LobbyEntry;
      await this.scheduleLobbyTimeout(questId, expiresAt, channelId, threadTs, lobbyTs);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }
    if (method === "cancel") {
      const { questId } = args as { questId: number };
      await this.cancelLobbyTimeout(questId);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }
    if (method === "scheduleTurnNotif") {
      const { questId, userId, channelId, threadTs, fireAt } = args as unknown as TurnNotifEntry;
      await this.scheduleTurnNotif(questId, userId, channelId, threadTs, fireAt);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }
    if (method === "cancelTurnNotif") {
      const { questId } = args as { questId: number };
      await this.cancelTurnNotif(questId);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: false, error: "unknown method" }), { status: 400, headers: { "content-type": "application/json" } });
  }

  async scheduleLobbyTimeout(
    questId: number,
    expiresAt: number,
    channelId: string,
    threadTs: string,
    lobbyTs: string | null,
  ): Promise<void> {
    await this.state.storage.put<LobbyEntry>(`lobby:${questId}`, {
      questId, expiresAt, channelId, threadTs, lobbyTs,
    });
    const current = await this.state.storage.getAlarm();
    if (current === null || expiresAt < current) {
      await this.state.storage.setAlarm(expiresAt);
    }
  }

  async cancelLobbyTimeout(questId: number): Promise<void> {
    await this.state.storage.delete(`lobby:${questId}`);
    const entries = await this.state.storage.list<LobbyEntry>({ prefix: "lobby:" });
    if (entries.size === 0) {
      await this.state.storage.deleteAlarm();
    } else {
      let min = Infinity;
      for (const [, entry] of entries) {
        if (entry.expiresAt < min) min = entry.expiresAt;
      }
      await this.state.storage.setAlarm(min);
    }
  }

  async scheduleTurnNotif(
    questId: number,
    userId: string,
    channelId: string,
    threadTs: string,
    fireAt: number,
  ): Promise<void> {
    await this.state.storage.put<TurnNotifEntry>(`turn:${questId}`, {
      questId, userId, channelId, threadTs, fireAt,
    });
    const current = await this.state.storage.getAlarm();
    if (current === null || fireAt < current) {
      await this.state.storage.setAlarm(fireAt);
    }
  }

  async cancelTurnNotif(questId: number): Promise<void> {
    await this.state.storage.delete(`turn:${questId}`);
    await this.rescheduleAlarm();
  }

  private async rescheduleAlarm(): Promise<void> {
    const lobbyEntries = await this.state.storage.list<LobbyEntry>({ prefix: "lobby:" });
    const turnEntries = await this.state.storage.list<TurnNotifEntry>({ prefix: "turn:" });
    let min: number | null = null;
    for (const [, e] of lobbyEntries) if (min === null || e.expiresAt < min) min = e.expiresAt;
    for (const [, e] of turnEntries) if (min === null || e.fireAt < min) min = e.fireAt;
    if (min === null) await this.state.storage.deleteAlarm();
    else await this.state.storage.setAlarm(min);
  }

  async alarm(): Promise<void> {
    const now = Date.now();

    // Process expired lobby entries
    const lobbyEntries = await this.state.storage.list<LobbyEntry>({ prefix: "lobby:" });
    for (const [key, entry] of lobbyEntries) {
      if (entry.expiresAt <= now) {
        try {
          await startQuestFromLobby(
            entry.questId, entry.channelId, entry.threadTs, entry.lobbyTs, this.env,
          );
        } catch (err) {
          console.error("LobbyManager.alarm: startQuestFromLobby failed", {
            questId: entry.questId, err: String(err),
          });
        }
        await this.state.storage.delete(key);
      }
    }

    // Process delayed turn notifications
    const turnEntries = await this.state.storage.list<TurnNotifEntry>({ prefix: "turn:" });
    for (const [key, entry] of turnEntries) {
      if (entry.fireAt <= now) {
        try {
          const quest = await getQuestById(this.env.DB, entry.questId);
          if (quest && this.env.SLACK_BOT_TOKEN) {
            await fetch("https://slack.com/api/chat.postMessage", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "authorization": `Bearer ${this.env.SLACK_BOT_TOKEN}`,
              },
              body: JSON.stringify({
                channel: entry.channelId,
                thread_ts: entry.threadTs,
                text: `<@${entry.userId}> it's your turn!`,
              }),
            });
          }
        } catch (err) {
          console.error("LobbyManager.alarm: turn notif failed", { questId: entry.questId, err: String(err) });
        }
        await this.state.storage.delete(key);
      }
    }

    await this.rescheduleAlarm();
  }
}

// Call the singleton LobbyManager DO to schedule an auto-start alarm.
export async function scheduleLobbyAlarm(
  env: Env,
  questId: number,
  expiresAt: number,
  channelId: string,
  threadTs: string,
  lobbyTs: string | null,
): Promise<void> {
  if (!env.LOBBY_MANAGER) return;
  const id = env.LOBBY_MANAGER.idFromName("singleton");
  const stub = env.LOBBY_MANAGER.get(id);
  await stub.fetch("http://do/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "schedule", questId, expiresAt, channelId, threadTs, lobbyTs }),
  });
}

// Call the singleton LobbyManager DO to cancel a pending alarm.
export async function cancelLobbyAlarm(env: Env, questId: number): Promise<void> {
  if (!env.LOBBY_MANAGER) return;
  const id = env.LOBBY_MANAGER.idFromName("singleton");
  const stub = env.LOBBY_MANAGER.get(id);
  await stub.fetch("http://do/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "cancel", questId }),
  });
}

// Schedule a delayed turn notification. Replaces any previous pending notif for
// the same quest so only the current actor's turn is ever pending at one time.
export async function scheduleTurnNotifAlarm(
  env: Env,
  questId: number,
  userId: string,
  channelId: string,
  threadTs: string,
): Promise<void> {
  if (!env.LOBBY_MANAGER) return;
  const fireAt = Date.now() + TURN_NOTIF_DELAY_MS;
  const id = env.LOBBY_MANAGER.idFromName("singleton");
  const stub = env.LOBBY_MANAGER.get(id);
  await stub.fetch("http://do/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "scheduleTurnNotif", questId, userId, channelId, threadTs, fireAt }),
  });
}

// Cancel any pending turn notification for a quest (e.g. when quest ends).
export async function cancelTurnNotifAlarm(env: Env, questId: number): Promise<void> {
  if (!env.LOBBY_MANAGER) return;
  const id = env.LOBBY_MANAGER.idFromName("singleton");
  const stub = env.LOBBY_MANAGER.get(id);
  await stub.fetch("http://do/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "cancelTurnNotif", questId }),
  });
}

// ─── End LobbyManager DO ──────────────────────────────────────────────────────

// Daily cron: rebuild town state (job board, NPCs, shop) for every channel
// that has an existing town_state row. Runs early morning so the board is
// fresh before players arrive. Configure the trigger time in wrangler.jsonc
// under `triggers.crons`.
async function scheduledRefresh(env: Env, ctx: ExecutionContext) {
  const rows = await env.DB
    .prepare(`SELECT DISTINCT channel_id FROM town_state`)
    .all<{ channel_id: string }>();
  const channels = rows.results?.map((r) => r.channel_id) ?? [];
  // Fallback: if no town state exists yet, seed the configured channel.
  if (channels.length === 0 && env.ALLOWED_CHANNEL_ID) {
    channels.push(env.ALLOWED_CHANNEL_ID);
  }
  console.log("scheduled:town_refresh", { channels });
  ctx.waitUntil(
    Promise.all(channels.map((ch) => rebuildTownState(env, ch).catch((err) => {
      console.error("scheduled:town_refresh:error", { channel: ch, err: String(err) });
    }))),
  );
}

export default {
  fetch: app.fetch.bind(app),
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    await scheduledRefresh(env, ctx);
  },
};
