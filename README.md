# slack-quest

A Slack bot that runs a comedic, engineering-themed mini dungeon-crawl in a single channel.
Cloudflare Workers + D1 + Workers AI. No real coworkers as NPCs — names are generated.

> Rename it for your team — the bot's display name (`Slack Quest` in [src/ai.ts](src/ai.ts),
> [src/commands.ts](src/commands.ts), [src/index.ts](src/index.ts), and the manifest below)
> is just a default. The Cloudflare Worker name and D1 database name in
> [wrangler.jsonc](wrangler.jsonc) and [package.json](package.json) can be renamed too.

## Design at a glance

- **Surface:** one Slack channel (the bot rejects calls from anywhere else).
- **Persistence:** D1. One character per Slack user, one active quest at a time.
- **Death model:** soft death by default — at 0 HP you're "downed," lose 25% gold + a random
  inventory item, and can't quest for 12h. Elite quests (`/dnd quest elite`) flip on perma-death.
- **AI:** Cloudflare Workers AI (`@cf/meta/llama-3.1-8b-instruct`) narrates opening scenes,
  hits, crits, joins, deaths, victories, and successful flees. Combat resolution itself is
  deterministic / dice-based — the model only writes the flavor line that wraps the result.
  Each slash command's ephemeral ack is the deterministic outcome (instant, no AI dependency);
  the AI-flavored version posts to the thread a beat later via `ctx.waitUntil`. If the model
  call fails or times out, the thread post falls back to a static line.
- **No GitHub integration.** Quests are AI-flavored from generic prompts.

## Current status

What works:

- `/dnd roll` — create a character with a random class + generated name.
- `/dnd me` — show your sheet.
- `/dnd quest [variant] [elite]` — kick off a quest. Variants: `boss` (L3+, single tougher
  monster, 2 phases at 50% HP, 2× rewards), `gauntlet` (L5+, 3 monsters back-to-back, no
  flee, party locked at start, 3× rewards, guaranteed drop on the final kill). `elite` is
  a modifier that composes with any variant — turns on perma-death. The bot generates the
  opening scene with Workers AI and posts it to the channel; for gauntlets it pre-generates
  all three waves at quest start so transitions are instant.
- `/dnd join` — join the active quest in the current channel. Monster max HP grows by 40%
  per joiner so the encounter doesn't get trivialized.
- `/dnd attack` — 1d6 + class `attack_mod`, crit ×2 on a natural 6.
- `/dnd cast` — 1d8 + class `magic_mod`, crit ×2 on a natural 8.
- `/dnd flee` — 1d2; on a 1 you escape (party fights on; quest fails only if you were the
  last fighter), on a 2 the monster gets a free hit and you stay in.
- `/dnd party` — show the current quest's roster + HP.
- `/dnd leaderboard` — top 10 heroes by level/XP/gold (channel-visible).
- Combat resolves a player turn then a monster turn. Monster damage is `1d4 + tier +
  floor((alive_party - 1) / 2)` so it gets meaner with more enemies. Updates post in the
  quest thread; the invoker gets an ephemeral copy.
- **Per-player 45-second cooldown** between actions instead of strict turn order — keeps
  Slack's async vibe and prevents one fast typer from dominating.
- **Soft death** at 0 HP on standard quests: 25% gold loss, drop a random inventory item,
  +1 scar, 12h `downed_until` cooldown, HP restored to max for next time. The quest
  continues for surviving party members.
- **Perma-death** at 0 HP on elite quests: character row deleted (cascades inventory + party
  records; `quests.created_by` is `ON DELETE SET NULL` so historical quests survive).
  Survivors fight on; quest only ends when the last fighter falls.
- **Victory rewards** split evenly across alive party members at the kill blow. Level-up
  triggers automatically when XP crosses the threshold (each level adds 1d6 to max HP and
  refills the bar).
- **Loot drops** roll independently per fighter on victory. Drop chance is 35% +5% per
  monster tier, capped at 70%. Each drop rolls a slot (40% weapon / 30% armor / 30%
  consumable), a rarity (common → rare; weights skew rarer at higher tiers), and a power
  number. The system rolls mechanics; the AI generates the name + flavor line.
- **Equipment** — `/dnd inventory` lists items, `/dnd equip <id>` slots a weapon or armor
  (one of each at a time). Combat reads equipped gear: `attack`/`cast` rolls become
  `class_mod + weapon_power`; armor reduces incoming damage by `floor(armor_power / 2)`,
  with a minimum of 1 dmg taken so armor never makes you immune.
- **Consumables** — `/dnd use <id>` heals you for the item's power. Free action; doesn't
  consume your 45-second combat cooldown so potions are actually worth taking into a fight.
- **Shop** — `/dnd shop` lists 5 AI-generated items priced flat by rarity (15/50/150g).
  Stock is **channel-wide and restocks every 6 hours**, so the channel collectively decides
  who grabs the rare drop. `/dnd buy <id>` claims atomically (no double-spend if two people
  hit the same item). `/dnd sell <id>` returns 30% of shop price as gold sink prevention.
  Stock tier scales with the active community's average level.

Still stubbed:

- `/dnd quest expedition` — multi-scene branching narrative with NPC encounters, decision
  forks, and skill checks. First-vote-wins decisions in v1.
- Reaction-based spectator buffs/debuffs.
- Idle-quest auto-fail timeout (a quest with no action in N hours should fail).

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
  name: Slack Quest
  description: A mini dungeon crawl for the team.
features:
  bot_user:
    display_name: Slack Quest
    always_online: true
  slash_commands:
    - command: /dnd
      url: https://slack-quest.<your-subdomain>.workers.dev/slack/commands
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
# fill in SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, and (optionally) ALLOWED_CHANNEL_ID
```

`ALLOWED_CHANNEL_ID` restricts slash commands to a single channel — get it by right-clicking
the channel → Copy link → the ID is the last path segment. Leave it blank in dev to accept
calls from any channel.

For deployed Workers:

```bash
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put ALLOWED_CHANNEL_ID
```

Keeping `ALLOWED_CHANNEL_ID` out of `wrangler.jsonc` means a public repo never leaks the
target channel ID.

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
