// The pauses around a fight. The server resolves a fight's last blow, its
// end and its rewards in one step, and before this a fight simply vanished:
// the island was back before the blow had landed and the spoils were lines
// in the feed. These pieces slow that down on screen without changing what
// happened:
//
//   - an opening card that says who has been met and why, shown before any
//     blow is drawn;
//   - the fight held on screen as it stood while the last blows play out;
//   - a recap of how it ended and what each hero came away with, which
//     stays until it is dismissed.
//
// Everything here is read from the events of the step that ended the fight.

import type { ClientState, ItemDef, Resources, WorldEvent } from "@gantt-quest/world";
import { ENEMIES, RARITY_COLOR } from "@gantt-quest/world";
import { blueprintName, resourceText } from "./hutDrops";
import { itemName, label } from "./labels";

type Battle = NonNullable<ClientState["battle"]>;

/** Seconds the renderer gives each blow; matches the beat in WorldRenderer.playEvents. */
export const BEAT_MS = 380;
/** How long the opening card stays up, and how many beats the first blows wait for it. */
export const INTRO_MS = 1900;
export const INTRO_BEATS = Math.ceil(INTRO_MS / BEAT_MS);

/** The fight as it stood once this step's blows had landed: the scene to hold on screen. */
export function settleBattle(battle: Battle, events: WorldEvent[]): Battle {
  const combatants = battle.combatants.map((c) => ({ ...c }));
  const by = new Map(combatants.map((c) => [c.id, c]));
  for (const ev of events) {
    if (ev.t !== "battle") continue;
    const b = ev.ev;
    if (b.t === "hit" || b.t === "tick") {
      const c = by.get(b.target);
      if (c) c.hp = Math.max(0, c.hp - b.amount);
    } else if (b.t === "heal") {
      const c = by.get(b.target);
      if (c) c.hp = Math.min(c.maxHp, c.hp + b.amount);
    } else if (b.t === "down") {
      const c = by.get(b.id);
      if (c) Object.assign(c, { hp: 0, down: true });
    }
  }
  return { ...battle, combatants };
}

/** Blows in a batch of events: how long the renderer will take to play them. */
export const blowsIn = (events: WorldEvent[]) => events.filter((e) => e.t === "battle" && (e.ev.t === "hit" || e.ev.t === "miss" || e.ev.t === "heal" || e.ev.t === "tick")).length;

function groupNames(kinds: string[]): string {
  const count = new Map<string, number>();
  for (const k of kinds) count.set(k, (count.get(k) ?? 0) + 1);
  return [...count].map(([k, n]) => (n > 1 ? `${n} × ${label("enemy", k)}` : label("enemy", k))).join(", ");
}

export interface Intro {
  title: string;
  line: string;
}

/** The opening card for a fight that has just begun, or null if this step began none. */
export function introFor(events: WorldEvent[], state: ClientState, names: Map<string, string>): Intro | null {
  const start = events.find((e) => e.t === "battle_start");
  if (!start || start.t !== "battle_start" || !state.battle) return null;
  const enemies = state.battle.combatants.filter((c) => c.side === "enemy");
  const who = enemies.some((c) => ENEMIES[c.kind]?.boss) ? enemies.map((c) => c.name).join(", ") : groupNames(enemies.map((c) => c.kind));
  const ambush = events.find((e) => e.t === "ambush");
  const forage = events.find((e) => e.t === "forage" && e.kind === "wolves");
  const n = (id: string) => names.get(id) ?? "Someone";
  if (ambush && ambush.t === "ambush") {
    return ambush.by === "band" ? { title: "Ambush!", line: `${who} came out of the dark at ${n(ambush.heroId)}.` } : { title: "A band on the road", line: `${n(ambush.heroId)} has run into ${who}.` };
  }
  if (forage && forage.t === "forage") return { title: "Wolves!", line: `${who} broke from the trees at ${n(forage.heroId)}.` };
  return { title: enemies.some((c) => ENEMIES[c.kind]?.boss) ? "The reckoning" : "Battle", line: `Facing ${who}.` };
}

export function BattleIntro({ intro }: { intro: Intro }) {
  return (
    <div className="battle-card intro" role="status">
      <h2>{intro.title}</h2>
      <p>{intro.line}</p>
    </div>
  );
}

