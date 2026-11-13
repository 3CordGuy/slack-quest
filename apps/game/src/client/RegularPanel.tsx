// A word with one of the pub's regulars: who they are, the job they have
// going, how far along you are with it, and what it pays. The terms and the
// pay come from the server; the buttons only name the regular.

import { useState } from "react";
import { QUEST_TEXT, RESOURCE_KINDS, RESOURCE_LABEL, regular, type Errand, type ErrandReward, type Resources } from "@gantt-quest/world";
import { api, type ErrandPaid, type RegularsView } from "./api";
import { DragPanel } from "./DragPanel";
import { spriteDataUrl } from "./render/sprites";
import { GOLD_ICON, ThingIcon, resourceIcon } from "./thingIcons";

type RegularView = RegularsView["regulars"][number];

// toDataURL is not free: draw each face once.
const faces = new Map<string, string>();
export function regularFace(look: string): string {
  let url = faces.get(look);
  if (!url) faces.set(look, (url = spriteDataUrl(look)));
  return url;
}

/** One material asked for, with what you hold toward it: "3/4 copper". */
function Need({ need, have }: { need: Resources; have?: Resources }) {
  return (
    <ul className="errand-needs">
      {RESOURCE_KINDS.filter((k) => (need[k] ?? 0) > 0).map((k) => {
        const got = have?.[k];
        const ok = got !== undefined && got >= need[k]!;
        return (
          <li key={k} className={have ? (ok ? "good" : "") : ""}>
            <ThingIcon icon={resourceIcon(k)} size={18} />
            {have ? <span><strong>{got}/{need[k]}</strong> {RESOURCE_LABEL[k].toLowerCase()}</span> : <span><strong>{need[k]}</strong> {RESOURCE_LABEL[k].toLowerCase()}</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** What a job pays: XP, gold and any materials, each with its icon. */
function Pay({ reward, get }: { reward: ErrandReward; get?: Resources }) {
  const things = { ...(get ?? {}), ...(reward.resources ?? {}) };
  return (
    <span className="errand-pay">
      {RESOURCE_KINDS.filter((k) => (things[k] ?? 0) > 0).map((k) => (
        <span key={k} className="errand-chip"><ThingIcon icon={resourceIcon(k)} size={18} />{things[k]} {RESOURCE_LABEL[k].toLowerCase()}</span>
      ))}
      {reward.gold > 0 && <span className="errand-chip"><ThingIcon icon={GOLD_ICON} size={18} />{reward.gold}g</span>}
      {reward.xp > 0 && <span className="errand-chip xp">+{reward.xp} XP</span>}
    </span>
  );
}

/** The terms of a job, as its row shows them. */
function Terms({ errand, have, ready }: { errand: Errand; have?: Resources; ready?: boolean }) {
  if (errand.kind === "fetch") return <><Need need={errand.need} have={have} /><div className="errand-for">Pays <Pay reward={errand.reward} /></div></>;
  if (errand.kind === "trade") return <><Need need={errand.give} have={have} /><div className="errand-for">For <Pay reward={errand.reward} get={errand.get} /></div></>;
  return (
    <>
      <p className={`errand-goal ${ready ? "good" : ""}`}>{ready ? "✓ " : ""}{QUEST_TEXT[errand.goal]}.{ready === false && <span className="muted"> Not yet.</span>}</p>
      <div className="errand-for">Pays <Pay reward={errand.reward} /></div>
    </>
  );
}

/** "You hand over 4 wood. +6 XP, 25 gold." */
function paidText(p: ErrandPaid): string {
  const got = [p.reward.gold > 0 ? `${p.reward.gold} gold` : "", ...RESOURCE_KINDS.filter((k) => (p.reward.resources?.[k] ?? 0) > 0).map((k) => `${p.reward.resources![k]} ${RESOURCE_LABEL[k].toLowerCase()}`)].filter(Boolean);
  return [got.length > 0 ? `You get ${got.join(" and ")}.` : "", p.xp?.text ?? ""].filter(Boolean).join(" ");
}

export function RegularPanel({ view, handedIn, cap, reload, refresh, onClose }: {
  view: RegularView;
  handedIn: number;
  cap: number;
  /** Fetch the regulars again. */
  reload(): Promise<unknown>;
  /** Fetch the hero again (gold, level). */
  refresh(): Promise<unknown>;
  onClose(): void;
}) {
  const who = regular(view.regular)!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { offer, held } = view;

  const act = async (action: "accept" | "handin" | "trade" | "drop") => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await api.errand(who.id, action);
      if (action === "accept") setDone("“Good. Don't keep me waiting.”");
      else if (action === "drop") setDone("“Suit yourself.”");
      else if (res.reward) setDone(`“${action === "trade" ? "Pleasure." : "Much obliged."}” ${paidText(res as ErrandPaid)}`);
      await Promise.all([reload(), action === "handin" || action === "trade" ? refresh() : null]);
    } catch (e) {
      setError((e as Error).message);
      void reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <DragPanel id="pub.regular" title="Errand" className="story panel pub-bar regular-panel">
      <div className="regular-head">
        <img className="regular-face" src={regularFace(who.look)} alt="" />
        <div>
          <h3>{who.name} <span className="muted">· {who.trade}</span></h3>
          <p className="salesman-says">“{who.line}”</p>
        </div>
      </div>

      {held ? (
        <div className={`errand-card ${held.ready ? "ready" : ""}`}>
          <div className="errand-kind">Your job{held.errand.day !== offer.day && <span className="muted"> · from {held.errand.day}</span>}</div>
          <p className="errand-ask">“{held.errand.text}”</p>
          <Terms errand={held.errand} have={held.errand.kind === "quest" ? undefined : held.have} ready={held.errand.kind === "quest" ? held.ready : undefined} />
          {/* A quest not yet done already says so in its row. */}
          {held.problem && !(held.errand.kind === "quest" && !held.ready) && <p className="bad small-note">{held.problem}</p>}
          <div className="row">
            <button className="primary" disabled={busy || !!held.problem} title={held.problem ?? ""} onClick={() => void act("handin")}>Hand in</button>
            <button disabled={busy} onClick={() => void act("drop")}>Give up</button>
            <button disabled={busy} onClick={onClose}>Not now</button>
          </div>
        </div>
      ) : view.doneToday ? (
        <p className="muted">“That's my job done for today. Same time tomorrow?”</p>
      ) : (
        <div className="errand-card">
          <div className="errand-kind">{offer.kind === "fetch" ? "Fetch" : offer.kind === "trade" ? `Trade · ${offer.times - view.traded} of ${offer.times} left today` : "A small job"}</div>
          <p className="errand-ask">“{offer.text}”</p>
          <Terms errand={offer} have={offer.kind === "quest" ? undefined : view.have} />
          {view.problem && <p className="bad small-note">{view.problem}</p>}
          <div className="row">
            {offer.kind === "trade"
              ? <button className="primary" disabled={busy || !!view.problem} title={view.problem ?? ""} onClick={() => void act("trade")}>Trade</button>
              : <button className="primary" disabled={busy || !!view.problem} title={view.problem ?? ""} onClick={() => void act("accept")}>Accept</button>}
            <button disabled={busy} onClick={onClose}>Not now</button>
          </div>
        </div>
      )}

      {done && <p className="good">{done}</p>}
      {error && <p className="bad">{error}</p>}
      <p className="muted small-note">Jobs handed in today: {handedIn} of {cap}. XP counts toward the day's Harbor XP.</p>
    </DragPanel>
  );
}
