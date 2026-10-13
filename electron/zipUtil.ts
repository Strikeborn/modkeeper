/**
 * Small zip writer and reader (no 7-Zip needed): world backups, and unpacking downloaded worlds.
 * Extraction never writes outside the target folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** Zip a folder (its contents under `rootName/`). Files over 4 GB aren't supported. */
export function zipFolder(dir: string, out: string, rootName = path.basename(dir)): { files: number; bytes: number } {
  const entries: { name: string; full: string }[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (e.isFile()) entries.push({ name: `${rootName}/${r}`, full });
    }
  };
  walk(dir, '');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.part`;
  const fd = fs.openSync(tmp, 'w');
  const central: Buffer[] = [];
  let offset = 0;
  let bytes = 0;
  try {
    for (const e of entries) {
      // session.lock is held open while a world is loaded; skipping it is what Minecraft's own backups do
      if (/(^|\/)session\.lock$/.test(e.name)) continue;
      const data = fs.readFileSync(e.full);
      if (data.length >= 0xffffffff) throw new Error(`${e.name} is too big to zip`);
      const crc = zlib.crc32(data);
      const packed = zlib.deflateRawSync(data);
      const stored = packed.length >= data.length;
      const body = stored ? data : packed;
      const name = Buffer.from(e.name, 'utf8');
      const st = fs.statSync(e.full);
      const d = st.mtime;
      const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
      const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6); // utf-8 names
      local.writeUInt16LE(stored ? 0 : 8, 8);
      local.writeUInt16LE(dosTime, 10);
      local.writeUInt16LE(dosDate, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      const head = Buffer.alloc(46);
      head.writeUInt32LE(0x02014b50, 0);
      head.writeUInt16LE(20, 4);
      head.writeUInt16LE(20, 6);
      head.writeUInt16LE(0x0800, 8);
      head.writeUInt16LE(stored ? 0 : 8, 10);
      head.writeUInt16LE(dosTime, 12);
      head.writeUInt16LE(dosDate, 14);
      head.writeUInt32LE(crc, 16);
      head.writeUInt32LE(body.length, 20);
      head.writeUInt32LE(data.length, 24);
      head.writeUInt16LE(name.length, 28);
      head.writeUInt32LE(offset, 42);
      central.push(head, name);
      fs.writeSync(fd, local);
      fs.writeSync(fd, name);
      fs.writeSync(fd, body);
      offset += 30 + name.length + body.length;
      if (offset >= 0xffffffff) throw new Error('Backup is over 4 GB');
      bytes += data.length;
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length / 2, 8);
    end.writeUInt16LE(central.length / 2, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    fs.writeSync(fd, cd);
    fs.writeSync(fd, end);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, out);
  return { files: central.length / 2, bytes };
}

export type ZipEntry = { name: string; method: number; csize: number; size: number; local: number };

export function zipEntries(buf: Buffer): ZipEntry[] {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue;
    const count = buf.readUInt16LE(i + 10);
    let p = buf.readUInt32LE(i + 16);
    const out: ZipEntry[] = [];
    for (let n = 0; n < count && p + 46 <= buf.length; n++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) break;
      const nameLen = buf.readUInt16LE(p + 28);
      out.push({
        name: buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/'),
        method: buf.readUInt16LE(p + 10),
        csize: buf.readUInt32LE(p + 20),
        size: buf.readUInt32LE(p + 24),
        local: buf.readUInt32LE(p + 42),
      });
      p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    }
    return out;
  }
  return [];
}

export function entryData(buf: Buffer, e: ZipEntry): Buffer {
  const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
  const raw = buf.subarray(start, start + e.csize);
  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`Unsupported zip compression (${e.method})`);
}

/** Extract entries under `prefix` (e.g. "MyWorld/") into `dest`, refusing any path that would land outside it. */
export function extractZip(buf: Buffer, dest: string, prefix = ''): number {
  const root = path.resolve(dest);
  let n = 0;
  for (const e of zipEntries(buf)) {
    if (!e.name.startsWith(prefix) || e.name.endsWith('/')) continue;
    const rel = e.name.slice(prefix.length);
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entryData(buf, e));
    n++;
  }
  return n;
}
