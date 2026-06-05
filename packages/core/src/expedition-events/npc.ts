// "NPC quest-bite" events — short transactional asks.
// Pass 2: 14 events (Pass 1: 2, +12 added) — exceeds the design doc target of ~10
// to reach 60 total events across all four files.

import type { ExpeditionEvent } from "./types";

export const NPC_EVENTS: ExpeditionEvent[] = [
  {
    id: "npc_delivery_to_x",
    setup: "npc",
    tone: "hopeful",
    risk: "safe",
    theme: "mercy",
    title: "A Package for X",
    body:
      "A breathless courier presses a parcel into your hands. 'Get this to the next outpost. Please. I can't make " +
      "it. They'll pay you when you arrive.' She runs the other direction before you can answer.",
    branches: [
      {
        id: "accept",
        label: "Accept the delivery",
        outcomes: [
          {
            weight: 70,
            text: "The outpost is real. The payment is generous. You feel useful.",
            effects: { gold: 20, xp: 10 },
          },
          {
            weight: 20,
            text: "The recipient was a fraud, but the parcel itself had something useful inside.",
            effects: { item: "🔧 Spare Parts" },
          },
          {
            weight: 10,
            text: "Bandits had the same idea. You arrive lighter than you started.",
            effects: { gold: -10, hp: -8 },
          },
        ],
      },
      {
        id: "open_it",
        label: "Open the parcel",
        outcomes: [
          {
            weight: 50,
            text: "Inside: a small stack of coins and a note marked URGENT. You pocket the coins.",
            effects: { gold: 15, effect: "guilt" },
          },
          {
            weight: 50,
            text: "Inside: a trap rune that snaps shut on your fingers.",
            effects: { hp: -7 },
          },
        ],
      },
      {
        id: "refuse",
        label: "Leave it on the ground",
        outcomes: [
          {
            weight: 100,
            text: "Someone else's problem now. The road continues, indifferent.",
          },
        ],
      },
    ],
  },

  {
    id: "npc_trade_y_for_z",
    setup: "npc",
    tone: "wry",
    risk: "mixed",
    theme: "greed",
    title: "A Curious Trade",
    body:
      "A trader in a wide hat won't make eye contact. 'I'll trade you something useful — for that thing in your " +
      "pocket. Yes. That one. No, I won't tell you what I'm giving you until you say yes.'",
    branches: [
      {
        id: "trade",
        label: "Trade (15g)",
        outcomes: [
          {
            weight: 50,
            text: "She hands you a small clinking pouch and vanishes into the crowd. The pouch is generous.",
            effects: { gold: 25 },
          },
          {
            weight: 30,
            text: "A bottle of something glowing. It does something. Possibly something good.",
            effects: { gold: -15, mana: 10, hp: 8 },
          },
          {
            weight: 20,
            text: "A rock. Just a rock. Heavier than it should be.",
            effects: { gold: -15 },
          },
        ],
      },
      {
        id: "negotiate",
        label: "Negotiate first",
        outcomes: [
          {
            weight: 60,
            text: "She relents and shows you the goods. You walk away with a small profit and your dignity.",
            effects: { gold: 8, xp: 6 },
          },
          {
            weight: 40,
            text: "She loses patience and disappears mid-sentence. You feel oddly relieved.",
          },
        ],
      },
      {
        id: "decline",
        label: "Decline politely",
        outcomes: [
          {
            weight: 100,
            text: "She tips her hat. You go your separate ways.",
          },
        ],
      },
    ],
  },

  {
    id: "npc_hunt_rogue_process",
    setup: "npc",
    tone: "wry",
    risk: "dangerous",
    theme: "curiosity",
    title: "Hunt the Rogue Process",
    body:
      "A sysadmin in a singed coat flags you down. 'There's a process loose in the woods. Eats CPU and " +
      "small game. Hundred gold to anyone who corners it.' She offers you a debugger and a bad map.",
    branches: [
      {
        id: "hunt",
        label: "Take the bounty",
        outcomes: [
          {
            weight: 50,
            text: "You corner it. It hisses. You SIGKILL it. The sysadmin pays in full.",
            effects: { gold: 35, xp: 18 },
          },
          {
            weight: 30,
            text: "You scare it off. The sysadmin pays a partial. Fair.",
            effects: { gold: 15, xp: 8 },
          },
          {
            weight: 20,
            text: "It SIGKILLs you first. You crawl back lighter and bloodier.",
            effects: { hp: -16 },
          },
        ],
      },
      {
        id: "decline",
        label: "Not your fight",
        outcomes: [
          {
            weight: 100,
            text: "She shrugs and asks the next traveler. The road moves on.",
          },
        ],
      },
    ],
  },

  {
    id: "npc_scout_pocket",
    setup: "npc",
    tone: "hopeful",
    risk: "mixed",
    theme: "curiosity",
    title: "Scout the Pocket",
    body:
      "A cartographer with ink-stained fingers waves a folded chart at you. 'There's a pocket of " +
      "unmapped land behind that ridge. Walk it, sketch it, come back. I pay per league.'",
    branches: [
      {
        id: "scout",
        label: "Scout it",
        outcomes: [
          {
            weight: 60,
            text: "Clean walk. Clean map. She pays per league and tips on top.",
            effects: { gold: 22, xp: 12 },
          },
          {
            weight: 30,
            text: "Half the pocket. You did your best. She pays per league anyway.",
            effects: { gold: 10, xp: 6 },
          },
          {
            weight: 10,
            text: "The pocket has teeth. You leave a map shaped like a hand and an apology.",
            effects: { gold: 5, hp: -10 },
          },
        ],
      },
      {
        id: "sell_old_notes",
        label: "Sell her old notes you have",
        outcomes: [
          {
            weight: 70,
            text: "She squints, nods, pays modestly. Fair trade for a smaller deception.",
            effects: { gold: 8 },
          },
          {
            weight: 30,
            text: "She catches the fake. She's polite. You leave a little embarrassed.",
            effects: { effect: "guilt" },
          },
        ],
      },
      {
        id: "decline",
        label: "Walk on",
        outcomes: [
          {
            weight: 100,
            text: "She nods. The ridge keeps its pocket.",
          },
        ],
      },
    ],
  },

  {
    id: "npc_trade_a_for_b",
    setup: "npc",
    tone: "wry",
    risk: "safe",
    theme: "greed",
    title: "Trade This for That",
    body:
      "A peddler with three hats stacked on one head won't touch coin. 'No money. Object for object. Pull " +
      "something from your pack. Show me. I'll match it.'",
    branches: [
      {
        id: "trade_small",
        label: "Trade a spare bauble",
        outcomes: [
          {
            weight: 70,
            text: "She hands you a wrapped parcel. Inside: something more useful than what you gave.",
            effects: { item: "🟢 Trinket", xp: 6 },
          },
          {
            weight: 30,
            text: "She hands you a wrapped parcel. Inside: a wrapped parcel. The road has a sense of humor.",
          },
        ],
      },
      {
        id: "trade_valuable",
        label: "Trade something good",
        outcomes: [
          {
            weight: 50,
            text: "A genuinely powerful tool comes out of her sack. You walk away a little wiser.",
            effects: { item: "📜 Scroll", xp: 14 },
          },
          {
            weight: 50,
            text: "A bigger version of what you gave her. You feel hustled in a friendly way.",
          },
        ],
      },
      {
        id: "decline",
        label: "Walk on",
        outcomes: [
          {
            weight: 100,
            text: "She tips one hat. Then another. Then the third. You walk on.",
          },
        ],
      },
    ],
  },

  {
    id: "npc_courier_job",
    setup: "npc",
    tone: "hopeful",
    risk: "safe",
    theme: "mercy",
    title: "A Courier with One Letter Left",
    body:
      "A courier in worn leathers leans against a fencepost, fanning her face with the last of her " +
      "satchel: one sealed letter. 'Last delivery. Wrong direction for me. Take it for half my fee?'",
    branches: [
      {
        id: "deliver",
        label: "Deliver it",
        outcomes: [
          {
            weight: 80,
            text: "The recipient is overjoyed and tips well.",
            effects: { gold: 18, xp: 10 },
          },
          {
            weight: 20,
            text: "The recipient is dead. The letter joins the soil. The courier paid you up front, at least.",
            effects: { gold: 8, effect: "guilt" },
          },
        ],
      },
      {
        id: "read_first",
        label: "Read it before delivering",
        outcomes: [
          {
            weight: 50,
            text: "A love letter. You deliver it anyway. Nobody knows you read it but you.",
            effects: { gold: 12, effect: "guilt" },
          },
          {
            weight: 50,
            text: "A business letter. You learn the recipient owes the sender a lot of money. You deliver it.",
            effects: { gold: 12, xp: 6 },
          },
        ],
      },
      {
        id: "decline",
        label: "Decline",
        outcomes: [
          {
            weight: 100,
            text: "She sighs and slings the satchel back. The road continues.",
          },
        ],
      },
    ],
  },

  {
    id: "npc_orphan_request",
    setup: "npc",
    tone: "hopeful",
    risk: "safe",
    theme: "mercy",
    title: "A Small Quest from a Small Person",
    body:
      "A kid of eight or nine plants themself in your path. 'Cat lost. Big tabby. Last seen by the " +
      "mill. Three coppers reward.' They show you the three coppers, very serious.",
    branches: [
      {
        id: "find_cat",
        label: "Find the cat",
        outcomes: [
          {
            weight: 70,
            text: "It's behind a barrel, very offended. Reunion is loud and joyful. The kid pays the three coppers.",
            effects: { gold: 3, xp: 14 },
          },
          {
            weight: 20,
            text: "You find the cat in a tree. It comes down for the kid, not for you. Still, paid.",
            effects: { gold: 3, xp: 8 },
          },
          {
            weight: 10,
            text: "You find the cat dead. You bury it without telling the kid. You don't take the coppers.",
            effects: { xp: 10, effect: "guilt" },
          },
        ],
      },
      {
        id: "give_coin",
        label: "Refuse payment, look anyway",
        outcomes: [
          {
            weight: 80,
            text: "Found and reunited. The kid hugs your knee. Worth more than three coppers.",
            effects: { xp: 18 },
          },
          {
            weight: 20,
            text: "No luck. The kid is brave about it. You feel small in a useful way.",
            effects: { xp: 6 },
          },
        ],
      },
      {
        id: "decline",
        label: "Decline",
        outcomes: [
          {
            weight: 100,
            text: "They look disappointed and march off to ask someone else.",
          },
        ],
      },
    ],
  },

  {
    id: "npc_smuggle",
    setup: "npc",
    tone: "grim",
    risk: "dangerous",
    theme: "greed",
    title: "A Smuggler with a Side Job",
    body:
      "A figure in a long coat leans close. 'Half-fee for half a job. Carry this small box across the " +
      "border. Don't open it. Don't drop it. Don't ask.'",
    branches: [
      {
        id: "accept",
        label: "Take the job",
        outcomes: [
          {
            weight: 50,
            text: "Easy walk. Big pay. You learn later it was medicine, not contraband. You sleep fine.",
            effects: { gold: 30 },
          },
          {
            weight: 30,
            text: "Easy walk. Big pay. You don't ask what was in the box.",
            effects: { gold: 30, effect: "guilt" },
          },
          {
            weight: 20,
            text: "You're searched at the border. The box screams when they open it. You spend a night in a cell.",
            effects: { gold: -15, hp: -10 },
          },
        ],
      },
      {
        id: "negotiate",
        label: "Negotiate up",
        outcomes: [
          {
            weight: 50,
            text: "He scoffs and walks. Nothing lost, nothing gained.",
          },
          {
            weight: 50,
            text: "He hands you the box at full price. You carry it nervously and arrive whole.",
            effects: { gold: 45, effect: "guilt" },
          },
        ],
      },
      {
        id: "refuse",
        label: "Refuse",
        outcomes: [
          {
            weight: 100,
            text: "He shrugs and asks the next stranger. You sleep easier for it.",
            effects: { xp: 8 },
          },
        ],
      },
    ],
  },

  {
    id: "npc_bard_for_hire",
    setup: "npc",
    tone: "wry",
    risk: "safe",
    theme: "mercy",
    title: "A Bard Looking for a Story",
    body:
      "A bard with a fresh new lute jogs to keep up. 'Stories! I trade gold for stories. Especially " +
      "embarrassing ones. Especially yours.' She is grinning. She is serious.",
    branches: [
      {
        id: "sell_story",
        label: "Sell her a story",
        outcomes: [
          {
            weight: 70,
            text: "She pays well. The story is yours to lose forever. The coin is yours to keep.",
            effects: { gold: 16 },
          },
          {
            weight: 30,
            text: "She pays well and promises to change all the names. You believe her about half.",
            effects: { gold: 16, effect: "guilt" },
          },
        ],
      },
      {
        id: "trade_story",
        label: "Trade story for story",
        outcomes: [
          {
            weight: 80,
            text: "Hers is better than yours. You walk away with a small new tale and a small new heart.",
            effects: { xp: 14, mana: 4 },
          },
          {
            weight: 20,
            text: "Yours is better than hers. She concedes graciously and gives you a coin anyway.",
            effects: { gold: 4, xp: 8 },
          },
        ],
      },
      {
        id: "refuse",
        label: "Walk on",
        outcomes: [
          {
            weight: 100,
            text: "She salutes you with her lute and pivots for the next stranger.",
          },
        ],
      },
    ],
  },

  {
    id: "npc_blacksmith_apprentice",
    setup: "npc",
    tone: "hopeful",
    risk: "safe",
    theme: "mercy",
    title: "A Blacksmith's Lost Apprentice",
    body:
      "A young apprentice runs up to you with a tray of tools. 'Master sent me to find a traveler willing " +
      "to test a new sharpening. Free for you. He gets to study the wear.'",
    branches: [
      {
        id: "accept",
        label: "Let him sharpen your gear",
        outcomes: [
          {
            weight: 80,
            text: "Your gear comes back keen. You'll cut a little truer for a week.",
            effects: { xp: 8, item: "🔧 Spare Parts" },
          },
          {
            weight: 20,
            text: "He's nervous and nicks your edge. You both apologize a lot.",
            effects: { hp: -3 },
          },
        ],
      },
      {
        id: "tip_him",
        label: "Tip him for the trouble (5g)",
        outcomes: [
          {
            weight: 100,
            text: "He blinks. He bows. He runs back to tell his master a customer was kind.",
            effects: { gold: -5, xp: 10 },
          },
        ],
      },
      {
        id: "refuse",
        label: "Decline",
        outcomes: [
          {
            weight: 100,
            text: "He nods, very small, and trudges off down the road.",
          },
        ],
      },
    ],
  },

  {
    id: "npc_fence_offers_deal",
    setup: "npc",
    tone: "grim",
    risk: "mixed",
    theme: "greed",
    title: "A Fence with a Soft Sell",
    body:
      "A woman in a too-clean cloak leans on a fencepost like she paid for it. 'Got anything in your " +
      "pack you don't strictly need? No questions. Real coin. Fair price.'",
    branches: [
      {
        id: "sell_junk",
        label: "Sell her some clutter",
        outcomes: [
          {
            weight: 80,
            text: "Decent coin for trash. You feel lighter.",
            effects: { gold: 12 },
          },
          {
            weight: 20,
            text: "She squints at your clutter, names a low price, and you take it.",
            effects: { gold: 6 },
          },
        ],
      },
      {
        id: "sell_oath_bound",
        label: "Sell her something you shouldn't",
        outcomes: [
          {
            weight: 60,
            text: "Big coin. Bigger silence.",
            effects: { gold: 30, effect: "guilt" },
          },
          {
            weight: 40,
            text: "She names the original owner and offers to put you in touch with them. You decline.",
            effects: { gold: 0, effect: "guilt" },
          },
        ],
      },
      {
        id: "walk_on",
        label: "Walk on",
        outcomes: [
          {
            weight: 100,
            text: "She tips her hood. The fencepost goes on holding her up after you leave.",
          },
        ],
      },
    ],
  },

  {
    id: "npc_pilgrimage_offer",
    setup: "npc",
    tone: "hopeful",
    risk: "mixed",
    theme: "mercy",
    title: "A Pilgrim Offers to Pray for You",
    body:
      "A robed pilgrim with calloused hands offers you a small ceremony. 'A blessing for the road ahead. " +
      "Costs nothing. Helps a little. May I?'",
    branches: [
      {
        id: "accept",
        label: "Accept the blessing",
        outcomes: [
          {
            weight: 80,
            text: "A few words, a hand on your shoulder, and a strange small warmth settles in your chest.",
            effects: { hp: 10, mana: 6 },
          },
          {
            weight: 20,
            text: "The ceremony is over fast. You feel calmer, if nothing else.",
            effects: { mana: 4 },
          },
        ],
      },
      {
        id: "tip",
        label: "Accept and tip (3g)",
        outcomes: [
          {
            weight: 100,
            text: "He bows. The blessing lasts longer than it should.",
            effects: { gold: -3, hp: 12, mana: 10 },
          },
        ],
      },
      {
        id: "decline",
        label: "Decline",
        outcomes: [
          {
            weight: 100,
            text: "He nods without offense and walks on.",
          },
        ],
      },
    ],
  },

  {
    id: "npc_alchemist_trade",
    setup: "npc",
    tone: "weird",
    risk: "mixed",
    theme: "curiosity",
    title: "An Alchemist Wants a Sample",
    body:
      "An alchemist with a small belt of vials raises a hand. 'Hair, blood, breath — one of those, " +
      "small amount, for my research. I pay in potions or coin.'",
    branches: [
      {
        id: "hair_for_potion",
        label: "Hair, for a potion",
        outcomes: [
          {
            weight: 80,
            text: "A vial of something useful changes hands. You walk on slightly more resilient.",
            effects: { hp: 14, mana: 6 },
          },
          {
            weight: 20,
            text: "She bottles your hair and gives you a vial of vinegar by mistake. Honest accident.",
          },
        ],
      },
      {
        id: "blood_for_coin",
        label: "Blood, for coin",
        outcomes: [
          {
            weight: 60,
            text: "A tiny prick. Fair coin. Both move on.",
            effects: { gold: 14, hp: -2 },
          },
          {
            weight: 40,
            text: "More than she said she'd take. She tips extra to make up for it.",
            effects: { gold: 20, hp: -6 },
          },
        ],
      },
      {
        id: "refuse",
        label: "Refuse",
        outcomes: [
          {
            weight: 100,
            text: "She nods politely, corks her empty vial, and turns to the next traveler.",
          },
        ],
      },
    ],
  },

  {
    id: "npc_innkeeper_referral",
    setup: "npc",
    tone: "hopeful",
    risk: "safe",
    theme: "mercy",
    title: "An Innkeeper's Referral",
    body:
      "An innkeeper jogs to catch you up. 'Wife's brother runs a hostel up the road. Tell him I sent you " +
      "and he'll feed you for free. Just bring back word he's alright.'",
    branches: [
      {
        id: "carry_word",
        label: "Carry the word",
        outcomes: [
          {
            weight: 80,
            text: "The brother is alright. The free meal is real. Everyone sleeps better tonight.",
            effects: { hp: 14, xp: 8 },
          },
          {
            weight: 20,
            text: "The brother has moved on. The innkeeper takes the news with a long quiet nod and pays you anyway.",
            effects: { gold: 8 },
          },
        ],
      },
      {
        id: "skim_referral",
        label: "Take the meal, skip the report",
        outcomes: [
          {
            weight: 100,
            text: "Free meal, no message returned. You feel a quiet small smudge on the day.",
            effects: { hp: 8, effect: "guilt" },
          },
        ],
      },
      {
        id: "decline",
        label: "Decline",
        outcomes: [
          {
            weight: 100,
            text: "He shrugs and waves. The road takes you both elsewhere.",
          },
        ],
      },
    ],
  },
];
