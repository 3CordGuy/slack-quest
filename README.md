# The Harbor of Heylets

A live co-op game. Your crew shares a harbour town. From the waygate in its square you open the crew's atlas, a chart of places that grows as you clear them, and step through to a freshly generated map: a ruin, a snowfield, a cave, a stronghold. You walk it freely, fight what lives there turn by turn on its hexes, search what they leave behind, and bring the loot home.

- **Play:** https://harbor.heylets.party
- **Staging:** https://harbor-staging.heylets.party

It runs entirely on Cloudflare: Workers, Durable Objects, D1, Workers AI and Email Sending, with a React and Three.js client drawing low-poly figures on hex terrain.

> The packages are called `@gantt-quest/*` for historical reasons: the Harbor grew out of an earlier game, **Gantt Quest**, whose code was removed from this repo in November 2026 (it is in the git history before then). The repo itself was `3CordGuy/slack-quest` until it moved to `heylets-game/heylets`; the old URL redirects.

---

## The game

**The Harbor** is your crew's home, a shared town you all walk around in together.
- **Gathering:** fish off the piers and the shore, fell trees, work the quarry. Fishing is a fight with one fish at a time; the quarry is thirty seconds at a rock face, hunting for the seam; felling is played through your hero's eyes: thirty seconds chopping, then thirty seconds splitting the logs on a block.
- **Your hut:** buy a plot, fill a resource bin to raise a shack, then furnish it, craft for it and upgrade it. Rest there to recover.
- **The pub:** a meal that gives back a gathering outing, table games played for a stake, the regulars and their errands, and traveling salesmen who drop in from time to time.
- **Crew projects:** pay together into the Apothecary and Smithy first; once both stand, the Lighthouse and the Galley unlock.
- **Around town:** the market stall, the notice board with each release's news, the Lapidary (where lodestones are cut and worked), the town chest the crew shares, and trading or giving gear to crewmates.

**The atlas** is the crew's chart of the world, opened at the waygate. Setting out for a place on it is a voyage.
- **Places:** each node is a place to clear. Clearing one opens the ones beyond it; lookouts lift the cloud over a wide stretch, and lairs hold a boss.
- **Lodestones:** setting out for a place takes a lodestone, put into its slot. A stone can carry modifiers that make the map harder and its bounty richer.
- **Setting out:** when one of you sets out, everyone in town is asked whether they are coming.

**A map** is one place on the atlas, generated from a seed.
- **Walking:** out of a fight, you walk where you like. A fight starts when you come close to an enemy band, and other bands that hear it join in.
- **Fights:** turn by turn on the hexes, each hero and enemy with a turn of their own, paid for in Action Points. Height, surfaces on the ground, and shoves off ledges and into water all matter, and every roll is shown in the combat log.
- **Loot:** bodies and chests are searched and shared first come, first served; clearing the place pays every hero a bounty of their own.
- **The caverns** under the Harbor are played the same way, by torchlight.

**Heroes:** eight classes, each with a passive, two weapons, class abilities chosen for a few slots, and a signature weapon. The classes are Lighthouse Paladin, Stormcall Mage, Smuggler Rogue, Reef Druid, Shanty Bard, Starchart Sage, Tidewall Warden and Wreck Warlock. Characters persist and level up, and sign-in is by email code, so guests can save their progress.

**For admins:** an admin page (`#admin`) renames things, recolours sprites and swaps item icons without code changes. It's presentation only and never changes the rules.

## Repo layout

| Path | What |
|---|---|
| `apps/game` | **The game.** Hono Worker, Durable Objects (`HarborRoom`, `HutRoom`, `PubRoom`, `ZoneRoom`), the AI calls, and the React + Three.js client. Its own D1 database and migrations. See [`apps/game/README.md`](apps/game/README.md). |
| `packages/world` | **The rules.** Pure and deterministic: no I/O, and no `Math.random` (everything uses a seeded RNG). Fights on the tiles (`src/zone`), map generation, the atlas, gear, huts, gathering, projects, the pub games and trading. Most changes start here. |
| `packages/core` | Shared basics: hex geometry, the five stats, starting stats and the XP curve. |
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

Port 5180 is fixed (`strictPort`). To run a second checkout or git worktree at the same time, give it another port: `pnpm --filter @gantt-quest/game exec vite --port 5181`. Each checkout has its own local database, so run `db:migrate:local` there too.

Some local defaults:
- **Sign-in codes** are printed in the dev server's output instead of emailed.
- **The AI** runs in `"mock"` mode, a scripted stand-in. Set `AI_MODE` to `"live"` in your `wrangler.jsonc` to use real Workers AI.
- **Admin page:** to see `#admin` locally, put `ADMIN_EMAILS=you@example.com` in `apps/game/.dev.vars`.
- **New migrations:** whenever new migrations land, run `db:migrate:local` again. A local 500 error after pulling usually means one was missed.

Dev builds expose a few console handles:
- **Driving the game:** `window.__harbor` in the Harbor and `window.__gqZone` on a map.
- **Pinning the sky:** `window.__gqTime` (0 is midnight, 0.5 is noon) and `window.__gqWeather` (0 is clear, 1 is heavy rain).
- **The renderer:** `window.__gqWorld` (`__gqWorld.renderer.info.render.calls` for draw calls).

## Tests

