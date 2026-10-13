/**
 * Emulation library: ROMs by system, the emulators that play them (RetroArch cores, BizHawk,
 * Ship of Harkinian), their saves/states, Ship of Harkinian mods and which folders Syncthing
 * shares. Read-only, apart from launching a game on the user's click.
 *
 * Layout this expects (the user's library, default Desktop\Games\Emulators):
 *   ROMs\<SYSTEM>\*.gba|sfc|smc|nes|z64...   RetroArch\retroarch.exe + cores\*.dll + saves\<SYSTEM> + States\<SYSTEM>
 *   Hawk\EmuHawk.exe   Ship\<build>\soh.exe + mods\   LiveSplit\...
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import type { EmulationLibrary, EmulationRom, EmulatorInfo, ModPortId, ModPortMods, RomHackInfo, SyncedFolder } from '../shared/types';
import { describePcPort, listShipMods, MOD_PORTS, portHasList, shipAltAssets } from './pcPorts';

/** PC ports that take Ship-style mod packs, found by their exe one folder below a library folder. */
const PORT_EXES: { id: ModPortId; exe: string; label: string }[] = [
  { id: 'soh', exe: 'soh.exe', label: 'Ship of Harkinian (Ocarina of Time PC port)' },
  { id: '2ship', exe: '2ship.exe', label: "2 Ship 2 Harkinian (Majora's Mask PC port)" },
  { id: 'starship', exe: 'Starship.exe', label: 'Starship (Star Fox 64 PC port)' },
];

/** Retail GBA game codes (header 0xAC) -> the game, so a hack keeping its base's code names it. */
const GBA_CODES: Record<string, string> = {
  BPEE: 'Pokémon Emerald Version (USA, Europe)',
  BPRE: 'Pokémon FireRed Version (USA)',
  BPGE: 'Pokémon LeafGreen Version (USA)',
  AXVE: 'Pokémon Ruby Version (USA)',
  AXPE: 'Pokémon Sapphire Version (USA)',
  BZME: 'The Legend of Zelda: The Minish Cap (USA)',
  BZMP: 'The Legend of Zelda: The Minish Cap (Europe)',
  BZMJ: 'Zelda no Densetsu: Fushigi no Boushi (Japan)',
  AZLE: 'The Legend of Zelda: A Link to the Past & Four Swords (USA)',
};
/** Retail Pokémon names as stored in the ROM: anything else of that form is a hack's own name. */
const RETAIL_POKEMON = /^pokemon (emerald|ruby|sapphire|fire ?red|leaf ?green|red|blue|green|gold|silver|crystal) version$/;

/** What the ROM itself says about being a hack (header, randomizer tag, internal name). */
export function detectHack(buf: Buffer, system: string, file: string): RomHackInfo | undefined {
  if (system === 'GBA' && buf.length > 0xb0) {
    const code = buf.toString('latin1', 0xac, 0xb0);
    const title = buf.toString('latin1', 0xa0, 0xac).replace(/\0+$/, '').trim();
    // internal "pokemon xxx version" strings: a hack's own name besides the retail one
    const names = new Set<string>();
    for (const m of buf.toString('latin1').matchAll(/pokemon [a-z ]{2,24} version/g)) names.add(m[0]);
    const own = [...names].find((n) => !RETAIL_POKEMON.test(n));
    const base = GBA_CODES[code];
    if (own) {
      const pretty = own.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/^Pokemon/, 'Pokémon').replace(/ Version$/, '');
      return { name: pretty, kind: 'hack', base, source: 'detected' };
    }
    if (!base && /^[A-Z0-9 ]+$/.test(title) && title && !/^POKEMON/.test(title)) {
      // an unknown game code with a Pokémon engine inside: a hack named by its header
      if ([...names].length) {
        const engine = [...names][0].includes('red') ? GBA_CODES.BPRE : [...names][0].includes('emerald') ? GBA_CODES.BPEE : undefined;
        return { name: title.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()), kind: 'hack', base: engine, source: 'detected' };
      }
    }
    if (/\[(patched|hack)\]/i.test(file)) return { kind: 'patch', base, source: 'detected' };
  }
  if (system === 'SNES' && buf.length > 0x7fd5) {
    const hdr = buf.toString('latin1', 0x7fc0, 0x7fd5);
    const vt = /^VT ([A-Za-z0-9]{6,})/.exec(hdr); // ALttP Randomizer stamps "VT <seed>"
    if (vt)
      return {
        name: `A Link to the Past Randomizer (seed ${vt[1]})`,
        kind: 'randomizer',
        base: 'The Legend of Zelda: A Link to the Past (Japan 1.0)',
        url: 'https://alttpr.com',
        source: 'detected',
      };
  }
  return undefined;
}

