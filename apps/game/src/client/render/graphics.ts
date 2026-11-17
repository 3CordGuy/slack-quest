// Making a WebGL renderer, and saying so plainly when the browser will not give one.
//
// A browser can refuse: WebGL switched off, or (seen in Safari, in a tab left open a long time) every new
// context handed over already lost. Three.js then fails with a TypeError from deep inside itself, which
// says nothing to the player. Everything that draws makes its renderer here, so the failure has one name
// and the crash screen (Crash.tsx) can tell them what to do.

import * as THREE from "three";

/** The browser would not give the game a working WebGL context. */
export class GraphicsUnavailable extends Error {
  constructor(cause?: unknown) {
    super("The browser did not give the game a working 3D canvas (WebGL).");
    this.name = "GraphicsUnavailable";
    this.cause = cause;
  }
}

/** What to try, in the order worth trying it. Shown wherever the game finds it cannot draw. */
export const GRAPHICS_HELP = "Close this tab and open the game in a new one. If it still will not draw, quit your browser and open it again.";

/** A WebGL renderer, or GraphicsUnavailable when the browser will not make one that works. */
export function makeRenderer(params?: THREE.WebGLRendererParameters): THREE.WebGLRenderer {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer(params);
  } catch (e) {
    throw new GraphicsUnavailable(e);
  }
  // Made, but already lost: it would draw nothing.
  if (renderer.getContext().isContextLost()) {
    renderer.dispose();
    throw new GraphicsUnavailable();
  }
  return renderer;
}
