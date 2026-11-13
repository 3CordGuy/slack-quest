// The player's side of the mix: a slider per group plus a master, a mute, and
// whether placed sounds are rendered for headphones.
//
// Each group has two gain stages. Your trim (manifest.mix[group].trimDb) sets
// the balance and players never see it; their slider sits after it. Only the
// sliders a player has actually moved are saved, so a slider they never
// touched follows whatever default you ship next.

import type { Fader, FaderDefault } from "./types";

export const FADERS: Fader[] = ["master", "music", "atmosphere", "sfx"];

export const FADER_LABELS: Record<Fader, string> = {
  master: "Master",
  music: "Music",
  atmosphere: "Atmosphere",
  sfx: "Sound effects",
};

/** The slider is linear in dB: full is 0 dB, the lowest step above silence is −FADER_RANGE_DB. */
export const FADER_RANGE_DB = 40;

/** A slider position (0–1) in dB. Zero is silence. */
export function faderDb(pos: number): number {
  if (!(pos > 0)) return -Infinity;
  return -FADER_RANGE_DB * (1 - Math.min(1, pos));
}

export function dbToGain(db: number): number {
  return db === -Infinity ? 0 : 10 ** (db / 20);
}

export const faderGain = (pos: number) => dbToGain(faderDb(pos));

export interface MixSettings {
  /** Only the sliders the player has moved. */
  volumes: Partial<Record<Fader, number>>;
  muted: boolean;
  /** Place sounds around the head for headphones (HRTF) rather than panning them between two speakers. */
  headphones: boolean;
}

const KEY = "gq.audio.v1";

function clamp01(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : undefined;
}

/** Read saved settings, dropping anything malformed. */
export function parseSettings(raw: string | null): MixSettings {
  const out: MixSettings = { volumes: {}, muted: false, headphones: false };
  if (!raw) return out;
  try {
    const data = JSON.parse(raw) as { volumes?: Record<string, unknown>; muted?: unknown; headphones?: unknown };
    for (const f of FADERS) {
      const v = clamp01(data.volumes?.[f]);
      if (v !== undefined) out.volumes[f] = v;
    }
    out.muted = data.muted === true;
    out.headphones = data.headphones === true;
  } catch {
    /* unreadable: start from the defaults */
  }
  return out;
}

/** The player's sound settings, saved per device. React reads it with useSyncExternalStore. */
export class MixStore {
  private settings: MixSettings;
  private listeners = new Set<() => void>();

  constructor(
    readonly defaults: Record<Fader, FaderDefault>,
    private storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null,
  ) {
    let raw: string | null = null;
    try {
      raw = storage?.getItem(KEY) ?? null;
    } catch {
      /* storage blocked */
    }
    this.settings = parseSettings(raw);
  }

  /** The current settings. A new object after every change, so it can be compared by identity. */
  get = (): MixSettings => this.settings;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Where a slider stands: the player's own setting, or your default. */
  volume(f: Fader): number {
    return this.settings.volumes[f] ?? this.defaults[f].volume;
  }

  setVolume(f: Fader, v: number) {
    this.update({ ...this.settings, volumes: { ...this.settings.volumes, [f]: clamp01(v) ?? 0 } });
  }

  setMuted(muted: boolean) {
    this.update({ ...this.settings, muted });
  }

  setHeadphones(headphones: boolean) {
    this.update({ ...this.settings, headphones });
  }

  /** Whether the player has changed anything from what the game ships with. */
  get changed(): boolean {
    return this.settings.muted || this.settings.headphones || Object.keys(this.settings.volumes).length > 0;
  }

  /** Forget everything the player set: every slider back to your defaults. */
  reset() {
    this.update({ volumes: {}, muted: false, headphones: false });
  }

  private update(next: MixSettings) {
    this.settings = next;
    try {
      if (!this.changed) this.storage?.removeItem(KEY);
      else this.storage?.setItem(KEY, JSON.stringify(next));
    } catch {
      /* storage full or blocked: the setting still holds for this visit */
    }
    for (const fn of this.listeners) fn();
  }
}
