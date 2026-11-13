// The notice board's word on the pub's regulars: who is in today, what each
// wants, and where this hero stands with each job (including jobs held with
// regulars who are not in today). Read-only; the jobs are taken and handed in
// at the pub.

import { useEffect, useState } from "react";
import { QUEST_TEXT, materialsText, regular, type Errand } from "@gantt-quest/world";
import { api, type RegularsView } from "../api";
import { RewardChips } from "../hutDrops";

/** What a job asks, in a few words for its line. */
function ask(e: Errand): string {
  if (e.kind === "fetch") return `Wants ${materialsText(e.need)}.`;
  if (e.kind === "trade") return `Gives ${materialsText(e.get)} for ${materialsText(e.give)}, ${e.times} times a day.`;
  return `${QUEST_TEXT[e.goal]}.`;
}

/** Pay shown on a line: a trade's pay is what it gives back. */
const pay = (e: Errand) => (e.kind === "trade" ? { gold: 0, resources: e.get } : { gold: e.reward.gold, resources: e.reward.resources });

export function ErrandsNotice() {
  const [view, setView] = useState<RegularsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.regulars().then(setView, (e: Error) => setError(e.message));
  }, []);

  if (error) return null;
  if (!view) return <p className="muted">Asking after the regulars…</p>;
  return (
    <>
      <p className="muted">Small jobs from the pub's regulars, for a little XP and some gold or materials. Take them on and hand them in at the pub; {view.cap} a day. Handed in today: {view.handedIn} of {view.cap}.</p>
      <ul className="notice-list errands-list">
        {view.regulars.map((r) => {
          const who = regular(r.regular)!;
          const job = r.held?.errand ?? r.offer;
          const status = r.held ? (!r.held.ready ? <span className="gold-text">Yours, under way.</span> : r.held.problem ? <span className="gold-text">Yours and ready. {r.held.problem}</span> : <span className="good">Yours, ready to hand in.</span>)
            : r.doneToday ? <span className="good">Done today.</span>
            : r.offer.kind === "trade" && r.traded > 0 ? <span className="muted">Traded {r.traded} of {r.offer.times} today.</span>
            : null;
          return (
            <li key={r.regular}>
              <strong>{who.name} <span className="muted">· {job.kind === "fetch" ? "fetch" : job.kind === "trade" ? "trade" : "small job"}</span></strong>
              <span className="contract-reward"><RewardChips {...pay(job)} /> <span className="errand-xp">+{job.reward.xp} XP</span></span>
              <span className="muted">{ask(job)} {status}</span>
            </li>
          );
        })}
        {view.away.map((a) => {
          const who = regular(a.errand.regular)!;
          return (
            <li key={a.errand.id} className="away">
              <strong>{who.name} <span className="muted">· not in today</span></strong>
              <span className="contract-reward"><RewardChips {...pay(a.errand)} /> <span className="errand-xp">+{a.errand.reward.xp} XP</span></span>
              <span className="muted">{ask(a.errand)} {a.ready ? <span className="good">Yours, ready to hand in when they are back.</span> : <span className="gold-text">Yours, under way.</span>}</span>
            </li>
          );
        })}
      </ul>
    </>
  );
}
