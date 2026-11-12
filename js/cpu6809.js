// Motorola 6809 CPU core. bus = { read(addr), write(addr, val) }

const CC_E = 0x80, CC_F = 0x40, CC_H = 0x20, CC_I = 0x10, CC_N = 0x08, CC_Z = 0x04, CC_V = 0x02, CC_C = 0x01;

const CYCLES = new Uint8Array([
  6, 0, 0, 6, 6, 0, 6, 6, 6, 6, 6, 0, 6, 6, 3, 6,
  0, 0, 2, 4, 0, 0, 5, 9, 0, 2, 3, 0, 3, 2, 8, 6,
  3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
  4, 4, 4, 4, 5, 5, 5, 5, 0, 5, 3, 6, 20, 11, 0, 19,
  2, 0, 0, 2, 2, 0, 2, 2, 2, 2, 2, 0, 2, 2, 0, 2,
  2, 0, 0, 2, 2, 0, 2, 2, 2, 2, 2, 0, 2, 2, 0, 2,
  6, 0, 0, 6, 6, 0, 6, 6, 6, 6, 6, 0, 6, 6, 3, 6,
  7, 0, 0, 7, 7, 0, 7, 7, 7, 7, 7, 0, 7, 7, 4, 7,
  2, 2, 2, 4, 2, 2, 2, 0, 2, 2, 2, 2, 4, 7, 3, 0,
  4, 4, 4, 6, 4, 4, 4, 4, 4, 4, 4, 4, 6, 7, 5, 5,
  4, 4, 4, 6, 4, 4, 4, 4, 4, 4, 4, 4, 6, 7, 5, 5,
  5, 5, 5, 7, 5, 5, 5, 5, 5, 5, 5, 5, 7, 8, 6, 6,
  2, 2, 2, 4, 2, 2, 2, 0, 2, 2, 2, 2, 3, 0, 3, 0,
  4, 4, 4, 6, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5,
  4, 4, 4, 6, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5,
  5, 5, 5, 7, 5, 5, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6,
]);

export class CPU6809 {
  constructor(bus) {
    this.bus = bus;
    this.a = this.b = this.dp = this.cc = 0;
    this.x = this.y = this.u = this.s = this.pc = 0;
    this.irq = false;
    this.firq = false;
    this.nmi = false;
    this.waiting = 0; // 0 run, 1 CWAI, 2 SYNC
    this.cyc = 0;
  }

  reset() {
    this.dp = 0;
    this.cc = CC_I | CC_F;
    this.waiting = 0;
    this.irq = this.firq = this.nmi = false;
    this.pc = this.rd16(0xfffe);
  }

  rd(a) { return this.bus.read(a & 0xffff); }
  wr(a, v) { this.bus.write(a & 0xffff, v & 0xff); }
  rd16(a) { return (this.rd(a) << 8) | this.rd(a + 1); }
  wr16(a, v) { this.wr(a, v >> 8); this.wr(a + 1, v); }
  fetch() { const v = this.bus.read(this.pc); this.pc = (this.pc + 1) & 0xffff; return v; }
  fetch16() { const h = this.fetch(); return (h << 8) | this.fetch(); }
  get d() { return (this.a << 8) | this.b; }
  set d(v) { this.a = (v >> 8) & 0xff; this.b = v & 0xff; }

  pushS(v) { this.s = (this.s - 1) & 0xffff; this.wr(this.s, v); }
  pushS16(v) { this.pushS(v); this.pushS(v >> 8); }
  pullS() { const v = this.rd(this.s); this.s = (this.s + 1) & 0xffff; return v; }
  pullS16() { const h = this.pullS(); return (h << 8) | this.pullS(); }
  pushU(v) { this.u = (this.u - 1) & 0xffff; this.wr(this.u, v); }
  pushU16(v) { this.pushU(v); this.pushU(v >> 8); }
  pullU() { const v = this.rd(this.u); this.u = (this.u + 1) & 0xffff; return v; }
  pullU16() { const h = this.pullU(); return (h << 8) | this.pullU(); }

