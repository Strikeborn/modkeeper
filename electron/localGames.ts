/**
 * Games that aren't Steam apps: whether they're installed, and cover art from their own launcher's files
 * (Steam's library art can't help here). Read-only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { findPrismInstances, prismExe } from './prism';

export type LocalGameInfo = { installed: boolean; art?: string; via?: string };

/** Xbox app installs go to <drive>:\XboxGames on whichever drive the user picked. */
function xboxGameDirs(name: string): string[] {
  const out: string[] = [];
  for (const d of 'CDEFGHIJ') {
    const dir = `${d}:\\XboxGames\\${name}\\Content`;
    if (fs.existsSync(dir)) out.push(dir);
  }
  return out;
}

function pngDataUrl(file: string): string | undefined {
  try {
    if (fs.statSync(file).size > 4_000_000) return undefined;
    return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
  } catch {
    return undefined;
  }
}

function minecraft(): LocalGameInfo {
  const launcherDirs = xboxGameDirs('Minecraft Launcher');
  const legacyLauncher = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Minecraft Launcher', 'MinecraftLauncher.exe');
  const prism = prismExe() ?? (findPrismInstances().length ? 'instances' : undefined);
  const via = prism ? 'Prism Launcher' : launcherDirs.length || fs.existsSync(legacyLauncher) ? 'Minecraft Launcher' : undefined;
  const art = launcherDirs.map((d) => pngDataUrl(path.join(d, 'SplashScreen.png'))).find(Boolean);
  return { installed: Boolean(via), art, via };
}

export function localGames(): Record<string, LocalGameInfo> {
  return { minecraft: minecraft() };
}
