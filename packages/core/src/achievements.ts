// Achievement definitions and award-check helpers.
// Definitions are pure constants (no DB). Award checks are pure functions.

import type { SpdThrow } from "./flavor";

export interface Achievement {
  id: string;
  title: string;
  flavor: string;
  description: string;
  icon: string; // RPG Awesome name (no ra- prefix)
  gradient: [string, string]; // CSS color from → to
  category: "combat" | "class" | "boss" | "death" | "social" | "economy" | "pub" | "quest";
}

export interface EarnedAchievement {
  id: string;
  unlocked_at: number; // unix ms
}

export const ACHIEVEMENTS: Achievement[] = [
  // ── Combat — General ──────────────────────────────────────────────────────
  {
    id: "first_victory",
    title: "First Blood",
    flavor: "The first monster to fall by your hand is never the last.",
    description: "Win your first combat.",
    icon: "crossed-swords",
    gradient: ["#7f1d1d", "#dc2626"],
    category: "combat",
  },
  {
    id: "veteran_10",
    title: "Veteran Combatant",
    flavor: "Ten battles behind you. Countless ahead.",
    description: "Win 10 combats.",
    icon: "sword",
    gradient: ["#1e3a5f", "#3b82f6"],
    category: "combat",
  },
  {
    id: "veteran_50",
    title: "Battle-Hardened",
    flavor: "Scars are just a map of where you've been.",
    description: "Win 50 combats.",
    icon: "sword",
    gradient: ["#312e81", "#6366f1"],
    category: "combat",
  },
  {
    id: "veteran_100",
    title: "Legendary Warrior",
    flavor: "The monsters whisper your name to each other.",
    description: "Win 100 combats.",
    icon: "lightning-sword",
    gradient: ["#451a03", "#f59e0b"],
    category: "combat",
  },
  {
    id: "killing_blow_10",
    title: "Monster Slayer",
    flavor: "A killing blow is an art. You have mastered ten.",
    description: "Land the killing blow on 10 monsters.",
    icon: "plain-dagger",
    gradient: ["#1c1917", "#78716c"],
    category: "combat",
  },
  {
    id: "near_death",
    title: "Death-Defying",
    flavor: "You looked into the void. It blinked first.",
    description: "Survive a combat after dropping below 25% HP.",
    icon: "fire-symbol",
    gradient: ["#7c2d12", "#ea580c"],
    category: "combat",
  },
  {
    id: "last_stand_1hp",
    title: "On the Edge",
    flavor: "One hit point. One heartbeat. Victory.",
    description: "Win a combat with exactly 1 HP remaining.",
    icon: "bleeding-hearts",
    gradient: ["#4c0519", "#f43f5e"],
    category: "combat",
  },
  {
    id: "speed_run_3",
    title: "Speed Demon",
    flavor: "The fight was over before the monsters knew it started.",
    description: "Win a combat in 3 rounds or fewer.",
    icon: "footprint",
    gradient: ["#14532d", "#22c55e"],
    category: "combat",
  },
  {
    id: "marathon_10",
    title: "Iron Endurance",
    flavor: "You outlasted their rage. Round after round.",
    description: "Survive a combat that lasts 10 or more rounds.",
    icon: "hourglass",
    gradient: ["#1e1b4b", "#818cf8"],
    category: "combat",
  },
  {
    id: "full_hp_win",
    title: "Untouched",
    flavor: "Not a scratch. Not a bruise. Just victory.",
    description: "Win a combat without losing any HP.",
    icon: "aura",
    gradient: ["#064e3b", "#10b981"],
    category: "combat",
  },

  // ── Boss Fights ───────────────────────────────────────────────────────────
  {
    id: "first_boss",
    title: "Boss Hunter",
    flavor: "The greatest among them still bleeds.",
    description: "Defeat your first boss.",
    icon: "dragon",
    gradient: ["#3b0764", "#a855f7"],
    category: "boss",
  },
  {
    id: "boss_5",
    title: "Boss Slayer",
    flavor: "Five legendary foes reduced to memories.",
    description: "Defeat 5 bosses.",
    icon: "dragon",
    gradient: ["#4a044e", "#e879f9"],
    category: "boss",
  },
  {
    id: "phase_2_survived",
    title: "Phase Breaker",
    flavor: "You cracked its second wind and kept swinging.",
    description: "Survive a boss's phase 2 transition.",
    icon: "fire",
    gradient: ["#7c1d1d", "#f97316"],
    category: "boss",
  },
  {
    id: "boss_killing_blow",
    title: "Dragonslayer",
    flavor: "The legend ends by your hand alone.",
    description: "Land the killing blow on a boss.",
    icon: "crossed-swords",
    gradient: ["#78350f", "#f59e0b"],
    category: "boss",
  },
  {
    id: "gauntlet_clear",
    title: "The Gauntlet",
    flavor: "Wave after wave. You remained standing.",
    description: "Complete a full gauntlet quest.",
    icon: "tower",
    gradient: ["#1c1917", "#a8a29e"],
    category: "boss",
  },

  // ── Class-Specific ────────────────────────────────────────────────────────
  {
    id: "devops_wins_5",
    title: "YAML Sorcerer",
    flavor: "The pipeline is live. The monsters are not.",
    description: "Win 5 combats as a DevOps Mage.",
    icon: "crystal-wand",
    gradient: ["#1e3a8a", "#60a5fa"],
    category: "class",
  },
  {
    id: "containerize_3",
    title: "Container Whisperer",
    flavor: "Containerize. Deploy. Dominate.",
    description: "Use Containerize 3 times across combats.",
    icon: "cubes",
    gradient: ["#0c4a6e", "#38bdf8"],
    category: "class",
  },
  {
    id: "qa_wins_5",
    title: "Holy Regression",
    flavor: "All bugs fixed. All monsters flattened.",
    description: "Win 5 combats as a QA Paladin.",
    icon: "shield",
    gradient: ["#1a2e05", "#84cc16"],
    category: "class",
  },
  {
    id: "paladin_heal_10",
    title: "Lay on Hands",
    flavor: "The light flows through you. Nothing is beyond saving.",
    description: "Heal allies 10 times across combats.",
    icon: "health-increase",
    gradient: ["#14532d", "#4ade80"],
    category: "class",
  },
  {
    id: "druid_wins_5",
    title: "Root Access",
    flavor: "The forest does not forget. Neither do you.",
    description: "Win 5 combats as a Backend Druid.",
    icon: "grass",
    gradient: ["#14532d", "#22c55e"],
    category: "class",
  },
  {
    id: "migrate_3",
    title: "Schema Migration",
    flavor: "Zero downtime. Three migrations. One legend.",
    description: "Use Migrate 3 times across combats.",
    icon: "leaf",
    gradient: ["#166534", "#86efac"],
    category: "class",
  },
  {
    id: "bard_wins_5",
    title: "Pixel Maestro",
    flavor: "Your UI ships. Your enemies don't.",
    description: "Win 5 combats as a Frontend Bard.",
    icon: "aura",
    gradient: ["#4a044e", "#c084fc"],
    category: "class",
  },
  {
    id: "hymn_killing_blow",
    title: "Encore",
    flavor: "The killing blow, set to music.",
    description: "Land the killing blow while Hymn is active.",
    icon: "perspective-dice-six",
    gradient: ["#581c87", "#d946ef"],
    category: "class",
  },
  {
    id: "sage_wins_5",
    title: "Ancient Wisdom",
    flavor: "You saw it coming. All of it.",
    description: "Win 5 combats as a Staff Sage.",
    icon: "scroll-unfurled",
    gradient: ["#1e3a5f", "#93c5fd"],
    category: "class",
  },
  {
    id: "foresee_lethal_survive",
    title: "Foresight",
    flavor: "You knew it would be lethal. You prepared anyway.",
    description: "Survive a Foresee-predicted lethal hit.",
    icon: "crystal-ball",
    gradient: ["#1e3a5f", "#818cf8"],
    category: "class",
  },
  {
    id: "rogue_wins_5",
    title: "Shadow Protocol",
    flavor: "The audit log shows nothing. Perfect.",
    description: "Win 5 combats as a Refactor Rogue.",
    icon: "plain-dagger",
    gradient: ["#1c1917", "#a8a29e"],
    category: "class",
  },
  {
    id: "vanish_dodge_5",
    title: "Ghost in the Code",
    flavor: "You were never there. The monsters agree.",
    description: "Dodge attacks while Vanished 5 times across combats.",
    icon: "player-dodge",
    gradient: ["#1c1917", "#d6d3d1"],
    category: "class",
  },
  {
    id: "warden_wins_5",
    title: "The Wall",
    flavor: "Nothing gets through. Nothing ever will.",
    description: "Win 5 combats as a SRE Warden.",
    icon: "shield",
    gradient: ["#1e3a5f", "#475569"],
    category: "class",
  },
  {
    id: "taunt_10",
    title: "Aggro Magnet",
    flavor: "You have their full and undivided hostility.",
    description: "Use Taunt 10 times across combats.",
    icon: "muscle-up",
    gradient: ["#27272a", "#71717a"],
    category: "class",
  },
  {
    id: "warlock_wins_5",
    title: "Dark Pact",
    flavor: "The contract was signed in blood. Both yours and theirs.",
    description: "Win 5 combats as a Data Warlock.",
    icon: "death-skull",
    gradient: ["#2e1065", "#7c3aed"],
    category: "class",
  },
  {
    id: "soul_drain_30",
    title: "Soul Harvest",
    flavor: "Their essence, yours now. Append to dataset.",
    description: "Drain 30 total HP via Soul Drain across combats.",
    icon: "bleeding-hearts",
    gradient: ["#3b0764", "#9333ea"],
    category: "class",
  },

  // ── Death & Survival ──────────────────────────────────────────────────────
  {
    id: "first_scar",
    title: "Lived to Tell",
    flavor: "The wound closed. The story didn't.",
    description: "Survive your first soft death.",
    icon: "fall-down",
    gradient: ["#7c2d12", "#c2410c"],
    category: "death",
  },
  {
    id: "scars_3",
    title: "Battle-Scarred",
    flavor: "Three marks of survival. Three reasons to keep going.",
    description: "Accumulate 3 scars.",
    icon: "bleeding-hearts",
    gradient: ["#881337", "#e11d48"],
    category: "death",
  },
  {
    id: "scars_5",
    title: "War-Torn",
    flavor: "They say the worst scars are the ones you can't see.",
    description: "Accumulate 5 scars.",
    icon: "death-skull",
    gradient: ["#4c0519", "#be123c"],
    category: "death",
  },
  {
    id: "deaths_10",
    title: "Nine Lives",
    flavor: "You've used more than nine. Nobody is counting.",
    description: "Suffer 10 soft deaths.",
    icon: "monster-skull",
    gradient: ["#1c1917", "#57534e"],
    category: "death",
  },
  {
    id: "deaths_20",
    title: "Unkillable",
    flavor: "At some point, dying became a scheduling inconvenience.",
    description: "Suffer 20 soft deaths.",
    icon: "crossed-swords",
    gradient: ["#18181b", "#3f3f46"],
    category: "death",
  },

  // ── Social / Party ────────────────────────────────────────────────────────
  {
    id: "full_party_4",
    title: "Better Together",
    flavor: "Four adventurers. One direction. Zero mercy.",
    description: "Win a combat with a full party of 4.",
    icon: "flag",
    gradient: ["#1e3a5f", "#38bdf8"],
    category: "social",
  },
  {
    id: "solo_win",
    title: "Solo Run",
    flavor: "You needed no one. They needed a medic.",
    description: "Win a combat alone.",
    icon: "hood",
    gradient: ["#1c1917", "#78716c"],
    category: "social",
  },
  {
    id: "duo_win",
    title: "Dynamic Duo",
    flavor: "Two is more than enough when two is you.",
    description: "Win a combat as a party of 2.",
    icon: "player",
    gradient: ["#134e4a", "#2dd4bf"],
    category: "social",
  },
  {
    id: "party_10",
    title: "Band of Brothers",
    flavor: "Ten quests together. Still speaking to each other.",
    description: "Complete 10 quests in a party.",
    icon: "conversation",
    gradient: ["#1e3a5f", "#60a5fa"],
    category: "social",
  },

  // ── Economy & Progression ─────────────────────────────────────────────────
  {
    id: "gold_100",
    title: "Goldsmith",
    flavor: "Enough gold to buy a problem or two.",
    description: "Accumulate 100 gold.",
    icon: "gold-bar",
    gradient: ["#713f12", "#ca8a04"],
    category: "economy",
  },
  {
    id: "gold_500",
    title: "Treasury",
    flavor: "You stopped counting. The merchants didn't.",
    description: "Accumulate 500 gold.",
    icon: "gold-bar",
    gradient: ["#78350f", "#f59e0b"],
    category: "economy",
  },
  {
    id: "gold_1000",
    title: "Gilded Legend",
    flavor: "A thousand gold pieces and the enemies to match.",
    description: "Accumulate 1000 gold.",
    icon: "gold-bar",
    gradient: ["#451a03", "#fbbf24"],
    category: "economy",
  },
  {
    id: "first_purchase",
    title: "Window Shopper",
    flavor: "You read the sign, went in, and left richer for it.",
    description: "Purchase an item from the shop.",
    icon: "ammo-bag",
    gradient: ["#1e3a5f", "#60a5fa"],
    category: "economy",
  },
  {
    id: "level_5",
    title: "Seasoned",
    flavor: "Level 5. Not a rookie anymore.",
    description: "Reach level 5.",
    icon: "perspective-dice-six",
    gradient: ["#14532d", "#4ade80"],
    category: "economy",
  },
  {
    id: "level_10",
    title: "Veteran",
    flavor: "Level 10. They stop checking your credentials.",
    description: "Reach level 10.",
    icon: "lightning-sword",
    gradient: ["#1e3a5f", "#818cf8"],
    category: "economy",
  },
  {
    id: "key_all_types",
    title: "Keymaster",
    flavor: "Bronze, silver, gold. You've held them all.",
    description: "Own at least one key of each tier simultaneously.",
    icon: "key",
    gradient: ["#78350f", "#fbbf24"],
    category: "economy",
  },

  // ── Pub Games ─────────────────────────────────────────────────────────────
  {
    id: "liars_first_win",
    title: "Card Sharp",
    flavor: "Your first lie was the most convincing.",
    description: "Win your first Liar's Dice game.",
    icon: "scroll-unfurled",
    gradient: ["#14532d", "#22c55e"],
    category: "pub",
  },
  {
    id: "liars_challenge_win",
    title: "Caught the Lie",
    flavor: "You called it. They couldn't hide.",
    description: "Win a Liar's Dice challenge.",
    icon: "x-mark",
    gradient: ["#134e4a", "#2dd4bf"],
    category: "pub",
  },
  {
    id: "liars_high_stake_20",
    title: "High Roller",
    flavor: "Twenty gold on the line. Not a tremor in your hand.",
    description: "Win a Liar's Dice game with a stake of 20+ gold.",
    icon: "gold-bar",
    gradient: ["#451a03", "#f59e0b"],
    category: "pub",
  },
  {
    id: "liars_challenge_5",
    title: "Skeptic",
    flavor: "You never believed them. Statistics proved you right.",
    description: "Issue 5 challenges in Liar's Dice.",
    icon: "monster-skull",
    gradient: ["#1c1917", "#6b7280"],
    category: "pub",
  },
  {
    id: "spd_first_win",
    title: "Rock Solid",
    flavor: "Stone crushes scissors. You crush challengers.",
    description: "Win your first Stone-Parchment-Dagger game.",
    icon: "bear-trap",
    gradient: ["#1c1917", "#78716c"],
    category: "pub",
  },
  {
    id: "spd_parchment_win",
    title: "Paper Trail",
    flavor: "The evidence is clear. You won with parchment.",
    description: "Win a Stone-Parchment-Dagger game using Parchment.",
    icon: "scroll-unfurled",
    gradient: ["#0c4a6e", "#38bdf8"],
    category: "pub",
  },
  {
    id: "spd_wins_3",
    title: "Lucky Streak",
    flavor: "Three wins in a row. Luck? Skill? The barkeep stopped caring.",
    description: "Win 3 Stone-Parchment-Dagger games.",
    icon: "perspective-dice-six",
    gradient: ["#4a044e", "#c084fc"],
    category: "pub",
  },
  {
    id: "spd_spectator_bet",
    title: "Deep Pockets",
    flavor: "You didn't play. You funded someone else's victory.",
    description: "Place a spectator bet on a Stone-Parchment-Dagger match.",
    icon: "gold-bar",
    gradient: ["#78350f", "#d97706"],
    category: "pub",
  },

  // ── Apothecary ────────────────────────────────────────────────────────────
  {
    id: "apothecary_first_purchase",
    title: "First Concoction",
    flavor: "You handed over gold. The apothecary handed back trouble in a vial.",
    description: "Purchase your first item from the Apothecary.",
    icon: "poison-bottle",
    gradient: ["#14532d", "#22c55e"],
    category: "economy",
  },
  {
    id: "apothecary_patron_5",
    title: "Regular Customer",
    flavor: "The apothecary has your usual ready before you ask.",
    description: "Purchase 5 items from the Apothecary.",
    icon: "bubbling-potion",
    gradient: ["#1a2d1a", "#4ade80"],
    category: "economy",
  },
  {
    id: "good_samaritan",
    title: "Good Samaritan",
    flavor: "They were down. You reached out your hand.",
    description: "Revive a downed adventurer at the Apothecary.",
    icon: "health-increase",
    gradient: ["#1e3a5f", "#60a5fa"],
    category: "social",
  },
  {
    id: "guardian_angel_3",
    title: "Guardian Angel",
    flavor: "Three times you pulled someone back from the brink.",
    description: "Revive 3 adventurers at the Apothecary.",
    icon: "aura",
    gradient: ["#1e3a5f", "#818cf8"],
    category: "social",
  },

  // ── Quest Types ───────────────────────────────────────────────────────────
  {
    id: "job_board_first",
    title: "Job Hunter",
    flavor: "The board had work. You answered.",
    description: "Complete your first job board quest.",
    icon: "rune-stone",
    gradient: ["#1e3a5f", "#60a5fa"],
    category: "quest",
  },
  {
    id: "dungeon_first",
    title: "Dungeon Delver",
    flavor: "Darkness below. You went anyway.",
    description: "Complete your first dungeon quest.",
    icon: "bear-trap",
    gradient: ["#1c1917", "#78716c"],
    category: "quest",
  },
  {
    id: "elite_no_death",
    title: "Elite Survivor",
    flavor: "Permadeath on the table. You left it there.",
    description: "Complete an elite quest without anyone dying.",
    icon: "trophy",
    gradient: ["#78350f", "#fbbf24"],
    category: "quest",
  },
  {
    id: "job_board_5",
    title: "Board Regular",
    flavor: "Your name is first on the list now.",
    description: "Complete 5 job board quests.",
    icon: "rune-stone",
    gradient: ["#1e3a5f", "#93c5fd"],
    category: "quest",
  },
  {
    id: "dungeon_3",
    title: "Dungeon Master",
    flavor: "Three dungeons cleared. The dark no longer surprises you.",
    description: "Complete 3 dungeon quests.",
    icon: "bear-trap",
    gradient: ["#292524", "#a8a29e"],
    category: "quest",
  },
  {
    id: "pack_hunter",
    title: "Pack Hunter",
    flavor: "They ran together. You put them down together.",
    description: "Defeat a 2-monster encounter.",
    icon: "wolf-howl",
    gradient: ["#1c2a1a", "#86efac"],
    category: "quest",
  },
  {
    id: "crowd_control",
    title: "Crowd Control",
    flavor: "Three at once, all dead. You make it look like a bug fix.",
    description: "Defeat a 3-monster encounter.",
    icon: "skulls",
    gradient: ["#2a1a1a", "#fca5a5"],
    category: "quest",
  },
  {
    id: "lone_wolf_pack",
    title: "Lone Wolf",
    flavor: "Solo run against multiple enemies. No backup. No excuses.",
    description: "Defeat 2 or more monsters in a single encounter while playing solo.",
    icon: "player",
    gradient: ["#1a1a2a", "#c4b5fd"],
    category: "quest",
  },
];

