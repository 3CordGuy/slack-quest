// Ship lobby: each hero may take one of the contract dealer's contracts before sailing.

import { CONTRACTS, contractsFor, rewardText, type ClientState } from "@gantt-quest/world";
import type { RunConnection } from "../useRun";
import { RewardChips } from "../hutDrops";
import "./board.css";

export function ContractPicker({ state, run }: { state: ClientState; run: RunConnection }) {
  const taken = state.heroes.find((h) => h.id === state.you)?.contract?.id ?? null;
  return (
    <div className="contracts">
      <h3>Take a contract</h3>
      <p className="muted">One each, from the contract dealer in the pub. It pays a bonus if you meet its terms and {state.kind === "caverns" ? "the whole crew climbs back out" : "the story is won"}.</p>
      <ul className="contract-list">
        {contractsFor(state.kind).map((c) => (
          <li key={c.id}>
            <button
              className={`contract ${taken === c.id ? "selected" : ""}`}
              aria-pressed={taken === c.id}
              // Clicking the one you hold puts it back.
              onClick={() => run.send({ type: "contract", contractId: taken === c.id ? null : c.id })}
            >
              <strong>{c.name}</strong>
              <span className="contract-reward" title={rewardText(c.reward)}><RewardChips gold={c.reward.gold} resources={c.reward.resources} /></span>
              <span className="contract-terms">{c.text}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Dry voyage" after a hero's name in the lobby list, if they have taken one. */
export function contractName(id: string | undefined): string | null {
  return CONTRACTS.find((c) => c.id === id)?.name ?? null;
}
