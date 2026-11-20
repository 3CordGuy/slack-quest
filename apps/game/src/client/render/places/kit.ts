// What a place's model is built with. Every kind of place on a map (a building, a chest, a game table) has a
// function that builds its model (the registry, index.ts, says which); the renderer makes an empty group and a
// kit round it (`placeKit`), and hands both to that function with the place itself.
//
// A model is built into `kit.g`, to fit one hex: the ground at y = 0, its front to +z, a hex a unit to the corner.
// The renderer then stands it, turns it and scales it (placing.ts), and looks on it for what it has to keep up:
//
//   - on the group's `userData`: `glows` (lit windows and lanterns, a BuildingGlow each) and `panes` (the glass
//     made with `warmPane`), which come up at dusk; `smoke` (a chimney top); `beacon` and `shine` (a lighthouse's
//     lantern, and the ironwork its beam lights); `glowAt` (the light of glowing mushrooms); `door` (the hex that
//     pointing anywhere on the model means); and the parts the renderer moves: a chest's `lid`, a crate's `body`,
//     the town chest's `townLid`, `townShine` and `flag`;
//   - on a mesh's `userData`: `glow` for one that is light and not a solid (no shadow, no ink, folded apart).
//
// Some effects are seeded by the order things are made in, so a model makes its pieces in the order it always has.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Poi, PoiKind, WorldMap } from "@gantt-quest/world";
import type { Waygate } from "../waygate";
import type { RenderState } from "../WorldRenderer";

/** What a model is told of the scene it is built for: the renderer says these afresh for every model. */
export interface PlaceScene {
  /** What sort of scene it is (RenderState.kind): "caverns" under ground, "pub" in the pub, nothing anywhere else. The way out of a cave is only drawn under ground. */
  sceneKind: RenderState["kind"];
  /** Which map it is (RenderState.code): "harbor" in the Harbor, where the cave mouth is a grander thing. */
  mapCode: string;
  /** The map itself, once there is one: for a model that looks at the ground round it (glowcaps grow against the rock). */
  map: WorldMap | undefined;
  /** A chest's lid now, as an angle about its hinge: at rest, or part way while it swings open. */
  lidNow(poi: Poi): number;
  /** A point out in the world (x, z), in the space of `poi`'s model as the renderer will set it down. */
  inModel(poi: Poi, x: number, z: number): THREE.Vector2;
  /** How far open the town chest's lid is now (0 shut, 1 thrown back), and its angle about its hinges when it is thrown back. */
  townLidAt: number;
  townLidThrown: number;
  /** Whether the town's waygate is open now: a gate is made as it stands. */
  gateOpen: boolean;
  /** To be called the moment a waygate begins to burst open (its sound hangs on it). */
  onWaygateBurst(): void;
  /** The renderer's waygates: a model that makes one puts it here, to be turned each frame and let go with the model. */
  gates: Waygate[];
}

/** The kit: the group being built, three helpers to build it with, and the scene. */
export interface PlaceKit extends PlaceScene {
  /** The model. */
  g: THREE.Group;
  /** A flat-shaded material of one colour. */
  lambert(color: string): THREE.MeshLambertMaterial;
  /** A mesh of `geometry` and `material` added to the model at (x, y, z), turned `rotY` about y. */
  add(geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, rotY?: number): THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
  /** A box's shape. */
  box(w: number, h: number, d: number): THREE.BoxGeometry;
}

/** A place's model: built into `kit.g`. */
export type PlaceModel = (poi: Poi, kit: PlaceKit) => void;
/** The models there are, by kind. A kind with none is drawn as nothing. */
export type PlaceModels = ReadonlyMap<PoiKind, PlaceModel>;

/** The kit for building a model into `g`. */
export function placeKit(g: THREE.Group, scene: PlaceScene): PlaceKit {
  const lambert = (color: string) => new THREE.MeshLambertMaterial({ color, flatShading: true });
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, rotY = 0) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.rotation.y = rotY;
    g.add(mesh);
    return mesh;
  };
  const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
  return { g, lambert, add, box, ...scene };
}

/**
 * Fold a model's pieces that share a look into one mesh each, so a detailed building costs a handful of draw calls
 * rather than one a piece. Plain lambert pieces of the same colour fold together; a piece with any other material
 * (a pane the ambience warms, the painted sign) folds only with pieces using that very material. Glows stay apart.
 */
export function foldByLook(g: THREE.Group) {
  const sets = new Map<string, THREE.Mesh[]>();
  for (const o of g.children) {
    if (!(o instanceof THREE.Mesh)) continue;
    const m = o.material as THREE.Material;
    const key = (m instanceof THREE.MeshLambertMaterial && !m.map ? `lambert:${m.color.getHexString()}` : m.uuid) + (o.userData.glow ? ":glow" : "");
    const set = sets.get(key);
    if (set) set.push(o);
    else sets.set(key, [o]);
  }
  for (const meshes of sets.values()) {
    if (meshes.length < 2) continue;
    const parts = meshes.map((mesh) => {
      mesh.updateMatrix();
      const geo = (mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()).applyMatrix4(mesh.matrix);
      geo.clearGroups();
      return geo;
    });
    const folded = mergeGeometries(parts);
    for (const p of parts) p.dispose();
    if (!folded) continue;
    const mesh = new THREE.Mesh(folded, meshes[0].material);
    mesh.userData.glow = meshes[0].userData.glow;
    for (const m of meshes) {
      g.remove(m);
      m.geometry.dispose();
    }
    g.add(mesh);
  }
}

/** Window glass that warms with the dusk: `unlit` by day, `lit` by night (the ambience moves it between the two; see `setGlows`). */
export function warmPane(unlit: string, lit: string): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: lit });
  m.userData = { unlit, lit };
  return m;
}
