// The glow round a structure under the pointer: a line of warm gold drawn
// round its whole silhouette, lamplight spreading a little way out from the
// line and a little way in over the structure's own edge.
//
// Nothing of the structure is rebuilt or recoloured. While one is lit, its
// solid pieces are drawn again, flat white, into a picture of their own (the
// mask), and the glow is found from that picture's edge and laid over the
// finished frame, only as far as the structure reaches on screen. With
// nothing lit, nothing is drawn and nothing is kept busy.

import * as THREE from "three";

/** The layer a lit structure's solid pieces are put on, for as long as it is lit: the mask is drawn from that layer alone. */
export const GLOW_LAYER = 30;

/** How far the glow reaches from the silhouette, in the mask's pixels on a view 800 tall (it widens with the view). */
const REACH = 13;

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

/**
 * Each ring of samples says how much of a circle round this pixel lies on the structure. Outside it, a small ring
 * gives the line and three wider ones the glow falling away; inside it, a ring gives the light that spills in
 * over the edge. The wider rings are turned by a different amount at every pixel, so the glow is grained and
 * not banded. The colours are the screen's own (sRGB), and go straight to it.
 */
const FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D mask;
  uniform vec2 px;
  uniform float wide;
  uniform float power;
  uniform vec3 line;
  uniform vec3 lamp;
  varying vec2 vUv;
  float at(vec2 o) { return texture2D(mask, vUv + o * px * wide).r; }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  float fine(float r) {
    float s = 0.0;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.7853982;
      s += at(vec2(cos(a), sin(a)) * r);
    }
    return s / 8.0;
  }
  float soft(float r, float turn) {
    float s = 0.0;
    for (int i = 0; i < 12; i++) {
      float a = turn + float(i) * 0.5235988;
      s += at(vec2(cos(a), sin(a)) * r);
    }
    return s / 12.0;
  }
  void main() {
    float inside = at(vec2(0.0));
    float turn = hash(gl_FragCoord.xy) * 0.5235988;
    float a = fine(2.0);
    float b = soft(4.0, turn);
    float c = soft(8.0, turn + 0.26);
    float d = soft(13.0, turn);
    float outside = 1.0 - inside;
    float edge = outside * smoothstep(0.0, 0.3, a);
    float glow = outside * (b + c + d) / 1.5;
    glow *= glow * 0.5 + 0.5;
    float spill = inside * clamp((1.0 - c) * 2.0, 0.0, 1.0);
    spill *= spill;
    vec3 rgb = line * edge + lamp * (glow * 0.8 + spill * 0.42);
    float cover = edge * 0.9 + glow * 0.3;
    gl_FragColor = vec4(rgb, cover) * power;
  }`;

/**
 * How an object stands: `shown` in a scene with nothing it stands in hidden, `hidden` in a scene but put out of
 * sight for now, or `gone` from any scene (the places or the map's scenery were built again, and this is the old one).
 */
function standing(o: THREE.Object3D): "shown" | "hidden" | "gone" {
  let seen = true;
  let at: THREE.Object3D = o;
  for (;;) {
    if (!at.visible) seen = false;
    if (!at.parent) return (at as THREE.Scene).isScene !== true ? "gone" : seen ? "shown" : "hidden";
    at = at.parent;
  }
}

export class HoverGlow {
  private target: THREE.WebGLRenderTarget | null = null;
  /** Draws whatever structure is lit, and nothing else: the structure is handed to it for the one draw (see `draw`). */
  private maskScene = new THREE.Scene();
  private white = new THREE.MeshBasicMaterial({ color: "#ffffff", side: THREE.DoubleSide, depthTest: false, depthWrite: false, fog: false });
  private overScene = new THREE.Scene();
  private flat = new THREE.Camera();
  private geometry = new THREE.BufferGeometry();
  private material: THREE.ShaderMaterial;
  private root: THREE.Object3D | null = null;
  /** The lit structure's pieces that are drawn into the mask, and those that are only counted in how far it reaches (a waygate's unseen column). */
  private solid: THREE.Mesh[] = [];
  private unseen: THREE.Mesh[] = [];
  /** How brightly it is lit, eased toward `goal`: it comes up quickly under the pointer and dies away when the pointer leaves. */
  private power = 0;
  private goal = 0;
  private still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  private box = new THREE.Box3();
  private part = new THREE.Box3();
  private corner = new THREE.Vector4();
  private viewProj = new THREE.Matrix4();
  private size = new THREE.Vector2();
  private clearWas = new THREE.Color();
  private scissorWas = new THREE.Vector4();

  constructor() {
    this.maskScene.overrideMaterial = this.white;
    this.maskScene.matrixWorldAutoUpdate = false;
    // One triangle that covers the screen.
    this.geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        mask: { value: null },
        px: { value: new THREE.Vector2(1, 1) },
        wide: { value: 1 },
        power: { value: 0 },
        // Polished brass for the line, lamplight for the glow.
        line: { value: new THREE.Vector3(1, 0.86, 0.5) },
        lamp: { value: new THREE.Vector3(1, 0.66, 0.22) },
      },
      // Laid over what is there: the line nearly hides what is under it (so it reads against a bright noon), and the
      // glow mostly adds to it (so it reads at night).
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.frustumCulled = false;
    this.overScene.add(mesh);
  }

  /** Whether a structure is lit and staying lit (false while the last one is only dying away). */
  get lit(): boolean {
    return !!this.root && this.goal > 0;
  }

  /**
   * Light a structure (everything under `root`), or with null let the lit one go out. Its solid pieces are only
   * marked, to be drawn into the mask: nothing of it is built again.
   */
  set(root: THREE.Object3D | null) {
    if (!root) {
      this.goal = 0;
      return;
    }
    this.goal = 1;
    if (root === this.root) return;
    this.release();
    this.root = root;
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || o.userData.ink) return;
      const material = (Array.isArray(o.material) ? o.material[0] : o.material) as THREE.Material | undefined;
      if (!material) return;
      if (!material.visible) return void this.unseen.push(o);
      // Light, glass and haze are no part of its outline.
      if (material.transparent) return;
      o.layers.enable(GLOW_LAYER);
      this.solid.push(o);
    });
  }

  private release() {
    for (const o of this.solid) o.layers.disable(GLOW_LAYER);
    this.solid = [];
    this.unseen = [];
    this.root = null;
    this.power = 0;
  }

  /**
   * How much of the view the lit structure and its glow cover, in the view's pixels from the bottom left; null
   * when none of it is in view. All of the view, if any of it is behind the camera.
   */
  private reach(camera: THREE.Camera, w: number, h: number, pad: number): { x: number; y: number; w: number; h: number } | null {
    const box = this.box.makeEmpty();
    for (const list of [this.solid, this.unseen]) {
      for (const o of list) {
        const g = o.geometry as THREE.BufferGeometry;
        if (!g.boundingBox) g.computeBoundingBox();
        box.union(this.part.copy(g.boundingBox!).applyMatrix4(o.matrixWorld));
      }
    }
    if (box.isEmpty()) return null;
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < 8; i++) {
      const v = this.corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z, 1).applyMatrix4(this.viewProj);
      if (v.w < 0.05) return { x: 0, y: 0, w, h };
      x0 = Math.min(x0, v.x / v.w);
      x1 = Math.max(x1, v.x / v.w);
      y0 = Math.min(y0, v.y / v.w);
      y1 = Math.max(y1, v.y / v.w);
    }
    const left = Math.max(0, Math.floor((x0 * 0.5 + 0.5) * w - pad));
    const right = Math.min(w, Math.ceil((x1 * 0.5 + 0.5) * w + pad));
    const bottom = Math.max(0, Math.floor((y0 * 0.5 + 0.5) * h - pad));
    const top = Math.min(h, Math.ceil((y1 * 0.5 + 0.5) * h + pad));
    return right > left && top > bottom ? { x: left, y: bottom, w: right - left, h: top - bottom } : null;
  }

  /**
   * Once a frame, after the frame has been drawn to the screen: lays the glow over it. `camera` is the one the
   * frame was drawn through, its matrices as that draw left them. Does nothing at all while nothing is lit.
   */
  draw(renderer: THREE.WebGLRenderer, camera: THREE.Camera, dt: number, clock: number) {
    const root = this.root;
    if (!root) return;
    // The place was built again under the pointer (a hut went up, a project was paid for), or the map's scenery
    // was: this is the old one, and whoever lit it finds the new (`lit` is false again).
    const how = standing(root);
    if (how === "gone") return this.release();
    this.power += (this.goal - this.power) * (1 - Math.exp(-dt * (this.goal > 0 ? 16 : 11)));
    if (this.goal === 0 && this.power < 0.02) return this.release();
    if (how === "hidden") return;
    const { x: w, y: h } = renderer.getDrawingBufferSize(this.size);
    if (w < 2 || h < 2) return;
    const wide = Math.max(1, h / 800);
    const area = this.reach(camera, w, h, REACH * wide + 3);
    if (!area) return;

    if (!this.target) this.target = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, stencilBuffer: false });
    else if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);

    const autoClear = renderer.autoClear;
    const shadows = renderer.shadowMap.autoUpdate;
    const clearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clearWas);
    const layers = camera.layers.mask;
    renderer.shadowMap.autoUpdate = false;

    // The mask: the structure alone, white on nothing. It is handed to a scene of its own for this one draw, and
    // stays where it stands in the world (its place there was worked out when the frame was drawn).
    this.maskScene.children = [root];
    camera.layers.set(GLOW_LAYER);
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.target);
    renderer.render(this.maskScene, camera);
    this.maskScene.children = [];
    camera.layers.mask = layers;
    renderer.setClearColor(this.clearWas, clearAlpha);

    // The glow, over the finished frame, no further than the structure reaches.
    const u = this.material.uniforms;
    u.mask.value = this.target.texture;
    (u.px.value as THREE.Vector2).set(1 / w, 1 / h);
    u.wide.value = wide;
    // It breathes, slowly: lamplight, not a sign.
    u.power.value = this.power * (this.still ? 0.94 : 0.9 + 0.1 * Math.sin(clock * 2.4));
    renderer.getScissor(this.scissorWas);
    const scissorTest = renderer.getScissorTest();
    const ratio = renderer.getPixelRatio();
    renderer.autoClear = false;
    renderer.setRenderTarget(null);
    renderer.setScissor(area.x / ratio, area.y / ratio, area.w / ratio, area.h / ratio);
    renderer.setScissorTest(true);
    renderer.render(this.overScene, this.flat);
    renderer.setScissor(this.scissorWas);
    renderer.setScissorTest(scissorTest);
    renderer.autoClear = autoClear;
    renderer.shadowMap.autoUpdate = shadows;
  }

  dispose() {
    this.release();
    this.target?.dispose();
    this.target = null;
    this.white.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
