// Finding, fetching and decoding audio files.
//
// The index lists every file and where each encoding of it is served. What
// ships is apps/game/public/audio/index.json, written by `pnpm audio:build`.
// While developing, the dev server also lists the WAV masters in
// apps/game/audio as they are, and those win, so a bounce is heard on the next
// play without encoding anything.
//
// Decoded audio is raw 32-bit float whatever it was stored as, so it is held
// within a memory budget: past it, the buffers used longest ago are let go
// (never one a playing loop holds) and decoded again if they are wanted.

import type { AudioFile, AudioIndex } from "./types";

const EMPTY: AudioIndex = { version: 1, files: {} };
export const SHIPPED_INDEX = "/audio/index.json";
export const DEV_INDEX = "/__audio/index.json";

async function fetchIndex(url: string): Promise<AudioIndex> {
  try {
    const res = await fetch(url, { cache: "no-cache" });
    // A missing file is answered with the app's page (it is a single-page app), so insist on JSON.
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return EMPTY;
    const data = (await res.json()) as AudioIndex;
    return data && data.version === 1 && data.files && typeof data.files === "object" ? data : EMPTY;
  } catch {
    return EMPTY;
  }
}

/** Ogg Opus where the browser says it can (Safari only since 18.4), AAC otherwise. A failed decode switches for good. */
function guessFormat(): "opus" | "aac" {
  try {
    return document.createElement("audio").canPlayType('audio/ogg; codecs="opus"') ? "opus" : "aac";
  } catch {
    return "aac";
  }
}

interface Cached {
  key: string;
  promise: Promise<AudioBuffer | null>;
  buffer: AudioBuffer | null;
  bytes: number;
  used: number;
}

export class Library {
  private index: AudioIndex = EMPTY;
  private sortedKeys: string[] = [];
  private format = guessFormat();
  private cache = new Map<string, Cached>();
  private pins = new Map<string, number>();
  private bytes = 0;
  private tick = 0;

  constructor(private ctx: BaseAudioContext, private budget: number) {}

  /** Fetch the index again: the shipped one, and while developing the masters on top of it. */
  async loadIndex(): Promise<void> {
    const shipped = await fetchIndex(SHIPPED_INDEX);
    const files: Record<string, AudioFile> = { ...shipped.files };
    if (import.meta.env.DEV) Object.assign(files, (await fetchIndex(DEV_INDEX)).files);
    this.index = { version: 1, files };
    this.sortedKeys = Object.keys(files).sort();
  }

  keys(): string[] {
    return this.sortedKeys;
  }

  file(key: string): AudioFile | undefined {
    return this.index.files[key];
  }

  /** The URL a file is fetched from: a master while developing, else the encoding this browser decodes. */
  url(key: string): string | null {
    const urls = this.index.files[key]?.urls;
    if (!urls) return null;
    return urls.wav ?? urls[this.format] ?? urls.opus ?? urls.aac ?? null;
  }

  /** The decoded buffer if it is already in memory, without waiting. */
  ready(key: string): AudioBuffer | null {
    const url = this.url(key);
    const hit = url ? this.cache.get(url) : undefined;
    if (!hit?.buffer) return null;
    hit.used = ++this.tick;
    return hit.buffer;
  }

  /** Fetch and decode a file (once; later calls share it). Null if it is missing or will not decode. */
  load(key: string): Promise<AudioBuffer | null> {
    const url = this.url(key);
    if (!url) return Promise.resolve(null);
    const hit = this.cache.get(url);
    if (hit) {
      hit.used = ++this.tick;
      return hit.promise;
    }
    const entry: Cached = { key, promise: Promise.resolve(null), buffer: null, bytes: 0, used: ++this.tick };
    entry.promise = this.decode(url).then(
      (buffer) => {
        entry.buffer = buffer;
        entry.bytes = buffer.length * buffer.numberOfChannels * 4;
        this.bytes += entry.bytes;
        this.trim();
        return buffer;
      },
      (err: unknown) => {
        this.cache.delete(url);
        // Opus refused: this browser cannot decode it after all, so use AAC from now on.
        const aac = this.index.files[key]?.urls.aac;
        if (this.format === "opus" && url === this.index.files[key]?.urls.opus && aac) {
          this.format = "aac";
          if (import.meta.env.DEV) console.info("[audio] this browser will not decode Opus; using AAC");
          return this.load(key);
        }
        if (import.meta.env.DEV) console.warn(`[audio] could not load ${key} (${url})`, err);
        return null;
      },
    );
    this.cache.set(url, entry);
    return entry.promise;
  }

  /** Keep a file in memory while something (a playing loop) holds it. */
  pin(key: string) {
    this.pins.set(key, (this.pins.get(key) ?? 0) + 1);
  }

  unpin(key: string) {
    const n = (this.pins.get(key) ?? 0) - 1;
    if (n > 0) this.pins.set(key, n);
    else this.pins.delete(key);
    this.trim();
  }

  stats() {
    return { format: this.format, files: this.sortedKeys.length, decoded: this.cache.size, megabytes: Math.round(this.bytes / 1e5) / 10, budget: this.budget / 1e6 };
  }

  private async decode(url: string): Promise<AudioBuffer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.arrayBuffer();
    return await this.ctx.decodeAudioData(data);
  }

  /** Let go of the buffers used longest ago until the decoded audio fits the budget. */
  private trim() {
    if (this.bytes <= this.budget) return;
    const idle = [...this.cache.entries()].filter(([, c]) => c.buffer && !this.pins.has(c.key)).sort((a, b) => a[1].used - b[1].used);
    for (const [url, c] of idle) {
      if (this.bytes <= this.budget) break;
      this.cache.delete(url);
      this.bytes -= c.bytes;
    }
  }
}
