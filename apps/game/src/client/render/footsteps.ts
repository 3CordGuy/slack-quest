// Footsteps: when a walking hero's hop lands, what they landed on, and how it looks.
// Kept free of Three.js and the DOM so the rules can be tested on their own.

import type { Biome } from "@gantt-quest/world";

/** What a foot comes down on, which sets both the sound of the step and the puff it kicks up. */
export type StepGround = "grass" | "stone" | "wood" | "mud" | "water" | "floor";

/** Grass and fields are soft, paving and rock click, piers and room floors are hollow boards, the quay is dull mud. */
export function stepGround(biome: Biome | undefined): StepGround | null {
  switch (biome) {
    case "plains":
    case "forest":
      return "grass";
    case "hills":
    case "cobble":
    case "rampart":
    case "cave":
      return "stone";
    case "dock":
      return "wood";
    case "floor":
      return "floor";
    case "mud":
      return "mud";
    case "water":
      return "water";
    default:
      return null;
  }
}

/** The hop is |sin(stride × HOP_RATE)|: it touches the ground each time stride × HOP_RATE passes a multiple of π. */
export const HOP_RATE = 3.6;

/** How many times a hop lands while the stride goes from `before` to `after`. */
export function footfalls(before: number, after: number): number {
  return Math.max(0, Math.floor((after * HOP_RATE) / Math.PI) - Math.floor((before * HOP_RATE) / Math.PI));
}

/** The hex under a point on the ground (the inverse of hexToWorld, rounded to the nearest hex). */
export function worldToHex(x: number, z: number): { q: number; r: number } {
  const fr = z / 1.5;
  const fq = x / Math.sqrt(3) - fr / 2;
  const fs = -fq - fr;
  let q = Math.round(fq);
  let r = Math.round(fr);
  const s = Math.round(fs);
  const dq = Math.abs(q - fq);
  const dr = Math.abs(r - fr);
  const ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q: q + 0, r: r + 0 }; // + 0 turns -0 into 0
}

/** The puff a footfall kicks up on each ground: which pixel shape, its colours, how many bits and how strong. */
export interface PuffLook {
  kind: "dust" | "fleck" | "splash";
  colors: string[];
  count: number;
  /** Opacity it starts at. */
  alpha: number;
  /** Size of its 16-pixel tile in world units: about 1.1 makes its pixels the size of a hero sprite's (22 pixels to 1.5 units). */
  size: number;
}

export const PUFFS: Record<StepGround, PuffLook> = {
  grass: { kind: "fleck", colors: ["#d4f09a", "#b5e36f", "#eefac8"], count: 2, alpha: 0.95, size: 1.1 },
  stone: { kind: "dust", colors: ["#e6dcc6", "#cfc4ad"], count: 2, alpha: 0.8, size: 1.15 },
  wood: { kind: "dust", colors: ["#d8c19b", "#bfa47a"], count: 1, alpha: 0.6, size: 1.0 },
  mud: { kind: "splash", colors: ["#7a6248", "#5c4a36"], count: 2, alpha: 0.9, size: 1.1 },
  water: { kind: "splash", colors: ["#e4f4ff", "#9fd2f5"], count: 3, alpha: 0.9, size: 1.15 },
  // Indoors: nothing but a faint scuff.
  floor: { kind: "dust", colors: ["#d9c4a0"], count: 1, alpha: 0.3, size: 1.0 },
};

/** How loud another hero's step is, from how far they are from the middle of the view: softer than your own, gone by 14 units. */
export function stepVolume(mine: boolean, distance: number): number {
  if (mine) return 1;
  return 0.45 * Math.max(0, 1 - distance / 14);
}
