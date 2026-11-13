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
import { RARITY_COLOR, WEAPONS, type Outfit, type Slot } from "@gantt-quest/world";
import type { Look } from "./looks";

const OUTLINE = "#1b1830";
/** Set by makeFigure for the figure being built: a fishing rod goes in its right hand. */
let rodInHand = false;
const GEAR = { steel: "#c9d1dc", shine: "#f1f5fa", iron: "#8b95a5", wood: "#8a5a2b", leather: "#a0683a", gold: "#e0b12e", paper: "#e8dcc0", bone: "#eee6cf", dark: "#2a2740" };
/** The frame a figure is modelled in, in model units: `setSize(1)` makes this one world unit tall. */
const FRAME = 22;

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

interface Mats {
  body: THREE.MeshLambertMaterial;
  outline: THREE.MeshBasicMaterial;
  glow: THREE.MeshBasicMaterial;
}

/** One jointed part: primitives gathered in the joint's own space, then merged into a mesh or three. */
class Part {
  readonly joint = new THREE.Group();
  private solid: THREE.BufferGeometry[] = [];
  private hull: THREE.BufferGeometry[] = [];
  private lit: THREE.BufferGeometry[] = [];

  constructor(parent: THREE.Object3D, x = 0, y = 0, z = 0) {
    this.joint.position.set(x, y, z);
    parent.add(this.joint);
  }

