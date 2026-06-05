// "Discovery" events — the party stumbles across an object or place.
// Pass 1 ships 3; full pool target is ~15.

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
];
