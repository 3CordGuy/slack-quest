# Curated Battlefield Art

The hex-combat canvas renders an AI-generated terrain image as the ground layer behind the grid. By default that art is generated on the worker via Cloudflare Flux (`@cf/black-forest-labs/flux-1-schnell`) on first cache miss per scene, cached forever in R2. This document covers the **curated drop-in path**: hand-supply your own art (e.g. Gemini "Nano Banana", Midjourney, Stable Diffusion) and override the Flux output per scene.

## When to curate

- Flux's terrain stylization for a particular scene reads weak.
- You want a specific painted look (Ghibli, neon noir, hand-drawn dungeon map) that the per-scene Flux prompt isn't nailing.
- You're polishing a launch and need every battlefield to look intentional.

## Scenes

The six themed scenes ([apps/web/src/ai.ts:520](../apps/web/src/ai.ts#L520)):

| Scene key | Vibe |
|---|---|
| `server_catacomb` | Stone catacomb floor crossed with ethernet cables and embedded circuit fragments |
| `cubicle_forest` | Office floor reclaimed by nature — cracked carpet tiles, twisting roots, moss |
| `warehouse_floor` | Polished concrete, painted lane lines, faint tire scuffs, sodium glow |
| `fluorescent_office` | Grey low-pile carpet tiles, scattered paper, coffee rings, cyan tint |
| `neon_basement` | Polished dark concrete with purple/magenta neon reflections, painted glyphs |
| `deadline_dungeon` | Torch-lit flagstones, scattered parchment, sticky notes pinned to stone |

## R2 key format

Each scene's image lives at exactly this object key in the `ART` R2 bucket (binding name `ART`, bucket name `gantt-quest-assets`):

```
art/battlefield/v3/<scene>.png
```

The version segment is `BATTLEFIELD_ART_VERSION` in [apps/web/src/ai.ts](../apps/web/src/ai.ts) and is bumped when the per-scene prompts change shape. Curating against the current version means your drops survive every redeploy until the next version bump.

Examples:

- `art/battlefield/v3/server_catacomb.png`
- `art/battlefield/v3/cubicle_forest.png`
- `art/battlefield/v3/deadline_dungeon.png`

## Image spec

| Field | Value |
|---|---|
| Format | PNG |
| Aspect | The canvas itself fills the screen, but the visible grid is roughly 9 columns × 11 rows pointy-top. Source the image at something tile-able like 1024×1280 or 1280×1280 so the terrain fills the canvas without obvious bands when cropped. |
| Camera | Strict top-down orthogonal (looking straight down). NO horizon line, NO sky, NO buildings rising above the floor. |
| Subject | Just the ground. No characters, no creatures, no pawns. |
| Lighting | Even diffused. Soft shadows only — strong directional light fights the hex overlay. |
| Frame | Edge-to-edge content. No vignette, no border, no name plate, no center focal point. |
| File size | ≤ 1.5 MB recommended. The image draws at ~40% alpha behind the hex grid; oversampling beyond ~2 MP is wasted bandwidth. |

The matching style anchor used by the Flux prompts is `BATTLEFIELD_STYLE_ANCHOR` in [apps/web/src/ai.ts](../apps/web/src/ai.ts). When prompting an external model, mirror the anchor: "Studio Ghibli style hand-painted top-down battlefield ground texture", "STRICT TOP-DOWN ORTHOGONAL VIEW", "NO horizon line, NO sky, NO characters", "EVEN DIFFUSED LIGHTING", "tiles seamlessly outward".

## Upload commands

### Via wrangler CLI (recommended)

From the repo root, ensure your `wrangler.toml` / login is pointing at the correct Cloudflare account, then:

```sh
# One scene at a time
wrangler r2 object put gantt-quest-assets/art/battlefield/v3/server_catacomb.png \
  --file ./local-art/server_catacomb.png \
  --content-type image/png

# Loop over a directory of curated PNGs (zsh / bash)
for f in ./local-art/*.png; do
  scene=$(basename "$f" .png)
  wrangler r2 object put "gantt-quest-assets/art/battlefield/v3/${scene}.png" \
    --file "$f" \
    --content-type image/png
done
```

### Via Cloudflare dashboard

1. Cloudflare dashboard → R2 → `gantt-quest-assets`
2. Navigate to `art/battlefield/v3/` (create the folder if it doesn't exist yet)
3. Upload your PNGs with filenames exactly matching the scene key (e.g. `cubicle_forest.png`)

### Verifying

After upload, a HEAD request via the public asset URL should return 200:

```sh
curl -I https://gantt-quest-web.workers.dev/img/art/battlefield/v3/server_catacomb.png
```

The image will appear on the next combat in that scene — no server restart needed. The worker's `getOrScheduleBattlefieldArt` HEAD-checks R2 first and returns the cached URL unchanged; only on miss does it schedule a fresh Flux generation.

## Fallback behavior

You don't have to curate every scene. The system gracefully falls back:

| State | What happens |
|---|---|
| Curated PNG present at `art/battlefield/v3/<scene>.png` | Used directly, no Flux call |
| Scene has no curated drop yet, no Flux cache yet | First combat returns null background → canvas renders with no ground layer; Flux generation kicks off in the background; next combat in that scene uses the Flux result |
| Scene has no curated drop, Flux already cached the v3 generation | Flux image used (the curated drop overrides any prior Flux output only if you delete the existing R2 object first or upload over it) |

To **replace** a Flux-generated scene with curated art that already exists at v3, the simplest path is `wrangler r2 object put …` against the same key — it overwrites.

## Reverting a curated drop

To remove a curated image and let Flux regenerate:

```sh
wrangler r2 object delete gantt-quest-assets/art/battlefield/v3/<scene>.png
```

Next combat in that scene will HEAD-miss → schedule a fresh Flux generation → serve null this once → cache the new Flux output → all subsequent combats use it.

## Version bumps

If `BATTLEFIELD_ART_VERSION` is later bumped from `v3` → `v4` (e.g. the prompts or aspect change again), your curated drops at `art/battlefield/v3/...` keep living in R2 but are no longer read. You can either:

- Copy them forward: `wrangler r2 object put gantt-quest-assets/art/battlefield/v4/<scene>.png --file <pulled-from-v3>`
- Or let Flux regenerate v4 from scratch, then curate over those if needed.

Old version keys can be safely deleted to reclaim storage once the version isn't referenced anywhere.
