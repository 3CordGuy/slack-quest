// Placeholder 16-bit style sprites, drawn procedurally onto tiny canvases so
// milestone 1 needs no art files. Each sprite is an 18x22 pixel figure with
// a dark outline, sampled with nearest-neighbour filtering. Swap these for
// real sprite sheets later without touching the renderer: it only asks for
// a texture per `kind`.

import * as THREE from "three";
import { ENEMIES, RARITY_COLOR, barPixels, healthBand, outfitKey, type HealthBand, type Outfit, type Slot } from "@gantt-quest/world";
import { LOOKS, mergeLook, type Look, type LookPalette } from "./looks";

const W = 18;
const H = 22;
const OUTLINE = "#1b1830";

function finish(ctx: CanvasRenderingContext2D): void {
  // Outline: any empty pixel touching a filled one becomes the outline colour.
  const img = ctx.getImageData(0, 0, W, H);
  const filled = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && img.data[(y * W + x) * 4 + 3] > 0;
  ctx.fillStyle = OUTLINE;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (filled(x, y)) continue;
      if (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1)) ctx.fillRect(x, y, 1, 1);
    }
  }
}

type Px = (x: number, y: number, w: number, h: number, c: string) => void;

/** The headgear a class or enemy has by default. */
function drawHat(px: Px, look: Look) {
  if (look.hat === "helm") {
    px(5, 2, 6, 3, "#aeb6c2");
    px(5, 5, 1, 2, "#aeb6c2");
    px(10, 5, 1, 2, "#aeb6c2");
    px(7, 1, 2, 1, look.accent);
  } else if (look.hat === "wizard") {
    px(8, 0, 1, 1, look.body);
    px(7, 1, 3, 1, look.body);
    px(6, 2, 5, 1, look.body);
    px(4, 3, 8, 1, look.accent);
  } else if (look.hat === "hood") {
    const c = look.hatColor ?? look.body;
    px(4, 2, 8, 3, c);
    px(4, 5, 1, 4, c);
    px(11, 5, 1, 4, c);
  } else if (look.hat === "leaves") {
    // A crown of leaves.
    px(5, 2, 6, 1, look.accent);
    px(4, 1, 2, 2, look.accent);
    px(7, 1, 2, 1, look.accent);
    px(10, 1, 2, 2, look.accent);
    px(6, 2, 1, 1, look.body);
  } else if (look.hat === "feather") {
    // A floppy cap with a feather.
    px(4, 2, 8, 2, look.body);
    px(3, 3, 1, 1, look.body);
    px(10, 0, 1, 2, look.accent);
    px(11, 0, 1, 1, look.accent);
  } else if (look.hat === "circlet") {
    px(5, 3, 6, 1, look.accent);
    px(7, 2, 2, 1, "#7fe3ff");
  } else if (look.hat === "brim") {
    // A wide-brimmed travelling hat with a band.
    const c = look.hatColor ?? look.body;
    px(2, 4, 12, 1, c);
    px(5, 1, 6, 3, c);
    px(5, 3, 6, 1, look.accent);
  } else if (look.hat === "turban") {
    const c = look.hatColor ?? look.accent;
    px(4, 1, 8, 3, c);
    px(6, 0, 4, 1, c);
    px(7, 2, 2, 1, look.accent);
  } else if (look.hat === "kerchief") {
    // A cloth knotted over the head, tails at the back.
    const c = look.hatColor ?? look.accent;
    px(5, 2, 6, 2, c);
    px(11, 3, 1, 2, c);
    px(12, 4, 1, 1, c);
  } else if (look.hat === "greathelm") {
    // A heavy closed helm: the whole head in iron, a dark slit to see through, a crest on top.
    const c = look.hatColor ?? "#8b95a5";
    px(4, 2, 8, 6, c);
    px(5, 1, 6, 1, c);
    px(5, 5, 6, 1, OUTLINE);
    px(8, 6, 1, 2, OUTLINE);
    px(7, 0, 2, 1, look.accent);
    px(4, 8, 8, 1, c);
  } else if (look.hat === "horns") {
    px(4, 0, 1, 3, look.accent);
    px(11, 0, 1, 3, look.accent);
    px(5, 2, 6, 1, look.accent);
  }
}

