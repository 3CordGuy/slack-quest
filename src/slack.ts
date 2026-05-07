// Slack-specific helpers: signature verification + Web API helpers.

export interface SlashCommandPayload {
  token: string;
  team_id: string;
  team_domain: string;
  channel_id: string;
  channel_name: string;
  user_id: string;
  user_name: string;
  command: string;
  text: string;
  response_url: string;
  trigger_id: string;
  api_app_id: string;
}

const encoder = new TextEncoder();

export async function verifySlackSignature(
  body: string,
  timestamp: string | null,
  signature: string | null,
  signingSecret: string,
): Promise<boolean> {
  if (!timestamp || !signature) return false;

  const ts = parseInt(timestamp, 10);
  if (Number.isNaN(ts)) return false;
  // Reject anything older than 5 minutes (replay protection).
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > 60 * 5) return false;

  const baseString = `v0:${timestamp}:${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(baseString));
  const hex = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const computed = `v0=${hex}`;

  if (computed.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

export function parseSlashCommand(body: string): SlashCommandPayload {
  const params = new URLSearchParams(body);
  return Object.fromEntries(params.entries()) as unknown as SlashCommandPayload;
}

export interface PostMessageArgs {
  channel: string;
  text: string;
  thread_ts?: string;
  // When true alongside thread_ts, Slack posts the message both as a thread reply AND
  // as a top-level channel message. Use sparingly — only for high-value "big beat"
  // moments (joins, victories, perma-death, phase transitions) that earn the channel
  // interrupt.
  reply_broadcast?: boolean;
  blocks?: unknown[];
}

export async function postMessage(
  botToken: string,
  args: PostMessageArgs,
): Promise<{ ok: boolean; ts?: string; error?: string }> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(args),
  });
  return (await res.json()) as { ok: boolean; ts?: string; error?: string };
}

// Reply asynchronously to a slash command using its response_url.
// Use this when work takes >3s — Slack's initial ack must return faster than that.
export async function respondToCommand(
  responseUrl: string,
  payload: { text: string; response_type?: "ephemeral" | "in_channel"; blocks?: unknown[] },
): Promise<void> {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
