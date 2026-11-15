// The bottom bar: the one fixed piece of HUD every view shares. It is built
// like a ship's rack, in flat colours and hard two-pixel edges:
//
//                 where you stand .... what to do here
//        o o o          points          o o o o
//    @[== health ==]@  <( level )>  @[== second meter ==]@
//      ================ experience =================
//   L [hand][hand] | [ ][ ][ ][ ][ ][ ][ ][ ][ ] | [bag] I
//
// The rack is one picture of timber drawn in code (rackArt.ts), with what
// changes laid over it. It is sectioned by two raised posts. Left of the
// first: what is in each hand. Between them, nine slots: what the hero can do (the abilities
// of the weapon in hand, or a punch with none), then anything quick to hand
// (potions on a voyage). Right of the second: the bag. On the beam over it
// runs the experience bar. Above that sit two meters, health on the left
// and whatever else the view counts on the right (focus on a voyage,
// gathering outings in the Harbor), with a plaque between them that shows
// the hero's level, or, on a voyage, the turn's clock: press it to end your
// turn. The turn's points are pips over the meters. Tabs hang off
// the rack's ends: the logbook and rest on the left, the bag's key and the
// menu on the right. Nothing on the
// bar is labelled: pointing at a thing brings up a card over the bar saying
// what it is (a meter's numbers, an item's card as in the bag, what an
// ability does, a key).
//
// In a fight on the tiles (a zone) the nine slots are what the hero can do
// this turn, each a button with its number key: the view hands them in as
// `slots`. Anywhere else they are a reminder of what the weapon does.
//
// I (or B) opens and closes the bag and L opens the logbook, unless you are
// typing. The bag's button does the same: press it again to put the bag away.

import { Children, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ABILITIES, RARITY_COLOR, STAT_LABEL, abilitiesFor, loadoutOf, maxHpFor, parseTraits, pendingTraitTiers, xpToNext } from "@gantt-quest/world";
import type { Me } from "../api";
import { Icon, ItemDetail, toOwned } from "../items";
import { blurb, label } from "../labels";
import { PixelIcon } from "../PixelIcon";
import { LiquidMeter } from "./LiquidMeter";
import { RACK, paintRack } from "./rackArt";
import "./hud.css";

const BOOK = ["####..####", "#...##...#", "#.#.##.#.#", "#...##...#", "#.#.##.#.#", "#...##...#", "#...##...#", "####..####", "..######.."];
/** A campfire: rest. */
const FIRE = ["....#.....", "....##....", "...###.#..", "..####.##.", "..#######.", ".###.####.", ".##...###.", "..##.###..", "#..####..#", ".########.", "#........#"];
const HOURGLASS = ["########", ".#....#.", ".######.", "..####..", "...##...", "..#..#..", ".#.##.#.", ".######.", "########"];

/** A row of turn points: lit for those left, dark for those spent. */
export interface HudPips {
  label: string;
  now: number;
  max: number;
  kind: "action" | "bonus" | "move" | "focus";
}

/** One of the nine slots, when the view fills them itself: something the hero can do now, by button or number key. */
export interface HudSlot {
  id: string;
  /** Two letters in the well. */
  glyph: string;
  name: string;
  /** What it costs and reaches, for the tooltip; and more about it. */
  line?: string;
  more?: string;
  /** How many are left of something that runs out. */
  count?: number;
  /** Turns until it can be used again. */
  wait?: number;
  /** Picked: waiting for its target. */
  picked?: boolean;
  /** Cannot be used right now: no Action left, on cooldown, none to throw. */
  spent?: boolean;
  run?(): void;
}

/** Something quick to hand on the rack, after the abilities. */
export interface HudQuick {
  icon: { name: string; color: string };
  /** What it is, and (in `note`) a line about it, for its tooltip. */
  label: string;
  note?: string;
  count?: number;
  run?(): void;
}

/** The meter on the right, across from health. */
export interface HudMeter {
  /** What it counts, and (in `note`) a few words more, for its tooltip. */
  name: string;
  note?: string;
  now: number;
  max: number;
  kind: "focus" | "stamina";
}

