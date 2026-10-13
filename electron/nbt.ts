/**
 * Minimal reader for Minecraft's NBT format (level.dat is gzipped NBT), enough to show a world's name,
 * mode, version and when it was last played. Read-only.
 */
import zlib from 'node:zlib';

export type Nbt = number | bigint | string | Nbt[] | { [k: string]: Nbt } | Int8Array | Int32Array | BigInt64Array;

export function readNbt(raw: Buffer): Record<string, Nbt> {
  const buf = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw;
  let p = 0;
  const u8 = () => buf.readUInt8(p++);
  const i16 = () => ((p += 2), buf.readInt16BE(p - 2));
  const u16 = () => ((p += 2), buf.readUInt16BE(p - 2));
  const i32 = () => ((p += 4), buf.readInt32BE(p - 4));
  const i64 = () => ((p += 8), buf.readBigInt64BE(p - 8));
  const str = () => {
    const n = u16();
    p += n;
    return buf.toString('utf8', p - n, p);
  };
  const payload = (type: number): Nbt => {
    switch (type) {
      case 1:
        return buf.readInt8(p++);
      case 2:
        return i16();
      case 3:
        return i32();
      case 4:
        return i64();
      case 5:
        return ((p += 4), buf.readFloatBE(p - 4));
      case 6:
        return ((p += 8), buf.readDoubleBE(p - 8));
      case 7: {
        const n = i32();
        p += n;
        return new Int8Array(buf.subarray(p - n, p));
      }
      case 8:
        return str();
      case 9: {
        const t = u8();
        const n = i32();
        const out: Nbt[] = [];
        for (let k = 0; k < n; k++) out.push(payload(t));
        return out;
      }
      case 10: {
        const out: Record<string, Nbt> = {};
        for (;;) {
          const t = u8();
          if (t === 0) return out;
          const name = str();
          out[name] = payload(t);
        }
      }
      case 11: {
        const n = i32();
        const out = new Int32Array(n);
        for (let k = 0; k < n; k++) out[k] = i32();
        return out;
      }
      case 12: {
        const n = i32();
        const out = new BigInt64Array(n);
        for (let k = 0; k < n; k++) out[k] = i64();
        return out;
      }
      default:
        throw new Error(`Unknown NBT tag ${type}`);
    }
  };
  const rootType = u8();
  if (rootType !== 10) throw new Error('Not an NBT compound');
  str();
  return payload(10) as Record<string, Nbt>;
}

export type WorldInfo = { levelName?: string; lastPlayed?: number; gameMode?: string; hardcore?: boolean; cheats?: boolean; version?: string; ageDays?: number; created?: string };

const MODES = ['Survival', 'Creative', 'Adventure', 'Spectator'];

/** The parts of level.dat the Worlds list shows. */
export function worldInfo(levelDat: Buffer): WorldInfo {
  const root = readNbt(levelDat);
  const d = (root.Data ?? root.data ?? {}) as Record<string, Nbt>;
  const num = (v: Nbt | undefined) => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : undefined);
  const version = d.Version as Record<string, Nbt> | undefined;
  const mode = num(d.GameType);
  return {
    levelName: typeof d.LevelName === 'string' ? d.LevelName : undefined,
    lastPlayed: num(d.LastPlayed),
    gameMode: mode != null ? MODES[mode] : undefined,
    hardcore: num(d.hardcore) === 1,
    cheats: num(d.allowCommands) === 1,
    version: typeof version?.Name === 'string' ? version.Name : undefined,
    ageDays: num(d.Time) != null ? Math.floor(num(d.Time)! / 24000) : undefined,
  };
}

/**
 * Replace one string value (e.g. Data.LevelName) in NBT, changing nothing else: the bytes around it are kept as they
 * are, so every other tag keeps its exact type. Gzipped input comes back gzipped.
 */
export function replaceNbtString(raw: Buffer, keys: string[], value: string): Buffer {
  const gz = raw[0] === 0x1f && raw[1] === 0x8b;
  const buf = gz ? zlib.gunzipSync(raw) : raw;
  let p = 0;
  let hit: [number, number] | undefined;
  const str = () => {
    const n = buf.readUInt16BE(p);
    p += 2 + n;
    return buf.toString('utf8', p - n, p);
  };
  const SIZES: Record<number, number> = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 4, 6: 8 };
  const skip = (type: number, path: string[]): void => {
    if (SIZES[type]) {
      p += SIZES[type];
      return;
    }
    switch (type) {
      case 7:
        p += 4 + buf.readInt32BE(p);
        return;
      case 8: {
        const start = p;
        str();
        if (!hit && path.length === keys.length && path.every((k, i) => k === keys[i])) hit = [start, p];
        return;
      }
      case 9: {
        const t = buf.readUInt8(p);
        const n = buf.readInt32BE(p + 1);
        p += 5;
        for (let k = 0; k < n; k++) skip(t, [...path, '[]']);
        return;
      }
      case 10:
        for (;;) {
          const t = buf.readUInt8(p++);
          if (t === 0) return;
          const name = str();
          skip(t, [...path, name]);
        }
      case 11:
        p += 4 + 4 * buf.readInt32BE(p);
        return;
      case 12:
        p += 4 + 8 * buf.readInt32BE(p);
        return;
      default:
        throw new Error(`Unknown NBT tag ${type}`);
    }
  };
  if (buf.readUInt8(p++) !== 10) throw new Error('Not an NBT compound');
  str();
  skip(10, []);
  if (!hit) throw new Error(`${keys.join('.')} not found`);
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > 0xffff) throw new Error('Name too long');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(bytes.length);
  const out = Buffer.concat([buf.subarray(0, hit[0]), len, bytes, buf.subarray(hit[1])]);
  return gz ? zlib.gzipSync(out) : out;
}
