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
// The rack is two rows deep, eighteen slots, and each is something the hero
// can do in a fight: an ability, a common action, a thing from the pack,
// each with its picture. The player lays them out as they like (drag one
// onto another to swap them), and the layout is kept per class (zone/hotbar.ts).
// In a fight on the tiles (a zone) the view hands the slots in as `slots`:
// each is then a button with its key (1 to 9 for the top row, Shift with
// them for the bottom), and a right-click chooses what goes there. Anywhere
// else the same bar is shown as it was left, to look at and rearrange.
//
// I (or B) opens and closes the bag and L opens the logbook, unless you are
// typing. The bag's button does the same: press it again to put the bag away.

import { Children, useEffect, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type ReactNode } from "react";
import { ABILITIES, COMMON_ACTIONS, RARITY_COLOR, THROWABLES, abilitiesFor, commonCost, loadoutOf, maxHpFor, parseTraits, pendingTraitTiers, tacticOf, xpToNext, type CommonAction, type Throwable } from "@gantt-quest/world";
import type { Me } from "../api";
import { Icon, ItemDetail, toOwned } from "../items";
import { blurb, label } from "../labels";
import { PixelIcon } from "../PixelIcon";
import { LiquidMeter } from "./LiquidMeter";
import { COMMON_ICON, ITEM_ICON, abilityIcon } from "../zone/actionIcons";
import { loadBar, moveSlot, saveBar } from "../zone/hotbar";
import { RACK, RACK_ROW, paintRack } from "./rackArt";
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
  /** Its picture in the well (a name and accent colour from the item art); `flat` draws it as a flat glyph, not a little model. */
  icon: { name: string; color: string; flat?: boolean };
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
  /** The slots as the view wants them (a fight on the tiles): up to two rows of nine, null for an empty one. Replaces the weapon's abilities and `quick`. */
  slots?: (HudSlot | null)[];
  /** The player dragged slot `from` onto slot `to`. */
  onSlotMove?(from: number, to: number): void;
  /** The player asked to choose what goes in a slot (a right-click, or a click on an empty one). */
  onSlotMenu?(index: number): void;
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

