// Starts a game and reports what the speech chip decoded; optionally writes a WAV.
// usage: node tools/speechcheck.mjs <rom.zip> [out.wav]
import { readFileSync, writeFileSync } from 'node:fs';
import { loadRomSet } from '../web/js/romset.js';
import { Board, CPU_HZ } from '../web/js/board.js';
const RATE = 44100;
const buf = readFileSync(process.argv[2]);
const b = new Board(await loadRomSet(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
const s = b.snd, sp = s.speech;
s.setSampleRate(RATE, CPU_HZ);
let bytes = 0, starts = 0, stops = 0, underruns = 0, peak = 0, talkSamples = 0;
const w = sp.write.bind(sp); sp.write = (v) => { bytes++; w(v); };
const st = sp.startTalking.bind(sp); sp.startTalking = () => { starts++; st(); };
const stp = sp.stop.bind(sp); sp.stop = () => { stops++; if (sp.ranOut) underruns++; stp(); };
const step = sp.step.bind(sp); sp.step = () => { const v = step(); if (sp.talking) talkSamples++; peak = Math.max(peak, Math.abs(v)); return v; };
const pcm = [];
const run = (sec) => { for (let i = 0; i < sec * 100; i++) { b.run(CPU_HZ / 100); pcm.push(...s.drain()); } };
const report = (label) => { console.log(label.padEnd(12), `bytes=${bytes} utterances=${starts} ended=${stops} underruns=${underruns} frames=${sp.frames} talking=${(talkSamples / 8400).toFixed(2)}s peak=${peak.toFixed(3)}`); };
run(8); report('attract 8s');
b.in.fireL = b.in.fireR = true; run(0.3); b.in.fireL = b.in.fireR = false;
run(12); report('game +12s');
if (process.argv[3]) {
  const out = Buffer.alloc(44 + pcm.length * 2);
  out.write('RIFF', 0); out.writeUInt32LE(36 + pcm.length * 2, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(RATE, 24); out.writeUInt32LE(RATE * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) out.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(pcm[i] * 32767))), 44 + i * 2);
  writeFileSync(process.argv[3], out);
  console.log('wrote', process.argv[3]);
}
