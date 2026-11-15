// The people and creatures of the world as small low-poly models, built from
// primitives like the furniture (props.ts) and the places on the map. A
// figure is a handful of jointed parts (legs, arms, head, whatever is held),
// each one merged mesh with its colours on the vertices, so it can walk,
// breathe, swing and lie down for a few draw calls.
//
// Everything is modelled in the old sprite's pixels: a person is about 17
// units from the soles to the crown, on a 22-unit frame. `setSize` scales
// that frame to world units. A figure faces +z; its right hand is at -x.
//
// Heroes wear what they have equipped: every base item and every weapon has
// its own shape, with its rarity colour as the trim.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import { GARB_PREFIX, INK_COLORS, INK_LEVELS, INK_REGIONS, RARITY_COLOR, WEAPONS, appearanceK, decodeInk, inkColorOf, inkLevelOf, type Appearance, type Ink, type InkRegion, type InkView, type Outfit, type Slot } from "@gantt-quest/world";
import type { Look } from "./looks";

export const OUTLINE = "#1b1830";
/** Set by makeFigure for the figure being built: a fishing rod goes in its right hand (gilded, for a full Catch Book). */
let rodInHand: boolean | "gilded" = false;
const GEAR = { steel: "#c9d1dc", shine: "#f1f5fa", iron: "#8b95a5", wood: "#8a5a2b", leather: "#a0683a", gold: "#e0b12e", paper: "#e8dcc0", bone: "#eee6cf", dark: "#2a2740" };
/** The frame a figure is modelled in, in model units: `setSize(1)` makes this one world unit tall. */
export const FRAME = 22;

type Rot = [number, number, number];
const ONE = new THREE.Vector3(1, 1, 1);
const HALF_PI = Math.PI / 2;

/** A colour a little lighter (k > 0) or darker (k < 0). */
function tone(hex: string, k: number): string {
  return `#${new THREE.Color(hex).offsetHSL(0, 0, k).getHexString()}`;
}

/**
 * Wear, so nobody looks fresh out of the box: every surface is broken into the model's own pixels, some of
 * them scuffed darker and a few rubbed pale, with larger patches of grime over that. It is worked out from
 * where a point lies in its part (stepped a little inside the surface, so a face never straddles two cells),
 * so it stays put on a limb as it swings.
 */
const WEAR = /* glsl */ `
{
  vec3 gritCell = floor( vGrit / 1.4 );
  float gritSpeck = fract( sin( dot( gritCell, vec3( 127.1, 311.7, 74.7 ) ) ) * 43758.5453 );
  vec3 gritPatch = floor( vGrit / 4.3 + 0.5 );
  float gritStain = fract( sin( dot( gritPatch, vec3( 269.5, 183.3, 246.1 ) ) ) * 43758.5453 );
  diffuseColor.rgb *= 1.0 - 0.2 * step( 0.76, gritSpeck ) + 0.1 * step( gritSpeck, 0.07 ) - 0.16 * gritStain * gritStain;
}`;

/** Lit like the furniture, but never darker than a third of its own colour: nobody vanishes at night. */
function bodyMaterial(): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("void main() {", "varying vec3 vGrit;\nvoid main() {")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n  vGrit = position - normal * 0.3;");
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", "varying vec3 vGrit;\nvoid main() {")
      .replace("#include <color_fragment>", `#include <color_fragment>${WEAR}`)
      .replace("#include <opaque_fragment>", "outgoingLight = max(outgoingLight, diffuseColor.rgb * 0.32);\n  #include <opaque_fragment>");
  };
  m.customProgramCacheKey = () => "gq-figure-body";
  return m;
}

/** The mud a figure picks up, and how high up it it reaches, in model units. */
const MUD = new THREE.Color("#5a4630");
const MUD_HEIGHT = 6.5;

/** A small seeded generator, so a figure's patches fall the same way every time it is built. */
let seed = 1;
function rand(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}

/**
 * Lets a figure fade away: a share of its pixels, in a fine fixed pattern, are simply not drawn, more of them
 * the further it has faded. It stays solid where it is drawn, so its parts still hide each other properly
 * (which see-through materials would not), and the pattern suits the pixels. `fade.value` is how much of it
 * is left, 1 to 0. Keeps any shader changes the material already has.
 */
function fadeable<M extends THREE.Material>(material: M, fade: { value: number }, key: string): M {
  const before = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    before.call(this, shader, renderer);
    shader.uniforms.figureFade = fade;
    shader.fragmentShader = shader.fragmentShader.replace(
      "void main() {",
      /* glsl */ `uniform float figureFade;
float figureDither() {
  ivec2 p = ivec2( mod( gl_FragCoord.xy, 4.0 ) );
  float m[16] = float[16]( 0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0 );
  return ( m[ p.x + p.y * 4 ] + 0.5 ) / 16.0;
}
void main() {
  if ( figureFade < 1.0 && figureFade <= figureDither() ) discard;`,
    );
  };
  material.customProgramCacheKey = () => key;
  return material;
}

/**
 * People (heroes, townsfolk and the humanoid enemies) are drawn low-poly, from tapered, faceted shapes with
 * exaggerated proportions (a big head, big hands and feet, broad shoulders over a narrow waist). The old box
 * people can be brought back per browser from the dev toolbox, to compare (it reloads the page); a hero who
 * has chosen how they look (appearance.ts) is low-poly regardless. The creatures (see rigFor) are drawn
 * low-poly too, from the same tapered, faceted shapes, and have no box models left.
 */
export const BLOCKY_KEY = "gq.dev.blockyPeople";
const BLOCKY_PREF = (() => {
  try {
    return localStorage.getItem(BLOCKY_KEY) === "1";
  } catch {
    return false;
  }
})();
/** How much bigger a low-poly head is than the box head it stands in for: a hat or helmet drawn in its space grows with it. */
const BIG_HEAD = 1.22;
/** Set by makeFigure for the figure being built: whether it is low-poly, and the look its hero chose (if any). */
let lowPoly = false;
let chosen: Appearance | null = null;

/** The body's proportions for the figure being built, from its chosen appearance: 1 is the usual for each. */
interface Measures {
  legs: number;
  girth: number;
  shoulders: number;
  /** How wide the hips are, so how far apart the legs stand. */
  hips: number;
  head: number;
}
const USUAL: Measures = { legs: 1, girth: 1, shoulders: 1, hips: 1, head: 1 };
let m: Measures = USUAL;
function measuresOf(look: Appearance | null): Measures {
  if (!look) return USUAL;
  return { legs: appearanceK("height", look), girth: appearanceK("build", look), shoulders: appearanceK("shoulders", look), hips: appearanceK("hips", look), head: appearanceK("headSize", look) };
}

/** One ring of a loft: its height, its half-width (x) and half-depth (z), and how far forward its middle is. */
type Ring = readonly [y: number, rx: number, rz: number, dz?: number];
type Pt = [number, number, number];

/**
 * A faceted tube through elliptical rings stacked up y, capped at both ends: a limb, a torso, a head. Its
 * sides are turned half a step so a flat face, not an edge, looks along +z.
 */
function loftGeometry(rings: readonly Ring[], sides: number): THREE.BufferGeometry {
  const sorted = [...rings].sort((p, q) => p[0] - q[0]);
  const loops = sorted.map(([y, rx, rz, dz = 0]) =>
    Array.from({ length: sides }, (_, k) => {
      const a = ((k + 0.5) / sides) * Math.PI * 2;
      return new THREE.Vector3(Math.sin(a) * rx, y, Math.cos(a) * rz + dz);
    }),
  );
  const out: number[] = [];
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (let i = 0; i + 1 < loops.length; i++) {
    for (let k = 0; k < sides; k++) {
      const n = (k + 1) % sides;
      tri(loops[i][k], loops[i][n], loops[i + 1][n]);
      tri(loops[i][k], loops[i + 1][n], loops[i + 1][k]);
    }
  }
  const cap = (i: number, up: boolean) => {
    const [y, , , dz = 0] = sorted[i];
    const c = new THREE.Vector3(0, y, dz);
    for (let k = 0; k < sides; k++) {
      const n = (k + 1) % sides;
      if (up) tri(c, loops[i][k], loops[i][n]);
      else tri(c, loops[i][n], loops[i][k]);
    }
  };
  cap(0, false);
  cap(loops.length - 1, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
  g.computeVertexNormals();
  return g;
}

/** A box `w` by `h` by `d` about its middle with every corner cut off: the hull of points set back from each corner along its three edges. */
function bevelledBox(w: number, h: number, d: number): THREE.BufferGeometry {
  const b = Math.min(w, h, d) * 0.24;
  const [x, y, z] = [w / 2, h / 2, d / 2];
  const pts: THREE.Vector3[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        pts.push(new THREE.Vector3(sx * (x - b), sy * y, sz * z), new THREE.Vector3(sx * x, sy * (y - b), sz * z), new THREE.Vector3(sx * x, sy * y, sz * (z - b)));
      }
    }
  }
  return new ConvexGeometry(pts);
}

/** Points given for one side (+x) and mirrored to the other; any on the middle line kept once. */
const sym = (pts: Pt[]): Pt[] => pts.flatMap(([x, y, z]): Pt[] => (x ? [[x, y, z], [-x, y, z]] : [[x, y, z]]));

/**
 * The outline's shell for a rounded shape: every corner pushed out `by` along the faces that meet there,
 * so the dark edge is the same width all round (a box's shell is simply scaled; a tapered limb's would not be).
 */
export function inflate(g: THREE.BufferGeometry, by: number): THREE.BufferGeometry {
  const pos = g.getAttribute("position");
  const key = (i: number) => `${Math.round(pos.getX(i) * 1000)},${Math.round(pos.getY(i) * 1000)},${Math.round(pos.getZ(i) * 1000)}`;
  const sums = new Map<string, THREE.Vector3>();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let f = 0; f < pos.count; f += 3) {
    a.fromBufferAttribute(pos, f);
    b.fromBufferAttribute(pos, f + 1);
    c.fromBufferAttribute(pos, f + 2);
    const n = b.sub(a).cross(c.sub(a));
    if (n.lengthSq() < 1e-12) continue;
    n.normalize();
    for (let i = f; i < f + 3; i++) {
      const k = key(i);
      let sum = sums.get(k);
      if (!sum) sums.set(k, (sum = new THREE.Vector3()));
      sum.add(n);
    }
  }
  const shell = g.clone();
  shell.deleteAttribute("normal");
  const out = shell.getAttribute("position");
  for (let i = 0; i < out.count; i++) {
    const sum = sums.get(key(i));
    if (!sum || sum.lengthSq() === 0) continue;
    a.copy(sum).normalize().multiplyScalar(by);
    out.setXYZ(i, out.getX(i) + a.x, out.getY(i) + a.y, out.getZ(i) + a.z);
  }
  return shell;
}

interface Mats {
  body: THREE.MeshLambertMaterial;
  outline: THREE.MeshBasicMaterial;
  glow: THREE.MeshBasicMaterial;
}

/** One jointed part: primitives gathered in the joint's own space, then merged into a mesh or three. */
class Part {
  readonly joint = new THREE.Group();
  /** What the part's meshes hang on: scaled for a body's proportions without scaling the joints below it. */
  readonly skin = new THREE.Group();
  private solid: THREE.BufferGeometry[] = [];
  private hull: THREE.BufferGeometry[] = [];
  private lit: THREE.BufferGeometry[] = [];

  constructor(parent: THREE.Object3D, x = 0, y = 0, z = 0) {
    this.joint.position.set(x, y, z);
    this.joint.add(this.skin);
    parent.add(this.joint);
  }

  /** `geometry` is centred on its own origin; `glow` draws it unlit, with no outline. */
  private add(geometry: THREE.BufferGeometry, color: string, x: number, y: number, z: number, rot?: Rot, glow = false, rounded = false, outlined = true): this {
    const at = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(...(rot ?? [0, 0, 0]))), ONE);
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    if (flat !== geometry) geometry.dispose();
    flat.deleteAttribute("uv");
    if (!outlined) {
      // Nothing round it: ink on the skin.
    } else if (!glow && rounded) {
      const shell = inflate(flat, edge);
      shell.applyMatrix4(at);
      this.hull.push(shell);
    } else if (!glow) {
      // The outline's shell: the same shape, a little larger all round.
      flat.computeBoundingBox();
      const size = flat.boundingBox!.getSize(new THREE.Vector3());
      const shell = flat.clone();
      shell.deleteAttribute("normal");
      shell.scale((size.x + 2 * edge) / size.x, (size.y + 2 * edge) / size.y, (size.z + 2 * edge) / size.z);
      shell.applyMatrix4(at);
      this.hull.push(shell);
    }
    const c = new THREE.Color(color);
    // No two pieces of cloth or plate are quite the same shade. (Not what glows, nor the ink of an eye.)
    if (!glow && color !== OUTLINE && color !== "#ffffff") c.offsetHSL((rand() - 0.5) * 0.02, (rand() - 0.5) * 0.08, (rand() - 0.5) * 0.06);
    const n = flat.getAttribute("position").count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3);
    flat.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    flat.applyMatrix4(at);
    (glow ? this.lit : this.solid).push(flat);
    return this;
  }

  /**
   * A box centred on (x, y, z). On a low-poly figure (gear, props, trim) its corners and edges are cut away
   * into facets, so it reads as a cut gem of a block rather than a cube; a sliver (a slit, a string) stays square.
   */
  box(color: string, w: number, h: number, d: number, x = 0, y = 0, z = 0, rot?: Rot): this {
    if (lowPoly && Math.min(w, h, d) >= 0.28) return this.add(bevelledBox(w, h, d), color, x, y, z, rot, false, true);
    return this.add(new THREE.BoxGeometry(w, h, d), color, x, y, z, rot);
  }

  /** An upright cylinder (or tapered post) centred on (x, y, z); rounder on a low-poly figure. */
  cyl(color: string, top: number, bottom: number, h: number, x = 0, y = 0, z = 0, sides = 6, rot?: Rot): this {
    return this.add(new THREE.CylinderGeometry(top, bottom, h, lowPoly ? Math.max(sides, 8) : sides), color, x, y, z, rot, false, lowPoly);
  }

  cone(color: string, radius: number, h: number, x = 0, y = 0, z = 0, sides = 4, rot?: Rot): this {
    return this.add(new THREE.ConeGeometry(radius, h, lowPoly ? Math.max(sides, 6) : sides), color, x, y, z, rot, false, lowPoly);
  }

  /** A faceted ball, optionally squashed along each axis. */
  ball(color: string, radius: number, x = 0, y = 0, z = 0, detail = 0, squash?: Rot): this {
    const g = new THREE.IcosahedronGeometry(radius, detail);
    if (squash) g.scale(...squash);
    return this.add(g, color, x, y, z);
  }

  /** A ring standing upright, facing +z. */
  ring(color: string, radius: number, tube: number, x = 0, y = 0, z = 0, rot?: Rot): this {
    return this.add(new THREE.TorusGeometry(radius, tube, 4, 10), color, x, y, z, rot);
  }

  /** A faceted tube through `rings` (see loftGeometry), in this joint's space offset by (x, y, z). */
  loft(color: string, rings: readonly Ring[], sides = 8, x = 0, y = 0, z = 0, rot?: Rot): this {
    return this.add(loftGeometry(rings, sides), color, x, y, z, rot, false, true);
  }

  /** The smallest solid that holds all of `pts`: a wedge, a blade, a shoe. */
  shape(color: string, pts: Pt[], x = 0, y = 0, z = 0, rot?: Rot): this {
    return this.add(new ConvexGeometry(pts.map(([px, py, pz]) => new THREE.Vector3(px, py, pz))), color, x, y, z, rot, false, true);
  }

  /** Triangles lying just over a surface (see inkOn), lit but with no outline: a tattoo's ink. */
  inkGeometry(color: string, positions: number[]): this {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    g.computeVertexNormals();
    return this.add(g, color, 0, 0, 0, undefined, false, false, false);
  }

  glowBox(color: string, w: number, h: number, d: number, x = 0, y = 0, z = 0, rot?: Rot): this {
    return this.add(new THREE.BoxGeometry(w, h, d), color, x, y, z, rot, true);
  }

  glowBall(color: string, radius: number, x = 0, y = 0, z = 0): this {
    return this.add(new THREE.IcosahedronGeometry(radius, 0), color, x, y, z, undefined, true);
  }

  get empty(): boolean {
    return this.solid.length === 0 && this.lit.length === 0;
  }

  /** Merge what was gathered into this joint's meshes. */
  build(mats: Mats, made: THREE.BufferGeometry[]) {
    const merged = (list: THREE.BufferGeometry[]) => {
      const g = mergeGeometries(list)!;
      for (const piece of list) piece.dispose();
      made.push(g);
      return g;
    };
    if (this.solid.length > 0) {
      const mesh = new THREE.Mesh(merged(this.solid), mats.body);
      // It takes no shadows (at this size, its own hat's shadow across its face is only noise) and throws
      // none itself: the figure's one still shape does that (see castShape).
      mesh.userData.body = true;
      this.skin.add(mesh, new THREE.Mesh(merged(this.hull), mats.outline));
    }
    if (this.lit.length > 0) {
      const mesh = new THREE.Mesh(merged(this.lit), mats.glow);
      mesh.userData.selfLit = true;
      this.skin.add(mesh);
    }
    this.solid = this.hull = this.lit = [];
  }
}

/** How thick the dark outline is, in model units, for the figure being built. */
let edge = 0.12;

/** What a rig is posed by each frame. */
interface Anim {
  /** Seconds on the render clock. */
  t: number;
  /** The walk cycle: -1 to 1 as the legs pass each other, 0 standing still. */
  swing: number;
  /** A slow -1 to 1, for breathing and hovering. */
  breath: number;
  /** 1 at the start of an attack, easing to 0. */
  strike: number;
  /** Down, or asleep. */
  lying: boolean;
  /** On a seat, 0 (standing) to 1: the hips stay where they are, the thighs go forward and the shins hang from the knee. */
  sitting: number;
}

interface Rig {
  parts: Part[];
  animate(a: Anim): void;
  /** Never touches the ground (a ghost, a bat) or is all one wet thing (a slime): no mud on it. */
  clean?: boolean;
}

// ---------- people ----------

/** The joints every two-legged figure shares, and how they move. */
function biped(top: THREE.Group, parts: Part[]) {
  const part = (parent: THREE.Object3D, x: number, y: number, z: number) => {
    const p = new Part(parent, x, y, z);
    parts.push(p);
    return p;
  };
  // The proportions chosen (all 1 for a stock figure): longer legs lift the hips, broader shoulders set the arms out.
  const hipY = 5 * m.legs;
  const torso = part(top, 0, hipY, 0);
  const head = part(torso.joint, 0, 6 + (lowPoly ? headLift() : 0), 0);
  const shoulderX = lowPoly ? 4.05 * m.shoulders + 0.45 : 4.5;
  const armR = part(torso.joint, -shoulderX, 5.5, 0);
  const armL = part(torso.joint, shoulderX, 5.5, 0);
  // A leg is a thigh from the hip and a shin from the knee. It is drawn as one limb in the hip's space (see
  // `limb`), and whatever crosses the knee is cut in two there, so it can bend.
  const thighR = part(top, -1.7 * m.girth * m.hips, hipY, 0);
  const thighL = part(top, 1.7 * m.girth * m.hips, hipY, 0);
  const shinR = part(thighR.joint, 0, KNEE * m.legs, 0);
  const shinL = part(thighL.joint, 0, KNEE * m.legs, 0);
  // The feet stand on the ground below the shins, kept their own size however long the legs are.
  // The knee is -KNEE above the ground, so the sole is that far below it.
  const footR = part(shinR.joint, 0, KNEE * m.legs, 0);
  const footL = part(shinL.joint, 0, KNEE * m.legs, 0);
  for (const leg of [thighR, thighL, shinR, shinL]) leg.skin.scale.set(m.girth, m.legs, m.girth);
  // Wide hips carry fuller thighs; the shins stay as they are.
  for (const thigh of [thighR, thighL]) thigh.skin.scale.x = m.girth * (0.5 + 0.5 * m.hips);
  const limbGirth = (1 + m.girth) / 2;
  for (const arm of [armR, armL]) arm.skin.scale.set(limbGirth, 1, limbGirth);
  const legR = limb(thighR, shinR);
  const legL = limb(thighL, shinL);
  // What each hand holds, kept upright while the arm hangs forward.
  const heldR = part(armR.joint, 0, -5, 0);
  const heldL = part(armL.joint, 0, -5, 0);
  /** How far forward each arm rests, and how what it holds is tipped. */
  const rest = { armR: -0.15, armL: -0.05, tiltR: 0, tiltL: 0 };
  // What the hands hold leans out from the body, far enough to clear the head (see heldLean).
  const lean = lowPoly ? heldLean(shoulderX) : 0;
  const animate = (a: Anim) => {
    heldR.joint.rotation.x = -rest.armR + rest.tiltR;
    heldL.joint.rotation.x = -rest.armL + rest.tiltL;
    heldR.joint.rotation.z = lean;
    heldL.joint.rotation.z = -lean;
    if (a.lying) {
      // On their back, the head toward -z, centred on where they stood.
      top.rotation.set(-HALF_PI, 0, 0);
      top.position.set(0, 2.4, 9);
      for (const leg of [thighL, thighR, shinL, shinR]) leg.joint.rotation.x = 0;
      armL.joint.rotation.set(rest.armL, 0, 0.12);
      armR.joint.rotation.set(rest.armR, 0, -0.12);
      head.joint.rotation.x = 0;
      return;
    }
    top.position.set(0, (a.breath + 1) * 0.07, 0);
    top.rotation.set(a.strike * 0.3, 0, 0);
    if (a.sitting > 0) {
      // Thighs out along the seat, a little apart, shins hanging; the free hand forward, as if on the table.
      // Part way there, on the way down onto the seat or up off it, everything is that share of the way.
      const k = a.sitting;
      // Hips down to where a seat is for anyone (longer legs reach further below it).
      top.position.y -= (hipY - 5) * k;
      thighL.joint.rotation.set(-SIT * k, 0, 0.12 * k);
      thighR.joint.rotation.set(-SIT * k, 0, -0.12 * k);
      shinL.joint.rotation.x = shinR.joint.rotation.x = (SIT - 0.1) * k;
      const reach = rest.armL + ((rest.armL < -0.3 ? rest.armL : -0.95) - rest.armL) * k;
      heldL.joint.rotation.x = -reach + rest.tiltL;
      armL.joint.rotation.set(reach + a.breath * 0.02, 0, 0.1 - 0.05 * k);
      armR.joint.rotation.set(rest.armR, 0, -0.1 - a.breath * 0.015);
      head.joint.rotation.x = a.breath * 0.02;
      return;
    }
    thighL.joint.rotation.set(a.swing * 0.8, 0, 0);
    thighR.joint.rotation.set(-a.swing * 0.8, 0, 0);
    // The knee of the leg swinging back bends a little.
    shinL.joint.rotation.x = Math.max(0, a.swing) * 0.6;
    shinR.joint.rotation.x = Math.max(0, -a.swing) * 0.6;
    armL.joint.rotation.set(rest.armL - a.swing * 0.6, 0, 0.1 + a.breath * 0.015);
    // The weapon arm swings less on the march, and comes up and over in an attack.
    armR.joint.rotation.set(rest.armR + a.swing * 0.3 - a.strike * 1.7, 0, -0.1 - a.breath * 0.015);
    head.joint.rotation.x = a.breath * 0.02 - a.strike * 0.15;
  };
  return { torso, head, armR, armL, legR, legL, thighR, thighL, shinR, shinL, footR, footL, heldR, heldL, rest, animate };
}

