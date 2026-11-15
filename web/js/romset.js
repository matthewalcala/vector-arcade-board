// Reads a ROM zip, works out which board it is for, and picks out the chips by CRC32,
// so file names don't matter.

// Chips of each supported board, by CRC32.
const SETS = {
  starwars: {
    0x04f1876e: 'banked', 0xf725e344: 'rom8000', 0xf6da0a00: 'romA000', 0x7e406703: 'romC000', 0xc7e51237: 'romE000',
    0x538e7d2f: 'vector', 0x82fc3eb2: 'avgProm',
    0x810e040e: 'math0', 0xae69881c: 'math1', 0xecf22628: 'math2', 0x83febfde: 'math3',
    0xdbf3aea2: 'sound0', 0xe38070a8: 'sound1',
  },
  esb: {
    0xef1e3ae5: 'banked', 0x62ce5c12: 'romA000', 0x27b0889b: 'romC000', 0xfd5c725e: 'romE000',
    0xea9e4dce: 'slap01', 0x76d07f59: 'slap23',
    0xb1f9bd12: 'vector', 0x82fc3eb2: 'avgProm',
    0xb8d0f69d: 'math0', 0x6a2a4d98: 'math1', 0x6a76138f: 'math2', 0xafbf6e01: 'math3',
    0x24ae3815: 'sound0', 0xca72d341: 'sound1',
  },
};
const OPTIONAL = ['sound0', 'sound1'];

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[i] = c;
}
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(buffer) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0 && i >= u8.length - 65557; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt zip directory');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    const dataStart = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = u8.subarray(dataStart, dataStart + csize);
    if (method === 0) files.push({ name, data: raw.slice() });
    else if (method === 8) files.push({ name, data: await inflateRaw(raw) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const lo = (rom) => rom.subarray(0, 0x2000), hi = (rom) => rom.subarray(0x2000, 0x4000);

function join(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// Returns the board's ROM layout:
//   bank6000: the two pages switched at 0x6000;  upper: one or two images of 0xa000-0xffff;
//   rom8000 or slapstic (four pages) for 0x8000-0x9fff;  sound: [address, data] pairs or null.
export async function loadRomSet(buffer) {
  const files = (await unzip(buffer)).map((f) => ({ crc: crc32(f.data), data: f.data }));
  let best = null;
  for (const [game, chips] of Object.entries(SETS)) {
    const found = {};
    for (const f of files) if (chips[f.crc]) found[chips[f.crc]] = f.data;
    const required = Object.values(chips).filter((r) => !OPTIONAL.includes(r));
    const missing = required.filter((r) => !found[r]).length;
    if (!best || missing < best.missing) best = { game, found, missing, total: required.length };
  }
  if (best.missing) throw new Error('ROM set not recognised: ' + best.missing + ' of ' + best.total + ' required chips missing');
  const { game, found } = best;
  const common = {
    game,
    bank6000: [lo(found.banked), hi(found.banked)],
    vector: found.vector,
    avgProm: found.avgProm,
    math: [found.math0, found.math1, found.math2, found.math3],
  };
  if (game === 'esb') {
    return {
      ...common,
      upper: [
        join(lo(found.romA000), lo(found.romC000), lo(found.romE000)),
        join(hi(found.romA000), hi(found.romC000), hi(found.romE000)),
      ],
      slapstic: [lo(found.slap01), hi(found.slap01), lo(found.slap23), hi(found.slap23)],
      sound: found.sound0 && found.sound1
        ? [[0x4000, lo(found.sound0)], [0xc000, hi(found.sound0)], [0x6000, lo(found.sound1)], [0xe000, hi(found.sound1)]]
        : null,
    };
  }
  return {
    ...common,
    upper: [join(found.romA000, found.romC000, found.romE000)],
    rom8000: found.rom8000,
    sound: found.sound0 && found.sound1
      ? [[0x4000, found.sound0], [0xc000, found.sound0], [0x6000, found.sound1], [0xe000, found.sound1]]
      : null,
  };
}
