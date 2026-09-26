import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ listWithAgents: vi.fn(), notify: vi.fn() }));
vi.mock("@/lib/teamApi", () => ({
  teamsApi: {},
  membersApi: {},
  agentsApi: {},
  tasksApi: { listWithAgents: api.listWithAgents },
}));
vi.mock("@/lib/tea-bridge", () => ({ tea: { notify: { error: api.notify } } }));
vi.mock("@/i18n", () => ({ default: { t: () => "Unable to load tasks." } }));
vi.mock("@/services/user-profile-store", () => ({
  seedDisplayNameCache: vi.fn(),
}));
vi.mock("@/services/backendStore", () => ({
  readActiveTeamId: () => null,
  writeActiveTeamId: vi.fn(),
  ensureValidActiveTeamId: vi.fn(),
  adaptTeam: vi.fn(),
  adaptMember: vi.fn(),
  adaptAgent: vi.fn(),
  adaptTask: (task: unknown) => task,
}));
import { useBackendStore } from "../web/src/stores/backend";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const page = { limit: 12, offset: 0 };
const result = { items: [{ task_id: "task-a", agents: [] }], total: 1 };

beforeEach(() => {
  useBackendStore.getState().clearAll();
  api.listWithAgents.mockReset();
  api.notify.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("task page failure and retry", () => {
  it("settles a failed page and does not automatically request it again", async () => {
    api.listWithAgents.mockRejectedValue(new Error("Connection unavailable"));
    await useBackendStore.getState().fetchTasks("team-a", page);
    expect(useBackendStore.getState().tasksErrorsByTeam["team-a"]["0:12"]).toBe(
      "Connection unavailable",
    );
    expect(
      useBackendStore.getState().tasksPagesByTeam["team-a"],
    ).toBeUndefined();
    expect(useBackendStore.getState().inflightTasks).toEqual({});
    await useBackendStore.getState().fetchTasks("team-a", page);
    expect(api.listWithAgents).toHaveBeenCalledTimes(1);
  });

  it("clears the error on explicit retry, deduplicates it, and caches success", async () => {
    api.listWithAgents.mockRejectedValueOnce(new Error("Offline"));
    await useBackendStore.getState().fetchTasks("team-a", page);
    const pending = deferred<typeof result>();
    api.listWithAgents.mockReturnValueOnce(pending.promise);
    const retry = useBackendStore
      .getState()
      .fetchTasks("team-a", { ...page, force: true });
    const concurrent = useBackendStore
      .getState()
      .fetchTasks("team-a", { ...page, force: true });
    expect(
      useBackendStore.getState().tasksErrorsByTeam["team-a"]["0:12"],
    ).toBeUndefined();
    expect(
      useBackendStore.getState().inflightTasks["team-a:0:12"],
    ).toBeDefined();
    await Promise.resolve();
    expect(api.listWithAgents).toHaveBeenCalledTimes(2);
    pending.resolve(result);
    await Promise.all([retry, concurrent]);
    expect(
      useBackendStore.getState().tasksPagesByTeam["team-a"]["0:12"][0].task_id,
    ).toBe("task-a");
    expect(useBackendStore.getState().tasksTotalByTeam["team-a"]).toBe(1);
    expect(useBackendStore.getState().tasksErrorsByTeam["team-a"]).toEqual({});
    expect(useBackendStore.getState().inflightTasks).toEqual({});
    await useBackendStore.getState().fetchTasks("team-a", page);
    expect(api.listWithAgents).toHaveBeenCalledTimes(2);
  });

  it("isolates failures by both team and pagination key", async () => {
    api.listWithAgents
      .mockRejectedValueOnce(new Error("First page failed"))
      .mockResolvedValue(result);
    await useBackendStore.getState().fetchTasks("team-a", page);
    await useBackendStore
      .getState()
      .fetchTasks("team-a", { ...page, offset: 12 });
    await useBackendStore.getState().fetchTasks("team-b", page);
    expect(useBackendStore.getState().tasksErrorsByTeam["team-a"]).toEqual({
      "0:12": "First page failed",
    });
    expect(useBackendStore.getState().tasksErrorsByTeam["team-b"]).toEqual({});
    expect(
      useBackendStore.getState().tasksPagesByTeam["team-a"]["12:12"],
    ).toHaveLength(1);
  });

  it.each(["invalidate", "clearAll"] as const)(
    "discards a stale failure after %s",
    async (action) => {
      const pending = deferred<typeof result>();
      api.listWithAgents.mockReturnValueOnce(pending.promise);
      const request = useBackendStore.getState().fetchTasks("team-a", page);
      await Promise.resolve();
      useBackendStore.getState()[action]();
      pending.reject(new Error("Old session failed"));
      await request;
      expect(useBackendStore.getState().tasksErrorsByTeam).toEqual({});
      expect(useBackendStore.getState().inflightTasks).toEqual({});
      expect(api.notify).not.toHaveBeenCalled();
    },
  );

  it("team invalidation lets a new request replace a stale one without losing other pages", async () => {
    const oldRequest = deferred<typeof result>();
    const newRequest = deferred<typeof result>();
    api.listWithAgents
      .mockResolvedValueOnce(result)
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);
    await useBackendStore.getState().fetchTasks("team-b", page);
    const stale = useBackendStore.getState().fetchTasks("team-a", page);
    await Promise.resolve();
    useBackendStore.getState().invalidateTeam("team-a");
    const fresh = useBackendStore.getState().fetchTasks("team-a", page);
    await Promise.resolve();
    oldRequest.reject(new Error("Stale team request"));
    await stale;
    expect(useBackendStore.getState().tasksErrorsByTeam["team-a"]).toEqual({});
    expect(
      useBackendStore.getState().inflightTasks["team-a:0:12"],
    ).toBeDefined();
    expect(
      useBackendStore.getState().tasksPagesByTeam["team-b"]["0:12"],
    ).toHaveLength(1);
    newRequest.resolve(result);
    await fresh;
    expect(
      useBackendStore.getState().tasksPagesByTeam["team-a"]["0:12"],
    ).toHaveLength(1);
    expect(api.notify).not.toHaveBeenCalled();
  });

  it("clears a settled error on team invalidation and permits a fresh load", async () => {
    api.listWithAgents
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValueOnce(result);
    await useBackendStore.getState().fetchTasks("team-a", page);
    useBackendStore.getState().invalidateTeam("team-a");
    expect(
      useBackendStore.getState().tasksErrorsByTeam["team-a"],
    ).toBeUndefined();
    await useBackendStore.getState().fetchTasks("team-a", page);
    expect(api.listWithAgents).toHaveBeenCalledTimes(2);
    expect(
      useBackendStore.getState().tasksPagesByTeam["team-a"]["0:12"],
    ).toHaveLength(1);
  });
});
