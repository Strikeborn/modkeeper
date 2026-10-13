import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EmulationLibrary, EmulationRom, HubSettings, ModPortId, PcPort, ShipMod, ShipModUpdate } from '@shared/types';
import { formatBytes, formatShortDate } from '../utils/format';
import { toast } from '../utils/toast';
import { SubTabs } from '../components/SubTabs';
import { GameBananaView } from './GameBananaView';

type EmuTab = 'roms' | 'mods' | 'gamebanana';
const TAB_KEY = 'modkeeper.emulationTab';

const WHERE_LABEL: Record<EmulationRom['where'], string> = {
  all: 'All devices',
  roms: 'ROMs folder',
  pc: 'PC',
};

/** "Hack of Pokémon FireRed (USA) · by LSA · v1.22" */
function hackLine(r: EmulationRom): string {
  const h = r.hackInfo!;
  const kind = h.kind === 'randomizer' ? 'Randomizer of' : h.kind === 'translation' ? 'Translation of' : h.kind === 'patch' ? 'Patched' : 'Hack of';
  return [
    h.base ? `${kind} ${h.base}` : h.kind === 'patch' ? 'Patched copy (original unknown)' : undefined,
    h.author ? `by ${h.author}` : undefined,
    h.version ? `v${h.version}` : undefined,
    h.source === 'detected' ? '(detected; add details in romhacks.json)' : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Three tabs: ROMs & hacks (with emulators, PC ports and Syncthing folders below), Mods & modlists (Ship of Harkinian packs
 * and saved sets of them), and GameBanana (browse, install and favorite mods).
 */
export function EmulationView() {
  const [tab, setTabState] = useState<EmuTab>(() => {
    try {
      const t = localStorage.getItem(TAB_KEY);
      return t === 'mods' || t === 'gamebanana' ? t : 'roms';
    } catch {
      return 'roms';
    }
  });
  const setTab = (t: EmuTab) => {
    setTabState(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* storage unavailable */
    }
  };
  const [settings, setSettings] = useState<HubSettings | null>(null);
  useEffect(() => {
    void window.modHub?.getSettings().then(setSettings);
  }, []);
  const [listName, setListName] = useState('');
  const [lib, setLib] = useState<EmulationLibrary | null>(null);
  const [loading, setLoading] = useState(false);
  const [system, setSystem] = useState('all');
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setLib(await window.modHub.getEmulationLibrary());
    } catch (e) {
      toast(`Couldn't read the emulation library: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const roms = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (lib?.roms ?? []).filter(
      (r) => (system === 'all' || r.system === system) && (!q || `${r.title} ${r.file}`.toLowerCase().includes(q)),
    );
  }, [lib, system, query]);

  const play = async (rom: EmulationRom) => {
    const r = await window.modHub.emulationPlay(rom.path);
    toast(r.ok ? `Starting ${rom.title}` : `Couldn't start: ${r.error}`);
  };
  const launch = async (id: string, name: string) => {
    const r = await window.modHub.emulationLaunch(id);
    toast(r.ok ? `Starting ${name}` : `Couldn't start: ${r.error}`);
  };
  const pickRoot = async () => {
    if (await window.modHub.pickEmulationRoot()) void load();
  };

  // PC ports: build output per port, live
  const [buildLog, setBuildLog] = useState<Record<string, string[]>>({});
  const [building, setBuilding] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);
  useEffect(
    () =>
      window.modHub.onPcPortBuildLog(({ portId, line }) =>
        setBuildLog((prev) => ({ ...prev, [portId]: [...(prev[portId] ?? []).slice(-400), line] })),
      ),
    [],
  );
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [buildLog]);
  const build = async (port: PcPort, region: string) => {
    setBuilding(port.id);
    setBuildLog((prev) => ({ ...prev, [port.id]: [`> build ${region}`] }));
    const r = await window.modHub.buildPcPort(port.id, region);
    setBuilding(null);
    toast(r.ok ? `${port.name}: build done` : `Build failed: ${r.error ?? `exit ${r.code}`}`);
    void load();
  };
  const playPort = async (port: PcPort, label: string) => {
    const r = await window.modHub.playPcPort(port.id, label);
    toast(r.ok ? `Starting ${port.name} (${label})` : `Couldn't start: ${r.error}`);
  };
  const addPort = async () => {
    if (await window.modHub.addPcPortFolder()) void load();
  };
  // Mods & modlists: one mod-pack port at a time (Ship, 2Ship, Starship), remembered in settings
  const modPort = lib?.modPorts.find((p) => p.id === settings?.modPortChoice) ?? lib?.modPorts[0];
  const pid: ModPortId = modPort?.id ?? 'soh';
  const chooseModPort = async (id: ModPortId) => setSettings(await window.modHub.saveSettings({ modPortChoice: id }));
  /** Where a pack's GameBanana source is kept (Ship's under the plain file name). */
  const sourceKey = (file: string) => (pid === 'soh' ? file.toLowerCase() : `${pid}:${file.toLowerCase()}`);
  const shipDone = (r: { ok: boolean; error?: string }) => {
    if (!r.ok) toast(r.error ?? 'Failed');
    void load();
  };
  const toggleShipMod = async (m: ShipMod) => shipDone(await window.modHub.setShipModEnabled(pid, m.path, !m.enabled));
  const moveShipMod = async (m: ShipMod, delta: number) => shipDone(await window.modHub.moveShipMod(pid, m.path, delta));
  const setAltAssets = async (on: boolean) => shipDone(await window.modHub.setShipAltAssets(pid, on));
  const deleteShipMod = async (m: ShipMod) => {
    if (!window.confirm(`Delete “${m.file}”? It goes to the Recycle Bin, so you can restore it from there.`)) return;
    const r = await window.modHub.deleteShipMod(pid, m.path);
    if (r.ok) toast(`Deleted ${m.file} (in the Recycle Bin)`);
    shipDone(r);
  };
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  const finishRename = async () => {
    if (!renaming) return;
    const m = modPort?.mods.find((x) => x.path === renaming.path);
    setRenaming(null);
    if (!m || !renaming.value.trim() || renaming.value.trim() === m.file.replace(/\.[^.]*$/, '')) return;
    const r = await window.modHub.renameShipMod(pid, m.path, renaming.value);
    if (r.ok) setSettings(await window.modHub.getSettings());
    shipDone(r);
  };
  const addShipPacks = async () => {
    const r = await window.modHub.addShipMods(pid);
    if (!r) return;
    toast(`Added ${r.added} pack${r.added === 1 ? '' : 's'}${r.skipped.length ? `; skipped: ${r.skipped.join(', ')}` : ''}${r.note ? `. ${r.note}` : ''}`);
    void load();
  };

  // GameBanana updates for installed packs: checked once when the tab opens, and on request
  const [updates, setUpdates] = useState<Record<string, ShipModUpdate>>({});
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);
  const checkedPorts = useRef(new Set<ModPortId>());
  const checkUpdates = useCallback(async (port: ModPortId, quiet = false) => {
    setCheckingUpdates(true);
    try {
      const r = await window.modHub.checkShipModUpdates(port);
      setUpdates(Object.fromEntries(r.updates.map((u) => [u.file.toLowerCase(), u])));
      setSettings(await window.modHub.getSettings());
      if (!quiet)
        toast(
          r.error
            ? `Couldn't check: ${r.error}`
            : r.checked === 0
              ? 'No packs from GameBanana to check (packs installed from the GameBanana tab can be updated).'
              : `${r.updates.length || 'No'} update${r.updates.length === 1 ? '' : 's'} (${r.checked} pack${r.checked === 1 ? '' : 's'} checked)`,
        );
    } finally {
      setCheckingUpdates(false);
    }
  }, []);
  useEffect(() => {
    if (tab !== 'mods' || !modPort?.mods.length || checkedPorts.current.has(modPort.id)) return;
    checkedPorts.current.add(modPort.id);
    setUpdates({});
    void checkUpdates(modPort.id, true);
  }, [tab, modPort, checkUpdates]);
  const updateShipMod = async (m: ShipMod) => {
    setUpdating(m.file);
    try {
      const r = await window.modHub.updateShipMod(pid, m.file);
      toast(r.message);
      if (r.ok) {
        setUpdates((u) => {
          const next = { ...u };
          delete next[m.file.toLowerCase()];
          return next;
        });
        setSettings(await window.modHub.getSettings());
      }
    } finally {
      setUpdating(null);
      void load();
    }
  };

  // modlists: the packs that are on, top (wins) first
  const enabledFiles = () => (modPort?.mods ?? []).filter((m) => m.enabled).map((m) => m.file);
  const portLists = (settings?.shipModLists ?? []).filter((l) => (l.game ?? 'soh') === pid);
  const sameNamedList = (l: { name: string; game?: ModPortId }, name: string) => l.name === name && (l.game ?? 'soh') === pid;
  const saveLists = async (lists: NonNullable<HubSettings['shipModLists']>) => setSettings(await window.modHub.saveSettings({ shipModLists: lists }));
  const saveModList = async () => {
    const name = listName.trim();
    if (!name || !lib) return;
    if (portLists.some((l) => l.name === name) && !window.confirm(`Replace the modlist “${name}” with the packs on now?`)) return;
    const files = enabledFiles();
    await saveLists([
      ...(settings?.shipModLists ?? []).filter((l) => !sameNamedList(l, name)),
      { name, files, saved: new Date().toISOString(), ...(pid === 'soh' ? {} : { game: pid }) },
    ]);
    setListName('');
    toast(`Saved “${name}” (${files.length} pack${files.length === 1 ? '' : 's'})`);
  };
  const updateModList = async (name: string) => {
    const files = enabledFiles();
    if (!window.confirm(`Update “${name}” to the ${files.length} pack${files.length === 1 ? '' : 's'} on now, in this order?`)) return;
    await saveLists((settings?.shipModLists ?? []).map((l) => (sameNamedList(l, name) ? { ...l, files, saved: new Date().toISOString() } : l)));
    toast(`Updated “${name}”`);
  };
  const [renamingList, setRenamingList] = useState<{ name: string; value: string } | null>(null);
  const finishListRename = async () => {
    if (!renamingList) return;
    const { name, value } = renamingList;
    setRenamingList(null);
    const next = value.trim();
    if (!next || next === name) return;
    if (portLists.some((l) => l.name === next)) {
      toast(`There's already a modlist called “${next}”`);
      return;
    }
    await saveLists((settings?.shipModLists ?? []).map((l) => (sameNamedList(l, name) ? { ...l, name: next } : l)));
  };
  const applyModList = async (files: string[]) => {
    const r = await window.modHub.applyShipModList(pid, files);
    toast(r.message);
    void load();
  };
  const removeModList = async (name: string) => {
    if (!window.confirm(`Remove the modlist “${name}”? (Your packs aren't touched.)`)) return;
    await saveLists((settings?.shipModLists ?? []).filter((l) => !sameNamedList(l, name)));
  };

  const tabs = (
    <SubTabs
      tabs={[
        { id: 'roms' as const, label: 'ROMs & hacks' },
        { id: 'mods' as const, label: 'Mods & modlists' },
        { id: 'gamebanana' as const, label: 'GameBanana' },
      ]}
      active={tab}
      onChange={setTab}
    />
  );

  if (tab === 'gamebanana') return (
      <GameBananaView
        header={tabs}
        installablePorts={Object.fromEntries(
          (lib?.modPorts ?? []).map((p) => [{ soh: 16121, '2ship': 20371, starship: 21612 }[p.id], p.name]),
        )}
        onInstalled={() => void load()}
      />
    );

  if (!lib) return <div className="empty-state">{loading ? 'Reading the emulation library…' : 'No library loaded.'}</div>;
  if (!lib.exists)
    return (
      <div className="empty-state">
        No emulation library at <code>{lib.root}</code>.{' '}
        <button type="button" className="btn btn-sm" onClick={() => void pickRoot()}>
          Choose folder…
        </button>
      </div>
    );

  const systems = Object.keys(lib.systems).sort();
  const hasShip = lib.modPorts.length > 0;

  if (tab === 'mods') {
    const packs = modPort?.mods ?? [];
    const ordered = modPort?.ordered ?? true;
    const portName = modPort?.name ?? 'Ship of Harkinian';
    const onMods = packs.filter((m) => m.enabled);
    const altOn = modPort?.altAssets === true;
    const altNeeded = onMods.filter((m) => m.alt).length;
    const sameList = (files: string[]) =>
      files.length === onMods.length &&
      (ordered
        ? files.every((f, n) => f.toLowerCase() === onMods[n].file.toLowerCase())
        : files.every((f) => onMods.some((m) => m.file.toLowerCase() === f.toLowerCase())));
    return (
      <div className="emu">
        <div className="filter-row subtabs-row">{tabs}</div>
        {!hasShip ? (
          <div className="empty-state">
            No mod-capable PC port found in the library yet. Ship of Harkinian (<code>soh.exe</code>), 2 Ship 2 Harkinian (
            <code>2ship.exe</code>) and Starship (<code>Starship.exe</code>) get their mods and modlists here, from a folder one level
            inside the library.
          </div>
        ) : (
          <div className="emu-panels emu-mods">
            <section className="emu-panel">
              <div className="emu-port-head">
                <h3>Mods for</h3>
                <select value={pid} onChange={(e) => void chooseModPort(e.target.value as ModPortId)} title="Which game's packs to manage">
                  {lib.modPorts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.mods.filter((m) => m.enabled).length}/{p.mods.length} on)
                    </option>
                  ))}
                </select>
              </div>
              <p className="muted">
                {ordered
                  ? `Packs that are on load top first: a pack overrides the ones below it. ${portName} reads this when it starts, and ModKeeper only changes it while the game is closed.`
                  : `${portName} loads every pack that's on, A to Z (a later name wins). It reads them when it starts, and ModKeeper only changes them while the game is closed.`}
              </p>
              <div className="emu-ship-actions">
                <button type="button" className="btn btn-sm" onClick={() => void addShipPacks()}>
                  Add packs…
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setTab('gamebanana')}>
                  Browse GameBanana
                </button>
                <button type="button" className="btn btn-sm btn-ghost" disabled={checkingUpdates} onClick={() => void checkUpdates(pid)}>
                  {checkingUpdates ? 'Checking…' : 'Check for updates'}
                </button>
                {pid === 'soh' && (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => void window.modHub.openShipModSite('website')}>
                    Ship site
                  </button>
                )}
                {modPort && (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => void window.modHub.openPath(modPort.dir)}>
                    Open folder
                  </button>
                )}
              </div>
              <label className="emu-alt-toggle" title={`${portName}'s Alternate Assets setting (the Tab key in game). Packs marked alt only show while it's on.`}>
                <input type="checkbox" checked={altOn} onChange={(e) => void setAltAssets(e.target.checked)} />
                Alternate assets on when the game starts
                {!altOn && altNeeded > 0 && (
                  <span className="emu-warn">
                    {' '}
                    · {altNeeded} pack{altNeeded === 1 ? '' : 's'} that {altNeeded === 1 ? 'is' : 'are'} on need{altNeeded === 1 ? 's' : ''} it
                  </span>
                )}
              </label>
              {packs.length === 0 ? (
                <p className="muted">No mod packs yet. Install from the GameBanana tab, or Add packs… (.o2r / .otr).</p>
              ) : (
                <ul className="emu-pack-list">
                  {packs.map((m) => {
                    const up = updates[m.file.toLowerCase()];
                    const src = settings?.shipModSources?.[sourceKey(m.file)];
                    return (
                      <li key={m.path} className={m.enabled ? '' : 'emu-mod-off'}>
                        <button
                          type="button"
                          className={`mod-table-toggle${m.enabled ? ' on' : ''}`}
                          title={m.enabled ? 'On: click to switch off (moves it to mods-disabled)' : 'Off: click to switch on (goes to the top)'}
                          onClick={() => void toggleShipMod(m)}
                        >
                          {m.enabled ? 'On' : 'Off'}
                        </button>
                        {m.enabled && ordered ? (
                          <span className="emu-order">
                            <button type="button" className="btn-icon" title="Higher priority" disabled={m.order === 0} onClick={() => void moveShipMod(m, -1)}>
                              ▲
                            </button>
                            <button
                              type="button"
                              className="btn-icon"
                              title="Lower priority"
                              disabled={m.order === onMods.length - 1}
                              onClick={() => void moveShipMod(m, 1)}
                            >
                              ▼
                            </button>
                          </span>
                        ) : (
                          <span className="emu-order" />
                        )}
                        {renaming?.path === m.path ? (
                          <input
                            className="emu-rename"
                            autoFocus
                            value={renaming.value}
                            onChange={(e) => setRenaming({ path: m.path, value: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void finishRename();
                              if (e.key === 'Escape') setRenaming(null);
                            }}
                            onBlur={() => void finishRename()}
                          />
                        ) : (
                          <span className="emu-pack-name" title={src ? `From GameBanana: ${src.modName ?? `mod ${src.modId}`} (${src.fileName})` : m.path}>
                            {m.file}
                          </span>
                        )}
                        {m.alt && (
                          <span className="pill emu-alt-pill" title="Alternate assets: shows only while Alternate Assets is on">
                            alt
                          </span>
                        )}
                        <span className="muted">
                          {' '}
                          · {formatBytes(m.sizeBytes)}
                          {m.folder ? ` · ${m.folder}` : ''}
                        </span>
                        <span className="dup-spacer" />
                        {up && (
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            disabled={updating !== null}
                            title={`Newer file on GameBanana: ${up.newFile}${up.newFileAdded ? ` (${formatShortDate(new Date(up.newFileAdded * 1000).toISOString())})` : ''}. The old pack is backed up.`}
                            onClick={() => void updateShipMod(m)}
                          >
                            {updating === m.file ? 'Updating…' : 'Update'}
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          title="Rename"
                          onClick={() => setRenaming({ path: m.path, value: m.file.replace(/\.[^.]*$/, '') })}
                        >
                          ✎
                        </button>
                        <button type="button" className="btn btn-sm btn-ghost" title="Show in Explorer" onClick={() => void window.modHub.openPath(m.path)}>
                          📁
                        </button>
                        <button type="button" className="btn btn-sm btn-ghost" title="Delete (to the Recycle Bin)" onClick={() => void deleteShipMod(m)}>
                          🗑
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
            <section className="emu-panel">
              <h3>Modlists</h3>
              <p className="muted">
                A modlist remembers which packs are on{ordered ? ' and their order' : ''}. Applying one switches its packs on
                {ordered ? ' in that order' : ''} and every other pack off (the game must be closed).
              </p>
              <div className="emu-ship-actions">
                <input
                  type="text"
                  placeholder="Name for the packs that are on now"
                  value={listName}
                  onChange={(e) => setListName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void saveModList()}
                />
                <button type="button" className="btn btn-sm btn-primary" disabled={!listName.trim()} onClick={() => void saveModList()}>
                  Save current ({onMods.length} on)
                </button>
              </div>
              {portLists.length === 0 ? (
                <p className="muted">No modlists saved yet.</p>
              ) : (
                <ul>
                  {portLists.map((l) => {
                    const current = sameList(l.files);
                    return (
                      <li key={l.name} title={l.files.map((f, n) => `${n + 1}. ${f}`).join('\n') || '(no packs)'}>
                        {renamingList?.name === l.name ? (
                          <input
                            className="emu-rename"
                            autoFocus
                            value={renamingList.value}
                            onChange={(e) => setRenamingList({ name: l.name, value: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void finishListRename();
                              if (e.key === 'Escape') setRenamingList(null);
                            }}
                            onBlur={() => void finishListRename()}
                          />
                        ) : (
                          <strong>{l.name}</strong>
                        )}
                        <span className="muted">
                          {' '}
                          · {l.files.length} pack{l.files.length === 1 ? '' : 's'} · saved {formatShortDate(l.saved)}
                          {current ? ' · active' : ''}
                        </span>
                        <span className="dup-spacer" />
                        <button type="button" className="btn btn-sm btn-primary" disabled={current} onClick={() => void applyModList(l.files)}>
                          Apply
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          disabled={current}
                          title="Save the packs that are on now (and their order) into this modlist"
                          onClick={() => void updateModList(l.name)}
                        >
                          Update
                        </button>
                        <button type="button" className="btn btn-sm btn-ghost" title="Rename" onClick={() => setRenamingList({ name: l.name, value: l.name })}>
                          ✎
                        </button>
                        <button type="button" className="btn btn-sm btn-ghost" title="Remove this modlist" onClick={() => void removeModList(l.name)}>
                          ✕
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="emu">
      <div className="filter-row subtabs-row">{tabs}</div>
      <div className="emu-head">
        <p className="loadouts-note">
          Library <code>{lib.root}</code> · {lib.roms.length} ROMs across {systems.length} systems. Play opens the game in RetroArch
          with the system's core (or BizHawk); saves and states are RetroArch's.
        </p>
        <div className="emu-actions">
          <button type="button" className="btn btn-sm" disabled={loading} onClick={() => void load()}>
            {loading ? 'Scanning…' : 'Rescan'}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => void window.modHub.openPath(lib.root)}>
            Open folder
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void pickRoot()}>
            Change folder…
          </button>
        </div>
      </div>

      <div className="toolbar">
        <label className="toolbar-select">
          System
          <select value={system} onChange={(e) => setSystem(e.target.value)}>
            <option value="all">All systems</option>
            {systems.map((s) => (
              <option key={s} value={s}>
                {lib.systems[s].name} ({lib.roms.filter((r) => r.system === s).length})
              </option>
            ))}
          </select>
        </label>
        <input type="search" placeholder="Search ROMs" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      <div className="mod-table-wrap">
        <table className="mod-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Console</th>
              <th>Where</th>
              <th>Region</th>
              <th>Notes</th>
              <th className="col-num">Size</th>
              <th className="emu-col-saves">Save / states</th>
              <th className="col-date">Last played</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {roms.map((r) => (
              <tr key={r.path}>
                <td className="col-title" title={r.file}>
                  {r.hackInfo?.name ?? r.title}
                  {r.hackInfo && <div className="emu-hack-line">{hackLine(r)}</div>}
                </td>
                <td title={lib.systems[r.system] ? `${lib.systems[r.system].name}${lib.systems[r.system].core ? ` · RetroArch core: ${lib.systems[r.system].core}` : ''}` : undefined}>
                  {r.system}
                </td>
                <td className="emu-col-where" title={`${r.path}${r.where === 'all' ? `\nAlso on: ${r.devices.filter((d) => d !== 'PC').join(', ')}` : ''}`}>
                  {WHERE_LABEL[r.where]}
                </td>
                <td>{r.region ?? '—'}</td>
                <td>
                  {r.hack && <span className="status-pill update">hack / patched</span>}
                  {r.location === 'bizhawk' && <span className="status-pill">BizHawk folder</span>}
                  {!!r.duplicateCount && (
                    <span className="status-pill" title="Same bytes as another file in the library">
                      duplicate ×{r.duplicateCount}
                    </span>
                  )}
                  {r.tags.filter((t) => !/patched/i.test(t)).map((t) => (
                    <span key={t} className="emu-tag" title={t === '!' ? 'A verified good dump' : undefined}>
                      {t === '!' ? 'verified dump' : t}
                    </span>
                  ))}
                </td>
                <td className="col-num">{formatBytes(r.sizeBytes)}</td>
                <td className="emu-col-saves">
                  {r.hasSave ? 'save' : '—'}
                  {r.stateCount ? ` · ${r.stateCount} state${r.stateCount === 1 ? '' : 's'}` : ''}
                </td>
                <td className="col-date">{r.lastPlayed ? formatShortDate(r.lastPlayed) : '—'}</td>
                <td className="emu-row-actions">
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => void play(r)}>
                    Play
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" title="Show in Explorer" onClick={() => void window.modHub.openPath(r.path)}>
                    📁
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="emu-panels">
        <section className="emu-panel">
          <h3>Emulators &amp; PC ports</h3>
          <ul>
            {lib.emulators.map((e) => (
              <li key={e.id}>
                <strong>{e.name}</strong>
                {e.detail && <span className="muted"> · {e.detail}</span>}
                <span className="dup-spacer" />
                <button type="button" className="btn btn-sm" onClick={() => void launch(e.id, e.name)}>
                  Open
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => void window.modHub.openPath(e.dir)}>
                  📁
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className="emu-panel">
          <h3>Synced with Syncthing</h3>
          {lib.synced.length === 0 ? (
            <p className="muted">No Syncthing folders inside the library.</p>
          ) : (
            <ul>
              {lib.synced.map((f) => (
                <li key={f.path} title={f.path}>
                  <strong>{f.label}</strong>
                  <span className="muted"> · {f.devices.length ? f.devices.join(', ') : 'no other devices'}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <section className="emu-panel emu-ports">
        <div className="emu-ports-head">
          <h3>PC ports &amp; decomp builds</h3>
          <span className="dup-spacer" />
          <button type="button" className="btn btn-sm" onClick={() => void addPort()}>
            Add folder…
          </button>
        </div>
        {lib.pcPorts.length === 0 ? (
          <p className="muted">Add a PC port checkout (e.g. a Project Picori folder) to play its builds and rebuild it from here.</p>
        ) : (
          lib.pcPorts.map((p) => (
            <div key={p.id} className="emu-port">
              <div className="emu-port-row">
                <strong>{p.name}</strong>
                {p.detail && <span className="muted"> · {p.detail}</span>}
                <span className="dup-spacer" />
                {p.targets.map((t) => (
                  <button
                    key={t.label}
                    type="button"
                    className="btn btn-sm btn-primary"
                    title={`${t.exe}${t.built ? `\nBuilt ${new Date(t.built).toLocaleString()}` : ''}`}
                    onClick={() => void playPort(p, t.label)}
                  >
                    Play {t.label}
                  </button>
                ))}
                {p.buildRegions.map((r) => (
                  <button
                    key={r}
                    type="button"
                    className="btn btn-sm"
                    disabled={!!building}
                    title={`Full build (build.py) for ${r}; stages the playable copy`}
                    onClick={() => void build(p, r)}
                  >
                    {building === p.id ? 'Building…' : `Build ${r}`}
                  </button>
                ))}
                <button type="button" className="btn btn-sm btn-ghost" title="Open folder" onClick={() => void window.modHub.openPath(p.dir)}>
                  📁
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  title="Remove from this list (doesn't touch the folder)"
                  onClick={() => void window.modHub.removePcPortFolder(p.dir).then(load)}
                >
                  ✕
                </button>
              </div>
              {p.targets.length > 0 && (
                <div className="muted emu-port-built">
                  Last built: {p.targets.map((t) => `${t.label} ${t.built ? formatShortDate(t.built) : '—'}`).join(' · ')}
                </div>
              )}
              {buildLog[p.id] && (
                <pre className="emu-build-log" ref={logRef}>
                  {buildLog[p.id].join('\n')}
                </pre>
              )}
            </div>
          ))
        )}
      </section>

    </div>
  );
}
