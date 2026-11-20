// The frames round every panel and the surfaces inside them, drawn in code
// and handed to the stylesheet as CSS variables: each frame is a nine-slice
// picture (corners that stay put, edges that stretch), each texture a tile
// that repeats.
//
// The trim is shaded as metal catches a lamp, then set down in fat pixels
// like the world it sits over (`pixelate`): worn timber round every panel, a
// gold line inside it that is bright along one side and dark along the
// other, and gold plates at the corners with an engraved ring and a domed
// stud. Slots are single squares, each with its own bronze rim and corner
// ticks. Behind the gear in the sea bag is a mottled hide. Parchment is for
// the name plates and the logbook.

/** Canvas pixels to one CSS pixel, so the trim stays sharp on dense screens and at the larger UI scales. */
export const D = 2;

export const BRASS = { hi: "#f3dfa0", mid: "#c29a4c", lo: "#7a5a26", dark: "#3d2b12" };

export function sheet(w: number, h: number, scale = D): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  return [canvas, ctx];
}
const url = (c: HTMLCanvasElement) => `url(${c.toDataURL()})`;

/** How big one pixel of the trim is, in CSS pixels: the same as a pixel of the item icons at their usual size. */
export const TRIM_PIXEL = 2;

/**
 * Turn a smoothly drawn picture into fat pixels: one colour to each `TRIM_PIXEL` square, taken from its middle,
 * with the colours stepped a little and soft edges made hard. The shading survives (a line is still bright on
 * its lit side, a dome still rounds), but in the same blocky hand as the world.
 */
export function pixelate(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = canvas.getContext("2d")!;
  const { width: w, height: h } = canvas;
  const b = TRIM_PIXEL * D;
  const src = ctx.getImageData(0, 0, w, h).data;
  const out = ctx.createImageData(w, h);
  const step = (n: number) => Math.min(255, Math.round(n / 12) * 12);
  for (let by = 0; by < h; by += b) {
    for (let bx = 0; bx < w; bx += b) {
      const i = (Math.min(h - 1, by + (b >> 1)) * w + Math.min(w - 1, bx + (b >> 1))) * 4;
      const a = src[i + 3];
      // Mostly there or not there; a faint middle step keeps a fade from ending in a cliff.
      const alpha = a < 56 ? 0 : a < 150 ? 150 : 255;
      if (alpha === 0) continue;
      const [r, g, bl] = [step(src[i]), step(src[i + 1]), step(src[i + 2])];
      for (let y = by; y < Math.min(h, by + b); y++) {
        for (let x = bx; x < Math.min(w, bx + b); x++) {
          const o = (y * w + x) * 4;
          out.data[o] = r;
          out.data[o + 1] = g;
          out.data[o + 2] = bl;
          out.data[o + 3] = alpha;
        }
      }
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas;
}

/** A number from 0 to 1 that is always the same for the same place. */
export const hash = (x: number, y: number, seed = 0) => {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return n - Math.floor(n);
};

/** Gold lit from the upper left, across the box given. */
export function gold(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): CanvasGradient {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, "#fbeab4");
  g.addColorStop(0.35, BRASS.mid);
  g.addColorStop(0.7, BRASS.lo);
  g.addColorStop(1, "#a8823c");
  return g;
}

/** The bottom bar's timber (rackArt.ts): every frame is cut from the same wood. */
const TIMBER = { out: "#3a1d20", dark: "#6b3524", mid: "#8e4a2f", light: "#b1633c", high: "#d18a55", brass: "#f4c64e", brassDark: "#b9822a", slotEdge: "#d99b73", slot: "#f3bc93" };
type Tone = "out" | "dark" | "mid" | "light" | "high";
/** Screen pixels to one pixel of this art: the same as the bottom bar's. */
const ART = 3;

/** A canvas `w` by `h` art pixels, and a way to set one of them. */
function artSheet(w: number, h: number): [HTMLCanvasElement, (x: number, y: number, c: string) => void] {
  const canvas = document.createElement("canvas");
  const k = ART * D;
  canvas.width = w * k;
  canvas.height = h * k;
  const ctx = canvas.getContext("2d")!;
  return [canvas, (x, y, c) => {
    ctx.fillStyle = c;
    ctx.fillRect(x * k, y * k, k, k);
  }];
}

/** A board's colour at a pixel: its own tone, with a grain of short dashes a shade lighter or darker. */
function grained(x: number, y: number, tone: Tone): string {
  if (tone === "out") return TIMBER.out;
  const order: Tone[] = ["dark", "mid", "light", "high"];
  const at = order.indexOf(tone);
  const dash = hash(Math.floor((x + y * 5) / 3), y, 71);
  return TIMBER[dash > 0.9 ? order[Math.min(3, at + 1)] : dash < 0.1 ? order[Math.max(0, at - 1)] : tone];
}

/**
 * A timber frame as a nine-slice picture. `bands` are the rail's rows from its lit edge to its shadowed one;
 * the top and left rails are lit along the outside, the bottom and right ones along the inside, as boards lit
 * from the upper left are. Each corner is a square block `corner` across with a brass stud.
 */
function frame(bands: Tone[], corner: number): string {
  const slice = Math.max(bands.length, corner);
  const size = slice * 2 + 8;
  const [canvas, dot] = artSheet(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.min(x, size - 1 - x);
      const dy = Math.min(y, size - 1 - y);
      if (dx < corner && dy < corner) {
        // The corner block, lit along its own top and left wherever it sits.
        const lx = x < size / 2 ? x : x - (size - corner);
        const ly = y < size / 2 ? y : y - (size - corner);
        const last = corner - 1;
        const mid = Math.floor(corner / 2);
        let c: string;
        if (lx === 0 || ly === 0 || lx === last || ly === last) c = TIMBER.out;
        else if (corner >= 6 && (lx === mid - 1 || lx === mid) && (ly === mid - 1 || ly === mid)) c = lx === mid - 1 && ly === mid - 1 ? TIMBER.brass : TIMBER.brassDark;
        else if (lx === 1 || ly === 1) c = TIMBER.high;
        else if (lx === last - 1 || ly === last - 1) c = TIMBER.dark;
        else c = grained(x, y, "light");
        dot(x, y, c);
        continue;
      }
      const d = Math.min(dx, dy);
      if (d >= bands.length) continue;
      // Which rail this is: a top or left one is lit on its outside, a bottom or right one on its inside.
      const far = dy <= dx ? y > size / 2 : x > size / 2;
      const tone = bands[far ? bands.length - 1 - d : d];
      dot(x, y, grained(dy <= dx ? x : y, d + (far ? 40 : 0), tone));
    }
  }
  return url(canvas);
}

