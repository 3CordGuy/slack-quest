// The fishing catalogue: every fish, creature and haul that can come up on
// the line, and the Catch Book page each one fills.
//
// Pure data. Rolling a catch, sizing it and pricing it are in fishing.ts; how
// it fights is in fishfight.ts. Each entry's `shape` and `palette` drive both
// its 3D model and its pixel sprite on the client, so the two always match.

import type { Resources } from "./hut";

/** The water a catch is found in. Each pier fishes one; the open sea needs a rowboat. */
export type Water = "shallows" | "mouth" | "deep" | "sea";
export const WATERS: Water[] = ["shallows", "mouth", "deep", "sea"];

export type FishRarity = "common" | "uncommon" | "rare" | "legendary" | "mythic";
export const FISH_RARITIES: FishRarity[] = ["common", "uncommon", "rare", "legendary", "mythic"];

/**
 * How a catch fights. A darter makes short quick runs; a diver few long heavy
 * ones; a thrasher shakes its head; a plodder pulls low and long; a leaper
 * jumps, slacking the line and then snapping it tight; a haul is dead weight.
 */
export type FightStyle = "darter" | "diver" | "thrasher" | "plodder" | "leaper" | "dead";

export type FishKind = "fish" | "creature" | "haul";

/** Catch Book pages. "bonus" holds Old Ironjaw, outside the count. */
export type BookPage = "shallows" | "mouth" | "deep" | "sea" | "strays" | "flotsam" | "bonus";
export const BOOK_PAGES: BookPage[] = ["shallows", "mouth", "deep", "sea", "strays", "flotsam", "bonus"];

export interface FishDef {
  id: string;
  name: string;
  blurb: string;
  kind: FishKind;
  page: BookPage;
  /** Where it bites. Hauls come up anywhere. */
  water: Water[];
  rarity: FishRarity;
  /** Length range, cm. Rolls lean small; specimens are the long tail. */
  lengthCm: [number, number];
  /** Weight range, kg, matched to the length roll (weight grows as length³). */
  weightKg: [number, number];
  style: FightStyle;
  /** The fishmonger's base price per kg, before the day's rate. */
  pricePerKg: number;
  /** Old Tam buys it for the pub's kitchen. */
  kitchen?: boolean;
  /** Hauls: materials paid when the sitting ends. */
  yields?: Resources;
  /** Hauls: gold paid when the sitting ends, a range. */
  gold?: [number, number];
  /** Hauls kept as an item (sold or mounted later) rather than paid out. */
  keep?: boolean;
  /** Drives the 3D model and the sprite. */
  shape: string;
  /** Body, belly and accent colours. */
  palette: string[];
  pattern?: "stripes" | "spots" | "bars" | "glow";
  /** Reserved: bites only at night, once the server keeps a clock for it. */
  night?: boolean;
}

type Entry = Omit<FishDef, "id">;

const fish = (e: Entry): Entry => e;