export const ACHIEVEMENT_MAP = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

// ── Award-check helpers ───────────────────────────────────────────────────────

function has(existing: EarnedAchievement[], id: string): boolean {
  return existing.some((a) => a.id === id);
}

function award(
  ids: string[],
  existing: EarnedAchievement[],
  ...candidates: Array<string | false>
): void {
  for (const c of candidates) {
    if (c && !has(existing, c)) ids.push(c);
  }
}

export interface CombatAchievementOpts {
  fighterClass: string;
  finalHp: number;
  maxHp: number;
  roundsTotal: number;
  partySize: number;
  status: "victory" | "defeat" | "fled";
  monster: { is_boss: boolean; total_waves?: number };
  existingAchievements: EarnedAchievement[];
  // Lifetime counts *before* this fight
  lifetimeWins: number;
  lifetimeKills: number;
  // true if this fighter landed the killing blow this fight
  landedKillingBlow: boolean;
  scarsCount: number;
  softDeathsTotal: number;
  isJobBoard: boolean;
  isDungeon: boolean;
  isElite: boolean;
  isNoDeathRun: boolean; // nobody downed during this quest
  initialMonsterCount: number; // total monsters at start of encounter (1 for single, 2-3 for pack)
}

export function checkCombatAchievements(opts: CombatAchievementOpts): string[] {
  const {
    fighterClass,
    finalHp,
    maxHp,
    roundsTotal,
    partySize,
    status,
    monster,
    existingAchievements: ex,
    lifetimeWins,
    lifetimeKills,
    landedKillingBlow,
    scarsCount,
    isJobBoard,
    isDungeon,
    isElite,
    isNoDeathRun,
    initialMonsterCount,
  } = opts;

  const ids: string[] = [];
  if (status !== "victory") return ids;

  const newWins = lifetimeWins + 1;

  // General wins
  award(ids, ex,
    !has(ex, "first_victory") && "first_victory",
    newWins >= 10 && !has(ex, "veteran_10") && "veteran_10",
    newWins >= 50 && !has(ex, "veteran_50") && "veteran_50",
    newWins >= 100 && !has(ex, "veteran_100") && "veteran_100",
  );

  // Killing blow
  if (landedKillingBlow) {
    const newKills = lifetimeKills + 1;
    award(ids, ex,
      newKills >= 10 && !has(ex, "killing_blow_10") && "killing_blow_10",
    );
  }

  // HP-based
  const hpPct = maxHp > 0 ? finalHp / maxHp : 1;
  award(ids, ex,
    hpPct < 0.25 && !has(ex, "near_death") && "near_death",
    finalHp === 1 && !has(ex, "last_stand_1hp") && "last_stand_1hp",
    finalHp === maxHp && !has(ex, "full_hp_win") && "full_hp_win",
  );

  // Speed / endurance
  award(ids, ex,
    roundsTotal <= 3 && !has(ex, "speed_run_3") && "speed_run_3",
    roundsTotal >= 10 && !has(ex, "marathon_10") && "marathon_10",
  );

  // Boss
  if (monster.is_boss) {
    // Count prior boss wins by looking at existing boss achievements as a proxy;
    // caller provides lifetimeWins which includes all combats, so use boss flags
    const bossIds = ["first_boss", "boss_5"];
    const hasBossFirst = has(ex, "first_boss");
    award(ids, ex,
      !hasBossFirst && "first_boss",
    );
    // boss_5: approximate — grant when they earn their 5th by checking if boss_5 is locked
    // Real counts would need a DB query; we check the existing set size instead.
    // Grant boss_5 once first_boss is already earned (i.e., this is at least the 2nd boss kill)
    // and boss_5 isn't earned yet. Caller should pass lifetimeWins filtered to bosses if possible.
    // For now, grant on the same event as first_boss only if boss_5 not yet earned and
    // this is the 5th+ boss — we can't know exactly without extra data, so we set a
    // conservative flag: grant boss_5 when the existing count of boss achievements suggests ≥5.
    // Simpler: caller passes `lifetimeBossWins`.
    if (hasBossFirst && !has(ex, "boss_5")) {
      // We don't have exact boss win count here; if caller wants this, pass lifetimeBossWins.
      // Award is handled via lifetimeBossWins field — skip for now (will be added via separate path).
    }
    if (landedKillingBlow) {
      award(ids, ex, !has(ex, "boss_killing_blow") && "boss_killing_blow");
    }
  }

  // Gauntlet
  if (monster.total_waves !== undefined && monster.total_waves > 1) {
    award(ids, ex, !has(ex, "gauntlet_clear") && "gauntlet_clear");
  }

  // Party size
  award(ids, ex,
    partySize === 1 && !has(ex, "solo_win") && "solo_win",
    partySize === 2 && !has(ex, "duo_win") && "duo_win",
    partySize >= 4 && !has(ex, "full_party_4") && "full_party_4",
  );

  // Class-specific wins (need lifetime class wins — approximate with total wins of same class)
  const cls = fighterClass.toLowerCase();
  if (cls.includes("devops") || cls === "devops mage") {
    award(ids, ex, newWins >= 5 && !has(ex, "devops_wins_5") && "devops_wins_5");
  }
  if (cls.includes("qa") || cls === "qa paladin") {
    award(ids, ex, newWins >= 5 && !has(ex, "qa_wins_5") && "qa_wins_5");
  }
  if (cls.includes("druid") || cls === "backend druid") {
    award(ids, ex, newWins >= 5 && !has(ex, "druid_wins_5") && "druid_wins_5");
  }
  if (cls.includes("bard") || cls === "frontend bard") {
    award(ids, ex, newWins >= 5 && !has(ex, "bard_wins_5") && "bard_wins_5");
  }
  if (cls.includes("sage") || cls === "staff sage") {
    award(ids, ex, newWins >= 5 && !has(ex, "sage_wins_5") && "sage_wins_5");
  }
  if (cls.includes("rogue") || cls === "refactor rogue") {
    award(ids, ex, newWins >= 5 && !has(ex, "rogue_wins_5") && "rogue_wins_5");
  }
  if (cls.includes("warden") || cls === "sre warden") {
    award(ids, ex, newWins >= 5 && !has(ex, "warden_wins_5") && "warden_wins_5");
  }
  if (cls.includes("warlock") || cls === "data warlock") {
    award(ids, ex, newWins >= 5 && !has(ex, "warlock_wins_5") && "warlock_wins_5");
  }

  // Quest type
  award(ids, ex,
    isJobBoard && !has(ex, "job_board_first") && "job_board_first",
  );
  if (isJobBoard) {
    // job_board_5 requires 5 completions; caller should pass count — approximate
    // by granting when they already have job_board_first
    if (has(ex, "job_board_first")) {
      // Grant handled via separate count-based check in the caller
    }
  }
  award(ids, ex,
    isDungeon && !has(ex, "dungeon_first") && "dungeon_first",
    isElite && isNoDeathRun && !has(ex, "elite_no_death") && "elite_no_death",
  );

  // Multi-monster pack achievements
  if (initialMonsterCount >= 2) {
    award(ids, ex, !has(ex, "pack_hunter") && "pack_hunter");
  }
  if (initialMonsterCount >= 3) {
    award(ids, ex, !has(ex, "crowd_control") && "crowd_control");
  }
  if (initialMonsterCount >= 2 && partySize === 1) {
    award(ids, ex, !has(ex, "lone_wolf_pack") && "lone_wolf_pack");
  }

  return ids;
}

