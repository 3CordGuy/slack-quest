// Pixel art for the pub's Cargo and Krakens table: what a die shows in
// place of its pips. The 6 is the ship and the 5 the captain once each is set
// aside, and a 1 in the cargo is the Kraken. Each is a 16-pixel picture, painted straight onto a die's face in the table scene
// (render/TableStage.ts) and handed to the panel as an image URL, shown at a
// whole multiple with `image-rendering: pixelated` to match the sprites.

export type CrewFace = 1 | 5 | 6;
export const CREW_FACE_NAME: Record<CrewFace, string> = { 6: "Ship", 5: "Captain", 1: "Kraken" };
export const isCrewFace = (v: number): v is CrewFace => v === 1 || v === 5 || v === 6;
/** The rim round a picture: gold for ship and captain, red for the Kraken. */
export const crewRim = (face: CrewFace) => (face === 1 ? "#a01818" : "#c99a3a");

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
  P: "#8a3fa0", // the Kraken
  p: "#4f1d62", // its shadow
  y: "#ffd23f", // its eye
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
  1: [
    "......pppp......",
    ".....pPPPPp.....",
    "....pPPPPPPp....",
    "....PPPPPPPP....",
    "....PyyPPyyP....",
    "....PykPPkyP....",
    "....pPPPPPPp....",
    ".....PPPPPP.....",
    "..P.PP.PP.PP.P..",
    ".PP.P..PP..P.PP.",
    ".P..P.P..P.P..P.",
    ".P.PP.P..P.PP.P.",
    ".PPp..PP.PP..pP.",
    "..bbbcbbbbcbbbb.",
    ".bbcbbbbcbbbbcbb",
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

function drawn(key: string, paint: (ctx: CanvasRenderingContext2D) => void): string {
  let url = cache.get(key);
  if (url) return url;
  const canvas = document.createElement("canvas");
  canvas.width = 20;
  canvas.height = 20;
  paint(canvas.getContext("2d")!);
  url = canvas.toDataURL();
  cache.set(key, url);
  return url;
}

/** A picture die face, 20 pixels square: the picture on ivory in its rim. */
export function crewFaceUrl(face: CrewFace): string {
  return drawn(`face:${face}`, (ctx) => {
    ctx.fillStyle = crewRim(face);
    ctx.fillRect(0, 0, 20, 20);
    ctx.fillStyle = "#f4efe1";
    ctx.fillRect(1, 1, 18, 18);
    paintCrewFace(ctx, face, 2, 2, 1);
  });
}

const PIP: Record<number, [number, number][]> = {
  1: [[9, 9]],
  2: [[5, 5], [13, 13]],
  3: [[5, 5], [9, 9], [13, 13]],
  4: [[5, 5], [13, 5], [5, 13], [13, 13]],
  5: [[5, 5], [13, 5], [9, 9], [5, 13], [13, 13]],
  6: [[5, 4], [13, 4], [5, 9], [13, 9], [5, 14], [13, 14]],
};

/** A plain die face, 20 pixels square, for the panel: ivory with its pips, or warm and gold-rimmed when it is kept. */
export function dieFaceUrl(value: number, kept = false): string {
  return drawn(`die:${value}:${kept}`, (ctx) => {
    ctx.fillStyle = kept ? "#c99a3a" : "#2a2118";
    ctx.fillRect(0, 0, 20, 20);
    ctx.fillStyle = kept ? "#ffe9a0" : "#f4efe1";
    ctx.fillRect(1, 1, 18, 18);
    ctx.fillStyle = "#2a2118";
    for (const [x, y] of PIP[value] ?? []) ctx.fillRect(x, y, 2, 2);
  });
}
