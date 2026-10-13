/**
 * A Minecraft world's details (from level.dat and its stats) and a top-down map drawn from its region files
 * (Anvil format, Minecraft 1.18 and newer). Read-only: the world is never written to.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { readNbt, type Nbt } from './nbt';

export type WorldDetails = {
  levelName?: string;
  seed?: string;
  created?: string;
  lastPlayed?: number;
  /** In-game days the world has run (Time / 24000) and hours of play from the player's stats. */
  ageDays?: number;
  playHours?: number;
  gameMode?: string;
  difficulty?: string;
  hardcore?: boolean;
  cheats?: boolean;
  version?: string;
  spawn?: [number, number, number];
  player?: { pos: [number, number, number]; dimension: string };
  dataPacks?: string[];
  dimensions: { name: string; bytes: number }[];
  mapSupported: boolean;
  /** Spots worth seeing on the map: world spawn, where each player was, and the beds they set as their respawn. */
  places: Place[];
};

export type Place = { kind: 'spawn' | 'player' | 'bed'; label: string; pos: [number, number, number]; dimension: 'overworld' | 'nether' | 'end' };

const dimOf = (v: Nbt | undefined): Place['dimension'] => {
  const s = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
  return /nether|^-1$/.test(s) ? 'nether' : /the_end|^1$/.test(s) ? 'end' : 'overworld';
};

/** A player's last position and bed (1.21's "respawn" compound, or the older SpawnX/Y/Z fields). */
function playerPlaces(p: Record<string, Nbt> | undefined, who: string): Place[] {
  if (!p) return [];
  const out: Place[] = [];
  const pos = p.Pos as number[] | undefined;
  if (pos?.length === 3) out.push({ kind: 'player', label: who === 'You' ? 'Where you were' : `${who} was here`, pos: [Math.floor(pos[0]), Math.floor(pos[1]), Math.floor(pos[2])], dimension: dimOf(p.Dimension) });
  const r = p.respawn as Record<string, Nbt> | undefined;
  const rp = r?.pos as Int32Array | number[] | undefined;
  const bed: [number, number, number] | undefined =
    rp && rp.length === 3 ? [Number(rp[0]), Number(rp[1]), Number(rp[2])] : num(p.SpawnX) != null ? [num(p.SpawnX)!, num(p.SpawnY) ?? 64, num(p.SpawnZ)!] : undefined;
  if (bed) out.push({ kind: 'bed', label: who === 'You' ? 'Your bed' : `${who}'s bed`, pos: bed, dimension: dimOf(r?.dimension ?? p.SpawnDimension) });
  return out;
}

/** uuid -> name from the launcher's usercache.json next to saves\. */
function playerNames(worldDir: string): Map<string, string> {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(worldDir, '..', '..', 'usercache.json'), 'utf8')) as { name: string; uuid: string }[];
    return new Map(list.map((u) => [u.uuid.toLowerCase(), u.name]));
  } catch {
    return new Map();
  }
}

const num = (v: Nbt | undefined) => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : undefined);
const MODES = ['Survival', 'Creative', 'Adventure', 'Spectator'];
const DIFFICULTY = ['Peaceful', 'Easy', 'Normal', 'Hard'];

function dirBytes(dir: string): number {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      total += e.isDirectory() ? dirBytes(f) : fs.statSync(f).size;
    }
  } catch {
    /* missing */
  }
  return total;
}