  pushAll() {
    this.pushS16(this.pc); this.pushS16(this.u); this.pushS16(this.y); this.pushS16(this.x);
    this.pushS(this.dp); this.pushS(this.b); this.pushS(this.a); this.pushS(this.cc);
  }

  // flag helpers
  nz8(v) { this.cc = (this.cc & ~(CC_N | CC_Z)) | (v & 0x80 ? CC_N : 0) | ((v & 0xff) ? 0 : CC_Z); }
  nz16(v) { this.cc = (this.cc & ~(CC_N | CC_Z)) | (v & 0x8000 ? CC_N : 0) | ((v & 0xffff) ? 0 : CC_Z); }
  logic8(v) { this.nz8(v); this.cc &= ~CC_V; return v & 0xff; }
  logic16(v) { this.nz16(v); this.cc &= ~CC_V; return v & 0xffff; }

  add8(a, b, c) {
    const r = a + b + c;
    this.cc &= ~(CC_H | CC_N | CC_Z | CC_V | CC_C);
    if ((a ^ b ^ r) & 0x10) this.cc |= CC_H;
    if ((a ^ r) & (b ^ r) & 0x80) this.cc |= CC_V;
    if (r & 0x100) this.cc |= CC_C;
    if (r & 0x80) this.cc |= CC_N;
    if (!(r & 0xff)) this.cc |= CC_Z;
    return r & 0xff;
  }
  sub8(a, b, c) {
    const r = a - b - c;
    this.cc &= ~(CC_N | CC_Z | CC_V | CC_C);
    if ((a ^ b) & (a ^ r) & 0x80) this.cc |= CC_V;
    if (r & 0x100) this.cc |= CC_C;
    if (r & 0x80) this.cc |= CC_N;
    if (!(r & 0xff)) this.cc |= CC_Z;
    return r & 0xff;
  }
  add16(a, b) {
    const r = a + b;
    this.cc &= ~(CC_N | CC_Z | CC_V | CC_C);
    if ((a ^ r) & (b ^ r) & 0x8000) this.cc |= CC_V;
    if (r & 0x10000) this.cc |= CC_C;
    if (r & 0x8000) this.cc |= CC_N;
    if (!(r & 0xffff)) this.cc |= CC_Z;
    return r & 0xffff;
  }
  sub16(a, b) {
    const r = a - b;
    this.cc &= ~(CC_N | CC_Z | CC_V | CC_C);
    if ((a ^ b) & (a ^ r) & 0x8000) this.cc |= CC_V;
    if (r & 0x10000) this.cc |= CC_C;
    if (r & 0x8000) this.cc |= CC_N;
    if (!(r & 0xffff)) this.cc |= CC_Z;
    return r & 0xffff;
  }

  // read-modify-write group, selected by low opcode nibble
  rmw(n, v) {
    let r;
    const c = this.cc & CC_C;
    switch (n) {
      case 0x0: // NEG
        r = (-v) & 0xff;
        this.cc &= ~(CC_N | CC_Z | CC_V | CC_C);
        if (v === 0x80) this.cc |= CC_V;
        if (v) this.cc |= CC_C;
        break;
      case 0x3: // COM
        r = ~v & 0xff;
        this.cc = (this.cc & ~(CC_N | CC_Z | CC_V)) | CC_C;
        break;
      case 0x4: // LSR
        r = v >> 1;
        this.cc = (this.cc & ~(CC_N | CC_Z | CC_C)) | (v & 1);
        break;
      case 0x6: // ROR
        r = (v >> 1) | (c << 7);
        this.cc = (this.cc & ~(CC_N | CC_Z | CC_C)) | (v & 1);
        break;
      case 0x7: // ASR
        r = (v >> 1) | (v & 0x80);
        this.cc = (this.cc & ~(CC_N | CC_Z | CC_C)) | (v & 1);
        break;
      case 0x8: // ASL
        r = (v << 1) & 0xff;
        this.cc &= ~(CC_N | CC_Z | CC_V | CC_C);
        if (v & 0x80) this.cc |= CC_C;
        if ((v ^ r) & 0x80) this.cc |= CC_V;
        break;
      case 0x9: // ROL
        r = ((v << 1) | c) & 0xff;
        this.cc &= ~(CC_N | CC_Z | CC_V | CC_C);
        if (v & 0x80) this.cc |= CC_C;
        if ((v ^ r) & 0x80) this.cc |= CC_V;
        break;
      case 0xa: // DEC
        r = (v - 1) & 0xff;
        this.cc &= ~(CC_N | CC_Z | CC_V);
        if (v === 0x80) this.cc |= CC_V;
        break;
      case 0xc: // INC
        r = (v + 1) & 0xff;
        this.cc &= ~(CC_N | CC_Z | CC_V);
        if (v === 0x7f) this.cc |= CC_V;
        break;
      case 0xd: // TST
        r = v;
        this.cc &= ~(CC_N | CC_Z | CC_V);
        break;
      case 0xf: // CLR
        r = 0;
        this.cc &= ~(CC_N | CC_Z | CC_V | CC_C);
        break;
      default:
        return v;
    }
    if (r & 0x80) this.cc |= CC_N;
    if (!r) this.cc |= CC_Z;
    return r;
  }

