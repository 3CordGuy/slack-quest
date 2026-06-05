// "NPC quest-bite" events — short transactional asks.
// Pass 1 ships 2; full pool target is ~10.

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
];
