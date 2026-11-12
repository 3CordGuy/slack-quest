// The admin side: browse every named thing in the game, rename it or rewrite
// its blurb, see who changed what, and revert to the code default. Saves go
// live for every player on their next reload. Only reachable at #admin by an
// account on the ADMIN_EMAILS allow-list; the server checks every call.

import { useCallback, useEffect, useMemo, useState } from "react";
import { CATALOGUE, CATALOGUE_KINDS, type CatalogueKind } from "@gantt-quest/world";
import type { HistoryRow, NameValue, OverrideRow } from "../../server/content";
import type { Me } from "../api";
import { loadContent } from "../content";
import { adminApi } from "./adminApi";
import "./admin.css";

/** Mirrors the server's limits so the counter warns before a save is refused. */
const NAME_MAX = 32;
const BLURB_MAX = 200;

const KIND_LABEL: Record<CatalogueKind, string> = {
  class: "Classes",
  ability: "Abilities",
  weapon: "Weapons",
  gear: "Gear",
  enemy: "Enemies",
  furnishing: "Furnishings",
  resource: "Resources",
  pub: "Pub menu",
  project: "Projects",
  effect: "Effects",
};

const when = (at: number) => new Date(at).toLocaleString();

export function AdminView({ me, onLeave }: { me: Me; onLeave: () => void }) {
  const [kind, setKind] = useState<CatalogueKind>("class");
  const [query, setQuery] = useState("");
  const [overrides, setOverrides] = useState<OverrideRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setOverrides(await adminApi.list());
      // Keep this tab's own UI in step with what was just saved.
      await loadContent();
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => void reload(), [reload]);

  const names = useMemo(() => {
    const map = new Map<string, NameValue>();
    for (const o of overrides ?? []) if (o.kind === "name") map.set(o.target, o.value as NameValue);
    return map;
  }, [overrides]);

  const rows = Object.entries(CATALOGUE[kind])
    .map(([id, def]) => ({ id, def, over: names.get(`${kind}:${id}`) }))
    .filter(({ id, def, over }) => {
      const q = query.trim().toLowerCase();
      return !q || [id, def.name, over?.name ?? ""].some((s) => s.toLowerCase().includes(q));
    });
  const modifiedIn = (k: CatalogueKind) => [...names.keys()].filter((t) => t.startsWith(`${k}:`)).length;

  async function doExport() {
    const bundle = await adminApi.exportAll();
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `gantt-quest-content-v${bundle.version}.json` });
    a.click();
    URL.revokeObjectURL(url);
  }

  async function doImport(file: File) {
    setError(null);
    try {
      const r = await adminApi.importAll(JSON.parse(await file.text()));
      setNotice(`Imported ${r.imported} overrides (version ${r.version}).`);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!me.isAdmin) {
    return (
      <div className="centre">
        <div className="panel">
          <p>This page is for admins.</p>
          <button onClick={onLeave}>Back to the Harbor</button>
        </div>
      </div>
    );
  }

  return (
    <div className="admin">
      <div className="topbar">
        <strong>Admin · content</strong>
        <span className="muted">Names and blurbs. Changes reach players on their next reload.</span>
        <span className="spacer" />
        <button className="small" onClick={() => void doExport()}>Export</button>
        <label className="small button-like">
          Import
          <input type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && void doImport(e.target.files[0])} />
        </label>
        <button className="small" onClick={onLeave}>Back to the Harbor</button>
      </div>
      {error && <p className="bad admin-msg">{error}</p>}
      {notice && <p className="good admin-msg">{notice}</p>}

      <div className="admin-body">
        <nav className="admin-kinds panel">
          {CATALOGUE_KINDS.map((k) => (
            <button key={k} className={k === kind ? "selected" : ""} onClick={() => (setKind(k), setSelected(null))}>
              {KIND_LABEL[k]}
              {modifiedIn(k) > 0 && <span className="tag">{modifiedIn(k)}</span>}
            </button>
          ))}
        </nav>

        <section className="admin-list panel">
          <input className="admin-search" placeholder={`Search ${KIND_LABEL[kind].toLowerCase()}…`} value={query} onChange={(e) => setQuery(e.target.value)} />
          {!overrides && <p className="muted">Loading…</p>}
          <ul>
            {rows.map(({ id, def, over }) => (
              <li key={id}>
                <button className={`admin-row ${selected === id ? "selected" : ""}`} onClick={() => setSelected(id)}>
                  <span>
                    <strong>{over?.name ?? def.name}</strong>
                    {over && <span className="tag good">modified</span>}
                  </span>
                  <span className="muted">{id}{over?.name ? ` · was ${def.name}` : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {selected && CATALOGUE[kind][selected] && (
          <NameEditor
            key={`${kind}:${selected}`}
            kind={kind}
            id={selected}
            current={names.get(`${kind}:${selected}`)}
            onSaved={async (msg) => {
              setError(null);
              setNotice(msg);
              await reload();
            }}
            onError={setError}
          />
        )}
      </div>
    </div>
  );
}

function NameEditor({ kind, id, current, onSaved, onError }: {
  kind: CatalogueKind;
  id: string;
  current: NameValue | undefined;
  onSaved: (msg: string) => Promise<void>;
  onError: (msg: string) => void;
}) {
  const def = CATALOGUE[kind][id];
  const target = `${kind}:${id}`;
  const hasBlurb = def.blurb !== undefined;
  const [name, setName] = useState(current?.name ?? def.name);
  const [text, setText] = useState(current?.blurb ?? def.blurb ?? "");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryRow[] | null>(null);

  useEffect(() => {
    adminApi.history("name", target).then(setHistory, () => setHistory([]));
  }, [target, current]);

  // Only fields that differ from the code default are stored, so a later code change to the other still shows.
  const value: NameValue = {};
  if (name.trim() !== def.name) value.name = name;
  if (hasBlurb && text.trim() !== def.blurb) value.blurb = text;
  const changed = (value.name ?? def.name) !== (current?.name ?? def.name) || (value.blurb ?? def.blurb) !== (current?.blurb ?? def.blurb);
  const tooLong = name.trim().length > NAME_MAX || text.trim().length > BLURB_MAX;

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

  const save = () =>
    Object.keys(value).length === 0
      ? run(() => adminApi.revert("name", target), `${def.name} is back to its default.`)
      : run(() => adminApi.save("name", target, value), `Saved ${value.name ?? def.name}.`);

  return (
    <section className="admin-editor panel">
      <h2>{current?.name ?? def.name}</h2>
      <p className="muted">{target}</p>

      <label className="admin-field">
        <span>Name <span className={name.trim().length > NAME_MAX ? "bad" : "muted"}>{name.trim().length}/{NAME_MAX}</span></span>
        <input value={name} maxLength={NAME_MAX + 20} onChange={(e) => setName(e.target.value)} />
        <span className="muted">Default: {def.name}</span>
      </label>

      {hasBlurb && (
        <label className="admin-field">
          <span>Blurb <span className={text.trim().length > BLURB_MAX ? "bad" : "muted"}>{text.trim().length}/{BLURB_MAX}</span></span>
          <textarea rows={3} value={text} onChange={(e) => setText(e.target.value.replace(/\n/g, " "))} />
          <span className="muted">Default: {def.blurb}</span>
        </label>
      )}

      <div className="admin-actions">
        <button className="primary" disabled={busy || !changed || tooLong || !name.trim()} onClick={() => void save()}>Save</button>
        <button disabled={busy || !current} onClick={() => void run(() => adminApi.revert("name", target), `${def.name} is back to its default.`)}>Revert to default</button>
      </div>

      <h3>History</h3>
      {history === null && <p className="muted">Loading…</p>}
      {history?.length === 0 && <p className="muted">Never changed.</p>}
      <ul className="admin-history">
        {history?.map((h) => {
          const v = h.new as NameValue | null;
          return (
            <li key={h.id}>
              <span>
                {v ? <>{v.name ?? <span className="muted">(default name)</span>}{v.blurb ? <span className="muted"> · {v.blurb}</span> : null}</> : <span className="muted">Reverted to default</span>}
              </span>
              <span className="muted">{h.by_name ?? h.by} · {when(h.at)}</span>
              {v && <button className="small" disabled={busy} onClick={() => void run(() => adminApi.save("name", target, v), "Restored that version.")}>Restore</button>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