/** A flourish to set either side of a heading: a line that tapers away from the words, a loop, and a diamond. */
function flourish(): string {
  const w = 56;
  const h = 12;
  const [canvas, ctx] = sheet(w, h);
  const y = h / 2;
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, "rgba(194, 154, 76, 0)");
  g.addColorStop(0.5, BRASS.mid);
  g.addColorStop(1, BRASS.hi);
  ctx.strokeStyle = g;
  ctx.lineWidth = 1.2;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(1, y);
  ctx.lineTo(30, y);
  // The loop.
  ctx.bezierCurveTo(36, y - 6.5, 42, y - 6.5, 42, y);
  ctx.bezierCurveTo(42, y + 6.5, 36, y + 6.5, 30, y);
  ctx.moveTo(42, y);
  ctx.lineTo(46, y);
  ctx.stroke();
  ctx.fillStyle = gold(ctx, 46, y - 4, 54, y + 4);
  ctx.beginPath();
  ctx.moveTo(50, y - 3.6);
  ctx.lineTo(54, y);
  ctx.lineTo(50, y + 3.6);
  ctx.lineTo(46, y);
  ctx.closePath();
  ctx.fill();
  return url(pixelate(canvas));
}

/**
 * How far the embossed square stands in from a pack square's edges, in screen pixels: from the top and left,
 * where the divider's two pixels come first, and from the bottom and right. The same gap shows on every side.
 * The stylesheet uses the same numbers to emboss a thing that covers several squares as one (theme.css).
 */
const EMBOSS = { near: 5, far: 3 };

/**
 * One square of the pack, `n` screen pixels across. Flat and dark, with nothing shaded across it. Its top and
 * left edges are a divider cut like a shallow groove: a dark line with a faint lit line beside it, both quiet.
 * With `motif`, a smaller square is embossed into its middle, the mark an empty square carries; without,
 * it is the dividers alone on nothing, to lay over a thing so the squares under it can still be counted.
 */
