/**
 * Modrinth (public API, no key) and CurseForge (needs the user's API key) for the Minecraft tab: search
 * filtered to the instance's version and loader, install the right file with its required dependencies,
 * and find newer versions of what's installed. Every download is checked against the site's hash and
 * scanned with Microsoft Defender before it goes into the instance.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { McBrowseResult, McBrowseSite, McBrowseSort, McInstance, McKind, McProject, McSource, McUpdate } from '../shared/types';
import { dataDir } from './dataDir';
import { itemPath, kindDir, listMcContent } from './mcContent';
import { defenderScan } from './security';
import { extractZip, zipEntries } from './zipUtil';

const MODRINTH = 'https://api.modrinth.com/v2';
const CURSEFORGE = 'https://api.curseforge.com/v1';
const UA = 'Strikeborn/ModKeeper (github.com/Strikeborn/modkeeper)';
const CF_MINECRAFT = 432;
const CF_CLASS: Partial<Record<McKind, number>> = { mods: 6, resourcepacks: 12, shaderpacks: 6552, worlds: 17 };
const CF_LOADER: Record<string, number> = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
const MR_TYPE: Partial<Record<McKind, string>> = { mods: 'mod', resourcepacks: 'resourcepack', shaderpacks: 'shader' };

type Json = Record<string, unknown>;
type Result = { ok: boolean; message: string };

async function mr<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${MODRINTH}${url}`, { ...init, headers: { 'User-Agent': UA, 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`Modrinth returned HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function cf<T>(url: string, key: string | undefined): Promise<T> {
  if (!key) throw new Error('CurseForge needs an API key: add yours in Settings → Accounts.');
  const auth: Record<string, string> = key.startsWith('cfc_') ? { Authorization: `Key ${key}` } : { 'x-api-key': key };
  const res = await fetch(`${CURSEFORGE}${url}`, { headers: { ...auth, Accept: 'application/json', 'User-Agent': UA } });
  if (res.status === 403 || res.status === 401) {
    // keys can work for lookups and downloads while CurseForge still blocks them from searching
    if (url.startsWith('/mods/search'))
      throw new Error(
        'CurseForge accepted your key for lookups but won’t let it search yet. New keys are often limited until CurseForge approves them: check the key’s status at console.curseforge.com. Modrinth search works meanwhile.',
      );
    throw new Error('CurseForge refused the API key. Check it in Settings → Accounts.');
  }
  if (!res.ok) throw new Error(`CurseForge returned HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Loaders a file may target, for Modrinth's filters. */
function mrLoaders(inst: McInstance, kind: McKind): string[] {
  if (kind === 'mods') return inst.loader ? [inst.loader] : [];
  if (kind === 'shaderpacks') return inst.shaderLoader ? [inst.shaderLoader] : [];
  if (kind === 'resourcepacks') return ['minecraft'];
  return [];
}

// ---------------- search ----------------

/** Modrinth projects installed in an instance (by the files' SHA-1), remembered while the files stay the same. */
const installedCache = new Map<string, Set<string>>();
async function installedModrinthProjects(inst: McInstance, kind: McKind): Promise<Set<string>> {
  const items = listMcContent(inst, kind).filter((i) => kind === 'mods' || /\.zip$/i.test(i.file));
  const hashes = items.map((i) => i.sha1 ?? crypto.createHash('sha1').update(fs.readFileSync(i.path)).digest('hex'));
  if (!hashes.length) return new Set();
  const key = `${inst.id}|${kind}|${[...hashes].sort().join(',')}`;
  const hit = installedCache.get(key);
  if (hit) return hit;
  const found = await mr<Record<string, Json>>('/version_files', { method: 'POST', body: JSON.stringify({ hashes, algorithm: 'sha1' }) }).catch(() => ({}) as Record<string, Json>);
  const set = new Set(Object.values(found).map((v) => String(v.project_id)));
  installedCache.set(key, set);
  return set;
}

