import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McInstance } from '../shared/types';
import { readNbt, replaceNbtString, worldInfo } from '../electron/nbt';
import { extractZip, zipFolder } from '../electron/zipUtil';
import {
  applyMcModList,
  backupWorld,
  itemPath,
  listMcContent,
  moveResourcePack,
  renameWorld,
  setActiveShader,
  setModEnabled,
  setResourcePackEnabled,
} from '../electron/mcContent';

/** A tiny level.dat: root { Data { LevelName, LastPlayed, GameType, Version { Name } } }, gzipped. */
function levelDat(name: string): Buffer {
  const parts: Buffer[] = [];
  const u8 = (n: number) => parts.push(Buffer.from([n]));
  const str = (s: string) => {
    const b = Buffer.from(s);
    const l = Buffer.alloc(2);
    l.writeUInt16BE(b.length);
    parts.push(l, b);
  };
  const tag = (t: number, n: string) => (u8(t), str(n));
  tag(10, '');
  tag(10, 'Data');
  tag(8, 'LevelName');
  str(name);
  tag(4, 'LastPlayed');
  const l = Buffer.alloc(8);
  l.writeBigInt64BE(1_700_000_000_000n);
  parts.push(l);
  tag(3, 'GameType');
  const i = Buffer.alloc(4);
  i.writeInt32BE(1);
  parts.push(i);
  tag(10, 'Version');
  tag(8, 'Name');
  str('1.21.8');
  u8(0);
  u8(0);
  u8(0);
  return zlib.gzipSync(Buffer.concat(parts));
}

let dir: string;
let inst: McInstance;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-mc-'));
  process.env.MODKEEPER_DATA_DIR = path.join(dir, 'data');
  const game = path.join(dir, 'game');
  for (const d of ['mods', 'resourcepacks', 'shaderpacks', 'saves/World A', 'config']) fs.mkdirSync(path.join(game, d), { recursive: true });
  fs.writeFileSync(path.join(game, 'mods', 'a.jar'), 'x');
  fs.writeFileSync(path.join(game, 'mods', 'b.jar.disabled'), 'x');
  fs.writeFileSync(path.join(game, 'resourcepacks', 'P1.zip'), 'x');
  fs.writeFileSync(path.join(game, 'resourcepacks', 'P2.zip'), 'x');
  fs.writeFileSync(path.join(game, 'shaderpacks', 'BSL.zip'), 'x');
  fs.writeFileSync(path.join(game, 'saves', 'World A', 'level.dat'), levelDat('Castle'));
  fs.writeFileSync(path.join(game, 'options.txt'), 'version:4440\nresourcePacks:["vanilla","file/P1.zip"]\nfov:0.0\n');
  inst = {
    id: 'prism:test',
    launcher: 'prism',
    launcherName: 'Prism Launcher',
    name: 'Test',
    gameDir: game,
    counts: { mods: 2, resourcepacks: 2, shaderpacks: 1, worlds: 1, screenshots: 0 },
    shaderLoader: 'iris',
    canLaunchDirect: true,
  };
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MODKEEPER_DATA_DIR;
});

describe('NBT', () => {
  it('reads level.dat', () => {
    expect(worldInfo(levelDat('Castle'))).toEqual({ levelName: 'Castle', lastPlayed: 1_700_000_000_000, gameMode: 'Creative', hardcore: false, cheats: false, version: '1.21.8' });
    expect(() => readNbt(Buffer.from([1, 2, 3]))).toThrow();
  });
});

describe('replaceNbtString', () => {
  it('changes only that string', () => {
    const before = zlib.gunzipSync(levelDat('Castle'));
    const after = zlib.gunzipSync(replaceNbtString(levelDat('Castle'), ['Data', 'LevelName'], 'Big Castle 🏰'));
    expect(worldInfo(after).levelName).toBe('Big Castle 🏰');
    const i = before.indexOf('Castle');
    expect(after.subarray(0, i - 2)).toEqual(before.subarray(0, i - 2));
    expect(after.subarray(after.length - (before.length - i - 6))).toEqual(before.subarray(i + 6));
    expect(() => replaceNbtString(levelDat('x'), ['Data', 'Nope'], 'y')).toThrow();
  });
});

describe('zip', () => {
  it('round-trips a folder and never extracts outside the target', () => {
    const src = path.join(dir, 'src');
    fs.mkdirSync(path.join(src, 'region'), { recursive: true });
    fs.writeFileSync(path.join(src, 'level.dat'), 'L'.repeat(5000));
    fs.writeFileSync(path.join(src, 'region', 'r.0.0.mca'), 'R');
    fs.writeFileSync(path.join(src, 'session.lock'), 'lock');
    const out = path.join(dir, 'w.zip');
    expect(zipFolder(src, out, 'My World').files).toBe(2);
    const dest = path.join(dir, 'dest');
    expect(extractZip(fs.readFileSync(out), dest, 'My World/')).toBe(2);
    expect(fs.readFileSync(path.join(dest, 'level.dat'), 'utf8')).toBe('L'.repeat(5000));
    expect(fs.readFileSync(path.join(dest, 'region', 'r.0.0.mca'), 'utf8')).toBe('R');
  });
});

