import type { ModRecord } from '@shared/types';

export type GameVersionInfo = {
  /** Short label for a table cell, e.g. "1.4–1.6", "B41, B42", "Rep, Rep+". */
  short: string;
  /** Everything known, for a tooltip. */
  full: string;
  /** True when guessed from the title/description (Isaac's Workshop has no version tags). */
  guessed?: boolean;
};

function numericVersions(tags: string[]): number[] {
  return tags.map((t) => Number(t)).filter((n) => Number.isFinite(n));
}

/** Which game versions/DLC a mod is for: Workshop version tags (RimWorld, PZ), else title/description markers (Isaac). */
export function gameVersionsFor(m: ModRecord): GameVersionInfo | null {
  const tags = m.gameVersionTags ?? [];
  if (tags.length) {
    const nums = numericVersions(tags);
    if (nums.length === tags.length && nums.length > 2) {
      const sorted = [...nums].sort((a, b) => a - b);
      const fmt = (n: number) => tags[nums.indexOf(n)];
      return { short: `${fmt(sorted[0])}–${fmt(sorted[sorted.length - 1])}`, full: `Workshop tags: ${tags.join(', ')}` };
    }
    const short = tags.map((t) => t.replace(/^Build\s*/i, 'B')).join(', ');
    return { short, full: `Workshop tags: ${tags.join(', ')}` };
  }
  if (m.gameId !== 'binding-of-isaac') return null;
  const text = `${m.title} ${m.description ?? ''}`;
  const found: string[] = [];
  // "Required DLC" from an archived Workshop page is a fact, not a guess.
  const dlc = m.workshopArchived?.requiredDlc ?? [];
  if (dlc.some((d) => /repentance\s*\+/i.test(d))) found.push('Rep+');
  else if (dlc.some((d) => /repentance/i.test(d))) found.push('Rep');
  if (found.length && !/REPENTOGON/i.test(text)) {
    return { short: found.join(', '), full: `Workshop page (archived): requires ${dlc.join(', ')}` };
  }
  if (/\bREP(entance)?\s*\+|\bREP\+/i.test(text)) found.push('Rep+');
  if (/\[(?:[^\]]*\/)?REP(entance)?(?![+\w])|\bRepentance\b(?!\s*\+)/i.test(text)) found.push('Rep');
  if (/\bAB\+|\bAfterbirth\s*\+/i.test(text)) found.push('AB+');
  if (/repentogon/i.test(text)) found.push('REPENTOGON');
  if (!found.length) return null;
  return {
    short: found.join(', '),
    full: `From the mod's title/description (Isaac's Workshop has no version tags): ${found.join(', ')}`,
    guessed: true,
  };
}

/**
 * Newest numeric version tag that a real share of a game's mods carry (≥ 3 mods and ≥ 10% of tagged mods), so one
 * mis-tagged mod ("1.7" before 1.7 exists) doesn't make it the target. Null when there is none.
 */
export function latestVersionTag(mods: ModRecord[]): string | null {
  const counts = new Map<string, number>();
  let tagged = 0;
  for (const m of mods) {
    const nums = (m.gameVersionTags ?? []).filter((t) => Number.isFinite(Number(t)));
    if (nums.length) tagged += 1;
    for (const t of new Set(nums)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const need = Math.max(3, Math.ceil(tagged * 0.1));
  let best: string | null = null;
  for (const [t, n] of counts) if (n >= need && (best == null || Number(t) > Number(best))) best = t;
  return best;
}

/** True when the mod lists version tags but not `version` (it hasn't been updated for it). */
export function missesVersion(m: ModRecord, version: string): boolean {
  const tags = m.gameVersionTags ?? [];
  return tags.length > 0 && numericVersions(tags).length > 0 && !tags.includes(version);
}