export async function searchMc(q: {
  site: McBrowseSite;
  kind: McKind;
  inst: McInstance;
  query?: string;
  sort: McBrowseSort;
  page: number;
  perPage: number;
  cfKey?: string;
  anyVersion?: boolean;
}): Promise<McBrowseResult> {
  const installed = new Set(listMcContent(q.inst, q.kind).map((i) => i.file.toLowerCase()));
  const version = q.anyVersion ? undefined : q.inst.mcVersion;
  if (q.site === 'modrinth') {
    const type = MR_TYPE[q.kind];
    if (!type) return { projects: [], total: 0, error: 'Modrinth has no worlds; switch to CurseForge for maps.' };
    const facets: string[][] = [[`project_type:${type}`]];
    if (version) facets.push([`versions:${version}`]);
    const loaders = mrLoaders(q.inst, q.kind).filter((l) => l !== 'minecraft');
    if (loaders.length) facets.push(loaders.map((l) => `categories:${l}`));
    const params = new URLSearchParams({
      query: q.query?.trim() ?? '',
      facets: JSON.stringify(facets),
      index: q.sort,
      offset: String((q.page - 1) * q.perPage),
      limit: String(q.perPage),
    });
    const [j, have] = await Promise.all([mr<{ hits: Json[]; total_hits: number }>(`/search?${params}`), installedModrinthProjects(q.inst, q.kind).catch(() => new Set<string>())]);
    return {
      total: j.total_hits,
      projects: j.hits.map(
        (h): McProject => ({
          site: 'modrinth',
          id: String(h.project_id),
          slug: h.slug as string,
          title: String(h.title ?? ''),
          description: h.description as string,
          author: h.author as string,
          icon: (h.icon_url as string) || undefined,
          downloads: h.downloads as number,
          follows: h.follows as number,
          updated: h.date_modified as string,
          categories: (h.display_categories ?? h.categories) as string[],
          url: `https://modrinth.com/${type}/${String(h.slug ?? h.project_id)}`,
          image: (h.featured_gallery as string) || ((h.gallery as string[] | undefined) ?? [])[0] || undefined,
          color: typeof h.color === 'number' ? `#${h.color.toString(16).padStart(6, '0')}` : undefined,
          installed: have.has(String(h.project_id)),
        }),
      ),
    };
  }
  const classId = CF_CLASS[q.kind];
  if (!classId) return { projects: [], total: 0, error: 'CurseForge has no screenshots section.' };
  const params = new URLSearchParams({
    gameId: String(CF_MINECRAFT),
    classId: String(classId),
    searchFilter: q.query?.trim() ?? '',
    sortField: String({ relevance: 1, downloads: 6, follows: 2, newest: 11, updated: 3 }[q.sort]),
    sortOrder: 'desc',
    index: String(Math.min(9950, (q.page - 1) * q.perPage)),
    pageSize: String(q.perPage),
  });
  if (version) params.set('gameVersion', version);
  if (q.kind === 'mods' && q.inst.loader && CF_LOADER[q.inst.loader]) params.set('modLoaderType', String(CF_LOADER[q.inst.loader]));
  const j = await cf<{ data: Json[]; pagination: { totalCount: number } }>(`/mods/search?${params}`, q.cfKey);
  return {
    // CurseForge only pages through the first 10,000 results
    total: Math.min(j.pagination.totalCount, 10_000),
    projects: j.data.map((m): McProject => {
      const files = (m.latestFiles as Json[] | undefined) ?? [];
      return {
        site: 'curseforge',
        id: String(m.id),
        slug: m.slug as string,
        title: String(m.name ?? ''),
        description: m.summary as string,
        author: ((m.authors as Json[] | undefined)?.[0]?.name as string) || undefined,
        icon: ((m.logo as Json | undefined)?.thumbnailUrl as string) || undefined,
        downloads: m.downloadCount as number,
        follows: m.thumbsUpCount as number,
        updated: m.dateModified as string,
        categories: ((m.categories as Json[] | undefined) ?? []).map((c) => String(c.name)).slice(0, 4),
        url: ((m.links as Json | undefined)?.websiteUrl as string) ?? `https://www.curseforge.com/minecraft/mc-mods/${m.slug}`,
        image: (((m.screenshots as Json[] | undefined) ?? [])[0]?.thumbnailUrl as string) || undefined,
        installed: files.some((f) => installed.has(String(f.fileName).toLowerCase())),
      };
    }),
  };
}

// ---------------- picking a file ----------------

type Picked = { url?: string; fileName: string; sha1?: string; versionName: string; fileId: string; projectId: string; published?: number; deps: { site: McBrowseSite; projectId: string; versionId?: string }[]; pageUrl?: string };

