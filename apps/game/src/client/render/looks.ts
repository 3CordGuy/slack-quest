// The stock look of every humanoid sprite: palette, headgear and weapon per
// hero class, NPC or enemy kind. Pure data with no three.js or DOM, so the
// Worker can import it to validate admin palette overrides.

export const HATS = ["helm", "wizard", "hood", "horns", "leaves", "feather", "tricorn", "circlet", "brim", "turban", "kerchief", "greathelm", "diver", "none"] as const;
export type Hat = (typeof HATS)[number];
export const LOOK_WEAPONS = ["sword", "staff", "daggers", "club", "bow", "lute", "orb", "lantern", "scroll", "pack", "basket", "axe_shield", "grimoire", "smith_hammer", "paddle", "cleaver", "none"] as const;
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
  /** Tall boots of this colour, turned down at the top, in place of the usual plain shoes. */
  boots?: string;
  /** A brass plate of this colour over the shoulders, bolted round, that a diving helmet seats on. */
  corselet?: string;
  /** Eyes that glow this colour, over the eyes the face is drawn with (a drowned thing's). */
  glowEyes?: string;
  /** A scarf of this colour pulled up over the mouth and nose, its end hanging down the chest. */
  mask?: string;
  /** A band of this colour round the brow (under the hat, if there is one), knotted behind with two short tails. */
  bandana?: string;
  /** A vest of this colour over the shirt, open down the front. */
  vest?: string;
  /** Leather of this colour: a strap from the shoulder across the chest, and a belt with pouches at the hips. */
  straps?: string;
  /** Gold epaulettes of this colour on the shoulders, fringed. */
  epaulettes?: string;
  /** A necklace of teeth round the throat, with a stone of this colour at the middle. */
  teeth?: string;
  /** The colour of a long coat (its skirts, sleeves and fronts), where it is not the body's. */
  coatColor?: string;
  /** The colour of a long coat's edges, where it is not the accent. */
  coatTrim?: string;
  /** Barnacles and a little coral grown over the shoulders, as on something long under the sea. */
  barnacles?: boolean;
  /** A sash of this colour knotted at the hip, its long ends hanging in waves down the leg. */
  sash?: string;
  /** A full-length coat over the legs, for travellers. */
  coat?: boolean;
  /** A mustache, in the hair's colour, on a stock figure (a hero's own is in their appearance). */
  mustache?: "bushy" | "pencil" | "handlebar" | "walrus";
  /** An apron of this colour over the clothes: a bib on the chest and a skirt to the knees. */
  apron?: string;
  /** The nose on a stock figure, where it is not the usual pointy one: `bulbous` is big, round and ruddy. */
  nose?: "button" | "broad" | "long" | "hooked" | "bulbous";
  /** The eyes on a stock figure, where they are not the usual round ones. */
  eyes?: "big" | "beady" | "narrow" | "sleepy" | "fierce";
}

