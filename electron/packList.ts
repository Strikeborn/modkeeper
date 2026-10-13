/**
 * File names inside Ship of Harkinian packs, read straight from the file: .o2r packs are zips (central
 * directory), .otr packs are MPQ archives (their "(listfile)"). 7-Zip can't open most MPQs, so this
 * doesn't lean on it. Read-only; returns undefined when a pack can't be read.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

// ---------------- zip ----------------

function zipNames(buf: Buffer): string[] | undefined {
  const from = Math.max(0, buf.length - 65_557);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue;
    const count = buf.readUInt16LE(i + 10);
    let p = buf.readUInt32LE(i + 16);
    if (p === 0xffffffff || p >= buf.length) return undefined; // zip64: leave it
    const names: string[] = [];
    for (let n = 0; n < count && p + 46 <= buf.length; n++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) return undefined;
      const nameLen = buf.readUInt16LE(p + 28);
      const extra = buf.readUInt16LE(p + 30);
      const comment = buf.readUInt16LE(p + 32);
      names.push(buf.toString('utf8', p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extra + comment;
    }
    return names;
  }
  return undefined;
}

// ---------------- MPQ ----------------

let cryptTable: Uint32Array | undefined;
function crypt(): Uint32Array {
  if (cryptTable) return cryptTable;
  const t = new Uint32Array(0x500);
  let seed = 0x00100001;
  for (let i = 0; i < 0x100; i++) {
    for (let j = 0; j < 5; j++) {
      seed = (seed * 125 + 3) % 0x2aaaab;
      const hi = (seed & 0xffff) << 16;
      seed = (seed * 125 + 3) % 0x2aaaab;
      t[i + j * 0x100] = (hi | (seed & 0xffff)) >>> 0;
    }
  }
  return (cryptTable = t);
}

function hashString(s: string, type: number): number {
  const t = crypt();
  let seed1 = 0x7fed7fed;
  let seed2 = 0xeeeeeeee;
  for (const c of s.toUpperCase()) {
    const ch = c.charCodeAt(0) & 0xff;
    seed1 = (t[type * 0x100 + ch] ^ ((seed1 + seed2) >>> 0)) >>> 0;
    seed2 = (ch + seed1 + seed2 + ((seed2 << 5) >>> 0) + 3) >>> 0;
  }
  return seed1;
}

/** Decrypt whole 32-bit words in place (a trailing partial word stays as is, like StormLib). */
function decrypt(buf: Buffer, key: number): void {
  const t = crypt();
  let seed2 = 0xeeeeeeee;
  for (let i = 0; i + 4 <= buf.length; i += 4) {
    seed2 = (seed2 + t[0x400 + (key & 0xff)]) >>> 0;
    const ch = (buf.readUInt32LE(i) ^ ((key + seed2) >>> 0)) >>> 0;
    buf.writeUInt32LE(ch, i);
    key = ((((~key << 0x15) >>> 0) + 0x11111111) | (key >>> 0x0b)) >>> 0;
    seed2 = (ch + seed2 + ((seed2 << 5) >>> 0) + 3) >>> 0;
  }
}

const COMPRESS = 0x200;
const IMPLODE = 0x100;
const ENCRYPTED = 0x10000;
const FIX_KEY = 0x20000;
const SINGLE_UNIT = 0x1000000;
const SECTOR_CRC = 0x4000000;

function inflateSector(data: Buffer, size: number): Buffer | undefined {
  if (data.length >= size) return data.subarray(0, size);
  const mask = data[0];
  if (mask !== 0x02) return undefined; // only zlib (StormLib's default) is handled
  try {
    return zlib.inflateSync(data.subarray(1));
  } catch {
    return undefined;
  }
}

