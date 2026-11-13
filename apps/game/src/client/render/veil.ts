// The veil over a view while its place is being built, and the way it lifts.
//
// Going in or out of a building, a view has nothing to show for a moment.
// Rather than a blank, the veil covers it in the night-blue of the page with
// a loading mark turning in the middle: a ring of six gold hexes chasing each
// other round inside a slow hexagon. When the place is ready the veil opens
// as an iris of hexes, the world's own shape: holes grow in a honeycomb from
// the middle outward, each rimmed in gold as it widens, until nothing is left.
//
// One full-screen triangle and one shader, drawn over the finished picture.

import * as THREE from "three";

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
uniform float cover;
uniform float time;
uniform float aspect;
uniform vec3 night;
uniform vec3 gold;
varying vec2 vUv;

const vec2 HEX = vec2(1.0, 1.7320508);
/** How many hexes the honeycomb is across the height of the view. */
const float CELLS = 7.0;

// 0 at a hexagon's middle to 0.5 at its edge: flat sides left and right.
float hexDist(vec2 p) {
  p = abs(p);
  return max(dot(p, vec2(0.5, 0.8660254)), p.x);
}

// The honeycomb cell a point is in: where the point lies in it (xy) and the cell's middle (zw).
vec4 hexCell(vec2 p) {
  vec4 c = floor(vec4(p, p - vec2(0.5, 1.0)) / HEX.xyxy) + 0.5;
  vec4 h = vec4(p - c.xy * HEX, p - (c.zw + 0.5) * HEX);
  return dot(h.xy, h.xy) < dot(h.zw, h.zw) ? vec4(h.xy, c.xy * HEX) : vec4(h.zw, (c.zw + 0.5) * HEX);
}

vec2 turn(vec2 p, float a) {
  float c = cos(a), s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

void main() {
  // The view, 2 tall, the middle at the origin.
  vec2 p = (vUv * 2.0 - 1.0) * vec2(aspect, 1.0);
  float open = 1.0 - cover;

  // The iris: each cell's hole starts to grow as the opening reaches it, the middle first.
  vec4 cell = hexCell(p * CELLS * 0.5);
  float away = length(cell.zw) / (CELLS * 0.5 * length(vec2(aspect, 1.0)));
  float grown = clamp((open * 1.7 - away) / 0.7, 0.0, 1.0);
  grown = grown * grown * (3.0 - 2.0 * grown);
  float hole = grown * 0.58;
  float edge = hexDist(cell.xy);
  float veil = step(hole, edge);
  // The rim of each hole glows as it widens, and dies away as the hole fills its cell.
  float rim = (1.0 - smoothstep(0.0, 0.035, edge - hole)) * veil * step(0.001, grown) * (1.0 - grown * 0.6);

  vec3 c = night;
  // A faint honeycomb in the dark, breathing, so the wait is not a flat colour.
  float comb = smoothstep(0.455, 0.5, edge);
  c += gold * comb * 0.035 * (0.6 + 0.4 * sin(time * 1.4 - away * 5.0));

  // The loading mark, there only while the veil is whole.
  float mark = smoothstep(0.82, 1.0, cover);
  if (mark > 0.0) {
    float lit = 0.0;
    // Six hexes on a ring, each lighting as the turn comes round to it and fading behind it.
    for (int i = 0; i < 6; i++) {
      float a = float(i) * 1.0471976 + 0.5235988;
      vec2 at = vec2(sin(a), cos(a)) * 0.115;
      float pip = 1.0 - smoothstep(0.019, 0.024, hexDist(turn(p - at, 0.5235988)) );
      float chase = fract(float(i) / 6.0 - time * 0.85);
      lit += pip * (0.16 + 0.84 * chase * chase * chase);
    }
    // And a thin hexagon round them, turning slowly the other way.
    float ring = hexDist(turn(p, -time * 0.35));
    lit += (1.0 - smoothstep(0.0, 0.006, abs(ring - 0.185))) * 0.45;
    c = mix(c, gold, clamp(lit, 0.0, 1.0) * mark);
  }

  c = mix(c, gold * 1.25, rim);
  gl_FragColor = vec4(c, veil);
  #include <colorspace_fragment>
}`;

/** Seconds the iris takes to open. */
export const VEIL_OPEN_S = 0.95;

export class Veil {
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private material: THREE.ShaderMaterial;
  private geometry = new THREE.BufferGeometry();

  constructor() {
    // One triangle that covers the screen.
    this.geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        cover: { value: 1 },
        time: { value: 0 },
        aspect: { value: 1 },
        night: { value: new THREE.Color(NIGHT) },
        gold: { value: new THREE.Color("#ffd23f") },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  /**
   * Draw the veil over whatever the renderer last drew to the screen.
   * @param cover 1 with the view wholly covered (the loading mark showing), down to 0 with it open
   */
  draw(renderer: THREE.WebGLRenderer, cover: number, time: number, aspect: number) {
    const u = this.material.uniforms;
    u.cover.value = cover;
    u.time.value = time;
    u.aspect.value = aspect;
    const autoClear = renderer.autoClear;
    const shadows = renderer.shadowMap.autoUpdate;
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
    renderer.autoClear = autoClear;
    renderer.shadowMap.autoUpdate = shadows;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** The dark the veil is made of: the page's own background, so the panels over it sit as they always do. */
export const NIGHT = "#23304f";