  eaIndexed() {
    const pb = this.fetch();
    const sel = (pb >> 5) & 3;
    let reg = sel === 0 ? this.x : sel === 1 ? this.y : sel === 2 ? this.u : this.s;
    let ea;
    if (!(pb & 0x80)) {
      this.cyc += 1;
      return (reg + ((pb & 0x10) ? (pb & 0x1f) - 0x20 : (pb & 0x1f))) & 0xffff;
    }
    let newReg = -1;
    switch (pb & 0x0f) {
      case 0x0: ea = reg; newReg = reg + 1; this.cyc += 2; break;
      case 0x1: ea = reg; newReg = reg + 2; this.cyc += 3; break;
      case 0x2: ea = reg - 1; newReg = ea; this.cyc += 2; break;
      case 0x3: ea = reg - 2; newReg = ea; this.cyc += 3; break;
      case 0x4: ea = reg; break;
      case 0x5: ea = reg + ((this.b ^ 0x80) - 0x80); this.cyc += 1; break;
      case 0x6: ea = reg + ((this.a ^ 0x80) - 0x80); this.cyc += 1; break;
      case 0x8: ea = reg + ((this.fetch() ^ 0x80) - 0x80); this.cyc += 1; break;
      case 0x9: ea = reg + this.fetch16(); this.cyc += 4; break;
      case 0xb: ea = reg + this.d; this.cyc += 4; break;
      case 0xc: { const o = (this.fetch() ^ 0x80) - 0x80; ea = this.pc + o; this.cyc += 1; break; }
      case 0xd: { const o = this.fetch16(); ea = this.pc + o; this.cyc += 5; break; }
      case 0xf: ea = this.fetch16(); this.cyc += 2; break;
      default: ea = reg; break;
    }
    if (newReg >= 0) {
      newReg &= 0xffff;
      if (sel === 0) this.x = newReg; else if (sel === 1) this.y = newReg; else if (sel === 2) this.u = newReg; else this.s = newReg;
    }
    ea &= 0xffff;
    if (pb & 0x10) { ea = this.rd16(ea); this.cyc += 3; }
    return ea;
  }

  // mode: 1 direct, 2 indexed, 3 extended
  ea(mode) {
    if (mode === 1) return (this.dp << 8) | this.fetch();
    if (mode === 2) return this.eaIndexed();
    return this.fetch16();
  }
  op8(mode) { return mode === 0 ? this.fetch() : this.rd(this.ea(mode)); }
  op16(mode) { return mode === 0 ? this.fetch16() : this.rd16(this.ea(mode)); }

