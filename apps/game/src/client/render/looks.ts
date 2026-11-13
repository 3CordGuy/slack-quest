// The stock look of every humanoid sprite: palette, headgear and weapon per
// hero class, NPC or enemy kind. Pure data with no three.js or DOM, so the
// Worker can import it to validate admin palette overrides.

export const HATS = ["helm", "wizard", "hood", "horns", "leaves", "feather", "circlet", "brim", "turban", "kerchief", "greathelm", "none"] as const;
export type Hat = (typeof HATS)[number];
export const LOOK_WEAPONS = ["sword", "staff", "daggers", "club", "bow", "lute", "orb", "lantern", "scroll", "pack", "basket", "axe_shield", "grimoire", "none"] as const;
export type Weapon = (typeof LOOK_WEAPONS)[number];

export interface Look {
  skin: string;
  hair: string;
  body: string;
  legs: string;
  accent: string;
  hat: Hat;
  weapon: Weapon;
  /** Colour of the hat, where it is not the body's. */
  hatColor?: string;
  /** A full-length coat over the legs, for travellers. */
  coat?: boolean;
}

export const LOOKS: Record<string, Look> = {
  qa_paladin: { skin: "#f1c9a5", hair: "#8a5a2b", body: "#c9ced6", legs: "#5b6475", accent: "#e0b12e", hat: "helm", weapon: "sword" },
  devops_mage: { skin: "#f1c9a5", hair: "#e8e8f0", body: "#4b5fd1", legs: "#2d357a", accent: "#7fe3ff", hat: "wizard", weapon: "staff" },
  refactor_rogue: { skin: "#d9a67c", hair: "#2b2b33", body: "#3d7a4f", legs: "#2f3b33", accent: "#b9433d", hat: "hood", weapon: "daggers" },
  backend_druid: { skin: "#d9a67c", hair: "#5a3d22", body: "#5d7d3a", legs: "#4a3a26", accent: "#a6d06a", hat: "leaves", weapon: "staff" },
  frontend_bard: { skin: "#f1c9a5", hair: "#c9743a", body: "#b9433d", legs: "#3b2f5a", accent: "#e0b12e", hat: "feather", weapon: "lute" },
  staff_sage: { skin: "#e8c2a0", hair: "#d9d9e3", body: "#6a3fa0", legs: "#3a2560", accent: "#f2d675", hat: "circlet", weapon: "orb" },
  sre_warden: { skin: "#d9a67c", hair: "#3a2a20", body: "#5b6475", legs: "#3a404c", accent: "#e8742e", hat: "greathelm", hatColor: "#8b95a5", weapon: "axe_shield" },
  data_warlock: { skin: "#c9b8c4", hair: "#1a1424", body: "#241b33", legs: "#15101f", accent: "#6dff9e", hat: "hood", hatColor: "#4a2f6b", weapon: "grimoire" },
  // Traveling salesmen (packages/world/src/salesman.ts): each one easy to tell from the crew at a glance.
  salesman_curio: { skin: "#f1d3b8", hair: "#1f1a24", body: "#5b2f63", legs: "#2a1838", accent: "#e0b12e", hat: "brim", hatColor: "#2a1f2e", weapon: "lantern", coat: true },
  salesman_plans: { skin: "#d9a67c", hair: "#9a9aa2", body: "#2f5f73", legs: "#24323a", accent: "#e8dcc0", hat: "kerchief", hatColor: "#3f6fa8", weapon: "scroll" },
  salesman_far: { skin: "#b07a52", hair: "#2a1c14", body: "#c96a2a", legs: "#4a2f1e", accent: "#2f8c8a", hat: "turban", hatColor: "#f2e6c8", weapon: "pack", coat: true },
  salesman_herbs: { skin: "#e3c2a2", hair: "#ececec", body: "#5a6b3a", legs: "#3e4a2a", accent: "#a6d06a", hat: "hood", weapon: "basket" },
  // The pub's regulars (packages/world/src/regulars.ts): Harbor folk, plainer than the salesmen.
  regular_gretta: { skin: "#e8b891", hair: "#c9743a", body: "#2f8c8a", legs: "#3a404c", accent: "#e8dcc0", hat: "kerchief", hatColor: "#b9433d", weapon: "basket" },
  regular_pike: { skin: "#d9a67c", hair: "#d9d9e3", body: "#2d3a5a", legs: "#1f2433", accent: "#e0b12e", hat: "brim", hatColor: "#1f2433", weapon: "none", coat: true },
  regular_wen: { skin: "#c9a27c", hair: "#5a3d22", body: "#a0683a", legs: "#4a3a26", accent: "#e8dcc0", hat: "none", weapon: "club" },
  regular_moss: { skin: "#f1c9a5", hair: "#ececec", body: "#3f6fa8", legs: "#2d357a", accent: "#f2d675", hat: "hood", hatColor: "#5b6475", weapon: "lantern", coat: true },
  regular_dacey: { skin: "#b07a52", hair: "#1a1424", body: "#3a3030", legs: "#1f1f1f", accent: "#b9433d", hat: "hood", hatColor: "#2a2a35", weapon: "pack" },
  npc: { skin: "#e8b891", hair: "#b9b9b9", body: "#a0683a", legs: "#5a4632", accent: "#e8dcc0", hat: "none", weapon: "none" },
  bandit: { skin: "#d9a67c", hair: "#3a2a20", body: "#7a2f2f", legs: "#3a3030", accent: "#1f1f1f", hat: "hood", weapon: "club" },
  cultist: { skin: "#cdb7d6", hair: "#2a1838", body: "#5b2a7a", legs: "#34194a", accent: "#e04fd0", hat: "hood", weapon: "staff" },
  brute: { skin: "#c9a27c", hair: "#2a1c14", body: "#5a4632", legs: "#3a2e22", accent: "#b9433d", hat: "none", weapon: "club" },
  archer: { skin: "#d9a67c", hair: "#3a2a20", body: "#4f6b3a", legs: "#33402a", accent: "#e8dcc0", hat: "hood", weapon: "bow" },
  guardian: { skin: "#9aa4b2", hair: "#7b8494", body: "#6b7280", legs: "#4b5563", accent: "#7fe3ff", hat: "none", weapon: "none" },
  villain: { skin: "#b8c7b0", hair: "#101010", body: "#2a2a35", legs: "#15151c", accent: "#e23b3b", hat: "horns", weapon: "sword" },
};

/** The colour fields of a look, which an admin palette override may change. */
export const LOOK_COLORS = ["skin", "hair", "body", "legs", "accent", "hatColor"] as const;

/** The colour, hat and weapon changes an admin may make to a look. Every field is optional. */
export type LookPalette = Partial<Pick<Look, (typeof LOOK_COLORS)[number] | "hat" | "weapon">>;

/**
 * A stock look with an admin palette laid over it, field by field. Anything
 * the palette leaves out (or gets wrong) keeps the code default.
 */
export function mergeLook(base: Look, palette: Record<string, unknown> | undefined): Look {
  if (!palette) return base;
  const out: Look = { ...base };
  for (const key of LOOK_COLORS) {
    const v = palette[key];
    if (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v)) out[key] = v;
  }
  if (typeof palette.hat === "string" && (HATS as readonly string[]).includes(palette.hat)) out.hat = palette.hat as Hat;
  if (typeof palette.weapon === "string" && (LOOK_WEAPONS as readonly string[]).includes(palette.weapon)) out.weapon = palette.weapon as Weapon;
  return out;
}