async function pickModrinth(inst: McInstance, kind: McKind, projectId: string, versionId?: string): Promise<Picked | undefined> {
  let v: Json | undefined;
  if (versionId) v = await mr<Json>(`/version/${versionId}`);
  else {
    const params = new URLSearchParams();
    const loaders = mrLoaders(inst, kind);
    if (loaders.length) params.set('loaders', JSON.stringify(loaders));
    if (inst.mcVersion) params.set('game_versions', JSON.stringify([inst.mcVersion]));
    const list = await mr<Json[]>(`/project/${projectId}/version?${params}`);
    v = list.find((x) => x.version_type === 'release') ?? list[0];
  }
  if (!v) return undefined;
  const files = (v.files as Json[]) ?? [];
  const f = files.find((x) => x.primary) ?? files[0];
  if (!f) return undefined;
  return {
    url: f.url as string,
    fileName: String(f.filename),
    sha1: (f.hashes as Json | undefined)?.sha1 as string,
    versionName: String(v.version_number ?? v.name ?? ''),
    fileId: String(v.id),
    projectId: String(v.project_id ?? projectId),
    published: v.date_published ? Date.parse(String(v.date_published)) / 1000 : undefined,
    deps: ((v.dependencies as Json[]) ?? [])
      .filter((d) => d.dependency_type === 'required' && (d.project_id || d.version_id))
      .map((d) => ({ site: 'modrinth' as const, projectId: String(d.project_id ?? ''), versionId: (d.version_id as string) || undefined })),
  };
}

const CF_LOADER_NAMES: Record<string, string> = { forge: 'Forge', fabric: 'Fabric', quilt: 'Quilt', neoforge: 'NeoForge' };

async function pickCurseforge(inst: McInstance, kind: McKind, projectId: string, cfKey?: string): Promise<Picked | undefined> {
  const params = new URLSearchParams({ pageSize: '50' });
  if (inst.mcVersion && kind !== 'worlds') params.set('gameVersion', inst.mcVersion);
  if (kind === 'mods' && inst.loader && CF_LOADER[inst.loader]) params.set('modLoaderType', String(CF_LOADER[inst.loader]));
  const j = await cf<{ data: Json[] }>(`/mods/${projectId}/files?${params}`, cfKey);
  const loaderName = inst.loader ? CF_LOADER_NAMES[inst.loader] : undefined;
  const fits = j.data.filter((f) => f.isAvailable !== false && (kind !== 'mods' || !loaderName || ((f.gameVersions as string[]) ?? []).includes(loaderName)));
  const sorted = [...fits].sort((a, b) => Date.parse(String(b.fileDate)) - Date.parse(String(a.fileDate)));
  const f = sorted.find((x) => x.releaseType === 1) ?? sorted[0];
  if (!f) return undefined;
  const mod = await cf<{ data: Json }>(`/mods/${projectId}`, cfKey).catch(() => undefined);
  return {
    url: (f.downloadUrl as string) || undefined,
    fileName: String(f.fileName),
    sha1: ((f.hashes as Json[]) ?? []).find((h) => h.algo === 1)?.value as string,
    versionName: String(f.displayName ?? f.fileName),
    fileId: String(f.id),
    projectId,
    published: Date.parse(String(f.fileDate)) / 1000,
    deps: ((f.dependencies as Json[]) ?? []).filter((d) => d.relationType === 3).map((d) => ({ site: 'curseforge' as const, projectId: String(d.modId) })),
    pageUrl: ((mod?.data.links as Json | undefined)?.websiteUrl as string) || undefined,
  };
}

// ---------------- download + place ----------------

async function download(url: string, sha1?: string): Promise<string> {
  const dir = path.join(dataDir(), 'downloads', 'minecraft');
  fs.mkdirSync(dir, { recursive: true });
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha1 && crypto.createHash('sha1').update(buf).digest('hex') !== sha1.toLowerCase()) throw new Error('Download damaged (checksum doesn’t match)');
  const name = decodeURIComponent(url.split('/').pop()?.split('?')[0] ?? 'download');
  const out = path.join(dir, `${Date.now()}-${name.replace(/[<>:"/\\|?*]/g, '_')}`);
  fs.writeFileSync(out, buf);
  return out;
}

