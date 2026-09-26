import { metaContracts } from "./meta-contracts.js";
export type Action = {
  path: string;
  method: "GET" | "POST";
  read: boolean;
  description: string;
  schema: unknown;
};
export function actions(team: string): Record<string, Action> {
  const result: Record<string, Action> = {};
  for (const [name, contract] of Object.entries(metaContracts)) {
    if (
      [
        "team/create",
        "team-member/add",
        "team-member/remove",
        "asset/create",
      ].includes(name)
    )
      continue;
    result["meta/" + name] = {
      path: "/meta/" + name,
      method: "POST",
      read: /\/(get|list|list-accessible|board-state|get-default-template)$/.test(
        name,
      ),
      ...contract,
    };
  }
  const add = (
    family: string,
    names: string[],
    read: string[],
    description: string,
  ) => {
    for (const name of names)
      result[family + "/" + name] = {
        path: `/${family}/${encodeURIComponent(team)}/${name}`,
        method: read.includes(name) ? "GET" : "POST",
        read: read.includes(name),
        description,
        schema: { type: "object" },
      };
  };
  add(
    "projects",
    ["list", "create", "update", "assign", "archive"],
    ["list"],
    "Projects: create/update {id?,name,description}; assign {task,projectId}; archive {id,archived:boolean}.",
  );
  add(
    "areas",
    ["list", "create", "update", "archive"],
    ["list"],
    "Areas: create/update {id?,name,description}; archive {id,archived:boolean}.",
  );
  add(
    "loops",
    [
      "list",
      "create",
      "update",
      "archive",
      "start",
      "skip",
      "complete",
      "undo",
    ],
    ["list"],
    "Recurring work. create/update {id?,name,brief,mode:flexible|scheduled,areaId,ownerId,projectId?,frequency:daily|weekly|monthly,target:1-100,agents:[agent IDs],timezone,startDate?:YYYY-MM-DD}. Scheduled target must be 1. start/skip {loopId,requestId:unique UUID,agentId:agent ID or empty string,dueDay?:YYYY-MM-DD,note?:string}; complete {id:occurrence ID,note,resultUrl,timeIds:[]}; undo {id:occurrence ID}; archive {id,archived:boolean}. Read list and preserve existing fields before updating.",
  );
  add(
    "timesheets",
    ["list", "approve", "reopen"],
    ["list"],
    "Time review. List requires {from:YYYY-MM-DD,to:YYYY-MM-DD,author?:user ID}. List first; review with {ids:[entry IDs]}. Does not make payments.",
  );
  add(
    "workbench",
    [
      "options",
      "handoff-profiles",
      "handoff-get",
      "handoff-launch",
      "handoff-sync",
      "context-get",
      "context-preview",
      "context-save",
      "context-catalog",
      "context-pages",
      "project-create",
    ],
    ["options", "handoff-profiles"],
    "Orca handoff: {taskId,binding,agent:codex|claude,profileId?}. Read options and handoff-get first. Wiki context: {kind:task|project,id}; save requires revision and references [{kind:wiki_page,wikiId,ref}]. project-create {runtime,name}.",
  );
  for (const name of [
    "handoff-get",
    "context-get",
    "context-preview",
    "context-catalog",
    "context-pages",
  ])
    result["workbench/" + name]!.read = true;
  for (const [family, names] of Object.entries({
    time: ["list", "start", "stop", "manual"],
    activity: ["list", "note"],
  }))
    for (const name of names)
      result[`task/${family}/${name}`] = {
        path: `/task/${family}/:taskId/${name}`,
        method: name === "list" ? "GET" : "POST",
        read: name === "list",
        description:
          family === "time"
            ? "Task time {taskId,id?,note?,seconds?,started?}; manual time in seconds and start epoch milliseconds."
            : "Task notes {taskId,text}.",
        schema: { type: "object" },
      };
  const post = (name: string, read: boolean, description: string) => {
    result[name] = {
      path: "/" + name,
      method: "POST",
      read,
      description,
      schema: { type: "object" },
    };
  };
  for (const name of [
    "list",
    "get",
    "graph",
    "page/ls",
    "page/read",
    "search",
    "raw/ls",
    "raw/read",
  ])
    post(
      "knowledge/wiki/" + name,
      true,
      "Wiki read {wiki_id,query?,refs?:[page paths],filenames?:[raw filenames],limit?}; list uses team_id. Discover exact refs with page/ls before read.",
    );
  post("knowledge/wiki/create", false, "Create Wiki {team_id,name}.");
  post(
    "knowledge/wiki/ingest",
    false,
    "Start Wiki ingestion {wiki_id}. This may incur model/API costs: disclose before proposing.",
  );
  post(
    "knowledge/wiki/raw/write",
    false,
    "Write Wiki source files {team_id,wiki_id,files:[{path,content}]}. Does not automatically ingest.",
  );
  for (const name of ["list", "get", "search", "explore"])
    post(
      "knowledge/code-graph/" + name,
      true,
      "Code graph {code_graph_id,query?,limit?}; list uses team_id.",
    );
  for (const name of [
    "list",
    "get",
    "search",
    "versions",
    "files/read",
    "listing",
  ])
    post(
      "skill/" + name,
      true,
      "Skills {team_id,user_id,agent_id?,task_id?,skill_id?,query?,paths?}. Use exact IDs returned by list.",
    );
  for (const name of [
    "create",
    "update",
    "patch",
    "files/write",
    "conversation/add",
  ])
    post(
      "skill/" + name,
      false,
      "Skill changes. Required identity: team_id,user_id,agent_id; existing skill_id for changes. Do not invent payload fields; ask for details if not known.",
    );
  for (const name of ["mine", "search", "layer"])
    post(
      "chat-memory/" + name,
      true,
      "Chat memory {team_id,agent_id?,query?,asset_id?,layer?}. Read accessible asset/agent IDs first.",
    );
  for (const [name, a] of Object.entries(result))
    if (name.startsWith("meta/"))
      a.description +=
        ". List uses {limit,offset}, scoped to current team. Get/update/archive requires exact " +
        name.split("/")[1]?.replaceAll("-", "_") +
        "_id. task/create {title,description?}; task/update {task_id,title?,description?,metadata_json?}; agent/create/update {agent_id?,name,description?,prompt?,visibility?}. Never invent board-transition revision; read board-state first. Actor identity is set by server.";
  const contracts: Record<string, string> = {
    "skill/create":
      "Create {name,content,resources?:[{path,content,encoding:utf-8|base64}],metadata?}.",
    "skill/update":
      "Replace skill content {skill_id,expected_version,content}. Read get first.",
    "skill/patch":
      "Patch {skill_id,expected_version,old_string,new_string,replace_all?:boolean}. Read get first.",
    "skill/files/write":
      "Write {skill_id,expected_version,files:[{path,content,encoding:utf-8|base64}]}.",
    "skill/files/read": "Read {skill_id,path,version?,encoding?:utf-8|base64}.",
    "skill/list":
      "List {filters?:{name_prefix?,status?:[active|archived]},pagination?:{limit,offset}}.",
    "skill/search": "Search {query,top_k?,mode?:bm25|embedding|hybrid}.",
    "skill/get":
      "Read {skill_id,version?,include_content?:boolean,include_manifest?:boolean}.",
    "skill/versions": "Versions {skill_id,pagination?:{limit,offset}}.",
  };
  for (const [name, description] of Object.entries(contracts))
    result[name]!.description =
      description +
      " Identity is supplied by the server; agent_id and task_id are optional scope filters.";
  return result;
}
export function redact(value: any): any {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/(password|secret|token|user_?key|api_?key|authorization|gateway_?endpoint)/i.test(
              key,
            ),
        )
        .map(([k, v]) => [k, redact(v)]),
    );
  return value;
}