function readMpqFile(buf: Buffer, base: number, name: string, sectorSize: number, hashes: Buffer, blocks: Buffer): Buffer | undefined {
  const n = hashes.length / 16;
  const h1 = hashString(name, 1);
  const h2 = hashString(name, 2);
  let block = -1;
  for (let k = 0, i = hashString(name, 0) % n; k < n; k++, i = (i + 1) % n) {
    const bi = hashes.readUInt32LE(i * 16 + 12);
    if (bi === 0xffffffff) break;
    if (hashes.readUInt32LE(i * 16) === h1 && hashes.readUInt32LE(i * 16 + 4) === h2) {
      block = bi;
      break;
    }
  }
  if (block < 0 || (block + 1) * 16 > blocks.length) return undefined;
  const offset = blocks.readUInt32LE(block * 16);
  const compSize = blocks.readUInt32LE(block * 16 + 4);
  const fileSize = blocks.readUInt32LE(block * 16 + 8);
  const flags = blocks.readUInt32LE(block * 16 + 12);
  if (flags & IMPLODE) return undefined;
  const start = base + offset;
  if (start + compSize > buf.length) return undefined;
  let key = hashString(name.split(/[\\/]/).pop() ?? name, 3);
  if (flags & FIX_KEY) key = (((key + offset) >>> 0) ^ fileSize) >>> 0;
  const raw = Buffer.from(buf.subarray(start, start + compSize));

  if (flags & SINGLE_UNIT) {
    if (flags & ENCRYPTED) decrypt(raw, key);
    return flags & COMPRESS ? inflateSector(raw, fileSize) : raw.subarray(0, fileSize);
  }
  const sectors = Math.ceil(fileSize / sectorSize);
  if (!(flags & COMPRESS)) {
    const out: Buffer[] = [];
    for (let s = 0; s < sectors; s++) {
      const part = raw.subarray(s * sectorSize, Math.min(fileSize, (s + 1) * sectorSize));
      if (flags & ENCRYPTED) decrypt(part, (key + s) >>> 0);
      out.push(part);
    }
    return Buffer.concat(out);
  }
  const words = sectors + 1 + (flags & SECTOR_CRC ? 1 : 0);
  const table = raw.subarray(0, words * 4);
  if (flags & ENCRYPTED) decrypt(table, (key - 1) >>> 0);
  const out: Buffer[] = [];
  for (let s = 0; s < sectors; s++) {
    const a = table.readUInt32LE(s * 4);
    const b = table.readUInt32LE(s * 4 + 4);
    if (b < a || b > raw.length) return undefined;
    const part = raw.subarray(a, b);
    if (flags & ENCRYPTED) decrypt(part, (key + s) >>> 0);
    const want = Math.min(sectorSize, fileSize - s * sectorSize);
    const data = inflateSector(part, want);
    if (!data) return undefined;
    out.push(data);
  }
  return Buffer.concat(out);
}

function mpqNames(buf: Buffer): string[] | undefined {
  // the header sits at 0 or on a 512-byte boundary after a stub
  let base = -1;
  for (let p = 0; p + 32 <= buf.length && p <= 1 << 20; p += 512) {
    if (buf.readUInt32LE(p) === 0x1a51504d) {
      base = p;
      break;
    }
  }
  if (base < 0) return undefined;
  const sectorSize = 512 << buf.readUInt16LE(base + 14);
  const hashPos = buf.readUInt32LE(base + 16);
  const blockPos = buf.readUInt32LE(base + 20);
  const hashCount = buf.readUInt32LE(base + 24);
  const blockCount = buf.readUInt32LE(base + 28);
  if (base + hashPos + hashCount * 16 > buf.length || base + blockPos + blockCount * 16 > buf.length) return undefined;
  const hashes = Buffer.from(buf.subarray(base + hashPos, base + hashPos + hashCount * 16));
  const blocks = Buffer.from(buf.subarray(base + blockPos, base + blockPos + blockCount * 16));
  decrypt(hashes, hashString('(hash table)', 3));
  decrypt(blocks, hashString('(block table)', 3));
  const list = readMpqFile(buf, base, '(listfile)', sectorSize, hashes, blocks);
  if (!list) return undefined;
  return list
    .toString('utf8')
    .split(/[;\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Names inside a pack, or undefined if it can't be read. */
export function packEntries(file: string): string[] | undefined {
  let buf: Buffer;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 1_500_000_000) return undefined;
    buf = fs.readFileSync(file);
  } catch {
    return undefined;
  }
  if (buf.length < 32) return undefined;
  if (buf.readUInt32LE(0) === 0x04034b50 || !/\.otr$/i.test(file)) return zipNames(buf) ?? mpqNames(buf);
  return mpqNames(buf) ?? zipNames(buf);
}

/** True when the pack has alternate assets (an alt\ folder Ship only shows with Alternate Assets on). */
export function packHasAltAssets(file: string): boolean | undefined {
  const names = packEntries(file);
  if (!names) return undefined;
  return names.some((n) => /^alt[\\/]/i.test(n));
}