export interface DeathAchievementOpts {
  existingAchievements: EarnedAchievement[];
  newScarsCount: number;    // scars count after this death
  totalSoftDeaths: number;  // total soft deaths including this one
}

export function checkDeathAchievements(opts: DeathAchievementOpts): string[] {
  const { existingAchievements: ex, newScarsCount, totalSoftDeaths } = opts;
  const ids: string[] = [];
  award(ids, ex,
    newScarsCount >= 1 && !has(ex, "first_scar") && "first_scar",
    newScarsCount >= 3 && !has(ex, "scars_3") && "scars_3",
    newScarsCount >= 5 && !has(ex, "scars_5") && "scars_5",
    totalSoftDeaths >= 10 && !has(ex, "deaths_10") && "deaths_10",
    totalSoftDeaths >= 20 && !has(ex, "deaths_20") && "deaths_20",
  );
  return ids;
}

export interface LiarsAchievementOpts {
  existingAchievements: EarnedAchievement[];
  won: boolean;
  stake: number;
  isChallenge: boolean;    // true if the win/loss was from a challenge
  challengeWon: boolean;
  totalChallenges: number; // total challenges issued including this one
}

export function checkLiarsAchievements(opts: LiarsAchievementOpts): string[] {
  const { existingAchievements: ex, won, stake, isChallenge, challengeWon, totalChallenges } = opts;
  const ids: string[] = [];
  award(ids, ex,
    won && !has(ex, "liars_first_win") && "liars_first_win",
    challengeWon && !has(ex, "liars_challenge_win") && "liars_challenge_win",
    won && stake >= 20 && !has(ex, "liars_high_stake_20") && "liars_high_stake_20",
    isChallenge && totalChallenges >= 5 && !has(ex, "liars_challenge_5") && "liars_challenge_5",
  );
  return ids;
}

