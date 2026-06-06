// "Dilemma" events — choose between bad options.
// Pass 2: 15 events (Pass 1: 2, +13 added) to hit the design doc target of ~15.

import type { ExpeditionEvent } from "./types";

export const DILEMMA_EVENTS: ExpeditionEvent[] = [
  {
    id: "dil_trolley_deploy_bot",
    setup: "dilemma",
    tone: "grim",
    risk: "dangerous",
    theme: "fear",
    title: "The Trolley Problem, but with a Deploy Bot",
    body:
      "A runaway deploy cart is barreling down a rail. On one track: five staging environments. On the other: " +
      "production. The switch is in your hand. Either way, something burns.",
    branches: [
      {
        id: "save_prod",
        label: "Save prod (let staging burn)",
        outcomes: [
          {
            weight: 60,
            text: "Five environments smoulder gently. The team will rebuild them. The user-facing site stays up. Lessons are learned, mostly by you.",
            effects: { gold: 12, xp: 15 },
          },
          {
            weight: 40,
            text: "Staging burns. So does your reputation for caution. You feel watched for a while.",
            effects: { xp: 8, effect: "guilt" },
          },
        ],
      },
      {
        id: "save_staging",
        label: "Save staging (sacrifice prod)",
        outcomes: [
          {
            weight: 50,
            text: "Prod goes down for an hour. You patch it back together with sweat and luck. Hard-won wisdom.",
            effects: { xp: 20, hp: -10 },
          },
          {
            weight: 50,
            text: "Prod is gone. The cleanup is brutal. You learn three new lessons you wish you hadn't.",
            effects: { gold: -15, hp: -14, xp: 12 },
          },
        ],
      },
      {
        id: "freeze",
        label: "Do nothing",
        outcomes: [
          {
            weight: 100,
            text: "The cart resolves itself somehow. You don't ask. The road tastes of ash for a while.",
            effects: { effect: "guilt" },
          },
        ],
      },
    ],
  },

  {
    id: "dil_save_data_or_dev",
    setup: "dilemma",
    tone: "grim",
    risk: "dangerous",
    theme: "mercy",
    title: "Save the Data or Save the Dev",
    body:
      "A backup drive is wedged under a collapsed shelf, blinking weakly. A trapped engineer is calling for help " +
      "from the far side of the room. You can reach one in time.",
    branches: [
      {
        id: "save_dev",
        label: "Save the engineer",
        outcomes: [
          {
            weight: 80,
            text: "She is bruised but breathing. She presses a coin into your hand — all she has. You walk out lighter.",
            effects: { gold: 6, xp: 18 },
          },
          {
            weight: 20,
            text: "You make it in time. The data didn't. The team will rebuild — and they remember who chose them.",
            effects: { xp: 12 },
          },
        ],
      },
      {
        id: "save_data",
        label: "Save the data",
        outcomes: [
          {
            weight: 60,
            text: "The drive boots. The dev didn't. The data was worth more than you knew — but you'll dream of her voice.",
            effects: { gold: 25, xp: 10, effect: "guilt" },
          },
          {
            weight: 40,
            text: "You grab the drive. The shelf gives a little — somehow both make it out. You don't ask how.",
            effects: { gold: 15, xp: 14 },
          },
        ],
      },
    ],
  },

  {
    id: "dil_betray_comrade",
    setup: "dilemma",
    tone: "grim",
    risk: "dangerous",
    theme: "greed",
    title: "A Comrade, A Sack of Coin",
    body:
      "A stranger in a fine coat offers you a sack of coin. The price: testimony against a friend who once " +
      "helped you out of a tight spot. The stranger is patient. The coin is heavy.",
    branches: [
      {
        id: "take_coin",
        label: "Take the coin",
        outcomes: [
          {
            weight: 60,
            text: "You testify. The coin spends. Your sleep changes shape.",
            effects: { gold: 40, effect: "guilt" },
          },
          {
            weight: 40,
            text: "Your friend catches wind and disappears before the testimony lands. The coin is yours, but the chair across the table is empty for a long time.",
            effects: { gold: 40, effect: "haunted" },
          },
        ],
      },
      {
        id: "refuse",
        label: "Refuse",
        outcomes: [
          {
            weight: 70,
            text: "The stranger nods once and leaves. Your friend never knows you were asked.",
            effects: { xp: 18 },
          },
          {
            weight: 30,
            text: "The stranger leaves a small token under your cup — a hint that the offer still stands. You don't pick it up.",
            effects: { xp: 12 },
          },
        ],
      },
      {
        id: "warn_friend",
        label: "Warn your friend",
        outcomes: [
          {
            weight: 80,
            text: "Your friend repays the favor in kind. The road feels a little safer for both of you.",
            effects: { gold: 12, xp: 20, hp: 8 },
          },
          {
            weight: 20,
            text: "Your friend doesn't believe you. They thank you anyway. Friendship is like that.",
            effects: { xp: 10 },
          },
        ],
      },
    ],
  },

  {
    id: "dil_two_villages",
    setup: "dilemma",
    tone: "grim",
    risk: "dangerous",
    theme: "mercy",
    title: "Two Villages, One Flood",
    body:
      "A dam is failing. The water will take one of two villages downstream. The break-valve is in your " +
      "hand. Either way, people you've never met lose everything.",
    branches: [
      {
        id: "save_smaller",
        label: "Save the smaller village",
        outcomes: [
          {
            weight: 60,
            text: "Forty saved. Two hundred lost. The forty will remember you the rest of their lives.",
            effects: { xp: 22, effect: "guilt" },
          },
          {
            weight: 40,
            text: "Forty saved. The two hundred had warning enough. You learn this later.",
            effects: { xp: 16 },
          },
        ],
      },
      {
        id: "save_larger",
        label: "Save the larger village",
        outcomes: [
          {
            weight: 60,
            text: "Two hundred saved. Forty lost. Math is not mercy. You know this now.",
            effects: { xp: 22, effect: "guilt" },
          },
          {
            weight: 40,
            text: "Two hundred saved. The forty saw the sign and ran. You learn this later.",
            effects: { xp: 16 },
          },
        ],
      },
      {
        id: "freeze",
        label: "Hesitate",
        outcomes: [
          {
            weight: 100,
            text: "The dam decides for you. The water takes whoever it takes. You walk away knowing nothing.",
            effects: { hp: -6, effect: "haunted" },
          },
        ],
      },
    ],
  },

  {
    id: "dil_starving_child",
    setup: "dilemma",
    tone: "grim",
    risk: "safe",
    theme: "mercy",
    title: "A Starving Child Steals Bread",
    body:
      "You see it happen: a kid lifts a loaf from a market stall and runs. The vendor shouts at you to " +
      "stop them. The kid's face is the face of someone who has not eaten in days.",
    branches: [
      {
        id: "stop_child",
        label: "Stop the child",
        outcomes: [
          {
            weight: 60,
            text: "The vendor pays you a finder's fee. The kid won't look at you again.",
            effects: { gold: 8, effect: "guilt" },
          },
          {
            weight: 40,
            text: "The vendor sees the kid's face, sighs, and lets it go. He thanks you for trying.",
            effects: { gold: 3 },
          },
        ],
      },
      {
        id: "pay_for_bread",
        label: "Pay for the bread (4g)",
        outcomes: [
          {
            weight: 100,
            text: "The vendor blinks, then nods. The kid disappears into the alley. Bread for a stranger.",
            effects: { gold: -4, xp: 12 },
          },
        ],
      },
      {
        id: "ignore",
        label: "Look the other way",
        outcomes: [
          {
            weight: 100,
            text: "The kid runs. The vendor shouts at someone else. Nothing changes for you.",
          },
        ],
      },
    ],
  },

  {
    id: "dil_caravan_choice",
    setup: "dilemma",
    tone: "grim",
    risk: "dangerous",
    theme: "fear",
    title: "Two Caravans Ask for Help",
    body:
      "Two messengers find you within minutes. One caravan is being robbed up the canyon. Another is " +
      "trapped under a landslide on the lower trail. You can reach one. The other will not wait.",
    branches: [
      {
        id: "save_robbed",
        label: "Reach the bandits",
        outcomes: [
          {
            weight: 50,
            text: "You scare off the bandits. Grateful merchants share their take.",
            effects: { gold: 22, hp: -6, effect: "guilt" },
          },
          {
            weight: 50,
            text: "You drive them off, get cut up doing it, and find out later the landslide killed three.",
            effects: { gold: 14, hp: -12, effect: "guilt" },
          },
        ],
      },
      {
        id: "save_trapped",
        label: "Reach the landslide",
        outcomes: [
          {
            weight: 60,
            text: "You dig out two survivors and a strongbox. The canyon caravan loses goods but not lives.",
            effects: { gold: 18, xp: 16 },
          },
          {
            weight: 40,
            text: "You dig out one survivor. You learn later the bandits took everything from the other.",
            effects: { gold: 6, xp: 8, effect: "guilt" },
          },
        ],
      },
      {
        id: "neither",
        label: "Send word to the nearest watch",
        outcomes: [
          {
            weight: 100,
            text: "The watch arrives slowly to both. Both lose people. Your hands are clean of the immediate, not the eventual.",
            effects: { effect: "haunted" },
          },
        ],
      },
    ],
  },

  {
    id: "dil_inheritance",
    setup: "dilemma",
    tone: "wry",
    risk: "safe",
    theme: "greed",
    title: "A Stranger's Inheritance",
    body:
      "A solicitor flags you down. 'A distant relation has died. You are named in the will. The estate " +
      "comes with a small debt of conscience.' She does not elaborate.",
    branches: [
      {
        id: "accept_estate",
        label: "Sign the papers",
        outcomes: [
          {
            weight: 50,
            text: "A modest sum. The debt of conscience is a stipend you owe a small village. You'll manage.",
            effects: { gold: 30, xp: 6 },
          },
          {
            weight: 50,
            text: "The debt was larger than she let on. The sum nets out small. You feel oddly responsible.",
            effects: { gold: 10, effect: "guilt" },
          },
        ],
      },
      {
        id: "refuse",
        label: "Refuse the inheritance",
        outcomes: [
          {
            weight: 100,
            text: "The solicitor nods. The estate dissolves to the next-of-kin. You feel clear-headed and slightly poorer.",
            effects: { xp: 12 },
          },
        ],
      },
      {
        id: "donate",
        label: "Sign and donate it all",
        outcomes: [
          {
            weight: 80,
            text: "The village names a fountain after you. You'll never see it. That's fine.",
            effects: { xp: 24, mana: 8 },
          },
          {
            weight: 20,
            text: "Most of it is absorbed by paperwork. A little reaches the village. The village writes you a kind letter.",
            effects: { xp: 8 },
          },
        ],
      },
    ],
  },

  {
    id: "dil_witness_or_walk",
    setup: "dilemma",
    tone: "grim",
    risk: "mixed",
    theme: "fear",
    title: "A Witness or a Walk Away",
    body:
      "You round a bend and see something you weren't meant to: two strangers arguing over a body that's " +
      "still warm. They haven't noticed you. Yet.",
    branches: [
      {
        id: "intervene",
        label: "Step forward",
        outcomes: [
          {
            weight: 40,
            text: "One of them was the killer. The other helps you bind them. Justice is messy and good.",
            effects: { gold: 12, xp: 20, hp: -6 },
          },
          {
            weight: 30,
            text: "It is not what it looks like. You apologize at length. Nobody is hurt further.",
            effects: { xp: 6 },
          },
          {
            weight: 30,
            text: "They turn on you both. You barely get away.",
            effects: { hp: -14 },
          },
        ],
      },
      {
        id: "report_later",
        label: "Slip away, report it later",
        outcomes: [
          {
            weight: 70,
            text: "The watch finds them by the time you've crossed the next stream. The bounty mailed to you is real.",
            effects: { gold: 18, effect: "guilt" },
          },
          {
            weight: 30,
            text: "By the time the watch arrives the scene is gone. You'll never know how it ends.",
            effects: { effect: "haunted" },
          },
        ],
      },
      {
        id: "walk_away",
        label: "Pretend you never saw",
        outcomes: [
          {
            weight: 100,
            text: "You walk. The road forgives you, mostly.",
            effects: { effect: "guilt" },
          },
        ],
      },
    ],
  },

  {
    id: "dil_quarantine",
    setup: "dilemma",
    tone: "grim",
    risk: "dangerous",
    theme: "fear",
    title: "A Town Under Quarantine",
    body:
      "A red flag flaps at the gates. A guard with a stained mask waves you off. 'Plague-watch. Two more " +
      "days. No one in, no one out.' Inside the wall you can hear a child crying.",
    branches: [
      {
        id: "respect_quarantine",
        label: "Camp outside the wall",
        outcomes: [
          {
            weight: 90,
            text: "Two cold days, no incidents. You move on healthy, and the town lifts the flag behind you.",
            effects: { xp: 10 },
          },
          {
            weight: 10,
            text: "Two cold days. You get sick anyway, mildly. Bad luck.",
            effects: { hp: -8 },
          },
        ],
      },
      {
        id: "sneak_in",
        label: "Sneak in to help",
        outcomes: [
          {
            weight: 40,
            text: "You bring medicine, find the kid, save them. You leave coughing but proud.",
            effects: { xp: 26, hp: -10 },
          },
          {
            weight: 60,
            text: "You bring medicine. The kid was already past saving. You leave coughing and quieter.",
            effects: { xp: 12, hp: -14, effect: "guilt" },
          },
        ],
      },
      {
        id: "go_around",
        label: "Detour around the town",
        outcomes: [
          {
            weight: 100,
            text: "The detour is long. You don't look back when you hear the wall behind you. The road goes on.",
          },
        ],
      },
    ],
  },

  {
    id: "dil_apprentice",
    setup: "dilemma",
    tone: "wry",
    risk: "safe",
    theme: "mercy",
    title: "An Apprentice Begs to Come Along",
    body:
      "A teenager runs up the road behind you, panting. 'Take me with you. Anywhere. I can carry packs. " +
      "I can fight. I'll work for food.' Their boots are wrong. Their eyes are right.",
    branches: [
      {
        id: "take_them",
        label: "Take them on",
        outcomes: [
          {
            weight: 60,
            text: "They are useful and brave. The road feels less lonely.",
            effects: { xp: 14, effect: "companion" },
          },
          {
            weight: 40,
            text: "They slow you down for a day and then quietly head home. Both of you learned something.",
            effects: { xp: 6 },
          },
        ],
      },
      {
        id: "send_home",
        label: "Send them home",
        outcomes: [
          {
            weight: 80,
            text: "They sulk. They go. You hope it sticks.",
            effects: { xp: 4 },
          },
          {
            weight: 20,
            text: "They sulk, go, then trail you anyway at a distance. The road is wide. You let it be.",
          },
        ],
      },
      {
        id: "give_coin",
        label: "Give them coin for the trip back (5g)",
        outcomes: [
          {
            weight: 100,
            text: "They thank you with grave teenage formality and walk away. Sometimes mercy looks like a coin.",
            effects: { gold: -5, xp: 10 },
          },
        ],
      },
    ],
  },

  {
    id: "dil_kill_or_release",
    setup: "dilemma",
    tone: "grim",
    risk: "dangerous",
    theme: "fear",
    title: "Kill the Snake or Let It Go",
    body:
      "A wounded animal — let's call it a snake, though it has too many wings for the word — looks up " +
      "from a snare trap. It is not afraid of you. It is too tired to be.",
    branches: [
      {
        id: "mercy_kill",
        label: "End it cleanly",
        outcomes: [
          {
            weight: 70,
            text: "You harvest a fang and a strip of skin worth real coin.",
            effects: { gold: 16, item: "🔧 Spare Parts" },
          },
          {
            weight: 30,
            text: "Clean death. No spoils. You leave a little heavier.",
            effects: { effect: "guilt" },
          },
        ],
      },
      {
        id: "release",
        label: "Free it",
        outcomes: [
          {
            weight: 60,
            text: "It lopes off into the brush. A week later you hear of a winged snake saving someone's life. Could be the same one.",
            effects: { xp: 22, mana: 10 },
          },
          {
            weight: 40,
            text: "It limps away. Whatever happens to it, you don't see.",
            effects: { xp: 8 },
          },
        ],
      },
      {
        id: "leave_it",
        label: "Walk on",
        outcomes: [
          {
            weight: 100,
            text: "You leave the snare set. Whatever finds the snake first gets the choice you didn't make.",
            effects: { effect: "guilt" },
          },
        ],
      },
    ],
  },

  {
    id: "dil_rigged_lottery",
    setup: "dilemma",
    tone: "wry",
    risk: "mixed",
    theme: "greed",
    title: "A Rigged Lottery",
    body:
      "A small carnival booth runs a lottery you can prove is rigged. The booth-keep doesn't know you " +
      "know. There's a real winner — a thin kid clutching their ticket — and a real loser, who is also you.",
    branches: [
      {
        id: "expose",
        label: "Expose the rig",
        outcomes: [
          {
            weight: 60,
            text: "The kid gets paid. The booth-keep skips town. You take a cut of the abandoned till.",
            effects: { gold: 18, xp: 12 },
          },
          {
            weight: 40,
            text: "The crowd believes the booth-keep over you. You leave embarrassed and lighter.",
            effects: { gold: -5, hp: -3 },
          },
        ],
      },
      {
        id: "exploit",
        label: "Buy your way into the rig",
        outcomes: [
          {
            weight: 60,
            text: "You bribe in. You win. Coin is coin.",
            effects: { gold: 24, effect: "guilt" },
          },
          {
            weight: 40,
            text: "The booth-keep takes your bribe and bolts. You learn a small expensive lesson.",
            effects: { gold: -12 },
          },
        ],
      },
      {
        id: "walk_on",
        label: "Walk on",
        outcomes: [
          {
            weight: 100,
            text: "The booth keeps shouting after you. The road is quieter just past the fairgrounds.",
          },
        ],
      },
    ],
  },

  {
    id: "dil_split_party",
    setup: "dilemma",
    tone: "wry",
    risk: "mixed",
    theme: "curiosity",
    title: "Split the Party?",
    body:
      "Two trails fork off at a stream. One promises faster travel, one promises a small ruin and " +
      "possibly loot. You could split up. You'd cover more ground. You'd also each be alone.",
    branches: [
      {
        id: "split_up",
        label: "Split the party",
        outcomes: [
          {
            weight: 50,
            text: "Both halves come back with stories and small spoils. Everyone learned something.",
            effects: { gold: 12, xp: 14 },
          },
          {
            weight: 50,
            text: "One half hits trouble. You patch them up at the regroup. Net loss, but everyone alive.",
            effects: { hp: -10, gold: 6 },
          },
        ],
      },
      {
        id: "stay_together",
        label: "Stay together — take the ruin",
        outcomes: [
          {
            weight: 70,
            text: "Slow but safe. A modest haul.",
            effects: { gold: 16 },
          },
          {
            weight: 30,
            text: "Slow and unrewarding. But you all sleep in the same fire-light tonight.",
            effects: { hp: 4 },
          },
        ],
      },
      {
        id: "stay_safe",
        label: "Stay together — take the fast road",
        outcomes: [
          {
            weight: 100,
            text: "You make good time. The ruin will be there for someone else.",
            effects: { xp: 6 },
          },
        ],
      },
    ],
  },

  {
    id: "dil_trade_levels",
    setup: "dilemma",
    tone: "weird",
    risk: "mixed",
    theme: "curiosity",
    title: "Trade Knowledge for Speed",
    body:
      "A robed figure offers a strange bargain at the wayside. 'I will give you a shortcut through the " +
      "ridge. The cost: a piece of what you know. You will not miss it.'",
    branches: [
      {
        id: "accept_trade",
        label: "Take the shortcut",
        outcomes: [
          {
            weight: 60,
            text: "You arrive at the next camp days early and missing a small useful fact you can't quite remember.",
            effects: { xp: -8, gold: 12 },
          },
          {
            weight: 40,
            text: "The shortcut works. The price never feels collected. Maybe later.",
            effects: { gold: 6 },
          },
        ],
      },
      {
        id: "ask_price_first",
        label: "Ask which piece",
        outcomes: [
          {
            weight: 80,
            text: "She names a fact too small to mourn. You hand it over and take the shortcut.",
            effects: { xp: 4, gold: 10 },
          },
          {
            weight: 20,
            text: "She names a fact too dear to spare. You walk on the long way.",
            effects: { xp: 6 },
          },
        ],
      },
      {
        id: "refuse",
        label: "Refuse",
        outcomes: [
          {
            weight: 100,
            text: "She nods, polite as a teacher dismissing a student. The road goes on.",
          },
        ],
      },
    ],
  },

  {
    id: "dil_press_release",
    setup: "dilemma",
    tone: "wry",
    risk: "mixed",
    theme: "fear",
    title: "Take the Blame, or the Glory",
    body:
      "A messenger catches up to you with two scrolls. One: a press release naming you the hero of a " +
      "disaster you only marginally helped with. The other: a confession assigning you blame for it. " +
      "Sign one. Sign neither.",
    branches: [
      {
        id: "sign_glory",
        label: "Sign the glory",
        outcomes: [
          {
            weight: 60,
            text: "You're famous for a week. The coin that comes with it is real.",
            effects: { gold: 24, effect: "guilt" },
          },
          {
            weight: 40,
            text: "Fame finds someone else more interesting tomorrow. You keep the coin.",
            effects: { gold: 18 },
          },
        ],
      },
      {
        id: "sign_blame",
        label: "Sign the blame",
        outcomes: [
          {
            weight: 50,
            text: "A friend who was actually at fault visits you in private to repay the favor.",
            effects: { gold: 14, xp: 20 },
          },
          {
            weight: 50,
            text: "You get pilloried for a week. It passes. You sleep clearer for it.",
            effects: { hp: -6, xp: 14 },
          },
        ],
      },
      {
        id: "sign_neither",
        label: "Sign neither",
        outcomes: [
          {
            weight: 100,
            text: "The messenger shrugs and rides on. The story finds its own shape without your name.",
            effects: { xp: 6 },
          },
        ],
      },
    ],
  },
];
