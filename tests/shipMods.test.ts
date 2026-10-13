import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addShipMods,
  applyShipModList,
  listShipMods,
  moveShipMod,
  readShipConfig,
  renameShipMod,
  setJsonValue,
  setShipAltAssets,
  setShipModEnabled,
} from '../electron/pcPorts';
import { packEntries, packHasAltAssets } from '../electron/packList';

/** A minimal stored zip holding these names (empty files). */
function zip(names: string[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const n of names) {
    const name = Buffer.from(n);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name);
    central.push(ch, name);
    offset += 30 + name.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const CONFIG = `{
    "CVars": {
        "gAudioEditor": {
            "Volume": 1.0
        },
        "gSettings": {
            "AltAssets": 0,
            "EnabledMods": "b|a"
        }
    },
    "Window": {}
}
`;

let dir: string;
let port: { id: 'soh'; dir: string };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-ship-'));
  process.env.MODKEEPER_DATA_DIR = path.join(dir, 'data');
  fs.mkdirSync(path.join(dir, 'mods'));
  fs.mkdirSync(path.join(dir, 'mods-disabled'));
  fs.writeFileSync(path.join(dir, 'mods', 'a.o2r'), zip(['alt/objects/x']));
  fs.writeFileSync(path.join(dir, 'mods', 'b.o2r'), zip(['objects/y']));
  fs.writeFileSync(path.join(dir, 'mods', 'c.o2r'), zip(['objects/z']));
  fs.writeFileSync(path.join(dir, 'mods-disabled', 'd.o2r'), zip(['alt/q']));
  fs.writeFileSync(path.join(dir, 'shipofharkinian.json'), CONFIG);
  port = { id: 'soh', dir };
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MODKEEPER_DATA_DIR;
});

describe('setJsonValue', () => {
  it('changes only the value, keeping 1.0 and the layout', () => {
    const out = setJsonValue(CONFIG, ['CVars', 'gSettings', 'AltAssets'], '1');
    expect(out).toBe(CONFIG.replace('"AltAssets": 0', '"AltAssets": 1'));
    expect(out).toContain('"Volume": 1.0');
  });
  it('adds a missing key with the same indent', () => {
    const out = setJsonValue(CONFIG, ['CVars', 'gSettings', 'New'], '"x"');
    expect(out).toContain('"gSettings": {\n            "New": "x",\n            "AltAssets": 0');
    expect(JSON.parse(out).CVars.gSettings.New).toBe('x');
  });
  it('creates missing objects', () => {
    const out = setJsonValue('{\n    "CVars": {}\n}\n', ['CVars', 'gSettings', 'EnabledMods'], '"a"');
    expect(JSON.parse(out).CVars.gSettings.EnabledMods).toBe('a');
  });
});

