import type { EffectType, Rarity, ItemType, EquipSlot, TownSection, TownArt, QuestVariant, QuestOption } from "./types";

export const CATALOG_EFFECT: Record<string, { effect: string; target: "self" | "monster" }> = {
  "Espresso Shot": { effect: "regen",     target: "self"    },
  "Regen Draft":   { effect: "regen",     target: "self"    },
  "Poison Vial":   { effect: "poisoned",  target: "monster" },
  "Venom Vial":    { effect: "poisoned",  target: "monster" },
  "Battle Elixir": { effect: "empowered", target: "self"    },
};

export const ERROR_LABELS: Record<string, string> = {
  cooldown: "Catching your breath — try again later.",
  already_full: "Already at full HP/mana — no rest needed.",
  at_full_hp: "Already at full HP — save it for when you need it.",
  at_full_mana: "Already at full mana — save it for when you need it.",
  at_max_mana_cap: "Already at max mana cap (5) — save it for another character.",
  no_rest_mid_quest: "Can't rest mid-quest. Finish the fight first.",
  no_long_rest_mid_quest: "Long rest blocked mid-quest. Wrap up first.",
  downed: "You're downed — wait for the cooldown.",
  no_character: "Roll a character in Slack first.",
  unauthenticated: "Session expired — log in again.",
  not_yours: "That item isn't yours.",
  already_equipped: "Already equipped.",
  consumable_not_equippable: "Consumables can't be equipped — use them.",
  bad_item_id: "Bad item id.",
  bad_quest_id: "Bad quest id.",
  not_in_party: "You're not in this party.",
  web_mode: "This quest is being run from the web — head there.",
  slack_mode: "This quest was started in Slack — use Slack commands to fight.",
  cant_give_to_self: "Can't give an item to yourself.",
  unequip_first: "Unequip the item first before giving or selling.",
  recipient_no_character: "That player hasn't rolled a character yet.",
  mid_quest: "Not available mid-quest.",
  insufficient_gold: "Not enough gold.",
  unknown_drink: "Unknown drink.",
  drink_cap_reached: "The bartender cuts you off — you've had your fill before the fight.",
  invalid_stake: "Invalid stake amount.",
  invalid_throw: "Invalid throw — pick stone, parchment, or dagger.",
  match_already_open: "There's already an open match in your channel.",
  no_channel: "No channel found — join a quest first.",
  match_not_found: "Match not found.",
  match_not_open: "Match is no longer open.",
  match_taken: "Someone else accepted the match first.",
  cant_accept_own_match: "You can't accept your own match.",
  cant_bet_on_own_match: "You can't bet on your own match.",
  already_bet: "You've already placed a bet on this match.",
  invalid_side: "Pick initiator or challenger.",
  invalid_bet_amount: "Bet must be 5g, 10g, or 25g.",
  not_initiator: "Only the initiator can cancel the match.",
  already_resolved: "Match is already resolved.",
};

export const RARITY_COLOR: Record<Rarity, string> = {
  common: "#8a8f98",
  uncommon: "#16a34a",
  rare: "#3b82f6",
  epic: "#a855f7",
  legendary: "#f59e0b",
};

export const RARITY_RANK: Record<Rarity, number> = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };

export const EFFECT_COLOR: Record<EffectType, string> = {
  regen:    "#86efac",  /* --tone-good */
  bleeding: "#fb7185",  /* --tone-bleed */
  burning:  "#fb923c",  /* --tone-fire */
  poisoned: "#4ade80",  /* --tone-poison (green, not purple) */
  empowered:"#fbbf24",  /* --accent-gold */
  frozen:   "#93c5fd",  /* --tone-ice */
  shocked:  "#facc15",  /* --tone-shock (saturated yellow) */
};

export const EFFECT_ICON: Record<EffectType, string> = {
  regen: "aura",
  bleeding: "bleeding-wound",
  burning: "fire",
  poisoned: "poison-cloud",
  empowered: "electric",
  frozen: "ice-bolt",
  shocked: "electric",
};

export const ITEM_TYPE_ORDER: ItemType[] = [
  "weapon",
  "armor",
  "magic",
  "consumable",
  "revive",
  "tool",
  "scroll",
];

export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  weapon: "Weapons",
  armor: "Armor",
  magic: "Magic",
  consumable: "Consumables",
  revive: "Revives",
  tool: "Tools",
  scroll: "Scrolls",
};