/** romhacks.json in the library root: the user's curated hack details, by sha1 or file name. */
function loadRomHacks(root: string): { sha1?: string; file?: string; info: RomHackInfo }[] {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'romhacks.json'), 'utf8'));
    return (Array.isArray(j?.hacks) ? j.hacks : []).map((h: Record<string, string>) => ({
      sha1: h.sha1?.toLowerCase(),
      file: h.file?.toLowerCase(),
      info: {
        name: h.name, author: h.author, version: h.version, base: h.base, url: h.url, notes: h.notes,
        kind: (h.kind as RomHackInfo['kind']) ?? 'hack',
        source: 'romhacks.json' as const,
      },
    }));
  } catch {
    return [];
  }
}

const ROM_EXT: Record<string, string> = {
  '.gba': 'GBA', '.gb': 'GB', '.gbc': 'GBC', '.nes': 'NES', '.sfc': 'SNES', '.smc': 'SNES',
  '.z64': 'N64', '.n64': 'N64', '.v64': 'N64', '.nds': 'NDS', '.md': 'Genesis', '.gen': 'Genesis',
};
const SYSTEM_NAMES: Record<string, string> = {
  GBA: 'Game Boy Advance', GB: 'Game Boy', GBC: 'Game Boy Color', NES: 'NES', SNES: 'Super Nintendo',
  N64: 'Nintendo 64', NDS: 'Nintendo DS', Genesis: 'Genesis / Mega Drive',
};
/** RetroArch core per system, best first (only installed ones are offered). */
const CORE_PREFS: Record<string, string[]> = {
  GBA: ['mgba', 'vba_next', 'gpsp'],
  GB: ['gambatte', 'mgba', 'sameboy'],
  GBC: ['gambatte', 'mgba', 'sameboy'],
  NES: ['mesen', 'nestopia', 'fceumm'],
  SNES: ['bsnes2014_accuracy', 'bsnes', 'snes9x'],
  N64: ['mupen64plus_next', 'parallel_n64'],
  NDS: ['melonds', 'desmume'],
  Genesis: ['genesis_plus_gx', 'picodrive'],
};

export function defaultEmulationRoot(): string {
  return path.join(os.homedir(), 'Desktop', 'Games', 'Emulators');
}

/** "Legend of Zelda, The - The Minish Cap (USA) [!]" -> title, region, tags. */
export function parseRomName(file: string): { title: string; region?: string; tags: string[] } {
  const base = file.replace(/\.[^.]+$/, '');
  const tags: string[] = [];
  let region: string | undefined;
  const title = base
    .replace(/^\d{3,5}\s+-\s+/, '') // "1758 - " release numbers
    .replace(/\s*[([][^)\]]*[)\]]/g, (m) => {
      const t = m.trim().slice(1, -1).trim();
      if (!region && /^(USA|Europe|Japan|World|Australia|Germany|France|Spain|Italy|Korea|U|E|J|UE|USA, Europe|USA, Australia)$/i.test(t)) {
        region = { U: 'USA', E: 'Europe', J: 'Japan', UE: 'USA, Europe' }[t.toUpperCase()] ?? t;
      } else {
        tags.push(t);
      }
      return '';
    })
    .replace(/^(.*), The( - |$)/, 'The $1$2')
    .trim();
  return { title, region, tags };
}

type HashCache = Record<string, { size: number; mtime: number; sha1: string; hack?: RomHackInfo | null }>;

function walk(dir: string, depth: number, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0 && !e.name.startsWith('.')) walk(full, depth - 1, out);
    } else if (ROM_EXT[path.extname(e.name).toLowerCase()]) {
      out.push(full);
    }
  }
}

