import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestedRuntime,
  RuntimePicker,
  updateWorkbenchQuery,
  workbenchUrl,
} from "../web/src/pages/OrcaWorkbench/RuntimePicker";

afterEach(() => vi.unstubAllGlobals());

describe("cdesktop-only Workbench presentation", () => {
  it.each([
    ["#/workbench", ""],
    ["#/workbench?runtime=cdesktop&task=task-1", ""],
    ["#/workbench?runtime=orca&task=task-1", ""],
    ["#/workbench?runtime=unknown", ""],
    ["", "?runtime=orca&task=task-1"],
  ])("opens cdesktop for hash %s and search %s", (hash, search) => {
    vi.stubGlobal("window", { location: { hash, search } });
    expect(requestedRuntime()).toBe("cdesktop");
  });

  it("routes old runtime links to cdesktop without losing the task", () => {
    const url = workbenchUrl("orca", "task / & #");
    const query = new URLSearchParams(url.split("?")[1]);
    expect(query.get("runtime")).toBe("cdesktop");
    expect(query.get("task")).toBe("task / & #");
  });

  it("does not offer a redundant or hidden runtime selector", () => {
    const onChange = vi.fn();
    expect(RuntimePicker({ runtime: "cdesktop", onChange })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("preserves other route parameters and browser history state when selecting a task", () => {
    const replaceState = vi.fn();
    const dispatchEvent = vi.fn();
    const historyState = { idx: 4 };
    vi.stubGlobal("window", {
      location: {
        href: "https://example.test/#/workbench?runtime=cdesktop&context=wiki%2Fpage",
      },
      history: { state: historyState, replaceState },
      dispatchEvent,
    });
    updateWorkbenchQuery({ task: "task / & #" });
    expect(replaceState).toHaveBeenCalledOnce();
    const [state, , url] = replaceState.mock.calls[0];
    const query = new URLSearchParams(url.hash.split("?")[1]);
    expect(state).toBe(historyState);
    expect(query.get("context")).toBe("wiki/page");
    expect(query.get("runtime")).toBe("cdesktop");
    expect(query.get("task")).toBe("task / & #");
    expect(dispatchEvent.mock.calls[0][0].type).toBe("workbench-query-change");
  });
});
