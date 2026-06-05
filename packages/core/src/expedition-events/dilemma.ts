// "Dilemma" events — choose between bad options.
// Pass 1 ships 2; full pool target is ~15.

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
];
