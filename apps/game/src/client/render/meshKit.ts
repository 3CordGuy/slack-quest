// A small kit for the catches' low-poly models (catchArt.ts, fishModels.ts):
// parts built from primitives, moved into place, with their shading baked
// into vertex colours so they need no lights. That keeps a model looking the
// same in the world, on the overlay layer (drawn after the finishing pass,
// out of reach of the scene's lights) and in the sprite renderer.

import * as THREE from "three";

const LIGHT = new THREE.Vector3(0.45, 0.8, 0.55).normalize();

export const DARK = "#1b1830";

export interface At {
  pos?: [number, number, number];
  rot?: [number, number, number];
  scale?: [number, number, number];
}

/** A face's colour from where its middle is and which way it faces, for patterned bodies. */
export type Paint = (centre: THREE.Vector3, normal: THREE.Vector3) => THREE.Color;

/**
 * One part of a model: `geo` moved into place, then coloured face by face
 * (one colour, or `paint` per face) and shaded by how each face meets the light.
 */
export function part(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation | Paint, at: At = {}, material: { opacity?: number; double?: boolean } = {}): THREE.Mesh {
  if (at.scale) geo.scale(...at.scale);
  if (at.rot) {
    geo.rotateX(at.rot[0]);
    geo.rotateY(at.rot[1]);
    geo.rotateZ(at.rot[2]);
  }
  if (at.pos) geo.translate(...at.pos);
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  g.computeVertexNormals();
  const n = g.attributes.normal;
  const p = g.attributes.position;
  const flat = typeof color === "function" ? null : new THREE.Color(color);
  const colors = new Float32Array(n.count * 3);
  const centre = new THREE.Vector3();
  const normal = new THREE.Vector3();
  for (let f = 0; f < n.count; f += 3) {
    normal.set(n.getX(f), n.getY(f), n.getZ(f));
    let base = flat;
    if (!base) {
      centre.set((p.getX(f) + p.getX(f + 1) + p.getX(f + 2)) / 3, (p.getY(f) + p.getY(f + 1) + p.getY(f + 2)) / 3, (p.getZ(f) + p.getZ(f + 1) + p.getZ(f + 2)) / 3);
      base = (color as Paint)(centre, normal);
    }
    // A plate seen from behind is lit as from the front.
    const lit = Math.abs(normal.dot(LIGHT)) * (material.double ? 1 : 0) + (material.double ? 0 : Math.max(0, normal.dot(LIGHT)));
    const k = 0.5 + 0.55 * lit;
    for (let v = f; v < f + 3; v++) {
      colors[v * 3] = base.r * k;
      colors[v * 3 + 1] = base.g * k;
      colors[v * 3 + 2] = base.b * k;
    }
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const opacity = material.opacity ?? 1;
  return new THREE.Mesh(
    g,
    new THREE.MeshBasicMaterial({ vertexColors: true, transparent: opacity < 1, opacity, depthWrite: opacity >= 1, side: material.double ? THREE.DoubleSide : THREE.FrontSide }),
  );
}

export const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
export const cyl = (r0: number, r1: number, h: number, sides = 8) => new THREE.CylinderGeometry(r0, r1, h, sides);
export const ball = (r: number, w = 10, h = 8) => new THREE.SphereGeometry(r, w, h);
export const ring = (r: number, tube: number, arc = Math.PI * 2) => new THREE.TorusGeometry(r, tube, 5, 12, arc);
export const cone = (r: number, h: number, sides = 6) => new THREE.ConeGeometry(r, h, sides);
/** A flat plate (a fin) in the x-y plane, through these points. */
export const plate = (pts: [number, number][]) => new THREE.ShapeGeometry(new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y))));
