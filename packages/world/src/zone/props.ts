// What stands on a zone's hexes besides the ground itself: the walls of a
// ruin, the pillars of a hall, a brazier burning in a courtyard, the ribs
// of something long dead. A hex has one at most (`Tile.prop`), put there
// by the map's generator (lay.ts).
//
// The rules ask three things of one: does it bar the way, does it block
// the view (and so a shot, and the light), and does it give light. What
// it looks like is the client's business (render/zoneScenery.ts draws each
// kind); a test fails if a kind here has no drawing there.

export interface PropDef {
  name: string;
  /** Nobody walks, lands or is shoved onto its hex. */
  blocks?: boolean;
  /** Nothing is seen (or shot) through its hex. */
  hides?: boolean;
  /** It burns: how many hexes round it are lit, where it is dark. */
  light?: number;
  /** A line about it, for the tip under the pointer. */
  blurb: string;
}

export const PROPS = {
  // ---- masonry ----
  wall: { name: "Wall", blocks: true, hides: true, blurb: "Dressed stone, still standing. It bars the way and the view." },
  wall_broken: { name: "Broken wall", blocks: true, blurb: "What is left of a wall: too high to step over, low enough to see and shoot across." },
  tower: { name: "Tower", blocks: true, hides: true, blurb: "A round tower of fitted stone. It bars the way and the view." },
  arch: { name: "Archway", blurb: "A gate with nothing in it any more. Walk through." },
  pillar: { name: "Pillar", blocks: true, hides: true, blurb: "A pillar thick enough to stand behind." },
  pillar_broken: { name: "Broken pillar", blocks: true, blurb: "The stump of a pillar, and its drums lying round it." },
  statue: { name: "Statue", blocks: true, hides: true, blurb: "Somebody thought well enough of them to carve them twice life size." },
  obelisk: { name: "Obelisk", blocks: true, hides: true, blurb: "A needle of cut stone, written on all four sides." },
  altar: { name: "Altar", blocks: true, blurb: "A slab on a plinth. Whatever was offered here is long gone." },
  well: { name: "Well", blocks: true, blurb: "A ring of stone round a long drop." },
  stairs: { name: "Steps", blurb: "Worn steps up to the next level." },
  // ---- fire ----
  brazier: { name: "Brazier", blocks: true, light: 3, blurb: "An iron bowl of coals that somebody keeps fed." },
  campfire: { name: "Campfire", blocks: true, light: 3, blurb: "A fire in a ring of stones. Whoever lit it is not far off." },
  // ---- camps ----
  tent: { name: "Tent", blocks: true, hides: true, blurb: "Canvas over poles. It bars the way and the view." },
  palisade: { name: "Palisade", blocks: true, hides: true, blurb: "Sharpened stakes lashed side by side." },
  cart: { name: "Cart", blocks: true, blurb: "A cart with a broken axle, and nothing left on it worth carrying." },
  banner: { name: "Banner", blurb: "A pole and a rag of colour: someone claims this ground." },
  barrels: { name: "Barrels", blocks: true, blurb: "Barrels and sacks, stacked out of the wet." },
  // ---- the wild ----
  standing_stone: { name: "Standing stone", blocks: true, hides: true, blurb: "Set on end by people nobody remembers." },
  boulder: { name: "Boulder", blocks: true, hides: true, blurb: "Too big to move and too steep to climb." },
  ribs: { name: "Great ribs", blocks: true, blurb: "The ribs of something vast, bleached and half sunk." },
  skull: { name: "Great skull", blocks: true, hides: true, blurb: "The skull of something that ate whales." },
  crystal: { name: "Crystal", blocks: true, light: 2, blurb: "A spar of crystal taller than a mast, with its own cold light." },
  ice_spire: { name: "Ice spire", blocks: true, hides: true, blurb: "A fang of blue ice. It bars the way and the view." },
  dead_tree: { name: "Dead tree", blocks: true, blurb: "Bare and grey, and still standing." },
  great_tree: { name: "Great tree", blocks: true, hides: true, blurb: "An old tree, broader than a hut." },
  mushrooms: { name: "Giant mushrooms", blocks: true, blurb: "Caps as wide as a table, on stalks as thick as a leg." },
  stilt_hut: { name: "Stilt hut", blocks: true, hides: true, blurb: "A hut on legs, up out of the wet." },
  basalt: { name: "Basalt column", blocks: true, hides: true, blurb: "Six-sided black rock, as if somebody had cast it." },
  // ---- under a roof ----
  wall_torch: { name: "Wall with a torch", blocks: true, hides: true, light: 3, blurb: "Dressed stone, and a torch in an iron bracket." },
  throne: { name: "Throne", blocks: true, blurb: "A high seat of carved stone. Whoever sits in it gives the orders here." },
  bookshelf: { name: "Bookshelf", blocks: true, hides: true, blurb: "Shelves to the ceiling, and nobody dusting them." },
  table: { name: "Table", blocks: true, blurb: "A long table, with what was on it when they left." },
  weapon_rack: { name: "Weapon rack", blocks: true, blurb: "Spears and bills, racked and oiled." },
  cage: { name: "Cage", blocks: true, blurb: "Iron bars, a lock, and straw on the floor." },
  sarcophagus: { name: "Sarcophagus", blocks: true, blurb: "A stone coffin with somebody carved on the lid." },
  rug: { name: "Rug", blurb: "A long rug, worn down the middle by a great many boots." },
  // ---- under ground ----
  stalagmite: { name: "Stalagmite", blocks: true, hides: true, blurb: "A fang of wet stone, grown up from the floor a drip at a time." },
  bones: { name: "Bones", blurb: "Gnawed, cracked, and not all of them from animals." },
  // ---- the way in ----
  waygate: { name: "Waygate", blocks: true, light: 2, blurb: "The ring the lodestone drew you through. It is the way back, too." },
} satisfies Record<string, PropDef>;

export type PropKind = keyof typeof PROPS;
export const PROP_KINDS = Object.keys(PROPS) as PropKind[];

/** The prop on a tile, if it has one the rules know. */
export const propOf = (tile: { prop?: string } | undefined): PropDef | undefined => (tile?.prop ? (PROPS as Record<string, PropDef>)[tile.prop] : undefined);
