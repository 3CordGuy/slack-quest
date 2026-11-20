// The dealer in the pub, who leans on the pillar at the end of the bar: word
// on the regulars' errands, who is in today and what each wants.

import { PUB_DEALER } from "@gantt-quest/world";
import { DragPanel } from "../DragPanel";
import { regularFace } from "../RegularPanel";
import { ErrandsNotice } from "./ErrandsNotice";
import "./board.css";

export function DealerPanel({ onClose }: { onClose(): void }) {
  return (
    <DragPanel id="pub.dealer" title="Errands" className="story panel pub-bar regular-panel dealer-panel" role="dialog" aria-label={`${PUB_DEALER.name}, ${PUB_DEALER.trade}`}>
      <div className="regular-head">
        <img className="regular-face" src={regularFace(PUB_DEALER.look)} alt="" />
        <div className="grow">
          <h3>{PUB_DEALER.name} <span className="muted">· {PUB_DEALER.trade}</span></h3>
          <p className="salesman-says">“Who's in today, and what they want doing. Read it close; nobody here pays for good intentions.”</p>
        </div>
        <button className="small" onClick={onClose}>Close</button>
      </div>
      <div className="dealer-body">
        <h3>Errands at the pub</h3>
        <ErrandsNotice />
      </div>
    </DragPanel>
  );
}
