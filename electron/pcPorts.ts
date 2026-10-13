/**
 * PC ports and decomp builds (Emulation tab): folders the user adds in settings. A Project
 * Picori checkout (the Minish Cap decomp ported to PC) gets Play for each built copy and a
 * Build button that runs its build helper with live output. Ship of Harkinian mods are listed,
 * switched on/off, ordered, renamed and updated in step with Ship's own list (only while it's closed).
 * Nothing runs without the user's click.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import type { ModPortId, PcPort, ShipMod } from '../shared/types';
import { dataDir } from './dataDir';
import { packHasAltAssets } from './packList';

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function gitBranch(dir: string): string | undefined {
  try {
    const head = fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim();
    return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : head.slice(0, 7);
  } catch {
    // a worktree's .git is a file pointing at its gitdir
    try {
      const gitdir = /gitdir: (.*)/.exec(fs.readFileSync(path.join(dir, '.git'), 'utf8'))?.[1]?.trim();
      const head = gitdir ? fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf8').trim() : '';
      return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : undefined;
    } catch {
      return undefined;
    }
  }
}

/** What a folder holds: a Picori checkout (build.py + port/ + xmake.lua), else nothing we know. */
export function describePcPort(dir: string): PcPort | null {
  if (exists(path.join(dir, 'build.py')) && exists(path.join(dir, 'xmake.lua')) && exists(path.join(dir, 'port'))) {
    const branch = gitBranch(dir);
    const targets: PcPort['targets'] = [];
    for (const region of ['USA', 'EU', 'JP']) {
      const exe = path.join(dir, 'dist', region, 'tmc_pc.exe');
      if (exists(exe)) {
        let built: string | undefined;
        try {
          built = fs.statSync(exe).mtime.toISOString();
        } catch {
          /* unknown */
        }
        targets.push({ label: region, exe, cwd: path.dirname(exe), built });
      }
    }
    return {
      id: `picori:${dir.toLowerCase()}`,
      kind: 'picori',
      name: `Project Picori${branch ? ` (${branch})` : ''}`,
      detail: 'The Minish Cap, decomp ported to PC',
      dir,
      branch,
      targets,
      buildRegions: ['USA', 'EU'].filter((r) => r === 'USA' || targets.some((t) => t.label === r)),
      processName: 'tmc_pc.exe',
    };
  }
  return null;
}

function isRunning(image: string): boolean {
  try {
    return execFileSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH'], { encoding: 'utf8', windowsHide: true })
      .toLowerCase()
      .includes(image.toLowerCase());
  } catch {
    return false;
  }
}

export function launchPortTarget(port: PcPort, label: string): { ok: boolean; error?: string } {
  const t = port.targets.find((x) => x.label === label);
  if (!t) return { ok: false, error: `No ${label} build yet — Build first.` };
  spawn(t.exe, [], { cwd: t.cwd, detached: true, stdio: 'ignore' }).unref();
  return { ok: true };
}

const running = new Set<string>();

