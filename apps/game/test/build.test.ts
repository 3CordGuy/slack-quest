import { describe, expect, it } from "vitest";
import { BUILD_ID, isStale } from "../src/build";

describe("build id", () => {
  it("is 'dev' where no build stamped one (the tests, the dev server)", () => {
    expect(BUILD_ID).toBe("dev");
  });

  it("is stale only when the server names a different build", () => {
    expect(isStale("abc-1", "abc-2")).toBe(true);
    expect(isStale("abc-1", "abc-1")).toBe(false);
  });

  it("is not stale when the server cannot say: offline, or a server from before the route", () => {
    expect(isStale("abc-1", null)).toBe(false);
    expect(isStale("abc-1", undefined)).toBe(false);
    expect(isStale("abc-1", "")).toBe(false);
    expect(isStale("abc-1", { error: "not signed in" })).toBe(false);
  });
});
