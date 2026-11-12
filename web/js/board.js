import { CPU6809 } from './cpu6809.js';
import { AVG } from './avg.js';
import { SoundBoard } from './sound.js';

export const CPU_HZ = 12096000 / 8;
const IRQ_PERIOD = 6144; // CPU cycles: master / 4096 / 12
const SLICE = 64; // CPU cycles the two processors may drift apart

// math box microcode strobes
const M_LAC = 0x01, M_READ_ACC = 0x02, M_HALT = 0x04, M_INC_BIC = 0x08, M_CLEAR_ACC = 0x10, M_LDC = 0x20, M_LDB = 0x40, M_LDA = 0x80;

export class Board {
  // roms: { main0, main1 (bank halves), rom8000, romA000, romC000, romE000, vector, avgProm, math[4] }
  constructor(roms, nvram) {
    this.mem = new Uint8Array(0x10000);
    this.bankRom = [roms.bank0, roms.bank1];
    this.mem.set(roms.vector, 0x3000);
    this.mem.set(roms.bank0, 0x6000);
    this.mem.set(roms.rom8000, 0x8000);
    this.mem.set(roms.romA000, 0xa000);
    this.mem.set(roms.romC000, 0xc000);
    this.mem.set(roms.romE000, 0xe000);

    this.micro = new Uint16Array(1024);
    for (let i = 0; i < 1024; i++) {
      this.micro[i] = ((roms.math[0][i] & 0xf) << 12) | ((roms.math[1][i] & 0xf) << 8) | ((roms.math[2][i] & 0xf) << 4) | (roms.math[3][i] & 0xf);
    }

    this.cpu = new CPU6809(this);
    this.avg = new AVG(this.mem, roms.avgProm);
    this.snd = roms.sound ? new SoundBoard(roms.sound) : null;
    this.clock = 0;
    this.nextIrq = IRQ_PERIOD;
    this.avgDoneAt = 0;
    this.mathDoneAt = 0;

    this.latch = new Uint8Array(8);
    this.adc = 0;
    // math box
    this.mpa = 0; this.bic = 0;
    this.ra = 0; this.rb = 0; this.rc = 0; this.acc = 0;
    this.divisor = 0; this.dividend = 0; this.dvdShift = 0; this.quotient = 0;

    // nvram: 256 nibbles, volatile copy + stored copy
    this.nvStore = nvram || new Uint8Array(256).fill(0x0f);
    this.nvRam = new Uint8Array(this.nvStore);
    this.onNvStore = null;

    // inputs (true = pressed)
    this.in = { coin: false, fireL: false, fireR: false, thumbL: false, thumbR: false, selfTest: false };
    this.stickX = 0x80;
    this.stickY = 0x80;
    this.dsw0 = 0x94; // 6 shields, moderate, 1 bonus shield
    this.dsw1 = 0x00; // free play

    this.cpu.reset();
  }

  read(a) {
    if (a < 0x4300 || a >= 0x4800) return this.mem[a];
    if (a < 0x4400) {
      switch (a & 0xe0) {
        case 0x00: {
          let v = 0xdf;
          if (this.in.coin) v &= ~0x02;
          if (this.in.selfTest) v &= ~0x10;
          if (this.in.thumbL) v &= ~0x40;
          if (this.in.fireL) v &= ~0x80;
          return v;
        }
        case 0x20: {
          let v = 0x34;
          if (this.in.thumbR) v &= ~0x10;
          if (this.in.fireR) v &= ~0x20;
          if (this.clock >= this.avgDoneAt) v |= 0x40;
          if (this.clock < this.mathDoneAt) v |= 0x80;
          return v;
        }
        case 0x40: return this.dsw0;
        case 0x60: return this.dsw1;
        default: return this.adc;
      }
    }
    if (a < 0x4500) {
      if (!this.snd) return 0;
      return (a & 1) ? this.snd.mainFlags() : this.snd.mainRead();
    }
    if (a < 0x4600) return this.nvRam[a & 0xff] | 0xf0;
    if (a === 0x4700) return this.quotient >> 8;
    if (a === 0x4701) return this.quotient & 0xff;
    if (a === 0x4703) return (Math.random() * 256) | 0;
    return 0;
  }

