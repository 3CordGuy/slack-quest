// Encode the WAV masters in apps/game/audio into what ships:
// apps/game/public/audio/<key>.<hash>.ogg (Opus) and .m4a (AAC), and the
// index.json that lists them. Run with `pnpm audio:build`; needs ffmpeg.
//
// A file is encoded again only when the master or its settings change (the
// hash in its name covers both), and encodings no master asks for any more
// are removed. Placeholder files are skipped: they are for developing only.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AudioIndex } from "../../src/client/audio/types.ts";
import { describe, listWavs, readWav } from "./wav.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "../../audio");
const OUT = resolve(here, "../../public/audio");

/** Bitrates in kbps, by the top folder of a file and whether it is stereo. AAC needs a little more than Opus. */
const RATES: Record<string, { opus: [mono: number, stereo: number]; aac: [mono: number, stereo: number] }> = {
  music: { opus: [64, 112], aac: [96, 160] },
  ambience: { opus: [56, 80], aac: [80, 128] },
  sfx: { opus: [56, 80], aac: [72, 112] },
  // Impulse responses: short, and every sound with reverb passes through them, so they get the most.
  ir: { opus: [96, 160], aac: [128, 192] },
};
const DEFAULT_RATES = RATES.sfx;
/** Bump to encode everything again after changing how files are encoded. */
const ENCODER_VERSION = 1;

function ffmpeg(args: string[]): boolean {
  const res = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });
  return res.status === 0;
}

if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0) {
  console.error("ffmpeg was not found. Install it (https://ffmpeg.org/download.html) and make sure it is on your PATH.");
  process.exit(1);
}

const index: AudioIndex = { version: 1, files: {} };
const keep = new Set<string>(["index.json"]);
let encoded = 0;
let skipped = 0;
let failed = 0;

for (const [key, file] of listWavs(SRC)) {
  const info = readWav(file);
  if (!info) {
    console.warn(`skipped ${key}: not a WAV this can read`);
    failed++;
    continue;
  }
  if (info.placeholder) {
    skipped++;
    continue;
  }
  const rates = RATES[key.split("/")[0]] ?? DEFAULT_RATES;
  const stereo = info.channels >= 2 ? 1 : 0;
  const kbps = { opus: rates.opus[stereo], aac: rates.aac[stereo] };
  const hash = createHash("sha256").update(readFileSync(file)).update(JSON.stringify([ENCODER_VERSION, kbps])).digest("hex").slice(0, 10);
  const outs = { opus: `${key}.${hash}.ogg`, aac: `${key}.${hash}.m4a` };
  mkdirSync(dirname(join(OUT, outs.opus)), { recursive: true });
  let ok = true;
  if (!existsSync(join(OUT, outs.opus))) {
    ok &&= ffmpeg(["-i", file, "-c:a", "libopus", "-b:a", `${kbps.opus}k`, "-vbr", "on", "-ar", "48000", join(OUT, outs.opus)]);
    encoded++;
  }
  if (ok && !existsSync(join(OUT, outs.aac))) {
    ok &&= ffmpeg(["-i", file, "-c:a", "aac", "-b:a", `${kbps.aac}k`, "-movflags", "+faststart", join(OUT, outs.aac)]);
  }
  if (!ok) {
    console.warn(`failed to encode ${key}`);
    failed++;
    continue;
  }
  keep.add(outs.opus);
  keep.add(outs.aac);
  index.files[key] = { urls: { opus: `/audio/${outs.opus}`, aac: `/audio/${outs.aac}` }, ...describe(info) };
}

// Remove encodings that no master asks for any more.
let removed = 0;
const prune = (dir: string) => {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      prune(p);
      if (readdirSync(p).length === 0) rmSync(p, { recursive: true });
    } else if (/\.(ogg|m4a)$/.test(name) && !keep.has(relative(OUT, p).split(sep).join("/"))) {
      rmSync(p);
      removed++;
    }
  }
};
prune(OUT);

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "index.json"), JSON.stringify(index, null, 1) + "\n");
const total = Object.keys(index.files).length;
console.log(`${total} file${total === 1 ? "" : "s"} in the index: ${encoded} encoded, ${removed} old encoding${removed === 1 ? "" : "s"} removed${skipped ? `, ${skipped} placeholder${skipped === 1 ? "" : "s"} left out` : ""}${failed ? `, ${failed} failed` : ""}.`);
if (failed) process.exit(1);
