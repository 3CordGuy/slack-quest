// Felling in the grove: the 3D stand (render/GroveStage.ts), drawn full
// screen behind the gather panel, and the choices in the panel. Tap a tree, knock on it or pick the side to notch it, then stop
// the axe. The server decides where it falls; this plays it out.

import { useEffect, useRef, useState } from "react";
import { DIR_NAMES, NOTCH_DIRS, fallOutcome, type Dir8, type FallOutcome, type GatherChoice, type GatherView, type Outfit } from "@gantt-quest/world";
import { GroveStage, OUTCOME_COLOR, windText } from "./render/GroveStage";
import { TimingBar } from "./TimingBar";

const ARROW: Record<number, string> = { 0: "↑", 2: "→", 4: "↓", 6: "←" };
const OUTCOME_WORD: Record<FallOutcome, string> = { clear: "lands clear", hung: "hangs up", creek: "into the creek", pile: "onto the pile!" };
const WIND_ARROW = ["↑", "↗", "→", "↘", "↓", "↙", "←", "↖"];

export interface GroveHero {
  kind: string;
  outfit?: Outfit;
}

export function Grove({ outing, busy, hero, host, step }: {
  outing: GatherView;
  busy: boolean;
  hero: GroveHero;
  /** The full-screen layer behind the panel that the stage draws into. */
  host: HTMLElement | null;
  step(choice: GatherChoice): Promise<void>;
}) {
  const grove = outing.grove!;
  const box = useRef<HTMLDivElement>(null);
  const stage = useRef<GroveStage | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  /** A fall is playing: hold the choices until it has landed. */
  const [falling, setFalling] = useState(false);
  const press = useRef<(() => void) | null>(null);
  /** When the timing bar's marker started, by performance.now(), so the axe keeps the same time. */
  const swingAt = useRef<number | null>(null);
  const prev = useRef<GatherView | null>(null);
  const active = outing.status === "active";

  // Callbacks the stage holds for its whole life read the latest of these.
  const latest = useRef({ outing, busy, falling, picked, step });
  latest.current = { outing, busy, falling, picked, step };

  useEffect(() => {
    if (!host) return;
    const s = new GroveStage(host, {
      onPickTree: (cell) => {
        const { outing: o, busy: b, falling: f } = latest.current;
        if (o.status !== "active" || o.aim || b || f) return;
        setPicked((p) => (p === cell ? null : cell));
      },
      onPickDir: (dir) => {
        const { picked: p } = latest.current;
        if (p !== null) aim(p, dir);
      },
      onPress: () => press.current?.(),
      onFallDone: () => setFalling(false),
      // The panel floats over the stage: frame the grove in the space beside it.
      obstruction: () => box.current?.closest(".panel")?.getBoundingClientRect() ?? null,
    }, hero);
    stage.current = s;
    // A new stage starts from the grove as it stands.
    prev.current = null;
    return () => {
      s.dispose();
      stage.current = null;
    };
    // The hero's look is fixed for the life of the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  // Play out what changed since the last view (a knock, a fall), then show the grove as it now stands.
  useEffect(() => {
    const s = stage.current;
    if (!s) return;
    const before = prev.current?.grove;
    prev.current = outing;
    if (before && before.trees.length === grove.trees.length) {
      grove.trees.forEach((t, cell) => {
        if (t.fall && !before.trees[cell].fall) {
          setFalling(true);
          s.playFall(cell, t.fall);
        }
        if (t.knocked && !before.trees[cell].knocked && t.kind) s.knock(cell, t.kind);
      });
    }
    s.setGrove(grove, outing.status);
    if (!outing.aim || !active) {
      s.clearSwing();
      swingAt.current = null;
    } else if (!s.swinging) {
      // The bar's marker may have started before the stage was made (its effect runs first): catch the axe up to it.
      s.startSwing(outing.aim.cell, outing.aim.motion, (outing.aim.dir ?? 4) as Dir8, swingAt.current ?? performance.now());
    }
  }, [outing, grove, active, host]);

  useEffect(() => {
    stage.current?.pick(active && !outing.aim ? picked : null);
  }, [picked, active, outing.aim]);

  // A tree that has gone down can't stay picked.
  useEffect(() => {
    if (picked !== null && (grove.trees[picked]?.picked || !active)) setPicked(null);
  }, [grove, picked, active]);

  const aim = (cell: number, dir: Dir8) => {
    const { busy: b, falling: f, outing: o, step: send } = latest.current;
    if (b || f || o.aim || o.status !== "active") return;
    setPicked(null);
    void send({ t: "aim", cell, dir });
  };

  const down = grove.trees.flatMap((t, i) => (t.picked ? [i] : []));
  const tree = picked !== null ? grove.trees[picked] : null;
  const locked = busy || falling || !!outing.aim;

  return (
    <div className="grove" ref={box}>
      <div className="grove-info">
        <span className="grove-wind" title="The wind carries a fall round if the swing is off the mark">
          <span className="grove-wind-arrow" aria-hidden>{grove.wind.strength === 0 ? "·" : WIND_ARROW[grove.wind.dir]}</span>
          {windText(grove.wind)}
        </span>
        <span className="muted">Knocks left: {grove.knocksLeft}</span>
        <span className="spacer" />
        <span className="grove-legend">
          {(Object.keys(OUTCOME_COLOR) as FallOutcome[]).map((o) => (
            <span key={o}><i style={{ background: OUTCOME_COLOR[o] }} />{o === "clear" ? "clear" : o === "hung" ? "hangs up" : o}</span>
          ))}
        </span>
      </div>

      {outing.aim && active && (
        <TimingBar
          aim={outing.aim}
          spot="felling"
          busy={busy}
          pressRef={press}
          onStart={(at) => {
            swingAt.current = at;
            stage.current?.startSwing(outing.aim!.cell, outing.aim!.motion, (outing.aim!.dir ?? 4) as Dir8, at);
          }}
          onPressed={(at, grade) => stage.current?.stopSwing(at, grade)}
          stop={(at) => void step({ t: "push", at })}
        />
      )}

      {active && !outing.aim && (
        tree && picked !== null ? (
          <div className="grove-choose">
            <div className="row">
              <strong>Tree {picked + 1}</strong>
              <span className="muted">
                {tree.tall ? "Tall: falls two places, one more wood if it lands clear." : "Short: falls one place."}
                {tree.fungus ? " Bracket fungus on the bark." : ""}
                {tree.kind ? ` Knocked: ${tree.kind}.` : ""}
              </span>
            </div>
            <div className="row grove-dirs">
              {NOTCH_DIRS.map((d) => {
                const o = fallOutcome(picked, d, tree.tall ? 2 : 1, down);
                return (
                  <button key={d} disabled={locked} onClick={() => aim(picked, d)} style={{ borderColor: OUTCOME_COLOR[o] }} title={`Notch it ${DIR_NAMES[d]}: ${OUTCOME_WORD[o]}`}>
                    {ARROW[d]} {DIR_NAMES[d]} <span className="muted">· {OUTCOME_WORD[o]}</span>
                  </button>
                );
              })}
            </div>
            <div className="row">
              <button className="small" disabled={locked || grove.knocksLeft === 0 || tree.knocked} onClick={() => void step({ t: "knock", cell: picked })}>
                Knock on it{grove.knocksLeft > 0 && !tree.knocked ? ` (${grove.knocksLeft} left)` : ""}
              </button>
              <button className="small" onClick={() => setPicked(null)}>Pick another</button>
            </div>
          </div>
        ) : (
          <p className="muted gather-hint">
            {falling ? "Timber…" : "Tap a tree to pick it. Drag to look round. A tree must fall somewhere clear: not into a standing tree, the creek to the north or your pile and cart by the track."}
          </p>
        )
      )}
    </div>
  );
}
