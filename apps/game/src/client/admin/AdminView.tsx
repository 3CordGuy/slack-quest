// The admin side: browse every named thing, look and item icon in the game;
// rename it, recolour it or redraw it; see who changed what; revert to the
// code default. Saves go live for every player on their next reload. Only
// reachable at #admin by an account on the ADMIN_EMAILS allow-list; the
// server checks every call.

import { useCallback, useEffect, useMemo, useState } from "react";
import { CATALOGUE, CATALOGUE_KINDS, GEAR_BASES, RARITY_COLOR, SLOT_ICON, SLOT_LABEL, WEAPON_ICON, type CatalogueKind, type Slot } from "@gantt-quest/world";
import type { ImageValue, LogRow, NameValue, OverrideKind, OverrideRow, OverrideValue, PaletteValue } from "../../server/content";
import type { Me } from "../api";
import { loadContent } from "../content";
import { ITEM_ART_NAMES, itemArtUrl } from "../itemArt";
import { label } from "../labels";
import { previewSpriteUrl } from "../render/sprites";
import { adminApi } from "./adminApi";
import { IconEditor, IconThumb } from "./IconEditor";
import { PaletteEditor, Swatches } from "./PaletteEditor";
import { History, LOOK_GROUP_LABEL, LOOK_KINDS, lookGroup, lookName, useRunner, when, type EditorProps, type LookGroup } from "./shared";
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

type Tab = CatalogueKind | "looks" | "icons" | "log";

/** Which items (and empty equipment slots) are drawn with each icon. Several share one. */
const ICON_USERS: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {};
  const add = (icon: string, who: string) => (out[icon] ??= []).push(who);
  for (const [id, icon] of Object.entries(WEAPON_ICON)) if (CATALOGUE.weapon[id]) add(icon, `weapon:${id}`);
  for (const b of GEAR_BASES) add(b.icon, `gear:${b.ref}`);
  for (const [slot, icon] of Object.entries(SLOT_ICON)) add(icon, `slot:${slot}`);
  return out;
})();

/** Names of the icon's users, with any renames applied. */
const iconUsers = (icon: string) =>
  (ICON_USERS[icon] ?? []).map((u) => {
    const [k, id] = u.split(":");
    return k === "slot" ? `empty ${SLOT_LABEL[id as Slot].toLowerCase()} slot` : label(k as CatalogueKind, id);
  });

const keyOf = (kind: OverrideKind, target: string) => `${kind}|${target}`;

/** Where an override is edited: the tab and the selected row. */
function tabFor(kind: OverrideKind, target: string): { tab: Tab; id: string } | null {
  if (kind === "palette") return { tab: "looks", id: target };
  if (kind === "icon") return { tab: "icons", id: target };
  if (kind === "name") {
    const [k, id] = [target.slice(0, target.indexOf(":")), target.slice(target.indexOf(":") + 1)];
    return { tab: k as CatalogueKind, id };
  }
  return null;
}

/** A one-line, human name for an override's target. */
function targetName(kind: OverrideKind, target: string): string {
  if (kind === "palette") return `${lookName(target)} (look)`;
  if (kind === "icon") return `${target} (icon)`;
  if (kind === "name") {
    const k = target.slice(0, target.indexOf(":")) as CatalogueKind;
    const id = target.slice(k.length + 1);
    return `${CATALOGUE[k]?.[id]?.name ?? id} (${KIND_LABEL[k]?.toLowerCase() ?? k})`;
  }
  return target;
}

function ValueSummary({ kind, target, v }: { kind: OverrideKind; target: string; v: OverrideValue }) {
  if (kind === "palette") return <Swatches v={v as PaletteValue} />;
  if (kind === "icon") return <IconThumb name={target} png={(v as ImageValue).png} size={27} />;
  if (kind === "name") {
    const n = v as NameValue;
    return <span>{n.name ?? <span className="muted">(default name)</span>}{n.blurb ? <span className="muted"> · {n.blurb}</span> : null}</span>;
  }
  return <span className="muted">(image)</span>;
}