type Biped = ReturnType<typeof biped>;

/** Where the knee is, below the hip, and how far a thigh swings forward to sit. */
const KNEE = -2.5;
const SIT = HALF_PI - 0.08;

/** A leg to draw boxes on in the hip's space: each goes to the thigh or the shin, and one that crosses the knee is cut there. */
function limb(thigh: Part, shin: Part) {
  return {
    box(color: string, w: number, h: number, d: number, x = 0, y = 0, z = 0) {
      const high = y + h / 2;
      const low = y - h / 2;
      if (low >= KNEE) thigh.box(color, w, h, d, x, y, z);
      else if (high <= KNEE) shin.box(color, w, h, d, x, y - KNEE, z);
      else {
        thigh.box(color, w, high - KNEE, d, x, (high + KNEE) / 2, z);
        shin.box(color, w, KNEE - low, d, x, (KNEE + low) / 2 - KNEE, z);
      }
    },
  };
}

// ---------- low-poly people (see BLOCKY_KEY) ----------

/** The head's outline, ring by ring from the chin up, for each head shape: all about as wide at the top, so hats fit. */
const HEAD_RINGS: Record<string, Ring[]> = {
  round: [[0.45, 1.6, 1.5, 0.55], [1.5, 2.8, 2.6, 0.25], [3.2, 3.35, 3.05, 0], [4.9, 3.25, 3, -0.05], [6, 2.4, 2.25, -0.1], [6.45, 1, 1, -0.1]],
  long: [[-0.35, 1.45, 1.4, 0.6], [1.1, 2.7, 2.55, 0.3], [3.2, 3.3, 3.05, 0], [4.9, 3.25, 3, -0.05], [6, 2.4, 2.25, -0.1], [6.45, 1, 1, -0.1]],
  squat: [[1, 2, 1.85, 0.45], [1.8, 3.05, 2.75, 0.2], [3.25, 3.45, 3.1, 0], [4.9, 3.3, 3.02, -0.05], [5.85, 2.45, 2.3, -0.1], [6.3, 1.05, 1.05, -0.1]],
  pointed: [[0.05, 0.55, 0.6, 0.75], [1.3, 2.2, 2.2, 0.4], [3.2, 3.35, 3.05, 0], [4.9, 3.25, 3, -0.05], [6, 2.4, 2.25, -0.1], [6.45, 1, 1, -0.1]],
  square: [[0.35, 2.65, 2.15, 0.35], [1.45, 3.2, 2.75, 0.2], [3.2, 3.35, 3.05, 0], [4.9, 3.25, 3, -0.05], [6, 2.4, 2.25, -0.1], [6.45, 1, 1, -0.1]],
  pear: [[0.35, 2.55, 2.2, 0.4], [1.6, 3.6, 2.95, 0.15], [3.2, 3.45, 3.1, 0], [4.9, 2.95, 2.85, -0.05], [6, 2.15, 2.05, -0.1], [6.45, 0.9, 0.9, -0.1]],
};
/** Where the mouth sits for each head shape (a long face has it lower, a squat one higher). */
const MOUTH_Y: Record<string, number> = { long: 1.15, squat: 1.7 };

/**
 * How far (in radians) what a hand holds leans out from the body: a little for anyone, and more when the head,
 * with its ears and hair, is wider than the shoulders, so a staff held upright passes beside it, not through it.
 */
function heldLean(shoulderX: number): number {
  const rings = HEAD_RINGS[chosen?.headShape ?? "round"] ?? HEAD_RINGS.round;
  const k = BIG_HEAD * m.head;
  const half = (Math.max(...rings.map((r) => r[1])) + 0.5) * k;
  // From the hand (about half a unit above the hips) up to the widest of the head.
  const rise = 6 + headLift() + 3.2 * k - 0.5;
  const out = Math.max(0, half + 0.8 - shoulderX);
  return 0.06 + Math.atan2(out, rise);
}

/** How far a head of the chosen shape sits above the usual, on its neck, in the torso's units. */
function headLift(): number {
  return chosen?.headShape === "long" ? 0.45 : chosen?.headShape === "squat" ? -0.35 : 0;
}

/** A head's half-width, half-depth and forward offset at height `y`, from its rings. */
function ringAt(rings: readonly Ring[], y: number): { rx: number; rz: number; dz: number } {
  const at = (r: Ring) => ({ rx: r[1], rz: r[2], dz: r[3] ?? 0 });
  if (y <= rings[0][0]) return at(rings[0]);
  for (let i = 0; i + 1 < rings.length; i++) {
    const [y0] = rings[i];
    const [y1] = rings[i + 1];
    if (y <= y1) {
      const t = (y - y0) / (y1 - y0);
      const a = at(rings[i]);
      const b = at(rings[i + 1]);
      return { rx: a.rx + (b.rx - a.rx) * t, rz: a.rz + (b.rz - a.rz) * t, dz: a.dz + (b.dz - a.dz) * t };
    }
  }
  return at(rings[rings.length - 1]);
}

/** How far forward the face is at height `y`: the flat front face of the head's rings. */
const faceAt = (rings: readonly Ring[], y: number) => {
  const r = ringAt(rings, y);
  return r.rz * Math.cos(Math.PI / 8) + r.dz;
};

/**
 * A low-poly head, in the head's space before its scale: the chosen head shape, eyes, nose and facial hair
 * (or the usual round face, for a stock figure), ears and a cap of hair.
 */
function lowHead(head: Part, look: Look, asleep: boolean, covered = false) {
  const skin = look.skin;
  const shape = chosen?.headShape ?? "round";
  const rings = HEAD_RINGS[shape] ?? HEAD_RINGS.round;
  head.loft(skin, rings);
  const chinY = rings[0][0];
  const mouthY = MOUTH_Y[shape] ?? 1.45;
  const earX = ringAt(rings, 3).rx * 0.97;
  lowEars(head, tone(skin, -0.05), chosen?.ears ?? "round", earX, covered);
  lowNose(head, tone(skin, -0.05), chosen?.nose ?? "pointy", faceAt(rings, 2.3));
  head.box(tone(skin, -0.25), 1, 0.24, 0.3, 0, mouthY, faceAt(rings, mouthY) + 0.03);
  lowEyes(head, skin, look.hair, chosen?.eyes ?? "round", asleep, faceAt(rings, 3.05), faceAt(rings, 3.95));
  lowHair(head, look.hair, chosen?.hairStyle ?? "short", rings, covered);
  if (chosen?.ink) inkPart(head, "head", chosen.ink, skin);
  if (chosen) lowFacialHair(head, chosen.beard, chosen.mustache, skin, look.hair, rings, chinY, mouthY);
}

/**
 * Hair of each style, just outside a head of these rings: a cap down to the brow and a fall at the back,
 * longer or tied up or braided, or none. `covered` is a hat or helmet on top, which hides a bun.
 */
function lowHair(head: Part, hair: string, style: string, rings: readonly Ring[], covered: boolean) {
  if (style === "bald") return;
  const cap = (y: number, by: number) => ringAt(rings, y).rx + by;
  const capZ = (y: number, by: number) => ringAt(rings, y).rz + by;
  head.loft(hair, [[4.35, cap(4, 0.2), capZ(4, 0.21), -0.05], [5.3, cap(4.9, 0.22), capZ(4.9, 0.22), -0.1], [6.3, cap(6, 0.35), capZ(6, 0.35), -0.15], [6.95, 1.25, 1.25, -0.15]]);
  // The fall down the back: to the nape, or (long) on down between the shoulders, narrowing.
  const nape = ringAt(rings, 1.9);
  const levels: [y: number, rx: number, rz: number, from: number, to: number][] = [
    [4.9, cap(4.9, 0.3), capZ(4.9, 0.3), 95, 265],
    [1.9, nape.rx + 0.36, nape.rz + 0.36, 95, 265],
  ];
  if (style === "long") levels.push([-0.6, nape.rx + 0.15, nape.rz + 0.2, 110, 250], [-2.7, nape.rx - 0.45, nape.rz - 0.15, 125, 235]);
  const fall: Pt[] = [];
  for (const [y, rx, rz, from, to] of levels) {
    for (let i = 0; i <= 6; i++) {
      const a = ((from + ((to - from) * i) / 6) / 180) * Math.PI;
      fall.push([Math.sin(a) * rx, y, Math.cos(a) * rz - 0.15]);
    }
  }
  head.shape(hair, fall);
  const back = -capZ(4.5, 0.3);
  const tie = tone(hair, -0.18);
  if (style === "ponytail") {
    // Tied high at the back and hanging a little away from the neck, in two pieces that swing (see swingBraids).
    head.loft(tie, [[4.2, 0.62, 0.62], [4.75, 0.62, 0.62]], 6, 0, 0, back - 0.25);
    const root = new Part(head.joint, 0, 4.45, back - 0.35);
    root.loft(hair, [[0.15, 0.55, 0.55, 0], [-1.1, 0.78, 0.74, -0.35], [-1.9, 0.8, 0.75, -0.5], [-2.45, 0.72, 0.7, -0.58]]);
    const end = new Part(root.joint, 0, -2.1, -0.55);
    end.loft(hair, [[0.25, 0.74, 0.72, 0], [-1.2, 0.62, 0.6, -0.12], [-2.5, 0.42, 0.4, 0.02], [-3.4, 0.2, 0.2, 0.15]]);
    hang(root, end, 0);
  } else if (style === "bun" && !covered) {
    head.ball(hair, 1.45, 0, 5.9, back + 0.1, 1);
    // The band round its foot, where it meets the head.
    head.ball(tie, 1, 0, 5.05, back + 0.35, 0, [1.05, 0.45, 0.8]);
  } else if (style === "braids" || style === "frontBraids") {
    // Two braids from behind the ears, banded at the ends: down the back (braids), or forward over the
    // shoulders and down the chest (front braids). Each hangs in two pieces, jointed at the root and over
    // the shoulder, so it can swing (see swingBraids). They are laid out in the torso's units, not the
    // head's, so they clear the jaw, the shoulder and the arm whatever the head size, the shoulders and the
    // build: from behind the ear (outside the widest of the jaw), to a point above the shoulder and clear of
    // the top of the arm, then down the chest or the back, inside the arm.
    const front = style === "frontBraids";
    const k = BIG_HEAD * m.head;
    const neckY = 6 + headLift();
    let jaw = ringAt(rings, 3).rx - 0.15;
    for (let y = 0.6; y <= 2.6; y += 0.4) jaw = Math.max(jaw, ringAt(rings, y).rx + 0.05);
    const shoulderX = 4.05 * m.shoulders + 0.45;
    const armIn = shoulderX - 1.32 * ((1 + m.girth) / 2);
    for (const s of [-1, 1]) {
      const from = new THREE.Vector3(s * jaw * k, neckY + 2.6 * k, -1.1 * k);
      const inside = Math.min(3.2, Math.max(2.1, armIn - 0.75));
      const over = front
        ? new THREE.Vector3(s * Math.min(from.x * s - 0.2, shoulderX), 7.1, 1.6 * m.girth + 0.75)
        : new THREE.Vector3(s * Math.min(from.x * s - 0.3, inside + 0.3), 6.9, -(1.6 * m.girth + 0.8));
      const down = front
        ? new THREE.Vector3(s * inside, 7.1 - 3.9, 2.25 * m.girth + 0.65)
        : new THREE.Vector3(s * inside, 6.9 - 3.9, -(2.05 * m.girth + 0.65));
      const root = new Part(head.joint, from.x / k, (from.y - neckY) / k, from.z / k);
      root.joint.scale.setScalar(1 / k);
      const upper = over.clone().sub(from);
      aimDown(root.skin, upper);
      root.loft(hair, plait(0.35, -upper.length() - 0.3, 0, 0, 0.6));
      const end = new Part(root.joint, upper.x, upper.y, upper.z);
      const lower = down.clone().sub(over);
      const len = lower.length();
      aimDown(end.skin, lower);
      end.loft(hair, plait(0.3, -len, 0, 0, 0.55, 0.42));
      end.loft(tie, [[-len + 0.35, 0.52, 0.52], [-len + 0.7, 0.52, 0.52]]);
      hang(root, end, s, front ? 1 : -1);
    }
  }
}

/**
 * A long wizard's beard from the chin down the chest, laid out like the braids in the torso's units so it
 * clears the chest however stout the hero: forward from the chin, then down, in two pieces that swing
 * (see swingBraids), wide and flat, tapering to a point.
 */
function lowWizardBeard(head: Part, c: string, rings: readonly Ring[], chinY: number) {
  const k = BIG_HEAD * m.head;
  const neckY = 6 + headLift();
  const g = m.girth;
  const chinZ = faceAt(rings, chinY + 0.3) - 0.35;
  const from = new THREE.Vector3(0, neckY + (chinY + 0.3) * k, chinZ * k);
  const mid = new THREE.Vector3(0, Math.min(from.y - 2.6, 4.6), 2.15 * g + 1.25);
  const tip = new THREE.Vector3(0, mid.y - 3.4, 2.25 * g + 1.1);
  const root = new Part(head.joint, 0, (from.y - neckY) / k, from.z / k);
  root.joint.scale.setScalar(1 / k);
  const upper = mid.clone().sub(from);
  aimDown(root.skin, upper);
  const a = upper.length();
  root.loft(c, [[0.4, 2.1, 0.95], [-a * 0.35, 2.35, 1.0], [-a * 0.7, 2.2, 0.95], [-a - 0.3, 1.9, 0.85]], 8);
  const end = new Part(root.joint, upper.x, upper.y, upper.z);
  const lower = tip.clone().sub(mid);
  aimDown(end.skin, lower);
  const b = lower.length();
  end.loft(c, [[0.3, 1.9, 0.85], [-b * 0.35, 1.6, 0.75], [-b * 0.7, 0.95, 0.55], [-b, 0.15, 0.15, 0.25]], 8);
  hang(root, end, 0, 1);
}

/**
 * Hang a length of hair in two jointed pieces, to swing as the figure moves. `side` staggers its idle stir;
 * `drape` is a braid lying over a shoulder and down the chest, which can lift off them but not swing into them.
 */
function hang(root: Part, end: Part, side: number, drape: Drape = 0) {
  extraParts.push(root, end);
  braids.push({ root, end, side, drape, x: 0, vx: 0, z: 0, vz: 0, ex: 0, evx: 0, ez: 0, evz: 0, last: -1 });
}

/** Turn a part's meshes, drawn hanging straight down, to hang along `dir` instead. */
function aimDown(skin: THREE.Group, dir: THREE.Vector3) {
  skin.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.clone().normalize());
}

/** The rings of a plaited length of hair from `y0` down to `y1`, leaning forward from `dz0` to `dz1`: fat and thin by turns. */
function plait(y0: number, y1: number, dz0: number, dz1: number, r: number, rEnd = r): Ring[] {
  const out: Ring[] = [];
  const n = 8;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const rr = (r + (rEnd - r) * t) * (i % 2 ? 0.8 : 1);
    out.push([y0 + (y1 - y0) * t, rr, rr, dz0 + (dz1 - dz0) * t]);
  }
  return out;
}

/** Where hair hangs against the body: 0 free (a ponytail), 1 down the chest, -1 down the back. */
type Drape = 0 | 1 | -1;

/** A braid's (or a ponytail's) two joints, and the springs that swing them: the root's angles and speeds, then the end's. */
interface Braid {
  root: Part;
  end: Part;
  side: number;
  drape: Drape;
  x: number;
  vx: number;
  z: number;
  vz: number;
  ex: number;
  evx: number;
  ez: number;
  evz: number;
  last: number;
}
/** Set by makeFigure for the figure being built: parts hung on others outside the rig (braids), and the braids to swing. */
let extraParts: Part[] = [];
let braids: Braid[] = [];

/**
 * Swing the braids and ponytails: each joint is a damped spring. The root is pulled back on the march, side to side with
 * the stride and back in a strike, with a little idle stir; the end is flung by how fast the root moves, so
 * it lags and whips after it.
 */
function swingBraids(list: Braid[], a: Anim) {
  for (const b of list) {
    const dt = b.last < 0 ? 0 : Math.min(0.05, Math.max(0, a.t - b.last));
    b.last = a.t;
    const still = a.lying || a.sitting > 0.5;
    const s = b.side;
    // A ponytail swings back on the march; a braid over the shoulder is bounced up off it on each step.
    // Draped on the body, it is bounced off it on each step (forward off the chest, back off the back).
    const tx = still ? 0 : b.drape ? -b.drape * (0.1 * Math.abs(a.swing) + 0.35 * a.strike + 0.02 * (1 + Math.sin(a.t * 1.7 + s))) : 0.22 * Math.abs(a.swing) + 0.45 * a.strike + 0.035 * Math.sin(a.t * 1.7 + s);
    const tz = still ? 0 : b.drape ? 0.15 * a.swing - s * 0.05 : 0.2 * a.swing + 0.03 * Math.sin(a.t * 1.3 + s * 2);
    const spring = (at: number, v: number, goal: number, k: number, damp: number) => {
      const nv = v + (-(at - goal) * k - v * damp) * dt;
      return [at + nv * dt, nv] as const;
    };
    [b.x, b.vx] = spring(b.x, b.vx, tx, 70, 6);
    [b.z, b.vz] = spring(b.z, b.vz, tz, 70, 6);
    [b.ex, b.evx] = spring(b.ex, b.evx, -b.vx * 0.09, 95, 5);
    [b.ez, b.evz] = spring(b.ez, b.evz, -b.vz * 0.09, 95, 5);
    if (b.drape) {
      // The body stops it: tipping toward it (forward for a braid down the back, back for one down the
      // chest) would push it into the body, and outward (toward the side it hangs on) into the arm. It stops
      // dead there, and swings back out.
      const d = b.drape;
      if (d * b.x > 0) [b.x, b.vx] = [0, d * b.vx > 0 ? 0 : b.vx];
      if (s * b.z > 0) [b.z, b.vz] = [0, s * b.vz > 0 ? 0 : b.vz];
      if (d * b.ex > 0) [b.ex, b.evx] = [0, d * b.evx > 0 ? 0 : b.evx];
      if (s * b.ez > 0.04) [b.ez, b.evz] = [s * 0.04, s * b.evz > 0 ? 0 : b.evz];
    }
    b.root.joint.rotation.set(b.x, 0, b.z);
    b.end.joint.rotation.set(b.ex, 0, b.ez);
  }
}

/**
 * Ears of each kind at the sides of the head, `x` out from its middle. Pointed ones reach up through the hair;
 * under a hat or helm (`covered`) they are cut shorter.
 */
function lowEars(head: Part, c: string, kind: string, x: number, covered: boolean) {
  for (const s of [-1, 1]) {
    switch (kind) {
      case "wide":
        // Standing out from the head, fanned back.
        head.shape(c, [[s * x, 3.75, 0.15], [s * x, 2.25, 0.15], [s * x, 3.65, -0.65], [s * x, 2.35, -0.6], [s * (x + 1.05), 3.95, -0.55], [s * (x + 1.15), 2.55, -0.65], [s * (x + 0.95), 3.35, -0.95]]);
        break;
      case "thin":
        head.ball(c, 0.8, s * x, 3, -0.15, 0, [0.3, 0.95, 0.45]);
        break;
      case "tall":
        head.ball(c, 0.8, s * x, 3.2, -0.15, 0, [0.42, 1.45, 0.7]);
        break;
      case "pointy": {
        // Long and swept up and back to a point.
        const tip = covered ? 4.2 : 5.1;
        head.shape(c, [[s * x, 3.7, 0.1], [s * x, 2.3, 0.1], [s * x, 2.4, -0.6], [s * x, 3.6, -0.75], [s * (x + 0.45), 3.2, -0.3], [s * (x + 0.6), tip, -1.45], [s * (x + 0.35), tip - 0.45, -1.3]]);
        break;
      }
      default:
        head.ball(c, 0.8, s * x, 3, -0.15, 0, [0.45, 0.95, 0.85]);
    }
  }
}

/** The eyes (and brows over them) of each kind, on a face whose front is at `z` (eyes) and `browZ` (brows). */
function lowEyes(head: Part, skin: string, hair: string, kind: string, asleep: boolean, z: number, browZ: number) {
  const y = 3.05;
  for (const s of [-1, 1]) {
    const x = s * (kind === "beady" ? 1.05 : 1.15);
    if (asleep) head.box(OUTLINE, 1, 0.24, 0.3, x, y, z + 0.05);
    else if (kind === "big") {
      head.ball(OUTLINE, 1, x, y + 0.05, z - 0.1, 1, [0.55, 0.8, 0.32]);
      head.ball("#ffffff", 0.22, x + 0.18, y + 0.35, z + 0.18);
      head.ball("#ffffff", 0.1, x - 0.15, y - 0.25, z + 0.2);
    } else if (kind === "beady") {
      head.ball(OUTLINE, 0.3, x, y, z - 0.02, 1);
    } else if (kind === "narrow") {
      head.ball(OUTLINE, 1, x, y, z - 0.08, 1, [0.5, 0.26, 0.28]);
    } else {
      head.ball(OUTLINE, 1, x, y, z - 0.1, 1, [0.42, 0.62, 0.3]);
      head.ball("#ffffff", 0.17, x + 0.15, y + 0.25, z + 0.18);
      // Heavy lids, halfway down.
      if (kind === "sleepy") head.ball(tone(skin, -0.04), 1, x, y + 0.3, z - 0.04, 1, [0.52, 0.36, 0.36]);
    }
    const fierce = kind === "fierce";
    head.box(hair, 1.15, fierce ? 0.38 : 0.32, 0.35, s * 1.2, y + (kind === "big" ? 1.02 : fierce ? 0.7 : 0.9), browZ + 0.04, [0, 0, s * (fierce ? 0.38 : -0.12)]);
  }
}

/** A nose of each kind, its bridge between the eyes, on a face whose front is at `z`. */
function lowNose(head: Part, c: string, kind: string, z: number) {
  switch (kind) {
    case "button":
      head.ball(c, 0.5, 0, 2.2, z + 0.15, 0, [1.1, 0.85, 0.9]);
      return;
    case "broad":
      head.shape(c, sym([[0.75, 1.9, z - 0.2], [0.5, 2.6, z - 0.15], [0.3, 3, z - 0.1], [0.62, 1.95, z + 0.35], [0, 1.95, z + 0.5], [0, 2.6, z + 0.3]]));
      return;
    case "long":
      head.shape(c, sym([[0.38, 1.7, z - 0.2], [0, 3.1, z - 0.05], [0, 1.72, z + 0.95], [0.25, 1.78, z + 0.5]]));
      return;
    case "hooked":
      head.shape(c, sym([[0.4, 1.85, z - 0.2], [0, 3, z - 0.05], [0, 2.5, z + 0.6], [0, 1.85, z + 0.78], [0.22, 2.1, z + 0.55]]));
      return;
    default:
      head.shape(c, sym([[0.42, 1.95, z - 0.2], [0, 2.95, z - 0.05], [0, 2.05, z + 0.65]]));
  }
}

