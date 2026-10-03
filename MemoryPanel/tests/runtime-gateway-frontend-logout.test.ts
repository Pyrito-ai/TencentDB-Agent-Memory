import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  session: null as { instanceId: string; userKey: string } | null,
  team: null as string | null,
  unauthorized: (() => {}) as () => void,
  steps: [] as string[],
  clearAuth: vi.fn(),
  clearBackendCache: vi.fn(),
}));
vi.mock("@/components/LoginGate", () => ({
  readAuth: () => null,
  resumeSession: async () => null,
  clearAuth: () => {
    state.steps.push("clear-auth");
    state.session = null;
    state.clearAuth();
  },
}));
vi.mock("@/lib/teamApi", () => ({
  onUnauthorized: (handler: () => void) => {
    state.unauthorized = handler;
  },
}));
vi.mock("@/lib/panelSession", () => ({ getPanelSession: () => state.session }));
vi.mock("@/services", () => ({
  clearBackendCache: state.clearBackendCache,
  readActiveTeamId: () => state.team,
  writeActiveTeamId: (team: string | null) => {
    state.steps.push("clear-team");
    state.team = team;
  },
}));
import { useAuthStore } from "../web/src/stores/auth";

beforeEach(() => {
  vi.clearAllMocks();
  state.session = { instanceId: "instance-1", userKey: "test-only-key" };
  state.team = "team / & #";
  state.steps = [];
  useAuthStore.setState({ auth: null });
});
afterEach(() => vi.unstubAllGlobals());

describe("cdesktop browser revocation on logout", () => {
  it("dispatches authenticated revocation before clearing and does not wait on the network", async () => {
    const fetch = vi.fn(() => {
      state.steps.push("revoke");
      expect(state.session?.userKey).toBe("test-only-key");
      expect(state.team).toBe("team / & #");
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", fetch);
    await useAuthStore.getState().logout();
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/workbench/team%20%2F%20%26%20%23/cdesktop-browser-revoke",
      expect.objectContaining({
        method: "POST",
        keepalive: true,
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Tdai-Service-Id": "instance-1",
          "X-Tdai-User-Key": "test-only-key",
        },
      }),
    );
    expect(state.steps).toEqual(["revoke", "clear-team", "clear-auth"]);
    expect(state.clearBackendCache).toHaveBeenCalledOnce();
    expect(useAuthStore.getState().auth).toBeUndefined();
  });

  it("also tries revocation on 401 without a recursive authenticated API request", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    state.unauthorized();
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledOnce();
    expect(state.clearAuth).toHaveBeenCalledOnce();
    expect(useAuthStore.getState().auth).toBeUndefined();
  });

  it.each(["reject", "throw"])(
    "completes logout when revocation fails by %s",
    async (failure) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          if (failure === "throw") throw new Error("Network unavailable");
          return Promise.reject(new Error("Network unavailable"));
        }),
      );
      await useAuthStore.getState().logout();
      expect(state.session).toBeNull();
      expect(state.team).toBeNull();
      expect(useAuthStore.getState().auth).toBeUndefined();
    },
  );

  it.each(["team", "session"])(
    "clears local auth when no %s is available for revocation",
    async (missing) => {
      if (missing === "team") state.team = null;
      else state.session = null;
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await useAuthStore.getState().logout();
      expect(fetch).not.toHaveBeenCalled();
      expect(state.clearAuth).toHaveBeenCalledOnce();
      expect(useAuthStore.getState().auth).toBeUndefined();
    },
  );
});
