// Furniture for a hut's room: small low-poly models built from primitives,
// in the same style as the places on the map (WorldRenderer.poiModel). One
// per `model` key in the FURNISHINGS catalogue.
//
// Each model sits on the origin of its hex, fits inside its catalogue
// footprint, and faces the camera (+z) at facing 0. The renderer turns the
// whole group to face it. Wall pieces hang from their origin instead (see
// "on the walls").

import * as THREE from "three";
import { fieldstoneTexture } from "./groundArt";

/** The kinds of light a piece can give; Ambience sets how bright and how far each one reaches. A `brew` is the green glow off a bubbling cauldron. */
export type LightKind = "fire" | "candle" | "lamp" | "brew";

const WOOD = "#8a6a44";
const DARK_WOOD = "#5a3d22";
const PALE_WOOD = "#b98b5a";
const IRON = "#6f7480";
const STONE = "#9a968c";
const CLOTH = "#e8dcc0";
const GOLD = "#e0b12e";
/** From a hex's middle to the side it shares with the next one along: where a two-hex piece's middle sits from its anchor. */
const HX = Math.sqrt(3) / 2;

/** World units across one repeat of the fieldstone. */
const STONE_SPAN = 0.9;
let fieldstone: THREE.Texture | null = null;

/**
 * Fieldstone, tinted: laid on from all three sides by where each point is in the world and which way it faces
 * (the side it faces most takes most of its picture), so blocks of any shape need no UVs and the stones run on
 * unbroken from one block into the next.
 */
function stoneMaterial(tint: string): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ color: tint, map: (fieldstone ??= fieldstoneTexture()) });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("void main() {", "varying vec3 vStonePos;\nvarying vec3 vStoneNormal;\nvoid main() {")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n  vStonePos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\n  vStoneNormal = normalize( mat3( modelMatrix ) * objectNormal );");
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", "varying vec3 vStonePos;\nvarying vec3 vStoneNormal;\nvoid main() {")
      .replace(
        "#include <map_fragment>",
        /* glsl */ `{
          vec3 w = pow( abs( vStoneNormal ), vec3( 4.0 ) );
          w /= w.x + w.y + w.z;
          vec3 p = vStonePos / ${STONE_SPAN.toFixed(2)};
          vec4 stone = texture2D( map, p.zy ) * w.x + texture2D( map, p.xz ) * w.y + texture2D( map, p.xy ) * w.z;
          diffuseColor *= stone;
        }`,
      );
  };
  m.customProgramCacheKey = () => "gq-fieldstone";
  return m;
}

export class Builder {
  readonly group = new THREE.Group();

  private mesh(geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    this.group.add(mesh);
    return mesh;
  }

  /** A box whose base (not centre) sits at `y`. */
  box(color: string, w: number, h: number, d: number, x = 0, y = 0, z = 0): THREE.Mesh {
    return this.mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color, flatShading: true }), x, y + h / 2, z);
  }

  /** A box of fieldstone (see stoneMaterial), tinted, whose base sits at `y`. */
  stone(tint: string, w: number, h: number, d: number, x = 0, y = 0, z = 0): THREE.Mesh {
    return this.mesh(new THREE.BoxGeometry(w, h, d), stoneMaterial(tint), x, y + h / 2, z);
  }

  /** An upright cylinder (or, with different radii, a tapered post) whose base sits at `y`. */
  post(color: string, top: number, bottom: number, h: number, x = 0, y = 0, z = 0, sides = 6): THREE.Mesh {
    return this.mesh(new THREE.CylinderGeometry(top, bottom, h, sides), new THREE.MeshLambertMaterial({ color, flatShading: true }), x, y + h / 2, z);
  }

  cone(color: string, radius: number, h: number, x = 0, y = 0, z = 0, sides = 4): THREE.Mesh {
    return this.mesh(new THREE.ConeGeometry(radius, h, sides), new THREE.MeshLambertMaterial({ color, flatShading: true }), x, y + h / 2, z);
  }

  /** A lit ball centred on the point given. */
  ball(color: string, radius: number, x: number, y: number, z: number, detail = 1): THREE.Mesh {
    return this.mesh(new THREE.IcosahedronGeometry(radius, detail), new THREE.MeshLambertMaterial({ color, flatShading: true }), x, y, z);
  }

  /** Something that glows: drawn unlit, centred on the point given. */
  glow(color: string, geometry: THREE.BufferGeometry, x: number, y: number, z: number): THREE.Mesh {
    const mesh = this.mesh(geometry, new THREE.MeshBasicMaterial({ color }), x, y, z);
    // Lit from within: it gives light, so it must never cast a shadow over its own lamp.
    mesh.userData.selfLit = true;
    return mesh;
  }

  /**
   * A tongue of flame: an unlit box standing on `y`, marked so the ambience can
   * flicker it each frame (see Ambience.setFires). Its base stays put as it grows.
   */
  flame(color: string, w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0);
    const mesh = this.glow(color, geometry, x, y, z);
    mesh.userData.flame = this.group.children.filter((o) => o.userData.flame).length;
    return mesh;
  }

  /**
   * Where the piece's light hangs, in the model's own space: an empty marker
   * the renderer finds after placing it (see WorldRenderer.buildProps), so a
   * candle on a table that has been turned still lights from the right spot.
   */
  light(kind: LightKind, x: number, y: number, z: number): this {
    const at = new THREE.Object3D();
    at.position.set(x, y, z);
    at.userData.light = kind;
    this.group.add(at);
    return this;
  }

  /**
   * A fire's light: warm and flickering. `main` marks the room's great fire, which lights the whole room and
   * always throws shadows (see Ambience.setLights).
   */
  fire(x: number, y: number, z: number, main = false): this {
    this.light("fire", x, y, z);
    if (main) this.group.children[this.group.children.length - 1].userData.main = true;
    return this;
  }

  /**
   * A soft tongue of flame: a teardrop of light, brightest at its root and fading to nothing at its tip, added
   * over what is behind it. Flickered and swayed by the ambience like the boxy flames (see Ambience.setFires).
   */
  softFlame(color: string, radius: number, height: number, x: number, y: number, z: number): THREE.Mesh {
    const STEPS = 14;
    const profile: THREE.Vector2[] = [];
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS;
      const w = t < 0.28 ? Math.sin((t / 0.28) * (Math.PI / 2)) : Math.pow(1 - (t - 0.28) / 0.72, 1.4);
      profile.push(new THREE.Vector2(Math.max(1e-3, radius * w), height * t));
    }
    const geometry = new THREE.LatheGeometry(profile, 12);
    const base = new THREE.Color(color);
    const colors: number[] = [];
    const pos = geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      const t = pos.getY(i) / height;
      // Added to what is behind it, so dark is see-through: full at the root, gone by the tip.
      const k = Math.min(1, t / 0.12) * Math.pow(1 - t, 1.3);
      colors.push(base.r * k, base.g * k, base.b * k);
    }
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const mesh = this.mesh(geometry, material, x, y, z);
    mesh.userData.selfLit = true;
    mesh.userData.soft = true;
    mesh.userData.flame = this.group.children.filter((o) => o.userData.flame !== undefined).length;
    return mesh;
  }

  /**
   * A block of fieldstone standing in a corner where two walls meet at 120 degrees, the corner `corner` straight
   * behind the model's origin (at z = -corner): its front is flat at `front`, its sides at x0 and x1, and its back
   * follows the two walls, so it stands flush against both. The stone is laid by position (see stoneMaterial).
   */
  cornerBlock(tint: string, x0: number, x1: number, front: number, y: number, h: number, corner = 1, material?: THREE.Material): THREE.Mesh {
    /** How far forward the walls are this far to the side of the corner: they leave it at 30 degrees off the line across. */
    const wall = (x: number) => -corner + Math.tan(Math.PI / 6) * Math.abs(x) + 0.012;
    const pts: [number, number][] = [[x0, front], [x1, front], [x1, wall(x1)]];
    if (x0 < 0 && x1 > 0) pts.push([0, wall(0)]);
    pts.push([x0, wall(x0)]);
    // The shape is drawn in (x, -z) and stood up, so it extrudes upward.
    const shape = new THREE.Shape(pts.map(([px, pz]) => new THREE.Vector2(px, -pz)));
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
    geometry.rotateX(-Math.PI / 2);
    return this.mesh(geometry, material ?? stoneMaterial(tint), 0, y, 0);
  }

  /** A cylinder lying on its side along x, its middle at (x, y, z). */
  roll(color: string, radius: number, length: number, x = 0, y = 0, z = 0, sides = 6): THREE.Mesh {
    const mesh = this.mesh(new THREE.CylinderGeometry(radius, radius, length, sides), new THREE.MeshLambertMaterial({ color, flatShading: true }), x, y, z);
    mesh.rotation.z = Math.PI / 2;
    return mesh;
  }

  /** A ring standing upright, facing +z, its middle at (x, y, z). */
  ring(color: string, radius: number, tube: number, x = 0, y = 0, z = 0): THREE.Mesh {
    return this.mesh(new THREE.TorusGeometry(radius, tube, 4, 16), new THREE.MeshLambertMaterial({ color, flatShading: true }), x, y, z);
  }

  /** See-through, for glass. */
  glass(mesh: THREE.Mesh, opacity = 0.45): THREE.Mesh {
    const m = mesh.material as THREE.MeshLambertMaterial;
    m.transparent = true;
    m.opacity = opacity;
    m.depthWrite = false;
    mesh.userData.glass = true;
    return mesh;
  }

  /** A trophy's stand, with its top at y = 0.5. */
  pedestal(): this {
    this.post(STONE, 0.36, 0.42, 0.1);
    this.post("#c9c5bb", 0.2, 0.24, 0.32, 0, 0.1);
    this.post(STONE, 0.3, 0.26, 0.08, 0, 0.42);
    return this;
  }
}

