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
// its own shape, with its rarity colour as the trim. The weapons and shields
// in their hands are the very models of their item icons (gearModels.ts).

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import { GARB_PREFIX, INK_COLORS, INK_LEVELS, INK_REGIONS, RARITY_COLOR, WEAPONS, WEAPON_ICON, appearanceK, decodeInk, inkColorOf, inkLevelOf, type Appearance, type Ink, type InkRegion, type InkView, type Outfit, type Slot } from "@gantt-quest/world";
import type { Look } from "./looks";
import { buildLowPoly, disposeLowPoly } from "./gearModels";

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
/**
 * Tattoo ink: lit and shaded like the body (with the same floor of light), see-through by each vertex colour's
 * alpha, never hiding what is behind it from the depth test, and pulled a hair toward the eye over the skin.
 */
function inkMaterial(): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace("#include <opaque_fragment>", "outgoingLight = max(outgoingLight, diffuseColor.rgb * 0.32);\n  #include <opaque_fragment>");
  };
  m.customProgramCacheKey = () => "gq-figure-ink";
  return m;
}

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
/** How a loft is closed: `open` leaves off the cap at its first ring (or both ends); `inward` faces it inward, to be seen from inside. */
interface LoftShape {
  open?: "start" | "both";
  inward?: boolean;
}

function loftGeometry(rings: readonly Ring[], sides: number, shape: LoftShape = {}): THREE.BufferGeometry {
  const sorted = [...rings].sort((p, q) => p[0] - q[0]);
  const loops = sorted.map(([y, rx, rz, dz = 0]) =>
    Array.from({ length: sides }, (_, k) => {
      const a = ((k + 0.5) / sides) * Math.PI * 2;
      return new THREE.Vector3(Math.sin(a) * rx, y, Math.cos(a) * rz + dz);
    }),
  );
  const out: number[] = [];
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) =>
    shape.inward ? out.push(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z) : out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
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
  if (!shape.open) cap(0, false);
  if (shape.open !== "both") cap(loops.length - 1, true);
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
  /** Tattoo ink: lit like the skin, and as see-through as each cell was inked (its vertex colours' alpha). */
  ink: THREE.MeshLambertMaterial;
}

/** One jointed part: primitives gathered in the joint's own space, then merged into a mesh or three. */
class Part {
  readonly joint = new THREE.Group();
  /** What the part's meshes hang on: scaled for a body's proportions without scaling the joints below it. */
  readonly skin = new THREE.Group();
  private solid: THREE.BufferGeometry[] = [];
  private hull: THREE.BufferGeometry[] = [];
  private lit: THREE.BufferGeometry[] = [];
  private inked: THREE.BufferGeometry[] = [];

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
    return this.add(new THREE.TorusGeometry(radius, tube, lowPoly ? 6 : 4, lowPoly ? 16 : 10), color, x, y, z, rot, false, lowPoly);
  }

  /** A faceted tube through `rings` (see loftGeometry), in this joint's space offset by (x, y, z). */
  loft(color: string, rings: readonly Ring[], sides = 8, x = 0, y = 0, z = 0, rot?: Rot): this {
    return this.add(loftGeometry(rings, sides), color, x, y, z, rot, false, true);
  }

  /**
   * A loft left open at its first ring (or both ends; see LoftShape): a mouth, a hood's opening. Facing inward
   * it is a lining, seen only from inside and drawn with no outline.
   */
  shell(color: string, rings: readonly Ring[], sides: number, shape: LoftShape, x = 0, y = 0, z = 0, rot?: Rot): this {
    return this.add(loftGeometry(rings, sides, shape), color, x, y, z, rot, false, !shape.inward, !shape.inward);
  }

  /** The smallest solid that holds all of `pts`, with no outline: an eye laid on a face (see inlayPoints). */
  inlay(color: string, pts: Pt[]): this {
    return this.add(new ConvexGeometry(pts.map(([px, py, pz]) => new THREE.Vector3(px, py, pz))), color, 0, 0, 0, undefined, false, false, false);
  }

  /** The smallest solid that holds all of `pts`: a wedge, a blade, a shoe. */
  shape(color: string, pts: Pt[], x = 0, y = 0, z = 0, rot?: Rot): this {
    return this.add(new ConvexGeometry(pts.map(([px, py, pz]) => new THREE.Vector3(px, py, pz))), color, x, y, z, rot, false, true);
  }

  /**
   * Triangles lying just over a surface (see inkOn): a tattoo's ink, lit, with no outline, `alpha` of it laid
   * over what is under it (the skin shows through faint ink).
   */
  inkGeometry(color: string, alpha: number, positions: number[]): this {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    g.computeVertexNormals();
    const c = new THREE.Color(color);
    const n = positions.length / 3;
    const rgba = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) rgba.set([c.r, c.g, c.b, alpha], i * 4);
    g.setAttribute("color", new THREE.BufferAttribute(rgba, 4));
    this.inked.push(g);
    return this;
  }

  glowBox(color: string, w: number, h: number, d: number, x = 0, y = 0, z = 0, rot?: Rot): this {
    return this.add(new THREE.BoxGeometry(w, h, d), color, x, y, z, rot, true);
  }

  /** A faceted tube through `rings` that glows (unlit, no outline): a lantern's glass. */
  glowLoft(color: string, rings: readonly Ring[], sides = 8, x = 0, y = 0, z = 0): this {
    return this.add(loftGeometry(rings, sides), color, x, y, z, undefined, true);
  }

  glowBall(color: string, radius: number, x = 0, y = 0, z = 0): this {
    return this.add(new THREE.IcosahedronGeometry(radius, 0), color, x, y, z, undefined, true);
  }

  /**
   * A gear model (gearModels.ts) baked into this part, placed by `at`: each of its pieces in its own colour, what
   * glows in the icon glowing here. A piece too fine to take an outline (a string, a finger hole) goes without.
   */
  model(model: THREE.Object3D, at: THREE.Matrix4): this {
    model.updateMatrixWorld(true);
    const size = new THREE.Vector3();
    model.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const source = o.geometry as THREE.BufferGeometry;
      const flat = source.index ? source.toNonIndexed() : source.clone();
      flat.applyMatrix4(new THREE.Matrix4().multiplyMatrices(at, o.matrixWorld));
      const paints = (Array.isArray(o.material) ? o.material : [o.material]) as THREE.MeshLambertMaterial[];
      // A piece of several paints (a log and its cut ends) comes apart into one piece per paint.
      const pieces = paints.length > 1 && flat.groups.length > 0 ? flat.groups.map((g) => ({ g: slice(flat, g.start, g.count), paint: paints[g.materialIndex ?? 0] })) : [{ g: flat, paint: paints[0] }];
      if (pieces[0].g !== flat) flat.dispose();
      for (const { g, paint } of pieces) {
        g.computeBoundingBox();
        const [, middle] = g.boundingBox!.getSize(size).toArray().sort((a, b) => a - b);
        this.add(g, `#${paint.color.getHexString()}`, 0, 0, 0, undefined, !!paint.userData.glow, true, middle >= 3.5 * edge);
      }
    });
    return this;
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
      this.skin.add(mesh);
      // (Gear too fine for an outline has none: see model.)
      if (this.hull.length > 0) this.skin.add(new THREE.Mesh(merged(this.hull), mats.outline));
    }
    if (this.lit.length > 0) {
      const mesh = new THREE.Mesh(merged(this.lit), mats.glow);
      mesh.userData.selfLit = true;
      this.skin.add(mesh);
    }
    if (this.inked.length > 0) {
      // Drawn after the solid body it lies on, so the skin is there to show through.
      const mesh = new THREE.Mesh(merged(this.inked), mats.ink);
      mesh.renderOrder = 1;
      this.skin.add(mesh);
    }
    this.solid = this.hull = this.lit = this.inked = [];
  }
}

/** How thick the dark outline is, in model units, for the figure being built. */
let edge = 0.12;

/** The vertices `start` to `start + count` of a geometry with no index, as a geometry of their own. */
function slice(g: THREE.BufferGeometry, start: number, count: number): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(g.attributes) as [string, THREE.BufferAttribute][]) {
    out.setAttribute(name, new THREE.BufferAttribute(attr.array.slice(start * attr.itemSize, (start + count) * attr.itemSize), attr.itemSize, attr.normalized));
  }
  return out;
}

// ---------- gear in hand ----------

/** How a gear model (gearModels.ts) is held: it is built upright, its front toward +z, in its icon's units. */
interface Hold {
  /** The point of the model the hand closes on, in its own units. */
  grip: Pt;
  /** Its units to the figure's: one for all three ways, or across, along and through it. */
  scale: number | Pt;
  /** How it is turned in the hand, about the grip. */
  turn?: Rot;
  /** Where the grip goes in the part's frame (a hand's fist is at its origin). */
  at?: Pt;
  /** How the arm carries it (see drawHeld). */
  pose?: { arm?: number; tilt?: number };
}

/** Turns a model's +x (an axe's blade, a bow's belly, a book's fore-edge) to the front, its face out from the right hand. */
const FORWARD: Rot = [0, -HALF_PI, 0];
/** A shield's turn on the forearm: a little out from the body. */
const ON_ARM: Rot = [0, 0.35, 0];