interface Props {
  me: Me;
  /** One short line on where the hero stands, over the bar. */
  place?: ReactNode;
  /** The button for what can be done here. */
  children?: ReactNode;
  /** Hit points right now; omitted off a voyage, where the hero is whole. */
  hp?: { now: number; max: number };
  /** What the right-hand meter counts here. */
  meter?: HudMeter;
  pips?: HudPips[];
  /** Small extras beside the points: the doom clock, the larder. */
  chips?: ReactNode;
  quick?: HudQuick[];
  /** The nine slots as the view wants them (a fight on the tiles). Replaces the weapon's abilities and `quick`. */
  slots?: HudSlot[];
  /** The turn: seconds left on it (null with no clock), and ending it when it is yours. */
  turn?: { seconds: number | null; onEnd?(): void; waitingFor?: string };
  /** Resting, where it can be done. */
  rest?: { run(): void; hint: string; disabled?: boolean };
  onBag?(): void;
  /** Why the bag cannot be opened right now. */
  bagBlocked?: string;
  onBook?(): void;
  /** The game menu's cog (an OptionsMenu). */
  menu: ReactNode;
}

/** A place on the rack's picture, in its art pixels, as a style: the stylesheet's --p is how big one of those is drawn. */
const box = (x: number, y: number, w: number, h: number): CSSProperties => ({ left: `calc(${x} * var(--p))`, top: `calc(${y} * var(--p))`, width: `calc(${w} * var(--p))`, height: `calc(${h} * var(--p))` });
const well = (x: number) => box(x, RACK.slotY, RACK.slot, RACK.slot);
const tab = (side: "left" | "right", n: number) => box(RACK.tabs[side], RACK.tabs.y[n], RACK.tabs.w, RACK.tabs.h);
const typing = (e: KeyboardEvent) => !!(e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]");

/** A tooltip's words: what the thing is, a line about it, more if there is more, and the key that works it. */
function Tip({ name, line, more, keys }: { name: string; line?: string; more?: string; keys?: string }) {
  return (
    <div className="hud-tip-text">
      <strong>{name}{keys && <kbd>{keys}</kbd>}</strong>
      {line && <span>{line}</span>}
      {more && <span className="muted">{more}</span>}
    </div>
  );
}