function drawHumanoid(ctx: CanvasRenderingContext2D, look: Look) {
  const px = (x: number, y: number, w: number, h: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(x + 1, y + 1, w, h);
  };
  // Legs and boots.
  px(5, 15, 2, 4, look.legs);
  px(9, 15, 2, 4, look.legs);
  px(5, 18, 2, 1, OUTLINE);
  px(9, 18, 2, 1, OUTLINE);
  // Torso, belt, arms, hands.
  px(4, 9, 8, 6, look.body);
  px(4, 13, 8, 1, look.accent);
  px(3, 9, 1, 5, look.body);
  px(12, 9, 1, 5, look.body);
  px(3, 14, 1, 1, look.skin);
  px(12, 14, 1, 1, look.skin);
  // Head, hair, eyes.
  px(5, 3, 6, 6, look.skin);
  px(5, 3, 6, 2, look.hair);
  px(7, 6, 1, 1, OUTLINE);
  px(9, 6, 1, 1, OUTLINE);

  // A traveller's long coat, open at the front, down over the legs.
  if (look.coat) {
    px(4, 14, 3, 3, look.body);
    px(9, 14, 3, 3, look.body);
    px(4, 9, 1, 8, look.accent);
    px(11, 9, 1, 8, look.accent);
  }

  drawHat(px, look);

  if (look.weapon === "sword") {
    px(13, 5, 1, 8, "#dfe6ee");
    px(12, 13, 3, 1, look.accent);
  } else if (look.weapon === "staff") {
    px(13, 3, 1, 15, "#7a5230");
    px(12, 1, 3, 2, look.accent);
  } else if (look.weapon === "daggers") {
    px(2, 11, 1, 3, "#dfe6ee");
    px(13, 11, 1, 3, "#dfe6ee");
  } else if (look.weapon === "club") {
    px(13, 7, 2, 7, "#7a5230");
  } else if (look.weapon === "lute") {
    px(12, 10, 3, 4, "#a0683a");
    px(13, 5, 1, 5, "#7a5230");
    px(13, 11, 1, 1, OUTLINE);
  } else if (look.weapon === "orb") {
    px(13, 9, 1, 6, "#7a5230");
    px(12, 6, 3, 3, look.accent);
    px(13, 7, 1, 1, "#ffffff");
  } else if (look.weapon === "axe_shield") {
    // A big axe in the right hand, a tower shield covering the left side.
    px(13, 4, 1, 12, "#7a5230");
    px(14, 4, 2, 4, "#c9d1dc");
    px(15, 3, 1, 6, "#c9d1dc");
    px(0, 8, 4, 9, "#6f7480");
    px(1, 9, 2, 7, look.accent);
    px(1, 12, 2, 1, "#c9d1dc");
  } else if (look.weapon === "grimoire") {
    // A dark book held open, its pages glowing.
    px(12, 11, 4, 4, "#3a2a4a");
    px(12, 11, 4, 1, look.accent);
    px(13, 12, 2, 2, look.accent);
    px(13, 9, 1, 1, look.accent);
    px(15, 8, 1, 1, look.accent);
  } else if (look.weapon === "lantern") {
    // A lit lantern held out on its ring.
    px(13, 10, 1, 2, "#6f7480");
    px(12, 12, 3, 1, "#6f7480");
    px(12, 13, 3, 2, "#ffd98a");
    px(12, 15, 3, 1, "#6f7480");
  } else if (look.weapon === "scroll") {
    // Rolled plans under the arm, tied with blue.
    px(11, 11, 5, 2, "#e8dcc0");
    px(15, 11, 1, 2, "#c9b58a");
    px(13, 11, 1, 2, "#3f6fa8");
  } else if (look.weapon === "pack") {
    // A big pack on the back, showing past the shoulder, with a rolled blanket on top.
    px(0, 8, 3, 7, "#7a5230");
    px(0, 7, 3, 1, look.accent);
    px(1, 11, 1, 1, "#e0b12e");
  } else if (look.weapon === "basket") {
    // A basket of greens on the arm.
    px(12, 12, 4, 3, "#b98b5a");
    px(12, 11, 1, 1, "#b98b5a");
    px(15, 11, 1, 1, "#b98b5a");
    px(13, 11, 2, 1, "#6fae4a");
    px(13, 13, 2, 1, "#8a6a44");
  } else if (look.weapon === "bow") {
    px(13, 6, 1, 1, "#7a5230");
    px(14, 7, 1, 7, "#7a5230");
    px(13, 14, 1, 1, "#7a5230");
    px(13, 7, 1, 7, look.accent);
  }
}