  getReg(c) {
    switch (c) {
      case 0: return this.d; case 1: return this.x; case 2: return this.y; case 3: return this.u;
      case 4: return this.s; case 5: return this.pc;
      case 8: return 0xff00 | this.a; case 9: return 0xff00 | this.b;
      case 10: return 0xff00 | this.cc; case 11: return 0xff00 | this.dp;
      default: return 0xffff;
    }
  }
  setReg(c, v) {
    switch (c) {
      case 0: this.d = v; break; case 1: this.x = v & 0xffff; break; case 2: this.y = v & 0xffff; break;
      case 3: this.u = v & 0xffff; break; case 4: this.s = v & 0xffff; break; case 5: this.pc = v & 0xffff; break;
      case 8: this.a = v & 0xff; break; case 9: this.b = v & 0xff; break;
      case 10: this.cc = v & 0xff; break; case 11: this.dp = v & 0xff; break;
    }
  }

  cond(n) {
    const cc = this.cc;
    const n_ = (cc & CC_N) ? 1 : 0, z = (cc & CC_Z) ? 1 : 0, v = (cc & CC_V) ? 1 : 0, c = cc & CC_C;
    switch (n) {
      case 0x0: return true;
      case 0x1: return false;
      case 0x2: return !(c | z);
      case 0x3: return !!(c | z);
      case 0x4: return !c;
      case 0x5: return !!c;
      case 0x6: return !z;
      case 0x7: return !!z;
      case 0x8: return !v;
      case 0x9: return !!v;
      case 0xa: return !n_;
      case 0xb: return !!n_;
      case 0xc: return !(n_ ^ v);
      case 0xd: return !!(n_ ^ v);
      case 0xe: return !(z | (n_ ^ v));
      default: return !!(z | (n_ ^ v));
    }
  }

  psh(pb, useS) {
    const push = useS ? (v) => this.pushS(v) : (v) => this.pushU(v);
    const push16 = (v) => { push(v); push(v >> 8); };
    if (pb & 0x80) { push16(this.pc); this.cyc += 2; }
    if (pb & 0x40) { push16(useS ? this.u : this.s); this.cyc += 2; }
    if (pb & 0x20) { push16(this.y); this.cyc += 2; }
    if (pb & 0x10) { push16(this.x); this.cyc += 2; }
    if (pb & 0x08) { push(this.dp); this.cyc += 1; }
    if (pb & 0x04) { push(this.b); this.cyc += 1; }
    if (pb & 0x02) { push(this.a); this.cyc += 1; }
    if (pb & 0x01) { push(this.cc); this.cyc += 1; }
  }
  pul(pb, useS) {
    const pull = useS ? () => this.pullS() : () => this.pullU();
    const pull16 = () => { const h = pull(); return (h << 8) | pull(); };
    if (pb & 0x01) { this.cc = pull(); this.cyc += 1; }
    if (pb & 0x02) { this.a = pull(); this.cyc += 1; }
    if (pb & 0x04) { this.b = pull(); this.cyc += 1; }
    if (pb & 0x08) { this.dp = pull(); this.cyc += 1; }
    if (pb & 0x10) { this.x = pull16(); this.cyc += 2; }
    if (pb & 0x20) { this.y = pull16(); this.cyc += 2; }
    if (pb & 0x40) { const v = pull16(); if (useS) this.u = v; else this.s = v; this.cyc += 2; }
    if (pb & 0x80) { this.pc = pull16(); this.cyc += 2; }
  }

  interrupt(vector, full, mask) {
    if (this.waiting !== 1) {
      if (full) { this.cc |= CC_E; this.pushAll(); }
      else { this.cc &= ~CC_E; this.pushS16(this.pc); this.pushS(this.cc); }
    }
    this.waiting = 0;
    this.cc |= mask;
    this.pc = this.rd16(vector);
    return full ? 19 : 10;
  }

  step() {
    if (this.nmi) { this.nmi = false; return this.interrupt(0xfffc, true, CC_I | CC_F); }
    if (this.firq && !(this.cc & CC_F)) return this.interrupt(0xfff6, false, CC_I | CC_F);
    if (this.irq && !(this.cc & CC_I)) return this.interrupt(0xfff8, true, CC_I);
    if (this.waiting) {
      if (this.waiting === 2 && (this.irq || this.firq)) this.waiting = 0;
      else return 2;
    }

    const op = this.fetch();
    this.cyc = CYCLES[op];

    if (op >= 0x80) this.accOp(op);
    else if (op < 0x10 || op >= 0x40) this.rmwOp(op);
    else if (op >= 0x20 && op < 0x30) {
      const o = (this.fetch() ^ 0x80) - 0x80;
      if (this.cond(op & 0xf)) this.pc = (this.pc + o) & 0xffff;
    } else this.miscOp(op);
    return this.cyc;
  }

