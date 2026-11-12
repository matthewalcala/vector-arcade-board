import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.*;
import ghidra.program.model.address.*;

public class DumpFlows extends GhidraScript {
    public void run() throws Exception {
        Listing l = currentProgram.getListing();
        AddressSet rom = new AddressSet(toAddr(0x6000), toAddr(0xffff));
        AddressSetView undef = l.getUndefinedRanges(rom, false, monitor);
        long tot = 0;
        for (AddressRange r : undef) { tot += r.getLength(); if (r.getLength() >= 0x100) println("UNDEF " + r.getMinAddress() + "-" + r.getMaxAddress() + " " + r.getLength()); }
        println("UNDEF_TOTAL " + tot + " functions=" + currentProgram.getFunctionManager().getFunctionCount() + " instructions=" + l.getNumInstructions());
    }
}