const GEAR = { steel: "#c9d1dc", shine: "#f1f5fa", iron: "#8b95a5", wood: "#8a5a2b", leather: "#a0683a", gold: "#e0b12e", paper: "#e8dcc0", bone: "#eee6cf", dark: "#2a2740" };

/**
 * A hero wearing what they have equipped. The body is the class's own
 * colours; every worn item is drawn over it where it belongs: helmet or
 * hood on the head (the class's own hat shows until one is equipped), armor on the torso and legs, boots on the feet, the
 * main-hand weapon at the right of the picture and a shield at the left.
 * Each item's rarity colour shows as its trim.
 */
function drawHero(ctx: CanvasRenderingContext2D, look: Look, outfit: Outfit) {
  const px = (x: number, y: number, w: number, h: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(x + 1, y + 1, w, h);
  };
  const trim = (slot: Slot) => RARITY_COLOR[outfit[slot]!.rarity];

  // Legs and feet.
  const legs = outfit.legs ? GEAR.iron : look.legs;
  px(5, 15, 2, 4, legs);
  px(9, 15, 2, 4, legs);
  if (outfit.legs) {
    px(5, 16, 2, 1, GEAR.steel);
    px(9, 16, 2, 1, GEAR.steel);
    px(5, 15, 6, 1, trim("legs"));
  }
  if (outfit.boots) {
    px(4, 17, 3, 2, GEAR.leather);
    px(9, 17, 3, 2, GEAR.leather);
    px(5, 17, 2, 1, trim("boots"));
    px(9, 17, 2, 1, trim("boots"));
  } else {
    px(5, 18, 2, 1, OUTLINE);
    px(9, 18, 2, 1, OUTLINE);
  }

  // Torso and arms.
  const torso = outfit.body ? GEAR.iron : look.body;
  px(4, 9, 8, 6, torso);
  px(3, 9, 1, 5, torso);
  px(12, 9, 1, 5, torso);
  px(3, 14, 1, 1, look.skin);
  px(12, 14, 1, 1, look.skin);
  if (outfit.body) {
    px(3, 9, 2, 2, GEAR.steel);
    px(11, 9, 2, 2, GEAR.steel);
    px(7, 11, 2, 2, trim("body"));
    px(4, 13, 8, 1, GEAR.gold);
  } else {
    px(4, 13, 8, 1, look.accent);
  }
  if (outfit.amulet) {
    px(6, 9, 4, 1, GEAR.gold);
    px(7, 10, 2, 1, trim("amulet"));
  }
  if (outfit.ring) px(12, 14, 1, 1, trim("ring"));

  // Head.
  px(5, 3, 6, 6, look.skin);
  px(5, 3, 6, 2, look.hair);
  px(7, 6, 1, 1, OUTLINE);
  px(9, 6, 1, 1, OUTLINE);
  const helmet = outfit.helmet?.icon;
  if (helmet === "hood") {
    px(7, 1, 2, 1, GEAR.leather);
    px(4, 2, 8, 3, GEAR.leather);
    px(4, 5, 1, 5, GEAR.leather);
    px(11, 5, 1, 5, GEAR.leather);
    px(5, 4, 6, 1, trim("helmet"));
  } else if (helmet === "brutal-helm") {
    px(3, 0, 1, 3, GEAR.bone);
    px(12, 0, 1, 3, GEAR.bone);
    px(4, 2, 8, 4, GEAR.iron);
    px(5, 6, 6, 1, GEAR.dark);
    px(7, 6, 1, 1, trim("helmet"));
    px(9, 6, 1, 1, trim("helmet"));
    px(5, 7, 1, 2, GEAR.iron);
    px(10, 7, 1, 2, GEAR.iron);
  } else if (helmet) {
    px(7, 0, 2, 2, trim("helmet"));
    px(5, 2, 6, 3, GEAR.steel);
    px(4, 3, 1, 4, GEAR.steel);
    px(11, 3, 1, 4, GEAR.steel);
    px(5, 5, 1, 3, GEAR.steel);
    px(10, 5, 1, 3, GEAR.steel);
    px(8, 5, 1, 1, GEAR.steel);
  } else {
    // No helmet equipped: the class keeps its own hat.
    drawHat(px, look);
  }

  // Main hand: at the right of the picture.
  const weapon = outfit.main_hand?.ref;
  if (weapon === "mace") {
    px(13, 8, 1, 8, GEAR.wood);
    px(12, 5, 3, 3, GEAR.iron);
    px(13, 6, 1, 1, trim("main_hand"));
  } else if (weapon === "greatsword") {
    px(13, 1, 1, 1, GEAR.shine);
    px(13, 2, 2, 11, GEAR.steel);
    px(13, 2, 1, 11, GEAR.shine);
    px(12, 13, 4, 1, GEAR.gold);
    px(13, 14, 1, 1, GEAR.wood);
    px(13, 15, 1, 1, trim("main_hand"));
  } else if (weapon === "staff") {
    px(13, 4, 1, 15, GEAR.wood);
    px(12, 1, 3, 3, trim("main_hand"));
    px(13, 2, 1, 1, GEAR.shine);
  } else if (weapon === "tome") {
    px(12, 11, 4, 4, trim("main_hand"));
    px(12, 11, 1, 4, GEAR.dark);
    px(14, 12, 1, 2, GEAR.gold);
  } else if (weapon === "daggers") {
    px(13, 9, 1, 5, GEAR.steel);
    px(12, 14, 3, 1, trim("main_hand"));
    // The second dagger goes in the other hand unless a shield is there.
    if (!outfit.off_hand) {
      px(2, 9, 1, 5, GEAR.steel);
      px(1, 14, 3, 1, trim("main_hand"));
    }
  } else if (weapon === "root_staff") {
    px(13, 4, 1, 15, GEAR.wood);
    px(12, 2, 1, 2, GEAR.wood);
    px(14, 1, 1, 3, GEAR.wood);
    px(12, 1, 1, 1, trim("main_hand"));
    px(14, 0, 1, 1, "#a6d06a");
  } else if (weapon === "sickle") {
    px(13, 9, 1, 6, GEAR.wood);
    px(12, 5, 1, 4, GEAR.steel);
    px(13, 4, 2, 1, GEAR.steel);
    px(15, 5, 1, 1, GEAR.steel);
    px(13, 15, 1, 1, trim("main_hand"));
  } else if (weapon === "lute") {
    px(12, 10, 3, 4, GEAR.leather);
    px(13, 5, 1, 5, GEAR.wood);
    px(13, 11, 1, 1, GEAR.dark);
    px(13, 4, 1, 1, trim("main_hand"));
  } else if (weapon === "flute") {
    px(13, 6, 1, 9, GEAR.paper);
    px(13, 8, 1, 1, GEAR.dark);
    px(13, 11, 1, 1, GEAR.dark);
    px(13, 5, 1, 1, trim("main_hand"));
  } else if (weapon === "orb") {
    px(13, 9, 1, 7, GEAR.wood);
    px(12, 5, 3, 4, trim("main_hand"));
    px(13, 6, 1, 1, GEAR.shine);
  } else if (weapon === "scepter") {
    px(13, 6, 1, 10, GEAR.gold);
    px(12, 3, 3, 3, trim("main_hand"));
    px(12, 2, 1, 1, GEAR.gold);
    px(14, 2, 1, 1, GEAR.gold);
  } else if (weapon === "pager_axe") {
    // A long haft and a broad single blade.
    px(13, 4, 1, 12, GEAR.wood);
    px(14, 4, 2, 4, GEAR.steel);
    px(15, 3, 1, 6, GEAR.steel);
    px(14, 5, 1, 2, GEAR.shine);
    px(13, 15, 1, 1, trim("main_hand"));
  } else if (weapon === "maul") {
    // A heavy hammer: a block of iron on a long haft, clear of the helm.
    px(14, 6, 1, 10, GEAR.wood);
    px(13, 2, 4, 4, GEAR.iron);
    px(13, 2, 4, 1, GEAR.steel);
    px(14, 3, 2, 2, trim("main_hand"));
  } else if (weapon === "grimoire") {
    // A dark tome with glowing pages, its spine in the rarity colour.
    px(12, 11, 4, 4, GEAR.dark);
    px(12, 11, 1, 4, trim("main_hand"));
    px(13, 11, 3, 1, "#6dff9e");
    px(13, 12, 2, 2, "#6dff9e");
    px(14, 9, 1, 1, "#6dff9e");
  } else if (weapon === "void_staff") {
    // A black staff with a hollow ring at the top and a spark inside it.
    px(13, 5, 1, 14, GEAR.dark);
    px(12, 1, 3, 1, GEAR.dark);
    px(12, 4, 3, 1, GEAR.dark);
    px(12, 2, 1, 2, GEAR.dark);
    px(14, 2, 1, 2, GEAR.dark);
    px(13, 2, 1, 2, trim("main_hand"));
  } else if (weapon === "shortbow") {
    px(13, 6, 1, 1, GEAR.wood);
    px(14, 7, 1, 7, GEAR.wood);
    px(13, 14, 1, 1, GEAR.wood);
    px(13, 7, 1, 7, GEAR.paper);
    px(14, 10, 1, 2, trim("main_hand"));
  }

  // Off hand: a shield at the left of the picture, in front of the arm.
  const shield = outfit.off_hand?.icon;
  if (shield === "round-shield") {
    px(1, 9, 2, 6, GEAR.iron);
    px(0, 10, 4, 4, GEAR.iron);
    px(1, 11, 2, 2, trim("off_hand"));
  } else if (shield) {
    px(0, 8, 4, 6, GEAR.iron);
    px(1, 14, 2, 1, GEAR.iron);
    px(1, 9, 2, 4, trim("off_hand"));
    px(1, 9, 2, 1, GEAR.steel);
  }
}

