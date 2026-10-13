/**
 * Minecraft instances from every launcher on the PC: Prism Launcher, CurseForge, the Modrinth App and the
 * official launcher's .minecraft (plus any launcher profile with its own game folder). Read-only, apart from
 * starting a launcher when the user presses Play.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import type { McInstance, McKind, McLauncher } from '../shared/types';
import { findPrismInstances, prismExe } from './prism';

const appData = () => process.env.APPDATA ?? '';
const localAppData = () => process.env.LOCALAPPDATA ?? '';
const home = () => process.env.USERPROFILE ?? '';

const LAUNCHER_NAMES: Record<McLauncher, string> = {
  prism: 'Prism Launcher',
  curseforge: 'CurseForge',
  modrinth: 'Modrinth App',
  vanilla: 'Minecraft Launcher',
};

function firstExisting(paths: string[]): string | undefined {
  return paths.find((p) => p && fs.existsSync(p));
}

export function curseforgeExe(): string | undefined {
  return firstExisting([
    path.join(localAppData(), 'Programs', 'CurseForge Windows', 'CurseForge.exe'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'CurseForge Windows', 'CurseForge.exe'),
  ]);
}

export function modrinthExe(): string | undefined {
  return firstExisting([
    path.join(localAppData(), 'Modrinth App', 'Modrinth App.exe'),
    path.join(localAppData(), 'Programs', 'Modrinth App', 'Modrinth App.exe'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Modrinth App', 'Modrinth App.exe'),
  ]);
}

/** The official launcher: the Xbox app install (any drive) or the classic installer. */
export function vanillaLauncherExe(): string | undefined {
  const xbox = [...'CDEFGHIJ'].map((d) => `${d}:\\XboxGames\\Minecraft Launcher\\Content\\Minecraft.exe`);
  return firstExisting([
    ...xbox,
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Minecraft Launcher', 'MinecraftLauncher.exe'),
  ]);
}

export function launcherInstalled(l: McLauncher): boolean {
  if (l === 'prism') return Boolean(prismExe());
  if (l === 'curseforge') return Boolean(curseforgeExe());
  if (l === 'modrinth') return Boolean(modrinthExe());
  return Boolean(vanillaLauncherExe());
}

function countIn(dir: string, test: (name: string, isDir: boolean) => boolean): number {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => test(e.name, e.isDirectory())).length;
  } catch {
    return 0;
  }
}

export function contentCounts(gameDir: string): Record<McKind, number> {
  return {
    mods: countIn(path.join(gameDir, 'mods'), (n, d) => !d && /\.jar(\.disabled)?$/i.test(n)),
    resourcepacks: countIn(path.join(gameDir, 'resourcepacks'), (n, d) => d || /\.zip$/i.test(n)),
    shaderpacks: countIn(path.join(gameDir, 'shaderpacks'), (n, d) => d || /\.zip$/i.test(n)),
    worlds: countIn(path.join(gameDir, 'saves'), (n, d) => d && fs.existsSync(path.join(gameDir, 'saves', n, 'level.dat'))),
    screenshots: countIn(path.join(gameDir, 'screenshots'), (n, d) => !d && /\.(png|jpe?g)$/i.test(n)),
  };
}

/** Iris/Oculus or OptiFine in the mods folder (or an OptiFine launcher profile). */
function shaderLoaderOf(gameDir: string, optifineProfile = false): McInstance['shaderLoader'] {
  try {
    const jars = fs.readdirSync(path.join(gameDir, 'mods')).filter((f) => /\.jar$/i.test(f));
    if (jars.some((f) => /^(iris|oculus)[-_ ]/i.test(f))) return 'iris';
    if (jars.some((f) => /optifine/i.test(f))) return 'optifine';
  } catch {
    /* no mods folder */
  }
  return optifineProfile ? 'optifine' : undefined;
}

function pngDataUrl(file?: string): string | undefined {
  try {
    if (!file || fs.statSync(file).size > 2_000_000) return undefined;
    return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
  } catch {
    return undefined;
  }
}

function make(
  launcher: McLauncher,
  gameDir: string,
  rest: Partial<McInstance> & { name: string },
  optifineProfile = false,
): McInstance {
  return {
    id: `${launcher}:${path.normalize(gameDir).toLowerCase()}`,
    launcher,
    launcherName: LAUNCHER_NAMES[launcher],
    gameDir,
    counts: contentCounts(gameDir),
    shaderLoader: shaderLoaderOf(gameDir, optifineProfile),
    canLaunchDirect: false,
    ...rest,
  };
}

