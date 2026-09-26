/** Explicit subscription-worker smoke test. Creates only an isolated fixture project. */
import { mkdir, cp, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import {
  createSeoAuditFixture,
  seoFixtureRoot,
} from "./seo-audit-pilot-fixture.js";
// @ts-ignore Native runtime module, not part of the Panel build.
import { createCdesktopBridge } from "./cdesktop-runner.mjs";

const [
  flag,
  suppliedRoot,
  cdesktopUrl = "http://127.0.0.1:8131",
  webUrl = "http://127.0.0.1:5190",
] = process.argv.slice(2);
if (flag !== "--live" || !suppliedRoot || !path.isAbsolute(suppliedRoot))
  throw Error(
    "Usage: node --import tsx scripts/workbench/seo-audit-live-pilot.ts --live <new-absolute-output-directory> [cdesktop-origin] [web-origin]. Uses your configured Codex subscription.",
  );
const root = suppliedRoot;
await mkdir(root, { mode: 0o700 }); // Deliberately refuses to replay an existing pilot.
const repo = path.join(root, "site-repo");
await mkdir(repo);
await cp(path.join(seoFixtureRoot, "site"), path.join(repo, "site"), {
  recursive: true,
});
await writeFile(
  path.join(repo, "README.md"),
  "# SEO Audit test fixture\nSynthetic staging page. This repository has no remote. Only SEO-AUDIT.md may be produced by the pilot worker.\n",
);
execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
execFileSync("git", ["add", "README.md", "site"], { cwd: repo });
execFileSync(
  "git",
  [
    "-c",
    "user.name=SEO Audit Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Seed synthetic SEO audit fixture",
  ],
  { cwd: repo, stdio: "ignore" },
);
const token = randomBytes(32).toString("hex");
const bridge = await createCdesktopBridge({
  token,
  root: path.join(root, "bridge"),
  repos: [{ id: "seo-audit-pilot", path: repo, targetBranch: "main" }],
  cdesktopUrl,
  webUrl,
});
bridge.listen(0, "127.0.0.1");
await once(bridge, "listening");
const url = `http://127.0.0.1:${(bridge.address() as any).port}`;
const fixture = await createSeoAuditFixture(path.join(root, "tencent"), {
  binding: {
    id: "seo-pilot",
    label: "SEO Audit isolated test",
    repo: "seo-audit-pilot",
    url,
    webUrl,
    token,
  },
});
try {
  const response = await fixture.request("cdesktop-handoff-launch", {
    taskId: fixture.task.task_id,
    profileId: fixture.agentId,
    binding: fixture.binding.id,
    agent: "codex",
  });
  const result = (await response.json()) as any;
  if (!response.ok || !result.handoff?.receipt || result.handoff.error)
    throw Error(JSON.stringify(result));
  const handoff = result.handoff;
  await writeFile(
    path.join(root, "handoff.json"),
    JSON.stringify(handoff, null, 2),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(root, "result.json"),
    JSON.stringify(
      {
        agentId: fixture.agentId,
        skillId: fixture.skillId,
        skillVersion: fixture.skillVersion,
        taskId: fixture.task.task_id,
        packageDigest: handoff.bundle.digest,
        sourceRepo: repo,
        receipt: handoff.receipt,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      phase: "launched",
      files: handoff.bundle.files.length,
      packageDigest: handoff.bundle.digest,
      receipt: handoff.receipt,
    }),
  );
  for (
    let attempt = 0;
    attempt < 24 && handoff.receipt.state === "running";
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10000));
    const synced = (await (
      await fixture.request("cdesktop-handoff-sync", {
        taskId: fixture.task.task_id,
      })
    ).json()) as any;
    if (synced.error || synced.handoff?.error)
      throw Error(synced.error || synced.handoff.error);
    handoff.receipt = synced.handoff.receipt;
    await writeFile(
      path.join(root, "receipt.json"),
      JSON.stringify(handoff.receipt, null, 2),
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        phase: "observed",
        state: handoff.receipt.state,
        status: handoff.receipt.processStatus,
        worktree: handoff.receipt.worktree,
      }),
    );
  }
} finally {
  fixture.close();
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
}
