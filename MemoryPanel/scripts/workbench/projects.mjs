import {
  mkdir,
  readFile,
  writeFile,
  realpath,
  lstat,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export async function projectManager({ root, projectRoot, repos, command }) {
  const file = path.join(root, "projects.json");
  let created = [];
  try {
    created = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  for (const p of created)
    if (!repos.includes(`id:${p.id}`)) repos.push(`id:${p.id}`);
  let creating = false;
  return {
    async list() {
      const data = await command(["repo", "list"]);
      return (data.repos || [])
        .filter((r) => repos.includes(`id:${r.id}`))
        .map((r) => ({
          id: r.id,
          name: r.displayName || path.basename(r.path),
        }));
    },
    async create(name) {
      if (!projectRoot) throw Error("Project creation is not configured.");
      if (
        typeof name !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9 _-]{1,59}$/.test(name)
      )
        throw Error(
          "Use 2–60 letters, numbers, spaces, underscores, or hyphens.",
        );
      if (creating) throw Error("A project is being created.");
      creating = true;
      try {
        await mkdir(projectRoot, { recursive: true, mode: 0o700 });
        const base = await realpath(projectRoot);
        const dir = path.join(base, name.toLowerCase().replace(/ +/g, "-"));
        const registered = await command(["repo", "list"]);
        const known = registered.repos?.find((r) => r.path === dir);
        if (known && created.some((p) => p.id === known.id))
          return { id: known.id, name: known.displayName || name };
        try {
          await lstat(dir);
          throw Error(
            "That project folder already exists. Choose another name.",
          );
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        await mkdir(dir, { mode: 0o700 });
        await exec("git", ["init", "-b", "main", dir]);
        await writeFile(
          path.join(dir, "README.md"),
          `# ${name}\n\nCreated through Tencent Workbench.\n`,
          { flag: "wx" },
        );
        await exec("git", ["-C", dir, "add", "README.md"]);
        await exec("git", [
          "-C",
          dir,
          "-c",
          "user.name=Workbench",
          "-c",
          "user.email=workbench@localhost",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "-m",
          "Initialize Workbench project",
        ]);
        const result = await command(["repo", "add", "--path", dir]);
        if (!result.repo?.id)
          throw Error(
            "Project registration outcome uncertain. Inspect Orca before retrying.",
          );
        const project = {
          id: result.repo.id,
          name: result.repo.displayName || name,
        };
        created.push(project);
        await writeFile(file + ".tmp", JSON.stringify(created), {
          mode: 0o600,
        });
        await rename(file + ".tmp", file);
        repos.push(`id:${project.id}`);
        return project;
      } finally {
        creating = false;
      }
    },
  };
}
