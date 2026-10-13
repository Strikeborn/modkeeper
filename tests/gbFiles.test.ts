import { describe, expect, it } from 'vitest';
import { defaultGbFiles } from '../src/utils/gbFiles';
import type { GbFile } from '../shared/types';

const day = (d: string, h = 12) => Math.floor(new Date(`${d}T${String(h).padStart(2, '0')}:00:00`).getTime() / 1000);
const f = (id: number, added: number, description = '', avResult = 'clean'): GbFile => ({ id, name: `f${id}.zip`, size: 1, url: 'u', added, description, avResult });

describe('defaultGbFiles', () => {
  it('ticks the model and its equipment from the newest upload day, not outdated files', () => {
    // Playas 3DS Malon (Heroine): two files on 2026-09-12, older fixes and an outdated original.
    const files = [
      f(1, day('2026-09-12', 15), '(2026) Alt Equipment Update'),
      f(2, day('2026-09-12', 16), 'Similar to Link 3DS Equipment but lined up for Malon'),
      f(3, day('2026-09-11'), '(2026) Alt Equipment Update [Fix]'),
      f(4, day('2024-09-09'), 'Old Fix (Outdated)'),
    ];
    expect(defaultGbFiles(files).sort()).toEqual([1, 2]);
  });
  it('one file: that file', () => {
    expect(defaultGbFiles([f(9, day('2025-01-01'))])).toEqual([9]);
  });
  it('never picks a file GameBanana flags as infected', () => {
    expect(defaultGbFiles([f(1, day('2026-01-02'), '', 'infected'), f(2, day('2026-01-01'))])).toEqual([2]);
  });
});
