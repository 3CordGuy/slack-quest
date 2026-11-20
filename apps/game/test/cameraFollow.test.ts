import { afterEach, describe, expect, it, vi } from "vitest";
import { readFollow, writeFollow } from "../src/client/render/cameraFollow";
import { memoryStorage } from "./browser";

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
});