/** Each held icon's grip, scaled to stand with the figure: hilts and hafts in the fist, the foot of a staff clear of the ground. */
const HOLD: Record<string, Hold> = {
  broadsword: { grip: [0, 0.3, 0], scale: 0.72, pose: { tilt: 0.4 } },
  "hammer-drop": { grip: [0, -4, 0], scale: 0.6, turn: FORWARD, pose: { tilt: 0.4 } },
  "wizard-staff": { grip: [0, -3.5, 0], scale: 0.8 },
  "root-staff": { grip: [0, -4.2, 0], scale: 0.8 },
  "void-staff": { grip: [0, -3.5, 0], scale: 0.8 },
  "scroll-unfurled": { grip: [0, 1.2, 0], scale: 0.33, turn: FORWARD },
  // Held up in front on the palm, its sigil to the front.
  grimoire: { grip: [0, -6.5, 0], scale: 0.33, at: [0, 0, 0.6], pose: { arm: -0.9 } },
  // Beside the fist, the belly forward and the arrow pointing ahead.
  crossbow: { grip: [3.2, 0, 0], scale: 0.6, turn: FORWARD, at: [-1.4, 0, 0.35] },
  sickle: { grip: [0, -4.5, 0], scale: 0.5, turn: FORWARD, pose: { tilt: 0.4 } },
  orb: { grip: [0, -5, 0], scale: 0.45, pose: { arm: -0.5 } },
  scepter: { grip: [0, -5.5, 0], scale: 0.55, pose: { tilt: 0.3 } },
  "pager-axe": { grip: [0, -6.5, 0], scale: 0.65, turn: FORWARD, pose: { tilt: 0.25 } },
  maul: { grip: [0, -9, 0], scale: 0.65, turn: FORWARD, pose: { tilt: 0.2 } },
  // One in each fist (see heldGear).
  daggers: { grip: [0, -1.8, 0], scale: 0.53, pose: { tilt: 0.7 } },
  // In the lute's own frame (see drawLute): the belly at the origin.
  lute: { grip: [0, -3, 0], scale: 0.5 },
  // The signature weapons.
  "ballast-flail": { grip: [0, -3.8, 0], scale: 0.75, turn: FORWARD, pose: { tilt: 0.3 } },
  "barometer-rod": { grip: [0, -3.5, 0], scale: 0.8 },
  // One in each fist, like the daggers, the hooks curling forward.
  "gaff-hook": { grip: [0, -2.2, 0], scale: 0.55, turn: FORWARD, pose: { tilt: 0.5 } },
  "coral-staff": { grip: [0, -4.2, 0], scale: 0.8 },
  // Rung: held up by the handle, the bell hanging below the fist.
  "ships-bell": { grip: [0, 5.6, 0], scale: 0.5, pose: { arm: -0.7 } },
  astrolabe: { grip: [0, -4.2, 0], scale: 0.45, pose: { arm: -0.5 } },
  "lamp-hook": { grip: [0, -6.5, 0], scale: 0.65, turn: FORWARD, pose: { tilt: 0.15 } },
  // Held up in front by the stem.
  "bilge-chalice": { grip: [0, -3, 0], scale: 0.46, at: [0, 0, 0.4], pose: { arm: -0.9 } },
  "round-shield": { grip: [0, 0, 0], scale: 0.39, at: [0.5, -3.4, 1.9], turn: ON_ARM },
  shield: { grip: [0, -0.5, 0], scale: 0.43, at: [0.5, -2.9, 1.95], turn: ON_ARM },
};

/** Icons held one in each fist (see heldGear). */
const PAIRED = new Set(["daggers", "gaff-hook"]);

/** The icon (so the model) a stock look's weapon is drawn as: a class weapon's own, or the one most like it. */
const STOCK_ICON: Record<string, string> = { ...WEAPON_ICON, sword: "broadsword", bow: "crossbow" };

/** Put an icon's model in a part, held as `hold` says, in the trim colour. False when the icon has no model. */
function gear(p: Part, icon: string, trim: string, hold: Hold, inHand = false): boolean {
  const built = buildLowPoly(icon, trim, inHand);
  if (!built) return false;
  const scale = typeof hold.scale === "number" ? new THREE.Vector3().setScalar(hold.scale) : new THREE.Vector3(...hold.scale);
  const at = new THREE.Matrix4().compose(new THREE.Vector3(...(hold.at ?? [0, 0, 0])), new THREE.Quaternion().setFromEuler(new THREE.Euler(...(hold.turn ?? [0, 0, 0]))), scale);
  at.multiply(new THREE.Matrix4().makeTranslation(-hold.grip[0], -hold.grip[1], -hold.grip[2]));
  p.model(built.model, at);
  disposeLowPoly(built.model);
  return true;
}

/** A grip in a fist angled out from the body (`s` 1 for the right hand, -1 the left), for a dagger or a hook. */
function outward(hand: Part, s: number): Part {
  const grip = new Part(hand.joint);
  grip.joint.rotation.z = s * 0.38;
  extraParts.push(grip);
  return grip;
}

/**
 * A low-poly hero's weapon as its icon's model, and how the arm carries it; null when it has none, or is played
 * across the body (the lute and flute: drawHeld lays those out).
 */
function heldGear(icon: string, b: Biped, trim: string, shield: boolean): { arm?: number; tilt?: number } | null {
  const hold = HOLD[icon];
  if (!hold || icon === "lute") return null;
  if (PAIRED.has(icon)) {
    // One in each fist (the second unless a shield is there), both tipped forward the same.
    if (!gear(outward(b.heldR, 1), icon, trim, hold, true)) return null;
    if (!shield) {
      gear(outward(b.heldL, -1), icon, trim, hold, true);
      b.rest.tiltL = hold.pose?.tilt ?? 0;
    }
    return hold.pose ?? {};
  }
  return gear(b.heldR, icon, trim, hold) ? hold.pose ?? {} : null;
}

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
  /** At the oars of a rowboat (seated): where the stroke is, 0 (reached forward) to 1 (pulled back). -1: not rowing. */
  oars: number;
}

interface Rig {
  parts: Part[];
  animate(a: Anim): void;
  /** Never touches the ground (a ghost, a bat) or is all one wet thing (a slime): no mud on it. */
  clean?: boolean;
  /** A person's fists, right then left: where they hold things, and take hold of oars. */
  hands?: [THREE.Object3D, THREE.Object3D];
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
      if (a.oars >= 0) {
        // At the oars, facing the bow: both arms reach forward and up to the handles to push the blades back
        // through the water, then come down and back in to lift them out. The body leans into each push.
        const pull = a.oars;
        const forward = -1.12 + pull * 0.6;
        armL.joint.rotation.set(forward, 0, 0.03 + pull * 0.05);
        armR.joint.rotation.set(forward, 0, -0.03 - pull * 0.05);
        top.rotation.x = 0.12 - pull * 0.2;
        head.joint.rotation.x = -top.rotation.x * 0.7 + a.breath * 0.02;
        return;
      }
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
  lowEyes(head, look.hair, chosen?.eyes ?? "round", asleep, rings);
  lowHair(head, look.hair, chosen?.hairStyle ?? "short", rings, covered);
  if (chosen?.ink) inkPart(head, "head", chosen.ink);
  if (chosen) lowFacialHair(head, chosen.beard, chosen.mustache, skin, look.hair, rings, chinY, mouthY);
}

/**
 * Hair of each style, just outside a head of these rings: a cap down to the brow and a fall at the back,
 * longer or tied up or braided, or none. `covered` is a hat or helmet on top, which hides a bun.
 */
/** The cap of hair over a head of these rings, from the brow up: what a helm or a hat goes over (see fitted). */
function hairCap(rings: readonly Ring[]): Ring[] {
  const cap = (y: number, by: number) => ringAt(rings, y).rx + by;
  const capZ = (y: number, by: number) => ringAt(rings, y).rz + by;
  return [[4.35, cap(4, 0.2), capZ(4, 0.21), -0.05], [5.3, cap(4.9, 0.22), capZ(4.9, 0.22), -0.1], [6.3, cap(6, 0.35), capZ(6, 0.35), -0.15], [6.95, 1.25, 1.25, -0.15]];
}

function lowHair(head: Part, hair: string, style: string, rings: readonly Ring[], covered: boolean) {
  if (style === "bald") return;
  const cap = (y: number, by: number) => ringAt(rings, y).rx + by;
  const capZ = (y: number, by: number) => ringAt(rings, y).rz + by;
  head.loft(hair, hairCap(rings));
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
  // An amulet is worn over it, where it would otherwise be hidden (see lowAmulet).
  beardFront = { part: root, at: [0, -a * 0.5, 1.0] };
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
/** The front of a long (wizard's) beard on the figure being built, if it has one: where an amulet goes. */
let beardFront: { part: Part; at: Pt } | null = null;

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

/**
 * An inlay on the face: an ellipse `rx` by `ry` about (`cx`, `cy`), laid on the head's own faceted surface
 * (`rings`) `lift` proud of it. The head is an eight-sided loft, and an eye sits across the crease between its
 * front facets; a ball there sinks into one facet and floats off the other, and its outline comes adrift of it.
 * An inlay follows the facets (it holds points over its middle as well as round its rim, so it bends over the
 * crease instead of bridging under it). `clip` reshapes the rim: it returns the height a point should be at.
 */
function inlayPoints(rings: readonly Ring[], cx: number, cy: number, rx: number, ry: number, lift: number, clip?: (x: number, y: number) => number): Pt[] {
  const pts: Pt[] = [];
  for (const k of [1, 0.6, 0.25]) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const x = cx + Math.cos(a) * rx * k;
      let y = cy + Math.sin(a) * ry * k;
      if (clip) y = clip(x, y);
      const z = faceZ(rings, x, y);
      pts.push([x, y, z + lift]);
      // Its back, well inside the head, so it is solid and never shows an edge.
      if (k === 1) pts.push([x, y, z - 0.3]);
    }
  }
  const mid = clip ? clip(cx, cy) : cy;
  pts.push([cx, mid, faceZ(rings, cx, mid) + lift]);
  return pts;
}

/**
 * The eyes (and brows over them) of each kind, on a head of these `rings`. Each is ink laid on the face (see
 * inlayPoints) with no outline of its own, since it is the outline's colour; its catchlight and a sleepy lid are
 * laid flat over it, so each shades as one colour rather than as a faceted ball. The brows are laid on the face
 * the same way, each over a dark band that is its outline.
 */
