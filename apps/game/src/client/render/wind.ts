// Wind, part of "Fancy graphics". Gusts cross the island in fronts, all going
// the one way the wind blows (WIND_DIR), and the trees and the grass lean as
// each one passes: a ripple you can watch travel from one shore to the other.
// It blows harder in rain and hardest in a storm.
//
// The same gust is worked out in two places, and they must agree: here in
// JavaScript for the grass (whose tufts are placed one by one every frame),
// and in the shader below for the trees.

import * as THREE from "three";

/**
 * The way the wind blows across the map, a unit vector on the ground (x, z): mostly along +x, a little toward
 * +z. Everything the wind moves goes by it: the trees and grass lean this way, the wisps travel it, rain and
 * chimney smoke slant with it and flags stream out along it. Fixed in the world, so turning the camera never
 * turns the weather.
 */
export const WIND_DIR = { x: Math.cos(0.35), z: Math.sin(0.35) };

const UNIFORMS = { windTime: { value: 0 }, windPower: { value: 0 } };

const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Once a frame.
 * @param power how hard it blows: 0 is no wind at all (fancy graphics off, or indoors), about 0.35 a calm day, over 1 a storm
 */
export function updateWind(clock: number, power: number) {
  UNIFORMS.windTime.value = clock;
  // Reduced motion: nothing sways.
  UNIFORMS.windPower.value = still ? 0 : power;
}

/** How many spots the grass can be parted round at once: each of the nearest few walkers, and the place just behind each. */
const PARTINGS = 8;
/** Within this far (world units) of a walker, grass is pushed over. */
const PART_REACH = 0.85;
/**
 * `fieldCalm` is 1 while there is no wind and the grass is to sway in its own time anyway (as the tufts do),
 * else 0. `fieldWalkers` are the spots the grass parts round: x and z in the world, and in w how hard (0: unused).
 */
const FIELD = { fieldCalm: { value: 0 }, fieldWalkers: { value: Array.from({ length: PARTINGS }, () => new THREE.Vector4()) } };
/** Where each walker was a moment ago: it trails after them, so the grass they have passed through closes behind them, not at their heels. */
const trails = new WeakMap<object, { x: number; z: number }>();

/**
 * Once a frame: where everyone on the map is standing, so the fields of grass part round them (tall grass a
 * long way, a meadow a little). Only the few nearest `near` (what the camera is looking at) are sent; it all
 * happens in the fields' shader, so nothing is worked out per blade here.
 */
export function setFieldWalkers(walkers: Iterable<{ x: number; z: number }>, near: { x: number; z: number }, dt: number) {
  const nearest = [...walkers].sort((a, b) => Math.hypot(a.x - near.x, a.z - near.z) - Math.hypot(b.x - near.x, b.z - near.z)).slice(0, PARTINGS / 2);
  const slots = FIELD.fieldWalkers.value;
  const ease = Math.min(1, dt * 2.2);
  for (let i = 0; i < PARTINGS / 2; i++) {
    const w = nearest[i];
    if (!w) {
      slots[i * 2].set(0, 0, 0, 0);
      slots[i * 2 + 1].set(0, 0, 0, 0);
      continue;
    }
    let trail = trails.get(w);
    // Someone new, or come from far off (walked in, or set down elsewhere): no trail across the map.
    if (!trail || Math.hypot(trail.x - w.x, trail.z - w.z) > 3) trails.set(w, (trail = { x: w.x, z: w.z }));
    trail.x += (w.x - trail.x) * ease;
    trail.z += (w.z - trail.z) * ease;
    slots[i * 2].set(w.x, 0, w.z, 1);
    slots[i * 2 + 1].set(trail.x, 0, trail.z, 0.75);
  }
}

/** Once a frame, from the ambience: whether the meadows sway to and fro in its own time (no wind, motion allowed). */
export function setFieldCalm(calm: number) {
  FIELD.fieldCalm.value = calm;
}

/** How hard it is blowing right now. */
export const windPower = () => UNIFORMS.windPower.value;

/**
 * How far something standing at (x, z) is pushed over at this moment, 0 upward (it scales with `windPower`).
 * A steady lean, plus the gust front that happens to be passing, which comes in patches so that the
 * fronts are not unbroken lines.
 */