/** Facial hair of each kind, around a head of these rings. */
/** How far forward the face is at height `y`, `x` across it: on its rings' front, flat face or not. */
function faceZ(rings: readonly Ring[], x: number, y: number): number {
  const pts = section(rings, 8, y);
  let best = -Infinity;
  for (let k = 0; k < pts.length; k++) {
    const [ax, az] = pts[k];
    const [bx, bz] = pts[(k + 1) % pts.length];
    if (ax === bx || x < Math.min(ax, bx) || x > Math.max(ax, bx)) continue;
    best = Math.max(best, az + ((x - ax) / (bx - ax)) * (bz - az));
  }
  return Number.isFinite(best) ? best : faceAt(rings, y);
}

function lowFacialHair(head: Part, beard: string, mustache: string, skin: string, hair: string, rings: readonly Ring[], chinY: number, mouthY: number) {
  const c = tone(hair, -0.04);
  const out = (y: number, by: number): Ring => {
    const r = ringAt(rings, y);
    return [y, r.rx + by, r.rz + by, r.dz];
  };
  switch (beard) {
    case "stubble": {
      const shade = `#${new THREE.Color(skin).lerp(new THREE.Color(hair), 0.45).getHexString()}`;
      head.loft(shade, [out(chinY - 0.02, 0.05), out(chinY + 0.4, 0.06), out(mouthY - 0.22, 0.06)]);
      break;
    }
    case "goatee": {
      const cz = faceAt(rings, chinY + 0.4);
      head.shape(c, sym([[0.55, mouthY - 0.25, cz - 0.05], [0.45, chinY - 0.45, cz - 0.2], [0, chinY - 0.75, cz - 0.05], [0.35, mouthY - 0.2, cz + 0.25], [0, mouthY - 0.15, cz + 0.3]]));
      break;
    }
    case "full": {
      const chin = ringAt(rings, chinY);
      head.loft(c, [[chinY - 0.9, chin.rx * 0.5, chin.rz * 0.45, chin.dz + 0.4], out(chinY + 0.1, 0.28), out(1.6, 0.2), out(2.5, 0.12)]);
      break;
    }
    case "wizard": {
      // A full beard on the jaw, and from the chin a long one down the chest in two pieces that swing.
      const chin = ringAt(rings, chinY);
      head.loft(c, [[chinY - 0.4, chin.rx * 0.75, chin.rz * 0.6, chin.dz + 0.45], out(chinY + 0.1, 0.28), out(1.6, 0.2), out(2.5, 0.12)]);
      lowWizardBeard(head, c, rings, chinY);
      break;
    }
    case "chops":
      for (const s of [-1, 1]) {
        const pts: Pt[] = [];
        for (const y of [1.2, 2.2, 3.2]) {
          const r = ringAt(rings, y);
          for (const deg of [42, 72, 102]) {
            const a = (deg / 180) * Math.PI;
            pts.push([s * Math.sin(a) * (r.rx + 0.16), y, Math.cos(a) * (r.rz + 0.16) + r.dz]);
          }
        }
        head.shape(c, pts);
      }
      break;
  }
  // The mustache, over a full beard where there is one.
  const mz = faceAt(rings, mouthY) + (beard === "full" || beard === "wizard" ? 0.22 : 0);
  const y = mouthY;
  switch (mustache) {
    case "bushy":
      // Wide past the corners of the mouth, up to the nose, its ends drooping.
      head.shape(c, sym([[1.55, y - 0.05, mz - 0.12], [1.3, y + 0.55, mz + 0.02], [0.4, y + 0.82, mz + 0.3], [0, y + 0.78, mz + 0.4], [0.5, y + 0.02, mz + 0.45], [0, y + 0.12, mz + 0.45], [1.75, y - 0.6, mz - 0.25], [1.15, y - 0.32, mz + 0.18]]));
      return;
    case "pencil":
      // A thin line along the lip.
      head.shape(c, sym([[1.1, y + 0.28, mz - 0.02], [1.1, y + 0.42, mz - 0.02], [0.5, y + 0.36, mz + 0.2], [0.5, y + 0.5, mz + 0.2], [0, y + 0.38, mz + 0.26], [0, y + 0.52, mz + 0.26]]));
      return;
    case "handlebar": {
      // A thick bar under the nose, swept out past the mouth and curled up at the ends, lying on the face
      // all the way: a run of short pieces, each between two points along it, thinning toward the tips.
      const lift = beard === "full" || beard === "wizard" ? 0.22 : 0;
      const along: [number, number, number][] = [[0, 0.5, 0.3], [0.55, 0.44, 0.3], [1.05, 0.34, 0.27], [1.5, 0.42, 0.22], [1.8, 0.72, 0.18], [1.88, 1.05, 0.14], [1.68, 1.25, 0.1]];
      for (const s of [-1, 1]) {
        for (let i = 0; i + 1 < along.length; i++) {
          const pts: Pt[] = [];
          for (const [x, dy, th] of [along[i], along[i + 1]]) {
            const z = faceZ(rings, x, y + dy) + lift;
            for (const t of [-th, th]) pts.push([s * x, y + dy + t, z - 0.05], [s * x, y + dy + t, z + 0.12 + th]);
          }
          head.shape(c, pts);
        }
      }
      return;
    }
    case "walrus":
      // Heavy, hanging down over the mouth.
      head.shape(c, sym([[1.4, y - 0.6, mz - 0.12], [1.3, y + 0.62, mz], [0.4, y + 0.88, mz + 0.35], [0, y + 0.84, mz + 0.45], [0, y - 0.55, mz + 0.52], [0.75, y - 0.68, mz + 0.38]]));
      return;
  }
}

/** Rings just over the hair, from the brow to the crown: what a close helm or cap is built on. */
const OVER_HAIR: Ring[] = [[3.95, 3.72, 3.42], [5.4, 3.66, 3.38, -0.05], [6.7, 2.95, 2.75, -0.1], [7.5, 1.65, 1.55, -0.1], [7.8, 0.35, 0.35, -0.1]];

/** Rings made `by` larger all round. */
const grown = (rings: readonly Ring[], by: number): Ring[] => rings.map(([y, rx, rz, dz = 0]) => [y, rx + by, rz + by, dz]);

/**
 * The middle of one face of a loft (`sides` sides, see loftGeometry) at height `y`: the `k`th round from the
 * front (negative toward -x), and the turn about y that faces something along it. For laying plates, slits
 * and studs flat on a rounded helm.
 */
function facet(rings: readonly Ring[], sides: number, y: number, k: number, out = 0.12): { x: number; z: number; turn: number } {
  const pts = section(rings, sides, y);
  const j = (((k - 1) % sides) + sides) % sides;
  const [ax, az] = pts[j];
  const [bx, bz] = pts[(j + 1) % sides];
  const turn = (k * 2 * Math.PI) / sides;
  return { x: (ax + bx) / 2 + Math.sin(turn) * out, z: (az + bz) / 2 + Math.cos(turn) * out, turn };
}

/** A steel dome with a brow band, cheek guards and a crest: the paladin's helm, or (with a nasal) a diving helm. */
function lowHelm(head: Part, c: string, band: string, crest: string, nasal = false) {
  head.loft(c, OVER_HAIR, 10);
  head.loft(band, [[3.85, 3.84, 3.54], [4.45, 3.82, 3.52, -0.02]], 10);
  for (const s of [-1, 1]) head.shape(c, [[s * 3.5, 4.2, 1.6], [s * 3.5, 4.2, -1], [s * 3.2, 1.7, 1.2], [s * 3.2, 2, -0.6], [s * 3.95, 4.2, 1.4], [s * 3.95, 4.2, -0.8], [s * 3.7, 1.9, 0.9]]);
  head.shape(crest, sym([[0.42, 7.2, 2.2], [0.42, 8.7, 1.2], [0.42, 9.1, -0.6], [0.42, 8.3, -2.7], [0.42, 7, -2.6]]));
  if (nasal) {
    const f = facet(OVER_HAIR, 10, 3.9, 0, 0.25);
    head.shape(c, sym([[0.38, 3.95, f.z], [0.3, 2.35, f.z + 0.45], [0, 2.2, f.z + 0.6], [0, 3.95, f.z + 0.2]]));
  }
}

/**
 * A hood: rounded over the crown to a soft point at the back, falling round the back and sides of the head
 * to the shoulders, open at the face. `trim` edges the face.
 */
function lowHood(head: Part, c: string, rings: readonly Ring[], trim?: string) {
  head.loft(c, [[4.1, 3.92, 3.62], [5.5, 3.86, 3.56, -0.15], [6.8, 3.1, 2.95, -0.45], [7.6, 1.7, 1.65, -0.95], [8.05, 0.3, 0.3, -1.5]], 10);
  const fall: Pt[] = [];
  const levels: [number, number, number][] = [
    [5.4, 3.95, 3.6],
    [3.6, ringAt(rings, 3.6).rx + 0.6, ringAt(rings, 3.6).rz + 0.55],
    [1.6, ringAt(rings, 1.6).rx + 0.75, ringAt(rings, 1.6).rz + 0.6],
    [-0.3, 3.9, 3.3],
  ];
  for (const [y, rx, rz] of levels) {
    for (let deg = 52; deg <= 308; deg += 16) {
      const a = (deg / 180) * Math.PI;
      fall.push([Math.sin(a) * rx, y, Math.cos(a) * rz - 0.1]);
    }
  }
  head.shape(c, fall);
  if (trim) {
    const f = facet(OVER_HAIR, 10, 4.3, 0, 0.3);
    head.box(trim, 2.4, 0.55, 0.35, f.x, 4.3, f.z);
  }
}

/** The headgear a class, townsperson or enemy has by default, rounded to go with low-poly heads. */
function lowHat(head: Part, look: Look) {
  const rings = HEAD_RINGS[chosen?.headShape ?? "round"] ?? HEAD_RINGS.round;
  switch (look.hat) {
    case "helm":
      lowHelm(head, "#aeb6c2", tone("#aeb6c2", 0.07), look.accent);
      return;
    case "wizard": {
      // A wide brim just over the brows, a band, and a tall crown that bends back to its tip.
      head.loft(look.accent, [[4.3, 5.3, 5.05, -0.05], [4.68, 5.3, 5.05, -0.05]], 14);
      head.loft(look.body, [[4.5, 3.82, 3.52, -0.05], [6.2, 3.22, 2.97, -0.15], [7.8, 2.25, 2.05, -0.4], [9.3, 1.3, 1.2, -0.85], [10.5, 0.55, 0.55, -1.5], [11.1, 0.1, 0.1, -1.95]], 10);
      head.loft(tone(look.body, -0.08), [[4.65, 3.86, 3.56, -0.05], [5.3, 3.72, 3.44, -0.08]], 10);
      const f = facet(OVER_HAIR, 10, 5, 0, 0.3);
      head.shape(look.accent, sym([[0, 5.55, f.z], [0.5, 5, f.z], [0, 4.45, f.z], [0, 5, f.z + 0.25]]));
      return;
    }
    case "hood":
      lowHood(head, look.hatColor ?? look.body, rings);
      return;
    case "leaves": {
      // A wreath: a band of twigs, leaves round it, and a berry.
      head.loft(tone(look.accent, -0.3), [[4.4, 3.8, 3.5], [4.85, 3.8, 3.5]], 10);
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        head.ball(i % 2 ? look.accent : tone(look.accent, -0.1), 0.95, Math.sin(a) * 3.85, 4.85 + (i % 2) * 0.3, Math.cos(a) * 3.55, 0, [1.25, 0.5, 1.25]);
      }
      head.ball("#c8433d", 0.55, 1.5, 5.35, 3.3, 1);
      return;
    }
    case "feather": {
      // A soft cap pushed back, a band, and a long feather sweeping up behind.
      const c = look.body;
      head.loft(c, [[4.2, 3.84, 3.54], [5.2, 3.9, 3.6, -0.15], [6.3, 3.35, 3.1, -0.4], [7, 2.15, 2.05, -0.65], [7.35, 0.6, 0.6, -0.8]], 10);
      head.loft(tone(c, -0.08), [[4.12, 3.9, 3.6], [4.6, 3.92, 3.62]], 10);
      head.shape(look.accent, [[-2.3, 5.6, -1.6], [-2.75, 5.6, -1.8], [-3.2, 8.4, -2.9], [-3.55, 9.6, -3.6], [-3.8, 10.6, -4.5], [-3.0, 8.6, -2.5], [-2.9, 7.4, -2.1]]);
      return;
    }
    case "circlet": {
      head.loft(look.accent, [[4.3, 3.66, 3.36], [4.75, 3.66, 3.36]], 10);
      const f = facet([[4.3, 3.66, 3.36], [4.75, 3.66, 3.36]], 10, 4.5, 0, 0.2);
      head.glowBall("#7fe3ff", 0.55, 0, 4.6, f.z);
      return;
    }
    case "brim": {
      // A round crown on a wide brim, the hair showing under it.
      const c = look.hatColor ?? look.body;
      head.loft(c, [[4.9, 5.5, 5.3, -0.05], [5.25, 5.5, 5.3, -0.05]], 14);
      head.loft(c, [[5, 3.62, 3.35, -0.05], [6.6, 3.35, 3.1, -0.1], [7.9, 3.05, 2.82, -0.12], [8.3, 2.4, 2.25, -0.12], [8.45, 0.5, 0.5, -0.12]], 10);
      head.loft(look.accent, [[5.25, 3.7, 3.42, -0.05], [5.9, 3.62, 3.36, -0.07]], 10);
      return;
    }
    case "turban": {
      const c = look.hatColor ?? look.accent;
      head.loft(c, [[4, 3.8, 3.5], [5, 4.18, 3.88, -0.1], [6.4, 3.92, 3.62, -0.15], [7.4, 2.8, 2.6, -0.15], [7.95, 1, 1, -0.1]], 10);
      head.loft(tone(c, -0.08), [[5.6, 4.15, 3.85, -0.12], [6.05, 4.05, 3.75, -0.14]], 10);
      head.ball(c, 1.15, 0.6, 7.95, -0.3, 1);
      const f = facet([[5, 4.18, 3.88, -0.1], [6.4, 3.92, 3.62, -0.15]], 10, 5.5, 0, 0.2);
      head.ball(look.accent, 0.55, 0, 5.5, f.z, 0);
      return;
    }
    case "kerchief": {
      // Tied close over the hair, knotted at the back with two tails.
      const c = look.hatColor ?? look.accent;
      head.loft(c, grown(OVER_HAIR, -0.05), 10);
      head.ball(tone(c, -0.08), 0.7, 0, 4.9, -3.55, 1);
      head.shape(c, [[0.15, 4.9, -3.5], [0.65, 4.9, -3.65], [1.45, 2.9, -3.75], [1.95, 3.05, -3.75], [1.7, 2.6, -3.85]]);
      head.shape(tone(c, -0.08), [[-0.15, 4.9, -3.5], [-0.6, 4.9, -3.65], [-0.95, 3.3, -3.75], [-1.4, 3.4, -3.75]]);
      return;
    }
    case "greathelm": {
      // A great helm over the whole head, its front pushed out over the nose, a slit for the eyes, breaths
      // below, and a crest.
      const c = look.hatColor ?? "#8b95a5";
      const helm: Ring[] = [[0.1, 3.1, 2.95, 0.55], [1.4, 3.88, 3.55, 0.6], [3.2, 3.98, 3.62, 0.45], [5.4, 3.8, 3.5, -0.05], [6.7, 3.05, 2.85, -0.1], [7.5, 1.75, 1.6, -0.1], [7.85, 0.4, 0.4, -0.1]];
      head.loft(c, helm, 10);
      head.loft(tone(c, -0.1), [[0, 3.2, 3.05, 0.55], [0.5, 3.45, 3.25, 0.58]], 10);
      for (const k of [-1, 0, 1]) {
        const f = facet(helm, 10, 3.3, k, 0.02);
        head.box(OUTLINE, 2.1, 0.5, 0.3, f.x, 3.3, f.z, [0, f.turn, 0]);
      }
      const f = facet(helm, 10, 2, 0, 0.02);
      for (const x of [-0.5, 0, 0.5]) head.box(OUTLINE, 0.22, 1.1, 0.3, x, 2, f.z);
      head.shape(look.accent, sym([[0.42, 7.3, 2.1], [0.42, 8.8, 0.9], [0.42, 9.1, -0.8], [0.42, 8.2, -2.8], [0.42, 7.1, -2.6]]));
      return;
    }
    case "horns": {
      head.loft(look.accent, [[4.3, 3.74, 3.44], [4.8, 3.74, 3.44]], 10);
      for (const s of [-1, 1]) {
        // Each horn curls out and up from the band.
        head.loft(look.accent, [[0, 0.85, 0.85], [1.2, 0.7, 0.7, 0.25], [2.3, 0.45, 0.45, 0.8], [3.1, 0.12, 0.12, 1.5]], 6, s * 3.2, 5.2, 0, [0, 0, -s * 0.7]);
      }
      return;
    }
  }
}

/** Armor on the head, rounded: a leather hood, the horned visor, or a diving helm (anything else). */
function lowWornHelmet(head: Part, helmet: { ref: string; icon: string }, trim: string) {
  const rings = HEAD_RINGS[chosen?.headShape ?? "round"] ?? HEAD_RINGS.round;
  if (helmet.ref === "hood" || helmet.icon === "hood") {
    lowHood(head, GEAR.leather, rings, trim);
    return;
  }
  if (helmet.ref === "visor" || helmet.icon === "brutal-helm") {
    // Horned iron down over the eyes, a dark visor, one eye alight and a spyglass over the other.
    const helm: Ring[] = [[2.2, 3.82, 3.55, 0.12], [3.95, 3.86, 3.56], [5.4, 3.74, 3.46, -0.05], [6.7, 3.02, 2.82, -0.1], [7.5, 1.7, 1.6, -0.1], [7.8, 0.35, 0.35, -0.1]];
    head.loft(GEAR.iron, helm, 10);
    for (const k of [-1, 0, 1]) {
      const f = facet(helm, 10, 3, k, 0.02);
      head.box(GEAR.dark, 2.2, 1.3, 0.3, f.x, 3, f.z, [0, f.turn, 0]);
    }
    const front = facet(helm, 10, 3, 0, 0.1);
    head.glowBall(trim, 0.38, 0.75, 3, front.z);
    head.cyl(GEAR.gold, 0.7, 0.55, 1.8, -0.8, 3, front.z + 0.8, 8, [HALF_PI, 0, 0]);
    head.glowBall(trim, 0.42, -0.8, 3, front.z + 1.75);
    for (const s of [-1, 1]) {
      head.shape(GEAR.iron, [[s * 3.35, 2.4, 1.3], [s * 3.4, 2.4, -1.2], [s * 2.95, 0.9, 0.8], [s * 3.05, 1, -0.6], [s * 3.8, 2.4, 1], [s * 3.75, 2.2, -0.9]]);
      head.loft(GEAR.bone, [[0, 0.85, 0.85], [1.2, 0.7, 0.7, 0.25], [2.3, 0.45, 0.45, 0.75], [3.1, 0.1, 0.1, 1.4]], 6, s * 3.3, 5.9, 0, [0, 0, -s * 0.55]);
    }
    return;
  }
  // A diving helm: a steel dome with a gold band, cheek plates, a nasal and a crest of its trim.
  lowHelm(head, GEAR.steel, GEAR.gold, trim, true);
}

/**
 * A chest over a narrow waist with the neck above it: the torso's own girth is its part's scale, and `sh` is
 * how much broader (or narrower) than that the shoulders are. `belt` is drawn at the waist if given.
 */
function lowChest(torso: Part, skin: string, cloth: string, sh: number, belt?: string): Ring[] {
  const hip = m.hips;
  const rings: Ring[] = [[-0.6, 2.85 * hip, 1.95 + (hip - 1) * 0.6, 0], [0.4, 2.6 * hip, 1.8 + (hip - 1) * 0.5, 0], [1.6, 2.45 * (1 + hip) * 0.5, 1.7, 0.05], [3.6, 3.3 * (1 + sh) * 0.5, 2.05, 0.15], [5.3, 4.05 * sh, 2, 0.05], [6.1, 3.1 * sh, 1.6, -0.05], [6.5, 1.4, 1.2, 0]];
  torso.cyl(skin, 1, 1.15, 1.6, 0, 6.6, 0, 6);
  torso.loft(cloth, rings);
  if (belt) torso.loft(belt, [around(rings, 0.85, 0.1, 0.02), around(rings, 1.75, 0.1, 0.05)]);
  return rings;
}

/** A ring just outside `rings` at height `y`, `by` larger all round. */
function around(rings: readonly Ring[], y: number, by: number, dz = 0): Ring {
  const r = ringAt(rings, y);
  return [y, r.rx + by, r.rz + by, r.dz + dz];
}

/** The class's tunic, belted, with a placket down the front. */
function lowTorso(torso: Part, look: Look, sh: number) {
  lowChest(torso, look.skin, look.body, sh, look.accent);
  torso.box(tone(look.body, 0.08), 0.8, 2.6, 0.3, 0, 4.1, 2.02);
  torso.shape(GEAR.gold, sym([[0.6, 0.85, 1.75], [0.6, 1.75, 1.8], [0.5, 0.95, 2.05], [0.5, 1.65, 2.08]]));
}

/** What is under the clothes: a plain linen vest, and short drawers on the hips. */
const LINEN = "#e6dcc4";
function lowUndershirt(torso: Part, skin: string, sh: number) {
  const rings = lowChest(torso, skin, LINEN, sh);
  // Its neckline: the skin of the chest showing in a little V.
  torso.shape(skin, sym([[0.75, 5.9, 1.62], [0, 4.9, 1.95], [0, 6.2, 1.5]]));
  // The drawers' waistband, round the hips.
  torso.loft(tone(LINEN, -0.06), [around(rings, -0.7, 0.06), around(rings, 0.3, 0.06)]);
}

/**
 * The skirts of a long coat, open at the front, as two panels round the legs from the waist to the shin:
 * each a slice of a flaring ring from `a0` to `a1` (radians from +z, toward +x), a little thick.
 */
function coatPanel(part: Part, color: string, s: number, a0: number, a1: number, grow = 0) {
  const pts: Pt[] = [];
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    // The skirts flare over the hips, wider for wide ones.
    for (const [y, rx, rz, dz] of [[1.4, 2.85 * (1 + m.hips) * 0.5 + grow, 2 + grow, 0.05], [-4.6, 3.5 * m.hips + grow, 2.7 + grow, -0.2]] as const) {
      for (const k of [1, 0.82]) pts.push([s * Math.sin(a) * rx * k, y, Math.cos(a) * rz * k + dz]);
    }
  }
  part.shape(color, pts);
}

