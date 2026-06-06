// "Encounter" events — a person or creature crosses the party's path.
// Pass 2: 16 events (Pass 1: 3, +13 added) toward the design doc target of ~20.

import type { ExpeditionEvent } from "./types";

export const ENCOUNTER_EVENTS: ExpeditionEvent[] = [
  {
    id: "enc_wandering_merchant",
    setup: "encounter",
    tone: "wry",
    risk: "safe",
    theme: "greed",
    title: "A Wandering Merchant",
    body:
      "A pack-laden merchant waves you over, his cart wheels squeaking the whole sorry song. " +
      "He has a 'today only' look in his eye and a thumb on the scale.",
    branches: [
      {
        id: "haggle",
        label: "Haggle hard",
        outcomes: [
          {
            weight: 60,
            text: "He grumbles but caves; you walk away ten gold richer than you started.",
            effects: { gold: 10 },
          },
          {
            weight: 30,
            text: "He shrugs and packs up — neither of you spends a coin.",
          },
          {
            weight: 10,
            text: "He takes offense, snaps the cart shut on your fingers. You lose a little blood.",
            effects: { hp: -4 },
          },
        ],
      },
      {
        id: "buy_potion",
        label: "Buy a potion (15g)",
        outcomes: [
          {
            weight: 70,
            text: "It tastes like riverbank but the warmth in your gut is real.",
            effects: { gold: -15, hp: 12 },
          },
          {
            weight: 30,
            text: "The bottle is half-water, but you do feel a smidge better.",
            effects: { gold: -15, hp: 4 },
          },
        ],
      },
      {
        id: "walk_on",
        label: "Walk on",
        outcomes: [
          {
            weight: 100,
            text: "He shouts a friendly insult after you. The road goes on.",
          },
        ],
      },
    ],
  },

  {
    id: "enc_suspicious_crow",
    setup: "encounter",
    tone: "weird",
    risk: "mixed",
    theme: "curiosity",
    title: "A Suspicious Crow",
    body:
      "A crow lands on a fence post and tilts its head at you. It's holding something shiny in its beak. " +
      "It does not look afraid.",
    branches: [
      {
        id: "offer_food",
        label: "Offer it food",
        outcomes: [
          {
            weight: 50,
            text: "The crow drops the shiny thing — a small coin — and snatches your offering. Fair trade.",
            effects: { gold: 5 },
          },
          {
            weight: 40,
            text: "It eats and flies off with both. You feel cheated by a bird.",
          },
          {
            weight: 10,
            text: "It pecks your finger and bolts. The wound throbs longer than it should.",
            effects: { hp: -3, effect: "bleeding" },
          },
        ],
      },
      {
        id: "grab_it",
        label: "Grab the shiny thing",
        outcomes: [
          {
            weight: 30,
            text: "You're faster than the crow expected. A surprisingly heavy gold coin.",
            effects: { gold: 12 },
          },
          {
            weight: 50,
            text: "The crow scarpers. The fence post is now just a fence post.",
          },
          {
            weight: 20,
            text: "Bad idea. The crow's friends were watching. Your scalp learns this the hard way.",
            effects: { hp: -6 },
          },
        ],
      },
      {
        id: "leave_it",
        label: "Leave it",
        outcomes: [
          {
            weight: 100,
            text: "The crow watches you go, deeply unimpressed.",
          },
        ],
      },
    ],
  },

  {
    id: "enc_drunken_bard",
    setup: "encounter",
    tone: "wry",
    risk: "safe",
    theme: "mercy",
    title: "A Drunken Bard",
    body:
      "A bard slumps against a stump, lute on the ground, smell of three different liquors and one regret. " +
      "He grins up at you like the world is still on speaking terms with him.",
    branches: [
      {
        id: "listen",
        label: "Listen to a song",
        outcomes: [
          {
            weight: 80,
            text: "It is genuinely good. You walk away inspired.",
            effects: { mana: 4, xp: 8 },
          },
          {
            weight: 20,
            text: "It's the same chord for nine minutes. You leave wiser, mostly about bards.",
            effects: { xp: 2 },
          },
        ],
      },
      {
        id: "buy_drink",
        label: "Buy him a drink (5g)",
        outcomes: [
          {
            weight: 60,
            text: "He tells you a secret no king ever wrote down. You feel the world tilt a little.",
            effects: { gold: -5, mana: 6, xp: 5 },
          },
          {
            weight: 40,
            text: "He drinks it, hands you the empty cup, and falls asleep mid-sentence.",
            effects: { gold: -5 },
          },
        ],
      },
      {
        id: "ignore",
        label: "Move along",
        outcomes: [
          {
            weight: 100,
            text: "He toasts your back with an invisible cup.",
          },
        ],
      },
    ],
  },

  {
    id: "enc_lost_engineer",
    setup: "encounter",
    tone: "hopeful",
    risk: "safe",
    theme: "mercy",
    title: "A Lost Engineer",
    body:
      "A figure in a soot-stained jumpsuit waves you down from the shoulder, helmet under one arm, a folded " +
      "schematic in the other. 'My team went on without me. If you point me toward the next outpost I can pay.'",
    branches: [
      {
        id: "escort",
        label: "Escort her a stretch",
        outcomes: [
          {
            weight: 70,
            text: "She insists on tightening every loose bolt on your gear as you walk. The work is real.",
            effects: { xp: 12, gold: 6 },
          },
          {
            weight: 30,
            text: "She tells you a story about a pump that nearly killed her. You leave inspired and slightly anxious.",
            effects: { xp: 6 },
          },
        ],
      },
      {
        id: "directions",
        label: "Point and walk on",
        outcomes: [
          {
            weight: 100,
            text: "She thanks you and presses a tarnished coin into your hand. The road moves on.",
            effects: { gold: 3 },
          },
        ],
      },
      {
        id: "trade_schematic",
        label: "Trade rations for the schematic",
        outcomes: [
          {
            weight: 60,
            text: "The page is dense and useful. You'll understand it for a long time.",
            effects: { gold: -4, xp: 14 },
          },
          {
            weight: 40,
            text: "It's a tea-stained map of a place you'll never go. You feel oddly fond of it.",
            effects: { gold: -4 },
          },
        ],
      },
    ],
  },

  {
    id: "enc_hostile_patrol",
    setup: "encounter",
    tone: "grim",
    risk: "dangerous",
    theme: "fear",
    title: "A Hostile Patrol",
    body:
      "Three armed figures step out of the underbrush in matching uniforms. Their leader squints at you " +
      "the way a wolf squints at lunch. 'Papers, traveler.'",
    branches: [
      {
        id: "bluff",
        label: "Bluff your way past",
        outcomes: [
          {
            weight: 40,
            text: "Your story is exactly the right amount of boring. They wave you on.",
            effects: { xp: 10 },
          },
          {
            weight: 40,
            text: "They sniff out the lie but settle for shaking you down. You pay the going rate.",
            effects: { gold: -8 },
          },
          {
            weight: 20,
            text: "Bad bluff. Worse landing. Your ribs will remember this conversation.",
            effects: { hp: -10 },
          },
        ],
      },
      {
        id: "bribe",
        label: "Offer a bribe (10g)",
        outcomes: [
          {
            weight: 80,
            text: "The leader pockets it without breaking eye contact. 'We never saw you.'",
            effects: { gold: -10 },
          },
          {
            weight: 20,
            text: "She takes the gold, then takes another swing for principle. Capitalism.",
            effects: { gold: -10, hp: -5 },
          },
        ],
      },
      {
        id: "stand_ground",
        label: "Refuse",
        outcomes: [
          {
            weight: 30,
            text: "Something in your eye scares them off. You feel briefly mythic.",
            effects: { xp: 18 },
          },
          {
            weight: 70,
            text: "They beat you, take coin, and leave you in a ditch. You crawl out lighter.",
            effects: { hp: -14, gold: -6 },
          },
        ],
      },
    ],
  },

  {
    id: "enc_friendly_recruit",
    setup: "encounter",
    tone: "hopeful",
    risk: "safe",
    theme: "mercy",
    title: "A Friendly Recruit",
    body:
      "A young recruit in shiny new armor sits on a rock polishing a sword that has clearly never seen blood. " +
      "She brightens when she sees you. 'You look like you know what you're doing!'",
    branches: [
      {
        id: "give_advice",
        label: "Give honest advice",
        outcomes: [
          {
            weight: 80,
            text: "She listens, nods, and trades you her spare flask of stew for the lesson. Warm and useful.",
            effects: { hp: 10, xp: 8 },
          },
          {
            weight: 20,
            text: "She doesn't listen. You feel old. Lessons are like that.",
            effects: { xp: 4 },
          },
        ],
      },
      {
        id: "sell_advice",
        label: "Offer training (5g)",
        outcomes: [
          {
            weight: 70,
            text: "She pays gladly. You leave with a small bonus and a small student.",
            effects: { gold: 5, xp: 6 },
          },
          {
            weight: 30,
            text: "She thinks better of it. You walk on lighter than expected.",
          },
        ],
      },
      {
        id: "send_off",
        label: "Wish her luck",
        outcomes: [
          {
            weight: 100,
            text: "She salutes with the wrong hand and means it.",
          },
        ],
      },
    ],
  },

  {
    id: "enc_deserter",
    setup: "encounter",
    tone: "grim",
    risk: "mixed",
    theme: "mercy",
    title: "A Deserter in the Reeds",
    body:
      "Crouched in the reeds: a soldier with two empty hands and one very full canteen of cheap brandy. " +
      "His regiment marched on without him. He looks up. 'Don't tell.'",
    branches: [
      {
        id: "let_him_go",
        label: "Let him go",
        outcomes: [
          {
            weight: 60,
            text: "He presses a folded note into your hand — a hidden cache, two days' walk back. You can use that.",
            effects: { gold: 18 },
          },
          {
            weight: 40,
            text: "He cries quietly. You sit with him until it passes, then walk away.",
            effects: { xp: 8 },
          },
        ],
      },
      {
        id: "drink_with_him",
        label: "Share his bottle",
        outcomes: [
          {
            weight: 50,
            text: "It's worse than you feared and better than you expected. You both feel lighter for a moment.",
            effects: { mana: 8 },
          },
          {
            weight: 50,
            text: "The brandy is dosed with something. You wake up with empty pockets.",
            effects: { gold: -10, hp: -4 },
          },
        ],
      },
      {
        id: "turn_him_in",
        label: "Turn him in",
        outcomes: [
          {
            weight: 100,
            text: "The bounty is real and the paperwork is brisk. The coin in your pocket feels heavier than it should.",
            effects: { gold: 15, effect: "guilt" },
          },
        ],
      },
    ],
  },

  {
    id: "enc_stranger_in_fog",
    setup: "encounter",
    tone: "weird",
    risk: "mixed",
    theme: "fear",
    title: "A Stranger in the Fog",
    body:
      "The fog thickens. A silhouette stands in the middle of the road, very still. They don't speak. They don't move. " +
      "Their cloak is the wrong color for any uniform you know.",
    branches: [
      {
        id: "approach",
        label: "Approach slowly",
        outcomes: [
          {
            weight: 40,
            text: "Up close, it's just a scarecrow in someone's joke. Pinned to its chest: a small coin pouch.",
            effects: { gold: 12 },
          },
          {
            weight: 40,
            text: "It vanishes when you're three steps away. You feel watched the rest of the day.",
            effects: { effect: "haunted" },
          },
          {
            weight: 20,
            text: "It's not a scarecrow. You don't remember what happens next, but your shoulder bleeds for hours.",
            effects: { hp: -10 },
          },
        ],
      },
      {
        id: "shout_greeting",
        label: "Call out a greeting",
        outcomes: [
          {
            weight: 50,
            text: "A long pause. Then the figure bows once and walks into the fog. You feel a quiet blessing.",
            effects: { mana: 8 },
          },
          {
            weight: 50,
            text: "The fog swallows your voice. The road is empty. You're not sure for how long.",
          },
        ],
      },
      {
        id: "detour",
        label: "Take a detour",
        outcomes: [
          {
            weight: 100,
            text: "The detour is longer but the air is cleaner. Some things stay strangers.",
          },
        ],
      },
    ],
  },

  {
    id: "enc_oracle_kid",
    setup: "encounter",
    tone: "weird",
    risk: "safe",
    theme: "curiosity",
    title: "An Oracle, Aged Twelve",
    body:
      "A kid in a hand-me-down robe sits at the crossroads with a deck of cards and a sign: ONE QUESTION, ONE COIN. " +
      "She does not look up when you approach.",
    branches: [
      {
        id: "ask_question",
        label: "Ask a question (3g)",
        outcomes: [
          {
            weight: 50,
            text: "She flips three cards and tells you something specific and true. You feel a chime in your bones.",
            effects: { gold: -3, mana: 10, xp: 8 },
          },
          {
            weight: 30,
            text: "She tells you to look behind the loose brick. You do, later. There's coin.",
            effects: { gold: 9 },
          },
          {
            weight: 20,
            text: "She shrugs. 'Sometimes the cards are tired.' You leave none the wiser.",
            effects: { gold: -3 },
          },
        ],
      },
      {
        id: "buy_deck",
        label: "Buy her deck (12g)",
        outcomes: [
          {
            weight: 60,
            text: "She hesitates, then sells. The deck hums faintly. You'll use it later.",
            effects: { gold: -12, item: "🎴 Reader's Deck" },
          },
          {
            weight: 40,
            text: "She laughs. 'Not for sale.' But she gives you the joker.",
          },
        ],
      },
      {
        id: "walk_on",
        label: "Walk on",
        outcomes: [
          {
            weight: 100,
            text: "She doesn't look up. The crossroads keeps its quiet.",
          },
        ],
      },
    ],
  },

  {
    id: "enc_hungry_pilgrim",
    setup: "encounter",
    tone: "hopeful",
    risk: "safe",
    theme: "mercy",
    title: "A Hungry Pilgrim",
    body:
      "An elder in dust-caked robes leans on a staff. Their bowl is empty. Their smile, when it comes, is " +
      "patient as old stone.",
    branches: [
      {
        id: "share_food",
        label: "Share your rations",
        outcomes: [
          {
            weight: 80,
            text: "They bless you with a word in a language you almost remember. You feel warmer for days.",
            effects: { hp: 12, mana: 6, xp: 8 },
          },
          {
            weight: 20,
            text: "They thank you with a small, polished stone. It's heavier than it looks.",
            effects: { xp: 4 },
          },
        ],
      },
      {
        id: "give_gold",
        label: "Drop a coin (5g)",
        outcomes: [
          {
            weight: 70,
            text: "They smile and bow their head. You feel a small good thing settle in your chest.",
            effects: { gold: -5, xp: 6 },
          },
          {
            weight: 30,
            text: "The coin clinks in. They say nothing. You walk on with a quieter mind.",
            effects: { gold: -5 },
          },
        ],
      },
      {
        id: "rob_them",
        label: "Take the bowl",
        outcomes: [
          {
            weight: 50,
            text: "The bowl is empty. Of course it is. You feel small for trying.",
            effects: { effect: "guilt" },
          },
          {
            weight: 50,
            text: "Under the bowl: a handful of coppers. You pocket them and feel the world tilt a degree.",
            effects: { gold: 7, effect: "cursed" },
          },
        ],
      },
    ],
  },

  {
    id: "enc_war_dog",
    setup: "encounter",
    tone: "wry",
    risk: "mixed",
    theme: "mercy",
    title: "A War Dog Off Its Leash",
    body:
      "A massive armored hound trots up the road, dragging a chewed lead and grinning around a captured " +
      "boot. It tilts its head at you. Tail high.",
    branches: [
      {
        id: "befriend",
        label: "Make friends",
        outcomes: [
          {
            weight: 70,
            text: "It drops the boot and presses its forehead against your knee. The boot was full of coin.",
            effects: { gold: 14 },
          },
          {
            weight: 30,
            text: "It accepts a scritch with grave dignity, then trots off about its business.",
            effects: { xp: 4 },
          },
        ],
      },
      {
        id: "fight_it",
        label: "Take the boot",
        outcomes: [
          {
            weight: 30,
            text: "You win, somehow. The boot's contents are yours, but you'll favor that arm for a week.",
            effects: { gold: 14, hp: -10 },
          },
          {
            weight: 70,
            text: "The dog wins. The dog always wins. You limp away convinced.",
            effects: { hp: -14 },
          },
        ],
      },
      {
        id: "leave_alone",
        label: "Step aside",
        outcomes: [
          {
            weight: 100,
            text: "It pads past you, happy with its prize. Good dog. Probably.",
          },
        ],
      },
    ],
  },

  {
    id: "enc_drunk_warforged",
    setup: "encounter",
    tone: "wry",
    risk: "safe",
    theme: "curiosity",
    title: "A Drunk Warforged",
    body:
      "A man-shaped construct of brass and gears sits in the road, leaking a fluid that smells like " +
      "fermented gear oil. It waves a piston-arm at you. 'I am, hic, philosophically wasted.'",
    branches: [
      {
        id: "philosophize",
        label: "Argue philosophy",
        outcomes: [
          {
            weight: 60,
            text: "It loses the argument and concedes you a small reward 'from the principles of fairness.'",
            effects: { gold: 9, xp: 10 },
          },
          {
            weight: 40,
            text: "It out-argues you and falls asleep mid-thesis. You feel obliterated, intellectually.",
            effects: { mana: -3, xp: 4 },
          },
        ],
      },
      {
        id: "fix_it",
        label: "Tighten its gears",
        outcomes: [
          {
            weight: 80,
            text: "It sobers up, weeps an oil-tear of gratitude, and gives you a useful bolt-bundle.",
            effects: { item: "🔧 Spare Parts" },
          },
          {
            weight: 20,
            text: "You misalign a cam. It curses you fondly in three dead languages.",
            effects: { hp: -3 },
          },
        ],
      },
      {
        id: "leave_it",
        label: "Roll it to the side",
        outcomes: [
          {
            weight: 100,
            text: "It thanks you with the dignity of a man who knows when to stop. The road continues.",
          },
        ],
      },
    ],
  },

  {
    id: "enc_grieving_widow",
    setup: "encounter",
    tone: "grim",
    risk: "safe",
    theme: "mercy",
    title: "A Widow at the Crossroads",
    body:
      "A woman in plain mourning sits by a small headstone someone set up by the roadside. The grave is " +
      "fresh. She does not weep — she stares.",
    branches: [
      {
        id: "sit_with_her",
        label: "Sit with her a while",
        outcomes: [
          {
            weight: 90,
            text: "Neither of you speaks. She presses a small jade pendant into your hand when you leave.",
            effects: { item: "🟢 Jade Pendant", xp: 10 },
          },
          {
            weight: 10,
            text: "She thanks you quietly and walks away. You stay alone by the stone for a moment longer.",
          },
        ],
      },
      {
        id: "leave_coin",
        label: "Leave a coin (3g)",
        outcomes: [
          {
            weight: 100,
            text: "She nods once. The coin will buy flowers, eventually.",
            effects: { gold: -3, xp: 4 },
          },
        ],
      },
      {
        id: "walk_past",
        label: "Walk past",
        outcomes: [
          {
            weight: 100,
            text: "She doesn't look up. The road takes a long time to leave behind.",
          },
        ],
      },
    ],
  },

  {
    id: "enc_rival_party",
    setup: "encounter",
    tone: "wry",
    risk: "mixed",
    theme: "greed",
    title: "A Rival Party",
    body:
      "Another expedition crests the rise. Their gear is shinier. Their banner is louder. Their captain — a " +
      "smug specimen with too many medals — gives you a slow once-over.",
    branches: [
      {
        id: "challenge",
        label: "Throw down a wager",
        outcomes: [
          {
            weight: 50,
            text: "You arm-wrestle their captain. You win. They pay up, gritted teeth and all.",
            effects: { gold: 22, xp: 12 },
          },
          {
            weight: 50,
            text: "You lose. He grins. The grin will live rent-free in your head for weeks.",
            effects: { gold: -15 },
          },
        ],
      },
      {
        id: "trade_intel",
        label: "Swap road intel",
        outcomes: [
          {
            weight: 80,
            text: "They warn you about a real hazard ahead. You return the favor. Both parties live a little longer.",
            effects: { xp: 14, hp: 6 },
          },
          {
            weight: 20,
            text: "They lie about the road, and you catch the lie. You walk away wiser.",
            effects: { xp: 8 },
          },
        ],
      },
      {
        id: "pass_quietly",
        label: "Tip your hat and pass",
        outcomes: [
          {
            weight: 100,
            text: "Their captain returns the tip with a smaller, more honest one. Two parties, one road.",
          },
        ],
      },
    ],
  },

  {
    id: "enc_courier_pigeon",
    setup: "encounter",
    tone: "weird",
    risk: "safe",
    theme: "curiosity",
    title: "A Courier Pigeon, Lost",
    body:
      "A pigeon flutters down onto your shoulder and offers a tiny strapped tube with its insistent left foot. " +
      "The tube hums faintly. The pigeon does not leave.",
    branches: [
      {
        id: "read_message",
        label: "Read the message",
        outcomes: [
          {
            weight: 50,
            text: "Coordinates. Easy to remember. Easy to use.",
            effects: { gold: 12, xp: 8 },
          },
          {
            weight: 30,
            text: "An invoice. Someone owes someone a lot of money. Not your problem.",
            effects: { xp: 4 },
          },
          {
            weight: 20,
            text: "A trap rune. It snaps your fingers. The pigeon flies off, satisfied.",
            effects: { hp: -5 },
          },
        ],
      },
      {
        id: "send_it_on",
        label: "Send the pigeon onward",
        outcomes: [
          {
            weight: 80,
            text: "It coos, salutes with a wing, and rockets off. Somewhere, someone will be relieved.",
            effects: { xp: 6 },
          },
          {
            weight: 20,
            text: "It refuses. It sits on your pack the rest of the day. You name it Brian.",
            effects: { effect: "companion" },
          },
        ],
      },
      {
        id: "eat_it",
        label: "Eat the pigeon",
        outcomes: [
          {
            weight: 100,
            text: "It is tougher than expected and tastes vaguely of paper. You feel slightly cursed but full.",
            effects: { hp: 6, effect: "cursed" },
          },
        ],
      },
    ],
  },

  {
    id: "enc_minor_god",
    setup: "encounter",
    tone: "weird",
    risk: "mixed",
    theme: "fear",
    title: "A Minor God, Bored",
    body:
      "A figure sits cross-legged in the middle of the path, glowing faintly, the kind of glow that makes road dust " +
      "rearrange itself politely. They look up. 'You. Entertain me.'",
    branches: [
      {
        id: "tell_joke",
        label: "Tell a joke",
        outcomes: [
          {
            weight: 50,
            text: "They laugh. Genuinely. You feel a small permanent improvement in your luck.",
            effects: { gold: 18, xp: 10 },
          },
          {
            weight: 30,
            text: "The joke lands sideways. They shrug and vanish. The road is empty again.",
          },
          {
            weight: 20,
            text: "They do not laugh. They turn you slightly the wrong color for a few hours. Embarrassing.",
            effects: { hp: -4, effect: "cursed" },
          },
        ],
      },
      {
        id: "sing",
        label: "Sing them a song",
        outcomes: [
          {
            weight: 60,
            text: "They hum along. You walk away with a small blessing curled around your shoulders.",
            effects: { mana: 12, xp: 8 },
          },
          {
            weight: 40,
            text: "They mistake the song for an insult. The road bends to make your trip longer.",
            effects: { hp: -6 },
          },
        ],
      },
      {
        id: "decline",
        label: "Politely decline",
        outcomes: [
          {
            weight: 100,
            text: "They blink, perplexed, and vanish. The dust returns to being mere dust.",
          },
        ],
      },
    ],
  },
];