  write(a, v) {
    if (a < 0x3000 || (a >= 0x4800 && a < 0x6000)) { this.mem[a] = v; return; }
    if (a < 0x4400 || a >= 0x4800) return;
    if (a < 0x4500) { if (this.snd && a === 0x4400) this.snd.mainWrite(v); return; }
    if (a < 0x4600) { this.nvRam[a & 0xff] = v & 0x0f; return; }
    if (a < 0x4700) {
      switch (a & 0xe0) {
        case 0x00:
          this.avgDoneAt = this.clock + Math.ceil(this.avg.go() / 8);
          break;
        case 0x20:
          this.avg.reset();
          this.avgDoneAt = this.clock;
          break;
        case 0x60: this.cpu.irq = false; break;
        case 0x80: this.setLatch(a & 7, v >> 7); break;
        case 0xa0:
          this.nvStore.set(this.nvRam);
          if (this.onNvStore) this.onNvStore(this.nvStore);
          break;
        case 0xc0: {
          const ch = a & 3;
          this.adc = ch === 0 ? this.stickY : ch === 1 ? this.stickX : 0;
          break;
        }
        case 0xe0: if (this.snd) this.snd.reset(); break;
      }
      return;
    }
    this.mathWrite(a & 7, v);
  }

  setLatch(bit, v) {
    if (this.latch[bit] === v) return;
    this.latch[bit] = v;
    if (bit === 4) this.mem.set(this.bankRom[v], 0x6000);
    if (bit === 7 && !v) this.nvRam.set(this.nvStore);
  }

  mathWrite(reg, v) {
    switch (reg) {
      case 0: this.mpa = v << 2; this.runMath(); break;
      case 1: this.bic = (this.bic & 0x0ff) | ((v & 1) << 8); break;
      case 2: this.bic = (this.bic & 0x100) | v; break;
      case 4:
        this.divisor = (this.divisor & 0x00ff) | (v << 8);
        this.dvdShift = this.dividend;
        this.quotient = 0;
        break;
      case 5: {
        this.divisor = (this.divisor & 0xff00) | v;
        // 15-step restoring divide, as wired on the board
        const neg = (this.divisor ^ 0xffff) + 1;
        for (let i = 1; i < 16; i++) {
          this.quotient = (this.quotient << 1) & 0xffff;
          const t = this.dvdShift + neg;
          if (t & 0x10000) {
            this.quotient |= 1;
            this.dvdShift = (t << 1) & 0xffff;
          } else {
            this.dvdShift = (this.dvdShift << 1) & 0xffff;
          }
        }
        break;
      }
      case 6: this.dividend = (this.dividend & 0x00ff) | (v << 8); break;
      case 7: this.dividend = (this.dividend & 0xff00) | v; break;
    }
  }

  // Matrix processor: runs microcode until its HALT strobe.
  runMath() {
    const ram = this.mem;
    let ticks = 0;
    for (let limit = 100000; limit > 0; limit--) {
      ticks += 5;
      const ip = this.micro[this.mpa];
      const strobes = ip >> 8;
      const ma = (ip & 0x80) ? (ip & 0x7f) : ((ip & 3) | ((this.bic & 0x1ff) << 2));
      const addr = 0x5000 + (ma << 1);
      const word = (ram[addr] << 8) | ram[addr + 1];
      const sword = (word ^ 0x8000) - 0x8000;

      if (strobes & M_CLEAR_ACC) this.acc = 0;
      if (strobes & M_LAC) this.acc = word << 16;
      if (strobes & M_READ_ACC) {
        ram[addr] = (this.acc >> 24) & 0xff;
        ram[addr + 1] = (this.acc >> 16) & 0xff;
      }
      if (strobes & M_HALT) limit = 0;
      if (strobes & M_INC_BIC) this.bic = (this.bic + 1) & 0x1ff;
      if (strobes & M_LDC) {
        this.rc = sword;
        // serial multiply-accumulate: ACC += (A - B) * C, scaled by 4
        this.acc = (this.acc + (Math.imul((this.ra - this.rb) << 1, this.rc) << 1)) | 0;
        this.ra = this.ra < 0 ? -1 : 0;
        this.rb = this.rb < 0 ? -1 : 0;
        ticks += 33;
      }
      if (strobes & M_LDB) this.rb = sword;
      if (strobes & M_LDA) this.ra = sword;

      this.mpa = (this.mpa & 0x300) | ((this.mpa + 1) & 0xff);
    }
    this.mathDoneAt = this.clock + Math.ceil(ticks / 8);
  }

  run(cycles) {
    const end = this.clock + cycles;
    const cpu = this.cpu;
    while (this.clock < end) {
      const sliceEnd = Math.min(end, this.clock + SLICE);
      while (this.clock < sliceEnd) {
        if (this.clock >= this.nextIrq) {
          cpu.irq = true;
          this.nextIrq += IRQ_PERIOD;
        }
        this.clock += cpu.step();
      }
      if (this.snd) this.snd.runTo(this.clock);
    }
  }
}
