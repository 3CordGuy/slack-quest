# Audio

This folder holds the WAV masters for the game's sound. The engine that plays them is in [`src/client/audio`](../src/client/audio); the file you edit to say what plays when is [`manifest.ts`](../src/client/audio/manifest.ts).

## Adding a sound

1. Bounce a WAV into this folder. Its path without the extension is its name: `sfx/footsteps/stone_04.wav` is `sfx/footsteps/stone_04`.
2. Point at it from the manifest. An event's `files` can end in `*`, so `sfx/footsteps/stone_*` picks up every take in that folder with no further edit.
3. With `pnpm dev:game` running, the game plays the WAV as it is. Overwriting a file or saving the manifest is heard at once, with no reload.

The top folder decides how a file is encoded: `music/`, `ambience/` or `sfx/`. Sounds placed in the world should be mono.

The WAVs here are not committed (they are in `.gitignore`). What ships is the encoded copy made in the last step below.

## Placeholders

```bash
pnpm --filter @gantt-quest/game audio:placeholders
```

writes a rough synthesized stand-in for every file the starter manifest names, so the engine can be heard before the real sounds exist. It never overwrites a file of yours, and placeholders are never shipped. Replace one by bouncing your own file to the same path.

## What the game asks for

The game asks for sounds by name, most specific first, and plays the first one the manifest has files for. A hit with Firebolt asks for `impact.firebolt`, then `impact.magic`, then `impact`. Start with the general names and add specific ones when you want them.

| Name | When |
|---|---|
| `footstep.<ground>` → `footstep` | A foot lands. Ground is `plains`, `forest`, `hills`, `cobble`, `dock`, `mud`, `floor`, `rampart`. |
| `attack.<ability>` → `attack.<melee\|ranged\|magic>` → `attack` | An attack sets off. |
| `impact.<ability>` → `impact.<style>` → `impact` | A blow lands. `impact.crit` is laid over it on a perfect roll. |
| `miss.<ability>` → `miss.<style>` → `miss` | An attack misses. |
| `hero.<class>.<attack\|hurt\|down>` → `hero.<…>` | A hero's voice. |
| `enemy.<kind>.<attack\|hurt\|down>` → `enemy.<…>` | An enemy's voice, such as `enemy.wolf.attack`. |
| `heal.<ability>` → `heal`, `heal.fail` | A heal lands, or fails. |
| `effect.<effect>` → `effect`, `tick.<effect>` → `tick` | An effect takes hold; bleeding or burning ticks. |
| `down`, `flee.ok`, `flee.fail`, `trait.<trait>` → `trait` | Someone goes down; a flee; a class trait kicks in. |
| `turn.yours`, `level_up`, `gold`, `loot.<rarity>` → `loot`, `key_item`, `pickup.<resource>` → `pickup`, `forage.<kind>` → `forage`, `search.found`, `search.empty`, `rest`, `discover` | Moments on a voyage, heard only by the hero they belong to. |
| `stinger.battle_start`, `stinger.victory`, `stinger.defeat`, `stinger.fled`, `stinger.ambush`, `stinger.voyage_won`, `stinger.voyage_lost` | Musical stings. |

Ability, class, enemy and trait names are lower case with underscores (`Aimed Shot` is `aimed_shot`). While developing, the browser console says once which names were asked for and found nothing, and `pnpm test` fails if the manifest has an event name the game never asks for.

## Loops

A loop goes round between its loop markers if the WAV has them (the `smpl` chunk most DAWs can embed), else the region given in the manifest (`loop: { start, end }`), else the whole file. Anything before the loop start is an intro, heard once.

Compressed files carry a little padding at each end, so for a loop that must be seamless, bounce it with a second of its own tail before the start and a second of its head after the end, mark the inner region as the loop, and set `startAt: "loop"`.

Each scene (`harbor`, `hut`, `pub`, `sailing`, `island`, `battle`, `spar`, `title`) names one music loop and any number of atmosphere loops. Moving between scenes crossfades; a loop that both scenes share keeps playing.

## The mix

`mix` in the manifest holds, for Master, Music, Atmosphere and Sound effects, where the player's slider starts (`volume`, 0–1) and your own trim in dB (`trimDb`), which players never see. Only sliders a player has moved are saved, so changing a default or a trim reaches everyone who has not.

## Shipping

```bash
pnpm --filter @gantt-quest/game audio:build
```

encodes every master to Ogg Opus and AAC in `public/audio`, and writes `public/audio/index.json`. It needs [ffmpeg](https://ffmpeg.org/download.html) on your PATH. Commit `public/audio`: the deployed game plays only what is there. Until this has been run, the deployed game is silent.
