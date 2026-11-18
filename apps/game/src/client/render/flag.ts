// A flag flying from a pole: a sheet of cloth whose ripples run from the pole
// out to its free end, bigger toward the end, with a second, quicker ripple on
// top so it never quite repeats. In a lull it hangs a little; in a gust it
// streams out and snaps. A handful of vertices moved each frame, nothing more.

import * as THREE from "three";

/** The crew's pennant: red, with a gold stripe along it and a darker hem at the pole. Pixel art, as the rest is. */
export function pennantTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 20;
  canvas.height = 10;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#b23a2e";
  ctx.fillRect(0, 0, 20, 10);
  ctx.fillStyle = "#e9c85a";
  ctx.fillRect(0, 4, 20, 2);
  // The hem, where it is sewn round the pole: the texture's right edge, as the cloth hangs off to the left.
  ctx.fillStyle = "#7d2720";
  ctx.fillRect(19, 0, 1, 10);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

/**
 * Ripple a flag's cloth. `cloth` is a plane in x and y with its pole edge at x = 0 and its free end out along
 * -x, its resting places kept in `userData.rest`. `blow` is how hard the wind is on it: about 0.5 a breeze,
 * over 1 a gale.
 */
export function waveFlag(cloth: THREE.BufferGeometry, clock: number, blow: number) {
  const rest = cloth.userData.rest as Float32Array | undefined;
  if (!rest) return;
  const pos = cloth.getAttribute("position") as THREE.BufferAttribute;
  let length = 0;
  for (let i = 0; i < pos.count; i++) length = Math.max(length, -rest[i * 3]);
  if (length <= 0) return;
  const k = Math.min(1.6, blow);
  const amp = length * (0.06 + 0.1 * k);
  const speed = 5 + 4 * k;
  // In a lull the free end sags; it streams out level as the wind picks up.
  const sag = length * 0.18 * Math.max(0, 1 - k);
  for (let i = 0; i < pos.count; i++) {
    const x = rest[i * 3], y = rest[i * 3 + 1];
    const u = -x / length;
    const phase = u * 7 - clock * speed;
    const z = amp * u * (Math.sin(phase) + 0.35 * Math.sin(phase * 1.9 + y * 9 + 1.3));
    // The cloth does not stretch: the more it ripples the nearer its end comes in to the pole.
    pos.setXYZ(i, x * (1 - 0.06 * k * u), y - sag * u * u, z);
  }
  pos.needsUpdate = true;
}