export const LOOKS: Record<string, Look> = {
  qa_paladin: { skin: "#f1c9a5", hair: "#8a5a2b", body: "#c9ced6", legs: "#5b6475", accent: "#e0b12e", hat: "helm", weapon: "sword" },
  // The Mage is a storm witch of the open deck: a hood, eyes alight with lightning, a tattered sea-green robe over
  // dark trousers, a necklace of teeth, a teal sash, and a driftwood staff grown over with barnacles.
  devops_mage: { skin: "#e8c4a6", hair: "#6b5440", body: "#2f5f5c", legs: "#2a2d2c", accent: "#7fd8ff", hat: "hood", hatColor: "#24403e", weapon: "staff", coat: true, coatTrim: "#1f3836", sash: "#3a6d70", glowEyes: "#8fe0ff", teeth: "#3fb8a8", boots: "#2a2622" },
  // The Rogue is a smuggler: a cloth band round the brow, a long dark coat over an olive shirt, belts and straps
  // with pouches, and two knives.
  refactor_rogue: { skin: "#d9a67c", hair: "#1f1c22", body: "#5a5a3e", legs: "#3d3e2e", accent: "#7a3a34", hat: "none", weapon: "daggers", bandana: "#8a8370", coat: true, coatColor: "#2a3038", coatTrim: "#1c2126", straps: "#5a3d26", boots: "#1f1f22" },
  backend_druid: { skin: "#d9a67c", hair: "#5a3d22", body: "#5d7d3a", legs: "#4a3a26", accent: "#a6d06a", hat: "leaves", weapon: "staff" },
  // The Bard sings at the capstan: a red bandana knotted behind, a linen shirt under a weathered teal vest, a red
  // sash, olive trousers and boots.
  frontend_bard: { skin: "#d9a67c", hair: "#3a2a20", body: "#e3d9c0", legs: "#4f5440", accent: "#e0b12e", hat: "kerchief", hatColor: "#a8322a", weapon: "lute", vest: "#4f6463", sash: "#a8322a", straps: "#5a3d26", boots: "#4a3426" },
  // The Sage is the ship's navigator: a tricorn over a red band, long grey hair, a teal captain's coat edged in gold
  // with gold epaulettes, a red sash, and a glowing armillary sphere on the palm.
  staff_sage: { skin: "#e3b897", hair: "#c9c9cc", body: "#1f4a46", legs: "#2a2420", accent: "#f2d675", hat: "tricorn", hatColor: "#1f2826", weapon: "orb", coat: true, coatTrim: "#c9a24a", bandana: "#7a2a2a", epaulettes: "#d4ab4a", sash: "#6b2a2a", boots: "#3a2c22" },
  // The Warden is a deep-sea diver: a brass helmet with a glass port, a brass plate on the shoulders, a canvas suit
  // and lead-weighted boots. The sea does not move them, and neither will you.
  sre_warden: { skin: "#d9a67c", hair: "#3a2a20", body: "#8f7f5c", legs: "#7d6f50", accent: "#e8742e", hat: "diver", hatColor: "#c2893a", weapon: "axe_shield", boots: "#4a4a52", corselet: "#c2893a" },
  // The Warlock is a captain the sea gave back: a dripping tricorn over a red band, eyes alight, a scarf over the
  // face, a long sea-dark coat edged in tarnished gold, a red sash, barnacles on the shoulders, and a grimoire
  // glowing purple.
  data_warlock: { skin: "#a3aca4", hair: "#2a2f2c", body: "#1f2e2b", legs: "#1a1f1e", accent: "#b06cff", hat: "tricorn", hatColor: "#1d2624", weapon: "grimoire", coat: true, coatTrim: "#a8863a", sash: "#6b2230", bandana: "#6b2230", glowEyes: "#c48bff", mask: "#2c3a39", boots: "#1d1f1f", barnacles: true },
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
  // The contract dealer by the pillar in the pub (packages/world/src/pub.ts): a broker in a long coat with a scroll of terms.
  dealer: { skin: "#e3b48c", hair: "#3a2a20", body: "#6b1f2a", legs: "#2a2228", accent: "#e0b12e", hat: "brim", hatColor: "#2a2228", weapon: "scroll", coat: true },
  // The keepers of the smithy and the apothecary (packages/world/src/keepers.ts): the smith in a leather apron with her
  // forging hammer, a red kerchief keeping her hair out of the fire; the apothecary in a long green coat and hood
  // (a hood, not a wide hat, so the brim does not hide his stirring), with the paddle he stirs his cauldron with.
  keeper_smith: { skin: "#d9a67c", hair: "#3a2a20", body: "#6b4a34", legs: "#3a3030", accent: "#8b95a5", hat: "kerchief", hatColor: "#b9433d", weapon: "smith_hammer" },
  keeper_apothecary: { skin: "#e8c2a0", hair: "#d9d9e3", body: "#3e6a44", legs: "#2a3a2e", accent: "#f2d675", hat: "hood", hatColor: "#2f5a3a", weapon: "paddle", coat: true },
  // The galley's cook: a big, weathered man with small beady eyes, a great red nose and a heavy black mustache, in a slate shirt under a stained linen
  // apron, a cook's cloth cap wound round his head, and the cleaver he is never seen without.
  keeper_cook: { skin: "#c98f68", hair: "#2a1c14", body: "#5f6f7a", legs: "#4a3a2e", accent: "#7a3a22", hat: "turban", hatColor: "#ece7d8", weapon: "cleaver", mustache: "walrus", apron: "#e2d9c2", nose: "bulbous", eyes: "beady" },
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
