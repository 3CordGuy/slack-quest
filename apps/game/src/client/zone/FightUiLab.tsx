// A bench for the fight interface (development only, at #lab/fightui): the
// turn bar, the announcement, the turn order, the combat log, the roll shown
// large and the loot window, with made-up data and a button for every state
// each can be in. The backdrop is a plain dark field the size of the game
// view, with the bottom rack's own timber drawn where the real bar stands
// (and --hud-h set from it, as the real bar does), a block where the chat
// lies and one where the crew's cards hang, so placement is judged in context.
// The sea bag is the real one where the visitor has a hero (loot can be dragged
// onto it), and a block the same size and place where they have none.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ACTION_AP, AP_MAX, AP_TURN, BONUS_AP, FURNISHINGS, HERO_CLASSES, apForMove, moveLeft, weaponItem, type Budget, type LootItem, type Roll, type Rolled } from "@gantt-quest/world";
import type { Me } from "../api";
import { InventoryScreen } from "../InventoryScreen";
import { spriteDataUrl } from "../render/sprites";
import { RACK, RACK_ROW, paintRack } from "../ui/rackArt";
import "../ui/hud.css";
import "./zone.css";
import { CombatLog, RollToast, type LogEntry } from "./CombatLog";
import { InitiativeStrip, type InitiativeUnit } from "./InitiativeStrip";
import { LootPanel } from "./LootPanel";
import { TurnBanner, type TurnBannerKind, type TurnBannerShow } from "./TurnBanner";
import { TurnBar } from "./TurnBar";

interface Fighter { id: string; name: string; side: "hero" | "enemy"; kind: string; hp: number; maxHp: number; shield?: number; init: number; tie?: number; down?: boolean; mine?: boolean; hidden?: boolean }

const CLASSES = HERO_CLASSES.map((c) => c.id);
const PARTY: Fighter[] = [
  { id: "h1", name: "Mira Tidewright", side: "hero", kind: CLASSES[0], hp: 31, maxHp: 38, shield: 6, init: 19, mine: true },
  { id: "e1", name: "Dire Wolf", side: "enemy", kind: "wolf", hp: 14, maxHp: 22, init: 17 },
  { id: "h2", name: "Brann", side: "hero", kind: CLASSES[1], hp: 12, maxHp: 26, init: 15, tie: 14 },
  { id: "e2", name: "Bandit Cutter", side: "enemy", kind: "bandit", hp: 18, maxHp: 18, init: 15, tie: 6 },
  { id: "e3", name: "Cave Bat", side: "enemy", kind: "bat", hp: 0, maxHp: 9, init: 12, down: true },
  { id: "h3", name: "Sela", side: "hero", kind: CLASSES[2], hp: 22, maxHp: 24, init: 11 },
  { id: "e4", name: "Ogre", side: "enemy", kind: "ogre", hp: 40, maxHp: 52, init: 8 },
  { id: "e5", name: "Something unseen", side: "enemy", kind: "shade", hp: 10, maxHp: 10, init: 5, hidden: true },
];
const EXTRA_KINDS = ["skeleton", "spider", "cultist", "archer", "brute", "slime", "troll", "bear"];
const CROWD: Fighter[] = [
  ...PARTY,
  ...Array.from({ length: 16 }, (_, i): Fighter => ({ id: `x${i}`, name: `${EXTRA_KINDS[i % EXTRA_KINDS.length][0].toUpperCase()}${EXTRA_KINDS[i % EXTRA_KINDS.length].slice(1)} ${i + 1}`, side: i % 5 === 0 ? "hero" : "enemy", kind: i % 5 === 0 ? CLASSES[(i / 5 + 3) % CLASSES.length] : EXTRA_KINDS[i % EXTRA_KINDS.length], hp: 6 + ((i * 7) % 14), maxHp: 20, init: 4 - Math.floor(i / 4) })),
];

