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
import { APPEARANCE_OPTIONS, GARB_PREFIX, HAIR_COLORS, SKIN_TONES, INK_COLORS, INK_LEVELS, INK_REGIONS, RARITY_COLOR, WEAPONS, WEAPON_ICON, appearanceK, decodeInk, inkColorOf, inkLevelOf, wearsLanternHelm, type Appearance, type Ink, type InkRegion, type InkView, type Outfit, type Slot } from "@gantt-quest/world";
import type { Look } from "./looks";
import { torchFlame } from "./torchFlame";
import { buildLowPoly, disposeLowPoly, type Dangle, type Spin } from "./gearModels";
import { makeSilhouette, type Silhouette } from "./silhouette";

export const OUTLINE = "#1b1830";
/** Set by makeFigure for the figure being built: a fishing rod goes in its right hand (gilded, for a full Catch Book). */
let rodInHand: boolean | "gilded" = false;
/** The diving set's riveted iron, its brass trim and its rope (see lowDiverHelm, lowDiverPlate). */
const DIVE_IRON = "#5d6064";
const DIVE_BRASS = "#b8893a";
const ROPE = "#b49a62";
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

/**
 * How far a figure's light is eased from its facets toward its rounded normals (see roundNormals): 0 lights each
 * flat face in one tone, 1 shades every piece as smoothly as a pebble. A trace of the facets is kept, so a
 * shape's planes still read.
 */
const SMOOTHING = 0.85;

/**
 * Soft shading: the face's own normal (worked out from the slope of the surface, as flat shading does) mixed
 * toward the rounded normal handed down from the piece's corners, so light rolls over a shoulder or a helmet
 * instead of stepping from face to face.
 */
const SOFTEN = /* glsl */ `
{
  vec3 facet = normalize( cross( dFdx( vViewPosition ), dFdy( vViewPosition ) ) );
  normal = normalize( mix( facet, normal, ${SMOOTHING.toFixed(2)} ) );
}`;

/**
 * Rounded normals for one piece: at each corner, the faces that meet there averaged, each by the angle it makes
 * at that corner (so a box's corner leans equally to its three sides however its faces are cut into triangles).
 * Shared only within the piece, so a sleeve never rounds into the arm it sits on.
 */
function roundNormals(g: THREE.BufferGeometry) {
  const pos = g.getAttribute("position");
  const key = (i: number) => `${Math.round(pos.getX(i) * 1000)},${Math.round(pos.getY(i) * 1000)},${Math.round(pos.getZ(i) * 1000)}`;
  const sums = new Map<string, THREE.Vector3>();
  const corner = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const face = new THREE.Vector3();
  const keys: string[] = [];
  for (let f = 0; f < pos.count; f += 3) {
    for (let k = 0; k < 3; k++) corner[k].fromBufferAttribute(pos, f + k);
    face.subVectors(corner[1], corner[0]).cross(ab.subVectors(corner[2], corner[0]));
    for (let k = 0; k < 3; k++) keys[f + k] = key(f + k);
    if (face.lengthSq() < 1e-14) continue;
    face.normalize();
    for (let k = 0; k < 3; k++) {
      ab.subVectors(corner[(k + 1) % 3], corner[k]);
      ac.subVectors(corner[(k + 2) % 3], corner[k]);
      const angle = ab.angleTo(ac);
      let sum = sums.get(keys[f + k]);
      if (!sum) sums.set(keys[f + k], (sum = new THREE.Vector3()));
      sum.addScaledVector(face, angle);
    }
  }
  const normals = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const sum = sums.get(keys[i]);
    if (sum && sum.lengthSq() > 0) {
      face.copy(sum).normalize();
      normals.set([face.x, face.y, face.z], i * 3);
    }
  }
  g.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
}

/** Lit like the furniture, but never darker than a third of its own colour: nobody vanishes at night. */
function bodyMaterial(): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <normal_fragment_begin>", `#include <normal_fragment_begin>${SOFTEN}`)
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
/**
 * What is worn over what, as a number each piece carries (its `layer`): the legs under the hem of whatever is
 * worn on the body, a hood's mantle over the body and the tops of the arms, and headgear over the hair and the head.
 */
const TIER = { legs: -1, body: 0, mantle: 1, headgear: 2 };
/** The layer whatever is drawn next belongs to (see TIER): set round the drawing of legs and of headgear. */
let tier = TIER.body;
/** How much nearer one layer is drawn than the one under it, in the figure's own units. */
const LAYER_LIFT = 0.3;

/**
 * Layers: a piece on an outer layer is drawn a little nearer the eye in depth only (it does not move or grow on
 * the screen), by its layer's share of LAYER_LIFT at the figure's own scale. So where a helmet and the hair
 * under it nearly touch, or the top of a thigh swings out through a tunic's hem, the outer one is what shows,
 * with no piece resized to make room.
 */
const LAYERED = /* glsl */ `
{
  float lift = layer * ${LAYER_LIFT.toFixed(2)} * length( modelViewMatrix[ 1 ].xyz );
  vec4 nearer = projectionMatrix * ( mvPosition + vec4( 0.0, 0.0, lift, 0.0 ) );
  gl_Position.z = nearer.z / nearer.w * gl_Position.w;
}`;

function fadeable<M extends THREE.Material>(material: M, fade: { value: number }, key: string): M {
  const before = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    before.call(this, shader, renderer);
    shader.uniforms.figureFade = fade;
    shader.vertexShader = shader.vertexShader.replace("void main() {", "attribute float layer;\nvoid main() {").replace("#include <project_vertex>", `#include <project_vertex>${LAYERED}`);
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
  /**
   * Draw each ring up to a point at its +z side (a hood's peak, when the loft is laid on its side): for each ring,
   * lowest first, how far past its half-depth the point reaches, as a share of it. Its sides then put a corner,
   * not a face, at +z, so the point is a point.
   */
  apex?: readonly number[];
}

function loftGeometry(rings: readonly Ring[], sides: number, shape: LoftShape = {}): THREE.BufferGeometry {
  const sorted = [...rings].sort((p, q) => p[0] - q[0]);
  const loops = sorted.map(([y, rx, rz, dz = 0], i) =>
    Array.from({ length: sides }, (_, k) => {
      const a = ((k + (shape.apex ? 0 : 0.5)) / sides) * Math.PI * 2;
      // Drawn up to a point at +z: the corner there all the way, its neighbours a little, the rest not at all.
      const lift = shape.apex ? 1 + (shape.apex[i] ?? 0) * Math.max(0, Math.cos(a)) ** 10 : 1;
      return new THREE.Vector3(Math.sin(a) * rx, y, Math.cos(a) * rz * lift + dz);
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

/** A ring of a hanging loft (see hemmedGeometry): a Ring, and how much of the hem's fall it takes (0 to 1). */
/**
 * A ring of a hanging loft (see hemmedGeometry): a Ring, how much of the hem's fall it takes (0 to 1), and how far
 * either side of the middle it is parted at the front (0, or left out, closed).
 */
type HemRing = readonly [y: number, rx: number, rz: number, dz: number, fall: number, open?: number];

/**
 * Cloth hung in rings stacked up y, open at the bottom and closed at the top: a mantle. Unlike loftGeometry,
 * a corner looks straight along +z (and so one straight back), so the hem can come to a point there; each
 * ring is let down by its `fall` share of `hem(a)`, `a` in radians from +z toward +x. Between rings both
 * parted at the front the cloth is cut there, its two edges each that far from the middle: an opening up the
 * front, closed where a ring is not parted. The cloth is `thick` through, its inside face set in that far and
 * closed to the outside along the hem and the cut, so its edges are a solid's and are outlined like one.
 */
function hemmedGeometry(rings: readonly HemRing[], sides: number, hem: (a: number) => number, thick = 0.14): THREE.BufferGeometry {
  const sorted = [...rings].sort((p, q) => p[0] - q[0]);
  // Each ring runs from its front edge on the +x side round the back to the one on the -x side: on a closed
  // ring the two are the same corner, straight ahead.
  const loopsAt = (inset: number) =>
    sorted.map(([y, rx, rz, dz, fall, open = 0]) => {
      const cut = Math.asin(Math.min(0.9, open / rx));
      return Array.from({ length: sides + 1 }, (_, k) => {
        const a = k === 0 ? cut : k === sides ? Math.PI * 2 - cut : (k / sides) * Math.PI * 2;
        return new THREE.Vector3(Math.sin(a) * (rx - inset), y - fall * hem(a), Math.cos(a) * (rz - inset) + dz);
      });
    });
  const outer = loopsAt(0);
  const inner = loopsAt(thick);
  const out: number[] = [];
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    if (!a.equals(b) && !b.equals(c) && !c.equals(a)) out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };
  // A four-cornered face, `a` to `b` along and `d` to `c` beside them, facing along (b - a) × (d - a).
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => {
    tri(a, b, c);
    tri(a, c, d);
  };
  const last = sorted.length - 1;
  for (let i = 0; i < last; i++) {
    const [lo, hi, inLo, inHi] = [outer[i], outer[i + 1], inner[i], inner[i + 1]];
    for (let k = 0; k < sides; k++) {
      quad(lo[k], lo[k + 1], hi[k + 1], hi[k]);
      quad(inLo[k], inHi[k], inHi[k + 1], inLo[k + 1]);
    }
    if (!sorted[i][5] !== !sorted[i + 1][5]) {
      // Across the front where a parted ring meets a closed one: the top of the opening.
      quad(lo[sides], lo[0], hi[0], hi[sides]);
      quad(inLo[sides], inHi[sides], inHi[0], inLo[0]);
    } else if (sorted[i][5]) {
      // The two edges of the cut, each facing into the opening.
      quad(lo[0], hi[0], inHi[0], inLo[0]);
      quad(lo[sides], inLo[sides], inHi[sides], hi[sides]);
    }
  }
  // The hem, facing down, from the outside face to the inside one.
  for (let k = 0; k < sides; k++) quad(outer[0][k], inner[0][k], inner[0][k + 1], outer[0][k + 1]);
  // The top, closed outside and in.
  const [y, , , dz] = sorted[last];
  const c = new THREE.Vector3(0, y, dz);
  for (let k = 0; k < sides; k++) {
    tri(c, outer[last][k], outer[last][k + 1]);
    tri(c, inner[last][k + 1], inner[last][k]);
  }
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

/**
 * Cut a piece (three corners a face, with its normals) in two at height `y`: what lies above, what lies below,
 * and how far the cut reaches across (x) and through (z) about its middle. Faces that cross the cut are split
 * along it, their normals carried over, so the two halves still shade as one piece where they meet.
 */
function cutAt(g: THREE.BufferGeometry, y: number): { above: THREE.BufferGeometry; below: THREE.BufferGeometry; span: { x: number; z: number; rx: number; rz: number } | null } {
  const pos = g.getAttribute("position");
  const nor = g.getAttribute("normal") as THREE.BufferAttribute | undefined;
  type V = [number, number, number, number, number, number];
  const sides: [number[], number[]] = [[], []];
  const normals: [number[], number[]] = [[], []];
  let [x0, x1, z0, z1] = [Infinity, -Infinity, Infinity, -Infinity];
  const put = (side: 0 | 1, poly: V[]) => {
    for (let i = 1; i + 1 < poly.length; i++) {
      for (const v of [poly[0], poly[i], poly[i + 1]]) {
        sides[side].push(v[0], v[1], v[2]);
        normals[side].push(v[3], v[4], v[5]);
      }
    }
  };
  for (let f = 0; f < pos.count; f += 3) {
    const tri: V[] = [0, 1, 2].map((k) => [pos.getX(f + k), pos.getY(f + k), pos.getZ(f + k), nor ? nor.getX(f + k) : 0, nor ? nor.getY(f + k) : 0, nor ? nor.getZ(f + k) : 0]);
    const over = tri.map((v) => v[1] >= y);
    if (over.every(Boolean)) put(0, tri);
    else if (!over.some(Boolean)) put(1, tri);
    else {
      const up: V[] = [];
      const down: V[] = [];
      for (let k = 0; k < 3; k++) {
        const a = tri[k];
        const b = tri[(k + 1) % 3];
        (over[k] ? up : down).push(a);
        if (over[k] === over[(k + 1) % 3]) continue;
        const t = (y - a[1]) / (b[1] - a[1]);
        const c = a.map((v, i) => v + (b[i] - v) * t) as V;
        c[1] = y;
        up.push(c);
        down.push(c);
        x0 = Math.min(x0, c[0]);
        x1 = Math.max(x1, c[0]);
        z0 = Math.min(z0, c[2]);
        z1 = Math.max(z1, c[2]);
      }
      put(0, up);
      put(1, down);
    }
  }
  const make = (side: 0 | 1) => {
    const out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.Float32BufferAttribute(sides[side], 3));
    if (nor) out.setAttribute("normal", new THREE.Float32BufferAttribute(normals[side], 3));
    return out;
  };
  return { above: make(0), below: make(1), span: x1 >= x0 ? { x: (x0 + x1) / 2, z: (z0 + z1) / 2, rx: (x1 - x0) / 2, rz: (z1 - z0) / 2 } : null };
}

/** How far out from a limb's own line a piece may reach and still be part of the limb (a sleeve, a bracer): it is cut at the joint. Anything wider (a shield) is not. */
const LIMB_REACH = 2.3;

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
  /**
   * A joint part way down this part (an elbow): what is drawn on it below `at` goes to `lower`, which hangs
   * from the joint, and a piece of the limb that crosses the joint is cut in two there (see place).
   */
  private bend: { at: number; lower: Part } | null = null;

  constructor(parent: THREE.Object3D, x = 0, y = 0, z = 0) {
    this.joint.position.set(x, y, z);
    this.joint.add(this.skin);
    parent.add(this.joint);
  }

  /**
   * Give this part a joint at height `at` (an elbow), with `lower` hanging from it: what is drawn on this part
   * from here on, in its own space as before, is shared out between the two (see place).
   */
  jointAt(at: number, lower: Part): this {
    this.bend = { at, lower };
    return this;
  }

  /** `geometry` is centred on its own origin; `glow` draws it unlit, with no outline. */
  private add(geometry: THREE.BufferGeometry, color: string, x: number, y: number, z: number, rot?: Rot, glow = false, rounded = false, outlined = true): this {
    const at = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(...(rot ?? [0, 0, 0]))), ONE);
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    if (flat !== geometry) geometry.dispose();
    flat.deleteAttribute("uv");
    // A square piece's outline is the same shape a little larger all round, grown about its own middle; a
    // rounded one's is pushed out along its faces, once it is known where the piece goes (see put).
    let shell: THREE.BufferGeometry | null = null;
    if (outlined && !glow && !rounded) {
      flat.computeBoundingBox();
      const size = flat.boundingBox!.getSize(new THREE.Vector3());
      shell = flat.clone();
      shell.deleteAttribute("normal");
      shell.scale((size.x + 2 * edge) / size.x, (size.y + 2 * edge) / size.y, (size.z + 2 * edge) / size.z);
      shell.applyMatrix4(at);
    }
    flat.applyMatrix4(at);
    if (!glow) roundNormals(flat);
    const c = new THREE.Color(color);
    // No two pieces of cloth or plate are quite the same shade. (Not what glows, nor the ink of an eye.)
    if (!glow && color !== OUTLINE && color !== "#ffffff") c.offsetHSL((rand() - 0.5) * 0.02, (rand() - 0.5) * 0.08, (rand() - 0.5) * 0.06);
    this.place(flat, shell, c, glow, outlined && !glow && rounded, tier);
    return this;
  }

  /**
   * Where a piece (already in this part's space) goes. On a part with a joint: above it, here; below it, on the
   * lower part; across it, the limb's own pieces (a sleeve, an arm) are cut in two at the joint, with a round
   * of the same colour set in the joint to fill the gap when it bends, and anything else (too wide to be the
   * limb, or only just over the line) goes whole to the side most of it is on.
   */
  private place(flat: THREE.BufferGeometry, shell: THREE.BufferGeometry | null, c: THREE.Color, glow: boolean, inflated: boolean, layer: number) {
    const bend = this.bend;
    if (!bend) return this.put(flat, shell, c, glow, inflated, layer);
    const down = (g: THREE.BufferGeometry | null) => g?.translate(0, -bend.at, 0) ?? null;
    flat.computeBoundingBox();
    const box = flat.boundingBox!;
    const lower = () => bend.lower.put(down(flat)!, down(shell), c, glow, inflated, layer);
    if (box.max.y <= bend.at) return lower();
    if (box.min.y >= bend.at) return this.put(flat, shell, c, glow, inflated, layer);
    const limb = Math.max(-box.min.x, box.max.x, -box.min.z, box.max.z) <= LIMB_REACH && box.max.y - bend.at >= 0.5 && bend.at - box.min.y >= 0.5;
    if (!limb) return (box.max.y + box.min.y) / 2 < bend.at ? lower() : this.put(flat, shell, c, glow, inflated, layer);
    const cut = cutAt(flat, bend.at);
    const cutShell = shell ? cutAt(shell, bend.at) : null;
    flat.dispose();
    shell?.dispose();
    this.put(cut.above, cutShell?.above ?? null, c, glow, inflated, layer);
    bend.lower.put(down(cut.below)!, down(cutShell?.below ?? null), c, glow, inflated, layer);
    if (cut.span && !glow) {
      // The joint: a ball in a round limb, a barrel across a square one, the size of the cut.
      const { x, z, rx, rz } = cut.span;
      const round = inflated ? new THREE.IcosahedronGeometry(1, 1) : new THREE.CylinderGeometry(1, 1, 2, 10).rotateZ(HALF_PI);
      const knuckle = round.index ? round.toNonIndexed() : round;
      knuckle.deleteAttribute("uv");
      if (inflated) knuckle.scale(rx * 0.98, Math.min(rx, rz) * 0.98, rz * 0.98);
      else knuckle.scale(rx * 0.98, rz * 0.98, rz * 0.98);
      knuckle.translate(x, bend.at, z);
      roundNormals(knuckle);
      this.put(knuckle, null, c, false, inflated || !!shell, layer);
    }
  }

  /** Keep a piece on this part: its outline's shell (made here for a rounded piece), and the piece in its colour. */
  private put(flat: THREE.BufferGeometry, shell: THREE.BufferGeometry | null, c: THREE.Color, glow: boolean, inflated: boolean, layer: number) {
    // Its layer on every corner, and on its outline's shell too, so the two stay together in depth.
    const layered = (g: THREE.BufferGeometry) => g.setAttribute("layer", new THREE.BufferAttribute(new Float32Array(g.getAttribute("position").count).fill(layer), 1));
    layered(flat);
    if (inflated) this.hull.push(inflate(flat, edge));
    else if (shell) this.hull.push(layered(shell));
    const n = flat.getAttribute("position").count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3);
    flat.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    (glow ? this.lit : this.solid).push(flat);
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

  /** Cloth hung through `rings` with its hem let down by `hem` (see hemmedGeometry): a mantle. */
  hanging(color: string, rings: readonly HemRing[], sides: number, hem: (a: number) => number): this {
    return this.add(hemmedGeometry(rings, sides, hem), color, 0, 0, 0, undefined, false, true);
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
    const bend = this.bend;
    if (bend) {
      // Each little face of ink goes with the piece of the limb it lies on.
      const [above, below]: number[][] = [[], []];
      for (let f = 0; f < positions.length; f += 9) {
        const face = positions.slice(f, f + 9);
        if ((face[1] + face[4] + face[7]) / 3 >= bend.at) above.push(...face);
        else below.push(face[0], face[1] - bend.at, face[2], face[3], face[4] - bend.at, face[5], face[6], face[7] - bend.at, face[8]);
      }
      if (below.length > 0) bend.lower.inkGeometry(color, alpha, below);
      if (above.length === 0) return this;
      positions = above;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    g.computeVertexNormals();
    const c = new THREE.Color(color);
    const n = positions.length / 3;
    const rgba = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) rgba.set([c.r, c.g, c.b, alpha], i * 4);
    g.setAttribute("color", new THREE.BufferAttribute(rgba, 4));
    g.setAttribute("layer", new THREE.BufferAttribute(new Float32Array(n).fill(tier), 1));
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
  pose?: Carry;
}

/** Turns a model's +x (an axe's blade, a bow's belly, a book's fore-edge) to the front, its face out from the right hand. */
const FORWARD: Rot = [0, -HALF_PI, 0];
/** A shield's turn on the forearm: a little out from the body. */
const ON_ARM: Rot = [0, 0.35, 0];
/** Turns a gun (its barrel up the model, its grip and stock toward -x) to point ahead, grip down. */
const GUN: Rot = [HALF_PI, HALF_PI, 0];
/** And a crossbow (its top toward +z) to point ahead, top up. */
const BOLT: Rot = [-HALF_PI, 0, Math.PI];

/** Each held icon's grip, scaled to stand with the figure: hilts and hafts in the fist, the foot of a staff clear of the ground. */
const HOLD: Record<string, Hold> = {
  // Every blade is held edge forward, its guard fore and aft, so a cut leads with the edge: the models are made
  // flat to the front, and turned in the hand.
  broadsword: { grip: [0, 0.3, 0], scale: 0.72, turn: FORWARD, pose: { tilt: 0.4 } },
  "hammer-drop": { grip: [0, -4, 0], scale: 0.6, turn: FORWARD, pose: { tilt: 0.4 } },
  "wizard-staff": { grip: [0, -3.5, 0], scale: 0.8 },
  "root-staff": { grip: [0, -4.2, 0], scale: 0.8 },
  // Held low on its wrapped grip, so the whirlpool at its head rides above a hat's brim.
  "void-staff": { grip: [0, -6, 0], scale: 0.8 },
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
  // Sea blades, edge forward like the sword; a knuckle bow comes round in front of the fist.
  cutlass: { grip: [0, 0.3, 0], scale: 0.74, turn: FORWARD, pose: { tilt: 0.4 } },
  sabre: { grip: [0, 0.3, 0], scale: 0.7, turn: FORWARD, pose: { tilt: 0.4 } },
  rapier: { grip: [0, 0.2, 0], scale: 0.72, turn: FORWARD, pose: { tilt: 0.55 } },
  dirk: { grip: [0, 0.5, 0], scale: 0.72, turn: FORWARD, pose: { tilt: 0.6 } },
  // Guns and the crossbow: a pistol in the fist, pointing ahead with its muzzle up a little; the long ones
  // gripped at the wrist of the stock and carried across the chest (see LONG_GUNS and heldGear).
  pistol: { grip: [-2.3, -4.8, 0], scale: 0.58, turn: GUN, pose: { tilt: -0.4 } },
  blunderbuss: { grip: [-1.7, -6.6, 0], scale: 0.62, turn: GUN },
  "harpoon-gun": { grip: [-2.4, -6.6, 0], scale: 0.62, turn: GUN },
  "heavy-crossbow": { grip: [0, -6, 0], scale: 0.62, turn: BOLT },
  // One in each fist (see heldGear).
  daggers: { grip: [0, -1.8, 0], scale: 0.53, turn: FORWARD, pose: { tilt: 0.7 } },
  dirks: { grip: [0, 0.5, 0], scale: 0.58, turn: FORWARD, pose: { tilt: 0.7 } },
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
  "boarding-pike": { grip: [0, -6.5, 0], scale: 0.65, turn: FORWARD, pose: { tilt: 0.15 } },
  // Held up in front by the stem.
  "bilge-chalice": { grip: [0, -3, 0], scale: 0.46, at: [0, 0, 0.4], pose: { arm: -0.9 } },
  "round-shield": { grip: [0, 0, 0], scale: 0.39, at: [0.5, -3.4, 1.9], turn: ON_ARM },
  shield: { grip: [0, -0.5, 0], scale: 0.43, at: [0.5, -2.9, 1.95], turn: ON_ARM },
};

/** What a bard plays (see Biped.instrument). */
type Instrument = "lute" | "flute" | "bell" | "accordion";

/** Icons held one in each fist (see heldGear). */
const PAIRED = new Set(["daggers", "dirks", "gaff-hook"]);

/** The icon (so the model) a stock look's weapon is drawn as: a class weapon's own, or the one most like it. */
const STOCK_ICON: Record<string, string> = { ...WEAPON_ICON, sword: "broadsword", bow: "crossbow", cutlass: "cutlass" };

/** Put an icon's model in a part, held as `hold` says, in the trim colour. False when the icon has no model. */
function gear(p: Part, icon: string, trim: string, hold: Hold, inHand = false): boolean {
  const built = buildLowPoly(icon, trim, inHand);
  if (!built) return false;
  const scale = typeof hold.scale === "number" ? new THREE.Vector3().setScalar(hold.scale) : new THREE.Vector3(...hold.scale);
  const at = new THREE.Matrix4().compose(new THREE.Vector3(...(hold.at ?? [0, 0, 0])), new THREE.Quaternion().setFromEuler(new THREE.Euler(...(hold.turn ?? [0, 0, 0]))), scale);
  at.multiply(new THREE.Matrix4().makeTranslation(-hold.grip[0], -hold.grip[1], -hold.grip[2]));
  // What hangs loose (a flail's ball, a lantern) goes on a joint of its own at its pivot, to swing (see
  // swingDangles); one built inside another hangs from its end, a second joint down the same chain.
  const loose: THREE.Object3D[] = [];
  built.model.traverse((o) => {
    if (o.userData.dangle) loose.push(o);
  });
  const outer = new Map<THREE.Object3D, THREE.Object3D | null>();
  for (const group of loose) {
    let up = group.parent;
    while (up && !up.userData.dangle) up = up.parent;
    outer.set(group, up);
  }
  for (const group of loose) group.removeFromParent();
  const made = new Map<THREE.Object3D, { part: Part; pivot: THREE.Vector3; chain: Dangling }>();
  for (const group of loose) {
    const d = group.userData.dangle as Dangle;
    const pivot = new THREE.Vector3(...d.pivot).applyMatrix4(at);
    const rest = new THREE.Vector3(...d.bob).applyMatrix4(at).sub(pivot);
    const above = outer.get(group) ? made.get(outer.get(group)!) : undefined;
    // Each joint is placed in the one above it, which is the hand's frame moved to its own pivot.
    const from = above ? pivot.clone().sub(above.pivot) : pivot;
    const part = new Part(above ? above.part.joint : p.joint, from.x, from.y, from.z);
    part.model(group, new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z).multiply(at));
    disposeLowPoly(group);
    extraParts.push(part);
    const link: Link = { joint: part.joint, rest, size: (d.size ?? 0) * scale.x, weight: d.mass ?? 1, at: new THREE.Vector3(), was: new THREE.Vector3() };
    const clear = d.clear && { from: new THREE.Vector3(...d.clear.from).applyMatrix4(at), to: new THREE.Vector3(...d.clear.to).applyMatrix4(at), r: d.clear.r * scale.x };
    let chain: Dangling;
    if (above) {
      chain = above.chain;
      chain.links.push(link);
      chain.clear = clear ?? chain.clear;
    } else {
      chain = { links: [link], limit: d.limit, clear, placed: false, pivot: new THREE.Vector3() };
      dangles.push(chain);
    }
    made.set(group, { part, pivot, chain });
  }
  // What turns freely (an armillary sphere's inner rings) goes on a joint of its own at its pivot, turned about
  // its axis each frame (see turnSpinners).
  const turning: THREE.Object3D[] = [];
  built.model.traverse((o) => {
    if (o.userData.spin) turning.push(o);
  });
  for (const group of turning) {
    group.removeFromParent();
    const sp = group.userData.spin as Spin;
    const pivot = new THREE.Vector3(...sp.pivot).applyMatrix4(at);
    const axis = new THREE.Vector3(...sp.axis).transformDirection(at);
    const part = new Part(p.joint, pivot.x, pivot.y, pivot.z);
    part.model(group, new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z).multiply(at));
    disposeLowPoly(group);
    extraParts.push(part);
    const own = sp.speed ?? SPIN_SPEED;
    spinners.push({ joint: part.joint, axis, angle: 0, speed: own, own, was: new THREE.Quaternion(), seen: false });
  }
  // What flashes (a bolt of lightning, in several forks) goes on joints of its own, one shown at a time or none
  // (see flashBolts).
  const flashing: THREE.Object3D[] = [];
  built.model.traverse((o) => {
    if (o.userData.flicker) flashing.push(o);
  });
  if (flashing.length > 0) {
    const set: THREE.Object3D[] = [];
    for (const group of flashing) {
      group.removeFromParent();
      const part = new Part(p.joint);
      part.model(group, at);
      disposeLowPoly(group);
      extraParts.push(part);
      set.push(part.joint);
    }
    flickers.push(set);
  }
  p.model(built.model, at);
  disposeLowPoly(built.model);
  return true;
}

/** Something turning freely about an axis in the hand (see Kit.spin): its angle, how fast it turns, and the hand's last turn. */
interface Spinner {
  joint: THREE.Object3D;
  /** The axis it turns about, in the hand's frame. */
  axis: THREE.Vector3;
  angle: number;
  speed: number;
  /** The speed it turns at on its own, and eases back to (see Kit.spin). */
  own: number;
  /** The hand's turn in the world last frame, once it has been `seen`. */
  was: THREE.Quaternion;
  seen: boolean;
}
/** Set by makeFigure for the figure being built: what turns freely in its hands. */
let spinners: Spinner[] = [];
/** Set by makeFigure for the figure being built: each set of shapes in its hands that flash in turn (see Kit.flicker). */
let flickers: THREE.Object3D[][] = [];
/** How many times a second a flashing thing may change, and how often it is dark between flashes. */
const FLASH_RATE = 15;
const FLASH_DARK = 0.45;

/**
 * Flash what flickers in the hand: many times a second one of its shapes shows, or none, picked from the clock
 * (the same for anyone watching, and for a test), so a bolt zaps about the glass, a different fork each time.
 * A slot's length wanders too, so it never settles into a beat.
 */
function flashBolts(sets: THREE.Object3D[][], time: number) {
  const slot = Math.floor(time * FLASH_RATE + Math.sin(time * 2.3) * 1.5);
  sets.forEach((set, k) => {
    const h = Math.abs(Math.sin((slot + 1) * 12.9898 + k * 78.233) * 43758.5453) % 1;
    const pick = h < FLASH_DARK ? -1 : Math.min(set.length - 1, Math.floor(((h - FLASH_DARK) / (1 - FLASH_DARK)) * set.length));
    set.forEach((joint, i) => (joint.visible = i === pick));
  });
}
/** How fast a spinner turns on its own, in radians a second, and how quickly it eases back to that after a jolt. */
const SPIN_SPEED = 0.7;
const SPIN_EASE = 1.4;
/**
 * A hand turning further than this about the axis in one frame (radians) has snapped round, as a figure does when
 * it turns to face a new way: that leaves the ring be, rather than setting it whirling. And how much one frame's
 * turn may add to its speed (radians a second), so a sharp flick sets it going only so fast.
 */
const SPIN_SNAP = 0.8;
const SPIN_KICK = 3;
const _spinQ = new THREE.Quaternion();
const _spinNow = new THREE.Quaternion();
const _spinAxis = new THREE.Vector3();

/**
 * Turn what spins freely: on its own, slowly; and as the hand turns about its axis it stays behind, as a loose
 * ring would, its speed taking up the difference and easing back to its own turn.
 */
function turnSpinners(list: Spinner[], dt: number) {
  for (const sp of list) {
    const hand = sp.joint.parent;
    if (!hand) continue;
    hand.updateWorldMatrix(true, false);
    const now = _spinNow;
    hand.matrixWorld.decompose(_pos, now, _scale);
    if (sp.seen && dt > 0) {
      // How far the hand has turned about the spinner's axis since last frame (the axis in the world).
      _spinQ.copy(now).multiply(_inv.copy(sp.was).invert());
      // The shorter way round (q and -q are the same turn).
      if (_spinQ.w < 0) _spinQ.set(-_spinQ.x, -_spinQ.y, -_spinQ.z, -_spinQ.w);
      _spinAxis.copy(sp.axis).applyQuaternion(now).normalize();
      const turned = 2 * Math.atan2(_spinQ.x * _spinAxis.x + _spinQ.y * _spinAxis.y + _spinQ.z * _spinAxis.z, _spinQ.w);
      // Left behind by the hand's turn, it is set spinning the other way, then eases back to its own speed.
      if (Math.abs(turned) < SPIN_SNAP) sp.speed -= Math.max(-SPIN_KICK, Math.min(SPIN_KICK, (turned / dt) * 0.6));
      sp.speed += (sp.own - sp.speed) * (1 - Math.exp(-SPIN_EASE * dt));
      sp.speed = Math.max(-8, Math.min(8, sp.speed));
      sp.angle += sp.speed * dt;
    }
    sp.was.copy(now);
    sp.seen = true;
    sp.joint.quaternion.setFromAxisAngle(sp.axis, sp.angle);
  }
}

/** One joint of something hanging loose: a length of chain, or the weight on its end. */
interface Link {
  joint: THREE.Group;
  /** From its pivot to its end (the next joint's pivot, or where its weight is), as built, in its parent's frame. */
  rest: THREE.Vector3;
  /** How big its end is, in the figure's units: how far it is kept off the body (0 not at all). */
  size: number;
  /** How heavy its end is, against the others in the chain. */
  weight: number;
  /** Where its end is in the world, and where it was a step ago (its speed). */
  at: THREE.Vector3;
  was: THREE.Vector3;
}

/**
 * Something hanging loose in a hand, swung by how the hand really moves through the world: a turn on the spot, a
 * run, a blow, an arm swinging on the march all fling it, and it falls back under its own weight. One link is a
 * pendulum; more (a flail's chain jointed half way) bend as they swing, the ball on the end pulling the chain.
 */
interface Dangling {
  links: Link[];
  /** How far a single link may swing from where it was built, in radians, if not all the way round (a clapper). */
  limit?: number;
  /** The haft the end hangs by, in the hand's frame: the last link's end is kept `r` from the line between. */
  clear?: { from: THREE.Vector3; to: THREE.Vector3; r: number };
  /** Whether it has been hung yet, and where the pivot was in the world last frame. */
  placed: boolean;
  pivot: THREE.Vector3;
}

/** Set by makeFigure for the figure being built: what hangs loose in its hands. */
let dangles: Dangling[] = [];
/** Set by biped for the figure being built: the parts of the body a weight swinging from a hand bumps against. */
let bodyParts: Part[] = [];

/** A piece of the body as a capsule (a line, rounded out by `r`) in its joint's space, for what swings to bump against. */
interface BodyCapsule {
  joint: THREE.Object3D;
  a: THREE.Vector3;
  b: THREE.Vector3;
  r: number;
}

/**
 * Fit a capsule round each body part, once it is built: along the longest side of what is drawn on it, as thick
 * as the other two sides on average. So a broad-shouldered or long-legged hero's is their own shape.
 */
function bodyCapsules(parts: Part[]): BodyCapsule[] {
  const out: BodyCapsule[] = [];
  const box = new THREE.Box3();
  const piece = new THREE.Box3();
  const size = new THREE.Vector3();
  const mid = new THREE.Vector3();
  for (const part of parts) {
    box.makeEmpty();
    part.skin.updateMatrix();
    for (const o of part.skin.children) {
      if (!(o instanceof THREE.Mesh) || !o.userData.body) continue;
      o.geometry.computeBoundingBox();
      box.union(piece.copy(o.geometry.boundingBox!).applyMatrix4(part.skin.matrix));
    }
    if (box.isEmpty()) continue;
    box.getSize(size);
    box.getCenter(mid);
    const half = size.toArray().map((n) => n / 2);
    const long = half.indexOf(Math.max(...half));
    const r = (half.reduce((sum, n) => sum + n, 0) - half[long]) / 2;
    const along = new THREE.Vector3().setComponent(long, Math.max(0, half[long] - r));
    out.push({ joint: part.joint, a: mid.clone().sub(along), b: mid.clone().add(along), r });
  }
  return out;
}

/** Gravity, in the figure's units (22 to its height) a second squared: a little light, so a swing reads. */
const DANGLE_GRAVITY = 95;
/** How much of its speed a swing loses a second, to the air and the chain. */
const DANGLE_DRAG = 2.2;

const _pivot = new THREE.Vector3();
const _step = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _rest = new THREE.Vector3();
const _parentQ = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _pos = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _line = new THREE.Line3();
const _near = new THREE.Vector3();
const _from = new THREE.Vector3();
const _at = new THREE.Vector3();
const _inv = new THREE.Quaternion();
const _off = new THREE.Vector3();
/** The body's capsules in the world this frame: two ends and a radius each. */
const _body: { a: THREE.Vector3; b: THREE.Vector3; r: number }[] = [];
/** How much of its speed a weight keeps each step it is rubbing against the body. */
const RUB = 0.85;

/** Push `bob` out of the capsule from `a` to `b` of radius `r`. True if it was inside. */
function pushOut(bob: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, r: number): boolean {
  _line.set(a, b);
  _line.closestPointToPoint(bob, true, _near);
  const off = _off.subVectors(bob, _near);
  const gap = off.length();
  if (gap >= r) return false;
  if (gap < 1e-6) off.set(1, 0, 0);
  bob.copy(_near).addScaledVector(off.normalize(), r);
  return true;
}

/**
 * Swing what hangs loose: each is a weight on a rod from its pivot, stepped in the world (Verlet), so it keeps
 * its speed while the hand carrying it moves and turns under it. Then its joint is turned to hang toward it.
 */
