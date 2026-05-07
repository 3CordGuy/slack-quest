import { Hono } from "hono";

import { handleCommand } from "./commands";
import { parseSlashCommand, verifySlackSignature } from "./slack";

export interface Env {
  DB: D1Database;
  AI: Ai;
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  ALLOWED_CHANNEL_ID: string; // Set via .dev.vars locally / `wrangler secret put` in prod. Empty = allow any channel.
}

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("slack-quest is alive."));

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
    return c.json({
      response_type: "ephemeral",
      text: "Slack Quest only runs in the designated channel.",
    });
  }

  const response = await handleCommand(payload, c.env, c.executionCtx);
  return c.json(response);
});

export default app;
