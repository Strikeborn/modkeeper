import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HubSettings, McBrowseResult, McBrowseSite, McBrowseSort, McInstance, McItem, McKind, McLauncher, McProject, McUpdate, McWorldDetails } from '@shared/types';
import { SubTabs } from '../components/SubTabs';
import { formatBytes, formatShortDate } from '../utils/format';
import { toast } from '../utils/toast';
import { useGridTop, wheelPage } from '../utils/fillHeight';

type Tab = McKind | 'browse';
const TAB_KEY = 'modkeeper.minecraftTab';
/** Four rows of seven on a wide window. */
const PER_PAGE = 28;

const KIND_LABEL: Record<McKind, string> = {
  mods: 'Mods',
  resourcepacks: 'Resource packs',
  shaderpacks: 'Shaders',
  worlds: 'Worlds',
  screenshots: 'Screenshots',
};

const LAUNCHER_LINKS: Record<McLauncher, { label: string; url: string }> = {
  prism: { label: 'Prism Launcher', url: 'https://prismlauncher.org/' },
  curseforge: { label: 'CurseForge', url: 'https://www.curseforge.com/download/app' },
  modrinth: { label: 'Modrinth App', url: 'https://modrinth.com/app' },
  vanilla: { label: 'Minecraft Launcher', url: 'https://www.minecraft.net/download' },
};

