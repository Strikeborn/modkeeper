/**
 * What's inside a Minecraft instance, and the few changes ModKeeper makes to it:
 *  - mods: on/off by renaming "x.jar" <-> "x.jar.disabled" (what Prism, CurseForge and Modrinth all do)
 *  - resource packs: on/off and order in options.txt's resourcePacks list (last in the list = on top)
 *  - shaders: the active pack in Iris's config/iris.properties or OptiFine's optionsshaders.txt
 *  - worlds: read level.dat; back up to a zip in ModKeeper's data folder
 * Text settings files are edited line by line (backed up first); nothing changes while the instance runs.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { McInstance, McItem, McKind } from '../shared/types';
import { dataDir } from './dataDir';
import { replaceNbtString, worldInfo } from './nbt';
import { jarMetadata, readZipEntry, type JarMeta } from './prism';
import { zipFolder } from './zipUtil';

type Result = { ok: boolean; error?: string };

const FOLDERS: Record<McKind, string> = {
  mods: 'mods',
  resourcepacks: 'resourcepacks',
  shaderpacks: 'shaderpacks',
  worlds: 'saves',
  screenshots: 'screenshots',
};

export const kindDir = (inst: McInstance, kind: McKind) => path.join(inst.gameDir, FOLDERS[kind]);

function dataUrl(buf: Buffer | undefined, type = 'image/png'): string | undefined {
  return buf && buf.length < 1_500_000 ? `data:${type};base64,${buf.toString('base64')}` : undefined;
}

function folderSize(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else
        try {
          total += fs.statSync(f).size;
        } catch {
          /* gone */
        }
    }
  };
  try {
    walk(dir);
  } catch {
    /* unreadable */
  }
  return total;
}

// jar details and hashes are slow on big modpacks: keep them per file (path + size + time)
const jarCache = new Map<string, { meta: JarMeta; sha1: string; icon?: string }>();

