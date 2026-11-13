import { loadRomSet } from './romset.js';
import { Board, CPU_HZ } from './board.js';
import { VIEW_W, VIEW_H } from './avg.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const ctx = canvas.getContext('2d');
const setup = $('setup');
const msg = $('msg');

let board = null;
const stick = { x: 0.5, y: 0.5 }; // 0..1, screen-style (y down)
const IDLE_MS = 30000;
let lastInput = -Infinity;
const touched = () => { lastInput = performance.now(); };

// ---- storage -------------------------------------------------------------

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('vector-board', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function kvGet(key) {
  try {
    const db = await idb();
    return await new Promise((resolve) => {
      const r = db.transaction('kv').objectStore('kv').get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(undefined);
    });
  } catch { return undefined; }
}
async function kvSet(key, value) {
  try {
    const db = await idb();
    db.transaction('kv', 'readwrite').objectStore('kv').put(value, key);
  } catch { /* storage unavailable: run without persistence */ }
}

// ---- boot ----------------------------------------------------------------

async function start(buffer, remember) {
  const roms = await loadRomSet(buffer);
  if (remember) {
    kvSet('rom', buffer);
    // ask the browser not to clear this site's storage when space runs low
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }
  const nv = await kvGet('nvram');
  board = new Board(roms, nv instanceof Uint8Array && nv.length === 256 ? nv : null);
  board.onNvStore = (data) => kvSet('nvram', new Uint8Array(data));
  if (audioCtx && board.snd) board.snd.setSampleRate(audioCtx.sampleRate, CPU_HZ);
  setup.hidden = true;
  window.__board = board;
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

async function boot() {
  const saved = await kvGet('rom');
  if (saved) {
    try { await start(saved, false); return; } catch { /* fall through to picker */ }
  }
  try {
    const res = await fetch('dev-rom.zip');
    if (res.ok) { await start(await res.arrayBuffer(), false); return; }
  } catch { /* no dev rom */ }
}

$('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    await start(await file.arrayBuffer(), true);
  } catch (err) {
    msg.textContent = err.message;
  }
});

// ---- audio ---------------------------------------------------------------

// Each frame's samples are queued as a short buffer scheduled right after the
// previous one. Plain buffer sources are the most dependable path on iOS Safari.
let audioCtx = null, audioNext = 0;
const audioStat = { buffers: 0, state: 'none' };
window.__audio = audioStat;
const soundTag = $('sound');

function pushAudio(samples) {
  if (!samples.length || audioCtx.state !== 'running') return;
  const now = audioCtx.currentTime;
  if (audioNext < now + 0.02 || audioNext > now + 0.3) audioNext = now + 0.06;
  const buf = audioCtx.createBuffer(1, samples.length, audioCtx.sampleRate);
  buf.getChannelData(0).set(samples);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(audioCtx.destination);
  src.start(audioNext);
  audioNext += buf.duration;
  audioStat.buffers++;
}

function showAudioState() {
  audioStat.state = audioCtx ? audioCtx.state : 'none';
  soundTag.textContent = audioStat.state === 'running' ? '' : 'TAP FOR SOUND';
}

// Keep the phone from dimming mid-game; has to be asked for from a gesture too.
let wakeLock = null;
function keepAwake() {
  if (wakeLock || !navigator.wakeLock) return;
  navigator.wakeLock.request('screen').then((w) => {
    wakeLock = w;
    w.addEventListener('release', () => { wakeLock = null; });
  }, () => {});
}

// Browsers only allow sound to start from inside a touch or key handler.
function unlockAudio() {
  keepAwake();
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { soundTag.textContent = 'NO AUDIO SUPPORT'; return; }
    audioCtx = new Ctx();
    audioCtx.onstatechange = showAudioState;
    if (board && board.snd) board.snd.setSampleRate(audioCtx.sampleRate, CPU_HZ);
  }
  if (audioCtx.state !== 'running') {
    const p = audioCtx.resume();
    if (p && p.then) p.then(showAudioState, showAudioState);
    // iOS wants a sound actually started inside the gesture
    const src = audioCtx.createBufferSource();
    src.buffer = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
    src.connect(audioCtx.destination);
    src.start(0);
  }
  showAudioState();
}
for (const ev of ['touchstart', 'touchend', 'pointerup', 'mouseup', 'click', 'keydown']) {
  document.addEventListener(ev, unlockAudio, { capture: true, passive: true });
}

// ---- rendering -----------------------------------------------------------

const COLORS = ['0,0,0', '60,90,255', '40,255,70', '60,255,255', '255,50,50', '255,70,255', '255,255,70', '255,255,255'];

function resize() {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

function draw() {
  resize();
  const w = canvas.width, h = canvas.height;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  if (!board) return;
  const f = board.avg.frame;
  const sx = w / VIEW_W, sy = h / VIEW_H;
  const base = Math.max(1, h / 420);
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (let pass = 0; pass < 2; pass++) {
    ctx.lineWidth = pass === 0 ? base * 3.5 : base;
    for (let i = 1; i < f.n; i++) {
      const inten = f.inten[i];
      if (!inten) continue;
      const a = Math.pow(inten / 255, 0.6) * (pass === 0 ? 0.22 : 1);
      ctx.strokeStyle = 'rgba(' + COLORS[f.color[i]] + ',' + a.toFixed(3) + ')';
      const x0 = f.x[i - 1] * sx, y0 = f.y[i - 1] * sy, x1 = f.x[i] * sx, y1 = f.y[i] * sy;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(Math.abs(x1 - x0) + Math.abs(y1 - y0) < 0.5 ? x0 + 0.5 : x1, y1);
      ctx.stroke();
    }
  }
}

let last = 0;
function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (board) {
    if (now - lastInput > IDLE_MS) {
      // The game learns the yoke's range from the extremes it sees. While nobody is
      // playing, show it both ends so the next game starts fully calibrated.
      board.stickX = board.stickY = (Math.floor(board.clock / (CPU_HZ / 4)) & 1) ? 255 : 0;
    } else {
      // stick is where the crosshair should be on screen; undo the game's own scaling
      board.stickX = Math.round(clamp01((stick.x + 0.055) / 1.11) * 255);
      board.stickY = Math.round((1 - clamp01((stick.y - 0.111) / 1.07)) * 255);
    }
    board.run(Math.round(dt * CPU_HZ));
    if (board.snd) { const samples = board.snd.drain(); if (audioCtx) pushAudio(samples); }
  }
  draw();
}

