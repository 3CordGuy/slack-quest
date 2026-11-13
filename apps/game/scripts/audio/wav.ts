// Reading WAV masters: their length, and the loop markers a DAW embeds in the
// "smpl" chunk. Used by the dev server (to list apps/game/audio as it is) and
// by the build (to write the shipped index).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { AudioFile } from "../../src/client/audio/types.ts";

/** Written into the files the placeholder script makes, so they are never mistaken for yours. */
export const PLACEHOLDER_TAG = "gq-placeholder";

export interface WavInfo {
  sampleRate: number;
  channels: number;
  duration: number;
  loop?: { start: number; end: number };
  placeholder: boolean;
}

/** Null if the file is not a WAV this can read. */
export function readWav(path: string): WavInfo | null {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    return null;
  }
  if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WAVE") return null;
  let sampleRate = 0;
  let channels = 0;
  let blockAlign = 0;
  let dataBytes = 0;
  let loop: { start: number; end: number } | undefined;
  let placeholder = false;
  for (let at = 12; at + 8 <= buf.length; ) {
    const id = buf.toString("latin1", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt " && size >= 16) {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      blockAlign = buf.readUInt16LE(body + 12);
    } else if (id === "data") {
      dataBytes = Math.min(size, buf.length - body);
    } else if (id === "smpl" && size >= 60 && buf.readUInt32LE(body + 28) > 0) {
      // The first loop: start and end in sample frames, the end inclusive.
      loop = { start: buf.readUInt32LE(body + 36 + 8), end: buf.readUInt32LE(body + 36 + 12) + 1 };
    } else if (id === "LIST") {
      placeholder ||= buf.toString("latin1", body, Math.min(buf.length, body + size)).includes(PLACEHOLDER_TAG);
    }
    at = body + size + (size % 2);
  }
  if (!sampleRate || !blockAlign || !channels) return null;
  const frames = dataBytes / blockAlign;
  const info: WavInfo = { sampleRate, channels, duration: frames / sampleRate, placeholder };
  if (loop && loop.end > loop.start && loop.end <= frames) info.loop = { start: loop.start / sampleRate, end: loop.end / sampleRate };
  return info;
}

/** Every .wav under `dir`, as [key, path]: the key is its path without the extension, with forward slashes. */
export function listWavs(dir: string): [key: string, path: string][] {
  const out: [string, string][] = [];
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.wav$/i.test(name)) out.push([relative(dir, p).slice(0, -4).split(sep).join("/"), p]);
    }
  };
  walk(dir);
  return out;
}

/** An index entry for a master, without its URLs. */
export function describe(info: WavInfo): Omit<AudioFile, "urls"> {
  return {
    duration: Math.round(info.duration * 1e4) / 1e4,
    sampleRate: info.sampleRate,
    channels: info.channels,
    ...(info.loop ? { loop: info.loop } : {}),
    ...(info.placeholder ? { placeholder: true } : {}),
  };
}
