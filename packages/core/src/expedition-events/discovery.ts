// "Discovery" events — the party stumbles across an object or place.
// Pass 2: 15 events (Pass 1: 3, +12 added) to hit the design doc target of ~15.

import type { ExpeditionEvent } from "./types";

export const DISCOVERY_EVENTS: ExpeditionEvent[] = [
  {
    id: "disc_broken_vending",
    setup: "discovery",
    tone: "weird",
    risk: "safe",
    theme: "curiosity",
    title: "A Broken Vending Machine",
    body:
      "A glass-fronted machine, half-buried in vines, hums faintly. The label peeled long ago but you can " +
      "still make out half a word: '...SNACKS'. The coin slot looks newly polished.",
    branches: [
      {
        id: "insert_coin",
        label: "Insert a coin (5g)",
        outcomes: [
          {
            weight: 60,
            text: "Ka-thunk. Out tumbles something wrapped in foil that tastes like home cooking.",
            effects: { gold: -5, hp: 10 },
          },
          {
            weight: 30,
            text: "Ka-thunk. A handful of coins drops out instead. You feel the universe blink.",
            effects: { gold: 10 },
          },
          {
            weight: 10,
            text: "It eats your coin and emits a tiny mournful sigh.",
            effects: { gold: -5 },
          },
        ],
      },
      {
        id: "kick_it",
        label: "Kick it",
        outcomes: [
          {
            weight: 50,
            text: "Gold cascades out for a full second. The machine groans, then dies politely.",
            effects: { gold: 18 },
          },
          {
            weight: 50,
            text: "Your foot hurts. The machine does not.",
            effects: { hp: -3 },
          },
        ],
      },
      {
        id: "leave_it",
        label: "Leave it alone",
        outcomes: [
          {
            weight: 100,
            text: "It keeps humming as you go. Some mysteries earn their dignity.",
          },
        ],
      },
    ],
  },

  {
    id: "disc_ancient_terminal",
    setup: "discovery",
    tone: "weird",
    risk: "mixed",
    theme: "curiosity",
    title: "An Ancient Terminal",
    body:
      "A blinking cursor on a green screen, set into a stone obelisk. The keyboard layout is wrong " +
      "but recognizably one. A login prompt waits.",
    branches: [
      {
        id: "type_admin",
        label: "Try 'admin / admin'",
        outcomes: [
          {
            weight: 40,
            text: "It works. You're in. The system is grateful and shares a forgotten map of a treasure cache.",
            effects: { gold: 20, xp: 12 },
          },
          {
            weight: 40,
            text: "ACCESS DENIED. You feel mildly judged.",
          },
          {
            weight: 20,
            text: "Alarms. Smoke. The obelisk emits a static jolt before going quiet.",
            effects: { hp: -8 },
          },
        ],
      },
      {
        id: "unplug_it",
        label: "Unplug it",
        outcomes: [
          {
            weight: 70,
            text: "The cable was hooked to a hidden cache of components — useful trade goods.",
            effects: { gold: 9, item: "🔧 Scrap Bundle" },
          },
          {
            weight: 30,
            text: "Nothing happens. You feel briefly relieved.",
          },
        ],
      },
      {
        id: "walk_past",
        label: "Walk past",
        outcomes: [
          {
            weight: 100,
            text: "It keeps blinking. You don't look back.",
          },
        ],
      },
    ],
  },

  {
    id: "disc_weeping_shrine",
    setup: "discovery",
    tone: "hopeful",
    risk: "safe",
    theme: "mercy",
    title: "A Weeping Shrine",
    body:
      "Carved stones in a half-circle. Water beads on the figure at the center like the rock itself is grieving. " +
      "A small alms-bowl sits at its feet.",
    branches: [
      {
        id: "make_offering",
        label: "Leave gold (8g)",
        outcomes: [
          {
            weight: 70,
            text: "Warmth pools in your chest. The road ahead feels just a little kinder.",
            effects: { gold: -8, hp: 14, mana: 6 },
          },
          {
            weight: 30,
            text: "Nothing happens, but you sleep better tonight all the same.",
            effects: { gold: -8, hp: 6 },
          },
        ],
      },
      {
        id: "pray",
        label: "Just pray",
        outcomes: [
          {
            weight: 60,
            text: "A small blessing. You feel your magic stir.",
            effects: { mana: 8 },
          },
          {
            weight: 40,
            text: "Silence. But sometimes silence is enough.",
          },
        ],
      },
      {
        id: "take_alms",
        label: "Take from the bowl",
        outcomes: [
          {
            weight: 50,
            text: "A few coins, easily got. You feel something watching you go.",
            effects: { gold: 6, effect: "cursed" },
          },
          {
            weight: 50,
            text: "The bowl is sticky and your hand comes away bleeding without you knowing why.",
            effects: { gold: 6, hp: -6 },
          },
        ],
      },
    ],
  },

  {
    id: "disc_cursed_cache",
    setup: "discovery",
    tone: "grim",
    risk: "dangerous",
    theme: "greed",
    title: "A Cache, Marked CURSED",
    body:
      "A loose flagstone hides a tin box. Across the top, in white paint and a hurried hand: " +
      "'CURSED. DO NOT.' Inside, you can hear coins shift.",
    branches: [
      {
        id: "take_it",
        label: "Take the coin",
        outcomes: [
          {
            weight: 50,
            text: "It's a lot of coin. The curse is real and small — you'll feel watched for a long time.",
            effects: { gold: 30, effect: "cursed" },
          },
          {
            weight: 30,
            text: "Coin. No curse. Or no curse you can name yet.",
            effects: { gold: 25 },
          },
          {
            weight: 20,
            text: "The box shrieks open and the coins bite. You bleed for hours.",
            effects: { hp: -14 },
          },
        ],
      },
      {
        id: "burn_it",
        label: "Burn it where it lies",
        outcomes: [
          {
            weight: 70,
            text: "The box burns clean. You feel a small, righteous warmth.",
            effects: { xp: 10 },
          },
          {
            weight: 30,
            text: "The smoke gets in your throat for a day. Worth it. You think.",
            effects: { hp: -3, xp: 6 },
          },
        ],
      },
      {
        id: "leave_alone",
        label: "Replace the stone",
        outcomes: [
          {
            weight: 100,
            text: "Some treasures earn their warnings. The road continues.",
          },
        ],
      },
    ],
  },

  {
    id: "disc_locked_datatomb",
    setup: "discovery",
    tone: "weird",
    risk: "mixed",
    theme: "curiosity",
    title: "A Locked Datatomb",
    body:
      "A waist-high cube of dark glass squats in a clearing. A keypad blinks slow blue. Etched on one face: " +
      "FROM THIS POINT, READ-ONLY.",
    branches: [
      {
        id: "pick_lock",
        label: "Pick the lock",
        outcomes: [
          {
            weight: 40,
            text: "Click. The cube hands you a small scroll of useful tradecraft.",
            effects: { item: "📜 Scroll", xp: 14 },
          },
          {
            weight: 40,
            text: "Click. The cube sighs and gives you nothing but the satisfaction.",
            effects: { xp: 6 },
          },
          {
            weight: 20,
            text: "The cube politely electrocutes you and re-locks itself. You smell faintly of ozone.",
            effects: { hp: -7 },
          },
        ],
      },
      {
        id: "smash_it",
        label: "Smash it",
        outcomes: [
          {
            weight: 30,
            text: "Bits of useful component scatter. You collect what you can carry.",
            effects: { item: "🔧 Scrap Bundle", hp: -4 },
          },
          {
            weight: 70,
            text: "The cube is harder than your hammer. Your arm will remember this.",
            effects: { hp: -8 },
          },
        ],
      },
      {
        id: "walk_past",
        label: "Walk past",
        outcomes: [
          {
            weight: 100,
            text: "The keypad blinks slowly on. Someone else's problem.",
          },
        ],
      },
    ],
  },

  {
    id: "disc_derelict_dropship",
    setup: "discovery",
    tone: "weird",
    risk: "mixed",
    theme: "curiosity",
    title: "A Derelict Dropship",
    body:
      "Half-buried in the hillside: a wrecked dropship, its hull peeled like fruit. The cockpit door " +
      "is jammed open six inches. Something inside still beeps.",
    branches: [
      {
        id: "salvage",
        label: "Salvage the cockpit",
        outcomes: [
          {
            weight: 50,
            text: "You find a working power cell and a working sandwich. Both are useful.",
            effects: { item: "🔧 Scrap Bundle", hp: 6 },
          },
          {
            weight: 30,
            text: "Just scrap and dust. You break even on the climb back out.",
            effects: { gold: 5 },
          },
          {
            weight: 20,
            text: "The hull shifts on you. You crawl out lighter and slower.",
            effects: { hp: -10 },
          },
        ],
      },
      {
        id: "trigger_beacon",
        label: "Set off the beacon",
        outcomes: [
          {
            weight: 60,
            text: "Hours later, a scavenger crew pays you a finder's fee.",
            effects: { gold: 18 },
          },
          {
            weight: 40,
            text: "The beacon screams for an hour. Nothing comes. You leave with a headache.",
            effects: { mana: -3 },
          },
        ],
      },
      {
        id: "leave_alone",
        label: "Leave it for the rust",
        outcomes: [
          {
            weight: 100,
            text: "The ship keeps beeping behind you for a long time.",
          },
        ],
      },
    ],
  },

  {
    id: "disc_strange_mushroom",
    setup: "discovery",
    tone: "weird",
    risk: "mixed",
    theme: "curiosity",
    title: "A Strange Mushroom",
    body:
      "Pulsing softly at the base of a hollow log: a finger-thick mushroom cap glowing pink. It changes " +
      "color when you breathe on it.",
    branches: [
      {
        id: "eat_it",
        label: "Eat it",
        outcomes: [
          {
            weight: 30,
            text: "Mana floods you. You see three steps ahead of yourself for an hour.",
            effects: { mana: 16, xp: 8 },
          },
          {
            weight: 40,
            text: "Mild euphoria. Mild stomachache. You'll live.",
            effects: { hp: -3, mana: 4 },
          },
          {
            weight: 30,
            text: "You hallucinate for an hour and wake up in a different patch of grass.",
            effects: { hp: -8, mana: 6 },
          },
        ],
      },
      {
        id: "harvest",
        label: "Harvest carefully",
        outcomes: [
          {
            weight: 80,
            text: "You bag a fistful. They'll fetch a fair price later.",
            effects: { gold: 14 },
          },
          {
            weight: 20,
            text: "They dissolve in your hand the second you cut them. Mushrooms are like that.",
          },
        ],
      },
      {
        id: "leave_them",
        label: "Leave them growing",
        outcomes: [
          {
            weight: 100,
            text: "The mushroom resumes its pink-cycle without you. Good for it.",
          },
        ],
      },
    ],
  },

  {
    id: "disc_hidden_spring",
    setup: "discovery",
    tone: "hopeful",
    risk: "safe",
    theme: "mercy",
    title: "A Hidden Spring",
    body:
      "Behind a fallen tree, a small pool catches the sun. The water is unreasonably clear. A small " +
      "mossy cup sits on the rim, like an offering or a hint.",
    branches: [
      {
        id: "drink",
        label: "Drink deeply",
        outcomes: [
          {
            weight: 80,
            text: "The water hums down through you. You feel mended in three small places.",
            effects: { hp: 16, mana: 6 },
          },
          {
            weight: 20,
            text: "Cool, clean, unremarkable. But sometimes that's all you need.",
            effects: { hp: 6 },
          },
        ],
      },
      {
        id: "fill_skin",
        label: "Fill your waterskin",
        outcomes: [
          {
            weight: 100,
            text: "A few cool sips for the road. Small things matter.",
            effects: { hp: 4 },
          },
        ],
      },
      {
        id: "leave_offering",
        label: "Leave a coin (3g)",
        outcomes: [
          {
            weight: 80,
            text: "The pool ripples once for no reason. You feel a small protection settle over you.",
            effects: { gold: -3, hp: 10, mana: 8 },
          },
          {
            weight: 20,
            text: "The coin sinks. The spring does what springs do.",
            effects: { gold: -3 },
          },
        ],
      },
    ],
  },

  {
    id: "disc_old_milestone",
    setup: "discovery",
    tone: "hopeful",
    risk: "safe",
    theme: "curiosity",
    title: "An Old Milestone",
    body:
      "Half-sunk in the bank: a weathered milestone. The carving is half-erased but you can make out: " +
      "'... 14 leagues to ... if traveler reads, may they ...'",
    branches: [
      {
        id: "read_aloud",
        label: "Read it aloud",
        outcomes: [
          {
            weight: 70,
            text: "A small warmth curls through you. The road ahead feels a little shorter.",
            effects: { xp: 10, mana: 4 },
          },
          {
            weight: 30,
            text: "Nothing happens, but a bird lands on your shoulder briefly. That counts.",
            effects: { xp: 4 },
          },
        ],
      },
      {
        id: "rub_for_charcoal",
        label: "Take a rubbing",
        outcomes: [
          {
            weight: 80,
            text: "The rubbing is a passable trade good for a scholar. You bag it.",
            effects: { item: "📜 Scroll" },
          },
          {
            weight: 20,
            text: "You smear it. The stone forgives you.",
          },
        ],
      },
      {
        id: "walk_past",
        label: "Walk past",
        outcomes: [
          {
            weight: 100,
            text: "It keeps its half-secret. The road continues.",
          },
        ],
      },
    ],
  },

  {
    id: "disc_severed_signpost",
    setup: "discovery",
    tone: "grim",
    risk: "mixed",
    theme: "fear",
    title: "A Severed Signpost",
    body:
      "A signpost lies in the mud, axe-marks across its face. Two arrows: one points up the safer-looking " +
      "ravine, one points down toward a smoking valley. You cannot tell which arrow goes where.",
    branches: [
      {
        id: "trust_higher",
        label: "Take the ravine",
        outcomes: [
          {
            weight: 70,
            text: "It is harder going but you arrive ahead of schedule and ahead of trouble.",
            effects: { xp: 10 },
          },
          {
            weight: 30,
            text: "The detour costs you a day and a sprain.",
            effects: { hp: -6 },
          },
        ],
      },
      {
        id: "trust_lower",
        label: "Take the valley",
        outcomes: [
          {
            weight: 40,
            text: "The smoke is a controlled burn. You find an abandoned camp with usable coin.",
            effects: { gold: 16 },
          },
          {
            weight: 60,
            text: "The smoke is not controlled. You leave coughing, lighter, slightly singed.",
            effects: { hp: -9, gold: -4 },
          },
        ],
      },
      {
        id: "set_it_right",
        label: "Stand it back up",
        outcomes: [
          {
            weight: 100,
            text: "You make a guess. The next traveler might thank you, or curse you. The road forgives both.",
            effects: { xp: 4 },
          },
        ],
      },
    ],
  },

  {
    id: "disc_buried_chest",
    setup: "discovery",
    tone: "wry",
    risk: "mixed",
    theme: "greed",
    title: "A Buried Chest",
    body:
      "The corner of a strongbox pokes from soft dirt under a stunted tree. The lock is intact. You feel " +
      "very specifically watched.",
    branches: [
      {
        id: "dig_it_up",
        label: "Dig it up",
        outcomes: [
          {
            weight: 50,
            text: "Coin and a trinket. Decent haul, no strings.",
            effects: { gold: 22, item: "🟢 Trinket" },
          },
          {
            weight: 30,
            text: "Coin only. The trinket spot is empty. Someone else got here first.",
            effects: { gold: 12 },
          },
          {
            weight: 20,
            text: "Snap-trap. Your wrist will throb for hours.",
            effects: { hp: -8, gold: 8 },
          },
        ],
      },
      {
        id: "pick_lock_in_place",
        label: "Pick the lock in place",
        outcomes: [
          {
            weight: 60,
            text: "Patient work. You pocket what's inside and re-bury the lid.",
            effects: { gold: 18 },
          },
          {
            weight: 40,
            text: "The lock wins. The chest stays as you found it.",
          },
        ],
      },
      {
        id: "leave_it",
        label: "Leave it for the soil",
        outcomes: [
          {
            weight: 100,
            text: "The tree sighs. The road goes on.",
          },
        ],
      },
    ],
  },

  {
    id: "disc_haunted_workbench",
    setup: "discovery",
    tone: "weird",
    risk: "mixed",
    theme: "curiosity",
    title: "A Haunted Workbench",
    body:
      "A workbench in a clearing. Tools laid neatly. Sawdust drifts where there is no breeze. A half-" +
      "finished chair has been waiting for you, specifically, for a long time.",
    branches: [
      {
        id: "finish_chair",
        label: "Finish the chair",
        outcomes: [
          {
            weight: 70,
            text: "When you set the last peg, the bench exhales. A small craftsman's blessing settles in.",
            effects: { mana: 10, xp: 14 },
          },
          {
            weight: 30,
            text: "It collapses the moment you stand. The bench was unimpressed.",
            effects: { xp: 4 },
          },
        ],
      },
      {
        id: "take_tool",
        label: "Take a tool",
        outcomes: [
          {
            weight: 60,
            text: "A solid plane. It'll fetch a price, or save you one.",
            effects: { item: "🔧 Spare Parts" },
          },
          {
            weight: 40,
            text: "The tool weighs more than seems fair. You leave it.",
            effects: { hp: -3 },
          },
        ],
      },
      {
        id: "walk_past",
        label: "Walk past",
        outcomes: [
          {
            weight: 100,
            text: "Sawdust settles. Some workshops should be left to finish themselves.",
          },
        ],
      },
    ],
  },

  {
    id: "disc_starfall_crater",
    setup: "discovery",
    tone: "weird",
    risk: "dangerous",
    theme: "curiosity",
    title: "A Starfall Crater",
    body:
      "A shallow crater steams faintly. At its center: a fist-sized lump of metal that no map has a name " +
      "for. It hums when you step close.",
    branches: [
      {
        id: "pocket_it",
        label: "Pocket it",
        outcomes: [
          {
            weight: 40,
            text: "It cools to room temperature against your hip. You'll find a use for it.",
            effects: { item: "🔧 Scrap Bundle", xp: 12 },
          },
          {
            weight: 30,
            text: "It cools, then quietly disintegrates. You smell ozone.",
          },
          {
            weight: 30,
            text: "It does not cool. Your pocket burns through. You smell hair.",
            effects: { hp: -10 },
          },
        ],
      },
      {
        id: "study_it",
        label: "Study it carefully",
        outcomes: [
          {
            weight: 80,
            text: "You take notes a sage would pay for. You'll cash them in later.",
            effects: { gold: 14, xp: 10 },
          },
          {
            weight: 20,
            text: "Your notes catch on a draft and burn. Studying is hard.",
          },
        ],
      },
      {
        id: "leave_it",
        label: "Leave it where it fell",
        outcomes: [
          {
            weight: 100,
            text: "The crater hums on without you. The sky knows.",
          },
        ],
      },
    ],
  },

  {
    id: "disc_glowing_well",
    setup: "discovery",
    tone: "weird",
    risk: "mixed",
    theme: "curiosity",
    title: "A Glowing Well",
    body:
      "A circle of stones around a hole in the ground. Down inside: a faint blue glow that pulses like a " +
      "tired heart. A rope is tied off at the rim but rotten halfway down.",
    branches: [
      {
        id: "climb_down",
        label: "Climb down",
        outcomes: [
          {
            weight: 40,
            text: "At the bottom: a stash of useful gear someone left for safekeeping a long time ago.",
            effects: { gold: 20, item: "🔧 Spare Parts" },
          },
          {
            weight: 30,
            text: "Just glowing fungus. Pretty, but worthless.",
          },
          {
            weight: 30,
            text: "The rope gives. You fall the last six feet and limp out emptier than you went in.",
            effects: { hp: -10 },
          },
        ],
      },
      {
        id: "lower_lantern",
        label: "Lower a lantern first",
        outcomes: [
          {
            weight: 80,
            text: "You spot what you need and snag it with a hook. Patient hands, full pockets.",
            effects: { gold: 14 },
          },
          {
            weight: 20,
            text: "The glow is just glow. You waste a candle and walk on.",
          },
        ],
      },
      {
        id: "walk_past",
        label: "Walk past",
        outcomes: [
          {
            weight: 100,
            text: "The glow keeps its rhythm. Some wells are just for looking.",
          },
        ],
      },
    ],
  },

  {
    id: "disc_old_battlefield",
    setup: "discovery",
    tone: "grim",
    risk: "mixed",
    theme: "mercy",
    title: "An Old Battlefield",
    body:
      "Crows in the grass. Iron half-eaten by weather. Bones picked clean and sun-bleached. Somewhere " +
      "in the underbrush a flag flutters that no one alive remembers fighting for.",
    branches: [
      {
        id: "loot_carefully",
        label: "Pick the dead",
        outcomes: [
          {
            weight: 50,
            text: "A buckle, a half-coin, a sturdy strap. Practical loot for practical needs.",
            effects: { gold: 14, item: "🔧 Spare Parts" },
          },
          {
            weight: 30,
            text: "A pouch of coin under a ribcage. Nobody complains.",
            effects: { gold: 18, effect: "guilt" },
          },
          {
            weight: 20,
            text: "An old trap, still primed. Your hand will not forget.",
            effects: { hp: -8 },
          },
        ],
      },
      {
        id: "bury_one",
        label: "Bury what you can",
        outcomes: [
          {
            weight: 100,
            text: "A few stones piled, a few words muttered. You leave lighter than you arrived.",
            effects: { xp: 18 },
          },
        ],
      },
      {
        id: "walk_through",
        label: "Walk straight through",
        outcomes: [
          {
            weight: 100,
            text: "The crows go quiet for the length of your stride. They start again when you're gone.",
          },
        ],
      },
    ],
  },
];
