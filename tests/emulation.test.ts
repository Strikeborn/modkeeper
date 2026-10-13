import { describe, expect, it } from 'vitest';
import { detectHack, parseRomName } from '../electron/emulation';

/** A fake GBA image: header title/code plus optional text in the body (no real ROM data). */
function gba(title: string, code: string, body = ''): Buffer {
  const b = Buffer.alloc(0x1000);
  b.write(title.padEnd(12, '\0'), 0xa0, 'latin1');
  b.write(code, 0xac, 'latin1');
  b.write(body, 0x400, 'latin1');
  return b;
}

describe('parseRomName', () => {
  it('splits No-Intro names', () => {
    expect(parseRomName('Legend of Zelda, The - The Minish Cap (USA).gba')).toEqual({
      title: 'The Legend of Zelda - The Minish Cap',
      region: 'USA',
      tags: [],
    });
    const p = parseRomName('Legend of Zelda, The - Ocarina of Time (U) (V1.2) [!].z64');
    expect(p.region).toBe('USA');
    expect(p.tags).toEqual(['V1.2', '!']);
    expect(parseRomName('1758 - The Legend of Zelda - The Minish Cap (E)(Independent).gba').title).toBe(
      'The Legend of Zelda - The Minish Cap',
    );
  });
});

describe('detectHack', () => {
  it('names a Pokémon hack from its internal name and keeps the base from the game code', () => {
    const h = detectHack(gba('POKEMON EMER', 'BPEE', 'pokemon emerald version\0pokemon emerald rogue version'), 'GBA', 'x.gba');
    expect(h?.name).toBe('Pokémon Emerald Rogue');
    expect(h?.base).toBe('Pokémon Emerald Version (USA, Europe)');
    expect(h?.source).toBe('detected');
  });

  it('names a hack with its own game code from the header, base from the engine inside', () => {
    const h = detectHack(gba('ULTRA VIOLET', 'PUVV', 'pokemon red version'), 'GBA', 'x.gba');
    expect(h?.name).toBe('Ultra Violet');
    expect(h?.base).toBe('Pokémon FireRed Version (USA)');
  });

  it('leaves retail ROMs alone', () => {
    expect(detectHack(gba('POKEMON EMER', 'BPEE', 'pokemon emerald version'), 'GBA', 'Pokemon - Emerald Version (USA, Europe).gba')).toBeUndefined();
    expect(detectHack(gba('GBAZELDA MC', 'BZME'), 'GBA', 'Minish Cap (USA).gba')).toBeUndefined();
  });

  it('flags a [patched] copy of a retail game', () => {
    expect(detectHack(gba('GBAZELDA MC', 'BZME'), 'GBA', 'Minish Cap (USA) [patched].gba')).toMatchObject({
      kind: 'patch',
      base: 'The Legend of Zelda: The Minish Cap (USA)',
    });
  });

  it('recognises an ALttP Randomizer seed from the SNES header', () => {
    const b = Buffer.alloc(0x8000);
    b.write('VT 29MQpxzdGD        ', 0x7fc0, 'latin1');
    expect(detectHack(b, 'SNES', 'seed.sfc')).toMatchObject({ kind: 'randomizer', name: 'A Link to the Past Randomizer (seed 29MQpxzdGD)' });
  });
});
