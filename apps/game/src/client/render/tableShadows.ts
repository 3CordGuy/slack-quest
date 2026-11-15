// Soft shadows on a game table's cloth, under the dice, markers, cards and
// coins (see TableStage): no shadow maps, just a dark smudge drawn under each
// piece, as the lantern hung over the table would throw. A piece lifted off
// the cloth (a die in the air, a card on its way) throws a wider, fainter one,
// pushed out from under the lantern.
//
// Every smudge on the table is one of two instanced meshes (round ones for
// discs and coins, squarish ones for dice and cards), so the whole lot is two
// draw calls. They darken what is under them (subtractive blending), each by
// its own amount, set in its instance colour.

import * as THREE from "three";

/** What a piece throws: a round smudge or a squarish one, and how dark, 0 to 1. Put on a mesh as `userData.shadow`. */
export interface Caster {
  round: boolean;
  dark: number;
}

/** How many smudges a table can show at once (six Cargo and Krakens seats of five dice, and room to spare). */
const MAX = 160;
/** How much wider than the piece its smudge is drawn: the soft edge reaches out past it. */
const SPREAD = 1.75;
/** Above this height off the cloth a piece throws no smudge at all. */
const FADE_H = 0.45;

/** A soft smudge, white (dark) in the middle to black (nothing) at the rim. `power` 2 is round, higher is squarer. */
function smudge(power: number): THREE.Texture {
  const N = 64;
  const c = document.createElement("canvas");
  c.width = c.height = N;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(N, N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = Math.abs((x + 0.5) / N - 0.5) * 2;
      const v = Math.abs((y + 0.5) / N - 0.5) * 2;
      const d = (u ** power + v ** power) ** (1 / power);
      // Dark under the piece itself, falling away smoothly to nothing at the rim.
      const k = THREE.MathUtils.clamp((d - 0.42) / 0.58, 0, 1);
      const a = Math.round(255 * (1 - k * k * (3 - 2 * k)));
      const i = (y * N + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = a;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

function layer(map: THREE.Texture): THREE.InstancedMesh {
  const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    map,
    transparent: true,
    premultipliedAlpha: true,
    blending: THREE.SubtractiveBlending,
    depthWrite: false,
    toneMapped: false,
    // Lying on the cloth: nudged toward the eye so the two do not fight.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, MAX);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
  mesh.count = 0;
  // Its instances move every frame; its bounds are never worked out again.
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  return mesh;
}

const p = new THREE.Vector3();
const s = new THREE.Vector3();
const q = new THREE.Quaternion();
const up = new THREE.Vector3();
const across = new THREE.Vector3();
const m = new THREE.Matrix4();
const turn = new THREE.Quaternion();
const Y = new THREE.Vector3(0, 1, 0);
const grey = new THREE.Color();

export class TableShadows {
  readonly group = new THREE.Group();
  private round = layer(smudge(2));
  private square = layer(smudge(5));

  /** `top`: the height of the cloth's surface in the table's own space; `light`: where the lantern's light hangs, in the same. */
  constructor(private top: number, private light: THREE.Vector3) {
    this.group.add(this.round, this.square);
  }

  /** Lay a smudge under every visible piece marked as a caster under `roots`. `space` is the table's own group. */
  update(roots: THREE.Object3D[], space: THREE.Object3D) {
    let nr = 0;
    let ns = 0;
    for (const root of roots) {
      root.traverseVisible((o) => {
        const c = o.userData.shadow as Caster | undefined;
        if (!c || !(o instanceof THREE.Mesh)) return;
        const target = c.round ? this.round : this.square;
        const n = c.round ? nr : ns;
        if (n >= MAX) return;
        const box = o.geometry.boundingBox ?? (o.geometry.computeBoundingBox(), o.geometry.boundingBox!);
        o.getWorldPosition(p);
        space.worldToLocal(p);
        o.getWorldScale(s);
        o.getWorldQuaternion(q);
        let hx = ((box.max.x - box.min.x) / 2) * s.x;
        const hy = ((box.max.y - box.min.y) / 2) * s.y;
        let hz = ((box.max.z - box.min.z) / 2) * s.z;
        // Lying flat, it throws its own outline turned its own way; tumbling (a die in the air), a square as wide as it.
        up.set(0, 1, 0).applyQuaternion(q);
        const flat = Math.abs(up.y) > 0.9;
        let yaw = 0;
        let bottom = hy;
        if (flat) {
          across.set(1, 0, 0).applyQuaternion(q);
          yaw = Math.atan2(-across.z, across.x);
        } else {
          hx = hz = Math.max(hx, hy, hz);
          bottom = hx;
        }
        const h = Math.max(0, p.y - bottom - this.top);
        const fade = 1 - h / FADE_H;
        if (fade <= 0 || hx < 0.002) return;
        // Thrown away from the lantern, the further the higher the piece is off the cloth.
        const push = h / Math.max(0.2, this.light.y - this.top - h);
        const grow = 1 + h * 3;
        turn.setFromAxisAngle(Y, yaw);
        m.compose(
          // A hair over the cloth, under the face of a card lying on it.
          p.set(p.x + (p.x - this.light.x) * push, this.top + 0.0015, p.z + (p.z - this.light.z) * push),
          turn,
          s.set(hx * 2 * SPREAD * grow, 1, hz * 2 * SPREAD * grow),
        );
        target.setMatrixAt(n, m);
        const dark = c.dark * fade * fade;
        target.setColorAt(n, grey.setRGB(dark, dark, dark));
        if (c.round) nr++;
        else ns++;
      });
    }
    for (const [mesh, n] of [[this.round, nr], [this.square, ns]] as const) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose() {
    for (const mesh of [this.round, this.square]) {
      mesh.geometry.dispose();
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.dispose();
      mesh.dispose();
    }
  }
}
