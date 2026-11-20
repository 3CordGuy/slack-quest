// The announcement: a band that sweeps across the upper middle of the view
// and is gone a moment later. A fight breaking out ("Combat · Roll for
// initiative"), a new round, whose turn it is, and how it ended.
//
// Your own turn is the event: gold, twice the size of anyone else's, struck
// in with a flare behind it. A crewmate's is small and sea-green; an enemy's
// small and red, coming from the other side. The view hands in what to show
// with an id; a new id plays it again, and the band takes itself away when
// it has played. It never takes a press: the map under it stays clickable.

import { useEffect, useState } from "react";
import "./fight.css";

export type TurnBannerKind = "yours" | "ally" | "enemy" | "round" | "fight" | "victory" | "defeat" | "cleared";

export interface TurnBannerShow {
  /** A new id plays the banner again, even with the same words. */
  id: number;
  kind: TurnBannerKind;
  title: string;
  sub?: string;
}

export interface TurnBannerProps {
  show: TurnBannerShow | null;
}

/** How long each kind stays, in milliseconds: its `--dur` in fight.css, and a little over. */
export const BANNER_MS: Record<TurnBannerKind, number> = { yours: 2100, ally: 1500, enemy: 1500, round: 1700, fight: 2400, victory: 3000, defeat: 3200, cleared: 2600 };

export function TurnBanner({ show }: TurnBannerProps) {
  /** The id of the banner that has finished playing: it is not drawn again until a new one comes. */
  const [done, setDone] = useState<number | null>(null);
  const id = show?.id ?? null;
  const kind = show?.kind;
  // The band fades itself out; this takes it off the page afterwards (and stands in where animations are off).
  useEffect(() => {
    if (id === null || !kind) return;
    const timer = setTimeout(() => setDone(id), BANNER_MS[kind] + 80);
    return () => clearTimeout(timer);
  }, [id, kind]);

  if (!show || done === show.id) return null;
  const grand = show.kind === "yours" || show.kind === "fight" || show.kind === "victory" || show.kind === "cleared";
  return (
    <div key={show.id} className={`fight-ui fight-banner ${show.kind}`} role="status" aria-live="polite">
      <div className="fb-band">
        {grand && <span className="fb-flourish" aria-hidden />}
        <div className="fb-words">
          <strong>{show.title}</strong>
          {show.sub && <span>{show.sub}</span>}
        </div>
        {grand && <span className="fb-flourish r" aria-hidden />}
        <i className="fb-shine" aria-hidden />
      </div>
    </div>
  );
}
