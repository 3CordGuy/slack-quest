// Item icons with some depth to them. Gear, materials and gold each have a little low-poly model
// (ui/lowPolyIcons.ts), faceted like the heroes, posed, framed to fill the picture and inked round the
// edge. Any other icon, and any an admin has redrawn, is built from its 16x16 pixels (itemArt.ts): one
// block per pixel and a few blocks thick, turned a touch toward the viewer. Both are lit from the upper
// left like the heroes' portraits.
//
// One small WebGL renderer, made the first time a picture is asked for,
// draws them all; each picture is drawn once and remembered.

import * as THREE from "three";
import { ART_PIXELS, hasIconOverride, iconArtListeners, itemArtPixels, itemArtUrl } from "../itemArt";
import { buildLowPoly, disposeLowPoly } from "./lowPolyIcons";

/** Pixels a picture is drawn at: shown at 36 to 54, so there is always detail to spare. */
const PX = 128;
/** How thick the block model is, in icon pixels. */
const DEPTH = 3;
/** The ink round a low-poly model, in picture pixels, and its colour (the pixel icons' outline). */
const INK = 3;
const INK_COLOR = "#1b1830";
/** Room left round a model for its ink, and a little to breathe, as a share of the picture. */
const MARGIN = (INK + 3) / PX;

interface Studio {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  stand: THREE.Group;
  box: THREE.BoxGeometry;
  material: THREE.MeshLambertMaterial;
  /** Scratch canvases for inking: the model's shape in ink, and the picture with its outline. */
  shape: CanvasRenderingContext2D;
  out: CanvasRenderingContext2D;
}

let studio: Studio | null | undefined;
const cache = new Map<string, string>();
iconArtListeners.add(() => cache.clear());

const scratch = () => {
  const c = document.createElement("canvas");
  c.width = PX;
  c.height = PX;
  return c.getContext("2d")!;
};

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
    scene.add(stand);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 400);
    studio = { renderer, scene, camera, stand, box: new THREE.BoxGeometry(1, 1, 1), material: new THREE.MeshLambertMaterial(), shape: scratch(), out: scratch() };
  } catch {
    // No WebGL: the flat icons do.
    studio = null;
  }
  return studio;
}

/** Point the camera straight down -z at a square `half` across each way round (x, y). */
function aim(camera: THREE.OrthographicCamera, x: number, y: number, half: number, front: number) {
  camera.left = x - half;
  camera.right = x + half;
  camera.top = y + half;
  camera.bottom = y - half;
  camera.position.set(0, 0, front + 100);
  camera.near = 1;
  camera.far = 400;
  camera.updateProjectionMatrix();
}

/** The picture just rendered with a dark line round its edge, as a URL. */
function inked(s: Studio): string {
  const { shape, out } = s;
  const src = s.renderer.domElement;
  shape.globalCompositeOperation = "source-over";
  shape.clearRect(0, 0, PX, PX);
  shape.drawImage(src, 0, 0);
  shape.globalCompositeOperation = "source-in";
  shape.fillStyle = INK_COLOR;
  shape.fillRect(0, 0, PX, PX);
  out.clearRect(0, 0, PX, PX);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    out.drawImage(shape.canvas, Math.cos(a) * INK, Math.sin(a) * INK);
  }
  out.drawImage(src, 0, 0);
  return out.canvas.toDataURL();
}

/** The low-poly picture for an icon, or null when it has no model. */
function lowPolyUrl(s: Studio, name: string, accent: string): string | null {
  const built = buildLowPoly(name, accent);
  if (!built) return null;
  const { model, def } = built;
  // Turned about its own upright, then laid on its slant, then its top leant away.
  const spin = new THREE.Group();
  spin.rotation.y = def.spin ?? 0.5;
  spin.add(model);
  const lean = new THREE.Group();
  lean.rotation.z = def.lean ?? 0;
  lean.add(spin);
  s.stand.rotation.set(def.tip ?? 0.3, 0, 0);
  s.stand.add(lean);
  s.stand.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(s.stand, true);
  const size = box.getSize(new THREE.Vector3());
  const mid = box.getCenter(new THREE.Vector3());
  const half = Math.max(size.x, size.y) / 2 / (1 - 2 * (MARGIN + (def.pad ?? 0)));
  aim(s.camera, mid.x, mid.y, half, box.max.z);
  let url: string | null = null;
  try {
    s.renderer.render(s.scene, s.camera);
    url = inked(s);
  } catch {
    // A lost context: the flat icon this time.
  }
  s.stand.remove(lean);
  disposeLowPoly(model);
  return url;
}

/** The pixel icon built in blocks. */
function blockUrl(s: Studio, name: string, accent: string): string | null {
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
  // Turned to show its right-hand edge and tipped to show its top, as a thing lying in a tray is seen.
  s.stand.rotation.set(0.32, -0.5, 0);
  s.stand.add(mesh);
  aim(s.camera, 0, 0, ART_PIXELS * 0.72, 0);
  let url: string | null = null;
  try {
    s.renderer.render(s.scene, s.camera);
    url = s.renderer.domElement.toDataURL();
  } catch {
    // A lost context: the flat icon this time.
  }
  s.stand.remove(mesh);
  mesh.dispose();
  return url;
}

/** Image URL for an icon's 3D form, in the given accent (rarity) colour. Falls back to the flat icon. */
export function voxelIconUrl(name: string, accent: string): string {
  const key = `${name}|${accent}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const s = open();
  if (!s) return itemArtUrl(name, accent);
  const url = (!hasIconOverride(name) && lowPolyUrl(s, name, accent)) || blockUrl(s, name, accent);
  if (!url) return itemArtUrl(name, accent);
  cache.set(key, url);
  return url;
}