export function HudBar({ me, place, children, hp, meter, pips = [], chips, quick = [], slots, turn, rest, onBag, bagBlocked, onBook, menu }: Props) {
  const c = me.character;
  const items = me.inventory.map(toOwned);
  const worn = items.filter((i) => i.equipped);
  const weapon = worn.find((i) => i.slot === "main_hand");
  const offhand = worn.find((i) => i.slot === "off_hand");
  // With nothing in hand there is only the punch.
  const abilities = abilitiesFor(weapon?.ref);

  /** What the pointer is over on the bar, and where along it (in the picture's pixels), for the card that explains it. */
  const [tip, setTip] = useState<{ x: number; node: ReactNode } | null>(null);
  const hover = (x: number, node: ReactNode) => ({ onPointerEnter: () => setTip({ x, node }), onPointerLeave: () => setTip(null), onPointerDown: () => setTip(null) });
  const [hpAt, otherAt] = RACK.meters;
  const plaqueX = RACK.plaque.x + RACK.plaque.w / 2;

  // The newest slots, for the key handler, which is not rebound each time they change.
  const slotsNow = useRef(slots);
  slotsNow.current = slots;

  // The rack's timber is one fixed picture, painted once.
  const art = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (art.current) paintRack(art.current);
  }, [me.character === null]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if ((k === "b" || k === "i") && onBag && !bagBlocked) onBag();
      if (k === "l" && onBook) onBook();
      // A fight's slots answer to their numbers.
      const slot = /^[1-9]$/.test(k) ? slotsNow.current?.[Number(k) - 1] : undefined;
      if (slot?.run && !slot.spent) slot.run();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onBag, onBook, bagBlocked]);

  if (!c) return <div className="hud"><div className="hud-rack"><span className="hud-caps">{children}{menu}</span></div></div>;

  const bonus = loadoutOf(worn).bonus;
  const stats = { str: c.str + (bonus.str ?? 0), int_stat: c.int_stat + (bonus.int_stat ?? 0), vit: c.vit + (bonus.vit ?? 0), agi: c.agi + (bonus.agi ?? 0), dex: c.dex + (bonus.dex ?? 0) };
  const maxHp = hp?.max ?? maxHpFor(stats, c.level);
  const nowHp = hp?.now ?? maxHp;
  const next = xpToNext(c.level);
  const news = c.unspent_points > 0 || pendingTraitTiers(c.class_id, c.level, parseTraits(c.traits)).length > 0;
  const left = pips.filter((p) => p.kind !== "focus");
  const right = pips.filter((p) => p.kind === "focus");
  const pipRow = (p: HudPips) => (
    <span key={p.label} className={`hud-pips ${p.kind}`} title={`${p.label}: ${p.now} of ${p.max} left`}>
      {Array.from({ length: Math.max(p.max, p.now) }, (_, i) => <i key={i} className={i < p.now ? "on" : ""} />)}
    </span>
  );

  return (
    <div className="hud" role="toolbar" aria-label="Your hero">
      {(place || Children.toArray(children).length > 0) && (
        <div className="hud-here">
          {place && <span className="hud-place">{place}</span>}
          {children}
        </div>
      )}

      <div className="hud-points">
        <span className="hud-points-side">{left.map(pipRow)}</span>
        <span className="hud-points-side end">{right.map(pipRow)}{chips}</span>
      </div>

      <div className="hud-rack" style={box(0, 0, RACK.w, RACK.h)} onPointerLeave={() => setTip(null)}>
        <canvas ref={art} className="hud-rack-art" aria-hidden />
        <div className="hud-xp" style={box(RACK.xp.x, RACK.xp.y, RACK.xp.w, RACK.xp.h)} {...hover(RACK.xp.x + RACK.xp.w / 2, <Tip name="Experience" line={`${c.xp} of ${next} to level ${c.level + 1}`} />)}>
          <div style={{ width: `${(100 * c.xp) / next}%` }} />
        </div>

        {/* Over the cornice: health, the plaque, and the view's other count. Their numbers are in their tooltips. */}
        <div className="hud-meter" style={box(hpAt.x, hpAt.y, hpAt.w, hpAt.h)} {...hover(hpAt.x + hpAt.w / 2, <Tip name="Health" line={`${nowHp} of ${maxHp} hit points`} />)}>
          <LiquidMeter kind="hp" now={nowHp} max={maxHp} w={hpAt.w} h={hpAt.h} />
        </div>
        {meter && (
          <div className="hud-meter" style={box(otherAt.x, otherAt.y, otherAt.w, otherAt.h)} {...hover(otherAt.x + otherAt.w / 2, <Tip name={meter.name} line={`${meter.now} of ${meter.max}${meter.note ? ` · ${meter.note}` : ""}`} />)}>
            <LiquidMeter kind={meter.kind} now={meter.now} max={meter.max} w={otherAt.w} h={otherAt.h} />
          </div>
        )}
        {turn ? (
          <button
            className={`hud-plaque turn ${turn.onEnd ? "mine" : ""} ${turn.seconds !== null && turn.seconds <= 15 ? "low" : ""}`}
            style={box(RACK.plaque.x, RACK.plaque.y, RACK.plaque.w, RACK.plaque.h)}
            aria-label={turn.onEnd ? "End turn" : "Waiting"}
            disabled={!turn.onEnd}
            onClick={turn.onEnd}
            {...hover(plaqueX, <Tip name={turn.onEnd ? "End your turn" : `Waiting for ${turn.waitingFor ?? "the others"}`} line={turn.seconds !== null ? `${turn.seconds} seconds left on the turn` : undefined} />)}
          >
            <PixelIcon rows={HOURGLASS} size={12} />
            {turn.seconds !== null ? <span>{turn.seconds}</span> : <span>{turn.onEnd ? "End" : "…"}</span>}
          </button>
        ) : (
          <button
            className={`hud-plaque ${news ? "news" : ""}`}
            style={box(RACK.plaque.x, RACK.plaque.y, RACK.plaque.w, RACK.plaque.h)}
            aria-label="Logbook"
            disabled={!onBook}
            onClick={onBook}
            {...hover(plaqueX, <Tip name={`${c.name}, level ${c.level}`} line={news ? "Something to spend or pick in the logbook" : "Open the logbook"} keys="L" />)}
          >
            <span>Lv {c.level}</span>
          </button>
        )}

        {/* Left of the first post: weapon and shield, each with the card it has in the bag. */}
        <span className="hud-slot hand" style={well(RACK.hands[0])} {...hover(RACK.hands[0] + 7, weapon ? <ItemDetail item={weapon} equipped classId={c.class_id} level={c.level} /> : <Tip name="Nothing in hand" line="Bare fists: all you can do in a fight is punch." />)}>
          {weapon && <Icon name={weapon.icon} color={RARITY_COLOR[weapon.rarity]} size={40} />}
        </span>
        <span className="hud-slot hand" style={well(RACK.hands[1])} {...hover(RACK.hands[1] + 7, offhand ? <ItemDetail item={offhand} equipped classId={c.class_id} level={c.level} /> : <Tip name="Off hand" line="Empty." />)}>
          {offhand && <Icon name={offhand.icon} color={RARITY_COLOR[offhand.rarity]} size={40} />}
        </span>

        {/* Between the posts, in a fight on the tiles: what the hero can do this turn, each a button. */}
        {slots?.slice(0, RACK.mid.length).map((s, i) => (
          <button
            key={s.id}
            className={`hud-slot act ${s.picked ? "picked" : ""} ${s.spent ? "spent" : ""}`}
            style={well(RACK.mid[i])}
            aria-label={s.name}
            aria-pressed={!!s.picked}
            disabled={!s.run || !!s.spent}
            onClick={s.run}
            {...hover(RACK.mid[i] + 7, <Tip name={s.name} line={s.line} more={s.more} keys={String(i + 1)} />)}
          >
            <span className="hud-glyph">{s.glyph}</span>
            {s.wait ? <span className="hud-wait">{s.wait}</span> : s.count !== undefined && <span className="hud-count">{s.count}</span>}
            <span className="hud-key">{i + 1}</span>
          </button>
        ))}
        {/* Otherwise: what the weapon in hand can do, then what is quick to hand. */}
        {!slots && abilities.slice(0, RACK.mid.length).map((id, i) => {
          const a = ABILITIES[id];
          const name = label("ability", id);
          return (
            <span key={id} className="hud-slot ability" style={well(RACK.mid[i])} {...hover(RACK.mid[i] + 7, <Tip name={name} line={`${a.rolls} × ${STAT_LABEL[a.stat]}`} more={`${blurb("ability", id)} Used in a fight.`} keys={String(i + 1)} />)}>
              <span className="hud-glyph">{name.slice(0, 2)}</span>
              <span className="hud-key">{i + 1}</span>
            </span>
          );
        })}
        {!slots && quick.slice(0, RACK.mid.length - abilities.length).map((q, i) => (
          <button key={q.label} className="hud-slot quick" style={well(RACK.mid[abilities.length + i])} disabled={!q.run} onClick={q.run} {...hover(RACK.mid[abilities.length + i] + 7, <Tip name={q.label} line={q.note} keys={String(abilities.length + i + 1)} />)}>
            <Icon name={q.icon.name} color={q.icon.color} size={30} />
            {q.count !== undefined && <span className="hud-count">{q.count}</span>}
            <span className="hud-key">{abilities.length + i + 1}</span>
          </button>
        ))}

        {/* Right of the second post: the bag. */}
        <button
          className="hud-slot bag"
          style={well(RACK.bag)}
          aria-label="Sea bag"
          disabled={!onBag || !!bagBlocked}
          onClick={onBag}
          {...hover(RACK.bag + 7, <Tip name="Sea bag" line={bagBlocked ?? `${c.gold} gold${me.carry ? ` · ${me.carry.carried} of ${me.carry.limit} squares filled` : ""}`} keys="I" />)}
        >
          {/* The sea bag itself, as a thing: drawn in the round like everything that goes in it. */}
          <Icon name="sea-bag" color="#e0b12e" size={40} />
        </button>

        {/* The tabs off each end: the logbook and rest on the left, the bag's key and the menu on the right. */}
        <button className={`hud-tab ${news ? "news" : ""}`} style={tab("left", 0)} aria-label="Logbook" disabled={!onBook} onClick={onBook} {...hover(4, <Tip name="Logbook" line={news ? "Something to spend or pick" : "Your hero, traits and skills"} keys="L" />)}>L</button>
        {rest && (
          <button className="hud-tab" style={tab("left", 1)} aria-label="Rest" disabled={rest.disabled} onClick={rest.run} {...hover(4, <Tip name="Rest" line={rest.hint} />)}>
            <PixelIcon rows={FIRE} size={11} />
          </button>
        )}
        <button className="hud-tab" style={tab("right", 0)} aria-label="Sea bag" disabled={!onBag || !!bagBlocked} onClick={onBag} {...hover(RACK.w - 4, <Tip name="Sea bag" line={bagBlocked} keys="I" />)}>I</button>
        <span className="hud-tab cog" style={tab("right", 1)} {...hover(RACK.w - 4, <Tip name="Menu" line="Settings, your account and the way out" keys="Esc" />)}>{menu}</span>

        {/* What the pointer is over, explained: a card over the bar, above that thing. */}
        {tip && <div className="hud-tip panel" style={{ left: `clamp(150px, calc(${tip.x} * var(--p)), calc(100% - 150px))` }} role="tooltip">{tip.node}</div>}
      </div>
    </div>
  );
}

/** For views (or moments) with no bottom bar: the cog and a few chips, tucked into the top-right corner. */
export function HudCorner({ children, menu }: { children?: ReactNode; menu: ReactNode }) {
  return <div className="hud-corner">{children}{menu}</div>;
}
