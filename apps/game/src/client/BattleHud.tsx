// The battle HUD: turn order, a chip per combatant, and the acting hero's
// abilities. It only needs a battle and somewhere to send the chosen action,
// so a voyage's fight and a sparring bout in the Harbor share it.

import { useEffect, useState } from "react";
import { ABILITIES, EFFECT_INFO, STAT_LABEL, type AbilityDef, type BattleAction, type BattleState, type Combatant } from "@gantt-quest/world";
import { DragPanel } from "./DragPanel";
import { blurb, label } from "./labels";

/** Whole seconds until `deadline` (epoch ms), re-rendering each second. Null when there is no deadline. */
export function useCountdown(deadline: number | null | undefined): number | null {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return deadline ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : null;
}

function CombatantChip({ c, active, onClick, selectable }: { c: Combatant; active: boolean; onClick?: () => void; selectable?: boolean }) {
  return (
    <button className={`chip ${c.side} ${active ? "active" : ""} ${c.down ? "down" : ""} ${selectable ? "selectable" : ""}`} disabled={!selectable} onClick={onClick}>
      <strong>{c.name}</strong>
      <span className="bar"><span className="bar-fill hp" style={{ width: `${(100 * c.hp) / c.maxHp}%` }} /><span>{c.hp} / {c.maxHp}</span></span>
      {c.effects.length > 0 && <span className="effects">{c.effects.map((e) => <i key={e.kind} style={{ color: EFFECT_INFO[e.kind].color }} title={blurb("effect", e.kind)}>{label("effect", e.kind)}</i>)}</span>}
    </button>
  );
}

interface Props {
  /** `deadline` is the turn timer, in epoch ms, where there is one. */
  battle: BattleState & { deadline?: number | null };
  /** The viewer's combatant id. They may not be in the fight. */
  you: string;
  onAction(action: BattleAction): void;
}

export function BattleHud({ battle, you, onAction }: Props) {
  const [abilityId, setAbilityId] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  const left = useCountdown(battle.deadline);
  const actorId = battle.order[battle.turn];
  const actor = battle.combatants.find((c) => c.id === actorId);
  const me = battle.combatants.find((c) => c.id === you);
  const mine = actorId === you && !!me;
  useEffect(() => {
    setAbilityId(null);
    setFocus(0);
  }, [actorId, battle.round]);

  const ability: AbilityDef | null = abilityId ? ABILITIES[abilityId] : null;
  const fire = (target?: string) => {
    if (!ability) return;
    onAction({ type: "ability", ability: ability.id, target, focus: Math.min(focus, ability.rolls) });
  };
  const targetSide = ability?.target === "enemy" ? "enemy" : ability?.target === "ally" ? "hero" : null;
  const order = battle.order.map((id) => battle.combatants.find((c) => c.id === id)!).filter((c) => !c.down);

  return (
    <div className="battle">
      <DragPanel id="run.timeline" title="Turn order" compact className="timeline panel">
        <span className="muted">Round {battle.round}</span>
        {order.map((c) => <span key={c.id} className={`turn-chip ${c.side} ${c.id === actorId ? "active" : ""}`}>{c.name}</span>)}
        {left !== null && <span className={left <= 15 ? "bad" : "muted"}>{left}s</span>}
      </DragPanel>
      <div className="sides">
        {(["hero", "enemy"] as const).map((side) => (
          <div key={side} className="side">
            {battle.combatants.filter((c) => c.side === side).map((c) => (
              <CombatantChip key={c.id} c={c} active={c.id === actorId} selectable={mine && targetSide === side && !c.down} onClick={() => fire(c.id)} />
            ))}
          </div>
        ))}
      </div>
      <DragPanel id="run.actions" title="Actions" compact className="actions panel">
        {mine && me ? (
          <>
            <div className="ability-row">
              {me.abilities.map((id) => {
                const a = ABILITIES[id];
                return (
                  <button key={id} className={`ability ${abilityId === id ? "selected" : ""}`} onClick={() => { setAbilityId(id); setFocus((f) => Math.min(f, a.rolls)); }}>
                    <strong>{label("ability", id)}</strong>
                    <span>{a.rolls} × {me.pct[a.stat]}% {STAT_LABEL[a.stat]}</span>
                    <span className="muted">{blurb("ability", id)}</span>
                  </button>
                );
              })}
            </div>
            <div className="row">
              {ability ? (
                <>
                  <span>Focus:</span>
                  {Array.from({ length: Math.min(me.focus, ability.rolls) + 1 }, (_, i) => (
                    <button key={i} className={`small ${focus === i ? "selected" : ""}`} onClick={() => setFocus(i)}>{i}</button>
                  ))}
                  {targetSide ? <span className="muted">Now pick {targetSide === "enemy" ? "an enemy" : "an ally"} above.</span> : <button className="primary" onClick={() => fire()}>Use {label("ability", ability.id)}</button>}
                </>
              ) : (
                <span className="muted">Your turn. Choose an ability.</span>
              )}
              <span className="spacer" />
              <button disabled={me.potions <= 0} onClick={() => onAction({ type: "potion" })}>Potion ({me.potions})</button>
              {!battle.boss && <button onClick={() => onAction({ type: "flee" })}>Flee</button>}
            </div>
          </>
        ) : (
          <span>{me ? <>Waiting for <strong>{actor?.name}</strong>…</> : "Your crewmates are fighting. You are too far away to join."}</span>
        )}
      </DragPanel>
    </div>
  );
}