/** Run the port's build helper (Picori: `python build.py --usa`), streaming its output lines. */
export function buildPort(
  port: PcPort,
  region: string,
  onLine: (line: string) => void,
): Promise<{ ok: boolean; code?: number; error?: string }> {
  if (port.kind !== 'picori') return Promise.resolve({ ok: false, error: 'No build helper for this port' });
  if (running.has(port.id)) return Promise.resolve({ ok: false, error: 'A build is already running' });
  if (port.processName && isRunning(port.processName))
    return Promise.resolve({ ok: false, error: 'Close the game first — the build replaces its exe.' });
  const flag = region === 'EU' ? '--eur' : region === 'JP' ? '--jp' : '--usa';
  running.add(port.id);
  return new Promise((resolve) => {
    const child = spawn('python', ['build.py', flag], { cwd: port.dir, windowsHide: true, env: { ...process.env, PYTHONUNBUFFERED: '1', NO_COLOR: '1' } });
    let rest = '';
    const feed = (chunk: Buffer) => {
      rest += chunk.toString('utf8');
      const lines = rest.split(/\r?\n/);
      rest = lines.pop() ?? '';
      // strip terminal colour codes
      // oxlint-disable-next-line no-control-regex
      for (const l of lines) onLine(l.replace(/\x1b\[[0-9;]*m/g, ''));
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (e) => {
      running.delete(port.id);
      resolve({ ok: false, error: String(e) });
    });
    child.on('close', (code) => {
      if (rest) onLine(rest);
      running.delete(port.id);
      resolve({ ok: code === 0, code: code ?? undefined });
    });
  });
}

// ---------------- Mod packs for Ship of Harkinian and its sibling ports ----------------
// Ship 9 and 2Ship keep their enabled packs, in priority order (top wins), in their config as
// CVars.gSettings.EnabledMods ("name|name", file names without extension). At startup they put any pack
// in mods\ that isn't listed at the bottom, so an "off" pack has to live outside mods\: ModKeeper keeps
// those in mods-disabled\. Starship has no list: it loads every pack in mods\ (A to Z). Each port rewrites
// its config when it exits, so nothing here runs while it's open.

const PACK = /\.(o2r|otr)$/i;

export type { ModPortId };
export type ModPort = { id: ModPortId; dir: string };

export const MOD_PORTS: Record<
  ModPortId,
  { name: string; exe: string; config: string; enabledKey?: string[]; altKey: string[] }
> = {
  soh: {
    name: 'Ship of Harkinian',
    exe: 'soh.exe',
    config: 'shipofharkinian.json',
    enabledKey: ['CVars', 'gSettings', 'EnabledMods'],
    altKey: ['CVars', 'gSettings', 'AltAssets'],
  },
  '2ship': {
    name: '2 Ship 2 Harkinian',
    exe: '2ship.exe',
    config: '2ship2harkinian.json',
    enabledKey: ['CVars', 'gSettings', 'EnabledMods'],
    altKey: ['CVars', 'gEnhancements', 'Mods', 'AlternateAssets'],
  },
  starship: {
    name: 'Starship',
    exe: 'Starship.exe',
    config: 'starship.cfg.json',
    altKey: ['CVars', 'gEnhancements', 'Mods', 'AlternateAssets'],
  },
};

const portRunning = (port: ModPort) => isRunning(MOD_PORTS[port.id].exe);
const closeFirst = (port: ModPort) => `Close ${MOD_PORTS[port.id].name} first (it rewrites its settings when it exits).`;
/** Whether the port keeps its own ordered list of enabled packs (Starship loads mods\ A to Z). */
export const portHasList = (port: ModPort) => Boolean(MOD_PORTS[port.id].enabledKey);
// oxlint-disable-next-line no-control-regex
const BAD_NAME = /[<>:"/\\|?*\x00-\x1f]/;

/** The name Ship lists a pack under: its file name without the extension. */
export const shipModName = (file: string) => path.basename(file).replace(/\.[^.]*$/, '');

function listPacks(dir: string, enabled: boolean): ShipMod[] {
  const out: ShipMod[] = [];
  const walk = (d: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && depth > 0) walk(full, depth - 1);
      else if (PACK.test(e.name)) {
        const st = fs.statSync(full);
        out.push({
          file: e.name,
          path: full,
          sizeBytes: st.size,
          enabled,
          added: st.mtime.toISOString(),
          folder: path.relative(dir, d) || undefined,
          alt: altAssets(full, st),
        });
      }
    }
  };
  walk(dir, 2);
  return out;
}

