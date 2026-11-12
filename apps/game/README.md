# Gantt Quest — overworld game (`apps/game`)

The rewrite described in [`docs/overworld-revamp.md`](../../docs/overworld-revamp.md): a live, turn-based co-op game. A crew shares **the Harbor** (a walkable place where you see each other), up to four of them board a ship and sail to **an Island** (one seeded hex map with one generated story), talks to Workers AI characters, fights line-up battles, and brings XP and loot home.

This app is separate from `apps/web` (the existing game), with its own Worker, Durable Object and D1 database. Nothing here is deployed yet.

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

A hand-deployed test copy runs as the `gantt-quest-game-staging` Worker with its own D1 database and live Workers AI. It is defined as the `staging` environment in `wrangler.jsonc` (put the real database id in your local, gitignored copy).

```bash
pnpm --filter @gantt-quest/game exec wrangler d1 migrations apply DB --remote --env staging
CLOUDFLARE_ENV=staging pnpm --filter @gantt-quest/game build
pnpm --filter @gantt-quest/game exec wrangler deploy
```

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
| `apps/game/src/worker.ts` | Harbor HTTP API and the WebSocket route |
| `apps/game/src/server/run-room.ts` | One Durable Object per voyage: persist, broadcast, timers |
| `apps/game/src/server/harbor-room.ts` | One Durable Object per crew: presence, walking, chat, dock board |
| `apps/game/src/server/ai.ts` | Prompts and the Workers AI calls (and the mock) |
| `apps/game/src/server/db.ts` | D1 access |
| `apps/game/src/server/email.ts` | Sending sign-in codes |
| `apps/game/src/client/render/` | Three.js island renderer and placeholder sprites |
| `apps/game/src/client/*.tsx` | Character creation, crew gate, shared Harbor, inventory, market stall and in-voyage HUD (React) |
| `apps/game/src/client/itemArt.ts` | Pixel-art item icons drawn in code, in the style of the hero sprites; the accent colour is the item's rarity |

## Rules worth knowing before changing things

- **The model never changes the game.** It returns words plus a *proposed* intent. `validateIntent` checks that intent against the NPC's capability list in the story bible; anything else is dropped. New NPC powers are added as capabilities and verbs in `packages/world`, not as prompt text.
- **What an NPC asks for is a fixed list too.** Demands live on the story frame (`packages/world/src/story.ts`) so the game can always tell whether one is met. Don't let prompt text introduce new requests.
- **The reducer is the authority.** Clients send intents; the Durable Object runs `stepWorld`. The acting hero is taken from the socket, never from the message.
- **Everything random goes through the seeded RNG in `WorldState`.** No `Math.random` in `packages/world`; a run must replay from its seed and action log.
- **D1 is the system of record.** The Durable Object caches state and reloads it after hibernation. Persist before broadcast. Timers are DO Alarms.
- **Rewards are written as they are earned**, so a dropped run never loses loot. Defeat costs a capped amount of gold and nothing else.

## Tests

```bash
pnpm --filter @gantt-quest/world test
pnpm --filter @gantt-quest/world typecheck
pnpm --filter @gantt-quest/game typecheck
```

In dev builds the page exposes `window.__gq` (`state`, `send`, and the `World` module) on a voyage and `window.__harbor` in the Harbor, for driving either from the console.

## Known gaps in milestone 1

- Placeholder art: sprites are drawn in code (`render/sprites.ts`), props are primitive shapes.
- One story frame, one talkable NPC, three hero classes.
- Battle numbers are not tuned; a focused party can stun-lock the boss.
- Battle events animate in sequence but HP bars jump to the final value.
- Huts are plots only: no interiors, decorating or upgrades yet, and only the first 12 crew members get one drawn.
- The Harbor's only shop is the market stall (gear). No smithy, potions or provisioning yet. Crew chat is not stored.
- Gear has no affixes, uniques, sets or elements.
- No production deploy and no CI deploy. Staging is deployed by hand; production needs a workflow change and review.
