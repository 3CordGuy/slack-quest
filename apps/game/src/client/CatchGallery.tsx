// Every catch side by side: its pixel sprite, and its 3D model side-on and
// from three-quarters, page by page as the Catch Book lays them out. For
// checking that the sprites and models match, and that nothing is missing.
// Admins only, and anyone on the dev server.

import { useMemo } from "react";
import { BOOK_PAGES, bookPage, formatLength, formatWeight, type BookPage } from "@gantt-quest/world";
import { catchIcon, catchPicture } from "./render/catchArt";
import "./fishing.css";

const PAGE_NAME: Record<BookPage, string> = { shallows: "Shallows", mouth: "Harbor Mouth", deep: "Deep & Rocky", sea: "Open Sea", strays: "Strays", flotsam: "Flotsam", bonus: "Bonus" };

export function CatchGallery({ onLeave }: { onLeave(): void }) {
  const pages = useMemo(
    () => BOOK_PAGES.map((page) => ({ page, rows: bookPage(page).map((f) => ({ f, icon: catchIcon(f.id), side: catchPicture(f.id, 200, "side"), three: catchPicture(f.id, 200, "three") })) })),
    [],
  );
  return (
    <div className="catch-gallery">
      <header>
        <h1>Catches</h1>
        <span className="muted">Each catch's sprite beside its model. The sprite is drawn from the model.</span>
        <span className="spacer" />
        <button onClick={onLeave}>Back</button>
      </header>
      {pages.map(({ page, rows }) => (
        <section key={page}>
          <h2>{PAGE_NAME[page]} <span className="muted">· {rows.length}</span></h2>
          <div className="catch-grid">
            {rows.map(({ f, icon, side, three }) => (
              <figure key={f.id} className={f.rarity}>
                <div className="catch-shots">
                  <img className="catch-sprite" src={icon} alt="" width={80} height={80} />
                  <img src={side} alt="" width={120} height={120} />
                  <img src={three} alt="" width={120} height={120} />
                </div>
                <figcaption>
                  <strong>{f.name}</strong>
                  <span className="muted">{f.rarity} · {f.shape}{f.pattern ? ` · ${f.pattern}` : ""} · {formatLength(f.lengthCm[1] * 10)}, {formatWeight(f.weightKg[1] * 1000)}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
