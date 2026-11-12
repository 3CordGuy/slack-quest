# The Harbor of Heylets

A live, turn-based co-op game in the spirit of *For the King*. Your crew shares a harbour town between voyages. Up to four of you board a ship, sail to a freshly generated island with its own story, talk your way past AI-voiced islanders, fight what lives there, and bring the loot home.

- **Play:** https://harbor.heylets.party
- **Staging:** https://harbor-staging.heylets.party

It runs entirely on Cloudflare: Workers, Durable Objects, D1, Workers AI and Email Sending, with a React and Three.js client. Pixel-art sprites stand on low-poly hex terrain.

> The repo is called `slack-quest` and the packages `@gantt-quest/*` for historical reasons. The original game, **Gantt Quest**, still lives in `apps/web` and `apps/slack`; see [The original Gantt Quest](#the-original-gantt-quest) below.

---

## The game

**The Harbor** is your crew's home, a shared town you all walk around in together.
- **Gathering:** fish off the shore, fell trees, work the quarry. Each is a short timing game, swayed by your stats.
- **Your hut:** buy a plot, fill a resource bin to raise a shack, then furnish it, craft for it and upgrade it. Rest there to recover.
- **The pub:** food and drink that boost your next voyage, dice and Shoals at the tables, and traveling salesmen who drop in from time to time.
- **Crew projects:** pay together into the Apothecary (brews for the voyage) and Smithy (sharpen and reinforce gear) first; once both stand, the Lighthouse (a day more on every voyage, and the island's coast charted) and the Galley (a shared larder) unlock.
- **Around town:** the market stall, the notice board's contracts and crew goal, the sparring ring, and trading or giving gear to crewmates.

**A voyage** is one session. The crew sails to a seeded hex island with a generated story:
- **The island:** fog lifts as you explore, enemy bands roam, and there are herbs, mushrooms, wood and stone to pick up.
- **Fights:** turn order follows a speed timeline, enemies show what they'll do next, and everything is resolved by stat-check rolls.
- **Islanders:** you talk to them in free text. The AI writes what they say, but it can only change the game through a fixed, validated set of actions.
- **Returning home:** win or lose, you come back with XP, gold, loot and hut materials. Defeat costs a capped amount of gold and nothing else.

**Heroes:** eight classes, each with a passive, two weapons, traits chosen at levels 2 and 4, and a signature weapon. The classes are Tidewall Paladin, Stormcall Mage, Smuggler Rogue, Reef Druid, Shanty Bard, Starchart Sage, Lighthouse Warden and Wreck Warlock. Characters persist and level up, and sign-in is by email code, so guests can save their progress.

**For admins:** an admin page (`#admin`) renames things, recolours sprites and swaps item icons without code changes. It's presentation only and never changes the rules.

## Repo layout

| Path | What |
|---|---|
| `apps/game` | **The game.** Hono Worker, Durable Objects (`RunRoom`, `HarborRoom`, `HutRoom`, `PubRoom`), the AI calls, and the React + Three.js client. Its own D1 database and migrations. See [`apps/game/README.md`](apps/game/README.md). |
| `packages/world` | **The rules.** Pure and deterministic: no I/O, and no `Math.random` (everything uses a seeded RNG). The world and battle reducers, maps, stories, gear, huts, gathering, projects, the pub games and trading. Most changes start here. |
| `packages/core` | Shared basics from the original game: hex geometry, the five stats, starting stats and levelling. |
| `apps/web`, `apps/slack`, `packages/db` | The original Gantt Quest (legacy). |
| `docs/` | Design docs and checklists; see [Docs](#docs). |

## Run it locally

You don't need any Cloudflare resources to run it locally.

```bash
pnpm install
cp apps/game/wrangler.example.jsonc apps/game/wrangler.jsonc
pnpm --filter @gantt-quest/game db:migrate:local
pnpm dev:game
```

1. Open http://localhost:5180, create a character and found a crew.
2. For a second player on the same machine, open another tab with a different profile, e.g. http://localhost:5180/?p=2, and join with the crew's invite code.

Some local defaults:
- **Sign-in codes** are printed in the dev server's output instead of emailed.
- **The AI** runs in `"mock"` mode, a scripted stand-in. Set `AI_MODE` to `"live"` in your `wrangler.jsonc` to use real Workers AI.
- **Admin page:** to see `#admin` locally, put `ADMIN_EMAILS=you@example.com` in `apps/game/.dev.vars`.
- **New migrations:** whenever new migrations land, run `db:migrate:local` again. A local 500 error after pulling usually means one was missed.

Dev builds expose a few console handles:
- **Driving the game:** `window.__gq` (on a voyage) and `window.__harbor`.
- **Pinning the sky:** `window.__gqTime` (0 is midnight, 0.5 is noon) and `window.__gqWeather` (0 is clear, 1 is heavy rain).

## Tests

```bash
pnpm --filter @gantt-quest/world test        # the rules, including a seeded fight-balance simulation
pnpm --filter @gantt-quest/world typecheck
pnpm --filter @gantt-quest/game typecheck
pnpm --filter @gantt-quest/game test         # server code against SQLite with the migrations applied
```

CI (`.github/workflows/ci.yml`) runs the tests and typechecks on pull requests.

## Deploying

The game has two environments, both set in `apps/game/wrangler.jsonc`:

| | Worker | Address | Database |
|---|---|---|---|
| Staging | `gantt-quest-game-staging` | harbor-staging.heylets.party | `gantt-quest-game-staging` |
| Production | `gantt-quest-game` | harbor.heylets.party | `gantt-quest-game` |

`wrangler.jsonc` is **gitignored**. `wrangler.example.jsonc` is the tracked template. Copy it and fill in the real database IDs.

Deploy one environment at a time, in this order:

```bash
cd apps/game
npx wrangler d1 migrations apply DB --remote --env staging   # 1. migrations first
CLOUDFLARE_ENV=staging pnpm build                             # 2. build for that environment
npx wrangler deploy                                           # 3. deploy what was just built
```

- **Migrations first.** Apply them, and check they're recorded (`SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1`), before deploying, so new code never runs against an old schema. Migrations can't be rolled back; deploys can (`wrangler rollback`).
- **Build every time.** `wrangler deploy` ships whatever the last build produced, for whichever environment it was built for.
- **Production:** use `--env production` and `CLOUDFLARE_ENV=production`. The full checklist (secrets, the first deploy, smoke test, rollback) is [`docs/game-production-checklist.md`](docs/game-production-checklist.md).
- **Secrets:** `ADMIN_EMAILS` is a Worker secret per environment: `npx wrangler secret put ADMIN_EMAILS --env staging`.
- **CI deploys:** `.github/workflows/deploy-game.yml` can deploy from GitHub Actions. It's off by default: it needs the `WRANGLER_GAME_CONFIG` secret, and the repo variable `GAME_STAGING_AUTODEPLOY=true` for automatic staging deploys. Until then, deploys are by hand.

### Branches

- `main` is the only long-lived branch. Feature branches open PRs into it.
- A push to `main` runs `.github/workflows/deploy.yml`, which deploys the **legacy** web app and Slack bot. It skips pushes that only touch the game (`apps/game`, `packages/world`) or docs, and it never deploys the game.

## How the code is built

A few rules that keep the game fair and replayable:

- **The rules are pure.** Clients send intents. The Durable Object runs the reducer (`stepWorld` / `stepBattle` in `packages/world`) and broadcasts the result. The acting hero always comes from the socket, never from the message.
- **Everything random is seeded,** so a voyage can be replayed from its seed and action log.
- **The AI never changes the game directly.** It returns words plus a *proposed* intent, which is checked against what that islander is allowed to do in the story. New powers are added as validated verbs in `packages/world`, not as prompt text.
- **D1 is the system of record.** Durable Objects hibernate, reload from D1, and save before broadcasting. Timers are Durable Object alarms, never `setTimeout`.
- **Rewards are written as they're earned,** so a dropped voyage never loses loot.
- **Money and items move atomically,** in conditional D1 batches, so two requests at once can't spend the same gold twice.

## Docs

| Doc | What |
|---|---|
| [`apps/game/README.md`](apps/game/README.md) | The game app in depth: where each piece of code lives, and more rules worth knowing |
| [`docs/overworld-revamp.md`](docs/overworld-revamp.md) | The design behind the rewrite, and what's been built |
| [`docs/game-production-checklist.md`](docs/game-production-checklist.md) | Taking the game to production, and rolling back |
| [`docs/legacy-gantt-quest.md`](docs/legacy-gantt-quest.md) | The original Gantt Quest: architecture, setup and Slack app |

Other files in `docs/` are design notes from the original game: tactical hex combat, the expedition map, gear affixes and uniques, multi-foe encounters, ground effects, battlefield art, and its town map and pub.

## The original Gantt Quest

The first version of the game is a team-comedic, engineering-themed dungeon crawl. It's still running:
- `apps/web` is its web dashboard.
- `apps/slack` is its Slack bot, which is deprecated.
- Both share the `gantt-quest` D1 database through `packages/db`.

It's deployed by GitHub Actions on every push to `main`. It shares no data with The Harbor of Heylets: the two have separate databases, Workers and accounts. Its full README is preserved at [`docs/legacy-gantt-quest.md`](docs/legacy-gantt-quest.md).
