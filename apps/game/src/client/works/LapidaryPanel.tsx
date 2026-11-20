// Dealing with the lapidary, standing in front of her in her shop
// (KeeperView): everything to do with lodestones and gems. She cuts a plain
// lodestone from stone and iron, works the ones you carry at her bench (fuse,
// attune, temper, reroll: atlas/StoneBench.tsx), and buys gems for gold.
//
// It stands in the same frame as the smith's, the apothecary's and the cook's
// panels (KeeperPanels.tsx): her face and her last word at the top with what
// you hold, the work scrolling under it, and "Step away" to put it away.
// Unlike theirs there is no stock and nothing to haggle over, and nothing to
// ask the server for on the way in: what you carry is in `me`.
//
// What can be done is worked out here only to grey out buttons; the server
// checks every cut, piece of work and sale again.

import { useState } from "react";
import { GEM_PRICE, KEEPER_PLACES, stoneName, type Lodestone } from "@gantt-quest/world";
import { api, type Me } from "../api";
import { StoneBench } from "../atlas/StoneBench";
import { RewardChips } from "../hutDrops";
import { ThingIcon, resourceIcon } from "../thingIcons";
import { Frame, type Said } from "./KeeperPanels";
import "./works.css";

/** What she says, out loud over her head, to each thing she does for you. */
const SAYS = {
  cut: "Plain and true. It will open a place, and no more.",
  fuse: "Three into one. Look what it kept of each.",
  attune: "It has taken it. Mind where you carry that.",
  temper: "Harder now. So is wherever it takes you.",
  reroll: "Not what it was. That is all I promise.",
  gem: "A fair stone. Done.",
  gems: "Good colour, the lot. I will take them.",
} as const;

export function LapidaryKeeperPanel({ me, refresh, onSay, onDone }: {
  me: Me;
  /** Fetch the hero again (gold, the pack, the lodestones in it). */
  refresh(): Promise<unknown>;
  /** The keeper says something out loud, over her head. */
  onSay(text: string): void;
  /** Step back from the keeper, which puts the panel away. */
  onDone(): void;
}) {
  const { keeper } = KEEPER_PLACES.lapidary;
  const [said, setSaid] = useState<Said | null>(null);
  const [busy, setBusy] = useState(false);
  const gold = me.character?.gold ?? 0;
  const held = me.materials ?? {};
  const gems = held.gem ?? 0;

  const made = (stone: Lodestone, how: keyof typeof SAYS) => {
    onSay(SAYS[how]);
    setSaid({ text: `“${SAYS[how]}” ${how === "cut" ? "A plain lodestone" : stoneName(stone)} goes into your pack.`, tone: "good" });
  };
  const sell = async (qty: number) => {
    setBusy(true);
    setSaid(null);
    try {
      const res = await api.sellGems(qty);
      await refresh();
      const line = qty === 1 ? SAYS.gem : SAYS.gems;
      onSay(line);
      setSaid({ text: `“${line}” ${qty === 1 ? "A gem" : `${qty} gems`} for ${res.gold}g.`, tone: "good" });
    } catch (e) {
      setSaid({ text: (e as Error).message, tone: "bad" });
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame
      shop="lapidary"
      said={said}
      onDone={onDone}
      hold={<p className="works-stock">You hold: <RewardChips zeros gold={gold} resources={{ gem: gems, stone: held.stone ?? 0, iron: held.iron ?? 0 }} /></p>}
    >
      <h4 className="keeper-section">Lodestones <span className="muted">· cut plain, or worked at her bench · out of your pack</span></h4>
      <StoneBench me={me} refresh={refresh} onMade={made} />

      <h4 className="keeper-section">Gems <span className="muted">· {keeper.short} buys them · {GEM_PRICE}g each</span></h4>
      <ul className="workshop-list">
        <li className={gems > 0 ? "having" : ""} data-sell="gem">
          <ThingIcon icon={resourceIcon("gem")} size={36} />
          <span className="grow">
            <strong>Gems</strong> <span className="muted">· you carry {gems}</span>
            <br />
            <span className="muted small-note">Tempering a lodestone takes gems, and so does attuning one to a boon. Sell what you will not spend.</span>
          </span>
          <span className="keeper-buttons">
            <button className="small" disabled={busy || gems < 1} onClick={() => void sell(1)}>Sell 1 · {GEM_PRICE}g</button>
            <button className="small" disabled={busy || gems < 2} onClick={() => void sell(gems)}>Sell all · {GEM_PRICE * gems}g</button>
          </span>
        </li>
      </ul>
      <p className="muted small-note lapidary-where">Gems turn up in the quarry's seams and geodes, in a pearl oyster on the line, and now and then on what you beat out on the maps.</p>
    </Frame>
  );
}
