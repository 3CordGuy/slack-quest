// A prototype finishing pass over the whole picture: bloom on the bright
// things (flames, lit windows, wave crests), a tilt-shift blur away from what
// the camera looks at, and a warm/cool grade with a vignette. The scene is
// drawn to an offscreen buffer first, then a handful of small full-screen
// passes build the result. On with "Fancy graphics" in the options (see fancy.ts).

import * as THREE from "three";

/**
 * The layer for what is read rather than looked at (name plates, speech bubbles, health bars). The finishing pass
 * draws it afterwards, crisp, over the finished picture.
 */
export const OVERLAY_LAYER = 31;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/** Keeps only what is bright enough to glow. Colours are capped at what the screen can show first. */
const BRIGHT = /* glsl */ `
uniform sampler2D tMap;
uniform float threshold;
uniform float knee;
varying vec2 vUv;
void main() {
  vec3 c = min(texture2D(tMap, vUv).rgb, vec3(1.0));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor = vec4(c * smoothstep(threshold, threshold + knee, l), 1.0);
}`;

/** One direction of a soft blur: nine samples' worth from five reads. */
const BLUR = /* glsl */ `
uniform sampler2D tMap;
uniform vec2 dir;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tMap, vUv).rgb * 0.2270270270;
  c += texture2D(tMap, vUv + dir * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(tMap, vUv - dir * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(tMap, vUv + dir * 3.2307692308).rgb * 0.0702702703;
  c += texture2D(tMap, vUv - dir * 3.2307692308).rgb * 0.0702702703;
  gl_FragColor = vec4(c, 1.0);
}`;

const FINAL = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBlur;
uniform sampler2D tDepth;
uniform sampler2D tBloom0;
uniform sampler2D tBloom1;
uniform sampler2D tBloom2;
uniform float near;
uniform float far;
uniform float focus;
uniform vec2 focusRange;
uniform float dof;
uniform float focusSlack;
uniform float bloom;
uniform float grade;
uniform float vignette;
uniform float aspect;
uniform float lift;
uniform float flash;
// The grade for this hour: what the shadows and the highlights are tinted, and how rich the colour is.
uniform vec3 gradeShadow;
uniform vec3 gradeLight;
uniform float gradeColour;
uniform float gradeGain;
uniform vec3 gradeWash;
uniform float contrast;
// The air: drifting cloud, its shadows on the ground, the light between them, and haze into the distance.
uniform mat4 invViewProj;
uniform vec3 camPos;
uniform vec3 airSunDir;
uniform vec3 airSun;
uniform vec3 airSky;
uniform float airTime;
uniform float airCover;
uniform float airShadow;
uniform float airShafts;
uniform float airHaze;
varying vec2 vUv;