/** An arm in a sleeve with a cuff, from the shoulder joint down. */
function lowSleeve(arm: Part, cloth: string, cuff: string) {
  arm.loft(cloth, [[-3.9, 0.95, 0.95], [-2.6, 1.05, 1.05], [-1, 1.2, 1.22], [0.2, 1.32, 1.32], [0.95, 0.75, 0.75]], 6);
  arm.loft(cuff, [[-4.15, 1.08, 1.08], [-3.45, 1.1, 1.1]], 6);
}

/** A tunic sleeve rolled up above the elbow, the turned-back cuff fat round the arm, and the forearm bare below. */
function lowRolledSleeve(arm: Part, skin: string, cloth: string) {
  arm.loft(skin, BARE_ARM.slice(0, 3), 6);
  arm.loft(cloth, [[-1.6, 1.2, 1.22], [-1, 1.22, 1.24], [0.2, 1.32, 1.32], [0.95, 0.75, 0.75]], 6);
  arm.loft(tone(cloth, 0.07), [[-2.05, 1.24, 1.26], [-1.8, 1.36, 1.38], [-1.4, 1.36, 1.38], [-1.2, 1.26, 1.28]], 6);
}

/** A bare arm, with the vest's short sleeve over the shoulder. */
const BARE_ARM: Ring[] = [[-4.2, 0.85, 0.85], [-2.6, 0.98, 0.98], [-1, 1.12, 1.14], [0.2, 1.2, 1.2], [0.85, 0.7, 0.7]];
function lowBareArm(arm: Part, skin: string) {
  arm.loft(skin, BARE_ARM, 6);
  arm.loft(LINEN, [[-1.2, 1.24, 1.26], [0.3, 1.36, 1.36], [1, 0.8, 0.8]], 6);
}

// ---------- tattoos ----------

/** How big an ink cell is on the body, in its part's units before scaling. */
const INK_CELL = 0.26;

/**
 * Where an ink region's grid lies on the body (see INK_REGIONS): the loft it is drawn on, in its part's space
 * before the part is scaled, with how many sides it has; and the grid's half width and top there. The grid is
 * seen square on, from the front or the back, so a cell lands on the body where it is seen to be.
 */
export interface InkSurface {
  rings: readonly Ring[];
  sides: number;
  half: number;
  top: number;
  cell: number;
}

export function inkSurface(region: InkRegion, look?: Appearance | null): InkSurface {
  const cell = INK_CELL;
  const half = (INK_REGIONS[region].cols * cell) / 2;
  switch (region) {
    case "head":
      return { rings: HEAD_RINGS[look?.headShape ?? "round"] ?? HEAD_RINGS.round, sides: 8, half, top: 6.64, cell };
    case "armR":
    case "armL":
      // From just under the vest's sleeve to the wrist.
      return { rings: BARE_ARM, sides: 6, half, top: -0.87, cell };
    case "thighR":
    case "thighL":
      // From just under the drawers to the knee.
      return { rings: THIGH, sides: 6, half, top: -1.46, cell };
    default:
      // From the knee down to the ankle.
      return { rings: SHIN, sides: 6, half, top: 0, cell };
  }
}

/** A loft's cross-section at height `y`: its corners, round from the front, in (x, z). */
function section(rings: readonly Ring[], sides: number, y: number): [number, number][] {
  const r = ringAt(rings, y);
  return Array.from({ length: sides }, (_, k) => {
    const a = ((k + 0.5) / sides) * Math.PI * 2;
    return [Math.sin(a) * r.rx, Math.cos(a) * r.rz + r.dz];
  });
}

/** How far out to either side a loft reaches at height `y` (0 above or below it): its outline seen square on. */
export function inkAcross(surface: InkSurface, y: number): number {
  const { rings } = surface;
  if (y < rings[0][0] || y > rings[rings.length - 1][0]) return 0;
  return Math.max(...section(rings, surface.sides, y).map(([x]) => Math.abs(x)));
}

/**
 * The point on a loft at height `y` and across `x`, on its front (or back), lifted a little off it, outward
 * along the face it lies on.
 */
function onSurface(surface: InkSurface, x: number, y: number, back: boolean): [number, number, number] {
  const pts = section(surface.rings, surface.sides, y);
  const reach = Math.max(...pts.map(([px]) => Math.abs(px)));
  const cx = Math.max(-reach * 0.999, Math.min(reach * 0.999, x));
  let best: { z: number; nx: number; nz: number } | null = null;
  for (let k = 0; k < pts.length; k++) {
    const [ax, az] = pts[k];
    const [bx, bz] = pts[(k + 1) % pts.length];
    if (ax === bx || cx < Math.min(ax, bx) || cx > Math.max(ax, bx)) continue;
    const z = az + ((cx - ax) / (bx - ax)) * (bz - az);
    if (best && (back ? z >= best.z : z <= best.z)) continue;
    // Outward from the loft: the edge's normal, turned away from its middle.
    let nx = bz - az;
    let nz = -(bx - ax);
    const len = Math.hypot(nx, nz) || 1;
    nx /= len;
    nz /= len;
    const midZ = (az + bz) / 2 - ringAt(surface.rings, y).dz;
    if (nx * (ax + bx) / 2 + nz * midZ < 0) {
      nx = -nx;
      nz = -nz;
    }
    best = { z, nx, nz };
  }
  if (!best) return [cx, y, 0];
  const lift = 0.035;
  return [cx + best.nx * lift, y, best.z + best.nz * lift];
}

/**
 * Lay one side's inked cells over a loft on `part`: each cell cut where the loft's faces turn and where its
 * rings change, so every piece lies flat on the face under it, and gathered into one mesh per shade.
 */
function inkOn(part: Part, surface: InkSurface, cols: number, view: InkView, cells: Map<number, number>, skin: string) {
  const { half, top, cell, rings } = surface;
  const back = view === "b";
  // Seen from the front, the grid's left is the figure's right (-x); from the back, its left.
  const xAt = (c: number) => (back ? half - c * cell : -half + c * cell);
  /** Each cell's colour (its ink over the skin, as strongly as it was inked), and the triangles in it. */
  const byColor = new Map<string, number[]>();
  for (const [at, ink] of cells) {
    const c = at % cols;
    const r = Math.floor(at / cols);
    const yTop = top - r * cell;
    const yBottom = yTop - cell;
    const xa = Math.min(xAt(c), xAt(c + 1));
    const xb = Math.max(xAt(c), xAt(c + 1));
    if (Math.abs((xa + xb) / 2) >= inkAcross(surface, (yTop + yBottom) / 2)) continue;
    const color = inkOver(skin, ink);
    if (!byColor.has(color)) byColor.set(color, []);
    const out = byColor.get(color)!;
    const ys = [yBottom, ...rings.map((ring) => ring[0]).filter((y) => y > yBottom && y < yTop), yTop];
    for (let i = 0; i + 1 < ys.length; i++) {
      const [y0, y1] = [ys[i], ys[i + 1]];
      const mid = (y0 + y1) / 2;
      const reach = inkAcross(surface, mid);
      if (reach <= 0) continue;
      const turns = section(rings, surface.sides, mid).map(([x]) => x);
      const xs = [Math.max(xa, -reach), ...turns.filter((x) => x > xa && x < xb), Math.min(xb, reach)].sort((p, q) => p - q);
      for (let j = 0; j + 1 < xs.length; j++) {
        const [x0, x1] = [xs[j], xs[j + 1]];
        if (x1 - x0 < 1e-4) continue;
        const a = onSurface(surface, x0, y0, back);
        const b = onSurface(surface, x1, y0, back);
        const c2 = onSurface(surface, x1, y1, back);
        const d = onSurface(surface, x0, y1, back);
        // Wound to face out: toward +z on the front, -z on the back.
        if (back) out.push(...a, ...c2, ...b, ...a, ...d, ...c2);
        else out.push(...a, ...b, ...c2, ...a, ...c2, ...d);
      }
    }
  }
  for (const [color, positions] of byColor) if (positions.length) part.inkGeometry(color, positions);
}

/** The colour a cell of ink shows on this skin: its ink laid over the skin, as strongly as it was inked. */
export function inkOver(skin: string, cell: number): string {
  const ink = INK_COLORS[inkColorOf(cell) - 1] ?? INK_COLORS[0];
  return `#${new THREE.Color(skin).lerp(new THREE.Color(ink), inkLevelOf(cell) / INK_LEVELS).getHexString()}`;
}

/** Draw the tattoos a hero drew on `region`, front and back, on the part it lies on. */
function inkPart(part: Part, region: InkRegion, ink: Ink, skin: string) {
  const surface = inkSurface(region, chosen);
  for (const view of ["f", "b"] as const) {
    const cells = decodeInk(ink[`${region}.${view}`]);
    if (cells.size) inkOn(part, surface, INK_REGIONS[region].cols, view, cells, skin);
  }
}

/**
 * Where the face is on a head of the chosen look, in the head grid's units, for the paper doll to sketch
 * under the ink: the eyes, brows, nose, mouth and ears, and where the hair covers.
 */
export function inkGuides(look: Appearance | null | undefined) {
  const shape = look?.headShape ?? "round";
  const rings = HEAD_RINGS[shape] ?? HEAD_RINGS.round;
  return {
    eyeY: 3.05,
    eyeX: look?.eyes === "beady" ? 1.05 : 1.15,
    browY: 3.95,
    noseY: 2.3,
    mouthY: MOUTH_Y[shape] ?? 1.45,
    earX: ringAt(rings, 3).rx * 0.97,
    earY: 3,
    /** The cap of hair comes down to here all round, and the fall at the back to `napeY`. */
    capY: 4.35,
    napeY: 1.9,
    bald: look?.hairStyle === "bald",
  };
}

/** A big round mitt of a hand, the thumb forward and toward the body. `s` is the side (-1 right, 1 left). */
function lowHand(arm: Part, skin: string, s: number) {
  arm.loft(skin, [[-6.35, 0.5, 0.55, 0.1], [-5.85, 1.12, 1.05, 0.15], [-4.9, 1.18, 1.1, 0.1], [-4.15, 0.85, 0.85]], 6);
  arm.ball(skin, 0.48, -s * 0.55, -4.95, 0.95);
}

/** A tapered leg in two pieces that meet at the knee, so it can bend: the thigh on `thigh`, the shin on `shin`. */
const THIGH: Ring[] = [[-2.95, 1.08, 1.12], [-1.4, 1.3, 1.36], [0.2, 1.5, 1.5], [0.85, 1.1, 1.1]];
const SHIN: Ring[] = [[-2.25, 0.92, 0.98], [-1, 1.15, 1.2, -0.05], [0.4, 1.1, 1.14]];
function lowLeg(thigh: Part, shin: Part, color: string) {
  thigh.loft(color, THIGH, 6);
  shin.loft(color, SHIN, 6);
}

/** A bare leg, the drawers over the top of the thigh. */
function lowBareLeg(thigh: Part, shin: Part, skin: string) {
  lowLeg(thigh, shin, skin);
  thigh.loft(LINEN, [[-1.5, 1.42, 1.48], [0.3, 1.6, 1.6], [0.9, 1.2, 1.2]], 6);
}

/**
 * A mail hauberk over the chest, low-poly: mail on the low-poly chest, rounded steel breast and back plates,
 * a mail skirt over the hips, a gold belt, and the trim's colour on the breastplate. Returns how far forward
 * its front is (for an amulet over it).
 */
function lowHauberk(torso: Part, skin: string, sh: number, trim: string): number {
  const rings = lowChest(torso, skin, GEAR.iron, sh, GEAR.gold);
  const hip = ringAt(rings, -0.6);
  torso.loft(tone(GEAR.iron, -0.1), [around(rings, 0.55, 0.1), [-1.5, hip.rx + 0.35, hip.rz + 0.3, hip.dz]], 8);
  for (const back of [false, true]) {
    const pts: Pt[] = [];
    for (const y of [2.3, 3.5, 4.6, 5.45]) {
      const r = ringAt(rings, y);
      for (const deg of [-64, -32, 0, 32, 64]) {
        const a = (deg / 180) * Math.PI;
        const z = Math.cos(a) * (r.rz + 0.24);
        pts.push([Math.sin(a) * (r.rx + 0.24), y, back ? -z + r.dz : z + r.dz]);
      }
    }
    torso.shape(GEAR.steel, pts);
  }
  const front = ringAt(rings, 4.2).rz + ringAt(rings, 4.2).dz + 0.3;
  torso.box(trim, 1.3, 1.3, 0.4, 0, 4.2, front);
  return front;
}

/**
 * An oilskin greatcoat over the chest, low-poly (the skirts are coat panels, drawn with the other long coats):
 * a stand-up collar, a placket with gold buttons, a dark belt with a buckle in the trim's colour. Returns how
 * far forward its front is.
 */
function lowGreatcoat(torso: Part, skin: string, oilskin: string, sh: number, trim: string): number {
  const rings = lowChest(torso, skin, oilskin, sh, GEAR.dark);
  torso.loft(tone(oilskin, -0.1), [around(rings, 5.55, 0.18, -0.05), [6.55, 1.95, 1.75, -0.3]], 8);
  const front = (y: number) => ringAt(rings, y).rz * Math.cos(Math.PI / 8) + ringAt(rings, y).dz;
  torso.box(tone(oilskin, 0.08), 0.9, 3.4, 0.3, 0, 3.85, front(3.85) + 0.08);
  for (const y of [2.5, 3.6, 4.7]) torso.ball(GEAR.gold, 0.3, 0, y, front(y) + 0.25);
  torso.box(trim, 1.2, 1.1, 0.4, 0, 1.3, front(1.3) + 0.12);
  return front(4.5) + 0.1;
}

/** Armor on the legs, low-poly: loose sailcloth trousers tied at the shin, or iron greaves with steel at the knee and shin. */
function lowLegArmor(thigh: Part, shin: Part, ref: string, trim: string) {
  if (ref === "trousers") {
    const cloth = "#d8cfb4";
    thigh.loft(cloth, grown(THIGH, 0.14), 6);
    shin.loft(cloth, [[-1.55, 1.18, 1.24], [-1, 1.32, 1.38, -0.05], [0.4, 1.28, 1.32]], 6);
    shin.loft(trim, [[-1.75, 1.22, 1.28], [-1.35, 1.24, 1.3]], 6);
    thigh.box(tone(cloth, -0.1), 0.9, 1.1, 0.3, 0.45, -1.6, 1.42);
    return;
  }
  thigh.loft(GEAR.iron, grown(THIGH, 0.06), 6);
  shin.loft(GEAR.iron, grown(SHIN, 0.08), 6);
  shin.ball(GEAR.steel, 0.95, 0, 0.05, 0.85, 0, [1.15, 0.95, 0.8]);
  shin.shape(GEAR.steel, sym([[0.75, -0.55, 0.95], [0.7, -1.95, 0.85], [0, -0.45, 1.38], [0, -2.05, 1.25]]));
  thigh.loft(trim, [[0.05, 1.62, 1.62], [0.5, 1.56, 1.56]], 6);
}

/** Boots, low-poly: short iron-shod treads, or tall sea boots turned down at the top. */
function lowBoots(foot: Part, shin: Part, ref: string, trim: string) {
  if (ref === "treads") {
    lowShoe(foot, "#5a4632");
    foot.shape(GEAR.iron, sym([[1.42, -0.05, -1.5], [1.5, -0.05, 1.5], [1.02, -0.05, 2.7], [0, -0.05, 2.95], [1.42, 0.4, -1.5], [1.5, 0.4, 1.5], [1.02, 0.4, 2.7], [0, 0.4, 2.95]]));
    shin.loft("#5a4632", [[-2.35, 1.06, 1.1], [-1.75, 1.1, 1.14]], 6);
    shin.loft(trim, [[-1.8, 1.14, 1.18], [-1.5, 1.14, 1.18]], 6);
    return;
  }
  lowShoe(foot, GEAR.leather);
  shin.loft(GEAR.leather, [[-2.35, 1.1, 1.14], [-1, 1.3, 1.34, -0.05], [-0.5, 1.32, 1.36]], 6);
  shin.loft(tone(GEAR.leather, 0.08), [[-0.85, 1.44, 1.48], [-0.2, 1.48, 1.52]], 6);
  shin.loft(trim, [[-1.15, 1.36, 1.4], [-0.92, 1.37, 1.41]], 6);
}

/** A chunky round-toed shoe, its sole on the ground at the foot's origin. */
function lowShoe(foot: Part, color: string) {
  foot.shape(color, sym([[1.22, 0, -1.3], [1.3, 0, 1.4], [0.9, 0, 2.45], [0, 0, 2.7], [1.05, 1.35, -1.05], [1.1, 1.15, 0.7], [0.75, 0.75, 2.15], [0, 0.85, 2.4]]));
  foot.shape(tone(color, -0.12), sym([[1.3, 0, -1.4], [1.38, 0, 1.45], [0.95, 0, 2.55], [0, 0, 2.8], [1.3, 0.35, -1.4], [1.38, 0.35, 1.45], [0.95, 0.35, 2.55], [0, 0.35, 2.8]]));
}

/** A bare foot: a rounded wedge, flat on the ground, the ankle into the shin. */
function lowBareFoot(foot: Part, skin: string) {
  foot.shape(skin, sym([[0.95, 0, -1], [1.05, 0, 1.3], [0.7, 0, 2.2], [0, 0, 2.4], [0.8, 1.1, -0.7], [0.75, 0.7, 1.1], [0, 0.55, 2.1], [0, 1.25, -0.6]]));
}

/** A sword: a diamond-section blade tapering to a point, a swept guard, a wrapped grip and a round pommel. */
function lowSword(w: Part, accent: string) {
  w.cyl(GEAR.leather, 0.42, 0.48, 2.1, 0, 0.15, 0, 6);
  w.ball(accent, 0.62, 0, -1.05, 0);
  w.shape(accent, sym([[1.95, 1.45, 0.3], [1.95, 2.05, 0.3], [1.95, 1.45, -0.3], [1.95, 2.05, -0.3], [0, 1.05, 0.48], [0, 1.85, 0.48], [0, 1.05, -0.48], [0, 1.85, -0.48]]));
  w.shape(GEAR.steel, sym([[0.62, 1.9, 0], [0, 1.9, 0.26], [0, 1.9, -0.26], [0.5, 8.7, 0], [0, 8.7, 0.22], [0, 8.7, -0.22], [0, 10.3, 0]]));
}

/** A head: skin, ears, hair, and a face. */
function drawHead(head: Part, look: Look, asleep: boolean) {
  const skin = look.skin;
  head.box(skin, 6.4, 5.8, 5.8, 0, 3.2, 0);
  for (const s of [-1, 1]) head.box(tone(skin, -0.05), 0.7, 1.5, 1.3, s * 3.4, 2.8, 0);
  head.box(look.hair, 6.8, 1.6, 6.2, 0, 5.5, -0.1);
  head.box(look.hair, 6.8, 4.2, 1.4, 0, 3.9, -2.6);
  for (const s of [-1, 1]) head.box(look.hair, 0.6, 2.6, 3.2, s * 3.3, 4.2, -0.6);
  head.box(look.hair, 6.6, 0.9, 0.6, 0, 4.6, 2.9);
  for (const s of [-1, 1]) {
    if (asleep) head.box(OUTLINE, 1.5, 0.4, 0.3, s * 1.5, 2.7, 2.95);
    else {
      head.box(OUTLINE, 1.1, 1.5, 0.3, s * 1.5, 2.9, 2.95);
      head.box("#ffffff", 0.45, 0.5, 0.3, s * 1.5 + 0.3, 3.35, 3.0);
    }
  }
  head.box(tone(skin, -0.07), 0.9, 0.8, 0.5, 0, 2.05, 3.05);
  head.box(tone(skin, -0.22), 1.6, 0.35, 0.3, 0, 1.1, 2.95);
}

/** The headgear a class or enemy has by default. */
function drawHat(head: Part, look: Look) {
  const hat = look.hat;
  if (hat === "helm") {
    const c = "#aeb6c2";
    head.box(c, 7, 2.8, 6.6, 0, 5.3, 0);
    head.box(tone(c, 0.06), 5.4, 0.7, 5, 0, 7, 0);
    for (const s of [-1, 1]) head.box(c, 0.7, 2.6, 3.2, s * 3.45, 2.9, 0.4);
    head.box(look.accent, 1, 1.5, 3.6, 0, 7.9, -0.2);
  } else if (hat === "wizard") {
    head.cyl(look.accent, 5.3, 5.3, 0.6, 0, 6.2, 0, 10);
    head.cyl(look.body, 2.1, 3.4, 3, 0, 8, 0, 8);
    head.cone(look.body, 2.1, 4.2, 0, 11.4, -0.5, 8, [-0.25, 0, 0]);
    head.box(look.accent, 1, 1, 0.5, 0, 7.6, 3.1);
  } else if (hat === "hood") {
    drawHood(head, look.hatColor ?? look.body);
  } else if (hat === "leaves") {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      head.box(i % 2 ? look.accent : tone(look.accent, -0.1), 1.9, i % 2 ? 2 : 1.4, 0.7, Math.sin(a) * 3.3, i % 2 ? 6.3 : 6, Math.cos(a) * 3.1, [0, a, 0]);
    }
    head.ball("#c8433d", 0.6, 1.4, 6.3, 3.3);
  } else if (hat === "feather") {
    head.box(look.body, 7.2, 1.5, 6.8, 0, 6, 0);
    head.box(look.body, 2.6, 1.1, 4.6, 3.8, 5.5, -0.2, [0, 0, -0.25]);
    head.box(tone(look.body, -0.08), 7.3, 0.5, 6.9, 0, 5.3, 0);
    head.box(look.accent, 0.5, 4, 1.5, -2.6, 8.2, -1, [-0.35, 0, 0.15]);
  } else if (hat === "circlet") {
    head.box(look.accent, 7.1, 0.7, 6.6, 0, 4.9, -0.1);
    head.glowBox("#7fe3ff", 1.2, 1.2, 0.5, 0, 5.2, 3.3);
  } else if (hat === "brim") {
    const c = look.hatColor ?? look.body;
    head.cyl(c, 5.7, 5.7, 0.5, 0, 6, 0, 10);
    head.cyl(c, 3, 3.3, 2.6, 0, 7.5, 0, 8);
    head.cyl(look.accent, 3.4, 3.4, 0.7, 0, 6.6, 0, 8);
  } else if (hat === "turban") {
    const c = look.hatColor ?? look.accent;
    head.ball(c, 4.2, 0, 6.2, -0.1, 1, [1, 0.6, 1]);
    head.box(tone(c, -0.08), 7.2, 1.2, 6.6, 0, 5, -0.1);
    head.ball(c, 1.4, 0.8, 8.4, 0);
    head.box(look.accent, 1.1, 1.1, 0.6, 0, 5.8, 3.6);
  } else if (hat === "kerchief") {
    const c = look.hatColor ?? look.accent;
    head.box(c, 7, 1.9, 6.5, 0, 5.5, -0.1);
    head.box(c, 1.2, 2.8, 0.8, 1.6, 3.4, -3.6, [0, 0, 0.2]);
    head.box(tone(c, -0.08), 1, 2.2, 0.8, -0.4, 3.7, -3.7, [0, 0, -0.15]);
  } else if (hat === "greathelm") {
    const c = look.hatColor ?? "#8b95a5";
    head.box(c, 7.4, 6.6, 6.8, 0, 3.6, 0);
    head.box(tone(c, 0.06), 6, 0.8, 5.6, 0, 7.2, 0);
    head.box(tone(c, -0.1), 7.6, 0.8, 7, 0, 0.6, 0);
    head.box(OUTLINE, 5.6, 0.9, 0.4, 0, 3.3, 3.3);
    head.box(OUTLINE, 0.8, 1.8, 0.4, 0, 2, 3.3);
    head.box(look.accent, 1.4, 1.5, 4.8, 0, 8.2, 0);
  } else if (hat === "horns") {
    head.box(look.accent, 7, 0.8, 6.5, 0, 5, -0.1);
    for (const s of [-1, 1]) head.cone(look.accent, 0.9, 3.2, s * 3.1, 7.4, 0, 5, [0, 0, -s * 0.4]);
  }
}

