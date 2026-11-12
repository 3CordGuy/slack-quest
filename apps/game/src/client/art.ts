// Hands the content bundle's palettes and icons to the renderers. Palettes
// apply as they are; icon PNGs are decoded to pixels once per distinct image
// (so drawing an icon stays synchronous) before the first screen paints.

import type { ContentBundle } from "./content";
import { ICON_SIZE, setIconOverrides, type IconPixels } from "./itemArt";
import { setLookOverrides } from "./render/sprites";

const decoded = new Map<string, IconPixels>();

/** A base64 PNG as 16x16 RGBA pixels, or null if it can't be read or is the wrong size. */
export async function decodeIcon(png: string): Promise<IconPixels | null> {
  const hit = decoded.get(png);
  if (hit) return hit;
  try {
    const img = new Image();
    img.src = `data:image/png;base64,${png}`;
    await img.decode();
    if (img.naturalWidth !== ICON_SIZE || img.naturalHeight !== ICON_SIZE) return null;
    const canvas = document.createElement("canvas");
    canvas.width = ICON_SIZE;
    canvas.height = ICON_SIZE;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, ICON_SIZE, ICON_SIZE).data;
    decoded.set(png, pixels);
    return pixels;
  } catch {
    return null;
  }
}

/** 16x16 RGBA pixels as a base64 PNG (no data: prefix), as the server stores it. */
export function encodeIcon(pixels: IconPixels): string {
  const canvas = document.createElement("canvas");
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), ICON_SIZE, ICON_SIZE), 0, 0);
  return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}

/** Put a bundle's palettes and icons in force. An icon that fails to decode falls back to the code-drawn one. */
export async function applyArt(bundle: ContentBundle): Promise<void> {
  setLookOverrides(bundle.palettes);
  const icons: Record<string, IconPixels> = {};
  await Promise.all(
    Object.entries(bundle.icons).map(async ([name, { png }]) => {
      const pixels = await decodeIcon(png);
      if (pixels) icons[name] = pixels;
    }),
  );
  setIconOverrides(icons);
}
