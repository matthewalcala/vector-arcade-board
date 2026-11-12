// Sound board: second 6809, a 6532 RIOT (timer + ports), four POKEYs, and the
// two latches that link it to the main CPU, and the speech chip hung off the RIOT ports.
import { CPU6809 } from './cpu6809.js';
import { Speech } from './tms5220.js';

const SPEECH_PERIOD = 180; // CPU cycles per speech sample: (master / 18) / 80 = 8400 Hz

function lfsr(bits, tap) {
  const len = (1 << bits) - 1;
  const out = new Uint8Array(len);
  let r = len;
  for (let i = 0; i < len; i++) {
    out[i] = r & 1;
    r = (r >> 1) | (((r ^ (r >> tap)) & 1) << (bits - 1));
  }
  return out;
}
const POLY4 = lfsr(4, 1), POLY5 = lfsr(5, 2), POLY9 = lfsr(9, 5), POLY17 = lfsr(17, 5);

class Pokey {
  constructor() {
    this.audf = new Uint8Array(4);
    this.audc = new Uint8Array(4);
    this.ctl = 0;
    this.cnt = new Int32Array(4).fill(1);
    this.period = new Int32Array(4).fill(28);
    this.out = new Uint8Array(4);
    this.hp = new Uint8Array(2);
    this.t = 0;
  }

  write(reg, v) {
    if (reg < 8) {
      if (reg & 1) this.audc[reg >> 1] = v; else this.audf[reg >> 1] = v;
    } else if (reg === 8) {
      this.ctl = v;
    } else if (reg === 9) {
      this.updatePeriods();
      this.cnt.set(this.period);
      return;
    } else return;
    this.updatePeriods();
  }

  updatePeriods() {
    const f = this.audf, ctl = this.ctl, base = (ctl & 1) ? 114 : 28;
    this.period[0] = (ctl & 0x40) ? f[0] + 4 : (f[0] + 1) * base;
    this.period[1] = (ctl & 0x10) ? ((ctl & 0x40) ? f[1] * 256 + f[0] + 7 : (f[1] * 256 + f[0] + 1) * base) : (f[1] + 1) * base;
    this.period[2] = (ctl & 0x20) ? f[2] + 4 : (f[2] + 1) * base;
    this.period[3] = (ctl & 0x08) ? ((ctl & 0x20) ? f[3] * 256 + f[2] + 7 : (f[3] * 256 + f[2] + 1) * base) : (f[3] + 1) * base;
  }

  // advance by a number of chip clocks and return the mixed level (0..60)
  step(clocks) {
    this.t += clocks;
    const ctl = this.ctl;
    for (let ch = 0; ch < 4; ch++) {
      let cnt = this.cnt[ch] - clocks;
      if (cnt <= 0) {
        const c = this.audc[ch], period = this.period[ch];
        do {
          const at = this.t + cnt;
          if ((c & 0x80) || POLY5[at % 31]) {
            if (c & 0x20) this.out[ch] ^= 1;
            else if (c & 0x40) this.out[ch] = POLY4[at % 15];
            else this.out[ch] = (ctl & 0x80) ? POLY9[at % 511] : POLY17[at % 131071];
          }
          if (ch === 2) this.hp[0] = this.out[0];
          if (ch === 3) this.hp[1] = this.out[1];
          cnt += period;
        } while (cnt <= 0);
      }
      this.cnt[ch] = cnt;
    }
    let sum = 0;
    for (let ch = 0; ch < 4; ch++) {
      const c = this.audc[ch];
      let on = this.out[ch];
      if (ch === 0 && (ctl & 4)) on ^= this.hp[0];
      if (ch === 1 && (ctl & 2)) on ^= this.hp[1];
      if ((c & 0x10) || on) sum += c & 0x0f;
    }
    return sum;
  }
}

