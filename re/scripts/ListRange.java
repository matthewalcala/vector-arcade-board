import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.*;
import ghidra.program.model.address.*;

// args: start end (hex). Disassembles the range if needed and prints it.
public class ListRange extends GhidraScript {
    public void run() throws Exception {
        String[] a = getScriptArgs();
        Address s = toAddr(Integer.parseInt(a[0], 16)), e = toAddr(Integer.parseInt(a[1], 16));
        Listing l = currentProgram.getListing();
        Address p = s;
        while (p.compareTo(e) <= 0) {
            Instruction i = l.getInstructionAt(p);
            if (i == null) { disassemble(p); i = l.getInstructionAt(p); }
            if (i == null) { println("L " + p + " db " + String.format("%02x", getByte(p) & 0xff)); p = p.add(1); continue; }
            println("L " + p + " " + i);
            p = p.add(i.getLength());
        }
    }
}