export function HudBar({ me, place, children, hp, meter, pips = [], chips, quick = [], slots, onSlotMove, onSlotMenu, turn, rest, onBag, bagBlocked, onBook, menu }: Props) {
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
  const rackRows = 2;
  // Out of a fight: the bar as this class last left it, to look at and rearrange.
  const classId = me.character?.class_id ?? "";
  const abilityKey = abilities.join(",");
  const [layout, setLayout] = useState<string[]>([]);
  useEffect(() => {
    if (classId) setLayout(loadBar(classId, abilities));
  }, [classId, abilityKey]);
  useEffect(() => {
    if (art.current) paintRack(art.current, rackRows);
  }, [me.character === null, rackRows]);

  // How much of the bottom of the screen the bar takes (its rack and the pips over it, not the "here" strip), as
  // --hud-h on the page: whatever a view floats over the bottom (a minigame's controls) sits clear above it.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => {
      const tops = [...el.children].filter((k) => !k.classList.contains("hud-here")).map((k) => k.getBoundingClientRect().top);
      if (tops.length === 0) return;
      document.documentElement.style.setProperty("--hud-h", `${Math.max(0, Math.round(innerHeight - Math.min(...tops)))}px`);
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    addEventListener("resize", measure);
    return () => {
      watch.disconnect();
      removeEventListener("resize", measure);
      document.documentElement.style.removeProperty("--hud-h");
    };
  }, [c === null]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if ((k === "b" || k === "i") && onBag && !bagBlocked) onBag();
      if (k === "l" && onBook) onBook();
      // A fight's slots answer to their numbers: the top row plain, the bottom row with Shift.
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
      const slot = digit ? slotsNow.current?.[Number(digit) - 1 + (e.shiftKey ? RACK.mid.length : 0)] : undefined;
      if (slot?.run && !slot.spent) slot.run();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onBag, onBook, bagBlocked]);

  if (!c) return <div className="hud" ref={root}><div className="hud-rack"><span className="hud-caps">{children}{menu}</span></div></div>;

  /** One slot of the bar as it is shown out of a fight: what it is and what it costs, with nothing to press. */
  const reminder = (key: string): HudSlot | null => {
    const [kind, id] = [key.slice(0, 2), key.slice(3)];
    const cost = (c: "action" | "bonus") => (c === "action" ? "Action" : "Bonus action");
    if (kind === "ab" && ABILITIES[id]) return { id: key, icon: { ...abilityIcon(id), flat: true }, name: label("ability", id), line: `${cost(tacticOf(id).cost)} · used in a fight`, more: blurb("ability", id) };
    if (kind === "do" && COMMON_ACTIONS[id as CommonAction]) return { id: key, icon: { ...COMMON_ICON[id as CommonAction], flat: true }, name: COMMON_ACTIONS[id as CommonAction].name, line: `${cost(commonCost(id as CommonAction, c.class_id))} · used in a fight`, more: COMMON_ACTIONS[id as CommonAction].blurb };
    if (kind === "it" && THROWABLES[id as Throwable]) return { id: key, icon: ITEM_ICON[id as Throwable], name: THROWABLES[id as Throwable].name, line: "Carried into a fight", more: THROWABLES[id as Throwable].blurb, count: me.consumables?.[id as Throwable] ?? 0 };
    return null;
  };
  const shown = slots ?? layout.map(reminder);
  const moveShown = onSlotMove ?? ((from: number, to: number) => {
    const next = moveSlot(layout, from, to);
    setLayout(next);
    saveBar(c.class_id, next);
  });

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
    <div className="hud" ref={root} role="toolbar" aria-label="Your hero">
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

      <div className="hud-rack" style={box(0, 0, RACK.w, RACK.h + (rackRows - 1) * RACK_ROW)} onPointerLeave={() => setTip(null)}>
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

        {/* Between the posts, in a fight on the tiles: what the hero can do, each a button, in two rows. */}
        {shown.slice(0, RACK.mid.length * 2).map((s, i) => {
          const col = i % RACK.mid.length;
          const lower = i >= RACK.mid.length;
          const at = box(RACK.mid[col], RACK.slotY + (lower ? RACK_ROW : 0), RACK.slot, RACK.slot);
          const keys = `${lower ? "Shift " : ""}${col + 1}`;
          // Any slot can be dropped on, and asked to hold something else.
          const arrange = {
            onDragOver: (e: DragEvent) => e.preventDefault(),
            onDrop: (e: DragEvent) => {
              e.preventDefault();
              const from = Number(e.dataTransfer.getData("text/gq-slot"));
              if (Number.isInteger(from) && from !== i) moveShown(from, i);
            },
            onContextMenu: (e: MouseEvent) => {
              e.preventDefault();
              onSlotMenu?.(i);
            },
          };
          if (!s) {
            return <button key={`empty${i}`} className="hud-slot act empty" style={at} aria-label={`Empty slot ${keys}`} onClick={() => onSlotMenu?.(i)} {...arrange} {...hover(RACK.mid[col] + 7, <Tip name="Empty slot" line={onSlotMenu ? "Click to choose what goes here." : "Drag a slot here to move it."} more={onSlotMenu ? "Drag a slot onto another to swap them; right-click one to change it." : undefined} keys={keys} />)} />;
          }
          return (
            <button
              key={s.id}
              className={`hud-slot act ${s.picked ? "picked" : ""} ${s.spent ? "spent" : ""} ${slots ? "" : "reminder"}`}
              style={at}
              aria-label={s.name}
              aria-pressed={!!s.picked}
              aria-disabled={!s.run || !!s.spent}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("text/gq-slot", String(i));
                e.dataTransfer.effectAllowed = "move";
                setTip(null);
              }}
              onClick={() => !s.spent && s.run?.()}
              {...arrange}
              {...hover(RACK.mid[col] + 7, <Tip name={s.name} line={s.line} more={s.more} keys={keys} />)}
            >
              <Icon name={s.icon.name} color={s.icon.color} size={30} flat={s.icon.flat} />
              {s.wait ? <span className="hud-wait">{s.wait}</span> : s.count !== undefined && <span className="hud-count">{s.count}</span>}
              <span className="hud-key">{lower ? "⇧" : ""}{col + 1}</span>
            </button>
          );
        })}
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
