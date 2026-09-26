import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  lstat,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  validateBundle,
  stageBundle,
  verifyBundle,
  bundlePrompt,
} from "./agent-bundle.mjs";

const hash = (data) => createHash("sha256").update(data).digest("hex");
export function testBundle(
  input = [
    {
      path: "scripts/check.mjs",
      content: "console.log('ok');\n",
      executable: true,
    },
  ],
) {
  const files = [
    {
      path: "manifest.json",
      content: '{"schema":"tencent.agent-bundle.v1"}',
      executable: false,
    },
    {
      path: "skills/seo-audit/SKILL.md",
      content: "# SEO Audit\nPrivate fixture instructions",
      executable: false,
    },
    ...input,
  ]
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map(({ path, content, executable = false }) => ({
      path,
      content,
      sha256: hash(content),
      executable,
    }));
  return {
    schema: "tencent.agent-bundle.v1",
    digest: hash(JSON.stringify(files)),
    files,
  };
}
export async function removeBundleFixture(root) {
  const stat = await lstat(root);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    await chmod(root, 0o700);
    for (const file of await readdir(root))
      await removeBundleFixture(path.join(root, file));
  }
  await rm(root, { recursive: true, force: true });
}

// Helpers live in this file only; bridge tests construct their own fixture to
// avoid importing test registrations.
test("bundle validates hashes, portable paths and bounded UTF8 files", () => {
  assert.equal(validateBundle(testBundle()).files.length, 3);
  for (const candidate of [
    "../bad",
    "/root/bad",
    "a/../bad",
    "a\\bad",
    "a//bad",
    ".bundle.json",
    "x/CON.txt",
    "foo.",
    "a\nfoo",
    "a/./b",
  ]) {
    assert.throws(() =>
      validateBundle(testBundle([{ path: candidate, content: "x" }])),
    );
  }
  for (const paths of [
    ["a", "a/b"],
    ["A/b", "a/c"],
    ["a", "a"],
    ["A", "a"],
  ]) {
    assert.throws(() =>
      validateBundle(testBundle(paths.map((path) => ({ path, content: "x" })))),
    );
  }
  assert.throws(() =>
    validateBundle(
      testBundle([{ path: "a", content: "x".repeat(128 * 1024 + 1) }]),
    ),
  );
  assert.throws(() =>
    validateBundle(
      testBundle(
        Array.from({ length: 65 }, (_, i) => ({
          path: "file" + i,
          content: "x",
        })),
      ),
    ),
  );
  assert.throws(() =>
    validateBundle(
      testBundle(
        Array.from({ length: 5 }, (_, i) => ({
          path: "file" + i,
          content: "x".repeat(128 * 1024),
        })),
      ),
    ),
  );
  assert.throws(() =>
    validateBundle(testBundle([{ path: "a", content: "\ud800" }])),
  );
  const bundle = testBundle();
  bundle.files[0].content += "changed";
  assert.throws(() => validateBundle(bundle));
  assert.throws(() =>
    validateBundle({ ...testBundle(), digest: "0".repeat(64) }),
  );
  assert.throws(() => validateBundle({ ...testBundle(), arbitrary: true }));
});

test("hash-valid bundles require the manifest and a Skill entrypoint", () => {
  for (const omitted of ["manifest.json", "skills/seo-audit/SKILL.md"]) {
    const bundle = testBundle();
    bundle.files = bundle.files.filter((file) => file.path !== omitted);
    bundle.digest = hash(JSON.stringify(bundle.files));
    assert.throws(() => validateBundle(bundle));
  }
});

test("staging is outside source, immutable, reusable and detects tampering", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-bundle-"));
  t.after(() => removeBundleFixture(root));
  const bundle = testBundle(),
    id = randomUUID();
  const directory = await stageBundle(root, id, bundle);
  assert.equal(
    await readFile(path.join(directory, bundle.files[0].path), "utf8"),
    bundle.files[0].content,
  );
  assert.equal((await lstat(directory)).mode & 0o777, 0o500);
  assert.equal(
    (await lstat(path.join(directory, "scripts/check.mjs"))).mode & 0o777,
    0o500,
  );
  assert.equal(
    (await lstat(path.join(directory, "skills/seo-audit/SKILL.md"))).mode &
      0o777,
    0o400,
  );
  assert.equal(await stageBundle(root, id, bundle), directory);
  assert.equal(await verifyBundle(root, id, bundle), directory);
  assert.match(
    bundlePrompt("Audit it", directory, bundle),
    /read the package manifest and all SKILL.md/,
  );
  assert.ok(bundlePrompt("Audit it", directory, bundle).includes(directory));
  await assert.rejects(
    stageBundle(root, randomUUID(), bundle, { forbiddenRoots: [root] }),
  );
  const file = path.join(directory, bundle.files[0].path);
  await chmod(file, 0o600);
  await writeFile(file, "tampered");
  await chmod(file, 0o500);
  await assert.rejects(stageBundle(root, id, bundle));
});

test("saved package cannot be replaced, extended, or symlinked", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-bundle-"));
  t.after(() => removeBundleFixture(root));
  const bundle = testBundle(),
    id = randomUUID();
  const directory = await stageBundle(root, id, bundle);
  await assert.rejects(
    stageBundle(root, id, testBundle([{ path: "other.txt", content: "x" }])),
  );
  await chmod(directory, 0o700);
  await writeFile(path.join(directory, "unexpected"), "x");
  await chmod(directory, 0o500);
  await assert.rejects(verifyBundle(root, id, bundle));
  const linkId = randomUUID();
  await symlink(directory, path.join(root, linkId + ".bundle"));
  await assert.rejects(stageBundle(root, linkId, bundle));
  const partial = path.join(root, randomUUID() + ".bundle");
  await mkdir(partial, { mode: 0o500 });
  await assert.rejects(
    stageBundle(root, path.basename(partial, ".bundle"), bundle),
  );
});