  rmwOp(op) {
    const n = op & 0xf;
    const grp = op >> 4;
    if (grp === 4) { this.a = this.rmw(n, this.a); return; }
    if (grp === 5) { this.b = this.rmw(n, this.b); return; }
    const ea = this.ea(grp === 0 ? 1 : grp === 6 ? 2 : 3);
    if (n === 0xe) { this.pc = ea; return; }
    if (n === 0xf) { this.rmw(n, 0); this.wr(ea, 0); return; }
    const v = this.rd(ea);
    const r = this.rmw(n, v);
    if (n !== 0xd) this.wr(ea, r);
  }

  accOp(op) {
    const mode = (op >> 4) & 3;
    const isB = (op & 0x40) !== 0;
    const lo = op & 0xf;
    const acc = isB ? this.b : this.a;
    let r = acc;
    switch (lo) {
      case 0x0: r = this.sub8(acc, this.op8(mode), 0); break;
      case 0x1: this.sub8(acc, this.op8(mode), 0); return;
      case 0x2: r = this.sub8(acc, this.op8(mode), this.cc & CC_C); break;
      case 0x3:
        if (isB) this.d = this.add16(this.d, this.op16(mode));
        else this.d = this.sub16(this.d, this.op16(mode));
        return;
      case 0x4: r = this.logic8(acc & this.op8(mode)); break;
      case 0x5: this.logic8(acc & this.op8(mode)); return;
      case 0x6: r = this.logic8(this.op8(mode)); break;
      case 0x7: this.wr(this.ea(mode), this.logic8(acc)); return;
      case 0x8: r = this.logic8(acc ^ this.op8(mode)); break;
      case 0x9: r = this.add8(acc, this.op8(mode), this.cc & CC_C); break;
      case 0xa: r = this.logic8(acc | this.op8(mode)); break;
      case 0xb: r = this.add8(acc, this.op8(mode), 0); break;
      case 0xc:
        if (isB) this.d = this.logic16(this.op16(mode));
        else this.sub16(this.x, this.op16(mode));
        return;
      case 0xd:
        if (isB) { this.wr16(this.ea(mode), this.logic16(this.d)); return; }
        if (mode === 0) {
          const o = (this.fetch() ^ 0x80) - 0x80;
          this.pushS16(this.pc);
          this.pc = (this.pc + o) & 0xffff;
        } else {
          const ea = this.ea(mode);
          this.pushS16(this.pc);
          this.pc = ea;
        }
        return;
      case 0xe:
        if (isB) this.u = this.logic16(this.op16(mode));
        else this.x = this.logic16(this.op16(mode));
        return;
      case 0xf:
        this.wr16(this.ea(mode), this.logic16(isB ? this.u : this.x));
        return;
    }
    if (isB) this.b = r; else this.a = r;
  }

