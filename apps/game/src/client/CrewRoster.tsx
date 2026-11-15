// Who is in the crew (or in the room): one tidy row per person with their
// sprite, name, level and class, here-first. Shared by the Harbor's Crew
// panel and the "Inside" panels of the hut and the pub.

import { useEffect, useState, type ReactNode } from "react";
import type { Outfit } from "@gantt-quest/world";
import { label } from "./labels";
import { spriteDataUrl, spriteKey } from "./render/sprites";
import "./roster.css";

export interface RosterMember {
  id: string;
  name: string;
  classId: string;
  level: number;
  /** In this place right now. Away members are greyed and listed after everyone here. */
  here: boolean;
  /** What they are wearing, when known (only for people present). */
  outfit?: Outfit;
  /** Extra small tags after the name, e.g. "owner". */
  tags?: string[];
}

/** One thing to do with a crewmate, offered when their row is right-clicked. */
export interface RosterAction {
  label: string;
  /** Why it cannot be done right now: shown greyed out, with this under it. */
  blocked?: string;
  run(): void;
}

interface Props {
  members: RosterMember[];
  you: string | null;
  /** The line above the list, e.g. "3 of 9 here". */
  heading: ReactNode;
  /** Open this person's hero sheet. */
  onOpen?(id: string): void;
  /** Whose sheet is open, to mark their row. */
  openId?: string | null;
  /** Offer a Trade button on everyone but you. */
  onTrade?(id: string): void;
  /** What a right-click on someone's row offers (trade, teleport to them). Nothing for an empty list. */
  menu?(member: RosterMember): RosterAction[];
}

// toDataURL is not free: draw each look once.
const faces = new Map<string, string>();
function face(classId: string, outfit?: Outfit): string {
  const key = spriteKey(classId, outfit);
  let url = faces.get(key);
  if (!url) faces.set(key, (url = spriteDataUrl(classId, outfit)));
  return url;
}

/** Two pixel arrows passing each other: give and take. */
const TradeIcon = () => (
  <svg className="cm-trade-icon" viewBox="0 0 7 11" width={14} height={22} shapeRendering="crispEdges" aria-hidden>
    <path fill="currentColor" d="M4 0h1v5H4zM5 1h1v3H5zM6 2h1v1H6zM0 2h4v1H0zM2 6h1v5H2zM1 7h1v3H1zM0 8h1v1H0zM3 8h4v1H3z" />
  </svg>
);

const byName = (a: RosterMember, b: RosterMember) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

export function CrewRoster({ members, you, heading, onOpen, openId, onTrade, menu }: Props) {
  const here = members.filter((m) => m.here).sort(byName);
  const away = members.filter((m) => !m.here).sort(byName);
  /** The menu that is open: whose, and where on screen it was asked for. */
  const [asked, setAsked] = useState<{ id: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!asked) return;
    const close = () => setAsked(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    // On the next turn of the loop, so the click that opened it does not close it.
    const t = setTimeout(() => {
      addEventListener("pointerdown", close);
      addEventListener("keydown", onKey);
    });
    return () => {
      clearTimeout(t);
      removeEventListener("pointerdown", close);
      removeEventListener("keydown", onKey);
    };
  }, [asked]);
  const askedOf = asked ? members.find((m) => m.id === asked.id) : undefined;
  const offered = askedOf && menu ? menu(askedOf) : [];

  const row = (m: RosterMember) => {
    const mine = m.id === you;
    const cls = label("class", m.classId);
    const body = (
      <>
        <span className="cm-face">
          <img className="pixel-icon" src={face(m.classId, m.outfit)} width={36} height={44} alt="" />
          <i className={`dot ${m.here ? "on" : ""}`} />
        </span>
        <span className="cm-text">
          <span className="cm-line">
            <strong className="cm-name">{m.name}</strong>
            {mine && <span className="cm-tag you">you</span>}
            {m.tags?.map((t) => <span key={t} className="cm-tag">{t}</span>)}
          </span>
          <span className="cm-line">
            <span className="cm-lv">Lv {m.level}</span>
            <span className="cm-class">{cls}</span>
          </span>
        </span>
      </>
    );
    return (
      <li
        key={m.id}
        className={`cm ${m.here ? "here" : "away"}${mine ? " mine" : ""}${m.id === openId ? " open" : ""}`}
        onContextMenu={(e) => {
          if (!menu || menu(m).length === 0) return;
          e.preventDefault();
          setAsked({ id: m.id, x: e.clientX, y: e.clientY });
        }}
      >
        {onOpen ? (
          <button type="button" className="cm-main" title={`${m.name}, level ${m.level} ${cls}${m.here ? "" : " (away)"}. Look them over.`} onClick={() => onOpen(m.id)}>
            {body}
          </button>
        ) : (
          <span className="cm-main" title={`${m.name}, level ${m.level} ${cls}`}>{body}</span>
        )}
        {onTrade && !mine && (
          <button type="button" className="small cm-trade" title={`Give or trade with ${m.name}`} aria-label={`Trade with ${m.name}`} onClick={() => onTrade(m.id)}>
            <TradeIcon />
          </button>
        )}
      </li>
    );
  };

  return (
    <div className="panel crew-roster">
      <h3 className="roster-head">{heading}</h3>
      <ul className="roster">
        {here.map(row)}
        {away.length > 0 && here.length > 0 && <li className="roster-sep" aria-hidden>Away</li>}
        {away.map(row)}
      </ul>
      {asked && askedOf && offered.length > 0 && (
        <div className="cm-menu panel" role="menu" aria-label={askedOf.name} style={{ left: Math.min(asked.x, innerWidth - 230), top: Math.min(asked.y, innerHeight - 40 - offered.length * 44) }} onPointerDown={(e) => e.stopPropagation()}>
          <strong className="cm-menu-name">{askedOf.name}</strong>
          {offered.map((a) => (
            <button key={a.label} type="button" role="menuitem" className="cm-menu-item" disabled={!!a.blocked} onClick={() => { setAsked(null); a.run(); }}>
              <span>{a.label}</span>
              {a.blocked && <span className="muted">{a.blocked}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
