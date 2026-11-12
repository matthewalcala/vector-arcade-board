import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.data.PointerDataType;
import ghidra.program.model.symbol.SourceType;

public class SeedVectors extends GhidraScript {
    public void run() throws Exception {
        String[] names = {"SWI3", "SWI2", "FIRQ", "IRQ", "SWI", "NMI", "RESET"};
        for (int i = 0; i < names.length; i++) {
            Address v = toAddr(0xfff2 + 2 * i);
            int t = getShort(v) & 0xffff;
            createData(v, new PointerDataType());
            createLabel(v, "VEC_" + names[i], true, SourceType.USER_DEFINED);
            if (t == 0xffff) continue;
            Address a = toAddr(t);
            addEntryPoint(a);
            if (getSymbolAt(a) == null || getSymbolAt(a).getSource() == SourceType.DEFAULT)
                createLabel(a, names[i] + "_handler", true, SourceType.USER_DEFINED);
            disassemble(a);
            createFunction(a, null);
            println("vector " + names[i] + " -> " + a);
        }
    }
}