/** A hood: over the crown, down the back and the sides of the head, onto the shoulders. */
function drawHood(head: Part, c: string, trim?: string) {
  head.box(c, 7.5, 2.2, 7, 0, 5.7, -0.2);
  head.box(c, 7.5, 5.6, 1.6, 0, 3.4, -2.95);
  for (const s of [-1, 1]) head.box(c, 0.9, 5.2, 5.4, s * 3.55, 3.3, -0.4);
  head.box(tone(c, -0.07), 2.2, 1.1, 2.4, 0, 7, -1.6);
  head.box(tone(c, -0.07), 8, 1, 5.4, 0, 0.5, -0.8);
  if (trim) head.box(trim, 7.6, 0.6, 0.5, 0, 4.9, 3.1);
}

/**
 * What is carried, in the frame of the hand that carries it: the grip at the origin, up along +y.
 * Returns how far forward the arm rests and how the thing is tipped, where it is not held upright at the side.
 */
function drawHeld(id: string, b: Biped, trim: string, look: Look, shield: boolean): { arm?: number; tilt?: number } {
  const w = b.heldR;
  const shaft = (c: string, h: number, y: number) => w.cyl(c, 0.42, 0.42, h, 0, y, 0, 6);
  const dagger = (p: Part) => {
    p.box(GEAR.wood, 0.7, 1.6, 0.7, 0, 0.1, 0);
    p.box(trim, 2, 0.5, 0.9, 0, 1, 0);
    p.box(GEAR.steel, 0.9, 3.4, 0.4, 0, 2.9, 0);
    p.box(GEAR.shine, 0.5, 0.9, 0.4, 0, 5, 0);
  };
  const axe = (band: string) => {
    shaft(GEAR.wood, 14, 3.4);
    w.box(GEAR.steel, 0.5, 4, 2.6, 0, 9.4, 1.7);
    w.box(GEAR.shine, 0.52, 5, 0.8, 0, 9.4, 3.2);
    w.box(GEAR.iron, 0.5, 1.4, 1.2, 0, 9.4, -0.9);
    w.cyl(band, 0.6, 0.6, 0.8, 0, 7, 0, 6);
  };
  const lantern = (y: number, z: number) => {
    w.box(GEAR.iron, 1.7, 0.4, 1.7, 0, y + 1.2, z);
    w.cone(GEAR.iron, 1, 0.7, 0, y + 1.7, z);
    w.glowBox("#ffd98a", 1.3, 1.9, 1.3, 0, y, z);
    for (const [x, zz] of [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]]) w.box(GEAR.iron, 0.25, 2, 0.25, x, y, z + zz);
    w.box(GEAR.iron, 1.7, 0.4, 1.7, 0, y - 1.2, z);
  };
  switch (id) {
    case "sword":
      if (lowPoly) {
        lowSword(w, look.accent);
        return { tilt: 0.55 };
      }
      w.box(GEAR.wood, 0.8, 1.8, 0.8, 0, 0.2, 0);
      w.box(look.accent, 1, 1, 1, 0, -0.9, 0);
      w.box(look.accent, 3.2, 0.6, 1, 0, 1.3, 0);
      w.box(GEAR.steel, 1.1, 7.5, 0.45, 0, 5.3, 0);
      w.box(GEAR.shine, 0.35, 7.5, 0.5, 0, 5.3, 0);
      w.box(GEAR.steel, 0.7, 0.9, 0.45, 0, 9.5, 0);
      return { tilt: 0.55 };
    case "greatsword":
      w.box(GEAR.wood, 0.9, 2.6, 0.9, 0, 0.4, 0);
      w.box(trim, 1.2, 1.2, 1.2, 0, -1.2, 0);
      w.box(GEAR.gold, 4.6, 0.7, 1.1, 0, 1.9, 0);
      w.box(GEAR.steel, 1.7, 11, 0.5, 0, 7.8, 0);
      w.box(GEAR.shine, 0.5, 10.6, 0.56, 0, 7.8, 0);
      w.box(GEAR.steel, 1, 1, 0.5, 0, 13.6, 0);
      return { tilt: 0.4 };
    case "staff":
      shaft(GEAR.wood, 17, 3.2);
      w.cyl(GEAR.gold, 0.75, 0.75, 0.6, 0, 11.6, 0, 6);
      for (const s of [-1, 1]) w.box(GEAR.gold, 0.35, 1.9, 0.35, s * 1.35, 12.7, 0);
      w.glowBall(trim, 1.4, 0, 13.1, 0);
      return {};
    case "root_staff":
      shaft(GEAR.wood, 16, 2.8);
      w.box(GEAR.wood, 0.7, 3.4, 0.7, -0.9, 12, 0, [0, 0, 0.35]);
      w.box(GEAR.wood, 0.7, 4, 0.7, 1, 12.3, 0, [0, 0, -0.4]);
      w.glowBall(trim, 0.8, 0, 12.6, 0);
      w.box("#a6d06a", 1.5, 0.4, 0.9, 2.2, 14.3, 0);
      w.box("#a6d06a", 1.1, 0.4, 0.8, -1.9, 13.6, 0.2);
      return {};
    case "void_staff":
      shaft(GEAR.dark, 16, 2.8);
      w.ring(GEAR.dark, 1.5, 0.42, 0, 12.4, 0);
      w.glowBall(trim, 0.65, 0, 12.4, 0);
      return {};
    case "mace":
      shaft(GEAR.wood, 8, 2.5);
      w.cyl(trim, 0.62, 0.62, 0.7, 0, 5.4, 0, 6);
      w.ball(GEAR.iron, 1.9, 0, 7.5, 0);
      w.box(GEAR.steel, 0.5, 2.6, 4.3, 0, 7.5, 0);
      w.box(GEAR.steel, 4.3, 2.6, 0.5, 0, 7.5, 0);
      return { tilt: 0.4 };
    case "maul":
      shaft(GEAR.wood, 13, 3);
      w.box(GEAR.iron, 3.2, 3.2, 5.2, 0, 10.4, 0);
      for (const s of [-1, 1]) w.box(GEAR.steel, 3.5, 3.5, 0.7, 0, 10.4, s * 2.6);
      w.box(trim, 3.4, 3.4, 1.2, 0, 10.4, 0);
      return { tilt: 0.2 };
    case "pager_axe":
      axe(trim);
      return { tilt: 0.25 };
    case "sickle":
      shaft(GEAR.wood, 4.4, 1);
      w.box(trim, 0.9, 0.9, 0.9, 0, -1.4, 0);
      w.box(GEAR.steel, 0.4, 2.8, 0.8, 0, 4.4, 0);
      w.box(GEAR.steel, 0.4, 0.8, 3.2, 0, 5.9, 1.3);
      w.box(GEAR.shine, 0.4, 1.7, 0.8, 0, 5, 2.9);
      return { tilt: 0.4 };
    case "daggers": {
      // One in each fist (the second unless a shield is there), both tipped forward the same and angled out
      // from the body, up and away from the hands.
      const outward = (hand: Part, s: number) => {
        const grip = new Part(hand.joint);
        grip.joint.rotation.z = s * 0.38;
        extraParts.push(grip);
        return grip;
      };
      dagger(outward(w, 1));
      if (!shield) {
        dagger(outward(b.heldL, -1));
        b.rest.tiltL = 0.7;
      }
      return { tilt: 0.7 };
    }
    case "shortbow":
    case "bow": {
      // Held beside the fist, the belly forward and the string toward the arm.
      if (lowPoly) {
        // One smooth stave: thickest at the grip, curving back and tapering to a nock at each tip, the
        // string straight between them.
        const reach = 4.7;
        const back = (y: number) => 0.35 - 1.75 * (y / reach) ** 2;
        const stave: Ring[] = [];
        for (let i = 0; i <= 12; i++) {
          const y = -reach + (2 * reach * i) / 12;
          const r = 0.38 - 0.2 * Math.abs(y / reach) ** 1.5;
          stave.push([y, r, r * 1.15, back(y)]);
        }
        w.loft(GEAR.wood, stave, 6, -1.4);
        for (const y of [-reach, reach]) w.ball(tone(GEAR.wood, -0.15), 0.26, -1.4, y, back(y), 0);
        w.box(id === "bow" ? look.accent : GEAR.paper, 0.14, 2 * reach - 0.2, 0.14, -1.4, 0, back(reach) + 0.05);
        w.loft(id === "bow" ? GEAR.leather : trim, [[-0.8, 0.46, 0.52, back(0)], [0.8, 0.46, 0.52, back(0)]], 6, -1.4);
        return {};
      }
      for (let i = -2; i <= 2; i++) w.box(GEAR.wood, 0.6, 2.6, 0.6, -1.4, i * 2.2, 0.3 - Math.abs(i) * 0.85, [i * 0.3, 0, 0]);
      w.box(id === "bow" ? look.accent : GEAR.paper, 0.2, 9.4, 0.2, -1.4, 0, -1.5);
      w.box(id === "bow" ? GEAR.leather : trim, 0.9, 1.6, 0.9, -1.4, 0, 0.3);
      return {};
    }
    case "tome":
      w.box(trim, 1.3, 4.2, 3.2, 0, -0.4, 0.4);
      w.box(GEAR.paper, 0.9, 3.8, 3.3, 0, -0.4, 0.5);
      w.box(GEAR.dark, 1.35, 4.2, 0.5, 0, -0.4, -1.1);
      w.box(GEAR.gold, 1.4, 0.6, 0.5, 0, -0.4, 2);
      return {};
    case "grimoire": {
      // Held open in front, the pages alight.
      const cover = look.weapon === "grimoire" && trim === look.accent ? "#3a2a4a" : GEAR.dark;
      const page = trim === look.accent ? look.accent : "#6dff9e";
      for (const s of [-1, 1]) {
        w.box(cover, 2.6, 0.5, 3.4, s * 1.3, 0.9, 0.6, [0, 0, s * 0.3]);
        w.glowBox(page, 2.2, 0.3, 3, s * 1.25, 1.3, 0.6, [0, 0, s * 0.3]);
      }
      w.box(trim, 0.6, 0.6, 3.5, 0, 0.6, 0.6);
      w.glowBox(page, 0.4, 0.4, 0.4, 0.7, 3.2, 0.4);
      w.glowBox(page, 0.4, 0.4, 0.4, -0.8, 4.4, 1);
      return { arm: -0.9 };
    }
    case "lute":
      if (lowPoly) {
        // Played across the body: its belly in front of the waist by the strumming hand, the neck reaching up
        // and across to the other hand, raised to hold it near the head. Laid from where that hand is, so it
        // grips the neck however broad the shoulders.
        const grip = handAt(1, LUTE_ARMS.left, 0.1);
        const belly = new THREE.Vector3(-1.4, 2, 2.25 * m.girth + 1.35);
        const along = grip.clone().sub(belly).normalize();
        belly.copy(grip).addScaledVector(along, -6.8);
        const lute = new Part(b.torso.joint);
        layAlong(lute.joint, belly, along);
        drawLute(lute, trim);
        // And the same lute slung across the back, for while they walk: its belly behind the right hip, the
        // neck up past the left shoulder, clear of the head (turned about, so it faces out behind).
        const back = new Part(b.torso.joint, -1, 2, -(1.9 * m.girth + 1.25));
        back.joint.rotation.set(0, Math.PI, 0.75);
        drawLute(back, trim);
        return sling(b, lute, back, LUTE_ARMS);
      }
      w.ball(GEAR.leather, 2.3, 0, -2.2, 1.1, 1, [1, 1.25, 0.55]);
      w.cyl(GEAR.dark, 0.7, 0.7, 0.2, 0, -2, 2.4, 8, [HALF_PI, 0, 0]);
      w.box(GEAR.wood, 0.7, 5.4, 0.6, 0, 2.6, 1.1);
      w.box(trim, 1.2, 1.3, 0.8, 0, 5.6, 1.1);
      w.box(GEAR.paper, 0.3, 6.4, 0.1, 0, 1.6, 1.5);
      return {};
    case "flute":
      if (lowPoly) {
        // Held across the chest in both hands, the lower end in the right, the upper in the left.
        const low = handAt(-1, FLUTE_ARMS.right, -0.1);
        const high = handAt(1, FLUTE_ARMS.left, 0.1);
        const span = high.clone().sub(low);
        const flute = new Part(b.torso.joint);
        layAlong(flute.joint, low, span);
        drawFlute(flute, trim, span.length());
        // Slung across the back while they walk, the mouthpiece up past the left shoulder.
        const back = new Part(b.torso.joint, -0.6, 2.6, -(1.9 * m.girth + 0.55));
        back.joint.rotation.set(0, Math.PI, 0.85);
        drawFlute(back, trim, 8.5);
        return sling(b, flute, back, FLUTE_ARMS);
      }
      w.cyl(GEAR.paper, 0.38, 0.38, 8, 0, 2.6, 0, 6);
      for (const y of [1.5, 3, 4.5]) w.box(GEAR.dark, 0.3, 0.4, 0.3, 0, y, 0.3);
      w.cyl(trim, 0.5, 0.5, 0.8, 0, 6.8, 0, 6);
      return { tilt: 0.6 };
    case "orb":
      shaft(GEAR.wood, 6, 0.6);
      w.cyl(GEAR.gold, 1, 0.5, 0.9, 0, 4, 0, 6);
      w.glowBall(trim, 1.7, 0, 6, 0);
      w.glowBox("#ffffff", 0.5, 0.5, 0.5, -0.6, 6.7, 1.2);
      return { arm: -0.5 };
    case "scepter":
      w.cyl(GEAR.gold, 0.36, 0.36, 9, 0, 2, 0, 6);
      w.cyl(GEAR.gold, 0.9, 0.5, 0.8, 0, 6.6, 0, 6);
      w.ball(trim, 1.25, 0, 7.9, 0);
      for (const s of [-1, 1]) w.cone(GEAR.gold, 0.4, 1.3, s * 1.3, 7.6, 0);
      return { tilt: 0.3 };
    case "club":
      w.cyl(GEAR.wood, 1, 0.45, 7.6, 0, 2.6, 0, 6);
      w.box(tone(GEAR.wood, -0.1), 0.6, 0.6, 0.6, 0.8, 5.2, 0.3);
      w.box(tone(GEAR.wood, -0.1), 0.6, 0.6, 0.6, -0.7, 4, -0.4);
      return { tilt: 0.5 };
    case "rod": {
      // A fishing rod held out over the water: cork grip and reel, a long tapering blank, the line hanging
      // from its tip with a float on the end.
      w.cyl("#b8875a", 0.5, 0.5, 2.4, 0, 0.6, 0, 6);
      w.cyl(GEAR.iron, 0.8, 0.8, 0.5, 0.7, 1.4, 0, 8, [0, 0, HALF_PI]);
      w.cyl(rodInHand === "gilded" ? GEAR.gold : "#3a2a1c", 0.18, 0.38, 15, 0, 9.3, 0, 5);
      w.box("#e8eef2", 0.12, 7, 0.12, 0, 13.4, 1.4, [0.95, 0, 0]);
      w.ball("#d8352a", 0.5, 0, 11.4, 4.3);
      return { arm: -0.85, tilt: 0.75 };
    }
    case "lantern":
      w.ring(GEAR.iron, 0.6, 0.18, 0, -0.9, 0.9, [0, HALF_PI, 0]);
      lantern(-3.4, 0.9);
      return { arm: -0.7 };
    case "scroll": {
      // Rolled plans under the other arm, tied with blue.
      const p = b.heldL;
      p.cyl(GEAR.paper, 0.8, 0.8, 6, -0.3, 1.2, 0.6, 8, [HALF_PI, 0, 0]);
      p.cyl("#3f6fa8", 0.88, 0.88, 1, -0.3, 1.2, 0.6, 8, [HALF_PI, 0, 0]);
      for (const s of [-1, 1]) p.cyl("#c9b58a", 0.5, 0.5, 0.3, -0.3, 1.2, 0.6 + s * 3, 8, [HALF_PI, 0, 0]);
      return {};
    }
    case "pack": {
      // A big pack on the back, with a rolled blanket on top.
      const t = b.torso;
      t.box("#7a5230", 5.4, 5.6, 2.6, 0, 3.2, -3.2);
      t.box("#5f3f24", 5.5, 2, 2.7, 0, 5, -3.2);
      t.cyl(look.accent, 1.1, 1.1, 5.8, 0, 6.8, -3.1, 8, [0, 0, HALF_PI]);
      t.box(GEAR.gold, 0.8, 0.8, 0.3, 0, 3.8, -4.6);
      for (const s of [-1, 1]) t.box("#5f3f24", 0.6, 5.4, 0.3, s * 2.3, 3.3, 2);
      return {};
    }
    case "basket": {
      // A basket of greens on the other arm.
      const p = b.heldL;
      p.cyl("#b98b5a", 2, 1.6, 2.2, 0, -1.6, 0.8, 8);
      p.cyl("#8a6a44", 2.05, 2.05, 0.5, 0, -1, 0.8, 8);
      p.ring("#8a6a44", 1.7, 0.2, 0, -0.4, 0.8);
      for (const [x, z] of [[-0.8, 0.4], [0.7, 0.5], [0, 1.5]]) p.ball("#6fae4a", 0.9, x, -0.4, z);
      return {};
    }
    case "axe_shield": {
      // A big axe in the right hand, a tower shield on the left arm.
      axe(look.accent);
      const s = b.armL;
      s.box("#6f7480", 4.8, 8.4, 0.7, 0.4, -2.6, 1.9, [0, 0.35, 0]);
      s.box(look.accent, 3.2, 6.6, 0.3, 0.3, -2.6, 2.35, [0, 0.35, 0]);
      s.box(GEAR.steel, 3.4, 0.8, 0.35, 0.3, -2.4, 2.45, [0, 0.35, 0]);
      return { tilt: 0.25 };
    }
    // The signature weapons.
    case "ballast_flail":
      shaft(GEAR.wood, 6.4, 1.6);
      w.cyl(trim, 0.62, 0.62, 0.7, 0, 4.4, 0, 6);
      for (const [y, z] of [[5.3, 0.5], [5.7, 1.3], [5.3, 2.1]]) w.box(GEAR.iron, 0.5, 0.5, 0.6, 0, y, z);
      w.ball(GEAR.iron, 1.7, 0, 4, 3);
      for (const [x, y, z, r] of [[0, 2.2, 3, Math.PI], [0, 4, 4.8, HALF_PI], [1.8, 4, 3, 0], [-1.8, 4, 3, 0]] as const) w.cone(GEAR.steel, 0.5, 1.2, x, y, z, 4, x ? [0, 0, -Math.sign(x) * HALF_PI] : [r, 0, 0]);
      return { tilt: 0.3 };
    case "barometer_rod":
      shaft(GEAR.wood, 15, 2.4);
      for (const y of [10.1, 13.7]) w.cyl(GEAR.gold, 0.95, 0.95, 0.5, 0, y, 0, 6);
      w.glowBox("#8fd3ff", 0.9, 3.1, 0.9, 0, 11.9, 0);
      for (const s of [-1, 1]) w.box(GEAR.gold, 0.25, 3.2, 0.25, s * 0.75, 11.9, 0);
      w.ball(trim, 0.75, 0, 14.6, 0);
      return {};
    case "gaff_hook": {
      const hook = (p: Part) => {
        p.cyl(GEAR.wood, 0.42, 0.42, 4.6, 0, 1.2, 0, 6);
        p.cyl(trim, 0.6, 0.6, 0.6, 0, 3.2, 0, 6);
        p.box(GEAR.steel, 0.4, 2.2, 0.6, 0, 4.5, 0);
        p.box(GEAR.steel, 0.4, 0.6, 2.2, 0, 5.6, 0.8);
        p.box(GEAR.shine, 0.4, 1.7, 0.6, 0, 4.9, 1.8);
      };
      hook(w);
      if (!shield) hook(b.heldL);
      return { tilt: 0.5 };
    }
    case "coral_staff": {
      const coral = "#ff8f7a";
      shaft(GEAR.wood, 16, 2.8);
      w.box(coral, 0.8, 2.8, 0.8, -1, 12, 0, [0, 0, 0.4]);
      w.box(coral, 0.8, 3.4, 0.8, 1, 12.4, 0, [0, 0, -0.35]);
      w.box(tone(coral, 0.08), 0.6, 1.6, 0.6, 2, 14.2, 0, [0, 0, -0.9]);
      w.box(tone(coral, 0.08), 0.6, 1.4, 0.6, -2, 13.5, 0, [0, 0, 0.9]);
      w.glowBall(trim, 0.7, 0, 12.4, 0);
      return {};
    }
    case "ships_bell":
      w.box(GEAR.wood, 0.8, 1.8, 0.8, 0, -0.2, 0);
      w.cyl(GEAR.gold, 0.7, 2.1, 2.6, 0, -2.6, 0.2, 8);
      w.cyl("#b88a1e", 2.3, 2.3, 0.4, 0, -3.9, 0.2, 8);
      w.ball(trim, 0.55, 0, -4.4, 0.2);
      return { arm: -0.7 };
    case "astrolabe":
      w.cyl(GEAR.gold, 0.32, 0.32, 3, 0, 1, 0, 6);
      w.ring(GEAR.gold, 2, 0.3, 0, 4.8, 0);
      w.box(GEAR.gold, 3.6, 0.3, 0.3, 0, 4.8, 0);
      w.box(GEAR.gold, 0.3, 3.6, 0.3, 0, 4.8, 0);
      w.box(GEAR.steel, 0.3, 4.2, 0.36, 0, 4.8, 0.05, [0, 0, 0.7]);
      w.glowBall(trim, 0.6, 0, 4.8, 0.2);
      return { arm: -0.5 };
    case "lamp_hook":
      shaft(GEAR.wood, 14, 3.4);
      w.cyl(trim, 0.6, 0.6, 0.8, 0, 6, 0, 6);
      w.box(GEAR.steel, 0.4, 0.6, 2.6, 0, 10.6, 1.1);
      w.box(GEAR.steel, 0.4, 1.4, 0.5, 0, 10, 2.2);
      lantern(7.6, 2.2);
      return { tilt: 0.15 };
    case "bilge_chalice": {
      w.cyl(GEAR.gold, 0.36, 0.36, 2.4, 0, 1.2, 0, 6);
      w.cyl(GEAR.gold, 1.7, 0.8, 2.2, 0, 3.4, 0, 8);
      w.cyl(trim, 1.78, 1.78, 0.4, 0, 4.2, 0, 8);
      w.glowBox("#6dff9e", 2.2, 0.2, 2.2, 0, 4.55, 0);
      w.glowBox("#6dff9e", 0.4, 0.4, 0.4, 0.5, 6, 0.3);
      w.glowBox("#6dff9e", 0.4, 0.4, 0.4, -0.6, 7.2, -0.2);
      return { arm: -0.9 };
    }
  }
  return {};
}

