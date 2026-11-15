// Atari "slapstic" 137412-101: a bank-switch chip that watches the address bus and
// changes which of four ROM pages is visible at 0x8000-0x9fff when it sees certain
// access patterns. Behaviour and constants follow MAME's slapstic.cpp
// (BSD-3-Clause; Aaron Giles, Olivier Galibert).
//
// The "alternate" sequence depends on the 6809's dummy bus cycle at 0xffff during a
// 5-bit-offset indexed access, which cpu6809.js produces for that reason.

const IDLE = 0, ACTIVE = 1, ALT_VALID = 2, ALT_SELECT = 3, ALT_COMMIT = 4, BIT_LOAD = 5, BIT_ODD = 6, BIT_EVEN = 7;
const BASE = 0x8000;

export class Slapstic {
  constructor(onBank) {
    this.onBank = onBank;
    this.reset();
  }

  reset() {
    this.state = IDLE;
    this.loaded = 0;
    this.setBank(3);
  }

  setBank(n) {
    this.bank = n;
    this.onBank(n);
  }

  // called with the address of every main CPU bus access
  test(a) {
    const inside = (a & 0xe000) === BASE;
    const low = a & 0x1fff;
    if (this.state === IDLE) {
      if (a === BASE) this.state = ACTIVE;
      return;
    }
    if (a === BASE && this.state !== ACTIVE) { this.state = ACTIVE; return; }
    switch (this.state) {
      case ACTIVE:
        if (!inside) return;
        if (low === 0x0080 || low === 0x0090 || low === 0x00a0 || low === 0x00b0) {
          this.setBank((low >> 4) & 3);
          this.state = IDLE;
        } else if ((low & 0x1f00) === 0x1e00) this.state = ALT_VALID;
        else if ((low & 0x1ff0) === 0x1540) this.state = BIT_LOAD;
        return;
      case ALT_VALID:
        this.state = !inside && low === 0x1fff ? ALT_SELECT : ACTIVE;
        return;
      case ALT_SELECT:
        if (inside && (low & 0x1ffc) === 0x1b5c) {
          this.loaded = low & 3;
          this.state = ALT_COMMIT;
        } else this.state = ACTIVE;
        return;
      case ALT_COMMIT:
        if (inside && (low & 0x1fcf) === 0x0080) { this.setBank(this.loaded); this.state = IDLE; }
        return;
      case BIT_LOAD:
        if (inside && (low & 0x1fcf) === 0x0080) { this.loaded = this.bank; this.state = BIT_ODD; }
        return;
      default: {
        // BIT_ODD / BIT_EVEN: each access to 0x1540-0x1543 flips one bit of the pending bank
        if (!inside) return;
        if ((low & 0x1ff3) >= 0x1540 && (low & 0x1ff3) <= 0x1543) {
          const odd = this.state === BIT_ODD;
          switch ((low & 3) ^ (odd ? 0 : 3)) {
            case 0: this.loaded &= ~1; break;
            case 1: this.loaded |= 1; break;
            case 2: this.loaded &= ~2; break;
            default: this.loaded |= 2; break;
          }
          this.state = odd ? BIT_EVEN : BIT_ODD;
        } else if ((low & 0x1ff8) === 0x1550) { this.setBank(this.loaded); this.state = IDLE; }
      }
    }
  }
}
