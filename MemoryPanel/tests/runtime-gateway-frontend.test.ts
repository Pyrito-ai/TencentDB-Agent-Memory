import { describe, expect, it, vi } from "vitest";
import {
  browserGatewayBootstrapUrl,
  gatewaySessionIdentity,
  postBrowserGatewayGrant,
  validateBrowserGatewayGrant,
} from "../web/src/pages/OrcaWorkbench/runtimeGateway";
import type { CdesktopHandoff } from "../web/src/pages/OrcaWorkbench/CdesktopTaskHandoff";

const origin = "https://cdesktop.example.test";
const panelOrigin = "https://panel.example.test";
const bootstrapUrl = `${origin}/_pyrito/session`;
const now = Date.parse("2026-10-03T12:00:00Z");
const grant = {
  bootstrapUrl,
  ticket: "opaque-single-use-test-ticket",
  expiresAt: "2026-10-03T12:00:30Z",
};

describe("cdesktop browser grant validation", () => {
  it("accepts only the configured separate HTTPS origin", () => {
    expect(browserGatewayBootstrapUrl(origin, panelOrigin)).toBe(bootstrapUrl);
    expect(browserGatewayBootstrapUrl(`${origin}/`, panelOrigin)).toBe(
      bootstrapUrl,
    );
    expect(validateBrowserGatewayGrant(grant, origin, panelOrigin, now)).toBe(
      grant,
    );
  });

  it.each([
    panelOrigin,
    "http://cdesktop.example.test",
    "http://localhost:3000",
    "https://user:password@cdesktop.example.test",
    `${origin}/runtime`,
    `${origin}/?runtime=cdesktop`,
    `${origin}/#runtime`,
    "//cdesktop.example.test",
    "not a URL",
  ])("rejects unsafe gateway configuration %s", (configured) => {
    expect(() => browserGatewayBootstrapUrl(configured, panelOrigin)).toThrow(
      /configured/,
    );
  });

  it.each([
    "https://other.example.test/_pyrito/session",
    `${bootstrapUrl}?ticket=leaked`,
    `${bootstrapUrl}#fragment`,
    `${bootstrapUrl}/`,
    `${origin}/_pyrito/other`,
    "https://user@cdesktop.example.test/_pyrito/session",
    "http://localhost:3000/_pyrito/session",
    "/_pyrito/session",
  ])("rejects a grant targeting %s", (url) => {
    expect(() =>
      validateBrowserGatewayGrant(
        { ...grant, bootstrapUrl: url },
        origin,
        panelOrigin,
        now,
      ),
    ).toThrow(/secure session/);
  });

  it.each([
    null,
    {},
    { ...grant, ticket: "" },
    { ...grant, ticket: "has whitespace" },
    { ...grant, ticket: "x".repeat(8193) },
    { ...grant, ticket: 42 },
    { ...grant, expiresAt: "not-a-date" },
    { ...grant, expiresAt: 1_790_000_000_000 },
  ])("rejects an incomplete or malformed grant", (value) => {
    expect(() =>
      validateBrowserGatewayGrant(value, origin, panelOrigin, now),
    ).toThrow(/secure session/);
  });

  it("rejects a grant expired at or before submission", () => {
    expect(() =>
      validateBrowserGatewayGrant(grant, origin, panelOrigin, now + 30_000),
    ).toThrow(/expired/);
    expect(() =>
      validateBrowserGatewayGrant(grant, origin, panelOrigin, now + 30_001),
    ).toThrow(/expired/);
  });
});

describe("cdesktop saved session identity", () => {
  const handoff: CdesktopHandoff = {
    id: "handoff-1",
    binding: "project-1",
    agent: "codex",
    spec: "saved instructions",
    receipt: {
      id: "receipt-1",
      state: "running",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      webUrl:
        "http://localhost:3000/workspaces/workspace-1?sessionId=session-1",
    },
  };

  it("preserves a mounted session across receipt status and metadata refreshes", () => {
    const refreshed: CdesktopHandoff = {
      ...handoff,
      error: "temporary status refresh error",
      receipt: {
        ...handoff.receipt!,
        id: "receipt-new",
        state: "exited",
        notice: "new status",
      },
    };
    expect(gatewaySessionIdentity(refreshed)).toBe(
      gatewaySessionIdentity(handoff),
    );
  });

  it("changes only when the saved handoff or native workspace/session changes", () => {
    for (const changed of [
      { ...handoff, id: "handoff-2" },
      {
        ...handoff,
        receipt: { ...handoff.receipt!, workspaceId: "workspace-2" },
      },
      { ...handoff, receipt: { ...handoff.receipt!, sessionId: "session-2" } },
    ]) {
      expect(gatewaySessionIdentity(changed)).not.toBe(
        gatewaySessionIdentity(handoff),
      );
    }
  });
});

describe("single-use iframe POST", () => {
  function fakeDocument(throws = false) {
    const input = { type: "", name: "", value: "" };
    const form = {
      method: "",
      action: "",
      target: "",
      hidden: false,
      append: vi.fn(),
      remove: vi.fn(),
      submit: vi.fn(() => {
        expect(form.method).toBe("POST");
        expect(form.action).toBe(bootstrapUrl);
        expect(form.action).not.toContain(grant.ticket);
        expect(form.target).toBe("cdesktop-unique-frame");
        expect(form.hidden).toBe(true);
        expect(input).toEqual({
          type: "hidden",
          name: "ticket",
          value: grant.ticket,
        });
        if (throws) throw new Error("Browser refused submission");
      }),
    };
    const document = {
      createElement: vi.fn((tag: string) => (tag === "form" ? form : input)),
      body: { append: vi.fn() },
    };
    return { document: document as unknown as Document, form, input };
  }

  it.each([false, true])(
    "clears the ephemeral form, including when submission throws: %s",
    (throws) => {
      const { document, form, input } = fakeDocument(throws);
      const send = () =>
        postBrowserGatewayGrant(
          { ...grant, expiresAt: new Date(Date.now() + 30_000).toISOString() },
          origin,
          panelOrigin,
          "cdesktop-unique-frame",
          document,
        );
      if (throws) expect(send).toThrow("Browser refused submission");
      else send();
      expect(form.submit).toHaveBeenCalledOnce();
      expect(form.append).toHaveBeenCalledWith(input);
      expect(document.body.append).toHaveBeenCalledWith(form);
      expect(input.value).toBe("");
      expect(form.remove).toHaveBeenCalledOnce();
    },
  );

  it("does not create or submit a form for an invalid grant", () => {
    const { document, form } = fakeDocument();
    expect(() =>
      postBrowserGatewayGrant(
        {
          ...grant,
          bootstrapUrl: "https://attacker.example.test/_pyrito/session",
        },
        origin,
        panelOrigin,
        "cdesktop-unique-frame",
        document,
      ),
    ).toThrow(/secure session/);
    expect(document.createElement).not.toHaveBeenCalled();
    expect(form.submit).not.toHaveBeenCalled();
  });
});