const d20 = () => 1 + Math.floor(Math.random() * 20);
const roll = (over: Partial<Roll> & Pick<Roll, "kind" | "label" | "d20" | "bonus" | "vs" | "adv">): Roll => {
  const kept = over.d20.length === 1 || over.adv === 0 ? over.d20[0] : over.adv > 0 ? Math.max(...over.d20) : Math.min(...over.d20);
  const total = kept + over.bonus;
  const crit = over.kind === "attack" && kept === 20;
  return { id: "h1", kept, total, ok: crit || (kept !== 1 && total >= over.vs), crit, ...over };
};
const rolled = (d: number, n: number, plus: number, more: Partial<Rolled> = {}): Rolled => {
  const faces = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * d));
  return { d, faces, plus, total: faces.reduce((a, b) => a + b, 0) + plus, ...more };
};

const BANNERS: Record<TurnBannerKind, { title: string; sub?: string }> = {
  yours: { title: "Your turn", sub: "Mira Tidewright · Round 2" },
  ally: { title: "Brann's turn" },
  enemy: { title: "Dire Wolf's turn" },
  round: { title: "Round 3" },
  fight: { title: "Combat", sub: "Roll for initiative" },
  victory: { title: "Victory", sub: "The band is broken" },
  defeat: { title: "Defeated", sub: "The crew is down" },
  cleared: { title: "The cave is clear", sub: "Its bounty is yours" },
};

const LOOT: LootItem[] = [
  { t: "gold", n: 47 },
  { t: "gear", item: weaponItem("greatsword", "rare", 4, { str: 2 }) },
  { t: "gear", item: weaponItem("staff", "epic", 6, { int_stat: 3 }) },
  { t: "res", kind: "fur", n: 3 },
  { t: "res", kind: "iron", n: 12 },
  { t: "use", kind: "healing", n: 2 },
  { t: "use", kind: "fire", n: 1 },
  { t: "stone", stone: ["hardy", "gilded2"] },
  { t: "blueprint", id: "hearth" },
  { t: "furnishing", grant: { defId: "trophy_pelt", label: FURNISHINGS.trophy_pelt?.name ?? "Great Pelt" } },
];

/** One of the bench's own buttons. */
function B({ children, on, press }: { children: string; on?: boolean; press: () => void }) {
  return <button type="button" className={`small ${on ? "selected" : ""}`} onClick={press}>{children}</button>;
}