function drawWolf(ctx: CanvasRenderingContext2D, fur = "#7d8793", dark = "#59616c", eye = "#ffd23f") {
  const px = (x: number, y: number, w: number, h: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(x + 1, y + 1, w, h);
  };
  px(2, 11, 10, 4, fur); // body
  px(0, 10, 2, 2, dark); // tail
  px(10, 8, 5, 5, fur); // head
  px(14, 10, 2, 2, dark); // snout
  px(10, 6, 1, 2, dark); // ears
  px(13, 6, 1, 2, dark);
  px(13, 9, 1, 1, eye);
  px(3, 15, 2, 4, dark); // legs
  px(9, 15, 2, 4, dark);
}

/** The sparring ring's training dummy: a straw sack on a post, with a target painted on its chest. */
function drawDummy(ctx: CanvasRenderingContext2D) {
  const px = (x: number, y: number, w: number, h: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(x + 1, y + 1, w, h);
  };
  const straw = "#d9b662";
  const shade = "#b08d3e";
  px(7, 14, 2, 5, GEAR.wood); // post
  px(4, 19, 8, 1, GEAR.wood); // foot
  px(2, 9, 12, 2, GEAR.wood); // crossbar arms
  px(2, 8, 1, 4, shade); // straw tufts at the hands
  px(13, 8, 1, 4, shade);
  px(4, 8, 8, 7, straw); // sack body
  px(4, 14, 8, 1, shade);
  px(6, 9, 4, 4, "#f4efe2"); // target
  px(7, 10, 2, 2, "#c8433d");
  px(5, 2, 6, 6, straw); // head
  px(5, 7, 6, 1, GEAR.leather); // rope at the neck
  px(6, 4, 1, 1, OUTLINE); // stitched eyes and mouth
  px(9, 4, 1, 1, OUTLINE);
  px(7, 6, 2, 1, shade);
}

