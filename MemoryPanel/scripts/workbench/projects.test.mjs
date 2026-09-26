import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectManager } from "./projects.mjs";
test("project creation is bounded, durable, and idempotent for registered projects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wb-projects-"));
  const repos = ["id:allowed"];
  const registry = [
    { id: "allowed", path: "/allowed", displayName: "Allowed" },
    { id: "hidden", path: "/hidden" },
  ];
  let added = 0;
  const command = async (args) =>
    args[1] === "list"
      ? { repos: registry }
      : {
          repo: registry[
            registry.push({
              id: "new",
              path: args[3],
              displayName: "New project",
            }) - 1
          ],
          count: ++added,
        };
  try {
    const manager = await projectManager({
      root,
      projectRoot: path.join(root, "projects"),
      repos,
      command,
    });
    assert.equal((await manager.list()).length, 1);
    for (const name of ["../escape", "/tmp/escape", "x", "hello;echo bad"])
      await assert.rejects(() => manager.create(name));
    const p = await manager.create("New Project");
    assert.equal(p.id, "new");
    assert.ok(repos.includes("id:new"));
    assert.equal((await manager.create("New Project")).id, "new");
    assert.equal(added, 1);
    const nextRepos = ["id:allowed"];
    const restored = await projectManager({
      root,
      projectRoot: path.join(root, "projects"),
      repos: nextRepos,
      command,
    });
    assert.equal((await restored.list()).length, 2);
    await mkdir(path.join(root, "projects", "occupied"));
    await assert.rejects(() => manager.create("Occupied"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
