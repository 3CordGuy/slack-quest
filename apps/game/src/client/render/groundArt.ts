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
  shade.addColorStop(0, "rgba(255,240,210,0.14)");
  shade.addColorStop(0.18, "rgba(255,240,210,0)");
  shade.addColorStop(0.75, "rgba(40,20,0,0)");
  shade.addColorStop(1, "rgba(40,20,0,0.14)");
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
    ctx.globalAlpha = 0.16 + hash(id, 50 + i, salt) * 0.16;
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
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = wood.grain;
    ctx.beginPath();
    ctx.ellipse(kx, ky, 4, 2.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(kx, ky, 7, 4, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  // The ink outline.
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, 4);
  ctx.strokeStyle = wood.gap;
  ctx.lineWidth = 1;
  ctx.stroke();
  // Two nails at each end, each a dark head with a glint.
  for (const nx of [bx + 8, bx + bw - 8]) {
    for (const ny of [by + bh * 0.3, by + bh * 0.7]) {
      ctx.fillStyle = wood.nail;
      ctx.beginPath();
      ctx.arc(nx, ny, 1.9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.beginPath();
      ctx.arc(nx - 0.7, ny - 0.7, 0.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Floorboards for a hut: warm, honey-coloured boards running across the room. */
export function floorTexture(): THREE.CanvasTexture {
  return sheet((ctx) => planks(ctx, { boards: ["#b58d5e", "#ab8455", "#bd9566", "#b08a5c"], gap: "#7f5f3e", grain: "#9a7650", nail: "#6e5640" }, 300));
}

/** Planks for the piers: greyer, sea-weathered boards running out to sea. */
export function pierTexture(): THREE.CanvasTexture {
  return sheet((ctx) => {
    // Turned a quarter, so the boards run the other way from the floor's.
    ctx.translate(SIZE / 2, SIZE / 2);
    ctx.rotate(Math.PI / 2);
    ctx.translate(-SIZE / 2, -SIZE / 2);
    planks(ctx, { boards: ["#9a7a50", "#927448", "#a28256", "#97784e"], gap: "#6c5538", grain: "#86704c", nail: "#5c4c3c" }, 630);
  });
}