function compact(n?: number): string {
  if (n == null) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** "Jul 2025" for a Minecraft version, from Mojang's list. */
function releasedLabel(dates: Record<string, string>, v?: string): string | undefined {
  const t = v && dates[v];
  return t ? new Date(t).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : undefined;
}

function instanceLabel(i: McInstance, dates: Record<string, string>): string {
  const released = releasedLabel(dates, i.mcVersion);
  const what = [i.mcVersion !== i.name ? i.mcVersion : undefined, released && `(${released})`, i.loader].filter(Boolean).join(' ');
  // a Prism instance is often just named after its version: "26.3 (Sep 2026)", not "26.3 · (Sep 2026)"
  return `${i.name}${what ? (what.startsWith('(') ? ` ${what}` : ` · ${what}`) : ''} — ${i.launcherName}`;
}

/** Minecraft: instances from Prism, CurseForge, the Modrinth App and the official launcher, their content, and Modrinth/CurseForge browse. */
export function MinecraftView() {
  const [instances, setInstances] = useState<McInstance[]>([]);
  const [launchers, setLaunchers] = useState<Record<McLauncher, boolean> | null>(null);
  const [settings, setSettings] = useState<HubSettings | null>(null);
  const [tab, setTabState] = useState<Tab>(() => {
    try {
      return (localStorage.getItem(TAB_KEY) as Tab) || 'mods';
    } catch {
      return 'mods';
    }
  });
  const setTab = (t: Tab) => {
    setTabState(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* storage unavailable */
    }
  };
  const [items, setItems] = useState<McItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [updates, setUpdates] = useState<Record<string, McUpdate>>({});
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [dates, setDates] = useState<Record<string, string>>({});
  const [openWorld, setOpenWorld] = useState<{ item: McItem; rename?: boolean } | null>(null);
  useEffect(() => {
    void window.modHub.mcVersionDates().then(setDates);
  }, []);

  const loadInstances = useCallback(async () => {
    const [r, s] = await Promise.all([window.modHub.mcInstances(), window.modHub.getSettings()]);
    setInstances(r.instances);
    setLaunchers(r.launchers);
    setSettings(s);
  }, []);
  useEffect(() => {
    void loadInstances();
  }, [loadInstances]);

  const inst = instances.find((i) => i.id === settings?.mcInstanceChoice) ?? instances[0];
  const kind: McKind = tab === 'browse' ? 'mods' : tab;

  const loadItems = useCallback(async () => {
    if (!inst || tab === 'browse') return;
    setLoading(true);
    try {
      setItems(await window.modHub.mcContent(inst.id, tab));
    } finally {
      setLoading(false);
    }
  }, [inst, tab]);
  useEffect(() => {
    setUpdates({});
    void loadItems();
  }, [loadItems]);

  const chooseInstance = async (id: string) => setSettings(await window.modHub.saveSettings({ mcInstanceChoice: id }));
  const done = (r: { ok: boolean; error?: string; message?: string }, okMsg?: string) => {
    if (!r.ok) toast(r.error ?? r.message ?? 'Failed', 'error');
    else if (okMsg || r.message) toast(okMsg ?? r.message!);
    void loadItems();
    void loadInstances();
  };

  if (!launchers) return <div className="empty-state">Looking for Minecraft…</div>;

  const missingLaunchers = (Object.keys(LAUNCHER_LINKS) as McLauncher[]).filter((l) => !launchers[l]);
  const getLinks = missingLaunchers.length > 0 && (
    <span className="mc-get">
      Not installed:{' '}
      {missingLaunchers.map((l) => (
        <button key={l} type="button" className="btn-link" onClick={() => void window.modHub.mcOpenPage(LAUNCHER_LINKS[l].url)}>
          {LAUNCHER_LINKS[l].label}
        </button>
      ))}
    </span>
  );

  if (!inst)
    return (
      <div className="empty-state">
        No Minecraft instances found (Prism Launcher, CurseForge, Modrinth App or the Minecraft Launcher). {getLinks}
      </div>
    );

  const tabs = (
    <SubTabs
      tabs={[
        ...(['mods', 'resourcepacks', 'shaderpacks', 'worlds', 'screenshots'] as McKind[]).map((k) => ({ id: k as Tab, label: `${KIND_LABEL[k]} (${inst.counts[k]})` })),
        { id: 'browse' as Tab, label: 'Browse' },
      ]}
      active={tab}
      onChange={setTab}
    />
  );

  const checkUpdates = async () => {
    setChecking(true);
    try {
      const r = await window.modHub.mcCheckUpdates(inst.id, kind);
      setUpdates(Object.fromEntries(r.updates.map((u) => [u.file, u])));
      toast(r.error ? `Couldn't check: ${r.error}` : r.updates.length ? `${r.updates.length} update${r.updates.length === 1 ? '' : 's'}` : 'Everything is up to date (that Modrinth or CurseForge knows of).');
    } finally {
      setChecking(false);
    }
  };
  const update = async (it: McItem) => {
    setBusy(it.file);
    try {
      const r = await window.modHub.mcUpdate(inst.id, kind, it.file);
      if (r.ok)
        setUpdates((u) => {
          const n = { ...u };
          delete n[it.file];
          return n;
        });
      setSettings(await window.modHub.getSettings());
      done(r);
    } finally {
      setBusy(null);
    }
  };
  const remove = async (it: McItem) => {
    const what = kind === 'worlds' ? `the world “${it.title}”` : `“${it.file}”`;
    if (!window.confirm(`Delete ${what}? It goes to the Recycle Bin, so you can restore it from there.${kind === 'worlds' ? '\n\nTip: Back up first keeps a zip in ModKeeper.' : ''}`)) return;
    done(await window.modHub.mcDelete(inst.id, kind, it.file), `Deleted ${it.title} (in the Recycle Bin)`);
  };

  const shown = items.filter((i) => !filter.trim() || `${i.title} ${i.file} ${i.authors ?? ''} ${i.modId ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const onCount = items.filter((i) => i.enabled).length;

  return (
    <div className="mc">
      <div className="filter-row mc-head">
        <label>
          Instance
          <select value={inst.id} onChange={(e) => void chooseInstance(e.target.value)}>
            {(Object.keys(LAUNCHER_LINKS) as McLauncher[]).map((l) => {
              const group = instances.filter((i) => i.launcher === l);
              return group.length ? (
                <optgroup key={l} label={LAUNCHER_LINKS[l].label}>
                  {group.map((i) => (
                    <option key={i.id} value={i.id}>
                      {instanceLabel(i, dates)}
                    </option>
                  ))}
                </optgroup>
              ) : null;
            })}
          </select>
        </label>
        <button type="button" className="btn btn-sm btn-primary" title={inst.canLaunchDirect ? 'Start this instance' : `Open ${inst.launcherName}`} onClick={async () => done(await window.modHub.mcPlay(inst.id))}>
          ▶ {inst.canLaunchDirect ? 'Play' : `Open ${inst.launcherName}`}
        </button>
        {inst.canLaunchDirect && (
          <button type="button" className="btn btn-sm" title={`Open ${inst.launcherName} (to add a mod loader, change Java or settings)`} onClick={async () => done(await window.modHub.mcOpenLauncher(inst.id))}>
            Open {inst.launcherName}
          </button>
        )}
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void window.modHub.mcOpenFolder(inst.id)}>
          Open folder
        </button>
        <span className="muted mc-meta">
          {inst.mcVersion && releasedLabel(dates, inst.mcVersion) ? `${inst.mcVersion} released ${releasedLabel(dates, inst.mcVersion)} · ` : ''}
          {inst.loader ? `${inst.loader}${inst.loaderVersion ? ` ${inst.loaderVersion}` : ''}` : 'vanilla (no mod loader)'}
          {inst.shaderLoader ? ` · shaders: ${inst.shaderLoader === 'iris' ? 'Iris' : 'OptiFine'}` : ''}
          {inst.lastPlayed ? ` · played ${formatShortDate(inst.lastPlayed)}` : ''}
        </span>
        {getLinks}
      </div>
      {tab === 'browse' ? (
        <McBrowse inst={inst} header={tabs} hasCfKey={Boolean(settings?.curseforgeApiKey)} onInstalled={() => void loadInstances()} />
      ) : (
        <>
          <div className="filter-row subtabs-row">
            {tabs}
            {tab !== 'screenshots' && (
              <input type="text" className="mc-filter" placeholder={`Filter ${KIND_LABEL[kind].toLowerCase()}`} value={filter} onChange={(e) => setFilter(e.target.value)} />
            )}
            {(tab === 'mods' || tab === 'resourcepacks' || tab === 'shaderpacks') && (
              <button type="button" className="btn btn-sm" disabled={checking || items.length === 0} onClick={() => void checkUpdates()}>
                {checking ? 'Checking…' : 'Check for updates'}
              </button>
            )}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setTab('browse')}>
              Get more
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => void window.modHub.mcOpenFolder(inst.id, kind)}>
              Open folder
            </button>
            <span className="muted">
              {tab === 'mods' && `${onCount}/${items.length} on`}
              {tab === 'resourcepacks' && `${onCount} on · the top pack wins`}
              {tab === 'shaderpacks' && (inst.shaderLoader ? (items.some((i) => i.active) ? '' : 'Shaders off') : 'No shader loader: install Iris (Browse → Mods)')}
            </span>
            {tab === 'shaderpacks' && items.some((i) => i.active) && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={async () => done(await window.modHub.mcSetEnabled(inst.id, 'shaderpacks', '', false))}>
                Shaders off
              </button>
            )}
          </div>
          {tab === 'screenshots' ? (
            <Screenshots inst={inst} items={items} />
          ) : loading && items.length === 0 ? (
            <div className="empty-state">Reading {KIND_LABEL[kind].toLowerCase()}…</div>
          ) : items.length === 0 ? (
            <div className="empty-state">
              No {KIND_LABEL[kind].toLowerCase()} in “{inst.name}” yet.{' '}
              <button type="button" className="btn btn-sm" onClick={() => setTab('browse')}>
                Browse
              </button>
            </div>
          ) : (
            <div className={tab === 'mods' ? 'mc-split' : ''}>
              <ul className="mc-list">
                {shown.map((it) => (
                  <McRow
                    key={it.path}
                    it={it}
                    kind={kind}
                    onCount={onCount}
                    update={updates[it.file]}
                    busy={busy === it.file}
                    source={settings?.mcSources?.[`${inst.id}|${it.file.toLowerCase()}`]?.site}
                    onToggle={async () => done(await window.modHub.mcSetEnabled(inst.id, kind, it.file, !it.enabled))}
                    onMove={async (d) => done(await window.modHub.mcMovePack(inst.id, it.file, d))}
                    onUpdate={() => void update(it)}
                    onDelete={() => void remove(it)}
                    onBackup={async () => done(await window.modHub.mcBackupWorld(inst.id, it.file), `Backed up “${it.title}” (shown in Explorer)`)}
                    onOpen={() => void window.modHub.mcOpenFolder(inst.id, kind, it.file)}
                    onDetails={kind === 'worlds' ? () => setOpenWorld({ item: it }) : undefined}
                    onRename={kind === 'worlds' ? () => setOpenWorld({ item: it, rename: true }) : undefined}
                  />
                ))}
              </ul>
              {openWorld && (
                <WorldPanel
                  key={openWorld.item.path}
                  inst={inst}
                  item={openWorld.item}
                  startRenaming={openWorld.rename}
                  onClose={() => setOpenWorld(null)}
                  onBackup={async () =>
                    done(await window.modHub.mcBackupWorld(inst.id, openWorld.item.file), `Backed up “${openWorld.item.title}” (shown in Explorer)`)
                  }
                  onRenamed={async (file) => {
                    const fresh = await window.modHub.mcContent(inst.id, 'worlds');
                    setItems(fresh);
                    const it = fresh.find((x) => x.file === file);
                    setOpenWorld(it ? { item: it } : null);
                  }}
                />
              )}
              {tab === 'mods' && <ModLists inst={inst} items={items} settings={settings} setSettings={setSettings} onApplied={() => void loadItems()} />}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function McRow(p: {
  it: McItem;
  kind: McKind;
  onCount: number;
  update?: McUpdate;
  busy: boolean;
  source?: string;
  onToggle: () => void;
  onMove: (d: number) => void;
  onUpdate: () => void;
  onDelete: () => void;
  onBackup: () => void;
  onOpen: () => void;
  onDetails?: () => void;
  onRename?: () => void;
}) {
  const { it, kind } = p;
  const w = it.world;
  return (
    <li className={`mc-row${it.enabled || kind === 'worlds' || kind === 'shaderpacks' ? '' : ' emu-mod-off'}`}>
      {(kind === 'mods' || kind === 'resourcepacks') && (
        <button type="button" className={`mod-table-toggle${it.enabled ? ' on' : ''}`} onClick={p.onToggle} title={it.enabled ? 'On: click to switch off' : 'Off: click to switch on'}>
          {it.enabled ? 'On' : 'Off'}
        </button>
      )}
      {kind === 'resourcepacks' &&
        (it.enabled ? (
          <span className="emu-order">
            <button type="button" className="btn-icon" title="Higher (applied over the packs below)" disabled={it.order === 0} onClick={() => p.onMove(-1)}>
              ▲
            </button>
            <button type="button" className="btn-icon" title="Lower" disabled={it.order === p.onCount - 1} onClick={() => p.onMove(1)}>
              ▼
            </button>
          </span>
        ) : (
          <span className="emu-order" />
        ))}
      {kind === 'shaderpacks' && (
        <button type="button" className={`mod-table-toggle${it.active ? ' on' : ''}`} disabled={it.active} onClick={p.onToggle} title={it.active ? 'The shader pack in use' : 'Use this shader pack'}>
          {it.active ? 'In use' : 'Use'}
        </button>
      )}
      {it.icon ? <img className="mc-icon" src={it.icon} alt="" /> : <span className="mc-icon mc-icon-blank" />}
      <div
        className={`mc-row-main${p.onDetails ? ' mc-clickable' : ''}`}
        role={p.onDetails ? 'button' : undefined}
        tabIndex={p.onDetails ? 0 : undefined}
        title={p.onDetails ? 'Details and map' : undefined}
        onClick={p.onDetails}
        onKeyDown={(e) => e.key === 'Enter' && p.onDetails?.()}
      >
        <div className="mc-row-title">
          <strong title={it.file}>{it.title}</strong>
          {it.version && <span className="muted"> {it.version}</span>}
          {p.source && <span className="pill">{p.source === 'modrinth' ? 'Modrinth' : 'CurseForge'}</span>}
          {(it.missing?.length ?? 0) > 0 && (
            <span className="pill mc-warn" title="These mods are required but not installed (or switched off)">
              needs {it.missing!.join(', ')}
            </span>
          )}
        </div>
        <div className="muted mc-row-sub">
          {w
            ? [
                w.gameMode,
                w.hardcore ? 'hardcore' : '',
                w.cheats ? 'cheats on' : '',
                w.version,
                w.created ? `created ${formatShortDate(w.created)}` : '',
                w.lastPlayed ? `played ${formatShortDate(new Date(w.lastPlayed).toISOString())}` : '',
                w.ageDays != null ? `${w.ageDays.toLocaleString()} days old` : '',
                it.sizeBytes != null ? formatBytes(it.sizeBytes) : '',
              ]
                .filter(Boolean)
                .join(' · ')
            : [it.authors, it.sizeBytes != null ? formatBytes(it.sizeBytes) : 'folder', it.description].filter(Boolean).join(' · ')}
        </div>
      </div>
      {p.update && (
        <button type="button" className="btn btn-sm btn-primary" disabled={p.busy} title={`${p.update.newFileName} from ${p.update.site === 'modrinth' ? 'Modrinth' : 'CurseForge'} (the old file is backed up)`} onClick={p.onUpdate}>
          {p.busy ? 'Updating…' : `Update → ${p.update.newVersion}`}
        </button>
      )}
      {kind === 'worlds' && (
        <button type="button" className="btn btn-sm btn-ghost" title="Rename this world" onClick={p.onRename}>
          ✎
        </button>
      )}
      {kind === 'worlds' && (
        <button type="button" className="btn btn-sm" title="Details and map" onClick={p.onDetails}>
          Map
        </button>
      )}
      {kind === 'worlds' && (
        <button type="button" className="btn btn-sm" title="Zip this world into ModKeeper's backups" onClick={p.onBackup}>
          Back up
        </button>
      )}
      <button type="button" className="btn btn-sm btn-ghost" title="Show in Explorer" onClick={p.onOpen}>
        📁
      </button>
      <button type="button" className="btn btn-sm btn-ghost" title="Delete (to the Recycle Bin)" onClick={p.onDelete}>
        🗑
      </button>
    </li>
  );
}

function ModLists(p: { inst: McInstance; items: McItem[]; settings: HubSettings | null; setSettings: (s: HubSettings) => void; onApplied: () => void }) {
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ name: string; value: string } | null>(null);
  const all = p.settings?.mcModLists ?? [];
  const lists = all.filter((l) => l.instance === p.inst.id);
  const on = p.items.filter((i) => i.enabled).map((i) => i.file);
  const same = (files: string[]) => files.length === on.length && files.every((f) => on.some((o) => o.toLowerCase() === f.toLowerCase()));
  const save = async (next: typeof all) => p.setSettings(await window.modHub.saveSettings({ mcModLists: next }));
  const mine = (l: (typeof all)[number], n: string) => l.instance === p.inst.id && l.name === n;

  return (
    <section className="emu-panel mc-lists">
      <h3>Modlists</h3>
      <p className="muted">Sets of mods for “{p.inst.name}”. Applying one switches its mods on and every other mod off (Minecraft must be closed).</p>
      <div className="emu-ship-actions">
        <input type="text" placeholder="Name for the mods that are on now" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={!name.trim()}
          onClick={async () => {
            const n = name.trim();
            if (lists.some((l) => l.name === n) && !window.confirm(`Replace “${n}” with the mods on now?`)) return;
            await save([...all.filter((l) => !mine(l, n)), { instance: p.inst.id, name: n, files: on, saved: new Date().toISOString() }]);
            setName('');
            toast(`Saved “${n}” (${on.length} mods)`);
          }}
        >
          Save current ({on.length} on)
        </button>
      </div>
      {lists.length === 0 ? (
        <p className="muted">No modlists for this instance yet.</p>
      ) : (
        <ul>
          {lists.map((l) => {
            const current = same(l.files);
            return (
              <li key={l.name} title={l.files.join('\n') || '(no mods)'}>
                {renaming?.name === l.name ? (
                  <input
                    className="emu-rename"
                    autoFocus
                    value={renaming.value}
                    onChange={(e) => setRenaming({ name: l.name, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setRenaming(null);
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    }}
                    onBlur={async () => {
                      const v = renaming.value.trim();
                      setRenaming(null);
                      if (!v || v === l.name) return;
                      if (lists.some((x) => x.name === v)) return toast(`There's already a modlist called “${v}”`);
                      await save(all.map((x) => (mine(x, l.name) ? { ...x, name: v } : x)));
                    }}
                  />
                ) : (
                  <strong>{l.name}</strong>
                )}
                <span className="muted">
                  {' '}
                  · {l.files.length} mods · {formatShortDate(l.saved)}
                  {current ? ' · active' : ''}
                </span>
                <span className="dup-spacer" />
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={current}
                  onClick={async () => {
                    const r = await window.modHub.mcApplyModList(p.inst.id, l.files);
                    toast(r.message, r.ok ? 'info' : 'error');
                    p.onApplied();
                  }}
                >
                  Apply
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={current}
                  title="Save the mods on now into this modlist"
                  onClick={async () => {
                    if (!window.confirm(`Update “${l.name}” to the ${on.length} mods on now?`)) return;
                    await save(all.map((x) => (mine(x, l.name) ? { ...x, files: on, saved: new Date().toISOString() } : x)));
                  }}
                >
                  Update
                </button>
                <button type="button" className="btn btn-sm btn-ghost" title="Rename" onClick={() => setRenaming({ name: l.name, value: l.name })}>
                  ✎
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  title="Remove this modlist"
                  onClick={async () => {
                    if (window.confirm(`Remove the modlist “${l.name}”? (Your mods aren't touched.)`)) await save(all.filter((x) => !mine(x, l.name)));
                  }}
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Screenshots load a page at a time (there can be hundreds of big PNGs). */
function Screenshots({ inst, items }: { inst: McInstance; items: McItem[] }) {
  const [count, setCount] = useState(60);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [full, setFull] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const todo = items.slice(0, count).filter((it) => !urls[it.file]);
      // six at a time: quick, without flooding the main process
      for (let k = 0; k < todo.length && live; k += 6)
        await Promise.all(
          todo.slice(k, k + 6).map(async (it) => {
            const u = await window.modHub.mcScreenshot(inst.id, it.file);
            if (live && u) setUrls((m) => ({ ...m, [it.file]: u }));
          }),
        );
    })();
    return () => {
      live = false;
    };
    // urls is filled by this effect; re-running on it would loop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inst.id, items, count]);
  if (items.length === 0) return <div className="empty-state">No screenshots in “{inst.name}” (F2 in game takes one).</div>;
  return (
    <>
      <div className="mc-shots">
        {items.slice(0, count).map((it) => (
          <button
            key={it.file}
            type="button"
            className="mc-shot"
            title={`${it.file} · ${formatShortDate(it.modified)}`}
            onClick={async () => {
              setOpen(it.file);
              setFull(null);
              setFull((await window.modHub.mcScreenshot(inst.id, it.file, true)) ?? null);
            }}
          >
            {urls[it.file] ? <img src={urls[it.file]} alt="" loading="lazy" /> : <span className="muted">…</span>}
          </button>
        ))}
      </div>
      {count < items.length && (
        <div className="mc-more">
          <button type="button" className="btn btn-sm" onClick={() => setCount((c) => c + 60)}>
            Show more ({items.length - count} left)
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCount(items.length)}>
            Show all
          </button>
        </div>
      )}
      {open && (
        <div className="mc-lightbox" role="dialog" onClick={() => setOpen(null)}>
          {(full ?? urls[open]) && <img src={full ?? urls[open]} alt="" />}
          <span>
            {open} ·{' '}
            <button type="button" className="btn-link" onClick={(e) => (e.stopPropagation(), void window.modHub.mcOpenFolder(inst.id, 'screenshots', open))}>
              Show in Explorer
            </button>
          </span>
        </div>
      )}
    </>
  );
}

