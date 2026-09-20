import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  symlink,
  mkdir,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { inspectWorkspace, readWorkspaceFile } from "./workspace.mjs";
test("worktree snapshots include committed and uncommitted changes, with safe file reads", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wb-files-"));
  const directory = path.join(root, "repo");
  await mkdir(directory);
  const git = (...args) =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
    }).trim();
  try {
    git("init", "-q");
    git("config", "user.name", "Workbench Test");
    git("config", "user.email", "test@example.invalid");
    await writeFile(path.join(directory, "file.ts"), "original\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    const job = { host: "local", directory: await realpath(directory), base };
    await writeFile(path.join(directory, "file.ts"), "committed change\n");
    git("add", ".");
    git("commit", "-qm", "worker edit");
    await writeFile(path.join(directory, "new.ts"), "new file\n");
    const first = await inspectWorkspace(job);
    assert.ok(first.diff.includes("+committed change"));
    assert.ok(first.diff.includes("+new file"));
    assert.equal(first.truncated, false);
    assert.equal(
      (await readWorkspaceFile(job, "file.ts")).content,
      "committed change\n",
    );
    await writeFile(path.join(directory, "file.ts"), "later change\n");
    assert.notEqual((await inspectWorkspace(job)).snapshot, first.snapshot);
    await assert.rejects(() => readWorkspaceFile(job, "../secret"));
    await assert.rejects(() => readWorkspaceFile(job, ".git/config"));
    await assert.rejects(() =>
      readWorkspaceFile({ ...job, host: "ssh:host" }, "file.ts"),
    );
    await writeFile(path.join(root, "secret"), "private");
    await symlink(path.join(root, "secret"), path.join(directory, "link"));
    await assert.rejects(() => readWorkspaceFile(job, "link"));
    assert.equal((await inspectWorkspace(job)).truncated, true);
    assert.equal(await readFile(path.join(root, "secret"), "utf8"), "private");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