// How high the clouds drift, in the world's units.
const float CLOUD_HEIGHT = 14.0;
float airHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float airNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(airHash(i), airHash(i + vec2(1.0, 0.0)), f.x), mix(airHash(i + vec2(0.0, 1.0)), airHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// How much cloud stands between a spot in the world and the sun: 0 in the open, 1 under thick cloud.
float cloudOver(vec3 at) {
  vec2 q = at.xz + airSunDir.xz * (CLOUD_HEIGHT - at.y) / max(airSunDir.y, 0.3);
  q = q * 0.065 + airTime * vec2(0.011, 0.005);
  float n = airNoise(q) * 0.65 + airNoise(q * 2.3 + 7.1) * 0.35;
  return smoothstep(airCover, airCover + 0.16, n);
}

float distanceAt(vec2 uv) {
  float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
  return 2.0 * near * far / (far + near - z * (far - near));
}

vec3 toScreen(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec3 sharp = min(texture2D(tScene, vUv).rgb, vec3(1.0));
  vec3 soft = min(texture2D(tBlur, vUv).rgb, vec3(1.0));
  // Tilt-shift: sharp at the distance the camera looks at, softer the further from it.
  // The sharp band is a share of the focus distance, but never thinner than focusSlack: zoomed right in and
  // tilted low, a figure's head is a good way nearer than its feet, and it must stay sharp with them.
  float off = abs(distanceAt(vUv) - focus);
  float slack = max(0.0, focusSlack - focusRange.x * focus);
  vec3 c = mix(sharp, soft, smoothstep(focusRange.x * focus + slack, focusRange.y * focus + slack * 2.0, off) * dof);

  // Where in the world this pixel is, from how deep it lies.
  float depth = texture2D(tDepth, vUv).x;
  vec4 back = invViewProj * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec3 spot = back.xyz / back.w;
  float ground = step(depth, 0.99995);
  // Cloud shadows drift over the land and the sea.
  c *= 1.0 - airShadow * cloudOver(spot) * ground;
  // Light shafts: walk from the eye to the spot and count how much of the air on the way stands in sunlight.
  // The steps are the same for every pixel: starting each pixel's walk at a different point left a grain
  // over the picture like a dirty screen.
  if (airShafts > 0.001) {
    vec3 ray = spot - camPos;
    ray *= min(1.0, 70.0 / length(ray));
    float lit = 0.0;
    for (int i = 0; i < 8; i++) {
      vec3 at = camPos + ray * ((float(i) + 0.5) / 8.0);
      lit += at.y > CLOUD_HEIGHT ? 0.8 : 1.0 - cloudOver(at);
    }
    // Only ever adds light: air in the sun glows a little, and air in shade is left as it is.
    // (Taking light away here once turned whole hexes black at a low sun.)
    c += airSun * airShafts * max(lit / 8.0 - 0.8, 0.0);
  }
  c = max(c, vec3(0.0));
  // Lightning: for an instant everything is lit hard and blue-white, the sky and the sea with it.
  c = c * (1.0 + flash * 2.2) + vec3(0.42, 0.5, 0.68) * flash * 0.16;
  // Haze: the far land and the horizon sink into the sky's colour.
  float away = length(spot - camPos);
  c = mix(c, airSky, smoothstep(focus * 1.7, focus * 3.6, away) * airHaze * ground);

  vec3 glow = texture2D(tBloom0, vUv).rgb * 0.5 + texture2D(tBloom1, vUv).rgb * 0.3 + texture2D(tBloom2, vUv).rgb * 0.2;
  c += glow * bloom;

  // Cool shadows, warm highlights, a touch more colour.
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 toned = c * gradeGain * mix(gradeShadow, gradeLight, smoothstep(0.03, 0.6, l));
  toned = mix(vec3(l * gradeGain), toned, gradeColour);
  // The hour's veil of colour. It tints the middle tones and leaves the darkest parts dark, so the
  // picture keeps its depth.
  toned = clamp(toned, 0.0, 1.0);
  toned += gradeWash * (1.0 - toned) * smoothstep(0.0, 0.35, dot(toned, vec3(0.2126, 0.7152, 0.0722)));
  c = clamp(mix(c, toned, grade), 0.0, 1.0);

  c = toScreen(c);
  // A very gentle S-curve for contrast, on the colours as the eye sees them, then the darks lifted a
  // little at night so the ground never sinks to black.
  c = mix(c, c * c * (3.0 - 2.0 * c), contrast * grade);
  c = c * (1.0 - lift) + lift;
  vec2 q = (vUv - 0.5) * vec2(min(aspect, 1.6), 1.0);
  c *= 1.0 - vignette * smoothstep(0.35, 1.0, length(q) * 1.25);
  gl_FragColor = vec4(c, 1.0);
}`;

/** The knobs, for tuning from the console: `__gqWorld.post.params.bloom = 1.2`. */
export type PostParams = {
  /** How strongly bright things glow, by day and by night. */
  bloom: number;
  bloomNight: number;
  /** How bright something must be to glow, by day and by night (0 to 1). */
  threshold: number;
  thresholdNight: number;
  /** How much of the tilt-shift blur to mix in, 0 to 1. */
  dof: number;
  /** Where the blur starts and where it is full, as a share of the focus distance. */
  focusNear: number;
  focusFar: number;
  /** The least the sharp band may reach either side of the focus, in world units, however close the camera is. */
  focusSlack: number;
  /** How much of the colour grade to apply, 0 to 1. */
  grade: number;
  /** How dark the corners go, 0 to 1. */
  vignette: number;
  /** How far the darkest tones are raised at full night, 0 to 1 of the screen's range. */
  nightLift: number;
  /** How much of the sunrise and sunset look to lay over the picture when the sun is low, 0 to 1. */
  goldenHour: number;
  /** How much contrast the picture is given all day, and how much more while the sun is low. */
  contrast: number;
  lowSunContrast: number;
  /** How dark a cloud's shadow is at noon, 0 to 1. */
  cloudShadow: number;
  /** How strong the light shafts between the clouds are. */
  shafts: number;
  /** How far the distance sinks into the sky's colour, 0 to 1. */
  haze: number;
};

/** What the finishing pass needs to know about the sky this frame. */
export type Air = {
  /** False indoors and underground: no clouds, shafts or haze there. */
  outdoors: boolean;
  clock: number;
  /** The direction to the sun or moon, and its light (colour and strength together). */
  sunDir: THREE.Vector3;
  sun: THREE.Color;
  sky: THREE.Color;
  /** How overcast it is, 0 (clear, a few clouds) to 1. */
  overcast: number;
  /** How high the sun stands: about 1.2 at noon, 0 on the horizon, about -0.8 at midnight. */
  sunHeight: number;
  /** How bright the lightning is right now, 0 to 1. */
  flash: number;
};

/**
 * The colour grade at four points of the day: what multiplies the shadows, what multiplies the highlights,
 * and how rich the colour is (1 leaves it alone). The pass blends between them by the clock.
 */
type Rgb = [number, number, number];
/**
 * `gain` brightens the picture before it is tinted (the low sun leaves the scene dim, and a golden hour
 * should glow, not gloom); `wash` is a veil of colour laid over everything, strongest in the dark parts.
 */
const look = (shadow: Rgb, light: Rgb, colour: number, gain = 1, wash: Rgb = [0, 0, 0]) => ({ shadow: new THREE.Vector3(...shadow), light: new THREE.Vector3(...light), colour, gain, wash: new THREE.Vector3(...wash) });
const LOOKS = {
  /** Crisp and near neutral: a touch of blue in the shade, a touch of warmth in the sun. */
  noon: look([0.97, 0.99, 1.06], [1.05, 1.0, 0.94], 1.1),
  /** Golden hour, while the low sun is still up: bright orange over everything, the richest colour of the day. */
  gold: look([1.04, 0.95, 0.92], [1.46, 1.08, 0.58], 1.32, 1.22, [0.06, 0.028, 0.0]),
  /** The afterglow, as the sun goes under (and before it comes up): the orange turns to pink and rose. */
  pink: look([0.98, 0.86, 1.12], [1.42, 0.9, 0.94], 1.3, 1.4, [0.055, 0.012, 0.04]),
  /** Night: teal in the dark, and the highlights left alone so lanterns and fires keep their own warmth. */
  night: look([0.84, 0.98, 1.16], [1.0, 1.0, 1.0], 1.0),
};
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const BLOOM_LEVELS = 3;

export class PostFx {
  readonly params: PostParams = { bloom: 0.55, bloomNight: 1.1, threshold: 0.82, thresholdNight: 0.5, dof: 0.85, focusNear: 0.1, focusFar: 0.42, focusSlack: 3, grade: 1, vignette: 0.2, nightLift: 0.03, goldenHour: 1, contrast: 0.11, lowSunContrast: 0.22, cloudShadow: 0.3, shafts: 0.9, haze: 0.5 };
  private scene: THREE.WebGLRenderTarget;
  /** Half-size soft copy of the scene, for the tilt-shift. */
  private soft: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  /** Glow at a half, a quarter and an eighth of the picture: each a scratch buffer and the result. */
  private glow: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget][] = [];
  private bright: THREE.ShaderMaterial;
  private blur: THREE.ShaderMaterial;
  private final: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private flat = new THREE.Camera();

  constructor(private renderer: THREE.WebGLRenderer) {
    // Room above 1 and no banding in the dark, where the phone allows it.
    const type = renderer.extensions.has("EXT_color_buffer_float") || renderer.extensions.has("EXT_color_buffer_half_float") ? THREE.HalfFloatType : THREE.UnsignedByteType;
    // The scene itself is drawn with four samples a pixel, so the edges of hexes, roofs and figures are smooth.
    const target = (depth = false) => {
      const t = new THREE.WebGLRenderTarget(1, 1, { type, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: depth, samples: depth ? 4 : 0 });
      if (depth) t.depthTexture = new THREE.DepthTexture(1, 1);
      return t;
    };
    this.scene = target(true);
    this.soft = [target(), target()];
    for (let i = 0; i < BLOOM_LEVELS; i++) this.glow.push([target(), target()]);

    const material = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false });
    this.bright = material(BRIGHT, { tMap: { value: null }, threshold: { value: 0.8 }, knee: { value: 0.18 } });
    this.blur = material(BLUR, { tMap: { value: null }, dir: { value: new THREE.Vector2() } });
    this.final = material(FINAL, {
      tScene: { value: this.scene.texture },
      tBlur: { value: this.soft[1].texture },
      tDepth: { value: this.scene.depthTexture },
      tBloom0: { value: this.glow[0][1].texture },
      tBloom1: { value: this.glow[1][1].texture },
      tBloom2: { value: this.glow[2][1].texture },
      near: { value: 0.1 },
      far: { value: 200 },
      focus: { value: 20 },
      focusRange: { value: new THREE.Vector2() },
      dof: { value: 0 },
      focusSlack: { value: 0 },
      bloom: { value: 0 },
      grade: { value: 0 },
      vignette: { value: 0 },
      aspect: { value: 1 },
      lift: { value: 0 },
      flash: { value: 0 },
      gradeShadow: { value: new THREE.Vector3(1, 1, 1) },
      gradeLight: { value: new THREE.Vector3(1, 1, 1) },
      gradeColour: { value: 1 },
      gradeGain: { value: 1 },
      contrast: { value: 0.1 },
      gradeWash: { value: new THREE.Vector3(0, 0, 0) },
      invViewProj: { value: new THREE.Matrix4() },
      camPos: { value: new THREE.Vector3() },
      airSunDir: { value: new THREE.Vector3(0, 1, 0) },
      airSun: { value: new THREE.Color(0, 0, 0) },
      airSky: { value: new THREE.Color(0, 0, 0) },
      airTime: { value: 0 },
      airCover: { value: 0.6 },
      airShadow: { value: 0 },
      airShafts: { value: 0 },
      airHaze: { value: 0 },
    });

    // One triangle that covers the screen.
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.quad = new THREE.Mesh(geometry, this.bright);
    this.quad.frustumCulled = false;
  }

  /** The size of the picture in its own (already chunky) pixels. */
  setSize(w: number, h: number) {
    this.scene.setSize(w, h);
    const half = (n: number, by: number) => Math.max(1, Math.ceil(n / by));
    for (const t of this.soft) t.setSize(half(w, 2), half(h, 2));
    this.glow.forEach((pair, i) => pair.forEach((t) => t.setSize(half(w, 2 << i), half(h, 2 << i))));
    this.final.uniforms.aspect.value = w / h;
  }

  private pass(material: THREE.ShaderMaterial, to: THREE.WebGLRenderTarget | null) {
    this.quad.material = material;
    this.renderer.setRenderTarget(to);
    this.renderer.render(this.quad, this.flat);
  }

  /** Blurs `from` into `pair[1]`, across then down, using `pair[0]` as scratch. */
  private soften(from: THREE.Texture, pair: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget], spread: number) {
    const u = this.blur.uniforms;
    u.tMap.value = from;
    (u.dir.value as THREE.Vector2).set(spread / pair[0].width, 0);
    this.pass(this.blur, pair[0]);
    u.tMap.value = pair[0].texture;
    (u.dir.value as THREE.Vector2).set(0, spread / pair[0].height);
    this.pass(this.blur, pair[1]);
  }

  /**
   * Draws the scene with the finishing pass.
   * @param focus how far the camera is from what it looks at
   * @param night how dark it is outdoors, 0 to 1: glow comes up as the light goes
   * @param air the sky this frame, for cloud shadows, light shafts and haze
   */
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, focus: number, night: number, air: Air) {
    const p = this.params;
    const r = this.renderer;
    const layers = camera.layers.mask;
    camera.layers.disable(OVERLAY_LAYER);
    r.setRenderTarget(this.scene);
    r.render(scene, camera);

    // Glow: pick out the bright parts at half size, then blur them wider and wider.
    this.bright.uniforms.tMap.value = this.scene.texture;
    this.bright.uniforms.threshold.value = p.threshold + (p.thresholdNight - p.threshold) * night;
    this.pass(this.bright, this.glow[0][1]);
    this.soften(this.glow[0][1].texture, this.glow[0], 1);
    for (let i = 1; i < BLOOM_LEVELS; i++) this.soften(this.glow[i - 1][1].texture, this.glow[i], 1);

    this.soften(this.scene.texture, this.soft, 1.4);

    const u = this.final.uniforms;
    u.near.value = camera.near;
    u.far.value = camera.far;
    u.focus.value = focus;
    (u.focusRange.value as THREE.Vector2).set(p.focusNear, p.focusFar);
    u.dof.value = p.dof;
    u.focusSlack.value = p.focusSlack;
    u.bloom.value = p.bloom + (p.bloomNight - p.bloom) * night;
    u.grade.value = p.grade;
    u.vignette.value = p.vignette;
    u.lift.value = p.nightLift * night;
    u.flash.value = air.flash;
    // The grade follows the clock: noon's look gives way to night's as the light goes, and the low sun's
    // (a sunrise's or a sunset's) is laid over both while the sun is near the horizon.
    // It is gold from early afternoon, at full strength for the whole last stretch of the sun's descent,
    // turns pink as the sun reaches the horizon, and the pink lingers well into the dusk. Mornings run the
    // same in reverse: pink before sunrise, then gold.
    const h = air.sunHeight;
    const low = air.outdoors ? (1 - (h >= 0 ? smooth(0.5, 1.12, h) : smooth(0.15, 0.7, -h))) * p.goldenHour : 0;
    const rosy = 1 - smooth(-0.12, 0.32, h);
    const dark = air.outdoors ? night : 0;
    const mix = (pick: (l: (typeof LOOKS)["noon"]) => number) => {
      const day = pick(LOOKS.noon) + (pick(LOOKS.night) - pick(LOOKS.noon)) * dark;
      const hour = pick(LOOKS.gold) + (pick(LOOKS.pink) - pick(LOOKS.gold)) * rosy;
      return day + (hour - day) * low;
    };
    (u.gradeShadow.value as THREE.Vector3).set(mix((l) => l.shadow.x), mix((l) => l.shadow.y), mix((l) => l.shadow.z));
    (u.gradeLight.value as THREE.Vector3).set(mix((l) => l.light.x), mix((l) => l.light.y), mix((l) => l.light.z));
    (u.gradeWash.value as THREE.Vector3).set(mix((l) => l.wash.x), mix((l) => l.wash.y), mix((l) => l.wash.z));
    u.gradeColour.value = mix((l) => l.colour);
    u.gradeGain.value = mix((l) => l.gain);
    // The dim hours get more contrast, not less: bright lights against deep shade is what makes them moody.
    u.contrast.value = p.contrast + p.lowSunContrast * low;
    u.lift.value *= 1 - 0.4 * low;
    // The low sun also makes everything bright glow more.
    u.bloom.value *= 1 + 0.9 * low;
    (u.invViewProj.value as THREE.Matrix4).multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
    (u.camPos.value as THREE.Vector3).setFromMatrixPosition(camera.matrixWorld);
    (u.airSunDir.value as THREE.Vector3).copy(air.sunDir);
    (u.airSun.value as THREE.Color).copy(air.sun);
    (u.airSky.value as THREE.Color).copy(air.sky);
    u.airTime.value = air.clock;
    // A clear day has a few clouds; an overcast one is mostly cloud.
    u.airCover.value = 0.6 - 0.22 * air.overcast;
    // The shadows and shafts are the sun's or moon's doing, so they fade as its light does;
    // the shafts are strongest when it stands low.
    const light = Math.min(1, Math.max(air.sun.r, air.sun.g, air.sun.b));
    u.airShadow.value = air.outdoors ? p.cloudShadow * light : 0;
    u.airShafts.value = air.outdoors ? p.shafts * light * (0.35 + 0.65 * (1 - Math.max(0, air.sunDir.y))) : 0;
    // Less haze while the sun is low: with the sky all one colour it lays a flat veil over the whole island.
    u.airHaze.value = air.outdoors ? p.haze * (1 - 0.45 * low) : 0;
    this.pass(this.final, null);

    // The overlay layer, straight onto the finished picture: no sky to clear it, and no shadow maps to redraw.
    const background = scene.background;
    const autoClear = r.autoClear;
    const shadows = r.shadowMap.autoUpdate;
    scene.background = null;
    r.autoClear = false;
    r.shadowMap.autoUpdate = false;
    camera.layers.set(OVERLAY_LAYER);
    r.render(scene, camera);
    camera.layers.mask = layers;
    scene.background = background;
    r.autoClear = autoClear;
    r.shadowMap.autoUpdate = shadows;
  }

  dispose() {
    this.scene.depthTexture?.dispose();
    for (const t of [this.scene, ...this.soft, ...this.glow.flat()]) t.dispose();
    for (const m of [this.bright, this.blur, this.final]) m.dispose();
    this.quad.geometry.dispose();
  }
}
