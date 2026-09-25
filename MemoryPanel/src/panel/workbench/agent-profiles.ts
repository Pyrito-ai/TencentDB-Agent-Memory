import type { PanelDeps } from "../panel-deps.js";
import type { ExecutionScope } from "./execution.js";
export type AgentProfile = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  updatedAt: string;
};
// The launcher supports owned profiles and profiles explicitly shared with the team.
function visible(a: any, s: ExecutionScope) {
  return (
    a &&
    a.team_id === s.team &&
    a.status === "active" &&
    (a.owner_user_id === s.user || a.visibility === "team")
  );
}
function snapshot(a: any): AgentProfile {
  return {
    id: a.agent_id,
    name: a.name,
    description: a.description || "",
    prompt: a.prompt || "",
    updatedAt: a.updated_at || "",
  };
}
export function agentProfiles(deps: PanelDeps) {
  return {
    async list(s: ExecutionScope) {
      const items: AgentProfile[] = [];
      for (let offset = 0; offset < 10000; offset += 100) {
        const env = await deps.metaKernel.invoke(
          "agent/list",
          { team_id: s.team, status: "active", limit: 100, offset },
          s.ctx,
        );
        if (env.code !== 0) throw Error("Agent profiles could not be loaded.");
        const data = env.data as any;
        const page = Array.isArray(data) ? data : data?.items;
        if (!Array.isArray(page))
          throw Error("Agent profiles could not be loaded.");
        items.push(...page.filter((a) => visible(a, s)).map(snapshot));
        if (page.length < 100) return items;
      }
      throw Error("Too many agent profiles to load.");
    },
    async get(s: ExecutionScope, id: string) {
      const env = await deps.metaKernel.invoke(
        "agent/get",
        { agent_id: id },
        s.ctx,
      );
      const a = env.data as any;
      if (env.code !== 0 || !visible(a, s) || a.agent_id !== id)
        throw Error(
          "Selected agent profile is unavailable or no longer accessible.",
        );
      return snapshot(a);
    },
  };
}