function prismInstances(): McInstance[] {
  return findPrismInstances().map((i) => {
    let icon: string | undefined;
    let lastPlayed: string | undefined;
    try {
      const cfg = fs.readFileSync(path.join(i.dir, 'instance.cfg'), 'utf8');
      const key = /^iconKey=(.*)$/m.exec(cfg)?.[1]?.trim();
      if (key && key !== 'default') {
        const iconsDir = path.join(appData(), 'PrismLauncher', 'icons');
        const f = fs.existsSync(iconsDir) ? fs.readdirSync(iconsDir).find((n) => n.replace(/\.[^.]+$/, '') === key) : undefined;
        icon = pngDataUrl(f ? path.join(iconsDir, f) : undefined);
      }
      const lp = Number(/^lastLaunchTime=(\d+)$/m.exec(cfg)?.[1]);
      if (lp) lastPlayed = new Date(lp).toISOString();
    } catch {
      /* no cfg details */
    }
    return make('prism', i.gameDir, { name: i.name, mcVersion: i.mcVersion, loader: i.loader, icon, lastPlayed, canLaunchDirect: Boolean(prismExe()) });
  });
}

/** CurseForge: <Instances>\<name>\minecraftinstance.json; the instance folder is the game folder. */
function curseforgeInstances(): McInstance[] {
  const roots = [path.join(home(), 'curseforge', 'minecraft', 'Instances')];
  // CurseForge lets you move it; its settings remember where
  try {
    const s = JSON.parse(fs.readFileSync(path.join(appData(), 'CurseForge', 'storage', 'settings.json'), 'utf8')) as Record<string, unknown>;
    const mc = JSON.stringify(s).match(/"minecraftRoot"\s*:\s*"([^"]+)"/)?.[1];
    if (mc) roots.unshift(path.join(JSON.parse(`"${mc}"`) as string, 'Instances'));
  } catch {
    /* default place */
  }
  const out: McInstance[] = [];
  for (const root of [...new Set(roots)]) {
    let dirs: fs.Dirent[] = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const d of dirs) {
      const dir = path.join(root, d.name);
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, 'minecraftinstance.json'), 'utf8')) as {
          name?: string;
          gameVersion?: string;
          baseModLoader?: { name?: string; minecraftVersion?: string } | null;
          lastPlayed?: string;
        };
        const loaderName = j.baseModLoader?.name ?? '';
        const m = /^(forge|fabric|neoforge|quilt)-(.+)$/i.exec(loaderName);
        out.push(
          make('curseforge', dir, {
            name: j.name ?? d.name,
            mcVersion: j.gameVersion ?? j.baseModLoader?.minecraftVersion,
            loader: m?.[1].toLowerCase(),
            loaderVersion: m?.[2]?.replace(new RegExp(`-?${j.gameVersion ?? '$^'}$`), ''),
            lastPlayed: j.lastPlayed && !j.lastPlayed.startsWith('0001') ? j.lastPlayed : undefined,
          }),
        );
      } catch {
        /* not an instance */
      }
    }
  }
  return out;
}

