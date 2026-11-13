// Story panel: the contract you took and whether its terms are met right now.

import { contractById, contractMet, rewardText, type ClientState } from "@gantt-quest/world";
import "./board.css";

export function ContractStatus({ state }: { state: ClientState }) {
  const me = state.heroes.find((h) => h.id === state.you);
  const def = me?.contract ? contractById(me.contract.id) : undefined;
  if (!me || !def) return null;
  const met = contractMet(state, me);
  return (
    <p className={`contract-status ${met ? "met" : ""}`}>
      {met ? "☑" : "☐"} Contract: <strong>{def.name}</strong>. {def.text}
      <span className="muted">{met ? "Met as things stand" : "Not met yet"} · pays {rewardText(def.reward)} {state.kind === "caverns" ? "once the crew climbs out" : "if the story is won"}</span>
    </p>
  );
}
