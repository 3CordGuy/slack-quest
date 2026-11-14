// Opening a table at one of the pub's games: free, a stake picked with one
// click, or any other amount typed in, up to STAKE_MAX. Shared by the dice,
// Shoals, and Cargo and Krakens tables.

import { useState } from "react";
import { STAKE_MAX, STAKE_PICKS, stakeLabel } from "@gantt-quest/world";

export function StakePicker({ gold, again, open, also = "" }: {
  gold: number;
  /** A game has just ended here: "Another game" rather than "Open a table". */
  again: boolean;
  open(ante: number): void;
  /** Said after the stake in each button's hint, such as ", for 3 rounds". */
  also?: string;
}) {
  const [typed, setTyped] = useState("");
  const amount = typed.trim() === "" ? null : Number(typed);
  const valid = amount !== null && Number.isInteger(amount) && amount >= 0 && amount <= STAKE_MAX;
  const tooDear = valid && amount > gold;
  const hint = (a: number) => (gold < a ? "You cannot afford this stake" : a === 0 ? `Open a table for nothing, just for the game${also}` : `Open a table at ${a} gold a seat${also}`);
  return (
    <>
      <span>{again ? "Another game:" : "Open a table:"}</span>
      {STAKE_PICKS.map((a) => (
        <button key={a} className="small" disabled={gold < a} title={hint(a)} onClick={() => open(a)}>
          {a === 0 ? "Free" : stakeLabel(a)}
        </button>
      ))}
      <span className="stake-own">
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={STAKE_MAX}
          step={1}
          value={typed}
          placeholder="Other"
          aria-label={`Any stake, up to ${STAKE_MAX} gold`}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && valid && !tooDear && open(amount)}
        />
        <button className="small" disabled={!valid || tooDear} title={!valid ? `A whole number of gold, from 0 to ${STAKE_MAX}` : tooDear ? "You cannot afford this stake" : hint(amount)} onClick={() => valid && open(amount)}>
          Open
        </button>
      </span>
      <span className="muted">You have {gold}.</span>
    </>
  );
}

/** The seated players' note before a game: when the stake is taken, if there is one. */
export const anteNote = (ante: number) => (ante > 0 ? "The ante is taken when the game starts." : "A free game: no gold changes hands.");