export function gustAt(x: number, z: number): number {
  const t = UNIFORMS.windTime.value;
  const front = (x * WIND_DIR.x + z * WIND_DIR.z) * 0.42 - t * 1.3;
  const gust = (0.5 + 0.5 * Math.sin(front)) ** 2;
  const patchy = 0.6 + 0.4 * Math.sin((x * -WIND_DIR.z + z * WIND_DIR.x) * 0.23 + t * 0.21);
  return UNIFORMS.windPower.value * (0.25 + 0.75 * gust * patchy);
}

const GUST = /* glsl */ `
uniform float windTime;
uniform float windPower;
float windGust(vec2 at) {
  float front = dot(at, vec2(${WIND_DIR.x}, ${WIND_DIR.z})) * 0.42 - windTime * 1.3;
  float gust = pow(0.5 + 0.5 * sin(front), 2.0);
  float patchy = 0.6 + 0.4 * sin(dot(at, vec2(${-WIND_DIR.z}, ${WIND_DIR.x})) * 0.23 + windTime * 0.21);
  return windPower * (0.25 + 0.75 * gust * patchy);
}
void main() {`;

/**
 * Makes a material's field of grass sway: an InstancedMesh of patches whose blades stand on y = 0, at most
 * `height` tall, each patch turned its own way about y, each vertex carrying `aRoot`, the place (x, z) in the
 * patch its blade is rooted. Every blade bends from its root by the gust passing
 * over that very spot, so the gusts can be seen rolling through one patch and on into the next (and with no
 * wind, sways to and fro in its own time, as the tufts do; see setFieldCalm), and leans away from anyone
 * walking through it (setFieldWalkers), all of it on the GPU: nothing is placed again each frame, however
 * many blades there are.
 */
export function addFieldSway(material: THREE.Material, height: number) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, UNIFORMS, FIELD);
    shader.vertexShader = shader.vertexShader.replace("void main() {", `attribute vec2 aRoot;\nuniform float fieldCalm;\nuniform vec4 fieldWalkers[${PARTINGS}];\n` + GUST).replace(
      "#include <begin_vertex>",
      /* glsl */ `#include <begin_vertex>
      #ifdef USE_INSTANCING
      {
        // Where this vertex's blade is rooted, in the world: everything below goes by that, so a blade moves
        // as one piece (by its own vertices' places, its tip and its root would be pushed different ways).
        vec2 at = (instanceMatrix * vec4(aRoot.x, 0.0, aRoot.y, 1.0)).xz;
        float phase = at.x * 0.6 + at.y * 0.35;
        vec2 way = (transpose(mat3(instanceMatrix)) * vec3(${WIND_DIR.x}, 0.0, ${WIND_DIR.z})).xz / max(length(instanceMatrix[0].xyz), 1e-3);
        float lean = windGust(at) * 0.55 + sin(windTime * 3.1 + at.x * 1.7 + at.y * 2.3) * 0.05 * windPower
          + fieldCalm * (sin(windTime * 1.3 + phase) * 0.22 + sin(windTime * 3.1 + phase * 1.7) * 0.07 + 0.08);
        float up = max(position.y, 0.0);
        float bend = up * clamp(up / ${height.toFixed(3)}, 0.0, 1.0);
        transformed.xz += way * lean * bend;
        // Parted by whoever is walking through: the whole blade leans away from each of them, the harder the
        // nearer, and is laid lower as it goes over. The taller the blade the further its tip travels, so tall
        // grass opens wide. A blade right under their feet has no way to lean: it is trodden flat instead.
        vec2 push = vec2(0.0);
        float trodden = 0.0;
        for (int i = 0; i < ${PARTINGS}; i++) {
          vec2 off = at - fieldWalkers[i].xz;
          float d = length(off);
          push += (off / max(d, 0.22)) * (1.0 - smoothstep(0.0, ${PART_REACH.toFixed(2)}, d)) * fieldWalkers[i].w;
          trodden = max(trodden, (1.0 - smoothstep(0.08, 0.3, d)) * fieldWalkers[i].w);
        }
        float over = length(push);
        if (over > 1.0) push /= over;
        over = min(over, 1.0);
        transformed.xz += (transpose(mat3(instanceMatrix)) * vec3(push.x, 0.0, push.y)).xz * 0.5 * bend;
        transformed.y -= over * 0.28 * bend;
        transformed.y *= 1.0 - 0.8 * trodden;
      }
      #endif`,
    );
  };
  material.customProgramCacheKey = () => `field-sway-${height}`;
}