describe('instance content', () => {
  it('lists mods, packs (with order), shaders and worlds', () => {
    expect(listMcContent(inst, 'mods').map((m) => [m.file, m.enabled])).toEqual([
      ['a.jar', true],
      ['b.jar', false],
    ]);
    expect(listMcContent(inst, 'resourcepacks').map((p) => [p.file, p.enabled, p.order])).toEqual([
      ['P1.zip', true, 0],
      ['P2.zip', false, undefined],
    ]);
    expect(listMcContent(inst, 'worlds')[0].title).toBe('Castle');
    expect(listMcContent(inst, 'shaderpacks')[0].active).toBe(false);
  });

  it('switches mods by renaming, and applies a modlist', () => {
    expect(setModEnabled(inst, 'b.jar', true).ok).toBe(true);
    expect(fs.existsSync(path.join(inst.gameDir, 'mods', 'b.jar'))).toBe(true);
    expect(applyMcModList(inst, ['b.jar', 'gone.jar'])).toMatchObject({ ok: true, switched: 1, missing: ['gone.jar'] });
    expect(fs.existsSync(path.join(inst.gameDir, 'mods', 'a.jar.disabled'))).toBe(true);
    expect(setModEnabled(inst, '../evil.jar', true).ok).toBe(false);
  });

  it('turns packs on at the top, reorders them, and keeps the rest of options.txt', () => {
    expect(setResourcePackEnabled(inst, 'P2.zip', true).ok).toBe(true);
    let opts = fs.readFileSync(path.join(inst.gameDir, 'options.txt'), 'utf8');
    expect(opts).toContain('resourcePacks:["vanilla","file/P1.zip","file/P2.zip"]');
    expect(opts).toContain('fov:0.0');
    expect(listMcContent(inst, 'resourcepacks').map((p) => p.file)).toEqual(['P2.zip', 'P1.zip']);
    expect(moveResourcePack(inst, 'P1.zip', -1).ok).toBe(true);
    opts = fs.readFileSync(path.join(inst.gameDir, 'options.txt'), 'utf8');
    expect(opts).toContain('resourcePacks:["vanilla","file/P2.zip","file/P1.zip"]');
    expect(setResourcePackEnabled(inst, 'P2.zip', false).ok).toBe(true);
    expect(fs.readFileSync(path.join(inst.gameDir, 'options.txt'), 'utf8')).toContain('resourcePacks:["vanilla","file/P1.zip"]');
  });

  it('sets the Iris shader pack, and turns shaders off', () => {
    expect(setActiveShader(inst, 'BSL.zip').ok).toBe(true);
    expect(listMcContent(inst, 'shaderpacks')[0].active).toBe(true);
    expect(setActiveShader(inst, null).ok).toBe(true);
    expect(listMcContent(inst, 'shaderpacks')[0].active).toBe(false);
    expect(fs.readFileSync(path.join(inst.gameDir, 'config', 'iris.properties'), 'utf8')).toContain('enableShaders=false');
  });

  it('backs up a world as a zip in ModKeeper data', () => {
    const r = backupWorld(inst, 'World A');
    expect(r.ok).toBe(true);
    expect(r.path!.startsWith(path.join(dir, 'data'))).toBe(true);
    expect(fs.existsSync(r.path!)).toBe(true);
  });

  it('renames a world, and its folder only when asked', () => {
    let r = renameWorld(inst, 'World A', 'Sky Base', false);
    expect(r).toMatchObject({ ok: true, file: 'World A' });
    expect(listMcContent(inst, 'worlds')[0].title).toBe('Sky Base');
    fs.mkdirSync(path.join(inst.gameDir, 'saves', 'Taken'));
    expect(renameWorld(inst, 'World A', 'Taken', true).ok).toBe(false);
    r = renameWorld(inst, 'World A', 'Sky: Base?', true);
    expect(r).toMatchObject({ ok: true, file: 'Sky_ Base_' });
    expect(listMcContent(inst, 'worlds')[0]).toMatchObject({ title: 'Sky: Base?', file: 'Sky_ Base_' });
    expect(fs.readdirSync(path.join(dir, 'data', 'backups', 'minecraft', 'Test', 'worlds')).length).toBe(2);
    expect(renameWorld(inst, 'Sky_ Base_', '   ', false).ok).toBe(false);
  });

  it('keeps names inside their folder', () => {
    expect(itemPath(inst, 'worlds', '..')).toBeUndefined();
    expect(itemPath(inst, 'mods', 'sub/x.jar')).toBeUndefined();
    expect(itemPath(inst, 'mods', 'x.jar')).toBe(path.join(inst.gameDir, 'mods', 'x.jar'));
  });
});
