// Measures crosshair position (fraction of screen) for stick fractions after an attract-mode sweep of the yoke extremes.
import { readFileSync } from 'node:fs';
import { loadRomSet } from '../web/js/romset.js';
import { Board, CPU_HZ } from '../web/js/board.js';

const buf = readFileSync(process.argv[2]);
const roms = await loadRomSet(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const sweepAt = Number(process.argv[3] || 6);

function crosshair(board) {
  const f = board.avg.frame;
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (let i = 0; i < f.n; i++) if (f.inten[i] && f.color[i] === 3) { x0 = Math.min(x0, f.x[i]); x1 = Math.max(x1, f.x[i]); y0 = Math.min(y0, f.y[i]); y1 = Math.max(y1, f.y[i]); }
  return [(x0 + x1) / 2 / 250, (y0 + y1) / 2 / 280];
}

const b = new Board(roms);
b.run(CPU_HZ * sweepAt);
for (let t = 0; t < 8; t++) { b.stickX = b.stickY = (t & 1) ? 255 : 0; b.run(CPU_HZ / 4); }
b.stickX = b.stickY = 128;
b.run(CPU_HZ * 3);
b.in.fireL = b.in.fireR = true; b.run(CPU_HZ * 0.3); b.in.fireL = b.in.fireR = false;
b.run(CPU_HZ * 9);
for (const u of [0.1, 0.3, 0.5, 0.7, 0.9]) {
  b.stickX = Math.round(u * 255);
  b.stickY = Math.round((1 - u) * 255);
  b.run(CPU_HZ * 1.5);
  const [cx, cy] = crosshair(b);
  console.log('u', u, 'crosshair x', cx.toFixed(3), 'y', cy.toFixed(3));
}