export default function FightUiLab({ me, refresh }: { me?: Me; refresh?: () => Promise<unknown> }) {
  const [crowd, setCrowd] = useState(false);
  const fighters = crowd ? CROWD : PARTY;
  const [at, setAt] = useState(0);
  const [round, setRound] = useState(2);
  const [forceWait, setForceWait] = useState(false);
  // The turn's budget, as the rules keep it: Action Points, the steps bought and not yet walked, and what a point buys.
  const [ap, setAp] = useState(AP_TURN);
  const [move, setMove] = useState(0);
  const [stride, setStride] = useState(2);
  /** What the pointer is over: something that costs Action Points, or a walk of so many steps. */
  const [aim, setAim] = useState<{ ap: number } | { steps: number } | null>(null);
  const [course, setCourse] = useState<{ now: number; max: number } | undefined>();
  const [seconds, setSeconds] = useState<number | null>(42);
  const [ticking, setTicking] = useState(false);
  const [extra, setExtra] = useState(false);
  const [banner, setBanner] = useState<TurnBannerShow | null>(null);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(true);
  const [logAbove, setLogAbove] = useState(false);
  const [toast, setToast] = useState<{ roll: Roll; dice?: Rolled } | null>(null);
  const [loot, setLoot] = useState<{ kind: "body" | "chest" | "spoils"; items: LootItem[] } | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [bag, setBag] = useState(false);
  const [bagOver, setBagOver] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [panel, setPanel] = useState(true);
  const [said, setSaid] = useState("");
  const ids = useRef(1);
  const nid = () => ids.current++;

  const actor = fighters[at % fighters.length];
  const myTurn = !!actor.mine && !forceWait;
  const units = useMemo<InitiativeUnit[]>(
    () => fighters.map((f, i) => ({ id: f.id, name: f.name, side: f.side, portrait: f.hidden ? "" : spriteDataUrl(f.kind), hp: f.hp, maxHp: f.maxHp, shield: f.shield, init: f.init, tie: f.tie, turn: i === at % fighters.length, spent: i < at % fighters.length, down: !!f.down, mine: !!f.mine, hidden: f.hidden })),
    [fighters, at],
  );

  const add = (...more: LogEntry[]) => setEntries((was) => [...was, ...more].slice(-400));
  const fire = (kind: TurnBannerKind, over?: { title: string; sub?: string }) => setBanner({ id: nid(), kind, ...(over ?? BANNERS[kind]) });

  /** The turn passes to the next fighter still standing: the banner, the log and the bar all follow. */
  const nextTurn = () => {
    let i = at;
    let r = round;
    do {
      i++;
      if (i % fighters.length === 0) r++;
    } while (fighters[i % fighters.length].down);
    const who = fighters[i % fighters.length];
    setAt(i);
    setForceWait(false);
    if (r !== round) {
      setRound(r);
      add({ k: "head", id: nid(), text: `Round ${r}` });
    }
    add({ k: "turn", id: nid(), name: who.name, side: who.side });
    fire(who.mine ? "yours" : who.side === "hero" ? "ally" : "enemy", who.mine ? { title: "Your turn", sub: `${who.name} · Round ${r}` } : { title: `${who.name}'s turn` });
    // Steps bought and not walked are lost with the turn; points not spent are kept, and a fresh turn's are added to them.
    setMove(0);
    if (who.mine) setAp((a) => Math.min(AP_MAX, a + AP_TURN));
    setAim(null);
    setSeconds(who.mine ? 60 : 20);
  };

  const budget: Budget = { ap, move, stride, disengaged: false };
  const reach = moveLeft(budget);
  // As the view works them out: a walk out of reach buys nothing (the steps alone show red).
  const apCost = !aim ? null : "ap" in aim ? aim.ap : aim.steps <= reach ? apForMove(budget, aim.steps) : null;
  const spend = (n: number, what: string) => {
    if (n > ap) return setSaid(`${what}: ${n} AP, and only ${ap} left`);
    setAp(ap - n);
    setSaid(`${what}: ${n} AP`);
  };
  const buyStride = () => {
    if (ap <= 0 || stride <= 0) return setSaid("Nothing to buy a stride with");
    setAp(ap - 1);
    setMove(move + stride);
    setSaid(`Bought a stride: ${stride} steps for 1 AP`);
  };
  /** Walk so many steps: what is bought goes first, and strides are bought as they are needed. */
  const walk = (n: number) => {
    if (n > reach) return setSaid(`${n} steps is out of reach (${reach})`);
    const bought = apForMove(budget, n);
    setAp(ap - bought);
    setMove(move + bought * stride - n);
    setSaid(`Walked ${n}${bought ? `, buying ${bought} stride${bought === 1 ? "" : "s"}` : " on steps already bought"}`);
  };

  const attack = (how: "hit" | "miss" | "crit" | "adv" | "dis") => {
    const dice = how === "crit" ? [20] : how === "adv" ? [d20(), d20()] : how === "dis" ? [d20(), d20()] : how === "hit" ? [14] : [4];
    const r = roll({ kind: "attack", label: "Cleave · attack", d20: dice, bonus: 5, vs: 13, adv: how === "adv" ? 1 : how === "dis" ? -1 : 0, target: "e1" });
    const out: LogEntry[] = [{ k: "roll", id: nid(), who: "Mira Tidewright", side: "hero", roll: r, target: "Dire Wolf" }];
    let dmg: Rolled | undefined;
    if (r.ok) {
      dmg = rolled(8, r.crit ? 2 : 1, 3, r.crit ? { crit: true } : {});
      out.push({ k: "hit", id: nid(), actor: "Mira Tidewright", side: "hero", target: "Dire Wolf", what: "Cleave", amount: dmg.total, dice: dmg, crit: r.crit });
    } else out.push({ k: "miss", id: nid(), actor: "Mira Tidewright", side: "hero", target: "Dire Wolf", what: "Cleave" });
    add(...out);
    setToast({ roll: r, dice: dmg });
    setAp((a) => Math.max(0, a - ACTION_AP));
  };
  const enemyAttack = () => {
    const r = roll({ kind: "attack", label: "Bite · attack", d20: [d20()], bonus: 4, vs: 15, adv: 0, id: "e1", target: "h1" });
    const out: LogEntry[] = [{ k: "roll", id: nid(), who: "Dire Wolf", side: "enemy", roll: r, target: "Mira Tidewright" }];
    let dmg: Rolled | undefined;
    if (r.ok) {
      dmg = rolled(6, 2, 2);
      out.push({ k: "hit", id: nid(), actor: "Dire Wolf", side: "enemy", target: "Mira Tidewright", what: "Bite", amount: Math.max(0, dmg.total - 4), dice: dmg, blocked: 4 });
    } else out.push({ k: "miss", id: nid(), actor: "Dire Wolf", side: "enemy", target: "Mira Tidewright", what: "Bite" });
    add(...out);
    setToast({ roll: r, dice: dmg });
  };
  const save = (ok: boolean) => {
    const r = roll({ kind: "save", label: "Agility save", d20: ok ? [17] : [5], bonus: 2, vs: 14, adv: 0, id: "e2" });
    const dmg = rolled(6, 2, 0, ok ? { halved: true } : {});
    add(
      { k: "note", id: nid(), text: "Brann throws a Fire bomb at the Bandit Cutter." },
      { k: "roll", id: nid(), who: "Bandit Cutter", side: "enemy", roll: r },
      { k: "hit", id: nid(), actor: "Brann", side: "hero", target: "Bandit Cutter", what: "Fire bomb", amount: ok ? Math.floor(dmg.total / 2) : dmg.total, dice: dmg },
    );
    setToast({ roll: r, dice: dmg });
  };
  const shove = () => {
    const r = roll({ kind: "shove", label: "Shove · Strength", d20: [d20()], bonus: 3, vs: 11, adv: 0, target: "e4" });
    add({ k: "roll", id: nid(), who: "Mira Tidewright", side: "hero", roll: r, target: "Ogre" }, { k: "note", id: nid(), text: r.ok ? "The Ogre is knocked back a hex." : "The Ogre does not budge.", tone: r.ok ? "good" : "dim" });
    setToast({ roll: r });
  };
  const initiative = () => {
    const out: LogEntry[] = [{ k: "head", id: nid(), text: "Combat begins" }];
    for (const f of fighters.slice(0, 8)) out.push({ k: "roll", id: nid(), who: f.name, side: f.side, roll: { ...roll({ kind: "initiative", label: "Initiative", d20: [Math.max(1, f.init - 3)], bonus: 3, vs: 0, adv: 0, id: f.id }), ok: true } });
    add(...out);
    fire("fight");
  };
  const heal = () => {
    const dice = rolled(4, 2, 2);
    add({ k: "heal", id: nid(), actor: "Brann", target: "Mira Tidewright", what: "Mend", amount: dice.total, dice });
  };
  const fall = () => add({ k: "hit", id: nid(), side: "none", target: "Bandit Cutter", what: "Burning", amount: 3 }, { k: "note", id: nid(), text: "Cave Bat falls.", tone: "bad" }, { k: "note", id: nid(), text: "Sela slips out of sight.", tone: "dim" }, { k: "note", id: nid(), text: "Mira Tidewright is Bolstered: a shield of 6.", tone: "good" });
  const fill = () => {
    const out: LogEntry[] = [];
    for (let i = 0; i < 20; i++) {
      const r = roll({ kind: "attack", label: "Stab · attack", d20: [d20()], bonus: 4, vs: 12, adv: 0 });
      out.push({ k: "turn", id: nid(), name: i % 2 ? "Dire Wolf" : "Sela", side: i % 2 ? "enemy" : "hero" }, { k: "roll", id: nid(), who: i % 2 ? "Dire Wolf" : "Sela", side: i % 2 ? "enemy" : "hero", roll: r, target: i % 2 ? "Sela" : "Dire Wolf" });
      if (r.ok) {
        const dmg = rolled(i % 2 ? 6 : 4, r.crit ? 2 : 1, 2, r.crit ? { crit: true } : {});
        out.push({ k: "hit", id: nid(), actor: i % 2 ? "Dire Wolf" : "Sela", side: i % 2 ? "enemy" : "hero", target: i % 2 ? "Sela" : "Dire Wolf", what: i % 2 ? "Bite" : "Stab", amount: dmg.total, dice: dmg, crit: r.crit });
      } else out.push({ k: "miss", id: nid(), actor: i % 2 ? "Dire Wolf" : "Sela", side: i % 2 ? "enemy" : "hero", target: i % 2 ? "Sela" : "Dire Wolf", what: i % 2 ? "Bite" : "Stab" });
    }
    add(...out);
  };

  // The clock, when it is running.
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setSeconds((s) => (s === null ? null : Math.max(0, s - 1))), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  // The rack's timber, painted as the real bar paints it, and how much of the bottom of the view it takes.
  const hud = useRef<HTMLDivElement>(null);
  const art = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (art.current) paintRack(art.current, 2);
    const el = hud.current;
    if (!el) return;
    const measure = () => document.documentElement.style.setProperty("--hud-h", `${Math.max(0, Math.round(innerHeight - el.getBoundingClientRect().top))}px`);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    addEventListener("resize", measure);
    return () => {
      watch.disconnect();
      removeEventListener("resize", measure);
      document.documentElement.style.removeProperty("--hud-h");
    };
  }, [zoom]);
  // The UI scale, for this page only: the stylesheet's own variable, put back on leaving.
  useEffect(() => {
    const root = document.documentElement.style;
    const was = root.getPropertyValue("--ui-zoom");
    root.setProperty("--ui-zoom", String(zoom));
    return () => { root.setProperty("--ui-zoom", was || "1"); };
  }, [zoom]);
  // H hides the bench's own buttons, for a clean look at the pieces.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.code === "KeyH" && !e.ctrlKey && !e.metaKey) setPanel((on) => !on); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const take = (index: number, how: string) => {
    if (!loot) return;
    setSaid(`${how}: ${JSON.stringify(loot.items[index]).slice(0, 60)}`);
    setLoot({ ...loot, items: loot.items.filter((_, i) => i !== index) });
  };

  return (
    <div className={`run zone-view in-fight ${myTurn ? "my-turn" : ""}`} style={lab.root}>
      <div className="stage" style={lab.stage} />
      <div className="zone-frame" aria-hidden />

      <InitiativeStrip round={round} units={units} onPick={(id) => setSaid(`Picked ${id}`)} />
      <TurnBanner show={banner} />
      <RollToast roll={toast?.roll ?? null} who={toast ? (toast.roll.id === "h1" ? "Mira Tidewright" : toast.roll.id === "e1" ? "Dire Wolf" : "Bandit Cutter") : undefined} dice={toast?.dice} />
      <CombatLog entries={entries} open={logOpen} onToggle={() => setLogOpen((o) => !o)} className={logAbove ? "above" : undefined} />
      {loot && (
        <LootPanel
          title={loot.kind === "body" ? "Dire Wolf" : loot.kind === "chest" ? "Iron-bound Chest" : "Spoils of Gull Rock"}
          subtitle={loot.kind === "body" ? "Fallen · level 3" : loot.kind === "chest" ? "Thrown open" : "Shared out to each of you"}
          kind={loot.kind}
          share={loot.kind === "spoils" ? "own" : "shared"}
          items={loot.items}
          blocked={blocked ? "Not in the middle of a fight." : undefined}
          onTake={(i) => take(i, "Took")}
          onTakeAll={() => { setSaid(`Took all ${loot.items.length}`); setLoot({ ...loot, items: [] }); }}
          onClose={() => setLoot(null)}
          viewer={{ classId: CLASSES[0], level: 5 }}
        />
      )}
      <TurnBar
        myTurn={myTurn}
        actor={myTurn ? actor.name : "Mira Tidewright"}
        waitingFor={myTurn ? undefined : actor.mine ? "Brann" : actor.name}
        round={round}
        ap={ap}
        apMax={AP_MAX}
        apTurn={AP_TURN}
        apCost={apCost}
        move={move}
        stride={stride}
        moveCost={aim && "steps" in aim ? aim.steps : null}
        course={course}
        seconds={seconds}
        onEnd={myTurn ? nextTurn : undefined}
        extra={extra ? <><button className="small">♪ Join song</button><button className="small primary">Unlock the door</button></> : undefined}
      />

      {/* Where the real bottom bar stands: its own timber, at its own size. */}
      <div className="hud">
        <div className="hud-points" ref={hud} />
        <div className="hud-rack" style={{ width: `calc(${RACK.w} * var(--p))`, height: `calc(${RACK.h + RACK_ROW} * var(--p))` }}>
          <canvas ref={art} className="hud-rack-art" aria-hidden />
        </div>
      </div>
      {/* Where the chat lies, and where the crew's cards hang. */}
      <div className="chat panel" style={lab.chat}><span className="muted">Chat (its footprint)</span></div>
      <div style={lab.crew}>{["Mira", "Brann", "Sela"].map((n) => <div key={n} className="panel" style={lab.card}>{n}</div>)}</div>
      {/* The sea bag's footprint, as somewhere to drop loot: the real one takes a `Me`. */}
      {bag && me?.character && <InventoryScreen me={me} refresh={refresh ?? (() => Promise.resolve())} onClose={() => setBag(false)} onIsland onLootDrop={(i) => take(i, "Dropped on the bag")} />}
      {bag && !me?.character && (
        <div className="overlay inv-overlay bag-overlay">
          <div
            className={`bag panel window ${bagOver ? "loot-over" : ""}`}
            style={{ ...lab.bag, "--u": "51px" } as CSSProperties}
            onDragOver={(e) => { if (e.dataTransfer.types.includes("text/gq-loot")) { e.preventDefault(); setBagOver(true); } }}
            onDragLeave={() => setBagOver(false)}
            onDrop={(e) => { e.preventDefault(); setBagOver(false); take(Number(e.dataTransfer.getData("text/gq-loot")), "Dropped on the bag"); }}
          >
            <span className="win-plate">Sea Bag</span>
            <p className="muted" style={{ margin: "auto", textAlign: "center" }}>The sea bag's footprint.<br />Drag loot here.</p>
          </div>
        </div>
      )}

      {panel ? (
        <aside className="panel" style={lab.panel}>
          <div style={lab.row}><strong style={{ flex: 1 }}>Fight UI lab</strong><B press={() => setPanel(false)}>Hide (H)</B></div>
          <div style={lab.head}>Turn</div>
          <div style={lab.row}>
            <B press={nextTurn}>Next turn</B>
            <B on={forceWait} press={() => setForceWait((w) => !w)}>Waiting</B>
            <B press={() => { setAt(0); setForceWait(false); setAp((a) => Math.min(AP_MAX, a + AP_TURN)); setMove(0); fire("yours"); }}>My turn</B>
            <B on={crowd} press={() => { setCrowd((c) => !c); setAt(0); }}>24 fighters</B>
          </div>
          <div style={lab.head}>Action Points · {ap} of {AP_MAX}, {move} steps bought, {reach} in reach</div>
          <div style={lab.row}>
            <B press={() => spend(ACTION_AP, "An ability")}>Ability (2 AP)</B>
            <B press={() => spend(BONUS_AP, "A quick thing")}>Quick thing (1 AP)</B>
            <B press={buyStride}>Buy a stride</B>
            <B press={() => walk(1)}>Walk 1</B>
            <B press={() => walk(3)}>Walk 3</B>
          </div>
          <div style={lab.row}>
            <span className="muted">Set</span>
            <B press={() => { setAp(AP_TURN); setMove(0); }}>Fresh 4</B>
            <B press={() => { setAp(AP_MAX); setMove(0); }}>Full 6</B>
            <B press={() => { setAp(0); setMove(0); }}>0 AP</B>
            <B press={nextTurn}>End turn (bank)</B>
            <B on={stride === 0} press={() => { setStride((s) => (s === 0 ? 2 : 0)); setMove(0); }}>Cannot move</B>
            <B on={stride === 3} press={() => setStride((s) => (s === 3 ? 2 : 3))}>Stride 3</B>
          </div>
          <div style={lab.row}>
            <span className="muted">Hover</span>
            <B on={aim === null} press={() => setAim(null)}>No hover</B>
            {[1, 2, 5].map((n) => <B key={n} on={!!aim && "ap" in aim && aim.ap === n} press={() => setAim({ ap: n })}>{`Aim ${n} AP`}</B>)}
            {[1, 3, 20].map((n) => <B key={n} on={!!aim && "steps" in aim && aim.steps === n} press={() => setAim({ steps: n })}>{`Hover walk ${n}`}</B>)}
          </div>
          <div style={lab.row}>
            <B on={!!course} press={() => setCourse((c) => (c ? undefined : { now: 2, max: 3 }))}>Course</B>
            <B on={extra} press={() => setExtra((x) => !x)}>Extras</B>
          </div>
          <div style={lab.row}>
            <span className="muted">Clock</span>
            <B on={ticking} press={() => setTicking((t) => !t)}>Run</B>
            <B press={() => setSeconds(60)}>60</B>
            <B press={() => setSeconds(16)}>16</B>
            <B press={() => setSeconds(8)}>8</B>
            <B on={seconds === null} press={() => setSeconds(null)}>none</B>
          </div>
          <div style={lab.head}>Banner</div>
          <div style={lab.row}>{(Object.keys(BANNERS) as TurnBannerKind[]).map((k) => <B key={k} press={() => fire(k)}>{k}</B>)}</div>
          <div style={lab.head}>Rolls and the log</div>
          <div style={lab.row}>
            <B press={() => attack("hit")}>Hit</B>
            <B press={() => attack("miss")}>Miss</B>
            <B press={() => attack("crit")}>Crit</B>
            <B press={() => attack("adv")}>Advantage</B>
            <B press={() => attack("dis")}>Disadv.</B>
            <B press={enemyAttack}>Enemy (blocked)</B>
            <B press={() => save(true)}>Save (halved)</B>
            <B press={() => save(false)}>Save failed</B>
            <B press={shove}>Shove</B>
            <B press={initiative}>Initiative</B>
            <B press={heal}>Heal</B>
            <B press={fall}>Notes</B>
            <B press={() => add({ k: "head", id: nid(), text: `Round ${round + 1}` })}>Head</B>
            <B press={fill}>Fill 60</B>
            <B press={() => setEntries([])}>Clear</B>
            <B on={logAbove} press={() => setLogAbove((a) => !a)}>Log above the bar</B>
          </div>
          <div style={lab.head}>Loot</div>
          <div style={lab.row}>
            <B press={() => setLoot({ kind: "body", items: LOOT.slice(0, 4) })}>Body</B>
            <B press={() => setLoot({ kind: "chest", items: LOOT })}>Chest (all kinds)</B>
            <B press={() => setLoot({ kind: "spoils", items: [...LOOT, ...LOOT] })}>Spoils (20)</B>
            <B press={() => setLoot({ kind: "chest", items: [] })}>Empty</B>
            <B on={blocked} press={() => setBlocked((b) => !b)}>Blocked</B>
            <B on={bag} press={() => setBag((b) => !b)}>Bag</B>
          </div>
          <div style={lab.head}>UI scale</div>
          <div style={lab.row}>{[0.8, 1, 1.2, 1.5].map((z) => <B key={z} on={zoom === z} press={() => setZoom(z)}>{String(z)}</B>)}</div>
          {said && <div className="muted" style={{ marginTop: 6, overflowWrap: "anywhere" }}>{said}</div>}
        </aside>
      ) : (
        <button type="button" className="small" style={lab.show} onClick={() => setPanel(true)}>Lab (H)</button>
      )}
    </div>
  );
}

const lab: Record<string, CSSProperties> = {
  root: { background: "#141a1c" },
  stage: { background: "radial-gradient(ellipse at 50% 45%, #3b4a44 0, #26322f 45%, #141a1c 100%)" },
  chat: { width: 340, height: 150 },
  crew: { position: "absolute", top: 60, right: 52, width: 230, zIndex: 10, display: "flex", flexDirection: "column", gap: 8 },
  card: { padding: "5px 8px", height: 54 },
  bag: { pointerEvents: "auto", width: 51 * 12 + 46, maxWidth: "none", height: 600, display: "flex" },
  panel: { position: "absolute", left: 12, top: 118, width: 300, zIndex: 70, padding: "8px 10px", fontSize: 12, maxHeight: "calc(100% - 420px)", overflowY: "auto" },
  head: { margin: "7px 0 3px", fontFamily: "var(--font-head)", fontSize: 13, letterSpacing: "0.06em", color: "var(--brass-hi)" },
  row: { display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", marginBottom: 3 },
  show: { position: "absolute", left: 12, top: 118, zIndex: 70 },
};