/** A shield on the left forearm, held across the front. */
function drawShield(arm: Part, ref: string, icon: string, trim: string) {
  const turn: Rot = [0, 0.35, 0];
  if (lowPoly && !(ref === "buckler" || icon === "round-shield")) {
    lowKiteShield(arm, trim, turn);
    return;
  }
  if (ref === "buckler" || icon === "round-shield") {
    // A barrel lid: planks, an iron hoop and a boss.
    arm.cyl("#9a7448", 2.7, 2.7, 0.6, 0.5, -3.4, 1.9, 10, [HALF_PI, 0, 0.35]);
    arm.ring(GEAR.iron, 2.7, 0.36, 0.5, -3.4, 1.9, turn);
    arm.box("#6f5030", 0.3, 5, 0.2, 0.6, -3.4, 2.25, turn);
    arm.ball(trim, 0.85, 0.65, -3.4, 2.4);
    return;
  }
  // A tall shield, pointed at the foot.
  arm.box(GEAR.iron, 4.6, 5.2, 0.6, 0.5, -2.6, 1.9, turn);
  arm.box(GEAR.iron, 3.4, 1.2, 0.6, 0.5, -5.8, 1.9, turn);
  arm.box(GEAR.iron, 1.8, 1, 0.6, 0.5, -6.9, 1.9, turn);
  arm.box(GEAR.steel, 4.8, 0.8, 0.7, 0.5, -0.3, 1.9, turn);
  arm.box(trim, 3.2, 3.6, 0.3, 0.62, -2.7, 2.25, turn);
  arm.box(GEAR.gold, 1, 1, 0.3, 0.7, -2.5, 2.45, turn);
}

/**
 * A tall shield on the forearm, low-poly: a heater's shape, broad at the top and pointed at the foot, with a
 * steel rim, its face in the trim's colour and a gold boss, turned a little out from the body.
 */
function lowKiteShield(arm: Part, trim: string, turn: Rot) {
  const at = new THREE.Vector3(0.5, -2.9, 1.95);
  const outline: [number, number][] = [[-2.35, 2.65], [2.35, 2.65], [2.55, 0.4], [1.85, -2.3], [0, -4.2], [-1.85, -2.3], [-2.55, 0.4]];
  const plate = (scale: number, z0: number, z1: number): Pt[] => outline.flatMap(([x, y]): Pt[] => [[x * scale, y * scale, z0], [x * scale, y * scale, z1]]);
  arm.shape(GEAR.steel, plate(1, -0.32, 0.18), at.x, at.y, at.z, turn);
  arm.shape(GEAR.iron, plate(0.86, 0.1, 0.32), at.x, at.y, at.z, turn);
  arm.shape(trim, plate(0.6, 0.25, 0.42), at.x, at.y + 0.25, at.z, turn);
  const boss = new THREE.Vector3(0, 0.55, 0.55).applyEuler(new THREE.Euler(...turn)).add(at);
  arm.ball(GEAR.gold, 0.7, boss.x, boss.y, boss.z, 1);
}

/**
 * A person: a class in its own clothes, a townsperson, or an enemy. With an
 * `outfit`, a hero wearing what they have equipped: helmet or hood on the
 * head (the class's own hat shows until one is worn), armor on the chest,
 * arms and legs, boots, a ring and an amulet, the weapon in the right hand
 * and a shield on the left arm.
 */
function person(top: THREE.Group, look: Look, outfit: Outfit | undefined, asleep: boolean): Rig {
  const parts: Part[] = [];
  const b = biped(top, parts);
  const trim = (slot: Slot) => RARITY_COLOR[outfit![slot]!.rarity];
  const { torso, head, armL, armR } = b;
  // Starting clothes are items like any other (garb, gear.ts): worn, they are the class's own look; taken off
  // a hero who chose how they look, what is under them shows. Anything else in a slot is armor.
  const garb = (slot: Slot) => !!outfit?.[slot]?.ref.startsWith(GARB_PREFIX);
  const bare = (slot: Slot) => !!chosen && !outfit?.[slot];
  const armor = (slot: Slot) => (garb(slot) ? undefined : outfit?.[slot]);

  // Legs and feet.
  const legs = armor("legs");
  const boots = armor("boots");
  const sides = [
    [b.legR, b.thighR, b.shinR, b.footR],
    [b.legL, b.thighL, b.shinL, b.footL],
  ] as const;
  for (const [leg, thigh, shin, foot] of sides) {
    if (lowPoly && !legs) {
      if (bare("legs")) {
        lowBareLeg(thigh, shin, look.skin);
        if (chosen?.ink) {
          const right = thigh === b.thighR;
          inkPart(thigh, right ? "thighR" : "thighL", chosen.ink, look.skin);
          inkPart(shin, right ? "shinR" : "shinL", chosen.ink, look.skin);
        }
      }
      else lowLeg(thigh, shin, look.legs);
    }
    else if (lowPoly && legs) lowLegArmor(thigh, shin, legs.ref, trim("legs"));
    else if (legs?.ref === "trousers") {
      // Sailcloth: pale, loose, tied at the shin.
      const cloth = "#d8cfb4";
      leg.box(cloth, 3, 4.4, 3.1, 0, -2.2, 0);
      leg.box(tone(cloth, -0.1), 1, 1.2, 0.3, 0.4, -2.4, 1.6);
      leg.box(trim("legs"), 3.15, 0.6, 3.25, 0, -3.9, 0);
      leg.box(look.legs, 2.2, 0.8, 2.4, 0, -4.4, 0);
    } else if (legs) {
      // Greaves: plate over the thigh, the knee and the shin.
      leg.box(GEAR.iron, 2.6, 5, 2.8, 0, -2.5, 0);
      leg.box(GEAR.steel, 2.8, 1.3, 0.7, 0, -1.9, 1.3);
      leg.box(GEAR.steel, 2.2, 1.7, 0.5, 0, -3.6, 1.35);
      leg.box(trim("legs"), 2.8, 0.6, 3, 0, -0.5, 0);
    } else {
      leg.box(look.legs, 2.4, 5, 2.6, 0, -2.5, 0);
    }
    if (lowPoly && !boots) {
      if (bare("boots")) lowBareFoot(foot, look.skin);
      else lowShoe(foot, GEAR.dark);
    }
    else if (lowPoly && boots) lowBoots(foot, shin, boots.ref, trim("boots"));
    else if (boots?.ref === "treads") {
      // Short and iron-shod.
      leg.box("#5a4632", 2.9, 1.8, 3.2, 0, -4, 0.1);
      leg.box("#5a4632", 2.9, 1.1, 1.3, 0, -4.35, 2);
      leg.box(GEAR.iron, 3.1, 0.7, 4.7, 0, -4.8, 0.6);
      leg.box(trim("boots"), 3, 0.5, 3.3, 0, -3.1, 0.1);
    } else if (boots) {
      // Tall sea boots, turned down at the top.
      leg.box(GEAR.leather, 2.9, 2.7, 3.2, 0, -3.6, 0.1);
      leg.box(GEAR.leather, 2.9, 1.2, 1.3, 0, -4.35, 2);
      leg.box(tone(GEAR.leather, 0.08), 3.2, 0.8, 3.5, 0, -2.2, 0.1);
      leg.box(trim("boots"), 3.25, 0.4, 3.55, 0, -2.8, 0.1);
      leg.box(GEAR.dark, 3, 0.4, 4.5, 0, -4.95, 0.6);
    } else {
      leg.box(GEAR.dark, 2.6, 1.2, 3.5, 0, -4.4, 0.4);
    }
  }

  // Chest, belt and coat-tails.
  const body = armor("body");
  const undressed = bare("body");
  const greatcoat = body?.ref === "greatcoat";
  const oilskin = "#b1933c";
  const cloth = greatcoat ? oilskin : body ? GEAR.iron : look.body;
  let front = 1.95;
  if (!lowPoly) torso.box(look.skin, 2.6, 0.8, 2.6, 0, 6.1, 0);
  // The torso is as stout as chosen (box armor is as broad as the shoulders it sits on).
  torso.skin.scale.set(lowPoly ? m.girth : m.shoulders, 1, m.girth);
  if (lowPoly && !greatcoat && !body) {
    if (undressed) lowUndershirt(torso, look.skin, m.shoulders / m.girth);
    else lowTorso(torso, look, m.shoulders / m.girth);
  } else if (lowPoly && greatcoat) {
    front = lowGreatcoat(torso, look.skin, oilskin, m.shoulders / m.girth, trim("body"));
  } else if (lowPoly && body) {
    front = lowHauberk(torso, look.skin, m.shoulders / m.girth, trim("body"));
  } else if (greatcoat) {
    torso.box(oilskin, 7.2, 6, 4, 0, 3, 0);
    torso.box(tone(oilskin, -0.1), 7.5, 1.2, 4.5, 0, 5.6, -0.2);
    for (const s of [-1, 1]) torso.box(tone(oilskin, 0.08), 1.3, 3.2, 0.3, s * 1.3, 3.9, 2.1);
    for (const y of [1.9, 3.1, 4.3]) torso.box(GEAR.gold, 0.6, 0.6, 0.3, 0, y, 2.15);
    torso.box(GEAR.dark, 7.4, 0.9, 4.2, 0, 1, 0);
    torso.box(trim("body"), 1.2, 1.1, 0.4, 0, 1, 2.2);
    front = 2.2;
  } else if (body) {
    // A hauberk: mail, with a breastplate over it and a gold belt.
    torso.box(GEAR.iron, 7, 6, 3.8, 0, 3, 0);
    torso.box(GEAR.steel, 5.6, 3.4, 0.6, 0, 4, 1.9);
    torso.box(GEAR.steel, 5.6, 3.4, 0.5, 0, 4, -1.9);
    torso.box(trim("body"), 1.4, 1.4, 0.5, 0, 4.2, 2.3);
    torso.box(tone(GEAR.iron, -0.1), 7.3, 1.4, 4.1, 0, 0.1, 0);
    torso.box(GEAR.gold, 7.4, 0.9, 4.2, 0, 1.3, 0);
    front = 2.3;
  } else {
    torso.box(look.body, 7, 6, 3.8, 0, 3, 0);
    torso.box(tone(look.body, 0.07), 1, 3.6, 0.2, 0, 3.9, 1.95);
    torso.box(tone(look.body, -0.07), 7.2, 1, 4, 0, 0.3, 0);
    torso.box(look.accent, 7.3, 1, 4.1, 0, 1.3, 0);
    torso.box(GEAR.gold, 1.2, 1, 0.3, 0, 1.3, 2.15);
  }
  if (greatcoat || (look.coat && !body && !undressed)) {
    // A long coat, open at the front, down over the legs.
    const edgeColor = greatcoat ? trim("body") : look.accent;
    if (lowPoly) {
      for (const s of [-1, 1]) {
        coatPanel(torso, cloth, s, 0.42, Math.PI + 0.05);
        coatPanel(torso, edgeColor, s, 0.38, 0.52, 0.06);
      }
    } else {
      for (const s of [-1, 1]) {
        torso.box(cloth, 2.7, 4.6, 4.3, s * 2.4, -2, 0);
        torso.box(edgeColor, 0.5, 4.6, 0.4, s * 1.25, -2, 2.05);
      }
      torso.box(cloth, 7.3, 4.6, 1, 0, -2, -1.7);
    }
  }
  const amulet = outfit?.amulet;
  if (amulet) {
    torso.box(GEAR.gold, 3.4, 0.4, 0.3, 0, 5.3, front + 0.1);
    if (amulet.ref === "keystone") {
      // A key on its cord.
      torso.box(GEAR.gold, 0.5, 1.9, 0.3, 0, 4.2, front + 0.15);
      torso.box(GEAR.gold, 1, 0.4, 0.3, 0.4, 3.5, front + 0.15);
      torso.box(trim("amulet"), 1.1, 0.9, 0.35, 0, 5, front + 0.2);
    } else if (amulet.ref === "badge") {
      // A badge pinned over the heart.
      torso.box(trim("amulet"), 1.5, 1.5, 0.35, 1.8, 4.3, front + 0.15, [0, 0, Math.PI / 4]);
      torso.box(GEAR.gold, 0.7, 0.7, 0.4, 1.8, 4.3, front + 0.25);
    } else {
      torso.box(trim("amulet"), 1.1, 1.1, 0.4, 0, 4.5, front + 0.2);
    }
  }

  // Arms and hands.
  // A hero with ink on either arm wears the tunic with both sleeves rolled up.
  const inkedArms = !!chosen?.ink && (["armR.f", "armR.b", "armL.f", "armL.b"] as const).some((side) => !!chosen?.ink?.[side]);
  for (const [arm, s] of [[armR, -1], [armL, 1]] as const) {
    if (lowPoly) {
      lowHand(arm, look.skin, s);
      if (!greatcoat && !body) {
        const region = s < 0 ? "armR" : "armL";
        if (undressed) {
          lowBareArm(arm, look.skin);
          if (chosen?.ink) inkPart(arm, region, chosen.ink, look.skin);
        } else if (inkedArms) {
          // Sleeves rolled up, to show off the ink on the forearms.
          lowRolledSleeve(arm, look.skin, cloth);
          inkPart(arm, region, chosen!.ink!, look.skin);
        } else lowSleeve(arm, cloth, look.accent);
        continue;
      }
      if (greatcoat) {
        // Oilskin sleeves, cuffed in the coat's trim.
        lowSleeve(arm, oilskin, trim("body"));
      } else {
        // Mail sleeves, a steel pauldron over the shoulder edged in the trim, and a steel vambrace.
        lowSleeve(arm, GEAR.iron, GEAR.steel);
        arm.ball(GEAR.steel, 1.55, s * 0.25, 0.35, 0, 0, [1.05, 0.72, 1.15]);
        arm.loft(trim("body"), [[-0.75, 1.5, 1.5], [-0.45, 1.5, 1.5]], 8, s * 0.2);
        arm.loft(GEAR.steel, [[-3.75, 1.12, 1.12], [-2.75, 1.18, 1.18]], 8);
      }
      continue;
    } else {
      arm.box(cloth, 2, 4.6, 2.4, 0, -2.1, 0);
      arm.box(look.skin, 1.8, 1.5, 2, 0, -5, 0);
    }
    if (greatcoat) {
      arm.box(trim("body"), 2.3, 0.8, 2.7, 0, -3.9, 0);
      arm.box(tone(oilskin, -0.1), 2.6, 1, 3, s * 0.1, 0.1, 0);
    } else if (body) {
      arm.box(GEAR.steel, 2.9, 1.5, 3.3, s * 0.2, 0.2, 0);
      arm.box(trim("body"), 3, 0.4, 3.4, s * 0.2, -0.7, 0);
      arm.box(GEAR.steel, 2.3, 1.5, 2.7, 0, -3.5, 0);
    } else {
      arm.box(look.accent, 2.2, 0.7, 2.6, 0, -4, 0);
    }
  }
  const ring = outfit?.ring;
  if (ring?.ref === "bands" && lowPoly) {
    for (const arm of [armR, armL]) arm.loft(trim("ring"), [[-4.45, 1.05, 1.05], [-3.95, 1.08, 1.08]], 8);
  } else if (ring?.ref === "bands") {
    for (const arm of [armR, armL]) arm.box(trim("ring"), 2.4, 0.6, 2.8, 0, -4.2, 0);
  } else if (ring) {
    armR.box(GEAR.gold, 2, 0.4, 2.2, 0, -5.1, 0);
    armR.box(trim("ring"), 0.7, 0.7, 0.5, 0, -5.1, 1.2);
  }

  // Head.
  if (lowPoly) {
    head.joint.scale.setScalar(BIG_HEAD * m.head);
    // Something on the head: worn headgear, or the class's own hat on a figure that has no choice in it.
    const hatted = !!outfit?.helmet || (!chosen && look.hat !== "none");
    lowHead(head, look, asleep, hatted);
  } else drawHead(head, look, asleep);
  const helmet = armor("helmet");
  if (lowPoly && helmet) {
    lowWornHelmet(head, helmet, trim("helmet"));
  } else if (helmet?.ref === "hood" || helmet?.icon === "hood") {
    drawHood(head, GEAR.leather, trim("helmet"));
  } else if (helmet?.ref === "visor" || helmet?.icon === "brutal-helm") {
    // Horned iron, a dark visor, one eye alight and a spyglass over the other.
    head.box(GEAR.iron, 7.1, 3.6, 6.7, 0, 5, 0);
    for (const s of [-1, 1]) {
      head.cone(GEAR.bone, 0.85, 3, s * 4, 6.6, 0, 5, [0, 0, -s * 0.5]);
      head.box(GEAR.iron, 0.8, 2.8, 3.2, s * 3.4, 1.9, 1.1);
    }
    head.box(GEAR.dark, 6.7, 1.5, 0.6, 0, 2.9, 3);
    head.glowBox(trim("helmet"), 1, 0.6, 0.3, 1.5, 2.9, 3.4);
    head.cyl(GEAR.gold, 0.75, 0.6, 1.8, -1.5, 2.9, 3.9, 6, [HALF_PI, 0, 0]);
    head.glowBox(trim("helmet"), 0.7, 0.7, 0.2, -1.5, 2.9, 4.85);
  } else if (helmet) {
    // A diving helm: a steel dome with a crest, cheek plates and a nasal.
    head.box(GEAR.steel, 7.1, 3.4, 6.7, 0, 5.2, 0);
    head.box(GEAR.shine, 5.4, 0.8, 5.2, 0, 7.2, 0);
    head.box(GEAR.gold, 7.2, 0.6, 6.8, 0, 3.9, 0);
    for (const s of [-1, 1]) {
      head.box(GEAR.steel, 0.8, 3.2, 3.6, s * 3.45, 2.3, 0.6);
      head.box(GEAR.gold, 0.6, 0.6, 0.3, s * 2.5, 5.4, 3.4);
    }
    head.box(GEAR.steel, 0.9, 2.4, 0.5, 0, 3.2, 3.2);
    head.box(GEAR.steel, 7.1, 2.6, 1, 0, 2.6, -3);
    head.box(trim("helmet"), 1.2, 1.6, 5.2, 0, 8.2, -0.2);
  } else if (!bare("helmet")) {
    // No helmet equipped: the class keeps its own hat (a hero who chose their look wears it as an item).
    if (lowPoly) lowHat(head, look);
    else drawHat(head, look);
  }

  // Hands: a hero's weapon (signature weapons that have no shape of their own are drawn as the one they are like).
  const shield = outfit?.off_hand;
  if (shield) drawShield(armL, shield.ref, shield.icon, trim("off_hand"));
  if (rodInHand) {
    // A townsperson, or a hero with nothing in hand, has no trim for it: the look's accent instead.
    apply(b, drawHeld("rod", b, outfit?.main_hand ? trim("main_hand") : look.accent, look, !!shield));
  } else if (outfit) {
    const held = outfit.main_hand;
    if (held) {
      apply(b, drawHeld(held.ref, b, trim("main_hand"), look, !!shield));
      const like = WEAPONS[held.ref]?.looksLike;
      if (b.heldR.empty && like) apply(b, drawHeld(like, b, trim("main_hand"), look, !!shield));
    }
  } else if (look.weapon !== "none") {
    apply(b, drawHeld(look.weapon, b, look.accent, look, false));
  }
  if (shield || look.weapon === "axe_shield") b.rest.armL = -0.55;
  return { parts, animate: b.animate };
}

/** A lute in its own part's frame: the belly at the origin facing +z, the neck up +y. */
function drawLute(p: Part, trim: string) {
  p.ball(GEAR.leather, 2.3, 0, 0, 0, 1, [1, 1.2, 0.5]);
  p.ball(tone(GEAR.leather, 0.08), 2.1, 0, 0.05, 0.2, 1, [0.92, 1.1, 0.42]);
  p.cyl(GEAR.dark, 0.7, 0.7, 0.2, 0, 0.5, 1.05, 10, [HALF_PI, 0, 0]);
  p.box(GEAR.wood, 0.75, 5.6, 0.55, 0, 4.6, 0.3);
  p.box(trim, 1.2, 1.3, 0.8, 0, 7.7, 0.1, [-0.3, 0, 0]);
  p.box(GEAR.paper, 0.35, 7.4, 0.1, 0, 3, 1.15);
}

/** How far forward each arm comes (radians) to play a lute across the body, and to hold a flute across the chest. */
const LUTE_ARMS = { right: -0.5, left: -1.35 };
const FLUTE_ARMS = { right: -0.9, left: -1.2 };

/** A flute in its own part's frame: a pipe up +y from just below the grip at the origin to past `span`, finger holes to the front. */
function drawFlute(p: Part, trim: string, span: number) {
  p.cyl(GEAR.paper, 0.38, 0.38, span + 1.6, 0, span / 2, 0, 8);
  for (const t of [0.3, 0.45, 0.6]) p.box(GEAR.dark, 0.3, 0.4, 0.3, 0, span * t, 0.3);
  p.cyl(trim, 0.5, 0.5, 0.8, 0, span + 0.4, 0, 8);
}

/** Where a hand is, in the torso's frame, its arm (on side `side`, -1 right) turned `forward` and `out` as the biped turns it. */
function handAt(side: number, forward: number, out: number): THREE.Vector3 {
  const shoulderX = 4.05 * m.shoulders + 0.45;
  return new THREE.Vector3(0, -5.1, 0).applyEuler(new THREE.Euler(forward, 0, out)).add(new THREE.Vector3(side * shoulderX, 5.5, 0));
}

