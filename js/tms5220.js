// TMS5220 speech synthesiser, speak-external mode only (data fed by the CPU).
// It decodes LPC frames from a 16-byte FIFO and runs a 10-stage lattice filter.
//
// The parameter tables below are the chip's internal ROM values as documented in
// MAME's tms5110r.hxx (BSD-3-Clause; Frank Palazzolo, Couriersud, Jonathan Gevaryahu).

const ENERGY = [0, 1, 2, 3, 4, 6, 8, 11, 16, 23, 33, 47, 63, 85, 114, 0];
const PITCH = [
  0, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
  30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 44, 46, 48,
  50, 52, 53, 56, 58, 60, 62, 65, 68, 70, 72, 76, 78, 80, 84, 86,
  91, 94, 98, 101, 105, 109, 114, 118, 122, 127, 132, 137, 142, 148, 153, 159,
];
const K = [
  [-501, -498, -497, -495, -493, -491, -488, -482, -478, -474, -469, -464, -459, -452, -445, -437,
    -412, -380, -339, -288, -227, -158, -81, -1, 80, 157, 226, 287, 337, 379, 411, 436],
  [-328, -303, -274, -244, -211, -175, -138, -99, -59, -18, 24, 64, 105, 143, 180, 215,
    248, 278, 306, 331, 354, 374, 392, 408, 422, 435, 445, 455, 463, 470, 476, 506],
  [-441, -387, -333, -279, -225, -171, -117, -63, -9, 45, 98, 152, 206, 260, 314, 368],
  [-328, -273, -217, -161, -106, -50, 5, 61, 116, 172, 228, 283, 339, 394, 450, 506],
  [-328, -282, -235, -189, -142, -96, -50, -3, 43, 90, 136, 182, 229, 275, 322, 368],
  [-256, -212, -168, -123, -79, -35, 10, 54, 98, 143, 187, 232, 276, 320, 365, 409],
  [-308, -260, -212, -164, -117, -69, -21, 27, 75, 122, 170, 218, 266, 314, 361, 409],
  [-256, -161, -66, 29, 124, 219, 314, 409],
  [-256, -176, -96, -15, 65, 146, 226, 307],
  [-205, -132, -59, 14, 87, 160, 234, 307],
];
const K_BITS = [5, 5, 4, 4, 4, 4, 4, 3, 3, 3];
const CHIRP = [0x00, 0x03, 0x0f, 0x28, 0x4c, 0x6c, 0x71, 0x50, 0x25, 0x26, 0x4c, 0x44, 0x1a, 0x32, 0x3b, 0x13, 0x37, 0x1a, 0x25, 0x1f, 0x1d];
const INTERP_SHIFT = [0, 3, 3, 3, 2, 2, 1, 1];
const SAMPLES_PER_PERIOD = 25; // 8 periods per 25 ms frame
const FIFO_SIZE = 16;

// 10-bit coefficient times 15-bit signal, as the chip's serial multiplier does it
function mul(a, b) {
  a = ((a + 512) & 1023) - 512;
  b = ((b + 16384) & 32767) - 16384;
  return (a * b) >> 9;
}

export class Speech {
  constructor() {
    this.fifo = new Uint8Array(FIFO_SIZE);
    this.x = new Int32Array(10);
    this.u = new Int32Array(11);
    this.curK = new Int32Array(10);
    this.tgtK = new Int32Array(10);
    this.kIdx = new Uint8Array(10);
    this.frames = 0;
    this.reset();
  }

  reset() {
    this.head = this.tail = this.count = this.bitsTaken = 0;
    this.external = false; // "speak external": bytes written are speech data, not commands
    this.talking = false;
    this.rng = 0x1fff;
  }

  // READY line: only busy while the FIFO is full
  get ready() { return !this.external || this.count < FIFO_SIZE; }

  write(v) {
    if (this.external) {
      if (this.count >= FIFO_SIZE) return;
      this.fifo[this.tail] = v;
      this.tail = (this.tail + 1) % FIFO_SIZE;
      this.count++;
      if (!this.talking && this.count > FIFO_SIZE / 2) this.startTalking();
      return;
    }
    const cmd = v & 0x70;
    if (cmd === 0x60) {
      this.head = this.tail = this.count = this.bitsTaken = 0;
      this.external = true;
    } else if (cmd === 0x70) {
      this.reset();
    }
  }

  startTalking() {
    this.talking = true;
    this.stopping = false;
    this.period = 1;
    this.sampleInPeriod = 0;
    this.curEnergy = this.tgtEnergy = this.prevEnergy = 0;
    this.curPitch = this.tgtPitch = 0;
    this.curK.fill(0);
    this.tgtK.fill(0);
    this.kIdx.set([0, 0, 0, 0, 15, 15, 15, 7, 7, 7]);
    this.pitchIdx = 0;
    this.oldUnvoiced = this.newUnvoiced = true;
    this.oldSilent = this.newSilent = true;
    this.inhibit = false;
    this.pitchCount = 0;
    this.x.fill(0);
    this.parseFrame();
  }