class Riot {
  constructor() {
    this.ram = new Uint8Array(128);
    this.dra = this.ddra = this.drb = this.ddrb = 0;
    this.paIn = 0xff;
    this.timer = 0xff; this.shift = 0; this.sub = 0; this.wrapped = true;
    this.timerFlag = false; this.timerIrq = false;
    this.pa7Flag = false; this.pa7Irq = false; this.pa7Rising = false;
    this.onPortA = null;
  }

  // pins as seen from outside: outputs drive, inputs float high
  get paOut() { return (this.dra & this.ddra) | (~this.ddra & 0xff); }
  get pbOut() { return (this.drb & this.ddrb) | (~this.ddrb & 0xff); }

  get irq() { return (this.timerFlag && this.timerIrq) || (this.pa7Flag && this.pa7Irq); }

  setPa(bit, state) {
    const mask = 1 << bit;
    const old = this.paIn & mask;
    this.paIn = state ? this.paIn | mask : this.paIn & ~mask;
    if (bit === 7 && !!old !== !!state && !!state === this.pa7Rising) this.pa7Flag = true;
  }

  tick(cycles) {
    if (this.wrapped) {
      const t = this.timer - cycles;
      if (t < 0) this.timerFlag = true;
      this.timer = t & 0xff;
      return;
    }
    this.sub += cycles;
    const period = 1 << this.shift;
    while (this.sub >= period) {
      this.sub -= period;
      if (this.timer === 0) {
        this.timer = 0xff;
        this.timerFlag = true;
        this.wrapped = true;
        this.timer = (this.timer - this.sub) & 0xff;
        this.sub = 0;
        return;
      }
      this.timer--;
    }
  }

  read(a) {
    if (!(a & 4)) {
      switch (a & 3) {
        case 0: return (this.dra & this.ddra) | (this.paIn & ~this.ddra);
        case 1: return this.ddra;
        case 2: return (this.drb & this.ddrb) | (0x60 & ~this.ddrb); // speech status is never strobed by this board's program
        default: return this.ddrb;
      }
    }
    if (a & 1) {
      const v = (this.timerFlag ? 0x80 : 0) | (this.pa7Flag ? 0x40 : 0);
      this.pa7Flag = false;
      return v;
    }
    this.timerFlag = false;
    this.timerIrq = !!(a & 8);
    return this.timer;
  }

  write(a, v) {
    if (!(a & 4)) {
      switch (a & 3) {
        case 0: this.dra = v; if (this.onPortA) this.onPortA(); break;
        case 1: this.ddra = v; if (this.onPortA) this.onPortA(); break;
        case 2: this.drb = v; break;
        default: this.ddrb = v; break;
      }
      return;
    }
    if (a & 0x10) {
      this.timer = v;
      this.shift = [0, 3, 6, 10][a & 3];
      this.sub = 0;
      this.wrapped = false;
      this.timerFlag = false;
      this.timerIrq = !!(a & 8);
    } else {
      this.pa7Irq = !!(a & 2);
      this.pa7Rising = !!(a & 1);
    }
  }
}

export class SoundBoard {
  constructor(roms) {
    this.mem = new Uint8Array(0x10000).fill(0xff);
    this.mem.set(roms[0], 0x4000); this.mem.set(roms[0], 0xc000);
    this.mem.set(roms[1], 0x6000); this.mem.set(roms[1], 0xe000);
    this.mem.fill(0, 0x2000, 0x2800);
    this.riot = new Riot();
    this.pokey = [new Pokey(), new Pokey(), new Pokey(), new Pokey()];
    this.speech = new Speech();
    this.speechLevel = 0;
    this.speechOut = 0;
    this.nextSpeech = SPEECH_PERIOD;
    this.ws = 1;
    this.riot.onPortA = () => {
      // falling edge on PA0 strobes the byte on port B into the speech chip
      const ws = this.riot.paOut & 1;
      if (this.ws && !ws) this.speech.write(this.riot.pbOut);
      this.ws = ws;
    };
    this.cpu = new CPU6809(this);
    this.clock = 0;
    // latches: command = main -> sound, reply = sound -> main
    this.command = 0; this.commandPending = false;
    this.reply = 0; this.replyPending = false;
    // audio
    this.clocksPerSample = 0;
    this.nextSample = 0;
    this.pokeyClock = 0;
    this.buf = new Float32Array(8192);
    this.bufLen = 0;
    this.dc = 0;
    this.pokeyWrites = 0;
    this.riot.setPa(4, 1);
    this.reset();
  }

