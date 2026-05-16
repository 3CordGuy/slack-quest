// Workers AI helpers. Uses Llama 3.1 8B Instruct — cheap, plenty good for flavor text.

import type { Character, DungeonGraph, DungeonNode, DungeonObject, LootOption, MonsterSpec, SceneJson } from "@gantt-quest/db";
import { fallbackMonsterName, fallbackSceneText, rollItem } from "@gantt-quest/core";

const MODEL = "@cf/meta/llama-3.1-8b-instruct";

// Smaller, faster model used for the lightweight identity step (just picks a
// name + HP, no prose). Llama 3.2 3B Instruct returns in roughly half the time
// of the 8B model — meaningful win when step 1 is the latency floor for
// standard/boss quest builds. The 8B is still used for the SCENE step and all
// the other prose-generating helpers (loot flavor, victory flavor, etc.).
const FAST_MODEL = "@cf/meta/llama-3.2-3b-instruct";

interface AiRunResponse {
  response?: string;
}

export type SceneVariant = "standard" | "boss" | "gauntlet-wave";

// Optional surface for monster-portrait generation. When passed to
// generateOpeningScene, the worker will fire a flux-1-schnell call in parallel
// with the scene-text step and persist the PNG in R2. Decoupled from the Env
// shape on purpose — keeps ai.ts free of the index.ts type cycle.
export interface ArtTarget {
  bucket: R2Bucket;
  baseUrl: string; // e.g. "https://gantt-quest.3cordguy.workers.dev"
}

// Two-step opening-scene generation:
//   1. generateMonsterIdentity → picks MONSTER_NAME + MONSTER_HP (small prompt,
//      tight output)
//   2a. generateSceneForMonster → writes the SCENE with the chosen name forced
//       as explicit input
//   2b. generateMonsterArt (optional) → flux-1-schnell portrait, cached in R2
//
// Steps 2a and 2b run in parallel — both depend only on the identity output,
// so we don't pay double latency. Art is fail-soft: any error returns null and
// the scene renders without an image block.
//
// Eliminates the name/scene mismatch class of bugs by construction — the scene
// prompt sees the name as input, never invents one. Pays an extra AI call per
// scene-gen, but each call is smaller than the old single-call combined output,
// so total token cost is roughly equivalent.
export async function generateOpeningScene(
  ai: Ai,
  character: Pick<Character, "name" | "class" | "level">,
  elite: boolean,
  variant: SceneVariant = "standard",
  waveContext?: { wave: number; total: number },
  avoidNames: string[] = [],
  art?: ArtTarget,
  // When provided (e.g. by Job Board acceptance), the seed name overrides
  // the AI's identity step — the quest's monster is forced to BE the name
  // the player just clicked. HP is still rolled randomly within the
  // variant's range. Used to make Job Board postings real promises instead
  // of marketing chrome.
  seedName?: string,
): Promise<SceneJson> {
  const baseTier = Math.max(1, character.level + (elite ? 1 : 0));
  const tier = variant === "boss" ? baseTier + 1 : baseTier;

  // Boss has roughly 1.8x the HP ceiling; gauntlet wave is standard.
  const baseFloor = 8 + tier * 4;
  const baseCeil = baseFloor + 12;
  const monsterHpFloor = variant === "boss" ? Math.floor(baseFloor * 1.8) : baseFloor;
  const monsterHpCeil = variant === "boss" ? Math.floor(baseCeil * 1.8) : baseCeil;

  // Step 1: pick a name + HP. When a seed name is provided we skip the
  // identity AI call entirely (saves a call, locks in the Job Board
  // promise) and roll HP randomly within the same range.
  const identity = seedName
    ? { name: seedName, hp: monsterHpFloor + Math.floor(Math.random() * (monsterHpCeil - monsterHpFloor + 1)) }
    : await generateMonsterIdentity(
        ai, variant, monsterHpFloor, monsterHpCeil, avoidNames, waveContext,
      );
  // Steps 2a + 2b in parallel. Art may be undefined when caller didn't provide
  // a target (e.g. test paths) or returns null on failure.
  const [scene, artUrl] = await Promise.all([
    generateSceneForMonster(ai, identity.name, character, elite, variant, waveContext),
    art ? generateMonsterArt(ai, art, identity.name, variant, tier) : Promise.resolve(null),
  ]);

  const result: SceneJson = {
    monster_name: identity.name,
    monster_hp: identity.hp,
    monster_max_hp: identity.hp,
    tier,
    scene,
  };
  if (artUrl) result.monster_art_url = artUrl;
  return result;
}

// Bumped when we change the art prompt or model so old cached portraits are
// orphaned (gracefully — old quests still reference older URLs which 404, and
// the image block silently fails to render). Increment when iterating on
// style.
//
// History:
//   v1 — generic 90s MTG oil painting; flux frequently fell back to default
//        "fantasy creature" rather than interpreting the dev-themed name.
//   v2 — explicit "depict the name LITERALLY" instruction; pushes flux to read
//        names like "Sprint Saboteur" or "Bias Bug" as direct subjects.
//   v3 — break the name into component words + show the action; drop the
//        "fantasy creature" framing that biased flux toward generic warriors.
//        A "Sprint Saboteur" should now be someone visibly sabotaging a sprint
//        (race / scrum board), not a winged spear-warrior.
//   v4 — embrace the trading-card frame instead of fighting it. Flux was
//        ignoring the "no border" instruction anyway, and the rendered card
//        chrome (name plate, mana cost, frame) commits fully to the bit.
//        Garbled card text is on-brand for the "1992 amateur misprint" vibe.
//   v5 — drop the trading-card framing; keep the painterly 90s style. Switch
//        the style anchor from "MTG card" to "Elmore/Easley D&D module
//        illustration" — same painterly vibe + period, but doesn't drag in
//        card chrome (frame, name plate, mana cost). Just the artwork.
//   v6 — switch from Elmore/Easley oil painting to Studio Ghibli hand-drawn
//        anime watercolor style. Warmer, brighter, more expressive. Applies
//        to view banners, NPCs, merchants, traps, characters, lockboxes —
//        every surface that uses STYLE_ANCHOR.
const ART_VERSION = "v6";

// Monster portraits use a separate version so we can iterate on the monster-
// specific look (lighter lighting, more PM/dev scene context) without
// invalidating every other surface (NPCs, merchants, view banners, etc.)
// that's already cached and looking right at v5.
//
//   v6 — first attempt at lighter / more dev-themed setting via an OVERLAY
//        added after STYLE_ANCHOR. Didn't land — the global anchor's "TSR
//        D&D module cover" + "dim moody lighting" biases were too strong
//        and flux kept defaulting to dim dungeon. Overlay read as advice.
//   v7 — full replacement of STYLE_ANCHOR with a monster-specific one (no
//        overlay). The corporate-fantasy office setting + bright lighting
//        are now FIRST-class anchor terms, baked in alongside the painterly
//        90s style — not appended after a competing anchor.
//   v8 — Studio Ghibli style replaces the painterly oil-on-canvas. Hand-
//        drawn anime watercolor, soft cel-shading, warm cinematic lighting.
//        Corporate-fantasy office-dungeon setting preserved.
const MONSTER_ART_VERSION = "v8";

// Slug for the R2 key. Lowercase a-z0-9 only, hyphenated, capped to 60 chars
// to keep keys reasonable. Two different monsters with the same name (rare,
// avoid-list usually prevents it) will share art — that's fine.
function slugifyMonsterName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "unnamed";
}

// Common style anchor used by every generated piece in the bot — monster
// portraits AND singleton view banners (inventory, shop, etc.). Keeping this
// in one place is what makes the whole UI feel like a single illustrated
// artifact rather than "fantasy bot with mismatched headers."
//
// Style: Studio Ghibli / Hayao Miyazaki. Hand-drawn anime watercolor with
// soft cel-shading, warm cinematic lighting, saturated colors, and the
// dreamlike whimsy typical of films like Spirited Away, My Neighbor
// Totoro, Howl's Moving Castle, and Princess Mononoke. Replaces the
// earlier Elmore/Easley oil-painting anchor — same painterly quality,
// but warmer, brighter, and more expressive.
const STYLE_ANCHOR =
  "Studio Ghibli style hand-drawn anime illustration — watercolor textures, soft cel-shading, warm cinematic lighting, vibrant saturated colors, painterly brushwork, atmospheric and dreamlike. The kind of art you'd find in a Hayao Miyazaki film like Spirited Away, My Neighbor Totoro, or Howl's Moving Castle. Gentle, whimsical, expressive composition.";

// Negative prompt fragment shared across all surfaces — keeps the output as
// pure illustration rather than a UI element with text/borders/logos.
const NEGATIVES =
  "edge-to-edge painted illustration, no card frame, no name plate, no border, no text, no logos, no UI elements";