  miscOp(op) {
    switch (op) {
      case 0x10: this.page2(); break;
      case 0x11: this.page3(); break;
      case 0x12: break;
      case 0x13: this.waiting = 2; break;
      case 0x16: { const o = this.fetch16(); this.pc = (this.pc + o) & 0xffff; break; }
      case 0x17: { const o = this.fetch16(); this.pushS16(this.pc); this.pc = (this.pc + o) & 0xffff; break; }
      case 0x19: { // DAA
        let cf = 0;
        const lsn = this.a & 0x0f, msn = this.a & 0xf0;
        if (lsn > 9 || (this.cc & CC_H)) cf |= 0x06;
        if (msn > 0x80 && lsn > 9) cf |= 0x60;
        if (msn > 0x90 || (this.cc & CC_C)) cf |= 0x60;
        const r = this.a + cf;
        this.cc &= ~(CC_N | CC_Z | CC_V);
        if (r & 0x100) this.cc |= CC_C;
        this.a = r & 0xff;
        this.nz8(this.a);
        break;
      }
      case 0x1a: this.cc |= this.fetch(); break;
      case 0x1c: this.cc &= this.fetch(); break;
      case 0x1d: this.a = (this.b & 0x80) ? 0xff : 0; this.nz16(this.d); break;
      case 0x1e: {
        const pb = this.fetch();
        const r1 = pb >> 4, r2 = pb & 0xf;
        const t = this.getReg(r1);
        this.setReg(r1, this.getReg(r2));
        this.setReg(r2, t);
        break;
      }
      case 0x1f: { const pb = this.fetch(); this.setReg(pb & 0xf, this.getReg(pb >> 4)); break; }
      case 0x30: this.x = this.eaIndexed(); this.cc = (this.cc & ~CC_Z) | (this.x ? 0 : CC_Z); break;
      case 0x31: this.y = this.eaIndexed(); this.cc = (this.cc & ~CC_Z) | (this.y ? 0 : CC_Z); break;
      case 0x32: this.s = this.eaIndexed(); break;
      case 0x33: this.u = this.eaIndexed(); break;
      case 0x34: this.psh(this.fetch(), true); break;
      case 0x35: this.pul(this.fetch(), true); break;
      case 0x36: this.psh(this.fetch(), false); break;
      case 0x37: this.pul(this.fetch(), false); break;
      case 0x39: this.pc = this.pullS16(); break;
      case 0x3a: this.x = (this.x + this.b) & 0xffff; break;
      case 0x3b: // RTI
        this.cc = this.pullS();
        if (this.cc & CC_E) {
          this.a = this.pullS(); this.b = this.pullS(); this.dp = this.pullS();
          this.x = this.pullS16(); this.y = this.pullS16(); this.u = this.pullS16();
          this.cyc += 9;
        }
        this.pc = this.pullS16();
        break;
      case 0x3c: // CWAI
        this.cc &= this.fetch();
        this.cc |= CC_E;
        this.pushAll();
        this.waiting = 1;
        break;
      case 0x3d: { // MUL
        const r = this.a * this.b;
        this.d = r;
        this.cc &= ~(CC_Z | CC_C);
        if (!r) this.cc |= CC_Z;
        if (r & 0x80) this.cc |= CC_C;
        break;
      }
      case 0x3f: this.swi(0xfffa, CC_I | CC_F); break;
    }
  }

  swi(vector, mask) {
    this.cc |= CC_E;
    this.pushAll();
    this.cc |= mask;
    this.pc = this.rd16(vector);
  }

  page2() {
    const op = this.fetch();
    if (op >= 0x21 && op <= 0x2f) {
      const o = this.fetch16();
      this.cyc = 5;
      if (this.cond(op & 0xf)) { this.pc = (this.pc + o) & 0xffff; this.cyc = 6; }
      return;
    }
    if (op === 0x3f) { this.cyc = 20; this.swi(0xfff4, 0); return; }
    this.cyc = CYCLES[op] + 1;
    const mode = (op >> 4) & 3;
    const hi = op >= 0xc0;
    switch (op & 0xf) {
      case 0x3: this.sub16(this.d, this.op16(mode)); break;
      case 0xc: this.sub16(this.y, this.op16(mode)); break;
      case 0xe:
        if (hi) this.s = this.logic16(this.op16(mode));
        else this.y = this.logic16(this.op16(mode));
        break;
      case 0xf: this.wr16(this.ea(mode), this.logic16(hi ? this.s : this.y)); break;
    }
  }

  page3() {
    const op = this.fetch();
    if (op === 0x3f) { this.cyc = 20; this.swi(0xfff2, 0); return; }
    this.cyc = CYCLES[op] + 1;
    const mode = (op >> 4) & 3;
    switch (op & 0xf) {
      case 0x3: this.sub16(this.u, this.op16(mode)); break;
      case 0xc: this.sub16(this.s, this.op16(mode)); break;
    }
  }
}