function jarInfo(file: string, st: fs.Stats) {
  const key = `${file.toLowerCase()}|${st.size}|${st.mtimeMs}`;
  const hit = jarCache.get(key);
  if (hit) return hit;
  const meta = jarMetadata(file);
  let icon: string | undefined;
  if (meta.icon) {
    try {
      const want = meta.icon.replace(/^\//, '');
      icon = dataUrl(readZipEntry(file, (n) => n === want)?.data);
    } catch {
      /* no icon */
    }
  }
  const info = { meta, sha1: crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'), icon };
  jarCache.set(key, info);
  return info;
}

// ---- options.txt: resourcePacks:["vanilla","file/Pack.zip"] ----

function readOptions(inst: McInstance): string | undefined {
  try {
    return fs.readFileSync(path.join(inst.gameDir, 'options.txt'), 'utf8');
  } catch {
    return undefined;
  }
}

function optionList(text: string, key: string): string[] {
  const line = new RegExp(`^${key}:(.*)$`, 'm').exec(text)?.[1];
  if (!line) return [];
  try {
    const v = JSON.parse(line) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function backupFile(inst: McInstance, file: string) {
  const dir = path.join(dataDir(), 'backups', 'minecraft', safeName(inst.name));
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(file, path.join(dir, `${path.basename(file)}-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  const old = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(path.basename(file) + '-'))
    .sort();
  for (const f of old.slice(0, Math.max(0, old.length - 20))) fs.rmSync(path.join(dir, f), { force: true });
}

const safeName = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'instance'; // oxlint-disable-line no-control-regex

/** Set a "key:value" line in a key:value settings file (adds it if missing), backing the file up first. */
function setLine(inst: McInstance, file: string, key: string, value: string, sep = ':') {
  let text = '';
  if (fs.existsSync(file)) {
    text = fs.readFileSync(file, 'utf8');
    backupFile(inst, file);
  }
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${sep}.*$`, 'm');
  const line = `${key}${sep}${value}`;
  text = re.test(text) ? text.replace(re, () => line) : `${text}${text && !text.endsWith('\n') ? nl : ''}${line}${nl}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

// ---- shaders ----

function activeShader(inst: McInstance): string | undefined {
  const read = (f: string) => {
    try {
      return fs.readFileSync(path.join(inst.gameDir, f), 'utf8');
    } catch {
      return undefined;
    }
  };
  if (inst.shaderLoader === 'iris') {
    const t = read(path.join('config', 'iris.properties')) ?? read(path.join('config', 'oculus.properties'));
    if (!t || /^enableShaders=false/m.test(t)) return undefined;
    return /^shaderPack=(.*)$/m.exec(t)?.[1]?.trim() || undefined;
  }
  const t = read('optionsshaders.txt');
  const v = t && /^shaderPack=(.*)$/m.exec(t)?.[1]?.trim();
  return v && v !== 'OFF' && v !== '(internal)' ? v : undefined;
}

/** Turn a shader pack on (the only active one) or shaders off. */
export function setActiveShader(inst: McInstance, file: string | null): Result {
  if (!inst.shaderLoader) return { ok: false, error: 'This instance has no shader loader (Iris or OptiFine). Install Iris from Browse first.' };
  if (inst.shaderLoader === 'iris') {
    const cfg = ['iris.properties', 'oculus.properties'].map((f) => path.join(inst.gameDir, 'config', f)).find((f) => fs.existsSync(f)) ?? path.join(inst.gameDir, 'config', 'iris.properties');
    if (file) setLine(inst, cfg, 'shaderPack', file, '=');
    setLine(inst, cfg, 'enableShaders', file ? 'true' : 'false', '=');
  } else setLine(inst, path.join(inst.gameDir, 'optionsshaders.txt'), 'shaderPack', file ?? 'OFF', '=');
  return { ok: true };
}

// ---- listing ----

export function listMcContent(inst: McInstance, kind: McKind): McItem[] {
  const dir = kindDir(inst, kind);
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: McItem[] = [];
  if (kind === 'mods') {
    for (const e of entries) {
      if (!e.isFile() || !/\.jar(\.disabled)?$/i.test(e.name)) continue;
      const full = path.join(dir, e.name);
      const st = fs.statSync(full);
      const { meta, sha1, icon } = jarInfo(full, st);
      out.push({
        kind,
        file: e.name.replace(/\.disabled$/i, ''),
        path: full,
        enabled: !/\.disabled$/i.test(e.name),
        sizeBytes: st.size,
        modified: st.mtime.toISOString(),
        title: meta.name ?? e.name.replace(/\.jar(\.disabled)?$/i, ''),
        version: meta.version,
        authors: meta.authors,
        description: meta.description,
        icon,
        modId: meta.modId,
        sha1,
        missing: meta.depends,
      });
    }
    // which needed ids no enabled mod provides
    const have = new Set<string>();
    for (const m of out.filter((x) => x.enabled)) {
      const meta = jarInfo(m.path, fs.statSync(m.path)).meta;
      if (meta.modId) have.add(meta.modId);
      for (const p of meta.provides ?? []) have.add(p);
    }
    if (have.has('fabric-api')) have.add('fabric');
    if (have.has('fabric')) have.add('fabric-api');
    for (const m of out) m.missing = m.enabled ? m.missing?.filter((d) => !have.has(d)) : undefined;
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  if (kind === 'resourcepacks') {
    const opts = readOptions(inst) ?? '';
    const on = optionList(opts, 'resourcePacks').filter((x) => x.startsWith('file/')).map((x) => x.slice(5));
    for (const e of entries) {
      if (!e.isDirectory() && !/\.zip$/i.test(e.name)) continue;
      const full = path.join(dir, e.name);
      const st = fs.statSync(full);
      let icon: string | undefined;
      let description: string | undefined;
      try {
        if (e.isDirectory()) {
          icon = dataUrl(fs.existsSync(path.join(full, 'pack.png')) ? fs.readFileSync(path.join(full, 'pack.png')) : undefined);
          description = packDescription(fs.readFileSync(path.join(full, 'pack.mcmeta'), 'utf8'));
        } else {
          icon = dataUrl(readZipEntry(full, (n) => n === 'pack.png')?.data);
          description = packDescription(readZipEntry(full, (n) => n === 'pack.mcmeta')?.data.toString('utf8'));
        }
      } catch {
        /* no pack.png / pack.mcmeta */
      }
      const idx = on.indexOf(e.name);
      out.push({
        kind,
        file: e.name,
        path: full,
        enabled: idx >= 0,
        order: idx >= 0 ? on.length - 1 - idx : undefined,
        sizeBytes: e.isDirectory() ? undefined : st.size,
        modified: st.mtime.toISOString(),
        title: e.name.replace(/\.zip$/i, ''),
        description,
        icon,
      });
    }
    return out.sort((a, b) => (a.enabled === b.enabled ? (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title) : a.enabled ? -1 : 1));
  }

  if (kind === 'shaderpacks') {
    const active = activeShader(inst);
    for (const e of entries) {
      if (!e.isDirectory() && !/\.zip$/i.test(e.name)) continue;
      const full = path.join(dir, e.name);
      const st = fs.statSync(full);
      out.push({
        kind,
        file: e.name,
        path: full,
        enabled: e.name === active,
        active: e.name === active,
        sizeBytes: e.isDirectory() ? undefined : st.size,
        modified: st.mtime.toISOString(),
        title: e.name.replace(/\.zip$/i, ''),
      });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  if (kind === 'worlds') {
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      const level = path.join(full, 'level.dat');
      if (!fs.existsSync(level)) continue;
      let world: McItem['world'];
      try {
        world = worldInfo(fs.readFileSync(level));
        // the folder's creation time is when the world was made (Minecraft doesn't store it)
        const made = fs.statSync(full);
        world.created = (made.birthtimeMs > 0 ? made.birthtime : made.mtime).toISOString();
      } catch {
        world = undefined;
      }
      const st = fs.statSync(level);
      out.push({
        kind,
        file: e.name,
        path: full,
        enabled: true,
        sizeBytes: folderSize(full),
        modified: st.mtime.toISOString(),
        title: world?.levelName || e.name,
        icon: dataUrl(fs.existsSync(path.join(full, 'icon.png')) ? fs.readFileSync(path.join(full, 'icon.png')) : undefined),
        world,
      });
    }
    return out.sort((a, b) => (b.world?.lastPlayed ?? 0) - (a.world?.lastPlayed ?? 0));
  }

  // screenshots: newest first, thumbnails are the files themselves (loaded by the page on demand)
  for (const e of entries) {
    if (!e.isFile() || !/\.(png|jpe?g)$/i.test(e.name)) continue;
    const full = path.join(dir, e.name);
    const st = fs.statSync(full);
    out.push({ kind, file: e.name, path: full, enabled: true, sizeBytes: st.size, modified: st.mtime.toISOString(), title: e.name });
  }
  return out.sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? ''));
}

/** pack.mcmeta's description: a string, or Minecraft's text components. */
function packDescription(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    const d = (JSON.parse(raw) as { pack?: { description?: unknown } }).pack?.description;
    const flat = (v: unknown): string =>
      typeof v === 'string' ? v : Array.isArray(v) ? v.map(flat).join('') : v && typeof v === 'object' ? `${(v as { text?: string }).text ?? ''}${flat((v as { extra?: unknown }).extra ?? '')}` : '';
    return flat(d).replace(/§./g, '').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** A screenshot's path, if it's really one of this instance's screenshots. */
export function screenshotPath(inst: McInstance, file: string): string | undefined {
  const full = itemPath(inst, 'screenshots', file);
  return full && /\.(png|jpe?g)$/i.test(full) && fs.existsSync(full) ? full : undefined;
}

// ---- changes ----

/** The item's file inside its kind's folder, or undefined if the name tries to leave it. */
export function itemPath(inst: McInstance, kind: McKind, file: string): string | undefined {
  const dir = path.resolve(kindDir(inst, kind));
  const full = path.resolve(dir, file);
  return full.startsWith(dir + path.sep) && path.dirname(full) === dir ? full : undefined;
}

export function setModEnabled(inst: McInstance, file: string, enabled: boolean): Result {
  const on = itemPath(inst, 'mods', file);
  if (!on || !/\.jar$/i.test(on)) return { ok: false, error: 'Not a mod in this instance' };
  const off = `${on}.disabled`;
  if (enabled && fs.existsSync(off) && !fs.existsSync(on)) fs.renameSync(off, on);
  else if (!enabled && fs.existsSync(on) && !fs.existsSync(off)) fs.renameSync(on, off);
  return { ok: true };
}

/** Exactly these mods on (by file name), every other one off. */
export function applyMcModList(inst: McInstance, files: string[]): Result & { switched: number; missing: string[] } {
  const want = new Set(files.map((f) => f.toLowerCase()));
  let switched = 0;
  const items = listMcContent(inst, 'mods');
  for (const m of items) {
    const on = want.has(m.file.toLowerCase());
    if (on === m.enabled) continue;
    const r = setModEnabled(inst, m.file, on);
    if (!r.ok) return { ...r, switched, missing: [] };
    switched++;
  }
  const missing = files.filter((f) => !items.some((m) => m.file.toLowerCase() === f.toLowerCase()));
  return { ok: true, switched, missing };
}

/** Resource packs: write the on list (top first in `onTopFirst`) to options.txt, keeping vanilla and built-in packs. */
function writeResourcePacks(inst: McInstance, onTopFirst: string[]): Result {
  const file = path.join(inst.gameDir, 'options.txt');
  const text = readOptions(inst);
  if (text === undefined) return { ok: false, error: 'Start this instance once first (Minecraft creates options.txt on its first run).' };
  const current = optionList(text, 'resourcePacks');
  const builtIn = current.filter((x) => !x.startsWith('file/'));
  const list = [...(builtIn.length ? builtIn : ['vanilla']), ...[...onTopFirst].reverse().map((f) => `file/${f}`)];
  setLine(inst, file, 'resourcePacks', JSON.stringify(list));
  // packs Minecraft marked incompatible stay marked only while they're on
  const incompatible = optionList(text, 'incompatibleResourcePacks').filter((x) => list.includes(x));
  if (/^incompatibleResourcePacks:/m.test(text)) setLine(inst, file, 'incompatibleResourcePacks', JSON.stringify(incompatible));
  return { ok: true };
}

export function setResourcePackEnabled(inst: McInstance, file: string, enabled: boolean): Result {
  if (!itemPath(inst, 'resourcepacks', file)) return { ok: false, error: 'Not a resource pack in this instance' };
  const on = listMcContent(inst, 'resourcepacks')
    .filter((p) => p.enabled && p.file !== file)
    .map((p) => p.file);
  return writeResourcePacks(inst, enabled ? [file, ...on] : on);
}

export function moveResourcePack(inst: McInstance, file: string, delta: number): Result {
  const on = listMcContent(inst, 'resourcepacks')
    .filter((p) => p.enabled)
    .map((p) => p.file);
  const i = on.indexOf(file);
  const j = i + Math.sign(delta);
  if (i < 0 || j < 0 || j >= on.length) return { ok: true };
  [on[i], on[j]] = [on[j], on[i]];
  return writeResourcePacks(inst, on);
}

/** Zip a world into ModKeeper's backups (named with the date). */
export function backupWorld(inst: McInstance, file: string): Result & { path?: string } {
  const full = itemPath(inst, 'worlds', file);
  if (!full || !fs.existsSync(path.join(full, 'level.dat'))) return { ok: false, error: 'Not a world in this instance' };
  const out = path.join(dataDir(), 'backups', 'minecraft', safeName(inst.name), 'worlds', `${safeName(file)}-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`);
  zipFolder(full, out, file);
  return { ok: true, path: out };
}

/**
 * Rename a world: the name Minecraft shows (LevelName in level.dat, backed up first) and, if asked, its folder.
 * Returns the folder name it ends up in.
 */
export function renameWorld(inst: McInstance, file: string, newName: string, renameFolder: boolean): Result & { file?: string } {
  const dir = itemPath(inst, 'worlds', file);
  const name = newName.trim();
  if (!dir || !fs.existsSync(path.join(dir, 'level.dat'))) return { ok: false, error: 'Not a world in this instance' };
  if (!name) return { ok: false, error: 'Type a name' };
  if (name.length > 100) return { ok: false, error: 'That name is too long' };
  let target = dir;
  if (renameFolder) {
    // Windows-safe folder name, like Minecraft makes: no \ / : * ? " < > |, no trailing dots or spaces
    const folder = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'World'; // oxlint-disable-line no-control-regex
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(folder)) return { ok: false, error: 'Windows doesn’t allow that folder name' };
    target = path.join(path.dirname(dir), folder);
    if (target.toLowerCase() !== dir.toLowerCase() && fs.existsSync(target)) return { ok: false, error: `There’s already a world folder called “${folder}”` };
  }
  const level = path.join(dir, 'level.dat');
  const raw = fs.readFileSync(level);
  const next = replaceNbtString(raw, ['Data', 'LevelName'], name);
  if (worldInfo(next).levelName !== name) return { ok: false, error: 'Couldn’t change the name safely; nothing was changed.' };
  const backupDir = path.join(dataDir(), 'backups', 'minecraft', safeName(inst.name), 'worlds');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(level, path.join(backupDir, `${safeName(file)}-level.dat-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  fs.writeFileSync(`${level}.tmp`, next);
  fs.renameSync(`${level}.tmp`, level);
  if (target !== dir) {
    try {
      fs.renameSync(dir, target);
    } catch (e) {
      return { ok: true, file, error: `Renamed in game, but the folder couldn’t be renamed (${e instanceof Error ? e.message : String(e)}).` };
    }
  }
  return { ok: true, file: path.basename(target) };
}