// Prompts for singleton view banners (inventory, shop, treasure, etc.). Each
// renders the same image every time — generated once on first cache miss,
// then served from R2 forever. The keys are stable across deploys so a
// version bump (in ART_VERSION) is what invalidates them.
//
// Style is appended (not inlined) so iterating on STYLE_ANCHOR re-shapes every
// view consistently without per-prompt edits.
export const VIEW_ART_PROMPTS = {
  // The /sq inventory header — adventurer's pack contents on display.
  inventory:
    "An adventurer's open leather pack laid out on a wooden table, contents spilling: a few potion vials with cork stoppers, a rolled scroll, a worn dagger, a small coin pouch, leather-bound journal. Warm candlelight, top-down 3/4 view. Single still-life composition.",

  // The /sq shop header — channel-shop interior. Pushed explicitly toward
  // "merchant / curio shop with commerce signaling" because the earlier
  // generic-interior prompt got rendered as a craft workshop (workbench,
  // tools) rather than a place to buy things. Key renamed from `shop` to
  // `channel_shop` to bust the stale cached image without bumping the
  // global ART_VERSION (which would re-gen every other banner too).
  channel_shop:
    "Interior of a bustling fantasy curio shop. A friendly shopkeeper smiling behind a polished wooden COUNTER with a brass ring-up bell, ready to serve customers. Shelves behind the counter stocked with neatly labeled corked potion bottles bearing handwritten price tags, weapons hung on display racks, scrolls in cubby holes, jewelry under a glass case. Hanging sign with a coin-and-key logo over the door. Warm lantern light, dust motes in the air. This is a SHOP for buying goods — not a workshop, not a forge, not a workbench. The mood is welcoming commerce.",

  // Mid-dungeon treasure chamber (final-room reward, no monster).
  treasure:
    "A heavy ornate chest sits open in the middle of a dim stone chamber, golden light spilling out from inside. Old coins and folded fabric visible. Flagstone floor, faint cobwebs in corners. Single dramatic chest as the focal point.",

  // The dungeon merchant — singleton image used until per-encounter art lands.
  merchant:
    "A hooded fantasy merchant standing behind a portable wooden stall in a dim dungeon corridor. Goods displayed: vials, a coiled rope, two weapons, a small wooden box. Single lantern hanging above. Mysterious mood, face partially shadowed.",

  // Lockbox tier variants — three separate keys, three separate images.
  // Same chest archetype but the chrome scales with tier (rougher iron for
  // bronze, ornate brass for silver, gilded gold-leaf for gold).
  lockbox_bronze:
    "A small iron-banded wooden chest with a heavy bronze padlock, sitting in a dim stone alcove. Plain rivets and worn iron straps. Dust and cobwebs around the edges. Single chest, focal-point composition.",
  lockbox_silver:
    "An ornate dark-wood chest reinforced with engraved silver bands and a heavy filigreed silver padlock, sitting in a dim stone alcove. Detailed metalwork, slight tarnish. Single chest, focal-point composition.",
  lockbox_gold:
    "A lavishly ornate chest covered in gold-leaf engraving with a massive jeweled gold padlock, sitting on a stone pedestal in a dim chamber. Faint glow from cracks in the lid, polished gilt highlights. Single chest, focal-point composition.",

  // Per-class character portraits — rendered on /sq sheet. Each prompt
  // captures the class's engineering-themed identity literally (yaml runes
  // for DevOps, regression-suite halo for QA, etc.). Three-quarter portrait
  // composition keeps every class consistent in framing for a unified
  // "character roster" feel.
  class_devops_mage:
    "Three-quarter view portrait of a fantasy wizard in deep robes, hands wreathed in glowing arcane sigils that resemble stylized YAML brackets and container icons, summoning a translucent ethereal box of code. Single figure, dim arcane chamber, dramatic lighting.",
  class_qa_paladin:
    "Three-quarter view portrait of a heavily armored paladin holding a glowing greatsword inscribed with intricate runes, light pouring from the blade onto small bug-like creatures cowering at her feet. Single figure, holy chamber, dramatic lighting.",
  class_backend_druid:
    "Three-quarter view portrait of a bearded druid in green robes with vines running through his hair, kneeling beside a luminous tree whose roots form a network of tabular database glyphs. Single figure, mossy underground grove, dappled magical light.",
  class_frontend_bard:
    "Three-quarter view portrait of an elaborately dressed bard playing a stringed instrument that emits cascading streams of colored pixels and ribbons. Adoring townsfolk in the background. Single figure, warm tavern light, vibrant.",
  class_staff_sage:
    "Three-quarter view portrait of an elderly sage in deep blue robes hunched over a massive ancient tome on a heavy oak desk, surrounded by piles of scrolls and a guttering candle. Single figure, candlelit study, somber mood.",
  class_refactor_rogue:
    "Three-quarter view portrait of a hooded rogue in dark leathers with twin daggers drawn, mid-shadow-step, tangled fragments of broken ghostly code dissolving at her feet. Single figure, dim alley, dramatic shadow.",
  class_sre_warden:
    "Three-quarter view portrait of a grim heavily-armored warrior in dented plate, standing on a great wall, looking out over a howling formless void of swirling chaos. Single figure, dawn light, stoic mood.",
  class_data_warlock:
    "Three-quarter view portrait of a pact-bound warlock in tattered dark robes with glowing eyes, reading from an unholy grimoire whose pages writhe with arcane SQL-like characters and dark tendrils of energy. Single figure, candlelit ritual chamber, sinister atmosphere.",

  // Town overview — the hub map view rendered behind /sq town. Wide
  // village-establishing shot, NOT an interior. Buildings labeled or
  // distinct enough that the location buttons below feel like they map
  // to real places.
  town_overview:
    "A small fantasy village at golden hour, panoramic establishing view from a low hillside. A timbered tavern with a hanging sign, a stone temple with a bell-tower, a job-board kiosk at the village square, a smith's forge with smoke rising, an inn with warm lit windows. Cobblestone path winding between them. A few villagers in middle distance. Cozy, lived-in, welcoming.",

  // Pub interior — the /sq pub banner. Single warm-lit tavern shot.
  // Avoids close-up portraiture of a specific NPC since the bartender
  // and regulars are textually described and rotate weekly.
  pub_interior:
    "Interior of a cozy fantasy tavern at evening. Sturdy wooden bar with polished brass rail and rows of corked bottles on shelves behind. A few barrels stacked at one end, a hearth crackling at the back, two or three rough wooden tables with high-backed chairs. Lantern light, warm wood tones, hint of pipe smoke. No specific people in close-up — the room is the subject, intimate but not crowded.",

  // Smithy interior — the /sq smithy banner. Workshop shot, anvil at the
  // center, glowing forge in the background. No specific smith figure
  // (textual description handles their personality), but tools + sparks
  // sell the "this is where you upgrade gear" idea.
  smithy_interior:
    "Interior of a fantasy blacksmith's workshop. A large iron anvil at center stage with a half-finished sword resting on it. A glowing red-orange forge behind, embers visible. Walls hung with hammers, tongs, files, and a few finished weapons and pieces of armor on display. Sparks frozen in the air, leather apron draped over a wooden stool. Warm fire-light, smoke in the rafters. The room is the subject; no specific smith figure in close-up.",

  // Inn interior — the /sq inn banner. Cozy lodging shot. Multiple beds
  // hint at the room-tier mechanic (cot vs. private room) without
  // committing to one specific layout. Hearth + lanterns sell the
  // "warm safe space between quests" idea.
  inn_interior:
    "Interior of a cozy fantasy inn's main room. Two simple straw cots against one wall, a curtained private bed-alcove against the other. A small stone hearth in the corner with a kettle hanging over the fire. Wooden ceiling beams, a few hung lanterns casting warm orange light, a small rug on the plank floor. Quiet, restful, safe. No specific people in close-up — the room is the subject.",
} as const;

// Builds the full R2 key + the composed prompt for a given view-art short
// key. Centralized so getOrScheduleViewArt and pregenAllViewArt stay in
// sync (both must use the same key path or the cache won't line up).
function viewArtKeyAndPrompt(shortKey: string, rawPrompt: string): { key: string; fullPrompt: string } {
  return {
    key: `art/views/${ART_VERSION}/${shortKey}.png`,
    fullPrompt: `${rawPrompt} ${STYLE_ANCHOR} ${NEGATIVES}`,
  };
}

// Lazy fetch + generate for singleton/static view art. Returns the public URL
// when the image is in R2 already; on cache miss, schedules generation via
// ctx.waitUntil and returns null so the caller can render WITHOUT the image
// this one time. Subsequent calls hit the cache.
//
// This is the function to use for any view that always renders the same image
// (inventory header, shop banner, lockbox-tier chest art, etc.). For per-name
// art (monsters, eventually merchants/NPCs), use generateAndCacheArt directly
// with a name-based key — those callers want to await the result so the URL
// can be stored in the scene/node.
export async function getOrScheduleViewArt(
  ai: Ai,
  art: ArtTarget,
  ctx: ExecutionContext,
  shortKey: string,    // e.g. "inventory" — gets prefixed/versioned automatically
  prompt: string,      // raw subject prompt; STYLE_ANCHOR + NEGATIVES are appended
): Promise<string | null> {
  const { key, fullPrompt } = viewArtKeyAndPrompt(shortKey, prompt);
  const publicUrl = `${art.baseUrl}/img/${key}`;

  try {
    const existing = await art.bucket.head(key);
    if (existing) return publicUrl;
  } catch (err) {
    // R2 head error — fall through to the lazy-gen path. If gen also fails,
    // we return null and the caller skips the image.
    console.warn("view-art:head-error", { shortKey, err: err instanceof Error ? err.message : String(err) });
  }

  // Cache miss — schedule generation as background work and return null this
  // call. The next render hits the cache. Players never wait for first-gen.
  ctx.waitUntil(generateAndCacheArt(ai, art, key, fullPrompt, `view:${shortKey}`));
  return null;
}

// Pre-generate every view-art image so the first player to hit each surface
// sees the banner immediately. Cache-aware — already-rendered keys no-op
// (one R2 head check each). Sequential rather than parallel to avoid
// hammering Workers AI rate limits in a single burst. Returns a per-key
// summary so the caller can see what was generated vs cached vs failed.
export async function pregenAllViewArt(
  ai: Ai,
  art: ArtTarget,
): Promise<Array<{ shortKey: string; status: "cached" | "generated" | "failed"; url: string | null }>> {
  const results: Array<{ shortKey: string; status: "cached" | "generated" | "failed"; url: string | null }> = [];
  for (const shortKey of Object.keys(VIEW_ART_PROMPTS)) {
    const prompt = VIEW_ART_PROMPTS[shortKey as keyof typeof VIEW_ART_PROMPTS];
    const { key, fullPrompt } = viewArtKeyAndPrompt(shortKey, prompt);
    const publicUrl = `${art.baseUrl}/img/${key}`;
    try {
      const existing = await art.bucket.head(key);
      if (existing) {
        results.push({ shortKey, status: "cached", url: publicUrl });
        continue;
      }
    } catch {
      // Treat head failure as miss — generation will surface the real error.
    }
    const url = await generateAndCacheArt(ai, art, key, fullPrompt, `view:${shortKey}`);
    results.push({
      shortKey,
      status: url ? "generated" : "failed",
      url,
    });
  }
  return results;
}

// Monster-specific style anchor — REPLACES the global STYLE_ANCHOR for
// monster art (not layered after it). v8 swaps the Larry-Elmore oil-painting
// anchor for a Studio Ghibli hand-drawn watercolor style, while keeping the
// corporate-fantasy office-dungeon SETTING that v7 established. Same
// monster-as-literal-name-interpretation; same office/PM scene cues; the
// rendering style is what changed.
const MONSTER_STYLE_ANCHOR =
  "Studio Ghibli style hand-drawn anime illustration — watercolor textures, soft cel-shading, vibrant saturated colors, expressive painterly brushwork. The kind of frame you'd see in a Hayao Miyazaki film (Spirited Away / Princess Mononoke / Howl's Moving Castle). SETTING: a corporate-fantasy hybrid world where adventurers fight in a half-stone half-office workplace dungeon. The environment is a high-tech office crossed with a stone keep — warm natural daylight, soft desk lamps, glowing computer monitors lighting the scene. Gantt charts and burndown graphs are pinned to stone walls. Sticky notes and kanban-board cards cover desks. Server racks hum in alcoves. Coffee cups, ergonomic keyboards, mechanical office gear, ethernet cables, and scattered scrolls of printout code are visible in the background. LIGHTING IS BRIGHT, WARM, AND DREAMLIKE — not dim, not shadowy, not dungeon-gloomy. The monster is clearly lit and expressive against the busy office-dungeon backdrop. Whimsical creature design, gentle melancholy or wonder typical of Ghibli antagonists.";

// Generates a small monster portrait via flux-1-schnell, persists to R2,
// returns the public URL. R2-keyed by name slug so the same monster always
// shows the same picture (and quickly serves from cache on repeats).
//
// Cached under MONSTER_ART_VERSION (separate from ART_VERSION) so we can
// iterate on the monster look — lighting, scene context, etc. — without
// invalidating the rest of the bot's art (NPCs, merchants, view banners).
//
// Fail-soft: any error returns null. The caller's scene still renders, just
// without an image block. We never block a quest on art.
// Returns a size descriptor phrase based on monster tier/level, used to
// convey scale in the image prompt. Higher tiers produce larger, more
// imposing creatures so players can read danger at a glance.
function monsterSizeHint(tier: number): string {
  if (tier <= 3) return "small creature, could fit in your palm, non-threatening, tiny";
  if (tier <= 6) return "medium-sized creature, about knee-height, slightly menacing";
  if (tier <= 9) return "human-sized creature, clearly dangerous and imposing";
  if (tier <= 14) return "large creature, larger than a human, hulking and fearsome";
  return "massive hulking creature, towers over humans, terrifying presence";
}

async function generateMonsterArt(
  ai: Ai,
  art: ArtTarget,
  monsterName: string,
  variant: SceneVariant,
  tier = 1,
): Promise<string | null> {
  const slug = slugifyMonsterName(monsterName);
  const key = `art/${MONSTER_ART_VERSION}/${slug}.png`;

  const sizeHint = monsterSizeHint(tier);
  const variantHint =
    variant === "boss"
      ? ` dramatic boss creature, looming, more imposing composition, ${sizeHint},`
      : variant === "gauntlet-wave"
      ? ` a single creature, mid-tier henchman energy, ${sizeHint},`
      : ` a single creature, fantasy interpretation, ${sizeHint},`;

  // SUBJECT is the literal noun phrase from the monster's name. We separate it
  // from the style deliberately — flux's default fantasy-art training pulls
  // every prompt toward "armored warrior" unless we explicitly tell it the
  // subject is a depicted scene of the name's meaning.
  //
  // Few-shot examples give flux a concrete pattern for "break compound name
  // into parts → show the action." Kept varied (insect / scene / object) so
  // flux doesn't anchor on one archetype.
  const subject =
    `ILLUSTRATION SUBJECT: depict "${monsterName}" — break the name into its words and paint a scene that shows that exact thing happening or being.` +
    ` Treat the name as a literal noun phrase to illustrate, NOT as a fantasy warrior's title.` +
    ` Examples of the approach: "Bias Bug" = a literal beetle with a skewed/lopsided body; "Race Condition" = two figures colliding mid-stride at a finish line; "Scope Overlord" = a giant figure looming over a tiny worker buried in scrolls.` +
    `${variantHint}`;

  // Order matters: SUBJECT first (defines what's painted), then the monster-
  // specific anchor (painterly 90s style + corporate-fantasy setting +
  // bright office lighting, all baked in as primary terms — not overlaid
  // after a competing global anchor), then NEGATIVES.
  const prompt = `${subject} ${MONSTER_STYLE_ANCHOR} ${NEGATIVES}`;
  return generateAndCacheArt(ai, art, key, prompt, `monster:${monsterName}`);
}