export const FISH: Record<string, FishDef> = Object.fromEntries(
  Object.entries({
    // ---------- shallows: the west pier and the shore ----------
    sprat: fish({ name: "Harbor Sprat", blurb: "A sliver of silver. They come in hundreds.", kind: "fish", page: "shallows", water: ["shallows"], rarity: "common", lengthCm: [8, 15], weightKg: [0.01, 0.04], style: "darter", pricePerKg: 40, kitchen: true, shape: "slim", palette: ["#b8c4cc", "#eef2f4", "#5d7a8a"] }),
    goby: fish({ name: "Mud Goby", blurb: "Lives in the silt under the pier and resents being disturbed.", kind: "fish", page: "shallows", water: ["shallows"], rarity: "common", lengthCm: [6, 14], weightKg: [0.01, 0.05], style: "darter", pricePerKg: 25, shape: "goby", palette: ["#8a7355", "#c9b896", "#4a3b2a"], pattern: "spots" }),
    flounder: fish({ name: "Sandbar Flounder", blurb: "Both eyes on one side, and both of them looking at you.", kind: "fish", page: "shallows", water: ["shallows"], rarity: "common", lengthCm: [20, 50], weightKg: [0.1, 1.8], style: "plodder", pricePerKg: 6, kitchen: true, shape: "flat", palette: ["#9c8a6a", "#f0e8d8", "#6b5a3e"], pattern: "spots" }),
    wrasse: fish({ name: "Green Wrasse", blurb: "Bright as a weed bed in the sun, and about as good to eat.", kind: "fish", page: "shallows", water: ["shallows"], rarity: "common", lengthCm: [15, 40], weightKg: [0.1, 1.2], style: "darter", pricePerKg: 4, shape: "deep", palette: ["#4f9a5e", "#c8e0a0", "#2e5e8a"], pattern: "stripes" }),
    mullet: fish({ name: "Striped Mullet", blurb: "Jumps for no reason anyone has worked out.", kind: "fish", page: "shallows", water: ["shallows"], rarity: "uncommon", lengthCm: [30, 70], weightKg: [0.4, 4], style: "leaper", pricePerKg: 5, kitchen: true, shape: "torpedo", palette: ["#7d8c96", "#e4e8ea", "#3e4a52"], pattern: "stripes" }),
    glass_eel: fish({ name: "Glass Eel", blurb: "You can see its heart beating, and it can see yours.", kind: "fish", page: "shallows", water: ["shallows"], rarity: "uncommon", lengthCm: [30, 90], weightKg: [0.1, 1.5], style: "thrasher", pricePerKg: 9, shape: "eel", palette: ["#cfe6e8", "#f6fbfb", "#8ab8bd"] }),
    reed_barracuda: fish({ name: "Reed Barracuda", blurb: "Waits in the weed with its mouth open. A lot of teeth for a fish this thin.", kind: "fish", page: "shallows", water: ["shallows"], rarity: "uncommon", lengthCm: [50, 120], weightKg: [0.8, 9], style: "darter", pricePerKg: 5, shape: "pike", palette: ["#6b7f5a", "#dfe6cf", "#2f3a26"], pattern: "bars" }),
    lantern_sole: fish({ name: "Lantern Sole", blurb: "A flatfish with a faint glow along its fins. Fishermen say it is lit from inside.", kind: "fish", page: "shallows", water: ["shallows"], rarity: "rare", lengthCm: [25, 60], weightKg: [0.3, 3], style: "plodder", pricePerKg: 18, shape: "flat", palette: ["#6e6a8a", "#f2efd8", "#ffe78a"], pattern: "glow" }),
    spotted_ray: fish({ name: "Spotted Ray", blurb: "Lies flat on the sand and then, suddenly, does not.", kind: "fish", page: "shallows", water: ["shallows"], rarity: "rare", lengthCm: [50, 140], weightKg: [3, 25], style: "diver", pricePerKg: 4, shape: "ray", palette: ["#8a7a62", "#e8e0d0", "#3b3226"], pattern: "spots" }),
    old_whiskers: fish({ name: "Old Whiskers", blurb: "The harbor wels. Older than the pier, and it knows where every post is.", kind: "fish", page: "shallows", water: ["shallows"], rarity: "legendary", lengthCm: [150, 260], weightKg: [40, 120], style: "diver", pricePerKg: 2.5, shape: "wels", palette: ["#4a4636", "#b8ab88", "#22201a"], pattern: "spots" }),

    // ---------- the harbor mouth: the middle pier ----------
    herring: fish({ name: "Silver Herring", blurb: "The town runs on these. Smoked, salted, pickled, or in Tam's stew.", kind: "fish", page: "mouth", water: ["mouth"], rarity: "common", lengthCm: [18, 35], weightKg: [0.05, 0.5], style: "darter", pricePerKg: 9, kitchen: true, shape: "slim", palette: ["#9fb3c4", "#f2f5f7", "#3f5a74"] }),
    mackerel: fish({ name: "Mackerel", blurb: "Tiger-striped, quick, and never alone for long.", kind: "fish", page: "mouth", water: ["mouth"], rarity: "common", lengthCm: [25, 50], weightKg: [0.2, 1.5], style: "darter", pricePerKg: 5, kitchen: true, shape: "torpedo", palette: ["#3d7a7a", "#e8eef0", "#16343a"], pattern: "bars" }),
    pollock: fish({ name: "Blue Pollock", blurb: "Not exciting, but there is always more of it.", kind: "fish", page: "mouth", water: ["mouth"], rarity: "common", lengthCm: [35, 80], weightKg: [0.5, 6], style: "plodder", pricePerKg: 3, kitchen: true, shape: "cod", palette: ["#56708c", "#dde4ea", "#2b3a4a"] }),
    bream: fish({ name: "Sea Bream", blurb: "A round silver plate of a fish, with a gold bar over the eyes.", kind: "fish", page: "mouth", water: ["mouth"], rarity: "common", lengthCm: [25, 55], weightKg: [0.3, 3], style: "darter", pricePerKg: 5, kitchen: true, shape: "deep", palette: ["#a9b4ba", "#f0f2f2", "#d9a83a"] }),
    sea_bass: fish({ name: "Sea Bass", blurb: "Hits hard, shakes harder.", kind: "fish", page: "mouth", water: ["mouth"], rarity: "uncommon", lengthCm: [40, 90], weightKg: [0.8, 10], style: "thrasher", pricePerKg: 6, kitchen: true, shape: "bass", palette: ["#6f7f8a", "#e6eaec", "#2f3a42"] }),
    bonito: fish({ name: "Bonito", blurb: "A small tuna in a hurry.", kind: "fish", page: "mouth", water: ["mouth"], rarity: "uncommon", lengthCm: [45, 80], weightKg: [1, 7], style: "darter", pricePerKg: 5, shape: "tuna", palette: ["#2f4f6f", "#e0e6ea", "#14243a"], pattern: "stripes" }),
    garfish: fish({ name: "Garfish", blurb: "A needle with fins. Its bones are green, which nobody likes to learn at dinner.", kind: "fish", page: "mouth", water: ["mouth"], rarity: "uncommon", lengthCm: [50, 90], weightKg: [0.3, 1.5], style: "leaper", pricePerKg: 8, shape: "gar", palette: ["#4f8a7a", "#e4efe8", "#1f3f38"] }),
    amberjack: fish({ name: "Amberjack", blurb: "Hooks easily, then heads for the bottom and stays there.", kind: "fish", page: "mouth", water: ["mouth"], rarity: "rare", lengthCm: [60, 150], weightKg: [4, 40], style: "diver", pricePerKg: 3, shape: "jack", palette: ["#8a8a6a", "#ecead8", "#c9a040"], pattern: "stripes" }),
    silver_king: fish({ name: "Silver King", blurb: "A tarpon, scaled like a suit of coins. Throws itself clear of the water to throw the hook.", kind: "fish", page: "mouth", water: ["mouth"], rarity: "rare", lengthCm: [100, 200], weightKg: [10, 80], style: "leaper", pricePerKg: 2, shape: "tarpon", palette: ["#c4ccd2", "#f6f8f9", "#5a6a78"] }),
    gate_sturgeon: fish({ name: "Gate Sturgeon", blurb: "Armoured like a boat, and it has been through the harbor mouth longer than boats have.", kind: "fish", page: "mouth", water: ["mouth"], rarity: "legendary", lengthCm: [150, 280], weightKg: [30, 150], style: "plodder", pricePerKg: 2.5, shape: "sturgeon", palette: ["#5a5a52", "#c8c4b0", "#2a2a24"] }),

    // ---------- deep and rocky: the east pier ----------
    rockling: fish({ name: "Rockling", blurb: "Three whiskers and a grudge.", kind: "fish", page: "deep", water: ["deep"], rarity: "common", lengthCm: [20, 45], weightKg: [0.1, 1.2], style: "plodder", pricePerKg: 4, kitchen: true, shape: "cod", palette: ["#8a5a3a", "#e8d4c0", "#4a2a1a"], pattern: "spots" }),
    snapper: fish({ name: "Red Snapper", blurb: "As red as a lantern and as cross as it looks.", kind: "fish", page: "deep", water: ["deep"], rarity: "common", lengthCm: [30, 70], weightKg: [0.5, 8], style: "thrasher", pricePerKg: 5, kitchen: true, shape: "bass", palette: ["#c4473a", "#f2d0c4", "#7a2420"] }),
    lingcod: fish({ name: "Lingcod", blurb: "Mottled like the rocks it hides in. Its flesh can be faintly blue.", kind: "fish", page: "deep", water: ["deep"], rarity: "common", lengthCm: [50, 120], weightKg: [1, 20], style: "diver", pricePerKg: 3, kitchen: true, shape: "cod", palette: ["#6a6a4a", "#d8d4b8", "#2a2a1a"], pattern: "spots" }),
    scorpionfish: fish({ name: "Scorpionfish", blurb: "Mind the spines. Mind them more than that.", kind: "fish", page: "deep", water: ["deep"], rarity: "uncommon", lengthCm: [20, 45], weightKg: [0.3, 2.5], style: "thrasher", pricePerKg: 10, shape: "scorpion", palette: ["#b05a3a", "#e8c4a8", "#5a2a1a"], pattern: "spots" }),
    conger: fish({ name: "Conger Eel", blurb: "Thick as an arm, and it would like your arm.", kind: "fish", page: "deep", water: ["deep"], rarity: "uncommon", lengthCm: [80, 220], weightKg: [2, 40], style: "thrasher", pricePerKg: 2.5, shape: "eel", palette: ["#4a4e52", "#b8bcc0", "#1a1c1e"] }),
    inkjaw: fish({ name: "Inkjaw Squid", blurb: "Comes up in a cloud of black and a lot of arms.", kind: "creature", page: "deep", water: ["deep"], rarity: "uncommon", lengthCm: [30, 90], weightKg: [0.5, 8], style: "thrasher", pricePerKg: 7, kitchen: true, shape: "squid", palette: ["#a05a7a", "#f0d8e0", "#2a1a24"], pattern: "spots" }),
    wreck_grouper: fish({ name: "Wreck Grouper", blurb: "Lives in the wreck and drags anything it takes back inside.", kind: "fish", page: "deep", water: ["deep"], rarity: "rare", lengthCm: [70, 160], weightKg: [6, 90], style: "diver", pricePerKg: 2.5, shape: "grouper", palette: ["#5a6a4a", "#c8ccb0", "#2a3020"], pattern: "bars" }),
    moonfish: fish({ name: "Moonfish", blurb: "Round, red-finned and warm-blooded, which no fish has any business being.", kind: "fish", page: "deep", water: ["deep"], rarity: "rare", lengthCm: [80, 150], weightKg: [15, 60], style: "plodder", pricePerKg: 2.5, shape: "moon", palette: ["#7a8aa8", "#e8ecf4", "#d04a3a"], pattern: "spots" }),
    reef_shark: fish({ name: "Grey Reef Shark", blurb: "Circles the rocks below the lighthouse. Now it circles you.", kind: "fish", page: "deep", water: ["deep"], rarity: "rare", lengthCm: [120, 250], weightKg: [20, 150], style: "thrasher", pricePerKg: 1.5, shape: "shark", palette: ["#6a7078", "#dcdfe2", "#2a2e32"] }),
    halibut: fish({ name: "Halibut", blurb: "A flatfish the size of a door.", kind: "fish", page: "deep", water: ["deep"], rarity: "rare", lengthCm: [80, 220], weightKg: [6, 120], style: "plodder", pricePerKg: 2.5, kitchen: true, shape: "flat", palette: ["#5a5242", "#f2efe6", "#2a261e"], pattern: "spots" }),
    lampjaw: fish({ name: "Lampjaw Angler", blurb: "A light on a stalk, and behind it a mouth that is mostly mouth.", kind: "fish", page: "deep", water: ["deep"], rarity: "legendary", lengthCm: [60, 120], weightKg: [8, 50], style: "plodder", pricePerKg: 4, shape: "angler", palette: ["#3a3238", "#8a7a82", "#ffe070"], pattern: "glow", night: true }),

    // ---------- the open sea: rowboat only ----------
    flying_fish: fish({ name: "Flying Fish", blurb: "Spends half its life in the air. Spends the rest of it in your boat.", kind: "fish", page: "sea", water: ["sea"], rarity: "common", lengthCm: [20, 40], weightKg: [0.1, 0.6], style: "leaper", pricePerKg: 10, shape: "flyer", palette: ["#3a5a9a", "#e4ecf6", "#8ab0e0"] }),
    skipjack: fish({ name: "Skipjack", blurb: "Stripes down the belly and a motor in the tail.", kind: "fish", page: "sea", water: ["sea"], rarity: "common", lengthCm: [40, 80], weightKg: [1, 8], style: "darter", pricePerKg: 4, kitchen: true, shape: "tuna", palette: ["#2a4060", "#dce4ec", "#5a6a7a"], pattern: "stripes" }),
    albacore: fish({ name: "Albacore", blurb: "Long pectoral fins, and a long run to go with them.", kind: "fish", page: "sea", water: ["sea"], rarity: "common", lengthCm: [60, 120], weightKg: [4, 30], style: "diver", pricePerKg: 3, kitchen: true, shape: "tuna", palette: ["#2a3a5a", "#e8ecf0", "#c4ccd8"] }),
    blue_shark: fish({ name: "Blue Shark", blurb: "Slim, blue, and curious about the boat.", kind: "fish", page: "sea", water: ["sea"], rarity: "uncommon", lengthCm: [150, 280], weightKg: [20, 120], style: "thrasher", pricePerKg: 1.2, shape: "shark", palette: ["#3a6aaa", "#e8eef6", "#1a3a6a"] }),
    sunfish: fish({ name: "Drifting Sunfish", blurb: "A fish that is all head. It basks, it drifts, and it weighs as much as a cart.", kind: "fish", page: "sea", water: ["sea"], rarity: "uncommon", lengthCm: [100, 250], weightKg: [50, 200], style: "plodder", pricePerKg: 0.6, shape: "sunfish", palette: ["#8a929a", "#e6e8ea", "#4a525a"] }),
    dorado: fish({ name: "Sunfin Dorado", blurb: "Gold and green in the water, and it fades the moment it is out.", kind: "fish", page: "sea", water: ["sea"], rarity: "rare", lengthCm: [70, 180], weightKg: [4, 35], style: "leaper", pricePerKg: 4, kitchen: true, shape: "dorado", palette: ["#c8b030", "#f2e890", "#3a8a6a"], pattern: "spots" }),
    bluefin: fish({ name: "Bluefin", blurb: "Built like a cannonball and twice as determined.", kind: "fish", page: "sea", water: ["sea"], rarity: "rare", lengthCm: [90, 200], weightKg: [12, 120], style: "diver", pricePerKg: 2.5, shape: "tuna", palette: ["#1a2a4a", "#dce2ea", "#c8b040"] }),
    swordfish: fish({ name: "Broadbill Swordfish", blurb: "It has a sword. That is the whole of the warning.", kind: "fish", page: "sea", water: ["sea"], rarity: "rare", lengthCm: [150, 300], weightKg: [30, 200], style: "leaper", pricePerKg: 1.5, shape: "sword", palette: ["#4a4a5a", "#d8d8e0", "#2a2a36"] }),
    sailback: fish({ name: "Sailback", blurb: "Raises a sail along its back when it hunts, and goes faster than anything in the sea.", kind: "fish", page: "sea", water: ["sea"], rarity: "legendary", lengthCm: [180, 300], weightKg: [30, 90], style: "leaper", pricePerKg: 3, shape: "sail", palette: ["#2a4a8a", "#e0e6f0", "#6a4aa8"], pattern: "spots" }),
    oarfish: fish({ name: "Ribbon Oarfish", blurb: "A silver ribbon as long as a ship, with a red crest. Sailors call it a sea serpent, and it does not argue.", kind: "fish", page: "sea", water: ["sea"], rarity: "legendary", lengthCm: [300, 600], weightKg: [20, 150], style: "plodder", pricePerKg: 2, shape: "ribbon", palette: ["#c8ccd4", "#f4f6f8", "#d03a3a"] }),

    // ---------- strays: any water ----------
    shore_crab: fish({ name: "Shore Crab", blurb: "Came up holding the bait and refuses to let go of it.", kind: "creature", page: "strays", water: ["shallows", "mouth", "deep"], rarity: "common", lengthCm: [6, 15], weightKg: [0.05, 0.4], style: "dead", pricePerKg: 12, kitchen: true, shape: "crab", palette: ["#5a6a3a", "#d8c890", "#2a3018"] }),
    spider_crab: fish({ name: "Spider Crab", blurb: "All legs, and every one of them is in the way.", kind: "creature", page: "strays", water: ["shallows", "mouth", "deep"], rarity: "uncommon", lengthCm: [20, 60], weightKg: [0.5, 5], style: "dead", pricePerKg: 7, kitchen: true, shape: "spider_crab", palette: ["#b06a3a", "#e8c8a8", "#5a3018"] }),
    blue_lobster: fish({ name: "Blue Lobster", blurb: "One in a great many is blue. Tam will not cook it; he says it is lucky.", kind: "creature", page: "strays", water: ["deep"], rarity: "rare", lengthCm: [25, 60], weightKg: [0.5, 6], style: "thrasher", pricePerKg: 20, shape: "lobster", palette: ["#2a5aaa", "#8ab0e0", "#14305a"] }),
    ironjaw: fish({ name: "Old Ironjaw", blurb: "A scarred old shark with a jaw full of other people's hooks. Every harbor has a story about him. This one is true.", kind: "fish", page: "bonus", water: ["sea"], rarity: "mythic", lengthCm: [250, 380], weightKg: [150, 300], style: "thrasher", pricePerKg: 1.5, shape: "shark", palette: ["#4a4e54", "#a8acb0", "#8a3a2a"], pattern: "bars" }),

    // ---------- flotsam: hauls, anywhere ----------
    kelp: fish({ name: "Kelp Tangle", blurb: "A great green knot of it. Good for nothing, but it was heavy.", kind: "haul", page: "flotsam", water: ["shallows", "mouth", "deep", "sea"], rarity: "common", lengthCm: [40, 120], weightKg: [0.5, 3], style: "dead", pricePerKg: 0, shape: "kelp", palette: ["#4a6a2a", "#8aa040", "#2a3a14"] }),
    boot: fish({ name: "Old Boot", blurb: "Left foot. Somebody, somewhere, still has the right.", kind: "haul", page: "flotsam", water: ["shallows", "mouth", "deep", "sea"], rarity: "common", lengthCm: [25, 32], weightKg: [0.5, 1.2], style: "dead", pricePerKg: 0, shape: "boot", palette: ["#5a3a24", "#8a6a4a", "#2a1a10"] }),
    driftwood: fish({ name: "Driftwood", blurb: "Bleached and smooth. It will burn.", kind: "haul", page: "flotsam", water: ["shallows", "mouth", "deep", "sea"], rarity: "common", lengthCm: [50, 150], weightKg: [2, 6], style: "dead", pricePerKg: 0, yields: { wood: 1 }, shape: "driftwood", palette: ["#c8b89a", "#e8dcc4", "#8a7a5a"] }),
    fish_skeleton: fish({ name: "Fish Skeleton", blurb: "Picked clean by the crabs. The bones are still good for something.", kind: "haul", page: "flotsam", water: ["shallows", "mouth", "deep", "sea"], rarity: "common", lengthCm: [30, 90], weightKg: [0.5, 1.5], style: "dead", pricePerKg: 0, yields: { bone: 1 }, shape: "skeleton", palette: ["#e8e4d8", "#f6f4ee", "#a8a498"] }),
    whalebone: fish({ name: "Whalebone Bundle", blurb: "Ribs as long as your arm, lashed together by someone who meant to come back for them.", kind: "haul", page: "flotsam", water: ["shallows", "mouth", "deep", "sea"], rarity: "uncommon", lengthCm: [80, 140], weightKg: [4, 10], style: "dead", pricePerKg: 0, yields: { bone: 2 }, shape: "whalebone", palette: ["#e0d8c4", "#f2ece0", "#8a7a5a"] }),
    kettle: fish({ name: "Rusted Kettle", blurb: "Copper under the green. The spout still pours, mostly sand.", kind: "haul", page: "flotsam", water: ["shallows", "mouth", "deep", "sea"], rarity: "uncommon", lengthCm: [20, 30], weightKg: [1, 3], style: "dead", pricePerKg: 0, yields: { copper: 1 }, shape: "kettle", palette: ["#5a8a6a", "#b87a4a", "#2a4a34"] }),
    chain: fish({ name: "Barnacled Chain", blurb: "A length of anchor chain. Whatever it held is long gone.", kind: "haul", page: "flotsam", water: ["shallows", "mouth", "deep", "sea"], rarity: "uncommon", lengthCm: [100, 200], weightKg: [4, 10], style: "dead", pricePerKg: 0, yields: { iron: 1 }, shape: "chain", palette: ["#6a5a4a", "#c8c0b0", "#3a2a1e"] }),
    bottle: fish({ name: "Message in a Bottle", blurb: "Corked and dry inside. Someone wanted this read.", kind: "haul", page: "flotsam", water: ["shallows", "mouth", "deep", "sea"], rarity: "uncommon", lengthCm: [25, 30], weightKg: [0.4, 0.6], style: "dead", pricePerKg: 0, gold: [3, 8], shape: "bottle", palette: ["#4a8a6a", "#c8e8d8", "#e8dcb8"] }),
    tackle_tin: fish({ name: "Lost Tackle Tin", blurb: "Hooks, a float, a coil of good line, and a few coins somebody hid under the tray.", kind: "haul", page: "flotsam", water: ["shallows", "mouth", "deep", "sea"], rarity: "uncommon", lengthCm: [18, 24], weightKg: [0.5, 1], style: "dead", pricePerKg: 0, gold: [5, 12], shape: "tin", palette: ["#8a8a8a", "#c8c8c8", "#a83a2a"] }),
    crate: fish({ name: "Sodden Crate", blurb: "Stencilled with a merchant's mark. Some of what is inside survived.", kind: "haul", page: "flotsam", water: ["shallows", "mouth", "deep", "sea"], rarity: "uncommon", lengthCm: [50, 70], weightKg: [5, 15], style: "dead", pricePerKg: 0, yields: { wood: 1, fur: 1 }, shape: "crate", palette: ["#7a5a3a", "#a88a5a", "#3a2a1a"] }),
    pearl_oyster: fish({ name: "Pearl Oyster", blurb: "Crusted shut. Something inside rattles.", kind: "haul", page: "flotsam", water: ["shallows", "mouth", "deep", "sea"], rarity: "rare", lengthCm: [12, 25], weightKg: [0.3, 1], style: "dead", pricePerKg: 0, yields: { gem: 1 }, shape: "oyster", palette: ["#8a8478", "#f0ece4", "#e8e0f0"] }),
    lockbox: fish({ name: "Smuggler's Lockbox", blurb: "Iron-banded and locked. The lock gives before you do.", kind: "haul", page: "flotsam", water: ["shallows", "mouth", "deep", "sea"], rarity: "rare", lengthCm: [30, 45], weightKg: [4, 9], style: "dead", pricePerKg: 0, gold: [20, 50], shape: "lockbox", palette: ["#5a3a24", "#8a8a8a", "#c8a040"] }),
    ships_bell: fish({ name: "Ship's Bell", blurb: "Green with age, with a name on it nobody in the Harbor recognises. It still rings.", kind: "haul", page: "flotsam", water: ["shallows", "mouth", "deep", "sea"], rarity: "legendary", lengthCm: [35, 50], weightKg: [15, 30], style: "dead", pricePerKg: 0, keep: true, shape: "bell", palette: ["#5a8a6a", "#c8a050", "#2a4a34"] }),
    mermaid_comb: fish({ name: "Mermaid's Comb", blurb: "Carved from something that is not bone and not shell. It is warm to the touch.", kind: "haul", page: "flotsam", water: ["shallows", "mouth", "deep", "sea"], rarity: "legendary", lengthCm: [15, 22], weightKg: [0.2, 0.4], style: "dead", pricePerKg: 0, keep: true, shape: "comb", palette: ["#e8d8e8", "#f8f0f8", "#8ab0c8"] }),
  }).map(([id, e]) => [id, { id, ...e }]),
);

export const FISH_IDS = Object.keys(FISH);

/** What a kept haul (`keep`) sells for at the fishmonger, flat, whatever its weight. */
export const KEPT_HAUL_PRICE: Record<string, number> = { ships_bell: 90, mermaid_comb: 120 };

/** The entries on a Catch Book page, commons first, as the page lays them out. */
export function bookPage(page: BookPage): FishDef[] {
  return FISH_IDS.map((id) => FISH[id]).filter((f) => f.page === page).sort((a, b) => FISH_RARITIES.indexOf(a.rarity) - FISH_RARITIES.indexOf(b.rarity));
}

/** Slots that count towards a full Catch Book: every page but the bonus. */
export const BOOK_SLOTS = FISH_IDS.filter((id) => FISH[id].page !== "bonus").length;

/** "a mackerel", "an albacore", or a named fish as it is: "Old Ironjaw". */
export function aFish(id: string): string {
  const name = FISH[id]?.name ?? id;
  if (/^Old /.test(name)) return name;
  return `${/^[AEIOU]/i.test(name) ? "an" : "a"} ${name.toLowerCase()}`;
}
