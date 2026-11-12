// The Harbor's notice board: the crew's shared goal for the week, and the
// contracts a hero can take aboard a ship.

import { useEffect, useState } from "react";
import { rewardText } from "@gantt-quest/world";
import { api, type Board } from "../api";
import { DragPanel } from "../DragPanel";
import "./board.css";

function timeLeft(endsAt: number): string {
  const hours = Math.max(1, Math.ceil((endsAt - Date.now()) / 3_600_000));
  return hours >= 48 ? `${Math.floor(hours / 24)} days` : `${hours} hour${hours === 1 ? "" : "s"}`;
}

export function NoticeBoard({ refresh, onClose }: { refresh(): Promise<unknown>; onClose(): void }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.board().then(setBoard, (e: Error) => setError(e.message));
    // A filled goal pays gold while you are away; pick up the new total.
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const goal = board?.goal;

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <DragPanel id="harbor.notices" title="Notice board" compact className="panel notice-board" role="dialog" aria-label="Notice board">
        <header className="notice-head">
          <h2>Notice board</h2>
          <span className="spacer" />
          <button className="small" onClick={onClose}>Close</button>
        </header>
        {error && <p className="bad">{error}</p>}
        {!board && !error && <p className="muted">Reading the notices…</p>}
        {board && (
          <>
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
                  <span>Pays every crew member <strong>{goal.reward} gold</strong> when it is filled.</span>
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
                  <span className="contract-reward">{rewardText(c.reward)}</span>
                  <span className="muted">{c.text}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </DragPanel>
    </div>
  );
}