export function worldDetails(worldDir: string): WorldDetails {
  const d = (readNbt(fs.readFileSync(path.join(worldDir, 'level.dat'))).Data ?? {}) as Record<string, Nbt>;
  const wgs = d.WorldGenSettings as Record<string, Nbt> | undefined;
  const seed = num(wgs?.seed) ?? num(d.RandomSeed);
  const player = d.Player as Record<string, Nbt> | undefined;
  const pos = player?.Pos as number[] | undefined;
  const version = (d.Version as Record<string, Nbt> | undefined)?.Name;
  const packs = (d.DataPacks as Record<string, Nbt> | undefined)?.Enabled;
  let playHours: number | undefined;
  try {
    const statsDir = path.join(worldDir, 'stats');
    for (const f of fs.readdirSync(statsDir).filter((x) => x.endsWith('.json'))) {
      const s = JSON.parse(fs.readFileSync(path.join(statsDir, f), 'utf8')) as { stats?: { 'minecraft:custom'?: Record<string, number> } };
      const custom = s.stats?.['minecraft:custom'] ?? {};
      const ticks = custom['minecraft:play_time'] ?? custom['minecraft:play_one_minute'];
      if (ticks) playHours = Math.max(playHours ?? 0, ticks / 20 / 3600);
    }
  } catch {
    /* no stats */
  }
  let created: string | undefined;
  try {
    const st = fs.statSync(worldDir);
    created = (st.birthtimeMs > 0 ? st.birthtime : st.mtime).toISOString();
  } catch {
    /* unknown */
  }
  const dims = [
    { name: 'Overworld', dir: worldDir },
    { name: 'Nether', dir: path.join(worldDir, 'DIM-1') },
    { name: 'The End', dir: path.join(worldDir, 'DIM1') },
  ]
    .map((x) => ({ name: x.name, bytes: dirBytes(path.join(x.dir, 'region')) }))
    .filter((x) => x.bytes > 0);
  const dataVersion = num(d.DataVersion) ?? 0;
  const places: Place[] = [{ kind: 'spawn', label: 'World spawn', pos: [num(d.SpawnX) ?? 0, num(d.SpawnY) ?? 64, num(d.SpawnZ) ?? 0], dimension: 'overworld' }];
  places.push(...playerPlaces(player, 'You'));
  // other players who joined (LAN / opened to friends); the host's own file repeats level.dat's Player
  const names = playerNames(worldDir);
  try {
    const pdDir = path.join(worldDir, 'playerdata');
    const files = fs.readdirSync(pdDir).filter((f) => /^[0-9a-f-]{36}\.dat$/i.test(f));
    for (const f of files) {
      if (files.length === 1 && player) continue;
      const uuid = f.slice(0, 36).toLowerCase();
      const pd = readNbt(fs.readFileSync(path.join(pdDir, f)));
      const who = names.get(uuid) ?? `Player ${uuid.slice(0, 8)}`;
      const own = player && JSON.stringify(pd.Pos) === JSON.stringify(player.Pos);
      if (!own) places.push(...playerPlaces(pd, who));
    }
  } catch {
    /* no other players */
  }
  const mode = num(d.GameType);
  const diff = num(d.Difficulty);
  return {
    levelName: typeof d.LevelName === 'string' ? d.LevelName : undefined,
    seed: seed != null ? String(typeof (wgs?.seed ?? d.RandomSeed) === 'bigint' ? (wgs?.seed ?? d.RandomSeed) : seed) : undefined,
    created,
    lastPlayed: num(d.LastPlayed),
    ageDays: num(d.Time) != null ? Math.floor(num(d.Time)! / 24000) : undefined,
    playHours,
    gameMode: mode != null ? MODES[mode] : undefined,
    difficulty: diff != null ? DIFFICULTY[diff] : undefined,
    hardcore: num(d.hardcore) === 1,
    cheats: num(d.allowCommands) === 1,
    version: typeof version === 'string' ? version : undefined,
    spawn: [num(d.SpawnX) ?? 0, num(d.SpawnY) ?? 64, num(d.SpawnZ) ?? 0],
    player: pos?.length === 3 ? { pos: [Math.floor(pos[0]), Math.floor(pos[1]), Math.floor(pos[2])], dimension: typeof player?.Dimension === 'string' ? player.Dimension : 'minecraft:overworld' } : undefined,
    dataPacks: Array.isArray(packs) ? (packs as string[]).filter((p) => p !== 'vanilla') : undefined,
    dimensions: dims,
    // 1.18 (data version 2860) moved chunks to the format the map reads
    mapSupported: dataVersion >= 2860,
    places,
  };
}

// ---------------- map ----------------

