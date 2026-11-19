// Motes: small soft points of light that drift and fade, all moved by the
// graphics card from one clock. Sparks off a brazier, the dust a waygate
// draws in, embers over a lava field, snow over a frozen void.
//
// Each mote is born at its own point, travels `rise` up (or down) over its
// life while swaying `sway` to the sides, fades in and out, and is born
// again. A field of them can be wrapped round a moving middle (see `wrap`),
// so the air is full of them wherever the camera goes.

import * as THREE from "three";

export interface Mote {
  x: number;
  y: number;
  z: number;
  color: THREE.Color;
  /** How far it travels up over its life, in world units: negative falls. */
  rise: number;
  /** How far it wanders to the sides. */
  sway: number;
  /** Lives a second: 0.5 is a life of two seconds. */
  rate: number;
  /** Where in its life it starts, 0 to 1. */
  phase: number;
  /** Its size, as a share of the field's. */
  size: number;
}

export interface MoteField {
  points: THREE.Points;
  /** Once a frame. `middle` moves a wrapped field. */
  tick(clock: number, middle?: THREE.Vector3): void;
  dispose(): void;
}

let dot: THREE.CanvasTexture | null = null;
/** A soft round dot, bright in the middle. Made once and shared. */
function softDot(): THREE.CanvasTexture {
  if (dot) return dot;
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  dot = new THREE.CanvasTexture(canvas);
  dot.colorSpace = THREE.SRGBColorSpace;
  return dot;
}

/**
 * A field of motes. `size` is the widest a mote is drawn, in world units. With `wrap`, the motes fill a box
 * that many units across (and `wrap.tall` high, about the y they were given) which follows the middle handed
 * to `tick`, each mote stepping round to the far side as it leaves.
 */
export function moteField(motes: Mote[], size: number, opts: { wrap?: number; additive?: boolean; opacity?: number } = {}): MoteField {
  const n = motes.length;
  const position = new Float32Array(n * 3);
  const color = new Float32Array(n * 3);
  const drift = new Float32Array(n * 4);
  const scale = new Float32Array(n);
  motes.forEach((m, i) => {
    position.set([m.x, m.y, m.z], i * 3);
    color.set([m.color.r, m.color.g, m.color.b], i * 3);
    drift.set([m.rise, m.sway, m.rate, m.phase], i * 4);
    scale[i] = m.size;
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(color, 3));
  geometry.setAttribute("aDrift", new THREE.BufferAttribute(drift, 4));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(scale, 1));
  const material = new THREE.PointsMaterial({
    size,
    map: softDot(),
    vertexColors: true,
    transparent: true,
    opacity: opts.opacity ?? 1,
    blending: opts.additive === false ? THREE.NormalBlending : THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const uniforms = { uMoteClock: { value: 0 }, uMoteWrap: { value: new THREE.Vector4(0, 0, 0, opts.wrap ?? 0) } };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("void main() {", "attribute vec4 aDrift;\nattribute float aSize;\nuniform float uMoteClock;\nuniform vec4 uMoteWrap;\nvarying float vMoteFade;\nvoid main() {")
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `vec3 transformed = vec3( position );
        float moteLife = fract( uMoteClock * aDrift.z + aDrift.w );
        if ( uMoteWrap.w > 0.0 ) transformed.xz = mod( transformed.xz - uMoteWrap.xz + uMoteWrap.w * 0.5, uMoteWrap.w ) - uMoteWrap.w * 0.5 + uMoteWrap.xz;
        transformed.y += moteLife * aDrift.x;
        transformed.x += sin( moteLife * 8.2 + aDrift.w * 40.0 ) * aDrift.y * ( 0.3 + moteLife );
        transformed.z += cos( moteLife * 5.7 + aDrift.w * 70.0 ) * aDrift.y * ( 0.3 + moteLife );
        vMoteFade = smoothstep( 0.0, 0.12, moteLife ) * ( 1.0 - moteLife );`,
      )
      .replace("#include <fog_vertex>", "#include <fog_vertex>\ngl_PointSize *= aSize * ( 1.0 - 0.45 * moteLife );");
    shader.fragmentShader = shader.fragmentShader.replace("void main() {", "varying float vMoteFade;\nvoid main() {").replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.a *= vMoteFade;");
  };
  const points = new THREE.Points(geometry, material);
  // They move in the shader: where they were made says nothing of where they are.
  points.frustumCulled = false;
  points.userData.glow = true;
  return {
    points,
    tick(clock, middle) {
      uniforms.uMoteClock.value = clock;
      if (middle) uniforms.uMoteWrap.value.set(middle.x, middle.y, middle.z, opts.wrap ?? 0);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