  /** `geometry` is centred on its own origin; `glow` draws it unlit, with no outline. */
  private add(geometry: THREE.BufferGeometry, color: string, x: number, y: number, z: number, rot?: Rot, glow = false): this {
    const at = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(...(rot ?? [0, 0, 0]))), ONE);
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    if (flat !== geometry) geometry.dispose();
    flat.deleteAttribute("uv");
    if (!glow) {
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

  /** A box centred on (x, y, z). */
  box(color: string, w: number, h: number, d: number, x = 0, y = 0, z = 0, rot?: Rot): this {
    return this.add(new THREE.BoxGeometry(w, h, d), color, x, y, z, rot);
  }

  /** An upright cylinder (or tapered post) centred on (x, y, z). */
  cyl(color: string, top: number, bottom: number, h: number, x = 0, y = 0, z = 0, sides = 6, rot?: Rot): this {
    return this.add(new THREE.CylinderGeometry(top, bottom, h, sides), color, x, y, z, rot);
  }

  cone(color: string, radius: number, h: number, x = 0, y = 0, z = 0, sides = 4, rot?: Rot): this {
    return this.add(new THREE.ConeGeometry(radius, h, sides), color, x, y, z, rot);
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
      // It throws a shadow but takes none: at this size, its own hat's shadow across its face is only noise.
      mesh.castShadow = true;
      this.joint.add(mesh, new THREE.Mesh(merged(this.hull), mats.outline));
    }
    if (this.lit.length > 0) {
      const mesh = new THREE.Mesh(merged(this.lit), mats.glow);
      mesh.userData.selfLit = true;
      this.joint.add(mesh);
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
  const torso = part(top, 0, 5, 0);
  const head = part(torso.joint, 0, 6, 0);
  const armR = part(torso.joint, -4.5, 5.5, 0);
  const armL = part(torso.joint, 4.5, 5.5, 0);
  const legR = part(top, -1.7, 5, 0);
  const legL = part(top, 1.7, 5, 0);
  // What each hand holds, kept upright while the arm hangs forward.
  const heldR = part(armR.joint, 0, -5, 0);
  const heldL = part(armL.joint, 0, -5, 0);
  /** How far forward each arm rests, and how what it holds is tipped. */
  const rest = { armR: -0.15, armL: -0.05, tiltR: 0, tiltL: 0 };
  const animate = (a: Anim) => {
    heldR.joint.rotation.x = -rest.armR + rest.tiltR;
    heldL.joint.rotation.x = -rest.armL + rest.tiltL;
    if (a.lying) {
      // On their back, the head toward -z, centred on where they stood.
      top.rotation.set(-HALF_PI, 0, 0);
      top.position.set(0, 2.4, 9);
      legL.joint.rotation.x = legR.joint.rotation.x = 0;
      armL.joint.rotation.set(rest.armL, 0, 0.12);
      armR.joint.rotation.set(rest.armR, 0, -0.12);
      head.joint.rotation.x = 0;
      return;
    }
    top.position.set(0, (a.breath + 1) * 0.07, 0);
    top.rotation.set(a.strike * 0.3, 0, 0);
    legL.joint.rotation.x = a.swing * 0.8;
    legR.joint.rotation.x = -a.swing * 0.8;
    armL.joint.rotation.set(rest.armL - a.swing * 0.6, 0, 0.1 + a.breath * 0.015);
    // The weapon arm swings less on the march, and comes up and over in an attack.
    armR.joint.rotation.set(rest.armR + a.swing * 0.3 - a.strike * 1.7, 0, -0.1 - a.breath * 0.015);
    head.joint.rotation.x = a.breath * 0.02 - a.strike * 0.15;
  };
  return { torso, head, armR, armL, legR, legL, heldR, heldL, rest, animate };
}

type Biped = ReturnType<typeof biped>;

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
    case "daggers":
      dagger(w);
      // The second dagger goes in the other hand unless a shield is there.
      if (!shield) dagger(b.heldL);
      return { tilt: 0.7 };
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
      w.ball(GEAR.leather, 2.3, 0, -2.2, 1.1, 1, [1, 1.25, 0.55]);
      w.cyl(GEAR.dark, 0.7, 0.7, 0.2, 0, -2, 2.4, 8, [HALF_PI, 0, 0]);
      w.box(GEAR.wood, 0.7, 5.4, 0.6, 0, 2.6, 1.1);
      w.box(trim, 1.2, 1.3, 0.8, 0, 5.6, 1.1);
      w.box(GEAR.paper, 0.3, 6.4, 0.1, 0, 1.6, 1.5);
      return {};
    case "flute":
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
      w.cyl("#3a2a1c", 0.18, 0.38, 15, 0, 9.3, 0, 5);
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

  // Legs and feet.
  const legs = outfit?.legs;
  const boots = outfit?.boots;
  for (const leg of [b.legR, b.legL]) {
    if (legs?.ref === "trousers") {
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
    if (boots?.ref === "treads") {
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
  const body = outfit?.body;
  const greatcoat = body?.ref === "greatcoat";
  const oilskin = "#b1933c";
  const cloth = greatcoat ? oilskin : body ? GEAR.iron : look.body;
  let front = 1.95;
  torso.box(look.skin, 2.6, 0.8, 2.6, 0, 6.1, 0);
  if (greatcoat) {
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
  if (greatcoat || (look.coat && !body)) {
    // A long coat, open at the front, down over the legs.
    const edgeColor = greatcoat ? trim("body") : look.accent;
    for (const s of [-1, 1]) {
      torso.box(cloth, 2.7, 4.6, 4.3, s * 2.4, -2, 0);
      torso.box(edgeColor, 0.5, 4.6, 0.4, s * 1.25, -2, 2.05);
    }
    torso.box(cloth, 7.3, 4.6, 1, 0, -2, -1.7);
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
  for (const [arm, s] of [[armR, -1], [armL, 1]] as const) {
    arm.box(cloth, 2, 4.6, 2.4, 0, -2.1, 0);
    arm.box(look.skin, 1.8, 1.5, 2, 0, -5, 0);
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
  if (ring?.ref === "bands") {
    for (const arm of [armR, armL]) arm.box(trim("ring"), 2.4, 0.6, 2.8, 0, -4.2, 0);
  } else if (ring) {
    armR.box(GEAR.gold, 2, 0.4, 2.2, 0, -5.1, 0);
    armR.box(trim("ring"), 0.7, 0.7, 0.5, 0, -5.1, 1.2);
  }

  // Head.
  drawHead(head, look, asleep);
  const helmet = outfit?.helmet;
  if (helmet?.ref === "hood" || helmet?.icon === "hood") {
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
  } else {
    // No helmet equipped: the class keeps its own hat.
    drawHat(head, look);
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
  for (const leg of [b.legR, b.legL]) {
    leg.box(bone, 1.2, 4.6, 1.2, 0, -2.3, 0);
    leg.box(dim, 1.5, 0.9, 1.5, 0, -2.3, 0.1);
    leg.box(bone, 1.6, 0.6, 3, 0, -4.7, 0.6);
  }
  b.torso.box(dim, 5.2, 1.6, 2.6, 0, 0.6, 0);
  b.torso.box(bone, 1.3, 6, 1.3, 0, 3.2, -0.6);
  for (const y of [2.4, 3.7, 5]) {
    b.torso.box(dim, 5.8, 0.7, 0.7, 0, y, 1.1);
    for (const s of [-1, 1]) b.torso.box(dim, 0.7, 0.7, 2.6, s * 2.6, y, 0);
  }
  b.torso.box(bone, 7.6, 0.8, 1.2, 0, 5.7, 0);
  for (const arm of [b.armR, b.armL]) {
    arm.box(bone, 1, 4.6, 1, 0, -2.2, 0);
    arm.box(dim, 1.3, 0.8, 1.3, 0, -2.2, 0);
    arm.box(bone, 1.4, 1.3, 1.6, 0, -5, 0);
  }
  b.head.box(bone, 6, 4.6, 5.6, 0, 3.6, 0);
  b.head.box(dim, 4.4, 1.6, 4, 0, 0.9, 0.6);
  for (const s of [-1, 1]) b.head.box(OUTLINE, 1.6, 1.7, 0.4, s * 1.5, 3.4, 2.7);
  b.head.box(OUTLINE, 0.7, 0.9, 0.4, 0, 2, 2.7);
  for (const x of [-1.2, -0.4, 0.4, 1.2]) b.head.box(bone, 0.5, 0.7, 0.3, x, 0.9, 2.65);
  b.head.box("#8a3b2f", 6.3, 1.2, 5.9, 0, 5.5, 0);
  b.head.box("#8a3b2f", 1, 2.4, 0.7, 2.4, 4, -3.2, [0, 0, 0.2]);
  const w = b.heldR;
  w.box("#6b4a2b", 0.8, 1.8, 0.8, 0, 0.2, 0);
  w.box("#6b4a2b", 2.8, 0.6, 1.2, 0, 1.3, 0.2);
  w.box("#a3896a", 1.1, 6.4, 0.4, 0, 4.8, 0);
  w.box("#a3896a", 1.1, 1.6, 0.4, 0, 8.4, 0.5, [0.5, 0, 0]);
  b.rest.armR = -0.35;
  b.rest.tiltR = 0.55;
  return { parts, animate: b.animate };
}

// ---------- creatures ----------

/** The four-legged gait a wolf and a bear share. `across` is half the body's width, `tall` the back's height. */
function fourLegs(top: THREE.Group, legs: Part[], head: Part, tail: Part | null, across: number, tall: number) {
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
    head.joint.rotation.set(a.breath * 0.04 + a.strike * 0.35, 0, 0);
    if (tail) tail.joint.rotation.y = Math.sin(a.t * 3.1) * 0.3;
  };
}

/** A wolf, nose toward +z. The pack leader is the same animal, darker, with a red eye. */
function wolf(top: THREE.Group, fur = "#7d8793", dark = "#59616c", eye = "#ffd23f"): Rig {
  const parts: Part[] = [];
  const part = (parent: THREE.Object3D, x: number, y: number, z: number) => (parts[parts.length] = new Part(parent, x, y, z));
  const body = part(top, 0, 0, 0);
  body.box(fur, 4.4, 4, 9, 0, 6.2, -0.4);
  body.box(tone(fur, 0.05), 5, 4.7, 3.6, 0, 6.5, 2.6);
  body.box(dark, 3.4, 1, 6, 0, 4.2, -0.6);
  body.box(dark, 2.2, 1, 7, 0, 8.4, -0.6);
  const head = part(top, 0, 8, 4.4);
  head.box(fur, 4, 3.8, 3.6, 0, 0.8, 1.4);
  head.box(dark, 2.2, 1.9, 2.6, 0, 0, 4);
  head.box(OUTLINE, 1, 0.9, 0.8, 0, 0.6, 5.3);
  for (const s of [-1, 1]) {
    head.cone(dark, 0.85, 1.9, s * 1.3, 3.5, 0.5);
    head.glowBox(eye, 0.75, 0.75, 0.3, s * 1.25, 1.4, 3.25);
  }
  head.box(GEAR.paper, 0.4, 0.7, 0.4, 0.7, -1.1, 4.6);
  const tail = part(top, 0, 7.6, -4.8);
  tail.box(fur, 1.5, 1.5, 3.4, 0, -0.9, -1.4, [0.6, 0, 0]);
  tail.box(dark, 1.3, 1.3, 1.6, 0, -2.2, -3.2, [0.6, 0, 0]);
  const legs = [[-1.5, 3], [1.5, 3], [-1.5, -3.6], [1.5, -3.6]].map(([x, z]) => {
    const leg = part(top, x, 4.6, z);
    leg.box(dark, 1.5, 4.6, 1.7, 0, -2.3, 0);
    leg.box(tone(dark, -0.06), 1.7, 0.7, 2.2, 0, -4.3, 0.3);
    return leg;
  });
  return { parts, animate: fourLegs(top, legs, head, tail, 2.6, 9) };
}

/**
 * A bear on all fours: heavier than the wolf, with a hump at the shoulders, round ears, a pale muzzle and
 * thick clawed legs. `frost` greys the hump and brow for the old Great Bear.
 */
function bear(top: THREE.Group, fur = "#7a5232", dark = "#4f3420", muzzle = "#b98a5a", eye = "#f2a33a", frost?: string): Rig {
  const parts: Part[] = [];
  const part = (parent: THREE.Object3D, x: number, y: number, z: number) => (parts[parts.length] = new Part(parent, x, y, z));
  const body = part(top, 0, 0, 0);
  body.box(fur, 7, 6.6, 10, 0, 7.6, -0.6);
  body.box(fur, 6.2, 2.4, 4.6, 0, 11.6, 1.4);
  body.box(dark, 5.6, 1, 8, 0, 4.2, -0.6);
  body.box(dark, 1.6, 1.6, 1, 0, 8.6, -5.9);
  if (frost) body.box(frost, 6.3, 0.8, 4.7, 0, 12.6, 1.4);
  const head = part(top, 0, 9.4, 4.2);
  head.box(fur, 5.6, 5.2, 4.4, 0, 0.6, 1.8);
  head.box(muzzle, 3, 2.6, 2.4, 0, -0.6, 4.8);
  head.box(OUTLINE, 1.2, 1, 0.8, 0, 0.3, 6);
  for (const s of [-1, 1]) {
    head.ball(dark, 1.05, s * 2.2, 3.6, 1.2);
    head.glowBox(eye, 0.8, 0.8, 0.3, s * 1.6, 1.5, 4.05);
  }
  if (frost) head.box(frost, 5.7, 0.8, 4.5, 0, 3, 1.8);
  const legs = [[-2.3, 3.2], [2.3, 3.2], [-2.3, -4], [2.3, -4]].map(([x, z]) => {
    const leg = part(top, x, 4.8, z);
    leg.box(dark, 2.6, 4.8, 3, 0, -2.4, 0);
    for (const cx of [-0.8, 0, 0.8]) leg.box(GEAR.paper, 0.5, 0.6, 0.7, cx, -4.5, 1.8);
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
  body.ball(pale, 3.9, 0, 12.6, 0, 1);
  body.cyl(pale, 3.8, 4.6, 8, 0, 8.4, 0, 8);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.2;
    body.cone(i % 2 ? shade : pale, 1.5, i % 2 ? 3.4 : 2.4, Math.sin(a) * 3.3, i % 2 ? 2.9 : 3.4, Math.cos(a) * 3.3, 4, [Math.PI, 0, 0]);
  }
  for (const s of [-1, 1]) body.box(eye, 1.6, 2, 0.5, s * 1.5, 13, 3.3);
  body.box(eye, 2.4, 1.6, 0.5, 0, 10.2, 3.75);
  if (crown) {
    body.cyl(crown, 2.9, 2.9, 0.9, 0, 16, 0, 8);
    for (let i = 0; i < 4; i++) body.cone(crown, 0.7, 1.4, Math.sin(i * HALF_PI + 0.4) * 2.5, 17.1, Math.cos(i * HALF_PI + 0.4) * 2.5);
  }
  const arms = [-1, 1].map((s) => {
    const arm = (parts[parts.length] = new Part(body.joint, s * 3.6, 9.6, 1));
    arm.box(shade, 1.5, 1.5, 4.4, 0, 0, 2.2);
    arm.box(pale, 1.8, 1.2, 1.4, 0, 0, 4.8);
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
  body.ball(dark, 2.3, 0, 0, 0, 0, [1, 1.2, 0.9]);
  for (const s of [-1, 1]) {
    body.cone(dark, 0.7, 1.8, s * 1.1, 2.8, 0);
    body.glowBox("#ff4d4d", 0.7, 0.7, 0.3, s * 0.9, 0.7, 1.9);
  }
  body.box(GEAR.paper, 0.4, 0.8, 0.3, 0.3, -0.7, 1.95);
  const wings = [-1, 1].map((s) => {
    const p = (parts[parts.length] = new Part(body.joint, s * 1.6, 0.8, 0));
    p.box(wing, 5.2, 2.2, 0.35, s * 2.6, 0, 0);
    p.box(wing, 3.2, 2, 0.35, s * 6, -1, 0);
    p.box(wing, 2, 1, 0.35, s * 3.6, -1.6, 0);
    p.box(dark, 7.6, 0.5, 0.5, s * 3.8, 1.1, 0);
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
  body.ball(green, 6, 0, 4, 0, 1, [1, 0.8, 1]);
  body.cyl(deep, 5.9, 5.5, 1.8, 0, 0.9, 0, 10);
  body.ball(green, 1.1, -5.9, 0.7, 1.4);
  body.box("#c9f5b8", 1.8, 0.8, 0.5, -2, 7.4, 3.3, [-0.6, -0.3, 0]);
  body.box("#c9f5b8", 0.7, 1.4, 0.5, -3.6, 5.6, 3.9, [-0.3, -0.5, 0]);
  for (const s of [-1, 1]) body.box("#14301a", 1.5, 1.8, 0.6, s * 1.9, 4.6, 5.4);
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
  body.cyl(GEAR.wood, 0.8, 0.8, 6.4, 0, 3.2, 0, 6);
  body.box(GEAR.wood, 8, 0.8, 1.6, 0, 0.4, 0);
  body.box(GEAR.wood, 1.6, 0.8, 8, 0, 0.4, 0);
  body.cyl(straw, 3.7, 3.2, 7, 0, 9.6, 0, 8);
  body.cyl(shade, 3.3, 3.3, 0.8, 0, 6.3, 0, 8);
  body.box(GEAR.wood, 14, 1.2, 1.2, 0, 11.2, 0);
  for (const s of [-1, 1]) body.box(shade, 1.2, 3.4, 1.8, s * 6.8, 11, 0);
  body.cyl("#f4efe2", 2.1, 2.1, 0.4, 0, 9.6, 3.4, 10, [HALF_PI, 0, 0]);
  body.cyl("#c8433d", 1, 1, 0.4, 0, 9.6, 3.6, 10, [HALF_PI, 0, 0]);
  body.cyl(GEAR.leather, 2.5, 2.5, 0.8, 0, 13.4, 0, 8);
  body.ball(straw, 3.1, 0, 16, 0, 1);
  for (const s of [-1, 1]) body.box(OUTLINE, 0.8, 0.8, 0.5, s * 1.2, 16.6, 2.75);
  body.box(shade, 2, 0.5, 0.5, 0, 15, 2.7);
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
}

export interface Figure {
  /** Stands on its origin, facing +z: place it and turn it about y. */
  readonly root: THREE.Group;
  /** How tall the 22-unit frame is in world units: what a sprite's height used to be. */
  setSize(size: number): void;
  update(pose: FigurePose): void;
  /** Greyed, for someone down in a fight. */
  setDim(on: boolean): void;
  dispose(): void;
}

export interface FigureOptions {
  /** Eyes shut. */
  asleep?: boolean;
  /** Fishing: a rod in the right hand in place of whatever weapon is there. */
  rod?: boolean;
  /** Outline thickness, in model units. */
  edge?: number;
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
  rodInHand = !!opts.rod;
  const rig = rigFor(kind, top, look, outfit, !!opts.asleep);
  const mats: Mats = {
    body: bodyMaterial(),
    outline: new THREE.MeshBasicMaterial({ color: OUTLINE, side: THREE.BackSide }),
    glow: new THREE.MeshBasicMaterial({ vertexColors: true }),
  };
  const made: THREE.BufferGeometry[] = [];
  for (const part of rig.parts) part.build(mats, made);
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
    rig.animate({ t: p.time, swing, breath: Math.sin(p.time * 2.2 + beat), strike: Math.min(1, Math.abs(p.lean) * 2), lying: p.lying });
  };
  update({ time: 0, stride: 0, walking: false, lean: 0, lying: false });
  last = -1;
  return {
    root,
    setSize: (size) => scaler.scale.setScalar(size / FRAME),
    update,
    setDim(on) {
      mats.body.color.setScalar(on ? 0.5 : 1);
      mats.glow.color.setScalar(on ? 0.4 : 1);
    },
    dispose() {
      for (const g of made) g.dispose();
      mats.body.dispose();
      mats.outline.dispose();
      mats.glow.dispose();
    },
  };
}