export function AdminView({ me, onLeave }: { me: Me; onLeave: () => void }) {
  const [tab, setTab] = useState<Tab>("class");
  const [query, setQuery] = useState("");
  const [modifiedOnly, setModifiedOnly] = useState(false);
  const [lookFilter, setLookFilter] = useState<LookGroup | "all">("all");
  const [overrides, setOverrides] = useState<OverrideRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Bumped after every save so lists redraw their thumbnails from the new bundle.
  const [stamp, setStamp] = useState(0);

  const reload = useCallback(async () => {
    try {
      setOverrides(await adminApi.list());
      // Keep this tab's own UI and art in step with what was just saved.
      await loadContent();
      setStamp((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => void reload(), [reload]);

  const byKey = useMemo(() => {
    const map = new Map<string, OverrideValue>();
    for (const o of overrides ?? []) map.set(keyOf(o.kind, o.target), o.value);
    return map;
  }, [overrides]);
  const get = <V extends OverrideValue>(kind: OverrideKind, target: string) => byKey.get(keyOf(kind, target)) as V | undefined;

  const q = query.trim().toLowerCase();
  const matches = (...texts: string[]) => !q || texts.some((s) => s.toLowerCase().includes(q));

  const modifiedIn = (t: Tab): number => {
    const rows = overrides ?? [];
    if (t === "looks") return rows.filter((o) => o.kind === "palette").length;
    if (t === "icons") return rows.filter((o) => o.kind === "icon").length;
    if (t === "log") return 0;
    return rows.filter((o) => o.kind === "name" && o.target.startsWith(`${t}:`)).length;
  };

  const editorProps: EditorProps = {
    onSaved: async (msg) => {
      setError(null);
      setNotice(msg);
      await reload();
    },
    onError: (msg) => (setNotice(null), setError(msg)),
  };

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

  const choose = (t: Tab, id: string | null = null) => {
    setTab(t);
    setSelected(id);
  };

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

  const nav = (t: Tab, text: string) => (
    <button key={t} className={t === tab ? "selected" : ""} onClick={() => choose(t)}>
      {text}
      {modifiedIn(t) > 0 && <span className="tag">{modifiedIn(t)}</span>}
    </button>
  );

  let list: React.ReactNode = null;
  let editor: React.ReactNode = null;

  if (tab === "looks") {
    const rows = LOOK_KINDS.filter((k) => {
      const over = get<PaletteValue>("palette", k);
      return (lookFilter === "all" || lookGroup(k) === lookFilter) && (!modifiedOnly || over) && matches(k, lookName(k));
    });
    list = (
      <>
        <div className="admin-filters">
          {(["all", "class", "enemy", "other"] as const).map((g) => (
            <button key={g} className={`small ${lookFilter === g ? "selected" : ""}`} onClick={() => setLookFilter(g)}>{g === "all" ? "All" : LOOK_GROUP_LABEL[g]}</button>
          ))}
        </div>
        <ul>
          {rows.map((k) => {
            const over = get<PaletteValue>("palette", k);
            return (
              <li key={k}>
                <button className={`admin-row with-thumb ${selected === k ? "selected" : ""}`} onClick={() => setSelected(k)}>
                  <img src={previewSpriteUrl(k, over)} alt="" className="pixel" width={36} height={44} data-stamp={stamp} />
                  <span>
                    <strong>{lookName(k)}</strong>
                    {over && <span className="tag good">modified</span>}
                    <span className="muted"> {k} · {LOOK_GROUP_LABEL[lookGroup(k)].toLowerCase()}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </>
    );
    if (selected && LOOK_KINDS.includes(selected)) {
      const cur = get<PaletteValue>("palette", selected);
      editor = <PaletteEditor key={`${selected}:${JSON.stringify(cur ?? null)}`} kind={selected} current={cur} {...editorProps} />;
    }
  } else if (tab === "icons") {
    const rows = ITEM_ART_NAMES.filter((n) => (!modifiedOnly || get("icon", n)) && matches(n, ...iconUsers(n)));
    list = (
      <ul className="admin-icon-grid">
        {rows.map((n) => (
          <li key={n}>
            <button className={`admin-icon-cell ${selected === n ? "selected" : ""} ${get("icon", n) ? "modified" : ""}`} title={[n, ...iconUsers(n)].join("\n")} onClick={() => setSelected(n)}>
              <img src={itemArtUrl(n, RARITY_COLOR.rare)} alt="" className="pixel" width={36} height={36} data-stamp={stamp} />
              <span>{n}</span>
            </button>
          </li>
        ))}
      </ul>
    );
    if (selected && ITEM_ART_NAMES.includes(selected)) {
      editor = <IconEditor key={selected} name={selected} current={get<ImageValue>("icon", selected)} usedBy={iconUsers(selected)} {...editorProps} />;
    }
  } else if (tab === "log") {
    list = <ChangeLog stamp={stamp} onOpen={(kind, target) => {
      const where = tabFor(kind, target);
      if (where) choose(where.tab, where.id);
    }} />;
  } else {
    const kind = tab;
    const rows = Object.entries(CATALOGUE[kind])
      .map(([id, def]) => ({ id, def, over: get<NameValue>("name", `${kind}:${id}`) }))
      .filter(({ id, def, over }) => (!modifiedOnly || over) && matches(id, def.name, over?.name ?? ""));
    list = (
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
    );
    if (selected && CATALOGUE[kind][selected]) {
      editor = <NameEditor key={`${kind}:${selected}`} kind={kind} id={selected} current={get<NameValue>("name", `${kind}:${selected}`)} {...editorProps} />;
    }
  }

  const searchLabel = tab === "looks" ? "looks" : tab === "icons" ? "icons or items" : tab === "log" ? "" : KIND_LABEL[tab].toLowerCase();

  return (
    <div className={`admin ${selected ? "has-selection" : ""}`}>
      <div className="topbar">
        <strong>Admin · content</strong>
        <span className="muted admin-hint">Names, looks and icons. Changes reach players on their next reload.</span>
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
          <span className="admin-nav-head muted">Names</span>
          {CATALOGUE_KINDS.map((k) => nav(k, KIND_LABEL[k]))}
          <span className="admin-nav-head muted">Art</span>
          {nav("looks", "Sprite looks")}
          {nav("icons", "Item icons")}
          <span className="admin-nav-head muted">History</span>
          {nav("log", "Change log")}
        </nav>

        <section className="admin-list panel">
          {tab !== "log" && (
            <div className="admin-search-row">
              <input className="admin-search" type="search" placeholder={`Search ${searchLabel}…`} value={query} onChange={(e) => setQuery(e.target.value)} />
              <label className="admin-check"><input type="checkbox" checked={modifiedOnly} onChange={(e) => setModifiedOnly(e.target.checked)} /> modified only</label>
            </div>
          )}
          {!overrides && <p className="muted">Loading…</p>}
          {list}
        </section>

        {editor && (
          <div className="admin-editor-wrap">
            <button className="small admin-close" onClick={() => setSelected(null)}>← Back to the list</button>
            {editor}
          </div>
        )}
      </div>
    </div>
  );
}

/** Every change of every kind, newest first; click one to open its editor. */
function ChangeLog({ stamp, onOpen }: { stamp: number; onOpen: (kind: OverrideKind, target: string) => void }) {
  const [log, setLog] = useState<LogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    adminApi.log().then(setLog, (e: Error) => setError(e.message));
  }, [stamp]);
  if (error) return <p className="bad">{error}</p>;
  if (!log) return <p className="muted">Loading…</p>;
  if (!log.length) return <p className="muted">Nothing has been changed yet.</p>;
  return (
    <ul className="admin-log">
      {log.map((r) => (
        <li key={r.id}>
          <button className="admin-row" onClick={() => onOpen(r.kind, r.target)} disabled={!tabFor(r.kind, r.target)}>
            <span><strong>{targetName(r.kind, r.target)}</strong></span>
            <span>{r.new ? <ValueSummary kind={r.kind} target={r.target} v={r.new} /> : <span className="muted">Reverted to default</span>}</span>
            <span className="muted">{r.by_name ?? r.by} · {when(r.at)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function NameEditor({ kind, id, current, ...props }: { kind: CatalogueKind; id: string; current: NameValue | undefined } & EditorProps) {
  const def = CATALOGUE[kind][id];
  const target = `${kind}:${id}`;
  const hasBlurb = def.blurb !== undefined;
  const [name, setName] = useState(current?.name ?? def.name);
  const [text, setText] = useState(current?.blurb ?? def.blurb ?? "");
  const { busy, run } = useRunner(props);

  // Only fields that differ from the code default are stored, so a later code change to the other still shows.
  const value: NameValue = {};
  if (name.trim() !== def.name) value.name = name;
  if (hasBlurb && text.trim() !== def.blurb) value.blurb = text;
  const changed = (value.name ?? def.name) !== (current?.name ?? def.name) || (value.blurb ?? def.blurb) !== (current?.blurb ?? def.blurb);
  const tooLong = name.trim().length > NAME_MAX || text.trim().length > BLURB_MAX;

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

      <History<NameValue>
        kind="name"
        target={target}
        current={current}
        busy={busy}
        render={(v) => <ValueSummary kind="name" target={target} v={v} />}
        onRestore={(v) => void run(() => adminApi.save("name", target, v), "Restored that version.")}
      />
    </section>
  );
}
