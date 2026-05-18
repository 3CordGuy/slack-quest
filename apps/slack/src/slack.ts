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
  // Set to true when this payload was synthesized from a Block Kit button
  // click (interactive flow) rather than a real slash command. Handlers use
  // this to avoid the duplicate-render issue: button clicks already get a
  // public update via response_url's response_type, so they should skip the
  // separate postToThread that slash commands rely on for visibility.
  _interactive?: boolean;
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

// Slack's interactivity payloads (button clicks, menu selects, etc.) come in as
// URL-encoded form bodies with a single `payload` field containing JSON. We only
// care about block_actions for the inventory buttons today.
export interface InteractiveAction {
  action_id: string;       // e.g. "equip" | "use" | "sell"
  block_id: string;        // e.g. "inv_42"
  value: string;           // typically the inventory id as a string
  type: string;            // "button" | "static_select" | ...
}

export interface InteractivePayload {
  type: "block_actions" | string;
  user: { id: string; username?: string };
  channel: { id: string; name?: string };
  team: { id: string; domain?: string };
  api_app_id: string;
  trigger_id: string;
  response_url: string;
  actions: InteractiveAction[];
}

export function parseInteractivePayload(body: string): InteractivePayload | null {
  const params = new URLSearchParams(body);
  const raw = params.get("payload");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as InteractivePayload;
  } catch {
    return null;
  }
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

export async function openDMChannel(
  botToken: string,
  userId: string,
): Promise<string | null> {
  const res = await fetch("https://slack.com/api/conversations.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ users: userId }),
  });
  const data = (await res.json()) as { ok: boolean; channel?: { id: string }; error?: string };
  if (!data.ok) {
    console.warn("conversations.open failed", data.error);
    return null;
  }
  return data.channel?.id ?? null;
}

export async function sendDM(
  botToken: string,
  userId: string,
  text: string,
): Promise<void> {
  const channelId = await openDMChannel(botToken, userId);
  if (!channelId) return;
  await postMessage(botToken, { channel: channelId, text });
}

// Edits an existing channel message. Used to retire stale interactive
// buttons after a multi-player game resolves (the original "Accept /
// Bet" buttons would otherwise stay live and return errors on click).
export interface UpdateMessageArgs {
  channel: string;
  ts: string;
  text: string;
  blocks?: unknown[];
}
export async function deleteMessage(
  botToken: string,
  channel: string,
  ts: string,
): Promise<void> {
  await fetch("https://slack.com/api/chat.delete", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, ts }),
  });
}

export async function updateMessage(
  botToken: string,
  args: UpdateMessageArgs,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(args),
  });
  return (await res.json()) as { ok: boolean; error?: string };
}

// Recruitment-card post for a freshly-started quest. Lands in the channel
// alongside the opening narrative with a single "Join Quest" button so
// spectators can drop in without typing `/sq join`.
//
// Skipped for elite quests (perma-death — opt-in by direct invite only) and
// for any mid-flow quest (dungeon past room 1, gauntlet past wave 1). Quest
// creation is always at the start of those flows so the check is a no-op
// today, but we keep it explicit so future "resurrect dropped quest" code
// paths don't accidentally re-broadcast a half-played quest as joinable.
//
// Two buttons:
//   1. "Join on web" — a Block Kit link button to `webBaseUrl`. Drops the
//      user into the web app where the dashboard's joinable-quest banner
//      handles the actual /api/quest/join POST. Omitted when WEB_BASE_URL
//      is unset so dev iteration doesn't render a dead link.
//   2. "Join here" — Slack-side join. `action_id` encodes the quest id
//      (`join_quest_<id>`) for in-block uniqueness, but handleJoin looks
//      up the active quest in the channel naturally.
export interface JoinableQuestArgs {
  channel: string;
  questId: number;
  variant: "standard" | "boss" | "gauntlet" | "dungeon" | string;
  monsterName: string;
  monsterMaxHp: number;
  createdByUserId: string;
  partySize: number;
  // Public base URL of the web app (e.g. https://quest.heylets.party).
  // When provided, the recruitment card renders a "Join on web" link
  // button alongside the Slack "Join here" button so users can pick
  // whichever surface they prefer.
  webBaseUrl?: string;
}

export async function postJoinableQuest(
  botToken: string,
  args: JoinableQuestArgs,
): Promise<{ ok: boolean; ts?: string; error?: string }> {
  const variantBadge =
    args.variant === "boss"
      ? "👑 Boss"
      : args.variant === "gauntlet"
      ? "⚔️ Gauntlet"
      : args.variant === "dungeon"
      ? "🗺️ Dungeon"
      : "⚔️ Quest";

  const partyLine =
    args.partySize > 1
      ? `Party of ${args.partySize} — *${args.monsterName}* (${args.monsterMaxHp} HP)`
      : `<@${args.createdByUserId}> vs. *${args.monsterName}* (${args.monsterMaxHp} HP)`;

  const text = `${variantBadge} — joinable quest. ${partyLine}`;

  // Buttons render in declaration order: web link first, Slack join
  // second. action_ids must be unique within the actions block; the
  // link button's action_id is decorative (Slack doesn't deliver an
  // interactivity payload for url buttons) but we still set one for
  // future analytics + the uniqueness rule.
  //
  // Important: prefix MUST differ from `join_quest_` so that
  // handleInteraction's prefix dispatcher (`action_id.startsWith
  // ("join_quest_")` → handleJoin) can't accidentally route a URL-button
  // click into the Slack-side join handler if Slack ever changes how
  // url buttons are delivered. `link_quest_web_` keeps the routing
  // explicit and one-way.
  const elements: unknown[] = [];
  if (args.webBaseUrl) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: "Join on web", emoji: true },
      action_id: `link_quest_web_${args.questId}`,
      url: args.webBaseUrl,
    });
  }
  elements.push({
    type: "button",
    style: "primary",
    text: { type: "plain_text", text: "Join here", emoji: true },
    action_id: `join_quest_${args.questId}`,
    value: String(args.questId),
  });

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${variantBadge} — *Joinable quest*\n${partyLine}`,
      },
    },
    {
      type: "actions",
      elements,
    },
  ];

  return postMessage(botToken, {
    channel: args.channel,
    text,
    blocks,
  });
}

// Reply asynchronously to a slash command using its response_url.
// Use this when work takes >3s — Slack's initial ack must return faster than that.
//
// Supports the response_url-specific flags: replace_original deletes the
// previous message and posts the new content in its place; delete_original
// removes the message that triggered this interaction without posting
// anything new. Both only meaningful for interactive (button click)
// payloads — slash command response_urls ignore them.
export async function respondToCommand(
  responseUrl: string,
  payload: {
    text?: string;
    response_type?: "ephemeral" | "in_channel";
    blocks?: unknown[];
    replace_original?: boolean;
    delete_original?: boolean;
  },
): Promise<void> {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