// alt\ detection reads the whole pack, so remember it per file (path + size + time)
let altCache: Record<string, boolean> | undefined;
const altCacheFile = () => path.join(dataDir(), 'cache', 'ship-alt-assets.json');
function altAssets(file: string, st: fs.Stats): boolean | undefined {
  if (!altCache) {
    try {
      altCache = JSON.parse(fs.readFileSync(altCacheFile(), 'utf8')) as Record<string, boolean>;
    } catch {
      altCache = {};
    }
  }
  const key = `${file.toLowerCase()}|${st.size}|${Math.round(st.mtimeMs)}`;
  if (key in altCache) return altCache[key];
  const alt = packHasAltAssets(file);
  if (alt === undefined) return undefined;
  altCache[key] = alt;
  try {
    fs.mkdirSync(path.dirname(altCacheFile()), { recursive: true });
    fs.writeFileSync(altCacheFile(), JSON.stringify(altCache));
  } catch {
    /* cache only */
  }
  return alt;
}

// ---- shipofharkinian.json: edited as text, only the keys we change, so Ship's other values keep their exact form ----

type Span = { path: string[]; start: number; end: number };

/** Where each value sits in a JSON text (objects, arrays and primitives), by key path. */
export function jsonSpans(text: string): Span[] {
  const spans: Span[] = [];
  let i = 0;
  const fail = (): never => {
    throw new Error(`Unexpected JSON at ${i}`);
  };
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const str = (): string => {
    const s = i;
    if (text[i] !== '"') fail();
    i++;
    while (text[i] !== '"') {
      if (i >= text.length) fail();
      if (text[i] === '\\') i++;
      i++;
    }
    i++;
    return JSON.parse(text.slice(s, i)) as string;
  };
  const value = (p: string[]) => {
    ws();
    const s = i;
    const c = text[i];
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      i++;
      ws();
      if (text[i] === close) i++;
      else
        for (;;) {
          if (c === '{') {
            ws();
            const k = str();
            ws();
            if (text[i++] !== ':') fail();
            value([...p, k]);
          } else value(p);
          ws();
          const d = text[i++];
          if (d === close) break;
          if (d !== ',') fail();
        }
    } else if (c === '"') str();
    else {
      while (i < text.length && /[^,}\]\s]/.test(text[i])) i++;
      if (i === s) fail();
    }
    spans.push({ path: p, start: s, end: i });
  };
  value([]);
  return spans;
}

/** Set a value at a key path (creating the objects on the way), changing nothing else in the text. */
export function setJsonValue(text: string, keys: string[], valueJson: string): string {
  const spans = jsonSpans(text);
  const at = (p: string[]) => spans.find((s) => s.path.length === p.length && s.path.every((k, n) => k === p[n]));
  const hit = at(keys);
  if (hit) return text.slice(0, hit.start) + valueJson + text.slice(hit.end);
  // deepest object that exists, then the rest nested inside it
  let depth = keys.length - 1;
  while (depth > 0 && text[at(keys.slice(0, depth))?.start ?? -1] !== '{') depth--;
  const obj = at(keys.slice(0, depth));
  if (!obj || text[obj.start] !== '{') throw new Error('Settings file is not a JSON object');
  let v = valueJson;
  for (let k = keys.length - 1; k > depth; k--) v = `{ ${JSON.stringify(keys[k])}: ${v} }`;
  const entry = `${JSON.stringify(keys[depth])}: ${v}`;
  const open = obj.start + 1;
  if (!text.slice(open, obj.end - 1).trim()) return text.slice(0, open) + entry + text.slice(obj.end - 1);
  const m = /^\r?\n([ \t]*)/.exec(text.slice(open));
  return text.slice(0, open) + (m ? m[0] : ' ') + entry + ',' + text.slice(open);
}

export interface ShipConfig {
  /** Enabled pack names, top (wins) first. */
  enabled: string[];
  altAssets?: boolean;
  exists: boolean;
}

