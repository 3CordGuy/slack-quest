// Ending screen: how your contract came out.

import { contractById, rewardText, type ClientState } from "@gantt-quest/world";
import "./board.css";

export function ContractResult({ state }: { state: ClientState }) {
  const taken = state.heroes.find((h) => h.id === state.you)?.contract;
  const def = taken ? contractById(taken.id) : undefined;
  if (!taken || !def) return null;
  const met = taken.outcome === "met";
  const won = state.result?.outcome === "victory";
  return (
    <div className={`contract-result ${met ? "met" : ""}`}>
      <p>Contract: <strong>{def.name}</strong> · <span className={met ? "good" : "bad"}>{met ? "fulfilled" : "not fulfilled"}</span></p>
      <p className="muted">
        {met ? `Bonus paid: ${rewardText(def.reward)} (included below).` : won ? `${def.text} No bonus this time.` : state.kind === "caverns" ? "Contracts only pay when the crew climbs back out." : "Contracts only pay on a won story."}
      </p>
    </div>
  );
}