// ---- input ---------------------------------------------------------------

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// A tap can be shorter than one emulation frame, so keep the trigger held a minimum time.
const MIN_FIRE_MS = 70;
let fireDownAt = 0, fireTimer = null;
function applyFire(on) {
  if (board) board.in.fireL = board.in.fireR = board.in.thumbL = board.in.thumbR = on;
}
function setFire(on) {
  touched();
  $('fire').classList.toggle('on', on);
  clearTimeout(fireTimer);
  if (on) {
    fireDownAt = performance.now();
    applyFire(true);
    return;
  }
  const wait = MIN_FIRE_MS - (performance.now() - fireDownAt);
  if (wait > 0) fireTimer = setTimeout(() => applyFire(false), wait);
  else applyFire(false);
}

// fire zone: any finger down fires
const firePointers = new Set();
const fire = $('fire');
fire.addEventListener('pointerdown', (e) => { e.preventDefault(); fire.setPointerCapture(e.pointerId); firePointers.add(e.pointerId); setFire(true); });
for (const ev of ['pointerup', 'pointercancel']) {
  fire.addEventListener(ev, (e) => { firePointers.delete(e.pointerId); if (!firePointers.size) setFire(false); });
}

// aim pad: relative, like a trackpad. The crosshair stays where you leave it.
const pad = $('pad');
const touchRing = $('touch');
const PAD_TRAVEL = 110; // px of thumb travel for the full range
let padPointer = null, padLast = null;
pad.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  pad.setPointerCapture(e.pointerId);
  padPointer = e.pointerId;
  padLast = { x: e.clientX, y: e.clientY };
  pad.classList.add('on');
  // brief ring where the thumb landed
  touchRing.style.left = e.clientX + 'px';
  touchRing.style.top = e.clientY + 'px';
  touchRing.animate(
    [{ opacity: 0.7, transform: 'scale(0.6)' }, { opacity: 0, transform: 'scale(1.25)' }],
    { duration: 450, easing: 'ease-out' },
  );
});
pad.addEventListener('pointermove', (e) => {
  if (e.pointerId !== padPointer) return;
  stick.x = clamp01(stick.x + (e.clientX - padLast.x) / PAD_TRAVEL);
  stick.y = clamp01(stick.y + (e.clientY - padLast.y) / PAD_TRAVEL);
  padLast = { x: e.clientX, y: e.clientY };
  touched();
});
for (const ev of ['pointerup', 'pointercancel']) {
  pad.addEventListener(ev, (e) => { if (e.pointerId === padPointer) { padPointer = null; pad.classList.remove('on'); } });
}

// game screen: absolute. The crosshair goes where you touch.
const screen = $('screen');
function aimAt(e) {
  touched();
  const r = screen.getBoundingClientRect();
  stick.x = clamp01((e.clientX - r.left) / r.width);
  stick.y = clamp01((e.clientY - r.top) / r.height);
}
let screenPointer = null;
screen.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  screen.setPointerCapture(e.pointerId);
  screenPointer = e.pointerId;
  aimAt(e);
  if (e.pointerType === 'mouse') setFire(true);
});
screen.addEventListener('pointermove', (e) => {
  if (e.pointerId === screenPointer || e.pointerType === 'mouse') aimAt(e);
});
for (const ev of ['pointerup', 'pointercancel']) {
  screen.addEventListener(ev, (e) => {
    if (e.pointerId === screenPointer) screenPointer = null;
    if (e.pointerType === 'mouse') setFire(false);
  });
}

// landscape picture shape: stretched to fill, or the cabinet's 4:3
const shape = $('shape');
function setFit(fit) {
  $('app').classList.toggle('fit', fit);
  shape.textContent = fit ? 'WIDE' : '4:3';
  try { localStorage.setItem('fit', fit ? '1' : ''); } catch { /* not remembered */ }
}
shape.addEventListener('click', () => setFit(!$('app').classList.contains('fit')));
let savedFit = false;
try { savedFit = !!localStorage.getItem('fit'); } catch { /* default */ }
setFit(savedFit);

// keyboard, for desktop testing
const keys = new Set();
addEventListener('keydown', (e) => {
  if (e.code === 'Space') { setFire(true); e.preventDefault(); }
  keys.add(e.code);
});
addEventListener('keyup', (e) => {
  if (e.code === 'Space') setFire(false);
  keys.delete(e.code);
});
setInterval(() => {
  const s = 0.02;
  if (keys.size) touched();
  if (keys.has('ArrowLeft')) stick.x = clamp01(stick.x - s);
  if (keys.has('ArrowRight')) stick.x = clamp01(stick.x + s);
  if (keys.has('ArrowUp')) stick.y = clamp01(stick.y - s);
  if (keys.has('ArrowDown')) stick.y = clamp01(stick.y + s);
}, 16);

document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('contextmenu', (e) => e.preventDefault());

boot();
requestAnimationFrame(tick);
