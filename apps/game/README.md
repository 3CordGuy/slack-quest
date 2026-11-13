# The Harbor of Heylets (`apps/game`)

The rewrite described in [`docs/overworld-revamp.md`](../../docs/overworld-revamp.md): a live, turn-based co-op game. A crew shares **the Harbor** (a walkable place where you see each other), up to four of them board a ship and sail to **an Island** (one seeded hex map with one generated story), talks to Workers AI characters, fights line-up battles, and brings XP and loot home.

This app is separate from `apps/web` (the original game), with its own Worker, Durable Objects and D1 database. It's live at https://harbor.heylets.party, with staging at https://harbor-staging.heylets.party. For setting up and deploying production, see [`docs/game-production-checklist.md`](../../docs/game-production-checklist.md); the [root README](../../README.md) has the deploy steps for both.

## Run it locally

No Cloudflare resources are needed.

```bash
pnpm install
cp apps/game/wrangler.example.jsonc apps/game/wrangler.jsonc
pnpm --filter @gantt-quest/game db:migrate:local
pnpm --filter @gantt-quest/game dev
```

Open http://localhost:5180, create a character and found a crew. To play two players on one machine, open a second tab at http://localhost:5180/?p=2 — the `p` parameter gives that tab its own guest account — and join the crew with its invite code. Background tabs do not animate (browsers pause rendering), so bring a tab to the front to watch it.

### Email sign-in

Players start as guests and can attach an email to keep their character. Locally there is no mail binding, so the six-digit code is printed in the dev server's output as `[email/dev] to=… Your Gantt Quest sign-in code is …`. Use any made-up address.

To send real mail (staging does), the environment needs a `send_email` binding named `EMAIL` and a `MAIL_FROM_ADDRESS` var on a domain onboarded for Email Sending; see the staging block in `wrangler.example.jsonc`.

### AI: mock or live

`AI_MODE` in `wrangler.jsonc` controls the model calls.

- `"mock"` (the default in the example): a scripted stand-in. Stories come from the canned fills in `packages/world/src/story.ts`; the NPC is a deliberately gullible script that proposes whatever your words suggest, so you can watch the server-side guard rails refuse it.
- `"live"`: real Workers AI. Requires `wrangler login`. AI bindings always call the remote service, so this uses your account's Workers AI allocation.

## Staging

A test copy runs as the `gantt-quest-game-staging` Worker with its own D1 database and live Workers AI. It is defined as the `staging` environment in `wrangler.jsonc` (put the real database id in your local, gitignored copy).

CI deploys it on every merge to `main` that touches the game, and production from a `game-v*` tag after a reviewer approves; the root README has the steps. To deploy staging by hand instead (the fallback):

```bash
pnpm --filter @gantt-quest/game exec wrangler d1 migrations apply DB --remote --env staging
CLOUDFLARE_ENV=staging pnpm --filter @gantt-quest/game build
pnpm --filter @gantt-quest/game exec wrangler deploy
```

Apply the migrations first and confirm they are recorded (`SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1`) before deploying, so new code never runs against the old schema. A new Durable Object class (as `PubRoom` was) also needs its binding and a migration tag in your local `wrangler.jsonc`, for each environment.

Build before deploying: `wrangler deploy` ships whatever the last build produced, for whichever environment it was built for. Sign-in is an ungated guest account, so anyone with the URL can use the Workers AI allocation.

## Where things live

| Path | What |
|---|---|
| `packages/world/src/` | All game rules. Pure and deterministic, no I/O. Start here. |
| `…/world.ts` | The world reducer: `stepWorld(state, action)` → new state, events, effects |
| `…/battle.ts` | Line-up combat reducer |
| `…/check.ts` | The one roll mechanic (`rollCheck`) used by attacks, persuasion, searching and movement |
| `…/map.ts` | Island generation and weighted pathfinding |
| `…/story.ts` | Story frames, the story bible, and its validators |
| `…/npc.ts` | Parsing and validating what the model proposes |
| `…/view.ts` | What a client is allowed to see (hides the lair, NPC secrets, RNG) |
| `…/harbor.ts` | The Harbor map, path check and message types |
| `…/gear.ts` | Slots, rarities, item generation, armor, prices and the stall's stock |
| `…/hut.ts`, `…/hutroom.ts` | Hut materials, furnishings, tiers and perks; the walk-in room, placement and its message types |
| `…/drops.ts` | Materials, blueprints, decor and trophies paid out by fights, caches and a won story |
| `…/contracts.ts` | Notice-board contracts and the crew's weekly goal |
| `…/hero.ts` | A hero as the battle rules see one; shared by voyages and the sparring ring |
| `…/gather.ts` | Fishing, felling and the quarry: outings, timing, payouts, stamina and resting |
| `…/grove.ts` | Felling's grove: where a felled tree comes down (wind, fall lines, the creek and the pile) |
| `…/projects.ts` | Crew projects (the lighthouse and those still to open) |
| `…/pub.ts` | The pub's room, menu and food-and-drink boosts |
| `…/dice.ts`, `…/shoals.ts` | The pub's two table games, each a pure reducer with a per-player view |
| `…/trade.ts` | Offers between crewmates and their validation |
| `apps/game/src/worker.ts` | Harbor HTTP API and the WebSocket route |
| `apps/game/src/server/run-room.ts` | One Durable Object per voyage: persist, broadcast, timers |
| `apps/game/src/server/harbor-room.ts` | One Durable Object per crew: presence, walking, chat, dock board |
| `apps/game/src/server/hut-room.ts` | One Durable Object per hut owner: presence, walking, chat and furniture |
| `apps/game/src/server/pub-room.ts` | One Durable Object per crew for the pub: presence, walking, chat and the game tables |
| `apps/game/src/server/stake-table.ts` | A game table for any stake game: antes, prize, per-player views, forfeits |
| `apps/game/src/server/gather.ts`, `projects.ts`, `trade.ts` | D1 work for gathering and resting, crew projects, and trading |
| `apps/game/src/server/board.ts` | Contract results and crew-goal progress in D1 |
| `apps/game/src/server/ai.ts` | Prompts and the Workers AI calls (and the mock) |
| `apps/game/src/server/db.ts` | D1 access |
| `apps/game/src/server/email.ts` | Sending sign-in codes |
| `apps/game/src/client/render/` | Three.js renderer, placeholder sprites, furniture models (`props.ts`), the sky, weather, shadows and moving decoration (`ambience.ts`), and the felling grove (`GroveStage.ts`, its own small scene drawn full screen behind the gather panel) |
| `apps/game/src/client/*.tsx` | Character creation, crew gate, shared Harbor, huts, the pub, notice board (`board/`), works (`works/`), sparring, gathering, trading, inventory, market stall, the crossing, fight pacing (`BattleBeats.tsx`) and the in-voyage HUD (React) |
| `apps/game/src/client/itemArt.ts` | Pixel-art item icons drawn in code, in the style of the hero sprites; the accent colour is the item's rarity |

