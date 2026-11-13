// Fancy water: with "Fancy graphics" on, the sea and the water hexes are
// drawn as one unbroken, moving surface: rolling waves that catch the light,
// the sky's colour on their far slopes, a bright path toward the sun or moon,
// lantern and fire light glancing off them at night, paler shallows and foam
// along the shore. The water's own colour is cut into flat steps with hard
// edges, like the flat-shaded ground beside it; the reflections on it are smooth.
// It is added to the materials the water already uses,
// and does nothing while the setting is off, so the plain sea is exactly as it was.

import * as THREE from "three";

const STANDING = 12;
const RIPPLES = 8;

/** Shared by every water material: one clock, one sun, one sky. */
const UNIFORMS = {
  waterTime: { value: 0 },
  waterFancy: { value: 0 },
  waterSunDir: { value: new THREE.Vector3(0, 1, 0) },
  waterGlint: { value: new THREE.Color(0, 0, 0) },
  waterBase: { value: new THREE.Color("#3577cf") },
  waterSky: { value: new THREE.Color("#a9dcf7") },
  waterRain: { value: 0 },
  waterStars: { value: 0 },
  // How wet the ground is, 0 (dry) to 1 (soaked).
  waterWet: { value: 0 },
  // The moon's reflection: where it lies (x, z) and how bright it is.
  waterMoon: { value: new THREE.Vector3(0, 0, 0) },
  // Things standing in the water, which the sea breaks round: where (x, z), half their length along x, and how wide.
  waterStanding: { value: Array.from({ length: STANDING }, () => new THREE.Vector4(0, 0, 0, 0)) },
  // Rings opening where something touched the water: where (x, z) and when (on the water's clock).
  waterRipples: { value: Array.from({ length: RIPPLES }, () => new THREE.Vector3(0, 0, -99)) },
};

/** Something standing in the water for the sea to foam round: rocks, a wreck, a moored ship. */
export type Standing = { x: number; z: number; /** Half its length along x; 0 for something round. */ half: number; /** How far from its middle line its edge is. */ radius: number };

/** Tells the water what stands in it on this map. Anything past the first dozen is left without foam. */
export function setWaterStanding(things: Standing[]) {
  UNIFORMS.waterStanding.value.forEach((v, i) => {
    const t = things[i];
    if (t) v.set(t.x, t.z, t.half, t.radius);
    else v.set(0, 0, 0, 0);
  });
}

/**
 * The night sky on the water.
 * @param stars how clearly the stars show, 0 (day or overcast) to 1
 * @param moonX where the moon's reflection lies on the sea
 * @param moonZ
 * @param moon how bright the moon's reflection is, 0 to 1
 */
export function setWaterNight(stars: number, moonX: number, moonZ: number, moon: number) {
  UNIFORMS.waterStars.value = stars;
  UNIFORMS.waterMoon.value.set(moonX, moonZ, moon);
}

/** How wet the ground is, 0 (dry) to 1 (soaked): it darkens, puddles gather, and lights glint off it. */
export function setGroundWet(wet: number) {
  UNIFORMS.waterWet.value = wet;
}

let nextRipple = 0;
/** Opens a ring on the water at a spot, as from a footstep at the water's edge. */
export function addWaterRipple(x: number, z: number) {
  UNIFORMS.waterRipples.value[nextRipple].set(x, z, UNIFORMS.waterTime.value);
  nextRipple = (nextRipple + 1) % RIPPLES;
}

const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Once a frame.
 * @param sunDir the direction to the sun or moon
 * @param glint the colour and strength of the sun's or moon's light
 * @param base the sea's own colour right now (it darkens at night and greys in the rain)
 * @param sky the sky's colour, which the waves reflect
 * @param rain how hard it is raining, 0 to 1: raindrops ring the water
 */
export function updateWater(on: boolean, clock: number, sunDir: THREE.Vector3, glint: THREE.Color, base: THREE.Color, sky: THREE.Color, rain: number) {
  UNIFORMS.waterRain.value = rain;
  UNIFORMS.waterFancy.value = on ? 1 : 0;
  // Reduced motion: the water keeps its look but holds still.
  if (!still) UNIFORMS.waterTime.value = clock;
  UNIFORMS.waterSunDir.value.copy(sunDir);
  UNIFORMS.waterGlint.value.copy(glint);
  UNIFORMS.waterBase.value.copy(base);
  UNIFORMS.waterSky.value.copy(sky);
}

