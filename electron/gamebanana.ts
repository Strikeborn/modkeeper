import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { GbFile, GbGame, GbMod, GbModDetails, GbSort } from '../shared/types';
import { find7zExecutable } from './sevenZipList';

/**
 * GameBanana (public apiv11, no key). Only the Mod section is used (no Requests, Questions, Tutorials or WiPs). Mods
 * GameBanana marks as mature (content ratings, a warning before showing, or NSFW) are shown with a Mature badge, or
 * left out when the user turns "Show mature mods" off in Settings.
 */
const API = 'https://gamebanana.com/apiv11';
/** GameBanana's game id for Ship of Harkinian (Ocarina of Time PC port). */
export const GB_SHIP_GAME_ID = 16121;
/** GameBanana games whose mods install straight into a PC port's mods folder. */
export const GB_PORT_GAMES: Record<number, 'soh' | '2ship' | 'starship'> = { [GB_SHIP_GAME_ID]: 'soh', 20371: '2ship', 21612: 'starship' };
const UA = 'ModKeeper (https://github.com/Strikeborn/modkeeper)';

type Json = Record<string, unknown>;

async function getJson(url: string): Promise<Json> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`GameBanana returned HTTP ${res.status}`);
  return (await res.json()) as Json;
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

export async function searchGbGames(name: string): Promise<GbGame[]> {
  const j = await getJson(`${API}/Util/Game/NameMatch?_sName=${encodeURIComponent(name.trim().slice(0, 80))}`);
  return ((j._aRecords as Json[]) ?? []).map((r) => ({ id: num(r._idRow) ?? 0, name: str(r._sName) ?? '', iconUrl: str(r._sIconUrl) }));
}

function previewUrl(r: Json): string | undefined {
  const img = ((r._aPreviewMedia as Json)?._aImages as Json[] | undefined)?.[0];
  if (!img) return undefined;
  const base = str(img._sBaseUrl);
  const file = str(img._sFile530) ?? str(img._sFile);
  return base && file ? `${base}/${file}` : undefined;
}

/** Mods only (no requests, questions, tutorials...). */
const isMod = (r: Json) => str(r._sModelName) === undefined || str(r._sModelName) === 'Mod';

/** Content GameBanana rates or shows behind a warning. */
function isMature(r: Json): boolean {
  if (r._bHasContentRatings === true || r._bIsNsfw === true) return true;
  const vis = str(r._sInitialVisibility);
  return Boolean(vis && vis !== 'show');
}

function toMod(r: Json): GbMod {
  return {
    id: num(r._idRow) ?? 0,
    name: str(r._sName) ?? '',
    url: str(r._sProfileUrl) ?? '',
    author: str((r._aSubmitter as Json)?._sName),
    authorUrl: str((r._aSubmitter as Json)?._sProfileUrl),
    category: str((r._aRootCategory as Json)?._sName),
    gameId: num((r._aGame as Json)?._idRow),
    gameName: str((r._aGame as Json)?._sName),
    version: str(r._sVersion)?.replace(/^v(?=\d)/i, '') || undefined,
    likes: num(r._nLikeCount),
    views: num(r._nViewCount),
    added: num(r._tsDateAdded),
    updated: num(r._tsDateUpdated) ?? num(r._tsDateModified),
    previewUrl: previewUrl(r),
    hasFiles: r._bHasFiles !== false,
    mature: isMature(r) || undefined,
  };
}

const SORTS: Record<GbSort, string> = {
  liked: 'Generic_MostLiked',
  downloaded: 'Generic_MostDownloaded',
  viewed: 'Generic_MostViewed',
  newest: 'Generic_Newest',
  updated: 'Generic_LatestUpdated',
};

export async function listGbMods(q: { gameId: number; sort: GbSort; page: number; perPage: number; search?: string; showMature?: boolean }): Promise<{
  mods: GbMod[];
  total: number;
  complete: boolean;
  perPage: number;
}> {
  const search = q.search?.trim();
  const url = search
    ? `${API}/Util/Search/Results?_sModelName=Mod&_sOrder=best_match&_idGameRow=${q.gameId}&_sSearchString=${encodeURIComponent(search.slice(0, 100))}&_nPage=${q.page}`
    : `${API}/Mod/Index?_nPerpage=${q.perPage}&_nPage=${q.page}&_aFilters%5BGeneric_Game%5D=${q.gameId}&_sSort=${SORTS[q.sort]}`;
  const j = await getJson(url);
  const meta = (j._aMetadata as Json) ?? {};
  const records = ((j._aRecords as Json[]) ?? []).filter((r) => isMod(r) && (q.showMature !== false || !isMature(r)));
  return {
    mods: records.map(toMod),
    total: num(meta._nRecordCount) ?? 0,
    complete: meta._bIsComplete === true,
    perPage: num(meta._nPerpage) ?? q.perPage,
  };
}