const MODELS: Record<string, (b: Builder) => void> = {
  // A bedroll laid out on the ground: a blanket, a rolled end for a pillow, and a pack beside it.
  bedroll(b) {
    b.box("#7a5a3c", 0.55, 0.05, 1.05, 0.25, 0, 0.1);
    b.box("#9c3f36", 0.5, 0.06, 0.7, 0.25, 0.04, 0.25);
    b.box("#d8d2c0", 0.42, 0.12, 0.2, 0.25, 0.04, -0.32);
    b.box("#5a4632", 0.28, 0.24, 0.24, -0.35, 0, -0.25);
    // A small campfire beside it: a ring of stones, two crossed sticks and a few flames.
    const [fx, fz] = [-0.42, 0.42];
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3 + 0.3;
      b.box(i % 2 ? STONE : "#7d796f", 0.1, 0.07, 0.1, fx + Math.sin(a) * 0.17, 0, fz + Math.cos(a) * 0.17);
    }
    b.box(DARK_WOOD, 0.3, 0.05, 0.06, fx, 0.02, fz).rotation.y = 0.6;
    b.box(DARK_WOOD, 0.3, 0.05, 0.06, fx, 0.04, fz).rotation.y = -0.6;
    b.flame("#ff7a2a", 0.13, 0.22, 0.13, fx, 0.04, fz);
    b.flame("#ffb03a", 0.08, 0.16, 0.08, fx + 0.06, 0.04, fz + 0.04);
    b.flame("#ffe066", 0.06, 0.1, 0.06, fx - 0.05, 0.04, fz + 0.02);
    b.fire(fx, 0.4, fz);
  },
  // A length of bar counter, a full hex wide so neighbouring lengths join into one bar.
  bar(b) {
    b.box(WOOD, 1.76, 0.6, 0.5);
    b.box(DARK_WOOD, 1.8, 0.07, 0.62, 0, 0.6);
    b.box(DARK_WOOD, 1.76, 0.08, 0.04, 0, 0.12, 0.27);
    b.post("#d8d2c0", 0.07, 0.06, 0.14, -0.4, 0.67, 0.08);
    b.post("#c98b3a", 0.07, 0.06, 0.14, 0.3, 0.67, -0.05);
  },
  keg(b) {
    b.post(WOOD, 0.34, 0.34, 0.7, 0, 0, 0, 8);
    b.post("#4a4f5a", 0.355, 0.355, 0.06, 0, 0.12, 0, 8);
    b.post("#4a4f5a", 0.355, 0.355, 0.06, 0, 0.52, 0, 8);
    b.box(DARK_WOOD, 0.08, 0.08, 0.12, 0, 0.26, 0.36);
  },
  // The pub's pillar at the end of the bar (packages/world/src/pub.ts): a squared timber post on a stone footing,
  // up past the walls to a beam, with the contract dealer's notices pinned to its face and a lamp on a hook.
  pillar(b) {
    b.box(STONE, 0.46, 0.14, 0.46);
    b.box(DARK_WOOD, 0.3, 2.2, 0.3, 0, 0.14);
    b.box("#4a321c", 0.34, 0.06, 0.34, 0, 0.6);
    b.box(DARK_WOOD, 0.46, 0.12, 0.46, 0, 2.34);
    b.box(DARK_WOOD, 0.2, 0.16, 1.3, 0, 2.46, -0.4);
    // Notices, a little askew, each with a red pin.
    for (const [x, y, w, h, tilt] of [[-0.06, 1.08, 0.2, 0.26, 0.08], [0.07, 1.36, 0.17, 0.22, -0.12], [-0.03, 0.8, 0.16, 0.18, -0.05]] as const) {
      b.box(CLOTH, w, h, 0.015, x, y, 0.158).rotation.z = tilt;
      b.box("#b9433d", 0.03, 0.03, 0.02, x, y + h - 0.05, 0.17);
    }
    // A lamp hung from a hook on the side the bar is not.
    b.box(IRON, 0.18, 0.025, 0.025, 0.24, 1.86, 0);
    b.box(IRON, 0.015, 0.1, 0.015, 0.32, 1.76, 0);
    b.box("#b87333", 0.14, 0.03, 0.14, 0.32, 1.73);
    b.glow("#ffd98a", new THREE.BoxGeometry(0.11, 0.14, 0.11), 0.32, 1.66, 0);
    b.box("#b87333", 0.14, 0.03, 0.14, 0.32, 1.56);
    // No light of its own: a lamp's light makes its whole piece cast no shadow, and the pillar should.
  },
  table(b) {
    // Dark, oiled wood, so it stands out from the pale floorboards it sits on.
    b.box("#5e3d24", 1.0, 0.08, 0.7, 0, 0.42);
    for (const [x, z] of [[-0.42, -0.27], [0.42, -0.27], [-0.42, 0.27], [0.42, 0.27]]) b.box("#3b2616", 0.08, 0.42, 0.08, x, 0, z);
    b.box("#d8d2c0", 0.2, 0.05, 0.2, 0.22, 0.5, 0.05);
  },
  chair(b) {
    // Dark wood like the tables, so a stool stands out from the floor.
    b.post("#5e3d24", 0.24, 0.24, 0.07, 0, 0.3);
    for (const a of [0.5, 2.6, 4.7]) b.post("#3b2616", 0.035, 0.045, 0.3, Math.sin(a) * 0.16, 0, Math.cos(a) * 0.16, 5);
  },
  rug(b) {
    b.box("#8a5a3c", 1.2, 0.03, 0.8);
    b.box("#c9a877", 0.9, 0.035, 0.5);
    // The head end, so its facing can be read.
    b.box("#8a5a3c", 0.3, 0.06, 0.24, 0, 0, 0.46);
  },
  lantern(b) {
    b.post(IRON, 0.16, 0.2, 0.06);
    b.post("#b87333", 0.05, 0.05, 0.75, 0, 0.06);
    b.box("#b87333", 0.26, 0.05, 0.26, 0, 0.8);
    b.glow("#ffd98a", new THREE.BoxGeometry(0.2, 0.24, 0.2), 0, 0.98, 0);
    b.cone("#b87333", 0.2, 0.14, 0, 1.1);
    b.light("lamp", 0, 0.98, 0);
  },
  banner(b) {
    b.post(IRON, 0.14, 0.18, 0.06);
    b.post(DARK_WOOD, 0.04, 0.04, 1.5, 0, 0.06, 0, 5);
    b.box(DARK_WOOD, 0.7, 0.05, 0.05, 0, 1.45);
    b.box("#b9433d", 0.6, 0.8, 0.03, 0, 0.64, 0.03);
    b.box(GOLD, 0.6, 0.1, 0.035, 0, 0.98, 0.03);
  },
  bed(b) {
    b.box(WOOD, 0.8, 0.22, 1.25);
    b.box(CLOTH, 0.74, 0.1, 1.15, 0, 0.22);
    b.box("#3f6fa8", 0.76, 0.12, 0.7, 0, 0.22, 0.24);
    b.box("#f4efe1", 0.5, 0.1, 0.24, 0, 0.32, -0.42);
    b.box(DARK_WOOD, 0.84, 0.6, 0.08, 0, 0, -0.62);
  },
  /** The free storage chest every home has: smaller and plainer than the Sea Chest, with a domed lid and a padlock. */
  small_chest(b) {
    b.box(WOOD, 0.55, 0.28, 0.4);
    b.box(DARK_WOOD, 0.58, 0.1, 0.43, 0, 0.28);
    b.box(DARK_WOOD, 0.5, 0.06, 0.36, 0, 0.38);
    for (const x of [-0.2, 0.2]) b.box(IRON, 0.05, 0.42, 0.45, x, 0);
    b.box(IRON, 0.1, 0.12, 0.04, 0, 0.18, 0.22);
  },
  chest(b) {
    b.box(WOOD, 0.75, 0.34, 0.5);
    b.box(DARK_WOOD, 0.79, 0.14, 0.54, 0, 0.34);
    for (const x of [-0.25, 0.25]) b.box(IRON, 0.07, 0.5, 0.56, x, 0);
    b.box(GOLD, 0.1, 0.12, 0.04, 0, 0.26, 0.27);
  },
  hearth(b) {
    b.box(STONE, 1.1, 0.14, 0.7);
    for (const x of [-0.42, 0.42]) b.box(STONE, 0.26, 0.6, 0.6, x, 0.14);
    b.box("#3a3632", 0.6, 0.6, 0.12, 0, 0.14, -0.24);
    b.box("#8d8674", 1.2, 0.16, 0.72, 0, 0.74);
    b.box(STONE, 0.4, 0.5, 0.4, 0, 0.9, -0.1);
    // Logs on the grate, and pixel flames licking up off them.
    b.box(DARK_WOOD, 0.44, 0.08, 0.1, 0, 0.14, 0.06);
    b.box("#4a321c", 0.4, 0.07, 0.09, 0.02, 0.14, -0.06);
    b.box("#c4421c", 0.36, 0.03, 0.14, 0, 0.21, 0);
    b.flame("#ff6a1f", 0.13, 0.3, 0.1, -0.12, 0.2, -0.02);
    b.flame("#ff8a2a", 0.15, 0.38, 0.1, 0.02, 0.2, 0.0);
    b.flame("#ff7424", 0.12, 0.26, 0.1, 0.14, 0.2, -0.03);
    b.flame("#ffb83a", 0.09, 0.24, 0.08, -0.05, 0.2, 0.06);
    b.flame("#ffd84a", 0.08, 0.18, 0.07, 0.09, 0.2, 0.07);
    b.flame("#fff0a0", 0.05, 0.1, 0.05, 0.02, 0.2, 0.09);
    // The light sits just out of the firebox, so it spills across the floor in front.
    b.fire(0, 0.5, 0.48);
  },
  /**
   * The pub's great fireplace, built into the corner where its back wall meets the side wall: a hearthstone
   * before it, a deep sooty firebox between two piers of fieldstone, an oak mantel with tankards on it, and the
   * chimney breast stepping in as it rises to the top of the wall. Logs on firedogs over a bed of embers, soft
   * flames, and the room's great fire, which lights the whole pub and throws its shadows across the floor.
   * Facing the room along the corner's bisector, its back fitted flush to both walls.
   */
  pub_hearth(b) {
    const OAK = "#4a2f22";
    b.cornerBlock("#a39888", -0.98, 0.98, 0.5, 0, 0.07);
    for (const [x0, x1] of [[-0.74, -0.32], [0.32, 0.74]]) b.cornerBlock("#f2ead8", x0, x1, -0.02, 0.07, 0.93);
    // The firebox: its back and sides black with soot, and its floor a bed of ash.
    b.cornerBlock("#54473c", -0.32, 0.32, -0.4, 0.07, 0.93);
    b.cornerBlock("#e6dccb", -0.32, 0.32, -0.02, 0.74, 0.26);
    b.box("#2c2622", 0.62, 0.012, 0.38, 0, 0.07, -0.21);
    // The mantel: a heavy oak beam across the front, its ends fitted to the walls.
    const oak = new THREE.MeshLambertMaterial({ color: OAK });
    b.cornerBlock(OAK, -0.86, 0.86, 0.08, 1.0, 0.08, 1, oak);
    b.cornerBlock(OAK, -0.8, 0.8, 0.02, 0.95, 0.05, 1, oak);
    // The chimney breast, stepping in as it rises.
    b.cornerBlock("#f2ead8", -0.62, 0.62, -0.1, 1.08, 0.34);
    b.cornerBlock("#ece2cf", -0.44, 0.44, -0.2, 1.42, 0.34);
    // Tankards and a plate on the mantel.
    for (const x of [-0.55, 0.6]) {
      b.post("#9aa0a8", 0.045, 0.05, 0.11, x, 1.08, -0.02, 10);
      b.post("#4a4f5a", 0.05, 0.05, 0.012, x, 1.18, -0.02, 10);
    }
    b.post("#c9a54a", 0.1, 0.1, 0.015, 0.3, 1.13, -0.08, 16).rotation.x = Math.PI / 2 - 0.25;
    // Firedogs, and three logs across them.
    for (const x of [-0.2, 0.2]) {
      b.box("#2e2c30", 0.03, 0.16, 0.03, x, 0.07, -0.08);
      b.box("#2e2c30", 0.03, 0.03, 0.26, x, 0.07, -0.2);
    }
    const log = (x: number, y: number, z: number, length: number, yaw: number, radius = 0.045) => {
      const m = b.roll("#4a321c", radius, length, x, y, z, 10);
      m.rotation.y = yaw;
      return m;
    };
    log(0, 0.15, -0.16, 0.56, 0.12);
    log(0.02, 0.15, -0.27, 0.52, -0.1);
    log(-0.04, 0.22, -0.21, 0.44, 0.35, 0.04);
    // Embers under them, glowing.
    b.glow("#c4421c", new THREE.BoxGeometry(0.48, 0.02, 0.26), 0, 0.085, -0.21);
    b.glow("#ff7a2a", new THREE.BoxGeometry(0.3, 0.022, 0.14), 0.02, 0.087, -0.2);
    // The flames: a broad orange body, warmer tongues inside it, and a pale hot heart.
    const flames: [string, number, number, number, number][] = [
      ["#ff5a14", 0.13, 0.5, -0.1, -0.24],
      ["#ff6a1c", 0.12, 0.42, 0.12, -0.22],
      ["#ff7a24", 0.11, 0.58, 0.01, -0.2],
      ["#ff9a32", 0.08, 0.4, -0.05, -0.17],
      ["#ffb84a", 0.07, 0.34, 0.07, -0.16],
      ["#ffe08a", 0.05, 0.24, 0.0, -0.15],
      ["#fff3c8", 0.03, 0.13, 0.02, -0.14],
    ];
    for (const [color, radius, height, x, z] of flames) b.softFlame(color, radius, height, x, 0.13, z);
    // The great fire's light, just out of the firebox, so it spills across the hearth and the room.
    b.fire(0, 0.42, 0.14, true);
  },
  bookshelf(b) {
    b.box(DARK_WOOD, 0.95, 1.25, 0.34, 0, 0, -0.1);
    const books = ["#b9433d", "#3f6fa8", "#6b8c2f", GOLD, "#6a2f8c"];
    for (let shelf = 0; shelf < 3; shelf++) {
      b.box("#2a2018", 0.83, 0.3, 0.06, 0, 0.12 + shelf * 0.38, 0.06);
      for (let i = 0; i < 5; i++) b.box(books[(i + shelf * 2) % books.length], 0.11, 0.2 + ((i + shelf) % 3) * 0.03, 0.08, -0.32 + i * 0.16, 0.12 + shelf * 0.38, 0.09);
    }
  },
  workbench(b) {
    b.box(WOOD, 1.15, 0.1, 0.6, 0, 0.5);
    for (const x of [-0.5, 0.5]) b.box(DARK_WOOD, 0.1, 0.5, 0.52, x, 0);
    b.box(DARK_WOOD, 0.9, 0.06, 0.4, 0, 0.14);
    // A vice, a mallet and a plank being worked on.
    b.box(IRON, 0.16, 0.16, 0.2, -0.42, 0.6, 0.16);
    b.box(PALE_WOOD, 0.5, 0.05, 0.14, 0.15, 0.6, -0.08);
    b.box(IRON, 0.2, 0.1, 0.1, 0.3, 0.6, 0.16);
    b.box(DARK_WOOD, 0.05, 0.05, 0.3, 0.3, 0.63, 0.3);
  },
  // The same bench with a lantern standing on it, for working by: the smithy keeps its lamp out (see keepers.ts).
  workbench_lit(b) {
    MODELS.workbench(b);
    const [x, y, z] = [-0.15, 0.6, -0.18];
    b.box("#b87333", 0.15, 0.03, 0.15, x, y, z);
    b.glow("#ffd98a", new THREE.BoxGeometry(0.11, 0.13, 0.11), x, y + 0.095, z);
    for (const [dx, dz] of [[-0.065, -0.065], [0.065, -0.065], [-0.065, 0.065], [0.065, 0.065]]) b.box("#8a5a2a", 0.02, 0.13, 0.02, x + dx, y + 0.03, z + dz);
    b.cone("#b87333", 0.11, 0.07, x, y + 0.16, z);
    b.box("#8a5a2a", 0.1, 0.02, 0.02, x, y + 0.25, z);
    b.light("lamp", x, y + 0.12, z + 0.1);
  },
  // A barrel with a candle stuck on its head in its own wax.
  barrel_lit(b) {
    MODELS.barrel(b);
    b.post(CLOTH, 0.05, 0.07, 0.03, 0.06, 0.78, 0.04, 6);
    b.post(CLOTH, 0.035, 0.04, 0.16, 0.06, 0.78, 0.04, 6);
    b.flame("#ffd98a", 0.04, 0.07, 0.04, 0.06, 0.94, 0.04);
    b.light("candle", 0.06, 1.04, 0.04);
  },
  weapon_rack(b) {
    for (const x of [-0.45, 0.45]) b.box(DARK_WOOD, 0.08, 1.05, 0.14, x, 0, -0.1);
    b.box(WOOD, 0.98, 0.07, 0.1, 0, 0.3, -0.1);
    b.box(WOOD, 0.98, 0.07, 0.1, 0, 0.85, -0.1);
    // A sword, a spear and an axe leaning in it.
    b.box("#cfd6e0", 0.07, 0.75, 0.03, -0.25, 0.25, -0.02);
    b.box(GOLD, 0.2, 0.05, 0.05, -0.25, 0.22, -0.02);
    b.post(PALE_WOOD, 0.025, 0.025, 1.15, 0, 0.04, -0.02, 5);
    b.cone("#cfd6e0", 0.06, 0.18, 0, 1.19, -0.02);
    b.post(PALE_WOOD, 0.03, 0.03, 0.8, 0.25, 0.04, -0.02, 5);
    b.box(IRON, 0.22, 0.2, 0.04, 0.32, 0.68, -0.02);
  },
  // ---- the smithy and the apothecary (packages/world/src/keepers.ts): fittings, never sold ----
  /**
   * The forge, against the back wall: a fieldstone hearth at waist height with an arched mouth glowing in its face,
   * an iron-bound rim, and on top a deep bed of coals, red at the edges and white-hot at the heart, with a bar of
   * iron heating in it. Over it a tapered hood of riveted iron with a copper band, on iron posts, a rail of tongs, a
   * hammer and a poker hung from it, and a fieldstone chimney going up the wall. Leather bellows on its right.
   * Its fire is the room's great fire.
   */
  forge(b) {
    const SOOT = "#2a2623";
    const HOOD = "#3d3a38";
    const COPPER = "#b87333";
    // The hearth: a plinth, the body, and an iron-bound rim with rivets along the front.
    b.stone("#8d8674", 1.46, 0.12, 0.98, 0, 0, -0.06);
    b.stone("#a39888", 1.32, 0.5, 0.86, 0, 0.12, -0.06);
    b.box("#5a5550", 1.4, 0.08, 0.94, 0, 0.62, -0.06);
    b.box(IRON, 1.42, 0.05, 0.02, 0, 0.64, 0.42);
    for (let i = 0; i < 7; i++) b.ball("#8b95a5", 0.016, -0.6 + i * 0.2, 0.665, 0.435, 0);
    // The arched mouth in its face: a sooty recess with embers glowing in it, under an arch of red brick.
    b.box(SOOT, 0.46, 0.26, 0.03, 0, 0.16, 0.36);
    b.glow("#c4421c", new THREE.BoxGeometry(0.4, 0.05, 0.02), 0, 0.2, 0.38);
    b.glow("#ff8a2a", new THREE.BoxGeometry(0.22, 0.03, 0.02), 0, 0.22, 0.385);
    for (let k = 0; k <= 6; k++) {
      const a = Math.PI * (k / 6);
      const brick = b.box("#a8513a", 0.09, 0.06, 0.05, 0, 0, 0.375);
      brick.position.set(-Math.cos(a) * 0.27, 0.36 + Math.sin(a) * 0.12, 0.375);
      brick.rotation.z = a - Math.PI / 2;
    }
    // The bed of coals on top: dark at the rim, red through, a hot orange core and a white heart, lumps over it.
    b.box(SOOT, 0.98, 0.05, 0.56, 0, 0.7, -0.06);
    b.glow("#b8361a", new THREE.BoxGeometry(0.86, 0.03, 0.46), 0, 0.745, -0.06);
    b.glow("#ff7a24", new THREE.BoxGeometry(0.5, 0.035, 0.28), 0, 0.75, -0.06);
    b.glow("#ffd27a", new THREE.BoxGeometry(0.2, 0.04, 0.12), 0.04, 0.755, -0.06);
    for (const [x, z, r] of [[-0.36, -0.2, 0.06], [-0.28, 0.12, 0.05], [0.34, -0.16, 0.06], [0.38, 0.1, 0.05], [-0.12, -0.26, 0.05], [0.16, 0.16, 0.045], [-0.4, -0.02, 0.05]]) b.ball("#2f2b29", r, x, 0.77, z, 0);
    // A bar of iron heating in the coals, white-hot at its end, and its cool end and handle sticking out to the right.
    const hot = b.glow("#ffb347", new THREE.BoxGeometry(0.34, 0.035, 0.035), 0.06, 0.785, -0.02);
    hot.rotation.y = -0.25;
    b.glow("#fff0c0", new THREE.BoxGeometry(0.1, 0.038, 0.038), -0.06, 0.786, 0.01);
    const cool = b.box("#4a4e58", 0.36, 0.03, 0.03, 0.4, 0.77, -0.09);
    cool.rotation.y = -0.25;
    // Soft flames licking up off the coals.
    for (const [color, radius, height, x, z] of [["#ff5a14", 0.1, 0.36, -0.18, -0.08], ["#ff7a24", 0.11, 0.46, 0.02, -0.04], ["#ff6a1c", 0.09, 0.32, 0.22, -0.1], ["#ffb84a", 0.06, 0.26, -0.04, 0.02], ["#ffe08a", 0.04, 0.16, 0.06, -0.02]] as const) {
      b.softFlame(color, radius, height, x, 0.76, z);
    }
    // The hood: iron posts at the front corners, a copper band round its foot, the tapered hood itself with rivets,
    // and the chimney up the wall behind.
    for (const x of [-0.62, 0.62]) b.box(IRON, 0.06, 0.56, 0.06, x, 0.68, 0.34);
    b.box(COPPER, 1.34, 0.07, 0.86, 0, 1.22, -0.08);
    const hood = b.post(HOOD, 0.3, 0.86, 0.58, 0, 1.28, -0.12, 4);
    hood.rotation.y = Math.PI / 4;
    hood.scale.z = 0.72;
    for (let i = 0; i < 5; i++) b.ball("#8b95a5", 0.018, -0.36 + i * 0.18, 1.36, 0.25, 0);
    b.stone("#8d8674", 0.5, 0.92, 0.42, 0, 1.78, -0.22);
    b.box("#5a5550", 0.6, 0.07, 0.5, 0, 2.7, -0.22);
    // A rail along the copper band, and the smith's tools hung from it: tongs, a hammer, a poker.
    b.box(IRON, 1.12, 0.025, 0.025, 0, 1.12, 0.37);
    for (const [x, kind] of [[-0.4, "tongs"], [-0.12, "hammer"], [0.18, "poker"], [0.44, "tongs"]] as const) {
      b.box(IRON, 0.012, 0.06, 0.012, x, 1.06, 0.37);
      if (kind === "tongs") {
        for (const s of [-1, 1]) {
          const leg = b.box("#4a4e58", 0.018, 0.4, 0.018, x, 0.66, 0.38);
          leg.rotation.z = s * 0.07;
        }
      } else if (kind === "hammer") {
        b.box(PALE_WOOD, 0.025, 0.3, 0.025, x, 0.76, 0.38);
        b.box("#5b606c", 0.13, 0.07, 0.07, x, 0.7, 0.38);
      } else {
        b.box("#4a4e58", 0.02, 0.44, 0.02, x, 0.62, 0.38);
        b.ring("#4a4e58", 0.035, 0.008, x, 1.05, 0.38);
      }
    }
    // The bellows on the right: two shaped boards with brass studs, a leather bag between, a nozzle into the hearth,
    // and the handles.
    const [bx, by, bz] = [0.86, 0.44, 0.02];
    b.box(DARK_WOOD, 0.32, 0.04, 0.5, bx, by, bz);
    b.box("#6b4a34", 0.28, 0.16, 0.44, bx, by + 0.04, bz);
    b.box(DARK_WOOD, 0.32, 0.04, 0.5, bx, by + 0.2, bz);
    for (const [dx, dz] of [[-0.1, -0.15], [0.1, -0.15], [0, 0.12]]) b.ball(GOLD, 0.016, bx + dx, by + 0.245, bz + dz, 0);
    b.box(COPPER, 0.22, 0.04, 0.04, bx - 0.2, by + 0.1, bz - 0.24);
    b.box(DARK_WOOD, 0.05, 0.05, 0.22, bx, by + 0.22, bz + 0.34);
    b.box(DARK_WOOD, 0.05, 0.44, 0.05, bx, 0, bz + 0.2);
    b.fire(0, 1.0, 0.5, true);
  },
  // Coal for the forge: an open-topped bin heaped with it, and a shovel leaning in the corner.
  coal_bin(b) {
    b.box(DARK_WOOD, 0.8, 0.44, 0.62, 0, 0, -0.04);
    for (const y of [0.06, 0.32]) b.box(IRON, 0.82, 0.05, 0.64, 0, y, -0.04);
    b.box("#1f1d1c", 0.7, 0.08, 0.52, 0, 0.42, -0.04);
    for (const [x, z, r] of [[-0.18, -0.08, 0.1], [0.08, 0.02, 0.12], [0.24, -0.14, 0.09], [-0.04, -0.18, 0.1]]) b.ball("#2a2726", r, x, 0.5, z, 0);
    b.post(PALE_WOOD, 0.02, 0.02, 0.8, 0.36, 0.1, 0.24, 5).rotation.z = -0.25;
    b.box(IRON, 0.16, 0.18, 0.03, 0.44, 0.02, 0.24);
  },
  // The anvil, standing on its own cast-iron foot: a broad base and a waisted pedestal up to the body, a horn to the
  // left and the heel to the right, its face polished bright. On the face a sword blade being forged, glowing from
  // the fire: white-hot where the hammer falls, orange to dull red along it, its tang cooling grey over the heel.
  anvil(b) {
    b.box("#2f3238", 0.5, 0.06, 0.36);
    for (const [x, z] of [[-0.2, -0.13], [0.2, -0.13], [-0.2, 0.13], [0.2, 0.13]]) b.box("#2f3238", 0.12, 0.04, 0.1, x, 0, z);
    // Low, so the face is at about the smith's waist: the face at 0.44 above the floor.
    const pedestal = b.post("#3d4048", 0.15, 0.24, 0.12, 0, 0.06, 0, 4);
    pedestal.rotation.y = Math.PI / 4;
    b.box("#3d4048", 0.4, 0.06, 0.3, 0, 0.18);
    b.box("#4a4e58", 0.22, 0.08, 0.2, 0, 0.24);
    b.box("#5b606c", 0.62, 0.11, 0.26, 0.04, 0.32);
    const horn = b.cone("#5b606c", 0.085, 0.3, -0.42, 0.32, 0, 6);
    horn.rotation.z = Math.PI / 2;
    horn.position.y = 0.375;
    b.box("#8b95a5", 0.6, 0.012, 0.24, 0.04, 0.43);
    // The blade on the face: its glow in bands from white-hot where the hammer lands (toward the horn) to red at
    // the point and the shoulders.
    const y = 0.451;
    b.glow("#b8361a", new THREE.BoxGeometry(0.5, 0.014, 0.05), -0.02, y, 0);
    b.glow("#ff7a24", new THREE.BoxGeometry(0.3, 0.016, 0.052), -0.12, y + 0.001, 0);
    b.glow("#ffd27a", new THREE.BoxGeometry(0.14, 0.018, 0.054), -0.15, y + 0.002, 0);
    b.glow("#fff4d0", new THREE.BoxGeometry(0.05, 0.02, 0.056), -0.16, y + 0.003, 0);
    const tip = b.glow("#b8361a", new THREE.ConeGeometry(0.026, 0.08, 4), -0.31, y, 0);
    tip.rotation.z = Math.PI / 2;
    // The tang, cooled to iron, running off over the heel.
    b.box("#3a2a26", 0.08, 0.012, 0.03, 0.27, y - 0.006, 0);
    b.box("#4a4e58", 0.16, 0.012, 0.022, 0.39, y - 0.006, 0);
  },
  // The quench: a half barrel of dark water, with a pair of tongs hooked over the rim.
  quench_tub(b) {
    b.post(WOOD, 0.36, 0.32, 0.46, 0, 0, 0, 10);
    for (const y of [0.08, 0.36]) b.post("#4a4f5a", 0.375, 0.375, 0.05, 0, y, 0, 10);
    b.post("#2f4a5c", 0.33, 0.33, 0.02, 0, 0.42, 0, 10);
    b.box(IRON, 0.03, 0.5, 0.03, 0.2, 0.3, 0.2).rotation.z = 0.3;
    b.box(IRON, 0.03, 0.5, 0.03, 0.26, 0.3, 0.2).rotation.z = 0.42;
  },
  // A suit of plate on a stand: a post and crossbar, a cuirass, pauldrons and a helm on top.
  armor_stand(b) {
    b.box(DARK_WOOD, 0.5, 0.06, 0.5);
    b.post(DARK_WOOD, 0.04, 0.05, 1.2, 0, 0.06, 0, 6);
    b.box(DARK_WOOD, 0.7, 0.05, 0.05, 0, 0.98);
    b.box("#aeb6c2", 0.44, 0.5, 0.26, 0, 0.56);
    b.box("#8b95a5", 0.46, 0.08, 0.28, 0, 0.56);
    b.box(GOLD, 0.06, 0.4, 0.02, 0, 0.62, 0.135);
    for (const x of [-0.3, 0.3]) b.box("#aeb6c2", 0.2, 0.12, 0.28, x, 0.98);
    b.post("#aeb6c2", 0.13, 0.15, 0.22, 0, 1.12, 0, 8);
    b.box("#2a2a35", 0.16, 0.04, 0.02, 0, 1.2, 0.14);
    b.cone("#b9433d", 0.04, 0.16, 0, 1.34, 0, 5);
  },
  // The grindstone: a stone wheel in a timber frame over a water trough, with a crank.
  grindstone(b) {
    for (const z of [-0.2, 0.2]) {
      b.box(DARK_WOOD, 0.74, 0.07, 0.07, 0, 0, z);
      for (const x of [-0.26, 0.26]) b.box(DARK_WOOD, 0.07, 0.6, 0.07, x, 0, z);
      b.box(WOOD, 0.66, 0.06, 0.06, 0, 0.56, z);
    }
    b.box("#5a6b73", 0.5, 0.12, 0.3, 0, 0.14);
    const wheel = b.post("#b0aca0", 0.3, 0.3, 0.14, 0, 0, 0, 14);
    wheel.rotation.x = Math.PI / 2;
    wheel.position.y = 0.6;
    const axle = b.post(IRON, 0.03, 0.03, 0.6, 0, 0, 0, 6);
    axle.rotation.x = Math.PI / 2;
    axle.position.y = 0.6;
    b.box(IRON, 0.03, 0.2, 0.03, 0, 0.5, 0.3);
    b.box(PALE_WOOD, 0.05, 0.05, 0.12, 0, 0.5, 0.36);
  },
  // Shelves to head height, crowded with bottles and jars of every colour, a row of drawers at the foot.
  potion_shelf(b) {
    b.box(DARK_WOOD, 0.98, 1.5, 0.36, 0, 0, -0.14);
    b.box("#4a321c", 1.04, 0.06, 0.4, 0, 1.5, -0.14);

    for (let i = 0; i < 3; i++) b.box(WOOD, 0.28, 0.2, 0.03, -0.31 + i * 0.31, 0.06, 0.05);
    for (let i = 0; i < 3; i++) b.box(GOLD, 0.05, 0.03, 0.02, -0.31 + i * 0.31, 0.15, 0.07);
    const glassy = ["#b9433d", "#4f9a5a", "#3f6fa8", "#c98b3a", "#8c5ab0", "#4fb8b0", "#d8d2c0"];
    for (let shelf = 0; shelf < 3; shelf++) {
      const y = 0.34 + shelf * 0.38;
      b.box("#2a2018", 0.88, 0.32, 0.05, 0, y, -0.02);
      b.box(WOOD, 0.9, 0.03, 0.3, 0, y - 0.03, -0.08);
      for (let i = 0; i < 6; i++) {
        const color = glassy[(i * 3 + shelf * 2) % glassy.length];
        const tall = (i + shelf) % 3 === 0;
        const x = -0.36 + i * 0.145;
        b.post(color, tall ? 0.035 : 0.05, tall ? 0.045 : 0.055, tall ? 0.2 : 0.13, x, y, 0.03, 6);
        b.post("#8a6a44", 0.018, 0.018, 0.04, x, y + (tall ? 0.2 : 0.13), 0.03, 5);
      }
    }
  },
  // The same shelves with a fat candle guttering on top, wax run down the front. Only one shelf in the shop has one,
  // so the candles light pools of the room and leave dark between them.
  potion_shelf_lit(b) {
    MODELS.potion_shelf(b);
    b.post(CLOTH, 0.045, 0.05, 0.16, 0.3, 1.56, -0.04, 6);
    b.box(CLOTH, 0.03, 0.08, 0.02, 0.33, 1.5, 0.06);
    b.flame("#ffd98a", 0.04, 0.07, 0.04, 0.3, 1.72, -0.04);
    b.light("candle", 0.3, 1.82, -0.04);
  },
  // The cauldron: a black iron pot on three legs over a small fire, the brew a sickly green and bubbling. The apothecary stirs it with his paddle.
  cauldron(b) {
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3 + 0.2;
      b.box(i % 2 ? STONE : "#7d796f", 0.12, 0.08, 0.12, Math.sin(a) * 0.34, 0, Math.cos(a) * 0.34);
    }
    b.box(DARK_WOOD, 0.4, 0.06, 0.07, 0, 0.02, 0).rotation.y = 0.5;
    b.box("#4a321c", 0.4, 0.06, 0.07, 0, 0.04, 0).rotation.y = -0.6;
    b.flame("#ff7a2a", 0.12, 0.2, 0.1, -0.06, 0.06, 0.04);
    b.flame("#ffb03a", 0.09, 0.15, 0.08, 0.08, 0.06, -0.02);
    b.flame("#ffe066", 0.06, 0.1, 0.05, 0.0, 0.06, 0.1);
    for (const a of [0.4, 2.5, 4.6]) b.post("#26262b", 0.03, 0.035, 0.28, Math.sin(a) * 0.24, 0, Math.cos(a) * 0.24, 5);
    b.post("#2e2e35", 0.34, 0.22, 0.34, 0, 0.24, 0, 10);
    b.post("#26262b", 0.37, 0.37, 0.05, 0, 0.56, 0, 10);
    b.glow("#7fd66a", new THREE.CylinderGeometry(0.32, 0.32, 0.02, 10), 0, 0.6, 0);
    for (const [x, z, r] of [[-0.12, 0.06, 0.05], [0.1, -0.08, 0.04], [0.04, 0.14, 0.03]]) b.glow("#b6f2a0", new THREE.IcosahedronGeometry(r, 0), x, 0.62, z);
    // A small fire (not a room's great fire: the apothecary keeps his lamp out and his shop in pools of light), and
    // the brew gives off a green glow of its own.
    b.fire(0, 0.3, 0.5);
    b.light("brew", 0, 0.8, 0);
  },
  // The apothecary's counter: a panelled front, a top with the scales, a mortar and pestle, and a few bottles put out.
  shop_counter(b) {
    b.box(WOOD, 1.2, 0.62, 0.52);
    b.box(DARK_WOOD, 1.28, 0.06, 0.6, 0, 0.62);
    for (const x of [-0.38, 0, 0.38]) b.box(PALE_WOOD, 0.3, 0.42, 0.02, x, 0.1, 0.262);
    // A balance: a post, a beam and two pans.
    b.post("#b87333", 0.02, 0.03, 0.26, -0.34, 0.68, 0, 6);
    b.box("#b87333", 0.34, 0.02, 0.02, -0.34, 0.92);
    for (const x of [-0.5, -0.18]) {
      b.box("#b87333", 0.008, 0.1, 0.008, x, 0.82);
      b.post(GOLD, 0.07, 0.05, 0.02, x, 0.8, 0, 8);
    }
    // A mortar and pestle.
    b.post("#c9c5bb", 0.09, 0.06, 0.09, 0.08, 0.68, 0.06, 8);
    b.post("#8d8674", 0.02, 0.025, 0.16, 0.11, 0.72, 0.06, 5).rotation.z = -0.5;
    for (const [x, z, color] of [[0.36, -0.04, "#b9433d"], [0.46, 0.08, "#4f9a5a"], [0.28, 0.12, "#3f6fa8"]] as const) {
      b.post(color, 0.04, 0.05, 0.12, x, 0.68, z, 6);
      b.post("#8a6a44", 0.018, 0.018, 0.035, x, 0.8, z, 5);
    }
    // A stub of candle in a brass dish at the back corner, to count by.
    b.post("#b87333", 0.07, 0.06, 0.02, -0.5, 0.68, -0.18, 8);
    b.post(CLOTH, 0.025, 0.025, 0.1, -0.5, 0.7, -0.18, 6);
    b.flame("#ffd98a", 0.03, 0.05, 0.03, -0.5, 0.8, -0.18);
    b.light("candle", -0.5, 0.88, -0.18);
  },
  // A drying rack: two posts and three rails hung with bunches of herbs, heads down.
  herb_rack(b) {
    for (const x of [-0.46, 0.46]) b.box(DARK_WOOD, 0.07, 1.4, 0.07, x, 0, -0.16);
    b.box(DARK_WOOD, 1.0, 0.06, 0.3, 0, 0, -0.16);
    const greens = ["#5e9a3a", "#7ea845", "#4a7d3a", "#9aa85a", "#6b8c2f"];
    for (let rail = 0; rail < 3; rail++) {
      const y = 0.62 + rail * 0.36;
      b.box(WOOD, 0.96, 0.04, 0.04, 0, y, -0.16);
      for (let i = 0; i < 5; i++) {
        const x = -0.36 + i * 0.18 + (rail % 2) * 0.05;
        b.box("#c9a877", 0.015, 0.06, 0.015, x, y - 0.06, -0.14);
        const bunch = b.cone(greens[(i + rail * 2) % greens.length], 0.06, 0.2, x, y - 0.26, -0.14, 5);
        bunch.rotation.x = Math.PI;
        if ((i + rail) % 4 === 0) b.ball("#b98ad6", 0.03, x, y - 0.26, -0.14, 0);
      }
    }
  },
  // A work table for the herbs: a chopping board and knife, pots of what is growing, a jar of mushrooms and a candle.
  herb_table(b) {
    b.box(WOOD, 1.1, 0.08, 0.6, 0, 0.46);
    for (const [x, z] of [[-0.48, -0.23], [0.48, -0.23], [-0.48, 0.23], [0.48, 0.23]]) b.box(DARK_WOOD, 0.08, 0.46, 0.08, x, 0, z);
    b.box(DARK_WOOD, 0.96, 0.05, 0.46, 0, 0.14);
    b.box(PALE_WOOD, 0.3, 0.03, 0.22, -0.1, 0.54, 0.08);
    b.box("#cfd6e0", 0.16, 0.01, 0.04, -0.06, 0.57, 0.12).rotation.y = 0.4;
    for (const [x, z] of [[-0.14, 0.04], [-0.2, 0.1]]) b.box("#5e9a3a", 0.08, 0.02, 0.03, x, 0.57, z);
    for (const [x, z] of [[-0.4, -0.14], [0.42, -0.12]]) {
      b.post("#b8613a", 0.08, 0.06, 0.1, x, 0.54, z, 6);
      for (const [dx, dz, h] of [[0, 0, 0.18], [0.04, 0.03, 0.13], [-0.04, 0.02, 0.14]]) b.cone("#5e9a3a", 0.035, h, x + dx, 0.64, z + dz, 4);
    }
    b.glass(b.post("#cfe4ea", 0.07, 0.07, 0.15, 0.22, 0.54, 0.1, 8), 0.4);
    b.cone("#b9433d", 0.03, 0.03, 0.22, 0.6, 0.1, 6);
    b.post(CLOTH, 0.025, 0.025, 0.12, 0.2, 0.54, -0.16, 6);
    b.glow("#ffd98a", new THREE.BoxGeometry(0.03, 0.05, 0.03), 0.2, 0.69, -0.16);
    b.light("candle", 0.2, 0.75, -0.16);
  },
  // ---- more furniture ----
  desk(b) {
    b.box(DARK_WOOD, 1.1, 0.06, 0.56, 0, 0.56);
    // A bank of drawers on the left, two legs on the right.
    b.box(WOOD, 0.34, 0.56, 0.5, -0.36, 0);
    for (const y of [0.08, 0.3]) {
      b.box(PALE_WOOD, 0.28, 0.17, 0.02, -0.36, y, 0.25);
      b.box(GOLD, 0.05, 0.04, 0.03, -0.36, y + 0.07, 0.27);
    }
    for (const z of [-0.22, 0.22]) b.box("#3b2616", 0.07, 0.56, 0.07, 0.48, 0, z);
  },
  side_table(b) {
    b.box("#5e3d24", 0.56, 0.05, 0.52, 0, 0.5);
    for (const [x, z] of [[-0.22, -0.2], [0.22, -0.2], [-0.22, 0.2], [0.22, 0.2]]) b.box("#3b2616", 0.06, 0.5, 0.06, x, 0, z);
    b.box(WOOD, 0.46, 0.03, 0.42, 0, 0.16);
  },
  dresser(b) {
    b.box(DARK_WOOD, 1.02, 0.05, 0.5, 0, 0, -0.1);
    b.box(WOOD, 0.98, 0.75, 0.46, 0, 0.05, -0.1);
    b.box(DARK_WOOD, 1.04, 0.04, 0.52, 0, 0.8, -0.1);
    for (const y of [0.1, 0.34, 0.58]) {
      b.box(PALE_WOOD, 0.86, 0.19, 0.02, 0, y, 0.14);
      for (const x of [-0.22, 0.22]) b.box(GOLD, 0.06, 0.04, 0.03, x, y + 0.08, 0.16);
    }
  },
  cupboard(b) {
    b.box(DARK_WOOD, 0.92, 0.05, 0.46, 0, 0, -0.12);
    b.box(WOOD, 0.88, 1.41, 0.42, 0, 0.05, -0.12);
    b.box(DARK_WOOD, 0.96, 0.06, 0.48, 0, 1.46, -0.12);
    for (const x of [-0.215, 0.215]) {
      b.box(PALE_WOOD, 0.4, 1.28, 0.02, x, 0.12, 0.1);
      b.box(DARK_WOOD, 0.3, 0.5, 0.025, x, 0.8, 0.1);
      b.box(IRON, 0.04, 0.12, 0.03, x > 0 ? 0.05 : -0.05, 0.7, 0.12);
    }
  },
  /** The free wardrobe every home has: tall, with two doors, a cornice and a clothes rail peeking out. */
  wardrobe(b) {
    b.box(DARK_WOOD, 0.92, 0.06, 0.46, 0, 0, -0.12);
    b.box(WOOD, 0.88, 1.48, 0.42, 0, 0.06, -0.12);
    b.box(DARK_WOOD, 0.96, 0.08, 0.5, 0, 1.54, -0.12);
    b.box(PALE_WOOD, 0.9, 0.04, 0.46, 0, 1.5, -0.12);
    for (const x of [-0.215, 0.215]) {
      b.box(PALE_WOOD, 0.41, 1.34, 0.02, x, 0.12, 0.1);
      // A panel high and low on each door, and a knob by the middle.
      b.box(DARK_WOOD, 0.3, 0.56, 0.025, x, 0.82, 0.1);
      b.box(DARK_WOOD, 0.3, 0.4, 0.025, x, 0.22, 0.1);
      b.ball(GOLD, 0.025, x > 0 ? 0.04 : -0.04, 0.74, 0.12, 0);
    }
    // A scarf caught in the doors.
    b.box("#b8452f", 0.05, 0.36, 0.03, 0.0, 0.5, 0.11);
  },
  crate(b) {
    b.box(PALE_WOOD, 0.66, 0.5, 0.66);
    for (const y of [0.06, 0.36]) b.box(WOOD, 0.68, 0.08, 0.68, 0, y);
    b.box(WOOD, 0.08, 0.5, 0.68, -0.29, 0);
    b.box(WOOD, 0.08, 0.5, 0.68, 0.29, 0);
    b.box(DARK_WOOD, 0.7, 0.06, 0.7, 0, 0.5);
  },
  barrel(b) {
    b.post(WOOD, 0.28, 0.26, 0.74, 0, 0, 0, 8);
    for (const y of [0.1, 0.6]) b.post("#4a4f5a", 0.29, 0.29, 0.05, 0, y, 0, 8);
    b.post(DARK_WOOD, 0.27, 0.27, 0.04, 0, 0.74, 0, 8);
  },
  fireplace(b) {
    b.box("#8d8674", 1.6, 0.12, 0.8);
    for (const x of [-0.62, 0.62]) b.box(STONE, 0.36, 0.82, 0.6, x, 0.12, -0.05);
    b.box("#2e2a27", 0.9, 0.82, 0.12, 0, 0.12, -0.3);
    b.box("#8d8674", 1.7, 0.12, 0.38, 0, 0.94, 0.19);
    b.box(STONE, 1.6, 0.12, 0.6, 0, 0.94, -0.05);
    b.box(STONE, 1.0, 0.95, 0.5, 0, 1.06, -0.17);
    // Stones set into the face, a shade lighter.
    for (const [x, y] of [[-0.68, 0.3], [0.58, 0.56], [-0.55, 0.7], [0.7, 0.22]]) b.box("#aaa699", 0.14, 0.1, 0.02, x, y, 0.26);
    // A grate of logs, embers, and a big pixel fire.
    b.box(IRON, 0.7, 0.04, 0.4, 0, 0.12, 0);
    b.box(DARK_WOOD, 0.6, 0.09, 0.12, 0, 0.16, 0.06).rotation.y = 0.15;
    b.box("#4a321c", 0.56, 0.08, 0.11, 0, 0.16, -0.08).rotation.y = -0.2;
    b.box("#c4421c", 0.5, 0.03, 0.2, 0, 0.24, 0);
    const flames: [string, number, number, number, number][] = [
      ["#ff5a1a", 0.15, 0.4, -0.2, -0.04],
      ["#ff7a24", 0.17, 0.52, -0.04, 0.0],
      ["#ff6a1f", 0.15, 0.42, 0.13, -0.05],
      ["#ff8a2a", 0.12, 0.3, 0.27, 0.0],
      ["#ffb83a", 0.11, 0.34, -0.1, 0.07],
      ["#ffc94a", 0.1, 0.28, 0.06, 0.08],
      ["#ffe27a", 0.07, 0.18, -0.02, 0.1],
      ["#fff3b0", 0.05, 0.1, 0.14, 0.1],
    ];
    for (const [color, w, h, x, z] of flames) b.flame(color, w, h, w * 0.7, x, 0.24, z);
    b.fire(0, 0.6, 0.6);
  },

  // ---- small things ----
  // ---- big pieces: built from their anchor hex's middle out across the next (see hut.ts, Footprint) ----
  long_table(b) {
    // A trestle table two hexes long, in the same dark wood as the Plank Table, with a cloth runner down it.
    b.box("#5e3d24", 2.5, 0.08, 0.76, HX, 0.42);
    for (const x of [HX - 1.12, HX + 1.12]) for (const z of [-0.29, 0.29]) b.box("#3b2616", 0.08, 0.42, 0.08, x, 0, z);
    b.box("#3b2616", 0.08, 0.42, 0.5, HX, 0);
    b.box("#3b2616", 2.2, 0.06, 0.06, HX, 0.16);
    b.box(CLOTH, 2.1, 0.012, 0.26, HX, 0.5);
  },
  long_bench(b) {
    b.box("#5e3d24", 2.3, 0.07, 0.4, HX, 0.28);
    for (const x of [HX - 1.04, HX, HX + 1.04]) b.box("#3b2616", 0.07, 0.28, 0.34, x, 0);
    b.box("#3b2616", 2.08, 0.05, 0.05, HX, 0.12);
  },
  four_poster(b) {
    const [head, foot] = [HX - 1.14, HX + 1.14];
    // The frame, the mattress at a bunk's height, pillows at the head and a deep red blanket.
    b.box(WOOD, 2.3, 0.2, 1.04, HX);
    b.box(CLOTH, 2.16, 0.1, 0.96, HX, 0.2);
    b.box("#9c3f36", 1.4, 0.12, 1.0, HX + 0.36, 0.2);
    b.box("#7a2f2a", 0.08, 0.13, 1.0, HX - 0.34, 0.2);
    for (const z of [-0.24, 0.24]) b.box("#f4efe1", 0.28, 0.1, 0.38, head + 0.28, 0.3, z);
    b.box(DARK_WOOD, 0.08, 0.75, 1.04, head, 0);
    b.box(DARK_WOOD, 0.08, 0.42, 1.04, foot, 0);
    // Four posts, rails across the top with a valance hanging off them, and curtains tied back at each post.
    for (const x of [head, foot]) {
      for (const z of [-0.5, 0.5]) {
        b.post(DARK_WOOD, 0.045, 0.055, 1.78, x, 0, z);
        b.box("#9c3f36", 0.13, 1.1, 0.13, x + (x === head ? 0.09 : -0.09), 0.5, z * 0.9);
        b.box(GOLD, 0.15, 0.04, 0.15, x + (x === head ? 0.09 : -0.09), 0.86, z * 0.9);
      }
      b.box(DARK_WOOD, 0.06, 0.06, 1.04, x, 1.74);
    }
    for (const z of [-0.5, 0.5]) {
      b.box(DARK_WOOD, 2.34, 0.06, 0.06, HX, 1.74, z);
      b.box("#9c3f36", 2.34, 0.2, 0.03, HX, 1.56, z * 1.02);
    }
  },
  great_bookcase(b) {
    // Two bays of shelves under one cornice, and a ladder leaning on the right-hand bay.
    b.box(DARK_WOOD, 2.4, 1.62, 0.4, HX, 0, -0.15);
    b.box("#4a3220", 2.46, 0.08, 0.44, HX, 1.54, -0.15);
    const books = ["#b9433d", "#3f6fa8", "#6b8c2f", GOLD, "#6a2f8c", "#8a5a3c"];
    for (let shelf = 0; shelf < 4; shelf++) {
      const y = 0.1 + shelf * 0.36;
      for (const bay of [-1, 1]) {
        const mid = HX + bay * 0.58;
        b.box("#2a2018", 1.04, 0.3, 0.06, mid, y, 0.03);
        for (let i = 0; i < 7; i++) {
          if ((i + shelf + (bay > 0 ? 2 : 0)) % 6 === 5) continue;
          b.box(books[(i + shelf * 2 + (bay > 0 ? 3 : 0)) % books.length], 0.11, 0.2 + ((i + shelf) % 3) * 0.03, 0.08, mid - 0.42 + i * 0.14, y, 0.06);
        }
      }
    }
    b.box(DARK_WOOD, 0.06, 1.5, 0.08, HX, 0.06, 0.04);
    for (const x of [HX + 0.62, HX + 0.94]) b.box(PALE_WOOD, 0.04, 1.58, 0.04, x, 0, 0.11);
    for (let i = 0; i < 5; i++) b.box(PALE_WOOD, 0.36, 0.03, 0.03, HX + 0.78, 0.2 + i * 0.3, 0.11);
  },
  runner_rug(b) {
    // An old sail, three hexes long: cream canvas, a blue stripe down the middle and red ones either side.
    b.box("#d8cdb0", 4.6, 0.025, 1.0, 2 * HX);
    b.box("#3f6fa8", 4.4, 0.03, 0.18, 2 * HX);
    for (const z of [-0.3, 0.3]) b.box("#b8452f", 4.4, 0.03, 0.1, 2 * HX, 0, z);
    for (const x of [2 * HX - 2.27, 2 * HX + 2.27]) b.box("#a89a78", 0.06, 0.032, 1.0, x);
  },
  round_rug(b) {
    // Rings of braided rope and rag, laid over three hexes.
    const rings: [string, number][] = [["#8a5a3c", 1.35], ["#4f8a3a", 1.08], [CLOTH, 0.8], ["#b8452f", 0.52], ["#3f6fa8", 0.22]];
    rings.forEach(([color, radius], i) => b.post(color, radius, radius, 0.02 + i * 0.004, HX, 0, 0.5, 24));
  },

  candle(b) {
    b.post(GOLD, 0.07, 0.08, 0.025);
    b.post("#efe6c8", 0.035, 0.035, 0.14, 0, 0.025);
    b.flame("#ffb03a", 0.035, 0.06, 0.035, 0, 0.165, 0);
    b.flame("#fff0a0", 0.018, 0.035, 0.018, 0, 0.17, 0.004);
    b.light("candle", 0, 0.26, 0);
  },
  candelabra(b) {
    b.post("#b87333", 0.07, 0.09, 0.03);
    b.post("#b87333", 0.02, 0.02, 0.2, 0, 0.03);
    b.box("#b87333", 0.26, 0.025, 0.03, 0, 0.21);
    for (const x of [-0.12, 0, 0.12]) {
      const y = x === 0 ? 0.26 : 0.235;
      b.post("#b87333", 0.03, 0.025, 0.02, x, y - 0.02);
      b.post("#efe6c8", 0.022, 0.022, 0.09, x, y);
      b.flame("#ffb03a", 0.026, 0.05, 0.026, x, y + 0.09, 0);
    }
    b.light("candle", 0, 0.42, 0);
  },
  hand_lantern(b) {
    b.box("#b87333", 0.15, 0.03, 0.15);
    b.glow("#ffd98a", new THREE.BoxGeometry(0.11, 0.13, 0.11), 0, 0.095, 0);
    for (const [x, z] of [[-0.065, -0.065], [0.065, -0.065], [-0.065, 0.065], [0.065, 0.065]]) b.box("#8a5a2a", 0.02, 0.13, 0.02, x, 0.03, z);
    b.cone("#b87333", 0.11, 0.07, 0, 0.16);
    b.box("#8a5a2a", 0.1, 0.02, 0.02, 0, 0.25);
    b.light("lamp", 0, 0.12, 0.1);
  },
  mug(b) {
    b.post("#9a7146", 0.06, 0.055, 0.13, 0, 0, 0, 8);
    b.post(IRON, 0.062, 0.062, 0.02, 0, 0.03, 0, 8);
    b.post("#f4efe1", 0.055, 0.055, 0.02, 0, 0.12, 0, 8);
    b.box("#9a7146", 0.03, 0.08, 0.02, 0.075, 0.025);
  },
  bottle(b) {
    b.post("#2f7a4a", 0.045, 0.05, 0.15, 0, 0, 0, 6);
    b.post("#2f7a4a", 0.018, 0.03, 0.07, 0, 0.15, 0, 6);
    b.post(PALE_WOOD, 0.016, 0.016, 0.03, 0, 0.22, 0, 5);
    b.box(CLOTH, 0.07, 0.06, 0.005, 0, 0.05, 0.045);
  },
  plate(b) {
    b.post("#b86a4a", 0.14, 0.11, 0.02, 0, 0, 0, 8);
    b.box("#c99a54", 0.14, 0.06, 0.08, -0.02, 0.02, 0).rotation.y = 0.4;
    b.box("#e8c84a", 0.07, 0.05, 0.06, 0.07, 0.02, 0.04);
  },
  books(b) {
    const stack: [string, number, number, number][] = [["#3f6fa8", 0.22, 0.15, 0.05], ["#b9433d", 0.2, 0.14, -0.2], ["#6b8c2f", 0.18, 0.13, 0.25]];
    stack.forEach(([color, w, d, turn], i) => {
      const book = b.box(color, w, 0.045, d, 0, i * 0.045);
      book.rotation.y = turn;
      b.box("#f4efe1", w - 0.02, 0.03, 0.01, 0, i * 0.045 + 0.008, d / 2).rotation.y = turn;
    });
  },
  potted_herb(b) {
    b.post("#b8613a", 0.08, 0.06, 0.1, 0, 0, 0, 6);
    b.post("#4a3424", 0.07, 0.07, 0.01, 0, 0.095, 0, 6);
    for (const [x, z, h] of [[0, 0, 0.18], [0.04, 0.03, 0.13], [-0.04, 0.02, 0.14], [0.01, -0.04, 0.12]]) b.cone("#5e9a3a", 0.035, h, x, 0.1, z, 4);
  },
  mushroom_jar(b) {
    for (const [x, z, color] of [[-0.02, 0, "#b9433d"], [0.03, 0.02, "#c9a877"], [0.01, -0.03, "#8a5a3c"]] as const) {
      b.post("#efe6c8", 0.01, 0.012, 0.06, x, 0.01, z, 5);
      b.cone(color, 0.03, 0.03, x, 0.06, z, 6);
    }
    b.glass(b.post("#cfe4ea", 0.07, 0.07, 0.15, 0, 0, 0, 8), 0.4);
    b.post(GOLD, 0.072, 0.072, 0.025, 0, 0.15, 0, 8);
  },
  skull(b) {
    b.box("#efe9d6", 0.12, 0.1, 0.13, 0, 0.03);
    b.box("#e2dbc4", 0.09, 0.04, 0.07, 0, 0, 0.03);
    for (const x of [-0.03, 0.03]) b.box("#2a2018", 0.03, 0.025, 0.01, x, 0.07, 0.065);
    b.box("#2a2018", 0.015, 0.02, 0.01, 0, 0.045, 0.065);
  },
  sea_chart(b) {
    b.box("#e6d7a8", 0.32, 0.006, 0.24);
    for (const [w, x, z] of [[0.1, -0.06, -0.05], [0.07, 0.07, 0.04], [0.05, -0.02, 0.07]]) b.box("#6b8c5a", w, 0.008, w * 0.6, x, 0, z);
    b.box("#b9433d", 0.02, 0.01, 0.02, 0.09, 0, -0.06);
    b.roll("#d8c48e", 0.025, 0.26, 0, 0.025, -0.13);
  },
  hourglass(b) {
    for (const y of [0, 0.19]) b.post(DARK_WOOD, 0.07, 0.07, 0.02, 0, y, 0, 6);
    for (const a of [0.5, 2.6, 4.7]) b.post(DARK_WOOD, 0.008, 0.008, 0.17, Math.sin(a) * 0.055, 0.02, Math.cos(a) * 0.055, 4);
    b.glass(b.cone("#d9eef2", 0.045, 0.085, 0, 0.02, 0, 6), 0.5).rotation.x = Math.PI;
    b.glass(b.cone("#d9eef2", 0.045, 0.085, 0, 0.105, 0, 6), 0.5);
    b.cone("#e0b86a", 0.035, 0.04, 0, 0.02, 0, 6);
  },
  writing_set(b) {
    b.post("#1f2430", 0.04, 0.045, 0.05, 0, 0, 0, 6);
    b.post("#0c0e14", 0.02, 0.02, 0.01, 0, 0.05, 0, 6);
    const quill = b.box("#f4efe1", 0.012, 0.22, 0.04, 0.03, 0.03, 0);
    quill.rotation.z = -0.5;
    b.box("#c9a877", 0.12, 0.004, 0.16, -0.1, 0, 0.02);
  },
  coin_pile(b) {
    const coins: [number, number, number][] = [[0, 0, 0], [0, 0.016, 0], [0.005, 0.032, 0.004], [0.06, 0, 0.03], [0.06, 0.016, 0.03], [-0.05, 0, 0.04], [-0.02, 0, -0.06], [0.04, 0, -0.05]];
    for (const [x, y, z] of coins) b.post(GOLD, 0.035, 0.035, 0.015, x, y, z, 8);
  },
  // ---- on the walls ----
  // Each hangs with its back flat on the wall at z = 0, facing the room (+z),
  // centred on the point it hangs from. Its `surface` and `mount` in the
  // catalogue are measured from that point.
  wall_shelf(b) {
    // The plank's top is the catalogue's surface, at y = 0.13.
    b.box(PALE_WOOD, 0.8, 0.04, 0.26, 0, 0.09, 0.13);
    b.box(DARK_WOOD, 0.8, 0.03, 0.03, 0, 0.09, 0.255);
    for (const x of [-0.28, 0.28]) {
      b.box(DARK_WOOD, 0.04, 0.24, 0.04, x, -0.15, 0.02);
      b.box(DARK_WOOD, 0.04, 0.04, 0.2, x, 0.05, 0.1);
      b.box(IRON, 0.035, 0.035, 0.16, x, -0.06, 0.07).rotation.x = Math.PI / 4;
    }
  },
  painting(b) {
    b.box(GOLD, 0.62, 0.46, 0.04, 0, -0.23, 0.02);
    b.box("#8fc3e6", 0.52, 0.2, 0.02, 0, -0.01, 0.04);
    b.box("#2f6aa3", 0.52, 0.16, 0.02, 0, -0.17, 0.04);
    b.box("#f4efe1", 0.06, 0.1, 0.02, 0.08, -0.07, 0.05);
    b.box("#6a4a2a", 0.14, 0.03, 0.02, 0.08, -0.1, 0.05);
    b.box("#fff3c4", 0.07, 0.07, 0.015, -0.17, 0.12, 0.05);
  },
  wall_chart(b) {
    b.box("#e6d7a8", 0.62, 0.42, 0.015, 0, -0.21, 0.01);
    for (const [w, h, x, y] of [[0.16, 0.12, -0.14, 0.04], [0.12, 0.1, 0.14, -0.08], [0.08, 0.06, -0.02, -0.12], [0.06, 0.05, 0.18, 0.1]]) b.box("#6b8c5a", w, h, 0.01, x, y - h / 2, 0.02);
    b.box("#b9433d", 0.03, 0.03, 0.01, 0.06, 0.04, 0.025);
    for (const [x, y] of [[-0.28, 0.18], [0.28, 0.18], [-0.28, -0.18], [0.28, -0.18]]) b.box(IRON, 0.03, 0.03, 0.02, x, y - 0.015, 0.02);
    b.roll("#d8c48e", 0.022, 0.66, 0, 0.21, 0.025);
    b.roll("#d8c48e", 0.022, 0.66, 0, -0.21, 0.025);
  },
  sconce(b) {
    b.box(IRON, 0.12, 0.22, 0.03, 0, -0.2, 0.015);
    b.box(IRON, 0.04, 0.04, 0.16, 0, -0.14, 0.09);
    b.post(IRON, 0.07, 0.05, 0.03, 0, -0.12, 0.17);
    b.post("#efe6c8", 0.03, 0.03, 0.12, 0, -0.09, 0.17);
    b.flame("#ffb03a", 0.035, 0.06, 0.035, 0, 0.03, 0.17);
    b.flame("#fff0a0", 0.018, 0.035, 0.018, 0, 0.035, 0.174);
    b.light("candle", 0, 0.13, 0.22);
  },
  wall_lantern(b) {
    b.box(IRON, 0.1, 0.16, 0.03, 0, 0.06, 0.015);
    b.box(IRON, 0.03, 0.03, 0.2, 0, 0.18, 0.11);
    b.box(IRON, 0.02, 0.06, 0.02, 0, 0.12, 0.2);
    b.box("#b87333", 0.18, 0.03, 0.18, 0, -0.18, 0.2);
    b.glow("#ffd98a", new THREE.BoxGeometry(0.14, 0.17, 0.14), 0, -0.06, 0.2);
    for (const [x, z] of [[-0.075, 0.125], [0.075, 0.125], [-0.075, 0.275], [0.075, 0.275]]) b.box("#8a5a2a", 0.02, 0.17, 0.02, x, -0.15, z);
    b.cone("#b87333", 0.13, 0.08, 0, 0.02, 0.2);
    b.light("lamp", 0, -0.06, 0.32);
  },
  ship_wheel(b) {
    b.ball(DARK_WOOD, 0.08, 0, 0, 0.07);
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const spoke = b.box(WOOD, 0.035, 0.66, 0.035, 0, -0.33, 0.07);
      spoke.position.set(0, 0, 0.07);
      spoke.rotation.z = a;
      // A handle past the rim.
      b.post(PALE_WOOD, 0.022, 0.022, 0.06, Math.sin(a) * 0.33, Math.cos(a) * 0.33 - 0.03, 0.07, 5).rotation.z = -a;
    }
    b.ring(WOOD, 0.25, 0.03, 0, 0, 0.07);
  },
  crossed_blades(b) {
    b.box(DARK_WOOD, 0.34, 0.4, 0.04, 0, -0.2, 0.02);
    b.box(GOLD, 0.2, 0.22, 0.02, 0, -0.11, 0.045);
    for (const turn of [0.7, -0.7]) {
      const blade = b.box("#cfd6e0", 0.05, 0.62, 0.02, 0, -0.31, 0.07);
      blade.position.set(0, 0, 0.07);
      blade.rotation.z = turn;
      const guard = b.box(GOLD, 0.14, 0.03, 0.03, 0, 0, 0.075);
      guard.position.set(Math.sin(turn) * 0.2, -Math.cos(turn) * 0.2, 0.075);
      guard.rotation.z = turn;
    }
  },
  // ---- the smithy's walls: her work hung up for sale (packages/world/src/keepers.ts). Each hangs from its top. ----
  // A longsword hung point down between two pegs, with a red-wrapped grip and a brass guard.
  wall_sword(b) {
    for (const x of [-0.12, 0.12]) b.box(DARK_WOOD, 0.04, 0.04, 0.08, x, -0.3, 0.04);
    b.ball(GOLD, 0.04, 0, -0.05, 0.06, 0);
    b.box("#7a2f2f", 0.045, 0.18, 0.04, 0, -0.26, 0.06);
    b.box(GOLD, 0.26, 0.04, 0.05, 0, -0.3, 0.06);
    b.box("#cfd6e0", 0.07, 0.7, 0.02, 0, -1.0, 0.06);
    b.box("#eef2f6", 0.02, 0.66, 0.022, 0, -0.98, 0.065);
    b.cone("#cfd6e0", 0.05, 0.08, 0, -1.07, 0.06, 4).rotation.z = Math.PI;
  },
  // A round shield, red with an iron rim and boss, two axes crossed behind it.
  wall_shield_axes(b) {
    for (const turn of [0.65, -0.65]) {
      const handle = b.box(DARK_WOOD, 0.035, 0.84, 0.03, 0, 0, 0.03);
      handle.position.set(0, -0.42, 0.03);
      handle.rotation.z = turn;
      const head = b.box("#8b95a5", 0.18, 0.13, 0.025, 0, 0, 0.035);
      head.position.set(-Math.sin(turn) * 0.36 + Math.cos(turn) * 0.06 * Math.sign(turn), -0.42 + Math.cos(turn) * 0.36 + Math.sin(turn) * 0.06 * Math.sign(turn), 0.035);
      head.rotation.z = turn;
    }
    const face = b.post("#8a2f2a", 0.26, 0.26, 0.04, 0, 0, 0, 14);
    face.rotation.x = Math.PI / 2;
    face.position.set(0, -0.42, 0.07);
    b.ring(IRON, 0.255, 0.022, 0, -0.42, 0.09);
    for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) b.box(IRON, 0.02, 0.2, 0.012, Math.sin(a) * 0.12, -0.42 - 0.1 + Math.cos(a) * 0.12, 0.092).rotation.z = a;
    b.ball(IRON, 0.06, 0, -0.42, 0.1, 1);
  },
  // A warhammer and a mace crossed, hung on a board.
  wall_hammers(b) {
    b.box(DARK_WOOD, 0.5, 0.12, 0.04, 0, -0.14, 0.02);
    for (const [turn, kind] of [[0.5, "hammer"], [-0.5, "mace"]] as const) {
      const haft = b.box(PALE_WOOD, 0.035, 0.78, 0.03, 0, 0, 0.06);
      haft.position.set(0, -0.48, 0.06);
      haft.rotation.z = turn;
      const [hx, hy] = [-Math.sin(turn) * 0.34, -0.48 + Math.cos(turn) * 0.34];
      if (kind === "hammer") {
        const head = b.box("#5b606c", 0.22, 0.09, 0.08, 0, 0, 0.06);
        head.position.set(hx, hy, 0.06);
        head.rotation.z = turn;
      } else {
        b.ball("#5b606c", 0.08, hx, hy, 0.06, 0);
        for (const a of [0, 1.6, 3.2, 4.8]) b.cone("#8b95a5", 0.025, 0.06, hx + Math.sin(a) * 0.08, hy - 0.03 + Math.cos(a) * 0.08, 0.06, 4);
      }
    }
  },
  mounted_fish(b) {
    b.box(DARK_WOOD, 0.52, 0.3, 0.04, 0, -0.15, 0.02);
    b.box(GOLD, 0.12, 0.03, 0.01, 0, -0.13, 0.045);
    b.box("#6f9cb0", 0.36, 0.13, 0.08, -0.02, -0.03, 0.08);
    b.box("#8fb8c8", 0.12, 0.1, 0.07, 0.16, -0.025, 0.08);
    b.cone("#5f8a9c", 0.08, 0.12, -0.25, -0.0, 0.08, 3).rotation.z = Math.PI / 2;
    b.box("#1f2430", 0.02, 0.02, 0.01, 0.19, 0.0, 0.12);
  },

  // The pub's leaderboard: a big slate standing on two legs against the back wall, as wide as a hex,
  // chalked in four columns (dice, Shoals, Cargo and Krakens, Turn the Tide) under a sign, with a chalk tray.
  // Its back is at z = 0 side of the frame; it faces +z, into the room.
  tally_board(b) {
    const CHALK = "#e9ecef";
    const W = 1.56;
    // Legs and feet.
    for (const x of [-W / 2 - 0.02, W / 2 + 0.02]) {
      b.box(DARK_WOOD, 0.07, 1.86, 0.07, x, 0, 0);
      b.box(DARK_WOOD, 0.1, 0.05, 0.34, x, 0, 0.04);
    }
    // The frame and the slate in it, from knee height to well over a hero's head.
    b.box(DARK_WOOD, W, 1.02, 0.06, 0, 0.5, 0);
    b.box("#2c3a33", W - 0.1, 0.92, 0.02, 0, 0.55, 0.035);
    // The sign over it.
    b.box(PALE_WOOD, 0.9, 0.2, 0.05, 0, 1.6, 0.01);
    b.box(GOLD, 0.74, 0.03, 0.01, 0, 1.69, 0.04);
    for (const x of [-0.3, 0.3]) b.box(IRON, 0.02, 0.1, 0.02, x, 1.52, 0.01);
    // Column rules, and a line under the heads.
    for (const x of [-0.36, 0, 0.36]) b.box(CHALK, 0.012, 0.82, 0.006, x, 0.58, 0.05);
    b.box(CHALK, W - 0.2, 0.012, 0.006, 0, 1.24, 0.05);
    // Each column's head: a die, a Shoals marker, a gold piece, a playing card.
    b.box("#f4efe1", 0.1, 0.1, 0.06, -0.54, 1.28, 0.06);
    for (const [x, y] of [[-0.565, 1.3], [-0.515, 1.35]]) b.box("#1f2430", 0.02, 0.02, 0.005, x, y, 0.09);
    b.post("#6f9cb0", 0.055, 0.055, 0.04, -0.18, 1.33, 0.06, 8).rotation.x = Math.PI / 2;
    b.post(GOLD, 0.05, 0.05, 0.02, 0.18, 1.33, 0.055, 8).rotation.x = Math.PI / 2;
    const card = b.box("#f4efe1", 0.08, 0.12, 0.01, 0.54, 1.27, 0.055);
    card.rotation.z = -0.15;
    b.box("#b9433d", 0.03, 0.03, 0.005, 0.545, 1.315, 0.062).rotation.z = Math.PI / 4;
    // Tallies, a row a player: four strokes and a fifth across.
    const counts = [[7, 3, 6, 4], [4, 6, 2, 5], [2, 1, 4, 1], [1, 2, 0, 3]];
    counts.forEach((row, i) => row.forEach((n, col) => {
      const left = -0.68 + col * 0.36;
      const y = 1.06 - i * 0.16;
      for (let k = 0; k < n; k++) {
        const group = Math.floor(k / 5);
        const inGroup = k % 5;
        if (inGroup < 4) b.box(CHALK, 0.02, 0.1, 0.005, left + group * 0.15 + inGroup * 0.026, y, 0.05);
        else b.box(CHALK, 0.12, 0.02, 0.005, left + group * 0.15 + 0.039, y + 0.045, 0.051).rotation.z = 0.6;
      }
    }));
    // The chalk tray and a stick of chalk in it.
    b.box(PALE_WOOD, W, 0.04, 0.12, 0, 0.47, 0.07);
    b.roll(CHALK, 0.016, 0.12, 0.3, 0.53, 0.09);
  },

  // Boats, as they show in the craft list (on the water they are drawn under the hero by the renderer).
  float_barrel(b) {
    b.post(WOOD, 0.26, 0.23, 0.36);
    for (const y of [0.06, 0.28]) b.ring(IRON, 0.25, 0.012, 0, y, 0).rotation.x = Math.PI / 2;
  },
  rowboat(b) {
    b.box(WOOD, 0.46, 0.16, 0.9, 0, 0, 0);
    b.box(DARK_WOOD, 0.38, 0.01, 0.8, 0, 0.16, 0);
    b.box(PALE_WOOD, 0.9, 0.02, 0.05, 0, 0.15, -0.05);
  },

  // The Catch Book's rewards, one per page, and Old Ironjaw's jaw.
  shallows_chart(b) {
    b.box("#e6d7a8", 0.62, 0.44, 0.015, 0, -0.22, 0.01);
    b.box("#7fb0b8", 0.56, 0.38, 0.01, 0, -0.19, 0.02);
    for (const [w, h, x, y] of [[0.2, 0.05, -0.12, 0.08], [0.14, 0.04, 0.12, -0.04], [0.1, 0.035, -0.05, -0.12]]) b.box("#e8dcb0", w, h, 0.01, x, y - h / 2, 0.026);
    for (const [x, y] of [[0.16, 0.1], [-0.18, -0.06], [0.02, 0.0], [0.2, -0.13]]) b.box("#4a7a3a", 0.035, 0.035, 0.01, x, y, 0.028);
    b.box("#b9433d", 0.025, 0.025, 0.01, -0.22, 0.12, 0.03);
    b.roll("#d8c48e", 0.022, 0.66, 0, 0.22, 0.025);
    b.roll("#d8c48e", 0.022, 0.66, 0, -0.22, 0.025);
  },
  brass_spyglass(b) {
    for (const x of [-0.18, 0.18]) b.box(DARK_WOOD, 0.04, 0.1, 0.1, x, -0.12, 0.05);
    b.roll(GOLD, 0.05, 0.26, -0.16, 0.0, 0.1);
    b.roll("#c89a2a", 0.04, 0.2, 0.06, 0.0, 0.1);
    b.roll(GOLD, 0.03, 0.16, 0.22, 0.0, 0.1);
    b.roll(DARK_WOOD, 0.052, 0.05, -0.08, 0.0, 0.1);
  },
  lamp_lens(b) {
    b.box(IRON, 0.08, 0.06, 0.04, 0, 0.18, 0.02);
    for (const [r, t] of [[0.2, 0.025], [0.15, 0.022], [0.1, 0.02], [0.05, 0.018]]) b.glass(b.ring("#bfe6f0", r, t, 0, -0.05, 0.07), 0.6);
    b.glow("#fff3c0", new THREE.SphereGeometry(0.035, 8, 6), 0, -0.05, 0.08);
  },
  crossed_oars(b) {
    for (const s of [-1, 1]) {
      const shaft = b.box(PALE_WOOD, 0.035, 0.86, 0.03, 0, -0.43, 0.04);
      shaft.position.set(0, 0, 0.04);
      shaft.rotation.z = s * 0.62;
      const blade = b.box(WOOD, 0.1, 0.24, 0.02, 0, 0, 0.05);
      // At the lower end of the shaft: turned by a, its +y end goes to (-sin a, cos a), so the lower end is the opposite.
      blade.position.set(Math.sin(s * 0.62) * 0.33, -Math.cos(0.62) * 0.33, 0.05);
      blade.rotation.z = s * 0.62;
    }
    b.box("#8a6a3a", 0.08, 0.05, 0.06, 0, -0.03, 0.06);
  },
  lobster_pot(b) {
    b.box(DARK_WOOD, 0.46, 0.04, 0.24, 0, -0.18, 0.12);
    for (const x of [-0.2, -0.07, 0.07, 0.2]) {
      const hoop = b.ring(PALE_WOOD, 0.13, 0.012, x, -0.16, 0.12);
      hoop.rotation.y = Math.PI / 2;
    }
    for (let i = 0; i < 5; i++) {
      const a = (i / 4) * Math.PI;
      b.box("#c8b88a", 0.44, 0.012, 0.012, 0, -0.16 + Math.sin(a) * 0.13 - 0.006, 0.12 + Math.cos(a) * 0.13);
    }
    b.ring("#8a8a6a", 0.06, 0.012, 0.23, -0.1, 0.12).rotation.y = Math.PI / 2;
  },
  glass_floats(b) {
    for (let i = 0; i < 5; i++) b.box("#3a3020", 0.66, 0.008, 0.008, 0, -0.2 + i * 0.1, 0.03);
    for (let i = 0; i < 7; i++) b.box("#3a3020", 0.008, 0.46, 0.008, -0.3 + i * 0.1, -0.23, 0.03);
    for (const [x, y, r, c] of [[-0.18, 0.0, 0.08, "#4a9a7a"], [0.04, -0.06, 0.1, "#3a7ab0"], [0.22, 0.04, 0.07, "#6ab0a0"], [-0.06, 0.1, 0.06, "#4a6ab0"], [0.14, -0.15, 0.06, "#5aa080"]] as const) {
      b.glass(b.ball(c, r, x, y, 0.08, 2), 0.75);
    }
  },
  ironjaw_jaw(b) {
    const jaw = b.ring("#d8d0bc", 0.27, 0.045, 0, -0.04, 0.06);
    jaw.scale.set(1, 0.7, 1);
    for (let i = 0; i < 13; i++) {
      const a = Math.PI * 0.15 + (i / 12) * Math.PI * 1.7;
      const tooth = b.cone("#f4f0e4", 0.025, 0.08, Math.cos(a) * 0.22, -0.04 + Math.sin(a) * 0.15, 0.07, 3);
      tooth.rotation.z = a + Math.PI / 2;
    }
    for (const [x, y] of [[-0.18, 0.1], [0.05, 0.17], [0.2, -0.12], [-0.1, -0.2]]) b.ring(IRON, 0.025, 0.006, x, y, 0.1);
    b.box(DARK_WOOD, 0.62, 0.5, 0.03, 0, -0.29, 0.0);
  },

  // Far goods, sold only by a traveling salesman.
  globe(b) {
    b.post(DARK_WOOD, 0.08, 0.2, 0.08);
    b.post(DARK_WOOD, 0.04, 0.05, 0.5, 0, 0.08, 0, 5);
    b.ball("#3f7fb8", 0.24, 0, 0.8, 0);
    // A couple of guessed-at coastlines, and the brass ring it turns in.
    b.box("#7aa64a", 0.16, 0.12, 0.06, 0.06, 0.78, 0.2);
    b.box("#7aa64a", 0.1, 0.08, 0.06, -0.14, 0.86, 0.16);
    b.box(GOLD, 0.04, 0.56, 0.04, 0.27, 0.52, 0);
    b.box(GOLD, 0.04, 0.56, 0.04, -0.27, 0.52, 0);
  },
  ship_bottle(b) {
    // A low stand, a green glass bottle on its side, and the little ship inside.
    b.box(DARK_WOOD, 0.7, 0.36, 0.32);
    b.box(WOOD, 0.74, 0.04, 0.36, 0, 0.36);
    b.box(DARK_WOOD, 0.24, 0.3, 0.2, 0, 0.4);
    b.box(WOOD, 0.28, 0.05, 0.08, 0, 0.42);
    b.box(CLOTH, 0.02, 0.18, 0.14, 0, 0.47);
    const glass = b.box("#b8e0cc", 0.56, 0.22, 0.22, 0, 0.4);
    const m = glass.material as THREE.MeshLambertMaterial;
    m.transparent = true;
    m.opacity = 0.4;
    m.depthWrite = false;
    b.box("#b8e0cc", 0.12, 0.1, 0.1, 0.34, 0.46);
    b.box("#8a6a44", 0.05, 0.08, 0.08, 0.42, 0.47);
  },
  shell_chimes(b) {
    b.post(IRON, 0.14, 0.18, 0.06);
    b.post(DARK_WOOD, 0.04, 0.04, 1.35, 0, 0.06, 0, 5);
    b.box(DARK_WOOD, 0.66, 0.05, 0.05, 0, 1.3);
    // Strings of shells hanging off the arm.
    [-0.28, -0.14, 0.14, 0.28].forEach((x, i) => {
      const drop = 0.3 + (i % 2) * 0.12;
      b.box("#d8d0c0", 0.01, drop, 0.01, x, 1.3 - drop);
      b.cone(i % 2 ? "#f4d9c6" : "#f4efe1", 0.06, 0.1, x, 1.24 - drop, 0, 6);
    });
  },
  trophy_relic(b) {
    b.pedestal();
    b.glow("#ffd23f", new THREE.OctahedronGeometry(0.2), 0, 0.82, 0);
    b.post(GOLD, 0.14, 0.1, 0.1, 0, 0.5);
  },
  trophy_token(b) {
    b.pedestal();
    // A ribboned keepsake box.
    b.box("#c96a8a", 0.34, 0.22, 0.28, 0, 0.5);
    b.box(GOLD, 0.36, 0.23, 0.07, 0, 0.5);
    b.box(GOLD, 0.07, 0.23, 0.3, 0, 0.5);
    b.cone(GOLD, 0.09, 0.1, 0, 0.72);
  },
  trophy_pelt(b) {
    b.pedestal();
    // A pelt draped over a rail, with a pair of fangs.
    for (const x of [-0.26, 0.26]) b.post(DARK_WOOD, 0.03, 0.03, 0.6, x, 0.5, 0, 5);
    b.box(DARK_WOOD, 0.6, 0.05, 0.05, 0, 1.08);
    b.box("#7a5a3a", 0.5, 0.5, 0.07, 0, 0.6, 0.02);
    b.box("#5a4028", 0.34, 0.14, 0.09, 0, 0.98, 0.02);
    for (const x of [-0.08, 0.08]) b.cone("#f4efe1", 0.035, 0.12, x, 0.5, 0.2);
  },
  trophy_core(b) {
    b.pedestal();
    b.glow("#5ce1e6", new THREE.IcosahedronGeometry(0.2, 0), 0, 0.84, 0);
    for (const a of [0, 2.1, 4.2]) b.box(IRON, 0.06, 0.34, 0.06, Math.sin(a) * 0.22, 0.5, Math.cos(a) * 0.22);
  },
};

