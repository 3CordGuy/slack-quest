// Footsteps: when a walking hero's hop lands, what they landed on, and how it looks.
// Kept free of Three.js and the DOM so the rules can be tested on their own.

import type { Biome } from "@gantt-quest/world";

/** What a foot comes down on, which sets both the sound of the step and the puff it kicks up. */
export type StepGround = "grass" | "dirt" | "stone" | "wood" | "mud" | "water" | "floor";

/**
 * Grass and fields are soft, paving and rock click, piers and room floors are hollow boards, the quay is dull mud.
 * `path` is whether a dirt path crosses the hex: on grass, that is dry trodden earth underfoot, not turf.
 */
export function stepGround(biome: Biome | undefined, path = false): StepGround | null {
  if (path && biome === "plains") return "dirt";
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

/**
 * The puff a footfall kicks up on each ground, as a few low-poly pieces: lumps of dust that swell and drift off,
 * chips of grass that tumble away, or drops that are thrown up and fall back. Which, their colours, how many,
 * and how big a piece is (world units; a hero stands about 1.5 tall).
 */
export interface PuffLook {
  kind: "dust" | "fleck" | "splash";
  colors: string[];
  count: number;
  size: number;
}

/** A ground's puff may be of more than one kind at once: grass throws up chips of itself and a little pale dust with them. */
export const PUFFS: Record<StepGround, PuffLook[]> = {
  // Small: a couple of pale puffs that show against the green, and chips of grass.
  grass: [
    { kind: "dust", colors: ["#e9efcf", "#d6e2b4"], count: 2, size: 0.07 },
    { kind: "fleck", colors: ["#a9dc6c", "#c7ec92"], count: 2, size: 0.08 },
  ],
  // A dirt path is dry and loose: the biggest puffs, the colour of its earth.
  dirt: [{ kind: "dust", colors: ["#d2b88c", "#c0a274", "#dcc8a0"], count: 4, size: 0.14 }],
  stone: [{ kind: "dust", colors: ["#e2d9c4", "#cfc5ae"], count: 3, size: 0.11 }],
  wood: [{ kind: "dust", colors: ["#d8c4a0", "#c4ab84"], count: 2, size: 0.09 }],
  mud: [{ kind: "splash", colors: ["#7a6248", "#5c4a36"], count: 3, size: 0.05 }],
  water: [{ kind: "splash", colors: ["#e4f4ff", "#9fd2f5"], count: 4, size: 0.05 }],
  // Indoors: nothing but a faint scuff.
  floor: [{ kind: "dust", colors: ["#d9c4a0"], count: 1, size: 0.06 }],
};

