// Where a place's model is put down: where a hex is in the world, which way a facing turns a model, and how
// big and how far back from its hex each kind of place stands (`PLACE`). The renderer sets every model down
// by these (WorldRenderer.buildPois), and a model that has to know how it will stand reads them too, so
// they are kept here, where both can reach them, and not in the renderer.

import * as THREE from "three";
import type { HexPos } from "@gantt-quest/core";
import type { Poi } from "@gantt-quest/world";

export const SQRT3 = Math.sqrt(3);

/** Straight up: the axis everything on the map turns about. */
export const UP = new THREE.Vector3(0, 1, 0);

/** Where a hex's middle is in the world, on the ground: x and z. */
export function hexToWorld(p: HexPos): { x: number; z: number } {
  return { x: SQRT3 * (p.q + p.r / 2), z: 1.5 * p.r };
}

/** A turn in sixths plus radians, as Three.js turns a model about y. */
export const yawOf = (facing: number, angle = 0) => -((facing * Math.PI) / 3 + angle);

/**
 * How a point of interest's model stands against its hex. Every model is made to fit one hex, with its middle
 * `back` behind the hex's (0.28 unless said here). The Harbor's places are drawn bigger than that, so a hero
 * looks the right size beside them: `scale` times as big, and far enough back that the building stands on the
 * ground behind its door (see `footing` in the world's harbor.ts) with the hero on the doorstep in front.
 * `turn` (in sixths of a turn, as a facing is) turns it further about its door: half a sixth for a thing that
 * stands on the one hex up and to the right of where it is used from, and so faces down and to the left.
 */
export const PLACE: Partial<Record<Poi["kind"], { scale: number; back: number; turn?: number }>> = {
  pub: { scale: 2.2, back: 1.6 },
  lighthouse: { scale: 3, back: 3 },
  works: { scale: 2, back: 1.8 },
  shop: { scale: 2, back: 1.6 },
  apothecary: { scale: 2, back: 1.7 },
  smithy: { scale: 2, back: 1.7 },
  galley: { scale: 2, back: 1.7 },
  plot: { scale: 1.7, back: 1.4 },
  lot: { scale: 2, back: 1.6 },
  site: { scale: 2, back: 1.6 },
  fishing: { scale: 1.6, back: 0.8 },
  cave: { scale: 2.2, back: 1.3 },
  board: { scale: 1.35, back: SQRT3, turn: 0.5 },
  // (A small shop: no bigger than the market stall, on the two hexes behind its door.)
  lapidary: { scale: 2, back: 1.6 },
  townchest: { scale: 1.6, back: SQRT3, turn: 0.5 },
  // The waygate hangs over the middle of the hex beside the one it is used from, at its own size.
  waygate: { scale: 1, back: SQRT3, turn: 0.5 },
  ring: { scale: 1.5, back: 0.42 },
  felling: { scale: 1.5, back: 0.42 },
  quarry: { scale: 1.5, back: 0.42 },
  rocks: { scale: 1.6, back: 0.45 },
  wreck: { scale: 1.8, back: 0.5 },
};
/** On a map of the world (RenderState.far) a place is a landmark of a small world: no bigger than its hex, and standing on it. */
const FAR_PLACE: Partial<Record<Poi["kind"], { scale: number; back: number; turn?: number }>> = {
  lighthouse: { scale: 1.2, back: 0.1 },
  cave: { scale: 1, back: 0.3 },
};
export const placeOf = (poi: Poi, far = false): { scale: number; back: number; turn?: number } => (far ? FAR_PLACE[poi.kind] : PLACE[poi.kind]) ?? { scale: far ? 0.8 : 1, back: far ? 0.1 : 0.28 };
