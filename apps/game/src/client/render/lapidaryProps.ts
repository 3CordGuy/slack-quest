// The Lapidary's fittings (packages/world/src/keepers.ts): the furniture of
// the workshop where lodestones are cut and gems are bought. Never sold, and
// never moved. Built like the rest of the furniture (props.ts spreads these
// into its models): each sits on the origin of its hex and faces +z.

import * as THREE from "three";
import type { Builder } from "./props";

const WOOD = "#8a6a44";
const DARK_WOOD = "#5a3d22";
const PALE_WOOD = "#b98b5a";
const IRON = "#6f7480";
const BRASS = "#c79a3e";
const COPPER = "#b87333";
const CLOTH = "#e8dcc0";
const VELVET = "#2a2440";
/** A lodestone not yet woken, and one that has taken its light. */
const LODE = "#39445a";
const LODE_LIT = "#7fd0ff";
/** Cut gems, in the colours they come in. The first is the game's own gem pink. */
const GEMS = ["#ff7ae0", "#4fd6c8", "#ffb84a", "#8cff7a", "#b48cff", "#7fd0ff"];
/** Rough stone, as it comes out of the quarry. */
const ROUGH = ["#7b8088", "#9a9ea6", "#6c7079", "#8a8478"];

/** A cut stone: two pyramids base to base, a little taller than wide. Glowing ones are drawn unlit. */
function stone(b: Builder, color: string, size: number, x: number, y: number, z: number, glow = false, turn = 0): THREE.Mesh {
  const geometry = new THREE.OctahedronGeometry(size, 0);
  let mesh: THREE.Mesh;
  if (glow) mesh = b.glow(color, geometry, x, y, z);
  else {
    mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color, flatShading: true }));
    mesh.position.set(x, y, z);
    b.group.add(mesh);
  }
  mesh.scale.y = 1.3;
  mesh.rotation.y = turn;
  return mesh;
}

/** A lump of rough stone. */
function lump(b: Builder, color: string, size: number, x: number, y: number, z: number, turn = 0) {
  const mesh = new THREE.Mesh(new THREE.DodecahedronGeometry(size, 0), new THREE.MeshLambertMaterial({ color, flatShading: true }));
  mesh.position.set(x, y, z);
  mesh.rotation.set(turn, turn * 1.7, 0);
  b.group.add(mesh);
}

/** A fat candle with its flame, standing on `y`, and the light it gives. */
function candle(b: Builder, x: number, y: number, z: number) {
  b.post(CLOTH, 0.04, 0.045, 0.14, x, y, z, 6);
  b.flame("#ffd98a", 0.04, 0.07, 0.04, x, y + 0.14, z);
  b.light("candle", x, y + 0.24, z);
}

