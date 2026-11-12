// Pieces shared by the admin editors: the history list with "restore", and
// the busy/error wrapper every save and revert goes through.

import { useEffect, useState } from "react";
import { CATALOGUE } from "@gantt-quest/world";
import type { HistoryRow, OverrideKind, OverrideValue } from "../../server/content";
import { label } from "../labels";
import { LOOKS } from "../render/looks";
import { adminApi } from "./adminApi";

export const when = (at: number) => new Date(at).toLocaleString();

export interface EditorProps {
  onSaved: (msg: string) => Promise<void>;
  onError: (msg: string) => void;
}

/** Run one save or revert, report it, and keep the buttons disabled meanwhile. */
export function useRunner({ onSaved, onError }: EditorProps) {
  const [busy, setBusy] = useState(false);
  async function run(work: () => Promise<unknown>, msg: string) {
    setBusy(true);
    try {
      await work();
      await onSaved(msg);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return { busy, run };
}

/** A target's past versions, newest first, each with a Restore button. `current` refetches it after a save. */
export function History<V extends OverrideValue>({ kind, target, current, busy, render, onRestore }: {
  kind: OverrideKind;
  target: string;
  current: unknown;
  busy: boolean;
  render: (v: V) => React.ReactNode;
  onRestore: (v: V) => void;
}) {
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  useEffect(() => {
    adminApi.history(kind, target).then(setHistory, () => setHistory([]));
  }, [kind, target, current]);
  return (
    <>
      <h3>History</h3>
      {history === null && <p className="muted">Loading…</p>}
      {history?.length === 0 && <p className="muted">Never changed.</p>}
      <ul className="admin-history">
        {history?.map((h) => {
          const v = h.new as V | null;
          return (
            <li key={h.id}>
              <span>{v ? render(v) : <span className="muted">Reverted to default</span>}</span>
              <span className="muted">{h.by_name ?? h.by} · {when(h.at)}</span>
              {v && <button className="small" disabled={busy} onClick={() => onRestore(v)}>Restore</button>}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Who wears a look: a hero class, an enemy, or someone else (the townsfolk and salesmen). */
export type LookGroup = "class" | "enemy" | "other";
export const LOOK_GROUP_LABEL: Record<LookGroup, string> = { class: "Classes", enemy: "Enemies", other: "Townsfolk" };

export const lookGroup = (kind: string): LookGroup => (CATALOGUE.class[kind] ? "class" : CATALOGUE.enemy[kind] ? "enemy" : "other");

const titleCase = (id: string) => id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** A look's display name: its class or enemy name where it has one. */
export function lookName(kind: string): string {
  const g = lookGroup(kind);
  return g === "other" ? titleCase(kind) : label(g, kind);
}

export const LOOK_KINDS = Object.keys(LOOKS);