/** Set a joint at `at`, its +y along `dir` and its +z as near the front (+z) as that allows. */
function layAlong(joint: THREE.Object3D, at: THREE.Vector3, dir: THREE.Vector3) {
  const y = dir.clone().normalize();
  const z = new THREE.Vector3(0, 0, 1).addScaledVector(y, -y.z).normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  joint.position.copy(at);
  joint.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/** An instrument played in front and slung behind (see stow): its two parts, and the arms it is played with. */
function sling(b: Biped, front: Part, back: Part, arms: { right: number; left: number }) {
  extraParts.push(front, back);
  slung = {
    front,
    back,
    rest: b.rest,
    arms,
    stowed: false,
    since: 0,
    p: 0,
    home: { pos: back.joint.position.clone(), quat: back.joint.quaternion.clone() },
    held: null,
  };
  b.rest.armL = arms.left;
  return { arm: arms.right };
}

/**
 * An instrument carried two ways: in the hands, played across the body, while standing (or fighting), and
 * slung on the back while walking, the arms free to swing. Set by drawHeld for the figure being built.
 */
interface Slung {
  front: Part;
  back: Part;
  rest: Biped["rest"];
  /** How far forward each arm comes to play it. */
  arms: { right: number; left: number };
  /** Where it should be: on the back (or in the hands). */
  stowed: boolean;
  /** How long the hero has been doing the other thing, to swap only once they keep at it. */
  since: number;
  /** Where it is: 0 in the hands, 1 on the back, between while it swings round. */
  p: number;
  /** The slung lute's own place on the back, in the torso's frame. */
  home: { pos: THREE.Vector3; quat: THREE.Quaternion };
  /** Where the lute in the hands was last seen, in the torso's frame: where a swing to the back starts. */
  held: { pos: THREE.Vector3; quat: THREE.Quaternion } | null;
}
let slung: Slung | null = null;

/** How long the lute takes to swing round from the hands to the back, or back again, in seconds. */
const SWING_ROUND = 0.45;
const scratch = { m: new THREE.Matrix4(), scale: new THREE.Vector3(), sweep: new THREE.Quaternion(), up: new THREE.Vector3(0, 1, 0) };

/**
 * Sling it on the back once they have walked a moment, and bring it round again once they stop (or strike).
 * In between it swings round the right side of the body: the slung lute starts where the one in the hands
 * is, goes round the hip in an arc, a little up and out as it passes, turning as it goes, and settles on the
 * back; the arms ease from playing to swinging free (or back) with it.
 */
function stow(s: Slung, walking: boolean, strike: number, dt: number) {
  const want = walking && strike < 0.05;
  if (want === s.stowed) s.since = 0;
  else {
    s.since += dt;
    if (s.since > (want ? 0.15 : 0.35)) {
      s.stowed = want;
      s.since = 0;
    }
  }
  const torso = s.back.joint.parent;
  // While it is held, keep track of where it is against the torso (from the frame just drawn).
  if (s.p === 0 && torso) {
    scratch.m.copy(torso.matrixWorld).invert().multiply(s.front.joint.matrixWorld);
    const held = s.held ?? { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
    scratch.m.decompose(held.pos, held.quat, scratch.scale);
    // Before anything has been drawn there is nothing to go by.
    s.held = held.pos.lengthSq() > 0.01 ? held : null;
  }
  const goal = s.stowed ? 1 : 0;
  // A swing needs somewhere to start from; with none (a portrait, the first frame) it just goes there.
  if (!s.held) s.p = goal;
  else if (s.p < goal) s.p = Math.min(goal, s.p + dt / SWING_ROUND);
  else if (s.p > goal) s.p = Math.max(goal, s.p - dt / SWING_ROUND);
  const e = s.p * s.p * (3 - 2 * s.p);

  s.front.joint.visible = s.p === 0;
  s.back.joint.visible = s.p > 0;
  const { pos, quat } = s.home;
  if (s.p === 0 || s.p === 1 || !s.held) {
    s.back.joint.position.copy(pos);
    s.back.joint.quaternion.copy(quat);
  } else {
    const from = s.held;
    // Round the right side (toward -x): the angle about the body falls from the front to the back.
    const a0 = Math.atan2(from.pos.x, from.pos.z);
    let a1 = Math.atan2(pos.x, pos.z);
    if (a1 > a0) a1 -= Math.PI * 2;
    const lift = Math.sin(Math.PI * e);
    const a = a0 + (a1 - a0) * e;
    const r = Math.hypot(from.pos.x, from.pos.z) * (1 - e) + Math.hypot(pos.x, pos.z) * e + lift * 0.9;
    s.back.joint.position.set(Math.sin(a) * r, from.pos.y + (pos.y - from.pos.y) * e + lift * 1.4, Math.cos(a) * r);
    // Turned with the sweep round the body, and eased into its own lie on the back.
    scratch.sweep.setFromAxisAngle(scratch.up, a - a0);
    s.back.joint.quaternion.copy(scratch.sweep).multiply(from.quat).slerp(quat, e);
  }
  s.rest.armL = s.arms.left + (-0.05 - s.arms.left) * e;
  s.rest.armR = s.arms.right + (-0.35 - s.arms.right) * e;
}

function apply(b: Biped, pose: { arm?: number; tilt?: number }) {
  b.rest.armR = pose.arm ?? -0.35;
  b.rest.tiltR = pose.tilt ?? 0;
}

/** One of the smugglers' dead: a skeleton with a rusted cutlass and a scrap of its old bandana. */
function skeleton(top: THREE.Group): Rig {
  const parts: Part[] = [];
  const b = biped(top, parts);
  const bone = "#e8e2d0";
  const dim = "#c9c1aa";
  const rag = "#8a3b2f";
  for (const [thigh, shin, foot] of [[b.thighR, b.shinR, b.footR], [b.thighL, b.shinL, b.footL]]) {
    // A thigh bone from a round head at the hip, a kneecap, a shin bone, and a long bony foot.
    thigh.loft(bone, [[0.55, 0.5, 0.5], [0.15, 0.72, 0.72], [-0.5, 0.48, 0.48], [-1.9, 0.4, 0.4], [-2.55, 0.62, 0.6]], 6);
    shin.ball(dim, 0.72, 0, -0.05, 0.15);
    shin.loft(bone, [[-0.15, 0.58, 0.56], [-0.8, 0.4, 0.4], [-2, 0.36, 0.36], [-2.45, 0.52, 0.52]], 6);
    foot.shape(bone, sym([[0.6, 0, -0.85], [0.72, 0, 1], [0.45, 0, 2.05], [0, 0, 2.2], [0.48, 0.55, -0.7], [0.42, 0.42, 1], [0, 0.48, 1.9], [0, 0.85, -0.5]]));
  }
  const t = b.torso;
  // The pelvis, a bowl wider at its rim; the spine up the back, a knuckle of bone at each vertebra.
  t.loft(dim, [[-0.3, 1.5, 0.95, 0.05], [0.45, 2.3, 1.25], [1.4, 2.65, 1.35, -0.1]], 8);
  const spine: Ring[] = [];
  for (let i = 0, y = 1.1; y <= 6.9; i++, y += 0.48) spine.push([y, i % 2 ? 0.66 : 0.46, i % 2 ? 0.62 : 0.44]);
  t.loft(bone, spine, 6, 0, 0, -0.6);
  // Three ribs a side, sweeping round from the spine and down to the breastbone.
  ([[2.4, 2.35], [3.6, 2.65], [4.8, 2.75]] as const).forEach(([y, w]) => {
    for (const s of [-1, 1]) {
      const at = (k: number): Pt => {
        const a = Math.PI * (1 - k);
        return [s * Math.sin(a) * w, y - 0.55 * k, Math.cos(a) * 1.35 + 0.2];
      };
      const steps = [0, 0.25, 0.5, 0.75, 0.93];
      for (let i = 0; i + 1 < steps.length; i++) strut(t, dim, at(steps[i]), at(steps[i + 1]), 0.3, 0.3, 5);
    }
  });
  strut(t, bone, [0, 1.75, 1.5], [0, 5.3, 1.6], 0.4, 0.5);
  // Collarbones out to the round of each shoulder.
  strut(t, bone, [-3.9, 5.75, 0.15], [3.9, 5.75, 0.15], 0.42);
  for (const s of [-1, 1]) t.ball(bone, 0.78, s * 4.3, 5.6, 0, 1);
  for (const arm of [b.armR, b.armL]) {
    arm.loft(bone, [[0.4, 0.52, 0.52], [0, 0.58, 0.58], [-0.6, 0.4, 0.4], [-1.9, 0.36, 0.36], [-2.3, 0.52, 0.52]], 6);
    arm.ball(dim, 0.62, 0, -2.35, -0.05);
    arm.loft(bone, [[-2.4, 0.46, 0.46], [-3.2, 0.34, 0.34], [-4.2, 0.38, 0.4], [-4.5, 0.48, 0.48]], 6);
    // A bony hand: a narrow palm and the fingers curled under it.
    arm.shape(bone, sym([[0.5, -4.35, 0.45], [0.5, -4.35, -0.35], [0.62, -5.2, 0.7], [0.55, -5.4, -0.4], [0.3, -5.95, 0.35], [0, -6, 0.85], [0, -5.7, -0.45]]));
  }
  // The skull, round over a narrower jaw, hollow eyes and a nose hole.
  const h = b.head;
  const skull: Ring[] = [[1.5, 2.25, 2.1, 0.55], [2.3, 2.85, 2.65, 0.3], [3.5, 3.1, 2.9, 0], [4.9, 3.05, 2.85, -0.1], [5.8, 2.45, 2.35, -0.15], [6.3, 1, 1, -0.15]];
  h.loft(bone, skull, 10);
  h.loft(dim, [[0.05, 1.45, 1.15, 0.95], [0.55, 1.9, 1.5, 0.85], [1.65, 2.15, 1.85, 0.6]], 8);
  for (const s of [-1, 1]) h.ball(OUTLINE, 1, s * 1.3, 3.45, 2.55, 1, [0.82, 0.92, 0.5]);
  h.shape(OUTLINE, sym([[0.42, 2.55, 2.2], [0.42, 2.55, 2.95], [0, 1.75, 2.2], [0, 1.75, 2.95]]));
  for (const x of [-1.2, -0.4, 0.4, 1.2]) h.shape(bone, [[x - 0.26, 1.55, 1.9], [x + 0.26, 1.55, 1.9], [x - 0.22, 1.55, 2.45 - Math.abs(x) * 0.18], [x + 0.22, 1.55, 2.45 - Math.abs(x) * 0.18], [x, 0.75, 2.25 - Math.abs(x) * 0.18]]);
  // The bandana tied over its crown, a tail of it hanging behind.
  h.loft(rag, [[4.55, 3.2, 3, -0.1], [5.1, 3.18, 2.98, -0.11], [5.85, 2.6, 2.5, -0.15], [6.45, 1.15, 1.15, -0.15]], 10);
  h.ball(rag, 0.6, 1.9, 5.05, -2.75, 0);
  h.shape(rag, [[1.55, 5.1, -2.7], [2.35, 5.1, -2.65], [2.65, 2.7, -3.15], [3.3, 2.95, -3], [2.2, 4.3, -3.2]]);
  // A rusted cutlass: a wrapped grip, a knuckle guard, and a broad blade curving forward to its point.
  const w = b.heldR;
  const wood = "#6b4a2b";
  const rust = "#a3896a";
  w.loft(wood, [[-0.7, 0.36, 0.36], [1.1, 0.42, 0.42]], 6);
  w.ball(wood, 0.5, 0, -0.85, 0);
  w.shape(wood, sym([[1.4, 1.15, 0.65], [1.4, 1.5, 0.65], [1.4, 1.15, -0.2], [1.4, 1.5, -0.2], [0.5, 1.0, 0.85], [0.5, 1.65, 0.85], [0.5, 1.0, -0.45], [0.5, 1.65, -0.45]]));
  w.shape(rust, sym([[0.5, 1.5, 0.14], [0.5, 1.5, -0.14], [0.6, 6.3, 0.32], [0.6, 6.3, 0.02]]));
  w.shape(rust, [...sym([[0.6, 6.1, 0.32], [0.6, 6.1, 0.02], [0.42, 8, 0.82], [0.42, 8, 0.52]]), [0, 9.05, 1.35], [0, 9, 1.08]]);
  b.rest.armR = -0.35;
  b.rest.tiltR = 0.55;
  return { parts, animate: b.animate };
}

// ---------- creatures ----------

/** Rings for a loft lying along z, nose toward +z: each its z, half-width, half-height, and how high its middle is. */
type Span = readonly [z: number, rx: number, ry: number, up?: number];

/**
 * A faceted tube lying along z through `spans` (see Span): a body, a snout, a tail. Its flat faces are under
 * and over it and to each side. `pitch` tips its +z end up (and its -z end down), from (x, y, z).
 */
function lengthwise(part: Part, color: string, spans: readonly Span[], sides = 8, x = 0, y = 0, z = 0, pitch = 0) {
  part.loft(color, spans.map(([sz, rx, ry, up = 0]): Ring => [sz, rx, ry, -up]), sides, x, y, z, [HALF_PI - pitch, 0, 0]);
}

/**
 * A hide of fur over part of a lengthwise loft: between `z0` and `z1`, round it from angle `a0` to `a1`
 * (radians from straight up, toward +x), `by` outside it. A dark stripe down a back, a pale belly, frost.
 */
function pelt(part: Part, color: string, spans: readonly Span[], z0: number, z1: number, a0: number, a1: number, by = 0.14) {
  const pts: Pt[] = [];
  for (let i = 0; i <= 4; i++) {
    const z = z0 + ((z1 - z0) * i) / 4;
    const r = ringAt(spans as readonly Ring[], z);
    for (let j = 0; j <= 4; j++) {
      const a = a0 + ((a1 - a0) * j) / 4;
      pts.push([Math.sin(a) * (r.rx + by), r.dz + Math.cos(a) * (r.rz + by), z]);
    }
  }
  part.shape(color, pts);
}

/** A tapered, faceted rod from `a` to `b`: a bone, a post, a crossbar. */
function strut(part: Part, color: string, a: Pt, b: Pt, ra: number, rb = ra, sides = 6) {
  const along = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = along.length();
  const turn = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), along.normalize()));
  part.loft(color, [[0, ra, ra], [len, rb, rb]], sides, a[0], a[1], a[2], [turn.x, turn.y, turn.z]);
}

/** A flat pill `rx` by `ry` and `depth` thick, facing +z before `rot`: a shine, a stitched mouth. */
function spot(part: Part, color: string, rx: number, ry: number, depth: number, x: number, y: number, z: number, rot?: Rot) {
  const pts: Pt[] = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    for (const d of [-depth / 2, depth / 2]) pts.push([Math.cos(a) * rx, Math.sin(a) * ry, d]);
  }
  part.shape(color, pts, x, y, z, rot);
}

/**
 * The four-legged gait a wolf and a bear share. `across` is half the body's width, `tall` the back's height,
 * and `stoop` how far (radians) the head is carried nose-down: a wolf's, low and growling.
 */
function fourLegs(top: THREE.Group, legs: Part[], head: Part, tail: Part | null, across: number, tall: number, stoop = 0) {
  return (a: Anim) => {
    if (a.lying) {
      // On its side.
      top.rotation.set(0, 0, HALF_PI);
      top.position.set(tall * 0.55, across, 0);
      for (const leg of legs) leg.joint.rotation.x = 0;
      head.joint.rotation.set(0, 0, 0);
      return;
    }
    top.rotation.set(-a.strike * 0.3, 0, 0);
    top.position.set(0, (a.breath + 1) * 0.06 + a.strike * 1.2, 0);
    legs.forEach((leg, i) => (leg.joint.rotation.x = (i === 0 || i === 3 ? 1 : -1) * a.swing * 0.7));
    head.joint.rotation.set(stoop + a.breath * 0.04 + a.strike * 0.35, 0, 0);
    if (tail) tail.joint.rotation.y = Math.sin(a.t * 3.1) * 0.3;
  };
}

/** A wolf, nose toward +z. The pack leader is the same animal, darker, with a red eye. */
function wolf(top: THREE.Group, fur = "#7d8793", dark = "#59616c", eye = "#ffd23f"): Rig {
  const parts: Part[] = [];
  const part = (parent: THREE.Object3D, x: number, y: number, z: number) => (parts[parts.length] = new Part(parent, x, y, z));
  const body = part(top, 0, 0, 0);
  // Lean hips, a tucked belly and a deep chest, a ruff of paler fur at the shoulders; dark down the back and under.
  const trunk: Span[] = [[-5.1, 1.2, 1.2, 6.9], [-4.4, 1.95, 1.85, 6.6], [-2.6, 2, 1.7, 6.6], [-0.6, 2.1, 1.95, 6.45], [1.6, 2.4, 2.35, 6.4], [3.4, 2.35, 2.3, 6.55], [4.5, 1.5, 1.6, 6.8]];
  const ruff: Span[] = [[0.9, 2.3, 2.25, 6.5], [2.3, 2.7, 2.6, 6.6], [3.9, 2.6, 2.5, 6.85], [4.9, 1.8, 1.9, 7.2]];
  lengthwise(body, fur, trunk);
  lengthwise(body, tone(fur, 0.05), ruff);
  pelt(body, dark, trunk, -4.3, 1.2, -0.7, 0.7, 0.12);
  pelt(body, dark, trunk, -3.2, 1.2, Math.PI - 0.7, Math.PI + 0.7, 0.1);
  // The hackles up, a crest of spiky fur from the nape back over the shoulders, tallest at the withers.
  for (let i = 0; i < 9; i++) {
    const z = 4.6 - i * 0.75;
    const r = ringAt((z > 0.9 ? ruff : trunk) as readonly Ring[], z);
    const rise = Math.max(0.7, 2.3 - Math.abs(z - 2.2) * 0.42);
    for (const s of i % 2 ? [-1, 1] : [0]) {
      const x = s * 0.7;
      const y = r.dz + r.rz - 0.4 - Math.abs(x) * 0.35;
      body.shape(i % 2 ? dark : tone(fur, 0.05), [[x - 0.65, y, z + 0.6], [x + 0.65, y, z + 0.6], [x, y, z - 0.6], [x + s * 0.45, y + rise, z - 0.75]]);
    }
  }
  // Head down, snarling (see fourLegs' stoop).
  const head = part(top, 0, 7.7, 4.4);
  // A long skull, a dark tapering snout with a black nose, ears pinned back, bright eyes, and bared fangs.
  lengthwise(head, fur, [[-0.6, 1.6, 1.6, 1], [0.5, 2.25, 2.1, 0.95], [1.9, 2.25, 1.95, 0.85], [3, 1.7, 1.5, 0.55], [3.5, 1, 0.95, 0.35]]);
  lengthwise(head, dark, [[2.3, 1.3, 1.1, 0.2], [4, 1.08, 0.9, 0.05], [5.15, 0.8, 0.65, -0.05], [5.5, 0.45, 0.42, -0.05]]);
  head.ball(OUTLINE, 0.5, 0, 0.5, 5.4, 0, [1.15, 0.8, 0.9]);
  for (const s of [-1, 1]) {
    head.shape(dark, [[s * 0.6, 2.4, -0.2], [s * 2.2, 2.4, -0.2], [s * 1.4, 2.4, 1], [s * 1.35, 2.6, -0.7], [s * 1.7, 4.2, -1.1]]);
    head.glowBall(eye, 0.44, s * 1.25, 1.5, 3.05);
    // Upper fangs over the lip, and the lower ones up from the jaw.
    head.shape(GEAR.paper, [[s * 0.45, -0.5, 4.3], [s * 0.85, -0.5, 4.3], [s * 0.65, -0.5, 4.75], [s * 0.68, -1.5, 4.5]]);
    head.shape(GEAR.paper, [[s * 0.4, -1.3, 3.7], [s * 0.75, -1.3, 3.7], [s * 0.58, -1.3, 4.05], [s * 0.6, -0.65, 3.85]]);
  }
  // The jaw dropped a little, the dark of the mouth showing between.
  lengthwise(head, OUTLINE, [[2.6, 0.85, 0.3, -0.85], [4.7, 0.6, 0.25, -0.9]], 6);
  lengthwise(head, dark, [[2.4, 1, 0.5, -1.15], [4.4, 0.78, 0.38, -1.25], [4.9, 0.5, 0.28, -1.22]], 6);
  // The lip curled back off the teeth: wrinkles over the snout.
  for (const z of [3.2, 3.75]) head.shape(tone(dark, -0.08), sym([[0.85, 0.85, z], [0.85, 0.85, z + 0.22], [0, 1.25, z], [0, 1.25, z + 0.22]]));
  const tail = part(top, 0, 7.6, -4.8);
  // A brush hanging down and back, dark at its tip.
  lengthwise(tail, fur, [[0.6, 0.6, 0.6], [-0.6, 0.85, 0.85], [-2.4, 1.05, 1], [-3.6, 0.9, 0.85]], 6, 0, 0, 0, 0.61);
  lengthwise(tail, dark, [[-3.3, 0.96, 0.9], [-4.6, 0.7, 0.66], [-5.2, 0.2, 0.2]], 6, 0, 0, 0, 0.61);
  const legs = [[-1.5, 3], [1.5, 3], [-1.5, -3.6], [1.5, -3.6]].map(([x, z]) => {
    const leg = part(top, x, 4.6, z);
    // The hind legs bend back at the hock.
    const rings: Ring[] = z > 0 ? [[1.2, 1.05, 1.2, 0.1], [-0.6, 0.88, 0.98, 0.05], [-2.6, 0.68, 0.72, 0.05], [-3.9, 0.62, 0.68, 0.1]] : [[1.4, 1.2, 1.55, -0.25], [-0.6, 0.98, 1.12, -0.4], [-2.3, 0.66, 0.75, -0.6], [-3.1, 0.58, 0.66, -0.45], [-3.9, 0.62, 0.68, -0.15]];
    leg.loft(dark, rings, 6);
    leg.shape(tone(dark, -0.06), sym([[0.72, -4.6, -0.55], [0.82, -4.6, 0.7], [0.5, -4.6, 1.35], [0, -4.6, 1.5], [0.58, -3.7, -0.5], [0.58, -3.8, 0.4], [0, -4, 1.2]]));
    return leg;
  });
  return { parts, animate: fourLegs(top, legs, head, tail, 2.6, 9, 0.3) };
}

/**
 * A bear on all fours: heavier than the wolf, with a hump at the shoulders, round ears, a pale muzzle and
 * thick clawed legs. `frost` greys the hump and brow for the old Great Bear.
 */
