// Seeing someone through what hides them.
//
// A hero behind a tree or a wall (and an enemy in a fight) is shown through it as a flat shape of one colour,
// so nobody is lost behind the scenery. Only trees and walls do this: a figure behind a rise in the ground,
// long grass or another figure is simply hidden, as before.
//
// It is done in the one drawing of the scene, in three steps kept apart by render order:
//
//   1. What hides (`HIDES`): the trees, and a copy of the wall hexes that writes depth and no colour. Drawn
//      before anything else, so for a moment the depth buffer holds them and nothing more.
//   2. The mark (`MARK`): each figure's body again, drawing nothing, kept only where it is *behind* that depth,
//      and writing the figure's own number into the stencil there. Those are the pixels where a tree or a wall
//      stands in front of it.
//   3. Everything else, as always. Then, first of what is see-through, the shape: the body once more, over
//      whatever is there, only where the stencil still holds its number, which it clears as it goes so that an
//      arm crossing the chest is not laid on twice.
//
// So it needs a stencil buffer, on the canvas (WorldRenderer) and on the finishing pass's own picture (post.ts).

import * as THREE from "three";

/** Render order for what hides a figure, and for a figure's mark behind it: both before the rest of the scene (0). */
export const HIDES = -2;
const MARK = -1;
/** How solid the shape is. */
const OPACITY = 0.55;

/** One number each, 1 to 255, round and round: two figures with the same number would only share their shapes' pixels. */
let numbers = 0;

/** Depth and no colour, a little behind where it really is: for the copy of the walls, so the walls themselves still draw over it. */
export function hidingMaterial(clippingPlanes?: THREE.Plane[]): THREE.Material {
  return new THREE.MeshBasicMaterial({ colorWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2, clippingPlanes });
}

export interface Silhouette {
  /** Show it in this colour, or not at all. */
  show(color: string | null): void;
  dispose(): void;
}

/**
 * The shape of these meshes (a figure's body, piece by piece) seen through trees and walls: two more meshes on
 * each, sharing its geometry and moving as it does. Nothing is drawn until `show` gives it a colour.
 */
export function makeSilhouette(bodies: THREE.Mesh[]): Silhouette {
  const number = (numbers = (numbers % 255) + 1);
  const mark = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthFunc: THREE.GreaterDepth, stencilWrite: true, stencilRef: number, stencilZPass: THREE.ReplaceStencilOp });
  const shape = new THREE.MeshBasicMaterial({ transparent: true, opacity: OPACITY, depthTest: false, depthWrite: false, fog: false, stencilWrite: true, stencilRef: number, stencilFunc: THREE.EqualStencilFunc, stencilZPass: THREE.ZeroStencilOp });
  const meshes: THREE.Mesh[] = [];
  for (const body of bodies) {
    for (const material of [mark, shape]) {
      const mesh = new THREE.Mesh(body.geometry, material);
      mesh.renderOrder = MARK;
      mesh.visible = false;
      body.add(mesh);
      meshes.push(mesh);
    }
  }
  return {
    show(color) {
      if (color) shape.color.set(color);
      for (const mesh of meshes) mesh.visible = !!color;
    },
    dispose() {
      for (const mesh of meshes) mesh.removeFromParent();
      mark.dispose();
      shape.dispose();
    },
  };
}
