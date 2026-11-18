// Release notes for commits already merged, where the subject (or a missing
// Release-note trailer) did not say it well. Keyed by full commit hash; the
// value is the lines to show instead, each read like a subject
// ("Area: text"). An empty list leaves the commit out.
//
// For new work, write the subject or a Release-note: trailer instead (see
// release-notes.ts); this list is only for the past.

export const OVERRIDES: Record<string, string[]> = {
  // game-v2026.11.13.5 (#368)
  "2300bc847429c6de0e4bf348de67e8bf55f829b2": ["Sign-in: send http visits to https so returning players can sign in"],
  // game-v2026.11.15.2 (#419)
  "a75dff4189c1bef9666dcc0c09affe79e3ad6f96": [
    "Heroes: choose how your hero looks: build, head, ears, hair, eyes, nose, mustache, beard, skin and hair colour",
    "Heroes: draw your own tattoos on a paper doll, in greys and muted colours",
    "Heroes: existing heroes get a look from their class; change it any time with Change look on your hero sheet",
    "Heroes: starting hat, tunic, trousers and shoes are items you can take off",
  ],
  // game-v2026.11.18 (#500). Left off the board by a "Release-note: skip" on three commits inside the squash.
  "c15abb8e37d3838186b85b7b9fe80ff44678ce7d": [
    "Atlas: a world for your crew to explore, opened from the lighthouse; clear a place to open the ones beyond it",
    "Atlas: places differ by climate and by kind (landfalls, sea caves, lookouts and lairs), and clearing one pays everyone there a bounty",
    "Lodestones: found in bounties and kept in your pack; put one into a far-off place's slot to set out, and what it carries makes that map harder or richer",
    "Stonecutter's bench: beside the smithy, cut a plain lodestone, or fuse, attune, temper and reroll the ones you carry",
    "Town chest: a chest in the town square that the whole crew shares, with tabs you can buy, name, colour and reorder",
    "Harbor: a bigger town square with the notice board and the town chest at its head; one hut plot has moved up the lane to the caverns",
    "Harbor: click the notice board, town chest, stonecutter's bench or market stall to walk up and open it",
  ],
  // game-v2026.11.18 (#494). Left off the board by a "Release-note: skip" on one commit inside the squash.
  "1c738e6bd932583bec48e4feb8f245826e48944f": [
    "Abilities: every class has abilities of its own; choose three on the Skills page of your logbook, in the Harbor, on top of what your weapon gives",
    "Abilities: every weapon gives two abilities of its own, in place of the old ones",
    "Classes: the Paladin is now the Lighthouse Paladin and the Warden the Tidewall Warden",
    "Warden: the Boarding Pike replaces the Lamp Hook, and the Bell-Buoy Maul is the starting weapon",
    "Fights: the ability bar holds ten a row (keys 1 to 9 and 0, the bottom row with Shift), and a cooldown shows as a big number on its slot",
    "Fights: a shield shows as a pale stretch on health bars, and an aura shows its reach as a dashed outline",
    "Fights: the ring and sparks from a landing spell or flask no longer stay frozen on the ground",
  ],
};
