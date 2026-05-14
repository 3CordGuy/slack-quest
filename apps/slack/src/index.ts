import { Hono } from "hono";

import { pregenAllViewArt } from "./ai";
import { handleCommand, handleInteraction } from "./commands";
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

export default app;