export interface Spoils {
  id: string;
  name: string;
  xp: number;
  gold: number;
  items: ItemDef[];
  resources: Resources;
  blueprints: string[];
  furnishings: string[];
  level: number | null;
  /** Knocked down during the fight. */
  fell: boolean;
  /** Health left, of how much. */
  hp: number;
  maxHp: number;
}

export interface Recap {
  status: "victory" | "defeat" | "fled";
  /** Lost, but the rest of the crew was not in it: the beaten are back at the ship and the voyage goes on. */
  carriedBack: boolean;
  /** Who was beaten, for the heading. */
  enemies: string;
  heroes: Spoils[];
}

/** What the fight that just ended came to, from the events of the step that ended it. */
export function recapFor(events: WorldEvent[], settled: Battle, state: ClientState): Recap | null {
  const end = events.findIndex((e) => e.t === "battle_end");
  if (end < 0) return null;
  const endEvent = events[end];
  const status = endEvent.t === "battle_end" && (endEvent.status === "victory" || endEvent.status === "fled") ? endEvent.status : "defeat";
  const fell = new Set(events.filter((e) => e.t === "battle" && e.ev.t === "down").map((e) => (e.t === "battle" && e.ev.t === "down" ? e.ev.id : "")));
  const heroes: Spoils[] = settled.combatants
    .filter((c) => c.side === "hero")
    .map((c) => {
      const now = state.heroes.find((h) => h.id === c.id);
      return { id: c.id, name: c.name, xp: 0, gold: 0, items: [], resources: {}, blueprints: [], furnishings: [], level: null, fell: fell.has(c.id) || !!c.down, hp: now?.hp ?? c.hp, maxHp: now?.maxHp ?? c.maxHp };
    });
  const by = new Map(heroes.map((h) => [h.id, h]));
  for (const ev of events.slice(end + 1)) {
    if (ev.t === "xp") by.get(ev.heroId) && (by.get(ev.heroId)!.xp += ev.amount);
    else if (ev.t === "gold") by.get(ev.heroId) && (by.get(ev.heroId)!.gold += ev.amount);
    else if (ev.t === "loot") by.get(ev.heroId)?.items.push(ev.item);
    else if (ev.t === "level_up") by.get(ev.heroId) && (by.get(ev.heroId)!.level = ev.level);
    else if (ev.t === "blueprint") by.get(ev.heroId)?.blueprints.push(blueprintName(ev.blueprint));
    else if (ev.t === "furnishing") by.get(ev.heroId)?.furnishings.push(ev.furnishing.label);
    else if (ev.t === "resources") {
      const h = by.get(ev.heroId);
      if (h) for (const [kind, n] of Object.entries(ev.resources)) h.resources[kind as keyof Resources] = (h.resources[kind as keyof Resources] ?? 0) + (n ?? 0);
    }
  }
  return { status, carriedBack: events.some((e) => e.t === "carried_back"), enemies: groupNames(settled.combatants.filter((c) => c.side === "enemy").map((c) => c.kind)), heroes };
}

