import { afterEach, expect, test, vi } from "vitest";
import { createCoordinator, replySchema } from "../src/panel/workbench/coordinator.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

test("legacy discussion responses remain action-free; send proposals require bounded exact worker identity", () => {
  expect(replySchema.parse({reply:"Discuss",workers:[]}).actions).toEqual([]);
  for (const action of [
    {type:"send",workerId:"term_other",text:"do it"},
    {type:"send",workerId:"11111111-1111-4111-8111-111111111111",text:" "},
    {type:"send",workerId:"11111111-1111-4111-8111-111111111111",text:"a".repeat(8001)},
    {type:"send",workerId:"11111111-1111-4111-8111-111111111111",text:"hello",terminal:"someone-else"},
    {type:"launch",workerId:"11111111-1111-4111-8111-111111111111",text:"hello"},
  ]) expect(replySchema.safeParse({reply:"Draft",actions:[action]}).success).toBe(false);
});

test("coordinator returns a targeted draft without making any runner call", async () => {
  vi.stubEnv("WORKBENCH_LLM_API_KEY","test-key");
  vi.stubEnv("WORKBENCH_LLM_MODEL","test-model");
  vi.stubEnv("WORKBENCH_LLM_BASE_URL","https://model.invalid/v1");
  const action={type:"send",workerId:"11111111-1111-4111-8111-111111111111",text:"Simplify the header."};
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({reply:"Ready to send",workers:[],actions:[action]})}}]}),{status:200}));
  vi.stubGlobal("fetch",fetcher);
  const result=await createCoordinator().chat([{role:"user",text:"Tell the worker to simplify the header"}],"project",[{id:action.workerId,state:"running"}]);
  expect(result.actions).toEqual([action]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe("https://model.invalid/v1/chat/completions");
  const body=JSON.parse(fetcher.mock.calls[0][1].body);
  expect(JSON.parse(body.messages[1].content).workers[0].id).toBe(action.workerId);
});