/** RetroArch's paths, from retroarch.cfg (":" = the RetroArch folder). */
function retroarchDirs(raDir: string): { saves: string; states: string; sortByContent: boolean; sortByCore: boolean } {
  const cfg: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(path.join(raDir, 'retroarch.cfg'), 'utf8').split(/\r?\n/)) {
      const m = /^(\w+)\s*=\s*"(.*)"\s*$/.exec(line);
      if (m) cfg[m[1]] = m[2];
    }
  } catch {
    /* defaults below */
  }
  const resolve = (v: string | undefined, fallback: string) =>
    !v || v === 'default' ? path.join(raDir, fallback) : v.startsWith(':') ? path.join(raDir, v.slice(1).replace(/^[\\/]/, '')) : v;
  return {
    saves: resolve(cfg.savefile_directory, 'saves'),
    states: resolve(cfg.savestate_directory, 'states'),
    sortByContent: cfg.sort_savefiles_by_content_enable === 'true',
    sortByCore: cfg.sort_savefiles_enable === 'true',
  };
}

function findEmulators(root: string): { emulators: EmulatorInfo[]; raDir?: string; cores: string[] } {
  const emulators: EmulatorInfo[] = [];
  let raDir: string | undefined;
  let cores: string[] = [];
  for (const name of safeList(root)) {
    const dir = path.join(root, name);
    if (fs.existsSync(path.join(dir, 'retroarch.exe'))) {
      raDir = dir;
      cores = safeList(path.join(dir, 'cores'))
        .filter((f) => f.endsWith('_libretro.dll'))
        .map((f) => f.replace(/_libretro\.dll$/, ''));
      emulators.push({ id: 'retroarch', name: 'RetroArch', exe: path.join(dir, 'retroarch.exe'), dir, detail: `cores: ${cores.join(', ') || 'none'}` });
    } else if (fs.existsSync(path.join(dir, 'EmuHawk.exe'))) {
      emulators.push({ id: 'bizhawk', name: 'BizHawk', exe: path.join(dir, 'EmuHawk.exe'), dir });
    } else {
      // Ship of Harkinian (and other PC ports) sit one folder down: Ship\SoH-...\soh.exe
      for (const sub of [dir, ...safeList(dir).map((s) => path.join(dir, s))]) {
        const port = PORT_EXES.find((p) => fs.existsSync(path.join(sub, p.exe)) && !emulators.some((e) => e.id === p.id));
        if (port) {
          emulators.push({ id: port.id, name: port.label, exe: path.join(sub, port.exe), dir: sub });
          break;
        }
        const ls = safeList(sub).find((f) => /^LiveSplit\.exe$/i.test(f));
        if (ls) {
          emulators.push({ id: 'livesplit', name: 'LiveSplit (speedrun timer)', exe: path.join(sub, ls), dir: sub });
          break;
        }
      }
    }
  }
  return { emulators, raDir, cores };
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Folders Syncthing shares that sit inside the library (read from its config, no API calls). */
function syncthingFolders(root: string): SyncedFolder[] {
  const cfgPath = [
    path.join(process.env.LOCALAPPDATA ?? '', 'Syncthing', 'config.xml'),
    path.join(process.env.APPDATA ?? '', 'Syncthing', 'config.xml'),
  ].find((p) => fs.existsSync(p));
  if (!cfgPath) return [];
  const xml = fs.readFileSync(cfgPath, 'utf8');
  const names = new Map<string, string>();
  for (const m of xml.matchAll(/<device id="([^"]+)" name="([^"]*)"/g)) names.set(m[1], m[2]);
  const rootNorm = path.normalize(root).toLowerCase();
  const out: SyncedFolder[] = [];
  for (const m of xml.matchAll(/<folder ([^>]*)>([\s\S]*?)<\/folder>/g)) {
    const attr = (k: string) => new RegExp(`${k}="([^"]*)"`).exec(m[1])?.[1] ?? '';
    const id = attr('id');
    const p = path.normalize(attr('path'));
    if (!id || !p.toLowerCase().startsWith(rootNorm)) continue;
    const devices = [...m[2].matchAll(/<device id="([^"]+)"/g)].map((d) => names.get(d[1]) ?? d[1].slice(0, 7)).filter((n) => n !== os.hostname());
    out.push({ label: attr('label') || id, path: p, devices: [...new Set(devices)] });
  }
  return out;
}

export async function scanEmulationLibrary(root: string, cacheDir: string, pcPortFolders: string[] = []): Promise<EmulationLibrary> {
  const pcPorts = pcPortFolders.map((d) => describePcPort(d)).filter((p): p is NonNullable<typeof p> => !!p);
  const cacheFile = path.join(cacheDir, 'emulation-hashes.json');
  let cache: HashCache = {};
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {
    /* first run */
  }
  if (!fs.existsSync(root)) {
    return { root, exists: false, roms: [], emulators: [], synced: [], sohMods: [], modPorts: [], pcPorts, systems: {} };
  }
  const { emulators, raDir, cores } = findEmulators(root);
  const ra = raDir ? retroarchDirs(raDir) : undefined;

  const files: string[] = [];
  walk(path.join(root, 'ROMs'), 3, files);
  for (const emu of emulators.filter((e) => e.id === 'bizhawk')) walk(emu.dir, 3, files); // BizHawk keeps its own (e.g. randomizer seeds)

  const roms: EmulationRom[] = [];
  const nextCache: HashCache = {};
  for (const file of files) {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    const system = ROM_EXT[path.extname(file).toLowerCase()];
    const prev = cache[file];
    const fresh = !!prev && prev.size === st.size && prev.mtime === st.mtimeMs && prev.hack !== undefined;
    let sha1 = fresh ? prev.sha1 : '';
    let detected: RomHackInfo | null = fresh ? (prev.hack ?? null) : null;
    if (!fresh) {
      try {
        const buf = await fs.promises.readFile(file); // ROMs are small (<= 64 MB)
        sha1 = crypto.createHash('sha1').update(buf).digest('hex');
        detected = detectHack(buf, system, path.basename(file)) ?? null;
      } catch {
        sha1 = '';
      }
    }
    nextCache[file] = { size: st.size, mtime: st.mtimeMs, sha1, hack: detected };
    const base = path.basename(file).replace(/\.[^.]+$/, '');
    const parsed = parseRomName(path.basename(file));
    // RetroArch saves/states: sorted into a folder named after the content folder (GBA) and,
    // inside it, one per core (mGBA, Mupen64Plus-Next...), so look in each core folder
    const contentDir = path.basename(path.dirname(file));
    const dirsUnder = (top: string): string[] => {
      const d = ra?.sortByContent ? path.join(top, contentDir) : top;
      return [d, ...safeList(d).map((x) => path.join(d, x)).filter((x) => isDir(x))];
    };
    const saveDirs = ra ? dirsUnder(ra.saves) : [];
    const hasSave = saveDirs.some((d) => fs.existsSync(path.join(d, `${base}.srm`)));
    const stateFiles = ra
      ? dirsUnder(ra.states).flatMap((d) =>
          safeList(d)
            .filter((f) => f.startsWith(`${base}.state`) && !f.endsWith('.png'))
            .map((f) => path.join(d, f)),
        )
      : [];
    const states = stateFiles;
    const lastState = stateFiles.map((f) => fs.statSync(f).mtimeMs).reduce((a, b) => Math.max(a, b), 0);
    const inBizHawk = emulators.some((e) => e.id === 'bizhawk' && file.toLowerCase().startsWith(e.dir.toLowerCase() + path.sep));
    roms.push({
      path: file,
      file: path.basename(file),
      system,
      title: parsed.title,
      region: parsed.region,
      tags: parsed.tags,
      hack: !!detected || parsed.tags.some((t) => /patched|hack|rando/i.test(t)) || /randomizer|^alttpr/i.test(base),
      hackInfo: detected ?? undefined,
      sizeBytes: st.size,
      sha1,
      location: inBizHawk ? 'bizhawk' : 'library',
      devices: ['PC'],
      where: file.toLowerCase().startsWith(path.join(root, 'ROMs').toLowerCase() + path.sep) ? 'roms' : 'pc',
      hasSave,
      stateCount: states.length,
      lastPlayed: lastState ? new Date(lastState).toISOString() : undefined,
    });
  }
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(nextCache));
  } catch {
    /* cache is optional */
  }
  // the same content more than once (e.g. two dumps with identical bytes)
  const bySha = new Map<string, number>();
  for (const r of roms) if (r.sha1) bySha.set(r.sha1, (bySha.get(r.sha1) ?? 0) + 1);
  for (const r of roms) r.duplicateCount = r.sha1 ? (bySha.get(r.sha1) ?? 1) - 1 : 0;

  const systems: EmulationLibrary['systems'] = {};
  for (const sys of new Set(roms.map((r) => r.system))) {
    const core = (CORE_PREFS[sys] ?? []).find((c) => cores.includes(c));
    systems[sys] = { name: SYSTEM_NAMES[sys] ?? sys, core };
  }
  const soh = emulators.find((e) => e.id === 'soh');
  const sohMods = soh ? listShipMods({ id: 'soh', dir: soh.dir }) : [];
  const modPorts: ModPortMods[] = PORT_EXES.flatMap((p) => {
    const e = emulators.find((x) => x.id === p.id);
    if (!e) return [];
    const port = { id: p.id, dir: e.dir };
    return [
      {
        id: p.id,
        name: MOD_PORTS[p.id].name,
        dir: e.dir,
        mods: p.id === 'soh' ? sohMods : listShipMods(port),
        altAssets: shipAltAssets(port),
        ordered: portHasList(port),
      },
    ];
  });
  roms.sort((a, b) => a.system.localeCompare(b.system) || a.title.localeCompare(b.title));
  // which devices have each ROM: PC, plus whoever Syncthing shares its folder with
  const synced = syncthingFolders(root);
  for (const r of roms) {
    const folder = synced.find((f) => r.path.toLowerCase().startsWith(f.path.toLowerCase() + path.sep));
    if (folder) {
      r.devices = ['PC', ...folder.devices];
      if (folder.devices.length) r.where = 'all';
    }
  }
  // the user's romhacks.json wins over detection (fields it leaves out keep the detected ones)
  const curated = loadRomHacks(root);
  for (const r of roms) {
    const c = curated.find((h) => (h.sha1 && h.sha1 === r.sha1) || (!h.sha1 && h.file === r.file.toLowerCase()));
    if (!c) continue;
    const merged = { ...(r.hackInfo ?? {}), ...Object.fromEntries(Object.entries(c.info).filter(([, v]) => v !== undefined)) };
    r.hackInfo = merged as RomHackInfo;
    r.hack = true;
  }
  return { root, exists: true, roms, emulators, synced, sohMods, sohAltAssets: soh ? shipAltAssets({ id: 'soh', dir: soh.dir }) : undefined, modPorts, pcPorts, systems };
}