describe('Ship packs', () => {
  it('lists on packs in Ship order (unlisted at the bottom) with the alt marker', () => {
    const mods = listShipMods(port);
    expect(mods.map((m) => `${m.file}:${m.enabled}:${m.order ?? '-'}:${m.alt}`)).toEqual([
      'b.o2r:true:0:false',
      'a.o2r:true:1:true',
      'c.o2r:true:2:false',
      'd.o2r:false:-:true',
    ]);
  });

  it('switching on moves the pack in and puts it on top; off takes it out of the list', () => {
    expect(setShipModEnabled(port, path.join(dir, 'mods-disabled', 'd.o2r'), true).ok).toBe(true);
    expect(readShipConfig(port).enabled).toEqual(['d', 'b', 'a', 'c']);
    expect(setShipModEnabled(port, path.join(dir, 'mods', 'b.o2r'), false).ok).toBe(true);
    expect(readShipConfig(port).enabled).toEqual(['d', 'a', 'c']);
    expect(fs.existsSync(path.join(dir, 'mods-disabled', 'b.o2r'))).toBe(true);
    // the rest of Ship's settings are untouched
    expect(fs.readFileSync(path.join(dir, 'shipofharkinian.json'), 'utf8')).toContain('"Volume": 1.0');
  });

  it('reorders, renames and sets alternate assets', () => {
    expect(moveShipMod(port, path.join(dir, 'mods', 'a.o2r'), -1).ok).toBe(true);
    expect(readShipConfig(port).enabled).toEqual(['a', 'b', 'c']);
    const r = renameShipMod(port, path.join(dir, 'mods', 'a.o2r'), 'Alpha');
    expect(r.file).toBe('Alpha.o2r');
    expect(readShipConfig(port).enabled).toEqual(['Alpha', 'b', 'c']);
    expect(renameShipMod(port, path.join(dir, 'mods', 'b.o2r'), 'd').ok).toBe(false); // d is installed (off)
    expect(renameShipMod(port, path.join(dir, 'mods', 'b.o2r'), 'x|y').ok).toBe(false);
    expect(setShipAltAssets(port, true).ok).toBe(true);
    expect(readShipConfig(port).altAssets).toBe(true);
  });

  it('adds new packs at the top and never overwrites', () => {
    const src = path.join(dir, 'new.o2r');
    fs.writeFileSync(src, zip(['x']));
    fs.copyFileSync(path.join(dir, 'mods', 'a.o2r'), path.join(dir, 'a-copy.o2r'));
    const r = addShipMods(port, [src, path.join(dir, 'mods-disabled', 'd.o2r')]);
    expect(r.addedFiles).toEqual(['new.o2r']);
    expect(r.skipped[0]).toContain('already installed');
    expect(readShipConfig(port).enabled[0]).toBe('new');
  });

  it('applies a modlist: exactly its packs, in its order', () => {
    const r = applyShipModList(port, ['d.o2r', 'c.o2r', 'gone.o2r']);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual(['gone.o2r']);
    expect(readShipConfig(port).enabled).toEqual(['d', 'c']);
    expect(listShipMods(port).filter((m) => m.enabled).map((m) => m.file)).toEqual(['d.o2r', 'c.o2r']);
  });

  it('backs up the config before changing it', () => {
    setShipAltAssets(port, true);
    const backups = fs.readdirSync(path.join(dir, 'data', 'backups', 'ship'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, 'data', 'backups', 'ship', backups[0]), 'utf8')).toBe(CONFIG);
  });
});

describe('other ports', () => {
  it('2Ship keeps the same list but its own alternate-assets setting', () => {
    fs.renameSync(path.join(dir, 'shipofharkinian.json'), path.join(dir, '2ship2harkinian.json'));
    const two = { id: '2ship' as const, dir };
    expect(setShipAltAssets(two, true).ok).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, '2ship2harkinian.json'), 'utf8'));
    expect(cfg.CVars.gEnhancements.Mods.AlternateAssets).toBe(1);
    expect(cfg.CVars.gSettings.AltAssets).toBe(0);
    expect(readShipConfig(two).enabled).toEqual(['b', 'a']);
  });
  it('Starship has no list: packs load A to Z and switching only moves files', () => {
    fs.renameSync(path.join(dir, 'shipofharkinian.json'), path.join(dir, 'starship.cfg.json'));
    const star = { id: 'starship' as const, dir };
    expect(listShipMods(star).filter((m) => m.enabled).map((m) => m.file)).toEqual(['a.o2r', 'b.o2r', 'c.o2r']);
    const before = fs.readFileSync(path.join(dir, 'starship.cfg.json'), 'utf8');
    expect(setShipModEnabled(star, path.join(dir, 'mods', 'a.o2r'), false).ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'starship.cfg.json'), 'utf8')).toBe(before);
    expect(moveShipMod(star, path.join(dir, 'mods', 'b.o2r'), 1).ok).toBe(false);
  });
});

describe('packEntries', () => {
  it('reads zip packs', () => {
    const f = path.join(dir, 'mods', 'a.o2r');
    expect(packEntries(f)).toEqual(['alt/objects/x']);
    expect(packHasAltAssets(path.join(dir, 'mods', 'b.o2r'))).toBe(false);
  });
  it('returns undefined for something that is not a pack', () => {
    const f = path.join(dir, 'junk.otr');
    fs.writeFileSync(f, zlib.deflateSync(Buffer.alloc(100)));
    expect(packEntries(f)).toBeUndefined();
  });
});