export function readShipConfig(port: ModPort): ShipConfig {
  const prof = MOD_PORTS[port.id];
  const at = (j: unknown, keys: string[]) => keys.reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), j);
  try {
    const j: unknown = JSON.parse(fs.readFileSync(path.join(port.dir, prof.config), 'utf8'));
    const raw = prof.enabledKey ? at(j, prof.enabledKey) : undefined;
    const alt = at(j, prof.altKey);
    return { exists: true, enabled: typeof raw === 'string' && raw ? raw.split('|') : [], altAssets: typeof alt === 'number' ? alt !== 0 : undefined };
  } catch {
    return { exists: false, enabled: [] };
  }
}

type Result = { ok: boolean; error?: string };

/** Change gSettings keys in Ship's config (backed up first). Callers check Ship isn't running. */
function writeShipSettings(port: ModPort, values: { EnabledMods?: string[]; AltAssets?: boolean }): Result {
  const prof = MOD_PORTS[port.id];
  const file = path.join(port.dir, prof.config);
  if (values.EnabledMods && !prof.enabledKey) values = { ...values, EnabledMods: undefined };
  if (!values.EnabledMods && values.AltAssets === undefined) return { ok: true };
  const had = exists(file);
  let text: string;
  try {
    text = had ? fs.readFileSync(file, 'utf8') : '{\n    "CVars": {}\n}\n';
    if (values.EnabledMods && prof.enabledKey) text = setJsonValue(text, prof.enabledKey, JSON.stringify(values.EnabledMods.join('|')));
    if (values.AltAssets !== undefined) text = setJsonValue(text, prof.altKey, values.AltAssets ? '1' : '0');
    JSON.parse(text);
  } catch {
    return { ok: false, error: `Couldn't read ${prof.config}; nothing changed.` };
  }
  if (had) {
    const dir = path.join(dataDir(), 'backups', port.id === 'soh' ? 'ship' : port.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(file, path.join(dir, `${prof.config.replace(/\.json$/, '')}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
    // keep the last 20
    const old = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    for (const f of old.slice(0, Math.max(0, old.length - 20))) fs.rmSync(path.join(dir, f), { force: true });
  }
  fs.writeFileSync(`${file}.tmp`, text, 'utf8');
  fs.renameSync(`${file}.tmp`, file);
  return { ok: true };
}

/** Packs in mods\ (on, in Ship's priority order) then mods-disabled\ (off, by name). */
export function listShipMods(port: ModPort): ShipMod[] {
  const on = listPacks(path.join(port.dir, 'mods'), true);
  const off = listPacks(path.join(port.dir, 'mods-disabled'), false).sort((a, b) => a.file.localeCompare(b.file));
  const order = effectiveOrder(port, on);
  on.sort((a, b) => order.indexOf(shipModName(a.file)) - order.indexOf(shipModName(b.file)));
  on.forEach((m, n) => (m.order = n));
  return [...on, ...off];
}

/** The order Ship will load: its list (installed packs only), then unlisted packs in mods\ at the bottom, as Ship adds them. */
function effectiveOrder(port: ModPort, on = listPacks(path.join(port.dir, 'mods'), true)): string[] {
  const names = on.map((m) => shipModName(m.file));
  if (!portHasList(port)) return [...new Set(on.map((m) => m.path).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).map(shipModName))];
  const listed = readShipConfig(port).enabled.filter((n) => names.includes(n));
  const unlisted = names.filter((n) => !listed.includes(n)).sort();
  return [...new Set([...listed, ...unlisted])];
}

export function shipAltAssets(port: ModPort): boolean | undefined {
  return readShipConfig(port).altAssets;
}

export function shipIsRunning(port: ModPort): boolean {
  return portRunning(port);
}

export function setShipAltAssets(port: ModPort, on: boolean): Result {
  if (portRunning(port)) return { ok: false, error: closeFirst(port) };
  return writeShipSettings(port, { AltAssets: on });
}

function inside(file: string, dir: string): boolean {
  return path.normalize(file).toLowerCase().startsWith(path.normalize(dir).toLowerCase() + path.sep);
}

export function isShipPack(port: ModPort, file: string): boolean {
  return PACK.test(file) && (inside(file, path.join(port.dir, 'mods')) || inside(file, path.join(port.dir, 'mods-disabled')));
}

function sameNameElsewhere(port: ModPort, name: string, except?: string): boolean {
  return [...listPacks(path.join(port.dir, 'mods'), true), ...listPacks(path.join(port.dir, 'mods-disabled'), false)].some(
    (m) => shipModName(m.file).toLowerCase() === name.toLowerCase() && m.path.toLowerCase() !== except?.toLowerCase(),
  );
}

/** On: into mods\ and to the top of Ship's list (so it wins). Off: out to mods-disabled\ and off the list. */
export function setShipModEnabled(port: ModPort, modPath: string, enabled: boolean): Result {
  if (portRunning(port)) return { ok: false, error: closeFirst(port) };
  const from = path.normalize(modPath);
  const src = path.join(port.dir, enabled ? 'mods-disabled' : 'mods');
  const dst = path.join(port.dir, enabled ? 'mods' : 'mods-disabled');
  if (!inside(from, src)) return { ok: false, error: 'Not in the expected folder' };
  const to = path.join(dst, path.relative(src, from));
  if (exists(to)) return { ok: false, error: 'A pack with that name is already there' };
  const name = shipModName(from);
  const order = effectiveOrder(port).filter((n) => n !== name);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  return writeShipSettings(port, { EnabledMods: enabled ? [name, ...order] : order });
}

/** Move an enabled pack up (-1) or down (+1) in Ship's priority list. */
export function moveShipMod(port: ModPort, modPath: string, delta: number): Result {
  if (!portHasList(port)) return { ok: false, error: `${MOD_PORTS[port.id].name} loads its packs A to Z; rename a pack to change its place.` };
  if (portRunning(port)) return { ok: false, error: closeFirst(port) };
  const order = effectiveOrder(port);
  const i = order.indexOf(shipModName(modPath));
  const j = i + Math.sign(delta);
  if (i < 0 || j < 0 || j >= order.length) return { ok: true };
  [order[i], order[j]] = [order[j], order[i]];
  return writeShipSettings(port, { EnabledMods: order });
}

/** Rename a pack's file (keeping its extension and place in the list). */
export function renameShipMod(port: ModPort, modPath: string, newName: string): Result & { path?: string; file?: string } {
  if (portRunning(port)) return { ok: false, error: closeFirst(port) };
  const from = path.normalize(modPath);
  if (!isShipPack(port, from)) return { ok: false, error: 'Not a Ship pack' };
  const name = newName.trim().replace(PACK, '');
  if (!name || BAD_NAME.test(name) || /^\.+$/.test(name)) return { ok: false, error: 'That name can’t be used (no \\ / : * ? " < > |)' };
  const oldName = shipModName(from);
  if (name === oldName) return { ok: true, path: from, file: path.basename(from) };
  if (name.toLowerCase() !== oldName.toLowerCase() && sameNameElsewhere(port, name)) return { ok: false, error: `A pack named “${name}” is already installed` };
  const to = path.join(path.dirname(from), name + path.extname(from));
  const order = effectiveOrder(port);
  fs.renameSync(from, to);
  const i = order.indexOf(oldName);
  if (i >= 0) {
    order[i] = name;
    const r = writeShipSettings(port, { EnabledMods: order });
    if (!r.ok) return r;
  }
  return { ok: true, path: to, file: path.basename(to) };
}

/** Take a pack off Ship's list (after it was deleted). */
export function forgetShipMod(port: ModPort, file: string): Result {
  if (portRunning(port)) return { ok: false, error: closeFirst(port) };
  const name = shipModName(file);
  const cfg = readShipConfig(port);
  if (!cfg.enabled.includes(name)) return { ok: true };
  return writeShipSettings(port, { EnabledMods: cfg.enabled.filter((n) => n !== name) });
}

/** Copy downloaded packs into mods\ (never overwrites) and put them at the top of Ship's list. */
export function addShipMods(port: ModPort, files: string[]): { added: number; skipped: string[]; addedFiles: string[]; note?: string } {
  const dst = path.join(port.dir, 'mods');
  fs.mkdirSync(dst, { recursive: true });
  const addedFiles: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const name = path.basename(f);
    if (!PACK.test(name)) {
      skipped.push(`${name} (not an .o2r/.otr pack — extract it first)`);
      continue;
    }
    if (sameNameElsewhere(port, shipModName(name))) {
      skipped.push(`${name} (already installed)`);
      continue;
    }
    fs.copyFileSync(f, path.join(dst, name));
    addedFiles.push(name);
  }
  let note: string | undefined;
  if (addedFiles.length) {
    const names = addedFiles.map(shipModName);
    if (!portHasList(port)) note = undefined;
    else if (portRunning(port)) note = `${MOD_PORTS[port.id].name} is open, so it adds the new packs at the bottom of its list when it next starts.`;
    else {
      const r = writeShipSettings(port, { EnabledMods: [...names, ...effectiveOrder(port).filter((n) => !names.includes(n))] });
      if (!r.ok) note = r.error;
    }
  }
  return { added: addedFiles.length, skipped, addedFiles, note };
}

/** Swap a pack for a newer one: the old file goes to backupDir, the new one takes its folder and place in the list. */
export function replaceShipMod(port: ModPort, oldPath: string, newPack: string, backupDir: string): Result & { file?: string } {
  if (portRunning(port)) return { ok: false, error: closeFirst(port) };
  const from = path.normalize(oldPath);
  if (!exists(from)) return { ok: false, error: 'The installed pack is gone' };
  const newName = shipModName(newPack);
  const oldName = shipModName(from);
  if (newName.toLowerCase() !== oldName.toLowerCase() && sameNameElsewhere(port, newName, from))
    return { ok: false, error: `Another pack named “${newName}” is already installed` };
  const order = effectiveOrder(port);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.renameSync(from, path.join(backupDir, path.basename(from)));
  const to = path.join(path.dirname(from), path.basename(newPack));
  fs.copyFileSync(newPack, to);
  const i = order.indexOf(oldName);
  if (i >= 0 && newName !== oldName) {
    order[i] = newName;
    const r = writeShipSettings(port, { EnabledMods: order });
    if (!r.ok) return r;
  }
  return { ok: true, file: path.basename(to) };
}

/** Make exactly these packs (file names, top wins) the enabled ones, in this order. */
export function applyShipModList(port: ModPort, files: string[]): Result & { switched: number; missing: string[] } {
  if (portRunning(port)) return { ok: false, error: closeFirst(port), switched: 0, missing: [] };
  const want = files.map(shipModName);
  const wantLower = new Set(want.map((n) => n.toLowerCase()));
  let switched = 0;
  for (const m of listShipMods(port)) {
    const on = wantLower.has(shipModName(m.file).toLowerCase());
    if (on === m.enabled) continue;
    const src = path.join(port.dir, m.enabled ? 'mods' : 'mods-disabled');
    const to = path.join(port.dir, on ? 'mods' : 'mods-disabled', path.relative(src, m.path));
    if (exists(to)) return { ok: false, error: `${m.file} is in both mods and mods-disabled`, switched, missing: [] };
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(m.path, to);
    switched++;
  }
  const installed = listPacks(path.join(port.dir, 'mods'), true).map((m) => shipModName(m.file));
  const byLower = new Map(installed.map((n) => [n.toLowerCase(), n]));
  const order = want.map((n) => byLower.get(n.toLowerCase())).filter((n): n is string => !!n);
  const missing = files.filter((f) => !byLower.has(shipModName(f).toLowerCase()));
  const r = writeShipSettings(port, { EnabledMods: [...new Set(order)] });
  return { ...r, switched, missing };
}