const BROWSE_KINDS: McKind[] = ['mods', 'resourcepacks', 'shaderpacks', 'worlds'];

function McBrowse({ inst, header, hasCfKey, onInstalled }: { inst: McInstance; header: React.ReactNode; hasCfKey: boolean; onInstalled: () => void }) {
  const [site, setSite] = useState<McBrowseSite>('modrinth');
  const [kind, setKind] = useState<McKind>('mods');
  const [sort, setSort] = useState<McBrowseSort>('downloads');
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const [anyVersion, setAnyVersion] = useState(false);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<McBrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installedNow, setInstalledNow] = useState<Set<string>>(new Set());
  const seq = useRef(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const lastWheel = useRef(0);

  const effectiveSite: McBrowseSite = kind === 'worlds' ? 'curseforge' : site;
  const needsKey = effectiveSite === 'curseforge' && !hasCfKey;
  /** Mods need a mod loader; an instance without one (vanilla) can still take packs, shaders (OptiFine) and maps. */
  const noLoader = kind === 'mods' && !inst.loader;

  useEffect(() => {
    if (needsKey) {
      setResult(null);
      return;
    }
    const n = ++seq.current;
    setLoading(true);
    void window.modHub
      .mcSearch({ site: effectiveSite, kind, instance: inst.id, query: applied, sort, page, perPage: PER_PAGE, anyVersion })
      .then((r) => n === seq.current && setResult(r))
      .finally(() => n === seq.current && setLoading(false));
  }, [effectiveSite, kind, inst.id, applied, sort, page, anyVersion, needsKey]);

  const maxPage = result ? Math.max(1, Math.ceil(result.total / PER_PAGE)) : 1;
  useGridTop(gridRef, [result?.projects.length, loading]);
  const onWheel = (e: React.WheelEvent) => {
    if (loading) return;
    wheelPage(e, gridRef.current, lastWheel, (d) => {
      const next = page + d;
      if (next >= 1 && next <= maxPage) setPage(next);
    });
  };
  const install = async (p: McProject) => {
    setInstalling(p.id);
    try {
      const r = await window.modHub.mcInstall({ site: p.site, kind, instance: inst.id, projectId: p.id, title: p.title });
      toast(r.message, r.ok ? 'info' : 'error');
      if (r.ok) {
        setInstalledNow((s) => new Set(s).add(`${p.site}:${p.id}`));
        onInstalled();
      }
    } finally {
      setInstalling(null);
    }
  };
  const reset = () => setPage(1);
  const versionNote = useMemo(
    () => (anyVersion ? 'all versions' : [inst.mcVersion, kind === 'mods' ? inst.loader : kind === 'shaderpacks' ? inst.shaderLoader : undefined].filter(Boolean).join(' · ') || 'all versions'),
    [anyVersion, inst, kind],
  );

  return (
    <>
      <div className="filter-row subtabs-row">
        {header}
        <label>
          From
          <select
            value={effectiveSite}
            disabled={kind === 'worlds'}
            title={kind === 'worlds' ? 'Maps come from CurseForge (Modrinth has none)' : undefined}
            onChange={(e) => {
              setSite(e.target.value as McBrowseSite);
              reset();
            }}
          >
            <option value="modrinth">Modrinth</option>
            <option value="curseforge">CurseForge</option>
          </select>
        </label>
        <label>
          Type
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as McKind);
              reset();
            }}
          >
            {BROWSE_KINDS.map((k) => (
              <option key={k} value={k}>
                {k === 'worlds' ? 'Maps' : KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sort
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as McBrowseSort);
              reset();
            }}
          >
            <option value="relevance">Relevance</option>
            <option value="downloads">Downloads</option>
            <option value="follows">{effectiveSite === 'modrinth' ? 'Follows' : 'Popular'}</option>
            <option value="newest">Newest</option>
            <option value="updated">Recently updated</option>
          </select>
        </label>
        <input
          type="text"
          className="mc-filter"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setApplied(query);
              reset();
            }
          }}
          onBlur={() => {
            if (query !== applied) {
              setApplied(query);
              reset();
            }
          }}
        />
        <label className="checkbox-inline" title="Show files for any Minecraft version, not just this instance's">
          <input
            type="checkbox"
            checked={anyVersion}
            onChange={(e) => {
              setAnyVersion(e.target.checked);
              reset();
            }}
          />
          Any version
        </label>
        <span className="muted">For {versionNote}</span>
        <div className="pagination-inline">
          <button type="button" className="btn btn-sm" disabled={loading || page <= 1} onClick={() => setPage(page - 1)}>
            ‹
          </button>
          {result && <span className="gb-total">{result.total.toLocaleString()} ·</span>}
          <span>
            Page {page} of {maxPage.toLocaleString()}
          </span>
          <button type="button" className="btn btn-sm" disabled={loading || page >= maxPage} onClick={() => setPage(page + 1)}>
            ›
          </button>
        </div>
      </div>
      {noLoader && (
        <p className="message">
          “{inst.name}” has no mod loader, so mods wouldn't load in it.{' '}
          {inst.launcher === 'prism'
            ? 'In Prism Launcher: right-click the instance → Edit → Version → Install Fabric (or NeoForge), then come back here.'
            : inst.launcher === 'vanilla'
              ? 'The Minecraft Launcher can’t add one: make a Fabric or NeoForge instance in Prism Launcher (or CurseForge / the Modrinth App) and pick it above.'
              : `Add Fabric, Forge or NeoForge to it in ${inst.launcherName}, then come back here.`}{' '}
          You can still browse.
        </p>
      )}
      {needsKey ? (
        <div className="empty-state">
          CurseForge needs an API key. Get one free at{' '}
          <button type="button" className="btn-link" onClick={() => void window.modHub.mcOpenPage('https://console.curseforge.com/')}>
            console.curseforge.com
          </button>{' '}
          (API keys), then paste it in Settings → Accounts. {kind !== 'worlds' && 'Modrinth works without one.'}
        </div>
      ) : result?.error ? (
        <p className="message message-error">{result.error}</p>
      ) : loading && !result ? (
        <div className="empty-state">Searching {effectiveSite === 'modrinth' ? 'Modrinth' : 'CurseForge'}…</div>
      ) : result && result.projects.length === 0 ? (
        <div className="empty-state">Nothing found for {versionNote}. Try Any version or another search.</div>
      ) : (
        <div className={`mc-browse-grid grid-fill${loading ? ' is-loading' : ''}`} ref={gridRef} onWheel={onWheel}>
          {result?.projects.map((p) => {
            const done = p.installed || installedNow.has(`${p.site}:${p.id}`);
            return (
              <article key={`${p.site}-${p.id}`} className="mc-card">
                {p.image ? (
                  <img className="mc-card-image" src={p.image} alt="" loading="lazy" />
                ) : (
                  <div className="mc-card-image mc-card-image-blank" style={{ background: p.color ? `linear-gradient(135deg, ${p.color}55, ${p.color}22)` : undefined }}>
                    {p.icon && <img src={p.icon} alt="" loading="lazy" />}
                  </div>
                )}
                <div className="mc-card-head">
                  {p.icon ? <img className="mc-icon" src={p.icon} alt="" loading="lazy" /> : <span className="mc-icon mc-icon-blank" />}
                  <div>
                    <strong title={p.title}>{p.title}</strong>
                    <div className="muted">
                      {p.author && `by ${p.author} · `}⬇ {compact(p.downloads)}
                      {p.follows ? ` · ♥ ${compact(p.follows)}` : ''}
                    </div>
                  </div>
                </div>
                <p className="mc-card-desc" title={p.description}>
                  {p.description}
                </p>
                {p.categories?.length ? <div className="muted mc-card-tags">{p.categories.slice(0, 4).join(' · ')}</div> : null}
                <div className="mc-card-actions">
                  <button type="button" className={`btn btn-sm btn-primary${done ? ' btn-active' : ''}`} disabled={done || installing !== null || noLoader} title={noLoader ? `“${inst.name}” has no mod loader yet (see the note above)` : undefined} onClick={() => void install(p)}>
                    {done ? 'Installed' : installing === p.id ? 'Installing…' : 'Install'}
                  </button>
                  <button type="button" className="btn btn-sm" title="Open its page" onClick={() => void window.modHub.mcOpenPage(p.url)}>
                    ↗
                  </button>
                  {p.updated && <span className="muted">{formatShortDate(p.updated)}</span>}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}

type Place = McWorldDetails['places'][number];
const PLACE_ICON: Record<Place['kind'], string> = { spawn: '✦', player: '●', bed: '🛏' };
const RADII = [64, 128, 256, 512];

/** A world's details and a top-down map, centred on spawn, where you were, or a bed. */
function WorldPanel({
  inst,
  item,
  startRenaming,
  onClose,
  onBackup,
  onRenamed,
}: {
  inst: McInstance;
  item: McItem;
  startRenaming?: boolean;
  onClose: () => void;
  onBackup: () => void;
  onRenamed: (file: string) => void;
}) {
  const [d, setD] = useState<McWorldDetails | null | undefined>(undefined);
  const [rename, setRename] = useState<{ name: string; folder: boolean } | null>(startRenaming ? { name: item.title, folder: false } : null);
  const [saving, setSaving] = useState(false);
  const saveRename = async () => {
    if (!rename) return;
    const name = rename.name.trim();
    if (!name || (name === item.title && (!rename.folder || name === item.file))) return setRename(null);
    setSaving(true);
    try {
      const r = await window.modHub.mcRenameWorld(inst.id, item.file, name, rename.folder);
      if (!r.ok) return toast(r.error ?? 'Couldn’t rename', 'error');
      toast(r.error ?? `Renamed to “${name}”${rename.folder && r.file ? ` (folder: ${r.file})` : ''}`);
      setRename(null);
      onRenamed(r.file ?? item.file);
    } finally {
      setSaving(false);
    }
  };
  const [place, setPlace] = useState<Place | null>(null);
  const [radius, setRadius] = useState(128);
  const [map, setMap] = useState<{ image?: string; chunks: number; error?: string } | null>(null);
  const [drawing, setDrawing] = useState(false);

  useEffect(() => {
    void window.modHub.mcWorldDetails(inst.id, item.file).then((x) => {
      setD(x);
      // start where you'll be when you load in: your bed if you have one, else where you were, else spawn
      const ps = x?.places ?? [];
      setPlace(ps.find((p) => p.kind === 'bed' && p.label === 'Your bed') ?? ps.find((p) => p.kind === 'player') ?? ps[0] ?? null);
    });
  }, [inst.id, item.file]);

  useEffect(() => {
    if (!place || !d?.mapSupported) return;
    let live = true;
    setDrawing(true);
    void window.modHub
      .mcWorldMap(inst.id, item.file, { x: place.pos[0], z: place.pos[2], radius, dimension: place.dimension })
      .then((m) => live && setMap(m))
      .finally(() => live && setDrawing(false));
    return () => {
      live = false;
    };
  }, [place, radius, d?.mapSupported, inst.id, item.file]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** Other places that fall inside the map, as % offsets for markers. */
  const markers = (d?.places ?? []).filter(
    (p) => place && p !== place && p.dimension === place.dimension && Math.abs(p.pos[0] - place.pos[0]) < radius && Math.abs(p.pos[2] - place.pos[2]) < radius,
  );
  const facts: [string, string | undefined][] = d
    ? [
        ['Created', d.created ? formatShortDate(d.created) : undefined],
        ['Last played', d.lastPlayed ? formatShortDate(new Date(d.lastPlayed).toISOString()) : undefined],
        ['World age', d.ageDays != null ? `${d.ageDays.toLocaleString()} in-game days` : undefined],
        ['Time played', d.playHours != null ? `${d.playHours < 1 ? `${Math.round(d.playHours * 60)} min` : `${d.playHours.toFixed(1)} h`}` : undefined],
        ['Mode', [d.gameMode, d.hardcore ? 'hardcore' : '', d.cheats ? 'cheats on' : ''].filter(Boolean).join(', ')],
        ['Difficulty', d.difficulty],
        ['Version', d.version],
        ['Seed', d.seed],
        ['Data packs', d.dataPacks?.length ? d.dataPacks.join(', ') : 'none'],
        ['Size', d.dimensions.map((x) => `${x.name} ${formatBytes(x.bytes)}`).join(' · ') || undefined],
      ]
    : [];

  return (
    <div className="mc-modal" role="dialog" aria-label={item.title} onClick={onClose}>
      <div className="mc-world" onClick={(e) => e.stopPropagation()}>
        <div className="mc-world-head">
          {item.icon ? <img className="mc-icon" src={item.icon} alt="" /> : <span className="mc-icon mc-icon-blank" />}
          {rename ? (
            <span className="mc-rename">
              <input
                autoFocus
                value={rename.name}
                maxLength={100}
                onChange={(e) => setRename({ ...rename, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveRename();
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setRename(null);
                  }
                }}
              />
              <label className="checkbox-inline" title={`Folder now: ${item.file}`}>
                <input type="checkbox" checked={rename.folder} onChange={(e) => setRename({ ...rename, folder: e.target.checked })} />
                Rename the folder too
              </label>
              <button type="button" className="btn btn-sm btn-primary" disabled={saving || !rename.name.trim()} onClick={() => void saveRename()}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRename(null)}>
                Cancel
              </button>
            </span>
          ) : (
            <>
              <h3>{item.title}</h3>
              <button type="button" className="btn btn-sm btn-ghost" title="Rename this world" onClick={() => setRename({ name: item.title, folder: false })}>
                ✎
              </button>
              <span className="muted">{item.file !== item.title ? item.file : ''}</span>
            </>
          )}
          <span className="dup-spacer" />
          <button type="button" className="btn btn-sm" onClick={onBackup}>
            Back up
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void window.modHub.mcOpenFolder(inst.id, 'worlds', item.file)}>
            📁
          </button>
          <button type="button" className="btn btn-sm btn-ghost" title="Close (Esc)" onClick={onClose}>
            ✕
          </button>
        </div>
        {d === undefined ? (
          <div className="empty-state">Reading the world…</div>
        ) : d === null ? (
          <div className="empty-state">Couldn't read this world's level.dat.</div>
        ) : (
          <div className="mc-world-body">
            <dl className="mc-facts">
              {facts
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
            </dl>
            <div className="mc-map-col">
              {!d.mapSupported ? (
                <div className="empty-state">The map needs a world saved in Minecraft 1.18 or newer (this one is {d.version ?? 'older'}).</div>
              ) : (
                <>
                  <div className="mc-places">
                    {d.places.map((p) => (
                      <button
                        key={`${p.label}-${p.pos.join(',')}`}
                        type="button"
                        className={`btn btn-sm${place === p ? ' btn-active' : ''}`}
                        title={`${p.pos.join(', ')}${p.dimension !== 'overworld' ? ` (${p.dimension})` : ''}`}
                        onClick={() => setPlace(p)}
                      >
                        {PLACE_ICON[p.kind]} {p.label}
                      </button>
                    ))}
                    <span className="dup-spacer" />
                    <label>
                      Area
                      <select value={radius} onChange={(e) => setRadius(Number(e.target.value))}>
                        {RADII.map((r) => (
                          <option key={r} value={r}>
                            {r * 2}×{r * 2} blocks
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className={`mc-map${drawing ? ' is-loading' : ''}`}>
                    {map?.image ? (
                      <>
                        <img src={map.image} alt={`Map around ${place?.label}`} />
                        <span className={`mc-marker mc-marker-${place?.kind}`} style={{ left: '50%', top: '50%' }} title={place?.label}>
                          {place ? PLACE_ICON[place.kind] : ''}
                        </span>
                        {markers.map((p) => (
                          <span
                            key={p.label}
                            className={`mc-marker mc-marker-${p.kind}`}
                            style={{ left: `${50 + ((p.pos[0] - place!.pos[0]) / (2 * radius)) * 100}%`, top: `${50 + ((p.pos[2] - place!.pos[2]) / (2 * radius)) * 100}%` }}
                            title={`${p.label} (${p.pos.join(', ')})`}
                          >
                            {PLACE_ICON[p.kind]}
                          </span>
                        ))}
                      </>
                    ) : (
                      <span className="muted">{map?.error ?? 'Drawing the map…'}</span>
                    )}
                  </div>
                  <div className="muted mc-map-note">
                    {place && `${place.label}: ${place.pos.join(', ')}${place.dimension !== 'overworld' ? ` in the ${place.dimension === 'nether' ? 'Nether' : 'End'}` : ''}`}
                    {map && map.chunks === 0 && !drawing ? ' · nothing explored here yet' : ''} · north is up
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
