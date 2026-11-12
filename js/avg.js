// Analog vector generator: a PROM-driven state machine that walks a display
// list in the main CPU's address space and emits beam positions.

const X_CENTER = 125 * 65536;
const Y_CENTER = 140 * 65536;
const MAX_POINTS = 20000;
const DAC_W3 = 1, DAC_W2 = 0.5, DAC_W1 = 12 / 47;
const DAC_FULL = DAC_W3 + DAC_W2 + DAC_W1;

export const VIEW_W = 250;
export const VIEW_H = 280;

export class AVG {
  constructor(mem, prom) {
    this.mem = mem;
    this.prom = prom;
    this.state = 0;
    this.op = 0;
    this.pc = 0;
    this.sp = 0;
    this.stack = [0, 0, 0, 0];
    this.dvx = this.dvy = this.dvy12 = 0;
    this.timer = 0;
    this.intLatch = 0;
    this.binScale = this.scale = 0;
    this.color = this.intensity = 0;
    this.halt = 1;
    this.xpos = X_CENTER;
    this.ypos = Y_CENTER;
    // working buffer for the list being generated
    this.n = 0;
    this.px = new Float32Array(MAX_POINTS);
    this.py = new Float32Array(MAX_POINTS);
    this.pc3 = new Uint8Array(MAX_POINTS);
    this.pi = new Uint8Array(MAX_POINTS);
    // list handed to the renderer
    this.frame = { n: 0, x: new Float32Array(MAX_POINTS), y: new Float32Array(MAX_POINTS), color: new Uint8Array(MAX_POINTS), inten: new Uint8Array(MAX_POINTS) };
    this.frameCount = 0;
  }

  reset() {
    this.state = 0;
    this.binScale = 0;
    this.scale = 0;
    this.color = 0;
    this.halt = 1;
  }

  point(x, y, color, inten) {
    if (this.n >= MAX_POINTS) return;
    const i = this.n++;
    this.px[i] = x / 65536;
    this.py[i] = y / 65536;
    this.pc3[i] = color;
    this.pi[i] = inten;
  }

  shiftTimer() {
    this.timer = (this.timer >> 1) | 0x4000 | ((this.op & 2) << 6);
  }

  // Runs the display list to its HALT. Returns elapsed time in master clock ticks.
  go() {
    this.pc = 0;
    this.sp = 0;
    this.halt = 0;
    this.n = 0;
    let ticks = 0;
    let settle = 16;
    for (let guard = 0; guard < 4000000 && settle > 0; guard++) {
      if (this.halt) settle--;
      const addr = (((this.state >> 4) ^ 1) << 7) | (this.op << 4) | (this.state & 0xf);
      this.state = (this.state & 0x10) | (this.prom[addr] & 0xf);
      if (this.state & 8) ticks += this.strobe(this.state & 7, this.mem[this.pc & 0x3fff]);
      this.state = (this.halt << 4) | (this.state & 0xf);
      if (!this.halt) ticks += 8;
    }
    this.halt = 1;
    this.publish();
    return ticks;
  }

  publish() {
    const f = this.frame;
    const start = this.n > 10 ? 0 : f.n;
    const count = Math.min(this.n, MAX_POINTS - start);
    f.x.set(this.px.subarray(0, count), start);
    f.y.set(this.py.subarray(0, count), start);
    f.color.set(this.pc3.subarray(0, count), start);
    f.inten.set(this.pi.subarray(0, count), start);
    f.n = start + count;
    this.frameCount++;
  }

  strobe(which, data) {
    const op0 = this.op & 1, op1 = this.op & 2, op2 = this.op & 4;
    switch (which) {
      case 0:
        this.dvy = (this.dvy & 0x1f00) | data;
        this.pc++;
        return 0;
      case 1:
        this.dvy12 = (data >> 4) & 1;
        this.op = data >> 5;
        this.intLatch = 0;
        this.dvy = (this.dvy12 << 12) | ((data & 0xf) << 8);
        this.dvx = 0;
        this.pc++;
        return 0;
      case 2:
        this.dvx = (this.dvx & 0x1f00) | data;
        this.pc++;
        return 0;
      case 3:
        this.intLatch = data >> 4;
        this.dvx = ((this.intLatch & 1) << 12) | ((data & 0xf) << 8) | (this.dvx & 0xff);
        this.pc++;
        return 0;
      case 4:
        if (op0) {
          this.stack[this.sp & 3] = this.pc;
        } else {
          // normalise: shift both deltas up until one uses its top bit
          let i = 0;
          while (((this.dvy ^ (this.dvy << 1)) & 0x1000) === 0 && ((this.dvx ^ (this.dvx << 1)) & 0x1000) === 0 && i++ < 16) {
            this.dvy = (this.dvy & 0x1000) | ((this.dvy << 1) & 0x1fff);
            this.dvx = (this.dvx & 0x1000) | ((this.dvx << 1) & 0x1fff);
            this.shiftTimer();
          }
          if (op1) this.timer &= 0xff;
        }
        return 0;
      case 5:
        if (!op2) {
          for (let i = this.binScale; i > 0; i--) this.shiftTimer();
          if (op1) this.timer &= 0xff;
        } else {
          this.sp = (this.sp + (op1 ? -1 : 1)) & 0xf;
        }
        return 0;
      case 6:
        if (op2) {
          this.pc = op0 ? this.dvy << 1 : this.stack[this.sp & 3];
        } else if (this.dvy12) {
          this.scale = this.dvy & 0xff;
          this.binScale = (this.dvy >> 8) & 7;
        } else {
          this.intensity = this.dvy & 0xff;
          this.color = (this.dvy >> 8) & 0xf;
        }
        return 0;
      default: {
        let cycles = 0;
        this.halt = op0;
        if (!op0 && !op2) {
          cycles = op1 ? 0x100 - (this.timer & 0xff) : 0x8000 - this.timer;
          this.timer = 0;
          const k = cycles * (this.scale ^ 0xff);
          this.xpos += Math.floor((((this.dvx >> 3) ^ 0x200) - 0x200) * k / 16);
          this.ypos -= Math.floor((((this.dvy >> 3) ^ 0x200) - 0x200) * k / 16);
          const il = this.intLatch;
          const dac = ((il >> 3) & 1) * DAC_W3 + ((il >> 2) & 1) * DAC_W2 + ((il >> 1) & 1) * DAC_W1;
          this.point(this.xpos, this.ypos, this.color & 7, Math.round(dac / DAC_FULL * this.intensity));
        }
        if (op2) {
          cycles = 0x8000 - this.timer;
          this.timer = 0;
          this.xpos = X_CENTER;
          this.ypos = Y_CENTER;
          this.point(this.xpos, this.ypos, 0, 0);
        }
        return cycles;
      }
    }
  }
}
