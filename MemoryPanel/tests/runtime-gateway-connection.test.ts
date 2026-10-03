import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGatewayConnection,
  isGatewayDocumentLoad,
  type GatewayConnectionState,
} from "../web/src/pages/OrcaWorkbench/runtimeGatewayConnection";

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function attempt() {
  const changes: GatewayConnectionState[] = [];
  const connection = createGatewayConnection((state) => changes.push(state));
  return { connection, changes, last: () => changes.at(-1) };
}

async function start(
  connection: ReturnType<typeof createGatewayConnection>,
  request = vi.fn(),
) {
  connection.startGrant(request);
  await Promise.resolve();
  return request;
}

describe("cdesktop iframe connection deadlines", () => {
  it("bounds grant waiting and never treats the initial blank frame as a connected session", async () => {
    const { connection, last } = attempt();
    await start(connection);
    connection.frameLoaded();
    connection.frameLoaded();
    expect(connection.phase).toBe("waiting");
    vi.advanceTimersByTime(19_999);
    expect(last()).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(last()).toMatchObject({ phase: "error", submitted: false });
    const latePost = vi.fn();
    expect(connection.submit(latePost)).toBe(false);
    connection.frameLoaded();
    expect(latePost).not.toHaveBeenCalled();
    expect(connection.phase).toBe("error");
  });

  it("gives the posted document its own 45 seconds regardless of time spent obtaining the grant", async () => {
    const { connection, last } = attempt();
    await start(connection);
    vi.advanceTimersByTime(19_000);
    const post = vi.fn();
    expect(connection.submit(post)).toBe(true);
    expect(last()).toEqual({ phase: "submitted", submitted: true, error: "" });
    vi.advanceTimersByTime(44_999);
    expect(connection.phase).toBe("submitted");
    vi.advanceTimersByTime(1);
    expect(last()).toMatchObject({ phase: "timed-out", submitted: true });
    expect(post).toHaveBeenCalledOnce();
  });

  it("recovers a late load from the same posted attempt and clears its timeout message without replaying", async () => {
    const { connection, last } = attempt();
    await start(connection);
    const post = vi.fn();
    connection.submit(post);
    vi.advanceTimersByTime(45_000);
    expect(last()?.error).toMatch(/longer than expected/);
    expect(connection.submit(post)).toBe(false);
    connection.frameLoaded();
    expect(last()).toEqual({ phase: "ready", submitted: true, error: "" });
    vi.advanceTimersByTime(120_000);
    expect(connection.phase).toBe("ready");
    expect(connection.submit(post)).toBe(false);
    expect(post).toHaveBeenCalledOnce();
  });

  it("does not recover an invalid or unsubmitted grant through a later blank load", async () => {
    const { connection, last } = attempt();
    await start(connection);
    const post = vi.fn(() => {
      throw new Error("Invalid session grant");
    });
    expect(() => connection.submit(post)).toThrow("Invalid session grant");
    connection.fail("Unable to open the saved session.");
    connection.frameLoaded();
    vi.advanceTimersByTime(60_000);
    expect(last()).toEqual({
      phase: "error",
      submitted: false,
      error: "Unable to open the saved session.",
    });
    expect(post).toHaveBeenCalledOnce();
  });

  it("cancels disposed attempts so late grants, loads and timers cannot affect a replacement", async () => {
    const old = attempt();
    await start(old.connection);
    old.connection.submit(vi.fn());
    old.connection.dispose();
    const replacement = attempt();
    await start(replacement.connection);
    const oldPost = vi.fn();
    expect(old.connection.submit(oldPost)).toBe(false);
    old.connection.frameLoaded();
    old.connection.fail("Late error");
    expect(old.changes).toHaveLength(1);
    expect(replacement.last()).toBeUndefined();
    expect(oldPost).not.toHaveBeenCalled();
    replacement.connection.submit(vi.fn());
    replacement.connection.frameLoaded();
    vi.advanceTimersByTime(120_000);
    expect(old.changes).toHaveLength(1);
    expect(replacement.last()).toEqual({
      phase: "ready",
      submitted: true,
      error: "",
    });
  });

  it("cancels a queued StrictMode probe before it can request a grant or arm a deadline", async () => {
    const probe = attempt();
    const cancelledRequest = vi.fn();
    probe.connection.startGrant(cancelledRequest);
    probe.connection.dispose();
    const live = attempt();
    const request = await start(live.connection);
    const cancelledPost = vi.fn();
    const livePost = vi.fn();
    expect(probe.connection.submit(cancelledPost)).toBe(false);
    expect(live.connection.submit(livePost)).toBe(true);
    expect(live.connection.submit(livePost)).toBe(false);
    live.connection.frameLoaded();
    expect(probe.changes).toEqual([]);
    expect(cancelledRequest).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
    expect(cancelledPost).not.toHaveBeenCalled();
    expect(livePost).toHaveBeenCalledOnce();
    expect(live.last()?.phase).toBe("ready");
  });

  it("requests exactly once without any initial iframe load event and rejects a late blank load", async () => {
    const { connection } = attempt();
    const post = vi.fn();
    const request = vi.fn(() => connection.submit(post));
    expect(connection.startGrant(request)).toBe(true);
    expect(connection.startGrant(request)).toBe(false);
    await Promise.resolve();
    expect(request).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledOnce();
    expect(connection.phase).toBe("submitted");
    const blankFrame = { contentDocument: { URL: "about:blank" } as Document };
    expect(isGatewayDocumentLoad(blankFrame)).toBe(false);
    if (isGatewayDocumentLoad(blankFrame)) connection.frameLoaded();
    expect(connection.phase).toBe("submitted");
    const gatewayFrame = { contentDocument: null };
    expect(isGatewayDocumentLoad(gatewayFrame)).toBe(true);
    if (isGatewayDocumentLoad(gatewayFrame)) connection.frameLoaded();
    expect(connection.phase).toBe("ready");
  });

  it("starts the grant deadline at request dispatch even when the mounted page resumes late", async () => {
    const { connection, last } = attempt();
    const request = vi.fn();
    connection.startGrant(request);
    // Simulate a delayed effect microtask. Mounting alone must not consume the request budget.
    vi.advanceTimersByTime(60_000);
    expect(last()).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(request).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(19_999);
    expect(connection.phase).toBe("waiting");
    vi.advanceTimersByTime(1);
    expect(connection.phase).toBe("error");
  });

  it("ignores accessible initial documents and accepts browser cross-origin document denial", () => {
    for (const URL of ["", "about:blank", "about:srcdoc"]) {
      expect(
        isGatewayDocumentLoad({ contentDocument: { URL } as Document }),
      ).toBe(false);
    }
    const denied = {
      get contentDocument(): Document | null {
        throw new DOMException("Cross-origin", "SecurityError");
      },
    };
    const unexpected = {
      get contentDocument(): Document | null {
        throw new Error("Unexpected read error");
      },
    };
    expect(isGatewayDocumentLoad(denied)).toBe(true);
    expect(isGatewayDocumentLoad(unexpected)).toBe(false);
  });
});