function lowEyes(head: Part, hair: string, kind: string, asleep: boolean, rings: readonly Ring[]) {
  const y = 3.05;
  const fierce = kind === "fierce";
  for (const s of [-1, 1]) {
    const x = s * (kind === "beady" ? 1.05 : 1.15);
    const glint = (gx: number, gy: number, r: number) => head.inlay("#ffffff", inlayPoints(rings, gx, gy, r, r, 0.1));
    if (asleep) {
      // Shut: a lid line, sagging a little in the middle.
      head.inlay(OUTLINE, inlayPoints(rings, x, y - 0.1, 0.5, 0.09, 0.07, (px, py) => py + 0.16 * ((px - x) / 0.5) ** 2));
    } else if (kind === "big") {
      head.inlay(OUTLINE, inlayPoints(rings, x, y + 0.05, 0.55, 0.8, 0.07));
      glint(x + 0.18, y + 0.35, 0.21);
      glint(x - 0.15, y - 0.27, 0.1);
    } else if (kind === "beady") {
      head.inlay(OUTLINE, inlayPoints(rings, x, y, 0.3, 0.3, 0.07));
    } else if (kind === "narrow") {
      head.inlay(OUTLINE, inlayPoints(rings, x, y, 0.5, 0.24, 0.07));
    } else {
      // Round, sleepy and fierce eyes. A fierce one is cut level with its brow, low at the inner corner; a
      // sleepy one has heavy lids halfway down, so only its bottom half shows, under a level lid line.
      const sleepy = kind === "sleepy";
      const clip = fierce ? (px: number, py: number) => Math.min(py, y + 0.3 + (s * px - 1.15) * 0.55) : sleepy ? (_px: number, py: number) => Math.min(py, y + 0.04) : undefined;
      head.inlay(OUTLINE, inlayPoints(rings, x, y, 0.42, 0.62, 0.07, clip));
      if (!sleepy) glint(x + 0.12, y + (fierce ? 0.1 : 0.22), 0.16);
    }
    // The brow, along a line tipped at its inner end (down for a fierce one, a little up otherwise), laid on
    // the face over a dark band a little larger all round: its outline, even on every side (an outline shell
    // shows only on the side turned from the viewer, a bar at one end and nothing over the top).
    const bx = s * 1.2;
    const by = y + (kind === "big" ? 1.02 : fierce ? 0.7 : 0.9);
    const tip = Math.sin(fierce ? 0.38 : -0.12);
    const half = (fierce ? 0.38 : 0.32) / 2;
    const brow = (color: string, grow: number, lift: number) => {
      const pts: Pt[] = [];
      for (const t of [-1, -0.5, 0, 0.5, 1]) {
        const px = bx + t * (0.575 + grow);
        const py = by + s * (px - bx) * tip;
        for (const dy of [-half - grow, 0, half + grow]) {
          const z = faceZ(rings, px, py + dy);
          pts.push([px, py + dy, z + lift]);
          if (dy !== 0) pts.push([px, py + dy, z - 0.3]);
        }
      }
      head.inlay(color, pts);
    };
    brow(OUTLINE, 0.09, 0.06);
    brow(hair, 0, 0.14);
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

/** The rings of the head being dressed: its chosen shape, or the usual round one. */
const headRings = (): readonly Ring[] => HEAD_RINGS[chosen?.headShape ?? "round"] ?? HEAD_RINGS.round;

/** A head of these rings as headgear meets it: the face and jaw, and the cap of hair from the brow up. */
const crownOf = (rings: readonly Ring[]): Ring[] => [...rings.filter((r) => r[0] < 4), ...hairCap(rings)];
const ROUND_CROWN = crownOf(HEAD_RINGS.round);

/** How much wider, deeper and further forward the head being dressed (with its hair) is than the round head, at height `y`. */
function headDelta(y: number): { rx: number; rz: number; dz: number } {
  const a = ringAt(crownOf(headRings()), y);
  const b = ringAt(ROUND_CROWN, y);
  return { rx: a.rx - b.rx, rz: a.rz - b.rz, dz: a.dz - b.dz };
}

/**
 * Rings drawn round the usual round head (a helm, a hat's crown), fitted to the head being dressed: at each
 * height moved out or in by as much as it (with its hair) is wider or narrower there, so a helm sits as close on
 * a pear head's narrow crown or a square jaw as on a round one. Long spans are cut into shorter ones first, so
 * the fit holds between the rings too (a squat head's crown falls away faster than a round one's).
 */
function fitted(rings: readonly Ring[]): Ring[] {
  if (headRings() === HEAD_RINGS.round) return rings.slice();
  const fine: Ring[] = [];
  rings.forEach((r, i) => {
    const next = rings[i + 1];
    fine.push(r);
    if (!next) return;
    const steps = Math.ceil(Math.abs(next[0] - r[0]) / 0.45);
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      fine.push([r[0] + (next[0] - r[0]) * t, r[1] + (next[1] - r[1]) * t, r[2] + (next[2] - r[2]) * t, (r[3] ?? 0) + ((next[3] ?? 0) - (r[3] ?? 0)) * t]);
    }
  });
  const out: Ring[] = fine.map(([y, rx, rz, dz = 0]) => {
    const d = headDelta(y);
    return [y, rx + d.rx, rz + d.rz, dz + d.dz];
  });
  // Rigid: it curves over a dip in the head (a squat head's crown falling away), never in after it.
  const rx = rounded(out.map((r) => [r[0], r[1]]));
  const rz = rounded(out.map((r) => [r[0], r[2]]));
  return out.map((r, i) => [r[0], rx[i], rz[i], r[3] ?? 0]);
}

/** The heights of a profile ([y, r] in order of y) lifted to the least that bows only outward: its upper hull. */
function rounded(profile: [number, number][]): number[] {
  const hull: [number, number][] = [];
  for (const p of profile) {
    while (hull.length >= 2) {
      const [a, b] = [hull[hull.length - 2], hull[hull.length - 1]];
      // Drop b if it lies on or under the line from a to p.
      if ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0) hull.pop();
      else break;
    }
    hull.push(p);
  }
  return profile.map(([y, r]) => {
    for (let i = 0; i + 1 < hull.length; i++) {
      const [y0, r0] = hull[i];
      const [y1, r1] = hull[i + 1];
      if (y >= y0 && y <= y1) return Math.max(r, y1 === y0 ? Math.max(r0, r1) : r0 + ((r1 - r0) * (y - y0)) / (y1 - y0));
    }
    return r;
  });
}

/** Points placed beside the usual round head, moved out (or in) with the side of the head being dressed. */
const besideHead = (pts: Pt[]): Pt[] => pts.map(([x, y, z]) => [x + Math.sign(x) * headDelta(y).rx, y, z]);

/**
 * A plate over each cheek, from the brow band down to the jaw: hugging the side of the head being dressed,
 * its foot a little in from its top as the face narrows to the chin.
 */
function cheekGuards(head: Part, c: string, top = 4.2, foot = 1.8) {
  const at = (y: number, out: number) => ringAt(headRings(), y).rx + out;
  for (const s of [-1, 1]) {
    head.shape(c, [
      [s * at(top, 0.2), top, 1.6], [s * at(top, 0.2), top, -1], [s * at(top, 0.62), top, 1.4], [s * at(top, 0.62), top, -0.8],
      [s * at(foot, 0.16), foot, 1.15], [s * at(foot, 0.16), foot + 0.3, -0.6], [s * at(foot, 0.55), foot + 0.2, 0.9],
    ]);
  }
}

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
  const dome = fitted(OVER_HAIR);
  head.loft(c, dome, 10);
  head.loft(band, fitted([[3.85, 3.84, 3.54], [4.45, 3.82, 3.52, -0.02]]), 10);
  cheekGuards(head, c);
  head.shape(crest, sym([[0.42, 7.2, 2.2], [0.42, 8.7, 1.2], [0.42, 9.1, -0.6], [0.42, 8.3, -2.7], [0.42, 7, -2.6]]));
  if (nasal) {
    const f = facet(dome, 10, 3.9, 0, 0.25);
    head.shape(c, sym([[0.38, 3.95, f.z], [0.3, 2.35, f.z + 0.45], [0, 2.2, f.z + 0.6], [0, 3.95, f.z + 0.2]]));
  }
}

/**
 * A hood, low-poly: a cloth shell round the head, from an oval opening that frames the face, swelling over
 * the ears and crown and tapering to a soft point down the back; dark inside round the face; a short mantle
 * round the neck over the shoulders. `trim` bands the opening (a worn hood).
 *
 * The shell is a loft run front to back and laid on its side (turned so the loft's +y runs back, -z): each
 * ring's rx is its half-width, its rz its half-height and its dz how far up its middle is from `mid`. The
 * opening reaches from the brow to just under the chin of a head of these rings.
 */
