// The chart behind the hero's gear in the sea bag: a sea chart's line work,
// in faint gold, filling the whole of the gear's panel. From the middle of
// the body slot a compass rose throws its thirty-two rhumb lines out to the
// edges; rings and a ring of ticks are struck round it; two small wind roses
// sit in the lower corners; and a ruled border with a scale's alternating
// bars runs round the panel.
//
// The chart is drawn round the gear, not under it. Each slot's place is
// cleared, and a cartouche is ruled round it: a fine box with a diamond at
// each corner for the larger slots, a ring with four ticks for the small
// ones. So every slot sits in a frame the chart has made for it.

import { useEffect, useRef } from "react";

/** A slot's place on the panel, in squares. */
export interface ChartSlot {
  x: number;
  y: number;
  w: number;
  h: number;
}

const GOLD = (a: number) => `rgba(244, 198, 78, ${a})`;

function paint(canvas: HTMLCanvasElement, slots: ChartSlot[], unit: number, focus: { x: number; y: number }, pad: { x: number; y: number }) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  const D = Math.min(3, Math.max(2, Math.ceil(devicePixelRatio || 1)));
  canvas.width = w * D;
  canvas.height = h * D;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(D, 0, 0, D, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.lineCap = "round";
  const cx = pad.x + focus.x * unit;
  const cy = pad.y + focus.y * unit;
  const far = Math.hypot(w, h);
  const line = (x0: number, y0: number, x1: number, y1: number) => {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  };
  const circle = (x: number, y: number, r: number) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  };
  /** A star of eight points: the four winds long, the four between them short, each a kite half washed in. */
  const star = (x: number, y: number, long: number, short: number, strength: number) => {
    const point = (turn: number, reach: number, waist: number) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(turn);
      ctx.strokeStyle = GOLD(strength);
      ctx.beginPath();
      ctx.moveTo(0, -reach);
      ctx.lineTo(waist, -waist);
      ctx.lineTo(0, 0);
      ctx.lineTo(-waist, -waist);
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = GOLD(strength * 0.4);
      ctx.beginPath();
      ctx.moveTo(0, -reach);
      ctx.lineTo(waist, -waist);
      ctx.lineTo(0, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };
    for (let i = 0; i < 4; i++) point((i * Math.PI) / 2 + Math.PI / 4, short, short * 0.16);
    for (let i = 0; i < 4; i++) point((i * Math.PI) / 2, long, long * 0.14);
  };

  ctx.lineWidth = 1;

  // The rhumb lines: thirty-two from the rose's middle to the edges, the eight principal winds a little stronger.
  for (let i = 0; i < 32; i++) {
    const a = (i * Math.PI) / 16;
    ctx.strokeStyle = GOLD(i % 4 === 0 ? 0.17 : i % 2 === 0 ? 0.1 : 0.06);
    line(cx, cy, cx + Math.cos(a) * far, cy + Math.sin(a) * far);
  }
  // Rings struck round it, and a ring of ticks between the outer pair.
  ctx.strokeStyle = GOLD(0.16);
  for (const r of [1.95, 2.08, 3.55, 3.7, 5.5]) circle(cx, cy, r * unit);
  for (let i = 0; i < 96; i++) {
    const a = (i * Math.PI) / 48;
    const inner = (i % 12 === 0 ? 3.36 : i % 3 === 0 ? 3.45 : 3.5) * unit;
    ctx.strokeStyle = GOLD(i % 12 === 0 ? 0.24 : 0.13);
    line(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner, cx + Math.cos(a) * 3.55 * unit, cy + Math.sin(a) * 3.55 * unit);
  }
  star(cx, cy, 3.3 * unit, 2.2 * unit, 0.16);

  // Two small wind roses in the lower corners, each with its own ring.
  for (const sx of [1.5, 10.5]) {
    const [x, y] = [pad.x + sx * unit, pad.y + (h - pad.y * 2) - 0.72 * unit];
    ctx.strokeStyle = GOLD(0.2);
    circle(x, y, 0.56 * unit);
    circle(x, y, 0.62 * unit);
    star(x, y, 0.52 * unit, 0.34 * unit, 0.26);
  }

  // The border: two ruled lines with a scale's alternating bars between them.
  const [o, t] = [5.5, 4];
  ctx.strokeStyle = GOLD(0.3);
  ctx.strokeRect(o, o, w - o * 2, h - o * 2);
  ctx.strokeStyle = GOLD(0.18);
  ctx.strokeRect(o + t, o + t, w - (o + t) * 2, h - (o + t) * 2);
  ctx.fillStyle = GOLD(0.2);
  const bar = 14;
  for (let x = o, i = 0; x < w - o; x += bar, i++) {
    if (i % 2) continue;
    const len = Math.min(bar, w - o - x);
    ctx.fillRect(x, o, len, t);
    ctx.fillRect(x, h - o - t, len, t);
  }
  for (let y = o, i = 0; y < h - o; y += bar, i++) {
    if (i % 2) continue;
    const len = Math.min(bar, h - o - y);
    ctx.fillRect(o, y, t, len);
    ctx.fillRect(w - o - t, y, t, len);
  }

  // The chart gives way to each slot, and rules a cartouche round it.
  for (const s of slots) {
    const [x, y, sw, sh] = [pad.x + s.x * unit, pad.y + s.y * unit, s.w * unit, s.h * unit];
    const small = s.w === 1 && s.h === 1;
    if (small) {
      const [mx, my, r] = [x + sw / 2, y + sh / 2, unit * 0.82];
      // Nothing of the chart inside the ring.
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      ctx.arc(mx, my, r + 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = GOLD(0.42);
      circle(mx, my, r);
      ctx.strokeStyle = GOLD(0.2);
      circle(mx, my, r + 3);
      // A tick at each of the four winds.
      ctx.strokeStyle = GOLD(0.5);
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2;
        line(mx + Math.cos(a) * (r - 3), my + Math.sin(a) * (r - 3), mx + Math.cos(a) * (r + 6), my + Math.sin(a) * (r + 6));
      }
      continue;
    }
    const g = 6;
    ctx.clearRect(x - g - 4, y - g - 4, sw + (g + 4) * 2, sh + (g + 4) * 2);
    ctx.strokeStyle = GOLD(0.42);
    ctx.strokeRect(x - g + 0.5, y - g + 0.5, sw + g * 2 - 1, sh + g * 2 - 1);
    ctx.strokeStyle = GOLD(0.18);
    ctx.strokeRect(x - g - 3 + 0.5, y - g - 3 + 0.5, sw + (g + 3) * 2 - 1, sh + (g + 3) * 2 - 1);
    // A diamond on each corner, and a tick at the middle of each side.
    ctx.fillStyle = GOLD(0.6);
    for (const [px, py] of [[x - g, y - g], [x + sw + g, y - g], [x - g, y + sh + g], [x + sw + g, y + sh + g]]) {
      ctx.beginPath();
      ctx.moveTo(px, py - 3.5);
      ctx.lineTo(px + 3.5, py);
      ctx.lineTo(px, py + 3.5);
      ctx.lineTo(px - 3.5, py);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = GOLD(0.45);
    line(x + sw / 2, y - g - 5, x + sw / 2, y - g + 2);
    line(x + sw / 2, y + sh + g - 2, x + sw / 2, y + sh + g + 5);
    line(x - g - 5, y + sh / 2, x - g + 2, y + sh / 2);
    line(x + sw + g - 2, y + sh / 2, x + sw + g + 5, y + sh / 2);
  }
}

/**
 * The chart, sized to the panel it lies in. `unit` is a square's size in screen pixels, `focus` the rose's
 * middle in squares, and `pad` the panel's own padding, which the slots' places are measured inside.
 */
export function DollChart({ slots, unit, focus, pad }: { slots: ChartSlot[]; unit: number; focus: { x: number; y: number }; pad: { x: number; y: number } }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      try {
        paint(canvas, slots, unit, focus, pad);
      } catch {
        // No canvas: the gear lies on the plain hide.
      }
    };
    const watch = new ResizeObserver(draw);
    watch.observe(canvas);
    draw();
    return () => watch.disconnect();
    // The slots' places are fixed for the life of the bag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit]);
  return <canvas ref={ref} className="bag-chart" aria-hidden />;
}