  setSampleRate(hz, cpuHz) {
    this.clocksPerSample = cpuHz / hz;
    this.nextSample = this.clock + this.clocksPerSample;
    this.pokeyClock = this.clock;
  }

  reset() {
    this.setCommandPending(false);
    this.setReplyPending(false);
    this.cpu.reset();
  }

  setCommandPending(on) { this.commandPending = on; this.riot.setPa(7, on ? 1 : 0); }
  setReplyPending(on) { this.replyPending = on; this.riot.setPa(6, on ? 1 : 0); }

  // main CPU side
  mainWrite(v) { this.command = v; this.setCommandPending(true); }
  mainRead() { this.setReplyPending(false); return this.reply; }
  mainFlags() { return (this.commandPending ? 0x80 : 0) | (this.replyPending ? 0x40 : 0); }

  // sound CPU bus
  read(a) {
    if (a >= 0x2000) return this.mem[a];
    if (a >= 0x1000 && a < 0x1080) return this.riot.ram[a & 0x7f];
    if (a >= 0x1080 && a < 0x10a0) {
      this.riot.setPa(2, this.speech.ready ? 0 : 1);
      return this.riot.read(a);
    }
    if (a >= 0x0800 && a < 0x1000) { this.setCommandPending(false); return this.command; }
    return 0xff;
  }

  write(a, v) {
    if (a >= 0x2000) { if (a < 0x2800) this.mem[a] = v; return; }
    if (a < 0x0800) { this.reply = v; this.setReplyPending(true); return; }
    if (a >= 0x1000 && a < 0x1080) { this.riot.ram[a & 0x7f] = v; return; }
    if (a >= 0x1080 && a < 0x10a0) { this.riot.write(a, v); return; }
    if (a >= 0x1800 && a < 0x1840) {
      const off = a & 0x3f;
      this.pokey[(off >> 3) & 3].write((off & 7) | ((off & 0x20) >> 2), v);
      this.pokeyWrites++;
    }
  }

  runTo(clock) {
    const cpu = this.cpu, riot = this.riot;
    while (this.clock < clock) {
      cpu.irq = riot.irq;
      const c = cpu.step();
      this.clock += c;
      riot.tick(c);
      if (this.clock >= this.nextSpeech) {
        this.speechLevel = this.speech.step();
        this.nextSpeech += SPEECH_PERIOD;
      }
    }
    if (!this.clocksPerSample) return;
    while (this.nextSample <= this.clock) {
      const target = Math.floor(this.nextSample);
      const n = target - this.pokeyClock;
      this.pokeyClock = target;
      const p = this.pokey;
      const level = (p[0].step(n) + p[1].step(n) + p[2].step(n) + p[3].step(n)) / 240;
      this.dc += (level - this.dc) * 0.002;
      this.speechOut += (this.speechLevel - this.speechOut) * 0.45; // soften the 8.4 kHz steps
      let v = (level - this.dc) * 1.6 + this.speechOut;
      if (v > 1) v = 1; else if (v < -1) v = -1;
      if (this.bufLen < this.buf.length) this.buf[this.bufLen++] = v;
      this.nextSample += this.clocksPerSample;
    }
  }

  // hands over the samples generated since the last call
  drain() {
    const out = this.buf.subarray(0, this.bufLen);
    this.bufLen = 0;
    return out;
  }
}