// Wounded / phase-2 variant of a monster portrait. Same name, same slug,
// distinct cache key (`-p2`) so the original phase-1 portrait isn't
// overwritten. Prompt layers wounded/enraged/desperate cues onto the
// existing literal-name interpretation — flux paints the same creature
// but bloodied. Shares MONSTER_ART_VERSION with phase-1 so a prompt
// iteration invalidates both halves together.
//
// Returns null on any failure; caller falls back to the phase-1 portrait.
export async function generateMonsterArtPhase2(
  ai: Ai,
  art: ArtTarget,
  monsterName: string,
): Promise<string | null> {
  const slug = slugifyMonsterName(monsterName);
  const key = `art/${MONSTER_ART_VERSION}/${slug}-p2.png`;

  const subject =
    `ILLUSTRATION SUBJECT: depict "${monsterName}" — same creature interpretation as before but now BADLY WOUNDED, half-dead and ENRAGED.` +
    ` Bloodied, scarred, eyes burning with desperate fury, posture lower and more dangerous, tattered, scorched. Half their health gone, fighting like a cornered animal.` +
    ` Treat the name as a literal noun phrase to illustrate.` +
    ` Examples of the approach: "Bias Bug" = a bloodied beetle missing a leg; "Race Condition" = two collided figures, one dragging the other forward in fury.` +
    ` A single creature, dramatic looming composition,`;

  // Phase-2 inherits the same monster anchor — bright office-dungeon setting
  // and corporate-fantasy backdrop — so the wounded variant stays in the
  // same visual world instead of reverting to a generic dim dungeon.
  const prompt = `${subject} ${MONSTER_STYLE_ANCHOR} ${NEGATIVES}`;
  return generateAndCacheArt(ai, art, key, prompt, `monster-p2:${monsterName}`);
}

const ROOM_ART_VERSION = "v1";

// Generates a dungeon room illustration for the graph dungeon. Cached per
// room slug so the same room always shows the same picture after its first
// visit. Room art is intentionally lazier than monster art — we don't need
// the full monster-subject breakdown, just a scene impression.
//
// Key is stable: room-slug + dungeon-theme-slug, versioned by ROOM_ART_VERSION.
// Returns null on any failure; caller skips the image block.
export async function generateRoomArt(
  ai: Ai,
  art: ArtTarget,
  roomId: string,
  roomName: string,
  roomDescription: string,
): Promise<string | null> {
  const slug = slugifyMonsterName(`${roomId}-${roomName}`);
  const key = `art/rooms/${ROOM_ART_VERSION}/${slug}.png`;

  const subject =
    `ILLUSTRATION SUBJECT: a dungeon room called "${roomName}". Scene: ${roomDescription.slice(0, 200)}.` +
    ` Wide establishing shot, no characters, environment only.`;

  const prompt = `${subject} ${MONSTER_STYLE_ANCHOR} ${NEGATIVES}`;
  return generateAndCacheArt(ai, art, key, prompt, `room:${roomName}`);
}

// Personality traits injected into the character portrait prompt to push
// flux toward a unique emotional/postural read per roll. One is picked
// randomly so two characters of the same class look distinct — different
// expression, stance, or aura even when the class descriptor is identical.
const CHARACTER_TRAITS = [
  "battle-worn and world-weary, thousand-yard stare",
  "bright-eyed and eager, barely containing nervous energy",
  "cocky and self-assured, slight smirk, chin raised",
  "haunted and intense, shadowed eyes, coiled tension",
  "cheerful and irreverent, slightly disheveled",
  "stoic and unreadable, arms crossed, jaw set",
  "curious and distracted, peering at something just off-frame",
  "exhausted but resolute, mid-breath, gear askew",
  "calm and meditative, serene half-smile",
  "fierce and focused, eyes locked forward, weapons at the ready",
];

// Per-class scene descriptors used by the per-character portrait prompt.
// These are stripped-down versions of the singleton class_* banners — same
// archetypal visual language, but written so the character's NAME can be
// dropped in as the literal subject. The singleton banners stay as a fast
// fallback while a fresh per-character gen runs in the background.
const CLASS_DESCRIPTOR: Record<string, string> = {
  devops_mage:
    "Wizard in deep robes, hands wreathed in glowing arcane sigils that resemble stylized YAML brackets and container icons, summoning a translucent ethereal box of code. Dim arcane chamber, dramatic lighting.",
  qa_paladin:
    "Heavily armored paladin holding a glowing greatsword inscribed with intricate runes, light pouring from the blade onto small bug-like creatures cowering at the feet. Holy chamber, dramatic lighting.",
  backend_druid:
    "Bearded druid in green robes with vines running through hair, kneeling beside a luminous tree whose roots form a network of tabular database glyphs. Mossy underground grove, dappled magical light.",
  frontend_bard:
    "Elaborately dressed bard playing a stringed instrument that emits cascading streams of colored pixels and ribbons. Adoring townsfolk in the background. Warm tavern light, vibrant.",
  staff_sage:
    "Elderly sage in deep blue robes hunched over a massive ancient tome on a heavy oak desk, surrounded by piles of scrolls and a guttering candle. Candlelit study, somber mood.",
  refactor_rogue:
    "Hooded rogue in dark leathers with twin daggers drawn, mid-shadow-step, tangled fragments of broken ghostly code dissolving at the feet. Dim alley, dramatic shadow.",
  sre_warden:
    "Grim heavily-armored warrior in dented plate, standing on a great wall, looking out over a howling formless void of swirling chaos. Dawn light, stoic mood.",
  data_warlock:
    "Pact-bound warlock in tattered dark robes with glowing eyes, reading from an unholy grimoire whose pages writhe with arcane SQL-like characters and dark tendrils of energy. Candlelit ritual chamber, sinister atmosphere.",
};

// Per-character portrait. Cached in R2 keyed by the character-name slug, so
// every roll gets a unique image — even two players who roll the same class
// see different portraits. Names with epithets ("Fenel the Deprecated",
// "Brudor the Halflinter") feed the same literal-name interpretation we use
// for monsters: flux reads the words as visual cues.
//
// Generation is lazy. On cache miss we schedule the gen via ctx.waitUntil
// and return the class-singleton banner as a placeholder so the first view
// of /sq sheet shows *something* while the unique portrait renders. The
// next view picks up the cached unique image.
//
// Returns null when neither the per-character nor the class-fallback art
// exists (e.g. IMAGE_BASE_URL unset, or class doesn't have a descriptor).
export async function getOrScheduleCharacterArt(
  ai: Ai,
  art: ArtTarget,
  ctx: ExecutionContext,
  character: { name: string; class: string; gender?: "m" | "f" | null },
  classId: string,
): Promise<string | null> {
  const slug = slugifyMonsterName(character.name);
  const charKey = `art/${ART_VERSION}/character/${slug}.png`;
  const charUrl = `${art.baseUrl}/img/${charKey}`;

  try {
    const existing = await art.bucket.head(charKey);
    if (existing) return charUrl;
  } catch (err) {
    console.warn("character-art:head-error", { name: character.name, err: err instanceof Error ? err.message : String(err) });
  }

  // Cache miss — fire the per-character gen as background work.
  const descriptor = CLASS_DESCRIPTOR[classId] ?? "Adventurer in fantasy attire, dramatic lighting.";
  // Pick a random personality trait so two same-class rolls look distinct —
  // different expression, stance, or aura. The trait is seeded by the
  // character name's first byte so regenerations are stable for the same
  // name, but different names (almost always) draw different traits.
  const traitIdx = character.name.charCodeAt(0) % CHARACTER_TRAITS.length;
  const trait = CHARACTER_TRAITS[traitIdx];
  // Anchor gender so regenerations of the same character don't swing between
  // male and female interpretations. Empty hint for legacy nulls lets flux
  // pick freely.
  const genderHint = character.gender === "m"
    ? " The character is MALE."
    : character.gender === "f"
    ? " The character is FEMALE."
    : "";
  const subject =
    `Single-figure character portrait of "${character.name}", a fantasy ${character.class}.${genderHint}` +
    ` Personality and bearing: ${trait}.` +
    ` Treat the character name (especially any epithet like "the Patient" or "Stack-Cleaver") LITERALLY — interpret what the words suggest about appearance, posture, gear, scars, or aura.` +
    ` ${descriptor}` +
    ` Three-quarter view, RPG fantasy art style, single character against a moody background.`;
  const prompt = `${subject} ${STYLE_ANCHOR} ${NEGATIVES}`;
  ctx.waitUntil(generateAndCacheArt(ai, art, charKey, prompt, `character:${character.name}`));

  // Fallback to the class-singleton banner while the unique gen runs. We
  // head-check it too so a missing fallback (e.g. brand-new class without a
  // pre-warmed banner) doesn't surface as a broken Slack image block.
  const fallbackKey = `art/views/${ART_VERSION}/class_${classId}.png`;
  try {
    const existing = await art.bucket.head(fallbackKey);
    if (existing) return `${art.baseUrl}/img/${fallbackKey}`;
  } catch {
    // Fall through — render no image this time.
  }
  return null;
}

// Per-trap-room art. Each trap has a unique AI-generated scene description
// ("a mangled mess of wires and code", "a pit of stale config files", etc.),
// and we cache by a slug derived from the first ~80 chars of that scene so
// the cache key is stable across renders of the same trap.
//
// Subject is the scene itself — we feed flux the description verbatim and
// ask it to paint the literal contents. Same Elmore/Easley anchor for
// stylistic unity. Returns null on failure; caller skips the image block.
export async function generateTrapArt(
  ai: Ai,
  art: ArtTarget,
  scene: string,
): Promise<string | null> {
  // Slug from the leading scene words — stable for the same trap, varies
  // across traps. Capped to 60 chars by slugifyMonsterName.
  const slug = slugifyMonsterName(scene.slice(0, 80));
  const key = `art/${ART_VERSION}/trap/${slug}.png`;

  const subject =
    `ILLUSTRATION SUBJECT: a fantasy dungeon trap scene, depicting LITERALLY the following description: "${scene}"` +
    ` Render exactly what's described — show the trap's machinery, hazards, and tension visually. No people in the foreground, focus on the dangerous device or environmental hazard.` +
    ` Single-scene composition, dim claustrophobic dungeon corridor, dramatic shadows, sense of imminent danger.`;

  const prompt = `${subject} ${STYLE_ANCHOR} ${NEGATIVES}`;
  return generateAndCacheArt(ai, art, key, prompt, `trap:${slug}`);
}

// Per-encounter character portraits for dungeon NPCs and merchants. Both have
// AI-generated names (generateNpcName / generateMerchantName), and we cache
// by name slug — a "Brudor the Halflinter" encountered in two different
// dungeons will render the same portrait both times. The cached art also
// makes the same merchant name ringback consistently if avoid-list rotation
// repeats it.
//
// Style anchor + literal-name interpretation are the same as monster art —
// the epithet portion of the name ("the Patient", "Stack-Cleaver") is the
// part flux can lean into for character flavor. Different from monsters
// only in the framing (single-character portrait vs creature) and the
// scene context (dungeon corridor, merchant stall).
//
// Returns null on any failure; callers must skip the image block on null.
export async function generateEncounterArt(
  ai: Ai,
  art: ArtTarget,
  kind: "npc" | "merchant",
  name: string,
): Promise<string | null> {
  const slug = slugifyMonsterName(name);
  const key = `art/${ART_VERSION}/${kind}/${slug}.png`;

  const subject =
    kind === "npc"
      ? `ILLUSTRATION SUBJECT: a single-figure character portrait of "${name}" — a wandering adventurer encountered in a dim dungeon corridor.` +
        ` Treat the name (especially any epithet like "the Patient" or "Stack-Cleaver") LITERALLY — interpret what the words suggest about the character's appearance, posture, gear, or aura.` +
        ` Examples: "the Patient" = serene composed expression; "Halflinter" = scruffy half-lit by torchlight; "Stack-Cleaver" = wielding an oversized weapon.` +
        ` Three-quarter portrait, single character against a moody background, dramatic lighting.`
      : `ILLUSTRATION SUBJECT: a single fantasy merchant figure named "${name}", standing behind a small portable wooden stall in a dim dungeon corridor.` +
        ` Treat the name and any epithet LITERALLY for personality cues — interpret what the words suggest about the merchant's look or gear.` +
        ` Stall displays a few wares: vials, scrolls, a small weapon. Single hooded or robed figure beside the stall, lantern light, mysterious mood.`;

  const prompt = `${subject} ${STYLE_ANCHOR} ${NEGATIVES}`;
  return generateAndCacheArt(ai, art, key, prompt, `${kind}:${name}`);
}

