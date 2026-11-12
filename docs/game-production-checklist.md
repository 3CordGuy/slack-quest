# Game (`apps/game`) production checklist

Production is the Worker `gantt-quest-game` at **https://harbor.heylets.party**, with its own D1 database `gantt-quest-game`. Staging (`gantt-quest-game-staging`, https://harbor-staging.heylets.party) stays as it is. Every step marked **(approval)** changes something real in Cloudflare or GitHub: run it only after the owner has said yes.

All commands run from the repo root. `W` is shorthand for `pnpm --filter @gantt-quest/game exec wrangler`.

## 1. Create the resources

As of 2026-11-12 the account has no `gantt-quest-game` database and no `gantt-quest-game` Worker, so neither name is taken.

- **(approval)** The production D1 database:
  ```bash
  pnpm --filter @gantt-quest/game exec wrangler d1 create gantt-quest-game
  ```
  Copy the `database_id` it prints.
- Nothing else needs creating by hand. The Durable Object namespaces come with the first deploy (migration tags `v1`–`v4`), Workers AI needs no resource, and the custom domain's DNS record and certificate are made by the deploy.
- `noreply@heylets.party` is already onboarded for Email Sending (staging sends from it). Production reuses it.

## 2. Config

In your local, gitignored `apps/game/wrangler.jsonc`, add the `env.production` block from `apps/game/wrangler.example.jsonc` and put the new `database_id` in it. What it sets:

| | Production |
|---|---|
| `name` | `gantt-quest-game` (explicit, or wrangler would add `-production`) |
| `routes` | `[{ "pattern": "harbor.heylets.party", "custom_domain": true }]` |
| `workers_dev` / `preview_urls` | `false` / `false`: the custom domain is the only way in |
| `d1_databases` | `DB` → `gantt-quest-game` (the id from step 1) |
| `ai` | `AI` |
| `send_email` | `EMAIL`, remote |
| `vars` | `AI_MODE: "live"`, `MAIL_FROM_ADDRESS: "noreply@heylets.party"`, `MAIL_FROM_NAME: "Gantt Quest"` |
| `durable_objects` | `RUN_ROOM`, `HARBOR_ROOM`, `HUT_ROOM`, `PUB_ROOM` |

The top level of the file stays local-only (mock AI, all-zeros D1 id). That means a build made without `CLOUDFLARE_ENV` can't reach production: its deploy fails on the fake database id.

Durable Object `migrations` live at the top level and every environment shares them. When a new DO class lands, add a tag there and its binding to each environment's `durable_objects`.

Check the config without deploying:
```bash
CLOUDFLARE_ENV=production pnpm --filter @gantt-quest/game build
pnpm --filter @gantt-quest/game exec wrangler deploy --dry-run
```
The binding list should show `DB (gantt-quest-game)`, `EMAIL`, `AI`, `AI_MODE ("live")` and the four DOs. This was checked on 2026-11-12 with the template and a fake id.

## 3. Secrets

- `ADMIN_EMAILS` (comma-separated, lower-case). Unset means nobody is an admin, which is safe, so set it **after** the first deploy. `secret put` on a Worker that doesn't exist yet would create an empty one.
  - **(approval)**
    ```bash
    pnpm --filter @gantt-quest/game exec wrangler secret put ADMIN_EMAILS --name gantt-quest-game
    ```
    Pass `--name` every time: after a build, wrangler reads the built config, which is for whichever environment was built last.
- For CI (section 7), as GitHub repo secrets:
  - **(approval)** `WRANGLER_GAME_CONFIG`: the full `apps/game/wrangler.jsonc` with the real staging and production ids.
    ```bash
    gh secret set WRANGLER_GAME_CONFIG < apps/game/wrangler.jsonc
    ```
  - `CLOUDFLARE_API_TOKEN` already exists for the legacy deploy. It also needs these permissions (edit the token in the dashboard, or make a new one and update the secret):
    - Account: Workers Scripts Edit, D1 Edit, Workers AI Read;
    - Zone `heylets.party`: Workers Routes Edit and DNS Edit, for the custom domain.