/** A downloaded world zip: the folder holding level.dat goes into saves\ under a free name. */
function installWorld(inst: McInstance, zip: string, wanted: string): string {
  const buf = fs.readFileSync(zip);
  const level = zipEntries(buf).find((e) => /(^|\/)level\.dat$/.test(e.name));
  if (!level) throw new Error('No world (level.dat) inside the download');
  const prefix = level.name.slice(0, level.name.length - 'level.dat'.length);
  const saves = kindDir(inst, 'worlds');
  const base = (prefix.replace(/\/$/, '').split('/').pop() || wanted).replace(/[<>:"/\\|?*]/g, '_');
  let name = base;
  for (let n = 2; fs.existsSync(path.join(saves, name)); n++) name = `${base} (${n})`;
  extractZip(buf, path.join(saves, name), prefix);
  return name;
}

export type InstallReport = Result & { installed: { file: string; source: McSource }[] };

export async function installMc(q: { site: McBrowseSite; kind: McKind; inst: McInstance; projectId: string; cfKey?: string; title?: string }): Promise<InstallReport> {
  const installed: { file: string; source: McSource }[] = [];
  const notes: string[] = [];
  const done = new Set<string>();
  // what's already there, so dependencies already present aren't fetched again
  const haveFiles = new Set(listMcContent(q.inst, q.kind).map((i) => i.file.toLowerCase()));
  let haveProjects = new Set<string>();
  if (q.kind === 'mods') {
    const hashes = listMcContent(q.inst, 'mods')
      .map((m) => m.sha1)
      .filter((h): h is string => !!h);
    if (hashes.length)
      haveProjects = new Set(
        Object.values(await mr<Record<string, Json>>('/version_files', { method: 'POST', body: JSON.stringify({ hashes, algorithm: 'sha1' }) }).catch(() => ({}))).map((v) =>
          String(v.project_id),
        ),
      );
  }

  const one = async (site: McBrowseSite, projectId: string, versionId: string | undefined, top: boolean): Promise<void> => {
    const key = `${site}:${projectId || versionId}`;
    if (done.has(key)) return;
    done.add(key);
    if (!top && site === 'modrinth' && haveProjects.has(projectId)) return;
    const p = site === 'modrinth' ? await pickModrinth(q.inst, q.kind, projectId, versionId) : await pickCurseforge(q.inst, q.kind, projectId, q.cfKey);
    if (!p) {
      notes.push(`${top ? q.title ?? 'This' : `A required dependency (${projectId})`} has no file for ${q.inst.mcVersion ?? 'this version'}${q.kind === 'mods' && q.inst.loader ? ` / ${q.inst.loader}` : ''}.`);
      return;
    }
    if (!top && haveFiles.has(p.fileName.toLowerCase())) return;
    if (!p.url) {
      notes.push(`${p.fileName}: its author only allows downloads from the CurseForge site${p.pageUrl ? ` (${p.pageUrl})` : ''}.`);
      return;
    }
    if (q.kind !== 'worlds' && (haveFiles.has(p.fileName.toLowerCase()) || haveFiles.has(`${p.fileName.toLowerCase()}.disabled`))) {
      notes.push(`${p.fileName} is already installed.`);
      return;
    }
    const saved = await download(p.url, p.sha1);
    try {
      const scan = await defenderScan(saved);
      if (scan.status === 'threat') {
        notes.push(`${p.fileName}: Microsoft Defender found a threat; not installed.`);
        return;
      }
      let placed = p.fileName;
      if (q.kind === 'worlds') placed = installWorld(q.inst, saved, p.fileName.replace(/\.zip$/i, ''));
      else {
        const target = itemPath(q.inst, q.kind, p.fileName);
        if (!target) throw new Error(`Odd file name: ${p.fileName}`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(saved, target);
      }
      haveFiles.add(placed.toLowerCase());
      installed.push({ file: placed, source: { site, projectId: p.projectId, fileId: p.fileId, fileName: p.fileName, title: top ? q.title : undefined, published: p.published } });
      notes.push(`${top ? 'Installed' : 'Added dependency'} ${placed}${scan.status === 'clean' ? '' : ' (Defender couldn’t scan it)'}.`);
    } finally {
      fs.rmSync(saved, { force: true });
    }
    if (q.kind === 'mods') for (const d of p.deps) await one(d.site, d.projectId, d.versionId, false);
  };

  try {
    await one(q.site, q.projectId, undefined, true);
  } catch (e) {
    notes.push(e instanceof Error ? e.message : String(e));
  }
  return { ok: installed.length > 0, message: notes.join(' ') || 'Nothing installed.', installed };
}

// ---------------- updates ----------------

function sha1File(f: string): string {
  return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
}

/** Newer files for what's installed: Modrinth by file hash (works for anything from Modrinth), CurseForge by recorded source. */
export async function checkMcUpdates(inst: McInstance, kind: McKind, sources: Record<string, McSource>, cfKey?: string): Promise<McUpdate[]> {
  if (kind === 'worlds' || kind === 'screenshots') return [];
  const items = listMcContent(inst, kind).filter((i) => kind === 'mods' || /\.zip$/i.test(i.file));
  const hashes = new Map(items.map((i) => [i.sha1 ?? sha1File(i.path), i]));
  const out: McUpdate[] = [];
  if (hashes.size) {
    const latest = await mr<Record<string, Json>>('/version_files/update', {
      method: 'POST',
      body: JSON.stringify({ hashes: [...hashes.keys()], algorithm: 'sha1', loaders: mrLoaders(inst, kind), game_versions: inst.mcVersion ? [inst.mcVersion] : [] }),
    }).catch(() => ({}) as Record<string, Json>);
    for (const [hash, v] of Object.entries(latest)) {
      const item = hashes.get(hash);
      const files = (v.files as Json[]) ?? [];
      if (!item || files.some((f) => (f.hashes as Json)?.sha1 === hash)) continue;
      const f = files.find((x) => x.primary) ?? files[0];
      out.push({ file: item.file, site: 'modrinth', newVersion: String(v.version_number ?? ''), newFileName: String(f?.filename ?? '') });
    }
  }
  for (const i of items) {
    const src = sources[`${inst.id}|${i.file.toLowerCase()}`];
    if (!cfKey || src?.site !== 'curseforge' || out.some((u) => u.file === i.file)) continue;
    const p = await pickCurseforge(inst, kind, src.projectId, cfKey).catch(() => undefined);
    if (p && p.fileId !== src.fileId && (p.published ?? 0) > (src.published ?? 0)) out.push({ file: i.file, site: 'curseforge', newVersion: p.versionName, newFileName: p.fileName });
  }
  return out;
}

/** Swap an installed file for its newest version; the old one goes to ModKeeper's backups and on/off is kept. */
export async function updateMcItem(inst: McInstance, kind: McKind, file: string, sources: Record<string, McSource>, cfKey?: string): Promise<Result & { newFile?: string; source?: McSource }> {
  const item = listMcContent(inst, kind).find((i) => i.file === file);
  if (!item) return { ok: false, message: 'Not installed any more.' };
  let p: Picked | undefined;
  const src = sources[`${inst.id}|${file.toLowerCase()}`];
  if (src?.site === 'curseforge') p = await pickCurseforge(inst, kind, src.projectId, cfKey);
  else {
    const latest = await mr<Record<string, Json>>('/version_files/update', {
      method: 'POST',
      body: JSON.stringify({ hashes: [item.sha1 ?? sha1File(item.path)], algorithm: 'sha1', loaders: mrLoaders(inst, kind), game_versions: inst.mcVersion ? [inst.mcVersion] : [] }),
    });
    const v = Object.values(latest)[0];
    if (v) p = await pickModrinth(inst, kind, String(v.project_id), String(v.id));
  }
  if (!p?.url) return { ok: false, message: p ? `${p.fileName}: download it from the CurseForge site.` : 'No newer file found.' };
  if (p.fileName === file) return { ok: true, message: `${file} is up to date.` };
  const saved = await download(p.url, p.sha1);
  try {
    const scan = await defenderScan(saved);
    if (scan.status === 'threat') return { ok: false, message: `${p.fileName}: Microsoft Defender found a threat; not installed.` };
    const target = itemPath(inst, kind, item.enabled || kind !== 'mods' ? p.fileName : `${p.fileName}.disabled`);
    if (!target) return { ok: false, message: `Odd file name: ${p.fileName}` };
    if (fs.existsSync(target)) return { ok: false, message: `${p.fileName} is already there.` };
    const backup = path.join(dataDir(), 'backups', 'minecraft', 'replaced', new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(backup, { recursive: true });
    fs.renameSync(item.path, path.join(backup, path.basename(item.path)));
    fs.copyFileSync(saved, target);
    return {
      ok: true,
      message: `Updated ${file} → ${p.fileName}. The old file is in ModKeeper's backups.`,
      newFile: p.fileName,
      source: { site: src?.site ?? 'modrinth', projectId: p.projectId, fileId: p.fileId, fileName: p.fileName, title: src?.title, published: p.published },
    };
  } finally {
    fs.rmSync(saved, { force: true });
  }
}
