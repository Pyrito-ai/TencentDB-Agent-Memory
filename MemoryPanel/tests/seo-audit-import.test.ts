import { expect, test, vi } from "vitest";
import { importSeoAuditAgent } from "../scripts/workbench/seo-audit-package.js";

test.each([
  {},
  { agent_id: "" },
  { agent_id: "  " },
  { agent_id: 123 },
])("malformed successful Agent creation retains its pending checkpoint: %j", async (data) => {
  const journal: Record<string, unknown>[] = [];
  const meta = vi.fn(async () => ({ code: 0, data }));
  const skill = vi.fn(async () => ({ code: 0, data: {} }));
  const input = {
    team: "team-pilot", user: "user-pilot", meta, skill,
    checkpoint: async (state: Record<string, unknown>) => { journal.push(structuredClone(state)); },
  };
  await expect(importSeoAuditAgent(input)).rejects.toThrow("invalid identity");
  expect(journal).toHaveLength(1);
  expect(journal.at(-1)).toMatchObject({ pending: "agent/create" });
  expect(journal.at(-1)).not.toHaveProperty("agentId");
  await expect(importSeoAuditAgent({ ...input, existing: journal.at(-1) })).rejects.toThrow("uncertain");
  expect(meta).toHaveBeenCalledTimes(1);
  expect(skill).not.toHaveBeenCalled();
  expect(journal).toHaveLength(1);
});

test.each([
  {},
  { skill_id: "", version: 1 },
  { skill_id: " ", version: 1 },
  { skill_id: "skl-pilot", version: 0 },
  { skill_id: "skl-pilot", version: 1.5 },
  { skill_id: "skl-pilot", version: "1" },
])("malformed successful Skill creation retains its pending checkpoint: %j", async (data) => {
  const journal: Record<string, unknown>[] = [];
  const meta = vi.fn(async () => ({ code: 0, data: { agent_id: "agt-pilot" } }));
  const skill = vi.fn(async () => ({ code: 0, data }));
  const input = {
    team: "team-pilot", user: "user-pilot", meta, skill,
    checkpoint: async (state: Record<string, unknown>) => { journal.push(structuredClone(state)); },
  };
  await expect(importSeoAuditAgent(input)).rejects.toThrow("invalid identity or version");
  expect(journal).toHaveLength(3);
  expect(journal.at(-1)).toMatchObject({ pending: "skill/create", agentId: "agt-pilot" });
  expect(journal.at(-1)).not.toHaveProperty("skillId");
  expect(journal.at(-1)).not.toHaveProperty("skillVersion");
  await expect(importSeoAuditAgent({ ...input, existing: journal.at(-1) })).rejects.toThrow("uncertain");
  expect(meta).toHaveBeenCalledTimes(1);
  expect(skill).toHaveBeenCalledTimes(1);
  expect(journal).toHaveLength(3);
});
