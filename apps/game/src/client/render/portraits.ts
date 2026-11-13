// Pictures of the figures for the HUD (crew lists, the character sheet, the
// admin page): each model drawn once, standing, on a small see-through
// canvas, at the same 18 by 22 shape the old sprites had. One little WebGL
// renderer, made the first time a picture is asked for, draws them all.

import * as THREE from "three";
import { ENEMIES, type Outfit } from "@gantt-quest/world";
import { FOUR_LEGGED, makeFigure } from "./figures";
import type { Look } from "./looks";

/** A picture's size in pixels at detail 1: twice the old sprite. */
const W = 36;
const H = 44;
/** The frame a person fits in, in model units, with room for a hat or a staff. */
const FRAME_H = 25;
const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

interface Studio {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  /** Tips whoever stands on it a little toward the viewer, as the game's camera looks down on them. */
  stand: THREE.Group;
}

let studio: Studio | null | undefined;

function open(): Studio | null {
  if (studio !== undefined) return studio;
  try {
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, preserveDrawingBuffer: true, powerPreference: "low-power" });
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 0);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight("#ffffff", "#8a8fa8", 1.9));
    const sun = new THREE.DirectionalLight("#fff4e0", 1.7);
    sun.position.set(-4, 7, 9);
    scene.add(sun);
    const stand = new THREE.Group();
    stand.rotation.x = 0.2;
    scene.add(stand);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 200);
    camera.position.set(0, 0, 100);
    studio = { renderer, scene, camera, stand };
  } catch {
    // No WebGL: the HUD goes without faces.
    studio = null;
  }
  return studio;
}

/**
 * A figure's picture as an image URL. Heroes and townsfolk turn a little to their left, enemies to their
 * right (they face the heroes), and the animals stand side-on. `detail` multiplies the pixel size.
 */
export function portraitUrl(kind: string, look: Look, outfit: Outfit | undefined, asleep: boolean, detail = 1): string {
  const s = open();
  if (!s) return BLANK;
  // The outline is about a pixel wide whatever the detail.
  const figure = makeFigure(kind, look, outfit, { asleep, edge: 0.55 / detail });
  figure.setSize(22);
  const foe = !outfit && !!ENEMIES[kind];
  figure.root.rotation.y = (foe ? -1 : 1) * (FOUR_LEGGED.has(kind) ? 1.15 : 0.5);
  s.stand.add(figure.root);
  s.stand.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(s.stand);
  // A person's frame, widened for whatever is too big for it (a bear, a great axe).
  const tall = Math.max(FRAME_H, box.max.y - box.min.y + 2, ((box.max.x - box.min.x + 2) * H) / W);
  const wide = (tall * W) / H;
  const midX = (box.min.x + box.max.x) / 2;
  const foot = box.min.y - 1;
  s.camera.left = midX - wide / 2;
  s.camera.right = midX + wide / 2;
  s.camera.bottom = foot;
  s.camera.top = foot + tall;
  s.camera.updateProjectionMatrix();
  s.renderer.setSize(W * detail, H * detail, false);
  let url = BLANK;
  try {
    s.renderer.render(s.scene, s.camera);
    url = s.renderer.domElement.toDataURL();
  } catch {
    // A lost context: no picture this time.
  }
  s.stand.remove(figure.root);
  figure.dispose();
  return url;
}