  stop() {
    this.talking = false;
    this.external = false;
    this.head = this.tail = this.count = this.bitsTaken = 0;
  }

  readBits(n) {
    let v = 0;
    while (n--) {
      if (!this.count) { this.ranOut = true; v <<= 1; continue; }
      v = (v << 1) | ((this.fifo[this.head] >> this.bitsTaken) & 1);
      if (++this.bitsTaken === 8) {
        this.bitsTaken = 0;
        this.head = (this.head + 1) % FIFO_SIZE;
        this.count--;
      }
    }
    return v;
  }

  parseFrame() {
    this.frames++;
    this.ranOut = false;
    const prevUnvoiced = this.newUnvoiced, prevSilent = this.newSilent;
    const energyIdx = this.readBits(4);
    let silent = energyIdx === 0;
    if (energyIdx === 15) this.stopping = true;
    if (!silent && energyIdx !== 15) {
      const repeat = this.readBits(1);
      this.pitchIdx = this.readBits(6);
      if (!repeat) {
        for (let i = 0; i < 4; i++) this.kIdx[i] = this.readBits(K_BITS[i]);
        if (this.pitchIdx) for (let i = 4; i < 10; i++) this.kIdx[i] = this.readBits(K_BITS[i]);
      }
    }
    if (this.ranOut) { this.stopping = true; silent = true; }
    const unvoiced = silent || energyIdx === 15 ? prevUnvoiced : this.pitchIdx === 0;
    const zero = silent || energyIdx === 15;
    this.tgtEnergy = zero ? 0 : ENERGY[energyIdx];
    this.tgtPitch = zero ? 0 : PITCH[this.pitchIdx];
    for (let i = 0; i < 10; i++) this.tgtK[i] = zero || (i >= 4 && unvoiced) ? 0 : K[i][this.kIdx[i]];
    this.newUnvoiced = unvoiced;
    this.newSilent = zero;
    // no smooth interpolation across a voicing change or out of silence
    this.inhibit = prevUnvoiced !== unvoiced || (prevSilent && !zero) || (prevUnvoiced && zero);
  }

  // One output sample (chip clock / 80). Returns -1..1.
  step() {
    if (!this.talking) return 0;

    if (this.sampleInPeriod === 0) {
      const p = this.period;
      if (p === 0) {
        this.curEnergy = this.tgtEnergy;
        this.curPitch = this.tgtPitch;
        this.curK.set(this.tgtK);
      } else if (!this.inhibit) {
        const s = INTERP_SHIFT[p];
        this.curEnergy += (this.tgtEnergy - this.curEnergy) >> s;
        this.curPitch += (this.tgtPitch - this.curPitch) >> s;
        for (let i = 0; i < 10; i++) this.curK[i] += (this.tgtK[i] - this.curK[i]) >> s;
      }
    }

    let exc;
    if (this.oldUnvoiced) exc = (this.rng & 1) ? -64 : 64;
    else exc = this.pitchCount < CHIRP.length ? CHIRP[this.pitchCount] : 0;
    for (let i = 0; i < 20; i++) {
      const bit = ((this.rng >> 12) ^ (this.rng >> 3) ^ (this.rng >> 2) ^ this.rng) & 1;
      this.rng = ((this.rng << 1) | bit) & 0x1fff;
    }

    const u = this.u, x = this.x, k = this.curK;
    u[10] = mul(this.prevEnergy, exc << 6);
    for (let i = 9; i >= 0; i--) u[i] = u[i + 1] - mul(k[i], x[i]);
    for (let i = 9; i >= 1; i--) x[i] = x[i - 1] + mul(k[i - 1], u[i - 1]);
    x[0] = u[0];
    this.prevEnergy = this.curEnergy;

    let out = ((u[0] + 16384) & 32767) - 16384;
    if (out > 2047) out = 2047; else if (out < -2048) out = -2048;

    this.pitchCount++;
    if (this.pitchCount >= this.curPitch || (this.inhibit && this.period === 0)) this.pitchCount = 0;

    if (++this.sampleInPeriod === SAMPLES_PER_PERIOD) {
      this.sampleInPeriod = 0;
      if (this.period === 7) {
        // end of the interpolated part of the frame: voicing switches over here
        this.oldUnvoiced = this.newUnvoiced;
        this.oldSilent = this.newSilent;
        if (this.stopping) { this.stop(); return out / 2048; }
        this.period = 0;
      } else if (this.period === 0) {
        this.period = 1;
        this.parseFrame();
      } else {
        this.period++;
      }
    }
    return out / 2048;
  }
}