/**
 * What each hex of the ground tells the shader, three numbers a hex:
 * whether it is water (1) or not (0); which of its six sides touch land
 * (one bit a side, in the order of `shoreSide`); and, for land, what kind of
 * ground it is (see GROUND_KIND), so its top can be painted to suit.
 */
export function waterAttribute(count: number): THREE.InstancedBufferAttribute {
  return new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
}

/** The kinds of ground that get painted detail on top: 0 is none (it is left one flat colour). */
export const GROUND_KIND: Record<string, number> = { plains: 1, forest: 2, hills: 3 };

/**
 * Which side of a hex faces a neighbour that lies toward (dx, dz) in the world: 0 to 5, matching the shader.
 * The ground's hexes have a corner pointing along +z, so their sides face 30°, 90°, ... round from there.
 */
export function shoreSide(dx: number, dz: number): number {
  const turn = Math.atan2(dx, dz) - Math.PI / 6;
  return ((Math.round(turn / (Math.PI / 3)) % 6) + 6) % 6;
}

const VERT_HEAD = /* glsl */ `
#ifdef WATER_TILES
attribute vec3 aWater;
varying vec2 vWaterTile;
varying float vGround;
varying vec2 vWaterLocal;
varying float vWaterTop;
uniform float waterFancy;
#endif
varying vec3 vWaterPos;
void main() {`;

// The ground's hexes are drawn a little small, which leaves a dark seam between them, and the water hexes stand a
// touch above the open sea. Water hexes are grown to meet each other and lowered to the sea's level, so it is
// all one unbroken surface.
const VERT_BEGIN = /* glsl */ `#include <begin_vertex>
#ifdef WATER_TILES
if (aWater.x > 0.5 && waterFancy > 0.5) {
  transformed.xz *= 1.0 / 0.985;
  // Flattened to a sheet at the hex's top, so no side of a hex shows along the edge.
  transformed.y = 1.0;
}
#endif`;

const VERT_BODY = /* glsl */ `#include <project_vertex>
{
  vec4 waterAt = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  waterAt = instanceMatrix * waterAt;
  #endif
  vWaterPos = (modelMatrix * waterAt).xyz;
  #ifdef WATER_TILES
  vWaterTile = aWater.xy;
  vGround = aWater.z;
  vWaterLocal = position.xz;
  vWaterTop = step(0.5, normal.y);
  #endif
}`;