/** Anything without a model of its own is drawn as a crate, so it is still visible and movable. */
function crate(b: Builder) {
  b.box(WOOD, 0.6, 0.6, 0.6);
  b.box(DARK_WOOD, 0.64, 0.08, 0.64, 0, 0.26);
}

/** A pale see-through copy of a model, to show where something being carried would go. Red when it cannot go there. */
export function ghostModel(model: string): THREE.Group {
  const g = propModel(model);
  g.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.material = new THREE.MeshBasicMaterial({ color: "#bfe8ff", transparent: true, opacity: 0.55, depthWrite: false });
    o.castShadow = o.receiveShadow = false;
    o.userData.flame = undefined;
  });
  g.traverse((o) => {
    if (o.userData.light) o.userData.light = undefined;
  });
  return g;
}

/** Tint a ghost: pale blue where it fits, red where it does not. */
export function tintGhost(g: THREE.Group, ok: boolean) {
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) (o.material as THREE.MeshBasicMaterial).color.set(ok ? "#bfe8ff" : "#ff6b6b");
  });
}

export const PROP_MODELS = Object.keys(MODELS);

/** A fresh model for a furnishing, standing on the origin. */
export function propModel(model: string): THREE.Group {
  const b = new Builder();
  (MODELS[model] ?? crate)(b);
  return b.group;
}
