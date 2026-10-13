import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// "Is Ship running?" calls tasklist; tests must not depend on what's open on this PC.
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: () => '',
}));
import { addShipMods, describePcPort, listShipMods, setShipModEnabled } from '../electron/pcPorts';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-ports-'));
  process.env.MODKEEPER_DATA_DIR = path.join(dir, 'data');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MODKEEPER_DATA_DIR;
});

describe('Ship of Harkinian mods', () => {
  it('lists, switches off/on and adds packs', () => {
    fs.mkdirSync(path.join(dir, 'mods'));
    fs.writeFileSync(path.join(dir, 'mods', 'a.o2r'), 'x');
    expect(listShipMods({ id: 'soh', dir }).map((m) => [m.file, m.enabled])).toEqual([['a.o2r', true]]);

    expect(setShipModEnabled({ id: 'soh', dir }, path.join(dir, 'mods', 'a.o2r'), false).ok).toBe(true);
    expect(listShipMods({ id: 'soh', dir })[0].enabled).toBe(false);
    expect(fs.existsSync(path.join(dir, 'mods-disabled', 'a.o2r'))).toBe(true);
    expect(setShipModEnabled({ id: 'soh', dir }, path.join(dir, 'mods-disabled', 'a.o2r'), true).ok).toBe(true);

    const src = path.join(dir, 'dl');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'b.otr'), 'y');
    fs.writeFileSync(path.join(src, 'c.zip'), 'z');
    const r = addShipMods({ id: 'soh', dir }, [path.join(src, 'b.otr'), path.join(src, 'c.zip'), path.join(dir, 'mods', 'a.o2r')]);
    expect(r.added).toBe(1);
    expect(r.skipped).toHaveLength(2);
  });

  it('refuses paths outside its folders', () => {
    fs.writeFileSync(path.join(dir, 'x.o2r'), 'x');
    expect(setShipModEnabled({ id: 'soh', dir }, path.join(dir, 'x.o2r'), false).ok).toBe(false);
  });
});

describe('describePcPort', () => {
  it('recognises a Picori checkout and its built copies', () => {
    for (const f of ['build.py', 'xmake.lua']) fs.writeFileSync(path.join(dir, f), '');
    fs.mkdirSync(path.join(dir, 'port'));
    fs.mkdirSync(path.join(dir, 'dist', 'USA'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'USA', 'tmc_pc.exe'), '');
    const p = describePcPort(dir)!;
    expect(p.kind).toBe('picori');
    expect(p.targets.map((t) => t.label)).toEqual(['USA']);
    expect(p.buildRegions).toEqual(['USA']);
  });
  it('ignores other folders', () => {
    expect(describePcPort(dir)).toBeNull();
  });
});
