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
  // three.js reads back every shader program's log as it is first used, to report mistakes in it. Asking for the
  // log makes the browser finish compiling that program there and then, on the page's own thread: with a few
  // hundred programs between the town's views that was nearly half of the time the game took to open, and it
  // undid compiling them ahead on the browser's own threads (WorldRenderer's `warm`). So it is off, and asked
  // for when working on a shader: add `shaders` to the address (`?shaders`) on the dev server.
  renderer.debug.checkShaderErrors = import.meta.env.DEV && new URLSearchParams(location.search).has("shaders");
  // Made, but already lost: it would draw nothing.
  if (renderer.getContext().isContextLost()) {
    renderer.dispose();
    throw new GraphicsUnavailable();
  }
  return renderer;
}

/**
 * Done when every shader program the renderer has asked for is compiled and linked. Asking a program whether it is
 * ready costs nothing; asking it for anything else makes the browser finish it there and then.
 */
export function programsReady(renderer: THREE.WebGLRenderer): Promise<void> {
  return new Promise((done) => {
    const look = () => {
      const programs = (renderer.info.programs ?? []) as unknown as { isReady?(): boolean }[];
      if (renderer.getContext().isContextLost() || programs.every((p) => p.isReady?.() ?? true)) done();
      else setTimeout(look, 10);
    };
    look();
  });
}

let ahead: boolean | null = null;
/**
 * Whether this browser can compile shaders on threads of its own while the page goes on (the
 * KHR_parallel_shader_compile extension: Chrome, Edge and Safari have it, Firefox does not). Without it every
 * shader is compiled on the page's thread, one after another, as it is first used: loading the whole town with the
 * game then takes several times as long, so there it is not done (see App's Buildings).
 */
export function compilesAhead(): boolean {
  if (ahead !== null) return ahead;
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    ahead = !!gl?.getExtension("KHR_parallel_shader_compile");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    ahead = false;
  }
  return ahead;
}