## Rules worth knowing before changing things

- **The model never changes the game.** It returns words plus a *proposed* intent. `validateIntent` checks that intent against the NPC's capability list in the story bible; anything else is dropped. New NPC powers are added as capabilities and verbs in `packages/world`, not as prompt text.
- **What an NPC asks for is a fixed list too.** Demands live on the story frame (`packages/world/src/story.ts`) so the game can always tell whether one is met. Don't let prompt text introduce new requests.
- **The reducer is the authority.** Clients send intents; the Durable Object runs `stepWorld`. The acting hero is taken from the socket, never from the message.
- **Everything random goes through the seeded RNG in `WorldState`.** No `Math.random` in `packages/world`; a run must replay from its seed and action log.
- **D1 is the system of record.** The Durable Object caches state and reloads it after hibernation. Persist before broadcast. Timers are DO Alarms.
- **Rewards are written as they are earned**, so a dropped run never loses loot. Defeat costs a capped amount of gold and nothing else.
- **Hut furniture is in one catalogue.** `FURNISHINGS` (`packages/world/src/hut.ts`) says what each piece is: `size: "small"` for things that go anywhere in a hex or on a top, `surface` for a top small things can stand on, `light` for a candle, lamp or fire, and `storage` for how many slots a container has. The server checks placement with `placeProblem` and `smallPlaceProblem`, and the client uses the same rules to tint the ghost of the piece being carried. A model in `render/props.ts` must match its catalogue `surface`. Indoors there is one shadow-casting fire light and four plain lights, shared by whichever lit pieces are nearest the camera, so the light count never changes.

## Tests

```bash
pnpm --filter @gantt-quest/world test
pnpm --filter @gantt-quest/world typecheck
pnpm --filter @gantt-quest/game typecheck
pnpm --filter @gantt-quest/game test
```

The game's own tests (`apps/game/test/`) run the trading server code against SQLite with the migrations applied, using Node's built-in `node:sqlite` as a stand-in for D1.

In dev builds the page exposes `window.__gq` (`state`, `send`, and the `World` module) on a voyage and `window.__harbor` in the Harbor, for driving either from the console. Set `window.__gqTime` to a number from 0 to 1 to pin the time of day (0 is midnight, 0.5 is noon), and `window.__gqWeather` from 0 (clear) to 1 (heavy rain) to pin the weather. The pub and huts expose `window.__pub` and `window.__hut` the same way. `window.__gqWorld` is the world renderer and `window.__gqGrove` the felling grove while it is open; each has `renderer.info.render.calls` for draw calls.

## Known gaps

- Art is drawn in code: sprites in `render/sprites.ts`, props from simple shapes. Admins can recolour sprites and swap item icons from `#admin`.
- Four story frames, with one talkable islander per story.
- Balance has a seeded simulation (`packages/world/src/balance.ts`), but real play will still need tuning.
- The Harbor has twelve plots: a crew larger than that can't all own one.
- The Galley project is still locked. Crew chat isn't stored.
- The doom clock doesn't allow for time lost to fog and roaming bands.
- Timing in fishing, felling and the quarry trusts the client's reported moment within a round trip, so a script can always hit dead centre (capped at +20% a roll, and a felled tree falling true).
- The world renderer has no pause, so it keeps drawing underneath the full-screen felling grove.
- Gear has no affixes, uniques, sets or elements.
- Felling's sounds are synth stand-ins until recordings are added under `sfx/gather/` (see `audio/manifest.ts`).
