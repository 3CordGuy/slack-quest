// Placeholder 16-bit style sprites, drawn procedurally onto tiny canvases so
// milestone 1 needs no art files. Each sprite is an 18x22 pixel figure with
// a dark outline, sampled with nearest-neighbour filtering. Swap these for
// real sprite sheets later without touching the renderer: it only asks for
// a texture per `kind`.

import * as THREE from "three";

const W = 18;
const H = 22;
const OUTLINE = "#1b1830";

type Hat = "helm" | "wizard" | "hood" | "horns" | "none";
type Weapon = "sword" | "staff" | "daggers" | "club" | "none";

interface Look {
  skin: string;
  hair: string;
  body: string;
  legs: string;
  accent: string;
  hat: Hat;
  weapon: Weapon;
}

const LOOKS: Record<string, Look> = {
  qa_paladin: { skin: "#f1c9a5", hair: "#8a5a2b", body: "#c9ced6", legs: "#5b6475", accent: "#e0b12e", hat: "helm", weapon: "sword" },
  devops_mage: { skin: "#f1c9a5", hair: "#e8e8f0", body: "#4b5fd1", legs: "#2d357a", accent: "#7fe3ff", hat: "wizard", weapon: "staff" },
  refactor_rogue: { skin: "#d9a67c", hair: "#2b2b33", body: "#3d7a4f", legs: "#2f3b33", accent: "#b9433d", hat: "hood", weapon: "daggers" },
  npc: { skin: "#e8b891", hair: "#b9b9b9", body: "#a0683a", legs: "#5a4632", accent: "#e8dcc0", hat: "none", weapon: "none" },
  bandit: { skin: "#d9a67c", hair: "#3a2a20", body: "#7a2f2f", legs: "#3a3030", accent: "#1f1f1f", hat: "hood", weapon: "club" },
  cultist: { skin: "#cdb7d6", hair: "#2a1838", body: "#5b2a7a", legs: "#34194a", accent: "#e04fd0", hat: "hood", weapon: "staff" },
  villain: { skin: "#b8c7b0", hair: "#101010", body: "#2a2a35", legs: "#15151c", accent: "#e23b3b", hat: "horns", weapon: "sword" },
};

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
    px(4, 2, 8, 3, look.body);
    px(4, 5, 1, 4, look.body);
    px(11, 5, 1, 4, look.body);
  } else if (look.hat === "horns") {
    px(4, 0, 1, 3, look.accent);
    px(11, 0, 1, 3, look.accent);
    px(5, 2, 6, 1, look.accent);
  }

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
  }
}

function drawWolf(ctx: CanvasRenderingContext2D) {
  const px = (x: number, y: number, w: number, h: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(x + 1, y + 1, w, h);
  };
  const fur = "#7d8793";
  const dark = "#59616c";
  px(2, 11, 10, 4, fur); // body
  px(0, 10, 2, 2, dark); // tail
  px(10, 8, 5, 5, fur); // head
  px(14, 10, 2, 2, dark); // snout
  px(10, 6, 1, 2, dark); // ears
  px(13, 6, 1, 2, dark);
  px(13, 9, 1, 1, "#ffd23f"); // eye
  px(3, 15, 2, 4, dark); // legs
  px(9, 15, 2, 4, dark);
}

const cache = new Map<string, THREE.CanvasTexture>();

/** Texture for a hero class, enemy kind, or "npc". Unknown kinds get the bandit. */
export function spriteTexture(kind: string): THREE.CanvasTexture {
  const hit = cache.get(kind);
  if (hit) return hit;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  if (kind === "wolf") drawWolf(ctx);
  else drawHumanoid(ctx, LOOKS[kind] ?? LOOKS.bandit);
  finish(ctx);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  cache.set(kind, tex);
  return tex;
}

export const SPRITE_ASPECT = W / H;

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

/** A name tag. Returns the texture and its width-to-height ratio so the caller can size the sprite. */
export function labelTexture(text: string): { texture: THREE.CanvasTexture; aspect: number } {
  const font = "bold 20px ui-monospace, Menlo, monospace";
  const probe = document.createElement("canvas").getContext("2d")!;
  probe.font = font;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(probe.measureText(text).width) + 16;
  canvas.height = 28;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgba(27, 24, 48, 0.78)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#f1eee4";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 1);
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, aspect: canvas.width / canvas.height };
}
