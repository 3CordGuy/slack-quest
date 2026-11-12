// The stock look of every humanoid sprite: palette, headgear and weapon per
// hero class, NPC or enemy kind. Pure data with no three.js or DOM, so the
// Worker can import it to validate admin palette overrides.

export const HATS = ["helm", "wizard", "hood", "horns", "leaves", "feather", "circlet", "none"] as const;
export type Hat = (typeof HATS)[number];
export const LOOK_WEAPONS = ["sword", "staff", "daggers", "club", "bow", "lute", "orb", "none"] as const;
export type Weapon = (typeof LOOK_WEAPONS)[number];

export interface Look {
  skin: string;
  hair: string;
  body: string;
  legs: string;
  accent: string;
  hat: Hat;
  weapon: Weapon;
}

export const LOOKS: Record<string, Look> = {
  qa_paladin: { skin: "#f1c9a5", hair: "#8a5a2b", body: "#c9ced6", legs: "#5b6475", accent: "#e0b12e", hat: "helm", weapon: "sword" },
  devops_mage: { skin: "#f1c9a5", hair: "#e8e8f0", body: "#4b5fd1", legs: "#2d357a", accent: "#7fe3ff", hat: "wizard", weapon: "staff" },
  refactor_rogue: { skin: "#d9a67c", hair: "#2b2b33", body: "#3d7a4f", legs: "#2f3b33", accent: "#b9433d", hat: "hood", weapon: "daggers" },
  backend_druid: { skin: "#d9a67c", hair: "#5a3d22", body: "#5d7d3a", legs: "#4a3a26", accent: "#a6d06a", hat: "leaves", weapon: "staff" },
  frontend_bard: { skin: "#f1c9a5", hair: "#c9743a", body: "#b9433d", legs: "#3b2f5a", accent: "#e0b12e", hat: "feather", weapon: "lute" },
  staff_sage: { skin: "#e8c2a0", hair: "#d9d9e3", body: "#6a3fa0", legs: "#3a2560", accent: "#f2d675", hat: "circlet", weapon: "orb" },
  npc: { skin: "#e8b891", hair: "#b9b9b9", body: "#a0683a", legs: "#5a4632", accent: "#e8dcc0", hat: "none", weapon: "none" },
  bandit: { skin: "#d9a67c", hair: "#3a2a20", body: "#7a2f2f", legs: "#3a3030", accent: "#1f1f1f", hat: "hood", weapon: "club" },
  cultist: { skin: "#cdb7d6", hair: "#2a1838", body: "#5b2a7a", legs: "#34194a", accent: "#e04fd0", hat: "hood", weapon: "staff" },
  brute: { skin: "#c9a27c", hair: "#2a1c14", body: "#5a4632", legs: "#3a2e22", accent: "#b9433d", hat: "none", weapon: "club" },
  archer: { skin: "#d9a67c", hair: "#3a2a20", body: "#4f6b3a", legs: "#33402a", accent: "#e8dcc0", hat: "hood", weapon: "bow" },
  guardian: { skin: "#9aa4b2", hair: "#7b8494", body: "#6b7280", legs: "#4b5563", accent: "#7fe3ff", hat: "none", weapon: "none" },
  villain: { skin: "#b8c7b0", hair: "#101010", body: "#2a2a35", legs: "#15151c", accent: "#e23b3b", hat: "horns", weapon: "sword" },
};

/** The colour fields of a look, which an admin palette override may change. */
export const LOOK_COLORS = ["skin", "hair", "body", "legs", "accent"] as const;