function swingDangles(list: Dangling[], dt: number, top: THREE.Object3D, body: BodyCapsule[]) {
  // The whole figure, posed for this frame, into the world: the hands that carry and the body they swing against.
  top.updateWorldMatrix(true, true);
  while (_body.length < body.length) _body.push({ a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0 });
  for (const [i, c] of body.entries()) {
    _body[i].a.copy(c.a).applyMatrix4(c.joint.matrixWorld);
    _body[i].b.copy(c.b).applyMatrix4(c.joint.matrixWorld);
  }
  for (const d of list) {
    const first = d.links[0];
    const hand = first.joint.parent;
    if (!hand) continue;
    hand.matrixWorld.decompose(_pos, _parentQ, _scale);
    const scale = _scale.x || 1;
    _pivot.copy(first.joint.position).applyMatrix4(hand.matrixWorld);
    // In the world, which way the first link hangs as built (for a limit).
    _rest.copy(first.rest).normalize().applyQuaternion(_parentQ);
    // The first frame, or a jump across the map (a new scene, a teleport): hang it straight down, at rest.
    if (!d.placed || dt <= 0 || _pivot.distanceTo(d.pivot) > 40 * scale) {
      _dir.copy(d.limit !== undefined ? _rest : DOWN);
      let end = _pivot;
      for (const link of d.links) {
        link.at.copy(end).addScaledVector(_dir, link.rest.length() * scale);
        link.was.copy(link.at);
        end = link.at;
      }
      d.pivot.copy(_pivot);
      d.placed = true;
    } else {
      // A few small steps, the pivot carried along between last frame's place and this one's.
      const steps = Math.min(8, Math.max(1, Math.ceil(dt * 240)));
      const h = dt / steps;
      const keep = Math.exp(-DANGLE_DRAG * h);
      const fall = DANGLE_GRAVITY * scale * h * h;
      const from = _from.copy(d.pivot);
      const last = d.links[d.links.length - 1];
      for (let i = 1; i <= steps; i++) {
        const at = _at.copy(from).lerp(_pivot, i / steps);
        for (const link of d.links) {
          _step.subVectors(link.at, link.was).multiplyScalar(keep);
          link.was.copy(link.at);
          link.at.add(_step);
          link.at.y -= fall;
        }
        // Each link held at its length from the one above: the pivot does not give, and of two ends the
        // lighter gives more (a length of chain, to the ball). A few rounds, as each pulls on the next.
        const hold = () => {
          for (let round = 0; round < (d.links.length > 1 ? 3 : 1); round++) {
            for (const [n, link] of d.links.entries()) {
              const above = n === 0 ? null : d.links[n - 1];
              const anchor = above ? above.at : at;
              _dir.subVectors(link.at, anchor);
              if (_dir.lengthSq() < 1e-12) _dir.copy(DOWN);
              const length = link.rest.length() * scale;
              const off = _dir.length() - length;
              _dir.normalize();
              if (!above) {
                link.at.addScaledVector(_dir, -off);
                continue;
              }
              const share = above.weight / (above.weight + link.weight);
              link.at.addScaledVector(_dir, -off * share);
              above.at.addScaledVector(_dir, off * (1 - share));
            }
          }
        };
        hold();
        // A clapper stays within its bell.
        if (d.limit !== undefined) {
          _dir.subVectors(first.at, at).normalize();
          if (_dir.angleTo(_rest) > d.limit) {
            const axis = _step.crossVectors(_rest, _dir);
            if (axis.lengthSq() < 1e-12) _dir.copy(_rest);
            else _dir.copy(_rest).applyAxisAngle(axis.normalize(), d.limit);
            first.at.copy(at).addScaledVector(_dir, first.rest.length() * scale);
          }
        }
        // Kept off the haft (the end) and the body (every end that has a size): pushed straight out of each
        // (twice round, as one can push it into another), then held to its length again. Touching the body, it
        // rubs, and loses some speed.
        for (let pass = 0; pass < 2; pass++) {
          let moved = false;
          if (d.clear) moved = pushOut(last.at, _a.copy(d.clear.from).applyMatrix4(hand.matrixWorld), _b.copy(d.clear.to).applyMatrix4(hand.matrixWorld), d.clear.r * scale);
          for (const link of d.links) {
            if (link.size <= 0) continue;
            let touched = false;
            for (let c = 0; c < body.length; c++) {
              if (pushOut(link.at, _body[c].a, _body[c].b, (body[c].r + link.size) * scale)) moved = touched = true;
            }
            if (touched) link.was.lerp(link.at, 1 - RUB);
          }
          if (!moved) break;
          hold();
        }
      }
      d.pivot.copy(_pivot);
    }
    // Turn each joint so its link, built along `rest`, lies toward its end: the first in the hand's frame, each
    // next in the frame the one above has just been turned to.
    let end = _pivot;
    for (const link of d.links) {
      _dir.subVectors(link.at, end).normalize().applyQuaternion(_inv.copy(_parentQ).invert());
      link.joint.quaternion.setFromUnitVectors(_rest.copy(link.rest).normalize(), _dir);
      _parentQ.multiply(link.joint.quaternion);
      end = link.at;
    }
  }
}

/** A grip in a fist angled out from the body (`s` 1 for the right hand, -1 the left), for a dagger or a hook. */
function outward(hand: Part, s: number): Part {
  const grip = new Part(hand.joint);
  grip.joint.rotation.z = s * 0.38;
  extraParts.push(grip);
  return grip;
}

/** The long guns and the crossbow, by icon: too long for one hand, carried across the chest in two (see heldGear). */
const LONG_GUNS = new Set(["blunderbuss", "harpoon-gun", "heavy-crossbow"]);

/**
 * The books carried open (see openBook), by icon: the covers' colour, and whether what is written on the pages
 * glows in the trim (a grimoire's sigils) or is plain ink (a logbook's lines).
 */
const BOOKS: Record<string, { cover: string; glows: boolean }> = {
  grimoire: { cover: "#2e2440", glows: true },
  "scroll-unfurled": { cover: "#6b4a2b", glows: false },
};

/**
 * A book held open before the chest on the right hand, level, its far edge a little raised so the pages show:
 * two boards meeting in a shallow V at the spine, a block of pages on each, lines of writing across them and a
 * ribbon down the gutter. Motes rise off the open pages (see makeMotes), and a spell is cast with the other hand
 * waved over them (see biped's `reads`).
 */
function openBook(b: Biped, cover: string, glows: boolean, trim: string): Carry {
  // Out from the fist to the middle of the chest: the hand has it by its near corner, and the other can reach over it.
  const book = new Part(b.before().joint, 2.4, 1.25, 1.7);
  book.joint.rotation.x = -0.4;
  extraParts.push(book);
  b.reads(book.joint);
  const paper = "#efe6cf";
  for (const s of [-1, 1]) {
    const lie: Rot = [0, 0, s * 0.17];
    book.box(cover, 2.35, 0.24, 3.4, s * 1.16, 0.2, 0, lie);
    book.box(paper, 2.1, 0.34, 3.05, s * 1.12, 0.46, 0, lie);
    // What is written: a sigil's glowing strokes, or a few lines in ink.
    for (const [i, z] of [-0.9, -0.3, 0.3, 0.9].entries()) {
      const wide = 1.5 - ((i + (s > 0 ? 1 : 0)) % 3) * 0.3;
      if (glows) book.glowBox(trim, wide, 0.06, 0.16, s * 1.12, 0.66 + 0.19 * 0.0, z, lie);
      else book.box("#5a4a3a", wide, 0.05, 0.12, s * 1.12, 0.65, z, lie);
    }
  }
  book.box(tone(cover, -0.08), 0.5, 0.3, 3.4, 0, 0.08, 0);
  book.box(trim, 0.22, 0.06, 1.3, 0.12, 0.4, 2.0);
  b.emits(trim, [0, 0.9, 0], book.joint);
  // Held well out: the upper arm forward, the forearm level, so the book is clear of the chin.
  return { upper: -0.55, bend: -1.0 };
}

/**
 * A low-poly hero's weapon as its icon's model, and how the arm carries it; null when it has none, or is played
 * across the body (the lute, flute and squeeze box: drawHeld lays those out).
 */
function heldGear(icon: string, b: Biped, trim: string, shield: boolean): Carry | null {
  const hold = HOLD[icon];
  if (!hold || icon === "lute") return null;
  if (BOOKS[icon]) return openBook(b, BOOKS[icon].cover, BOOKS[icon].glows, trim);
  if (LONG_GUNS.has(icon)) {
    // Carried low at the ready: the right hand on the grip before the belly, the barrel out ahead and to the
    // left, clear of the head, standing as the body does; the left hand has it by the barrel (see biped's
    // `steady`; a shield arm stays put).
    const gun = new Part(b.before().joint, 0.2, 0.2, 0.2);
    gun.joint.rotation.order = "YXZ";
    gun.joint.rotation.set(GUN_PORT.pitch, GUN_PORT.yaw, 0);
    if (!gear(gun, icon, trim, hold)) return null;
    extraParts.push(gun);
    b.armed(true, gun.joint, GUNS[icon].muzzle, GUNS[icon].smoke);
    if (!shield) Object.assign(b.rest, { armL: ACROSS_ARM.arm, bendL: ACROSS_ARM.bend, twistL: ACROSS_ARM.twist });
    return { upper: -0.1, bend: -1.15 };
  }
  if (icon === "crossbow" && !shield) {
    // A bow is carried across the body like the lute: gripped in the left fist before the belly, its limbs
    // slanting from the right hip up past the left shoulder, flat to the body so its whole curve shows, the
    // arrow on the string pointing down and away. The right hand hangs ready to draw.
    const bow = new Part(b.across().joint, 0, 0, BOW_OUT);
    bow.joint.rotation.z = BOW_CANT;
    if (!gear(bow, icon, trim, { grip: hold.grip, scale: hold.scale }, true)) return null;
    // Strung by the figure, so the string can be drawn: a half from each tip to the nock, and an arrow on it.
    const k = hold.scale as number;
    const tip = { x: (-0.5 - hold.grip[0]) * k, y: 8 * k };
    const halves = [1, -1].map((s) => {
      const half = new Part(bow.joint, tip.x, s * tip.y, 0);
      half.cyl(GEAR.paper, 0.07, 0.07, 1, 0, -0.5, 0, 4);
      return half;
    });
    const arrow = new Part(bow.joint, tip.x, 0, 0.35);
    arrow.cyl(GEAR.paper, 0.14, 0.14, 6.2, 3.0, 0, 0, 5, [0, 0, HALF_PI]);
    arrow.cone(GEAR.steel, 0.42, 1.1, 6.6, 0, 0, 5, [0, 0, -HALF_PI]);
    for (const turn of [0, HALF_PI]) arrow.box(trim, 1.4, 0.75, 0.08, 0.6, 0, 0, [turn, 0, 0]);
    extraParts.push(bow, ...halves, arrow);
    b.string({ bow, halves, arrow, tip });
    // A knife for close work, in the hand that draws the string: out of sight until a blow is struck with it.
    const knife = new Part(b.heldR.joint);
    if (gear(knife, "dirk", trim, HOLD.dirk)) {
      extraParts.push(knife);
      b.sidearms(knife.joint);
    }
    return { arm: -0.2, bend: -0.7 };
  }
  if (PAIRED.has(icon)) {
    // One in each fist (the second unless a shield is there), both tipped forward the same.
    if (!gear(outward(b.heldR, 1), icon, trim, hold, true)) return null;
    if (!shield) {
      gear(outward(b.heldL, -1), icon, trim, hold, true);
      carryLeft(b, hold.pose?.tilt ?? 0);
    }
    return hold.pose ?? {};
  }
  // A flail is held with its chain hanging straight, to swing (its picture curls it round).
  if (!gear(b.heldR, icon, trim, hold, icon === "ballast-flail")) return null;
  // Held as it is made (nothing with an edge is: see HOLD), a thing is flat to the front and its sides lead.
  if (!hold.turn) b.cutsAlong("x");
  const motes = MOTES[icon];
  if (motes) b.emits(motes.color ?? trim, motes.at);
  if (GUNS[icon]) b.armed(false, b.heldR.joint, GUNS[icon].muzzle, GUNS[icon].smoke);
  // A bell is rung for a song, as a lute is strummed.
  if (icon === "ships-bell") b.instrument("bell", b.heldR, 0, trim);
  if (FOCUS.has(icon)) b.focuses();
  return hold.pose ?? {};
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
  /** A strike or a hit under way, for a rig that plays them (see Rig.acts); null otherwise. */
  act: Act | null;
  /** How many of the figure's own units make one of the world's, as it is drawn now: for a step measured in tiles. */
  scale: number;
  /** On a seat, 0 (standing) to 1: the hips stay where they are, the thighs go forward and the shins hang from the knee. */
  sitting: number;
  /** At the oars of a rowboat (seated): where the stroke is, 0 (reached forward) to 1 (pulled back). -1: not rowing. */
  oars: number;
  /** A stage of getting up off the ground, for a rig that has them (see Rig.getUp); null otherwise. */
  getUp: GetUp | null;
}

/**
 * The stages of getting up off the ground, each a pose held on the way: rolled onto the front, up on hands and
 * knees, and up on one knee (anyone on two legs); rolled onto the belly, the legs tucked under (a beast).
 */
type GetUp = "front" | "crawl" | "kneel" | "belly";
/** How a two-legged figure gets up, and a four-legged one. */
const BIPED_GET_UP: readonly GetUp[] = ["front", "crawl", "kneel"];
const BEAST_GET_UP: readonly GetUp[] = ["belly"];
/** Seconds to come into each stage of getting up, and from the last of them up onto the feet. */
const GET_UP_TIME: Record<GetUp | "stand", number> = { front: 0.45, crawl: 0.4, kneel: 0.4, belly: 0.5, stand: 0.45 };
/**
 * How much of the way round to the front each stage has turned (it gets up the way its head lay, and turns to face
 * forward as it rises), and how much of the way from where it lay to where it stands it has come.
 */
const GET_UP_TURNED: Record<GetUp, number> = { front: 0, crawl: 0, kneel: 0.5, belly: 0 };
/** Where the hips are along the ground, from where it stands, as it gets up on two legs: a little back. */
const GET_UP_HIPS = -1;

/**
 * A blow being struck or taken, `t` seconds into it: an ordinary strike (a cut, or with a stabbing weapon a
 * thrust), a heavy one (a sweep, or with a blade in each hand both jabbed downward), a spell or a throw being cast, an instrument being played, a gun or a crossbow being fired, or the flinch of being hit.
 * `n` counts the figure's actions, so two flinches in a row need not be the same.
 */
interface Act {
  kind: "strike" | "stab" | "pounce" | "heavy" | "twin" | "cast" | "play" | "fire" | "guard" | "taunt" | "hit" | "hammer" | "stir" | "jump";
  t: number;
  n: number;
  /** A jump's seconds off the ground (see JUMP). */
  air?: number;
}

type Keys = readonly (readonly [number, number])[];
/** A value along keyframes [seconds, value], eased from each to the next; held before the first and after the last. */
function along(keys: Keys, t: number): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t > keys[i][0]) continue;
    const k = (t - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0]);
    return keys[i - 1][1] + (keys[i][1] - keys[i - 1][1]) * k * k * (3 - 2 * k);
  }
  return keys[keys.length - 1][1];
}

/**
 * A strike, key by key. `hit` is when the blow lands and `over` when the figure is back as it was. The weapon arm:
 * `arm` is the upper arm's turn (0 hangs, -π/2 points ahead, -π straight up), `bend` the elbow's, `out` how far
 * the arm is lifted from the side, and `blade` which way what the hand holds points (0 upright, π/2 flat ahead,
 * below 0 laid back over the shoulder). The body: `lean` forward, `twist` (above 0 brings the weapon shoulder
 * through), both mostly at the waist, `rise` up onto the toes, `crouch` into the knees (the hips come down with
 * them, the feet stay on the ground), and `off` the free arm's counter-swing.
 */
interface Blow {
  hit: number;
  over: number;
  arm: Keys;
  bend: Keys;
  out: Keys;
  blade: Keys;
  lean: Keys;
  twist: Keys;
  rise: Keys;
  crouch: Keys;
  off: Keys;
  /** How far into its step toward the mark the figure is, 0 (where it stood) to 1 (a full STRIDE on). */
  step: Keys;
}

/** How far a figure steps in to strike, in the world's units: half way across a tile, to its edge. */
const STRIDE = 0.8;

/** An ordinary strike: the weapon drawn back over the shoulder, cut down and across, and brought back to guard. */
const SWING: Blow = {
  hit: 0.17,
  over: 0.52,
  arm: [[0, -0.4], [0.11, -2.0], [0.17, -1.0], [0.27, -0.5], [0.52, -0.3]],
  bend: [[0, -1.2], [0.11, -1.5], [0.17, -0.2], [0.27, -0.3], [0.52, -1.2]],
  out: [[0, 0.1], [0.11, 0.4], [0.17, 0.05], [0.52, 0.1]],
  blade: [[0, 0.3], [0.11, -0.9], [0.17, 1.5], [0.27, 1.75], [0.4, 1.1], [0.52, 0.3]],
  lean: [[0, 0], [0.11, -0.1], [0.17, 0.3], [0.3, 0.22], [0.52, 0]],
  twist: [[0, 0], [0.11, -0.35], [0.17, 0.45], [0.3, 0.3], [0.52, 0]],
  rise: [[0, 0], [0.11, 0.15], [0.17, 0], [0.52, 0]],
  crouch: [[0, 0], [0.17, 0.3], [0.3, 0.24], [0.52, 0]],
  off: [[0, 0], [0.11, -0.45], [0.17, 0.4], [0.52, 0]],
  step: [[0, 0], [0.1, 0.3], [0.17, 1], [0.32, 1], [0.52, 0]],
};

/**
 * A thrust, for a weapon that stabs: the hand drawn back to the hip with the point levelled at the mark, then a
 * step half way across the tile into a deep lunge, the arm shot out straight behind the point and the shoulder
 * turned in after it; held there a moment at full stretch, and drawn back to guard.
 */
const THRUST: Blow = {
  hit: 0.17,
  over: 0.52,
  arm: [[0, -0.3], [0.09, 0.5], [0.17, -1.42], [0.29, -1.38], [0.52, -0.3]],
  bend: [[0, -1.2], [0.09, -2.0], [0.17, -0.06], [0.29, -0.1], [0.52, -1.2]],
  out: [[0, 0.1], [0.09, 0.3], [0.17, 0], [0.52, 0.1]],
  blade: [[0, 0.3], [0.09, 1.45], [0.17, 1.57], [0.29, 1.57], [0.42, 1.0], [0.52, 0.3]],
  lean: [[0, 0], [0.09, -0.05], [0.17, 0.32], [0.29, 0.3], [0.52, 0]],
  twist: [[0, 0], [0.09, -0.4], [0.17, 0.55], [0.29, 0.5], [0.52, 0]],
  rise: [[0, 0], [0.52, 0]],
  crouch: [[0, 0], [0.09, 0.18], [0.17, 0.3], [0.29, 0.28], [0.52, 0]],
  off: [[0, 0], [0.09, -0.3], [0.17, 0.75], [0.29, 0.7], [0.52, 0]],
  step: [[0, 0], [0.09, 0.2], [0.17, 1], [0.3, 1], [0.52, 0]],
};

/**
 * A dagger's strike: a stab downward out of the air. A quick crouch, then a leap forward and up, the right blade
 * turned over in the fist and lifted high, legs flung apart in the stride; it is driven down as the figure comes
 * down, landing at the far edge of the tile in a deep crouch behind the point. The other arm is thrown back.
 */
const POUNCE: Blow = {
  hit: 0.3,
  over: 0.74,
  arm: [[0, -0.3], [0.1, -0.9], [0.2, -2.7], [0.25, -2.75], [0.3, -1.1], [0.43, -1.05], [0.74, -0.3]],
  bend: [[0, -1.2], [0.2, -1.3], [0.25, -1.35], [0.3, -0.5], [0.43, -0.55], [0.74, -1.2]],
  out: [[0, 0.1], [0.2, 0.3], [0.3, 0], [0.74, 0.1]],
  blade: [[0, 0.3], [0.1, 1.4], [0.2, 2.25], [0.25, 2.2], [0.3, 2.95], [0.43, 2.95], [0.6, 1.8], [0.74, 0.3]],
  lean: [[0, 0], [0.1, 0.15], [0.2, -0.15], [0.3, 0.5], [0.43, 0.45], [0.74, 0]],
  twist: [[0, 0], [0.2, -0.35], [0.3, 0.4], [0.43, 0.35], [0.74, 0]],
  rise: [[0, 0], [0.1, 0], [0.2, 6.5], [0.3, 0], [0.74, 0]],
  crouch: [[0, 0], [0.1, 0.45], [0.15, 0.1], [0.22, 0.45], [0.3, 0.75], [0.43, 0.65], [0.74, 0]],
  off: [[0, 0], [0.2, 0.6], [0.3, 0.9], [0.43, 0.8], [0.74, 0]],
  step: [[0, 0], [0.1, 0.1], [0.3, 1], [0.5, 1], [0.74, 0]],
};

/**
 * The heavy strike of a blade in each hand, with a flourish: a dip and a flick tosses both blades up out of the
 * hands; they turn over in the air as the arms go up after them, and are caught points down over the head; then a
 * long step into a deep lunge as both are jabbed downward together, the whole body dropping behind them. Held
 * there, and the blades turned back upright as the figure gathers itself. Both arms follow the same keys, each on
 * its own side (`blade` past π/2 is a point turned over, π straight down). `toss` is how high over the hands the
 * blades are, and `spin` the whole turn they make in the air on top of turning over.
 */
const TWIN: Blow & { toss: Keys; spin: Keys } = {
  hit: 0.46,
  over: 1.06,
  arm: [[0, -0.3], [0.07, 0.1], [0.12, -1.1], [0.3, -2.5], [0.38, -2.7], [0.46, -1.15], [0.61, -1.1], [1.06, -0.3]],
  bend: [[0, -1.2], [0.07, -1.5], [0.12, -0.9], [0.3, -1.3], [0.38, -1.35], [0.46, -0.55], [0.61, -0.6], [1.06, -1.2]],
  out: [[0, 0.1], [0.3, 0.36], [0.46, -0.04], [0.61, -0.04], [1.06, 0.1]],
  blade: [[0, 0.3], [0.12, 0.3], [0.38, 2.2], [0.46, 2.95], [0.61, 2.95], [0.86, 2.0], [1.06, 0.3]],
  lean: [[0, 0], [0.07, 0.1], [0.2, -0.15], [0.38, -0.22], [0.46, 0.5], [0.61, 0.45], [1.06, 0]],
  twist: [[0, 0], [1.06, 0]],
  rise: [[0, 0], [0.07, 0], [0.14, 0.3], [0.3, 0.2], [0.38, 0.5], [0.46, 0], [1.06, 0]],
  crouch: [[0, 0], [0.07, 0.3], [0.14, 0], [0.3, 0.1], [0.38, 0], [0.46, 0.7], [0.61, 0.62], [1.06, 0]],
  off: [[0, 0], [1.06, 0]],
  step: [[0, 0], [0.36, 0.15], [0.46, 1], [0.75, 1], [1.06, 0]],
  toss: [[0, 0], [0.12, 0], [0.25, 6.5], [0.38, 0], [1.06, 0]],
  spin: [[0.12, 0], [0.38, Math.PI * 2]],
};

/**
 * A heavy strike: a great sweep from one side to the other. Both hands to the weapon, it is wound far out to the
 * figure's right, hips and shoulders turned with it; swung flat across the front in one wide arc, the blade
 * leading; and carried on round to the left, where it hangs a moment before the figure gathers itself. The hands
 * stay before the chest (two can only meet near the middle of so broad a body): the arc is the waist's turn and
 * the weapon's own. `twist` is the body's turn (below 0 to the right), `yaw` the weapon's across the body (above 0
 * to the right) and `tilt` its rise above the level, `step` how far into its step toward the mark it is.
 */
const SWEEP = {
  hit: 0.35,
  over: 0.98,
  twist: [[0, 0], [0.24, -1.25], [0.3, -1.4], [0.35, 0.05], [0.42, 0.9], [0.62, 1.0], [0.98, 0]] as Keys,
  yaw: [[0, 0.15], [0.24, 1.45], [0.3, 1.65], [0.35, 0.1], [0.42, -0.95], [0.62, -1.05], [0.98, 0.15]] as Keys,
  tilt: [[0, 1.0], [0.24, 0.5], [0.3, 0.4], [0.35, 0.02], [0.42, -0.12], [0.62, -0.1], [0.98, 1.0]] as Keys,
  lean: [[0, 0], [0.26, -0.06], [0.35, 0.2], [0.62, 0.2], [0.98, 0]] as Keys,
  crouch: [[0, 0], [0.26, 0.28], [0.35, 0.42], [0.62, 0.36], [0.98, 0]] as Keys,
  step: [[0, 0], [0.24, 0.2], [0.3, 0.3], [0.36, 1], [0.66, 1], [0.98, 0]] as Keys,
};

/**
 * A cast, for a spell or anything thrown: the casting hand (and the staff, orb or book in it) is swung up and once
 * round overhead, the body rising under it, then brought down to point straight at the mark, the shoulder turned
 * in behind it. What is cast leaves at `emit`, as the point arrives; the point is held, and let fall. `turn` is
 * where round the overhead circle the hand is, and `point` how far it has come down from the circle to the mark.
 */
const CAST = {
  emit: 0.44,
  over: 0.88,
  turn: [[0, -1.6], [0.08, -1.0], [0.34, 5.6], [0.88, 5.6]] as Keys,
  point: [[0, 0], [0.33, 0], [0.44, 1], [0.88, 1]] as Keys,
  lean: [[0, 0], [0.12, -0.12], [0.34, -0.16], [0.44, 0.2], [0.66, 0.18], [0.88, 0]] as Keys,
  twist: [[0, 0], [0.3, -0.3], [0.44, 0.35], [0.66, 0.3], [0.88, 0]] as Keys,
  rise: [[0, 0], [0.14, 0.3], [0.34, 0.35], [0.44, 0], [0.88, 0]] as Keys,
  crouch: [[0, 0], [0.34, 0], [0.44, 0.2], [0.66, 0.18], [0.88, 0]] as Keys,
  off: [[0, 0], [0.2, -0.35], [0.44, 0.5], [0.66, 0.45], [0.88, 0]] as Keys,
};

/**
 * An instrument played, for a bard's song: a lute is strummed, the hand going down and up across its strings; a
 * flute is lifted level to the mouth in both hands. The player sways and bobs in time, and notes rise from the
 * instrument with a few wisps curling up among them (see makeNotes). What the song does begins at `emit`.
 */
const PLAY = { emit: 0.5, over: 2.4 };
/** When each note of a song leaves the instrument, how long a note lasts, and the same for the wisps among them. */
const NOTE_AT = [0.28, 0.44, 0.6, 0.78, 0.94, 1.1, 1.28, 1.44];
const NOTE_LIFE = 0.95;
const WISP_AT = [0.32, 0.68, 1.04, 1.36];
const WISP_LIFE = 1.15;
/** Things made for a figure that are not its body's (a song's notes): thrown away with it. Set by makeFigure. */
let spare: { dispose(): void }[] = [];

/**
 * The notes of a song: quavers that pop out of the instrument, rise swaying and fade, some in `color` and some
 * pale, and wisps of pale ribbon that curl up among them, turning and thinning as they go. Where each is depends
 * only on how far into the song it is, so a song held still, or stepped a frame at a time, shows the same notes.
 * Past a `spread` of 1 they start further apart and fan out wider as they climb (a squeeze box's, off the width
 * of its bellows).
 */
