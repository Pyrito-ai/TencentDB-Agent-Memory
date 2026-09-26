import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
const exec = promisify(execFile);
const digest = (text) => createHash("sha256").update(text).digest("hex");
async function git(root, args) {
  const { stdout } = await exec(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.quotePath=false",
      "-C",
      root,
      ...args,
    ],
    {
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
    },
  );
  return stdout;
}
async function rootFor(job) {
  if (job.host !== "local" || !job.directory || !job.base)
    throw Error("Local worktree inspection unavailable.");
  const root = await realpath(job.directory);
  if (
    root !== job.directory ||
    path.resolve((await git(root, ["rev-parse", "--show-toplevel"])).trim()) !==
      root
  )
    throw Error("Worktree identity changed.");
  return root;
}
function validFile(file) {
  return (
    typeof file === "string" &&
    file.length > 0 &&
    file.length < 2000 &&
    !file.includes("\\") &&
    !path.isAbsolute(file) &&
    file
      .split("/")
      .every((p) => p && p !== "." && p !== ".." && p !== ".git") &&
    !file.includes("\0")
  );
}
async function bytes(root, file) {
  if (!validFile(file)) throw Error("Invalid path.");
  let current = root;
  for (const part of file.split("/")) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink())
      throw Error("Symlinks are not readable.");
  }
  const stat = await lstat(current);
  if (!stat.isFile() || stat.size > 256000)
    throw Error("File too large or not regular.");
  if ((await realpath(current)) !== current) throw Error("Path changed.");
  return readFile(current);
}
async function files(root) {
  return [
    ...new Set(
      (
        await git(root, [
          "ls-files",
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
        ])
      )
        .split("\0")
        .filter(validFile),
    ),
  ].sort();
}
export async function readWorkspaceFile(job, file) {
  const root = await rootFor(job);
  if (!(await files(root)).includes(file))
    throw Error("File is not in the worktree.");
  const content = await bytes(root, file);
  if (content.includes(0)) throw Error("Binary file cannot be displayed.");
  return { path: file, content: content.toString("utf8") };
}
export async function inspectWorkspace(job) {
  const root = await rootFor(job);
  if (!/^[a-f0-9]{40,64}$/.test(job.base)) throw Error("Invalid base commit.");
  const [names, status, patch, branch] = await Promise.all([
    files(root),
    git(root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-status",
      "-z",
      job.base,
      "--",
    ]),
    git(root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--no-color",
      job.base,
      "--",
    ]),
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);
  const statuses = new Map();
  const parts = status.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2)
    statuses.set(parts[i + 1], parts[i]);
  const untracked = (
    await git(root, ["ls-files", "-z", "--others", "--exclude-standard"])
  )
    .split("\0")
    .filter(validFile);
  for (const file of untracked) statuses.set(file, "?");
  let diff = patch;
  let truncated = names.length > 1000 || patch.length > 250000;
  const hashes = [];
  for (const [file, status] of statuses) {
    if (status === "D") {
      hashes.push([file, "deleted"]);
      continue;
    }
    try {
      const data = await bytes(root, file);
      hashes.push([file, digest(data)]);
      if (data.includes(0)) {
        truncated = true;
        continue;
      }
      if (status === "?")
        diff +=
          `\n--- /dev/null\n+++ b/${file}\n` +
          data
            .toString("utf8")
            .split("\n")
            .map((l) => "+" + l)
            .join("\n");
    } catch {
      truncated = true;
      hashes.push([file, "unreadable"]);
    }
  }
  if (diff.length > 250000) truncated = true;
  return {
    files: [...new Set([...names, ...statuses.keys()])]
      .slice(0, 1000)
      .map((file) => ({ path: file, status: statuses.get(file) || " " })),
    branch: branch.trim(),
    base: job.base,
    diff: diff.slice(0, 250000),
    snapshot: digest(JSON.stringify({ base: job.base, patch, hashes })),
    truncated,
    notice: truncated
      ? "Some files or changes cannot be displayed completely. Inspect them in Orca before approval."
      : undefined,
  };
}