## 4. Migrations, in this order

There are 15 files today, `0001_init.sql` to `0015_content_overrides.sql` (more may land before launch). On an empty database they all apply in one go, in filename order. D1 records each one in `d1_migrations`.

1. **(approval)**
   ```bash
   pnpm --filter @gantt-quest/game exec wrangler d1 migrations apply DB --remote --env production
   ```
2. Confirm. The result should be the newest file in `apps/game/migrations/`:
   ```bash
   pnpm --filter @gantt-quest/game exec wrangler d1 execute DB --remote --env production --command "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1"
   ```
3. Only then build and deploy. Always migrate before deploying, so new code never runs against an old schema. Migrations must also be additive: the code that's already live has to keep working on the new schema, because a rollback (section 6) brings old code back but leaves the schema as it is.

## 5. First deploy and smoke test

1. **(approval)** Build for production, then deploy:
   ```bash
   CLOUDFLARE_ENV=production pnpm --filter @gantt-quest/game build && pnpm --filter @gantt-quest/game exec wrangler deploy
   ```
   Don't pass `--env` to `deploy`: the build has already chosen the environment. Cloudflare then creates the `harbor.heylets.party` DNS record and certificate. The first HTTPS request can fail for a minute while the certificate is issued.
2. Read-only checks, which create no rows:
   ```bash
   curl -sI https://harbor.heylets.party/ | head -1
   ```
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://harbor.heylets.party/api/me
   ```
   The first should show 200 and the second 401.
3. By hand in a browser:
   - play as a guest;
   - create a character and found a crew;
   - walk the Harbor, which proves the HarborRoom DO and its WebSocket;
   - enter the hut and the pub, and say one line to the barkeep (live AI);
   - start a voyage and check the story text is not the canned mock;
   - attach an email and receive the code from `noreply@heylets.party`;
   - after the `ADMIN_EMAILS` secret is set, check that the admin link shows for that account.
4. Watch errors live while you play:
   ```bash
   pnpm --filter @gantt-quest/game exec wrangler tail gantt-quest-game
   ```
   Look for `ai:json-error`, `ai:text-error` and `[email/dev]`. The last one means the EMAIL binding is missing.

## 6. Rollback

- **Code:**
  ```bash
  pnpm --filter @gantt-quest/game exec wrangler deployments list --name gantt-quest-game
  ```
  ```bash
  pnpm --filter @gantt-quest/game exec wrangler rollback <version-id> --name gantt-quest-game -m "why"
  ```
  This is instant and goes back to an earlier uploaded version, including its static assets.
- **What a rollback does not undo:**
  - **D1 migrations.** Rolled-back code runs against the new schema, which is why migrations must be additive. To undo the data itself, use Time Travel:
    ```bash
    wrangler d1 time-travel restore DB --env production --bookmark <bookmark>
    ```
    This throws away **every** write since that bookmark, players' progress included. The CI job logs a bookmark just before it migrates. By hand, take one with `wrangler d1 time-travel info DB --env production`.
  - **Durable Object migrations.** Cloudflare won't roll back past a version that added a DO class (a new migration tag). Roll forward instead.
  - **DO storage.** Voyages, huts and pub tables already saved by newer code stay saved. Older code has to tolerate state it doesn't know about.
  - **Secrets and the custom domain.** A rollback leaves both untouched.
- **Turn production off completely:** remove the custom domain in the dashboard (Workers > gantt-quest-game > Domains), or deploy with the `routes` entry taken out. The old game at the legacy domain is not affected either way.

## 7. Deploying after launch (CI)

`.github/workflows/deploy-game.yml` deploys `apps/game` by doing the steps above in order:

1. write the config;
2. unit tests;
3. take a D1 bookmark;
4. migrate, and confirm the newest migration is recorded;
5. build with `CLOUDFLARE_ENV`;
6. deploy;
7. smoke test.

What starts it:

- **Production:** push a tag `game-v*`, for example
  ```bash
  git tag game-v2026.11.12 origin/overworld-revamp && git push origin game-v2026.11.12
  ```
  Or use a manual run once the workflow is on `main`, since GitHub only lists manual workflows from the default branch.
- **Staging:** a manual run. Or set the repo variable `GAME_STAGING_AUTODEPLOY=true` and it deploys on every push to `overworld-revamp` that touches the game. It's off by default so hand deploys keep working.
- Before the first CI production run:
  - create the GitHub Environment `production` with yourself as a required reviewer (Settings > Environments), so every production run waits for your approval;
  - set `WRANGLER_GAME_CONFIG` (section 3).

The workflow has not run yet. The first real test is a manual staging run.

## 8. Risk review (what assumes staging)

Checked in the code on 2026-11-12:

- **No hard-coded hosts.** No `heylets.party`, `harbor-staging` or `workers.dev` appears anywhere in `apps/game/src`. The client calls relative `/api/*` paths and same-origin WebSockets.
- **Cookies are fine for production.**
  - `gq_session` is host-only (no `Domain`), so staging and production sessions are separate.
  - It is `HttpOnly`, `SameSite=Lax`, and `Secure` whenever the request is HTTPS.
- **`MAIL_FROM_ADDRESS` is a var**, not a constant. The template sets it per environment, and staging's old placeholder `noreply@yourdomain.com` is gone. With no `EMAIL` binding, codes are written to the log rather than failing, so a misconfigured production would *look* fine but nobody could sign in. Check the email step of the smoke test.
- **Dev-only overrides are gated by `import.meta.env.DEV`**, which Vite sets to `false` in a build:
  - `__gqTime` and `__gqWeather` (`render/ambience.ts`);
  - `?salesman=` and `__gqSalesman` (`salesmanClock.ts`, and server-side `server/salesman.ts`);
  - `window.__gq`, `__harbor`, `__hut` and `__pub`.

  None of them reach production.
- **`?p=` / `x-gq-profile`** (a separate guest per tab) is not dev-gated. It only names a different cookie, so it grants nothing, but it is how one person makes many guests. It's harmless on its own; see the AI costs below.
- **Admins:** `ADMIN_EMAILS` is per Worker, so production starts with no admins until the secret is set. Content overrides are per database, so staging's edits don't carry over. Use the admin page's Export → Import to copy them.
- **Production is only reachable on its domain** (`workers_dev: false`, `preview_urls: false`). Staging keeps its `workers.dev` address.

### AI_MODE and costs

Production runs `AI_MODE: "live"` on `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, the largest model in use. Calls come from:

- one story per voyage (`generateFill`);
- each NPC reply in a voyage (`npcTurn`);
- each epilogue;
- **each barkeep line** (`POST /api/pub/talk`).

Every call has a `max_tokens` cap. When a call fails (an outage, or the account's allocation running out), the game falls back to canned text, so a cap on spend can't break play.

What's missing: **any per-player or per-day limit**. Sign-in is an ungated guest account. Anyone with the URL can:

1. make a guest;
2. found a crew;
3. post to `/api/pub/talk` in a loop.

Each post is a 70B call, and `?p=` makes new guests trivial. The same goes for NPC talk inside a voyage. Before announcing the URL publicly:

1. **Add a rate limit** to `/api/pub/talk` and the voyage `npc_call` path. The Workers Rate Limiting binding is the easiest, keyed by player id, for example 10 per minute. Optionally add a per-crew daily count in D1, with canned replies once it's spent.
2. **Set a spend alert** in the Cloudflare dashboard (Billing > Notifications) for Workers AI. Workers AI has no hard cap you can set; the free daily allocation is shared across the account (equipflow and the other Workers too).
3. **Consider a WAF rate-limiting rule** on `harbor.heylets.party/api/auth/*`. Email codes already have a 30-second cooldown per address and an attempt limit, but nothing stops one client requesting codes for many addresses, which can hurt the sending domain's reputation.

None of these block a soft launch to a small, known group. All three should be in place before the link goes anywhere public.
