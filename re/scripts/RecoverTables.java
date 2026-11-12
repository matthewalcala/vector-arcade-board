import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.*;
import ghidra.program.model.address.*;
import ghidra.program.model.data.PointerDataType;
import ghidra.program.model.symbol.*;
import java.util.*;
import java.util.regex.*;

// Resolves JMP/JSR [idx,R] dispatches whose table base is loaded by a nearby LDx #imm.
public class RecoverTables extends GhidraScript {
    static final int ROM_LO = 0x6000;

    public void run() throws Exception {
        Listing l = currentProgram.getListing();
        List<Instruction> sites = new ArrayList<>();
        InstructionIterator it = l.getInstructions(true);
        while (it.hasNext()) {
            Instruction i = it.next();
            String m = i.getMnemonicString();
            if ((m.equals("JMP") || m.equals("JSR")) && i.toString().contains("[")) sites.add(i);
        }
        Pattern reg = Pattern.compile("\\[[ABD]?,([XYU])\\]");
        int added = 0;
        for (Instruction i : sites) {
            Matcher mt = reg.matcher(i.toString());
            if (!mt.find()) { println("UNRESOLVED " + i.getAddress() + " " + i); continue; }
            String ld = "LD" + mt.group(1);
            Integer base = null;
            Instruction p = i.getPrevious();
            for (int k = 0; k < 8 && p != null; k++, p = p.getPrevious()) {
                if (p.getMnemonicString().equals(ld) && p.toString().contains("#")) {
                    base = (int) (p.getScalar(0).getUnsignedValue() & 0xffff);
                    break;
                }
            }
            if (base == null || base < ROM_LO) { println("UNRESOLVED " + i.getAddress() + " " + i); continue; }
            int limit = 0x10000, n = 0;
            for (int a = base; a + 1 < limit && n < 128; a += 2, n++) {
                if (l.getInstructionAt(toAddr(a)) != null) break;
                int t = getShort(toAddr(a)) & 0xffff;
                if (t < ROM_LO || t == 0xffff) break;
                if (t > base && t < limit) limit = t;
                Address ta = toAddr(t);
                try { clearListing(toAddr(a), toAddr(a + 1)); createData(toAddr(a), new PointerDataType()); } catch (Exception e) { }
                i.addOperandReference(0, ta, i.getMnemonicString().equals("JSR") ? RefType.COMPUTED_CALL : RefType.COMPUTED_JUMP, SourceType.ANALYSIS);
                if (l.getInstructionAt(ta) == null) { disassemble(ta); added++; }
                if (getFunctionAt(ta) == null) createFunction(ta, null);
            }
            if (getSymbolAt(toAddr(base)) == null || getSymbolAt(toAddr(base)).getSource() == SourceType.DEFAULT)
                createLabel(toAddr(base), String.format("jumptable_%04x", base), true, SourceType.ANALYSIS);
            println("TABLE " + i.getAddress() + " " + i + " base=" + Integer.toHexString(base) + " entries=" + n);
        }
        println("NEW_TARGETS " + added);
    }
}