/** Launch a ROM: RetroArch with the system's core, else BizHawk. */
export function playRom(lib: EmulationLibrary, romPath: string): { ok: boolean; error?: string } {
  const rom = lib.roms.find((r) => r.path === romPath);
  if (!rom) return { ok: false, error: 'ROM not in the library (rescan?)' };
  const ra = lib.emulators.find((e) => e.id === 'retroarch');
  const core = lib.systems[rom.system]?.core;
  if (ra && core) {
    spawn(ra.exe, ['-L', path.join(ra.dir, 'cores', `${core}_libretro.dll`), rom.path], { cwd: ra.dir, detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  }
  const hawk = lib.emulators.find((e) => e.id === 'bizhawk');
  if (hawk) {
    spawn(hawk.exe, [rom.path], { cwd: hawk.dir, detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  }
  return { ok: false, error: `No emulator for ${rom.system}` };
}

/** Start an emulator or PC port on its own (e.g. Ship of Harkinian). */
export function launchEmulator(lib: EmulationLibrary, id: string): { ok: boolean; error?: string } {
  const emu = lib.emulators.find((e) => e.id === id);
  if (!emu) return { ok: false, error: 'Not found' };
  spawn(emu.exe, [], { cwd: emu.dir, detached: true, stdio: 'ignore' }).unref();
  return { ok: true };
}