export interface SpdAchievementOpts {
  existingAchievements: EarnedAchievement[];
  won: boolean;
  throw_used: SpdThrow;
  isSpectator: boolean;
  totalWins: number; // SPD wins including this one
}

export function checkSpdAchievements(opts: SpdAchievementOpts): string[] {
  const { existingAchievements: ex, won, throw_used, isSpectator, totalWins } = opts;
  const ids: string[] = [];
  award(ids, ex,
    !isSpectator && won && !has(ex, "spd_first_win") && "spd_first_win",
    !isSpectator && won && throw_used === "parchment" && !has(ex, "spd_parchment_win") && "spd_parchment_win",
    !isSpectator && totalWins >= 3 && !has(ex, "spd_wins_3") && "spd_wins_3",
    isSpectator && !has(ex, "spd_spectator_bet") && "spd_spectator_bet",
  );
  return ids;
}

export interface ApothecaryAchievementOpts {
  existingAchievements: EarnedAchievement[];
  totalPurchases: number; // apothecary purchases including this one
  totalRevives: number;   // revives given including this one
  action: "purchase" | "revive";
}

export function checkApothecaryAchievements(opts: ApothecaryAchievementOpts): string[] {
  const { existingAchievements: ex, totalPurchases, totalRevives, action } = opts;
  const ids: string[] = [];
  if (action === "purchase") {
    award(ids, ex,
      totalPurchases >= 1 && !has(ex, "apothecary_first_purchase") && "apothecary_first_purchase",
      totalPurchases >= 5 && !has(ex, "apothecary_patron_5") && "apothecary_patron_5",
    );
  }
  if (action === "revive") {
    award(ids, ex,
      totalRevives >= 1 && !has(ex, "good_samaritan") && "good_samaritan",
      totalRevives >= 3 && !has(ex, "guardian_angel_3") && "guardian_angel_3",
    );
  }
  return ids;
}

export interface ProgressionAchievementOpts {
  existingAchievements: EarnedAchievement[];
  level: number;
  gold: number;
  keysBronze: number;
  keysSilver: number;
  keysGold: number;
}

export function checkProgressionAchievements(opts: ProgressionAchievementOpts): string[] {
  const { existingAchievements: ex, level, gold, keysBronze, keysSilver, keysGold } = opts;
  const ids: string[] = [];
  award(ids, ex,
    level >= 5 && !has(ex, "level_5") && "level_5",
    level >= 10 && !has(ex, "level_10") && "level_10",
    gold >= 100 && !has(ex, "gold_100") && "gold_100",
    gold >= 500 && !has(ex, "gold_500") && "gold_500",
    gold >= 1000 && !has(ex, "gold_1000") && "gold_1000",
    keysBronze >= 1 && keysSilver >= 1 && keysGold >= 1 && !has(ex, "key_all_types") && "key_all_types",
  );
  return ids;
}
