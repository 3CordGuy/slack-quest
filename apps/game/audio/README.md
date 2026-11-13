# Audio

This folder holds the WAV masters for the game's sound. The engine that plays them is in [`src/client/audio`](../src/client/audio); the file you edit to say what plays when is [`manifest.ts`](../src/client/audio/manifest.ts).

## Adding a sound

1. Bounce a WAV into this folder. Its path without the extension is its name: `sfx/footsteps/stone_04.wav` is `sfx/footsteps/stone_04`.
2. Point at it from the manifest. An event's `files` can end in `*`, so `sfx/footsteps/stone_*` picks up every take in that folder with no further edit.
3. With `pnpm dev:game` running, the game plays the WAV as it is. Overwriting a file or saving the manifest is heard at once, with no reload.

The top folder decides how a file is encoded: `music/`, `ambience/`, `sfx/` or `ir/` (impulse responses). Sounds placed in the world should be mono.

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
| `weather.thunder` | Lightning strikes in a storm. A storm is its own weather: heavy rain with thunder, where a downpour is heavy rain without. The flash on screen follows the loudness of the take that plays, so bounce each strike, crack and rumble together, as one take: `sfx/weather/thunder_01.wav`, `thunder_02.wav`, and so on. |
| `stinger.battle_start`, `stinger.victory`, `stinger.defeat`, `stinger.fled`, `stinger.ambush`, `stinger.voyage_won`, `stinger.voyage_lost` | Musical stings. |

Ability, class, enemy and trait names are lower case with underscores (`Aimed Shot` is `aimed_shot`). While developing, the browser console says once which names were asked for and found nothing, and `pnpm test` fails if the manifest has an event name the game never asks for.

## Loops

A loop goes round between its loop markers if the WAV has them (the `smpl` chunk most DAWs can embed), else the region given in the manifest (`loop: { start, end }`), else the whole file. Anything before the loop start is an intro, heard once.

Compressed files carry a little padding at each end, so for a loop that must be seamless, bounce it with a second of its own tail before the start and a second of its head after the end, mark the inner region as the loop, and set `startAt: "loop"`.

Each scene (`harbor`, `hut`, `pub`, `sailing`, `island`, `battle`, `spar`, `title`) names one music loop and any number of atmosphere loops. Moving between scenes crossfades; a loop that both scenes share keeps playing.

## Indoors

A scene can be inside another:

```ts
pub: { inside: { of: "harbor", cutoff: 700, gainDb: -3 } },
```

Walking in, the Harbor's music, atmosphere and sea carry on without a break, with a high cut at `cutoff` Hz and `gainDb` quieter, as heard through the walls. Walking out opens them up again. The sea loses its direction indoors.

A building's own sound goes in the same scene and is heard clean over the muffled outside: `ambience: ["pub_crowd"]`. Giving the scene its own `music` replaces the music from outside (`music: null` for none), while the outside atmosphere stays, muffled.

## Following the sky

The game keeps these values up to date, and any loop's level can follow one:

| Parameter | Range |
|---|---|
| `night` | 0 in full day to 1 in deep night |
| `rain` | 0 dry to 1 pouring |
| `storm` | 0 in any other weather to 1 in a full storm (heavy rain with thunder). A downpour without thunder leaves it at 0 |
| `time` | The time of day: 0 midnight, 0.25 dawn, 0.5 noon, 0.75 dusk |
| `shore` | How far you stand from the nearest water, in hexes: 0 at the edge, a large number with none in reach |

All but `shore` describe the sky outside and hold indoors too, so a hut can have rain on its roof. A curve is a list of `[value, level]` points joined by straight lines, with level 0 silent and 1 full:

```ts
night: { file: "ambience/forest_night", follow: { param: "night", curve: [[0.3, 0], [0.7, 1]] } },
```

`follow` can also be a list, and the levels multiply. This bed fades in at night and dips 3 dB at the water's edge, back to full two hexes inland:

```ts
follow: [{ param: "night", curve: [[0.3, 0], [0.7, 1]] }, { param: "shore", curve: [[0.5, 0.7], [2, 1]] }],
```

A bed whose curve has it at silence is not played, or held in memory, until the curve brings it up.

A day takes ten minutes. To hear a moment without waiting, type `__gqTime = 0.8` (dusk) or `__gqWeather = 1` (rain) in the browser console; `delete __gqTime` hands it back to the clock. `__gqStorm = 1` with `__gqWeather = 1` is a storm. The sky controls in the engine readout do the same with buttons.

## Stems

A loop can carry `layers`: stems that start on the same sample as its main file and stay locked to it. Bounce them the same length. Each can follow a parameter, which is how one piece of music changes from day to night:

```ts
harbor: {
  file: "music/harbor",
  layers: [{ file: "music/harbor_night", follow: { param: "night", curve: [[0.3, 0], [0.8, 1]] } }],
},
```

Every stem is held decoded in memory (about 23 MB a minute in stereo), so keep them few and no longer than they need to be.

## Memory

