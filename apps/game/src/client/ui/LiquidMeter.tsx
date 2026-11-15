// A meter's fill, as liquid in its channel. It is shaded a pixel at a time
// on the rack's own grid, like a little shader: lighter along the top where
// it catches the light and darker along the bottom, slow swells of brighter
// colour sliding through it, the odd glint, and a leading edge that laps
// back and forth a pixel, brighter where it meets the air. The level eases
// to its new value rather than jumping.
//
// It redraws about fifteen times a second, and holds still for anyone who
// has asked for less motion.

import { useEffect, useRef } from "react";

type RGB = [number, number, number];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const hash = (x: number, y: number) => {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
};

/** Each liquid's colours: in shadow, its body, lit, and its brightest glint. */
const LIQUID: Record<string, [RGB, RGB, RGB, RGB]> = {
  hp: [[150, 26, 30], [214, 48, 40], [246, 110, 84], [255, 214, 196]],
  focus: [[32, 88, 140], [58, 140, 196], [124, 198, 236], [226, 246, 255]],
  stamina: [[176, 112, 20], [238, 176, 40], [252, 220, 104], [255, 250, 214]],
};

export function LiquidMeter({ kind, now, max, w, h }: { kind: keyof typeof LIQUID; now: number; max: number; w: number; h: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const goal = useRef(0);
  goal.current = Math.max(0, Math.min(1, now / Math.max(1, max)));

  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(w, h);
    const [deep, body, lit, glint] = LIQUID[kind];
    const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    let level = goal.current;
    let frame = 0;
    let last = 0;
    const draw = (ms: number) => {
      frame = requestAnimationFrame(draw);
      if (ms - last < 66) return;
      const dt = Math.min(0.25, (ms - last) / 1000);
      last = ms;
      level += (goal.current - level) * (1 - Math.exp(-dt * 6));
      const t = still ? 0 : ms / 1000;
      for (let y = 0; y < h; y++) {
        // The leading edge laps: each row a little ahead of or behind the level, in its own time.
        const edge = level >= 0.999 ? w : level * w + (level > 0.01 ? Math.sin(t * 2.4 + y * 1.7) * 0.7 : 0);
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (x + 0.5 > edge) {
            img.data[i + 3] = 0;
            continue;
          }
          // Top row lit, bottom row in shadow, the body between.
          let c: RGB = y === 0 ? mix(body, lit, 0.7) : y === h - 1 ? mix(body, deep, 0.75) : body;
          // Swells: bands of brighter colour drifting along, leaning as they go.
          const swell = 0.5 + 0.5 * Math.sin(x * 0.42 - t * 1.5 + y * 0.9 + Math.sin(t * 0.6 + x * 0.11) * 1.4);
          c = mix(c, lit, swell * swell * 0.42);
          // A glint now and then, mostly near the top.
          if (hash(x + Math.floor(t * 5) * 7, y) > 0.975 + y * 0.006) c = mix(c, glint, 0.8);
          // Where the liquid meets the air it is brightest.
          if (level < 0.999 && edge - x < 1.5) c = mix(c, glint, 0.55);
          img.data[i] = c[0];
          img.data[i + 1] = c[1];
          img.data[i + 2] = c[2];
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [kind, w, h]);

  return <canvas ref={canvas} className="liquid-meter" width={w} height={h} aria-hidden />;
}