function cell(n: number, motif: boolean): string {
  // Drawn finer than the rest of the trim, so the emboss can be a quarter of a pixel wide.
  const [canvas, ctx] = sheet(n, n, 4);
  if (motif) {
    ctx.fillStyle = "#1b110f";
    ctx.fillRect(0, 0, n, n);
    // A smaller square sunk into the middle, the same distance in from the square's own edges on every side
    // (the divider takes the first two pixels along the top and the left, so it is measured from inside that).
    // A dark line a quarter of a pixel wide along its top and left where the edge shades it, a hair of light along its bottom and
    // right where the edge catches it, and the faintest shade inside.
    const hair = 0.25;
    const [x0, x1] = [EMBOSS.near, n - EMBOSS.far];
    const side = x1 - x0;
    ctx.fillStyle = "rgba(0, 0, 0, 0.08)";
    ctx.fillRect(x0, x0, side, side);
    ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
    ctx.fillRect(x0, x0, side, hair);
    ctx.fillRect(x0, x0, hair, side);
    ctx.fillStyle = "rgba(255, 214, 170, 0.13)";
    ctx.fillRect(x0 + hair, x1 - hair, side - hair, hair);
    ctx.fillRect(x1 - hair, x0 + hair, hair, side - hair);
  }
  // The groove along the top and the left: dark, then a hair of light.
  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
  ctx.fillRect(0, 0, n, 1);
  ctx.fillRect(0, 0, 1, n);
  ctx.fillStyle = "rgba(255, 214, 170, 0.07)";
  ctx.fillRect(1, 1, n - 1, 1);
  ctx.fillRect(1, 1, 1, n - 1);
  return url(canvas);
}

/**
 * A gold fitting for the corner of a book's cover (drawn for the top left): a plate that wraps the corner and
 * sweeps in a curve across the leather, with an engraved line following its edge, a curl, and a domed stud.
 */
function bookCorner(): string {
  const n = 54;
  const [canvas, ctx] = sheet(n, n);
  const shape = new Path2D();
  shape.moveTo(3, 1);
  shape.lineTo(n - 3, 1);
  shape.quadraticCurveTo(n - 1, 8, n - 9, 10);
  shape.bezierCurveTo(26, 12, 12, 26, 10, n - 9);
  shape.quadraticCurveTo(8, n - 1, 1, n - 3);
  shape.lineTo(1, 3);
  shape.quadraticCurveTo(1, 1, 3, 1);
  shape.closePath();
  ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1.5;
  ctx.fillStyle = gold(ctx, 0, 0, n * 0.7, n * 0.7);
  ctx.fill(shape);
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "#3d2b12";
  ctx.lineWidth = 1;
  ctx.stroke(shape);
  // Light along the outer edges.
  ctx.strokeStyle = "rgba(255, 248, 216, 0.8)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(2.2, n - 8);
  ctx.lineTo(2.2, 2.2);
  ctx.lineTo(n - 8, 2.2);
  ctx.stroke();
  // An engraved line inside the curve, and a curl off its middle.
  ctx.strokeStyle = "rgba(74, 50, 16, 0.85)";
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.moveTo(n - 12, 6);
  ctx.bezierCurveTo(22, 8, 8, 22, 6, n - 12);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(17, 17, 4.2, Math.PI * 0.2, Math.PI * 1.75);
  ctx.stroke();
  const dome = ctx.createRadialGradient(8.5, 8.5, 0.4, 10, 10, 4.6);
  dome.addColorStop(0, "#fffbe6");
  dome.addColorStop(0.45, BRASS.mid);
  dome.addColorStop(1, BRASS.dark);
  ctx.fillStyle = dome;
  ctx.beginPath();
  ctx.arc(10, 10, 4, 0, Math.PI * 2);
  ctx.fill();
  return url(pixelate(canvas));
}