/** The shelves of rough stone and split geodes, shared by the plain one and the one with a candle on top. */
function stoneShelf(b: Builder) {
  b.box(DARK_WOOD, 0.98, 1.5, 0.36, 0, 0, -0.14);
  b.box("#4a321c", 1.04, 0.06, 0.4, 0, 1.5, -0.14);
  // A cupboard at the foot, its two doors shut on brass knobs.
  for (const x of [-0.23, 0.23]) {
    b.box(WOOD, 0.42, 0.24, 0.03, x, 0.05, 0.05);
    b.ball(BRASS, 0.022, x * 0.25, 0.17, 0.075, 0);
  }
  for (let shelf = 0; shelf < 3; shelf++) {
    const y = 0.36 + shelf * 0.38;
    b.box("#2a2018", 0.88, 0.32, 0.05, 0, y, -0.02);
    b.box(WOOD, 0.9, 0.03, 0.3, 0, y - 0.03, -0.08);
    if (shelf === 0) {
      // Rough stone, as it came off the cart.
      for (let i = 0; i < 5; i++) lump(b, ROUGH[i % ROUGH.length], 0.07 + (i % 2) * 0.02, -0.34 + i * 0.17, y + 0.07, 0.02, i * 1.3);
    } else if (shelf === 1) {
      // Geodes split open: grey outside, a hollow of crystal within, turned to show it.
      for (const [x, color] of [[-0.28, "#b48cff"], [0, "#4fd6c8"], [0.28, "#ff7ae0"]] as const) {
        b.ball("#77736b", 0.11, x, y + 0.1, 0, 0).scale.set(1, 0.9, 0.7);
        b.glow(color, new THREE.CircleGeometry(0.075, 7), x, y + 0.1, 0.08);
      }
    } else {
      // Jars of grit and polish, and a roll or two of notes.
      for (const [x, color] of [[-0.32, "#c9c5bb"], [-0.18, "#8a5a3a"], [-0.04, "#d8cfb4"]] as const) {
        b.glass(b.post("#cfe4ea", 0.05, 0.05, 0.15, x, y, 0.02, 8), 0.5);
        b.post(color, 0.042, 0.042, 0.09, x, y + 0.005, 0.02, 8);
        b.post(DARK_WOOD, 0.052, 0.052, 0.02, x, y + 0.15, 0.02, 8);
      }
      b.roll(CLOTH, 0.035, 0.3, 0.24, y + 0.035, 0.02, 7);
      b.roll("#d9c9a0", 0.03, 0.26, 0.26, y + 0.095, 0.0, 7);
    }
  }
}

