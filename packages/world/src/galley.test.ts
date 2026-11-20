// The galley: its place among the projects.

import { describe, expect, it } from "vitest";
import { GALLEY_PROJECT, projectById } from "./index";

describe("the galley project", () => {
  it("is open, with its catalogue cost", () => {
    expect(projectById(GALLEY_PROJECT)).toMatchObject({ open: true, cost: { gold: 250, wood: 30, fur: 15, bone: 10 } });
  });
});
