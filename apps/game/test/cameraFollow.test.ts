import { afterEach, describe, expect, it, vi } from "vitest";
import { FOLLOW_ICON, readFollow, writeFollow } from "../src/client/render/cameraFollow";

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe("camera follow setting", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is on until turned off, and remembers either way", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(readFollow()).toBe(true);
    writeFollow(false);
    expect(readFollow()).toBe(false);
    writeFollow(true);
    expect(readFollow()).toBe(true);
  });

  it("stays on, without throwing, when storage is blocked", () => {
    const blocked = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked, removeItem: blocked });
    expect(readFollow()).toBe(true);
    expect(() => writeFollow(false)).not.toThrow();
  });

  it("has a square icon", () => {
    expect(FOLLOW_ICON.every((row) => row.length === FOLLOW_ICON.length)).toBe(true);
  });
});
