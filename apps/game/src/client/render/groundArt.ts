// Illustrated ground for the built-up tiles: the Harbor's cobbles, a hut's
// floorboards and the piers' planks. Drawn once in code at a good size and
// filtered smoothly, in the manner of a painted storybook map: clean shapes,
// an ink line round each stone or board, a soft bevel where it catches the
// light and a few strokes of detail (grain, nails). Each sheet tiles, so it
// runs on unbroken from one hex into the next.

import * as THREE from "three";

/** Pixels across one sheet. */
const SIZE = 256;

const hash = (a: number, b: number, salt: number) => {
  const n = Math.sin(a * 127.1 + b * 311.7 + salt * 74.7) * 43758.5453;
  return n - Math.floor(n);
};
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);

function sheet(draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  draw(canvas.getContext("2d")!);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/**
 * Cobbles: rounded stones of uneven size in a few close greys (now and then a mossy one), each ringed by a dark
 * ink line in pale grout, lit along its upper edge and shaded along its lower, with a soft dome to the middle.
 * Each pixel belongs to the nearest of a scatter of stone centres; its distance to the stone's edge is a smooth
 * minimum of its distances to the borders with every neighbour, which rounds the corners.
 */
export function cobbleTexture(): THREE.CanvasTexture {
  return sheet((ctx) => {
    const CELLS = 5;
    const step = SIZE / CELLS;
    const tones = ["#7d8089", "#767982", "#838690", "#7a7c84"].map(rgb);
    const moss = rgb("#74806f");
    const grout = rgb("#8a8b8e");
    const ink = rgb("#5e6068");
    const centres: { x: number; y: number; tone: number[] }[] = [];
    for (let cy = 0; cy < CELLS; cy++) {
      for (let cx = 0; cx < CELLS; cx++) {
        const odd = cy % 2 ? 0.5 : 0;
        centres.push({
          x: (cx + odd + 0.25 + hash(cx, cy, 610) * 0.5) * step,
          y: (cy + 0.25 + hash(cx, cy, 611) * 0.5) * step,
          tone: hash(cx, cy, 612) < 0.08 ? moss : tones[Math.floor(hash(cx, cy, 613) * tones.length)],
        });
      }
    }
    const wrap = (d: number) => d - SIZE * Math.round(d / SIZE);
    const img = ctx.createImageData(SIZE, SIZE);
    const GROUT = 2.4;
    const LINE = 1.2;
    const K = 3;
    // The light comes from the top left of the sheet.
    const lx = -0.6, ly = -0.8;
    const dx = new Float32Array(centres.length);
    const dy = new Float32Array(centres.length);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        let best = 0;
        let bestD = Infinity;
        centres.forEach((c, i) => {
          dx[i] = wrap(x + 0.5 - c.x);
          dy[i] = wrap(y + 0.5 - c.y);
          const d = dx[i] * dx[i] + dy[i] * dy[i];
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        });
        // Distance to each border with a neighbour, folded into one rounded edge distance.
        let sum = 0;
        for (let i = 0; i < centres.length; i++) {
          if (i === best) continue;
          const ex = dx[best] - dx[i], ey = dy[best] - dy[i];
          const gap = Math.hypot(ex, ey);
          const edge = (dx[i] * dx[i] + dy[i] * dy[i] - bestD) / (2 * gap);
          sum += Math.exp(-edge / K);
        }
        const edge = -K * Math.log(sum);
        const r = Math.sqrt(bestD) || 1;
        const facing = (dx[best] / r) * lx + (dy[best] / r) * ly;
        const rim = 1 - smooth(GROUT + LINE, GROUT + LINE + 8, edge);
        const dome = 1 + 0.04 * (1 - smooth(0, step * 0.55, r));
        let col = centres[best].tone.map((v) => v * dome);
        col = facing > 0 ? mix(col, [255, 255, 255], facing * rim * 0.12) : mix(col, [20, 20, 30], -facing * rim * 0.14);
        col = mix(col, ink, 1 - smooth(GROUT + LINE - 0.6, GROUT + LINE + 0.6, edge));
        col = mix(col, grout, 1 - smooth(GROUT - 0.6, GROUT + 0.6, edge));
        const o = (y * SIZE + x) * 4;
        img.data[o] = col[0];
        img.data[o + 1] = col[1];
        img.data[o + 2] = col[2];
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  });
}

type Wood = { boards: string[]; gap: string; grain: string; nail: string };

/**
 * Rows of long boards, one to a row with the joint somewhere different every row: each a rounded plank with an ink
 * outline over a dark gap, lit along its top and shaded along its foot, with long flowing grain, now and then a
 * knot, and a pair of nails at each end.
 */
function planks(ctx: CanvasRenderingContext2D, wood: Wood, salt: number) {
  const ROWS = 6;
  const h = SIZE / ROWS;
  ctx.fillStyle = wood.gap;
  ctx.fillRect(0, 0, SIZE, SIZE);
  for (let row = 0; row < ROWS; row++) {
    const y = row * h;
    const joint = [0.34, 0.78, 0.12, 0.58, 0.9, 0.22][row] * SIZE;
    const id = row;
    const tone = wood.boards[Math.floor(hash(id, 1, salt) * wood.boards.length)];
    const knot = hash(id, 2, salt) < 0.5 ? 0.2 + hash(id, 3, salt) * 0.6 : -1;
    // Drawn once where it lies and once a sheet to the left, so a board running off the right edge comes back on the left.
    for (const shift of [0, -SIZE]) board(ctx, wood, joint + shift, y, SIZE, h, tone, knot, id, salt);
  }
}

function board(ctx: CanvasRenderingContext2D, wood: Wood, x: number, y: number, w: number, h: number, tone: string, knot: number, id: number, salt: number) {
  const inset = 2;
  const bx = x + inset, by = y + inset, bw = w - inset * 2, bh = h - inset * 2;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, 4);
  ctx.fillStyle = tone;
  ctx.fill();
  ctx.clip();
  // Light along the top, shade along the foot.
  const shade = ctx.createLinearGradient(0, by, 0, by + bh);
  shade.addColorStop(0, "rgba(255,240,210,0.28)");
  shade.addColorStop(0.18, "rgba(255,240,210,0)");
  shade.addColorStop(0.75, "rgba(40,20,0,0)");
  shade.addColorStop(1, "rgba(40,20,0,0.3)");
  ctx.fillStyle = shade;
  ctx.fillRect(bx, by, bw, bh);
  // The grain: long lines that drift up and down along the board, and bend round the knot.
  ctx.strokeStyle = wood.grain;
  ctx.lineCap = "round";
  const kx = bx + knot * bw;
  const ky = by + bh * (0.35 + hash(id, 4, salt) * 0.3);
  for (let i = 0; i < 4; i++) {
    const base = by + bh * (0.2 + i * 0.2) + (hash(id, 10 + i, salt) - 0.5) * 4;
    const amp = 1 + hash(id, 20 + i, salt) * 2;
    const phase = hash(id, 30 + i, salt) * 6.28;
    ctx.lineWidth = 0.9 + hash(id, 40 + i, salt) * 0.8;
    ctx.globalAlpha = 0.35 + hash(id, 50 + i, salt) * 0.3;
    ctx.beginPath();
    for (let s = 0; s <= 48; s++) {
      const px = bx + (s / 48) * bw;
      let py = base + Math.sin((s / 48) * 6.28 * 2.2 + phase) * amp;
      if (knot >= 0) {
        const near = Math.exp(-((px - kx) ** 2) / 200);
        py += Math.sign(py - ky || 1) * near * 5;
      }
      if (s === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  if (knot >= 0) {
    ctx.fillStyle = wood.grain;
    ctx.beginPath();
    ctx.ellipse(kx, ky, 4, 2.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(kx, ky, 7, 4, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
  // The ink outline.
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, 4);
  ctx.strokeStyle = wood.gap;
  ctx.lineWidth = 1.6;
  ctx.stroke();
  // Two nails at each end, each a dark head with a glint.
  for (const nx of [bx + 8, bx + bw - 8]) {
    for (const ny of [by + bh * 0.3, by + bh * 0.7]) {
      ctx.fillStyle = wood.nail;
      ctx.beginPath();
      ctx.arc(nx, ny, 1.9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.beginPath();
      ctx.arc(nx - 0.7, ny - 0.7, 0.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Floorboards for a hut: warm, honey-coloured boards running across the room. */
export function floorTexture(): THREE.CanvasTexture {
  return sheet((ctx) => planks(ctx, { boards: ["#b58d5e", "#ab8455", "#bd9566", "#b08a5c"], gap: "#5e4229", grain: "#8a6640", nail: "#4a3a2c" }, 300));
}

/** Planks for the piers: greyer, sea-weathered boards running out to sea. */
export function pierTexture(): THREE.CanvasTexture {
  return sheet((ctx) => {
    // Turned a quarter, so the boards run the other way from the floor's.
    ctx.translate(SIZE / 2, SIZE / 2);
    ctx.rotate(Math.PI / 2);
    ctx.translate(-SIZE / 2, -SIZE / 2);
    planks(ctx, { boards: ["#9a7a50", "#927448", "#a28256", "#97784e"], gap: "#4a3826", grain: "#76603f", nail: "#3c342c" }, 630);
  });
}

/**
 * Fieldstone for a fireplace: rounded stones of uneven size in warm greys and tans, set in pale mortar, each with
 * a soft ink line and a gentle bevel, quieter than the cobbles. Laid on a fireplace from every side at once by
 * position (see triplanar in props.ts), so it needs no UVs and never stretches.
 */
export function fieldstoneTexture(): THREE.CanvasTexture {
  return sheet((ctx) => {
    const CELLS = 4;
    const step = SIZE / CELLS;
    const tones = ["#a8977a", "#9d8d72", "#b2a286", "#968770", "#a39a88"].map(rgb);
    const mortar = rgb("#c9bea6");
    const ink = rgb("#6e6352");
    const centres: { x: number; y: number; tone: number[] }[] = [];
    for (let cy = 0; cy < CELLS; cy++) {
      for (let cx = 0; cx < CELLS; cx++) {
        centres.push({
          x: (cx + (cy % 2 ? 0.5 : 0) + 0.2 + hash(cx, cy, 710) * 0.6) * step,
          y: (cy + 0.2 + hash(cx, cy, 711) * 0.6) * step,
          tone: tones[Math.floor(hash(cx, cy, 713) * tones.length)],
        });
      }
    }
    const wrap = (d: number) => d - SIZE * Math.round(d / SIZE);
    const img = ctx.createImageData(SIZE, SIZE);
    const MORTAR = 3.2;
    const LINE = 1.1;
    const K = 4;
    const lx = -0.6, ly = -0.8;
    const dx = new Float32Array(centres.length);
    const dy = new Float32Array(centres.length);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        let best = 0;
        let bestD = Infinity;
        centres.forEach((c, i) => {
          dx[i] = wrap(x + 0.5 - c.x);
          dy[i] = wrap(y + 0.5 - c.y);
          const d = dx[i] * dx[i] + dy[i] * dy[i];
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        });
        let sum = 0;
        for (let i = 0; i < centres.length; i++) {
          if (i === best) continue;
          const gap = Math.hypot(dx[best] - dx[i], dy[best] - dy[i]);
          sum += Math.exp(-((dx[i] * dx[i] + dy[i] * dy[i] - bestD) / (2 * gap)) / K);
        }
        const edge = -K * Math.log(sum);
        const r = Math.sqrt(bestD) || 1;
        const facing = (dx[best] / r) * lx + (dy[best] / r) * ly;
        const rim = 1 - smooth(MORTAR + LINE, MORTAR + LINE + 10, edge);
        // A faint mottle across each stone, so none is one flat colour.
        const mottle = 0.96 + 0.08 * hash(Math.floor(x / 9), Math.floor(y / 9), 715 + best);
        let col = centres[best].tone.map((v) => v * mottle);
        col = facing > 0 ? mix(col, [255, 250, 240], facing * rim * 0.12) : mix(col, [30, 24, 18], -facing * rim * 0.16);
        col = mix(col, ink, (1 - smooth(MORTAR + LINE - 0.6, MORTAR + LINE + 0.6, edge)) * 0.8);
        col = mix(col, mortar, 1 - smooth(MORTAR - 0.7, MORTAR + 0.7, edge));
        const o = (y * SIZE + x) * 4;
        img.data[o] = col[0];
        img.data[o + 1] = col[1];
        img.data[o + 2] = col[2];
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  });
}

/** Where the pub's wall dressing changes over, as shares of the wall's height from the floor (see panelTexture). */
export const PANEL = { skirting: 0.05, rail: 0.5, railTop: 0.535, beam: 0.93 };

/**
 * The pub's walls inside, to go with the inn outside (a stone ground floor under cream plaster and dark timbers):
 * dark oak boards standing upright to waist height, a skirting board at their foot and a moulded rail along
 * their top, cream lime plaster above, and a dark timber beam along the top. One sheet is one unit of wall
 * across (four boards) and the wall's whole height; it repeats along the wall.
 */
export function panelTexture(): THREE.CanvasTexture {
  const W = 256;
  const H = 448;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  /** A share of the wall's height, from the floor, as a y on the sheet. */
  const at = (share: number) => H * (1 - share);
  const timber = "#4a2f22";

  // Plaster: warm cream, a soft mottle, and a little shade where it meets the rail and the beam.
  const plasterTop = at(PANEL.beam);
  const plasterFoot = at(PANEL.railTop);
  ctx.fillStyle = "#e3d3ae";
  ctx.fillRect(0, plasterTop, W, plasterFoot - plasterTop);
  for (let i = 0; i < 26; i++) {
    const x = hash(i, 1, 800) * W;
    const y = plasterTop + hash(i, 2, 800) * (plasterFoot - plasterTop);
    const r = 14 + hash(i, 3, 800) * 30;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const tone = hash(i, 4, 800) < 0.5 ? "120,95,60" : "255,250,235";
    g.addColorStop(0, `rgba(${tone},0.07)`);
    g.addColorStop(1, `rgba(${tone},0)`);
    ctx.fillStyle = g;
    for (const shift of [-W, 0, W]) {
      ctx.save();
      ctx.translate(shift, 0);
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      ctx.restore();
    }
  }
  for (const [y0, y1, down] of [[plasterTop, plasterTop + 18, true], [plasterFoot - 14, plasterFoot, false]] as const) {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(down ? 0 : 1, "rgba(80,55,30,0.18)");
    g.addColorStop(down ? 1 : 0, "rgba(80,55,30,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, y0, W, y1 - y0);
  }

  // The boards: four to a sheet, each its own shade of dark oak, with long faint grain and a groove between.
  const top = at(PANEL.rail);
  const foot = at(PANEL.skirting);
  const tones = ["#6b4a2e", "#64452a", "#724f32", "#68482c"];
  const bw = W / 4;
  for (let i = 0; i < 4; i++) {
    const x = i * bw;
    ctx.fillStyle = tones[i];
    ctx.fillRect(x, top, bw, foot - top);
    // Light down one side of the board, shade down the other: it is a little rounded.
    const g = ctx.createLinearGradient(x, 0, x + bw, 0);
    g.addColorStop(0, "rgba(255,230,190,0.1)");
    g.addColorStop(0.25, "rgba(255,230,190,0)");
    g.addColorStop(0.8, "rgba(30,15,5,0)");
    g.addColorStop(1, "rgba(30,15,5,0.18)");
    ctx.fillStyle = g;
    ctx.fillRect(x, top, bw, foot - top);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, top, bw, foot - top);
    ctx.clip();
    ctx.strokeStyle = "#4e3420";
    ctx.lineCap = "round";
    for (let k = 0; k < 4; k++) {
      const base = x + bw * (0.18 + k * 0.2) + (hash(i, k, 810) - 0.5) * 5;
      const amp = 0.8 + hash(i, k, 811) * 1.6;
      const phase = hash(i, k, 812) * 6.28;
      ctx.lineWidth = 0.8 + hash(i, k, 813) * 0.6;
      ctx.globalAlpha = 0.18 + hash(i, k, 814) * 0.14;
      ctx.beginPath();
      for (let s = 0; s <= 40; s++) {
        const y = top + (s / 40) * (foot - top);
        const px = base + Math.sin((s / 40) * 6.28 * 1.6 + phase) * amp;
        if (s === 0) ctx.moveTo(px, y);
        else ctx.lineTo(px, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
    // The groove: a dark line with a pale lip beside it.
    ctx.fillStyle = "#3a2618";
    ctx.fillRect(x, top, 2, foot - top);
    ctx.fillStyle = "rgba(255,225,180,0.12)";
    ctx.fillRect(x + 2, top, 1, foot - top);
  }

  /** A run of timber along the wall: dark, lit along its top edge and shaded along its foot. */
  const band = (y0: number, y1: number, tone: string) => {
    ctx.fillStyle = tone;
    ctx.fillRect(0, y0, W, y1 - y0);
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, "rgba(255,225,180,0.22)");
    g.addColorStop(0.3, "rgba(255,225,180,0)");
    g.addColorStop(0.7, "rgba(20,10,0,0)");
    g.addColorStop(1, "rgba(20,10,0,0.3)");
    ctx.fillStyle = g;
    ctx.fillRect(0, y0, W, y1 - y0);
  };
  band(at(PANEL.railTop), top, timber);
  band(foot, H, timber);
  band(0, plasterTop, timber);
  // A soft shadow the rail throws on the boards under it.
  const lip = ctx.createLinearGradient(0, top, 0, top + 10);
  lip.addColorStop(0, "rgba(10,5,0,0.3)");
  lip.addColorStop(1, "rgba(10,5,0,0)");
  ctx.fillStyle = lip;
  ctx.fillRect(0, top, W, 10);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}
