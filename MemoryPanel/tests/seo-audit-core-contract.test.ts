import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSeoAuditFixture } from "../scripts/workbench/seo-audit-pilot-fixture.js";
import {
  importSeoAuditAgent,
  readSeoAuditPackage,
} from "../scripts/workbench/seo-audit-package.js";
// Node bridge consumes the exact serialized bundle the real Panel route emitted.
// @ts-expect-error runtime JavaScript module
import { validateBundle } from "../scripts/workbench/agent-bundle.mjs";

test("native Agent/Skill/Wiki ACL/L3 stores assemble pinned pilot for both runtime handoffs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "seo-audit-core-contract-"));
  const launches: any[] = [];
  const fixture = await createSeoAuditFixture(root, {
    binding: {
      id: "pilot",
      label: "pilot",
      repo: "seo-pilot",
      url: "http://127.0.0.1:1",
      token: "x".repeat(32),
    },
    runner: {
      launch: async (
        _b: any,
        id: string,
        _a: any,
        spec: string,
        bundle: any,
      ) => {
        launches.push({ spec, bundle });
        return { id, state: "running" };
      },
      read: async (_b: any, id: string) => ({ id, state: "running" }),
    } as any,
  });
  try {
    for (const prefix of ["", "cdesktop-"]) {
      const response = await fixture.request(`${prefix}handoff-launch`, {
        taskId: fixture.task.task_id,
        binding: "pilot",
        agent: "codex",
        profileId: fixture.agentId,
      });
      const data = (await response.json()) as any;
      expect(data.error).toBeUndefined();
      expect(response.status).toBe(200);
      expect(data.handoff.error).toBeUndefined();
      const bundle = validateBundle(data.handoff.bundle);
      const file = (name: string) =>
        bundle.files.find((f: any) => f.path === name);
      expect(file("skills/seo-audit/SKILL.md").content).toContain(
        "version: 2.0.1",
      );
      expect(file("skills/seo-audit/scripts/inspect-html.mjs").executable).toBe(
        true,
      );
      expect(file("context/wiki.md").content).toContain("noindex");
      expect(file("context/memory.md").content).toContain(
        "fixture-memory-report-style",
      );
      expect(launches.at(-1).bundle).toEqual(bundle);
      const manifest = JSON.parse(file("manifest.json").content);
      expect(manifest.agent.id).toBe(fixture.agentId);
      expect(manifest.memory.layer).toBe("L3");
      expect(manifest.memory.readOnly).toBe(true);
      expect(manifest.skills[0].version).toBe(1);
    }
    expect(launches).toHaveLength(2);
    const beforeReplay = await fixture.meta("agent/get", {
      agent_id: fixture.agentId,
    });
    const currentMetadata = JSON.parse(beforeReplay.data.metadata_json);
    const pkg = await readSeoAuditPackage();
    const writes: string[] = [];
    const replay = await importSeoAuditAgent({
      team: fixture.team.team_id,
      user: fixture.user.user_id,
      existing: {
        agentId: fixture.agentId,
        skillId: fixture.skillId,
        skillVersion: fixture.skillVersion,
        packageHash: pkg.packageHash,
        complete: true,
      },
      meta: async (action, body) => {
        if (action !== "agent/get") writes.push(action);
        return fixture.meta(action, body);
      },
      skill: fixture.skill,
    });
    expect(replay.metadata).toEqual(currentMetadata);
    expect(writes).toEqual([]);
    await expect(
      importSeoAuditAgent({
        team: fixture.team.team_id,
        user: fixture.user.user_id,
        existing: { pending: "agent/create", packageHash: pkg.packageHash },
        meta: fixture.meta,
        skill: fixture.skill,
      }),
    ).rejects.toThrow("uncertain");
    const source = await fixture.meta("asset/update", {
      asset_id: fixture.skillId,
      status: "archived",
    });
    expect(source.code).toBe(0);
    const revoked = await fixture.request("handoff-get", {
      taskId: fixture.task.task_id,
    });
    expect(revoked.status).toBe(409);
    expect(launches).toHaveLength(2);
  } finally {
    fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