export const SLOT_LABELS: Record<EquipSlot, string> = {
  main_hand: "Main Hand",
  off_hand: "Off Hand",
  body: "Body",
  helmet: "Helmet",
  pants: "Legs",
  boots: "Boots",
  ring: "Ring",
  amulet: "Amulet",
};

export const SLOT_ICON: Record<EquipSlot, string> = {
  main_hand: "hand",
  off_hand: "hand",
  body: "chest-armor",
  helmet: "heavy-helm",
  pants: "armored-pants",
  boots: "boots",
  ring: "ring",
  amulet: "gem-chain",
};

export const DOLL_LAYOUT: (EquipSlot | null)[] = [
  "helmet",    null,        null,
  "body",      "main_hand", "off_hand",
  "pants",     "ring",      "amulet",
  "boots",     null,        null,
];

export const VARIANT_LABEL: Record<string, string> = {
  standard: "Standard",
  boss: "Boss",
  gauntlet: "Gauntlet",
};

export const VARIANT_STYLE: Record<string, { icon: string; color: string; bg: string; label: string }> = {
  standard:     { icon: "sword",         color: "#86efac", bg: "#0a1f0a", label: "STANDARD" },
  boss:         { icon: "crown",         color: "#fca5a5", bg: "#1f0a0a", label: "BOSS" },
  gauntlet:     { icon: "crossed-swords",color: "#c4b5fd", bg: "#130a1f", label: "GAUNTLET" },
  bounty_pack:  { icon: "dragon",        color: "#fb923c", bg: "#1f0e00", label: "BOUNTY PACK" },
};

export const ART_PLACEHOLDERS: Record<string, { bg: string; icon: string; color: string }> = {
  "Shop":       { bg: "#1e1a0d", icon: "gold-bar",              color: "#c9a227" },
  "The Inn":    { bg: "#1a1510", icon: "bed",                   color: "#c4956a" },
  "The Smithy": { bg: "#1e1208", icon: "anvil",                 color: "#e07840" },
  "The Pub":    { bg: "#1a1608", icon: "beer-stein",            color: "#d4a53a" },
  "Apothecary": { bg: "#140f22", icon: "potion-ball",           color: "#9a6fcd" },
  "Inventory":  { bg: "#0f1620", icon: "cubes",                 color: "#5c9bd6" },
  "Outskirts":  { bg: "#0d1a10", icon: "run",                   color: "#5da85a" },
  "Job Board":  { bg: "#101820", icon: "scroll-unfurled",       color: "#5a8ab5" },
};

export const DEFAULT_ART_PLACEHOLDER = { bg: "#111318", icon: "perspective-dice-six", color: "#555b6a" };

export const LIARS_TRUST_MULT_DISPLAY = "1.7";
export const LIARS_CHALLENGE_MULT_DISPLAY = "2.5";

export const GAME_LABELS: Record<string, string> = { liars: "Liar's Roll", spd_match: "SPD match", spd_bet: "SPD side-bet" };

export const HUNT_PACK_LABEL = ["", "Solo", "Pair", "Trio"] as const;

export const HAGGLE_LABEL: Record<"failed" | "15" | "25" | "30", string> = {
  failed: "No luck",
  "15": "Modest deal",
  "25": "Good deal",
  "30": "Steal!",
};

export const DISTRICT_CONFIG: {
  key: TownSection;
  label: string;
  icon: string;
  color: string;
  artKey: keyof TownArt;
}[] = [
  { key: "job_board", label: "Job Board", icon: "scroll-unfurled", color: "#b89b3a", artKey: "overview_art_url" },
  { key: "pub",       label: "The Pub",   icon: "beer-stein",      color: "#92400e", artKey: "pub_art_url" },
  { key: "shop",      label: "Shop",      icon: "gold-bar",        color: "#1e3a5f", artKey: "shop_art_url" },
  { key: "inn",       label: "Inn",       icon: "bed",             color: "#1a3a2a", artKey: "inn_art_url" },
  { key: "smithy",    label: "Smithy",    icon: "anvil",           color: "#2a1a1a", artKey: "smithy_art_url" },
  { key: "apothecary", label: "Apothecary", icon: "poison-bottle", color: "#1a2d1a", artKey: "apothecary_art_url" },
  { key: "hunt",      label: "Outskirts", icon: "sword",           color: "#1a1a2e", artKey: "outskirts_art_url" },
];