Every loop that is playing is held fully decoded: about 23 MB for each minute of stereo, whatever the file's own sample rate or bit depth (the engine runs at 48 kHz). A three-minute stereo bed is 74 MB. The engine readout shows the total. Phones start to struggle past roughly 100 MB, so loop length is the thing to watch:

- Loops for emitters (fire, the sea) are folded to mono when loaded, which halves them.
- Beds at silence are not loaded.
- A loop is let go as soon as nothing is playing it.

## Resting between plays

Give a piece a `gap` and it stops looping: it plays through from the top, is silent for that many seconds, then plays again. The town music does this, so the Harbor has two minutes of atmosphere alone between plays:

```ts
harbor: { file: "music/harbor", gap: 120 },
```

A range rests a different length each time: `gap: [120, 240]`. With a gap the whole file is one play, so loop markers are not used, and other music cannot come in on its bar. Scenes that share the piece (the Harbor, the hut, the pub) share its rest. If you leave while it is resting and come back, it waits out what is left; if you leave while it is playing, it starts from the top when you return. The engine readout shows how long a resting piece has left.

## Switching on the bar

Give music its `bpm` (and `beatsPerBar` if not 4), and music that replaces it can set `enter: "bar"` or `enter: "beat"` to come in on its next bar or beat line instead of at once. Bars are counted from the start of the file (or from the loop start with `startAt: "loop"`), so start loops on a bar line and make them whole bars long.

## Sounds placed in the world

You are the listener: sounds are heard from where your hero stands, and left and right follow the camera, so a fire on the right of the screen is in the right speaker however the view is turned. A placed sound gets quieter with distance, loses its top end, and moves to its side; close by, it stays near the middle.

One-shots are placed automatically: other heroes' footsteps and every blow in a fight play from where they happen. Your own footsteps are not placed.

`emitters` in the manifest are loops that play from things on the map:

| Emitter | Where |
|---|---|
| `fire` | Every campfire, fireplace and stove |
| `candle`, `lamp` | Every candle; every lantern |
| `sea` | The water as a whole: louder toward the shore, from the side it lies on, and all around you when it surrounds you |

```ts
fire: { file: "ambience/fire", gainDb: -6, ref: 1.5, max: 12, voices: 3 },
```

`ref` is the distance within which it is at full level and `max` the distance past which it is silent, in map units (a hex is about 1.7 across). Only the nearest `voices` sources sound at once, each starting the loop at a different point so they do not phase. A stereo file is folded to mono when it is loaded. They follow the Atmosphere slider.

Players choose how placed sounds are rendered with **Headphones (3D sound)** in the Sound panel. On (the default), the browser places them around the head (HRTF): up the screen is in front of you, down it is behind. Off, sounds are panned between two speakers. Level and dulling with distance are the same either way.

## Reverb

A one-shot is heard in the reverb of the place you are in if its event sets `reverb`, its send level in dB:

```ts
"footstep.cobble": { files: "sfx/footsteps/stone_*", reverb: -6 },
```

Events without it stay dry, which is right for stings and interface sounds. Music and atmosphere are never sent.

`reverbs` names each reverb and its impulse response, a WAV under `ir/`, with `gainDb` for the level of its return. `zones` says which is heard where: the ground underfoot decides first, then the scene, then `default`. Use `null` for no reverb.

```ts
reverbs: { woods: { file: "ir/woods", gainDb: -5 }, room: { file: "ir/room", gainDb: -3 } },
zones: {
  ground: { forest: "woods" },
  scene: { hut: "room" },
  default: "open",
},
```

Moving from one zone to another crossfades the two over a second, once you have been in the new one for a moment. The return comes back into the Sound effects group, so that slider turns the room down along with the sounds in it. Impulse responses can be mono or stereo; the browser evens out their loudness, so set the level with `gainDb`.

## The engine readout

While developing, the Sound panel has **Show engine readout**: the scene, the ground and reverb zone, the sky values, where the sea is, the level of every loop, stem and emitter voice, the one-shots sounding, and how much decoded audio is in memory. `__gqAudio.debug()` in the browser console gives the same as data.

## The mix

`mix` in the manifest holds, for Master, Music, Atmosphere and Sound effects, where the player's slider starts (`volume`, 0–1) and your own trim in dB (`trimDb`), which players never see. Only sliders a player has moved are saved, so changing a default or a trim reaches everyone who has not.

## Shipping

```bash
pnpm --filter @gantt-quest/game audio:build
```

encodes every master to Ogg Opus and AAC in `public/audio`, and writes `public/audio/index.json`. It needs [ffmpeg](https://ffmpeg.org/download.html) on your PATH. Commit `public/audio`: the deployed game plays only what is there. Until this has been run, the deployed game is silent.

To hear what the encoding did before committing it, open the engine readout in the Sound panel and switch **Playing** from *Masters (WAV)* to *Encoded (as shipped)*. Playing loops restart from the other source, so you can go back and forth. Sounds that are still placeholders are silent on the encoded side, since placeholders are never encoded. The bitrates are the `RATES` table at the top of `scripts/audio/build.ts`; change one and run `audio:build` again.