/**
 * Makes a material's old oaks move in the wind. Like addWindSway (an InstancedMesh, each tree standing upright
 * about its own middle, `height` tall, turned its own way), but an old oak is stout: the whole of it leans
 * only a third as far. Its leaves make up for it. Each vertex carries `aLeaf`: for a leaf, where its stem is
 * (x, y, z) and 1; for wood, all 0. A leaf moves as one piece, like a blade of grass, never changing shape:
 * it is carried a little downwind and back, further as a gust passes, and flutters about its stem, turning
 * and dipping in its own time, so the crown shimmers while the trunk barely moves.
 */
export function addOakSway(material: THREE.Material, height: number) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, UNIFORMS);
    shader.vertexShader = shader.vertexShader.replace("void main() {", "attribute vec4 aLeaf;\n" + GUST).replace(
      "#include <begin_vertex>",
      /* glsl */ `#include <begin_vertex>
      #ifdef USE_INSTANCING
      {
        vec2 root = instanceMatrix[3].xz;
        float size = max(length(instanceMatrix[0].xyz), 1e-3);
        vec2 way = (transpose(mat3(instanceMatrix)) * vec3(${WIND_DIR.x}, 0.0, ${WIND_DIR.z})).xz / size;
        float up = clamp(position.y / ${height.toFixed(3)} + 0.5, 0.0, 1.0);
        float gust = windGust(root);
        float lean = gust * 0.07 + sin(windTime * 2.1 + root.x * 1.7 + root.y * 2.3) * 0.008 * windPower;
        transformed.xz += way * lean * up * up;
        // The leaf as one piece: every vertex of it gets the same drift downwind, and the same small turns about
        // its stem (small angles, so a cross product does for each rotation): a dip across the wind, and a twist.
        vec3 stem = aLeaf.xyz;
        float own = dot(stem, vec3(53.0, 31.0, 47.0)) + root.x * 0.9 + root.y * 0.7;
        // Neighbouring leaves drift together (by where they are, coarsely), so the crown heaves; each flutters alone.
        float drift = aLeaf.w * (gust * 0.025 + windPower * 0.008 * sin(windTime * 1.7 + dot(stem, vec3(5.0, 3.0, 4.0)) + root.x));
        transformed.xz += way * drift;
        vec3 arm = position - stem;
        float dip = aLeaf.w * (gust * 0.45 * sin(windTime * 4.3 + own) + windPower * 0.12 * sin(windTime * 6.1 + own * 1.7));
        float twist = aLeaf.w * (gust * 0.35 + windPower * 0.1) * sin(windTime * 5.2 + own * 2.3);
        transformed += dip * cross(vec3(-way.y, 0.0, way.x), arm) + twist * cross(vec3(0.0, 1.0, 0.0), arm);
      }
      #endif`,
    );
  };
  material.customProgramCacheKey = () => `oak-sway-${height}`;
}

/**
 * Makes a material's trees sway. For an InstancedMesh of trees whose geometry stands upright about its own
 * middle, `height` tall: each bends from its foot, most at the tip, by the gust passing where it stands,
 * with a small shiver of its own on top.
 */
export function addWindSway(material: THREE.Material, height: number, turned = false) {
  // Trees that are each turned their own way about y have the wind turned back into their own frame,
  // so they all still lean the one way it blows.
  const way = turned
    ? /* glsl */ `(transpose(mat3(instanceMatrix)) * vec3(${WIND_DIR.x}, 0.0, ${WIND_DIR.z})).xz / max(length(instanceMatrix[0].xyz), 1e-3)`
    : /* glsl */ `vec2(${WIND_DIR.x}, ${WIND_DIR.z})`;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, UNIFORMS);
    shader.vertexShader = shader.vertexShader.replace("void main() {", GUST).replace(
      "#include <begin_vertex>",
      /* glsl */ `#include <begin_vertex>
      #ifdef USE_INSTANCING
      {
        vec2 root = instanceMatrix[3].xz;
        float up = clamp(position.y / ${height.toFixed(3)} + 0.5, 0.0, 1.0);
        float lean = windGust(root) * 0.2 + sin(windTime * 3.3 + root.x * 1.7 + root.y * 2.3) * 0.025 * windPower;
        transformed.xz += ${way} * lean * up * up;
      }
      #endif`,
    );
  };
  material.customProgramCacheKey = () => `wind-sway-${height}${turned ? "-turned" : ""}`;
}
