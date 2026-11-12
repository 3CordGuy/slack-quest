// Furniture for a hut's room: small low-poly models built from primitives,
// in the same style as the places on the map (WorldRenderer.poiModel). One
// per `model` key in the FURNISHINGS catalogue.
//
// Each model sits on the origin of its hex, fits inside it, and faces the
// camera (+z) at facing 0. The renderer turns the whole group to face it.

import * as THREE from "three";

/** The kinds of light a piece can give; Ambience sets how bright and how far each one reaches. */
export type LightKind = "fire" | "candle" | "lamp";

const WOOD = "#8a6a44";
const DARK_WOOD = "#5a3d22";
const PALE_WOOD = "#b98b5a";
const IRON = "#6f7480";
const STONE = "#9a968c";
const CLOTH = "#e8dcc0";
const GOLD = "#e0b12e";

class Builder {
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
    return this.mesh(geometry, new THREE.MeshBasicMaterial({ color }), x, y, z);
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

  /** A fire's light: warm, flickering, and the one that throws shadows indoors. */
  fire(x: number, y: number, z: number): this {
    return this.light("fire", x, y, z);
  }

  /** A cylinder lying on its side along x, its middle at (x, y, z). */
  roll(color: string, radius: number, length: number, x = 0, y = 0, z = 0, sides = 6): THREE.Mesh {
    const mesh = this.mesh(new THREE.CylinderGeometry(radius, radius, length, sides), new THREE.MeshLambertMaterial({ color, flatShading: true }), x, y, z);
    mesh.rotation.z = Math.PI / 2;
    return mesh;
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
