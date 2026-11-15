// Finds RAM bytes that track the starting-shields switch after a game starts.
// usage: node tools/findshields.mjs <rom.zip>
import { readFileSync } from 'node:fs';
import { loadRomSet } from '../web/js/romset.js';
import { Board, CPU_HZ } from '../web/js/board.js';

const buf = readFileSync(process.argv[2]);
const roms = await loadRomSet(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const snaps = [];
for (let n = 0; n < 4; n++) {
  const b = new Board({ ...roms, sound: null });
  b.dsw0 = 0x94 | n;
  b.stickX = b.stickY = 128;
  b.run(CPU_HZ * 8);
  for (let i = 0; i < 6; i++) {
    b.in.fireL = b.in.fireR = true; b.run(CPU_HZ / 5);
    b.in.fireL = b.in.fireR = false; b.run(CPU_HZ / 2);
  }
  b.run(CPU_HZ * 4);
  snaps.push(b.mem.slice(0x4800, 0x6000));
}
for (let i = 0; i < snaps[0].length; i++) {
  const v = snaps.map((s) => s[i]);
  if (v[1] - v[0] === 1 && v[2] - v[0] === 2 && v[3] - v[0] === 3) console.log((0x4800 + i).toString(16), v.join(' '));
}