export const PRIMARY_STAT_META: Record<string, { color: string; label: string; tooltip: (v: number, level: number) => string }> = {
  str:      { color: "#f87171", label: "STR", tooltip: (v) => `Attack modifier\nfloor((${v} − 5) / 2) = ${Math.floor((v - 5) / 2) >= 0 ? "+" : ""}${Math.floor((v - 5) / 2)}\nAdded to weapon damage rolls` },
  int_stat: { color: "#7dd3fc", label: "INT", tooltip: (v) => `Magic modifier\nfloor((${v} − 5) / 2) = ${Math.floor((v - 5) / 2) >= 0 ? "+" : ""}${Math.floor((v - 5) / 2)}\nAdded to spell & heal rolls\n\nStarting mana\n1 + floor(${v} / 4) = ${1 + Math.floor(v / 4)}` },
  vit:      { color: "#86efac", label: "VIT", tooltip: (v, level) => `Max HP\n16 + 2×${v} + 2×${level} = ${16 + 2 * v + 2 * level}\n\nArmor bonus\nfloor(max(0, ${v} − 5) / 4) = +${Math.floor(Math.max(0, v - 5) / 4)}\nPassive armor above 5 VIT` },
  agi:      { color: "#34d399", label: "AGI", tooltip: (v) => `Dodge chance\nmin(15%, (${v} − 5) × 1%) = ${Math.round(Math.min(0.15, Math.max(0, v - 5) * 0.01) * 100)}%\nFully negates a hit when dodged\n\nInitiative bonus\nfloor((${v} − 5) / 2) = ${Math.floor((v - 5) / 2) >= 0 ? "+" : ""}${Math.floor((v - 5) / 2)}\nAdded to d6 initiative roll` },
  dex:      { color: "#fbbf24", label: "DEX", tooltip: (v) => `Crit bonus\nmax(0, (${v} − 5) × 1%) = +${Math.round(Math.min(0.10, Math.max(0, v - 5) * 0.01) * 100)}%\nBonus crit chance (cap 10%)` },
};

export const QUEST_OPTIONS: QuestOption[] = [
  {
    id: "standard" as QuestVariant,
    label: "Standard",
    icon: "sword",
    accentColor: "#86efac",
    bg: "#1a2e1a",
    border: "#22543d",
    lockedBorder: "#2a2d33",
    tag: "Single encounter",
    description:
      "The dungeon master conjures a single AI-generated foe scaled to your party's level. A reliable source of XP, gold, and loot.",
    rewards: "Normal XP & gold",
    beginLabel: "Begin Standard Quest",
    pendingLabel: "Rolling…",
    minLevel: 1,
  },
  {
    id: "boss" as QuestVariant,
    label: "Boss",
    icon: "crown",
    accentColor: "#fca5a5",
    bg: "#2e1a1a",
    border: "#7f1d1d",
    lockedBorder: "#2a2d33",
    tag: "Climactic single foe",
    description:
      "One fearsome creature with elevated HP and an extra tier of attack power. Every action matters — a single mistake can turn the tide.",
    rewards: "Bonus XP + chance at rare drop",
    beginLabel: "Challenge the Boss",
    pendingLabel: "Rolling…",
    minLevel: 3,
  },
  {
    id: "gauntlet" as QuestVariant,
    label: "Gauntlet",
    icon: "crossed-swords",
    accentColor: "#c4b5fd",
    bg: "#1e1a2e",
    border: "#4c1d95",
    lockedBorder: "#2a2d33",
    tag: "3 waves, no recovery",
    description:
      "Three enemies back-to-back with no rest between waves. HP and mana carry over — positioning and resource management are everything.",
    rewards: "3× monster loot + milestone bonus",
    beginLabel: "Enter the Gauntlet",
    pendingLabel: "Rolling…",
    minLevel: 5,
  },
  {
    id: "tower" as QuestVariant,
    label: "Climb the Tower",
    icon: "tower-flag",
    accentColor: "#fbbf24",
    bg: "#2e2515",
    border: "#854d0e",
    lockedBorder: "#2a2d33",
    tag: "10-floor cycles, no flee",
    description:
      "Climb an open-ended tower. Each floor scales harder. Rest stop on floor 5 of every cycle, boss on floor 10. After every boss, bank your spoils or press on into a steeper cycle. Death ends the run.",
    rewards: "XP per floor · loot at rest stops + boss hoards",
    beginLabel: "Climb the Tower",
    pendingLabel: "Pre-rolling floors…",
    minLevel: 3,
  },
];
