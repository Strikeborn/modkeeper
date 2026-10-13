import { describe, expect, it } from 'vitest';
import { bestMatch, looseName, newerFile } from '../electron/shipUpdates';
import type { GbFile } from '../shared/types';

const file = (id: number, name: string, added: number): GbFile => ({ id, name, size: 1, url: `https://x/${id}`, added });

describe('looseName', () => {
  it('drops versions, years, extensions and punctuation', () => {
    expect(looseName('3ds_Hero_Malon_(2026).otr')).toBe('3ds hero malon');
    expect(looseName('Malon v1.2.3.zip')).toBe('malon');
    expect(looseName('KinRupee.o2r')).toBe('kinrupee');
  });
});

describe('bestMatch', () => {
  const names = ['3ds_hero_malon.otr', '3ds_hero_malon_equipment.o2r'];
  it('prefers the same loose name', () => {
    expect(bestMatch(names, '3ds_hero_malon_(2026).otr', (s) => s)).toBe('3ds_hero_malon.otr');
    expect(bestMatch(names, '3ds_hero_malon_equipment_v2.o2r', (s) => s)).toBe('3ds_hero_malon_equipment.o2r');
  });
  it('takes the only candidate', () => {
    expect(bestMatch(['anything.o2r'], 'other.o2r', (s) => s)).toBe('anything.o2r');
  });
  it('gives up when it is a tie', () => {
    expect(bestMatch(['abc_one.o2r', 'abc_two.o2r'], 'xyz.o2r', (s) => s)).toBeUndefined();
  });
});

describe('newerFile', () => {
  it('finds a later upload of the same file', () => {
    const files = [file(1, 'malon_v1.zip', 100), file(2, 'malon_equipment.zip', 9000), file(3, 'malon_v2.zip', 9000)];
    expect(newerFile(files, { modId: 9, fileId: 1, fileName: 'malon_v1.zip', fileAdded: 100 })?.id).toBe(3);
  });
  it('skips files from the same release, or installed for another pack', () => {
    const files = [file(1, 'malon_model.zip', 100), file(2, 'malon_equipment.zip', 300), file(3, 'malon_hands.zip', 9000)];
    expect(newerFile(files, { modId: 9, fileId: 1, fileName: 'malon_model.zip', fileAdded: 100 }, new Set([3]))).toBeUndefined();
  });
  it('none when nothing is newer, or the install time is unknown', () => {
    const files = [file(1, 'malon.zip', 100)];
    expect(newerFile(files, { modId: 9, fileId: 1, fileName: 'malon.zip', fileAdded: 100 })).toBeUndefined();
    expect(newerFile([file(2, 'malon.zip', 9000)], { modId: 9, fileName: 'malon.zip' })).toBeUndefined();
  });
});
