// The contract dealer in the pub, who leans on the pillar at the end of the
// bar: the crew's shared goal for the week, the contracts a hero can take
// aboard a ship, and word on the regulars' errands. (This used to be the
// Harbor's notice board, which now carries the game's release notes.)

import { useEffect, useState } from "react";
import { PUB_DEALER, rewardText } from "@gantt-quest/world";
import { api, type Board } from "../api";
import { DragPanel } from "../DragPanel";
import { RewardChips } from "../hutDrops";
import { regularFace } from "../RegularPanel";
import { ErrandsNotice } from "./ErrandsNotice";
import "./board.css";

function timeLeft(endsAt: number): string {
  const hours = Math.max(1, Math.ceil((endsAt - Date.now()) / 3_600_000));
  return hours >= 48 ? `${Math.floor(hours / 24)} days` : `${hours} hour${hours === 1 ? "" : "s"}`;
}

export function DealerPanel({ refresh, onClose }: { refresh(): Promise<unknown>; onClose(): void }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.contracts().then(setBoard, (e: Error) => setError(e.message));
    // A filled goal pays gold while you are away; pick up the new total.
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const goal = board?.goal;

  return (
    <DragPanel id="pub.dealer" title="Contracts" className="story panel pub-bar regular-panel dealer-panel" role="dialog" aria-label={`${PUB_DEALER.name}, ${PUB_DEALER.trade}`}>
      <div className="regular-head">
        <img className="regular-face" src={regularFace(PUB_DEALER.look)} alt="" />
        <div className="grow">
          <h3>{PUB_DEALER.name} <span className="muted">· {PUB_DEALER.trade}</span></h3>
          <p className="salesman-says">“Contracts for the voyage, and what the crew's after this week. Read them close; I don't pay for good intentions.”</p>
        </div>
        <button className="small" onClick={onClose}>Close</button>
      </div>
      {error && <p className="bad">{error}</p>}
      {!board && !error && <p className="muted">Leafing through the papers…</p>}
      {board && (
        <div className="dealer-body">
          <h3>Crew goal this week</h3>
          {goal ? (
            <div className={`crew-goal ${goal.rewarded ? "filled" : ""}`}>
              <strong>{goal.text}</strong>
              <span className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={goal.target} aria-valuenow={goal.progress}>
                <span className="bar-fill goal" style={{ width: `${(100 * goal.progress) / goal.target}%` }} />
                <span>{goal.progress} / {goal.target}</span>
              </span>
              {goal.rewarded ? (
                <span className="good">Filled. Every crew member was paid {goal.reward} gold.</span>
              ) : (
                <span className="with-icon">Pays every crew member <RewardChips gold={goal.reward} /> when it is filled.</span>
              )}
              <span className="muted">Any voyage from this Harbor counts. A new goal is posted in {timeLeft(goal.endsAt)}.</span>
            </div>
          ) : (
            <p className="muted">No goal is posted right now.</p>
          )}

          <h3>Contracts</h3>
          <p className="muted">Take one aboard a ship before it sails. It pays if you meet its terms and the story is won.</p>
          <ul className="notice-list">
            {board.contracts.map((c) => (
              <li key={c.id}>
                <strong>{c.name}</strong>
                <span className="contract-reward" title={rewardText(c.reward)}><RewardChips gold={c.reward.gold} resources={c.reward.resources} /></span>
                <span className="muted">{c.text}</span>
              </li>
            ))}
          </ul>

          <h3>Errands at the pub</h3>
          <ErrandsNotice />
        </div>
      )}
    </DragPanel>
  );
}
