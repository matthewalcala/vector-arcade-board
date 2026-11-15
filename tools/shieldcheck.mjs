// Plays a game without touching the controls and logs the shield counter.
// usage: node tools/shieldcheck.mjs <rom.zip> [hold]   ("hold" restores each lost shield)
import { readFileSync } from 'node:fs';
import { loadRomSet } from '../web/js/romset.js';
import { Board, CPU_HZ } from '../web/js/board.js';

const buf = readFileSync(process.argv[2]);
const roms = await loadRomSet(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const b = new Board({ ...roms, sound: null });
b.cheat = process.argv[3] === 'hold';
b.stickX = b.stickY = 128;
b.run(CPU_HZ * 8);
for (let i = 0; i < 6; i++) {
  b.in.fireL = b.in.fireR = true; b.run(CPU_HZ / 5);
  b.in.fireL = b.in.fireR = false; b.run(CPU_HZ / 2);
}
let last = '';
for (let t = 0; t < 1200; t++) {
  b.run(CPU_HZ / 10);
  const now = `${b.mem[0x4860]} ${b.mem[0x488e]}`;
  if (now !== last) { console.log(`t=${(t / 10).toFixed(1)}s 4860=${b.mem[0x4860]} 488e=${b.mem[0x488e]}`); last = now; }
}
