import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBindings } from "../src/panel/workbench/runner-client.js";
const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function config(webUrl: string) {
  const dir = mkdtempSync(join(tmpdir(), "workbench-binding-"));
  directories.push(dir);
  const file = join(dir, "bindings.json");
  writeFileSync(
    file,
    JSON.stringify([
      {
        id: "owner",
        label: "Orca",
        instance: "default",
        team: "t",
        user: "u",
        repo: "id:r",
        url: "http://127.0.0.1:8791",
        token: "x".repeat(32),
        webUrl,
      },
    ]),
  );
  vi.stubEnv("WORKBENCH_BINDINGS_FILE", file);
}
test("accepts a credential-free HTTPS or loopback Orca browser endpoint", () => {
  for (const url of [
    "https://orca.example.test/web-index.html",
    "http://127.0.0.1:5188/web-index.html",
  ]) {
    config(url);
    expect(loadBindings()[0].webUrl).toBe(url);
  }
});
test.each([
  "https://user:secret@orca.example.test/",
  "https://orca.example.test/?token=secret",
  "https://orca.example.test/#pairing=secret",
  "http://public.example.test/",
  "javascript:alert(1)",
])("rejects unsafe browser endpoint %s", (url) => {
  config(url);
  expect(() => loadBindings()).toThrow();
});