function lowHood(head: Part, c: string, rings: readonly Ring[], trim?: string) {
  const side: Rot = [-HALF_PI, 0, 0];
  const chin = Math.min(0.6, rings[0][0] + 0.1);
  const brow = 5.3;
  const mid = (brow + chin) / 2;
  const half = (brow - chin) / 2;
  // As much wider as the face is anywhere from the chin to the brow than a round one (a square or pear jaw),
  // so it is framed by the opening, not pushed through the sides; the crown follows a narrower top in.
  let wide = 0;
  for (let y = chin; y <= brow; y += 0.25) wide = Math.max(wide, ringAt(rings, y).rx - ringAt(HEAD_RINGS.round, y).rx);
  const crown = Math.min(0, ringAt(rings, 4.9).rx - ringAt(HEAD_RINGS.round, 4.9).rx);
  // The opening stands out past the hair at the brow, so the face sits back inside the hood.
  const shell: Ring[] = [
    [-3.3, 2.85 + wide, half, 0],
    [-2.4, 3.65 + wide, half + 1, 0.45],
    [-0.5, 4.05 + wide, 3.75, 3.5 - mid],
    [1.5, 3.85 + (wide + crown) / 2, 3.55 + crown, 3.6 - mid],
    [3, 2.75 + crown, 2.75 + crown, 3.9 - mid],
    [4, 1.2, 1.2, 4.15 - mid],
    [4.5, 0.15, 0.15, 4.05 - mid],
  ];
  head.shell(c, shell, 12, { open: "start" }, 0, mid, 0, side);
  // The lining round the face, in shadow.
  const lining: Ring[] = shell.slice(0, 3).map(([y, rx, rz, dz = 0]) => [y + 0.05, rx - 0.14, rz - 0.14, dz]);
  head.shell(tone(c, -0.32), lining, 12, { open: "both", inward: true }, 0, mid, 0, side);
  // A short mantle round the neck and over the shoulders, under the chin at the front.
  head.loft(c, [[-1.15, 3.95 + wide, 3.5, 0.1], [-0.4, 3.8 + wide, 3.35, 0.05], [0.15, 3 + wide, 2.5, -0.4]], 12);
  if (trim) head.shell(trim, [[-3.45, 2.99 + wide, half + 0.12, 0], [-3.12, 2.99 + wide, half + 0.12, 0]], 12, { open: "both" }, 0, mid, 0, side);
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
      head.loft(look.accent, fitted([[4.3, 5.3, 5.05, -0.05], [4.68, 5.3, 5.05, -0.05]]), 14);
      head.loft(look.body, fitted([[4.5, 3.82, 3.52, -0.05], [6.2, 3.22, 2.97, -0.15], [7.8, 2.25, 2.05, -0.4], [9.3, 1.3, 1.2, -0.85], [10.5, 0.55, 0.55, -1.5], [11.1, 0.1, 0.1, -1.95]]), 10);
      head.loft(tone(look.body, -0.08), fitted([[4.65, 3.86, 3.56, -0.05], [5.3, 3.72, 3.44, -0.08]]), 10);
      const f = facet(fitted(OVER_HAIR), 10, 5, 0, 0.3);
      head.shape(look.accent, sym([[0, 5.55, f.z], [0.5, 5, f.z], [0, 4.45, f.z], [0, 5, f.z + 0.25]]));
      return;
    }
    case "hood":
      lowHood(head, look.hatColor ?? look.body, rings);
      return;
    case "leaves": {
      // A wreath: a band of twigs, leaves round it, and a berry.
      head.loft(tone(look.accent, -0.3), fitted([[4.4, 3.8, 3.5], [4.85, 3.8, 3.5]]), 10);
      const d = headDelta(4.85);
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        head.ball(i % 2 ? look.accent : tone(look.accent, -0.1), 0.95, Math.sin(a) * (3.85 + d.rx), 4.85 + (i % 2) * 0.3, Math.cos(a) * (3.55 + d.rz) + d.dz, 0, [1.25, 0.5, 1.25]);
      }
      head.ball("#c8433d", 0.55, 1.5 + d.rx * 0.4, 5.35, 3.3 + d.rz + d.dz, 1);
      return;
    }
    case "feather": {
      // A soft cap pushed back, a band, and a long feather sweeping up behind.
      const c = look.body;
      head.loft(c, fitted([[4.2, 3.84, 3.54], [5.2, 3.9, 3.6, -0.15], [6.3, 3.35, 3.1, -0.4], [7, 2.15, 2.05, -0.65], [7.35, 0.6, 0.6, -0.8]]), 10);
      head.loft(tone(c, -0.08), fitted([[4.12, 3.9, 3.6], [4.6, 3.92, 3.62]]), 10);
      head.shape(look.accent, [[-2.3, 5.6, -1.6], [-2.75, 5.6, -1.8], [-3.2, 8.4, -2.9], [-3.55, 9.6, -3.6], [-3.8, 10.6, -4.5], [-3.0, 8.6, -2.5], [-2.9, 7.4, -2.1]]);
      return;
    }
    case "circlet": {
      const band = fitted([[4.3, 3.66, 3.36], [4.75, 3.66, 3.36]]);
      head.loft(look.accent, band, 10);
      const f = facet(band, 10, 4.5, 0, 0.2);
      head.glowBall("#7fe3ff", 0.55, 0, 4.6, f.z);
      return;
    }
    case "brim": {
      // A round crown on a wide brim, the hair showing under it.
      const c = look.hatColor ?? look.body;
      head.loft(c, fitted([[4.9, 5.5, 5.3, -0.05], [5.25, 5.5, 5.3, -0.05]]), 14);
      head.loft(c, fitted([[5, 3.62, 3.35, -0.05], [6.6, 3.35, 3.1, -0.1], [7.9, 3.05, 2.82, -0.12], [8.3, 2.4, 2.25, -0.12], [8.45, 0.5, 0.5, -0.12]]), 10);
      head.loft(look.accent, fitted([[5.25, 3.7, 3.42, -0.05], [5.9, 3.62, 3.36, -0.07]]), 10);
      return;
    }
    case "turban": {
      const c = look.hatColor ?? look.accent;
      head.loft(c, fitted([[4, 3.8, 3.5], [5, 4.18, 3.88, -0.1], [6.4, 3.92, 3.62, -0.15], [7.4, 2.8, 2.6, -0.15], [7.95, 1, 1, -0.1]]), 10);
      head.loft(tone(c, -0.08), fitted([[5.6, 4.15, 3.85, -0.12], [6.05, 4.05, 3.75, -0.14]]), 10);
      head.ball(c, 1.15, 0.6, 7.95, -0.3, 1);
      const f = facet(fitted([[5, 4.18, 3.88, -0.1], [6.4, 3.92, 3.62, -0.15]]), 10, 5.5, 0, 0.2);
      head.ball(look.accent, 0.55, 0, 5.5, f.z, 0);
      return;
    }
    case "kerchief": {
      // Tied close over the hair, knotted at the back with two tails.
      const c = look.hatColor ?? look.accent;
      head.loft(c, fitted(grown(OVER_HAIR, -0.05)), 10);
      // The knot and its tails stay on the back of the head, however deep it is.
      const d = headDelta(4.9);
      const back = d.dz - d.rz;
      head.ball(tone(c, -0.08), 0.7, 0, 4.9, -3.55 + back, 1);
      head.shape(c, [[0.15, 4.9, -3.5 + back], [0.65, 4.9, -3.65 + back], [1.45, 2.9, -3.75 + back], [1.95, 3.05, -3.75 + back], [1.7, 2.6, -3.85 + back]]);
      head.shape(tone(c, -0.08), [[-0.15, 4.9, -3.5 + back], [-0.6, 4.9, -3.65 + back], [-0.95, 3.3, -3.75 + back], [-1.4, 3.4, -3.75 + back]]);
      return;
    }
    case "greathelm": {
      // A great helm over the whole head, its front pushed out over the nose, a slit for the eyes, breaths
      // below, and a crest.
      const c = look.hatColor ?? "#8b95a5";
      // Down past the chin of a long face or a pointed one.
      const low = Math.min(0, headRings()[0][0] - 0.35);
      // Its front out over the nose, and deep enough behind to close over the hair at the nape.
      const helm = fitted([[0.1 + low, 3.1, 3.2, 0.3], [1.4, 3.88, 3.8, 0.35], [3.2, 3.98, 3.87, 0.2], [5.4, 3.8, 3.55, -0.1], [6.7, 3.05, 2.85, -0.1], [7.5, 1.75, 1.6, -0.1], [7.85, 0.4, 0.4, -0.1]]);
      head.loft(c, helm, 10);
      head.loft(tone(c, -0.1), fitted([[low, 3.2, 3.3, 0.3], [0.5 + low, 3.45, 3.5, 0.33]]), 10);
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
      head.loft(look.accent, fitted([[4.3, 3.74, 3.44], [4.8, 3.74, 3.44]]), 10);
      for (const s of [-1, 1]) {
        // Each horn curls out and up from the band.
        head.loft(look.accent, [[0, 0.85, 0.85], [1.2, 0.7, 0.7, 0.25], [2.3, 0.45, 0.45, 0.8], [3.1, 0.12, 0.12, 1.5]], 6, s * (3.2 + headDelta(5.2).rx), 5.2, 0, [0, 0, -s * 0.7]);
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
    const helm = fitted([[2.2, 3.82, 3.55, 0.12], [3.95, 3.86, 3.56], [5.4, 3.74, 3.46, -0.05], [6.7, 3.02, 2.82, -0.1], [7.5, 1.7, 1.6, -0.1], [7.8, 0.35, 0.35, -0.1]]);
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
      head.shape(GEAR.iron, besideHead([[s * 3.35, 2.4, 1.3], [s * 3.4, 2.4, -1.2], [s * 2.95, 0.9, 0.8], [s * 3.05, 1, -0.6], [s * 3.8, 2.4, 1], [s * 3.75, 2.2, -0.9]]));
      head.loft(GEAR.bone, [[0, 0.85, 0.85], [1.2, 0.7, 0.7, 0.25], [2.3, 0.45, 0.45, 0.75], [3.1, 0.1, 0.1, 1.4]], 6, s * (3.3 + headDelta(5.9).rx), 5.9, 0, [0, 0, -s * 0.55]);
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
  const rings = chestRings(sh);
  torso.cyl(skin, 1, 1.15, 1.6, 0, 6.6, 0, 6);
  torso.loft(cloth, rings);
  if (belt) torso.loft(belt, [around(rings, 0.85, 0.1, 0.02), around(rings, 1.75, 0.1, 0.05)]);
  return rings;
}

/** The low-poly chest's rings, hips to neck, for shoulders `sh` as broad as the girth (see lowChest). */
function chestRings(sh: number): Ring[] {
  const hip = m.hips;
  // Down at the hips the clothes come out over the tops of the thighs, so the legs don't poke through at the sides.
  return [[-0.6, Math.max(2.85 * hip, thighReach(-0.6)), 1.95 + (hip - 1) * 0.6, 0], [0.4, Math.max(2.6 * hip, thighReach(0.4)), 1.8 + (hip - 1) * 0.5, 0], [1.6, 2.45 * (1 + hip) * 0.5, 1.7, 0.05], [3.6, 3.3 * (1 + sh) * 0.5, 2.05, 0.15], [5.3, 4.05 * sh, 2, 0.05], [6.1, 3.1 * sh, 1.6, -0.05], [6.5, 1.4, 1.2, 0]];
}

/**
 * A point on the front of the low-poly chest (`rings`) at `x` across and `y` up, `out` further out along the
 * surface, and which way the surface faces there (radians about y, 0 straight ahead): where to lay a chain or
 * pin a badge so it lies on the chest, not in it.
 */
function onChest(rings: readonly Ring[], x: number, y: number, out: number): { at: Pt; yaw: number } {
  const r = ringAt(rings, y);
  const u = Math.min(0.95, Math.abs(x) / r.rx);
  const z = r.rz * Math.sqrt(1 - u * u);
  // The ellipse's outward normal at (x, z): (x / rx², z / rz²).
  const nx = x / (r.rx * r.rx);
  const nz = z / (r.rz * r.rz);
  const n = Math.hypot(nx, nz);
  return { at: [x + (nx / n) * out, y, z + r.dz + (nz / n) * out], yaw: Math.atan2(nx, nz) };
}

/**
 * An amulet worn over the low-poly chest, big enough to read on a figure across the harbour: a chain from the
 * shoulders down the front to a pendant at mid-chest, below the chin (and a hood's mantle), or a badge pinned
 * over the heart. `over` is how far whatever is worn stands out past the chest (a hauberk's plates, a
 * greatcoat's buttons), so it lies on top of them. A long beard down the chest would hide it, so with one the
 * pendant hangs (or the badge is pinned) on the front of the beard and swings with it. The stone glows in the
 * item's rarity colour.
 */
function lowAmulet(torso: Part, ref: string, trim: string, sh: number, over: number) {
  const rings = chestRings(sh);
  const lift = over + 0.2;
  // The part it is drawn on, where on it the pendant hangs from (or the badge is pinned), and which way that
  // faces; `put` is a frame there: `dx` across, `dy` up, `dz` out.
  const beard = beardFront;
  const on = beard?.part ?? torso;
  const { at, yaw } = beard ? { at: [beard.at[0], beard.at[1], beard.at[2] + 0.1] as Pt, yaw: 0 } : ref === "badge" ? onChest(rings, 1.75, 3.05, lift) : onChest(rings, 0, 3.2, lift);
  const rot: Rot = [0, yaw, 0];
  const put = (dx: number, dy: number, dz: number): [number, number, number] => [at[0] + Math.cos(yaw) * dx + Math.sin(yaw) * dz, at[1] + dy, at[2] - Math.sin(yaw) * dx + Math.cos(yaw) * dz];
  if (ref === "badge") {
    // The Harbormaster's Badge: a crowned heart on a gold boss, facing out.
    spot(on, GEAR.gold, 1.05, 1.15, 0.3, ...put(0, 0, 0), rot);
    // A heart: two lobes and a point, a little proud of the boss.
    for (const s of [-1, 1]) on.glowBall(trim, 0.38, ...put(s * 0.3, 0.12, 0.25));
    on.glowBox(trim, 0.6, 0.6, 0.25, ...put(0, -0.2, 0.25), [0, yaw, Math.PI / 4]);
    // Its crown: three gold points over the top.
    for (const s of [-1, 0, 1]) on.cone(GEAR.gold, 0.2, s === 0 ? 0.6 : 0.45, ...put(s * 0.42, 1.05 + (s === 0 ? 0.08 : 0), 0.2), 4, rot);
    return;
  }
  if (beard) {
    // Over a beard, the chain comes out from under it at the top.
    for (const s of [-1, 1]) strut(on, GEAR.gold, put(s * 0.95, 1.6, -0.15), put(0, 0, 0), 0.17);
  } else {
    // The chain: from either shoulder, close round the neck, down over the chest to where the pendant hangs.
    const path: [number, number][] = [[1.45, 5.85], [1.4, 5.1], [1.15, 4.2], [0.65, 3.45], [0, 3.2]];
    for (const s of [-1, 1]) {
      for (let i = 0; i + 1 < path.length; i++) {
        const a = onChest(rings, s * path[i][0], path[i][1], lift - 0.05).at;
        const b = onChest(rings, s * path[i + 1][0], path[i + 1][1], lift - 0.05).at;
        strut(torso, GEAR.gold, a, b, 0.17);
      }
    }
  }
  if (ref === "keystone") {
    // The Lighthouse Key, hanging by its bow: a gold ring with the stone in it, a shaft, and two teeth.
    on.ring(GEAR.gold, 0.55, 0.18, ...put(0, -0.5, 0.05), rot);
    on.glowBall(trim, 0.4, ...put(0, -0.5, 0.1));
    on.box(GEAR.gold, 0.34, 1.25, 0.3, ...put(0, -1.55, 0), rot);
    on.box(GEAR.gold, 0.55, 0.3, 0.3, ...put(0.4, -2, 0), rot);
    on.box(GEAR.gold, 0.4, 0.3, 0.3, ...put(0.33, -1.62, 0), rot);
    return;
  }
  // The Lucky Lanyard (or any other amulet): a stone in a gold setting.
  spot(on, GEAR.gold, 0.75, 0.9, 0.3, ...put(0, -0.7, 0), rot);
  on.glowBall(trim, 0.55, ...put(0, -0.7, 0.2));
}

/**
 * A ring on the low-poly mitt (lowHand), round the knuckles below the thumb: the Mooring Bands, one in the
 * trim's colour on each hand; any other, a gold band on the right hand with a stone on the outside that glows
 * in the trim's colour.
 */
function lowRing(armR: Part, armL: Part, ref: string, trim: string) {
  const band: Ring[] = [[-5.82, 1.2, 1.15, 0.15], [-5.42, 1.26, 1.2, 0.13]];
  if (ref === "bands") {
    for (const arm of [armR, armL]) arm.loft(trim, band, 8);
    return;
  }
  armR.loft(GEAR.gold, band, 8);
  // The stone, out to the side and a little forward (the right hand is s = -1: outward is -x).
  const a = 0.75;
  armR.ball(GEAR.gold, 0.44, -Math.sin(a) * 1.3, -5.62, Math.cos(a) * 1.22 + 0.14);
  armR.glowBall(trim, 0.42, -Math.sin(a) * 1.6, -5.62, Math.cos(a) * 1.5 + 0.14);
}

/**
 * How far out from the middle the outside of a thigh reaches at height `y` (the torso's own units; the hips are
 * at 0), with room for trousers or greaves over it: what the clothes at the waist have to cover.
 */
function thighReach(y: number): number {
  const fuller = 0.5 + 0.5 * m.hips;
  return 1.7 * m.hips + (ringAt(THIGH, y).rx + 0.14) * fuller + 0.12;
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
    // The skirts flare over the hips, wider for wide ones, and out over the tops of the thighs.
    const rings: [number, number, number, number][] = [
      [1.4, 2.85 * (1 + m.hips) * 0.5 + grow, 2 + grow, 0.05],
      [0.2, Math.max(3.1 * m.hips, thighReach(0.2) + 0.1) + grow, 2.25 + grow, 0],
      [-4.6, Math.max(3.5 * m.hips, thighReach(0.2) + 0.25) + grow, 2.7 + grow, -0.2],
    ];
    for (const [y, rx, rz, dz] of rings) {
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
const INK_CELL = 0.13;

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
function inkOn(part: Part, surface: InkSurface, cols: number, view: InkView, cells: Map<number, number>) {
  const { half, top, cell, rings } = surface;
  const back = view === "b";
  // Seen from the front, the grid's left is the figure's right (-x); from the back, its left.
  const xAt = (c: number) => (back ? half - c * cell : -half + c * cell);
  /** The triangles of each ink (a colour at a level), to lie over the skin as see-through as it was inked. */
  const byInk = new Map<number, number[]>();
  for (const [at, ink] of cells) {
    const c = at % cols;
    const r = Math.floor(at / cols);
    const yTop = top - r * cell;
    const yBottom = yTop - cell;
    const xa = Math.min(xAt(c), xAt(c + 1));
    const xb = Math.max(xAt(c), xAt(c + 1));
    if (Math.abs((xa + xb) / 2) >= inkAcross(surface, (yTop + yBottom) / 2)) continue;
    if (!byInk.has(ink)) byInk.set(ink, []);
    const out = byInk.get(ink)!;
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
  for (const [ink, positions] of byInk) {
    if (positions.length) part.inkGeometry(INK_COLORS[inkColorOf(ink) - 1] ?? INK_COLORS[0], inkLevelOf(ink) / INK_LEVELS, positions);
  }
}

/** The colour a cell of ink shows on this skin: its ink laid over the skin, as strongly as it was inked. */
export function inkOver(skin: string, cell: number): string {
  const ink = INK_COLORS[inkColorOf(cell) - 1] ?? INK_COLORS[0];
  return `#${new THREE.Color(skin).lerp(new THREE.Color(ink), inkLevelOf(cell) / INK_LEVELS).getHexString()}`;
}

/** Draw the tattoos a hero drew on `region`, front and back, on the part it lies on. */
function inkPart(part: Part, region: InkRegion, ink: Ink) {
  const surface = inkSurface(region, chosen);
  const { cols } = INK_REGIONS[region];
  for (const view of ["f", "b"] as const) {
    const cells = decodeInk(ink[`${region}.${view}`], cols);
    if (cells.size) inkOn(part, surface, cols, view, cells);
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
function drawHeld(id: string, b: Biped, trim: string, look: Look, shield: boolean, icon?: string): { arm?: number; tilt?: number } {
  // Low-poly, a weapon with an icon is held as that icon's model: what is in the hand is what is in the bag.
  const fromIcon = lowPoly && icon ? heldGear(icon, b, trim, shield) : null;
  if (fromIcon) return fromIcon;
  const w = b.heldR;
  const shaft = (c: string, h: number, y: number) => w.cyl(c, 0.42, 0.42, h, 0, y, 0, 6);
  const dagger = (p: Part) => {
    p.box(GEAR.wood, 0.7, 1.6, 0.7, 0, 0.1, 0);
    p.box(trim, 2, 0.5, 0.9, 0, 1, 0);
    p.box(GEAR.steel, 0.9, 3.4, 0.4, 0, 2.9, 0);
    p.box(GEAR.shine, 0.5, 0.9, 0.4, 0, 5, 0);
  };
  /** Two points mirrored across the blade's flat (x), `t` either side of it. */
  const flat = (t: number, y: number, z: number): Pt[] => [[t, y, z], [-t, y, z]];
  const axe = (band: string) => {
    if (lowPoly && gear(w, "pager-axe", band, HOLD["pager-axe"])) {
      return;
    }
    shaft(GEAR.wood, 14, 3.4);
    w.box(GEAR.steel, 0.5, 4, 2.6, 0, 9.4, 1.7);
    w.box(GEAR.shine, 0.52, 5, 0.8, 0, 9.4, 3.2);
    w.box(GEAR.iron, 0.5, 1.4, 1.2, 0, 9.4, -0.9);
    w.cyl(band, 0.6, 0.6, 0.8, 0, 7, 0, 6);
  };
  const lantern = (y: number, z: number) => {
    if (lowPoly) {
      // A round iron base, glowing glass between four slim posts, a band and a domed roof with a knob.
      w.loft(GEAR.iron, [[y - 1.35, 0.95, 0.95], [y - 0.95, 1.02, 1.02]], 8, 0, 0, z);
      w.glowLoft("#ffd98a", [[y - 0.95, 0.72, 0.72], [y + 0.95, 0.72, 0.72]], 8, 0, 0, z);
      for (let k = 0; k < 4; k++) {
        const a = ((k + 0.5) * Math.PI) / 2;
        w.cyl(GEAR.iron, 0.12, 0.12, 1.9, Math.sin(a) * 0.82, y, z + Math.cos(a) * 0.82, 6);
      }
      w.loft(GEAR.iron, [[y + 0.95, 1.02, 1.02], [y + 1.25, 0.95, 0.95], [y + 1.75, 0.55, 0.55], [y + 2.05, 0.15, 0.15]], 8, 0, 0, z);
      w.ball(GEAR.iron, 0.24, 0, y + 2.15, z, 0);
      return;
    }
    w.box(GEAR.iron, 1.7, 0.4, 1.7, 0, y + 1.2, z);
    w.cone(GEAR.iron, 1, 0.7, 0, y + 1.7, z);
    w.glowBox("#ffd98a", 1.3, 1.9, 1.3, 0, y, z);
    for (const [x, zz] of [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]]) w.box(GEAR.iron, 0.25, 2, 0.25, x, y, z + zz);
    w.box(GEAR.iron, 1.7, 0.4, 1.7, 0, y - 1.2, z);
  };
  switch (id) {
    case "sword":
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
      if (lowPoly) {
        // A knobbly cudgel, thin at the grip and swelling to a rounded head, with knots in it.
        w.loft(GEAR.wood, [[-1.2, 0.45, 0.45], [1.5, 0.5, 0.5], [3.6, 0.78, 0.75], [5.4, 1.05, 1], [6.2, 1.12, 1.08], [6.45, 0.6, 0.6]], 8);
        for (const [r, x, y, z] of [[0.42, 0.85, 5, 0.35], [0.38, -0.8, 3.9, -0.4], [0.35, 0.2, 5.75, -0.95]]) w.ball(tone(GEAR.wood, -0.12), r, x, y, z, 0);
        return { tilt: 0.5 };
      }
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
      for (const s of [-1, 1]) {
        if (lowPoly) p.ball("#c9b58a", 0.55, -0.3, 1.2, 0.6 + s * 3.2, 1);
        else p.cyl("#c9b58a", 0.5, 0.5, 0.3, -0.3, 1.2, 0.6 + s * 3, 8, [HALF_PI, 0, 0]);
      }
      return {};
    }
    case "pack": {
      // A big pack on the back, with a rolled blanket on top.
      const t = b.torso;
      if (lowPoly) {
        // A rounded leather sack on the back, a flap over its top, a bedroll strapped on above, straps over the
        // shoulders and down the chest.
        const strap = "#5f3f24";
        t.loft("#7a5230", [[0.7, 2.3, 1.05], [2.2, 2.75, 1.35], [4.4, 2.7, 1.35], [5.9, 2.05, 1.05], [6.25, 1, 0.6]], 10, 0, 0, -3.25);
        const flapPts: Pt[] = [];
        for (const [y, rx, rz] of [[6.15, 1.65, 1], [5.6, 2.35, 1.3], [4.2, 2.8, 1.45]]) {
          for (let deg = 110; deg <= 250; deg += 28) {
            const a = (deg / 180) * Math.PI;
            flapPts.push([Math.sin(a) * rx, y, Math.cos(a) * rz - 3.25]);
          }
        }
        t.shape(strap, flapPts);
        t.ball(GEAR.gold, 0.4, 0, 4.15, -4.78, 0);
        t.cyl(look.accent, 1.05, 1.05, 5.6, 0, 6.95, -3, 10, [0, 0, HALF_PI]);
        for (const x of [-1.6, 1.6]) t.cyl(strap, 1.13, 1.13, 0.35, x, 6.95, -3, 10, [0, 0, HALF_PI]);
        for (const s of [-1, 1]) {
          t.shape(strap, [[s * 1.8, 6, -1.7], [s * 2.4, 6, -1.7], [s * 1.85, 6.68, 0], [s * 2.45, 6.58, 0], [s * 1.8, 6, 1.6], [s * 2.4, 6, 1.6], [s * 1.85, 6.86, 0], [s * 2.45, 6.76, 0]]);
          t.shape(strap, [[s * 1.75, 5.75, 1.82], [s * 2.35, 5.75, 1.72], [s * 1.75, 3, 2.18], [s * 2.35, 3, 2.08], [s * 1.75, 5.75, 2.02], [s * 2.35, 5.75, 1.92], [s * 1.75, 3, 2.38], [s * 2.35, 3, 2.28]]);
        }
        return {};
      }
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
      if (lowPoly) {
        // A woven bowl, banded, with a rim and a round handle, full of greens.
        const wicker = "#b98b5a";
        p.loft(wicker, [[-2.75, 1.45, 1.45], [-1.6, 1.95, 1.95], [-0.55, 2.1, 2.1]], 10, 0, 0, 0.8);
        for (const y of [-2.05, -1.3]) p.loft(tone(wicker, -0.12), [[y, 1.86, 1.86], [y + 0.25, 1.92, 1.92]], 10, 0, 0, 0.8);
        p.loft("#8a6a44", [[-0.72, 2.18, 2.18], [-0.32, 2.18, 2.18]], 10, 0, 0, 0.8);
        p.ring("#8a6a44", 1.7, 0.2, 0, -0.4, 0.8);
        for (const [x, z] of [[-0.8, 0.4], [0.7, 0.5], [0, 1.5]]) p.ball("#6fae4a", 0.9, x, -0.35, z, 1, [1, 0.75, 1]);
        return {};
      }
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
      if (lowPoly) {
        // A tall shield, rounded at the shoulders and pointed at the foot: a steel rim, its face in the accent,
        // a steel band across it.
        const turn: Rot = [0, 0.35, 0];
        const outline: [number, number][] = [[-2.3, 3.9], [2.3, 3.9], [2.55, 3.1], [2.55, -3.4], [1.9, -4.1], [0, -4.45], [-1.9, -4.1], [-2.55, -3.4], [-2.55, 3.1]];
        const plate = (k: number, z0: number, z1: number): Pt[] => outline.flatMap(([x, y]): Pt[] => [[x * k, y * k, z0], [x * k, y * k, z1]]);
        s.shape("#6f7480", plate(1, -0.35, 0.15), 0.4, -2.6, 1.9, turn);
        s.shape(look.accent, plate(0.84, 0.12, 0.36), 0.4, -2.6, 1.9, turn);
        s.shape(GEAR.steel, [[-2.2, 0.55, 0.3], [2.2, 0.55, 0.3], [-2.2, 1.3, 0.3], [2.2, 1.3, 0.3], [-2.2, 0.55, 0.5], [2.2, 0.55, 0.5], [-2.2, 1.3, 0.5], [2.2, 1.3, 0.5]], 0.4, -2.6, 1.9, turn);
        return { tilt: 0.25 };
      }
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
  // Low-poly, it is its icon's model.
  if (lowPoly && HOLD[icon] && gear(arm, icon, trim, HOLD[icon])) return;
  const turn = ON_ARM;
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
          inkPart(thigh, right ? "thighR" : "thighL", chosen.ink);
          inkPart(shin, right ? "shinR" : "shinL", chosen.ink);
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
  // Low-poly, it lies over whatever is worn (a hauberk's plates, a greatcoat's buttons, a tunic's placket), and
  // is drawn once the head is, in case a long beard is in its way.
  const amuletOver = greatcoat ? 0.45 : body ? 0.36 : undressed ? 0.04 : 0.14;
  if (amulet && !lowPoly) {
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
          if (chosen?.ink) inkPart(arm, region, chosen.ink);
        } else if (inkedArms) {
          // Sleeves rolled up, to show off the ink on the forearms.
          lowRolledSleeve(arm, look.skin, cloth);
          inkPart(arm, region, chosen!.ink!);
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
  if (ring && lowPoly) {
    lowRing(armR, armL, ring.ref, trim("ring"));
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

  if (amulet && lowPoly) lowAmulet(torso, amulet.ref, trim("amulet"), m.shoulders / m.girth, amuletOver);

  // Hands: a hero's weapon (signature weapons that have no shape of their own are drawn as the one they are like).
  const shield = outfit?.off_hand;
  if (shield) drawShield(armL, shield.ref, shield.icon, trim("off_hand"));
  if (rodInHand) {
    // A townsperson, or a hero with nothing in hand, has no trim for it: the look's accent instead.
    apply(b, drawHeld("rod", b, outfit?.main_hand ? trim("main_hand") : look.accent, look, !!shield));
  } else if (outfit) {
    const held = outfit.main_hand;
    if (held) {
      const like = WEAPONS[held.ref]?.looksLike;
      const grips = extraParts.length;
      apply(b, drawHeld(held.ref, b, trim("main_hand"), look, !!shield, held.icon));
      // Nothing drawn for it (no model, no shape of its own): drawn as the weapon it is like.
      if (b.heldR.empty && extraParts.length === grips && like) apply(b, drawHeld(like, b, trim("main_hand"), look, !!shield));
    }
  } else if (look.weapon !== "none") {
    apply(b, drawHeld(look.weapon, b, look.accent, look, false, STOCK_ICON[look.weapon]));
  }
  if (shield || look.weapon === "axe_shield") b.rest.armL = -0.55;
  return { parts, animate: b.animate, hands: [b.heldR.joint, b.heldL.joint] };
}

/** A lute in its own part's frame: the belly at the origin facing +z, the neck up +y. Its icon's model, low-poly. */
function drawLute(p: Part, trim: string) {
  if (gear(p, "lute", trim, HOLD.lute)) return;
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
  // Its icon's model, slimmed and drawn out to reach from hand to hand: 16 long from foot to mouthpiece.
  if (gear(p, "flute", trim, { grip: [0, -8, 0], scale: [0.45, (span + 1.6) / 16, 0.45], at: [0, -0.8, 0] })) return;
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

// ---------- giants ----------

/**
 * A big two-legged figure: built on a person's joints with the proportions `measures` (see biped), then
 * the whole of it grown by `grow`. The outline is thinned to match, so it is as fine as anyone else's.
 */
function giant(top: THREE.Group, parts: Part[], measures: Measures, grow: number): Biped {
  m = measures;
  edge /= grow;
  top.scale.setScalar(grow);
  return biped(top, parts);
}

/**
 * Stoop a biped forward by `lean` radians at the hips, its head lifted back to look ahead and its arms hanging
 * `reach` further forward than they would: a hulking carriage. Down, it lies flat like anyone.
 */
function stooped(b: Biped, lean: number, reach: number): (a: Anim) => void {
  return (a) => {
    b.animate(a);
    if (a.lying) {
      b.torso.joint.rotation.x = 0;
      return;
    }
    const k = lean * (1 - a.sitting);
    b.torso.joint.rotation.x = k;
    b.head.joint.rotation.x -= k * 0.9;
    for (const arm of [b.armR, b.armL]) arm.joint.rotation.x -= k + reach;
  };
}

/** A great bare foot, flat on the ground, with three blunt toes (or claws). */
function giantFoot(foot: Part, skin: string, nail: string, w: number, long: number, claws = false) {
  foot.shape(skin, sym([[w, 0, -1.3], [w * 1.1, 0, long * 0.55], [w * 0.8, 0, long], [0, 0, long * 1.08], [w * 0.85, 1.5, -1.05], [w * 0.85, 1.15, long * 0.45], [0, 0.95, long * 0.95], [0, 1.75, -0.85]]));
  for (const x of [-w * 0.55, 0, w * 0.55]) {
    if (claws) foot.shape(nail, [[x - 0.28, 0, long * 0.95], [x + 0.28, 0, long * 0.95], [x, 0.45, long * 0.95], [x, 0, long * 1.35]]);
    else foot.ball(tone(skin, -0.06), 0.42, x, 0.35, long * 0.98, 0, [1, 0.8, 1]);
  }
}

/**
 * An ogre: half again as broad as a brute and a head taller, with a great hanging belly, a small bald head
 * sunk between the shoulders under a heavy brow, tusks up from an underbite, a fur kilt, and an iron-banded
 * club the length of a man.
 */
function ogre(top: THREE.Group): Rig {
  const parts: Part[] = [];
  const b = giant(top, parts, { legs: 0.85, girth: 1.4, shoulders: 1.5, hips: 1.3, head: 1 }, 1.3);
  const skin = "#b3a46a";
  const dark = tone(skin, -0.12);
  const fur = "#6e4f30";
  const leather = "#5a3d22";
  // Short tree-trunk legs and wide bare feet.
  for (const [thigh, shin, foot] of [[b.thighR, b.shinR, b.footR], [b.thighL, b.shinL, b.footL]] as const) {
    lowLeg(thigh, shin, skin);
    shin.ball(dark, 0.95, 0, 0.1, 0.55, 0, [1, 0.8, 0.8]);
    giantFoot(foot, skin, GEAR.bone, 1.65, 2.9);
  }
  // The trunk: hips, a belly hanging out in front, a barrel of a chest, shoulders like a yoke and a hump of
  // muscle behind the neck.
  const t = b.torso;
  const trunk: Ring[] = [[-0.8, 4.3, 3.1, 0.2], [0.5, 4.7, 3.7, 0.65], [2, 5, 4, 0.95], [3.5, 5.05, 3.5, 0.55], [4.9, 6.2, 3.1, 0.05], [6, 5.5, 2.8, -0.25], [6.9, 2.9, 2.2, -0.2]];
  t.loft(skin, trunk, 10);
  // A paler belly and a navel.
  t.shape(tone(skin, 0.07), sym([[2.4, 0.6, 4.1], [2.7, 2, 4.6], [2.2, 3.4, 3.9], [0, 0.4, 4.45], [0, 2, 5.05], [0, 3.5, 4.15]]));
  t.ball(dark, 0.32, 0, 1.6, 5.0);
  // The fur kilt, round the hips and over the tops of the thighs, a rawhide belt and a bone toggle.
  t.loft(fur, [[-2.1, 5, 3.9, 0.35], [-0.9, 4.75, 3.75, 0.4], [0.35, 4.85, 3.85, 0.62]], 10);
  for (let i = 0; i < 10; i++) {
    const a = ((i + 0.5) / 10) * Math.PI * 2;
    const [x, z] = [Math.sin(a) * 5.05, Math.cos(a) * 4.05 + 0.35];
    t.shape(tone(fur, -0.06), [[x * 0.92, -1.9, z * 0.92], [x, -2.1, z], [x * 1.02 + Math.cos(a) * 0.5, -2.75, z * 1.02 - Math.sin(a) * 0.5], [x * 0.94 - Math.cos(a) * 0.5, -2.2, z * 0.94 + Math.sin(a) * 0.5]]);
  }
  t.loft(leather, [around(trunk, 0.3, 0.12, 0.02), around(trunk, 1.0, 0.12, 0.04)], 10);
  t.shape(GEAR.bone, [[-0.9, 0.5, 4.7], [0.9, 0.5, 4.7], [-0.9, 0.9, 4.95], [0.9, 0.9, 4.95], [0, 0.7, 5.25]]);
  // A shaggy pelt slung over one shoulder.
  t.ball(fur, 1.9, 4.9, 5.7, 0, 0, [1.1, 0.65, 1.25]);
  t.ball(tone(fur, 0.06), 1.4, 3.7, 6.3, -0.3, 0, [1.2, 0.5, 1.2]);
  // The head, small for the body, sat low and forward between the shoulders.
  const h = b.head;
  h.joint.position.set(0, 5.7, 1.5);
  const skull: Ring[] = [[0.1, 2.7, 2.45, 0.7], [1.4, 3.05, 2.75, 0.45], [2.9, 2.85, 2.6, 0.1], [4.2, 2.55, 2.4, -0.1], [5, 1.7, 1.65, -0.15], [5.35, 0.6, 0.6, -0.15]];
  h.loft(skin, skull, 8);
  // A heavy brow over little dark eyes, a broad flat nose, and a wide mouth with the lower jaw jutting.
  h.shape(dark, sym([[2.3, 3.3, 2.25], [2.2, 3.85, 2.25], [0.4, 3.45, 2.85], [0.4, 4, 2.75], [1.3, 3.25, 2.95], [0, 3.55, 2.95]]));
  for (const s of [-1, 1]) {
    h.ball(OUTLINE, 0.34, s * 1.0, 2.95, 2.62);
    h.ball("#ffffff", 0.1, s * 1.0 + 0.1, 3.05, 2.9);
  }
  h.shape(dark, sym([[0.8, 1.95, 2.8], [0.45, 2.85, 2.75], [0.7, 2.0, 3.3], [0, 1.95, 3.55], [0, 2.75, 3.15]]));
  h.box(OUTLINE, 2.4, 0.26, 0.3, 0, 1.2, 3.12);
  h.shape(skin, sym([[1.9, 0.15, 2.75], [1.6, 1.05, 3.05], [0, 0.0, 3.25], [0, 1.0, 3.35]]));
  // Tusks up out of the underbite, past the lip.
  for (const s of [-1, 1]) h.shape(GEAR.bone, [[s * 1.0, 0.85, 3.05], [s * 1.45, 0.85, 3.0], [s * 1.2, 0.85, 3.45], [s * 1.35, 2.05, 3.2]]);
  // Small round ears, low on the head, and a topknot tied with a thong.
  for (const s of [-1, 1]) h.ball(tone(skin, -0.05), 0.75, s * 2.85, 2.55, -0.1, 0, [0.5, 1, 0.85]);
  h.ball("#2a1c14", 0.75, 0, 5.4, -0.4, 0, [1, 0.8, 1]);
  h.loft(leather, [[5.85, 0.45, 0.45, -0.4], [6.15, 0.45, 0.45, -0.4]], 6);
  h.shape("#2a1c14", [[-0.35, 6.1, -0.2], [0.35, 6.1, -0.2], [-0.25, 6.1, -0.7], [0.25, 6.1, -0.7], [0, 4.4, -2.3]]);
  // Great arms, a rawhide bracer on each, and fists like buckets.
  for (const arm of [b.armR, b.armL]) {
    arm.loft(skin, [[1, 1.3, 1.3], [0.2, 1.75, 1.75], [-1.3, 1.5, 1.5], [-2.6, 1.2, 1.25], [-3.6, 1.45, 1.45], [-4.7, 1.3, 1.3]], 8);
    arm.loft(leather, [[-4.5, 1.42, 1.42], [-3.4, 1.58, 1.58]], 8);
    arm.ball(skin, 1.35, 0, -5.6, 0.15, 1, [1, 1.05, 1]);
  }
  // A club: a crooked bough, thick at the head, bound with iron and studded.
  const w = b.heldR;
  const wood = "#7a5530";
  w.loft(wood, [[-1.6, 0.5, 0.5], [1.5, 0.6, 0.6], [4.2, 0.95, 0.95, 0.1], [6.8, 1.4, 1.4, 0.2], [8.7, 1.3, 1.3, 0.15], [9.3, 0.7, 0.7, 0.1]], 7);
  w.loft(GEAR.iron, [[6.1, 1.42, 1.42, 0.18], [6.7, 1.5, 1.5, 0.2]], 7);
  for (const [y, a] of [[7.6, 0.4], [7.9, 2.5], [8.1, 4.6], [5.2, 1.5], [5.4, 3.6]] as const) w.cone(GEAR.iron, 0.3, 0.7, Math.sin(a) * 1.35, y, Math.cos(a) * 1.35 + 0.18, 5, [Math.cos(a) * HALF_PI, 0, -Math.sin(a) * HALF_PI]);
  b.rest.armR = -0.3;
  b.rest.tiltR = 0.75;
  b.rest.armL = -0.15;
  return { parts, animate: stooped(b, 0.18, 0.05) };
}

/**
 * A troll: tall, gaunt and stooped, its arms hanging to its knees and ending in claws; grey-green hide with
 * moss and stony warts on it, a long drooping nose, small yellow eyes, ears out to the sides and fangs up
 * from the jaw. A ragged hide round its hips and nothing in its hands.
 */
function troll(top: THREE.Group): Rig {
  const parts: Part[] = [];
  const b = giant(top, parts, { legs: 1.15, girth: 0.9, shoulders: 1.1, hips: 0.95, head: 1 }, 1.18);
  const skin = "#7f9474";
  const dark = tone(skin, -0.12);
  const moss = "#4e6a33";
  const wart = "#8d8a7a";
  const hide = "#6b5a3e";
  const nail = "#2f2a24";
  for (const [thigh, shin, foot] of [[b.thighR, b.shinR, b.footR], [b.thighL, b.shinL, b.footL]] as const) {
    thigh.loft(skin, [[-2.95, 0.9, 0.95], [-1.4, 1.05, 1.1], [0.2, 1.3, 1.3], [0.85, 0.95, 0.95]], 6);
    // Knobbled knees and stringy shins.
    shin.ball(dark, 0.85, 0, 0, 0.35);
    shin.loft(skin, [[-2.25, 0.75, 0.8], [-1, 0.9, 0.95, -0.1], [0.4, 0.85, 0.9]], 6);
    giantFoot(foot, skin, nail, 1.3, 2.8, true);
  }
  const t = b.torso;
  // A narrow waist, ribs up to a bony chest, and the shoulders high and humped behind.
  const trunk: Ring[] = [[-0.6, 2.75, 1.95], [1, 2.35, 1.7, 0.1], [3, 3.1, 2.2, 0.2], [4.8, 4, 2.4, -0.1], [5.9, 4.7, 2.55, -0.5], [6.7, 3.2, 2.1, -0.45], [7.3, 1.3, 1.2, 0.3]];
  t.loft(skin, trunk, 8);
  for (const y of [2.6, 3.4]) t.shape(dark, sym([[2.4, y, 1.75], [2.4, y + 0.22, 1.8], [1.1, y - 0.35, 2.25], [1.1, y - 0.13, 2.3]]));
  // Moss down its back and over a shoulder, and warts like little stones.
  t.shape(moss, sym([[2.6, 6.4, -2.55], [3.3, 5.5, -2.8], [1.8, 3.2, -2.3], [0, 6.8, -2.6], [0, 3, -2.4], [0, 5, -3.1]]));
  t.ball(moss, 1.2, -3.8, 6.3, -0.3, 0, [1.2, 0.55, 1.4]);
  for (const [x, y, z, r] of [[1.4, 5.6, -2.9, 0.42], [-1.1, 4.4, -2.65, 0.35], [2.2, 4.1, 1.9, 0.3], [-2.9, 5.4, 1.6, 0.34], [0.4, 6.3, -2.8, 0.3]] as const) t.ball(wart, r, x, y, z);
  // A ragged hide about the hips, a flap hanging before and behind.
  t.loft(hide, [[-1.5, 3.05, 2.2, 0.05], [-0.4, 2.95, 2.15], [0.5, 2.7, 2.0, 0.05]], 8);
  for (const s of [-1, 1]) t.shape(tone(hide, -0.05), [[-1.2, -1.2, s * 2.15], [1.2, -1.2, s * 2.15], [-1.1, -1.2, s * 1.9], [1.1, -1.2, s * 1.9], [-0.9, -3.6, s * 2.3], [0.7, -3.9, s * 2.3], [0, -3.4, s * 2.15]]);
  // The head, pushed out ahead on its neck.
  const h = b.head;
  h.joint.position.set(0, 6.7, 1.6);
  const skull: Ring[] = [[0.3, 1.9, 1.8, 0.75], [1.3, 2.55, 2.25, 0.45], [2.9, 2.6, 2.35, 0.05], [4.3, 2.3, 2.2, -0.2], [5.1, 1.45, 1.45, -0.3], [5.45, 0.5, 0.5, -0.3]];
  h.loft(skin, skull, 8);
  // A long nose drooping past the mouth, a ridge of brow, and small yellow eyes under it.
  h.shape(dark, sym([[0.55, 3.35, 2.3], [0.7, 2.4, 2.45], [0.35, 1.6, 3.5], [0, 1.15, 4.35], [0, 3.5, 2.55], [0, 1.9, 4.4]]));
  h.shape(dark, sym([[2.1, 3.65, 1.95], [2.0, 4.05, 1.9], [0.3, 3.75, 2.5], [0.3, 4.15, 2.4], [1.1, 3.55, 2.55]]));
  for (const s of [-1, 1]) h.glowBall("#ffc23a", 0.34, s * 1.05, 3.25, 2.25);
  // A wide slot of a mouth, and fangs up from the jaw.
  h.box(OUTLINE, 2.6, 0.24, 0.3, 0, 0.95, 2.4);
  for (const s of [-1, 1]) h.shape(GEAR.paper, [[s * 0.75, 0.75, 2.35], [s * 1.1, 0.75, 2.3], [s * 0.9, 0.75, 2.7], [s * 0.95, 1.65, 2.45]]);
  // Ears out to the sides and drooping, and a few hanks of mossy hair.
  for (const s of [-1, 1]) h.shape(tone(skin, -0.05), [[s * 2.4, 3.7, 0.2], [s * 2.4, 2.6, 0.2], [s * 2.4, 3.5, -0.6], [s * 4.3, 2.3, -0.9], [s * 4.1, 2.0, -0.7]]);
  for (const [x, z] of [[0, -0.4], [-1.1, -1.2], [1.1, -1.2], [0, -1.9]] as const) h.shape(moss, [[x - 0.45, 5.2, z + 0.3], [x + 0.45, 5.2, z + 0.3], [x, 5.45, z], [x + 0.2 * Math.sign(x || 1), 3.2, z - 1.6]]);
  // Long arms to the knee, knobbed at the elbow, and three-clawed hands.
  for (const arm of [b.armR, b.armL]) {
    arm.loft(skin, [[0.8, 1.05, 1.05], [0.1, 1.2, 1.2], [-1.8, 0.88, 0.92], [-3.4, 0.72, 0.76], [-3.95, 0.9, 0.9], [-5.6, 0.82, 0.84], [-6.7, 0.66, 0.68]], 6);
    arm.ball(wart, 0.32, 0, -3.8, -0.75);
    arm.loft(skin, [[-8.0, 0.65, 0.5, 0.15], [-7.4, 1.05, 0.85, 0.15], [-6.7, 0.75, 0.72]], 6);
    for (const [x, z] of [[-0.55, 0.45], [0, 0.6], [0.55, 0.45]] as const) arm.shape(nail, [[x - 0.2, -7.9, z - 0.2], [x + 0.2, -7.9, z - 0.2], [x, -7.9, z + 0.2], [x, -9.1, z + 0.45]]);
  }
  b.rest.armR = -0.1;
  b.rest.armL = -0.1;
  return { parts, animate: stooped(b, 0.42, 0.1) };
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
    case "ogre":
      return ogre(top);
    case "troll":
      return troll(top);
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
  /**
   * At the oars of a rowboat (a person, seated): where the stroke is, 0 (hands reached forward) to 1 (pulled back
   * in). Whatever the hands held is put down meanwhile, so they can take the oars (see Figure.hands).
   */
  rowing?: number;
}

/** How far below a seat's top a seated figure's origin goes, as a share of its size: its hips, less half a thigh. */
export const SITTING_DROP = 3.7 / FRAME;

export interface Figure {
  /** Stands on its origin, facing +z: place it and turn it about y. */
  readonly root: THREE.Group;
  /** How tall the 22-unit frame is in world units: what a sprite's height used to be. */
  setSize(size: number): void;
  update(pose: FigurePose): void;
  /** A person's fists, right then left, for putting oars in; null for a creature. */
  hands(): [THREE.Object3D, THREE.Object3D] | null;
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
  beardFront = null;
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
    ink: fadeable(inkMaterial(), fade, "gq-figure-ink"),
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
  /** Whether what the hands hold is put away (at the oars). */
  let heldAway = false;
  const update = (p: FigurePose) => {
    const dt = last < 0 ? 1 : Math.min(0.1, Math.max(0, p.time - last));
    last = p.time;
    const want = p.walking ? Math.sin(p.stride * 3.6) : 0;
    swing += (want - swing) * Math.min(1, dt * 20);
    const rowing = p.rowing !== undefined && !!rig.hands && !p.lying;
    const anim: Anim = { t: p.time, swing, breath: Math.sin(p.time * 2.2 + beat), strike: Math.min(1, Math.abs(p.lean) * 2), lying: p.lying, sitting: rowing ? 1 : typeof p.sitting === "number" ? Math.max(0, Math.min(1, p.sitting)) : p.sitting ? 1 : 0, oars: rowing ? Math.max(0, Math.min(1, p.rowing!)) : -1 };
    if (sling) stow(sling, p.walking, anim.strike, dt);
    // At the oars, whatever was in hand is laid down in the boat; it is back in hand once they step ashore.
    if (rig.hands && rowing !== heldAway) {
      heldAway = rowing;
      for (const hand of rig.hands) for (const held of hand.children) held.visible = !rowing;
    }
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
    hands: () => rig.hands ?? null,
    setDim(on) {
      mats.body.color.setScalar(on ? 0.5 : 1);
      mats.glow.color.setScalar(on ? 0.4 : 1);
      mats.ink.color.setScalar(on ? 0.5 : 1);
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
      mats.ink.dispose();
    },
  };
}
