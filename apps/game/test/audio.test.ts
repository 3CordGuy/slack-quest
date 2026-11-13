// The audio engine's pure parts, and the manifest checked against what the
// game can actually ask for, so a misspelt event or scene is caught here.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIO } from "../src/client/audio/manifest";
import { MixStore, faderDb, faderGain, parseSettings } from "../src/client/audio/mixer";
import { soundName, soundNames } from "../src/client/audio/names";
import { TakePicker, curveAt, distanceGain, expandFiles, resolveName, slug, untilNextLine } from "../src/client/audio/select";
import { readWav } from "../scripts/audio/wav";

describe("the manifest", () => {
  const known = soundNames();
  it("only names events the game asks for", () => {
    const unknown = Object.keys(AUDIO.events).filter((n) => !known.has(n));
    expect(unknown).toEqual([]);
  });
  it("points every scene at music and ambience that exist", () => {
    for (const [name, scene] of Object.entries(AUDIO.scenes)) {
      if (scene.music) expect(AUDIO.music[scene.music], `${name} music`).toBeDefined();
      for (const a of scene.ambience ?? []) expect(AUDIO.ambience[a], `${name} ambience ${a}`).toBeDefined();
    }
  });
  it("gives every curve rising points and levels between 0 and 1", () => {
    const loops = [...Object.entries(AUDIO.music), ...Object.entries(AUDIO.ambience)];
    for (const [name, loop] of loops) {
      for (const f of [loop.follow, ...(loop.layers ?? []).map((l) => l.follow)]) {
        if (!f) continue;
        expect(f.curve.length, name).toBeGreaterThan(0);
        f.curve.forEach(([x, y], i) => {
          if (i > 0) expect(x, name).toBeGreaterThanOrEqual(f.curve[i - 1][0]);
          expect(y, name).toBeGreaterThanOrEqual(0);
          expect(y, name).toBeLessThanOrEqual(1);
        });
      }
    }
  });
  it("follows curves in straight lines, flat past the ends", () => {
    const curve: [number, number][] = [[0.3, 0], [0.8, 1]];
    expect(curveAt(curve, 0)).toBe(0);
    expect(curveAt(curve, 0.55)).toBeCloseTo(0.5);
    expect(curveAt(curve, 1)).toBe(1);
  });
  it("finds the next bar line, through the loop point", () => {
    const region = { start: 0, end: 8 };
    expect(untilNextLine(1, 0, region, 0, 2)).toBeCloseTo(1);
    // 9s in, an 8s loop has gone round: 1s into it again.
    expect(untilNextLine(9, 0, region, 0, 2)).toBeCloseTo(1);
    // Bars counted from a loop start one second into the file.
    expect(untilNextLine(0.5, 1, { start: 1, end: 9 }, 1, 2)).toBeCloseTo(1.5);
    // Right on the line: take the next one.
    expect(untilNextLine(2, 0, region, 0, 2)).toBeCloseTo(2);
  });
  it("keeps slider defaults between 0 and 1", () => {
    for (const d of Object.values(AUDIO.mix)) {
      expect(d.volume).toBeGreaterThanOrEqual(0);
      expect(d.volume).toBeLessThanOrEqual(1);
    }
  });
});

describe("sound names", () => {
  it("fall back from the ability to its style to the general sound", () => {
    expect(soundName.impact("Aimed Shot", "ranged")).toEqual(["impact.aimed_shot", "impact.ranged", "impact"]);
    expect(soundName.down({ side: "enemy", kind: "wolf" })).toEqual(["enemy.wolf.down", "enemy.down", "down"]);
  });
  it("sound rewards only for the hero they belong to", () => {
    expect(soundName.world({ t: "gold", heroId: "a", amount: 5 }, "a")).toEqual(["gold"]);
    expect(soundName.world({ t: "gold", heroId: "b", amount: 5 }, "a")).toBeNull();
  });
  it("play the first name that has files", () => {
    expect(resolveName(["impact.firebolt", "impact.magic", "impact"], (n) => n === "impact.magic" || n === "impact")).toBe("impact.magic");
    expect(resolveName(["a", "b"], () => false)).toBeNull();
  });
  it("slug display names", () => {
    expect(slug("Chain Spark")).toBe("chain_spark");
    expect(slug("Ship's Bell!")).toBe("ship_s_bell");
  });
});