/** Rough colours by block name, enough for a readable overview. */
const COLOURS: [RegExp, [number, number, number]][] = [
  [/water|bubble_column|kelp|seagrass/, [52, 92, 196]],
  [/lava|magma/, [214, 96, 24]],
  [/ice|snow|powder_snow/, [236, 240, 250]],
  [/grass_block|moss|azalea|grass$|fern|vine|lily_pad/, [96, 152, 64]],
  [/leaves/, [58, 112, 40]],
  [/mangrove|jungle/, [70, 120, 50]],
  [/sand(?!stone)|suspicious_sand/, [218, 206, 150]],
  [/sandstone/, [206, 190, 130]],
  [/red_sand|terracotta/, [176, 100, 60]],
  [/gravel/, [140, 134, 128]],
  [/dirt|mud|podzol|farmland|path|rooted/, [134, 96, 66]],
  [/mycelium/, [112, 96, 110]],
  [/clay/, [160, 166, 178]],
  [/deepslate|basalt|blackstone/, [80, 80, 86]],
  [/netherrack|nylium|nether_wart|crimson/, [130, 50, 50]],
  [/warped/, [40, 120, 110]],
  [/end_stone|purpur/, [220, 222, 160]],
  [/stone|cobble|andesite|diorite|granite|tuff|calcite|ore/, [125, 125, 125]],
  [/log|wood|planks|stairs|slab|fence|door|bookshelf|barrel|chest|crafting/, [150, 116, 72]],
  [/brick/, [150, 80, 66]],
  [/glass/, [190, 220, 230]],
  [/flower|poppy|dandelion|tulip|orchid|allium|bluet|daisy|rose|peony|lilac/, [200, 80, 120]],
  [/wheat|carrots|potatoes|beetroots|hay/, [200, 180, 70]],
  [/pumpkin|melon/, [200, 120, 30]],
  [/torch|lantern|glowstone|shroomlight/, [250, 210, 110]],
  [/wool|carpet|concrete|bed/, [200, 200, 200]],
  [/obsidian/, [30, 20, 50]],
  [/bedrock/, [60, 60, 60]],
];
const colourCache = new Map<string, [number, number, number]>();
function colourOf(name: string): [number, number, number] {
  let c = colourCache.get(name);
  if (!c) {
    const n = name.replace(/^minecraft:/, '');
    c = COLOURS.find(([re]) => re.test(n))?.[1] ?? [120, 120, 110];
    colourCache.set(name, c);
  }
  return c;
}

/** Packed long array (no spanning, 1.16+) -> value at index. */
function packedAt(data: BigInt64Array, bits: number, index: number): number {
  const perLong = Math.floor(64 / bits);
  const word = data[Math.floor(index / perLong)];
  if (word === undefined) return 0;
  const shift = BigInt((index % perLong) * bits);
  return Number((BigInt.asUintN(64, word) >> shift) & ((1n << BigInt(bits)) - 1n));
}

type Column = { height: number; colour: [number, number, number] };

/** Top block of every column in a chunk (16x16), or null when the chunk isn't generated / readable. */
function chunkColumns(chunk: Record<string, Nbt>): Column[] | null {
  const status = typeof chunk.Status === 'string' ? chunk.Status : '';
  if (status && !/full|minecraft:full/.test(status)) return null;
  const sections = (chunk.sections as Record<string, Nbt>[] | undefined) ?? [];
  if (!sections.length) return null;
  const minSectionY = Math.min(...sections.map((s) => num(s.Y) ?? 0));
  const minY = minSectionY * 16;
  const hm = (chunk.Heightmaps as Record<string, Nbt> | undefined)?.WORLD_SURFACE as BigInt64Array | undefined;
  if (!hm) return null;
  const byY = new Map<number, Record<string, Nbt>>(sections.map((s) => [num(s.Y) ?? 0, s]));
  const out: Column[] = [];
  for (let z = 0; z < 16; z++)
    for (let x = 0; x < 16; x++) {
      const stored = packedAt(hm, 9, z * 16 + x);
      let y = stored - 1 + minY;
      let colour: [number, number, number] = [0, 0, 0];
      // walk down past air until a block is found (heightmap is usually exact)
      for (let tries = 0; tries < 8; tries++, y--) {
        const sec = byY.get(Math.floor(y / 16));
        const bs = sec?.block_states as Record<string, Nbt> | undefined;
        const palette = bs?.palette as Record<string, Nbt>[] | undefined;
        if (!palette?.length) break;
        let idx = 0;
        if (palette.length > 1 && bs?.data) {
          const bits = Math.max(4, Math.ceil(Math.log2(palette.length)));
          idx = packedAt(bs.data as BigInt64Array, bits, ((y & 15) * 16 + z) * 16 + x);
        }
        const name = String(palette[idx]?.Name ?? 'minecraft:air');
        if (!/air$/.test(name)) {
          colour = colourOf(name);
          break;
        }
      }
      out.push({ height: y, colour });
    }
  return out;
}

