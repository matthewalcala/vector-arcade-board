// Reads a ROM zip and picks out the chips by CRC32, so file names don't matter.

const CHIPS = {
  0x04f1876e: 'banked',
  0xf725e344: 'rom8000',
  0xf6da0a00: 'romA000',
  0x7e406703: 'romC000',
  0xc7e51237: 'romE000',
  0x538e7d2f: 'vector',
  0x82fc3eb2: 'avgProm',
  0x810e040e: 'math0',
  0xae69881c: 'math1',
  0xecf22628: 'math2',
  0x83febfde: 'math3',
  0xdbf3aea2: 'sound0',
  0xe38070a8: 'sound1',
};
const REQUIRED = ['banked', 'rom8000', 'romA000', 'romC000', 'romE000', 'vector', 'avgProm', 'math0', 'math1', 'math2', 'math3'];

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

export async function loadRomSet(buffer) {
  const found = {};
  for (const f of await unzip(buffer)) {
    const role = CHIPS[crc32(f.data)];
    if (role) found[role] = f.data;
  }
  const missing = REQUIRED.filter((r) => !found[r]);
  if (missing.length) throw new Error('ROM set not recognised: ' + missing.length + ' of ' + REQUIRED.length + ' required chips missing');
  return {
    bank0: found.banked.subarray(0, 0x2000),
    bank1: found.banked.subarray(0x2000, 0x4000),
    rom8000: found.rom8000,
    romA000: found.romA000,
    romC000: found.romC000,
    romE000: found.romE000,
    vector: found.vector,
    avgProm: found.avgProm,
    math: [found.math0, found.math1, found.math2, found.math3],
    sound: found.sound0 && found.sound1 ? [found.sound0, found.sound1] : null,
  };
}
