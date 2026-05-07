# gantt-quest

A Slack bot that runs a comedic, engineering-themed mini dungeon-crawl in a single channel.
Cloudflare Workers + D1 + Workers AI. No real coworkers as NPCs — names are generated.

## Design at a glance

- **Surface:** one Slack channel (the bot rejects calls from anywhere else).
- **Persistence:** D1. One character per Slack user, one active quest at a time.
- **Death model:** soft death by default — at 0 HP you're "downed," lose 25% gold + a random
  inventory item, and can't quest for 12h. Elite quests (`/dnd quest elite`) flip on perma-death.
- **AI:** Cloudflare Workers AI (`@cf/meta/llama-3.1-8b-instruct`) for opening-scene narration only.
  Combat resolution is deterministic / dice-based; the model just adds flavor.
- **No GitHub integration.** Quests are AI-flavored from generic prompts.

## Current status

v1 scaffold. What works:

- `/dnd roll` — create a character with a random class + generated name.
- `/dnd me` — show your sheet.
- `/dnd quest [elite]` — kick off a quest. The bot generates an opening scene with Workers AI
  and posts it to the channel. The thread + monster state is persisted.
- `/dnd help` — list commands.

What's stubbed for v2 (deliberately, not by accident):

- In-quest combat actions (`/dnd attack`, `/dnd cast`, etc.) — schema is ready, command
  dispatch needs writing.
- Scar awarding + downed-timer enforcement on actual HP-zero.
- Inventory drops + level-up flow.
- Elite quest perma-death cleanup.

See `src/commands.ts` for the dispatch table — that's where `attack` and friends slot in.

## Setup

### 1. Install + create the D1 database

```bash
pnpm install
pnpm db:create
```

Copy the `database_id` Wrangler prints into `wrangler.jsonc` under `d1_databases[0].database_id`.

### 2. Apply migrations locally

```bash
pnpm db:migrate:local
```

### 3. Create the Slack app

Use this manifest at <https://api.slack.com/apps?new_app=1> → "From an app manifest":

```yaml
display_information:
  name: Gantt-Quest
  description: A mini dungeon crawl for the team.
features:
  bot_user:
    display_name: Gantt-Quest
    always_online: true
  slash_commands:
    - command: /dnd
      url: https://gantt-quest.<your-subdomain>.workers.dev/slack/commands
      description: Roll a character, start a quest, check your sheet
      usage_hint: roll | me | quest [elite] | help
      should_escape: false
oauth_config:
  scopes:
    bot:
      - chat:write
      - commands
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

Install to your workspace, copy the bot token (`xoxb-...`) and signing secret.

### 4. Wire up secrets

Locally:

```bash
cp .dev.vars.example .dev.vars
# fill in SLACK_SIGNING_SECRET and SLACK_BOT_TOKEN
```

Set `ALLOWED_CHANNEL_ID` in `wrangler.jsonc` to the `#gamers` channel ID once you have it
(right-click the channel → Copy link → the ID is the last path segment).

For deployed Workers:

```bash
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_BOT_TOKEN
```

### 5. Run it

```bash
pnpm dev
```

In another terminal, expose your dev server with ngrok or Cloudflare Tunnel and update the
slash command URL in the Slack app to that hostname while iterating.

For prod:

```bash
pnpm db:migrate:remote
pnpm deploy
```

Then point the Slack app's slash command URL at the deployed Worker.

## File map

```
migrations/0001_init.sql   — schema (characters, quests, party, log, inventory)
src/index.ts               — Hono entrypoint, Slack signature verify, channel allowlist
src/slack.ts               — signature verification + Web API helpers
src/commands.ts            — slash sub-command dispatch + handlers
src/db.ts                  — D1 query helpers (no ORM)
src/ai.ts                  — Workers AI scene generation + parser
src/flavor.ts              — classes, NPC name generator, dice
```