function readChunk(region: Buffer, cx: number, cz: number): Record<string, Nbt> | null {
  const i = 4 * ((cx & 31) + (cz & 31) * 32);
  const offset = ((region[i] << 16) | (region[i + 1] << 8) | region[i + 2]) * 4096;
  if (!offset || offset + 5 > region.length) return null;
  const length = region.readUInt32BE(offset);
  const type = region[offset + 4];
  const body = region.subarray(offset + 5, offset + 4 + length);
  try {
    const raw = type === 1 ? zlib.gunzipSync(body) : type === 2 ? zlib.inflateSync(body) : type === 3 ? body : null;
    return raw ? readNbt(raw) : null;
  } catch {
    return null;
  }
}

/**
 * RGBA pixels (one per block) for the square of side 2*radius around (centerX, centerZ) in a dimension.
 * Unexplored ground is transparent. Hills are shaded by comparing each column with the one to its north.
 */
export function renderWorldMap(
  worldDir: string,
  centerX: number,
  centerZ: number,
  radius: number,
  dimension: 'overworld' | 'nether' | 'end' = 'overworld',
): { width: number; height: number; rgba: Buffer; chunks: number } {
  const size = radius * 2;
  const rgba = Buffer.alloc(size * size * 4);
  const heights = new Int16Array(size * size).fill(-32768);
  const x0 = Math.floor(centerX) - radius;
  const z0 = Math.floor(centerZ) - radius;
  const regionDir = path.join(worldDir, dimension === 'nether' ? 'DIM-1' : dimension === 'end' ? 'DIM1' : '', 'region');
  let chunks = 0;
  for (let rx = Math.floor(x0 / 512); rx <= Math.floor((x0 + size - 1) / 512); rx++)
    for (let rz = Math.floor(z0 / 512); rz <= Math.floor((z0 + size - 1) / 512); rz++) {
      let region: Buffer;
      try {
        region = fs.readFileSync(path.join(regionDir, `r.${rx}.${rz}.mca`));
      } catch {
        continue;
      }
      for (let lcz = 0; lcz < 32; lcz++)
        for (let lcx = 0; lcx < 32; lcx++) {
          const bx = (rx * 32 + lcx) * 16;
          const bz = (rz * 32 + lcz) * 16;
          if (bx + 16 <= x0 || bz + 16 <= z0 || bx >= x0 + size || bz >= z0 + size) continue;
          const chunk = readChunk(region, lcx, lcz);
          const cols = chunk && chunkColumns(chunk);
          if (!cols) continue;
          chunks++;
          for (let z = 0; z < 16; z++)
            for (let x = 0; x < 16; x++) {
              const px = bx + x - x0;
              const pz = bz + z - z0;
              if (px < 0 || pz < 0 || px >= size || pz >= size) continue;
              const c = cols[z * 16 + x];
              const p = pz * size + px;
              heights[p] = c.height;
              rgba[p * 4] = c.colour[0];
              rgba[p * 4 + 1] = c.colour[1];
              rgba[p * 4 + 2] = c.colour[2];
              rgba[p * 4 + 3] = 255;
            }
        }
    }
  // relief: brighter facing north-west slopes, darker away from them
  for (let pz = 1; pz < size; pz++)
    for (let px = 0; px < size; px++) {
      const p = pz * size + px;
      const north = heights[p - size];
      if (heights[p] === -32768 || north === -32768) continue;
      const f = heights[p] > north ? 1.12 : heights[p] < north ? 0.86 : 1;
      for (let k = 0; k < 3; k++) rgba[p * 4 + k] = Math.min(255, Math.round(rgba[p * 4 + k] * f));
    }
  return { width: size, height: size, rgba, chunks };
}