// Core image-generation primitive used by every art helper in this file.
// Checks R2 for the cached object first, generates via flux-1-schnell on
// miss, persists, and returns the public URL. `label` is a short tag used
// only for log messages — distinguishes monster vs view vs other callers.
//
// Fail-soft: returns null on any error. Callers must handle null by skipping
// the image block.
async function generateAndCacheArt(
  ai: Ai,
  art: ArtTarget,
  key: string,
  prompt: string,
  label: string,
): Promise<string | null> {
  const publicUrl = `${art.baseUrl}/img/${key}`;

  try {
    const existing = await art.bucket.head(key);
    if (existing) {
      console.log("art:cache-hit", { label, key });
      return publicUrl;
    }
  } catch (err) {
    console.warn("art:head-error", { label, err: err instanceof Error ? err.message : String(err) });
  }

  console.log("art:start", { label, key });
  try {
    const result = (await ai.run("@cf/black-forest-labs/flux-1-schnell", {
      prompt,
      steps: 4, // flux-schnell is tuned for 4-step generation; higher costs more, doesn't help.
    })) as unknown;

    // flux-1-schnell returns { image: <base64 string> }. Other image models on
    // Workers AI return ReadableStream / Uint8Array — handle both shapes
    // defensively in case Cloudflare changes the binding.
    const bytes = await coerceImageBytes(result);
    if (!bytes) {
      console.warn("art:unrecognized-response", { label, key });
      return null;
    }

    await art.bucket.put(key, bytes, {
      httpMetadata: { contentType: "image/png" },
    });
    console.log("art:done", { label, key, size: bytes.byteLength });
    return publicUrl;
  } catch (err) {
    console.error("art:error", { label, key, err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// Defensive shape coercion for the image-model response. Workers AI image
// models historically returned multiple shapes across versions; we tolerate
// all of them and surface a single Uint8Array.
async function coerceImageBytes(result: unknown): Promise<Uint8Array | null> {
  if (!result) return null;
  // Shape A: { image: <base64 string> } (flux-1-schnell)
  if (typeof result === "object" && result !== null && "image" in result) {
    const img = (result as { image?: unknown }).image;
    if (typeof img === "string") {
      // base64 → bytes. Worker runtime has atob.
      try {
        const binary = atob(img);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      } catch {
        return null;
      }
    }
  }
  // Shape B: ReadableStream
  if (result instanceof ReadableStream) {
    const reader = result.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  }
  // Shape C: Uint8Array / ArrayBuffer directly
  if (result instanceof Uint8Array) return result;
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  return null;
}

// Step 1 of opening-scene generation: pick a name + HP. Tiny output — Llama
// nails the format with the focused prompt + smaller max_tokens budget.
async function generateMonsterIdentity(
  ai: Ai,
  variant: SceneVariant,
  hpFloor: number,
  hpCeil: number,
  avoidNames: string[],
  waveContext?: { wave: number; total: number },
): Promise<{ name: string; hp: number }> {
  const variantHint =
    variant === "boss"
      ? "BOSS encounter — name should be imposing, multi-word, slightly mythic."
      : variant === "gauntlet-wave"
      ? `Wave ${waveContext?.wave}/${waveContext?.total} of a gauntlet — name should be punchy, single archetype.`
      : "Standard foe — slightly absurd, single concept.";

  // Avoid-list with core-noun guidance. Bumped slice from 10 → 25 since
  // getRecentMonsterNames now extracts every monster from each quest (not
  // just the final/top-level one), so a recent dungeon contributes ~5-7
  // names instead of 1. The 25-name slice gives ~3-4 dungeons of coverage.
  const avoidLines: string[] = [];
  if (avoidNames.length > 0) {
    const cleaned = avoidNames.slice(0, 25).map((n) => n.trim()).filter(Boolean);
    if (cleaned.length > 0) {
      avoidLines.push(
        `STRICT AVOID LIST — these foes have appeared in this channel recently. DO NOT REUSE any of these names OR their core nouns: ${cleaned.join(", ")}.`,
        "Examples of what counts as duplication: if 'API Abandoner' is on the list, avoid ALL 'API ___' variants (API Anchor, API Abuser, etc.). If 'Deadline Demon' is on the list, avoid ALL 'Deadline ___' variants. Pick a fresh core noun and concept entirely.",
        "Brainstorm freshly from this list of unused themes: code review, stand-up meetings, release notes, on-call rotation, technical debt, retro, OKRs, performance reviews, post-mortems, hotfixes, observability, dependencies, branch protection, design docs, dashboards, alerts, Docker (containers / images / docker-compose / Dockerfile / orphaned volumes / dangling layers / build cache / port conflicts / network bridges).",
      );
    }
  }

  const system = [
    "You name comedic engineering + project-management themed monsters for Slack Quest.",
    "Tone: dry, witty, software-industry + PM (PRs, standups, sprints, gantt charts, scope creep, retros, kanban, blockers, deprecated APIs, on-call pagers, Docker containers, Dockerfile, orphaned volumes, dangling images).",
    "Output MUST follow this EXACT format. Plain text only — no markdown, no asterisks, no quotes around values, no commentary.",
    `MONSTER_NAME: <a ${variant === "boss" ? "2-5" : "1-4"} word name>`,
    `MONSTER_HP: <integer between ${hpFloor} and ${hpCeil}>`,
    variantHint,
    ...avoidLines,
  ].join("\n");

  console.log("identity:start", { variant, hpFloor, hpCeil, avoidCount: avoidNames.length });
  try {
    const res = (await ai.run(FAST_MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: "Pick the next foe now." },
      ],
      // Bumped from 60 to 150 — Llama sometimes adds a brief preamble before
      // the field block, and 60 was too tight to fit both fields after that.
      max_tokens: 150,
    })) as AiRunResponse;
    const text = res.response ?? "";
    console.log("identity:received", { len: text.length, preview: text.slice(0, 200) });
    const parsed = parseIdentityResponse(text, hpFloor, hpCeil);
    if (!parsed) {
      console.warn("identity:parse-fallback", { preview: text.slice(0, 200) });
      return { name: fallbackMonsterName(), hp: Math.floor((hpFloor + hpCeil) / 2) };
    }
    console.log("identity:done", parsed);
    return parsed;
  } catch (err) {
    console.error("identity:error", { err: err instanceof Error ? err.message : String(err) });
    return { name: fallbackMonsterName(), hp: Math.floor((hpFloor + hpCeil) / 2) };
  }
}

// Lenient parser for the identity step's AI response. Tries strict
// "MONSTER_NAME: X / MONSTER_HP: Y" format first, then falls back to a
// label-less interpretation: first non-numeric line = name, first standalone
// integer = HP. Llama frequently drops the field labels and returns "<name>:
// <hp>" or "<name>\n<hp>" — this catches both modes.
function parseIdentityResponse(
  text: string,
  hpFloor: number,
  hpCeil: number,
): { name: string; hp: number } | null {
  // Strict pass first — most-specific match.
  const strictName = /\*{0,2}MONSTER_NAME\*{0,2}\s*:\s*(.+)/i.exec(text);
  const strictHp = /\*{0,2}MONSTER_HP\*{0,2}\s*:\s*\*{0,2}(\d+)/i.exec(text);
  if (strictName?.[1]) {
    const name = stripWrappers(strictName[1].split("\n")[0]);
    let hp = strictHp ? parseInt(strictHp[1], 10) : Math.floor((hpFloor + hpCeil) / 2);
    hp = Math.min(hpCeil, Math.max(hpFloor, hp));
    if (name) return { name, hp };
  }

  // Lenient pass — split into lines, identify name + integer.
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  let name = "";
  let hp = NaN;
  for (const raw of lines) {
    // Strip any leading label-ish prefix (MONSTER_NAME, NAME, HP, etc.) + trailing colons.
    const cleaned = raw
      .replace(/^\*{0,2}(monster[_\s]?name|monster[_\s]?hp|name|hp|foe)\*{0,2}\s*:?\s*/i, "")
      .replace(/[:;]+$/, "")
      .trim();
    if (!cleaned) continue;
    // Standalone integer? Treat as HP if not yet captured AND it's plausibly in range.
    const intOnly = /^(\d+)\s*$/.exec(cleaned);
    if (intOnly && Number.isNaN(hp)) {
      const val = parseInt(intOnly[1], 10);
      // Loose range check — Llama might pick slightly outside the floor/ceil.
      // We clamp later. Just need to filter accidental matches like "4 limbs."
      if (val >= 1 && val <= hpCeil * 3) {
        hp = val;
        continue;
      }
    }
    // First alphabetic line = name candidate.
    if (!name && /[A-Za-z]/.test(cleaned)) {
      name = stripWrappers(cleaned);
    }
  }
  if (!name) return null;
  if (Number.isNaN(hp)) hp = Math.floor((hpFloor + hpCeil) / 2);
  hp = Math.min(hpCeil, Math.max(hpFloor, hp));
  return { name, hp };
}

// Step 2 of opening-scene generation: write the scene prose with the chosen
// name pinned as input. The prompt is very explicit about using the exact name.
async function generateSceneForMonster(
  ai: Ai,
  monsterName: string,
  character: Pick<Character, "name" | "class" | "level">,
  elite: boolean,
  variant: SceneVariant,
  waveContext?: { wave: number; total: number },
): Promise<string> {
  const variantLine =
    variant === "boss" ? "Climactic, imposing — single big foe." :
    variant === "gauntlet-wave" ? `Wave ${waveContext?.wave}/${waveContext?.total} — quick, momentum-driven, between breaths.` :
    "Standard quest opening.";
  const system = [
    "You narrate comedic engineering + project-management themed dungeon scenes for Slack Quest.",
    "Tone: dry, witty, software-industry + PM winks (PRs, standups, sprints, gantt charts, scope creep, retros, blockers, MVPs, kanban).",
    "Output ONE paragraph: 2-3 sentences, ~60 words total. Plain text — no markdown, no labels, no quotes around the prose.",
    `The monster's name is "${monsterName}". You MUST refer to it by that EXACT name at least once in the prose. Do not invent any other proper noun for the monster.`,
  ].join("\n");
  const user = [
    `Write the opening scene for ${character.name}, a Level ${character.level} ${character.class}, facing ${monsterName}.`,
    elite ? "ELITE quest — perma-death looms." : "",
    `Beat: ${variantLine}`,
  ].filter(Boolean).join("\n");
  console.log("scene:start", { monsterName, variant });
  try {
    const res = (await ai.run(MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 220,
    })) as AiRunResponse;
    const text = (res.response ?? "").trim().replace(/^["'`]|["'`]$/g, "");
    console.log("scene:received", { len: text.length, preview: text.slice(0, 200) });
    if (!text) {
      console.warn("scene:empty-fallback");
      return fallbackSceneText();
    }
    // Final consistency check — log a warning if the LLM still slipped a different
    // name in (rare with the explicit-name prompt). We return the text anyway since
    // it's still on-tone narration; the alternative is a generic fallback.
    if (!sceneMentionsName(text, monsterName)) {
      console.warn("scene:name-mismatch", { monsterName, preview: text.slice(0, 120) });
    }
    console.log("scene:done", { monsterName });
    return text;
  } catch (err) {
    console.error("scene:error", { err: err instanceof Error ? err.message : String(err) });
    return fallbackSceneText();
  }
}

// Strips markdown emphasis (`*`, `_`), surrounding quotes, and code ticks from a
// captured field value. Llama 3.1 8B sometimes wraps fields like `**Foo**` or `"Foo"`
// despite the strict format spec.
function stripWrappers(s: string): string {
  let v = s.trim();
  for (let i = 0; i < 4; i++) {
    const next = v.replace(/^[*_"'`]+/, "").replace(/[*_"'`]+$/, "").trim();
    if (next === v) break;
    v = next;
  }
  return v;
}

// Does the scene prose actually mention the monster's name? Lenient match: case-insensitive,
// strips a leading "the " from the name (so "the Bloat King" matches "Bloat King"), and
// passes if any 2+ consecutive words from the name appear in the scene.
function sceneMentionsName(scene: string, name: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/^the\s+/, "").trim();
  const sceneL = scene.toLowerCase();
  const nameL = norm(name);
  if (!nameL) return true;
  if (sceneL.includes(nameL)) return true;
  const words = nameL.split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return true;
  // For multi-word names, require any 2 consecutive name words to appear together.
  if (words.length >= 2) {
    for (let i = 0; i < words.length - 1; i++) {
      if (sceneL.includes(`${words[i]} ${words[i + 1]}`)) return true;
    }
    return false;
  }
  // Single-word name: match if it shows up anywhere.
  return sceneL.includes(words[0]);
}

// Shared system prompt for one-line combat flavor. Tight constraints — the model gets
// excited and starts writing essays otherwise.
const COMBAT_SYSTEM = [
  'You are the narrator of "Slack Quest", a comedic engineering-themed dungeon crawl Slack bot.',
  "Tone: dry, witty, software-industry + project-management winks (PRs, standups, deprecated APIs, YAML, on-call pagers, 502s, kubernetes, regex, sprints, gantt charts, scope creep, kanban, retros, blockers, story points, the critical path, burndown).",
  "Never break character. Never mention you are an AI.",
  "Output ONE line, 1-2 sentences, ~25 words MAX. No markdown formatting. No emoji. Do not include numbers, HP values, or damage amounts.",
].join("\n");

// Strips a leading first-person/template fragment if the model echoes the prompt back.
function cleanFlavor(s: string): string {
  return s
    .trim()
    .replace(/^(here['']s|here is|narration:|line:)\s*/i, "")
    .replace(/^["'`]|["'`]$/g, "")
    .trim();
}

async function generateFlavor(
  ai: Ai,
  userPrompt: string,
  fallback: string,
  maxTokens = 90,
): Promise<string> {
  try {
    const result = (await ai.run(MODEL, {
      messages: [
        { role: "system", content: COMBAT_SYSTEM },
        { role: "user", content: userPrompt },
      ],
      max_tokens: maxTokens,
    })) as AiRunResponse;
    const cleaned = cleanFlavor(result.response ?? "");
    return cleaned || fallback;
  } catch {
    return fallback;
  }
}

interface FighterRef {
  name: string;
  class: string;
  level: number;
  // Optional gender — feeds pronoun consistency into every flavor call. Null
  // for legacy characters rolled before the field existed; in that case the
  // LLM picks pronouns freely (usually "they" or guesses from the name).
  gender?: "m" | "f" | null;
}

// Builds a one-line pronoun hint to append to flavor prompts so the LLM
// uses consistent grammar across calls. Empty string when no gender is set,
// which leaves the LLM free to pick.
function pronounHint(gender: "m" | "f" | null | undefined): string {
  if (gender === "m") return " Use he/him pronouns.";
  if (gender === "f") return " Use she/her pronouns.";
  return "";
}

export async function flavorHit(
  ai: Ai,
  character: FighterRef,
  monsterName: string,
  action: "attack" | "cast",
  isCrit: boolean,
  equippedWeapon?: string,
  equippedArmor?: string,
): Promise<string> {
  const verb = action === "cast"
    ? equippedWeapon
      ? `channels their *${equippedWeapon}* at`
      : "casts a spell at"
    : equippedWeapon
      ? `swings their *${equippedWeapon}* at`
      : "swings a weapon at";
  const intensity = isCrit ? "The blow lands as a CRITICAL hit — devastating." : "The blow connects solidly.";
  const gearHint = equippedWeapon || equippedArmor
    ? ` Mention the gear by name: ${[equippedWeapon && `weapon "${equippedWeapon}"`, equippedArmor && `armor "${equippedArmor}"`].filter(Boolean).join(", ")}.`
    : "";
  const user = `${character.name}, a Level ${character.level} ${character.class}, ${verb} ${monsterName}. ${intensity} Narrate this single moment in-world.${gearHint}${pronounHint(character.gender)}`;
  const fallback = isCrit
    ? `${character.name} lands a brutal blow on ${monsterName}${equippedWeapon ? ` with their ${equippedWeapon}` : ""}.`
    : `${character.name} strikes ${monsterName}${equippedWeapon ? ` with their ${equippedWeapon}` : ""}.`;
  return generateFlavor(ai, user, fallback);
}

export async function flavorJoin(
  ai: Ai,
  character: FighterRef,
  monsterName: string,
): Promise<string> {
  const user = `${character.name}, a Level ${character.level} ${character.class}, has just arrived mid-fight to join the party against ${monsterName}. Narrate their dramatic entrance.${pronounHint(character.gender)}`;
  const fallback = `${character.name} the ${character.class} arrives to join the fight against ${monsterName}.`;
  return generateFlavor(ai, user, fallback);
}

export async function flavorFleeSuccess(
  ai: Ai,
  character: FighterRef,
  monsterName: string,
  partyContinues: boolean,
): Promise<string> {
  const tail = partyContinues
    ? "The rest of the party fights on without them."
    : "Nobody is left to fight; the quest ends in retreat.";
  const user = `${character.name}, a Level ${character.level} ${character.class}, just successfully fled from ${monsterName}. ${tail} Narrate the escape with wry humor.${pronounHint(character.gender)}`;
  const fallback = `${character.name} slips away from ${monsterName} and lives to debug another day.`;
  return generateFlavor(ai, user, fallback);
}

export async function flavorDeath(
  ai: Ai,
  character: FighterRef,
  monsterName: string,
  isPerma: boolean,
): Promise<string> {
  const user = isPerma
    ? `${character.name}, a Level ${character.level} ${character.class}, has just been permanently slain by ${monsterName} in an elite quest. Write a brief, dignified-but-comedic obituary line in-world.${pronounHint(character.gender)}`
    : `${character.name}, a Level ${character.level} ${character.class}, was just dropped to 0 HP by ${monsterName} and is now downed. They'll recover after a 12-hour cooldown. Narrate the indignity in one line.${pronounHint(character.gender)}`;
  const fallback = isPerma
    ? `${character.name} falls before ${monsterName}, never to compile again.`
    : `${character.name} crumples under ${monsterName}'s onslaught.`;
  return generateFlavor(ai, user, fallback, 110);
}

// AI names + flavors a loot drop. Mechanics (slot, power, rarity) are deterministic;
// the model only writes the name and a one-line description.
// Returns { name, flavor } — falls back to generic stubs if the model misbehaves.
//
// Note: this function is for items whose names are AI-generated (weapon, armor,
// consumable, magic, revive). Tool & scroll catalog items use flavorCatalogItem
// instead — their names are fixed and the AI only writes the flavor blurb.
// Slot-specific type hint overrides for Phase 2 armor subtypes. Called when the
// item roll carries a slot value that isn't handled by the generic armor hint.
function slotTypeHint(slot: string): string | null {
  switch (slot) {
    case "ring":     return "a finger ring or accessory (e.g. signet ring, debug ring, null-pointer ring, uptime band)";
    case "amulet":   return "a neck amulet or pendant (e.g. data-crystal pendant, uptime medallion, recursion talisman)";
    case "boots":    return "footwear (e.g. runtime sandals, debug boots, null-pointer treads, stack-overflow cleats)";
    case "helmet":   return "head armor (e.g. crash helmet, null-guard visor, incident commander's helm, merge-conflict cap)";
    case "pants":    return "leg armor or trousers (e.g. cargo pants, quantum leggings, debug denims, load-balanced greaves)";
    case "off_hand": return "a shield (e.g. firewall buckler, rate-limiting shield, null-check barrier, abstraction layer)";
    default:         return null;
  }
}

export async function flavorLootDrop(
  ai: Ai,
  monsterName: string,
  type: "weapon" | "armor" | "consumable" | "magic" | "revive",
  rarity: "common" | "uncommon" | "rare" | "epic" | "legendary",
  power: number,
  weaponRange?: "melee" | "ranged" | "focus",
  slot?: string,
): Promise<{ name: string; flavor: string }> {
  const weaponHint = type === "weapon"
    ? weaponRange === "ranged"
      ? "a RANGED weapon (e.g. crossbow, bow, sling, throwing dart, scroll-launcher, blunderbuss)"
      : weaponRange === "focus"
      ? "a FOCUS / caster weapon — a magical channel, not a damage tool (e.g. wand, staff, druidic bough, codex, sigil-rod, healer's chime, focusing crystal, spell-quill). It boosts healing and shielding rather than attack damage."
      : "a MELEE weapon (e.g. sword, hammer, dagger, gauntlet, mace, axe — solid hand-to-hand)"
    : null;
  const typeHint =
    weaponHint ??
    (slot ? (slotTypeHint(slot) ?? "armor (e.g. vest, robe, cloak, helm, plating, gloves)") :
     type === "armor"  ? "armor (e.g. vest, robe, cloak, helm, plating, gloves)" :
     type === "magic"  ? "a magical focus (e.g. tome, crystal, sigil, talisman, rune-stone)" :
     type === "revive" ? "a revival item (e.g. phoenix down, defib paddles, hot-fix kit, sacred patch)" :
                         "a consumable (e.g. potion, brew, scroll, capsule, energy drink, snack)");
  const rarityHint =
    rarity === "legendary" ? "LEGENDARY — this is a mythic relic, name it like something whispered in the halls of engineering lore. Grandiose, unforgettable." :
    rarity === "epic" ? "EPIC quality — prestigious and powerful, name it like something a senior architect would write a blog post about." :
    rarity === "rare" ? "Rare and weighty — name it like a notable artifact with some history." :
    rarity === "uncommon" ? "Uncommon — slightly notable, has some history." :
    "Common — workmanlike, mildly absurd is fine.";
  const powerHint =
    type === "consumable" ? `It restores about ${power} HP when used.` :
    type === "magic" ? `It permanently grants +${power} maximum mana when consumed.` :
    type === "revive" ? `It revives a downed party member to ${power}% of their max HP.` :
    type === "weapon" && weaponRange === "focus"
      ? `It grants +${power} to heal AND shield amounts (no damage bonus). Also +1 max mana while equipped.`
      : `It grants a +${power} bonus when equipped.`;

  const user = [
    `Generate loot dropped by ${monsterName} for a comedic engineering-themed dungeon crawl.`,
    `It is ${typeHint}. ${rarityHint} ${powerHint}`,
    "Output exactly two lines, no markdown, no quotes:",
    "NAME: <a 2-5 word punchy themed name>",
    "FLAVOR: <one short sentence, ~15 words, dryly funny, software-industry winks ok>",
  ].join("\n");

  const fallback = {
    name: type === "consumable" ? `Mystery ${rarity} elixir` : `Battered ${rarity} ${type}`,
    flavor: `Dropped by ${monsterName}. Smells faintly of merge conflicts.`,
  };

  try {
    const result = (await ai.run(MODEL, {
      messages: [
        { role: "system", content: COMBAT_SYSTEM },
        { role: "user", content: user },
      ],
      max_tokens: 90,
    })) as AiRunResponse;
    const text = (result.response ?? "").trim();
    const nameMatch = /NAME:\s*(.+)/i.exec(text);
    const flavorMatch = /FLAVOR:\s*(.+)/i.exec(text);
    const name = nameMatch?.[1]?.trim().replace(/^["'`]|["'`]$/g, "");
    const flavor = flavorMatch?.[1]?.trim().replace(/^["'`]|["'`]$/g, "");
    if (!name || !flavor) return fallback;
    return { name, flavor };
  } catch {
    return fallback;
  }
}

// Flavor text for a catalog item (tool/scroll). The name is fixed by the catalog;
// this only generates the one-line description. Falls back to the catalog blurb if
// the model misbehaves.
export async function flavorCatalogItem(
  ai: Ai,
  catalogName: string,
  blurb: string,
  location: string,
): Promise<string> {
  const system = [
    'You are the narrator of "Slack Quest", a comedic engineering + project-management themed dungeon crawl Slack bot.',
    "Tone: dry, witty, software-industry winks (PRs, standups, sprints, gantt charts, scope creep, kanban, deprecated APIs, on-call pagers).",
    "Output ONE line: a 1-2 sentence flavor description (~25 words). No markdown, no quotes, no name field, no labels. Just the prose.",
    `Item: ${catalogName} — ${blurb}`,
  ].join("\n");
  const user = `Found in ${location}. Describe how this specific ${catalogName} looks/feels in 1-2 dry, witty sentences.`;
  try {
    const res = (await ai.run(MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 80,
    })) as AiRunResponse;
    const text = (res.response ?? "").trim().replace(/^["'`]|["'`]$/g, "");
    return text || blurb;
  } catch {
    return blurb;
  }
}

// Generates the per-node content of an expedition. The model picks a coherent
// theme + 5 scenes; we rely on field markers to parse rather than JSON output
// (llama-3.1-8b is unreliable with strict JSON, very reliable with line markers).
export interface GeneratedExpeditionScene {
  scene: string;
  choices: string[];
}

export async function generateExpeditionForkScene(
  ai: Ai,
  theme: string,
  pathTaken: string[],
  sceneIndex: number,
  totalForks: number,
): Promise<GeneratedExpeditionScene> {
  const history = pathTaken.length > 0
    ? `Choices made so far: ${pathTaken.map((p, i) => `(${i + 1}) ${p}`).join("; ")}.`
    : "This is the opening scene.";

  const user = [
    `You are running an expedition quest with the theme: "${theme}".`,
    `This is fork ${sceneIndex} of ${totalForks}.`,
    history,
    "Generate the next scene + 2 choices. Output exactly:",
    "SCENE: <2 sentences, ~40 words, set the situation>",
    "CHOICE_1: <a short imperative phrase, ~6 words>",
    "CHOICE_2: <a short imperative phrase, ~6 words, meaningfully different from choice 1>",
  ].join("\n");

  const fallback: GeneratedExpeditionScene = {
    scene: "A junction looms. Two paths diverge through the gloom of long-deprecated documentation.",
    choices: ["Take the lit path", "Take the dark path"],
  };

  try {
    const result = (await ai.run(MODEL, {
      messages: [
        { role: "system", content: COMBAT_SYSTEM },
        { role: "user", content: user },
      ],
      max_tokens: 200,
    })) as AiRunResponse;
    const text = (result.response ?? "").trim();
    const scene = /SCENE:\s*(.+)/i.exec(text)?.[1]?.trim();
    const c1 = /CHOICE_1:\s*(.+)/i.exec(text)?.[1]?.trim().replace(/^["'`]|["'`]$/g, "");
    const c2 = /CHOICE_2:\s*(.+)/i.exec(text)?.[1]?.trim().replace(/^["'`]|["'`]$/g, "");
    if (!scene || !c1 || !c2) return fallback;
    return { scene, choices: [c1, c2] };
  } catch {
    return fallback;
  }
}

export async function generateExpeditionTheme(ai: Ai): Promise<string> {
  const user = "Generate a single short evocative theme for an expedition into a hostile codebase. 4-7 words. No quotes. Examples: 'the cursed monorepo merge', 'haunted staging environment', 'forgotten sprint of 2019'.";
  const fallback = "the abandoned staging environment";
  return generateFlavor(ai, user, fallback, 30);
}

export async function flavorForkOutcome(
  ai: Ai,
  theme: string,
  choice: string,
): Promise<string> {
  const user = `Expedition theme: "${theme}". The party just chose: "${choice}". Narrate the immediate consequence in one short line.`;
  const fallback = `The party commits to the path.`;
  return generateFlavor(ai, user, fallback, 80);
}

export async function flavorSignature(
  ai: Ai,
  character: FighterRef,
  monsterName: string,
  signatureName: string,
  isCrit: boolean,
  equippedWeapon?: string,
  equippedArmor?: string,
): Promise<string> {
  const intensity = isCrit ? "It lands as a CRITICAL strike — devastating." : "It lands true.";
  const gearHint = equippedWeapon || equippedArmor
    ? ` Work the gear into the moment: ${[equippedWeapon && `weapon "${equippedWeapon}"`, equippedArmor && `armor "${equippedArmor}"`].filter(Boolean).join(", ")}.`
    : "";
  const user = `${character.name}, a Level ${character.level} ${character.class}, just unleashes their signature ability *${signatureName}* on ${monsterName}. ${intensity} Narrate the moment with extra weight — this is a class-defining move.${gearHint}${pronounHint(character.gender)}`;
  const fallback = isCrit
    ? `${character.name}'s ${signatureName}${equippedWeapon ? `, channeled through their ${equippedWeapon},` : ""} crashes into ${monsterName} like a falling stack trace.`
    : `${character.name} channels ${signatureName}${equippedWeapon ? ` through their ${equippedWeapon}` : ""} at ${monsterName}.`;
  return generateFlavor(ai, user, fallback, 110);
}

// Generates a trap room: scene description + 3 disarm-option texts. The skill type
// for each option is fixed by caller (one str, one dex, one int) — the AI just
// fills in what those skills look like in this scenario.
export interface GeneratedTrap {
  scene: string;
  options: { str: string; dex: string; int: string };
}

export async function generateTrapRoom(
  ai: Ai,
  theme: string,
  roomNumber: number,
  totalRooms: number,
): Promise<GeneratedTrap> {
  const user = [
    `You are running room ${roomNumber}/${totalRooms} of a dungeon themed: "${theme}".`,
    "This room contains a TRAP. Generate scene + 3 disarm options matching three approaches:",
    "  STR — brute force (smash, charge, bend, lift)",
    "  DEX — finesse (disarm, slip past, defuse, sneak)",
    "  INT — wits (decode, riddle, calculate, identify)",
    "Output exactly:",
    "SCENE: <2 sentences, ~35 words, set the trap with menace>",
    "STR: <imperative phrase, 4-6 words>",
    "DEX: <imperative phrase, 4-6 words>",
    "INT: <imperative phrase, 4-6 words>",
  ].join("\n");

  const fallback: GeneratedTrap = {
    scene: "A pressure plate clicks under your boot. The room hisses — definitely a trap.",
    options: {
      str: "Smash through the wall",
      dex: "Disarm the trigger gently",
      int: "Decode the warding glyphs",
    },
  };

  try {
    const result = (await ai.run(MODEL, {
      messages: [
        { role: "system", content: COMBAT_SYSTEM },
        { role: "user", content: user },
      ],
      max_tokens: 200,
    })) as AiRunResponse;
    const text = (result.response ?? "").trim();
    const scene = /SCENE:\s*(.+)/i.exec(text)?.[1]?.trim();
    const str = /STR:\s*(.+)/i.exec(text)?.[1]?.trim().replace(/^["'`]|["'`]$/g, "");
    const dex = /DEX:\s*(.+)/i.exec(text)?.[1]?.trim().replace(/^["'`]|["'`]$/g, "");
    const int = /INT:\s*(.+)/i.exec(text)?.[1]?.trim().replace(/^["'`]|["'`]$/g, "");
    if (!scene || !str || !dex || !int) return fallback;
    return { scene, options: { str, dex, int } };
  } catch {
    return fallback;
  }
}

export async function generateLockboxScene(
  ai: Ai,
  theme: string,
  roomNumber: number,
  totalRooms: number,
): Promise<string> {
  const user = `Room ${roomNumber}/${totalRooms} of a dungeon themed: "${theme}". This room has a *locked* chest. Narrate the discovery in 2 sentences (~35 words). Hint that without a key, players can only walk past empty-handed.`;
  const fallback = "A chest sits at the room's center, bound in three iron locks and humming with promise. You'd need a key — or your conscience to leave it.";
  return generateFlavor(ai, user, fallback, 110);
}

export interface GeneratedNpc {
  scene: string;
  greeting: string;
}

export async function generateNpcRoom(
  ai: Ai,
  theme: string,
  roomNumber: number,
  totalRooms: number,
  npcName: string,
  // The actual item the NPC is offering (post-loot-roll). Forced into the
  // prompt as an explicit input so the greeting names what's on offer instead
  // of inventing generic "wares" — same fix pattern we used for the monster
  // name/scene mismatch class of bug.
  offerItemName: string,
): Promise<GeneratedNpc> {
  const user = [
    `Room ${roomNumber}/${totalRooms} of a dungeon themed: "${theme}".`,
    `An NPC named "${npcName}" is here, offering a specific item to the party: "${offerItemName}".`,
    `In their GREETING, they MUST name or directly describe "${offerItemName}" — they're trying to give it away or sell it. Don't invent a different item.`,
    "Output exactly:",
    "SCENE: <2 sentences setting the encounter — what they look like, what they're doing>",
    `GREETING: <1-2 sentences of what they say, naming or describing "${offerItemName}" specifically>`,
  ].join("\n");

  const fallback: GeneratedNpc = {
    scene: "A figure in patched robes warms hands by a battered terminal. They look up and grin.",
    greeting: `"Trade you for this *${offerItemName}*? I came across it three sprints back and have no use for it."`,
  };

  try {
    const result = (await ai.run(MODEL, {
      messages: [
        { role: "system", content: COMBAT_SYSTEM },
        { role: "user", content: user },
      ],
      max_tokens: 200,
    })) as AiRunResponse;
    const text = (result.response ?? "").trim();
    const scene = /SCENE:\s*(.+)/i.exec(text)?.[1]?.trim();
    const greeting = /GREETING:\s*([\s\S]+)/i.exec(text)?.[1]?.trim().replace(/^["'`]|["'`]$/g, "");
    if (!scene || !greeting) return fallback;
    return { scene, greeting };
  } catch {
    return fallback;
  }
}

// Generates a merchant room scene + greeting. Merchant is a guaranteed slot
// that always lands as the last middle room (right before the sub-boss),
// giving the party a "last chance to gear up" beat.
export interface GeneratedMerchant {
  scene: string;
  greeting: string;
}

export async function generateMerchantRoom(
  ai: Ai,
  theme: string,
  roomNumber: number,
  totalRooms: number,
  merchantName: string,
  // Real stock items the merchant is selling — feeds into the greeting so
  // they hawk specific wares by name rather than inventing generic ones.
  // Same fix pattern as monster name/scene mismatch.
  stockItemNames: string[],
): Promise<GeneratedMerchant> {
  const stockList = stockItemNames.length > 0
    ? stockItemNames.map((n) => `  • "${n}"`).join("\n")
    : "  • (no stock listed)";
  const user = [
    `Room ${roomNumber}/${totalRooms} of a dungeon themed: "${theme}".`,
    `A traveling merchant named "${merchantName}" has set up a tiny shop here, mid-dungeon.`,
    `Their stall has these specific items today:`,
    stockList,
    `In their GREETING, they MUST name or directly hawk at least ONE of the items above by name. Don't invent generic wares — they're selling these exact things. Mentioning two of the items is even better.`,
    "Output exactly:",
    "SCENE: <2 sentences setting the encounter — what their stall looks like, where they came from>",
    `GREETING: <1-2 sentences of what they say to the party, naming at least one of the listed items>`,
  ].join("\n");

  const firstItem = stockItemNames[0] ?? "trouble preparation";
  const fallback: GeneratedMerchant = {
    scene: `${merchantName} has improvised a shopfront from overturned standing-desks and a fluttering Gantt chart.`,
    greeting: `"Adventurers! Step right up. You'll want a *${firstItem}* — trust me, you'll want a *${firstItem}*."`,
  };

  try {
    const result = (await ai.run(MODEL, {
      messages: [
        { role: "system", content: COMBAT_SYSTEM },
        { role: "user", content: user },
      ],
      max_tokens: 220,
    })) as AiRunResponse;
    const text = (result.response ?? "").trim();
    const scene = /SCENE:\s*(.+)/i.exec(text)?.[1]?.trim();
    const greeting = /GREETING:\s*([\s\S]+)/i.exec(text)?.[1]?.trim().replace(/^["'`]|["'`]$/g, "");
    if (!scene || !greeting) return fallback;
    return { scene, greeting };
  } catch {
    return fallback;
  }
}

export async function flavorBossPhase(
  ai: Ai,
  monsterName: string,
): Promise<string> {
  const user = `${monsterName} has just been wounded past 50% HP and powers up — second phase of the boss fight begins. Narrate the menacing transformation in one line.`;
  const fallback = `${monsterName} pulses with renewed fury — the fight isn't over yet.`;
  return generateFlavor(ai, user, fallback, 110);
}

export async function flavorGauntletNext(
  ai: Ai,
  prevMonster: string,
  nextMonster: string,
  waveLabel: string,
): Promise<string> {
  const user = `${prevMonster} just fell. Now ${nextMonster} emerges — ${waveLabel} of a gauntlet. Narrate the transition with no rest in between.`;
  const fallback = `Before the dust settles, ${nextMonster} appears — ${waveLabel}.`;
  return generateFlavor(ai, user, fallback, 110);
}

export async function flavorVictory(
  ai: Ai,
  character: FighterRef,
  monsterName: string,
  partySize: number,
): Promise<string> {
  const partyText = partySize === 1 ? "fighting solo" : `fighting alongside ${partySize - 1} other heroes`;
  const user = `${character.name}, a Level ${character.level} ${character.class} ${partyText}, just landed the killing blow on ${monsterName}. Narrate the triumph.${pronounHint(character.gender)}`;
  const fallback = `${character.name} delivers the killing blow. ${monsterName} is no more.`;
  return generateFlavor(ai, user, fallback, 110);
}

// =============================================================================
// TOWN / PUB
// =============================================================================
//
// Two surfaces of AI gen for the town:
//   1. Town name — short, evocative, refreshed weekly so the place feels
//      persistent. Fast model since it's a single line.
//   2. NPC dialog trees — one call per NPC per daily refresh produces a
//      structured 2-level tree (root → 3 options → 2 sub-options each, with
//      occasional reward payloads). Robust to malformed output via a strict
//      JSON parser + hand-written fallback tree.
//
// We do NOT AI-generate NPC dialog turns at runtime (per the design doc's
// "multiple-choice not free-text" principle). All player choices walk the
// pre-baked tree from cached TownState.

// Short evocative town name. Workshop-style fantasy with a software wink
// ("Stale Logfile Township", "The Sprintward Hamlet"). One line, ~5-8 words.
export async function generateTownName(
  ai: Ai,
  recentNames: string[] = [],
): Promise<string> {
  const avoidLine = recentNames.length > 0
    ? `\nAvoid these recently-used names: ${recentNames.join(", ")}.`
    : "";
  const user = [
    "Generate a single evocative fantasy-RPG town name with a software-engineering wink.",
    'Examples: "Stale Logfile Township", "The Sprintward Hamlet", "Old Mainbranch on the Hill".',
    "Output ONLY the name itself, nothing else. 3-6 words. No quotes, no preamble.",
    avoidLine,
  ].filter(Boolean).join("\n");
  const fallback = "Stale Logfile Township";
  try {
    const result = (await ai.run(FAST_MODEL, {
      messages: [
        { role: "system", content: COMBAT_SYSTEM },
        { role: "user", content: user },
      ],
      max_tokens: 30,
    })) as AiRunResponse;
    const cleaned = cleanFlavor(result.response ?? "")
      .replace(/^name:\s*/i, "")
      .split("\n")[0]
      .trim();
    return cleaned.length >= 3 && cleaned.length <= 60 ? cleaned : fallback;
  } catch {
    return fallback;
  }
}

// Generates a multi-choice dialog tree for an NPC. Returns a JSON tree the
// commands.ts handler walks via action_id paths.
//
// Tree shape (2 levels deep — chosen for token budget + reliability over
// 3-level which makes the JSON output flakier):
//
//   root: { npc_says, options: [opt1, opt2, opt3] }
//   opt:  { player_says, next: { npc_says, options: [sub1, sub2] }, payload? }
//   sub:  { player_says, next: { npc_says }, payload? }       // terminal
//
// Payloads scatter occasionally: 1-2 per tree at most so they feel like
// rewards, not handouts. Hand-written fallback tree returned on parse
// failure so the pub always has a working NPC.
export interface NpcDialogInput {
  name: string;
  archetype: string;       // "weary engineer", "retired adventurer"
  vibe: string;            // "dry and bitter; nine deadlines deep"
  concern: string;         // "his apprentice keeps merging to main"
  role: "bartender" | "regular";
  townName: string;
}

export interface AiDialogPayload {
  type: "rumor" | "gold" | "drink_token" | "xp";
  text?: string;           // rumor body
  amount?: number;         // gold or xp amount
  drink_id?: string;       // drink_token reference
}
export interface AiDialogNode {
  npc_says: string;
  options?: AiDialogOption[];
}
export interface AiDialogOption {
  player_says: string;
  next: AiDialogNode;
  payload?: AiDialogPayload;
}

export async function generateNpcDialog(
  ai: Ai,
  input: NpcDialogInput,
): Promise<AiDialogNode> {
  const roleNote = input.role === "bartender"
    ? "They run the bar at the Stale Logfile Tavern."
    : "They're a regular at the Stale Logfile Tavern, nursing a drink.";
  const user = [
    `You are writing a branching dialog tree for an NPC in a Slack-based RPG.`,
    `The NPC is ${input.name}, a ${input.archetype}. Vibe: ${input.vibe}. Their current concern: ${input.concern}. ${roleNote}`,
    "",
    "ROLE ASSIGNMENT (critical — do not invert):",
    "- The NPC SPEAKS FIRST. Every `npc_says` field is a line spoken BY the NPC TO the player.",
    "- Every `player_says` field is what the PLAYER says back. These render as buttons the player clicks.",
    "- The root `npc_says` is the NPC's opening line — a question, a remark, an observation. NEVER a response, NEVER an answer to a question, NEVER 'thanks for that.'",
    "- The nested `next.npc_says` is the NPC's reply AFTER the player picks an option. THIS is where rewards land.",
    "",
    "TREE SHAPE — exactly 3 top-level options, each with exactly 2 sub-options:",
    "{",
    `  "npc_says": "<opening — NPC speaks to player, 1-2 sentences>",`,
    `  "options": [`,
    `    { "player_says": "<player's reply, ~6-10 words>",`,
    `      "next": { "npc_says": "<NPC's response to that reply>",`,
    `        "options": [`,
    `          { "player_says": "<sub-reply>", "next": { "npc_says": "<NPC closes the conversation>" } },`,
    `          { "player_says": "<sub-reply>", "next": { "npc_says": "<NPC closes the conversation>" } }`,
    `        ] } },`,
    `    { "player_says": "...", "next": { "npc_says": "...", "options": [ ...2 sub-options... ] } },`,
    `    { "player_says": "...", "next": { "npc_says": "...", "options": [ ...2 sub-options... ] } }`,
    "  ]",
    "}",
    "",
    "REWARDS:",
    `- Up to 2 player-option branches across the tree may carry a payload: { "type": "rumor", "text": "<one sentence>" } OR { "type": "gold", "amount": 3-8 } OR { "type": "xp", "amount": 5-15 }.`,
    "- Rewards are paid out IMMEDIATELY when the player picks that option — the very next `npc_says` line is the NPC handing it over.",
    "- The exchange must complete IN-DIALOGUE. NEVER frame the reward as a fetch quest, errand, delivery, or future task. The NPC pays for what just happened: the player answered a question, shared news, told a joke, offered company.",
    "- Forbidden phrases: 'fetch me', 'bring me', 'go find', 'come back tomorrow', 'as a down payment', 'if you can do this for me', 'I'll pay you when'.",
    "",
    "EXAMPLE — gold-payable answer to a question:",
    `{`,
    `  "npc_says": "Do you know what day the bard comes to town?",`,
    `  "options": [`,
    `    { "player_says": "Tomorrow, I think.",`,
    `      "next": { "npc_says": "Tomorrow! That's what I needed to hear. Here, a coin for the trouble.",`,
    `        "options": [`,
    `          { "player_says": "Anytime.", "next": { "npc_says": "I'll save you a seat." } },`,
    `          { "player_says": "Glad to help.", "next": { "npc_says": "Means a lot, friend." } }`,
    `        ] },`,
    `      "payload": { "type": "gold", "amount": 5 } },`,
    `    { "player_says": "He was here yesterday.",`,
    `      "next": { "npc_says": "Damn, I missed him again.",`,
    `        "options": [`,
    `          { "player_says": "There's always next time.", "next": { "npc_says": "Aye, suppose so." } },`,
    `          { "player_says": "Was he any good?", "next": { "npc_says": "Better than the last one." } }`,
    `        ] } },`,
    `    { "player_says": "Next week, actually.",`,
    `      "next": { "npc_says": "Plenty of time to prepare, then.",`,
    `        "options": [`,
    `          { "player_says": "What's the song?", "next": { "npc_says": "Same one as last time. Always is." } },`,
    `          { "player_says": "I'll be there.", "next": { "npc_says": "Save me a stool." } }`,
    `        ] } }`,
    `  ]`,
    `}`,
    "",
    "Tone: software-engineering fantasy. No fourth-wall breaks. Match the NPC's vibe.",
    "Output JSON ONLY. No prose. No code fences. Exactly 3 top-level options. Exactly 2 sub-options on each.",
  ].join("\n");

  try {
    const result = (await ai.run(MODEL, {
      messages: [
        // We use a JSON-strict system to override the prose-only COMBAT_SYSTEM
        // — this is the one helper where we WANT structured output.
        { role: "system", content: "You output strictly valid JSON matching the schema provided. No prose, no code fences, no commentary." },
        { role: "user", content: user },
      ],
      max_tokens: 900,
    })) as AiRunResponse;
    const raw = (result.response ?? "").trim()
      // Strip code fences if the model insists on them.
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(raw) as AiDialogNode;
    // Structural validation. We've seen the model occasionally produce:
    //   - Single-option root trees (1 button, no real choice)
    //   - Inverted-role outputs (player line in npc_says, npc line on a button)
    //   - Empty/missing options on the next-level node
    // Trees that fail these checks fall back to the hand-written backstop —
    // it's better to render a generic-but-correct conversation than a
    // confusing single-button stub.
    if (!isWellFormedDialogTree(parsed)) {
      return fallbackDialogTree(input);
    }
    return parsed;
  } catch {
    return fallbackDialogTree(input);
  }
}

// Generates a single Job Board listing — a short title + 1-sentence flavor
// blurb for a specific quest variant. Returns both pieces; caller pairs
// them with hand-formatted level/reward info on display.
//
// One AI call per job per daily refresh. With 3 jobs we add 3 calls/day to
// the town's gen budget — negligible (~$0.0001/day per channel).
export interface JobListingFlavor {
  title: string;
  blurb: string;
}
export async function generateJobListing(
  ai: Ai,
  variant: "standard" | "boss" | "dungeon" | "gauntlet",
  townName: string,
): Promise<JobListingFlavor> {
  const variantHint = (() => {
    switch (variant) {
      case "standard": return "A single foe somewhere outside town. Modest difficulty.";
      case "boss": return "A named, beefy foe with two phases. Group recommended.";
      case "dungeon": return "A 5-7 room expedition with traps, lockboxes, NPC encounters, sub-boss + treasure.";
      case "gauntlet": return "Three monsters back-to-back with no rest between waves. No fleeing.";
    }
  })();
  const user = [
    `Generate a posting for a ${variant} job on the ${townName} job board.`,
    `Variant context: ${variantHint}`,
    "",
    "Return STRICTLY VALID JSON in this shape:",
    `{ "title": "<3-7 word evocative job title with software-engineering wink>", "blurb": "<1-2 sentence hook from the poster's perspective>" }`,
    "",
    "Examples:",
    `{ "title": "The Stale PR at the Merge Gate", "blurb": "A goblin is hoarding rebased commits up in the hills. Bring its scalp; we'll pay." }`,
    `{ "title": "Schemaless Shrieker — Sub-cellar", "blurb": "Something old has woken under the data temple. Two phases, by the rumors. Group up." }`,
    `{ "title": "Lost Sprint Crypts", "blurb": "Five rooms, locks, traps, and whatever's haunting the burndown chart. Bring keys." }`,
    "",
    "Output JSON ONLY. No prose. No code fences.",
  ].join("\n");

  const fallback: JobListingFlavor = (() => {
    switch (variant) {
      case "standard": return { title: "Goblin Trouble in the Outskirts", blurb: "Something's been ransacking the kanban field. Bring it down." };
      case "boss": return { title: "The Underlying Bug", blurb: "Old and stubborn, holed up in the temple ruins. Two phases by the rumors." };
      case "dungeon": return { title: "Sprint Crypts", blurb: "Five rooms, locks, traps. Bring keys and friends." };
      case "gauntlet": return { title: "The On-Call Rotation", blurb: "Three pages, three monsters, no rest between. Light a candle." };
    }
  })();

  try {
    const result = (await ai.run(MODEL, {
      messages: [
        { role: "system", content: "You output strictly valid JSON. No prose, no code fences." },
        { role: "user", content: user },
      ],
      max_tokens: 200,
    })) as AiRunResponse;
    const raw = (result.response ?? "").trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(raw) as Partial<JobListingFlavor>;
    if (typeof parsed.title === "string" && parsed.title.trim().length > 0
        && typeof parsed.blurb === "string" && parsed.blurb.trim().length > 0) {
      return { title: parsed.title.trim(), blurb: parsed.blurb.trim() };
    }
    return fallback;
  } catch {
    return fallback;
  }
}

// Tree-shape validator. Root must have:
//   - non-empty npc_says
//   - at least 2 player options
// Each top-level option must have:
//   - non-empty player_says
//   - a `next` node with non-empty npc_says
//   - at least 1 sub-option (we don't require 2 strictly — AI sometimes
//     gives 1, and a single sub-option still produces a working leaf)
// Tighter than the original > 0 check; loose enough that the AI doesn't
// fall back constantly when output is "good enough."
function isWellFormedDialogTree(t: AiDialogNode | null | undefined): boolean {
  if (!t || typeof t.npc_says !== "string" || t.npc_says.trim().length === 0) return false;
  if (!Array.isArray(t.options) || t.options.length < 2) return false;
  for (const opt of t.options) {
    if (!opt || typeof opt.player_says !== "string" || opt.player_says.trim().length === 0) return false;
    if (!opt.next || typeof opt.next.npc_says !== "string" || opt.next.npc_says.trim().length === 0) return false;
  }
  return true;
}

// Hand-written conversational backstop. Used when AI gen fails or returns
// malformed JSON. Generic enough to fit any archetype while still feeling
// in-character. Includes immediate-exchange payloads (rumor + gold) so
// failures don't strip rewards entirely — and the framing models the
// pattern we want AI gen to follow (exchange completes in-dialogue, no
// future tasks).
function fallbackDialogTree(input: NpcDialogInput): AiDialogNode {
  const isBartender = input.role === "bartender";
  return {
    npc_says: isBartender
      ? `${input.name} polishes a mug. "What'll it be, friend? Long day in the queue?"`
      : `${input.name} looks up from their drink. "Sit if you like. The bench is cheaper than the bar."`,
    options: [
      {
        player_says: "How's business?",
        next: {
          npc_says: isBartender
            ? "Busy enough. Three deploys went sideways this week and everyone's drowning their sorrows here."
            : "Same as ever. New tools, same old bugs.",
          options: [
            // Immediate exchange: player asks for gossip → NPC SHARES gossip (the payload).
            // The conversation completes in-place; there's no follow-up task.
            { player_says: "Anything worth hearing about?", next: { npc_says: "Word is something's stirring at the old merge gate. There — now you know what I know." }, payload: { type: "rumor", text: "Something's stirring at the old merge gate." } },
            { player_says: "Sounds rough.", next: { npc_says: "Aye. Drink up and try not to think about it." } },
          ],
        },
      },
      {
        player_says: "What's on your mind?",
        next: {
          // Immediate exchange: player offers a sympathetic ear → NPC pays a small
          // gold for the company. The reward lands as the NPC speaks; there's
          // no errand, no "come back tomorrow."
          npc_says: `${input.concern} — kind of you to listen. Here, a coin for the company.`,
          options: [
            { player_says: "Glad to help.", next: { npc_says: "Means more than you know, friend." }, payload: { type: "gold", amount: 4 } },
            { player_says: "Sorry to hear that.", next: { npc_says: "Don't be — just stand still a moment longer." }, payload: { type: "gold", amount: 4 } },
          ],
        },
      },
      {
        player_says: "Just passing through.",
        next: {
          npc_says: "Stay safe out there. The roads aren't what they were.",
          options: [
            { player_says: "Any advice?", next: { npc_says: "Keep your blade sharp and your dependencies pinned." } },
            { player_says: "Will do.", next: { npc_says: "Godspeed." } },
          ],
        },
      },
    ],
  };
}

// ── Phase 4: Graph Dungeon Generation ────────────────────────────────────────

// Programmatic topology for a graph dungeon with 7 rooms:
//
//   entrance ──[n]──► room_1 ──[n]──► junction
//                                        │
//                         [n] room_3    [e] room_2b  (optional branch)
//                              │              │
//                         boss_ante ◄──────────┘
//                              │
//                         boss_room
//
// Players use /gq move n/e/s/w to navigate. One optional branch room gives
// a choice moment. Boss kill triggers resolveVictory.
const GRAPH_TOPOLOGY: Array<{
  id: string;
  exits: Record<string, string>;
  role: "entrance" | "combat" | "safe" | "branch" | "boss_ante" | "boss";
}> = [
  { id: "entrance",  exits: { n: "room_1" },                          role: "entrance" },
  { id: "room_1",    exits: { s: "entrance", n: "junction" },         role: "combat" },
  { id: "junction",  exits: { s: "room_1", n: "room_3", e: "room_2b" }, role: "safe" },
  { id: "room_2b",   exits: { w: "junction" },                        role: "branch" },
  { id: "room_3",    exits: { s: "junction", n: "boss_ante" },        role: "combat" },
  { id: "boss_ante", exits: { s: "room_3", n: "boss_room" },          role: "boss_ante" },
  { id: "boss_room", exits: { s: "boss_ante" },                       role: "boss" },
];

export async function generateDungeonGraph(
  ai: Ai,
  theme: string,
  level: number,
  recentNames: string[] = [],
  art?: ArtTarget,
): Promise<DungeonGraph> {
  const descriptions = await generateGraphRoomDescriptions(ai, theme, level);
  const baseTier = Math.max(1, Math.ceil(level / 2));
  const encounterSlots = GRAPH_TOPOLOGY.filter(r => r.role === "combat" || r.role === "branch" || r.role === "boss");

  const monsterEntries = await Promise.all(
    encounterSlots.map(async (slot) => {
      const isBoss = slot.role === "boss";
      const tier = isBoss ? baseTier + 1 : baseTier;
      const hpFloor = isBoss ? 28 + level * 3 : 12 + level * 2;
      const hpCeil  = isBoss ? 40 + level * 5 : 22 + level * 3;
      const identity = await generateMonsterIdentity(ai, isBoss ? "boss" : "gauntlet-wave", hpFloor, hpCeil, recentNames);
      const artUrl = isBoss && art ? await generateMonsterArt(ai, art, identity.name, "boss", tier) : null;
      const spec: MonsterSpec = {
        name: identity.name,
        hp: identity.hp,
        max_hp: identity.hp,
        tier,
        is_boss: isBoss || undefined,
        art_url: artUrl,
      };
      return [slot.id, spec] as const;
    }),
  );
  const monsterByRoom = new Map(monsterEntries);

  // Pre-roll loot specs for the two loot-bearing rooms. Names/flavor are
  // placeholders — the take command calls flavorLootDrop at pickup time so
  // each player sees freshly-generated text rather than frozen graph text.
  const rollToLootSpec = (tier: number): LootOption => {
    const r = rollItem(tier);
    return {
      name: "Dungeon Find",
      item_type: r.type,
      power: r.power,
      rarity: r.rarity,
      flavor: "Found in the depths.",
      weapon_range: r.weapon_range ?? null,
      slot: r.slot ?? null,
      stat_bonus: (r.stat_bonus ?? null) as Record<string, number> | null,
      item_subtype: r.item_subtype ?? null,
    };
  };
  // junction gets an uncommon-biased roll (safe rest-stop feel);
  // room_2b (optional branch) gets a tier+1 roll as the risk/reward payoff.
  const junctionLoot = rollToLootSpec(baseTier);
  const branchLoot   = rollToLootSpec(Math.min(baseTier + 1, 5));

  const nodes: Record<string, DungeonNode> = {};
  for (const slot of GRAPH_TOPOLOGY) {
    const desc = descriptions[slot.id] ?? { name: slot.id, text: "A room in the dungeon." };
    let objects: DungeonObject[] = [];
    if (slot.id === "junction") {
      objects = [
        { id: "sign", name: "Faded Directory Sign", takeable: false, used: false,
          on_use: { effect: "flavor", text: "The sign reads: 'All paths lead to the same deadline.'" } },
        { id: "locker", name: "Maintenance Locker", takeable: true, used: false,
          on_use: { effect: "spawn_item", item: junctionLoot } },
      ];
    } else if (slot.id === "room_2b") {
      objects = [
        { id: "cache", name: "Abandoned Cache", takeable: true, used: false,
          on_use: { effect: "spawn_item", item: branchLoot } },
      ];
    }
    const monster = monsterByRoom.get(slot.id);
    nodes[slot.id] = {
      id: slot.id,
      name: desc.name,
      description: desc.text,
      exits: slot.exits as DungeonNode["exits"],
      objects,
      encounter: monster ? { monsters: [monster], cleared: false } : undefined,
      visited: slot.id === "entrance",
    };
  }

  return { nodes, current: "entrance", visited: ["entrance"] };
}

const GRAPH_ROLE_HINTS: Record<string, string> = {
  entrance:  "Entrance — no enemies, just atmosphere. Foreboding.",
  room_1:    "First combat room — tension. Something lurks here.",
  junction:  "Junction / crossroads — brief rest. Two paths diverge.",
  room_2b:   "Optional branch — dangerous, potentially rewarding.",
  room_3:    "Deep room — darker tone, battle ahead.",
  boss_ante: "Anteroom before the boss — dread, pre-battle quiet.",
  boss_room: "Boss chamber — final confrontation, dramatic and imposing.",
};

async function generateGraphRoomDescriptions(
  ai: Ai,
  theme: string,
  level: number,
): Promise<Record<string, { name: string; text: string }>> {
  const fallback: Record<string, { name: string; text: string }> = {
    entrance:  { name: "Server Lobby",      text: "Emergency lighting casts red shadows across overturned chairs. The air smells of burnt circuits." },
    room_1:    { name: "North Corridor",    text: "The overhead fluorescents flicker in a sickly rhythm. Something breathes in the dark." },
    junction:  { name: "Crossroads Hub",   text: "Two corridors diverge here. A faded directory sign offers no useful guidance." },
    room_2b:   { name: "Side Lab",          text: "Dust coats every surface like static. Old equipment hums as if still waiting for commands." },
    room_3:    { name: "Deep Server Bay",   text: "Banks of ancient servers blink status lights in no discernible pattern. Heat rolls off them in waves." },
    boss_ante: { name: "Ops Center",        text: "The door ahead is heavier than the others. The hum behind it is not mechanical." },
    boss_room: { name: "The Core",          text: "A pulsing node of compressed technical debt fills the room. It has been waiting for you." },
  };

  const user = [
    `Design a dungeon for a comedic engineering RPG. Theme: "${theme}". Player level: ${level}.`,
    `For each room below, output exactly: ID | Short Room Name (2-4 words) | Two atmospheric sentences (~40 words).`,
    `Use office/software imagery. Output only lines, no commentary.`,
    ``,
    ...GRAPH_TOPOLOGY.map(r => `${r.id}: ${GRAPH_ROLE_HINTS[r.id] ?? "Exploration room."}`),
  ].join("\n");

  try {
    const res = (await ai.run(MODEL, {
      messages: [
        { role: "system", content: "You write concise dungeon room descriptions. Follow the format exactly." },
        { role: "user", content: user },
      ],
      max_tokens: 700,
    })) as AiRunResponse;
    const text = (res.response ?? "").trim();
    const result: Record<string, { name: string; text: string }> = { ...fallback };
    for (const line of text.split("\n")) {
      const parts = line.split("|").map(s => s.trim());
      if (parts.length < 3) continue;
      const [rawId, rawName, ...rest] = parts;
      const id = rawId.toLowerCase().replace(/\s+/g, "_");
      const desc = rest.join(" ").trim();
      if (id && rawName && desc && id in fallback) {
        result[id] = { name: rawName, text: desc };
      }
    }
    return result;
  } catch {
    return fallback;
  }
}
