import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.*;

public class Report extends GhidraScript {
    public void run() throws Exception {
        Listing l = currentProgram.getListing();
        println("STATS " + currentProgram.getName() + " functions=" + currentProgram.getFunctionManager().getFunctionCount()
            + " instructions=" + l.getNumInstructions() + " definedData=" + l.getNumDefinedData()
            + " errorBookmarks=" + currentProgram.getBookmarkManager().getBookmarkCount("Error"));
    }
}