const cache = new Map<string, THREE.CanvasTexture>();

// Admin palette overrides (from the content bundle), laid over LOOKS. Every
// change bumps the revision, which is part of every sprite key: the cache
// starts afresh and the world renderer, which compares keys, redraws units.
let palettes: Record<string, LookPalette> = {};
let revision = 0;

/** Replace the palette overrides in force. Sprites drawn from now on use them. */
export function setLookOverrides(next: Record<string, LookPalette>): void {
  if (JSON.stringify(next) === JSON.stringify(palettes)) return;
  palettes = next;
  revision++;
  cache.clear();
}

/** A kind's look as currently drawn: the stock look with any admin palette over it. Unknown kinds get the bandit. */
export function lookFor(kind: string): Look {
  return mergeLook(LOOKS[kind] ?? LOOKS.bandit, palettes[kind]);
}

/** Cache key for a sprite: the kind plus whatever is being worn, whether they are asleep, and the overrides in force. */
export function spriteKey(kind: string, outfit?: Outfit, asleep = false): string {
  return (outfit ? `${kind}|${outfitKey(outfit)}` : kind) + (asleep ? "|zz" : "") + `|r${revision}`;
}

/** Flip the canvas left to right, in place. */
function mirror(ctx: CanvasRenderingContext2D) {
  const img = ctx.getImageData(0, 0, W, H);
  const out = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const from = (y * W + x) * 4;
      const to = (y * W + (W - 1 - x)) * 4;
      for (let k = 0; k < 4; k++) out.data[to + k] = img.data[from + k];
    }
  }
  ctx.putImageData(out, 0, 0);
}