```bash
pnpm --filter @gantt-quest/world test        # the rules
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

### From GitHub Actions (the normal way)

`.github/workflows/deploy-game.yml` deploys the game. For each environment it writes the config, runs the tests, takes a D1 Time Travel bookmark, applies and confirms migrations, builds, deploys and smoke-tests.

- **Staging** deploys automatically on every push to `main` that touches the game (`apps/game`, `packages/world`, `packages/core`, the lockfile or the workflow). The repo variable `GAME_STAGING_AUTODEPLOY=true` turns this on. To deploy staging by hand: `gh workflow run deploy-game.yml --ref main -f target=staging`.
- **Production** deploys when you push a `game-v*` tag. Tag a commit that is already green on staging, named for the day; a second release the same day gets a suffix (`game-v2026.11.13.2`):
  ```bash
  git fetch origin && git tag game-v2026.11.13 origin/main && git push origin game-v2026.11.13
  ```
  There is no approval step: the push deploys to production once the tests and migrations pass. Before tagging, read what the release will say on the notice board (see [Release notes](#release-notes) below). The run's last job writes the tag's GitHub release from the same notes.
- **Config:** CI gets the whole `apps/game/wrangler.jsonc` from the repo secret `WRANGLER_GAME_CONFIG`. When you change an environment block (a new binding, var or Durable Object), update the secret too, or CI keeps deploying the old config: `gh secret set WRANGLER_GAME_CONFIG < apps/game/wrangler.jsonc`.

### By hand (fallback)

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

### Branches and shipping a change

- `main` is the only long-lived branch. Feature branches open PRs into it; start them from a fresh `origin/main`.
- A push to `main` that touches the game deploys it to **staging** (see above). Production only ever deploys from a `game-v*` tag.

For collaborators, a change goes out like this:

1. Branch from `origin/main`, make the change, and run the tests and typechecks above.
2. Try it in the browser locally (reload, a second player with `?p=2`, and a phone-sized window) before committing.
3. Open a PR into `main`, with a title a player would understand (`Area: what changed`): it becomes the line on the notice board. CI runs the tests and typechecks; list what you checked by hand in the description.
4. Merge once CI is green. Staging deploys on its own: check the run in the Actions tab and try the change on https://harbor-staging.heylets.party.
5. If a new binding, var or Durable Object came with the change, update the `WRANGLER_GAME_CONFIG` secret before tagging.
6. When staging looks right, check the release notes (below), then tag for production (above).

### Release notes

The Harbor's notice board lists what changed in each release, and a tab left open on an older build offers the same list ("What's in this release?") when a newer one is out. The notes are not written at release time: the build reads them out of git. Every `game-v*` tag is a release, and its notes are the commits on `main` since the tag before it. So the notes are written when a PR is merged, and checked when a release is cut.

**In every PR that changes the game:**

- The squash commit's subject is the note, so the PR title (or the only commit's subject) is written for players: `Fishing: a perfect catch pays a little more`.
- To say more than one line, or something better than the title, put `Release-note:` lines in a commit message on the branch, one per change a player would notice. The squash commit's message is the branch's commit messages joined together; the PR description is not part of it.
- `Release-note: skip` leaves the commit off the board. Use it only when the whole PR changes nothing a player can notice: a `skip` in any one commit on the branch hides the entire PR.
- Commits that touch no shipped code (docs, CI, scripts, tests) make no line and need nothing.

**Before pushing a tag:**

```bash
git fetch origin --tags
node --experimental-strip-types apps/game/scripts/release-notes.ts --unreleased   # run on the commit you will tag
```

The first entry, `next-<sha>`, is what the board will say for the release (staging's board shows it as "Coming next"). If a change players would notice is missing, or a line reads like a commit rather than news, correct it in `apps/game/scripts/release-note-overrides.ts` (keyed by commit hash), merge that, and tag the new tip. After the tag there is nothing more to write: the deploy builds the board and the GitHub release from git.

**A good note** is written for players, in plain words, one line per change they would notice: what they can now do or see, not what the code does. It starts with the area (`Fights:`, `Pub:`, `Sea bag:`) and leaves out file names, PR numbers and internal terms.

[`AGENTS.md`](AGENTS.md) has the same steps for coding agents, and [`apps/game/README.md`](apps/game/README.md#release-notes) has the rules the script follows.

## How the code is built

A few rules that keep the game fair and replayable:

- **The rules are pure.** Clients send intents. The Durable Object runs the reducer (`stepZone` in `packages/world`) and broadcasts the result. The acting hero always comes from the socket, never from the message.
- **Everything random is seeded,** so a map is the same for everyone on it and its fights can be replayed in tests.
- **The AI only ever produces words** (the barkeep's talk, a name for a new hero). It never changes the game.
- **D1 is the system of record.** Durable Objects hibernate, reload from D1, and save before broadcasting. Timers are Durable Object alarms, never `setTimeout`.
- **Rewards are written as they're earned,** so a dropped connection never loses loot.
- **Money and items move atomically,** in conditional D1 batches, so two requests at once can't spend the same gold twice.

## Docs

| Doc | What |
|---|---|
| [`apps/game/README.md`](apps/game/README.md) | The game app in depth: where each piece of code lives, and more rules worth knowing |
| [`AGENTS.md`](AGENTS.md) | For coding agents: writing release notes for the notice board, and what to check before committing |
| [`docs/game-production-checklist.md`](docs/game-production-checklist.md) | Taking the game to production, and rolling back |
| [`docs/fishing-rebuild.md`](docs/fishing-rebuild.md) | The design doc fishing was rebuilt from |