describe("file patterns", () => {
  const keys = ["sfx/footsteps/stone_01", "sfx/footsteps/stone_02", "sfx/footsteps/stone/deep", "sfx/footsteps/wood_01", "sfx/ui/loot"];
  it("match takes within one folder", () => {
    expect(expandFiles("sfx/footsteps/stone_*", keys)).toEqual(["sfx/footsteps/stone_01", "sfx/footsteps/stone_02"]);
  });
  it("take exact names, and skip ones that are missing", () => {
    expect(expandFiles(["sfx/ui/loot", "sfx/ui/gone", "sfx/ui/loot"], keys)).toEqual(["sfx/ui/loot"]);
  });
});

describe("picking takes", () => {
  it("never repeats a take when picking at random", () => {
    const p = new TakePicker();
    let last = -1;
    for (let i = 0; i < 200; i++) {
      const n = p.next(3);
      expect(n).not.toBe(last);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(3);
      last = n;
    }
  });
  it("plays every take once per round when shuffling, with no repeat across rounds", () => {
    const p = new TakePicker();
    let last = -1;
    for (let round = 0; round < 20; round++) {
      const seen = new Set<number>();
      for (let i = 0; i < 4; i++) {
        const n = p.next(4, "shuffle");
        expect(n).not.toBe(last);
        seen.add((last = n));
      }
      expect(seen.size).toBe(4);
    }
  });
  it("goes in order for a sequence", () => {
    const p = new TakePicker();
    expect([p.next(3, "sequence"), p.next(3, "sequence"), p.next(3, "sequence"), p.next(3, "sequence")]).toEqual([0, 1, 2, 0]);
  });
});

describe("the mix", () => {
  it("maps the slider to dB", () => {
    expect(faderDb(1)).toBeCloseTo(0);
    expect(faderDb(0.5)).toBe(-20);
    expect(faderGain(0)).toBe(0);
    expect(faderGain(0.5)).toBeCloseTo(0.1);
  });
  it("saves only the sliders a player moved, so the rest follow new defaults", () => {
    const saved = new Map<string, string>();
    const storage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
    const defaults = structuredClone(AUDIO.mix);
    const mix = new MixStore(defaults, storage);
    expect(mix.volume("music")).toBe(defaults.music.volume);
    mix.setVolume("music", 0.25);
    const again = new MixStore({ ...defaults, sfx: { volume: 0.33, trimDb: 0 } }, storage);
    expect(again.volume("music")).toBe(0.25);
    expect(again.volume("sfx")).toBe(0.33);
    again.reset();
    expect(saved.size).toBe(0);
    expect(again.volume("music")).toBe(defaults.music.volume);
  });
  it("ignores malformed saved settings", () => {
    expect(parseSettings("not json")).toEqual({ volumes: {}, muted: false });
    expect(parseSettings('{"volumes":{"music":7,"sfx":"x"},"muted":true}')).toEqual({ volumes: { music: 1 }, muted: true });
  });
  it("fades sounds with distance", () => {
    expect(distanceGain(0)).toBe(1);
    expect(distanceGain(8)).toBeCloseTo(0.5);
    expect(distanceGain(40)).toBe(0);
  });
});

describe("reading masters", () => {
  it("reads length and embedded loop markers", () => {
    const frames = 48000;
    const fmt = Buffer.alloc(24);
    fmt.write("fmt ", 0, "latin1");
    fmt.writeUInt32LE(16, 4);
    fmt.writeUInt16LE(1, 8);
    fmt.writeUInt16LE(2, 10);
    fmt.writeUInt32LE(48000, 12);
    fmt.writeUInt32LE(48000 * 4, 16);
    fmt.writeUInt16LE(4, 20);
    fmt.writeUInt16LE(16, 22);
    const data = Buffer.alloc(8 + frames * 4);
    data.write("data", 0, "latin1");
    data.writeUInt32LE(frames * 4, 4);
    const smpl = Buffer.alloc(8 + 60);
    smpl.write("smpl", 0, "latin1");
    smpl.writeUInt32LE(60, 4);
    smpl.writeUInt32LE(1, 8 + 28);
    smpl.writeUInt32LE(12000, 8 + 36 + 8);
    smpl.writeUInt32LE(35999, 8 + 36 + 12);
    const head = Buffer.alloc(12);
    head.write("RIFF", 0, "latin1");
    head.writeUInt32LE(4 + fmt.length + data.length + smpl.length, 4);
    head.write("WAVE", 8, "latin1");
    const path = join(mkdtempSync(join(tmpdir(), "gq-audio-")), "loop.wav");
    writeFileSync(path, Buffer.concat([head, fmt, data, smpl]));
    expect(readWav(path)).toEqual({ sampleRate: 48000, channels: 2, duration: 1, loop: { start: 0.25, end: 0.75 }, placeholder: false });
  });
});