/** Draw one sprite onto a fresh canvas. Shared by the cached textures and the admin preview. */
function drawSprite(kind: string, look: Look, outfit: Outfit | undefined, asleep: boolean): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  if (kind === "wolf") drawWolf(ctx);
  // The pack leader: the same animal, darker, with a red eye. The renderer draws it larger.
  else if (kind === "alpha") drawWolf(ctx, "#4a4f5c", "#2c3039", "#ff4d4d");
  else if (kind === "dummy") drawDummy(ctx);
  else if (outfit) drawHero(ctx, look, outfit);
  else drawHumanoid(ctx, look);
  // Asleep: the eyes are shut, a short dark line where each one was.
  if (asleep && LOOKS[kind]) {
    ctx.fillStyle = look.skin;
    ctx.fillRect(8, 7, 1, 1);
    ctx.fillRect(10, 7, 1, 1);
    ctx.fillStyle = OUTLINE;
    ctx.fillRect(7, 7, 2, 1);
    ctx.fillRect(10, 7, 2, 1);
  }
  // Everything is drawn facing right (a wolf's nose, a weapon in the right of the picture).
  // Enemies line up on the right of the arena, so turn them round to face the heroes.
  if (ENEMIES[kind] && !outfit) mirror(ctx);
  finish(ctx);
  return canvas;
}

/**
 * Texture for a hero class, enemy kind, or "npc". Unknown kinds get the
 * bandit. Pass a hero's outfit to draw them wearing it; without one the
 * kind's stock look is used.
 */
export function spriteTexture(kind: string, outfit?: Outfit, asleep = false): THREE.CanvasTexture {
  const key = spriteKey(kind, outfit, asleep);
  const hit = cache.get(key);
  if (hit) return hit;
  const tex = new THREE.CanvasTexture(drawSprite(kind, lookFor(kind), outfit, asleep));
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, tex);
  return tex;
}

/**
 * A sprite drawn with a given palette (undefined: the stock look) rather than
 * the one in force, as an image URL: the admin page's live preview. Same
 * drawing code as the game, no cache.
 */
export function previewSpriteUrl(kind: string, palette: LookPalette | undefined, outfit?: Outfit, asleep = false): string {
  return drawSprite(kind, mergeLook(LOOKS[kind] ?? LOOKS.bandit, palette), outfit, asleep).toDataURL();
}

export const SPRITE_ASPECT = W / H;

/** The same sprite as an image URL, for use in the HUD. */
export function spriteDataUrl(kind: string, outfit?: Outfit): string {
  return (spriteTexture(kind, outfit).image as HTMLCanvasElement).toDataURL();
}

let zTexture: THREE.CanvasTexture | null = null;

/** A pixel-art "Z" for someone asleep: pale blue with a dark outline. Shared by every sleeper. */
export function sleepZTexture(): THREE.CanvasTexture {
  if (zTexture) return zTexture;
  const canvas = document.createElement("canvas");
  canvas.width = 9;
  canvas.height = 9;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#dbe9ff";
  ctx.fillRect(2, 2, 5, 1);
  ctx.fillRect(5, 3, 1, 1);
  ctx.fillRect(4, 4, 1, 1);
  ctx.fillRect(3, 5, 1, 1);
  ctx.fillRect(2, 6, 5, 1);
  // A one-pixel dark outline around the letter.
  const img = ctx.getImageData(0, 0, 9, 9);
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < 9 && y < 9 && img.data[(y * 9 + x) * 4 + 3] > 0;
  ctx.fillStyle = OUTLINE;
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) if (!on(x, y) && (on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1))) ctx.fillRect(x, y, 1, 1);
  zTexture = new THREE.CanvasTexture(canvas);
  zTexture.magFilter = THREE.NearestFilter;
  zTexture.minFilter = THREE.NearestFilter;
  zTexture.generateMipmaps = false;
  zTexture.colorSpace = THREE.SRGBColorSpace;
  return zTexture;
}

