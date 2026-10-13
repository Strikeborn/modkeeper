import { describe, expect, it } from 'vitest';
import { latestVersionTag, missesVersion } from '../src/utils/modVersions';
import { mod } from './helpers';

describe('game version gaps', () => {
  const a = mod({ id: 'a', gameId: 'rimworld', gameVersionTags: ['1.4', '1.5'] });
  const b = mod({ id: 'b', gameId: 'rimworld', gameVersionTags: ['1.5', '1.6'] });
  const c = mod({ id: 'c', gameId: 'rimworld' });

  it('finds the newest version a real share of mods carry, ignoring one-off future tags', () => {
    const many = Array.from({ length: 10 }, (_, i) => mod({ id: `m${i}`, gameId: 'rimworld', gameVersionTags: i < 6 ? ['1.5', '1.6'] : ['1.5'] }));
    const odd = mod({ id: 'odd', gameId: 'rimworld', gameVersionTags: ['1.6', '1.7'] });
    expect(latestVersionTag([...many, odd, c])).toBe('1.6');
    expect(latestVersionTag([a, b, c])).toBeNull(); // too few mods to tell
    expect(latestVersionTag([c])).toBeNull();
  });

  it('flags mods tagged for older versions only, not untagged ones', () => {
    expect(missesVersion(a, '1.6')).toBe(true);
    expect(missesVersion(b, '1.6')).toBe(false);
    expect(missesVersion(c, '1.6')).toBe(false);
    expect(missesVersion(mod({ id: 'd', gameId: 'project-zomboid', gameVersionTags: ['Build 41'] }), '42')).toBe(false);
  });
});
