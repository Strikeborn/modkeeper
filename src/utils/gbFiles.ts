import type { GbFile } from '@shared/types';

const OUTDATED = /\b(outdated|old|legacy|deprecated|obsolete)\b/i;

/**
 * Files to pre-tick when a GameBanana mod has several: everything uploaded on the newest upload day (a model and its
 * matching equipment usually come together) except files the author marks outdated or old. Falls back to the newest file.
 */
export function defaultGbFiles(files: GbFile[]): number[] {
  const usable = files.filter((f) => f.avResult !== 'infected');
  if (usable.length <= 1) return usable.map((f) => f.id);
  const day = (f: GbFile) => (f.added ? new Date(f.added * 1000).toDateString() : '');
  const newest = [...usable].sort((a, b) => (b.added ?? 0) - (a.added ?? 0))[0];
  const picks = usable.filter((f) => day(f) === day(newest) && !OUTDATED.test(`${f.description ?? ''} ${f.name}`));
  return (picks.length ? picks : [newest]).map((f) => f.id);
}
