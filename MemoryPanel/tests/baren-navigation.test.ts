import { describe, expect, it } from "vitest";
import {
  DOCK_PAGES,
  MORE_GROUPS,
  NAV_LABELS,
  PAGE_PATHS,
  legacyProjectsLocation,
  pageForPath,
  projectBoardLocation,
  visiblePageIds,
} from "../web/src/constants/navigation";

describe("Baren navigation compatibility", () => {
  it("exposes one Task board destination and keeps Projects as a legacy route", () => {
    const destinations = [
      ...DOCK_PAGES,
      ...MORE_GROUPS.flatMap((group) => group.pages),
    ];
    expect(new Set(destinations).size).toBe(destinations.length);
    expect([...destinations].sort()).toEqual(
      Object.keys(PAGE_PATHS)
        .filter((id) => id !== "projects")
        .sort(),
    );
    expect(DOCK_PAGES).toContain("workbench_board");
    expect(destinations).not.toContain("projects");
    expect(PAGE_PATHS.projects).toBe("/projects");
    expect(NAV_LABELS.workbench_board).toBe("Task board");
  });
  it("keeps the old board landing and resource/deep-link route identity", () => {
    expect(pageForPath("/")).toBe("workbench_board");
    expect(pageForPath("/workbench")).toBe("orca_workbench");
    expect(pageForPath("/projects")).toBe("workbench_board");
    expect(pageForPath("/projects/example")).toBe("workbench_board");
    expect(pageForPath("/team/api-keys")).toBe("api_keys");
    expect(pageForPath("/guide")).toBeNull();
  });
  it("retains reviewer and analytics restrictions after moving to More", () => {
    expect(visiblePageIds("reviewer", true)).not.toContain("team_members");
    expect(visiblePageIds("reviewer", true)).not.toContain("analytics");
    expect(visiblePageIds("member", true)).not.toContain("analytics");
    expect(visiblePageIds("admin", false)).not.toContain("analytics");
    expect(visiblePageIds("admin", true)).toContain("analytics");
    expect(visiblePageIds("member", false)).toContain("team_members");
    for (const role of ["admin", "member", "reviewer", null]) {
      expect(visiblePageIds(role, true)).not.toContain("projects");
      expect(visiblePageIds(role, true)).toContain("workbench_board");
    }
  });
  it("opens project details in the board without losing encoded project IDs", () => {
    const id = "launch / autumn+winter?draft&team=Design 東京";
    const location = new URL(projectBoardLocation(id), "http://localhost");
    expect(location.pathname).toBe("/");
    expect(location.hash).toBe("");
    expect([...location.searchParams.entries()]).toEqual([
      ["project", id],
      ["projectDetails", id],
    ]);
  });
  it("translates legacy project links while preserving task and unrelated parameters", () => {
    const id = "launch / autumn+winter?draft&team=Design 東京";
    const search = new URLSearchParams([
      ["id", id],
      ["project", "old-project"],
      ["projectDetails", "old-details"],
      ["task", "task / one"],
      ["source", "review"],
      ["tag", "alpha"],
      ["tag", "beta"],
    ]);
    const location = new URL(
      legacyProjectsLocation(`?${search.toString()}`),
      "http://localhost",
    );
    expect(location.pathname).toBe("/");
    expect(location.searchParams.has("id")).toBe(false);
    expect(location.searchParams.get("project")).toBe(id);
    expect(location.searchParams.get("projectDetails")).toBe(id);
    expect(location.searchParams.get("task")).toBe("task / one");
    expect(location.searchParams.get("source")).toBe("review");
    expect(location.searchParams.getAll("tag")).toEqual(["alpha", "beta"]);
  });
  it("opens project management for legacy collection links and preserves current context", () => {
    const location = new URL(
      legacyProjectsLocation("?project=existing&task=selected&source=review"),
      "http://localhost",
    );
    expect(location.pathname).toBe("/");
    expect(location.searchParams.get("manageProjects")).toBe("1");
    expect(location.searchParams.get("project")).toBe("existing");
    expect(location.searchParams.get("task")).toBe("selected");
    expect(location.searchParams.get("source")).toBe("review");
    expect(legacyProjectsLocation("")).toBe("/?manageProjects=1");
  });
});