/** Modrinth App: profiles in app.db (SQLite) and folders under profiles\. */
function modrinthInstances(): McInstance[] {
  const out: McInstance[] = [];
  for (const base of [path.join(appData(), 'ModrinthApp'), path.join(appData(), 'com.modrinth.theseus')]) {
    const profiles = path.join(base, 'profiles');
    if (!fs.existsSync(profiles)) continue;
    const meta = new Map<string, { name?: string; game_version?: string; mod_loader?: string; mod_loader_version?: string; icon_path?: string; last_played?: number }>();
    try {
      const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
      const db = new DatabaseSync(path.join(base, 'app.db'), { readOnly: true });
      try {
        for (const r of db.prepare('SELECT * FROM profiles').all() as Record<string, unknown>[]) {
          if (typeof r.path === 'string') meta.set(r.path, r as never);
        }
      } finally {
        db.close();
      }
    } catch {
      /* older app or locked database: folder names only */
    }
    for (const d of fs.readdirSync(profiles, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const m = meta.get(d.name);
      const loader = m?.mod_loader && m.mod_loader !== 'vanilla' ? m.mod_loader : undefined;
      out.push(
        make('modrinth', path.join(profiles, d.name), {
          name: m?.name ?? d.name,
          mcVersion: m?.game_version,
          loader,
          loaderVersion: m?.mod_loader_version,
          icon: pngDataUrl(m?.icon_path),
          lastPlayed: m?.last_played ? new Date(m.last_played * (m.last_played < 1e12 ? 1000 : 1)).toISOString() : undefined,
        }),
      );
    }
  }
  return out;
}

/** The official launcher: .minecraft, plus profiles that point at their own game folder. */
function vanillaInstances(): McInstance[] {
  const root = path.join(appData(), '.minecraft');
  if (!fs.existsSync(root)) return [];
  type Profile = { name?: string; type?: string; lastVersionId?: string; gameDir?: string; lastUsed?: string };
  let profiles: Profile[] = [];
  try {
    profiles = Object.values((JSON.parse(fs.readFileSync(path.join(root, 'launcher_profiles.json'), 'utf8')) as { profiles?: Record<string, Profile> }).profiles ?? {});
  } catch {
    /* no profiles yet */
  }
  const shared = profiles.filter((p) => !p.gameDir);
  const recent = [...shared].sort((a, b) => (b.lastUsed ?? '').localeCompare(a.lastUsed ?? ''))[0];
  const version = (p?: Profile) => (p?.lastVersionId && /^\d/.test(p.lastVersionId) ? p.lastVersionId.split('-')[0] : undefined);
  // "latest-release" profiles don't name a version: take the newest full release the launcher downloaded
  const newestRelease = () => {
    try {
      return fs
        .readdirSync(path.join(root, 'versions'), { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d+\.\d+(\.\d+)?$/.test(d.name))
        .map((d) => ({ v: d.name, t: fs.statSync(path.join(root, 'versions', d.name)).mtimeMs }))
        .sort((a, b) => b.t - a.t)[0]?.v;
    } catch {
      return undefined;
    }
  };
  const out = [
    make(
      'vanilla',
      root,
      {
        name: '.minecraft',
        mcVersion: version(recent) ?? newestRelease(),
        lastPlayed: recent?.lastUsed && !recent.lastUsed.startsWith('1970') ? recent.lastUsed : undefined,
      },
      shared.some((p) => /optifine/i.test(p.lastVersionId ?? '')),
    ),
  ];
  for (const p of profiles.filter((x) => x.gameDir && fs.existsSync(x.gameDir))) {
    out.push(make('vanilla', p.gameDir!, { name: p.name || path.basename(p.gameDir!), mcVersion: version(p), lastPlayed: p.lastUsed }, /optifine/i.test(p.lastVersionId ?? '')));
  }
  return out;
}

export function findMcInstances(): McInstance[] {
  const all = [...prismInstances(), ...curseforgeInstances(), ...modrinthInstances(), ...vanillaInstances()];
  const seen = new Set<string>();
  return all
    .filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)))
    .sort((a, b) => (b.lastPlayed ?? '').localeCompare(a.lastPlayed ?? '') || a.name.localeCompare(b.name));
}

export function mcInstanceById(id: string): McInstance | undefined {
  return findMcInstances().find((i) => i.id === id);
}

/** Start the instance (Prism can launch it directly); other launchers open so you can press Play there. */
export function launchMcInstance(inst: McInstance): { ok: boolean; message: string } {
  const run = (exe: string, args: string[] = []) => spawn(exe, args, { detached: true, stdio: 'ignore', cwd: path.dirname(exe) }).unref();
  if (inst.launcher === 'prism') {
    const exe = prismExe();
    if (!exe) return { ok: false, message: 'Prism Launcher isn’t installed.' };
    run(exe, ['--launch', path.basename(path.dirname(inst.gameDir))]);
    return { ok: true, message: `Starting “${inst.name}” in Prism Launcher` };
  }
  const exe = inst.launcher === 'curseforge' ? curseforgeExe() : inst.launcher === 'modrinth' ? modrinthExe() : vanillaLauncherExe();
  if (!exe) return { ok: false, message: `${inst.launcherName} isn’t installed.` };
  if (inst.launcher === 'vanilla' && exe.includes('XboxGames')) {
    // Store apps start through their app id, not the exe
    spawn('explorer.exe', ['shell:AppsFolder\\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft'], { detached: true, stdio: 'ignore' }).unref();
  } else run(exe);
  return { ok: true, message: `Opening ${inst.launcherName}: press Play on “${inst.name}” there` };
}

/** Open the instance's launcher itself (to add a mod loader, change settings, sign in...). */
export function openMcLauncher(inst: McInstance): { ok: boolean; message: string } {
  const exe = inst.launcher === 'prism' ? prismExe() : inst.launcher === 'curseforge' ? curseforgeExe() : inst.launcher === 'modrinth' ? modrinthExe() : vanillaLauncherExe();
  if (!exe) return { ok: false, message: `${inst.launcherName} isn’t installed.` };
  if (inst.launcher === 'vanilla' && exe.includes('XboxGames'))
    spawn('explorer.exe', ['shell:AppsFolder\\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft'], { detached: true, stdio: 'ignore' }).unref();
  else spawn(exe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exe) }).unref();
  return { ok: true, message: `Opening ${inst.launcherName}` };
}

/** Java processes whose command line points into this game folder (the game has its files open). */
export function mcInstanceRunning(gameDir: string): boolean {
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='javaw.exe' or Name='java.exe'\" | ForEach-Object { $_.CommandLine }"],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
    );
    const dir = path.normalize(gameDir).toLowerCase();
    return out
      .toLowerCase()
      .split(/\r?\n/)
      .some((l) => l.includes(dir) || l.includes(dir.replace(/\\/g, '/')));
  } catch {
    return false;
  }
}
