import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGatewayConnection,
  type GatewayConnectionState,
} from "../web/src/pages/OrcaWorkbench/runtimeGatewayConnection";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function attempt() {
  const changes: GatewayConnectionState[] = [];
  const connection = createGatewayConnection((state) => changes.push(state));
  return { connection, changes, last: () => changes.at(-1) };
}

describe("cdesktop iframe connection deadlines", () => {
  it("bounds grant waiting and never treats the initial blank frame as a connected session", () => {
    const { connection, last } = attempt();
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

  it("gives the posted document its own 45 seconds regardless of time spent obtaining the grant", () => {
    const { connection, last } = attempt();
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

  it("recovers a late load from the same posted attempt and clears its timeout message without replaying", () => {
    const { connection, last } = attempt();
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

  it("does not recover an invalid or unsubmitted grant through a later blank load", () => {
    const { connection, last } = attempt();
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

  it("cancels disposed attempts so late grants, loads and timers cannot affect a replacement", () => {
    const old = attempt();
    old.connection.submit(vi.fn());
    old.connection.dispose();
    const replacement = attempt();
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

  it("allows a fresh attempt after a cancelled setup without reviving the cancelled one", () => {
    const probe = attempt();
    probe.connection.dispose();
    const live = attempt();
    const cancelledPost = vi.fn();
    const livePost = vi.fn();
    expect(probe.connection.submit(cancelledPost)).toBe(false);
    expect(live.connection.submit(livePost)).toBe(true);
    expect(live.connection.submit(livePost)).toBe(false);
    live.connection.frameLoaded();
    expect(probe.changes).toEqual([]);
    expect(cancelledPost).not.toHaveBeenCalled();
    expect(livePost).toHaveBeenCalledOnce();
    expect(live.last()?.phase).toBe("ready");
  });
});
