// The veil over a view while its place is being built.
//
// Going in or out of a building, a view has nothing to show for a moment.
// Rather than a blank, the veil covers it with a night sky in the page's own
// blue, a few stars coming and going, and in the middle the game's mark: the
// gold anchor from the title page, hanging and swinging gently as if from its
// chain, over two lines of swell. All of it is in fat pixels, like the mark.
// When the place is ready the veil simply clears, and the place itself does
// the arriving (see rise.ts).
//
// One full-screen triangle and one shader, drawn over the finished picture.

import * as THREE from "three";
import anchorSvg from "../../../public/favicon.svg?raw";

/** The dark the veil is made of: the page's own background, so the panels over it sit as they always do. */
export const NIGHT = "#23304f";
/** Seconds the veil takes to clear once the place is ready. */
export const VEIL_CLEAR_S = 0.4;

/** The anchor from the favicon, without its tile: sixteen pixels square, one texel a pixel. */
function anchorTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 16;
  const ctx = canvas.getContext("2d")!;
  // Each path is one colour and a run of one-pixel squares: "M3 4h1v1h-1z".
  for (const path of anchorSvg.matchAll(/<path fill="(#[0-9a-fA-F]{3,8})" d="([^"]*)"/g)) {
    ctx.fillStyle = path[1];
    for (const cell of path[2].matchAll(/M(\d+) (\d+)h1v1h-1z/g)) ctx.fillRect(Number(cell[1]), Number(cell[2]), 1, 1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
uniform float cover;
uniform float time;
uniform vec2 size;
uniform float fat;
uniform sampler2D anchor;
uniform vec3 night;
uniform vec3 deep;
uniform vec3 gold;
uniform vec3 foam;
varying vec2 vUv;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  // The view in fat pixels, counted from the middle: x right, y up.
  vec2 cell = floor((vUv - 0.5) * size / fat);

  // Night: a little deeper toward the top.
  vec3 c = mix(night, deep, smoothstep(-0.1, 0.5, vUv.y - 0.5) * 0.55);

  // Stars: one fat pixel here and there, each on its own slow twinkle.
  float seed = hash(cell);
  if (seed > 0.9962) {
    float glint = 0.5 + 0.5 * sin(time * (0.8 + seed * 40.0 - 39.0) + seed * 90.0);
    c = mix(c, foam, 0.25 + 0.55 * glint);
  }

  // The anchor: sixteen of its own pixels square, each three fat pixels, hung from a point above it and
  // swinging a few degrees either way. It is turned in whole pixels' worth, so it stays crisp.
  float swing = sin(time * 1.7) * 0.11;
  vec2 pivot = vec2(0.0, 30.0);
  vec2 from = cell + 0.5 - pivot;
  vec2 hung = vec2(cos(swing) * from.x - sin(swing) * from.y, sin(swing) * from.x + cos(swing) * from.y) + pivot;
  // Its shadow first, a pixel of the mark lower, then the mark.
  for (int pass = 0; pass < 2; pass++) {
    vec2 at = (hung + vec2(0.0, pass == 0 ? 3.0 : 0.0)) / 3.0 + vec2(8.0, 8.0);
    if (at.x >= 0.0 && at.x < 16.0 && at.y >= 0.0 && at.y < 16.0) {
      vec4 mark = texture2D(anchor, (floor(at) + 0.5) / 16.0);
      if (mark.a > 0.5) c = pass == 0 ? deep * 0.45 : mark.rgb;
    }
  }

  // The swell under it: two broken lines of foam, sliding opposite ways.
  for (int row = 0; row < 2; row++) {
    float y = -34.0 - float(row) * 5.0;
    float drift = floor(time * (row == 0 ? 5.0 : -3.5));
    float along = cell.x + drift + float(row) * 4.0;
    float lift = floor(sin(along * 0.38 + float(row) * 1.7) * 1.4 + 0.5);
    if (abs(cell.x) < 26.0 - float(row) * 7.0 && cell.y == y + lift && mod(along, 9.0) < 6.0) c = mix(c, foam, row == 0 ? 0.6 : 0.32);
  }

  gl_FragColor = vec4(c, clamp(cover, 0.0, 1.0));
  #include <colorspace_fragment>
}`;

export class Veil {
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private material: THREE.ShaderMaterial;
  private geometry = new THREE.BufferGeometry();
  private anchor = anchorTexture();

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
        size: { value: new THREE.Vector2(1, 1) },
        fat: { value: 2 },
        anchor: { value: this.anchor },
        night: { value: new THREE.Color(NIGHT) },
        deep: { value: new THREE.Color("#1b1830") },
        gold: { value: new THREE.Color("#ffd23f") },
        foam: { value: new THREE.Color("#e8dcc0") },
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
   * @param cover 1 with the view wholly covered, down to 0 as it clears
   * @param fat how many of the renderer's pixels one of the veil's is across
   */
  draw(renderer: THREE.WebGLRenderer, cover: number, time: number, fat: number) {
    const u = this.material.uniforms;
    u.cover.value = cover;
    u.time.value = time;
    u.fat.value = fat;
    (u.size.value as THREE.Vector2).set(renderer.domElement.width, renderer.domElement.height);
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
    this.anchor.dispose();
  }
}
