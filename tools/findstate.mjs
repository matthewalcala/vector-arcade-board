// Finds RAM bytes that single out the wave-select screen from attract mode and play.
// usage: node tools/findstate.mjs <rom.zip> [svg-out-dir]
import { readFileSync, writeFileSync } from 'node:fs';
import { loadRomSet } from '../web/js/romset.js';
import { Board, CPU_HZ } from '../web/js/board.js';
import { VIEW_W, VIEW_H } from '../web/js/avg.js';

const buf = readFileSync(process.argv[2]);
const outDir = process.argv[3];
const roms = await loadRomSet(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const b = new Board({ ...roms, sound: null });
b.stickX = b.stickY = 128;
const snap = () => b.mem.slice(0x4800, 0x5000);
const svg = (name) => {
  if (!outDir) return;
  const f = b.avg.frame;
  const colors = ['#000', '#00f', '#0f0', '#0ff', '#f00', '#f0f', '#ff0', '#fff'];
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" width="800" height="600" preserveAspectRatio="none" style="background:#000">`;
  for (let i = 1; i < f.n; i++) {
    if (!f.inten[i]) continue;
    out += `<line x1="${f.x[i - 1].toFixed(2)}" y1="${f.y[i - 1].toFixed(2)}" x2="${f.x[i].toFixed(2)}" y2="${f.y[i].toFixed(2)}" stroke="${colors[f.color[i]]}" stroke-width="0.6"/>`;
  }
  writeFileSync(`${outDir}/${name}.svg`, out + '</svg>');
};
const other = [], select = [];
for (const t of [8, 7, 10, 15, 20]) { b.run(CPU_HZ * t); other.push(snap()); }
b.in.fireL = b.in.fireR = true; b.run(CPU_HZ / 5);
b.in.fireL = b.in.fireR = false;
for (let i = 0; i < 6; i++) { b.run(CPU_HZ * 0.7); select.push(snap()); if (i === 2) svg('select'); }
svg('select-late');
// shoot whatever is under the crosshair, then play
for (let i = 0; i < 8; i++) {
  b.in.fireL = b.in.fireR = true; b.run(CPU_HZ / 5);
  b.in.fireL = b.in.fireR = false; b.run(CPU_HZ / 2);
}
for (const t of [3, 5, 10, 20]) { b.run(CPU_HZ * t); other.push(snap()); }
svg('play');
for (let i = 0; i < 0x800; i++) {
  const v = select[0][i];
  if (select.every((s) => s[i] === v) && other.every((s) => s[i] !== v)) {
    console.log((0x4800 + i).toString(16), 'select=' + v, 'other=' + other.map((s) => s[i]).join(','));
  }
}
