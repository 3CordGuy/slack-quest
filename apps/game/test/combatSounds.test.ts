import { describe, expect, it } from "vitest";
import { ABILITIES, ENEMIES } from "@gantt-quest/world";
import { blowKind, effectSound, hitSound, launchSound, missSound } from "../src/client/render/combatSounds";

describe("combat sounds", () => {
  it("sorts blows by how they are struck", () => {
    expect(blowKind("Cleave")).toBe("blade");
    expect(blowKind("Smite")).toBe("blunt");
    expect(blowKind("Maul")).toBe("blunt");
    expect(blowKind("Bite")).toBe("blade");
    expect(blowKind("Aimed Shot")).toBe("arrow");
    expect(blowKind("Volley")).toBe("arrow");
    expect(blowKind("Firebolt")).toBe("spell");
    expect(blowKind("Dark Bolt")).toBe("spell");
    expect(blowKind("Something New")).toBe("blunt");
  });

  it("gives every spell-stat ability a spell's sound", () => {
    for (const a of Object.values(ABILITIES)) if (a.stat === "int_stat") expect(blowKind(a.name)).toBe("spell");
  });

  it("gives every enemy attack a sound", () => {
    for (const e of Object.values(ENEMIES)) for (const a of e.attacks) expect(["blade", "blunt", "arrow", "spell"]).toContain(blowKind(a.name));
  });

  it("flies arrows and spells, not hand blows", () => {
    expect(launchSound("arrow")).toBe("arrow_loose");
    expect(launchSound("spell")).toBe("spell_cast");
    expect(launchSound("blade")).toBeNull();
    expect(hitSound("arrow")).toBe("arrow_hit");
    expect(missSound("spell")).toBe("fizzle");
    expect(missSound("blunt")).toBe("whiff");
  });

  it("has a tell for every effect", () => {
    expect(effectSound("bleeding")).toBe("bleed");
    expect(effectSound("burning")).toBe("burn");
    expect(effectSound("stunned")).toBe("stun");
    expect(effectSound("guarded")).toBe("buff");
    expect(effectSound("slowed")).toBe("debuff");
  });
});
