// Item icons with some depth to them. Each 16x16 icon (itemArt.ts) is built
// into a little model, one block per pixel and a few blocks thick, turned a
// touch toward the viewer and lit from the upper left like the heroes'
// portraits. So every icon there is, and any an admin uploads, gets its 3D
// form without anyone modelling it.
//
// One small WebGL renderer, made the first time a picture is asked for,
// draws them all; each picture is drawn once and remembered.

import * as THREE from "three";
import { ART_PIXELS, iconArtListeners, itemArtPixels, itemArtUrl } from "../itemArt";

/** Pixels a picture is drawn at: shown at 36 to 54, so there is always detail to spare. */
const PX = 128;
/** How thick the model is, in icon pixels. */
const DEPTH = 3;

interface Studio {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  stand: THREE.Group;
  box: THREE.BoxGeometry;
  material: THREE.MeshLambertMaterial;
}

let studio: Studio | null | undefined;
const cache = new Map<string, string>();
iconArtListeners.add(() => cache.clear());

function open(): Studio | null {
  if (studio !== undefined) return studio;
  try {
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true, powerPreference: "low-power" });
    renderer.setPixelRatio(1);
    renderer.setSize(PX, PX, false);
    renderer.setClearColor(0x000000, 0);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight("#ffffff", "#5a6a8a", 1.5));
    const sun = new THREE.DirectionalLight("#fff1d8", 2.2);
    sun.position.set(-6, 9, 10);
    scene.add(sun);
    const stand = new THREE.Group();
    // Turned to show its right-hand edge and tipped to show its top, as a thing lying in a tray is seen.
    stand.rotation.set(0.32, -0.5, 0);
    scene.add(stand);
    const half = ART_PIXELS * 0.72;
    const camera = new THREE.OrthographicCamera(-half, half, half, -half, 1, 200);
    camera.position.set(0, 0, 100);
    studio = { renderer, scene, camera, stand, box: new THREE.BoxGeometry(1, 1, 1), material: new THREE.MeshLambertMaterial() };
  } catch {
    // No WebGL: the flat icons do.
    studio = null;
  }
  return studio;
}

/** Image URL for an icon's 3D form, in the given accent (rarity) colour. Falls back to the flat icon. */
export function voxelIconUrl(name: string, accent: string): string {
  const key = `${name}|${accent}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const s = open();
  if (!s) return itemArtUrl(name, accent);
  const img = itemArtPixels(name, accent);
  const cells: [number, number, number][] = [];
  for (let y = 0; y < ART_PIXELS; y++) {
    for (let x = 0; x < ART_PIXELS; x++) {
      const i = (y * ART_PIXELS + x) * 4;
      if (img.data[i + 3] > 127) cells.push([x, y, i]);
    }
  }
  const mesh = new THREE.InstancedMesh(s.box, s.material, cells.length);
  const at = new THREE.Matrix4();
  const colour = new THREE.Color();
  const mid = (ART_PIXELS - 1) / 2;
  cells.forEach(([x, y, i], n) => {
    at.makeScale(1, 1, DEPTH).setPosition(x - mid, mid - y, 0);
    mesh.setMatrixAt(n, at);
    mesh.setColorAt(n, colour.setRGB(img.data[i] / 255, img.data[i + 1] / 255, img.data[i + 2] / 255, THREE.SRGBColorSpace));
  });
  s.stand.add(mesh);
  let url = itemArtUrl(name, accent);
  try {
    s.renderer.render(s.scene, s.camera);
    url = s.renderer.domElement.toDataURL();
    cache.set(key, url);
  } catch {
    // A lost context: the flat icon this time.
  }
  s.stand.remove(mesh);
  mesh.dispose();
  return url;
}