/** A short text label as a pixel-crisp texture, for floating combat numbers. */
export function textTexture(text: string, color: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 24;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "bold 18px ui-monospace, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 4;
  ctx.strokeStyle = OUTLINE;
  ctx.strokeText(text, 32, 12);
  ctx.fillStyle = color;
  ctx.fillText(text, 32, 12);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** What a hero's overhead plate shows under their name: level, and how full their HP and XP are (0 to 1). */
export interface PlateStats {
  level: number;
  hp: number;
  xp: number;
}

const PLATE_BG: [number, number, number, number] = [27, 24, 48, 225];
const NAME_INK: [number, number, number] = [241, 238, 228];
const LEVEL_INK: [number, number, number] = [255, 210, 63];
const BAR_TRACK = "#3b3560";
const HP_COLOR: Record<HealthBand, string> = { good: "#6ee06e", hurt: "#ffd23f", low: "#ff6b6b" };
const XP_COLOR = "#7d8cff";
/** Rows of the name line, then the HP bar (3 rows), a gap, the XP bar (2 rows) and a margin. */
const NAME_ROWS = 15;
const PLATE_ROWS = NAME_ROWS + 6;
/** Bars never shorter than this, so a short name still gets a readable bar. */
const MIN_PLATE_WIDTH = 34;

/** The key a plate is cached and redrawn by: it changes only when a pixel of it would. */
export function plateKey(text: string, plate?: PlateStats): string {
  if (!plate) return text;
  const width = plateWidth(text, plate);
  const inner = width - 6;
  return `${text}|${plate.level}|${barPixels(plate.hp, inner)}:${healthBand(plate.hp)}|${barPixels(plate.xp, inner)}`;
}

const LABEL_FONT = "12px ui-monospace, Menlo, Consolas, monospace";
let measurer: CanvasRenderingContext2D | null = null;
function measure(text: string): number {
  if (!measurer) {
    measurer = document.createElement("canvas").getContext("2d")!;
    measurer.font = LABEL_FONT;
    (measurer as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "1px";
  }
  return Math.ceil(measurer.measureText(text).width);
}
const levelText = (plate: PlateStats) => `Lv${plate.level}`;
function plateWidth(text: string, plate?: PlateStats): number {
  if (!plate) return measure(text) + 8;
  return Math.max(MIN_PLATE_WIDTH, measure(levelText(plate)) + 6 + measure(text) + 8);
}

/**
 * A name tag, and with `plate` a hero's overhead plate: their level in gold
 * beside the name, then a thin HP bar (green, yellow, red as it drops) and a
 * thinner XP bar. Every pixel is solid, so it stays as crisp as the sprite.
 * Returns the texture, its width-to-height ratio, and how many of its rows
 * are the name line (the rest sit under it).
 */
export function labelTexture(text: string, plate?: PlateStats): { texture: THREE.CanvasTexture; aspect: number } {
  // Drawn small and then snapped to solid pixels, so a name is as hard-edged as the sprite under it.
  // Regular weight at this size gives strokes one pixel wide; bold fills the letters in.
  const canvas = document.createElement("canvas");
  canvas.width = plateWidth(text, plate);
  canvas.height = plate ? PLATE_ROWS : NAME_ROWS;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.font = LABEL_FONT;
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "1px";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  const mid = NAME_ROWS / 2 + 1;
  // Where the gold level ends and the name begins.
  let split = 0;
  if (plate) {
    const lv = levelText(plate);
    const lvW = measure(lv);
    const nameW = measure(text);
    const left = Math.floor((canvas.width - (lvW + 6 + nameW)) / 2);
    ctx.textAlign = "left";
    ctx.fillText(lv, left, mid);
    ctx.fillText(text, left + lvW + 6, mid);
    split = left + lvW + 3;
  } else {
    ctx.textAlign = "center";
    ctx.fillText(text, canvas.width / 2, mid);
  }
  // Every pixel becomes either text or plate: no soft edges for the sampler to smear.
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = image.data;
  for (let k = 0; k < px.length; k += 4) {
    const ink = px[k + 3] >= 96;
    const x = (k / 4) % canvas.width;
    const colour = x < split ? LEVEL_INK : NAME_INK;
    px[k] = ink ? colour[0] : PLATE_BG[0];
    px[k + 1] = ink ? colour[1] : PLATE_BG[1];
    px[k + 2] = ink ? colour[2] : PLATE_BG[2];
    px[k + 3] = ink ? 255 : PLATE_BG[3];
  }
  ctx.putImageData(image, 0, 0);
  if (plate) {
    const x0 = 3;
    const inner = canvas.width - 6;
    const bar = (y: number, rows: number, fraction: number, colour: string) => {
      ctx.fillStyle = BAR_TRACK;
      ctx.fillRect(x0, y, inner, rows);
      const filled = barPixels(fraction, inner);
      if (filled > 0) {
        ctx.fillStyle = colour;
        ctx.fillRect(x0, y, filled, rows);
      }
    };
    bar(NAME_ROWS - 1, 3, plate.hp, HP_COLOR[healthBand(plate.hp)]);
    bar(NAME_ROWS + 3, 2, plate.xp, XP_COLOR);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, aspect: canvas.width / canvas.height };
}

// ---------- battle effects ----------

export type FxKind = "slash" | "bolt" | "arrow" | "burst" | "spark";

const fxCache = new Map<string, THREE.CanvasTexture>();

/**
 * A small pixel effect in one colour: a crescent swipe, a spell bolt, an
 * arrow, an impact burst, or healing sparkles. `flip` mirrors it for
 * attacks travelling right to left.
 */
export function fxTexture(kind: FxKind, color: string, flip = false): THREE.CanvasTexture {
  const key = `${kind}|${color}|${flip}`;
  const hit = fxCache.get(key);
  if (hit) return hit;
  const N = 16;
  const canvas = document.createElement("canvas");
  canvas.width = N;
  canvas.height = N;
  const ctx = canvas.getContext("2d")!;
  const dot = (x: number, y: number, c = color) => {
    ctx.fillStyle = c;
    ctx.fillRect(flip ? N - 1 - x : x, y, 1, 1);
  };
  if (kind === "slash") {
    // A crescent sweeping from upper left round to lower right, thickest in the middle.
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const dx = x - 2.5;
        const dy = y - 13.5;
        const d = Math.hypot(dx, dy);
        const a = Math.atan2(-dy, dx);
        if (a < 0.05 || a > 1.5) continue;
        const width = 0.6 + 2.6 * Math.sin(((a - 0.05) / 1.45) * Math.PI);
        if (Math.abs(d - 11) <= width / 2 + 0.3) dot(x, y, Math.abs(d - 11.4) < 0.7 ? "#ffffff" : color);
      }
    }
  } else if (kind === "bolt") {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const d = Math.hypot(x - 9.5, y - 7.5);
      if (d < 3.6) dot(x, y, d < 1.8 ? "#ffffff" : color);
    }
    // A short trail behind it.
    for (let x = 1; x < 6; x++) if (x % 2) dot(x, 7);
    dot(3, 9);
    dot(4, 5);
  } else if (kind === "arrow") {
    for (let x = 2; x < 12; x++) dot(x, 8, "#e8dcc0");
    dot(12, 8);
    dot(13, 8);
    dot(11, 7);
    dot(11, 9);
    dot(12, 7);
    dot(12, 9);
    dot(2, 7, "#ffffff");
    dot(2, 9, "#ffffff");
    dot(3, 7, "#ffffff");
    dot(3, 9, "#ffffff");
  } else if (kind === "burst") {
    for (let i = 2; i < 7; i++) {
      dot(8 + i, 8);
      dot(7 - i, 8);
      dot(8, 8 + i - 1);
      dot(8, 7 - i + 1);
    }
    for (let i = 2; i < 5; i++) {
      dot(8 + i, 8 + i);
      dot(7 - i, 7 - i);
      dot(8 + i, 7 - i);
      dot(7 - i, 8 + i);
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(7, 7, 2, 2);
  } else {
    for (const [cx, cy] of [[4, 4], [11, 6], [6, 11], [12, 12]]) {
      dot(cx, cy, "#ffffff");
      dot(cx - 1, cy);
      dot(cx + 1, cy);
      dot(cx, cy - 1);
      dot(cx, cy + 1);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  fxCache.set(key, tex);
  return tex;
}
