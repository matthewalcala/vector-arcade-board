// Boots the board without a display and reports what the vector generator drew.
// usage: node tools/headless.mjs <rom.zip> [seconds] [out.svg] [out.wav]
import { readFileSync, writeFileSync } from 'node:fs';
import { loadRomSet } from '../web/js/romset.js';
import { Board, CPU_HZ } from '../web/js/board.js';
import { VIEW_W, VIEW_H } from '../web/js/avg.js';

const [zipPath, secondsArg, svgPath, wavPath] = process.argv.slice(2);
const RATE = 44100;
const pcm = [];
const seconds = Number(secondsArg || 5);
const buf = readFileSync(zipPath);
const roms = await loadRomSet(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const board = new Board(roms);
if (board.snd) board.snd.setSampleRate(RATE, CPU_HZ);

for (let s = 0; s < seconds * 10; s++) {
  for (let k = 0; k < 10; k++) {
    board.run(CPU_HZ / 100);
    if (board.snd) pcm.push(...board.snd.drain());
  }
  if (s % 10 === 9) {
    const f = board.avg.frame;
    let lit = 0;
    for (let i = 0; i < f.n; i++) if (f.inten[i]) lit++;
    console.log(`t=${(s + 1) / 10}s pc=${board.cpu.pc.toString(16)} lists=${board.avg.frameCount} points=${f.n} lit=${lit}` + (board.snd ? ` sndpc=${board.snd.cpu.pc.toString(16)} pokeyWrites=${board.snd.pokeyWrites} samples=${pcm.length}` : ''));
  }
}

if (svgPath) {
  const f = board.avg.frame;
  const colors = ['#000', '#00f', '#0f0', '#0ff', '#f00', '#f0f', '#ff0', '#fff'];
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" width="800" height="600" preserveAspectRatio="none" style="background:#000">`;
  for (let i = 1; i < f.n; i++) {
    if (!f.inten[i]) continue;
    out += `<line x1="${f.x[i - 1].toFixed(2)}" y1="${f.y[i - 1].toFixed(2)}" x2="${f.x[i].toFixed(2)}" y2="${f.y[i].toFixed(2)}" stroke="${colors[f.color[i]]}" stroke-opacity="${(f.inten[i] / 255).toFixed(2)}" stroke-width="0.5" stroke-linecap="round"/>`;
  }
  writeFileSync(svgPath, out + '</svg>');
  console.log('wrote', svgPath);
}

if (pcm.length) {
  let peak = 0, sq = 0, cross = 0;
  for (let i = 0; i < pcm.length; i++) {
    peak = Math.max(peak, Math.abs(pcm[i]));
    sq += pcm[i] * pcm[i];
    if (i && (pcm[i] > 0) !== (pcm[i - 1] > 0)) cross++;
  }
  console.log(`audio: ${(pcm.length / RATE).toFixed(1)}s peak=${peak.toFixed(3)} rms=${Math.sqrt(sq / pcm.length).toFixed(4)} zeroCrossings/s=${Math.round(cross / (pcm.length / RATE))}`);
  if (wavPath) {
    const out = Buffer.alloc(44 + pcm.length * 2);
    out.write('RIFF', 0); out.writeUInt32LE(36 + pcm.length * 2, 4); out.write('WAVEfmt ', 8);
    out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
    out.writeUInt32LE(RATE, 24); out.writeUInt32LE(RATE * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
    out.write('data', 36); out.writeUInt32LE(pcm.length * 2, 40);
    for (let i = 0; i < pcm.length; i++) out.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(pcm[i] * 32767))), 44 + i * 2);
    writeFileSync(wavPath, out);
    console.log('wrote', wavPath);
  }
}
