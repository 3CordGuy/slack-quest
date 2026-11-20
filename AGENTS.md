# Notes for agents working on this repo

The game is **The Harbor of Heylets** in `apps/game`, with its rules in `packages/world` and `packages/core`. The [root README](README.md) says how to run it, test it and ship a change; [`apps/game/README.md`](apps/game/README.md) says where each piece of code lives. Read those before changing things. This file only holds what agents have got wrong before.

## Release notes for the notice board

Players read what changed in each release on the Harbor's notice board, and a tab left open on an older build lists the same notes under "What's in this release?" when a newer one is out. **Nobody writes those notes at release time. They are read out of git when the game is built**, so they are only as good as the commits on `main`. Writing them is part of every PR that changes the game, and checking them is part of every release.

How it works (`apps/game/scripts/release-notes.ts`):

- Every `game-v*` tag is a release. Its notes are the commits on `main` between it and the tag before it.
- A commit makes one line when it changes code that ships: `apps/game/src`, `apps/game/public`, `apps/game/audio`, `apps/game/index.html`, `packages/world/src` or `packages/core/src`, tests left out. Docs, CI, scripts and test-only commits make none.
- The line is the commit's **subject**, without the `(#123)`. `Felling: chops cut a notch` shows as **Felling:** Chops cut a notch.
- `Release-note:` lines in the commit **message** replace the subject: each one is a line on the board, and `Release-note: skip` leaves the commit off the board.
- The tag's own message is not read. Neither is the GitHub release: the production deploy writes that from the same notes, so do not edit it by hand.

### When you open or merge a PR

PRs are squash-merged, so one PR is one commit on `main`, and so one entry on the board.

1. **Give the PR a title a player would understand**, as `Area: what changed`. The title becomes the squash commit's subject. (A PR with a single commit takes that commit's subject instead, so write that the same way.)
2. **If one line is not enough, or the title has to be technical, add `Release-note:` lines to a commit message on the branch**, one per change a player would notice:
   ```
   Release-note: Fishing: a perfect catch pays a little more
   Release-note: Pub: the dice table seats four
   ```
   The squash commit's message is every commit message on the branch joined together. The PR description is **not** part of it, so a trailer written only there is lost.
3. **Use `Release-note: skip` only when the whole PR changes nothing a player can notice** (a refactor, a dev tool, a test helper that lives in `src`). Because the messages are joined, a `skip` on any one commit hides the entire PR, whatever its title says. This is how Atlas (#500) and class abilities (#494) never reached the board: a commit inside each said `skip`. For a commit inside a larger PR that players should hear about, leave the trailer off.
4. **Before merging, read the commit messages on the branch for stray trailers**: `git log origin/main..HEAD --format=%B | grep -i '^Release-note:'`. If you merge from the command line you can set the message yourself and be sure: `gh pr merge --squash --subject "Area: what changed (#123)" --body "Release-note: …"`.

### When you cut a release

1. On a checkout of the commit you are about to tag, with tags fetched (`git fetch origin --tags`), print what the board will say:
   ```bash
   node --experimental-strip-types apps/game/scripts/release-notes.ts --unreleased
   ```
   The first entry, `next-<sha>`, is the release you are about to cut; if there is none, nothing since the last tag makes a line. Staging shows the same list on its notice board as "Coming next".
2. Read it as a player. Every change they would notice since the last tag should have a line, and no line should be about code.
3. If a line is missing or reads badly, fix it in `apps/game/scripts/release-note-overrides.ts`: an entry keyed by the full hash of the commit on `main`, holding the lines to show instead (an empty list hides the commit). Merge that to `main` first, then tag the new tip. A merged commit cannot be reworded any other way.
4. Tag and push (the README has the naming). The production deploy builds the board from git, and its last job, "GitHub release notes", writes the tag's GitHub release from the same notes. A release whose commits make no lines shows as "Fixes and small changes behind the scenes."

### What a good note looks like

- **Written for players.** Say what they can now do or will now see, not what the code does. "Rename yourself from your hero sheet", not "Add PATCH /api/character/name".
- **One line per change they would notice.** A big PR gets several `Release-note:` lines; a fix gets one. Do not list the steps you took.
- **Plain words.** No file names, function names, PR numbers or internal terms. Prefer the plain genre word to a nautical or invented one ("Slowed", not "Becalmed").
- **Start with the area**, one to three words and a colon: `Fishing:`, `Fights:`, `Sea bag:`, `Pub:`. Use an area the board already has where one fits.
- **Short.** One sentence, no full stop needed. If it needs an "and also", it is two notes.
- **A fix says what is right now**, not what was broken in the code: "A dead enemy's hex is free the moment it dies".

## Before you commit a game change

- Try it in the browser in local dev first (reload, a second player with `?p=2`, a phone-sized window), and list what you checked in the PR.
- Run `pnpm --filter @gantt-quest/game typecheck` and `pnpm --filter @gantt-quest/game test` (and the same for `@gantt-quest/world` if you touched the rules).
- `apps/game/wrangler.jsonc` is local and gitignored. CI writes it from the `WRANGLER_GAME_CONFIG` secret, so a new binding, variable or Durable Object also needs that secret updated by the repo owner before it deploys.
- Pushing a `game-v*` tag deploys to production with no approval step. Do not push one unless you were asked to release.