const FRAG_HEAD = /* glsl */ `
uniform float waterTime;
uniform float waterFancy;
uniform vec3 waterSunDir;
uniform vec3 waterGlint;
uniform vec3 waterBase;
uniform vec3 waterSky;
uniform float waterRain;
uniform float waterStars;
uniform vec3 waterMoon;
uniform float waterWet;
#ifdef WATER_TILES
varying float vWaterTop;
varying float vGround;
#endif
uniform vec4 waterStanding[${STANDING}];
uniform vec3 waterRipples[${RIPPLES}];
varying vec3 vWaterPos;
#ifdef WATER_TILES
varying vec2 vWaterTile;
varying vec2 vWaterLocal;
#endif
// The size of one step of the water's tone.
const float WATER_STEP = 0.1;
// The water's patterns are drawn in squares this many to a world unit: chunky pixels lying on the sea.
const float WATER_GRID = 11.0;
// And the land's detail a little finer.
const float LAND_GRID = 14.0;
float waterHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
vec2 waterHash2(vec2 p) {
  return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
}
// A web of wandering cells: small where two cells meet, so a threshold on it draws the web's lines.
float waterWeb(vec2 p, float t) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float nearest = 8.0;
  float next = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = 0.5 + 0.4 * sin(t + 6.2832 * waterHash2(i + g));
      float d = length(g + o - f);
      if (d < nearest) {
        next = nearest;
        nearest = d;
      } else if (d < next) next = d;
    }
  }
  return next - nearest;
}
// Now and then a wave breaks: a burst of white and a scatter of spray, then it is gone.
// The sea is cut into big squares, and each has one break at its own moment and a new place every time.
float waterSplash(vec2 at, float size, float every, float salt) {
  vec2 c = floor(at / size);
  float seed = waterHash(c + salt);
  float period = every * (0.7 + 0.6 * seed);
  float turn = waterTime / period + seed * 10.0;
  float u = fract(turn) * period / 0.9;
  if (u > 1.0) return 0.0;
  vec2 centre = (c + 0.25 + 0.5 * waterHash2(c + floor(turn) * 1.7 + salt)) * size;
  float d = length(at - centre);
  float r = 0.12 + 0.5 * u;
  float burst = step(d, 0.24 * (1.0 - u * 1.8));
  float spray = step(d, r) * step(0.74, waterHash(floor(at * WATER_GRID) + floor(waterTime * 10.0))) * (1.0 - u);
  return max(burst, step(0.3, spray));
}
// Rain on the sea: small rings that open where the drops land. More of them the harder it rains.
float waterDrops(vec2 at) {
  if (waterRain <= 0.02) return 0.0;
  vec2 c = floor(at / 1.3);
  float seed = waterHash(c + 5.3);
  float period = 1.4 + 1.6 * seed;
  float turn = waterTime / period + seed * 10.0;
  float u = fract(turn);
  // Each square of sea takes a drop only some of the time: all of the time in a downpour.
  if (waterHash(c + floor(turn) * 3.3) > waterRain) return 0.0;
  vec2 centre = (c + 0.2 + 0.6 * waterHash2(c + floor(turn) * 1.7)) * 1.3;
  float d = length(at - centre);
  return step(abs(d - (0.06 + 0.34 * u)), 0.05) * step(u, 0.75) * (1.0 - u);
}
float waterNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(waterHash(i), waterHash(i + vec2(1.0, 0.0)), f.x), mix(waterHash(i + vec2(0.0, 1.0)), waterHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// One train of waves: adds its slope (x, y) and its height (z).
void waterTrain(inout vec3 sum, vec2 p, vec2 dir, float tight, float speed, float steep) {
  float phase = dot(p, dir) * tight + waterTime * speed;
  sum += vec3(dir * cos(phase) * steep, sin(phase) * steep);
}
void main() {
  vec3 waterShine = vec3(0.0);`;