const detailsCache = new Map<number, GbModDetails>();

export async function gbModDetails(ids: number[], fresh = false): Promise<Record<number, GbModDetails>> {
  const out: Record<number, GbModDetails> = {};
  if (fresh) for (const id of ids) detailsCache.delete(id);
  const todo = ids.filter((id) => {
    const c = detailsCache.get(id);
    if (c) out[id] = c;
    return !c;
  });
  // A few at a time: kind to GameBanana, still quick for a page.
  for (let i = 0; i < todo.length; i += 4) {
    await Promise.all(
      todo.slice(i, i + 4).map(async (id) => {
        try {
          const d = await getJson(`${API}/Mod/${id}?_csvProperties=_sName,_sDescription,_bIsNsfw,_nDownloadCount,_aFiles`);
          const files: GbFile[] = ((d._aFiles as Json[]) ?? []).map((f) => ({
            id: num(f._idRow) ?? 0,
            name: str(f._sFile) ?? '',
            size: num(f._nFilesize) ?? 0,
            url: str(f._sDownloadUrl) ?? '',
            md5: str(f._sMd5Checksum),
            added: num(f._tsDateAdded),
            avResult: str(f._sAvResult),
            description: str(f._sDescription) || undefined,
          }));
          const det: GbModDetails = {
            name: str(d._sName),
            description: str(d._sDescription)?.trim() || undefined,
            nsfw: d._bIsNsfw === true,
            downloads: num(d._nDownloadCount),
            files,
          };
          detailsCache.set(id, det);
          out[id] = det;
        } catch {
          /* leave it out; the card shows without a description */
        }
      }),
    );
  }
  return out;
}

const PACK = /\.(o2r|otr)$/i;
const ARCHIVE = /\.(zip|7z|rar)$/i;

/** Newest file that isn't flagged by GameBanana's own antivirus. */
export function pickFile(files: GbFile[]): GbFile | undefined {
  return [...files].filter((f) => f.url && f.avResult !== 'infected').sort((a, b) => (b.added ?? 0) - (a.added ?? 0))[0];
}

/** Download a mod's file into ModKeeper's downloads folder; checks GameBanana's MD5. */
export async function downloadGbFile(file: GbFile, modId: number, downloadsRoot: string): Promise<string> {
  const dir = path.join(downloadsRoot, 'gamebanana', String(modId));
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(file.name) || `file-${file.id}`);
  const res = await fetch(file.url, { headers: { 'User-Agent': UA } });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  // Stream to disk (mods can be hundreds of MB), hashing as it goes.
  const hash = crypto.createHash('md5');
  const part = `${dest}.part`;
  const out = fs.createWriteStream(part);
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
  body.on('data', (chunk: Buffer) => hash.update(chunk));
  await pipeline(body, out);
  if (file.md5 && hash.digest('hex').toLowerCase() !== file.md5.toLowerCase()) {
    fs.rmSync(part, { force: true });
    throw new Error('Download damaged (checksum does not match GameBanana’s)');
  }
  fs.renameSync(part, dest);
  return dest;
}

/** Packs inside a downloaded file: the file itself, or what 7-Zip extracts from an archive (into a temp folder). */
export function packsFromDownload(file: string): { packs: string[]; tempDir?: string; error?: string } {
  if (PACK.test(file)) return { packs: [file] };
  if (!ARCHIVE.test(file)) return { packs: [], error: 'Not an .o2r/.otr pack or an archive' };
  const exe = find7zExecutable();
  if (!exe) return { packs: [], error: '7-Zip is needed to unpack this archive (install 7-Zip)' };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modkeeper-gb-'));
  try {
    execFileSync(exe, ['x', '-y', `-o${tempDir}`, file], { windowsHide: true, stdio: 'ignore', timeout: 5 * 60_000 });
  } catch {
    return { packs: [], tempDir, error: '7-Zip could not unpack the archive' };
  }
  const packs: string[] = [];
  const walk = (d: string, depth: number) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && depth > 0) walk(full, depth - 1);
      else if (PACK.test(e.name)) packs.push(full);
    }
  };
  walk(tempDir, 4);
  return { packs, tempDir };
}
