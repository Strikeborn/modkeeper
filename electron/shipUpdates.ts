/**
 * Matching a Ship pack to a newer GameBanana file: authors re-upload with new versions in the name
 * ("malon_v2.zip"), so names are compared with versions, years and punctuation left out.
 */
import type { GbFile, ShipModSource } from '../shared/types';

/** "3ds_Hero_Malon_(2026) v1.2.otr" -> "3ds hero malon" */
export function looseName(file: string): string {
  return file
    .toLowerCase()
    .replace(/(\.(o2r|otr|zip|7z|rar))+$/i, '')
    .split(/[^a-z0-9.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t && !/^v?\d+(\.\d+)*[a-z]?$/.test(t))
    .join(' ');
}

function prefixScore(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** The candidate whose name best matches `name`: same loose name, else the only one, else the longest shared start (4+ letters). */
export function bestMatch<T>(items: T[], name: string, nameOf: (t: T) => string): T | undefined {
  if (items.length === 0) return undefined;
  const want = looseName(name);
  const same = items.find((t) => looseName(nameOf(t)) === want);
  if (same) return same;
  if (items.length === 1) return items[0];
  const scored = items.map((t) => ({ t, s: prefixScore(looseName(nameOf(t)), want) })).sort((a, b) => b.s - a.s);
  return scored[0].s >= 4 && scored[0].s > (scored[1]?.s ?? 0) ? scored[0].t : undefined;
}

/** Files uploaded together are one release (a model and its equipment), not an update of each other. */
const SAME_RELEASE_SECONDS = 3600;

/**
 * A file uploaded after the installed one that stands in for it, if any. `inUse` holds the GameBanana file ids other
 * installed packs came from, so a sibling file of the same mod isn't taken for an update.
 */
export function newerFile(files: GbFile[], src: ShipModSource, inUse: Set<number> = new Set()): GbFile | undefined {
  if (!src.fileAdded) return undefined;
  const newer = files.filter(
    (f) => f.url && f.avResult !== 'infected' && (f.added ?? 0) > src.fileAdded! + SAME_RELEASE_SECONDS && f.id !== src.fileId && !inUse.has(f.id),
  );
  return bestMatch(newer, src.fileName, (f) => f.name);
}
