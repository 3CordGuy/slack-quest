// "Encounter" events — a person or creature crosses the party's path.
// Pass 1 ships 3; target for the full pool is ~20.

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
];