export const LAPIDARY_MODELS: Record<string, (b: Builder) => void> = {
  /**
   * The cutting wheel, the lapidary's own work: a heavy bench with a splash pan let into its top and, turning flat
   * in the pan, a lap of copper charged with grit, on a spindle driven from a flywheel and a treadle underneath. A
   * can on an arm drips water onto the lap, a block beside it holds the dops, each with a stone set in wax on its
   * end, and at the back corner stands her work lamp: a flame behind a globe of water, which throws its light in one
   * bright spot on the stone. She holds a stone to the lap and works it round and round.
   */
  lap_wheel(b) {
    // The bench: four square legs, rails, and a thick top.
    for (const [x, z] of [[-0.4, -0.3], [0.4, -0.3], [-0.4, 0.3], [0.4, 0.3]]) b.box(DARK_WOOD, 0.1, 0.5, 0.1, x, 0, z);
    for (const z of [-0.3, 0.3]) b.box(DARK_WOOD, 0.8, 0.06, 0.05, 0, 0.12, z);
    b.box(WOOD, 0.96, 0.08, 0.76, 0, 0.5);
    // The splash pan and the lap in it: a rim of dark wood, wet slate, and the copper wheel with its ring of grit.
    b.post(DARK_WOOD, 0.36, 0.36, 0.06, 0.06, 0.58, 0.02, 12);
    b.post("#3d4a52", 0.32, 0.32, 0.02, 0.06, 0.625, 0.02, 12);
    b.post(COPPER, 0.26, 0.26, 0.035, 0.06, 0.64, 0.02, 16);
    b.post("#8a8f96", 0.2, 0.2, 0.006, 0.06, 0.676, 0.02, 16);
    b.post(BRASS, 0.035, 0.035, 0.03, 0.06, 0.676, 0.02, 8);
    // Under the top: the spindle, the flywheel on it, and the treadle with its rod.
    b.post(IRON, 0.025, 0.025, 0.4, 0.06, 0.1, 0.02, 6);
    b.post("#4a4e58", 0.24, 0.24, 0.05, 0.06, 0.22, 0.02, 12);
    b.box(PALE_WOOD, 0.3, 0.03, 0.2, 0.1, 0.02, 0.34).rotation.x = -0.18;
    b.box(IRON, 0.02, 0.2, 0.02, 0.1, 0.04, 0.26);
    // The drip can, on an arm from the back corner out over the lap.
    b.box(IRON, 0.03, 0.42, 0.03, -0.4, 0.58, -0.3);
    const arm = b.box(IRON, 0.36, 0.025, 0.025, -0.25, 0.97, -0.2);
    arm.rotation.y = 0.55;
    b.post(COPPER, 0.06, 0.045, 0.1, -0.1, 0.86, -0.1, 8);
    b.box(COPPER, 0.012, 0.06, 0.012, -0.06, 0.8, -0.06);
    // The dop block: a block of wood drilled for the dops, three standing in it with a stone on each.
    b.box(DARK_WOOD, 0.22, 0.06, 0.1, -0.3, 0.58, 0.26);
    GEMS.slice(0, 3).forEach((color, i) => {
      const x = -0.37 + i * 0.07;
      b.post(PALE_WOOD, 0.012, 0.014, 0.14, x, 0.62, 0.26, 5);
      b.ball("#3a2a22", 0.02, x, 0.77, 0.26, 0);
      stone(b, color, 0.022, x, 0.8, 0.26, i === 0, i);
    });
    // The work lamp at the back corner, away from her: a brass foot, a flame, and the globe of water before it.
    const [lx, lz] = [-0.3, -0.12];
    b.post(BRASS, 0.07, 0.09, 0.03, lx, 0.58, lz, 8);
    b.post(BRASS, 0.018, 0.018, 0.16, lx, 0.61, lz, 6);
    b.post(BRASS, 0.045, 0.03, 0.03, lx, 0.77, lz, 8);
    b.flame("#ffd98a", 0.04, 0.08, 0.04, lx, 0.8, lz);
    b.glass(b.ball("#cfeaff", 0.085, lx + 0.1, 0.84, lz + 0.08, 1), 0.38);
    b.post(BRASS, 0.012, 0.03, 0.2, lx + 0.1, 0.58, lz + 0.08, 6);
    b.light("lamp", lx + 0.1, 1.15, lz + 0.2);
  },
  /**
   * The case of lodestones, against the back wall: a tall cabinet with a glazed front, three shelves of stones each
   * on its own little stand, some dark and some that have taken their light and give it off through the glass, and
   * a row of drawers at the foot. Its glow is the blue in the room.
   */
  lodestone_case(b) {
    b.box(DARK_WOOD, 0.98, 1.5, 0.36, 0, 0, -0.14);
    b.box("#4a321c", 1.06, 0.07, 0.42, 0, 1.5, -0.14);
    b.box(BRASS, 0.5, 0.03, 0.02, 0, 1.52, 0.07);
    for (let i = 0; i < 3; i++) {
      b.box(WOOD, 0.28, 0.2, 0.03, -0.31 + i * 0.31, 0.06, 0.05);
      b.box(BRASS, 0.06, 0.025, 0.02, -0.31 + i * 0.31, 0.15, 0.07);
    }
    // The inside: lined dark, so the stones show.
    b.box("#1c1a26", 0.88, 1.12, 0.05, 0, 0.32, -0.04);
    const lit = [[1, 0, 1, 0], [0, 1, 0, 1], [1, 0, 0, 1]];
    for (let shelf = 0; shelf < 3; shelf++) {
      const y = 0.34 + shelf * 0.37;
      b.box(WOOD, 0.9, 0.025, 0.28, 0, y - 0.025, -0.08);
      for (let i = 0; i < 4; i++) {
        const x = -0.33 + i * 0.22;
        const on = lit[shelf][i] === 1;
        b.post(BRASS, 0.03, 0.045, 0.03, x, y, 0, 6);
        stone(b, on ? LODE_LIT : LODE, 0.062, x, y + 0.115, 0, on, i + shelf);
        if (on) b.glow("#bfe6ff", new THREE.OctahedronGeometry(0.028, 0), x, y + 0.115, 0).scale.y = 1.3;
      }
    }
    // The glazing: a frame, a bar down the middle, and the glass.
    for (const x of [-0.46, 0, 0.46]) b.box(DARK_WOOD, 0.045, 1.14, 0.03, x, 0.31, 0.055);
    for (const y of [0.3, 1.42]) b.box(DARK_WOOD, 0.96, 0.045, 0.03, 0, y, 0.055);
    b.glass(b.box("#cfe4ea", 0.9, 1.1, 0.01, 0, 0.33, 0.05), 0.05);
    // Its light hangs well out in front of it, so it falls on the floor and whoever stands there, not flat on the glass.
    b.light("lode", 0, 0.9, 0.75);
  },
  /**
   * The stone trays, beside the case: a low chest of wide, shallow drawers, each lined with cloth and laid out with
   * sorted stones, two of them pulled open; and on its top a tray of the best, a pair of tongs and a brush.
   */
  stone_trays(b) {
    b.box(DARK_WOOD, 0.98, 0.8, 0.5, 0, 0, -0.1);
    b.box("#4a321c", 1.04, 0.05, 0.56, 0, 0.8, -0.1);
    for (let i = 0; i < 5; i++) {
      const y = 0.06 + i * 0.145;
      // The second and the fourth drawers stand open, further the lower.
      const out = i === 1 ? 0.2 : i === 3 ? 0.12 : 0;
      b.box(WOOD, 0.9, 0.12, 0.03, 0, y, 0.15 + out);
      b.box(BRASS, 0.12, 0.02, 0.02, 0, y + 0.05, 0.172 + out);
      if (!out) continue;
      b.box(WOOD, 0.9, 0.03, out, 0, y, 0.15 + out / 2);
      b.box(VELVET, 0.84, 0.01, out - 0.02, 0, y + 0.03, 0.15 + out / 2);
      for (let k = 0; k < 6; k++) stone(b, GEMS[(k + i) % GEMS.length], 0.026, -0.33 + k * 0.132, y + 0.07, 0.15 + out / 2, k === 2, k);
    }
    // On top: a tray of the best, and her tongs and brush.
    b.box(WOOD, 0.46, 0.03, 0.3, -0.2, 0.85, -0.1);
    b.box(VELVET, 0.4, 0.012, 0.24, -0.2, 0.872, -0.1);
    for (let k = 0; k < 6; k++) stone(b, GEMS[k], 0.034, -0.34 + (k % 3) * 0.14, 0.92, -0.17 + Math.floor(k / 3) * 0.13, k === 0 || k === 4, k * 0.7);
    b.box(IRON, 0.2, 0.012, 0.014, 0.26, 0.85, -0.02).rotation.y = 0.4;
    b.box(IRON, 0.2, 0.012, 0.014, 0.27, 0.85, 0.0).rotation.y = 0.52;
    b.box(PALE_WOOD, 0.16, 0.02, 0.025, 0.26, 0.85, -0.22).rotation.y = -0.3;
    b.box("#3a2a22", 0.05, 0.03, 0.03, 0.34, 0.85, -0.245).rotation.y = -0.3;
  },
  /**
   * The table she weighs and looks stones over on, at her back: a panelled counter with a brass balance, a loupe on
   * a stand over a square of dark cloth with a stone on it, a tray of gems, a ledger, and a candle to see by.
   */
  gem_table(b) {
    b.box(WOOD, 1.2, 0.62, 0.52);
    b.box(DARK_WOOD, 1.28, 0.06, 0.6, 0, 0.62);
    for (const x of [-0.38, 0, 0.38]) b.box(PALE_WOOD, 0.3, 0.42, 0.02, x, 0.1, 0.262);
    // The balance: a post, a beam and two pans, a gem in one and weights in the other.
    b.post(BRASS, 0.02, 0.03, 0.26, -0.36, 0.68, -0.04, 6);
    b.box(BRASS, 0.34, 0.02, 0.02, -0.36, 0.92, -0.04);
    for (const x of [-0.52, -0.2]) {
      b.box(BRASS, 0.008, 0.1, 0.008, x, 0.82, -0.04);
      b.post(BRASS, 0.07, 0.05, 0.02, x, 0.8, -0.04, 8);
    }
    stone(b, GEMS[0], 0.03, -0.52, 0.86, -0.04, true, 0.4);
    b.post("#4a4e58", 0.02, 0.025, 0.035, -0.2, 0.82, -0.04, 6);
    // The loupe on its stand: a brass ring with a glass in it on a bent arm, over a square of cloth and one stone.
    b.box(VELVET, 0.2, 0.012, 0.2, 0.06, 0.68, 0.08);
    stone(b, GEMS[1], 0.036, 0.06, 0.735, 0.08, true, 0.9);
    b.post(BRASS, 0.05, 0.06, 0.02, 0.2, 0.68, -0.06, 8);
    b.post(BRASS, 0.012, 0.012, 0.2, 0.2, 0.7, -0.06, 5);
    const arm = b.box(BRASS, 0.16, 0.014, 0.014, 0.14, 0.9, 0.0);
    arm.rotation.y = 0.8;
    const ring = b.ring(BRASS, 0.055, 0.012, 0.07, 0.89, 0.07);
    ring.rotation.x = Math.PI / 2;
    const lens = b.glass(b.post("#cfeaff", 0.05, 0.05, 0.008, 0.07, 0.886, 0.07, 10), 0.4);
    lens.userData.glass = true;
    // A tray of gems, a ledger with a pen across it, and a candle in a brass dish at the back corner.
    b.box(WOOD, 0.26, 0.025, 0.18, 0.42, 0.68, 0.1);
    b.box(VELVET, 0.22, 0.01, 0.14, 0.42, 0.7, 0.1);
    for (let k = 0; k < 4; k++) stone(b, GEMS[(k + 2) % GEMS.length], 0.026, 0.35 + (k % 2) * 0.13, 0.74, 0.06 + Math.floor(k / 2) * 0.08, k === 1, k);
    b.box("#6b2f2a", 0.2, 0.03, 0.26, 0.38, 0.68, -0.14).rotation.y = 0.15;
    b.box(CLOTH, 0.17, 0.008, 0.22, 0.38, 0.71, -0.14).rotation.y = 0.15;
    b.post(BRASS, 0.07, 0.06, 0.02, -0.52, 0.68, -0.2, 8);
    candle(b, -0.52, 0.7, -0.2);
  },
  // Shelves to head height: rough stone at the foot, geodes split open to show their crystal, jars of grit and polish.
  stone_shelf(b) {
    stoneShelf(b);
  },
  // The same shelves with a fat candle guttering on top: only one in the shop has one, so the light is in pools.
  stone_shelf_lit(b) {
    stoneShelf(b);
    b.box(CLOTH, 0.03, 0.08, 0.02, 0.33, 1.5, 0.06);
    candle(b, 0.3, 1.56, -0.04);
  },
  // The bin of rough, waiting to be cut: an iron-bound box heaped with stone, a seam of colour showing in a lump or
  // two, and the hammer and chisel she breaks it down with leaning in the corner.
  rough_bin(b) {
    b.box(DARK_WOOD, 0.8, 0.44, 0.62, 0, 0, -0.04);
    for (const y of [0.06, 0.32]) b.box(IRON, 0.82, 0.05, 0.64, 0, y, -0.04);
    b.box("#4a4e58", 0.7, 0.06, 0.52, 0, 0.4, -0.04);
    for (const [x, z, r, i] of [[-0.2, -0.1, 0.12, 0], [0.08, 0.0, 0.14, 1], [0.24, -0.16, 0.1, 2], [-0.04, -0.2, 0.11, 3], [-0.24, 0.1, 0.09, 0], [0.2, 0.12, 0.1, 2]]) lump(b, ROUGH[i], r, x, 0.5, z, x * 7);
    stone(b, GEMS[0], 0.035, 0.1, 0.63, 0.08, true, 0.5);
    stone(b, LODE_LIT, 0.03, -0.2, 0.6, -0.02, true, 1.1);
    b.post(PALE_WOOD, 0.02, 0.02, 0.6, 0.36, 0.1, 0.26, 5).rotation.z = -0.22;
    b.box("#5b606c", 0.14, 0.08, 0.08, 0.42, 0.66, 0.26);
    b.box(IRON, 0.025, 0.4, 0.025, -0.36, 0.1, 0.27).rotation.z = 0.2;
  },
};
