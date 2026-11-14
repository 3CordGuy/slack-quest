// Pixel art for the pub's Ship, Captain & Crew table: what a held die shows in
// place of its pips. The 6 is the ship, the 5 the captain, the 4 the crew. Each
// is a 16-pixel picture, painted straight onto a die's face in the table scene
// (render/TableStage.ts) and handed to the panel as an image URL, shown at a
// whole multiple with `image-rendering: pixelated` to match the sprites.

export type CrewFace = 4 | 5 | 6;
export const CREW_ART_PX = 16;
export const CREW_FACE_NAME: Record<CrewFace, string> = { 6: "Ship", 5: "Captain", 4: "Crew" };
export const isCrewFace = (v: number): v is CrewFace => v === 4 || v === 5 || v === 6;

const PALETTE: Record<string, string> = {
  k: "#1b1830", // ink
  r: "#b9433d", // red: pennant, coat, bandana
  m: "#3a2414", // mast, beard
  w: "#efe4c8", // sail, shirt
  h: "#6b3f1f", // hull
  g: "#d9a43a", // gold
  b: "#3f6fa8", // sea, stripes
  c: "#7db6f2", // wave caps
  s: "#e8b38a", // skin
  e: "#1b1830", // eyes
  n: "#22202e", // hat
};

const ART: Record<CrewFace, string[]> = {
  6: [
    "........rr......",
    "........rrr.....",
    "........m.......",
    "......kkmkk.....",
    ".....kwwmwwk....",
    ".....kwwmwwk..m.",
    "....kwwwmwwwk.m.",
    "....kwwwmwwwkkm.",
    "....kkkkmkkkkwk.",
    "........m....k..",
    ".khhhhhhhhhhhhk.",
    "..khggggggggghk.",
    "...khhhhhhhhhk..",
    "..bbbcbbbbcbbbb.",
    ".bbcbbbbcbbbbcbb",
    "................",
  ],
  5: [
    "................",
    "...kkkkkkkkkk...",
    "..knnnnnnnnnnk..",
    ".knnnnngnnnnnnk.",
    "knnnnnngnnnnnnnk",
    ".kkkkkkkkkkkkkk.",
    "....kssssssk....",
    "....sesssses....",
    "....ssssssss....",
    "....smmmmmms....",
    ".....mmmmmm.....",
    "...rrrmmmmrrr...",
    "..rrrgrrrrgrrr..",
    "..rrrrrrrrrrrr..",
    "..rrrgrrrrgrrr..",
    "................",
  ],
  4: [
    "................",
    ".....rrrrrr.....",
    "....rrrrrrrr....",
    "....rrrrrrrrr.r.",
    "....kssssssk.rr.",
    "....sesssses....",
    "....ssssssss....",
    "....sssmmsss....",
    ".....ssssss.....",
    "......ssss......",
    "...wwwwwwwwww...",
    "..bbbbbbbbbbbb..",
    "..wwwwwwwwwwww..",
    "..bbbbbbbbbbbb..",
    "..wwwwwwwwwwww..",
    "................",
  ],
};

/** Paint a face's picture with its top-left at (x, y), `scale` canvas pixels to an art pixel. */
export function paintCrewFace(ctx: CanvasRenderingContext2D, face: CrewFace, x: number, y: number, scale: number) {
  ART[face].forEach((row, r) =>
    [...row].forEach((ch, c) => {
      const color = PALETTE[ch];
      if (!color) return;
      ctx.fillStyle = color;
      ctx.fillRect(x + c * scale, y + r * scale, scale, scale);
    }),
  );
}

const cache = new Map<string, string>();

/** A held die face, 20 pixels square: the picture on ivory in a gold rim. */
export function crewFaceUrl(face: CrewFace): string {
  const key = String(face);
  let url = cache.get(key);
  if (url) return url;
  const canvas = document.createElement("canvas");
  canvas.width = 20;
  canvas.height = 20;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#c99a3a";
  ctx.fillRect(0, 0, 20, 20);
  ctx.fillStyle = "#f4efe1";
  ctx.fillRect(1, 1, 18, 18);
  paintCrewFace(ctx, face, 2, 2, 1);
  url = canvas.toDataURL();
  cache.set(key, url);
  return url;
}