export function BattleRecap({ recap, you, onDone }: { recap: Recap; you: string; onDone(): void }) {
  const title = recap.status === "victory" ? "Victory" : recap.status === "fled" ? "You got away" : recap.carriedBack ? "Carried back to the ship" : "The party has fallen";
  const sub =
    recap.status === "victory" ? `${recap.enemies} beaten.`
    : recap.status === "fled" ? `${recap.enemies} did not follow.`
    : recap.carriedBack ? `${recap.enemies} had the better of it. The rest of the crew is still out there, so the voyage goes on.`
    : `${recap.enemies} had the better of it.`;
  // Your own hero first.
  const heroes = [...recap.heroes].sort((a, b) => Number(b.id === you) - Number(a.id === you));
  return (
    <div className={`battle-card recap ${recap.status}`} role="dialog" aria-label={title}>
      <h2>{title}</h2>
      <p className="muted">{sub}</p>
      <ul className="recap-heroes">
        {heroes.map((h) => {
          const gained = h.xp > 0 || h.gold > 0 || h.items.length > 0 || Object.keys(h.resources).length > 0 || h.blueprints.length > 0 || h.furnishings.length > 0;
          return (
            <li key={h.id} className={h.id === you ? "you" : ""}>
              <div className="recap-who">
                <strong>{h.name}</strong>
                {h.id === you && <span className="tag">you</span>}
                {h.fell && <span className="tag bad">knocked down</span>}
                {h.level !== null && <span className="tag good">level {h.level}!</span>}
                <span className="spacer" />
                <span className="muted">{h.hp} / {h.maxHp} HP</span>
              </div>
              {gained ? (
                <div className="recap-gains">
                  {h.xp > 0 && <span className="chip">+{h.xp} XP</span>}
                  {h.gold > 0 && <span className="chip gold">+{h.gold} gold</span>}
                  {Object.keys(h.resources).length > 0 && <span className="chip">{resourceText(h.resources)}</span>}
                  {h.items.map((item, i) => <span key={i} className="chip" style={{ borderColor: RARITY_COLOR[item.rarity], color: RARITY_COLOR[item.rarity] }}>{itemName(item)}</span>)}
                  {h.blueprints.map((b, i) => <span key={`b${i}`} className="chip">Blueprint: {b}</span>)}
                  {h.furnishings.map((f, i) => <span key={`f${i}`} className="chip">{f}</span>)}
                </div>
              ) : (
                <div className="muted">{recap.status === "victory" ? "Nothing to show for it this time." : "Nothing gained."}</div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="row">
        <span className="spacer" />
        <button className="primary" autoFocus onClick={onDone}>Continue</button>
      </div>
    </div>
  );
}

// ---------- a cache opened ----------

export interface Find {
  hero: string;
  mine: boolean;
  xp: number;
  gold: number;
  items: ItemDef[];
  resources: Resources;
  blueprints: string[];
  furnishings: string[];
  /** Two or more of the three rolls landed: there was a potion in it too. */
  potion: boolean;
}

/** What a successful search turned up, from the events of the step it happened in. Null if this step found nothing. */
export function findFor(events: WorldEvent[], you: string, names: Map<string, string>): Find | null {
  const at = events.findIndex((e) => e.t === "search" && e.found);
  const search = events[at];
  if (at < 0 || search.t !== "search") return null;
  const find: Find = { hero: names.get(search.heroId) ?? "Someone", mine: search.heroId === you, xp: 0, gold: 0, items: [], resources: {}, blueprints: [], furnishings: [], potion: false };
  const roll = events[at - 1];
  if (roll?.t === "check" && roll.check.successes >= 2) find.potion = true;
  for (const ev of events.slice(at + 1)) {
    if (!("heroId" in ev) || ev.heroId !== search.heroId) continue;
    if (ev.t === "xp") find.xp += ev.amount;
    else if (ev.t === "gold") find.gold += ev.amount;
    else if (ev.t === "loot") find.items.push(ev.item);
    else if (ev.t === "blueprint") find.blueprints.push(blueprintName(ev.blueprint));
    else if (ev.t === "furnishing") find.furnishings.push(ev.furnishing.label);
    else if (ev.t === "resources") for (const [kind, n] of Object.entries(ev.resources)) find.resources[kind as keyof Resources] = (find.resources[kind as keyof Resources] ?? 0) + (n ?? 0);
  }
  return find;
}

export function FindCard({ find, onDone }: { find: Find; onDone(): void }) {
  const empty = find.gold === 0 && find.items.length === 0 && Object.keys(find.resources).length === 0 && find.blueprints.length === 0 && find.furnishings.length === 0;
  return (
    <div className="battle-card recap victory" role="dialog" aria-label="Treasure found">
      <h2>{find.mine ? "You found something!" : `${find.hero} found something!`}</h2>
      <p className="muted">The cache gives up what it was hiding.</p>
      <div className="recap-gains find-gains">
        {find.gold > 0 && <span className="chip gold">+{find.gold} gold</span>}
        {find.potion && <span className="chip">A potion</span>}
        {find.items.map((item, i) => <span key={i} className="chip" style={{ borderColor: RARITY_COLOR[item.rarity], color: RARITY_COLOR[item.rarity] }}>{itemName(item)}</span>)}
        {Object.keys(find.resources).length > 0 && <span className="chip">{resourceText(find.resources)}</span>}
        {find.blueprints.map((b, i) => <span key={`b${i}`} className="chip">Blueprint: {b}</span>)}
        {find.furnishings.map((f, i) => <span key={`f${i}`} className="chip">{f}</span>)}
        {find.xp > 0 && <span className="chip">+{find.xp} XP</span>}
        {empty && <span className="muted">Less than it promised.</span>}
      </div>
      <div className="row">
        <span className="spacer" />
        <button className="primary" autoFocus onClick={onDone}>Continue</button>
      </div>
    </div>
  );
}