/** Soft round patches of colour scattered over a tile, each drawn again one tile over wherever it crosses an edge, so the tile repeats without a seam. */
function mottle(ctx: CanvasRenderingContext2D, n: number, count: number, seed: number, radius: [number, number], colors: [string, string]) {
  for (let i = 0; i < count; i++) {
    const x = hash(i, 1, seed) * n;
    const y = hash(i, 2, seed) * n;
    const r = radius[0] + hash(i, 3, seed) * radius[1];
    for (const ox of [-n, 0, n]) {
      for (const oy of [-n, 0, n]) {
        if (x + ox + r < 0 || x + ox - r > n || y + oy + r < 0 || y + oy - r > n) continue;
        const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        g.addColorStop(0, colors[hash(i, 4, seed) > 0.5 ? 0 : 1]);
        g.addColorStop(1, "rgba(0, 0, 0, 0)");
        ctx.fillStyle = g;
        ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
  }
}

/** A mottled hide: soft patches of lighter and darker brown, and fine pores. */
function hide(): string {
  const n = 256;
  const [canvas, ctx] = sheet(n, n);
  ctx.fillStyle = "#2a2019";
  ctx.fillRect(0, 0, n, n);
  mottle(ctx, n, 150, 41, [14, 44], ["rgba(150, 108, 62, 0.11)", "rgba(0, 0, 0, 0.16)"]);
  for (let i = 0; i < 1400; i++) {
    ctx.fillStyle = hash(i, 7, 42) > 0.5 ? "rgba(255, 226, 180, 0.05)" : "rgba(0, 0, 0, 0.12)";
    ctx.fillRect(hash(i, 5, 42) * n, hash(i, 6, 42) * n, 1, 1);
  }
  return url(canvas);
}

/** Planking for the logbook's cover: boards with long grain and a dark seam between them. */
function wood(): string {
  const n = 128;
  const [canvas, ctx] = sheet(n, n);
  for (let b = 0; b < 4; b++) {
    const y = b * 32;
    const tone = 44 + hash(b, 1, 51) * 16;
    ctx.fillStyle = `rgb(${tone + 16}, ${tone}, ${tone - 14})`;
    ctx.fillRect(0, y, n, 32);
    for (let i = 0; i < 26; i++) {
      ctx.fillStyle = hash(b, i, 52) > 0.5 ? "rgba(255, 220, 170, 0.045)" : "rgba(0, 0, 0, 0.1)";
      ctx.fillRect(0, y + hash(b, i, 53) * 31, n, 1);
    }
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(0, y + 31, n, 1);
    ctx.fillStyle = "rgba(255, 224, 176, 0.08)";
    ctx.fillRect(0, y, n, 1);
  }
  return url(canvas);
}

/**
 * Parchment: a warm ground with broad, soft clouds of lighter and darker tone, fine grain and a few fibres:
 * enough to read as a worn page, not so much that it competes with the writing. The tile is large and the
 * clouds wide, so no patch stands out and the repeat does not show.
 */
function paper(): string {
  const n = 512;
  const [canvas, ctx] = sheet(n, n);
  ctx.fillStyle = "#e0d0a8";
  ctx.fillRect(0, 0, n, n);
  mottle(ctx, n, 46, 61, [90, 130], ["rgba(255, 248, 226, 0.13)", "rgba(150, 112, 58, 0.1)"]);
  mottle(ctx, n, 70, 63, [26, 46], ["rgba(255, 250, 232, 0.07)", "rgba(140, 104, 52, 0.065)"]);
  // Grain: single specks, barely there.
  for (let i = 0; i < 5200; i++) {
    ctx.fillStyle = hash(i, 7, 62) > 0.5 ? "rgba(255, 252, 238, 0.1)" : "rgba(110, 82, 42, 0.08)";
    ctx.fillRect(hash(i, 5, 62) * n, hash(i, 6, 62) * n, 1, 1);
  }
  // A few short fibres lying this way and that.
  ctx.lineWidth = 0.6;
  for (let i = 0; i < 260; i++) {
    const x = hash(i, 1, 64) * n;
    const y = hash(i, 2, 64) * n;
    const turn = hash(i, 3, 64) * Math.PI;
    const len = 3 + hash(i, 4, 64) * 7;
    ctx.strokeStyle = hash(i, 5, 64) > 0.5 ? "rgba(120, 90, 46, 0.09)" : "rgba(255, 252, 238, 0.12)";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(turn) * len, y + Math.sin(turn) * len);
    ctx.stroke();
  }
  return url(canvas);
}

/** Draw the frames and textures and hand them to the stylesheet. Called once, before the first render. */
export function installFrames(): void {
  const root = document.documentElement.style;
  try {
    // Sizes are in CSS pixels; the pictures are D times that, and theme.css slices them in picture pixels.
    root.setProperty("--frame-panel", frame(["out", "high", "mid", "out"], 6));
    root.setProperty("--frame-window", frame(["out", "high", "light", "mid", "dark", "out"], 8));
    root.setProperty("--frame-thin", frame(["out", "light"], 3));
    root.setProperty("--flourish", flourish());
    root.setProperty("--tex-cell", cell(51, true));
    root.setProperty("--tex-lines", cell(51, false));
    root.setProperty("--book-corner", bookCorner());
    root.setProperty("--tex-hide", hide());
    root.setProperty("--tex-wood", wood());
    root.setProperty("--tex-paper", paper());
  } catch {
    // No canvas: theme.css falls back to plain borders and flat colours.
  }
}