function makeNotes(color: string, spread = 1) {
  const group = new THREE.Group();
  group.visible = false;
  // A quaver: a tilted head, a stem and a flag.
  const head = new THREE.IcosahedronGeometry(0.42, 1);
  head.scale(1, 0.74, 0.55).rotateZ(0.4);
  const stem = new THREE.BoxGeometry(0.1, 1.55, 0.1).translate(0.36, 0.78, 0).toNonIndexed();
  const flag = new THREE.BoxGeometry(0.55, 0.16, 0.1).rotateZ(-0.55).translate(0.6, 1.4, 0).toNonIndexed();
  const quaver = mergeGeometries([head, stem, flag])!;
  for (const piece of [head, stem, flag]) piece.dispose();
  // A wisp: a thin ribbon winding up and out, like breath on a cold morning.
  const curl = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(Array.from({ length: 9 }, (_, i) => new THREE.Vector3(Math.cos(i * 0.85) * 0.12 * i, i * 0.34, Math.sin(i * 0.85) * 0.12 * i))), 24, 0.045, 4);
  spare.push(quaver, curl);
  const fleck = (geometry: THREE.BufferGeometry, tint: string) => {
    const material = new THREE.MeshBasicMaterial({ color: tint, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    group.add(mesh);
    spare.push(material);
    return { mesh, material };
  };
  const notes = NOTE_AT.map((_, i) => fleck(quaver, i % 3 === 2 ? "#fff6dc" : color));
  const wisps = WISP_AT.map(() => fleck(curl, "#fff6dc"));
  return {
    group,
    hide() {
      group.visible = false;
    },
    /** The song `t` seconds in, its notes rising from `from` (in the frame the group hangs in). */
    show(t: number, from: THREE.Vector3) {
      group.visible = true;
      notes.forEach(({ mesh, material }, i) => {
        const age = t - NOTE_AT[i];
        mesh.visible = age > 0 && age < NOTE_LIFE;
        if (!mesh.visible) return;
        const k = age / NOTE_LIFE;
        // Each keeps to its own side of the rest, and wanders as it climbs.
        const side = (((i * 37) % 7) - 3) * 0.75 * spread * (1 + age * (spread - 1));
        mesh.position.set(from.x + side + Math.sin(age * 4.5 + i * 1.9) * 1.1, from.y + 0.5 + age * 8.5, from.z + 1.2 + age * 1.2);
        mesh.rotation.z = Math.sin(age * 5 + i) * 0.35;
        const size = (2.1 + (i % 2) * 0.6) * Math.min(1, age / 0.12);
        mesh.scale.set(i % 2 ? -size : size, size, size);
        material.opacity = 1 - k * k;
      });
      wisps.forEach(({ mesh, material }, j) => {
        const age = t - WISP_AT[j];
        mesh.visible = age > 0 && age < WISP_LIFE;
        if (!mesh.visible) return;
        const k = age / WISP_LIFE;
        mesh.position.set(from.x + Math.sin(age * 2 + j * 2.1) * 0.9 + (j % 2 ? 1.4 : -1.4) * spread, from.y + 0.2 + age * 5.5, from.z + 0.9);
        mesh.rotation.y = age * 3.2 + j * 2;
        mesh.scale.setScalar(1.7 + k * 2.6);
        material.opacity = 0.8 * (1 - k) * Math.min(1, age / 0.15);
      });
    },
  };
}
/** A joint to lay a line along, to read its place and turn back off (see layAlong). */
const laid = new THREE.Object3D();

/**
 * The held things, besides the open books (see openBook), that give off motes of light (see makeMotes): where in
 * the hand's frame they rise from (the brim of the cup), and their colour where it is the thing's own and not
 * its trim.
 */
const MOTES: Record<string, { at: Pt; color?: string }> = {
  "bilge-chalice": { at: [0, 3.9, 0.4], color: "#6dff9e" },
};
/** How many motes drift up at rest, how long each takes to rise and fade, and how many more a cast throws out. */
const MOTES_IDLE = 5;
const MOTE_RISE = 2.6;
const MOTES_CAST = 18;

/**
 * Motes of light off a book or a brimming cup. At rest a few drift up from it, one after another, winding a
 * little as they climb and fading out. A cast throws out many more: they whirl up and outward round it while the
 * hand swings overhead, and as it points the last of them stream away toward the mark. Like a song's notes, where
 * each one is depends only on the clock, so it holds still when time does.
 */
function makeMotes(color: string) {
  const group = new THREE.Group();
  const shape = new THREE.OctahedronGeometry(0.5, 0);
  spare.push(shape);
  const mote = (i: number) => {
    const material = new THREE.MeshBasicMaterial({ color: i % 3 === 0 ? "#fff6dc" : color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const mesh = new THREE.Mesh(shape, material);
    mesh.visible = false;
    group.add(mesh);
    spare.push(material);
    return { mesh, material };
  };
  const idle = Array.from({ length: MOTES_IDLE }, (_, i) => mote(i + 1));
  const burst = Array.from({ length: MOTES_CAST }, (_, i) => mote(i));
  return {
    group,
    hide() {
      group.visible = false;
    },
    /** As they are at `clock` seconds, rising from `from`; `cast` is how far into a cast it is, below 0 for none. */
    show(clock: number, cast: number, from: THREE.Vector3) {
      group.visible = true;
      idle.forEach(({ mesh, material }, i) => {
        const age = (clock + (i * MOTE_RISE) / MOTES_IDLE) % MOTE_RISE;
        const k = age / MOTE_RISE;
        const round = age * 2.2 + i * 1.3;
        mesh.visible = true;
        mesh.position.set(from.x + Math.cos(round) * 0.8 * (0.3 + k), from.y + 0.2 + k * 6, from.z + Math.sin(round) * 0.8 * (0.3 + k));
        mesh.rotation.set(age * 2, age * 3, 0);
        mesh.scale.setScalar(1.15 * (1 - k * 0.5));
        material.opacity = Math.sin(Math.PI * k) * 0.9;
      });
      burst.forEach(({ mesh, material }, i) => {
        const born = 0.04 + i * 0.03;
        const age = cast - born;
        mesh.visible = cast >= 0 && age > 0 && age < 0.6;
        if (!mesh.visible) return;
        const k = age / 0.6;
        if (born < CAST.emit - 0.12) {
          // Whirled up and outward while the hand goes round.
          const round = i * 2.4 + age * 9;
          const out = 0.6 + k * 2.6;
          mesh.position.set(from.x + Math.cos(round) * out, from.y + k * 5.5, from.z + Math.sin(round) * out);
        } else {
          // Streamed away ahead, toward the mark, as the hand points.
          mesh.position.set(from.x + Math.sin(i * 2.1) * 0.5 * (1 - k), from.y + Math.cos(i * 1.7) * 0.5 * (1 - k), from.z + 0.6 + age * 30);
        }
        mesh.rotation.set(age * 6, age * 8, 0);
        mesh.scale.setScalar(1.5 * (1 - k * 0.6));
        material.opacity = 1 - k * k;
      });
    },
  };
}

/**
 * A gun or a crossbow fired. A pistol (`hand`) is lifted and levelled at arm's length; a long gun or a crossbow
 * (`long`) is brought from the port to the shoulder, the body turned side-on (`turn`) behind it, the barrel level
 * and the other hand under it. Each is aimed by `aim`, goes off at `shot` (it kicks, the muzzle jumping and the
 * shooter rocked back, and a powder gun flashes and smokes: see makeSmoke), and is lowered between `down` and
 * `over`. `ends` is when the last of the smoke has gone.
 */
const FIRE = { turn: 1.1, ends: 1.6, hand: { aim: 0.18, shot: 0.26, down: 0.5, over: 0.82 }, long: { aim: 0.26, shot: 0.36, down: 0.64, over: 1.0 } };
/**
 * How a long gun is carried at rest, before the belly: its muzzle a little up, and out ahead and to the left,
 * so its barrel is clear of the head (and a helmet's brim) and passes where the left hand can reach it.
 */
const GUN_PORT = { pitch: -0.3, yaw: 0.8 };
/**
 * Where the right hand has a long gun as it is aimed, in the torso's frame as the body stands side-on: how far
 * out from the body's middle, to the side the chest faces; how far along the line of the shot; and how high,
 * which is below the shoulders so the barrel passes under the brim of a helmet.
 */
const GUN_AIM = { out: 2.8, along: 0.1, high: 4.1 };
/**
 * The guns and the crossbow, by icon: whether it takes two hands; where its muzzle is from the grip, in the frame
 * it is held in (the barrel runs out along +z); and how much smoke it makes (none, for a crossbow).
 */
const GUNS: Record<string, { long: boolean; muzzle: Pt; smoke: number }> = {
  pistol: { long: false, muzzle: [0, 1.33, 7.4], smoke: 1 },
  blunderbuss: { long: true, muzzle: [0, 1.05, 10.3], smoke: 1.8 },
  "harpoon-gun": { long: true, muzzle: [0, 1.5, 6.9], smoke: 0.8 },
  "heavy-crossbow": { long: true, muzzle: [0, 0, 8], smoke: 0 },
};

/**
 * A shot's flash and smoke: a few sparks of fire that leap from the muzzle and are gone, and puffs of grey that
 * roll out ahead of it, climb and thin away. They stay where the gun was when it went off, whatever the shooter
 * does next; `big` scales the lot (a blunderbuss makes a cloud). Where each is depends only on the time since the
 * shot.
 */
function makeSmoke(big: number) {
  const group = new THREE.Group();
  group.visible = false;
  const puff = new THREE.IcosahedronGeometry(0.5, 1);
  const spark = new THREE.OctahedronGeometry(0.5, 0);
  spare.push(puff, spark);
  const fleck = (geometry: THREE.BufferGeometry, material: THREE.MeshBasicMaterial) => {
    const mesh = new THREE.Mesh(geometry, material);
    group.add(mesh);
    spare.push(material);
    return { mesh, material };
  };
  const sparks = Array.from({ length: 4 }, (_, i) => fleck(spark, new THREE.MeshBasicMaterial({ color: i % 2 ? "#fff3c8" : "#ffb347", transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
  const puffs = Array.from({ length: 7 }, (_, i) => fleck(puff, new THREE.MeshBasicMaterial({ color: i % 2 ? "#d9d5cd" : "#bdb8b0", transparent: true, depthWrite: false })));
  const from = new THREE.Vector3();
  const dir = new THREE.Vector3();
  let last = Infinity;
  return {
    group,
    hide() {
      group.visible = false;
      last = Infinity;
    },
    /** `since` seconds after the shot; `at` and `ahead` are the muzzle and the way it points now, kept from the moment it went off. */
    show(since: number, at: THREE.Vector3, ahead: THREE.Vector3) {
      if (since < last) {
        from.copy(at);
        dir.copy(ahead);
      }
      last = since;
      group.visible = true;
      sparks.forEach(({ mesh, material }, i) => {
        const k = since / 0.1;
        mesh.visible = k < 1;
        if (!mesh.visible) return;
        mesh.position.copy(from).addScaledVector(dir, 0.5 + i * 0.6 + k * 1.6);
        mesh.rotation.set(i, since * 30, i * 2);
        mesh.scale.setScalar(big * (1.9 - k) * (1 - i * 0.17));
        material.opacity = 1 - k;
      });
      puffs.forEach(({ mesh, material }, i) => {
        const age = since - i * 0.025;
        mesh.visible = age > 0 && age < 1;
        if (!mesh.visible) return;
        // Out fast and slowing, then climbing, each a little to one side of the last.
        mesh.position.copy(from).addScaledVector(dir, 0.8 + (2.4 + i * 0.5) * (1 - (1 - age) ** 2));
        mesh.position.x += Math.sin(i * 2.3) * 0.7 * age;
        mesh.position.y += age * 3 + i * 0.12;
        mesh.scale.setScalar(big * (1.1 + age * 2.8));
        material.opacity = 0.8 * (1 - age);
      });
    },
  };
}

/**
 * The swoosh behind a swung weapon: how long it lingers, how fast the weapon's tip must be going (in the figure's
 * own units a second) to leave one at all and to leave it at full strength, and the most of it kept.
 */
const SWOOSH = { life: 0.13, slow: 45, fast: 110, most: 64, bright: 0.55, inner: 0.5, arc: 0.12 };

/**
 * A swoosh: a ribbon of light left in the air where a swung weapon has just been, between where its tip was and
 * where a point part way down it was, brightest at the tip and newest, fading out behind. It is drawn from where
 * the weapon really went, frame by frame, so it follows any swing; a weapon moving slowly leaves none. A fast
 * swing turns a long way between two frames, so the stretch between is filled in round the arc the weapon turned
 * through (about the hand), not cut straight across.
 */
function makeSwoosh() {
  const n = SWOOSH.most;
  const positions = new Float32Array(n * 6);
  const colors = new Float32Array(n * 8).fill(1);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
  const index: number[] = [];
  for (let i = 0; i < n - 1; i++) index.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
  geometry.setIndex(index);
  const material = new THREE.MeshBasicMaterial({ color: "#f4f8ff", vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.visible = false;
  spare.push(geometry, material);
  const trail: { t: number; tip: THREE.Vector3; mid: THREE.Vector3; a: number }[] = [];
  const was = { hand: new THREE.Vector3(), tip: new THREE.Vector3(), a: 0 };
  const arm = { from: new THREE.Vector3(), to: new THREE.Vector3(), at: new THREE.Vector3(), hand: new THREE.Vector3() };
  let seen = -Infinity;
  return {
    mesh,
    hide() {
      trail.length = 0;
      mesh.visible = false;
      seen = -Infinity;
    },
    /** Where the hand and the weapon's tip are now, at `t` seconds; `on`, whether a blow is being struck. */
    track(t: number, hand: THREE.Vector3, tip: THREE.Vector3, on: boolean) {
      const dt = t - seen;
      // The clock stopped: as it was. It jumped: start over.
      if (dt === 0) return;
      let a = 0;
      if (dt < 0 || dt > 0.2) trail.length = 0;
      else if (on) {
        a = Math.min(1, Math.max(0, (tip.distanceTo(was.tip) / dt - SWOOSH.slow) / (SWOOSH.fast - SWOOSH.slow)));
        if (a > 0 || trail.length > 0) {
          // From where it was last frame to where it is, a step for each little turn of the weapon about the hand.
          arm.from.copy(was.tip).sub(was.hand);
          arm.to.copy(tip).sub(hand);
          const steps = Math.max(1, Math.min(12, Math.ceil(arm.from.angleTo(arm.to) / SWOOSH.arc)));
          for (let i = 1; i <= steps; i++) {
            const k = i / steps;
            arm.at.copy(arm.from).lerp(arm.to, k).setLength(arm.from.length() + (arm.to.length() - arm.from.length()) * k);
            arm.hand.copy(was.hand).lerp(hand, k);
            trail.push({ t: seen + dt * k, tip: arm.hand.clone().add(arm.at), mid: arm.hand.clone().addScaledVector(arm.at, SWOOSH.inner), a: was.a + (a - was.a) * k });
          }
        }
      }
      was.hand.copy(hand);
      was.tip.copy(tip);
      was.a = a;
      seen = t;
      while (trail.length > 0 && (t - trail[0].t > SWOOSH.life || trail.length > n)) trail.shift();
      mesh.visible = trail.length > 1;
      if (!mesh.visible) return;
      trail.forEach((s, i) => {
        s.tip.toArray(positions, i * 6);
        s.mid.toArray(positions, i * 6 + 3);
        colors[i * 8 + 3] = SWOOSH.bright * s.a * (1 - (t - s.t) / SWOOSH.life);
        colors[i * 8 + 7] = 0;
      });
      geometry.setDrawRange(0, (trail.length - 1) * 6);
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.color.needsUpdate = true;
    },
  };
}

/** How far up a hold's own +y what is held in it reaches: the top of everything drawn there, in the hold's frame. */
function reachUp(hold: THREE.Object3D): number {
  hold.updateWorldMatrix(true, true);
  const back = new THREE.Matrix4().copy(hold.matrixWorld).invert();
  const all = new THREE.Box3();
  const one = new THREE.Box3();
  const into = new THREE.Matrix4();
  hold.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry?.attributes.position) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    all.union(one.copy(mesh.geometry.boundingBox!).applyMatrix4(into.multiplyMatrices(back, mesh.matrixWorld)));
  });
  return all.isEmpty() ? 0 : all.max.y;
}

/** A blow taken: the body thrown back off its feet a little, head snapped back, arms flung wide, then gathered again. */
const FLINCH = {
  over: 0.42,
  lean: [[0, 0], [0.06, -0.42], [0.2, 0.1], [0.42, 0]] as Keys,
  head: [[0, 0], [0.05, -0.5], [0.2, 0.12], [0.42, 0]] as Keys,
  back: [[0, 0], [0.07, -1.0], [0.24, -0.25], [0.42, 0]] as Keys,
  fling: [[0, 0], [0.06, 1], [0.2, 0.35], [0.42, 0]] as Keys,
  sway: [[0, 0], [0.07, 0.16], [0.42, 0]] as Keys,
  crouch: [[0, 0], [0.09, 0.3], [0.42, 0]] as Keys,
};
/**
 * Braced behind a guard: knees bent, weight forward, a shield (or, with none, what is in hand and the other
 * forearm) brought up before the body, held a moment and let down. `hold` is when the guard is up.
 */
const GUARD = { hold: 0.22, over: 1.2, up: [[0, 0], [0.22, 1], [0.85, 1], [1.2, 0]] as Keys };

/**
 * A challenge bellowed (Taunt): no weapon in it. The figure draws itself up and back for breath, then throws its
 * chest forward and its arms out wide, head up, and roars at `roar`, holding it with a shake of the fists before
 * it lets go. `lean` is forward (below 0 back), `spread` how far the arms are flung, `head` its tip (below 0 up).
 */
const TAUNT = {
  roar: 0.3,
  over: 1.2,
  lean: [[0, 0], [0.22, -0.26], [0.32, 0.28], [0.85, 0.22], [1.2, 0]] as Keys,
  spread: [[0, 0], [0.22, 0.25], [0.32, 1], [0.85, 1], [1.2, 0]] as Keys,
  head: [[0, 0], [0.22, -0.12], [0.32, -0.35], [0.85, -0.3], [1.2, 0]] as Keys,
  crouch: [[0, 0], [0.32, 0.22], [0.85, 0.2], [1.2, 0]] as Keys,
};
/**
 * A jump from one tile to another. The figure only makes the shapes of it; whoever jumps it carries it through
 * the air (see WorldRenderer.leapUnit). A crouch with the arms drawn back (`coil`), and at `spring` the legs
 * straighten and the feet leave the ground, the body tipping forward all the while (`lean`, and `wind` for the arms). Off it, the arms are thrown forward and up (`arms`, -1 back to 1 up),
 * the body is laid forward into the leap and comes upright (`pitch`), one knee is driven ahead of the other
 * (`split`), both are drawn up at the top (`tuck`) and the feet are put out ahead to land on (`reach`): all keyed
 * to how far through the air it is, 0 to 1, however long that takes. Then it comes down into a deep crouch, arms
 * out for balance (`sink`, in seconds from landing), and stands, `land` seconds after touching down.
 */
const JUMP = {
  spring: 0.16,
  land: 0.36,
  coil: [[0, 0], [0.11, 1], [0.16, 0]] as Keys,
  wind: [[0, 0], [0.1, -1], [0.16, 0.3]] as Keys,
  lean: [[0, 0], [0.16, 0.5]] as Keys,
  arms: [[0, 0.3], [0.3, 1], [0.65, 0.8], [1, 0.3]] as Keys,
  pitch: [[0, 0.5], [0.35, 0.12], [0.7, -0.12], [1, 0.2]] as Keys,
  split: [[0, 0], [0.22, 1], [0.6, 0.35], [1, 0]] as Keys,
  tuck: [[0, 0], [0.5, 1], [0.82, 0.5], [1, 0.12]] as Keys,
  reach: [[0.45, 0], [0.88, 1], [1, 0.6]] as Keys,
  sink: [[0, 0], [0.07, 1], [0.16, 0.85], [0.36, 0]] as Keys,
};
/** Where a bell rung in the hand sounds from, in the hand's frame: its mouth, hanging below the fist. */
const BELL_MOUTH = new THREE.Vector3(0, -2.2, 0);
/**
 * Work at a trade, not a fight: a smith's blow on the anvil (`hammer`), and a stir of a cauldron (`stir`). Neither
 * steps in. The hammer is raised high on the near side of the head, brought straight down to the anvil before the
 * figure as the body drops behind it (`hit`), bounces off it, and is lifted a little for the next. `up` is how high
 * the hammer is, 0 (on the anvil) to 1 (raised). A stir goes twice round the pot before the figure, in `over`
 * seconds (a long while, so a keeper asked to stir again and again does not straighten up between), the paddle
 * pointing down into it in both hands.
 */
const HAMMER = { hit: 0.4, over: 0.86, up: [[0, 0.25], [0.3, 1], [0.4, 0], [0.48, 0.18], [0.86, 0.25]] as Keys };
const STIR = { over: 30, turns: 25 };
/** How long each kind of action lasts. */
const ACT_OVER: Record<Act["kind"], number> = { strike: SWING.over, stab: THRUST.over, pounce: POUNCE.over, heavy: SWEEP.over, twin: TWIN.over, cast: CAST.over, play: PLAY.over, fire: FIRE.ends, guard: GUARD.over, taunt: TAUNT.over, hit: FLINCH.over, hammer: HAMMER.over, stir: STIR.over, jump: JUMP.spring + JUMP.land };
/** When each kind of blow lands. */
const ACT_HIT = { strike: SWING.hit, stab: THRUST.hit, pounce: POUNCE.hit, heavy: SWEEP.hit, twin: TWIN.hit };
/**
 * The weapons whose ordinary blow is not a cut, by weapon or by the icon in the hand: a dagger's is a leap and a
 * stab downward (see POUNCE), a rapier's a straight thrust at arm's length (see THRUST). An archer strikes with
 * the knife kept for it (see heldGear), as with a dagger; and bare hands jab straight out, a punch.
 */
const LIGHT: Record<string, "pounce" | "stab"> = { daggers: "pounce", dirk: "pounce", rapier: "stab", shortbow: "pounce", crossbow: "pounce", pistol: "pounce", blunderbuss: "pounce", harpoon_gun: "pounce", bow: "pounce", none: "stab" };
/** The blows a knife kept out of sight is drawn for (see biped's sidearm). */
const DRAWN = new Set<Act["kind"]>(["strike", "stab", "pounce", "heavy", "twin"]);
/** Things cast with by being held up, not swung: lifted high beside the head, then presented to the mark in both hands, upright all the while. */
const FOCUS = new Set(["orb", "astrolabe", "bilge-chalice"]);

interface Rig {
  parts: Part[];
  animate(a: Anim): void;
  /** Never touches the ground (a ghost, a bat) or is all one wet thing (a slime): no mud on it. */
  clean?: boolean;
  /** A person's fists, right then left: where they hold things, and take hold of oars. */
  hands?: [THREE.Object3D, THREE.Object3D];
  /** What the right hand carries on a hold of its own (an open book, a long gun): put down at the oars with the rest. */
  carried?: THREE.Object3D[];
  /** Draw and loose the bow carried, if one is (see Figure.loose). */
  loose?: () => number;
  /** Plays strikes and hits as timed animations of its own (see Act); a rig without is leant into them, as it always was. */
  acts?: boolean;
  /** Its ordinary strike, where what it carries does not cut (see LIGHT): a leaping stab, or a straight thrust. */
  light?: "pounce" | "stab";
  /** It carries an instrument, and plays it (see Figure.play). */
  plays?: boolean;
  /** It carries a gun or a crossbow, and fires it (see Figure.fire); `long` is one that takes both hands. */
  fires?: boolean;
  long?: boolean;
  /** A weapon in each hand: its heavy strike is both flipped over and jabbed downward, not a sweep. */
  twin?: boolean;
  /** The stages it goes through getting up (see GetUp), posed by `animate`; without, it eases straight up from how it lay. */
  getUp?: readonly GetUp[];
}

// ---------- people ----------

/** The joints every two-legged figure shares, and how they move. */
function biped(top: THREE.Group, parts: Part[], elbow = ELBOW) {
  const part = (parent: THREE.Object3D, x: number, y: number, z: number) => {
    const p = new Part(parent, x, y, z);
    parts.push(p);
    return p;
  };
  // The proportions chosen (all 1 for a stock figure): longer legs lift the hips, broader shoulders set the arms out.
  const hipY = 5 * m.legs;
  /** How long a thigh is, and a shin: this figure's own (the measures in force now are the next figure's later). */
  const shank = -KNEE * m.legs;
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
  // An arm is an upper arm from the shoulder and a forearm from the elbow. It is still drawn as one limb in the
  // shoulder's space: the part shares what is drawn on it between the two, and cuts a sleeve at the elbow.
  const foreR = part(armR.joint, 0, elbow, 0);
  const foreL = part(armL.joint, 0, elbow, 0);
  armR.jointAt(elbow, foreR);
  armL.jointAt(elbow, foreL);
  const limbGirth = (1 + m.girth) / 2;
  for (const arm of [armR, armL, foreR, foreL]) arm.skin.scale.set(limbGirth, 1, limbGirth);
  const legR = limb(thighR, shinR);
  const legL = limb(thighL, shinL);
  // What a weight swinging from the right hand can bump: all but that arm, which carries it.
  bodyParts = [torso, head, thighR, thighL, shinR, shinL, armL, foreL];
  // What each hand holds, in the middle of the fist, kept upright however the arm is bent.
  const fist = lowPoly ? -5.25 : -5;
  const heldR = part(foreR.joint, 0, fist - elbow, 0);
  const heldL = part(foreL.joint, 0, fist - elbow, 0);
  /** How far forward each upper arm rests, how far its elbow is bent (forward is below zero), and how what it holds is tipped. */
  const rest = { armR: -0.15, armL: -0.05, bendR: FREE_BEND, bendL: FREE_BEND, twistL: 0, twistR: 0, tiltR: 0, tiltL: 0 };
  // A forearm turns about the upper arm before it bends, so it can be brought across the body (a shield arm).
  foreL.joint.rotation.order = foreR.joint.rotation.order = "YXZ";
  /** What the left arm carries across the front (a shield's strap, a bow's grip): each kept standing as the body does. */
  /** A shield on the left arm (see shield): what a guard is made with. */
  let shielded = false;
  const levels: THREE.Object3D[] = [];
  /** And what the right arm carries before the chest (an open book), kept standing the same way. */
  const levelsR: THREE.Object3D[] = [];
  const level = { arm: new THREE.Quaternion() };
  /**
   * Carry a shield: the left arm bent round in front of the body, and on its forearm a strap that keeps the
   * shield upright and facing the front however the arm is bent. Returns the part to draw the shield on, laid
   * out as it always was on a straight arm (its middle about half a unit out, three down and two forward).
   */
  const shield = (): Part => {
    shielded = true;
    rest.armL = SHIELD_ARM.arm;
    rest.bendL = SHIELD_ARM.bend;
    rest.twistL = SHIELD_ARM.twist;
    const on = part(foreL.joint, 0, -1.7, 0);
    levels.push(on.joint);
    return part(on.joint, -0.5, 2.6, -0.7);
  };
  /**
   * Carry something in the right hand before the chest (an open book): the forearm turned in across the front.
   * Returns a part at the fist that stands as the body does, +y up and +z to the front.
   */
  const before = (): Part => {
    rest.twistR = BEFORE_TWIST;
    const on = part(foreR.joint, 0, fist - elbow, 0);
    levelsR.push(on.joint);
    return on;
  };
  /**
   * Carry something in the left fist across the front of the body (a bow): the arm bent round before the
   * belly. Returns a part at the fist that stands as the body does, +y up and +z to the front.
   */
  const across = (): Part => {
    rest.armL = ACROSS_ARM.arm;
    rest.bendL = ACROSS_ARM.bend;
    rest.twistL = ACROSS_ARM.twist;
    const on = part(foreL.joint, 0, fist - elbow, 0);
    levels.push(on.joint);
    return on;
  };
  /**
   * Hold something up in the left fist (a lit torch): the arm forward and bent so the fist is at the shoulder,
   * out in front. Returns a part at the fist that stands as the body does, +y up and +z to the front.
   */
  const aloft = (): Part => {
    rest.armL = TORCH_ARM.arm;
    rest.bendL = TORCH_ARM.bend;
    rest.twistL = TORCH_ARM.twist;
    const on = part(foreL.joint, 0, fist - elbow, 0);
    levels.push(on.joint);
    return on;
  };
  // What the hands hold leans out from the body, far enough to clear the head (see heldLean).
  const lean = lowPoly ? heldLean(shoulderX) : 0;
  /** A strung bow in the left hand (see heldGear), and the shot being made with it: when it began, and whether the next strike starts another. */
  let strung: Strung | null = null;
  const shot = { at: -Infinity, asked: false };
  /** Begin a shot on the next frame, if a bow is carried. Returns the seconds until the arrow leaves the string (0 with no bow). */
  const loose = (): number => {
    if (!strung) return 0;
    shot.asked = true;
    return BOW_DRAW;
  };
  const string = (bow: Strung) => {
    strung = bow;
    stringTo(bow, 0, true);
  };
  /** Lay the string from each tip to the nock, drawn back `pull`, the arrow on it (or gone, once loosed). */
  const stringTo = (bow: Strung, pull: number, nocked: boolean) => {
    bow.halves.forEach((half, i) => {
      const dy = (i === 0 ? -1 : 1) * bow.tip.y;
      half.joint.rotation.z = Math.atan2(-pull, -dy);
      half.joint.scale.y = Math.hypot(pull, dy);
    });
    bow.arrow.joint.position.x = bow.tip.x - pull;
    bow.arrow.joint.visible = nocked;
  };
  const aim = { grip: new THREE.Vector3(), nock: new THREE.Vector3(), down: new THREE.Vector3(0.5, -1, -0.2), back: new THREE.Vector3(-0.7, 0.15, -0.7), m: new THREE.Matrix4() };
  /** Keep what the left arm carries across the front standing as the body does, however the arm is posed just now. */
  const settle = () => {
    if (levels.length > 0) {
      level.arm.copy(armL.joint.quaternion).multiply(foreL.joint.quaternion).invert();
      for (const joint of levels) joint.quaternion.copy(level.arm);
    }
    if (levelsR.length > 0) {
      level.arm.copy(armR.joint.quaternion).multiply(foreR.joint.quaternion).invert();
      for (const joint of levelsR) joint.quaternion.copy(level.arm);
    }
  };
  /**
   * Shooting a bow, `since` seconds into it: the archer turns side-on, pushes the bow out toward the mark (it
   * comes upright, its belly to the mark), the other hand takes the string and draws it back with the arrow,
   * and looses; then the hand stays back a moment as the bow comes down.
   */
  const shoot = (bow: Strung, since: number) => {
    const ease = (a: number, b: number) => {
      const t = Math.min(1, Math.max(0, (since - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    const up = ease(0, 0.1) * (1 - ease(0.5, SHOT.over));
    const loosed = since >= SHOT.loose;
    const draw = ease(0.05, SHOT.loose - 0.03);
    top.rotation.y = -SHOT.turn * up;
    head.joint.rotation.y = SHOT.turn * 0.85 * up;
    // The bow hand: out toward the mark, which lies to the left of a body turned side-on, at chest height.
    const [ux, uz] = [Math.sin(SHOT.turn), Math.cos(SHOT.turn)];
    const reachOut = -bow.tip.x;
    aim.grip.set(-0.5 + reachOut * ux, 5.2, 2.8 + reachOut * uz);
    reach(armL.joint, foreL.joint, -elbow, elbow - fist, aim.grip, aim.down, up);
    settle();
    bow.bow.joint.rotation.set(0, -(HALF_PI - SHOT.turn) * up, BOW_CANT + (-0.12 - BOW_CANT) * up);
    bow.bow.joint.position.z = BOW_OUT * (1 - up);
    stringTo(bow, loosed ? 0 : draw * SHOT.pull, !loosed);
    // The string hand: to the nock, back with it, and a little further as it lets go.
    torso.joint.updateWorldMatrix(true, true);
    aim.nock.set(bow.tip.x - (draw + (loosed ? 0.2 * ease(SHOT.loose, SHOT.loose + 0.1) : 0)) * SHOT.pull, 0, 0);
    aim.nock.applyMatrix4(aim.m.copy(torso.joint.matrixWorld).invert().multiply(bow.bow.joint.matrixWorld));
    reach(armR.joint, foreR.joint, -elbow, elbow - fist, aim.nock, aim.back, up);
  };
  /** An instrument played in the hands (see sling): where it is held at rest, how long it is, and the notes of its song. */
  let music: { kind: Instrument; joint: THREE.Object3D; home: { pos: THREE.Vector3; quat: THREE.Quaternion }; span: number; notes: ReturnType<typeof makeNotes>; from: THREE.Vector3; mouth: THREE.Vector3; axis: THREE.Vector3 } | null = null;
  const instrument = (kind: Instrument, held: Part, span: number, color: string) => {
    const notes = makeNotes(color, kind === "accordion" ? 1.8 : 1);
    torso.joint.add(notes.group);
    music = { kind, joint: held.joint, home: { pos: held.joint.position.clone(), quat: held.joint.quaternion.clone() }, span, notes, from: new THREE.Vector3(), mouth: new THREE.Vector3(), axis: new THREE.Vector3(1, 0.14, 0).normalize() };
  };
  /** Motes of light off what the right hand holds (see makeMotes): where on it they rise from, in the hand's frame. */
  /**
   * A gun or a crossbow carried (see heldGear and GUNS): the joint it is held by (the right hand's hold for a
   * pistol, its own for a long gun, which is turned to aim), its muzzle and its fore-end in that frame, and the
   * smoke it makes. The smoke hangs in the figure's own frame, not the torso's, so it stays put as the body turns.
   */
  let gun: { long: boolean; frame: THREE.Object3D; muzzle: THREE.Vector3; ahead: THREE.Vector3; fore: THREE.Vector3; smoke: ReturnType<typeof makeSmoke> | null; at: THREE.Vector3; way: THREE.Vector3 } | null = null;
  const armed = (long: boolean, frame: THREE.Object3D, muzzle: Pt, smoke: number) => {
    const fumes = smoke > 0 ? makeSmoke(smoke) : null;
    if (fumes) top.parent?.add(fumes.group);
    gun = { long, frame, muzzle: new THREE.Vector3(...muzzle), ahead: new THREE.Vector3(muzzle[0], muzzle[1], muzzle[2] + 1), fore: new THREE.Vector3(0, -0.25, 3.8), smoke: fumes, at: new THREE.Vector3(), way: new THREE.Vector3() };
  };
  /**
   * Which way what the right hand holds cuts, in the hold's frame: +z, for a model turned edge-forward in the
   * hand (an axe, a hammer's face, a curved blade) and for anything drawn in place; +x, for one held as its
   * model is made, flat to the front (a straight sword). A sweep leads with it.
   */
  let cuts: "x" | "z" = "z";
  const cutsAlong = (axis: "x" | "z") => {
    cuts = axis;
  };
  /** The swooshes behind what the hands swing, made the first time a blow is struck: the hold, how far up it the weapon reaches, and where that is this frame. */
  let swung: { hold: THREE.Object3D; tipAt: THREE.Vector3; handAt: THREE.Vector3; tip: THREE.Vector3; hand: THREE.Vector3; swoosh: ReturnType<typeof makeSwoosh> }[] | null = null;
  const trails = (a: Anim) => {
    const striking = !!a.act && DRAWN.has(a.act.kind) && !a.lying && a.sitting === 0;
    if (!swung) {
      if (!striking || !top.parent) return;
      swung = [];
      for (const held of [heldR, heldL]) {
        // Only something long enough to swing: not a bare fist, nor a thing that hangs below it.
        const far = reachUp(held.joint);
        if (far < 2.5) continue;
        const swoosh = makeSwoosh();
        top.parent.add(swoosh.mesh);
        swung.push({ hold: held.joint, tipAt: new THREE.Vector3(0, far, 0), handAt: new THREE.Vector3(), tip: new THREE.Vector3(), hand: new THREE.Vector3(), swoosh });
      }
    }
    for (const s of swung) {
      if (a.lying || !top.parent) s.swoosh.hide();
      else s.swoosh.track(a.t, placeOf(s.hold, s.handAt, s.hand, top.parent), placeOf(s.hold, s.tipAt, s.tip, top.parent), striking);
    }
  };
  /** A focus in the right hand (see FOCUS): cast with by being held aloft. */
  let focus = false;
  const focuses = () => {
    focus = true;
  };
  /** A knife in the right fist, out of sight until a blow is struck with it (an archer's: see heldGear). */
  let sidearm: THREE.Object3D | null = null;
  const sidearms = (knife: THREE.Object3D) => {
    sidearm = knife;
    knife.visible = false;
  };
  /** A weapon in each hand (see carryLeft): the heavy strike is both together. */
  let paired = false;
  const pair = () => {
    paired = true;
  };
  /** An open book carried before the chest (see openBook): a cast is the other hand waved over it. */
  let reading: THREE.Object3D | null = null;
  const reads = (book: THREE.Object3D) => {
    reading = book;
    castPace = BOOK_CAST_PACE;
  };
  const chain = new THREE.Matrix4();
  /** Where `at`, a point in `frame` (any joint hung, however far down, from the torso), is in the torso's own frame (or `root`'s, further up). */
  const placeOf = (frame: THREE.Object3D, at: THREE.Vector3, out: THREE.Vector3, root: THREE.Object3D = torso.joint) => {
    chain.identity();
    for (let joint: THREE.Object3D | null = frame; joint && joint !== root; joint = joint.parent) {
      joint.updateMatrix();
      chain.premultiply(joint.matrix);
    }
    return out.copy(at).applyMatrix4(chain);
  };
  let glow: { motes: ReturnType<typeof makeMotes>; at: THREE.Vector3; frame: THREE.Object3D; from: THREE.Vector3 } | null = null;
  /** Motes rise from `at`, in the frame of `frame` (the right hand's hold unless given: any joint hung, however far down, from the torso). */
  const emits = (color: string, at: Pt, frame: THREE.Object3D = heldR.joint) => {
    const motes = makeMotes(color);
    torso.joint.add(motes.group);
    glow = { motes, at: new THREE.Vector3(...at), frame, from: new THREE.Vector3() };
  };
  const sweep = {
    dir: new THREE.Vector3(),
    grip: new THREE.Vector3(),
    /** Over an open book's left page, in the book's frame: where a hand is waved (see the cast). */
    over: new THREE.Vector3(1.6, 1.9, -0.6),
    poleR: new THREE.Vector3(-0.6, -0.8, -0.2),
    poleL: new THREE.Vector3(0.6, -0.8, -0.2),
    want: new THREE.Quaternion(),
    hold: new THREE.Quaternion(),
    euler: new THREE.Euler(),
    edge: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), HALF_PI),
    lead: new THREE.Vector3(),
    side: new THREE.Vector3(),
    m: new THREE.Matrix4(),
  };
  /**
   * A strike or a hit, laid over the pose just set: the weapon arm, the hand's hold, the body and the legs follow
   * the action's keys, easing in from however the figure stood and back out to it.
   */
  const blow = (act: Act, scale: number) => {
    const t = act.t;
    /**
     * Step in toward the mark, `by` of a STRIDE: the body goes forward, the left foot ahead of it and the right
     * trailing on a bent knee, the hips coming down as the legs part, so by the full stride it stands in a lunge.
     */
    const stride = (by: number) => {
      top.position.z += by * STRIDE * scale;
      const gait = Math.sin(Math.min(1, Math.max(0, by)) * HALF_PI);
      thighL.joint.rotation.x -= gait * 0.75;
      thighR.joint.rotation.x += gait * 0.75;
      shinR.joint.rotation.x += gait * 0.5;
      footL.joint.rotation.x += gait * 0.75;
      top.position.y -= shank * (1 - Math.cos(gait * 0.75)) * 1.6;
    };
    /** Bend at the knees by `c`: the thighs forward, the shins back under them, the feet flat, and the hips lowered by what the legs give up, so the feet stay on the ground. */
    const knees = (c: number) => {
      for (const thigh of [thighL, thighR]) thigh.joint.rotation.x -= c * 0.9;
      for (const shin of [shinL, shinR]) shin.joint.rotation.x += c * 1.8;
      for (const foot of [footL, footR]) foot.joint.rotation.x -= c * 0.9;
      top.position.y -= 2 * shank * (1 - Math.cos(c * 0.9));
    };
    /** Lean and turn, most of it at the waist and the rest through the whole body, so the feet stay planted. */
    const bow = (lean: number, twist: number) => {
      top.rotation.x += lean * 0.3;
      top.rotation.y += twist * 0.3;
      torso.joint.rotation.x += lean * 0.7;
      torso.joint.rotation.y += twist * 0.7;
    };
    if (act.kind === "hit") {
      const fling = along(FLINCH.fling, t);
      bow(along(FLINCH.lean, t), 0);
      // Rocked to one side or the other, turn about.
      top.rotation.z += along(FLINCH.sway, t) * (act.n % 2 ? 1 : -1);
      top.position.z += along(FLINCH.back, t);
      head.joint.rotation.x += along(FLINCH.head, t);
      armL.joint.rotation.x += 0.35 * fling;
      armR.joint.rotation.x += 0.35 * fling;
      armL.joint.rotation.z += 0.5 * fling;
      armR.joint.rotation.z -= 0.5 * fling;
      foreL.joint.rotation.x -= 0.45 * fling;
      foreR.joint.rotation.x -= 0.3 * fling;
      knees(along(FLINCH.crouch, t));
      return;
    }
    if (act.kind === "jump") {
      const air = act.air ?? 0.4;
      // How far through the air, held at 0 on the way up to the spring; and the seconds since coming down.
      const u = Math.min(1, Math.max(0, (t - JUMP.spring) / air));
      const down = t - JUMP.spring - air;
      const coil = along(JUMP.coil, t);
      const sink = along(JUMP.sink, down);
      // What the limbs were doing in the air goes out of them as the ground takes the weight.
      const k = Math.min(1, Math.max(0, down / 0.09));
      const aloft = t < JUMP.spring ? 0 : 1 - k * k * (3 - 2 * k);
      const tuck = along(JUMP.tuck, u) * aloft;
      const split = along(JUMP.split, u) * aloft;
      const ahead = along(JUMP.reach, u) * aloft;
      // Crouched to spring, and again to take the landing: the feet are on the ground for both.
      knees(0.62 * coil + 0.8 * sink);
      const pitch = t < JUMP.spring ? along(JUMP.lean, t) : along(JUMP.pitch, u) * aloft;
      bow(pitch + 0.5 * sink, 0);
      head.joint.rotation.x -= (pitch + 0.5 * sink) * 0.55;
      // In the air nothing holds the feet down: the left knee is driven up ahead and the right leg trails, both
      // are drawn up under the body over the top, and then the feet go out in front to meet the ground.
      thighL.joint.rotation.x -= 0.75 * split + 0.95 * tuck + 0.35 * ahead;
      shinL.joint.rotation.x += 0.9 * split + 1.5 * tuck - 0.55 * ahead * tuck;
      thighR.joint.rotation.x += 0.6 * split - 0.8 * tuck - 0.35 * ahead;
      shinR.joint.rotation.x += 0.35 * split + 1.3 * tuck - 0.5 * ahead * tuck;
      // Toes pointed while off the ground.
      const toes = 0.45 * aloft * Math.sin(Math.PI * Math.min(1, u * 1.15));
      footL.joint.rotation.x += toes;
      footR.joint.rotation.x += toes;
      // The arms: drawn back in the crouch, thrown forward and up with the spring, and brought down and out to
      // the sides for balance on landing. An arm with something carried across the front keeps mostly to its work.
      const swing = t < JUMP.spring ? along(JUMP.wind, t) : along(JUMP.arms, u) * (1 - Math.min(1, Math.max(0, down / 0.22)));
      const lift = swing < 0 ? -0.9 * swing : -2.2 * swing;
      const wide = 0.55 * sink + 0.25 * Math.max(0, swing);
      const left = levels.length > 0 ? 0.25 : 1;
      const right = levelsR.length > 0 ? 0.25 : 0.7;
      armL.joint.rotation.x += lift * left;
      armL.joint.rotation.z += wide * left;
      foreL.joint.rotation.x -= 0.5 * foreL.joint.rotation.x * Math.max(0, -swing) * left;
      // The weapon arm goes up less far, and what it holds stays pointing as it did, not swung over with the arm.
      armR.joint.rotation.x += lift * right;
      armR.joint.rotation.z -= wide * right;
      heldR.joint.rotation.x -= lift * right;
      if (levels.length === 0) heldL.joint.rotation.x -= lift * left;
      return;
    }
    const k = act.kind === "stab" ? THRUST : act.kind === "pounce" ? POUNCE : act.kind === "twin" ? TWIN : SWING;
    // Eased in over the first moments and back out over the last, so it starts and ends wherever the figure was.
    const over = act.kind === "heavy" ? SWEEP.over : act.kind === "cast" ? CAST.over : act.kind === "play" ? PLAY.over : act.kind === "guard" ? GUARD.over : act.kind === "taunt" ? TAUNT.over : act.kind === "hammer" || act.kind === "stir" ? ACT_OVER[act.kind] : k.over;
    const fade = Math.min(1, Math.max(0, (over - t) / 0.18));
    const w = Math.min(1, t / 0.05) * fade * fade * (3 - 2 * fade);
    /**
     * Carry what the right hand holds to `sweep.grip`, lying along `sweep.dir` (both in the torso's frame), `w` of
     * the way from however it was held: the arm bends to reach, and the hold turns to keep the line.
     */
    if (act.kind === "fire") {
      if (!gun) return;
      const f = gun.long ? FIRE.long : FIRE.hand;
      const ease = (from: number, till: number) => {
        const k = Math.min(1, Math.max(0, (t - from) / (till - from)));
        return k * k * (3 - 2 * k);
      };
      // Brought up to the aim and let down again; and from the shot, a kick that dies away.
      const up = ease(0, f.aim) * (1 - ease(f.down, f.over));
      const kick = t >= f.shot ? Math.exp(-(t - f.shot) * 9) : 0;
      if (!gun.long) {
        // A pistol: straight out from the shoulder, level; the shot throws the hand back and up, the muzzle with it.
        bow((0.08 - 0.22 * kick) * up, 0);
        sweep.grip.set(armR.joint.position.x * 0.75, 6.2 + 0.7 * kick, 4.6 - 1.0 * kick);
        reach(armR.joint, foreR.joint, -elbow, elbow - fist, sweep.grip, sweep.poleR, up);
        sweep.want.setFromEuler(sweep.euler.set(-0.6 * kick, 0, 0));
        sweep.hold.copy(armR.joint.quaternion).multiply(foreR.joint.quaternion).invert().multiply(sweep.want);
        heldR.joint.quaternion.slerp(sweep.hold, up);
        if (levels.length === 0) armL.joint.rotation.x += 0.4 * up;
        return;
      }
      // A long gun: the body turns side-on behind it and the head stays on the mark. The gun is levelled at the
      // chest and held out from the body in both hands (the other goes with it: see `steady`), not brought up to
      // the cheek: a head this size, and any helmet on it, hangs out over the shoulders, and a gun at the
      // shoulder would be inside it. The shot rocks the shooter back and jumps the muzzle.
      top.rotation.y -= FIRE.turn * up;
      head.joint.rotation.y += FIRE.turn * 0.85 * up;
      head.joint.rotation.x += 0.12 * up;
      bow((0.12 - 0.3 * kick) * up, 0);
      knees(0.15 * up);
      const [ux, uz] = [Math.sin(FIRE.turn), Math.cos(FIRE.turn)];
      const fwd = GUN_AIM.along - 0.7 * kick;
      sweep.grip.set(ux * fwd - uz * GUN_AIM.out, GUN_AIM.high + 0.15 * kick, uz * fwd + ux * GUN_AIM.out);
      reach(armR.joint, foreR.joint, -elbow, elbow - fist, sweep.grip, sweep.poleR, up);
      gun.frame.rotation.set(GUN_PORT.pitch + (-0.3 * kick - GUN_PORT.pitch) * up, GUN_PORT.yaw + (FIRE.turn - GUN_PORT.yaw) * up, 0);
      return;
    }
    if (act.kind === "play") {
      if (!music) return;
      // In time: about three strums (or breaths) a second, the body rocking at half that.
      const beat = t * 20;
      bow(0.04 * Math.sin(beat) * w, 0);
      top.rotation.z += 0.045 * Math.sin(beat * 0.5) * w;
      knees(0.07 * (0.5 + 0.5 * Math.sin(beat)) * w);
      if (music.kind === "bell") {
        // Rung: lifted high and out beside the head, and swung from the wrist to and fro on the beat, hanging
        // below the fist however the arm is turned; the head tips to it and the free arm comes out for balance.
        const rock = Math.sin(beat);
        sweep.grip.set(armR.joint.position.x * 0.8, 8.4 + 0.25 * Math.abs(rock), 3.8);
        reach(armR.joint, foreR.joint, -elbow, elbow - fist, sweep.grip, sweep.poleR, w);
        sweep.want.setFromEuler(sweep.euler.set(0, 0, 0.6 * rock));
        sweep.hold.copy(armR.joint.quaternion).multiply(foreR.joint.quaternion).invert().multiply(sweep.want);
        heldR.joint.quaternion.slerp(sweep.hold, w);
        head.joint.rotation.z += 0.1 * Math.sin(beat * 0.5 + 0.6) * w;
        if (levels.length === 0) armL.joint.rotation.z += 0.3 * w;
        placeOf(heldR.joint, BELL_MOUTH, music.from);
      } else if (music.kind === "lute") {
        // The strumming hand goes down and up across the strings, the wrist loose; the head nods and tilts along.
        armR.joint.rotation.x += 0.17 * Math.sin(beat) * w;
        foreR.joint.rotation.x += (-0.3 + 0.12 * Math.sin(beat)) * w;
        armL.joint.rotation.x += 0.03 * Math.sin(beat * 0.5 + 1) * w;
        head.joint.rotation.z += 0.12 * Math.sin(beat * 0.5 + 0.6) * w;
        head.joint.rotation.x += 0.06 * Math.sin(beat) * w;
        music.from.copy(music.home.pos);
        music.from.y += 1.6;
      } else if (music.kind === "accordion") {
        // Squeezed shut and drawn open on the beat, an end board in each hand, about its middle; the head sways along.
        const open = 1 + 0.16 * Math.sin(beat * 0.5) * w;
        music.axis.set(0, 1, 0).applyQuaternion(music.home.quat);
        music.from.copy(music.home.pos).addScaledVector(music.axis, music.span / 2);
        music.joint.position.copy(music.from).addScaledVector(music.axis, (-music.span / 2) * open);
        music.joint.scale.y = open;
        reach(armR.joint, foreR.joint, -elbow, elbow - fist, music.joint.position, sweep.poleR, w);
        sweep.grip.copy(music.from).addScaledVector(music.axis, (music.span / 2) * open);
        reach(armL.joint, foreL.joint, -elbow, elbow - fist, sweep.grip, sweep.poleL, w);
        head.joint.rotation.z += 0.12 * Math.sin(beat * 0.5 + 0.6) * w;
        music.from.y += 2;
        // And a jig to it: a foot kicked out ahead on every squeeze and every draw, the right then the left, the
        // knee bent as it comes up and straight at the top of the kick, the body leaning back a little into each.
        const step = Math.sin(beat * 0.5);
        for (const [thigh, shin, foot, kick] of [[thighR, shinR, footR, Math.max(0, step)], [thighL, shinL, footL, Math.max(0, -step)]] as const) {
          thigh.joint.rotation.x -= 0.8 * kick * w;
          shin.joint.rotation.x += 1.6 * kick * (1 - kick) * w;
          foot.joint.rotation.x += 0.35 * kick * w;
        }
        bow(-0.08 * Math.abs(step) * w, 0);
      } else {
        // The flute comes up level before the mouth, a hand toward each end (as near the middle as such short
        // arms and so broad a chest allow), the fingers working.
        const big = head.joint.scale.x;
        music.mouth.set(0, head.joint.position.y + 1.45 * big - 0.55, 2.95 * big + 0.5);
        layAlong(laid, music.from.copy(music.mouth).addScaledVector(music.axis, -music.span / 2), music.axis);
        music.joint.position.lerp(laid.position, w);
        music.joint.quaternion.slerp(laid.quaternion, w);
        sweep.grip.copy(music.mouth).addScaledVector(music.axis, -2.4);
        sweep.grip.y += 0.06 * Math.sin(beat * 2);
        reach(armR.joint, foreR.joint, -elbow, elbow - fist, sweep.grip, sweep.poleR, w);
        sweep.grip.copy(music.mouth).addScaledVector(music.axis, 2.4);
        sweep.grip.y += 0.06 * Math.sin(beat * 2 + 2);
        reach(armL.joint, foreL.joint, -elbow, elbow - fist, sweep.grip, sweep.poleL, w);
        head.joint.rotation.x += 0.06 * w;
        music.from.copy(music.mouth);
        music.from.y += 0.3;
      }
      music.notes.show(t, music.from);
      return;
    }
    /** The right hand to `sweep.grip`, what it holds turned as `sweep.want` says (in the torso's frame): `by` of the way, the action's own easing unless given. */
    const carry = (by = w) => {
      reach(armR.joint, foreR.joint, -elbow, elbow - fist, sweep.grip, sweep.poleR, by);
      sweep.hold.copy(armR.joint.quaternion).multiply(foreR.joint.quaternion).invert().multiply(sweep.want);
      heldR.joint.quaternion.slerp(sweep.hold, by);
    };
    /** What the right hand holds, lying along `sweep.dir` by the shortest turn from upright; `edged`, a quarter turn round its own length besides. */
    const wield = (by = w, edged = true) => {
      sweep.want.setFromUnitVectors(scratch.up, sweep.dir);
      if (edged) sweep.want.multiply(sweep.edge);
      carry(by);
    };
    if (act.kind === "hammer") {
      // At the anvil: the hammer goes up beside the head and comes straight down on the work before the figure,
      // the body bowing and the knees giving behind the blow; the other hand holds the work steady with the tongs.
      const up = along(HAMMER.up, t);
      const side = armR.joint.position.x;
      // The anvil stands low, at the knuckles: the blow comes down to it with a bend at the waist and knees.
      bow((0.16 - 0.24 * up) * w, 0.12 * up * w);
      knees((0.12 * (1 - up)) * w);
      head.joint.rotation.x += 0.26 * w;
      // At the bottom of the blow the hammer's face stops on the work on her anvil, whose face is 0.44 above the
      // floor (measured in the smithy, against the anvil itself); raised, it is up over her head.
      sweep.grip.set(side * 0.7, 6.8 + 3.8 * up, 3.6 - 2.4 * up);
      // The handle stays in the plane of the swing (straight ahead and up), and the hammer's face (the head's +z)
      // always leads, at right angles to the handle on the side it is swinging toward: raised, the face is to the
      // sky; at the blow the handle is level and the face comes straight down on the anvil. Never rolled sideways.
      sweep.dir.set(0, -0.12 + 0.95 * up, 1 - 1.8 * up).normalize();
      sweep.lead.set(0, -sweep.dir.z, sweep.dir.y);
      sweep.side.crossVectors(sweep.dir, sweep.lead);
      sweep.m.makeBasis(sweep.side, sweep.dir, sweep.lead);
      sweep.want.setFromRotationMatrix(sweep.m);
      carry();
      if (levels.length === 0) reach(armL.joint, foreL.joint, -elbow, elbow - fist, sweep.grip.set(-side * 0.5, 4.3, 3.6), sweep.poleL, w);
      return;
    }
    if (act.kind === "stir") {
      // Over the cauldron: both hands on the paddle, its blade down in the pot, going round and round; the body
      // sways with it and the head is bent to the brew.
      const a = (t / STIR.over) * STIR.turns * Math.PI * 2;
      const side = armR.joint.position.x;
      // The paddle is angled out ahead into the pot, not straight down, so its shaft shows between the figure and
      // the brew under a wide hat.
      bow(0.32 * w, 0.12 * Math.sin(a) * w);
      knees(0.1 * w);
      head.joint.rotation.x += 0.3 * w;
      sweep.grip.set(side * 0.2 + 1.3 * Math.cos(a), 5.2, 3.9 + 0.9 * Math.sin(a));
      sweep.dir.set(-0.2 * Math.cos(a), -0.68, 0.72 - 0.12 * Math.sin(a)).normalize();
      wield(w, false);
      if (levels.length === 0) reach(armL.joint, foreL.joint, -elbow, elbow - fist, sweep.grip.addScaledVector(sweep.dir, -2.6), sweep.poleL, w);
      return;
    }
    if (act.kind === "taunt") {
      // Drawn back for breath, then thrown forward: the chest out, the arms flung wide and up, the head back, the
      // knees planted; held with a shake of the fists, and let go.
      const open = along(TAUNT.spread, t);
      bow(along(TAUNT.lean, t), 0);
      knees(along(TAUNT.crouch, t));
      head.joint.rotation.x += along(TAUNT.head, t);
      const shake = t > TAUNT.roar && t < 0.85 ? Math.sin(t * 42) * 0.08 * open : 0;
      armL.joint.rotation.z += 1.15 * open + shake;
      armR.joint.rotation.z -= 1.15 * open + shake;
      armL.joint.rotation.x -= 0.55 * open;
      armR.joint.rotation.x -= 0.55 * open;
      return;
    }
    if (act.kind === "guard") {
      // Braced: the knees bent, the weight forward, the head down behind the guard; held, then let go.
      const up = along(GUARD.up, t);
      knees(0.32 * up);
      head.joint.rotation.x += 0.14 * up;
      if (shielded) {
        // The shield side leads, and the shield comes up and round before the chest and chin.
        bow(0.16 * up, -0.35 * up);
        head.joint.rotation.y += 0.3 * up;
        sweep.grip.set(1.2, 6.5, 4.2);
        reach(armL.joint, foreL.joint, -elbow, elbow - fist, sweep.grip, sweep.poleL, up);
        return;
      }
      bow(0.16 * up, 0.15 * up);
      // No shield: what the right hand holds is laid across the front like a bar, below the chin and tipped
      // forward (clear of the head, however long it is), and the other forearm comes up behind it.
      if (levelsR.length === 0) {
        sweep.grip.set(-1.8, 5.8, 3.6);
        sweep.dir.set(0.8, 0.45, 0.4).normalize();
        wield(up, false);
      }
      if (levels.length === 0) reach(armL.joint, foreL.joint, -elbow, elbow - fist, sweep.grip.set(2.0, 6.3, 3.7), sweep.poleL, up);
      return;
    }
    if (act.kind === "cast" && reading && levels.length === 0) {
      // From an open book: the free hand is waved round over the pages, the head bent to them, and then comes
      // forward to point at the mark as the spell leaves. The book stays where it is held.
      const p = along(CAST.point, t);
      bow((0.12 + 0.1 * p) * w, 0.3 * p * w);
      head.joint.rotation.x += 0.18 * (1 - p) * w;
      knees(along(CAST.crouch, t) * 0.6);
      const round = along(CAST.turn, t) * 1.7;
      placeOf(reading, sweep.over, sweep.grip);
      sweep.grip.x += 0.9 * Math.cos(round);
      sweep.grip.z += 0.6 * Math.sin(round);
      sweep.grip.lerp(sweep.dir.set(armL.joint.position.x * 0.62, 5.9, 4.8), p);
      reach(armL.joint, foreL.joint, -elbow, elbow - fist, sweep.grip, sweep.poleL, w);
      return;
    }
    if (act.kind === "cast") {
      bow(along(CAST.lean, t), along(CAST.twist, t));
      top.position.y += along(CAST.rise, t);
      knees(along(CAST.crouch, t));
      if (focus) {
        // A focus is not swung: it is lifted high beside the head, trembling as the spell gathers, then brought
        // down before the chest and presented to the mark, upright all the way, the other hand coming up to it.
        const p = along(CAST.point, t);
        const side = armR.joint.position.x;
        const [hx, hy, hz] = [side, 10.4 + 0.1 * Math.sin(t * 46), 1.0];
        sweep.grip.set(hx + (-1.6 - hx) * p, hy + (6.2 - hy) * p, hz + (4.2 - hz) * p);
        sweep.dir.set(0, 1, 0.3 * p).normalize();
        wield(w, false);
        if (levels.length > 0) return;
        armL.joint.rotation.x += along(CAST.off, t) * (1 - p);
        reach(armL.joint, foreL.joint, -elbow, elbow - fist, sweep.grip.set(1.5, 5.9, 4.0), sweep.poleL, p * w);
        return;
      }
      // The hand goes round a circle held out to the side and a little forward, clear of the head, what it holds
      // tipped out along the circle and leaning away from the head, then comes down and forward to arm's length,
      // levelled at the mark.
      const turn = along(CAST.turn, t);
      const p = along(CAST.point, t);
      const side = armR.joint.position.x;
      const out = Math.sign(side);
      const [cx, cy, cz] = [side * 1.5 + 0.6 * Math.cos(turn), 8.4, 1.7 + 0.6 * Math.sin(turn)];
      sweep.grip.set(cx + (side * 0.62 - cx) * p, cy + (5.9 - cy) * p, cz + (4.8 - cz) * p);
      sweep.dir.set((0.4 * Math.cos(turn) + 0.75 * out) * (1 - p) + 0.1 * p, 0.8 * (1 - p) + 0.1 * p, (0.45 * Math.sin(turn) + 0.15) * (1 - p) + p).normalize();
      wield();
      if (levels.length === 0) armL.joint.rotation.x += along(CAST.off, t);
      return;
    }
    if (act.kind === "heavy") {
      const twist = along(SWEEP.twist, t);
      bow(along(SWEEP.lean, t), twist);
      stride(along(SWEEP.step, t));
      // The eyes stay on the mark while the body turns under them.
      head.joint.rotation.y -= twist * 0.75;
      knees(along(SWEEP.crouch, t));
      // Which way the weapon points, in the torso's frame, and where the right hand holds it: before the chest,
      // drawn a little toward the side it points.
      const yaw = along(SWEEP.yaw, t);
      const tilt = along(SWEEP.tilt, t);
      sweep.dir.set(-Math.sin(yaw) * Math.cos(tilt), Math.sin(tilt), Math.cos(yaw) * Math.cos(tilt));
      sweep.grip.set(-0.7 * Math.sin(yaw), 4.3, 2.5);
      // The weapon lies along that line with its edge (an axe's blade, a hammer's face) turned level to the way
      // the line sweeps, and kept so all the way round: never rolled over, as the shortest turn from upright
      // would roll it, to face up at the back of the swing and down at the end of it.
      sweep.lead.crossVectors(scratch.up, sweep.dir).normalize();
      if (cuts === "z") sweep.m.makeBasis(sweep.side.crossVectors(sweep.dir, sweep.lead), sweep.dir, sweep.lead);
      else sweep.m.makeBasis(sweep.lead, sweep.dir, sweep.side.crossVectors(sweep.lead, sweep.dir));
      sweep.want.setFromRotationMatrix(sweep.m);
      carry();
      // The other hand, if it carries nothing across the front, takes the haft below the first.
      if (levels.length > 0) return;
      sweep.grip.addScaledVector(sweep.dir, -1);
      reach(armL.joint, foreL.joint, -elbow, elbow - fist, sweep.grip, sweep.poleL, w);
      return;
    }
    const to = (from: number, goal: number) => from + (goal - from) * w;
    const lean = along(k.lean, t);
    const twist = along(k.twist, t);
    bow(lean, twist);
    stride(along(k.step, t));
    top.position.y += along(k.rise, t);
    head.joint.rotation.x -= lean * 0.5;
    head.joint.rotation.y -= twist * 0.6;
    knees(along(k.crouch, t));
    armR.joint.rotation.x = to(armR.joint.rotation.x, along(k.arm, t));
    armR.joint.rotation.z = to(armR.joint.rotation.z, -along(k.out, t));
    foreR.joint.rotation.x = to(foreR.joint.rotation.x, along(k.bend, t));
    // What the hand holds points as the keys say, whatever the arm is doing to carry it there.
    heldR.joint.rotation.x = to(heldR.joint.rotation.x, along(k.blade, t) - (armR.joint.rotation.x + foreR.joint.rotation.x));
    if (act.kind === "twin") {
      // The left hand and its blade do as the right, on their own side.
      armL.joint.rotation.x = to(armL.joint.rotation.x, along(k.arm, t));
      armL.joint.rotation.z = to(armL.joint.rotation.z, along(k.out, t));
      foreL.joint.rotation.x = to(foreL.joint.rotation.x, along(k.bend, t));
      heldL.joint.rotation.x = to(heldL.joint.rotation.x, along(k.blade, t) - (armL.joint.rotation.x + foreL.joint.rotation.x));
      // Tossed: the blades leave the hands, straight up however the arms are turned, spinning a whole turn as
      // they go over, and come back down into them. The eyes go up after them.
      const air = along(TWIN.toss, t) * w;
      const spin = (along(TWIN.spin, t) % (Math.PI * 2)) * w;
      for (const [held, arm, fore] of [[heldR, armR, foreR], [heldL, armL, foreL]]) {
        held.joint.rotation.x += spin;
        level.arm.copy(arm.joint.quaternion).multiply(fore.joint.quaternion).invert();
        held.joint.position.add(sweep.dir.set(0, air, 0).applyQuaternion(level.arm));
      }
      head.joint.rotation.x -= 0.3 * Math.min(1, air / 3);
      return;
    }
    // The other arm, if it carries nothing across the front, is thrown back and through for balance.
    if (levels.length === 0) armL.joint.rotation.x += along(k.off, t);
  };
  const animate = (a: Anim) => {
    pose(a);
    // A long gun is back at the port unless it is being fired (see blow).
    if (gun?.long) gun.frame.rotation.set(GUN_PORT.pitch, GUN_PORT.yaw, 0);
    if (sidearm) sidearm.visible = !!a.act && DRAWN.has(a.act.kind) && !a.lying && a.sitting === 0 && a.oars < 0;
    if (music) {
      // Back where it is carried (a bell stays in the hand, which the pose has already set), and silent, unless
      // a song is being played (see blow).
      if (music.kind !== "bell") {
        music.joint.position.copy(music.home.pos);
        music.joint.quaternion.copy(music.home.quat);
        music.joint.scale.y = 1;
      }
      if (a.act?.kind !== "play" || a.lying || a.sitting !== 0) music.notes.hide();
    }
    if (a.act && !a.lying && a.sitting === 0) blow(a.act, a.scale);
    if (strung) {
      // A shot asked for begins now, and plays out on its own clock.
      if (shot.asked) [shot.at, shot.asked] = [a.t, false];
      const since = a.t - shot.at;
      if (since >= 0 && since < SHOT.over && !a.lying && a.sitting === 0) {
        shoot(strung, since);
        return shine(a);
      }
      strung.bow.joint.rotation.set(0, 0, BOW_CANT);
      strung.bow.joint.position.z = BOW_OUT;
      stringTo(strung, 0, true);
    }
    settle();
    steady(a);
    shine(a);
    fume(a);
    trails(a);
  };
  /**
   * A long gun is a two-handed thing: the other hand has it by the barrel, wherever the gun and the body have
   * got to this frame (carried, aimed, kicking, on the march). Not a shield arm, which has its own work, nor at
   * the oars.
   */
  const steady = (a: Anim) => {
    if (!gun?.long || levels.length > 0 || a.lying || a.oars >= 0) return;
    reach(armL.joint, foreL.joint, -elbow, elbow - fist, placeOf(gun.frame, gun.fore, sweep.grip), sweep.poleL, 1);
  };
  /** A shot's flash and smoke, from where the muzzle is and the way it points, in the figure's own frame (see makeSmoke). */
  const fume = (a: Anim) => {
    if (!gun?.smoke) return;
    const since = a.act?.kind === "fire" ? a.act.t - (gun.long ? FIRE.long : FIRE.hand).shot : -1;
    if (since < 0 || a.lying || !top.parent) return gun.smoke.hide();
    placeOf(gun.frame, gun.muzzle, gun.at, top.parent);
    placeOf(gun.frame, gun.ahead, gun.way, top.parent).sub(gun.at).normalize();
    gun.smoke.show(since, gun.at, gun.way);
  };
  /** The motes off what the hand holds, risen from where it is this frame (worked out through the arm, in the torso's frame). */
  const shine = (a: Anim) => {
    if (!glow) return;
    if (a.lying || !heldR.joint.visible) return glow.motes.hide();
    glow.motes.show(a.t, a.act?.kind === "cast" ? a.act.t : -1, placeOf(glow.frame, glow.at, glow.from));
  };
  /** From the shoulder to the knuckles, and from the hip to a knee on the ground. */
  const armLength = -fist + 0.7;
  const kneeling = shank + 0.35;
  /**
   * A stage of getting up (see GetUp), its hips GET_UP_HIPS along the ground. Face down: the hands set flat under
   * the shoulders and the head lifted. On hands and knees: the thighs and arms straight down, the shins along the
   * ground behind. On one knee: the body upright, the right foot planted before it, a hand on that knee.
   */
  const gettingUp = (stage: GetUp) => {
    const grown = top.scale.y;
    if (stage === "front") {
      top.rotation.set(HALF_PI, 0, 0);
      top.position.set(0, 2.2 * grown, (GET_UP_HIPS - hipY) * grown);
      thighL.joint.rotation.set(0, 0, 0.08);
      thighR.joint.rotation.set(0, 0, -0.08);
      shinL.joint.rotation.x = shinR.joint.rotation.x = 0;
      footL.joint.rotation.x = footR.joint.rotation.x = 0.9;
      armL.joint.rotation.set(0.25, 0, 0.55);
      armR.joint.rotation.set(0.25, 0, -0.55);
      foreL.joint.rotation.x = foreR.joint.rotation.x = -1.5;
      head.joint.rotation.x = -0.6;
      return;
    }
    if (stage === "crawl") {
      // Tipped up from flat so both the hands and the knees reach the ground.
      const tilt = Math.acos(Math.max(0.15, Math.min(0.95, (armLength - kneeling) / 5.5)));
      top.rotation.set(tilt, 0, 0);
      top.position.set(0, (kneeling - hipY * Math.cos(tilt)) * grown, (GET_UP_HIPS - hipY * Math.sin(tilt)) * grown);
      thighL.joint.rotation.set(-tilt, 0, 0.1);
      thighR.joint.rotation.set(-tilt, 0, -0.1);
      shinL.joint.rotation.x = shinR.joint.rotation.x = HALF_PI;
      footL.joint.rotation.x = footR.joint.rotation.x = 0.4;
      armL.joint.rotation.set(-tilt, 0, 0.08);
      armR.joint.rotation.set(-tilt, 0, -0.08);
      foreL.joint.rotation.x = foreR.joint.rotation.x = -0.1;
      head.joint.rotation.x = -(HALF_PI - tilt) * 0.5 - 0.3;
      return;
    }
    // On one knee.
    const forward = 0.15;
    top.rotation.set(forward, 0, 0);
    top.position.set(0, (kneeling - hipY) * grown, GET_UP_HIPS * grown);
    thighL.joint.rotation.set(-forward, 0, 0.08);
    shinL.joint.rotation.x = HALF_PI;
    footL.joint.rotation.x = 0.4;
    thighR.joint.rotation.set(-HALF_PI + 0.1 - forward, 0, -0.12);
    shinR.joint.rotation.x = HALF_PI - 0.1;
    footR.joint.rotation.x = -(forward + thighR.joint.rotation.x + shinR.joint.rotation.x);
    armR.joint.rotation.set(-0.55, 0, -0.2);
    foreR.joint.rotation.x = -0.7;
    armL.joint.rotation.set(-0.15, 0, 0.18);
    foreL.joint.rotation.x = -0.35;
    head.joint.rotation.x = -0.1;
  };
  const pose = (a: Anim) => {
    // The waist and the ankles are straight unless a blow bends them (see blow).
    torso.joint.rotation.set(0, 0, 0);
    footL.joint.rotation.x = footR.joint.rotation.x = 0;
    // Set whole every frame: a blow or a shot adds to these, or turns them outright, and must leave nothing behind.
    head.joint.rotation.set(0, 0, 0);
    heldR.joint.position.set(0, fist - elbow, 0);
    heldL.joint.position.set(0, fist - elbow, 0);
    heldR.joint.rotation.set(-(rest.armR + rest.bendR) + rest.tiltR, 0, lean);
    heldL.joint.rotation.set(-(rest.armL + rest.bendL) + rest.tiltL, 0, -lean);
    foreR.joint.rotation.y = rest.twistR;
    foreR.joint.rotation.x = rest.bendR;
    foreL.joint.rotation.x = rest.bendL;
    foreL.joint.rotation.y = rest.twistL;
    if (a.getUp) return gettingUp(a.getUp);

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
        // Straight-armed at the oars: the stroke was laid out for arms that reach.
        foreL.joint.rotation.x = foreR.joint.rotation.x = 0;
        top.rotation.x = 0.12 - pull * 0.2;
        head.joint.rotation.x = -top.rotation.x * 0.7 + a.breath * 0.02;
        return;
      }
      // An arm already carried forward (a shield, an instrument) stays as it is; a free one comes up, bent at the elbow.
      const carried = rest.armL + rest.bendL < -0.5;
      const reach = rest.armL + ((carried ? rest.armL : -0.45) - rest.armL) * k;
      const crook = rest.bendL + ((carried ? rest.bendL : -0.95) - rest.bendL) * k;
      heldL.joint.rotation.x = -(reach + crook) + rest.tiltL;
      foreL.joint.rotation.x = crook;
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
    // An arm carrying a shield or a bow is held where it is on the march; a free one swings.
    const free = levels.length > 0 ? 0.25 : 1;
    armL.joint.rotation.set(rest.armL - a.swing * 0.6 * free, 0, 0.1 + a.breath * 0.015);
    // The elbow of the arm swinging forward bends a little more.
    foreL.joint.rotation.x = rest.bendL - Math.max(0, a.swing) * 0.35 * free;
    // The weapon arm swings less on the march, and comes up and over in an attack, straightening as it comes down.
    armR.joint.rotation.set(rest.armR + a.swing * 0.3 - a.strike * 1.7, 0, -0.1 - a.breath * 0.015);
    foreR.joint.rotation.x = rest.bendR * (1 - 0.55 * a.strike) - Math.max(0, -a.swing) * 0.15;
    head.joint.rotation.x = a.breath * 0.02 - a.strike * 0.15;
  };
  return { torso, head, armR, armL, foreR, foreL, legR, legL, thighR, thighL, shinR, shinL, footR, footL, heldR, heldL, rest, carried: levelsR, shield, across, aloft, string, loose, instrument, plays: () => !!music, emits, before, reads, pair, focuses, sidearms, cutsAlong, twin: () => paired, armed, fires: () => !!gun, longGun: () => !!gun?.long, animate };
}

type Biped = ReturnType<typeof biped>;

/** Where the elbow is, below the shoulder. */
const ELBOW = -2.3;
/** How far an elbow is bent with nothing in the hand: a little, as an arm hangs. */
const FREE_BEND = -0.25;
/** How far it is bent to carry a weapon: the forearm well forward, the fist closed round the haft. */
const HELD_BEND = -1.35;
/** And how far back the upper arm is drawn for it, so the hand stays low at the side, clear of the face. */
const HELD_BACK = 0.3;
/** And a shield: the upper arm a little forward, the elbow well bent, and the forearm turned in across the front of the body. */
const SHIELD_ARM = { arm: -0.2, bend: -1.2, twist: -0.85 };
/** How far the right forearm turns in to carry an open book before the chest. */
const BEFORE_TWIST = 0.8;
/** And a bow, carried across the body: the fist before the belly. */
const ACROSS_ARM = { arm: -0.05, bend: -1.2, twist: -0.75 };
/** A torch held up: the upper arm forward, the forearm raised, the fist out before the shoulder. */
const TORCH_ARM = { arm: -0.55, bend: -1.35, twist: -0.2 };
/** How far a bow carried across the body leans, its upper limb toward the left shoulder, and how far before the fist it is carried. */
const BOW_CANT = -0.6;
const BOW_OUT = 0.55;
/** A shot: how far the archer turns side-on to it, how far the string is drawn, and (in seconds) when it is loosed and when the shot is over. */
const SHOT = { turn: 0.9, pull: 1.9, loose: 0.24, over: 0.8 };
/** How long an archer takes to draw before the arrow flies, in seconds: what throws the arrow waits for it (see Figure.loose). */
const BOW_DRAW = SHOT.loose;

/** A bow in the hand, strung: its string in two halves from the tips (`tip`, in the bow's frame) to the nock, and the arrow on it. */
interface Strung {
  bow: Part;
  halves: Part[];
  arrow: Part;
  tip: { x: number; y: number };
}

const ik = { t: new THREE.Vector3(), pole: new THREE.Vector3(), upper: new THREE.Vector3(), fore: new THREE.Vector3(), x: new THREE.Vector3(), y: new THREE.Vector3(), z: new THREE.Vector3(), m: new THREE.Matrix4(), q: new THREE.Quaternion() };
/**
 * Bend an arm (upper arm `arm` hung at `shoulder`, forearm `fore` from its elbow `upper` below, the fist `lower`
 * below that) so its fist reaches `target`, `w` of the way from however it is posed: the elbow kept toward
 * `pole`. All in the frame the shoulder is set in (the torso's). A target out of reach is reached toward.
 */
function reach(arm: THREE.Object3D, fore: THREE.Object3D, upper: number, lower: number, target: THREE.Vector3, pole: THREE.Vector3, w: number) {
  if (w <= 0) return;
  ik.t.copy(target).sub(arm.position);
  const far = Math.min(upper + lower - 0.02, Math.max(Math.abs(upper - lower) + 0.05, ik.t.length()));
  ik.t.normalize();
  const open = Math.acos(Math.min(1, Math.max(-1, (upper * upper + far * far - lower * lower) / (2 * upper * far))));
  ik.pole.copy(pole).addScaledVector(ik.t, -pole.dot(ik.t)).normalize();
  ik.upper.copy(ik.t).multiplyScalar(Math.cos(open)).addScaledVector(ik.pole, Math.sin(open));
  ik.fore.copy(ik.t).multiplyScalar(far).addScaledVector(ik.upper, -upper).normalize();
  const bend = Math.acos(Math.min(1, Math.max(-1, ik.upper.dot(ik.fore))));
  // The upper arm hangs along its own -y, and bends toward its own +z.
  ik.y.copy(ik.upper).negate();
  ik.z.copy(ik.fore).addScaledVector(ik.upper, -ik.fore.dot(ik.upper));
  if (ik.z.lengthSq() < 1e-6) ik.z.copy(ik.pole).negate();
  ik.z.normalize();
  ik.x.crossVectors(ik.y, ik.z);
  arm.quaternion.slerp(ik.q.setFromRotationMatrix(ik.m.makeBasis(ik.x, ik.y, ik.z)), w);
  fore.rotation.x += (-bend - fore.rotation.x) * w;
  fore.rotation.y *= 1 - w;
}

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
  const rings = HEAD_RINGS[(chosen ?? face)?.headShape ?? "round"] ?? HEAD_RINGS.round;
  const k = BIG_HEAD * m.head;
  const half = (Math.max(...rings.map((r) => r[1])) + 0.5) * k;
  // From the hand (about half a unit above the hips) up to the widest of the head.
  const rise = 6 + headLift() + 3.2 * k - 0.5;
  const out = Math.max(0, half + 0.8 - shoulderX);
  return 0.06 + Math.atan2(out, rise);
}

/** How far a head of the chosen shape sits above the usual, on its neck, in the torso's units. */
function headLift(): number {
  return (chosen ?? face)?.headShape === "long" ? 0.45 : (chosen ?? face)?.headShape === "squat" ? -0.35 : 0;
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
  const shape = (chosen ?? face)?.headShape ?? "round";
  const rings = HEAD_RINGS[shape] ?? HEAD_RINGS.round;
  head.loft(skin, rings);
  const chinY = rings[0][0];
  const mouthY = MOUTH_Y[shape] ?? 1.45;
  const earX = ringAt(rings, 3).rx * 0.97;
  lowEars(head, tone(skin, -0.05), (chosen ?? face)?.ears ?? "round", earX, covered);
  lowNose(head, tone(skin, -0.05), chosen?.nose ?? look.nose ?? face?.nose ?? "pointy", faceAt(rings, 2.3));
  head.box(tone(skin, -0.25), 1, 0.24, 0.3, 0, mouthY, faceAt(rings, mouthY) + 0.03);
  lowEyes(head, look.hair, chosen?.eyes ?? look.eyes ?? face?.eyes ?? "round", asleep, rings);
  if (look.glowEyes && !asleep) {
    // Alight over the eyes the face has: a glow in each. For a look whose eyes light only with a spell, each is a
    // part of its own, swelled and shrunk as the spell is cast (see castEyes).
    for (const s of [-1, 1]) {
      const x = s * 1.15;
      const z = faceZ(rings, x, 3.05) + 0.12;
      if (look.glowOnCast) {
        const eye = new Part(head.joint, x, 3.05, z);
        eye.glowBall(look.glowEyes, 0.36);
        extraParts.push(eye);
        castEyes.push(eye.joint);
      } else head.glowBall(look.glowEyes, 0.36, x, 3.05, z);
    }
  }
  if (look.mask) {
    // A scarf pulled up over the mouth and the nose, a little loose, gathered under the chin.
    const r = (y: number, by: number): Ring => {
      const at = ringAt(rings, y);
      return [y, at.rx + by, at.rz + by, at.dz + by * 0.6];
    };
    head.loft(look.mask, [r(chinY + 0.15, 0.1), r(1.2, 0.13), r(2, 0.24), r(2.5, 0.14)], 10);
    head.loft(tone(look.mask, -0.12), [r(2.4, 0.16), r(2.56, 0.16)], 10);
  }
  lowHair(head, look.hair, (chosen ?? face)?.hairStyle ?? "short", rings, covered);
  if (look.bandana) {
    // A cloth band round the brow, knotted behind with two short tails.
    head.loft(look.bandana, fitted([[3.85, 3.86, 3.56], [4.5, 3.89, 3.59]]), 10);
    const d = headDelta(4.2);
    const back = d.dz - d.rz;
    head.ball(tone(look.bandana, -0.1), 0.45, 0, 4.15, -3.6 + back, 0);
    for (const s of [-1, 1]) head.shape(look.bandana, [[s * 0.1, 4.2, -3.6 + back], [s * 0.45, 4.2, -3.7 + back], [s * 1.1, 2.7, -3.85 + back], [s * 1.5, 2.85, -3.85 + back]]);
  }
  if (look.loupe) {
    // A jeweller's loupe: a leather band round the brow, and hung from it over one eye a short brass tube, wider at
    // the eye than at its end, with a glass in it.
    const band = "#4a3426";
    head.loft(band, fitted([[3.95, 3.86, 3.56], [4.4, 3.89, 3.59]]), 10);
    const x = 1.15;
    const z = faceZ(rings, x, 3.05);
    head.box(band, 0.3, 1.1, 0.25, x, 3.65, z + 0.12);
    head.cyl(look.loupe, 0.5, 0.62, 1.1, x, 3.05, z + 0.55, 8, [HALF_PI, 0, 0]);
    head.cyl(tone(look.loupe, -0.14), 0.66, 0.66, 0.2, x, 3.05, z + 0.12, 8, [HALF_PI, 0, 0]);
    head.cyl("#cfeaff", 0.4, 0.4, 0.08, x, 3.05, z + 1.1, 8, [HALF_PI, 0, 0]);
  }
  if (chosen?.ink) inkPart(head, "head", chosen.ink);
  if (chosen) lowFacialHair(head, chosen.beard, chosen.mustache, skin, look.hair, rings, chinY, mouthY);
  // A stock figure's own (the galley's cook): no beard, just what its look names.
  else if (face || look.mustache) lowFacialHair(head, face?.beard ?? "none", look.mustache ?? face?.mustache ?? "none", skin, look.hair, rings, chinY, mouthY);
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
function hang(root: Part, end: Part, side: number, drape: Drape = 0, leg?: THREE.Object3D, fence?: Fence) {
  extraParts.push(root, end);
  braids.push({ root, end, side, drape, leg, fence, x: 0, vx: 0, z: 0, vz: 0, ex: 0, evx: 0, ez: 0, evz: 0, last: -1 });
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

/**
 * What a sash's end may not swing into: where its two pieces hang from (in the torso's frame), how long each is,
 * and the body's section at a height `y` as an ellipse about the torso's axis (half-widths across and front to
 * back, and how far forward its middle is).
 */
interface Fence {
  at: Pt;
  lengths: [number, number];
  section(y: number): [rx: number, rz: number, dz: number];
}

/** The direction a piece hangs when it is turned `x` about the across axis and `z` about the front-to-back one. */
function hangDir(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(Math.sin(z), -Math.cos(z) * Math.cos(x), -Math.cos(z) * Math.sin(x));
}
const _hang = new THREE.Vector3();
/** How far inside a section a point is: over 0 when it is within it (1 at its middle), 0 or under outside. */
function sunk(fence: Fence, x: number, y: number, z: number): number {
  const [rx, rz, dz] = fence.section(y);
  return 1 - Math.hypot(x / rx, (z - dz) / rz);
}

/** Where hair hangs against the body: 0 free (a ponytail), 1 down the chest, -1 down the back. */
type Drape = 0 | 1 | -1;

/** A braid's (or a ponytail's) two joints, and the springs that swing them: the root's angles and speeds, then the end's. */
interface Braid {
  root: Part;
  end: Part;
  side: number;
  drape: Drape;
  /** The thigh it hangs beside, on the outside of it (a sash's end): pushed ahead and out by it, never through it. */
  leg?: THREE.Object3D;
  /** The body (a coat's skirts, the hips and thighs) it hangs against, which it may not swing into. */
  fence?: Fence;
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
 * How many times longer than CAST a spell takes the figure being built (set by makeFigure, and by a rig carrying
 * an open book): the hand waved over the pages is slow and deliberate, so a book's cast is played slower, the
 * spell leaving as much later.
 */
let castPace = 1;
const BOOK_CAST_PACE = 2;
/** A townsperson's face and hair, picked for them from a name (see faceFor): what a hero chooses for themselves. */
type Face = Pick<Appearance, "headShape" | "ears" | "hairStyle" | "eyes" | "nose" | "mustache" | "beard"> & { skin?: string; hair?: string };
/** Set by makeFigure for the figure being built: a townsperson's own face, or null (a hero has `chosen`; others neither). */
let face: Face | null = null;
/** The kinds that are townsfolk, each given a face of their own (see faceFor). */
const TOWNSFOLK = /^(npc|dealer|regular_|salesman_|keeper_)/;
/** Skin tones and hair colours a townsperson may have: the everyday ones, not the painted. */
const TOWN_SKIN = SKIN_TONES.slice(0, 8);
const TOWN_HAIR = HAIR_COLORS.slice(0, 9);

/**
 * A face for a townsperson, the same every time for the same `key` (their id, or their kind for one who is always
 * the same person): head shape, ears, hair, eyes and nose. With `colours` (a generic villager), their skin and
 * hair colour too, and a mustache or beard on some; a named one keeps the colouring and facial hair their look gives.
 */
function faceFor(key: string, colours: boolean): Face {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  const next = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
  const pick = <T extends { id: string }>(list: readonly T[]): T["id"] => list[Math.floor(next() * list.length)].id;
  const o = APPEARANCE_OPTIONS;
  const f: Face = {
    headShape: pick(o.headShape),
    ears: pick(o.ears),
    hairStyle: pick(o.hairStyle),
    eyes: pick(o.eyes),
    nose: pick(o.nose),
    // A villager may have a mustache, a beard or both; a named townsperson has only what their look gives them.
    mustache: !colours || next() < 0.6 ? "none" : pick(o.mustache),
    beard: !colours || next() < 0.65 ? "none" : pick(o.beard),
  };
  if (colours) {
    f.skin = TOWN_SKIN[Math.floor(next() * TOWN_SKIN.length)];
    f.hair = TOWN_HAIR[Math.floor(next() * TOWN_HAIR.length)];
  }
  return f;
}

/** How high above the hips a long coat's skirts are hinged, in the torso's units: at the hip joints, so each turns with its leg. */
const SKIRT_PIVOT = 0.15;
/** How much of its leg's swing a long coat's skirt follows: all of it, or the leg strides out through the cloth. */
const SKIRT_FOLLOW = 1;
/** How far a long coat's skirts stand off the legs, so a bent knee stays inside the cloth. */
const SKIRT_EASE = 0.18;
/** Set by makeFigure for the figure being built: its kind (a hero's class), for the rules that go by it. */
let figureKind = "";
/** Set by makeFigure for the figure being built: a long coat's two skirts, each folded at the knee, and the leg each swings with. */
let skirts: { joint: THREE.Object3D; thigh: THREE.Object3D; fold: THREE.Object3D; shin: THREE.Object3D }[] = [];
/** How much of the knee's bend the lower piece of a long coat's skirt follows: cloth bends less than a leg. */
const FOLD_FOLLOW = 0.6;
/** How far down a long coat's hem hangs, in the torso's units, for legs of the usual length: a little below the knee. Longer or shorter legs move it with the knee (see coatHem). */
const COAT_HEM = -3.7;
/** The hem of a long coat on the figure being built: as far below its knee as the legs are long, so it always folds at the knee. */
const coatHem = () => COAT_HEM * m.legs;
/** How far a long coat's upper and lower skirt pieces overlap above and below the knee, so a bend opens no gap. */
const FOLD_OVERLAP = 0.7;
/** Set by makeFigure for the figure being built: eyes that light only while a spell is cast (see Look.glowOnCast). */
let castEyes: THREE.Object3D[] = [];
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
    if (b.leg) {
      // The thigh swings under it: forward (its angle falling) it shoves the end ahead of it and out to the
      // side; back, it falls away and the end swings free. Neither piece may swing in toward the leg.
      const front = b.leg.rotation.x + 0.12;
      const out = 0.05 + 0.35 * Math.max(0, -b.leg.rotation.x);
      if (b.x > front) [b.x, b.vx] = [front, Math.min(0, b.vx)];
      if (b.x + b.ex > front + 0.08) [b.ex, b.evx] = [front + 0.08 - b.x, Math.min(0, b.evx)];
      if (b.z < out) [b.z, b.vz] = [out, Math.max(0, b.vz)];
      if (b.z + b.ez < out) [b.ez, b.evz] = [out - b.z, Math.max(0, b.evz)];
    }
    if (b.fence) {
      // A sash's end is stopped by the coat or the legs it hangs over: whichever of its two pieces is inside the
      // body is swung out (and then the lower one, if it is still), a step at a time, its speed lost where it
      // is stopped, so it rides over the cloth instead of sinking into it.
      const f = b.fence;
      const [x0, y0, z0] = f.at;
      for (let i = 0; i < 24; i++) {
        const d1 = hangDir(b.x, b.z, _hang);
        const [x1, y1, z1] = [x0 + f.lengths[0] * d1.x, y0 + f.lengths[0] * d1.y, z0 + f.lengths[0] * d1.z];
        const d2 = hangDir(b.x + b.ex, b.z + b.ez, _hang);
        const [x2, y2, z2] = [x1 + f.lengths[1] * d2.x, y1 + f.lengths[1] * d2.y, z1 + f.lengths[1] * d2.z];
        const upper = Math.min(sunk(f, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), sunk(f, x1, y1, z1));
        const lower = Math.min(sunk(f, (x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2), sunk(f, x2, y2, z2));
        // (Never out past a third of a turn, whatever is in the way.)
        if (upper > -0.02 && b.z < 0.6) {
          b.z += 0.05;
          b.vz = Math.max(0, b.vz);
        } else if (lower > -0.02 && b.ez < 0.6) {
          b.ez += 0.05;
          b.evz = Math.max(0, b.evz);
        } else break;
      }
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
    case "bulbous": {
      // A great round nose, ruddier than the face it is on, a wing to each side and a bridge up between the eyes.
      const ruddy = "#" + new THREE.Color(c).lerp(new THREE.Color("#b8493f"), 0.38).getHexString();
      head.shape(c, sym([[0.5, 2.3, z - 0.2], [0, 3.2, z - 0.05], [0, 2.4, z + 0.6]]));
      head.ball(ruddy, 0.92, 0, 2.3, z + 0.5, 1, [1.05, 0.95, 1]);
      for (const s of [-1, 1]) head.ball(ruddy, 0.5, s * 0.78, 2.02, z + 0.22, 0, [1, 0.85, 0.9]);
      return;
    }
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
const headRings = (): readonly Ring[] => HEAD_RINGS[(chosen ?? face)?.headShape ?? "round"] ?? HEAD_RINGS.round;

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
 * the ears and crown and tapering to a soft point down the back; dark inside round the face. `trim` bands the
 * opening (a worn hood). Its mantle over the shoulders is drawn on the body (see lowMantle).
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
  // Drawn up to a peak over the brow: the opening itself rises to a point, a pointed arch round the face, and
  // the point carries back over the crown, easing off toward the back of the head.
  const apex = [0.9, 0.72, 0.38, 0.12, 0, 0, 0];
  head.shell(c, shell, 12, { open: "start", apex }, 0, mid, 0, side);
  // The lining round the face, in shadow.
  const lining: Ring[] = shell.slice(0, 3).map(([y, rx, rz, dz = 0]) => [y + 0.05, rx - 0.14, rz - 0.14, dz]);
  head.shell(tone(c, -0.32), lining, 12, { open: "both", inward: true, apex }, 0, mid, 0, side);
  // Its rim round the face, following the arch: a band of the trim (a worn hood's, or a look's own hood trim), or
  // else a thin line of outline ink, so the edge of the opening is drawn as every other edge is.
  // It is a slanted frame, narrower at its front edge than behind, so it faces the viewer and reads as a rim.
  const rim = (c: string, by: number) =>
    head.shell(c, [[-3.42, 2.66 + wide, half - 0.2, 0], [-3.2, 2.95 + wide + by, half + 0.1 + by, 0]], 12, { open: "both", apex: [0.95, 0.88] }, 0, mid, 0, side);
  rim(trim ?? OUTLINE, trim ? 0.12 : 0);
}

/**
 * A hood's mantle, low-poly, on the body (so it sits on the shoulders however the head turns): up the neck
 * under the hood, out over the tops of the arms, and down the chest and back, to a point behind and parted in
 * front from the hem up to a bow tied below the throat. It stands `over` past whatever is worn on the chest (see
 * amuletOver). `tie` is the bow's colour; `trim` bands the hem (a worn hood).
 */
function lowMantle(torso: Part, c: string, over: number, tie: string, trim?: string) {
  // In the torso's own units (its girth is its part's scale): where the arms hang, and how far a sleeve reaches
  // out from there at its widest and at its top.
  const arm = (4.05 * m.shoulders + 0.45) / m.girth;
  const [widest, top] = [1.32 / m.girth, 0.75 / m.girth];
  const t = over + 0.18;
  const hem = (a: number) => (Math.cos(a) > 0 ? 1.9 : 2.2) * Math.abs(Math.cos(a)) ** 2.2;
  // The opening: wide at the hem, closing to the bow.
  const rings: HemRing[] = [
    [4.85, arm + widest + t + 0.3, 2.4 + t, 0.1, 1, 0.95],
    [5.75, arm + widest + t + 0.08, 2.3 + t, 0.08, 0.12, 0.06],
    [6.45, arm + top + t + 0.1, 2.1 + t, 0.02, 0],
    [6.8, 2.6 + t, 1.95 + t, 0, 0],
    [7.1, 2, 1.75, 0, 0],
  ];
  torso.hanging(c, rings, 16, hem);
  if (trim) {
    const [y, rx, rz, dz, , open = 0] = rings[0];
    torso.hanging(trim, [[y - 0.03, rx + 0.07, rz + 0.07, dz, 1, open], [y + 0.3, rx + 0.07, rz + 0.07, dz, 1, open - 0.08]], 16, hem);
  }
  // The bow, where the opening closes: a knot, two loops out to the sides and two ends hanging down the opening.
  const [y1, , rz1, dz1, fall1] = rings[1];
  const knot: Pt = [0, y1 - fall1 * hem(0) + 0.05, rz1 + dz1 + 0.25];
  torso.ball(tie, 0.3, ...knot, 0, [1.1, 0.9, 0.8]);
  for (const s of [-1, 1]) {
    torso.ball(tie, 0.36, knot[0] + s * 0.5, knot[1] + 0.08, knot[2] - 0.05, 0, [1.3, 0.65, 0.5]);
    strut(torso, tie, knot, [knot[0] + s * 0.32, knot[1] - 1.05, knot[2] + 0.12], 0.12, 0.09);
  }
}

/**
 * The Lighthouse Paladin's Lantern Helm, low-poly: a steel dome banded in brass, cheek guards, and on top a little
 * lantern burning, its brass posts round the light and a peaked cap over it in `cap`. Worn, it lights the dark
 * (wearsLanternHelm).
 */
function lowLanternHelm(head: Part, cap: string) {
  const c = "#aeb6c2";
  const dome = fitted(OVER_HAIR);
  const band = fitted([[3.85, 3.84, 3.54], [4.45, 3.82, 3.52, -0.02]]);
  head.loft(c, dome, 10);
  // The brow band a twist of brass rope: a rounded roll, its strands slanting round the head.
  const roll = fitted([[3.8, 3.84, 3.54], [3.98, 4.04, 3.74], [4.15, 4.12, 3.82, -0.01], [4.32, 4.04, 3.74, -0.02], [4.5, 3.82, 3.52, -0.02]]);
  head.loft(GEAR.gold, roll, 14);
  const b = ringAt(roll, 4.15);
  const strands = 30;
  for (let i = 0; i < strands; i++) {
    const t = (i / strands) * Math.PI * 2;
    head.box(tone(GEAR.gold, -0.22), 0.09, 0.66, 0.08, Math.sin(t) * (b.rx + 0.02), 4.15, Math.cos(t) * (b.rz + 0.02) + b.dz, [0, t, 0.7]);
  }
  // A brass comb from the brow up over the crown and down the back, under the lantern: a hull of its edge, the
  // inside lost in the dome.
  const comb: Pt[] = [];
  for (const [y, out] of [[4.6, 0.2], [5.6, 0.42], [6.7, 0.55], [7.4, 0.6]] as const) {
    const r = ringAt(dome, y);
    comb.push([0.24, y, r.dz + r.rz + out], [0.24, y, r.dz - r.rz - out]);
  }
  const top = ringAt(dome, 7.75);
  comb.push([0.24, 8.35, top.dz + 0.9], [0.24, 8.35, top.dz - 0.9]);
  head.shape(GEAR.gold, sym(comb));
  // A short peak over the brow, angled a little down, following the curve of the band.
  const f = ringAt(band, 3.85);
  const peak: Pt[] = [];
  // Short: the camera looks down on heroes, and a longer one hides their eyes.
  for (const [x, out] of [[0, 0.8], [1.6, 0.58], [2.9, 0.2]] as const) {
    const z = f.dz + f.rz * Math.sqrt(Math.max(0, 1 - (x / f.rx) ** 2));
    peak.push([x, 3.9, z - 0.1], [x, 3.7, z - 0.1], [x, 3.84 - out * 0.15, z + out], [x, 3.68 - out * 0.15, z + out]);
  }
  head.shape(c, sym(peak));
  cheekGuards(head, c);
  // Brass rivets on each cheek guard, and the same line of them carried on up each side of the dome over the
  // band, as far apart and in line with them.
  const rivetZ = 0.35;
  const rivetGap = 1.1;
  for (const s of [-1, 1]) {
    for (const y of [2.45, 2.45 + rivetGap]) head.ball(GEAR.gold, 0.19, s * (ringAt(headRings(), y).rx + 0.66), y, rivetZ, 0);
    for (let y = 4.75; y < 7.3; y += rivetGap) {
      const r = ringAt(dome, y);
      const across = r.rx * Math.sqrt(Math.max(0, 1 - ((rivetZ - r.dz) / r.rz) ** 2));
      head.ball(GEAR.gold, 0.19, s * (across + 0.04), y, rivetZ, 0);
    }
  }
  const d = headDelta(7.6);
  const z = d.dz - 0.1;
  head.cyl(GEAR.gold, 1.15, 1.35, 0.5, 0, 7.95, z, 8);
  head.glowBox("#ffd27a", 1.3, 1.5, 1.3, 0, 8.95, z);
  for (const [x, k] of [[-0.75, -0.75], [0.75, -0.75], [-0.75, 0.75], [0.75, 0.75]]) head.box(GEAR.gold, 0.26, 1.7, 0.26, x, 8.95, z + k);
  head.cyl(GEAR.gold, 1.2, 1.2, 0.3, 0, 9.85, z, 8);
  head.cone(cap, 1.2, 1.1, 0, 10.5, z, 8);
  head.ball(GEAR.gold, 0.25, 0, 11.15, z, 0);
}

/** The headgear a class, townsperson or enemy has by default, rounded to go with low-poly heads. */
function lowHat(head: Part, look: Look) {
  const rings = HEAD_RINGS[(chosen ?? face)?.headShape ?? "round"] ?? HEAD_RINGS.round;
  switch (look.hat) {
    case "helm":
      lowHelm(head, "#aeb6c2", tone("#aeb6c2", 0.07), look.accent);
      return;
    case "lamphelm":
      lowLanternHelm(head, look.accent);
      return;
    case "coral": {
      // A band of kelp round the brow, and on it a crown of branching coral, taller at the front, with a little
      // shell at its middle.
      const c = look.hatColor ?? look.accent;
      const kelp = "#3d6b2e";
      head.loft(kelp, fitted([[3.95, 3.84, 3.54], [4.65, 3.88, 3.58, -0.03]]), 10);
      const d = headDelta(4.6);
      for (let i = 0; i < 7; i++) {
        const a = ((i - 3) / 3) * 1.9;
        const tall = 1 - Math.abs(i - 3) * 0.12;
        const base: Pt = [Math.sin(a) * (3.75 + d.rx), 4.55, Math.cos(a) * (3.5 + d.rz) + d.dz];
        const tip: Pt = [base[0] * 1.18, 4.55 + 3.3 * tall, base[2] * 1.18];
        const col = i % 2 ? c : tone(c, 0.1);
        strut(head, col, base, tip, 0.42, 0.22);
        head.ball(tone(col, 0.15), 0.26, ...tip, 0);
        // Two side branches off each, forking up and away to either side, each with a knobbed end.
        for (const [at, side, up] of [[0.35, 1, 1.5], [0.6, -1, 1.2]] as const) {
          const mid: Pt = [base[0] + (tip[0] - base[0]) * at, base[1] + (tip[1] - base[1]) * at, base[2] + (tip[2] - base[2]) * at];
          const end: Pt = [mid[0] + Math.cos(a) * 0.95 * side, mid[1] + up, mid[2] - Math.sin(a) * 0.95 * side];
          strut(head, col, mid, end, 0.22, 0.14);
          head.ball(tone(col, 0.15), 0.18, ...end, 0);
        }
      }
      head.ball("#f0dcc8", 0.45, 0, 4.4, 3.75 + d.rz + d.dz, 0, [1, 0.8, 0.5]);
      return;
    }
    case "wizard": {
      // A wide brim just over the brows, a band, and a tall crown that bends back to its tip. A hat of its own
      // colour (a witch's) is that colour brim and all; otherwise the crown is the robe's and the brim the trim's.
      const c = look.hatColor ?? look.body;
      head.loft(look.hatColor ? tone(c, 0.04) : look.accent, fitted([[4.3, 5.3, 5.05, -0.05], [4.68, 5.3, 5.05, -0.05]]), 14);
      head.loft(c, fitted([[4.5, 3.82, 3.52, -0.05], [6.2, 3.22, 2.97, -0.15], [7.8, 2.25, 2.05, -0.4], [9.3, 1.3, 1.2, -0.85], [10.5, 0.55, 0.55, -1.5], [11.1, 0.1, 0.1, -1.95]]), 10);
      head.loft(tone(c, -0.08), fitted([[4.65, 3.86, 3.56, -0.05], [5.3, 3.72, 3.44, -0.08]]), 10);
      const f = facet(fitted(OVER_HAIR), 10, 5, 0, 0.3);
      head.shape(look.accent, sym([[0, 5.55, f.z], [0.5, 5, f.z], [0, 4.45, f.z], [0, 5, f.z + 0.25]]));
      return;
    }
    case "hood":
      lowHood(head, look.hatColor ?? look.body, rings, look.hoodTrim);
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
    case "tricorn": {
      // A low round crown, and round it a broad brim cocked up into three walls that meet in three points: one
      // over the brow and one behind each ear. Each wall bows out where it passes the crown, rises highest there,
      // and leans out a little; a gold braid runs along its top edge.
      const c = look.hatColor ?? look.body;
      const d = headDelta(4.6);
      const rx = (r: number) => r + d.rx;
      const rz = (r: number) => r + d.rz;
      head.loft(c, fitted([[4.2, 3.86, 3.56], [5.5, 3.78, 3.48, -0.05], [6.5, 3.2, 2.95, -0.1], [7.05, 2, 1.85, -0.1], [7.25, 0.4, 0.4, -0.1]]), 10);
      // Where the walls stand, going round from the front point: a point, the middle of a wall, the next point...
      const foot: { a: number; r: number; y: number; top: number }[] = [];
      for (let i = 0; i < 6; i++) {
        const point = i % 2 === 0;
        foot.push({ a: (i / 6) * Math.PI * 2, r: point ? 6.1 : 4.35, y: point ? 4.75 : 4.35, top: point ? 5.15 : 6.75 });
      }
      const at = (f: (typeof foot)[number], k: number, y: number, out = 1): Pt => [Math.sin(f.a) * rx(f.r) * k * out, y, Math.cos(f.a) * rz(f.r) * k * out + d.dz];
      for (let i = 0; i < 6; i++) {
        const f = foot[i];
        const g = foot[(i + 1) % 6];
        const pts: Pt[] = [];
        for (const k of [1, 0.9]) pts.push(at(f, k, f.y), at(g, k, g.y), at(f, k, f.top, 1.05), at(g, k, g.top, 1.05));
        head.shape(c, pts);
        strut(head, GEAR.gold, at(f, 0.97, f.top + 0.05, 1.05), at(g, 0.97, g.top + 0.05, 1.05), 0.17);
      }
      // A cockade of the sash's red on the left wall.
      const w = foot[1];
      head.ball(look.accent, 0.62, ...at(w, 1.06, 5.7, 1.03), 0, [1, 1, 0.45]);
      head.ball(GEAR.gold, 0.25, ...at(w, 1.13, 5.7, 1.03), 0);
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
      if (look.knotSide) {
        // Knotted on the left side, above the ear, its two tails hanging down past the jaw.
        const d = headDelta(4.4);
        const x = 3.85 + d.rx;
        const z = d.dz - 0.7;
        head.ball(tone(c, -0.08), 0.65, x + 0.1, 4.45, z, 1);
        head.shape(c, [[x + 0.1, 4.4, z - 0.1], [x + 0.35, 4.3, z - 0.45], [x + 0.75, 2.2, z - 0.9], [x + 0.6, 2.0, z - 0.35], [x + 0.45, 2.3, z - 0.6]]);
        head.shape(tone(c, -0.08), [[x + 0.1, 4.4, z + 0.15], [x + 0.35, 4.3, z + 0.45], [x + 0.55, 2.7, z + 0.25], [x + 0.45, 2.85, z + 0.75]]);
        return;
      }
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
    case "diver": {
      const c = look.hatColor ?? "#c2893a";
      lowDiverHelm(head, c, tone(c, -0.2));
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

/**
 * A deep-sea diver's helmet, low-poly: a round bowl over the whole head on a collar round the neck, bolted at
 * its foot, a clear round window in front (an opening, so the face shows through), a smaller one of glass on
 * each side, and a valve on top, in `c` trimmed with `dark`. The Warden's own is brass; the Diving Helm worn as
 * armor is iron trimmed in brass. The bowl is a loft run front to back and laid on its side (as the hood is):
 * its first ring is the window, and each ring's rx is its half-width, rz its half-height and dz how far up its
 * middle is from `mid`.
 */
function lowDiverHelm(head: Part, c: string, dark: string) {
  const d = headDelta(4);
  const w = (r: number) => r + d.rx;
  const mid = 4;
  const portY = 3;
  const side: Rot = [-HALF_PI, 0, 0];
  // Round as a ball, front to back, but for the window cut flat across its front.
  const bowl: Ring[] = [[-3.75, 2.05, 2.05, portY - mid]];
  for (const y of [-3.55, -3.1, -2.6, -1.8, -0.8, 0.3, 1.4, 2.4, 3.2, 3.8, 4.15, 4.3]) {
    const k = Math.sqrt(Math.max(0, 1 - (y / 4.35) ** 2));
    bowl.push([y, Math.max(0.3, w(4.05) * k), Math.max(0.3, 4.15 * k), (portY - mid) * Math.min(1, Math.max(0, (-y - 1.8) / 1.95))]);
  }
  head.shell(c, bowl, 16, { open: "start" }, 0, mid, d.dz, side);
  // Its lining, in shadow, round the window.
  head.shell(tone(c, -0.45), bowl.slice(0, 3).map(([y, rx, rz, dz = 0]) => [y + 0.05, rx - 0.14, rz - 0.14, dz] as Ring), 16, { open: "both", inward: true }, 0, mid, d.dz, side);
  // The window's rim, and a glint on the glass at its edge.
  head.ring(dark, 2.15, 0.34, 0, portY, 3.8 + d.dz);
  head.box("#e8f6f8", 0.2, 0.6, 0.08, -1.3, portY + 1.15, 3.78 + d.dz, [0, 0, 0.6]);
  // The collar round the neck that the bowl sits on, bolted round.
  head.loft(c, fitted([[-0.6, 3.15, 3.15, 0.1], [0.4, 3.45, 3.45, 0.1], [1, 3.2, 3.2, 0.1]]), 12);
  head.loft(dark, fitted([[-0.75, 3.3, 3.3, 0.1], [-0.2, 3.35, 3.35, 0.1]]), 12);
  for (let i = 0; i < 8; i++) {
    const a = ((i + 0.5) / 8) * Math.PI * 2;
    head.ball(tone(c, 0.12), 0.2, Math.sin(a) * 3.42, -0.45, Math.cos(a) * 3.42 + 0.1, 0);
  }
  // A small window of glass on each side.
  for (const s of [-1, 1]) {
    const x = s * (w(4.05) + 0.05);
    const pts: Pt[] = [];
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      for (const k of [-0.25, 0.06]) pts.push([x + s * k, 3.6 + Math.sin(a) * 0.75, Math.cos(a) * 0.75 + d.dz]);
    }
    head.shape("#2c5560", pts);
    head.ring(dark, 0.87, 0.26, x + s * 0.1, 3.6, d.dz, [0, s * HALF_PI, 0]);
  }
  // The air valve on top, and the hose coupling at the back.
  head.cyl(dark, 0.4, 0.55, 0.5, 0, mid + 4.1, d.dz, 8);
  head.cyl(c, 0.6, 0.6, 0.9, 0, 5, -4.05 + d.dz, 8, [HALF_PI, 0, 0]);
  head.cyl(dark, 0.75, 0.75, 0.3, 0, 5, -4.5 + d.dz, 8, [HALF_PI, 0, 0]);
}

/**
 * The Spyglass Visor, low-poly: a lookout's cap. Leather snug over the crown with a seam up the middle, a riveted
 * brass band round the brow and flaps down over the ears; goggles over the eyes on a strap round the back; and a
 * spyglass drawn out over one eye, in three lengths, held on an arm hinged at the temple. The far lens is alight
 * in `trim`.
 */
function lowSpyglassVisor(head: Part, trim: string) {
  const rings = headRings();
  const leather = "#7a4a2a";
  const stitch = "#5a3520";
  const brass = DIVE_BRASS;
  const bright = tone(DIVE_BRASS, 0.18);
  // The cap, snug over the hair, and a raised seam over the top from the brow to the nape.
  const cap = fitted([[3.95, 3.8, 3.5], [5.3, 3.77, 3.47, -0.05], [6.5, 3.14, 2.94, -0.1], [7.25, 1.98, 1.88, -0.1], [7.62, 0.6, 0.6, -0.1]]);
  head.loft(leather, cap, 12);
  const seam: Pt[] = [];
  for (const y of [4.6, 5.6, 6.5, 7.1, 7.5]) {
    const r = ringAt(cap, y);
    seam.unshift([0, y, r.dz + r.rz + 0.04]);
    seam.push([0, y, r.dz - r.rz - 0.04]);
  }
  seam.splice(seam.length / 2, 0, [0, 7.66, -0.1]);
  for (let i = 0; i + 1 < seam.length; i++) strut(head, stitch, seam[i], seam[i + 1], 0.2);
  // The brass band round the brow, studded with rivets.
  const band = fitted([[3.75, 3.98, 3.68], [4.55, 3.96, 3.66, -0.02]]);
  head.loft(brass, band, 12);
  for (let k = -5; k <= 6; k++) {
    if (k === 0) continue;
    const f = facet(band, 12, 4.15, k, 0.04);
    head.ball(bright, 0.14, f.x, 4.15, f.z);
  }
  // Flaps over the ears, a brass stud on each.
  const at = (y: number, out: number) => ringAt(rings, y).rx + out;
  for (const s of [-1, 1]) {
    head.shape(leather, [
      [s * at(4, 0.3), 4, 1.2], [s * at(4, 0.3), 4, -1.5], [s * at(4, 0.78), 4, 1.05], [s * at(4, 0.78), 4, -1.35],
      [s * at(1.5, 0.22), 1.5, 0.65], [s * at(1.5, 0.22), 1.5, -0.85], [s * at(1.5, 0.62), 1.5, 0.5], [s * at(1.5, 0.62), 1.5, -0.7],
    ]);
    head.ball(bright, 0.2, s * at(2.2, 0.68), 2.2, -0.1);
  }
  // The goggles: an eyecup over each eye on a strap round the head, a bridge between them over the nose.
  const eye = (s: number): Pt => [s * 1.15, 3.05, faceZ(rings, s * 1.15, 3.05)];
  const strapR = ringAt(rings, 3.05);
  const strap: Pt[] = [];
  for (let i = 0; i <= 8; i++) {
    const a = 0.95 + (i / 8) * (Math.PI * 2 - 1.9);
    strap.push([Math.sin(a) * (strapR.rx + 0.85), 3.05, strapR.dz + Math.cos(a) * (strapR.rz + 0.45)]);
  }
  for (let i = 0; i + 1 < strap.length; i++) strut(head, stitch, strap[i], strap[i + 1], 0.24);
  for (const s of [-1, 1]) strut(head, stitch, strap[s < 0 ? 0 : strap.length - 1], [eye(s)[0] + s * 0.55, 3.05, eye(s)[2] + 0.25], 0.24);
  for (const s of [-1, 1]) {
    const [x, y, z] = eye(s);
    head.cyl(brass, 0.66, 0.72, 0.5, x, y, z + 0.2, 10, [HALF_PI, 0, 0]);
    head.ring(bright, 0.62, 0.14, x, y, z + 0.47);
  }
  const [rx, ry, rz] = eye(1);
  head.cyl(GEAR.dark, 0.55, 0.55, 0.06, rx, ry, rz + 0.44, 10, [HALF_PI, 0, 0]);
  head.box("#e8f6f8", 0.14, 0.42, 0.06, rx - 0.22, ry + 0.16, rz + 0.48, [0, 0, 0.6]);
  strut(head, brass, [eye(-1)[0] + 0.6, 3.2, eye(-1)[2] + 0.3], [eye(1)[0] - 0.6, 3.2, eye(1)[2] + 0.3], 0.13);
  // The spyglass over the other eye, angled a little out: an eyepiece, a bright drawn length, a leather grip and
  // the brass barrel, rimmed at each joint, and the lens at its end.
  const [ex, ey, ez] = eye(-1);
  const out = -0.14;
  const along = (t: number, up = 0): Pt => [ex + Math.sin(out) * t, ey + up, ez + 0.2 + Math.cos(out) * t];
  strut(head, bright, along(0.2), along(1.3), 0.5, 0.5, 10);
  head.ring(GEAR.dark, 0.54, 0.1, ...along(1.3), [0, out, 0]);
  strut(head, leather, along(1.3), along(2.15), 0.62, 0.62, 10);
  head.ring(brass, 0.65, 0.12, ...along(1.45), [0, out, 0]);
  head.ring(brass, 0.65, 0.12, ...along(2.0), [0, out, 0]);
  strut(head, brass, along(2.15), along(2.95), 0.72, 0.82, 10);
  head.ring(bright, 0.82, 0.16, ...along(2.95), [0, out, 0]);
  head.glowBall(trim, 0.6, ...along(2.7));
  // Its arm, from a knurled wheel on the band at the temple to a clamp round the drawn length.
  const temple: Pt = [-(ringAt(band, 4.1).rx + 0.15), 4.1, 1.4];
  head.cyl(brass, 0.5, 0.5, 0.32, ...temple, 10, [0, 0, HALF_PI]);
  head.ball(bright, 0.2, temple[0] - 0.2, temple[1], temple[2]);
  strut(head, brass, temple, along(0.85, 0.55), 0.14);
  head.ring(brass, 0.54, 0.1, ...along(0.85), [0, out, 0]);
}

/** Armor on the head, rounded: a leather hood, the Spyglass Visor, or a diving helm (anything else). */
function lowWornHelmet(head: Part, helmet: { ref: string; icon: string }, trim: string) {
  const rings = HEAD_RINGS[(chosen ?? face)?.headShape ?? "round"] ?? HEAD_RINGS.round;
  if (helmet.ref === "hood" || helmet.icon === "hood") {
    lowHood(head, GEAR.leather, rings, trim);
    return;
  }
  if (helmet.ref === "visor" || helmet.icon === "brutal-helm") {
    lowSpyglassVisor(head, trim);
    return;
  }
  // The Diving Helm: a diver's helmet in dark iron, trimmed in brass, with a knob of its trim on the valve.
  lowDiverHelm(head, DIVE_IRON, DIVE_BRASS);
  head.ball(trim, 0.32, 0, 8.45, headDelta(4).dz);
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
function coatPanel(part: Part, color: string, s: number, a0: number, a1: number, grow = 0, span?: [top: number, bottom: number]) {
  const steps = 6;
  // The skirts flare over the hips, wider for wide ones, and out over the tops of the thighs.
  const all: [number, number, number, number][] = [
    [1.4, 2.85 * (1 + m.hips) * 0.5 + grow, 2 + grow, 0.05],
    [0.2, Math.max(3.1 * m.hips, thighReach(0.2) + 0.1) + grow, 2.25 + grow, 0],
    [coatHem(), Math.max(3.4 * m.hips, thighReach(0.2) + 0.25) + grow, 2.6 + grow, -0.15],
  ];
  // Only the stretch from `span`'s top to its bottom (a skirt folded at the knee is two): the rings inside it, and
  // one at each end, between the rings either side of it.
  const at = (y: number): [number, number, number, number] => {
    const i = Math.max(0, all.findIndex(([ry], k) => k + 1 < all.length && y <= ry && y >= all[k + 1][0]));
    const [p, q] = [all[i], all[i + 1]];
    const t = (p[0] - y) / (p[0] - q[0]);
    return [y, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t, p[3] + (q[3] - p[3]) * t];
  };
  const rings = span ? [at(span[0]), ...all.filter(([y]) => y < span[0] && y > span[1]), at(span[1])] : all;
  // A thin shell of cloth, hollow inside: built as small curved tiles, one per step round and per band down, each
  // the smallest solid holding its corners on the outer face and the same a cloth's thickness further in. (One
  // solid round the whole arc would fill the inside of the curve, a slab between the legs.)
  const thick = 0.16;
  const on = (a: number, [y, rx, rz, dz]: [number, number, number, number], inset: number): Pt => [s * Math.sin(a) * (rx - inset), y, Math.cos(a) * (rz - inset) + dz];
  for (let i = 0; i < steps; i++) {
    const [p, q] = [a0 + ((a1 - a0) * i) / steps, a0 + ((a1 - a0) * (i + 1)) / steps];
    for (let j = 0; j + 1 < rings.length; j++) {
      const pts: Pt[] = [];
      for (const a of [p, q]) for (const r of [rings[j], rings[j + 1]]) for (const inset of [0, thick]) pts.push(on(a, r, inset));
      part.shape(color, pts);
    }
  }
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

/**
 * Diver's Plate over the chest, low-poly: riveted iron plate over a dark canvas suit, a brass corselet on the
 * shoulders bolted round, a length of chain slung from one shoulder across the chest, and rope wound round the
 * waist and knotted, its end hanging. The trim's colour on the corselet's front plate. Returns how far forward
 * its front is.
 */
function lowDiverPlate(torso: Part, skin: string, sh: number, trim: string): number {
  const rings = lowChest(torso, skin, DIVE_IRON, sh);
  const hip = ringAt(rings, -0.6);
  torso.loft(tone(DIVE_IRON, -0.12), [around(rings, 0.55, 0.1), [-1.5, hip.rx + 0.32, hip.rz + 0.28, hip.dz]], 8);
  // Rivets down the front and across the chest.
  for (const y of [1.9, 2.9, 3.9]) {
    for (const x of [-1.5, 1.5]) {
      const p = onChest(rings, x, y, 0.08);
      torso.ball(tone(DIVE_IRON, 0.2), 0.17, ...p.at, 0);
    }
  }
  // The corselet: brass over the shoulders, up to a collar, bolted round, with a plate of the trim at its front.
  torso.loft(DIVE_BRASS, [around(rings, 3.9, 0.12, 0.02), around(rings, 4.8, 0.28, 0.02), around(rings, 5.7, 0.3, 0), [6.45, 2.1, 1.85, 0], [6.9, 1.75, 1.6, 0]]);
  torso.loft(tone(DIVE_BRASS, -0.22), [around(rings, 3.75, 0.16, 0.02), around(rings, 4.05, 0.16, 0.02)]);
  const at = ringAt(rings, 4.85);
  for (let i = 0; i < 10; i++) {
    const a = ((i + 0.5) / 10) * Math.PI * 2;
    torso.ball(tone(DIVE_BRASS, 0.14), 0.22, Math.sin(a) * (at.rx + 0.38), 4.85, Math.cos(a) * (at.rz + 0.38) + at.dz, 0);
  }
  const plate = onChest(rings, 0, 4.75, 0.42);
  torso.box(trim, 1.2, 0.6, 0.25, ...plate.at);
  // A chain from the right shoulder down across the chest to the left hip: links turned by turns.
  for (let i = 0; i < 9; i++) {
    const t = i / 8;
    const x = -2.3 + 4.4 * t;
    const y = 4.4 - 3.3 * t;
    const p = onChest(rings, x, y, 0.22);
    torso.ring(GEAR.dark, 0.32, 0.1, ...p.at, [0, p.yaw + (i % 2 ? HALF_PI : 0), -0.64]);
  }
  // Rope round the waist, wound twice and knotted at the front, its end hanging.
  torso.loft(ROPE, [around(rings, 0.55, 0.2, 0.02), around(rings, 0.95, 0.22, 0.02)]);
  torso.loft(tone(ROPE, -0.1), [around(rings, 1.05, 0.2, 0.03), around(rings, 1.45, 0.2, 0.03)]);
  const knot = onChest(rings, -0.9, 0.9, 0.3);
  torso.ball(ROPE, 0.45, ...knot.at, 0);
  strut(torso, ROPE, knot.at, [knot.at[0] - 0.25, knot.at[1] - 2.3, knot.at[2] + 0.15], 0.17, 0.15);
  return ringAt(rings, 4.2).rz + ringAt(rings, 4.2).dz + 0.3;
}

/** Armor on the legs, low-poly: loose sailcloth trousers tied at the shin, or iron greaves with steel at the knee and shin. */
function lowLegArmor(thigh: Part, shin: Part, ref: string, trim: string) {
  if (ref === "diving_legs") {
    // Riveted Leggings: dark canvas, a riveted iron knee plate, and a brass band round the top of the shin.
    const canvas = "#4d4a3e";
    thigh.loft(canvas, grown(THIGH, 0.12), 6);
    shin.loft(canvas, grown(SHIN, 0.1), 6);
    shin.ball(DIVE_IRON, 1.05, 0, 0.05, 0.75, 0, [1.2, 1, 0.85]);
    for (const x of [-0.55, 0.55]) shin.ball(tone(DIVE_IRON, 0.2), 0.15, x, 0.05, 1.62, 0);
    shin.loft(DIVE_BRASS, [[-1.05, 1.36, 1.4], [-0.6, 1.38, 1.42]], 6);
    thigh.loft(trim, [[0.05, 1.62, 1.62], [0.45, 1.58, 1.58]], 6);
    return;
  }
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
  if (ref === "lead_boots") {
    // Lead Boots: heavy and dark, a brass cap over the toe, tall shafts with a brass band, a strap in the trim.
    lowShoe(foot, "#3d3f44");
    foot.shape(DIVE_BRASS, sym([[1.32, 0.3, 0.9], [1.0, 0.3, 2.55], [0, 0.3, 2.85], [1.1, 1.1, 0.9], [0.8, 0.85, 2.3], [0, 0.95, 2.55]]));
    foot.shape(tone("#3d3f44", -0.1), sym([[1.45, -0.05, -1.5], [1.5, -0.05, 1.5], [1.05, -0.05, 2.75], [0, -0.05, 3], [1.45, 0.45, -1.5], [1.5, 0.45, 1.5], [1.05, 0.45, 2.75], [0, 0.45, 3]]));
    shin.loft("#3d3f44", [[-2.35, 1.22, 1.26], [-1.2, 1.36, 1.4], [-0.55, 1.4, 1.44]], 6);
    shin.loft(DIVE_BRASS, [[-1, 1.48, 1.52], [-0.55, 1.5, 1.54]], 6);
    shin.loft(trim, [[-1.75, 1.36, 1.4], [-1.5, 1.37, 1.41]], 6);
    return;
  }
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
    else if (look.eyes === "beady") head.box(OUTLINE, 0.7, 0.7, 0.3, s * 1.4, 3, 2.95);
    else {
      head.box(OUTLINE, 1.1, 1.5, 0.3, s * 1.5, 2.9, 2.95);
      head.box("#ffffff", 0.45, 0.5, 0.3, s * 1.5 + 0.3, 3.35, 3.0);
    }
  }
  if (look.nose === "bulbous") head.box("#" + new THREE.Color(skin).lerp(new THREE.Color("#b8493f"), 0.38).getHexString(), 1.6, 1.4, 1, 0, 2.2, 3.2);
  else head.box(tone(skin, -0.07), 0.9, 0.8, 0.5, 0, 2.05, 3.05);
  head.box(tone(skin, -0.22), 1.6, 0.35, 0.3, 0, 1.1, 2.95);
  if (look.mustache) {
    // A bar under the nose, and for the heavier ones its ends hanging past the mouth.
    head.box(look.hair, look.mustache === "pencil" ? 2.2 : 3, look.mustache === "pencil" ? 0.35 : 0.7, 0.4, 0, 1.55, 3.05);
    if (look.mustache !== "pencil") for (const s of [-1, 1]) head.box(look.hair, 0.6, 1, 0.4, s * 1.3, look.mustache === "handlebar" ? 1.85 : 1.1, 3.05);
  }
  if (look.loupe) {
    // A jeweller's loupe over one eye, on a leather band round the brow.
    head.box("#4a3426", 6.9, 0.5, 6.3, 0, 4.25, -0.05);
    head.box(look.loupe, 1.5, 1.5, 1.1, 1.5, 2.95, 3.5);
    head.box("#cfeaff", 0.9, 0.9, 0.2, 1.5, 2.95, 4.1);
  }
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
    const c = look.hatColor ?? look.body;
    head.cyl(look.hatColor ? tone(c, 0.04) : look.accent, 5.3, 5.3, 0.6, 0, 6.2, 0, 10);
    head.cyl(c, 2.1, 3.4, 3, 0, 8, 0, 8);
    head.cone(c, 2.1, 4.2, 0, 11.4, -0.5, 8, [-0.25, 0, 0]);
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
  } else if (hat === "tricorn") {
    const c = look.hatColor ?? look.body;
    head.cyl(c, 3.4, 3.7, 1.6, 0, 6, 0, 8);
    head.cyl(look.accent, 3.8, 3.8, 0.5, 0, 5.4, 0, 8);
    head.box(tone(c, 0.05), 10, 0.5, 10, 0, 5, 0);
    for (const s of [-1, 1]) head.box(c, 0.7, 1.6, 8, s * 5, 5.6, 0, [0, 0, -s * 0.4]);
    head.box(c, 9.5, 2, 0.7, 0, 5.9, -4.8, [-0.25, 0, 0]);
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
  } else if (hat === "lamphelm") {
    head.box("#aeb6c2", 7, 2.8, 6.6, 0, 5.3, 0);
    head.box(GEAR.gold, 7.2, 0.6, 6.8, 0, 4.2, 0);
    head.glowBox("#ffd27a", 1.6, 1.6, 1.6, 0, 7.6, 0);
    head.box(look.accent, 2, 0.8, 2, 0, 8.8, 0);
  } else if (hat === "coral") {
    head.box("#3d6b2e", 7.2, 0.9, 6.8, 0, 4.6, 0);
    for (const x of [-2.4, -0.8, 0.8, 2.4]) head.box(look.hatColor ?? look.accent, 0.6, 2.4, 0.6, x, 6, 3);
  } else if (hat === "diver") {
    const c = look.hatColor ?? "#c2893a";
    head.box(c, 8, 8.4, 7.8, 0, 3.6, 0);
    head.box("#1d3a44", 3.2, 3, 0.4, 0, 3.3, 3.9);
    head.box(tone(c, -0.2), 3.8, 0.45, 0.45, 0, 4.9, 3.95);
    head.box(tone(c, -0.2), 8.3, 0.8, 8.1, 0, -0.4, 0);
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
function drawHeld(id: string, b: Biped, trim: string, look: Look, shield: boolean, icon?: string): Carry {
  // Low-poly, a weapon with an icon is held as that icon's model: what is in the hand is what is in the bag.
  // A lit torch swung as a weapon: held up and forward in the fist, so a strike swings it.
  if (icon === "torch") {
    drawTorch(b.heldR);
    return { arm: -0.45, tilt: 0.15 };
  }
  const fromIcon = lowPoly && icon ? heldGear(icon, b, trim, shield) : null;
  if (fromIcon) return fromIcon;
  const w = b.heldR;
  const shaft = (c: string, h: number, y: number) => w.cyl(c, 0.42, 0.42, h, 0, y, 0, 6);
  const dagger = (p: Part) => {
    p.box(GEAR.wood, 0.7, 1.6, 0.7, 0, 0.1, 0);
    p.box(trim, 0.9, 0.5, 2, 0, 1, 0);
    p.box(GEAR.steel, 0.4, 3.4, 0.9, 0, 2.9, 0);
    p.box(GEAR.shine, 0.4, 0.9, 0.5, 0, 5, 0);
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
      // Edge forward, the guard fore and aft.
      w.box(look.accent, 1, 0.6, 3.2, 0, 1.3, 0);
      w.box(GEAR.steel, 0.45, 7.5, 1.1, 0, 5.3, 0);
      w.box(GEAR.shine, 0.5, 7.5, 0.35, 0, 5.3, 0);
      w.box(GEAR.steel, 0.45, 0.9, 0.7, 0, 9.5, 0);
      return { tilt: 0.55 };
    case "greatsword":
      w.box(GEAR.wood, 0.9, 2.6, 0.9, 0, 0.4, 0);
      w.box(trim, 1.2, 1.2, 1.2, 0, -1.2, 0);
      w.box(GEAR.gold, 1.1, 0.7, 4.6, 0, 1.9, 0);
      w.box(GEAR.steel, 0.5, 11, 1.7, 0, 7.8, 0);
      w.box(GEAR.shine, 0.56, 10.6, 0.5, 0, 7.8, 0);
      w.box(GEAR.steel, 0.5, 1, 1, 0, 13.6, 0);
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
      // An anchor upside down: the shank, a stock across it, and the crown with its arms hanging to the flukes.
      shaft(GEAR.iron, 13, 3);
      w.box(GEAR.wood, 0.6, 0.6, 4.6, 0, 1.4, 0);
      w.box(trim, 0.9, 0.5, 0.9, 0, 0.4, 0);
      w.box(GEAR.iron, 6.4, 0.9, 0.9, 0, 10.6, 0);
      for (const s of [-1, 1]) w.box(GEAR.steel, 2.4, 1.3, 0.7, s * 3.6, 9.8, 0, [0, 0, -s * 0.6]);
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
        carryLeft(b, 0.7);
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
      b.emits(trim, [0, 2, 0.4]);
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
      // The pages give off motes of their own light (see makeMotes).
      b.emits(page, [0, 1.6, 0.6]);
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
        return sling(b, lute, back, LUTE_ARMS, "lute", 6.8, trim);
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
        return sling(b, flute, back, FLUTE_ARMS, "flute", span.length(), trim);
      }
      w.cyl(GEAR.paper, 0.38, 0.38, 8, 0, 2.6, 0, 6);
      for (const y of [1.5, 3, 4.5]) w.box(GEAR.dark, 0.3, 0.4, 0.3, 0, y, 0.3);
      w.cyl(trim, 0.5, 0.5, 0.8, 0, 6.8, 0, 6);
      return { tilt: 0.6 };
    case "accordion":
      if (lowPoly) {
        // Held before the chest by an end board in each hand, the bellows between.
        const right = handAt(-1, ACCORDION_ARMS.right, -0.1);
        const left = handAt(1, ACCORDION_ARMS.left, 0.1);
        const span = left.clone().sub(right);
        const box = new Part(b.torso.joint);
        layAlong(box.joint, right, span);
        drawAccordion(box, trim, span.length());
        // Slung across the back while they walk, lying along the shoulders.
        const back = new Part(b.torso.joint, -4, 2.6, -(1.9 * m.girth + 1.4));
        back.joint.rotation.set(0, Math.PI, HALF_PI - 0.12);
        drawAccordion(back, trim, 8);
        return sling(b, box, back, ACCORDION_ARMS, "accordion", span.length(), trim);
      }
      w.box("#b8333a", 2.4, 2.6, 1.6, 0, 1.4, 0.6);
      w.box(GEAR.paper, 2, 2.2, 1.4, 0, 3.6, 0.6);
      w.box("#b8333a", 2.4, 2.6, 1.6, 0, 5.8, 0.6);
      w.box(trim, 0.4, 7, 0.5, 1.3, 3.6, 0);
      return { arm: -0.9 };
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
    case "smith_hammer":
      // A forging hammer: a short ash handle and a heavy iron head across it, a flat face one side and a peen the other.
      shaft(GEAR.wood, 8.6, 2.6);
      w.cyl(GEAR.iron, 0.5, 0.5, 0.7, 0, 6.6, 0, 6);
      w.box(GEAR.iron, 1.5, 1.6, 2.4, 0, 7.6, 0.5);
      w.box(GEAR.steel, 1.6, 1.7, 0.4, 0, 7.6, 1.8);
      w.box(GEAR.iron, 0.6, 1.0, 1.2, 0, 7.6, -1.3);
      return { tilt: 0.5 };
    case "cleaver":
      // The cook's cleaver: a short dark handle with brass rivets and a broad, heavy blade standing off it on the side
      // the forging hammer's face is, so the same blow that lands a hammer flat lands this edge down. The edge is
      // ground bright; a hole at the corner to hang it by.
      shaft("#4a321c", 4.0, 0.6);
      for (const y of [-0.5, 0.9]) w.ball(GEAR.gold, 0.22, 0.46, y, 0, 0);
      w.box(GEAR.iron, 0.34, 5.2, 3.1, 0, 5.3, 0.5);
      w.box(GEAR.steel, 0.36, 5.2, 0.5, 0, 5.3, 1.82);
      w.box("#2a2623", 0.38, 0.5, 0.5, 0, 7.3, -0.5);
      return { tilt: 0.5 };
    case "dop":
      // The lapidary's dop: a short turned stick with a brass ferrule, a lump of dark wax on its end and the stone
      // being cut set in the wax. It is what she holds the stone to the wheel with.
      w.cyl("#8a6a44", 0.34, 0.42, 4.6, 0, 1.9, 0, 6);
      w.cyl(GEAR.gold, 0.46, 0.46, 0.5, 0, 4.2, 0, 6);
      w.ball("#3a2a22", 0.6, 0, 4.9, 0, 0);
      w.glowBall(look.accent, 0.42, 0, 5.5, 0);
      return { tilt: 0.3 };
    case "paddle":
      // A brewer's paddle, taller than he is: a long shaft of pale, scrubbed ash, a dark band where it is gripped,
      // and a broad blade on the end, stained green where it goes into the brew. Pale so it shows against the
      // dark of the pot and his green coat.
      w.cyl("#efe2c4", 0.55, 0.55, 21, 0, 6, 0, 6);
      w.cyl("#5a3d22", 0.6, 0.6, 2.2, 0, 0.4, 0, 6);
      w.box("#f6ecd4", 0.6, 4.4, 2.4, 0, 16, 0);
      w.box("#9fe08a", 0.62, 1.4, 2.45, 0, 17.4, 0);
      return {};
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
      const s = b.shield();
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
      // The Chainshot Flail: three chains from the head, a small cannon ball on each.
      for (const [y, z] of [[5.3, 0.5], [5.7, 1.3], [5.3, 2.1]]) w.box(GEAR.iron, 0.5, 0.5, 0.6, 0.6, y, z);
      for (const [y, z] of [[4.8, 0.5], [4.2, 1.2], [3.5, 1.8]]) w.box(GEAR.iron, 0.5, 0.5, 0.6, -0.6, y, z);
      w.ball(GEAR.iron, 0.95, 0.7, 4.6, 3.0, 1);
      w.ball(GEAR.iron, 0.95, -0.7, 2.6, 2.5, 1);
      w.ball(GEAR.iron, 0.95, 0, 3.3, 4.3, 1);
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
      if (!shield) {
        hook(b.heldL);
        carryLeft(b, 0);
      }
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
    case "boarding_pike":
      shaft(GEAR.wood, 15, 3.4);
      w.cyl(trim, 0.6, 0.6, 0.8, 0, 6, 0, 6);
      w.cyl(GEAR.iron, 0.55, 0.55, 1.2, 0, 10.8, 0, 6);
      w.box(GEAR.iron, 3.4, 0.5, 0.5, 0, 11.6, 0);
      w.cone(GEAR.steel, 0.95, 4.8, 0, 14, 0, 4);
      return { tilt: 0.15 };
    case "bilge_chalice": {
      w.cyl(GEAR.gold, 0.36, 0.36, 2.4, 0, 1.2, 0, 6);
      w.cyl(GEAR.gold, 1.7, 0.8, 2.2, 0, 3.4, 0, 8);
      w.cyl(trim, 1.78, 1.78, 0.4, 0, 4.2, 0, 8);
      w.glowBox("#6dff9e", 2.2, 0.2, 2.2, 0, 4.55, 0);
      // What it brims with bubbles up off it (see makeMotes).
      b.emits("#6dff9e", [0, 4.8, 0]);
      return { arm: -0.9 };
    }
  }
  return {};
}

/** A shield on the left forearm, held across the front. */
/** A lit torch in the fist: a stick, pitch-soaked rag bound round its head, and a live flame on it (torchFlame.ts). */
function drawTorch(fist: Part) {
  fist.cyl("#6b4a2b", 0.4, 0.48, 9.5, 0, 2.4, 0, 6);
  fist.cyl("#2a1d14", 0.82, 0.82, 0.45, 0, 6.6, 0, 7);
  fist.cyl("#3a2a1e", 1.05, 0.72, 2.4, 0, 7.9, 0, 7);
  // A torch's fire, not a candle's: broad at the rag and licking well up past the head.
  const flame = torchFlame(2.5);
  flame.position.set(0, 8.6, 0);
  fist.joint.add(flame);
}

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
  // Under the hem of whatever is worn on the body.
  tier = TIER.legs;
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
      else if (look.boots) lowBoots(foot, shin, "sea", look.boots);
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

  tier = TIER.body;

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
  } else if (lowPoly && body?.ref === "diving_plate") {
    front = lowDiverPlate(torso, look.skin, m.shoulders / m.girth, trim("body"));
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
    const edgeColor = greatcoat ? trim("body") : look.coatTrim ?? look.accent;
    if (lowPoly) {
      // Each side's skirt hangs from the hip on a joint of its own and turns with the leg on that side (see
      // skirts), so the legs stride under the coat instead of through it: hinged level with the hip joints, so
      // skirt and leg turn about the same line, and standing a little off the leg. It is the torso's girth, as the
      // torso's own cloth is.
      for (const s of [-1, 1]) {
        const skirt = new Part(torso.joint, 0, SKIRT_PIVOT, 0);
        skirt.skin.position.y = -SKIRT_PIVOT;
        skirt.skin.scale.set(m.girth, 1, m.girth);
        const coatCloth = greatcoat ? cloth : look.coatColor ?? cloth;
        const thigh = (s > 0 ? b.thighL : b.thighR).joint;
        // Folded at the knee: the upper skirt turns with the thigh, and below the knee a second piece, hinged
        // there, bends with the shin, so the hem follows the lower leg as it kicks back.
        // The two overlap round the knee, the lower just inside the upper, so a bend slides one under the other
        // instead of opening a gap between them.
        const knee = KNEE * m.legs;
        coatPanel(skirt, coatCloth, s, 0.42, Math.PI + 0.05, SKIRT_EASE, [1.4, knee - FOLD_OVERLAP]);
        coatPanel(skirt, edgeColor, s, 0.38, 0.52, SKIRT_EASE + 0.06, [1.4, knee - FOLD_OVERLAP]);
        const fold = new Part(skirt.joint, 0, knee - SKIRT_PIVOT, 0);
        fold.skin.position.y = -knee;
        fold.skin.scale.set(m.girth, 1, m.girth);
        coatPanel(fold, coatCloth, s, 0.42, Math.PI + 0.05, SKIRT_EASE - 0.14, [knee + FOLD_OVERLAP, coatHem()]);
        coatPanel(fold, edgeColor, s, 0.38, 0.52, SKIRT_EASE - 0.08, [knee + FOLD_OVERLAP, coatHem()]);
        extraParts.push(skirt, fold);
        skirts.push({ joint: skirt.joint, thigh, fold: fold.joint, shin: (s > 0 ? b.shinL : b.shinR).joint });
      }
    } else {
      for (const s of [-1, 1]) {
        torso.box(greatcoat ? cloth : look.coatColor ?? cloth, 2.7, 4.6, 4.3, s * 2.4, -2, 0);
        torso.box(edgeColor, 0.5, 4.6, 0.4, s * 1.25, -2, 2.05);
      }
      torso.box(greatcoat ? cloth : look.coatColor ?? cloth, 7.3, 4.6, 1, 0, -2, -1.7);
    }
  }
  if (look.apron && !body && !undressed) {
    // An apron over the clothes: a bib on the chest with a strap over each shoulder, a darker tape round the
    // waist, and a skirt hanging a little clear of the thighs to the knees, a pocket on it.
    const apron = look.apron;
    torso.box(apron, 4.2, 3.4, 0.4, 0, 3.7, 2.08);
    for (const s of [-1, 1]) torso.box(tone(apron, -0.1), 0.5, 1.8, 0.3, s * 1.55, 5.75, 1.72, [-0.6, 0, -s * 0.12]);
    torso.box(tone(apron, -0.14), 5.8, 0.6, 0.45, 0, 1.75, 2.14);
    torso.box(apron, 5.6, 5.2, 0.4, 0, -0.9, 2.45, [-0.07, 0, 0]);
    torso.box(tone(apron, -0.08), 2.4, 1.4, 0.3, 0, -0.5, 2.52, [-0.07, 0, 0]);
  }
  if (look.corselet && !body && !undressed) {
    // A diver's brass corselet: a plate over the shoulders and the top of the chest and back, up to a collar
    // the helmet seats on, with a ring of bolts round it.
    const c = look.corselet;
    if (lowPoly) {
      const rings = chestRings(m.shoulders / m.girth);
      torso.loft(c, [around(rings, 3.9, 0.12, 0.02), around(rings, 4.8, 0.28, 0.02), around(rings, 5.7, 0.3, 0), [6.45, 2.1, 1.85, 0], [6.9, 1.75, 1.6, 0]]);
      torso.loft(tone(c, -0.2), [around(rings, 3.75, 0.16, 0.02), around(rings, 4.05, 0.16, 0.02)]);
      const at = ringAt(rings, 4.85);
      for (let i = 0; i < 10; i++) {
        const a = ((i + 0.5) / 10) * Math.PI * 2;
        torso.ball(tone(c, 0.12), 0.24, Math.sin(a) * (at.rx + 0.38), 4.85, Math.cos(a) * (at.rz + 0.38) + at.dz, 0);
      }
    } else {
      torso.box(c, 7.8, 1.8, 4.6, 0, 5.3, 0);
      torso.box(tone(c, -0.2), 7.9, 0.4, 4.7, 0, 4.4, 0);
    }
  }
  if (lowPoly && !body && !undressed) {
    const rings = chestRings(m.shoulders / m.girth);
    if (look.coat) {
      // The coat's front edges, trimmed, carried up from the skirts over the chest to the collar: the same line as
      // the skirts' edge, so it reads as one coat from the hem to the neck.
      const trimEdge = look.coatTrim ?? look.accent;
      for (const s of [-1, 1]) {
        const line = [1.3, 2.4, 3.5, 4.5, 5.3, 5.95].map((y, i, ys): Pt => {
          const r = ringAt(rings, y);
          // It turns out a little toward the shoulder at the top, a lapel opening round the neck.
          const a = 0.47 + 0.25 * Math.max(0, (i - (ys.length - 3)) / 2);
          return [s * Math.sin(a) * (r.rx + 0.16), y, Math.cos(a) * (r.rz + 0.16) + r.dz];
        });
        for (let i = 0; i + 1 < line.length; i++) strut(torso, trimEdge, line[i], line[i + 1], 0.17);
      }
    }
    if (look.coat && look.coatColor) {
      // The coat over the chest, all round the back and up over the shoulders to a collar at the neck, open down
      // the front where the shirt shows.
      for (const s of [-1, 1]) {
        const pts: Pt[] = [];
        for (const y of [0.4, 2.4, 4.4, 5.3, 5.9, 6.3]) {
          const r = ringAt(rings, y);
          for (const deg of [s * 28, s * 60, s * 95, s * 130, s * 160, s * 180]) {
            const a = (deg / 180) * Math.PI;
            pts.push([Math.sin(a) * (r.rx + 0.14), y, Math.cos(a) * (r.rz + 0.14) + r.dz]);
          }
        }
        torso.shape(look.coatColor, pts);
      }
    }
    if (look.vines) {
      // Kelp growing up round the torso: three vines from the waist, each winding half round the body as it climbs
      // to the shoulders, a little wavy, thinning toward the top, with a frond off it here and there.
      const out = (a: number, y: number, by: number): Pt => {
        const r = ringAt(rings, y);
        return [Math.sin(a) * (r.rx + by), y, Math.cos(a) * (r.rz + by) + r.dz];
      };
      for (let v = 0; v < 3; v++) {
        const start = (v / 3) * Math.PI * 2 + 0.4;
        const pts: Pt[] = [];
        for (let i = 0; i <= 8; i++) {
          const t = i / 8;
          const y = 0.6 + t * 5.2;
          pts.push(out(start + t * Math.PI * (v % 2 ? -1 : 1) + 0.18 * Math.sin(t * 9 + v), y, 0.14));
        }
        for (let i = 0; i + 1 < pts.length; i++) strut(torso, i % 2 ? tone(look.vines, -0.08) : look.vines, pts[i], pts[i + 1], 0.26 - i * 0.014, 0.25 - i * 0.014);
        // Fronds: long, flat blades sprouting off the vine, lying along the body.
        for (const i of [2, 4, 6]) {
          const a = start + (i / 8) * Math.PI * (v % 2 ? -1 : 1) + (i % 4 ? 0.28 : -0.28);
          torso.ball(tone(look.vines, 0.12), 0.32, ...out(a, 0.6 + (i / 8) * 5.2 + 0.35, 0.2), 0, [0.7, 1.7, 0.35]);
        }
      }
    }
    if (look.stripes) {
      // Bands round the chest, like a lighthouse's.
      for (const [y0, y1] of [[1.9, 2.7], [3.5, 4.3]]) torso.loft(look.stripes, [around(rings, y0, 0.07), around(rings, y1, 0.08)]);
    }
    if (look.vest) {
      // A vest over the shirt, open down the front: the shirt shows in a strip between its fronts.
      torso.loft(look.vest, [around(rings, 0.7, 0.1), around(rings, 3.6, 0.12), around(rings, 5.45, 0.12), around(rings, 5.95, 0.08)]);
      const f = (y: number) => onChest(rings, 0, y, 0.16).at;
      torso.shape(look.body, [[-0.55, 5.6, f(5.6)[2] - 0.3], [0.55, 5.6, f(5.6)[2] - 0.3], [-0.45, 0.8, f(0.8)[2] - 0.2], [0.45, 0.8, f(0.8)[2] - 0.2], [-0.5, 5.6, f(5.6)[2]], [0.5, 5.6, f(5.6)[2]], [-0.4, 0.8, f(0.8)[2]], [0.4, 0.8, f(0.8)[2]]]);
      for (const y of [2.2, 3.3]) for (const s of [-1, 1]) torso.ball(GEAR.gold, 0.16, ...onChest(rings, s * 0.75, y, 0.18).at, 0);
    }
    if (look.straps) {
      // A strap from the right shoulder across the chest to the left hip, buckled; a belt with a pouch on each hip.
      const pts = [0, 0.25, 0.5, 0.75, 1].map((t) => onChest(rings, -2.2 + 4.2 * t, 5.2 - 4 * t, 0.16).at);
      for (let i = 0; i + 1 < pts.length; i++) strut(torso, look.straps, pts[i], pts[i + 1], 0.24);
      torso.box(GEAR.iron, 0.6, 0.6, 0.2, ...onChest(rings, -0.1, 3.2, 0.32).at);
      torso.loft(look.straps, [around(rings, 0.25, 0.14, 0.02), around(rings, 0.75, 0.14, 0.02)]);
      torso.box(GEAR.iron, 0.75, 0.6, 0.25, ...onChest(rings, 0, 0.5, 0.2).at);
      for (const s of [-1, 1]) {
        const p = onChest(rings, s * 0.85 * ringAt(rings, 0).rx, -0.1, 0.3);
        torso.box(tone(look.straps, -0.08), 1, 1.1, 0.6, ...p.at, [0, p.yaw, 0]);
      }
    }
    if (look.teeth) {
      // Teeth strung round the throat, pointing down, with a stone at the middle.
      for (let i = 0; i < 9; i++) {
        const x = -1.7 + (3.4 * i) / 8;
        const y = 5.55 - 0.35 * Math.cos((x / 1.7) * HALF_PI);
        // Over a hood's mantle, where there is one, and low enough to clear its tie.
        const p = onChest(rings, x, y - (look.hat === "hood" ? 0.9 : 0), look.hat === "hood" ? 1.05 : 0.12);
        torso.cone(GEAR.bone, 0.18, 0.7, p.at[0], p.at[1] - 0.35, p.at[2], 6, [Math.PI, p.yaw, 0]);
      }
      torso.glowBall(look.teeth, 0.3, ...onChest(rings, 0, look.hat === "hood" ? 4.2 : 5.1, look.hat === "hood" ? 1.15 : 0.22).at);
    }
  }
  if (look.mask && lowPoly && !body && !undressed) {
    // The scarf's end, hanging from the throat down the chest.
    const rings = chestRings(m.shoulders / m.girth);
    const p = onChest(rings, 0.4, 5.6, 0.12);
    const q = onChest(rings, 0.7, 3.4, 0.12);
    torso.shape(look.mask, [[p.at[0] - 0.7, 6.1, p.at[2]], [p.at[0] + 0.7, 6.1, p.at[2]], [q.at[0] - 0.45, 3.4, q.at[2]], [q.at[0] + 0.5, 3.1, q.at[2]], [p.at[0], 6, p.at[2] - 0.2], [q.at[0], 3.3, q.at[2] - 0.2]]);
  }
  if (look.sash && !body && !undressed) {
    // A sash wound tight round the waist over the belt, knotted on the left hip, its two ends hanging to the
    // thigh and swinging as the figure moves (see swingBraids).
    const sash = look.sash;
    if (lowPoly) {
      const rings = chestRings(m.shoulders / m.girth);
      torso.loft(sash, [around(rings, 0.45, 0.13, 0.02), around(rings, 1.15, 0.15, 0.03), around(rings, 1.95, 0.13, 0.05)]);
      // The fold where it is wound round a second time.
      torso.loft(tone(sash, -0.16), [around(rings, 1.08, 0.17, 0.03), around(rings, 1.24, 0.17, 0.03)]);
      const knot = onChest(rings, 0.78 * ringAt(rings, 1.1).rx, 1.1, 0.35);
      torso.ball(tone(sash, -0.06), 0.8, ...knot.at, 0, [1.1, 0.85, 0.7]);
      // The ends hang from under the knot, a little proud of the hip, turned to lie along it.
      for (const [n, len, lean] of [[0, 2.4, 0.1], [1, 1.8, -0.12]] as const) {
        const root = new Part(torso.joint, knot.at[0] * m.girth + (n ? -0.2 : 0.15), knot.at[1] - 0.3, knot.at[2] * m.girth + 0.15 + n * 0.15);
        root.skin.rotation.set(0, knot.yaw, lean);
        root.loft(sash, [[0.35, 0.55, 0.14, 0], [-len * 0.35, 0.68, 0.15, 0.14], [-len * 0.7, 0.74, 0.15, -0.06], [-len - 0.1, 0.78, 0.15, 0.1]], 6);
        const end = new Part(root.joint, Math.sin(lean) * len, -len, 0);
        end.skin.rotation.set(0, knot.yaw, -lean * 0.5);
        const tail = len * 0.85;
        end.loft(tone(sash, -0.05), [[0.15, 0.78, 0.15, 0.1], [-tail * 0.4, 0.84, 0.15, -0.14], [-tail * 0.8, 0.88, 0.14, 0.12], [-tail, 0.84, 0.13, 0]], 6);
        // A fringe of gold thread at the end.
        end.loft(GEAR.gold, [[-tail - 0.05, 0.85, 0.13], [-tail - 0.4, 0.78, 0.1]], 6);
        // The body it hangs over: a long coat's skirts (flaring over the hips and out to the shin), or the hips
        // and tops of the thighs; a little thicker than the cloth so the sash lies on it.
        const hip = m.hips;
        const g = m.girth;
        const section = (y: number): [number, number, number] => {
          if (look.coat) {
            const t = Math.min(1, Math.max(0, (1.4 - y) / 6));
            return [(2.85 * (1 + hip) * 0.5 + (Math.max(3.5 * hip, thighReach(0.2) + 0.25) - 2.85 * (1 + hip) * 0.5) * t) * g + 0.25, (2 + 0.7 * t) * g + 0.25, 0.05 * (1 - t) - 0.2 * t];
          }
          return [Math.max(2.85 * hip, thighReach(y)) * g + 0.2, (1.95 + (hip - 1) * 0.6) * g + 0.2, 0];
        };
        hang(root, end, 1.5 + n * 2, 0, b.thighL.joint, { at: [root.joint.position.x, root.joint.position.y, root.joint.position.z], lengths: [len, tail], section });
      }
    } else {
      torso.box(sash, 7.4, 1.5, 4.15, 0, 1.1, 0);
      torso.ball(tone(sash, -0.1), 0.85, 3.2, 1, 1.4, 1, [1, 1, 0.8]);
      for (const [k, x] of [[0, 3.4], [1, 3.9]] as const) {
        for (let i = 0; i < 3 - k; i++) torso.box(i % 2 ? tone(sash, -0.07) : sash, 1.1, 1.4, 0.35, x + Math.sin(i + k) * 0.3, 0.1 - i * 1.2, 1.4 + k * 0.3);
      }
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
  const helmet = armor("helmet");
  // A hood, worn or the class's own: its mantle covers the shoulders (see lowMantle).
  // A lantern helm on the head (the Lantern Helm on anyone, or any starter hat on a Paladin: wearsLanternHelm, the
  // same rule that lights the dark round them) is drawn as one, and is no hood.
  const lantern = !!outfit?.helmet && wearsLanternHelm(figureKind, outfit);
  const hood = helmet ? helmet.ref === "hood" || helmet.icon === "hood" : !bare("helmet") && !lantern && look.hat === "hood";
  for (const [arm, s] of [[armR, -1], [armL, 1]] as const) {
    if (lowPoly) {
      lowHand(arm, look.skin, s);
      if (!greatcoat && !body) {
        const region = s < 0 ? "armR" : "armL";
        if (undressed || look.sleeveless) {
          // Bare arms: undressed, or a shirt with no sleeves.
          lowBareArm(arm, look.skin);
          if (chosen?.ink) inkPart(arm, region, chosen.ink);
        } else if (inkedArms) {
          // Sleeves rolled up, to show off the ink on the forearms.
          lowRolledSleeve(arm, look.skin, cloth);
          inkPart(arm, region, chosen!.ink!);
        } else lowSleeve(arm, look.coat && look.coatColor ? look.coatColor : cloth, look.accent);
        if (look.shell && !undressed) {
          // A scallop shell on the outside of each shoulder: a ribbed fan, its hinge low, opening upward.
          const x = s * 1.45;
          const rim = (k: number, a: number, out: number): Pt => [x + s * out, 1.9 * k * Math.cos(a), 1.9 * k * Math.sin(a)];
          const fan: Pt[] = [[x, -0.2, 0], [x + s * 0.25, -0.2, 0]];
          for (let i = 0; i <= 8; i++) {
            const a = -1.15 + (2.3 * i) / 8;
            fan.push(rim(1, a, 0), rim(1, a, 0.3));
          }
          arm.shape(look.shell, fan);
          for (let i = 0; i <= 6; i++) {
            const a = -1 + (2 * i) / 6;
            strut(arm, tone(look.shell, -0.18), [x + s * 0.32, -0.1, 0], rim(0.97, a, 0.34), 0.07, 0.09);
          }
          arm.ball(tone(look.shell, -0.2), 0.3, x + s * 0.2, -0.2, 0, 0);
        }
        if (look.epaulettes && !undressed) {
          // A gold pad over the shoulder, fringed all along its edge.
          arm.box(look.epaulettes, 2.3, 0.4, 2.5, s * 0.35, 1.35, 0);
          for (let i = 0; i < 6; i++) arm.box(tone(look.epaulettes, -0.08), 0.16, 0.85, 0.16, s * 1.45, 0.85, -1 + (2 * i) / 5);
          for (let i = 0; i < 3; i++) arm.box(tone(look.epaulettes, -0.08), 0.16, 0.85, 0.16, s * (1.0 - i * 0.45), 0.85, 1.2);
        }
        if (look.barnacles && !undressed) {
          // Barnacles crusted over the top of the shoulder, and a sprig of red coral among them.
          for (const [x, z, r] of [[0.35, 0.3, 0.34], [0.75, -0.25, 0.28], [0.1, -0.45, 0.24], [0.95, 0.45, 0.22], [-0.2, 0.55, 0.2]] as const) {
            arm.ball(r > 0.25 ? "#cfc6b0" : "#b3ab95", r, s * x, 1.25, z, 0, [1, 0.75, 1]);
          }
          strut(arm, "#c4604f", [s * 0.45, 1.3, 0.1], [s * 0.6, 2.2, 0.25], 0.12, 0.07);
          strut(arm, "#c4604f", [s * 0.52, 1.75, 0.16], [s * 0.95, 2.15, 0], 0.08, 0.05);
        }
        continue;
      }
      if (greatcoat) {
        // Oilskin sleeves, cuffed in the coat's trim.
        lowSleeve(arm, oilskin, trim("body"));
      } else {
        if (body?.ref === "diving_plate") {
          // Riveted iron sleeves, a big round pauldron rimmed in brass with a boss of the trim, and an iron
          // vambrace banded in brass.
          lowSleeve(arm, tone(DIVE_IRON, -0.08), DIVE_BRASS);
          if (!hood) {
            arm.ball(DIVE_IRON, 1.75, s * 0.3, 0.35, 0, 1, [1.05, 0.78, 1.12]);
            arm.loft(DIVE_BRASS, [[-0.55, 1.72, 1.72], [-0.2, 1.72, 1.72]], 10, s * 0.25);
            arm.ball(trim("body"), 0.4, s * 1.65, 0.75, 0, 0);
          }
          arm.loft(DIVE_IRON, [[-3.75, 1.18, 1.18], [-2.55, 1.24, 1.24]], 8);
          arm.loft(DIVE_BRASS, [[-2.75, 1.3, 1.3], [-2.5, 1.3, 1.3]], 8);
          continue;
        }
        // Mail sleeves, a steel pauldron over the shoulder edged in the trim (under a hood's mantle, none),
        // and a steel vambrace.
        lowSleeve(arm, GEAR.iron, GEAR.steel);
        if (!hood) {
          arm.ball(GEAR.steel, 1.55, s * 0.25, 0.35, 0, 0, [1.05, 0.72, 1.15]);
          arm.loft(trim("body"), [[-0.75, 1.5, 1.5], [-0.45, 1.5, 1.5]], 8, s * 0.2);
        }
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
    // (The starting hat is the class's own, so it covers the hair only if the class has one.)
    const hatted = (!!outfit?.helmet && !garb("helmet")) || lantern || ((!chosen || garb("helmet")) && look.hat !== "none");
    lowHead(head, look, asleep, hatted);
  } else drawHead(head, look, asleep);
  // Over the hair and the head.
  tier = TIER.headgear;
  if (lowPoly && helmet) {
    lowWornHelmet(head, helmet, trim("helmet"));
  } else if (helmet?.ref === "hood" || helmet?.icon === "hood") {
    drawHood(head, GEAR.leather, trim("helmet"));
  } else if (helmet?.ref === "visor" || helmet?.icon === "brutal-helm") {
    // A lookout's leather cap banded in brass, flaps over the ears, goggles, and a spyglass over one eye alight at its end.
    head.box("#7a4a2a", 7.1, 3, 6.7, 0, 5.4, 0);
    head.box(DIVE_BRASS, 7.3, 0.7, 6.9, 0, 4.1, 0);
    for (const s of [-1, 1]) head.box("#7a4a2a", 0.7, 2.8, 2.6, s * 3.45, 2.4, -0.1);
    head.box("#5a3520", 7.2, 0.5, 6.8, 0, 2.9, -0.3);
    head.box(DIVE_BRASS, 1.5, 1.5, 0.6, 1.5, 2.9, 3.5);
    head.box(GEAR.dark, 1, 1, 0.2, 1.5, 2.9, 3.85);
    head.cyl(DIVE_BRASS, 0.75, 0.75, 0.6, -1.5, 2.9, 3.6, 6, [HALF_PI, 0, 0]);
    head.cyl(tone(DIVE_BRASS, 0.18), 0.55, 0.55, 1, -1.6, 2.9, 4.4, 6, [HALF_PI, 0, 0]);
    head.cyl(DIVE_BRASS, 0.85, 0.7, 1.2, -1.75, 2.9, 5.4, 6, [HALF_PI, 0, 0]);
    head.glowBox(trim("helmet"), 1, 1, 0.2, -1.75, 2.9, 6.05);
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
  } else if (lowPoly && lantern) {
    // A lantern helm, whatever the wearer's class (it can be passed on through the crew's chest): it lights the dark
    // round them in the caves. Its cap is in their colours.
    lowLanternHelm(head, look.accent);
  } else if (!bare("helmet")) {
    // No helmet equipped: the class keeps its own hat (a hero who chose their look wears it as an item).
    if (lowPoly) lowHat(head, look);
    else drawHat(head, look);
  }
  // A hood's mantle lies on the shoulders, over what is worn on the body and under the hood.
  if (lowPoly && hood) {
    tier = TIER.mantle;
    lowMantle(torso, helmet ? GEAR.leather : (look.hatColor ?? look.body), amuletOver, helmet ? trim("helmet") : look.accent, helmet ? trim("helmet") : undefined);
  }
  tier = TIER.body;

  if (amulet && lowPoly) lowAmulet(torso, amulet.ref, trim("amulet"), m.shoulders / m.girth, amuletOver);

  // Hands: a hero's weapon (signature weapons that have no shape of their own are drawn as the one they are like).
  const shield = outfit?.off_hand;
  if (shield?.icon === "torch") drawTorch(b.aloft());
  else if (shield) drawShield(b.shield(), shield.ref, shield.icon, trim("off_hand"));
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
  // How what is in hand strikes: by the weapon (its own, or the one it is drawn as), its icon, or the stock look's.
  const main = outfit?.main_hand;
  const light = outfit ? (main ? (LIGHT[main.ref] ?? LIGHT[WEAPONS[main.ref]?.looksLike ?? ""] ?? LIGHT[main.icon]) : LIGHT.none) : LIGHT[look.weapon];
  return { parts, animate: b.animate, hands: [b.heldR.joint, b.heldL.joint], carried: b.carried, loose: b.loose, acts: true, light, plays: b.plays(), twin: b.twin(), fires: b.fires(), long: b.longGun(), getUp: BIPED_GET_UP };
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

/** How far forward each arm comes (radians) to hold a squeeze box before the chest. */
const ACCORDION_ARMS = { right: -1.0, left: -1.0 };

/** A squeeze box in its own part's frame: from the end board at the origin up +y to the other at `span`, keys to the front. */
function drawAccordion(p: Part, trim: string, span: number) {
  // Its icon's model, drawn out to reach from hand to hand: 15.5 long from board to board.
  if (gear(p, "accordion", trim, { grip: [0, -7.75, 0], scale: [0.5, span / 15.5, 0.5] })) return;
  p.box("#b8333a", 3.4, 1, 2.2, 0, 0.5, 0);
  p.box(GEAR.paper, 3, span - 2, 1.9, 0, span / 2, 0);
  p.box("#b8333a", 3.4, 1, 2.2, 0, span - 0.5, 0);
  p.box(trim, 0.3, span - 2, 0.8, -1.7, span / 2, -0.5);
}

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
function sling(b: Biped, front: Part, back: Part, arms: { right: number; left: number }, kind: Exclude<Instrument, "bell">, span: number, color: string) {
  extraParts.push(front, back);
  b.instrument(kind, front, span, color);
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
  // Played straight-armed: the instrument is laid from hand to hand (see handAt).
  b.rest.armL = arms.left;
  b.rest.bendL = 0;
  return { arm: arms.right, bend: 0 };
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
  s.rest.bendL = s.rest.bendR = FREE_BEND * e;
}

/**
 * Carry what the right hand holds. `arm` is how far forward a straight arm would have held it: with the elbow
 * bent (`bend`, HELD_BEND unless given) the upper arm is drawn back a little (HELD_BACK), less the further
 * forward that was, and the forearm does the reaching. A `bend` of 0 keeps the arm straight, exactly at `arm`;
 * `upper` sets the upper arm outright, whatever `arm` is.
 */
function apply(b: Biped, pose: Carry) {
  const arm = pose.arm ?? -0.35;
  const bend = pose.bend ?? HELD_BEND;
  b.rest.armR = pose.upper ?? (bend === 0 ? arm : HELD_BACK + 0.4 * (arm + 0.35));
  b.rest.bendR = bend;
  b.rest.tiltR = pose.tilt ?? 0;
}
type Carry = { arm?: number; tilt?: number; bend?: number; upper?: number };

/** The left hand carries the twin of what the right does (a second dagger, a second hook): the same crook of the arm. */
function carryLeft(b: Biped, tilt: number) {
  b.pair();
  b.rest.armL = HELD_BACK;
  b.rest.bendL = HELD_BEND;
  b.rest.tiltL = tilt;
}

/** One of the smugglers' dead: a skeleton with a rusted cutlass and a scrap of its old bandana. */
/**
 * A skeleton in a bandana with a rusted cutlass. `drowned`: one of a Warlock's sunken sailors, called up off the sea floor,
 * its bones stained by the sea and hung with kelp, in a navy kerchief with its cutlass, or under a tricorn with a pistol.
 */
function skeleton(top: THREE.Group, drowned?: "cutlass" | "pistol"): Rig {
  const parts: Part[] = [];
  const b = biped(top, parts);
  const bone = drowned ? "#c3cbb2" : "#e8e2d0";
  const dim = drowned ? "#98a48d" : "#c9c1aa";
  const rag = drowned ? "#2c4f73" : "#8a3b2f";
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
  if (drowned === "pistol") {
    // A gunner's tricorn: a three-cornered brim of sodden felt round a low crown.
    const felt = "#26303a";
    h.loft(felt, [[5.15, 4.3, 4.3], [5.5, 4.3, 4.3]], 3, 0, 0, -0.15, [0, Math.PI, 0]);
    h.loft(felt, [[5.3, 2.75, 2.6, -0.15], [6.6, 2.5, 2.35, -0.15], [7.1, 1.6, 1.5, -0.15]], 8);
    h.loft("#7a5a2a", [[5.45, 2.8, 2.65, -0.15], [5.8, 2.75, 2.6, -0.15]], 8);
  } else {
    // The bandana tied over its crown, a tail of it hanging behind.
    h.loft(rag, [[4.55, 3.2, 3, -0.1], [5.1, 3.18, 2.98, -0.11], [5.85, 2.6, 2.5, -0.15], [6.45, 1.15, 1.15, -0.15]], 10);
    h.ball(rag, 0.6, 1.9, 5.05, -2.75, 0);
    h.shape(rag, [[1.55, 5.1, -2.7], [2.35, 5.1, -2.65], [2.65, 2.7, -3.15], [3.3, 2.95, -3], [2.2, 4.3, -3.2]]);
  }
  if (drowned) {
    // The sea floor still on it: kelp trailing off the collarbones and the hips, and barnacles crusted on the bone.
    const weed = "#4f7a3a";
    const crust = "#ddd6c2";
    for (const [x, len] of [[-3.1, 2.6], [-1.2, 1.7], [2.3, 2.2], [3.6, 1.5]] as const) strut(t, weed, [x, 5.7, 0.55], [x * 1.05, 5.7 - len, 1.1], 0.24, 0.1, 5);
    for (const x of [-1.9, 1.4]) strut(t, weed, [x, 1.2, 1.05], [x * 1.1, -0.9, 1.25], 0.22, 0.1, 5);
    for (const [x, y, z] of [[3.9, 5.95, 0.5], [-4.4, 5.3, 0.3], [1.7, 0.6, 1.2], [-0.6, 3.6, -0.75]] as const) t.ball(crust, 0.3, x, y, z);
    h.ball(crust, 0.32, 2.4, 3.1, 1.6);
    h.ball(crust, 0.26, -2.1, 4.1, 1.5);
  }
  const w = b.heldR;
  const wood = "#6b4a2b";
  const rust = "#a3896a";
  if (drowned === "pistol") {
    // A flintlock pistol held up: a curved wooden butt in the fist, the lock and its hammer, and a long iron barrel, belled at the muzzle.
    const iron = "#5d6670";
    w.loft(wood, [[-0.8, 0.5, 0.42, -0.35], [0.2, 0.42, 0.38, -0.1], [1.1, 0.38, 0.36]], 6);
    w.ball(wood, 0.55, 0, -0.9, -0.45);
    w.shape(iron, sym([[0.3, 0.9, 0.5], [0.3, 0.9, -0.3], [0.3, 1.7, 0.5], [0.3, 1.7, -0.3]]));
    strut(w, iron, [0, 1.5, -0.35], [0, 2.1, -0.75], 0.16);
    w.loft(iron, [[1.2, 0.34, 0.34, 0.2], [5.4, 0.3, 0.3, 0.2], [5.7, 0.42, 0.42, 0.2], [5.9, 0.42, 0.42, 0.2]], 8);
    w.loft(wood, [[1.1, 0.4, 0.4, 0.2], [3.8, 0.36, 0.36, 0.2]], 6);
    apply(b, { tilt: 0.55 });
    return { parts, animate: b.animate, acts: true, getUp: BIPED_GET_UP };
  }
  // A rusted cutlass: a wrapped grip, a knuckle guard, and a broad blade curving forward to its point.
  w.loft(wood, [[-0.7, 0.36, 0.36], [1.1, 0.42, 0.42]], 6);
  w.ball(wood, 0.5, 0, -0.85, 0);
  w.shape(wood, sym([[1.4, 1.15, 0.65], [1.4, 1.5, 0.65], [1.4, 1.15, -0.2], [1.4, 1.5, -0.2], [0.5, 1.0, 0.85], [0.5, 1.65, 0.85], [0.5, 1.0, -0.45], [0.5, 1.65, -0.45]]));
  w.shape(rust, sym([[0.5, 1.5, 0.14], [0.5, 1.5, -0.14], [0.6, 6.3, 0.32], [0.6, 6.3, 0.02]]));
  w.shape(rust, [...sym([[0.6, 6.1, 0.32], [0.6, 6.1, 0.02], [0.42, 8, 0.82], [0.42, 8, 0.52]]), [0, 9.05, 1.35], [0, 9, 1.08]]);
  apply(b, { tilt: 0.55 });
  return { parts, animate: b.animate, acts: true, getUp: BIPED_GET_UP };
}

// ---------- giants ----------

/**
 * A big two-legged figure: built on a person's joints with the proportions `measures` (see biped), then
 * the whole of it grown by `grow`. The outline is thinned to match, so it is as fine as anyone else's.
 */
function giant(top: THREE.Group, parts: Part[], measures: Measures, grow: number, elbow = ELBOW): Biped {
  m = measures;
  edge /= grow;
  top.scale.setScalar(grow);
  return biped(top, parts, elbow);
}

/**
 * Stoop a biped forward by `lean` radians at the hips, its head lifted back to look ahead and its arms hanging
 * `reach` further forward than they would: a hulking carriage. Down, it lies flat like anyone.
 */
function stooped(b: Biped, lean: number, reach: number): (a: Anim) => void {
  return (a) => {
    b.animate(a);
    if (a.lying || a.getUp) {
      b.torso.joint.rotation.x = 0;
      return;
    }
    const k = lean * (1 - a.sitting);
    b.torso.joint.rotation.x += k;
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
  const b = giant(top, parts, { legs: 0.85, girth: 1.4, shoulders: 1.5, hips: 1.3, head: 1 }, 1.3, -2.6);
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
  b.rest.armR = -0.1;
  b.rest.bendR = -0.8;
  b.rest.tiltR = 0.75;
  b.rest.armL = -0.15;
  return { parts, animate: stooped(b, 0.18, 0.05), acts: true, getUp: BIPED_GET_UP };
}

/**
 * A troll: tall, gaunt and stooped, its arms hanging to its knees and ending in claws; grey-green hide with
 * moss and stony warts on it, a long drooping nose, small yellow eyes, ears out to the sides and fangs up
 * from the jaw. A ragged hide round its hips and nothing in its hands.
 */
function troll(top: THREE.Group): Rig {
  const parts: Part[] = [];
  const b = giant(top, parts, { legs: 1.15, girth: 0.9, shoulders: 1.1, hips: 0.95, head: 1 }, 1.18, -3.8);
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
  return { parts, animate: stooped(b, 0.42, 0.1), acts: true, getUp: BIPED_GET_UP };
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
    if (a.getUp) {
      // On its belly, the forelegs out in front and the hind legs tucked forward beside it, the head up.
      top.rotation.set(0, 0, 0);
      top.position.set(0, 1.4 - legs[0].joint.position.y, 0);
      for (const leg of legs) {
        const fore = leg.joint.position.z > 0;
        leg.joint.rotation.set(fore ? -HALF_PI : -HALF_PI * 0.85, 0, fore ? 0 : Math.sign(leg.joint.position.x) * 0.35);
      }
      head.joint.rotation.set(stoop * 0.5 - 0.15, 0, 0);
      if (tail) tail.joint.rotation.y = 0;
      return;
    }
    if (a.lying) {
      // On its side.
      top.rotation.set(0, 0, HALF_PI);
      top.position.set(tall * 0.55, across, 0);
      for (const leg of legs) leg.joint.rotation.set(0, 0, 0);
      head.joint.rotation.set(0, 0, 0);
      return;
    }
    top.rotation.set(-a.strike * 0.3, 0, 0);
    top.position.set(0, (a.breath + 1) * 0.06 + a.strike * 1.2, 0);
    // (Every turn of a joint is set, not one of them: getting up from a fall, it is eased back from however it lay.)
    legs.forEach((leg, i) => leg.joint.rotation.set((i === 0 || i === 3 ? 1 : -1) * a.swing * 0.7, 0, 0));
    head.joint.rotation.set(stoop + a.breath * 0.04 + a.strike * 0.35, 0, 0);
    if (tail) tail.joint.rotation.set(0, Math.sin(a.t * 3.1) * 0.3, 0);
  };
}

/**
 * A wolf, nose toward +z. The pack leader is the same animal, darker, with a red eye. `ember` is the fire in an
 * Ember Hound: it shows through cracks down its back and lights its mouth.
 */
function wolf(top: THREE.Group, fur = "#7d8793", dark = "#59616c", eye = "#ffd23f", ember?: string): Rig {
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
  if (ember) {
    // Cracks in the hide either side of the spine, slanting one way and then the other, and coals at the root of the tail.
    for (let i = 0; i < 7; i++) {
      const z = 4.1 - i * 1.3;
      const spans = z > 0.9 ? ruff : trunk;
      for (const s of [-1, 1]) {
        const a = s * (0.62 + (i % 2) * 0.3);
        body.glowBox(ember, 0.17, 0.5, 1.9 - (i % 3) * 0.3, ...onHide(spans, z, a, 0), [0, s * (i % 2 ? 0.75 : -0.55), -a]);
      }
    }
    for (const s of [-1, 1]) body.glowBall(ember, 0.3, ...onHide(trunk, -4.3, s * 0.5, 0.05));
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
  if (ember) head.glowBox(ember, 1.3, 0.34, 1.9, 0, -0.86, 3.6);
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
  return { parts, animate: fourLegs(top, legs, head, tail, 2.6, 9, 0.3), getUp: BEAST_GET_UP };
}

/**
 * A bear on all fours: heavier than the wolf, with a hump at the shoulders, round ears, a pale muzzle and
 * thick clawed legs. `frost` greys the hump and brow for the old Great Bear; `claw` is the colour of its claws
 * (a Snow Bear's are dark against its white).
 */
function bear(top: THREE.Group, fur = "#7a5232", dark = "#4f3420", muzzle = "#b98a5a", eye = "#f2a33a", frost?: string, claw: string = GEAR.paper): Rig {
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
    for (const cx of [-0.8, 0, 0.8]) leg.shape(claw, [[cx - 0.25, -4.8, 1.55], [cx + 0.25, -4.8, 1.55], [cx, -4.25, 1.6], [cx, -4.75, 2.55]]);
    return leg;
  });
  return { parts, animate: fourLegs(top, legs, head, null, 3.6, 12), getUp: BEAST_GET_UP };
}

/**
 * A ghost of the Haunted Caverns: a pale hooded shape with a ragged hem, hollow eyes and reaching hands,
 * hanging in the air. `crown` gives the bound Haunt the tarnished crown of whoever it was in life. `rime` is the
 * ice on a Rime Wraith: shards of it stand from its shoulders and back, and it is the cold light in its eyes.
 */
function ghost(top: THREE.Group, pale = "#dfe8f2", shade = "#a7b6cc", eye = "#24203a", crown?: string, rime?: string): Rig {
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
  if (rime) {
    for (const s of [-1, 1]) body.glowBall(rime, 0.55, s * 1.5, 13, 3.72);
    // Shards of ice round the shoulders and down the back (not the front, where the arms reach), long and short by turns.
    for (let i = 0; i < 7; i++) {
      const a = Math.PI + (i - 3) * 0.42;
      const long = i % 2 === 0 ? 3.4 : 2.1;
      const y = 10.6 + (i % 2) * 0.9;
      const at = (r: number, h: number, turn = 0): Pt => [Math.sin(a + turn) * r, h, Math.cos(a + turn) * r + 0.1];
      body.shape(rime, [at(3.3, y - 0.7, -0.14), at(3.3, y - 0.7, 0.14), at(3.3, y + 0.5), at(2.9, y), at(3.9 + long, y + long * 0.75)]);
    }
  }
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
    arms.forEach((arm, i) => arm.joint.rotation.set(-0.25 + Math.sin(a.t * 1.3 + i * 2) * 0.15 - a.strike * 0.6, 0, 0));
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
      wings.forEach((p, i) => p.joint.rotation.set(0, 0, (i ? -1 : 1) * 0.2));
      return;
    }
    top.rotation.set(a.strike * 0.5, 0, 0);
    top.position.set(0, Math.sin(a.t * 5) * 0.6, 0);
    const flap = Math.sin(a.t * 15) * 0.6;
    wings.forEach((p, i) => p.joint.rotation.set(0, 0, (i ? 1 : -1) * flap));
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

/** A Druid's sea turtle, nose toward +z: a high domed shell over four broad flippers, a blunt beaked head. */
function seaTurtle(top: THREE.Group): Rig {
  const shell = "#5b7a3a";
  const scute = "#7f9a4a";
  const rim = "#3e5428";
  const skin = "#86ad97";
  const belly = "#d9c98a";
  const parts: Part[] = [];
  const part = (parent: THREE.Object3D, x: number, y: number, z: number) => (parts[parts.length] = new Part(parent, x, y, z));
  const body = part(top, 0, 0, 0);
  // The pale belly plate, the dark rim of the shell over it, and the dome rising to a crown.
  body.loft(belly, [[1.4, 5.2, 6.2], [2.2, 6, 7]], 12);
  body.loft(rim, [[2.1, 6.4, 7.5], [2.9, 6.7, 7.8]], 12);
  body.loft(shell, [[2.8, 6.5, 7.6], [4.2, 6.2, 7.2], [5.6, 5.1, 5.9], [6.6, 3.4, 4], [7.1, 1.4, 1.6]], 12);
  // Plates on the dome: one down the crown, a ring of them round it.
  for (const z of [-3, 0, 3]) spot(body, scute, 1.7, 1.25, 0.5, 0, 6.6 - Math.abs(z) * 0.32, z, [-z * 0.12, 0, 0]);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    spot(body, scute, 1.5, 1.1, 0.45, Math.sin(a) * 4.4, 5.2, Math.cos(a) * 5.1, [Math.cos(a) * -0.55, 0, Math.sin(a) * 0.55]);
  }
  const head = part(top, 0, 3.3, 7.2);
  lengthwise(head, skin, [[-1.2, 1.35, 1.25], [0.6, 1.55, 1.4, 0.1], [2.3, 1.5, 1.35, 0.25], [3.4, 1.05, 0.95, 0.2], [3.9, 0.45, 0.4, 0.1]]);
  head.shape(rim, sym([[0.55, -0.2, 3.2], [0.3, 0.55, 3.55], [0, -0.55, 4.25]]));
  for (const s of [-1, 1]) head.ball(OUTLINE, 0.36, s * 1.05, 0.75, 2.4);
  const flipper = (x: number, z: number, long: number, sweep: number) => {
    const f = part(top, x, 2.4, z);
    f.ball(skin, 1, Math.sign(x) * long * 0.8, -0.2, sweep, 1, [long, 0.42, 1.25]);
    return f;
  };
  const flippers = [flipper(5.4, 3.6, 2.6, 1.2), flipper(-5.4, 3.6, 2.6, 1.2), flipper(4.8, -4.6, 1.7, -0.6), flipper(-4.8, -4.6, 1.7, -0.6)];
  body.ball(skin, 0.6, 0, 2.2, -7.6, 0, [1, 0.8, 1.6]);
  const animate = (a: Anim) => {
    if (a.lying) {
      // Flipped onto its back.
      top.rotation.set(0, 0, Math.PI);
      top.position.set(0, 7.6, 0);
      return;
    }
    top.rotation.set(-a.strike * 0.12, 0, 0);
    top.position.set(0, (a.breath + 1) * 0.05, a.strike * 1.4);
    // Flippers row, the near pair against the far.
    flippers.forEach((f, i) => {
      const side = i % 2 === 0 ? 1 : -1;
      const pair = i < 2 ? 1 : -1;
      f.joint.rotation.set(0, side * pair * a.swing * 0.5, side * (0.08 + Math.abs(a.swing) * 0.15));
    });
    head.joint.rotation.set(a.breath * 0.05 - a.strike * 0.25, Math.sin(a.t * 0.7) * 0.12, 0);
    head.joint.position.z = 7.2 + a.strike * 1.6;
  };
  return { parts, animate };
}

/** A point on a lengthwise loft: `z` along it, `a` radians round it from straight up (toward +x), `by` outside it. */
function onHide(spans: readonly Span[], z: number, a: number, by = 0): Pt {
  const r = ringAt(spans as readonly Ring[], z);
  return [Math.sin(a) * (r.rx + by), r.dz + Math.cos(a) * (r.rz + by), z];
}

/**
 * A hide over part of a lengthwise loft of `sides` sides (an even number) that swells and narrows along its
 * length, where pelt's one flat-sided piece would let the body show through: between `z0` and `z1`, round it
 * from angle `a0` to `a1` (radians from straight up, toward +x), `by` outside it, a piece to each stretch of
 * the loft and a face to each of its faces. Each piece goes a little way into the body, so a narrow one is still a solid.
 */
function hide(part: Part, color: string, spans: readonly Span[], sides: number, z0: number, z1: number, a0: number, a1: number, by = 0.12) {
  const along = [z0, ...spans.map((s) => s[0]).filter((z) => z > z0 && z < z1), z1];
  const step = (Math.PI * 2) / sides;
  const round = [a0];
  for (let a = (Math.floor(a0 / step) + 0.5) * step; a < a1; a += step) if (a > a0) round.push(a);
  round.push(a1);
  for (let i = 0; i + 1 < along.length; i++) part.shape(color, [along[i], along[i + 1]].flatMap((z) => round.flatMap((a) => [onHide(spans, z, a, by), onHide(spans, z, a, by - 0.4)])));
}

/**
 * A two-boned leg with its knee held high, as a spider's is: how far above level the thigh points and then the
 * shin (radians), for a foot `out` from the hip along the ground and `up` above it (below it: under 0). A foot
 * out of reach is brought in along the same line.
 */
function kneeHigh(out: number, up: number, thigh: number, shin: number): [number, number] {
  const d = Math.min(thigh + shin - 0.01, Math.max(Math.abs(thigh - shin) + 0.01, Math.hypot(out, up)));
  const toFoot = Math.atan2(up, out);
  const e1 = toFoot + Math.acos((thigh * thigh + d * d - shin * shin) / (2 * thigh * d));
  return [e1, Math.atan2(Math.sin(toFoot) * d - Math.sin(e1) * thigh, Math.cos(toFoot) * d - Math.cos(e1) * thigh)];
}

/**
 * A spider's four legs a side, front to back: where the hip is along the body (z, from its middle) and out from
 * it (x), which way the leg points (radians round from straight ahead), how far out its foot stands, and how
 * long it is beside the others. The first and last pairs are the longest.
 */
const SPIDER_LEGS: readonly (readonly [z: number, x: number, yaw: number, reach: number, long: number])[] = [
  [1.9, 1.65, 0.5, 7.4, 1],
  [0.8, 2.1, 1.15, 7, 0.94],
  [-0.3, 2.1, 1.9, 6.6, 0.9],
  [-1.3, 1.7, 2.5, 7.6, 1.04],
];
/** A spider's walk: how far each foot goes fore and aft of where it stands, and how high it is lifted on the way forward. */
const SCUTTLE = { stride: 1.9, lift: 2.2 };

/**
 * A giant hunting spider, eyes toward +z: a low head-and-chest with a cluster of lit eyes, two fangs and two
 * feelers under them, a fat abdomen behind with a marking down its back, and eight legs, each jointed at a knee
 * held high over its body. The legs walk in two sets of four, turn about; each foot is put where it should
 * stand and the leg bent to reach it (see kneeHigh), so the body can sink, sway and lunge over planted feet.
 * `brood` is the Broodmother: a little bigger (a boss is drawn larger besides) and much heavier, spined, an
 * hourglass for its marking and a sac of eggs carried under its tail.
 */
function spider(top: THREE.Group, shell = "#24332b", dark = "#121a16", back = "#3f7d3c", mark = "#dbe6b4", glow = "#9dff5a", brood = false): Rig {
  const parts: Part[] = [];
  // Modelled at a hound's size, and drawn `k` times that: each part's meshes are scaled, and its joints set as far apart.
  const k = brood ? 1.08 : 1;
  const stout = brood ? 1.22 : 1;
  const part = (parent: THREE.Object3D, x: number, y: number, z: number) => {
    const p = (parts[parts.length] = new Part(parent, x * k, y * k, z * k));
    p.skin.scale.setScalar(k);
    return p;
  };
  /** The middle of the head-and-chest, above the ground and ahead of the figure's own middle. */
  const [cy, cz] = [4.2, 1.6];
  const chest = part(top, 0, cy, cz);
  // A low shield, widest behind its middle and blunt in front, its back coloured and the plate under it dark.
  const carapace: Span[] = [[-2.7, 1, 0.85, 0.15], [-1.9, 2.1, 1.5, 0.3], [-0.3, 2.65, 1.9, 0.4], [1.1, 2.45, 1.8, 0.3], [2.2, 1.95, 1.5, 0.15], [2.9, 1.45, 1.15, 0.05], [3.2, 0.75, 0.65, 0]];
  lengthwise(chest, shell, carapace, 10);
  hide(chest, back, carapace, 10, -2.1, 1.5, -0.8, 0.8, 0.1);
  hide(chest, dark, carapace, 10, -2.3, 0.3, -0.1, 0.1, 0.18);
  hide(chest, dark, carapace, 10, -2.2, 2.4, Math.PI - 0.8, Math.PI + 0.8, 0.1);
  // The brow the eyes sit in, and the eyes: two great ones in front, one out to each side of them, four small above.
  chest.ball(shell, 1.3, 0, 0.75, 2.05, 1, [1.2, 0.8, 1]);
  for (const s of [-1, 1]) {
    chest.glowBall(glow, 0.46, s * 0.58, 0.72, 3.12);
    chest.glowBall(glow, 0.32, s * 1.36, 0.86, 2.62);
    chest.glowBall(glow, 0.24, s * 0.5, 1.52, 2.55);
    chest.glowBall(glow, 0.22, s * 1.2, 1.42, 1.95);
  }
  // The jaws: a stout dark base hung under the eyes, and a long pale fang curving down and in from it.
  const fangs = [-1, 1].map((s) => {
    const jaw = part(chest.joint, s * 0.66, -0.3, 2.7);
    strut(jaw, dark, [0, 0.35, -0.35], [s * 0.08, -1.15, 0.85], 0.68, 0.52, 6);
    jaw.shape(GEAR.bone, [[s * 0.08 - 0.3, -1.2, 0.85], [s * 0.08 + 0.3, -1.2, 0.85], [s * 0.08, -1.2, 1.25], [s * 0.08, -1.2, 0.5], [-s * 0.3, -2.7, 0.8]]);
    return jaw;
  });
  // A feeler either side of them, held out in front and bent down at its tip.
  const feelers = [-1, 1].map((s) => {
    const p = part(chest.joint, s * 1.35, -0.35, 2.3);
    strut(p, shell, [0, 0, 0], [s * 0.55, 0.45, 1.6], 0.44, 0.38, 6);
    p.ball(dark, 0.44, s * 0.55, 0.45, 1.6);
    strut(p, dark, [s * 0.55, 0.45, 1.6], [s * 0.4, -1.2, 2.5], 0.36, 0.2, 6);
    return p;
  });
  // The abdomen, hung from the waist: far bigger than the chest, highest behind its middle, its back coloured.
  const belly = part(chest.joint, 0, 0.2, -2.5);
  const sac: Span[] = [[-8.1, 0.7, 0.65, 0.8], [-7.5, 1.8 * stout, 1.6 * stout, 1], [-6.3, 2.9 * stout, 2.6 * stout, 1.35], [-4.5, 3.5 * stout, 3.1 * stout, 1.5], [-2.5, 3.3 * stout, 2.9 * stout, 1.2], [-0.7, 2.3 * stout, 2 * stout, 0.6], [0.4, 0.9, 0.8, 0.1]];
  lengthwise(belly, shell, sac, 10);
  hide(belly, back, sac, 10, -7.3, -1, -1, 1, 0.12);
  hide(belly, dark, sac, 10, -7, -1.2, Math.PI - 0.7, Math.PI + 0.7, 0.1);
  for (const s of [-1, 1]) belly.ball(dark, 0.42, s * 0.35, 0.6, -8.15);
  /** A patch on the abdomen's back with its corners at (z, angle round): a marking. */
  const patch = (color: string, corners: [number, number][]) => {
    const z = corners.reduce((sum, c) => sum + c[0], 0) / corners.length;
    belly.shape(color, [...corners.map(([cz, a]) => onHide(sac, cz, a, 0.2)), onHide(sac, z, 0, 0.36), onHide(sac, z, 0, -0.7)]);
  };
  if (brood) {
    // An hourglass: two wedges, point to point.
    patch(mark, [[-2.3, -0.4], [-2.3, 0.4], [-4.1, -0.07], [-4.1, 0.07]]);
    patch(mark, [[-6.1, -0.44], [-6.1, 0.44], [-4.3, -0.07], [-4.3, 0.07]]);
    // A row of spines down each side of it.
    for (let i = 0; i < 6; i++) {
      const z = -1.5 - i * 1.05;
      for (const s of [-1, 1]) belly.shape(dark, [onHide(sac, z + 0.4, s * 0.8, -0.1), onHide(sac, z - 0.4, s * 0.8, -0.1), onHide(sac, z, s * 0.98, -0.1), onHide(sac, z, s * 0.62, -0.1), onHide(sac, z - 0.7, s * 0.86, 1.3 - Math.abs(i - 2) * 0.16)]);
    }
    // The eggs, bound up in silk under the tail.
    const silk = "#e9e2cf";
    belly.ball(silk, 1.55, 0, -2.5, -6.2, 1, [1.05, 0.9, 1.15]);
    belly.ball(tone(silk, -0.06), 0.8, 1, -2.2, -5, 1);
    belly.ball(tone(silk, -0.06), 0.7, -1.05, -2.3, -5.3, 1);
    belly.ball(silk, 0.65, 0.2, -2.1, -7.6, 1);
  } else {
    // Three pale diamonds down the back, each smaller than the last, a lit speck either side of each.
    ([[-2.5, 1, 0.34], [-4.6, 0.85, 0.3], [-6.3, 0.6, 0.26]] as const).forEach(([z, half, wide]) => {
      patch(mark, [[z + half, 0], [z, wide], [z - half, 0], [z, -wide]]);
      for (const s of [-1, 1]) belly.glowBall(glow, 0.24, ...onHide(sac, z, s * (wide + 0.34), 0.06));
    });
  }
  // The legs. Each is made as it stands (thigh up and out to the knee, shin out and over to a second bend and
  // down to a point), in its own frame: +z out along the ground the way it points, so it lies in y and z.
  const hipY = cy - 0.45;
  const legs = SPIDER_LEGS.flatMap(([z, x, yaw, reach, long], i) =>
    [1, -1].map((s) => {
      const [thigh, shin] = [5.4 * long, 9.4 * long];
      const [e1, e2] = kneeHigh(reach, -hipY, thigh, shin);
      const knee = [Math.sin(e1) * thigh, Math.cos(e1) * thigh];
      const foot = [-hipY - knee[0], reach - knee[1]];
      const bend = [foot[0] * 0.44 + (foot[1] / shin) * 2, foot[1] * 0.44 - (foot[0] / shin) * 2];
      const limb = tone(shell, -0.04);
      const upper = part(top, s * x, hipY, cz + z);
      upper.joint.rotation.order = "YXZ";
      strut(upper, limb, [0, 0, 0], [0, knee[0], knee[1]], 0.68 * stout, 0.5 * stout, 6);
      const lower = part(upper.joint, 0, knee[0], knee[1]);
      lower.ball(dark, 0.66 * stout, 0, 0, 0, 1);
      strut(lower, limb, [0, 0, 0], [0, bend[0], bend[1]], 0.5 * stout, 0.4 * stout, 6);
      lower.ball(dark, 0.5 * stout, 0, bend[0], bend[1], 1);
      strut(lower, dark, [0, bend[0], bend[1]], [0, foot[0], foot[1]], 0.38 * stout, 0.07, 6);
      // Where the foot stands, in the figure's space; which of the two sets of four it walks with.
      const stand = new THREE.Vector3(s * (x + Math.sin(yaw) * reach) * k, 0, (cz + z + Math.cos(yaw) * reach) * k);
      return { upper, lower, thigh: thigh * k, shin: shin * k, e1, e2, yaw: s * yaw, stand, first: (i + (s > 0 ? 0 : 1)) % 2 === 0, front: i === 0, side: s };
    }),
  );
  /** Bend a leg so its thigh and shin point `e1` and `e2` above level, the leg turned `yaw` round from straight ahead. */
  const set = (leg: (typeof legs)[number], yaw: number, e1: number, e2: number) => {
    leg.upper.joint.rotation.set(leg.e1 - e1, yaw, 0);
    leg.lower.joint.rotation.set(leg.e2 - e2 - (leg.e1 - e1), 0, 0);
  };
  const inTop = new THREE.Matrix4();
  const at = new THREE.Vector3();
  /** Each spider fidgets on its own beat. */
  const quirk = Math.random() * 20;
  /** Where the walk is in its step, -1 to 1 a quarter turn ahead of the swing: above 0 the first set of feet is in the air. */
  let gait = 0;
  let wasAt = -1;
  let wasSwing = 0;
  const animate = (a: Anim) => {
    const dt = wasAt < 0 ? 0 : Math.max(0, a.t - wasAt);
    if (dt > 0) {
      const rate = (a.swing - wasSwing) / dt;
      const want = Math.sign(rate) * Math.sqrt(Math.max(0, 1 - a.swing * a.swing)) * Math.min(1, Math.abs(rate) / 1.5);
      gait += (want - gait) * Math.min(1, dt * 25);
    }
    wasAt = a.t;
    wasSwing = a.swing;
    if (a.lying) {
      // On its back, tail down, its legs drawn up over it and curled in.
      top.rotation.set(0.12, 0, Math.PI);
      top.position.set(0, (cy + 1.7 + 3.1 * stout) * k, 0);
      chest.joint.rotation.set(0, 0, 0);
      belly.joint.rotation.set(0, 0, 0);
      legs.forEach((leg, i) => set(leg, leg.yaw + (i % 2 ? 0.16 : 0), -0.7 - (i % 3) * 0.08, -2.45 - (i % 2) * 0.14));
      fangs.forEach((jaw) => jaw.joint.rotation.set(0.25, 0, 0));
      feelers.forEach((p) => p.joint.rotation.set(0.5, 0, 0));
      return;
    }
    // The body over its feet: it rises and sinks as it breathes, rides the walk, and on a strike rears and lunges.
    top.rotation.set(-a.strike * 0.24, a.swing * 0.04, 0);
    top.position.set(Math.sin(a.t * 0.8 + quirk) * 0.14 * k, ((a.breath + 1) * 0.14 + gait * gait * 0.3 + a.strike * 0.7) * k, a.strike * 2.6 * k);
    chest.joint.rotation.set(0, 0, 0);
    belly.joint.rotation.set(a.breath * 0.035 + a.strike * 0.14, -a.swing * 0.07, 0);
    fangs.forEach((jaw, i) => jaw.joint.rotation.set(Math.sin(a.t * 2.3 + i * 2 + quirk) * 0.05 - a.strike * 1.05, 0, (i ? 1 : -1) * a.strike * 0.4));
    feelers.forEach((p, i) => p.joint.rotation.set(Math.sin(a.t * 3.1 + i * 1.7 + quirk) * 0.14 - a.strike * 0.6, 0, 0));
    top.updateMatrix();
    inTop.copy(top.matrix).invert();
    for (const leg of legs) {
      // Its foot: forward through the air and back along the ground, turn about with the other set.
      const step = leg.first ? 1 : -1;
      const lift = Math.max(0, step * gait);
      at.copy(leg.stand);
      at.z += step * a.swing * SCUTTLE.stride * k;
      at.y += lift * SCUTTLE.lift * k;
      if (leg.front) {
        // The first pair: thrown up and wide on a strike; now and then one taps the ground, standing.
        const tap = Math.max(0, Math.sin(a.t * 0.9 + quirk + leg.side) - 0.9) * 10;
        at.y += (a.strike * 9 + tap * 0.9) * k;
        at.x += leg.side * a.strike * 2 * k;
        at.z += a.strike * 2.2 * k;
      }
      at.applyMatrix4(inTop).sub(leg.upper.joint.position);
      const [e1, e2] = kneeHigh(Math.hypot(at.x, at.z), at.y, leg.thigh, leg.shin);
      set(leg, Math.atan2(at.x, at.z), e1, e2);
    }
  };
  // (No mud: slung this low, all of it would be the colour of the ground.)
  return { parts, animate, clean: true };
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
    case "sea_turtle":
      return seaTurtle(top);
    case "spider":
      return spider(top);
    case "broodmother":
      return spider(top, "#2b1d3a", "#140d1f", "#3d2857", "#e23a30", "#ff3b3b", true);
    case "frost_wolf":
      return wolf(top, "#eaf2f8", "#a9c6dc", "#a8e4ff");
    case "ember_hound":
      return wolf(top, "#34302f", "#1c1a1b", "#ff9a2e", "#ff7a1e");
    case "snow_bear":
      return bear(top, "#eef3f6", "#c9d5de", "#dbe4ea", "#1d2230", undefined, "#2b2f3a");
    case "wraith":
      return ghost(top, "#e4f6ff", "#8fc9e8", "#16384f", undefined, "#7ff1ff");
    case "drowned_cutlass":
      return skeleton(top, "cutlass");
    case "drowned_gunner":
      return skeleton(top, "pistol");
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

/** What is slung too low to show much from the side: in a portrait it is tipped toward the viewer, to show its back. */
export const SEEN_FROM_ABOVE = new Set(["spider", "broodmother"]);

/** The animals that stand side-on in a portrait, as they did in their sprites. */
export const FOUR_LEGGED = new Set(["wolf", "alpha", "bear", "great_bear", "frost_wolf", "ember_hound", "snow_bear"]);

// ---------- falling dead ----------

/** Gravity for a body falling, in the figure's units (22 to its height) a second squared: about the real thing. */
const RAG_GRAVITY = 130;
/** Steps a second the fall is worked out in, and rounds of holding each piece together per step. */
const RAG_RATE = 120;
const RAG_ROUNDS = 6;
/** How much of its sideways speed a corner on the ground keeps each step: the ground grips. */
const RAG_GRIP = 0.55;
/**
 * How hard a joint holds the angle it had at the moment of death, per round: a little, so limbs flop but do not fold
 * flat. Held harder, a beast fallen on its side kept its legs out stiff, and from above it looked to be standing.
 */
const RAG_TONE = 0.01;
/** How long a body may go on settling, and how still it must be (units a step) for long enough to call it settled. */
const RAG_MAX = 4;
const RAG_STILL = 0.004;
/**
 * Down, as far as anyone watching can tell (seconds into the fall): on the ground, though it goes on settling by
 * hairs for a while yet (too little to see, but enough that it is seldom still). A body drops its own height under
 * RAG_GRAVITY in about this long; a wolf, measured, is on the ground by 0.55.
 */
const RAG_DOWN = 0.6;
/** How fast the blow that fells it knocks its head away (units a second): enough to topple it over its feet. */
const RAG_PUSH = 40;
/**
 * Turning a body over onto its side or back as it falls: how hard (radians a second squared) and how fast at most
 * (radians a second). Its pieces are boxes, and a box stays put on any flat face: an ogre sat on the bottom of its
 * body, and a bear stood on its four legs with only its head drooping. What carries the rest is turned till it
 * lies down, and held there, from rolling on over (a bear onto its back) or back up onto its legs (a wolf), for as
 * long as it goes on settling.
 */
const RAG_TOPPLE = 30;
const RAG_TOPPLE_SPEED = 3;
/** Lying, as far as that turning goes: the edge of it that stood upright now this near level (the sine of its slope). */
const RAG_LAID_DOWN = 0.2;
/** No piece of it moves faster than this (units a second), whatever the pushing apart of pieces caught in each other asks. */
const RAG_FASTEST = 90;
/** Getting up off the ground, in seconds: the arms and legs are drawn in first, and the body rises after them. */
const RISE_LIMBS = 0.5;
const RISE_BODY_FROM = 0.15;
const RISE_BODY = 0.75;

interface RagPiece {
  part: Part;
  /** Its box's eight corners and its joint: indices into the particles. */
  corners: number[];
  /** The part its box hangs from (null: the one that carries the rest, or one hung straight from the body's top). */
  parent: RagPiece | null;
  /** Its joint's turn, relative to the figure, as it fell, and the middle of its box then. */
  q0: THREE.Quaternion;
  mid0: THREE.Vector3;
  origin0: THREE.Vector3;
  /** Its box's three edges as it fell (corner 0 to 1, 2 and 4), for working out how it has turned since. */
  frame0: THREE.Matrix4;
  depth: number;
}

/** Two particles held `length` apart, `stiff` of the way each round. */
type RagStick = [number, number, number, number];

export interface Ragdoll {
  /** Work the fall on by `dt` seconds and pose the figure to match. False once it has come to rest. */
  step(dt: number): boolean;
  /** Down on the ground and lying still (or given up waiting for it to be), though it may twitch on a little. */
  down(): boolean;
  /** Put every joint back as it was when it fell (for one got up again). */
  restore(): void;
}

const _rq = new THREE.Quaternion();
const _rm = new THREE.Matrix4();
const _rv = new THREE.Vector3();
const _rx = new THREE.Vector3();
const _ry = new THREE.Vector3();
const _rz = new THREE.Vector3();

/** A frame (a turn) from three edges of a box: the first as it is, the second squared to it, the third across both. */
function frameOf(p: Float32Array, c: number[], out: THREE.Matrix4) {
  const at = (i: number, v: THREE.Vector3) => v.set(p[c[i] * 3], p[c[i] * 3 + 1], p[c[i] * 3 + 2]);
  const o = at(0, _rv);
  at(1, _rx).sub(o).normalize();
  at(2, _ry).sub(o);
  _ry.addScaledVector(_rx, -_ry.dot(_rx)).normalize();
  _rz.crossVectors(_rx, _ry);
  return out.makeBasis(_rx, _ry, _rz);
}

/**
 * Let a figure go limp and fall: each part of it a solid box of eight particles, each joint a particle held to
 * the boxes either side of it, all of them dropped under gravity onto the ground under its feet (y = 0 in the
 * figure's own space) and pushed `push` (in that space, along the ground) by the blow that felled it. Each frame
 * the boxes are read back as turns of the joints, so whatever the rig is (a man, a wolf, a slime), it crumples
 * as it is jointed.
 */
function ragdoll(top: THREE.Group, parts: Part[], push: THREE.Vector3): Ragdoll {
  const scaler = top.parent!;
  scaler.updateWorldMatrix(true, true);
  const toFigure = new THREE.Matrix4().copy(scaler.matrixWorld).invert();
  const figureQ = new THREE.Quaternion();
  scaler.getWorldQuaternion(figureQ);
  const fromFigure = figureQ.clone().invert();
  const byJoint = new Map(parts.map((p) => [p.joint as THREE.Object3D, p]));
  const saved = new Map<THREE.Object3D, THREE.Quaternion>(parts.map((p) => [p.joint, p.joint.quaternion.clone()]));
  saved.set(top, top.quaternion.clone());
  const savedTop = top.position.clone();

  const pos: number[] = [];
  const sticks: RagStick[] = [];
  const add = (v: THREE.Vector3) => (pos.push(v.x, v.y, v.z), pos.length / 3 - 1);
  const dist = (a: number, b: number) => Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]);
  const stick = (a: number, b: number, stiff = 1) => sticks.push([a, b, dist(a, b), stiff]);

  // Each part's box, in the figure's space as it stands now.
  const pieces: RagPiece[] = [];
  const box = new THREE.Box3();
  const piece = new THREE.Box3();
  for (const part of parts) {
    box.makeEmpty();
    part.skin.updateMatrix();
    for (const o of part.skin.children) {
      if (!(o instanceof THREE.Mesh) || !o.userData.body) continue;
      o.geometry.computeBoundingBox();
      box.union(piece.copy(o.geometry.boundingBox!).applyMatrix4(part.skin.matrix));
    }
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
    // Nothing quite flat, so its box always has a turn to read back.
    const size = box.getSize(new THREE.Vector3()).max(new THREE.Vector3(0.8, 0.8, 0.8));
    box.setFromCenterAndSize(box.getCenter(new THREE.Vector3()), size);
    const m = _rm.multiplyMatrices(toFigure, part.joint.matrixWorld);
    const corners: number[] = [];
    for (let i = 0; i < 8; i++) {
      const c = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      corners.push(add(c.applyMatrix4(m)));
    }
    corners.push(add(new THREE.Vector3().setFromMatrixPosition(m)));
    for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) stick(corners[a], corners[b]);
    const q0 = new THREE.Quaternion();
    part.joint.getWorldQuaternion(q0).premultiply(fromFigure);
    let depth = 0;
    for (let o = part.joint.parent; o && o !== top; o = o.parent) depth++;
    pieces.push({ part, corners, parent: null, q0, mid0: box.getCenter(new THREE.Vector3()).applyMatrix4(m), origin0: new THREE.Vector3().setFromMatrixPosition(m), frame0: new THREE.Matrix4(), depth });
  }
  if (pieces.length === 0) return { step: () => false, down: () => true, restore() {} };
  const atStart = new Float32Array(pos);
  for (const p of pieces) frameOf(atStart, p.corners, p.frame0);
  // What carries the rest: the biggest part hung straight from the top (a body, a torso).
  const volume = (p: RagPiece) => dist(p.corners[0], p.corners[1]) * dist(p.corners[0], p.corners[2]) * dist(p.corners[0], p.corners[4]);
  const roots = pieces.filter((p) => p.depth === 0);
  const main = (roots.length > 0 ? roots : pieces).reduce((a, b) => (volume(b) > volume(a) ? b : a));
  // Each joint held to the box above it (a part hung from the top, to the main one's), and a little to the angle it had.
  for (const p of pieces) {
    if (p === main) continue;
    let up: THREE.Object3D | null = p.part.joint.parent;
    while (up && up !== top && !byJoint.has(up)) up = up.parent;
    const parentPart = up && up !== top ? byJoint.get(up)! : main.part;
    p.parent = pieces.find((q) => q.part === parentPart) ?? main;
    const joint = p.corners[8];
    for (let i = 0; i < 8; i++) stick(joint, p.parent.corners[i]);
    stick(p.corners[0], p.parent.corners[7], RAG_TONE);
    stick(p.corners[7], p.parent.corners[0], RAG_TONE);
  }
  // The joint particle is carried on its own box too.
  for (const p of pieces) for (let i = 0; i < 8; i++) stick(p.corners[8], p.corners[i]);

  // What carries the rest is turned over till the edge of its box that stood upright lies along the ground: a body
  // onto its back or its front, a beast onto its side. It rolls about its longest edge along the ground (across
  // the shoulders, a beast's length), the way the blow knocks it, and either way for a blow head on to that; one
  // no wider one way than the other (a post) falls the way it was knocked. One squat already (a slime, a turtle)
  // is left be.
  const edgeAt = (p: ArrayLike<number>, k: number, out: THREE.Vector3) => {
    const a = main.corners[0];
    const b = main.corners[k];
    return out.set(p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]);
  };
  const edges = [1, 2, 4].map((k) => {
    const v = edgeAt(pos, k, new THREE.Vector3());
    return { k, length: v.length(), dir: v.normalize() };
  });
  const upright = edges.reduce((a, b) => (Math.abs(b.dir.y) > Math.abs(a.dir.y) ? b : a));
  const [e1, e2] = edges.filter((e) => e !== upright);
  const along = new THREE.Vector3(push.x, 0, push.z).normalize();
  // The way the top of it goes: across its long edge, to the side the blow knocks it.
  const fallTo = new THREE.Vector3();
  if (Math.max(e1.length, e2.length) < Math.min(e1.length, e2.length) * 1.25) fallTo.copy(along);
  else {
    const long = e1.length > e2.length ? e1 : e2;
    fallTo.set(long.dir.x, 0, long.dir.z).cross(_ry.set(0, 1, 0)).normalize();
    const knocked = fallTo.dot(along);
    if (knocked < 0 || (Math.abs(knocked) < 0.2 && Math.random() < 0.5)) fallTo.negate();
  }
  const toppling = upright.length >= Math.min(e1.length, e2.length) * 0.9 && Math.abs(upright.dir.y) > RAG_LAID_DOWN;
  // Turning about this, the top of it goes toward `fallTo`.
  const axis = new THREE.Vector3().crossVectors(_ry.set(0, 1, 0), fallTo).normalize();
  const mid = new THREE.Vector3();
  const n = pos.length / 3;
  // Nothing starts under the ground (a foot drawn a little into it, or one already lying), or it would be thrown out of it.
  let low = 0;
  for (let i = 0; i < n; i++) low = Math.min(low, pos[i * 3 + 1]);
  for (let i = 0; i < n; i++) pos[i * 3 + 1] -= low;
  const now = new Float32Array(pos);
  const was = new Float32Array(pos);
  // Knocked away from the blow, the higher the harder, so it topples over its feet; and a little up.
  const h = 1 / RAG_RATE;
  // Turned over, it is knocked the way it turns, or the two together lay it on an edge (a post on its crosspiece).
  const kick = toppling ? fallTo.clone().multiplyScalar(push.length()) : push;
  for (let i = 0; i < n; i++) {
    const lift = Math.max(0, now[i * 3 + 1]) / FRAME;
    was[i * 3] -= kick.x * lift * h;
    was[i * 3 + 1] -= 6 * lift * h;
    was[i * 3 + 2] -= kick.z * lift * h;
  }
  const order = [...pieces].sort((a, b) => a.depth - b.depth);
  // Where the main joint is in the top's space, and how it is turned there (undone): the top is carried by it.
  top.updateWorldMatrix(true, true);
  const mainAt = new THREE.Vector3().setFromMatrixPosition(_rm.copy(top.matrixWorld).invert().multiply(main.part.joint.matrixWorld));
  const topQ0 = new THREE.Quaternion();
  top.getWorldQuaternion(topQ0).premultiply(fromFigure);
  const mainQ0 = main.q0.clone();
  const mainInTop = topQ0.clone().invert().multiply(main.q0).invert();
  let time = 0;
  let spare = 0;
  let still = 0;

  const solve = () => {
    const keep = 0.998;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        const j = i * 3 + k;
        const v = Math.max(-RAG_FASTEST * h, Math.min(RAG_FASTEST * h, (now[j] - was[j]) * keep));
        was[j] = now[j];
        now[j] += v;
      }
      now[i * 3 + 1] -= RAG_GRAVITY * h * h;
    }
    // Turning it over: the whole of it pushed round its middle, as one piece, till what carries the rest lies, and
    // then slowed to a stop there. How fast it turns now is read off how all of it moves round the middle.
    if (toppling) {
      mid.set(0, 0, 0);
      for (let i = 0; i < n; i++) (mid.x += now[i * 3]), (mid.y += now[i * 3 + 1]), (mid.z += now[i * 3 + 2]);
      mid.divideScalar(n);
      let spin = 0;
      let reach = 0;
      for (let i = 0; i < n; i++) {
        _rx.set(now[i * 3] - mid.x, now[i * 3 + 1] - mid.y, now[i * 3 + 2] - mid.z);
        _rx.addScaledVector(axis, -_rx.dot(axis));
        _ry.set(now[i * 3] - was[i * 3], now[i * 3 + 1] - was[i * 3 + 1], now[i * 3 + 2] - was[i * 3 + 2]);
        spin += _rz.crossVectors(_rx, _ry).dot(axis);
        reach += _rx.lengthSq();
      }
      spin /= h * (reach || 1);
      const lying = Math.abs(edgeAt(now, upright.k, _rv).normalize().y) <= RAG_LAID_DOWN;
      const want = lying ? 0 : RAG_TOPPLE_SPEED;
      const more = Math.max(-RAG_TOPPLE * h, Math.min(RAG_TOPPLE * h, want - spin));
      // Only ever toward lying: never slowed while it is still getting there, nor turned back once it is past.
      if (lying ? more < 0 && spin > 0 : more > 0) {
        for (let i = 0; i < n; i++) {
          _rx.set(now[i * 3] - mid.x, now[i * 3 + 1] - mid.y, now[i * 3 + 2] - mid.z);
          _rz.crossVectors(axis, _rx).multiplyScalar(more * h);
          now[i * 3] += _rz.x;
          now[i * 3 + 1] += _rz.y;
          now[i * 3 + 2] += _rz.z;
        }
      }
    }
    for (let round = 0; round < RAG_ROUNDS; round++) {
      for (const [a, b, length, stiff] of sticks) {
        const dx = now[b * 3] - now[a * 3];
        const dy = now[b * 3 + 1] - now[a * 3 + 1];
        const dz = now[b * 3 + 2] - now[a * 3 + 2];
        const d = Math.hypot(dx, dy, dz) || 1e-6;
        const k = ((d - length) / d) * 0.5 * stiff;
        now[a * 3] += dx * k;
        now[a * 3 + 1] += dy * k;
        now[a * 3 + 2] += dz * k;
        now[b * 3] -= dx * k;
        now[b * 3 + 1] -= dy * k;
        now[b * 3 + 2] -= dz * k;
      }
      // The ground: nothing goes under it, and what touches it is held back by it.
      for (let i = 0; i < n; i++) {
        if (now[i * 3 + 1] >= 0) continue;
        now[i * 3 + 1] = 0;
        // Stopped dead on it: being pushed up out of it (a foot drawn a little into the ground) is no leap.
        was[i * 3 + 1] = 0;
        was[i * 3] = now[i * 3] - (now[i * 3] - was[i * 3]) * RAG_GRIP;
        was[i * 3 + 2] = now[i * 3 + 2] - (now[i * 3 + 2] - was[i * 3 + 2]) * RAG_GRIP;
      }
    }
    let most = 0;
    for (let j = 0; j < now.length; j++) most = Math.max(most, Math.abs(now[j] - was[j]));
    return most;
  };

  const turned = new THREE.Matrix4();
  const parentQ = new THREE.Quaternion();
  /** Read the boxes back as the figure's pose: the top carried with the main box, every other joint turned with its own. */
  const pose = () => {
    const rel = (p: RagPiece) => {
      frameOf(now, p.corners, turned);
      return _rq.setFromRotationMatrix(turned.multiply(_rm.copy(p.frame0).transpose()));
    };
    // The top: turned as the main box has, and placed so the main joint lands where its particle is.
    top.quaternion.copy(rel(main)).multiply(mainQ0).multiply(mainInTop);
    const j = main.corners[8];
    top.position.set(now[j * 3], now[j * 3 + 1], now[j * 3 + 2]).sub(_rv.copy(mainAt).applyQuaternion(top.quaternion));
    top.updateMatrixWorld(true);
    for (const p of order) {
      if (p === main) continue;
      const want = rel(p).multiply(p.q0);
      p.part.joint.parent!.getWorldQuaternion(parentQ).premultiply(fromFigure);
      p.part.joint.quaternion.copy(parentQ.invert().multiply(want));
      p.part.joint.updateMatrixWorld(true);
    }
  };

  return {
    step(dt) {
      if (time >= RAG_MAX) return false;
      spare += Math.min(dt, 0.1);
      while (spare >= h) {
        spare -= h;
        time += h;
        still = solve() < RAG_STILL ? still + h : 0;
      }
      pose();
      return still < 0.5 && time < RAG_MAX;
    },
    down: () => time >= RAG_DOWN || still >= 0.5,
    restore() {
      for (const [joint, q] of saved) joint.quaternion.copy(q);
      top.position.copy(savedTop);
    },
  };
}

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
  /**
   * Shoot the bow carried: the figure draws and looses it. Returns the seconds until the arrow leaves the string,
   * for whatever throws the arrow to wait; 0 for a figure with no bow in hand, which does nothing.
   */
  loose(): number;
  /**
   * Strike a blow. "light" is the ordinary one for what is in hand: a cut, with a dagger a leap and a stab
   * downward, with a rapier a straight thrust. "stab" is that thrust at arm's length, with whatever is held. "heavy" is a great two-handed sweep from side to side, or with a weapon
   * in each hand both tossed up, caught points down and jabbed downward. A person, a giant
   * or a skeleton winds up and steps in first, and this returns the seconds until the blow lands, for whatever
   * it hits to wait; a creature lunges at once, as it always did, and this returns 0.
   */
  strike(how?: "light" | "stab" | "heavy"): number;
  /**
   * Cast a spell, or throw something: the casting hand swings round overhead and comes down to point at the mark.
   * Returns the seconds until it points, which is when what is cast should leave; 0 for a creature, which only
   * leans into it. Asked again while one is under way, it does not start over: it returns what is left of the
   * wait, or (already pointing) holds the point and returns 0, so a run of bolts leaves one hand.
   */
  cast(): number;
  /**
   * Play the instrument carried, for a song: a lute is strummed, a flute lifted to the mouth, a bell rung, and notes rise from
   * it. Returns the seconds until the song takes hold, for what it does to wait; 0 for a figure with no instrument,
   * which does nothing. Asked again mid-song, it plays on and returns what is left of the wait.
   */
  play(): number;
  /**
   * Fire the gun or crossbow carried: a pistol is levelled at arm's length, a long one brought to the shoulder,
   * and it goes off with a kick (and, a powder gun, a flash and smoke). Returns the seconds until it goes off, for
   * what it shoots to wait; 0 for a figure with neither, which does nothing.
   */
  fire(): number;
  /**
   * Brace behind a guard: knees bent, a shield brought up before the body (or, with none, what is in hand and the
   * other forearm). Returns the seconds until the guard is up; 0 for a creature, which does nothing.
   */
  guard(): number;
  /**
   * Bellow a challenge (Taunt): drawn back for breath, then the chest thrown out and the arms flung wide, roaring.
   * Returns the seconds until the roar; 0 for a creature, which does nothing.
   */
  taunt(): number;
  /**
   * Work at a trade: `hammer` brings a hammer down on an anvil before the figure, and returns the seconds until it
   * lands, for the sparks and the ring of it to wait; `stir` stirs a pot before it, round and round for half a
   * minute, and returns 0. A creature does nothing and returns 0.
   */
  work(how: "hammer" | "stir"): number;
  /** Take a blow: the figure flinches from it. */
  hit(): void;
  /**
   * Jump, `air` seconds off the ground: a crouch, a spring with the arms thrown up, the knees drawn up over the top
   * and the feet put out to land, then a deep crouch on landing. The figure stays on its origin: whoever asks
   * carries it through the air. Returns the seconds until the feet leave the ground, for that to wait; 0 for a
   * creature, which only leans into it.
   */
  jump(air: number): number;
  /**
   * Go limp and fall where it stands (a ragdoll), knocked along `push` (in the world, along the ground: away from
   * the blow) or, without one, any way. It lies as it fell for as long as it is posed lying; stood up again, it
   * gets up from how it lay (as from any lying down) and takes its usual poses. `onDown` runs once it is down and
   * lying still (at once if it has already fallen, or is got up again first).
   */
  fall(push?: THREE.Vector3, onDown?: () => void): void;
  /** Greyed, for someone down in a fight. */
  setDim(on: boolean): void;
  /** How much of it is left to see, 1 (all there) to 0 (gone): it thins out pixel by pixel as a camera passes through it. */
  setFade(left: number): void;
  /**
   * Show the figure through a tree or a wall it stands behind, as a flat shape of this colour (see silhouette.ts);
   * null stops. Only in a scene drawn with a stencil buffer and with what hides drawn first. Not while it is faded.
   */
  setSilhouette(color: string | null): void;
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
  /** A townsperson's own name or id, which picks their face (see faceFor); without one, their kind picks it. */
  face?: string;
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
  tier = TIER.body;
  const extras: { dispose(): void }[] = (spare = []);
  rodInHand = opts.rod ?? false;
  extraParts = [];
  braids = [];
  dangles = [];
  spinners = [];
  flickers = [];
  bodyParts = [];
  beardFront = null;
  castEyes = [];
  skirts = [];
  figureKind = kind;
  castPace = 1;
  slung = null;
  chosen = outfit?.appearance ?? null;
  lowPoly = !!chosen || !!opts.lowPoly || !BLOCKY_PREF;
  m = lowPoly ? measuresOf(chosen) : USUAL;
  // A hero's own colouring over their class's; a townsperson's own face, and a villager's own colouring.
  if (chosen) look = { ...look, skin: chosen.skin, hair: chosen.hair };
  face = !chosen && TOWNSFOLK.test(kind) ? faceFor(opts.face ?? kind, kind === "npc") : null;
  if (face?.skin && face.hair) look = { ...look, skin: face.skin, hair: face.hair };
  const rig = rigFor(kind, top, look, outfit, !!opts.asleep);
  const fade = { value: 1 };
  const mats: Mats = {
    body: fadeable(bodyMaterial(), fade, "gq-figure-body"),
    outline: fadeable(new THREE.MeshBasicMaterial({ color: OUTLINE, side: THREE.BackSide }), fade, "gq-figure-line"),
    glow: fadeable(new THREE.MeshBasicMaterial({ vertexColors: true }), fade, "gq-figure-glow"),
    ink: fadeable(inkMaterial(), fade, "gq-figure-ink"),
  };
  const made: THREE.BufferGeometry[] = [];
  const allParts = [...rig.parts, ...extraParts];
  for (const part of allParts) part.build(mats, made);
  const swinging = braids;
  const loose = dangles;
  const turners = spinners;
  const flashers = flickers;
  const spellEyes = castEyes;
  const hems = skirts;
  const pace = castPace;
  /** How long an action of this kind takes this figure. */
  const lasts = (kind: Act["kind"]) => ACT_OVER[kind] * (kind === "cast" ? pace : 1);
  // What a swinging weight bumps against: only worth fitting for someone carrying one.
  const body = loose.length > 0 ? bodyCapsules(bodyParts) : [];
  const sling = slung;
  if (!rig.clean) muddy(scaler, mats.body);
  // Each figure breathes on its own beat.
  const beat = Math.random() * 6;
  let swing = 0;
  let last = -1;
  /** Whether what the hands hold is put away (at the oars). */
  let heldAway = false;
  /** The strike or hit asked for (it begins on the next frame), the one under way, and how many there have been. */
  let asked: Act["kind"] | null = null;
  let action: { kind: Act["kind"]; at: number; n: number; air: number } | null = null;
  /** How long the jump asked for is off the ground. */
  let airtime = 0;
  /** Its shape seen through trees and walls, made the first time it is asked for, and the colour asked for. */
  let through: Silhouette | null = null;
  let throughColor: string | null = null;
  let actions = 0;
  /** Fallen dead: the fall under way (or come to rest), which poses it in place of the rig while it lies. */
  let fallen: { doll: Ragdoll; moving: boolean; onDown?: () => void } | null = null;
  /** Told the one fallen is down (fall's onDown), once: it may be got up again before it is. */
  const landed = () => {
    const told = fallen?.onDown;
    if (fallen) fallen.onDown = undefined;
    told?.();
  };
  /** Lying the frame before, to see it get up. */
  let wasLying = false;
  /** A pose: every joint's turn (the top first), and where the top is. */
  type Held = { turns: THREE.Quaternion[]; place: THREE.Vector3 };
  /**
   * Getting up, from `at` on the render clock: from how it lay, through each of the rig's stages of getting up (see
   * GetUp), to the pose the rig gives each frame; a rig with none eases straight there. `posed` is that last pose
   * as the rig gave it the frame before, put back before the rig poses it again: a rig sets only some of a joint's
   * turn (a leg swung forward and back), and would otherwise build on the blend, keeping the twist of how the body
   * lay (legs crossed when it stood).
   */
  let rising: { at: number; from: Held; stages: Held[]; posed: Held } | null = null;
  const risers: THREE.Object3D[] = [top, ...allParts.map((part) => part.joint)];
  const ease = (k: number) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));
  const hold = (): Held => ({ turns: risers.map((o) => o.quaternion.clone()), place: top.position.clone() });
  const put = (pose: Held) => {
    risers.forEach((o, i) => o.quaternion.copy(pose.turns[i]));
    top.position.copy(pose.place);
  };
  /**
   * Lay the stages of getting up (posed facing forward, where it stands) along the ground the way the body lies,
   * from where it lies: the first turned about upright so its head points the way the head lay, and getting into it
   * is a roll about the length of the body (not a somersault up through standing and over onto the face). Each stage
   * after turns and comes back to where it stands by its share (see GET_UP_TURNED), and the last of them up onto
   * the feet the rest of the way.
   */
  const turnToLie = (from: Held, stages: Held[]) => {
    const upright = new THREE.Vector3(0, 1, 0);
    const turn = new THREE.Quaternion();
    // Which way the head is, in the body's own frame: what points ahead along the ground in the first stage.
    const headward = new THREE.Vector3(0, 0, 1).applyQuaternion(stages[0].turns[0].clone().invert());
    const lay = headward.applyQuaternion(from.turns[0]);
    const best = Math.hypot(lay.x, lay.z) > 0.2 ? Math.atan2(lay.x, lay.z) : 0;
    const shift = from.place.clone().sub(stages[0].place.clone().applyAxisAngle(upright, best));
    shift.y = 0;
    rig.getUp!.forEach((stage, i) => {
      const left = 1 - GET_UP_TURNED[stage];
      stages[i].turns[0].premultiply(turn.setFromAxisAngle(upright, best * left));
      stages[i].place.applyAxisAngle(upright, best * left).addScaledVector(shift, left);
    });
  };
  const update = (p: FigurePose) => {
    const first = last < 0;
    const dt = last < 0 ? 1 : Math.min(0.1, Math.max(0, p.time - last));
    last = p.time;
    if (asked) [action, asked] = [{ kind: asked, at: p.time, n: ++actions, air: asked === "jump" ? airtime : 0 }, null];
    const since = action ? p.time - action.at : 0;
    if (action && (since < 0 || since >= lasts(action.kind) + action.air)) action = null;
    const want = p.walking ? Math.sin(p.stride * 3.6) : 0;
    swing += (want - swing) * Math.min(1, dt * 20);
    const rowing = p.rowing !== undefined && !!rig.hands && !p.lying;
    const anim: Anim = { t: p.time, swing, breath: Math.sin(p.time * 2.2 + beat), strike: Math.min(1, Math.abs(p.lean) * 2), act: action && rig.acts ? { kind: action.kind, t: action.kind === "cast" ? since / pace : since, n: action.n, air: action.air } : null, scale: 1 / scaler.scale.x, lying: p.lying, sitting: rowing ? 1 : typeof p.sitting === "number" ? Math.max(0, Math.min(1, p.sitting)) : p.sitting ? 1 : 0, oars: rowing ? Math.max(0, Math.min(1, p.rowing!)) : -1, getUp: null };
    // A rig with no animations of its own is leant into a blow, and a little into a hit, easing off as it always has.
    if (action && !rig.acts) anim.strike = Math.max(anim.strike, Math.min(1, (action.kind === "hit" ? 0.5 : 1.8) * Math.exp(-8 * since)));
    if (sling) stow(sling, p.walking, Math.max(anim.strike, anim.act && anim.act.kind !== "hit" ? 1 : 0), dt);
    // At the oars, whatever was in hand is laid down in the boat; it is back in hand once they step ashore.
    if (rig.hands && rowing !== heldAway) {
      heldAway = rowing;
      for (const hand of rig.hands) for (const held of hand.children) held.visible = !rowing;
      for (const thing of rig.carried ?? []) thing.visible = !rowing;
    }
    // Up off the ground (from a fall, or from lying down): it gets up from how it lay, not all at once.
    if (wasLying && !p.lying && !first) {
      const from = hold();
      if (fallen) {
        landed();
        fallen.doll.restore();
        fallen = null;
      }
      const posed = hold();
      const stages = (rig.getUp ?? []).map((stage) => {
        rig.animate({ ...anim, act: null, strike: 0, swing: 0, getUp: stage });
        return hold();
      });
      if (stages.length > 0) turnToLie(from, stages);
      put(posed);
      rising = { at: p.time, from, stages, posed };
    }
    if (p.lying) rising = null;
    wasLying = p.lying;
    if (fallen && !p.lying) {
      landed();
      fallen.doll.restore();
      fallen = null;
    }
    if (fallen) {
      if (fallen.moving) fallen.moving = fallen.doll.step(first ? 0 : dt);
      if (!fallen.moving || fallen.doll.down()) landed();
    } else {
      if (rising) put(rising.posed);
      rig.animate(anim);
    }
    if (rising) {
      risers.forEach((o, i) => rising!.posed.turns[i].copy(o.quaternion));
      rising.posed.place.copy(top.position);
      const since = p.time - rising.at;
      if (rising.stages.length === 0) {
        // Arms and legs drawn in first, the body rising after them.
        const limbs = ease(since / RISE_LIMBS);
        const rise = ease((since - RISE_BODY_FROM) / RISE_BODY);
        risers.forEach((o, i) => o.quaternion.slerpQuaternions(rising!.from.turns[i], _rq.copy(o.quaternion), o === top ? rise : limbs));
        top.position.lerpVectors(rising.from.place, _rv.copy(top.position), rise);
        if (since >= RISE_BODY_FROM + RISE_BODY) rising = null;
      } else {
        // From one stage to the next, and from the last up onto the feet.
        const times = [...rig.getUp!.map((stage) => GET_UP_TIME[stage]), GET_UP_TIME.stand];
        let stage = 0;
        let into = since;
        while (stage < times.length - 1 && into >= times[stage]) into -= times[stage++];
        const k = ease(into / times[stage]);
        const was = stage === 0 ? rising.from : rising.stages[stage - 1];
        const next = stage < rising.stages.length ? rising.stages[stage] : null;
        risers.forEach((o, i) => o.quaternion.slerpQuaternions(was.turns[i], next ? next.turns[i] : _rq.copy(o.quaternion), k));
        top.position.lerpVectors(was.place, next ? next.place : _rv.copy(top.position), k);
        if (stage === times.length - 1 && into >= times[stage]) rising = null;
      }
    }
    if (swinging.length > 0) swingBraids(swinging, anim);
    if (loose.length > 0) swingDangles(loose, first ? 0 : dt, top, body);
    if (turners.length > 0) turnSpinners(turners, first ? 0 : dt);
    if (flashers.length > 0) flashBolts(flashers, p.time);
    // A long coat's skirts swing with the legs under them, forward and back and out to the side.
    for (const h of hems) {
      h.joint.rotation.set(h.thigh.rotation.x * SKIRT_FOLLOW, 0, h.thigh.rotation.z * SKIRT_FOLLOW);
      h.fold.rotation.x = h.shin.rotation.x * FOLD_FOLLOW;
    }
    if (spellEyes.length > 0) {
      // Eyes that light with a spell: swelling up as it gathers, brightest as it leaves, and out again after.
      const t = anim.act?.kind === "cast" ? anim.act.t / CAST.over : -1;
      const k = t < 0 || t >= 1 ? 0 : Math.sin(Math.PI * Math.min(1, t * 1.25));
      for (const eye of spellEyes) {
        eye.visible = k > 0.02;
        eye.scale.setScalar(Math.max(0.01, k));
      }
    }
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
    loose: () => rig.loose?.() ?? 0,
    strike(how = "light") {
      const kind = how === "heavy" ? (rig.twin ? "twin" : "heavy") : how === "stab" ? "stab" : (rig.light ?? "strike");
      asked = kind;
      return rig.acts ? ACT_HIT[kind] : 0;
    },
    work(how) {
      if (!rig.acts) return 0;
      asked = how;
      return how === "hammer" ? HAMMER.hit : 0;
    },
    cast() {
      if (rig.acts && action?.kind === "cast" && !asked) {
        const since = last - action.at;
        if (since < CAST.emit * pace) return CAST.emit * pace - since;
        if (since < (CAST.over - 0.25) * pace) {
          action.at = last - CAST.emit * pace;
          return 0;
        }
      }
      asked = "cast";
      return rig.acts ? CAST.emit * pace : 0;
    },
    play() {
      if (!rig.plays) return 0;
      if (action?.kind === "play" && !asked) {
        const since = last - action.at;
        if (since < PLAY.emit) return PLAY.emit - since;
        // Mid-song: play on from where the song took hold.
        action.at = last - PLAY.emit;
        return 0;
      }
      asked = "play";
      return PLAY.emit;
    },
    fire() {
      if (!rig.fires) return 0;
      asked = "fire";
      return (rig.long ? FIRE.long : FIRE.hand).shot;
    },
    guard() {
      if (!rig.acts) return 0;
      asked = "guard";
      return GUARD.hold;
    },
    taunt() {
      if (!rig.acts) return 0;
      asked = "taunt";
      return TAUNT.roar;
    },
    hit() {
      asked = "hit";
    },
    jump(air) {
      asked = "jump";
      airtime = Math.max(0.1, air);
      return rig.acts ? JUMP.spring : 0;
    },
    fall(push, onDown) {
      if (fallen) return onDown?.();
      // Into the figure's own space, along the ground; a blow from nowhere in particular knocks it any way.
      const dir = push ? push.clone() : new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5);
      dir.applyQuaternion(scaler.getWorldQuaternion(new THREE.Quaternion()).invert());
      dir.y = 0;
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
      dir.setLength(RAG_PUSH);
      fallen = { doll: ragdoll(top, allParts, dir), moving: true, onDown };
    },
    setDim(on) {
      mats.body.color.setScalar(on ? 0.5 : 1);
      mats.glow.color.setScalar(on ? 0.4 : 1);
      mats.ink.color.setScalar(on ? 0.5 : 1);
    },
    setFade(left) {
      const was = fade.value;
      fade.value = Math.max(0, Math.min(1, left));
      root.visible = fade.value > 0;
      // Thinned away for a camera passing through it, it is not then drawn solid through a wall.
      if (through && fade.value < 1 !== was < 1) through.show(fade.value < 1 ? null : throughColor);
    },
    setSilhouette(color) {
      if (color === throughColor) return;
      throughColor = color;
      if (!through) {
        if (!color) return;
        const bodies: THREE.Mesh[] = [];
        top.traverse((o) => {
          if (o instanceof THREE.Mesh && o.userData.body) bodies.push(o);
        });
        through = makeSilhouette(bodies);
      }
      through.show(fade.value < 1 ? null : color);
    },
    dispose() {
      through?.dispose();
      for (const g of made) g.dispose();
      for (const thing of extras) thing.dispose();
      mats.body.dispose();
      mats.outline.dispose();
      mats.glow.dispose();
      mats.ink.dispose();
    },
  };
}
