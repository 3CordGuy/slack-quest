import { describe, expect, it } from "vitest";
import { hexToWorld } from "../src/client/render/WorldRenderer";
import { HOP_RATE, footfalls, stepGround, stepVolume, worldToHex } from "../src/client/render/footsteps";

describe("footsteps", () => {
  it("lands twice per hex walked", () => {
    // A hex is √3 across; walking one in small frames should land exactly twice.
    const hex = Math.sqrt(3);
    let stride = 0;
    let landed = 0;
    while (stride < hex * 3) {
      const step = 4.2 / 60;
      landed += footfalls(stride, stride + step);
      stride += step;
    }
    expect(landed).toBe(Math.floor((stride * HOP_RATE) / Math.PI));
    expect(landed).toBeGreaterThanOrEqual(5);
    expect(landed).toBeLessThanOrEqual(7);
  });

  it("does not land when standing still", () => {
    expect(footfalls(0.4, 0.4)).toBe(0);
  });

  it("finds the hex under a point", () => {
    for (const p of [{ q: 0, r: 0 }, { q: 3, r: 2 }, { q: -2, r: 5 }, { q: 7, r: 9 }]) {
      const w = hexToWorld(p);
      expect(worldToHex(w.x + 0.3, w.z - 0.4)).toEqual(p);
    }
  });

  it("hears each ground", () => {
    expect(stepGround("plains")).toBe("grass");
    expect(stepGround("cobble")).toBe("stone");
    expect(stepGround("dock")).toBe("wood");
    expect(stepGround("floor")).toBe("floor");
    expect(stepGround("mud")).toBe("mud");
    expect(stepGround("fog")).toBeNull();
  });

  it("keeps other heroes softer and fades them with distance", () => {
    expect(stepVolume(true, 20)).toBe(1);
    expect(stepVolume(false, 0)).toBeLessThan(1);
    expect(stepVolume(false, 6)).toBeLessThan(stepVolume(false, 2));
    expect(stepVolume(false, 20)).toBe(0);
  });
});