function bear(top: THREE.Group, fur = "#7a5232", dark = "#4f3420", muzzle = "#b98a5a", eye = "#f2a33a", frost?: string): Rig {
  const parts: Part[] = [];
  const part = (parent: THREE.Object3D, x: number, y: number, z: number) => (parts[parts.length] = new Part(parent, x, y, z));
  const body = part(top, 0, 0, 0);
  // A barrel of a body rising to the hump over the shoulders, darker underneath, and a stub of a tail.
  const trunk: Span[] = [[-6, 1.7, 1.7, 7.9], [-5.1, 3, 2.95, 7.7], [-2.8, 3.6, 3.35, 7.6], [-0.2, 3.65, 3.55, 7.85], [1.6, 3.55, 4.1, 8.5], [3.4, 3.25, 3.7, 8.3], [4.7, 2.5, 2.6, 8.6]];
  lengthwise(body, fur, trunk);
  pelt(body, dark, trunk, -4.6, 3.2, Math.PI - 0.75, Math.PI + 0.75, 0.12);
  body.ball(dark, 1, 0, 8.8, -6, 0);
  if (frost) pelt(body, frost, trunk, -1, 3.8, -0.8, 0.8, 0.14);
  const head = part(top, 0, 9.4, 4.2);
  const skull: Span[] = [[-0.6, 2.5, 2.45, 0.8], [0.5, 3.1, 2.9, 0.75], [2.2, 3.05, 2.75, 0.6], [3.5, 2.4, 2.1, 0.25], [4.1, 1.45, 1.3, 0]];
  lengthwise(head, fur, skull);
  lengthwise(head, muzzle, [[3, 1.55, 1.35, -0.55], [5, 1.45, 1.2, -0.55], [5.95, 1.05, 0.85, -0.45], [6.2, 0.5, 0.45, -0.4]]);
  head.ball(OUTLINE, 0.62, 0, 0.35, 6, 0, [1.2, 0.75, 0.8]);
  for (const s of [-1, 1]) {
    head.ball(dark, 1.1, s * 2.4, 3.7, 1.1, 0, [1, 1, 0.7]);
    head.glowBall(eye, 0.44, s * 1.6, 1.6, 3.4);
  }
  if (frost) pelt(head, frost, skull, 0, 3, -0.85, 0.85, 0.13);
  const legs = [[-2.3, 3.2], [2.3, 3.2], [-2.3, -4], [2.3, -4]].map(([x, z]) => {
    const leg = part(top, x, 4.8, z);
    const rings: Ring[] = z > 0 ? [[1.5, 1.55, 1.75], [-0.8, 1.35, 1.55, 0.1], [-3, 1.25, 1.45, 0.2], [-4.2, 1.35, 1.6, 0.35]] : [[1.8, 1.75, 2.2, -0.3], [-0.6, 1.45, 1.7, -0.3], [-2.8, 1.25, 1.45, -0.05], [-4.2, 1.35, 1.6, 0.25]];
    leg.loft(dark, rings, 8);
    leg.shape(tone(dark, -0.05), sym([[1.4, -4.8, -1.25], [1.5, -4.8, 1], [1.1, -4.8, 1.85], [0, -4.8, 2.05], [1.35, -3.9, -1.15], [1.4, -3.9, 0.9], [0, -3.9, 1.7]]));
    for (const cx of [-0.8, 0, 0.8]) leg.shape(GEAR.paper, [[cx - 0.25, -4.8, 1.55], [cx + 0.25, -4.8, 1.55], [cx, -4.25, 1.6], [cx, -4.75, 2.55]]);
    return leg;
  });
  return { parts, animate: fourLegs(top, legs, head, null, 3.6, 12) };
}

/**
 * A ghost of the Haunted Caverns: a pale hooded shape with a ragged hem, hollow eyes and reaching hands,
 * hanging in the air. `crown` gives the bound Haunt the tarnished crown of whoever it was in life.
 */
function ghost(top: THREE.Group, pale = "#dfe8f2", shade = "#a7b6cc", eye = "#24203a", crown?: string): Rig {
  const parts: Part[] = [];
  const body = (parts[0] = new Part(top, 0, 2, 0));
  // One shape from the hem up over a round head, narrowing at the neck.
  body.loft(pale, [[4.2, 4.6, 4.5], [6.5, 4.3, 4.2, 0.05], [9.5, 3.75, 3.65, 0.15], [11.4, 3.7, 3.6, 0.15], [13.4, 3.9, 3.8, 0.05], [15.3, 3.1, 3, -0.1], [16.2, 1.75, 1.7, -0.15], [16.55, 0.4, 0.4, -0.15]], 10);
  // The ragged hem: tatters hanging below it, long and short by turns.
  for (let i = 0; i < 10; i++) {
    const a = ((i + 0.5) / 10) * Math.PI * 2;
    const half = Math.PI / 10;
    const long = i % 2 === 1;
    const at = (turn: number, r: number, y: number): Pt => [Math.sin(a + turn) * r, y, Math.cos(a + turn) * r];
    body.shape(long ? shade : pale, [at(-half, 4.62, 4.6), at(half, 4.62, 4.6), at(0, 3.5, 4.6), at(0, 4.3, 5.2), at(long ? 0.12 : -0.1, 4.15, long ? 1.3 : 2.2)]);
  }
  for (const s of [-1, 1]) body.ball(eye, 1, s * 1.5, 13, 3.35, 1, [0.92, 1.12, 0.55]);
  body.ball(eye, 1, 0, 10.2, 3.42, 1, [1.15, 0.8, 0.5]);
  if (crown) {
    body.loft(crown, [[15.3, 3.15, 3.05, -0.1], [16.2, 3, 2.92, -0.12]], 8);
    for (let i = 0; i < 4; i++) {
      const a = i * HALF_PI + 0.4;
      const at = (r: number, y: number, turn = 0): Pt => [Math.sin(a + turn) * r, y, Math.cos(a + turn) * r - 0.1];
      body.shape(crown, [at(3.05, 16.1, -0.3), at(3.05, 16.1, 0.3), at(2.6, 16.1), at(2.85, 17.55)]);
    }
  }
  const arms = [-1, 1].map((s) => {
    const arm = (parts[parts.length] = new Part(body.joint, s * 3.6, 9.6, 1));
    // A sleeve reaching forward, flaring at the cuff, and a pale hand with long fingers.
    lengthwise(arm, shade, [[-0.6, 1, 1], [1.5, 0.92, 0.88], [3.6, 0.82, 0.78], [4.4, 1.02, 0.95]], 6);
    arm.shape(pale, [[-0.7, 0.35, 4.2], [0.7, 0.35, 4.2], [-0.7, -0.45, 4.2], [0.7, -0.45, 4.2], [-0.75, 0.05, 5.55], [0, 0.2, 5.95], [0.75, 0.05, 5.55], [0, -0.55, 5.3]]);
    return arm;
  });
  const animate = (a: Anim) => {
    if (a.lying) {
      top.rotation.set(-HALF_PI, 0, 0);
      top.position.set(0, 4.2, 10);
      return;
    }
    top.rotation.set(a.strike * 0.35, 0, 0);
    top.position.set(0, Math.sin(a.t * 1.8) * 0.7 + 0.7, 0);
    arms.forEach((arm, i) => (arm.joint.rotation.x = -0.25 + Math.sin(a.t * 1.3 + i * 2) * 0.15 - a.strike * 0.6));
  };
  return { parts, animate, clean: true };
}

/** A cave bat, wings spread, hanging in the air: small, dark and red-eyed. */
function bat(top: THREE.Group): Rig {
  const parts: Part[] = [];
  const dark = "#4a3b52";
  const wing = "#2f2538";
  const body = (parts[0] = new Part(top, 0, 10, 0));
  // A furry egg of a body, tall pointed ears, red eyes and a fang.
  body.loft(dark, [[-2.75, 0.7, 0.65], [-2.1, 1.7, 1.45], [-0.6, 2.3, 1.95], [0.9, 2.25, 1.95, 0.1], [2.1, 1.75, 1.6, 0.15], [2.8, 0.7, 0.7, 0.1]], 8);
  for (const s of [-1, 1]) {
    body.shape(dark, [[s * 0.45, 2, -0.35], [s * 1.75, 2, -0.35], [s * 1.1, 2, 0.6], [s * 1.35, 4, 0.05]]);
    body.glowBall("#ff4d4d", 0.4, s * 0.85, 0.75, 1.72);
  }
  body.shape(GEAR.paper, [[0.12, -0.4, 1.7], [0.52, -0.4, 1.7], [0.32, -0.4, 2], [0.32, -1.25, 1.85]]);
  const wings = [-1, 1].map((s) => {
    const p = (parts[parts.length] = new Part(body.joint, s * 1.6, 0.8, 0));
    // An arm out to the wrist and a long finger on to the tip along the top; two more fingers fanning down;
    // the skin between them scalloped from one fingertip to the next.
    const wrist: [number, number] = [s * 4.2, 1.3];
    const tip: [number, number] = [s * 7.8, 0.9];
    const lower: [number, number] = [s * 6.6, -2.2];
    const inner: [number, number] = [s * 4, -2.4];
    const skin = (pts: [number, number][]) => p.shape(wing, pts.flatMap(([x, y]): Pt[] => [[x, y, -0.13], [x, y, 0.13]]));
    skin([[0, 1], wrist, inner, [s * 1.9, -1]]);
    skin([[0, 1], [s * 1.9, -1], [s * 0.2, -1.3]]);
    skin([wrist, inner, [s * 5.4, -1.35]]);
    skin([wrist, [s * 5.4, -1.35], lower]);
    skin([wrist, lower, [s * 7, -0.35]]);
    skin([wrist, [s * 7, -0.35], tip]);
    strut(p, dark, [0, 0.95, 0], [wrist[0], wrist[1], 0], 0.38, 0.28, 5);
    for (const end of [tip, lower, inner]) strut(p, dark, [wrist[0], wrist[1], 0], [end[0], end[1], 0], 0.24, 0.12, 5);
    p.ball(dark, 0.4, wrist[0], wrist[1] + 0.2, 0);
    return p;
  });
  const animate = (a: Anim) => {
    if (a.lying) {
      top.rotation.set(-HALF_PI, 0, 0);
      top.position.set(0, -8, 10);
      wings.forEach((p, i) => (p.joint.rotation.z = (i ? -1 : 1) * 0.2));
      return;
    }
    top.rotation.set(a.strike * 0.5, 0, 0);
    top.position.set(0, Math.sin(a.t * 5) * 0.6, 0);
    const flap = Math.sin(a.t * 15) * 0.6;
    wings.forEach((p, i) => (p.joint.rotation.z = (i ? 1 : -1) * flap));
  };
  return { parts, animate, clean: true };
}

/** A cave slime: a green blob with a shine on it, two dark eyes, and a drip. */
function slime(top: THREE.Group): Rig {
  const green = "#6fcf5a";
  const deep = "#3f8f36";
  const body = new Part(top, 0, 0, 0);
  // A gumdrop, its foot spread wide and darker where it sits in its own ooze.
  body.loft(green, [[1.4, 5.6, 5.6], [2.4, 5.85, 5.85], [4, 6, 6], [5.6, 5.6, 5.6], [7, 4.75, 4.75], [8.1, 3.3, 3.3], [8.7, 1.6, 1.6], [8.85, 0.4, 0.4]], 12);
  body.loft(deep, [[0, 5.7, 5.7], [0.6, 6.05, 6.05], [1.9, 6.05, 6.05]], 12);
  body.ball(green, 1.1, -5.9, 0.7, 1.4, 1);
  spot(body, "#c9f5b8", 1, 0.42, 0.6, -2, 7.35, 3.7, [-0.9, -0.4, 0]);
  spot(body, "#c9f5b8", 0.36, 0.72, 0.6, -3.6, 5.6, 4.3, [-0.45, -0.65, 0]);
  for (const s of [-1, 1]) body.ball("#14301a", 1, s * 1.9, 4.6, 5.45, 1, [0.78, 0.95, 0.45]);
  const animate = (a: Anim) => {
    const squash = a.lying ? -0.6 : a.breath * 0.05 + Math.abs(a.swing) * 0.18 - a.strike * 0.25;
    top.scale.set(1 - squash * 0.5, 1 + squash, 1 - squash * 0.5);
    top.position.set(0, 0, a.strike * 1.5);
  };
  return { parts: [body], animate, clean: true };
}

/** The sparring ring's training dummy: a straw sack on a post, with a target painted on its chest. */
function dummy(top: THREE.Group): Rig {
  const straw = "#d9b662";
  const shade = "#b08d3e";
  const body = new Part(top, 0, 0, 0);
  // A post on two crossed feet.
  body.loft(GEAR.wood, [[0, 0.95, 0.95], [6.6, 0.75, 0.75]], 6);
  for (const turn of [0, HALF_PI]) body.shape(GEAR.wood, [...sym([[4, 0, 0.75], [4, 0, -0.75], [4, 0.55, 0.6], [4, 0.55, -0.6]]), [0, 0.95, 0.85], [0, 0.95, -0.85]], 0, 0, 0, [0, turn, 0]);
  // The sack, tied at the bottom, with a target painted on its chest.
  body.loft(straw, [[6.1, 3.15, 2.95], [7.3, 3.5, 3.25], [9.6, 3.75, 3.45], [11.8, 3.75, 3.45], [12.9, 3.3, 3.05], [13.4, 2.4, 2.3]], 8);
  body.loft(shade, [[6, 3.3, 3.1], [6.75, 3.44, 3.22]], 8);
  body.loft("#f4efe2", [[0, 2.1, 2.1], [0.35, 2.1, 2.1]], 10, 0, 9.6, 3.1, [HALF_PI, 0, 0]);
  body.loft("#c8433d", [[0.3, 1, 1], [0.55, 1, 1]], 10, 0, 9.6, 3.1, [HALF_PI, 0, 0]);
  // A crossbar for arms, straw spilling from each end.
  strut(body, GEAR.wood, [-7.3, 11.2, 0], [7.3, 11.2, 0], 0.62);
  for (const s of [-1, 1]) body.loft(shade, [[9.3, 0.75, 0.95], [10.2, 0.92, 1.08], [12, 0.72, 0.88], [12.7, 0.36, 0.42]], 6, s * 6.8, 0, 0);
  // A sack of a head on a leather tie: two button eyes, a stitched mouth, a tuft on top.
  body.loft(GEAR.leather, [[13, 2.55, 2.45], [13.9, 2.45, 2.35]], 8);
  body.loft(straw, [[13.4, 1.6, 1.6], [14.1, 2.75, 2.65], [16, 3.15, 3.05], [17.8, 2.65, 2.55], [18.8, 1.3, 1.3], [19.1, 0.35, 0.35]], 8);
  body.loft(shade, [[18.6, 0.7, 0.7], [19.5, 0.5, 0.5], [20, 0.9, 0.85]], 5);
  for (const s of [-1, 1]) body.ball(OUTLINE, 0.5, s * 1.2, 16.6, 2.82, 1, [1, 1, 0.55]);
  spot(body, shade, 1, 0.22, 0.4, 0, 15, 2.85);
  const animate = (a: Anim) => {
    if (a.lying) {
      top.rotation.set(-HALF_PI, 0, 0);
      top.position.set(0, 3.6, 9);
    } else {
      top.rotation.set(-a.strike * 0.2, 0, Math.sin(a.t * 1.1) * 0.01);
      top.position.set(0, 0, 0);
    }
  };
  return { parts: [body], animate };
}

function rigFor(kind: string, top: THREE.Group, look: Look, outfit: Outfit | undefined, asleep: boolean): Rig {
  if (outfit) return person(top, look, outfit, asleep);
  switch (kind) {
    case "wolf":
      return wolf(top);
    case "alpha":
      return wolf(top, "#4a4f5c", "#2c3039", "#ff4d4d");
    case "bear":
      return bear(top);
    case "great_bear":
      return bear(top, "#4a3426", "#2a1d15", "#8a7a6a", "#ff4d4d", "#9a8f86");
    case "dummy":
      return dummy(top);
    case "shade":
      return ghost(top);
    case "haunt":
      return ghost(top, "#c7b8f0", "#8b74c9", "#ff4d4d", "#c9a24a");
    case "bat":
      return bat(top);
    case "skeleton":
      return skeleton(top);
    case "slime":
      return slime(top);
  }
  return person(top, look, undefined, asleep);
}

/**
 * Mud and dust from the ground up: as the figure stands, whatever is near its feet (boots, shins, a coat's
 * hem, the foot of a staff) is stained toward the colour of dirt, most at the sole and none above the knee.
 */
function muddy(scaler: THREE.Group, body: THREE.Material) {
  scaler.updateMatrixWorld(true);
  const toModel = new THREE.Matrix4().copy(scaler.matrixWorld).invert();
  const at = new THREE.Vector3();
  const local = new THREE.Matrix4();
  const tint = new THREE.Color();
  scaler.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || o.material !== body) return;
    local.multiplyMatrices(toModel, o.matrixWorld);
    const pos = o.geometry.getAttribute("position");
    const col = o.geometry.getAttribute("color");
    for (let i = 0; i < pos.count; i++) {
      const y = at.fromBufferAttribute(pos, i).applyMatrix4(local).y;
      if (y >= MUD_HEIGHT) continue;
      const k = Math.pow(1 - Math.max(0, y) / MUD_HEIGHT, 1.6) * 0.7;
      tint.fromBufferAttribute(col, i).lerp(MUD, k);
      col.setXYZ(i, tint.r, tint.g, tint.b);
    }
  });
}

/** Seen by the lights only: it is drawn into their shadow maps and nowhere else. */
const SHADOW_ONLY = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });

/**
 * What throws a figure's shadow: its whole body as it stands at rest, in one piece that never moves a limb.
 * Indoors the lights' shadow maps are small and are redrawn while someone walks; a striding figure's arms
 * and legs, redrawn into them a light or two a frame, threw rough shadows that jumped about the walls. A
 * still shape slides across them evenly, as the old shadow cards did. It lies down with the figure.
 */
function castShape(top: THREE.Group, made: THREE.BufferGeometry[]): THREE.Mesh | null {
  top.updateMatrixWorld(true);
  const toTop = new THREE.Matrix4().copy(top.matrixWorld).invert();
  const pieces: THREE.BufferGeometry[] = [];
  top.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !o.userData.body) return;
    const piece = o.geometry.clone();
    piece.deleteAttribute("color");
    piece.deleteAttribute("normal");
    piece.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toTop, o.matrixWorld));
    pieces.push(piece);
  });
  if (pieces.length === 0) return null;
  const shape = mergeGeometries(pieces)!;
  for (const piece of pieces) piece.dispose();
  made.push(shape);
  const mesh = new THREE.Mesh(shape, SHADOW_ONLY);
  mesh.castShadow = true;
  return mesh;
}

/** The animals that stand side-on in a portrait, as they did in their sprites. */
export const FOUR_LEGGED = new Set(["wolf", "alpha", "bear", "great_bear"]);

// ---------- the figure ----------

export interface FigurePose {
  /** Seconds on the render clock. */
  time: number;
  /** Distance walked, and whether it is walking now. */
  stride: number;
  walking: boolean;
  /** The lean into an attack: about half a radian as it starts, easing to zero. Either sign. */
  lean: number;
  /** Down in a fight, or asleep. */
  lying: boolean;
  /**
   * Seated: stand the figure with its feet `SITTING_DROP` of its size below the seat's top. A number is how far
   * into the pose it is, 0 (standing) to 1, for sitting down and getting up. Only people sit; a creature stands.
   */
  sitting?: boolean | number;
}

/** How far below a seat's top a seated figure's origin goes, as a share of its size: its hips, less half a thigh. */
export const SITTING_DROP = 3.7 / FRAME;

export interface Figure {
  /** Stands on its origin, facing +z: place it and turn it about y. */
  readonly root: THREE.Group;
  /** How tall the 22-unit frame is in world units: what a sprite's height used to be. */
  setSize(size: number): void;
  update(pose: FigurePose): void;
  /** Greyed, for someone down in a fight. */
  setDim(on: boolean): void;
  /** How much of it is left to see, 1 (all there) to 0 (gone): it thins out pixel by pixel as a camera passes through it. */
  setFade(left: number): void;
  dispose(): void;
}

export interface FigureOptions {
  /** Eyes shut. */
  asleep?: boolean;
  /** Fishing: a rod in the right hand in place of whatever weapon is there. "gilded" for a full Catch Book. */
  rod?: boolean | "gilded";
  /** Outline thickness, in model units. */
  edge?: number;
  /** Draw it low-poly whatever the dev toolbox says (a hero with a chosen appearance always is). */
  lowPoly?: boolean;
}

/**
 * The model for a hero class, enemy kind or townsperson, drawn with `look`. Pass a hero's outfit to
 * build them wearing it; without one the kind's stock look is used.
 */
export function makeFigure(kind: string, look: Look, outfit?: Outfit, opts: FigureOptions = {}): Figure {
  const root = new THREE.Group();
  const scaler = new THREE.Group();
  const top = new THREE.Group();
  root.add(scaler);
  scaler.add(top);
  scaler.scale.setScalar(1 / FRAME);
  edge = opts.edge ?? 0.12;
  seed = 20261113;
  rodInHand = opts.rod ?? false;
  extraParts = [];
  braids = [];
  slung = null;
  chosen = outfit?.appearance ?? null;
  lowPoly = !!chosen || !!opts.lowPoly || !BLOCKY_PREF;
  m = lowPoly ? measuresOf(chosen) : USUAL;
  // A hero's own colouring over their class's.
  if (chosen) look = { ...look, skin: chosen.skin, hair: chosen.hair };
  const rig = rigFor(kind, top, look, outfit, !!opts.asleep);
  const fade = { value: 1 };
  const mats: Mats = {
    body: fadeable(bodyMaterial(), fade, "gq-figure-body"),
    outline: fadeable(new THREE.MeshBasicMaterial({ color: OUTLINE, side: THREE.BackSide }), fade, "gq-figure-line"),
    glow: fadeable(new THREE.MeshBasicMaterial({ vertexColors: true }), fade, "gq-figure-glow"),
  };
  const made: THREE.BufferGeometry[] = [];
  for (const part of [...rig.parts, ...extraParts]) part.build(mats, made);
  const swinging = braids;
  const sling = slung;
  if (!rig.clean) muddy(scaler, mats.body);
  // Each figure breathes on its own beat.
  const beat = Math.random() * 6;
  let swing = 0;
  let last = -1;
  const update = (p: FigurePose) => {
    const dt = last < 0 ? 1 : Math.min(0.1, Math.max(0, p.time - last));
    last = p.time;
    const want = p.walking ? Math.sin(p.stride * 3.6) : 0;
    swing += (want - swing) * Math.min(1, dt * 20);
    const anim: Anim = { t: p.time, swing, breath: Math.sin(p.time * 2.2 + beat), strike: Math.min(1, Math.abs(p.lean) * 2), lying: p.lying, sitting: typeof p.sitting === "number" ? Math.max(0, Math.min(1, p.sitting)) : p.sitting ? 1 : 0 };
    if (sling) stow(sling, p.walking, anim.strike, dt);
    rig.animate(anim);
    if (swinging.length > 0) swingBraids(swinging, anim);
  };
  update({ time: 0, stride: 0, walking: false, lean: 0, lying: false });
  last = -1;
  const shadow = castShape(top, made);
  if (shadow) top.add(shadow);
  return {
    root,
    setSize: (size) => scaler.scale.setScalar(size / FRAME),
    update,
    setDim(on) {
      mats.body.color.setScalar(on ? 0.5 : 1);
      mats.glow.color.setScalar(on ? 0.4 : 1);
    },
    setFade(left) {
      fade.value = Math.max(0, Math.min(1, left));
      root.visible = fade.value > 0;
    },
    dispose() {
      for (const g of made) g.dispose();
      mats.body.dispose();
      mats.outline.dispose();
      mats.glow.dispose();
    },
  };
}