const FRAG_BODY = /* glsl */ `#include <color_fragment>
{
  #ifdef WATER_TILES
  // The ground's own detail, painted in small squares on the top of each hex: no two hexes alike, and
  // nothing that moves. Each kind of ground keeps its colour and gets its own marks.
  if (waterFancy > 0.5 && vWaterTop > 0.5 && vGround > 0.5) {
    vec2 square = floor(vWaterPos.xz * LAND_GRID);
    vec2 at = (square + 0.5) / LAND_GRID;
    float roll = waterHash(square + 11.0);
    // Where the marks gather, and broad patches a shade lighter or darker.
    float clump = waterNoise(at * 1.4 + 5.0);
    float shade = floor(waterNoise(at * 0.45 + 2.0) * 3.0) / 2.0;
    vec3 ground = diffuseColor.rgb;
    if (vGround < 1.5) {
      // Grass: sunlit blades in tufts, darker ones between, and now and then a small flower.
      ground *= 0.94 + 0.1 * shade;
      ground = mix(ground, ground * vec3(1.18, 1.2, 0.9), step(1.0 - 0.17 * clump, roll));
      ground = mix(ground, ground * vec3(0.8, 0.86, 0.85), step(roll, 0.1 * (1.0 - clump)));
      float flower = step(0.9972, waterHash(square + 71.0)) * step(0.5, clump);
      ground = mix(ground, mix(vec3(0.93, 0.9, 0.78), vec3(0.93, 0.76, 0.3), step(0.5, waterHash(square + 3.0))), flower);
    } else if (vGround < 2.5) {
      // Forest floor: deeper shade, with fallen leaves and bare dark earth.
      ground *= 0.9 + 0.12 * shade;
      ground = mix(ground, ground * vec3(1.3, 1.02, 0.66), step(0.93, roll) * 0.85);
      ground = mix(ground, ground * 0.76, step(roll, 0.09));
    } else {
      // Hills: bands of rock, with pale chips and dark pits.
      ground *= 0.93 + 0.1 * shade;
      ground *= 1.0 - 0.07 * step(0.5, fract(waterNoise(at * 0.9 + 8.0) * 6.0));
      ground = mix(ground, ground * 1.2, step(0.94, roll));
      ground = mix(ground, ground * 0.78, step(roll, 0.07));
    }
    diffuseColor.rgb = ground;
  }
  #endif
  #ifdef WATER_TILES
  float waterIs = step(0.5, vWaterTile.x) * waterFancy;
  #else
  float waterIs = waterFancy;
  #endif
  if (waterIs > 0.5) {
    // Everything is worked out at the middle of a chunky square of sea, so the patterns are made of pixels.
    vec2 pix = (floor(vWaterPos.xz * WATER_GRID) + 0.5) / WATER_GRID;
    // Four trains of long, slow waves crossing each other, on a surface bent by slow noise so the
    // pattern never lines up or repeats.
    vec2 p = pix + 2.4 * vec2(waterNoise(pix * 0.21 + waterTime * 0.03), waterNoise(pix * 0.21 + 31.7 - waterTime * 0.025));
    p += 0.7 * vec2(waterNoise(pix * 0.75 - waterTime * 0.05), waterNoise(pix * 0.75 + 9.4 + waterTime * 0.04));
    vec3 waves = vec3(0.0);
    waterTrain(waves, p, vec2(0.8, 0.6), 1.1, 0.7, 0.10);
    waterTrain(waves, p, vec2(-0.5, 0.866), 1.9, 1.0, 0.08);
    waterTrain(waves, p, vec2(0.2, -0.98), 3.3, 1.4, 0.06);
    waterTrain(waves, p, vec2(-0.954, -0.3), 5.6, 1.9, 0.04);
    vec3 tilt = normalize(vec3(-waves.x, 1.0, -waves.y));
    float crest = waves.z / 0.28 * 0.5 + 0.5;
    // No two stretches of sea alike: a slow, patchy swell lifts some of it and sinks the rest, and wide
    // drifting pools of deeper water lie under it all.
    crest = clamp(crest + (waterNoise(p * 0.8 + waterTime * 0.08) - 0.5) * 0.7, 0.0, 1.0);
    float deep = waterNoise(pix * 0.16 + waterTime * 0.012) * 0.6 + waterNoise(pix * 0.41 - waterTime * 0.02) * 0.4;
    vec3 eye = normalize(cameraPosition - vWaterPos);

    // The water's own colour: clear and a little green, gently deeper in the troughs and brighter on
    // slopes that face the light, in flat steps of tone.
    float tone = (0.84 + 0.34 * crest) * clamp(1.0 + 1.5 * (dot(tilt, waterSunDir) - waterSunDir.y), 0.7, 1.4);
    // Depth: dark pools between the swells, and a pale lip along the top of each wave.
    tone *= 0.8 + 0.34 * smoothstep(0.25, 0.75, deep);
    tone += 0.16 * step(0.86, crest);
    vec3 clear = mix(vec3(dot(waterBase, vec3(0.2126, 0.7152, 0.0722))), waterBase, 1.2) * vec3(0.86, 1.14, 1.08) * 1.12;
    vec3 sea = clear * (floor(tone / WATER_STEP + 0.5) * WATER_STEP);
    float shallow = 0.0;
    float caustic = 0.0;

    #ifdef WATER_TILES
    // How far this spot is from the nearest side that touches land.
    float edge = 9.0;
    // Rounded: a whole number handed across a triangle can arrive a hair off, and then the wrong sides read as shore.
    float sides = floor(vWaterTile.y + 0.5);
    // The same chunky square, measured from the middle of this hex.
    vec2 local = vWaterLocal + (pix - vWaterPos.xz) * 0.985;
    for (int k = 0; k < 6; k++) {
      float half_ = floor(sides * 0.5 + 0.01);
      float touches = sides - half_ * 2.0;
      sides = half_;
      float a = radians(30.0 + 60.0 * float(k));
      if (touches > 0.5) edge = min(edge, 0.853 - dot(local, vec2(sin(a), cos(a))));
    }
    // Shallows: paler and greener toward the land.
    float ragged = waterNoise(pix * 2.3 + waterTime * 0.25);
    shallow = floor(smoothstep(0.95, 0.0, edge + 0.12 * ragged) * 3.0 + 0.5) / 3.0;
    sea = mix(sea, sea * vec3(0.85, 1.3, 1.2) + vec3(0.0, 0.035, 0.035), shallow * 0.75);
    #endif

    // Caustics: a slow web of light, as on the floor of clear water. Brightest in the shallows.
    {
      // Bent twice, widely and finely, so the web's threads curve like light through ripples.
      vec2 q = pix + 0.6 * vec2(waterNoise(pix * 0.8 + waterTime * 0.06), waterNoise(pix * 0.8 + 11.3 - waterTime * 0.05));
      q += 0.22 * vec2(waterNoise(pix * 2.6 - waterTime * 0.11), waterNoise(pix * 2.6 + 5.9 + waterTime * 0.09));
      float web = waterWeb(q * 0.8 + waterTime * vec2(0.03, 0.02), waterTime * 0.5);
      float fine = waterWeb(q * 1.5 + 17.0 - waterTime * vec2(0.02, 0.04), waterTime * 0.7);
      float light = max(step(web, 0.07), step(fine, 0.05) * 0.55) + step(web, 0.16) * 0.3;
      caustic = min(light, 1.0) * (0.45 + 0.4 * shallow);
      sea = mix(sea, sea * 1.35 + vec3(0.03, 0.09, 0.09), caustic);
    }

    // Foam, all of it white: breaking waves out at sea, then the shore's own.
    float foam = max(waterSplash(pix, 3.4, 9.0, 3.1), waterDrops(pix) * 0.8);
    // The sea breaks round whatever stands in it: a ragged collar of foam at its edge, and a fainter
    // ring that drifts out from it now and then.
    float collar = waterNoise(pix * 3.1 + waterTime * 0.3);
    for (int i = 0; i < ${STANDING}; i++) {
      vec4 it = waterStanding[i];
      if (it.w <= 0.0) continue;
      vec2 off = pix - it.xy;
      off.x -= clamp(off.x, -it.z, it.z);
      float d = length(off) - it.w;
      foam = max(foam, step(abs(d - 0.05 * collar), 0.05 + 0.04 * collar));
      float out_ = fract(waterTime * 0.16 + float(i) * 0.37);
      foam = max(foam, step(abs(d - 0.12 - 0.5 * out_), 0.035) * (1.0 - out_) * 0.55 * step(0.35, collar));
    }
    // Rings where a foot came down at the water's edge.
    for (int i = 0; i < ${RIPPLES}; i++) {
      float age = waterTime - waterRipples[i].z;
      if (age < 0.0 || age > 1.4) continue;
      float d = length(pix - waterRipples[i].xy);
      foam = max(foam, step(abs(d - 0.08 - 0.34 * age), 0.045) * (1.0 - age / 1.4) * 0.8);
    }
    #ifdef WATER_TILES
    // A solid line against the land, and rings of it drifting out from the shore, thinning as they go.
    foam = max(foam, step(edge, 0.07 + 0.08 * ragged));
    float reach = clamp(1.0 - edge / 0.95, 0.0, 1.0);
    float ring = step(fract(edge * 2.4 - waterTime * 0.22 + ragged * 0.35), 0.26 * reach) * step(0.3, ragged);
    foam = max(foam, ring * (0.35 + 0.5 * reach));
    // Now and then a wave breaks on the shore: the line swells and throws spray.
    {
      vec2 c = floor(pix / 2.2);
      float seed = waterHash(c + 8.7);
      float period = 5.0 + 5.0 * seed;
      float u = fract(waterTime / period + seed * 10.0) * period / 0.9;
      if (u < 1.0) {
        float swell = sin(u * 3.1416);
        float spray = step(0.72, waterHash(floor(pix * WATER_GRID) + floor(waterTime * 10.0)));
        foam = max(foam, step(edge, 0.08 + 0.16 * swell));
        foam = max(foam, step(edge, 0.12 + 0.34 * swell) * spray);
      }
    }
    #endif
    sea = mix(sea, vec3(0.9, 0.96, 1.0), foam * 0.9);

    // Slopes leaning away from the eye show the sky instead of the water.
    float mirror = clamp(0.9 * pow(1.0 - max(dot(tilt, eye), 0.0), 2.0), 0.0, 0.45) * (1.0 - 0.6 * caustic);
    diffuseColor.rgb = sea * (1.0 - mirror);
    waterShine = waterSky * mirror * 0.85;
    // The caustics are light themselves, so the sky's reflection does not hide them: they glow in the colour of
    // the sun or moon, stronger the higher it stands, and warm where a lantern or fire reaches (below).
    vec3 causticGlow = caustic * clear * (0.6 + 0.8 * mirror / 0.45);
    waterShine += causticGlow * (vec3(0.22) + waterGlint * (0.45 + 0.6 * max(waterSunDir.y, 0.0)));

    // The path of light toward the sun or moon: crisp sparkles, and a soft sheen around them.
    // The reflections stay smooth: they are light on the water, not the water's own paint.
    float sun = max(dot(tilt, normalize(waterSunDir + eye)), 0.0);
    // The sheen is kept faint, and fainter still over a caustic, so a low sun or moon never washes the web out.
    waterShine += waterGlint * (step(0.3, pow(sun, 260.0)) * 1.6 + pow(sun, 36.0) * 0.07 * (1.0 - 0.7 * caustic));

    // The night sky on the water. Stars: single pixels scattered over the sea, each twinkling in its own
    // time, and sliding a little as the waves pass under them.
    if (waterStars > 0.02) {
      vec2 sky = floor((pix + tilt.xz * 0.5) * WATER_GRID);
      float star = waterHash(sky * 1.31 + 3.7);
      if (star > 0.9955) {
        float twinkle = 0.55 + 0.45 * sin(waterTime * (1.5 + star * 300.0) + star * 900.0);
        waterShine += vec3(0.75, 0.85, 1.0) * twinkle * waterStars * (1.0 - foam) * 0.9;
      }
    }
    // The moon: a broken disc of light lying on the sea, and a path of glints running from it toward the eye.
    if (waterMoon.z > 0.01) {
      vec2 from = pix + tilt.xz * 1.6 - waterMoon.xy;
      float disc = step(length(from), 0.68);
      vec2 toEye = normalize(cameraPosition.xz - waterMoon.xy);
      float along = dot(from, toEye);
      float across = abs(dot(from, vec2(-toEye.y, toEye.x)));
      float path = step(0.6, along) * step(along, 7.0) * step(across, 0.55 * (1.0 - along / 7.5)) * step(0.62, crest);
      waterShine += vec3(0.8, 0.88, 1.0) * waterMoon.z * (disc * 0.75 + path * 0.5) * (1.0 - foam);
    }

    // Lanterns, windows and fires glance off the waves near them.
    #if NUM_POINT_LIGHTS > 0
    vec3 tiltSeen = normalize((viewMatrix * vec4(tilt, 0.0)).xyz);
    vec3 eyeSeen = normalize(vViewPosition);
    for (int i = 0; i < NUM_POINT_LIGHTS; i++) {
      vec3 toLamp = pointLights[i].position + vViewPosition;
      float far = length(toLamp);
      float reach = getDistanceAttenuation(far, pointLights[i].distance, pointLights[i].decay);
      float lamp = max(dot(tiltSeen, normalize(toLamp / far + eyeSeen)), 0.0);
      waterShine += pointLights[i].color * reach * (pow(lamp, 90.0) * 2.2 + pow(lamp, 14.0) * 0.14 + caustic * 0.9);
    }
    #endif
  }
  #ifdef WATER_TILES
  // Rain on the land: the top of every hex darkens as it gets wet, shallow puddles gather in the low
  // spots, and lanterns and fires glint off both. It dries slowly once the rain stops.
  else if (waterFancy > 0.5 && waterWet > 0.01 && vWaterTop > 0.5) {
    vec2 pix = (floor(vWaterPos.xz * WATER_GRID) + 0.5) / WATER_GRID;
    float low = waterNoise(pix * 0.8 + 3.3) * 0.65 + waterNoise(pix * 2.1 + 1.7) * 0.35;
    // The puddles start small in the lowest spots and spread as the ground wets, and the water in them
    // comes up gradually too, so nothing appears all at once when the rain starts.
    float brim = 0.86 - 0.34 * smoothstep(0.1, 1.0, waterWet);
    float puddle = step(brim, low) * smoothstep(0.08, 0.75, waterWet);
    diffuseColor.rgb *= mix(1.0, 0.72, waterWet);
    // A puddle is a thin film of water: the ground shows through it, barely darker, with a faint
    // sheen of sky on top, a pale line at its brim, and rings where the drops land.
    diffuseColor.rgb *= 1.0 - 0.1 * puddle;
    // Its surface is never quite still: small ripples cross it, as on the sea but finer, so it catches
    // the sky, the sun and the lamps differently from every angle and from moment to moment.
    vec3 fine = vec3(0.0);
    waterTrain(fine, pix, vec2(0.8, 0.6), 7.0, 1.5, 0.06);
    waterTrain(fine, pix, vec2(-0.5, 0.866), 11.0, 2.2, 0.05);
    waterTrain(fine, pix, vec2(0.2, -0.98), 17.0, 3.0, 0.035);
    vec3 film = normalize(vec3(-fine.x, 1.0, -fine.y));
    vec3 eye = normalize(cameraPosition - vWaterPos);
    // More of the sky shows the lower the eye is to the water, and on the ripples that lean away from it.
    float mirror = clamp(1.6 * pow(1.0 - max(dot(film, eye), 0.0), 2.0), 0.0, 0.7);
    waterShine += waterSky * (0.05 + 0.4 * mirror) * puddle;
    float sun = max(dot(film, normalize(waterSunDir + eye)), 0.0);
    // A soft sheen only. Hard single-pixel glints, as on the sea, read as stray white dots on the ground.
    waterShine += waterGlint * pow(sun, 30.0) * 0.16 * puddle;
    waterShine += waterSky * 0.12 * puddle * step(low, brim + 0.022);
    waterShine += vec3(0.5, 0.55, 0.62) * waterDrops(pix) * puddle * 0.4;
    #if NUM_POINT_LIGHTS > 0
    // The ground is not quite flat, so the glint breaks up; a puddle's glint moves with its ripples.
    vec3 lie = normalize(vec3((waterNoise(pix * 3.1) - 0.5) * 0.3, 1.0, (waterNoise(pix * 3.1 + 9.0) - 0.5) * 0.3));
    vec3 lieSeen = normalize((viewMatrix * vec4(mix(lie, film, puddle), 0.0)).xyz);
    vec3 eyeSeen = normalize(vViewPosition);
    for (int i = 0; i < NUM_POINT_LIGHTS; i++) {
      vec3 toLamp = pointLights[i].position + vViewPosition;
      float far = length(toLamp);
      float reach = getDistanceAttenuation(far, pointLights[i].distance, pointLights[i].decay);
      float lamp = max(dot(lieSeen, normalize(toLamp / far + eyeSeen)), 0.0);
      waterShine += pointLights[i].color * reach * waterWet * (pow(lamp, 70.0) * (0.5 + 1.4 * puddle) + pow(lamp, 12.0) * 0.06);
    }
    #endif
  }
  #endif
}`;

/**
 * Teaches a material the fancy water. `tiles` is for the ground's hexes, which carry `waterAttribute` as `aWater`
 * and are only partly water; without it the whole surface is open sea.
 */
export function addFancyWater(material: THREE.MeshLambertMaterial, tiles = false) {
  if (tiles) material.defines = { ...material.defines, WATER_TILES: "" };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, UNIFORMS);
    shader.vertexShader = shader.vertexShader
      .replace("void main() {", VERT_HEAD)
      .replace("#include <begin_vertex>", VERT_BEGIN)
      .replace("#include <project_vertex>", VERT_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", FRAG_HEAD)
      .replace("#include <color_fragment>", FRAG_BODY)
      .replace("#include <opaque_fragment>", "outgoingLight += waterShine;\n#include <opaque_fragment>");
  };
  // Every water material shares one program for each kind.
  material.customProgramCacheKey = () => (tiles ? "fancy-water-tiles" : "fancy-water-sea");
}
